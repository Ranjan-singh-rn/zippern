"""P1-A3 — Owner MFA is real, and the server enforces it.

  * TOTP matches RFC 6238's published test vector (SHA-1, 8 digits → our 6).
  * An Owner session from sign-in is `mfa=False` and is refused on every route
    except the MFA routes, `me` and sign-out; a verified session passes.
  * Non-owners are untouched by the gate.
  * Enrolment: refused when no encryption key is configured (fail closed); the
    secret is stored ENCRYPTED; a wrong first code is refused; the right one
    enrols, returns ten recovery codes and stores only their hashes.
  * Enrolment cannot be restarted once enrolled (a stolen password cannot swap
    the authenticator).
  * Verify: a right code passes; the same code again is a replay and refused;
    wrong codes lock the factor after the threshold, audited and notified.
  * Recovery codes: each works once.
  * The upgraded session carries mfa=True on claim AND record; renewal keeps it.
  * Observer reset: observer only, needs a reason, deletes the factor, revokes
    every session of the Owner, audits, notifies. An Owner cannot reset.
  * No audit entry contains the secret or a code.

Run:  python3 -m tests.test_p1_owner_mfa
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import struct
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

# The harness's `jose` returns a constant token. Sessions are the point here,
# so give it a real (minimal) HS256: signature, issuer and expiry checked.
import base64 as _b64  # noqa: E402
import json as _json  # noqa: E402

_jose = sys.modules["jose"]


def _b64e(b: bytes) -> str:
    return _b64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return _b64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _encode(claims, key, algorithm="HS256"):
    head = _b64e(_json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64e(_json.dumps(claims).encode())
    sig = _b64e(hmac.new(key.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def _decode(token, key, algorithms=None, issuer=None, options=None):
    try:
        head, body, sig = token.split(".")
    except ValueError as exc:
        raise _jose.JWTError("malformed") from exc
    good = _b64e(hmac.new(key.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(good, sig):
        raise _jose.JWTError("bad signature")
    claims = _json.loads(_b64d(body))
    if issuer and claims.get("iss") != issuer:
        raise _jose.JWTError("bad issuer")
    if (options or {}).get("verify_exp", True) and claims.get("exp", 0) < time.time():
        raise _jose.JWTError("expired")
    return claims


_jose.jwt = types.SimpleNamespace(encode=_encode, decode=_decode)

from tests.fakes import FakeDb  # noqa: E402

from cryptography.fernet import Fernet  # noqa: E402

from app.config import settings  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import owner_mfa as mfa  # noqa: E402

db = FakeDb()
mfa.get_db = lambda: db
security.get_db = lambda: db

audit_log: list[dict] = []


async def fake_record(**kw):
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record

notices_sent: list[tuple] = []
emails_sent: list[dict] = []
from app.services import notices as notices_mod  # noqa: E402


async def fake_notice(uid, key, **kw):
    notices_sent.append((uid, key, kw.get("title")))
    return True


notices_mod.deliver = fake_notice
email_mod = types.ModuleType("app.services.email")


async def fake_email(**kw):
    emails_sent.append(kw)
    return {}


email_mod.deliver = fake_email
email_mod.Recipient = lambda **kw: kw
email_mod.Sensitivity = types.SimpleNamespace(OPERATIONAL="operational")
email_mod.page = lambda **kw: "<html>"
email_mod.esc = lambda v: str(v)
sys.modules["app.services.email"] = email_mod
import app.services as _services_pkg  # noqa: E402
_services_pkg.email = email_mod

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def refused(label: str, coro, status: int | None = None) -> None:
    global checks
    checks += 1
    try:
        run(coro)
        failures.append(f"{label}: was allowed")
    except mfa.MfaError as exc:
        if status is not None and exc.status_code != status:
            failures.append(f"{label}: status {exc.status_code}, wanted {status}")


# ── RFC 6238 test vector ──────────────────────────────────────────────────────
# Secret "12345678901234567890" (ASCII), T=59 → 8-digit 94287082 → 6-digit 287082.
import base64  # noqa: E402

rfc_secret = base64.b32encode(b"12345678901234567890").decode()
ok("RFC 6238 vector at T=59", mfa.hotp(rfc_secret, 59 // 30) == "287082")
ok("RFC 6238 vector at T=1111111109", mfa.hotp(rfc_secret, 1111111109 // 30) == "081804")
ok("a code is valid for the step either side (drift)", mfa.match_step(rfc_secret, "287082", at=59 + 30) == 1)
ok("…but not two steps away", mfa.match_step(rfc_secret, "287082", at=59 + 90) is None)
ok("garbage is not a code", mfa.match_step(rfc_secret, "28708x") is None)


def code_now(secret: str, offset: int = 0) -> str:
    return mfa.hotp(secret, mfa.step_at() + offset)


# ── People ────────────────────────────────────────────────────────────────────
OWNER = {"uid": "own1", "email": "owner@x.test", "name": "Owner One", "role": Role.OWNER, "jti": "j-pending"}
OWNER2 = {"uid": "own2", "email": "owner2@x.test", "name": "Owner Two", "role": Role.OWNER, "jti": "j2"}
OBSERVER = {"uid": "observer:1", "role": Role.OBSERVER, "name": "Observer"}
run(db[C.STAFF].insert_one({"uid": "own1", "role": "owner", "email": "owner@x.test", "name": "Owner One", "is_active": True}))
run(db[C.STAFF].insert_one({"uid": "own2", "role": "owner", "email": "owner2@x.test", "name": "Owner Two", "is_active": True}))
run(db[C.STAFF].insert_one({"uid": "tm1", "role": "tech_member", "email": "t@x.test", "name": "T", "is_active": True}))

# ── The gate in deps ──────────────────────────────────────────────────────────


def req(method: str, path: str):
    return types.SimpleNamespace(method=method, scope={"route": types.SimpleNamespace(path=path)})


def gate(user, method, path) -> bool:
    try:
        deps._refuse_owner_without_mfa(req(method, path), user)
        return True
    except deps.HTTPException as exc:
        return exc.status_code == 403 and False


settings.owner_mfa_required = True
pending = {**OWNER, "mfa_verified": False}
ok("pending Owner: an ordinary Owner route is refused", not gate(pending, "GET", "/api/reports/cash-position"))
ok("pending Owner: a write route is refused", not gate(pending, "POST", "/api/staff/{uid}/deactivate"))
ok("pending Owner: an unidentified route is refused", not gate(pending, "GET", ""))
for m, p in mfa.MFA_PENDING_ROUTES:
    ok(f"pending Owner may reach {m} {p}", gate(pending, m, p))
ok("pending Owner cannot regenerate recovery codes", not gate(pending, "POST", "/api/auth/mfa/recovery-codes"))
ok("verified Owner passes", gate({**OWNER, "mfa_verified": True}, "GET", "/api/reports/cash-position"))
ok("a team member is not affected", gate({"uid": "tm1", "role": Role.TECH_MEMBER}, "GET", "/api/reports/cash-position"))
# B3: the Observer carries the same factor (spec §8) — a pending Observer
# session is confined exactly as a pending Owner's; a verified one passes.
# `tests/test_observer_mfa.py` holds the whole of that; this is the pin.
ok("a pending Observer is gated like a pending Owner", not gate(OBSERVER, "GET", "/api/audit"))
ok("a verified Observer passes", gate({**OBSERVER, "mfa_verified": True}, "GET", "/api/audit"))
settings.owner_mfa_required = False
ok("the Owner switch does not reach the Observer (no bypass flag)", not gate(OBSERVER, "GET", "/api/audit"))
ok("…while it does switch the Owner gate off", gate(pending, "GET", "/api/reports/cash-position"))
settings.owner_mfa_required = True
try:
    deps._refuse_owner_without_mfa(req("GET", "/api/users"), pending)
except deps.HTTPException as exc:
    ok("the refusal carries the MFA header for the CRM", (exc.headers or {}).get(deps.MFA_REQUIRED_HEADER) == "1")

# Every MFA route in the allow-list really exists in the router.
src = (ROOT / "app/routers/auth.py").read_text()
for m, p in mfa.MFA_PENDING_ROUTES:
    sub = p.removeprefix("/api/auth")
    ok(f"route exists: {m} {p}", f'@router.{m.lower()}("{sub}"' in src)

# ── Enrolment ─────────────────────────────────────────────────────────────────
settings.owner_mfa_encryption_key = ""
refused("no encryption key: enrolment refused (fail closed)", mfa.start_enrolment(OWNER), 503)
ok("…and nothing was written", run(db[C.OWNER_MFA].find_one({"uid": "own1"})) is None)

settings.owner_mfa_encryption_key = Fernet.generate_key().decode()
refused("a non-owner cannot enrol", mfa.start_enrolment({"uid": "tm1", "role": Role.TECH_MEMBER}), 403)
start = run(mfa.start_enrolment(OWNER))
secret = start["secret"]
rec = run(db[C.OWNER_MFA].find_one({"uid": "own1"}))
ok("the pending secret is stored encrypted, not in clear", secret not in str(rec))
ok("the otpauth URI names the issuer and the secret", start["otpauth_uri"].startswith("otpauth://totp/") and secret in start["otpauth_uri"])

refused("a wrong first code is refused", mfa.confirm_enrolment(OWNER, "000000" if code_now(secret) != "000000" else "111111"), 401)
codes = run(mfa.confirm_enrolment(OWNER, code_now(secret)))
rec = run(db[C.OWNER_MFA].find_one({"uid": "own1"}))
ok("enrolled", bool(rec.get("enrolled_at")))
ok("ten recovery codes", len(codes) == 10 and len(set(codes)) == 10)
ok("recovery codes are stored only as hashes", all(c not in str(rec) for c in codes))
ok("the pending secret is gone", "pending_secret" not in rec)
ok("the enrolled secret is encrypted", secret not in str(rec))
ok("enrolment is audited", audit_log[-1]["action"] == audit_mod.Action.OWNER_MFA_ENROLLED)
ok("…and the Owner is notified", any(n[0] == "own1" and "on for your Owner" in n[2] for n in notices_sent))
refused("enrolment cannot be restarted once enrolled", mfa.start_enrolment(OWNER), 409)

# ── Verify ────────────────────────────────────────────────────────────────────
# The enrolment consumed the current step, so a sign-in in the same 30 s
# needs the next code — the replay rule, exercised.
refused("the code used to enrol cannot sign in (replay)", mfa.verify(OWNER, code=code_now(secret)), 401)
res = run(mfa.verify(OWNER, code=code_now(secret, +1)))
ok("the next code signs in", res["method"] == "totp")
refused("the same code twice is refused (replay)", mfa.verify(OWNER, code=code_now(secret, +1)), 401)

# Recovery codes work once.
res = run(mfa.verify(OWNER, recovery_code=codes[0].upper()))
ok("a recovery code works (case-insensitive)", res["method"] == "recovery_code" and res["recovery_codes_left"] == 9)
refused("…once", mfa.verify(OWNER, recovery_code=codes[0]), 401)
ok("using a recovery code notifies the Owner", any("recovery code was used" in (n[2] or "") for n in notices_sent))

# Lockout
settings.owner_mfa_max_failures = 3
run(db[C.OWNER_MFA].update_one({"uid": "own1"}, {"$set": {"failures": 0}}))
for _ in range(2):
    refused("wrong code", mfa.verify(OWNER, code="999999" if code_now(secret) != "999999" else "888888"), 401)
refused("the threshold locks the factor", mfa.verify(OWNER, code="999999" if code_now(secret) != "999999" else "888888"), 429)
refused("…and a RIGHT code is refused while locked", mfa.verify(OWNER, code=code_now(secret, +1)), 429)
ok("the lock is audited", any(e["action"] == audit_mod.Action.OWNER_MFA_LOCKED for e in audit_log))
ok("…and the Owner is told, in-app and by email",
   any("locked" in (n[2] or "") for n in notices_sent) and any(e.get("kind") == "owner_mfa.locked" for e in emails_sent))
run(db[C.OWNER_MFA].update_one({"uid": "own1"}, {"$set": {"locked_until": None}}))

# ── Sessions ──────────────────────────────────────────────────────────────────
settings.jwt_secret = "x" * 40
tok, _ = run(security.issue_session(uid="own1", email="owner@x.test", name="Owner One", role=Role.OWNER))
ok("a fresh Owner session is NOT verified", run(security.verify_session(tok))["mfa_verified"] is False)
tok2, _ = run(security.issue_session(uid="own1", email="owner@x.test", name="Owner One", role=Role.OWNER, mfa_verified=True))
ok("an upgraded session is verified", run(security.verify_session(tok2))["mfa_verified"] is True)
# A claim without a matching record is not trusted.
_jwt = _jose.jwt

claims = _jwt.decode(tok, settings.jwt_secret, algorithms=["HS256"], issuer=settings.jwt_issuer)
forged = _jwt.encode({**claims, "mfa": True}, settings.jwt_secret, algorithm="HS256")
ok("a token claiming mfa whose record says otherwise is not verified", run(security.verify_session(forged))["mfa_verified"] is False)
try:
    renewed, _, _ = run(security.renew_session(tok2))
    ok("renewing a verified Owner session keeps it verified", run(security.verify_session(renewed))["mfa_verified"] is True)
    renewed_pending, _, _ = run(security.renew_session(tok))
    ok("renewing a pending Owner session keeps it pending", run(security.verify_session(renewed_pending))["mfa_verified"] is False)
except security.AuthError as exc:
    ok(f"renewal ran ({exc})", False)
tm_tok, _ = run(security.issue_session(uid="tm1", email="t@x.test", name="T", role=Role.TECH_MEMBER))
ok("a team member's token has no mfa claim", "mfa" not in _jwt.decode(tm_tok, settings.jwt_secret, algorithms=["HS256"], issuer=settings.jwt_issuer))

# ── Observer reset ────────────────────────────────────────────────────────────
# B3: a reset is a SECURITY RESET — it also ends the Owner's mobile credentials
# (Firebase refresh tokens, quick-login) through `security.revoke_sessions_for_uid`.
# Firebase is not initialised here; stand the two Firebase calls in and record them.
mobile_revoked: list[tuple[str, str]] = []
security.firebase.revoke_sessions = lambda uid: (mobile_revoked.append(("firebase", uid)), "")[1]
security.firebase.revoke_quick_login = lambda uid: (mobile_revoked.append(("quick_login", uid)), "")[1]
refused("an Owner cannot reset another Owner's MFA", mfa.reset_by_observer(OWNER2, "own1", "lost phone, verified by call"), 403)
refused("a reset needs a real reason", mfa.reset_by_observer(OBSERVER, "own1", "lost"), 400)
refused("only Owners can be reset", mfa.reset_by_observer(OBSERVER, "tm1", "lost phone, verified by call"), 404)
out = run(mfa.reset_by_observer(OBSERVER, "own1", "Lost phone; identity confirmed by video call"))
ok("the factor is removed", run(db[C.OWNER_MFA].find_one({"uid": "own1"})) is None and out["was_enrolled"])
ok("every session of that Owner is revoked",
   all(s.get("revoked") for s in db[C.SESSIONS].docs.values() if s.get("uid") == "own1"))
ok("…and not anyone else's", not any(s.get("revoked") for s in db[C.SESSIONS].docs.values() if s.get("uid") == "tm1"))
ok("…and the Owner's mobile credentials went with them (refresh tokens and quick login)",
   ("firebase", "own1") in mobile_revoked and ("quick_login", "own1") in mobile_revoked)
ok("the bulk revocation is on the audit log, by the Observer, with no problems",
   any(e["action"] == audit_mod.Action.SESSIONS_REVOKED and e["subject_id"] == "own1"
       and e["actor"].get("uid") == OBSERVER["uid"] and e["meta"].get("problems") == [] for e in audit_log))
ok("the reset is audited with the reason", audit_log[-1]["action"] == audit_mod.Action.OWNER_MFA_RESET
   and "video call" in audit_log[-1]["reason"])
ok("the Owner is told in-app and by email",
   any(n[0] == "own1" and "reset" in (n[2] or "") for n in notices_sent) and any(e.get("kind") == "owner_mfa.reset" for e in emails_sent))
ok("after a reset the Owner can enrol again", "secret" in run(mfa.start_enrolment(OWNER)))

# ── Nothing secret in the audit log ───────────────────────────────────────────
blob = repr(audit_log)
ok("no audit entry contains the secret", secret not in blob)
ok("no audit entry contains a recovery code", not any(c in blob for c in codes))

if failures:
    print(f"{len(failures)} of {checks} owner-MFA checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} P1 owner-MFA checks passed.")
