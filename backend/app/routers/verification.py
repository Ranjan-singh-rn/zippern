"""Host identity verification review queue.

The agency uploads a photograph at registration; the host takes a live capture
in the app; a comparison runs. Anything the comparison cannot settle arrives
here for a person to decide.

Approving is not cosmetic. `isVerifiedHost` is what `releaseBeansForWeek`
checks before releasing a week's earnings, so an approval here is the moment a
host becomes payable — which is why the verdict is written with an audit entry,
in the same trail as bans and balance cards, and why every verdict needs a note.

`require_write` throughout: partners are excluded by that guard, and they must
be. An agency approving its own hosts is precisely the conflict of interest
verification exists to prevent.

`can_approve_kyc` on top of it, on all three routes including the two reads.
This is the KYC decision by another name — a live face capture matched against
an agency's upload — so it belongs to whoever the CRM says may approve KYC, and
`require_write` alone gave it to every staff role including Marketing. The reads
are gated too, unlike most reads in this API, because what they return is two
photographs of somebody's face behind signed URLs. Biometric data under the DPDP
Act is not an ordinary read, and the smallest set of people who can do the job is
the right set to let look.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.deps import require_permission, require_write
from app.core.roles import Permission
from app.services import verification as svc
from app.services.verification import VerificationError, VerificationNotFound

router = APIRouter(prefix="/host-verification", tags=["host-verification"])

#: One capability for the whole queue — looking at a case and deciding it are
#: the same job, and splitting them would let somebody read the photographs
#: without ever being accountable for a verdict.
_APPROVE_KYC = Depends(require_permission(Permission.CAN_APPROVE_KYC))


def _fail(exc: VerificationError) -> HTTPException:
    code = (
        status.HTTP_404_NOT_FOUND
        if isinstance(exc, VerificationNotFound)
        else status.HTTP_400_BAD_REQUEST
    )
    # HT-2: `VerificationNotApplied` carries 409 / 503; every other refusal is as before.
    code = getattr(exc, "status_code", None) or code
    return HTTPException(status_code=code, detail=str(exc))


class Verdict(BaseModel):
    verdict: str = Field(..., pattern="^(verified|rejected)$")
    #: What the reviewer saw. Stored on the record and in the audit entry — a
    #: rejected host is told to ask their agency to re-upload, so somebody has
    #: to be able to find out what was actually wrong with the last attempt.
    reason: str = Field(..., min_length=3, max_length=500)


@router.get("/pending", dependencies=[_APPROVE_KYC])
async def list_pending(
    limit: int = Query(50, ge=1, le=200),
    user: dict = Depends(require_write),
):
    """Hosts waiting on a human decision, oldest first.

    Oldest first because a queue sorted newest-first strands whoever has waited
    longest — and they are the one who cannot withdraw.
    """
    return await svc.list_pending(limit)


@router.get("/{uid}", dependencies=[_APPROVE_KYC])
async def get_for_review(uid: str, user: dict = Depends(require_write)):
    """One case, with both photographs behind short-lived signed URLs.

    Faces are biometric data under the DPDP Act. The reviewer gets a link that
    expires in fifteen minutes rather than standing read access to the bucket.
    """
    try:
        return await svc.get_for_review(uid)
    except VerificationError as exc:
        raise _fail(exc) from exc


@router.post("/{uid}/review", dependencies=[_APPROVE_KYC])
async def review(uid: str, body: Verdict, user: dict = Depends(require_write)):
    """Approve or reject. Immediate, attributed, and audited.

    Rejecting holds earnings rather than destroying them: the weekly payout run
    skips an unverified host's weeks and picks them up once the block clears, so
    a host who passes on a later attempt is paid everything they earned while
    unverified.
    """
    try:
        return await svc.review(uid, body.verdict, body.reason, user)
    except VerificationError as exc:
        raise _fail(exc) from exc
