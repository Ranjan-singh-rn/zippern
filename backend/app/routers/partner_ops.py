"""Partner lifecycle endpoints.

The write side of partner management: onboarding decisions, seller inventory,
credit, sales and agency commission.

Four guards carry the authority model:

  * `require_write` — raising a request or making an onboarding decision. Team
    work; the observer is refused here as everywhere.
  * `require_write_or_partner` — the same team work on the two routes the spec
    puts in the *partner's* hands: `POST /sellers/{id}/coin-purchases` (4.3.5,
    "seller buys inventory") and `POST /sales` (4.3.8, "seller … files a record
    of each sale"). For an internal role it is `require_write` unchanged. For an
    external one it grants nothing on its own — the route pins the caller to
    their own seller record with `_own_id_or_403` before the service sees the
    id, and that is what makes the route safe, not the guard.
  * `require_team_admin` — commission accrual, and creating a partner record.
    Neither moves cash; one creates a liability the business will later pay and
    the other creates the business entity every money flow resolves against, so
    neither is routine team work.
  * `require_owner` — every `/execute` and `/approve` endpoint, because that is
    the moment money actually moves. **No partner reaches any of them.** A
    seller raises a purchase and files a sale; an owner is what makes coins and
    diamonds exist, and that is unchanged by anything a portal can call.

Three routes additionally accept an unattended service credential. They hold
**different keys** and no operation is in two allowlists:

  * commission accrual and its read-only preview — the Sunday payout job, so a
    week can be accrued with no person present (`WEEKLY_ACCRUAL`);
  * `POST /partners` — the Firestore onboarding triggers, so an agency or seller
    just created in the CRM appears in the pending queue instead of existing
    only in Firestore, where no staff screen can see it (`PARTNER_REGISTRATION`).

Every `/execute` and `/approve` below still requires an owner, and no service
credential's allowlist contains any of them: accrual creates a liability,
registration creates an empty record, an owner's signature is what pays
anything, and that is unchanged by anything in this file.

Reads use `current_user` and are scoped: staff see every partner, a partner
sees only itself.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.config import settings
from app.core import audit, roles as R
from app.core.deps import (
    current_user,
    deny_service_actor,
    enforce_permission,
    internal_or_accrual_service,
    own_partner_id_or_403,
    own_session_uid,
    partner_ids_of,
    require_owner,
    require_permission,
    require_team_admin,
    require_write,
    require_write_or_partner,
    team_admin_or_accrual_service,
    team_admin_or_partner_apply_service,
    team_admin_or_partner_registration_service,
    team_admin_or_recharge_request_service,
)
from app.core.roles import Permission
from app.core.security import is_service_actor
from app.services import cards as cards_svc
from app.services import commission as commission_svc
from app.services import partner_applications as applications
from app.services import partner_activation as activation_svc
from app.services import partner_ops as svc
from app.services import recharges as recharges_svc
from app.services.partner_ops import PartnerOpsError
from app.services.partners import PartnerKind, PartnerStatus

log = logging.getLogger(__name__)

router = APIRouter(prefix="/partner-ops", tags=["partner operations"])


def _fail(exc: PartnerOpsError) -> HTTPException:
    """A partner rule refused this. The message is written to be shown to a user.

    403 when the refusal is about WHO is asking — restoring a revoked role or
    a revocation that moves dependents, both the Owner's (C2 / C3) — rather
    than about what was asked. `PartnerOpsForbidden` carries that status on
    the class, so this reads it rather than naming the class.
    """
    code = getattr(exc, "status_code", None) or status.HTTP_400_BAD_REQUEST
    # Approved contact rule: a refusal that carries a structured detail
    # (`ContactRequired.api_detail()` — the machine-readable code, with the same
    # sentence as `message`) sends it; every other refusal stays the plain
    # sentence it always was.
    structured = getattr(exc, "api_detail", None)
    return HTTPException(status_code=code, detail=structured() if callable(structured) else str(exc))


#: Staff may read any partner; a partner may read only their own records. One
#: implementation, in `app/core/deps.py`, shared with `routers/partners.py` —
#: this file used to carry a second copy of it, and a scope check that exists
#: twice is a scope check that will one day disagree with itself.
_own_id_or_403 = own_partner_id_or_403


# ══════════════════════════════════════════════════════════════════════════════
# The three capabilities this router turns on
# ══════════════════════════════════════════════════════════════════════════════
#
# Built once each and reused, because every one of them is worn by half a dozen
# routes and six copies of the same `Depends(require_permission(...))` is six
# chances for one of them to say something slightly different.
#
# **Onboarding — `can_approve_kyc` OR `can_approve_seller`.** Approving,
# rejecting, deactivating and reactivating all serve an agency *and* a seller
# through one route, and which one it is lives on the record, not in the request.
# A route that demanded both would refuse a role entitled to half its traffic,
# and one that demanded the wrong one would refuse half of it silently; reading
# the record first to pick, then refusing, would move an authority decision
# behind a database lookup for no gain — the two capabilities have identical
# holders in `zipper-crm/lib/auth.ts` (superadmin and ops_admin), so today there
# is no seller-but-not-KYC role for the distinction to protect. `any_of` states
# that honestly rather than pretending to a precision the table cannot express.
#
# **Seller credit and inventory — `can_coin_operations`.** Lending, repayment,
# recovery, write-off, the coin purchase execution and sale approval. The CRM
# calls this "verify recharges, mark coin ops" and gives it to Finance and the
# owners. These used to be `require_write` on the raise and `require_owner` on
# the execute, which meant a marketing member could put a lending card in front
# of an owner.
#
# **Money out — `can_process_payout`.** Commission payouts, host bean
# withdrawals and both legs of a sub-agency payout. Finance and the owners.
_APPROVE_PARTNER = Depends(
    require_permission(
        Permission.CAN_APPROVE_KYC, Permission.CAN_APPROVE_SELLER, any_of=True
    )
)
_COIN_OPS = Depends(require_permission(Permission.CAN_COIN_OPERATIONS))
_PROCESS_PAYOUT = Depends(require_permission(Permission.CAN_PROCESS_PAYOUT))


# ── Request bodies ────────────────────────────────────────────────────────────
# Every mutation carries a reason. Spec 6.1.4 — a change with no stated reason
# is not auditable, so it is not accepted.


class Reason(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


class AttachLogin(BaseModel):
    """Give a partner record that has no login an owner who can sign in.

    `reason` is mandatory like every other mutation here — this one creates a
    credential, so "why does this record have no owner and why is it this
    address" is the entire content of the audit entry.
    """

    email: str = Field(min_length=3, max_length=320)
    name: str = Field(default="", max_length=200)
    phone: str = Field(default="", max_length=40)
    reason: str = Field(min_length=3, max_length=1000)


class NewPartner(BaseModel):
    """Create the business record behind a Firestore agency or seller.

    `partner_id` is the **Firestore document id** — that id is the partner's
    `_id` in Mongo, and it is the only join between the two systems.

    `kind` is optional and is a **check**, never a setting. Main agency,
    sub-agency and seller are read from the partner's own document; if the kind
    given disagrees the request is refused and nothing is created. The kind
    selects which commission slab table the partner is paid from, so it is not
    something a caller gets to assert.
    """

    partner_id: str = Field(min_length=1, max_length=200)
    kind: PartnerKind | None = None
    reason: str = Field(min_length=3, max_length=1000)


class SecondRole(BaseModel):
    """An approved partner applying for the capability it does not have.

    `new_partner_id` is the **Firestore document id** of the second record — a
    `sellers` document for an agency applying to sell coins, an `agencies`
    document for a seller applying to run an agency. The kind is not a field
    here on purpose: it is the counterpart of what the applicant already is, and
    it is confirmed against the new document's own collection.
    """

    new_partner_id: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=3, max_length=1000)


class PaidReason(BaseModel):
    """Execution of a payout — the bank reference is how it reconciles."""

    payment_ref: str = Field(min_length=1, max_length=200)


class CoinPurchase(BaseModel):
    coins: int = Field(gt=0)
    amount_paid_minor: int = Field(ge=0)
    payment_ref: str = Field(min_length=1, max_length=200)
    evidence_url: str = Field(default="", max_length=2000)
    reason: str = Field(min_length=3, max_length=1000)


class Lending(BaseModel):
    coins: int = Field(gt=0)
    due_at: datetime
    terms: str = Field(default="", max_length=2000)
    reason: str = Field(min_length=3, max_length=1000)


class Repayment(BaseModel):
    coins: int = Field(gt=0)
    payment_ref: str = Field(default="", max_length=200)
    reason: str = Field(min_length=3, max_length=1000)


class Recovery(BaseModel):
    coins: int = Field(gt=0)
    penalty_coins: int = Field(default=0, ge=0)
    reason: str = Field(min_length=3, max_length=1000)


class WriteOff(BaseModel):
    coins: int = Field(gt=0)
    reason: str = Field(min_length=3, max_length=1000)


class Sale(BaseModel):
    seller_id: str = Field(min_length=1, max_length=200)
    buyer_uid: str = Field(min_length=1, max_length=200)
    diamonds: int = Field(gt=0)
    amount_paid_minor: int = Field(default=0, ge=0)
    reason: str = Field(min_length=3, max_length=1000)


class CommissionPayout(BaseModel):
    amount_minor: int = Field(gt=0)
    reason: str = Field(min_length=3, max_length=1000)


class HostWithdrawal(BaseModel):
    """Pay a host beans they have available.

    `beans`, not rupees: the wallet is denominated in beans, the conversion to
    cash happens at the rate in force when the bank transfer is made, and a
    rupee figure typed here could not be checked against anything.
    """

    beans: int = Field(gt=0)
    reason: str = Field(min_length=3, max_length=1000)
    # P0-7 (FIN-5): the queued request this card pays — `withdrawalRequests` or
    # `salaryRequests` and its id. Executing the card is the only way that
    # request becomes `paid`.
    request_collection: str = Field(default="", max_length=40)
    request_id: str = Field(default="", max_length=200)


class CommissionAccrual(BaseModel):
    """The caller supplies the **period**. The server computes the amount.

    `amount_minor` and `host_id` are optional and are both narrowing, never
    setting: `amount_minor` is checked against the figure derived from the
    ledger and the request is refused if they disagree, and `host_id` accrues
    only that host's share of the agency's commission for the period.
    """

    period: str = Field(min_length=1, max_length=64)
    reason: str = Field(default="", max_length=1000)
    host_id: str = Field(default="", max_length=200)
    since: datetime | None = None
    until: datetime | None = None
    amount_minor: int | None = Field(default=None, gt=0)


class SubAgencyPayout(BaseModel):
    parent_id: str = Field(min_length=1, max_length=200)
    sub_id: str = Field(min_length=1, max_length=200)
    amount_minor: int = Field(gt=0)
    reason: str = Field(min_length=3, max_length=1000)


# ══════════════════════════════════════════════════════════════════════════════
# Onboarding — team decisions, no owner signature. Spec 3.3.3 / 9.2
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/partners")
async def list_partners(
    kind: PartnerKind | None = Query(default=None),
    partner_status: PartnerStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """The onboarding queue and the partner directory.

    An external partner sees only its own records — **both** of them for a login
    that holds an agency and a seller, which is why this reads the session's
    whole id set rather than one primary id. The filters are ignored for them
    on purpose: a partner asking for `?status=pending` is asking about their own
    records, and answering with a filtered view of a set of one or two would
    only invite the reading that the empty result means nobody is pending.

    An applicant still under review has no ids and gets an empty list, which is
    the same thing this returned for them before and needs no special case.
    """
    if not R.is_internal(user["role"]):
        out: list[dict] = []
        for own in sorted(partner_ids_of(user)):
            try:
                out.append(await svc.get_partner(own))
            except PartnerOpsError:
                continue
        return out
    return await svc.list_partners(kind, partner_status, limit)


@router.post("/partners", status_code=status.HTTP_201_CREATED)
async def create_partner(
    body: NewPartner,
    user: dict = Depends(team_admin_or_partner_registration_service),
):
    """Create the Mongo business record for an existing agency or seller.

    Until now nothing created one. The CRM wrote the Firestore document and the
    record every money flow keys off never came into being, so a registered
    seller could not be funded and an approved agency could not accrue anything.

    **Or the partner-registration credential.** Nothing in a browser ever called
    this, which is why every applicant since launch has been invisible: all five
    creation screens write a Firestore document and stop, and the queues on
    /kyc, /agencies and /sellers are built from `list_partners`, which reads
    Mongo. The applicant cannot call it either — an agency or seller holds a
    Firebase login and no API session, because `sign_in_with_firebase` resolves
    a role from the `staff` collection and no partner is ever in it.

    So the Firestore triggers `registerAgencyPartner` / `registerSellerPartner`
    (functions/src/index.ts § 13) do it, presenting `X-Service-Key` and resolving
    to the system actor `system:partner-registration`, which is the actor
    recorded on the `partner.created` audit entry. That credential holds this
    operation and nothing else — it cannot approve, accrue, load inventory or
    pay, and this route creates a record that holds nothing and is `pending`
    either way. See `app/core/security.py` → `PARTNER_REGISTRATION`.

    The partner is created **holding nothing** — zero coins, zero credit, zero
    commission, zero cash recorded — and `pending`. Approval is a separate
    decision; an opening inventory load is a separate signed card.

    **Idempotent.** Creating twice returns the record that already exists with
    `created: false` and changes nothing about it. It is not an error: this is
    called from registration and approval screens that get retried, and a
    refusal there would report a failure for a partner that is perfectly fine.

    **Authority — a team admin.** No money moves, so it stops short of an owner
    signature, the same line the router already draws for commission accrual.
    But it is not routine team work either: this record is what every later
    money flow resolves against, its `kind` selects the commission slab table
    and its `parent_id` routes a sub-agency's payout through the right parent.
    A business entity coming into existence is an admin's decision.

    A `partner_id` that names no Firestore `agencies` or `sellers` document is
    refused. A partner record pointing at nobody would satisfy every internal
    check while naming no real partner, which is worse than having none.

    **The capability is checked in the body, not in the decorator**, because a
    dependency would start from `current_user` and refuse the Firestore trigger
    with a 401 about a missing `Authorization` header. `enforce_permission` lets
    a machine through — it arrived holding a key whose allowlist names this one
    operation, which is narrower than any role — and holds a person to
    `can_approve_kyc` or `can_approve_seller`, the same pair as approving.
    """
    await enforce_permission(
        user,
        Permission.CAN_APPROVE_KYC,
        Permission.CAN_APPROVE_SELLER,
        any_of=True,
    )
    try:
        return await svc.create_partner(
            body.partner_id, body.reason, user, body.kind
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/partners/{partner_id}/attach-login",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_APPROVE_PARTNER],
)
async def attach_login(
    partner_id: str,
    body: AttachLogin,
    user: dict = Depends(require_team_admin),
):
    """Attach a login to a partner record that has none.

    **The gap this closes.** A partner record with no `crmUid` belongs to
    nobody. Its owner cannot sign in to the CRM, cannot see a statement and
    cannot be told why an application was refused, and there has never been a
    control anywhere — no CRM screen, no endpoint, no script — that could give
    one an owner. The records exist: a sub-agency whose secondary-app signup
    half-failed, an applicant whose `crmUsers` write the rules refused, every
    partner brought in by `scripts/backfill_partners.py`. The only remedy was
    editing Firestore by hand, which nothing reviews and nothing records.

    **What it grants.** A sign-in, and nothing else. The partner's status,
    balances, approval and commission are untouched — an unapproved partner
    given a login gets a session that can reach no record at all
    (`security.resolve_partner_login`). It is not an approval route, it does not
    move money and it creates no liability.

    **Authority — a team admin, and never a machine.** The same guard as
    creating a partner record, for the same reason: no money moves, so it stops
    short of an owner's signature, but bringing a credential into existence is
    not routine team work. No service credential's allowlist contains it, and
    `deny_service_actor` refuses one outright rather than resting on that — a
    key that could mint partner logins is not a shape this system should have.

    **Refusals, all of them before anything is created.** A partner that does
    not exist, or that Firestore cannot confirm; a partner that already has a
    login on either side of the link, because re-pointing a record at somebody
    new is a handover and would orphan the current holder; an address that is a
    staff account; an address that already holds a `crmUsers` document naming a
    different partner; and an address whose human already holds a record in the
    same ROLE FAMILY.

    **The role-family refusal is the one-agency-per-human rule**, applied here
    because this endpoint is the other way a human becomes the owner of an
    agency. Creating a partner record claims the family
    (`ensure_partner_record`); linking an already-created one now claims it
    too, through the same `services/partner_roles` and the same `_id` lock, so
    two simultaneous links cannot both win. One agency-family record — an
    Agency *or* a Sub-agency, never both and never two — plus one Coin Seller.

    This used to refuse if the address signed in as **any** other partner,
    while its own message described the correct rule. Attaching a coin-seller
    login to someone who runs an agency — a combination the business requires —
    was rejected by that check. It is permitted now, and a second agency is
    not.
    """
    deny_service_actor(user)
    try:
        return await svc.attach_login(
            partner_id,
            body.email,
            body.reason,
            user,
            name=body.name,
            phone=body.phone,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.get("/partners/{partner_id}")
async def get_partner(partner_id: str, user: dict = Depends(current_user)):
    """One partner, with live credit standing and balance attached.

    A partner may fetch **either** of their own records — the `kind` is left
    open here on purpose, because a dual-role login's agency record and seller
    record are both "their own partner" and this route serves both.
    """
    pid = _own_id_or_403(user, partner_id)
    try:
        return await svc.get_partner(pid)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/partners/{partner_id}/virtual-account",
    status_code=status.HTTP_201_CREATED,
    # A VAN is a standing instruction to the bank in a *seller's* name, so this
    # one names the seller capability rather than the onboarding pair.
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_SELLER))],
)
async def issue_virtual_account(
    partner_id: str, body: Reason, user: dict = Depends(require_team_admin)
):
    """Issue an approved seller's permanent virtual account number. Spec 4.3.4.

    **The normal path is approval, not this.** `POST /partners/{id}/approve`
    issues one in the same flow the spec names (8C.1.4, "assigned a permanent
    VAN on approval"). This route exists for the sellers approved *before* the
    bank account existed: approval is not run twice, so without it every seller
    on the books today would stay without a number forever.

    **Today it refuses, and says why.** Virtual accounts need an HDFC eCMS
    collection account and eCMS needs a business current account (8C.8.7);
    Zipper is on a personal one. The refusal is the honest answer, and it is the
    same sentence the seller's own portal shows. Nothing is issued, and — the
    point of the whole design — nothing is invented to look like one.

    **A number is never reissued.** A VAN is permanent: the seller has printed
    it, saved it as a payee and given it to the people who pay them. Asking for
    a second one is refused with the first one named, because a reissue would
    orphan every standing instruction pointing at it and the money would arrive
    nowhere.

    **Authority — a team admin.** No money moves and no balance changes, so it
    stops short of an owner's signature; but a VAN is a standing instruction to
    the bank to accept money in this partner's name, which is not routine team
    work. The same line `POST /partners` and `attach-login` already draw.
    """
    deny_service_actor(user)
    try:
        return await svc.issue_virtual_account(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/partners/{partner_id}/approve", dependencies=[_APPROVE_PARTNER])
async def approve_partner(
    partner_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Approve an application — no owner signature, no money moves. Spec 9.2.

    This is also where the business record comes into existence: if no partner
    record exists for this id yet, one is created first from the Firestore
    document, at zero, and the response says so in `partner_record_created`.
    Approval is the moment a partner becomes real, so it is the right moment.
    An id that names no Firestore agency or seller is still refused.

    If the record is a **second capability** for a login that already holds one
    (`POST /partners/{id}/second-role` filed it), approving it also puts that
    capability on the login and cross-links the two partner documents. The two
    records, their balances and their ledgers stay entirely separate. A partner
    that is not a second capability takes none of that path.
    """
    try:
        return await svc.approve_partner(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


class GrantCapability(BaseModel):
    """Staff granting an existing partner their second capability."""

    #: 'agency' or 'seller' — the capability they do not already hold.
    kind: str = Field(pattern="^(agency|seller)$")
    name: str = Field(min_length=1, max_length=200)
    phone: str = Field(default="", max_length=40)
    reason: str = Field(min_length=3, max_length=1000)


@router.post(
    "/partners/{partner_id}/grant-capability",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_APPROVE_PARTNER],
)
async def grant_second_capability(
    partner_id: str, body: GrantCapability, user: dict = Depends(require_team_admin)
):
    """Give an existing partner their second capability, from the CRM.

    The path that did not exist. A second capability could only begin with the
    partner applying from their own dashboard, and creating a fresh agency
    instead makes a separate business with a separate login — so the partner's
    own login gained nothing and they went on being told they were under review.

    This writes both halves and links them to the login the partner already
    holds. It **approves nothing**: the result is `pending` and goes through the
    same review and the same Approve button as any other application, because
    that is where somebody confirms the documents and the bank account.

    `require_team_admin` rather than `require_write`: filing an application
    about yourself costs nothing, but creating a business record about somebody
    else is a decision.
    """
    try:
        return await svc.grant_second_capability(
            held_partner_id=partner_id,
            kind=PartnerKind.SELLER if body.kind == "seller" else PartnerKind.AGENCY,
            name=body.name,
            phone=body.phone,
            reason=body.reason,
            actor=user,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/partners/{partner_id}/second-role",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_APPROVE_PARTNER],
)
async def request_second_role(
    partner_id: str, body: SecondRole, user: dict = Depends(require_write)
):
    """An approved agency applies to sell coins, or a seller to run an agency.

    One login, two businesses, **two separate records**. The second one is
    created here holding nothing — zero coins, zero credit, zero commission,
    zero cash recorded — and `pending`, through the same
    `ensure_partner_record` every other partner goes through. It therefore lands
    in the same queue on /agencies or /sellers, and is approved with the same
    Approve button, by the same people, against the same mandatory reason. Coin
    inventory is real money; a second capability is reviewed like a first one.

    Nothing about the partner's existing record changes: commission stays an
    agency liability in paise and inventory stays a seller position in coins,
    on their own records in their own ledgers. Filing this moves no money and
    grants nothing — approval grants the capability, and an opening inventory
    load is still a separate signed card.

    **Authority — any writer**, the same as approving or rejecting an
    application. Filing costs nothing and decides nothing.
    """
    try:
        return await svc.request_second_role(
            partner_id, body.new_partner_id, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/partners/{partner_id}/reject", dependencies=[_APPROVE_PARTNER])
async def reject_partner(
    partner_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Reject an application. The reason is mandatory and is stored on the record,
    so the applicant is told why instead of silently reapplying."""
    try:
        return await svc.reject_partner(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


class PendingDecision(BaseModel):
    """Apply or refuse a change a partner proposed to their own record.

    The same `{approve, reason}` shape as
    `POST /users/host-applications/{id}/decide`, deliberately: these are the
    same act on two collections, and a reviewer screen that has to remember
    which one takes `approve` and which takes a verb in the path is a screen
    that will one day call the wrong one.
    """

    approve: bool
    reason: str = Field(min_length=3, max_length=1000)


@router.post(
    "/partners/{partner_id}/pending-changes/decide",
    # A proposal here is a bank account or an identity document, which is the
    # KYC decision arriving a second time — not a fresh approval of the partner.
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def decide_pending_changes(
    partner_id: str, body: PendingDecision, user: dict = Depends(require_write)
):
    """Apply or refuse a change an agency or seller proposed to their own record.

    **This route exists because no browser can do it.** An approved partner
    used to be able to replace their own bank account from their dashboard —
    the write went straight onto the live record, `status` stayed `approved`,
    and the review queue keys off `status`, so the new account was live and
    nobody ever looked. `firestore.rules` now refuses a partner every one of
    those fields; what they may write is a proposal, and the live field does
    not move. Applying it is this call, and there is no other way to make it
    happen.

    Approving writes the proposed values onto the record and clears the
    proposal. Refusing clears the proposal, leaves every live field exactly as
    it was, and stores the reason on the document so the partner is told why
    instead of submitting the same change again.

    **The proposer cannot be the approver.** The service refuses when the two
    uids match — four eyes on anything that moves where money is sent, which is
    the same control `firestore.rules` applies to a host's details by letting an
    admin propose and only a superadmin write.

    **Only the fields the rules protect are ever written.** A proposal is
    partner-supplied data and Firestore constrains nothing inside it; anything
    outside the payout and identity sets is refused and named in the response
    rather than applied.

    `require_write`, the same authority as approving the application in the
    first place — and it is the guard that matters, because it admits no
    external partner at all. A partner applying their own proposal would be the
    hole this closes, reopened.
    """
    try:
        if body.approve:
            return await svc.apply_pending_changes(partner_id, body.reason, user)
        return await svc.reject_pending_changes(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/partners/{partner_id}/deactivate", dependencies=[_APPROVE_PARTNER])
async def deactivate_partner(
    partner_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Suspend a partner. The record is kept — history stays attributable."""
    try:
        return await svc.deactivate_partner(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/partners/{partner_id}/reactivate", dependencies=[_APPROVE_PARTNER])
async def reactivate_partner(
    partner_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Lift a suspension — or, for the Owner only, restore a REVOKED record (C2).

    Restoring a revoked role answers 403 for anyone but the Owner; the way for
    everyone else is a recommendation on the person's reinstatement request.
    A role-level suspension keeps this route's ordinary permission."""
    try:
        return await svc.reactivate_partner(partner_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


class Revoke(Reason):
    #: A live main agency to receive the revoked agency's sub-agencies and
    #: hosts. Required when there are any; a sub-agency's hosts default to its
    #: parent. See `partner_ops.revoke_partner`.
    transfer_to: str | None = Field(default=None, max_length=128)


@router.post("/partners/{partner_id}/revoke", dependencies=[_APPROVE_PARTNER])
async def revoke_partner(
    partner_id: str, body: Revoke, user: dict = Depends(require_write)
):
    """Take the role away — and ONLY the role.

    The person's account is untouched (that is moderation, on `/users`), their
    other partner roles stay live, and every historical record stays. The
    role-family slot is KEPT (C1): a revoked role still counts, and the way
    back is a reinstatement request the Owner decides. Distinct from
    `deactivate`, which is a temporary suspension.

    An agency with sub-agencies or hosts is refused unless `transfer_to` names
    a live main agency to receive them; the refusal lists what is attached.
    A revocation that moves dependents at all is a transfer, and is the
    Owner's (C3): anyone else gets 403 and is pointed at
    `POST /partner-ops/transfers`.
    """
    try:
        return await svc.revoke_partner(partner_id, body.reason, user, body.transfer_to)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Seller inventory. Spec 4.3.5 / 4.3.6
# ══════════════════════════════════════════════════════════════════════════════


@router.post(
    "/sellers/{seller_id}/coin-purchases", status_code=status.HTTP_201_CREATED
)
async def request_coin_purchase(
    seller_id: str, body: CoinPurchase, user: dict = Depends(require_write_or_partner)
):
    """Raise a coin purchase card.

    Refused outright if the seller is blocked — unapproved, or with overdue
    credit (4.3.12). If the payment reference has been seen before, the card is
    still raised but carries `duplicate_reference`, so the owner sees it before
    signing rather than after.

    **The seller raises this one themselves.** Spec 4.3.5 is "seller buys
    inventory", and until the seller portal could call it a seller who had
    already paid us reached nobody. Staff raising it on a seller's behalf is
    unchanged and is still the normal case for a payment that arrives some other
    way.

    Two things make that safe, and neither is the dependency:

      * `_own_id_or_403` pins an external caller to their own **seller** record.
        `seller_id` came out of the URL, so without it a seller with a session
        could file a purchase against another seller's inventory. An internal
        caller passes through it untouched.
      * The card comes back through `cards.partner_view` for an external caller.
        `duplicate_of` is the result of searching every card in the business for
        this UTR — it is *other sellers'* ids and amounts, put on the card for
        the owner who signs it — and returning it to the seller who typed the
        reference would make this route an oracle for probing them.

    It still moves nothing. The coins exist when an owner executes the card, and
    that is `require_owner` (4.3.6).
    """
    seller_id = _own_id_or_403(user, seller_id, kind="seller")
    try:
        card = await svc.request_coin_purchase(
            seller_id,
            body.coins,
            body.amount_paid_minor,
            body.payment_ref,
            body.evidence_url,
            user,
            body.reason,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc
    if R.is_external(user["role"]):
        return cards_svc.partner_view(
            card, partner_ids_of(user), user.get("uid", "")
        )
    return card


@router.get("/payment-references/{payment_ref}")
async def payment_reference_history(
    payment_ref: str, user: dict = Depends(current_user)
):
    """Every card that already carries this reference — the duplicate check,
    available on its own so a reviewer can run it before raising anything."""
    if not R.is_internal(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not available to external accounts.",
        )
    return await svc.find_duplicate_payment_refs(payment_ref, limit=20)


@router.post("/coin-purchases/{card_id}/execute", dependencies=[_COIN_OPS])
async def execute_coin_purchase(card_id: str, user: dict = Depends(require_owner)):
    """Credit the inventory once the card is signed. Idempotent on the card id."""
    try:
        return await svc.execute_coin_purchase(card_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Seller credit. Spec 4.3.7 / 4.3.10–4.3.17
# ══════════════════════════════════════════════════════════════════════════════


@router.post(
    "/sellers/{seller_id}/lending",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_COIN_OPS],
)
async def request_lending(
    seller_id: str, body: Lending, user: dict = Depends(require_write)
):
    """Raise a lending card. A due date is required — credit without one is a gift."""
    try:
        return await svc.request_lending(
            seller_id, body.coins, body.due_at, body.terms, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/lending/{card_id}/execute", dependencies=[_COIN_OPS])
async def execute_lending(card_id: str, user: dict = Depends(require_owner)):
    """Credit the coins and record the debt with its amount and due date."""
    try:
        return await svc.execute_lending(card_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/sellers/{seller_id}/repayments",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_COIN_OPS],
)
async def request_repayment(
    seller_id: str, body: Repayment, user: dict = Depends(require_write)
):
    """Raise a repayment card. Spec 4.3.10."""
    try:
        return await svc.request_repayment(
            seller_id, body.coins, body.payment_ref, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/repayments/{card_id}/execute", dependencies=[_COIN_OPS])
async def execute_repayment(card_id: str, user: dict = Depends(require_owner)):
    """Reduce the outstanding debt by the repaid amount."""
    try:
        return await svc.execute_repayment(card_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/sellers/{seller_id}/recoveries",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_COIN_OPS],
)
async def request_recovery(
    seller_id: str, body: Recovery, user: dict = Depends(require_write)
):
    """Raise a recovery card. The penalty is legitimate and may take the total
    above the original debt (4.3.14); the split is shown before signing."""
    try:
        return await svc.request_recovery(
            seller_id, body.coins, body.penalty_coins, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/recoveries/{card_id}/execute", dependencies=[_COIN_OPS])
async def execute_recovery(card_id: str, user: dict = Depends(require_owner)):
    """Recover what the balance holds; any shortfall stays an open receivable
    against the seller rather than disappearing. Spec 4.3.16."""
    try:
        return await svc.execute_recovery(card_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post(
    "/partners/{partner_id}/write-off",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_COIN_OPS],
)
async def write_off_debt(
    partner_id: str, body: WriteOff, user: dict = Depends(require_write)
):
    """Raise a bad-debt write-off. Owner signature required. Spec 4.3.17."""
    try:
        return await svc.write_off_debt(partner_id, body.coins, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/write-offs/{card_id}/execute", dependencies=[_COIN_OPS])
async def execute_write_off(card_id: str, user: dict = Depends(require_owner)):
    """Book the loss. It appears in the audit log as one."""
    try:
        return await svc.execute_write_off(card_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Sales. Spec 4.3.8 / 4.3.9
# ══════════════════════════════════════════════════════════════════════════════


@router.post("/sales", status_code=status.HTTP_201_CREATED)
async def record_sale(body: Sale, user: dict = Depends(require_write_or_partner)):
    """File a sale. Nothing moves until it is approved.

    Spec 4.3.8 — "seller sells diamonds to users and **files a record of each
    sale**". The seller is the person who knows a sale happened, so the seller
    files it; staff filing one on their behalf is unchanged.

    `seller_id` arrives in the **body** here rather than the URL, which changes
    nothing about the check and everything about how easy it is to miss: an
    external caller is pinned to their own seller record before the service is
    called, so a seller cannot file a sale that debits somebody else's
    inventory. An internal caller passes through untouched.

    Filing leaves the sale at `pending` and moves no coins and no diamonds.
    Approval is `require_owner` and debits the seller's inventory before it
    credits the buyer, so a seller short of stock stops the sale before any
    diamonds exist (4.3.9).
    """
    seller_id = _own_id_or_403(user, body.seller_id, kind="seller")
    try:
        return await svc.record_sale(
            seller_id,
            body.buyer_uid,
            body.diamonds,
            body.amount_paid_minor,
            user,
            body.reason,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.get("/registration/availability")
async def registration_availability(
    email: str = Query(default="", max_length=254),
    phone: str = Query(default="", max_length=32),
    kind: str = Query(default="", pattern=r"^(|agency|seller)$"),
):
    """PUBLIC. Is this email / phone already registered as an Agency or Seller?

    Called by the public signup forms as the applicant leaves each field, so
    the form says "already registered as an Agency" there and then. Returns
    only the role kind per field (or null) — never a name, an id or a status.

    `kind` (optional) asks about one role only — the seller signup's duplicate
    check, which the browser cannot run against `sellers` itself (UGP-G, I-5).
    """
    from app.services import users as users_svc

    return await users_svc.registration_availability(email, phone, kind)


@router.get("/buyers/lookup")
async def lookup_buyer(q: str = Query(min_length=3, max_length=128), user: dict = Depends(current_user)):
    """Resolve a buyer for a sale by exact uid, email or phone. Masked results.

    Staff, or a login holding a Coin Seller role. Nobody else has a sale to file.
    """
    if not R.is_internal(user["role"]) and not partner_ids_of(user, "seller"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a coin seller can look up a buyer.")
    from app.services import users as users_svc

    return await users_svc.lookup_buyers(q)


@router.get("/sales")
async def list_sales(
    seller_id: str | None = Query(default=None),
    sale_status: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """Sales, scoped — a seller sees only its own.

    Sales belong to a seller record, so a partner is pinned to their *seller*
    id and to nothing else: an agency-only login, and an applicant under review,
    both have none and are given an empty list rather than an unfiltered query.
    The old line here (`user.get("partner_id") or user["uid"]`) would have put a
    Firebase uid in the filter for either of them.
    """
    if not R.is_internal(user["role"]):
        own = partner_ids_of(user, "seller")
        if not own:
            return []
        seller_id = next(iter(own))
    return await svc.list_sales(seller_id, sale_status, limit)


@router.post("/sales/{sale_id}/approve", dependencies=[_COIN_OPS])
async def approve_sale(
    sale_id: str, body: Reason, user: dict = Depends(require_owner)
):
    """Approve a sale — debits the seller's inventory, then credits the buyer.

    The debit is first on purpose: a seller short of stock stops the sale before
    any diamonds exist. Spec 4.3.9.
    """
    try:
        return await svc.approve_sale(sale_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Agency commission
# ══════════════════════════════════════════════════════════════════════════════


@router.post(
    "/agencies/{agency_id}/commission-payouts",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_PROCESS_PAYOUT],
)
async def request_commission_payout(
    agency_id: str, body: CommissionPayout, user: dict = Depends(require_write)
):
    """Raise a commission payout card. Refused if it would overpay the agency."""
    try:
        return await svc.request_commission_payout(
            agency_id, body.amount_minor, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/commission-payouts/{card_id}/execute", dependencies=[_PROCESS_PAYOUT])
async def execute_commission_payout(
    card_id: str, body: PaidReason, user: dict = Depends(require_owner)
):
    """Debit the commission balance and record the payment reference."""
    try:
        return await svc.execute_commission_payout(card_id, body.payment_ref, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.get("/agencies/{agency_id}/commission-preview")
async def commission_preview(
    agency_id: str,
    period: str = Query(min_length=1, max_length=64),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    user: dict = Depends(internal_or_accrual_service),
):
    """What a period would accrue, and the whole derivation behind it.

    Nothing is credited. This is how a team member checks a figure before it is
    accrued, instead of computing one in a browser and typing it in — and it is
    the read the weekly job makes before it accrues anything, so the sanity
    bound is applied to a figure rather than discovered afterwards.
    """
    try:
        return await svc.commission_preview(agency_id, period, since, until)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ── The unattended accrual ────────────────────────────────────────────────────
#
# Everything from here to `accrue_commission` exists because the Sunday job has
# no person in front of it. A team admin accruing by hand has looked at the
# figure; a cron has not, so the server does the looking.

#: `services/partner_ops.accrue_commission` raises `PartnerOpsError` with this
#: phrase when *every* host's leg of a period was already credited — the
#: idempotency key `commission:{agency}:{host}:{period}` doing its job on a
#: retry or a double trigger. For a person that is a refusal worth reading. For
#: a machine it is success: the week is accrued, and accrued exactly once.
#:
#: This couples to the wording of that message, which is why
#: `tests/test_service_credential.py` asserts the phrase is still in the source.
#: If it ever is not, the test fails rather than the Sunday email quietly
#: reporting a healthy retry as a failure. Anything that does not match falls
#: through to a loud failure, which is the safe direction.
ALREADY_ACCRUED_MARKER = "already accrued"


class AccrualOutcome:
    """What one unattended accrual did, in a word the caller can branch on."""

    ACCRUED = "accrued"
    ALREADY_ACCRUED = "already_accrued"
    NOTHING_TO_ACCRUE = "nothing_to_accrue"
    REFUSED_BOUND = "refused_sanity_bound"
    REFUSED_PROVISIONAL = "refused_provisional_slabs"


def _refusal(outcome: str, message: str, detail: dict) -> HTTPException:
    """A refusal a machine can classify and a person can read.

    409, not 400: nothing about the request is malformed. The server is
    declining to act unattended, and the same request from a team admin who has
    looked at the figure will go through.
    """
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"outcome": outcome, "message": message, **detail},
    )


async def _record_refusal(
    actor: dict, agency_id: str, outcome: str, message: str, meta: dict
) -> None:
    """Put the refusal in the audit log, where a missing week is visible.

    Best effort — a failure to record must not turn a clean refusal into a 500,
    because the caller still has to be told it was refused. The `logger.error`
    is the backstop and is emitted by the caller either way.
    """
    try:
        await audit.record(
            actor=actor,
            action=audit.Action.COMMISSION_ACCRUE_REFUSED,
            subject_type="partner",
            subject_id=agency_id,
            reason=message,
            after={"outcome": outcome},
            meta={"agency_id": agency_id, "outcome": outcome, **meta},
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "Could not record the refused accrual for %s in the audit log. The "
            "accrual was still refused.",
            agency_id,
        )


async def _accrue_unattended(agency_id: str, body: CommissionAccrual, actor: dict):
    """The accrual as a machine performs it: look first, then act.

    Four things happen here that do not happen when a person accrues, and each
    is because nobody is watching:

      1. **Preview first.** The figure is computed and inspected before
         anything is credited, and then handed back to `accrue_commission` as
         `expected_amount_minor`. That is a check, never a setting — if the
         ledger moved between the two reads the accrual refuses rather than
         crediting a figure that never passed the checks below.
      2. **A provisional slab table refuses.** If `appConfig/economy` could not
         be read, `commission.py` falls back to the documented table and says
         the figure is provisional. A person may look at that and decide. A cron
         may not: `commission.py` itself says a provisional figure "must not be
         paid without confirming the live configuration".
      3. **A sanity bound.** See `settings.service_accrual_max_minor`.
      4. **Zero is an outcome, not an error.** Most agencies bill below the
         floor in most weeks. `accrue_commission` refuses a zero movement, and
         rightly — but for the weekly run that is the normal case, and reporting
         fifty routine zeroes as fifty failures would bury a real one.
    """
    period = body.period

    try:
        preview = await svc.commission_preview(
            agency_id, period, body.since, body.until
        )
    except PartnerOpsError as exc:
        # A malformed slab table arrives here, and it is a failure, loudly.
        log.error(
            "Unattended accrual for %s in %s could not compute a figure: %s",
            agency_id,
            period,
            exc,
        )
        raise _fail(exc) from exc

    total_minor = int(preview["commission_minor"])
    span = preview["period"]
    agency_name = preview.get("agency_name") or agency_id
    common = {
        "agency_id": agency_id,
        "agency_name": agency_name,
        "period": span,
        "amount_minor": total_minor,
        "amount_inr": total_minor / 100,
        "billing_minor": preview["billing"]["billing_minor"],
        "provisional": preview["provisional"],
        "unattended": True,
    }

    if preview["provisional"]:
        why = " ".join(preview["warnings"]) or (
            "The live economy configuration could not be read."
        )
        message = (
            f"Commission for {agency_name} in {span} was NOT accrued. The figure "
            f"is provisional. {why} An unattended run will not create a liability "
            "from a fallback table. Confirm appConfig/economy, then accrue by hand."
        )
        log.error("%s", message)
        await _record_refusal(
            actor,
            agency_id,
            AccrualOutcome.REFUSED_PROVISIONAL,
            message,
            {
                "period": span,
                "would_have_accrued_minor": total_minor,
                "slab_source": preview["slab_table"]["source"],
                "warnings": preview["warnings"],
            },
        )
        raise _refusal(AccrualOutcome.REFUSED_PROVISIONAL, message, common)

    bound = int(settings.service_accrual_max_minor)
    if total_minor > bound:
        message = (
            f"Commission for {agency_name} in {span} came to "
            f"{commission_svc.rupee_text(total_minor)}, above the "
            f"{commission_svc.rupee_text(bound)} an unattended run may accrue for "
            f"one agency in one period. NOTHING WAS CREDITED. Billing was "
            f"{commission_svc.rupee_text(preview['billing']['billing_minor'])} at "
            f"{preview['breakdown']['rate_percent']}%. Check the ledger, then "
            "accrue it as a team admin — the bound applies to the machine, not to "
            "a person who has looked."
        )
        log.error("%s", message)
        await _record_refusal(
            actor,
            agency_id,
            AccrualOutcome.REFUSED_BOUND,
            message,
            {
                "period": span,
                "would_have_accrued_minor": total_minor,
                "bound_minor": bound,
                "billing_minor": preview["billing"]["billing_minor"],
                "rate_percent": preview["breakdown"]["rate_percent"],
                "band": preview["breakdown"]["band"],
            },
        )
        raise _refusal(AccrualOutcome.REFUSED_BOUND, message, common)

    if total_minor <= 0:
        return {
            **common,
            "outcome": AccrualOutcome.NOTHING_TO_ACCRUE,
            "credited_minor": 0,
            "message": preview["breakdown"]["explanation"],
            "breakdown": preview["breakdown"],
        }

    try:
        result = await svc.accrue_commission(
            agency_id,
            period,
            actor,
            host_id="",           # the machine never accrues a single host
            since=body.since,
            until=body.until,
            expected_amount_minor=total_minor,
            reason=body.reason or f"Weekly accrual (automated) — {span}",
        )
    except PartnerOpsError as exc:
        if ALREADY_ACCRUED_MARKER in str(exc):
            return {
                **common,
                "outcome": AccrualOutcome.ALREADY_ACCRUED,
                "credited_minor": 0,
                "message": str(exc),
            }
        log.error(
            "Unattended accrual for %s in %s was refused: %s", agency_id, span, exc
        )
        raise _fail(exc) from exc

    return {**result, "outcome": AccrualOutcome.ACCRUED, "unattended": True}


@router.post(
    "/agencies/{agency_id}/commission-accruals", status_code=status.HTTP_201_CREATED
)
async def accrue_commission(
    agency_id: str,
    body: CommissionAccrual,
    user: dict = Depends(team_admin_or_accrual_service),
):
    """Credit earned commission — the weekly payout run.

    **The server computes the amount.** Billing is derived from the ledger for
    the period given, the live slab table selects one band, and that band's rate
    applies to the whole figure. Any `amount_minor` in the body is treated as a
    check and the request is refused if it disagrees.

    Idempotent on agency + host + period, so re-running a period cannot accrue
    twice, and audited with the full derivation — band, rate, billing, per-host
    shares.

    **Authority.** A team admin, not any writer: an accrual creates a liability
    the business will pay, so it is not routine team work. It stops short of an
    owner signature because no cash leaves here — the payment itself is a card
    (`/commission-payouts`) and still needs one.

    **Or the weekly accrual credential.** The Sunday job presents
    `X-Service-Key` and is resolved to the system actor `system:weekly-accrual`,
    which is the actor recorded on every ledger movement and audit entry it
    writes. It takes the stricter path in `_accrue_unattended` — preview first,
    refuse a provisional slab table, refuse a total above the sanity bound,
    report a zero week as a zero rather than an error — because there is nobody
    in front of it. A team admin's request is untouched by any of that.

    **`can_process_payout` for the person.** An accrual is the step immediately
    before money leaves — it creates the liability a commission payout then
    pays — so it belongs to Finance and the owners, not to whichever of the six
    department admins happens to be looking at the agency screen. Checked in the
    body rather than the decorator for the same reason as `POST /partners`: the
    Sunday job presents a service key and no session, and a dependency starting
    from `current_user` would refuse it before `is_service_actor` ever ran.
    """
    if is_service_actor(user):
        return await _accrue_unattended(agency_id, body, user)

    await enforce_permission(user, Permission.CAN_PROCESS_PAYOUT)
    try:
        return await svc.accrue_commission(
            agency_id,
            body.period,
            user,
            host_id=body.host_id,
            since=body.since,
            until=body.until,
            expected_amount_minor=body.amount_minor,
            reason=body.reason,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Host bean withdrawal
# ══════════════════════════════════════════════════════════════════════════════
#
# The two halves of paying a host. The request is team work and the execution is
# an owner's, exactly as for a commission payout — and for the same reason: the
# signature is the moment the beans leave the host's wallet and the money leaves
# the bank.
#
# **No partner reaches either of these**, and the host reaches neither. A host
# does not raise their own payout here; the weekly release decides what is
# available and staff raise the card against it.


@router.post(
    "/hosts/{host_uid}/withdrawals",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_PROCESS_PAYOUT],
)
async def request_host_withdrawal(
    host_uid: str, body: HostWithdrawal, user: dict = Depends(require_write)
):
    """Raise a host withdrawal card. Refused if it exceeds what is available.

    `host_uid` is a **Firebase uid**, not a partner record id — a host is a user
    of the app, and their beans live on `users/{uid}`.
    """
    try:
        return await svc.request_host_withdrawal(
            host_uid, body.beans, body.reason, user,
            request_collection=body.request_collection, request_id=body.request_id,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/host-withdrawals/{card_id}/execute", dependencies=[_PROCESS_PAYOUT])
async def execute_host_withdrawal(
    card_id: str, body: PaidReason, user: dict = Depends(require_owner)
):
    """Debit the host's wallet, write the ledger row, record the bank reference.

    The Firestore debit is guarded by a transaction that re-reads
    `beansAvailable`, so a card signed before the host converted beans away is
    refused here rather than overdrawing them.
    """
    try:
        return await svc.execute_host_withdrawal(card_id, body.payment_ref, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Sub-agency — paid through the parent. Spec 4.2.4
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/subagency-payouts/open")
async def open_subagency_payouts(
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """Payouts not yet closed — our money has left, and the sub-agency has not
    been confirmed paid. This is what makes 4.2.4 enforceable.

    Staff see every open payout in the business, exactly as before. **An agency
    sees the ones it is a party to** — the payouts it is the parent of (4.2.6:
    the ones it owes a second leg on) and the ones it is the sub of (4.2.4:
    money that reaches it through its parent and no other way).

    That is not a nicety. Leg 1 debits the *sub's* commission balance
    (`services/partner_ops.execute_subagency_payout`), so the figure on
    `/partners/agencies/{id}/sub-agencies` drops to zero the moment Zipper pays
    the **parent** — before the sub has seen anything. Read on its own it says
    "settled" when the true reading is "we have handed it to your parent". This
    route is the only place either side can tell those apart.

    The filter is on the payout's own `parent_id` / `sub_id` against the ids on
    the session, so it is applied in the query rather than trusted to a screen —
    the CRM filters the same way client-side, which is a display convenience and
    was never a control. A session with no agency record on it is refused rather
    than answered with an empty list: "you hold no agency" and "nothing is open
    against you" are different facts and a payout list is the wrong place to
    blur them.
    """
    if R.is_internal(user["role"]):
        return await svc.open_subagency_payouts(limit)

    own = partner_ids_of(user, "agency")
    if not own:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This is an agency view. Your session holds no approved agency "
                "record, so there are no sub-agency payouts to show."
            ),
        )
    return await svc.open_subagency_payouts(limit, partner_ids=own)


@router.post(
    "/subagency-payouts",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_PROCESS_PAYOUT],
)
async def request_subagency_payout(
    body: SubAgencyPayout, user: dict = Depends(require_write)
):
    """Raise a sub-agency payout, recording both legs from the start."""
    try:
        return await svc.request_subagency_payout(
            body.parent_id, body.sub_id, body.amount_minor, body.reason, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/subagency-payouts/{card_id}/execute", dependencies=[_PROCESS_PAYOUT])
async def execute_subagency_payout(
    card_id: str, body: PaidReason, user: dict = Depends(require_owner)
):
    """Leg 1 — we pay the main agency. The payout stays open."""
    try:
        return await svc.execute_subagency_payout(card_id, body.payment_ref, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/subagency-payouts/{payout_id}/confirm-leg", dependencies=[_PROCESS_PAYOUT])
async def confirm_subagency_leg(
    payout_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Leg 2 — the main agency confirms it paid the sub. The payout closes."""
    try:
        return await svc.confirm_subagency_leg(payout_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Applying from the app. See `services/partner_applications`.
# ══════════════════════════════════════════════════════════════════════════════
#
# Reached by the Cloud Function callables with the partner-registration
# service key, carrying the signed-in user's uid — or by a team admin filing
# on somebody's behalf. The uid is a body field here because the caller is a
# machine speaking for a user; the callable copies it from `context.auth` and
# the app cannot set it. Every rule is applied in the service, server-side.


class PartnerApplication(BaseModel):
    applicant_uid: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern="^(agency|sub_agency|seller)$")
    form: dict = Field(default_factory=dict)
    parent_id: str | None = Field(default=None, max_length=128)


class HostApplication(BaseModel):
    applicant_uid: str = Field(min_length=1, max_length=128)
    form: dict = Field(default_factory=dict)
    parent_id: str = Field(min_length=1, max_length=128)


@router.get("/applications/eligibility/{uid}")
async def application_eligibility(
    uid: str, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """What this user may apply for, from authoritative records — the app's
    "Join as …" list is exactly this, and nothing is decided client-side."""
    try:
        return await applications.eligibility(uid)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.get("/applications/parents")
async def application_parents(
    for_kind: str = Query(default="sub_agency", pattern="^(sub_agency|host)$"),
    user: dict = Depends(team_admin_or_partner_apply_service),
):
    """Approved, active agencies a sub-agency (main only) or a host (main and
    sub) may join. The app shows this list; the server re-validates the pick."""
    return await applications.eligible_parents(for_kind)


@router.get("/applications/of/{uid}")
async def applications_of(
    uid: str, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """Every partner-role application this user has, with status."""
    return await applications.applications_of(uid)


@router.post("/applications", status_code=status.HTTP_201_CREATED)
async def submit_partner_application(
    body: PartnerApplication, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """Apply as Agency, Sub-agency or Coin Seller. Pending; approves nothing."""
    try:
        return await applications.submit_partner_application(
            body.applicant_uid, body.kind, body.form, body.parent_id, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Decision 15 (RC) — approved roles that wait for BOTH verified contacts.
# ══════════════════════════════════════════════════════════════════════════════
#
# Two doors onto the same service (`services/partner_activation`): the app,
# through the callables with the partner-registration service key and the
# signed-in uid in the body; and a CRM partner's own session (`/me/...`,
# allowlisted in `core/deps.PARTNER_ROUTES` for pending and waiting logins).
# Neither starts a role on the caller's word — the verification is re-read
# from Firebase Auth and the server's ledger, and the role table, restriction
# and parent are re-checked as at any approval.


class VerificationCheck(BaseModel):
    applicant_uid: str = Field(min_length=1, max_length=128)


class ContactConflict(BaseModel):
    """The app's door (service key): the signed-in uid travels in the body."""

    applicant_uid: str = Field(min_length=1, max_length=128)
    contact: str = Field(pattern="^(phone|email)$")
    value: str = Field(min_length=3, max_length=320)


class MyContactConflict(BaseModel):
    """A CRM partner's own door. Deliberately NO account field: the subject is
    the session (`own_session_uid`), so this body cannot name anybody else."""

    contact: str = Field(pattern="^(phone|email)$")
    value: str = Field(min_length=3, max_length=320)


@router.get("/applications/verification/{uid}")
async def verification_of(uid: str, user: dict = Depends(team_admin_or_partner_apply_service)):
    """What is verified on this account, and which approved roles wait for it."""
    return await activation_svc.overview(uid)


@router.post("/applications/verification/check")
async def verification_check(
    body: VerificationCheck, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """Re-read this person's verification and start every waiting role it allows."""
    try:
        return await activation_svc.check_and_activate(body.applicant_uid, activation_svc.activation_actor(body.applicant_uid, user))
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/applications/verification/conflict")
async def verification_conflict(
    body: ContactConflict, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """The contact this person tried to verify is held by another account.

    The answer is the same whether or not a conflict was found, so this is not
    a way to ask "does some account hold this number?".
    """
    await activation_svc.report_conflict(
        body.applicant_uid, body.contact, body.value, activation_svc.activation_actor(body.applicant_uid, user)
    )
    return {"received": True}


@router.get("/me/verification")
async def my_verification(user: dict = Depends(current_user)):
    """A CRM partner's own login: what is verified, what is missing, what waits."""
    return await activation_svc.overview(own_session_uid(user))


@router.post("/me/verification/check")
async def my_verification_check(user: dict = Depends(require_write_or_partner)):
    """A CRM partner's own login: re-check, and start what is now allowed.

    Self-scoped: no id is taken from the request. Allowlisted in
    `core/deps.PARTNER_REACHABLE`; the observer is refused by the guard.
    """
    uid = own_session_uid(user)
    try:
        return await activation_svc.check_and_activate(uid, activation_svc.activation_actor(uid, user))
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/me/verification/conflict")
async def my_verification_conflict(
    body: MyContactConflict, user: dict = Depends(require_write_or_partner)
):
    """A CRM partner's own login: the phone or email they tried belongs to another account.

    Self-scoped, and answered the same whether or not a conflict was found.
    """
    uid = own_session_uid(user)
    await activation_svc.report_conflict(uid, body.contact, body.value, activation_svc.activation_actor(uid, user))
    return {"received": True}


# ══════════════════════════════════════════════════════════════════════════════
# Decision 16 (RC) — a fresh Sub-agency application after a rejection.
# ══════════════════════════════════════════════════════════════════════════════


class SubAgencyReapply(BaseModel):
    """What the parent agency's Add Sub-Agency form collected, for a person
    whose login already exists from an application that was rejected."""

    email: str = Field(min_length=3, max_length=320)
    form: dict = Field(default_factory=dict)
    reason: str = Field(default="", max_length=2000)


@router.post("/agencies/{agency_id}/sub-agencies/reapply", status_code=status.HTTP_201_CREATED)
async def reapply_sub_agency(
    agency_id: str, body: SubAgencyReapply, user: dict = Depends(require_write_or_partner)
):
    """File a NEW pending Sub-agency application under `agency_id` for a person
    whose earlier Sub-agency application was rejected.

    A partner may name only its OWN agency (`_own_id_or_403`, kind agency);
    staff need team-admin authority, as for creating any partner record. The
    rejected record and its history are untouched; the new one is a separate
    record, pending, holding nothing (`partner_applications.reapply_sub_agency`).
    """
    parent_id = _own_id_or_403(user, agency_id, kind="agency")
    if R.is_internal(user["role"]) and not (
        R.is_team_admin(user["role"]) or R.is_owner(user["role"])
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Filing a partner application for somebody needs a team admin or an Owner.",
        )
    try:
        return await applications.reapply_sub_agency(
            parent_id, body.email, body.form, user, reason=body.reason,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# RC (confirmed, CRM-FLOW 9.48) — money frozen by a suspension, ban or revocation
# ══════════════════════════════════════════════════════════════════════════════


class FreezeDecision(BaseModel):
    decision: str = Field(pattern="^(release|withhold|adjust)$")
    note: str = Field(min_length=5, max_length=2000)
    adjustment: dict | None = None


@router.get("/frozen-money")
async def list_frozen_money(status: str | None = Query(default=None), user: dict = Depends(require_owner)):
    """The Owner's queue: every subject whose money is frozen (or was decided)."""
    from app.services import money_freeze

    return {"freezes": await money_freeze.list_freezes(status)}


@router.post("/frozen-money/{freeze_key}/decide")
async def decide_frozen_money(freeze_key: str, body: FreezeDecision, user: dict = Depends(require_owner)):
    """Release, withhold or adjust a frozen subject's money. Owner only, with a note."""
    from app.services import money_freeze

    try:
        return await money_freeze.decide(freeze_key, body.decision, body.note, user, adjustment=body.adjustment)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/partners/{partner_id}/activate", dependencies=[_APPROVE_PARTNER])
async def activate_partner(partner_id: str, user: dict = Depends(require_write)):
    """Staff: start an Owner-approved role whose contacts are now verified. Never bypasses them."""
    try:
        return await svc.activate_partner_if_verified(partner_id, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/applications/host", status_code=status.HTTP_201_CREATED)
async def submit_host_application(
    body: HostApplication, user: dict = Depends(team_admin_or_partner_apply_service)
):
    """Apply as Host under a chosen agency or sub-agency. Pending; the role is
    granted — UNVERIFIED — only when a reviewer approves."""
    try:
        return await applications.submit_host_application(
            body.applicant_uid, body.form, body.parent_id, user
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
# Manual recharge through a Coin Seller. See `services/recharges`.
# ══════════════════════════════════════════════════════════════════════════════
#
# Filing is the buyer's act (through the app's callable, with the service key)
# and moves nothing. Approving is a MONEY decision — seller coins become buyer
# diamonds — so it carries the same authority as approving a seller sale:
# `CAN_COIN_OPERATIONS` plus an owner session. Refund decisions likewise.


class RechargeRequest(BaseModel):
    buyer_uid: str = Field(min_length=1, max_length=128)
    seller_id: str = Field(min_length=1, max_length=128)
    diamonds: int = Field(gt=0, le=1_000_000)
    amount_minor: int = Field(gt=0, le=1_000_000_000)
    currency: str = Field(default="INR", max_length=8)
    payment_method: str = Field(min_length=2, max_length=24)
    reference: str = Field(default="", max_length=128)
    proof_url: str = Field(default="", max_length=2048)
    #: RF-30: one id per recharge form, the same on every retry of it. Optional
    #: (older apps send none); its shape is checked by `services/recharges`.
    client_request_id: str = Field(default="", max_length=64)


class RefundDecision(Reason):
    approve: bool


@router.post("/recharges", status_code=status.HTTP_201_CREATED)
async def submit_recharge(
    body: RechargeRequest, user: dict = Depends(team_admin_or_recharge_request_service)
):
    """A buyer says they paid a seller. Pending; nothing moves."""
    try:
        return await recharges_svc.submit_recharge(
            body.buyer_uid, body.seller_id, diamonds=body.diamonds,
            amount_minor=body.amount_minor, currency=body.currency,
            payment_method=body.payment_method, reference=body.reference,
            proof_url=body.proof_url, actor=user,
            client_request_id=body.client_request_id,
        )
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.get("/recharges")
async def list_recharges(
    recharge_status: str | None = Query(default=None, alias="status"),
    seller_id: str | None = Query(default=None),
    buyer_uid: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    user: dict = Depends(current_user),
):
    """The queue. A seller session sees only its own; staff see all.

    Plain session, like `list_sales`: the scoping is done here, by partner id,
    and a staff session needs no write capability to read a queue."""
    if not R.is_internal(user["role"]):
        own = sorted(partner_ids_of(user))
        if not own or (seller_id and seller_id not in own):
            return []
        seller_id = seller_id or own[0]
        buyer_uid = None
    return await recharges_svc.list_recharges(recharge_status, limit, seller_id, buyer_uid)


@router.get("/recharges/{recharge_id}")
async def get_recharge(recharge_id: str, user: dict = Depends(current_user)):
    try:
        doc = await recharges_svc.get_recharge(recharge_id)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc
    if not R.is_internal(user["role"]) and doc.get("seller_id") not in partner_ids_of(user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No recharge request with that id.")
    return doc


@router.post("/recharges/{recharge_id}/approve", dependencies=[_COIN_OPS])
async def approve_recharge(
    recharge_id: str, body: Reason, user: dict = Depends(require_owner)
):
    """Payment verified: seller coins → buyer diamonds, exactly once."""
    try:
        return await recharges_svc.approve_recharge(recharge_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/recharges/{recharge_id}/reject", dependencies=[_COIN_OPS])
async def reject_recharge(
    recharge_id: str, body: Reason, user: dict = Depends(require_write)
):
    try:
        return await recharges_svc.reject_recharge(recharge_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/recharges/{recharge_id}/refund", dependencies=[_COIN_OPS])
async def request_recharge_refund(
    recharge_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Open a refund review. Nothing moves until it is decided."""
    try:
        return await recharges_svc.request_refund(recharge_id, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc


@router.post("/recharges/{recharge_id}/refund/decide", dependencies=[_COIN_OPS])
async def decide_recharge_refund(
    recharge_id: str, body: RefundDecision, user: dict = Depends(require_owner)
):
    """Approve the refund (takes back only what is still there) or refuse it."""
    try:
        return await recharges_svc.decide_refund(recharge_id, body.approve, body.reason, user)
    except PartnerOpsError as exc:
        raise _fail(exc) from exc
