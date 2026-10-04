"""Player protection for the chance mechanics — spec 8B.6.

Eight claims are held down here, and each one is the reason a clause of 8B.6
exists.

  1. **A daily loss limit stops a play at exactly the right point, in the
     player's own timezone** (8B.6.1). The boundary is asserted to the diamond —
     the stake that is allowed and the stake one larger that is not — and the
     window is asserted to the minute in `Asia/Kolkata`, with the UTC-day answer
     computed alongside it so the two are visibly different numbers rather than
     a claim.

  2. **A weekly limit does the same over the local ISO week**, and the two
     windows are independent: a player inside their daily limit is still stopped
     by their weekly one.

  3. **A limit is per player and applies across every mechanic** (8B.6.1).
     Losses on a second mechanic count towards the same limit, so moving game
     does not restore headroom.

  4. **Self-exclusion holds, and is hard to undo** (8B.6.2). It cannot be set
     for less than the minimum term, it cannot be shortened by anybody, it does
     **not** lift when the term is served, the player has to ask, the request
     cannot be decided inside the reflection period, and the decision needs a
     named person and a reason. Every one of those is attempted and refused.

  5. **A cooling-off period expires correctly** (8B.6.2) — enforced up to the
     last second and gone the moment it ends, without anybody sweeping for it.

  6. **A session reminder fires after the configured duration** (8B.6.3), from
     the round history rather than from anything the app says, once per
     interval, and again at the next one.

  7. **Each harm pattern is detected** (8B.6.4): escalating stakes after losses,
     a sustained session, and rapid repeat play — each with the case one short
     of the threshold asserted as *not* detected, so a detector that fires on
     everything cannot pass.

  8. **A flagged player is reviewed by a named person and the decision is
     recorded** (8B.6.5), and nothing else closes a flag: a machine actor is
     refused, an unnamed session is refused, a missing reason is refused, and a
     second decision on the same flag is refused.

And the rule that sits underneath all of them: **a protection that fails open is
not a protection.** With the protection store unreadable, the play does not
happen — asserted through the real `chance.play_round`, with the ledger empty
afterwards.

The real service code runs. Only Mongo underneath it is replaced, following
`tests/harness.py`.

Run:  python3 -m tests.test_player_protection
"""

from __future__ import annotations

import ast
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
DB.UNIQUE = {
    **FakeDb.UNIQUE,
    "chance_rounds": ("round_id",),
    "player_protection_flags": ("flag_id",),
}
mongo.get_db = lambda: DB  # type: ignore[assignment]


# `money.apply_movement` opens a session and a transaction. Mongo's are real;
# these do nothing. Only the blocked path is exercised through the real
# `play_round`, and a blocked play never reaches a movement at all — which is
# itself one of the things asserted.
class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def start_transaction(self):
        return _FakeTransaction()


class _FakeClient:
    async def start_session(self):
        return _FakeSession()


mongo.get_client = lambda: _FakeClient()  # type: ignore[assignment]

from app.config import settings  # noqa: E402
from app.db.mongo import C  # noqa: E402

import app.db.firebase as firebase  # noqa: E402

firebase.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]

from app.core.roles import Role, Team  # noqa: E402
from app.services import chance as X  # noqa: E402
from app.services import player_protection as P  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def truthy(label: str, value) -> None:
    global checks
    checks += 1
    if not value:
        failures.append(f"{label}\n    expected something truthy, got {value!r}")


def falsy(label: str, value) -> None:
    global checks
    checks += 1
    if value:
        failures.append(f"{label}\n    expected something falsy, got {value!r}")


def contains(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = str(haystack)
    if needle.lower() not in text.lower():
        failures.append(f"{label}\n    {needle!r} is not in: {text[:600]!r}")


def absent(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = str(haystack)
    if needle.lower() in text.lower():
        failures.append(f"{label}\n    {needle!r} should NOT be in: {text[:600]!r}")


def run(coro):
    return asyncio.run(coro)


def refuses(label: str, factory, *, error=P.ProtectionError):
    """This must be refused, not quietly given a wrong answer.

    Returns the exception, so a test can go on to assert what it *said* — which
    for 8B.6 is half the requirement: a refusal nobody can read is not a
    protection anybody is helped by.
    """
    global checks
    checks += 1
    try:
        result = factory()
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
    except error as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return None
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return None


def allows(label: str, factory):
    global checks
    checks += 1
    try:
        result = factory()
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
        return result
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: was refused — {type(exc).__name__}({exc})")
        return None


# ── The people, and the moment everything is measured from ────────────────────

APP_ADMIN = {"uid": "u-app-1", "name": "Rhea (App admin)", "role": Role.APP_ADMIN, "team": Team.APP}
SUPPORT = {"uid": "u-sup-1", "name": "Meera (Support admin)", "role": Role.SUPPORT_ADMIN, "team": Team.SUPPORT}
MACHINE = {"uid": "system:some-job", "name": "A scheduled job", "role": "system", "team": None}
UNNAMED = {"uid": "u-ghost", "name": "", "role": Role.APP_ADMIN, "team": Team.APP}

PLAYER = "player-arjun-001"


def utc(y, m, d, hh=0, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


#: A Monday, so the ISO week boundary is a fact rather than an assumption.
MONDAY = utc(2026, 8, 24)
check("the reference date really is a Monday", MONDAY.strftime("%A"), "Monday")
check("the business timezone under test", settings.report_timezone, "Asia/Kolkata")


def seed_rounds(rows, player=PLAYER) -> None:
    """Write rounds straight into `chance_rounds`, the way a play would have."""
    docs = []
    for i, row in enumerate(rows):
        played = row["at"]
        docs.append(
            {
                "round_id": f"r-{player}-{len(DB[C.CHANCE_ROUNDS].docs) + i:05d}",
                "player_uid": player,
                "mechanic_id": row.get("mechanic", "lucky_gift_tier_1"),
                "country": "IN",
                "status": row.get("status", "settled"),
                "played_at": played,
                "settled_at": played,
                "unit_stake": int(row["stake"]),
                "quantity": 1,
                "total_stake": int(row["stake"]),
                "payout": int(row.get("payout", 0)),
                "config_version": 1,
            }
        )
    DB.seed(C.CHANCE_ROUNDS, docs)


def wipe(*collections) -> None:
    for name in collections:
        DB[name].docs = []


# ══════════════════════════════════════════════════════════════════════════════
# 1. THE WINDOW — the player's day, not a UTC day
# ══════════════════════════════════════════════════════════════════════════════
#
# Asia/Kolkata is UTC+05:30, so a local day starts at 18:30 UTC the evening
# before. Every figure below is that arithmetic and nothing else.

since, until, label = P.day_window(utc(2026, 8, 24, 18, 0))
check("the local day starts at 18:30 UTC the evening before", since, utc(2026, 8, 23, 18, 30))
check("...and ends at 18:30 UTC on the day itself", until, utc(2026, 8, 24, 18, 30))
check("...and is labelled with the date the player would name", label, "2026-08-24")

# One minute later in UTC is the *next* local day. This is the whole bug.
since2, _u2, label2 = P.day_window(utc(2026, 8, 24, 18, 31))
check("18:31 UTC is already the next local day", label2, "2026-08-25")
check("...and its window starts at 18:30 UTC", since2, utc(2026, 8, 24, 18, 30))
truthy(
    "the two windows do not overlap, so nothing is double-counted",
    until <= since2,
)

wsince, wuntil, wlabel = P.week_window(utc(2026, 8, 26, 12, 0))  # a Wednesday
check("the local week starts on Monday 00:00 local", wsince, utc(2026, 8, 23, 18, 30))
check("...and runs seven days", wuntil - wsince, timedelta(days=7))
check("...labelled by its Monday", wlabel, "week of 2026-08-24")

# The Sunday-night edge: 23:00 IST on Sunday is still last week, and 00:30 IST
# on Monday is this week — five and a half hours apart in local time, and on
# opposite sides of a UTC day.
_s, _u, sunday_label = P.week_window(utc(2026, 8, 23, 17, 30))   # 23:00 IST Sun
_s2, _u2, monday_label = P.week_window(utc(2026, 8, 23, 19, 0))  # 00:30 IST Mon
check("Sunday 23:00 local is the previous week", sunday_label, "week of 2026-08-17")
check("Monday 00:30 local is the new week", monday_label, "week of 2026-08-24")


# ══════════════════════════════════════════════════════════════════════════════
# 2. 8B.6.1 — A DAILY LOSS LIMIT, AT EXACTLY THE RIGHT POINT
# ══════════════════════════════════════════════════════════════════════════════
#
# The player sets 1,000 diamonds. They are 900 down on their local day. The
# stake that takes them exactly to the limit is allowed; the stake one diamond
# larger is not. Nothing about that sentence involves a float.

wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION, C.AUDIT, C.PLAYER_PROTECTION_FLAGS)

# 22:30 IST on Monday the 24th — comfortably inside the local day, and inside
# the *previous* UTC day too, which is what makes the next assertion bite.
run(P.set_player_limits(player_uid=PLAYER, daily=1_000, now=utc(2026, 8, 24, 10, 0)))
seed_rounds([{"at": utc(2026, 8, 24, 17, 0), "stake": 1_000, "payout": 100}])

EVENING = utc(2026, 8, 24, 18, 0)  # 23:30 IST on the 24th

state = run(P.player_status(PLAYER, now=EVENING))
check("staked so far today", state["daily"]["staked"], 1_000)
check("returned so far today", state["daily"]["returned"], 100)
check("net loss is staked minus returned", state["daily"]["net_loss"], 900)
check("the limit in force", state["daily"]["limit"], 1_000)
check("...set by the player", state["daily"]["limit_source"], "player")
check("headroom is the limit less the loss", state["daily"]["headroom"], 100)
check("the day resets at 18:30 UTC", state["daily"]["resets_at"], utc(2026, 8, 24, 18, 30))

allows(
    "a stake of exactly the headroom is allowed",
    lambda: P.gate_play(player_uid=PLAYER, mechanic_id="lucky_gift_tier_1",
                        total_stake=100, now=EVENING),
)
blocked = refuses(
    "one diamond more than the headroom is not",
    lambda: P.gate_play(player_uid=PLAYER, mechanic_id="lucky_gift_tier_1",
                        total_stake=101, now=EVENING),
    error=P.ProtectionBlocked,
)
check("...and the refusal names the daily limit", blocked.kind, "daily_loss_limit")
check("...with the headroom on it", blocked.detail["headroom"], 100)
check("...and the stake that was attempted", blocked.detail["attempted_stake"], 101)
check("...and the loss it was measured against", blocked.detail["net_loss"], 900)
check("...and the moment it lifts", blocked.lifts_at, utc(2026, 8, 24, 18, 30))

# 8B.6 is a protection, so the words are part of the requirement.
contains("the message says nothing was staked", blocked.message, "nothing was staked")
contains("the message says the balance is unchanged", blocked.message, "balance is unchanged")
contains("the message says when it resets", blocked.message, "resets at")
contains("the message names the local zone", blocked.message, "Asia/Kolkata")
for word in ("error", "invalid", "failed", "denied", "forbidden", "violation"):
    absent(f"the message does not say {word!r}", blocked.message, word)
truthy("the response says the balance is unchanged in a field", blocked.as_dict()["balance_unchanged"])

# And the point of the whole exercise: half an hour later in UTC it is a new
# day *for this player*, and the limit is clear. A UTC-cut window would still be
# counting the same round, and the two numbers are computed side by side here so
# the difference is a figure rather than an argument.
MIDNIGHT_IST = utc(2026, 8, 24, 18, 31)  # 00:01 IST on the 25th
fresh = run(P.player_status(PLAYER, now=MIDNIGHT_IST))
check("the local day has rolled and the loss is behind them", fresh["daily"]["net_loss"], 0)
check("...so the full limit is available again", fresh["daily"]["headroom"], 1_000)
allows(
    "...and a stake of the whole limit is allowed",
    lambda: P.gate_play(player_uid=PLAYER, total_stake=1_000, now=MIDNIGHT_IST),
)

utc_day_start = MIDNIGHT_IST.replace(hour=0, minute=0)
utc_day_loss = run(P.loss_in_window(PLAYER, utc_day_start, utc_day_start + timedelta(days=1)))
check(
    "a UTC-cut day would still be counting yesterday evening's loss",
    utc_day_loss["net_loss"],
    900,
)
truthy(
    "so the UTC answer and the local answer are genuinely different",
    utc_day_loss["net_loss"] != fresh["daily"]["net_loss"],
)


# ── A player who is ahead does not earn extra permission to lose ──────────────

wipe(C.CHANCE_ROUNDS)
seed_rounds([{"at": utc(2026, 8, 24, 17, 0), "stake": 100, "payout": 600}])
ahead = run(P.player_status(PLAYER, now=EVENING))
check("a winning day is a negative loss", ahead["daily"]["net_loss"], -500)
check("...and headroom is still just the limit, not limit plus winnings",
      ahead["daily"]["headroom"], 1_000)
refuses(
    "...so a stake past the limit is still refused",
    lambda: P.gate_play(player_uid=PLAYER, total_stake=1_001, now=EVENING),
    error=P.ProtectionBlocked,
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. 8B.6.1 — A WEEKLY LIMIT, AND WHY IT IS A SECOND WINDOW
# ══════════════════════════════════════════════════════════════════════════════
#
# Four quiet days each inside the daily limit add up to a week that is not.

wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION)
run(P.set_player_limits(player_uid=PLAYER, daily=1_000, weekly=3_000,
                        now=utc(2026, 8, 24, 1, 0)))

# Monday, Tuesday and Wednesday: 900 lost each, every one inside the daily
# limit. All three are in the local week that begins Monday the 24th.
seed_rounds(
    [
        {"at": utc(2026, 8, 24, 17, 0), "stake": 1_000, "payout": 100},
        {"at": utc(2026, 8, 25, 17, 0), "stake": 1_000, "payout": 100},
        {"at": utc(2026, 8, 26, 17, 0), "stake": 1_000, "payout": 100},
    ]
)

THURSDAY = utc(2026, 8, 27, 10, 0)  # 15:30 IST Thursday — a fresh local day
week = run(P.player_status(PLAYER, now=THURSDAY))
check("today's loss is nil", week["daily"]["net_loss"], 0)
check("today's headroom is the whole daily limit", week["daily"]["headroom"], 1_000)
check("the week's loss is the three days added up", week["weekly"]["net_loss"], 2_700)
check("the week's headroom is what is left of 3,000", week["weekly"]["headroom"], 300)

allows(
    "a stake inside both windows is allowed",
    lambda: P.gate_play(player_uid=PLAYER, total_stake=300, now=THURSDAY),
)
weekly_block = refuses(
    "a stake inside the daily limit but past the weekly one is refused",
    lambda: P.gate_play(player_uid=PLAYER, total_stake=301, now=THURSDAY),
    error=P.ProtectionBlocked,
)
check("...and it is the weekly limit that says so", weekly_block.kind, "weekly_loss_limit")
check("...resetting next Monday 00:00 local", weekly_block.lifts_at, utc(2026, 8, 30, 18, 30))
contains("...and saying so plainly", weekly_block.message, "week resets at")


# ══════════════════════════════════════════════════════════════════════════════
# 4. THE SCOPE OF A LIMIT — the account, not one mechanic
# ══════════════════════════════════════════════════════════════════════════════
#
# A per-mechanic limit is evaded in one tap by moving to the next game. This
# asserts that moving game restores nothing.

wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION)
run(P.set_player_limits(player_uid=PLAYER, daily=1_000, now=utc(2026, 8, 24, 1, 0)))
seed_rounds(
    [
        {"at": utc(2026, 8, 24, 16, 0), "stake": 500, "payout": 0,
         "mechanic": "lucky_gift_tier_1"},
        {"at": utc(2026, 8, 24, 17, 0), "stake": 400, "payout": 0,
         "mechanic": "aviator"},
    ]
)
scope = run(P.player_status(PLAYER, now=EVENING))
check("losses on two mechanics are one number", scope["daily"]["net_loss"], 900)
check("...so the headroom is the account's, not the game's", scope["daily"]["headroom"], 100)
moved = refuses(
    "moving to a third mechanic does not restore headroom",
    lambda: P.gate_play(player_uid=PLAYER, mechanic_id="a_brand_new_game",
                        total_stake=200, now=EVENING),
    error=P.ProtectionBlocked,
)
check("...and it is still the same daily limit", moved.kind, "daily_loss_limit")
contains("the record says the scope out loud", scope["limits_apply_to"], "not one at a time")

# An externally settled round (8B.1.4) is a loss like any other.
seed_rounds([{"at": utc(2026, 8, 24, 17, 30), "stake": 100, "payout": 0,
              "mechanic": "third_party_game"}])
check(
    "a third party's round counts towards the same limit",
    run(P.player_status(PLAYER, now=EVENING))["daily"]["net_loss"],
    1_000,
)

# A void round staked nothing, so it must count for nothing.
seed_rounds([{"at": utc(2026, 8, 24, 17, 45), "stake": 5_000, "payout": 0,
              "status": "void"}])
check(
    "a void round is not a loss — nothing was ever debited",
    run(P.player_status(PLAYER, now=EVENING))["daily"]["net_loss"],
    1_000,
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. A LIMIT A PLAYER CAN RAISE IN THE SAME MINUTE IS NOT A LIMIT
# ══════════════════════════════════════════════════════════════════════════════

wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION)
run(P.set_player_limits(player_uid=PLAYER, daily=1_000, now=utc(2026, 8, 24, 1, 0)))
seed_rounds([{"at": utc(2026, 8, 24, 17, 0), "stake": 1_000, "payout": 0}])

# Down to the limit, and they try to raise it on the spot.
raised = run(P.set_player_limits(player_uid=PLAYER, daily=50_000, now=EVENING))
check("the raise does not apply now", raised["daily"]["limit"], 1_000)
check("...it is scheduled", len(raised["takes_effect_later"]), 1)
check(
    "...for twenty-four hours later",
    raised["takes_effect_later"][0]["effective_from"],
    EVENING + timedelta(hours=settings.protection_limit_increase_delay_hours),
)
refuses(
    "and the old limit is enforced in the meantime",
    lambda: P.gate_play(player_uid=PLAYER, total_stake=10, now=EVENING),
    error=P.ProtectionBlocked,
)

# A day later it is in force — and by then the session that prompted it is over.
later = EVENING + timedelta(hours=settings.protection_limit_increase_delay_hours, minutes=1)
check(
    "a day later the raise has taken effect",
    run(P.player_status(PLAYER, now=later))["daily"]["limit"],
    50_000,
)

# A reduction is the other way round entirely — immediate, always.
cut = run(P.set_player_limits(player_uid=PLAYER, daily=200, now=later))
check("a reduction applies at once", cut["daily"]["limit"], 200)
check("...and is not scheduled", cut["takes_effect_later"], [])

# Staff limits sit in the same comparison, so a player cannot outbid one.
run(P.set_staff_limits(player_uid=PLAYER, daily=50, reason="Reviewed after a flag",
                       actor=SUPPORT, now=later))
run(P.set_player_limits(player_uid=PLAYER, daily=100_000, now=later))
after_staff = run(P.player_status(PLAYER, now=later))
check("the lowest limit anybody set is the one enforced", after_staff["daily"]["limit"], 50)
check("...and it is the staff one", after_staff["daily"]["limit_source"], "staff")


# ══════════════════════════════════════════════════════════════════════════════
# 6. 8B.6.2 — SELF-EXCLUSION HOLDS, AND IS HARD TO UNDO
# ══════════════════════════════════════════════════════════════════════════════

EXCLUDER = "player-nikhil-002"
wipe(C.PLAYER_PROTECTION, C.AUDIT)

MINIMUM = settings.protection_min_self_exclusion_days
check("the shipped minimum term is six months", MINIMUM, 180)

short = refuses(
    "a self-exclusion shorter than the minimum term is refused",
    lambda: P.self_exclude(player_uid=EXCLUDER, days=1, now=MONDAY),
)
contains("...and it points at the tool that fits", str(short), "cooling-off")

run(P.self_exclude(player_uid=EXCLUDER, days=MINIMUM, now=MONDAY))
TERM_ENDS = MONDAY + timedelta(days=MINIMUM)

held = refuses(
    "an excluded player cannot play",
    lambda: P.gate_play(player_uid=EXCLUDER, total_stake=1, now=MONDAY + timedelta(minutes=1)),
    error=P.ProtectionBlocked,
)
check("...and the refusal names the exclusion", held.kind, "self_excluded")
check(
    "...and does NOT promise a moment it lifts, because nothing lifts it",
    held.lifts_at,
    None,
)
contains("...but it does say when the term ends", held.as_dict()["detail"]["minimum_term_ends_at_local"], "2027")

# It also holds the door shut a step earlier: no commitment is even issued.
refuses(
    "an excluded player is not even handed a round to play",
    lambda: P.gate_commit(player_uid=EXCLUDER, now=MONDAY + timedelta(minutes=1)),
    error=P.ProtectionBlocked,
)

# Thirty seconds later, which is the case the spec calls out by name.
refuses(
    "thirty seconds later it is still on",
    lambda: P.gate_play(player_uid=EXCLUDER, total_stake=1,
                        now=MONDAY + timedelta(seconds=30)),
    error=P.ProtectionBlocked,
)

# Nothing shortens it — not the player, not staff.
inside = refuses(
    "the player cannot ask for it to be lifted inside the term",
    lambda: P.request_exclusion_lift(player_uid=EXCLUDER, now=TERM_ENDS - timedelta(days=1)),
)
contains("...and is told nobody can shorten it", str(inside), "cannot be shortened by anybody")
refuses(
    "staff cannot lift it inside the term either — there is nothing to decide",
    lambda: P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True,
        reason="The player called and asked us nicely", actor=SUPPORT,
        now=TERM_ENDS - timedelta(days=1),
    ),
)
# Asking again does not replace the term that is running, and there is no way
# to ask for a shorter one at all: anything under the minimum is refused above,
# and anything over it only ever moves the end date later.
again = run(P.self_exclude(player_uid=EXCLUDER, days=MINIMUM, now=MONDAY))
truthy("re-excluding for the same term changes nothing", again["already_excluded"])
check(
    "...and the original term still stands",
    run(P.player_status(EXCLUDER, now=MONDAY + timedelta(days=30)))
    ["self_exclusion"]["minimum_until"],
    TERM_ENDS,
)
refuses(
    "there is no shorter term to ask for — the floor is the floor",
    lambda: P.self_exclude(player_uid=EXCLUDER, days=MINIMUM - 1,
                           now=MONDAY + timedelta(days=30)),
)

# The term is served. It still does not lift.
SERVED = TERM_ENDS + timedelta(minutes=1)
served = run(P.player_status(EXCLUDER, now=SERVED))
check("the served term is marked served", served["self_exclusion"]["status"], "expired")
falsy("...and the player still cannot play", served["can_play"])
still = refuses(
    "a served term does NOT reopen the account on its own",
    lambda: P.gate_play(player_uid=EXCLUDER, total_stake=1, now=SERVED),
    error=P.ProtectionBlocked,
)
check("...it is still the exclusion refusing", still.kind, "self_excluded")

# Three deliberate acts by two parties, with a gap in the middle.
asked = run(P.request_exclusion_lift(player_uid=EXCLUDER, now=SERVED))
truthy("the player may now ask", asked["requested"])
check(
    "...and the reflection period is the configured one",
    asked["earliest_decision_at"],
    SERVED + timedelta(hours=settings.protection_exclusion_reflection_hours),
)
refuses(
    "asking does not reopen anything",
    lambda: P.gate_play(player_uid=EXCLUDER, total_stake=1, now=SERVED + timedelta(minutes=1)),
    error=P.ProtectionBlocked,
)
early = refuses(
    "and nobody may decide before the reflection period is over",
    lambda: P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True, reason="They have been fine for months",
        actor=SUPPORT, now=SERVED + timedelta(hours=1),
    ),
)
contains("...because the wait is the control", str(early), "the wait is the control")

DECIDABLE = SERVED + timedelta(hours=settings.protection_exclusion_reflection_hours, minutes=1)
refuses(
    "a machine may not decide it",
    lambda: P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True, reason="Automatic annual review",
        actor=MACHINE, now=DECIDABLE,
    ),
)
refuses(
    "nor may a session with no name on it",
    lambda: P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True, reason="Looks fine to me now",
        actor=UNNAMED, now=DECIDABLE,
    ),
)
refuses(
    "nor may anybody without a reason",
    lambda: P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True, reason="ok", actor=SUPPORT, now=DECIDABLE,
    ),
)

# Refusing to lift is a decision too, and it is recorded like one.
refused_lift = run(
    P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=False,
        reason="Spoke to them; they asked us to keep it on for now.",
        actor=SUPPORT, now=DECIDABLE,
    )
)
falsy("a refusal to lift leaves it closed", refused_lift["approved"])
check("...against a named person", refused_lift["decided_by"]["name"], SUPPORT["name"])
refuses(
    "...and the player still cannot play",
    lambda: P.gate_play(player_uid=EXCLUDER, total_stake=1, now=DECIDABLE),
    error=P.ProtectionBlocked,
)

# And finally, properly, by a named person with a reason.
asked_again = run(P.request_exclusion_lift(player_uid=EXCLUDER, now=DECIDABLE))
truthy("the player may ask again after a refusal", asked_again["requested"])
FINAL = DECIDABLE + timedelta(hours=settings.protection_exclusion_reflection_hours, minutes=1)
lifted = run(
    P.decide_exclusion_lift(
        player_uid=EXCLUDER, approve=True,
        reason="Second conversation; they are clear and the term is long served.",
        actor=SUPPORT, now=FINAL,
    )
)
truthy("only then is it lifted", lifted["approved"])
truthy("...and only then can they play", run(P.player_status(EXCLUDER, now=FINAL))["can_play"])

lift_entries = [
    d for d in DB[C.AUDIT].docs if d["action"] == P.Act.LIFT_DECIDED
]
check("both decisions are in the audit log", len(lift_entries), 2)
for entry in lift_entries:
    truthy("...each against a named person", entry["actor"]["name"])
    truthy("...each with a reason", len(entry["reason"]) >= P.MIN_REASON)
    falsy("...and none of them written by a machine", entry["actor"]["is_system"])


# ══════════════════════════════════════════════════════════════════════════════
# 7. 8B.6.2 — A COOLING-OFF PERIOD, WHICH DOES EXPIRE
# ══════════════════════════════════════════════════════════════════════════════

COOLER = "player-priya-003"
wipe(C.PLAYER_PROTECTION)

FLOOR = settings.protection_min_cooling_off_hours
CEILING = settings.protection_max_cooling_off_days
too_short = refuses(
    "a cooling-off shorter than the floor is not a break",
    lambda: P.start_cooling_off(player_uid=COOLER, hours=1, now=MONDAY),
)
contains("...and says so", str(too_short), f"at least {FLOOR} hours")
too_long = refuses(
    "a cooling-off longer than the ceiling is a self-exclusion in disguise",
    lambda: P.start_cooling_off(player_uid=COOLER, hours=CEILING * 24 + 1, now=MONDAY),
)
contains("...and points at the honest tool", str(too_long), "self-exclusion")

started = run(P.start_cooling_off(player_uid=COOLER, hours=48, now=MONDAY))
ENDS = MONDAY + timedelta(hours=48)
check("it runs for exactly what was asked", started["until"], ENDS)
contains("...and says when it ends, in the player's own zone", started["message"], "Asia/Kolkata")
contains("...and that nothing was taken", started["message"], "balance is untouched")

cooling = refuses(
    "it holds while it runs",
    lambda: P.gate_play(player_uid=COOLER, total_stake=1, now=MONDAY + timedelta(hours=24)),
    error=P.ProtectionBlocked,
)
check("...and names itself", cooling.kind, "cooling_off")
check("...and promises the moment it lifts, because this one does", cooling.lifts_at, ENDS)
contains("...saying it opens up by itself", cooling.message, "by itself")

refuses(
    "it holds to the last second",
    lambda: P.gate_play(player_uid=COOLER, total_stake=1, now=ENDS - timedelta(seconds=1)),
    error=P.ProtectionBlocked,
)
allows(
    "and it is gone the moment it ends, with nobody sweeping for it",
    lambda: P.gate_play(player_uid=COOLER, total_stake=1, now=ENDS),
)
check(
    "...and the stored record is cleared, not just ignored by the gate",
    run(P.player_status(COOLER, now=ENDS))["cooling_off"],
    None,
)

# It cannot be cancelled early — only extended.
run(P.start_cooling_off(player_uid=COOLER, hours=72, now=ENDS))
shortened = run(P.start_cooling_off(player_uid=COOLER, hours=24, now=ENDS + timedelta(hours=1)))
falsy("a shorter cooling-off does not cut a longer one short", shortened["started"])
check("...the longer one still runs", shortened["until"], ENDS + timedelta(hours=72))


# ══════════════════════════════════════════════════════════════════════════════
# 8. 8B.6.3 — A SESSION REMINDER, DERIVED FROM THE ROUNDS
# ══════════════════════════════════════════════════════════════════════════════
#
# The session comes out of `chance_rounds`, not out of anything the app says
# about itself. A client that stops reporting is a player who never gets a
# reminder; a derived session survives a reinstall, a second device and a
# background kill.

PLAYER_S = "player-sana-004"
wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION, C.AUDIT)

EVERY = settings.protection_session_reminder_minutes
GAP = settings.protection_session_gap_minutes
check("the shipped reminder interval", EVERY, 60)
check("the shipped session gap", GAP, 30)

T0 = utc(2026, 8, 24, 6, 0)
seed_rounds(
    [
        {"at": T0, "stake": 10, "payout": 0},
        {"at": T0 + timedelta(minutes=25), "stake": 10, "payout": 0},
        {"at": T0 + timedelta(minutes=50), "stake": 10, "payout": 0},
    ],
    player=PLAYER_S,
)

at59 = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=59)))
truthy("three rounds 25 minutes apart are one session", at59["active"])
check("...beginning at the first of them", at59["started_at"], T0)
check("...and 59 minutes long", at59["minutes"], 59)
check("no reminder one minute early", at59["reminder_due"], None)

at60 = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=60)))
truthy("the reminder fires at exactly the configured duration", at60["reminder_due"])
check("...at the right milestone", at60["reminder_due"]["milestone_minutes"], 60)
contains("...and says nothing is wrong", at60["reminder_due"]["message"], "nothing wrong")
contains("...just the time", at60["reminder_due"]["message"], "60 minutes")

at61 = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=61)))
check("it does not fire again a minute later", at61["reminder_due"], None)
check("...and the count of what was sent is kept", at61["reminders_sent"], 1)
check("...with the next one an interval away", at61["next_reminder_at"], T0 + timedelta(minutes=120))

# Keep the session alive to the second milestone.
seed_rounds(
    [
        {"at": T0 + timedelta(minutes=75), "stake": 10, "payout": 0},
        {"at": T0 + timedelta(minutes=100), "stake": 10, "payout": 0},
    ],
    player=PLAYER_S,
)
at120 = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=120)))
truthy("the second reminder fires at the second interval", at120["reminder_due"])
check("...naming the two-hour milestone", at120["reminder_due"]["milestone_minutes"], 120)
check("...and it is the second one", at120["reminders_sent"], 2)

reminders = [d for d in DB[C.AUDIT].docs if d["action"] == P.Act.SESSION_REMINDER]
check("both reminders are recorded server-side, not merely returned", len(reminders), 2)
truthy("...by the protection system itself", reminders[0]["actor"]["is_system"])

# A gap longer than the rule ends the session, and the counter starts again.
gone = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=100 + GAP + 1)))
falsy("a gap past the rule ends the session", gone["active"])
check("...and there is nothing to remind about", gone["minutes"], 0)

seed_rounds([{"at": T0 + timedelta(minutes=200), "stake": 10, "payout": 0}],
            player=PLAYER_S)
restarted = run(P.session_state(PLAYER_S, now=T0 + timedelta(minutes=205)))
check("a new session starts at its own first round", restarted["started_at"],
      T0 + timedelta(minutes=200))
check("...with the reminder count reset", restarted["reminders_sent"], 0)


# ══════════════════════════════════════════════════════════════════════════════
# 9. 8B.6.4 — EACH HARM PATTERN, AND EACH ONE'S NEAR MISS
# ══════════════════════════════════════════════════════════════════════════════
#
# `detect_patterns` is pure, so each pattern is exercised directly on rounds
# built by hand. Every one is asserted twice: the case that trips it, and the
# case one short of the threshold that must not.

NEED = settings.protection_harm_escalation_rounds
MULTIPLE = settings.protection_harm_escalation_multiple
SUSTAINED = settings.protection_harm_session_minutes
RAPID_N = settings.protection_harm_rapid_rounds
RAPID_MINS = settings.protection_harm_rapid_window_minutes
check("the shipped escalation thresholds", (NEED, MULTIPLE), (5, 3))
check("the shipped sustained-session threshold, in minutes", SUSTAINED, 180)
check("the shipped rapid-play thresholds", (RAPID_N, RAPID_MINS), (20, 10))

NOW = utc(2026, 8, 24, 12, 0)
IDLE = {"active": False, "minutes": 0, "rounds": 0, "started_at": None}


def rounds_at(specs) -> list[dict]:
    return [
        {"played_at": at, "total_stake": stake, "payout": payout}
        for at, stake, payout in specs
    ]


def patterns(rounds, session=IDLE, pending=0):
    return {
        f["pattern"]: f
        for f in P.detect_patterns(rounds, session, pending_stake=pending, now=NOW)
    }


# ── 1. Escalating stakes after losses ─────────────────────────────────────────

chase = rounds_at(
    [(NOW - timedelta(minutes=50 - i * 10), stake, 0)
     for i, stake in enumerate([10, 20, 30, 40, 50])]
)
found = patterns(chase)
truthy("five losing rounds with the stake rising to 5× is flagged", P.Pattern.ESCALATING_STAKES in found)
escalation = found[str(P.Pattern.ESCALATING_STAKES)]
check("...counting the run", escalation["evidence"]["consecutive_losing_rounds"], 5)
check("...from the stake it started at", escalation["evidence"]["first_stake"], 10)
check("...to the one it reached", escalation["evidence"]["last_stake"], 50)

four = patterns(chase[1:])
falsy("four of them is not, because the threshold is five", P.Pattern.ESCALATING_STAKES in four)

flat = rounds_at(
    [(NOW - timedelta(minutes=50 - i * 10), 10, 0) for i in range(6)]
)
falsy("six losses at a flat stake is not a chase", P.Pattern.ESCALATING_STAKES in patterns(flat))

# A win in the middle breaks the run, which is the whole point of "after losses".
with_a_win = rounds_at(
    [
        (NOW - timedelta(minutes=50), 10, 0),
        (NOW - timedelta(minutes=40), 20, 0),
        (NOW - timedelta(minutes=30), 30, 900),   # a win
        (NOW - timedelta(minutes=20), 40, 0),
        (NOW - timedelta(minutes=10), 50, 0),
    ]
)
falsy(
    "rising stakes after a win are not a chase",
    P.Pattern.ESCALATING_STAKES in patterns(with_a_win),
)

# The round being attempted right now completes the run, so it is caught on the
# play that completes it rather than one play late.
truthy(
    "the stake being attempted now counts towards the run",
    P.Pattern.ESCALATING_STAKES in patterns(chase[1:], pending=60),
)

# ── 2. A sustained session ────────────────────────────────────────────────────

long_session = {"active": True, "minutes": SUSTAINED, "rounds": 40,
                "started_at": NOW - timedelta(minutes=SUSTAINED)}
truthy(
    "three hours of continuous play is flagged",
    P.Pattern.SUSTAINED_SESSION in patterns([], long_session),
)
check(
    "...with the duration on the evidence",
    patterns([], long_session)[str(P.Pattern.SUSTAINED_SESSION)]["evidence"]["session_minutes"],
    SUSTAINED,
)
falsy(
    "one minute short of it is not",
    P.Pattern.SUSTAINED_SESSION
    in patterns([], {**long_session, "minutes": SUSTAINED - 1}),
)
falsy(
    "and a long-finished session is not, because it is not running",
    P.Pattern.SUSTAINED_SESSION
    in patterns([], {**long_session, "active": False}),
)

# ── 3. Rapid repeat play ──────────────────────────────────────────────────────

burst = rounds_at(
    [(NOW - timedelta(seconds=30 * i), 10, 0) for i in range(RAPID_N)]
)
truthy("twenty rounds inside ten minutes is flagged", P.Pattern.RAPID_REPEAT in patterns(burst))
check(
    "...counting the rounds in the window",
    patterns(burst)[str(P.Pattern.RAPID_REPEAT)]["evidence"]["rounds_in_window"],
    RAPID_N,
)
falsy(
    "nineteen of them is not",
    P.Pattern.RAPID_REPEAT in patterns(burst[:-1]),
)
spread = rounds_at(
    [(NOW - timedelta(minutes=3 * i), 10, 0) for i in range(RAPID_N + 5)]
)
falsy(
    "the same number of rounds spread over an hour is not rapid play",
    P.Pattern.RAPID_REPEAT in patterns(spread),
)


# ── The flags reach the queue, and nothing empties it ─────────────────────────

CHASER = "player-vikram-005"
wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION, C.PLAYER_PROTECTION_FLAGS, C.AUDIT)

seed_rounds(
    [
        {"at": NOW - timedelta(minutes=50 - i * 10), "stake": stake, "payout": 0}
        for i, stake in enumerate([10, 20, 30, 40])
    ],
    player=CHASER,
)
gate = allows(
    "the play itself is allowed — a flag stops nothing",
    lambda: P.gate_play(player_uid=CHASER, mechanic_id="lucky_gift_tier_1",
                        total_stake=50, now=NOW),
)
check("...and it raised one flag", len(gate["flags_raised"]), 1)

queue = run(P.list_flags(status="open"))
check("the flag is on the review queue", len(queue), 1)
check("...naming the pattern", queue[0]["pattern"], str(P.Pattern.ESCALATING_STAKES))
check("...and the player", queue[0]["player_uid"], CHASER)
check("...unreviewed", queue[0]["review"], None)
contains("...saying explicitly that it is not a conclusion", queue[0]["note"], "never a conclusion")

# A second detection of the same pattern updates the card rather than filling
# the queue with copies of it.
seed_rounds([{"at": NOW - timedelta(minutes=5), "stake": 50, "payout": 0}], player=CHASER)
run(P.gate_play(player_uid=CHASER, total_stake=60, now=NOW + timedelta(minutes=1)))
check("a second detection does not raise a second card", len(run(P.list_flags(status="open"))), 1)
check("...it is seen again on the same one", run(P.list_flags(status="open"))[0]["seen"], 2)

raised_entries = [d for d in DB[C.AUDIT].docs if d["action"] == P.Act.FLAG_RAISED]
check("one flag, one audit entry", len(raised_entries), 1)
truthy("...written by the detector, not a person", raised_entries[0]["actor"]["is_system"])


# ══════════════════════════════════════════════════════════════════════════════
# 10. 8B.6.5 — A NAMED PERSON REVIEWS IT, AND THE DECISION IS RECORDED
# ══════════════════════════════════════════════════════════════════════════════

flag_id = run(P.list_flags(status="open"))[0]["flag_id"]

refuses(
    "a machine cannot review a flag",
    lambda: P.review_flag(flag_id=flag_id, decision="no_action",
                          reason="Automatic nightly triage pass", actor=MACHINE),
)
refuses(
    "a session with no name cannot review one either",
    lambda: P.review_flag(flag_id=flag_id, decision="no_action",
                          reason="Had a look, seems ordinary", actor=UNNAMED),
)
refuses(
    "a review with no real reason is refused",
    lambda: P.review_flag(flag_id=flag_id, decision="no_action", reason="fine",
                          actor=SUPPORT),
)
refuses(
    "a decision outside the vocabulary is refused",
    lambda: P.review_flag(flag_id=flag_id, decision="looked_at_it",
                          reason="Checked the history and it is fine", actor=SUPPORT),
)
refuses(
    "'limit imposed' has to name the limit it imposes",
    lambda: P.review_flag(flag_id=flag_id, decision="limit_imposed",
                          reason="Stake pattern warrants a cap", actor=SUPPORT),
)
check("none of those closed it", run(P.list_flags(status="open"))[0]["status"], "open")

REVIEWED_AT = NOW + timedelta(hours=2)
decided = run(
    P.review_flag(
        flag_id=flag_id,
        decision="limit_imposed",
        reason="Stakes doubled across five losing rounds; capped at 500 a day and messaged.",
        actor=SUPPORT,
        daily_limit=500,
        now=REVIEWED_AT,
    )
)
check("the flag is now reviewed", decided["status"], "reviewed")
check("...by a named person", decided["review"]["by"]["name"], "Meera (Support admin)")
check("...whose uid is recorded", decided["review"]["by"]["uid"], "u-sup-1")
check("...with the decision", decided["review"]["decision"], "limit_imposed")
check("...and the reason kept in full", decided["review"]["reason"][:14], "Stakes doubled")
check("...at a recorded moment", decided["review"]["at"], REVIEWED_AT)
check("...and the consequence applied as part of it",
      decided["review"]["applied"]["daily_limit"], 500)

check("the queue is now empty", run(P.list_flags(status="open")), [])
check("...and the flag is still there, reviewed", len(run(P.list_flags(status="reviewed"))), 1)

imposed = run(P.player_status(CHASER, now=REVIEWED_AT))
check("the limit the reviewer imposed is in force", imposed["daily"]["limit"], 500)
check("...as a staff limit", imposed["daily"]["limit_source"], "staff")

again_exc = refuses(
    "a second decision on the same flag is refused",
    lambda: P.review_flag(flag_id=flag_id, decision="no_action",
                          reason="Actually I think this one is fine", actor=APP_ADMIN),
)
contains("...naming who decided it first", str(again_exc), "Meera")

review_entries = [d for d in DB[C.AUDIT].docs if d["action"] == P.Act.FLAG_REVIEWED]
check("the decision is in the audit log", len(review_entries), 1)
check("...against the reviewer", review_entries[0]["actor"]["uid"], "u-sup-1")
falsy("...not a machine", review_entries[0]["actor"]["is_system"])
truthy("...with the reason", len(review_entries[0]["reason"]) >= P.MIN_REASON)
check("...and the before/after of the flag", review_entries[0]["before"]["status"], "open")

# A suspension decided on a review is a real one, and it is not undone by the
# same click that made it.
seed_rounds(
    [
        {"at": NOW - timedelta(minutes=9) + timedelta(seconds=20 * i), "stake": 5, "payout": 0}
        for i in range(RAPID_N)
    ],
    player="player-rapid-006",
)
run(P.gate_play(player_uid="player-rapid-006", total_stake=5, now=NOW))
rapid_flag = [
    f for f in run(P.list_flags(status="open"))
    if f["player_uid"] == "player-rapid-006"
][0]
run(
    P.review_flag(
        flag_id=rapid_flag["flag_id"],
        decision="play_suspended",
        reason="Twenty rounds in nine minutes; pausing play while we speak to them.",
        actor=SUPPORT,
        suspend_days=7,
        now=NOW,
    )
)
suspended = refuses(
    "a suspension decided on a review stops play",
    lambda: P.gate_play(player_uid="player-rapid-006", total_stake=1,
                        now=NOW + timedelta(days=1)),
    error=P.ProtectionBlocked,
)
check("...and names itself", suspended.kind, "staff_suspension")
contains("...without blaming the player", suspended.message, "while we look into something")
allows(
    "...and it ends when it was said it would",
    lambda: P.gate_play(player_uid="player-rapid-006", total_stake=1,
                        now=NOW + timedelta(days=7, minutes=1)),
)


# ══════════════════════════════════════════════════════════════════════════════
# 11. FAIL CLOSED — an unreadable protection is a refused play
# ══════════════════════════════════════════════════════════════════════════════

FAILER = "player-unreadable-007"
wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION)


class _Unreadable:
    """A collection that cannot be read. The failure a live outage produces."""

    def __init__(self, real):
        self.real = real

    def __getattr__(self, name):
        return getattr(self.real, name)

    async def find_one(self, *_a, **_k):
        raise RuntimeError("connection to the replica set was lost")

    def find(self, *_a, **_k):
        raise RuntimeError("connection to the replica set was lost")

    def aggregate(self, *_a, **_k):
        raise RuntimeError("connection to the replica set was lost")


# The module logs an ERROR for every refused read, which is exactly what it
# should do in production and exactly what nobody wants printed above a passing
# test run. Quietened for this section only, and put back afterwards.
import logging  # noqa: E402

logging.getLogger("app.services.player_protection").setLevel(logging.CRITICAL)

real_protection = DB[C.PLAYER_PROTECTION]
DB.collections[C.PLAYER_PROTECTION] = _Unreadable(real_protection)  # type: ignore[assignment]

unavailable = refuses(
    "with the protection store unreadable the play does not happen",
    lambda: P.gate_play(player_uid=FAILER, total_stake=1, now=NOW),
    error=P.ProtectionBlocked,
)
check("...and it says why", unavailable.kind, "protection_unavailable")
truthy("...as the dedicated failure", isinstance(unavailable, P.ProtectionUnavailable))
truthy(
    "...which is a ProtectionBlocked, so nothing has to remember to catch it",
    issubclass(P.ProtectionUnavailable, P.ProtectionBlocked),
)
contains("...telling the player nothing was staked", unavailable.message, "nothing was staked")
refuses(
    "...and no round is even opened",
    lambda: P.gate_commit(player_uid=FAILER, now=NOW),
    error=P.ProtectionBlocked,
)

DB.collections[C.PLAYER_PROTECTION] = real_protection  # type: ignore[assignment]
allows(
    "with the store readable again the play is allowed",
    lambda: P.gate_play(player_uid=FAILER, total_stake=1, now=NOW),
)

# The same rule on the other read: the loss window itself.
real_rounds = DB[C.CHANCE_ROUNDS]
run(P.set_player_limits(player_uid=FAILER, daily=100, now=NOW))
DB.collections[C.CHANCE_ROUNDS] = _Unreadable(real_rounds)  # type: ignore[assignment]
losses_unreadable = refuses(
    "a loss window that cannot be totalled is a refused play, never a zero",
    lambda: P.gate_play(player_uid=FAILER, total_stake=1, now=NOW),
    error=P.ProtectionBlocked,
)
check("...and it fails closed the same way", losses_unreadable.kind, "protection_unavailable")
DB.collections[C.CHANCE_ROUNDS] = real_rounds  # type: ignore[assignment]
logging.getLogger("app.services.player_protection").setLevel(logging.NOTSET)


# ══════════════════════════════════════════════════════════════════════════════
# 12. THE WIRING — enforced inside the real play path, before the stake moves
# ══════════════════════════════════════════════════════════════════════════════
#
# Everything above tests the control. This tests that the control is actually in
# the road: a self-excluded player is refused by `chance.play_round` itself, the
# round is voided, and the ledger has nothing in it.

wipe(C.CHANCE_ROUNDS, C.PLAYER_PROTECTION, C.LEDGER, C.BALANCES,
     C.CHANCE_MECHANICS, C.CHANCE_CONFIGS)

DRAFT = {
    "outcomes": [
        {"multiplier_bp": 0, "probability_ppm": 400_000},
        {"multiplier_bp": 10_000, "probability_ppm": 500_000},
        {"multiplier_bp": 45_000, "probability_ppm": 100_000},
    ],
    "stake": {"min_stake": 10, "max_stake": 100, "step": 10},
    "quantity_tiers": [1],
    "max_single_win": 5_000,
    "enabled_countries": ["IN"],
    "multiplier_basis": "total_stake",
}
EVAL = X.evaluate_draft(DRAFT)
check("the fixture table is not blocked, so the play path is genuinely reachable",
      EVAL["blocked"], False)

DB.seed(
    C.CHANCE_MECHANICS,
    [{"_id": "lucky_gift_tier_1", "kind": "lucky_gift", "name": "Lucky gift tier 1",
      "live_version": 1}],
)
DB.seed(
    C.CHANCE_CONFIGS,
    [{"mechanic_id": "lucky_gift_tier_1", "version": 1, "status": "live",
      "evaluation": EVAL, "effective_from": MONDAY, "card_id": None,
      "signed_by": {"uid": "u-own-1", "name": "Owner One"}}],
)

EDGE_ACTOR = {
    "uid": "system:chance:app_tier",
    "name": "app_tier (signed caller)",
    "role": "system",
    "team": None,
    "caller": "app_tier",
}

opened = allows(
    "an ordinary player is handed a round",
    lambda: X.commit_round(mechanic_id="lucky_gift_tier_1", player_uid=PLAYER,
                           country="IN", actor=EDGE_ACTOR),
)

# Now they exclude themselves, between the commitment and the play.
run(P.self_exclude(player_uid=PLAYER, days=MINIMUM, now=MONDAY))

refuses(
    "no further round is opened for them",
    lambda: X.commit_round(mechanic_id="lucky_gift_tier_1", player_uid=PLAYER,
                           country="IN", actor=EDGE_ACTOR),
    error=P.ProtectionBlocked,
)
in_flight = refuses(
    "and the round already in flight is refused by play_round itself",
    lambda: X.play_round(round_id=opened["round_id"], unit_stake=10, quantity=1,
                         client_entropy="x", actor=EDGE_ACTOR),
    error=P.ProtectionBlocked,
)
check("...by the exclusion", in_flight.kind, "self_excluded")

played = run(X.round_record(opened["round_id"]))
check("the round is voided rather than left claimed", played["status"], "void")
check("...with nothing staked on it", played["total_stake"], None)
check("...and nothing paid", played["payout"], None)
check("THE LEDGER IS EMPTY — a limit stops a play, it never moves money",
      len(DB[C.LEDGER].docs), 0)
check("...and no balance row was ever created", len(DB[C.BALANCES].docs), 0)


# ── The call is where it has to be: before the debit ───────────────────────────
#
# Read out of `chance.py`'s own source, so a later edit that moves the gate
# after `apply_movement` — which would take the stake and then refuse the play —
# fails here rather than in production.

play_src = ast.parse((ROOT / "app" / "services" / "chance.py").read_text())
play_fn = next(
    node
    for node in ast.walk(play_src)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name == "play_round"
)
gate_line = min(
    (
        node.lineno
        for node in ast.walk(play_fn)
        if isinstance(node, ast.Attribute) and node.attr == "gate_play"
    ),
    default=None,
)
movement_line = min(
    (
        node.lineno
        for node in ast.walk(play_fn)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "apply_movement"
    ),
    default=None,
)
truthy("play_round calls the protection gate at all", gate_line is not None)
truthy("play_round moves money at all", movement_line is not None)
truthy(
    "and the gate is called BEFORE the stake is debited",
    gate_line is not None and movement_line is not None and gate_line < movement_line,
)

commit_fn = next(
    node
    for node in ast.walk(play_src)
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name == "commit_round"
)
truthy(
    "commit_round calls the protection gate too",
    any(
        isinstance(node, ast.Attribute) and node.attr == "gate_commit"
        for node in ast.walk(commit_fn)
    ),
)

# The whole of "money is never moved by any of this", checked as a fact about
# the module rather than as a promise in its docstring.
protection_src = (ROOT / "app" / "services" / "player_protection.py").read_text()
absent("player_protection never imports the money service", protection_src,
       "from app.services.money")
absent("...nor apply_movement", protection_src, "apply_movement")
for name in ("balances", "C.LEDGER", "C.BALANCES"):
    absent(f"...nor touches {name}", protection_src, name)


# ══════════════════════════════════════════════════════════════════════════════
# 13. EVERY ROUTE IS GUARDED, AND EVERY FIGURE IS AN INTEGER
# ══════════════════════════════════════════════════════════════════════════════

INTERNAL_GUARDS = {"require_internal", "require_owner", "require_team_admin"}
router_src = ast.parse((ROOT / "app" / "routers" / "chance.py").read_text())
protection_routes: dict[str, tuple[set, bool]] = {}
for node in ast.walk(router_src):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    paths = [
        d.args[0].value
        for d in node.decorator_list
        if isinstance(d, ast.Call)
        and isinstance(d.func, ast.Attribute)
        and isinstance(d.func.value, ast.Name)
        and d.func.value.id == "router"
        and d.args
        and isinstance(d.args[0], ast.Constant)
    ]
    if not any("protection" in str(p) for p in paths):
        continue
    guards = {
        default.args[0].id
        for default in list(node.args.defaults) + list(node.args.kw_defaults)
        if isinstance(default, ast.Call)
        and isinstance(default.func, ast.Name)
        and default.func.id == "Depends"
        and default.args
        and isinstance(default.args[0], ast.Name)
    }
    signs = any(
        isinstance(inner, ast.Call)
        and isinstance(inner.func, ast.Name)
        and inner.func.id == "_signed_caller"
        for inner in ast.walk(node)
    )
    protection_routes[node.name] = (guards, signs)

truthy("the router really declares protection routes", len(protection_routes) >= 8)
for name, (guards, signs) in sorted(protection_routes.items()):
    truthy(
        f"{name} is guarded by a real dependency or verifies a signature",
        bool(guards & INTERNAL_GUARDS) or signs,
    )
# Every route that *decides* something about an account is a team admin's.
for name in ("review_protection_flag", "impose_limits", "decide_lift"):
    truthy(f"{name} needs a team admin", "require_team_admin" in protection_routes[name][0])
# And there is deliberately no route that cancels a self-exclusion.
router_text = (ROOT / "app" / "routers" / "chance.py").read_text()
absent("there is no route that cancels a self-exclusion", router_text,
       'router.post("/edge/protection/self-exclusion/cancel')

for doc in DB[C.PLAYER_PROTECTION].docs:
    for window, entry in (doc.get("limits") or {}).items():
        for source, held in entry.items():
            truthy(
                f"{window}/{source} limit {held.get('amount')!r} is an int",
                isinstance(held.get("amount"), int)
                and not isinstance(held.get("amount"), bool),
            )
    truthy(
        f"blocked_plays {doc.get('blocked_plays')!r} is an int",
        isinstance(doc.get("blocked_plays", 0), int),
    )

for flag in DB[C.PLAYER_PROTECTION_FLAGS].docs:
    for key, value in (flag.get("evidence") or {}).items():
        truthy(
            f"evidence {key}={value!r} is an int, a bool or a timestamp",
            isinstance(value, (int, bool, datetime)) or value is None,
        )


# ── Report ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} player-protection checks passed.")
print()
print("  · a daily loss limit stops the play at exactly the headroom, and one")
print("    diamond past it — cut in Asia/Kolkata, not in UTC")
print("  · a weekly limit is a second window over the local ISO week")
print("  · a limit is the account's, not one mechanic's: moving game restores nothing")
print("  · a raise waits 24 hours; a reduction is immediate; the lowest set wins")
print("  · self-exclusion cannot be short, cannot be shortened, does not lift on")
print("    its own, and reopens only on the player's request, after a reflection")
print("    period, by a named person with a reason")
print("  · a cooling-off period holds to the last second and is gone at the next")
print("  · a session reminder fires at 60 minutes of continuous play, once")
print("  · each of the three harm patterns is detected, and each near miss is not")
print("  · a flag is closed by a named person or by nobody")
print("  · an unreadable protection store is a refused play, never a zero")
print()
print("The window, in figures — Asia/Kolkata is UTC+05:30:")
print(f"  {'a moment in UTC':>22}  {'the player’s day':>18}  {'window in UTC':>34}")
for moment in (
    utc(2026, 8, 24, 12, 0),
    utc(2026, 8, 24, 18, 29),
    utc(2026, 8, 24, 18, 30),
    utc(2026, 8, 24, 23, 0),
):
    s, u, lab = P.day_window(moment)
    print(
        f"  {moment.strftime('%Y-%m-%d %H:%M'):>22}  {lab:>18}  "
        f"{s.strftime('%m-%d %H:%M')} → {u.strftime('%m-%d %H:%M')}".rjust(34)
    )
print()
print("  The 18:29 and 18:30 rows are the whole of it: half a minute apart, and")
print("  two different days for the player whose limit it is. A UTC-cut window")
print("  puts both in the 24th and lets the same 1,000 diamonds be lost twice.")
