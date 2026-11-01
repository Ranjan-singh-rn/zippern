"""Revoking staff access, and inviting without hijacking an existing account.

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
#  FIX 3 — revocation reaches Firebase
# ══════════════════════════════════════════════════════════════════════════════

reset_auth_calls()
sent_mail.clear()
created = invite("revoke-me@example.com", "Revoke Me")
target_uid = created["uid"]

reset_auth_calls()
result = run(svc.deactivate(target_uid, OWNER, "Left the company"))

ok("the account is disabled in Firebase", (target_uid, {"disabled": True}) in AUTH_CALLS["disabled"])
ok("and its refresh tokens are revoked", target_uid in AUTH_CALLS["revoked"])
check("the caller is told the revocation is complete", result["fully_revoked"], True)
check("and the login state is named", result["firebase_login"], "disabled")
check("the application flag is still set", result["is_active"], False)

# Both calls matter, and for different reasons: `disabled` refuses NEW sign-ins
# while `revoke_refresh_tokens` invalidates the ID token already in the browser,
# which otherwise stays acceptable for up to an hour.
ok("disabling and revoking are both done, not one or the other",
   len(AUTH_CALLS["disabled"]) == 1 and len(AUTH_CALLS["revoked"]) == 1)

# ── The uid, never the address ────────────────────────────────────────────────
#
# Two accounts can share an email across systems. Resolving the target by
# address would disable somebody nobody revoked and leave the revoked person
# signing in — the one mistake in this whole function that cannot be noticed
# from the screen that made it.
ok("the target is addressed by uid", AUTH_CALLS["disabled"][0][0] == target_uid)
ok("and the uid is not an email", "@" not in AUTH_CALLS["disabled"][0][0])

# ── Idempotence ───────────────────────────────────────────────────────────────
reset_auth_calls()
try:
    run(svc.deactivate(target_uid, OWNER, "Left the company"))
    checks += 1
except Exception as exc:  # noqa: BLE001
    checks += 1
    failures.append(f"revoking an already-revoked account raised {exc!r}")
ok("a second revocation disables again rather than failing", len(AUTH_CALLS["disabled"]) == 1)

# ── A missing Firebase account is not a failure ───────────────────────────────
#
# The observer has none by design, and a row whose account was removed by hand
# has none either. There is nothing to revoke and that is not an error.
reset_auth_calls()


class _NotFound(Exception):
    pass


svc.fb_auth.UserNotFoundError = _NotFound
fb.fb_auth.UserNotFoundError = _NotFound
original_update = fb.fb_auth.update_user
fb.fb_auth.update_user = lambda uid, **k: (_ for _ in ()).throw(_NotFound("no such user"))

ghost = invite("ghost@example.com", "Ghost")
ghost_result = run(svc.deactivate(ghost["uid"], OWNER, "Never existed in Firebase"))
check("a missing Firebase account still reports a complete revocation",
      ghost_result["fully_revoked"], True)

# ── A Firebase failure must NOT be reported as success ────────────────────────
fb.fb_auth.update_user = lambda uid, **k: (_ for _ in ()).throw(RuntimeError("quota exceeded"))
audit_entries.clear()

broken = invite("broken@example.com", "Broken")
broken_result = run(svc.deactivate(broken["uid"], OWNER, "Firebase is down"))

check("a Firebase failure is not reported as fully revoked", broken_result["fully_revoked"], False)
ok("and the reason reaches the caller", "quota exceeded" in str(broken_result["firebase_login"]))
ok("the application flags are still applied, so the most valuable half is done",
   broken_result["is_active"] is False)
ok("and the failure has its own searchable audit action",
   any(e.get("action") == audit_mod.Action.STAFF_FIREBASE_REVOKE_FAILED for e in audit_entries))

fb.fb_auth.update_user = original_update


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

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} staff-revocation and invite-safety checks passed.")
print("  · revocation disables the Firebase account AND revokes its refresh tokens")
print("  · the target is resolved by uid, never by email address")
print("  · a Firebase failure is audited and never reported as a complete revocation")
print("  · a missing Firebase account is not a failure")
print("  · an invitation onto an existing account sends no password link")
print("  · and a send that could not happen is never announced as sent")
sys.exit(0)
