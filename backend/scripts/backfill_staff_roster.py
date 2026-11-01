"""P1-E — fill `staffRoster` (names-only staff list) from the Mongo `staff` rows.

`firestore.rules` now lets a member of staff read only their OWN `crmUsers`
document (contact details), so the CRM's assignee pickers read `staffRoster`
instead. New invites, role changes and (de)activations keep it current through
`crm_directory`; this writes the rows for everyone who already exists.

RUN THIS BEFORE DEPLOYING THE P1-E RULES, or the pickers are empty until it runs.

    python3 -m scripts.backfill_staff_roster                         # report only
    python3 -m scripts.backfill_staff_roster --apply --project <id>  # write

Dry by default; `--apply` needs `--project` equal to the connected project. The
source is Mongo `staff` (authoritative), never `crmUsers`. Only internal roles
are written — the Observer (no CRM presence) and partners are skipped. Prints
counts per role and per department, never names, emails or phone numbers.
Re-running is safe: each row is overwritten with the same values.

NOT RUN as part of Phase 1 — it writes production data and needs approval.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter


async def _run(apply: bool, project: str) -> int:
    from app.core.roles import Role, team_of
    from app.db import firebase, mongo
    from app.db.mongo import C, get_db
    from app.services import crm_directory as crm

    firebase.init()
    await mongo.connect()
    actual = str(getattr(firebase.firestore_client(), "project", "") or "")
    if apply and (not project or project != actual):
        print(f"Refusing to write: --project {project!r} does not match the connected project {actual!r}.",
              file=sys.stderr)
        return 2

    by_role: Counter = Counter()
    skipped: Counter = Counter()
    failed = 0
    async for row in get_db()[C.STAFF].find({}):
        try:
            role = Role(str(row.get("role", "")))
        except ValueError:
            skipped["unknown role"] += 1
            continue
        crm_role = crm.CRM_ROLE.get(role)
        if role in crm.NOT_MIRRORED or crm_role is None or not row.get("uid"):
            skipped[str(role)] += 1
            continue
        by_role[crm_role] += 1
        if apply:
            team = team_of(role)
            note = crm.write_roster(str(row["uid"]), name=str(row.get("name", "")), crm_role=crm_role,
                                    dept=str(team) if team else None,
                                    is_active=bool(row.get("is_active", True)))
            failed += 1 if note else 0

    print(f"project: {actual}")
    print(f"roster rows {'written' if apply else 'to write'}: {sum(by_role.values())}")
    for k, v in sorted(by_role.items()):
        print(f"  {k}: {v}")
    if skipped:
        print("skipped: " + ", ".join(f"{k}={v}" for k, v in sorted(skipped.items())))
    if apply and failed:
        print(f"{failed} row(s) failed — see the log and re-run.", file=sys.stderr)
        return 1
    if not apply:
        print("Report only. Re-run with --apply --project <id> to write.")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--project", default="")
    args = ap.parse_args(argv)
    return asyncio.run(_run(args.apply, args.project))


if __name__ == "__main__":
    raise SystemExit(main())
