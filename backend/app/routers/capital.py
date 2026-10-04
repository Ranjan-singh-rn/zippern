"""The owners' capital account — money in from their pocket, and back out.

Neither direction is trading, so neither touches profit. See
`app/services/capital.py` for why that distinction is the whole point.

Two guards, both already in use:

  * `require_write` — recording a movement. It moves nothing; it raises a card.
  * `require_owner` — `/settle`, which is the moment the transfer happened.

There is **no verify route and no sign route here**, deliberately, exactly as in
`expenses.py`: a capital card is verified at `POST /cards/{id}/verify` and signed
at `POST /cards/{id}/sign` like every other card. That is where separation of
duties lives, and it applies with full force here — *an owner cannot sign their
own capital card*. Somebody putting money in, or taking it out, is precisely the
movement that needs the other owner's name on it. "How much did I put in" is a
question three partners will eventually disagree about.

Reading is `require_internal` rather than `require_owner`: the capital account
is business record, and Finance and the Observer are entitled to see it. Writing
it is not.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.deps import require_internal, require_owner, require_write
from app.services import capital as svc
from app.services.capital import CapitalError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/capital", tags=["owner capital"])


def _fail(exc: CapitalError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


class Movement(BaseModel):
    """One capital movement, in either direction."""

    direction: str = Field(pattern="^(in|out)$")
    owner_uid: str = Field(min_length=1, max_length=200)
    owner_name: str = Field(default="", max_length=200)
    #: Paise. ₹1,000 is 100000. Integer throughout, like every other amount.
    amount_minor: int = Field(gt=0)
    method: str = Field(default="bank", max_length=40)
    reference: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=3, max_length=1000)


class SettleBody(BaseModel):
    reason: str = Field(default="", max_length=1000)


@router.post("", status_code=status.HTTP_201_CREATED)
async def record_movement(body: Movement, user: dict = Depends(require_write)):
    """Record that an owner is putting money in, or taking it out.

    **Moves nothing.** It raises a card, which another person verifies and an
    owner — not the owner it is about — signs.
    """
    try:
        return await svc.record(
            direction=body.direction,
            owner_uid=body.owner_uid,
            owner_name=body.owner_name,
            amount_minor=body.amount_minor,
            method=body.method,
            reference=body.reference,
            reason=body.reason,
            actor=user,
        )
    except CapitalError as exc:
        raise _fail(exc) from exc


@router.post("/{card_id}/settle")
async def settle(card_id: str, body: SettleBody, user: dict = Depends(require_owner)):
    """Stage 5 of 5 — the transfer happened. Owners only.

    Refuses anything not already signed, so nothing can be settled that a second
    person has not verified and signed off.
    """
    try:
        return await svc.mark_settled(card_id, user)
    except CapitalError as exc:
        raise _fail(exc) from exc


@router.get("")
async def capital_account(
    owner_uid: str | None = Query(default=None),
    user: dict = Depends(require_internal),
):
    """What each owner has put in, taken back and is still owed.

    Executed movements only. A signed card whose transfer has not happened is
    not money the business holds, and counting it would overstate both the cash
    and what is owed.
    """
    return {
        "owners": await svc.contribution_of(owner_uid),
        "totals": await svc.totals(),
    }
