"""Chance mechanics — configuration, and the door a round comes through.

Spec Part 8B. Two kinds of route live here and they are separated on purpose.

**The portal half** is guarded by the dependencies `app/core/deps.py` already
has, and by nothing new:

  * reading a configuration is `require_internal` — the odds, the RTP, the
    countries and the history are business record, and the observer reads the
    business record like everything else (1.1.1);
  * previewing a table and proposing a change are `require_team_admin`;
  * making a signed configuration live, and withdrawing a market, are
    `require_owner`.

There is deliberately **no verify route and no sign route in this file.** A
configuration card is verified at `POST /cards/{id}/verify` and signed at
`POST /cards/{id}/sign` like every other card on the board (Part 5), which is
where separation of duties is enforced. A second pair of endpoints here would
be a second implementation of that rule.

**The machine half** — `/chance/edge/*` — carries no `Depends` at all, and that
is not an omission. Its callers are not people:

  * the app tier, which holds a player's Firebase identity and plays on their
    behalf. `app/core/security.py` resolves a session role out of the `staff`
    collection, so a user of the Android app cannot hold a session at all;
    inventing a player session here would be a second authority model beside
    the one this codebase has, and the instruction was not to.
  * a third-party game provider settling a round it ran, which 8B.1.4 requires
    to be server-to-server, signed and verified, and never through the app.

Both prove themselves with an HMAC-SHA256 signature over the method, the path,
a timestamp and the exact bytes of the body, verified by
`chance.verify_signed_caller` as the **first statement** of every one of those
handlers before any argument is read. The keys live in the environment and are
empty by default, so an untouched deployment is one where nothing can be played
(8B.1.7). `tests/test_chance.py` reads this file's source and fails if any route
in it has neither an internal guard nor that call.

One refusal is worth reading twice. A mechanic that is not enabled in the
caller's country answers **404 with the message an unknown id produces**, and
the catalogue omits it entirely. 8B.0.7 asks for invisible, not blocked; a 403
saying "not available in your country" is a map of where a mechanic is switched
off, which is the thing that must not exist.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.core.deps import (
    require_internal,
    require_owner,
    require_permission,
    require_team_admin,
)
from app.core.roles import Permission
from app.services import chance as svc
from app.services import player_protection as protection
from app.services.player_protection import (
    ProtectionBlocked,
    ProtectionError,
    ProtectionUnavailable,
)
from app.services.chance import (
    ChanceError,
    ConfigBlocked,
    MechanicUnavailable,
    PlayerFrozen,
    SignatureError,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/chance", tags=["chance mechanics"])

# ── Who may touch a payout table ─────────────────────────────────────────────
#
# `can_economy_config` — "View / propose economy config changes", which in
# `zipper-crm/lib/auth.ts` is the Tech department and the owners. A chance
# mechanic's configuration IS economy config: it sets what a spin costs, what it
# pays and therefore the house edge, which is the same lever as the bean rate
# and the diamond price.
#
# `require_team_admin` on its own admitted all six department admins, so a
# marketing admin could propose a payout table and a support admin could preview
# one. It stays in the signature and this narrows it to Tech admins and owners
# (a tech *member* holds the capability but is not a team admin, so the existing
# guard still stops them — the two gates are doing different jobs and both are
# needed).
#
# It is applied to the two OWNER-only routes as well. An owner holds every
# capability so nothing narrows there; what it buys is that every route which
# changes the economy says so in one vocabulary, and a future demotion of an
# activation to a non-owner cannot quietly land somewhere unlabelled.
#
# **Not** on suspend / resume / exposure / player protection below. Suspending a
# mechanic is a risk control taken against live exposure, usually by whoever is
# watching the margin rather than by whoever writes the tables, and Tech is the
# one department the CRM does not give a user-facing permission to. Narrowing
# those to `can_economy_config` would take an emergency stop away from Ops and
# Finance and hand it to the team least likely to be watching. They keep
# `require_team_admin` / `require_owner` and are named here so the omission is a
# decision on the record rather than a route somebody missed.
_ECONOMY_CONFIG = Depends(require_permission(Permission.CAN_ECONOMY_CONFIG))

#: The three headers a signed machine caller presents.
CALLER_HEADER = "X-Chance-Caller"
SIGNATURE_HEADER = "X-Chance-Signature"
TIMESTAMP_HEADER = "X-Chance-Timestamp"


def _fail(exc: ChanceError) -> HTTPException:
    """A rule refused this. The message is written to be shown."""
    if isinstance(exc, MechanicUnavailable):
        # 8B.0.7 — the same answer an unknown id gets. Nothing in the status
        # code or the body distinguishes "switched off here" from "never built".
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such mechanic."
        )
    if isinstance(exc, SignatureError):
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        )
    if isinstance(exc, ConfigBlocked):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": str(exc), "blocked_reasons": exc.reasons},
        )
    if isinstance(exc, PlayerFrozen):
        # 8B.5.4. **409, not 404 and not 403.** Not 404, because unlike a
        # suspended mechanic there is nothing here to hide — the fact being
        # stated is about this account, to the holder of this account, and 0.5.5
        # already commits us to telling somebody when their access is
        # restricted and that their balance is preserved. Not 403, because they
        # are perfectly entitled to be here: the request conflicts with the
        # state of the account, which is what 409 means, and it is the same code
        # a player-protection block uses for the same reason.
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(exc), "kind": "chance_review_freeze"},
        )
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


def _protection_fail(exc: ProtectionError) -> HTTPException:
    """A player protection stopped this. Spec 8B.6, and **not** an error.

    A separate function from `_fail` on purpose, because the status codes are
    the argument. A limit reached is not a bad request and it is not a
    forbidden one: the caller was authenticated, the body was well formed, and
    nothing they did was wrong. What happened is that the request conflicts with
    the state of the account — a limit they set, a break they asked for — so it
    is **409**, and the body carries the plain-language message, the machine
    `kind` and the moment it lifts.

    `ProtectionUnavailable` is **503**, which is exactly what it is: we could
    not read the protection store, so we did not take the stake. It is a subclass
    of `ProtectionBlocked`, so it is checked first, and 503 is the one status
    that correctly tells a client "this may work in a minute" — which is true,
    and which a 409 would not say.

    Nothing in either body reads as a fault, and both say in a field of their
    own that the balance is unchanged. That is 8B.6 in one response.
    """
    if isinstance(exc, ProtectionUnavailable):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=exc.as_dict()
        )
    if isinstance(exc, ProtectionBlocked):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=exc.as_dict())
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


async def _signed_caller(
    request: Request,
    caller: str,
    signature: str,
    timestamp: str,
    strip_claims: bool = True,
) -> tuple[dict, dict]:
    """Verify the signature and hand back (actor, body).

    The body is read as **bytes** and the signature checked against those bytes
    before it is parsed, so what was signed is what arrived rather than a
    re-serialisation of it. The parsed body then has every outcome-claiming
    field stripped out of it (8B.1.2 / 8B.1.3) before any handler sees it.

    `strip_claims=False` on exactly one route: the third-party settlement
    callback. A provider **is** the server that ran the game, so its stated
    multiplier and payout are not a client claiming a win — they are the figures
    this side recomputes and compares against, refusing the settlement outright
    if the two disagree (`chance.settle_external_round`). Stripping them there
    would throw away the only thing that makes the cross-check possible, and
    would leave us paying whatever we calculated with no way to notice the
    provider disagreed.
    """
    raw = await request.body()
    try:
        actor = svc.verify_signed_caller(
            caller=caller,
            signature=signature,
            timestamp=timestamp,
            method=request.method,
            path=request.url.path,
            body=raw,
        )
    except SignatureError as exc:
        log.warning(
            "chance: refused a signed request from %r to %s", caller, request.url.path
        )
        raise _fail(exc) from exc

    import json

    try:
        parsed = json.loads(raw or b"{}")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Body is not JSON."
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Body is not an object."
        )

    if not strip_claims:
        parsed["_claims_ignored"] = []
        return actor, parsed

    body, claims = svc.strip_client_claims(parsed)
    body["_claims_ignored"] = claims
    return actor, body


# ══════════════════════════════════════════════════════════════════════════════
#  Reading — internal
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/mechanics")
async def list_mechanics(user: dict = Depends(require_internal)):
    """Every mechanic, live or not, with the configuration in force.

    Internal only, and that is the difference between this and the catalogue a
    player sees: this names mechanics that are switched off, and where.
    """
    try:
        return await svc.list_mechanics()
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/mechanics/{mechanic_id}")
async def get_mechanic(mechanic_id: str, user: dict = Depends(require_internal)):
    try:
        mechanic = await svc.get_mechanic(mechanic_id)
        mechanic["configs"] = await svc.config_history(mechanic_id, limit=20)
        return mechanic
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/mechanics/{mechanic_id}/configs")
async def list_configs(
    mechanic_id: str,
    limit: int = Query(default=100, le=500),
    user: dict = Depends(require_internal),
):
    """Every version ever written, newest first. Spec 8B.14.5.

    The answer to "when did this become available in that market and who signed
    it", from the record rather than from anyone's memory.
    """
    try:
        return await svc.config_history(mechanic_id, limit)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/mechanics/{mechanic_id}/configs/{version}")
async def get_config(
    mechanic_id: str, version: int, user: dict = Depends(require_internal)
):
    """One immutable version — including the one a past round was drawn from."""
    try:
        return await svc.config_version(mechanic_id, version)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/rounds/{round_id}")
async def get_round(round_id: str, user: dict = Depends(require_internal)):
    """One round in full, with its fairness proof recomputed. Spec 8B.5.5."""
    try:
        return await svc.round_record(round_id)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/players/{player_uid}/rounds")
async def player_history(
    player_uid: str,
    limit: int = Query(default=100, le=500),
    user: dict = Depends(require_internal),
):
    """A player's full history. Spec 8B.5.5."""
    try:
        return await svc.player_rounds(player_uid, limit)
    except ChanceError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  Configuring — a team writes it, an owner signs it
# ══════════════════════════════════════════════════════════════════════════════


class OutcomeRow(BaseModel):
    """One row of the table. Both figures are integers and neither is optional.

    `multiplier_bp` is basis points of the stake — 10000 is 1×, 170000 is 17×.
    `probability_ppm` is parts per million; the column must sum to exactly
    1,000,000 (8B.2.3) or the table is refused.
    """

    multiplier_bp: int = Field(ge=0)
    probability_ppm: int = Field(gt=0)


class StakeRules(BaseModel):
    """Stake denominations. Spec 8B.2.5. Whole diamonds."""

    min_stake: int = Field(gt=0)
    max_stake: int = Field(gt=0)
    step: int = Field(gt=0)


class RtpBand(BaseModel):
    """The band every quantity tier's RTP must sit inside. Spec 8B.3.4."""

    min_ppm: int = Field(gt=0)
    max_ppm: int = Field(gt=0)


class ExposureRules(BaseModel):
    """The reserve and the payout ceilings. Spec 8B.4.3 / 8B.4.4.

    Part of the **configuration draft**, so it moves on the card an owner signs
    with the odds, not on a setting somebody can edit at three in the morning.
    Every figure is a whole number of diamonds; every one is optional, and
    leaving one out means "no ceiling of this kind" — which the evaluation
    states as a flag rather than silently reading as zero.

    There is no `reserve_diamonds` without a `reserve_basis`: 8B.4.3 asks for a
    reserve that is *modelled*, and the evaluation prints what a three-sigma bad
    run costs at three volumes so the sentence can quote a number.
    """

    reserve_diamonds: int | None = None
    reserve_basis: str = ""
    max_payout_per_round: int | None = None
    max_payout_per_player_per_day: int | None = None
    max_payout_platform_per_day: int | None = None


class ConfigDraft(BaseModel):
    """A proposed configuration.

    There is **no RTP field, and there will not be one.** The server computes it
    from the table (8B.2.4); a figure a person could type is a figure that can
    disagree with the odds it claims to describe.
    """

    outcomes: list[OutcomeRow]
    stake: StakeRules
    max_single_win: int = Field(gt=0)
    enabled_countries: list[str] = Field(default_factory=list)
    quantity_tiers: list[int] = Field(default_factory=list)
    multiplier_basis: str = "total_stake"
    rtp_band: RtpBand | None = None
    deliberate_lower_return_on_larger_plays: bool = False
    lower_return_statement: str = ""
    regression_override: dict | None = None
    provider: dict | None = None
    exposure: ExposureRules | None = None


class NewMechanic(BaseModel):
    mechanic_id: str = Field(min_length=3, max_length=64)
    kind: str
    name: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=8, max_length=1000)


class ProposedConfig(BaseModel):
    draft: ConfigDraft
    reason: str = Field(min_length=8, max_length=1000)


class WithdrawMarket(BaseModel):
    country: str = Field(min_length=2, max_length=2)
    reason: str = Field(min_length=8, max_length=1000)


def _draft_dict(draft: ConfigDraft) -> dict:
    return {
        "outcomes": [
            {"multiplier_bp": o.multiplier_bp, "probability_ppm": o.probability_ppm}
            for o in draft.outcomes
        ],
        "stake": {
            "min_stake": draft.stake.min_stake,
            "max_stake": draft.stake.max_stake,
            "step": draft.stake.step,
        },
        "max_single_win": draft.max_single_win,
        "enabled_countries": list(draft.enabled_countries or []),
        "quantity_tiers": list(draft.quantity_tiers or []),
        "multiplier_basis": draft.multiplier_basis,
        "rtp_band": (
            {"min_ppm": draft.rtp_band.min_ppm, "max_ppm": draft.rtp_band.max_ppm}
            if draft.rtp_band
            else None
        ),
        "deliberate_lower_return_on_larger_plays": (
            draft.deliberate_lower_return_on_larger_plays
        ),
        "lower_return_statement": draft.lower_return_statement,
        "regression_override": draft.regression_override,
        "provider": draft.provider,
        "exposure": _exposure_dict(getattr(draft, "exposure", None)),
    }


def _exposure_dict(exposure: ExposureRules | None) -> dict | None:
    if exposure is None:
        return None
    return {
        key: getattr(exposure, key, None)
        for key in (
            "reserve_diamonds",
            "reserve_basis",
            "max_payout_per_round",
            "max_payout_per_player_per_day",
            "max_payout_platform_per_day",
        )
    }


@router.post("/configs/preview", dependencies=[_ECONOMY_CONFIG])
async def preview_config(
    body: ConfigDraft, user: dict = Depends(require_team_admin)
):
    """What this table would do, before anybody signs anything. Spec 8B.2.4.

    Writes nothing. Returns the computed RTP, the house edge, the effective RTP
    of every quantity tier (8B.3.2), and every flag and block that would apply —
    from the same function that guards the proposal, so what is previewed is
    what will be enforced.
    """
    try:
        return svc.evaluate_draft(_draft_dict(body))
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post(
    "/mechanics",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_ECONOMY_CONFIG],
)
async def create_mechanic(
    body: NewMechanic, user: dict = Depends(require_team_admin)
):
    """Create a mechanic. It starts with no configuration and no market.

    Nothing is live, so no owner signature is needed to bring the record into
    existence — the first configuration is what needs one, and until it exists
    this mechanic is invisible everywhere.
    """
    try:
        return await svc.create_mechanic(
            mechanic_id=body.mechanic_id,
            kind=body.kind,
            name=body.name,
            reason=body.reason,
            actor=user,
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post(
    "/mechanics/{mechanic_id}/configs",
    status_code=status.HTTP_201_CREATED,
    dependencies=[_ECONOMY_CONFIG],
)
async def propose_config(
    mechanic_id: str,
    body: ProposedConfig,
    user: dict = Depends(require_team_admin),
):
    """Raise the card that changes a configuration. Stage 1 of 5. Spec 8B.2.8.

    A blocked table (8B.3.4 / 8B.10.4) is refused here and never reaches an
    owner: a card that cannot be activated should not be on anybody's queue.
    """
    try:
        return await svc.propose_config(
            mechanic_id=mechanic_id,
            draft=_draft_dict(body.draft),
            reason=body.reason,
            actor=user,
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/configs/{card_id}/activate", dependencies=[_ECONOMY_CONFIG])
async def activate_config(card_id: str, user: dict = Depends(require_owner)):
    """Stage 5 of 5 — the configuration becomes the live one. Owners only.

    Refuses anything not already signed, so the authority is carried by the
    board's stage machine rather than re-asserted here.
    """
    try:
        return await svc.activate_config(card_id, user)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/mechanics/{mechanic_id}/withdraw-country", dependencies=[_ECONOMY_CONFIG])
async def withdraw_country(
    mechanic_id: str, body: WithdrawMarket, user: dict = Depends(require_owner)
):
    """Switch one market off now. Owner only. Spec 8B.0.4 / 8B.14.1.

    Effective immediately and without an app release. Adding a market back is a
    full card — the asymmetry, and why it exists, is argued in
    `chance.withdraw_country`.
    """
    try:
        return await svc.withdraw_country(
            mechanic_id=mechanic_id,
            country=body.country,
            reason=body.reason,
            actor=user,
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  The signed machine door — /chance/edge
# ══════════════════════════════════════════════════════════════════════════════
#
# No `Depends`. Every handler below verifies an HMAC signature as its first act.
# See the module docstring for why this is a door and not a hole.


@router.post("/edge/catalogue")
async def catalogue(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """What a player in this country may see. Spec 8B.0.7 / 8B.14.3.

    A mechanic disabled here is **absent**, not marked disabled. The response in
    a market where everything is switched off is identical to the response in a
    market where nothing was ever built.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return {
            "country": str(body.get("country") or "").upper(),
            "mechanics": await svc.visible_mechanics(str(body.get("country") or "")),
        }
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/edge/rounds", status_code=status.HTTP_201_CREATED)
async def commit_round(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """Open a round and publish the commitment. Spec 8B.1.6.

    Nothing is staked. What comes back is the hash of a seed already drawn and
    stored, the nonce, the odds table and the configuration version — everything
    a player needs to check the round afterwards, published before they play it.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await svc.commit_round(
            mechanic_id=str(body.get("mechanic_id") or ""),
            player_uid=str(body.get("player_uid") or ""),
            country=str(body.get("country") or ""),
            actor=actor,
        )
    except ProtectionBlocked as exc:  # 8B.6 — a control, not a fault
        raise _protection_fail(exc) from exc
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/edge/rounds/{round_id}/play")
async def play_round(
    round_id: str,
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """Play it. The server draws, records, then pays. Spec 8B.1.1 – 8B.1.5.

    The body carries a stake, a quantity and — optionally — the caller's own
    entropy. Anything in it that looks like a result or a winning amount has
    already been removed by `_signed_caller` and is recorded as having been
    removed (8B.1.2 / 8B.1.3).
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await svc.play_round(
            round_id=round_id,
            unit_stake=body.get("unit_stake"),
            quantity=body.get("quantity", 1),
            client_entropy=str(body.get("client_entropy") or ""),
            actor=actor,
            claims_ignored=body.get("_claims_ignored") or [],
        )
    except ProtectionBlocked as exc:  # 8B.6 — a control, not a fault
        raise _protection_fail(exc) from exc
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/edge/settlements")
async def settle_external(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """A third-party game settles a round it ran. Spec 8B.1.4.

    Server-to-server, signed and verified, never through the app. The payout is
    recomputed on this side from the provider's stake and multiplier, capped by
    our own maximum single win, and refused outright if their arithmetic and
    ours disagree — a signature proves who sent a number, not that the number is
    right. What a provider must supply is listed in
    `chance.settle_external_round`.
    """
    actor, body = await _signed_caller(
        request,
        x_chance_caller,
        x_chance_signature,
        x_chance_timestamp,
        strip_claims=False,
    )
    try:
        return await svc.settle_external_round(
            provider=actor["caller"], payload=body, actor=actor
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  Player protection — spec 8B.6
# ══════════════════════════════════════════════════════════════════════════════
#
# Two halves again, and split on the same line as everything above.
#
# **The player's half** is on the signed machine door, because a player has no
# session in this API — `app/core/security.py` resolves a role out of the
# `staff` collection and a user of the Android app cannot hold one. The app tier
# asserts the player's uid inside the signature, exactly as it does to commit
# and play a round; there is no second authority model here.
#
# **The staff half** is `require_internal` to read and `require_team_admin` to
# decide, and every decision carries a mandatory reason. A review can impose a
# limit or suspend play on somebody's account, which is not a thing a session
# with no name on it may do — `player_protection.named_person` refuses one, and
# refuses a machine, so 8B.6.5's "reviewed by a named person" is a refusal in
# the service rather than a convention in the portal.
#
# **None of these routes moves money and none of them can.**
# `player_protection.py` does not import `app.services.money` and will not.
#
# Note what is deliberately absent: there is no route that cancels a
# self-exclusion, no route that shortens one, and no route that ends a
# cooling-off period early. `/self-exclusion/lift-request` starts a clock and
# puts the account on somebody's desk; only `/self-exclusion/decide` reopens it,
# it is staff-only, it needs a reason, and the service refuses it before the
# reflection period has run. See `player_protection.self_exclude` for why the
# undo is this hard.


class PlayerLimits(BaseModel):
    """The player's own daily and weekly loss limits. Spec 8B.6.1.

    Whole diamonds. `0` clears the player's own limit — which is a loosening
    like any other and waits out the same delay. Omit a field to leave it alone.
    """

    player_uid: str = Field(min_length=1, max_length=128)
    daily: int | None = Field(default=None, ge=0)
    weekly: int | None = Field(default=None, ge=0)


class SelfExclusion(BaseModel):
    player_uid: str = Field(min_length=1, max_length=128)
    days: int = Field(ge=1)
    note: str = Field(default="", max_length=500)


class CoolingOff(BaseModel):
    player_uid: str = Field(min_length=1, max_length=128)
    hours: int = Field(ge=1)
    note: str = Field(default="", max_length=500)


class StaffLimits(BaseModel):
    daily: int | None = Field(default=None, ge=0)
    weekly: int | None = Field(default=None, ge=0)
    reason: str = Field(min_length=8, max_length=1000)


class FlagReview(BaseModel):
    """One reviewer's decision on one flag. Spec 8B.6.5."""

    decision: str
    reason: str = Field(min_length=8, max_length=1000)
    daily_limit: int | None = Field(default=None, ge=0)
    weekly_limit: int | None = Field(default=None, ge=0)
    suspend_days: int | None = Field(default=None, ge=1)


class LiftDecision(BaseModel):
    approve: bool
    reason: str = Field(min_length=8, max_length=1000)


# ── The player's own controls, through the signed door ────────────────────────


@router.post("/edge/protection/status")
async def protection_status(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """Everything a player's own screen shows. Spec 8B.6.1 – 8B.6.3.

    Called before a play rather than discovered from a refusal, which is the
    whole of "a limit reached is not an error": the headroom, the moment each
    window resets, any break that is running and the current session all come
    back here, so the app can say "you have 300 left today" instead of showing a
    rejection.

    It also returns any session reminder that has fallen due (8B.6.3) — read
    only. The reminder is *recorded* server-side inside `gate_play` whether or
    not this is ever called, so a client that never asks is still a client we
    can prove was told.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await protection.player_status(str(body.get("player_uid") or ""))
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/edge/protection/limits")
async def set_own_limits(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """The player sets their own loss limits. Spec 8B.6.1.

    A reduction applies immediately; a raise waits out
    `protection_limit_increase_delay_hours`. The response names both, so a
    player who has asked for a higher limit is told when it starts rather than
    finding out by being refused.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await protection.set_player_limits(
            player_uid=str(body.get("player_uid") or ""),
            daily=body.get("daily"),
            weekly=body.get("weekly"),
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/edge/protection/self-exclude")
async def self_exclude(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """The player excludes themselves. Spec 8B.6.2.

    There is no matching route that undoes this, and that is the point. See the
    section comment above, and `player_protection.self_exclude`.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await protection.self_exclude(
            player_uid=str(body.get("player_uid") or ""),
            days=body.get("days"),
            note=str(body.get("note") or ""),
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/edge/protection/cooling-off")
async def cooling_off(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """A short break the player sets for themselves. Spec 8B.6.2.

    Unlike a self-exclusion this one ends by itself, which is exactly what makes
    it the light tool. It still cannot be cancelled early.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await protection.start_cooling_off(
            player_uid=str(body.get("player_uid") or ""),
            hours=body.get("hours"),
            note=str(body.get("note") or ""),
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/edge/protection/self-exclusion/lift-request")
async def request_lift(
    request: Request,
    x_chance_caller: str = Header(default="", alias=CALLER_HEADER),
    x_chance_signature: str = Header(default="", alias=SIGNATURE_HEADER),
    x_chance_timestamp: str = Header(default="", alias=TIMESTAMP_HEADER),
):
    """The player asks for a served exclusion to be reopened. **Nothing lifts.**

    Refused outright while the minimum term is running. Once served, this starts
    a reflection period and puts the account in front of a named person; the
    account stays closed throughout, and only `/protection/self-exclusion/decide`
    can reopen it.
    """
    actor, body = await _signed_caller(
        request, x_chance_caller, x_chance_signature, x_chance_timestamp
    )
    try:
        return await protection.request_exclusion_lift(
            player_uid=str(body.get("player_uid") or ""),
            note=str(body.get("note") or ""),
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


# ── The staff half — reading the queue, and deciding ──────────────────────────


@router.get("/protection/flags")
async def list_protection_flags(
    status_filter: str = Query(default="open", alias="status"),
    player_uid: str = Query(default=""),
    limit: int = Query(default=100, le=500),
    user: dict = Depends(require_internal),
):
    """The review queue. Spec 8B.6.4 / 8B.6.5.

    Nothing in this system empties it. A flag leaves `open` only through
    `/protection/flags/{id}/review`, which needs a named person and a reason.
    """
    try:
        return await protection.list_flags(
            status=status_filter or None,
            player_uid=player_uid or None,
            limit=limit,
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.get("/protection/players/{player_uid}")
async def protection_record(player_uid: str, user: dict = Depends(require_internal)):
    """One player's protections, as staff see them. Spec 8B.6.

    The same record the player sees, so a support conversation is about one set
    of figures rather than two.
    """
    try:
        record = await protection.player_status(player_uid)
        record["flags"] = await protection.list_flags(player_uid=player_uid, limit=50)
        return record
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/protection/flags/{flag_id}/review")
async def review_protection_flag(
    flag_id: str, body: FlagReview, user: dict = Depends(require_team_admin)
):
    """A named person reviews a flag and the decision is recorded. Spec 8B.6.5.

    The decision comes from a fixed vocabulary, the reason is mandatory, and any
    consequence — a limit imposed, play suspended — is applied here rather than
    left as a second action somebody might not take. A flag already reviewed is
    refused: a second decision would overwrite somebody else's, and if the
    behaviour continued the honest record is a new flag.
    """
    try:
        return await protection.review_flag(
            flag_id=flag_id,
            decision=body.decision,
            reason=body.reason,
            actor=user,
            daily_limit=body.daily_limit,
            weekly_limit=body.weekly_limit,
            suspend_days=body.suspend_days,
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/protection/players/{player_uid}/limits")
async def impose_limits(
    player_uid: str, body: StaffLimits, user: dict = Depends(require_team_admin)
):
    """Staff impose a loss limit on one player. Spec 8B.6.1.

    Immediate in both directions, unlike the player's own, and recorded against
    a named person with a reason. The player cannot loosen it: the lowest limit
    set by anybody is the one enforced, so they can only go below it.
    """
    try:
        return await protection.set_staff_limits(
            player_uid=player_uid,
            daily=body.daily,
            weekly=body.weekly,
            reason=body.reason,
            actor=user,
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


@router.post("/protection/players/{player_uid}/self-exclusion/decide")
async def decide_lift(
    player_uid: str, body: LiftDecision, user: dict = Depends(require_team_admin)
):
    """Decide a request to reopen a served self-exclusion. Spec 8B.6.2 / 8B.6.5.

    The only route in this API that can reopen chance mechanics for a player who
    closed them. It refuses before the player has asked, refuses inside the
    minimum term, refuses before the reflection period has run, and refuses a
    session with no name on it. A refusal to lift is recorded as carefully as an
    approval — deciding not to reopen somebody's account is still a decision.
    """
    try:
        return await protection.decide_exclusion_lift(
            player_uid=player_uid,
            approve=body.approve,
            reason=body.reason,
            actor=user,
        )
    except ProtectionError as exc:
        raise _protection_fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  Exposure, the reserve and the stops — Part 8B.4
# ══════════════════════════════════════════════════════════════════════════════
#
# Reading the position is `require_internal` — the exposure of a chance mechanic
# is business record and the Observer reads the business record like everything
# else (1.1.1).
#
# The two write routes are deliberately asymmetric, and it is the asymmetry
# `withdraw_country` already argues for. **Stopping** a mechanic is available to
# a team admin, because it makes something less available and can never make a
# mechanic payable where it was not. **Restarting** one is an owner, because the
# mechanic stopped by paying past a limit the business signed for and deciding
# it may pay again is a decision about money.


class SuspendMechanic(BaseModel):
    reason: str = Field(min_length=8, max_length=1000)


class ResumeMechanic(BaseModel):
    reason: str = Field(min_length=8, max_length=1000)


class FreezePlayer(BaseModel):
    reason: str = Field(min_length=8, max_length=1000)
    evidence: dict | None = None


class UnfreezePlayer(BaseModel):
    reason: str = Field(min_length=8, max_length=1000)


@router.get("/exposure")
async def exposure(user: dict = Depends(require_internal)):
    """Every mechanic: total staked against total paid out, live. Spec 8B.4.2.

    Computed from `chance_rounds`, the record each round is written into before
    it is paid — not from the counters the ceilings are enforced on. Both are
    returned, side by side, so a divergence between the control and the record
    is visible rather than averaged into one number nobody can check.
    """
    try:
        return await svc.exposure_snapshot()
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/mechanics/{mechanic_id}/exposure")
async def mechanic_exposure(
    mechanic_id: str, user: dict = Depends(require_internal)
):
    """One mechanic's exposure, reserve headroom and ceilings. Spec 8B.4.2 / 8B.4.3."""
    try:
        return await svc.exposure_for(mechanic_id)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/mechanics/{mechanic_id}/suspend")
async def suspend_mechanic(
    mechanic_id: str, body: SuspendMechanic, user: dict = Depends(require_team_admin)
):
    """Stop a mechanic by hand. Spec 8B.4.5.

    The same stop the ceilings apply automatically, available to a person who
    has seen something the ceilings have not. From the moment it returns the
    mechanic pays nothing, accepts nothing, and is invisible to every player in
    exactly the way a mechanic disabled for their country is.
    """
    try:
        return await svc.suspend_mechanic(
            mechanic_id=mechanic_id, reason=body.reason, actor=user
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/mechanics/{mechanic_id}/resume")
async def resume_mechanic(
    mechanic_id: str, body: ResumeMechanic, user: dict = Depends(require_owner)
):
    """Restart a suspended mechanic. Owners only, with a reason. Spec 8B.4.5.

    There is no timer anywhere that does this. The audit entry records the live
    exposure at the moment of the decision, so the record shows what the owner
    was looking at, and resuming changes no ceiling and no reserve — if the
    breached condition still holds the next qualifying payout stops it again.
    """
    try:
        return await svc.resume_mechanic(
            mechanic_id=mechanic_id, reason=body.reason, actor=user
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


# ══════════════════════════════════════════════════════════════════════════════
#  Monitoring, the exception queue and the margin — Part 8B.5
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/mechanics/{mechanic_id}/rtp")
async def rtp_divergence(
    mechanic_id: str,
    days: int = Query(default=7, ge=1, le=90),
    user: dict = Depends(require_internal),
):
    """Actual RTP against configured RTP, per day and pooled. Spec 8B.5.1.

    Judged against the exact variance of the signed outcome table, reported as a
    confidence bound on actual RTP rather than as a percentage gap, and refusing
    to alert below a minimum number of rounds however extreme the figure looks —
    a small sample diverges by a lot, and calling that an exploit is how the
    alert stops being read.
    """
    try:
        return await svc.rtp_divergence(mechanic_id, days=days)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/exceptions")
async def exception_queue(
    hours: int = Query(default=24, ge=1, le=720),
    user: dict = Depends(require_internal),
):
    """What Ops has to work through. Spec 8B.5.6.

    Suspended mechanics, frozen players, withheld payouts and player anomalies.
    Nothing on it clears itself, expires, or is settled by a scheduled job.
    """
    try:
        return await svc.exception_queue(hours=hours)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/margin")
async def margin(
    days: int = Query(default=7, ge=1, le=90),
    user: dict = Depends(require_internal),
):
    """What Finance owns. Spec 8B.5.6 / 8B.7.1.

    Gross gaming revenue per mechanic with actual against configured RTP beside
    it and the reserve position underneath. A separate call from the exception
    queue because they are separate jobs.
    """
    try:
        return await svc.margin_report(days=days)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/players/{player_uid}/anomalies")
async def player_anomalies(
    player_uid: str,
    hours: int = Query(default=24, ge=1, le=720),
    user: dict = Depends(require_internal),
):
    """Win rate, frequency and timing for one player. Spec 8B.5.3.

    Evidence, never a verdict. Reading this changes nothing about the account.
    """
    try:
        return await svc.player_anomalies(player_uid, hours=hours)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.get("/players/{player_uid}/activity")
async def player_activity(
    player_uid: str,
    limit: int = Query(default=200, le=500),
    user: dict = Depends(require_internal),
):
    """One player's whole chance history, reconstructable. Spec 8B.5.5."""
    try:
        return await svc.player_activity(player_uid, limit)
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/players/{player_uid}/freeze")
async def freeze_player(
    player_uid: str, body: FreezePlayer, user: dict = Depends(require_team_admin)
):
    """Pause a player's chance activity pending review. Spec 8B.5.4.

    It stops them opening or playing a round, and that is all it does. **No
    balance moves, no settled round is reversed or amended, and the account is
    not banned** — every other part of the product is unaffected. The service
    refuses anyone who is not Ops or an owner: 8B.5.6 gives the exception queue
    to Ops, and 8B.6.5 wants a named reviewer rather than a role.
    """
    try:
        return await svc.freeze_player(
            player_uid=player_uid,
            reason=body.reason,
            actor=user,
            evidence=body.evidence,
        )
    except ChanceError as exc:
        raise _fail(exc) from exc


@router.post("/players/{player_uid}/unfreeze")
async def unfreeze_player(
    player_uid: str, body: UnfreezePlayer, user: dict = Depends(require_team_admin)
):
    """End a freeze after a review. Spec 8B.5.4 / 8B.6.5.

    A person, a reason and an audit entry naming them. A freeze never expires on
    its own, for the same reason a suspension never does: a timer means nobody
    ever has to look.
    """
    try:
        return await svc.unfreeze_player(
            player_uid=player_uid, reason=body.reason, actor=user
        )
    except ChanceError as exc:
        raise _fail(exc) from exc
