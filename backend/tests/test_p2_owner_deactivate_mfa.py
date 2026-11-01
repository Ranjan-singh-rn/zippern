"""P2 (MFA release, narrow port): deactivating an Owner ends every Owner MFA binding,
and a later reinstatement cannot bring one back.

The production `deactivate()` (the pre-P1 code live since 20 Oct) revokes the API
sessions, disables the Firebase login, sets crmUsers.isActive=false and clears the
Storage role claim. It does not touch `ownerMfaSessions/{uid}`, which did not exist.

Merged tree (P1 decision 1, WP-B): the personal Firebase login is NEVER disabled by
a staff deactivation — it is the person's own Zipper app account. Every "login
disabled" expectation of the rc2 version of this test is therefore inverted here:
`firebase.set_user_disabled` stays installed as a tripwire that must never fire, and
the ordering check "bindings gone before the login is disabled" became "bindings gone
before the staff record is marked inactive". The P1-B machinery (`_change_status`,
suspend, reactivate) is part of this tree, so the rc2 pin that refused it is inverted.

With MFA released and no hook:
  * a custom-token session's binding outlives the deactivation; and
  * a reinstatement re-enables a login whose refresh tokens were never revoked.
    Production has no reactivate route, so today a reinstatement is an
    out-of-band re-enable, and `set_user_disabled(uid, False)` leaves the refresh
    tokens alone. The old browser session would then refresh, with the same
    `mfa_sid` and the same `auth_time`, and act as an Owner in the rules again
    without a new MFA.

What this checks:
  1. Deactivating an Owner deletes ALL their bindings (CRM and Android), before the
     staff record is marked inactive, and audits it; the login is never touched.
  2. A bound custom-token session no longer passes the rules' Owner check.
  3. After an out-of-band reinstatement:
     - the old session, refreshed with the same sid and auth_time, is still refused;
     - it cannot be confirmed against a new API session;
     - a fresh MFA sign-in gets a NEW sid, and the old sid stays dead.
  4. A failed clear is reported (`owner_mfa_bindings`, `fully_revoked`), not hidden.
     The rest of the revocation still happens, and running the deactivation again
     clears the bindings.
  5. Deactivating someone who is not an Owner never touches Owner MFA bindings.

Run:  python3 -m tests.test_p2_owner_deactivate_mfa
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
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

# A real (minimal) HS256 so API sessions round-trip, as in test_p1_owner_mfa_binding.
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
from app.services import staff as svc  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
fb._fs = fs
fb.firestore_client = lambda: fs
mfa.get_db = lambda: db
security.get_db = lambda: db
svc.get_db = lambda: db
settings.jwt_secret = "x" * 40

audit_log: list[dict] = []


async def fake_record(**kw):
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record
from app.services import notices as notices_mod  # noqa: E402
from app.services import email as email_mod  # noqa: E402


async def _quiet(*a, **k):
    return True


async def _sent(*a, **k):
    return {"outcome": "sent"}


# P1-F: the access-change notices (in-app + email) are delivered after the change;
# neither delivery is under test here, so both report success.
notices_mod.deliver = _quiet
email_mod.deliver = _sent

# ── The deactivation's other halves, observed ────────────────────────────────────────────────────
#: Decision 1 tripwire: a staff deactivation must never call `set_user_disabled`.
DISABLED: dict[str, bool] = {}
#: The Owner's bindings at the moment the staff record is marked inactive.
BINDINGS_AT_INACTIVE: dict[str, dict] = {}


def doc(uid: str) -> dict:
    snap = fs.collection(mfa.SESSIONS_COLLECTION).document(uid).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def fake_set_user_disabled(uid: str, disabled: bool):
    DISABLED[uid] = disabled
    return None                                            # no problem


_real_staff_update_one = db[C.STAFF].update_one


async def observing_staff_update_one(query, update, *a, **k):
    if query.get("uid") and (update.get("$set") or {}).get("is_active") is False:
        BINDINGS_AT_INACTIVE[query["uid"]] = dict(doc(query["uid"]).get("bindings", {}))
    return await _real_staff_update_one(query, update, *a, **k)


db[C.STAFF].update_one = observing_staff_update_one
svc.firebase.set_user_disabled = fake_set_user_disabled
svc.storage_claims.clear = lambda uid: None


async def fake_crm_set_active(**kw):
    return types.SimpleNamespace(action="updated")


svc.crm.aset_active = fake_crm_set_active

# ── Firebase token verification and custom-token minting, faked as in the binding test ──────────
FIREBASE: dict[str, dict] = {}


def fake_verify(token: str) -> dict:
    if token not in FIREBASE:
        raise ValueError("invalid or revoked")
    return FIREBASE[token]


mfa._verify_firebase_token = fake_verify
mfa._create_custom_token = lambda uid, sid: f"CUSTOM-TOKEN-{uid}-{sid}"

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def fb_token(name: str, uid: str, auth_time: int, provider: str, **extra) -> str:
    FIREBASE[name] = {"uid": uid, "auth_time": auth_time, "firebase": {"sign_in_provider": provider}, **extra}
    return name


def redeem(custom_token: str, auth_time: int, name: str) -> str:
    """What signInWithCustomToken + getIdToken() produce: provider 'custom', the sid claim."""
    uid, sid = custom_token.removeprefix("CUSTOM-TOKEN-").split("-", 1)
    return fb_token(name, uid, auth_time, "custom", mfa_sid=sid)


def verified_session(uid: str):
    tok, exp = run(security.issue_session(uid=uid, email=f"{uid}@x.test", name=uid, role=Role.OWNER, mfa_verified=True))
    claims = run(security.verify_session(tok))
    return {"uid": uid, "email": f"{uid}@x.test", "name": uid, "role": Role.OWNER, "jti": claims["jti"],
            "mfa_verified": True}, exp


def sid_of(user: dict) -> str:
    return str(run(db[C.SESSIONS].find_one({"jti": user["jti"]})).get("mfa_binding_id") or "")


def bind(uid: str, auth_time: int, name: str, client: str = "crm"):
    """A full MFA sign-in: mint for a verified API session, redeem, confirm. Returns (user, sid, id token)."""
    user, exp = verified_session(uid)
    run(mfa.mint_owner_session(user, fb_token(f"pw-{name}", uid, auth_time, "password"), api_jti=user["jti"],
                               api_expires=exp, client=client))
    sid = sid_of(user)
    tok = redeem(f"CUSTOM-TOKEN-{uid}-{sid}", auth_time + 1, name)
    run(mfa.confirm_owner_session(user, tok))
    return user, sid, tok


def rules_owner_ok(uid: str, token: str) -> bool:
    """firestore.rules ownerMfaOk() + ownerMfaBindingLive(), evaluated on the stored document."""
    t = FIREBASE[token]
    sid = t.get("mfa_sid", "")
    b = doc(uid).get("bindings", {}).get(sid, {})
    exp = b.get("expiresAt")
    return (isinstance(sid, str) and sid != "" and t["firebase"]["sign_in_provider"] == "custom"
            and b.get("state") == "active" and b.get("authTime", -1) == t.get("auth_time", -2)
            and exp is not None and exp > datetime.now(timezone.utc))


OBSERVER = {"uid": "obs1", "email": "obs@x.test", "name": "Observer", "role": Role.OBSERVER}
for uid in ("own1", "own2", "own3"):
    run(db[C.STAFF].insert_one({"uid": uid, "role": "owner", "email": f"{uid}@x.test", "name": uid, "is_active": True}))
run(db[C.STAFF].insert_one({"uid": "tech1", "role": "tech_admin", "email": "tech1@x.test", "name": "Tech", "is_active": True,
                            "dept": "tech"}))

# ── 1-2. Deactivation clears every binding, first ────────────────────────────────────────────────
crm_user, crm_sid, crm_tok = bind("own1", 1000, "id-crm")
and_user, and_sid, and_tok = bind("own1", 2000, "id-android", client="android")
ok("precondition: the Owner's CRM and Android sign-ins are both bound",
   rules_owner_ok("own1", crm_tok) and rules_owner_ok("own1", and_tok) and crm_sid != and_sid)

res = run(svc.deactivate("own1", OBSERVER, "Left the company; handover complete."))
ok("deactivating an Owner deletes ALL of their bindings", doc("own1").get("bindings", {}) == {})
ok("the bindings were already gone when the staff record was marked inactive (cleared first)",
   BINDINGS_AT_INACTIVE.get("own1") == {})
ok("decision 1: the personal Firebase login is not touched", "own1" not in DISABLED)
ok("the outcome is reported: owner_mfa_bindings == 'cleared', fully_revoked",
   res.get("owner_mfa_bindings") == "cleared" and res.get("fully_revoked") is True)
ok("audited as owner_mfa.unbound (all), by the Observer",
   any(e.get("action") == audit_mod.Action.OWNER_MFA_UNBOUND and e.get("subject_id") == "own1"
       and (e.get("meta") or {}).get("all") is True for e in audit_log))
ok("the CRM and Android custom-token sessions no longer pass the rules' Owner check",
   not rules_owner_ok("own1", crm_tok) and not rules_owner_ok("own1", and_tok))
staff_row = run(db[C.STAFF].find_one({"uid": "own1"}))
ok("the rest of the revocation is unchanged: API sessions revoked, staff inactive (status deactivated)",
   run(db[C.SESSIONS].find_one({"jti": crm_user["jti"]})).get("revoked") is True
   and run(db[C.SESSIONS].find_one({"jti": and_user["jti"]})).get("revoked") is True
   and staff_row.get("is_active") is False and staff_row.get("status") == "deactivated")

# ── 3. An out-of-band reinstatement cannot revive a binding ──────────────────────────────────────
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": True}}))   # a hand edit, not `reactivate`
refreshed = fb_token("id-crm-refreshed", "own1", FIREBASE[crm_tok]["auth_time"], "custom", mfa_sid=crm_sid)
ok("after reinstatement, the old session refreshed with the same sid and auth_time is still refused",
   not rules_owner_ok("own1", refreshed))
new_user, new_exp = verified_session("own1")
r = run(mfa.confirm_owner_session(new_user, refreshed))
ok("the old sign-in cannot be confirmed against a new API session", r.get("state") != "bound" and doc("own1").get("bindings", {}) == {})
r = run(mfa.confirm_owner_session(crm_user, refreshed))
ok("nor against its own, revoked, API session", r.get("state") != "bound" and doc("own1").get("bindings", {}) == {})
_, fresh_sid, fresh_tok = bind("own1", 3000, "id-fresh")
ok("a fresh MFA sign-in gets a NEW sid and is bound", fresh_sid not in ("", crm_sid, and_sid) and rules_owner_ok("own1", fresh_tok))
ok("and the old sid stays dead", not rules_owner_ok("own1", refreshed) and crm_sid not in doc("own1").get("bindings", {}))

# ── 4. A failed clear is reported, not hidden; a retry clears ────────────────────────────────────
_, o3_sid, o3_tok = bind("own3", 4000, "id-own3")
real_mutate = mfa._mutate


def broken_mutate(uid, change):
    raise RuntimeError("Firestore unavailable")


mfa._mutate = broken_mutate
try:  # revision 4: an incomplete revocation is an error (HTTP 400), never a 200
    res, err = run(svc.deactivate("own3", OBSERVER, "Second Owner leaves; access removed.")), None
except svc.StaffError as exc:
    res, err = None, exc
mfa._mutate = real_mutate
ok("a failed clear is an error naming the bindings, never a success (revision 4)",
   res is None and "MFA bindings were NOT removed" in str(err) and "NOT complete" in str(err)
   and "run the deactivation again" in str(err))
ok("… and the rest of the revocation still happened (inactive; login untouched)",
   run(db[C.STAFF].find_one({"uid": "own3"})).get("is_active") is False and "own3" not in DISABLED)
res = run(svc.deactivate("own3", OBSERVER, "Retry: Firestore was unavailable."))
ok("running the deactivation again clears the bindings", res.get("owner_mfa_bindings") == "cleared"
   and doc("own3").get("bindings", {}) == {} and not rules_owner_ok("own3", o3_tok))

# ── 5. Not an Owner: Owner MFA bindings are never touched ────────────────────────────────────────
calls: list[str] = []
real_clear = mfa.clear_all_bindings


async def spy_clear(uid, reason, actor=None):
    calls.append(uid)
    return await real_clear(uid, reason, actor=actor)


mfa.clear_all_bindings = spy_clear
OWNER2 = {"uid": "own2", "email": "own2@x.test", "name": "own2", "role": Role.OWNER}
res = run(svc.deactivate("tech1", OWNER2, "Moved to another team."))
mfa.clear_all_bindings = real_clear
ok("deactivating a non-Owner never calls clear_all_bindings", calls == [])
ok("… and reports n/a for Owner MFA bindings", res.get("owner_mfa_bindings") == "n/a")

# ── Wiring (source pins on the merged deactivate path) ──────────────────────────────────────────
src = (ROOT / "app" / "services" / "staff.py").read_text()
body = src[src.find("async def deactivate("):src.find("async def team_overview(")]
i_rev = body.find("update_many({\"uid\": uid}, {\"$set\": {\"revoked\": True}})")
i_clear = body.find("clear_all_bindings(")
i_record = body.find("status_patch(to_status)")
ok("deactivate() clears bindings right after revoking the API sessions, before the record write",
   -1 not in (i_rev, i_clear, i_record) and i_rev < i_clear < i_record)
ok("only for Owners", i_clear != -1 and ("if R.is_owner(target_role):" in body[:i_clear]
   or ("is_owner = R.is_owner(target_role)" in body[:i_clear] and "if is_owner:" in body[:i_clear])))
ok("decision 1: the deactivation path never disables the Firebase login",
   "set_user_disabled" not in body and "revoke_refresh_tokens" not in body and DISABLED == {})
ok("the P1-B machinery is present (_change_status / suspend / reactivate)",
   all(w in src for w in ("def _change_status", "def suspend(", "def reactivate(")))

if failures:
    print(f"{len(failures)} of {checks} Owner-deactivation MFA checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} Owner-deactivation MFA checks passed.")
