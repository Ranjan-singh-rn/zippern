"""FX phase — Host decisions and Host state (FX-01, FX-10, FX-12), executed.

  FX-01  refusing a host application revokes the person's Host role ONLY when
         THIS application is what granted it (`isActivated` and
         `activatedByUid == uid` — the legacy redeemed-before-approval case).
         A leftover application of somebody who is a Host through ANOTHER
         application (a redeemed invitation; a legacy duplicate filed before
         the one-pending lock) is refused and nothing is revoked (RF-04, R1).
  FX-10  `revoke_host` marks the roster row inactive in the same write, and
         `_move_host` moves a host only from the agency it is actually under
         and stamps the application it carries (RF-15).
  FX-12  when a Host role is granted, the person's OTHER open host
         applications are superseded (RF-05/DUP-06).

REAL: services.users, services.user_roles, services.partner_ops,
      services.partner_applications.
FAKE: Mongo (`tests/harness.FakeDb`) and Firestore (`tests/fakes.FakeFirestore`) —
      the setup of tests/test_ugp_roles_warn.py.

    python3 -m tests.test_fx_host_decisions
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


class _Tx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class _Session(_Tx):
    def start_transaction(self):
        return _Tx()


class _Client:
    async def start_session(self):
        return _Session()


mongo.get_client = lambda: _Client()  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
# Decision 15 (RC): every account in these fixtures holds BOTH verified contacts
# (an SMS-linked phone and a code-verified email) — the subject of this module
# is not the contact rule, which tests/test_rc_contact_verification.py runs with
# per-uid records, verified and not.
from tests import harness as _rc_harness  # noqa: E402

firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]
AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    await DB[C.AUDIT].insert_one({"action": kw.get("action"),
                                  "subject": {"type": kw.get("subject_type"), "id": kw.get("subject_id")},
                                  "meta": kw.get("meta") or {}})
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import users as svc  # noqa: E402

# Same stub as test_ugp_roles_warn.py: the guest rule is not under test here
# (tests/test_fx_record_integrity.py runs it for real).
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


run = asyncio.run


def call(claim: str, thunk, default=None):
    """Run one step; an exception is a recorded FAILURE, and the run goes on."""
    global checks
    try:
        return thunk()
    except Exception as exc:  # noqa: BLE001
        checks += 1
        failures.append(f"{claim}\n        raised {exc.__class__.__name__}: {exc}")
        return default


STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
WHY = "Duplicate of the application this person already holds the role through."


def users():
    return fs.collection("users").docs


def user(uid: str, **over) -> None:
    users()[uid] = {"name": f"user {uid}", "accountState": "active", "isBanned": False,
                    "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, **over})


def apps_col():
    return fs.collection("hostApplications").docs


def roster(agency: str):
    return fs.collection("agencies").document(agency).collection("agencyHosts").docs


def revoked_stamped(uid: str) -> bool:
    u = users()[uid]
    return bool(u.get("hostRevokedAt") or u.get("hostRemovedAt"))


def host_revoked_notices(uid: str) -> list:
    return [d for d in fs.collection("notifications").docs.values()
            if d.get("userId") == uid and "revok" in str(d.get("type", "")).lower()]


partner("AG1", "own-ag1", "agency")
partner("AG2", "own-ag2", "agency")
user("own-ag1")
user("own-ag2")

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. FX-01 — a refusal revokes only the role THIS application granted")

# A: Host through a redeemed invitation, plus a Coin Seller role; a leftover
#    self-application for the SAME agency is refused.
user("P", isHost=True, agencyId="AG1", isVerifiedHost=True)
partner("SELLER-P", "P", "seller")
apps_col()["inv-P"] = {"agencyId": "AG1", "status": "approved", "isActivated": True,
                       "activatedByUid": "P", "hostName": "P"}
apps_col()["self-P"] = {"applicantUid": "P", "status": "pending", "agencyId": "AG1", "hostName": "P"}
res = run(svc.decide_host_application("self-P", False, WHY, STAFF))
eq("the leftover self-application is refused", apps_col()["self-P"]["status"], "rejected")
eq("…the Host role is KEPT", users()["P"].get("isHost"), True)
eq("…no revocation stamp is written", revoked_stamped("P"), False)
eq("…no 'host revoked' notice is sent", host_revoked_notices("P"), [])
eq("…the granting invitation is untouched", apps_col()["inv-P"]["status"], "approved")
eq("…and the Coin Seller role is untouched",
   next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELLER-P")["status"], "approved")
ok("…and the decision says why nothing was revoked", "another application" in str(res.get("note", "")),
   str(res.get("note")))

# B: the leftover names a DIFFERENT agency.
user("Q", isHost=True, agencyId="AG1", isVerifiedHost=True)
partner("SELLER-Q", "Q", "seller")
apps_col()["inv-Q"] = {"agencyId": "AG1", "status": "approved", "isActivated": True,
                       "activatedByUid": "Q", "hostName": "Q"}
apps_col()["self-Q"] = {"applicantUid": "Q", "status": "pending", "agencyId": "AG2", "hostName": "Q"}
run(svc.decide_host_application("self-Q", False, WHY, STAFF))
eq("a leftover for another agency: refused", apps_col()["self-Q"]["status"], "rejected")
eq("…Host role kept", users()["Q"].get("isHost"), True)
eq("…still under the agency that granted it", users()["Q"].get("agencyId"), "AG1")

# C: a LEGACY duplicate — two self-applications from before the one-pending lock;
#    the person became a Host through the first (approved, activated), the
#    second is still pending.
user("L", isHost=True, agencyId="AG1")
partner("SELLER-L", "L", "seller")
apps_col()["self-L1"] = {"applicantUid": "L", "status": "approved", "agencyId": "AG1", "isActivated": True,
                         "activatedByUid": "L", "hostName": "L"}
apps_col()["self-L2"] = {"applicantUid": "L", "status": "pending", "agencyId": "AG1", "hostName": "L"}
run(svc.decide_host_application("self-L2", False, WHY, STAFF))
eq("a legacy pending duplicate is refused", apps_col()["self-L2"]["status"], "rejected")
eq("…without touching the Host role the first one granted", users()["L"].get("isHost"), True)

# D: the application that DID grant the role (legacy order: redeemed before it
#    was approved) — refusing it still revokes, as before.
user("R", isHost=True, agencyId="AG1")
partner("SELLER-R", "R", "seller")
apps_col()["inv-R"] = {"agencyId": "AG1", "status": "pending", "isActivated": True,
                       "activatedByUid": "R", "hostName": "R"}
run(svc.decide_host_application("inv-R", False, "Documents do not match; refusing.", STAFF))
eq("refusing the application that granted the role revokes it (multi-role)", users()["R"].get("isHost"), False)
eq("…with the revocation stamp", revoked_stamped("R"), True)

# E: the single-role control — unchanged.
user("S1", isHost=True, agencyId="AG1")
apps_col()["inv-S1"] = {"agencyId": "AG1", "status": "pending", "isActivated": True,
                        "activatedByUid": "S1", "hostName": "S1"}
run(svc.decide_host_application("inv-S1", False, "Refusing.", STAFF))
eq("a single-role Host keeps the only role (suspend instead)", users()["S1"].get("isHost"), True)

# F: somebody who is not a Host at all — the refusal is just a refusal.
user("N")
apps_col()["self-N"] = {"applicantUid": "N", "status": "pending", "agencyId": "AG1", "hostName": "N"}
run(svc.decide_host_application("self-N", False, "Refusing.", STAFF))
eq("a non-Host's application is refused", apps_col()["self-N"]["status"], "rejected")
eq("…and nothing about the account changes", users()["N"].get("isHost"), None)

# ══════════════════════════════════════════════════════════════════════════════
print("2. FX-10 — the roster row follows the role; a move is conditional and stamped")

from datetime import datetime, timezone  # noqa: E402

OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
REVOKE_WHY = "Revoked after a review of repeated policy breaches."

# A multi-role Host (Host + Coin Seller) on AG1's roster, and a second Host
# beside them who must not be touched.
user("H1", isHost=True, agencyId="AG1", isVerifiedHost=True)
partner("SELLER-H1", "H1", "seller")
user("H2", isHost=True, agencyId="AG1")
partner("SELLER-H2", "H2", "seller")
roster("AG1")["H1"] = {"uid": "H1", "name": "H1", "agencyId": "AG1", "applicationId": "inv-H1"}
roster("AG1")["H2"] = {"uid": "H2", "name": "H2", "agencyId": "AG1"}
apps_col()["inv-H1"] = {"agencyId": "AG1", "status": "approved", "kycStatus": "approved",
                        "isActivated": True, "activatedByUid": "H1", "hostName": "H1",
                        "decidedByUid": "staff-1"}

# The write fails → NOTHING changes (one write, not two).
_orig_batch = fs.batch


def _failing_batch():
    b = _orig_batch()
    b.fail_on_commit = True
    return b


fs.batch = _failing_batch
try:
    run(svc.revoke_host("H1", REVOKE_WHY, STAFF, enforce_target_policy=False))
    _raised = False
except Exception:  # noqa: BLE001
    _raised = True
fs.batch = _orig_batch
ok("a failed revoke write raises", _raised)
eq("…and leaves the account a Host", users()["H1"].get("isHost"), True)
eq("…and the roster row current", roster("AG1")["H1"].get("active"), None)

call("revoke_host on a multi-role Host", lambda: run(svc.revoke_host("H1", REVOKE_WHY, STAFF, enforce_target_policy=False)))
eq("revoke_host: the account is no longer a Host", users()["H1"].get("isHost"), False)
eq("…the roster row is marked inactive in the same write", roster("AG1")["H1"].get("active"), False)
eq("…with why", roster("AG1")["H1"].get("removedReason"), "revoked")
ok("…and when", roster("AG1")["H1"].get("removedAt") is not None)
ok("…the row is KEPT (history), not deleted", "H1" in roster("AG1"))
eq("…the other Host on the roster is untouched", roster("AG1")["H2"].get("active"), None)
eq("…and the person's Coin Seller role is untouched",
   next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELLER-H1")["status"], "approved")
eq("a reader of the roster sees one current host",
   call("roster_row_is_current", lambda: [u for u, row in roster("AG1").items()
                                          if svc.roster_row_is_current(row) and u in ("H1", "H2")]), ["H2"])
eq("…and the backend's own roster reader skips the revoked row",
   sorted(h["uid"] for h in ops._hosts_of("AG1") if h["uid"] in ("H1", "H2")), ["H2"])

# A Host with no roster row at all (activated before rows existed): revoked as
# before, and no phantom row is created.
user("H3", isHost=True, agencyId="AG1")
partner("SELLER-H3", "H3", "seller")
call("revoke_host with no roster row", lambda: run(svc.revoke_host("H3", REVOKE_WHY, STAFF, enforce_target_policy=False)))
eq("a Host with no roster row is revoked as before", users()["H3"].get("isHost"), False)
ok("…and no roster row is invented", "H3" not in roster("AG1"))

# Restored → the SAME row, current again, nothing left of the removal.
partner("AG1-MONGO-CHECK", "nobody", "agency")  # unrelated record; must not matter
try:
    run(svc.restore_host("H1", "Reinstated after the review was overturned.", OWNER,
                         enforce_target_policy=False))
    _restored = True
except Exception as exc:  # noqa: BLE001
    _restored = False
    failures.append(f"restore_host raised: {exc}")
if _restored:
    eq("restore_host: the same row is current again", roster("AG1")["H1"].get("active"), True)
    ok("…and nothing of the removal is left",
       "removedAt" not in roster("AG1")["H1"] and "removedReason" not in roster("AG1")["H1"])

# ── _move_host: compare-and-set on users.agencyId, and the application stamped
user("M1", isHost=True, agencyId="AG1")
roster("AG1")["M1"] = {"uid": "M1", "name": "M1", "agencyId": "AG1", "applicationId": "inv-M1"}
apps_col()["inv-M1"] = {"agencyId": "AG1", "status": "approved", "isActivated": True,
                        "activatedByUid": "M1", "hostName": "M1"}
NOW = datetime.now(timezone.utc)
row_as_read = dict(roster("AG1")["M1"], uid="M1")
eq("a move from the agency the host is under succeeds",
   ops._move_host(row_as_read, "AG1", "AG2", NOW), True)
eq("…the account now names AG2", users()["M1"].get("agencyId"), "AG2")
ok("…the row moved", "M1" in roster("AG2") and "M1" not in roster("AG1"))
eq("…and the application it joined on is stamped",
   (apps_col()["inv-M1"].get("transferredTo"), apps_col()["inv-M1"].get("transferredFrom")), ("AG2", "AG1"))

# The second of two moves that both read the host under AG1 (RF-31): refused,
# nothing written.
writes_before = dict(users()["M1"])
eq("a stale second move (still thinks AG1) is refused", ops._move_host(row_as_read, "AG1", "AG3", NOW), False)
eq("…the account is unchanged", users()["M1"], writes_before)
ok("…and no roster row appears under AG3", "M1" not in roster("AG3"))
eq("…and the stamp still names the real move", apps_col()["inv-M1"].get("transferredTo"), "AG2")
eq("a repeated identical move is a no-op too (redelivery)", ops._move_host(row_as_read, "AG1", "AG2", NOW), False)

# ══════════════════════════════════════════════════════════════════════════════
print("3. FX-13 — revoke with dependents: nothing swallowed, resumable")

partner("AGX", "own-agx", "agency", type="main")
partner("SELLER-AGX", "own-agx", "seller")  # UGP-B: the owner holds a second role
partner("AGT", "own-agt", "agency", type="main")  # where the dependents go
user("own-agx")
user("own-agt")
for uid in ("X1", "X2", "X3"):
    user(uid, isHost=True, agencyId="AGX")
    roster("AGX")[uid] = {"uid": uid, "name": uid, "agencyId": "AGX"}
# X2 was revoked earlier: its row is history, not a dependent.
users()["X2"]["isHost"] = False
roster("AGX")["X2"].update({"active": False, "removedReason": "revoked"})

_real_move = ops._move_host


def _flaky_move(host, *a, **k):
    if host.get("uid") == "X3":
        raise RuntimeError("simulated Firestore outage")
    return _real_move(host, *a, **k)


ops._move_host = _flaky_move
res = call("revoke with a failing host move", lambda: run(ops.revoke_partner(
    "AGX", "Closing the agency after review.", OWNER, transfer_to="AGT")), {}) or {}
ops._move_host = _real_move
moved = res.get("dependents_moved") or {}
eq("the agency is revoked", next(p for p in DB[C.PARTNERS].docs if p["_id"] == "AGX")["status"], "revoked")
eq("the host that could move, moved", moved.get("hosts"), ["X1"])
eq("…the failure is REPORTED by name, not swallowed", [f["uid"] for f in moved.get("failed_hosts", [])], ["X3"])
eq("…the revoked Host's row is not a dependent (not moved)", users()["X2"].get("agencyId"), "AGX")
eq("…the outcome says incomplete", moved.get("complete"), False)
ok("…and the note says how to finish", "Run Revoke again" in str(res.get("note", "")), str(res.get("note")))
eq("…recorded on the record, so it can be resumed",
   (next(p for p in DB[C.PARTNERS].docs if p["_id"] == "AGX").get("dependents_transfer") or {}).get("failed_hosts"),
   ["X3"])

res2 = call("Revoke again to resume", lambda: run(ops.revoke_partner("AGX", "Finishing the move.", OWNER)), {}) or {}
eq("Revoke again RESUMES: the rest is moved", (res2.get("resumed"), (res2.get("dependents_moved") or {}).get("hosts")),
   (True, ["X3"]))
eq("…X3 is now under AGT", users()["X3"].get("agencyId"), "AGT")
eq("…complete", (res2.get("dependents_moved") or {}).get("complete"), True)
eq("…X1 was not moved twice", users()["X1"].get("agencyId"), "AGT")
try:
    run(ops.revoke_partner("AGX", "Once more.", OWNER))
    _again = None
except ops.PartnerOpsError as exc:
    _again = str(exc)
ok("with nothing left, Revoke again says it was already revoked", bool(_again) and "already revoked" in _again,
   str(_again))
try:
    partner("AGY", "own-agy", "agency", type="main")
    partner("SELLER-AGY", "own-agy", "seller")
    user("Y1", isHost=True, agencyId="AGY")
    roster("AGY")["Y1"] = {"uid": "Y1", "name": "Y1", "agencyId": "AGY"}
    ops._move_host = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
    call("revoke AGY with every move failing", lambda: run(ops.revoke_partner(
        "AGY", "Closing the agency after review.", OWNER, transfer_to="AGT")))
    ops._move_host = _real_move
    _nonowner = None
    try:
        run(ops.revoke_partner("AGY", "Finishing.", STAFF))
    except ops.PartnerOpsError as exc:
        _nonowner = exc
    ok("resuming a transfer is the Owner's, like the first attempt",
       isinstance(_nonowner, ops.PartnerOpsForbidden), repr(_nonowner))
finally:
    ops._move_host = _real_move

# ══════════════════════════════════════════════════════════════════════════════
print("4. FX-12 — a grant supersedes the person's other open applications")

LOCKS = DB[apps.HOST_APPLICATION_LOCKS]
user("G1")
apps_col()["self-G1-a"] = {"applicantUid": "G1", "status": "pending", "kycStatus": "submitted",
                           "agencyId": "AG1", "hostName": "G1", "callRate": 300}
apps_col()["self-G1-b"] = {"applicantUid": "G1", "status": "pending", "kycStatus": "submitted",
                           "agencyId": "AG2", "hostName": "G1"}  # a legacy duplicate
apps_col()["self-G1-old"] = {"applicantUid": "G1", "status": "rejected", "kycStatus": "rejected",
                             "rejectionReason": "earlier refusal", "agencyId": "AG1"}
apps_col()["inv-G1-contact"] = {"agencyId": "AG1", "status": "approved", "applicantPhone": "+919800000777",
                                "hostName": "G1 by contact"}  # names no account
user("G2")
apps_col()["self-G2"] = {"applicantUid": "G2", "status": "pending", "kycStatus": "submitted", "agencyId": "AG1"}
run(LOCKS.insert_one({"_id": "G1", "application_id": "self-G1-b"}))

g = call("grant_host on an application", lambda: run(svc.grant_host(
    "G1", "AG1", "Approved after review of the documents.", STAFF,
    meta={"application_id": "self-G1-a"}, enforce_target_policy=False)), {}) or {}
eq("the grant made G1 a Host", users()["G1"].get("isHost"), True)
b = apps_col()["self-G1-b"]
eq("the OTHER pending self-application is closed — both status fields",
   (b.get("status"), b.get("kycStatus")), ("rejected", "rejected"))
eq("…naming the application that granted the role", b.get("supersededBy"), "self-G1-a")
ok("…and saying why", "became a Host through another application" in str(b.get("rejectionReason")),
   str(b.get("rejectionReason")))
eq("…its B32 lock is released", run(LOCKS.find_one({"_id": "G1"})), None)
eq("…and the grant reports it", g.get("superseded_applications"), ["self-G1-b"])
eq("the application being granted is not superseded", apps_col()["self-G1-a"].get("supersededBy"), None)
eq("an earlier refusal keeps its own reason", apps_col()["self-G1-old"].get("rejectionReason"), "earlier refusal")
eq("an invitation that names no account is not touched (it is flagged on /kyc instead)",
   apps_col()["inv-G1-contact"].get("status"), "approved")
eq("another person's pending application is untouched", apps_col()["self-G2"].get("status"), "pending")

# A direct grant while an application is pending is still REFUSED (unchanged:
# the pending application is decided instead) — and nothing is superseded.
user("G3")
apps_col()["self-G3"] = {"applicantUid": "G3", "status": "pending", "kycStatus": "submitted", "agencyId": "AG1"}
try:
    run(svc.grant_host("G3", "AG1", "Granted directly by staff after a call.", STAFF, enforce_target_policy=False))
    _direct = None
except svc.UserError as exc:
    _direct = str(exc)
ok("a direct grant beside a pending application is still refused (unchanged)",
   bool(_direct) and "already with a reviewer" in _direct, str(_direct))
eq("…and the pending application is left exactly as it was",
   (apps_col()["self-G3"].get("status"), apps_col()["self-G3"].get("supersededBy")), ("pending", None))

# Repeated: nothing more happens, nothing is reopened.
before_b = dict(apps_col()["self-G1-b"])
eq("superseding again closes nothing new",
   call("supersede again", lambda: run(svc.supersede_other_host_applications("G1", "self-G1-a", STAFF))), [])
eq("…and leaves the closed one exactly as it was", apps_col()["self-G1-b"], before_b)

# Refusing the superseded one later is refused as already decided — the RF-04
# path to taking the role away does not exist any more.
try:
    run(svc.decide_host_application("self-G1-b", False, "Refusing the duplicate.", STAFF))
    _dup = None
except Exception as exc:  # noqa: BLE001
    _dup = str(exc)
ok("a superseded application cannot be refused again (already decided)",
   bool(_dup) and "already been refused" in _dup, str(_dup))
eq("…and G1 is still a Host", users()["G1"].get("isHost"), True)

# ══════════════════════════════════════════════════════════════════════════════
print("5. FX-13 — a direct restore closes the open reinstatement request")

from app.services import role_appeals as ra  # noqa: E402

STATEMENT = "I was removed by mistake; the report was about a different account entirely."


def revoked_host(uid: str) -> None:
    user(uid, isHost=True, agencyId="AG1")
    partner(f"SELLER-{uid}", uid, "seller")
    roster("AG1")[uid] = {"uid": uid, "name": uid, "agencyId": "AG1", "applicationId": f"inv-{uid}"}
    apps_col()[f"inv-{uid}"] = {"agencyId": "AG1", "status": "approved", "kycStatus": "approved",
                                "isActivated": True, "activatedByUid": uid, "hostName": uid,
                                "decidedByUid": "staff-1"}
    run(svc.revoke_host(uid, REVOKE_WHY, STAFF, enforce_target_policy=False))


def request_of(appeal_id: str) -> dict:
    return next(r for r in DB[ra.ROLE_APPEALS].docs if r["_id"] == appeal_id)


SELF = lambda uid: {"uid": uid, "name": uid, "role": "app_user"}  # noqa: E731

# The defect: a request open beside a direct restore.
revoked_host("RA1")
filed = call("file a reinstatement request", lambda: run(ra.submit("RA1", "host", STATEMENT, SELF("RA1"))), {}) or {}
rid = (filed.get("appeal") or {}).get("id", "")
ok("the request is open", bool(rid) and request_of(rid)["status"] in ra.OPEN_STATUSES)
restored = call("Owner restores RA1 directly", lambda: run(svc.restore_host(
    "RA1", "Restored directly after checking the report.", OWNER, enforce_target_policy=False)), {}) or {}
eq("the role is back", users()["RA1"].get("isHost"), True)
eq("…and the open request is CLOSED, as restored", request_of(rid)["status"] if rid else None, "restored")
eq("…saying how", ((request_of(rid).get("decision") or {}).get("via") if rid else None), "direct_restore")
eq("…its lock is released", run(DB[ra.ROLE_APPEAL_LOCKS].find_one({"_id": "RA1:host"})), None)
eq("…and the restore reports it", restored.get("closed_requests"), [rid] if rid else None)

# "Keep revoked" on a request whose role is live again (restored before this
# fix, or in a race): moot — closed as restored, no "stays revoked" notice.
revoked_host("RA2")
filed2 = call("file RA2's request", lambda: run(ra.submit("RA2", "host", STATEMENT, SELF("RA2"))), {}) or {}
rid2 = (filed2.get("appeal") or {}).get("id", "")
users()["RA2"].update({"isHost": True, "hostRestoredAt": datetime.now(timezone.utc)})  # restored outside
notices_before = len([d for d in fs.collection("notifications").docs.values() if d.get("userId") == "RA2"])
try:
    run(ra.decide(rid2, "keep_revoked", "The report stands; keeping it revoked.", OWNER))
    _moot = None
except ra.RoleAppealConflict as exc:
    _moot = str(exc)
ok("keep revoked on a live role is refused as moot", bool(_moot) and "no longer revoked" in str(_moot), str(_moot))
eq("…the request is closed as restored, not 'kept revoked'", request_of(rid2)["status"] if rid2 else None, "restored")
eq("…and the person is NOT told their role stays revoked",
   len([d for d in fs.collection("notifications").docs.values() if d.get("userId") == "RA2"]), notices_before)
eq("…the role is untouched", users()["RA2"].get("isHost"), True)

# Unchanged: keep revoked on a role that IS still revoked.
revoked_host("RA3")
filed3 = call("file RA3's request", lambda: run(ra.submit("RA3", "host", STATEMENT, SELF("RA3"))), {}) or {}
rid3 = (filed3.get("appeal") or {}).get("id", "")
call("keep RA3 revoked", lambda: run(ra.decide(rid3, "keep_revoked", "The report stands; keeping it revoked.", OWNER)))
eq("keep revoked on a still-revoked role works as before", request_of(rid3)["status"] if rid3 else None, "kept_revoked")
eq("…the role stays revoked", users()["RA3"].get("isHost"), False)

# Unchanged: the Owner restores THROUGH the request — decided once, not closed twice.
revoked_host("RA4")
filed4 = call("file RA4's request", lambda: run(ra.submit("RA4", "host", STATEMENT, SELF("RA4"))), {}) or {}
rid4 = (filed4.get("appeal") or {}).get("id", "")
dec = call("restore RA4 through the request", lambda: run(ra.decide(
    rid4, "restore", "Restored on review of the evidence.", OWNER)), {}) or {}
eq("restoring through the request decides it", request_of(rid4)["status"] if rid4 else None, "restored")
ok("…as a decision (not a direct-restore close)",
   ((request_of(rid4).get("decision") or {}).get("via") if rid4 else "x") is None)
eq("…and the role is back", users()["RA4"].get("isHost"), True)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} FX host-decision checks passed.")
