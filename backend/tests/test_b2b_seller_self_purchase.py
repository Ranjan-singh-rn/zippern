"""B2b (3 Nov 2026) — a Coin Seller never buys diamonds from their own stock.

The owner reported it as an existing bug: a seller could buy from their own seller account. Filing such a request
was already refused (`submit_recharge` compared the buyer with the seller's owner uid); what was NOT closed:

  * a seller record keyed by its owner's uid (the legacy `sellers/{uid}` shape) — the owner-uid field can be empty
    on those, so the comparison let the seller through;
  * APPROVAL — a request filed before the check existed, written straight into Firestore by an old app, or a seller
    whose owner was changed after filing, was approved like any other and moved the seller's inventory into the
    seller's own wallet;
  * and the app listed the seller's own listing among the resellers to pay (fixed in `ResellerListScreen`).

Pinned here, through the REAL `services/recharges` and the ledger (`money.apply_movement`), over the in-memory
Mongo and Firestore:

  * filing is refused for the owner uid AND for a seller record keyed by the buyer's uid;
  * approval is refused for a self request already in the queue — nothing moves, it stays pending, and the
    refusal says to reject it;
  * approval is refused when the seller's owner became the buyer after filing;
  * a sale recorded by staff is refused for the seller's own account (by record id and by owner uid);
  * an ordinary request is still approved and credited exactly once.

    python3 -m tests.test_b2b_seller_self_purchase
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
from app.services import partner_ops as po  # noqa: E402
from app.services import recharges as rc  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]


async def fake_audit(**kw):
    return "audit-x"


audit_mod.record = fake_audit
rc.audit.record = fake_audit
po.audit.record = fake_audit
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []
run = asyncio.run
OWNER = {"uid": "owner-1", "name": "Owner", "role": "superadmin", "team": None}
APP = {"uid": "system:partner-registration", "name": "app", "role": "system", "team": None}


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
        run(coro)
    except PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


def coins(seller_id: str) -> int:
    return run(get_balance(HolderType.SELLER, seller_id, Currency.COINS))


def diamonds(uid: str) -> int:
    return int(fs.collection("users").docs.get(uid, {}).get("diamonds", 0))


def rec(rid: str) -> dict:
    return next(d for d in DB[C.RECHARGES].docs if d["_id"] == rid)


# ── The world ───────────────────────────────────────────────────────────────
# SELL: an ordinary seller owned by u-seller. LEGACY: a seller record keyed by its owner's uid, owner field empty.
DB[C.PARTNERS].docs.append({"_id": "SELL", "kind": "seller", "name": "Coins R Us", "status": "approved",
                            "is_active": True, "owner_crm_uid": "u-seller", "total_coins_sold": 0})
DB[C.PARTNERS].docs.append({"_id": "u-legacy", "kind": "seller", "name": "Old Shop", "status": "approved",
                            "is_active": True, "owner_crm_uid": "", "total_coins_sold": 0})
for sid in ("SELL", "u-legacy"):
    DB[C.BALANCES].docs.append({"holder_type": "seller", "holder_id": sid, "currency": "coins", "amount": 1000})
for uid in ("u-buyer", "u-seller", "u-legacy", "u-later"):
    fs.collection("users").docs[uid] = {"name": uid, "diamonds": 0}
fs.collection("sellers").docs["SELL"] = {"displayName": "Coins R Us", "coinBalance": 1000}


def file(buyer: str, seller: str, ref: str) -> dict:
    return run(rc.submit_recharge(buyer, seller, diamonds=100, amount_minor=10000, currency="INR",
                                  payment_method="upi", reference=ref, proof_url="https://x/p.jpg", actor=APP))


def queue_directly(rid: str, buyer: str, seller: str, owner: str) -> None:
    """A request already in the queue, as an old app or a pre-check filing left it."""
    now = datetime.now(timezone.utc)
    DB[C.RECHARGES].docs.append({
        "_id": rid, "buyer_uid": buyer, "seller_id": seller, "seller_owner_uid": owner, "seller_name": seller,
        "diamonds": 100, "amount_minor": 10000, "currency": "INR", "payment_method": "upi",
        "status": "pending", "credited_diamonds": 0, "refunded_diamonds": 0, "unrecoverable_diamonds": 0,
        "created_at": now, "updated_at": now, "history": [],
    })
    fs.collection("rechargeRequests").docs[rid] = {"status": "pending", "buyerUid": buyer}


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Filing")
refuses("the seller's own account (owner uid) is refused", rc.submit_recharge(
    "u-seller", "SELL", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="F1", proof_url="", actor=APP))
m = refuses("a seller record keyed by the buyer's own uid is refused (owner field empty)", rc.submit_recharge(
    "u-legacy", "u-legacy", diamonds=10, amount_minor=1000, currency="INR", payment_method="upi",
    reference="F2", proof_url="", actor=APP))
ok("…saying why", "own account" in m, m)
eq("nothing filed for either", [d["_id"] for d in DB[C.RECHARGES].docs], [])

# ══════════════════════════════════════════════════════════════════════════════
print("2. Approval of a self request already in the queue")
queue_directly("R-SELF", "u-seller", "SELL", "u-seller")
m = refuses("approving it is refused", rc.approve_recharge("R-SELF", "Payment seen.", OWNER))
ok("…telling staff to reject it", "own stock" in m and "Reject" in m, m)
eq("the seller still holds every coin", coins("SELL"), 1000)
eq("the seller's own wallet got nothing", diamonds("u-seller"), 0)
eq("the request is still pending", rec("R-SELF")["status"], "pending")

queue_directly("R-LEGACY", "u-legacy", "u-legacy", "")
refuses("a legacy uid-keyed seller approving its own request is refused", rc.approve_recharge(
    "R-LEGACY", "Payment seen.", OWNER))
eq("…and its coins are untouched", coins("u-legacy"), 1000)

# ══════════════════════════════════════════════════════════════════════════════
print("3. The seller's owner became the buyer after filing")
r = file("u-later", "SELL", "F3")
next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELL")["owner_crm_uid"] = "u-later"
refuses("approving it now is refused", rc.approve_recharge(r["id"], "Payment seen.", OWNER))
eq("nothing moved", (coins("SELL"), diamonds("u-later")), (1000, 0))
next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELL")["owner_crm_uid"] = "u-seller"

# ══════════════════════════════════════════════════════════════════════════════
print("4. A sale recorded by staff")
refuses("to the seller's own record id", po.record_sale("SELL", "SELL", 50, 5000, OWNER))
refuses("to the seller's owner account", po.record_sale("SELL", "u-seller", 50, 5000, OWNER))

# ══════════════════════════════════════════════════════════════════════════════
print("5. An ordinary request still goes through, once")
r = file("u-buyer", "SELL", "F4")
run(rc.approve_recharge(r["id"], "Payment seen.", OWNER))
eq("the buyer got the diamonds", diamonds("u-buyer"), 100)
eq("the seller's coins went down by exactly that", coins("SELL"), 900)
refuses("a second approval moves nothing", rc.approve_recharge(r["id"], "Again.", OWNER))
eq("…still 100", diamonds("u-buyer"), 100)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} seller self-purchase checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} seller self-purchase checks passed.")
