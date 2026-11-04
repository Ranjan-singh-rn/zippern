"""B1 — the owner-alone money card (master spec §8) and the board's races.

What is pinned:

  1. One Owner raises, verifies, signs and executes a card alone — through the
     stages one by one and through `owner_fast_path` — and EVERY transition
     writes its own audit entry (`card.raised`, `card.review_started`,
     `card.verified`, `card.signed`, `card.executed`), nothing skipped.
  2. Everybody who is not an Owner meets the old boundaries: a Finance admin
     cannot verify the card they raised, a team admin cannot sign, a member of
     another department cannot reject (B-2), and only an Owner rejects a
     verified or signed card. An Owner still cannot sign the card that pays
     them (OWNER_DECISION_PENDING flag).
  3. B-6: a sign racing a reject cannot resurrect a rejected card; a verify
     racing a reject cannot either.
  4. B-23: a card verified straight from `requested` passes THROUGH Under
     Review in the record — `review_started_at/by` and `card.review_started`.
  5. B-3: the generic `POST /api/cards` raises only configuration types.
  6. §8 notifications: after a signature and after an execution every OTHER
     active Owner gets an in-app notice (deterministic id) and an email; a
     retry of the same event sends nothing twice; a provider failure never
     undoes the signature — the notice is recorded pending and the sweep's
     retry delivers it.

REAL: `services/cards`, `services/owner_mail`, `services/email` (deliver),
      `services/notify`, `services/notices`, `core/audit`, `routers/cards`.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), SendGrid.

    python3 -m tests.test_m_owner_alone
"""

from __future__ import annotations

import asyncio
import logging
import sys
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

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.routers import cards as cards_router  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402

# O6 (Owner decision, 5 Nov 2026): an Owner's signature now executes a coin / diamond card in the same request
# (`cards.AUTO_EXECUTE_ON_OWNER_SIGN`). This file pins the two-step board — sign, then the type's own execute route —
# which is what the flag restores when switched off and what a card signed before the decision still takes. Nothing
# asserted below changed; the decision's own behaviour is pinned in tests/test_o6_owner_sign_final.py.
cards_svc.AUTO_EXECUTE_ON_OWNER_SIGN = False
from app.services import owner_mail  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402  (registers the executors)
from app.services.cards import CardError, CardType, NewCard, Stage  # noqa: E402
from app.services.money import Currency, HolderType, get_balance  # noqa: E402

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


def refuses(claim: str, coro, *, kind=CardError) -> str:
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


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]


def internal(uid: str, role: Role, team=None, name: str = "") -> dict:
    return {"uid": uid, "name": name or uid, "role": role, "team": team, "partner_ids": {}}


OWNER_A = internal("u-owner-a", Role.OWNER, name="Owner One")
OWNER_B = internal("u-owner-b", Role.OWNER, name="Owner Two")
FIN_ADMIN = internal("u-fin-admin", Role.FINANCE_ADMIN, Team.FINANCE, "Anil (Finance admin)")
FIN_MEMBER = internal("u-fin-member", Role.FINANCE_MEMBER, Team.FINANCE, "Sara (Finance)")
OPS_ADMIN = internal("u-ops-admin", Role.OPS_ADMIN, Team.OPS, "Neha (Ops admin)")
MARKETING_MEMBER = internal("u-mkt", Role.MARKETING_MEMBER, Team.MARKETING, "Rhea (Marketing)")

# The staff record is where the Owners' addresses come from — never a constant.
DB.seed(C.STAFF, [
    {"uid": "u-owner-a", "email": "owner-a@zipper.test", "name": "Owner One", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-b", "email": "owner-b@zipper.test", "name": "Owner Two", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-c", "email": "owner-c@zipper.test", "name": "Owner Three", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-gone", "email": "gone@zipper.test", "name": "Former Owner", "role": str(Role.OWNER), "is_active": False},
    {"uid": "u-fin-admin", "email": "fin@zipper.test", "name": "Anil", "role": str(Role.FINANCE_ADMIN), "is_active": True},
])
DB.seed(C.PARTNERS, [
    {"_id": "SELL-1", "kind": "seller", "name": "Coins R Us", "status": "approved", "is_active": True,
     "owner_crm_uid": "u-seller-1", "credit": {"outstanding": 0, "history": []}},
])


def audit_actions(card_id: str) -> list[str]:
    return [d["action"] for d in DB[C.AUDIT].docs if (d.get("subject") or {}).get("id") == card_id]


def card_doc(card_id: str) -> dict:
    return next(d for d in DB[C.CARDS].docs if str(d["_id"]) == card_id)


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


def emails(kind_prefix: str = "owner_money") -> list[dict]:
    return [d for d in DB[C.EMAIL_DELIVERIES].docs if str(d.get("kind", "")).startswith(kind_prefix)]


def raise_purchase(actor: dict, coins: int = 10_000, ref: str = "UTR-1") -> dict:
    return run(cards_svc.raise_card(NewCard(
        type=CardType.SELLER_COIN_PURCHASE, team=Team.FINANCE, title=f"Coin purchase — {coins} coins",
        amount=coins, currency=str(Currency.COINS), reason="Seller paid for inventory; bank advice attached.",
        subject_type="seller", subject_id="SELL-1",
        payload={"coins": coins, "amount_paid_minor": coins * 229, "payment_ref": ref},
    ), actor))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. One Owner alone, stage by stage, every step audited")

card = raise_purchase(OWNER_A, ref="UTR-ALONE-1")
cid = card["id"]
eq("a fresh card starts at requested", card["stage"], "requested")
v = run(cards_svc.verify(cid, OWNER_A, "Bank advice matches the coins asked for."))
eq("the Owner who raised it verifies it", v["stage"], "awaiting_signoff")
eq("…and Under Review was recorded on the way (B-23)", v["review_started_by"]["uid"], "u-owner-a")
ok("…with a timestamp", v["review_started_at"] is not None)
s = run(cards_svc.sign(cid, OWNER_A, "Approved."))
eq("the same Owner signs it", s["stage"], "approved")
eq("…and the card says so", s["owner_alone"], True)
x = run(ops.execute_coin_purchase(cid, OWNER_A))
eq("the same Owner executes it", x["stage"], "executed")
eq("…and the coins landed once", run(get_balance(HolderType.SELLER, "SELL-1", Currency.COINS)), 10_000)
eq("every transition wrote its own audit entry, in order",
   [a for a in audit_actions(cid) if a.startswith("card.")],
   ["card.raised", "card.review_started", "card.verified", "card.signed", "card.executed"])
eq("…every one by the same Owner",
   {(d.get("actor") or {}).get("uid") for d in DB[C.AUDIT].docs if (d.get("subject") or {}).get("id") == cid},
   {"u-owner-a"})

# ══════════════════════════════════════════════════════════════════════════════
print("2. The fast path — the same sequence in one request, nothing skipped")

card2 = raise_purchase(OWNER_B, coins=5_000, ref="UTR-FAST-1")
cid2 = card2["id"]
out = run(cards_svc.owner_fast_path(cid2, OWNER_B, verification_note="Checked the advice.", execute=True))
eq("the fast path ends executed", out["stage"], "executed")
eq("…listing each step it took", [s["action"] for s in out["fast_path"]["steps"]],
   ["card.review_started", "card.verified", "card.signed", "card.executed"])
eq("…and the audit trail has every stage plus the fast-path marker",
   [a for a in audit_actions(cid2) if a.startswith("card.")],
   ["card.raised", "card.review_started", "card.verified", "card.signed", "card.executed", "card.owner_fast_path"])
eq("…the coins landed once more", run(get_balance(HolderType.SELLER, "SELL-1", Currency.COINS)), 15_000)
refuses("the fast path is an Owner's alone", cards_svc.owner_fast_path(
    raise_purchase(FIN_ADMIN, ref="UTR-FAST-2")["id"], FIN_ADMIN, verification_note="Mine."))
refuses("…and it needs a verification note", cards_svc.owner_fast_path(cid2, OWNER_B, verification_note="  "))
# A card already signed just executes; a card already executed refuses.
card3 = raise_purchase(OWNER_A, coins=1, ref="UTR-FAST-3")
run(cards_svc.owner_fast_path(card3["id"], OWNER_A, verification_note="ok ok"))
eq("without execute=True the fast path stops at approved", card_doc(card3["id"])["stage"], "approved")
out3 = run(cards_svc.owner_fast_path(card3["id"], OWNER_A, verification_note="again", execute=True))
eq("…and a second call executes it", out3["stage"], "executed")
refuses("…and a third finds it executed", cards_svc.owner_fast_path(card3["id"], OWNER_A, verification_note="again"))
# A type with no registered executor stops at the signature and says so.
cfg = run(cards_svc.raise_card(NewCard(
    type=CardType.RATE_CHANGE, team=Team.FINANCE, title="Rate change", amount=1, currency="inr_minor",
    reason="Bean rate review.", subject_type="config", subject_id="economy", payload={}), OWNER_A))
m = refuses("a type executed from its own route stops the fast path at the signature",
            cards_svc.owner_fast_path(cfg["id"], OWNER_A, verification_note="Reviewed.", execute=True))
ok("…saying so", "own route" in m, m)
eq("…with the card signed all the same", card_doc(cfg["id"])["stage"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("3. Everybody else keeps the old boundaries")

fin_card = raise_purchase(FIN_ADMIN, ref="UTR-FIN-1")
refuses("a Finance admin cannot verify the card they raised",
        cards_svc.verify(fin_card["id"], FIN_ADMIN, "Mine, and correct."))
refuses("a member cannot verify", cards_svc.verify(fin_card["id"], FIN_MEMBER, "Checked."))
refuses("an admin of another department cannot verify a Finance card",
        cards_svc.verify(fin_card["id"], OPS_ADMIN, "Looks fine."))
run(cards_svc.verify(fin_card["id"], OWNER_B, "Checked by an Owner."))
refuses("a Finance admin cannot sign", cards_svc.sign(fin_card["id"], FIN_ADMIN, "Approved."))
refuses("a team admin cannot sign", cards_svc.sign(fin_card["id"], OPS_ADMIN, "Approved."))
refuses("a member cannot sign", cards_svc.sign(fin_card["id"], FIN_MEMBER, "Approved."))
# B-2 — rejecting.
refuses("B-2: a member of another department cannot reject a verified card",
        cards_svc.reject(fin_card["id"], MARKETING_MEMBER, "No."))
refuses("B-2: nor can a Finance admin once it is verified",
        cards_svc.reject(fin_card["id"], FIN_ADMIN, "Changed my mind."))
pre = raise_purchase(FIN_MEMBER, ref="UTR-PRE-1")
refuses("B-2: a marketing member cannot reject a requested Finance card",
        cards_svc.reject(pre["id"], MARKETING_MEMBER, "No."))
refuses("B-2: nor can the member who raised it",
        cards_svc.reject(pre["id"], FIN_MEMBER, "Withdrawn."))
eq("B-2: the Finance admin can reject a requested Finance card",
   run(cards_svc.reject(pre["id"], FIN_ADMIN, "Reference belongs to another payment."))["stage"], "rejected")
pre2 = raise_purchase(FIN_MEMBER, ref="UTR-PRE-2")
refuses("B-2: an Ops admin cannot reject a requested Finance card",
        cards_svc.reject(pre2["id"], OPS_ADMIN, "No."))
run(cards_svc.sign(fin_card["id"], OWNER_A, "Approved."))
refuses("B-2: an approved card is rejected only by an Owner",
        cards_svc.reject(fin_card["id"], FIN_ADMIN, "No."))
eq("…and an Owner can", run(cards_svc.reject(fin_card["id"], OWNER_B, "Not this week."))["stage"], "rejected")
# The one refusal kept for Owners: the card that pays them.
drawings = run(cards_svc.raise_card(NewCard(
    type=CardType.OWNER_DRAWINGS, team=Team.FINANCE, title="Drawings", amount=100_000, currency="inr_minor",
    reason="Owner takes money out.", subject_type="owner", subject_id="u-owner-a", payload={}), FIN_ADMIN))
run(cards_svc.verify(drawings["id"], OWNER_A, "Checked."))
m = refuses("an Owner still cannot sign the card that pays them (OWNER_DECISION_PENDING)",
            cards_svc.sign(drawings["id"], OWNER_A, "Approved."))
ok("…saying so", "pays you" in m, m)
eq("…while another Owner can", run(cards_svc.sign(drawings["id"], OWNER_B, "Approved."))["stage"], "approved")
ok("the owner's queue leaves out the card that pays them",
   drawings["id"] not in {c["id"] for c in run(cards_svc.awaiting_my_signature(OWNER_A))})

# ══════════════════════════════════════════════════════════════════════════════
print("4. B-6 — a sign racing a reject cannot resurrect a rejected card")

race = raise_purchase(FIN_MEMBER, ref="UTR-RACE-1")
run(cards_svc.verify(race["id"], FIN_ADMIN, "Checked."))


async def _sign_vs_reject():
    return await asyncio.gather(
        cards_svc.reject(race["id"], OWNER_A, "Reference reused."),
        cards_svc.sign(race["id"], OWNER_B, "Approved."),
        return_exceptions=True,
    )


res = run(_sign_vs_reject())
eq("exactly one of the two wins", sum(1 for r in res if isinstance(r, dict)), 1)
ok("…the other is a board refusal, not a crash", all(isinstance(r, CardError) for r in res if not isinstance(r, dict)))
ok("…and the card is rejected or approved, never both", card_doc(race["id"])["stage"] in ("rejected", "approved"))
# A reject that lands first: the sign must not flip it back to approved.
race2 = raise_purchase(FIN_MEMBER, ref="UTR-RACE-2")
run(cards_svc.verify(race2["id"], FIN_ADMIN, "Checked."))
real_get = cards_svc._get
seen = {"n": 0}


async def _get_then_reject(card_id, as_dict=False):
    doc = await real_get(card_id, as_dict)
    if card_id == race2["id"] and seen["n"] == 0 and not as_dict:
        seen["n"] += 1
        # The reject lands between the signer's read and the signer's write.
        await DB[C.CARDS].update_one({"_id": card_id}, {"$set": {"stage": "rejected"}})
    return doc


cards_svc._get = _get_then_reject
m = refuses("a sign whose read predates a reject misses its write (B-6)", cards_svc.sign(race2["id"], OWNER_A, "Approved."))
cards_svc._get = real_get
eq("…and the card stays rejected", card_doc(race2["id"])["stage"], "rejected")
ok("…and the refusal names the stage", "rejected" in m, m)
# The same for verify.
race3 = raise_purchase(FIN_MEMBER, ref="UTR-RACE-3")
run(cards_svc.start_review(race3["id"], FIN_ADMIN))
seen["n"] = 0


async def _get_then_reject3(card_id, as_dict=False):
    doc = await real_get(card_id, as_dict)
    if card_id == race3["id"] and seen["n"] == 0 and not as_dict:
        seen["n"] += 1
        await DB[C.CARDS].update_one({"_id": card_id}, {"$set": {"stage": "rejected"}})
    return doc


cards_svc._get = _get_then_reject3
refuses("a verify whose read predates a reject misses its write (B-6)", cards_svc.verify(race3["id"], FIN_ADMIN, "Checked."))
cards_svc._get = real_get
eq("…and the card stays rejected", card_doc(race3["id"])["stage"], "rejected")

# ══════════════════════════════════════════════════════════════════════════════
print("5. B-3 — the generic board route raises configuration cards only")

from tests.harness import HTTPException  # noqa: E402


class _Body:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def generic(card_type):
    return cards_router.raise_card(_Body(
        type=card_type, team=Team.FINANCE, title="Generic", amount=100, currency="coins",
        reason="A generic raise.", subject_type="seller", subject_id="SELL-1", payload={}, evidence=[],
    ), user=FIN_ADMIN)


for t in (CardType.SELLER_COIN_PURCHASE, CardType.LENDING_ISSUE, CardType.COMMISSION_PAYOUT,
          CardType.HOST_WITHDRAWAL, CardType.OPERATING_EXPENSE, CardType.OWNER_CAPITAL_IN,
          CardType.CHANCE_CONFIG_CHANGE, CardType.BALANCE_CREDIT):
    m = refuses(f"B-3: {t} is refused on the generic route", generic(t), kind=HTTPException)
    ok(f"…pointing at its own route ({t})", "own route" in m or "person's page" in m, m)
eq("…while a rate change is raised there", run(generic(CardType.RATE_CHANGE))["stage"], "requested")
ok("the allow-list names no money type",
   not (cards_svc.GENERIC_RAISE_TYPES & {str(CardType.SELLER_COIN_PURCHASE), str(CardType.HOST_WITHDRAWAL),
                                          str(CardType.COMMISSION_PAYOUT), str(CardType.BALANCE_CREDIT),
                                          str(CardType.LENDING_ISSUE)}))

# ══════════════════════════════════════════════════════════════════════════════
print("6. The other Owners are told — in-app and by email, once, retryably")

fs.collection("notifications").docs.clear()
PROVIDER.sent.clear()
n_card = raise_purchase(OWNER_A, coins=777, ref="UTR-NOTIFY-1")
ncid = n_card["id"]
run(cards_svc.verify(ncid, OWNER_A, "Checked."))
signed = run(cards_svc.sign(ncid, OWNER_A, "Approved."))
notice = signed["owner_notice"]
eq("the signature's notice is sent", notice["status"], "sent")
eq("…to the two other active Owners, not the signer, not the former Owner", notice["recipients"], 2)
key = owner_mail.event_key(ncid, "card_signed")
eq("the event key is deterministic", key, f"owner_money:{ncid}:card_signed")
eq("each other Owner has one in-app notice, keyed on the event",
   sorted(fs.collection("notifications").docs), sorted([f"{key}:u-owner-b", f"{key}:u-owner-c"]))
ok("the signer got none", not notices_for("u-owner-a"))
ok("nor the former Owner", not notices_for("u-owner-gone"))
one = notices_for("u-owner-b")[0]
eq("the notice is typed for the CRM", one["type"], "owner_money")
ok("…and names the actor, the action, the amount and the reference",
   "Owner One" in one["body"] and "signed" in one["body"] and "777" in one["body"] and ncid in one["body"], one["body"])
eq("…with the facts in meta", (one["meta"]["eventKey"], one["meta"]["amount"], one["meta"]["actorUid"]),
   (key, 777, "u-owner-a"))
sent = [s for s in PROVIDER.sent]
eq("two emails went out", len(sent), 2)
eq("…to the two other Owners", sorted(s["to"] for s in sent), ["owner-b@zipper.test", "owner-c@zipper.test"])
ok("…with actor, action, amount and reference in the body",
   all("Owner One" in s["html"] and "777" in s["html"] and ncid in s["html"] and "Card signed" in s["html"] for s in sent))
ok("…and no address of anybody else", not any("fin@zipper.test" in str(s["to"]) for s in sent))
eq("the delivery rows carry the kind",
   {d["kind"] for d in emails() if (d.get("meta") or {}).get("reference") == ncid}, {"owner_money.card_signed"})
row = next(d for d in DB[C.OWNER_NOTICES].docs if d["_id"] == key)
eq("the owner_notices row is sent", row["status"], "sent")
ok("…and audited", any(d["action"] == "owner_money.notified" and (d.get("subject") or {}).get("id") == key
                         for d in DB[C.AUDIT].docs))

# Idempotent on retry: the same event again sends nothing.
again = run(owner_mail.notify_other_owners(actor=OWNER_A, action="card_signed", reference=ncid,
                                            reference_type="card", amount=777, currency="coins", title="x"))
eq("a retry of the same event is recognised", again.get("already"), True)
eq("…and sends no second email", len(PROVIDER.sent), 2)
eq("…and writes no second notice", len(fs.collection("notifications").docs), 2)

# Execution notifies too, under its own key.
PROVIDER.sent.clear()
run(ops.execute_coin_purchase(ncid, OWNER_A))
exec_key = owner_mail.event_key(ncid, "card_executed")
eq("the execution has its own event", sorted(k for k in fs.collection("notifications").docs if "executed" in k),
   sorted([f"{exec_key}:u-owner-b", f"{exec_key}:u-owner-c"]))
eq("…and two more emails", len(PROVIDER.sent), 2)
ok("…saying executed", all("Card executed" in s["html"] for s in PROVIDER.sent))

# A provider failure does not undo the business action; the notice stays retryable.
PROVIDER.sent.clear()
PROVIDER.raise_on_send = RuntimeError("SendGrid is down")
f_card = raise_purchase(OWNER_B, coins=321, ref="UTR-NOTIFY-FAIL")
fcid = f_card["id"]
run(cards_svc.verify(fcid, OWNER_B, "Checked."))
signed_f = run(cards_svc.sign(fcid, OWNER_B, "Approved."))
eq("the signature stands when the email fails", signed_f["stage"], "approved")
eq("…and the card's audit trail has the signature", audit_actions(fcid).count("card.signed"), 1)
eq("…while the notice is pending", signed_f["owner_notice"]["status"], "pending")
fkey = owner_mail.event_key(fcid, "card_signed")
frow = next(d for d in DB[C.OWNER_NOTICES].docs if d["_id"] == fkey)
eq("the owner_notices row is pending", frow["status"], "pending")
ok("…the in-app half landed", all(frow["deliveries"][u]["in_app"] for u in ("u-owner-a", "u-owner-c")))
ok("…the email half did not", all(frow["deliveries"][u]["email"] != "sent" for u in ("u-owner-a", "u-owner-c")))
ok("…and the failure is audited",
   any(d["action"] == "owner_money.notice_failed" and (d.get("subject") or {}).get("id") == fkey for d in DB[C.AUDIT].docs))
eq("the pending list shows it", [p["id"] for p in run(owner_mail.pending())], [fkey])
# The provider comes back; the sweep's retry delivers only what is owed.
PROVIDER.raise_on_send = None
retried = run(owner_mail.retry_pending())
eq("the retry sends it", [r["outcome"] for r in retried], ["sent"])
eq("…to the two Owners not yet told, once each", sorted(s["to"] for s in PROVIDER.sent),
   ["owner-a@zipper.test", "owner-c@zipper.test"])
frow = next(d for d in DB[C.OWNER_NOTICES].docs if d["_id"] == fkey)
eq("…and the row is sent", frow["status"], "sent")
eq("…with no second in-app notice", len([k for k in fs.collection("notifications").docs if k.startswith(fkey)]), 2)
eq("nothing is pending any more", run(owner_mail.pending()), [])
eq("a second retry has nothing to do", run(owner_mail.retry_pending()), [])

# The alert detector sees a notice still pending after the configured minutes.
from datetime import datetime, timedelta, timezone  # noqa: E402

from app.services import alerts  # noqa: E402

PROVIDER.raise_on_send = RuntimeError("SendGrid is down again")
g_card = raise_purchase(OWNER_C := internal("u-owner-c", Role.OWNER, name="Owner Three"), coins=5, ref="UTR-NOTIFY-OLD")
run(cards_svc.verify(g_card["id"], OWNER_C, "Checked."))
run(cards_svc.sign(g_card["id"], OWNER_C, "Approved."))
PROVIDER.raise_on_send = None
gkey = owner_mail.event_key(g_card["id"], "card_signed")
eq("a fresh pending notice is below the threshold", run(alerts._find_owner_notice_failed()), [])
run(DB[C.OWNER_NOTICES].update_one({"_id": gkey}, {"$set": {
    "created_at": datetime.now(timezone.utc) - timedelta(minutes=settings.alert_owner_notice_pending_minutes + 5)}}))
found = run(alerts._find_owner_notice_failed())
eq("…and an old one is found by the detector", [f.key for f in found], [f"owner_notice_failed:{gkey}"])
ok("…naming the Owners not told", "u-owner-a" in dict(found[0].rows)["Owners not yet told"])
ok("the detector is registered for the scheduled scan", "owner_notice_failed" in alerts.DETECTORS_BY_ID)

# No other Owner at all: recorded, not failed.
DB[C.STAFF].docs = [d for d in DB[C.STAFF].docs if d["uid"] == "u-owner-a" or d["role"] != "owner"]
solo = raise_purchase(OWNER_A, coins=9, ref="UTR-SOLO")
run(cards_svc.verify(solo["id"], OWNER_A, "Checked."))
eq("with no other Owner the notice records that and the signature stands",
   run(cards_svc.sign(solo["id"], OWNER_A, "Approved."))["owner_notice"]["status"], "no_recipients")

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} owner-alone checks passed.")
