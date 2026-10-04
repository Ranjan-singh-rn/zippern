"""Virtual account numbers — built ready, switched on when the bank exists.

Spec 4.3.4 / 8C.1. An approved coin seller is issued a permanent virtual account
number and every payment into it identifies the payer, which is what removes the
UTR-and-screenshot dance. It needs an HDFC eCMS collection account on a
**business current account** (8C.8.7) and the owner is on a personal one, so it
cannot be switched on. These tests cover the two halves of that:

  * with no bank configured, **nothing is issued and nothing is invented**. Not
    a prefix plus a counter, not the partner id, not a placeholder. The record
    says none has been issued and why, and the seller's existing
    pay-and-send-a-reference path is untouched.
  * with a bank configured and a client wired, a VAN is issued at approval, from
    the bank, once — and never regenerated, because a partner has given that
    number to the people who pay them.

And the seam the bank feed would arrive through: `identify_payer`, which turns
one statement line into a seller and refuses rather than guesses.

No database and no network: `tests/harness.py` stubs the I/O, so everything
under `app/` exercised here is the real, unmodified code — including the real
audit writer, which refuses an entry with no reason.

Run:  python3 -m tests.test_virtual_accounts
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from app.config import settings  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services.partners import PartnerStatus  # noqa: E402

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


def refuses(label: str, factory) -> str:
    """This must be refused with a message, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = asyncio.run(factory())
    except ops.PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted PartnerOpsError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def run(coro):
    return asyncio.run(coro)


# ── The world ─────────────────────────────────────────────────────────────────

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)

SELLER_DOC = {
    "crmId": "S9Z8Y7X6",
    "crmUid": "crm-uid-seller",
    "displayName": "Meena Coin Store",
    "isApproved": False,
    "isActive": False,
}

AGENCY_DOC = {
    "crmId": "A1B2C3D4",
    "type": "main",
    "agencyName": "Skyline Talents",
    "status": "pending",
}

FIRESTORE: dict[str, tuple[str, dict]] = {
    "seller-1": ("sellers", SELLER_DOC),
    "seller-2": ("sellers", dict(SELLER_DOC, displayName="Corner Shop Coins")),
    "seller-3": ("sellers", dict(SELLER_DOC, displayName="Third Shop")),
    "seller-4": ("sellers", dict(SELLER_DOC, displayName="Fourth Shop")),
    "agency-1": ("agencies", AGENCY_DOC),
}

db = FakeDb()
synced: list[tuple[str, dict]] = []


def fake_read_firestore(partner_id: str, collection: str | None = None):
    found = FIRESTORE.get(partner_id)
    if found is None:
        return None
    name, data = found
    if collection is not None and collection != name:
        return None
    return name, dict(data)


def fake_sync(partner: dict, fields: dict) -> bool:
    synced.append((str(partner["_id"]), fields))
    return True


ops.get_db = lambda: db
partner_svc.get_db = lambda: db
audit_mod.get_db = lambda: db
money_mod.get_db = lambda: db
cards_svc.get_db = lambda: db

# The bank-is-down case logs the exception, which is exactly right in production
# and is a stack trace in the middle of a test table here. The refusal itself is
# asserted; it is not read out of the log.
logging.getLogger("app.services.partner_ops").setLevel(logging.CRITICAL)
ops._read_firestore_partner = fake_read_firestore
ops._sync_partner_doc = fake_sync

ACTOR = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
REASON = "KYC checked against the PAN and the bank statement; approving."


def audit_actions(subject_id: str) -> list[str]:
    return [
        d["action"]
        for d in db[C.AUDIT].docs
        if d["subject"]["id"] == subject_id
    ]


def stored(partner_id: str) -> dict:
    for doc in db[C.PARTNERS].docs:
        if doc["_id"] == partner_id:
            return doc
    raise AssertionError(f"no partner {partner_id!r}")


def no_bank() -> None:
    """The live configuration: four blanks, and nothing is issued."""
    settings.van_provider = ""
    settings.van_ifsc = ""
    settings.van_beneficiary_name = ""
    settings.van_collection_account = ""
    ops.register_van_allocator(None)


def with_bank(allocator=None) -> None:
    """What the day the current account opens looks like."""
    settings.van_provider = "hdfc_ecms"
    settings.van_ifsc = "HDFC0000123"
    settings.van_beneficiary_name = "Zipper Technologies Private Limited"
    settings.van_collection_account = "50200099887766"
    ops.register_van_allocator(allocator)


# ══════════════════════════════════════════════════════════════════════════════
# 1. No bank — nothing is issued, and nothing is invented
# ══════════════════════════════════════════════════════════════════════════════

no_bank()
ok("with the four settings blank, no bank is configured", not ops.van_bank_configured())

approved = run(ops.approve_partner("seller-1", REASON, ACTOR))

check("the seller is approved regardless", approved["status"], "approved")
check("and active", approved["is_active"], True)

van = approved["virtual_account"]
check("no VAN is issued", van["issued"], False)
check("and the number is None — not a placeholder, not an empty string", van["number"], None)
check("the response says the bank is not configured", van["bank_configured"], False)
ok(
    "and the reason names the business current account (8C.8.7)",
    "business current account" in van["reason"],
)
ok(
    "…and says the existing payment path is unaffected",
    "payment reference" in van["reason"],
)

# The record itself. A number that does not exist must be absent, not blank —
# and above all not derived from anything.
record = stored("seller-1")
ok(
    "nothing at all is written under virtual_account",
    "virtual_account" not in record or not record["virtual_account"].get("number"),
)
serialised = repr(record)
for invented in ("seller-1", "S9Z8Y7X6"):
    ok(
        f"no VAN is synthesised from {invented}",
        f"'number': '{invented}'" not in serialised,
    )

# And no audit noise: with no bank this is true of every seller in the business
# and always will be until the account opens. The absence is derived on read.
check(
    "approval audits creation and approval, and nothing about a VAN",
    audit_actions("seller-1"),
    ["partner.created", "partner.approved"],
)

# What a reader sees, through the real read path both the CRM and the portal use.
fetched = run(ops.get_partner("seller-1"))
check("GET /partners/{id} always carries a virtual_account", fetched["virtual_account"], van)
ok("…and it never names who would have issued it", "issued_by" not in fetched["virtual_account"])

# The backfill route refuses loudly rather than reporting success. Somebody is
# standing here asking for a number.
message = refuses(
    "issuing with no bank",
    lambda: ops.issue_virtual_account("seller-1", "Seller asked for their VAN.", ACTOR),
)
ok("the refusal explains the bank requirement", "eCMS" in message)
ok("nothing was written by the refusal", "virtual_account" not in stored("seller-1"))

# A blank reason is refused before anything else is considered.
refuses("blank reason", lambda: ops.issue_virtual_account("seller-1", "  ", ACTOR))


# ══════════════════════════════════════════════════════════════════════════════
# 2. A half-configured bank is not a bank
# ══════════════════════════════════════════════════════════════════════════════
#
# A number with no IFSC cannot be paid into and a number with no beneficiary
# name is rejected at the payer's own bank. All four, or none of it.

for field in ("van_provider", "van_ifsc", "van_beneficiary_name", "van_collection_account"):
    with_bank(lambda partner: {"number": "SHOULD-NEVER-BE-USED"})
    setattr(settings, field, "")
    ok(f"a bank missing {field} is not configured", not ops.van_bank_configured())

with_bank(lambda partner: {"number": "VAN-HALF"})
settings.van_ifsc = ""
half = run(ops.approve_partner("seller-2", REASON, ACTOR))
check("and issues nothing", half["virtual_account"]["issued"], False)
check("…with no number", half["virtual_account"]["number"], None)
ok(
    "…even though a client stood ready to hand one over",
    "virtual_account" not in stored("seller-2"),
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. The bank exists — a VAN is issued at approval, by the bank
# ══════════════════════════════════════════════════════════════════════════════

allocations: list[str] = []


def bank(partner: dict) -> dict:
    """Stands in for the eCMS client. The NUMBER comes from here, which is the
    whole point: it is the bank's, not something this system computed."""
    allocations.append(str(partner["_id"]))
    return {"number": f"91500{len(allocations):09d}"}


with_bank(bank)
issued = run(ops.approve_partner("seller-3", REASON, ACTOR))["virtual_account"]

check("a VAN is issued on approval", issued["issued"], True)
check("…and it is the number the bank returned", issued["number"], "91500000000001")
check("…the bank was asked exactly once", allocations, ["seller-3"])
check("…carrying the configured IFSC", issued["ifsc"], "HDFC0000123")
check(
    "…and the beneficiary name a payer must see",
    issued["beneficiary_name"],
    "Zipper Technologies Private Limited",
)
check("…and the provider", issued["provider"], "hdfc_ecms")
check(
    "…and the real account it maps onto (8C.1.3)",
    issued["collection_account"],
    "50200099887766",
)
ok("…and the replica was told", ("seller-3", ) == (synced[-1][0],))
check(
    "…which is what the app and the portal read",
    synced[-1][1]["virtualAccountNumber"],
    "91500000000001",
)

ok(
    "issuing is audited as its own action",
    "partner.van_issued" in audit_actions("seller-3"),
)
entry = [d for d in db[C.AUDIT].docs if d["action"] == "partner.van_issued"][0]
check("the audit entry carries the reason", entry["reason"], REASON)
check("…and the number", entry["after"]["virtual_account_number"], "91500000000001")
check(
    "…and says where the number came from",
    entry["meta"]["allocated_by"],
    "the bank — this number was not generated here",
)

# The view a partner reads carries no staff identity, even though the record does.
ok("the record keeps who issued it", "issued_by" in stored("seller-3")["virtual_account"])
view = run(ops.get_partner("seller-3"))["virtual_account"]
ok("…and the view handed to the partner does not", "issued_by" not in view)
check("…while still carrying the number", view["number"], "91500000000001")


# ══════════════════════════════════════════════════════════════════════════════
# 4. Never regenerated
# ══════════════════════════════════════════════════════════════════════════════
#
# A VAN is permanent (8C.1.4). The seller has printed it, saved it as a payee
# and given it to the people who pay them; a second number would orphan every
# standing instruction pointing at the first.

before_calls = list(allocations)
again = run(
    ops._ensure_virtual_account(stored("seller-3"), "Re-running approval.", ACTOR)
)
check("a second issue attempt returns the number already held", again["number"], "91500000000001")
check("…and says so", again["already_held"], True)
check("…without asking the bank again", allocations, before_calls)
check(
    "…and writes no second audit entry",
    [a for a in audit_actions("seller-3") if a == "partner.van_issued"],
    ["partner.van_issued"],
)

message = refuses(
    "asking for a second VAN",
    lambda: ops.issue_virtual_account("seller-3", "Seller wants a new number.", ACTOR),
)
ok("the refusal names the number they already hold", "91500000000001" in message)
ok("…and says a VAN is permanent", "permanent" in message)
check(
    "…and the stored number is untouched",
    stored("seller-3")["virtual_account"]["number"],
    "91500000000001",
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. The bank is there and still says nothing — an incident, not a silence
# ══════════════════════════════════════════════════════════════════════════════

with_bank(None)
none_wired = run(ops.approve_partner("seller-4", REASON, ACTOR))["virtual_account"]
check("a configured bank with no client issues nothing", none_wired["issued"], False)
check("…and no number", none_wired["number"], None)
ok("…and says a client must be registered", "register_van_allocator" in none_wired["reason"])
ok(
    "…and, unlike 'there is no bank', it is audited as a failure",
    "partner.van_not_issued" in audit_actions("seller-4"),
)
ok(
    "…and the reason is on the record for the portal to show",
    "allocate" in stored("seller-4")["virtual_account"]["last_failure"],
)

# A client that raises must not take an approval down with it.
db[C.PARTNERS].docs = [d for d in db[C.PARTNERS].docs if d["_id"] != "seller-4"]
FIRESTORE["seller-5"] = ("sellers", dict(SELLER_DOC, displayName="Fifth Shop"))


def exploding_bank(partner: dict) -> dict:
    raise RuntimeError("eCMS returned 503")


with_bank(exploding_bank)
survived = run(ops.approve_partner("seller-5", REASON, ACTOR))
check("an approval survives a bank that is down", survived["status"], "approved")
check("…and issues nothing", survived["virtual_account"]["issued"], False)
ok("…naming what the bank said", "503" in survived["virtual_account"]["reason"])
ok(
    "…and saying nothing was invented",
    "no number was invented" in survived["virtual_account"]["reason"],
)

# A client that answers with a blank is answering with nothing, and a blank is
# never filled in from somewhere else.
FIRESTORE["seller-6"] = ("sellers", dict(SELLER_DOC, displayName="Sixth Shop"))
with_bank(lambda partner: {"number": "   "})
blank = run(ops.approve_partner("seller-6", REASON, ACTOR))["virtual_account"]
check("a blank answer issues nothing", blank["issued"], False)
check("…and no number", blank["number"], None)
ok("…and says a blank is not a number", "blank answer is not a number" in blank["reason"])


# ══════════════════════════════════════════════════════════════════════════════
# 6. VANs are a collection instrument — sellers, not agencies
# ══════════════════════════════════════════════════════════════════════════════

with_bank(bank)
agency = run(ops.approve_partner("agency-1", REASON, ACTOR))
check("an agency is issued no VAN", agency["virtual_account"]["issued"], False)
ok(
    "…and is told why: money comes in through a VAN, and we pay agencies",
    "coin sellers" in agency["virtual_account"]["reason"],
)
ok("…and the bank was never asked for one", "agency-1" not in allocations)

message = refuses(
    "issuing a VAN for an agency by hand",
    lambda: ops.issue_virtual_account("agency-1", "Agency asked for a VAN.", ACTOR),
)
ok("the refusal names the kind", "agency" in message and "seller" in message)

# An application still under review is not somebody we accept money for.
FIRESTORE["seller-7"] = ("sellers", dict(SELLER_DOC, displayName="Seventh Shop"))
run(ops.create_partner("seller-7", "Registered through the CRM.", ACTOR))
message = refuses(
    "issuing a VAN for a pending applicant",
    lambda: ops.issue_virtual_account("seller-7", "Applicant asked early.", ACTOR),
)
ok("the refusal says they are not approved", "pending" in message)


# ══════════════════════════════════════════════════════════════════════════════
# 7. The reconciliation seam — one statement line, one seller
# ══════════════════════════════════════════════════════════════════════════════
#
# The bank feed cannot be built without a bank. The join can, and this is it.
# It identifies and does nothing else: no coin moves, no card is raised, no
# balance changes.

for field in (
    "credited_to",
    "amount_minor",
    "credited_at",
    "bank_reference",
    "collection_account",
):
    ok(
        f"the statement-line contract names {field}",
        field in ops.VAN_STATEMENT_LINE_FIELDS,
    )

LINE = {
    "credited_to": "91500000000001",
    "amount_minor": 250_000,
    "credited_at": NOW,
    "bank_reference": "HDFCR52026082400451",
    "collection_account": "50200099887766",
    "remitter_name": "MEENA KUMARI",
}

matched = run(ops.identify_payer(LINE))
check("a credit into a seller's VAN identifies them", matched["matched"], True)
check("…by partner id", matched["partner_id"], "seller-3")
check("…with the amount untouched", matched["amount_minor"], 250_000)
check(
    "…and an idempotency key built from the BANK's reference, not a typed one",
    matched["idempotency_key"],
    "bank:50200099887766:HDFCR52026082400451",
)
ok(
    "…and it says what happens next rather than doing it",
    "auto_verified" in matched["next_step"],
)
check(
    "nothing was credited — this identifies and stops",
    run(ops.get_partner("seller-3"))["coins_on_hand"],
    0,
)

unknown = run(ops.identify_payer({**LINE, "credited_to": "91500999999999"}))
check("an unrecognised VAN matches nobody", unknown["matched"], False)
check("…and names nobody", unknown["partner_id"], None)
ok("…and says nothing was guessed", "nothing is guessed" in unknown["reason"])

foreign = run(ops.identify_payer({**LINE, "collection_account": "50200011112222"}))
check("a line for somebody else's collection account matches nobody", foreign["matched"], False)
ok("…and says why", "is not ours" in foreign["reason"])

blankref = run(ops.identify_payer({**LINE, "bank_reference": ""}))
check("a line with no bank reference matches nobody", blankref["matched"], False)
ok("…because a replay could not be told apart", "replay" in blankref["reason"])

noline = run(ops.identify_payer({**LINE, "credited_to": ""}))
check("a line naming no virtual account matches nobody", noline["matched"], False)
ok("…and names the field that carries it", "credited_to" in noline["reason"])

# A suspended seller keeps their number — it is permanent — but money arriving
# for an account we have stopped trading with is a person's decision.
stored("seller-3")["status"] = str(PartnerStatus.SUSPENDED)
suspended = run(ops.identify_payer(LINE))
check("a credit for a suspended seller is not applied", suspended["matched"], False)
check("…but the seller is still named, because the number is still theirs",
      suspended["partner_id"], "seller-3")
ok("…and it says a person should decide", "for a person to decide" in suspended["reason"])
stored("seller-3")["status"] = str(PartnerStatus.APPROVED)

no_bank()
closed = run(ops.identify_payer(LINE))
check("with no bank there is no feed to reconcile", closed["matched"], False)
ok("…and the sentence is the same one everywhere else", closed["reason"] == ops.VAN_NO_BANK)


# ══════════════════════════════════════════════════════════════════════════════
# 8. The UTR path is untouched
# ══════════════════════════════════════════════════════════════════════════════
#
# The VAN work must not have quietly changed how a seller pays today. This is
# the live path and it stays exactly as it was.

no_bank()
FIRESTORE["seller-8"] = ("sellers", dict(SELLER_DOC, displayName="Eighth Shop"))
run(ops.approve_partner("seller-8", REASON, ACTOR))
card = run(
    ops.request_coin_purchase(
        "seller-8",
        1_000,
        250_000,
        "UTR-2026-0001",
        "https://example.test/proof.jpg",
        ACTOR,
        "Paid ₹2,500 for 1,000 coins by IMPS.",
    )
)
check("a seller with no VAN still buys inventory the old way", card["stage"], "requested")
check("…with the payment reference they typed", card["payload"]["payment_ref"], "UTR-2026-0001")
check("…and the proof they uploaded", card["evidence"][0]["kind"], "payment_proof")

refused = refuses(
    "a coin purchase with no payment reference",
    lambda: ops.request_coin_purchase("seller-8", 1_000, 250_000, "  ", "", ACTOR, "x"),
)
ok(
    "…is still refused, exactly as before",
    "payment reference" in refused,
)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} virtual-account checks passed.")
print("  · with no bank configured nothing is issued and nothing is invented —")
print("    no prefix, no counter, no partner id wearing an account number")
print("  · a half-configured bank is not a bank; all four settings or none")
print("  · with a bank and a client, a VAN is issued at approval BY THE BANK,")
print("    audited, mirrored to the document the app and portal read")
print("  · and never regenerated: a second request is refused with the first")
print("    number named, and the bank is not asked again")
print("  · a bank that is down or answers blank issues nothing, audits the")
print("    failure and leaves the approval standing")
print("  · agencies get none — a VAN collects money, and we pay agencies")
print("  · identify_payer turns one statement line into one seller, and refuses")
print("    an unknown number, a foreign collection account and a missing")
print("    reference rather than attributing them to the nearest partner")
print("  · the UTR-and-proof path a seller uses today is unchanged")
sys.exit(0)
