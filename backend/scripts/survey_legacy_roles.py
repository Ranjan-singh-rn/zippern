"""P1-G — READ-ONLY survey of legacy role strings. Changes nothing.

Before the department system, `crmUsers.role` could be `admin`, `ops`, `tech`,
`finance` or `support`. The CRM front end and the backend read those as
`app_admin` / `*_member` (`LEGACY_ROLE_MAP`, `crm_directory.LEGACY_CRM_ROLE`),
but `firestore.rules` still honours them literally — and gives `admin`
EVERY department's helper (`isApp/isOps/isTech/isFinance/isSupport`) plus
`isAdmin()`. A stale `admin` document therefore holds more Firestore authority
than the role its holder sees in the CRM. This script measures how many exist
so the removal plan (outputs/p1-exec/P1-G-LEGACY-ROLE-PLAN.md) can be approved
with numbers, not guesses.

    python3 -m scripts.survey_legacy_roles

Reads `crmUsers` (Firestore) and `staff` (Mongo). Prints counts and an 8-char
fingerprint per flagged document — never a uid, name, email or phone. Also
counts ORPHANS: staff-role crmUsers documents with no Mongo staff row, and
Mongo staff rows with no crmUsers document.

READ-ONLY: only `find()` and `stream()`; Mongo is connected with
`ensure=False` so no index DDL runs. `tests/test_p1_survey_readonly.py` runs it
against recording fakes and fails on any write. Targets are decided by
`app/core/isolation.py`: outside production only a local MongoDB and a `demo-`
emulator project; a production run off Cloud Run additionally needs
ZIPPER_ALLOW_PRODUCTION_ACCESS set to the project id.
Exit code 0 = no legacy strings, 3 = some found (for scripting).
"""

from __future__ import annotations

import asyncio
import hashlib
from collections import Counter

LEGACY = {"admin": "app_admin", "ops": "ops_member", "tech": "tech_member",
          "finance": "finance_member", "support": "support_member"}


#: crmUsers roles that are partners, not staff — excluded from the orphan check.
PARTNER_CRM_ROLES = {"agency", "seller"}
#: Mongo roles with no crmUsers document by design (crm_directory.NOT_MIRRORED).
NOT_MIRRORED = {"observer", "agency", "seller"}


def _fp(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:8]


async def _run() -> int:
    from app.db import firebase, mongo
    from app.db.mongo import C, get_db

    firebase.init()
    # ensure=False: `ensure_indexes()` is DDL — a write. This tool only reads.
    await mongo.connect(ensure=False)
    client = firebase.firestore_client()
    print(f"project: {getattr(client, 'project', '')}  (read-only)")

    staff_role = {}
    async for row in get_db()[C.STAFF].find({}, {"uid": 1, "role": 1}):
        if row.get("uid"):
            staff_role[str(row["uid"])] = str(row.get("role", ""))

    roles: Counter = Counter()
    flagged: list[tuple[str, str, str, str]] = []
    crm_staff_uids: set[str] = set()
    orphan_crm: Counter = Counter()  # staff-role crmUsers doc, no Mongo staff row
    for d in client.collection("crmUsers").stream():
        data = d.to_dict() or {}
        raw = str(data.get("role", ""))
        roles[raw] += 1
        if raw not in PARTNER_CRM_ROLES:
            crm_staff_uids.add(d.id)
            if d.id not in staff_role:
                orphan_crm[f"{raw or '(empty)'} active={data.get('isActive', True) is not False}"] += 1
        legacy_in_roles = [r for r in (data.get("roles") or []) if r in LEGACY]
        if raw in LEGACY or legacy_in_roles:
            mongo_role = staff_role.get(d.id, "")
            flagged.append((_fp(d.id), raw, mongo_role or "(no staff row)", ",".join(legacy_in_roles)))

    print("\ncrmUsers.role values:")
    for k, v in sorted(roles.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {k or '(empty)'}: {v}{'   ← LEGACY' if k in LEGACY else ''}")
    print(f"\nlegacy documents: {len(flagged)}")
    for fp, raw, mrole, extra in flagged:
        print(f"  doc #{fp}  crmUsers.role={raw!r} → reads as {LEGACY.get(raw, raw)!r} in CRM/API; "
              f"Mongo staff.role={mrole!r}{'; legacy in roles[]: ' + extra if extra else ''}")
    print(f"\norphaned crmUsers staff documents (no Mongo staff row): {sum(orphan_crm.values())}")
    for k, v in sorted(orphan_crm.items()):
        print(f"  {k}: {v}")
    missing = Counter(r for u, r in staff_role.items() if r not in NOT_MIRRORED and u not in crm_staff_uids)
    print(f"Mongo staff rows with no crmUsers document (observer excluded): {sum(missing.values())}"
          + (f" {dict(missing)}" if missing else ""))
    legacy_mongo = Counter(r for r in staff_role.values() if r in LEGACY)
    if legacy_mongo:
        print(f"\nMongo staff rows with a legacy string (should be none): {dict(legacy_mongo)}")
    return 3 if flagged or legacy_mongo else 0


def main() -> int:
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
