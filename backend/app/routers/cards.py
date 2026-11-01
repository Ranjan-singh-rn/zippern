"""The money board — endpoints.

── Permissions ───────────────────────────────────────────────────────────────

The two interesting decisions on this board are already made by the role model
in `services/cards.py` rather than by a dependency here — `verify` calls
`can_verify_money(role, card_team)` and `sign` calls `can_sign_money(role)` —
so the guards in this file are the outer tier and the real rule is one layer in.
That is unchanged.

What is added is `can_approve_requests` on the two signing routes. It is the
CRM's name for "approve requests in the SA approval queue", it belongs to
superadmin alone, and signing a card is exactly that queue. An owner holds every
capability, so this narrows nothing today; it is here so that the one place in
the API where a request is finally approved is labelled in the same vocabulary
the rest of the system is now enforced in.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.deps import (
    current_user,
    require_owner,
    require_permission,
    require_write,
)
from app.core.roles import Permission, Team
from app.services import cards as svc
from app.services.cards import CardError, CardType, NewCard, Stage

router = APIRouter(prefix="/cards", tags=["money board"])

_APPROVE_REQUESTS = Depends(require_permission(Permission.CAN_APPROVE_REQUESTS))


def _fail(exc: CardError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


class RaiseCard(BaseModel):
    type: CardType
    team: Team
    title: str = Field(min_length=3, max_length=200)
    amount: int
    currency: str
    reason: str = Field(min_length=3, max_length=1000)
    subject_type: str
    subject_id: str
    payload: dict = Field(default_factory=dict)
    evidence: list[dict] = Field(default_factory=list)


class Note(BaseModel):
    note: str = Field(min_length=3, max_length=1000)


class OptionalNote(BaseModel):
    note: str = Field(default="", max_length=1000)


class Reason(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


#: UGP review: a change to a user's balance is raised only where the balance
#: permission is checked and the card's subject IS the account the money moves
#: on — `POST /users/{uid}/balance` (Adjust balance) and a warning deduction.
#: Through this generic route any writing staff member could raise one, with a
#: payload naming a different account from the subject the signer is shown.
#: No CRM screen raises these here.
_BALANCE_CARD_TYPES = frozenset({CardType.BALANCE_CREDIT, CardType.BALANCE_DEBIT})


@router.post("", status_code=status.HTTP_201_CREATED)
async def raise_card(body: RaiseCard, user: dict = Depends(require_write)):
    if body.type in _BALANCE_CARD_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "A balance change is raised from the person's page (Adjust balance, or a "
                "warning with a deduction), not as a generic card."
            ),
        )
    try:
        return await svc.raise_card(
            NewCard(
                type=body.type,
                team=body.team,
                title=body.title,
                amount=body.amount,
                currency=body.currency,
                reason=body.reason,
                subject_type=body.subject_type,
                subject_id=body.subject_id,
                payload=body.payload,
                evidence=body.evidence,
            ),
            user,
        )
    except CardError as exc:
        raise _fail(exc) from exc


@router.get("")
async def list_cards(
    stage: Stage | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """The board, scoped to what the caller should see."""
    return await svc.board_for(user, stage=stage, limit=limit)


@router.get("/inbox")
async def inbox(user: dict = Depends(current_user)):
    """What is waiting on you, across every board. Spec 7.3."""
    return await svc.waiting_on_me(user)


@router.get("/awaiting-signature")
async def awaiting_signature(user: dict = Depends(require_owner)):
    """An owner's queue — verified cards, oldest first, excluding their own."""
    return await svc.awaiting_my_signature(user)


@router.post("/{card_id}/review")
async def start_review(card_id: str, user: dict = Depends(require_write)):
    try:
        return await svc.start_review(card_id, user)
    except CardError as exc:
        raise _fail(exc) from exc


@router.post("/{card_id}/verify")
async def verify(card_id: str, body: Note, user: dict = Depends(require_write)):
    """Team admin or Finance confirms the facts and hands it to owners."""
    try:
        return await svc.verify(card_id, user, body.note)
    except CardError as exc:
        raise _fail(exc) from exc


@router.post("/{card_id}/sign", dependencies=[_APPROVE_REQUESTS])
async def sign(card_id: str, body: OptionalNote, user: dict = Depends(require_owner)):
    """Owner signature. The card becomes Approved, then execution follows."""
    try:
        return await svc.sign(card_id, user, body.note)
    except CardError as exc:
        raise _fail(exc) from exc


@router.post("/sign-bulk", dependencies=[_APPROVE_REQUESTS])
async def sign_bulk(
    card_ids: list[str], user: dict = Depends(require_owner)
):
    """Sign several verified cards at once. Each is logged individually. Spec 5.5.6."""
    signed, failed = [], []
    for cid in card_ids[:100]:
        try:
            signed.append(await svc.sign(cid, user))
        except CardError as exc:
            failed.append({"card_id": cid, "error": str(exc)})
    return {"signed": len(signed), "failed": failed, "cards": signed}


@router.post("/{card_id}/reject")
async def reject(card_id: str, body: Reason, user: dict = Depends(require_write)):
    try:
        return await svc.reject(card_id, user, body.reason)
    except CardError as exc:
        raise _fail(exc) from exc
