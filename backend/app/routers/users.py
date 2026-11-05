"""User, moderation and reports endpoints.

Moderation is direct (5.6), so these take effect on the call. Money is not:
a balance change raises a card and only moves once an owner has signed it.

Every mutating endpoint requires a reason. That is not a formality — the reason
is what the audit log stores, and `GET /users/{uid}/history` is only worth
reading if the reasons are there.

Live-room intervention (8.7.3) lives here rather than in a router of its own,
because it is moderation: ending a stream or muting a host is an act against a
person's broadcast, decided on the spot, recorded with a reason, and it belongs
beside the ban and the warning it will usually be raised alongside. Two routes,
both `require_write` plus an ops-or-owner narrowing, and neither is reachable by
a partner.

── Permissions ───────────────────────────────────────────────────────────────

Every write below now also declares the capability it needs, in the decorator,
**beside** the guard it already had rather than instead of it. `require_write`
answered "you are internal and you are not the observer", which admitted a
marketing member to `POST /{uid}/ban` and a tech member to a balance request.
`app/core/roles.PERMISSIONS` is what answers the rest, and it is the same table
the CRM greys its buttons from.

Two deliberate omissions, both because the matching permission would refuse the
role the spec puts in charge:

  * **the live-room pair** keeps `_require_intervener` and gains nothing.
    `can_monitor_live` belongs to the App department (and owners); ending a
    stream belongs to Ops (8.7.3), which does not hold it. Ending a broadcast is
    moderation, not monitoring, and gating it on the monitor's permission would
    take the control away from the only team that has it.
  * **`/{uid}/warn`** asks for `can_view_users` rather than `can_ban_users`. A
    warning is the lightest thing on this screen and Support issues most of
    them; Support holds `can_view_users` and not `can_ban_users`, which is the
    table saying exactly that. `can_view_users` here means "may be on the user
    moderation screen at all" — it still refuses Tech, Marketing, and both
    members who are only there to read agency and seller lists.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from google.api_core.exceptions import FailedPrecondition

from app.core.firestore_errors import index_unavailable
from app.core.deps import (
    current_user,
    enforce_permission,
    require_owner,
    require_permission,
    require_write,
)
from app.core.roles import Permission
from app.services import appeals as appeals_svc
from app.services import live as live_svc
from app.services import cards as cards_svc
from app.services import users as svc
from app.services.appeals import AppealError, AppealNotFound, AppealStatus
from app.services.live import LiveError
from app.services.money import Currency
from app.services.users import (
    DeviceType,
    OwnerOnly,
    ReportAction,
    ReportStatus,
    UserError,
    UserNotFound,
    ProtectedTarget,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


def _fail(exc: UserError) -> HTTPException:
    # 403 for a protected target, not 400: the request is well-formed and the
    # caller is authenticated — they are simply not permitted against this
    # subject. A 400 would read as "you sent something wrong" and send them
    # looking for a typo.
    if isinstance(exc, (ProtectedTarget, OwnerOnly)):
        code = status.HTTP_403_FORBIDDEN
    else:
        code = (
            status.HTTP_404_NOT_FOUND
            if isinstance(exc, UserNotFound)
            else status.HTTP_400_BAD_REQUEST
        )
    # HT-2: a refusal that carries its own status says so — 409 "not recorded,
    # decide again" or 503 "could not be confirmed". No older refusal sets one.
    code = getattr(exc, "status_code", None) or code
    # Decision 15 (RC): a refusal that carries a machine-readable detail (the
    # both-contacts rule) keeps it, so the CRM can show what is missing.
    structured = getattr(exc, "api_detail", None)
    return HTTPException(status_code=code, detail=structured() if callable(structured) else str(exc))


def _live_fail(exc: LiveError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


def _require_intervener(user: dict) -> dict:
    """Ops or an owner. Spec 3.4.5 / 8.7.3.

    Applied in the route rather than as a dependency in `app/core/deps.py`,
    because it is this route pair's rule and not a tier of the authority model —
    the shared guards are role *tiers* and a fourth one that meant "ops, plus
    owners" would be a tier nothing else uses.

    `require_write` has already run, so the observer (1.1.4) and every external
    partner are gone before this is consulted. What this adds is that the app,
    tech, support, finance and marketing teams — who can all reach `/live` to
    watch — cannot cut somebody's broadcast off.
    """
    if not live_svc.may_intervene(user["role"]):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Ending or muting a live stream is done by Ops or a business "
                "owner. Warning or banning the host is open to you."
            ),
        )
    return user


# ── Bodies ────────────────────────────────────────────────────────────────────


class Reason(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


class WarnDeduction(BaseModel):
    """UGP-D: the optional deduction on a warning. The server decides whether
    this currency is the right one for the person's roles, and whether the live
    balance covers it — this only bounds the shape."""

    currency: str = Field(pattern=r"^(diamonds|beans)$")
    #: Strict (UGP review): JSON `true` is not 1 and `"5"` is not 5.
    amount: int = Field(ge=1, le=10_000_000, strict=True)


class Warn(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)
    deduction: WarnDeduction | None = None
    #: One id per click in the CRM. A retried request with the same id returns
    #: the first outcome instead of a second warning (UGP-D).
    request_id: str | None = Field(
        default=None, min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"
    )


class HostDecision(BaseModel):
    """A decision on one host application.

    `approve` is a boolean rather than two endpoints so that the approve path
    and the reject path cannot drift apart — the whole reason this route exists
    is that a host's two status fields were written by different code.

    The reason is mandatory on both, exactly as it is for a partner: a refused
    applicant is told why instead of being left to reapply into the same queue,
    and it is stored on the application as well as in the audit entry.
    """

    approve: bool
    reason: str = Field(min_length=3, max_length=1000)


class SellerFlag(BaseModel):
    is_seller: bool
    reason: str = Field(min_length=3, max_length=1000)


class BalanceRequest(BaseModel):
    currency: Currency
    amount: int = Field(description="Positive credits, negative debits.")
    reason: str = Field(min_length=3, max_length=1000)


class Ban(BaseModel):
    """A ban: the reason, and (§5) its scope, category and evidence.

    `scope` — `account_and_devices` (the default, and what the ban has always
    done) bars every handset the account was seen on; `account` leaves the
    handsets alone. `category` is a short label from the CRM's list; `evidence`
    is a list of references (report ids, storage paths, links) — never files.
    All three are recorded on the account and on the audit entry.
    """

    reason: str = Field(min_length=3, max_length=1000)
    scope: str = Field(default="account_and_devices", pattern=r"^(account|account_and_devices)$")
    category: str = Field(default="", max_length=80)
    evidence: list[str] = Field(default_factory=list, max_length=10)


class Suspend(BaseModel):
    """A suspension, with an optional term.

    `days` is here — and not only on the reports queue, where it has always
    been — because without it every suspension raised from the user screen was
    indefinite, and `lift_expired_suspensions` could never end one. A reviewer
    who meant "three days" had to come back and lift it by hand, and if nobody
    remembered, "three days" was for ever.

    Omitted means indefinite, deliberately: "off the platform while we
    investigate" is a real decision and it has no end date until somebody makes
    one. The bounds are the service's own (1 to 365) restated here so a bad
    number is refused before it reaches Firestore.
    """

    reason: str = Field(min_length=3, max_length=1000)
    days: int | None = Field(
        default=None,
        ge=1,
        le=365,
        description="Suspension length in days. Omit for 'until a human lifts it'.",
    )


class HostSuspend(BaseModel):
    """A suspension of the HOST ROLE only (§5), with an optional term.

    Ten characters of reason, not three: the host and their agency are both
    told it. `days` is the account suspension's bound (1 to 365); omitted means
    "until somebody resumes it", and the daily run lifts a timed one.
    """

    reason: str = Field(min_length=10, max_length=1000)
    days: int | None = Field(
        default=None,
        ge=1,
        le=365,
        description="Suspension length in days. Omit for 'until the Host role is resumed'.",
    )


class DeviceBan(BaseModel):
    device_id: str = Field(min_length=1, max_length=200)
    device_type: DeviceType
    reason: str = Field(min_length=3, max_length=1000)
    user_uids: list[str] = Field(default_factory=list)
    #: Ops placed this ban on the handset's own evidence, not as a consequence
    #: of banning an account. It is what stops an unrelated account's unban
    #: deleting the record later.
    #:
    #: **Defaults to true, and that is the safe direction.** Every caller of
    #: this endpoint is a person looking at the device ban list, so a ban raised
    #: here IS an Ops decision by construction — and a CRM build that does not
    #: send the field yet gets a ban that survives rather than one that can be
    #: swept away by somebody else's unban. The cascade inside `ban_user` does
    #: not come through here and passes `manual=False` itself.
    manual: bool = True


class ReportDecision(BaseModel):
    """What a reviewer decided, and how much of it.

    `days` and `beans` each belong to exactly one action — the service refuses
    them anywhere else rather than ignoring them, because a reviewer who types
    a number into the wrong box has misunderstood what they are about to do.
    """

    action: ReportAction
    reason: str = Field(min_length=3, max_length=1000)
    #: Suspension length. Omit for "until a human lifts it".
    days: int | None = Field(default=None, ge=1, le=365)
    #: Beans to take back, as a positive quantity. Raises a card; moves nothing.
    beans: int | None = Field(default=None, ge=1)


class LiveReason(BaseModel):
    """A live-room intervention. Spec 8.7.4 — every one is logged with a reason.

    Six characters rather than the three every other body here asks for. This is
    a broadcast being cut off in front of an audience, and "ok" is not a reason
    somebody will be able to read back in six months.
    """

    reason: str = Field(min_length=6, max_length=1000)


class MuteHost(BaseModel):
    """Set or clear a host's mute flag. Both directions carry a reason."""

    muted: bool
    reason: str = Field(min_length=6, max_length=1000)


# ── Live rooms — 8.7.3 / 8.7.4 ────────────────────────────────────────────────
# Declared before the /{uid} routes so a literal path is never shadowed.


@router.post("/live-rooms/{room_id}/end")
async def end_live_room(
    room_id: str, body: LiveReason, user: dict = Depends(require_write)
):
    """End a live stream. Ops or an owner, audited, reason mandatory. Spec 8.7.3.

    **The gap this closes.** `/live` has carried a disabled End button with the
    reason written on it, because there was no endpoint. Before that there was
    something worse: the CRM wrote `isActive: false` onto the Firestore room
    document straight from the browser — a change with no actor, no reason and
    no audit entry, where the only evidence a stream had been cut was that it
    had stopped. That control was removed rather than fixed. This replaces it
    properly.

    **What it does, exactly.** It flags `liveRooms/{room_id}` inactive and
    writes who, when and why beside it. The stream itself is carried by the
    media provider; it stops when the host's client reads the flag and drops the
    room, so it can stay visible in the app for a moment afterwards. The
    response says so and the CRM prints it — an End button that implies the
    video is severed the instant it is pressed would be lying about what it did.

    **What it does not do.** It does not ban, suspend or warn the host, and it
    does not touch their account at all. If the behaviour warrants that, it is
    `POST /users/{uid}/ban` or `/warn`, which is a separate decision with its
    own reason and its own audit entry.

    **Refusals.** A room id that names nothing; a room that has already ended,
    which is refused rather than answered "done" so a double press cannot look
    like two interventions; a reason under six characters; a role outside Ops
    and the owners; the observer, and every partner account.
    """
    _require_intervener(user)
    try:
        return await live_svc.end_room(room_id, body.reason, user)
    except LiveError as exc:
        raise _live_fail(exc) from exc


@router.post("/party-rooms/{room_id}/end")
async def end_party_room(
    room_id: str, body: LiveReason, user: dict = Depends(require_write)
):
    """O12 (5 Nov 2026): close a party room from the CRM's party monitor. Ops or an owner, audited, reason mandatory.

    The party twin of `/live-rooms/{room_id}/end`: the room is flagged closed with who and why, its seats removed and
    everybody's in-party flag cleared (the app's own teardown), so each phone in it leaves. Not a ban.
    """
    _require_intervener(user)
    try:
        return await live_svc.end_party_room(room_id, body.reason, user)
    except LiveError as exc:
        raise _live_fail(exc) from exc


@router.post("/live-rooms/{room_id}/mute")
async def mute_live_host(
    room_id: str, body: MuteHost, user: dict = Depends(require_write)
):
    """Mute or unmute a live host. Ops or an owner, audited. Spec 8.7.3.

    **This records a decision and cannot enforce one, and says so.** The host's
    audio is published by their device to the media provider; this API is not in
    that path and has no way to silence anybody. What it writes is `hostMuted`
    on the room document — an instruction the **Android app must honour** by
    stopping the host's audio publisher. Until the app reads that flag, muting
    here changes nothing the audience can hear.

    That sentence comes back on every response as `app_must_honour`, and the CRM
    shows it verbatim. A mute button that reports success into a room still
    making noise is worse than no button at all, so the limitation is on the
    screen rather than in a comment.

    Unmuting is the same route with `muted: false`, and carries its own reason:
    lifting an intervention is an intervention.
    """
    _require_intervener(user)
    try:
        return await live_svc.mute_host(room_id, body.muted, body.reason, user)
    except LiveError as exc:
        raise _live_fail(exc) from exc


# ── Device bans ───────────────────────────────────────────────────────────────
# Declared before the /{uid} routes so a literal path is never shadowed.


@router.get("/devices/bans")
async def list_banned_devices(
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """Currently banned devices, newest first."""
    return await svc.list_banned_devices(limit)


@router.post(
    "/devices/bans",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
)
async def ban_device(body: DeviceBan, user: dict = Depends(require_write)):
    """Ban a device. The document is keyed by the device id, which is the path
    the Android app actually reads — anything else is a ban that never applies.

    A ban raised here is marked `manualBan` unless the caller says otherwise,
    which makes it **Ops' own decision about this handset** rather than a
    consequence of some account. That matters because unbanning an account
    lifts the device bans that account caused, and before the mark existed an
    independent Ops ban was deleted by the first unban that came near it.
    """
    try:
        return await svc.ban_device(
            body.device_id,
            str(body.device_type),
            body.reason,
            body.user_uids,
            user,
            manual=body.manual,
        )
    except UserError as exc:
        raise _fail(exc) from exc


@router.post(
    "/devices/bans/{device_id}/unban",
    dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
)
async def unban_device(
    device_id: str, body: Reason, user: dict = Depends(require_write)
):
    """Lift a device ban. The document is removed, because the app only checks
    whether it exists; the audit entry keeps the history.

    Unconditional, unlike the release that rides along with `POST
    /users/{uid}/unban`: this is a decision about the handset itself, so it
    lifts the ban whatever caused it — including a `manualBan` and including
    one still naming banned accounts. The audit entry records both, so what was
    overridden stays readable."""
    try:
        return await svc.unban_device(device_id, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc


# ── Reports queue ─────────────────────────────────────────────────────────────


@router.get("/reports")
async def list_reports(
    report_status: ReportStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """The reports queue, newest first."""
    return await svc.list_reports(
        str(report_status) if report_status else None, limit
    )


#: Which capability each verdict on the reports queue costs, beyond being
#: allowed on the queue at all. The action is in the body, so it cannot be a
#: dependency — a route-level gate would have to demand the strongest of them
#: from everybody, which would take `dismiss` away from Support and leave the
#: queue unworkable for the team that lives in it.
_REPORT_ACTION_PERMISSION: dict[str, Permission] = {
    str(ReportAction.SUSPEND): Permission.CAN_BAN_USERS,
    str(ReportAction.BAN): Permission.CAN_BAN_USERS,
    # A deduction raises a card and moves nothing, but it is still a balance
    # decision and it is the reason the queue can reach money at all.
    str(ReportAction.DEDUCT): Permission.CAN_ADJUST_BALANCE,
    # `warn` and `dismiss` need nothing further: they cost the account no money
    # and no access, and `can_view_users` below is already the whole of who
    # should be reading this queue.
}


@router.post(
    "/reports/{report_id}/action",
    dependencies=[Depends(require_permission(Permission.CAN_VIEW_USERS))],
)
async def action_report(
    report_id: str, body: ReportDecision, user: dict = Depends(require_write)
):
    """Decide a report and carry the decision out.

    `warn`, `suspend` and `ban` take effect immediately. `deduct` raises a card
    on the money board and moves nothing until an owner signs it. `dismiss`
    touches the account at all. The report is linked to whatever resulted, and
    both halves are audited.

    Authority is in two parts because the decision is in the body. Reaching the
    queue is `can_view_users`; the verdict that bans somebody or takes beans
    back costs its own capability on top — see `_REPORT_ACTION_PERMISSION`. That
    split is what lets a support member dismiss a vexatious report without also
    being able to ban the person it is about."""
    permission = _REPORT_ACTION_PERMISSION.get(str(body.action))
    if permission is not None:
        await enforce_permission(user, permission)
    try:
        return await svc.action_report(
            report_id,
            str(body.action),
            body.reason,
            user,
            days=body.days,
            beans=body.beans,
        )
    except UserError as exc:
        raise _fail(exc) from exc


# ── Appeals — the return path ─────────────────────────────────────────────────


class AppealDecision(BaseModel):
    """Uphold the original decision, or overturn it.

    The reason is ten characters rather than three because this one is read by
    the person who appealed. It is the entire answer they get, and "no" is not
    an answer — it is a second appeal waiting to be filed.
    """

    verdict: AppealStatus
    reason: str = Field(min_length=10, max_length=2000)


@router.get("/appeals")
async def list_appeals(
    appeal_status: AppealStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """The appeals queue, OLDEST first — the longest wait is a person still
    locked out, and that is the most urgent row on the screen.

    ── WHY THIS CATCHES FailedPrecondition ──────────────────────────────────

    Filtering by `status` and ordering by `createdAt` needs a composite index,
    and the one for `appeals` was never declared. Firestore raises
    `FailedPrecondition`; nothing caught it; there is no global handler; so
    the CRM got a bare `500 Internal Server Error` on four of its five tabs
    and the page said "Could not load this" with nothing to act on. The index
    now exists, but an undeployed index in some other environment must not
    look like a bug in the API again.

    503, not 500 and not a 4xx: the request was valid and the caller can do
    nothing about it. The message carries the Firestore console URL, which is
    the one piece of information that turns this from a mystery into a
    two-minute fix.
    """
    try:
        return await appeals_svc.list_appeals(
            str(appeal_status) if appeal_status else None, limit
        )
    except FailedPrecondition as exc:
        raise index_unavailable(exc, "the appeals queue") from exc


@router.get(
    "/appeals/{appeal_id}/evidence",
    dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
)
async def appeal_evidence(appeal_id: str, user: dict = Depends(current_user)):
    """Fifteen-minute signed links to an appeal's private attachments (UGP-F).

    Public-web appeals store object PATHS, never download URLs, so the
    attachments are readable only through this route.

    UGP review: `can_ban_users` — the permission that DECIDES appeals, and the
    tier the in-app evidence already has in `storage.rules` — rather than any
    signed-in staff member; and every opening is audited. The statement stays
    readable to whoever may read the queue, as before."""
    from app.core import audit as audit_mod
    from app.services import public_appeals as pub

    try:
        links = await pub.evidence_links(appeal_id)
    except pub.PublicAppealError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    try:
        await audit_mod.record(
            actor=user,
            action=audit_mod.Action.APPEAL_EVIDENCE_VIEWED,
            subject_type="appeal",
            subject_id=appeal_id,
            reason="Opened the appeal's attachments.",
            meta={"attachments": len(links)},
        )
    except Exception:  # noqa: BLE001 — the reviewer still gets to see what was sent
        log.warning("appeal %s: evidence view not audited", appeal_id)
    return {"evidence": links}


class AppealRecommendation(BaseModel):
    """§5 — a reviewer's written recommendation for the Owner: `uphold` or
    `overturn`, with a note of at least ten characters (it is the record)."""

    outcome: str = Field(pattern=r"^(uphold|overturn)$")
    note: str = Field(min_length=10, max_length=2000)


@router.post(
    "/appeals/{appeal_id}/recommend",
    dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
)
async def recommend_appeal(
    appeal_id: str, body: AppealRecommendation, user: dict = Depends(require_write)
):
    """Record a recommendation on a ban / suspension appeal (§5). Lifts nothing.

    `can_ban_users` — the reviewer's tier — and never the person who made the
    decision being appealed (four eyes). The appeal stays pending; the Owners
    are told (audit + email) and decide it at `/decide`."""
    try:
        return await appeals_svc.recommend_appeal(appeal_id, body.outcome, body.note, user)
    except AppealNotFound as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except AppealError as exc:
        raise HTTPException(
            status_code=getattr(exc, "status_code", None) or status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@router.post(
    "/appeals/{appeal_id}/decide",
    dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))],
)
async def decide_appeal(
    appeal_id: str, body: AppealDecision, user: dict = Depends(require_write)
):
    """Decide an appeal, and reverse what an overturn can reverse.

    §5: the OWNER's decision. `can_ban_users` stays on the door (an Owner holds
    it; a reviewer reaching this is refused by the service with 403 and told
    to recommend instead), and the four-eyes rule holds for the Owner too: an
    Owner who made the decision being appealed cannot decide the appeal.

    `can_ban_users`, and not a lighter permission, because an overturn lifts a
    ban — the same act as `POST /{uid}/unban` arriving through the appeal that
    argued for it. Whoever may not ban may not un-ban either, and a queue that
    could quietly reverse moderation decisions without that capability would be
    the ban gate with one more step in front of it.

    The response carries `reversed` and `outstanding`: what changed, and what
    could not be changed from here. A ban lifts immediately; beans already paid
    out need a credit an owner signs, and saying "overturned" without saying so
    would be the same lie as a report marked actioned that banned nobody."""
    try:
        return await appeals_svc.decide_appeal(
            appeal_id, str(body.verdict), body.reason, user
        )
    except AppealNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    except AppealError as exc:
        # HT-2: `AppealDecisionNotRecorded` carries 409 / 503, `AppealForbidden`
        # 403; every other appeal refusal stays a 400.
        raise HTTPException(
            status_code=getattr(exc, "status_code", None) or status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


# ── Balance changes — cards, never direct writes ──────────────────────────────


@router.post(
    "/balance-cards/{card_id}/execute",
    dependencies=[Depends(require_permission(Permission.CAN_ADJUST_BALANCE))],
)
async def execute_balance_card(card_id: str, user: dict = Depends(require_owner)):
    """Move the money for a signed balance card. Owners only, and only after
    the card has been verified and signed.

    The owner gate is unchanged and is the one that matters; the capability is
    stated beside it so that this route says what it is in the same vocabulary
    the CRM does. An owner holds every permission, so nothing here narrows —
    which is the point: an owner-only route that also declared no capability
    would be the one place the money vocabulary went quiet."""
    try:
        return await svc.execute_balance_card(card_id, user)
    except UserError as exc:
        raise _fail(exc) from exc


# ── Host applications ─────────────────────────────────────────────────────────
#
# Declared above the `/{uid}/…` routes, like `/devices` and `/reports` are: the
# path is matched in declaration order and `host-applications` would otherwise
# be read as somebody's uid.


@router.post(
    "/host-applications/{application_id}/decide",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def decide_host_application(
    application_id: str, body: HostDecision, user: dict = Depends(require_write)
):
    """Approve or refuse a host application. The only writer of that decision.

    Writes `status` and `kycStatus` **together** — the two used to be written by
    three different screens, one of which wrote only one of them, so an
    application could say `status: approved` and `kycStatus: pending` and no
    screen agreed with any other about whether it had been decided. They are now
    written from one place and cannot diverge.

    It also does the thing the decision is *for*: approving makes the applicant's
    account a host attached to the inviting agency, refusing takes that back. The
    grant and the stamp are one call because the failure this closes is somebody
    writing one without the other.

    **Approval is refused when nobody has redeemed the referral code yet.** The
    app account only exists once the applicant enters their code, so there would
    be nothing to grant; the refusal says so and rejecting is still available,
    because cancelling an unredeemed invitation is a real thing a reviewer needs.

    `require_write`, the same guard as `grant-host` beside it — and it is the
    guard that matters here, because it excludes every external partner. An
    agency approving its own host applications is exactly the conflict of
    interest this review exists to prevent; the agency files the invitation,
    staff decide it.
    """
    try:
        return await svc.decide_host_application(
            application_id, body.approve, body.reason, user
        )
    except UserError as exc:
        raise _fail(exc) from exc


@router.post(
    "/host-applications/{application_id}/pending-changes/decide",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def decide_host_pending_changes(
    application_id: str, body: HostDecision, user: dict = Depends(require_write)
):
    """Apply or refuse a proposed change to a host's payout or identity details.

    Separate from the route above, and the separation is the point. That one
    decides whether the applicant becomes a host; this one decides whether their
    bank account moves. An approved host whose account number changes has not
    been re-approved, and recording it as though they had would hide the thing
    worth seeing inside an approval nobody disputes.

    A host has no dashboard, so every proposal here was written on their behalf —
    by staff, or by the agency that recruited them. `firestore.rules` therefore
    makes it four-eyes: an admin may propose, only a superadmin may write one of
    these fields straight onto the record. The service enforces the other half,
    that the proposer is not the person who applies it.

    Approving writes only the payout and identity fields the rules protect;
    anything else found in the proposal is refused and named in the response,
    because Firestore constrains which keys a proposal occupies and not what is
    inside it. Refusing writes no live field at all and stores the reason on the
    application.

    `require_write`, the same guard as deciding the application — and the guard
    that matters, because it admits no external partner. An agency applying its
    own proposal to a host it recruited is the conflict of interest this whole
    review exists to prevent.
    """
    try:
        return await svc.decide_host_pending_changes(
            application_id, body.approve, body.reason, user
        )
    except UserError as exc:
        raise _fail(exc) from exc


@router.post(
    "/{uid}/balance-request",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_permission(Permission.CAN_ADJUST_BALANCE))],
)
async def request_balance_change(
    uid: str, body: BalanceRequest, user: dict = Depends(require_write)
):
    """Raise a card to change a user's balance. Nothing moves until an owner
    signs it and `/balance-cards/{card_id}/execute` runs.

    Raising the card is not moving the money, which is why this is not
    owner-only — but it is not free either. It puts a signed-off credit or debit
    in front of an owner with somebody's name on it, and an owner working
    through a board of them is relying on whoever raised each one being entitled
    to. `can_adjust_balance` is that entitlement: App, Finance and the owners.

    Owner decision (5 Nov 2026): raised BY an Owner, the card is reviewed, verified, signed and executed in the
    same request — the balance moves now, every stage keeps its own audit entry and the other Owners are told
    (`cards.complete_if_owner`). An Owner's own account is the exception the board keeps: that card waits for
    another Owner, and the response says so (`owner_complete_error`).
    """
    try:
        card = await svc.request_balance_change(
            uid, body.currency, body.amount, body.reason, user
        )
    except UserError as exc:
        raise _fail(exc) from exc
    return await cards_svc.complete_if_owner(card, user, body.reason)


# ── Moderation ────────────────────────────────────────────────────────────────


# ── The four moderation operations ────────────────────────────────────────────
#
#                 account      device             another account on that phone?
#   ban           restricted   every one barred   no
#   unban         active       this account's     —
#                              bans lifted
#   suspend       restricted   NOT barred         yes
#   resume        active       untouched          —
#
# Ban ↔ Unban and Suspend ↔ Resume are two pairs, not one pair and two spellings.
# Each of the lifting routes refuses the other's case by name and says which one
# to use, because a CRM that offered "Unban" for a suspended account would lift
# it through code that goes looking for device bans to delete — and a suspension
# never placed one, so what it would find belongs to somebody else's decision.


#: The four moderation operations all cost the same capability. Named once so
#: that a fifth one added tomorrow is an obvious copy of a line that is already
#: there, rather than a route somebody guarded by eye.
_BAN_USERS = Depends(require_permission(Permission.CAN_BAN_USERS))


@router.post("/{uid}/ban", dependencies=[_BAN_USERS])
async def ban_user(uid: str, body: Ban, user: dict = Depends(require_write)):
    """Ban an account, and bar every handset it has been seen on. Immediate —
    moderation needs no signature (5.6).

    The device half is the part worth reading the response for. It bars every
    document under `users/{uid}/devices`, not the single `deviceId` written at
    profile setup years ago, and the response says how many handsets it actually
    reached and which ones it could not. Barring a handset locks out EVERY
    account on it, which is the point and also the cost.

    §5: `scope`, `category` and `evidence` are recorded with the reason, the
    actor and the time. A ban does not itself revoke a partner role."""
    # `getattr` rather than attribute access: a caller still sending the older
    # `{reason}` body gets the ban it always got (account and devices).
    scope = str(getattr(body, "scope", None) or svc.BAN_SCOPE_ACCOUNT_AND_DEVICES)
    try:
        return await svc.ban_user(
            uid, body.reason, user,
            ban_device_too=(scope != svc.BAN_SCOPE_ACCOUNT),
            category=str(getattr(body, "category", "") or ""),
            evidence=list(getattr(body, "evidence", None) or []),
        )
    except UserError as exc:
        raise _fail(exc) from exc


@router.post("/{uid}/unban", dependencies=[_BAN_USERS])
async def unban_user(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Lift a ban, and with it the device bans this account caused.

    The original ban reason is kept as `previousBanReason`.

    A device ban survives this when somebody else is still holding it up — a
    second banned account on the same handset, or an Ops ban placed on the
    device's own evidence. The response names each one that stayed and why,
    because an unbanned person who still cannot sign in needs to be told which
    phone and not left to find out.

    **Refuses a suspended account** and says to use Resume. The two are not
    interchangeable: this one reaches for `bannedDevices` records and a
    suspension never created any.

    A pending appeal from this account is closed as `resolved` — not
    `overturned`, because nobody reviewed it. See `appeals.auto_resolve_pending`.
    """
    try:
        result = await svc.unban_user(uid, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc

    # After the unban, and only on this path. The sweep and `decide_appeal`
    # call the service directly, so neither can reach this. Failure here must
    # not fail the unban — the restriction is already lifted, and an appeal
    # left pending is a queue item, not a locked-out person.
    try:
        resolution = await appeals_svc.auto_resolve_pending(
            uid, user, trigger="unban"
        )
        if resolution:
            result = {**result, "appeal_resolved": resolution}
    except Exception:  # noqa: BLE001 — never let this cost the unban
        log.exception("unban %s: pending appeal could not be auto-resolved", uid)
    return result


@router.post("/{uid}/suspend", dependencies=[_BAN_USERS])
async def suspend_user(uid: str, body: Suspend, user: dict = Depends(require_write)):
    """Suspend an account, for a stated number of days or until lifted by hand.

    **No device is barred.** That is the whole difference between this and a
    ban: a suspended person may go back to the login screen and sign in with a
    different, eligible account on the same phone. `resolveIdentity` in the
    Cloud Functions enforces exactly that split.

    `days` is optional and bounded to a year. With it, the suspension ends
    itself — `lift_expired_suspensions` resumes the account on the next daily
    run after the date passes, and audits the lift. Without it, it stands until
    somebody presses Resume.

    The account is enforced with `isBanned`, because the app has one gate and
    every rule reads it; `accountState: 'suspended'` is what tells the app to
    show a suspension screen with an end date rather than the permanent-ban
    screen it used to show."""
    try:
        return await svc.suspend_user(uid, body.reason, user, days=body.days)
    except UserError as exc:
        raise _fail(exc) from exc


@router.post("/{uid}/resume", dependencies=[_BAN_USERS])
async def resume_user(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Lift a suspension. Touches no device.

    **This is not Unban, and it is not a convenience wrapper around it.**
    Un-suspending used to call `unban_user`, which wrote `user.unbanned` into
    the log for an account that had never been banned — so an expired
    suspension and a moderator lifting a ban read as the same event — and then
    went on to delete a `bannedDevices` record that the suspension had never
    created. Ops bans on shared handsets disappeared that way.

    It is audited as `user.resumed`, it clears the suspension and its schedule,
    and there is no device path in it at all.

    **Refuses a banned account** and says to use Unban. If this could lift a
    ban, the two would be aliases again and a ban could be lifted without the
    device bans it caused ever coming off — leaving somebody unbanned and still
    walled out, with nothing on either screen explaining why.

    It DOES work on a suspension whose `isBanned` flag is somehow false, which
    `unban_user` refused outright — a stray suspension used to be unliftable by
    any endpoint and simply stayed on the account for ever.

    A pending appeal from this account is closed as `resolved`. A suspension
    that EXPIRES on its own does not do this — `lift_expired_suspensions` calls
    the service directly and leaves the appeal pending, because nobody has
    answered the question the person asked.
    """
    try:
        result = await svc.resume_user(uid, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc

    try:
        resolution = await appeals_svc.auto_resolve_pending(
            uid, user, trigger="resume"
        )
        if resolution:
            result = {**result, "appeal_resolved": resolution}
    except Exception:  # noqa: BLE001 — never let this cost the resume
        log.exception("resume %s: pending appeal could not be auto-resolved", uid)
    return result


@router.post(
    "/{uid}/warn",
    dependencies=[Depends(require_permission(Permission.CAN_VIEW_USERS))],
)
async def warn_user(uid: str, body: Warn, user: dict = Depends(require_write)):
    """Record a formal warning, attributed to the person issuing it.

    `can_view_users`, not `can_ban_users` — see the note at the top of this
    module. Support issues most warnings and holds the first and not the second.

    UGP-D: a warning may carry a deduction. That part is a balance decision, so
    it costs `can_adjust_balance` on top — the same split, and the same
    mechanism, as the reports queue's `deduct` verdict (`_REPORT_ACTION_
    PERMISSION`). A warning without one costs what it always did.
    """
    if body.deduction is not None:
        await enforce_permission(user, _WARN_DEDUCTION_PERMISSION)
        # A deduction is only accepted on a request that can be retried
        # safely — see `services.users.warn_user`.
        if not body.request_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A warning with a deduction needs a request_id.",
            )
    try:
        return await svc.warn_user(
            uid, body.reason, user,
            request_id=body.request_id,
            deduction=(
                {"currency": body.deduction.currency, "amount": body.deduction.amount}
                if body.deduction is not None else None
            ),
        )
    except UserError as exc:
        raise _fail(exc) from exc


#: A warning's deduction is a balance decision. Named rather than written inline
#: so it reads as the same rule the reports queue applies to `deduct`.
_WARN_DEDUCTION_PERMISSION = Permission.CAN_ADJUST_BALANCE


# ── There is no direct "grant host" route any more ───────────────────────────
#
# `POST /users/{uid}/grant-host` made somebody a host from the user screen with
# no application, no documents, no agency relationship and no record of why
# beyond a free-text reason. The product's role lifecycle is application →
# review → approval, for hosts as for every partner role: a host application
# (filed by an agency from its dashboard, or by the person from the app) is
# decided at `POST /users/host-applications/{id}/decide`, and THAT is the one
# door onto `services.users.grant_host`. The service function is kept for it.
#
# A client that still calls the old path gets a 404, which is the honest
# answer: the operation does not exist. The seller display flag below is the
# same story for "Make seller" — `is_seller: true` is refused, because the
# Coin Seller partner role is obtained through its application, and the
# Diamond-Shop display flag follows the approved partner record rather than a
# button.


@router.post(
    "/{uid}/revoke-host",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def revoke_host(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Remove host status. The agency link is kept so paid commission history
    stays readable."""
    try:
        return await svc.revoke_host(uid, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc


@router.post(
    "/{uid}/restore-host",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def restore_host(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Restore a revoked Host role from the person's EXISTING approved
    application, roster row and verification record (UGP-B). The same
    capability as revoking it — and, C2, the Owner only: anyone else gets 403
    and recommends on the person's reinstatement request instead."""
    try:
        return await svc.restore_host(uid, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc


# ── Host role suspension (§5 partner role suspension, the Host capability) ────
#
# Only the Host role pauses: the account, the person's other roles, the Host
# record (agency link, roster row, verification) and the earnings history stay.
# The gate is revoke-host's — `can_approve_kyc` on `require_write` — so Support
# (no `can_approve_kyc`) and the Observer (no write) are refused, and no partner
# reaches either route. Resuming is the same gate: a suspension is lifted by
# whoever may impose one, while a REVOKED role is refused by the service and
# comes back only through the Owner-decided reinstatement.


@router.post(
    "/{uid}/suspend-host",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def suspend_host(uid: str, body: HostSuspend, user: dict = Depends(require_write)):
    """Suspend the Host role, for `days` or until resumed.

    Ends the host's live rooms, freezes host money for the Owner's review and
    tells the host and their agency. Answers `{uid, host: {status: "suspended",
    suspendedUntil, reason}, notified: {host, agency}, audit_id}`; the same
    request again answers the standing suspension with `already: true`.
    400 for anybody who is not an approved, current Host or is already
    suspended on other terms."""
    try:
        return await svc.suspend_host(uid, body.reason, user, days=getattr(body, "days", None))
    except UserError as exc:
        raise _fail(exc) from exc


@router.post(
    "/{uid}/resume-host",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))],
)
async def resume_host(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Lift a Host-role suspension: the SAME record works again.

    Answers `{uid, host: {status: <what it was before>}, notified, audit_id}`.
    A revoked Host is refused — reinstatement is the Owner's decision on a
    request, never a resume. Frozen money is not released here."""
    try:
        return await svc.resume_host(uid, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc


@router.get("/{uid}/roles")
async def user_roles(uid: str, user: dict = Depends(current_user)):
    """What this person holds and which ROLE actions may be offered (UGP-B).

    Read from the authoritative records only (Mongo `partners`, the Host flag
    and `hostApplications`). The CRM user page renders Revoke / Restore from
    `roles[].actions` and nothing else, so a guest with no roles is offered no
    role action at all, and a person with ONE role is offered none — suspend
    the account instead. The server applies the same count when pressed.

    `current_user`, like the warnings and history reads beside it: any internal
    session may read; the writes each carry their own capability.
    """
    from app.services import user_roles as roles_svc

    return await roles_svc.roles_for_crm(uid)


@router.post(
    "/{uid}/seller-flag",
    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_SELLER))],
)
async def set_seller_flag(
    uid: str, body: SellerFlag, user: dict = Depends(require_write)
):
    """Remove the seller display flag. Granting it directly is refused.

    `users.isSeller` is the Diamond-Shop display flag. It is NOT the Coin
    Seller partner role — that is a Mongo `partners` record reached through
    an application and a review — but a person reading the app badge cannot
    tell the two apart, so the flag must follow the approved record and never
    precede it. Clearing it remains available for cleanup.
    """
    if body.is_seller:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Seller status is not granted from here. A Coin Seller applies "
                "and is approved through the review queue; the app badge follows "
                "the approved record."
            ),
        )
    try:
        return await svc.set_seller_flag(uid, False, body.reason, user)
    except UserError as exc:
        raise _fail(exc) from exc


# ── Reading a user's record ───────────────────────────────────────────────────


@router.get("/{uid}/warnings")
async def list_warnings(
    uid: str,
    limit: int = Query(default=100, le=500),
    user: dict = Depends(current_user),
):
    """Warnings issued against an account, newest first."""
    try:
        return await svc.list_warnings(uid, limit)
    except UserError as exc:
        raise _fail(exc) from exc


@router.get("/{uid}/history")
async def user_history(
    uid: str,
    limit: int = Query(default=200, le=500),
    user: dict = Depends(current_user),
):
    """Everything that ever happened to this account, and who did it. Read from
    the append-only audit log, not from Firestore."""
    return await svc.user_history(uid, limit)
