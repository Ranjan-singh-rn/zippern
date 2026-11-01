"""C3 — transfers between agencies: an admin requests, the Owner decides.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * filing: `can_approve_kyc` (or the Owner) only, with a note; the subject
    must be an ACTIVE Host on an unrestricted account, or an APPROVED
    Sub-agency — a revoked or restricted subject is refused; the destination
    must be a live main agency (or, for a Host, a live sub-agency under a live
    main agency) and must not be the current one; one open request per
    subject; the Owners are told;
  * deciding: the Owner only (403 for anyone else, through the route too);
    approve re-validates and runs the EXISTING move helpers — the host's
    agency, roster row and verification record move, a sub-agency's parent
    moves with its history — and every id stays what it was; no ledger row is
    written; reject leaves the relationship exactly as it was;
  * a revocation that would move dependents is the Owner's (403 otherwise).

REAL: services.transfer_requests, partner_ops, partner_applications,
partner_roles, users, notices; routers.transfer_requests.
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`).

    python3 -m tests.test_transfer_requests
"""

from __future__ import annotations

import asyncio
import logging
import sys
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
from tests import harness as _rc_harness  # noqa: E402

# Decision 15 (RC): every login in these fixtures holds BOTH verified contacts
# (an SMS-linked phone and a code-verified email) — the subject of this module
# is not the contact rule, which tests/test_rc_contact_verification.py runs with
# per-uid records, verified and not.
firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.routers import transfer_requests as router  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import transfer_requests as svc  # noqa: E402

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


def refused(claim: str, coro, kind=svc.TransferError):
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return None
    failures.append(f"{claim}: was NOT refused")
    return None


run = asyncio.run
ADMIN = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
FINANCE = {"uid": "fin-1", "name": "Finance Admin", "role": "finance_admin", "team": "finance"}
OWNER = {"uid": "owner-1", "name": "The Owner", "role": "owner", "team": None}
NOTE = "The host asked to move; both agencies agreed in writing."


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, **over})
    fs.collection("sellers" if kind == "seller" else "agencies").docs[pid] = {
        "agencyName" if kind != "seller" else "displayName": pid, "crmUid": owner}


def record(pid: str) -> dict:
    return next(p for p in DB[C.PARTNERS].docs if p["_id"] == pid)


def roster(agency: str):
    return fs.collection("agencies").document(agency).collection("agencyHosts").docs


def host(uid: str, agency: str, **over) -> None:
    user(uid, isHost=True, agencyId=agency, **over)
    roster(agency)[uid] = {"uid": uid, "name": f"host {uid}", "agencyId": agency}
    fs.collection("hostVerification").docs[uid] = {"uid": uid, "status": "verified", "agencyId": agency}


for o in ("o-main1", "o-main2", "o-sub1", "o-sub2", "o-susp", "o-subr"):
    user(o)
partner("MAIN1", "o-main1", "agency")
partner("MAIN2", "o-main2", "agency")
partner("MAIN-SUSP", "o-susp", "agency", status="suspended")
partner("SUB1", "o-sub1", "sub_agency", parent_id="MAIN1")
partner("SUB2", "o-sub2", "sub_agency", parent_id="MAIN2")
partner("SUB-R", "o-subr", "sub_agency", status="revoked", parent_id="MAIN1")
host("h1", "MAIN1")
host("h-susp", "MAIN1", isSuspended=True, isBanned=True, accountState="suspended")
user("h-rev", isHost=False, agencyId="MAIN1", hostRevokedAt=__import__("datetime").datetime(2026, 10, 1))
host("h4", "MAIN1")

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Filing — who may, and what may be moved where")

refused("an account without can_approve_kyc cannot request a transfer",
        svc.request("host", "h1", "MAIN2", NOTE, FINANCE), kind=svc.TransferForbidden)
refused("a note under 10 characters is refused", svc.request("host", "h1", "MAIN2", "Move", ADMIN))
exc = refused("a REVOKED Host cannot be transferred", svc.request("host", "h-rev", "MAIN2", NOTE, ADMIN))
ok("…pointed at reinstatement instead", exc is not None and "revoked" in str(exc).lower(), str(exc))
refused("a Host on a restricted account cannot be transferred", svc.request("host", "h-susp", "MAIN2", NOTE, ADMIN))
refused("a REVOKED sub-agency cannot be transferred", svc.request("sub_agency", "SUB-R", "MAIN2", NOTE, ADMIN))
refused("a sub-agency cannot go under another sub-agency", svc.request("sub_agency", "SUB1", "SUB2", NOTE, ADMIN))
refused("nobody goes to a suspended agency", svc.request("host", "h1", "MAIN-SUSP", NOTE, ADMIN))
refused("the destination must differ from the current agency", svc.request("host", "h1", "MAIN1", NOTE, ADMIN))
eq("…and none of those wrote anything", (len(DB["transfer_requests"].docs), len(DB["transfer_locks"].docs)), (0, 0))

DB.seed(C.STAFF, [{"uid": "owner-1", "role": "owner", "is_active": True,
                   "email": "owner@zipper.test", "name": "The Owner"}])
filed = run(svc.request("host", "h1", "MAIN2", NOTE, ADMIN))
T1 = filed["request"]["id"]
eq("a valid request is pending", filed["request"]["status"], "pending")
eq("…from the current agency to the chosen one",
   (filed["request"]["from_agency_id"], filed["request"]["to_agency_id"]), ("MAIN1", "MAIN2"))
eq("…requested by the admin", filed["request"]["requested_by"]["uid"], "ops-1")
eq("…holding the one-per-subject lock", DB["transfer_locks"].docs[0]["_id"], "host:h1")
ok("…the Owners are told on the audit log",
   any(e["action"] == "transfer.requested" and e["subject_id"] == T1 for e in AUDIT))
_requested_rows = [d for d in DB[C.EMAIL_DELIVERIES].docs if d["kind"] == "transfer.requested"]
ok("…and by email", "owner@zipper.test" in [d["to"] for d in _requested_rows], str(_requested_rows))
# §12 "transfer requested": the affected person and both agencies are told
# too — the host at their verified address, the agencies on their records
# (which, in this fixture, carry no address: recorded as a gap, not skipped).
ok("…the Host is told as well (§12: affected person)", "h1@x.test" in [d["to"] for d in _requested_rows],
   str([d["to"] for d in _requested_rows]))
eq("…and the agencies' owners get an in-app notice of the pending transfer, one per side",
   sorted((k, d["userId"]) for k, d in fs.collection("notifications").docs.items()
          if k in (f"transfer_{T1}_source_requested", f"transfer_{T1}_target_requested")),
   [(f"transfer_{T1}_source_requested", "o-main1"), (f"transfer_{T1}_target_requested", "o-main2")])
eq("…and NOTHING has moved yet", fs.collection("users").docs["h1"]["agencyId"], "MAIN1")
refused("a second open transfer for the same Host is refused",
        svc.request("host", "h1", "SUB2", NOTE, ADMIN), kind=svc.TransferConflict)
ok("the queue lists it", any(r["id"] == T1 for r in run(svc.list_requests(ADMIN))["requests"]))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Deciding — the Owner only")

exc = refused("a non-Owner cannot decide a transfer", svc.decide(T1, True, NOTE, ADMIN),
              kind=svc.TransferForbidden)
eq("…with the Owner sentence", str(exc), "Only the Owner can decide a transfer.")
try:
    run(router.decide_transfer(T1, router.TransferDecision(approve=True, note=NOTE), user=ADMIN))
    route_status = None
except Exception as e:  # noqa: BLE001
    route_status = getattr(e, "status_code", None)
eq("…and through the route it is a 403", route_status, 403)
eq("…and nothing moved", fs.collection("users").docs["h1"]["agencyId"], "MAIN1")

out = run(svc.decide(T1, True, "Approved: the move was agreed by both.", OWNER))
eq("the Owner approves", out["request"]["status"], "approved")
eq("the Host's agency is now the destination", fs.collection("users").docs["h1"]["agencyId"], "MAIN2")
ok("…the roster row moved with them", "h1" in roster("MAIN2") and "h1" not in roster("MAIN1"))
eq("B23: …and so did the verification record", fs.collection("hostVerification").docs["h1"]["agencyId"], "MAIN2")
eq("…which keeps its status", fs.collection("hostVerification").docs["h1"]["status"], "verified")
eq("…the Host is the same uid", out["moved"]["subject_id"], "h1")
ok("…told about the move", any(d.get("userId") == "h1" and d["type"] == "partner_transferred"
                               for d in fs.collection("notifications").docs.values()))
eq("…no ledger row was written — no money moves", len(DB[C.LEDGER].docs), 0)
ok("…the lock is released", all(d["_id"] != "host:h1" for d in DB["transfer_locks"].docs))
ok("…audited as approved", any(e["action"] == "transfer.approved" for e in AUDIT))
refused("deciding it twice is refused", svc.decide(T1, False, NOTE, OWNER), kind=svc.TransferConflict)

s = run(svc.request("sub_agency", "SUB1", "MAIN2", "Sub-agency moving to the bigger agency.", ADMIN))
run(svc.decide(s["request"]["id"], True, "Approved after talking to both agencies.", OWNER))
eq("a sub-agency's parent moves on approval", record("SUB1")["parent_id"], "MAIN2")
eq("…with the move in its history", record("SUB1")["parent_history"][-1]["from"], "MAIN1")
ok("…the sub-agency keeps its id and status", record("SUB1")["status"] == "approved")
ok("…its owner is told", any(d.get("userId") == "o-sub1" and d["type"] == "partner_transferred"
                             for d in fs.collection("notifications").docs.values()))

r = run(svc.request("sub_agency", "SUB2", "MAIN1", "Proposed move, to be discussed.", ADMIN))
rej = run(svc.decide(r["request"]["id"], False, "Not agreed — the sub-agency stays.", OWNER))
eq("a rejected transfer is rejected", rej["request"]["status"], "rejected")
eq("…and the relationship is exactly as it was", record("SUB2")["parent_id"], "MAIN2")

# Approval re-validates: the destination went down after the request.
t4 = run(svc.request("host", "h4", "MAIN2", NOTE, ADMIN))
record("MAIN2")["status"] = "suspended"
record("MAIN2")["is_active"] = False
refused("approving onto a destination that is no longer live is refused",
        svc.decide(t4["request"]["id"], True, NOTE, OWNER))
eq("…the Host stays where they were", fs.collection("users").docs["h4"]["agencyId"], "MAIN1")
eq("…and the request is still pending", next(d for d in DB["transfer_requests"].docs
                                              if d["_id"] == t4["request"]["id"])["status"], "pending")
record("MAIN2")["status"] = "approved"
record("MAIN2")["is_active"] = True

# ══════════════════════════════════════════════════════════════════════════════
print("3. A revocation that moves dependents is the Owner's")

user("o-dep")
partner("DEP", "o-dep", "agency")
partner("DEP-SELL", "o-dep", "seller")      # a second role, so one may be revoked (UGP-B)
host("h-dep", "DEP")
try:
    run(ops.revoke_partner("DEP", "Closing the agency.", ADMIN, transfer_to="MAIN1"))
    denied = None
except ops.PartnerOpsError as e:
    denied = e
ok("a non-Owner revoking an agency WITH a host is refused (403)", isinstance(denied, ops.PartnerOpsForbidden))
eq("…with the transfer sentence", str(denied), ops.OWNER_ONLY_TRANSFER.format(n=1))
eq("…and nothing changed", (record("DEP")["status"], fs.collection("users").docs["h-dep"]["agencyId"]),
   ("approved", "DEP"))
run(ops.revoke_partner("DEP", "Closing the agency.", OWNER, transfer_to="MAIN1"))
eq("the Owner's revocation moves the host", fs.collection("users").docs["h-dep"]["agencyId"], "MAIN1")
eq("…and revokes the agency", record("DEP")["status"], "revoked")
# Restoring the agency later does not undo the move: the Host stays with the
# destination until the Owner explicitly transfers them back (established rule).
run(ops.reactivate_partner("DEP", "Agency restored after review.", OWNER))
eq("restoring the agency brings back the SAME record", record("DEP")["status"], "approved")
eq("…and does NOT move its former host back (a transfer back is the Owner's own decision)",
   fs.collection("users").docs["h-dep"]["agencyId"], "MAIN1")
partner("NODEP", "o-dep2", "agency")
partner("NODEP-SELL", "o-dep2", "seller")
user("o-dep2")
run(ops.revoke_partner("NODEP", "No dependents to move.", ADMIN))
eq("a revocation with NO dependents keeps its ordinary permission", record("NODEP")["status"], "revoked")

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} transfer checks passed.")
print("  · requested by can_approve_kyc with a note; revoked / restricted subjects refused")
print("  · decided by the Owner only; approve re-validates and uses the existing moves")
print("  · ids kept, roster and verification moved, no money moved; reject changes nothing")
print("  · a revocation that moves dependents is the Owner's\n")
