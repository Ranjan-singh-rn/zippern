"""B1 — M-1 replica drift: detected, alerted, repaired, never double-applied;
and the app-visible rows every CRM movement now leaves (M-15, M-17, M-18).

  1. A Firestore sync that fails marks the balance `replica_stale` with the
     delta owed; the ledger is committed either way (money is not lost).
  2. The `replica_drift` detector finds it once it is older than the
     configured minutes; a fresh one waits for the sweep's repair first.
  3. `repair_replica_drift` replays the pending deltas ONCE, keyed on the
     ledger id: the live balance ends consistent with the ledger, the history
     row is written, the marker is written, and a second repair (or a sync
     that had in fact landed before its answer was lost) applies nothing.
  4. A repair that fails leaves the row stale, audited, still alerting; the
     sweep carries it in its own vocabulary.
  5. M-15: an agency commission sync writes `commissionBalance` (paise, as an
     Increment), `commissionBalanceInr` (rupees, absolute) and the unit.
  6. M-17: a host withdrawal leaves a `beanTransactions/card_{id}` row.
  7. M-18: an admin balance credit leaves a `diamondTransactions/card_{id}`
     row; a sale credit leaves `sale_{id}`.

REAL: `services/money`, `db/firebase` (sync, replay, debit), `services/alerts`
      detectors, `services/scheduling` sweep, `services/users` balance card.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`).

    python3 -m tests.test_m_replica_drift
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs  # noqa: E402

install_stubs()
PROVIDER = FakeSendGrid()
PROVIDER.install()

import app.db.mongo as mongo  # noqa: E402
from app.config import settings  # noqa: E402

settings.sendgrid_api_key = "SG.test-key-never-appears-in-output.0000"

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

from app.core import audit as audit_mod  # noqa: E402
from app.services import alerts, money, scheduling  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import users as users_svc  # noqa: E402
from app.services.cards import CardType, NewCard  # noqa: E402
from app.services.money import Currency, DuplicateMovement, HolderType, Movement, apply_movement  # noqa: E402

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


_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

OWNER = {"uid": "u-owner", "name": "Owner", "role": Role.OWNER, "team": None, "partner_ids": {}}
DB.seed(C.STAFF, [
    {"uid": "u-owner", "email": "owner@zipper.test", "name": "Owner", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-fin", "email": "fin@zipper.test", "name": "Fin", "role": str(Role.FINANCE_ADMIN), "is_active": True},
])


def users_doc(uid: str) -> dict:
    return fs.collection("users").docs.get(uid) or {}


def history(uid: str, kind: str = "diamondTransactions") -> dict:
    return fs.collection("users").document(uid).collection(kind).docs


def balance_row(holder_type: str, holder_id: str, currency: str) -> dict:
    return next(d for d in DB[C.BALANCES].docs
                if d["holder_type"] == holder_type and d["holder_id"] == holder_id and d["currency"] == currency)


def credit(uid: str, amount: int, key: str, history_id: str | None = None):
    return run(apply_movement(Movement(
        holder_type=HolderType.USER, holder_id=uid, currency=Currency.DIAMONDS, amount=amount,
        action="balance.credit", reason="Recharge verified.", actor=OWNER, idempotency_key=key,
        history={"id": history_id, "reason": "Recharge via seller", "rechargeRequestId": key.split(":")[1]} if history_id else None,
    )))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. A failed sync is recorded with the delta owed; the ledger stands")

fs.collection("users").docs["buyer-1"] = {"name": "Buyer", "diamonds": 50}
fs.collection("users").fail_on("set", "buyer-1")   # Firestore refuses the balance write
r1 = credit("buyer-1", 1_000, "recharge:R1:diamonds", "recharge_R1")
eq("the ledger row is committed", len([d for d in DB[C.LEDGER].docs if d.get("idempotency_key") == "recharge:R1:diamonds"]), 1)
eq("…and the Mongo balance moved", run(money.get_balance(HolderType.USER, "buyer-1", Currency.DIAMONDS)), 1_000)
eq("…but the sync reports failure", r1.replica_synced, False)
eq("the live balance did not move", users_doc("buyer-1")["diamonds"], 50)
row = balance_row("user", "buyer-1", "diamonds")
eq("the balance row is stale, with the exact delta still owed",
   (row["replica_stale"], [p["delta"] for p in row["replica_pending"]]), (True, [1_000]))
eq("…keyed on the ledger id", row["replica_pending"][0]["ledger_id"], r1.ledger_id)
ok("…carrying the history row to write", row["replica_pending"][0]["history"]["id"] == "recharge_R1")
# A second movement while Firestore is still down queues behind it.
r2 = credit("buyer-1", 500, "recharge:R2:diamonds", "recharge_R2")
eq("a second failed sync queues a second delta", [p["delta"] for p in balance_row("user", "buyer-1", "diamonds")["replica_pending"]], [1_000, 500])
eq("the drift list names the row", [d["holder_id"] for d in run(money.find_replica_drift())], ["buyer-1"])

# ══════════════════════════════════════════════════════════════════════════════
print("2. The detector: fresh drift waits for the sweep, old drift alerts")

eq("a just-failed sync is not alerted yet (the sweep repairs first)", run(alerts._find_replica_drift()), [])
run(DB[C.BALANCES].update_one({"holder_id": "buyer-1"}, {"$set": {
    "replica_stale_at": datetime.now(timezone.utc) - timedelta(minutes=settings.alert_replica_stale_minutes + 1)}}))
found = run(alerts._find_replica_drift())
eq("an old one is found", [f.key for f in found], ["replica_drift:user:buyer-1:diamonds"])
ok("…naming what is owed", "+1,500" in found[0].headline, found[0].headline)
eq("…with a fingerprint that changes as the gap changes", found[0].fingerprint.split(":")[:2], ["2", "1500"])
ok("the detector is on the scheduled scan", "replica_drift" in alerts.DETECTORS_BY_ID)
scan = run(alerts.scan(["replica_drift"]))
eq("the scan raises it once", scan["fired"], 1)
eq("…to Finance and the Owners", sorted(PROVIDER.sent[-1]["to"] for _ in [0]) and sorted({s["to"] for s in PROVIDER.sent}), ["fin@zipper.test", "owner@zipper.test"])
eq("…and a second scan is suppressed", run(alerts.scan(["replica_drift"]))["fired"], 0)

# ══════════════════════════════════════════════════════════════════════════════
print("3. The repair replays each delta once and the replica ends consistent")

fs.collection("users").clear_failures()
summary = run(money.repair_replica_drift(actor=OWNER))
eq("one row repaired", (summary["rows"], summary["repaired"], summary["failed"]), (1, 1, 0))
eq("…two deltas replayed", summary["replayed"], 2)
eq("the live balance is now ledger-consistent (50 + 1000 + 500)", users_doc("buyer-1")["diamonds"], 1_550)
eq("…the history rows were written", sorted(history("buyer-1")), ["recharge_R1", "recharge_R2"])
eq("…with the amounts", (history("buyer-1")["recharge_R1"]["amount"], history("buyer-1")["recharge_R1"]["type"]), (1_000, "credit"))
markers = fs.collection("users").document("buyer-1").collection(firebase_mod.REPLICA_SYNCS).docs
eq("…and a marker per ledger id", sorted(markers), sorted([r1.ledger_id, r2.ledger_id]))
row = balance_row("user", "buyer-1", "diamonds")
eq("the balance row is clean", (row["replica_stale"], row["replica_pending"]), (False, []))
eq("…and keeps the history of what was repaired", [p["outcome"] for p in row["replica_repaired"]], ["replayed", "replayed"])
ok("…audited", any(d["action"] == "replica.repaired" and d["subject"]["id"] == "buyer-1" for d in DB[C.AUDIT].docs))
eq("a second repair has nothing to do", run(money.repair_replica_drift())["rows"], 0)
eq("…and moved nothing", users_doc("buyer-1")["diamonds"], 1_550)
eq("the detector is quiet", run(alerts._find_replica_drift()), [])

# A sync that LANDED but whose answer was lost: the marker says so, the repair applies nothing.
fs.collection("users").docs["buyer-2"] = {"name": "Buyer Two", "diamonds": 0}
real_sync = firebase_mod.sync_balance_to_firestore


def _landed_then_lost(*a, **k):
    real_sync(*a, **k)   # the write lands…
    return False         # …and the answer is lost


firebase_mod.sync_balance_to_firestore = _landed_then_lost
r3 = credit("buyer-2", 300, "recharge:R3:diamonds", "recharge_R3")
firebase_mod.sync_balance_to_firestore = real_sync
eq("the write landed", users_doc("buyer-2")["diamonds"], 300)
eq("…and the row is stale all the same", balance_row("user", "buyer-2", "diamonds")["replica_stale"], True)
summary = run(money.repair_replica_drift())
eq("the repair finds the marker and applies nothing", (summary["replayed"], summary["already_applied"]), (0, 1))
eq("…so the balance is still 300, not 600", users_doc("buyer-2")["diamonds"], 300)
eq("…and the row is clean", balance_row("user", "buyer-2", "diamonds")["replica_stale"], False)

# Concurrent: a new sync fails while the repair runs — the repair re-reads, loses nothing.
fs.collection("users").docs["buyer-3"] = {"name": "Buyer Three", "diamonds": 0}
fs.collection("users").fail_on("set", "buyer-3")
credit("buyer-3", 10, "recharge:R4:diamonds")
fs.collection("users").clear_failures()
real_update = DB[C.BALANCES].update_one
raced = {"done": False}


async def _update_with_race(query, update, **kw):
    if not raced["done"] and "replica_pending" in query and query.get("holder_id") == "buyer-3":
        raced["done"] = True
        # A sync fails and pushes while the repair holds its stale read.
        await real_update({"holder_type": "user", "holder_id": "buyer-3", "currency": "diamonds"}, {
            "$set": {"replica_stale": True},
            "$push": {"replica_pending": {"delta": 7, "idempotency_key": "recharge:R5:diamonds",
                                          "ledger_id": "ledger-late", "at": datetime.now(timezone.utc)}},
        })
    return await real_update(query, update, **kw)


DB[C.BALANCES].update_one = _update_with_race
summary = run(money.repair_replica_drift())
DB[C.BALANCES].update_one = real_update
eq("the repair that raced a new failure finished both deltas", (summary["repaired"], summary["replayed"]), (1, 2))
eq("…and the live balance holds both", users_doc("buyer-3")["diamonds"], 17)
eq("…with nothing pending", balance_row("user", "buyer-3", "diamonds")["replica_pending"], [])

# ══════════════════════════════════════════════════════════════════════════════
print("4. A repair that fails stays visible; the sweep reports it")

fs.collection("users").docs["buyer-4"] = {"name": "Buyer Four", "diamonds": 0}
fs.collection("users").fail_on("set", "buyer-4")
credit("buyer-4", 42, "recharge:R6:diamonds")
summary = run(money.repair_replica_drift())
eq("Firestore still down: the row is not repaired", (summary["repaired"], summary["failed"]), (0, 1))
row = balance_row("user", "buyer-4", "diamonds")
eq("…it stays stale with the delta pending", (row["replica_stale"], [p["delta"] for p in row["replica_pending"]]), (True, [42]))
ok("…and the error is on the row", "503" in str(row.get("replica_repair_last_error")), row.get("replica_repair_last_error"))
ok("…and audited", any(d["action"] == "replica.repair_failed" and d["subject"]["id"] == "buyer-4" for d in DB[C.AUDIT].docs))
sweep_rows = run(scheduling._sweep_replica_repair())
eq("the sweep reports the failure in its own vocabulary", [r["outcome"] for r in sweep_rows], ["failed"])
ok("the sweep is registered", any(name == "replica_drift_repair" for name, _s, _f in scheduling.SWEEPS))
fs.collection("users").clear_failures()
eq("…and succeeds once Firestore is back", [r["outcome"] for r in run(scheduling._sweep_replica_repair())], ["sent"])
eq("…leaving the balance right", users_doc("buyer-4")["diamonds"], 42)

# ══════════════════════════════════════════════════════════════════════════════
print("5. M-15 — the agency commission mirror states its unit and its rupees")

run(apply_movement(Movement(holder_type=HolderType.AGENCY, holder_id="AG-1", currency=Currency.COMMISSION,
                            amount=125_000, action="commission.accrue", reason="Week 40.", actor=OWNER,
                            idempotency_key="commission:AG-1:h1:w40")))
ag = fs.collection("agencies").docs["AG-1"]
eq("commissionBalance is incremented in paise", ag["commissionBalance"], 125_000)
eq("…the unit is stated", ag["commissionBalanceUnit"], "paise")
eq("…and the rupee mirror is written for the CRM", ag["commissionBalanceInr"], 1_250.0)
run(apply_movement(Movement(holder_type=HolderType.AGENCY, holder_id="AG-1", currency=Currency.COMMISSION,
                            amount=-25_000, action="commission.pay", reason="Paid.", actor=OWNER,
                            idempotency_key="card:x:commission")))
ag = fs.collection("agencies").docs["AG-1"]
eq("a payout moves both", (ag["commissionBalance"], ag["commissionBalanceInr"]), (100_000, 1_000.0))

# ══════════════════════════════════════════════════════════════════════════════
print("6. M-17 — a host withdrawal leaves the app-visible bean row")

fs.collection("users").docs["host-1"] = {"name": "Host", "beans": 5_000, "beansAvailable": 4_000, "agencyId": "AG-1",
                                         "isVerifiedHost": True}
wcard = run(cards_svc.raise_card(NewCard(
    type=CardType.HOST_WITHDRAWAL, team=Team.FINANCE, title="Host withdrawal — 1,000 beans", amount=1_000,
    currency="beans", reason="Weekly payout.", subject_type="user", subject_id="host-1",
    payload={"beans": 1_000, "host_id": "host-1", "agency_id": "AG-1"}), OWNER))
run(cards_svc.verify(wcard["id"], OWNER, "Checked."))
run(cards_svc.sign(wcard["id"], OWNER, "Approved."))
done = run(ops.execute_host_withdrawal(wcard["id"], "UTR-W-1", OWNER))
eq("the withdrawal executed", done["stage"], "executed")
eq("…the wallet moved once", (users_doc("host-1")["beans"], users_doc("host-1")["beansAvailable"]), (4_000, 3_000))
brow = history("host-1", "beanTransactions").get(f"card_{wcard['id']}")
ok("the beanTransactions row exists under the card id", brow is not None)
eq("…saying what happened", (brow["type"], brow["amount"], brow["paymentRef"], brow["context"]), ("debit", 1_000, "UTR-W-1", "withdrawal"))
eq("…with the balance after", brow["balanceAfter"], 4_000)

# ══════════════════════════════════════════════════════════════════════════════
print("7. M-18 — admin credits and sale credits explain themselves in the history")

fs.collection("users").docs["u-credit"] = {"name": "Credited", "diamonds": 10}
bcard = run(users_svc.request_balance_change("u-credit", Currency.DIAMONDS, 250, "Goodwill after an outage.", OWNER,
                                             enforce_target_policy=False))
run(cards_svc.verify(bcard["id"], OWNER, "Checked."))
run(cards_svc.sign(bcard["id"], OWNER, "Approved."))
run(users_svc.execute_balance_card(bcard["id"], OWNER))
eq("the credit landed", users_doc("u-credit")["diamonds"], 260)
crow = history("u-credit").get(f"card_{bcard['id']}")
ok("…and the diamondTransactions row names the card", crow is not None and crow["cardId"] == bcard["id"])
eq("…as a credit of the amount", (crow["type"], crow["amount"], crow["context"]), ("credit", 250, "admin_credit"))
# A replayed execution does not write a second row or a second credit.
try:
    run(users_svc.execute_balance_card(bcard["id"], OWNER))
except Exception:  # noqa: BLE001 — "already executed"
    pass
eq("…and a replay changes nothing", (users_doc("u-credit")["diamonds"], len(history("u-credit"))), (260, 1))

# A sale credit.
DB.seed(C.PARTNERS, [{"_id": "SELL-9", "kind": "seller", "name": "Nine", "status": "approved", "is_active": True,
                      "owner_crm_uid": "u-seller-9"}])
DB.seed(C.BALANCES, [{"holder_type": "seller", "holder_id": "SELL-9", "currency": "coins", "amount": 5_000}])
fs.collection("sellers").docs["SELL-9"] = {"coinBalance": 5_000}
fs.collection("users").docs["u-buyer-9"] = {"name": "Buyer Nine", "diamonds": 0}
DB["partner_sales"]._next_id = _card_id  # type: ignore[assignment]
sale = run(ops.record_sale("SELL-9", "u-buyer-9", 400, 100_000, OWNER, "Sold four hundred diamonds for cash."))
approved = run(ops.approve_sale(sale["id"], "Buyer confirmed receipt.", OWNER))
eq("the sale credited the buyer", users_doc("u-buyer-9")["diamonds"], 400)
srow = history("u-buyer-9").get(f"sale_{sale['id']}")
ok("…with a diamondTransactions row under the sale id", srow is not None)
eq("…saying it was a sale", (srow["type"], srow["amount"], srow["context"], srow["saleId"]), ("credit", 400, "sale", sale["id"]))

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} replica-drift checks passed.")
