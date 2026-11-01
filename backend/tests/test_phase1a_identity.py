"""Phase 1A — staff hierarchy, partner/staff separation and guest refusal.

STAFF-001  exactly one observer; only the observer creates or removes Owners;
           the last active Owner cannot be removed (counted, not hardcoded).
STAFF-002  Owners manage department roles only; never the observer, never
           another Owner, never their own role.
STAFF-003  staff never get partner roles; a role change cannot name one.
SECURITY-004 / ROLE-001  an account that already holds a partner role cannot be
           made staff by an invitation.
AUTH-002   a guest (no verified phone, no verified email on the Firebase Auth
           record) is offered no partner or host role, at filing or approval.

Run:  python3 -m tests.test_phase1a_identity
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

_email = types.ModuleType("app.services.email")
_email.send_staff_invitation = lambda **kw: None
_email.send_staff_access_added = lambda **kw: None
sys.modules["app.services.email"] = _email

from app.core import audit as audit_mod  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import partner_applications as pa  # noqa: E402
from app.services import staff as svc  # noqa: E402
from app.services import storage_claims  # noqa: E402
from app.services.staff import Invitation, StaffError  # noqa: E402

db = FakeDb()
store = FakeFirestore()
crm.firebase.firestore_client = lambda: store
fb.firestore_client = lambda: store
svc.get_db = lambda: db


async def _audit(**kw):
    return "audit-id"


audit_mod.record = _audit
storage_claims.apply_for_role = lambda uid, role: ""
storage_claims.clear = lambda uid: ""
fb.set_user_disabled = lambda uid, disabled: ""


class AuthUser:
    def __init__(self, uid, phone=None, email=None, email_verified=False, providers=()):
        self.uid = uid
        self.phone_number = phone
        self.email = email
        self.email_verified = email_verified
        self.provider_data = list(providers)


_n = [0]


def _create_user(*, email, display_name="", password="", email_verified=False):
    _n[0] += 1
    return AuthUser(f"fb-{_n[0]}")


svc.fb_auth.create_user = _create_user
svc.fb_auth.generate_password_reset_link = lambda email: f"https://reset/{email}"
existing_by_email: dict[str, AuthUser] = {}
fb.get_user_by_email = lambda email: existing_by_email.get(email)
auth_records: dict[str, AuthUser] = {}
fb.get_user = lambda uid: auth_records.get(uid)

OBSERVER = {"uid": "observer:314zipper@gmail.com", "name": "Observer", "role": Role.OBSERVER, "team": None}
OWNER_A = {"uid": "owner-a", "name": "A", "role": Role.OWNER, "team": None}

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def refused(label: str, factory) -> str:
    global checks
    checks += 1
    try:
        run(factory())
    except StaffError as exc:
        return str(exc)
    failures.append(label + " (was ALLOWED)")
    return ""


async def seed_staff(uid, role, active=True, email=None):
    await db[C.STAFF].insert_one({
        "uid": uid, "email": email or f"{uid}@zipper.test", "name": uid,
        "role": str(role), "team": str(R.team_of(role)) if R.team_of(role) else None,
        "is_active": active,
    })
    if role != Role.OBSERVER:   # the observer has no crmUsers document by design
        store.collection("crmUsers").document(uid).set({
            "uid": uid, "email": email or f"{uid}@zipper.test",
            "role": crm.crm_role_for(role), "isActive": active,
        })


run(seed_staff("owner-a", Role.OWNER))
run(seed_staff("owner-b", Role.OWNER))
run(seed_staff("observer:314zipper@gmail.com", Role.OBSERVER))
run(seed_staff("ops-admin", Role.OPS_ADMIN))
run(seed_staff("ops-member", Role.OPS_MEMBER))

# ══════════════════════════════════════════════════════════════════════════════
print("STAFF-001 — Owner creation is the observer's alone")
# ══════════════════════════════════════════════════════════════════════════════
ok("an Owner is not offered the owner role", Role.OWNER not in svc.assignable_roles(Role.OWNER))
ok("nor the observer role", Role.OBSERVER not in svc.assignable_roles(Role.OWNER))
ok("the observer is offered exactly [owner]", svc.assignable_roles(Role.OBSERVER) == [Role.OWNER])
refused("an Owner cannot invite an Owner",
        lambda: svc.invite(Invitation(email="x@zipper.test", name="X", role=Role.OWNER), OWNER_A))
refused("nobody can invite an observer",
        lambda: svc.invite(Invitation(email="y@zipper.test", name="Y", role=Role.OBSERVER), OBSERVER))
made = run(svc.invite(Invitation(email="owner-c@zipper.test", name="C", role=Role.OWNER), OBSERVER,
                      reason="Third owner."))
ok("the observer can create an Owner", made["role"] == str(Role.OWNER))
OWNER_C_UID = made["uid"]

# ══════════════════════════════════════════════════════════════════════════════
print("STAFF-001/003 — Owner removal: observer only, never the last")
# ══════════════════════════════════════════════════════════════════════════════
refused("an Owner cannot deactivate another Owner",
        lambda: svc.deactivate("owner-b", OWNER_A, "Disagreement."))
refused("an Owner cannot deactivate the observer",
        lambda: svc.deactivate("observer:314zipper@gmail.com", OWNER_A, "Remove watcher."))
refused("a department admin cannot deactivate an Owner",
        lambda: svc.deactivate("owner-b", {"uid": "ops-admin", "role": Role.OPS_ADMIN}, "x x x"))
out = run(svc.deactivate(OWNER_C_UID, OBSERVER, "Leaving the business."))
ok("the observer can deactivate an Owner", out["is_active"] is False)
run(svc.deactivate("owner-b", OBSERVER, "Leaving the business."))
msg = refused("the LAST active Owner cannot be deactivated",
              lambda: svc.deactivate("owner-a", OBSERVER, "Leaving the business."))
ok("and the refusal says why", "last active owner" in msg)
row = run(db[C.STAFF].find_one({"uid": "owner-a"}))
ok("the last Owner is still active", row["is_active"] is True)

# ══════════════════════════════════════════════════════════════════════════════
print("STAFF-002/003 — role changes")
# ══════════════════════════════════════════════════════════════════════════════
refused("an Owner cannot change their own role",
        lambda: svc.change_role("owner-a", Role.OPS_ADMIN, OWNER_A, "Stepping down."))
run(seed_staff("owner-d", Role.OWNER))
refused("an Owner cannot demote another Owner",
        lambda: svc.change_role("owner-d", Role.OPS_ADMIN, OWNER_A, "Demote."))
refused("an Owner cannot promote anyone to Owner",
        lambda: svc.change_role("ops-member", Role.OWNER, OWNER_A, "Promote."))
refused("an Owner cannot make anyone the observer",
        lambda: svc.change_role("ops-member", Role.OBSERVER, OWNER_A, "Watch."))
refused("an Owner cannot touch the observer's role",
        lambda: svc.change_role("observer:314zipper@gmail.com", Role.OPS_ADMIN, OWNER_A, "x x x"))
refused("a staff member cannot be given the agency role",
        lambda: svc.change_role("ops-member", Role.AGENCY, OWNER_A, "Run an agency."))
refused("…nor the seller role",
        lambda: svc.change_role("ops-member", Role.SELLER, OWNER_A, "Sell coins."))
refused("a department admin cannot change roles at all",
        lambda: svc.change_role("ops-member", Role.OPS_ADMIN, {"uid": "ops-admin", "role": Role.OPS_ADMIN}, "x x x"))
changed = run(svc.change_role("ops-member", Role.OPS_ADMIN, OWNER_A, "Promoted to run ops."))
ok("an Owner CAN move a member between department roles", changed["role"] == str(Role.OPS_ADMIN))

# ══════════════════════════════════════════════════════════════════════════════
print("SECURITY-004 / ROLE-001 — a partner cannot be made staff")
# ══════════════════════════════════════════════════════════════════════════════
existing_by_email["partner@example.test"] = AuthUser("partner-uid", providers=["phone"])
run(db[C.PARTNERS].insert_one({"_id": "AG1", "kind": "agency", "status": "approved",
                               "owner_crm_uid": "partner-uid"}))
msg = refused("inviting an agency owner as staff is refused",
              lambda: svc.invite(Invitation(email="partner@example.test", name="P", role=Role.OPS_MEMBER), OWNER_A))
ok("and names the partner role", "agency" in msg)
ok("no staff row was written", run(db[C.STAFF].find_one({"uid": "partner-uid"})) is None)

existing_by_email["host@example.test"] = AuthUser("host-uid", providers=["phone"])
store.collection("users").document("host-uid").set({"isHost": True})
refused("inviting a host as staff is refused",
        lambda: svc.invite(Invitation(email="host@example.test", name="H", role=Role.OPS_MEMBER), OWNER_A))

# ══════════════════════════════════════════════════════════════════════════════
print("AUTH-002 — guests hold no partner or host role")
# ══════════════════════════════════════════════════════════════════════════════
auth_records["anon"] = AuthUser("anon")
auth_records["typed-only"] = AuthUser("typed-only", email="t@example.test", email_verified=False)
auth_records["phone-ok"] = AuthUser("phone-ok", phone="+919800000001", providers=["phone"])
auth_records["email-ok"] = AuthUser("email-ok", email="e@example.test", email_verified=True)
ok("an anonymous account is a guest", pa.is_unverified_guest("anon"))
ok("an unverified email does not make a person", pa.is_unverified_guest("typed-only"))
ok("a missing auth record fails closed (guest)", pa.is_unverified_guest("nobody"))
ok("a verified phone is a person", not pa.is_unverified_guest("phone-ok"))
ok("a verified email is a person", not pa.is_unverified_guest("email-ok"))

table = pa.eligible_kinds({"guest": True, "partners": [], "host": None})
ok("a guest is offered nothing", table["options"] == [])
ok("for every kind, with the guest sentence",
   all(table["blocked"].get(k) == pa.GUEST_REFUSAL for k in pa.KINDS))
table = pa.eligible_kinds({"guest": False, "partners": [], "host": None})
ok("a verified person with nothing held is offered everything", set(table["options"]) == set(pa.KINDS))


async def _held_guest(uid):
    return {"uid": uid, "internal": "", "guest": True, "partners": [], "host": None,
            "pending_host_application": None}

_orig_held = pa.held_roles
pa.held_roles = _held_guest
try:
    run(pa.recheck_at_decision("anon", "agency"))
    ok("approval of a guest's application is refused at decision time", False)
except pa.ApplicationError as exc:
    ok("approval of a guest's application is refused at decision time", "Guest" in str(exc))
pa.held_roles = _orig_held

# ── Routes ───────────────────────────────────────────────────────────────────
src = (ROOT / "app" / "routers" / "staff.py").read_text()
i = src.index('@router.post("/owners/{uid}/deactivate")')
sig = src[i: src.index('"""', i)]
ok("there is an observer-only owner removal route", "require_owner_provisioner" in sig)

if failures:
    print(f"\n{len(failures)} of {checks} Phase 1A identity checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} Phase 1A identity checks passed.")
sys.exit(0)
