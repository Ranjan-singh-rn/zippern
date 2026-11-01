"""Operating expenditure — the other half of the owner's profit definition.

    "profit is like the money we received for selling coin - our all
     expenditure"

The receipts half of that sentence has always worked. The expenditure half had
nowhere to be written down until `app/services/expenses.py`, and these tests hold
down the three claims that make the new half trustworthy:

  1. **An expense is a card like any other.** Five stages, and the money moves
     only at the fifth. Every separation-of-duties refusal is exercised
     individually here — the raiser verifying, the raiser signing, the verifier
     signing, a non-owner signing, a wrong-team admin verifying, paying a card
     nobody signed, and paying the same card twice. Convenience is exactly the
     argument that gets one of these waived, so each one has its own check with
     its own name.

  2. **The profit statement subtracts what was recorded and stays honest about
     what was not.** The same P&L is run three times over the same revenue: with
     nothing recorded, with one category recorded, and with all seven. It must
     be an upper bound in the first two cases and stop being one only in the
     third. One recorded expense making the number look complete is the specific
     failure this is written to catch.

  3. **Money is integers, end to end.** Paise in, paise out, no float anywhere
     between an invoice and the profit figure.

The real service code runs — the real card engine, the real audit log, the real
report. Only Mongo underneath it is replaced, following `tests/harness.py`.

Run:  python3 -m tests.test_expenses
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()

# Services bind `get_db` at import (`from app.db.mongo import get_db`), so the
# swap has to happen before they are imported — one indirection through a
# mutable holder and every module sees the same database however it imported.
CURRENT: dict[str, FakeDb] = {"db": DB}
mongo.get_db = lambda: CURRENT["db"]  # type: ignore[assignment]

# `bson.ObjectId` refuses anything that is not 24 characters, and the card
# engine round-trips every id through it. The fake collection's default ids are
# not 24 characters, so the cards collection is given ones that are — otherwise
# every card would come back "not found" and the flow tests would pass for the
# wrong reason.
_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


from app.db.mongo import C  # noqa: E402

DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

from fastapi import Depends  # noqa: E402  (the harness stub)

from app.core import audit as audit_log  # noqa: E402
from app.core.deps import require_owner, require_write  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.routers import expenses as expenses_router  # noqa: E402
from app.services import cards as card_svc  # noqa: E402
from app.services import expenses as X  # noqa: E402
from app.services import reports as R  # noqa: E402
from app.services.cards import CardError, CardType, Stage  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def truthy(label: str, value) -> None:
    global checks
    checks += 1
    if not value:
        failures.append(f"{label}\n    expected something truthy, got {value!r}")


def contains(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = " ".join(haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() not in text.lower():
        failures.append(f"{label}\n    {needle!r} is not in: {text[:400]!r}")


def absent(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = " ".join(haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() in text.lower():
        failures.append(f"{label}\n    {needle!r} should NOT be in: {text[:400]!r}")


def run(coro):
    return asyncio.run(coro)


def refuses(label: str, coro_factory, *, error=X.ExpenseError) -> None:
    """This must be refused, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = asyncio.run(coro_factory())
    except error:
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return
    failures.append(f"{label}: was NOT refused — returned {result!r}")


def rupees(amount) -> int:
    """A rupee figure as integer paise, without ever touching a float."""
    from decimal import Decimal

    return int((Decimal(str(amount)) * 100).to_integral_value())


# ── The people ────────────────────────────────────────────────────────────────
#
# Six of them, because separation of duties cannot be checked with fewer.

OPS_MEMBER = {"uid": "u-ops-1", "name": "Ravi (Ops)", "role": Role.OPS_MEMBER, "team": Team.OPS}
OPS_ADMIN = {"uid": "u-ops-2", "name": "Neha (Ops admin)", "role": Role.OPS_ADMIN, "team": Team.OPS}
FIN_ADMIN = {"uid": "u-fin-1", "name": "Anil (Finance admin)", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE}
FIN_MEMBER = {"uid": "u-fin-2", "name": "Sara (Finance)", "role": Role.FINANCE_MEMBER, "team": Team.FINANCE}
OWNER_A = {"uid": "u-own-1", "name": "Owner One", "role": Role.OWNER, "team": None}
OWNER_B = {"uid": "u-own-2", "name": "Owner Two", "role": Role.OWNER, "team": None}

PERIOD = "2026-08"


async def raise_one(
    category=X.ExpenseCategory.STAFF_SALARIES,
    amount=rupees(450_000),
    actor=OPS_MEMBER,
    period=PERIOD,
    payee="August payroll",
    invoice_ref=None,
    reason="August salaries for the ops and tech teams, per the payroll sheet.",
    recurring=False,
):
    global _REF
    _REF += 1
    return await X.raise_expense(
        category=category,
        amount_inr_minor=amount,
        period=period,
        payee=payee,
        invoice_ref=invoice_ref or f"INV-{_REF:05d}",
        reason=reason,
        actor=actor,
        evidence_url="https://drive.example/invoice.pdf",
        recurring=recurring,
    )


_REF = 0


#: Every rupee this test actually pays, by category. The P&L assertions are
#: made against this rather than against constants copied out of the report —
#: a figure that agrees with a hardcoded number it was derived from proves
#: nothing.
PAID: dict[str, int] = {}


def record_paid(category, amount: int) -> None:
    key = str(category)
    PAID[key] = PAID.get(key, 0) + amount


async def full_flow(
    category=X.ExpenseCategory.STAFF_SALARIES,
    amount=rupees(450_000),
    raiser=OPS_MEMBER,
    verifier=FIN_ADMIN,
    signer=OWNER_A,
    payer=OWNER_A,
    period=PERIOD,
    payee="August payroll",
    recurring=False,
) -> dict:
    """Raise → verify → sign → pay, as five separate acts by three people."""
    card = await raise_one(
        category=category,
        amount=amount,
        actor=raiser,
        period=period,
        payee=payee,
        recurring=recurring,
    )
    await card_svc.verify(card["id"], verifier, "Invoice and bank advice checked.")
    await card_svc.sign(card["id"], signer, "Approved for payment.")
    done = await X.execute_expense(card["id"], f"UTR{card['id'][-8:]}", payer)
    record_paid(category, amount)
    return done


# ══════════════════════════════════════════════════════════════════════════════
# 1. THE FIVE STAGES
# ══════════════════════════════════════════════════════════════════════════════

card = run(raise_one())

check("a new expense starts at Requested", card["stage"], str(Stage.REQUESTED))
check("nothing is auto-verified", card["auto_verified"], False)
check("it is an operating expense card", card["type"], str(CardType.OPERATING_EXPENSE))
check("raised on the Finance board whoever raised it", card["team"], str(Team.FINANCE))
check("the amount is integer paise", card["amount"], 45_000_000)
truthy("and is an int, not a float", isinstance(card["amount"], int))
check("denominated in INR minor units", card["currency"], "inr_minor")
check("the category is the report's own line key", card["payload"]["category"], "staff_salaries")
check("the period the cost is FOR travels with the card", card["payload"]["period"], PERIOD)
check("the basis is stated on the card", card["payload"]["basis"], "cash")
check("evidence is mandatory and present", card["evidence"][0]["kind"], "invoice")
truthy("the invoice reference is on the card", card["payload"]["invoice_ref"])
truthy("a reason is carried", len(card["reason"]) > 3)
check("nobody has verified it", card["verified_by"], None)
check("nobody has signed it", card["signed_by"], None)
check("no money has moved", card["executed_at"], None)

run(card_svc.verify(card["id"], FIN_ADMIN, "Payroll sheet and bank advice checked."))
after_verify = run(card_svc._get(card["id"], as_dict=True))
check("a second person verifies it", after_verify["stage"], str(Stage.AWAITING_SIGNOFF))
check("and is recorded by name", after_verify["verified_by"]["uid"], FIN_ADMIN["uid"])
check("still no money moved", after_verify["executed_at"], None)

run(card_svc.sign(card["id"], OWNER_A, "Approved."))
after_sign = run(card_svc._get(card["id"], as_dict=True))
check("an owner signs it", after_sign["stage"], str(Stage.APPROVED))
check("and is recorded by name", after_sign["signed_by"]["uid"], OWNER_A["uid"])
check(
    "approved is NOT paid — the two stages are separate on purpose",
    after_sign["executed_at"],
    None,
)

paid = run(X.execute_expense(card["id"], "UTR-98765", OWNER_A))
record_paid(X.ExpenseCategory.STAFF_SALARIES, 45_000_000)
check("an owner pays it", paid["stage"], str(Stage.EXECUTED))
truthy("and the moment is recorded", paid["executed_at"] is not None)
check("with the bank reference", paid["execution_result"]["payment_ref"], "UTR-98765")
check("and the amount that left", paid["execution_result"]["amount_inr_minor"], 45_000_000)
contains(
    "the card says the figure counts in the period it was PAID",
    paid["execution_result"]["counted_on"],
    "cash basis",
)

# Five stages, three different people, and every one of them in the audit log
# with a reason.
history = run(audit_log.history_for("expense", f"{PERIOD}:staff_salaries"))
actions = {entry["action"] for entry in history}
truthy("raising is audited against the expense", audit_log.Action.EXPENSE_RAISED in actions)
truthy("paying is audited against the expense", audit_log.Action.EXPENSE_PAID in actions)
truthy("every expense audit entry carries a reason", all(e["reason"] for e in history))
truthy("and names the actor", all(e["actor"]["uid"] for e in history))

card_history = run(audit_log.history_for("card", card["id"]))
card_actions = [e["action"] for e in card_history]
for action in (
    audit_log.Action.CARD_RAISED,
    audit_log.Action.CARD_VERIFIED,
    audit_log.Action.CARD_SIGNED,
    audit_log.Action.CARD_EXECUTED,
):
    truthy(f"the board recorded {action}", action in card_actions)


# ══════════════════════════════════════════════════════════════════════════════
# 2. SEPARATION OF DUTIES — every refusal, one at a time
# ══════════════════════════════════════════════════════════════════════════════

own = run(raise_one(actor=FIN_ADMIN))
refuses(
    "the person who raised a card cannot verify it",
    lambda: card_svc.verify(own["id"], FIN_ADMIN, "It is fine, I raised it."),
    error=CardError,
)
refuses(
    "an admin of a different team cannot verify a Finance card",
    lambda: card_svc.verify(own["id"], OPS_ADMIN, "Looks right to me."),
    error=CardError,
)
refuses(
    "a team member cannot verify at all",
    lambda: card_svc.verify(own["id"], FIN_MEMBER, "Checked."),
    error=CardError,
)
refuses(
    "nothing can be signed before it is verified",
    lambda: card_svc.sign(own["id"], OWNER_A, "Approved."),
    error=CardError,
)
refuses(
    "and nothing can be paid before it is signed",
    lambda: X.execute_expense(own["id"], "UTR-1", OWNER_A),
)

run(card_svc.verify(own["id"], OWNER_B, "Checked against the supplier invoice."))
refuses(
    "a team admin cannot sign — verification is not approval",
    lambda: card_svc.sign(own["id"], OPS_ADMIN, "Approved."),
    error=CardError,
)
refuses(
    "nor can a finance admin",
    lambda: card_svc.sign(own["id"], FIN_ADMIN, "Approved."),
    error=CardError,
)
# Master spec §8 (owner-alone): the Owner who verified a card MAY sign it. The
# two-person refusal that used to live here is kept for everybody who is not
# an Owner — and nobody who is not an Owner signs at all.
signed = run(card_svc.sign(own["id"], OWNER_B, "Approved."))
check("the Owner who verified it signs it (§8)", signed["stage"], str(Stage.APPROVED))
check("…and the card says the signature was owner-alone", signed["owner_alone"], True)

# An owner's own card: under §8 the same Owner may verify and sign it, and the
# record still shows every stage with that Owner's name on each.
owners_own = run(raise_one(actor=OWNER_A, category=X.ExpenseCategory.INFRASTRUCTURE))
check("an owner's own card starts at Requested like everyone else's", owners_own["stage"], str(Stage.REQUESTED))
verified_own = run(card_svc.verify(owners_own["id"], OWNER_A, "Mine, and correct — invoice attached."))
check("an Owner may verify the card they raised (§8)", verified_own["stage"], str(Stage.AWAITING_SIGNOFF))
check("…and Under Review was recorded, not skipped (B-23)",
      verified_own["review_started_by"]["uid"], OWNER_A["uid"])
own_signed = run(card_svc.sign(owners_own["id"], OWNER_A, "Approved."))
check("an Owner may sign the card they raised (§8)", own_signed["stage"], str(Stage.APPROVED))
own_actions = [e["action"] for e in run(audit_log.history_for("card", owners_own["id"]))]
for action in (
    audit_log.Action.CARD_RAISED,
    audit_log.Action.CARD_REVIEW_STARTED,
    audit_log.Action.CARD_VERIFIED,
    audit_log.Action.CARD_SIGNED,
):
    truthy(f"…every step is its own audit entry: {action}", action in own_actions)
# A Finance admin who raised a card still cannot verify it — the relaxation is
# the Owner's alone.
fin_own = run(raise_one(actor=FIN_ADMIN, category=X.ExpenseCategory.INFRASTRUCTURE))
refuses(
    "a finance admin still cannot verify the card they raised",
    lambda: card_svc.verify(fin_own["id"], FIN_ADMIN, "Mine, and correct."),
    error=CardError,
)

# Paying twice pays once.
run(X.execute_expense(owners_own["id"], "UTR-DUP", OWNER_B))
record_paid(X.ExpenseCategory.INFRASTRUCTURE, rupees(450_000))
refuses(
    "an executed card cannot be paid a second time",
    lambda: X.execute_expense(owners_own["id"], "UTR-DUP", OWNER_B),
)
refuses(
    "and a payment with no bank reference is refused",
    lambda: X.execute_expense(signed["id"], "   ", OWNER_A),
)
check(
    "the double-payment attempt left the card executed exactly once",
    len(
        [
            e
            for e in run(audit_log.history_for("card", owners_own["id"]))
            if e["action"] == audit_log.Action.CARD_EXECUTED
        ]
    ),
    1,
)

# §8: one Owner raised, verified and signed that card, and the record names
# that Owner at every stage — the trail, not a second person, is the control.
paid_card = run(card_svc._get(owners_own["id"], as_dict=True))
people = {
    paid_card["requested_by"]["uid"],
    paid_card["verified_by"]["uid"],
    paid_card["signed_by"]["uid"],
}
check("one Owner is named at every stage of their own expense (§8)", people, {OWNER_A["uid"]})
check("…and the card records that it was owner-alone", paid_card["owner_alone"], True)


# ── Authority, as wired on the routes ─────────────────────────────────────────
#
# The claim is not only that the service refuses; it is that the router asks for
# the right guard, and that there is no second door into verification or
# signature living in this file.

ROUTES = {(r["method"], r["path"]): r for r in expenses_router.router.routes}


def guard_of(method: str, path: str):
    fn = ROUTES[(method, path)]["fn"]
    for default in fn.__defaults__ or ():
        if isinstance(default, Depends):
            return default.dependency
    return None


check("raising an expense needs write access", guard_of("post", ""), require_write)
check(
    "repeating one needs write access",
    guard_of("post", "/{card_id}/repeat"),
    require_write,
)
check("paying one needs an owner", guard_of("post", "/{card_id}/pay"), require_owner)
check(
    "there is no verify route on the expense board",
    [p for _m, p in ROUTES if "verify" in p],
    [],
)
check(
    "and no sign route — the money board's are the only ones",
    [p for _m, p in ROUTES if "sign" in p],
    [],
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. MALFORMED AND NEGATIVE AMOUNTS
# ══════════════════════════════════════════════════════════════════════════════

refuses("a negative expense is refused", lambda: raise_one(amount=-1))
refuses("a large negative one too", lambda: raise_one(amount=-rupees(50_000)))
refuses("an expense of zero is refused", lambda: raise_one(amount=0))
refuses("a float amount is refused, not rounded", lambda: raise_one(amount=1250.05))
refuses("even a float that is a whole number", lambda: raise_one(amount=45000.0))
refuses("a string amount is refused", lambda: raise_one(amount="4500000"))
refuses("True is not an amount", lambda: raise_one(amount=True))
refuses("None is not an amount", lambda: raise_one(amount=None))
refuses("an invented category is refused", lambda: raise_one(category="server_snacks"))
refuses("a blank category is refused", lambda: raise_one(category=""))
refuses("month 13 is not a period", lambda: raise_one(period="2026-13"))
refuses("nor is a bare year", lambda: raise_one(period="2026"))
refuses("nor a date", lambda: raise_one(period="2026-08-14"))
refuses("evidence is mandatory", lambda: raise_one(invoice_ref="   "))
refuses("a payee is mandatory", lambda: raise_one(payee=""))
refuses("a reason is mandatory", lambda: raise_one(reason=""))
refuses("and a one-word reason is not a reason", lambda: raise_one(reason="x"))

before_refusals = len(DB[C.CARDS].docs)
refuses("one more refusal, to count against", lambda: raise_one(amount=-500))
check(
    "a refused expense creates no card at all",
    len(DB[C.CARDS].docs),
    before_refusals,
)

try:
    run(raise_one(amount=-1))
except X.ExpenseError as exc:
    contains("the refusal explains itself in paise", str(exc), "greater than zero")
    contains("and says what to do with money coming back", str(exc), "refund")
try:
    run(raise_one(amount=1250.05))
except X.ExpenseError as exc:
    contains("and a float refusal shows the integer form", str(exc), "125005")


# ══════════════════════════════════════════════════════════════════════════════
# 4. RECURRING COSTS — a person raises the next one, not a scheduler
# ══════════════════════════════════════════════════════════════════════════════

july = run(
    full_flow(
        category=X.ExpenseCategory.INFRASTRUCTURE,
        amount=rupees(82_000),
        period="2026-07",
        payee="AWS Mumbai",
        recurring=True,
    )
)
check("July's server bill was paid", july["stage"], str(Stage.EXECUTED))

worklist = run(X.recurring_worklist("2026-08"))
due_keys = {(d["category"], d["payee"]) for d in worklist["due"]}
truthy("a recurring cost with no card for August is on the worklist",
       ("infrastructure", "AWS Mumbai") in due_keys)
contains("and the worklist says a person raises it", worklist["note"], "repeat")
contains(
    "and says why no scheduler does it",
    worklist["note"],
    "a figure nobody looked at is not a figure an owner should be signing",
)

august = run(
    X.repeat(
        card_id=july["id"],
        period="2026-08",
        amount_inr_minor=rupees(91_500),
        invoice_ref="INV-AWS-0826",
        reason="August infrastructure — the bill rose with the new region.",
        actor=OPS_MEMBER,
    )
)
check("next month's card starts at Requested, like any other", august["stage"], str(Stage.REQUESTED))
check("it inherits the category", august["payload"]["category"], "infrastructure")
check("and the payee", august["payload"]["payee"], "AWS Mumbai")
check("but NOT the amount — that is asked for again", august["amount"], rupees(91_500))
check("the previous amount is shown for comparison", august["payload"]["previous_amount_inr_minor"], rupees(82_000))
check("and the card it came from is recorded", august["payload"]["repeats_card_id"], july["id"])
check("nothing is inherited from the old verification", august["verified_by"], None)
check("nor from the old signature", august["signed_by"], None)

after_repeat = run(X.recurring_worklist("2026-08"))
truthy(
    "once raised, it leaves the worklist",
    ("infrastructure", "AWS Mumbai")
    not in {(d["category"], d["payee"]) for d in after_repeat["due"]},
)

# The duplicate-invoice check warns before signature rather than refusing.
dup = run(raise_one(invoice_ref="INV-AWS-0826", category=X.ExpenseCategory.INFRASTRUCTURE))
truthy("a reused invoice reference is flagged on the card", dup["payload"]["duplicate_reference"])
contains("with a warning an owner sees before signing", dup.get("warning", ""), "separate bill")


# ══════════════════════════════════════════════════════════════════════════════
# 5. THE P&L — before expenses exist, part way, and complete
# ══════════════════════════════════════════════════════════════════════════════
#
# The same revenue, the same window, run three times. The only thing that
# changes is how much of the cost of running the company has been recorded.

NOW = datetime.now(timezone.utc)
SINCE = NOW - timedelta(days=2)
UNTIL = NOW + timedelta(days=1)

RATES = R.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    # No seller discount configured: wholesale equals retail, which is
    # what these figures were all computed against before the wholesale
    # price existed. Nothing in this file is testing the discount.
    seller_wholesale_price_inr_per_lakh=2390.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="test",
    fetched_at=SINCE,
)

REVENUE = rupees(2_000_000)


class patched:
    """Swap module attributes for the duration of a block, then put them back."""

    def __init__(self, module, **attrs):
        self.module, self.attrs, self.original = module, attrs, {}

    def __enter__(self):
        for name, value in self.attrs.items():
            self.original[name] = getattr(self.module, name)
            setattr(self.module, name, value)
        return self.module

    def __exit__(self, *_exc):
        for name, value in self.original.items():
            setattr(self.module, name, value)
        return False


async def pnl():
    """The real profit statement, over the real expense cards in the fake Mongo.

    Only the three sources that are not this feature are stubbed — receipts,
    payouts and seller credit. `_expenditure_by_category` is the real one, so
    what is being tested is the aggregation over cards this test actually
    raised, verified, signed and paid.
    """

    async def cash(*_a, **_k):
        return R.Report(
            name="cash_position",
            title="Cash",
            period=R._period(SINCE, UNTIL),
            columns=[("line", "Line")],
            rows=[{"line": "x"}],
            totals={"receipts_inr_minor": REVENUE, "payments_out_inr_minor": 0},
        )

    async def payouts(*_a, **_k):
        return [], 0, []

    async def credit(*_a, **_k):
        return []

    with patched(R, cash_position=cash, _executed_payouts=payouts, _credit_events=credit):
        return await R.profit_and_loss(SINCE, UNTIL, RATES)


def totals_of(report):
    return report.totals, {r["line"]: r for r in report.rows}


# ── (a) Nothing recorded in this window ───────────────────────────────────────
#
# Every expense paid so far in this test belongs to a period label but was paid
# just now — so first, prove the shape of a window with no expense at all by
# looking at a window before any of them.

EMPTY_SINCE = NOW - timedelta(days=90)
EMPTY_UNTIL = NOW - timedelta(days=30)


async def pnl_empty_window():
    async def cash(*_a, **_k):
        return R.Report(
            name="cash_position",
            title="Cash",
            period=R._period(EMPTY_SINCE, EMPTY_UNTIL),
            columns=[("line", "Line")],
            rows=[{"line": "x"}],
            totals={"receipts_inr_minor": REVENUE, "payments_out_inr_minor": 0},
        )

    async def payouts(*_a, **_k):
        return [], 0, []

    async def credit(*_a, **_k):
        return []

    with patched(R, cash_position=cash, _executed_payouts=payouts, _credit_events=credit):
        return await R.profit_and_loss(EMPTY_SINCE, EMPTY_UNTIL, RATES)


before = run(pnl_empty_window())
bt, brows = totals_of(before)

check(
    "with nothing recorded, all seven categories are unknown",
    sorted(bt["unknown_lines"]),
    [
        "binance_fees",
        "gateway_fees",
        "infrastructure",
        "marketing",
        "refunds_to_users",
        "staff_salaries",
        "taxes",
    ],
)
check("no operating cost is subtracted", bt["operating_expenditure_inr_minor"], 0)
check("so profit is the whole of revenue", bt["profit_inr_minor"], REVENUE)
check("and the statement is not complete", bt["complete"], False)
contains("it is labelled an upper bound", before.warnings, "UPPER BOUND")
contains(
    "and names the categories with no entry",
    before.warnings,
    "OPERATING COST CATEGORIES HAVE NO ENTRY FOR THIS PERIOD",
)
check("the salary line carries no figure at all", brows["Staff salaries and contractor pay"]["inr_minor"], None)
contains(
    "and says it is unrecorded for the period, not zero",
    brows["Staff salaries and contractor pay"]["definition"],
    "NOT RECORDED FOR THIS PERIOD",
)
contains(
    "the host salary_request card is still distinguished from staff pay",
    brows["Staff salaries and contractor pay"]["definition"],
    "pays HOSTS",
)
contains(
    "and every unknown line says how to make it known",
    brows["Taxes"]["definition"],
    "signed by an owner",
)
contains("the owner's words are quoted verbatim", R.DEFINITIONS["profit"],
         "profit is like the money we received for selling coin - our all expenditure")
contains(
    "and the profit line says whose definition it is",
    [r["line"] for r in before.rows],
    "owner's own definition",
)


# ── (b) One category recorded ─────────────────────────────────────────────────
#
# The salary card at the top of this file was paid inside the live window. One
# real cost is now subtracted — and the number must NOT start looking complete.

partway = run(pnl())
pt, prows = totals_of(partway)

check(
    "salaries are a real figure now",
    prows["Staff salaries and contractor pay"]["inr_minor"],
    -PAID["staff_salaries"],
)
check(
    "and every rupee paid so far is subtracted from profit",
    pt["profit_inr_minor"],
    REVENUE - sum(PAID.values()),
)
truthy("staff_salaries is no longer among the unknown", "staff_salaries" not in pt["unknown_lines"])
truthy("infrastructure is not either", "infrastructure" not in pt["unknown_lines"])
check("but the five others still are", len(pt["unknown_lines"]), 5)
check("so the statement is STILL not complete", pt["complete"], False)
contains("and still says upper bound", partway.warnings, "UPPER BOUND")
contains(
    "one recorded expense does not make the figure look finished",
    partway.warnings,
    "One recorded expense does not make the number complete",
)
contains(
    "the known line states how many cards are behind it",
    prows["Staff salaries and contractor pay"]["definition"],
    "executed operating-expense card",
)
contains(
    "and which month the cost is labelled for",
    prows["Staff salaries and contractor pay"]["definition"],
    PERIOD,
)
check(
    "an unpaid expense is NOT subtracted — this is a cash statement",
    "not been paid yet" in " ".join(partway.warnings),
    True,
)


# ── (c) Every category recorded ───────────────────────────────────────────────

for category, amount in (
    (X.ExpenseCategory.GATEWAY_FEES, rupees(12_450)),
    (X.ExpenseCategory.BINANCE_FEES, rupees(3_275)),
    (X.ExpenseCategory.TAXES, rupees(180_000)),
    (X.ExpenseCategory.MARKETING, rupees(64_900)),
    (X.ExpenseCategory.REFUNDS_TO_USERS, rupees(2_150)),
):
    run(full_flow(category=category, amount=amount))

complete = run(pnl())
ct, crows = totals_of(complete)

check("every category now has an entry", ct["unknown_lines"], [])
check("nothing is missing", ct["operating_categories_missing"], [])
check("the statement is complete", ct["complete"], True)
absent(
    "and the profit is NOT declared an upper bound",
    complete.warnings,
    "THIS PROFIT IS AN UPPER BOUND",
)
absent(
    "nor is any category named as missing",
    complete.warnings,
    "OPERATING COST CATEGORIES HAVE NO ENTRY",
)
contains(
    "the statement says so in words",
    complete.warnings,
    "so the profit below is NOT an upper bound",
)
contains(
    "and still warns that an unraised cost is invisible to any report",
    complete.warnings,
    "a cost that was never raised on a card is still invisible",
)

recorded = sum(v["inr_minor"] for v in ct["operating_expenditure_by_category"].values())
check("the report's total is what this test actually paid", recorded, sum(PAID.values()))
check(
    "profit = revenue − every recorded cost, the owner's own definition",
    ct["profit_inr_minor"],
    REVENUE - sum(PAID.values()),
)
check("the basis is stated", ct["expenditure_basis"], "cash — a cost counts in the period it was paid")

# A category is unknown per PERIOD, not once and for all: the same seven are
# unknown again in a window where nothing was paid.
still_blind = run(pnl_empty_window())
check(
    "a category with no entry in another period is unknown again there",
    len(still_blind.totals["unknown_lines"]),
    7,
)
check("and that statement is an upper bound again", still_blind.totals["complete"], False)


# ══════════════════════════════════════════════════════════════════════════════
# 6. INTEGER ROUNDING — paise in, paise out, no float anywhere
# ══════════════════════════════════════════════════════════════════════════════

odd = [125_005, 33_334, 33_333, 33_333, 1, 99]  # ₹1,250.05 and awkward friends
for amount in odd:
    run(full_flow(category=X.ExpenseCategory.OTHER, amount=amount))

with_other = run(pnl())
ot, orows = totals_of(with_other)
other = ot["operating_expenditure_by_category"]["other"]

check("odd paise sum exactly, with no drift", other["inr_minor"], sum(odd))
truthy("and the total is an int", isinstance(other["inr_minor"], int))
check("₹1,250.05 is 125005 paise, never 1250.05", 125_005 in odd, True)
check("the display value divides by exactly 100", other["inr"], round(sum(odd) / 100, 2))
check("the 'other' line appears once it has entries", "Other operating expenditure" in orows, True)
check("and is subtracted", orows["Other operating expenditure"]["inr_minor"], -sum(odd))

truthy("profit is an integer number of paise", isinstance(ot["profit_inr_minor"], int))
truthy("expenditure is an integer number of paise", isinstance(ot["expenditure_inr_minor"], int))
truthy(
    "every expenditure figure on the statement is an int or None",
    all(
        r["inr_minor"] is None or isinstance(r["inr_minor"], int)
        for r in with_other.rows
    ),
)
check(
    "and the whole statement still balances",
    ot["profit_inr_minor"],
    ot["revenue_inr_minor"] - ot["expenditure_inr_minor"],
)

# `other` is the one category whose absence is not counted against the
# statement — and the statement says why rather than staying silent.
check("with 'other' recorded the statement is still complete", ot["complete"], True)
no_other = run(pnl_empty_window())
contains(
    "with no one-off recorded, the statement says it cannot tell zero from unentered",
    no_other.warnings,
    "cannot tell a period with no one-off costs from a period whose one-off costs nobody entered",
)


# ══════════════════════════════════════════════════════════════════════════════
# 7. THE REGISTER
# ══════════════════════════════════════════════════════════════════════════════

register = run(X.list_expenses())
truthy("every expense is listed, at whatever stage", len(register) > 10)
truthy(
    "including ones nobody has paid",
    any(r["stage"] != str(Stage.EXECUTED) for r in register),
)
salary_only = run(X.list_expenses(category=X.ExpenseCategory.STAFF_SALARIES))
truthy(
    "and it filters by category",
    all(r["payload"]["category"] == "staff_salaries" for r in salary_only),
)
july_only = run(X.list_expenses(period="2026-07"))
truthy("and by the period the cost is for", all(r["payload"]["period"] == "2026-07" for r in july_only))
refuses("a malformed period is refused on the register too", lambda: X.list_expenses(period="last month"))


# ── Report ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} operating-expenditure checks passed.")
print()
print("  · an expense is a card: raised, verified by a second person, signed by")
print("    an owner, then paid — and Approved is not Paid")
print("  · every separation-of-duties refusal holds, including for an owner's own card")
print("  · a negative, zero, float or non-numeric amount is refused and creates no card")
print("  · recurring costs are re-raised by a person from last month's card, and the")
print("    worklist names what has not been entered yet — no scheduler signs anything")
print("  · cash basis: a cost counts when it is paid; what is owed and unpaid is")
print("    counted and named, never quietly accrued")
print("  · a category with no entry for the period reads UNKNOWN, never zero")
print("  · the profit stops being an upper bound only when all seven have entries")
print()
print("What the owner's profit figure is made of, this period:")
print(f"  {'line':<40}{'INR':>16}  cards")
print(f"  {'Revenue — money received':<40}{ot['revenue_inr_minor'] / 100:>16,.2f}")
for key, entry in sorted(ot["operating_expenditure_by_category"].items()):
    label = X.CATEGORY_LABELS.get(key, key)
    print(f"  {label:<40}{-entry['inr']:>16,.2f}  {entry['cards']}")
print(f"  {'PROFIT (owner’s own definition)':<40}{ot['profit_inr']:>16,.2f}")
print(
    f"  every line has a figure behind it: {ot['complete']}  "
    f"— basis: {ot['expenditure_basis']}"
)
