"""Repair stale app role flags on existing users/{uid} documents. DRY RUN BY DEFAULT.

    cd backend && .venv/bin/python -m scripts.repair_app_role_flags              # dry run, all
    cd backend && .venv/bin/python -m scripts.repair_app_role_flags --uid UID    # dry run, one
    cd backend && .venv/bin/python -m scripts.repair_app_role_flags --uid UID --apply

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

`users/{uid}.isAgent / isSeller / agencyId` are written at exactly three
moments: `syncMyRoles` at sign-in (and, from the new app build, at cold start),
`push_app_role_flags` after a CRM partner decision (new backend), and
`_attach_app_identity` when the backend mirrors a login. An account approved
BEFORE those were in place, whose owner has not signed in since, has nothing
that will ever revisit it — `diagnose_app_identity` reports FLAGS_STALE. This
re-runs the same derivation once, from the authoritative `crmUsers` document.

── WHAT IT GUARANTEES ──────────────────────────────────────────────────────

  * Derives flags only from `crmUsers/{uid}` via `crm_directory.app_role_patch`
    — the same pure function the decision-time push uses (and which mirrors
    `functions/src/crmRoles.ts::deriveRoleFlags`). Approved capabilities only;
    pending / revoked / rejected / suspended earn nothing.
  * Writes ONLY isAgent, isSeller, agencyId, crmRole(partner value → '').
    Never isProfileComplete, never isSuspended / isBanned / suspendedUntil,
    never isOfficial, never a staff crmRole, never a host's agencyId.
  * NEVER creates users/{uid}: `update`, which Firestore refuses on a missing
    document; a missing document is reported as SKIP_NO_USERS_DOC.
  * Idempotent: an account that already agrees produces no write. Run it twice
    and the second run reports zero changes.
  * Guarded against racing a live sign-in: each write is conditioned on the
    document's update time as read; a document changed in between is skipped
    and reported, not overwritten.
  * A crmUsers read that fails skips that uid — unknown is never "no roles".
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from app.services import crm_directory as crm

PARTNER_ROLES = frozenset(crm.PARTNER_CRM_ROLE.values())


def _is_partner_login(doc: dict) -> bool:
    roles = doc.get("roles") if isinstance(doc.get("roles"), list) else []
    return str(doc.get("role") or "") in PARTNER_ROLES or any(str(r) in PARTNER_ROLES for r in roles)


def _describe(patch: dict) -> dict:
    return {k: ("<delete>" if not isinstance(v, (bool, str)) else v) for k, v in patch.items()}


def candidate_uids(client, only: list[str]) -> list[str]:
    """Every uid whose flags could be wrong: partner logins, plus users docs that
    claim a partner flag (a stale POSITIVE needs removing as much as a stale
    negative needs adding)."""
    if only:
        return sorted(set(only))
    uids: set[str] = set()
    for snap in client.collection("crmUsers").stream():
        if _is_partner_login(snap.to_dict() or {}):
            uids.add(snap.id)
    for snap in client.collection("users").stream():
        d = snap.to_dict() or {}
        if d.get("isAgent") is True or d.get("isSeller") is True or str(d.get("crmRole") or "") in PARTNER_ROLES:
            uids.add(snap.id)
    return sorted(uids)


def plan_one(client, uid: str) -> dict[str, Any]:
    users_snap = client.collection("users").document(uid).get()
    if not users_snap.exists:
        return {"uid": uid, "action": "SKIP_NO_USERS_DOC", "patch": {}}
    try:
        crm_doc = crm.read(uid)
    except Exception as exc:  # noqa: BLE001
        return {"uid": uid, "action": "SKIP_CRM_UNREADABLE", "patch": {}, "error": str(exc)}
    users_doc = users_snap.to_dict() or {}
    patch = crm.app_role_patch(crm_doc, users_doc)
    return {
        "uid": uid,
        "action": "UPDATE" if patch else "OK",
        "patch": patch,
        "entitled": crm.app_role_flags(crm_doc),
        "current": {k: users_doc.get(k) for k in crm.APP_ROLE_FIELDS},
        "_snap": users_snap,
    }


def apply_one(client, row: dict) -> str:
    """Write one planned patch. Returns 'APPLIED' or a SKIP reason."""
    ref = client.collection("users").document(row["uid"])
    snap = row["_snap"]
    update_time = getattr(snap, "update_time", None)
    write_option = getattr(client, "write_option", None)
    try:
        if update_time is not None and callable(write_option):
            ref.update(row["patch"], option=write_option(last_update_time=update_time))
        else:
            ref.update(row["patch"])
    except Exception as exc:  # noqa: BLE001 — missing doc or concurrent change
        return f"SKIP_WRITE_REFUSED ({exc})"
    return "APPLIED"


def run(client, only: list[str], apply: bool) -> list[dict]:
    rows = [plan_one(client, uid) for uid in candidate_uids(client, only)]
    for row in rows:
        if apply and row["action"] == "UPDATE":
            row["result"] = apply_one(client, row)
    return rows


def main() -> int:
    from app.db import firebase

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uid", action="append", default=[], help="limit to these uids (repeatable)")
    ap.add_argument("--apply", action="store_true", help="write the planned patches")
    args = ap.parse_args()

    firebase.init()
    client = firebase.firestore_client()
    rows = run(client, args.uid, apply=False)
    updates = [r for r in rows if r["action"] == "UPDATE"]
    print("MODE:", "APPLY" if args.apply else "DRY RUN — nothing will be written")
    for r in rows:
        line = f"  {r['action']:<20} {r['uid']}"
        if r["action"] == "UPDATE":
            line += f"  current={r['current']}  patch={_describe(r['patch'])}"
        if r.get("error"):
            line += f"  error={r['error']}"
        print(line)
    print(f"\n{len(rows)} candidate(s), {len(updates)} to update, "
          f"{sum(r['action'] == 'SKIP_NO_USERS_DOC' for r in rows)} without a users doc (left alone).")
    if not args.apply or not updates:
        print("Dry run complete." if not args.apply else "Nothing to apply.")
        return 0
    try:
        typed = input(f"Type {len(updates)} to write {len(updates)} patch(es): ").strip()
    except (EOFError, KeyboardInterrupt):
        typed = ""
    if typed != str(len(updates)):
        print("Stopped. Nothing was written.")
        return 1
    for r in updates:
        print(f"  {apply_one(client, r):<20} {r['uid']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
