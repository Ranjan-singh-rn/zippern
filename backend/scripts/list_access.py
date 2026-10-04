"""Who can sign in, and where each account lives.

    python -m scripts.list_access

Access currently exists in two places while the front end is being migrated:

  * Firestore `crmUsers` — what the CRM reads to resolve a role and build nav
  * Mongo `staff`        — what the API reads to authorise every call

An account in Firestore but not Mongo can open the CRM but every money and
audit screen will refuse it. An account in Mongo but not Firestore can call the
API but cannot get past the CRM login. Both are worth knowing about.

Nothing creates a half-account any more: `POST /staff` writes both records in
one call (backend/app/services/crm_directory.py). This reports what is already
out there, and `scripts/repair_staff_accounts.py` fixes it.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase, mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402


async def main() -> int:
    firebase.init()
    await mongo.connect()

    # Firestore side
    fs_rows: dict[str, dict] = {}
    for doc in firebase.firestore_client().collection("crmUsers").stream():
        d = doc.to_dict() or {}
        email = (d.get("email") or "").lower()
        fs_rows[email or doc.id] = {
            "uid": doc.id,
            "email": email,
            "name": d.get("name", ""),
            "role": d.get("role", ""),
            "active": d.get("isActive", True),
        }

    # Mongo side
    mg_rows: dict[str, dict] = {}
    async for d in mongo.get_db()[C.STAFF].find({}):
        email = (d.get("email") or "").lower()
        mg_rows[email] = {
            "uid": d.get("uid", ""),
            "email": email,
            "name": d.get("name", ""),
            "role": d.get("role", ""),
            "active": d.get("is_active", True),
        }

    everyone = sorted(set(fs_rows) | set(mg_rows))

    print(f"\n  {len(everyone)} account(s) with some form of access\n")
    print(f"  {'EMAIL':<36} {'CRM (Firestore)':<18} {'API (Mongo)':<18} STATUS")
    print(f"  {'-' * 36} {'-' * 18} {'-' * 18} ------")

    orphans_fs, orphans_mg, inactive = [], [], []

    for email in everyone:
        fs = fs_rows.get(email)
        mg = mg_rows.get(email)

        fs_label = fs["role"] if fs else "—"
        mg_label = mg["role"] if mg else "—"

        if fs and not mg:
            status = "CRM only"
            orphans_fs.append(email)
        elif mg and not fs:
            status = "API only"
            orphans_mg.append(email)
        else:
            status = "both"

        is_active = (fs["active"] if fs else True) and (mg["active"] if mg else True)
        if not is_active:
            status += " · inactive"
            inactive.append(email)

        print(f"  {email:<36} {fs_label:<18} {mg_label:<18} {status}")

    if orphans_fs:
        print(
            f"\n  ⚠  {len(orphans_fs)} account(s) exist in Firestore only.\n"
            "     They can sign into the CRM, but every money and audit screen\n"
            "     will refuse them. If these are leftovers from testing, remove\n"
            "     them — they are live access to your admin portal."
        )
        for e in orphans_fs:
            print(f"       · {e}  (uid {fs_rows[e]['uid']})")
        print(
            "\n     Remove one with:\n"
            "       Firebase console → Firestore → crmUsers → delete the document\n"
            "       Firebase console → Authentication → delete the user"
        )

    if orphans_mg:
        print(f"\n  ⚠  {len(orphans_mg)} account(s) exist in Mongo only — they cannot")
        print("     get past the CRM login.")
        for e in orphans_mg:
            print(f"       · {e}")
        print(
            "\n     Repair them with:\n"
            "       python -m scripts.repair_staff_accounts            # see what it would do\n"
            "       python -m scripts.repair_staff_accounts --confirm  # write it\n"
            "     That script repairs the other direction too, and reports what it\n"
            "     will not guess at. It never touches the observer."
        )

    if not orphans_fs and not orphans_mg:
        print("\n  ✓ Both sides agree. Every account exists in exactly one state.")

    await mongo.disconnect()
    print()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
