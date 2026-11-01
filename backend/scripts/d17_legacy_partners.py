"""D17 — active legacy partners without BOTH verified contacts: survey, dry-run, guarded apply.

── THE APPROVED DIRECTION ──────────────────────────────────────────────────

Decision 15 holds a NEW approval in `awaiting_verification` until the login
has a verified phone AND a verified email. D17 moves the roles that started
before that rule — active partners whose login lacks either — into the same
state. The way back is the D15 way back: once both are verified, the role
starts again by itself (`partner_ops.activate_partner_if_verified`).

── WHAT THIS SCRIPT DOES, IN ORDER, AND WHAT IT WILL NOT DO ────────────────

  1. SURVEY (default; read-only). Every approved, active Agency, Sub-agency
     and Coin Seller record; the login behind it (the Mongo owner, else the
     Firestore document's `crmUid` / `ownerUid` — read, never persisted);
     its verification from the authoritative sources
     (`contact_verification.status`: Firebase Auth + the code ledger; a
     reset or sign-in link does not count); and money in flight. Active
     Hosts are surveyed as COUNTS only — their semantics are an open
     decision (D17-H) and no Host is ever planned or changed here.
  2. DRY-RUN PLAN. Totals and breakdowns, sample records under an
     anonymous reference (sha256 of the record id, 10 hex), the exact state
     change each planned record would undergo, and a validation of the plan
     against the current semantics. With `--plan-out FILE` the plan is
     written to a local file (record ids, kinds, what is missing, money
     flags — no uid, name, phone or email) and its sha256 is printed.
  3. APPLY (`--apply`) — NOT part of the release. Only after the dry-run has
     been reviewed and SEPARATELY approved. It needs the plan file, its
     sha256, the approval reference, the same project, a plan younger than
     `MAX_PLAN_AGE_HOURS`; it applies only entries planned `hold`, and
     `partner_ops.hold_for_verification` re-reads every record and its
     verification and refuses any that changed. Records with money in
     flight are EXCLUDED (open decision D17-M) and never applied.

It opens Mongo with `mongo.connect(ensure=False)`: the same isolation check,
without `ensure_indexes()` — which is DDL and has no place in a survey.

── USAGE (owner-run, from backend/) ────────────────────────────────────────

    ENVIRONMENT=production ZIPPER_ALLOW_PRODUCTION_ACCESS=<project id> \\
        .venv/bin/python -m scripts.d17_legacy_partners --plan-out ~/d17-plan.json

    # only after the dry-run was reviewed and the migration approved:
    ENVIRONMENT=production ZIPPER_ALLOW_PRODUCTION_ACCESS=<project id> \\
        .venv/bin/python -m scripts.d17_legacy_partners --apply \\
            --plan ~/d17-plan.json --plan-sha256 <hex> --approval "<who, when, where>"
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PLAN_KIND = "zipper.d17.plan"
PLAN_VERSION = 1
PARTNER_KINDS = ("agency", "sub_agency", "seller")
MAX_PLAN_AGE_HOURS = 72
MIGRATION_ACTOR = {"uid": "system:d17-migration", "name": "D17 migration", "role": "system", "team": None}

#: What a planned `hold` changes — the Decision 15 waiting state, for a role
#: that had started. Printed with the plan so the reviewer approves exactly this.
STATE_CHANGE = (
    "Mongo partners/<id>: status approved → awaiting_verification, is_active true → false, "
    "activation = {state, missing, held_at, held_by, held_reason}; the original approval stays",
    "Firestore agencies|sellers/<id>: status awaiting_verification, isActive false "
    "(sellers: isApproved false), activationPending = missing",
    "crmUsers/<login>: role status awaiting_verification (the CRM waiting room); app role flags re-pushed",
    "partner CRM sessions revoked (the capability is gone); audit partner.held_for_verification",
    "Official message to the login: the role is paused until both contacts are verified",
    "Back: verifying both contacts starts the role again (activate_partner_if_verified) — "
    "referral code and virtual account are ensured, not re-minted",
)


def ref(record_id: str) -> str:
    """An anonymous, stable reference for printing: sha256 of the record id, 10 hex."""
    return hashlib.sha256(str(record_id).encode("utf-8")).hexdigest()[:10]


@dataclass
class Candidate:
    partner_id: str
    kind: str
    missing: list[str]
    no_login: bool = False
    money: dict[str, int] = field(default_factory=dict)


def classify(c: Candidate) -> tuple[str, str]:
    """('none' | 'hold' | 'exclude', why). Pure."""
    if c.no_login:
        return "exclude", "no login attached — nobody could verify; needs a human (attach_login)"
    if not c.missing:
        return "none", "both contacts verified"
    if any(int(v or 0) > 0 for v in c.money.values()):
        return "exclude", "money in flight — open decision D17-M"
    return "hold", ""


def build_plan(candidates: Iterable[Candidate], hosts: dict[str, Any], *, project: str, generated_at: str) -> dict:
    """The plan file's content. Pure. No uid, name, phone or email in it."""
    entries = []
    for c in sorted(candidates, key=lambda x: (x.kind, x.partner_id)):
        action, why = classify(c)
        if action == "none":
            continue
        entries.append({
            "partner_id": c.partner_id,
            "ref": ref(c.partner_id),
            "kind": c.kind,
            "missing": sorted(c.missing),
            "money_in_flight": {k: int(v) for k, v in sorted(c.money.items()) if int(v or 0) > 0},
            "action": action,
            "why": why,
            "expect": {"status": "approved", "is_active": True},
        })
    return {
        "kind": PLAN_KIND,
        "version": PLAN_VERSION,
        "project": project,
        "generated_at": generated_at,
        "entries": entries,
        "hosts": hosts,
    }


def plan_sha256(plan: dict) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def totals(candidates: list[Candidate]) -> dict[str, Any]:
    by_kind = Counter(c.kind for c in candidates)
    lacking = [c for c in candidates if c.missing and not c.no_login]
    by_missing = Counter((c.kind, "+".join(sorted(c.missing))) for c in lacking)
    actions = Counter(classify(c)[0] for c in candidates)
    return {
        "active_partners": len(candidates),
        "by_kind": dict(sorted(by_kind.items())),
        "lacking_a_verified_contact": len(lacking),
        "by_kind_and_missing": {f"{k}:{m}": n for (k, m), n in sorted(by_missing.items())},
        "no_login": sum(1 for c in candidates if c.no_login),
        "actions": dict(sorted(actions.items())),
    }


def validate_plan(plan: dict) -> list[str]:
    """Checks the plan against the current semantics. Pure. Returns problems (empty = valid)."""
    problems = []
    if plan.get("kind") != PLAN_KIND or plan.get("version") != PLAN_VERSION:
        problems.append("not a D17 plan of this version")
    for e in plan.get("entries", []):
        r = e.get("ref", "?")
        if e.get("kind") not in PARTNER_KINDS:
            problems.append(f"{r}: kind {e.get('kind')!r} is not held by this migration (Hosts are D17-H)")
        if e.get("action") == "hold":
            if not e.get("missing"):
                problems.append(f"{r}: planned hold with nothing missing")
            if e.get("money_in_flight"):
                problems.append(f"{r}: planned hold with money in flight (must be excluded, D17-M)")
            if e.get("expect") != {"status": "approved", "is_active": True}:
                problems.append(f"{r}: a hold must expect an approved, active record")
        elif e.get("action") != "exclude":
            problems.append(f"{r}: unknown action {e.get('action')!r}")
        if ref(e.get("partner_id", "")) != r:
            problems.append(f"{r}: reference does not match the record id")
    hosts = plan.get("hosts") or {}
    if hosts.get("action") != "excluded":
        problems.append("hosts must be excluded until D17-H is decided")
    return problems


def render(plan: dict, t: dict, sha: str, samples: int = 5) -> str:
    lines = ["", "═" * 74,
             "  D17 LEGACY PARTNERS — DRY RUN. Nothing was written.",
             "═" * 74,
             f"  project {plan['project']}   generated {plan['generated_at']}", ""]
    lines.append(f"  approved, active partner records      {t['active_partners']}   {t['by_kind']}")
    lines.append(f"  lacking a verified phone or email     {t['lacking_a_verified_contact']}")
    for k, n in t["by_kind_and_missing"].items():
        lines.append(f"      {k:<34} {n}")
    lines.append(f"  with no login attached                {t['no_login']}")
    lines.append(f"  plan: {t['actions']}")
    hosts = plan.get("hosts") or {}
    lines += ["", f"  active Hosts (COUNTS ONLY — D17-H open): {hosts.get('active_hosts', 0)}, "
              f"lacking: {hosts.get('lacking', {})}, with beans > 0: {hosts.get('with_beans', 0)}"]
    holds = [e for e in plan["entries"] if e["action"] == "hold"]
    excl = [e for e in plan["entries"] if e["action"] == "exclude"]
    lines += ["", f"  sample planned holds ({min(samples, len(holds))} of {len(holds)}):"]
    for e in holds[:samples]:
        lines.append(f"      ref {e['ref']}  {e['kind']:<10} missing {'+'.join(e['missing'])}")
    lines += [f"  sample exclusions ({min(samples, len(excl))} of {len(excl)}):"]
    for e in excl[:samples]:
        lines.append(f"      ref {e['ref']}  {e['kind']:<10} {e['why']}  {e['money_in_flight'] or ''}")
    lines += ["", "  each planned hold would change:"]
    lines += [f"    · {s}" for s in STATE_CHANGE]
    problems = validate_plan(plan)
    lines += ["", "  validation against current semantics: " + ("OK" if not problems else "PROBLEMS")]
    lines += [f"    ✗ {p}" for p in problems]
    lines += ["", f"  plan sha256 {sha}",
              "  Applying it is a SEPARATE, explicitly approved step (deployment plan, step 10).", ""]
    return "\n".join(lines)


def check_apply_preconditions(plan: dict, *, given_sha: str, approval: str, project: str, now: datetime) -> list[str]:
    """Everything that must hold before a single write. Pure."""
    problems = validate_plan(plan)
    if plan_sha256(plan) != (given_sha or "").strip().lower():
        problems.append("the plan's sha256 does not match --plan-sha256")
    if not (approval or "").strip():
        problems.append("--approval is required (who approved the reviewed dry-run, and when)")
    if plan.get("project") != project:
        problems.append(f"the plan was made for project {plan.get('project')!r}, not {project!r}")
    try:
        made = datetime.fromisoformat(str(plan.get("generated_at")))
        age_h = (now - made).total_seconds() / 3600
        if age_h > MAX_PLAN_AGE_HOURS or age_h < 0:
            problems.append(f"the plan is {age_h:.0f} h old; make and review a fresh one")
    except ValueError:
        problems.append("the plan has no readable generated_at")
    return problems


# ── I/O — survey (read-only) ────────────────────────────────────────────────

async def _db_without_ddl():
    """Mongo through `mongo.connect()` — its isolation check — WITHOUT `ensure_indexes()` (DDL)."""
    from app.db import mongo

    await mongo.connect(ensure=False)
    return mongo.get_db()


async def _ids(col, query: dict) -> set[str]:
    """The `_id`s a query matches — read with `find`, nothing else."""
    return {str(d.get("_id")) async for d in col.find(query)}


async def survey(db) -> tuple[list[Candidate], dict[str, Any]]:
    from app.db.mongo import C
    from app.services import contact_verification
    from app.services.partner_roles import _firestore_owner_of  # read-only (owner_uid_of would PERSIST)
    from app.db import firebase

    out: list[Candidate] = []
    rows = [p async for p in db[C.PARTNERS].find(
        {"status": "approved", "is_active": True, "kind": {"$in": list(PARTNER_KINDS)}})]
    for p in rows:
        pid, kind = str(p["_id"]), str(p.get("kind") or "")
        uid = str(p.get("owner_crm_uid") or "").strip() or await asyncio.to_thread(_firestore_owner_of, p)
        money: dict[str, int] = {}
        if kind == "seller":
            bal = await db[C.BALANCES].find_one({"holder_type": "seller", "holder_id": pid, "currency": "coins"})
            money["seller_coins"] = int((bal or {}).get("amount") or 0)
            money["open_recharges"] = len(await _ids(db[C.RECHARGES], {
                "seller_id": pid, "status": {"$in": ["pending", "approving", "refund_pending", "refunding"]}}))
        else:
            bal = await db[C.BALANCES].find_one({"holder_type": "agency", "holder_id": pid, "currency": "commission"})
            money["commission_minor"] = int((bal or {}).get("amount") or 0)
            open_payouts = {"$in": ["pending", "parent_paid"]}
            money["open_subagency_payouts"] = len(
                await _ids(db[C.SUBAGENCY_PAYOUTS], {"parent_id": pid, "status": open_payouts})
                | await _ids(db[C.SUBAGENCY_PAYOUTS], {"sub_id": pid, "status": open_payouts}))
        if not uid:
            out.append(Candidate(pid, kind, [], no_login=True, money=money))
            continue
        v = await asyncio.to_thread(contact_verification.status, uid)
        out.append(Candidate(pid, kind, [] if v.complete else list(v.missing), no_login=v.no_account, money=money))

    # Hosts: counts only (D17-H is open).
    hosts = {"active_hosts": 0, "lacking": {"phone": 0, "email": 0, "both": 0}, "with_beans": 0, "action": "excluded"}
    from google.cloud.firestore_v1.base_query import FieldFilter

    def _host_rows():
        q = (firebase.firestore_client().collection("users")
             .where(filter=FieldFilter("isHost", "==", True))
             .select(["isDeleted", "accountState", "beans"]))
        return [(s.id, s.to_dict() or {}) for s in q.stream()]

    for uid, d in await asyncio.to_thread(_host_rows):
        if d.get("isDeleted") is True or str(d.get("accountState") or "") in ("permanently_deactivated", "recovery_pending"):
            continue
        hosts["active_hosts"] += 1
        if int(d.get("beans") or 0) > 0:
            hosts["with_beans"] += 1
        v = await asyncio.to_thread(contact_verification.status, uid)
        if not v.complete:
            hosts["lacking"]["both" if len(v.missing) == 2 else v.missing[0]] += 1
    return out, hosts


async def apply(plan: dict, sha: str, approval: str) -> list[dict]:
    from app.services import partner_ops

    results = []
    for e in plan["entries"]:
        if e["action"] != "hold":
            results.append({"ref": e["ref"], "applied": False, "why": e["why"]})
            continue
        reason = (f"D17 legacy-partner migration, plan {sha[:12]} ({approval}). "
                  f"The login lacks a verified {' and '.join(e['missing'])}.")
        try:
            out = await partner_ops.hold_for_verification(e["partner_id"], reason, MIGRATION_ACTOR)
            results.append({"ref": e["ref"], "applied": True, "missing": out.get("missing"),
                            "notified": out.get("notified")})
        except partner_ops.PartnerOpsError as exc:
            results.append({"ref": e["ref"], "applied": False, "why": str(exc).replace(e["partner_id"], e["ref"])})
    return results


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan-out", type=Path, help="write the dry-run plan here (local file)")
    ap.add_argument("--apply", action="store_true", help="apply a REVIEWED, APPROVED plan (separate approval)")
    ap.add_argument("--plan", type=Path)
    ap.add_argument("--plan-sha256", default="")
    ap.add_argument("--approval", default="")
    args = ap.parse_args()

    from app.config import settings
    from app.db import firebase

    firebase.init()                      # the isolation rules, before any credential is read
    project = str(getattr(settings, "firebase_project_id", "") or "")
    db = await _db_without_ddl()

    if args.apply:
        if not args.plan:
            ap.error("--apply needs --plan, --plan-sha256 and --approval")
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
        problems = check_apply_preconditions(plan, given_sha=args.plan_sha256, approval=args.approval,
                                             project=project, now=datetime.now(timezone.utc))
        if problems:
            print("REFUSED — nothing was written:")
            for p in problems:
                print(f"  ✗ {p}")
            return 2
        results = await apply(plan, plan_sha256(plan), args.approval)
        print(json.dumps({"applied": sum(r["applied"] for r in results), "results": results}, indent=2))
        return 0

    candidates, hosts = await survey(db)
    plan = build_plan(candidates, hosts, project=project,
                      generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    sha = plan_sha256(plan)
    print(render(plan, totals(candidates), sha))
    if args.plan_out:
        args.plan_out.write_text(json.dumps(plan, indent=2, sort_keys=True), encoding="utf-8")
        print(f"  plan written to {args.plan_out} (sha256 {sha})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
