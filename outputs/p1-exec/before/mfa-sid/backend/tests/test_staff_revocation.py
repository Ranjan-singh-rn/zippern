"""Revoking staff access, and inviting without hijacking an existing account.

P1 (approved decision 1): the old FIX 3 below — disabling the Firebase account on
revocation — is REVERSED, because that account is the person's own Zipper app
account. The "used to mean" note is kept as history.

Two fixes, both in `app/services/staff.py`, and they share a harness because they
share the one idea: **the Firebase credential is not ours to assume about.**

── WHAT REVOCATION USED TO MEAN ──────────────────────────────────────────────

`deactivate()` flipped `staff.is_active` in Mongo and `isActive` on the CRM
document, and stopped. The Firebase account was untouched, so a revoked person
kept a working login indefinitely — they could still authenticate, still mint
fresh ID tokens, still receive a password reset — and were held out only by two
reads our own code performs. If either write failed, and the CRM mirror is
best-effort with a repair script named in its error, the shell opened for them
until somebody ran it.

── WHAT AN INVITATION USED TO DO TO AN EXISTING ACCOUNT ──────────────────────

`invite()` reuses the Firebase account when the address already has one, which
is right: one person is meant to hold one uid carrying their password, their
Google identity and their phone. What it also did was mail them a
password-reset link — a live credential for an account they are already using,
worded as though the account were new. Most invitees are already Zipper app
users, so this was the common case, not the edge one.

Run:  python3 -m tests.test_staff_revocation
"""

from __future__ import annotations

import asyncio
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import (  # noqa: E402
    AUTH_CALLS,
    FakeDb,
    FakeFirestore,
    install_module_stubs,
    reset_auth_calls,
)

install_module_stubs()

# `invite` imports the email service lazily, so a stub has to be in place before
# the call rather than before the import.
sent_mail: list[dict] = []
email_stub = types.ModuleType("app.services.email")
email_stub.send_staff_invitation = lambda **kw: sent_mail.append({"kind": "invitation", **kw})
email_stub.send_staff_access_added = lambda **kw: sent_mail.append({"kind": "access_added", **kw})


# P1-F — the access-change notices go through `email.deliver` with a dedupe key.
async def _stub_deliver(**kw):
    sent_mail.append({"kind": kw.get("kind"), "dedupe_key": kw.get("dedupe_key"), "html": kw.get("html", "")})
    return {"outcome": "sent"}


email_stub.deliver = _stub_deliver
email_stub.Recipient = lambda **kw: types.SimpleNamespace(**kw)
email_stub.Sensitivity = types.SimpleNamespace(OPERATIONAL="operational")
email_stub.page = lambda **kw: kw.get("body", "")
email_stub.esc = lambda v: str(v)
sys.modules["app.services.email"] = email_stub

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import staff as svc  # noqa: E402
from app.services.staff import Invitation  # noqa: E402

db = FakeDb()
crm_users = FakeFirestore()
crm.firebase.firestore_client = lambda: crm_users
fb.firestore_client = lambda: crm_users
svc.get_db = lambda: db

audit_entries: list[dict] = []


async def fake_audit_record(**kwargs):
    audit_entries.append(kwargs)
    return "audit-id"


audit_mod.record = fake_audit_record


class AuthUser:
    """Enough of a Firebase user record for the two questions `invite` asks."""

    def __init__(self, uid: str, *, providers: list[str] | None = None, verified: bool = False):
        self.uid = uid
        self.email_verified = verified
        self.provider_data = [types.SimpleNamespace(provider_id=p) for p in (providers or [])]


auth_accounts: dict[str, AuthUser] = {}
_next_uid = [0]


def fake_create_user(*, email, display_name="", password="", email_verified=False):
    _next_uid[0] += 1
    user = AuthUser(f"fb-uid-{_next_uid[0]}", providers=["password"], verified=email_verified)
    auth_accounts[email.lower()] = user
    return user


reset_links: list[str] = []


def fake_reset_link(email: str) -> str:
    reset_links.append(email)
    return f"https://reset/{email}"


svc.fb_auth.create_user = fake_create_user
svc.fb_auth.generate_password_reset_link = fake_reset_link
fb.get_user_by_email = lambda email: auth_accounts.get(email.lower())
fb.get_user = lambda uid: next((u for u in auth_accounts.values() if u.uid == uid), None)

OWNER = {"uid": "owner-1", "name": "Tanishque", "role": Role.OWNER, "team": None}


def peek(path: str) -> dict:
    """One fake-Firestore document as a dict ({} when absent)."""
    col, doc_id = path.split("/", 1)
    snap = crm_users.collection(col).document(doc_id).get()
    return (snap.to_dict() if getattr(snap, "exists", False) else None) or {}

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


def invite(email: str, name: str = "Dev", role: Role = Role.OPS_MEMBER) -> dict:
    return run(
        svc.invite(
            Invitation(email=email, name=name, phone="", role=role, field_charge=""),
            OWNER,
        )
    )


# ══════════════════════════════════════════════════════════════════════════════
#  P1-B1 — revocation ends STAFF access and leaves the personal app account alone
# ══════════════════════════════════════════════════════════════════════════════
#
# Approved decision 1 reverses the old FIX 3. `invite` reuses the person's own
# Zipper account ("one person, one uid"), so disabling that Firebase account
# locked them out of their app — wallet, beans, host earnings. Staff access is
# now revoked by everything that carries it (API sessions, the Mongo row the
# guards read, `crmUsers.isActive` the Firestore rules read, the Storage claim)
# and the Firebase account is not touched at all.

reset_auth_calls()
sent_mail.clear()
created = invite("revoke-me@example.com", "Revoke Me")
target_uid = created["uid"]
run(db[C.SESSIONS].insert_one({"jti": "j-revoke-1", "uid": target_uid, "revoked": False}))

reset_auth_calls()
sent_mail.clear()
result = run(svc.deactivate(target_uid, OWNER, "Left the company"))

ok("the personal Firebase account is NOT disabled", AUTH_CALLS["disabled"] == [])
ok("and its refresh tokens are NOT revoked (the app stays signed in)", AUTH_CALLS["revoked"] == [])
check("the caller is told the personal account is unchanged", result["personal_app_account"], "unchanged")
check("the staff record is inactive", result["is_active"], False)
check("…with an explicit status", result["status"], "deactivated")
row = run(db[C.STAFF].find_one({"uid": target_uid}))
check("the stored row says deactivated", (row["status"], row["is_active"]), ("deactivated", False))
sess = run(db[C.SESSIONS].find_one({"jti": "j-revoke-1"}))
check("the API session is revoked", sess["revoked"], True)
check("the CRM directory entry is switched off (Firestore grants end)",
      peek(f"crmUsers/{target_uid}").get("isActive"), False)
ok("the change is audited as staff.deactivated",
   any(e.get("action") == audit_mod.Action.STAFF_DEACTIVATED and e.get("subject_id") == target_uid for e in audit_entries))
ok("the person is emailed after the change, keyed on the event",
   any(m.get("kind") == "staff.deactivated" and m.get("dedupe_key") for m in sent_mail))
ok("…and given an in-app notice", peek("notifications/staff_deactivated_audit-id").get("userId") == target_uid)
ok("the notice carries no reason text", "Left the company" not in str(peek("notifications/staff_deactivated_audit-id")))

# Not idempotent by silence: a second deactivation is refused with a sentence.
try:
    run(svc.deactivate(target_uid, OWNER, "Left the company"))
    failures.append("deactivating an already-deactivated account should be refused")
except svc.StaffError as exc:
    ok("a second deactivation is refused and says why", "already deactivated" in str(exc))
checks += 1

# ── An inactive row cannot mint a staff session, even with an enabled login ───
from app.core import account_state  # noqa: E402

refusal = account_state.staff_refusal(row)
ok("an enabled personal login with a deactivated staff row is refused", refusal is not None)


# ══════════════════════════════════════════════════════════════════════════════
#  P1-B2 — reactivation: authorised, reasoned, audited; old sessions stay dead
# ══════════════════════════════════════════════════════════════════════════════

sent_mail.clear()
back = run(svc.reactivate(target_uid, OWNER, "Rehired after review"))
check("reactivated", (back["status"], back["is_active"]), ("active", True))
check("the CRM directory entry is switched back on",
      peek(f"crmUsers/{target_uid}").get("isActive"), True)
check("the old session stays revoked — the person signs in again",
      run(db[C.SESSIONS].find_one({"jti": "j-revoke-1"}))["revoked"], True)
ok("audited as staff.reactivated",
   any(e.get("action") == audit_mod.Action.STAFF_REACTIVATED for e in audit_entries))
ok("the person is told", any(m.get("kind") == "staff.active" for m in sent_mail))
ok("the personal login is still untouched", AUTH_CALLS["disabled"] == [])

for label, fn, actor in (
    ("a reason is required", lambda: svc.reactivate(target_uid, OWNER, "   "), OWNER),
    ("nobody reactivates themselves", lambda: svc.suspend("owner-1", OWNER, "x" * 5), OWNER),
):
    try:
        run(fn())
        failures.append(f"{label}: was allowed")
    except svc.StaffError:
        pass
    checks += 1

# A department admin reaches only their own department's MEMBERS.
OPS_ADMIN = {"uid": "ops-admin-1", "name": "Ops Admin", "role": Role.OPS_ADMIN, "team": "ops"}
member = invite("member@example.com", "Member", Role.OPS_MEMBER)
finance = invite("fin@example.com", "Fin", Role.FINANCE_MEMBER)
run(svc.suspend(member["uid"], OPS_ADMIN, "On leave this month"))
check("an ops admin suspends an ops member", run(db[C.STAFF].find_one({"uid": member["uid"]}))["status"], "suspended")
check("suspension refuses the account at the session guard",
      account_state.staff_refusal(run(db[C.STAFF].find_one({"uid": member["uid"]}))).reason, "staff_suspended")
run(svc.reactivate(member["uid"], OPS_ADMIN, "Back from leave"))
check("…and reactivates them", run(db[C.STAFF].find_one({"uid": member["uid"]}))["status"], "active")
try:
    run(svc.suspend(finance["uid"], OPS_ADMIN, "Not my department"))
    failures.append("an ops admin suspended a finance member")
except svc.StaffError as exc:
    ok("an ops admin cannot suspend another department", "own department" in str(exc))
checks += 1

# Owners: the observer only, and never the last active one.
OBSERVER = {"uid": "observer:x", "name": "Observer", "role": Role.OBSERVER, "team": None}
crm_users.collection("crmUsers").document("owner-x").set({"uid": "owner-x", "role": "superadmin", "isActive": True})
run(db[C.STAFF].insert_one({"uid": "owner-x", "email": "ox@example.com", "name": "Owner X",
                            "role": "owner", "team": None, "is_active": True}))
for label, fn in (
    ("an owner cannot suspend another owner", lambda: svc.suspend("owner-x", OWNER, "Disagreement")),
    ("the observer cannot suspend the LAST active owner", lambda: svc.suspend("owner-x", OBSERVER, "Testing")),
):
    try:
        run(fn())
        failures.append(f"{label}: was allowed")
    except svc.StaffError:
        pass
    checks += 1
crm_users.collection("crmUsers").document("owner-y").set({"uid": "owner-y", "role": "superadmin", "isActive": True})
run(db[C.STAFF].insert_one({"uid": "owner-y", "email": "oy@example.com", "name": "Owner Y",
                            "role": "owner", "team": None, "is_active": True}))
# P1-A3b: an Owner's Firestore/Storage MFA bindings must not survive suspension
# or deactivation, and reactivation must not bring them back.
from datetime import timedelta as _td  # noqa: E402


def _seed_binding(uid: str) -> None:
    exp = datetime.now(timezone.utc) + _td(days=1)
    crm_users.collection("ownerMfaSessions").document(uid).set({
        "uid": uid, "bindings": {"b1": {"authTime": 1, "provider": "password", "client": "crm",
                                        "apiJti": "j", "expiresAt": exp, "createdAt": exp}},
        "active": {"1:password": exp}})


def _has_binding(uid: str) -> bool:
    return crm_users.collection("ownerMfaSessions").document(uid).get().exists


_seed_binding("owner-x")
run(svc.suspend("owner-x", OBSERVER, "Investigation"))
check("with two owners, the observer suspends one", run(db[C.STAFF].find_one({"uid": "owner-x"}))["status"], "suspended")
check("P1-A3b: suspending an Owner removes its MFA bindings", _has_binding("owner-x"), False)
run(svc.reactivate("owner-x", OBSERVER, "Cleared"))
check("…and restores them", run(db[C.STAFF].find_one({"uid": "owner-x"}))["status"], "active")
check("P1-A3b: reactivation does NOT restore MFA bindings", _has_binding("owner-x"), False)
_seed_binding("owner-x")
run(svc.deactivate("owner-x", OBSERVER, "Left the business"))
check("P1-A3b: deactivating an Owner removes its MFA bindings", _has_binding("owner-x"), False)
run(svc.reactivate("owner-x", OBSERVER, "Returned"))
_seed_binding("owner-y")
run(svc.suspend(member["uid"], OPS_ADMIN, "Second leave"))
check("P1-A3b: suspending a non-owner leaves Owner bindings alone", _has_binding("owner-y"), True)
run(svc.reactivate(member["uid"], OPS_ADMIN, "Back"))
try:
    run(svc.reactivate(OBSERVER["uid"], OWNER, "No"))
    failures.append("someone reactivated the observer")
except svc.StaffError:
    pass
checks += 1


# ══════════════════════════════════════════════════════════════════════════════
#  FIX 4 — inviting onto an account that already exists
# ══════════════════════════════════════════════════════════════════════════════

# ── A brand-new address gets the invitation, with the set-password link ───────
sent_mail.clear()
reset_links.clear()
fresh = invite("brand-new@example.com", "Brand New")

check("a new invitee is emailed exactly once", len(sent_mail), 1)
check("and it is the invitation", sent_mail[0]["kind"], "invitation")
ok("carrying a set-password link", sent_mail[0]["set_password_link"].startswith("https://reset/"))
check("the account was not treated as pre-existing", fresh["reused_existing_account"], False)
ok("and the response says what was sent", "invitation sent" in fresh["notification"])

# The address is NOT marked verified at creation. Nothing has proved the person
# reads this mailbox — it was typed by whoever invited them — and the emailed
# link is what proves it, because the password it replaces is 32 random bytes
# nobody was ever told.
check("a new staff account starts unverified", fresh["email_already_verified"], False)

# ── An address that already has a Zipper account is NOT sent a reset link ─────
#
# This is the hijack. The invitee is an ordinary app user with a Google sign-in;
# mailing them a password-reset link for it, worded as a new-account invitation,
# is a working credential for an account they use every day.
auth_accounts["app-user@example.com"] = AuthUser(
    "fb-uid-existing", providers=["google.com"], verified=True
)
sent_mail.clear()
reset_links.clear()

reused = invite("app-user@example.com", "App User")

check("no password-reset link is generated at all", len(reset_links), 0)
check("exactly one email is sent", len(sent_mail), 1)
check("and it is the access-added one, not the invitation", sent_mail[0]["kind"], "access_added")
ok("which carries no link of any kind",
   "set_password_link" not in sent_mail[0])
check("the existing account is reused, not duplicated", reused["uid"], "fb-uid-existing")
check("and the response says so", reused["reused_existing_account"], True)
ok("in words the inviter can act on",
   "already had a Zipper account" in reused["notification"])

# One uid, not two. The canonical-identity rule — one person, one Firebase
# account carrying password, Google and phone — is the reason reuse is right;
# doing it silently is the only part that was wrong.
check("no second Firebase account was created for that address",
      len([u for u in auth_accounts.values() if u.uid == "fb-uid-existing"]), 1)

# ── An existing account with NO way to sign in still gets the link ────────────
#
# An auth record with no provider at all is unreachable by anybody, so the
# set-password link is an invitation rather than a hijack.
auth_accounts["shell@example.com"] = AuthUser("fb-uid-shell", providers=[], verified=False)
sent_mail.clear()
reset_links.clear()

shell = invite("shell@example.com", "Shell")
check("an unreachable account is sent the set-password link", len(reset_links), 1)
check("as a normal invitation", sent_mail[0]["kind"], "invitation")
check("reusing its uid", shell["uid"], "fb-uid-shell")

# ── A send that cannot happen is never reported as sent ───────────────────────
#
# The screen used to say "Invitation sent to {email}" unconditionally, while the
# send was skipped whenever the link could not be generated. An account could
# exist in both stores, be audited as created, be announced as invited, and
# nobody had been written to.
svc.fb_auth.generate_password_reset_link = lambda email: (_ for _ in ()).throw(
    RuntimeError("link service down")
)
sent_mail.clear()

silent = invite("nolink@example.com", "No Link")
check("nothing was sent", len(sent_mail), 0)
ok("and the response says so in capitals", "NOTHING WAS SENT" in silent["notification"])
ok("naming the cause", "link service down" in silent["notification"])
ok("and telling the operator what to do instead",
   "Forgot password" in silent["notification"])

svc.fb_auth.generate_password_reset_link = fake_reset_link

# ── A duplicate invitation is still refused ───────────────────────────────────
try:
    invite("brand-new@example.com", "Brand New Again")
    checks += 1
    failures.append("a duplicate staff email was accepted")
except svc.StaffError as exc:
    checks += 1
    ok("a second invitation to the same address is refused", "already" in str(exc).lower())


# ── Result ────────────────────────────────────────────────────────────────────


# ══════════════════════════════════════════════════════════════════════════════
#  P1-B4 — a conflicting partner record refuses the invitation, every held status
# ══════════════════════════════════════════════════════════════════════════════
for n, status in enumerate(("pending", "awaiting_verification", "approved", "suspended", "revoked")):
    email = f"partner{n}@example.com"
    acct = fake_create_user(email=email)
    run(db[C.PARTNERS].insert_one({"_id": f"P-{n}", "kind": "agency", "status": status, "owner_crm_uid": acct.uid}))
    try:
        invite(email, f"Partner {n}", Role.OPS_MEMBER)
        failures.append(f"a {status} partner record did not block the invitation")
    except svc.StaffError as exc:
        ok(f"a {status} partner record blocks the invitation and names it", status in str(exc))
        ok(f"…and nothing was created for the {status} case", run(db[C.STAFF].find_one({"email": email})) is None)
    check(f"the {status} partner record is untouched", run(db[C.PARTNERS].find_one({"_id": f"P-{n}"}))["status"], status)
    checks += 1
# A REJECTED application holds nothing: hiring that person is allowed.
acct = fake_create_user(email="rejected@example.com")
run(db[C.PARTNERS].insert_one({"_id": "P-rej", "kind": "seller", "status": "rejected", "owner_crm_uid": acct.uid}))
hired = invite("rejected@example.com", "Rejected Applicant", Role.OPS_MEMBER)
check("a rejected partner record does not block hiring", hired["status"], "active")

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} staff-revocation and invite-safety checks passed.")
print("  · revocation ends staff access and leaves the personal app account untouched (P1-B1)")
print("  · suspension and reactivation follow the hierarchy, need a reason, and are audited (P1-B2/B3)")
print("  · old sessions stay revoked after reactivation; the person is notified (P1-F)")
print("  · an invitation onto an existing account sends no password link")
print("  · and a send that could not happen is never announced as sent")
sys.exit(0)
