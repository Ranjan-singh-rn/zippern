"""Operating expenditure endpoints — money leaving the company to run it.

Two guards, both of them ones that already exist:

  * `require_write` — raising an expense, and raising next month's from last
    month's. Team work; the observer is refused here as everywhere.
  * `require_owner` — `/pay`, because that is the moment the money leaves.

There is deliberately **no verify route and no sign route in this file.** An
expense card is verified at `POST /cards/{card_id}/verify` and signed at
`POST /cards/{card_id}/sign`, exactly like every other card on the board, which
is where separation of duties is enforced: the verifier cannot be the raiser
(5.5.1 / 5.5.2), the signer must be an owner and can be neither the raiser
(5.5.3) nor the verifier. Adding a second pair of endpoints here would be a
second implementation of that rule, and the whole point of the board is that
there is not one.

An owner may pay only a card another person raised and a third signed off —
`/pay` refuses anything that is not already in Approved, so the authority is
carried by the stage machine rather than re-asserted here.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.deps import require_internal, require_owner, require_write
from app.services import expenses as svc
from app.services.cards import Stage
from app.services.expenses import ExpenseCategory, ExpenseError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/expenses", tags=["operating expenditure"])


def _fail(exc: ExpenseError) -> HTTPException:
    """An expenditure rule refused this. The message is written to be shown."""
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


class NewExpense(BaseModel):
    """One cost of running the company.

    `amount_inr_minor` is **integer paise**. ₹45,000.00 of salary is 4500000.
    A float is refused rather than rounded — see `services/expenses._minor_amount`.
    """

    category: ExpenseCategory
    amount_inr_minor: int = Field(gt=0)
    period: str = Field(min_length=7, max_length=7)
    payee: str = Field(min_length=1, max_length=200)
    invoice_ref: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=3, max_length=1000)
    evidence_url: str = Field(default="", max_length=2000)
    recurring: bool = False
    note: str = Field(default="", max_length=2000)


class RepeatExpense(BaseModel):
    """Next period's card, from a previous one. Amount and evidence are not
    inherited — a recurring cost that changed has to be noticed by a person."""

    period: str = Field(min_length=7, max_length=7)
    amount_inr_minor: int = Field(gt=0)
    invoice_ref: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=3, max_length=1000)
    payee: str = Field(default="", max_length=200)
    evidence_url: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)


class PaidReason(BaseModel):
    """Payment of an expense — the bank reference is how it reconciles."""

    payment_ref: str = Field(min_length=1, max_length=200)


# ── Raise → (verify → sign on /cards) → pay ───────────────────────────────────


@router.post("", status_code=status.HTTP_201_CREATED)
async def raise_expense(body: NewExpense, user: dict = Depends(require_write)):
    """Stage 1 of 5. Any team member. Nothing has moved yet."""
    try:
        return await svc.raise_expense(
            category=body.category,
            amount_inr_minor=body.amount_inr_minor,
            period=body.period,
            payee=body.payee,
            invoice_ref=body.invoice_ref,
            reason=body.reason,
            actor=user,
            evidence_url=body.evidence_url,
            recurring=body.recurring,
            note=body.note,
        )
    except ExpenseError as exc:
        raise _fail(exc) from exc


@router.post("/{card_id}/repeat", status_code=status.HTTP_201_CREATED)
async def repeat_expense(
    card_id: str, body: RepeatExpense, user: dict = Depends(require_write)
):
    """Raise this period's card from a previous one. Still stage 1 of 5."""
    try:
        return await svc.repeat(
            card_id=card_id,
            period=body.period,
            amount_inr_minor=body.amount_inr_minor,
            invoice_ref=body.invoice_ref,
            reason=body.reason,
            actor=user,
            payee=body.payee,
            evidence_url=body.evidence_url,
            note=body.note,
        )
    except ExpenseError as exc:
        raise _fail(exc) from exc


@router.post("/{card_id}/pay")
async def pay_expense(
    card_id: str, body: PaidReason, user: dict = Depends(require_owner)
):
    """Stage 5 of 5 — record that the money left. Owners only.

    Refuses anything not already signed, so an owner cannot pay a card that no
    second person verified.
    """
    try:
        return await svc.execute_expense(card_id, body.payment_ref, user)
    except ExpenseError as exc:
        raise _fail(exc) from exc


# ── Reading ───────────────────────────────────────────────────────────────────


@router.get("")
async def list_expenses(
    period: str | None = Query(default=None),
    category: ExpenseCategory | None = Query(default=None),
    stage: Stage | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(require_internal),
):
    """The expense register, at every stage — including what is not yet paid."""
    try:
        return await svc.list_expenses(period, category, stage, limit)
    except ExpenseError as exc:
        raise _fail(exc) from exc


@router.get("/recurring-due")
async def recurring_due(
    period: str = Query(...), user: dict = Depends(require_internal)
):
    """Recurring costs with no card yet for this month — the manual worklist."""
    try:
        return await svc.recurring_worklist(period)
    except ExpenseError as exc:
        raise _fail(exc) from exc
