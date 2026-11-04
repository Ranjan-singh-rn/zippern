"""B1 — card executors and accruals: M-12, B-5, M-11, M-6, B-22.

  1. M-12 / B-5: every executor claims the card first (a reject then loses);
     a replayed execution — double click, retry, two at once — moves money
     once and closes the card as EXECUTED rather than FAILED; repayment,
     recovery and write-off apply their figure once and conditionally, so a
     lending executing concurrently with a repayment cannot overwrite it.
  2. M-11: a sale is filed only against a buyer that exists; approval is a
     compare-and-set (two approvals → one movement); a credit failure after
     the debit leaves the sale `failed` and RESUMABLE — approving again
     continues with the credit and never debits the seller twice; the buyer's
     history carries `sale_{id}`.
  3. M-6 / B-7: an accrual is keyed on the window, not the label — the same
     week under two labels accrues once; a month overlapping an accrued week
     is refused; an accrual made under the legacy label key is recognised.
  4. B-22: the human accrual path refuses a provisional slab table exactly as
     the unattended one does.

REAL: `services/partner_ops`, `services/cards`, `services/money`,
      `services/commission` (window resolution).
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), the slab
      table and bean rate (`commission.compute_for_period` is driven through a
      fixed table so the test owns the figures).

    python3 -m tests.test_m_executors
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
from app.services import commission as commission_svc  # noqa: E402
from app.services import owner_mail  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services.cards import CardError  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402
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
DB["partner_sales"]._next_id = _oid  # type: ignore[assignment]

OWNER = {"uid": "u-owner", "name": "Owner", "role": Role.OWNER, "team": None, "partner_ids": {}}
FIN = {"uid": "u-fin", "name": "Anil", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE, "partner_ids": {}}
DB.seed(C.STAFF, [{"uid": "u-owner", "email": "owner@zipper.test", "name": "Owner", "role": str(Role.OWNER), "is_active": True}])
DB.seed(C.PARTNERS, [
    {"_id": "SELL", "kind": "seller", "name": "Coins R Us", "status": "approved", "is_active": True,
     "owner_crm_uid": "u-seller", "total_coins_sold": 0},
    {"_id": "AG", "kind": "agency", "name": "Stars Agency", "status": "approved", "is_active": True,
     "owner_crm_uid": "u-agency"},
])
fs.collection("sellers").docs["SELL"] = {"coinBalance": 0}
firebase_mod.read_host_wallet = lambda uid: (  # type: ignore[assignment]
    {"beans": 0, "beans_available": 0, "agency_id": "", "is_verified_host": False, "name": "Buyer"}
    if uid.startswith("buyer") else None
)
# Rates: a known wholesale price so a purchase's amount check is deterministic.
from app.services import reports as reports_svc  # noqa: E402


class _Rates:
    seller_wholesale_price_inr_per_lakh = 2_000.0
    diamond_pack_price_inr_per_lakh = 2_290.0
    provisional = False


async def _rates():
    return _Rates()


reports_svc.load_rates = _rates  # type: ignore[assignment]


def coins() -> int:
    return run(get_balance(HolderType.SELLER, "SELL", Currency.COINS))


def card_doc(cid: str) -> dict:
    return next(d for d in DB[C.CARDS].docs if str(d["_id"]) == cid)


def partner(pid: str) -> dict:
    return next(d for d in DB[C.PARTNERS].docs if d["_id"] == pid)


def approve(card: dict) -> str:
    run(cards_svc.verify(card["id"], OWNER, "Checked."))
    run(cards_svc.sign(card["id"], OWNER, "Approved."))
    return card["id"]


def ledger_keys(prefix: str) -> list[str]:
    return sorted(d["idempotency_key"] for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(prefix))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. M-12 / B-5 — claim first, replay once, close as executed")

p = approve(run(ops.request_coin_purchase("SELL", 10_000, 2_000 * 100 * 10_000 // 100_000, "UTR-P1", "", FIN,
                                          "Paid for 10,000 coins of inventory.")))
first = run(ops.execute_coin_purchase(p, OWNER))
eq("the purchase executed", (first["stage"], coins()), ("executed", 10_000))
ok("…and the card was claimed before the money moved", card_doc(p).get("execution_claimed_at") is not None)
refuses("executing it again is refused by the board", ops.execute_coin_purchase(p, OWNER))
eq("…and moved nothing", coins(), 10_000)

# B-5: the ledger row landed but the card was not closed (a crash in between).
p2 = approve(run(ops.request_coin_purchase("SELL", 5_000, 2_000 * 100 * 5_000 // 100_000, "UTR-P2", "", FIN,
                                           "Paid for 5,000 coins of inventory.")))
real_finish = ops._finish
async def _crash_before_close(*a, **k):
    raise RuntimeError("process died before closing the card")
ops._finish = _crash_before_close
try:
    run(ops.execute_coin_purchase(p2, OWNER))
except RuntimeError:
    pass
ops._finish = real_finish
eq("the coins landed", coins(), 15_000)
eq("…the card is still approved (claimed)", card_doc(p2)["stage"], "approved")
m = ""
try:
    run(cards_svc.reject(p2, OWNER, "Changed my mind."))
except CardError as exc:
    m = str(exc)
ok("a reject after the claim is refused", "already started" in m, m)
again = run(ops.execute_coin_purchase(p2, OWNER))
eq("B-5: executing again closes the card as EXECUTED, not failed", again["stage"], "executed")
eq("…with the ledger's own figures and the replay noted", (again["execution_result"].get("already_applied"), coins()), (True, 15_000))
eq("…one ledger row", ledger_keys(f"card:{p2}:"), [f"card:{p2}:coins"])
eq("…and cash_paid_minor counted once", partner("SELL").get("cash_paid_minor"), 2_000 * 100 * 15_000 // 100_000)

# Two executions at once: one movement, one executed card.
p3 = approve(run(ops.request_coin_purchase("SELL", 100, 2_000 * 100 * 100 // 100_000, "UTR-P3", "", FIN,
                                           "Paid for 100 coins of inventory.")))


async def _twice():
    return await asyncio.gather(ops.execute_coin_purchase(p3, OWNER), ops.execute_coin_purchase(p3, OWNER),
                                return_exceptions=True)


res = run(_twice())
eq("two executions at once: one succeeds", sum(1 for r in res if isinstance(r, dict)), 1)
eq("…the coins moved once", coins(), 15_100)
eq("…and the card is executed", card_doc(p3)["stage"], "executed")

# Lending, repayment, recovery, write-off — conditional, idempotent.
due = datetime.now(timezone.utc) + timedelta(days=30)
lend = approve(run(ops.request_lending("SELL", 4_000, due, "30 days", "Stock on credit ahead of the festival.", FIN)))
run(ops.execute_lending(lend, OWNER))
eq("lending credited the coins and recorded the debt", (coins(), partner("SELL")["credit"]["outstanding"]), (19_100, 4_000))
replay = run(ops.execute_lending(lend, OWNER)) if False else None
# A lending replayed after a crash between the record update and the close:
run(DB[C.CARDS].update_one({"_id": lend}, {"$set": {"stage": "approved"}}))
again = run(ops.execute_lending(lend, OWNER))
eq("a replayed lending records the debt ONCE", (again["execution_result"]["debt_recorded"], partner("SELL")["credit"]["outstanding"], coins()),
   ("replayed", 4_000, 19_100))

repay = approve(run(ops.request_repayment("SELL", 1_500, "UTR-R1", "Seller transferred against the credit.", FIN)))
recover = approve(run(ops.request_recovery("SELL", 1_000, 100, "Overdue; recovering from stock.", FIN)))
# The repayment and the recovery execute concurrently: both figures must land.


async def _both():
    return await asyncio.gather(ops.execute_repayment(repay, OWNER), ops.execute_recovery(recover, OWNER),
                                return_exceptions=True)


res = run(_both())
ok("both executed", all(isinstance(r, dict) for r in res), str(res))
credit = partner("SELL")["credit"]
eq("the outstanding figure holds both: 4000 − 1500 + 100 − 1100", credit["outstanding"], 1_500)
eq("…totals are right", (credit["total_repaid"], credit["total_recovered"], credit["total_penalty"]), (1_500, 1_100, 100))
eq("…the recovery debited the coins once", coins(), 18_000)
eq("…and each card wrote exactly one history entry", sorted(h["card_id"] for h in credit["history"]), sorted([lend, repay, recover]))
# Replays apply nothing twice.
for cid, fn in ((repay, ops.execute_repayment), (recover, ops.execute_recovery)):
    run(DB[C.CARDS].update_one({"_id": cid}, {"$set": {"stage": "approved"}}))
    out = run(fn(cid, OWNER))
    eq(f"a replayed {card_doc(cid)['type']} applies nothing twice", (out["execution_result"].get("replayed"), partner("SELL")["credit"]["outstanding"], coins()),
       (True, 1_500, 18_000))
wo = approve(run(ops.write_off_debt("SELL", 1_500, "Seller gone; writing the rest off.", OWNER)))
out = run(ops.execute_write_off(wo, OWNER))
eq("the write-off closes the debt", (out["execution_result"]["written_off"], partner("SELL")["credit"]["outstanding"]), (1_500, 0))
run(DB[C.CARDS].update_one({"_id": wo}, {"$set": {"stage": "approved"}}))
out = run(ops.execute_write_off(wo, OWNER))
eq("…and a replay writes nothing off twice", (out["execution_result"]["replayed"], partner("SELL")["credit"]["total_written_off"]), (True, 1_500))

# ══════════════════════════════════════════════════════════════════════════════
print("2. M-11 — sales: a real buyer, a CAS, a resumable credit, a history row")

refuses("a sale needs a buyer that exists", ops.record_sale("SELL", "nobody-1", 10, 1_000, FIN, "Sold to a ghost."))
fs.collection("users").docs["buyer-1"] = {"name": "Buyer", "diamonds": 0}
sale = run(ops.record_sale("SELL", "buyer-1", 1_000, 229_000, FIN, "Walk-in sale, cash taken."))
eq("filed pending with the buyer's name", (sale["status"], sale["buyer_name"]), ("pending", "Buyer"))


async def _two_approvals():
    return await asyncio.gather(ops.approve_sale(sale["id"], "Buyer confirmed.", OWNER),
                                ops.approve_sale(sale["id"], "Buyer confirmed again.", OWNER), return_exceptions=True)


res = run(_two_approvals())
eq("two approvals at once: one wins", sum(1 for r in res if isinstance(r, dict)), 1)
eq("…the seller is debited once and the buyer credited once", (coins(), fs.collection("users").docs["buyer-1"]["diamonds"]), (17_000, 1_000))
eq("…with the history row under the sale id",
   fs.collection("users").document("buyer-1").collection("diamondTransactions").docs[f"sale_{sale['id']}"]["amount"], 1_000)
refuses("an approved sale cannot be approved again", ops.approve_sale(sale["id"], "Again.", OWNER))

# The credit fails after the debit: failed, then resumed.
fs.collection("users").docs["buyer-2"] = {"name": "Buyer Two", "diamonds": 0}
sale2 = run(ops.record_sale("SELL", "buyer-2", 500, 100_000, FIN, "Second sale."))
real_move = ops._move_once
async def _credit_fails(m):
    if m.holder_type == HolderType.USER:
        raise RuntimeError("Mongo write failed on the credit")
    return await real_move(m)
ops._move_once = _credit_fails
m = refuses("a credit failure after the debit is reported", ops.approve_sale(sale2["id"], "Confirmed.", OWNER))
ops._move_once = real_move
ok("…saying approve again finishes it", "approve it again" in m, m)
sale_doc = next(d for d in DB["partner_sales"].docs if str(d["_id"]) == sale2["id"])
eq("…the sale is failed, the seller debited, the buyer not credited",
   (sale_doc["status"], coins(), fs.collection("users").docs["buyer-2"]["diamonds"]), ("failed", 16_500, 0))
resumed = run(ops.approve_sale(sale2["id"], "Resuming.", OWNER))
eq("M-11: approving again resumes and finishes", (resumed["status"], resumed["resumed"]), ("approved", True))
eq("…without a second debit, with the credit", (coins(), fs.collection("users").docs["buyer-2"]["diamonds"]), (16_500, 500))
eq("…one ledger row per side", ledger_keys(f"sale:{sale2['id']}:"), [f"sale:{sale2['id']}:coins", f"sale:{sale2['id']}:diamonds"])
# A live claim refuses; a stale one is re-taken.
fs.collection("users").docs["buyer-3"] = {"name": "Buyer Three", "diamonds": 0}
sale3 = run(ops.record_sale("SELL", "buyer-3", 10, 1_000, FIN, "Third."))
run(DB["partner_sales"].update_one({"_id": sale3["id"]}, {"$set": {"status": "approving", "claimed_at": datetime.now(timezone.utc)}}))
refuses("a live claim refuses a second approval", ops.approve_sale(sale3["id"], "Again.", OWNER))
run(DB["partner_sales"].update_one({"_id": sale3["id"]}, {"$set": {"claimed_at": datetime.now(timezone.utc) - timedelta(hours=1)}}))
eq("…a stale claim is re-taken and finished", run(ops.approve_sale(sale3["id"], "Resume.", OWNER))["status"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("3. M-6 — accruals are keyed on the window; overlaps are refused")

WEEK_SINCE = datetime(2026, 9, 28, tzinfo=timezone.utc)   # ISO week 40 of 2026
WEEK_UNTIL = WEEK_SINCE + timedelta(days=7)
HOSTS = {"h1": 10_000, "h2": 5_000}


async def _compute(agency_id, period, since=None, until=None, partner=None):
    start, end, label = commission_svc.resolve_period(period, since, until)
    weights = list(HOSTS.values())
    total = 150_000   # ₹1,500 for the agency, whatever the label says
    shares = commission_svc.apportion(total, weights)
    return {
        "agency_id": agency_id, "agency_name": "Stars Agency", "agency_kind": "agency", "period": label,
        "since": start, "until": end,
        "billing": {"billing_minor": 1_500_000, "beans_cashed_out": 15_000, "host_count": 2, "definition": "x"},
        "slab_table": {"source": "test", "provisional": False},
        "breakdown": {"band": "B1", "rate_percent": "10", "floor_minor": 0, "rule": "r", "rounding": "r", "explanation": "e"},
        "commission_minor": total,
        "hosts": [{"host_id": h, "beans_cashed_out": b, "share_minor": s, "share_note": ""} for (h, b), s in zip(HOSTS.items(), shares)],
        "warnings": [], "provisional": PROVISIONAL["on"],
    }


PROVISIONAL = {"on": False}
commission_svc.compute_for_period = _compute  # type: ignore[assignment]

first = run(ops.accrue_commission("AG", "2026-W40", FIN, reason="Week 40 accrual."))
eq("week 40 accrues both hosts", (first["credited_minor"], len(first["accrued"])), (150_000, 2))
window = ops.commission_window_label(WEEK_SINCE, WEEK_UNTIL)
eq("…keyed on the WINDOW", sorted(ledger_keys("commission:AG:")), sorted([f"commission:AG:h1:{window}", f"commission:AG:h2:{window}"]))
eq("…and the window is on the record", first["window"], window)
m = refuses("the same week under an explicit since/until with a new label is already accrued",
            ops.accrue_commission("AG", "settlement-batch-7", FIN, since=WEEK_SINCE, until=WEEK_UNTIL, reason="Batch."))
ok("…saying so", "already accrued" in m, m)
m = refuses("a month that overlaps the accrued week is refused", ops.accrue_commission("AG", "2026-10", FIN, reason="October."))
ok("…naming the clash", "overlaps" in m and "2026-W40" in m, m)
m = refuses("a shifted explicit range that overlaps is refused",
            ops.accrue_commission("AG", "custom", FIN, since=WEEK_SINCE + timedelta(days=3), until=WEEK_UNTIL + timedelta(days=3), reason="Shifted."))
ok("…naming the clash", "overlaps" in m, m)
eq("nothing was credited by any of those", run(get_balance(HolderType.AGENCY, "AG", Currency.COMMISSION)), 150_000)
nxt = run(ops.accrue_commission("AG", "2026-W41", FIN, reason="Week 41."))
eq("the next week accrues normally", nxt["credited_minor"], 150_000)
# A legacy accrual (label key, as before M-6) is recognised as done.
DB[C.LEDGER].docs.append({"_id": "legacy", "holder_type": "agency", "holder_id": "AG", "currency": "commission",
                          "amount": 100_000, "action": "commission.accrue", "idempotency_key": "commission:AG:h1:2026-W42",
                          "at": datetime.now(timezone.utc), "meta": {"host_id": "h1", "period": "2026-W42"}})
legacy = run(ops.accrue_commission("AG", "2026-W42", FIN, reason="Week 42."))
eq("a host accrued under the legacy label key is skipped, the other accrued", ([a["host_id"] for a in legacy["already_accrued"]], [a["host_id"] for a in legacy["accrued"]]), (["h1"], ["h2"]))

# ══════════════════════════════════════════════════════════════════════════════
print("4. B-22 — a provisional slab table is refused on the human path too")

PROVISIONAL["on"] = True
m = refuses("a provisional figure is not accrued by a person either", ops.accrue_commission("AG", "2026-W43", FIN, reason="Week 43."))
ok("…saying to confirm the configuration", "provisional" in m and "appConfig/economy" in m, m)
eq("…and nothing moved (W40 + W41 + h2 of W42)", run(get_balance(HolderType.AGENCY, "AG", Currency.COMMISSION)), 350_000)
PROVISIONAL["on"] = False

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} executor checks passed.")
