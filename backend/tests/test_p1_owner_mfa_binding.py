"""P1-A3b — per-session `mfa_sid` binding of an Owner's Firebase session.

Backend half of the Owner MFA boundary (rules: tests/firestore.p1mfa.rules.test.mjs,
tests/storage.p1mfa.rules.test.mjs; real tokens: tests/auth.p1mfa.emulator.test.mjs).

  * MINT only after: Owner role, the caller's live MFA-verified API session, an
    active Owner staff row, and a Firebase ID token that verifies (signature +
    revocation) for the same uid. Every refusal writes nothing and says why.
  * The custom token carries `mfa_sid` = a random per-session id; the binding
    starts 'minted' and grants nothing.
  * CONFIRM only with the ID token of the session that redeemed it: same uid,
    provider 'custom', mfa_sid == this API session's binding, state minted ->
    'active' with that token's auth_time. A second redemption (other auth_time)
    is a replay and is refused; re-confirming the same sign-in is idempotent.
  * A mint failure leaves no binding; a renewal failure revokes the binding.
  * Renewal moves + extends; a revoked binding is never resurrected.
  * Sign-out removes only its own binding; Observer reset removes all.
  * CRM and Android sessions are independent; same-second sign-ins get
    different sids, so one's sign-out never touches the other.
  * No full sid, custom token or ID token in the audit log.

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

MINTED: list[tuple[str, str]] = []
MINT_FAIL = {"on": False}


def fake_mint(uid: str, sid: str) -> str:
    if MINT_FAIL["on"]:
        raise RuntimeError("signBlob denied")
    MINTED.append((uid, sid))
    return f"CUSTOM-TOKEN-{uid}-{sid}"


mfa._create_custom_token = fake_mint


def fb_token(name: str, uid: str, auth_time: int, provider: str, **extra) -> str:
    FIREBASE[name] = {"uid": uid, "auth_time": auth_time, "firebase": {"sign_in_provider": provider}, **extra}
    return name


def redeem(custom_token: str, auth_time: int, name: str | None = None) -> str:
    """What signInWithCustomToken + getIdToken() produce: provider 'custom', the sid claim."""
    uid, sid = custom_token.removeprefix("CUSTOM-TOKEN-").split("-", 1)
    return fb_token(name or f"id-{sid}-{auth_time}", uid, auth_time, "custom", mfa_sid=sid)


def verified_session(uid: str = "own1") -> tuple[str, dict, datetime]:
    tok, exp = run(security.issue_session(uid=uid, email="o@x.test", name="Owner", role=Role.OWNER, mfa_verified=True))
    claims = run(security.verify_session(tok))
    return tok, {**OWNER, "uid": uid, "jti": claims["jti"], "mfa_verified": True}, exp


def doc(uid: str = "own1") -> dict:
    snap = fs.collection(mfa.SESSIONS_COLLECTION).document(uid).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def binding(sid: str, uid: str = "own1") -> dict:
    return doc(uid).get("bindings", {}).get(sid, {})


def sid_of(user: dict) -> str:
    return str(run(db[C.SESSIONS].find_one({"jti": user["jti"]})).get("mfa_binding_id") or "")


# ── Mint: refusals write nothing ─────────────────────────────────────────────
_, u0, e0 = verified_session()
r = run(mfa.mint_owner_session(u0, "", api_jti=u0["jti"], api_expires=e0))
ok("no Firebase token → 'missing_token', nothing minted", r["state"] == "missing_token" and doc() == {} and not MINTED)
r = run(mfa.mint_owner_session(u0, "garbage", api_jti=u0["jti"], api_expires=e0))
ok("invalid/revoked Firebase token → failed, nothing minted", r["state"] == "failed" and doc() == {} and not MINTED)
r = run(mfa.mint_owner_session(u0, fb_token("t-other", "someone-else", 1000, "password"), api_jti=u0["jti"], api_expires=e0))
ok("token for another uid → failed", r["state"] == "failed" and doc() == {} and not MINTED)
FIREBASE["t-noat"] = {"uid": "own1", "firebase": {"sign_in_provider": "password"}}
r = run(mfa.mint_owner_session(u0, "t-noat", api_jti=u0["jti"], api_expires=e0))
ok("token without auth_time → failed", r["state"] == "failed" and doc() == {})
ptok, pexp = run(security.issue_session(uid="own1", email="o@x.test", name="Owner", role=Role.OWNER))
pjti = run(security.verify_session(ptok))["jti"]
r = run(mfa.mint_owner_session({**OWNER, "jti": pjti}, fb_token("t-a", "own1", 1000, "password"), api_jti=pjti, api_expires=pexp))
ok("a PENDING (not MFA-verified) API session cannot mint", r["state"] == "failed" and doc() == {} and not MINTED)
r = run(mfa.mint_owner_session({**u0, "role": Role.TECH_ADMIN}, "t-a", api_jti=u0["jti"], api_expires=e0))
ok("a non-Owner cannot mint", r["state"] == "failed" and doc() == {})
_, u_o2, e_o2 = verified_session("own2")
r = run(mfa.mint_owner_session(u0, "t-a", api_jti=u_o2["jti"], api_expires=e_o2))
ok("another user's API session cannot be used", r["state"] == "failed" and doc() == {})
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": False}}))
r = run(mfa.mint_owner_session(u0, "t-a", api_jti=u0["jti"], api_expires=e0))
ok("a deactivated Owner cannot mint", r["state"] == "failed" and doc() == {})
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": True}}))
r = run(mfa.mint_owner_session(u0, "t-a", api_jti=u0["jti"], api_expires=datetime.now(timezone.utc) - timedelta(seconds=1)))
ok("an expired API session cannot mint", r["state"] == "failed" and doc() == {})
MINT_FAIL["on"] = True
r = run(mfa.mint_owner_session(u0, "t-a", api_jti=u0["jti"], api_expires=e0))
MINT_FAIL["on"] = False
ok("a token-minting failure (signBlob) leaves NO binding behind (fail closed)", r["state"] == "failed" and doc() == {})

# ── Mint + confirm: CRM ──────────────────────────────────────────────────────
crm_tok, crm, crm_exp = verified_session()
r = run(mfa.mint_owner_session(crm, fb_token("t-crm-pw", "own1", 1000, "password"), api_jti=crm["jti"], api_expires=crm_exp))
ok("mint returns a custom token and state 'minted'", r["state"] == "minted" and r["custom_token"].startswith("CUSTOM-TOKEN-"))
crm_sid = sid_of(crm)
ok("the sid is long and random", len(crm_sid) >= 20 and MINTED[-1] == ("own1", crm_sid))
ok("the binding starts MINTED (grants nothing in the rules)", binding(crm_sid).get("state") == "minted")
ok("…tied to this API session and its expiry", binding(crm_sid)["apiJti"] == crm["jti"] and binding(crm_sid)["expiresAt"] == crm_exp)
ok("…and to the verified sign-in it came from", binding(crm_sid)["issuedFromAuthTime"] == 1000)

r = run(mfa.confirm_owner_session(crm, "t-crm-pw"))
ok("confirming with the OLD password sign-in is refused (no mfa_sid, provider password)", r["state"] == "failed" and binding(crm_sid)["state"] == "minted")
fb_token("t-forged", "own1", 1001, "password", mfa_sid=crm_sid)
r = run(mfa.confirm_owner_session(crm, "t-forged"))
ok("an mfa_sid on a non-custom provider is refused", r["state"] == "failed" and binding(crm_sid)["state"] == "minted")
fb_token("t-wrongsid", "own1", 1001, "custom", mfa_sid="not-the-sid")
r = run(mfa.confirm_owner_session(crm, "t-wrongsid"))
ok("an unknown mfa_sid is refused", r["state"] == "failed")
redeemed = redeem(f"CUSTOM-TOKEN-own1-{crm_sid}", 1001)
r = run(mfa.confirm_owner_session({**crm, "mfa_verified": False}, redeemed))
ok("a pending session cannot confirm", r["state"] == "failed")
r = run(mfa.confirm_owner_session(crm, redeemed))
ok("the redeemed custom-token session confirms", r["state"] == "bound")
ok("…binding ACTIVE with the redeemed sign-in's auth_time", binding(crm_sid)["state"] == "active" and binding(crm_sid)["authTime"] == 1001)
ok("re-confirming the same sign-in is idempotent", run(mfa.confirm_owner_session(crm, redeemed))["state"] == "bound")
replay = redeem(f"CUSTOM-TOKEN-own1-{crm_sid}", 1500, name="id-replay")
r = run(mfa.confirm_owner_session(crm, replay))
ok("a SECOND redemption of the custom token (other auth_time) is a replay, refused", r["state"] == "failed" and binding(crm_sid)["authTime"] == 1001)
_, other, other_exp = verified_session()
r = run(mfa.confirm_owner_session(other, redeemed))
ok("another API session cannot confirm this binding", r["state"] == "failed")

# ── Same second, same provider: a different session gets a DIFFERENT sid ─────
twin_tok, twin, twin_exp = verified_session()
run(mfa.mint_owner_session(twin, fb_token("t-twin-pw", "own1", 1000, "password"), api_jti=twin["jti"], api_expires=twin_exp))
twin_sid = sid_of(twin)
ok("a same-second, same-provider session gets its own sid", twin_sid and twin_sid != crm_sid)
run(mfa.confirm_owner_session(twin, redeem(f"CUSTOM-TOKEN-own1-{twin_sid}", 1001, name="id-twin")))
ok("both active independently", binding(crm_sid)["state"] == "active" and binding(twin_sid)["state"] == "active")

# ── Android: a separate sign-in ───────────────────────────────────────────────
and_tok, andr, and_exp = verified_session()
run(mfa.mint_owner_session(andr, fb_token("t-phone", "own1", 2000, "phone"), api_jti=andr["jti"], api_expires=and_exp, client="android"))
and_sid = sid_of(andr)
run(mfa.confirm_owner_session(andr, redeem(f"CUSTOM-TOKEN-own1-{and_sid}", 2001, name="id-android")))
ok("the Android session binds alongside", binding(and_sid).get("state") == "active" and binding(and_sid)["client"] == "android")

# ── Sign-out: only its own ───────────────────────────────────────────────────
ok("signing out the CRM session removes its binding", run(mfa.unbind_session(crm["jti"], actor=OWNER)) is True)
ok("…and only that one", crm_sid not in doc()["bindings"] and binding(twin_sid)["state"] == "active" and binding(and_sid)["state"] == "active")
ok("sign-out is idempotent", run(mfa.unbind_session(crm["jti"], actor=OWNER)) is False)
run(mfa.unbind_session(twin["jti"], actor=OWNER))

# ── Renewal ──────────────────────────────────────────────────────────────────
renewed, renewed_exp, prof = run(security.renew_session(and_tok))
new_jti = run(security.verify_session(renewed))["jti"]
ok("renewal moves the binding to the new API session", binding(and_sid)["apiJti"] == new_jti)
ok("…extends it to the new expiry", binding(and_sid)["expiresAt"] == renewed_exp)
ok("…keeps it ACTIVE with the same sid (the Firebase session continues)", binding(and_sid)["state"] == "active")
ok("…reports 'bound'", prof.get("mfa_firestore_binding") == "bound")
run(mfa.unbind_session(new_jti, actor=OWNER))
again, _, prof2 = run(security.renew_session(renewed))
ok("renewal NEVER resurrects a revoked binding", and_sid not in doc().get("bindings", {}) and prof2.get("mfa_firestore_binding") == "not_bound")

# Renewal failure revokes (fail closed).
r_tok, r_user, r_exp = verified_session()
run(mfa.mint_owner_session(r_user, fb_token("t-rf", "own1", 3000, "password"), api_jti=r_user["jti"], api_expires=r_exp))
r_sid = sid_of(r_user)
run(mfa.confirm_owner_session(r_user, redeem(f"CUSTOM-TOKEN-own1-{r_sid}", 3001, name="id-rf")))
real_mutate = mfa._mutate
calls = {"n": 0}


def flaky(uid, change):
    calls["n"] += 1
    if calls["n"] == 1:
        raise RuntimeError("Firestore unavailable")
    return real_mutate(uid, change)


mfa._mutate = flaky
_, _, rprof = run(security.renew_session(r_tok))
mfa._mutate = real_mutate
ok("a renewal whose binding write fails reports 'failed'", rprof.get("mfa_firestore_binding") == "failed")
ok("…and the binding is REVOKED, not left on the old session", r_sid not in doc().get("bindings", {}))

# ── Retry unlock replaces this session's binding ─────────────────────────────
rt_tok, rt, rt_exp = verified_session()
run(mfa.mint_owner_session(rt, fb_token("t-rt", "own1", 4000, "password"), api_jti=rt["jti"], api_expires=rt_exp))
first = sid_of(rt)
run(mfa.mint_owner_session(rt, "t-rt", api_jti=rt["jti"], api_expires=rt_exp))
second = sid_of(rt)
ok("a retry mints a new sid and drops this session's previous one", second != first and first not in doc()["bindings"] and second in doc()["bindings"])

# ── Observer reset clears everything ─────────────────────────────────────────
out = run(mfa.reset_by_observer({"uid": "observer:1", "role": Role.OBSERVER}, "own1", "Lost phone; identity confirmed by call"))
ok("Observer reset removes every binding", doc() == {} and out["firestore_bindings_cleared"] is True)
ok("clearing is idempotent", run(mfa.clear_all_bindings("own1", "again")) is True and doc() == {})

# ── Pruning and the cap ──────────────────────────────────────────────────────
x_tok, xu, x_exp = verified_session()
run(mfa.mint_owner_session(xu, fb_token("t-x", "own1", 5000, "password"), api_jti=xu["jti"], api_expires=x_exp))
xs = sid_of(xu)
d = doc()
d["bindings"][xs]["createdAt"] = datetime.now(timezone.utc) - mfa.MINT_TTL - timedelta(seconds=1)
fs.collection(mfa.SESSIONS_COLLECTION).document("own1").set(d)
for i in range(mfa.MAX_BINDINGS + 2):
    _, ui, ei = verified_session()
    run(mfa.mint_owner_session(ui, fb_token(f"t-c{i}", "own1", 6000 + i, "password"), api_jti=ui["jti"], api_expires=ei))
ok("a minted binding never confirmed within the token lifetime is pruned", xs not in doc()["bindings"])
ok("at most MAX_BINDINGS are kept", len(doc()["bindings"]) == mfa.MAX_BINDINGS)
run(mfa.clear_all_bindings("own1", "tidy"))

# ── Storage-claim writer never persists mfa_sid ─────────────────────────────
from app.services import storage_claims as sc  # noqa: E402

written: list[dict] = []
sc._auth = lambda: types.SimpleNamespace(
    get_user=lambda uid: types.SimpleNamespace(custom_claims={"role": "owner", "aid": "", "mfa_sid": "leaked", "x": 1}),
    set_custom_user_claims=lambda uid, claims: written.append(dict(claims)))
sc._apply("own1", {"role": "owner", "aid": ""})
ok("the account-wide claim writer strips mfa_sid", written and "mfa_sid" not in written[-1] and written[-1].get("x") == 1)

# ── Router wiring / logging hygiene (source checks; FastAPI is stubbed) ──────
src = (ROOT / "app/routers/auth.py").read_text()
ok("verify and enrol-confirm mint for the new session", "owner_mfa.mint_owner_session(\n        user, firebase_id_token, api_jti=new_jti" in src)
ok("a confirm route exists for verified sessions only", '@router.post("/mfa/bind/confirm")' in src)
ok("neither bind route is reachable by a pending session",
   ("POST", "/api/auth/mfa/bind") not in mfa.MFA_PENDING_ROUTES and ("POST", "/api/auth/mfa/bind/confirm") not in mfa.MFA_PENDING_ROUTES)
ok("sign-out releases this session's binding", "owner_mfa.unbind_session(jti, actor=user)" in src)
blob = repr(audit_log)
ok("no audit entry carries a custom token or ID token", "CUSTOM-TOKEN" not in blob and "id-" not in blob and "t-crm-pw" not in blob)
ok("no audit entry carries a full sid", not any(s in blob for s in (crm_sid, twin_sid, and_sid, r_sid, first, second)))
mfa_src = (ROOT / "app/services/owner_mfa.py").read_text()
ok("the mint failure log names the exception type only (no token)", 'type(exc).__name__' in mfa_src)

if failures:
    print(f"{len(failures)} of {checks} owner-MFA binding checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} P1 owner-MFA binding checks passed.")
