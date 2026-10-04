"""Partner creation tests.

`partners` is the collection every money flow behind an agency or a seller
resolves against, and until now nothing inserted into it. These tests cover the
function that does, and — more importantly — cover the **shape** of what it
writes, because a partner created without a field some later flow reads does not
fail at creation. It fails when somebody is trying to move money.

No database and no network: `tests/fakes.py` stubs the I/O underneath, so the
code exercised here is the real `app/services/partner_ops.py`.

Run:  python3 -m tests.test_partner_create
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.services import commission as commission_mod  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services.partners import (  # noqa: E402
    CreditStanding,
    PartnerKind,
    PartnerStatus,
)

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


def refuses(label: str, coro_factory) -> str:
    """This must be refused with a message, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = asyncio.run(coro_factory())
    except ops.PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted PartnerOpsError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ── Firestore fixtures, in the shape the real documents carry ─────────────────
# Field names are taken from `zipper-crm/lib/agencies.ts` (Agency) and
# `zipper-crm/lib/sellers.ts` (Seller), not invented for the test.

MAIN_AGENCY = {
    "crmId": "A1B2C3D4",
    "crmUid": "crm-uid-main",
    "type": "main",
    "parentAgencyId": None,
    "ownerUid": "owner-uid-1",
    "ownerName": "Ravi Kulkarni",
    "ownerPhone": "+919876500001",
    "ownerEmail": "ravi@skyline.example",
    "agencyName": "Skyline Talents",
    "referralCode": "SKYL4F2A",
    "status": "pending",
    "kycStatus": "pending",
    "isActive": False,
    "totalHosts": 0,
    "totalSubAgencies": 0,
}

SUB_AGENCY = {
    "crmId": "B2C3D4E5",
    "type": "sub",
    "parentAgencyId": "agency-main-1",
    "ownerName": "Nisha Rao",
    "agencyName": "Skyline South",
    "status": "pending",
    "kycStatus": "pending",
    "isActive": False,
    "totalHosts": 0,
    "totalSubAgencies": 0,
}

# A sub-agency that never got `type: 'sub'` — only a parent. It is still a
# sub-agency, and reading it as a main one would pay it from the richer table.
SUB_BY_PARENT_ONLY = {
    "crmId": "C3D4E5F6",
    "parentAgencyId": "agency-main-1",
    "agencyName": "Skyline West",
    "status": "pending",
}

SELLER = {
    "crmId": "S9Z8Y7X6",
    "crmUid": "crm-uid-seller",
    "ownerUid": "",
    "displayName": "Meena Coin Store",
    "phone": "+919876500002",
    "email": "meena@coins.example",
    "isApproved": False,
    "isActive": False,
    "coinBalance": 0,
    "totalCoinsSold": 0,
    "qrCodeUrl": "",
    "description": "",
}

# No crmId at all — the unique sparse index must not be handed a null.
SELLER_NO_CRM_ID = {
    "displayName": "Corner Shop Coins",
    "isApproved": False,
    "isActive": False,
}

# No name anywhere. Created anyway, with a warning — refusing would leave a
# paid-up partner unfundable over a blank field.
NAMELESS_AGENCY = {"crmId": "D4E5F6G7", "type": "main", "status": "pending"}

FIRESTORE: dict[str, tuple[str, dict]] = {
    "agency-main-1": ("agencies", MAIN_AGENCY),
    "agency-sub-1": ("agencies", SUB_AGENCY),
    "agency-sub-2": ("agencies", SUB_BY_PARENT_ONLY),
    "seller-1": ("sellers", SELLER),
    "seller-2": ("sellers", SELLER_NO_CRM_ID),
    "agency-nameless": ("agencies", NAMELESS_AGENCY),
}


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
audit_entries: list[dict] = []
synced: list[tuple[str, dict]] = []


def fake_read_firestore(partner_id: str, collection: str | None = None):
    found = FIRESTORE.get(partner_id)
    if found is None:
        return None
    name, data = found
    if collection is not None and collection != name:
        return None
    return name, dict(data)


async def fake_audit_record(**kwargs):
    if not (kwargs.get("reason") or "").strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")
    audit_entries.append(kwargs)
    return "audit-id"


def fake_sync(partner: dict, fields: dict) -> bool:
    synced.append((str(partner["_id"]), fields))
    return True


ops.get_db = lambda: db
partner_svc.get_db = lambda: db
audit_mod.record = fake_audit_record
ops.audit.record = fake_audit_record
ops._read_firestore_partner = fake_read_firestore
ops._sync_partner_doc = fake_sync

ACTOR = {
    "uid": "staff-1",
    "name": "Ops Admin",
    "role": "ops_admin",
    "team": "ops",
}
REASON = "Registered through the CRM; creating the business record."


def stored(partner_id: str) -> dict:
    return db["partners"].docs[partner_id]


# ══════════════════════════════════════════════════════════════════════════════
# 1. Creation from a main agency
# ══════════════════════════════════════════════════════════════════════════════

result = asyncio.run(ops.create_partner("agency-main-1", REASON, ACTOR))

check("main agency → id", result["id"], "agency-main-1")
check("main agency → kind", result["kind"], "agency")
check("main agency → name", result["name"], "Skyline Talents")
check("main agency → crm_id", result["crm_id"], "A1B2C3D4")
check("main agency → no parent", result["parent_id"], None)
check("main agency → created", result["created"], True)
check("main agency → status is pending, not approved", result["status"], "pending")
check("main agency → inactive until approved", result["is_active"], False)
check("main agency → no warnings", result["warnings"], [])

# It is the main slab table this partner will be paid from — checked through the
# real consumer rather than by re-reading the field.
check(
    "main agency selects the MAIN slab table",
    commission_mod.kind_of(stored("agency-main-1")),
    commission_mod.AgencyKind.MAIN,
)

# ── Every balance opens at zero ───────────────────────────────────────────────
doc = stored("agency-main-1")
check("opens with no credit outstanding", doc["credit"]["outstanding"], 0)
check("opens with no due date", doc["credit"]["due_at"], None)
check("opens with nothing ever lent", doc["credit"]["total_lent"], 0)
check("opens with nothing ever repaid", doc["credit"]["total_repaid"], 0)
check("opens with nothing ever recovered", doc["credit"]["total_recovered"], 0)
check("opens with no penalty", doc["credit"]["total_penalty"], 0)
check("opens with nothing written off", doc["credit"]["total_written_off"], 0)
check("opens with an empty credit history", doc["credit"]["history"], [])
check("opens with no cash recorded", doc["cash_paid_minor"], 0)
check("opens with nothing sold", doc["total_coins_sold"], 0)

# Coin and commission balances are not stored on the partner at all — they are
# ledger positions. A partner record that carried its own copy would be a second
# source of truth for a balance.
ok(
    "no coin balance is stored on the partner record",
    "coins" not in doc and "coin_balance" not in doc and "balance" not in doc,
)
ok(
    "no commission balance is stored on the partner record",
    "commission" not in doc and "commission_balance" not in doc,
)

# ── Audited, with the reason ──────────────────────────────────────────────────
check("creation wrote one audit entry", len(audit_entries), 1)
entry = audit_entries[0]
check("audit action", entry["action"], "partner.created")
check("audit subject type", entry["subject_type"], "partner")
check("audit subject id", entry["subject_id"], "agency-main-1")
check("audit carries the reason", entry["reason"], REASON)
check("audit records the opening state", entry["after"]["credit_outstanding"], 0)
check("audit says it opened at zero", entry["meta"]["opened_at_zero"], True)
check(
    "audit names the source collection",
    entry["meta"]["firestore_collection"],
    "agencies",
)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Creation from a sub-agency — parent carried, different slab table
# ══════════════════════════════════════════════════════════════════════════════

sub = asyncio.run(ops.create_partner("agency-sub-1", REASON, ACTOR))

check("sub-agency → kind", sub["kind"], "sub_agency")
check("sub-agency → parent", sub["parent_id"], "agency-main-1")
check("sub-agency → name", sub["name"], "Skyline South")
check(
    "sub-agency selects the SUB slab table",
    commission_mod.kind_of(stored("agency-sub-1")),
    commission_mod.AgencyKind.SUB,
)

# The sub-agency has to be findable from its parent — that query is `kind` plus
# `parent_id`, which is why both are written.
check(
    "sub-agency is found by its parent's query",
    [
        d["_id"]
        for d in db["partners"].docs.values()
        if d.get("kind") == str(PartnerKind.SUB_AGENCY)
        and d.get("parent_id") == "agency-main-1"
    ],
    ["agency-sub-1"],
)

# A parent with no `type: 'sub'` is still a sub-agency.
sub2 = asyncio.run(ops.create_partner("agency-sub-2", REASON, ACTOR))
check("parent implies sub-agency", sub2["kind"], "sub_agency")
check("parent implies sub-agency → parent kept", sub2["parent_id"], "agency-main-1")


# ══════════════════════════════════════════════════════════════════════════════
# 3. Creation from a seller
# ══════════════════════════════════════════════════════════════════════════════

seller = asyncio.run(ops.create_partner("seller-1", REASON, ACTOR))

check("seller → kind", seller["kind"], "seller")
check("seller → name from displayName", seller["name"], "Meena Coin Store")
check("seller → crm_id", seller["crm_id"], "S9Z8Y7X6")
check("seller → no parent", seller["parent_id"], None)
check("seller opens holding nothing", stored("seller-1")["credit"]["outstanding"], 0)

# The real reader, on the real record: a fresh seller is blocked from inventory
# because it is not approved yet — not because of some missing field.
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-1"))
check("a fresh seller cannot take inventory", allowed, False)
check("and is told why", why, "Seller account is not approved.")

# Credit standing reads `credit.outstanding` and `credit.due_at` off the record.
check(
    "a fresh seller has no credit standing to speak of",
    partner_svc.credit_standing(
        stored("seller-1")["credit"]["outstanding"],
        stored("seller-1")["credit"]["due_at"],
    ),
    CreditStanding.NONE,
)

# A seller with no crmId: the key is absent, never an explicit null, because the
# `crm_id` index is unique **and sparse** and a sparse index still indexes nulls.
no_crm = asyncio.run(ops.create_partner("seller-2", REASON, ACTOR))
ok("a missing crmId leaves the key off entirely", "crm_id" not in stored("seller-2"))
ok(
    "and says so rather than leaving it unexplained",
    any("crmId" in w for w in no_crm["warnings"]),
)

# Two partners without a crmId can both exist. With `crm_id: None` written out,
# the second insert would have collided on the unique index.
FIRESTORE["seller-3"] = ("sellers", {"displayName": "Third Shop"})
third = asyncio.run(ops.create_partner("seller-3", REASON, ACTOR))
check("a second partner without a crmId is still creatable", third["created"], True)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Idempotency — a second call is a no-op, and never a reset
# ══════════════════════════════════════════════════════════════════════════════

before_inserts = db["partners"].inserts
before_audit = len(audit_entries)

# Give the seller a live position, the way lending and a coin purchase would.
stored("seller-1")["credit"]["outstanding"] = 25_000
stored("seller-1")["cash_paid_minor"] = 229_000
stored("seller-1")["total_coins_sold"] = 4_000
stored("seller-1")["status"] = str(PartnerStatus.APPROVED)
stored("seller-1")["is_active"] = True

again = asyncio.run(ops.create_partner("seller-1", "Retried after a timeout.", ACTOR))

check("creating twice reports created: false", again["created"], False)
check("creating twice inserts nothing", db["partners"].inserts, before_inserts)
check("creating twice audits nothing", len(audit_entries), before_audit)
check("the live credit position survives", again["credit"]["outstanding"], 25_000)
check("the cash recorded survives", again["cash_paid_minor"], 229_000)
check("the lifetime sold figure survives", again["total_coins_sold"], 4_000)
check("the approved status survives", again["status"], "approved")
check("the active flag survives", again["is_active"], True)
ok(
    "and the response says nothing was changed",
    "already existed" in again["note"],
)

# Even under a race — the read misses and the insert loses — exactly one record
# exists and the loser is answered with the winner's.
raced = asyncio.run(
    ops.ensure_partner_record("seller-1", ACTOR, "Racing creation.", None)
)
check("a raced creation returns the existing record", raced[1], False)
check("and still only one insert has happened", db["partners"].inserts, before_inserts)

# A kind that disagrees with the record that already exists is refused rather
# than silently answered with the wrong partner.
message = refuses(
    "existing partner, wrong kind",
    lambda: ops.create_partner("seller-1", REASON, ACTOR, PartnerKind.AGENCY),
)
ok("and the refusal names both kinds", "seller" in message and "agency" in message)


# ══════════════════════════════════════════════════════════════════════════════
# 5. An unknown id is refused
# ══════════════════════════════════════════════════════════════════════════════

message = refuses(
    "unknown partner id",
    lambda: ops.create_partner("no-such-partner", REASON, ACTOR),
)
ok("the refusal names the id", "no-such-partner" in message)
ok(
    "and says nothing was created",
    "nothing was created" in message.lower(),
)
ok("nothing was written for an unknown id", "no-such-partner" not in db["partners"].docs)

# A seller id offered as an agency finds no agencies document, and is refused —
# a partner record under the wrong kind is paid from the wrong slab table.
refuses(
    "seller id claimed as an agency",
    lambda: ops.create_partner("seller-4-unknown", REASON, ACTOR, PartnerKind.AGENCY),
)

# A main agency claimed as a sub-agency: the document is found, and the caller's
# kind loses to what the document says.
message = refuses(
    "main agency claimed as a sub-agency",
    lambda: ops.create_partner(
        "agency-nameless", REASON, ACTOR, PartnerKind.SUB_AGENCY
    ),
)
ok("the refusal explains why the document wins", "slab table" in message)
ok(
    "and nothing was created for it",
    "agency-nameless" not in db["partners"].docs,
)

# A blank reason is refused — an unaudited creation is not auditable.
refuses("blank reason", lambda: ops.create_partner("agency-nameless", "  ", ACTOR))
refuses("blank partner id", lambda: ops.create_partner("   ", REASON, ACTOR))


# ══════════════════════════════════════════════════════════════════════════════
# 6. Every field a later flow reads is present
# ══════════════════════════════════════════════════════════════════════════════
#
# Each row is (dotted path, the consumer that reads it). This is the list that
# matters: a partner created without one of these does not fail here — it fails
# when someone is trying to move money.

READ_BY: list[tuple[str, str]] = [
    ("_id", "partner_ops._partner, every find_one({'_id': ...})"),
    ("kind", "partner_ops._partner / _fs_collection, commission.kind_of"),
    ("name", "partners.agency_statement / seller_statement, reports, card titles"),
    ("parent_id", "partners.sub_agencies_of, partner_ops.request_subagency_payout"),
    ("status", "partner_ops._approved_partner, partners.can_take_inventory"),
    ("is_active", "partner_ops.approve_partner / deactivate_partner"),
    ("credit.outstanding", "request_repayment, execute_recovery, write_off_debt"),
    ("credit.due_at", "partners.credit_standing, partners.overdue_sellers"),
    ("credit.terms", "execute_lending"),
    ("credit.total_lent", "execute_lending ($inc)"),
    ("credit.total_repaid", "execute_repayment ($inc)"),
    ("credit.total_recovered", "execute_recovery ($inc)"),
    ("credit.total_penalty", "execute_recovery ($inc)"),
    ("credit.total_written_off", "execute_write_off ($inc)"),
    ("credit.history", "execute_lending / repayment / recovery / write-off ($push)"),
    ("cash_paid_minor", "execute_coin_purchase ($inc), partners.seller_statement"),
    ("total_coins_sold", "approve_sale ($inc), synced to Firestore totalCoinsSold"),
    ("created_at", "partner_ops.list_partners (sort key)"),
    ("updated_at", "every mutation on this record"),
    ("approved_at", "the Firestore replica, and the CRM record view"),
    ("approved_by", "the Firestore replica, and the CRM record view"),
    ("rejection_reason", "partner_ops.reject_partner, shown to the applicant"),
    ("rejection_history", "partner_ops.reject_partner ($push)"),
]

MISSING = object()


def read(doc: dict, dotted: str):
    node = doc
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return MISSING
        node = node[part]
    return node


fresh = stored("agency-sub-1")
for dotted, consumer in READ_BY:
    ok(f"{dotted} is present (read by {consumer})", read(fresh, dotted) is not MISSING)

# `crm_id` is the one field that is legitimately absent, and only when the
# Firestore document has none.
ok(
    "crm_id is present when Firestore has one (read by _sync_partner_doc)",
    read(fresh, "crm_id") is not MISSING,
)

# Money fields are whole numbers of minor units, never floats.
for dotted in (
    "credit.outstanding",
    "credit.total_lent",
    "credit.total_repaid",
    "credit.total_recovered",
    "credit.total_penalty",
    "credit.total_written_off",
    "cash_paid_minor",
    "total_coins_sold",
):
    value = read(fresh, dotted)
    ok(f"{dotted} is a whole number", isinstance(value, int) and not isinstance(value, bool))


# ══════════════════════════════════════════════════════════════════════════════
# 7. Approval creates the record, in the same flow
# ══════════════════════════════════════════════════════════════════════════════

FIRESTORE["agency-never-seen"] = (
    "agencies",
    {"crmId": "E5F6G7H8", "type": "main", "agencyName": "Late Arrival Talents"},
)

ok(
    "the partner does not exist before approval",
    "agency-never-seen" not in db["partners"].docs,
)

approved = asyncio.run(
    ops.approve_partner(
        "agency-never-seen", "Reviewed the file; approving.", ACTOR
    )
)

check("approval created the record", approved["partner_record_created"], True)
check("and approved it", approved["status"], "approved")
check("and activated it", approved["is_active"], True)
check("the created record is the right kind", approved["kind"], "agency")
check(
    "and it still opened at zero",
    stored("agency-never-seen")["credit"]["outstanding"],
    0,
)
check(
    "and holds no cash",
    stored("agency-never-seen")["cash_paid_minor"],
    0,
)

# Two audit entries: the creation and the approval. Both, or the record has a
# gap where its own beginning should be.
actions = [e["action"] for e in audit_entries if e["subject_id"] == "agency-never-seen"]
check("approval audited creation and approval", actions, ["partner.created", "partner.approved"])

# Approving a partner that already exists does not create a second one.
before_inserts = db["partners"].inserts
approved_again = asyncio.run(
    ops.approve_partner("agency-main-1", "Approving after review.", ACTOR)
)
check("approving an existing partner creates nothing", approved_again["partner_record_created"], False)
check("and inserts nothing", db["partners"].inserts, before_inserts)

# An id that names no Firestore document is still refused at approval — an
# approval must never mint a record for a partner that does not exist.
message = refuses(
    "approving an unknown id",
    lambda: ops.approve_partner("no-such-partner", "Approve please.", ACTOR),
)
ok("the refusal names the id", "no-such-partner" in message)
ok("nothing was created by the refused approval", "no-such-partner" not in db["partners"].docs)

# The seller now approved through the record created above can take inventory —
# the whole point of the exercise.
asyncio.run(ops.approve_partner("seller-2", "Approved after KYC.", ACTOR))
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-2"))
check("an approved seller can take inventory", allowed, True)
check("with nothing standing in the way", why, "")


# ══════════════════════════════════════════════════════════════════════════════
# 8. A record that can still be created, said out loud
# ══════════════════════════════════════════════════════════════════════════════

nameless = asyncio.run(ops.create_partner("agency-nameless", REASON, ACTOR))
check("a nameless document still creates a record", nameless["created"], True)
check("with an empty name rather than a guess", nameless["name"], "")
ok("and a warning that says so", any("no name" in w for w in nameless["warnings"]))

FIRESTORE["agency-orphan-sub"] = (
    "agencies",
    {"crmId": "F6G7H8I9", "type": "sub", "agencyName": "Orphan Sub"},
)
orphan = asyncio.run(ops.create_partner("agency-orphan-sub", REASON, ACTOR))
check("a sub-agency with no parent is still a sub-agency", orphan["kind"], "sub_agency")
check("with no parent invented for it", orphan["parent_id"], None)
ok(
    "and a warning that a payout cannot be raised for it",
    any("parentAgencyId" in w for w in orphan["warnings"]),
)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} partner-creation checks passed.")
print("  · created from a main agency, a sub-agency and a seller")
print("  · sub-agency carries its parent and selects the sub-agency slab table")
print("  · every balance opens at zero, and no balance is duplicated onto the record")
print("  · creating twice is a no-op — no second record, no audit entry, no reset")
print("  · an id that names no Firestore agency or seller is refused")
print("  · approval creates the record in the same flow, and audits both")
print(f"  · all {len(READ_BY)} fields the other services read are present")
sys.exit(0)
