"""P2 (MFA release, revision 3): a deactivation whose audit write fails is still a
deactivation, is never reported as complete, and can be run again.

Revision 2 cleared an Owner's MFA bindings early and wrote their audit entry at the
same point, before the staff record, the Firebase login and the CRM directory
were touched. A failed audit write there raised out of `deactivate()` with the
API sessions revoked and the bindings gone, but the account still active, the
login still enabled and the CRM directory still open: the Owner could simply sign
in again. And because `deactivate()` counted the target among the active Owners,
running it again after a failure that HAD marked the account inactive was refused
as "the last active owner" whenever only one other Owner was active.

What this checks, with failures injected into the audit log, Firestore and the
CRM directory:
  1. A failed audit write (the MFA binding removal, or the deactivation itself)
     no longer stops the revocation: sessions revoked, bindings deleted, account
     inactive, CRM entry off, storage claim cleared, and sign-in refused. The
     caller gets an error naming what was not recorded; nothing reports the
     deactivation as complete.
  2. Running it again after that partial failure is accepted (one other Owner
     active), completes, and records what was missing.
  3. A repeat of a COMPLETE deactivation is refused as "already deactivated" and
     changes nothing (merged tree: the P1-B3 status model decides; rc2 accepted and
     re-audited a repeat — see the note below).
  4. Every MFA binding (CRM, Android, minted-but-unconfirmed) is removed before
     the staff record is marked inactive, and none can be confirmed afterwards.
  5. Existing guarantees hold: Owners are removed by the Observer only, never the
     last active Owner (and a refusal changes nothing), non-Owners never touch MFA
     bindings, a Firestore failure is reported, a CRM failure is still raised, and
     no audit entry carries a token.

Merged tree (P1 decision 1, WP-B): the personal Firebase login is NEVER disabled by
a staff deactivation — it is the person's own Zipper app account. Every "login
disabled" expectation of the rc2 version is inverted here: `set_user_disabled` stays
installed as a tripwire that must never fire. The `before` of a `staff.deactivated`
entry carries the P1-B3 `status` as well as `is_active`.

Run:  python3 -m tests.test_p2_owner_deactivate_failure_paths
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
#: The Owner's bindings at the moment the staff record is marked inactive.
BINDINGS_AT_INACTIVE: dict[str, dict] = {}
CLAIMS_CLEARED: list[str] = []
CRM_ACTIVE: dict[str, bool] = {}
CRM_FAIL = {"on": False}


def doc(uid: str) -> dict:
    snap = fs.collection(mfa.SESSIONS_COLLECTION).document(uid).get()
    return (snap.to_dict() or {}) if snap.exists else {}


def fake_set_user_disabled(uid: str, disabled: bool):
    DISABLED[uid] = disabled
    return ""


_real_staff_update_one = db[C.STAFF].update_one


async def observing_staff_update_one(query, update, *a, **k):
    if query.get("uid") and (update.get("$set") or {}).get("is_active") is False:
        BINDINGS_AT_INACTIVE[query["uid"]] = dict(doc(query["uid"]).get("bindings", {}))
    return await _real_staff_update_one(query, update, *a, **k)


db[C.STAFF].update_one = observing_staff_update_one


def fake_claims_clear(uid: str):
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
add_staff("own1", "owner")
add_staff("own2", "owner")
add_staff("tech1", "tech_admin", dept="tech")
add_staff("obs1", "observer")

# ── 1. An audit write that fails does not stop the revocation ─────────────────────────────────────
crm_user, crm_sid, crm_tok, crm_api = bind("own1", 1000, "id-crm")
and_user, and_sid, and_tok, and_api = bind("own1", 2000, "id-android", client="android")
own2_user, own2_sid, own2_tok, own2_api = bind("own2", 3000, "id-own2")
ok("precondition: own1 is bound on CRM and Android and can sign in",
   rules_owner_ok("own1", crm_tok) and rules_owner_ok("own1", and_tok) and sign_in("own1")[1] is None)

FAIL_AUDIT.add(UNBOUND)
res, err = attempt(svc.deactivate("own1", OBSERVER, "Left the company; handover complete."))
FAIL_AUDIT.clear()
msg = str(err or "")
ok("1a the caller gets an error, not a deactivation report", res is None and isinstance(err, svc.StaffError))
ok("1b the error names the audit entry that is missing", "Owner MFA binding removal" in msg)
ok("1c and says the deactivation is NOT complete and must be run again",
   "NOT complete" in msg and "run the deactivation again" in msg)
ok("1d the original failure is chained, not dropped", isinstance(getattr(err, "__cause__", None), RuntimeError))
ok("1e every API session of the Owner is revoked", not api_session_works(crm_api) and not api_session_works(and_api))
ok("1f every MFA binding is deleted (CRM and Android)", doc("own1").get("bindings", {}) == {})
ok("1g the custom-token sessions no longer pass the rules' Owner check",
   not rules_owner_ok("own1", crm_tok) and not rules_owner_ok("own1", and_tok))
ok("1h the bindings were already gone when the staff record was marked inactive", BINDINGS_AT_INACTIVE.get("own1") == {})
ok("1i the staff record is inactive, status deactivated", staff("own1").get("is_active") is False
   and staff("own1").get("status") == "deactivated")
ok("1j decision 1: the personal Firebase login is NOT disabled", "own1" not in DISABLED)
ok("1k the CRM directory entry is switched off", CRM_ACTIVE.get("own1") is False)
ok("1l the storage role claim is cleared", "own1" in CLAIMS_CLEARED)
ok("1m the deactivation itself is audited, by the Observer, with its reason",
   any(e["actor"]["uid"] == "obs1" and e["reason"] == "Left the company; handover complete."
       for e in entries(DEACTIVATED, "own1")))
ok("1n nothing claims the binding removal was recorded", entries(UNBOUND, "own1") == [])
ok("1o a new sign-in is refused: the account is deactivated",
   (lambda r: r[0] is None and "deactivated" in str(r[1]))(sign_in("own1")))
ok("1p the other Owner is untouched", staff("own2").get("is_active") is True and rules_owner_ok("own2", own2_tok)
   and api_session_works(own2_api))

# ── 2. Running it again after the partial failure (own2 is the only other active Owner) ──────────
before_unbound = len(entries(UNBOUND, "own1"))
res, err = attempt(svc.deactivate("own1", OBSERVER, "Retry: the audit log was unavailable."))
ok("2a the retry is accepted, not refused as 'the last active owner'", err is None)
ok("2b and reports a complete revocation", bool(res) and res.get("fully_revoked") is True
   and res.get("owner_mfa_bindings") == "cleared")
ok("2c the binding removal is now recorded, once", len(entries(UNBOUND, "own1")) == before_unbound + 1)
last = entries(DEACTIVATED, "own1")[-1]
ok("2d the retry's staff.deactivated entry records the state it found (already inactive, deactivated)",
   (last.get("before") or {}).get("is_active") is False and (last.get("before") or {}).get("status") == "deactivated"
   and last.get("reason") == "Retry: the audit log was unavailable." and (last.get("meta") or {}).get("retry") is True)
ok("2e the other Owner is still untouched", staff("own2").get("is_active") is True and rules_owner_ok("own2", own2_tok))

# ── 3. A repeat of a COMPLETE deactivation is refused; the last active Owner stays protected ─────
#
# rc2 accepted the repeat (no status model) and audited it again. In the merged
# tree the P1-B3 status model decides: a deactivated account cannot be deactivated
# again ("already deactivated"), and only a revocation that reported itself
# incomplete (`revocation_outstanding` on the row) may be run again — which is
# what part 2 above exercised.
n_log = len(audit_log)
res, err = attempt(svc.deactivate("own1", OBSERVER, "Repeated by mistake."))
ok("3a a repeat of a complete deactivation is refused, saying it is already deactivated",
   res is None and isinstance(err, svc.StaffError) and "already deactivated" in str(err))
ok("3b nothing is brought back and nothing is touched: inactive, login untouched, no binding document",
   staff("own1").get("is_active") is False and "own1" not in DISABLED and doc("own1") == {})
ok("3c the refusal writes no audit entry", len(audit_log) == n_log)

n_log = len(audit_log)
res, err = attempt(svc.deactivate("own2", OBSERVER, "Leaving the business."))
ok("3d the LAST active Owner cannot be deactivated", res is None and "last active owner" in str(err))
ok("3e and the refusal changes nothing: active, sessions live, binding intact, login untouched, no audit",
   staff("own2").get("is_active") is True and api_session_works(own2_api) and rules_owner_ok("own2", own2_tok)
   and "own2" not in DISABLED and len(audit_log) == n_log)

# ── 4. Active MFA binding cleanup: every binding, before the record is marked inactive ──────────
add_staff("own3", "owner")                                  # so that own2 is no longer the last
own2_and_user, _, own2_and_tok, _ = bind("own2", 3100, "id-own2-android", client="android")
pending_user, pending_sid, pending_tok, _ = bind("own2", 3200, "id-own2-pending", confirm=False)
ok("precondition: own2 holds two active bindings and one minted, unconfirmed",
   len(doc("own2").get("bindings", {})) == 3 and rules_owner_ok("own2", own2_tok) and rules_owner_ok("own2", own2_and_tok)
   and not rules_owner_ok("own2", pending_tok))
res, err = attempt(svc.deactivate("own2", OBSERVER, "Leaving the business."))
ok("4a the deactivation completes", err is None and res.get("fully_revoked") is True and res.get("owner_mfa_bindings") == "cleared")
ok("4b every binding is removed, including the minted one", doc("own2") == {})
ok("4c and they were gone before the staff record was marked inactive", BINDINGS_AT_INACTIVE.get("own2") == {})
r = run(mfa.confirm_owner_session(pending_user, pending_tok))
ok("4d the minted binding can no longer be confirmed", r.get("state") != "bound" and doc("own2") == {})
ok("4e no rules check passes for any of own2's Firebase sessions",
   not any(rules_owner_ok("own2", t) for t in (own2_tok, own2_and_tok, pending_tok)))
ok("4f the removal is audited, by the Observer", any(e["actor"]["uid"] == "obs1" and (e.get("meta") or {}).get("all")
                                                        for e in entries(UNBOUND, "own2")))

# ── 5. A Firestore failure in the cleanup is reported, not hidden; a retry clears ────────────────
add_staff("own4", "owner")
_, _, own3_tok, _ = bind("own3", 4000, "id-own3")
real_mutate = mfa._mutate


def broken_mutate(uid, change):
    raise RuntimeError("Firestore unavailable (simulated)")


mfa._mutate = broken_mutate
res, err = attempt(svc.deactivate("own3", OBSERVER, "Second Owner leaves."))
mfa._mutate = real_mutate
ok("5a a failed clear is an error naming the bindings, never a success (revision 4)",
   res is None and isinstance(err, svc.StaffError) and "MFA bindings were NOT removed" in str(err)
   and "run the deactivation again" in str(err))
ok("5b nothing claims the bindings were removed", entries(UNBOUND, "own3") == [])
ok("5c the rest of the revocation still happened (login untouched)",
   staff("own3").get("is_active") is False and "own3" not in DISABLED and CRM_ACTIVE.get("own3") is False
   and "own3" in CLAIMS_CLEARED)
res, err = attempt(svc.deactivate("own3", OBSERVER, "Retry: Firestore was unavailable."))
ok("5d running it again clears and records them", err is None and res.get("owner_mfa_bindings") == "cleared"
   and doc("own3") == {} and not rules_owner_ok("own3", own3_tok) and len(entries(UNBOUND, "own3")) == 1)

# ── 6. A failed staff.deactivated write cannot stop it either (non-Owner and Owner) ──────────────
tech_tok, _ = run(security.issue_session(uid="tech1", email="tech1@x.test", name="tech1", role=Role.TECH_ADMIN))
FAIL_AUDIT.add(DEACTIVATED)
res, err = attempt(svc.deactivate("tech1", OWNER2, "Moved to another company."))
FAIL_AUDIT.clear()
ok("6a a non-Owner whose deactivation entry fails: error, naming the missing entry",
   res is None and isinstance(err, svc.StaffError) and "deactivation (RuntimeError)" in str(err))
ok("6b and the revocation is complete underneath it (login untouched)",
   staff("tech1").get("is_active") is False and "tech1" not in DISABLED and CRM_ACTIVE.get("tech1") is False
   and "tech1" in CLAIMS_CLEARED and not api_session_works(tech_tok))
ok("6c a non-Owner never touches Owner MFA bindings", entries(UNBOUND, "tech1") == [])
res, err = attempt(svc.deactivate("tech1", OWNER2, "Retry after the audit failure."))
ok("6d the retry records it (before: inactive, deactivated)", err is None
   and entries(DEACTIVATED, "tech1")[-1]["before"] == {"status": "deactivated", "is_active": False}
   and res.get("owner_mfa_bindings") == "n/a")

add_staff("own5", "owner")
_, _, own4_tok, _ = bind("own4", 5000, "id-own4")
FAIL_AUDIT.update({DEACTIVATED, UNBOUND})
res, err = attempt(svc.deactivate("own4", OBSERVER, "Leaving."))
FAIL_AUDIT.clear()
ok("6e an Owner whose two entries both fail: one error naming both",
   isinstance(err, svc.StaffError) and "Owner MFA binding removal" in str(err) and "deactivation (RuntimeError)" in str(err))
ok("6f and still: inactive, login untouched, CRM off, claim cleared, bindings gone, sign-in refused",
   staff("own4").get("is_active") is False and "own4" not in DISABLED and CRM_ACTIVE.get("own4") is False
   and "own4" in CLAIMS_CLEARED and doc("own4") == {} and not rules_owner_ok("own4", own4_tok)
   and sign_in("own4")[0] is None)

# ── 7. A CRM directory failure is still raised; a missing audit entry is named in the same error ──
add_staff("own6", "owner")
CRM_FAIL["on"] = True
FAIL_AUDIT.add(UNBOUND)
res, err = attempt(svc.deactivate("own5", OBSERVER, "Leaving."))
FAIL_AUDIT.clear()
CRM_FAIL["on"] = False
ok("7a the CRM failure still reaches the caller, naming the step and the fix that works for it",
   isinstance(err, svc.StaffError) and "CRM directory entry was NOT switched off" in str(err)
   and "run the deactivation again" in str(err) and "Nothing else was changed" not in str(err))
ok("7b and the missing audit entry is named in the same error", "Owner MFA binding removal" in str(err))
ok("7c the security half is done: inactive (login untouched)", staff("own5").get("is_active") is False
   and "own5" not in DISABLED)
ok("7d the divergence is audited (staff.mirror_failed)",
   bool(entries(audit_mod.Action.STAFF_MIRROR_FAILED, "own5")))

# ── 8. Authorization guarantees ──────────────────────────────────────────────────────────────────
n_log = len(audit_log)
res, err = attempt(svc.deactivate("own6", OWNER2, "Disagreement."))
ok("8a an Owner cannot deactivate another Owner, and nothing changes",
   isinstance(err, svc.StaffError) and staff("own6").get("is_active") is True and len(audit_log) == n_log)
res, err = attempt(svc.deactivate("own6", {"uid": "ops-admin", "role": Role.OPS_ADMIN}, "x x x x"))
ok("8b a department admin cannot deactivate an Owner", isinstance(err, svc.StaffError) and staff("own6").get("is_active") is True)
res, err = attempt(svc.deactivate("obs1", OWNER2, "Rotate the observer."))
ok("8c nobody deactivates the Observer", isinstance(err, svc.StaffError))
res, err = attempt(svc.deactivate("own6", OBSERVER, "   "))
ok("8d a reason is required", isinstance(err, svc.StaffError) and staff("own6").get("is_active") is True)
blob = repr(audit_log)
issued = [t for t in FIREBASE]
ok("8e no audit entry carries a custom token or an ID token",
   "CUSTOM-TOKEN" not in blob and not any(re.search(r"(?<![A-Za-z0-9_-])" + re.escape(t) + r"(?![A-Za-z0-9_-])", blob)
                                          for t in issued))
ok("8f no audit entry carries a full binding id", not any(s and s in blob for s in (crm_sid, and_sid, own2_sid, pending_sid)))
ok("8g every entry written by a deactivation names its actor and a reason",
   all(e.get("actor", {}).get("uid") and str(e.get("reason", "")).strip()
       for e in audit_log if e.get("action") in (UNBOUND, DEACTIVATED)))

# ── 9. Wiring (source pins) ──────────────────────────────────────────────────────────────────────
src = (ROOT / "app" / "services" / "staff.py").read_text()
body = src[src.find("async def deactivate("):src.find("async def team_overview(")]
_clear_call = re.search(r"clear_all_bindings\(uid, [^)]*\)", body)
ok("9a the early cleanup does not audit inside it (no actor passed)",
   _clear_call is not None and "actor" not in _clear_call.group(0)
   and '"Owner deactivated"' in body and "actor=actor)" not in body[_clear_call.start():_clear_call.end()])
ok("9e decision 1: the deactivation path never disables the Firebase login, and the tripwire never fired",
   "set_user_disabled" not in body and "revoke_refresh_tokens" not in body and DISABLED == {})
ok("9b every audit write of deactivate() goes through the collecting `record`",
   body.count("await audit.record(") == 1 and "await audit.record(**entry)" in body)
i_claims, i_raise = body.find("storage_claims.clear"), body.find("if not_done or audit_failures:\n        cause = ")
ok("9c a missing audit entry is raised only after the last revocation step", -1 not in (i_claims, i_raise) and i_claims < i_raise)
ok("9d the last-owner count subtracts the target only while it is active",
   'active_owners - (1 if person.get("is_active", True) else 0) < 1' in body)

if failures:
    print(f"{len(failures)} of {checks} deactivation failure-path checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} deactivation failure-path checks passed.")
