"""Operating expenditure — the cost of running the company.

The owner defines profit as *"the money we received for selling coin − our all
expenditure"*. Until this module existed the second half of that sentence had
nowhere to be written down: there was no card type, no collection and no ledger
action for a salary, a server bill or a gateway fee. So every "profit" this
business produced was gross contribution *before* the cost of running the
company, and `reports.profit_and_loss` said exactly that on its own face.

This is the missing half.

An expense is money leaving the company, so it goes on the **same money board as
everything else** (Part 5): raised by one person, verified by a second, signed by
an owner, then executed.

    Requested → Under Review → Awaiting Sign-off → Approved → Executed

Verification and signature are the board's own endpoints — `/cards/{id}/verify`
and `/cards/{id}/sign` — and are deliberately **not** re-implemented here. There
is one implementation of separation of duties, in `app/services/cards.py`, and an
expense cannot drift away from it or quietly acquire an exception. Nothing in
this module can move a card past a stage; it raises one at the front and records
the payment at the back.

Four decisions are recorded here, because they are the ones a reader will ask
about.

**One card type, eight categories.** `CardType.OPERATING_EXPENSE` carries the
category in `payload.category`, and the category values *are* the line keys of
the profit statement — `staff_salaries`, `infrastructure`, `marketing`,
`gateway_fees`, `binance_fees`, `taxes`, `refunds_to_users`, plus `other`. The
report groups by that field and subtracts, with no mapping table in between,
because a mapping table is a place where a category can be added on one side and
forgotten on the other — and a forgotten category is money that silently leaves
the profit figure.

**Cash, not accrual.** An expense counts in the period the money *left*
(`executed_at`), exactly as revenue counts in the period the money arrived. The
owner reads a cash statement and asked for a cash statement, and introducing
accruals underneath a figure he reads as cash would change what the number means
without telling him. The card still carries `period` — the month the cost is
*for* — because "July's salaries, paid on 5 August" is a real and useful
distinction; but that field is a **label on the card**, not a second set of
books. It is shown on the statement so a payment landing outside its own month is
visible, and it never moves a rupee between periods. An expense that is owed and
not yet paid is therefore not on the statement at all — so the statement counts
those cards and says how many there are, rather than letting them be invisible.

**Recurring costs are re-raised by a person.** Salaries and servers repeat every
month, and the obvious answer — a template with a scheduler behind it — is the
wrong one here. A stored amount goes stale, and an unattended job that raises a
money card every month is a machine putting a figure in front of an owner who is
inclined to sign what the machine produced. Instead `repeat(...)` copies a
previous card's category, payee and recurrence marker into a **new Requested
card** that still needs a fresh amount, a fresh invoice reference and a fresh
reason — one action for the person raising it, and all five stages intact.
`recurring_worklist(period)` lists every recurring cost that has no card for a
given month, so "what have we not entered yet" is a question with an answer
rather than something an owner has to remember. That worklist plus the profit
statement's own missing-category warning is the reminder; no scheduler is needed
to make it work, and none is built.

**No ledger movement.** Every other money path in this system ends in
`money.apply_movement`, and this one does not. That is not an oversight. A
movement debits a *holder's balance*, and the holders this business tracks are
users, sellers and agencies holding diamonds, beans, coins and commission — an
electricity bill debits a bank account that is not modelled here at all.
Inventing a synthetic "house" holder to debit would create a balance nobody
funds, that no reconciliation could check against anything, and that could be
driven negative by a report. The record of an expense is therefore the card, its
evidence, its payment reference and its audit trail — the same choice the seller
credit repayment and write-off paths already make deliberately. What the ledger
guarantees for a movement, the board guarantees here: two people before an owner
signs, one owner to execute, an immutable audit entry with a mandatory reason at
both ends, and a stage machine that refuses to pay the same card twice.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from bson import ObjectId

from app.core import audit
from app.core.compat import StrEnum
from app.core.roles import Team
from app.db.mongo import C, get_db
from app.services import cards as card_svc
from app.services.cards import CardError, CardType, NewCard, Stage

log = logging.getLogger(__name__)

MIN_REASON = 3

#: Every expense is denominated in INR **minor units** (paise), as an integer.
#: `reports.to_inr_minor` maps this currency 1:1, so an expense reaches the
#: profit statement without a conversion, without a rate and without a float.
CURRENCY = "inr_minor"

#: The month a cost belongs to, e.g. `2026-08`. A label, not a second ledger —
#: see the module docstring on cash versus accrual.
PERIOD_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class ExpenseError(Exception):
    """Refused by an expenditure rule. The message is safe to show the caller."""


class ExpenseCategory(StrEnum):
    """What kind of cost this is.

    These seven values are, character for character, the seven expenditure lines
    the profit statement already names as costs it cannot see. Recording one
    turns that line from unknown into a figure with no translation step in
    between. `OTHER` is the eighth and is for genuine one-offs; it is handled
    differently by the report and the difference is explained there.
    """

    STAFF_SALARIES = "staff_salaries"
    INFRASTRUCTURE = "infrastructure"
    MARKETING = "marketing"
    GATEWAY_FEES = "gateway_fees"
    BINANCE_FEES = "binance_fees"
    TAXES = "taxes"
    REFUNDS_TO_USERS = "refunds_to_users"
    OTHER = "other"


#: The seven the profit statement expects to see every period. `OTHER` is not
#: among them: an empty `other` is genuinely no information, whereas an empty
#: `staff_salaries` means nobody entered the payroll.
REPORTED_CATEGORIES: tuple[ExpenseCategory, ...] = (
    ExpenseCategory.GATEWAY_FEES,
    ExpenseCategory.BINANCE_FEES,
    ExpenseCategory.TAXES,
    ExpenseCategory.STAFF_SALARIES,
    ExpenseCategory.INFRASTRUCTURE,
    ExpenseCategory.MARKETING,
    ExpenseCategory.REFUNDS_TO_USERS,
)

CATEGORY_LABELS: dict[str, str] = {
    str(ExpenseCategory.STAFF_SALARIES): "Staff salaries and contractor pay",
    str(ExpenseCategory.INFRASTRUCTURE): "Servers, Firebase, hosting and tooling",
    str(ExpenseCategory.MARKETING): "Marketing, campaigns and promoter spend",
    str(ExpenseCategory.GATEWAY_FEES): "Payment gateway fees",
    str(ExpenseCategory.BINANCE_FEES): "Binance / foreign settlement fees",
    str(ExpenseCategory.TAXES): "Taxes",
    str(ExpenseCategory.REFUNDS_TO_USERS): "Refunds to users",
    str(ExpenseCategory.OTHER): "Other operating expenditure",
}


class Act:
    """Audit actions this module writes. Mirrors `app.core.audit.Action`."""

    EXPENSE_RAISED = audit.Action.EXPENSE_RAISED
    EXPENSE_PAID = audit.Action.EXPENSE_PAID


# ── Small helpers ─────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public(doc: dict) -> dict:
    out = dict(doc)
    if "_id" in out:
        out["id"] = str(out.pop("_id"))
    return out


def _require_reason(reason: str) -> str:
    text = (reason or "").strip()
    if len(text) < MIN_REASON:
        raise ExpenseError(
            f"A reason of at least {MIN_REASON} characters is required. An "
            "expense with no stated reason is not auditable, so it is not "
            "accepted."
        )
    return text


def _require_text(value: str, label: str, limit: int = 200) -> str:
    text = (value or "").strip()
    if not text:
        raise ExpenseError(f"{label} is required.")
    if len(text) > limit:
        raise ExpenseError(f"{label} is longer than {limit} characters.")
    return text


def _minor_amount(value) -> int:
    """An amount of money, in integer paise.

    Refuses a float outright rather than rounding it. ``12.5`` paise is not a
    quantity of money this business can pay, and accepting it would put a
    rounding decision inside a finance record where nobody would ever see it.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise ExpenseError(
            "Amount must be a whole number of paise (INR minor units) — "
            f"got {type(value).__name__} {value!r}. Money is never a float here: "
            "₹1,250.05 is 125005, not 1250.05."
        )
    if value <= 0:
        raise ExpenseError(
            f"Amount must be greater than zero — got {value}. An expense of zero "
            "records nothing, and a negative expense is a receipt: if money came "
            "back, raise a refund or a credit note rather than a negative cost."
        )
    return value


def _valid_category(value) -> ExpenseCategory:
    try:
        return ExpenseCategory(str(value))
    except ValueError as exc:
        allowed = ", ".join(str(c) for c in ExpenseCategory)
        raise ExpenseError(
            f"'{value}' is not an expense category. Use one of: {allowed}. The "
            "category is what the profit statement subtracts by, so an invented "
            "one would be money the report cannot place."
        ) from exc


def _valid_period(value: str) -> str:
    text = (value or "").strip()
    if not PERIOD_PATTERN.match(text):
        raise ExpenseError(
            f"'{value}' is not a period. Give the month the cost belongs to as "
            "YYYY-MM, e.g. 2026-08. This is the month the cost is *for*; the "
            "profit statement counts the expense in the period it was actually "
            "paid."
        )
    return text


async def _raise(card: NewCard, actor: dict) -> dict:
    try:
        return await card_svc.raise_card(card, actor)
    except CardError as exc:
        raise ExpenseError(str(exc)) from exc


async def _finish(card_id: str, actor: dict, result: dict, ok: bool) -> dict:
    try:
        return await card_svc.mark_executed(card_id, actor, result, ok)
    except CardError as exc:
        raise ExpenseError(str(exc)) from exc


async def _card(card_id: str) -> dict:
    try:
        oid = ObjectId(card_id)
    except Exception as exc:  # noqa: BLE001
        raise ExpenseError("Expense card not found.") from exc

    doc = await get_db()[C.CARDS].find_one({"_id": oid})
    if doc is None:
        raise ExpenseError("Expense card not found.")
    if doc.get("type") != str(CardType.OPERATING_EXPENSE):
        raise ExpenseError(
            f"Card {card_id} is a {doc.get('type')} card, not an operating "
            "expense."
        )
    return doc


async def _card_ready(card_id: str) -> dict:
    """An expense card an owner has signed and nobody has paid yet."""
    doc = await _card(card_id)
    stage = doc.get("stage")
    if stage == str(Stage.EXECUTED):
        raise ExpenseError(
            "This expense has already been paid. Nothing was paid a second time."
        )
    if stage != str(Stage.APPROVED):
        raise ExpenseError(
            f"Card is {stage}. Only an expense signed by an owner can be paid."
        )
    return doc


# ── Raising ───────────────────────────────────────────────────────────────────


async def find_duplicate_invoice_refs(ref: str, limit: int = 10) -> list[dict]:
    """Earlier expense cards carrying the same invoice or receipt reference.

    Not a refusal — the same reference legitimately reappears (a corrected
    invoice, a supplier who numbers per-line). It is shown on the card so the
    owner sees it *before* signing, which is where a double payment is cheap to
    stop and after which it is not.
    """
    ref = (ref or "").strip()
    if not ref:
        return []

    cursor = (
        get_db()[C.CARDS]
        .find(
            {
                "type": str(CardType.OPERATING_EXPENSE),
                "payload.invoice_ref": ref,
                "stage": {"$ne": str(Stage.REJECTED)},
            }
        )
        .sort("created_at", -1)
        .limit(max(1, min(limit, 20)))
    )
    return [
        {
            "card_id": str(doc["_id"]),
            "stage": doc.get("stage"),
            "amount_inr_minor": doc.get("amount"),
            "category": (doc.get("payload") or {}).get("category"),
            "period": (doc.get("payload") or {}).get("period"),
            "created_at": doc.get("created_at"),
        }
        async for doc in cursor
    ]


async def raise_expense(
    *,
    category,
    amount_inr_minor: int,
    period: str,
    payee: str,
    invoice_ref: str,
    reason: str,
    actor: dict,
    evidence_url: str = "",
    recurring: bool = False,
    note: str = "",
) -> dict:
    """Raise an expense card. Stage 1 of 5 — any team member may do this.

    Nothing has moved. What exists afterwards is a request, in Requested, that a
    second person has to verify and an owner has to sign before anybody can pay
    it.

    The card is raised on the **Finance** board whoever raises it. Money leaving
    the company is Finance's business, and it means a marketing spend is not
    verified by the marketing admin who asked for it — the verifier is Finance,
    a team admin of Finance, or an owner, and in every case it is somebody other
    than the person who raised the card (`cards._assert_can_verify`).
    """
    cat = _valid_category(category)
    amount = _minor_amount(amount_inr_minor)
    period = _valid_period(period)
    payee = _require_text(payee, "A payee")
    invoice_ref = _require_text(
        invoice_ref, "An invoice or receipt reference", limit=200
    )
    reason = _require_reason(reason)

    duplicates = await find_duplicate_invoice_refs(invoice_ref)

    card = await _raise(
        NewCard(
            type=CardType.OPERATING_EXPENSE,
            team=Team.FINANCE,
            title=f"{CATEGORY_LABELS[str(cat)]} — {payee} — {period}",
            amount=amount,
            currency=CURRENCY,
            reason=reason,
            subject_type="expense",
            subject_id=f"{period}:{cat}",
            payload={
                "category": str(cat),
                "period": period,
                "payee": payee,
                "invoice_ref": invoice_ref,
                "recurring": bool(recurring),
                "note": (note or "").strip(),
                # Stated on the card itself so nobody has to infer it: this
                # figure lands in the period it is PAID, not the period above.
                "basis": "cash",
                # Shown to the owner before signature, never a silent refusal.
                "duplicate_reference": bool(duplicates),
                "duplicate_of": duplicates,
            },
            evidence=[
                {
                    "kind": "invoice",
                    "ref": invoice_ref,
                    "url": (evidence_url or "").strip(),
                }
            ],
            # An expense is never auto-verified. A bank-proven inbound payment
            # can skip human verification (5.3.1) because the bank is the second
            # party; money going out has no such witness.
            auto_verified=False,
        ),
        actor,
    )

    # `raise_card` audits against the card. This second entry is against the
    # expense subject, so `history_for("expense", "2026-08:staff_salaries")`
    # returns that month's payroll history without anyone knowing a card id.
    await audit.record(
        actor=actor,
        action=Act.EXPENSE_RAISED,
        subject_type="expense",
        subject_id=f"{period}:{cat}",
        reason=reason,
        after={
            "category": str(cat),
            "period": period,
            "payee": payee,
            "amount_inr_minor": amount,
            "stage": card["stage"],
        },
        card_id=card["id"],
        meta={"invoice_ref": invoice_ref, "recurring": bool(recurring)},
    )

    if duplicates:
        card["warning"] = (
            f"Invoice reference {invoice_ref} appears on {len(duplicates)} "
            "earlier expense card(s). Confirm this is a separate bill before "
            "signing."
        )
    return card


async def repeat(
    *,
    card_id: str,
    period: str,
    amount_inr_minor: int,
    invoice_ref: str,
    reason: str,
    actor: dict,
    payee: str = "",
    evidence_url: str = "",
    note: str = "",
) -> dict:
    """Raise next month's card from last month's, as a new Requested card.

    This is the whole of the recurring-cost mechanism, and it is deliberately
    manual: it copies the category, the payee and the recurrence marker, and it
    demands a fresh amount, a fresh invoice reference and a fresh reason. A
    salary that changed, a server bill that doubled and a supplier who was not
    paid at all are all things a person notices while doing this and a scheduler
    would not.

    The new card starts at Requested like any other. Nothing is inherited from
    the old card's verification or signature.
    """
    source = await _card(card_id)
    payload = source.get("payload") or {}

    new_card = await raise_expense(
        category=payload.get("category"),
        amount_inr_minor=amount_inr_minor,
        period=period,
        payee=(payee or payload.get("payee") or ""),
        invoice_ref=invoice_ref,
        reason=reason,
        actor=actor,
        evidence_url=evidence_url,
        recurring=True,
        note=note or payload.get("note") or "",
    )

    await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(new_card["id"])},
        {
            "$set": {
                "payload.repeats_card_id": str(source["_id"]),
                "payload.repeats_period": payload.get("period"),
                "payload.previous_amount_inr_minor": int(source.get("amount") or 0),
                "updated_at": _now(),
            }
        },
    )
    new_card["payload"]["repeats_card_id"] = str(source["_id"])
    new_card["payload"]["repeats_period"] = payload.get("period")
    new_card["payload"]["previous_amount_inr_minor"] = int(source.get("amount") or 0)
    return new_card


# ── Paying ────────────────────────────────────────────────────────────────────


async def execute_expense(card_id: str, payment_ref: str, actor: dict) -> dict:
    """Stage 5 of 5 — the money left. Owners only.

    Approved and Executed are separate for the reason the board separates them
    everywhere (5.2.6): if the transfer fails, the card is visibly stuck rather
    than silently lost. A card that is already Executed refuses here, so a
    replayed request pays nothing a second time.
    """
    ref = _require_text(payment_ref, "A payment reference (UTR, transaction id)")
    card = await _card_ready(card_id)

    payload = card.get("payload") or {}
    category = str(payload.get("category") or "")
    period = str(payload.get("period") or "")
    amount = int(card.get("amount") or 0)

    result = {
        "payment_ref": ref,
        "paid_at": _now(),
        "amount_inr_minor": amount,
        "category": category,
        "period_label": period,
        "payee": payload.get("payee"),
        "invoice_ref": payload.get("invoice_ref"),
        # The statement counts this in the period it was paid, which is now —
        # not in `period_label`. Recorded on the card so the two can never be
        # confused by a later reader.
        "counted_on": "cash basis: the period containing this executed_at",
    }

    await audit.record(
        actor=actor,
        action=Act.EXPENSE_PAID,
        subject_type="expense",
        subject_id=f"{period}:{category}",
        reason=card.get("reason") or "Operating expense paid",
        before={"stage": str(Stage.APPROVED)},
        after={"paid_inr_minor": amount, "payment_ref": ref},
        card_id=card_id,
        meta={
            "category": category,
            "period_label": period,
            "payee": payload.get("payee"),
            "invoice_ref": payload.get("invoice_ref"),
        },
    )

    return await _finish(card_id, actor, result, True)


# ── Reading ───────────────────────────────────────────────────────────────────


async def list_expenses(
    period: str | None = None,
    category=None,
    stage: Stage | None = None,
    limit: int = 100,
) -> list[dict]:
    """The expense register — every card, whatever stage it reached."""
    q: dict = {"type": str(CardType.OPERATING_EXPENSE)}
    if period:
        q["payload.period"] = _valid_period(period)
    if category:
        q["payload.category"] = str(_valid_category(category))
    if stage:
        q["stage"] = str(stage)

    cursor = (
        get_db()[C.CARDS].find(q).sort("created_at", -1).limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]


async def recurring_worklist(period: str) -> dict:
    """What repeats every month, and what has no card yet for this one.

    The answer to "which categories does the owner still have to enter". A cost
    is on this list because somebody previously raised it and marked it
    recurring — the system never invents one, and never assumes an expense that
    stopped is still owed.
    """
    period = _valid_period(period)
    db = get_db()

    known: dict[tuple[str, str], dict] = {}
    cursor = db[C.CARDS].find(
        {
            "type": str(CardType.OPERATING_EXPENSE),
            "payload.recurring": True,
            "stage": {"$ne": str(Stage.REJECTED)},
        }
    )
    async for doc in cursor:
        payload = doc.get("payload") or {}
        key = (str(payload.get("category") or ""), str(payload.get("payee") or ""))
        entry = known.get(key)
        last_period = str(payload.get("period") or "")
        if entry is None or last_period > entry["last_period"]:
            known[key] = {
                "category": key[0],
                "category_label": CATEGORY_LABELS.get(key[0], key[0]),
                "payee": key[1],
                "last_period": last_period,
                "last_card_id": str(doc["_id"]),
                "last_amount_inr_minor": int(doc.get("amount") or 0),
                "last_stage": doc.get("stage"),
            }

    raised: set[tuple[str, str]] = set()
    cursor = db[C.CARDS].find(
        {
            "type": str(CardType.OPERATING_EXPENSE),
            "payload.period": period,
            "stage": {"$ne": str(Stage.REJECTED)},
        }
    )
    async for doc in cursor:
        payload = doc.get("payload") or {}
        raised.add(
            (str(payload.get("category") or ""), str(payload.get("payee") or ""))
        )

    due = [entry for key, entry in sorted(known.items()) if key not in raised]
    done = [entry for key, entry in sorted(known.items()) if key in raised]

    return {
        "period": period,
        "due": due,
        "already_raised": done,
        "note": (
            f"{len(due)} recurring cost(s) have no card for {period}. Each was "
            "marked recurring when it was last raised. Raise the next one with "
            "`repeat` — it copies the category and payee and asks for this "
            "month's amount, invoice reference and reason, then goes through "
            "the same five stages as any other card. Nothing here raises a card "
            "on its own: a figure nobody looked at is not a figure an owner "
            "should be signing."
        ),
    }
