"""Transfer requests — an admin requests, the Owner decides (C3). See
`services/transfer_requests`.

  * Filing and listing: `can_approve_kyc` (the Owner holds it too).
  * Deciding: the Owner only — refused in the service with 403 for anyone else,
    so the sentence is the same whichever route reaches it.

A revocation that would move dependents is refused for non-Owners and points
here (`partner_ops.revoke_partner`). No route here is reachable by an external
partner session, and nothing here moves a balance.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.deps import require_internal, require_permission, require_write
from app.core.roles import Permission
from app.services import transfer_requests as svc
from app.services.transfer_requests import TransferError

router = APIRouter(prefix="/partner-ops/transfers", tags=["transfers"])

_KYC = Depends(require_permission(Permission.CAN_APPROVE_KYC))


def _fail(exc: TransferError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


class NewTransfer(BaseModel):
    kind: str = Field(pattern="^(host|sub_agency)$")
    #: A Host's uid, or a Sub-agency's partner id.
    subject_id: str = Field(min_length=1, max_length=128)
    to_agency_id: str = Field(min_length=1, max_length=128)
    note: str = Field(min_length=10, max_length=2000)


class TransferDecision(BaseModel):
    approve: bool
    note: str = Field(min_length=10, max_length=2000)


@router.post("", status_code=status.HTTP_201_CREATED, dependencies=[_KYC])
async def request_transfer(body: NewTransfer, user: dict = Depends(require_write)):
    """File a transfer for the Owner to decide. Moves nothing; the Owners are told."""
    try:
        return await svc.request(body.kind, body.subject_id, body.to_agency_id, body.note, user)
    except TransferError as exc:
        raise _fail(exc) from exc


@router.post("/{request_id}/decide")
async def decide_transfer(
    request_id: str, body: TransferDecision, user: dict = Depends(require_write)
):
    """The Owner approves (re-validated, then moved) or rejects."""
    try:
        return await svc.decide(request_id, body.approve, body.note, user)
    except TransferError as exc:
        raise _fail(exc) from exc


@router.get("", dependencies=[_KYC])
async def transfer_queue(
    transfer_status: str = Query(default="open", alias="status", pattern="^(open|all)$"),
    user: dict = Depends(require_internal),
):
    """Transfer requests — open by default, oldest first."""
    try:
        return await svc.list_requests(user, transfer_status)
    except TransferError as exc:
        raise _fail(exc) from exc
