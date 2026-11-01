"""SUPERSEDED (2026-11-01) by scripts/reset/ — see scripts/reset/RESET-RUNBOOK.md.

    ╔══════════════════════════════════════════════════════════════════════════╗
    ║  THIS SCRIPT NO LONGER EXECUTES. `--apply` is REFUSED unconditionally.   ║
    ║  It re-planned live and deleted whatever qualified at that moment, with  ║
    ║  no frozen manifest, no target in its log, no backup gate and recursive  ║
    ║  (uncounted) subcollection deletes — see docs/phase-1a/                   ║
    ║  RESET-RECONCILIATION-2026-10-15.md §6. The replacement is                ║
    ║  scripts/reset/{backup,plan,execute,seed,postcheck}.py.                   ║
    ╚══════════════════════════════════════════════════════════════════════════╝

Kept for its pure helpers (`guard`, `owner_users_patch`, `owner_crm_patch`,
`check_plan_file`), which tests/test_reset_plan.py still pins. The original
docstring follows for the record.

Execute the FRESH production reset. DRY RUN unless --apply. IRREVERSIBLE with --apply.

    cd backend
    # 1. plan (read-only) — must be a --fresh plan with no blockers
    .venv/bin/python -m scripts.plan_test_data_reset --fresh \
        --owner-uid 'UID1' --owner-uid 'UID2' --owner-uid 'UID3' --out reset-plan.json
    # 2. back up
    .venv/bin/python -m scripts.backup_firestore
    # 3. rehearse (read-only)
    .venv/bin/python -m scripts.execute_test_data_reset --plan reset-plan.json \
        --owner-uid 'UID1' --owner-uid 'UID2' --owner-uid 'UID3'
    # 4. execute
    .venv/bin/python -m scripts.execute_test_data_reset --plan reset-plan.json \
        --owner-uid 'UID1' --owner-uid 'UID2' --owner-uid 'UID3' --apply

── WHAT SURVIVES ───────────────────────────────────────────────────────────

  * The three Owners: Firebase Auth account, Mongo staff row, crmUsers,
    users, publicProfiles, live sessions, and their own Storage objects
    (avatar, KYC). Their users doc is RESET: partner flags off, economy
    counters (diamonds, beans, …) to 0. Their crmUsers loses partner residue.
  * The Observer: its Mongo staff row and sessions. It has no Auth account.
  * Configuration: appConfig, gifts, bagItems, diamondPacks, rechargePackages,
    paymentConfig, levelConfig, contentConfig…; Mongo rates, chance configs,
    scheduled_runs, alert_state, report_subscriptions; Storage appBuilds/
    (the in-app updater's APKs), contentAssets/, gifts/ and other config.
  * Rules, indexes, functions, hosting — not data; never touched.

── WHAT IS DELETED ─────────────────────────────────────────────────────────

Every other Auth account, staff row, crmUsers/users/publicProfiles document
(with its subcollections), every partner, application, notification, token,
session, conversation, auth event, appeal, and ALL money and audit history —
ledger, audit, recharges, sales, payouts, reconciliation, email deliveries,
weekly reports, platformRevenue, rechargeRequests … — including the Owners'.
Plus every non-Owner Storage object under the per-user prefixes.

── WHY IT IS SAFE TO RUN ───────────────────────────────────────────────────

  * The allowlist is resolved live with the same fail-closed checks as the
    planner, and its fingerprint must EQUAL the one in the reviewed plan file.
    It is re-resolved and re-compared before EACH phase.
  * The reviewed plan must be a `--fresh` plan with zero blockers, and the
    live re-plan must also have zero blockers.
  * Every single delete passes `guard()`, which refuses anything whose id,
    owner or path segment is an allowlisted uid in an identity location.
  * `--apply` additionally requires typing  DELETE <count>.
  * Order: Mongo → Firestore → Storage → Firebase Auth last, so an interrupted
    run never leaves a live login pointing at nothing. Re-running finishes the
    job (everything is idempotent: deleting a deleted thing is a no-op).
  * A JSON log of every id deleted or reset is written next to the plan.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from typing import Any

from app.core.destructive import DestructiveRefused, require_data_canary, require_destructive_target  # P0-10
from scripts import plan_test_data_reset as P

PARTNER_ROLES = ("agency", "seller")


class RefusedError(RuntimeError):
    """Execution refused. Nothing (further) is written."""


# ── Pure: guards and reset patches ───────────────────────────────────────────

def guard(store: str, collection: str, doc_id: str, owner: str, allow: P.Allowlist) -> None:
    """Raise unless deleting this is permitted. The last line of defence."""
    keep = allow.uids | ({allow.observer.get("uid")} - {""})
    row = {"store": store, "collection": collection}
    if P.is_identity_row(row) and (doc_id in keep or owner in keep):
        raise RefusedError(f"guard: refusing to delete allowlisted identity {store}/{collection}/{doc_id}")
    if store == "mongo" and collection == "staff" and doc_id == allow.observer.get("_id"):
        raise RefusedError("guard: refusing to delete the Observer staff row")
    if store == "storage" and any(seg in allow.uids for seg in doc_id.split("/")[1:]):
        raise RefusedError(f"guard: refusing to delete an Owner Storage object {doc_id}")
    if store == "storage" and P.storage_action(doc_id, allow) != "DELETE":
        raise RefusedError(f"guard: {doc_id} is not a DELETE path")
    if store == "firestore" and collection in P.FS_CONFIG:
        raise RefusedError(f"guard: refusing to delete configuration {collection}")
    if store == "mongo" and collection in P.MONGO_CONFIG:
        raise RefusedError(f"guard: refusing to delete configuration {collection}")


def owner_users_patch(doc: dict, delete_field: Any) -> dict:
    """Fresh-start patch for an Owner's users/{uid}. Only flags and counters."""
    patch: dict = {}
    for k in ("isAgent", "isSeller"):
        if doc.get(k):
            patch[k] = False
    for k in ("agencyId", "sellerId"):
        if doc.get(k):
            patch[k] = delete_field
    if str(doc.get("crmRole") or "") in PARTNER_ROLES:
        patch["crmRole"] = ""
    for k in P.OWNER_RESET_ZERO:
        if isinstance(doc.get(k), (int, float)) and doc.get(k) != 0:
            patch[k] = 0
    return patch


def owner_crm_patch(doc: dict, delete_field: Any) -> dict:
    """Fresh-start patch for an Owner's crmUsers/{uid}: partner residue only."""
    patch: dict = {}
    roles = doc.get("roles")
    if isinstance(roles, list) and any(r in PARTNER_ROLES for r in roles):
        patch["roles"] = [r for r in roles if r not in PARTNER_ROLES]
    for k in ("agencyId", "sellerId", "roleStatus"):
        if k in doc:
            patch[k] = delete_field
    return patch


def check_plan_file(plan: dict) -> None:
    if plan.get("policy") != "fresh":
        raise RefusedError("the plan file is not a --fresh plan; re-run the planner with --fresh")
    if plan.get("blockers"):
        raise RefusedError(f"the plan file has blockers: {plan['blockers']}")


# ── I/O ──────────────────────────────────────────────────────────────────────

async def _resolve(owner_uids: list[str]) -> P.Allowlist:
    from firebase_admin import auth as fb_auth

    from app.config import settings
    from app.db import mongo

    def _safe(fn):
        def inner(v):
            try:
                return fn(v)
            except Exception:  # noqa: BLE001
                return None
        return inner

    staff = [r async for r in mongo.get_db()["staff"].find({})]
    return P.resolve_allowlist(staff, owner_uids, settings.observer_email, _safe(fb_auth.get_user),
                               _safe(fb_auth.get_user_by_email), _safe(fb_auth.get_user_by_phone_number))


async def execute(owner_uids: list[str], plan_path: str, apply: bool) -> int:
    from firebase_admin import auth as fb_auth
    from firebase_admin import firestore as fb_firestore

    from app.db import firebase, mongo

    # P0-10 (OPS-C): the target, named and confirmed, before anything connects.
    try:
        print(require_destructive_target("execute_test_data_reset", writes=apply))
    except DestructiveRefused as exc:
        raise RefusedError(str(exc)) from exc

    with open(plan_path) as fh:
        reviewed = json.load(fh)
    check_plan_file(reviewed)
    expected = reviewed["allowlist"]["fingerprint"]

    live = await P.gather_and_plan(owner_uids, fresh=True)   # connects + disconnects
    if live["allowlist"]["fingerprint"] != expected:
        raise RefusedError("the live allowlist differs from the reviewed plan — re-plan and review")
    if live["blockers"]:
        raise RefusedError(f"the live re-plan has blockers: {live['blockers']}")

    total = sum(sum(v.values()) for k, v in live["totals"].items() if k == "DELETE")
    print("LIVE RE-PLAN (fresh) — matches the reviewed allowlist", expected[:16])
    for action, per in sorted(live["totals"].items()):
        print(f"  {action}: {sum(per.values())}")
        for k, n in sorted(per.items()):
            print(f"      {k:<44} {n:>7}")
    if not apply:
        print("\nDRY RUN — nothing was written. Re-run with --apply to execute.")
        return 0

    try:
        typed = input(f"\nThis permanently deletes {total} record(s). Type  DELETE {total}  to continue: ")
    except (EOFError, KeyboardInterrupt):
        typed = ""
    if typed.strip() != f"DELETE {total}":
        print("Stopped. Nothing was written.")
        return 1

    log: dict[str, Any] = {"started": datetime.now(timezone.utc).isoformat(), "fingerprint": expected,
                           "deleted": [], "reset": []}
    firebase.init()
    # No `ensure_indexes()` (DDL): the reset deletes; index builds belong to the
    # deployed backend's startup.
    await mongo.connect(ensure=False)
    db = mongo.get_db()
    client = firebase.firestore_client()
    try:
        # P0-10: this database must name this project before anything is deleted.
        try:
            await require_data_canary(db, "execute_test_data_reset")
        except DestructiveRefused as exc:
            raise RefusedError(str(exc)) from exc

        async def recheck(phase: str) -> P.Allowlist:
            a = await _resolve(owner_uids)
            if a.fingerprint() != expected:
                raise RefusedError(f"allowlist changed before phase {phase}; stopping")
            print(f"\n── {phase} (allowlist re-verified)")
            return a

        # ── Phase 1: Mongo ────────────────────────────────────────────────
        allow = await recheck("MONGO")
        removed: set[str] = set()
        for name in sorted(await db.list_collection_names()):
            raw = [d async for d in db[name].find({})]
            rows = P.apply_fresh_policy(P.classify_mongo(name, raw, allow, removed), allow)
            for r in rows:
                if r["action"] != "DELETE":
                    continue
                if r["id"] == "*":
                    guard("mongo", name, "*", "", allow)
                    res = await db[name].delete_many({})
                    log["deleted"].append({"store": "mongo", "collection": name, "id": "*",
                                           "count": res.deleted_count})
                    print(f"   mongo {name:<28} {res.deleted_count:>6} (all)")
                    break
                match = next(d for d in raw if str(d.get("_id")) == r["id"])
                guard("mongo", name, r["id"], r.get("owner", ""), allow)
                await db[name].delete_one({"_id": match["_id"]})
                log["deleted"].append({"store": "mongo", "collection": name, "id": r["id"]})
            n = sum(1 for r in rows if r["action"] == "DELETE" and r["id"] != "*")
            if n:
                print(f"   mongo {name:<28} {n:>6}")

        # ── Phase 2: Firestore ────────────────────────────────────────────
        allow = await recheck("FIRESTORE")
        kept: set[str] = set()
        for coll in P.firestore_order(client.collections()):
            docs = [(d.id, d.to_dict() or {}) for d in coll.stream()]
            rows = P.apply_fresh_policy(P.classify_firestore(coll.id, docs, allow, removed, kept), allow)
            if any(r["action"] == "UNCLASSIFIED" for r in rows):
                raise RefusedError(f"firestore/{coll.id} appeared since planning; stopping")
            whole = [r for r in rows if r["id"] == "*" and r["action"] == "DELETE"]
            if whole:
                guard("firestore", coll.id, "*", "", allow)
                client.recursive_delete(coll)
                log["deleted"].append({"store": "firestore", "collection": coll.id, "id": "*",
                                       "count": whole[0].get("count")})
                print(f"   firestore {coll.id:<24} {whole[0].get('count', 0):>6} (all)")
                continue
            n = 0
            for r in rows:
                ref = coll.document(r["id"]) if r["id"] != "*" else None
                if r["action"] == "DELETE" and ref is not None:
                    guard("firestore", coll.id, r["id"], r.get("owner", ""), allow)
                    client.recursive_delete(ref)
                    log["deleted"].append({"store": "firestore", "collection": coll.id, "id": r["id"]})
                    n += 1
                elif r["action"] == "RESET" and ref is not None:
                    doc = dict(docs)[r["id"]]
                    patch = (owner_users_patch(doc, fb_firestore.DELETE_FIELD) if coll.id == "users"
                             else owner_crm_patch(doc, fb_firestore.DELETE_FIELD))
                    if patch:
                        ref.update(patch)
                        log["reset"].append({"collection": coll.id, "id": r["id"], "fields": sorted(patch)})
                        print(f"   firestore {coll.id}/{r['id']} reset {sorted(patch)}")
            if n:
                print(f"   firestore {coll.id:<24} {n:>6}")

        # ── Phase 3: Storage ──────────────────────────────────────────────
        allow = await recheck("STORAGE")
        n = 0
        for blob in firebase.storage_bucket().list_blobs():
            action = P.storage_action(blob.name, allow)
            if action == "UNCLASSIFIED":
                raise RefusedError(f"storage {blob.name} appeared since planning; stopping")
            if action == "DELETE":
                guard("storage", blob.name.split("/")[0] + "/", blob.name, "", allow)
                blob.delete()
                log["deleted"].append({"store": "storage", "id": blob.name})
                n += 1
        print(f"   storage objects deleted {n:>6}")

        # ── Phase 4: Firebase Auth (last) ─────────────────────────────────
        allow = await recheck("AUTH")
        doomed = [u.uid for u in fb_auth.list_users().iterate_all() if u.uid not in allow.uids]
        for uid in doomed:
            guard("auth", "auth", uid, uid, allow)
        for i in range(0, len(doomed), 1000):
            res = fb_auth.delete_users(doomed[i:i + 1000])
            for err in res.errors:
                print(f"   auth {doomed[i + err.index]}: {err.reason}")
        log["deleted"] += [{"store": "auth", "id": u} for u in doomed]
        print(f"   auth accounts deleted {len(doomed):>6}")
    finally:
        await mongo.disconnect()
        log["finished"] = datetime.now(timezone.utc).isoformat()
        # Timestamped: a re-run must never overwrite the log of the run that deleted things.
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = plan_path.replace(".json", "") + f"-applied-{stamp}.json"
        with open(out, "w") as fh:
            json.dump(log, fh, indent=2, default=str)
        print(f"\nLog written to {out}")

    print("\nDone. Owners: sign out and back in on the CRM and the app.")
    return 0


SUPERSEDED_BY = "scripts/reset/ (python -m scripts.reset.execute) — see scripts/reset/RESET-RUNBOOK.md"


def main() -> int:
    # SUPERSEDED: a run that would write is refused before anything is parsed,
    # connected or read. The dry-run path is left so the old plan files can
    # still be rehearsed against, but nothing in this file deletes any more.
    if "--apply" in sys.argv:
        print(f"REFUSED: execute_test_data_reset is superseded by {SUPERSEDED_BY}. "
              "--apply no longer does anything.")
        return 2
    print(f"NOTE: this script is superseded by {SUPERSEDED_BY}; it runs read-only.")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--owner-uid", action="append", default=[], required=True)
    ap.add_argument("--plan", required=True, help="the reviewed --fresh plan JSON")
    ap.add_argument("--apply", action="store_true", help="REFUSED — superseded (see the banner above)")
    args = ap.parse_args()
    args.apply = False
    try:
        return asyncio.run(execute(args.owner_uid, args.plan, args.apply))
    except (RefusedError, P.AllowlistError) as exc:
        print(f"REFUSED: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
