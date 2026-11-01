"""A staff account is two records, and one call has to write both.

The bug these cover: a Zipper staff account needs a Mongo `staff` row *and* a
Firestore `crmUsers` document, and until now no creation path wrote both. An
account with only the Firestore half signs into the CRM shell, renders every
tab, and then reports that it cannot load data on every API-backed screen. An
account with only the Mongo half cannot get past the CRM login at all.

So these tests do not check that a function was called. They check, after each
operation, that **both doors are open** — the query `sign_in_with_firebase` makes
against Mongo, and the read `crmSignIn` makes against Firestore — and that the
observer, which must hold no Firestore document at all, still holds none.

No database and no network: `tests/fakes.py` stubs the I/O underneath, so the
code exercised here is the real `app/services/staff.py` and the real
`app/services/crm_directory.py`.

Run:  python3 -m tests.test_staff_directory
"""

from __future__ import annotations

import asyncio
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

# `app.services.staff` imports the email service lazily, inside `invite`. It is
# replaced here rather than stubbed at the provider level because none of these
# tests are about email — what matters is only that a set-password link is not
# sent for an account that was not fully created.
import app.services  # noqa: E402

sent_invitations: list[dict] = []
_email_stub = types.ModuleType("app.services.email")
_email_stub.send_staff_invitation = lambda **kw: bool(sent_invitations.append(kw)) or True
sys.modules["app.services.email"] = _email_stub
app.services.email = _email_stub  # type: ignore[attr-defined]

from app.core import roles as R  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import staff as svc  # noqa: E402
from app.services.staff import Invitation, StaffError  # noqa: E402

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


def refuses(label: str, coro_factory) -> str:
    """This must be refused with a message, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = asyncio.run(coro_factory())
    except StaffError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted StaffError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
fs = FakeFirestore()
fb._fs = fs

crm_users = fs.collection("crmUsers")
audit_entries: list[dict] = []


async def fake_audit_record(**kwargs):
    if not (kwargs.get("reason") or "").strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")
    audit_entries.append(kwargs)
    return "audit-id"


audit_mod.record = fake_audit_record
svc.get_db = lambda: db


class AuthUser:
    def __init__(self, uid: str):
        self.uid = uid


auth_accounts: dict[str, str] = {}  # email → uid
_next_uid = [0]


def fake_create_user(*, email, display_name="", password="", email_verified=False):
    _next_uid[0] += 1
    uid = f"fb-uid-{_next_uid[0]}"
    auth_accounts[email.lower()] = uid
    return AuthUser(uid)


svc.fb_auth.create_user = fake_create_user
svc.fb_auth.generate_password_reset_link = lambda email: f"https://reset/{email}"
fb.get_user_by_email = lambda email: (
    AuthUser(auth_accounts[email.lower()]) if email.lower() in auth_accounts else None
)
fb.get_user = lambda uid: (AuthUser(uid) if uid in auth_accounts.values() else None)

OWNER = {"uid": "owner-1", "name": "Tanishque", "role": Role.OWNER, "team": None}
OBSERVER_EMAIL = "314zipper@gmail.com"


def actions_for(uid: str) -> list[str]:
    return [e["action"] for e in audit_entries if e["subject_id"] == uid]


def api_door_open(uid: str) -> dict | None:
    """The query `app/core/security.py::sign_in_with_firebase` makes."""
    return asyncio.run(db[C.STAFF].find_one({"uid": uid}))


def crm_door_open(uid: str) -> dict | None:
    """The read `zipper-crm/lib/auth.ts::crmSignIn` makes."""
    return crm.read(uid)


# ══════════════════════════════════════════════════════════════════════════════
# 1. The two vocabularies line up, and nothing falls between them
# ══════════════════════════════════════════════════════════════════════════════

for role in Role:
    ok(
        f"{role} either has a CRM spelling or a recorded reason to have none",
        role in crm.CRM_ROLE or role in crm.NOT_MIRRORED,
    )

check("an owner is a CRM superadmin", crm.crm_role_for(Role.OWNER), "superadmin")
check("the observer has no CRM spelling at all", crm.crm_role_for(Role.OBSERVER), None)
ok(
    "and the reason is recorded rather than implied",
    "read-only" in crm.NOT_MIRRORED[Role.OBSERVER],
)

# Every department role is spelled the same on both sides. If that ever stops
# being true, the shell and the API disagree about what somebody is.
for role in sorted(crm.CRM_ROLE, key=str):
    if role is Role.OWNER:
        continue
    check(f"{role} is spelled the same on both sides", crm.CRM_ROLE[role], str(role))

# The reverse direction refuses to mint an owner from a script.
check("superadmin does not map back to a role", crm.mongo_role_for("superadmin"), None)
ok(
    "and the refusal says why",
    "sign money" in crm.MONGO_ROLE_REFUSED["superadmin"],
)
check("a legacy role reads as the CRM reads it", crm.normalise_crm_role("ops"), "ops_member")
check("a legacy admin maps to the app department", crm.normalise_crm_role("admin"), "app_admin")


# ── The permission defaults are the front end's, not a second opinion ────────
#
# A document written with the wrong permissions is the same class of bug in a
# different place: the tab is there and the screen refuses. So the Python table
# is checked against the TypeScript one that `createCrmUser` used, by reading it.

TS_AUTH = ROOT.parent / "zipper-crm" / "lib" / "auth.ts"


def parse_ts_permissions(text: str) -> dict[str, list[str]]:
    start = text.index("export const DEFAULT_PERMISSIONS")
    start = text.index("{", start)
    depth = 0
    end = start
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = re.sub(r"//[^\n]*", "", text[start + 1 : end])
    return {
        m.group(1): re.findall(r"'([a-z_]+)'", m.group(2))
        for m in re.finditer(r"([A-Za-z_]+)\s*:\s*\[([^\]]*)\]", block)
    }


if TS_AUTH.exists():
    ts_permissions = parse_ts_permissions(TS_AUTH.read_text())
    check(
        "every CRM role in the front end has a permission default here",
        sorted(ts_permissions),
        sorted(crm.DEFAULT_PERMISSIONS),
    )
    for role_name in sorted(ts_permissions):
        check(
            f"{role_name} permissions match zipper-crm/lib/auth.ts",
            sorted(crm.DEFAULT_PERMISSIONS.get(role_name, ())),
            sorted(ts_permissions[role_name]),
        )
else:  # pragma: no cover — running the backend outside the monorepo
    print(f"  · {TS_AUTH} not present; permission parity not checked")


# ══════════════════════════════════════════════════════════════════════════════
# 2. An invitation creates BOTH halves
# ══════════════════════════════════════════════════════════════════════════════

created = asyncio.run(
    svc.invite(
        Invitation(
            email="Rhea@Example.com",
            name="Rhea Nair",
            role=Role.TECH_ADMIN,
            phone="9876500001",
            field_charge="Economy Config Owner",
        ),
        OWNER,
    )
)
RHEA = created["uid"]

check("the invitation reports the API record", created["role"], "tech_admin")
check("and the CRM document", created["crm_user_document"], "written")
check("under the CRM's spelling of the role", created["crm_role"], "tech_admin")

row = api_door_open(RHEA)
ok("the API door is open — sign_in_with_firebase finds a staff row", row is not None)
check("with the role that was invited", row["role"], "tech_admin")
check("active", row["is_active"], True)
check("and the address lower-cased", row["email"], "rhea@example.com")

doc = crm_door_open(RHEA)
ok("the CRM door is open — crmSignIn finds a crmUsers document", doc is not None)
check("carrying the same role", doc["role"], "tech_admin")
check("the same address", doc["email"], "rhea@example.com")
check("the department the shell groups by", doc["dept"], "tech")
check("active, or crmSignIn refuses it", doc["isActive"], True)
check("the name the team screen shows", doc["name"], "Rhea Nair")
check("the phone", doc["phone"], "9876500001")
check("the named responsibility", doc["fieldCharge"], "Economy Config Owner")
check("reporting to whoever invited them", doc["reportsTo"], "owner-1")
check(
    "and the permissions a tech admin has always had",
    sorted(doc["permissions"]),
    sorted(crm.DEFAULT_PERMISSIONS["tech_admin"]),
)
ok("with a human-readable id, as the team screen expects", len(doc["crmId"]) == 8)
check("the document is filed under the Firebase uid", doc["uid"], RHEA)

check("creation is audited", actions_for(RHEA), ["staff.created"])
check(
    "and the entry names the CRM role it wrote",
    audit_entries[-1]["meta"]["crm_role"],
    "tech_admin",
)
check("a set-password link was sent", len(sent_invitations), 1)

# Inviting the same address twice is refused, and now says which half exists.
message = refuses(
    "a second invitation to the same address",
    lambda: svc.invite(
        Invitation(email="rhea@example.com", name="Rhea Nair", role=Role.TECH_ADMIN),
        OWNER,
    ),
)
ok("the refusal names the address", "rhea@example.com" in message)
ok(
    "and does not send them to the repair script for a healthy account",
    "repair_staff_accounts" not in message,
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. The observer never gains a Firestore document
# ══════════════════════════════════════════════════════════════════════════════
#
# The old vocabulary has no read-only tier — its lowest useful value is
# 'superadmin', which is full write on every Firestore-backed page. A document
# for the observer is not a smaller version of the account; it is the opposite
# of it.

# Someone has already left one behind, under a different uid, as happens when an
# address is added through a screen that writes Firestore directly.
crm_users.document("stray-observer-uid").set(
    {
        "uid": "stray-observer-uid",
        "email": OBSERVER_EMAIL,
        "name": "Observer",
        "role": "superadmin",
        "isActive": True,
    }
)
ok(
    "the stray document is there before the invitation",
    crm_users.docs.get("stray-observer-uid") is not None,
)

# ── Inviting one is refused outright ─────────────────────────────────────────
#
# Stronger than "it gets no document". The observer is a single permanent
# account — `settings.observer_email`, seeded by `scripts/seed_accounts.py` —
# and `invite` cannot actually produce a working one: no CRM document by design,
# a "set your password" email for an account whose only door is an emailed code,
# that code delivered to one fixed mailbox whoever it is for, and `security.py`
# refusing any Firebase-token observer session. It used to be offered to owners
# and would create an account nobody could sign in to.
refused_observer = ""
try:
    asyncio.run(
        svc.invite(
            Invitation(email=OBSERVER_EMAIL, name="Observer", role=Role.OBSERVER),
            OWNER,
        )
    )
    checks += 1
    failures.append("an owner was allowed to invite a second observer")
except StaffError as exc:
    checks += 1
    refused_observer = str(exc)
    # Refused by `assignable_roles` first, and by the dedicated guard in
    # `invite` if a list ever contained it again. Asserted as the property,
    # because which of the two speaks is an implementation detail.
    ok("an owner cannot invite an observer", "observer" in refused_observer.lower())

ok("and it is not on the list of roles an owner may assign",
   Role.OBSERVER not in svc.assignable_roles(Role.OWNER))
ok("nor on the observer's own list, so it cannot clone itself",
   Role.OBSERVER not in svc.assignable_roles(Role.OBSERVER))

# The seeded observer, as `scripts/seed_accounts.py` leaves it: a Mongo row with
# the synthetic uid and no Firestore document anywhere.
OBSERVER_UID = f"observer:{OBSERVER_EMAIL}"
asyncio.run(
    db[C.STAFF].insert_one(
        {
            "uid": OBSERVER_UID,
            "email": OBSERVER_EMAIL,
            "name": "Observer",
            "role": str(Role.OBSERVER),
            "team": None,
            "is_active": True,
        }
    )
)

# The stray document is still removed — by address, because the observer's uid
# is synthetic and matches no Firestore document ever written.
crm.mirror(
    uid=OBSERVER_UID,
    email=OBSERVER_EMAIL,
    name="Observer",
    role=Role.OBSERVER,
    created_by="seed",
)
check(
    "the stray one — matched on email, not uid — is gone",
    crm.find_by_email(OBSERVER_EMAIL),
    [],
)
ok(
    "the deletion is recorded as the removal of write access",
    "stray-observer-uid" in crm_users.deleted,
)

# Nothing is written for it on a second pass either — "absent" is the end state,
# not a step towards one.
again = crm.mirror(
    uid=OBSERVER_UID,
    email=OBSERVER_EMAIL,
    name="Observer",
    role=Role.OBSERVER,
    created_by="seed",
)
check("a second pass leaves it absent by design", again.action, "absent_by_design")
check("still nothing under its uid", crm_door_open(OBSERVER_UID), None)
check("and nothing under its address", crm.find_by_email(OBSERVER_EMAIL), [])

# Phase 1A (STAFF-001): CHANGED EXPECTATION. The observer cannot be
# deactivated at all — the attempt is refused — and still nothing is written.
try:
    asyncio.run(
        svc.deactivate(OBSERVER_UID, OWNER, "Rotating the observer to a new person.")
    )
    check("an owner deactivating the observer is refused", "allowed", "refused")
except svc.StaffError:
    check("an owner deactivating the observer is refused", "refused", "refused")
check(
    "and no document is written for it",
    crm.find_by_email(OBSERVER_EMAIL),
    [],
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. A role change updates both
# ══════════════════════════════════════════════════════════════════════════════
#
# A stale `crmUsers.role` is its own bug: the shell shows one thing and the API
# enforces another, and the person finds out one refused screen at a time.

asyncio.run(db[C.SESSIONS].insert_one({"jti": "j-rhea", "uid": RHEA, "revoked": False}))

changed = asyncio.run(
    svc.change_role(
        RHEA, Role.FINANCE_MEMBER, OWNER, "Moving to finance after the reshuffle."
    )
)

check("the API record carries the new role", api_door_open(RHEA)["role"], "finance_member")
check("and so does the CRM document", crm_door_open(RHEA)["role"], "finance_member")
check("with the new department", crm_door_open(RHEA)["dept"], "finance")

# ── The transfer moves AUTHORITY, and `reports_to` is not how ────────────────
#
# `team` is the authorisation key now (`manages()`), so a department change moves
# authority by itself. Asserted as the property rather than as a field value:
# an earlier version of this test checked `reports_to` after the move and passed
# for the wrong reason, because this person happened to have been invited by the
# owner in the first place.
moved = api_door_open(RHEA)
check("the record now says finance", moved["team"], "finance")
ok(
    "an ops admin has no authority over them any more",
    not svc.manages({"uid": "ops-admin-x", "role": Role.OPS_ADMIN}, moved),
)
ok(
    "and the finance admin does, without having invited them",
    svc.manages({"uid": "finance-admin-x", "role": Role.FINANCE_ADMIN}, moved),
)
ok(
    "`reports_to` grants nothing on its own",
    not svc.manages(
        {"uid": moved.get("reports_to") or "whoever-invited-them",
         "role": Role.OPS_ADMIN},
        moved,
    ),
)
check("the response says the document was rewritten", changed["crm_user_document"], "written")
check(
    "the live session is revoked, so the old role cannot be replayed",
    asyncio.run(db[C.SESSIONS].find_one({"jti": "j-rhea"}))["revoked"],
    True,
)
check(
    "permissions follow the new role",
    sorted(crm_door_open(RHEA)["permissions"]),
    sorted(crm.DEFAULT_PERMISSIONS["finance_member"]),
)
ok(
    "and the old role's permissions do not linger",
    "can_economy_config" not in crm_door_open(RHEA)["permissions"],
)
ok("the change is audited", "staff.role_changed" in actions_for(RHEA))
ok("with no mirror failure recorded", "staff.mirror_failed" not in actions_for(RHEA))

# The two changes that are not an ordinary edit.
promoted = asyncio.run(
    svc.invite(
        Invitation(email="arjun@example.com", name="Arjun Rao", role=Role.OPS_MEMBER),
        OWNER,
    )
)
ARJUN = promoted["uid"]
# Phase 1A (STAFF-001/002): CHANGED EXPECTATION. An Owner can no longer
# promote anybody to Owner or Observer through `change_role` — Owners are made
# by the observer, and there is exactly one observer. Both are refused, and
# neither record moves.
for target_role, why in ((Role.OWNER, "Third owner, agreed at the board."),
                         (Role.OBSERVER, "Stepping back to a watching role.")):
    try:
        asyncio.run(svc.change_role(ARJUN, target_role, OWNER, why))
        check(f"a change to {target_role} via change_role is refused", "allowed", "refused")
    except svc.StaffError:
        check(f"a change to {target_role} via change_role is refused", "refused", "refused")
check("the API record is unchanged", api_door_open(ARJUN)["role"], "ops_member")
check("and so is the CRM document", crm_door_open(ARJUN)["role"], "ops_member")


# ══════════════════════════════════════════════════════════════════════════════
# 5. Deactivation reaches both
# ══════════════════════════════════════════════════════════════════════════════
#
# Revoking the API session is not revoking access: `crmSignIn` reads
# `crmUsers.isActive`, and while that still says true the shell opens and every
# Firestore-backed screen on it works.

leaving = asyncio.run(
    svc.invite(
        Invitation(email="dev@example.com", name="Dev Patel", role=Role.SUPPORT_MEMBER),
        OWNER,
    )
)
DEV = leaving["uid"]
asyncio.run(db[C.SESSIONS].insert_one({"jti": "j-dev", "uid": DEV, "revoked": False}))

asyncio.run(svc.deactivate(DEV, OWNER, "Left the company on 14 August; handover done."))

check("the API record is inactive", api_door_open(DEV)["is_active"], False)
check("the CRM document is inactive", crm_door_open(DEV)["isActive"], False)
check(
    "the live session is revoked",
    asyncio.run(db[C.SESSIONS].find_one({"jti": "j-dev"}))["revoked"],
    True,
)
ok("and it is audited", "staff.deactivated" in actions_for(DEV))
check(
    "the document is not deleted — history stays attributable",
    crm_door_open(DEV)["email"],
    "dev@example.com",
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. Partial failure is loud
# ══════════════════════════════════════════════════════════════════════════════
#
# Mongo first, Firestore second, on purpose. Of the two half-written states this
# can leave, the one it leaves is the one where nothing half-works: the CRM login
# refuses outright with a message. The other order would leave the account this
# whole exercise is about — shell opens, every tab present, every API screen
# saying it cannot load.

crm_users.fail_on("set")

message = refuses(
    "an invitation whose Firestore write fails",
    lambda: svc.invite(
        Invitation(email="maya@example.com", name="Maya Iyer", role=Role.APP_MEMBER),
        OWNER,
    ),
)
MAYA = auth_accounts["maya@example.com"]

ok("the caller is told the API record was saved", "saved to the API record" in message)
ok("and that the CRM entry was not", "was not written" in message)
ok("the reason from Firestore is passed through", "Firestore is unavailable" in message)
ok("and the exact repair command is in the message", crm.REPAIR_COMMAND in message)

ok("the staff row is still there — it is not silently rolled back", api_door_open(MAYA) is not None)
check("and the CRM document is genuinely absent", crm_door_open(MAYA), None)
check(
    "both the creation and the failure are in the audit log",
    actions_for(MAYA),
    ["staff.created", "staff.mirror_failed"],
)
failure_entry = [e for e in audit_entries if e["action"] == "staff.mirror_failed"][-1]
check(
    "and the failure entry carries the repair command",
    failure_entry["meta"]["repair"],
    crm.REPAIR_COMMAND,
)
check(
    "no set-password link was sent for an account that cannot sign in",
    [s for s in sent_invitations if s["to_email"] == "maya@example.com"],
    [],
)

# Re-inviting is the obvious thing to try, and it must not answer with a flat
# "an account already exists" that explains nothing.
message = refuses(
    "re-inviting the half-created account",
    lambda: svc.invite(
        Invitation(email="maya@example.com", name="Maya Iyer", role=Role.APP_MEMBER),
        OWNER,
    ),
)
ok("the refusal says which half is missing", "CRM directory entry is missing" in message)
ok("says re-inviting will not fix it", "Re-inviting will not fix" in message)
ok("and names the repair command", crm.REPAIR_COMMAND in message)

# A role change whose mirror fails: the change stands, and the caller is told.
message = refuses(
    "a role change whose Firestore write fails",
    lambda: svc.change_role(DEV, Role.SUPPORT_ADMIN, OWNER, "Promoting to run support."),
)
ok("the caller is told the change was saved", "was saved to the API record" in message)
ok("and given the repair command", crm.REPAIR_COMMAND in message)
check("the API record really did change", api_door_open(DEV)["role"], "support_admin")
check("and the CRM document really did not", crm_door_open(DEV)["role"], "support_member")
ok("the divergence is audited", "staff.mirror_failed" in actions_for(DEV))

# A deactivation whose mirror fails still revokes the session — the most
# valuable half is done first for exactly this reason.
asyncio.run(db[C.SESSIONS].insert_one({"jti": "j-dev-2", "uid": DEV, "revoked": False}))
asyncio.run(
    db[C.STAFF].update_one({"uid": DEV}, {"$set": {"is_active": True}})
)
message = refuses(
    "a deactivation whose Firestore write fails",
    lambda: svc.deactivate(DEV, OWNER, "Access revoked pending investigation."),
)
check(
    "the session is revoked anyway",
    asyncio.run(db[C.SESSIONS].find_one({"jti": "j-dev-2"}))["revoked"],
    True,
)
check("the API record is inactive anyway", api_door_open(DEV)["is_active"], False)
ok("and the caller is told the CRM half did not follow", crm.REPAIR_COMMAND in message)

crm_users.clear_failures()

# A staff row whose uid has no Firebase account cannot be given a document —
# the id would name nobody, and no token could ever be produced for it.
try:
    crm.mirror(
        uid="",
        email="ghost@example.com",
        name="Ghost",
        role=Role.OPS_MEMBER,
        created_by="test",
    )
    failures.append("a blank uid was accepted")
    checks += 1
except crm.DirectoryError as exc:
    checks += 1
    ok("a document with no uid is refused", "no Firebase uid" in str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# 8. The invite form offers nothing to somebody the endpoint will refuse
# ══════════════════════════════════════════════════════════════════════════════
#
# Every department runs itself. All six admins hold `CAN_MANAGE_TEAM` and all
# six are narrowed, by the server, to their own department at member tier.
#
# Finance and Tech are the regression. They did not hold the permission, so the
# form offered a role the endpoint refused — and the first attempt at a fix made
# `assignable_roles` return `[]` for them, which removed the button and wrote
# "Finance and Tech do not run their own departments" into the role model. The
# organisation model says the opposite. The permission was granted instead.

for role in sorted(R.ADMIN_ROLES, key=str):
    offered = svc.assignable_roles(role)
    team = R.team_of(role)
    ok(f"{role} holds CAN_MANAGE_TEAM",
       R.has_permission(role, R.Permission.CAN_MANAGE_TEAM))
    check(f"{role} is offered exactly their own department's member role",
          offered, [r for r in R.MEMBER_ROLES if R.team_of(r) == team])
    check(f"{role} is offered exactly one role", len(offered), 1)

    # The three things a department admin must never be able to create.
    ok(f"{role} cannot create any admin",
       not any(r in R.ADMIN_ROLES for r in offered))
    ok(f"{role} cannot create another department's member",
       all(R.team_of(r) == team for r in offered))
    ok(f"{role} cannot create an owner or the observer",
       Role.OWNER not in offered and Role.OBSERVER not in offered)

# Named outright, because these two are the ones that were wrong.
check("finance_admin creates finance_member and nothing else",
      svc.assignable_roles(Role.FINANCE_ADMIN), [Role.FINANCE_MEMBER])
check("tech_admin creates tech_member and nothing else",
      svc.assignable_roles(Role.TECH_ADMIN), [Role.TECH_MEMBER])

# A member is not an admin and runs nothing.
for role in sorted(R.MEMBER_ROLES, key=str):
    check(f"{role} is offered nothing", svc.assignable_roles(role), [])
    ok(f"{role} does not hold CAN_MANAGE_TEAM",
       not R.has_permission(role, R.Permission.CAN_MANAGE_TEAM))

# Phase 1A (STAFF-001): CHANGED EXPECTATION. Every department role and
# nothing else — not `owner` (the observer provisions owners) and not
# `observer`, which is a single permanent account.
ok("an owner is offered every department role and nothing else",
   sorted(map(str, svc.assignable_roles(Role.OWNER))) == sorted(map(str, R.STAFF_ROLES)))
ok("and not the owner role", Role.OWNER not in svc.assignable_roles(Role.OWNER))
ok("but not the observer",
   Role.OBSERVER not in svc.assignable_roles(Role.OWNER))
check("the observer may provision an owner, and only that",
      svc.assignable_roles(Role.OBSERVER), [Role.OWNER])


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} staff-directory checks passed.")
print("  · an invitation opens both doors — the Mongo row and the crmUsers document")
print("  · a role change rewrites both, and the old role's permissions do not linger")
print("  · a deactivation reaches both, and revokes the live session first")
print("  · the observer never gains a document, and a stray one is removed by email")
print("  · a failed mirror is raised, audited, and carries the repair command")
print("  · the permission defaults are the front end's, read from lib/auth.ts")
print("  · a department move moves authority, and reports_to grants nothing")
print("  · all six department admins create their own member role, and only that")
sys.exit(0)
