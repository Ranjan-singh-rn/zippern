"""C4 — a suspended or banned app account loses its CRM partner access.

── THE DEFECT (B06) ────────────────────────────────────────────────────────

Suspending or banning an account stopped the app and nothing else. The same
person's agency or coin-seller portal kept working: the live CRM session, a
fresh sign-in and every renewal were all decided from the partner records
alone, and those were untouched — rightly, because the roles are not what a
moderation decision is about.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * every session — partner, applicant, staff — is also asked whether the app
    account behind it is restricted, after the partner/staff answer;
  * a suspended Agency + Coin Seller's existing session is refused at its next
    re-check, a fresh sign-in is refused, a renewal is refused;
  * suspending or banning revokes every CRM session of the uid and marks
    `crmUsers/{uid}.accountRestricted` (only when that document exists);
    resuming / unbanning clears it;
  * the roles are NOT touched: lifting the restriction gives back exactly the
    roles still approved — a Coin Seller revoked meanwhile stays revoked;
  * staff with no app restriction are unaffected.

REAL: core.account_state, core.security, core.deps, services.users,
partner_ops, crm_directory. FAKE: Mongo (`tests/harness.FakeDb`), Firestore
(`tests/fakes.FakeFirestore`), and a JWT that really carries claims.

    python3 -m tests.test_account_restriction
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, Request, install_stubs  # noqa: E402

install_stubs()


# A JWT that round-trips its claims — the harness stub returns the literal
# string "token", and nothing about a session can be tested through that. The
# same envelope `tests/test_session_lifetime.py` uses.
class JWTError(Exception):
    pass


def _digest(claims: dict, secret: str) -> str:
    return hashlib.sha256(f"{json.dumps(claims, sort_keys=True, default=str)}|{secret}".encode()).hexdigest()


class RealishJwt:
    @staticmethod
    def encode(claims, secret, algorithm=None):  # noqa: ARG004
        return json.dumps({"claims": claims, "sig": _digest(claims, secret)})

    @staticmethod
    def decode(token, secret, algorithms=None, issuer=None, options=None):  # noqa: ARG004
        try:
            envelope = json.loads(token)
            claims = envelope["claims"]
        except Exception as exc:  # noqa: BLE001
            raise JWTError("not a token") from exc
        if envelope.get("sig") != _digest(claims, secret):
            raise JWTError("signature does not verify")
        if (options or {}).get("verify_exp", True):
            if int(claims.get("exp") or 0) < int(datetime.now(timezone.utc).timestamp()):
                raise JWTError("expired")
        return claims


sys.modules["jose"] = types.ModuleType("jose")
sys.modules["jose"].JWTError = JWTError
sys.modules["jose"].jwt = RealishJwt

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import account_state  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import security as sec  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]


async def fake_audit(**kw):
    return "audit-id"


audit_mod.record = fake_audit

from app.config import settings  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import users as users_svc  # noqa: E402

logging.disable(logging.CRITICAL)
# "Set the interval to 0 to check on every request" (`core/account_state`): the
# re-check runs on each call here, which is what a test of the re-check needs —
# and the harness's `find_one` would read the cache lookup's projection as a
# sort order.
settings.auth_state_recheck_seconds = 0

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refused(claim: str, factory, error=sec.AuthError) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(factory())
    except error as exc:
        return str(getattr(exc, "message", None) or exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run
MESSAGE = account_state.ACCOUNT_RESTRICTED_MESSAGE
MOD = {"uid": "mod-1", "name": "Moderator", "role": "app_admin", "team": "app"}
STAFF = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved") -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid})


def crm_login(uid: str, role: str, **extra) -> None:
    fs.collection("crmUsers").docs[uid] = {"uid": uid, "email": f"{uid}@x.test", "role": role,
                                          "isActive": True, "status": "approved", **extra}


async def _sign_in_as(uid: str):
    """`sign_in_with_firebase` for a token that proves `uid` and its address."""
    firebase_mod.verify_id_token = lambda _t: {  # type: ignore[assignment]
        "uid": uid, "email": f"{uid}@x.test", "email_verified": True,
        "firebase": {"sign_in_provider": "password"},
    }
    return await sec.sign_in_with_firebase("an-id-token")


def sign_in(uid: str) -> tuple[str, datetime, dict]:
    return run(_sign_in_as(uid))


async def _aged_recheck(token: str) -> None:
    """The per-request check, as the next request after the interval runs it."""
    await account_state.assert_may_act(await sec.verify_session(token))


def recheck(token: str) -> None:
    run(_aged_recheck(token))


# ── The world ────────────────────────────────────────────────────────────────
user("p1")
partner("AG", "p1", "agency")
partner("SL", "p1", "seller")
crm_login("p1", "agency", roles=["agency", "seller"], agencyId="AG", sellerId="SL",
          roleStatus={"agency": "approved", "seller": "approved"})
# The seller's Firestore document — what the public directory is mirrored from.
fs.collection("sellers").docs["SL"] = {"isApproved": True, "isActive": True, "status": "approved",
                                       "displayName": "SL", "crmUid": "p1"}
user("p2")
partner("AG2", "p2", "agency")
crm_login("p2", "agency", agencyId="AG2")
user("p3")                                     # an app user with no CRM login at all
DB.seed(C.STAFF, [{"uid": "s1", "email": "s1@x.test", "name": "Staff", "role": "ops_admin",
                   "is_active": True}])
user("p4")
partner("AG4", "p4", "agency", status="pending")
crm_login("p4", "agency", agencyId="AG4", status="pending")

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The verdict, pure")

eq("no app document → no app restriction", account_state.app_account_refusal(None), None)
eq("an active account → none", account_state.app_account_refusal({"accountState": "active"}), None)
for doc in ({"accountState": "suspended"}, {"accountState": "banned"},
            {"isBanned": True}, {"isSuspended": True}):
    refusal = account_state.app_account_refusal(doc)
    ok(f"{doc} is refused", refusal is not None and refusal.reason == "account_restricted")
ok("…with the contract's sentence", account_state.app_account_refusal({"isBanned": True}).message == MESSAGE)

# ══════════════════════════════════════════════════════════════════════════════
print("2. A live session is refused at its next re-check")

t1, _, prof1 = sign_in("p1")
eq("an Agency + Coin Seller signs in with both capabilities", prof1["partner_ids"],
   {"agency": "AG", "seller": "SL"})
recheck(t1)
ok("…and the session passes its re-check while the account is active", True)
# The backstop: restricted WITHOUT the sessions being revoked (a session that
# predates this fix, a hand edit, a failed sweep).
fs.collection("users").docs["p1"].update({"isSuspended": True, "isBanned": True, "accountState": "suspended"})
m = refused("an existing CRM session is refused once the app account is suspended",
            lambda: _aged_recheck(t1), error=account_state.AccountRefused)
eq("…with the account-restricted sentence", m, MESSAGE)
try:
    run(deps.current_user(Request("GET", "/api/partner-ops/partners"), authorization=f"Bearer {t1}"))
    status_code = None
except Exception as exc:  # noqa: BLE001
    status_code = getattr(exc, "status_code", None)
eq("…which every route answers with 403", status_code, 403)
fs.collection("users").docs["p1"].update({"isSuspended": False, "isBanned": False, "accountState": "active"})

# ══════════════════════════════════════════════════════════════════════════════
print("3. Suspension closes the CRM door; the roles are untouched")

t2, _, _ = sign_in("p1")
out = run(users_svc.suspend_user("p1", "Abuse in a live room.", MOD))
eq("suspending revokes every CRM session of the uid", out["crm_access"]["crm_sessions_revoked"], 2)
m = refused("…so the session in hand stops at once", lambda: sec.verify_session(t2))
ok("…as revoked", "revoked" in m, m)
eq("…and the login is marked for the rules", fs.collection("crmUsers").docs["p1"].get("accountRestricted"), True)
eq("…and the seller listing is hidden from the public directory (C4 / B06)",
   fs.collection("sellers").docs["SL"].get("ownerRestricted"), True)
eq("…reported as one listing hidden", out["crm_access"]["seller_listings_hidden"], 1)
eq("…and presence is cleared server-side (the app can no longer write it, B42)",
   fs.collection("users").docs["p1"].get("isOnline"), False)
eq("…while the seller document itself stays approved",
   (fs.collection("sellers").docs["SL"].get("status"), fs.collection("sellers").docs["SL"].get("isApproved")),
   ("approved", True))
eq("…while the roles themselves are untouched",
   sorted((p["_id"], p["status"]) for p in DB[C.PARTNERS].docs if p["owner_crm_uid"] == "p1"),
   [("AG", "approved"), ("SL", "approved")])
eq("a fresh sign-in is refused", refused("sign-in while suspended", lambda: _sign_in_as("p1")), MESSAGE)
# A session minted some other way while the account is restricted — renewal is
# its own door and must refuse too.
t3, _ = run(sec.issue_session(uid="p1", email="p1@x.test", name="p1", role=Role.AGENCY,
                              partner_ids={"agency": "AG", "seller": "SL"}, partner_status="approved"))
eq("a renewal is refused", refused("renewal while suspended", lambda: sec.renew_session(t3)), MESSAGE)

# The Seller is revoked while the account is suspended (Agency + Seller → two
# roles, so one may go).
run(ops.revoke_partner("SL", "Chargebacks confirmed.", STAFF))
eq("(the Seller is revoked meanwhile)", next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SL")["status"], "revoked")

# ══════════════════════════════════════════════════════════════════════════════
print("4. Lifting it gives back exactly what is still approved")

back = run(users_svc.resume_user("p1", "Suspension served.", MOD))
eq("resuming clears the mark", fs.collection("crmUsers").docs["p1"].get("accountRestricted"), False)
eq("…and the seller listing flag (the revoked record stays out by its own status)",
   fs.collection("sellers").docs["SL"].get("ownerRestricted"), False)
ok("…and says so", back["crm_access"]["crm_login_flagged"] is True)
t4, _, prof4 = sign_in("p1")
eq("sign-in works again — with the Agency only; the revoked Seller stays revoked",
   prof4["partner_ids"], {"agency": "AG"})
recheck(t4)
ok("…and the new session passes its re-check", True)

# ══════════════════════════════════════════════════════════════════════════════
print("5. A ban does the same; an account with no CRM login gets no document")

t5, _, _ = sign_in("p2")
run(users_svc.ban_user("p2", "Fraud confirmed.", MOD))
refused("a banned partner's session stops", lambda: sec.verify_session(t5))
eq("…the login is marked", fs.collection("crmUsers").docs["p2"].get("accountRestricted"), True)
eq("…and presence is cleared server-side", fs.collection("users").docs["p2"].get("isOnline"), False)
eq("…and cannot sign in", refused("banned sign-in", lambda: _sign_in_as("p2")), MESSAGE)
run(users_svc.unban_user("p2", "Appeal upheld after review.", MOD))
eq("unbanning clears the mark", fs.collection("crmUsers").docs["p2"].get("accountRestricted"), False)
eq("…and the partner signs in again", sign_in("p2")[2]["partner_ids"], {"agency": "AG2"})

# Unban, like resume, gives back only what is still approved: a role revoked
# before the ban stays revoked after it is lifted.
user("p5")
partner("AG5", "p5", "agency")
partner("SL5", "p5", "seller")
crm_login("p5", "agency", roles=["agency", "seller"], agencyId="AG5", sellerId="SL5",
          roleStatus={"agency": "approved", "seller": "approved"})
run(ops.revoke_partner("SL5", "Chargebacks confirmed.", STAFF))
run(users_svc.ban_user("p5", "Fraud confirmed.", MOD))
run(users_svc.unban_user("p5", "Appeal upheld after review.", MOD))
eq("unban after a role revocation: the revoked Seller stays revoked",
   next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SL5")["status"], "revoked")
eq("…the Agency is still approved", next(p for p in DB[C.PARTNERS].docs if p["_id"] == "AG5")["status"], "approved")
eq("…and sign-in carries the Agency only", sign_in("p5")[2]["partner_ids"], {"agency": "AG5"})

s3 = run(users_svc.suspend_user("p3", "Spam.", MOD))
eq("an app user with no CRM login: nothing is flagged", s3["crm_access"]["crm_login_flagged"], False)
ok("…and no crmUsers document is created", "p3" not in fs.collection("crmUsers").docs)

# ══════════════════════════════════════════════════════════════════════════════
print("6. Every session — the applicant's and staff's too")

t6, _, prof6 = sign_in("p4")
eq("(an applicant under review has a session with no ids)", prof6["partner_ids"], {})
fs.collection("users").docs["p4"].update({"isBanned": True, "accountState": "banned"})
m = refused("an applicant's session is refused once the account is banned",
            lambda: _aged_recheck(t6), error=account_state.AccountRefused)
eq("…with the account-restricted sentence", m, MESSAGE)

t7, _, prof7 = sign_in("s1")
eq("staff sign in as staff", prof7["role"], "ops_admin")
recheck(t7)
ok("…and their session passes — no app restriction to honour", True)

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} account-restriction checks passed.")
print("  · a restricted app account: live session refused, sign-in refused, renewal refused")
print("  · suspend / ban revoke every CRM session and mark crmUsers.accountRestricted")
print("  · lifting it restores exactly the roles still approved; roles are never touched")
print("  · applies to every session, staff unaffected\n")
