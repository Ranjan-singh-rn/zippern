"""B1 + B2 — the recharge reference index and refund idempotency.

B1: a proof-only recharge (no payment reference) must never collide with
    another proof-only recharge to the same seller; a real reference stays
    unique per seller, including under a race. The index migration replaces
    only the legacy sparse index and is idempotent.

B2: one logical refund debits the buyer at most once — across a normal run,
    a retry after success, a retry after a crash between the debit and the
    bookkeeping, a process that died holding the claim, and two staff clicking
    at once. Partial, zero and over-large refunds never go negative, and there
    is exactly one ledger effect and one notification.

    python3 -m tests.test_recharge_money
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

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import recharges as rc  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]


async def fake_audit(**kw):
    return "audit"


audit_mod.record = fake_audit
rc.audit.record = fake_audit
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []


def ok(claim, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim} {detail}")


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refuses(claim, coro) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run
OWNER = {"uid": "owner-1", "name": "Owner", "role": "superadmin", "team": None}
APP = {"uid": "system:partner-registration", "name": "app", "role": "system", "team": None}


def rec(rid):
    return next(d for d in DB[C.RECHARGES].docs if d["_id"] == rid)


def diamonds(uid):
    return int(fs.collection("users").docs[uid].get("diamonds", 0))


def coins():
    return run(get_balance(HolderType.SELLER, "SELL", Currency.COINS))


def ledger_for_refund(rid):
    return [d for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(f"recharge:{rid}:refund")]


def notices(uid, type_):
    return [d for d in fs.collection("notifications").docs.values()
            if d.get("userId") == uid and d.get("type") == type_]


DB[C.PARTNERS].docs.append({"_id": "SELL", "kind": "seller", "name": "Coins R Us", "status": "approved",
                            "is_active": True, "owner_crm_uid": "u-seller", "total_coins_sold": 0})
DB[C.BALANCES].docs.append({"holder_type": "seller", "holder_id": "SELL", "currency": "coins", "amount": 100000})
fs.collection("sellers").docs["SELL"] = {"displayName": "Coins R Us", "coinBalance": 100000}


def file(buyer="u-buyer", reference="", diamonds_=100):
    fs.collection("users").docs.setdefault(buyer, {"name": buyer, "diamonds": 0})
    return run(rc.submit_recharge(buyer, "SELL", diamonds=diamonds_, amount_minor=diamonds_ * 100,
                                  currency="INR", payment_method="upi", reference=reference,
                                  proof_url="https://x/proof.jpg", actor=APP))


# ══════════════════════════════════════════════════════════════════════════════
print("\nB1. The (seller_id, reference) index")

# Migration from the legacy sparse index, over existing records.
DB.seed(C.RECHARGES, [
    {"_id": "old-1", "seller_id": "SELL", "reference": "UTR-OLD", "status": "approved"},
    {"_id": "old-2", "seller_id": "SELL", "status": "approved"},
])
run(DB[C.RECHARGES].create_index([("seller_id", 1), ("reference", 1)], unique=True, sparse=True))
run(DB[C.RECHARGES].create_index([("status", 1), ("created_at", -1)]))
# Prove the legacy index IS the bug: a second reference-less doc collides.
try:
    run(DB[C.RECHARGES].insert_one({"_id": "probe", "seller_id": "SELL", "status": "pending"}))
    legacy_collides = False
except Exception:  # noqa: BLE001
    legacy_collides = True
ok("the legacy sparse compound index refuses a second reference-less request (the bug)", legacy_collides)

eq("migration replaces the legacy index", run(mongo.ensure_recharge_reference_index(DB)), "replaced")
eq("…and is idempotent", run(mongo.ensure_recharge_reference_index(DB)), "present")
info = run(DB[C.RECHARGES].index_information())
ok("the new index is partial + unique",
   info[mongo.RECHARGE_REFERENCE_INDEX].get("unique") is True
   and info[mongo.RECHARGE_REFERENCE_INDEX].get("partialFilterExpression") == {"reference": {"$gt": ""}})
ok("the unrelated status index survived", "status_1_created_at_-1" in info)
ok("no other index on the same key pattern remains",
   sum(1 for v in info.values() if v.get("key") == [("seller_id", 1), ("reference", 1)]) == 1)
eq("existing records untouched", sorted(d["_id"] for d in DB[C.RECHARGES].docs), ["old-1", "old-2"])

a = file(reference="")
b = file(reference="")
ok("1. first recharge with no reference succeeds", rec(a["id"])["status"] == "pending")
ok("2. second recharge with no reference succeeds", rec(b["id"])["status"] == "pending")
ok("…neither stored a reference key", "reference" not in rec(a["id"]) and "reference" not in rec(b["id"]))
file(reference="UTR-1")
m = refuses("3. the same real reference twice is refused", rc.submit_recharge(
    "u-buyer", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="UTR-1", proof_url="", actor=APP))
ok("…saying why", "already been submitted" in m)
c1 = file(reference="UTR-2")
c2 = file(reference="UTR-3")
ok("4. different real references both succeed", rec(c1["id"]) and rec(c2["id"]))
refuses("an old record's reference is still protected", rc.submit_recharge(
    "u-buyer", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="UTR-OLD", proof_url="", actor=APP))


async def _race():
    return await asyncio.gather(*[
        rc.submit_recharge("u-buyer", "SELL", diamonds=10, amount_minor=1000, currency="INR",
                           payment_method="upi", reference="UTR-RACE", proof_url="", actor=APP)
        for _ in range(3)
    ], return_exceptions=True)

res = run(_race())
eq("5. concurrent same reference → exactly one accepted", sum(1 for r in res if isinstance(r, dict)), 1)
ok("…the others refused as duplicates, not crashed",
   all(isinstance(r, PartnerOpsError) for r in res if not isinstance(r, dict)))
eq("…one record holds it", sum(1 for d in DB[C.RECHARGES].docs if d.get("reference") == "UTR-RACE"), 1)

# Insert failures that are NOT duplicates are no longer reported as duplicates.
real_insert = DB[C.RECHARGES].insert_one
async def _boom(*a, **k):
    raise RuntimeError("network down")
DB[C.RECHARGES].insert_one = _boom
global_checks_before = checks
try:
    file(reference="UTR-NET")
    raised = None
except Exception as exc:  # noqa: BLE001
    raised = exc
DB[C.RECHARGES].insert_one = real_insert
ok("a non-duplicate insert failure is raised as itself, not as 'already submitted'",
   isinstance(raised, RuntimeError))

# ══════════════════════════════════════════════════════════════════════════════
print("B2. One logical refund, at most one debit")


def approved_recharge(buyer, d=100, start=0):
    fs.collection("users").docs[buyer] = {"name": buyer, "diamonds": start}
    r = file(buyer=buyer, diamonds_=d)
    run(rc.approve_recharge(r["id"], "Paid.", OWNER))
    return r["id"]


def open_refund(rid):
    run(rc.request_refund(rid, "Chargeback.", OWNER))


# 1. Normal refund
R = approved_recharge("b-normal", 100)
eq("credited", diamonds("b-normal"), 100)
open_refund(R)
eq("the refund cycle is fixed when the refund opens", rec(R)["refund_cycle"], 1)
coins_before = coins()
out = run(rc.decide_refund(R, True, "Confirmed.", OWNER))
eq("1. normal refund → refunded", rec(R)["status"], "refunded")
eq("…buyer back to zero", diamonds("b-normal"), 0)
eq("…seller restored by exactly that", coins() - coins_before, 100)
eq("9. exactly one ledger effect per side", len(ledger_for_refund(R)), 2)
eq("10. exactly one refund notification to the buyer", len(notices("b-normal", "recharge_refunded")), 1)

# 2. Retry after success
refuses("2. retry after a successful refund is refused", rc.decide_refund(R, True, "Again.", OWNER))
eq("…nothing moved twice", diamonds("b-normal"), 0)
eq("…still one ledger effect per side", len(ledger_for_refund(R)), 2)

# 3. Retry after the debit but before the bookkeeping completed
R3 = approved_recharge("b-crash", 100)
open_refund(R3)
real_apply = rc.apply_movement
calls = {"n": 0}
async def _crash_after_debit(m):
    calls["n"] += 1
    raise RuntimeError("process died after the Firestore debit")
rc.apply_movement = _crash_after_debit
try:
    run(rc.decide_refund(R3, True, "Confirmed.", OWNER))
except RuntimeError:
    pass
rc.apply_movement = real_apply
eq("the debit happened once", diamonds("b-crash"), 0)
eq("…and the request went back to refund_pending for a retry", rec(R3)["status"], "refund_pending")
out = run(rc.decide_refund(R3, True, "Retry.", OWNER))
eq("3. retry after debit does NOT debit again", diamonds("b-crash"), 0)
eq("…the retry recorded what was taken the first time", out["taken"], 100)
eq("…final status refunded", rec(R3)["status"], "refunded")
eq("…exactly one ledger effect per side", len(ledger_for_refund(R3)), 2)
eq("…one app-visible debit row",
   len([k for k in fs.collection("users").document("b-crash").collection("diamondTransactions").docs
        if k.startswith(f"recharge_{R3}_reversal")]), 1)
eq("…exactly one refund notification", len(notices("b-crash", "recharge_refunded")), 1)

# A process that died HOLDING the claim (status stuck at 'refunding')
R4 = approved_recharge("b-dead", 100)
open_refund(R4)
real_apply = rc.apply_movement
rc.apply_movement = _crash_after_debit
real_update = DB[C.RECHARGES].update_one
async def _lost_revert(q, u, **k):  # the revert never ran: the process was gone
    if q.get("status") == "refunding":
        return None
    return await real_update(q, u, **k)
DB[C.RECHARGES].update_one = _lost_revert
try:
    run(rc.decide_refund(R4, True, "Confirmed.", OWNER))
except RuntimeError:
    pass
rc.apply_movement = real_apply
DB[C.RECHARGES].update_one = real_update
eq("stuck at refunding", rec(R4)["status"], "refunding")
refuses("a live claim is not re-taken", rc.decide_refund(R4, True, "Retry.", OWNER))
rec(R4)["claimed_at"] = datetime.now(timezone.utc) - timedelta(minutes=30)
out = run(rc.decide_refund(R4, True, "Resume.", OWNER))
eq("a stale claim is resumed and finishes", rec(R4)["status"], "refunded")
eq("…without a second debit", diamonds("b-dead"), 0)
eq("…one ledger effect per side", len(ledger_for_refund(R4)), 2)

# 4. Concurrent refunds
R5 = approved_recharge("b-race", 100)
open_refund(R5)
async def _two():
    return await asyncio.gather(rc.decide_refund(R5, True, "Staff A decides.", OWNER),
                                rc.decide_refund(R5, True, "Staff B decides.", OWNER), return_exceptions=True)
res = run(_two())
eq("4. concurrent refunds → one succeeds", sum(1 for r in res if isinstance(r, dict)), 1)
eq("…buyer debited once", diamonds("b-race"), 0)
eq("…one ledger effect per side", len(ledger_for_refund(R5)), 2)

# 5. Partial buyer balance (spent 60 of 100)
R6 = approved_recharge("b-partial", 100)
fs.collection("users").docs["b-partial"]["diamonds"] = 40
open_refund(R6)
out = run(rc.decide_refund(R6, True, "Confirmed.", OWNER))
eq("5. partial: takes what is there", out["taken"], 40)
eq("…records the rest as unrecoverable", out["unrecoverable"], 60)
eq("…status reversed", rec(R6)["status"], "reversed")
eq("8. no negative balance", diamonds("b-partial"), 0)

# 6. Zero buyer balance
R7 = approved_recharge("b-zero", 100)
fs.collection("users").docs["b-zero"]["diamonds"] = 0
open_refund(R7)
out = run(rc.decide_refund(R7, True, "Confirmed.", OWNER))
eq("6. zero balance: nothing taken", out["taken"], 0)
eq("…reversed with everything unrecoverable", (rec(R7)["status"], out["unrecoverable"]), ("reversed", 100))
eq("…no ledger effect", len(ledger_for_refund(R7)), 0)
eq("…still not negative", diamonds("b-zero"), 0)

# 7. Refund larger than the buyer's balance cannot overdraw
R8 = approved_recharge("b-big", 500)
fs.collection("users").docs["b-big"]["diamonds"] = 120
open_refund(R8)
out = run(rc.decide_refund(R8, True, "Confirmed.", OWNER))
eq("7. larger than balance → capped at the balance", (out["taken"], diamonds("b-big")), (120, 0))

# Approval resume + duplicate approval (§7 money check)
fs.collection("users").docs["b-ap"] = {"name": "b-ap", "diamonds": 0}
RA = file(buyer="b-ap", diamonds_=50)["id"]
async def _two_approvals():
    return await asyncio.gather(rc.approve_recharge(RA, "Staff A verified.", OWNER), rc.approve_recharge(RA, "Staff B verified.", OWNER),
                                return_exceptions=True)
res = run(_two_approvals())
eq("concurrent approval → one credit", (sum(1 for r in res if isinstance(r, dict)), diamonds("b-ap")), (1, 50))
refuses("duplicate approval refused", rc.approve_recharge(RA, "Third click here.", OWNER))
eq("…still credited once", diamonds("b-ap"), 50)

# replica_stale is now recorded when the live balance could not be moved
real_sync = firebase_mod.sync_balance_to_firestore
firebase_mod.sync_balance_to_firestore = lambda *a, **k: False
fs.collection("users").docs["b-stale"] = {"name": "b-stale", "diamonds": 0}
RS = file(buyer="b-stale", diamonds_=30)["id"]
run(rc.approve_recharge(RS, "Paid.", OWNER))
firebase_mod.sync_balance_to_firestore = real_sync
drift = run(money_mod.find_replica_drift())
row = next((d for d in drift if d.get("holder_id") == "b-stale"), None)
ok("a failed live-balance sync marks the balance replica_stale", row is not None)
ok("…with the exact delta still owed", row and row["replica_pending"][0]["delta"] == 30)

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} recharge-money checks passed.")
