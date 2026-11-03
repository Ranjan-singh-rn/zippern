"""QA #50 (3 Nov 2026) — a partner is told when a proposed bank / KYC change is
applied or refused.

Before: `partner_ops.apply_pending_changes` / `reject_pending_changes` and
`users.decide_host_pending_changes` wrote the record and the audit entry and
told nobody. An applied change appeared without a word; a refused one silently
reverted, its reason stored on a dashboard the partner had no reason to open
(and a host has no dashboard at all).

Now each decision sends one Official message (and its email) to the human
behind the record — keyed on the decision's audit entry, naming the FIELDS in
words and never their values (bank details, identity documents).

REAL: the three decision functions and `notices.partner_details_decided`, over
the in-memory Firestore and the harness Mongo; audit is a fake returning an id.

    python3 -m tests.test_qa_partner_detail_notices
"""

from __future__ import annotations

import asyncio
import logging
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

import app.db.mongo as mongo  # noqa: E402

db = FakeDb()
mongo.get_db = lambda: db  # type: ignore[assignment]  — before any service binds it

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.services import notices  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import users as users_svc  # noqa: E402

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


run = asyncio.run
fs = FakeFirestore()
AUDIT_IDS = iter(f"audit-{n}" for n in range(1, 100))


async def fake_audit(**_kw):
    return next(AUDIT_IDS)


for mod in (ops, users_svc):
    mod.get_db = lambda: db  # type: ignore[assignment]
audit_mod.record = fake_audit
ops.audit.record = fake_audit
users_svc.audit.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
# No verified email anywhere: the in-app leg is what is asserted; the email leg
# for an address-less partner is recorded, never a reason to fail the decision.
firebase_mod.get_user = lambda uid: types.SimpleNamespace(uid=uid, email="", email_verified=False)  # type: ignore[assignment]
logging.disable(logging.CRITICAL)

REVIEWER = {"uid": "staff-2", "name": "Ops Reviewer", "role": "ops_admin", "team": "ops"}
PROPOSER = {"uid": "staff-1", "name": "Ops Proposer", "role": "ops_member"}


def notice_for(prefix: str) -> list[dict]:
    return [d for k, d in fs.collection("notifications").docs.items() if k.startswith(prefix)]


# ── An agency's bank change, APPLIED ─────────────────────────────────────────
fs.collection("agencies").docs["ag-1"] = {
    "agencyName": "Skyline", "crmUid": "crm-ag-1", "accountNumber": "111", "ifscCode": "HDFC0001",
    "kycDocUrls": ["https://x/1"], "kycStatus": "submitted",
    "pendingChanges": {"fields": {"accountNumber": "222", "ifscCode": "SBIN0002"},
                       "submittedBy": PROPOSER, "previousKycStatus": "approved"},
}
out = run(ops.apply_pending_changes("ag-1", "Matches the new passbook page.", REVIEWER))
eq("applied: the decision reports the partner was told", out.get("notified"), True)
applied = notice_for("partner_details_applied_")
eq("…one Official message, to the agency's login", [d.get("userId") for d in applied], ["crm-ag-1"])
body = str(applied[0].get("body")) if applied else ""
eq("…saying what changed, in words",
   body, "The change you proposed to your Agency details has been reviewed and applied: "
         "bank account number, IFSC code. Payouts go to the new details from now on.")
ok("…never the values themselves", "222" not in body and "SBIN0002" not in body)
eq("…typed and linked to the decision",
   (applied[0].get("type"), applied[0].get("relatedId")) if applied else None, ("partner_details_decided", "audit-1"))

# ── A seller's UPI change, REFUSED — with the reason ─────────────────────────
fs.collection("sellers").docs["se-1"] = {
    "displayName": "Coins", "crmUid": "crm-se-1", "upiId": "old@upi", "kycStatus": "submitted",
    "pendingChanges": {"fields": {"upiId": "new@upi"}, "submittedBy": PROPOSER, "previousKycStatus": "approved"},
}
out = run(ops.reject_pending_changes("se-1", "The UPI name does not match the seller's ID.", REVIEWER))
eq("refused: the partner was told", out.get("notified"), True)
refused = notice_for("partner_details_rejected_")
eq("…to the seller's login", [d.get("userId") for d in refused], ["crm-se-1"])
r_body = str(refused[0].get("body")) if refused else ""
ok("…with the reason", "Reason: The UPI name does not match the seller's ID." in r_body)
ok("…and that the current details stay", "Your current details stay as they were." in r_body)
ok("…never the proposed value", "new@upi" not in r_body)
eq("…the reason is its own field too", refused[0].get("reason") if refused else None,
   "The UPI name does not match the seller's ID.")

# ── A record whose document has no crmUid: the business record's owner ──────
db["partners"].docs["ag-2"] = {"_id": "ag-2", "kind": "agency", "owner_crm_uid": "crm-ag-2"}
fs.collection("agencies").docs["ag-2"] = {
    "agencyName": "North", "kycStatus": "submitted",
    "pendingChanges": {"fields": {"bankName": "SBI"}, "submittedBy": PROPOSER},
}
run(ops.apply_pending_changes("ag-2", "Bank merger, new name confirmed.", REVIEWER))
ok("a document without crmUid: told through owner_crm_uid",
   any(d.get("userId") == "crm-ag-2" for d in notice_for("partner_details_applied_")))

# ── Nobody to tell: the decision stands, notified is False ───────────────────
fs.collection("agencies").docs["ag-3"] = {
    "agencyName": "Orphan", "kycStatus": "submitted",
    "pendingChanges": {"fields": {"branch": "East"}, "submittedBy": PROPOSER},
}
out = run(ops.apply_pending_changes("ag-3", "Branch moved, confirmed by letter.", REVIEWER))
eq("no login behind the record: applied, and notified is False", (out.get("applied"), out.get("notified")),
   (["branch"], False))

# ── A host's change (decided in users.py): the host is told ──────────────────
fs.collection("hostApplications").docs["ha-1"] = {
    "hostName": "Asha", "activatedByUid": "host-uid-1", "agencyId": "ag-1", "kycStatus": "submitted",
    "pendingChanges": {"fields": {"accountNumber": "333"}, "submittedBy": PROPOSER, "previousKycStatus": "approved"},
}
out = run(users_svc.decide_host_pending_changes("ha-1", False, "The passbook photo is unreadable.", REVIEWER))
eq("host: refused, and told", out.get("notified"), True)
host = [d for d in notice_for("partner_details_rejected_") if d.get("userId") == "host-uid-1"]
ok("…a Host notice, with the reason", bool(host) and "to your Host details was not applied" in str(host[0].get("body"))
   and "The passbook photo is unreadable." in str(host[0].get("body")))

# ── Two proposals, two decisions: two notices (keyed on the decision) ────────
fs.collection("agencies").docs["ag-1"]["pendingChanges"] = {"fields": {"branch": "West"}, "submittedBy": PROPOSER}
run(ops.reject_pending_changes("ag-1", "Branch not on the passbook.", REVIEWER))
ag1 = [d for d in fs.collection("notifications").docs.values() if d.get("userId") == "crm-ag-1"]
eq("a second decision on the same partner is a second notice", len(ag1), 2)

# ── The words for each field ─────────────────────────────────────────────────
eq("labels, each once", notices.detail_labels(["accountNumber", "bankAccount", "ifscCode", "kycDocUrls", "idDocUrls"]),
   ["bank account number", "IFSC code", "identity documents"])
eq("a key nobody knows is 'other details', never the proposer's own text",
   notices.detail_labels(["isActivated", "Click here: evil.example"]), ["other details"])
for field in sorted(ops.APPLICABLE_FIELDS):
    ok(f"every field a proposal may change has words: {field}", field in notices._DETAIL_LABELS)

print()
if failures:
    print(f"{len(failures)} of {checks} partner detail notice checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} partner detail notice checks passed.")
print("  · QA #50: a partner (agency, seller, host) is told when a proposed bank/KYC change is applied or refused")
