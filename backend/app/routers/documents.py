"""Short-lived links to KYC and identity documents.

One route. It exists so that a permanent `?alt=media&token=` download URL —
a bearer credential that never expires and that Storage Rules are not
consulted for — stops being the thing the CRM renders.

`current_user` throughout, so an app account cannot reach this at all: an
Android user has a Firebase token but no API session. Everything finer than
that is in `services/documents._may_see`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status

from app.core.deps import current_user
from app.services import documents as svc
from app.services.documents import DocumentError, DocumentForbidden, DocumentNotFound

router = APIRouter(prefix="/documents", tags=["documents"])


def _fail(exc: DocumentError) -> HTTPException:
    if isinstance(exc, DocumentNotFound):
        code = status.HTTP_404_NOT_FOUND
    elif isinstance(exc, DocumentForbidden):
        code = status.HTTP_403_FORBIDDEN
    else:
        code = status.HTTP_400_BAD_REQUEST
    return HTTPException(status_code=code, detail=str(exc))


@router.get("/batch")
async def documents_batch(
    ref: list[str] = Query(default_factory=list),
    slot: list[str] = Query(default_factory=list),
    user: dict = Depends(current_user),
) -> dict:
    """Signed URLs for many records in one request.

    ── WHY GET WITH REPEATED PARAMS AND NOT POST WITH A BODY ────────────────

    A body would have been tidier to write. But this is a READ — it mutates
    nothing — and `PARTNER_REACHABLE` draws a hard line there: an allowlisted
    write must carry `require_write_or_partner` and call
    `own_partner_id_or_403` in its body, because that scope call is the only
    thing between "a seller may buy inventory" and "a seller may buy inventory
    in another seller's name". This route authorises per ref instead, which is
    the right shape for a batch and the wrong shape for that rule. Declaring a
    read as POST to get a body would have meant either weakening the rule or
    satisfying it with a scope call that does not fit — so the route matches
    what it actually is.

    `?ref=host:ID&ref=host:ID2&slot=photo`. `slot` narrows which documents are
    signed, applied to every ref: a list showing one thumbnail per row should
    not pay for three KYC signatures per row it will not render.

    Record ids travel in the query string. They are Firestore auto-ids, not
    personal data, and they are already in the page the caller is looking at.

    A ref the caller may not see is omitted rather than refused, so one
    unreachable row does not blank a page. See the service.
    """
    slots = [s for s in slot if s.strip()]
    refs = []
    for raw in ref:
        kind, _, rid = raw.partition(":")
        if kind.strip() and rid.strip():
            refs.append({"kind": kind.strip(), "id": rid.strip(), "slots": slots or None})
    try:
        return await svc.documents_batch(refs, user)
    except DocumentError as exc:
        raise _fail(exc) from exc


@router.get("/{kind}/{record_id}")
async def documents_for(
    kind: str = Path(..., pattern="^(agency|seller|host|coin_purchase)$"),
    record_id: str = Path(..., min_length=1, max_length=200),
    user: dict = Depends(current_user),
) -> dict:
    """Every document on one partner or host record, behind signed URLs.

    The response never contains a stored permanent URL. Each entry is either a
    signed URL good for fifteen minutes or `null` with a sentence explaining
    why it could not be signed — the same shape the host-verification queue
    already uses, so one unreadable file does not blank the page.
    """
    try:
        return await svc.documents_for(kind, record_id, user)
    except DocumentError as exc:
        raise _fail(exc) from exc
