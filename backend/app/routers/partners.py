"""Partner endpoints.

Two audiences share this router:

  * **Staff** looking at any partner.
  * **The partner themselves**, seeing only their own record.

A partner is scoped to their own id by `own_partner_id_or_403`, so an agency can
never read another agency's ledger by changing the URL.

**Every route here now runs against a real partner session.** Until partner
sign-in existed the scope check had never executed with an external role in it,
so two things about it were untested and one was wrong: the fallback treated a
Firebase uid as a partner id, and a login holding both capabilities had only one
of them on its session. Both are fixed in `app/core/deps.py`, in one
implementation shared with `routers/partner_ops.py` rather than a second copy.

The agency routes pass `kind="agency"` and the seller routes `kind="seller"`.
That is not decoration: it is what stops a dual-role partner handing their
seller id to an agency statement, and it is what makes `me` mean something
definite for a login that holds two records.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core import roles as R
from app.core.deps import current_user, own_partner_id_or_403, require_internal
from app.core.roles import Role
from app.services import appeals as appeals_svc
from app.services import partners as svc
from app.services.appeals import AppealError

router = APIRouter(prefix="/partners", tags=["partners"])


# ── Agency ────────────────────────────────────────────────────────────────────


@router.get("/agencies/{agency_id}/statement")
async def agency_statement(
    agency_id: str,
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    limit: int = Query(default=200, le=500),
    user: dict = Depends(current_user),
):
    """Commission earned, paid and outstanding, with the full ledger.

    This is what an agency sees about its own money — spec 0.2.2 and 0.2.3, and
    the thing that currently does not exist anywhere in the product.
    """
    aid = own_partner_id_or_403(user, agency_id, kind="agency")
    return asdict(await svc.agency_statement(aid, since, until, limit))


@router.get("/agencies/{agency_id}/hosts")
async def agency_hosts(
    agency_id: str,
    since: datetime | None = Query(default=None),
    limit: int = Query(default=200, le=500),
    user: dict = Depends(current_user),
):
    """Per-host earnings, aggregated from the ledger. Spec 0.2.4."""
    aid = own_partner_id_or_403(user, agency_id, kind="agency")
    return await svc.agency_host_performance(aid, since, limit)


@router.get("/agencies/{agency_id}/host-reports")
async def agency_host_reports(
    agency_id: str,
    limit: int = Query(default=200, le=500),
    user: dict = Depends(current_user),
):
    """Every report filed against a host of this agency.

    An agency is the most likely source of a correction to a bad report — it
    knows the context the reviewer does not, and it is the one party with an
    interest in the host being treated fairly AND the standing to say so. It
    could not see them at all before, so it could not contest one.

    This is a route rather than a security rule for a structural reason: a
    report carries a `targetUid` and nothing about agencies, so "is this one of
    mine" is a question about the USER document it points at. A rule would need
    a `get()` per row and still would not satisfy a list query. The hosts are
    resolved first here, then the reports fetched by uid.
    """
    aid = own_partner_id_or_403(user, agency_id, kind="agency")
    try:
        return await appeals_svc.reports_for_agency_hosts(aid, limit)
    except AppealError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@router.get("/agencies/{agency_id}/appeals")
async def agency_appeals(
    agency_id: str,
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """Appeals this agency raised, and what became of them.

    Raising one is a direct Firestore write from the dashboard, like a host
    invitation. Reading the OUTCOME goes through here so an agency sees the
    decision, the reason and what was reversed without being able to read
    anybody else's."""
    aid = own_partner_id_or_403(user, agency_id, kind="agency")
    try:
        return await appeals_svc.appeals_for_agency(aid, limit)
    except AppealError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@router.get("/agencies/{agency_id}/sub-agencies")
async def sub_agencies(agency_id: str, user: dict = Depends(current_user)):
    """A parent's sub-agencies and what it owes each. Spec 4.2.9."""
    aid = own_partner_id_or_403(user, agency_id, kind="agency")
    return await svc.sub_agencies_of(aid)


# ── Seller ────────────────────────────────────────────────────────────────────


@router.get("/sellers/{seller_id}/statement")
async def seller_statement(
    seller_id: str,
    limit: int = Query(default=200, le=500),
    user: dict = Depends(current_user),
):
    """One reconciled view — bought, lent, sold, paid, outstanding. Spec 0.4.2."""
    sid = own_partner_id_or_403(user, seller_id, kind="seller")
    return asdict(await svc.seller_statement(sid, limit))


@router.get("/sellers/{seller_id}/history")
async def seller_history(
    seller_id: str,
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    limit: int = Query(default=500, le=1000),
    user: dict = Depends(current_user),
):
    """Every movement involving this seller, in one time-ordered list.

    Both audiences read this one route, which is the point of it. The owner
    asks *"how much business have I done with this person, between these two
    dates"*; the seller asks *"what has happened on my account"*. They are the
    same list, so a single endpoint means the two answers cannot drift apart —
    and `own_partner_id_or_403` is what makes it safe to share, pinning a
    partner to their own record exactly as `/statement` does.

    What `/statement` above cannot answer and this can:

      * **rupees per movement** — the UTR and the amount live on the card, not
        in the coin ledger, and `cash_paid_minor` on the record is one lifetime
        counter that no window can be taken out of;
      * **repayments** — `execute_repayment` writes no coin movement at all, so
        they appear in the coin statement at no limit and in no period. They are
        read here from the card and from `credit.history`;
      * **sales** — with the buyer, and what the seller took for the coins.

    `since` / `until` bound the list and every total in it. Amounts are paise.
    """
    sid = own_partner_id_or_403(user, seller_id, kind="seller")
    return asdict(await svc.seller_history(sid, since, until, limit))


@router.get("/sellers/{seller_id}/can-take-inventory")
async def can_take_inventory(seller_id: str, user: dict = Depends(current_user)):
    """Whether this seller may buy or borrow more. Spec 4.3.12."""
    sid = own_partner_id_or_403(user, seller_id, kind="seller")
    allowed, reason = await svc.can_take_inventory(sid)
    return {"allowed": allowed, "reason": reason}


# ── Exposure — staff only ─────────────────────────────────────────────────────


@router.get("/credit/exposure")
async def credit_exposure(user: dict = Depends(require_internal)):
    """Total credit outstanding across every seller.

    Nobody can answer this today — it requires reading a subcollection per
    seller and adding it up by hand.
    """
    if not (R.can_read_all(user["role"]) or user["role"] in
            {Role.FINANCE_ADMIN, Role.FINANCE_MEMBER, Role.OPS_ADMIN}):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not available for this role.",
        )
    return await svc.total_credit_exposure()


@router.get("/credit/overdue")
async def overdue(
    limit: int = Query(default=100, le=500),
    user: dict = Depends(require_internal),
):
    """Sellers past their due date — the recovery worklist. Spec 4.3.11."""
    return await svc.overdue_sellers(limit)
