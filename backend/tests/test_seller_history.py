"""One seller's whole record, in one list.

`partners.seller_statement` is the coin ledger and only the coin ledger, and
three things fall straight through it. This test exists to hold each of them
shut, because each one was a real question with no answer anywhere in the
product:

  * **A repayment appears in the coin statement at no limit and in no period.**
    `execute_repayment` writes no ledger movement — the debt is denominated in
    coins that were issued and already sold, so what closes is a number on the
    partner record. The seller who paid it could see it nowhere; the owner
    could see it nowhere. It is asserted here *both* ways round: absent from
    the statement, present in the history, with its UTR.
  * **Rupees.** The amount and the payment reference live on the card, not in
    the ledger, and `cash_paid_minor` on the record is one lifetime `$inc` that
    no window can be taken out of. "How much business did I do with him in this
    period" had no source at all.
  * **Sales.** `partner_sales` holds the buyer and what the seller took. The
    ledger sees an unattributed inventory debit.

Nothing here writes a card, a ledger row or a credit event by hand. Every
movement is made through the real `partner_ops` request → verify → sign →
execute path, so if any of those ever stops writing what this reads, this test
fails rather than passing against a shape invented in it.

Run:  python3 -m tests.test_seller_history
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]


# `money.apply_movement` opens a session and a transaction. Mongo's are real;
# these do nothing. Every other guarantee of the movement — the mandatory
# reason, the negative-balance refusal, the idempotency key, the ledger row and
# the audit row — is the real code.
class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def start_transaction(self):
        return _FakeTransaction()


class _FakeClient:
    async def start_session(self):
        return _FakeSession()


mongo.get_client = lambda: _FakeClient()  # type: ignore[assignment]

from app.db.mongo import C  # noqa: E402

import app.db.firebase as firebase  # noqa: E402

firebase.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]

from app.core.roles import Role, Team  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402

# The card engine round-trips every id through `bson.ObjectId`, and the
# harness's stand-in refuses anything that is not 24 characters.
_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]
# `approve_sale` does the same to a sale id.
DB[C.SALES]._next_id = _card_id  # type: ignore[assignment]

# Firestore is a replica here and everywhere else. Mongo is the record.
ops._sync_partner_doc = lambda partner, fields: True  # type: ignore[assignment]

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
    return asyncio.run(coro)


# ── The world ─────────────────────────────────────────────────────────────────

NOW = datetime.now(timezone.utc)
DUE = NOW + timedelta(days=30)

SELLER_ID = "seller-mine"
BUYER_UID = "firebase-uid-buyer-1"

DB.seed(
    C.PARTNERS,
    [
        {
            "_id": SELLER_ID,
            "kind": "seller",
            "name": "Mine Ltd",
            "status": "approved",
            "is_active": True,
            "credit": {"outstanding": 0, "due_at": None, "history": []},
            "cash_paid_minor": 0,
            "total_coins_sold": 0,
            "created_at": NOW,
        }
    ],
)


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team, "partner_ids": {}}


def external(uid: str, role: Role, ids: dict) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": None, "partner_ids": ids}


RAISER = internal("uid-finance-a", Role.FINANCE_ADMIN, Team.FINANCE)
VERIFIER = internal("uid-finance-b", Role.FINANCE_ADMIN, Team.FINANCE)
OWNER = internal("uid-owner", Role.OWNER)
SELLER = external("uid-seller", Role.SELLER, {"seller": SELLER_ID})


def drive(card: dict, note: str) -> str:
    """Take a raised card all the way to signed. Nothing has moved yet."""
    card_id = card["id"]
    run(cards_svc.verify(card_id, VERIFIER, note))
    run(cards_svc.sign(card_id, OWNER, "Approved."))
    return card_id


# ══════════════════════════════════════════════════════════════════════════════
# The movements, made for real
# ══════════════════════════════════════════════════════════════════════════════

# 1. The seller pays ₹2,50,000 for 100,000 coins and we credit them.
purchase = run(
    ops.request_coin_purchase(
        SELLER_ID,
        100_000,
        25_000_000,
        "UTR-BUY-1",
        "https://example.test/proof-1.jpg",
        SELLER,
        "Paid 2,50,000 rupees by IMPS for the stock, rate agreed on call.",
    )
)
run(ops.execute_coin_purchase(drive(purchase, "Bank line matches the UTR."), OWNER))

# 2. We lend them 50,000 coins on credit, due in 30 days.
lending = run(
    ops.request_lending(
        SELLER_ID, 50_000, DUE, "Repay within 30 days.",
        "Trading well and asked for stock on credit ahead of the festival.",
        RAISER,
    )
)
run(ops.execute_lending(drive(lending, "Credit limit and standing checked."), OWNER))

# 3. They sell 30,000 diamonds to a buyer for ₹90,000, and an owner approves it.
sale = run(
    ops.record_sale(
        SELLER_ID, BUYER_UID, 30_000, 9_000_000, SELLER,
        "Sold 30,000 diamonds to a walk-in buyer, cash taken.",
    )
)
run(ops.approve_sale(sale["id"], "Buyer confirmed receipt; releasing the diamonds.", OWNER))

# 4. They repay 20,000 against the debt. THIS MOVES NO COINS.
repayment = run(
    ops.request_repayment(
        SELLER_ID, 20_000, "UTR-REPAY-1",
        "Seller transferred against the outstanding credit.",
        RAISER,
    )
)
run(ops.execute_repayment(drive(repayment, "Repayment landed, reference matches."), OWNER))

# 5. We recover 10,000 plus a 1,000 penalty out of the stock they hold.
recovery = run(
    ops.request_recovery(
        SELLER_ID, 10_000, 1_000,
        "Balance of the credit is past due; recovering from stock.",
        RAISER,
    )
)
run(ops.execute_recovery(drive(recovery, "Stock confirmed sufficient."), OWNER))

# 6. And one lending card that is raised and NOT executed. Nothing has moved on
#    it, and both audiences have to be able to see that it exists and that it
#    has not.
pending_lending = run(
    ops.request_lending(
        SELLER_ID, 7_000, DUE, "Same terms.",
        "Second tranche requested; raised and awaiting the board.",
        RAISER,
    )
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. The gap: a repayment is in no coin statement, at any limit
# ══════════════════════════════════════════════════════════════════════════════

statement = run(partner_svc.seller_statement(SELLER_ID, limit=500))
actions = {str(e.get("action") or "") for e in statement.entries}

ok("the coin statement has the purchase", "inventory.credit" in actions)
ok("…the lending", "lending.issue" in actions)
ok("…the sale's debit", "inventory.debit" in actions)
ok("…and the recovery", "lending.recover" in actions)
ok(
    "but a repayment appears in the coin statement NOWHERE — it moves no coins",
    "lending.repay" not in actions,
)


# ══════════════════════════════════════════════════════════════════════════════
# 2. The history has all of it, once each
# ══════════════════════════════════════════════════════════════════════════════

history = run(partner_svc.seller_history(SELLER_ID))
rows = history.rows

by_kind: dict[str, list[dict]] = {}
for row in rows:
    by_kind.setdefault(str(row["kind"]), []).append(row)

check("one purchase row", len(by_kind.get("coin_purchase", [])), 1)
check("one sale row", len(by_kind.get("sale", [])), 1)
check("one repayment row", len(by_kind.get("repayment", [])), 1)
check("one recovery row", len(by_kind.get("recovery", [])), 1)
check("two lending rows — one executed, one still on the board",
      len(by_kind.get("lending_issue", [])), 2)
check("six rows and no seventh", len(rows), 6)

ok("newest first", all(rows[i]["at"] >= rows[i + 1]["at"] for i in range(len(rows) - 1)))
ok("every row is dated", all(isinstance(r["at"], datetime) for r in rows))


# ── The repayment, which is the whole point ───────────────────────────────────

repaid = by_kind["repayment"][0]
check("the repayment carries its UTR", repaid["reference"], "UTR-REPAY-1")
check("…moves no coins, and says zero rather than nothing", repaid["coins"], 0)
check("…and takes 20,000 off what they owe", repaid["owed_delta"], -20_000)
check("…as an executed movement", repaid["settled"], True)
check("…with the card it came from", repaid["card_stage"], "executed")
ok("…and its card id", bool(repaid["card_id"]))


# ── The purchase: rupees, reference and proof, none of which are in the ledger ─

bought = by_kind["coin_purchase"][0]
check("the purchase carries the rupees, in paise", bought["amount_minor"], 25_000_000)
check("…the UTR", bought["reference"], "UTR-BUY-1")
check("…the proof", bought["proof_url"], "https://example.test/proof-1.jpg")
check("…the coins that actually moved", bought["coins"], 100_000)
check("…and which way the money went", bought["money"], "seller_paid_zipper")


# ── The sale: the only row with a counterparty ────────────────────────────────

sold = by_kind["sale"][0]
check("the sale names the buyer", sold["counterparty"], BUYER_UID)
check("…what the seller took for it", sold["amount_minor"], 9_000_000)
check("…and the stock that left", sold["coins"], -30_000)
check("…money that never touched us", sold["money"], "buyer_paid_seller")


# ── The recovery: what was taken, not what was asked for ──────────────────────

recovered = by_kind["recovery"][0]
check("the recovery took 11,000 out of stock", recovered["coins"], -11_000)
check("…and left the penalty on the debt", recovered["owed_delta"], 1_000 - 11_000)


# ── The card nobody signed off: visible, and visibly unmoved ──────────────────

still_open = [r for r in by_kind["lending_issue"] if not r["settled"]]
check("the unexecuted lending is on the list", len(still_open), 1)
check("…having moved no coins", still_open[0]["coins"], 0)
check("…and changed no debt", still_open[0]["owed_delta"], 0)
check("…while saying what was asked for", still_open[0]["requested_coins"], 7_000)
ok("…and where it has got to", still_open[0]["card_stage"] in
   {"requested", "under_review", "awaiting_signoff", "approved"})


# ══════════════════════════════════════════════════════════════════════════════
# 3. "How much business have I done with him" — the totals
# ══════════════════════════════════════════════════════════════════════════════

totals = history.totals
check("coins bought", totals["coins_bought"], 100_000)
check("rupees they paid us, in paise", totals["rupees_paid_minor"], 25_000_000)
check("coins sold", totals["coins_sold"], 30_000)
check("rupees they took for them, in paise", totals["rupees_taken_minor"], 9_000_000)
check("coins lent to them", totals["coins_lent"], 50_000)
check("coins repaid", totals["coins_repaid"], 20_000)
check("coins recovered from their stock", totals["coins_recovered"], 11_000)

check("five movements have actually happened", totals["settled_movements"], 5)
check("one has not", totals["pending_movements"], 1)
check("…and it is excluded from every total above", totals["pending_coins"], 7_000)


# ══════════════════════════════════════════════════════════════════════════════
# 4. The window, which `cash_paid_minor` could never be scoped to
# ══════════════════════════════════════════════════════════════════════════════

wide = run(
    partner_svc.seller_history(
        SELLER_ID, NOW - timedelta(days=1), NOW + timedelta(days=1)
    )
)
check("a window around today holds everything", len(wide.rows), 6)
check("…and the same totals", wide.totals["rupees_paid_minor"], 25_000_000)
check("…and reports its own bounds", wide.period_from, NOW - timedelta(days=1))

empty = run(
    partner_svc.seller_history(
        SELLER_ID, NOW - timedelta(days=90), NOW - timedelta(days=60)
    )
)
check("a window before any of it holds nothing", len(empty.rows), 0)
check("…and totals nothing, rather than a lifetime figure", empty.totals["rupees_paid_minor"], 0)
check("…which is what `cash_paid_minor` cannot do", empty.totals["coins_bought"], 0)

# The lifetime counter, for contrast: it is the same number in every window,
# which is exactly why it cannot answer the owner's question.
lifetime = run(partner_svc.seller_statement(SELLER_ID))
check("the lifetime counter says the same thing whatever you ask",
      lifetime.cash_paid_minor, 25_000_000)


# ══════════════════════════════════════════════════════════════════════════════
# 5. It is one seller's record and nobody else's
# ══════════════════════════════════════════════════════════════════════════════

DB.seed(
    C.PARTNERS,
    [
        {
            "_id": "seller-theirs",
            "kind": "seller",
            "name": "Theirs Ltd",
            "status": "approved",
            "is_active": True,
            "credit": {"outstanding": 0, "due_at": None, "history": []},
            "cash_paid_minor": 0,
            "total_coins_sold": 0,
            "created_at": NOW,
        }
    ],
)
theirs = run(partner_svc.seller_history("seller-theirs"))
check("another seller's history is their own, and it is empty", len(theirs.rows), 0)
check("…with no part of the first seller's rupees in it",
      theirs.totals["rupees_paid_minor"], 0)

# A seller that does not exist is not an error and is not somebody else's data.
nobody = run(partner_svc.seller_history("seller-nobody"))
check("an unknown seller has no history", len(nobody.rows), 0)
check("…and no name to print", nobody.name, "")


# ══════════════════════════════════════════════════════════════════════════════
# 6. Truncation says so, rather than looking like an empty period
# ══════════════════════════════════════════════════════════════════════════════

small = run(partner_svc.seller_history(SELLER_ID, limit=2))
check("a short limit returns the short list", len(small.rows), 2)
check("…and says it was cut", small.truncated, True)
ok("…while the full read does not claim to be", not history.truncated)
ok("…and every source reports what it read", history.sources["cards"] >= 5)


# ══════════════════════════════════════════════════════════════════════════════
# 7. A refused card is neither business done nor business in flight
# ══════════════════════════════════════════════════════════════════════════════
#
# Counting a rejection as pending would have somebody chasing a card that was
# refused weeks ago; counting it as settled would report money that never moved.
# It is listed, with its stage, and counted as neither.

refused = run(
    ops.request_coin_purchase(
        SELLER_ID, 4_000, 1_000_000, "UTR-BAD-1", "", SELLER,
        "Paid 10,000 rupees for 4,000 coins — reference turned out to be wrong.",
    )
)
run(cards_svc.reject(refused["id"], VERIFIER, "Reference belongs to another payment."))

after = run(partner_svc.seller_history(SELLER_ID))
rejected_rows = [r for r in after.rows if r["card_stage"] == "rejected"]
check("the rejected purchase is on the list", len(rejected_rows), 1)
check("…and moved nothing", rejected_rows[0]["coins"], 0)
check("…and is counted as refused", after.totals["refused_movements"], 1)
check("…not as pending", after.totals["pending_movements"], 1)
check("…and its rupees are in no total", after.totals["rupees_paid_minor"], 25_000_000)


# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\n  ✓ all {checks} seller-history checks passed\n")
print("  Six real movements, driven through request → verify → sign → execute:\n")
print(f"    {'what':<26} {'coins':>10} {'owed':>10} {'rupees (paise)':>16}  reference")
for row in history.rows:
    print(
        f"    {str(row['what']):<26} {row['coins']:>10,} {row['owed_delta']:>10,} "
        f"{row['amount_minor']:>16,}  {row['reference'] or '—'}"
    )
print()
print("  · a repayment moves no coins, so the coin statement cannot show one at")
print("    any limit — it is read from the card and the credit history instead")
print("  · rupees, the UTR and the proof live on the card, never in the ledger")
print("  · a sale names its buyer and what the seller took for the coins")
print("  · a card nobody executed is listed and excluded from every total")
print("  · and the totals are scoped to a window, which the lifetime")
print("    cash_paid_minor counter on the partner record can never be")
sys.exit(0)
