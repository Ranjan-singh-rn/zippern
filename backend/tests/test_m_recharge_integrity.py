"""B1 — recharges and frozen money: M-14, M-9, §8 notices, §5 holds.

  1. M-14: an approval that died between the seller's debit and the buyer's
     credit is approved again and FINISHES — the ledger key is probed before
     the balance check, so the retry is "already applied", never
     "insufficient" — and `reject` refuses a recharge whose coins debit landed.
  2. M-9: a refund whose Firestore clawback landed and whose Mongo bookkeeping
     died is back under review; REFUSING it then finishes the refund (the
     reversal row is the fact) instead of leaving the buyer debited and a later
     cycle clawing back again.
  3. §8: recharge approval, refund decisions and frozen-money decisions tell
     the other Owners (deterministic keys, idempotent).
  4. §5 / §11: revoking a seller puts its pending cards, recharges and sales on
     the held-for-review list — nothing approved, cancelled or executed —
     visible to Finance/Owner, released by them, alerted while it waits; a
     frozen seller's recharge still cannot be approved.
  5. The stale-claim detector names a recharge stuck `approving`.

REAL: `services/recharges`, `services/money`, `services/money_freeze`,
      `services/owner_mail`, `services/alerts`, `services/partner_ops`.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), SendGrid.

    python3 -m tests.test_m_recharge_integrity
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

from app.services import alerts, money_freeze, owner_mail  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import recharges as rc  # noqa: E402
from app.services.cards import CardType, NewCard  # noqa: E402
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

OWNER = {"uid": "u-owner-a", "name": "Owner One", "role": Role.OWNER, "team": None, "partner_ids": {}}
OWNER_B = {"uid": "u-owner-b", "name": "Owner Two", "role": Role.OWNER, "team": None, "partner_ids": {}}
FIN = {"uid": "u-fin", "name": "Anil", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE, "partner_ids": {}}
APP = {"uid": "system:partner-registration", "name": "app", "role": "system", "team": None}
DB.seed(C.STAFF, [
    {"uid": "u-owner-a", "email": "owner-a@zipper.test", "name": "Owner One", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-b", "email": "owner-b@zipper.test", "name": "Owner Two", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-fin", "email": "fin@zipper.test", "name": "Anil", "role": str(Role.FINANCE_ADMIN), "is_active": True},
])
DB.seed(C.PARTNERS, [{"_id": "SELL", "kind": "seller", "name": "Coins R Us", "status": "approved", "is_active": True,
                      "owner_crm_uid": "u-seller", "total_coins_sold": 0, "credit": {"outstanding": 0, "history": []}}])
DB.seed(C.BALANCES, [{"holder_type": "seller", "holder_id": "SELL", "currency": "coins", "amount": 100_000}])
fs.collection("sellers").docs["SELL"] = {"coinBalance": 100_000}


def rec(rid):
    return next(d for d in DB[C.RECHARGES].docs if d["_id"] == rid)


def diamonds(uid):
    return int(fs.collection("users").docs[uid].get("diamonds", 0))


def coins():
    return run(get_balance(HolderType.SELLER, "SELL", Currency.COINS))


def file(buyer, n=100, reference=""):
    fs.collection("users").docs.setdefault(buyer, {"name": buyer, "diamonds": 0})
    return run(rc.submit_recharge(buyer, "SELL", diamonds=n, amount_minor=n * 100, currency="INR",
                                  payment_method="upi", reference=reference, proof_url="https://x/p.jpg", actor=APP))


def notices_with(prefix: str) -> list[str]:
    return sorted(k for k in fs.collection("notifications").docs if k.startswith(prefix))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. M-14 — a retried approval finishes; a landed debit cannot be rejected")

r = file("b-crash", 500)["id"]
real_apply = rc.apply_movement
calls = {"n": 0}


async def _die_after_debit(m):
    calls["n"] += 1
    result = await real_apply(m)   # the seller's debit LANDS…
    raise RuntimeError("process died after the debit")   # …and the process dies


rc.apply_movement = _die_after_debit
try:
    run(rc.approve_recharge(r, "Paid, verified.", OWNER))
except RuntimeError:
    pass
rc.apply_movement = real_apply
eq("the seller was debited once", coins(), 99_500)
eq("…the buyer not credited", diamonds("b-crash"), 0)
eq("…and the request went back to pending", rec(r)["status"], "pending")
m = refuses("M-14: rejecting it now is refused — the coins debit landed", rc.reject_recharge(r, "Looks fake.", FIN))
ok("…saying what to do instead", "approve it again" in m.lower(), m)
eq("…and nothing changed", (rec(r)["status"], coins()), ("pending", 99_500))
# The seller has since spent down to nothing: the retry must still finish.
run(DB[C.BALANCES].update_one({"holder_id": "SELL"}, {"$set": {"amount": 0}}))
out = run(rc.approve_recharge(r, "Paid, verified — retry.", OWNER))
eq("M-14: the retry finishes the approval although the balance is now 0", out["status"], "approved")
eq("…the buyer is credited once", diamonds("b-crash"), 500)
eq("…the seller is not debited twice", coins(), 0)
eq("…and the ledger holds one debit and one credit for it",
   sorted(d["idempotency_key"] for d in DB[C.LEDGER].docs if str(d.get("idempotency_key", "")).startswith(f"recharge:{r}:")),
   [f"recharge:{r}:coins", f"recharge:{r}:diamonds"])
run(DB[C.BALANCES].update_one({"holder_id": "SELL"}, {"$set": {"amount": 99_500}}))
# A genuinely short seller still gets the honest answer.
short = file("b-short", 200_000)["id"]
m = refuses("a seller who is genuinely short is told so", rc.approve_recharge(short, "Paid.", OWNER))
ok("…with the figures", "holds 99,500 coins" in m or "holds 99500 coins" in m, m)
eq("…and the request stays pending with the shortfall on it", (rec(short)["status"], rec(short)["shortfall"]["needed"]), ("pending", 200_000))

# ══════════════════════════════════════════════════════════════════════════════
print("2. M-9 — refusing a refund whose clawback already landed finishes it")

r2 = file("b-refund", 300)["id"]
run(rc.approve_recharge(r2, "Paid.", OWNER))
eq("credited", diamonds("b-refund"), 300)
run(rc.request_refund(r2, "Chargeback from the bank.", FIN))
coins_before = coins()


async def _die_after_clawback(m):
    raise RuntimeError("process died after the Firestore clawback")


rc.apply_movement = _die_after_clawback
try:
    run(rc.decide_refund(r2, True, "Confirmed chargeback.", OWNER))
except RuntimeError:
    pass
rc.apply_movement = real_apply
eq("the clawback landed", diamonds("b-refund"), 0)
eq("…the request is back under review", rec(r2)["status"], "refund_pending")
eq("…and the seller's coins are not back yet", coins(), coins_before)
out = run(rc.decide_refund(r2, False, "Second look: the bank withdrew the chargeback.", OWNER))
eq("M-9: the refusal FINISHES the refund instead of refusing", out["status"], "refunded")
ok("…and says why", out["forced_by_reversal_row"] is not None and out["forced_by_reversal_row"]["taken"] == 300, out.get("forced_by_reversal_row"))
eq("…the buyer is not clawed back twice", diamonds("b-refund"), 0)
eq("…the seller's coins come back exactly once", coins() - coins_before, 300)
eq("…one reversal row", [k for k in fs.collection("users").document("b-refund").collection("diamondTransactions").docs if "reversal" in k], [f"recharge_{r2}_reversal_1"])
ok("…and the audit entry records the conversion",
   any(d["action"] == "recharge.refunded" and (d.get("meta") or {}).get("forced_by_reversal_row") for d in DB[C.AUDIT].docs))
# A refusal with NO reversal row is an ordinary refusal.
r3 = file("b-refuse", 50)["id"]
run(rc.approve_recharge(r3, "Paid.", OWNER))
run(rc.request_refund(r3, "Buyer asked.", FIN))
out = run(rc.decide_refund(r3, False, "Not warranted.", OWNER))
eq("an ordinary refusal goes back to approved", out["status"], "approved")
eq("…and takes nothing", diamonds("b-refuse"), 50)

# ══════════════════════════════════════════════════════════════════════════════
print("3. §8 — the other Owners are told of recharge, refund and freeze decisions")

eq("the approval told Owner Two, keyed on the recharge",
   notices_with(f"owner_money:{r3}:recharge_approved"), [f"owner_money:{r3}:recharge_approved:u-owner-b"])
eq("…and the refusal", notices_with(f"owner_money:{r3}:refund_refused"), [f"owner_money:{r3}:refund_refused:u-owner-b"])
eq("…and the completed refund", notices_with(f"owner_money:{r2}:refund_approved"), [f"owner_money:{r2}:refund_approved:u-owner-b"])
eq("…by email too", sorted({d["kind"] for d in DB[C.EMAIL_DELIVERIES].docs if d.get("kind", "").startswith("owner_money")}),
   ["owner_money.refund_approved", "owner_money.refund_refused", "owner_money.recharge_approved"] if False else
   sorted({"owner_money.recharge_approved", "owner_money.refund_refused", "owner_money.refund_approved"}))
again = run(owner_mail.notify_other_owners(actor=OWNER, action="recharge_approved", reference=r3, reference_type="recharge",
                                            amount=50, currency="diamonds"))
eq("a retry of the same recharge event sends nothing new", again.get("already"), True)
# A frozen-money decision.
run(money_freeze.freeze("user", "host-f", kinds=["host_earnings"], cause="account_suspended", label="a suspension",
                        reason="Under review.", actor=FIN))
fz = run(money_freeze.decide("user:host-f", "release", "Nothing untoward found.", OWNER))
eq("the freeze decision told Owner Two", notices_with("owner_money:user:host-f:freeze_release"),
   ["owner_money:user:host-f:freeze_release:u-owner-b"])
eq("…and the decision stands", fz["status"], "released")

# ══════════════════════════════════════════════════════════════════════════════
print("4. §5 — pending money on role revocation is held for Finance/Owner review")

fs.collection("users").docs["b-held"] = {"name": "Held buyer", "diamonds": 0}
pending_r = file("b-held", 40, reference="UTR-HELD-1")["id"]
pending_card = run(cards_svc.raise_card(NewCard(
    type=CardType.LENDING_REPAY, team=Team.FINANCE, title="Repayment", amount=1_000, currency="coins",
    reason="Seller repaid part of the credit.", subject_type="seller", subject_id="SELL",
    payload={"coins": 1_000, "payment_ref": "UTR-REPAY"}), FIN))
executed_card = run(cards_svc.raise_card(NewCard(
    type=CardType.SELLER_COIN_PURCHASE, team=Team.FINANCE, title="Old purchase", amount=1, currency="coins",
    reason="Done long ago.", subject_type="seller", subject_id="SELL", payload={}), FIN))
run(DB[C.CARDS].update_one({"_id": executed_card["id"]}, {"$set": {"stage": "executed"}}))
firebase_mod.read_host_wallet = lambda uid: {"beans": 0, "beans_available": 0, "agency_id": "", "is_verified_host": False, "name": "B"}  # type: ignore[assignment]
pending_sale = run(ops.record_sale("SELL", "b-held", 10, 1_000, FIN, "Walk-in sale, cash taken."))
held = run(money_freeze.hold_pending_items_for_revoked_role("seller", "SELL", "Seller role revoked for fraud.", OWNER))
eq("the pending card, the two pending recharges (one is the short one from §1) and the sale are held",
   sorted(i["item_type"] for i in held["items"]), ["card", "recharge", "recharge", "sale"])
eq("…the executed card is not", any(i["id"] == executed_card["id"] for i in held["items"]), False)
eq("…and the earlier, decided recharges are not", any(i["id"] in (r, r2, r3) for i in held["items"]), False)
eq("the marker says why", rec(pending_r)["held"]["reason"], "role_revoked")
eq("…and nothing was approved, cancelled or executed",
   (rec(pending_r)["status"], next(c for c in DB[C.CARDS].docs if c["_id"] == pending_card["id"])["stage"]),
   ("pending", "requested"))
ok("…each hold is audited", sum(1 for d in DB[C.AUDIT].docs if d["action"] == "money.item_held") >= 3)
listed = run(money_freeze.list_held_items())
eq("the Finance board lists them", (len(listed["cards"]), len(listed["recharges"]), len(listed["sales"]), listed["total"]), (1, 2, 1, 4))
eq("a second hold is idempotent", run(money_freeze.hold_pending_items_for_revoked_role("seller", "SELL", "again", OWNER))["held"], 0)
found = run(alerts._find_money_items_held())
eq("the detector names every held item", len(found), 4)
ok("…for Finance and the Owners", all(f.audience == (alerts.FINANCE, alerts.OWNERS) for f in found))
# The freeze behind a real revocation still blocks the money.
run(money_freeze.freeze_partner("SELL", cause="role_revoked", label="the role's revocation", reason="Fraud.", actor=OWNER))
m = refuses("a held recharge of a frozen seller cannot be approved", rc.approve_recharge(pending_r, "Paid.", OWNER))
ok("…because the money is frozen for the Owner", "frozen" in m, m)
eq("the freeze itself put nothing new on hold (already held)", run(money_freeze.list_held_items())["total"], 4)
# Finance decides: reject the recharge; release the card's hold so an Owner can execute it later.
run(rc.reject_recharge(pending_r, "Seller revoked; refund the buyer outside the app.", FIN))
eq("a decided recharge leaves the list (the short one is still pending)", len(run(money_freeze.list_held_items())["recharges"]), 1)
refuses("a member cannot release a hold", money_freeze.release_hold("card", pending_card["id"], "Let it through.", {"uid": "x", "role": "finance_member"}), kind=PermissionError)
released = run(money_freeze.release_hold("card", pending_card["id"], "Repayment is money coming back; proceed.", FIN))
ok("Finance can release a hold, and the marker keeps the history", released["held"]["released_by"]["uid"] == "u-fin")
eq("…and the card leaves the list", len(run(money_freeze.list_held_items())["cards"]), 0)
eq("…but is still on it with include_released", len(run(money_freeze.list_held_items(include_released=True))["cards"]), 1)
refuses("releasing twice is refused", money_freeze.release_hold("card", pending_card["id"], "Again.", FIN), kind=LookupError)

# The role side's hook contract (services/revocation_hooks) is implemented
# in terms of the same list: idempotent, reports the ids, never raises.
from app.services import revocation_hooks  # noqa: E402

hook = run(revocation_hooks.hold_pending_money_for_revoked_seller("SELL", reason="Fraud.", actor=OWNER))
eq("the hook is implemented and names the queue", (hook["implemented"], hook["queue"]), (True, "held_revocation_review"))
eq("…holding nothing new after the freeze already did", hook["newly_held"], 0)
eq("…and reporting what is on the list for this seller", (sorted(hook["cards_held"]), len(hook["requests_held"])),
   ([], 2))   # the card was released above (Finance's decision stands); the short recharge and the sale are still held
summary = run(revocation_hooks.pending_money_summary("partner", "SELL"))
eq("the summary is read-only and implemented", (summary["implemented"], summary["coin_balance"] > 0), (True, True))
ok("…listing the open requests", {r["kind"] for r in summary["open_requests"]} >= {"recharge", "sale"})
ok("…and the pending cards", any(c["id"] == pending_card["id"] for c in summary["cards"]))

# ══════════════════════════════════════════════════════════════════════════════
print("5. A recharge stuck 'approving' is named by the scheduled detector")

stuck = file("b-stuck", 10)["id"]
run(DB[C.RECHARGES].update_one({"_id": stuck}, {"$set": {
    "status": "approving", "claimed_at": datetime.now(timezone.utc) - timedelta(minutes=settings.alert_money_claim_stale_minutes + 1)}}))
found = run(alerts._find_money_claim_stale())
eq("the stale claim is found", [f.key for f in found], [f"recharge_stuck:{stuck}"])
ok("…telling the operator to approve again, not reject", "Do not reject" in found[0].action)
ok("the detectors are on the scheduled scan", {"money_claim_stale", "money_items_held"} <= set(alerts.DETECTORS_BY_ID))

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} recharge-integrity checks passed.")
