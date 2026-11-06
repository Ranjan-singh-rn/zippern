"""Owner, 6 Nov 2026 — the Economy Book: sold to sellers, lent, repaid, held, sold on to users, spent, owed, and the
logbook of ledger movements. Read-only; every figure from the store that holds it.

REAL: services/reports.economy_book, summarise_app_spend.
FAKE: Mongo (tests.harness.FakeDb); Firestore reads replaced by fixed rows.

    python3 -m tests.test_economy_book
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

from app.db.mongo import C  # noqa: E402
from app.services import reports as R  # noqa: E402

R.get_db = lambda: DB  # type: ignore[assignment]

checks, failures = 0, []


def ok(claim, cond):
    global checks
    checks += 1
    if not cond:
        failures.append(claim)


now = datetime.now(timezone.utc)
recent = now - timedelta(days=1)
old = now - timedelta(days=200)

DB[C.PARTNERS].docs += [
    {"_id": "S1", "kind": "seller", "name": "Shop One", "status": "approved", "total_coins_sold": 300,
     "credit": {"limit": 5000, "outstanding": 1000}},
    {"_id": "S2", "kind": "seller", "name": "Shop Two", "status": "approved", "total_coins_sold": 0},
    {"_id": "A1", "kind": "agency", "name": "Agency"},
]
DB[C.BALANCES].docs += [
    {"holder_type": "seller", "holder_id": "S1", "currency": "coins", "amount": 1700},
    {"holder_type": "seller", "holder_id": "S2", "currency": "coins", "amount": 500},
]
DB[C.CARDS].docs += [
    {"_id": "c1", "type": "seller_coin_purchase", "stage": "executed", "amount": 1000, "subject_id": "S1",
     "payload": {"amount_paid_minor": 100000}, "executed_at": recent},
    {"_id": "c2", "type": "seller_coin_purchase", "stage": "executed", "amount": 500, "subject_id": "S2",
     "payload": {"amount_paid_minor": 50000}, "executed_at": old},
    {"_id": "c3", "type": "seller_coin_purchase", "stage": "requested", "amount": 9999, "subject_id": "S2", "payload": {}},
    {"_id": "c4", "type": "lending_issue", "stage": "executed", "amount": 1000, "subject_id": "S1", "executed_at": recent},
]
DB[C.RECHARGES].docs += [
    {"_id": "r1", "status": "approved", "diamonds": 300, "credited_diamonds": 300, "amount_minor": 30000},
    {"_id": "r2", "status": "pending", "diamonds": 50},
    {"_id": "r3", "status": "rejected", "diamonds": 70},
]
DB[C.LEDGER].docs += [
    {"_id": "l1", "at": recent, "holder_type": "seller", "holder_id": "S1", "currency": "coins", "amount": 1000,
     "balance_before": 0, "balance_after": 1000, "action": "inventory.credit", "reason": "purchase",
     "actor": {"uid": "o1", "name": "Owner", "role": "superadmin"}, "idempotency_key": "card:c1:coins"},
    {"_id": "l2", "at": recent + timedelta(hours=1), "holder_type": "user", "holder_id": "u1", "currency": "diamonds",
     "amount": 300, "action": "balance.credit", "reason": "recharge", "actor": {"uid": "S1"}},
    {"_id": "l3", "at": old, "holder_type": "seller", "holder_id": "S2", "currency": "coins", "amount": 500,
     "action": "inventory.credit", "reason": "old", "actor": {}},
]


async def fake_scan(collection, field, since, until):
    assert collection == "platformRevenue"
    return [
        {"type": "gift", "grossDiamonds": 100, "payoutBeans": 60, "platformCut": 40},
        {"type": "gift", "grossDiamonds": 50, "payoutBeans": 30, "platformCut": 20},
        {"type": "call", "grossDiamonds": 80, "payoutBeans": 48, "platformCut": 32},
    ]

R._fs_scan = fake_scan  # type: ignore[assignment]
R._wallet_totals = lambda: {"wallets": 2, "diamonds": 170, "beans": 138}  # type: ignore[assignment]

book = asyncio.run(R.economy_book(now - timedelta(days=30), now + timedelta(minutes=1)))
h = book["headline"]
ok("sold to sellers counts only executed purchases (all time)", h["sold_to_sellers_coins"] == 1500)
ok("…and what they paid", h["sold_to_sellers_paid_minor"] == 150000)
ok("window figures only inside the window", book["wholesale"]["window_coins"] == 1000)
ok("lent coins", h["lent_to_sellers_coins"] == 1000)
ok("borrowed and not repaid", h["borrowed_outstanding_coins"] == 1000)
ok("held by sellers now", h["held_by_sellers_coins"] == 2200)
ok("sold on to users (approved recharges only)", h["sold_by_sellers_to_users_diamonds"] == 300)
ok("pending recharges counted apart", book["recharges"]["pending_diamonds"] == 50)
ok("in user wallets", h["in_user_wallets_diamonds"] == 170 and h["in_user_wallets_beans"] == 138)
ok("spent in the app (window)", h["spent_in_app_diamonds_window"] == 230)
ok("spend by type", book["app_spend"]["by_type"]["gift"]["gross_diamonds"] == 150 and book["app_spend"]["by_type"]["call"]["zipper_cut"] == 32)
ok("sellers listed, biggest debt first, agencies excluded", [s["id"] for s in book["sellers"]] == ["S1", "S2"])
ok("logbook: window only, newest first", [e["id"] for e in book["ledger"]] == ["l2", "l1"])
ok("logbook rows carry reference, actor and balances", book["ledger"][1]["reference"] == "card:c1:coins" and book["ledger"][1]["balance_after"] == 1000)

f = asyncio.run(R.economy_book(now - timedelta(days=30), now + timedelta(minutes=1), holder_type="seller"))
ok("logbook filter by holder type", [e["id"] for e in f["ledger"]] == ["l1"])


async def broken_scan(*a, **k):
    raise R.DataUnavailable("platformRevenue unreadable")

R._fs_scan = broken_scan  # type: ignore[assignment]
b = asyncio.run(R.economy_book(now - timedelta(days=30), now + timedelta(minutes=1)))
ok("an unreadable part is reported unavailable, never as zero", b["headline"]["spent_in_app_diamonds_window"] is None and b["unavailable"])

if failures:
    print(f"{len(failures)} of {checks} economy-book checks FAILED")
    for x in failures:
        print("  ✗", x)
    sys.exit(1)
print(f"All {checks} economy-book checks passed.")
