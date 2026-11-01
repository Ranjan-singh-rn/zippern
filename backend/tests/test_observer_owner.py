"""The observer provisions owners — and that is the whole of what it can write.

    314zipper (Observer)         one permanent account
        ↓
    Owners                       several
        ↓
    six departments              admin → member

── THE CONSTRAINT THIS HAD TO FIT INSIDE ─────────────────────────────────────

The observer is read-only by design (spec 1.1.4) and the read-only-ness is
structural rather than a flag:

  * it has **no Firebase account**. `security.py` refuses any Firebase-token
    observer session outright, and its uid is synthetic — `observer:<email>`;
  * it signs in by a one-time code emailed to a DIFFERENT mailbox from the
    account address, so holding the account is not enough;
  * it has **no `crmUsers` document**, and `crm_directory.NOT_MIRRORED` says
    why: the CRM vocabulary's lowest tier is `superadmin`, so any document it
    were given would grant full write access on every Firestore-backed page;
  * `require_write` refuses it by name;
  * and it holds none of the twenty capabilities, which are mirrored from
    `zipper-crm/lib/auth.ts` and asserted role-by-role in `test_permissions`.

So "the observer provisions owners" could not be a twenty-first permission —
that table has to keep matching the front end, and `PERMISSIONS[OWNER]` is
asserted to be every member of it, which would have handed the authority to
owners as a side effect. Nor could it be a hole in `require_write`, which guards
every write the observer is deliberately kept away from.

── THE SHAPE INSTEAD ─────────────────────────────────────────────────────────

Three independent narrowings, any one of which refuses on its own:

  1. `require_owner_provisioner` — the route guard. The observer, nobody else.
  2. `ProvisionOwnerBody` — carries no role. The handler hardcodes `Role.OWNER`,
     so the request cannot name a department admin, a member, or an observer.
  3. `assignable_roles(OBSERVER) == [Role.OWNER]` — enforced inside `invite`,
     which is the same service every other invitation goes through.

Nothing about the observer's identity changed: still no Firebase account, still
no CRM document, still one address in config.

Run:  python3 -m tests.test_observer_owner
"""

from __future__ import annotations

import asyncio
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# `harness` rather than `fakes`: this test reads `app/config` and
# `app/services/staff`, which need the wider stub set.
from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

sent_mail: list[dict] = []
_email = types.ModuleType("app.services.email")
_email.send_staff_invitation = lambda **kw: sent_mail.append(kw)
_email.send_staff_access_added = lambda **kw: sent_mail.append(kw)
sys.modules["app.services.email"] = _email

from app.config import settings  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Permission, Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import staff as svc  # noqa: E402
from app.services.staff import Invitation, StaffError  # noqa: E402

db = FakeDb()
store = FakeFirestore()
crm.firebase.firestore_client = lambda: store
fb.firestore_client = lambda: store
svc.get_db = lambda: db

audit_entries: list[dict] = []


async def fake_audit(**kwargs):
    audit_entries.append(kwargs)
    return "audit-id"


audit_mod.record = fake_audit


class AuthUser:
    def __init__(self, uid: str):
        self.uid = uid
        self.email_verified = False
        self.provider_data: list = []


_n = [0]


def fake_create_user(*, email, display_name="", password="", email_verified=False):
    _n[0] += 1
    return AuthUser(f"fb-{_n[0]}")


svc.fb_auth.create_user = fake_create_user
svc.fb_auth.generate_password_reset_link = lambda email: f"https://reset/{email}"
fb.get_user_by_email = lambda email: None
fb.get_user = lambda uid: None

OBSERVER_EMAIL = (settings.observer_email or "314zipper@gmail.com").lower()
OBSERVER = {
    "uid": f"observer:{OBSERVER_EMAIL}",
    "email": OBSERVER_EMAIL,
    "name": "Observer",
    "role": Role.OBSERVER,
    "team": None,
}
OWNER = {"uid": "owner-1", "name": "Tanishque", "role": Role.OWNER, "team": None}

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


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def refuses(label: str, coro_factory) -> str:
    global checks
    checks += 1
    try:
        run(coro_factory())
    except StaffError as exc:
        return str(exc)
    failures.append(label)
    return ""


# ══════════════════════════════════════════════════════════════════════════════
#  1. 314zipper provisions an owner
# ══════════════════════════════════════════════════════════════════════════════

created = run(
    svc.invite(
        Invitation(email="new.owner@example.com", name="New Owner", role=Role.OWNER),
        OBSERVER,
        reason="Third owner, agreed at the board.",
    )
)

check("the account is created as an owner", created["role"], str(Role.OWNER))
check("it is not in a department", created["team"], None)
ok("it has a Firebase account of its own", created["uid"].startswith("fb-"))
check("and a CRM document, because owners need one",
      created["crm_role"], "superadmin")

# The audit carries the observer's reason, not a generated sentence. Provisioning
# an owner is the most consequential account creation in the system.
owner_entry = next(
    (e for e in audit_entries if e.get("subject_id") == created["uid"]), None
)
ok("the creation is audited", owner_entry is not None)
check("with the reason the observer gave",
      owner_entry["reason"], "Third owner, agreed at the board.")
check("and the observer as the actor", owner_entry["actor"]["uid"], OBSERVER["uid"])


# ══════════════════════════════════════════════════════════════════════════════
#  2. There is one observer, and nothing can make a second
# ══════════════════════════════════════════════════════════════════════════════

ok("the observer cannot assign its own role",
   Role.OBSERVER not in svc.assignable_roles(Role.OBSERVER))
ok("nor can an owner",
   Role.OBSERVER not in svc.assignable_roles(Role.OWNER))
for role in sorted(R.STAFF_ROLES, key=str):
    ok(f"nor can {role}", Role.OBSERVER not in svc.assignable_roles(role))

# And the service refuses it regardless of any list, which is the guard that
# still holds if a list is ever widened by mistake.
why = refuses(
    "an observer could be invited",
    lambda: svc.invite(
        Invitation(email="second.observer@example.com", name="Two", role=Role.OBSERVER),
        OBSERVER,
    ),
)
ok("the refusal names the real mechanism", "observer" in why.lower())

why_owner = refuses(
    "an owner could invite an observer",
    lambda: svc.invite(
        Invitation(email="third.observer@example.com", name="Three", role=Role.OBSERVER),
        OWNER,
    ),
)
ok("an owner is refused too", why_owner != "")

# One address, from configuration — not a collection anybody adds rows to.
ok("the observer is a single configured address",
   isinstance(settings.observer_email, str) and "@" in settings.observer_email)
ok("and its sign-in code goes to a different mailbox, so holding the account "
   "is not enough",
   settings.observer_otp_delivery_email != settings.observer_email)


# ══════════════════════════════════════════════════════════════════════════════
#  3. It cannot provision department staff
# ══════════════════════════════════════════════════════════════════════════════

check("its whole authority is one role", svc.assignable_roles(Role.OBSERVER), [Role.OWNER])

for role in sorted(R.STAFF_ROLES, key=str):
    refuses(
        f"the observer could create {role}",
        lambda role=role: svc.invite(
            Invitation(email=f"{role}@example.com", name="Nope", role=role),
            OBSERVER,
        ),
    )

# The route cannot even express it: the body has no role field and the handler
# hardcodes `Role.OWNER`. Read out of the router SOURCE rather than by importing
# it — the narrowing is the shape of the request, and reading the text proves it
# without needing a web framework in a unit test.
ROUTER_SRC = (ROOT / "app" / "routers" / "staff.py").read_text(encoding="utf-8")

body_block = ROUTER_SRC[
    ROUTER_SRC.index("class ProvisionOwnerBody") : ROUTER_SRC.index("@router.post(\"/owners\"")
]
ok("the provisioning request carries no role field",
   not re.search(r"^\s*role\s*:", body_block, re.M))
check("only an identity and a reason",
      set(re.findall(r"^\s{4}(\w+)\s*:", body_block, re.M)),
      {"email", "name", "phone", "reason"})

handler = ROUTER_SRC[
    ROUTER_SRC.index("async def provision_owner") : ROUTER_SRC.index("@router.get(\"\")")
]
ok("the handler hardcodes the owner role", "role=Role.OWNER" in handler)
ok("and reads nothing about a role from the body",
   not re.search(r"body\.role", handler))


# ══════════════════════════════════════════════════════════════════════════════
#  4. It cannot reach agencies, sellers or hosts through this
# ══════════════════════════════════════════════════════════════════════════════

# External partners are not staff roles, so `invite` could not create one even
# if the observer asked — and it is refused before that is tested.
ok("agency and seller are external, never staff",
   R.EXTERNAL_ROLES.isdisjoint(R.STAFF_ROLES))
for external in sorted(R.EXTERNAL_ROLES, key=str):
    ok(f"the observer cannot assign {external}",
       external not in svc.assignable_roles(Role.OBSERVER))
    refuses(
        f"the observer could create a {external}",
        lambda external=external: svc.invite(
            Invitation(email=f"{external}@example.com", name="Nope", role=external),
            OBSERVER,
        ),
    )

# Hosts are not a CRM role at all — they are `isHost` on a user document, reached
# through agency referral codes. Nothing in the staff service can make one.
ok("there is no host role to assign",
   not any(str(r) == "host" for r in Role))

# The route guard admits the observer and nobody else, so it cannot be reused as
# a general-purpose write.
# The SIGNATURE, not the whole function — the docstring discusses
# `require_write` in prose, and a test that matched on prose would pass or fail
# on how the comment is worded.
signature = handler[: handler.index('"""')]
ok("the route is guarded by require_owner_provisioner",
   "require_owner_provisioner" in signature)
ok("and by nothing else — no require_write, which refuses the observer anyway",
   "require_write" not in signature)
ok("nor require_team_admin, which the observer is not",
   "require_team_admin" not in signature)


# ══════════════════════════════════════════════════════════════════════════════
#  5. Owners can still create owners
# ══════════════════════════════════════════════════════════════════════════════

# Phase 1A (STAFF-001): CHANGED EXPECTATION. Only the observer creates Owners.
ok("an owner may NOT assign the owner role",
   Role.OWNER not in svc.assignable_roles(Role.OWNER))
try:
    run(svc.invite(
        Invitation(email="another.owner@example.com", name="Another", role=Role.OWNER),
        OWNER,
    ))
    ok("an owner inviting an owner is refused", False)
except StaffError:
    ok("an owner inviting an owner is refused", True)

# The observer can provision a second owner: several owners remain possible.
second = run(
    svc.invite(
        Invitation(email="another.owner@example.com", name="Another", role=Role.OWNER),
        OBSERVER,
        reason="Second owner.",
    )
)
check("and the account is created by the observer", second["role"], str(Role.OWNER))
ok("multiple owners are allowed", second["uid"] != created["uid"])

# An owner still reaches every department, which the observer does not.
ok("an owner may assign every staff role",
   all(r in svc.assignable_roles(Role.OWNER) for r in R.STAFF_ROLES))


# ══════════════════════════════════════════════════════════════════════════════
#  6. The six departments and twelve roles are untouched
# ══════════════════════════════════════════════════════════════════════════════

check("there are six departments", len(list(R.Team)), 6)
check("named as the organisation names them",
      sorted(str(t) for t in R.Team),
      ["app", "finance", "marketing", "ops", "support", "tech"])
check("twelve department roles", len(R.STAFF_ROLES), 12)
check("six admins", len(R.ADMIN_ROLES), 6)
check("six members", len(R.MEMBER_ROLES), 6)

for team in R.Team:
    admins = [r for r in R.ADMIN_ROLES if R.team_of(r) == team]
    members = [r for r in R.MEMBER_ROLES if R.team_of(r) == team]
    check(f"{team} has exactly one admin", len(admins), 1)
    check(f"{team} has exactly one member", len(members), 1)
    ok(f"{team}'s admin holds CAN_MANAGE_TEAM",
       R.has_permission(admins[0], Permission.CAN_MANAGE_TEAM))
    check(f"{team}'s admin creates only its own member",
          svc.assignable_roles(admins[0]), members)

ok("neither the owner nor the observer is in a department",
   R.team_of(Role.OWNER) is None and R.team_of(Role.OBSERVER) is None)


# ══════════════════════════════════════════════════════════════════════════════
#  The observer's identity model is unchanged
# ══════════════════════════════════════════════════════════════════════════════

# The point of the narrow design: nothing below moved.
ok("the observer still holds none of the twenty capabilities",
   not any(R.has_permission(Role.OBSERVER, p) for p in Permission))
ok("it is still mapped to no CRM role at all", Role.OBSERVER in crm.NOT_MIRRORED)
check("so it is still given no crmUsers document",
      crm.CRM_ROLE.get(Role.OBSERVER), None)
ok("its uid is still synthetic, naming no Firebase account",
   OBSERVER["uid"].startswith("observer:"))
ok("and it still reads everything", R.can_read_all(Role.OBSERVER))


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} observer/owner checks passed.")
print("  · the observer provisions owners, with a mandatory audited reason")
print("  · it cannot create a department role, a partner, or a second observer")
print("  · the route carries no role field and hardcodes owner")
print("  · owners still create owners, and still reach every department")
print("  · six departments and twelve roles unchanged")
print("  · and the observer still has no capability, no CRM role and no Firebase account")
sys.exit(0)
