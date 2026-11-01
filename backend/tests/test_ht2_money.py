"""HT-2 — money and records under Firestore failure: once, and never misreported.

── WHY ─────────────────────────────────────────────────────────────────────

An error from a Firestore transaction never proves that nothing committed: the
client re-sends a commit on UNAVAILABLE / RESOURCE_EXHAUSTED, a re-sent commit
of an applied transaction can come back as an error, and ABORTED there makes
the library run the callback AGAIN on the state it just committed.

  * A HOST WITHDRAWAL card raised without a payout request carried no
    idempotency key: a re-run callback debited the wallet AGAIN, and so did two
    executions of the card at once. Any error was reported as "nothing was paid
    — raise a fresh one" and the card failed, even when the debit had landed
    (and a fresh card, with its own key, could debit again).
  * A settled card whose answer was lost was refused on its own retry ("already
    paid its request") and never got its ledger row.
  * The signed balance card, the refund and the official warning were already
    keyed (history id / warning id) and resumable, but any error was a bare 500
    — even when the effect had landed.
  * A verification decision whose answer was lost came back as "changed while
    you were reviewing": the host verified or rejected with no audit entry and
    no notice, and a re-review refused.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  1. withdrawal: a lost answer debits ONCE; applied-then-deadline is verified
     and executed; not-visible outcomes keep the card APPROVED with a typed
     409 / 503 that says to execute THIS card again — which then debits once,
     even after a late landing; two executions at once debit once; a settled
     card's lost answer is executed with its ledger row; a completed card
     executed again is still refused, as before;
  2. signed balance card, 3. refund, 4. warning: an effect that landed is
     verified and finished in the same call; one that is not visible is a typed
     409 / 503 saying the retry is safe; the retry acts once;
  5. verification review: a lost answer is the decision, audited and notified
     once; a decision not visible is a typed 409; deciding again applies once.

REAL: `app.db.firebase` (debit, clawback, warning, classification),
      `partner_ops.execute_host_withdrawal`, `users` (balance card, warning),
      `recharges.decide_refund`, `verification.review`, the cards board, the
      Mongo ledger code, and the library's own retry loop.
FAKE: Firestore = `tests/fakes_tx.TxFirestore`; Mongo (`harness.FakeDb`);
      audit and notices are recorders.

Service-level tests against an in-memory model — NOT end-to-end.

    python3 -m tests.test_ht2_money
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

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


from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes_tx import TxFirestore, defer  # noqa: E402
from tests.firestore_contention import ACTOR, Aborted, DeadlineExceeded, acting  # noqa: E402

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

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = TxFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
firebase_mod.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]
from tests import harness as _harness  # noqa: E402

firebase_mod.get_user = _harness.verified_auth  # type: ignore[assignment]
AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    await DB[C.AUDIT].insert_one({"action": kw.get("action"),
                                  "subject": {"type": kw.get("subject_type"), "id": kw.get("subject_id")},
                                  "meta": kw.get("meta") or {}})
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.core.roles import Role, Team  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import notices as notices_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import recharges as rc  # noqa: E402
from app.services import users as users_svc  # noqa: E402
from app.services import verification as verification_svc  # noqa: E402

rc.audit.record = fake_audit
NOTICES: list[tuple] = []


async def _verified_notice(uid, approved, reason=""):
    NOTICES.append(("verification", uid, approved))
    return True


notices_mod.host_verification_decided = _verified_notice
apps.is_unverified_guest = lambda uid: False
logging.disable(logging.CRITICAL)
run = asyncio.run

_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

WithdrawalDebitNotConfirmed = getattr(ops, "WithdrawalDebitNotConfirmed", None)
LiveStepNotConfirmed = getattr(users_svc, "LiveStepNotConfirmed", None)
RefundStepNotConfirmed = getattr(rc, "RefundStepNotConfirmed", None)
VerificationNotApplied = getattr(verification_svc, "VerificationNotApplied", None)


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team, "partner_ids": {}}


RAISER = internal("uid-finance-a", Role.FINANCE_ADMIN, Team.FINANCE)
VERIFIER = internal("uid-finance-b", Role.FINANCE_ADMIN, Team.FINANCE)
OWNER = internal("uid-owner", Role.OWNER)
STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
SUPER = {"uid": "owner-1", "name": "Owner", "role": "superadmin", "team": None}
APP = {"uid": "system:partner-registration", "name": "app", "role": "system", "team": None}

#: every scripted failure that actually fired: (label, what)
FIRED: list[tuple] = []


def always(error):
    def hook(tx, *rest):
        err = error()
        FIRED.append((tx.label, type(err).__name__))
        raise err
    return hook


def once(hook):
    fired: list[int] = []

    def wrapped(tx, *rest):
        if not fired:
            fired.append(1)
            hook(tx, *rest)
    return wrapped


def writes_only(hook):
    """Act only on attempts that write — a re-run attempt that recognises its
    own commit writes nothing, and must not be failed again."""
    def wrapped(tx, *rest):
        if tx._writes:
            hook(tx, *rest)
    return wrapped


def deferring(error):
    inner = defer(error)

    def hook(tx, *rest):
        FIRED.append((tx.label, "deferred"))
        inner(tx)
    return hook


def really(where: str) -> None:
    ok(f"the scripted failure really fired ({where})", bool(FIRED), "nothing was injected")
    FIRED.clear()


def attempt(coro_fn, label: str, *args, **kwargs):
    try:
        return acting(label, run, coro_fn(*args, **kwargs))
    except Exception as exc:  # noqa: BLE001 — returned and asserted on
        return exc


def show(x) -> str:
    return repr(x) if isinstance(x, Exception) else str(x)[:200]


def doc(path: str) -> dict:
    col, did = path.split("/")
    return fs.collection(col).docs.get(did) or {}


def card(cid: str) -> dict:
    return next(c for c in DB[C.CARDS].docs if str(c.get("_id")) == cid)


def ledger_rows(cid: str) -> int:
    return len([r for r in DB[C.LEDGER].docs if str(r.get("card_id")) == cid])


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Host withdrawal cards")


def host(uid: str, beans: int) -> None:
    fs.collection("users").docs[uid] = {"name": uid, "beans": beans, "beansAvailable": beans,
                                        "agencyId": "ag-1", "isVerifiedHost": True}


def withdrawal(uid: str, beans: int, collection: str = "", rid: str = "") -> str:
    kw = {"request_collection": collection, "request_id": rid} if collection else {}
    c = run(ops.request_host_withdrawal(uid, beans, "Paying out.", RAISER, **kw))
    run(cards_svc.verify(c["id"], VERIFIER, "Checked against the request."))
    run(cards_svc.sign(c["id"], OWNER, "Approved."))
    return c["id"]


host("w1", 10_000)
cid = withdrawal("w1", 4_000)
fs.after_commit["w1"] = writes_only(once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(ops.execute_host_withdrawal, "w1", cid, "UTR-1", OWNER)
fs.clear_hooks()
really("withdrawal, lost answer")
print(f"   request-less card, lost answer → {show(out)}")
eq("a request-less card whose answer was lost debits the wallet ONCE (it used to debit twice)",
   doc("users/w1").get("beansAvailable"), 6_000)
eq("…executed, with one ledger row", (card(cid).get("stage"), ledger_rows(cid)), ("executed", 1))

host("w2", 10_000)
cid = withdrawal("w2", 4_000)
fs.after_commit["w2"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(ops.execute_host_withdrawal, "w2", cid, "UTR-2", OWNER)
fs.clear_hooks()
really("withdrawal, applied then deadline")
print(f"   applied, then a deadline → {show(out)}")
ok("a debit applied but answered with a deadline is verified and the card executed "
   "(it used to be 'nothing was paid — raise a fresh one' over a debited wallet)",
   not isinstance(out, Exception), show(out))
eq("…debited once, executed, one ledger row",
   (doc("users/w2").get("beansAvailable"), card(cid).get("stage"), ledger_rows(cid)), (6_000, "executed", 1))

host("w3", 10_000)
cid = withdrawal("w3", 4_000)
fs.on_commit["w3"] = deferring(lambda: DeadlineExceeded("504"))
out = attempt(ops.execute_host_withdrawal, "w3", cid, "UTR-3", OWNER)
fs.clear_hooks()
really("withdrawal, outcome unknown")
ok("a debit not visible after a deadline: a typed 503 — not 'nothing was paid'",
   WithdrawalDebitNotConfirmed is not None and isinstance(out, WithdrawalDebitNotConfirmed)
   and out.status_code == 503, show(out))
ok("…saying to execute THIS card again, not to raise a new one",
   "execute THIS card again" in str(out) and "do not raise a new" in str(out), show(out))
eq("…the card is still approved, the wallet untouched (for now)",
   (card(cid).get("stage"), doc("users/w3").get("beansAvailable")), ("approved", 10_000))
eq("the debit then lands late", fs.land_deferred(), [True])
out = attempt(ops.execute_host_withdrawal, "w3b", cid, "UTR-3", OWNER)
ok("executing the same card again finishes it", not isinstance(out, Exception), show(out))
eq("…debited ONCE in all, executed, one ledger row",
   (doc("users/w3").get("beansAvailable"), card(cid).get("stage"), ledger_rows(cid)), (6_000, "executed", 1))

host("w4", 10_000)
cid = withdrawal("w4", 4_000)
fs.on_commit["w4"] = always(lambda: Aborted("409"))
out = attempt(ops.execute_host_withdrawal, "w4", cid, "UTR-4", OWNER)
fs.clear_hooks()
really("withdrawal, contended")
ok("a debit Firestore kept aborting: a typed 409, the card still approved",
   WithdrawalDebitNotConfirmed is not None and isinstance(out, WithdrawalDebitNotConfirmed)
   and out.status_code == 409 and card(cid).get("stage") == "approved", show(out))
out = attempt(ops.execute_host_withdrawal, "w4b", cid, "UTR-4", OWNER)
eq("…executing it again debits once", (doc("users/w4").get("beansAvailable"), card(cid).get("stage"),
                                        ledger_rows(cid)), (6_000, "executed", 1))

host("w5", 10_000)
cid = withdrawal("w5", 4_000)
fs.on_commit["race-0"] = lambda tx: None
results: list = [None, None]
gate = threading.Barrier(2)


def execute(k: int) -> None:
    ACTOR.set(f"race-{k}")
    gate.wait()
    try:
        results[k] = run(ops.execute_host_withdrawal(cid, "UTR-5", OWNER))
    except Exception as exc:  # noqa: BLE001
        results[k] = exc


fs.on_commit["race-0"] = lambda tx: __import__("time").sleep(0.01)
threads = [threading.Thread(target=execute, args=(k,)) for k in range(2)]
for t in threads:
    t.start()
for t in threads:
    t.join(30)
fs.clear_hooks()
FIRED.clear()
print(f"   two executions at once → {[show(r)[:60] for r in results]}")
eq("two executions of one request-less card at once debit the wallet ONCE",
   doc("users/w5").get("beansAvailable"), 6_000)
eq("…and leave one ledger row", ledger_rows(cid), 1)

host("w6", 10_000)
fs.collection("withdrawalRequests").docs["wr6"] = {"hostUid": "w6", "beans": 4_000, "status": "approved"}
cid = withdrawal("w6", 4_000, "withdrawalRequests", "wr6")
fs.after_commit["w6"] = writes_only(once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(ops.execute_host_withdrawal, "w6", cid, "UTR-6", OWNER)
fs.clear_hooks()
really("settled card, lost answer")
ok("a settled card whose answer was lost is EXECUTED (it used to refuse itself: 'already paid its request')",
   not isinstance(out, Exception), show(out))
eq("…debited once, the request paid by this card, one ledger row",
   (doc("users/w6").get("beansAvailable"), doc("withdrawalRequests/wr6").get("cardId"), ledger_rows(cid)),
   (6_000, cid, 1))
card(cid)["stage"] = "approved"  # as a second, raced execution would have found it
out = attempt(ops.execute_host_withdrawal, "w6b", cid, "UTR-6", OWNER)
ok("a COMPLETED card executed again is still refused, nothing debited (the existing contract)",
   isinstance(out, ops.PartnerOpsError) and "already paid" in str(out)
   and doc("users/w6").get("beansAvailable") == 6_000 and ledger_rows(cid) == 1, show(out))

# Review findings (independent review of the HT-2 diff).
from tests.firestore_contention import ServiceUnavailable  # noqa: E402

# R1 — the library hides a failed begin behind its own ValueError.
host("w7", 10_000)
cid = withdrawal("w7", 4_000)
fs.after_commit["w7"] = writes_only(once(always(lambda: Aborted("409 transaction no longer valid"))))
fs.on_begin["w7"] = lambda tx: (FIRED.append((tx.label, "begin")), (_ for _ in ()).throw(
    ServiceUnavailable("503 begin unavailable")))[0] if tx.attempt == 2 else None
out = attempt(ops.execute_host_withdrawal, "w7", cid, "UTR-7", OWNER)
fs.clear_hooks()
really("withdrawal, lost answer then a failed begin")
print(f"   lost answer, then the next begin fails → {show(out)}")
ok("a debit that landed, then a failed begin hidden behind the library's 'cannot be rolled back' "
   "ValueError: verified and executed — not 'nothing was paid'", not isinstance(out, Exception), show(out))
eq("…debited once, executed, one ledger row",
   (doc("users/w7").get("beansAvailable"), card(cid).get("stage"), ledger_rows(cid)), (6_000, "executed", 1))

# R2 — a card whose debit was not confirmed is claimed: it cannot be rejected.
host("w8", 10_000)
cid = withdrawal("w8", 4_000)
fs.on_commit["w8"] = deferring(lambda: DeadlineExceeded("504"))
out = attempt(ops.execute_host_withdrawal, "w8", cid, "UTR-8", OWNER)
fs.clear_hooks()
really("withdrawal, unknown, then a reject")
rej = attempt(cards_svc.reject, "w8r", cid, OWNER, "Looks wrong.")
ok("a card whose debit was not confirmed cannot be REJECTED (it could have landed)",
   isinstance(rej, Exception) and "cannot be rejected" in str(rej), show(rej))
eq("…it stays approved", card(cid).get("stage"), "approved")
fs.land_deferred()
attempt(ops.execute_host_withdrawal, "w8b", cid, "UTR-8", OWNER)
eq("…and executing it again finishes it with one debit",
   (doc("users/w8").get("beansAvailable"), card(cid).get("stage"), ledger_rows(cid)), (6_000, "executed", 1))

# R3 — the ledger already holds this card's withdrawal when a REAL debit reaches it
# (another execution of the card replayed and wrote the row first).
from app.services.money import Currency, HolderType, Movement, apply_movement  # noqa: E402

host("w9", 10_000)
cid = withdrawal("w9", 4_000)
run(apply_movement(Movement(
    holder_type=HolderType.USER, holder_id="w9", currency=Currency.BEANS, amount=-4_000,
    action=audit_mod.Action.WITHDRAWAL_PAY, reason="Paying out.", actor=OWNER, card_id=cid,
    idempotency_key=f"card:{cid}:withdrawal", allow_negative=True, replica_applied_by_caller=True,
    meta={"payment_ref": "UTR-9"})))
out = attempt(ops.execute_host_withdrawal, "w9", cid, "UTR-9", OWNER)
print(f"   ledger row already written by the other execution → {show(out)}")
ok("a real debit meeting this card's ledger row: refused as already executed, the card CLOSED — "
   "not failed with 'needs manual correction'", isinstance(out, ops.PartnerOpsError)
   and "has been closed" in str(out) and card(cid).get("stage") == "executed", show(out))
eq("…one debit, one ledger row", (doc("users/w9").get("beansAvailable"), ledger_rows(cid)), (6_000, 1))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Signed balance cards (warning deductions)")


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


_oid = iter(range(500, 10_000))


def deduction_card(uid: str, currency: str, amount: int) -> str:
    run(users_svc.warn_user(uid, "Second offence.", STAFF, request_id=f"req-{uid}",
                            deduction={"currency": currency, "amount": amount}))
    c = next(c for c in DB[C.CARDS].docs if (c.get("payload") or {}).get("uid") == uid)
    c["_id"] = f"{next(_oid):024x}"
    c["stage"] = "approved"
    return str(c["_id"])


user("d1", diamonds=100)
cid = deduction_card("d1", "diamonds", 30)
fs.after_commit["d1"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(users_svc.execute_balance_card, "d1", cid, SUPER)
fs.clear_hooks()
really("balance card, applied then deadline")
ok("a deduction applied but answered with a deadline is finished in the same call (it used to be a 500)",
   not isinstance(out, Exception), show(out))
eq("…taken once, card executed, one ledger row",
   (doc("users/d1").get("diamonds"), card(cid).get("stage"),
    sum(1 for r in DB[C.LEDGER].docs if r.get("idempotency_key") == cid)), (70, "executed", 1))

user("d2", diamonds=100)
cid = deduction_card("d2", "diamonds", 30)
fs.on_commit["d2"] = always(lambda: Aborted("409"))
out = attempt(users_svc.execute_balance_card, "d2", cid, SUPER)
fs.clear_hooks()
really("balance card, contended")
ok("a deduction Firestore kept aborting: a typed 409 saying to execute it again",
   LiveStepNotConfirmed is not None and isinstance(out, LiveStepNotConfirmed) and out.status_code == 409
   and "execute it again" in str(out), show(out))
eq("…nothing taken, the card still approved", (doc("users/d2").get("diamonds"), card(cid).get("stage")),
   (100, "approved"))
out = attempt(users_svc.execute_balance_card, "d2b", cid, SUPER)
eq("…executing again takes it once", (doc("users/d2").get("diamonds"), card(cid).get("stage")), (70, "executed"))

user("d3", isHost=True, agencyId="AG1", beansAvailable=1_000, beans=1_000)
cid = deduction_card("d3", "beans", 40)
fs.after_commit["d3"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(users_svc.execute_balance_card, "d3", cid, SUPER)
fs.clear_hooks()
really("beans card, applied then deadline")
eq("a beans deduction applied but answered with a deadline: taken once, executed",
   (doc("users/d3").get("beansAvailable"), card(cid).get("stage")), (960, "executed"))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Recharge refunds")

DB[C.PARTNERS].docs.append({"_id": "SELL", "kind": "seller", "name": "Coins R Us", "status": "approved",
                            "is_active": True, "owner_crm_uid": "u-seller", "total_coins_sold": 0})
DB[C.BALANCES].docs.append({"holder_type": "seller", "holder_id": "SELL", "currency": "coins", "amount": 10_000})
fs.collection("sellers").docs["SELL"] = {"displayName": "Coins R Us", "coinBalance": 10_000}
_ref = iter(range(1, 1000))


def refundable(buyer: str) -> str:
    fs.collection("users").docs[buyer] = {"name": buyer, "diamonds": 0}
    r = run(rc.submit_recharge(buyer, "SELL", diamonds=300, amount_minor=30000, currency="INR",
                               payment_method="upi", reference=f"UTR-R{next(_ref)}",
                               proof_url="https://x/p.jpg", actor=APP))
    run(rc.approve_recharge(r["id"], "UTR verified against the statement.", SUPER))
    # The live wallet the approval credited (the replica sync is a no-op in this file).
    fs.collection("users").docs[buyer]["diamonds"] = 300
    run(rc.request_refund(r["id"], "Buyer paid twice by mistake.", SUPER))
    return r["id"]


def rec(rid: str) -> dict:
    return next(d for d in DB[C.RECHARGES].docs if d["_id"] == rid)


rid = refundable("b1")
fs.after_commit["rf1"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(rc.decide_refund, "rf1", rid, True, "Duplicate payment confirmed.", SUPER)
fs.clear_hooks()
really("refund, applied then deadline")
ok("a refund clawback applied but answered with a deadline completes in the same call (it used to be a 500)",
   not isinstance(out, Exception), show(out))
eq("…refunded, 300 taken once", (rec(rid)["status"], doc("users/b1").get("diamonds")), ("refunded", 0))

rid = refundable("b2")
fs.on_commit["rf2"] = always(lambda: Aborted("409"))
out = attempt(rc.decide_refund, "rf2", rid, True, "Duplicate payment confirmed.", SUPER)
fs.clear_hooks()
really("refund, contended")
ok("a refund clawback Firestore kept aborting: a typed 409 saying to approve it again",
   RefundStepNotConfirmed is not None and isinstance(out, RefundStepNotConfirmed) and out.status_code == 409
   and "approve it again" in str(out), show(out))
eq("…nothing taken, back under review", (rec(rid)["status"], doc("users/b2").get("diamonds")),
   ("refund_pending", 300))
out = attempt(rc.decide_refund, "rf2b", rid, True, "Duplicate payment confirmed.", SUPER)
eq("…approving again takes it once", (rec(rid)["status"], doc("users/b2").get("diamonds")), ("refunded", 0))

# ══════════════════════════════════════════════════════════════════════════════
print("4. Official warnings")


def warnings(uid: str) -> dict:
    return fs.collection("users").document(uid).collection("warnings").docs


user("v1")
fs.after_commit["wn1"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(users_svc.warn_user, "wn1", "v1", "Spam in a public room.", STAFF, request_id="req-v1-1")
fs.clear_hooks()
really("warning, applied then deadline")
ok("a warning applied but answered with a deadline is finished (it used to be a 500)",
   not isinstance(out, Exception), show(out))
eq("…one warning, counted once, audited once",
   (len(warnings("v1")), doc("users/v1").get("warnings"),
    len([a for a in AUDIT if a.get("subject_id") == "v1" and a.get("action") == audit_mod.Action.USER_WARNED])),
   (1, 1, 1))

user("v2")
fs.on_commit["wn2"] = always(lambda: Aborted("409"))
out = attempt(users_svc.warn_user, "wn2", "v2", "Spam in a public room.", STAFF, request_id="req-v2-1")
fs.clear_hooks()
really("warning, contended")
ok("a warning Firestore kept aborting: a typed 409 saying to send the same request again",
   LiveStepNotConfirmed is not None and isinstance(out, LiveStepNotConfirmed) and out.status_code == 409
   and "same request again" in str(out), show(out))
eq("…no warning yet", len(warnings("v2")), 0)
out = attempt(users_svc.warn_user, "wn2b", "v2", "Spam in a public room.", STAFF, request_id="req-v2-1")
eq("…sending it again warns once", (len(warnings("v2")), doc("users/v2").get("warnings")), (1, 1))

# ══════════════════════════════════════════════════════════════════════════════
print("5. Host verification decisions")


def capture(uid: str) -> None:
    user(uid)
    fs.collection("hostVerification").docs[uid] = {"uid": uid, "status": "pending_manual", "hostName": uid}


def decided(uid: str) -> tuple:
    return (doc(f"hostVerification/{uid}").get("status"), doc(f"users/{uid}").get("isVerifiedHost"),
            len([a for a in AUDIT if a.get("subject_id") == uid
                 and a.get("action") == audit_mod.Action.HOST_VERIFICATION_APPROVED]),
            NOTICES.count(("verification", uid, True)))


capture("r1")
fs.after_commit["rv1"] = writes_only(once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(verification_svc.review, "rv1", "r1", "verified", "Same person in both photos.", STAFF)
fs.clear_hooks()
really("review, lost answer")
ok("a verification decision whose answer was lost is the decision (it used to be 'changed while you were "
   "reviewing', with no audit and no notice)", not isinstance(out, Exception), show(out))
eq("…verified, payable, audited once, told once", decided("r1"), ("verified", True, 1, 1))

capture("r2")
fs.after_commit["rv2"] = writes_only(once(always(lambda: DeadlineExceeded("504"))))
out = attempt(verification_svc.review, "rv2", "r2", "verified", "Same person in both photos.", STAFF)
fs.clear_hooks()
really("review, applied then deadline")
eq("a decision applied but answered with a deadline: verified, audited once, told once",
   decided("r2"), ("verified", True, 1, 1))

capture("r3")
fs.on_commit["rv3"] = always(lambda: Aborted("409"))
out = attempt(verification_svc.review, "rv3", "r3", "verified", "Same person in both photos.", STAFF)
fs.clear_hooks()
really("review, contended")
ok("a decision Firestore kept aborting: VerificationNotApplied, 409, saying to decide again",
   VerificationNotApplied is not None and isinstance(out, VerificationNotApplied) and out.status_code == 409
   and "Decide it again" in str(out), show(out))
eq("…still waiting, not payable, nothing audited", decided("r3"), ("pending_manual", None, 0, 0))
out = attempt(verification_svc.review, "rv3b", "r3", "verified", "Same person in both photos.", STAFF)
eq("…deciding again applies it once", decided("r3"), ("verified", True, 1, 1))

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} HT-2 money checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} HT-2 money checks passed.")
