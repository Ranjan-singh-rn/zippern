"""B3 / spec §13 — the session rules, as properties.

  * `security.revoke_sessions_for_uid(uid, reason, *, actor, keep_jti, mobile)`
    is the one helper every revocation shares: it ends every live API session
    of one person (except the kept one), takes the Owner's Firestore/Storage
    MFA bindings with them, and — for a restriction, a ban or a security reset
    (`mobile=True`) — revokes the Firebase refresh tokens and deletes the
    quick-login credentials. It never raises for a downstream failure: what
    did not happen is in `problems`, and the audit row carries the counts.
  * B-21: `GET /auth/sessions` lists the caller's live sessions (client,
    address, user agent, when; fingerprints only) and
    `POST /auth/sessions/revoke-all` is "sign out everywhere (else)". Both are
    self-scoped and reachable by a partner; neither by a pending Owner or
    Observer session. The seven-day token and three-day grace are untouched.
  * B-18: `require_owner` re-reads the role on record before an Owner money
    action, exactly as `require_permission` does.
  * Restriction, ban, role revocation and the Observer's MFA reset revoke what
    they must (asserted against the source where the writer is another
    module), and the mobile quick-login credential is 30 days, Keystore-bound,
    versioned, revocable and honoured only while unrevoked (Functions source).

Run:  python3 -B -m tests.test_session_rules
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import re
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, Request, install_stubs  # noqa: E402

install_stubs()

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

db = FakeDb()
security.get_db = lambda: db
mfa.get_db = lambda: db
import app.db.mongo as mongo_mod  # noqa: E402

mongo_mod.get_db = lambda: db
account_state._read_app_account = lambda uid: None
settings.jwt_secret = "x" * 40
settings.auth_state_recheck_seconds = 0
settings.owner_mfa_required = True

audit_log: list[dict] = []


async def fake_record(**kw):
    audit_log.append(kw)
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record

#: What the Firebase side was asked to do — recorded, and made to fail on demand.
mobile_calls: list[tuple[str, str]] = []
mobile_problem: dict[str, str] = {"firebase": "", "quick_login": ""}
security.firebase.revoke_sessions = lambda uid: (mobile_calls.append(("firebase", uid)), mobile_problem["firebase"])[1]
security.firebase.revoke_quick_login = lambda uid: (mobile_calls.append(("quick_login", uid)), mobile_problem["quick_login"])[1]

#: The Owner MFA binding removals, stood in: recorded, and made to fail on demand.
bindings_cleared: list[tuple[str, str]] = []
bindings_unbound: list[tuple[str, frozenset, str]] = []
binding_outcome = {"ok": True}


async def fake_clear_all_bindings(uid, reason, actor=None):
    bindings_cleared.append((uid, reason))
    return binding_outcome["ok"]


async def fake_unbind_sessions(uid, jtis, reason):
    bindings_unbound.append((uid, frozenset(jtis), reason))
    return binding_outcome["ok"]


mfa.clear_all_bindings = fake_clear_all_bindings
mfa.unbind_sessions = fake_unbind_sessions

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


def session_doc(jti: str) -> dict:
    return next(s for s in db[C.SESSIONS].docs if s["jti"] == jti)


# ── The world ─────────────────────────────────────────────────────────────────
db.seed(C.STAFF, [
    {"uid": "own1", "email": "owner@x.test", "name": "Owner One", "role": "owner", "is_active": True},
    {"uid": "own2", "email": "owner2@x.test", "name": "Owner Two", "role": "owner", "is_active": True},
    {"uid": "fin1", "email": "fin@x.test", "name": "Fin", "role": "finance_admin", "is_active": True},
    {"uid": "observer:obs@x.test", "email": "obs@x.test", "name": "Observer", "role": "observer", "is_active": True},
])


def issue(uid, role, **kw):
    email = f"{uid}@x.test"
    return run(security.issue_session(uid=uid, email=email, name=uid, role=role, **kw))


print("── revoke_sessions_for_uid ──────────────────────────────────────────────")

laptop, _ = issue("own1", Role.OWNER, mfa_verified=True, client="crm", ip="10.0.0.1", user_agent="Mozilla/5.0 Mac")
phone, _ = issue("own1", Role.OWNER, mfa_verified=True, client="android", ip="10.0.0.2", user_agent="Zipper/20")
stale, _ = issue("own1", Role.OWNER, mfa_verified=False, client="crm")
other, _ = issue("own2", Role.OWNER, mfa_verified=True, client="crm")
laptop_jti = run(security.verify_session(laptop))["jti"]
phone_jti = run(security.verify_session(phone))["jti"]
run(db[C.SESSIONS].update_one({"jti": phone_jti}, {"$set": {"mfa_binding_id": "sid-phone"}}))

result = run(security.revoke_sessions_for_uid("own1", "Stolen laptop reported", keep_jti=laptop_jti))
check("every OTHER live session of the uid is revoked", result["api_sessions"], 2)
check("…and the kept one is reported by fingerprint only", result["kept"], laptop_jti[:8])
ok("the kept session still works", run(security.verify_session(laptop))["uid"] == "own1")
refused("the phone's session is dead", security.verify_session(phone))
refused("…and the stale pending one", security.verify_session(stale))
ok("somebody else's session is untouched", run(security.verify_session(other))["uid"] == "own2")
check("the reason is on the record", session_doc(phone_jti).get("revoked_reason"), "Stolen laptop reported")
ok("…with a time", session_doc(phone_jti).get("revoked_at") is not None)
check("the phone held a Firestore binding, so its binding was removed", result["mfa_bindings_cleared"], True)
check("…ONLY the ended sessions' bindings — the kept laptop's survives",
      bindings_unbound[-1], ("own1", frozenset({phone_jti}), "Stolen laptop reported"))
check("…and not the whole uid's", bindings_cleared, [])
check("an ordinary revocation leaves the phone's quick login ALONE (not a restriction)", result["firebase_revoked"], None)
check("…and the Firebase side was not called", mobile_calls, [])
check("nothing to report", result["problems"], [])
ok("no audit row without an actor", not any(e["action"] == audit_mod.Action.SESSIONS_REVOKED for e in audit_log))

again = run(security.revoke_sessions_for_uid("own1", "again", keep_jti=laptop_jti))
check("idempotent: nothing left to revoke", (again["api_sessions"], again["mfa_bindings_cleared"]), (0, None))

# A security reset: the mobile side goes too, and it is audited.
actor = {"uid": "observer:obs@x.test", "name": "Observer", "role": Role.OBSERVER}
run(db[C.SESSIONS].update_one({"jti": laptop_jti}, {"$set": {"mfa_binding_id": "sid-laptop"}}))
reset = run(security.revoke_sessions_for_uid("own1", "Observer reset the Owner's MFA", actor=actor, mobile=True))
check("the kept laptop goes too when nothing is kept", reset["api_sessions"], 1)
check("…and with nothing kept, EVERY binding of the uid goes", bindings_cleared[-1], ("own1", "Observer reset the Owner's MFA"))
check("the Firebase refresh tokens and the quick-login credentials are revoked",
      (reset["firebase_revoked"], reset["quick_login_revoked"]), (True, True))
check("…in that order, for that uid", mobile_calls, [("firebase", "own1"), ("quick_login", "own1")])
row = next(e for e in audit_log if e["action"] == audit_mod.Action.SESSIONS_REVOKED)
check("one audit row, by the actor, with the counts", (row["actor"]["uid"], row["subject_id"], row["meta"]["api_sessions"],
      row["meta"]["quick_login_revoked"]), (actor["uid"], "own1", 1, True))
ok("…and never a token or a full session id", laptop not in json.dumps(audit_log, default=str)
   and laptop_jti not in json.dumps(audit_log, default=str))

# Failures downstream are reported, never raised.
mobile_calls.clear()
mobile_problem["quick_login"] = "The quick-login credentials could not be revoked: Firestore down"
binding_outcome["ok"] = False
t, _ = issue("own1", Role.OWNER, mfa_verified=True, client="crm")
run(db[C.SESSIONS].update_one({"jti": run(security.verify_session(t))["jti"]}, {"$set": {"mfa_binding_id": "sid-x"}}))
broken = run(security.revoke_sessions_for_uid("own1", "Suspended", actor=actor, mobile=True))
check("the API session is still revoked", broken["api_sessions"], 1)
check("…and what did not happen is named", (broken["mfa_bindings_cleared"], broken["quick_login_revoked"], len(broken["problems"])),
      (False, False, 2))
ok("…on the audit row too", any(e["action"] == audit_mod.Action.SESSIONS_REVOKED and len(e["meta"]["problems"]) == 2 for e in audit_log))
mobile_problem["quick_login"] = ""
binding_outcome["ok"] = True

# The Observer's synthetic uid names no Firebase account: skipped, not failed.
mobile_calls.clear()
obs_tok, _ = issue("observer:obs@x.test", Role.OBSERVER, mfa_verified=True)
obs = run(security.revoke_sessions_for_uid("observer:obs@x.test", "Sign out everywhere", mobile=True))
check("the Observer's API session is revoked", obs["api_sessions"], 1)
check("…and Firebase is not asked about a uid it does not know", (mobile_calls, obs["firebase_revoked"]), ([], None))
check("an empty uid revokes nothing and says so", run(security.revoke_sessions_for_uid("", "x"))["problems"], ["No account id was given."])


print("── GET /auth/sessions and POST /auth/sessions/revoke-all ───────────────")

db[C.SESSIONS].docs.clear()
firebase_mod = security.firebase
firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
    "uid": "fin1", "email": "fin@x.test", "email_verified": True, "firebase": {"sign_in_provider": "password"},
}


class Req(Request):
    def __init__(self, method, path, *, ip="", ua="", forwarded=""):
        super().__init__(method, path)
        self.headers = {"user-agent": ua, **({"x-forwarded-for": forwarded} if forwarded else {})}
        self.client = types.SimpleNamespace(host=ip) if ip else None


r1 = run(auth_router.signin(types.SimpleNamespace(id_token="id-token-aaaa", client="crm"),
                            Req("POST", "/api/auth/signin", ip="10.0.0.9", ua="Mozilla/5.0 (Macintosh)")))
travel(minutes=1)
r2 = run(auth_router.signin(types.SimpleNamespace(id_token="id-token-bbbb", client="android"),
                            Req("POST", "/api/auth/signin", forwarded="203.0.113.5, 10.0.0.1", ua="Zipper/20 (Android 14)")))
travel(minutes=1)
r3 = run(auth_router.signin(types.SimpleNamespace(id_token="id-token-cccc", client="nonsense"),
                            Req("POST", "/api/auth/signin", ip="10.0.0.7")))
me = run(deps.current_user(Req("GET", "/api/auth/sessions"), authorization=f"Bearer {r2.token}"))
listing = run(auth_router.my_sessions(me))
check("three live sessions", listing["count"], 3)
check("newest first, the current one first of all", [s["current"] for s in listing["sessions"]], [True, False, False])
current = listing["sessions"][0]
check("the current session is the Android one, with its forwarded address and agent",
      (current["client"], current["ip"], current["user_agent"]), ("android", "203.0.113.5", "Zipper/20 (Android 14)"))
laptop_row = next(s for s in listing["sessions"] if s["client"] == "crm" and s["ip"] == "10.0.0.9")
ok("the laptop is recognisable", "Macintosh" in laptop_row["user_agent"])
ok("an unknown client name is read as the CRM, not refused",
   sum(1 for s in listing["sessions"] if s["client"] == "crm") == 2 and not any(s["client"] == "nonsense" for s in listing["sessions"]))
ok("fingerprints only: no entry carries a full session id or a token",
   all(len(s["id"]) == 8 for s in listing["sessions"])
   and not any(t in json.dumps(listing) for t in (r1.token, r2.token, r3.token)))
ok("…and each has an issue time, an expiry and a last-active time",
   all(s["issued_at"] and s["expires_at"] and s["last_active_at"] for s in listing["sessions"]))
ok("the audit of the sign-in names the client", any(
    e["action"] == audit_mod.Action.LOGIN_SUCCEEDED and e["meta"].get("client") == "android" for e in audit_log))

# A renewal keeps the device's identity on the new record.
renewed, _, _ = run(security.renew_session(r2.token, ip="203.0.113.6"))
rec = session_doc(run(security.verify_session(renewed))["jti"])
check("renewal carries client and agent, and takes the new address", (rec["client"], rec["user_agent"], rec["ip"]),
      ("android", "Zipper/20 (Android 14)", "203.0.113.6"))
check("…and the replaced record says why it ended", session_doc(me["jti"]).get("revoked_reason"), "Renewed")
me = run(deps.current_user(Req("GET", "/api/auth/sessions"), authorization=f"Bearer {renewed}"))
check("still three live sessions after a renewal", run(auth_router.my_sessions(me))["count"], 3)

# Sign out everywhere ELSE.
out = run(auth_router.revoke_all_my_sessions(Req("POST", "/api/auth/sessions/revoke-all"), None, me))
check("two others revoked, this one kept", (out["revoked"], out["current_kept"]), (2, True))
ok("the caller's session still works", run(security.verify_session(renewed))["uid"] == "fin1")
refused("the laptop's does not", security.verify_session(r1.token))
check("the list is now one", run(auth_router.my_sessions(me))["count"], 1)
ok("sign-out-everywhere is on the audit log twice: the bulk row and the SESSION_ENDED row",
   any(e["action"] == audit_mod.Action.SESSIONS_REVOKED and e["subject_id"] == "fin1" for e in audit_log)
   and any(e["action"] == audit_mod.Action.SESSION_ENDED and e["meta"].get("method") == "revoke_all" for e in audit_log))
out = run(auth_router.revoke_all_my_sessions(Req("POST", "/api/auth/sessions/revoke-all"),
                                             types.SimpleNamespace(include_current=True), me))
check("…and with include_current the caller's own goes too", (out["revoked"], out["current_kept"]), (1, False))
refused("…so it is dead", security.verify_session(renewed))

# Reachability: partners yes (self-scoped), a pending Owner or Observer no.
ok("both routes are partner-reachable, self-scoped",
   ("GET", "/api/auth/sessions") in deps.PARTNER_REACHABLE and ("POST", "/api/auth/sessions/revoke-all") in deps.PARTNER_REACHABLE)
src = (ROOT / "app" / "routers" / "auth.py").read_text()
for name in ("async def my_sessions", "async def revoke_all_my_sessions"):
    body = src[src.index(name):]
    body = body[: body.index("\n@router", 10) if "\n@router" in body[10:] else len(body)]
    ok(f"{name} acts on own_session_uid and takes no id", "own_session_uid(user)" in body and "{" not in body.split("\n")[0])
pending_owner = {"uid": "own1", "role": Role.OWNER, "mfa_verified": False}
for m, p in (("GET", "/api/auth/sessions"), ("POST", "/api/auth/sessions/revoke-all")):
    try:
        deps._refuse_owner_without_mfa(Request(m, p), pending_owner)
        ok(f"a pending Owner cannot reach {m} {p}", False)
    except deps.HTTPException as exc:
        ok(f"a pending Owner cannot reach {m} {p}", exc.status_code == 403)

# The seven-day / three-day design is untouched.
check("a session is still a week", settings.session_ttl_minutes, 10_080)
check("…renewable for three more days", settings.session_renewal_grace_minutes, 4_320)
check("…and the Observer's twelve hours", settings.observer_session_ttl_minutes, 720)


print("── B-18: require_owner re-reads the role on record ─────────────────────")

verified_owner = {"uid": "own1", "role": Role.OWNER, "mfa_verified": True, "email": "owner@x.test"}
ok("an active Owner on record passes", run(deps.require_owner(verified_owner))["uid"] == "own1")
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"role": "finance_admin"}}))
msg = refused("an Owner whose role moved under the session is refused", deps.require_owner(verified_owner), deps.HTTPException, 403)
ok("…and told the role changed", "role has changed" in msg)
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"role": "owner", "is_active": False}}))
refused("a deactivated Owner is refused", deps.require_owner(verified_owner), deps.HTTPException, 403)
run(db[C.STAFF].update_one({"uid": "own1"}, {"$set": {"is_active": True}}))
refused("a session with no staff row is refused", deps.require_owner({"uid": "ghost", "role": Role.OWNER}), deps.HTTPException, 403)
refused("a non-owner is refused before any read", deps.require_owner({"uid": "fin1", "role": Role.FINANCE_ADMIN}), deps.HTTPException, 403)
deps_src = (ROOT / "app" / "core" / "deps.py").read_text()
owner_fn = deps_src[deps_src.index("async def require_owner("):]
owner_fn = owner_fn[: owner_fn.index("\nasync def ", 10)]
ok("…through the same §19 check require_permission uses", "_confirm_role_on_record(user, R.Role.OWNER)" in owner_fn)
for path in ("capital.py", "expenses.py", "partner_ops.py", "notifications.py", "chance.py", "users.py", "cards.py"):
    ok(f"routers/{path} still mounts require_owner on its Owner routes",
       "Depends(require_owner)" in (ROOT / "app" / "routers" / path).read_text())


print("── Restriction, ban, role revocation, security reset ────────────────────")

staff_src = (ROOT / "app" / "services" / "staff.py").read_text()
revoke_access = staff_src[staff_src.index("async def _revoke_access("):]
revoke_access = revoke_access[: revoke_access.index("\nasync def ", 10)]
ok("suspend / deactivate revoke every API session of the person first",
   'db[C.SESSIONS].update_many({"uid": uid}, {"$set": {"revoked": True}})' in revoke_access
   or "revoke_sessions_for_uid(" in revoke_access)
ok("…and clear an Owner's MFA bindings", "clear_all_bindings(" in revoke_access)
change_role = staff_src[staff_src.index("async def change_role("):]
change_role = change_role[: change_role.index("\nasync def ", 10)]
ok("a role change revokes the sessions carrying the old role",
   'db[C.SESSIONS].update_many({"uid": uid}, {"$set": {"revoked": True}})' in change_role
   or "revoke_sessions_for_uid(" in change_role)

users_src = (ROOT / "app" / "services" / "users.py").read_text()
ban = users_src[users_src.index("async def ban_user("):users_src.index("async def unban_user(")]
ok("a ban disables the Firebase login and revokes its tokens", "set_user_disabled, uid, True" in ban)
suspend = users_src[users_src.index("async def suspend_user("):]
suspend = suspend[: suspend.index("\nasync def ", 10)]
ok("a suspension revokes the Firebase refresh tokens and moves the cut-off",
   "firebase.revoke_sessions" in suspend and "credentialsValidAfter" in suspend)

mfa_src = (ROOT / "app" / "services" / "owner_mfa.py").read_text()
reset = mfa_src[mfa_src.index("async def reset_by_observer("):]
reset = reset[: reset.index("\nasync def ", 10)]
ok("the Observer's MFA reset is a SECURITY RESET through the shared helper, mobile included",
   "revoke_sessions_for_uid(" in reset and "mobile=True" in reset)
ok("renewal refuses a revoked session, so a bulk revocation is final",
   'if record.get("revoked"):' in (ROOT / "app" / "core" / "security.py").read_text())

sec_src = (ROOT / "app" / "core" / "security.py").read_text()
sig = re.search(r"async def revoke_sessions_for_uid\((.*?)\) -> dict:", sec_src, re.S)
ok("the signature the moderation side calls", sig is not None and
   "uid: str" in sig.group(1) and "reason: str" in sig.group(1) and "actor:" in sig.group(1)
   and "keep_jti:" in sig.group(1) and "mobile: bool = False" in sig.group(1))


print("── Quick login: 30 days, Keystore-bound, revocable ──────────────────────")

policy = (REPO / "functions" / "src" / "quickLoginPolicy.ts").read_text(encoding="utf-8")
quick = (REPO / "functions" / "src" / "quickLogin.ts").read_text(encoding="utf-8")
identity = (REPO / "functions" / "src" / "identity.ts").read_text(encoding="utf-8")
ttl = re.search(r"export const QUICK_LOGIN_TTL_DAYS = (\d+)", policy)
ok("the credential expires in at most 30 days (the 400-day token is gone)", ttl is not None and int(ttl.group(1)) <= 30)
ok("…and the old unbound records are refused as legacy", "'legacy'" in policy and "isLegacy(record)" in policy)
ok("a revoked credential is refused at redemption", "if (record.revokedAt) return 'refused'" in policy)
ok("an expired one too", "expiry <= nowMs) return 'refused'" in policy)
ok("redemption needs a signature from the handset's Keystore key over a server challenge",
   "verifySignature(" in quick and "crypto.verify(" in quick and "challengeId" in quick)
ok("the raw secret is never stored: the document id is its hash", "doc(hash(secret))" in quick)
ok("a displaced device loses its quick login", "quick-login revoked on displacement" in identity)
ok("a deleted account loses every credential", "revokeQuickLoginOnRestriction" in identity)
ok("…while ban and suspension keep it for the appeal and grant NO session",
   "grantsSession" in policy and "outcome === 'allow'" in policy)
ok("the person can forget a device or all devices", "revokeQuickLogin" in quick and "allDevices" in quick)
firebase_src = (ROOT / "app" / "db" / "firebase.py").read_text()
ok("the backend can revoke every credential of a uid (security reset)",
   "def revoke_quick_login(uid: str) -> str:" in firebase_src and 'QUICK_LOGIN_COLLECTION = "quickLoginTokens"' in firebase_src)
store = (REPO / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper" / "app" / "util" / "QuickLoginStore.kt")
if store.exists():
    kt = store.read_text(encoding="utf-8")
    ok("the app keeps the secret out of cloud backup", "setShouldBackupToCloud(false)" in kt.replace(" ", ""))
key = (REPO / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper" / "app" / "util" / "DeviceKey.kt")
if key.exists():
    ok("…and signs with a key generated inside the Android Keystore", "KeyGenParameterSpec" in key.read_text(encoding="utf-8"))

mobile = (REPO / "functions" / "src" / "mobileSession.ts").read_text(encoding="utf-8")
ok("one active mobile session per human: the server mints and replaces it in a transaction",
   "runTransaction" in identity and "activeMobileSession" in identity and "credentialsValidAfter" in identity)
ok("…and every protected callable checks the session and the auth time", "assertActiveSession" in mobile
   and "auth_time" in mobile)

if failures:
    print(f"\n{len(failures)} of {checks} session-rule checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} B3 session-rule checks passed.")
print("  · revoke_sessions_for_uid ends every live session, the Owner's bindings, and — for a")
print("    restriction or a security reset — the Firebase tokens and the quick-login credential")
print("  · GET /auth/sessions lists live sessions by fingerprint; POST /auth/sessions/revoke-all signs out everywhere")
print("  · require_owner re-reads the role on record before any Owner money action (B-18)")
print("  · the seven-day token and three-day grace are untouched; quick login is 30 days and Keystore-bound")
