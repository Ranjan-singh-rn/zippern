"""Manual recharge through a Coin Seller: filed, verified, credited once, and
reversed only as far as the diamonds are still there.

── WHAT THIS PINS SHUT ─────────────────────────────────────────────────────

  * filing moves nothing, validates the seller, refuses a reused reference;
  * approval debits the seller's coins and credits the buyer's diamonds
    through the REAL ledger (`money.apply_movement`) with deterministic
    idempotency keys — a second approval moves nothing;
  * a seller without coins cannot be approved; the request stays pending;
  * rejection moves nothing and tells both parties with the reason;
  * a refund takes back exactly what is still in the live wallet, records the
    rest as spent, restores the seller's coins by the same amount, and never
    makes a balance negative; replaying the decision moves nothing;
  * every step is audited and mirrored, and nobody is banned by a refund.

REAL: `services/recharges`, `services/money.apply_movement`,
      `db/firebase.clawback_user_diamonds`.
FAKE: Mongo (`tests/harness.FakeDb`, which enforces the ledger's unique
      `idempotency_key`), Firestore (`tests/fakes.FakeFirestore`, with
      `Increment` applied as arithmetic).

    python3 -m tests.test_recharges
"""

from __future__ import annotations

import asyncio
import logging
import sys
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
from app.services import recharges as rc  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
audit_entries: list[dict] = []


async def fake_audit(**kw):
    audit_entries.append(kw)
    return f"audit-{len(audit_entries)}"


audit_mod.record = fake_audit
rc.audit.record = fake_audit
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refuses(claim: str, coro) -> str:
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


def bal(holder_type, holder_id, currency) -> int:
    return run(get_balance(holder_type, holder_id, currency))


def rec(rid: str) -> dict:
    return next(d for d in DB[C.RECHARGES].docs if d["_id"] == rid)


def notices_for(uid: str) -> list[str]:
    return sorted(d["type"] for d in fs.collection("notifications").docs.values() if d.get("userId") == uid)


def diamonds(uid: str) -> int:
    return int(fs.collection("users").docs[uid].get("diamonds", 0))


# ── The world ───────────────────────────────────────────────────────────────
DB[C.PARTNERS].docs.append({"_id": "SELL", "kind": "seller", "name": "Coins R Us",
                            "status": "approved", "is_active": True, "owner_crm_uid": "u-seller",
                            "total_coins_sold": 0})
DB[C.PARTNERS].docs.append({"_id": "SUSP", "kind": "seller", "name": "Suspended Shop",
                            "status": "suspended", "is_active": False, "owner_crm_uid": "u-s2"})
DB[C.PARTNERS].docs.append({"_id": "AGCY", "kind": "agency", "name": "An Agency",
                            "status": "approved", "is_active": True, "owner_crm_uid": "u-ag"})
# The seller holds 1,000 coins (loaded earlier through a signed card).
DB[C.BALANCES].docs.append({"holder_type": "seller", "holder_id": "SELL", "currency": "coins", "amount": 1000})
fs.collection("users").docs["u-buyer"] = {"name": "Buyer", "diamonds": 0}
fs.collection("sellers").docs["SELL"] = {"displayName": "Coins R Us", "coinBalance": 1000}


def file(**over) -> dict:
    kw = dict(buyer_uid="u-buyer", seller_id="SELL", diamonds=300, amount_minor=30000,
              currency="INR", payment_method="upi", reference="UTR-001",
              proof_url="https://x/proof.jpg", actor=APP)
    kw.update(over)
    return run(rc.submit_recharge(kw.pop("buyer_uid"), kw.pop("seller_id"), **kw))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Filing moves nothing")

r = file()
R = r["id"]
eq("pending", rec(R)["status"], "pending")
eq("buyer has no diamonds yet", diamonds("u-buyer"), 0)
eq("seller still holds every coin", bal(HolderType.SELLER, "SELL", Currency.COINS), 1000)
eq("the buyer is told it is being verified", notices_for("u-buyer"), ["recharge_submitted"])
eq("…and so is the seller", notices_for("u-seller"), ["recharge_submitted"])
ok("mirrored to rechargeRequests with the legacy shape",
   fs.collection("rechargeRequests").docs[R]["diamondPackage"] == 300
   and fs.collection("rechargeRequests").docs[R]["verifiedByStaff"] is False)
ok("audited", any(e["action"] == "recharge.requested" for e in audit_entries))

m = refuses("the same reference for the same seller is refused", rc.submit_recharge(
    "u-other", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="UTR-001", proof_url="", actor=APP))
ok("…naming the earlier request", R in m)
m = refuses("a suspended seller is refused", rc.submit_recharge(
    "u-buyer", "SUSP", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="X1", proof_url="", actor=APP))
m = refuses("an agency is not a seller", rc.submit_recharge(
    "u-buyer", "AGCY", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="X2", proof_url="", actor=APP))
m = refuses("no reference and no proof is refused", rc.submit_recharge(
    "u-buyer", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="", proof_url="", actor=APP))
m = refuses("a seller cannot recharge themselves", rc.submit_recharge(
    "u-seller", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="X3", proof_url="", actor=APP))
m = refuses("zero diamonds refused", rc.submit_recharge(
    "u-buyer", "SELL", diamonds=0, amount_minor=1000, currency="INR", payment_method="upi",
    reference="X4", proof_url="", actor=APP))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Approval credits exactly once")

a = run(rc.approve_recharge(R, "UTR verified against the seller's statement.", OWNER))
eq("approved", rec(R)["status"], "approved")
eq("buyer credited", diamonds("u-buyer"), 300)
eq("seller debited in the ledger", bal(HolderType.SELLER, "SELL", Currency.COINS), 700)
eq("buyer credited in the ledger", bal(HolderType.USER, "u-buyer", Currency.DIAMONDS), 300)
eq("credited_diamonds recorded", rec(R)["credited_diamonds"], 300)
ok("approved_by and approved_at recorded", rec(R)["approved_by"]["uid"] == "owner-1" and rec(R)["approved_at"])
ok("the app's history row exists with a deterministic id",
   f"recharge_{R}" in fs.collection("users").document("u-buyer").collection("diamondTransactions").docs)
ok("the mirror says the ledger credited it",
   fs.collection("rechargeRequests").docs[R]["creditedByLedger"] is True)
ok("seller lifetime sold incremented",
   next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELL")["total_coins_sold"] == 300)
eq("both told", (notices_for("u-buyer").count("recharge_approved"), notices_for("u-seller").count("recharge_approved")), (1, 1))
keys = sorted(d["idempotency_key"] for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(f"recharge:{R}:"))
eq("two ledger rows with the recharge's keys", keys, [f"recharge:{R}:coins", f"recharge:{R}:diamonds"])

m = refuses("approving twice is refused", rc.approve_recharge(R, "again", OWNER))
eq("…and nothing moved", diamonds("u-buyer"), 300)
eq("…ledger unchanged", bal(HolderType.SELLER, "SELL", Currency.COINS), 700)
eq("…still two rows", len([d for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(f"recharge:{R}:")]), 2)

# Even if the CAS were bypassed, the ledger keys hold: replay the movements directly.
from app.services.money import DuplicateMovement, Movement, apply_movement  # noqa: E402
try:
    run(apply_movement(Movement(holder_type=HolderType.USER, holder_id="u-buyer", currency=Currency.DIAMONDS,
                                amount=300, action="balance.credit", reason="replay", actor=OWNER,
                                idempotency_key=f"recharge:{R}:diamonds")))
    ok("a replayed credit with the same key is refused by the ledger", False)
except DuplicateMovement:
    ok("a replayed credit with the same key is refused by the ledger", True)
eq("…balance unchanged by the replay", diamonds("u-buyer"), 300)

# Concurrent approvals.
r2 = file(reference="UTR-002", diamonds=100, amount_minor=10000); R2 = r2["id"]
async def _race():
    return await asyncio.gather(rc.approve_recharge(R2, "Verified.", OWNER), rc.approve_recharge(R2, "Verified.", OWNER),
                                return_exceptions=True)
res = run(_race())
eq("two concurrent approvals → one success", len([x for x in res if isinstance(x, dict)]), 1)
eq("…and exactly 100 more diamonds", diamonds("u-buyer"), 400)

# ══════════════════════════════════════════════════════════════════════════════
print("3. Seller shortfall and rejection")

r3 = file(reference="UTR-003", diamonds=5000, amount_minor=500000); R3 = r3["id"]
m = refuses("a seller short of coins cannot be approved", rc.approve_recharge(R3, "Verified.", OWNER))
ok("…the message names the shortfall", "holds" in m and "needs" in m)
eq("…the request stays pending", rec(R3)["status"], "pending")
eq("…buyer unchanged", diamonds("u-buyer"), 400)
ok("…shortfall recorded on the request", "shortfall" in rec(R3))

rej = run(rc.reject_recharge(R3, "Screenshot does not match any credit on our statement.", OWNER))
eq("rejected", rec(R3)["status"], "rejected")
eq("nothing moved", bal(HolderType.SELLER, "SELL", Currency.COINS), 600)
ok("buyer told with the reason", any("Screenshot" in d["body"] for d in fs.collection("notifications").docs.values()
                                     if d.get("userId") == "u-buyer" and d["type"] == "recharge_rejected"))
m = refuses("rejecting again is refused", rc.reject_recharge(R3, "again", OWNER))
m = refuses("approving a rejected one is refused", rc.approve_recharge(R3, "again", OWNER))

# ══════════════════════════════════════════════════════════════════════════════
print("4. Refund — full, when nothing was spent")

m = refuses("a refund cannot be requested on a pending recharge", rc.request_refund(R3, "again", OWNER))
req = run(rc.request_refund(R2, "Buyer paid twice by mistake.", OWNER))
eq("refund_pending", rec(R2)["status"], "refund_pending")
eq("nothing moved yet", diamonds("u-buyer"), 400)
m = refuses("approving during refund review is refused", rc.approve_recharge(R2, "again", OWNER))
dec = run(rc.decide_refund(R2, True, "Duplicate payment confirmed.", OWNER))
eq("refunded in full", rec(R2)["status"], "refunded")
eq("100 taken back", dec["taken"], 100)
eq("nothing unrecoverable", dec["unrecoverable"], 0)
eq("buyer back to 300", diamonds("u-buyer"), 300)
eq("seller coins restored by 100", bal(HolderType.SELLER, "SELL", Currency.COINS), 700)
eq("refunded_diamonds recorded", rec(R2)["refunded_diamonds"], 100)
ok("a debit history row for the app", f"recharge_{R2}_reversal_1" in
   fs.collection("users").document("u-buyer").collection("diamondTransactions").docs)
ok("buyer told", "recharge_refunded" in notices_for("u-buyer"))
m = refuses("deciding the refund again is refused", rc.decide_refund(R2, True, "again", OWNER))
eq("…and nothing moved on the replay", diamonds("u-buyer"), 300)
eq("…ledger unchanged on the replay", bal(HolderType.SELLER, "SELL", Currency.COINS), 700)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Refund — partial, when some was spent")

# The buyer spends 250 of their 300 in the app (gifts, calls — Mongo never sees it).
fs.collection("users").docs["u-buyer"]["diamonds"] = 50
run(rc.request_refund(R, "Chargeback from the bank.", OWNER))
dec = run(rc.decide_refund(R, True, "Bank reversed the payment.", OWNER))
eq("status is REVERSED, not refunded", rec(R)["status"], "reversed")
eq("only the 50 still there were taken", dec["taken"], 50)
eq("250 recorded as unrecoverable (spent)", dec["unrecoverable"], 250)
eq("the live balance is exactly zero — never negative", diamonds("u-buyer"), 0)
eq("seller coins restored by exactly 50", bal(HolderType.SELLER, "SELL", Currency.COINS), 750)
eq("the record carries both figures", (rec(R)["refunded_diamonds"], rec(R)["unrecoverable_diamonds"]), (50, 250))
ok("the history entry records credited/available/taken/unrecoverable",
   rec(R)["history"][-1]["available_before"] == 50 and rec(R)["history"][-1]["outstanding"] == 300)
ok("buyer told it was partly reversed", "recharge_reversed" in notices_for("u-buyer"))
ok("the user was NOT banned or suspended by the refund",
   not fs.collection("users").docs["u-buyer"].get("isBanned") and not fs.collection("users").docs["u-buyer"].get("isSuspended"))
ok("audited with the unrecoverable figure",
   any(e["action"] == "recharge.refunded" and e["after"]["unrecoverable"] == 250 for e in audit_entries))

# Refusing a refund.
r4 = file(reference="UTR-004", diamonds=20, amount_minor=2000); R4 = r4["id"]
run(rc.approve_recharge(R4, "Verified.", OWNER))
run(rc.request_refund(R4, "Buyer asked.", OWNER))
run(rc.decide_refund(R4, False, "Service was delivered; no grounds.", OWNER))
eq("a refused refund returns to approved", rec(R4)["status"], "approved")
eq("…and moved nothing", diamonds("u-buyer"), 20)
ok("buyer told", "recharge_refund_rejected" in notices_for("u-buyer"))

# ══════════════════════════════════════════════════════════════════════════════
print("6. The audit trail reads in order")

trail = [e["action"] for e in audit_entries if e["subject_id"] == R]
eq("one recharge, four events, in order", trail,
   ["recharge.requested", "recharge.approved", "recharge.refund_requested", "recharge.refunded"])
ok("every recharge audit row names the buyer", all(e["meta"].get("buyer_uid") for e in audit_entries if e["subject_type"] == "recharge"))
seen = run(rc.list_recharges(None, 100))
ok("the queue lists them newest first", [d["id"] for d in seen][0] == R4)
ok("filtering by status works", all(d["status"] == "rejected" for d in run(rc.list_recharges("rejected", 100))))

# ══════════════════════════════════════════════════════════════════════════════
print("7. A notice that cannot be written never undoes a credit")

r9 = file(reference="UTR-009", diamonds=10, amount_minor=1000); R9 = r9["id"]
before = diamonds("u-buyer")
fs.collection("notifications").fail_on("set")
try:
    out = run(rc.approve_recharge(R9, "Verified.", OWNER))
    eq("credited despite the notice failing", diamonds("u-buyer"), before + 10)
    eq("…status approved", rec(R9)["status"], "approved")
    eq("…and both notices reported undelivered", out["notified"], {"buyer": False, "seller": False})
finally:
    fs.collection("notifications").clear_failures()

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} recharge checks passed.")
print("  · filing moves nothing; duplicate references and bad sellers refused")
print("  · approval credits once through the real ledger; replays and races move nothing")
print("  · shortfall keeps the request pending; rejection notifies with the reason")
print("  · refund takes back only what is still there, records the rest as spent,")
print("    never goes negative, restores the seller, and bans nobody\n")
