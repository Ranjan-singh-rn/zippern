"""O6 — the Owner's signature is final (Owner decision, 5 Nov 2026).

  "one owner, if it is doing something, let it be done; the other owners just get to know … if owner signs
   something, that will be a final decision … when owner signs for the coin balance to be transferred, coins will
   be directly automatically added — no extra clicking."

What is pinned:

  1. An Owner's signature on a coin / diamond card executes it in the same request — a seller's coin purchase, a
     loan to a seller, a user's balance credit. Every stage still writes its own audit entry, in order; the other
     Owners are told of the signature AND of the execution; a replayed execution moves nothing twice.
  2. A payout is NOT executed by the signature: its execution records a bank transfer a person makes first.
  3. An execution the signature runs and that is refused (the seller's money is frozen) leaves the signature
     standing, moves nothing and says why on the response; the fast path does not run it a second time.
  4. A card an Owner RAISES from a staff screen is done in the same request (review → verify → sign → execute,
     each audited) — a loan, a repayment, a coin purchase, a balance credit. Anyone else's card waits for an
     Owner; a partner's own card is never touched; the card that pays an Owner still needs another Owner.
  5. Bulk signing executes each coin card it signs.
  6. The flag switched off restores the two-step board exactly.

REAL: `services/cards`, `services/partner_ops`, `services/users`, `services/money`, `services/money_freeze`,
      `services/owner_mail`, `routers/partner_ops`, `routers/users`, `routers/cards`, `core/audit`.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), SendGrid, the published wholesale rate.

    python3 -m tests.test_o6_owner_sign_final
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

from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.routers import cards as cards_router  # noqa: E402
from app.routers import partner_ops as ops_router  # noqa: E402
from app.routers import users as users_router  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import money_freeze  # noqa: E402
from app.services import owner_mail  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402  (registers the coin executors)
from app.services import reports as reports_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402  (registers the balance executors)
from app.services.cards import CardType, NewCard  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

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


def refuses(claim: str, coro, *, kind=Exception) -> str:
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


def internal(uid: str, role: Role, team=None, name: str = "") -> dict:
    return {"uid": uid, "name": name or uid, "role": role, "team": team, "partner_ids": {}}


OWNER_A = internal("u-owner-a", Role.OWNER, name="Owner One")
OWNER_B = internal("u-owner-b", Role.OWNER, name="Owner Two")
FIN_ADMIN = internal("u-fin-admin", Role.FINANCE_ADMIN, Team.FINANCE, "Anil (Finance admin)")
FIN_MEMBER = internal("u-fin-member", Role.FINANCE_MEMBER, Team.FINANCE, "Sara (Finance)")
SELLER_1 = {"uid": "u-seller-1", "name": "Coins R Us", "role": Role.SELLER, "partner_ids": {"seller": "SELL-1"}}

DB.seed(C.STAFF, [
    {"uid": "u-owner-a", "email": "owner-a@zipper.test", "name": "Owner One", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-b", "email": "owner-b@zipper.test", "name": "Owner Two", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-c", "email": "owner-c@zipper.test", "name": "Owner Three", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-fin-admin", "email": "fin@zipper.test", "name": "Anil", "role": str(Role.FINANCE_ADMIN), "is_active": True},
])


def seller(pid: str, owner_uid: str, **extra) -> dict:
    return {"_id": pid, "kind": "seller", "name": pid, "status": "approved", "is_active": True,
            "owner_crm_uid": owner_uid, "total_coins_sold": 0, "credit": {"outstanding": 0, "history": []}, **extra}


DB.seed(C.PARTNERS, [
    seller("SELL-1", "u-seller-1"), seller("SELL-2", "u-seller-2"), seller("SELL-F", "u-seller-f"),
    {"_id": "AG-1", "kind": "agency", "name": "Stars Agency", "status": "approved", "is_active": True,
     "owner_crm_uid": "u-agency-1"},
])
for sid in ("SELL-1", "SELL-2", "SELL-F"):
    fs.collection("sellers").docs[sid] = {"coinBalance": 0, "totalCoinsSold": 0}
fs.collection("users").docs["u-credit"] = {"name": "Credited", "diamonds": 10}
fs.collection("users").docs["u-credit-2"] = {"name": "Credited Two", "diamonds": 0}
fs.collection("users").docs["u-owner-a"] = {"name": "Owner One (app account)", "diamonds": 0}


class _Rates:
    seller_wholesale_price_inr_per_lakh = 2_000.0
    diamond_pack_price_inr_per_lakh = 2_390.0
    provisional = False
    seller_tiers: dict = {}


async def _rates():
    return _Rates()


reports_svc.load_rates = _rates  # type: ignore[assignment]


class _Body:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def coins(sid: str) -> int:
    return run(get_balance(HolderType.SELLER, sid, Currency.COINS))


def card_doc(card_id: str) -> dict:
    return next(d for d in DB[C.CARDS].docs if str(d["_id"]) == card_id)


def card_actions(card_id: str) -> list[str]:
    return [d["action"] for d in DB[C.AUDIT].docs
            if (d.get("subject") or {}).get("id") == card_id and str(d["action"]).startswith("card.")]


def notice_keys(card_id: str) -> set[str]:
    return {k for k in fs.collection("notifications").docs if f":{card_id}:" in k}


def outstanding(sid: str) -> int:
    row = next(d for d in DB[C.PARTNERS].docs if d["_id"] == sid)
    return int((row.get("credit") or {}).get("outstanding") or 0)


def purchase_by_finance(sid: str, n: int, ref: str) -> str:
    """A coin purchase raised by Finance and verified by the Finance admin — waiting for an Owner."""
    card = run(ops.request_coin_purchase(sid, n, n * 2, ref, "", FIN_MEMBER, "Seller paid; bank advice attached."))
    run(cards_svc.verify(card["id"], FIN_ADMIN, "Bank line matches the UTR and the amount."))
    eq(f"[{ref}] Finance's card waits for an Owner", card_doc(card["id"])["stage"], "awaiting_signoff")
    return card["id"]


ok("the decision is on by default", cards_svc.AUTO_EXECUTE_ON_OWNER_SIGN is True)
ok("…and an Owner completes the cards they raise", cards_svc.OWNER_COMPLETES_OWN_CARDS is True)
eq("the types the signature executes are the coin and diamond movements, never a payout",
   cards_svc.AUTO_EXECUTE_TYPES,
   frozenset({"seller_coin_purchase", "lending_issue", "lending_repay", "lending_recover", "bad_debt_write_off",
              "balance_credit", "balance_debit"}))
ok("…every one of them has an executor to run",
   all(t in cards_svc.EXECUTORS for t in cards_svc.AUTO_EXECUTE_TYPES), str(sorted(cards_svc.EXECUTORS)))

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The Owner's signature moves the coins — no second click")

cid = purchase_by_finance("SELL-1", 10_000, "UTR-O6-1")
signed = run(cards_svc.sign(cid, OWNER_A, "Approved."))
eq("one signature, and the card is executed", signed["stage"], "executed")
eq("…the response says the signature executed it", signed.get("auto_executed"), True)
eq("…the coins are in the seller's inventory", coins("SELL-1"), 10_000)
eq("…and the app's mirror shows them", fs.collection("sellers").docs["SELL-1"]["coinBalance"], 10_000)
eq("every stage wrote its own audit entry, in order",
   card_actions(cid), ["card.raised", "card.review_started", "card.verified", "card.signed", "card.executed"])
eq("…signed and executed by the same Owner",
   {(d.get("actor") or {}).get("uid") for d in DB[C.AUDIT].docs
    if (d.get("subject") or {}).get("id") == cid and d["action"] in ("card.signed", "card.executed")},
   {"u-owner-a"})
eq("the card records who signed it", card_doc(cid)["signed_by"]["uid"], "u-owner-a")
eq("the other two Owners heard of the signature AND of the execution",
   notice_keys(cid),
   {f"owner_money:{cid}:card_signed:u-owner-b", f"owner_money:{cid}:card_signed:u-owner-c",
    f"owner_money:{cid}:card_executed:u-owner-b", f"owner_money:{cid}:card_executed:u-owner-c"})
ok("…the signer was not told about their own signature",
   not any(k.endswith(":u-owner-a") for k in notice_keys(cid)))
eq("the signature's notice is on the response", (signed.get("owner_notice") or {}).get("status"), "sent")
m = refuses("the old execute step now finds it executed", ops.execute_coin_purchase(cid, OWNER_A), kind=PartnerOpsError)
ok("…saying so", "already been executed" in m, m)
eq("…and the coins landed once", coins("SELL-1"), 10_000)

# A loan: the coins AND the debt, both, on the signature.
due = datetime.now(timezone.utc) + timedelta(days=14)
loan = run(ops.request_lending("SELL-2", 4_000, due, "Repay in two weeks.", "Seller asked for stock on credit.", FIN_MEMBER))
run(cards_svc.verify(loan["id"], FIN_ADMIN, "Within the seller's limit; terms agreed."))
signed_loan = run(cards_svc.sign(loan["id"], OWNER_B, "Approved."))
eq("a loan is executed by the signature", signed_loan["stage"], "executed")
eq("…the coins are lent", coins("SELL-2"), 4_000)
eq("…and the debt is recorded with them", outstanding("SELL-2"), 4_000)

# A user's balance credit (diamonds) — the replica moves too.
bcard = run(users_svc.request_balance_change("u-credit", Currency.DIAMONDS, 250, "Goodwill after an outage.",
                                             FIN_ADMIN, enforce_target_policy=False))
run(cards_svc.verify(bcard["id"], OWNER_B, "Outage confirmed; amount per policy."))
signed_b = run(cards_svc.sign(bcard["id"], OWNER_A, "Approved."))
eq("a balance credit is executed by the signature", signed_b["stage"], "executed")
eq("…the user's diamonds moved in the app", fs.collection("users").docs["u-credit"]["diamonds"], 260)
eq("…and in the ledger", run(get_balance(HolderType.USER, "u-credit", Currency.DIAMONDS)), 250)
m = refuses("the separate balance Execute now finds it executed", users_svc.execute_balance_card(bcard["id"], OWNER_A))
ok("…saying so", "executed" in m, m)
eq("…and nothing moved twice", fs.collection("users").docs["u-credit"]["diamonds"], 260)

# ══════════════════════════════════════════════════════════════════════════════
print("2. A payout is signed, not executed — the bank transfer is a person's step")

payout = run(cards_svc.raise_card(NewCard(
    type=CardType.COMMISSION_PAYOUT, team=Team.FINANCE, title="Commission payout — Stars Agency", amount=150_000,
    currency="commission", reason="Week 44 commission.", subject_type="agency", subject_id="AG-1",
    payload={"agency_id": "AG-1"}), FIN_MEMBER))
run(cards_svc.verify(payout["id"], FIN_ADMIN, "Accrual matches the statement."))
signed_p = run(cards_svc.sign(payout["id"], OWNER_A, "Approved."))
eq("a payout stops at approved", signed_p["stage"], "approved")
ok("…with no execution attempted", "auto_executed" not in signed_p, str(signed_p.get("auto_executed")))
eq("…and its audit trail ends at the signature", card_actions(payout["id"])[-1], "card.signed")

# ══════════════════════════════════════════════════════════════════════════════
print("3. An execution the signature runs and that is refused: the signature stands, nothing moves")

fid = purchase_by_finance("SELL-F", 2_000, "UTR-O6-FROZEN")
run(money_freeze.freeze_partner("SELL-F", cause="test_hold", label="a review hold",
                                reason="Owner review of this seller's payments.", actor=OWNER_B))
signed_f = run(cards_svc.sign(fid, OWNER_A, "Approved."))
ok("the signature stands", signed_f["stage"] in ("approved", "failed"), signed_f["stage"])
eq("…the response says the execution did not run", signed_f.get("auto_executed"), False)
ok("…and why", "frozen" in str(signed_f.get("auto_execute_error", "")).lower(), str(signed_f.get("auto_execute_error")))
eq("…no coins moved", coins("SELL-F"), 0)
ok("…the signature is in the audit", "card.signed" in card_actions(fid))
ok("…and no execution is", "card.executed" not in card_actions(fid))

# The fast path on a frozen seller: signature runs the execution once; the fast path does not run it again.
fid2 = purchase_by_finance("SELL-F", 1_000, "UTR-O6-FROZEN-2")
calls = {"n": 0}
real_exec = cards_svc.EXECUTORS["seller_coin_purchase"]


async def _counting(card_id, actor, *, payment_ref=""):
    calls["n"] += 1
    return await real_exec(card_id, actor, payment_ref=payment_ref)


cards_svc.EXECUTORS["seller_coin_purchase"] = _counting
fp = run(cards_svc.owner_fast_path(fid2, OWNER_B, verification_note="Checked again.", execute=True))
cards_svc.EXECUTORS["seller_coin_purchase"] = real_exec
eq("the refused execution ran once, not twice", calls["n"], 1)
eq("…the fast path reports it", (fp.get("auto_executed"), "frozen" in str(fp.get("auto_execute_error", "")).lower()),
   (False, True))
eq("…and nothing moved", coins("SELL-F"), 0)

# ══════════════════════════════════════════════════════════════════════════════
print("4. A card an Owner raises is done in the same step; anyone else's waits")

# A loan raised by an Owner from the seller record.
before = coins("SELL-1")
got = run(ops_router.request_lending("SELL-1", _Body(coins=3_000, due_at=due, terms="Two weeks.",
                                                     reason="Festival stock on credit."), user=OWNER_A))
eq("an Owner's loan is executed in the same request", got["stage"], "executed")
eq("…through every stage, each listed", [s["action"] for s in got["fast_path"]["steps"]],
   ["card.review_started", "card.verified", "card.signed", "card.executed"])
eq("…the coins are lent", coins("SELL-1"), before + 3_000)
eq("…and the debt recorded", outstanding("SELL-1"), 3_000)
eq("…every stage audited, plus the one-step marker",
   card_actions(got["id"]),
   ["card.raised", "card.review_started", "card.verified", "card.signed", "card.executed", "card.owner_fast_path"])
eq("…the other Owners heard of it",
   {k.rsplit(":", 1)[-1] for k in notice_keys(got["id"])}, {"u-owner-b", "u-owner-c"})

# The seller repays; an Owner records it — the debt goes down in the same request.
rep = run(ops_router.request_repayment("SELL-1", _Body(coins=1_000, payment_ref="UTR-REPAY-1",
                                                       reason="Seller repaid part of the loan."), user=OWNER_A))
eq("an Owner's repayment is executed in the same request", rep["stage"], "executed")
eq("…and the debt is reduced", outstanding("SELL-1"), 2_000)

# The same loan raised by Finance waits for an Owner.
fin_loan = run(ops_router.request_lending("SELL-1", _Body(coins=500, due_at=due, terms="",
                                                          reason="Small top-up on credit."), user=FIN_ADMIN))
eq("Finance's loan waits for an Owner", fin_loan["stage"], "requested")
ok("…with nothing attempted", "fast_path" not in fin_loan)
eq("…and nothing lent", outstanding("SELL-1"), 2_000)

# A coin purchase raised by an Owner for a seller who paid.
before = coins("SELL-2")
cp = run(ops_router.request_coin_purchase("SELL-2", _Body(coins=5_000, amount_paid_minor=10_000,
                                                          payment_ref="UTR-O6-OWNER", evidence_url="",
                                                          reason="Seller paid by bank transfer."), user=OWNER_B))
eq("an Owner's coin purchase is executed in the same request", cp["stage"], "executed")
eq("…the inventory is credited", coins("SELL-2"), before + 5_000)

# The seller's own purchase request is the seller's: never completed, and answered through the partner view.
mine = run(ops_router.request_coin_purchase("me", _Body(coins=2_000, amount_paid_minor=4_000,
                                                        payment_ref="UTR-O6-SELLER", evidence_url="",
                                                        reason="I paid by UPI."), user=SELLER_1))
eq("a seller's own request waits for Zipper", card_doc(mine["id"])["stage"], "requested")
ok("…no stage was run on it", "fast_path" not in mine and "auto_executed" not in mine)

# A balance credit raised by an Owner from a user's page.
bc = run(users_router.request_balance_change("u-credit-2", _Body(currency=Currency.DIAMONDS, amount=75,
                                                                 reason="Compensation for a failed gift."),
                                             user=OWNER_A))
eq("an Owner's balance credit is executed in the same request", bc["stage"], "executed")
eq("…and the user has the diamonds", fs.collection("users").docs["u-credit-2"]["diamonds"], 75)

# Raised by Finance, the same credit waits.
bc_fin = run(users_router.request_balance_change("u-credit-2", _Body(currency=Currency.DIAMONDS, amount=25,
                                                                     reason="Second compensation."), user=FIN_ADMIN))
eq("Finance's balance credit waits for an Owner", bc_fin["stage"], "requested")
eq("…and nothing moved", fs.collection("users").docs["u-credit-2"]["diamonds"], 75)

# The card that pays an Owner still needs another Owner — even raised by them.
own = run(users_svc.request_balance_change("u-owner-a", Currency.DIAMONDS, 1_000, "Testing my own account.",
                                           OWNER_A, enforce_target_policy=False))
done = run(cards_svc.complete_if_owner(own, OWNER_A, "Testing my own account."))
eq("an Owner's own credit stops before the signature", done["stage"], "awaiting_signoff")
ok("…and says why", "pays you" in str(done.get("owner_complete_error", "")), str(done.get("owner_complete_error")))
eq("…nothing moved", fs.collection("users").docs["u-owner-a"]["diamonds"], 0)
eq("…and another Owner's signature moves it", run(cards_svc.sign(own["id"], OWNER_B, "Approved."))["stage"], "executed")
eq("…once", fs.collection("users").docs["u-owner-a"]["diamonds"], 1_000)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Bulk signing executes each coin card it signs")

b1 = purchase_by_finance("SELL-1", 1_000, "UTR-BULK-1")
b2 = purchase_by_finance("SELL-1", 2_000, "UTR-BULK-2")
before = coins("SELL-1")
res = run(cards_router.sign_bulk([b1, b2], user=OWNER_A))
eq("both are signed", res["signed"], 2)
eq("…and both executed", [c["stage"] for c in res["cards"]], ["executed", "executed"])
eq("…the coins landed, once each", coins("SELL-1"), before + 3_000)

# ══════════════════════════════════════════════════════════════════════════════
print("6. The flag off restores the two-step board")

cards_svc.AUTO_EXECUTE_ON_OWNER_SIGN = False
cards_svc.OWNER_COMPLETES_OWN_CARDS = False
t = purchase_by_finance("SELL-1", 700, "UTR-FLAG-OFF")
before = coins("SELL-1")
s_off = run(cards_svc.sign(t, OWNER_A, "Approved."))
eq("with the flag off a signature leaves the card approved", s_off["stage"], "approved")
eq("…nothing moved", coins("SELL-1"), before)
eq("…until the execute step runs", run(ops.execute_coin_purchase(t, OWNER_A))["stage"], "executed")
eq("…once", coins("SELL-1"), before + 700)
off_loan = run(ops_router.request_lending("SELL-1", _Body(coins=100, due_at=due, terms="",
                                                          reason="Flag off: an Owner's loan waits."), user=OWNER_A))
eq("with the flag off an Owner's own card waits too", off_loan["stage"], "requested")
cards_svc.AUTO_EXECUTE_ON_OWNER_SIGN = True
cards_svc.OWNER_COMPLETES_OWN_CARDS = True

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} owner-signature-is-final checks passed.")
