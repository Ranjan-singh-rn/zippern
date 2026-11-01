"""P1-A3b — binding an Owner's Firebase sign-in to an MFA-verified API session.

Backend half of the Owner MFA boundary (the rules half is
tests/firestore.p1mfa.rules.test.mjs and tests/storage.p1mfa.rules.test.mjs).

  * bind: only after the Firebase token verifies, its uid matches, the API
    session is the caller's live MFA-verified Owner session, and the staff row
    is an active Owner. Every refusal writes NOTHING and returns a state.
  * missing token → API upgraded, Firestore/Storage stay locked (explicit state).
  * one binding per API session, keyed by a random id; the rules-facing
    `active` index (auth_time:provider → expiry) is derived from live bindings.
  * CRM and Android sign-ins coexist; two sessions with the SAME auth_time and
    provider each hold a binding, and signing one out keeps the shared key live.
  * renewal moves the binding to the new jti and extends it; a binding removed
    by sign-out/reset is never re-created by renewal.
  * Observer reset clears every binding; sign-out clears only its own.
  * expired bindings are pruned; at most MAX_BINDINGS kept.
  * the router passes the client's token on verify AND enrol-confirm, and
    sign-out releases the binding.

Run:  python3 -m tests.test_p1_owner_mfa_binding
"""

from __future__ import annotations

import asyncio
import base64 as _b64
import hashlib
import hmac
import json as _json
import sys
import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

# A real (minimal) HS256 so sessions round-trip, as in test_p1_owner_mfa.
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
    head, body, sig = token.split(".")
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

from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

from app.config import settings  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import owner_mfa as mfa  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
fb._fs = fs
fb.firestore_client = lambda: fs
mfa.get_db = lambda: db
security.get_db = lambda: db
settings.jwt_secret = "x" * 40

audit_log: list[dict] = []


async def fake_record(**kw):
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record
from app.services import notices as notices_mod  # noqa: E402


async def _no_notice(*a, **k):
    return True


notices_mod.deliver = _no_notice
from app.services import email as email_mod  # noqa: E402

email_mod.deliver = _no_notice  # the reset notice email is best-effort and not under test here

#: token string → decoded claims the "Firebase" verifier returns; anything else is invalid.
FIREBASE: dict[str, dict] = {}


def fake_verify(token: str) -> dict:
    if token not in FIREBASE:
        raise ValueError("invalid or revoked")
    return FIREBASE[token]


mfa._verify_firebase_token = fake_verify

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


OWNER = {"uid": "own1", "email": "o@x.test", "name": "Owner", "role": Role.OWNER}
run(db[C.STAFF].insert_one({"uid": "own1", "role": "owner", "email": "o@x.test", "name": "Owner", "is_active": True}))
run(db[C.STAFF].insert_one({"uid": "own2", "role": "owner", "email": "o2@x.test", "name": "Owner2", "is_active": True}))


def fb_token(name: str, uid: str, auth_time: int, provider: str) -> str:
    FIREBASE[name] = {"uid": uid, "auth_time": auth_time, "firebase": {"sign_in_provider": provider}}
    return name


def verified_session(uid: str = "own1") -> tuple[str, str, datetime]:
    tok, exp = run(security.issue_session(uid=uid, email="o@x.test", name="Owner", role=Role.OWNER, mfa_verified=True))
    return tok, run(security.verify_session(tok))["jti"], exp


def doc(uid: str = "own1") -> dict:
    snap = fs.collection(mfa.SESSIONS_COLLECTION).document(uid).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def active(uid: str = "own1") -> dict:
    return doc(uid).get("active", {})


# ── Refusals write nothing ───────────────────────────────────────────────────
_, jti0, exp0 = verified_session()
r = run(mfa.bind_firebase_session(OWNER, "", api_jti=jti0, api_expires=exp0))
ok("no token → explicit 'missing_token', nothing bound", r["state"] == "missing_token" and doc() == {})
r = run(mfa.bind_firebase_session(OWNER, "garbage", api_jti=jti0, api_expires=exp0))
ok("invalid/revoked Firebase token → failed, nothing bound", r["state"] == "failed" and doc() == {})
r = run(mfa.bind_firebase_session(OWNER, fb_token("t-other", "someone-else", 1000, "password"), api_jti=jti0, api_expires=exp0))
ok("token for another uid → failed, nothing bound", r["state"] == "failed" and "different account" in r["reason"] and doc() == {})
FIREBASE["t-noat"] = {"uid": "own1", "firebase": {"sign_in_provider": "password"}}
r = run(mfa.bind_firebase_session(OWNER, "t-noat", api_jti=jti0, api_expires=exp0))
ok("token without auth_time → failed", r["state"] == "failed" and doc() == {})
pend_tok, pend_exp = run(security.issue_session(uid="own1", email="o@x.test", name="Owner", role=Role.OWNER))
pend_jti = run(security.verify_session(pend_tok))["jti"]
r = run(mfa.bind_firebase_session(OWNER, fb_token("t-a", "own1", 1000, "password"), api_jti=pend_jti, api_expires=pend_exp))
ok("a PENDING (not MFA-verified) API session cannot be bound", r["state"] == "failed" and doc() == {})
r = run(mfa.bind_firebase_session({**OWNER, "role": Role.TECH_ADMIN}, "t-a", api_jti=jti0, api_expires=exp0))
ok("a non-Owner cannot bind", r["state"] == "failed" and doc() == {})
_, jti_other_owner, exp_o = verified_session("own2")
r = run(mfa.bind_firebase_session(OWNER, "t-a", api_jti=jti_other_owner, api_expires=exp_o))
ok("another user's API session cannot be bound", r["state"] == "failed" and doc() == {})
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": False}}))
r = run(mfa.bind_firebase_session(OWNER, "t-a", api_jti=jti0, api_expires=exp0))
ok("a deactivated Owner cannot bind", r["state"] == "failed" and doc() == {})
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": True}}))
ok("every refusal is audited", sum(1 for e in audit_log if e["action"] == audit_mod.Action.OWNER_MFA_BIND_FAILED) >= 6)
ok("no audit entry carries a token", "t-a" not in repr(audit_log) and "garbage" not in repr(audit_log))

# ── Bind: CRM ────────────────────────────────────────────────────────────────
crm_tok, crm_jti, crm_exp = verified_session()
r = run(mfa.bind_firebase_session(OWNER, "t-a", api_jti=crm_jti, api_expires=crm_exp, client="crm"))
ok("CRM sign-in binds", r["state"] == "bound")
ok("rules key is auth_time:provider", list(active()) == ["1000:password"])
ok("the key expires with the API session", active()["1000:password"] == crm_exp)
crm_bid = run(db[C.SESSIONS].find_one({"jti": crm_jti}))["mfa_binding_id"]
ok("the API session records its binding id", bool(crm_bid) and crm_bid in doc()["bindings"])
ok("the binding names the API session it belongs to", doc()["bindings"][crm_bid]["apiJti"] == crm_jti)

# ── Android: a separate sign-in coexists ─────────────────────────────────────
and_tok, and_jti, and_exp = verified_session()
r = run(mfa.bind_firebase_session(OWNER, fb_token("t-phone", "own1", 2000, "phone"), api_jti=and_jti, api_expires=and_exp, client="android"))
ok("Android sign-in binds alongside", r["state"] == "bound" and set(active()) == {"1000:password", "2000:phone"})

# ── Collision: a second session with the SAME auth_time and provider ─────────
twin_tok, twin_jti, twin_exp = verified_session()
r = run(mfa.bind_firebase_session(OWNER, fb_token("t-twin", "own1", 1000, "password"), api_jti=twin_jti, api_expires=twin_exp))
ok("a same-auth_time session gets its OWN binding", r["state"] == "bound" and len(doc()["bindings"]) == 3)
ok("…sharing one rules key", sorted(active()) == ["1000:password", "2000:phone"])

# Sign out the CRM session: only its binding goes; the twin keeps the key live.
ok("sign-out removes this session's binding", run(mfa.unbind_session(crm_jti, actor=OWNER)) is True)
ok("…and only that one", crm_bid not in doc()["bindings"] and len(doc()["bindings"]) == 2)
ok("…the shared key survives for the twin", "1000:password" in active())
ok("…the Android key is untouched", "2000:phone" in active())
ok("sign-out is idempotent", run(mfa.unbind_session(crm_jti, actor=OWNER)) is False and len(doc()["bindings"]) == 2)
run(mfa.unbind_session(twin_jti, actor=OWNER))
ok("when the last session with a key signs out, the key goes", "1000:password" not in active() and "2000:phone" in active())

# ── Renewal ──────────────────────────────────────────────────────────────────
before_bid = run(db[C.SESSIONS].find_one({"jti": and_jti}))["mfa_binding_id"]
renewed, renewed_exp, prof = run(security.renew_session(and_tok))
new_jti = run(security.verify_session(renewed))["jti"]
b = doc()["bindings"][before_bid]
ok("renewal moves the binding to the new API session", b["apiJti"] == new_jti)
ok("…and extends it to the new expiry", b["expiresAt"] == renewed_exp and active()["2000:phone"] == renewed_exp)
ok("…and reports the state", prof.get("mfa_firestore_binding") == "bound")
ok("…the new session record carries the binding id", run(db[C.SESSIONS].find_one({"jti": new_jti}))["mfa_binding_id"] == before_bid)
ok("…the old session is revoked (renewal is not replayable)", run(db[C.SESSIONS].find_one({"jti": and_jti}))["revoked"] is True)

# A renewal after the binding was removed never re-creates it.
run(mfa.unbind_session(new_jti, actor=OWNER))
again, _, prof2 = run(security.renew_session(renewed))
ok("renewal of an unbound session does not re-create a binding", doc() == {} and prof2.get("mfa_firestore_binding") == "not_bound")

# A pending session's renewal never touches bindings.
pt, _, pprof = run(security.renew_session(pend_tok))
ok("a pending Owner session renews without any binding", "mfa_firestore_binding" not in pprof and doc() == {})

# ── Observer reset clears everything ─────────────────────────────────────────
s1, j1, e1 = verified_session()
s2, j2, e2 = verified_session()
run(mfa.bind_firebase_session(OWNER, fb_token("t-r1", "own1", 3000, "password"), api_jti=j1, api_expires=e1))
run(mfa.bind_firebase_session(OWNER, fb_token("t-r2", "own1", 4000, "phone"), api_jti=j2, api_expires=e2, client="android"))
ok("two live bindings before the reset", len(active()) == 2)
out = run(mfa.reset_by_observer({"uid": "observer:1", "role": Role.OBSERVER}, "own1", "Lost phone; identity confirmed by call"))
ok("Observer reset removes every binding", doc() == {} and out["firestore_bindings_cleared"] is True)
ok("…and revokes every API session", run(db[C.SESSIONS].find_one({"jti": j1}))["revoked"] is True)
ok("clearing is idempotent", run(mfa.clear_all_bindings("own1", "again")) is True and doc() == {})

# ── Expiry pruning and the cap ───────────────────────────────────────────────
s3, j3, e3 = verified_session()
run(mfa.bind_firebase_session(OWNER, fb_token("t-x", "own1", 5000, "password"), api_jti=j3, api_expires=e3))
d = doc()
bid = next(iter(d["bindings"]))
d["bindings"][bid]["expiresAt"] = datetime.now(timezone.utc) - timedelta(seconds=1)
fs.collection(mfa.SESSIONS_COLLECTION).document("own1").set(d)
s4, j4, e4 = verified_session()
run(mfa.bind_firebase_session(OWNER, fb_token("t-y", "own1", 6000, "password"), api_jti=j4, api_expires=e4))
ok("an expired binding is pruned on the next write", bid not in doc()["bindings"] and "5000:password" not in active())
for i in range(mfa.MAX_BINDINGS + 3):
    _, jj, ee = verified_session()
    run(mfa.bind_firebase_session(OWNER, fb_token(f"t-c{i}", "own1", 7000 + i, "password"), api_jti=jj, api_expires=ee))
ok("at most MAX_BINDINGS are kept", len(doc()["bindings"]) == mfa.MAX_BINDINGS)
ok("…the newest are kept", f"{7000 + mfa.MAX_BINDINGS + 2}:password" in active())
run(mfa.clear_all_bindings("own1", "tidy"))

# ── Router wiring (source checks: FastAPI is stubbed here) ───────────────────
src = (ROOT / "app/routers/auth.py").read_text()
ok("verify passes the client's Firebase token", "await _upgraded_session(user, body.firebase_id_token, body.client)" in src)
ok("enrol-confirm passes it too", "session = await _upgraded_session(user, body.firebase_id_token, body.client)" in src)
ok("sign-out releases this session's binding", "owner_mfa.unbind_session(jti, actor=user)" in src)
ok("the retry route is for verified sessions only", "not user.get(\"mfa_verified\")" in src and '@router.post("/mfa/bind")' in src)
from app.services import owner_mfa as _m  # noqa: E402
ok("/mfa/bind is NOT reachable by a pending session", ("POST", "/api/auth/mfa/bind") not in _m.MFA_PENDING_ROUTES)
staff_src = (ROOT / "app/services/staff.py").read_text()
ok("suspension/deactivation of an Owner clears its bindings", 'owner_mfa.clear_all_bindings(uid, f"Owner {to_status}", actor=actor)' in staff_src)
ok("role change away from Owner clears bindings (defensive)", 'clear_all_bindings(uid, "Role changed away from Owner"' in staff_src)
ok("the rules key format matches the backend", "string(request.auth.token.get('auth_time', 0)) + ':'" in (ROOT.parent / "firestore.rules").read_text()
   and mfa.binding_key(1000, "password") == "1000:password")

if failures:
    print(f"{len(failures)} of {checks} owner-MFA binding checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} P1 owner-MFA binding checks passed.")
