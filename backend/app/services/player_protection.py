"""Player protection for the chance mechanics — spec 8B.6.

8B.6.6 is the sentence the rest of this module is built around:

    "These are not optional extras. They protect the business as much as the
     player."

So nothing here is a disclosure, a banner or a setting the app is trusted to
respect. Every one of them is a **control**: a server-side refusal at the moment
of play, a record of who decided what, and a figure computed from
`chance_rounds` rather than from anything a client says about itself.

## The five things, and where each one lives

  * **8B.6.1 — daily and weekly loss limits.** `set_player_limits`,
    `set_staff_limits`, the house defaults in `app/config.py`, and the arithmetic
    in `loss_in_window`. Enforced by `gate_play`.
  * **8B.6.2 — self-exclusion and a self-set cooling-off period.**
    `self_exclude`, `start_cooling_off`, `request_exclusion_lift`,
    `decide_exclusion_lift`. Enforced by `gate_play` and `gate_commit`.
  * **8B.6.3 — session reminders.** `session_state`, which derives a session
    from the round history and records a reminder when one falls due.
  * **8B.6.4 — automatic flagging of harm patterns.** `detect_patterns` and
    `raise_flags`, run inside `gate_play` on every allowed play.
  * **8B.6.5 — a named person reviews a flag and the decision is recorded.**
    `review_flag`, and nothing else in this module ever closes one.

## Four rules that shaped every function below

**Enforcement is server-side, at the moment of play.** The only place a stake is
known before it is taken is `chance.play_round`, so that is where `gate_play` is
called — after the round is claimed and the stake validated, and *before* the
diamond leaves the balance. An app that chooses not to call a protection API is
not a threat model this module has to model, because the app is not the thing
enforcing anything.

**A protection that fails open is not a protection.** Every read of the
protection store is wrapped, and any failure to read it raises
`ProtectionUnavailable` — which is a subclass of `ProtectionBlocked`, so every
caller that already refuses a blocked play refuses an unreadable one too,
without having to remember to. The play does not happen. This is the one place
in the codebase where an unavailable database is answered by doing less rather
than by retrying.

**Money is never moved from here.** There is no import of `app.services.money`
in this file and there will not be one. A limit stops a play; it does not take a
balance, return a stake or reverse a payout. The stake that was refused was
never debited, and the message says so in those words.

**Integers, and the player's own day.** Diamonds are whole numbers, minutes are
whole numbers, and "daily" means the calendar day in `REPORT_TIMEZONE`
(Asia/Kolkata), resolved through `scheduling.business_tz()` — the same resolver
the scheduled reports use, because a daily window cut in UTC for an Indian
player starts at 05:30 in the morning and folds the previous evening, which is
the busiest part of the day, into the wrong date. That bug was found and fixed
once already in this codebase; it is not re-introduced here.

## The two decisions this module had to make

**Self-exclusion is hard to undo, deliberately, in two ways at once.**

  1. A **mandatory minimum term** (`protection_min_self_exclusion_days`, 180 by
     default). Inside it nothing lifts the exclusion — not the player, not
     support, not an owner. Staff may *extend* it and may never shorten it,
     because a control whose strength is the persuadability of the most
     sympathetic person on the rota is not a control.
  2. The term running out **does not lift it.** An exclusion whose end is a
     timer is one a player waits out passively on the worst day of their year.
     When the term expires the record moves to `expired`, and the account is
     reopened only when the player asks (`request_exclusion_lift`), a
     **reflection period** of `protection_exclusion_reflection_hours` has passed
     since they asked, and a **named member of staff records a decision with a
     reason** (`decide_exclusion_lift`). Three deliberate acts by two parties,
     with a gap in the middle.

     Cooling-off is the opposite on purpose, and that is why both exist: it is
     short, self-chosen, capped, and it *does* expire on its own. Somebody who
     wants a week off takes a cooling-off; self-exclusion is not the tool for
     that and is not priced like it.

**A loss limit is per player and applies across every mechanic, not per
mechanic.** A per-mechanic limit is evaded in one tap by moving from the lucky
gift to the next game we launch, which makes it a speed bump rather than a
limit. Every mechanic in `chance_rounds` stakes and pays the same unit — a
diamond — so one number can cover all of them honestly. The window sums every
round the player played anywhere, including rounds settled by a third-party
provider (8B.1.4), because a loss is a loss whoever's server drew it.

## What "loss" means, and where the line is drawn

Loss is **staked minus returned** over the window, exactly as the spec words it:
the sum of `total_stake` over the player's rounds less the sum of `payout`. A
player who is ahead has a negative loss and full headroom, which is right — they
have not lost anything.

The refusal is on the **worst case of the play being attempted**, not on the
loss already booked: a play is refused when `loss_so_far + total_stake` would
exceed the limit. Under the softer rule ("refuse once the limit is reached") a
player one diamond short of a 1,000 limit may stake 50,000 and end the day
50,000 down, and a limit that permits that is not bounding anything. Under this
rule the headroom figure is also the largest stake that may be placed right now,
which is a single number the app can show before the player commits to anything.

## The tone of a refusal

8B.6 is a protection, so a refusal here is not a fault and is not written as
one. Every `ProtectionBlocked` carries a `message` in plain words, a machine
`kind`, and — where there is one — the exact moment the block lifts, in UTC for
a machine and in the player's own timezone for a person. Nothing says "error",
nothing says "invalid", and nothing implies the player did something wrong. They
set a limit, or they asked us to stop them, and we did.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

from app.config import settings
from app.core import audit
from app.core.compat import StrEnum
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)


#: A reason on a staff decision. The same floor `chance.py` uses, for the same
#: reason: a decision about somebody's account with no stated reason is not
#: auditable, and "ok" is not a reason.
MIN_REASON = 8

#: The machine that writes the records nobody pressed a button for — a reminder
#: falling due, a pattern being detected, a play being refused. The `system:`
#: prefix is what `app/core/audit.py` reserves so an owner reading the log can
#: tell a control from a colleague at a glance.
SYSTEM_ACTOR: dict = {
    "uid": f"{audit.SYSTEM_UID_PREFIX}player_protection",
    "name": "Player protection (8B.6)",
    "role": "system",
    "team": None,
}


# ══════════════════════════════════════════════════════════════════════════════
#  Failures
# ══════════════════════════════════════════════════════════════════════════════


class ProtectionError(Exception):
    """A rule in this module refused. The message is safe to show a caller."""


class ProtectionBlocked(ProtectionError):
    """A control stopped this play. **Not an error, and not the player's fault.**

    Carries everything a screen needs to say so kindly and everything a machine
    needs to act on it: a stable `kind`, a plain-language `message`, the moment
    the block lifts (or None where it does not lift on a timer), and whatever
    figures the control was computed from.
    """

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        lifts_at: datetime | None = None,
        detail: Mapping | None = None,
    ):
        super().__init__(message)
        self.kind = str(kind)
        self.message = message
        self.lifts_at = lifts_at
        self.detail = dict(detail or {})

    def as_dict(self) -> dict:
        return {
            "allowed": False,
            "kind": self.kind,
            "message": self.message,
            "lifts_at": self.lifts_at,
            "lifts_at_local": local_text(self.lifts_at) if self.lifts_at else None,
            "detail": self.detail,
            # Said in the response as well as in the prose, because it is the
            # first thing a person wants to know and the last thing a refusal
            # usually tells them.
            "balance_unchanged": True,
        }


class ProtectionUnavailable(ProtectionBlocked):
    """The protection store could not be read, so the play does not happen.

    **A subclass of `ProtectionBlocked` on purpose.** Every caller that already
    refuses a blocked play refuses an unreadable one too, without a second
    `except` clause anybody could forget to write. A protection that fails open
    is not a protection: if we cannot tell whether this player excluded
    themselves, we do not take their stake.
    """

    def __init__(self, cause: str = ""):
        super().__init__(
            str(Block.UNAVAILABLE),
            "We could not check your play settings just now, so nothing was "
            "staked and your balance is unchanged. Please try again in a "
            "moment.",
            detail={"cause": cause},
        )


# ══════════════════════════════════════════════════════════════════════════════
#  Vocabulary
# ══════════════════════════════════════════════════════════════════════════════


class Block(StrEnum):
    """Why a play did not happen. Stable strings; the app may branch on them."""

    SELF_EXCLUDED = "self_excluded"
    COOLING_OFF = "cooling_off"
    STAFF_SUSPENSION = "staff_suspension"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    WEEKLY_LOSS_LIMIT = "weekly_loss_limit"
    UNAVAILABLE = "protection_unavailable"


class Window(StrEnum):
    DAILY = "daily"
    WEEKLY = "weekly"


class Source(StrEnum):
    """Who set a limit. The **lowest** of the three that is set is enforced."""

    HOUSE = "house"     # app/config.py — applies to everyone
    STAFF = "staff"     # imposed on a review, and the player cannot loosen it
    PLAYER = "player"   # the player's own, 8B.6.1


class ExclusionStatus(StrEnum):
    NONE = "none"
    ACTIVE = "active"                  # inside the mandatory minimum term
    EXPIRED = "expired"                # term served; still excluded until lifted
    LIFT_REQUESTED = "lift_requested"  # asked; reflection period running
    LIFTED = "lifted"


class Pattern(StrEnum):
    """The three behaviours 8B.6.4 names."""

    ESCALATING_STAKES = "escalating_stakes_after_losses"
    SUSTAINED_SESSION = "sustained_session"
    RAPID_REPEAT = "rapid_repeat_play"


class FlagStatus(StrEnum):
    OPEN = "open"
    REVIEWED = "reviewed"


class Decision(StrEnum):
    """What a reviewer concluded. Spec 8B.6.5.

    There is no "dismissed" and no "auto-closed". Every one of these is a
    sentence a named person is prepared to have read back to them.
    """

    NO_ACTION = "no_action"                 # looked, and this is ordinary play
    CONTACTED_PLAYER = "contacted_player"
    LIMIT_IMPOSED = "limit_imposed"
    PLAY_SUSPENDED = "play_suspended"
    ESCALATED = "escalated"


class Act:
    """Audit actions written by this module.

    Declared here, beside the only code that writes them, the way `chance.Act`
    and `expenses.Act` keep their own. None of them exists in
    `audit.Action`, because none of them is a money movement — which is itself
    the point: these are the records of a control acting, and they are as
    auditable as a payment.
    """

    LIMIT_SET = "protection.limit_set"
    LIMIT_INCREASE_SCHEDULED = "protection.limit_increase_scheduled"
    SELF_EXCLUDED = "protection.self_excluded"
    EXCLUSION_EXTENDED = "protection.self_exclusion_extended"
    LIFT_REQUESTED = "protection.exclusion_lift_requested"
    LIFT_DECIDED = "protection.exclusion_lift_decided"
    COOLING_OFF = "protection.cooling_off_started"
    PLAY_BLOCKED = "protection.play_blocked"
    SESSION_REMINDER = "protection.session_reminder"
    FLAG_RAISED = "protection.harm_pattern_flagged"
    FLAG_REVIEWED = "protection.harm_pattern_reviewed"


# ══════════════════════════════════════════════════════════════════════════════
#  Settings, read once per call and never hard-coded in a detector
# ══════════════════════════════════════════════════════════════════════════════
#
# Every threshold below is an environment variable. An owner who wants a session
# reminder every thirty minutes rather than every sixty changes a setting;
# nobody edits Python to retune a protection. `getattr` with a default keeps a
# deployment that predates one of these settings working rather than failing to
# boot — but the default is the same figure `app/config.py` declares, so there is
# exactly one number and this is not a second opinion about it.


def _setting(name: str, fallback: int) -> int:
    value = getattr(settings, name, fallback)
    try:
        return int(value)
    except (TypeError, ValueError):  # pragma: no cover — a misconfigured env
        return int(fallback)


# ══════════════════════════════════════════════════════════════════════════════
#  The player's own day — 8B.6.1, and the bug that is not being repeated
# ══════════════════════════════════════════════════════════════════════════════
#
# `chance_rounds.played_at` is stored in UTC, like every other timestamp in this
# system, and that is right for arithmetic. It is wrong for a *window*: at
# UTC+05:30 the UTC day [00:00, 24:00) runs from 05:30 yesterday morning to
# 05:30 this morning locally. A daily loss limit cut that way lets a player lose
# their limit at nine in the evening, lose it again at six the next morning, and
# never see a refusal — because the two evenings are one UTC day apart but two
# local days apart, and vice versa.
#
# So the window is resolved in `REPORT_TIMEZONE` and only then converted to UTC
# for the query. `scheduling.business_tz()` is the resolver, imported lazily
# because it lives in a module that pulls in the mail and alert stack and this
# one has no business depending on either at import time.


def business_tz() -> Any:
    """The zone a player's day is cut in. One definition, not a second copy."""
    from app.services.scheduling import business_tz as resolve

    return resolve()


def _local(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(business_tz())


def _utc(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def local_text(moment: datetime | None) -> str:
    """A moment as a person in the business timezone would read it."""
    if moment is None:
        return ""
    return _local(moment).strftime("%-d %B %Y at %H:%M") + f" ({_zone_name()})"


def _zone_name() -> str:
    return str(getattr(settings, "report_timezone", "") or "UTC").strip() or "UTC"


def day_window(now: datetime | None = None) -> tuple[datetime, datetime, str]:
    """[start of the player's today, start of their tomorrow) — returned in UTC.

    Half-open, matching every other window in this codebase, so two consecutive
    days never double-count a round and never miss one. The label is the local
    calendar date, which is the date the player would name.
    """
    local = _local(now or _now())
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return _utc(start), _utc(start + timedelta(days=1)), start.date().isoformat()


def week_window(now: datetime | None = None) -> tuple[datetime, datetime, str]:
    """[local Monday 00:00, the next local Monday 00:00) — returned in UTC.

    A **calendar** week rather than a rolling seven days, and cut in the same
    zone as the day. A rolling window would be stricter, but it never resets
    from the player's point of view: they can never be told "this lifts on
    Monday morning", only "some of it lifts at some point", which is not a
    sentence anybody can plan around. A weekly limit a player can reason about
    is one they keep.
    """
    local = _local(now or _now())
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    start = midnight - timedelta(days=midnight.weekday())
    return _utc(start), _utc(start + timedelta(days=7)), f"week of {start.date().isoformat()}"


# ══════════════════════════════════════════════════════════════════════════════
#  The store
# ══════════════════════════════════════════════════════════════════════════════
#
# One document per player, `_id` = the player's uid, in a collection of its own.
# Nothing else writes it and it holds no money field of any kind.


def _uid(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        raise ProtectionError("A protection record belongs to a player.")
    if len(text) > 128:
        raise ProtectionError("That is not a player id.")
    return text


def _blank(player_uid: str) -> dict:
    return {
        "_id": player_uid,
        "player_uid": player_uid,
        "limits": {},           # window → {source → {"amount": int, ...}}
        "pending_limits": [],   # increases waiting out their delay
        "self_exclusion": None,
        "cooling_off": None,
        "staff_suspension": None,
        "session": None,
        "blocked_plays": 0,
        "created_at": None,
        "updated_at": None,
    }


async def _read(player_uid: str) -> dict:
    """The player's record, or a blank one. **Never a silent failure.**

    Any exception at all becomes `ProtectionUnavailable`, and every caller of
    this function treats that as a refusal. The broad catch is deliberate: the
    question is not "which driver exception was it", it is "do we know whether
    this person asked us to stop them" — and if the answer is no, the play does
    not happen whatever the reason.
    """
    try:
        doc = await get_db()[C.PLAYER_PROTECTION].find_one({"_id": player_uid})
    except Exception as exc:  # noqa: BLE001 — see the docstring
        log.error(
            "player_protection: could not read the record for %s (%s: %s); "
            "refusing the play rather than allowing it",
            player_uid,
            type(exc).__name__,
            exc,
        )
        raise ProtectionUnavailable(f"{type(exc).__name__}: {exc}") from exc
    return doc if doc is not None else _blank(player_uid)


async def _write(player_uid: str, changes: Mapping, *, inc: Mapping | None = None) -> dict:
    """Upsert one player's record and hand back what it now says."""
    update: dict = {
        "$set": {**dict(changes), "updated_at": _now()},
        "$setOnInsert": {"player_uid": player_uid, "created_at": _now()},
    }
    if inc:
        update["$inc"] = dict(inc)
    try:
        await get_db()[C.PLAYER_PROTECTION].update_one(
            {"_id": player_uid}, update, upsert=True
        )
    except Exception as exc:  # noqa: BLE001
        log.error("player_protection: could not write %s: %s", player_uid, exc)
        raise ProtectionUnavailable(f"{type(exc).__name__}: {exc}") from exc
    return await _read(player_uid)


def _public(doc: Mapping) -> dict:
    out = dict(doc)
    out.pop("_id", None)
    return out


def _reason(raw: Any) -> str:
    text = str(raw or "").strip()
    if len(text) < MIN_REASON:
        raise ProtectionError(
            f"A reason of at least {MIN_REASON} characters is required. A "
            "decision about somebody's account with no stated reason is not "
            "auditable (8B.6.5)."
        )
    return text


def named_person(actor: Mapping | None) -> dict:
    """The person a decision is recorded against, or a refusal. Spec 8B.6.5.

    "A flagged player is reviewed by a named person" is enforced rather than
    assumed: a machine actor is refused outright, and so is a session with no
    name on it. The alternative — recording a decision against an empty string —
    produces a review queue that empties itself and a record nobody can be asked
    about.
    """
    actor = actor or {}
    if audit.is_system_actor(actor) or str(actor.get("uid", "")).startswith(
        audit.SYSTEM_UID_PREFIX
    ):
        raise ProtectionError(
            "A harm flag is reviewed by a named person, not by a machine "
            "(8B.6.5). Automatic detection raises the flag; a human closes it."
        )
    uid = str(actor.get("uid") or "").strip()
    name = str(actor.get("name") or "").strip()
    if not uid or not name:
        raise ProtectionError(
            "A review has to name the person who made the decision. This "
            "session carries no name, so the decision cannot be recorded "
            "against anybody (8B.6.5)."
        )
    return {"uid": uid, "name": name, "role": str(actor.get("role") or "")}


# ══════════════════════════════════════════════════════════════════════════════
#  8B.6.1 — loss limits
# ══════════════════════════════════════════════════════════════════════════════


def _amount(raw: Any, label: str) -> int:
    """A whole number of diamonds. `True` is not a number here."""
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ProtectionError(
            f"{label} is a whole number of diamonds — got "
            f"{type(raw).__name__} {raw!r}."
        )
    if raw < 0:
        raise ProtectionError(f"{label} cannot be negative.")
    return raw


def house_limits() -> dict[str, int]:
    """The limit the business applies to everybody. 0 means "none set"."""
    return {
        str(Window.DAILY): _setting("protection_default_daily_loss_limit", 0),
        str(Window.WEEKLY): _setting("protection_default_weekly_loss_limit", 0),
    }


def effective_limit(doc: Mapping, window: Window | str) -> dict:
    """The limit in force for one window, and who set it.

    **The lowest positive limit wins**, and that is the whole rule. A player may
    always make their own stricter than the house's; they can never make it
    looser, because their number is not the only one considered. A limit imposed
    by staff on a review sits in the same comparison, so a player cannot undo it
    by setting a large one of their own — they can only go below it.
    """
    key = str(window)
    stored = (doc.get("limits") or {}).get(key) or {}
    candidates: list[tuple[int, str]] = []

    house = house_limits().get(key, 0)
    if house > 0:
        candidates.append((house, str(Source.HOUSE)))
    for source in (Source.STAFF, Source.PLAYER):
        entry = stored.get(str(source)) or {}
        amount = entry.get("amount")
        if isinstance(amount, int) and not isinstance(amount, bool) and amount > 0:
            candidates.append((amount, str(source)))

    if not candidates:
        return {"window": key, "amount": None, "source": None, "set": False}
    amount, source = min(candidates, key=lambda pair: pair[0])
    return {"window": key, "amount": amount, "source": source, "set": True}


def _apply_due_increases(doc: Mapping, now: datetime) -> tuple[dict, list[dict]]:
    """Move any limit increase whose delay has run out into force.

    Pure. Returns the record as it should now read and the increases that
    matured, so the caller can persist and audit them in one write.
    """
    pending = list(doc.get("pending_limits") or [])
    if not pending:
        return dict(doc), []

    limits = {k: dict(v) for k, v in (doc.get("limits") or {}).items()}
    matured: list[dict] = []
    still: list[dict] = []
    for entry in pending:
        effective_from = entry.get("effective_from")
        if isinstance(effective_from, datetime) and effective_from <= now:
            window, source = str(entry.get("window")), str(entry.get("source"))
            limits.setdefault(window, {})[source] = {
                "amount": int(entry.get("amount") or 0),
                "set_at": effective_from,
                "set_by": entry.get("requested_by"),
                "note": "A scheduled increase that has now taken effect.",
            }
            matured.append(entry)
        else:
            still.append(entry)

    out = dict(doc)
    out["limits"] = limits
    out["pending_limits"] = still
    return out, matured


async def _refresh(player_uid: str, now: datetime) -> dict:
    """Read the record with every timer in it brought up to date.

    Three things expire on a clock — a cooling-off period, the mandatory term of
    a self-exclusion, and the delay on a limit increase — and all three are
    resolved here, once, so no caller has to remember to. The resolved state is
    written back when it changed, which means the stored record is also what a
    staff screen reads rather than something only the gate knows.
    """
    doc = await _read(player_uid)
    changes: dict = {}

    doc, matured = _apply_due_increases(doc, now)
    if matured:
        changes["limits"] = doc["limits"]
        changes["pending_limits"] = doc["pending_limits"]

    cooling = doc.get("cooling_off") or None
    if cooling and _ended(cooling.get("until"), now):
        doc["cooling_off"] = None
        changes["cooling_off"] = None

    exclusion = doc.get("self_exclusion") or None
    if exclusion and exclusion.get("status") == str(ExclusionStatus.ACTIVE):
        if _ended(exclusion.get("minimum_until"), now):
            # The term is served. The exclusion does NOT lift — it becomes
            # liftable, which is a different thing and the whole of the second
            # half of the self-exclusion argument in the module docstring.
            exclusion = {**exclusion, "status": str(ExclusionStatus.EXPIRED)}
            doc["self_exclusion"] = exclusion
            changes["self_exclusion"] = exclusion

    if changes:
        await _write(player_uid, changes)
        for entry in matured:
            await audit.record(
                actor=SYSTEM_ACTOR,
                action=Act.LIMIT_SET,
                subject_type="player_protection",
                subject_id=player_uid,
                reason=(
                    f"A {entry.get('window')} loss limit increase to "
                    f"{entry.get('amount')} diamonds, requested "
                    f"{_setting('protection_limit_increase_delay_hours', 24)} "
                    "hours earlier, has taken effect."
                ),
                after={"window": entry.get("window"), "amount": entry.get("amount")},
                meta={"source": entry.get("source"), "delayed": True},
            )
    return doc


def _ended(until: Any, now: datetime) -> bool:
    return isinstance(until, datetime) and _aware(until) <= now


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


async def loss_in_window(
    player_uid: str, since: datetime, until: datetime
) -> dict:
    """Staked minus returned, over one window, across **every** mechanic.

    One aggregation over `chance_rounds`, the collection that already records
    every play with its stake, its payout, its player and its timestamp. Only
    `recorded` and `settled` rounds count: a `committed` round staked nothing
    and a `void` one was refused before the debit, so counting either would
    charge a player for a play that never happened.

    Fails closed like everything else here — an aggregation that raises is an
    unreadable limit, not a zero.
    """
    match = {
        "player_uid": player_uid,
        "status": {"$in": ["recorded", "settled"]},
        "played_at": {"$gte": since, "$lt": until},
    }
    try:
        cursor = get_db()[C.CHANCE_ROUNDS].aggregate(
            [
                {"$match": match},
                {
                    "$group": {
                        "_id": None,
                        "staked": {"$sum": "$total_stake"},
                        "returned": {"$sum": "$payout"},
                        "rounds": {"$sum": 1},
                    }
                },
            ]
        )
        rows = [row async for row in cursor]
    except Exception as exc:  # noqa: BLE001 — see `_read`
        log.error(
            "player_protection: could not total %s's losses (%s: %s); refusing",
            player_uid,
            type(exc).__name__,
            exc,
        )
        raise ProtectionUnavailable(f"{type(exc).__name__}: {exc}") from exc

    row = rows[0] if rows else {}
    staked = int(row.get("staked") or 0)
    returned = int(row.get("returned") or 0)
    return {
        "since": since,
        "until": until,
        "staked": staked,
        "returned": returned,
        # Negative when the player is ahead, and deliberately not clamped here.
        # `headroom` below is where the clamp belongs, because a player who is
        # up 500 does not get 500 diamonds of extra permission to lose.
        "net_loss": staked - returned,
        "rounds": int(row.get("rounds") or 0),
    }


def headroom(limit: int | None, net_loss: int) -> int | None:
    """The largest stake this limit still permits. None when no limit is set.

    Clamped at zero from below, which is the answer to "a player who is ahead
    can lose more than their limit": they cannot. Being 500 up does not buy 500
    diamonds of extra allowance, it just means the loss counter has not started.
    """
    if limit is None:
        return None
    return max(0, limit - max(0, net_loss))


async def _window_state(
    player_uid: str, doc: Mapping, window: Window, now: datetime
) -> dict:
    since, until, label = (
        day_window(now) if window is Window.DAILY else week_window(now)
    )
    limit = effective_limit(doc, window)
    loss = await loss_in_window(player_uid, since, until)
    amount = limit["amount"]
    return {
        "window": str(window),
        "label": label,
        "limit": amount,
        "limit_source": limit["source"],
        "since": since,
        "until": until,
        "resets_at": until,
        "resets_at_local": local_text(until),
        "timezone": _zone_name(),
        "staked": loss["staked"],
        "returned": loss["returned"],
        "net_loss": loss["net_loss"],
        "rounds": loss["rounds"],
        "headroom": headroom(amount, loss["net_loss"]),
    }


# ── Setting a limit ───────────────────────────────────────────────────────────


def _increase_delay_hours() -> int:
    return max(0, _setting("protection_limit_increase_delay_hours", 24))


async def set_player_limits(
    *,
    player_uid: str,
    daily: int | None = None,
    weekly: int | None = None,
    now: datetime | None = None,
) -> dict:
    """The player sets their own daily and weekly loss limits. Spec 8B.6.1.

    **A reduction is immediate. An increase waits.** That asymmetry is the only
    thing that makes a self-set limit mean anything: a player who reaches their
    limit and can raise it in the same minute has not been limited, they have
    been asked a question at the worst possible moment. So an increase is
    written as a *pending* change that takes effect
    `protection_limit_increase_delay_hours` later — by which time the session
    that prompted it is over — and the old, lower limit is enforced until then.

    Setting a limit to 0 removes the player's own limit, and that is an increase
    like any other: it waits out the same delay, and any house or staff limit
    underneath it is untouched and still applies.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    doc = await _refresh(player_uid, now)

    limits = {k: dict(v) for k, v in (doc.get("limits") or {}).items()}
    pending = [dict(p) for p in (doc.get("pending_limits") or [])]
    immediate: list[dict] = []
    scheduled: list[dict] = []

    for window, requested in ((Window.DAILY, daily), (Window.WEEKLY, weekly)):
        if requested is None:
            continue
        amount = _amount(requested, f"A {window} loss limit")
        ceiling = _setting("protection_max_loss_limit", 10_000_000)
        if amount > ceiling:
            raise ProtectionError(
                f"The largest loss limit this system will hold is {ceiling:,} "
                f"diamonds. {amount:,} is not a limit anybody is protected by."
            )
        key = str(window)
        current = (limits.get(key) or {}).get(str(Source.PLAYER)) or {}
        existing = int(current.get("amount") or 0)
        # 0 means "no limit of my own", which is the loosest setting there is —
        # so it compares as larger than any real number, not as smaller.
        looser = amount == 0 or (existing != 0 and amount > existing)

        entry = {
            "amount": amount,
            "set_at": now,
            "set_by": {"uid": player_uid, "name": "the player", "role": "player"},
        }
        if not looser:
            limits.setdefault(key, {})[str(Source.PLAYER)] = entry
            # A tightening supersedes any increase still waiting for the same
            # window, or the delay would quietly undo the decision just made.
            pending = [p for p in pending if str(p.get("window")) != key]
            immediate.append({"window": key, "amount": amount})
        else:
            effective_from = now + timedelta(hours=_increase_delay_hours())
            pending = [p for p in pending if str(p.get("window")) != key]
            pending.append(
                {
                    "window": key,
                    "source": str(Source.PLAYER),
                    "amount": amount,
                    "requested_at": now,
                    "effective_from": effective_from,
                    "requested_by": {"uid": player_uid, "name": "the player"},
                }
            )
            scheduled.append(
                {
                    "window": key,
                    "amount": amount,
                    "effective_from": effective_from,
                    "effective_from_local": local_text(effective_from),
                }
            )

    await _write(player_uid, {"limits": limits, "pending_limits": pending})

    for change in immediate:
        await audit.record(
            actor=SYSTEM_ACTOR,
            action=Act.LIMIT_SET,
            subject_type="player_protection",
            subject_id=player_uid,
            reason=(
                f"The player set their own {change['window']} loss limit to "
                f"{change['amount']} diamonds. A reduction takes effect at once."
            ),
            after=change,
            meta={"source": str(Source.PLAYER), "immediate": True},
        )
    for change in scheduled:
        await audit.record(
            actor=SYSTEM_ACTOR,
            action=Act.LIMIT_INCREASE_SCHEDULED,
            subject_type="player_protection",
            subject_id=player_uid,
            reason=(
                f"The player asked to raise their {change['window']} loss limit "
                f"to {change['amount']} diamonds. It takes effect in "
                f"{_increase_delay_hours()} hours; the lower limit applies "
                "until then."
            ),
            after=change,
            meta={"source": str(Source.PLAYER), "immediate": False},
        )

    status = await player_status(player_uid, now=now)
    status["applied_now"] = immediate
    status["takes_effect_later"] = scheduled
    return status


async def set_staff_limits(
    *,
    player_uid: str,
    daily: int | None = None,
    weekly: int | None = None,
    reason: str,
    actor: Mapping,
    now: datetime | None = None,
) -> dict:
    """Staff impose a loss limit on one player. Spec 8B.6.1 and 8B.6.5.

    Immediate in both directions, unlike the player's own — a limit a reviewer
    decided on is a control, and a control that takes a day to bite is not one.
    Recorded against a named person with a mandatory reason, because this is a
    restriction placed on somebody's account by somebody else.
    """
    player_uid = _uid(player_uid)
    reason = _reason(reason)
    person = named_person(actor)
    now = now or _now()
    doc = await _refresh(player_uid, now)

    limits = {k: dict(v) for k, v in (doc.get("limits") or {}).items()}
    applied: list[dict] = []
    for window, requested in ((Window.DAILY, daily), (Window.WEEKLY, weekly)):
        if requested is None:
            continue
        amount = _amount(requested, f"A {window} loss limit")
        limits.setdefault(str(window), {})[str(Source.STAFF)] = {
            "amount": amount,
            "set_at": now,
            "set_by": person,
            "reason": reason,
        }
        applied.append({"window": str(window), "amount": amount})

    if not applied:
        raise ProtectionError("Name at least one limit to set.")

    before = {
        str(w): effective_limit(doc, w)["amount"] for w in (Window.DAILY, Window.WEEKLY)
    }
    await _write(player_uid, {"limits": limits})
    await audit.record(
        actor=dict(actor),
        action=Act.LIMIT_SET,
        subject_type="player_protection",
        subject_id=player_uid,
        reason=reason,
        before=before,
        after={"limits": applied},
        meta={"source": str(Source.STAFF), "decided_by": person},
    )
    return await player_status(player_uid, now=now)


# ══════════════════════════════════════════════════════════════════════════════
#  8B.6.2 — self-exclusion, and a cooling-off period a player sets themselves
# ══════════════════════════════════════════════════════════════════════════════


async def self_exclude(
    *,
    player_uid: str,
    days: int,
    note: str = "",
    now: datetime | None = None,
) -> dict:
    """The player excludes themselves. Spec 8B.6.2.

    The term may not be shorter than `protection_min_self_exclusion_days`. That
    is not a formality: a self-exclusion a player can set for an hour is a
    cooling-off with a frightening name, and offering it as one would let
    somebody reach for the serious tool and get the light one. The light one is
    `start_cooling_off`, and it is right there.

    An existing exclusion is **extended, never replaced**. Asking for six months
    while nine are already running leaves nine running, and says so.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    minimum = max(1, _setting("protection_min_self_exclusion_days", 180))
    days = _amount(days, "A self-exclusion length in days")
    if days < minimum:
        raise ProtectionError(
            f"A self-exclusion runs for at least {minimum} days. If you want a "
            "shorter break, a cooling-off period is the right thing and you can "
            "set one for anything from "
            f"{_setting('protection_min_cooling_off_hours', 24)} hours to "
            f"{_setting('protection_max_cooling_off_days', 90)} days."
        )

    doc = await _refresh(player_uid, now)
    existing = doc.get("self_exclusion") or None
    until = now + timedelta(days=days)
    extended = False
    if existing and existing.get("status") in {
        str(ExclusionStatus.ACTIVE),
        str(ExclusionStatus.EXPIRED),
        str(ExclusionStatus.LIFT_REQUESTED),
    }:
        current_until = existing.get("minimum_until")
        if isinstance(current_until, datetime) and _aware(current_until) >= until:
            return {
                "already_excluded": True,
                "message": _exclusion_message(existing, now),
                "status": await player_status(player_uid, now=now),
            }
        extended = True

    record = {
        "status": str(ExclusionStatus.ACTIVE),
        "requested_at": now,
        "days": days,
        "minimum_until": until,
        "note": str(note or "")[:500],
        # Written on the record itself so nobody reading it later has to know
        # this module's rules to understand why it did not simply end.
        "lift_rule": (
            "This does not end on its own. When the minimum term is served the "
            "account stays excluded until the player asks for it to be lifted, "
            "a reflection period passes, and a named member of staff records a "
            "decision (8B.6.2 / 8B.6.5)."
        ),
        "lift_request": None,
        "lifted_by": None,
        "lifted_at": None,
    }
    await _write(player_uid, {"self_exclusion": record})
    await audit.record(
        actor=SYSTEM_ACTOR,
        action=Act.EXCLUSION_EXTENDED if extended else Act.SELF_EXCLUDED,
        subject_type="player_protection",
        subject_id=player_uid,
        reason=(
            f"The player excluded themselves from chance mechanics for {days} "
            "days. It cannot be shortened, and it does not lift on its own."
        ),
        before={"self_exclusion": (existing or {}).get("status")},
        after={"status": str(ExclusionStatus.ACTIVE), "minimum_until": until},
        meta={"extended": extended, "days": days},
    )
    return {
        "already_excluded": False,
        "extended": extended,
        "message": _exclusion_message(record, now),
        "status": await player_status(player_uid, now=now),
    }


def _exclusion_message(record: Mapping, now: datetime) -> str:
    status = str(record.get("status") or "")
    until = record.get("minimum_until")
    if status == str(ExclusionStatus.ACTIVE):
        return (
            "You are excluded from chance mechanics until at least "
            f"{local_text(_aware(until)) if isinstance(until, datetime) else 'the end of the term'}. "
            "Nothing can shorten that. When the term is served your account "
            "stays closed to these features until you ask for it to be reopened "
            "and somebody here reviews the request — so there is nothing you "
            "need to do in the meantime, and nothing you can do by accident."
        )
    if status == str(ExclusionStatus.EXPIRED):
        return (
            "Your self-exclusion term has been served. Your account is still "
            "closed to chance mechanics, and it stays closed until you ask us "
            "to reopen it and somebody here reviews that request."
        )
    if status == str(ExclusionStatus.LIFT_REQUESTED):
        request = record.get("lift_request") or {}
        earliest = request.get("earliest_decision_at")
        return (
            "We have your request to reopen chance mechanics. Somebody will "
            "look at it"
            + (
                f" from {local_text(_aware(earliest))} onwards"
                if isinstance(earliest, datetime)
                else ""
            )
            + ". Until they do, your account stays closed to these features."
        )
    return "Chance mechanics are open on your account."


async def request_exclusion_lift(
    *, player_uid: str, note: str = "", now: datetime | None = None
) -> dict:
    """The player asks for a served exclusion to be reopened. It does not lift.

    Two things are true of this function and both are load-bearing. It cannot be
    called before the minimum term is served, and calling it changes nothing
    about whether the player may play — it starts a clock and puts the account
    on somebody's desk. The reflection period between the request and the
    earliest possible decision exists because the moment somebody asks to be let
    back in is the moment they are least well placed to judge whether they
    should be.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    doc = await _refresh(player_uid, now)
    record = doc.get("self_exclusion") or None
    if not record or record.get("status") in {
        None,
        str(ExclusionStatus.LIFTED),
        str(ExclusionStatus.NONE),
    }:
        raise ProtectionError("There is no self-exclusion on this account.")
    if record.get("status") == str(ExclusionStatus.ACTIVE):
        until = record.get("minimum_until")
        raise ProtectionError(
            "This self-exclusion is still inside its minimum term"
            + (
                f", which runs until {local_text(_aware(until))}"
                if isinstance(until, datetime)
                else ""
            )
            + ". It cannot be shortened by anybody, including us."
        )
    if record.get("status") == str(ExclusionStatus.LIFT_REQUESTED):
        return {
            "requested": False,
            "already_requested": True,
            "message": _exclusion_message(record, now),
        }

    hours = max(0, _setting("protection_exclusion_reflection_hours", 72))
    earliest = now + timedelta(hours=hours)
    updated = {
        **record,
        "status": str(ExclusionStatus.LIFT_REQUESTED),
        "lift_request": {
            "asked_at": now,
            "earliest_decision_at": earliest,
            "note": str(note or "")[:500],
        },
    }
    await _write(player_uid, {"self_exclusion": updated})
    await audit.record(
        actor=SYSTEM_ACTOR,
        action=Act.LIFT_REQUESTED,
        subject_type="player_protection",
        subject_id=player_uid,
        reason=(
            "The player asked for their served self-exclusion to be lifted. "
            "Nothing is reopened by the request; it waits "
            f"{hours} hours and then a named person decides."
        ),
        after={"earliest_decision_at": earliest},
        meta={"reflection_hours": hours},
    )
    return {
        "requested": True,
        "already_requested": False,
        "earliest_decision_at": earliest,
        "earliest_decision_at_local": local_text(earliest),
        "message": _exclusion_message(updated, now),
    }


async def decide_exclusion_lift(
    *,
    player_uid: str,
    approve: bool,
    reason: str,
    actor: Mapping,
    now: datetime | None = None,
) -> dict:
    """A named person decides whether a served exclusion is lifted. Spec 8B.6.2.

    The last of the three acts, and the only one that can reopen the account.
    Refused before the reflection period has run, refused where no request was
    made, refused where the term is still running, and refused to a machine.
    A refusal to lift leaves the account excluded and is recorded exactly as
    carefully as an approval — a decision not to reopen is still a decision
    somebody made about somebody else's account.
    """
    player_uid = _uid(player_uid)
    reason = _reason(reason)
    person = named_person(actor)
    now = now or _now()
    doc = await _refresh(player_uid, now)
    record = doc.get("self_exclusion") or None

    if not record or record.get("status") != str(ExclusionStatus.LIFT_REQUESTED):
        raise ProtectionError(
            "There is no request to reopen chance mechanics on this account. A "
            "self-exclusion is never lifted on our initiative — the player has "
            "to ask first (8B.6.2)."
        )
    earliest = (record.get("lift_request") or {}).get("earliest_decision_at")
    if isinstance(earliest, datetime) and _aware(earliest) > now:
        raise ProtectionError(
            "The reflection period on this request has not finished. It can be "
            f"decided from {local_text(_aware(earliest))} onwards. The wait is "
            "the control; deciding early removes it."
        )

    decision = {
        "decided_at": now,
        "decided_by": person,
        "approved": bool(approve),
        "reason": reason,
    }
    if approve:
        updated = {
            **record,
            "status": str(ExclusionStatus.LIFTED),
            "lifted_at": now,
            "lifted_by": person,
            "decision": decision,
        }
    else:
        # Back to `expired`: the term is still served, so the player may ask
        # again. Refusing once does not re-impose a term they already did.
        updated = {
            **record,
            "status": str(ExclusionStatus.EXPIRED),
            "lift_request": None,
            "decision": decision,
        }

    await _write(player_uid, {"self_exclusion": updated})
    await audit.record(
        actor=dict(actor),
        action=Act.LIFT_DECIDED,
        subject_type="player_protection",
        subject_id=player_uid,
        reason=reason,
        before={"status": str(ExclusionStatus.LIFT_REQUESTED)},
        after={"status": updated["status"], "approved": bool(approve)},
        meta={"decided_by": person},
    )
    return {
        "approved": bool(approve),
        "decided_by": person,
        "decided_at": now,
        "reason": reason,
        "status": await player_status(player_uid, now=now),
    }


async def start_cooling_off(
    *, player_uid: str, hours: int, note: str = "", now: datetime | None = None
) -> dict:
    """A short break the player sets for themselves. Spec 8B.6.2.

    Bounded at both ends. Below `protection_min_cooling_off_hours` it is not a
    break, it is a pause between two taps; above
    `protection_max_cooling_off_days` the honest tool is a self-exclusion and
    saying so is better than letting somebody take a nine-month cooling-off that
    they can cancel — because unlike a self-exclusion, this one **does** end on
    its own, and that is exactly what makes it the light tool.

    Like a self-exclusion it cannot be cancelled early or shortened. It can only
    be extended.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    hours = _amount(hours, "A cooling-off period in hours")
    floor = max(1, _setting("protection_min_cooling_off_hours", 24))
    ceiling_days = max(1, _setting("protection_max_cooling_off_days", 90))
    if hours < floor:
        raise ProtectionError(
            f"A cooling-off period is at least {floor} hours. A shorter one is "
            "not a break."
        )
    if hours > ceiling_days * 24:
        raise ProtectionError(
            f"A cooling-off period runs for at most {ceiling_days} days. For "
            "longer than that, a self-exclusion is the right thing — and unlike "
            "this, it does not end on its own."
        )

    doc = await _refresh(player_uid, now)
    until = now + timedelta(hours=hours)
    existing = doc.get("cooling_off") or None
    current_until = (existing or {}).get("until")
    if isinstance(current_until, datetime) and _aware(current_until) >= until:
        return {
            "started": False,
            "until": _aware(current_until),
            "until_local": local_text(_aware(current_until)),
            "message": (
                "You already have a longer break running. It ends on "
                f"{local_text(_aware(current_until))}."
            ),
        }

    record = {
        "started_at": now,
        "hours": hours,
        "until": until,
        "note": str(note or "")[:500],
    }
    await _write(player_uid, {"cooling_off": record})
    await audit.record(
        actor=SYSTEM_ACTOR,
        action=Act.COOLING_OFF,
        subject_type="player_protection",
        subject_id=player_uid,
        reason=(
            f"The player set a cooling-off period of {hours} hours. It cannot "
            "be cancelled early and it ends on its own."
        ),
        after={"until": until, "hours": hours},
        meta={"extended": bool(existing)},
    )
    return {
        "started": True,
        "until": until,
        "until_local": local_text(until),
        "message": (
            f"Chance mechanics are off on your account until {local_text(until)}. "
            "Nothing else changes and your balance is untouched."
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  8B.6.3 — session reminders
# ══════════════════════════════════════════════════════════════════════════════
#
# A session is **derived from the rounds themselves** rather than tracked by the
# app. Two reasons, and the second is the important one: a client-reported
# session is a client-reported figure, and a client that stops reporting is a
# player who never gets a reminder; and a derived session survives a crash, a
# reinstall, a second device and a background kill, because the evidence is
# `chance_rounds` and that is written by this server.
#
# The rule is a gap rule. Consecutive rounds more than
# `protection_session_gap_minutes` apart are two sessions; anything closer is
# continuous play. That is the same shape every analytics sessioniser uses, and
# it is the only definition of "continuous" that does not require the app to
# tell us when it thinks a session began.


async def _recent_rounds(player_uid: str, since: datetime, limit: int = 500) -> list[dict]:
    """This player's rounds since a moment, oldest first. Fails closed."""
    try:
        cursor = (
            get_db()[C.CHANCE_ROUNDS]
            .find(
                {
                    "player_uid": player_uid,
                    "status": {"$in": ["recorded", "settled"]},
                    "played_at": {"$gte": since},
                }
            )
            .sort("played_at", -1)
            .limit(limit)
        )
        rounds = [doc async for doc in cursor]
    except Exception as exc:  # noqa: BLE001 — see `_read`
        raise ProtectionUnavailable(f"{type(exc).__name__}: {exc}") from exc
    rounds.sort(key=lambda d: _aware(d["played_at"]) if d.get("played_at") else since)
    return rounds


def session_from(rounds: Sequence[Mapping], now: datetime) -> dict:
    """The current run of continuous play, from the round history.

    Pure, and takes the rounds it is given, so the gap rule can be checked
    directly rather than through a database.
    """
    gap = timedelta(minutes=max(1, _setting("protection_session_gap_minutes", 30)))
    played = [
        _aware(r["played_at"]) for r in rounds if isinstance(r.get("played_at"), datetime)
    ]
    if not played:
        return {"active": False, "started_at": None, "minutes": 0, "rounds": 0}

    played.sort()
    if now - played[-1] > gap:
        # The last round is old enough that the session has already ended.
        return {"active": False, "started_at": None, "minutes": 0, "rounds": 0}

    start = played[-1]
    count = 1
    for earlier, later in zip(reversed(played[:-1]), reversed(played[1:])):
        if later - earlier > gap:
            break
        start = earlier
        count += 1
    return {
        "active": True,
        "started_at": start,
        "minutes": int((now - start).total_seconds() // 60),
        "rounds": count,
    }


async def session_state(
    player_uid: str,
    *,
    now: datetime | None = None,
    record_reminder: bool = True,
) -> dict:
    """The player's current session, and any reminder that has fallen due.

    A reminder is due every `protection_session_reminder_minutes` of continuous
    play. It is **recorded server-side when it falls due**, on the protection
    record and in the audit log, whether or not the app ever asks for it — so
    "the reminder fired" is a fact about this server rather than a claim about a
    client, and a client that never displays one is a client we can prove was
    told.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    gap_minutes = max(1, _setting("protection_session_gap_minutes", 30))
    every = max(1, _setting("protection_session_reminder_minutes", 60))

    # A session cannot be longer than a day of continuous play with no gap
    # bigger than the gap rule; looking back a day is generous and bounded.
    rounds = await _recent_rounds(player_uid, now - timedelta(days=1))
    session = session_from(rounds, now)

    doc = await _read(player_uid)
    stored = doc.get("session") or {}
    started = session.get("started_at")
    same_session = (
        isinstance(stored.get("started_at"), datetime)
        and isinstance(started, datetime)
        and _aware(stored["started_at"]) == started
    )
    sent = int(stored.get("reminders_sent") or 0) if same_session else 0

    due = None
    if session["active"] and session["minutes"] >= every * (sent + 1):
        milestone = every * (sent + 1)
        # If the process was asleep through two milestones, the reminder names
        # the real elapsed time rather than the one it happened to catch.
        due = {
            "at": now,
            "minutes": session["minutes"],
            "milestone_minutes": milestone,
            "message": (
                f"You have been playing for {session['minutes']} minutes. "
                "There is nothing wrong — this is just a note of the time, "
                "since it is easy to lose track of. Your balance and your "
                "limits are unchanged."
            ),
        }

    if due and record_reminder:
        await _write(
            player_uid,
            {
                "session": {
                    "started_at": started,
                    "reminders_sent": sent + 1,
                    "last_reminder_at": now,
                    "last_reminder_minutes": session["minutes"],
                    "gap_minutes": gap_minutes,
                }
            },
        )
        await audit.record(
            actor=SYSTEM_ACTOR,
            action=Act.SESSION_REMINDER,
            subject_type="player_protection",
            subject_id=player_uid,
            reason=(
                f"{session['minutes']} minutes of continuous play "
                f"({session['rounds']} rounds); the "
                f"{due['milestone_minutes']}-minute reminder fell due (8B.6.3)."
            ),
            after={"minutes": session["minutes"], "reminder_number": sent + 1},
            meta={"session_started_at": started, "every_minutes": every},
        )
        sent += 1
    elif session["active"] and not same_session and record_reminder:
        await _write(
            player_uid,
            {
                "session": {
                    "started_at": started,
                    "reminders_sent": 0,
                    "last_reminder_at": None,
                    "gap_minutes": gap_minutes,
                }
            },
        )

    return {
        **session,
        "reminder_every_minutes": every,
        "session_gap_minutes": gap_minutes,
        "reminders_sent": sent,
        "reminder_due": due,
        "next_reminder_at": (
            _aware(started) + timedelta(minutes=every * (sent + 1))
            if session["active"] and isinstance(started, datetime)
            else None
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  8B.6.4 — automatic flagging of behaviour associated with harm
# ══════════════════════════════════════════════════════════════════════════════
#
# Three patterns, named by the spec, and each one is arithmetic over rounds this
# server wrote. None of them is a conclusion: a flag says "somebody should look
# at this", never "this person has a problem", and nothing in this module acts
# on one. 8B.6.5 is the acting, and it is a person.


def _is_loss(round_doc: Mapping) -> bool:
    return int(round_doc.get("payout") or 0) < int(round_doc.get("total_stake") or 0)


def detect_patterns(
    rounds: Sequence[Mapping],
    session: Mapping,
    *,
    pending_stake: int = 0,
    now: datetime | None = None,
) -> list[dict]:
    """Every pattern the recent history shows. Pure — no database, no writes.

    `pending_stake` is the stake of the play being attempted right now, which is
    not in `rounds` yet because nothing is written until the play is allowed.
    Including it is what lets the escalating-stake pattern be caught on the
    round that completes it rather than one round late.
    """
    now = now or _now()
    findings: list[dict] = []

    ordered = [
        r
        for r in rounds
        if isinstance(r.get("played_at"), datetime)
        and isinstance(r.get("total_stake"), int)
    ]
    ordered.sort(key=lambda r: _aware(r["played_at"]))

    # ── 1. Escalating stakes after losses ────────────────────────────────────
    #
    # The chase, in its plainest form: every round a loss, every stake at least
    # the one before, and the last one a multiple of the first. All three
    # conditions together, because any one alone is ordinary — a run of losses
    # is a Tuesday, and a bigger stake after a win is not a chase.
    need = max(2, _setting("protection_harm_escalation_rounds", 5))
    multiple = max(2, _setting("protection_harm_escalation_multiple", 3))
    trailing: list[int] = []
    for r in reversed(ordered):
        if not _is_loss(r):
            break
        trailing.append(int(r["total_stake"]))
    trailing.reverse()
    if pending_stake > 0:
        trailing = trailing + [int(pending_stake)]

    run: list[int] = []
    for stake in trailing:
        if run and stake < run[-1]:
            run = [stake]
        else:
            run.append(stake)
    if len(run) >= need and run[0] > 0 and run[-1] >= run[0] * multiple:
        findings.append(
            {
                "pattern": str(Pattern.ESCALATING_STAKES),
                "severity": "act",
                "headline": (
                    f"{len(run)} losing rounds in a row with the stake rising "
                    f"from {run[0]} to {run[-1]} diamonds"
                ),
                "evidence": {
                    "consecutive_losing_rounds": len(run),
                    "first_stake": run[0],
                    "last_stake": run[-1],
                    "multiple": run[-1] // run[0],
                    "threshold_rounds": need,
                    "threshold_multiple": multiple,
                    "includes_pending_stake": pending_stake > 0,
                },
            }
        )

    # ── 2. A sustained session ───────────────────────────────────────────────
    sustained = max(1, _setting("protection_harm_session_minutes", 180))
    if session.get("active") and int(session.get("minutes") or 0) >= sustained:
        findings.append(
            {
                "pattern": str(Pattern.SUSTAINED_SESSION),
                "severity": "watch",
                "headline": (
                    f"{int(session['minutes'])} minutes of continuous play "
                    f"({int(session.get('rounds') or 0)} rounds)"
                ),
                "evidence": {
                    "session_minutes": int(session["minutes"]),
                    "session_rounds": int(session.get("rounds") or 0),
                    "session_started_at": session.get("started_at"),
                    "threshold_minutes": sustained,
                },
            }
        )

    # ── 3. Rapid repeat play ─────────────────────────────────────────────────
    #
    # Distinct from a long session: this is rate, not duration. Twenty rounds in
    # ten minutes is somebody tapping without reading, which is the behaviour a
    # sustained-session check would miss entirely at minute nine.
    rapid_rounds = max(2, _setting("protection_harm_rapid_rounds", 20))
    rapid_window = max(1, _setting("protection_harm_rapid_window_minutes", 10))
    cutoff = now - timedelta(minutes=rapid_window)
    in_window = [r for r in ordered if _aware(r["played_at"]) >= cutoff]
    count = len(in_window) + (1 if pending_stake > 0 else 0)
    if count >= rapid_rounds:
        findings.append(
            {
                "pattern": str(Pattern.RAPID_REPEAT),
                "severity": "act",
                "headline": f"{count} rounds inside {rapid_window} minutes",
                "evidence": {
                    "rounds_in_window": count,
                    "window_minutes": rapid_window,
                    "threshold_rounds": rapid_rounds,
                    "staked_in_window": sum(
                        int(r.get("total_stake") or 0) for r in in_window
                    )
                    + int(pending_stake or 0),
                },
            }
        )

    return findings


async def raise_flags(
    player_uid: str, findings: Iterable[Mapping], *, now: datetime | None = None
) -> list[dict]:
    """Write a flag for each finding that does not already have an open one.

    One open flag per (player, pattern). A second detection of the same pattern
    updates the evidence on the flag already waiting to be reviewed rather than
    creating a queue of a hundred identical cards — which is the failure mode
    that gets a review queue ignored, and an ignored queue is worse than none
    because it looks like a control from the outside.

    Nothing here is ever closed automatically. `review_flag` is the only writer
    of a `reviewed` status in this module, and it needs a named person.
    """
    now = now or _now()
    out: list[dict] = []
    collection = get_db()[C.PLAYER_PROTECTION_FLAGS]
    for finding in findings:
        pattern = str(finding.get("pattern"))
        try:
            existing = await collection.find_one(
                {
                    "player_uid": player_uid,
                    "pattern": pattern,
                    "status": str(FlagStatus.OPEN),
                }
            )
        except Exception as exc:  # noqa: BLE001
            # Detection failing must never take a play down with it: the flag is
            # a control that runs *beside* the play, not one the play depends
            # on. The limits and the exclusion are the ones that fail closed.
            log.error("player_protection: could not read flags for %s: %s", player_uid, exc)
            return out

        if existing:
            await collection.update_one(
                {"flag_id": existing["flag_id"]},
                {
                    "$set": {
                        "last_seen_at": now,
                        "evidence": dict(finding.get("evidence") or {}),
                        "headline": finding.get("headline"),
                        "severity": finding.get("severity"),
                    },
                    "$inc": {"seen": 1},
                },
            )
            out.append({**_public(existing), "already_open": True})
            continue

        flag = {
            "flag_id": secrets.token_hex(12),
            "player_uid": player_uid,
            "pattern": pattern,
            "status": str(FlagStatus.OPEN),
            "severity": str(finding.get("severity") or "watch"),
            "headline": str(finding.get("headline") or ""),
            "evidence": dict(finding.get("evidence") or {}),
            "detected_at": now,
            "last_seen_at": now,
            "seen": 1,
            "review": None,
            "note": (
                "Detected automatically. A flag is a request for somebody to "
                "look, never a conclusion about the player, and nothing acts on "
                "it until a named person records a decision (8B.6.5)."
            ),
        }
        try:
            await collection.insert_one(flag)
        except Exception as exc:  # noqa: BLE001 — including a unique-index race
            log.warning(
                "player_protection: flag for %s/%s was not written: %s",
                player_uid,
                pattern,
                exc,
            )
            continue

        await audit.record(
            actor=SYSTEM_ACTOR,
            action=Act.FLAG_RAISED,
            subject_type="player_protection_flag",
            subject_id=flag["flag_id"],
            reason=(
                f"{pattern.replace('_', ' ')}: {flag['headline']}. Flagged for "
                "review under 8B.6.4; no play was stopped and no money moved."
            ),
            after={"player_uid": player_uid, "pattern": pattern},
            meta={"evidence": flag["evidence"], "severity": flag["severity"]},
        )
        out.append({**_public(flag), "already_open": False})
    return out


async def list_flags(
    *, status: str | None = None, player_uid: str | None = None, limit: int = 100
) -> list[dict]:
    """The review queue, newest first. Spec 8B.6.5."""
    query: dict = {}
    if status:
        query["status"] = str(status)
    if player_uid:
        query["player_uid"] = _uid(player_uid)
    cursor = (
        get_db()[C.PLAYER_PROTECTION_FLAGS]
        .find(query)
        .sort("detected_at", -1)
        .limit(max(1, min(int(limit), 500)))
    )
    return [_public(doc) async for doc in cursor]


async def get_flag(flag_id: str) -> dict:
    doc = await get_db()[C.PLAYER_PROTECTION_FLAGS].find_one(
        {"flag_id": str(flag_id or "").strip()}
    )
    if doc is None:
        raise ProtectionError("No such flag.")
    return _public(doc)


# ══════════════════════════════════════════════════════════════════════════════
#  8B.6.5 — a named person reviews it, and the decision is recorded
# ══════════════════════════════════════════════════════════════════════════════


async def review_flag(
    *,
    flag_id: str,
    decision: str,
    reason: str,
    actor: Mapping,
    daily_limit: int | None = None,
    weekly_limit: int | None = None,
    suspend_days: int | None = None,
    now: datetime | None = None,
) -> dict:
    """Close a flag with a decision. The only thing in this module that can.

    Four requirements, and each one is a refusal rather than a convention:

      * **a named person**, never a machine and never an unnamed session
        (`named_person`);
      * **a decision from a fixed vocabulary**, so the queue can be counted and
        so "reviewed" is not a synonym for "clicked";
      * **a reason of real length**, mandatory, recorded on the flag and in the
        audit log;
      * **the consequence, if any, applied here** — a limit imposed or play
        suspended happens as part of the decision rather than as a second action
        somebody might not take.

    Nothing about this is automatic and nothing about it is reversible by the
    same click: reopening a suspension is `decide_exclusion_lift`, which is a
    separate decision with its own reason.
    """
    flag_id = str(flag_id or "").strip()
    reason = _reason(reason)
    person = named_person(actor)
    now = now or _now()

    try:
        choice = Decision(str(decision))
    except ValueError as exc:
        allowed = ", ".join(str(d) for d in Decision)
        raise ProtectionError(
            f"'{decision}' is not a review decision. One of: {allowed}."
        ) from exc

    doc = await get_db()[C.PLAYER_PROTECTION_FLAGS].find_one({"flag_id": flag_id})
    if doc is None:
        raise ProtectionError("No such flag.")
    if doc.get("status") == str(FlagStatus.REVIEWED):
        review = doc.get("review") or {}
        raise ProtectionError(
            "This flag was already reviewed by "
            f"{(review.get('by') or {}).get('name', 'somebody')} on "
            f"{local_text(_aware(review['at'])) if isinstance(review.get('at'), datetime) else 'an earlier date'}. "
            "A second decision on the same flag would overwrite theirs; raise a "
            "new one if the behaviour has continued."
        )

    player_uid = str(doc.get("player_uid") or "")
    applied: dict = {}

    if choice is Decision.LIMIT_IMPOSED:
        if daily_limit is None and weekly_limit is None:
            raise ProtectionError(
                "A decision of 'limit_imposed' has to name the limit it "
                "imposes, or nothing was imposed."
            )
        await set_staff_limits(
            player_uid=player_uid,
            daily=daily_limit,
            weekly=weekly_limit,
            reason=reason,
            actor=actor,
            now=now,
        )
        applied = {"daily_limit": daily_limit, "weekly_limit": weekly_limit}

    if choice is Decision.PLAY_SUSPENDED:
        days = _amount(
            suspend_days if suspend_days is not None else 30,
            "A suspension length in days",
        )
        if days < 1:
            raise ProtectionError("A suspension runs for at least a day.")
        until = now + timedelta(days=days)
        await _write(
            player_uid,
            {
                "staff_suspension": {
                    "until": until,
                    "days": days,
                    "imposed_at": now,
                    "imposed_by": person,
                    "reason": reason,
                    "flag_id": flag_id,
                }
            },
        )
        applied = {"suspended_until": until, "days": days}

    review = {
        "by": person,
        "at": now,
        "decision": str(choice),
        "reason": reason,
        "applied": applied,
    }
    await get_db()[C.PLAYER_PROTECTION_FLAGS].update_one(
        {"flag_id": flag_id},
        {"$set": {"status": str(FlagStatus.REVIEWED), "review": review}},
    )
    await audit.record(
        actor=dict(actor),
        action=Act.FLAG_REVIEWED,
        subject_type="player_protection_flag",
        subject_id=flag_id,
        reason=reason,
        before={"status": str(FlagStatus.OPEN), "pattern": doc.get("pattern")},
        after={"status": str(FlagStatus.REVIEWED), "decision": str(choice)},
        meta={
            "player_uid": player_uid,
            "reviewed_by": person,
            "applied": applied,
            "pattern": doc.get("pattern"),
        },
    )
    return {**await get_flag(flag_id), "applied": applied}


# ══════════════════════════════════════════════════════════════════════════════
#  The gate — server-side, at the moment of play
# ══════════════════════════════════════════════════════════════════════════════


async def gate_commit(*, player_uid: str, now: datetime | None = None) -> dict:
    """Refuse to even open a round for a player who has asked us to stop.

    Called from `chance.commit_round`. Nothing is staked at commit time, so the
    loss limits cannot be evaluated here — the stake is not known yet — and this
    checks only the three states that do not depend on one. A player who has
    excluded themselves should not be handed a commitment, an odds table and a
    round id they will be refused on; "it must hold" means the door is shut, not
    that the last step fails.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    doc = await _refresh(player_uid, now)
    _refuse_if_stopped(doc, now)
    return {"allowed": True}


async def gate_play(
    *,
    player_uid: str,
    mechanic_id: str = "",
    total_stake: int = 0,
    now: datetime | None = None,
) -> dict:
    """The one enforcement point. Called from `chance.play_round`.

    Called after the round is claimed and the stake validated, and **before the
    stake leaves the balance** — so a refusal here means nothing was debited,
    which is what the message says. Raises `ProtectionBlocked` (or
    `ProtectionUnavailable`, which is one) and returns a summary otherwise.

    The order is deliberate. Exclusion and cooling-off come first because they
    are absolute and cheap; the loss windows come second because they cost a
    query each. Session reminders and pattern detection run **last and only on
    an allowed play**, because they describe play that is about to happen.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    stake = _amount(total_stake, "A stake")
    doc = await _refresh(player_uid, now)

    try:
        _refuse_if_stopped(doc, now)
        daily = await _window_state(player_uid, doc, Window.DAILY, now)
        _refuse_if_over(daily, stake, Block.DAILY_LOSS_LIMIT, "day")
        weekly = await _window_state(player_uid, doc, Window.WEEKLY, now)
        _refuse_if_over(weekly, stake, Block.WEEKLY_LOSS_LIMIT, "week")
    except ProtectionBlocked as blocked:
        await _record_block(player_uid, mechanic_id, stake, blocked, now)
        raise

    session = await session_state(player_uid, now=now)
    rounds = await _recent_rounds(player_uid, now - timedelta(days=1))
    findings = detect_patterns(rounds, session, pending_stake=stake, now=now)
    flags = await raise_flags(player_uid, findings, now=now) if findings else []

    return {
        "allowed": True,
        "daily": daily,
        "weekly": weekly,
        "session": session,
        "flags_raised": [f["flag_id"] for f in flags if not f.get("already_open")],
    }


def _refuse_if_stopped(doc: Mapping, now: datetime) -> None:
    """Self-exclusion, a staff suspension, and a cooling-off period.

    A pure refusal over an already-refreshed record, so the same three checks
    guard `commit_round` and `play_round` from one implementation.
    """
    exclusion = doc.get("self_exclusion") or None
    if exclusion and str(exclusion.get("status")) in {
        str(ExclusionStatus.ACTIVE),
        str(ExclusionStatus.EXPIRED),
        str(ExclusionStatus.LIFT_REQUESTED),
    }:
        until = exclusion.get("minimum_until")
        raise ProtectionBlocked(
            str(Block.SELF_EXCLUDED),
            _exclusion_message(exclusion, now),
            # Deliberately None even while a minimum term is running: nothing
            # happens automatically at the end of it, and promising a moment it
            # lifts would be a promise this system does not keep.
            lifts_at=None,
            detail={
                "status": exclusion.get("status"),
                "minimum_term_ends_at": _aware(until) if isinstance(until, datetime) else None,
                "minimum_term_ends_at_local": (
                    local_text(_aware(until)) if isinstance(until, datetime) else None
                ),
            },
        )

    suspension = doc.get("staff_suspension") or None
    until = (suspension or {}).get("until")
    if suspension and isinstance(until, datetime) and _aware(until) > now:
        raise ProtectionBlocked(
            str(Block.STAFF_SUSPENSION),
            "Chance mechanics are paused on your account while we look into "
            f"something. They open again on {local_text(_aware(until))}. "
            "Nothing else on your account is affected and your balance is "
            "unchanged.",
            lifts_at=_aware(until),
            detail={"until": _aware(until)},
        )

    cooling = doc.get("cooling_off") or None
    until = (cooling or {}).get("until")
    if cooling and isinstance(until, datetime) and _aware(until) > now:
        raise ProtectionBlocked(
            str(Block.COOLING_OFF),
            "You asked for a break from chance mechanics and it is still "
            f"running. It ends on {local_text(_aware(until))}, and everything "
            "opens up again by itself then. Your balance is unchanged.",
            lifts_at=_aware(until),
            detail={"until": _aware(until), "hours": cooling.get("hours")},
        )


def _refuse_if_over(state: Mapping, stake: int, kind: Block, word: str) -> None:
    """One loss window against one stake. See the module docstring for the rule."""
    limit = state.get("limit")
    if limit is None:
        return
    room = state.get("headroom")
    if room is None:
        return
    if stake <= room:
        return

    resets = state.get("resets_at")
    if room > 0:
        opening = (
            f"You have {room:,} diamonds left inside the {word}ly limit of "
            f"{int(limit):,} on your account, and this play would go past it."
        )
    else:
        opening = (
            f"You have reached the {word}ly limit of {int(limit):,} diamonds "
            "on your account."
        )
    raise ProtectionBlocked(
        str(kind),
        opening
        + " Nothing was staked and your balance is unchanged. The "
        f"{word} resets at {state.get('resets_at_local')}, and you can lower "
        "the limit at any time.",
        lifts_at=resets if isinstance(resets, datetime) else None,
        detail={
            "limit": int(limit),
            "limit_source": state.get("limit_source"),
            "net_loss": state.get("net_loss"),
            "staked": state.get("staked"),
            "returned": state.get("returned"),
            "headroom": room,
            "attempted_stake": stake,
            "window": state.get("window"),
            "window_label": state.get("label"),
            "timezone": state.get("timezone"),
        },
    )


async def _record_block(
    player_uid: str,
    mechanic_id: str,
    stake: int,
    blocked: ProtectionBlocked,
    now: datetime,
) -> None:
    """A refused play is a control acting, so it is written down like one.

    Best-effort by design: the play has already been refused by the time this
    runs, and a failure to write the record must not turn a refusal into an
    exception the caller handles differently. The refusal is the control; this
    is its evidence.
    """
    try:
        await _write(player_uid, {"last_blocked_at": now}, inc={"blocked_plays": 1})
    except ProtectionError:  # pragma: no cover — the store is already unhappy
        pass
    if blocked.kind == str(Block.UNAVAILABLE):
        return
    try:
        await audit.record(
            actor=SYSTEM_ACTOR,
            action=Act.PLAY_BLOCKED,
            subject_type="player_protection",
            subject_id=player_uid,
            reason=(
                f"A play of {stake} diamonds on "
                f"{mechanic_id or 'a chance mechanic'} was refused by "
                f"{blocked.kind} (8B.6). Nothing was staked and no balance "
                "moved."
            ),
            after={"kind": blocked.kind, "stake": stake, "mechanic_id": mechanic_id},
            meta={"detail": blocked.detail},
        )
    except Exception as exc:  # noqa: BLE001 — evidence, not enforcement
        log.error("player_protection: could not audit a blocked play: %s", exc)


# ══════════════════════════════════════════════════════════════════════════════
#  What a screen shows — the player's, and a reviewer's
# ══════════════════════════════════════════════════════════════════════════════


async def player_status(player_uid: str, *, now: datetime | None = None) -> dict:
    """Everything about one player's protections, in one read.

    This is the answer to "a limit reached is not an error": every figure a
    refusal would carry is available *before* the play, so the app can show the
    headroom, the reset time and any break that is running rather than
    discovering all three from a rejection.
    """
    player_uid = _uid(player_uid)
    now = now or _now()
    doc = await _refresh(player_uid, now)

    exclusion = doc.get("self_exclusion") or None
    cooling = doc.get("cooling_off") or None
    suspension = doc.get("staff_suspension") or None

    try:
        _refuse_if_stopped(doc, now)
        stopped = None
    except ProtectionBlocked as blocked:
        stopped = blocked.as_dict()

    return {
        "player_uid": player_uid,
        "can_play": stopped is None,
        "stopped": stopped,
        "daily": await _window_state(player_uid, doc, Window.DAILY, now),
        "weekly": await _window_state(player_uid, doc, Window.WEEKLY, now),
        "limits_apply_to": (
            "every chance mechanic on the account, not one at a time — a limit "
            "on one game that another game does not honour is not a limit "
            "(8B.6.1)."
        ),
        "pending_limit_changes": [
            {
                **{k: v for k, v in entry.items() if k != "requested_by"},
                "effective_from_local": local_text(entry.get("effective_from"))
                if isinstance(entry.get("effective_from"), datetime)
                else None,
            }
            for entry in (doc.get("pending_limits") or [])
        ],
        "self_exclusion": (
            {
                **exclusion,
                "message": _exclusion_message(exclusion, now),
                "can_be_lifted_by_anyone_now": False
                if str(exclusion.get("status")) == str(ExclusionStatus.ACTIVE)
                else None,
            }
            if exclusion
            else None
        ),
        "cooling_off": (
            {**cooling, "until_local": local_text(_aware(cooling["until"]))}
            if cooling and isinstance(cooling.get("until"), datetime)
            else None
        ),
        "staff_suspension": (
            {**suspension, "until_local": local_text(_aware(suspension["until"]))}
            if suspension and isinstance(suspension.get("until"), datetime)
            else None
        ),
        "session": await session_state(player_uid, now=now, record_reminder=False),
        "blocked_plays": int(doc.get("blocked_plays") or 0),
        "timezone": _zone_name(),
        "rules": {
            "self_exclusion_minimum_days": _setting(
                "protection_min_self_exclusion_days", 180
            ),
            "self_exclusion_lifts_on_its_own": False,
            "exclusion_reflection_hours": _setting(
                "protection_exclusion_reflection_hours", 72
            ),
            "cooling_off_minimum_hours": _setting(
                "protection_min_cooling_off_hours", 24
            ),
            "cooling_off_maximum_days": _setting("protection_max_cooling_off_days", 90),
            "limit_increase_delay_hours": _increase_delay_hours(),
            "session_reminder_minutes": _setting(
                "protection_session_reminder_minutes", 60
            ),
        },
    }
