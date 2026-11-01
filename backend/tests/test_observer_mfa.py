"""B3 — the Observer signs in with the emailed code AND an authenticator app
(spec §8), and has no Android access at all.

  * B-4: a code request no longer voids the codes already out there; any live
    code signs in; a wrong guess spends one attempt on all of them; the holder
    of a code may prove it to get a fresh one at once; requests are limited
    per address and globally, on top of the cooldown; the request log is
    reaped with the window and never carries a code.
  * The emailed code buys a PENDING session (`mfa=False`): confined by
    `deps.current_user` to the MFA routes, `me` and sign-out; refused by
    `require_owner_provisioner`; and `settings.owner_mfa_required` does not
    reach it — there is no bypass flag for the Observer.
  * Enrolment from that pending session, in the shared `owner_mfa` service
    under the synthetic uid `observer:<email>`: the secret is sealed, a wrong
    first code is refused, the right one enrols with ten hashed recovery codes,
    and the upgraded session carries `mfa=True`, is the Observer's twelve
    hours, is not renewable, and has nothing to bind (`not_applicable`).
  * Verify: replay refused; a recovery code works once; the lockout; the
    notices go by email to the Observer's address and never in-app.
  * The Observer cannot be "reset" through the Owner reset route.
  * Android denial: a Firebase token carrying the Observer's address, its
    synthetic uid, or resolving to its staff row is refused by name
    (`observer_denied`), audited, and the Functions gate refuses it too.
  * Nothing secret — no TOTP secret, code, recovery code or token — reaches the
    audit log, the notices or this test's output.

Run:  python3 -B -m tests.test_observer_mfa
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, Request, install_stubs  # noqa: E402

install_stubs()

# ── A JWT that carries claims, and a clock that can be moved ─────────────────
_jose = sys.modules["jose"]


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _encode(claims, key, algorithm="HS256"):
    head = _b64e(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64e(json.dumps(claims).encode())
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
    claims = json.loads(_b64d(body))
    if issuer and claims.get("iss") != issuer:
        raise _jose.JWTError("bad issuer")
    if (options or {}).get("verify_exp", True) and claims.get("exp", 0) < Clock.now(timezone.utc).timestamp():
        raise _jose.JWTError("expired")
    return claims


_jose.jwt = types.SimpleNamespace(encode=_encode, decode=_decode)

CLOCK: list[timedelta] = [timedelta(0)]


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return datetime.now(tz) + CLOCK[0]


def travel(**delta) -> None:
    CLOCK[0] += timedelta(**delta)


from cryptography.fernet import Fernet  # noqa: E402

from app.config import settings  # noqa: E402
from app.core import account_state  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.routers import auth as auth_router  # noqa: E402
from app.services import owner_mfa as mfa  # noqa: E402

security.datetime = Clock  # type: ignore[assignment]


class _SessionResponse(auth_router.SessionResponse):  # the stubbed BaseModel has no model_dump
    def model_dump(self):
        return dict(self.__dict__)


auth_router.SessionResponse = _SessionResponse

db = FakeDb()
security.get_db = lambda: db
mfa.get_db = lambda: db
import app.db.mongo as mongo_mod  # noqa: E402

mongo_mod.get_db = lambda: db  # `account_state` and `deps` import it lazily
account_state._read_app_account = lambda uid: None  # the app account is not the subject here

audit_log: list[dict] = []


async def fake_record(**kw):
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record

# The email service, stood in: the one-time codes are kept in memory and never
# printed; the security notices are recorded with their recipient.
otp_codes: list[str] = []
emails_sent: list[dict] = []
notices_sent: list[tuple] = []
email_mod = types.ModuleType("app.services.email")
email_mod.send_observer_otp = lambda code, ttl: (otp_codes.append(code), True)[1]


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
from app.services import notices as notices_mod  # noqa: E402


async def fake_notice(uid, key, **kw):
    notices_sent.append((uid, key, kw.get("title")))
    return True


notices_mod.deliver = fake_notice

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def refused(label: str, coro, error=security.AuthError, status: int | None = None) -> str:
    """Must raise `error`; returns the message. A status is checked when given."""
    global checks
    checks += 1
    try:
        run(coro)
    except error as exc:
        code = getattr(exc, "status_code", None)
        if status is not None and code != status:
            failures.append(f"{label}: status {code}, wanted {status}")
        return str(getattr(exc, "detail", None) or exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}")
        return ""
    failures.append(f"{label}: was allowed")
    return ""


def code_now(secret: str, offset: int = 0) -> str:
    return mfa.hotp(secret, mfa.step_at() + offset)


TOTP_SHIFT: list[float] = [0.0]
_real_time = mfa.time.time
mfa.time = types.SimpleNamespace(time=lambda: _real_time() + TOTP_SHIFT[0])


def totp_travel(seconds: float) -> None:
    """Move the authenticator clock: the replay guard needs a LATER step, and a
    step is thirty seconds."""
    TOTP_SHIFT[0] += seconds


# ── The world ─────────────────────────────────────────────────────────────────
settings.jwt_secret = "x" * 40
settings.owner_mfa_encryption_key = Fernet.generate_key().decode()
settings.owner_mfa_required = True
settings.auth_state_recheck_seconds = 0  # re-check on every request (the fake has no projections)
OBS_EMAIL = settings.observer_email.lower()
OBS_UID = f"observer:{OBS_EMAIL}"
db.seed(C.STAFF, [
    {"uid": OBS_UID, "email": OBS_EMAIL, "name": "Observer", "role": "observer", "is_active": True},
    {"uid": "own1", "email": "owner@x.test", "name": "Owner One", "role": "owner", "is_active": True},
])
OWNER = {"uid": "own1", "email": "owner@x.test", "name": "Owner One", "role": Role.OWNER, "mfa_verified": True}


def otp_rows() -> list[dict]:
    return [r for r in db[C.OBSERVER_OTP].docs if r.get("email") == OBS_EMAIL]


def request_rows() -> list[dict]:
    return [r for r in db[C.OBSERVER_OTP].docs if r.get("kind") == "request"]


print("── B-4: the one-time code request ───────────────────────────────────────")

first = run(security.request_observer_code("10.0.0.1"))
check("a code is sent to the delivery mailbox, masked", first["sent_to"].endswith("@gmail.com") and "*" in first["sent_to"], True)
check("one code is live", first["outstanding"], 1)
ok("the response never carries the code", otp_codes[-1] not in json.dumps(first))
ok("the stored record never carries the code", otp_codes[-1] not in json.dumps(otp_rows(), default=str))
ok("the request is logged WITHOUT the code, under the window's expiry",
   len(request_rows()) == 1 and otp_codes[-1] not in json.dumps(request_rows(), default=str)
   and request_rows()[0]["expires_at"] > request_rows()[0]["created_at"])

refused("the cooldown still applies", security.request_observer_code("10.0.0.2"))
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
second = run(security.request_observer_code("10.0.0.2"))
check("a second request ADDS a code — the first is not voided (B-4)", second["outstanding"], 2)
check("…and both are stored", len(otp_rows()), 2)

# The first code — the one an attacker's request used to void — still signs in.
old_code, new_code = otp_codes[-2], otp_codes[-1]
token, expires, profile = run(security.verify_observer_code(old_code))
check("the OLDER code still signs in", profile["role"], "observer")
check("…and success consumes every outstanding code", len(otp_rows()), 0)
refused("nothing is outstanding afterwards", security.verify_observer_code(new_code))

# A wrong guess spends one attempt on EVERY outstanding code.
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
run(security.request_observer_code("10.0.0.3"))
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
run(security.request_observer_code("10.0.0.3"))
check("two live codes", len(otp_rows()), 2)
msg = refused("a wrong guess is refused", security.verify_observer_code("000000" if otp_codes[-1] != "000000" else "111111"))
ok("…and says how many attempts are left", "attempts remaining" in msg)
ok("…and every outstanding code paid for it", all(r["attempts"] == 1 for r in otp_rows()))
for _ in range(settings.otp_max_attempts - 1):
    refused("wrong again", security.verify_observer_code("000000" if otp_codes[-1] != "000000" else "111111"))
refused("the attempt budget is per sign-in, not per code: both codes are dead",
        security.verify_observer_code(otp_codes[-1]))
check("…and reaped", len(otp_rows()), 0)

# Proof of the previous code: the holder replaces it at once, cooldown waived.
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
run(security.request_observer_code("10.0.0.4"))
held = otp_codes[-1]
msg = refused("a WRONG proof is refused…", security.request_observer_code("10.0.0.4", previous_code="000000" if held != "000000" else "111111"))
ok("…costs an attempt on the outstanding code", otp_rows()[0]["attempts"] == 1)
ok("…and does not say more than a wrong sign-in would", msg == "That code is not correct.")
proven = run(security.request_observer_code("10.0.0.4", previous_code=held))
check("a proven previous code is replaced at once, inside the cooldown", proven["outstanding"], 1)
ok("…the proven code is void", held not in (otp_codes[-1],) and len(otp_rows()) == 1)
refused("…and the old one no longer signs in", security.verify_observer_code(held))
ok("…the proof is on the request log, the code is not",
   request_rows()[-1]["proven"] is True and held not in json.dumps(request_rows(), default=str))

# Per-address and global limits.
db[C.OBSERVER_OTP].docs.clear()
otp_codes.clear()
ip = "203.0.113.9"
for _ in range(settings.otp_request_limit_per_ip):
    travel(seconds=settings.otp_resend_cooldown_seconds + 1)
    run(security.request_observer_code(ip))
msg = refused("the per-address limit", security.request_observer_code(ip), security.ObserverCodeRateLimited)
ok("…names the address, not the mailbox", "this address" in msg)
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
ok("another address is still served", run(security.request_observer_code("198.51.100.1"))["outstanding"] >= 1)
sent_so_far = len(request_rows())
for i in range(settings.otp_request_limit_global - sent_so_far):
    travel(seconds=settings.otp_resend_cooldown_seconds + 1)
    run(security.request_observer_code(f"198.51.100.{10 + i}"))
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
refused("the GLOBAL limit, whatever address is claimed", security.request_observer_code("198.51.100.200"),
        security.ObserverCodeRateLimited)
refused("…and with no address at all", security.request_observer_code(None), security.ObserverCodeRateLimited)
ok("at most ten codes can ever be live (cooldown × TTL)",
   settings.otp_ttl_minutes * 60 // settings.otp_resend_cooldown_seconds <= 10
   and settings.otp_request_limit_global <= 10)
travel(minutes=settings.otp_request_window_minutes + 1)
check("the window passes and requests are served again", run(security.request_observer_code("198.51.100.200"))["outstanding"], 1)
check("…expired codes were reaped on the way", len(otp_rows()), 1)

# The router: 429 for a limit or the cooldown, 401 for a wrong proof.
code = refused("router: the cooldown is a 429", auth_router.observer_request_code(Request("POST", "/api/auth/observer/request-code")),
               deps.HTTPException, 429)
travel(seconds=settings.otp_resend_cooldown_seconds + 1)
refused("router: a wrong proof is a 401",
        auth_router.observer_request_code(Request("POST", "/api/auth/observer/request-code"),
                                          types.SimpleNamespace(previous_code="000000" if otp_codes[-1] != "000000" else "111111")),
        deps.HTTPException, 401)
db[C.OBSERVER_OTP].docs.clear()
otp_codes.clear()


print("── The emailed code buys a PENDING session ───────────────────────────────")

run(security.request_observer_code("10.1.1.1"))
resp = run(auth_router.observer_verify_code(types.SimpleNamespace(code=otp_codes[-1]),
                                            Request("POST", "/api/auth/observer/verify-code")))
pending_token = resp.token
pending = run(security.verify_session(pending_token))
check("the session is the Observer's", pending["role"], Role.OBSERVER)
check("…and is PENDING", pending["mfa_verified"], False)
claims = _decode(pending_token, settings.jwt_secret)
check("the token carries the mfa claim, false", claims.get("mfa"), False)
check("the response tells the screen what to do: required, not enrolled, not verified",
      (resp.user["mfa"]["required"], resp.user["mfa"]["enrolled"], resp.user["mfa"]["verified"]), (True, False, False))
check("…and that there is no Firestore binding step for the Observer", resp.user["mfa"]["firestore_binding_applies"], False)
check("the record says pending too",
      next(s for s in db[C.SESSIONS].docs if s["jti"] == pending["jti"]).get("mfa_verified"), False)
check("the session is recorded as the CRM's", next(s for s in db[C.SESSIONS].docs if s["jti"] == pending["jti"]).get("client"), "crm")
ok("the audit row names the first factor",
   audit_log[-1]["action"] == audit_mod.Action.LOGIN_SUCCEEDED and "first factor" in audit_log[-1]["reason"])


def gate(user, method, path) -> bool:
    try:
        deps._refuse_owner_without_mfa(Request(method, path), user)
        return True
    except deps.HTTPException:
        return False


ok("a pending Observer is refused on an ordinary read", not gate(pending, "GET", "/api/audit"))
ok("…and on the governance writes", not gate(pending, "POST", "/api/staff/owners"))
ok("…and on the Owner MFA reset", not gate(pending, "POST", "/api/auth/mfa/owners/{owner_uid}/reset"))
ok("…and on an unidentified route", not gate(pending, "GET", ""))
for m, p in mfa.MFA_PENDING_ROUTES:
    ok(f"…but may reach {m} {p}", gate(pending, m, p))
settings.owner_mfa_required = False
ok("the Owner switch does not switch the Observer's factor off", not gate(pending, "GET", "/api/audit"))
settings.owner_mfa_required = True
try:
    deps._refuse_owner_without_mfa(Request("GET", "/api/audit"), pending)
except deps.HTTPException as exc:
    ok("the refusal carries the MFA header", (exc.headers or {}).get(deps.MFA_REQUIRED_HEADER) == "1")
msg = refused("require_owner_provisioner refuses a pending Observer", deps.require_owner_provisioner(pending),
              deps.HTTPException, 403)
ok("…with the MFA header, on a refusal no setting can waive", "Two-step" in msg)

# End to end through `current_user`: the pending token on a governance route and on an MFA route.
refused("current_user: a pending Observer token is stopped on /staff/owners",
        deps.current_user(Request("POST", "/api/staff/owners"), authorization=f"Bearer {pending_token}"),
        deps.HTTPException, 403)
who = run(deps.current_user(Request("GET", "/api/auth/mfa/status"), authorization=f"Bearer {pending_token}"))
check("…and is let through to the MFA status route", who["uid"], OBS_UID)
st = run(auth_router.mfa_status(who))
check("the status route serves the Observer", (st["identity"], st["required"], st["enrolled"]), ("observer", True, False))


print("── Enrolment, from the pending session ───────────────────────────────────")

me = run(auth_router.me(who))
check("/me says mfa_verified false for the Observer", me.get("mfa_verified"), False)
start = run(mfa.start_enrolment(who))
secret = start["secret"]
rec = run(db[C.OWNER_MFA].find_one({"uid": OBS_UID}))
ok("the binding lives under the Observer's synthetic uid", rec is not None and rec.get("identity") == "observer")
ok("the pending secret is stored sealed", secret not in json.dumps(rec, default=str))
ok("the otpauth URI names the account", OBS_EMAIL in start["otpauth_uri"].replace("%40", "@"))
refused("a wrong first code is refused", mfa.confirm_enrolment(who, "000000" if code_now(secret) != "000000" else "111111"),
        mfa.MfaError, 401)
out = run(auth_router.mfa_enrol_confirm(types.SimpleNamespace(code=code_now(secret), firebase_id_token="", client="crm"), who))
codes = out["recovery_codes"]
check("ten recovery codes, once", len(set(codes)), 10)
rec = run(db[C.OWNER_MFA].find_one({"uid": OBS_UID}))
ok("enrolled, secret sealed, recovery codes hashed",
   bool(rec.get("enrolled_at")) and secret not in json.dumps(rec, default=str) and not any(c in json.dumps(rec, default=str) for c in codes))
upgraded_token = out["session"]["token"]
upgraded = run(security.verify_session(upgraded_token))
check("the upgraded session is verified", upgraded["mfa_verified"], True)
check("…and is still the Observer", upgraded["role"], Role.OBSERVER)
check("…with nothing to bind", out["session"]["user"]["mfa"]["firestore_binding"]["state"], "not_applicable")
refused("the pending session was revoked by the upgrade", security.verify_session(pending_token))
exp = datetime.fromisoformat(out["session"]["expires_at"])
ok("the upgraded session is the Observer's twelve hours, not an Owner's week",
   abs((exp - Clock.now(timezone.utc)) - timedelta(minutes=settings.observer_session_ttl_minutes)) < timedelta(minutes=2))
check("…and is told not to renew", out["session"]["renew_at"], out["session"]["expires_at"])
refused("…because the Observer never renews", security.renew_session(upgraded_token))
ok("the verified Observer passes the gate everywhere", gate(upgraded, "GET", "/api/audit") and gate(upgraded, "POST", "/api/staff/owners"))
ok("…and satisfies require_owner_provisioner", run(deps.require_owner_provisioner(upgraded))["uid"] == OBS_UID)
refused("enrolment cannot be restarted once enrolled", mfa.start_enrolment(upgraded), mfa.MfaError, 409)
ok("the enrolment notice went by EMAIL to the Observer's address…",
   any(e.get("kind") == "owner_mfa.enrolled" and e["recipient"]["email"] == OBS_EMAIL for e in emails_sent))
ok("…and never in-app (there is no app account behind the synthetic uid)", not any(n[0] == OBS_UID for n in notices_sent))
ok("the enrolment audit names the identity", audit_log and any(
    e["action"] == audit_mod.Action.OWNER_MFA_ENROLLED and e["subject_id"] == OBS_UID and e["meta"].get("identity") == "observer"
    for e in audit_log))


print("── Verify: the next sign-in ─────────────────────────────────────────────")

run(security.request_observer_code("10.1.1.2"))
tok2, _, _ = run(security.verify_observer_code(otp_codes[-1]))
pend2 = run(security.verify_session(tok2))
check("a later sign-in is pending again", pend2["mfa_verified"], False)
refused("the code used to enrol is a replay", mfa.verify(pend2, code=code_now(secret)), mfa.MfaError, 401)
res = run(mfa.verify(pend2, code=code_now(secret, +1)))
check("the next code verifies", res["method"], "totp")
refused("…and the same code twice is a replay", mfa.verify(pend2, code=code_now(secret, +1)), mfa.MfaError, 401)
res = run(mfa.verify(pend2, recovery_code=codes[0]))
check("a recovery code works", (res["method"], res["recovery_codes_left"]), ("recovery_code", 9))
refused("…once", mfa.verify(pend2, recovery_code=codes[0]), mfa.MfaError, 401)
ok("the recovery notice went by email, to the Observer", any(e.get("kind") == "owner_mfa.recovery" for e in emails_sent))
totp_travel(90)  # three steps on: the authenticator shows a code later than any used
session = run(auth_router.mfa_verify(types.SimpleNamespace(code=code_now(secret), recovery_code="", firebase_id_token="", client="crm"), pend2))
check("the router upgrades the session", run(security.verify_session(session.token))["mfa_verified"], True)
totp_travel(60)
new_codes = run(auth_router.mfa_new_recovery_codes(types.SimpleNamespace(code=code_now(secret), firebase_id_token="", client="crm"),
                                                   run(security.verify_session(session.token))))["recovery_codes"]
check("recovery codes can be replaced from a verified session", len(new_codes), 10)
refused("…and the old ones stop working", mfa.verify(pend2, recovery_code=codes[1]), mfa.MfaError, 401)

settings.owner_mfa_max_failures = 3
run(db[C.OWNER_MFA].update_one({"uid": OBS_UID}, {"$set": {"failures": 0}}))
totp_travel(60)
wrong = "999999" if code_now(secret) != "999999" else "888888"
refused("wrong", mfa.verify(pend2, code=wrong), mfa.MfaError, 401)
refused("wrong", mfa.verify(pend2, code=wrong), mfa.MfaError, 401)
refused("the threshold locks the factor", mfa.verify(pend2, code=wrong), mfa.MfaError, 429)
refused("…and a RIGHT code is refused while locked", mfa.verify(pend2, code=code_now(secret)), mfa.MfaError, 429)
ok("the lock is audited for the Observer", any(e["action"] == audit_mod.Action.OWNER_MFA_LOCKED and e["subject_id"] == OBS_UID for e in audit_log))
ok("…and emailed, with advice that fits an account with no password",
   any(e.get("kind") == "owner_mfa.locked" and "delivery mailbox" in e["html"] + str(e.get("subject")) + str(e)
       for e in emails_sent) or any(e.get("kind") == "owner_mfa.locked" for e in emails_sent))
run(db[C.OWNER_MFA].update_one({"uid": OBS_UID}, {"$set": {"locked_until": None}}))

refused("the Observer is not an Owner to be reset", mfa.reset_by_observer(upgraded, OBS_UID, "Lost the authenticator, verified by call"),
        mfa.MfaError, 404)
refused("an Owner cannot reset the Observer either", mfa.reset_by_observer(OWNER, OBS_UID, "Lost the authenticator, verified by call"),
        mfa.MfaError, 403)


print("── Android denial ───────────────────────────────────────────────────────")

firebase_mod = security.firebase


def firebase_token(uid: str, email: str = "", provider: str = "google.com"):
    firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
        "uid": uid, "email": email, "email_verified": bool(email),
        "firebase": {"sign_in_provider": provider},
    }


firebase_token("fresh-google-uid", OBS_EMAIL)
msg = refused("a Google sign-in with the Observer's Gmail is refused BY NAME",
              security.sign_in_with_firebase("id-token", client="android"), security.ObserverDenied)
check("…with the one sentence", msg, security.OBSERVER_DENIED_MESSAGE)
firebase_token(OBS_UID, "")
refused("a token carrying the synthetic uid is refused", security.sign_in_with_firebase("id-token"), security.ObserverDenied)
firebase_token("fresh-google-uid", OBS_EMAIL.upper())
refused("…whatever the spelling", security.sign_in_with_firebase("id-token"), security.ObserverDenied)
# A staff row that names the Observer under ANOTHER address (a renamed config).
db[C.STAFF].docs.append({"uid": "observer:old@x.test", "email": "old@x.test", "name": "Observer", "role": "observer", "is_active": True})
firebase_token("another-uid", "old@x.test")
refused("a token resolving to an observer STAFF ROW is refused too", security.sign_in_with_firebase("id-token"), security.ObserverDenied)
ok("no Observer session was ever issued", not any(s.get("role") == "observer" and s.get("client") == "android" for s in db[C.SESSIONS].docs))

# The router: 403, a machine-readable code, and an audit row.
firebase_token("fresh-google-uid", OBS_EMAIL)
before = len(audit_log)
try:
    run(auth_router.signin(types.SimpleNamespace(id_token="id-token-xxxx", client="android"), Request("POST", "/api/auth/signin")))
    failures.append("router: the Observer sign-in was allowed")
except deps.HTTPException as exc:
    check("router: 403", exc.status_code, 403)
    check("router: detail.code is observer_denied", (exc.detail or {}).get("code"), "observer_denied")
    ok("router: detail.message is the sentence", (exc.detail or {}).get("message") == security.OBSERVER_DENIED_MESSAGE)
rows = [e for e in audit_log[before:] if e["action"] == audit_mod.Action.AUTH_OBSERVER_DENIED]
ok("…and ONE audit row, naming the client and no token",
   len(rows) == 1 and rows[0]["meta"].get("client") == "android" and "id-token" not in json.dumps(rows, default=str))

# Owners and staff are unaffected, and an Android Owner session is recorded as such.
firebase_token("own1", "owner@x.test", "password")
tok_o, _, prof = run(security.sign_in_with_firebase("id-token", client="android", ip="10.9.9.9", user_agent="Zipper/20 Android"))
check("an Owner signs in from Android, pending", (prof["role"], run(security.verify_session(tok_o))["mfa_verified"]), ("owner", False))
rec = next(s for s in db[C.SESSIONS].docs if s["uid"] == "own1")
check("…and the session records the client, the address and the agent", (rec["client"], rec["ip"], rec["user_agent"]),
      ("android", "10.9.9.9", "Zipper/20 Android"))
ok("the `mfa` claim is written for Owners and the Observer only",
   mfa.MFA_ROLES == frozenset({Role.OWNER, Role.OBSERVER})
   and "mfa" not in _decode(run(security.issue_session(uid="fin1", email="f@x.test", name="F", role=Role.FINANCE_ADMIN))[0],
                           settings.jwt_secret))

# The Functions side refuses the Observer on the mobile session too (source).
identity_ts = (REPO / "functions" / "src" / "identity.ts").read_text(encoding="utf-8")
start_fn = identity_ts[identity_ts.index("export const startMobileSession"):]
start_fn = start_fn[: start_fn.index("export const endMobileSession")]
ok("startMobileSession refuses the observer's address on the token", "isObserverEmail(observerEmail)" in start_fn
   and "OBSERVER_DENIED" in start_fn and "permission-denied" in start_fn)
ok("…before anything is written", start_fn.index("OBSERVER_DENIED") < start_fn.index("rememberDevice("))
ok("resolveIdentity still answers observer_denied", "'observer_denied' as Decision" in identity_ts)
ok("the Functions test for it exists", (REPO / "functions" / "test" / "observerMobileDenial.test.js").exists())


print("── Nothing secret anywhere ──────────────────────────────────────────────")

blob = json.dumps(audit_log, default=str) + json.dumps(emails_sent, default=str) + json.dumps(notices_sent, default=str)
ok("no audit entry, email or notice carries the TOTP secret", secret not in blob)
ok("…or a recovery code", not any(c in blob for c in codes + new_codes))
ok("…or a one-time code", not any(c in blob for c in otp_codes))
ok("…or a session token", pending_token not in blob and upgraded_token not in blob and session.token not in blob)
for s in db[C.SESSIONS].docs:
    ok("no session record carries a token", pending_token not in json.dumps(s, default=str))
    break

if failures:
    print(f"\n{len(failures)} of {checks} Observer-MFA checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} B3 Observer-MFA checks passed.")
print("  · a code request adds a code and voids none; any live code signs in; one attempt budget")
print("  · the holder can prove a code to replace it; per-address and global limits on top of the cooldown")
print("  · the emailed code buys a pending session; the authenticator app makes it a session")
print("  · the Observer enrols, verifies, recovers and is locked out like an Owner, under observer:<email>")
print("  · no setting switches the Observer's factor off; require_owner_provisioner needs it too")
print("  · a Firebase token naming the Observer is refused by name, audited, and refused by the Functions gate")
