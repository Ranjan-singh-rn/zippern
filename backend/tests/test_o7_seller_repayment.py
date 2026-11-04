"""O7 — a seller pays back borrowed coins, from the app and the CRM seller portal (Owner, 5 Nov 2026).

  "if a seller borrowed some coin from us, for that coin he needs to pay — and that payment is not integrated in
   the app and the CRM, which is the biggest gap."

What is pinned:

  1. A seller files a repayment for their OWN borrowed coins — a payment to Zipper (amount + reference) or unsold
     coins handed back — through `POST /partner-ops/sellers/{seller_id}/repayment-requests`, answered through the
     partner view. Nothing moves on filing.
  2. Refused: another seller's record (403), nothing owed, more than is owed, a payment with no reference or no
     amount, returning more coins than the inventory holds, an unknown method.
  3. One Owner's approval is final: a payment lowers the debt (no coin moves); a return takes the coins out of the
     inventory and lowers the debt by the same amount. The seller sees their card on their board.
  4. Filed by an Owner on the seller's behalf, it is done in the same request (O6).

REAL: `routers/partner_ops`, `services/partner_ops`, `services/cards`, `services/money`, `core/deps`.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), SendGrid.

    python3 -m tests.test_o7_seller_repayment
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, HTTPException, install_stubs  # noqa: E402

install_stubs()

PROVIDER = FakeSendGrid()
PROVIDER.install()
PROVIDER.next_status = 202

import app.db.mongo as mongo  # noqa: E402
from app.config import settings  # noqa: E402

settings.sendgrid_api_key = "SG.test-key-never-appears-in-output.0000"
settings.mail_from = "no-reply@zipperlive.org"

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

from app.core import deps  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.routers import partner_ops as ops_router  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services.money import Currency, HolderType, Movement, apply_movement, get_balance  # noqa: E402

logging.disable(logging.CRITICAL)
run = asyncio.run
checks = 0
failures: list[str] = []


def ok(claim: str, cond, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refused(claim: str, coro, *, status: int | None = None, says: str = "") -> str:
    global checks
    checks += 1
    try:
        run(coro)
    except HTTPException as exc:
        detail = str(getattr(exc, "detail", exc))
        if status is not None and getattr(exc, "status_code", None) != status:
            failures.append(f"{claim}: status {getattr(exc, 'status_code', None)}, want {status} ({detail})")
        elif says and says not in detail:
            failures.append(f"{claim}: said {detail!r}, want it to say {says!r}")
        return detail
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

OWNER = {"uid": "u-owner", "name": "Owner One", "role": Role.OWNER, "team": None, "partner_ids": {}}
OWNER_B = {"uid": "u-owner-b", "name": "Owner Two", "role": Role.OWNER, "team": None, "partner_ids": {}}
FIN = {"uid": "u-fin", "name": "Anil", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE, "partner_ids": {}}
SELLER = {"uid": "u-s1", "name": "Coins R Us", "role": Role.SELLER, "partner_ids": {"seller": "S1"}}
OTHER = {"uid": "u-s2", "name": "Other Seller", "role": Role.SELLER, "partner_ids": {"seller": "S2"}}
DB.seed(C.STAFF, [
    {"uid": "u-owner", "email": "owner@zipper.test", "name": "Owner One", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-b", "email": "owner-b@zipper.test", "name": "Owner Two", "role": str(Role.OWNER), "is_active": True},
])


def seller(pid: str, owner_uid: str) -> dict:
    return {"_id": pid, "kind": "seller", "name": pid, "status": "approved", "is_active": True,
            "owner_crm_uid": owner_uid, "total_coins_sold": 0, "credit": {"outstanding": 0, "history": []}}


DB.seed(C.PARTNERS, [seller("S1", "u-s1"), seller("S2", "u-s2"), seller("S3", "u-s3")])
for sid in ("S1", "S2", "S3"):
    fs.collection("sellers").docs[sid] = {"coinBalance": 0, "totalCoinsSold": 0}


class _Body:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def coins(sid: str) -> int:
    return run(get_balance(HolderType.SELLER, sid, Currency.COINS))


def owed(sid: str) -> int:
    row = next(d for d in DB[C.PARTNERS].docs if d["_id"] == sid)
    return int((row.get("credit") or {}).get("outstanding") or 0)


def card_doc(card_id: str) -> dict:
    return next(d for d in DB[C.CARDS].docs if str(d["_id"]) == card_id)


def repay(sid: str, user: dict, **kw):
    body = {"coins": 100, "method": "payment", "amount_paid_minor": 0, "payment_ref": "", "reason": "Paying back."}
    body.update(kw)
    return ops_router.request_seller_repayment(sid, _Body(**body), user=user)


# A loan of 5,000 coins to S1, approved by an Owner — the debt this file pays back.
due = datetime.now(timezone.utc) + timedelta(days=14)
loan = run(ops_router.request_lending("S1", _Body(coins=5_000, due_at=due, terms="Two weeks.",
                                                  reason="Festival stock on credit."), user=OWNER))
eq("the loan is lent", (loan["stage"], coins("S1"), owed("S1")), ("executed", 5_000, 5_000))

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The seller files a repayment for their own borrowed coins; nothing moves on filing")

ok("the route is partner-reachable",
   ("POST", "/api/partner-ops/sellers/{seller_id}/repayment-requests") in deps.PARTNER_REACHABLE)
paid = run(repay("me", SELLER, coins=2_000, amount_paid_minor=4_000_00, payment_ref="UTR-REPAY-1",
                 reason="Paid back by bank transfer."))
eq("a payment request is a repayment card", paid["type"], "lending_repay")
eq("…waiting for Zipper", paid["stage"], "requested")
eq("…saying what was paid", (paid["payload"]["coins"], paid["payload"]["amount_paid_minor"],
                             paid["payload"]["payment_ref"], paid["payload"]["method"]),
   (2_000, 4_000_00, "UTR-REPAY-1", "payment"))
eq("…and that the seller filed it", card_doc(paid["id"])["payload"]["requested_by_partner"], True)
ok("…answered through the partner view (no staff names)", (paid.get("requested_by") or {}).get("name") in ("", "Zipper", None)
   or paid["requested_by"].get("uid") == "u-s1", str(paid.get("requested_by")))
eq("…and nothing moved", (coins("S1"), owed("S1")), (5_000, 5_000))
mine = {c["id"] for c in run(cards_svc.board_for(SELLER))}
ok("the seller sees it on their own board", paid["id"] in mine)
ok("…another seller does not", paid["id"] not in {c["id"] for c in run(cards_svc.board_for(OTHER))})

back = run(repay("S1", SELLER, coins=1_000, method="return_coins", reason="Returning unsold coins."))
eq("a return is a recovery card with no penalty", (back["type"], back["payload"]["penalty_coins"],
                                                  back["payload"]["method"]), ("lending_recover", 0, "return_coins"))
eq("…nothing moved yet", (coins("S1"), owed("S1")), (5_000, 5_000))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Refusals")

refused("another seller's record", repay("S1", OTHER, coins=10, payment_ref="X", amount_paid_minor=100), status=403)
refused("nothing owed", repay("me", OTHER, coins=10, payment_ref="X", amount_paid_minor=100), says="no borrowed coins")
refused("more than is owed", repay("me", SELLER, coins=9_999, payment_ref="X", amount_paid_minor=100),
        says="more than the 5,000 owed")
refused("a payment with no reference", repay("me", SELLER, coins=10, amount_paid_minor=100), says="payment reference")
refused("a payment with no amount", repay("me", SELLER, coins=10, payment_ref="UTR-0"), says="amount paid")
refused("a return when nothing is owed",
        repay("me", {**SELLER, "uid": "u-s3", "partner_ids": {"seller": "S3"}}, coins=1, method="return_coins"),
        says="no borrowed coins")
refused("an unknown method", repay("me", SELLER, coins=10, method="barter"), says="Choose how")

# ══════════════════════════════════════════════════════════════════════════════
print("3. One Owner's approval is final")

done = run(cards_svc.owner_fast_path(paid["id"], OWNER_B, verification_note="Bank line matches UTR-REPAY-1.",
                                     execute=True))
eq("the payment is approved and carried out", done["stage"], "executed")
eq("…the debt went down by the coins paid for", owed("S1"), 3_000)
eq("…and no coin moved", coins("S1"), 5_000)
done2 = run(cards_svc.owner_fast_path(back["id"], OWNER_B, verification_note="Seller returned unsold stock.",
                                      execute=True))
eq("the return is approved and carried out", done2["stage"], "executed")
eq("…the coins left the inventory", coins("S1"), 4_000)
eq("…and the debt went down by the same", owed("S1"), 2_000)

# Return more than held is refused once the inventory is short.
run(apply_movement(Movement(holder_type=HolderType.SELLER, holder_id="S1", currency=Currency.COINS, amount=-3_900,
                            action="inventory.debit", reason="Sold to users", actor=OWNER,
                            idempotency_key="test:sold:S1")))
refused("returning more than the inventory holds", repay("me", SELLER, coins=500, method="return_coins"),
        says="Only 100 coins")

# ══════════════════════════════════════════════════════════════════════════════
print("4. Filed by an Owner on the seller's behalf, it is done at once")

staff = run(repay("S1", OWNER, coins=500, amount_paid_minor=1_000_00, payment_ref="UTR-REPAY-OWNER",
                  reason="Seller paid at the office."))
eq("an Owner's filing is executed in the same request", staff["stage"], "executed")
eq("…the debt went down", owed("S1"), 1_500)
fin = run(repay("S1", FIN, coins=500, amount_paid_minor=1_000_00, payment_ref="UTR-REPAY-FIN",
                reason="Seller paid by UPI."))
eq("Finance's filing waits for an Owner", fin["stage"], "requested")
eq("…and the debt is unchanged", owed("S1"), 1_500)

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} seller-repayment checks passed.")
