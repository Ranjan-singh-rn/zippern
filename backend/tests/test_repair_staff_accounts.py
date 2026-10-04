"""The repair script, in both directions.

Every account created before `app/services/crm_directory.py` existed is missing
one of its two halves — the CRM's /team screen wrote Firestore only, the API's
invite wrote Mongo only. `scripts/repair_staff_accounts.py` finds them and
writes the half that is missing, and these tests drive the real script end to
end: the same `run()` the owner types, with `sys.argv` set the same way.

Four things they hold it to:

  * it repairs in **both** directions, preserving the role that already exists;
  * it is dry-run by default, and a dry run writes nothing at all;
  * it reports what it cannot repair rather than guessing — an orphaned
    document, a role that maps to nothing, an account whose two halves disagree
    about which uid it is;
  * it **never touches the observer**, and says so out loud either way.

Run:  python3 -m tests.test_repair_staff_accounts
"""

from __future__ import annotations

import asyncio
import io
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db import mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

import scripts.repair_staff_accounts as repair  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
fs = FakeFirestore()
crm_users = fs.collection("crmUsers")
fb._fs = fs

audit_entries: list[dict] = []


async def fake_audit_record(**kwargs):
    if not (kwargs.get("reason") or "").strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")
    audit_entries.append(kwargs)
    return "audit-id"


async def _noop() -> None:
    return None


audit_mod.record = fake_audit_record
mongo.get_db = lambda: db
mongo.connect = _noop
mongo.disconnect = _noop
fb.init = lambda: None

#: Every Firebase Auth account that exists, email → uid.
AUTH: dict[str, str] = {
    "tanishque@example.com": "uid-owner",
    "rhea@example.com": "uid-rhea",
    "finance@example.com": "uid-finance",
    "old@example.com": "uid-old",
    "boss@example.com": "uid-boss",
}


class AuthUser:
    def __init__(self, uid: str):
        self.uid = uid


fb.get_user_by_email = lambda email: (
    AuthUser(AUTH[email.lower()]) if email.lower() in AUTH else None
)
fb.get_user = lambda uid: (AuthUser(uid) if uid in AUTH.values() else None)

OBSERVER_EMAIL = "314zipper@gmail.com"
NOW = datetime.now(timezone.utc)


def staff_row(uid: str, email: str, name: str, role: str, **extra) -> dict:
    return {
        "uid": uid,
        "email": email,
        "name": name,
        "role": role,
        "is_active": True,
        "created_at": NOW,
        "updated_at": NOW,
        **extra,
    }


def crm_doc(uid: str, email: str, name: str, role: str, **extra) -> dict:
    return {
        "uid": uid,
        "email": email,
        "name": name,
        "role": role,
        "isActive": True,
        "permissions": [],
        "createdBy": "legacy",
        **extra,
    }


async def seed() -> None:
    # ── Healthy: both halves, created by scripts/seed_accounts.py ────────────
    await db[C.STAFF].insert_one(
        staff_row("uid-owner", "tanishque@example.com", "Tanishque", "owner")
    )
    crm_users.document("uid-owner").set(
        crm_doc("uid-owner", "tanishque@example.com", "Tanishque", "superadmin")
    )

    # ── The observer: a Mongo row and, correctly, no document at all ─────────
    await db[C.STAFF].insert_one(
        staff_row(f"observer:{OBSERVER_EMAIL}", OBSERVER_EMAIL, "Observer", "observer")
    )

    # ── Created through /team-access: Mongo only. Cannot pass the CRM login ──
    await db[C.STAFF].insert_one(
        staff_row("uid-rhea", "rhea@example.com", "Rhea Nair", "tech_admin",
                  phone="9876500001")
    )

    # ── Created through /team: Firestore only. This is the reported bug ──────
    crm_users.document("uid-finance").set(
        crm_doc("uid-finance", "finance@example.com", "Farah Khan", "finance_admin",
                phone="9876500002", fieldCharge="Payout Reviewer")
    )

    # ── Firestore only, and on a role string from before the departments ─────
    crm_users.document("uid-old").set(
        crm_doc("uid-old", "old@example.com", "Om Lal", "ops")
    )

    # ── Firestore only, and revoked. Repairing it must not restore access ────
    crm_users.document("uid-boss").set(
        crm_doc("uid-boss", "boss@example.com", "Bela Sen", "support_admin",
                isActive=False)
    )

    # ── Cannot repair: the document names no Firebase Auth account ───────────
    crm_users.document("uid-ghost").set(
        crm_doc("uid-ghost", "ghost@example.com", "Ghost", "app_member")
    )

    # ── Cannot repair: 'superadmin' is the CRM spelling of 'owner' ───────────
    crm_users.document("uid-selfmade").set(
        crm_doc("uid-selfmade", "selfmade@example.com", "Self Made", "superadmin")
    )

    # ── Not staff: an agency's own record, written by the signup flow ────────
    crm_users.document("uid-agency").set(
        crm_doc("uid-agency", "skyline@example.com", "Skyline Talents", "agency",
                agencyId="agency-main-1")
    )


asyncio.run(seed())


def run_script(*argv: str) -> str:
    """Run the script exactly as the owner would, and return what it printed."""
    saved = sys.argv
    sys.argv = ["repair_staff_accounts.py", *argv]
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            code = repair.main()
    finally:
        sys.argv = saved
    check(f"`{' '.join(argv) or '(no flags)'}` exits 0", code, 0)
    return buffer.getvalue()


# ══════════════════════════════════════════════════════════════════════════════
# 1. Dry run — finds everything, writes nothing
# ══════════════════════════════════════════════════════════════════════════════

staff_before = len(db[C.STAFF].docs)
docs_before = dict(crm_users.docs)

output = run_script()

ok("the dry run announces itself", "DRY RUN — nothing will be written" in output)
ok("it names the account that needs a CRM document", "rhea@example.com" in output)
ok("and the one that needs a staff row", "finance@example.com" in output)
ok("it prints a summary", "── Summary ──" in output)
ok("it says what would be written, not what was", "crmUsers documents to write" in output)
ok("and how to write it", "python -m scripts.repair_staff_accounts --confirm" in output)

check("a dry run creates no staff row", len(db[C.STAFF].docs), staff_before)
check("and writes no Firestore document", crm_users.docs, docs_before)
check("and writes no audit entry", audit_entries, [])
check("nothing was deleted either", crm_users.deleted, [])

# ── The observer, verified and named, on every run ───────────────────────────
ok("the dry run has an Observer section", "\n  Observer\n" in output)
ok(
    "and states positively that it has no document",
    f"✓ {OBSERVER_EMAIL} has no crmUsers document" in output,
)
ok("and that it was left alone", "untouched" in output)

# ── What it refuses to guess at ──────────────────────────────────────────────
ok("unrepairable accounts are reported", "Reported, not repaired" in output)
ok("an orphaned document is named", "ghost@example.com" in output)
ok("and explained rather than left a mystery", "names no Firebase Auth account" in output)
ok("a self-made superadmin is refused", "selfmade@example.com" in output)
ok("because minting an owner is not a script's decision", "sign money" in output)
ok("an agency is recognised as not staff", "skyline@example.com" in output)
ok("and left alone", "Not staff — left alone" in output)


# ══════════════════════════════════════════════════════════════════════════════
# 2. --confirm — both directions repaired
# ══════════════════════════════════════════════════════════════════════════════

output = run_script("--confirm")

ok("the write run announces itself", "WRITING" in output)

# ── Direction one: a Mongo row that had no CRM document ──────────────────────
doc = crm.read("uid-rhea")
ok("Rhea now has a crmUsers document", doc is not None)
check("carrying the role her staff row already had", doc["role"], "tech_admin")
check("and the department the shell groups by", doc["dept"], "tech")
check("and the address", doc["email"], "rhea@example.com")
check("active", doc["isActive"], True)
check(
    "with the permissions that role has always had",
    sorted(doc["permissions"]),
    sorted(crm.DEFAULT_PERMISSIONS["tech_admin"]),
)
check(
    "and her API record is untouched",
    asyncio.run(db[C.STAFF].find_one({"uid": "uid-rhea"}))["role"],
    "tech_admin",
)

# ── Direction two: a CRM document that had no Mongo row ──────────────────────
row = asyncio.run(db[C.STAFF].find_one({"email": "finance@example.com"}))
ok("Farah now has a staff row", row is not None)
check("preserving the role the document carried", row["role"], "finance_admin")
check("with the team that role belongs to", row["team"], "finance")
check("filed under the uid the document was filed under", row["uid"], "uid-finance")
check("carrying the phone the document had", row["phone"], "9876500002")
check("and the named responsibility", row["field_charge"], "Payout Reviewer")
check("active", row["is_active"], True)
check(
    "and her CRM document is untouched",
    crm.read("uid-finance")["role"],
    "finance_admin",
)

# A legacy role string is read the way the CRM front end reads it, not guessed.
row = asyncio.run(db[C.STAFF].find_one({"email": "old@example.com"}))
check("a legacy 'ops' document becomes an ops_member row", row["role"], "ops_member")
ok("and the translation is stated", "legacy role 'ops' read as 'ops_member'" in output)

# A revoked account stays revoked. Repairing an identity is not restoring access.
row = asyncio.run(db[C.STAFF].find_one({"email": "boss@example.com"}))
ok("a revoked document still produces a row", row is not None)
check("and the row is inactive, as the document said", row["is_active"], False)
ok("which the output says out loud", "inactive, as the CRM document says" in output)

# ── Audited, with a reason, as a repair rather than a creation ───────────────
ok("every repair is audited", len(audit_entries) >= 4)
check(
    "as its own action",
    sorted({e["action"] for e in audit_entries}),
    ["staff.mirror_repaired"],
)
ok(
    "every entry carries a reason",
    all(e["reason"].strip() for e in audit_entries),
)
ok(
    "and says the missing half is the thing that changed",
    all(
        "missing" in str(e["before"]) for e in audit_entries
    ),
)
ok(
    "the actor is a named machine, not a borrowed person",
    all(e["actor"]["uid"] == "system:repair_staff_accounts" for e in audit_entries),
)

# ── Still nothing done to the observer ───────────────────────────────────────
check("the observer still has no document", crm.find_by_email(OBSERVER_EMAIL), [])
ok(
    "and the write run says so too",
    f"✓ {OBSERVER_EMAIL} has no crmUsers document" in output,
)
ok("nothing was deleted by the repair", crm_users.deleted == [])

# ── Nothing was invented for what it refused ─────────────────────────────────
check(
    "no staff row for the orphaned document",
    asyncio.run(db[C.STAFF].find_one({"email": "ghost@example.com"})),
    None,
)
check(
    "no owner was minted from a superadmin document",
    asyncio.run(db[C.STAFF].find_one({"email": "selfmade@example.com"})),
    None,
)
check(
    "and no staff row for an agency",
    asyncio.run(db[C.STAFF].find_one({"email": "skyline@example.com"})),
    None,
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Running it again is a no-op
# ══════════════════════════════════════════════════════════════════════════════

entries_before = len(audit_entries)
rows_before = len(db[C.STAFF].docs)
docs_before = dict(crm_users.docs)

output = run_script("--confirm")

check("a second run repairs nothing", len(audit_entries), entries_before)
check("creates no row", len(db[C.STAFF].docs), rows_before)
check("and writes no document", crm_users.docs, docs_before)
ok("everything it fixed now counts as healthy", "accounts already in both" in output)


# ══════════════════════════════════════════════════════════════════════════════
# 4. A stray observer document is reported and NOT removed
# ══════════════════════════════════════════════════════════════════════════════
#
# Removing it is `scripts/seed_accounts.py`'s job, deliberately. This script is
# run to fix accounts; the observer is the one account where "missing" is
# correct, so it stays out of the way and says what it saw.

crm_users.document("uid-stray-observer").set(
    crm_doc("uid-stray-observer", OBSERVER_EMAIL, "Observer", "superadmin")
)

output = run_script("--confirm")

ok(
    "a stray observer document is reported as a problem",
    f"✗ {OBSERVER_EMAIL} HAS a crmUsers document" in output,
)
ok("naming the document and what it grants", "uid-stray-observer" in output)
ok("and the write access it hands out", "write access on every" in output)
ok("it points at the script that removes it", "scripts.seed_accounts" in output)
ok(
    "and it does not remove it itself",
    crm_users.docs.get("uid-stray-observer") is not None,
)
check(
    "nor does it give the observer a staff row it does not have",
    len(db[C.STAFF].docs),
    rows_before,
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Halves that disagree about which uid the account is
# ══════════════════════════════════════════════════════════════════════════════

crm_users.docs.pop("uid-stray-observer")
AUTH["split@example.com"] = "uid-split-auth"
asyncio.run(
    db[C.STAFF].insert_one(
        staff_row("uid-split-mongo", "split@example.com", "Sam Split", "app_member")
    )
)
crm_users.document("uid-split-firestore").set(
    crm_doc("uid-split-firestore", "split@example.com", "Sam Split", "app_member")
)

output = run_script()

ok("a uid disagreement is reported", "split@example.com" in output)
ok("and named as a disagreement", "one of these is" in output)
ok("rather than repaired by guessing", "not this script's decision" in output)
check(
    "and no third document is written for it",
    crm.read("uid-split-mongo"),
    None,
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. One direction at a time
# ══════════════════════════════════════════════════════════════════════════════

output = run_script("--only", "crm")
ok("--only crm names the direction it is running", "staff rows missing a CRM" in output)

output = run_script("--only=mongo")
ok("--only=mongo works too", "CRM documents missing a staff row" in output)

saved = sys.argv
sys.argv = ["repair_staff_accounts.py", "--only", "sideways"]
buffer = io.StringIO()
with redirect_stdout(buffer):
    code = repair.main()
sys.argv = saved
check("an unknown direction is refused", code, 1)
ok("with a reason", "--only must be one of" in buffer.getvalue())


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} repair-script checks passed.")
print("  · a dry run finds every half-created account and writes nothing")
print("  · a Mongo row with no crmUsers document gets one, at the role it holds")
print("  · a crmUsers document with no staff row gets one, at the role it holds")
print("  · a revoked account stays revoked; a legacy role reads as the CRM reads it")
print("  · an orphaned document, a superadmin and an agency are reported, not guessed")
print("  · the observer is verified, named, and never written to")
sys.exit(0)
