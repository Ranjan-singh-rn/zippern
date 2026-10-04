"""WORKSTREAM 0, PHASE A — the authentication controls, as properties.

Each section names the hole it closes and what somebody could do through it.
Where a control lives in `firestore.rules` or in a Cloud Function it is asserted
against the source text, and that is said plainly rather than dressed up as an
executed test: there is no Firestore emulator in this environment.

Run:  python3 -m tests.test_auth_hardening
"""

from __future__ import annotations

import asyncio
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
RULES = (REPO / "firestore.rules").read_text(encoding="utf-8")
IDENTITY_TS = (REPO / "functions" / "src" / "identity.ts").read_text(encoding="utf-8")
MOBILE_TS = (REPO / "functions" / "src" / "mobileSession.ts").read_text(encoding="utf-8")
ACCOUNTS_TS = (REPO / "functions" / "src" / "accounts.ts").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.config import (  # noqa: E402
    MIN_SECRET_CHARS,
    InsecureConfiguration,
    Settings,
    assert_secure_configuration,
    secret_problems,
)
from app.core import account_state as A  # noqa: E402

failures: list[str] = []
checks = 0


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


# ══════════════════════════════════════════════════════════════════════════════
#  A1 — a deployment cannot run on a secret that is in this repository
# ══════════════════════════════════════════════════════════════════════════════
#
# `jwt_secret` has a source default of "change-me". It signs every session token
# the API issues. A production deployment that forgot the variable would mint
# tokens anyone holding this repository could forge, with no symptom at all.

print("── A1: the startup secret gate ──────────────────────────────────────────")


def prod(**over) -> Settings:
    return Settings(environment="production", **over)


ok("a development default is allowed to run", secret_problems(Settings()) == [])
ok(
    "…and so is any development value, however weak",
    secret_problems(Settings(jwt_secret="x")) == [],
)

ok("production refuses the source placeholder", len(secret_problems(prod())) == 1)
ok(
    "production refuses an empty secret",
    len(secret_problems(prod(jwt_secret=""))) == 1,
)
for placeholder in ("change-me", "CHANGE-ME", "changeme", "secret", "test"):
    ok(
        f"production refuses {placeholder!r}",
        len(secret_problems(prod(jwt_secret=placeholder))) == 1,
    )

ok(
    "production refuses a secret that is merely short",
    len(secret_problems(prod(jwt_secret="a" * (MIN_SECRET_CHARS - 1)))) == 1,
)
ok(
    "…and accepts one at the floor",
    secret_problems(prod(jwt_secret="a" * MIN_SECRET_CHARS)) == [],
)

ok(
    "the refusal names the variable, so the fix is obvious",
    "JWT_SECRET" in secret_problems(prod())[0],
)
ok(
    "…and never prints the value it rejected",
    "change-me" not in secret_problems(prod())[0],
)

raised = False
try:
    assert_secure_configuration(prod())
except InsecureConfiguration:
    raised = True
ok("assert_secure_configuration raises on a bad production config", raised)

main_src = (ROOT / "app" / "main.py").read_text()
ok(
    "and the application calls it in its lifespan, before serving anything",
    "assert_secure_configuration(settings)" in main_src,
)


# ══════════════════════════════════════════════════════════════════════════════
#  A2 — account state is checked on EVERY authenticated request
# ══════════════════════════════════════════════════════════════════════════════
#
# It used to be checked on 22 permission-gated routes and nowhere else, and for a
# partner on no route at all. A deactivated staff member holding a live token
# reached every other route; a suspended partner reached everything.

print("\n── A2: account state, on every request ──────────────────────────────────")

ok("a live staff row may act", A.staff_refusal({"is_active": True}) is None)
ok(
    "…and a row with no is_active field is treated as active",
    A.staff_refusal({}) is None,
)
ok("a deactivated staff row is refused", A.staff_refusal({"is_active": False}) is not None)
check(
    "…with a reason a log can be filtered on",
    A.staff_refusal({"is_active": False}).reason,
    "staff_deactivated",
)
ok("a MISSING staff row is refused, not allowed", A.staff_refusal(None) is not None)
check(
    "…and is distinguishable from a deactivated one",
    A.staff_refusal(None).reason,
    "staff_record_missing",
)

ok(
    "an approved, active partner may act",
    A.partner_refusal({"status": "approved", "is_active": True}) is None,
)
for status, reason in [
    ("pending", "partner_pending"),
    ("rejected", "partner_rejected"),
    ("suspended", "partner_suspended"),
]:
    refusal = A.partner_refusal({"status": status, "is_active": True})
    ok(f"a {status} partner is refused", refusal is not None)
    check(f"…for the right reason", refusal.reason, reason)

ok(
    "an approved but DEACTIVATED partner is refused",
    A.partner_refusal({"status": "approved", "is_active": False}) is not None,
)
ok("a missing partner record is refused", A.partner_refusal(None) is not None)

# The one that matters most: an unrecognised status must not fall through every
# branch and land on allow. A hand edit or a half-finished migration is exactly
# how a value nobody wrote on purpose gets into that field.
unknown = A.partner_refusal({"status": "under_review", "is_active": True})
ok("an UNRECOGNISED status fails closed", unknown is not None)
check("…and says so", unknown.reason, "partner_status_unknown")
ok(
    "…including an empty one",
    A.partner_refusal({"status": "", "is_active": True}) is not None,
)

# Staleness. A cached answer we cannot date is not an answer.
now = datetime.now(timezone.utc)
ok("a missing stamp is due", A.is_due(None, now=now, interval=60))
ok("a non-datetime stamp is due", A.is_due("yesterday", now=now, interval=60))
ok("a fresh stamp is not due", not A.is_due(now - timedelta(seconds=5), now=now, interval=60))
ok("an old stamp is due", A.is_due(now - timedelta(seconds=61), now=now, interval=60))
ok(
    "an interval of 0 means check every time",
    A.is_due(now, now=now, interval=0),
)
ok(
    "a naive stamp is read as UTC rather than crashing",
    not A.is_due(now.replace(tzinfo=None), now=now, interval=60),
)

deps_src = (ROOT / "app" / "core" / "deps.py").read_text()
ok(
    "current_user consults it, so every authenticated route is covered",
    "await assert_may_act(user)" in deps_src,
)
ok(
    "…and answers 403, not 401, so the CRM does not loop on renewal",
    "HTTP_403_FORBIDDEN, detail=exc.message" in deps_src,
)


# ══════════════════════════════════════════════════════════════════════════════
#  A3 — one active mobile session, enforced by the server
# ══════════════════════════════════════════════════════════════════════════════
#
# The session id was written by the server and compared only by the client. A
# patched app that ignored its own listener kept full access on the displaced
# handset.

print("\n── A3: the mobile session is a control now ──────────────────────────────")

# The verdict function itself is TypeScript and is exercised where it lives, in
# `functions/test/mobileSession.test.js`. What is asserted here is that the
# module exists, exports the pieces the guard needs, and is wired in — a Python
# re-implementation of the same decision would be a second opinion that could
# drift from the one that actually runs.
for symbol in (
    "export function sessionVerdict",
    "export async function assertActiveSession",
    "export function presentedSessionId",
    "export function enforcingPresentedSession",
):
    ok(f"mobileSession exports {symbol.split()[-1]}", symbol in MOBILE_TS)

ok(
    "tolerance is opt-OUT, so turning enforcement on is a deliberate act",
    "ENFORCE_MOBILE_SESSION" in MOBILE_TS,
)

# The guard is applied to the callables that move value.
for module, fn in [
    ("gifts.ts", "settleGift"),
    ("calls.ts", "startCall"),
    ("wallet.ts", "convertBeans"),
    ("wallet.ts", "purchaseBagItem"),
]:
    src = (REPO / "functions" / "src" / module).read_text()
    ok(
        f"{fn} verifies the mobile session",
        f"assertActiveSession" in src and f"'{fn}'" in src,
    )

ok(
    # Stripped of comments, because the module's own note explains WHY it does
    # not say "session expired" — and that explanation contains the phrase.
    "the displacement message is not the words 'session expired'",
    "signed in on another device" in MOBILE_TS
    and "session expired" not in strip_comments(MOBILE_TS).lower(),
)
ok(
    "the client gets a code to branch on, not just a sentence",
    "SESSION_DISPLACED" in MOBILE_TS,
)
ok(
    "a session id is never written to a log",
    "presentedLen" in MOBILE_TS and "presented," not in strip_comments(MOBILE_TS).split("logger.warn")[1][:400],
)

# The replacement is atomic, and it stamps the cut-off the rules compare against.
ok(
    "startMobileSession replaces the session inside a transaction",
    "runTransaction" in IDENTITY_TS and "credentialsValidAfter" in IDENTITY_TS,
)
ok(
    "…and the cut-off is a NUMBER, because auth_time in a rule is an integer",
    "Math.floor(now.toMillis() / 1000)" in IDENTITY_TS,
)

rules = strip_comments(RULES)
ok(
    "the rules compare auth_time against the cut-off",
    "request.auth.token.auth_time" in rules and "credentialsValidAfter" in rules,
)
ok(
    "…and an account with no cut-off is unaffected, which is the migration",
    "get('credentialsValidAfter', 0)" in rules,
)
ok(
    "the ordinary app write gate includes it",
    "isAppUser() && notBanned() && sessionCurrent()" in rules,
)

# And the field is not writable by the account it governs — otherwise the whole
# control is handed to the one party it is aimed at.
owner_denylist = rules[rules.index("function ownerProtectedFields"):]
owner_denylist = owner_denylist[: owner_denylist.index("}")]
ok(
    "credentialsValidAfter is protected from the owner of the document",
    "'credentialsValidAfter'" in owner_denylist,
)
ok(
    "…and from staff",
    "'credentialsValidAfter'" in rules[rules.index("function staffProtectedFields"):][:4000],
)


# ══════════════════════════════════════════════════════════════════════════════
#  A4 / A5 — a ban withdraws the credential, not just the permission
# ══════════════════════════════════════════════════════════════════════════════

print("\n── A4/A5: ban kills the credential ──────────────────────────────────────")

users_src = (ROOT / "app" / "services" / "users.py").read_text()
ban_body = users_src[users_src.index("async def ban_user") : users_src.index("async def unban_user")]
unban_body = users_src[users_src.index("async def unban_user") :][:6000]

ok(
    "ban_user disables the Firebase account and revokes its refresh tokens",
    "set_user_disabled, uid, True" in ban_body,
)
ok(
    "…and records a searchable act when that fails",
    "USER_FIREBASE_REVOKE_FAILED" in ban_body,
)
ok(
    "unban re-enables it, so an unbanned person can actually sign in",
    "set_user_disabled, uid, False" in unban_body,
)

firebase_src = (ROOT / "app" / "db" / "firebase.py").read_text()
ok(
    "revoking is still tied to disabling, not to re-enabling",
    "if disabled:" in firebase_src and "revoke_refresh_tokens" in firebase_src,
)

ok(
    "Quick Login is revoked by the existing trigger on the ban transition",
    "revokeQuickLoginOnRestriction" in IDENTITY_TS,
)

# Normal logout must NOT do any of this — that is what keeps Quick Login useful.
ok(
    "normal logout does not revoke Firebase credentials",
    "set_user_disabled" not in (ROOT / "app" / "routers" / "auth.py").read_text(),
)


# ══════════════════════════════════════════════════════════════════════════════
#  A6 — the observer must have an active record
# ══════════════════════════════════════════════════════════════════════════════
#
# A session used to be issued even when the row was ABSENT (on a synthetic uid)
# and was never checked for is_active. The one account that reads the whole
# business could be signed in after it had been switched off.

print("\n── A6: the observer ─────────────────────────────────────────────────────")

sec_src = (ROOT / "app" / "core" / "security.py").read_text()
verify = sec_src[sec_src.index("async def verify_observer_code") :][:6000]

ok("a missing observer record is refused", 'if observer is None' in verify)
ok("a deactivated observer record is refused", 'observer.get("is_active", True)' in verify)
ok(
    "the synthetic-uid fallback is gone",
    'f"observer:{email}"' not in verify,
)
ok(
    "a record with no uid is refused rather than issued an empty session",
    'if not uid' in verify,
)
ok(
    "both refusals read the same to an unauthenticated caller",
    verify.count('AuthError("This account cannot sign in.")') >= 3,
)


# ══════════════════════════════════════════════════════════════════════════════
#  A7 — a capability change invalidates the session carrying the old one
# ══════════════════════════════════════════════════════════════════════════════

print("\n── A7: capability changes, and the audit ───────────────────────────────")

po_src = (ROOT / "app" / "services" / "partner_ops.py").read_text()
approve = po_src[po_src.index("async def approve_partner") :][:9000]
ok(
    "approving a partner revokes the session that predates the capability",
    "_revoke_partner_sessions" in approve,
)
check(
    "rejection and deactivation still do too — three doors, three revokes",
    po_src.count("await _revoke_partner_sessions("),
    3,
)

audit_src = (ROOT / "app" / "core" / "audit.py").read_text()
for action in ("SESSION_ENDED", "SESSION_DISPLACED", "USER_FIREBASE_REVOKE_FAILED"):
    ok(f"{action} exists in the one audit registry", action in audit_src)

auth_src = (ROOT / "app" / "routers" / "auth.py").read_text()
ok("signing out is recorded, which it never was", "SESSION_ENDED" in auth_src)
ok(
    "…and the entry carries a fingerprint, never the session token",
    'jti[:8]' in auth_src,
)


# ══════════════════════════════════════════════════════════════════════════════
#  A8 — the recovery window
# ══════════════════════════════════════════════════════════════════════════════

print("\n── A8: sixty days ───────────────────────────────────────────────────────")

ok(
    "the grace period is sixty days",
    "ACCOUNT_RECOVERY_DAYS ?? 60) || 60" in ACCOUNTS_TS,
)
ok(
    "…and is still an environment variable, not a constant",
    "process.env.ACCOUNT_RECOVERY_DAYS" in ACCOUNTS_TS,
)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} Phase A authentication checks passed.")
print("  · a production deployment cannot run on a secret that is in this repo")
print("  · account state is checked on every authenticated request, staff AND partner")
print("  · an unrecognised partner status fails closed")
print("  · the mobile session is verified by the server, not by the client")
print("  · a displaced device is refused by the rules on auth_time, and absent means allowed")
print("  · a ban withdraws the Firebase credential; an unban gives it back")
print("  · the observer cannot sign in without an active record")
print("  · approving a capability revokes the session that predates it")
print("  · signing out is recorded")
print()
print("  firestore.rules and the Cloud Functions are asserted against their SOURCE.")
print("  There is no emulator here, and these are not rules-unit tests.")
sys.exit(0)
