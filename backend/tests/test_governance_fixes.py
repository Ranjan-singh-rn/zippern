"""The governance-phase fixes that are not a flow of their own, each pinned.

  B07  a record's owner is resolved from Mongo `owner_crm_uid`, else the
       Firestore document's `crmUid`/`ownerUid` (persisted when still empty) —
       so an agency whose Mongo link was never written still bars its owner
       from Host and from a second Agency, at submit, creation and approval;
  B17  approve / reject / reactivate / revoke write conditionally on the status
       they read and stop before any side effect; the Host decision takes a
       lease first;
  B19  joining a role never overwrites the person's own display name;
  B20  the Host selector and the application carry the agency's CURRENT name;
  B21  a sub-agency whose main agency is not live is neither offered nor
       accepted, at submit or at the decision;
  B29  the appeal four-eyes rule reads who actually banned / suspended / decided;
  B32  two Host applications at the same moment make exactly one;
  B33  a revoked Host who went on to hold a Sub-agency (a permitted order) can
       be restored;
  B37  a verification review needs a submitted capture, and writes the verdict
       and the payable flag together, conditionally;
  B39  restoring a partner revokes its sessions so the role reappears;
  B40  an appeal decision is claimed before anything is reversed;
  L3   a self-filed Host application takes contact details only from the
       verified sign-in;
  B08/B22  the activation backfill: dry run by default, conditional writes.

REAL: the services under `app/` and `scripts/backfill_host_application_activation`.
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`).

    python3 -m tests.test_governance_fixes
"""

from __future__ import annotations

import asyncio
import logging
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.services import appeals as appeals_svc  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import users as users_svc  # noqa: E402
from app.services import verification as verification_svc  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402
from scripts import backfill_host_application_activation as BF  # noqa: E402

apps.is_unverified_guest = lambda uid: False
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


def refused(claim: str, coro, kind=Exception) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run
NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
STAFF = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "The Owner", "role": "owner", "team": None}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None}
WHY = "Reviewed and decided by staff."
HOST_FORM = {"hostName": "Hema", "age": "24", "country": "IN", "callRate": "30",
             "photoUrl": ["https://x/face.jpg"], "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"]}
AGENCY_FORM = {"agencyName": "Second", "ownerName": "A", "paymentType": "india", "accountNumber": "1",
               "ifscCode": "I", "bankName": "B", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"]}

# Decision 15 (RC): a role starts only with BOTH contacts verified, so these
# fixtures hold an SMS-linked phone as well (deterministic per uid). The L3
# section below swaps in its own records on purpose.
from tests import harness as _rc_harness  # noqa: E402

firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str, owner: str | None, kind: str, status: str = "approved", *, fs_doc: dict | None = None,
            **over) -> None:
    doc = {"_id": pid, "kind": kind, "status": status, "is_active": status == "approved", "name": pid, **over}
    if owner:
        doc["owner_crm_uid"] = owner
    DB[C.PARTNERS].docs.append(doc)
    collection = "sellers" if kind == "seller" else "agencies"
    fs.collection(collection).docs[pid] = fs_doc if fs_doc is not None else {
        ("displayName" if kind == "seller" else "agencyName"): pid,
        **({"crmUid": owner} if owner else {}),
        **({"type": "sub", "parentAgencyId": over.get("parent_id")} if kind == "sub_agency" else {}),
    }


def record(pid: str) -> dict:
    return next(p for p in DB[C.PARTNERS].docs if p["_id"] == pid)


def host_apps_of(uid: str) -> list[dict]:
    return [d for d in fs.collection("hostApplications").docs.values() if d.get("applicantUid") == uid]


user("main-owner")
partner("MAIN", "main-owner", "agency")

# ══════════════════════════════════════════════════════════════════════════════
print("\nB07 — the owner of a record whose Mongo link was never written")

user("b7-owner")
partner("AGX", None, "agency", fs_doc={"agencyName": "AGX", "crmUid": "b7-owner"})
el = run(apps.eligibility("b7-owner"))
eq("an agency known only by its Firestore crmUid is held by its owner",
   [p["id"] for p in el["held"]["partners"]], ["AGX"])
eq("…so the owner may add a Coin Seller only", el["options"], ["seller"])
eq("…and the link is persisted onto the Mongo record", record("AGX").get("owner_crm_uid"), "b7-owner")
m = refused("…the owner is refused Host", apps.submit_host_application("b7-owner", HOST_FORM, "MAIN", SERVICE),
            kind=PartnerOpsError)
ok("…as an Agency", "cannot also be a Host" in m, m)
refused("…and a second Agency", apps.submit_partner_application("b7-owner", "agency", AGENCY_FORM, None, SERVICE),
        kind=PartnerOpsError)
fs.collection("agencies").docs["AGZ"] = {"agencyName": "AGZ", "crmUid": "b7-owner", "crmId": "AGZ00001"}
refused("…including through CRM creation", ops.create_partner("AGZ", "Registered by staff.", STAFF),
        kind=PartnerOpsError)
ok("…which creates no record", all(p["_id"] != "AGZ" for p in DB[C.PARTNERS].docs))

user("someone-else")
partner("AGY", "someone-else", "agency", fs_doc={"agencyName": "AGY", "crmUid": "b7-owner"})
ok("a Mongo owner naming somebody else wins over the Firestore document",
   "AGY" not in [p["id"] for p in run(apps.eligibility("b7-owner"))["held"]["partners"]])
eq("…and is never overwritten", record("AGY")["owner_crm_uid"], "someone-else")

user("b7-w")
partner("AGW", None, "agency", fs_doc={"agencyName": "AGW", "ownerUid": "b7-w"})
m = refused("own-agency check sees the resolved owner (ownerUid)", apps._validate_host_parent("AGW", "b7-w"),
            kind=PartnerOpsError)
ok("…saying so", "own agency" in m, m)

user("b7-host", isHost=True, agencyId="MAIN")
partner("AGH", None, "agency", status="pending", fs_doc={"agencyName": "AGH", "crmUid": "b7-host"})
m = refused("approval re-checks an owner known only from Firestore: a Host's agency is refused",
            ops.approve_partner("AGH", WHY, STAFF), kind=PartnerOpsError)
eq("…and it stays pending", record("AGH")["status"], "pending")

# ══════════════════════════════════════════════════════════════════════════════
print("B20 / B21 — the agencies a Host may choose")

user("named-owner")
partner("NAMED", "named-owner", "agency", name="Old Name", fs_doc={"agencyName": "New Name", "crmUid": "named-owner"})
user("subn-owner")
partner("SUBN", "subn-owner", "sub_agency", name="Sub Old", parent_id="NAMED", parent_name="Old Name",
        fs_doc={"agencyName": "Sub New", "type": "sub", "parentAgencyId": "NAMED", "crmUid": "subn-owner"})
user("ms-owner")
partner("MAIN-S", "ms-owner", "agency", status="suspended")
user("sus-owner")
partner("SUB-UNDER-S", "sus-owner", "sub_agency", parent_id="MAIN-S")
rows = {r["id"]: r for r in run(apps.eligible_parents("host"))}
eq("B20: the selector shows the agency's CURRENT name", rows["NAMED"]["name"], "New Name")
eq("B20: …and a sub-agency's current name and its parent's",
   (rows["SUBN"]["name"], rows["SUBN"]["parent_name"]), ("Sub New", "New Name"))
ok("B21: a sub-agency under a suspended main agency is not offered", "SUB-UNDER-S" not in rows)
ok("B21: …nor is the suspended main agency", "MAIN-S" not in rows)
user("b20-host")
h = run(apps.submit_host_application("b20-host", HOST_FORM, "NAMED", SERVICE))
eq("B20: the application carries the current name",
   fs.collection("hostApplications").docs[h["id"]]["agencyName"], "New Name")
user("b21-host")
m = refused("B21: a Host application under that sub-agency is refused",
            apps.submit_host_application("b21-host", HOST_FORM, "SUB-UNDER-S", SERVICE), kind=PartnerOpsError)
ok("B21: …saying its main agency is not active", "main agency" in m, m)

user("ml-owner")
partner("MAIN-L", "ml-owner", "agency")
user("sl-owner")
partner("SUB-L", "sl-owner", "sub_agency", parent_id="MAIN-L")
user("b21-late")
late = run(apps.submit_host_application("b21-late", HOST_FORM, "SUB-L", SERVICE))
record("MAIN-L").update({"status": "suspended", "is_active": False})
refused("B21/B18: approving it after the main agency was suspended is refused",
        users_svc.decide_host_application(late["id"], True, WHY, STAFF), kind=users_svc.UserError)
eq("…the application is still pending", fs.collection("hostApplications").docs[late["id"]]["status"], "pending")
ok("…and nobody was made a Host", not fs.collection("users").docs["b21-late"].get("isHost"))
ok("B17: …and its decision lease was given back",
   "decisionInFlight" not in fs.collection("hostApplications").docs[late["id"]])

# ══════════════════════════════════════════════════════════════════════════════
print("B32 — two Host applications at the same moment")

user("b32")


async def _two():
    return await asyncio.gather(
        apps.submit_host_application("b32", HOST_FORM, "MAIN", SERVICE),
        apps.submit_host_application("b32", HOST_FORM, "MAIN", SERVICE),
        return_exceptions=True,
    )


r1, r2 = run(_two())
eq("exactly one of two concurrent applications is filed", sum(1 for r in (r1, r2) if isinstance(r, dict)), 1)
ok("…the other is refused, not crashed", any(isinstance(r, PartnerOpsError) for r in (r1, r2)))
eq("…and one application document exists", len(host_apps_of("b32")), 1)
winner = next(r for r in (r1, r2) if isinstance(r, dict))
fs.collection("hostApplications").docs[winner["id"]]["status"] = "rejected"   # decided, lock left behind
again = run(apps.submit_host_application("b32", HOST_FORM, "MAIN", SERVICE))
ok("a lock whose application was decided does not bar a new one", again["id"] != winner["id"])
eq("…and the lock now names the new application",
   next(d for d in DB[apps.HOST_APPLICATION_LOCKS].docs if d["_id"] == "b32")["application_id"], again["id"])

# ══════════════════════════════════════════════════════════════════════════════
print("L3 — contact details only from the verified sign-in")

user("l3", phone="+919999999999", email="typed@x.test")
firebase_mod.get_user = lambda uid: types.SimpleNamespace(  # type: ignore[assignment]
    uid=uid, email="typed@x.test", email_verified=False, phone_number="")
l3 = run(apps.submit_host_application("l3", {**HOST_FORM, "applicantPhone": "+911111111111",
                                              "applicantEmail": "form@x.test"}, "MAIN", SERVICE))
d = fs.collection("hostApplications").docs[l3["id"]]
eq("an unverified email and typed contacts reach no application", (d["applicantPhone"], d["applicantEmail"]), ("", ""))
firebase_mod.get_user = lambda uid: types.SimpleNamespace(  # type: ignore[assignment]
    uid=uid, email=f"{uid}@x.test", email_verified=True, phone_number="+918888888888")
user("l3b")
d2 = fs.collection("hostApplications").docs[run(apps.submit_host_application("l3b", HOST_FORM, "MAIN", SERVICE))["id"]]
eq("a verified phone and email do", (d2["applicantPhone"], d2["applicantEmail"]), ("+918888888888", "l3b@x.test"))
firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]

# ══════════════════════════════════════════════════════════════════════════════
print("B33 — restoring a Host who went on to hold a Sub-agency")

user("m33b")
partner("MAIN-33B", "m33b", "agency")
# RC (confirmed role rule): a Sub-agency of main Agency X may be a Host only
# directly under X. B33's restoration therefore holds for the SAME main agency;
# the old fixture (Host under MAIN, Sub-agency under MAIN-33B) is now the
# forbidden pair and is asserted refused below.
user("b33", isHost=False, agencyId="MAIN-33B", hostRevokedAt=NOW)
fs.collection("hostApplications").docs["app-b33"] = {"applicantUid": "b33", "status": "approved", "agencyId": "MAIN-33B"}
partner("SUB-33", "b33", "sub_agency", parent_id="MAIN-33B")
run(users_svc.restore_host("b33", WHY, OWNER))
eq("a Host under main agency X who holds a Sub-agency under X is restored",
   fs.collection("users").docs["b33"]["isHost"], True)
user("b33x", isHost=False, agencyId="MAIN", hostRevokedAt=NOW)
fs.collection("hostApplications").docs["app-b33x"] = {"applicantUid": "b33x", "status": "approved", "agencyId": "MAIN"}
partner("SUB-33X", "b33x", "sub_agency", parent_id="MAIN-33B")
refused("…but not as a Host under ANOTHER agency than the Sub-agency's own (RC role rule)",
        users_svc.restore_host("b33x", WHY, OWNER), kind=users_svc.UserError)
ok("…nothing written", not fs.collection("users").docs["b33x"].get("isHost"))
user("b33n", isHost=False, agencyId="MAIN-S", hostRevokedAt=NOW)
fs.collection("hostApplications").docs["app-b33n"] = {"applicantUid": "b33n", "status": "approved", "agencyId": "MAIN-S"}
partner("SUB-33N", "b33n", "sub_agency", parent_id="MAIN-S")
refused("…but not when that Sub-agency's main agency is not live",
        users_svc.restore_host("b33n", WHY, OWNER), kind=users_svc.UserError)
ok("…nothing written", not fs.collection("users").docs["b33n"].get("isHost"))

# ══════════════════════════════════════════════════════════════════════════════
print("B17 / B39 — partner decisions are conditional on the status they read")

user("b17-owner")
partner("B17", "b17-owner", "agency", status="pending")
_real = ops._enforce_role_rules_at_decision


async def _a_rejection_lands_meanwhile(partner_doc, actor, **kw):
    await _real(partner_doc, actor, **kw)
    record("B17")["status"] = "rejected"


ops._enforce_role_rules_at_decision = _a_rejection_lands_meanwhile
try:
    m = refused("an approval whose record moved under it stops", ops.approve_partner("B17", WHY, STAFF),
                kind=PartnerOpsError)
finally:
    ops._enforce_role_rules_at_decision = _real
ok("…saying it changed", "changed" in m, m)
eq("…the concurrent decision stands", record("B17")["status"], "rejected")
ok("…and nothing after the write ran — no approval audit, no notice",
   not any(e["action"] == "partner.approved" and e["subject_id"] == "B17" for e in AUDIT)
   and not any(n.get("userId") == "b17-owner" and n["type"] == "partner_approved"
               for n in fs.collection("notifications").docs.values()))

user("b17r-owner")
partner("B17R", "b17r-owner", "seller", status="pending")
_real_now = ops._now


def _an_approval_lands_meanwhile():
    record("B17R")["status"] = "approved"
    return _real_now()


ops._now = _an_approval_lands_meanwhile
try:
    refused("a rejection whose record moved under it stops", ops.reject_partner("B17R", WHY, STAFF),
            kind=PartnerOpsError)
finally:
    ops._now = _real_now
eq("…the concurrent approval stands", record("B17R")["status"], "approved")

user("b17v-owner")
partner("B17V", "b17v-owner", "agency")
partner("B17V-S", "b17v-owner", "seller")
_real_target = ops._transfer_target


async def _a_suspension_lands_meanwhile(*a, **kw):
    record("B17V")["status"] = "suspended"
    return await _real_target(*a, **kw)


ops._transfer_target = _a_suspension_lands_meanwhile
try:
    refused("a revocation whose record moved under it stops", ops.revoke_partner("B17V", WHY, STAFF),
            kind=PartnerOpsError)
finally:
    ops._transfer_target = _real_target
eq("…the concurrent suspension stands", record("B17V")["status"], "suspended")

user("b39-owner")
partner("B39", "b39-owner", "seller", status="suspended")
partner("B39-AG", "b39-owner", "agency")
DB[C.SESSIONS].docs.append({"jti": "b39-j", "uid": "b39-owner", "revoked": False})
out = run(ops.reactivate_partner("B39", WHY, STAFF))
eq("C2: a role-level SUSPENSION is still lifted with the ordinary permission", record("B39")["status"], "approved")
eq("B39: restoring revokes the sessions that lack the capability", out["sessions_revoked"], 1)
ok("…for real", next(s for s in DB[C.SESSIONS].docs if s["jti"] == "b39-j")["revoked"] is True)

user("b17-host")
fs.collection("hostApplications").docs["app-b17"] = {"applicantUid": "b17-host", "status": "pending",
                                                     "agencyId": "MAIN", "hostName": "Hema"}
ref = fs.collection("hostApplications").document("app-b17")
lease = firebase_mod.claim_decision(ref, expected_status="pending", actor_uid="other-reviewer",
                                    default_status="pending")
m = refused("B17: a Host decision while another is in flight is refused",
            users_svc.decide_host_application("app-b17", True, WHY, STAFF), kind=users_svc.UserError)
ok("…saying somebody else is deciding", "Somebody else" in m, m)
ok("…and nobody was granted", not fs.collection("users").docs["b17-host"].get("isHost"))
firebase_mod.release_decision(ref, lease)
run(users_svc.decide_host_application("app-b17", True, WHY, STAFF))
eq("once the lease is given back the decision goes through", fs.collection("users").docs["b17-host"]["isHost"], True)

# ══════════════════════════════════════════════════════════════════════════════
print("B29 / B40 — appeals")


def appeal(appeal_id: str, subject: str, **over) -> None:
    fs.collection("appeals").docs[appeal_id] = {"subjectUid": subject, "status": "pending", "kind": "ban",
                                                "createdAt": NOW, **over}


MOD = lambda uid: {"uid": uid, "name": uid, "role": "app_admin", "team": "app"}  # noqa: E731
user("ap-ban", isBanned=True, accountState="banned", bannedBy="mod-a")
appeal("ap1", "ap-ban")
m = refused("B29: the moderator who BANNED cannot decide the appeal",
            appeals_svc.decide_appeal("ap1", "upheld", "The ban stands as decided.", MOD("mod-a")),
            kind=appeals_svc.AppealError)
ok("…told why", "cannot decide" in m, m)
run(appeals_svc.decide_appeal("ap1", "upheld", "The ban stands as decided.", MOD("mod-b")))
eq("…a different reviewer may", fs.collection("appeals").docs["ap1"]["status"], "upheld")
user("ap-susp", isSuspended=True, isBanned=True, accountState="suspended", suspendedBy="mod-c")
appeal("ap2", "ap-susp")
refused("B29: nor the moderator who SUSPENDED",
        appeals_svc.decide_appeal("ap2", "overturned", "It was the wrong account.", MOD("mod-c")),
        kind=appeals_svc.AppealError)
user("ap-rep")
fs.collection("reports").docs["rep1"] = {"targetUid": "ap-rep", "status": "actioned", "reviewedBy": "mod-d",
                                         "actionTaken": "warn"}
appeal("ap3", "ap-rep", kind="report", reportId="rep1")
refused("B29: nor the reviewer who decided the contested report",
        appeals_svc.decide_appeal("ap3", "overturned", "The report was not true.", MOD("mod-d")),
        kind=appeals_svc.AppealError)

user("ap-lease", isBanned=True, accountState="banned", bannedBy="mod-x")
appeal("ap4", "ap-lease")
aref = fs.collection("appeals").document("ap4")
alease = firebase_mod.claim_decision(aref, expected_status="pending", actor_uid="mod-y", default_status="pending")
m = refused("B40: an appeal decision while another is in flight is refused",
            appeals_svc.decide_appeal("ap4", "overturned", "The ban was on the wrong account.", MOD("mod-z")),
            kind=appeals_svc.AppealError)
eq("…and nothing was reversed", fs.collection("users").docs["ap-lease"]["accountState"], "banned")
firebase_mod.release_decision(aref, alease)
run(appeals_svc.decide_appeal("ap4", "overturned", "The ban was on the wrong account.", MOD("mod-z")))
eq("…once released, the overturn goes through", fs.collection("users").docs["ap-lease"]["accountState"], "active")
ok("…and leaves no lease behind", "decisionInFlight" not in fs.collection("appeals").docs["ap4"])
try:
    firebase_mod.claim_decision(aref, expected_status="pending", actor_uid="mod-q", default_status="pending")
    conflict = None
except firebase_mod.DecisionConflict as exc:
    conflict = exc
eq("B40: a decision against a status that has moved is refused", getattr(conflict, "reason", None), "changed")

# ══════════════════════════════════════════════════════════════════════════════
print("B37 — verification review")

user("v-cap")
fs.collection("hostVerification").docs["v-cap"] = {"uid": "v-cap", "status": "pending_capture"}
refused("a record still waiting for the host's capture cannot be decided",
        verification_svc.review("v-cap", "verified", "Looks like them.", STAFF),
        kind=verification_svc.VerificationError)
ok("…nothing written", not fs.collection("users").docs["v-cap"].get("isVerifiedHost"))
user("v-man")
fs.collection("hostVerification").docs["v-man"] = {"uid": "v-man", "status": "pending_manual",
                                                   "captureUrl": "https://x/c.jpg"}
run(verification_svc.review("v-man", "verified", "Same person in both photos.", STAFF))
eq("a submitted capture is decided: verdict and payable flag together",
   (fs.collection("hostVerification").docs["v-man"]["status"], fs.collection("users").docs["v-man"]["isVerifiedHost"]),
   ("verified", True))
refused("a decided record cannot be decided again", verification_svc.review(
    "v-man", "rejected", "Second look.", STAFF), kind=verification_svc.VerificationError)
ok("the write is conditional on the status that was reviewed",
   verification_svc._apply_review("v-man", "pending_manual", {"status": "rejected"}, False) is False)
eq("…and wrote nothing", fs.collection("hostVerification").docs["v-man"]["status"], "verified")

# ══════════════════════════════════════════════════════════════════════════════
print("B19 — joining a role never renames the person")

fs.collection("users").docs["b19"] = {"name": "Asha", "isProfileComplete": True}
crm._attach_app_identity(uid="b19", email="b19@x.test", phone="", name="Skyline Agency", crm_role="agency")
eq("an existing app account keeps its own name", fs.collection("users").docs["b19"]["name"], "Asha")
crm._attach_app_identity(uid="b19-new", email="b19new@x.test", phone="", name="Skyline Agency", crm_role="agency")
eq("…a document being created is seeded with it", fs.collection("users").docs["b19-new"]["name"], "Skyline Agency")

# ══════════════════════════════════════════════════════════════════════════════
print("B08 / B22 — the activation backfill")

bf = FakeFirestore()
DECIDED = datetime(2026, 9, 1, tzinfo=timezone.utc)
bf.collection("users").docs.update({"u1": {"isHost": True}, "u2": {"isHost": False}, "u6": {"isHost": True}})
bf.collection("hostApplications").docs.update({
    "a1": {"status": "approved", "applicantUid": "u1", "isActivated": False, "decidedAt": DECIDED},
    "a2": {"status": "approved", "applicantUid": "u2", "isActivated": False},
    "a3": {"status": "approved", "isActivated": False},
    "a4": {"status": "pending", "applicantUid": "u1", "isActivated": False},
    "a5": {"status": "approved", "applicantUid": "u1", "isActivated": True},
    "a6": {"status": "approved", "applicantUid": "u6", "isActivated": False},
})
before = {k: dict(v) for k, v in bf.collection("hostApplications").docs.items()}
planned = BF.run(bf, apply=False)
eq("the plan is exactly the approved, unactivated self-filed applications of current Hosts",
   sorted(r["application_id"] for r in planned), ["a1", "a6"])
eq("…and a dry run writes nothing", bf.collection("hostApplications").docs, before)
bf.collection("users").docs["u6"]["isHost"] = False          # changed since the plan was made
results = {r["application_id"]: BF.apply_one(bf, r) for r in planned}
eq("each write is conditional on the plan still holding", results, {"a1": "APPLIED", "a6": "SKIP_NO_LONGER_APPLIES"})
a1 = bf.collection("hostApplications").docs["a1"]
eq("…it writes exactly the three fields",
   (a1["isActivated"], a1["activatedByUid"], a1["activatedAt"]), (True, "u1", DECIDED))
eq("…and nothing else changed", {k: v for k, v in a1.items() if k not in ("isActivated", "activatedByUid", "activatedAt")},
   {k: v for k, v in before["a1"].items() if k != "isActivated"})
eq("a second run finds nothing to do", BF.run(bf, apply=False), [])
src = (ROOT / "scripts" / "backfill_host_application_activation.py").read_text()
ok("--apply is required to write", '"--apply", action="store_true"' in src and "if not args.apply" in src)

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} governance-fix checks passed.")
print("  · owners resolved from Firestore when Mongo lacks the link; decisions conditional")
print("  · current agency names; dead parents not offered; one Host application at a time")
print("  · four eyes on the real decider; appeal and Host decisions claimed first")
print("  · verification decided only on a capture, atomically; the backfill dry-runs\n")
