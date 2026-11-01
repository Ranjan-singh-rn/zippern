"""P2 (MFA release, revision 4): no deactivation is ever reported as done unless it is,
the last two active Owners cannot be deactivated at the same time, and every failure
path finishes the rest of the revocation and can be run again.

Revision 3 left four gaps (DEPLOYMENT-READINESS.md §3, risks 1–4):
  R1  a partial revocation (Firebase login still enabled, storage claim not cleared,
      MFA bindings not removed) returned HTTP 200 with `fully_revoked: false`, which
      the deployed CRM shows as "no longer has access"; a binding failure was not audited;
  R2  a CRM-directory failure returned before the storage claim was cleared, said
      "Nothing else was changed", named a repair script that does not fix it, and gave
      HTTP 500 when its own audit entry also failed;
  R3  the last-active-Owner guard checked, then wrote later: two simultaneous Observer
      deactivations of the last two active Owners could leave none;
  R4  a Mongo failure on the `is_active` write raised a 500 with the login still enabled.
And the `change_role()` binding hook ignored a failed clear.

What this checks, with failures injected into Mongo, Firestore, the CRM directory,
the storage claim and the audit log:
  A. A 200 always means `fully_revoked: true`. Every incomplete revocation is a StaffError
     (HTTP 400) that names what is outstanding, says it is NOT complete and to run it
     again, is audited once as `staff.revocation_incomplete`, and a retry finishes it.
     (A1, decision 1: the Firebase login is not a revocation step at all — a Firebase
     failure cannot make a deactivation incomplete because the login is never touched.)
  B. A CRM failure no longer stops the claim from being cleared, and a CRM failure whose
     own audit entry fails is still a StaffError, never a 500.
  C. Two simultaneous deactivations of the last two active Owners: one succeeds, one is
     refused and changes nothing, an Owner is left. The lease is given back, a stale one
     is taken over, and a held one refuses without changing anything.
  D. An `is_active` write failure still switches the CRM entry off and clears the claim;
     the error says so; a retry completes.
  E. The role-change hook reports a failed clear and audits it.

Merged tree (P1 decision 1, WP-B): the personal Firebase login is NEVER disabled by a
staff deactivation — it is the person's own Zipper app account. Every "login disabled"
expectation of the rc2 version is inverted here: `set_user_disabled` stays installed as
a tripwire that must never fire, and a Firebase outage (A1) is irrelevant to the result.
A repeat of a COMPLETE deactivation is refused ("already deactivated") by the P1-B3
status model; only an incomplete one may be run again.

Run:  python3 -m tests.test_p2_owner_deactivate_rev4
"""


from __future__ import annotations

import asyncio
import base64 as _b64
import hashlib
import hmac
import json as _json
import re
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

# A real (minimal) HS256 so API sessions round-trip, as in the other MFA tests.
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

# ── The audit log, with failure injection by action ─────────────────────────────────────────────
audit_log: list[dict] = []
FAIL_AUDIT: set[str] = set()


async def fake_record(**kw):
    if kw.get("action") in FAIL_AUDIT:
        raise RuntimeError("audit insert failed (simulated)")
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record
from app.services import email as email_mod  # noqa: E402
from app.services import notices as notices_mod  # noqa: E402


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
CLAIMS_CLEARED: list[str] = []
CRM_ACTIVE: dict[str, bool] = {}
CRM_FAIL = {"on": False}


def doc(uid: str) -> dict:
    snap = fs.collection(mfa.SESSIONS_COLLECTION).document(uid).get()
    return (snap.to_dict() or {}) if snap.exists else {}


FB_FAIL = {"on": False}
CLAIM_FAIL = {"on": False}


def fake_set_user_disabled(uid: str, disabled: bool):
    DISABLED[uid] = disabled
    if FB_FAIL["on"]:
        return "The Firebase login could not be disabled: quota exceeded (simulated)"
    return ""


def fake_claims_clear(uid: str):
    if CLAIM_FAIL["on"]:
        return "could not clear the Storage role claim (simulated)"
    CLAIMS_CLEARED.append(uid)
    return ""


async def fake_crm_set_active(**kw):
    if CRM_FAIL["on"]:
        raise svc.crm.DirectoryError("crmUsers write refused (simulated)")
    CRM_ACTIVE[kw["uid"]] = kw["is_active"]
    return types.SimpleNamespace(action="updated")


svc.firebase.set_user_disabled = fake_set_user_disabled
svc.storage_claims.clear = fake_claims_clear
svc.crm.aset_active = fake_crm_set_active

# ── Firebase ID tokens and custom tokens, faked as in the binding test ───────────────────────────
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


def attempt(c):
    """(result, None) or (None, the exception) — the caller of deactivate() sees exactly this."""
    try:
        return run(c), None
    except Exception as exc:  # noqa: BLE001
        return None, exc


def fb_token(name: str, uid: str, auth_time: int, provider: str, **extra) -> str:
    FIREBASE[name] = {"uid": uid, "auth_time": auth_time, "firebase": {"sign_in_provider": provider}, **extra}
    return name


def redeem(custom_token: str, auth_time: int, name: str) -> str:
    uid, sid = custom_token.removeprefix("CUSTOM-TOKEN-").split("-", 1)
    return fb_token(name, uid, auth_time, "custom", mfa_sid=sid)


def verified_session(uid: str):
    tok, exp = run(security.issue_session(uid=uid, email=f"{uid}@x.test", name=uid, role=Role.OWNER, mfa_verified=True))
    claims = run(security.verify_session(tok))
    user = {"uid": uid, "email": f"{uid}@x.test", "name": uid, "role": Role.OWNER, "jti": claims["jti"],
            "mfa_verified": True}
    return user, exp, tok


def sid_of(user: dict) -> str:
    return str(run(db[C.SESSIONS].find_one({"jti": user["jti"]})).get("mfa_binding_id") or "")


def bind(uid: str, auth_time: int, name: str, client: str = "crm", confirm: bool = True):
    """An MFA sign-in: mint for a verified API session, redeem, (confirm). Returns (user, sid, ID token, API token)."""
    user, exp, api_tok = verified_session(uid)
    run(mfa.mint_owner_session(user, fb_token(f"pw-{name}", uid, auth_time, "password"), api_jti=user["jti"],
                               api_expires=exp, client=client))
    sid = sid_of(user)
    tok = redeem(f"CUSTOM-TOKEN-{uid}-{sid}", auth_time + 1, name)
    if confirm:
        run(mfa.confirm_owner_session(user, tok))
    return user, sid, tok, api_tok


def rules_owner_ok(uid: str, token: str) -> bool:
    """firestore.rules ownerMfaOk() + ownerMfaBindingLive(), evaluated on the stored document."""
    from datetime import datetime, timezone
    t = FIREBASE[token]
    sid = t.get("mfa_sid", "")
    b = doc(uid).get("bindings", {}).get(sid, {})
    exp = b.get("expiresAt")
    return (isinstance(sid, str) and sid != "" and t["firebase"]["sign_in_provider"] == "custom"
            and b.get("state") == "active" and b.get("authTime", -1) == t.get("auth_time", -2)
            and exp is not None and exp > datetime.now(timezone.utc))


def sign_in(uid: str):
    """What POST /auth/signin does with a valid Firebase ID token for `uid`: (session, None) or (None, error)."""
    fb.verify_id_token = lambda _t: {"uid": uid, "email": f"{uid}@x.test", "email_verified": True,
                                     "firebase": {"sign_in_provider": "password"}}
    return attempt(security.sign_in_with_firebase("an-id-token"))


def api_session_works(api_tok: str) -> bool:
    return attempt(security.verify_session(api_tok))[1] is None


def staff(uid: str) -> dict:
    return run(db[C.STAFF].find_one({"uid": uid})) or {}


def entries(action: str, uid: str) -> list[dict]:
    return [e for e in audit_log if e.get("action") == action and e.get("subject_id") == uid]


OBSERVER = {"uid": "obs1", "email": "obs@x.test", "name": "Observer", "role": Role.OBSERVER}
OWNER2 = {"uid": "own2", "email": "own2@x.test", "name": "own2", "role": Role.OWNER}
UNBOUND, DEACTIVATED = audit_mod.Action.OWNER_MFA_UNBOUND, audit_mod.Action.STAFF_DEACTIVATED


def add_staff(uid: str, role: str, **extra) -> None:
    run(db[C.STAFF].insert_one({"uid": uid, "role": role, "email": f"{uid}@x.test", "name": uid,
                                "is_active": True, **extra}))


# Exactly TWO active Owners: the case where the old count refused a second run.
add_staff("obs1", "observer")



def last_entry(action: str, uid: str) -> dict:
    found = entries(action, uid)
    return found[-1] if found else {}


INCOMPLETE = getattr(audit_mod.Action, "STAFF_REVOCATION_INCOMPLETE", "staff.revocation_incomplete")
UNBIND_FAILED = getattr(audit_mod.Action, "OWNER_MFA_UNBIND_FAILED", "owner_mfa.unbind_failed")
LOCKS = getattr(svc, "STAFF_LOCKS", "staff_locks")
svc._OWNER_LEASE_WAIT = (0.01, 5)   # keep a refused wait short in this test


def lease_doc():
    return run(db[LOCKS].find_one({"_id": "owner-deactivation"}))


def incomplete_error(err, *needles) -> bool:
    """A StaffError that says NOT complete, says to run it again, and names each needle."""
    s = str(err or "")
    return (isinstance(err, svc.StaffError) and "NOT complete" in s and "run the deactivation again" in s
            and all(n in s for n in needles))


successes: list[dict] = []


def deact(uid, actor, reason):
    res, err = attempt(svc.deactivate(uid, actor, reason))
    if res is not None:
        successes.append(res)
    return res, err


for u in ("own1", "own2", "own3", "own4", "own5", "own6"):
    add_staff(u, "owner")
add_staff("tech1", "tech_admin", dept="tech")
add_staff("tech2", "tech_admin", dept="tech")

# ── A. R1: an incomplete revocation is an error, never a 200 ─────────────────────────────────────
# A1. Decision 1: Firebase is down — and it does not matter, because a staff deactivation
# never touches the personal login (non-Owner, deactivated by an Owner).
tech1_tok, _ = run(security.issue_session(uid="tech1", email="tech1@x.test", name="tech1", role=Role.TECH_ADMIN))
FB_FAIL["on"] = True
res, err = deact("tech1", OWNER2, "Moved on.")
FB_FAIL["on"] = False
ok("A1a a Firebase outage cannot make a deactivation incomplete: it completes (decision 1)",
   err is None and res.get("fully_revoked") is True and res.get("personal_app_account") == "unchanged"
   and "firebase_login" not in res)
ok("A1b everything that carries staff access went: sessions revoked, inactive, CRM off, claim cleared",
   not api_session_works(tech1_tok) and staff("tech1").get("is_active") is False and CRM_ACTIVE.get("tech1") is False
   and "tech1" in CLAIMS_CLEARED)
ok("A1c the login was never touched and nothing about it is audited",
   "tech1" not in DISABLED and entries(INCOMPLETE, "tech1") == []
   and entries(audit_mod.Action.STAFF_FIREBASE_REVOKE_FAILED, "tech1") == [])
n_log = len(audit_log)
res, err = deact("tech1", OWNER2, "Repeated by mistake.")
ok("A1d a repeat of a complete deactivation is refused (already deactivated) and changes nothing",
   res is None and isinstance(err, svc.StaffError) and "already deactivated" in str(err) and len(audit_log) == n_log)

# A2. The storage claim cannot be cleared.
CLAIM_FAIL["on"] = True
res, err = deact("tech2", OWNER2, "Moved on.")
CLAIM_FAIL["on"] = False
ok("A2a a storage-claim failure is an error naming it", res is None and incomplete_error(err, "storage role claim was NOT cleared"))
ok("A2b the rest happened (login untouched)", staff("tech2").get("is_active") is False and "tech2" not in DISABLED and CRM_ACTIVE.get("tech2") is False)
res, err = deact("tech2", OWNER2, "Retry: claims were down.")
ok("A2c a retry finishes it", err is None and res.get("fully_revoked") is True and "tech2" in CLAIMS_CLEARED)

# A3. An Owner's MFA bindings cannot be removed (Firestore down).
_, _, own1_tok, own1_api = bind("own1", 1000, "id-own1")
real_mutate = mfa._mutate


def broken_mutate(uid, change):
    raise RuntimeError("Firestore unavailable (simulated)")


mfa._mutate = broken_mutate
res, err = deact("own1", OBSERVER, "Leaving.")
mfa._mutate = real_mutate
ok("A3a a binding failure is an error naming it", res is None and incomplete_error(err, "MFA bindings were NOT removed"))
ok("A3b and it is audited (owner_mfa.unbind_failed), not only logged", bool(entries(UNBIND_FAILED, "own1"))
   and entries(UNBOUND, "own1") == [])
ok("A3c the rest happened (login untouched)", staff("own1").get("is_active") is False and "own1" not in DISABLED
   and CRM_ACTIVE.get("own1") is False and "own1" in CLAIMS_CLEARED and not api_session_works(own1_api))
res, err = deact("own1", OBSERVER, "Retry: Firestore was down.")
ok("A3d a retry removes the bindings and only then reports success", err is None and res.get("fully_revoked") is True
   and doc("own1") == {} and not rules_owner_ok("own1", own1_tok) and len(entries(UNBOUND, "own1")) == 1)

# ── B. R2: a CRM failure finishes the rest and names the real fix ───────────────────────────────
add_staff("tech3", "tech_admin", dept="tech")
CRM_FAIL["on"] = True
res, err = deact("tech3", OWNER2, "Moved on.")
CRM_FAIL["on"] = False
ok("B1a a CRM failure is an error naming the CRM entry", res is None and incomplete_error(err, "CRM directory entry was NOT switched off"))
ok("B1b the storage claim is cleared all the same (it used to be skipped)", "tech3" in CLAIMS_CLEARED)
ok("B1c the message no longer says nothing else was changed", "Nothing else was changed" not in str(err))
ok("B1d the divergence is audited (staff.mirror_failed)", bool(entries(audit_mod.Action.STAFF_MIRROR_FAILED, "tech3")))
res, err = deact("tech3", OWNER2, "Retry: the directory was down.")
ok("B1e running it again switches the CRM entry off and completes", err is None and res.get("fully_revoked") is True
   and CRM_ACTIVE.get("tech3") is False)

add_staff("tech4", "tech_admin", dept="tech")
CRM_FAIL["on"] = True
FAIL_AUDIT.add(audit_mod.Action.STAFF_MIRROR_FAILED)
res, err = deact("tech4", OWNER2, "Moved on.")
FAIL_AUDIT.clear()
CRM_FAIL["on"] = False
ok("B2a a CRM failure whose own audit entry also fails is a StaffError (HTTP 400), not a 500",
   res is None and isinstance(err, svc.StaffError) and incomplete_error(err, "CRM directory entry was NOT switched off"))
ok("B2b and the claim is still cleared (login untouched)", "tech4" in CLAIMS_CLEARED and "tech4" not in DISABLED)

# ── C. R3: the last two active Owners, deactivated at the same moment ────────────────────────────
# Active Owners now: own2..own6 (own1 is inactive). Leave exactly two active: own5 and own6.
for u in ("own2", "own3", "own4"):
    run(db[C.STAFF].update_one({"uid": u}, {"$set": {"is_active": False}}))
_, _, own5_tok, own5_api = bind("own5", 5000, "id-own5")
_, _, own6_tok, own6_api = bind("own6", 6000, "id-own6")


async def both():
    return await asyncio.gather(svc.deactivate("own5", OBSERVER, "Leaving (A)."),
                                svc.deactivate("own6", OBSERVER, "Leaving (B)."), return_exceptions=True)


n_log = len(audit_log)
outcome = run(both())
won = [o for o in outcome if isinstance(o, dict)]
lost = [o for o in outcome if isinstance(o, Exception)]
active_left = [u for u in ("own5", "own6") if staff(u).get("is_active") is True]
ok("C1 one of two simultaneous deactivations succeeds and one is refused", len(won) == 1 and len(lost) == 1)
ok("C2 the refusal is the last-active-owner rule", bool(lost) and "last active owner" in str(lost[0]))
ok("C3 an active Owner is left", len(active_left) == 1)
survivor = active_left[0] if active_left else "own6"
ok("C4 and the refused one changed nothing: sessions live, binding intact, login untouched, no audit entry",
   api_session_works(own5_api if survivor == "own5" else own6_api)
   and rules_owner_ok(survivor, own5_tok if survivor == "own5" else own6_tok)
   and survivor not in DISABLED and not any(e.get("subject_id") == survivor for e in audit_log[n_log:]))
ok("C5 the lease is given back", lease_doc() is None)

# A lease left by a process that died is taken over; a live one held by somebody else refuses.
from datetime import datetime, timedelta, timezone  # noqa: E402

add_staff("own7", "owner")
add_staff("own8", "owner")
run(db[LOCKS].insert_one({"_id": "owner-deactivation", "holder": "dead-process",
                          "expires_at": datetime.now(timezone.utc) - timedelta(seconds=5)}))
res, err = deact("own7", OBSERVER, "Leaving.")
ok("C6 a stale lease (its holder died) is taken over and the deactivation completes",
   err is None and res.get("fully_revoked") is True and lease_doc() is None)
run(db[LOCKS].delete_one({"_id": "owner-deactivation"}))   # whatever an older revision left behind
run(db[LOCKS].insert_one({"_id": "owner-deactivation", "holder": "another-request",
                          "expires_at": datetime.now(timezone.utc) + timedelta(seconds=60)}))
n_log = len(audit_log)
res, err = deact("own8", OBSERVER, "Leaving.")
ok("C7 a live lease held by another request refuses, saying nothing was changed",
   res is None and isinstance(err, svc.StaffError) and "in progress" in str(err) and "Nothing was changed" in str(err))
ok("C8 and nothing was changed", staff("own8").get("is_active") is True and "own8" not in DISABLED
   and len(audit_log) == n_log and (lease_doc() or {}).get("holder") == "another-request")
run(db[LOCKS].delete_one({"_id": "owner-deactivation", "holder": "another-request"}))

# ── D. R4: the is_active write fails ─────────────────────────────────────────────────────────────
add_staff("tech5", "tech_admin", dept="tech")
tech5_tok, _ = run(security.issue_session(uid="tech5", email="tech5@x.test", name="tech5", role=Role.TECH_ADMIN))
staff_coll = db[C.STAFF]
real_update_one = staff_coll.update_one


async def failing_update_one(query, update, *a, **k):
    if query.get("uid") == "tech5" and (update.get("$set") or {}).get("is_active") is False:
        raise RuntimeError("Mongo write failed (simulated)")
    return await real_update_one(query, update, *a, **k)


staff_coll.update_one = failing_update_one
res, err = deact("tech5", OWNER2, "Moved on.")
staff_coll.update_one = real_update_one
ok("D1 an is_active write failure is a StaffError naming it, not a 500",
   res is None and incomplete_error(err, "staff record was NOT marked inactive"))
ok("D2 the CRM entry is still switched off, the claim cleared, sessions revoked (login untouched)",
   "tech5" not in DISABLED and CRM_ACTIVE.get("tech5") is False and "tech5" in CLAIMS_CLEARED
   and not api_session_works(tech5_tok))
ok("D3 the audit entry does not claim the record was written",
   (last_entry(DEACTIVATED, "tech5").get("after") or {}).get("is_active") == "NOT WRITTEN")
res, err = deact("tech5", OWNER2, "Retry: Mongo was down.")
ok("D4 a retry completes", err is None and res.get("fully_revoked") is True and staff("tech5").get("is_active") is False)
ok("D5 and leaves no retry marker on the row", not staff("tech5").get(svc.OUTSTANDING_FIELD))

# ── E. The role-change hook reports a failed clear ───────────────────────────────────────────────
hook = getattr(svc, "_clear_owner_bindings_on_role_change", None)
ok("E0 the role-change hook is a reporting helper", callable(hook))
if callable(hook):
    _, _, own2_tok2, _ = bind("own2", 7000, "id-own2-rolechange")
    ok("E1 not a former Owner: nothing to do", run(hook("tech1", "tech_admin", OWNER2)) is None)
    mfa._mutate = broken_mutate
    problem = run(hook("own2", "owner", OWNER2))
    mfa._mutate = real_mutate
    ok("E2 a failed clear is reported, never ignored", bool(problem) and "NOT removed" in str(problem))
    ok("E3 and audited", bool(entries(UNBIND_FAILED, "own2")))
    ok("E4 a successful clear returns None and is audited", run(hook("own2", "owner", OWNER2)) is None
       and doc("own2") == {} and bool(entries(UNBOUND, "own2")))
src = (ROOT / "app" / "services" / "staff.py").read_text()
role_body = src[src.find("async def change_role("):src.find("async def _clear_owner_bindings_on_role_change(")]
ok("E5 change_role uses the reporting helper and raises when it reports a problem",
   "_clear_owner_bindings_on_role_change(uid, str(old_role), actor)" in role_body
   and "if owner_bindings_problem is not None:" in role_body)

# ── F. Every success was complete; no token in the audit log ─────────────────────────────────────
ok("F1 every deactivation that returned (HTTP 200) reported fully_revoked: true",
   bool(successes) and all(r.get("fully_revoked") is True for r in successes))
blob = repr(audit_log)
ok("F2 no audit entry carries a custom token", "CUSTOM-TOKEN" not in blob)
body_src = src[src.find("async def deactivate("):src.find("async def team_overview(")]
i_lease, i_count = body_src.find("_take_owner_lease(db)"), body_src.find("active_owners = await")
i_release, i_crm = body_src.find("_give_back_owner_lease(db, lease)"), body_src.find("crm.aset_active(")
ok("F3 the lease is taken before the last-owner count and given back before the CRM step",
   -1 not in (i_lease, i_count, i_release, i_crm) and i_lease < i_count < i_release < i_crm)
ok("F4 decision 1: the deactivation path never disables the Firebase login, and the tripwire never fired",
   "set_user_disabled" not in body_src and "revoke_refresh_tokens" not in body_src and DISABLED == {})

if failures:
    print(f"{len(failures)} of {checks} revision 4 deactivation checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} revision 4 deactivation checks passed.")
