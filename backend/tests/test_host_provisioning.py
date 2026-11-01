"""`grant_host` — the staff escape hatch, and the dead end it used to lead to.

── THE DEFECT ────────────────────────────────────────────────────────────────

There are two ways to become a host. `activateHost` (functions/src/hosts.ts) is
the normal one: the person redeems their agency's referral code and the function
writes four things in a transaction — the application, the user document, the
VERIFICATION RECORD, and the agency's roster row.

`grant_host` is the escape hatch for somebody who cannot redeem a code, and it
wrote three of the four. The missing one was the verification record, and
`submitHostCapture` refuses outright when it is absent:

    "Verification has not been set up for this account. Ask your agency to
     register you."

So a host created this way could never submit a face capture, could never be
verified, and `isVerifiedHost` gates going live, earning at their own call rate
and every weekly payout release. The escape hatch for a host who could not
redeem a code produced a host who could never be paid — and looked completely
healthy on every CRM screen, because every screen reads the user document.

── WHAT THESE TESTS HOLD SHUT ────────────────────────────────────────────────

  * the record is created, with the exact fields its readers index on;
  * `isVerifiedHost` is NOT set, in either path — host status is a statement
    about an agency relationship, verification is one about a face;
  * `status: 'pending_capture'`, which is deliberately absent from
    `services/verification.py::REVIEWABLE`, so it does not appear in a
    reviewer's queue before the host has submitted anything;
  * an existing record is left ALONE — a merge resetting `attemptCount` to zero
    and rewriting `createdAt` would undo a reviewer's work;
  * the write is atomic with the user document, so a failure cannot leave the
    half-created host this whole fix is about.

Run:  python3 -m tests.test_host_provisioning
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.services import users as svc  # noqa: E402

store = FakeFirestore()
firebase_mod.firestore_client = lambda: store

audit_entries: list[dict] = []


async def fake_audit_record(**kwargs):
    audit_entries.append(kwargs)
    return "audit-id"


audit_mod.record = fake_audit_record

# `users.ensure_ordinary_target` reads the Mongo `staff` collection to decide
# whether a subject is a protected internal identity. This file stubs the
# audit writer rather than using a FakeDb, so the service gets an empty one:
# every subject here is an ordinary app user, which is exactly what "no staff
# row" means.
_staff_db = FakeDb()
svc.get_db = lambda: _staff_db  # type: ignore[assignment]
from app.services import partner_applications as _apps  # noqa: E402

# Phase 1A (AUTH-002): these fixtures are verified people; the guest refusal
# is covered by tests/test_phase1a_identity.py.
_apps.is_unverified_guest = lambda uid: False
_apps.get_db = lambda: _staff_db  # type: ignore[assignment]  — the host grant re-checks the role table
# B18: a grant re-validates the agency it attaches the Host to, so the agencies
# these fixtures name exist and are approved and active.
_staff_db.seed("partners", [
    {"_id": "agency-1", "kind": "agency", "status": "approved", "is_active": True,
     "name": "Agency One", "owner_crm_uid": "agency-owner-1"},
    {"_id": "agency-2", "kind": "agency", "status": "approved", "is_active": True,
     "name": "Agency Two", "owner_crm_uid": "agency-owner-2"},
])

OPS = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin"}

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def seed_user(uid: str, **fields) -> None:
    store.collection("users").document(uid).set({"name": "Asha", **fields})


def seed_application(app_id: str, **fields) -> None:
    store.collection("hostApplications").document(app_id).set(
        {
            "hostName": "Asha K",
            "agencyId": "agency-1",
            "callRate": 900,
            "photoUrl": "https://photos/asha.jpg",
            **fields,
        }
    )


def verification(uid: str) -> dict:
    snap = store.collection("hostVerification").document(uid).get()
    return snap.to_dict() or {} if snap.exists else {}


# ══════════════════════════════════════════════════════════════════════════════
#  The verification record is created
# ══════════════════════════════════════════════════════════════════════════════

seed_user("host-a")
seed_application("app-a")
run(svc.grant_host("host-a", "agency-1", "Could not redeem the code", OPS,
                   {"application_id": "app-a"}))

ver = verification("host-a")
ok("a granted host has a verification record at all", ver != {})
check("it is waiting for the host, not for a reviewer", ver.get("status"), "pending_capture")
check("the uid is on the document as well as being its id", ver.get("uid"), "host-a")
check("the reviewer's agency column is filled", ver.get("agencyId"), "agency-1")
check("and the name they will see", ver.get("hostName"), "Asha K")
check("the attempt counter starts at zero", ver.get("attemptCount"), 0)
check("the application is linked for the audit trail", ver.get("applicationId"), "app-a")

# The photograph the capture is compared against. Without it `submitHostCapture`
# still works — it routes to manual review with `no_agency_photo` — but with it
# the reviewer has two faces to compare instead of one.
check("the agency's photograph is carried over",
      ver.get("agencyPhotoUrl"), "https://photos/asha.jpg")

ok("timestamps are set", ver.get("createdAt") is not None and ver.get("updatedAt") is not None)

# ── The distinction that must not collapse ────────────────────────────────────
user = store.collection("users").document("host-a").get().to_dict()
check("the user is a host", user.get("isHost"), True)
ok("but is NOT verified by having been granted", user.get("isVerifiedHost") is not True)
ok("so the capture step is still ahead of them", ver.get("status") == "pending_capture")

# `pending_capture` is deliberately not reviewable. A record that appeared in the
# queue before the host had submitted anything would be a row a reviewer cannot
# action, on every granted host, for ever.
from app.services import verification as ver_svc  # noqa: E402

ok("and it does not sit in the reviewer's queue",
   "pending_capture" not in ver_svc.REVIEWABLE)


# ══════════════════════════════════════════════════════════════════════════════
#  It works with no application at all
# ══════════════════════════════════════════════════════════════════════════════

seed_user("host-b")
run(svc.grant_host("host-b", "agency-2", "Direct grant, no invitation", OPS))

ver_b = verification("host-b")
ok("a grant with no application still opens verification", ver_b != {})
check("with no photograph to compare against", ver_b.get("agencyPhotoUrl"), "")
check("and no application id", ver_b.get("applicationId"), "")
check("but the agency is still recorded", ver_b.get("agencyId"), "agency-2")
# `submitHostCapture` handles the empty photograph by routing to manual review
# with `manualReason: 'no_agency_photo'`. The host can still get verified; a
# human simply has nothing to compare and says so.
check("the host can still reach the capture step", ver_b.get("status"), "pending_capture")


# ══════════════════════════════════════════════════════════════════════════════
#  An existing record is never trampled
# ══════════════════════════════════════════════════════════════════════════════

seed_user("host-c")
store.collection("hostVerification").document("host-c").set(
    {
        "uid": "host-c",
        "status": "pending_manual",
        "attemptCount": 3,
        "captureUrl": "https://captures/host-c.jpg",
        "createdAt": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "lastRejectedAt": datetime(2026, 2, 1, tzinfo=timezone.utc),
    }
)

run(svc.grant_host("host-c", "agency-1", "Re-granting after a revoke", OPS))

ver_c = verification("host-c")
check("a submitted capture is not reset to pending_capture", ver_c.get("status"), "pending_manual")
check("the attempt count survives", ver_c.get("attemptCount"), 3)
check("the capture survives", ver_c.get("captureUrl"), "https://captures/host-c.jpg")
check("and so does the rejection history",
      ver_c.get("lastRejectedAt"), datetime(2026, 2, 1, tzinfo=timezone.utc))
check("createdAt is not rewritten",
      ver_c.get("createdAt"), datetime(2026, 1, 1, tzinfo=timezone.utc))
# B23: the history stays, but the record names the agency the Host belongs to NOW.
check("B23: the surviving record names the agency of this grant", ver_c.get("agencyId"), "agency-1")

seed_user("host-e")
seed_application("app-e", agencyId="agency-2")
store.collection("hostVerification").document("host-e").set(
    {"uid": "host-e", "status": "verified", "attemptCount": 1, "agencyId": "agency-old",
     "applicationId": "app-old"}
)
run(svc.grant_host("host-e", "agency-2", "Re-granted under a new agency", OPS,
                   {"application_id": "app-e"}))
ver_e = verification("host-e")
check("B23: a re-grant moves the verification record's agency", ver_e.get("agencyId"), "agency-2")
check("B23: …and its application", ver_e.get("applicationId"), "app-e")
check("B23: …and keeps its status", ver_e.get("status"), "verified")


# ══════════════════════════════════════════════════════════════════════════════
#  B18 — the agency is re-validated at the grant
# ══════════════════════════════════════════════════════════════════════════════

_staff_db.seed("partners", [
    {"_id": "agency-suspended", "kind": "agency", "status": "suspended", "is_active": False,
     "name": "Paused Agency"},
    {"_id": "sub-under-paused", "kind": "sub_agency", "status": "approved", "is_active": True,
     "name": "Sub Of Paused", "parent_id": "agency-suspended"},
])
for label, agency in (("a suspended agency", "agency-suspended"),
                      ("a sub-agency whose main agency is suspended", "sub-under-paused"),
                      ("an agency that does not exist", "agency-gone")):
    uid = f"host-b18-{agency}"
    seed_user(uid)
    refused = False
    try:
        run(svc.grant_host(uid, agency, "Approved after review", OPS))
    except svc.UserError:
        refused = True
    ok(f"B18: granting Host under {label} is refused", refused)
    user_x = store.collection("users").document(uid).get().to_dict() or {}
    ok(f"B18: …and nothing was written for {label}", user_x.get("isHost") is not True
       and verification(uid) == {})


# ══════════════════════════════════════════════════════════════════════════════
#  No half-created host
# ══════════════════════════════════════════════════════════════════════════════

seed_user("host-d")

original_batch = store.batch


def failing_batch():
    b = original_batch()
    b.fail_on_commit = True
    return b


store.batch = failing_batch

raised = False
try:
    run(svc.grant_host("host-d", "agency-1", "Firestore is down", OPS))
except Exception:  # noqa: BLE001
    raised = True

store.batch = original_batch

ok("a failed write is reported rather than swallowed", raised)
user_d = store.collection("users").document("host-d").get().to_dict() or {}
ok("the user was NOT made a host", user_d.get("isHost") is not True)
check("and no verification record was left behind", verification("host-d"), {})
# This is the whole point of the batch. Before it, these two writes were
# separate: `isHost: true` landed first and the verification record never
# followed, which is the host who looks fine everywhere and can never be paid.
ok("so there is no host without a way to verify", not (
    user_d.get("isHost") is True and verification("host-d") == {}
))


# ══════════════════════════════════════════════════════════════════════════════
#  The shared seed matches what activateHost writes
# ══════════════════════════════════════════════════════════════════════════════

seed = svc.host_verification_seed(
    "x", agency_id="a", application_id="b", host_name="n", agency_photo_url="u"
)

# Read off the `tx.set(verRef, …)` payload in functions/src/hosts.ts. The two
# cannot share code across the language boundary, so this is what keeps them in
# step: a field added on one side and not the other shows up here.
expected_fields = {
    "uid", "status", "agencyPhotoUrl", "agencyId", "applicationId",
    "hostName", "attemptCount", "createdAt", "updatedAt",
}
check("the Python seed has exactly the fields the Cloud Function writes",
      set(seed), expected_fields)
ok("and `isVerifiedHost` is not one of them", "isVerifiedHost" not in seed)
ok("nor is anything claiming a capture exists",
   "captureUrl" not in seed and "aiScore" not in seed)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} host-provisioning checks passed.")
print("  · grant_host opens the verification record activateHost opens")
print("  · with the same fields, asserted against the Cloud Function's payload")
print("  · isVerifiedHost is never set by granting host status")
print("  · an existing capture, attempt count and rejection history survive")
print("  · and a failed write leaves no host at all, rather than an unpayable one")
sys.exit(0)
