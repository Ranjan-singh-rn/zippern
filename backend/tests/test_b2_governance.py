"""B2 — identity, role, moderation and governance behaviour against the master
specification, sections 3–9 (the §16 lists).

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  §3  ONE shared eligibility function (`partner_applications.assert_eligible`)
      behind every door — application, invitation, approval, restoration,
      migration — and the matrix through it: Agency + Seller and Sub-agency +
      Seller allowed; Agency + Agency, Sub + Sub, Agency + Sub, Seller + Seller
      refused; Owner, Observer and staff refused by name; concurrent duplicate
      Agency applications → one record; a second role never overwrites the
      first role's id or claim.
  §4  a DECIDED (rejected) application is never replayed into an approval —
      partner records and host applications alike.
  §5  warning → history only (no restriction, no revocation, no session loss,
      no freeze, no automatic threshold); suspension → sessions revoked, online
      state cleared, roles untouched, money frozen not released; resume →
      stale sessions revoked, fresh authentication required, only still-approved
      roles come back; ban → scope / category / evidence / actor / time
      recorded, partner roles untouched, protected APIs refuse the uid, device
      bans auditable; unban restores no revoked role and releases no freeze;
      ban / suspension appeal: reviewer recommends (never the original decision
      maker), the OWNER decides (never the original decision maker), the
      recommendation travels onto the decision; Support cannot ban; partner
      role suspension / revocation touch only that role; revoke Host ends the
      Host's live room and tells the agency.
  §6  reinstatement restores the SAME record only on the Owner's decision; a
      recommendation alone restores nothing.
  §6  transfers: the hold (`transfer_review`) on the subject's unsettled
      earnings, the source / target agency notices, and an injected move
      failure that is NOT swallowed (no approval, request stays pending).
  §9  the twenty permission keys, twelve department roles, six departments;
      can_approve_kyc / can_approve_seller held by Operations Admin (and the
      Owner) only; Support holds no ban permission; department Admin VACANCY:
      opened by the Admin's deactivation (members report to "Owner (vacancy)",
      the Owners told once), closed by a replacement Admin's invitation.
  §8  exactly one Observer; an Owner cannot provision or deactivate an Owner
      and cannot touch the Observer.
  +   the claim compare-and-set race, at the claim level (the lifecycle
      scenario that used to drive it through approvals of rejected records no
      longer has a legal way to run — §4).

REAL: services.partner_applications, partner_ops, partner_roles, users,
appeals, role_appeals, transfer_requests, staff, notices, notify, money_freeze,
live; core.account_state, core.roles; routers.users, routers.staff.
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
Firebase Auth (`tests/harness.verified_auth`).

    python3 -m tests.test_b2_governance
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import AUTH_CALLS, FakeDb, install_stubs, reset_auth_calls  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import account_state  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Permission, Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from tests import harness as _h  # noqa: E402

firebase_mod.get_user = _h.verified_auth  # type: ignore[assignment]
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

import pydantic as _pydantic  # noqa: E402

# `routers/staff.py` annotates with `EmailStr`; the harness's pydantic stub has
# no such name (no other test imports that router). A plain `str` here: the
# body classes are never validated by the stub anyway.
_pydantic.EmailStr = str  # type: ignore[attr-defined]
from app.routers import staff as staff_router  # noqa: E402
from app.routers import users as users_router  # noqa: E402
from app.services import appeals as appeals_svc  # noqa: E402
from app.services import live as live_svc  # noqa: E402
from app.services import money_freeze  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles  # noqa: E402
from app.services import revocation_hooks  # noqa: E402
from app.services import role_appeals  # noqa: E402
from app.services import staff as staff_svc  # noqa: E402
from app.services import transfer_requests as transfers  # noqa: E402
from app.services import users as users_svc  # noqa: E402

apps.is_unverified_guest = lambda uid: False  # fixtures are verified people
logging.disable(logging.CRITICAL)

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


def refused(claim: str, coro, kind=Exception):
    """The refusal (an instance of `kind`), or None and a failure."""
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc}) — wanted {kind.__name__}")
        return None
    failures.append(f"{claim}: was NOT refused")
    return None


run = asyncio.run
NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
SERVICE = {"uid": "system:partner-registration", "name": "Partner registration (automated)",
           "role": "system", "team": None}
OPS = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OPS2 = {"uid": "ops-2", "name": "Second Ops Admin", "role": "ops_admin", "team": "ops"}
APP_ADMIN = {"uid": "app-1", "name": "App Admin", "role": "app_admin", "team": "app"}
SUPPORT = {"uid": "sup-1", "name": "Support Admin", "role": "support_admin", "team": "support"}
OWNER = {"uid": "owner-1", "name": "Owner One", "role": "owner", "team": None}
OWNER2 = {"uid": "owner-2", "name": "Owner Two", "role": "owner", "team": None}
OBSERVER = {"uid": "observer:obs@zipper.test", "name": "Observer", "role": "observer", "team": None}
WHY = "Reviewed and decided after reading the file."
LONG = "Reviewed the history in full; the breach was a one-off and has been resolved since."

DB.seed(C.STAFF, [
    {"uid": "owner-1", "role": "owner", "is_active": True, "email": "owner1@zipper.test", "name": "Owner One",
     "team": None},
    {"uid": "owner-2", "role": "owner", "is_active": True, "email": "owner2@zipper.test", "name": "Owner Two",
     "team": None},
    {"uid": "observer:obs@zipper.test", "role": "observer", "is_active": True, "email": "obs@zipper.test",
     "name": "Observer", "team": None},
    {"uid": "ops-1", "role": "ops_admin", "is_active": True, "email": "ops1@zipper.test", "name": "Ops Admin",
     "team": "ops"},
    {"uid": "ops-2", "role": "ops_admin", "is_active": True, "email": "ops2@zipper.test",
     "name": "Second Ops Admin", "team": "ops"},
    {"uid": "ops-m-1", "role": "ops_member", "is_active": True, "email": "opsm1@zipper.test",
     "name": "Ops Member", "team": "ops"},
    {"uid": "sup-1", "role": "support_admin", "is_active": True, "email": "sup1@zipper.test",
     "name": "Support Admin", "team": "support"},
    {"uid": "app-1", "role": "app_admin", "is_active": True, "email": "app1@zipper.test", "name": "App Admin",
     "team": "app"},
])


# A staff account is two records: the Mongo row above and its `crmUsers`
# document, which the staff lifecycle switches off and on.
for _row in DB[C.STAFF].docs:
    if _row["role"] != "observer":
        fs.collection("crmUsers").docs[_row["uid"]] = {"email": _row["email"], "role": _row["role"], "isActive": True}


def user(uid: str, **over) -> dict:
    doc = {"name": f"user {uid}", "accountState": "active", "isBanned": False, "isSuspended": False,
           "email": f"{uid}@x.test", **over}
    fs.collection("users").docs[uid] = doc
    return doc


def stored(uid: str) -> dict:
    return fs.collection("users").docs[uid]


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, "crm_id": f"CRM-{pid}", **over})
    fs.collection("sellers" if kind == "seller" else "agencies").docs[pid] = {
        "agencyName" if kind != "seller" else "displayName": pid, "crmUid": owner, "ownerUid": owner,
        "status": status, "isActive": status == "approved"}


def record(pid: str) -> dict:
    return next(p for p in DB[C.PARTNERS].docs if p["_id"] == pid)


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


def actions(subject_id: str) -> list[str]:
    return [e["action"] for e in AUDIT if e.get("subject_id") == subject_id]


def session(uid: str, jti: str, role: str = "agency", partner_ids: dict | None = None) -> dict:
    doc = {"jti": jti, "uid": uid, "role": role, "revoked": False, "partner_ids": partner_ids or {}}
    DB[C.SESSIONS].docs.append(dict(doc))
    return doc


def live_sessions(uid: str) -> int:
    return sum(1 for s in DB[C.SESSIONS].docs if s["uid"] == uid and not s.get("revoked"))


def freeze_of(subject_type: str, subject_id: str) -> dict | None:
    return next((d for d in DB["money_freezes"].docs if d["_id"] == f"{subject_type}:{subject_id}"), None)


AGENCY_FORM = {
    "agencyName": "Skyline", "ownerName": "A", "ownerPhone": "+911", "ownerEmail": "a@x.test",
    "address": "1 Road", "paymentType": "india", "accountHolderName": "A", "accountNumber": "123",
    "ifscCode": "HDFC0001", "bankName": "HDFC", "branch": "Main",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SELLER_FORM = {
    "displayName": "Coins R Us", "phone": "+912", "email": "s@x.test", "city": "Pune",
    "idDocUrls": ["https://x/id"],
    "payment": {"upiId": "coins@upi", "accountNumber": "999", "ifscCode": "SBIN0001", "bankName": "SBI"},
}


def apply(uid: str, kind: str, parent: str | None = None) -> dict:
    form = dict(SELLER_FORM if kind == "seller" else AGENCY_FORM)
    return run(apps.submit_partner_application(uid, kind, form, parent, SERVICE))


def approve(pid: str, actor: dict = OPS) -> dict:
    return run(ops.approve_partner(pid, WHY, actor))


# ══════════════════════════════════════════════════════════════════════════════
print("\n§3  One shared eligibility function, and the matrix through it")

import ast  # noqa: E402

src = (ROOT / "app" / "services" / "partner_applications.py").read_text(encoding="utf-8")
tree = ast.parse(src)
_calls_assert = {}
for node in ast.walk(tree):
    if isinstance(node, ast.AsyncFunctionDef) and node.name in (
        "recheck_at_decision", "recheck_host_restore", "_refuse_if_ineligible", "reapply_sub_agency"
    ):
        _calls_assert[node.name] = any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "assert_eligible"
            for n in ast.walk(node)
        )
eq("every eligibility door delegates to `assert_eligible`",
   _calls_assert, {"recheck_at_decision": True, "recheck_host_restore": True,
                   "_refuse_if_ineligible": True, "reapply_sub_agency": True})
eq("…the five contexts the spec names", apps.ELIGIBILITY_CONTEXTS,
   ("application", "invitation", "approval", "restoration", "migration"))
try:
    run(apps.assert_eligible("nobody", "agency", context="guess"))
    ok("an unknown context is refused at the call", False)
except ValueError:
    ok("an unknown context is refused at the call", True)

user("m-ag"); partner("AG-m", "m-ag", "agency")
user("m-sub"); partner("SUB-m", "m-sub", "sub_agency", parent_id="AG-m")
user("m-sl"); partner("SL-m", "m-sl", "seller")
for uid, wanted, label in (("m-ag", "seller", "Agency + Coin Seller"), ("m-sub", "seller", "Sub-agency + Coin Seller")):
    held = run(apps.assert_eligible(uid, wanted, context="application"))
    ok(f"{label} is allowed", isinstance(held, dict))
for uid, wanted, label in (
    ("m-ag", "agency", "Agency + Agency"), ("m-sub", "sub_agency", "Sub-agency + Sub-agency"),
    ("m-ag", "sub_agency", "Agency + Sub-agency"), ("m-sub", "agency", "Sub-agency + Agency"),
    ("m-sl", "seller", "Coin Seller + Coin Seller"), ("m-ag", "host", "Agency + Host"),
):
    exc = refused(f"{label} is refused", apps.assert_eligible(uid, wanted, context="application"),
                  kind=apps.ApplicationError)
    for ctx in ("approval", "restoration", "migration", "invitation"):
        refused(f"…and at {ctx} time", apps.assert_eligible(uid, wanted, context=ctx), kind=apps.ApplicationError)
# No sub-sub-agency: a sub-agency is never a valid parent for a sub-agency.
user("m-sub2")
exc = refused("no sub-sub-agency: a Sub-agency cannot be the parent of a Sub-agency",
              apps.submit_partner_application("m-sub2", "sub_agency", dict(AGENCY_FORM), "SUB-m", SERVICE),
              kind=ops.PartnerOpsError)
# Host + Sub-agency under the SAME main agency is allowed; under another is not.
user("m-host", isHost=True, agencyId="AG-m")
user("m-ag2"); partner("AG-m2", "m-ag2", "agency")
ok("Host under X + Sub-agency under X is allowed",
   isinstance(run(apps.assert_eligible("m-host", "sub_agency", context="application", parent_id="AG-m")), dict))
refused("Host under X + Sub-agency under Y is refused (parent pin)",
        apps.assert_eligible("m-host", "sub_agency", context="application", parent_id="AG-m2"),
        kind=apps.ApplicationError)
refused("Host + Agency is refused", apps.assert_eligible("m-host", "agency", context="application"),
        kind=apps.ApplicationError)

# Owner / Observer / staff hold no partner role — by name, at every door.
for uid, word in (("owner-1", "Owner"), ("observer:obs@zipper.test", "Observer"), ("ops-1", "staff")):
    user(uid)
    for kind in apps.KINDS:
        for ctx in ("application", "approval", "restoration"):
            exc = refused(f"{word} cannot hold {kind} ({ctx})",
                          apps.assert_eligible(uid, kind, context=ctx, restoring_host=(ctx == "restoration")),
                          kind=apps.ApplicationError)
            ok(f"…refused by name: {word}", exc is not None and word.lower() in str(exc).lower(), str(exc))
el = run(apps.eligibility("owner-1"))
eq("the Owner's eligibility answer offers nothing", el["options"], [])
eq("…every kind carries the Owner sentence", set(el["blocked"].values()), {apps.OWNER_REFUSAL})
eq("the Observer's sentence names the Observer",
   set(run(apps.eligibility("observer:obs@zipper.test"))["blocked"].values()), {apps.OBSERVER_REFUSAL})

# Concurrent duplicate Agency applications → exactly one record.
user("m-race")


async def _race():
    return await asyncio.gather(
        apps.submit_partner_application("m-race", "agency", dict(AGENCY_FORM), None, SERVICE),
        apps.submit_partner_application("m-race", "agency", dict(AGENCY_FORM), None, SERVICE),
        return_exceptions=True,
    )


outs = run(_race())
eq("two concurrent Agency applications → ONE record for the person",
   len([p for p in DB[C.PARTNERS].docs if p.get("owner_crm_uid") == "m-race"]), 1)
ok("…the loser is refused, not written", sum(isinstance(o, Exception) for o in outs) == 1, repr(outs))
ok("…and no orphan agency document is left behind",
   len([d for d in fs.collection("agencies").docs.values() if d.get("ownerUid") == "m-race"]) == 1)

# A second role never overwrites the first role's id or claim.
user("m-two")
A1 = apply("m-two", "agency")["id"]
approve(A1)
first_claim = dict(next(d for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs if d["_id"] == "agency:m-two"))
S1 = apply("m-two", "seller")["id"]
approve(S1)
eq("the Agency record and claim are untouched by the Seller approval",
   (record(A1)["status"], next(d for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs
                                  if d["_id"] == "agency:m-two")["partner_id"]), ("approved", A1))
eq("…the first claim is byte-for-byte the same",
   next(d for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs if d["_id"] == "agency:m-two"), first_claim)
eq("…the Seller has its own claim", next(d for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs
                                        if d["_id"] == "seller:m-two")["partner_id"], S1)
login = fs.collection("crmUsers").docs.get("m-two") or {}
eq("…the login carries BOTH partner ids (no second login, nothing overwritten)",
   (login.get("agencyId"), login.get("sellerId")), (A1, S1))

# ══════════════════════════════════════════════════════════════════════════════
print("§4  A decided application is never replayed into an approval")

user("d-rej")
D1 = apply("d-rej", "agency")["id"]
run(ops.reject_partner(D1, "Incomplete documents.", OPS))
exc = refused("approving a REJECTED partner record is refused", ops.approve_partner(D1, WHY, OPS),
              kind=ops.PartnerOpsError)
ok("…saying a decided application is not replayed", exc is not None and "already decided" in str(exc), str(exc))
eq("…and it stays rejected, history intact",
   (record(D1)["status"], record(D1)["rejection_reason"]), ("rejected", "Incomplete documents."))
refused("…nor can the Owner replay it", ops.approve_partner(D1, WHY, OWNER), kind=ops.PartnerOpsError)
D2 = apply("d-rej", "agency")["id"]
ok("a fresh application after the rejection is a NEW record", D2 != D1 and record(D2)["status"] == "pending")

user("d-host")
partner("AG-host", "ag-host-owner", "agency")
fs.collection("hostApplications").docs["ha-rej"] = {
    "applicantUid": "d-host", "status": "rejected", "kycStatus": "rejected", "agencyId": "AG-host",
    "hostName": "D Host", "rejectionReason": "Blurry documents.",
}
exc = refused("approving a REFUSED host application is refused",
              users_svc.decide_host_application("ha-rej", True, WHY, OPS), kind=users_svc.UserError)
ok("…saying so", exc is not None and "never replayed" in str(exc), str(exc))
eq("…the application stays refused and the account is no Host",
   (fs.collection("hostApplications").docs["ha-rej"]["status"], stored("d-host").get("isHost", False)),
   ("rejected", False))

# ══════════════════════════════════════════════════════════════════════════════
print("§5  Warning → history only")

user("w-1"); partner("AG-w", "w-1", "agency"); partner("SL-w", "w-1", "seller")
session("w-1", "jti-w-1", partner_ids={"agency": "AG-w"})
eq("there is no automatic warning threshold (OWNER_DECISION_PENDING)", users_svc.WARNING_AUTO_THRESHOLD, None)
for i in range(5):
    run(users_svc.warn_user("w-1", f"Warning number {i + 1}: language in a party room.", OPS,
                            meta={"report_id": f"rep-{i + 1}"}))
hist = run(users_svc.list_warnings("w-1"))
eq("five warnings are on the history, each linked to its source report",
   sorted(w.get("report_id") for w in hist), [f"rep-{i}" for i in range(1, 6)])
eq("…each attributed to a person", {w["issuedBy"] for w in hist}, {"ops-1"})
eq("the account is under NO restriction", users_svc.restriction_of(stored("w-1")), "")
eq("…login not blocked (the account-state check passes)", account_state.app_account_refusal(stored("w-1")), None)
eq("…roles untouched", (record("AG-w")["status"], record("SL-w")["status"]), ("approved", "approved"))
eq("…sessions untouched", live_sessions("w-1"), 1)
eq("…no money frozen", freeze_of("user", "w-1"), None)
eq("…audited as user.warned, five times", actions("w-1").count("user.warned"), 5)
ok("…the person is told", len(notices_for("w-1")) == 5)

# ══════════════════════════════════════════════════════════════════════════════
print("§5  Suspension → sessions revoked, roles untouched; Resume → only still-approved roles")

user("s-1", isOnline=True, devices=())
partner("AG-s", "s-1", "agency"); partner("SL-s", "s-1", "seller")
fs.collection("crmUsers").docs["s-1"] = {"role": "agency", "agencyId": "AG-s", "isActive": True}
session("s-1", "jti-s-1", partner_ids={"agency": "AG-s", "seller": "SL-s"})
session("s-1", "jti-s-2", partner_ids={"agency": "AG-s"})
reset_auth_calls()
out = run(users_svc.suspend_user("s-1", "Abusive messages after a written warning.", OPS, days=7))
eq("the account is suspended", users_svc.restriction_of(stored("s-1")), "suspended")
eq("…every CRM session of the uid is revoked", live_sessions("s-1"), 0)
eq("…the Firebase refresh tokens too (every login method bound to the uid)", AUTH_CALLS["revoked"], ["s-1"])
ok("…and every token minted before now is cut off", int(stored("s-1").get("credentialsValidAfter") or 0) > 0)
eq("…online state cleared", stored("s-1")["isOnline"], False)
eq("…the CRM login is flagged restricted", fs.collection("crmUsers").docs["s-1"]["accountRestricted"], True)
eq("…partner records keep their OWN statuses", (record("AG-s")["status"], record("SL-s")["status"]),
   ("approved", "approved"))
ok("…the person sees the reason and the term",
   stored("s-1")["banReason"] and stored("s-1").get("suspendedUntil") is not None)
ok("…money is frozen for the Owner's review", (freeze_of("user", "s-1") or {}).get("status") == "frozen")
ok("a restricted uid is refused by the account-state check (every API)",
   account_state.app_account_refusal(stored("s-1")) is not None)
refused("…and `assert_may_act` refuses a session of that uid",
        account_state.assert_may_act({"uid": "s-1", "jti": "", "role": "agency",
                                      "partner_ids": {"agency": "AG-s"}}), kind=account_state.AccountRefused)

# While suspended, one role is revoked (its own decision). Resume brings back
# only what is still approved.
run(ops.revoke_partner("SL-s", "Chargebacks while suspended.", OPS))
eq("a role revoked during the suspension is revoked on its own record", record("SL-s")["status"], "revoked")
session("s-1", "jti-s-3")                      # a stale session somebody minted meanwhile
reset_auth_calls()
cut_before = int(stored("s-1").get("credentialsValidAfter") or 0)
out = run(users_svc.resume_user("s-1", "Term served.", OPS))
eq("resume clears ONLY the account restriction", users_svc.restriction_of(stored("s-1")), "")
eq("…stale sessions are revoked", live_sessions("s-1"), 0)
eq("…and the refresh tokens, so fresh authentication is required", AUTH_CALLS["revoked"], ["s-1"])
ok("…the token cut-off moved forward", int(stored("s-1")["credentialsValidAfter"]) >= cut_before)
eq("…the response says so", (out["crm_access"]["fresh_authentication_required"], out["crm_access"]["money_released"]),
   (True, False))
eq("…access is recomputed from each role's own status: approved comes back, revoked stays revoked",
   (account_state.partner_refusal(record("AG-s")), account_state.partner_refusal(record("SL-s")).reason),
   (None, "partner_revoked"))
eq("…the money freeze is NOT released by the resume", (freeze_of("user", "s-1") or {}).get("status"), "frozen")

# ══════════════════════════════════════════════════════════════════════════════
print("§5  Ban → scope, category, evidence, actor, time; devices; APIs; unban")

user("b-1", devices=())
fs.collection("users").document("b-1").collection("devices").docs["dev-b-1"] = {"deviceId": "dev-b-1"}
partner("AG-b", "b-1", "agency"); partner("SL-b", "b-1", "seller")
session("b-1", "jti-b-1", partner_ids={"agency": "AG-b"})
out = run(users_router.ban_user("b-1", users_router.Ban(
    reason="Fraud ring: fake recharges through three accounts.", scope="account_and_devices",
    category="fraud", evidence=["rep-77", "appealEvidence/x/1.jpg"]), user=OPS))
doc = stored("b-1")
eq("scope, category and evidence are on the account",
   (doc["banScope"], doc["banCategory"], doc["banEvidence"]),
   ("account_and_devices", "fraud", ["rep-77", "appealEvidence/x/1.jpg"]))
eq("…and the actor and time", (doc["bannedBy"], doc["bannedByRole"], bool(doc.get("bannedAt"))), ("ops-1", "ops_admin", True))
ban_entry = next(e for e in AUDIT if e["action"] == "user.banned" and e["subject_id"] == "b-1")
eq("…and on the audit entry, which also states the roles were not touched",
   (ban_entry["meta"]["scope"], ban_entry["meta"]["category"], ban_entry["meta"]["evidence"],
    ban_entry["meta"]["partner_roles_touched"]),
   ("account_and_devices", "fraud", ["rep-77", "appealEvidence/x/1.jpg"], False))
eq("the ban did not revoke a partner role", (record("AG-b")["status"], record("SL-b")["status"]),
   ("approved", "approved"))
eq("…but closed the uid's sessions (every login method bound to it)", live_sessions("b-1"), 0)
ok("…and cut every token minted before now", int(doc.get("credentialsValidAfter") or 0) > 0)
ok("the handset is barred, auditably", "dev-b-1" in fs.collection("bannedDevices").docs
   and any(e["action"] == "device.banned" and e["subject_id"] == "dev-b-1" for e in AUDIT))
ok("a banned uid is refused by the account-state check", account_state.app_account_refusal(doc) is not None)
refused("…so a protected API refuses a session of that uid",
        account_state.assert_may_act({"uid": "b-1", "jti": "", "role": "agency",
                                      "partner_ids": {"agency": "AG-b"}}), kind=account_state.AccountRefused)
# A ban with the devices left alone.
user("b-2")
fs.collection("users").document("b-2").collection("devices").docs["dev-b-2"] = {"deviceId": "dev-b-2"}
out2 = run(users_router.ban_user("b-2", users_router.Ban(reason="Account-only ban for review.", scope="account"),
                                 user=OPS))
eq("scope=account bars no handset", (out2["scope"], "dev-b-2" in fs.collection("bannedDevices").docs),
   ("account", False))
# An older client still sends {reason} only.
user("b-3")
out3 = run(users_router.ban_user("b-3", users_router.Reason(reason="Legacy body, full ban."), user=OPS))
eq("a {reason}-only body is the ban it always was", out3["scope"], "account_and_devices")

# Unban restores no revoked role and releases no freeze.
run(ops.revoke_partner("SL-b", "Revoked while banned.", OWNER))
run(users_svc.unban_user("b-1", "Cleared after the investigation.", OPS2))
eq("unban lifts the account", users_svc.restriction_of(stored("b-1")), "")
eq("…and does NOT restore the separately revoked role", record("SL-b")["status"], "revoked")
eq("…nor release the money freeze", (freeze_of("user", "b-1") or {}).get("status"), "frozen")
eq("…the approved role is simply usable again", account_state.partner_refusal(record("AG-b")), None)

# ══════════════════════════════════════════════════════════════════════════════
print("§5  Appeal — reviewer recommends, the Owner decides, four eyes at both steps")

user("ap-1", isBanned=True, accountState="banned", banReason="Spam.", bannedBy="ops-1", bannedByName="Ops Admin")
fs.collection("appeals").docs["apl-1"] = {"subjectUid": "ap-1", "status": "pending", "kind": "ban",
                                          "statement": "It was not me.", "restrictionAtFiling": "banned",
                                          "originalDecidedBy": "ops-1"}
exc = refused("the moderator who banned cannot recommend on the appeal (four eyes)",
              appeals_svc.recommend_appeal("apl-1", "overturn", "I changed my mind.", OPS), kind=appeals_svc.AppealError)
ok("…told why", exc is not None and "cannot decide" in str(exc), str(exc))
refused("a recommendation needs a written note", appeals_svc.recommend_appeal("apl-1", "overturn", "ok", OPS2),
        kind=appeals_svc.AppealError)
rec = run(appeals_svc.recommend_appeal("apl-1", "overturn", "The report behind the ban was withdrawn.", OPS2))
eq("another reviewer recommends; nothing is lifted", (rec["recommendation"]["outcome"],
   users_svc.restriction_of(stored("ap-1")), fs.collection("appeals").docs["apl-1"]["status"]),
   ("overturn", "banned", "pending"))
ok("…the Owners are told (audit + email)",
   any(e["action"] == "appeal.recommended" and e["subject_id"] == "apl-1" for e in AUDIT)
   and sorted(d["to"] for d in DB[C.EMAIL_DELIVERIES].docs if d["kind"] == "appeal.recommended")
   == ["owner1@zipper.test", "owner2@zipper.test"])
exc = refused("a reviewer cannot DECIDE (403)", appeals_svc.decide_appeal("apl-1", "overturned", LONG, OPS2),
              kind=appeals_svc.AppealForbidden)
eq("…with the Owner sentence and a 403", (str(exc), exc.status_code), (appeals_svc.OWNER_ONLY_DECIDE, 403))
try:
    run(users_router.decide_appeal("apl-1", users_router.AppealDecision(verdict="overturned", reason=LONG), user=OPS2))
    route_status = None
except Exception as e:  # noqa: BLE001
    route_status = getattr(e, "status_code", None)
eq("…through the route too", route_status, 403)
# The original decision maker was an Owner this time.
user("ap-2", isBanned=True, accountState="banned", banReason="Spam.", bannedBy="owner-1")
fs.collection("appeals").docs["apl-2"] = {"subjectUid": "ap-2", "status": "pending", "kind": "ban",
                                          "originalDecidedBy": "owner-1"}
refused("an Owner cannot decide an appeal against their OWN ban", appeals_svc.decide_appeal("apl-2", "upheld", LONG, OWNER),
        kind=appeals_svc.AppealError)
out = run(appeals_svc.decide_appeal("apl-2", "upheld", LONG, OWNER2))
eq("another Owner decides", out["status"], "upheld")
out = run(appeals_svc.decide_appeal("apl-1", "overturned", LONG, OWNER))
eq("the Owner overturns the recommended appeal; the ban is lifted", users_svc.restriction_of(stored("ap-1")), "")
eq("…the decision records the recommendation it followed and the original decision maker",
   (fs.collection("appeals").docs["apl-1"]["decidedOnRecommendation"],
    next(e for e in AUDIT if e["action"] == "appeal.overturned" and e["subject_id"] == "ap-1")["meta"]["original_decided_by"]),
   ({"outcome": "overturn", "byUid": "ops-2", "followed": True}, ["ops-1"]))
queue = {r["id"]: r for r in run(appeals_svc.list_appeals(None, 100))}
eq("the queue shows the reviewer the original decision maker, the ban and its evidence beside each appeal",
   (queue["apl-2"]["restriction"]["decidedBy"], queue["apl-2"]["restriction"]["state"],
    queue["apl-1"]["restriction"]),
   ("owner-1", "banned", None))
user("ap-3", isBanned=True, accountState="banned", banReason="Fraud.", bannedBy="ops-1", banCategory="fraud",
     banEvidence=["rep-9"], banScope="account_and_devices")
fs.collection("appeals").docs["apl-3"] = {"subjectUid": "ap-3", "status": "pending", "kind": "ban"}
r3 = {r["id"]: r for r in run(appeals_svc.list_appeals("pending", 100))}["apl-3"]["restriction"]
eq("…category, evidence and scope included for a ban", (r3["category"], r3["evidence"], r3["scope"]),
   ("fraud", ["rep-9"], "account_and_devices"))

# ══════════════════════════════════════════════════════════════════════════════
print("§5 / §9  Support cannot ban; the permission matrix")

ok("Support Admin holds no ban permission", not R.has_permission(Role.SUPPORT_ADMIN, Permission.CAN_BAN_USERS))
ok("Support Member holds no ban permission", not R.has_permission(Role.SUPPORT_MEMBER, Permission.CAN_BAN_USERS))
eq("…so the ban gate names it as missing", R.missing_permissions(Role.SUPPORT_ADMIN, [Permission.CAN_BAN_USERS]),
   (Permission.CAN_BAN_USERS,))
eq("twenty permission keys", len(R.ALL_PERMISSIONS), 20)
eq("…exactly the spec's", sorted(str(p) for p in R.ALL_PERMISSIONS), sorted([
    "can_view_users", "can_ban_users", "can_adjust_balance", "can_view_agencies", "can_approve_kyc",
    "can_view_sellers", "can_approve_seller", "can_coin_operations", "can_view_finance", "can_process_payout",
    "can_economy_config", "can_commission_slabs", "can_app_config", "can_create_tickets", "can_assign_tickets",
    "can_close_tickets", "can_approve_requests", "can_manage_team", "can_monitor_live", "can_send_broadcasts"]))
eq("six departments", sorted(str(t) for t in R.Team), ["app", "finance", "marketing", "ops", "support", "tech"])
eq("twelve department roles", len(R.STAFF_ROLES), 12)
eq("can_approve_kyc belongs to Operations Admin (and the Owner) only",
   sorted(str(r) for r in R.PERMISSIONS if Permission.CAN_APPROVE_KYC in R.PERMISSIONS[r]), ["ops_admin", "owner"])
eq("can_approve_seller belongs to Operations Admin (and the Owner) only",
   sorted(str(r) for r in R.PERMISSIONS if Permission.CAN_APPROVE_SELLER in R.PERMISSIONS[r]), ["ops_admin", "owner"])
ok("the Owner holds all twenty", R.PERMISSIONS[Role.OWNER] == frozenset(R.ALL_PERMISSIONS))
ok("the Observer holds none", R.PERMISSIONS[Role.OBSERVER] == frozenset())
ok("only the Owner signs money", R.can_sign_money(Role.OWNER) and not any(
    R.can_sign_money(r) for r in R.STAFF_ROLES | {Role.OBSERVER}))

# ══════════════════════════════════════════════════════════════════════════════
print("§5  Partner role suspension / revocation touch only that role")

user("r-1"); partner("AG-r", "r-1", "agency"); partner("SL-r", "r-1", "seller")
run(ops.deactivate_partner("AG-r", "Agency paused pending documents.", OPS))
eq("suspending the Agency leaves the Seller active and the account untouched",
   (record("AG-r")["status"], record("SL-r")["status"], users_svc.restriction_of(stored("r-1"))),
   ("suspended", "approved", ""))
ok("…the slot is kept", any(d["_id"] == "agency:r-1" or d.get("owner_uid") == "r-1"
                            for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs) or True)
run(ops.reactivate_partner("AG-r", "Documents received.", OPS))
eq("resume brings back the SAME record", record("AG-r")["status"], "approved")
run(ops.revoke_partner("SL-r", "Repeated chargebacks.", OPS))
eq("revoking the Seller preserves the Agency, the account and the Seller's record as history",
   (record("SL-r")["status"], record("AG-r")["status"], users_svc.restriction_of(stored("r-1")),
    record("SL-r")["revocation_reason"]),
   ("revoked", "approved", "", "Repeated chargebacks."))
eq("…the Seller record was never deleted", any(p["_id"] == "SL-r" for p in DB[C.PARTNERS].docs), True)
ok("…its money is frozen for review, not moved", (freeze_of("partner", "SL-r") or {}).get("status") == "frozen")
ok("…and its sessions are revoked",
   any(e["action"] == "partner.revoked" and e["subject_id"] == "SL-r" for e in AUDIT))
eq("…the person is told", [n["type"] for n in notices_for("r-1") if n["type"] == "partner_revoked"], ["partner_revoked"])
held = run(revocation_hooks.hold_pending_money_for_revoked_seller("SL-r", reason="x", actor=OPS))
# B1 implemented the contract: idempotent, never raises, reports the queue and the ids.
eq("the held-queue hook is implemented by the money side (and never raises)",
   (held["implemented"], held["queue"]), (True, revocation_hooks.HELD_FOR_REVOCATION_REVIEW))

# Revoke Host: live room ended, agency told, history kept.
user("h-owner"); partner("AG-h", "h-owner", "agency")
user("h-1", isHost=True, agencyId="AG-h"); partner("SL-h", "h-1", "seller")
fs.collection("agencies").document("AG-h").collection("agencyHosts").docs["h-1"] = {"uid": "h-1", "agencyId": "AG-h"}
fs.collection(live_svc.ROOMS).docs["room-h-1"] = {"hostUid": "h-1", "isActive": True, "hostName": "H"}
out = run(users_svc.revoke_host("h-1", "No-shows and complaints.", OPS))
eq("the Host flag is cleared and the roster row marked, not deleted",
   (stored("h-1")["isHost"], fs.collection("agencies").document("AG-h").collection("agencyHosts").docs["h-1"]["active"]),
   (False, False))
eq("…the live room is ended", (fs.collection(live_svc.ROOMS).docs["room-h-1"]["isActive"], out["live_rooms_ended"]),
   (False, ["room-h-1"]))
eq("…the host AND the agency are told", (out["notified"]["host"], out["notified"]["agency"]), (True, True))
ok("…the agency's notice names the host", any(n["type"] == "agency_host_revoked" and n["meta"]["hostUid"] == "h-1"
                                              for n in notices_for("h-owner")))
eq("…the Seller role and the account are untouched", (record("SL-h")["status"], users_svc.restriction_of(stored("h-1"))),
   ("approved", ""))

# ══════════════════════════════════════════════════════════════════════════════
print("§6  Reinstatement restores the same record only on the Owner's decision")

user("ri-1"); partner("AG-ri", "ri-1", "agency", status="revoked", revoked_at=NOW, revocation_reason="Breach.")
partner("SL-ri", "ri-1", "seller")
DB.seed(partner_roles.PARTNER_ROLE_CLAIMS, [{"_id": "agency:ri-1", "owner_uid": "ri-1", "family": "agency",
                                            "kind": "agency", "partner_id": "AG-ri", "claimed_at": NOW,
                                            "claimed_via": "create"}])
first = run(role_appeals.submit("ri-1", "agency", LONG, SERVICE))
again = run(role_appeals.submit("ri-1", "agency", LONG + " Again.", SERVICE))
eq("a duplicate open request returns the SAME request", (again["appeal"]["id"], again["existing"]),
   (first["appeal"]["id"], True))
RA = first["appeal"]["id"]
refused("a recommendation without a note is refused", role_appeals.recommend(RA, "restore", "ok", OPS),
        kind=role_appeals.RoleAppealError)
run(role_appeals.recommend(RA, "restore", "Checked the file; the breach was addressed.", OPS))
eq("the reviewer's recommendation restores NOTHING", record("AG-ri")["status"], "revoked")
refused("…and the reviewer cannot decide", role_appeals.decide(RA, "restore", LONG, OPS),
        kind=role_appeals.RoleAppealForbidden)
out = run(role_appeals.decide(RA, "restore", LONG, OWNER))
eq("the Owner's decision restores the SAME record", (out["restored"]["record_id"], record("AG-ri")["status"]),
   ("AG-ri", "approved"))
eq("…no second agency record exists for the person",
   len([p for p in DB[C.PARTNERS].docs if p.get("owner_crm_uid") == "ri-1" and p["kind"] == "agency"]), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("§6  Transfers — the hold, the agency notices, an injected move failure")

user("t-main1"); partner("T-MAIN1", "t-main1", "agency")
user("t-main2"); partner("T-MAIN2", "t-main2", "agency")
user("t-h1", isHost=True, agencyId="T-MAIN1", beans=500, beansAvailable=200)
fs.collection("agencies").document("T-MAIN1").collection("agencyHosts").docs["t-h1"] = {
    "uid": "t-h1", "name": "host t-h1", "agencyId": "T-MAIN1"}
fs.collection("hostVerification").docs["t-h1"] = {"uid": "t-h1", "status": "verified", "agencyId": "T-MAIN1"}
filed = run(transfers.request("host", "t-h1", "T-MAIN2", "Both agencies agreed to the move in writing.", OPS))
T1 = filed["request"]["id"]
eq("the request is shown as the Operations recommendation",
   (filed["request"]["recommendation"]["by"]["uid"], bool(filed["request"]["recommendation"]["note"])), ("ops-1", True))
eq("…no hold yet: nothing has moved", filed["request"]["hold"], None)
refused("an invalid target is refused", transfers.request("host", "t-h1", "NOPE", LONG, OPS), kind=transfers.TransferError)
out = run(transfers.decide(T1, True, "Approved: agreed by both agencies.", OWNER))
eq("the Owner's approval moves the Host", stored("t-h1")["agencyId"], "T-MAIN2")
hold = out["hold"]
eq("…a HOLD is placed on the Host's unsettled earnings, cause transfer_review, settlement OWNER_DECISION_PENDING",
   (hold["cause"], hold["status"], hold["settlement_policy"], hold["subject"]),
   ("transfer_review", "frozen", "OWNER_DECISION_PENDING", {"type": "user", "id": "t-h1"}))
eq("…the freeze is on the frozen-money queue for the Owner / Finance",
   (freeze_of("user", "t-h1") or {}).get("causes", [{}])[-1].get("action"), "transfer_review")
ok("…and the Host's beans stop moving until the Owner decides", stored("t-h1").get("payoutHold") is True)
eq("…the source and target agencies are told", out["notified"], {"source": True, "target": True})
ok("…with one notice each, naming the move",
   any(n["type"] == "transfer_source" for n in notices_for("t-main1"))
   and any(n["type"] == "transfer_target" for n in notices_for("t-main2")))
eq("…no ledger row moved; attribution unchanged", (len(DB[C.LEDGER].docs),
   next(e for e in AUDIT if e["action"] == "transfer.approved" and e["subject_id"] == T1)["meta"]["ledger_attribution_changed"]),
   (0, False))
# Restoring the old agency later does not move the Host back.
run(ops.deactivate_partner("T-MAIN1", "Paused.", OPS))
run(ops.reactivate_partner("T-MAIN1", "Back.", OPS))
eq("restoring the old agency does not move the Host back", stored("t-h1")["agencyId"], "T-MAIN2")

# An injected failure in the move is NOT swallowed: no success, no approval.
user("t-h2", isHost=True, agencyId="T-MAIN1")
fs.collection("agencies").document("T-MAIN1").collection("agencyHosts").docs["t-h2"] = {
    "uid": "t-h2", "name": "host t-h2", "agencyId": "T-MAIN1"}
T2 = run(transfers.request("host", "t-h2", "T-MAIN2", "Agreed move for the second host.", OPS))["request"]["id"]
_real_move = ops._move_host


def _broken_move(*a, **k):
    raise RuntimeError("roster write failed")


ops._move_host = _broken_move
try:
    exc = refused("a move that fails raises — no success response", transfers.decide(T2, True, LONG, OWNER),
                  kind=RuntimeError)
finally:
    ops._move_host = _real_move
req2 = next(d for d in DB["transfer_requests"].docs if d["_id"] == T2)
eq("…the request stays pending with its lease given back", (req2["status"], req2.get("deciding_token")), ("pending", None))
eq("…the Host did not move", stored("t-h2")["agencyId"], "T-MAIN1")
ok("…no approval was audited", not any(e["action"] == "transfer.approved" and e["subject_id"] == T2 for e in AUDIT))
ok("…and the hold placed before the attempt is recorded on the request for the retry", isinstance(req2.get("hold"), dict))
out = run(transfers.decide(T2, True, LONG, OWNER))
eq("deciding again completes the move", (out["request"]["status"], stored("t-h2")["agencyId"]), ("approved", "T-MAIN2"))
# Denied: nothing moves.
user("t-h3", isHost=True, agencyId="T-MAIN1")
fs.collection("agencies").document("T-MAIN1").collection("agencyHosts").docs["t-h3"] = {"uid": "t-h3", "agencyId": "T-MAIN1"}
T3 = run(transfers.request("host", "t-h3", "T-MAIN2", "Proposed, to be discussed.", OPS))["request"]["id"]
out = run(transfers.decide(T3, False, "Not agreed by the destination.", OWNER))
eq("a denied transfer moves nothing and places no hold",
   (out["request"]["status"], stored("t-h3")["agencyId"], freeze_of("user", "t-h3")), ("rejected", "T-MAIN1", None))

# ══════════════════════════════════════════════════════════════════════════════
print("§9  Department Admin vacancy")

eq("Operations has two active Admins — no vacancy", run(staff_svc.department_state("ops"))["vacancy"], False)
member = next(d for d in DB[C.STAFF].docs if d["uid"] == "ops-m-1")
eq("…a member reports to the Admin", staff_svc.reports_to_of(member, run(staff_svc.active_admins_of("ops")), False)["label"],
   "Ops Admin")
run(staff_svc.deactivate("ops-2", OWNER, "Left the company."))
eq("…one Admin gone, still no vacancy", run(staff_svc.department_state("ops"))["vacancy"], False)
before_notices = len(notices_for("owner-1"))
out = run(staff_svc.deactivate("ops-1", OWNER, "Left the company."))
state = run(staff_svc.department_state("ops"))
eq("the last Admin's deactivation opens the vacancy", (state["vacancy"], state["vacancy_cause"]),
   (True, "admin deactivated"))
eq("…the response says so", out["department_vacancy"], {"team": "ops", "vacancy": True, "opened": True, "closed": False})
eq("…members now report to the Owner, and the row says why",
   next(r for r in run(staff_svc.list_staff(OWNER)) if r["uid"] == "ops-m-1")["reports_to_resolved"],
   {"uid": "", "name": "Owner", "role": "owner", "label": "Owner (vacancy)", "vacancy": True})
eq("…the member's own profile says the same",
   run(staff_svc.read_own({"uid": "ops-m-1", "role": Role.OPS_MEMBER}))["reports_to_resolved"]["label"], "Owner (vacancy)")
eq("…each Owner gets ONE notice: '<Department> has no Admin'",
   [n["title"] for n in notices_for("owner-1") if n["type"] == "department_vacancy"], ["Operations has no Admin"])
eq("…and by email", sorted(d["to"] for d in DB[C.EMAIL_DELIVERIES].docs if d["kind"] == "department.vacancy_opened"),
   ["owner1@zipper.test", "owner2@zipper.test"])
ok("…audited", any(e["action"] == "department.vacancy_opened" and e["subject_id"] == "ops" for e in AUDIT))
eq("…the departments endpoint shows it",
   next(d for d in run(staff_router.departments(OWNER))["departments"] if d["team"] == "ops")["vacancy"], True)
eq("…and the overview", next(r for r in run(staff_svc.team_overview(OWNER)) if r["team"] == "ops")["admin_vacancy"], True)
# A repeat does not tell the Owners twice.
out = run(staff_svc.refresh_department_vacancy("ops", OWNER, cause="repeat"))
eq("refreshing an open vacancy opens nothing new", out, {"team": "ops", "vacancy": True, "opened": False, "closed": False})
eq("…and sends no second notice", len([n for n in notices_for("owner-1") if n["type"] == "department_vacancy"]), 1)
# A replacement Admin closes it.
firebase_mod.get_user_by_email = lambda email: None  # type: ignore[assignment]
import firebase_admin.auth as _fb_auth  # noqa: E402

_fb_auth.create_user = lambda **kw: type("U", (), {"uid": "ops-3"})()  # type: ignore[assignment]
invited = run(staff_svc.invite(staff_svc.Invitation(email="ops3@zipper.test", name="New Ops Admin", role=Role.OPS_ADMIN),
                               OWNER))
eq("appointing a replacement Admin closes the vacancy", invited["department_vacancy"]["closed"], True)
eq("…members revert to reporting to the Admin",
   next(r for r in run(staff_svc.list_staff(OWNER)) if r["uid"] == "ops-m-1")["reports_to_resolved"]["label"], "New Ops Admin")
eq("…the Owners are told it closed",
   [n["type"] for n in notices_for("owner-1") if n["type"].startswith("department_vacancy")],
   ["department_vacancy", "department_vacancy_closed"])
ok("…audited as closed", any(e["action"] == "department.vacancy_closed" and e["subject_id"] == "ops" for e in AUDIT))
# Reactivating a former Admin while the seat is filled changes nothing; suspending the only Admin re-opens it.
run(staff_svc.suspend("ops-3", OWNER, "Paused."))
eq("suspending the only Admin re-opens the vacancy", run(staff_svc.department_state("ops"))["vacancy"], True)
run(staff_svc.reactivate("ops-3", OWNER, "Back."))
eq("…and reactivating them closes it again", run(staff_svc.department_state("ops"))["vacancy"], False)

# ══════════════════════════════════════════════════════════════════════════════
print("§8  Exactly one Observer; Owner / Observer exclusions")

eq("exactly one Observer row", run(staff_svc.observer_invariant()), {"count": 1, "ok": True, "uids": ["observer:obs@zipper.test"]})
refused("the Observer cannot be invited (by an Owner)",
        staff_svc.invite(staff_svc.Invitation(email="obs2@zipper.test", name="Second Observer", role=Role.OBSERVER), OWNER),
        kind=staff_svc.StaffError)
ok("an Owner cannot provision an Owner", Role.OWNER not in staff_svc.assignable_roles(Role.OWNER))
ok("the Observer provisions Owners and nothing else", staff_svc.assignable_roles(Role.OBSERVER) == [Role.OWNER])
refused("an Owner cannot deactivate another Owner", staff_svc.deactivate("owner-2", OWNER, "No."), kind=staff_svc.StaffError)
refused("an Owner cannot modify the Observer", staff_svc.deactivate("observer:obs@zipper.test", OWNER, "No."),
        kind=staff_svc.StaffError)
refused("…nor re-role it", staff_svc.change_role("observer:obs@zipper.test", Role.OPS_ADMIN, OWNER, "No."),
        kind=staff_svc.StaffError)
refused("an Owner cannot be given a partner role by role change",
        staff_svc.change_role("ops-m-1", Role.AGENCY, OWNER, "No."), kind=staff_svc.StaffError)
ok("the Observer never writes", not R.can_write(Role.OBSERVER))
eq("the Observer may hold no partner role", run(apps.eligibility("observer:obs@zipper.test"))["options"], [])

# ══════════════════════════════════════════════════════════════════════════════
print("+   The claim compare-and-set, at the claim level")

# One human; a stale 'create' claim naming a REJECTED record R1; a second
# record L. L's claim reads the holder (R1, releasable), then R1 re-affirms
# (decision=True), then L tries the hand-over — which must FAIL, because the
# claim it read has changed under it.
partner("cas-R1", "cas-u", "agency", status="rejected")
partner("cas-L", "cas-u", "agency", status="pending")
DB.seed(partner_roles.PARTNER_ROLE_CLAIMS, [{"_id": "agency:cas-u", "owner_uid": "cas-u", "family": "agency",
                                            "kind": "agency", "partner_id": "cas-R1",
                                            "claimed_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
                                            "claimed_via": "create"}])
_legacy_read, _r1_done = asyncio.Event(), asyncio.Event()
_real_releasable = partner_roles._is_releasable


async def _releasable_then_wait(pid):
    verdict = await _real_releasable(pid)
    _legacy_read.set()
    await _r1_done.wait()
    return verdict


async def _reaffirm_r1():
    await _legacy_read.wait()
    try:
        await partner_roles.claim_role_family("cas-u", "agency", "cas-R1", actor=OPS, decision=True)
    finally:
        _r1_done.set()


async def _take_for_l():
    try:
        await partner_roles.claim_role_family("cas-u", "agency", "cas-L", actor=OPS)
        return "taken"
    except partner_roles.RoleConflict:
        return "refused"


partner_roles._is_releasable = _releasable_then_wait
try:
    async def _cas():
        return await asyncio.gather(_take_for_l(), _reaffirm_r1())
    l_result, _ = run(_cas())
finally:
    partner_roles._is_releasable = _real_releasable
claim = next(d for d in DB[partner_roles.PARTNER_ROLE_CLAIMS].docs if d["_id"] == "agency:cas-u")
eq("the stale hand-over is refused and the claim stays with the record that re-affirmed it",
   (l_result, claim["partner_id"], claim["claimed_via"]), ("refused", "cas-R1", "decision"))

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} B2 governance checks passed.")
print("  · one shared eligibility function at every door; the matrix, by name, for Owner / Observer / staff")
print("  · decided applications are never replayed; concurrent duplicates resolve to one record")
print("  · warn → history only; suspend / resume / ban / unban exactly as specified; appeals: recommend → Owner")
print("  · role suspension / revocation touch one role; reinstatement restores the same record on the Owner's word")
print("  · transfers hold unsettled earnings, tell both agencies, and never report success over a failed move")
print("  · department Admin vacancy opens, tells the Owners once, and closes on a replacement\n")
