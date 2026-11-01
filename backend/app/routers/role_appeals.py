"""Reinstatement requests for a revoked role (C2). See `services/role_appeals`.

Three audiences, three guards:

  * **The person**, through the app's Cloud Function callables
    (`submitRoleAppeal`, `myRoleAppeals`), which present the partner-apply
    service key and forward the uid from `context.auth` — the same wrapper as
    `partnerEligibility`. `team_admin_or_partner_apply_service`, exactly as
    `/partner-ops/applications/...`; a team admin may file on somebody's behalf.
  * **Reviewers** of that kind of role — `can_approve_kyc` for Host, Agency and
    Sub-agency, `can_approve_seller` for Coin Seller, the Owner for all — list
    the queue and recommend. The route admits either capability; the service
    refuses a reviewer of the wrong kind with 403.
  * **The Owner**, alone, decides. Everyone else gets 403 with "Only the Owner
    can decide a reinstatement." — decided in the service, so the sentence is
    the same whichever route reaches it.

No route here is reachable by an external partner session.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.deps import (
    require_internal,
    require_permission,
    require_write,
    team_admin_or_partner_apply_service,
)
from app.core.roles import Permission
from app.services import role_appeals as svc
from app.services.role_appeals import RoleAppealError

router = APIRouter(prefix="/partner-ops/role-appeals", tags=["role appeals"])

#: Reviewers of either kind of role. The per-kind check is the service's.
_REVIEWERS = Depends(
    require_permission(Permission.CAN_APPROVE_KYC, Permission.CAN_APPROVE_SELLER, any_of=True)
)


def _fail(exc: RoleAppealError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


class NewRoleAppeal(BaseModel):
    #: The person asking. The callable copies it from the verified token; the
    #: app cannot set it.
    uid: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(host|agency|sub_agency|seller)$")
    statement: str = Field(min_length=20, max_length=2000)


class AppealVerdict(BaseModel):
    outcome: str = Field(pattern="^(restore|keep_revoked)$")
    note: str = Field(min_length=10, max_length=2000)


@router.post("")
async def submit_role_appeal(
    body: NewRoleAppeal, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """File a reinstatement request for one revoked role. Idempotent: an open
    request for the same role is returned unchanged, with `existing: true`."""
    try:
        return await svc.submit(body.uid, body.kind, body.statement, user)
    except RoleAppealError as exc:
        raise _fail(exc) from exc


@router.get("/of/{uid}")
async def role_appeals_of(
    uid: str, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """The person's own requests, newest first."""
    return await svc.list_of(uid)


@router.get("", dependencies=[_REVIEWERS])
async def role_appeal_queue(
    appeal_status: str = Query(default="open", alias="status", pattern="^(open|all)$"),
    user: dict = Depends(require_internal),
):
    """The requests this reviewer may review — open by default, oldest first."""
    try:
        return await svc.list_for_staff(user, appeal_status)
    except RoleAppealError as exc:
        raise _fail(exc) from exc


@router.post("/{appeal_id}/recommend", dependencies=[_REVIEWERS])
async def recommend_role_appeal(
    appeal_id: str, body: AppealVerdict, user: dict = Depends(require_write)
):
    """Recommend restore or keep_revoked. The Owners are notified."""
    try:
        return await svc.recommend(appeal_id, body.outcome, body.note, user)
    except RoleAppealError as exc:
        raise _fail(exc) from exc


@router.post("/{appeal_id}/decide")
async def decide_role_appeal(
    appeal_id: str, body: AppealVerdict, user: dict = Depends(require_write)
):
    """The Owner restores the SAME record, or keeps the role revoked."""
    try:
        return await svc.decide(appeal_id, body.outcome, body.note, user)
    except RoleAppealError as exc:
        raise _fail(exc) from exc
