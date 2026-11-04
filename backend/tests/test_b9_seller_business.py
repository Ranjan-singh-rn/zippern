"""B9 (3 Nov 2026) — the coin-seller business, completed.

  1. Tiers: a seller on a priced tier is checked against the tier's wholesale price; no tier, the published one;
     a tier priced above retail is ignored; only a priced tier can be given; users' diamond price is untouched.
  2. Seller-to-seller trades: filed by the buyer, nothing moves until an owner approves; the selling seller's coins
     move to the buyer once (replayed approval moves nothing); refused — self, the same person behind two records,
     a circular trade, a reused payment reference, an overdue buyer; a short seller leaves it pending with the
     shortfall; the selling seller can dispute (approval then refuses); staff reject.
  3. Borrowing: no limit, no borrowing by request; within the limit it becomes an owner-signed lending card; past
     it, refused — staff lending included; a new loan never pushes back the due date of money already owed.
  4. Self-use: off unless the Owner switches it on; then coins → the seller's own wallet, never a sale.
  5. Profit: purchase cost, revenue (recharges, sales, trades), cost of coins sold, gross profit.
  6. The recharge "Total sold" now reaches the Firestore document the app reads.

REAL: services/seller_business, partner_ops, cards, money, recharges. FAKE: Mongo (harness.FakeDb), Firestore
(fakes.FakeFirestore), the rates.

    python3 -m tests.test_b9_seller_business
"""

from __future__ import annotations

import asyncio
import logging
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

from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.services import cards as cards_svc  # noqa: E402

# O6 (Owner decision, 5 Nov 2026): an Owner's signature now executes a coin / diamond card in the same request
# (`cards.AUTO_EXECUTE_ON_OWNER_SIGN`). This file pins the two-step board — sign, then the type's own execute route —
# which is what the flag restores when switched off and what a card signed before the decision still takes. Nothing
# asserted below changed; the decision's own behaviour is pinned in tests/test_o6_owner_sign_final.py.
cards_svc.AUTO_EXECUTE_ON_OWNER_SIGN = False
from app.services import partner_ops as ops  # noqa: E402
from app.services import reports as reports_svc  # noqa: E402
from app.services import seller_business as biz  # noqa: E402
from app.services.money import Currency, HolderType, Movement, apply_movement, get_balance  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

logging.disable(logging.CRITICAL)
run = asyncio.run
checks = 0
failures: list[str] = []


def ok(claim, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refuses(claim, coro, kind=PartnerOpsError) -> str:
    global checks
    checks += 1
    try:
        run(coro)
    except kind as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


_SEQ = {"n": 0}


def _oid() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _oid  # type: ignore[assignment]

OWNER = {"uid": "u-owner", "name": "Owner", "role": Role.OWNER, "team": None, "partner_ids": {}}
FIN = {"uid": "u-fin", "name": "Anil", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE, "partner_ids": {}}
DB.seed(C.STAFF, [{"uid": "u-owner", "email": "owner@zipper.test", "name": "Owner", "role": str(Role.OWNER), "is_active": True}])


def seller(pid, owner_uid, **extra):
    return {"_id": pid, "kind": "seller", "name": pid, "status": "approved", "is_active": True,
            "owner_crm_uid": owner_uid, "total_coins_sold": 0, **extra}


DB.seed(C.PARTNERS, [
    seller("S1", "u-s1"), seller("S2", "u-s2"), seller("S3", "u-s3"),
    seller("TWIN", "u-s1"),                       # the same person as S1, a second record
    seller("LATE", "u-late", credit={"outstanding": 500, "due_at": datetime.now(timezone.utc) - timedelta(days=2)}),
    seller("GOLD", "u-gold", tier="gold"),
])
for sid in ["S1", "S2", "S3", "TWIN", "LATE", "GOLD"]:
    fs.collection("sellers").docs[sid] = {"coinBalance": 0, "totalCoinsSold": 0}


class _Rates:
    seller_wholesale_price_inr_per_lakh = 2_000.0
    diamond_pack_price_inr_per_lakh = 2_390.0
    provisional = False
    seller_tiers = {"gold": {"name": "Gold", "price_per_lakh": 1_800.0}}


async def _rates():
    return _Rates()


reports_svc.load_rates = _rates  # type: ignore[assignment]


def coins(sid) -> int:
    return run(get_balance(HolderType.SELLER, sid, Currency.COINS))


def diamonds(uid) -> int:
    return run(get_balance(HolderType.USER, uid, Currency.DIAMONDS))


def give(sid, n, key):
    run(apply_movement(Movement(holder_type=HolderType.SELLER, holder_id=sid, currency=Currency.COINS, amount=n,
                                action="inventory.credit", reason="Test stock", actor=OWNER, idempotency_key=key,
                                meta={"amount_paid_minor": n * 2_000 * 100 // 100_000})))


def approve(card: dict) -> str:
    run(cards_svc.verify(card["id"], OWNER, "Checked."))
    run(cards_svc.sign(card["id"], OWNER, "Approved."))
    return card["id"]


def partner(pid):
    return next(d for d in DB[C.PARTNERS].docs if d["_id"] == pid)


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Tiers")

eq("the tier parser keeps priced tiers at or below retail",
   reports_svc.parse_seller_tiers({"gold": {"name": "Gold", "wholesalePriceInr": 1800}, "bad": {"wholesalePriceInr": 9999},
                                   "zero": {"wholesalePriceInr": 0}, "BAD ID": {"wholesalePriceInr": 10}}, 2390),
   {"gold": {"name": "Gold", "price_per_lakh": 1800.0}})
# Prices are ₹ per lakh: 100,000 coins cost a Gold seller ₹1,800 (180,000 paise); an untiered seller ₹2,000.
gold = run(ops.request_coin_purchase("GOLD", 100_000, 1_800 * 100, "UTR-G1", "", FIN, "Paid for 100,000 coins."))
ok("a Gold seller paying the Gold price is accepted", gold.get("id"))
msg = refuses("a Gold seller paying the untiered price must explain it",
              ops.request_coin_purchase("GOLD", 100_000, 2_000 * 100, "UTR-G2", "", FIN, "Paid for 100,000 coins."))
ok("…and is told the Gold price", "₹1,800.00" in msg, msg)
plain = run(ops.request_coin_purchase("S1", 100_000, 2_000 * 100, "UTR-S1", "", FIN, "Paid for 100,000 coins."))
ok("an untiered seller pays the published wholesale price", plain.get("id"))
r = run(biz.set_seller_tier("S1", "gold", "Volume above 10 lakh a month.", OWNER))
eq("only a priced tier can be given — gold was", (r["tier"], partner("S1").get("tier")), ("gold", "gold"))
eq("…and the app's seller document says so", fs.collection("sellers").docs["S1"].get("tier"), "gold")
refuses("a tier with no price is refused", biz.set_seller_tier("S1", "platinum", "Trying a tier.", OWNER))
run(biz.set_seller_tier("S1", "", "Back to the published price.", OWNER))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Seller-to-seller trades")

give("S2", 50_000, "t:stock:S2")
t = run(biz.request_trade("S1", "S2", 20_000, 45_000 * 100, "UTR-T1", "trade-req-0001", FIN))
eq("filed, nothing moved", (t["status"], coins("S1"), coins("S2")), ("pending", 0, 50_000))
again = run(biz.request_trade("S1", "S2", 20_000, 45_000 * 100, "UTR-T1", "trade-req-0001", FIN))
eq("the same filing twice is one trade", (again["id"], again["replayed"]), (t["id"], True))
refuses("a seller cannot buy from themselves", biz.request_trade("S1", "S1", 10, 0, "UTR-X", "trade-req-0002", FIN))
refuses("…nor from their own second record", biz.request_trade("TWIN", "S1", 10, 0, "UTR-X2", "trade-req-0003", FIN))
refuses("a payment reference already on a trade with that seller is refused",
        biz.request_trade("S3", "S2", 10, 0, "UTR-T1", "trade-req-0004", FIN))
refuses("a buyer with overdue credit takes no inventory", biz.request_trade("LATE", "S2", 10, 0, "UTR-L", "trade-req-0005", FIN))
refuses("a trade straight back while one is pending the other way is circular",
        biz.request_trade("S2", "S1", 10, 0, "UTR-C1", "trade-req-0006", FIN))
done = run(biz.approve_trade(t["id"], "UTR verified against the bank statement.", OWNER))
eq("approved: the coins moved once", (done["status"], coins("S1"), coins("S2")), ("approved", 20_000, 30_000))
refuses("approving again moves nothing", biz.approve_trade(t["id"], "Again.", OWNER))
eq("…and nothing moved twice", (coins("S1"), coins("S2")), (20_000, 30_000))
keys = sorted(d["idempotency_key"] for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(f"strade:{t['id']}"))
eq("two ledger rows, deterministic keys", keys, [f"strade:{t['id']}:credit", f"strade:{t['id']}:debit"])
refuses("selling the coins straight back inside seven days is circular",
        biz.request_trade("S2", "S1", 1_000, 0, "UTR-C2", "trade-req-0007", FIN))
eq("the mirror shows it approved", fs.collection("sellerTrades").docs[t["id"]].get("status"), "approved")

big = run(biz.request_trade("S3", "S2", 999_999, 0, "UTR-BIG", "trade-req-0008", FIN))
refuses("a seller short of coins leaves the trade pending", biz.approve_trade(big["id"], "Verified.", OWNER))
eq("…with the shortfall recorded and nothing moved",
   (next(d for d in DB[biz.TRADES].docs if d["_id"] == big["id"])["status"], coins("S2"), coins("S3")), ("pending", 30_000, 0))
run(biz.dispute_trade(big["id"], "S2", "I was never paid for this.", {"uid": "u-s2", "name": "S2", "role": Role.SELLER, "partner_ids": {"seller": "S2"}}))
msg = refuses("a disputed trade is not approved", biz.approve_trade(big["id"], "Verified.", OWNER))
ok("…and says why", "not paid" in msg, msg)
refuses("only the selling seller disputes", biz.dispute_trade(big["id"], "S3", "Not me.", FIN))
rej = run(biz.reject_trade(big["id"], "Seller says unpaid; buyer may refile with proof.", OWNER))
eq("staff reject it; nothing moved", (rej["status"], coins("S2"), coins("S3")), ("rejected", 30_000, 0))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Borrowing")

refuses("no limit: no borrowing by request", biz.request_borrow("S3", 1_000, 14, "Stock for the weekend.", FIN))
run(biz.set_credit_limit("S3", 10_000, "Six months of on-time payments.", OWNER))
card = run(biz.request_borrow("S3", 6_000, 14, "Stock for the weekend.", FIN))
eq("within the limit it is a lending card for an owner to sign", (card.get("type"), card.get("requested_by_seller")), ("lending_issue", True))
refuses("past the limit by request is refused", biz.request_borrow("S3", 20_000, 14, "More stock.", FIN))
refuses("…and staff cannot lend past it either",
        ops.request_lending("S3", 20_000, datetime.now(timezone.utc) + timedelta(days=10), "", "Big order.", FIN))
refuses("a repayment date more than 30 days away is refused", biz.request_borrow("S3", 100, 45, "Long loan.", FIN))
first_due = datetime.now(timezone.utc) + timedelta(days=5)
c1 = approve(run(ops.request_lending("S3", 1_000, first_due, "", "First loan.", FIN)))
run(ops.execute_lending(c1, OWNER))
c2 = approve(run(ops.request_lending("S3", 1_000, datetime.now(timezone.utc) + timedelta(days=25), "", "Second loan.", FIN)))
run(ops.execute_lending(c2, OWNER))
due = partner("S3")["credit"]["due_at"]
ok("a second loan does not push back the first one's due date", abs((due - first_due).total_seconds()) < 2, f"{due} vs {first_due}")
eq("the debt is both loans", partner("S3")["credit"]["outstanding"], 2_000)

# ══════════════════════════════════════════════════════════════════════════════
print("4. Self-use")

SELF = {"uid": "u-s1", "name": "S1", "role": Role.SELLER, "partner_ids": {"seller": "S1"}}
refuses("off unless Zipper switches it on", biz.use_inventory_for_self("S1", 1_000, "self-use-0001", "For my own calls.", SELF))
fs.collection("appConfig").docs["economy"] = {"sellerSelfUseAllowed": True}
sold_before = partner("S1").get("total_coins_sold", 0)
u = run(biz.use_inventory_for_self("S1", 1_000, "self-use-0001", "For my own calls.", SELF))
eq("coins → the seller's own wallet", (coins("S1"), diamonds("u-s1"), u["credited_uid"]), (19_000, 1_000, "u-s1"))
eq("…never a sale", partner("S1").get("total_coins_sold", 0), sold_before)
eq("the same request twice moves once", (run(biz.use_inventory_for_self("S1", 1_000, "self-use-0001", "For my own calls.", SELF))["replayed"], coins("S1")), (True, 19_000))

# ══════════════════════════════════════════════════════════════════════════════
print("5. Profit")

DB.seed("partner_sales", [{"_id": "sale-1", "seller_id": "S1", "buyer_uid": "b1", "diamonds": 5_000, "amount_paid_minor": 12_000 * 100,
                           "status": "approved"}])
p = run(biz.seller_profit("S1"))
eq("purchases: the trade's 20,000 coins at ₹45,000", (p["purchased_coins"], p["purchase_cost_minor"]), (20_000, 45_000 * 100))
eq("sales: 5,000 coins for ₹12,000", (p["coins_sold"], p["revenue_minor"]), (5_000, 12_000 * 100))
eq("cost of those coins at the average cost", p["cost_of_sold_minor"], 5_000 * 45_000 * 100 // 20_000)
eq("gross profit = revenue − cost of sold", p["gross_profit_minor"], 12_000 * 100 - 5_000 * 45_000 * 100 // 20_000)
eq("inventory and self-use as recorded", (p["inventory_coins"], p["self_use_coins"]), (19_000, 1_000))
ok("the definitions travel with the figures", "gross_profit_minor" in p["definitions"])
p2 = run(biz.seller_profit("S2"))
eq("the selling side of the trade is revenue", (p2["coins_sold"], p2["revenue_minor"]), (20_000, 45_000 * 100))

# ══════════════════════════════════════════════════════════════════════════════
print("6. A recharge's Total sold reaches the app")

src = (ROOT / "app" / "services" / "recharges.py").read_text()
ok("approve_recharge syncs totalCoinsSold to the seller document",
   '_sync_partner_doc(seller_after, {"totalCoinsSold"' in src)

print()
if failures:
    print(f"{len(failures)} of {checks} B9 checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} B9 coin-seller checks passed.")
