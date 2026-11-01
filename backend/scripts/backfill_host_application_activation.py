"""Stamp approved self-filed Host applications as activated. DRY RUN BY DEFAULT.

    cd backend && .venv/bin/python -m scripts.backfill_host_application_activation           # dry run
    cd backend && .venv/bin/python -m scripts.backfill_host_application_activation --apply   # write

── WHY THIS EXISTS (C5 / B08 / B22) ────────────────────────────────────────

Approving a self-filed Host application grants the role directly — there is no
referral code to redeem — but the approval never stamped the application as
activated. So every such application stayed `isActivated: false`, and the CRM,
which lists Hosts (`users.isHost`) and applications still awaiting activation
(`hostApplications`, `isActivated == false`) side by side, showed the same
person twice: once "Active" and once "Awaiting Activation".

`users.decide_host_application` now stamps `isActivated`, `activatedByUid` and
`activatedAt` when it approves for a known person. This repairs the applications
approved before that.

── WHAT IT GUARANTEES ──────────────────────────────────────────────────────

  * Candidates are exactly: `status == approved`, an `applicantUid` (a
    self-filed application — an agency invitation names nobody until it is
    redeemed), `isActivated == false`, and the applicant is a Host right now
    (`users/{applicantUid}.isHost == true`).
  * Writes exactly three fields: `isActivated: true`, `activatedByUid` = the
    applicant, `activatedAt` = when the application was decided (or now, when
    no decision time is on it). Nothing else, and never a new document.
  * Each write is CONDITIONAL: a transaction re-reads the application and the
    applicant and writes only if every condition above still holds, so a
    document changed since the plan was made is skipped and reported.
  * Idempotent: a second run finds nothing to do.
  * `--apply` is required to write anything, and asks for the count typed back.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from typing import Any


def _is_candidate(app: dict, user: dict | None) -> bool:
    """The four conditions, on a pair of documents. Pure."""
    return (
        str(app.get("status") or "") == "approved"
        and bool(str(app.get("applicantUid") or "").strip())
        and app.get("isActivated") is False
        and bool(user)
        and (user or {}).get("isHost") is True
    )


def _activation_fields(app: dict) -> dict[str, Any]:
    decided = app.get("decidedAt")
    return {
        "isActivated": True,
        "activatedByUid": str(app.get("applicantUid") or "").strip(),
        "activatedAt": decided if hasattr(decided, "timestamp") else datetime.now(timezone.utc),
    }


def plan(client) -> list[dict[str, Any]]:
    """Every approved self-filed application that should already be activated."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    rows: list[dict[str, Any]] = []
    query = client.collection("hostApplications").where(
        filter=FieldFilter("status", "==", "approved")
    )
    for snap in query.stream():
        app = snap.to_dict() or {}
        uid = str(app.get("applicantUid") or "").strip()
        if not uid or app.get("isActivated") is not False:
            continue
        user_snap = client.collection("users").document(uid).get()
        user = (user_snap.to_dict() or {}) if getattr(user_snap, "exists", False) else None
        if not _is_candidate(app, user):
            continue
        rows.append({
            "application_id": snap.id,
            "applicant_uid": uid,
            "agency_id": str(app.get("agencyId") or ""),
            "host_agency_id": str((user or {}).get("agencyId") or ""),
            "patch": _activation_fields(app),
        })
    return rows


def apply_one(client, row: dict[str, Any]) -> str:
    """Write one planned stamp, conditionally. Returns 'APPLIED' or a SKIP reason."""
    from firebase_admin import firestore

    app_ref = client.collection("hostApplications").document(row["application_id"])
    user_ref = client.collection("users").document(row["applicant_uid"])

    @firestore.transactional
    def _stamp(transaction) -> str:
        app_snap = app_ref.get(transaction=transaction)
        user_snap = user_ref.get(transaction=transaction)
        if not getattr(app_snap, "exists", False):
            return "SKIP_GONE"
        app = app_snap.to_dict() or {}
        user = (user_snap.to_dict() or {}) if getattr(user_snap, "exists", False) else None
        if str(app.get("applicantUid") or "").strip() != row["applicant_uid"]:
            return "SKIP_CHANGED"
        if not _is_candidate(app, user):
            return "SKIP_NO_LONGER_APPLIES"
        transaction.update(app_ref, row["patch"])
        return "APPLIED"

    try:
        return _stamp(client.transaction())
    except Exception as exc:  # noqa: BLE001 — reported, the run carries on
        return f"SKIP_WRITE_REFUSED ({exc})"


def run(client, *, apply: bool) -> list[dict[str, Any]]:
    rows = plan(client)
    if apply:
        for row in rows:
            row["result"] = apply_one(client, row)
    return rows


def main() -> int:
    from app.db import firebase

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--apply", action="store_true", help="write the planned stamps")
    args = ap.parse_args()

    firebase.init()
    client = firebase.firestore_client()
    rows = plan(client)
    print("MODE:", "APPLY" if args.apply else "DRY RUN — nothing will be written")
    for r in rows:
        print(
            f"  STAMP  {r['application_id']}  applicant={r['applicant_uid']}  "
            f"agency={r['agency_id']}  host_now_under={r['host_agency_id']}"
        )
    print(f"\n{len(rows)} approved self-filed application(s) to stamp as activated.")
    if not args.apply or not rows:
        print("Dry run complete." if not args.apply else "Nothing to apply.")
        return 0
    try:
        typed = input(f"Type {len(rows)} to write {len(rows)} stamp(s): ").strip()
    except (EOFError, KeyboardInterrupt):
        typed = ""
    if typed != str(len(rows)):
        print("Stopped. Nothing was written.")
        return 1
    for r in rows:
        print(f"  {apply_one(client, r):<24} {r['application_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
