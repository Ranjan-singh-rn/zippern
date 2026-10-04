"""Chance mechanics — the server's RNG, and the configuration behind it.

Spec Part 8B.0 – 8B.5. Everything a user stakes value on and does not know the
outcome of in advance: lucky gift tiers today, games like Aviator later. One
control system, because they share one risk profile.

Two halves, and the second exists because the first is not enough. Everything
down to `player_rounds` bounds **one round** — the odds are the server's, the
table sums to 100%, the payout is floored and capped at a maximum single win an
owner signed. Nothing in it bounds a thousand rounds, and 8B.4.6 names exactly
that gap: "the lucky gift payback is created on the spot with no reserve and
platform cut can go negative". From "Exposure, the reserve, and the ceilings"
onward is the part that closes it — a modelled reserve, three payout ceilings
enforced by atomic compare-and-increment, an auto-suspend that stops the
mechanic rather than watching it pay, and a monitor that tells a bad week from a
broken table with a confidence bound instead of a percentage gap.

8B.1.7 is the sentence this module exists to satisfy:

    "Until this exists, no chance mechanic should be live. Client-side
     randomness means the payout is whatever a modified app claims it is."

Four things are true of every round that goes through here, and each of them is
a refusal somewhere below rather than a convention:

  * **The outcome is drawn on this server.** A caller supplies a stake, a
    quantity and — if it wants — entropy of its own. It does not supply a
    result, a multiplier or a winning amount, and any field that looks like one
    is dropped on the floor and recorded as having been dropped (8B.1.2 /
    8B.1.3).
  * **The round is written down before it is paid.** Stake, result, multiplier,
    payout, timestamp and player land in `chance_rounds` in one document, and
    only then is a diamond credited (8B.1.5).
  * **Stake and payout are ledger movements**, through `money.apply_movement`
    like every other rupee, diamond and bean in the business — which is what
    puts them in the audit log (8B.7.4) with an idempotency key that makes a
    replayed settlement a no-op rather than a second payout.
  * **The result is provable afterwards.** The seed is committed as a hash
    before the round and revealed after it, so a player can recompute the draw
    and see that nothing moved between the commitment and the reveal (8B.1.6).

## Why `secrets` and never `random`

`random.Random` is a Mersenne Twister seeded, by default, from the clock. Two
consequences, both fatal here: 624 consecutive outputs are enough to recover the
full internal state and predict every subsequent draw, and a process seeded from
`time.time()` at start-up has at most a few million plausible seeds — a player
who knows roughly when the server booted can enumerate them offline and know the
outcome of every round before it happens. Every random byte in this module comes
from `secrets` (which is `os.urandom`, the kernel CSPRNG). The draw itself is
then *derived* from the committed seed with HMAC-SHA256 rather than drawn again,
because a verifiable outcome has to be reproducible from published values —
that is the whole of provable fairness, and it is why the roll is a keyed hash
and not a second call to the CSPRNG.

## What a mechanic is, and what a round is

A **mechanic** (`chance_mechanics`) is the thing that exists: "lucky gift tier
1", "Aviator". It carries a name, a kind, and a pointer at the configuration
version currently in force. It carries no odds, no countries and no money. A new
one is created disabled — no live version — and is therefore invisible in every
market until an owner has signed a configuration for it (8B.0.4, and the rule
that nothing is live by default).

A **configuration version** (`chance_configs`) is one immutable record per
change: the full outcome table, the stake denominations, the maximum single win,
the enabled countries, the RTP band, and the RTP the server computed from the
table. Versions are never edited. A change is a **new version**, raised as a
card on the money board, verified by a second person and signed by an owner
(8B.2.8 / Part 5), and only then does it become the live one.

A **round** (`chance_rounds`) is one play. It pins the configuration version it
was committed against, exactly as a commission accrual carries the slab
breakdown it was computed from (0.6.2 / 9.8) — a table that changes at 14:02
does not reach into a round committed at 14:01.

## Country gating, and why "invisible" is achievable from here

8B.0.7 and 8B.14.3 ask for something stronger than a refusal: a mechanic
disabled for a country must be *invisible* there, not blocked on tap. An API
cannot render a screen, but it can make the two calls a screen is built from
answer as though the mechanic does not exist:

  * `visible_mechanics(country)` returns the mechanics live in that market and
    says nothing whatsoever about the others — no entry, no `enabled: false`,
    no count that differs by market. A client that renders what it is given
    renders nothing, because it was told nothing.
  * `commit_round` on a mechanic not enabled for the caller's country raises
    `MechanicUnavailable`, which the router answers **404** with the same body a
    genuinely unknown id produces. A modified client that hardcodes the id
    learns nothing from the response that it did not already know.

Removing a country takes effect the moment the version is written; there is no
app release in the path (8B.14.1). See `withdraw_country` for the one asymmetry
in the signing rule and the reason for it.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterable, Mapping, Sequence

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.core import audit
from app.core.compat import StrEnum
from app.core.roles import Role, Team
from app.db.mongo import C, get_db
from app.services import cards as card_svc
from app.services.cards import CardError, CardType, NewCard, Stage
from app.services.money import (
    Currency,
    DuplicateMovement,
    HolderType,
    InsufficientBalance,
    Movement,
    apply_movement,
)

log = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════════════════════
#  Units. Integers, all the way down.
# ══════════════════════════════════════════════════════════════════════════════
#
# Three scales, and nothing in this module is ever a float:
#
#   * **Probability** in parts per million. `PROBABILITY_TOTAL` is the sum every
#     outcome table must hit exactly (8B.2.3). Basis points would have done for
#     the tables that exist today, but a one-in-a-hundred-thousand jackpot is not
#     writable in basis points at all, and a scale that cannot express the table
#     somebody wants to write is a scale they will work around.
#   * **Multiplier** in basis points, so `10_000` is 1× and `170_000` is 17×.
#     Halves and quarters of a stake are ordinary lucky-gift outcomes and a
#     whole-number multiplier could not hold them.
#   * **Money** in whole diamonds. A diamond is already the minor unit — there
#     is no smaller one — so a payout is an integer count and never a fraction.
PROBABILITY_TOTAL = 1_000_000          # ppm; 100%
MULTIPLIER_ONE = 10_000                # basis points; 1×

#: `probability_ppm × multiplier_bp` lands on this scale. Kept exactly, and
#: divided down only where a figure is being displayed.
RTP_SCALE = PROBABILITY_TOTAL * MULTIPLIER_ONE  # 10_000_000_000

#: The band a tier's effective RTP must sit inside before it may go live
#: (8B.3.4). A default, not a law: every configuration carries its own and an
#: owner signs it. 85%–96% is wide enough for a lucky gift and a game to have
#: different margins and narrow enough that 13% (8B.3.3) is refused on sight.
DEFAULT_RTP_BAND_MIN_PPM = 850_000     # 85%
DEFAULT_RTP_BAND_MAX_PPM = 960_000     # 96%

#: A settlement callback older than this is refused whatever its signature says.
#: A valid signature is not a fresh one, and a captured request replayed a day
#: later must not settle anything.
CALLBACK_MAX_AGE_SECONDS = 300

#: ISO 3166-1 alpha-2. Two letters, upper case, and nothing else — a country
#: list is the regulatory control surface (8B.0.4) and "in", "IND" and "India"
#: being three different markets is how a market stays switched on by accident.
COUNTRY_PATTERN = re.compile(r"^[A-Z]{2}$")

MECHANIC_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]{2,63}$")

MIN_REASON = 8


# ══════════════════════════════════════════════════════════════════════════════
#  Failures
# ══════════════════════════════════════════════════════════════════════════════


class ChanceError(Exception):
    """Refused by a rule in this module. The message is safe to show a caller."""


class MalformedOutcomeTable(ChanceError):
    """The odds table cannot be read, so no odds are derived from it."""


class ConfigBlocked(ChanceError):
    """The table is readable and must not go live. Carries every reason."""

    def __init__(self, message: str, reasons: Sequence[str] = ()):
        super().__init__(message)
        self.reasons = list(reasons)


class MechanicUnavailable(ChanceError):
    """No such mechanic here.

    Raised both for a mechanic that does not exist and for one that is not
    enabled in the caller's country, **with the same message**, and answered
    404 by the router. Distinguishing the two would turn the API into a map of
    which markets a mechanic is switched off in, which is exactly what 8B.0.7
    says must not be visible.
    """


class RoundError(ChanceError):
    """This round cannot be played, or cannot be played again."""


class SignatureError(ChanceError):
    """A server-to-server caller did not prove it is who it says it is."""


class PlayerFrozen(ChanceError):
    """This player's chance activity is frozen pending a review. Spec 8B.5.4.

    Deliberately **not** `MechanicUnavailable`. A suspended mechanic and a
    disabled one must be indistinguishable because the thing being hidden is a
    fact about the *market* (8B.0.7); a frozen player is a fact about their own
    account, and 0.5.5 already commits this business to telling somebody when
    their access is restricted and that their balance is preserved. Answering a
    frozen player "no such mechanic" would be a lie about a different subject,
    and would leave them unable to ask anybody about it.
    """


# ══════════════════════════════════════════════════════════════════════════════
#  Vocabulary
# ══════════════════════════════════════════════════════════════════════════════


class MechanicKind(StrEnum):
    LUCKY_GIFT = "lucky_gift"   # a gift tier with an uncertain return
    GAME = "game"               # Aviator and anything like it
    EVENT = "event"             # a limited-time mechanic (8B.12)


class MultiplierBasis(StrEnum):
    """What the drawn multiplier multiplies. Spec 8B.3.1.

    `TOTAL_STAKE` is the only setting a table may go live on without an explicit
    declaration, because it is the only one under which a larger play cannot
    return less per diamond than a smaller one. `UNIT_STAKE` is the shape of the
    current build and is what produced 58 / 59 / 27 / 13 (8B.3.3); it is kept —
    rather than deleted — because the spec permits a deliberate, stated lower
    return on larger plays, and because a control that cannot express the
    mistake cannot demonstrate that it catches it.
    """

    TOTAL_STAKE = "total_stake"
    UNIT_STAKE = "unit_stake"


class ConfigStatus(StrEnum):
    DRAFT = "draft"            # written, card raised, nothing live
    LIVE = "live"
    SUPERSEDED = "superseded"
    WITHDRAWN = "withdrawn"    # the card was rejected


class RoundStatus(StrEnum):
    COMMITTED = "committed"    # seed hash published, nothing staked
    PLAYING = "playing"        # claimed for a draw; a crash leaves it here
    RECORDED = "recorded"      # outcome written, payout not yet credited
    SETTLED = "settled"
    VOID = "void"


class Act:
    """Audit actions written by this module.

    `audit.Action` already carries `CONFIG_CHANGED`, and that is what the three
    configuration events are recorded under — a configuration change is a
    configuration change whether it is a rate table or an odds table, and an
    owner filtering the log for "what was changed" should see all of them. The
    round-level actions below have no equivalent in that vocabulary and are
    declared here, beside the only code that writes them, the way
    `expenses.Act` keeps an expense's two actions beside the expense.
    """

    CONFIG_CHANGED = audit.Action.CONFIG_CHANGED

    MECHANIC_CREATED = "chance.mechanic_created"
    STAKE = "chance.stake"
    PAYOUT = "chance.payout"
    ROUND_RECORDED = "chance.round_recorded"
    ROUND_VOID = "chance.round_void"
    CLIENT_CLAIM_IGNORED = "chance.client_claim_ignored"
    EXTERNAL_SETTLEMENT = "chance.external_settlement"

    # ── 8B.4.5 / 8B.5.4 — the stops ──────────────────────────────────────────
    CEILING_BREACHED = "chance.ceiling_breached"
    MECHANIC_SUSPENDED = "chance.mechanic_suspended"
    MECHANIC_RESUMED = "chance.mechanic_resumed"
    PLAYER_FROZEN = "chance.player_frozen"
    PLAYER_UNFROZEN = "chance.player_unfrozen"


#: Fields a caller might send that describe an *outcome*. Every one of them is
#: removed from the request before anything else happens, and their presence is
#: recorded (8B.1.2 / 8B.1.3). They are not refused: a refusal tells a modified
#: client which field name to stop sending, and an honest SDK that grew a
#: `won` field in a future version would start failing rounds for real players.
#: Dropping them is silent to the caller and loud in the audit log.
CLIENT_CLAIM_FIELDS: frozenset[str] = frozenset(
    {
        "outcome",
        "outcome_index",
        "result",
        "multiplier",
        "multiplier_bp",
        "payout",
        "payout_diamonds",
        "winnings",
        "win",
        "won",
        "prize",
        "balance",
        "balance_after",
        "rtp",
        "seed",
        "server_seed",
    }
)


# ══════════════════════════════════════════════════════════════════════════════
#  The outcome table — pure arithmetic, no database
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Outcome:
    """One row of the table: a multiplier and the chance of drawing it."""

    index: int
    multiplier_bp: int
    probability_ppm: int

    @property
    def multiplier_text(self) -> str:
        return _trim(Decimal(self.multiplier_bp) / MULTIPLIER_ONE)

    @property
    def probability_percent(self) -> str:
        return _trim(Decimal(self.probability_ppm) / 10_000)

    @property
    def contribution(self) -> int:
        """This row's share of the RTP, on `RTP_SCALE`."""
        return self.multiplier_bp * self.probability_ppm

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "multiplier_bp": self.multiplier_bp,
            "multiplier": self.multiplier_text,
            "probability_ppm": self.probability_ppm,
            "probability_percent": self.probability_percent,
            "contribution_ppm": _div_half_up(self.contribution, MULTIPLIER_ONE),
            "label": (
                f"{self.multiplier_text}× on {self.probability_percent}% of rolls"
            ),
        }


def _trim(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _div_half_up(numerator: int, denominator: int) -> int:
    """Integer division, halves away from zero, no float anywhere.

    Used only where an exact figure is being *reported* on a coarser scale. No
    money is ever computed through it — a payout is a floor (see `payout_for`).
    """
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    sign = -1 if numerator < 0 else 1
    n = abs(numerator)
    return sign * ((n * 2 + denominator) // (denominator * 2))


def _whole(value: Any, label: str) -> int:
    """A whole number, or a refusal. `True` is not a number here."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise MalformedOutcomeTable(
            f"{label} must be a whole number — got {type(value).__name__} "
            f"{value!r}. Probabilities, multipliers and payouts are integers in "
            "this system: a float probability cannot be checked to sum to "
            "exactly 100%, and a float payout is a rounding decision nobody "
            "would ever see."
        )
    return value


def parse_outcomes(raw: Any) -> list[Outcome]:
    """Read an outcome table, or refuse it. Spec 8B.2.3.

    The one rule with no discretion in it: **the probabilities must sum to
    exactly `PROBABILITY_TOTAL`**. Not "about", not "within rounding" — exactly,
    checked on integers, because a table summing to 999,999 has a
    one-in-a-million case the draw would have to invent a rule for, and a table
    summing to 1,000,001 has an outcome that can never be drawn. Either is a
    mis-set table, and the only safe thing to do with a mis-set table is
    refuse it.
    """
    if not isinstance(raw, (list, tuple)) or not raw:
        raise MalformedOutcomeTable(
            "An outcome table is a non-empty list of "
            "{multiplier_bp, probability_ppm} rows. Nothing is derived from a "
            f"table that is not one — got {type(raw).__name__} {raw!r}."
        )

    outcomes: list[Outcome] = []
    seen: set[int] = set()
    for i, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise MalformedOutcomeTable(
                f"Outcome {i + 1} is a {type(row).__name__}, not a mapping."
            )
        multiplier = _whole(
            row.get("multiplier_bp"), f"Outcome {i + 1}'s multiplier_bp"
        )
        probability = _whole(
            row.get("probability_ppm"), f"Outcome {i + 1}'s probability_ppm"
        )
        if multiplier < 0:
            raise MalformedOutcomeTable(
                f"Outcome {i + 1} has a multiplier of {multiplier} basis points. "
                "A negative multiplier would take more than the stake, which is "
                "not something this mechanic can do."
            )
        if probability <= 0:
            raise MalformedOutcomeTable(
                f"Outcome {i + 1} has a probability of {probability} ppm. An "
                "outcome that can never be drawn is not an outcome; remove the "
                "row rather than writing it as zero."
            )
        if probability > PROBABILITY_TOTAL:
            raise MalformedOutcomeTable(
                f"Outcome {i + 1} has a probability of {probability} ppm, which "
                f"is more than the whole of {PROBABILITY_TOTAL} ppm (100%)."
            )
        if multiplier in seen:
            raise MalformedOutcomeTable(
                f"Outcome {i + 1} repeats the multiplier {multiplier} basis "
                "points. Two rows with the same multiplier are one row with "
                "their probabilities added; written as two, a reader checking "
                "the odds sees the smaller number."
            )
        seen.add(multiplier)
        outcomes.append(
            Outcome(index=i, multiplier_bp=multiplier, probability_ppm=probability)
        )

    total = sum(o.probability_ppm for o in outcomes)
    if total != PROBABILITY_TOTAL:
        short = PROBABILITY_TOTAL - total
        raise MalformedOutcomeTable(
            f"The probabilities sum to {total} ppm, not {PROBABILITY_TOTAL} ppm "
            f"(100%). It is {'short by' if short > 0 else 'over by'} "
            f"{abs(short)} ppm ({_trim(Decimal(abs(short)) / 10_000)}%). A table "
            "that does not sum to exactly 100% is refused rather than "
            "normalised: normalising it would silently change every "
            "probability an owner signed."
        )

    # Sorted by multiplier so the stored table, the published odds and the
    # cumulative draw below all read in the same order whatever order it was
    # written in. The index is re-stated after sorting because it is what a
    # round records and what a fairness check recomputes.
    outcomes.sort(key=lambda o: o.multiplier_bp)
    return [
        Outcome(index=i, multiplier_bp=o.multiplier_bp, probability_ppm=o.probability_ppm)
        for i, o in enumerate(outcomes)
    ]


def rtp_numerator(outcomes: Sequence[Outcome]) -> int:
    """Σ probability × multiplier, exactly, on `RTP_SCALE`."""
    return sum(o.contribution for o in outcomes)


def rtp_ppm(outcomes: Sequence[Outcome]) -> int:
    """Return to player in ppm, computed from the table. Spec 8B.2.4.

    **Never typed in.** There is no parameter anywhere in this module by which a
    caller can state an RTP; the only way to change it is to change the table
    that produces it, which is the entire point of 8B.2.4 — nobody sets odds
    without seeing the margin that falls out of them.
    """
    return _div_half_up(rtp_numerator(outcomes), MULTIPLIER_ONE)


#: `variance_numerator` below lands on this scale. Var(M) is a *squared*
#: fraction, so it carries the square of the RTP scale: (10^6 × 10^4)² = 10^20.
VARIANCE_SCALE = RTP_SCALE * RTP_SCALE  # 10^20


def variance_numerator(outcomes: Sequence[Outcome]) -> int:
    """Var(multiplier) × 10^20, exactly, on integers. Spec 8B.4.1 / 8B.5.2.

    This is the number that separates a bad week from a broken table, and it is
    computed from the signed odds themselves rather than from history — so the
    question "is this normal?" is answered by the configuration an owner put
    their name to, not by what the last few days happened to look like.

    Var(M) = E[M²] − E[M]². With `p` in ppm and `m` in basis points:

        E[M²] = Σ p·m² / 10^14        E[M]² = (Σ p·m)² / 10^20

    so Var(M) = (10^6·Σ p·m² − (Σ p·m)²) / 10^20, and the numerator is an
    exact integer. Nothing here is ever a float: a variance computed in
    floating point would give a slightly different sigma on two machines, and a
    threshold that is not reproducible is not a control.
    """
    second = sum(o.probability_ppm * o.multiplier_bp * o.multiplier_bp for o in outcomes)
    mean = rtp_numerator(outcomes)
    return second * PROBABILITY_TOTAL - mean * mean


def sigma_ppm(outcomes: Sequence[Outcome]) -> int:
    """The standard deviation of one round's multiplier, in ppm of the stake.

    A lucky gift returning 92% with a 50× tail has a sigma near 1,600,000 ppm —
    **1.6×** the stake, on a mean of 0.92. One round tells you nothing; that is
    the arithmetic behind 8B.4.1, and it is why the reserve is sized in sigmas
    below and why the RTP monitor uses a confidence bound rather than a
    percentage gap.
    """
    import math

    return math.isqrt(variance_numerator(outcomes)) // MULTIPLIER_ONE


def bad_run_diamonds(*, stake: int, rounds: int, rtp: int, sigma: int, k: int) -> int:
    """What a `k`-sigma bad run costs the house, in diamonds. Spec 8B.4.1.

    Expected profit over `rounds` plays at `stake` is `rounds·stake·(1 − RTP)`;
    the spread of the house's position is `stake·sigma·√rounds`. A run this bad
    is a **planned** event, not a failure — which is the sentence 8B.4.1 exists
    to say, expressed as the number the reserve has to cover. Negative means the
    house is still ahead after a run that bad.
    """
    import math

    if rounds <= 0 or stake <= 0:
        return 0
    expected_profit = rounds * stake * (PROBABILITY_TOTAL - rtp) // PROBABILITY_TOTAL
    spread = k * stake * sigma * math.isqrt(rounds) // PROBABILITY_TOTAL
    return spread - expected_profit


def effective_rtp_ppm(
    outcomes: Sequence[Outcome], quantity: int, basis: MultiplierBasis
) -> int:
    """The RTP a player actually receives at this quantity. Spec 8B.3.2.

    Under `TOTAL_STAKE` this is the table's RTP at every quantity, and that is
    not a coincidence or an approximation — the multiplier scales with the
    stake, so quantity cancels. Under `UNIT_STAKE` the payout is fixed to one
    unit's stake while the player paid for `quantity` of them, so the return
    divides by the quantity. That single division is the whole of 8B.3.3.
    """
    if quantity < 1:
        raise ChanceError("A quantity is at least 1.")
    numerator = rtp_numerator(outcomes)
    if basis is MultiplierBasis.UNIT_STAKE:
        numerator = _div_half_up(numerator, quantity)
    return _div_half_up(numerator, MULTIPLIER_ONE)


def percent(ppm: int) -> str:
    """A ppm figure as a percentage string — "92", "58.8235"."""
    return _trim(Decimal(ppm) / 10_000)


def payout_for(
    total_stake: int, multiplier_bp: int, max_single_win: int
) -> tuple[int, bool, int]:
    """What one round pays. Returns (payout, was_capped, uncapped_payout).

    Two decisions are recorded here.

    **The multiplication floors.** `total_stake × multiplier_bp // 10_000` — a
    payout is a whole number of diamonds and there is no smaller unit to round
    into, so the fraction has to go somewhere. It goes to the house, always, and
    the largest amount it can ever be is one diamond on one round. Rounding it
    to the player instead would mint a diamond nobody staked, and rounding it
    half-up would do so on half of all rounds.

    **The cap is absolute** (8B.2.6). It is applied here, after the
    multiplication and before anything is credited, so it bounds the worst case
    on a single round whatever the table says and whatever a third-party
    provider claims. Both figures are recorded: a capped round shows what the
    table would have paid, because a cap that silently rewrites a result is
    indistinguishable from a mis-set table.
    """
    if total_stake <= 0:
        raise RoundError("A round needs a positive stake.")
    if max_single_win <= 0:
        raise ChanceError("A maximum single win must be a positive number of diamonds.")
    uncapped = total_stake * multiplier_bp // MULTIPLIER_ONE
    if uncapped > max_single_win:
        return max_single_win, True, uncapped
    return uncapped, False, uncapped


# ══════════════════════════════════════════════════════════════════════════════
#  The draw
# ══════════════════════════════════════════════════════════════════════════════
#
# The seed is drawn once, from the kernel, and committed as a hash. The outcome
# is then *derived* from it by keyed hashing, so it is reproducible by anybody
# holding the revealed seed and the published message, and by nobody holding
# only the hash.


def new_seed() -> bytes:
    """32 bytes from the operating system's CSPRNG.

    `secrets.token_bytes` is `os.urandom`. Not `random.getrandbits`, which is a
    Mersenne Twister whose entire future output is recoverable from 624 past
    draws, and not `random.seed(time.time())`, whose seed space is small enough
    to enumerate offline. See the module docstring.
    """
    return secrets.token_bytes(32)


def seed_hash(seed: bytes) -> str:
    """The commitment published before the round. SHA-256 of the raw seed."""
    return hashlib.sha256(seed).hexdigest()


def draw_message(round_id: str, nonce: str, client_entropy: str) -> str:
    """Everything the draw is derived from, as one canonical string.

    `round_id` and `nonce` are published at commit time, alongside the seed
    hash. `client_entropy` is supplied by the caller at play time — after it has
    seen the commitment. That ordering is what makes the scheme mean something:
    the server cannot choose a seed to suit the entropy (it committed first) and
    the player cannot choose entropy to suit the seed (it is still hidden).
    """
    return f"{round_id}:{nonce}:{client_entropy}"


def _stream_word(seed: bytes, message: str, counter: int) -> int:
    digest = hmac.new(
        seed, f"{message}:{counter}".encode("utf-8"), hashlib.sha256
    ).digest()
    return int.from_bytes(digest[:8], "big")


def draw(seed: bytes, message: str, outcomes: Sequence[Outcome]) -> dict:
    """Pick one outcome. Deterministic given the seed and the message.

    A 64-bit word modulo 1,000,000 is very slightly biased — 2^64 is not a
    multiple of 1,000,000, so the first 1,551,116 tickets are marginally more
    likely than the rest. The bias is around one part in 10^13 and would never
    be noticed; it is removed anyway by rejection sampling, because "too small
    to matter" is not an answer that can be given to a player asking whether the
    odds are the ones that were published, and the fix costs one comparison.
    """
    limit = ((1 << 64) // PROBABILITY_TOTAL) * PROBABILITY_TOTAL
    ticket = -1
    counter = 0
    for counter in range(128):
        word = _stream_word(seed, message, counter)
        if word < limit:
            ticket = word % PROBABILITY_TOTAL
            break
    if ticket < 0:  # pragma: no cover — probability ~2^-2000
        raise RoundError("The draw could not be resolved. Nothing was staked.")

    cursor = 0
    for outcome in outcomes:
        cursor += outcome.probability_ppm
        if ticket < cursor:
            return {
                "index": outcome.index,
                "multiplier_bp": outcome.multiplier_bp,
                "ticket": ticket,
                "counter": counter,
                "algorithm": (
                    "ticket = HMAC-SHA256(seed, f'{message}:{counter}')[:8] as a "
                    "big-endian integer, rejected and re-drawn with counter+1 "
                    "while it is >= floor(2^64 / 1000000) * 1000000, then "
                    "modulo 1000000. Outcomes are ordered by multiplier "
                    "ascending and the first whose cumulative probability "
                    "exceeds the ticket is the result."
                ),
            }
    raise RoundError(  # pragma: no cover — parse_outcomes makes this unreachable
        "The outcome table does not cover the whole probability space."
    )


def verify_round_outcome(
    *,
    seed_hex: str,
    published_hash: str,
    round_id: str,
    nonce: str,
    client_entropy: str,
    outcomes: Sequence[Outcome],
    recorded_index: int,
) -> dict:
    """Recompute a settled round from published values. Spec 8B.1.6.

    Pure, and deliberately takes everything it needs as arguments: a player, a
    regulator or an auditor can run this against the numbers on their own
    screen without an account, and the answer does not depend on anything this
    server chooses to say at the time it is asked.
    """
    seed = bytes.fromhex(seed_hex)
    computed_hash = seed_hash(seed)
    result = draw(seed, draw_message(round_id, nonce, client_entropy), outcomes)
    return {
        "seed_matches_commitment": hmac.compare_digest(computed_hash, published_hash),
        "published_hash": published_hash,
        "recomputed_hash": computed_hash,
        "recomputed_index": result["index"],
        "recorded_index": recorded_index,
        "outcome_matches": result["index"] == recorded_index,
        "ticket": result["ticket"],
        "verified": (
            hmac.compare_digest(computed_hash, published_hash)
            and result["index"] == recorded_index
        ),
        "algorithm": result["algorithm"],
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Evaluating a configuration — what the portal shows, and what it blocks
# ══════════════════════════════════════════════════════════════════════════════


def _countries(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str) or not isinstance(raw, Iterable):
        raise ChanceError(
            "Enabled countries are a list of ISO 3166-1 alpha-2 codes, e.g. "
            f"['IN', 'AE']. Got {raw!r}."
        )
    out: list[str] = []
    for entry in raw:
        code = str(entry or "").strip().upper()
        if not COUNTRY_PATTERN.match(code):
            raise ChanceError(
                f"'{entry}' is not an ISO 3166-1 alpha-2 country code. A country "
                "list is the regulatory switch (8B.0.4); a code nobody can match "
                "is a market nobody can turn off."
            )
        if code not in out:
            out.append(code)
    return sorted(out)


def _quantities(raw: Any) -> list[int]:
    if not raw:
        return [1]
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Iterable):
        raise ChanceError("Quantity tiers are a list of whole numbers, e.g. [1, 17].")
    out: list[int] = []
    for entry in raw:
        value = _whole(entry, "A quantity tier")
        if value < 1:
            raise ChanceError(f"A quantity tier is at least 1 — got {value}.")
        if value not in out:
            out.append(value)
    return sorted(out)


def _stake_rules(raw: Any) -> dict:
    """Minimum, maximum and step. Spec 8B.2.5."""
    raw = raw if isinstance(raw, Mapping) else {}
    minimum = _whole(raw.get("min_stake"), "min_stake")
    maximum = _whole(raw.get("max_stake"), "max_stake")
    step = _whole(raw.get("step"), "step")
    if minimum <= 0:
        raise ChanceError("The minimum stake must be at least one diamond.")
    if maximum < minimum:
        raise ChanceError(
            f"The maximum stake ({maximum}) is below the minimum ({minimum})."
        )
    if step <= 0:
        raise ChanceError("The stake step must be a positive number of diamonds.")
    if (maximum - minimum) % step:
        raise ChanceError(
            f"A step of {step} from a minimum of {minimum} never reaches the "
            f"maximum of {maximum}. The top denomination would be unplayable, "
            "which is not what anybody means by a maximum stake."
        )
    return {"min_stake": minimum, "max_stake": maximum, "step": step}


def permitted_stake(stake: int, rules: Mapping) -> bool:
    minimum = int(rules["min_stake"])
    maximum = int(rules["max_stake"])
    step = int(rules["step"])
    if stake < minimum or stake > maximum:
        return False
    return (stake - minimum) % step == 0


#: How many sigmas of bad luck the guidance below prices, and over how many
#: rounds. Three sigma over a hundred thousand rounds is the shape of a bad
#: month on a live lucky gift; it is printed on the card so that a reserve is
#: chosen against a number rather than against a feeling (8B.4.1).
RESERVE_GUIDANCE_SIGMAS = 3
RESERVE_GUIDANCE_ROUNDS = (1_000, 10_000, 100_000)


def _exposure_rules(
    raw: Any, *, max_single_win: int, outcomes: Sequence[Outcome], top_stake: int
) -> tuple[dict, list[str], list[str]]:
    """The reserve and the ceilings. Spec 8B.4.3 / 8B.4.4.

    These live **inside the configuration version**, which means they change on
    the same card, with the same second pair of eyes and the same owner
    signature, as the odds table does (8B.2.8). That is not tidiness: a reserve
    is the amount of money the business has agreed it can lose on this mechanic,
    and a figure like that moving on an environment variable at three in the
    morning is exactly the shape of 8B.4.6.

    Returns `(resolved, flags, blocked)`. Every figure is a whole number of
    diamonds, and `None` means "no ceiling of this kind", which is stated as a
    flag rather than silently treated as zero — a ceiling of zero would stop a
    mechanic paying anything at all, and reading an absent one that way would
    turn a forgotten field into an outage.
    """
    raw = raw if isinstance(raw, Mapping) else {}
    flags: list[str] = []
    blocked: list[str] = []

    def optional(name: str) -> int | None:
        value = raw.get(name)
        if value is None:
            return None
        number = _whole(value, name)
        if number <= 0:
            raise ChanceError(
                f"{name} is {number}. A ceiling of zero or less would stop the "
                "mechanic paying anything at all; leave it out to mean 'no "
                "ceiling of this kind', which is stated on the card either way."
            )
        return number

    per_round = optional("max_payout_per_round")
    per_player_day = optional("max_payout_per_player_per_day")
    platform_day = optional("max_payout_platform_per_day")
    reserve = optional("reserve_diamonds")
    basis_text = str(raw.get("reserve_basis") or "").strip()

    # 8B.2.6 already bounds one round absolutely, and it is mandatory. The
    # per-round ceiling of 8B.4.4 is therefore always *present* — it defaults to
    # the maximum single win — and can only ever be tightened, never loosened.
    if per_round is None:
        per_round = max_single_win
        resolved_from = "max_single_win"
    else:
        resolved_from = "configured"
        if per_round > max_single_win:
            blocked.append(
                f"The per-round payout ceiling is {per_round:,} diamonds and the "
                f"maximum single win is {max_single_win:,}. A ceiling above the "
                "cap that already applies can never bind, so it is not a "
                "ceiling — it is a number that reads like one on a report. "
                "Lower it, or raise the maximum single win on this same card."
            )

    if per_player_day is not None and per_player_day < per_round:
        blocked.append(
            f"A player may win {per_round:,} diamonds on one round and only "
            f"{per_player_day:,} in a day. One permitted round could not be paid "
            "in full, so every large win would be part-paid and the mechanic "
            "would suspend itself on its own first jackpot."
        )
    widest_day = per_player_day if per_player_day is not None else per_round
    if platform_day is not None and platform_day < widest_day:
        blocked.append(
            f"The platform daily ceiling of {platform_day:,} diamonds is below "
            f"what a single player is allowed in a day ({widest_day:,}). The "
            "narrower limit is the only one that would ever bind."
        )

    if reserve is not None:
        if len(basis_text) < MIN_REASON:
            blocked.append(
                "A reserve is a figure, and 8B.4.3 asks for it to be *modelled*. "
                "Write `reserve_basis` — how the number was arrived at, in a "
                "sentence an owner can disagree with. The guidance printed with "
                "this evaluation prices a "
                f"{RESERVE_GUIDANCE_SIGMAS}-sigma bad run at several volumes; "
                "quoting it is a perfectly good basis."
            )
        if platform_day is not None and platform_day > reserve:
            flags.append(
                f"The platform daily ceiling ({platform_day:,}) is larger than "
                f"the whole reserve ({reserve:,}), so a single bad day can "
                "exhaust it. That may be deliberate — the reserve is the stop, "
                "the daily ceiling is the brake — but it means the daily "
                "ceiling will never be what suspends this mechanic."
            )
    elif basis_text:
        flags.append(
            "A reserve basis is stated but no reserve figure is set, so nothing "
            "is enforced by it."
        )

    # 8B.4.1 as arithmetic: what a bad run actually costs, from the table's own
    # variance, so a reserve is chosen against a number.
    table_rtp = rtp_ppm(outcomes)
    sigma = sigma_ppm(outcomes)
    guidance = [
        {
            "rounds": rounds,
            "stake": top_stake,
            "sigmas": RESERVE_GUIDANCE_SIGMAS,
            "diamonds": bad_run_diamonds(
                stake=top_stake,
                rounds=rounds,
                rtp=table_rtp,
                sigma=sigma,
                k=RESERVE_GUIDANCE_SIGMAS,
            ),
        }
        for rounds in RESERVE_GUIDANCE_ROUNDS
    ]
    worst = max(row["diamonds"] for row in guidance)

    if reserve is None and per_player_day is None and platform_day is None:
        flags.append(
            "No reserve and no daily ceiling are configured, so the only limit "
            "on this mechanic is the maximum single win — it is bounded on one "
            "round and unbounded over a day. That is the gap 8B.4.6 names. A "
            f"{RESERVE_GUIDANCE_SIGMAS}-sigma bad run over "
            f"{RESERVE_GUIDANCE_ROUNDS[-1]:,} rounds at the top stake is "
            f"{worst:,} diamonds; a reserve wants to be at least that."
        )
    elif reserve is not None and reserve < worst:
        flags.append(
            f"The reserve of {reserve:,} diamonds is smaller than a "
            f"{RESERVE_GUIDANCE_SIGMAS}-sigma bad run over "
            f"{RESERVE_GUIDANCE_ROUNDS[-1]:,} rounds at the top stake "
            f"({worst:,}). This mechanic will suspend itself on ordinary "
            "variance, which 8B.4.1 warns is worse than no reserve at all — a "
            "control that cries wolf gets raised until it means nothing."
        )

    resolved = {
        "max_payout_per_round": per_round,
        "max_payout_per_round_source": resolved_from,
        "max_payout_per_player_per_day": per_player_day,
        "max_payout_platform_per_day": platform_day,
        "reserve_diamonds": reserve,
        "reserve_basis": basis_text,
        "sigma_ppm": sigma,
        "sigma_multiplier": _trim(Decimal(sigma) / PROBABILITY_TOTAL),
        "variance_numerator": variance_numerator(outcomes),
        "variance_scale": VARIANCE_SCALE,
        "reserve_guidance": guidance,
        "note": (
            "The per-round figure caps a payout, exactly as the maximum single "
            "win does — a big win is paid down to it and nothing suspends. The "
            "daily figures and the reserve are budgets: a payout that would "
            "cross one is paid down to the headroom that is left, the shortfall "
            "is withheld and recorded, and the mechanic auto-suspends (8B.4.5). "
            "Withheld diamonds are never written off and never silently "
            "credited — they are an exception for a person to settle on a "
            "signed card (8B.7.5)."
        ),
    }
    return resolved, flags, blocked


def evaluate_draft(draft: Mapping) -> dict:
    """Everything the portal needs to show about a proposed configuration.

    Writes nothing and reads nothing. This is the calculator behind the preview
    screen (8B.2.4 / 8B.3.2) and the gate in front of `propose_config`: the
    `blocked` flag it returns is the same flag that refuses the proposal, so
    what an owner sees before signing is what the server will enforce.
    """
    outcomes = parse_outcomes(draft.get("outcomes"))
    basis = _basis(draft.get("multiplier_basis", MultiplierBasis.TOTAL_STAKE))
    stake = _stake_rules(draft.get("stake"))
    quantities = _quantities(draft.get("quantity_tiers"))
    countries = _countries(draft.get("enabled_countries"))
    max_single_win = _whole(draft.get("max_single_win"), "max_single_win")

    band = draft.get("rtp_band") if isinstance(draft.get("rtp_band"), Mapping) else {}
    band_min = _whole(
        band.get("min_ppm", DEFAULT_RTP_BAND_MIN_PPM), "The RTP band minimum"
    )
    band_max = _whole(
        band.get("max_ppm", DEFAULT_RTP_BAND_MAX_PPM), "The RTP band maximum"
    )
    if band_min <= 0 or band_max <= band_min:
        raise ChanceError(
            f"The RTP band {band_min}–{band_max} ppm is not a band. The minimum "
            "must be positive and below the maximum."
        )
    if band_max >= PROBABILITY_TOTAL:
        raise ChanceError(
            f"The RTP band tops out at {percent(band_max)}%. A mechanic that "
            "returns 100% or more of what it takes is not a business, and a "
            "band that permits one is not a control (8B.11.1)."
        )

    if max_single_win <= 0:
        raise ChanceError(
            "A maximum single win is required and must be positive (8B.2.6). It "
            "is the only thing bounding the worst case on one round."
        )

    table_rtp = rtp_ppm(outcomes)
    nothing_back = sum(
        o.probability_ppm for o in outcomes if o.multiplier_bp < MULTIPLIER_ONE
    )
    zero_back = sum(o.probability_ppm for o in outcomes if o.multiplier_bp == 0)

    flags: list[str] = []
    blocked: list[str] = []

    # ── 8B.3.1 — what the multiplier multiplies ──────────────────────────────
    deliberate = bool(draft.get("deliberate_lower_return_on_larger_plays"))
    deliberate_reason = str(draft.get("lower_return_statement") or "").strip()
    if basis is MultiplierBasis.UNIT_STAKE:
        if not deliberate or len(deliberate_reason) < MIN_REASON:
            blocked.append(
                "The multiplier is applied to the UNIT stake, so a player buying "
                f"{max(quantities)} pays {max(quantities)}× and can win the same "
                "amount as a player buying one. 8B.3.1 permits this only where a "
                "lower return on larger plays is deliberate AND stated: set "
                "`deliberate_lower_return_on_larger_plays` and write the "
                "statement players will be shown."
            )
        else:
            flags.append(
                "Multiplier applies to the unit stake, so effective RTP falls as "
                f"quantity rises. Stated as deliberate: {deliberate_reason}"
            )

    # ── 8B.3.2 / 8B.3.4 — effective RTP per quantity tier ────────────────────
    tiers: list[dict] = []
    previous: int | None = None
    regressions: list[str] = []
    for quantity in quantities:
        tier_rtp = effective_rtp_ppm(outcomes, quantity, basis)
        in_band = band_min <= tier_rtp <= band_max
        tier_flags: list[str] = []
        if not in_band:
            side = "below" if tier_rtp < band_min else "above"
            tier_flags.append(
                f"{percent(tier_rtp)}% is {side} the agreed band "
                f"{percent(band_min)}–{percent(band_max)}%"
            )
        if previous is not None and tier_rtp < previous:
            tier_flags.append(
                f"returns less than the smaller tier ({percent(tier_rtp)}% vs "
                f"{percent(previous)}%)"
            )
            regressions.append(
                f"quantity {quantity} returns {percent(tier_rtp)}% where the tier "
                f"below returns {percent(previous)}%"
            )
        tiers.append(
            {
                "quantity": quantity,
                "effective_rtp_ppm": tier_rtp,
                "effective_rtp_percent": percent(tier_rtp),
                "house_edge_ppm": PROBABILITY_TOTAL - tier_rtp,
                "house_edge_percent": percent(PROBABILITY_TOTAL - tier_rtp),
                "in_band": in_band,
                "min_total_stake": stake["min_stake"] * quantity,
                "max_total_stake": stake["max_stake"] * quantity,
                "flags": tier_flags,
            }
        )
        previous = tier_rtp

    out_of_band = [t for t in tiers if not t["in_band"]]
    if out_of_band:
        blocked.append(
            "Blocked by 8B.3.4 — "
            + "; ".join(
                f"quantity {t['quantity']} returns {t['effective_rtp_percent']}%"
                for t in out_of_band
            )
            + f". The agreed band is {percent(band_min)}–{percent(band_max)}%. "
            "Fix the table or move the band, and the band moves on a signed card "
            "like everything else here."
        )

    # ── 8B.10.4 — a larger stake must never be worse value ───────────────────
    override = draft.get("regression_override")
    override = override if isinstance(override, Mapping) else {}
    override_reason = str(override.get("reason") or "").strip()
    if regressions:
        if override.get("allowed") and len(override_reason) >= MIN_REASON:
            flags.append(
                "Effective RTP falls as stake rises. Overridden by owner: "
                f"{override_reason} ({'; '.join(regressions)})"
            )
        else:
            blocked.append(
                "Blocked by 8B.10.4 — a larger stake tier returns a lower RTP "
                "than a smaller one: "
                + "; ".join(regressions)
                + ". Whales generate most of the revenue and this gives them the "
                "worst odds in the product. Fix it, or set `regression_override` "
                "with a reason an owner is prepared to sign."
            )

    # ── 8B.2.6 — the cap, and whether it bites ───────────────────────────────
    top_multiplier = max(o.multiplier_bp for o in outcomes)
    for tier in tiers:
        headline = tier["max_total_stake"] * top_multiplier // MULTIPLIER_ONE
        if basis is MultiplierBasis.UNIT_STAKE:
            headline = stake["max_stake"] * top_multiplier // MULTIPLIER_ONE
        if headline > max_single_win:
            flags.append(
                f"At quantity {tier['quantity']} and the top stake, the table's "
                f"{_trim(Decimal(top_multiplier) / MULTIPLIER_ONE)}× would pay "
                f"{headline:,} diamonds and the cap pays {max_single_win:,}. The "
                "advertised top multiplier is not payable at that stake — "
                "intended or not, players will notice."
            )
            break

    # ── 8B.11.4 — the shape of the distribution ──────────────────────────────
    if zero_back >= 500_000:
        flags.append(
            f"{percent(zero_back)}% of rolls return nothing. 8B.11.4 names this "
            "as the profile that produces burnout and complaints: more small "
            "wins at the same edge sustains longer play and earns more."
        )

    # ── 8B.4.3 / 8B.4.4 — the reserve and the ceilings ───────────────────────
    #
    # Evaluated here, on the same card, from the same table. The variance the
    # guidance is priced from is the variance of the odds being signed, so the
    # reserve and the odds can never be approved against different assumptions.
    exposure, exposure_flags, exposure_blocked = _exposure_rules(
        draft.get("exposure"),
        max_single_win=max_single_win,
        outcomes=outcomes,
        top_stake=stake["max_stake"] * max(quantities),
    )
    flags.extend(exposure_flags)
    blocked.extend(exposure_blocked)

    # ── 8B.0.4 / 8B.14 — where it would be live ──────────────────────────────
    if not countries:
        flags.append(
            "No country is enabled, so this mechanic will be invisible "
            "everywhere. That is a valid configuration and it is the default."
        )

    return {
        "outcomes": [o.as_dict() for o in outcomes],
        "outcome_count": len(outcomes),
        "probability_total_ppm": sum(o.probability_ppm for o in outcomes),
        "probability_total_percent": "100",
        "rtp_ppm": table_rtp,
        "rtp_percent": percent(table_rtp),
        "rtp_exact": rtp_numerator(outcomes) % MULTIPLIER_ONE == 0,
        "rtp_numerator": rtp_numerator(outcomes),
        "rtp_scale": RTP_SCALE,
        "house_edge_ppm": PROBABILITY_TOTAL - table_rtp,
        "house_edge_percent": percent(PROBABILITY_TOTAL - table_rtp),
        "win_probability_ppm": PROBABILITY_TOTAL - nothing_back,
        "win_probability_percent": percent(PROBABILITY_TOTAL - nothing_back),
        "nothing_back_probability_ppm": zero_back,
        "nothing_back_probability_percent": percent(zero_back),
        "multiplier_basis": str(basis),
        "stake": stake,
        "quantity_tiers": quantities,
        "tiers": tiers,
        "max_single_win": max_single_win,
        "exposure": exposure,
        "enabled_countries": countries,
        "rtp_band": {
            "min_ppm": band_min,
            "max_ppm": band_max,
            "min_percent": percent(band_min),
            "max_percent": percent(band_max),
        },
        "deliberate_lower_return_on_larger_plays": deliberate,
        "lower_return_statement": deliberate_reason,
        "regression_override": (
            {"allowed": bool(override.get("allowed")), "reason": override_reason}
            if override
            else {"allowed": False, "reason": ""}
        ),
        "provider": _provider(draft.get("provider")),
        "flags": flags,
        "blocked": bool(blocked),
        "blocked_reasons": blocked,
        "rounding_note": (
            "A payout is total stake × multiplier in basis points, floored to a "
            "whole diamond, then capped at the maximum single win. The floor "
            "costs a player at most one diamond per round and is why the "
            "realised RTP at very small stakes is fractionally below the figure "
            "above."
        ),
    }


def _basis(raw: Any) -> MultiplierBasis:
    try:
        return MultiplierBasis(str(raw))
    except ValueError as exc:
        raise ChanceError(
            f"'{raw}' is not a multiplier basis. Use "
            f"'{MultiplierBasis.TOTAL_STAKE}' or '{MultiplierBasis.UNIT_STAKE}'."
        ) from exc


def _provider(raw: Any) -> dict | None:
    """A third-party game's settlement identity. Spec 8B.1.4.

    Never a URL we call and never a secret. The name selects the shared key
    from the environment, and the key id is what a rotation moves. What a
    provider has to supply to be integrated is listed in
    `settle_external_round`.
    """
    if not raw:
        return None
    if not isinstance(raw, Mapping):
        raise ChanceError("A provider block is a mapping, or absent.")
    name = str(raw.get("name") or "").strip().lower()
    if not re.match(r"^[a-z][a-z0-9_]{1,31}$", name):
        raise ChanceError(
            f"'{raw.get('name')}' is not a provider name. Lower case letters, "
            "digits and underscores; it selects the shared signing key."
        )
    key_id = str(raw.get("signing_key_id") or "").strip()
    if not key_id:
        raise ChanceError(
            "A provider must name the signing key id its callbacks are signed "
            "with, so a rotation is visible in the configuration rather than "
            "only in an environment variable."
        )
    return {"name": name, "signing_key_id": key_id}


# ══════════════════════════════════════════════════════════════════════════════
#  Mechanics and configuration versions
# ══════════════════════════════════════════════════════════════════════════════


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public(doc: Mapping) -> dict:
    out = dict(doc)
    if "_id" in out:
        out["id"] = str(out.pop("_id"))
    out.pop("server_seed", None)  # never leaves this module by accident
    return out


def _reason(raw: str) -> str:
    text = (raw or "").strip()
    if len(text) < MIN_REASON:
        raise ChanceError(
            f"A reason of at least {MIN_REASON} characters is required. Every "
            "change to a chance mechanic is a change to money (8B.2.8), and a "
            "money change with no stated reason is not auditable."
        )
    return text


def _mechanic_id(raw: str) -> str:
    text = str(raw or "").strip().lower()
    if not MECHANIC_ID_PATTERN.match(text):
        raise ChanceError(
            f"'{raw}' is not a mechanic id. Lower case letters, digits and "
            "underscores, 3–64 characters, e.g. 'lucky_gift_tier_1'."
        )
    return text


async def create_mechanic(
    *,
    mechanic_id: str,
    kind,
    name: str,
    reason: str,
    actor: dict,
) -> dict:
    """Bring a mechanic into existence, switched off.

    No odds, no countries, no money — those arrive with its first configuration
    version, on a card an owner signs. So this is a team action rather than a
    signed one, and what it creates cannot be played anywhere: `live_version` is
    None, which every read path treats as "does not exist" for a player.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    reason = _reason(reason)
    try:
        kind = MechanicKind(str(kind))
    except ValueError as exc:
        allowed = ", ".join(str(k) for k in MechanicKind)
        raise ChanceError(f"'{kind}' is not a mechanic kind. One of: {allowed}.") from exc

    label = str(name or "").strip()
    if not label:
        raise ChanceError("A mechanic needs a name people will recognise.")

    doc = {
        "_id": mechanic_id,
        "kind": str(kind),
        "name": label,
        "live_version": None,
        # 8B.4.5. Absent and None mean the same thing everywhere this is read,
        # so a mechanic created before this field existed is not suspended.
        "suspended": None,
        "created_at": _now(),
        "created_by": {
            "uid": actor.get("uid", ""),
            "name": actor.get("name", ""),
            "role": str(actor.get("role", "")),
        },
        "updated_at": _now(),
    }
    try:
        await get_db()[C.CHANCE_MECHANICS].insert_one(doc)
    except DuplicateKeyError as exc:
        raise ChanceError(f"A mechanic called '{mechanic_id}' already exists.") from exc

    await audit.record(
        actor=actor,
        action=Act.MECHANIC_CREATED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        after={"kind": str(kind), "name": label, "live_version": None},
        meta={
            "live": False,
            "note": (
                "Created disabled and with no configuration. It is invisible in "
                "every country until an owner signs a configuration version."
            ),
        },
    )
    return _public(doc)


async def get_mechanic(mechanic_id: str) -> dict:
    doc = await get_db()[C.CHANCE_MECHANICS].find_one({"_id": _mechanic_id(mechanic_id)})
    if doc is None:
        raise MechanicUnavailable("No such mechanic.")
    return _public(doc)


async def list_mechanics() -> list[dict]:
    """Every mechanic, live or not, with its live configuration summarised.

    Internal. The player-facing question is `visible_mechanics`, which is a
    different function on purpose — this one names things that are switched off,
    and that is exactly what must never reach a market they are switched off in.
    """
    out: list[dict] = []
    async for doc in get_db()[C.CHANCE_MECHANICS].find({}).sort("_id", 1):
        entry = _public(doc)
        version = doc.get("live_version")
        suspended = doc.get("suspended")
        # `live` is what a player would experience, so a suspended mechanic is
        # not live however signed its configuration is. The two facts are kept
        # apart underneath it, because "signed but stopped" and "never
        # configured" are entirely different problems on an owner's screen.
        entry["configured"] = version is not None
        entry["suspended"] = suspended
        entry["live"] = version is not None and not suspended
        entry["live_config"] = None
        if version is not None:
            config = await _config(doc["_id"], int(version))
            entry["live_config"] = _config_summary(config)
        out.append(entry)
    return out


def _config_summary(config: Mapping) -> dict:
    evaluation = config.get("evaluation") or {}
    return {
        "version": config.get("version"),
        "status": config.get("status"),
        "rtp_ppm": evaluation.get("rtp_ppm"),
        "rtp_percent": evaluation.get("rtp_percent"),
        "house_edge_percent": evaluation.get("house_edge_percent"),
        "max_single_win": evaluation.get("max_single_win"),
        # 8B.4.2 — the portal shows the ceilings beside the odds, because the
        # two together are the exposure and neither means much alone.
        "exposure": evaluation.get("exposure"),
        "enabled_countries": evaluation.get("enabled_countries"),
        "multiplier_basis": evaluation.get("multiplier_basis"),
        "tiers": evaluation.get("tiers"),
        "flags": evaluation.get("flags"),
        "effective_from": config.get("effective_from"),
        "card_id": config.get("card_id"),
        "signed_by": config.get("signed_by"),
    }


async def _config(mechanic_id: str, version: int) -> dict:
    doc = await get_db()[C.CHANCE_CONFIGS].find_one(
        {"mechanic_id": mechanic_id, "version": int(version)}
    )
    if doc is None:
        raise ChanceError(f"{mechanic_id} has no configuration version {version}.")
    return doc


async def config_version(mechanic_id: str, version: int) -> dict:
    return _public(await _config(_mechanic_id(mechanic_id), int(version)))


async def config_history(mechanic_id: str, limit: int = 100) -> list[dict]:
    """Every version ever written, newest first. Spec 8B.14.5.

    Nothing is deleted and nothing is edited, so this is the answer to "when did
    this mechanic become available in that market, and who signed it" without
    anybody having to reconstruct it from the audit log.
    """
    cursor = (
        get_db()[C.CHANCE_CONFIGS]
        .find({"mechanic_id": _mechanic_id(mechanic_id)})
        .sort("version", -1)
        .limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]


async def live_config(mechanic_id: str) -> dict:
    """The configuration in force, or a refusal that says nothing more."""
    mechanic = await get_mechanic(mechanic_id)
    version = mechanic.get("live_version")
    if version is None:
        raise MechanicUnavailable("No such mechanic.")
    return await _config(mechanic["id"], int(version))


async def visible_mechanics(country: str) -> list[dict]:
    """What a player in this country may see. Spec 8B.0.7 / 8B.14.3.

    The whole of "invisible, not blocked" on the API's side. A mechanic not
    enabled here contributes **nothing** to this list — not a disabled entry,
    not a placeholder, not a different total. The response to a player in a
    market where every mechanic is switched off is identical to the response in
    a market where none was ever built.

    The published odds ride along, because 0.5.3 guarantees a user the stated
    odds of any chance mechanic they take part in, and the odds a player is
    shown must come from the same record the draw uses.
    """
    code = str(country or "").strip().upper()
    if not COUNTRY_PATTERN.match(code):
        raise ChanceError("A country is an ISO 3166-1 alpha-2 code, e.g. 'IN'.")

    out: list[dict] = []
    async for mechanic in get_db()[C.CHANCE_MECHANICS].find(
        {"live_version": {"$ne": None}}
    ):
        version = mechanic.get("live_version")
        if version is None:
            continue
        # 8B.4.5 — a suspended mechanic contributes nothing to this list, in
        # exactly the way a mechanic disabled for this country contributes
        # nothing. A player learns that it has stopped paying only by its
        # absence, which is the same thing they would learn if it had never
        # been built here. Telling them "temporarily unavailable" would say the
        # business is in trouble on this mechanic, to everyone, at once.
        if mechanic.get("suspended"):
            continue
        config = await _config(mechanic["_id"], int(version))
        evaluation = config.get("evaluation") or {}
        if code not in (evaluation.get("enabled_countries") or []):
            continue
        out.append(
            {
                "mechanic_id": mechanic["_id"],
                "kind": mechanic.get("kind"),
                "name": mechanic.get("name"),
                "config_version": int(version),
                "stake": evaluation.get("stake"),
                "quantity_tiers": evaluation.get("quantity_tiers"),
                "max_single_win": evaluation.get("max_single_win"),
                "multiplier_basis": evaluation.get("multiplier_basis"),
                # 0.5.3 — the published odds, exactly as configured.
                "outcomes": evaluation.get("outcomes"),
                "rtp_percent": evaluation.get("rtp_percent"),
            }
        )
    out.sort(key=lambda entry: entry["mechanic_id"])
    return out


# ── Changing a configuration is a card ────────────────────────────────────────


async def propose_config(
    *,
    mechanic_id: str,
    draft: Mapping,
    reason: str,
    actor: dict,
) -> dict:
    """Raise the card that changes a mechanic's configuration. Spec 8B.2.8.

    **Why a new card type rather than `RATE_CHANGE` or `PRICING_CHANGE`.**
    Both of those already exist and either would have carried the five stages
    correctly, so the argument is not about the stage machine — it is about what
    the board and the reports do with `type`. `RATE_CHANGE` is what an agency's
    commission slab table moves on and `PRICING_CHANGE` is what a diamond pack
    costs; both are partner-facing, both are quoted in statements, and the P&L
    already groups cards by type over a window on a dedicated index. An odds
    table, a country list and a payout ceiling are none of those things. Filed
    as a rate change, "show me every rate change this quarter" starts returning
    probability tables, and the question a regulator actually asks — "show me
    every change to the Indian country list for this mechanic, and who signed
    each one" — becomes a string search inside payloads. One new type
    (`CardType.CHANCE_CONFIG_CHANGE`), one board filter, and the five stages,
    the separation of duties and the audit trail are all inherited unchanged.

    **Why the card's amount is the maximum single win.** A card carries one
    number, and `raise_card` refuses a zero. The honest number for a
    configuration change is the largest amount the business can be asked to pay
    on one round under it (8B.2.6) — the owner signing is signing that
    exposure. The full evaluation, including RTP per tier, travels in the
    payload and is on the card in front of them.

    Nothing here is live. The draft is written as a version in `draft` status
    and becomes the live one only in `activate_config`, after a second person
    has verified and an owner has signed.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    reason = _reason(reason)
    mechanic = await get_mechanic(mechanic_id)

    evaluation = evaluate_draft(draft)
    if evaluation["blocked"]:
        # 8B.3.4 — flagged *and* blocked from going live. The flags are on the
        # exception rather than in a log, so the portal shows the person who
        # wrote the table exactly why it will not ship.
        raise ConfigBlocked(
            "This configuration cannot go live:\n  · "
            + "\n  · ".join(evaluation["blocked_reasons"]),
            evaluation["blocked_reasons"],
        )

    current = None
    if mechanic.get("live_version") is not None:
        current = await _config(mechanic_id, int(mechanic["live_version"]))

    version = await _next_version(mechanic_id)
    changes = _changes(current, evaluation)

    card = await _raise_card(
        NewCard(
            type=CardType.CHANCE_CONFIG_CHANGE,
            # The App team owns the app admin portal (Part 8), so this is its
            # board. Verification therefore falls to the App admin, Finance or
            # an owner — and never to whoever wrote the table.
            team=Team.APP,
            title=(
                f"{mechanic['name']} — configuration v{version}: RTP "
                f"{evaluation['rtp_percent']}%, max single win "
                f"{evaluation['max_single_win']:,} diamonds, "
                f"{len(evaluation['enabled_countries'])} market(s)"
            ),
            amount=evaluation["max_single_win"],
            currency=str(Currency.DIAMONDS),
            reason=reason,
            subject_type="chance_mechanic",
            subject_id=mechanic_id,
            payload={
                "mechanic_id": mechanic_id,
                "mechanic_name": mechanic["name"],
                "version": version,
                "previous_version": mechanic.get("live_version"),
                "evaluation": evaluation,
                "changes": changes,
                # Stated on the card so nobody has to infer it from the type.
                "note": (
                    "Signing this makes version "
                    f"{version} the configuration every new round is drawn "
                    "from. Rounds already committed keep the version they were "
                    "committed against."
                ),
            },
            auto_verified=False,
        ),
        actor,
    )

    doc = {
        "mechanic_id": mechanic_id,
        "version": version,
        "status": str(ConfigStatus.DRAFT),
        "evaluation": evaluation,
        "changes": changes,
        "card_id": card["id"],
        "reason": reason,
        "proposed_by": {
            "uid": actor.get("uid", ""),
            "name": actor.get("name", ""),
            "role": str(actor.get("role", "")),
        },
        "proposed_at": _now(),
        "effective_from": None,
        "signed_by": None,
        "signed_at": None,
        "superseded_at": None,
        "authority": "card",
    }
    try:
        await get_db()[C.CHANCE_CONFIGS].insert_one(doc)
    except DuplicateKeyError as exc:
        raise ChanceError(
            f"Version {version} of {mechanic_id} is already being changed. Let "
            "the card in flight be signed or rejected first — two drafts of one "
            "version is two owners signing different tables."
        ) from exc

    await audit.record(
        actor=actor,
        action=Act.CONFIG_CHANGED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        before=_config_summary(current) if current else None,
        after={
            "version": version,
            "status": str(ConfigStatus.DRAFT),
            "rtp_percent": evaluation["rtp_percent"],
            "max_single_win": evaluation["max_single_win"],
            "enabled_countries": evaluation["enabled_countries"],
        },
        card_id=card["id"],
        meta={"changes": changes, "live": False},
    )

    return {"card": card, "config": _public(doc)}


async def _next_version(mechanic_id: str) -> int:
    latest = await get_db()[C.CHANCE_CONFIGS].find_one(
        {"mechanic_id": mechanic_id}, sort=[("version", -1)]
    )
    return int(latest["version"]) + 1 if latest else 1


def _changes(current: Mapping | None, evaluation: Mapping) -> list[dict]:
    """What an owner is actually being asked to approve.

    A diff rather than a second copy of the table, because the failure mode of a
    configuration card is an owner signing three hundred lines of JSON that
    differ from the live ones in one probability.
    """
    if not current:
        return [
            {
                "field": "configuration",
                "before": None,
                "after": "first version",
                "note": "The mechanic has never been live.",
            }
        ]
    previous = current.get("evaluation") or {}
    out: list[dict] = []
    comparisons = (
        ("rtp_percent", "Return to player"),
        ("house_edge_percent", "House edge"),
        ("max_single_win", "Maximum single win"),
        ("enabled_countries", "Enabled countries"),
        ("multiplier_basis", "Multiplier applies to"),
        ("outcome_count", "Number of outcomes"),
        ("quantity_tiers", "Quantity tiers"),
        ("stake", "Stake denominations"),
    )
    for field, label in comparisons:
        before, after = previous.get(field), evaluation.get(field)
        if before != after:
            out.append({"field": field, "label": label, "before": before, "after": after})

    before_table = [
        (o["multiplier_bp"], o["probability_ppm"]) for o in previous.get("outcomes") or []
    ]
    after_table = [
        (o["multiplier_bp"], o["probability_ppm"]) for o in evaluation.get("outcomes") or []
    ]
    if before_table != after_table:
        out.append(
            {
                "field": "outcomes",
                "label": "Outcome table",
                "before": before_table,
                "after": after_table,
            }
        )

    # 8B.4.3 / 8B.4.4 — the reserve and each ceiling as their own diff lines.
    # Folded into one "exposure changed" row they would be a blob an owner
    # scrolls past; a reserve halving is the single most consequential edit
    # this card can carry and it gets its own line.
    before_exposure = previous.get("exposure") or {}
    after_exposure = evaluation.get("exposure") or {}
    for field, label in (
        ("reserve_diamonds", "Reserve"),
        ("reserve_basis", "How the reserve was modelled"),
        ("max_payout_per_round", "Ceiling — payout per round"),
        ("max_payout_per_player_per_day", "Ceiling — per player per day"),
        ("max_payout_platform_per_day", "Ceiling — platform per day"),
    ):
        before, after = before_exposure.get(field), after_exposure.get(field)
        if before != after:
            out.append(
                {
                    "field": f"exposure.{field}",
                    "label": label,
                    "before": before,
                    "after": after,
                }
            )
    return out


async def _raise_card(card: NewCard, actor: dict) -> dict:
    try:
        return await card_svc.raise_card(card, actor)
    except CardError as exc:
        raise ChanceError(str(exc)) from exc


async def activate_config(card_id: str, actor: dict) -> dict:
    """Make a signed configuration the live one. Owners only.

    The last of the five stages, and it is the money board's own rule that gets
    it here: this refuses anything not already in Approved, so the card was
    raised by one person, verified by a second and signed by an owner who was
    neither. Nothing in this module can move a card between stages — that lives
    in `services/cards.py` and there is one implementation of it.

    The evaluation is **re-run** here rather than trusted from the payload. The
    table has not changed (the version is immutable), but the code that judges
    it may have: if the band, the regression rule or the probability check has
    tightened since the card was raised, a configuration that would now be
    blocked does not slip through on a signature obtained under the old rules.
    """
    card = await _signed_card(card_id)
    payload = card.get("payload") or {}
    mechanic_id = str(payload.get("mechanic_id") or "")
    version = int(payload.get("version") or 0)

    config = await _config(mechanic_id, version)
    if config["status"] != str(ConfigStatus.DRAFT):
        raise ChanceError(
            f"Version {version} of {mechanic_id} is {config['status']}, not a "
            "draft awaiting activation."
        )

    mechanic = await get_mechanic(mechanic_id)
    live = mechanic.get("live_version")
    if live is not None and int(live) >= version:
        raise ChanceError(
            f"{mechanic_id} is already on version {live}. Version {version} was "
            "signed against an older state; raise the change again from where "
            "the mechanic actually is."
        )

    evaluation = evaluate_draft(_draft_from(config))
    if evaluation["blocked"]:
        raise ConfigBlocked(
            "This configuration is signed but cannot go live:\n  · "
            + "\n  · ".join(evaluation["blocked_reasons"]),
            evaluation["blocked_reasons"],
        )

    now = _now()
    db = get_db()
    # The signature on a version is the **owner who signed the card**, not
    # whoever pressed activate. They are usually different people and the
    # regulator's question is about the first (8B.14.4 / 8B.2.8); recording the
    # second in that field would put the wrong name against the decision.
    signer = card.get("signed_by") or {}
    activator = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }

    await db[C.CHANCE_CONFIGS].update_many(
        {
            "mechanic_id": mechanic_id,
            "status": str(ConfigStatus.LIVE),
        },
        {"$set": {"status": str(ConfigStatus.SUPERSEDED), "superseded_at": now}},
    )
    await db[C.CHANCE_CONFIGS].update_one(
        {"mechanic_id": mechanic_id, "version": version},
        {
            "$set": {
                "status": str(ConfigStatus.LIVE),
                "evaluation": evaluation,
                "effective_from": now,
                "signed_by": signer,
                "signed_at": card.get("signed_at") or now,
                "activated_by": activator,
                "activated_at": now,
            }
        },
    )
    await db[C.CHANCE_MECHANICS].update_one(
        {"_id": mechanic_id},
        {"$set": {"live_version": version, "updated_at": now}},
    )

    await audit.record(
        actor=actor,
        action=Act.CONFIG_CHANGED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=card.get("reason") or "Chance configuration activated",
        before={"live_version": live},
        after={
            "live_version": version,
            "rtp_percent": evaluation["rtp_percent"],
            "max_single_win": evaluation["max_single_win"],
            "enabled_countries": evaluation["enabled_countries"],
        },
        card_id=card_id,
        meta={
            "changes": config.get("changes"),
            "live": True,
            "markets": evaluation["enabled_countries"],
            "signed_by": signer.get("uid"),
            "activated_by": activator["uid"],
        },
    )

    try:
        await card_svc.mark_executed(
            card_id,
            actor,
            {
                "mechanic_id": mechanic_id,
                "version": version,
                "effective_from": now,
                "rtp_percent": evaluation["rtp_percent"],
                "enabled_countries": evaluation["enabled_countries"],
            },
            True,
        )
    except CardError as exc:
        raise ChanceError(str(exc)) from exc

    return _public(await _config(mechanic_id, version))


def _draft_from(config: Mapping) -> dict:
    """A stored version turned back into the draft it was written from."""
    evaluation = config.get("evaluation") or {}
    return {
        "outcomes": [
            {
                "multiplier_bp": o["multiplier_bp"],
                "probability_ppm": o["probability_ppm"],
            }
            for o in evaluation.get("outcomes") or []
        ],
        "multiplier_basis": evaluation.get("multiplier_basis"),
        "stake": evaluation.get("stake"),
        "quantity_tiers": evaluation.get("quantity_tiers"),
        "enabled_countries": evaluation.get("enabled_countries"),
        "max_single_win": evaluation.get("max_single_win"),
        "rtp_band": {
            "min_ppm": (evaluation.get("rtp_band") or {}).get("min_ppm"),
            "max_ppm": (evaluation.get("rtp_band") or {}).get("max_ppm"),
        },
        "deliberate_lower_return_on_larger_plays": evaluation.get(
            "deliberate_lower_return_on_larger_plays"
        ),
        "lower_return_statement": evaluation.get("lower_return_statement"),
        "regression_override": evaluation.get("regression_override"),
        "provider": evaluation.get("provider"),
        # 8B.4.3 / 8B.4.4. Only the *configured* keys travel: the sigma, the
        # variance and the guidance are derived from the table and are
        # recomputed, never carried, so a re-evaluation cannot inherit a stale
        # figure from the version it is re-reading.
        "exposure": _exposure_draft(evaluation.get("exposure")),
    }


def _exposure_draft(exposure: Any) -> dict:
    exposure = exposure if isinstance(exposure, Mapping) else {}
    out = {
        key: exposure.get(key)
        for key in (
            "max_payout_per_player_per_day",
            "max_payout_platform_per_day",
            "reserve_diamonds",
            "reserve_basis",
        )
    }
    # A per-round ceiling that was never configured defaulted to the maximum
    # single win. Writing it back as though it had been typed would turn a
    # default into a decision, and the two are different things on a card.
    if exposure.get("max_payout_per_round_source") == "configured":
        out["max_payout_per_round"] = exposure.get("max_payout_per_round")
    return out


async def _signed_card(card_id: str) -> dict:
    from bson import ObjectId

    try:
        oid = ObjectId(card_id)
    except Exception as exc:  # noqa: BLE001
        raise ChanceError("Configuration card not found.") from exc

    doc = await get_db()[C.CARDS].find_one({"_id": oid})
    if doc is None:
        raise ChanceError("Configuration card not found.")
    if doc.get("type") != str(CardType.CHANCE_CONFIG_CHANGE):
        raise ChanceError(
            f"Card {card_id} is a {doc.get('type')} card, not a chance "
            "configuration change."
        )
    if doc.get("stage") == str(Stage.EXECUTED):
        raise ChanceError("This configuration has already been made live.")
    if doc.get("stage") != str(Stage.APPROVED):
        raise ChanceError(
            f"Card is {doc.get('stage')}. Only a configuration an owner has "
            "signed can be made live (8B.2.8)."
        )
    return doc


async def withdraw_country(
    *, mechanic_id: str, country: str, reason: str, actor: dict
) -> dict:
    """Remove one market immediately. Owner only. Spec 8B.0.4 / 8B.14.1.

    **The one asymmetry in the signing rule, and why it is there.** 8B.2.8 says
    every configuration change is signed and versioned, and 8B.14.4 says every
    enable and disable is signed, dated and logged. A card satisfies both — but
    a card needs a second person to verify it before an owner can sign, and
    8B.0.4 asks for a market that can be switched off *in seconds*, which is
    what counsel calling on a Tuesday afternoon about the Online Gaming Act
    actually requires.

    So: **removing** a country is a single owner signature, applied at once.
    **Adding** one is a full card, always. The asymmetry is safe in one
    direction only — a withdrawal makes something less available and can never
    make a mechanic playable where it was not — and it is not an exception to
    versioning: this writes a new immutable version like any other change,
    carries the owner's signature and a mandatory reason, and appears in the
    history beside the cards (8B.14.5).

    Balances are untouched. Rounds already committed in that market are refused
    at play time by the live-country check in `play_round`, which is deliberate:
    the regulatory switch is not something a round in flight may outlive.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    reason = _reason(reason)
    code = str(country or "").strip().upper()
    if not COUNTRY_PATTERN.match(code):
        raise ChanceError("A country is an ISO 3166-1 alpha-2 code, e.g. 'IN'.")

    config = await live_config(mechanic_id)
    evaluation = config["evaluation"]
    if code not in (evaluation.get("enabled_countries") or []):
        raise ChanceError(
            f"{mechanic_id} is not enabled in {code}, so there is nothing to "
            "withdraw."
        )

    draft = _draft_from(config)
    draft["enabled_countries"] = [
        c for c in evaluation["enabled_countries"] if c != code
    ]
    new_evaluation = evaluate_draft(draft)

    version = await _next_version(mechanic_id)
    now = _now()
    signer = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }
    doc = {
        "mechanic_id": mechanic_id,
        "version": version,
        "status": str(ConfigStatus.LIVE),
        "evaluation": new_evaluation,
        "changes": _changes(config, new_evaluation),
        "card_id": None,
        "reason": reason,
        "proposed_by": signer,
        "proposed_at": now,
        "effective_from": now,
        "signed_by": signer,
        "signed_at": now,
        "superseded_at": None,
        # Named on the record itself so a reader never has to work out why this
        # one version has no card behind it.
        "authority": "owner_emergency_withdrawal",
        "withdrew_country": code,
    }

    db = get_db()
    try:
        await db[C.CHANCE_CONFIGS].insert_one(doc)
    except DuplicateKeyError as exc:
        raise ChanceError(
            "Another change to this mechanic is in flight. Try again."
        ) from exc

    await db[C.CHANCE_CONFIGS].update_many(
        {
            "mechanic_id": mechanic_id,
            "status": str(ConfigStatus.LIVE),
            "version": {"$lt": version},
        },
        {"$set": {"status": str(ConfigStatus.SUPERSEDED), "superseded_at": now}},
    )
    await db[C.CHANCE_MECHANICS].update_one(
        {"_id": mechanic_id},
        {"$set": {"live_version": version, "updated_at": now}},
    )

    await audit.record(
        actor=actor,
        action=Act.CONFIG_CHANGED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        before={"enabled_countries": evaluation["enabled_countries"]},
        after={"enabled_countries": new_evaluation["enabled_countries"]},
        meta={
            "withdrew_country": code,
            "version": version,
            "authority": "owner_emergency_withdrawal",
            "note": (
                "Immediate withdrawal by an owner under 8B.0.4. Adding a market "
                "back requires a full card."
            ),
        },
    )
    return _public(doc)


# ══════════════════════════════════════════════════════════════════════════════
#  Rounds
# ══════════════════════════════════════════════════════════════════════════════


def strip_client_claims(body: Mapping) -> tuple[dict, list[str]]:
    """Remove anything in a request that claims to know an outcome.

    Spec 8B.1.2 and 8B.1.3, enforced as data rather than as a convention: the
    fields never reach the code that computes anything, so no later change to
    this module can accidentally start reading one.
    """
    claims = sorted(k for k in body if k in CLIENT_CLAIM_FIELDS)
    return {k: v for k, v in body.items() if k not in CLIENT_CLAIM_FIELDS}, claims


async def commit_round(
    *,
    mechanic_id: str,
    player_uid: str,
    country: str,
    actor: dict,
) -> dict:
    """Publish the commitment for a round that has not been played. Spec 8B.1.6.

    Nothing is staked and no balance moves here. What comes back is the hash of
    a seed this server has already drawn and stored, the nonce, the exact odds
    table the round will be drawn from, and the configuration version those odds
    belong to. The player can record all of it before deciding to play.

    The version is pinned **now**, not at play time. A player is entitled to the
    odds they were shown; a table signed thirty seconds later applies to the
    next round, exactly as a commission rate change applies forward only
    (0.1.3 / 9.8).
    """
    mechanic_id = _mechanic_id(mechanic_id)
    code = str(country or "").strip().upper()
    if not COUNTRY_PATTERN.match(code):
        raise ChanceError("A country is an ISO 3166-1 alpha-2 code, e.g. 'IN'.")
    player = str(player_uid or "").strip()
    if not player:
        raise ChanceError("A round belongs to a player.")

    # 8B.5.4 — a frozen player opens nothing. Checked before the commitment is
    # drawn rather than at play time, so a frozen account never receives a seed
    # hash it could hold and play the moment a review clears it.
    await refuse_if_frozen(player)

    # 8B.6.2 — a player who asked us to stop them is not handed a commitment, an
    # odds table and a round id to be refused on later. The loss limits cannot
    # be checked here (no stake is named at commit time); `gate_play` does that.
    # Imported inside the function so `player_protection` — which reads this
    # module's `chance_rounds` — is not a circular import at module scope.
    from app.services import player_protection

    await player_protection.gate_commit(player_uid=player)

    config = await _live_config_for(mechanic_id, code)
    evaluation = config["evaluation"]

    seed = new_seed()
    round_id = secrets.token_hex(16)
    nonce = secrets.token_hex(8)
    now = _now()

    doc = {
        "round_id": round_id,
        "mechanic_id": mechanic_id,
        "config_version": int(config["version"]),
        "player_uid": player,
        "country": code,
        "status": str(RoundStatus.COMMITTED),
        # The seed is stored now and revealed after the draw. It is stripped
        # from every read path except the fairness proof of a settled round —
        # `_public` drops it, and `round_record` drops it while the round is
        # still unplayed.
        "server_seed": seed.hex(),
        "server_seed_hash": seed_hash(seed),
        "nonce": nonce,
        "client_entropy": None,
        "committed_at": now,
        "played_at": None,
        "settled_at": None,
        "unit_stake": None,
        "quantity": None,
        "total_stake": None,
        "outcome_index": None,
        "multiplier_bp": None,
        "payout": None,
        "uncapped_payout": None,
        "capped": False,
        "stake_ledger_id": None,
        "payout_ledger_id": None,
        "client_claims_ignored": [],
        "committed_by": {
            "uid": actor.get("uid", ""),
            "name": actor.get("name", ""),
            "role": str(actor.get("role", "")),
        },
    }
    try:
        await get_db()[C.CHANCE_ROUNDS].insert_one(doc)
    except DuplicateKeyError as exc:  # pragma: no cover — 128 bits of round id
        raise RoundError("Could not open a round. Nothing was staked.") from exc

    return {
        "round_id": round_id,
        "mechanic_id": mechanic_id,
        "config_version": int(config["version"]),
        "server_seed_hash": doc["server_seed_hash"],
        "nonce": nonce,
        "commitment": (
            "The result of this round is already determined by a seed drawn "
            "before you played. The SHA-256 of that seed is above. Send any "
            "string as `client_entropy` when you play — it goes into the draw, "
            "so neither side could have chosen its own value knowing the "
            "other's. The seed is revealed when the round settles and can be "
            "checked against this hash."
        ),
        "outcomes": evaluation["outcomes"],
        "rtp_percent": evaluation["rtp_percent"],
        "stake": evaluation["stake"],
        "quantity_tiers": evaluation["quantity_tiers"],
        "max_single_win": evaluation["max_single_win"],
        "committed_at": now,
    }


async def _live_config_for(mechanic_id: str, country: str) -> dict:
    """The live configuration, if this mechanic exists *here* and is running.

    One refusal for "no such mechanic", "not in this market" and "suspended",
    with one message. See `MechanicUnavailable`.

    The third case is the rule the whole of 8B.4.5 rests on: **a suspended
    mechanic pays nothing and accepts nothing**, and says so in the words a
    disabled one uses. There is no state in which a breached mechanic keeps
    drawing rounds, and there is no response from which a player can tell a
    suspension from a market that was never opened.
    """
    try:
        config = await live_config(mechanic_id)
    except ChanceError as exc:
        raise MechanicUnavailable("No such mechanic.") from exc
    mechanic = await get_mechanic(mechanic_id)
    if mechanic.get("suspended"):
        log.warning(
            "chance: %s is suspended; answering as unknown (8B.4.5)", mechanic_id
        )
        raise MechanicUnavailable("No such mechanic.")
    countries = (config.get("evaluation") or {}).get("enabled_countries") or []
    if country not in countries:
        log.info(
            "chance: %s is not enabled in %s; answering as unknown (8B.0.7)",
            mechanic_id,
            country,
        )
        raise MechanicUnavailable("No such mechanic.")
    return config


async def play_round(
    *,
    round_id: str,
    unit_stake: int,
    quantity: int = 1,
    client_entropy: str = "",
    actor: dict,
    claims_ignored: Sequence[str] = (),
) -> dict:
    """Draw, record, then pay. Spec 8B.1.1 – 8B.1.5.

    The order is the specification, not a preference:

      1. the round is claimed atomically, so a replayed request plays nothing
         twice;
      2. the stake is **debited** through the ledger — a round nobody could pay
         for is not a free roll;
      3. the outcome is drawn from the committed seed and the *pinned*
         configuration version;
      4. the whole result is **written down** — stake, outcome, multiplier,
         payout, timestamp, player (8B.1.5);
      5. and only then is the payout credited, through the ledger again.

    Between 4 and 5 a crash leaves a round in `recorded` with a payout owed and
    a ledger idempotency key that has not been used — which is recoverable and
    visible. A crash between 3 and 4 would leave a paid player and no record,
    which is not, and that is the whole reason the write is where it is.
    """
    rid = str(round_id or "").strip()
    quantity = _whole(quantity, "quantity")
    unit_stake = _whole(unit_stake, "unit_stake")
    if quantity < 1:
        raise RoundError("A quantity is at least 1.")
    if unit_stake <= 0:
        raise RoundError("A stake is a positive number of diamonds.")

    db = get_db()
    now = _now()

    # 1. Claim it. `find_one_and_update` on the status is what makes a double
    #    submission — a retried HTTP request, two taps, a replay — play once.
    claimed = await db[C.CHANCE_ROUNDS].find_one_and_update(
        {"round_id": rid, "status": str(RoundStatus.COMMITTED)},
        {"$set": {"status": str(RoundStatus.PLAYING), "played_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        existing = await db[C.CHANCE_ROUNDS].find_one({"round_id": rid})
        if existing is None:
            raise RoundError("No such round.")
        raise RoundError(
            f"Round {rid} is {existing.get('status')} and cannot be played "
            "again. Nothing was staked and nothing was paid."
        )

    mechanic_id = claimed["mechanic_id"]
    pinned_version = int(claimed["config_version"])

    # 8B.5.4 — frozen between the commitment and the play. Nothing was staked,
    # so the round is voided and the balance is untouched.
    try:
        await refuse_if_frozen(claimed["player_uid"])
    except PlayerFrozen:
        await _void(claimed, "The player's chance activity is frozen pending review.", actor)
        raise

    # The **pinned** version decides the odds; the **live** one decides whether
    # this market may play at all. A table change applies forward only, but a
    # country switched off under 8B.0.4 takes effect at once — a round committed
    # a minute before the switch does not get to outlive it.
    try:
        live = await _live_config_for(mechanic_id, claimed["country"])
    except MechanicUnavailable:
        await _void(claimed, "The mechanic is not available in this market.", actor)
        raise
    config = await _config(mechanic_id, pinned_version)
    evaluation = config["evaluation"]

    stake_rules = evaluation["stake"]
    if not permitted_stake(unit_stake, stake_rules):
        await _void(claimed, "Stake outside the permitted denominations.", actor)
        raise RoundError(
            f"A stake of {unit_stake} is not a permitted denomination: "
            f"{stake_rules['min_stake']}–{stake_rules['max_stake']} diamonds in "
            f"steps of {stake_rules['step']} (8B.2.5)."
        )
    if quantity not in evaluation["quantity_tiers"]:
        await _void(claimed, "Quantity outside the permitted tiers.", actor)
        raise RoundError(
            f"A quantity of {quantity} is not a permitted tier: "
            f"{evaluation['quantity_tiers']}."
        )

    total_stake = unit_stake * quantity
    player = claimed["player_uid"]
    reason = (
        f"{mechanic_id} round {rid}: stake {total_stake} diamonds "
        f"({quantity} × {unit_stake}) at configuration v{pinned_version}"
    )

    # 8B.6 — player protection, and the **only** moment it can be enforced: the
    # stake is finally known here and has not yet left the balance. A limit, a
    # self-exclusion or a cooling-off period refuses the round outright, and an
    # unreadable protection store refuses it too (`ProtectionUnavailable` is a
    # `ProtectionBlocked`) — a protection that fails open is not a protection.
    # The round is voided, so nothing is left claimed, and no money has moved in
    # either direction: this stops a play, it never takes or returns a balance.
    from app.services import player_protection

    try:
        await player_protection.gate_play(
            player_uid=player, mechanic_id=mechanic_id, total_stake=total_stake
        )
    except player_protection.ProtectionBlocked:
        await _void(claimed, "Refused by a player-protection control (8B.6).", actor)
        raise

    # 2. The stake leaves the player's balance, through the one write path
    #    there is. This is what puts a stake in the ledger and the audit log
    #    (8B.7.4) — and what refuses the round outright if the balance is not
    #    there, rather than granting a free draw.
    try:
        stake_movement = await apply_movement(
            Movement(
                holder_type=HolderType.USER,
                holder_id=player,
                currency=Currency.DIAMONDS,
                amount=-total_stake,
                action=Act.STAKE,
                reason=reason,
                actor=actor,
                idempotency_key=f"chance:{rid}:stake",
                meta={
                    "mechanic_id": mechanic_id,
                    "round_id": rid,
                    "config_version": pinned_version,
                    "quantity": quantity,
                    "unit_stake": unit_stake,
                    "country": claimed["country"],
                },
            )
        )
    except InsufficientBalance as exc:
        await _void(claimed, "Not enough diamonds for the stake.", actor)
        raise RoundError(
            f"Not enough diamonds: {exc.available} available, {total_stake} "
            "needed. Nothing was staked and no round was played."
        ) from exc
    except DuplicateMovement as exc:  # pragma: no cover — the claim precedes it
        raise RoundError("This round was already staked.") from exc

    # 2a. The stake is exposure the other way up (8B.4.2), and it is what the
    #     reserve is measured against — so it is counted the moment it is taken,
    #     before the draw, and it counts even on a round that pays nothing.
    await _record_stake(
        mechanic_id=mechanic_id, player_uid=player, stake=total_stake, when=now
    )

    # 3. The draw. Derived from the seed committed before the round, the nonce
    #    published with it, and whatever entropy the caller supplied afterwards.
    entropy = str(client_entropy or "")[:256]
    outcomes = parse_outcomes(_draft_from(config)["outcomes"])
    message = draw_message(rid, claimed["nonce"], entropy)
    result = draw(bytes.fromhex(claimed["server_seed"]), message, outcomes)

    basis = _basis(evaluation["multiplier_basis"])
    payable_stake = total_stake if basis is MultiplierBasis.TOTAL_STAKE else unit_stake
    payout, capped, uncapped = payout_for(
        payable_stake, result["multiplier_bp"], evaluation["max_single_win"]
    )

    # 3a. The ceilings and the reserve, consumed atomically before the record is
    #     written and long before anything is credited (8B.4.4 / 8B.4.6). What
    #     comes back is what may actually be paid.
    gate = await _apply_ceilings(
        mechanic_id=mechanic_id,
        player_uid=player,
        payout=payout,
        exposure=evaluation.get("exposure") or {},
        when=now,
        round_id=rid,
        actor=actor,
    )
    ceiling_capped = gate["capped_by_round_ceiling"]
    payout = gate["paid"]

    # 4. Written down BEFORE anything is paid (8B.1.5).
    recorded = {
        "status": str(RoundStatus.RECORDED),
        "client_entropy": entropy,
        "unit_stake": unit_stake,
        "quantity": quantity,
        "total_stake": total_stake,
        "payable_stake": payable_stake,
        "multiplier_basis": str(basis),
        "outcome_index": result["index"],
        "multiplier_bp": result["multiplier_bp"],
        "ticket": result["ticket"],
        "draw_counter": result["counter"],
        "payout": payout,
        "uncapped_payout": uncapped,
        "capped": capped,
        "max_single_win": evaluation["max_single_win"],
        "rtp_ppm_at_play": evaluation["rtp_ppm"],
        # 8B.5.1 — the *variance* of the table this round was drawn from, pinned
        # beside the RTP it was drawn from. Actual-versus-configured needs both:
        # the mean says what was expected and the variance says how far from it
        # is ordinary. Recorded here so a day's figures never have to be joined
        # back to a configuration that may since have been superseded.
        "variance_num_at_play": (evaluation.get("exposure") or {}).get(
            "variance_numerator"
        ),
        "live_version_at_play": int(live["version"]),
        "stake_ledger_id": stake_movement.ledger_id,
        "played_at": now,
        "client_claims_ignored": list(claims_ignored),
        # 8B.4.4 / 8B.4.6 — what the ceilings did to this round. `payout` is
        # what was credited; this is what the table would have paid before any
        # ceiling touched it, because a ceiling that silently rewrites a result
        # is indistinguishable from a mis-set table.
        "payout_before_ceilings": gate["before"],
        "withheld": gate["withheld"],
        "ceiling_capped": ceiling_capped,
        "ceilings_breached": gate["breached"],
        "exposure_day": gate["day"],
    }
    await db[C.CHANCE_ROUNDS].update_one({"round_id": rid}, {"$set": recorded})

    await audit.record(
        actor=actor,
        action=Act.ROUND_RECORDED,
        subject_type="chance_round",
        subject_id=rid,
        reason=reason,
        after={
            "player_uid": player,
            "mechanic_id": mechanic_id,
            "config_version": pinned_version,
            "total_stake": total_stake,
            "multiplier_bp": result["multiplier_bp"],
            "payout": payout,
            "capped": capped,
        },
        meta={
            "country": claimed["country"],
            "server_seed_hash": claimed["server_seed_hash"],
            "outcome_index": result["index"],
            "recorded_before_paid": True,
        },
    )

    if claims_ignored:
        # 8B.1.2 / 8B.1.3 — a caller that sent a result or a winning amount.
        # Silent to it, loud here.
        log.warning(
            "chance: round %s carried client-side outcome fields %s; ignored",
            rid,
            list(claims_ignored),
        )
        await audit.record(
            actor=actor,
            action=Act.CLIENT_CLAIM_IGNORED,
            subject_type="chance_round",
            subject_id=rid,
            reason=(
                "A client sent fields describing an outcome. The server drew and "
                "paid its own result; the fields were discarded (8B.1.2)."
            ),
            meta={"fields": list(claims_ignored), "player_uid": player},
        )

    # 5. Now, and only now, the money.
    payout_ledger_id = None
    if payout > 0:
        payout_movement = await apply_movement(
            Movement(
                holder_type=HolderType.USER,
                holder_id=player,
                currency=Currency.DIAMONDS,
                amount=payout,
                action=Act.PAYOUT,
                reason=(
                    f"{mechanic_id} round {rid}: "
                    f"{_trim(Decimal(result['multiplier_bp']) / MULTIPLIER_ONE)}× "
                    f"on {payable_stake} diamonds"
                    + (" (capped at the maximum single win)" if capped else "")
                ),
                actor=actor,
                idempotency_key=f"chance:{rid}:payout",
                meta={
                    "mechanic_id": mechanic_id,
                    "round_id": rid,
                    "config_version": pinned_version,
                    "multiplier_bp": result["multiplier_bp"],
                    "capped": capped,
                    "uncapped_payout": uncapped,
                },
            )
        )
        payout_ledger_id = payout_movement.ledger_id

    settled_at = _now()
    await db[C.CHANCE_ROUNDS].update_one(
        {"round_id": rid},
        {
            "$set": {
                "status": str(RoundStatus.SETTLED),
                "settled_at": settled_at,
                "payout_ledger_id": payout_ledger_id,
            }
        },
    )

    return {
        "round_id": rid,
        "mechanic_id": mechanic_id,
        "config_version": pinned_version,
        "player_uid": player,
        "country": claimed["country"],
        "unit_stake": unit_stake,
        "quantity": quantity,
        "total_stake": total_stake,
        "outcome_index": result["index"],
        "multiplier_bp": result["multiplier_bp"],
        "multiplier": _trim(Decimal(result["multiplier_bp"]) / MULTIPLIER_ONE),
        "payout": payout,
        "uncapped_payout": uncapped,
        "capped": capped,
        "net": payout - total_stake,
        "settled_at": settled_at,
        "status": str(RoundStatus.SETTLED),
        # The reveal travels with the result, so a player holds everything
        # needed to check the round without a second call and without an
        # account on this API (8B.1.6).
        "fairness": {
            "server_seed": claimed["server_seed"],
            "server_seed_hash": claimed["server_seed_hash"],
            "nonce": claimed["nonce"],
            "client_entropy": entropy,
            "message": message,
            "ticket": result["ticket"],
            "draw_counter": result["counter"],
            "algorithm": result["algorithm"],
            "outcomes": evaluation["outcomes"],
        },
    }


async def _void(round_doc: Mapping, why: str, actor: dict) -> None:
    """A claimed round that never became a play. Nothing was staked."""
    await get_db()[C.CHANCE_ROUNDS].update_one(
        {"round_id": round_doc["round_id"]},
        {"$set": {"status": str(RoundStatus.VOID), "void_reason": why}},
    )
    await audit.record(
        actor=actor,
        action=Act.ROUND_VOID,
        subject_type="chance_round",
        subject_id=str(round_doc["round_id"]),
        reason=why,
        before={"status": str(RoundStatus.COMMITTED)},
        after={"status": str(RoundStatus.VOID)},
        meta={
            "player_uid": round_doc.get("player_uid"),
            "mechanic_id": round_doc.get("mechanic_id"),
            "country": round_doc.get("country"),
        },
    )


async def round_record(round_id: str, reveal: bool = True) -> dict:
    """One round, in full. Spec 8B.5.5.

    The seed is revealed only once the round has settled. Before that it is the
    one field that must not leave this server: a player holding the seed of a
    committed round knows the result of a bet they have not placed yet.
    """
    doc = await get_db()[C.CHANCE_ROUNDS].find_one({"round_id": str(round_id or "")})
    if doc is None:
        raise RoundError("No such round.")
    settled = doc.get("status") == str(RoundStatus.SETTLED)
    seed = doc.get("server_seed")
    out = _public(doc)
    if reveal and settled and seed:
        out["server_seed"] = seed
        out["fairness"] = await fairness_proof(doc)
    else:
        out["server_seed"] = None
        out["seed_note"] = (
            "The seed is revealed when the round settles. Until then only its "
            "hash is published."
        )
    return out


async def fairness_proof(round_doc: Mapping) -> dict:
    """Recheck one settled round against the version it was played on.

    The outcome table is read back out of the immutable configuration version
    the round pinned — not out of a copy stored on the round, and not out of
    whatever is live now. That is the point: if the two ever disagreed, this is
    the function that would say so.
    """
    config = await _config(
        str(round_doc.get("mechanic_id")), int(round_doc.get("config_version") or 0)
    )
    outcomes = parse_outcomes(_draft_from(config)["outcomes"])
    proof = verify_round_outcome(
        seed_hex=str(round_doc.get("server_seed")),
        published_hash=str(round_doc.get("server_seed_hash")),
        round_id=str(round_doc.get("round_id")),
        nonce=str(round_doc.get("nonce")),
        client_entropy=str(round_doc.get("client_entropy") or ""),
        outcomes=outcomes,
        recorded_index=int(round_doc.get("outcome_index") or 0),
    )
    proof["config_version"] = int(round_doc.get("config_version") or 0)
    proof["outcomes"] = [o.as_dict() for o in outcomes]
    proof["nonce"] = round_doc.get("nonce")
    proof["client_entropy"] = round_doc.get("client_entropy")
    proof["server_seed"] = round_doc.get("server_seed")
    return proof


async def player_rounds(player_uid: str, limit: int = 100) -> list[dict]:
    """One player's history, newest first. Spec 8B.5.5.

    Every round is retained; nothing here deletes one. The next task's anomaly
    detection and the reporting task's gross gaming revenue both read this
    collection, which is why the round record carries the country, the
    configuration version and the RTP in force rather than pointers to them.
    """
    cursor = (
        get_db()[C.CHANCE_ROUNDS]
        .find({"player_uid": str(player_uid or "")})
        .sort("played_at", -1)
        .limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]


# ══════════════════════════════════════════════════════════════════════════════
#  Exposure, the reserve, and the ceilings — Part 8B.4
# ══════════════════════════════════════════════════════════════════════════════
#
# 8B.4.6 names the gap this section closes: "the lucky gift payback is created
# on the spot with no reserve and platform cut can go negative". Everything
# above this line bounds **one round** — the odds are signed, the maximum single
# win is absolute, the payout is floored. Nothing above this line bounds a
# thousand rounds, and a mechanic that is correct on every round and ruinous
# over a day is precisely the failure the spec is describing.
#
# ## The model
#
# Two figures, and they are different kinds of thing.
#
#   * **Exposure** (8B.4.2) is a *fact*: total staked against total paid out,
#     per mechanic, live. It is computed from `chance_rounds`, the record every
#     round is written into before it is paid, so it is the same arithmetic a
#     regulator would do by hand from the same rows. Its sign is the house's
#     position: positive is gross gaming revenue (8B.7.1), negative is money the
#     business is down on this mechanic.
#
#   * **The reserve** (8B.4.3) is a *decision*: how far that position is allowed
#     to go negative before the mechanic stops. It is a configured figure inside
#     the signed configuration version, so it moves on a card an owner signs,
#     with a second person verifying, exactly as the odds table does (8B.2.8).
#     `reserve_basis` is mandatory beside it: a reserve with no stated model is a
#     number somebody felt comfortable with, and the next person to feel
#     uncomfortable will change it.
#
# `headroom = reserve + (staked − paid_out)`. A mechanic that has taken more
# than it has paid is running on the house's own winnings and the reserve is
# untouched; one that is behind is spending the reserve. At zero headroom the
# mechanic is loss-making beyond what was budgeted for it, and it stops.
#
# ## Variance is not a breach — 8B.4.1
#
# "Short-run losses are certain and must be planned for, not treated as
# failures." A control that trips on ordinary variance gets raised until it
# means nothing, so none of the stops here is a judgement about how the odds are
# *running*:
#
#   * every stop is an **absolute quantity of money out**, not a rate, not a
#     ratio and not a comparison against the configured RTP;
#   * the reserve is *sized* against the table's own variance before it is
#     signed — `_exposure_rules` prices a three-sigma bad run at three volumes
#     from Σp(m−μ)² and flags a reserve too small to absorb one, so a mechanic
#     whose reserve would be eaten by an ordinary bad month is refused at the
#     card, not discovered at the suspension;
#   * "the odds look wrong" is a **different control entirely** (8B.5 below),
#     it uses a confidence bound rather than a percentage gap, and it alerts a
#     person rather than stopping the mechanic.
#
# A run of luck therefore consumes headroom and is visible on the exposure
# screen the whole way down. It only trips a stop when it has cost more real
# diamonds than the business wrote down in advance that it was prepared to lose,
# which is not a statistical statement at all.
#
# ## The race — two rounds, one ceiling
#
# The dangerous shape is read-then-write: check the day's payouts, find room,
# credit. Two rounds settling in the same millisecond both read the same total,
# both find room, and both pay. The ceiling is then whatever the two of them
# added up to.
#
# Nothing here reads before it writes. Every ceiling is a counter document in
# `chance_exposure` under a **unique `key`**, and it is consumed by a single
# conditional update that carries the limit in its own filter:
#
#     update_one({"key": k, "paid_out": {"$lte": limit - amount}},
#                {"$inc": {"paid_out": amount}})
#
# One document, one atomic compare-and-increment, decided by Mongo. Two rounds
# racing cannot both match: whichever loses matches nothing, and rather than
# guessing it then takes **exactly the headroom that is left** with a
# compare-and-set on the value it observed (`_consume`, slow path), retrying if
# that value moved underneath it. The sum of everything granted can therefore
# never exceed the limit, at any level of concurrency, and no round is ever
# refused headroom that was genuinely there.
#
# The reserve uses the same mechanism on a signed field: `net` carries
# `staked − paid_out`, a stake increments it and a payout decrements it, and the
# filter is `{"net": {"$gte": amount - reserve}}` — again one field, one
# document, one atomic decision.
#
# The gates are consumed **before** the round is recorded and long before
# `apply_movement` is called, so a crash anywhere after them leaves the counters
# over-consumed rather than under-consumed. That direction is deliberate: an
# over-consumed counter suspends the mechanic slightly early and a person can
# see why, an under-consumed one pays money that was not there.

#: How many times `_consume` will re-read and retry its compare-and-set before
#: giving up and granting nothing. Each retry means another round changed the
#: same counter in between; five is far past anything a real workload produces
#: and granting zero is the safe answer if it is ever reached.
_CAS_ATTEMPTS = 5

_TZ_CACHE: dict[str, Any] = {}


def _business_tz() -> Any:
    """The zone a 'day' is cut in, borrowed rather than redefined.

    `services/scheduling.py` already decides this for every scheduled report,
    and Finance owning the margin (8B.5.6) means the daily payout ceiling and
    the daily margin report have to agree about where Tuesday ends. Two
    definitions of "day" in one system is a discrepancy waiting to be argued
    about at a month end.
    """
    if "tz" not in _TZ_CACHE:
        from app.services.scheduling import business_tz

        _TZ_CACHE["tz"] = business_tz()
    return _TZ_CACHE["tz"]


def business_day(when: datetime | None = None) -> str:
    """The business day a moment belongs to, as `YYYY-MM-DD`."""
    moment = when or _now()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(_business_tz()).strftime("%Y-%m-%d")


async def _refuse_if_suspended(mechanic_id: str) -> None:
    """A suspended mechanic accepts nothing, in the usual words. Spec 8B.4.5."""
    mechanic = await get_mechanic(mechanic_id)
    if mechanic.get("suspended"):
        log.warning(
            "chance: %s is suspended; refusing (8B.4.5)", mechanic_id
        )
        raise MechanicUnavailable("No such mechanic.")


def _lifetime_key(mechanic_id: str) -> str:
    return f"mechanic:{mechanic_id}:lifetime"


def _mechanic_day_key(mechanic_id: str, day: str) -> str:
    return f"mechanic:{mechanic_id}:day:{day}"


def _player_day_key(mechanic_id: str, player_uid: str, day: str) -> str:
    return f"player:{player_uid}:mechanic:{mechanic_id}:day:{day}"


def _platform_day_key(day: str) -> str:
    return f"platform:day:{day}"


async def _ensure_counter(key: str, base: Mapping) -> None:
    """Make the counter exist, so every later update can be conditional.

    Every gate below is an `update_one` **without** upsert, and that is the
    point of this function. An upsert whose filter carries a limit does not
    evaluate that limit when it inserts — Mongo builds the new document from the
    filter's equalities alone — so an upserting gate would let the very first
    payout of a day through whatever the ceiling said. Creating the row first,
    unconditionally, removes the hole entirely.
    """
    from pymongo.errors import DuplicateKeyError as _Duplicate

    try:
        await get_db()[C.CHANCE_EXPOSURE].update_one(
            {"key": key},
            {
                "$setOnInsert": {
                    "key": key,
                    "staked": 0,
                    "paid_out": 0,
                    "withheld": 0,
                    "net": 0,
                    "rounds": 0,
                    "payouts": 0,
                    "created_at": _now(),
                    **dict(base),
                }
            },
            upsert=True,
        )
    except _Duplicate:  # pragma: no cover — another worker created it first
        return


async def _consume(key: str, *, limit: int | None, amount: int, mode: str) -> int:
    """Take up to `amount` from a budget. Returns what was actually granted.

    `mode` is `"budget"` — a payout ceiling, where `paid_out` may not exceed
    `limit` — or `"reserve"`, where `net` may not fall below `-limit`.

    Three steps, and none of them reads a value and then trusts it:

      1. **The whole amount, conditionally.** One update whose filter contains
         the limit. If it matches, the money was there and is now spoken for.
      2. **Whatever is left, on a compare-and-set.** The filter pins the exact
         value observed a moment ago, so an increment that raced ahead of us
         makes the update match nothing and we look again.
      3. **Nothing**, after `_CAS_ATTEMPTS` collisions.

    An unlimited budget (`limit is None`) still increments, because exposure is
    reported whether or not it is capped — a mechanic with no ceiling is one
    whose figures an owner can still read (8B.4.2).
    """
    if amount <= 0:
        return 0

    col = get_db()[C.CHANCE_EXPOSURE]
    field = "paid_out" if mode == "budget" else "net"

    def _inc(quantity: int) -> dict:
        inc = {"paid_out": quantity, "payouts": 1}
        if mode == "reserve":
            inc["net"] = -quantity
        return inc

    stamp = {"$set": {"updated_at": _now()}}

    if limit is None:
        await col.update_one({"key": key}, {"$inc": _inc(amount), **stamp})
        return amount

    condition = (
        {field: {"$lte": limit - amount}}
        if mode == "budget"
        else {field: {"$gte": amount - limit}}
    )
    result = await col.update_one(
        {"key": key, **condition}, {"$inc": _inc(amount), **stamp}
    )
    if getattr(result, "matched_count", 0):
        return amount

    for _attempt in range(_CAS_ATTEMPTS):
        doc = await col.find_one({"key": key})
        if doc is None:  # pragma: no cover — `_ensure_counter` precedes this
            return 0
        observed = int(doc.get(field) or 0)
        remaining = (limit - observed) if mode == "budget" else (observed + limit)
        remaining = max(0, min(remaining, amount))
        if remaining == 0:
            return 0
        result = await col.update_one(
            {"key": key, field: observed}, {"$inc": _inc(remaining), **stamp}
        )
        if getattr(result, "matched_count", 0):
            return remaining
    log.error(
        "chance: could not settle a claim on budget %s after %d attempts; "
        "granting nothing",
        key,
        _CAS_ATTEMPTS,
    )
    return 0


async def _release(key: str, *, amount: int, mode: str) -> None:
    """Give back headroom taken from a gate that a narrower one then refused.

    Gates are consumed in order and a later one may grant less than an earlier
    one already took. The difference was never paid to anybody, so it is handed
    straight back — otherwise the first ceiling would quietly tighten every time
    a different ceiling bound, and would eventually suspend a mechanic over
    money that was never credited.
    """
    if amount <= 0:
        return
    inc = {"paid_out": -amount}
    if mode == "reserve":
        inc["net"] = amount
    await get_db()[C.CHANCE_EXPOSURE].update_one(
        {"key": key}, {"$inc": inc, "$set": {"updated_at": _now()}}
    )


async def _record_stake(
    *, mechanic_id: str, player_uid: str, stake: int, when: datetime
) -> str:
    """Count a stake into every budget it belongs to. Spec 8B.4.2.

    Unconditional: a stake is money coming *in*, and nothing about it can breach
    anything. It increases `net`, which is what makes the reserve a position
    rather than a spend limit — a mechanic that is ahead is not consuming its
    reserve at all.
    """
    day = business_day(when)
    base = {"mechanic_id": mechanic_id, "day": day}
    targets = (
        (_lifetime_key(mechanic_id), {"kind": "lifetime", "mechanic_id": mechanic_id, "day": None}),
        (_mechanic_day_key(mechanic_id, day), {"kind": "mechanic_day", **base}),
        (
            _player_day_key(mechanic_id, player_uid, day),
            {"kind": "player_day", "player_uid": player_uid, **base},
        ),
        (_platform_day_key(day), {"kind": "platform_day", "mechanic_id": None, "day": day}),
    )
    for key, meta in targets:
        await _ensure_counter(key, meta)
        await get_db()[C.CHANCE_EXPOSURE].update_one(
            {"key": key},
            {
                "$inc": {"staked": stake, "net": stake, "rounds": 1},
                "$set": {"updated_at": _now()},
            },
        )
    return day


@dataclass(frozen=True, slots=True)
class _Gate:
    """One ceiling, as the thing that enforces it."""

    kind: str
    key: str
    limit: int | None
    mode: str
    label: str


async def _apply_ceilings(
    *,
    mechanic_id: str,
    player_uid: str,
    payout: int,
    exposure: Mapping,
    when: datetime,
    round_id: str,
    actor: dict,
) -> dict:
    """Decide what of a won payout may actually be paid. Spec 8B.4.4 / 8B.4.5.

    The per-round ceiling **caps**, exactly as the maximum single win does: a
    large win is paid down to it and nothing else happens. It is a designed
    limit that the table's own top multiplier reaches routinely at the top
    stake, and suspending a mechanic every time somebody hits the jackpot is the
    textbook case of a control that will be switched off (8B.4.1).

    The three budgets — per player per day, per mechanic per day, and the whole
    platform per day — and the reserve are different. Crossing one of those
    means the business is paying out more than it agreed to in a window, so the
    payout is trimmed to the headroom that genuinely remains, the shortfall is
    **withheld and recorded**, and the mechanic **auto-suspends** (8B.4.5).

    Withheld diamonds are not written off. They are on the round, in the audit
    log and on the exception queue, and 8B.7.5 already says how they are settled
    if they should be: a money card with an owner's signature. What must not
    happen — and does not happen here — is a payout being minted past a limit
    because reversing it afterwards would be tidier.
    """
    day = business_day(when)
    before_ceilings = payout

    per_round = exposure.get("max_payout_per_round")
    capped_by_round = False
    if per_round is not None and payout > int(per_round):
        payout = int(per_round)
        capped_by_round = True

    platform_all = int(getattr(settings, "chance_platform_daily_payout_ceiling", 0) or 0)
    gates = (
        _Gate(
            "per_player_per_day",
            _player_day_key(mechanic_id, player_uid, day),
            exposure.get("max_payout_per_player_per_day"),
            "budget",
            "the per-player daily payout ceiling",
        ),
        _Gate(
            "platform_per_day",
            _mechanic_day_key(mechanic_id, day),
            exposure.get("max_payout_platform_per_day"),
            "budget",
            "this mechanic's daily payout ceiling",
        ),
        _Gate(
            "all_mechanics_per_day",
            _platform_day_key(day),
            platform_all or None,
            "budget",
            "the daily payout ceiling across every mechanic "
            "(CHANCE_PLATFORM_DAILY_PAYOUT_CEILING)",
        ),
        _Gate(
            "reserve",
            _lifetime_key(mechanic_id),
            exposure.get("reserve_diamonds"),
            "reserve",
            "the modelled reserve",
        ),
    )

    taken: list[tuple[_Gate, int]] = []
    allowed = payout
    breached: list[dict] = []

    for gate in gates:
        await _ensure_counter(
            gate.key,
            {
                "kind": gate.kind,
                "mechanic_id": None if gate.kind == "all_mechanics_per_day" else mechanic_id,
                "day": None if gate.kind == "reserve" else day,
                "player_uid": player_uid if gate.kind == "per_player_per_day" else None,
            },
        )
        wanted = allowed
        granted = await _consume(
            gate.key, limit=gate.limit, amount=wanted, mode=gate.mode
        )
        taken.append((gate, granted))
        if granted < wanted:
            breached.append(
                {
                    "kind": gate.kind,
                    "key": gate.key,
                    "limit": gate.limit,
                    "label": gate.label,
                    "wanted": wanted,
                    "granted": granted,
                    "day": None if gate.kind == "reserve" else day,
                }
            )
            allowed = granted
        if allowed == 0:
            break

    for gate, granted in taken:
        if granted > allowed:
            await _release(gate.key, amount=granted - allowed, mode=gate.mode)

    withheld = payout - allowed
    if withheld > 0:
        for gate, _granted in taken:
            await get_db()[C.CHANCE_EXPOSURE].update_one(
                {"key": gate.key}, {"$inc": {"withheld": withheld}}
            )

    if breached:
        await _breach(
            mechanic_id=mechanic_id,
            player_uid=player_uid,
            round_id=round_id,
            requested=payout,
            paid=allowed,
            withheld=withheld,
            breached=breached,
            day=day,
            actor=actor,
        )

    return {
        "before": before_ceilings,
        "requested": payout,
        "paid": allowed,
        "withheld": withheld,
        "capped_by_round_ceiling": capped_by_round,
        "breached": breached,
        "day": day,
    }


# ── Auto-suspend, and the deliberate act that undoes it ───────────────────────


async def _breach(
    *,
    mechanic_id: str,
    player_uid: str,
    round_id: str,
    requested: int,
    paid: int,
    withheld: int,
    breached: Sequence[Mapping],
    day: str,
    actor: dict,
) -> None:
    """A ceiling bound. Record it, stop the mechanic, tell the owners."""
    names = ", ".join(str(b.get("label")) for b in breached)
    reason = (
        f"{mechanic_id} round {round_id} would have paid {requested:,} diamonds "
        f"and {names} left room for {paid:,}. {withheld:,} diamonds were "
        "withheld and the mechanic was suspended (8B.4.5)."
    )
    await audit.record(
        actor=actor,
        action=Act.CEILING_BREACHED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        after={
            "round_id": round_id,
            "player_uid": player_uid,
            "requested": requested,
            "paid": paid,
            "withheld": withheld,
            "day": day,
        },
        meta={
            "breached": [dict(b) for b in breached],
            "note": (
                "The withheld amount is not written off. It is an exception for "
                "a person to settle on a signed money card (8B.7.5); nothing "
                "here credits or reverses it automatically."
            ),
        },
    )
    await suspend_mechanic(
        mechanic_id=mechanic_id,
        reason=reason,
        actor=actor,
        automatic=True,
        breach={
            "round_id": round_id,
            "player_uid": player_uid,
            "requested": requested,
            "paid": paid,
            "withheld": withheld,
            "day": day,
            "ceilings": [dict(b) for b in breached],
        },
    )


async def suspend_mechanic(
    *,
    mechanic_id: str,
    reason: str,
    actor: dict,
    automatic: bool = False,
    breach: Mapping | None = None,
) -> dict:
    """Stop a mechanic. Spec 8B.4.5.

    From this moment the mechanic **pays nothing and accepts nothing**: no round
    can be opened on it, no committed round can be played, and no third-party
    settlement is honoured. Every one of those refusals is
    `MechanicUnavailable`, with the same words and the same 404 a mechanic that
    was never built in this market produces — a player cannot tell a suspension
    from a market that does not exist, which is what 8B.0.7 requires and what
    stops a stop becoming public news about the business.

    The write is `find_one_and_update` on `suspended: None`, so **the first
    breach suspends and every other one finds it already suspended**: a hundred
    rounds crossing a ceiling in the same second produce one suspension, one
    audit entry and one email, not a hundred.

    Stopping is available to a team admin as well as an owner, and restarting is
    not. That asymmetry is the one `withdraw_country` already argues for and it
    is safe in one direction only: suspending makes a mechanic less available
    and can never make one payable where it was not.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    reason = _reason(reason)
    await get_mechanic(mechanic_id)  # 404s on an unknown id, in the usual words

    now = _now()
    who = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }
    state = {
        "at": now,
        "by": who,
        "reason": reason,
        "automatic": bool(automatic),
        "breach": dict(breach) if breach else None,
    }
    updated = await get_db()[C.CHANCE_MECHANICS].find_one_and_update(
        {"_id": mechanic_id, "suspended": None},
        {"$set": {"suspended": state, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        existing = await get_mechanic(mechanic_id)
        return {
            "mechanic_id": mechanic_id,
            "suspended": existing.get("suspended"),
            "already_suspended": True,
        }

    await audit.record(
        actor=actor,
        action=Act.MECHANIC_SUSPENDED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        before={"suspended": None},
        after={"suspended": True, "automatic": bool(automatic)},
        meta={
            "breach": dict(breach) if breach else None,
            "note": (
                "The mechanic now answers every player exactly as a mechanic "
                "that is not enabled in their country does. Resuming is a "
                "deliberate act by an owner with a reason; there is no timer."
            ),
        },
    )
    await _alert_owners_of_suspension(mechanic_id, state)
    return {"mechanic_id": mechanic_id, "suspended": state, "already_suspended": False}


async def _alert_owners_of_suspension(mechanic_id: str, state: Mapping) -> None:
    """Tell all owners, now. Spec 8B.4.5.

    Through `services/alerts.py`, which already knows how to resolve "owners"
    from the staff record, how to render an alert, how to record the delivery
    and how not to send the same thing twice — a second alerting path here would
    be a second set of all four of those, and the one that got less use would be
    the one that was broken when it mattered.

    A failure to *send* never fails the suspension. The mechanic is already
    stopped, the audit entry is already written, and the scheduled
    `chance_mechanic_suspended` detector will raise it again on the next scan.
    """
    try:
        from app.services import alerts

        breach = dict(state.get("breach") or {})
        await alerts.raise_now(
            alert="chance_mechanic_suspended",
            spec="8B.4.5",
            severity="critical",
            audience=(str(alerts.OWNERS), str(alerts.FINANCE)),
            key=f"chance:suspended:{mechanic_id}",
            fingerprint=str(state.get("at")),
            headline=f"{mechanic_id} has auto-suspended — a payout ceiling was breached",
            rows=[
                ("Mechanic", mechanic_id),
                ("Suspended at", state.get("at")),
                ("Automatic", "yes" if state.get("automatic") else "no"),
                ("Reason", state.get("reason")),
                ("Round", breach.get("round_id") or "—"),
                ("Would have paid", breach.get("requested")),
                ("Actually paid", breach.get("paid")),
                ("Withheld", breach.get("withheld")),
                (
                    "Ceiling breached",
                    ", ".join(
                        str(c.get("label")) for c in (breach.get("ceilings") or [])
                    )
                    or "—",
                ),
            ],
            action=(
                "The mechanic is stopped and is invisible to every player. It "
                "does not restart on a timer: an owner must resume it, with a "
                "reason, after deciding whether the ceiling was right. The "
                "withheld diamonds are on the round record and are settled — if "
                "they should be — on a money card, never by a balance edit "
                "(8B.7.5 / 8B.7.6)."
            ),
            threshold="any payout that would cross a configured ceiling or the reserve",
            threshold_setting="the mechanic's signed configuration (8B.4.3 / 8B.4.4)",
            meta={"mechanic_id": mechanic_id, "breach": breach},
        )
    except Exception as exc:  # noqa: BLE001 — the stop is not conditional on the email
        log.exception(
            "chance: %s was suspended but the owner alert failed: %s", mechanic_id, exc
        )


async def resume_mechanic(*, mechanic_id: str, reason: str, actor: dict) -> dict:
    """Restart a suspended mechanic. Owners only. Spec 8B.4.5.

    **There is no timer anywhere in this module**, and this function is the
    reason there is not. A suspension that expires on its own says the business
    would rather the mechanic were paying than that somebody looked at why it
    stopped, and the next breach would suspend it again in a loop nobody reads.

    So: an owner, a mandatory reason, and an audit entry that records the live
    exposure **at the moment of the decision** — the headroom, the day's
    payouts, and what the ceiling was — so the record shows what the owner was
    looking at when they decided, not merely that they decided.

    Resuming does not raise a ceiling, refill a reserve or release a withheld
    payout. If the condition that breached is still true, the very next
    qualifying payout will suspend it again, and that is correct: the way to
    keep a mechanic running is a signed configuration change, not a restart.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    reason = _reason(reason)
    if str(actor.get("role", "")) != str(Role.OWNER):
        raise ChanceError(
            "Only a business owner can resume a suspended chance mechanic. It "
            "stopped because it paid out past a limit the business signed for; "
            "restarting it is a decision about money, not an operational step "
            "(8B.4.5)."
        )

    mechanic = await get_mechanic(mechanic_id)
    state = mechanic.get("suspended")
    if not state:
        raise ChanceError(f"{mechanic_id} is not suspended.")

    position = await exposure_for(mechanic_id)
    now = _now()
    who = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }
    await get_db()[C.CHANCE_MECHANICS].update_one(
        {"_id": mechanic_id},
        {
            "$set": {
                "suspended": None,
                "updated_at": now,
                "last_resumed": {
                    "at": now,
                    "by": who,
                    "reason": reason,
                    "suspension": dict(state),
                    "position_at_resume": position.get("headline"),
                },
            }
        },
    )
    await audit.record(
        actor=actor,
        action=Act.MECHANIC_RESUMED,
        subject_type="chance_mechanic",
        subject_id=mechanic_id,
        reason=reason,
        before={"suspended": True, "since": state.get("at")},
        after={"suspended": False},
        meta={
            "suspension": dict(state),
            "position_at_resume": position.get("headline"),
            "still_breached": position.get("still_breached"),
            "note": (
                "Resumed by an owner. Nothing about the ceilings or the reserve "
                "changed; if the breached condition still holds the next "
                "qualifying payout will suspend it again."
            ),
        },
    )
    await _release_suspension_alert(mechanic_id)
    return {
        "mechanic_id": mechanic_id,
        "suspended": None,
        "resumed_by": who,
        "reason": reason,
        "position": position.get("headline"),
        "still_breached": position.get("still_breached"),
    }


async def _release_suspension_alert(mechanic_id: str) -> None:
    """Forget the suspension alert, so a second one is not suppressed as a repeat."""
    try:
        from app.services import alerts

        await alerts.release(f"chance:suspended:{mechanic_id}")
    except Exception as exc:  # noqa: BLE001
        log.warning("chance: could not clear the alert state for %s: %s", mechanic_id, exc)


# ── Reading the position ──────────────────────────────────────────────────────


async def _counter(key: str) -> dict:
    doc = await get_db()[C.CHANCE_EXPOSURE].find_one({"key": key})
    return doc or {"key": key, "staked": 0, "paid_out": 0, "withheld": 0, "net": 0,
                   "rounds": 0, "payouts": 0}


async def _rounds_total(query: Mapping) -> dict:
    """Staked and paid out, summed from the rounds themselves. Spec 8B.4.2.

    From `chance_rounds` rather than from the counters, deliberately. The
    counters are a *control* — they are consumed before a payout and are
    conservative by design — and the rounds are the *record*. A figure an owner
    or a regulator reads has to come from the record, and the two are shown side
    by side below precisely so a divergence between them is visible rather than
    averaged away.
    """
    staked = paid = withheld = rounds = 0
    cursor = get_db()[C.CHANCE_ROUNDS].find(dict(query))
    async for doc in cursor:
        rounds += 1
        staked += int(doc.get("total_stake") or 0)
        paid += int(doc.get("payout") or 0)
        withheld += int(doc.get("withheld") or 0)
    return {
        "rounds": rounds,
        "staked": staked,
        "paid_out": paid,
        "withheld": withheld,
        "net": staked - paid,
    }


async def exposure_for(mechanic_id: str, *, day: str | None = None) -> dict:
    """One mechanic's live exposure and reserve position. Spec 8B.4.2 / 8B.4.3.

    `net` is the house's position: **staked minus paid out**, which is gross
    gaming revenue (8B.7.1) when it is positive and the amount the reserve is
    absorbing when it is negative. `headroom` is `reserve + net` — how much more
    can be paid out before this mechanic is loss-making past what was signed
    for.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    mechanic = await get_mechanic(mechanic_id)
    today = day or business_day()

    exposure: dict = {}
    version = mechanic.get("live_version")
    if version is None:
        latest = await get_db()[C.CHANCE_CONFIGS].find_one(
            {"mechanic_id": mechanic_id, "status": str(ConfigStatus.LIVE)},
            sort=[("version", -1)],
        )
        if latest:
            exposure = (latest.get("evaluation") or {}).get("exposure") or {}
    else:
        config = await _config(mechanic_id, int(version))
        exposure = (config.get("evaluation") or {}).get("exposure") or {}

    lifetime = await _rounds_total({"mechanic_id": mechanic_id})
    today_rows = await _rounds_total(
        {"mechanic_id": mechanic_id, "exposure_day": today}
    )
    control = await _counter(_lifetime_key(mechanic_id))
    control_today = await _counter(_mechanic_day_key(mechanic_id, today))

    reserve = exposure.get("reserve_diamonds")
    headroom = None if reserve is None else int(reserve) + lifetime["net"]
    consumed_ppm = None
    if reserve:
        spent = max(0, -lifetime["net"])
        consumed_ppm = min(PROBABILITY_TOTAL, spent * PROBABILITY_TOTAL // int(reserve))

    platform_day = exposure.get("max_payout_platform_per_day")
    day_headroom = (
        None
        if platform_day is None
        else max(0, int(platform_day) - int(control_today.get("paid_out") or 0))
    )

    still_breached = bool(
        (headroom is not None and headroom <= 0)
        or (day_headroom is not None and day_headroom <= 0)
    )

    return {
        "mechanic_id": mechanic_id,
        "name": mechanic.get("name"),
        "kind": mechanic.get("kind"),
        "config_version": version,
        "suspended": mechanic.get("suspended"),
        "day": today,
        # 8B.4.2 — the live headline, straight off the rounds.
        "headline": {
            "staked": lifetime["staked"],
            "paid_out": lifetime["paid_out"],
            "withheld": lifetime["withheld"],
            "net": lifetime["net"],
            "rounds": lifetime["rounds"],
            "actual_rtp_ppm": (
                lifetime["paid_out"] * PROBABILITY_TOTAL // lifetime["staked"]
                if lifetime["staked"]
                else None
            ),
            "reserve": reserve,
            "headroom": headroom,
            "reserve_consumed_ppm": consumed_ppm,
            "reserve_consumed_percent": (
                None if consumed_ppm is None else percent(consumed_ppm)
            ),
        },
        "today": {
            "staked": today_rows["staked"],
            "paid_out": today_rows["paid_out"],
            "withheld": today_rows["withheld"],
            "net": today_rows["net"],
            "rounds": today_rows["rounds"],
            "ceiling": platform_day,
            "headroom": day_headroom,
        },
        "ceilings": {
            "per_round": exposure.get("max_payout_per_round"),
            "per_player_per_day": exposure.get("max_payout_per_player_per_day"),
            "platform_per_day": platform_day,
            "all_mechanics_per_day": int(
                getattr(settings, "chance_platform_daily_payout_ceiling", 0) or 0
            )
            or None,
        },
        "reserve_basis": exposure.get("reserve_basis"),
        "sigma_ppm": exposure.get("sigma_ppm"),
        "reserve_guidance": exposure.get("reserve_guidance"),
        # The control's own view, beside the record's. They should agree; where
        # they do not, the counter is the conservative one and the difference is
        # a payout that was reserved and never credited.
        "control": {
            "staked": int(control.get("staked") or 0),
            "paid_out": int(control.get("paid_out") or 0),
            "net": int(control.get("net") or 0),
            "withheld": int(control.get("withheld") or 0),
        },
        "still_breached": still_breached,
    }


async def exposure_snapshot() -> list[dict]:
    """Every mechanic's exposure, for the portal's one screen. Spec 8B.4.2."""
    out: list[dict] = []
    async for doc in get_db()[C.CHANCE_MECHANICS].find({}).sort("_id", 1):
        out.append(await exposure_for(str(doc["_id"])))
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Monitoring — actual against theoretical, Part 8B.5
# ══════════════════════════════════════════════════════════════════════════════
#
# ## Why this is not "actual RTP is more than N% off configured"
#
# It is the obvious rule and it does not work. The spread of a sample of returns
# shrinks with the square root of its size, so one flat percentage is
# simultaneously far too tight on a quiet Tuesday and far too loose on a busy
# Saturday. Set it at 5% and a hundred-round morning alerts every day; set it
# wide enough that a hundred-round morning is quiet and a million-round day
# could be losing lakhs before it says anything. Either way, within a fortnight
# somebody stops reading the email, and 8B.5.2's three real causes — a
# configuration error, an exploit, a bug — all arrive after that.
#
# ## What is used instead
#
# The **exact variance of the signed outcome table**. For a table with outcomes
# `m` at probabilities `p`, one round's return has mean `μ = Σp·m` and variance
# `σ² = Σp·m² − μ²`, both computed on integers by `variance_numerator` from the
# same immutable version the round was drawn on. Over rounds with stakes `sᵢ`:
#
#     expected payout   E = Σ sᵢ·μ
#     standard error   SE = √(Σ sᵢ²·σ²)
#     z                   = (actual − E) / SE
#
# `z` is how many standard deviations the day landed from where the signed table
# says it should have. It is comparable across mechanics, across stake sizes and
# across days, which no percentage gap is, and it is reported as a **confidence
# interval on actual RTP** so a reader sees the band rather than a statistic.
#
# ## The thresholds, and why those numbers
#
#   * **4σ for one mechanic on one day** (CHANCE_RTP_DAILY_SIGMA_MILLI). Roughly
#     one day in 16,000 by chance — about one false alarm every forty years at
#     ten mechanics. A single day that far out is not luck.
#   * **3σ pooled over a rolling week** (CHANCE_RTP_WINDOW_SIGMA_MILLI). This is
#     8B.5.2's *persistent* gap. Pooling seven days multiplies the evidence, so
#     the bar comes down; a 3σ excursion that survives a week is the shape a
#     mis-set table or an exploit makes, and a single 3σ day is deliberately
#     ignored.
#   * **Never below 200 rounds** (CHANCE_RTP_MIN_ROUNDS), whatever z says. The
#     normal approximation z rests on is invalid in the tail of a heavy-tailed
#     multiplier distribution at small N: three rounds containing one 50× is a
#     six-sigma event and an entirely ordinary evening. The figure is still
#     computed and still shown — it is just not alerted on, and the report says
#     which of the two it is.
#
# ## What the report deliberately does not say
#
# 8B.5.2 names three causes and this code cannot tell them apart. It does not
# guess. Every divergence is reported as all three, with the evidence that would
# separate them — which configuration versions were in play, whether the
# divergence is concentrated in a handful of players, whether capped rounds
# explain it — so the person reading decides. A report that asserted "exploit"
# and was wrong would send Ops hunting a fraudster while a bad table kept
# paying.


def _round_stats(doc: Mapping, tables: dict) -> tuple[int, int, int] | None:
    """(stake, rtp_numerator, variance_numerator) for one settled round."""
    stake = int(doc.get("payable_stake") or doc.get("total_stake") or 0)
    if stake <= 0:
        return None
    rtp = doc.get("rtp_ppm_at_play")
    variance = doc.get("variance_num_at_play")
    if rtp is None or variance is None:
        key = (str(doc.get("mechanic_id")), int(doc.get("config_version") or 0))
        if key not in tables:
            tables[key] = None
        stats = tables[key]
        if stats is None:
            return None
        rtp, variance = stats
    # `rtp_ppm_at_play` is ppm; the numerator the arithmetic wants is ppm × 10^4.
    return stake, int(rtp) * MULTIPLIER_ONE, int(variance)


async def _load_tables(mechanic_id: str, versions: Sequence[int]) -> dict:
    """Mean and variance per configuration version, for rounds recorded before
    the variance was pinned on the round itself."""
    tables: dict = {}
    for version in set(versions):
        try:
            config = await _config(mechanic_id, int(version))
        except ChanceError:  # pragma: no cover — a version cannot vanish
            continue
        outcomes = parse_outcomes(_draft_from(config)["outcomes"])
        tables[(mechanic_id, int(version))] = (
            rtp_ppm(outcomes),
            variance_numerator(outcomes),
        )
    return tables


def _divergence(
    *, paid: int, stake_sum: int, expected_num: int, variance_acc: int, rounds: int,
    sigma_milli: int, min_rounds: int,
) -> dict:
    """Turn one bucket of rounds into a verdict. Pure arithmetic, no database.

    `expected_num` is `Σ sᵢ·rtp_numerator` on `RTP_SCALE`, and `variance_acc` is
    `Σ sᵢ²·variance_numerator` on `VARIANCE_SCALE`. Both scales cancel in `z`,
    which is why it can be computed exactly on integers:

        z = (paid·10^10 − Σ sᵢ·rtp_num) / √(Σ sᵢ²·var_num)
    """
    import math

    configured_ppm = expected_num // (stake_sum * MULTIPLIER_ONE) if stake_sum else None
    actual_ppm = paid * PROBABILITY_TOTAL // stake_sum if stake_sum else None

    standard_error = math.isqrt(max(0, variance_acc))
    numerator = paid * RTP_SCALE - expected_num
    z_milli = (numerator * 1_000 // standard_error) if standard_error else 0

    # The same standard error expressed as a band on actual RTP, in ppm, so the
    # report reads as "92% ± 1.4%" rather than as a z-score nobody acts on.
    band_ppm = (
        sigma_milli * standard_error // (1_000 * MULTIPLIER_ONE * stake_sum)
        if stake_sum and standard_error
        else 0
    )
    enough = rounds >= min_rounds
    divergent = enough and abs(z_milli) >= sigma_milli

    return {
        "rounds": rounds,
        "staked": stake_sum,
        "paid_out": paid,
        "net": stake_sum - paid,
        "configured_rtp_ppm": configured_ppm,
        "configured_rtp_percent": None if configured_ppm is None else percent(configured_ppm),
        "actual_rtp_ppm": actual_ppm,
        "actual_rtp_percent": None if actual_ppm is None else percent(actual_ppm),
        "gap_ppm": (
            None if actual_ppm is None or configured_ppm is None
            else actual_ppm - configured_ppm
        ),
        "expected_payout": expected_num // RTP_SCALE,
        "z_milli": z_milli,
        "z": _trim(Decimal(z_milli) / 1_000),
        "sigma_threshold_milli": sigma_milli,
        "confidence_band_ppm": band_ppm,
        "confidence_low_ppm": None if actual_ppm is None else actual_ppm - band_ppm,
        "confidence_high_ppm": None if actual_ppm is None else actual_ppm + band_ppm,
        "configured_inside_band": (
            None
            if actual_ppm is None or configured_ppm is None
            else abs(actual_ppm - configured_ppm) <= band_ppm
        ),
        "enough_rounds": enough,
        "min_rounds": min_rounds,
        "divergent": divergent,
        "verdict": (
            "not enough rounds to distinguish this from variance"
            if not enough
            else (
                f"{_trim(Decimal(abs(z_milli)) / 1_000)} standard deviations "
                f"{'above' if z_milli > 0 else 'below'} the signed table — "
                "outside the confidence bound"
                if divergent
                else "inside the confidence bound — ordinary variance"
            )
        ),
    }


async def rtp_divergence(
    mechanic_id: str,
    *,
    days: int | None = None,
    now: datetime | None = None,
) -> dict:
    """Actual RTP against configured RTP, per day and pooled. Spec 8B.5.1.

    Reads settled rounds only. A round that voided staked nothing and paid
    nothing and would drag both figures toward zero if counted.
    """
    mechanic_id = _mechanic_id(mechanic_id)
    window = int(days or getattr(settings, "chance_rtp_window_days", 7) or 7)
    reference = now or _now()
    since = reference - timedelta(days=window)

    daily_sigma = int(getattr(settings, "chance_rtp_daily_sigma_milli", 4_000))
    window_sigma = int(getattr(settings, "chance_rtp_window_sigma_milli", 3_000))
    min_rounds = int(getattr(settings, "chance_rtp_min_rounds", 200))

    rows: list[dict] = []
    cursor = get_db()[C.CHANCE_ROUNDS].find(
        {
            "mechanic_id": mechanic_id,
            "status": str(RoundStatus.SETTLED),
            "played_at": {"$gte": since},
        }
    )
    async for doc in cursor:
        rows.append(doc)

    tables = await _load_tables(
        mechanic_id, [int(r.get("config_version") or 0) for r in rows]
    )

    buckets: dict[str, dict] = {}
    versions: dict[str, set] = {}
    capped: dict[str, int] = {}
    for doc in rows:
        stats = _round_stats(doc, tables)
        if stats is None:
            continue
        stake, rtp_num, var_num = stats
        day = str(doc.get("exposure_day") or business_day(doc.get("played_at")))
        bucket = buckets.setdefault(
            day,
            {"paid": 0, "stake": 0, "expected": 0, "variance": 0, "rounds": 0},
        )
        bucket["paid"] += int(doc.get("payout") or 0)
        bucket["stake"] += stake
        bucket["expected"] += stake * rtp_num
        bucket["variance"] += stake * stake * var_num
        bucket["rounds"] += 1
        versions.setdefault(day, set()).add(int(doc.get("config_version") or 0))
        if doc.get("capped") or doc.get("ceiling_capped"):
            capped[day] = capped.get(day, 0) + 1

    per_day: list[dict] = []
    for day in sorted(buckets, reverse=True):
        bucket = buckets[day]
        entry = _divergence(
            paid=bucket["paid"],
            stake_sum=bucket["stake"],
            expected_num=bucket["expected"],
            variance_acc=bucket["variance"],
            rounds=bucket["rounds"],
            sigma_milli=daily_sigma,
            min_rounds=min_rounds,
        )
        entry["day"] = day
        entry["config_versions"] = sorted(versions.get(day, ()))
        entry["capped_rounds"] = capped.get(day, 0)
        per_day.append(entry)

    pooled = _divergence(
        paid=sum(b["paid"] for b in buckets.values()),
        stake_sum=sum(b["stake"] for b in buckets.values()),
        expected_num=sum(b["expected"] for b in buckets.values()),
        variance_acc=sum(b["variance"] for b in buckets.values()),
        rounds=sum(b["rounds"] for b in buckets.values()),
        sigma_milli=window_sigma,
        min_rounds=min_rounds,
    )
    pooled["days"] = window
    pooled["capped_rounds"] = sum(capped.values())

    return {
        "mechanic_id": mechanic_id,
        "window_days": window,
        "since": since,
        "per_day": per_day,
        "pooled": pooled,
        # 8B.5.2 — three causes, and this code cannot tell them apart. Saying so
        # is the point; a report that guessed would send people the wrong way.
        "if_divergent": [
            "A configuration error — the table that is live is not the table "
            "somebody meant to sign. Compare the live version against the one "
            "before it; the diff is on the card.",
            "An exploit — check whether the divergence is concentrated in a few "
            "players (`player_anomalies`) rather than spread across all of them.",
            "A bug — check the capped-round count below, whether any round "
            "settled on a configuration version it was not committed against, "
            "and whether every payout reconciles to a ledger movement.",
        ],
        "note": (
            "Actual RTP runs slightly below configured by construction: a payout "
            "is floored to a whole diamond and capped at the maximum single win, "
            "and both round in the house's favour. Capped rounds are counted "
            "beside each day so a divergence that is really the cap biting is "
            "visible as such."
        ),
    }


# ── Player-level anomalies — 8B.5.3 ───────────────────────────────────────────


async def player_anomalies(
    player_uid: str, *, hours: int | None = None, now: datetime | None = None
) -> dict:
    """Three questions about one player. Spec 8B.5.3.

    **Unusual win rate** — the same standardised comparison the mechanic-level
    monitor uses, against the same signed tables, at a higher bar. The bar is
    higher for a reason that has nothing to do with the player: this test runs
    against every active player every day, so the multiple-comparison correction
    *is* the threshold. Five sigma is about one player in three and a half
    million; four would flag a handful of honest people every single day, and a
    queue full of honest people is a queue nobody works.

    **Unusual frequency** — rounds per hour above a configured ceiling. Not a
    statistical test at all, because there is no distribution of human tapping
    speed to compare against; it is a statement about what a person can do.

    **Impossible timing** — three separate things, and only the last two are
    really about speed:

      * a round **played before it was committed**, which is a clock or an
        ordering fault on our side and is flagged whatever else is true;
      * two settled rounds closer together than a person can produce;
      * a round played sooner after its own commitment was published than the
        commitment could have reached a device and come back.

    Nothing here freezes anybody. It produces evidence; `freeze_player` is a
    separate, deliberate act with a reason on it.
    """
    import math

    player_uid = str(player_uid or "").strip()
    lookback = int(hours or getattr(settings, "chance_anomaly_lookback_hours", 24))
    reference = now or _now()
    since = reference - timedelta(hours=lookback)

    rows: list[dict] = []
    cursor = get_db()[C.CHANCE_ROUNDS].find(
        {
            "player_uid": player_uid,
            "status": str(RoundStatus.SETTLED),
            "played_at": {"$gte": since},
        }
    )
    async for doc in cursor:
        rows.append(doc)
    rows.sort(key=lambda d: d.get("played_at") or reference)

    findings: list[dict] = []

    # ── win rate ──────────────────────────────────────────────────────────────
    tables: dict = {}
    for mechanic in {str(r.get("mechanic_id")) for r in rows}:
        tables.update(
            await _load_tables(
                mechanic,
                [
                    int(r.get("config_version") or 0)
                    for r in rows
                    if str(r.get("mechanic_id")) == mechanic
                ],
            )
        )

    paid = stake_sum = expected = variance_acc = counted = 0
    for doc in rows:
        stats = _round_stats(doc, tables)
        if stats is None:
            continue
        stake, rtp_num, var_num = stats
        paid += int(doc.get("payout") or 0)
        stake_sum += stake
        expected += stake * rtp_num
        variance_acc += stake * stake * var_num
        counted += 1

    win_rate = _divergence(
        paid=paid,
        stake_sum=stake_sum,
        expected_num=expected,
        variance_acc=variance_acc,
        rounds=counted,
        sigma_milli=int(getattr(settings, "chance_player_sigma_milli", 5_000)),
        min_rounds=int(getattr(settings, "chance_player_min_rounds", 30)),
    )
    if win_rate["divergent"] and win_rate["z_milli"] > 0:
        findings.append(
            {
                "kind": "unusual_win_rate",
                "spec": "8B.5.3",
                "detail": (
                    f"{counted} rounds returned {win_rate['actual_rtp_percent']}% "
                    f"against a configured {win_rate['configured_rtp_percent']}% — "
                    f"{win_rate['z']} standard deviations above the signed table."
                ),
                "evidence": win_rate,
            }
        )

    # ── frequency ─────────────────────────────────────────────────────────────
    ceiling = int(getattr(settings, "chance_player_max_rounds_per_hour", 240))
    hourly = len(rows) // max(1, lookback)
    if hourly > ceiling:
        findings.append(
            {
                "kind": "unusual_frequency",
                "spec": "8B.5.3",
                "detail": (
                    f"{len(rows)} rounds in {lookback} hours — {hourly} an hour "
                    f"against a ceiling of {ceiling} "
                    "(CHANCE_PLAYER_MAX_ROUNDS_PER_HOUR)."
                ),
                "evidence": {"rounds": len(rows), "hours": lookback, "per_hour": hourly},
            }
        )

    # ── timing ────────────────────────────────────────────────────────────────
    min_gap = int(getattr(settings, "chance_player_min_round_gap_ms", 250))
    min_commit = int(getattr(settings, "chance_player_min_commit_to_play_ms", 50))
    impossible: list[dict] = []
    previous: datetime | None = None
    for doc in rows:
        played = doc.get("played_at")
        committed = doc.get("committed_at")
        if isinstance(played, datetime) and isinstance(committed, datetime):
            gap_ms = int((played - committed).total_seconds() * 1_000)
            if gap_ms < 0:
                impossible.append(
                    {
                        "round_id": doc.get("round_id"),
                        "why": "played before it was committed",
                        "milliseconds": gap_ms,
                    }
                )
            elif gap_ms < min_commit and not doc.get("external"):
                impossible.append(
                    {
                        "round_id": doc.get("round_id"),
                        "why": (
                            "played sooner after its own commitment than the "
                            "commitment could have reached a device"
                        ),
                        "milliseconds": gap_ms,
                    }
                )
        if isinstance(played, datetime) and isinstance(previous, datetime):
            gap_ms = int((played - previous).total_seconds() * 1_000)
            if 0 <= gap_ms < min_gap:
                impossible.append(
                    {
                        "round_id": doc.get("round_id"),
                        "why": "two rounds closer together than a person can play",
                        "milliseconds": gap_ms,
                    }
                )
        if isinstance(played, datetime):
            previous = played
    if impossible:
        findings.append(
            {
                "kind": "impossible_timing",
                "spec": "8B.5.3",
                "detail": (
                    f"{len(impossible)} round(s) with timing a person cannot "
                    f"produce (CHANCE_PLAYER_MIN_ROUND_GAP_MS = {min_gap}, "
                    f"CHANCE_PLAYER_MIN_COMMIT_TO_PLAY_MS = {min_commit})."
                ),
                "evidence": {"rounds": impossible[:20], "count": len(impossible)},
            }
        )

    flag = await player_flag(player_uid)
    return {
        "player_uid": player_uid,
        "window_hours": lookback,
        "since": since,
        "rounds": len(rows),
        "staked": stake_sum,
        "paid_out": paid,
        "net": stake_sum - paid,
        "win_rate": win_rate,
        "findings": findings,
        "flagged": bool(findings),
        "frozen": bool((flag or {}).get("frozen")),
        "note": (
            "A finding is evidence for a person to review, never a verdict and "
            "never an automatic action (8B.5.4). Nothing here freezes an "
            "account, reverses a round or touches a balance."
        ),
    }


async def scan_player_anomalies(
    *, hours: int | None = None, limit: int = 200, now: datetime | None = None
) -> list[dict]:
    """Every player who played recently, checked. Spec 8B.5.3 / 8B.5.6.

    The Ops exception queue is built from this. It reads rounds and writes
    nothing at all — freezing is a separate, deliberate act.
    """
    lookback = int(hours or getattr(settings, "chance_anomaly_lookback_hours", 24))
    reference = now or _now()
    since = reference - timedelta(hours=lookback)

    players: list[str] = []
    seen: set[str] = set()
    cursor = get_db()[C.CHANCE_ROUNDS].find(
        {"status": str(RoundStatus.SETTLED), "played_at": {"$gte": since}}
    )
    async for doc in cursor:
        uid = str(doc.get("player_uid") or "")
        if uid and uid not in seen:
            seen.add(uid)
            players.append(uid)

    out: list[dict] = []
    for uid in players[: max(1, min(limit, 2_000))]:
        report = await player_anomalies(uid, hours=lookback, now=reference)
        if report["findings"]:
            out.append(report)
    return out


# ── Freezing a player — 8B.5.4 ────────────────────────────────────────────────


async def player_flag(player_uid: str) -> dict | None:
    doc = await get_db()[C.CHANCE_PLAYER_FLAGS].find_one(
        {"_id": str(player_uid or "").strip()}
    )
    return _public(doc) if doc else None


async def refuse_if_frozen(player_uid: str) -> None:
    """The one gate a frozen player meets. Spec 8B.5.4."""
    flag = await player_flag(player_uid)
    if flag and flag.get("frozen"):
        raise PlayerFrozen(
            "Chance play is paused on this account while a review is carried "
            "out. Nothing has been taken from your balance, no past round has "
            "been changed, and the rest of the app is unaffected. Support can "
            "tell you where the review has got to."
        )


async def freeze_player(
    *, player_uid: str, reason: str, actor: dict, evidence: Mapping | None = None
) -> dict:
    """Stop a player opening or playing a round. Spec 8B.5.4.

    **What this does.** From now on `commit_round` and `play_round` refuse for
    this player, on every mechanic. That is the whole of it.

    **What this does not do, and will not.**

      * It does not move a diamond. No stake is returned, no payout is clawed
        back, no balance is adjusted — 8B.5.4 says *frozen pending review, not
        reversed automatically*, and 0.5.5 says a restricted account keeps its
        balance while the review runs.
      * It does not reverse, void or amend a settled round. Every round stays
        exactly as it was recorded and stays queryable (8B.5.5). If a round
        genuinely has to be unwound, that is a money card with an owner's
        signature and a reason (8B.7.5), raised by a person who has looked.
      * It is not a ban. The account is untouched everywhere else in the
        product; only chance mechanics are paused.
      * It does not expire. A freeze ends when a person ends it, with a reason,
        which is the same rule a suspended mechanic follows and for the same
        reason: a timer means nobody ever has to look.
    """
    player_uid = str(player_uid or "").strip()
    if not player_uid:
        raise ChanceError("A freeze names the player it applies to.")
    reason = _reason(reason)
    _require_reviewer(actor, "freeze a player's chance activity")

    now = _now()
    who = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }
    existing = await player_flag(player_uid)
    state = {
        "frozen": True,
        "reason": reason,
        "flagged_at": now,
        "flagged_by": who,
        "evidence": dict(evidence) if evidence else None,
        "unfrozen_at": None,
        "unfrozen_by": None,
        "unfreeze_reason": None,
    }
    await get_db()[C.CHANCE_PLAYER_FLAGS].update_one(
        {"_id": player_uid},
        {"$set": state, "$setOnInsert": {"_id": player_uid, "created_at": now}},
        upsert=True,
    )
    await audit.record(
        actor=actor,
        action=Act.PLAYER_FROZEN,
        subject_type="user",
        subject_id=player_uid,
        reason=reason,
        before={"frozen": bool((existing or {}).get("frozen"))},
        after={"frozen": True},
        meta={
            "evidence": dict(evidence) if evidence else None,
            "note": (
                "Chance play only. No balance moved, no round was reversed and "
                "no account was banned (8B.5.4)."
            ),
        },
    )
    return {"player_uid": player_uid, **state}


async def unfreeze_player(*, player_uid: str, reason: str, actor: dict) -> dict:
    """End a freeze. A person, a reason, an audit entry. Spec 8B.5.4 / 8B.6.5."""
    player_uid = str(player_uid or "").strip()
    reason = _reason(reason)
    _require_reviewer(actor, "release a player's chance activity")

    flag = await player_flag(player_uid)
    if not flag or not flag.get("frozen"):
        raise ChanceError(f"{player_uid} is not frozen.")

    now = _now()
    who = {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
    }
    await get_db()[C.CHANCE_PLAYER_FLAGS].update_one(
        {"_id": player_uid},
        {
            "$set": {
                "frozen": False,
                "unfrozen_at": now,
                "unfrozen_by": who,
                "unfreeze_reason": reason,
            }
        },
    )
    await audit.record(
        actor=actor,
        action=Act.PLAYER_UNFROZEN,
        subject_type="user",
        subject_id=player_uid,
        reason=reason,
        before={"frozen": True, "since": flag.get("flagged_at")},
        after={"frozen": False},
        meta={"reviewed_by": who, "original_reason": flag.get("reason")},
    )
    return {"player_uid": player_uid, "frozen": False, "reviewed_by": who,
            "reason": reason}


def _require_reviewer(actor: dict, what: str) -> None:
    """Ops owns the exception queue (8B.5.6); owners may act anywhere.

    A named person, always — `deny_service_actor` in `app/core/deps.py` makes
    the same point about machine credentials elsewhere, and 8B.6.5 requires the
    reviewer of a flag to *be* a named person. A freeze applied by a service key
    would have no one to answer for it.
    """
    role = str(actor.get("role", ""))
    if role == str(Role.OWNER):
        return
    if role in {str(Role.OPS_ADMIN), str(Role.OPS_MEMBER)}:
        return
    raise ChanceError(
        f"Only Ops or an owner can {what}. 8B.5.6 gives the exception queue to "
        "Ops; a review with no named reviewer is not a review (8B.6.5)."
    )


async def frozen_players(limit: int = 200) -> list[dict]:
    cursor = (
        get_db()[C.CHANCE_PLAYER_FLAGS]
        .find({"frozen": True})
        .sort("flagged_at", -1)
        .limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]


async def player_activity(player_uid: str, limit: int = 200) -> dict:
    """One player's full chance history, reconstructable. Spec 8B.5.5."""
    player_uid = str(player_uid or "").strip()
    rounds = await player_rounds(player_uid, limit)
    totals = await _rounds_total(
        {"player_uid": player_uid, "status": str(RoundStatus.SETTLED)}
    )
    return {
        "player_uid": player_uid,
        "flag": await player_flag(player_uid),
        "totals": totals,
        "actual_rtp_percent": (
            percent(totals["paid_out"] * PROBABILITY_TOTAL // totals["staked"])
            if totals["staked"]
            else None
        ),
        "rounds": rounds,
        "note": (
            "Every round this player has ever played is retained, including "
            "voided and withheld ones. Nothing in this system deletes one."
        ),
    }


# ── The two queues — 8B.5.6 ───────────────────────────────────────────────────


async def exception_queue(*, hours: int | None = None) -> dict:
    """What Ops has to work through. Spec 8B.5.6.

    Suspended mechanics, frozen players, rounds with money withheld, and the
    players whose figures do not look like anybody else's. Ops owns this;
    `margin_report` below is Finance's, and they are separate calls because
    they are separate jobs — a queue that mixes "someone must decide" with
    "someone must understand" gets worked as neither.
    """
    suspended = [
        {
            "mechanic_id": str(doc["_id"]),
            "name": doc.get("name"),
            "suspended": doc.get("suspended"),
        }
        async for doc in get_db()[C.CHANCE_MECHANICS].find({"suspended": {"$ne": None}})
    ]
    withheld = []
    async for doc in (
        get_db()[C.CHANCE_ROUNDS]
        .find({"withheld": {"$gt": 0}})
        .sort("played_at", -1)
        .limit(200)
    ):
        withheld.append(
            {
                "round_id": doc.get("round_id"),
                "mechanic_id": doc.get("mechanic_id"),
                "player_uid": doc.get("player_uid"),
                "withheld": doc.get("withheld"),
                "paid": doc.get("payout"),
                "would_have_paid": doc.get("payout_before_ceilings"),
                "played_at": doc.get("played_at"),
                "ceilings_breached": doc.get("ceilings_breached"),
            }
        )
    return {
        "owner": "ops",
        "spec": "8B.5.6",
        "suspended_mechanics": suspended,
        "frozen_players": await frozen_players(),
        "withheld_payouts": withheld,
        "player_anomalies": await scan_player_anomalies(hours=hours),
        "note": (
            "Every item here needs a person. Nothing on this queue clears "
            "itself, expires or is settled by a scheduled job."
        ),
    }


async def margin_report(*, days: int | None = None) -> dict:
    """What Finance owns. Spec 8B.5.6 / 8B.7.1.

    Gross gaming revenue per mechanic — staked minus paid out — with actual
    against configured RTP beside it and the reserve position underneath.
    """
    window = int(days or getattr(settings, "chance_rtp_window_days", 7) or 7)
    rows: list[dict] = []
    async for doc in get_db()[C.CHANCE_MECHANICS].find({}).sort("_id", 1):
        mechanic_id = str(doc["_id"])
        exposure = await exposure_for(mechanic_id)
        divergence = await rtp_divergence(mechanic_id, days=window)
        rows.append(
            {
                "mechanic_id": mechanic_id,
                "name": doc.get("name"),
                "kind": doc.get("kind"),
                "suspended": bool(doc.get("suspended")),
                "gross_gaming_revenue": exposure["headline"]["net"],
                "staked": exposure["headline"]["staked"],
                "paid_out": exposure["headline"]["paid_out"],
                "withheld": exposure["headline"]["withheld"],
                "reserve": exposure["headline"]["reserve"],
                "headroom": exposure["headline"]["headroom"],
                "reserve_consumed_percent": exposure["headline"][
                    "reserve_consumed_percent"
                ],
                "rtp": divergence["pooled"],
                "per_day": divergence["per_day"],
            }
        )
    return {
        "owner": "finance",
        "spec": "8B.5.6 / 8B.7.1",
        "window_days": window,
        "mechanics": rows,
        "note": (
            "Gross gaming revenue is reported as its own line, separate from "
            "gifting and calls (8B.7.1). Actual RTP is stated with the "
            "confidence bound it was judged against, never as a bare percentage "
            "gap."
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  The signed machine door
# ══════════════════════════════════════════════════════════════════════════════
#
# Two kinds of caller reach a round, and **neither of them is a browser session
# and neither is a person**:
#
#   * the app tier, which holds the player's Firebase identity and plays on
#     their behalf. `app/core/deps.py` has no player session — `verify_session`
#     resolves a role out of the `staff` collection, so a user of the Android
#     app cannot hold one — and inventing one here would be a second
#     authority model beside the one this codebase has. So the app tier
#     authenticates as a *machine*, and the player uid it asserts is inside the
#     signature.
#   * a third-party game provider settling a round it ran (8B.1.4), which is
#     server-to-server by definition and never through the app.
#
# Both present the same proof: HMAC-SHA256 over a canonical string built from
# the method, the path and the exact bytes of the body, with a shared secret
# selected by a caller name. `hmac.compare_digest` compares it. A timestamp
# inside the signed string bounds a replay to five minutes, and the round's own
# state machine bounds it to zero.
#
# Secrets come from the environment — one variable, `CHANCE_SIGNING_KEYS`,
# holding `name:secret` pairs — and never from the database, a request or this
# repository. **Empty is the default**, and an empty variable means no machine
# can play anything: the same shape `service_key_weekly_accrual` uses, and the
# same reason. A deployment that has not been given keys is a deployment where
# no chance mechanic is live, which is where 8B.1.7 says everything starts.

SIGNING_KEYS_ENV = "CHANCE_SIGNING_KEYS"


def _signing_keys() -> dict[str, str]:
    raw = os.environ.get(SIGNING_KEYS_ENV, "")
    keys: dict[str, str] = {}
    for pair in raw.split(","):
        name, _, secret = pair.partition(":")
        name, secret = name.strip().lower(), secret.strip()
        if name and secret:
            keys[name] = secret
    return keys


def canonical_string(method: str, path: str, timestamp: str, body: bytes) -> str:
    """What is signed. The body is hashed rather than included.

    Signing a digest of the body rather than the body itself keeps the string
    short and, more usefully, makes the signature cover the bytes that arrived
    rather than a re-serialisation of them — a provider that formats JSON
    differently from us still verifies, and a body altered in flight by one
    character does not.
    """
    digest = hashlib.sha256(body or b"").hexdigest()
    return f"{method.upper()}\n{path}\n{timestamp}\n{digest}"


def sign_request(secret: str, method: str, path: str, timestamp: str, body: bytes) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        canonical_string(method, path, timestamp, body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_signed_caller(
    *,
    caller: str,
    signature: str,
    timestamp: str,
    method: str,
    path: str,
    body: bytes,
    now: datetime | None = None,
) -> dict:
    """Prove a machine is who it says it is, or refuse. Spec 8B.1.4.

    Returns the actor the round will be audited against: a system actor, whose
    uid carries the `system:` prefix `app/core/audit.py` reserves, so an owner
    reading `/audit` can tell a machine from a colleague at a glance.
    """
    name = str(caller or "").strip().lower()
    keys = _signing_keys()
    if not keys:
        raise SignatureError(
            "No signing keys are configured, so no machine may play or settle "
            f"anything. Set {SIGNING_KEYS_ENV}. Nothing is live by default."
        )
    secret = keys.get(name)
    if not secret:
        # Deliberately the same message as a bad signature: a caller probing
        # names should not learn which ones exist.
        raise SignatureError("The request signature could not be verified.")

    try:
        when = datetime.fromtimestamp(int(str(timestamp).strip()), tz=timezone.utc)
    except (TypeError, ValueError) as exc:
        raise SignatureError("The request signature could not be verified.") from exc

    reference = now or _now()
    if abs((reference - when).total_seconds()) > CALLBACK_MAX_AGE_SECONDS:
        raise SignatureError(
            "This request is outside the "
            f"{CALLBACK_MAX_AGE_SECONDS}-second signing window. A valid "
            "signature is not a fresh one; a captured request is not replayed "
            "here."
        )

    expected = sign_request(secret, method, path, str(timestamp).strip(), body)
    if not hmac.compare_digest(expected, str(signature or "")):
        raise SignatureError("The request signature could not be verified.")

    return {
        "uid": f"{audit.SYSTEM_UID_PREFIX}chance:{name}",
        "name": f"{name} (signed caller)",
        "role": "system",
        "team": None,
        "caller": name,
    }


async def settle_external_round(
    *,
    provider: str,
    payload: Mapping,
    actor: dict,
) -> dict:
    """Settle a round a third party ran. Spec 8B.1.4.

    The signature is already verified by the time this is called — that is the
    door, and it is `verify_signed_caller`. What happens here is the part that
    matters: **the payout is recomputed on this side**. The provider states the
    stake and the multiplier it drew; this server multiplies them itself, floors
    the result itself, applies its own maximum single win (8B.2.6) and refuses
    the settlement outright if the provider's own figure disagrees. A signed
    message is proof of who sent it, never proof that the number in it is right.

    **What a provider has to supply to be integrated here.** All of it before a
    single round is played, and none of it negotiable:

      1. a shared signing secret and a key id, delivered out of band, rotatable
         without a deployment of theirs or ours;
      2. HMAC-SHA256 signatures over `canonical_string(...)` above, with the
         unix timestamp they signed, in `X-Chance-Timestamp`;
      3. a settlement reference unique per round and **stable across retries**,
         so their retry is our idempotency key rather than our second payout;
      4. the round's stake and its multiplier in basis points, plus the payout
         they computed, in the same units — so the two arithmetics can be
         compared rather than trusted;
      5. the player id in *our* namespace, and the country the round was played
         in, because both are ours to record and neither is theirs to invent;
      6. their own RNG evidence: a certification, or a commit-reveal we can
         republish to the player, since our own fairness proof stops at our
         boundary and saying otherwise about somebody else's draw would be a
         claim we cannot support;
      7. a daily reconciliation file of every settled round, so a settlement
         that never arrived is a discrepancy we find rather than one a player
         reports;
      8. a documented behaviour for a settlement we reject — the money never
         left this side, and their side has to agree the round is void.
    """
    config = await live_config(str(payload.get("mechanic_id") or ""))
    evaluation = config["evaluation"]
    declared = (evaluation.get("provider") or {}).get("name")
    if not declared or declared != str(provider or "").strip().lower():
        raise SignatureError(
            "This mechanic is not configured to settle through that provider. "
            "The provider is part of the signed configuration (8B.2.8)."
        )

    reference = str(payload.get("provider_round_ref") or "").strip()
    if not reference:
        raise RoundError("A settlement needs a provider round reference.")
    player = str(payload.get("player_uid") or "").strip()
    if not player:
        raise RoundError("A settlement needs the player it belongs to.")
    country = str(payload.get("country") or "").strip().upper()
    if country not in (evaluation.get("enabled_countries") or []):
        raise MechanicUnavailable("No such mechanic.")

    # 8B.4.5 / 8B.5.4 — the same two stops an internal round meets, and for the
    # same reason. A suspended mechanic accepts nothing, including a settlement
    # from a provider who has already run the round on their side: 8B.1.4's
    # eighth requirement is that a provider has a documented behaviour for a
    # settlement we reject, and this is one of the cases it covers. The refusal
    # is `MechanicUnavailable` in the usual words — a provider is not a player,
    # but there is nothing to be gained by giving the two different answers.
    await _refuse_if_suspended(str(config["mechanic_id"]))
    await refuse_if_frozen(player)

    total_stake = _whole(payload.get("total_stake"), "total_stake")
    multiplier_bp = _whole(payload.get("multiplier_bp"), "multiplier_bp")
    claimed_payout = _whole(payload.get("payout"), "payout")
    if total_stake <= 0 or multiplier_bp < 0:
        raise RoundError("A settlement needs a positive stake and a real multiplier.")

    payout, capped, uncapped = payout_for(
        total_stake, multiplier_bp, evaluation["max_single_win"]
    )
    if claimed_payout != uncapped:
        raise RoundError(
            f"The provider's payout of {claimed_payout} is not "
            f"{total_stake} × {multiplier_bp} basis points = {uncapped}. "
            "Nothing was credited. A signed message proves who sent it, not "
            "that the arithmetic in it is right."
        )

    rid = f"ext:{provider}:{reference}"
    now = _now()
    doc = {
        "round_id": rid,
        "mechanic_id": config["mechanic_id"],
        "config_version": int(config["version"]),
        "player_uid": player,
        "country": country,
        "status": str(RoundStatus.RECORDED),
        "external": True,
        "provider": str(provider).strip().lower(),
        "provider_round_ref": reference,
        "unit_stake": total_stake,
        "quantity": 1,
        "total_stake": total_stake,
        "multiplier_bp": multiplier_bp,
        "payout": payout,
        "uncapped_payout": uncapped,
        "capped": capped,
        "max_single_win": evaluation["max_single_win"],
        "rtp_ppm_at_play": evaluation["rtp_ppm"],
        "committed_at": now,
        "played_at": now,
        "settled_at": None,
        "server_seed": None,
        "server_seed_hash": None,
        "nonce": None,
        "client_entropy": None,
        "outcome_index": None,
        "fairness_note": (
            "Drawn by the provider, not by this server. Our fairness proof stops "
            "at our boundary; the provider's own evidence is what covers the "
            "draw."
        ),
        "stake_ledger_id": None,
        "payout_ledger_id": None,
    }
    try:
        # Recorded before it is paid, exactly as an internal round is (8B.1.5) —
        # and the unique index on `provider_round_ref` is what makes a retried
        # callback settle once.
        await get_db()[C.CHANCE_ROUNDS].insert_one(doc)
    except DuplicateKeyError:
        existing = await get_db()[C.CHANCE_ROUNDS].find_one(
            {"provider_round_ref": reference}
        )
        return {
            "settled": True,
            "duplicate": True,
            "round_id": str((existing or {}).get("round_id") or rid),
            "payout": int((existing or {}).get("payout") or 0),
            "note": (
                "This settlement reference was already applied. Nothing was paid "
                "a second time."
            ),
        }

    # 8B.4 — a provider's round is exposure like any other, and the reserve does
    # not care who drew the outcome. The counters are touched **after** the
    # insert, so the unique index on `provider_round_ref` is what stops a
    # retried callback consuming a day's headroom twice; and the final figures
    # are written back onto the round before anything is credited (8B.1.5).
    await _record_stake(
        mechanic_id=str(config["mechanic_id"]),
        player_uid=player,
        stake=total_stake,
        when=now,
    )
    gate = await _apply_ceilings(
        mechanic_id=str(config["mechanic_id"]),
        player_uid=player,
        payout=payout,
        exposure=evaluation.get("exposure") or {},
        when=now,
        round_id=rid,
        actor=actor,
    )
    payout = gate["paid"]
    await get_db()[C.CHANCE_ROUNDS].update_one(
        {"round_id": rid},
        {
            "$set": {
                "payout": payout,
                "payout_before_ceilings": gate["before"],
                "withheld": gate["withheld"],
                "ceiling_capped": gate["capped_by_round_ceiling"],
                "ceilings_breached": gate["breached"],
                "exposure_day": gate["day"],
                "variance_num_at_play": (evaluation.get("exposure") or {}).get(
                    "variance_numerator"
                ),
            }
        },
    )

    reason = (
        f"{config['mechanic_id']} external round {reference} via {provider}: "
        f"{total_stake} staked, {multiplier_bp} bp multiplier"
    )
    await audit.record(
        actor=actor,
        action=Act.EXTERNAL_SETTLEMENT,
        subject_type="chance_round",
        subject_id=rid,
        reason=reason,
        after={
            "player_uid": player,
            "total_stake": total_stake,
            "multiplier_bp": multiplier_bp,
            "payout": payout,
            "capped": capped,
        },
        meta={
            "provider": str(provider).strip().lower(),
            "provider_round_ref": reference,
            "country": country,
            "recomputed_on_this_side": True,
        },
    )

    payout_ledger_id = None
    if payout > 0:
        movement = await apply_movement(
            Movement(
                holder_type=HolderType.USER,
                holder_id=player,
                currency=Currency.DIAMONDS,
                amount=payout,
                action=Act.PAYOUT,
                reason=reason,
                actor=actor,
                idempotency_key=f"chance:{rid}:payout",
                meta={
                    "mechanic_id": config["mechanic_id"],
                    "provider": str(provider).strip().lower(),
                    "provider_round_ref": reference,
                    "capped": capped,
                },
            )
        )
        payout_ledger_id = movement.ledger_id

    await get_db()[C.CHANCE_ROUNDS].update_one(
        {"round_id": rid},
        {
            "$set": {
                "status": str(RoundStatus.SETTLED),
                "settled_at": _now(),
                "payout_ledger_id": payout_ledger_id,
            }
        },
    )
    return {
        "settled": True,
        "duplicate": False,
        "round_id": rid,
        "payout": payout,
        "capped": capped,
        "uncapped_payout": uncapped,
        "withheld": gate["withheld"],
        "ceilings_breached": gate["breached"],
    }
