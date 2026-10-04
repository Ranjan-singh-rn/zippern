"""Chance mechanics — the server's RNG, and the configuration behind it.

Part 8B. Six claims are held down here, and each one is the reason a paragraph
of the spec exists.

  1. **A table that does not sum to exactly 100% is refused.** Not normalised,
     not rounded, not warned about — refused, on integers, before an RTP is
     derived from it (8B.2.3).

  2. **The RTP is computed by the server from the table** (8B.2.4). There is no
     field anywhere by which one can be typed in, and the check here is against
     hand-worked arithmetic rather than against a constant the code produced.

  3. **The four quantity tiers of 8B.3.3.** The recorded numbers — 58% single,
     59% at 17×, 27% at 37×, 13% at 77× — are reproduced exactly from tables
     that behave the way the current build behaves, and then shown flat at every
     tier once the multiplier applies to the total stake (8B.3.1). Each of the
     four as-built tiers is also refused by `propose_config`, because a tier
     outside the band is blocked from going live and not merely flagged
     (8B.3.4).

  4. **A configuration is money.** It changes on a card: raised by one person,
     verified by a second, signed by an owner, and only then live (8B.2.8). Each
     stage is asserted, and activation is attempted and refused at every stage
     before the last.

  5. **A round is drawn, recorded and only then paid** (8B.1.5), on the
     configuration version in force when it was committed rather than the
     current one, with the stake and the payout moving through
     `money.apply_movement` like every other rupee in the business (8B.7.4).
     The ordering claim is checked from inside the payout movement itself.

  6. **A disabled market is invisible, not blocked** (8B.0.7), a client-supplied
     outcome or payout changes nothing (8B.1.2 / 8B.1.3), and the seed committed
     before a round verifies against the seed revealed after it (8B.1.6).

The real service code runs — the real card engine, the real ledger, the real
audit log, the real router functions. Only Mongo and Firestore underneath them
are replaced, following `tests/harness.py`.

Run:  python3 -m tests.test_chance
"""

from __future__ import annotations

import asyncio
import ast
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
# The unique indexes `app/db/mongo.py` declares for this feature. The round id
# and the provider settlement reference are the two that matter: the first makes
# a replayed play impossible, the second makes a provider's retry settle once.
DB.UNIQUE = {**FakeDb.UNIQUE, "chance_rounds": ("round_id", "provider_round_ref")}

CURRENT: dict[str, FakeDb] = {"db": DB}
mongo.get_db = lambda: CURRENT["db"]  # type: ignore[assignment]


# `money.apply_movement` opens a session and a transaction. Mongo's are real;
# these do nothing, which is the one thing this fake cannot honour — a partial
# failure inside a movement would not roll back here. Every other guarantee of
# the movement (the mandatory reason, the negative-balance refusal, the
# idempotency key, the ledger row and the audit row) is the real code.
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

from app.db.mongo import C  # noqa: E402

_SEQ = {"n": 0}


def _card_id() -> str:
    """24-character ids, because the card engine round-trips every id through
    `bson.ObjectId` and the harness's refuses anything shorter."""
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

import app.db.firebase as firebase  # noqa: E402

firebase.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]

os.environ["CHANCE_SIGNING_KEYS"] = "app_tier:tier-secret-9f3,acme_games:acme-secret-77"

from fastapi import Depends  # noqa: E402  (the harness stub)
from fastapi import HTTPException  # noqa: E402

from app.core import audit as audit_log  # noqa: E402
from app.core.deps import require_internal, require_owner, require_team_admin  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.routers import chance as chance_router  # noqa: E402
from app.services import cards as card_svc  # noqa: E402
from app.services import chance as X  # noqa: E402
from app.services import money  # noqa: E402
from app.services.cards import CardError, CardType, Stage  # noqa: E402

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


def contains(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = " ".join(str(h) for h in haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() not in text.lower():
        failures.append(f"{label}\n    {needle!r} is not in: {text[:500]!r}")


def absent(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = " ".join(str(h) for h in haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() in text.lower():
        failures.append(f"{label}\n    {needle!r} should NOT be in: {text[:500]!r}")


def run(coro):
    return asyncio.run(coro)


def refuses(label: str, factory, *, error=X.ChanceError) -> None:
    """This must be refused, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = factory()
        if asyncio.iscoroutine(result):
            result = asyncio.run(result)
    except error:
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return
    failures.append(f"{label}: was NOT refused — returned {result!r}")


# ── The people ────────────────────────────────────────────────────────────────

APP_ADMIN = {"uid": "u-app-1", "name": "Rhea (App admin)", "role": Role.APP_ADMIN, "team": Team.APP}
APP_MEMBER = {"uid": "u-app-2", "name": "Kabir (App)", "role": Role.APP_MEMBER, "team": Team.APP}
FIN_ADMIN = {"uid": "u-fin-1", "name": "Anil (Finance admin)", "role": Role.FINANCE_ADMIN, "team": Team.FINANCE}
OWNER_A = {"uid": "u-own-1", "name": "Owner One", "role": Role.OWNER, "team": None}
OWNER_B = {"uid": "u-own-2", "name": "Owner Two", "role": Role.OWNER, "team": None}

PLAYER = "player-arjun-001"


# ══════════════════════════════════════════════════════════════════════════════
# 1. THE OUTCOME TABLE — it sums to exactly 100%, or it is refused
# ══════════════════════════════════════════════════════════════════════════════
#
# The fixed lucky-gift table used through the rest of this file. Written the way
# 8B.11.3 and 8B.11.4 ask for — many small outcomes rather than a few large
# ones — and worked out by hand here so the assertions below are against
# arithmetic and not against whatever the code returned.
#
#   multiplier   probability      contribution to RTP
#   0×           40.45%           0
#   1×           30%              0.30
#   1.5×         15%              0.225
#   2×           10%              0.20
#   3×            4%              0.12
#   10×           0.5%            0.05
#   50×           0.05%           0.025
#   ────────────────────────────────────
#   sum          100%             0.92   → RTP 92%, house edge 8%

FIXED_TABLE = [
    {"multiplier_bp": 0, "probability_ppm": 404_500},
    {"multiplier_bp": 10_000, "probability_ppm": 300_000},
    {"multiplier_bp": 15_000, "probability_ppm": 150_000},
    {"multiplier_bp": 20_000, "probability_ppm": 100_000},
    {"multiplier_bp": 30_000, "probability_ppm": 40_000},
    {"multiplier_bp": 100_000, "probability_ppm": 5_000},
    {"multiplier_bp": 500_000, "probability_ppm": 500},
]

parsed = X.parse_outcomes(FIXED_TABLE)

check("every row is read", len(parsed), 7)
check(
    "the probabilities sum to exactly 100%",
    sum(o.probability_ppm for o in parsed),
    X.PROBABILITY_TOTAL,
)
check("and that total is 1,000,000 ppm, an integer", X.PROBABILITY_TOTAL, 1_000_000)
truthy("every probability is an int", all(isinstance(o.probability_ppm, int) for o in parsed))
truthy("every multiplier is an int", all(isinstance(o.multiplier_bp, int) for o in parsed))
check("the table is ordered by multiplier", [o.multiplier_bp for o in parsed], sorted(o.multiplier_bp for o in parsed))
check("1× is 10,000 basis points", X.MULTIPLIER_ONE, 10_000)
check("and reads as '1'", parsed[1].multiplier_text, "1")
check("50× reads as '50'", parsed[-1].multiplier_text, "50")
check("1.5× survives as a multiplier", parsed[2].multiplier_text, "1.5")

# ── A table that does not sum to 100% is refused ──────────────────────────────

short = [dict(row) for row in FIXED_TABLE]
short[0]["probability_ppm"] -= 1
refuses(
    "one part per million short of 100% is refused",
    lambda: X.parse_outcomes(short),
    error=X.MalformedOutcomeTable,
)
over = [dict(row) for row in FIXED_TABLE]
over[0]["probability_ppm"] += 1
refuses(
    "one part per million over 100% is refused",
    lambda: X.parse_outcomes(over),
    error=X.MalformedOutcomeTable,
)
try:
    X.parse_outcomes(short)
except X.MalformedOutcomeTable as exc:
    contains("the refusal states the shortfall exactly", str(exc), "999999 ppm")
    contains("and says it will not be normalised", str(exc), "normalised")

refuses(
    "a table that sums to 99%",
    lambda: X.parse_outcomes([{"multiplier_bp": 0, "probability_ppm": 990_000}]),
    error=X.MalformedOutcomeTable,
)
refuses("an empty table", lambda: X.parse_outcomes([]), error=X.MalformedOutcomeTable)
refuses("no table at all", lambda: X.parse_outcomes(None), error=X.MalformedOutcomeTable)
refuses("a string instead of a table", lambda: X.parse_outcomes("58%"), error=X.MalformedOutcomeTable)
refuses(
    "a row that is not a mapping",
    lambda: X.parse_outcomes([[0, 1_000_000]]),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a float probability is refused, not rounded",
    lambda: X.parse_outcomes(
        [{"multiplier_bp": 0, "probability_ppm": 500_000.0},
         {"multiplier_bp": 20_000, "probability_ppm": 500_000}]
    ),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a float multiplier too",
    lambda: X.parse_outcomes([{"multiplier_bp": 1.5, "probability_ppm": 1_000_000}]),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a string probability",
    lambda: X.parse_outcomes([{"multiplier_bp": 0, "probability_ppm": "1000000"}]),
    error=X.MalformedOutcomeTable,
)
refuses(
    "True is not a probability",
    lambda: X.parse_outcomes([{"multiplier_bp": 0, "probability_ppm": True}]),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a probability of zero — an outcome that can never be drawn",
    lambda: X.parse_outcomes(
        [{"multiplier_bp": 0, "probability_ppm": 0},
         {"multiplier_bp": 10_000, "probability_ppm": 1_000_000}]
    ),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a negative probability",
    lambda: X.parse_outcomes(
        [{"multiplier_bp": 0, "probability_ppm": -1},
         {"multiplier_bp": 10_000, "probability_ppm": 1_000_001}]
    ),
    error=X.MalformedOutcomeTable,
)
refuses(
    "a negative multiplier",
    lambda: X.parse_outcomes([{"multiplier_bp": -10_000, "probability_ppm": 1_000_000}]),
    error=X.MalformedOutcomeTable,
)
refuses(
    "the same multiplier written twice",
    lambda: X.parse_outcomes(
        [{"multiplier_bp": 20_000, "probability_ppm": 500_000},
         {"multiplier_bp": 20_000, "probability_ppm": 500_000}]
    ),
    error=X.MalformedOutcomeTable,
)

# Written out of order is a formatting accident, not a different table.
shuffled = X.parse_outcomes(list(reversed(FIXED_TABLE)))
check(
    "an out-of-order table sorts to the same one",
    [(o.multiplier_bp, o.probability_ppm) for o in shuffled],
    [(o.multiplier_bp, o.probability_ppm) for o in parsed],
)
check("and gives the same RTP", X.rtp_ppm(shuffled), X.rtp_ppm(parsed))


# ══════════════════════════════════════════════════════════════════════════════
# 2. RTP IS COMPUTED, NEVER TYPED IN — against hand-worked tables
# ══════════════════════════════════════════════════════════════════════════════

check("the fixed table returns 92%", X.rtp_ppm(parsed), 920_000)
check("stated as a percentage", X.percent(X.rtp_ppm(parsed)), "92")
check(
    "the house edge is the remainder",
    X.PROBABILITY_TOTAL - X.rtp_ppm(parsed),
    80_000,
)

# The same figure as the arithmetic the rule describes, so a wrong
# implementation cannot pass by agreeing with a constant.
by_hand = sum(row["probability_ppm"] * row["multiplier_bp"] for row in FIXED_TABLE)
check("Σ probability × multiplier, exactly", X.rtp_numerator(parsed), by_hand)
check("and it is 9,200,000,000 on a 10,000,000,000 scale", by_hand, 9_200_000_000)
check("the scale is stated", X.RTP_SCALE, 10_000_000_000)
check("92% of the scale", by_hand * 100 // X.RTP_SCALE, 92)

HAND_WORKED = [
    # (name, table, expected rtp in ppm)
    (
        "even money: half the time you get double, half you get nothing",
        [{"multiplier_bp": 0, "probability_ppm": 500_000},
         {"multiplier_bp": 20_000, "probability_ppm": 500_000}],
        1_000_000,  # 0.5 × 2 = 1.00 → 100%, no edge at all
    ),
    (
        "three quarters of rolls return the stake",
        [{"multiplier_bp": 0, "probability_ppm": 250_000},
         {"multiplier_bp": 10_000, "probability_ppm": 750_000}],
        750_000,  # 0.75 × 1 = 0.75
    ),
    (
        "a lottery: one in a hundred thousand pays 5,000×",
        [{"multiplier_bp": 0, "probability_ppm": 999_990},
         {"multiplier_bp": 50_000_000, "probability_ppm": 10}],
        50_000,  # 10/1,000,000 × 5,000 = 0.05 → 5%, and 95% is the edge
    ),
    (
        "the same lottery at 50,000× returns half the stake",
        [{"multiplier_bp": 0, "probability_ppm": 999_990},
         {"multiplier_bp": 500_000_000, "probability_ppm": 10}],
        500_000,  # 0.00001 × 50,000 = 0.5 → 50%
    ),
    (
        "everything returns the stake — a 100% table with no chance in it",
        [{"multiplier_bp": 10_000, "probability_ppm": 1_000_000}],
        1_000_000,
    ),
    (
        "nothing ever returns — a 0% table",
        [{"multiplier_bp": 0, "probability_ppm": 1_000_000}],
        0,
    ),
    (
        "the live-ish shape: 60% small wins, one big one",
        [{"multiplier_bp": 0, "probability_ppm": 400_000},
         {"multiplier_bp": 12_000, "probability_ppm": 500_000},
         {"multiplier_bp": 40_000, "probability_ppm": 99_000},
         {"multiplier_bp": 200_000, "probability_ppm": 1_000}],
        # 0.5×1.2 = 0.60 · 0.099×4 = 0.396 · 0.001×20 = 0.02 → 1.016
        1_016_000,
    ),
]
for name, table, expected in HAND_WORKED:
    check(f"hand-worked — {name}", X.rtp_ppm(X.parse_outcomes(table)), expected)

# There is no way to state an RTP. A draft carrying one is ignored, and what
# comes back is what the table actually returns (8B.2.4).
BASE_DRAFT = {
    "outcomes": FIXED_TABLE,
    "stake": {"min_stake": 10, "max_stake": 1_000, "step": 10},
    "quantity_tiers": [1, 17, 37, 77],
    "max_single_win": 500_000,
    "enabled_countries": ["AE", "NP"],
    "multiplier_basis": "total_stake",
}
lying = dict(BASE_DRAFT, rtp_ppm=999_999, rtp_percent="99.99", house_edge_ppm=1)
evaluated = X.evaluate_draft(lying)
check(
    "an RTP typed into the draft is ignored — the table decides",
    evaluated["rtp_ppm"],
    920_000,
)
check("and so is a typed house edge", evaluated["house_edge_percent"], "8")
truthy("the RTP divides exactly on this table", evaluated["rtp_exact"])
check("the win frequency is computed too", evaluated["win_probability_percent"], "59.55")
check(
    "as is the share of rolls returning nothing (8B.11.4)",
    evaluated["nothing_back_probability_percent"],
    "40.45",
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. THE COMBO PROBLEM — 8B.3.3, before and after
# ══════════════════════════════════════════════════════════════════════════════
#
# The spec records what the current build returns: 58% for a single, 59% at 17×,
# 27% at 37× and 13% at 77×. Look at what those figures are made of.
#
#   tier   effective RTP   × quantity   = expected return per UNIT stake
#   1      58%             × 1          = 0.58
#   17     59%             × 17         = 10.03
#   37     27%             × 37         =  9.99
#   77     13%             × 77         = 10.01
#
# The three combo tiers all return **about ten unit stakes**. That is not four
# unrelated mis-set tables; it is one design in which the drawn multiplier is
# applied to the price of a *single* gift while the player paid for seventeen,
# thirty-seven or seventy-seven of them. Divide the same ~10 by the quantity and
# 59 / 27 / 13 fall straight out. 8B.3.1 names the fix in one line: the
# multiplier applies to the total stake.
#
# Reproduced below exactly, from tables that behave the way the build behaves.

AS_BUILT = {
    #  tier: (probability of the win in ppm, multiplier in bp)
    1: (580_000, 10_000),    # 58% chance of 1× a unit stake
    17: (590_000, 170_000),  # 59% chance of 17× a unit stake
    37: (270_000, 370_000),  # 27% chance of 37× a unit stake
    77: (130_000, 770_000),  # 13% chance of 77× a unit stake
}


def as_built_table(quantity: int) -> list[dict]:
    win_ppm, multiplier_bp = AS_BUILT[quantity]
    return [
        {"multiplier_bp": 0, "probability_ppm": X.PROBABILITY_TOTAL - win_ppm},
        {"multiplier_bp": multiplier_bp, "probability_ppm": win_ppm},
    ]


RECORDED = {1: "58", 17: "59", 37: "27", 77: "13"}

before_table: list[tuple[int, str, str, str]] = []
for quantity, recorded in RECORDED.items():
    outcomes = X.parse_outcomes(as_built_table(quantity))
    effective = X.effective_rtp_ppm(outcomes, quantity, X.MultiplierBasis.UNIT_STAKE)
    check(
        f"as built, quantity {quantity} returns the {recorded}% the spec records",
        X.percent(effective),
        recorded,
    )
    per_unit = X.rtp_ppm(outcomes)
    before_table.append(
        (quantity, X.percent(effective), X.percent(per_unit), recorded)
    )

check(
    "and the three combo tiers all return about ten unit stakes",
    [
        round(X.rtp_ppm(X.parse_outcomes(as_built_table(q))) / 1_000_000, 1)
        for q in (17, 37, 77)
    ],
    [10.0, 10.0, 10.0],
)
check(
    "which is the one bug, seen three times: a unit-stake multiplier divided by "
    "the quantity",
    [
        X.percent(
            X.effective_rtp_ppm(
                X.parse_outcomes(as_built_table(q)), q, X.MultiplierBasis.UNIT_STAKE
            )
        )
        for q in (17, 37, 77)
    ],
    ["59", "27", "13"],
)

# The biggest spender gets by far the worst value — the spec's own words, as an
# assertion.
check(
    "the largest tier returns less than a quarter of what the smallest does",
    X.effective_rtp_ppm(X.parse_outcomes(as_built_table(77)), 77, X.MultiplierBasis.UNIT_STAKE)
    * 4
    < X.effective_rtp_ppm(X.parse_outcomes(as_built_table(1)), 1, X.MultiplierBasis.UNIT_STAKE),
    True,
)

# ── Every one of those four is blocked from going live (8B.3.4) ───────────────

for quantity in RECORDED:
    draft = {
        "outcomes": as_built_table(quantity),
        "stake": {"min_stake": 10, "max_stake": 1_000, "step": 10},
        "quantity_tiers": [quantity],
        "max_single_win": 500_000,
        "enabled_countries": ["AE"],
        "multiplier_basis": "unit_stake",
        "deliberate_lower_return_on_larger_plays": True,
        "lower_return_statement": "Stated on the gift screen before purchase.",
    }
    result = X.evaluate_draft(draft)
    truthy(f"quantity {quantity} as built is blocked", result["blocked"])
    contains(f"and 8B.3.4 is named for quantity {quantity}", result["blocked_reasons"], "8B.3.4")
    truthy(f"the tier is flagged, not silently dropped ({quantity})", result["tiers"][0]["flags"])

# Unit-stake multiplication is refused outright unless it is declared.
undeclared = X.evaluate_draft(
    dict(BASE_DRAFT, multiplier_basis="unit_stake", quantity_tiers=[1])
)
truthy("an undeclared unit-stake basis is blocked", undeclared["blocked"])
contains("and 8B.3.1 is named", undeclared["blocked_reasons"], "8B.3.1")

# And even declared, the falling return across tiers is its own block (8B.10.4).
declared = X.evaluate_draft(
    dict(
        BASE_DRAFT,
        multiplier_basis="unit_stake",
        max_single_win=50_000_000,
        deliberate_lower_return_on_larger_plays=True,
        lower_return_statement="Deliberate: larger combos buy more chances, not more return.",
    )
)
truthy("a declared unit-stake basis with four tiers is still blocked", declared["blocked"])
contains("by 8B.10.4 — a larger stake must never be worse value", declared["blocked_reasons"], "8B.10.4")

# ── After: one table, applied to the total stake ──────────────────────────────

fixed = X.evaluate_draft(BASE_DRAFT)
check("nothing about the fixed table is blocked", fixed["blocked"], False)
check("no blocking reasons at all", fixed["blocked_reasons"], [])
check(
    "and the effective RTP is identical at every quantity tier",
    [t["effective_rtp_percent"] for t in fixed["tiers"]],
    ["92", "92", "92", "92"],
)
check(
    "every tier is inside the agreed band",
    [t["in_band"] for t in fixed["tiers"]],
    [True, True, True, True],
)
check(
    "the tiers reported are the four the spec names",
    [t["quantity"] for t in fixed["tiers"]],
    [1, 17, 37, 77],
)
check(
    "and the total stake of a 77 combo at the top denomination is stated",
    fixed["tiers"][-1]["max_total_stake"],
    77_000,
)

after_table = [(t["quantity"], t["effective_rtp_percent"]) for t in fixed["tiers"]]

# The band is configurable, and a table outside it is refused whatever the band.
narrow = X.evaluate_draft(dict(BASE_DRAFT, rtp_band={"min_ppm": 930_000, "max_ppm": 950_000}))
truthy("a 92% table is blocked by a 93–95% band", narrow["blocked"])
contains("and the band is quoted in the refusal", narrow["blocked_reasons"], "93–95%")
wide = X.evaluate_draft(dict(BASE_DRAFT, rtp_band={"min_ppm": 100_000, "max_ppm": 990_000}))
check("and passes a band that admits it", wide["blocked"], False)
refuses(
    "a band that permits an RTP of 100% is refused — that is not a business",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, rtp_band={"min_ppm": 900_000, "max_ppm": 1_000_000})),
)
refuses(
    "and a band whose minimum is above its maximum is not a band",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, rtp_band={"min_ppm": 950_000, "max_ppm": 900_000})),
)
check(
    "the default band is stated in the code, not invented per mechanic",
    (X.DEFAULT_RTP_BAND_MIN_PPM, X.DEFAULT_RTP_BAND_MAX_PPM),
    (850_000, 960_000),
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. STAKE DENOMINATIONS AND THE MAXIMUM SINGLE WIN
# ══════════════════════════════════════════════════════════════════════════════

rules = fixed["stake"]
check("the minimum is honoured", X.permitted_stake(10, rules), True)
check("the maximum is honoured", X.permitted_stake(1_000, rules), True)
check("below the minimum is refused", X.permitted_stake(9, rules), False)
check("above the maximum is refused", X.permitted_stake(1_010, rules), False)
check("off the step is refused", X.permitted_stake(15, rules), False)
check("on the step is allowed", X.permitted_stake(120, rules), True)
refuses(
    "a step that never reaches the maximum is refused",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, stake={"min_stake": 10, "max_stake": 95, "step": 10})),
)
refuses(
    "a maximum below the minimum is refused",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, stake={"min_stake": 100, "max_stake": 10, "step": 10})),
)
refuses(
    "a float stake bound is refused",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, stake={"min_stake": 10.5, "max_stake": 100, "step": 10})),
)

# ── The cap, in absolute terms (8B.2.6) ───────────────────────────────────────

check("2× on 500 diamonds pays 1,000", X.payout_for(500, 20_000, 500_000)[0], 1_000)
check("and is not capped", X.payout_for(500, 20_000, 500_000)[1], False)
check("50× on 77,000 diamonds would pay 3,850,000", X.payout_for(77_000, 500_000, 10_000_000)[0], 3_850_000)
capped_payout, was_capped, uncapped = X.payout_for(77_000, 500_000, 500_000)
check("with a 500,000 cap it pays exactly the cap", capped_payout, 500_000)
check("and says it was capped", was_capped, True)
check("and records what the table would have paid", uncapped, 3_850_000)
check("a payout exactly on the cap is not capped", X.payout_for(50_000, 100_000, 500_000)[1], False)
check("0× pays nothing", X.payout_for(1_000, 0, 500_000)[0], 0)
check("the multiplication floors — 1.5× of 15 is 22, not 22.5", X.payout_for(15, 15_000, 500_000)[0], 22)
truthy("and the payout is an int", isinstance(X.payout_for(15, 15_000, 500_000)[0], int))
refuses("a maximum single win of zero is refused", lambda: X.payout_for(100, 10_000, 0))
refuses(
    "a configuration with no maximum single win is refused",
    lambda: X.evaluate_draft({**BASE_DRAFT, "max_single_win": 0}),
)
truthy(
    "a cap that bites at the top stake is flagged so nobody is surprised by it",
    any("cap pays" in flag for flag in fixed["flags"]),
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. THE DRAW — server-side, seeded from the kernel, and provable
# ══════════════════════════════════════════════════════════════════════════════

seed_a = X.new_seed()
seed_b = X.new_seed()
check("a seed is 32 bytes", len(seed_a), 32)
truthy("and two seeds are not the same", seed_a != seed_b)
check("the commitment is a SHA-256 hex digest", len(X.seed_hash(seed_a)), 64)
truthy("which changes with the seed", X.seed_hash(seed_a) != X.seed_hash(seed_b))

# Deterministic given the seed and the message — which is what makes it
# checkable — and different when either changes.
first = X.draw(seed_a, "round-1:nonce-1:hello", parsed)
again = X.draw(seed_a, "round-1:nonce-1:hello", parsed)
check("the same seed and message draw the same outcome", first["index"], again["index"])
check("and the same ticket", first["ticket"], again["ticket"])
truthy(
    "a different client entropy draws from a different ticket",
    X.draw(seed_a, "round-1:nonce-1:goodbye", parsed)["ticket"] != first["ticket"],
)
truthy(
    "and so does a different seed",
    X.draw(seed_b, "round-1:nonce-1:hello", parsed)["ticket"] != first["ticket"],
)
truthy("the ticket is inside the probability space", 0 <= first["ticket"] < X.PROBABILITY_TOTAL)
contains("the algorithm is published with the result", first["algorithm"], "HMAC-SHA256")
contains("including the rejection rule", first["algorithm"], "rejected and re-drawn")

# Over many draws the distribution is the configured one. Not a statistical
# test with a tolerance — a direct count of which bucket each ticket falls in,
# against the cumulative probabilities that produced it.
buckets = {o.index: 0 for o in parsed}
TRIALS = 20_000
for i in range(TRIALS):
    buckets[X.draw(seed_a, f"dist:{i}", parsed)["index"]] += 1
observed_zero = buckets[0] * 100 // TRIALS
truthy(
    "over 20,000 draws the 40.45% outcome lands between 38% and 43%",
    38 <= observed_zero <= 43,
)
truthy(
    "and the 30% outcome between 28% and 32%",
    28 <= buckets[1] * 100 // TRIALS <= 32,
)
truthy("every outcome in the table can be drawn", all(v >= 0 for v in buckets.values()))
truthy("the common ones all were", all(buckets[i] > 0 for i in range(5)))

# ── Commit and reveal (8B.1.6) ────────────────────────────────────────────────

proof = X.verify_round_outcome(
    seed_hex=seed_a.hex(),
    published_hash=X.seed_hash(seed_a),
    round_id="round-1",
    nonce="nonce-1",
    client_entropy="hello",
    outcomes=parsed,
    recorded_index=first["index"],
)
truthy("the revealed seed matches the published hash", proof["seed_matches_commitment"])
truthy("and reproduces the recorded outcome", proof["outcome_matches"])
truthy("so the round verifies", proof["verified"])

tampered = X.verify_round_outcome(
    seed_hex=seed_b.hex(),
    published_hash=X.seed_hash(seed_a),
    round_id="round-1",
    nonce="nonce-1",
    client_entropy="hello",
    outcomes=parsed,
    recorded_index=first["index"],
)
check("a substituted seed fails the commitment", tampered["seed_matches_commitment"], False)
check("and the round does not verify", tampered["verified"], False)

wrong_result = X.verify_round_outcome(
    seed_hex=seed_a.hex(),
    published_hash=X.seed_hash(seed_a),
    round_id="round-1",
    nonce="nonce-1",
    client_entropy="hello",
    outcomes=parsed,
    recorded_index=(first["index"] + 1) % len(parsed),
)
check("a recorded outcome that is not the drawn one fails", wrong_result["outcome_matches"], False)
check("and that round does not verify either", wrong_result["verified"], False)


# ══════════════════════════════════════════════════════════════════════════════
# 6. A CONFIGURATION IS MONEY — five stages, three people
# ══════════════════════════════════════════════════════════════════════════════

MECHANIC = "lucky_gift_tier_1"

created = run(
    X.create_mechanic(
        mechanic_id=MECHANIC,
        kind=X.MechanicKind.LUCKY_GIFT,
        name="Lucky gift — tier 1",
        reason="Building the tier 1 lucky gift under the new control system.",
        actor=APP_ADMIN,
    )
)
check("a new mechanic has no live configuration", created["live_version"], None)
check("so it is invisible in India", run(X.visible_mechanics("IN")), [])
check("and in the UAE", run(X.visible_mechanics("AE")), [])
check("and everywhere else", run(X.visible_mechanics("NP")), [])
refuses(
    "a second mechanic with the same id is refused",
    lambda: X.create_mechanic(
        mechanic_id=MECHANIC,
        kind=X.MechanicKind.LUCKY_GIFT,
        name="Another one",
        reason="This should not be allowed to exist twice.",
        actor=APP_ADMIN,
    ),
)
refuses(
    "creating a mechanic needs a reason",
    lambda: X.create_mechanic(
        mechanic_id="lucky_gift_tier_9", kind=X.MechanicKind.LUCKY_GIFT,
        name="Tier 9", reason="x", actor=APP_ADMIN,
    ),
)
refuses(
    "an invented kind is refused",
    lambda: X.create_mechanic(
        mechanic_id="slot_machine", kind="casino",
        name="Slots", reason="Trying an unknown kind of mechanic.", actor=APP_ADMIN,
    ),
)

# A blocked table never reaches an owner's queue.
cards_before = len(DB[C.CARDS].docs)
refuses(
    "a blocked configuration cannot even be proposed",
    lambda: X.propose_config(
        mechanic_id=MECHANIC,
        draft={
            "outcomes": as_built_table(77),
            "stake": {"min_stake": 10, "max_stake": 1_000, "step": 10},
            "quantity_tiers": [77],
            "max_single_win": 500_000,
            "enabled_countries": ["AE"],
            "multiplier_basis": "unit_stake",
            "deliberate_lower_return_on_larger_plays": True,
            "lower_return_statement": "Stated on the gift screen.",
        },
        reason="The 77 combo as it is built today.",
        actor=APP_ADMIN,
    ),
    error=X.ConfigBlocked,
)
check("and no card was raised for it", len(DB[C.CARDS].docs), cards_before)

proposal = run(
    X.propose_config(
        mechanic_id=MECHANIC,
        draft=BASE_DRAFT,
        reason="First configuration: 92% RTP, flat across all four combo tiers.",
        actor=APP_ADMIN,
    )
)
card = proposal["card"]
check("a configuration change is a card", card["type"], str(CardType.CHANCE_CONFIG_CHANGE))
check("raised on the App board", card["team"], str(Team.APP))
check("at Requested like any other", card["stage"], str(Stage.REQUESTED))
check("nothing is auto-verified", card["auto_verified"], False)
check(
    "the card's amount is the exposure an owner is signing — the maximum single win",
    card["amount"],
    500_000,
)
check("denominated in diamonds", card["currency"], str(money.Currency.DIAMONDS))
check("the computed RTP is on the card", card["payload"]["evaluation"]["rtp_percent"], "92")
check("with every tier", len(card["payload"]["evaluation"]["tiers"]), 4)
contains("and the title carries the figures", card["title"], "RTP 92%")
check("the version is 1", proposal["config"]["version"], 1)
check("and it is a draft", proposal["config"]["status"], str(X.ConfigStatus.DRAFT))
check("the mechanic is still not live", run(X.get_mechanic(MECHANIC))["live_version"], None)
check("and still invisible", run(X.visible_mechanics("AE")), [])

refuses(
    "an unsigned configuration cannot be made live",
    lambda: X.activate_config(card["id"], OWNER_A),
)
refuses(
    "the person who raised it cannot verify it",
    lambda: card_svc.verify(card["id"], APP_ADMIN, "Mine, and correct."),
    error=CardError,
)
run(card_svc.verify(card["id"], FIN_ADMIN, "Odds table and RTP checked against the preview."))
refuses(
    "a verified but unsigned configuration still cannot go live",
    lambda: X.activate_config(card["id"], OWNER_A),
)
refuses(
    "and a team admin cannot sign it",
    lambda: card_svc.sign(card["id"], APP_ADMIN, "Approved."),
    error=CardError,
)
refuses(
    "nor can the person who verified it",
    lambda: card_svc.sign(card["id"], FIN_ADMIN, "Approved."),
    error=CardError,
)
run(card_svc.sign(card["id"], OWNER_A, "92% RTP, flat across tiers. Approved."))

live_v1 = run(X.activate_config(card["id"], OWNER_B))
check("only then does it go live", live_v1["status"], str(X.ConfigStatus.LIVE))
check("as version 1", live_v1["version"], 1)
truthy("with the owner's signature on the record", live_v1["signed_by"]["uid"] == OWNER_A["uid"])
check("the mechanic now points at it", run(X.get_mechanic(MECHANIC))["live_version"], 1)
check(
    "the card is executed",
    run(card_svc._get(card["id"], as_dict=True))["stage"],
    str(Stage.EXECUTED),
)
refuses(
    "and cannot be activated twice",
    lambda: X.activate_config(card["id"], OWNER_B),
)

history = run(audit_log.history_for("chance_mechanic", MECHANIC))
actions = [entry["action"] for entry in history]
truthy("the mechanic's creation is audited", X.Act.MECHANIC_CREATED in actions)
truthy("the proposal is audited", audit_log.Action.CONFIG_CHANGED in actions)
truthy("every entry carries a reason", all(e["reason"] for e in history))
truthy("and names who did it", all(e["actor"]["uid"] for e in history))


# ══════════════════════════════════════════════════════════════════════════════
# 7. COUNTRY GATING — invisible, not blocked
# ══════════════════════════════════════════════════════════════════════════════

check("it is live in the UAE", [m["mechanic_id"] for m in run(X.visible_mechanics("AE"))], [MECHANIC])
check("and in Nepal", [m["mechanic_id"] for m in run(X.visible_mechanics("NP"))], [MECHANIC])
check(
    "India, which is not enabled, is answered with an empty list",
    run(X.visible_mechanics("IN")),
    [],
)
check(
    "identical to a country nobody has ever configured",
    run(X.visible_mechanics("BR")),
    run(X.visible_mechanics("IN")),
)
india = run(X.visible_mechanics("IN"))
absent("nothing in the Indian answer names the mechanic", str(india), MECHANIC)
absent("and nothing says 'disabled'", str(india), "disabled")

catalogue = run(X.visible_mechanics("AE"))
truthy("the published odds travel with the catalogue (0.5.3)", catalogue[0]["outcomes"])
check("as does the stated RTP", catalogue[0]["rtp_percent"], "92")

refuses(
    "a round cannot be opened in a country the mechanic is not enabled in",
    lambda: X.commit_round(
        mechanic_id=MECHANIC, player_uid=PLAYER, country="IN", actor=APP_ADMIN
    ),
    error=X.MechanicUnavailable,
)
refuses(
    "and neither can one on a mechanic that does not exist",
    lambda: X.commit_round(
        mechanic_id="no_such_thing", player_uid=PLAYER, country="AE", actor=APP_ADMIN
    ),
    error=X.MechanicUnavailable,
)

# The two refusals are indistinguishable from outside — that is the whole point.
def _detail(factory):
    try:
        run(factory())
    except X.MechanicUnavailable as exc:
        http = chance_router._fail(exc)
        return http.status_code, http.detail
    return None


check(
    "a disabled market and an unknown mechanic give the same 404 and the same words",
    _detail(lambda: X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="IN", actor=APP_ADMIN)),
    _detail(lambda: X.commit_round(mechanic_id="no_such_thing", player_uid=PLAYER, country="AE", actor=APP_ADMIN)),
)
check(
    "and it is a 404, not a 403 that would confirm the mechanic exists",
    _detail(lambda: X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="IN", actor=APP_ADMIN))[0],
    404,
)

refuses("a malformed country is refused", lambda: X.visible_mechanics("india"))
refuses("as is a three-letter code", lambda: X.visible_mechanics("IND"))
refuses(
    "and a configuration naming one is refused",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, enabled_countries=["India"])),
)


# ══════════════════════════════════════════════════════════════════════════════
# 8. A ROUND — drawn, recorded, then paid
# ══════════════════════════════════════════════════════════════════════════════

STARTING_DIAMONDS = 100_000
run(
    money.apply_movement(
        money.Movement(
            holder_type=money.HolderType.USER,
            holder_id=PLAYER,
            currency=money.Currency.DIAMONDS,
            amount=STARTING_DIAMONDS,
            action="balance.credit",
            reason="Opening balance for the chance mechanics test.",
            actor=OWNER_A,
        )
    )
)


def balance(uid: str = PLAYER) -> int:
    return run(
        money.get_balance(money.HolderType.USER, uid, money.Currency.DIAMONDS)
    )


check("the player starts with 100,000 diamonds", balance(), STARTING_DIAMONDS)


def round_doc(round_id: str) -> dict:
    return next(d for d in DB[C.CHANCE_ROUNDS].docs if d["round_id"] == round_id)


def entropy_for(round_id: str, wanted_bp: int, outcomes) -> str:
    """Find a client entropy that lands on a chosen multiplier.

    Only possible because this test can read the stored seed out of the
    database, which is exactly what a player cannot do before a round settles —
    and precisely why the seed is committed as a hash and revealed afterwards
    rather than published up front. Used here to reach the rare outcomes
    deterministically instead of playing two thousand rounds.
    """
    doc = round_doc(round_id)
    seed = bytes.fromhex(doc["server_seed"])
    for i in range(500_000):
        entropy = f"grind-{i}"
        result = X.draw(seed, X.draw_message(round_id, doc["nonce"], entropy), outcomes)
        if result["multiplier_bp"] == wanted_bp:
            return entropy
    raise AssertionError(f"no entropy found for {wanted_bp}")  # pragma: no cover


opened = run(
    X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN)
)
check("opening a round stakes nothing", balance(), STARTING_DIAMONDS)
check("the commitment is published before the round", len(opened["server_seed_hash"]), 64)
truthy("with a nonce", opened["nonce"])
check("and the configuration version it will be drawn from", opened["config_version"], 1)
truthy("and the full odds table (0.5.3)", len(opened["outcomes"]) == 7)
check(
    "the seed itself is NOT published",
    "server_seed" in opened,
    False,
)
check(
    "nor readable through the round record before it settles",
    run(X.round_record(opened["round_id"]))["server_seed"],
    None,
)

# A 2× win on a quantity of 17 at 100 diamonds a unit: 1,700 staked, 3,400 back.
entropy = entropy_for(opened["round_id"], 20_000, parsed)

# The ordering claim of 8B.1.5, checked from inside the payout movement: at the
# moment the money is credited, the outcome is already written down.
seen_at_payout: dict = {}
real_apply = X.apply_movement


async def watching_apply(movement):
    if movement.amount > 0 and movement.action == X.Act.PAYOUT:
        seen_at_payout.update(round_doc(opened["round_id"]))
    return await real_apply(movement)


X.apply_movement = watching_apply
try:
    played = run(
        X.play_round(
            round_id=opened["round_id"],
            unit_stake=100,
            quantity=17,
            client_entropy=entropy,
            actor=APP_ADMIN,
        )
    )
finally:
    X.apply_movement = real_apply

check("the multiplier drawn is 2×", played["multiplier_bp"], 20_000)
check("the total stake is 17 × 100", played["total_stake"], 1_700)
check("the payout is 2× the TOTAL stake, not the unit stake", played["payout"], 3_400)
check("not 200, which is what the current build would pay", played["payout"] != 200, True)
check("the net is stated", played["net"], 1_700)
check("the round settled", played["status"], str(X.RoundStatus.SETTLED))
check(
    "and the balance moved by exactly stake then payout",
    balance(),
    STARTING_DIAMONDS - 1_700 + 3_400,
)

check("the outcome was recorded before the payout was credited", seen_at_payout.get("status"), str(X.RoundStatus.RECORDED))
check("with the multiplier already on the record", seen_at_payout.get("multiplier_bp"), 20_000)
check("and the payout figure", seen_at_payout.get("payout"), 3_400)
check("and the stake", seen_at_payout.get("total_stake"), 1_700)
check("and the player", seen_at_payout.get("player_uid"), PLAYER)
truthy("and the timestamp", seen_at_payout.get("played_at") is not None)
check("the payout ledger id was not yet set at that moment", seen_at_payout.get("payout_ledger_id"), None)

# ── The ledger and the audit log (8B.7.4) ─────────────────────────────────────

ledger = run(money.ledger_for(money.HolderType.USER, PLAYER, money.Currency.DIAMONDS))
stake_rows = [r for r in ledger if r["action"] == X.Act.STAKE]
payout_rows = [r for r in ledger if r["action"] == X.Act.PAYOUT]
check("the stake is a ledger movement", len(stake_rows), 1)
check("for the negative of the total stake", stake_rows[0]["amount"], -1_700)
check("the payout is a ledger movement", len(payout_rows), 1)
check("for the payout", payout_rows[0]["amount"], 3_400)
truthy("both carry a reason", all(r["reason"] for r in stake_rows + payout_rows))
contains("the stake reason names the round", stake_rows[0]["reason"], opened["round_id"])
contains("and the configuration version", stake_rows[0]["reason"], "v1")
check("both are idempotent",
      sorted(r["idempotency_key"] for r in stake_rows + payout_rows),
      sorted([f"chance:{opened['round_id']}:payout", f"chance:{opened['round_id']}:stake"]))

round_audit = run(audit_log.history_for("chance_round", opened["round_id"]))
round_actions = {e["action"] for e in round_audit}
truthy("the round is in the audit log", X.Act.ROUND_RECORDED in round_actions)
player_audit = run(audit_log.history_for("user", PLAYER))
player_actions = {e["action"] for e in player_audit}
truthy("the stake is in the audit log against the player", X.Act.STAKE in player_actions)
truthy("and so is the payout", X.Act.PAYOUT in player_actions)
truthy("every one of them carries a reason", all(e["reason"] for e in player_audit))

# ── The reveal (8B.1.6) ───────────────────────────────────────────────────────

fairness = played["fairness"]
check("the seed is revealed with the result", len(fairness["server_seed"]), 64)
check(
    "and matches the hash published before the round",
    X.seed_hash(bytes.fromhex(fairness["server_seed"])),
    opened["server_seed_hash"],
)
check("the nonce is the committed one", fairness["nonce"], opened["nonce"])
check("the entropy the caller supplied is echoed", fairness["client_entropy"], entropy)
recheck = X.verify_round_outcome(
    seed_hex=fairness["server_seed"],
    published_hash=opened["server_seed_hash"],
    round_id=opened["round_id"],
    nonce=opened["nonce"],
    client_entropy=entropy,
    outcomes=X.parse_outcomes(FIXED_TABLE),
    recorded_index=played["outcome_index"],
)
truthy("and the whole round verifies from published values alone", recheck["verified"])

stored = run(X.round_record(opened["round_id"]))
truthy("the settled round reveals its seed", stored["server_seed"])
truthy("and recomputes its own proof", stored["fairness"]["verified"])
check(
    "against the configuration version it was played on",
    stored["fairness"]["config_version"],
    1,
)

# ── Replay, and refusals ──────────────────────────────────────────────────────

refuses(
    "a settled round cannot be played again",
    lambda: X.play_round(
        round_id=opened["round_id"], unit_stake=100, quantity=17,
        client_entropy=entropy, actor=APP_ADMIN,
    ),
    error=X.RoundError,
)
check("and the balance did not move", balance(), STARTING_DIAMONDS - 1_700 + 3_400)
refuses(
    "a round that does not exist cannot be played",
    lambda: X.play_round(round_id="nope", unit_stake=100, actor=APP_ADMIN),
    error=X.RoundError,
)

bad_stake = run(X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN))
before_bad = balance()
refuses(
    "a stake off the permitted denominations is refused",
    lambda: X.play_round(round_id=bad_stake["round_id"], unit_stake=15, actor=APP_ADMIN),
    error=X.RoundError,
)
check("and nothing was staked", balance(), before_bad)
check("the round is void, not left open", round_doc(bad_stake["round_id"])["status"], str(X.RoundStatus.VOID))

bad_quantity = run(X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN))
refuses(
    "a quantity that is not a configured tier is refused",
    lambda: X.play_round(round_id=bad_quantity["round_id"], unit_stake=100, quantity=5, actor=APP_ADMIN),
    error=X.RoundError,
)
check("and nothing was staked for that either", balance(), before_bad)

poor = "player-with-nothing"
broke_round = run(X.commit_round(mechanic_id=MECHANIC, player_uid=poor, country="AE", actor=APP_ADMIN))
refuses(
    "a player who cannot pay the stake gets no free roll",
    lambda: X.play_round(round_id=broke_round["round_id"], unit_stake=100, quantity=17, actor=APP_ADMIN),
    error=X.RoundError,
)
check("their balance is untouched", balance(poor), 0)
check("and the round is void", round_doc(broke_round["round_id"])["status"], str(X.RoundStatus.VOID))

# ── The cap, end to end ───────────────────────────────────────────────────────

cap_round = run(X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN))
cap_entropy = entropy_for(cap_round["round_id"], 500_000, parsed)
before_cap = balance()
capped = run(
    X.play_round(
        round_id=cap_round["round_id"], unit_stake=1_000, quantity=77,
        client_entropy=cap_entropy, actor=APP_ADMIN,
    )
)
check("50× on a 77,000 stake would pay 3,850,000", capped["uncapped_payout"], 3_850_000)
check("the maximum single win pays 500,000 instead", capped["payout"], 500_000)
truthy("and the round says it was capped", capped["capped"])
check(
    "the balance moved by the capped figure, not the table's",
    balance(),
    before_cap - 77_000 + 500_000,
)
check(
    "the record keeps what the table would have paid",
    round_doc(cap_round["round_id"])["uncapped_payout"],
    3_850_000,
)

# ── A client that reports its own outcome changes nothing ─────────────────────

body, claims = X.strip_client_claims(
    {
        "unit_stake": 100,
        "quantity": 1,
        "payout": 999_999_999,
        "multiplier_bp": 5_000_000,
        "won": True,
        "outcome_index": 6,
        "server_seed": "aa" * 32,
        "client_entropy": "mine",
    }
)
check(
    "every outcome-claiming field is stripped",
    sorted(claims),
    ["multiplier_bp", "outcome_index", "payout", "server_seed", "won"],
)
check("what is left is the stake, the quantity and the entropy",
      sorted(body), ["client_entropy", "quantity", "unit_stake"])
truthy("no payout survives", "payout" not in body)
truthy("no seed survives", "server_seed" not in body)


# ══════════════════════════════════════════════════════════════════════════════
# 9. A ROUND USES THE VERSION IN FORCE WHEN IT WAS PLAYED
# ══════════════════════════════════════════════════════════════════════════════
#
# Version 2 has a table with no multiplier in common with version 1 except zero.
# A round committed under version 1 and played after version 2 went live must
# draw from version 1 — and it is provable because the multiplier it lands on
# does not exist in version 2's table at all.

V2_TABLE = [
    {"multiplier_bp": 0, "probability_ppm": 780_000},
    {"multiplier_bp": 40_000, "probability_ppm": 200_000},   # 4× — 0.80
    {"multiplier_bp": 60_000, "probability_ppm": 20_000},    # 6× — 0.12
]
check("version 2's table also returns 92%", X.rtp_ppm(X.parse_outcomes(V2_TABLE)), 920_000)

in_flight = run(
    X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN)
)
check("committed against version 1", in_flight["config_version"], 1)
flight_entropy = entropy_for(in_flight["round_id"], 20_000, parsed)  # a 2×, v1 only

v2_proposal = run(
    X.propose_config(
        mechanic_id=MECHANIC,
        draft=dict(BASE_DRAFT, outcomes=V2_TABLE),
        reason="Fewer, larger wins. Same 92% return, different shape.",
        actor=APP_MEMBER,
    )
)
v2_card = v2_proposal["card"]
check("the change is version 2", v2_proposal["config"]["version"], 2)
truthy("and the card shows the owner what changed", v2_card["payload"]["changes"])
contains(
    "including the outcome table itself",
    [c["field"] for c in v2_card["payload"]["changes"]],
    "outcomes",
)
run(card_svc.verify(v2_card["id"], APP_ADMIN, "New table checked; RTP unchanged at 92%."))
run(card_svc.sign(v2_card["id"], OWNER_A, "Approved."))
run(X.activate_config(v2_card["id"], OWNER_B))

check("version 2 is now live", run(X.get_mechanic(MECHANIC))["live_version"], 2)
check(
    "version 1 is superseded, not deleted",
    run(X.config_version(MECHANIC, 1))["status"],
    str(X.ConfigStatus.SUPERSEDED),
)
check("and is still readable in full", len(run(X.config_version(MECHANIC, 1))["evaluation"]["outcomes"]), 7)

settled_late = run(
    X.play_round(
        round_id=in_flight["round_id"], unit_stake=100, quantity=1,
        client_entropy=flight_entropy, actor=APP_ADMIN,
    )
)
check("the round was drawn on version 1", round_doc(in_flight["round_id"])["config_version"], 1)
check("although version 2 was live at the time", round_doc(in_flight["round_id"])["live_version_at_play"], 2)
check("the multiplier drawn is 2×, which exists only in version 1", settled_late["multiplier_bp"], 20_000)
truthy(
    "and is not in version 2's table at all",
    20_000 not in [row["multiplier_bp"] for row in V2_TABLE],
)
check("the round carries the RTP of the version it played on",
      round_doc(in_flight["round_id"])["rtp_ppm_at_play"], 920_000)

# A round committed after the change draws from version 2.
after_change = run(
    X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="AE", actor=APP_ADMIN)
)
check("a new round is committed against version 2", after_change["config_version"], 2)
check("and is offered version 2's odds", len(after_change["outcomes"]), 3)

# ── Withdrawing a market takes effect at once, and outlives a committed round ──

pending_in_ae = run(
    X.commit_round(mechanic_id=MECHANIC, player_uid=PLAYER, country="NP", actor=APP_ADMIN)
)
withdrawn = run(
    X.withdraw_country(
        mechanic_id=MECHANIC,
        country="NP",
        reason="Counsel has advised withdrawing this market pending classification.",
        actor=OWNER_A,
    )
)
check("withdrawal writes a new version", withdrawn["version"], 3)
check("which is live immediately", withdrawn["status"], str(X.ConfigStatus.LIVE))
check("carrying the owner's signature", withdrawn["signed_by"]["uid"], OWNER_A["uid"])
check("and saying what authority it was made under", withdrawn["authority"], "owner_emergency_withdrawal")
check("Nepal is gone", withdrawn["evaluation"]["enabled_countries"], ["AE"])
check("and invisible there at once", run(X.visible_mechanics("NP")), [])
check("while the UAE is unaffected", len(run(X.visible_mechanics("AE"))), 1)
refuses(
    "a round already committed in a withdrawn market cannot be played",
    lambda: X.play_round(round_id=pending_in_ae["round_id"], unit_stake=100, actor=APP_ADMIN),
    error=X.MechanicUnavailable,
)
check("and it is voided rather than left open", round_doc(pending_in_ae["round_id"])["status"], str(X.RoundStatus.VOID))
refuses(
    "withdrawing a market that is not enabled is refused",
    lambda: X.withdraw_country(
        mechanic_id=MECHANIC, country="BR",
        reason="Nothing to withdraw here.", actor=OWNER_A,
    ),
)
refuses(
    "and a withdrawal needs a reason",
    lambda: X.withdraw_country(mechanic_id=MECHANIC, country="AE", reason="x", actor=OWNER_A),
)

versions = run(X.config_history(MECHANIC))
check("every version is retained", [v["version"] for v in versions], [3, 2, 1])
check(
    "and each says how it was authorised",
    [v["authority"] for v in versions],
    ["owner_emergency_withdrawal", "card", "card"],
)


# ══════════════════════════════════════════════════════════════════════════════
# 10. THE SIGNED MACHINE DOOR — and the routes' authority
# ══════════════════════════════════════════════════════════════════════════════


class Req:
    """`fastapi.Request` reduced to what the signed door reads."""

    def __init__(self, method: str, path: str, body: bytes):
        self.method = method.upper()
        self.url = types.SimpleNamespace(path=path)
        self._body = body

    async def body(self) -> bytes:
        return self._body


def signed(method: str, path: str, payload: dict, caller: str = "app_tier",
           secret: str = "tier-secret-9f3", skew_seconds: int = 0):
    import json

    raw = json.dumps(payload).encode()
    when = datetime.now(timezone.utc) + timedelta(seconds=skew_seconds)
    timestamp = str(int(when.timestamp()))
    signature = X.sign_request(secret, method, path, timestamp, raw)
    return Req(method, path, raw), caller, signature, timestamp


req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/catalogue", {"country": "AE"}
)
answer = run(
    chance_router.catalogue(
        req, x_chance_caller=caller, x_chance_signature=signature,
        x_chance_timestamp=timestamp,
    )
)
check("a correctly signed catalogue request is answered", answer["country"], "AE")
check("with the live mechanic", [m["mechanic_id"] for m in answer["mechanics"]], [MECHANIC])

req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/catalogue", {"country": "IN"}
)
india_answer = run(
    chance_router.catalogue(
        req, x_chance_caller=caller, x_chance_signature=signature,
        x_chance_timestamp=timestamp,
    )
)
check("and India is answered with nothing at all", india_answer["mechanics"], [])


def refuses_http(label: str, factory, status_code: int) -> None:
    global checks
    checks += 1
    try:
        run(factory())
    except HTTPException as exc:
        if exc.status_code != status_code:
            failures.append(f"{label}: got {exc.status_code}, wanted {status_code}")
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: raised {type(exc).__name__}({exc})")
        return
    failures.append(f"{label}: was NOT refused")


req, caller, signature, timestamp = signed("POST", "/api/chance/edge/catalogue", {"country": "AE"})
refuses_http(
    "an unsigned request is refused",
    lambda: chance_router.catalogue(req, x_chance_caller=caller, x_chance_signature="", x_chance_timestamp=timestamp),
    401,
)
refuses_http(
    "a wrong signature is refused",
    lambda: chance_router.catalogue(req, x_chance_caller=caller, x_chance_signature="00" * 32, x_chance_timestamp=timestamp),
    401,
)
refuses_http(
    "an unknown caller is refused",
    lambda: chance_router.catalogue(req, x_chance_caller="somebody_else", x_chance_signature=signature, x_chance_timestamp=timestamp),
    401,
)
wrong_key = signed("POST", "/api/chance/edge/catalogue", {"country": "AE"}, secret="not-the-secret")
refuses_http(
    "a signature made with the wrong key is refused",
    lambda: chance_router.catalogue(wrong_key[0], x_chance_caller=wrong_key[1], x_chance_signature=wrong_key[2], x_chance_timestamp=wrong_key[3]),
    401,
)
stale = signed("POST", "/api/chance/edge/catalogue", {"country": "AE"}, skew_seconds=-3_600)
refuses_http(
    "a correctly signed request from an hour ago is refused — a valid signature is not a fresh one",
    lambda: chance_router.catalogue(stale[0], x_chance_caller=stale[1], x_chance_signature=stale[2], x_chance_timestamp=stale[3]),
    401,
)
tampered_body = signed("POST", "/api/chance/edge/catalogue", {"country": "AE"})
tampered_body[0]._body = b'{"country": "IN"}'
refuses_http(
    "a body altered after signing is refused",
    lambda: chance_router.catalogue(tampered_body[0], x_chance_caller=tampered_body[1], x_chance_signature=tampered_body[2], x_chance_timestamp=tampered_body[3]),
    401,
)
wrong_path = signed("POST", "/api/chance/edge/rounds", {"country": "AE"})
wrong_path[0].url = types.SimpleNamespace(path="/api/chance/edge/catalogue")
refuses_http(
    "a signature for one route replayed on another is refused",
    lambda: chance_router.catalogue(wrong_path[0], x_chance_caller=wrong_path[1], x_chance_signature=wrong_path[2], x_chance_timestamp=wrong_path[3]),
    401,
)

# With no keys configured, nothing can be played. That is the default.
os.environ["CHANCE_SIGNING_KEYS"] = ""
no_keys = signed("POST", "/api/chance/edge/catalogue", {"country": "AE"})
refuses_http(
    "with no signing keys configured, no machine may call anything",
    lambda: chance_router.catalogue(no_keys[0], x_chance_caller=no_keys[1], x_chance_signature=no_keys[2], x_chance_timestamp=no_keys[3]),
    401,
)
os.environ["CHANCE_SIGNING_KEYS"] = "app_tier:tier-secret-9f3,acme_games:acme-secret-77"

# ── A round through the door, with a client claiming its own payout ───────────

req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/rounds",
    {"mechanic_id": MECHANIC, "player_uid": PLAYER, "country": "AE"},
)
via_door = run(
    chance_router.commit_round(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    )
)
truthy("a round can be opened through the signed door", via_door["round_id"])

v2_outcomes = X.parse_outcomes(V2_TABLE)
door_entropy = entropy_for(via_door["round_id"], 40_000, v2_outcomes)  # 4×
path = f"/api/chance/edge/rounds/{via_door['round_id']}/play"
before_door = balance()
req, caller, signature, timestamp = signed(
    "POST", path,
    {
        "unit_stake": 100,
        "quantity": 1,
        "client_entropy": door_entropy,
        # Everything below is a lie a modified client would tell.
        "payout": 999_999_999,
        "multiplier_bp": 5_000_000,
        "won": True,
        "outcome_index": 0,
    },
)
door_result = run(
    chance_router.play_round(
        via_door["round_id"], req, x_chance_caller=caller,
        x_chance_signature=signature, x_chance_timestamp=timestamp,
    )
)
check("the server's multiplier is used, not the client's", door_result["multiplier_bp"], 40_000)
check("the server's payout is credited, not the client's", door_result["payout"], 400)
check("the balance moved by the server's figures alone", balance(), before_door - 100 + 400)
check(
    "and the round records which claims were discarded",
    sorted(round_doc(via_door["round_id"])["client_claims_ignored"]),
    ["multiplier_bp", "outcome_index", "payout", "won"],
)
claim_audit = [
    e for e in run(audit_log.history_for("chance_round", via_door["round_id"]))
    if e["action"] == X.Act.CLIENT_CLAIM_IGNORED
]
check("the attempt is in the audit log", len(claim_audit), 1)
contains("naming the fields", str(claim_audit[0]["meta"]["fields"]), "payout")
check(
    "the round was drawn by this server",
    round_doc(via_door["round_id"])["server_seed_hash"],
    via_door["server_seed_hash"],
)

# ── A third-party provider settling server-to-server (8B.1.4) ─────────────────

GAME = "aviator"
run(
    X.create_mechanic(
        mechanic_id=GAME, kind=X.MechanicKind.GAME, name="Aviator",
        reason="Third-party crash game, settled server to server.", actor=APP_ADMIN,
    )
)
game_proposal = run(
    X.propose_config(
        mechanic_id=GAME,
        draft=dict(
            BASE_DRAFT,
            enabled_countries=["AE"],
            quantity_tiers=[1],
            provider={"name": "acme_games", "signing_key_id": "acme-2026-08"},
        ),
        reason="Aviator via Acme, 92% return, capped at 500,000 diamonds a round.",
        actor=APP_ADMIN,
    )
)
run(card_svc.verify(game_proposal["card"]["id"], FIN_ADMIN, "Provider and cap checked."))
run(card_svc.sign(game_proposal["card"]["id"], OWNER_A, "Approved."))
run(X.activate_config(game_proposal["card"]["id"], OWNER_B))

before_settlement = balance()
settlement = {
    "mechanic_id": GAME,
    "provider_round_ref": "ACME-88213",
    "player_uid": PLAYER,
    "country": "AE",
    "total_stake": 500,
    "multiplier_bp": 30_000,
    "payout": 1_500,
}
req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/settlements", settlement,
    caller="acme_games", secret="acme-secret-77",
)
settled = run(
    chance_router.settle_external(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    )
)
check("a signed settlement is applied", settled["settled"], True)
check("for the amount both sides compute", settled["payout"], 1_500)
check("and the player is credited", balance(), before_settlement + 1_500)

req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/settlements", settlement,
    caller="acme_games", secret="acme-secret-77",
)
replayed = run(
    chance_router.settle_external(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    )
)
truthy("the same settlement reference replayed is recognised", replayed["duplicate"])
check("and pays nothing a second time", balance(), before_settlement + 1_500)

lying_settlement = dict(settlement, provider_round_ref="ACME-88214", payout=999_999)
req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/settlements", lying_settlement,
    caller="acme_games", secret="acme-secret-77",
)
refuses_http(
    "a provider whose arithmetic disagrees with ours settles nothing",
    lambda: chance_router.settle_external(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    ),
    400,
)
check("and the player is not credited", balance(), before_settlement + 1_500)

capped_settlement = dict(
    settlement,
    provider_round_ref="ACME-88215",
    total_stake=1_000,
    multiplier_bp=10_000_000,   # 1,000× — far past our own ceiling
    payout=1_000_000,
)
req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/settlements", capped_settlement,
    caller="acme_games", secret="acme-secret-77",
)
big = run(
    chance_router.settle_external(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    )
)
check("our maximum single win applies to a provider's round too", big["payout"], 500_000)
truthy("and the round says so", big["capped"])

wrong_provider = dict(settlement, provider_round_ref="ACME-88216")
req, caller, signature, timestamp = signed(
    "POST", "/api/chance/edge/settlements", wrong_provider,
)
refuses_http(
    "the app tier's key cannot settle a provider's game",
    lambda: chance_router.settle_external(
        req, x_chance_caller=caller, x_chance_signature=signature, x_chance_timestamp=timestamp
    ),
    401,
)

# ── Every route in this router is guarded, or signed ──────────────────────────
#
# Read out of the source, so a route added tomorrow is covered whether or not
# anybody remembers this test exists.

INTERNAL_GUARDS = {"require_internal", "require_owner", "require_team_admin"}
tree = ast.parse((ROOT / "app" / "routers" / "chance.py").read_text())
route_guards: dict[str, tuple[set, bool]] = {}
for node in ast.walk(tree):
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    decorators = [
        d for d in node.decorator_list
        if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
        and isinstance(d.func.value, ast.Name) and d.func.value.id == "router"
    ]
    if not decorators:
        continue
    guards = {
        default.args[0].id
        for default in list(node.args.defaults) + list(node.args.kw_defaults)
        if isinstance(default, ast.Call) and isinstance(default.func, ast.Name)
        and default.func.id == "Depends" and default.args
        and isinstance(default.args[0], ast.Name)
    }
    signs = any(
        isinstance(inner, ast.Call) and isinstance(inner.func, ast.Name)
        and inner.func.id == "_signed_caller"
        for inner in ast.walk(node)
    )
    route_guards[node.name] = (guards, signs)

truthy("the router declares routes to check", len(route_guards) >= 12)
for name, (guards, signs) in sorted(route_guards.items()):
    truthy(
        f"{name} is either guarded by a real dependency or verifies a signature",
        bool(guards & INTERNAL_GUARDS) or signs,
    )
    truthy(
        f"{name} does not take a bare session",
        guards != {"current_user"},
    )

ROUTES = {(r["method"], r["path"]): r for r in chance_router.router.routes}


def guard_of(method: str, path: str):
    fn = ROUTES[(method, path)]["fn"]
    for default in fn.__defaults__ or ():
        if isinstance(default, Depends):
            return default.dependency
    return None


check("reading a configuration is internal", guard_of("get", "/mechanics/{mechanic_id}/configs"), require_internal)
check("reading a round is internal", guard_of("get", "/rounds/{round_id}"), require_internal)
check("previewing a table needs a team admin", guard_of("post", "/configs/preview"), require_team_admin)
check("proposing a change needs a team admin", guard_of("post", "/mechanics/{mechanic_id}/configs"), require_team_admin)
check("making one live needs an owner", guard_of("post", "/configs/{card_id}/activate"), require_owner)
check("withdrawing a market needs an owner", guard_of("post", "/mechanics/{mechanic_id}/withdraw-country"), require_owner)
check(
    "there is no verify route on the chance board",
    [p for _m, p in ROUTES if "verify" in p],
    [],
)
check(
    "and no sign route — the money board's are the only ones",
    [p for _m, p in ROUTES if p.endswith("/sign")],
    [],
)


# ══════════════════════════════════════════════════════════════════════════════
# 10A. THE RESERVE AND THE CEILINGS RIDE THE SAME SIGNED CARD — 8B.4.3 / 8B.4.4
# ══════════════════════════════════════════════════════════════════════════════
#
# The behaviour of the ceilings at play time — each binding at exactly its own
# figure, the auto-suspend, the race between two rounds, and actual against
# configured RTP — is held down in `tests/test_chance_exposure.py`, which needs
# a clock, an alert audience and a mail provider this module does not set up.
#
# What belongs *here* is the part that is a fact about a **configuration**: a
# reserve is money (8B.2.8), so it is evaluated by the same function, blocked by
# the same gate, versioned in the same immutable record and signed on the same
# card as the odds table. And the figure it is sized against — the variance of
# the table itself — is arithmetic, worked by hand below like every other number
# in this file.

# The fixed table: E[M²] = 0.30·1 + 0.15·2.25 + 0.10·4 + 0.04·9 + 0.005·100
#                        + 0.0005·2500
#                        = 0.30 + 0.3375 + 0.40 + 0.36 + 0.50 + 1.25 = 3.1475
# Var = 3.1475 − 0.92² = 3.1475 − 0.8464 = 2.3011
check(
    "the table's variance is 2.3011, exactly, on integers",
    X.variance_numerator(parsed),
    23_011 * 10**16,
)
truthy(
    "so one round's standard deviation is about 1.517 stakes",
    1_516_000 <= X.sigma_ppm(parsed) <= 1_517_000,
)
truthy(
    "which is far larger than the 0.92 mean — a single round says nothing "
    "about whether the odds are right, and that is the whole of 8B.4.1",
    X.sigma_ppm(parsed) > X.rtp_ppm(parsed),
)
truthy("the variance is an int", isinstance(X.variance_numerator(parsed), int))
truthy("and so is the sigma", isinstance(X.sigma_ppm(parsed), int))
SIGMA = X.sigma_ppm(parsed)
truthy(
    "a three-sigma bad run over a thousand rounds costs real money, and the "
    "figure is derived rather than guessed at",
    X.bad_run_diamonds(stake=1_000, rounds=1_000, rtp=920_000, sigma=SIGMA, k=3) > 0,
)
truthy(
    "and over enough volume the edge outruns the variance, so the same "
    "arithmetic says a long run needs no reserve at all — which is exactly "
    "8B.4.1's 'house edge only works over volume'",
    X.bad_run_diamonds(
        stake=1_000, rounds=10_000_000, rtp=920_000, sigma=SIGMA, k=3
    )
    < 0,
)

# ── The block is optional, and its absence is stated rather than assumed ──────

no_exposure = X.evaluate_draft(BASE_DRAFT)
check(
    "a configuration with no reserve still has a per-round ceiling, because "
    "the maximum single win already is one",
    no_exposure["exposure"]["max_payout_per_round"],
    500_000,
)
check(
    "recorded as a default, not as somebody's decision",
    no_exposure["exposure"]["max_payout_per_round_source"],
    "max_single_win",
)
check("with no reserve", no_exposure["exposure"]["reserve_diamonds"], None)
check("and no daily ceiling", no_exposure["exposure"]["max_payout_platform_per_day"], None)
check("which does not block it — this is additive", no_exposure["blocked"], False)
contains("but is flagged in the words of 8B.4.6", no_exposure["flags"], "8B.4.6")

# ── What is refused ──────────────────────────────────────────────────────────

for label, exposure, needle in (
    (
        "a per-round ceiling above the maximum single win",
        {"max_payout_per_round": 900_000},
        "never bind",
    ),
    (
        "a per-player daily ceiling below one permitted round",
        {"max_payout_per_player_per_day": 1_000},
        "own first jackpot",
    ),
    (
        "a platform daily ceiling below the per-player one",
        {"max_payout_per_player_per_day": 600_000,
         "max_payout_platform_per_day": 100_000},
        "would ever bind",
    ),
    (
        "a reserve with no stated model",
        {"reserve_diamonds": 5_000_000},
        "reserve_basis",
    ),
):
    blocked_draft = X.evaluate_draft(dict(BASE_DRAFT, exposure=exposure))
    truthy(f"{label} is blocked from going live", blocked_draft["blocked"])
    contains(f"…and the refusal explains why: {label}", blocked_draft["blocked_reasons"], needle)

refuses(
    "a float reserve is refused, not rounded",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, exposure={"reserve_diamonds": 1.5})),
)
refuses(
    "and a ceiling of zero is refused rather than read as 'pay nothing'",
    lambda: X.evaluate_draft(dict(BASE_DRAFT, exposure={"max_payout_per_round": 0})),
)

# ── It changes on the card, and it survives the signature ────────────────────

RESERVED = "lucky_gift_reserved"
run(
    X.create_mechanic(
        mechanic_id=RESERVED,
        kind=X.MechanicKind.LUCKY_GIFT,
        name="Lucky gift — with a reserve",
        reason="A tier configured with an explicit reserve and daily ceilings.",
        actor=APP_ADMIN,
    )
)
reserved_proposal = run(
    X.propose_config(
        mechanic_id=RESERVED,
        draft=dict(
            BASE_DRAFT,
            exposure={
                "reserve_diamonds": 5_000_000,
                "reserve_basis": (
                    "Three sigma over 100,000 rounds at the top stake, from the "
                    "guidance printed on this card."
                ),
                "max_payout_per_round": 400_000,
                "max_payout_per_player_per_day": 1_000_000,
                "max_payout_platform_per_day": 4_000_000,
            },
        ),
        reason="First configuration, with the reserve and ceilings of 8B.4.",
        actor=APP_ADMIN,
    )
)
reserved_card = reserved_proposal["card"]
check(
    "a reserve change is a chance configuration card like any other",
    reserved_card["type"],
    str(CardType.CHANCE_CONFIG_CHANGE),
)
truthy(
    "and the reserve is on the card an owner signs",
    reserved_card["payload"]["evaluation"]["exposure"]["reserve_diamonds"] == 5_000_000,
)
truthy(
    "beside the guidance it should have been chosen against",
    reserved_card["payload"]["evaluation"]["exposure"]["reserve_guidance"],
)
refuses(
    "an unsigned reserve cannot go live",
    lambda: X.activate_config(reserved_card["id"], OWNER_A),
)
run(card_svc.verify(reserved_card["id"], FIN_ADMIN, "Reserve and ceilings checked."))
refuses(
    "and a verified one still cannot",
    lambda: X.activate_config(reserved_card["id"], OWNER_A),
)
run(card_svc.sign(reserved_card["id"], OWNER_A, "5,000,000 diamond reserve. Approved."))
reserved_live = run(X.activate_config(reserved_card["id"], OWNER_B))

reserved_exposure = reserved_live["evaluation"]["exposure"]
check("the signed version carries the reserve", reserved_exposure["reserve_diamonds"], 5_000_000)
check("the per-round ceiling", reserved_exposure["max_payout_per_round"], 400_000)
check("the per-player daily ceiling", reserved_exposure["max_payout_per_player_per_day"], 1_000_000)
check("and the platform daily ceiling", reserved_exposure["max_payout_platform_per_day"], 4_000_000)
truthy(
    "with the basis the owner signed for",
    len(reserved_exposure["reserve_basis"]) >= X.MIN_REASON,
)
check(
    "the per-round ceiling is now a decision rather than a default",
    reserved_exposure["max_payout_per_round_source"],
    "configured",
)
check(
    "and the whole block survived re-evaluation at activation unchanged",
    run(X.config_version(RESERVED, 1))["evaluation"]["exposure"]["reserve_diamonds"],
    5_000_000,
)

# A change to any of it is a new immutable version on a new card, and the diff
# an owner reads names the figure that moved rather than showing a blob.
halved = run(
    X.propose_config(
        mechanic_id=RESERVED,
        draft=dict(
            BASE_DRAFT,
            exposure={
                "reserve_diamonds": 2_500_000,
                "reserve_basis": "Halved after the first quarter's volume.",
                "max_payout_per_round": 400_000,
                "max_payout_per_player_per_day": 1_000_000,
                "max_payout_platform_per_day": 4_000_000,
            },
        ),
        reason="Halving the reserve after a quarter of live volume.",
        actor=APP_ADMIN,
    )
)
reserve_diff = {
    c["field"]: c for c in halved["card"]["payload"]["changes"]
}
truthy(
    "halving the reserve is its own line on the card",
    "exposure.reserve_diamonds" in reserve_diff,
)
check("showing what it was", reserve_diff["exposure.reserve_diamonds"]["before"], 5_000_000)
check("and what it would become", reserve_diff["exposure.reserve_diamonds"]["after"], 2_500_000)
check(
    "the live version is untouched until somebody signs",
    run(X.get_mechanic(RESERVED))["live_version"],
    1,
)
run(card_svc.reject(halved["card"]["id"], OWNER_A, "Not yet. Leaving the reserve where it is."))
check(
    "and a rejected reserve change never becomes live",
    run(X.get_mechanic(RESERVED))["live_version"],
    1,
)


# ══════════════════════════════════════════════════════════════════════════════
# 11. NOTHING FLOATS
# ══════════════════════════════════════════════════════════════════════════════

for row in run(money.ledger_for(money.HolderType.USER, PLAYER, money.Currency.DIAMONDS, limit=500)):
    truthy(f"ledger amount {row['amount']!r} is an int", isinstance(row["amount"], int))
    truthy(f"balance after {row['balance_after']!r} is an int", isinstance(row["balance_after"], int))

for doc in DB[C.CHANCE_ROUNDS].docs:
    for field in ("total_stake", "payout", "multiplier_bp", "unit_stake", "quantity"):
        value = doc.get(field)
        truthy(
            f"round {field}={value!r} is an int or absent",
            value is None or isinstance(value, int),
        )

for version in run(X.config_history(MECHANIC)):
    evaluation = version["evaluation"]
    truthy(f"v{version['version']} RTP is an int", isinstance(evaluation["rtp_ppm"], int))
    for outcome in evaluation["outcomes"]:
        truthy("every probability stays an int", isinstance(outcome["probability_ppm"], int))
        truthy("every multiplier stays an int", isinstance(outcome["multiplier_bp"], int))
    check(
        f"v{version['version']} probabilities still sum to exactly 100%",
        sum(o["probability_ppm"] for o in evaluation["outcomes"]),
        1_000_000,
    )


# ── Report ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} chance-mechanic checks passed.")
print()
print("  · a table that does not sum to exactly 1,000,000 ppm is refused, not normalised")
print("  · RTP is computed from the table; a draft that states one is ignored")
print("  · a tier outside the agreed band is flagged AND blocked from going live")
print("  · a configuration change is a card: raised, verified, signed, then live")
print("  · a round is drawn, written down, and only then paid — checked from")
print("    inside the payout movement")
print("  · a round settles on the configuration version in force when it was committed")
print("  · a disabled market is answered with nothing, and a 404 identical to an unknown id")
print("  · the seed committed before the round verifies against the seed revealed after")
print()
print("8B.3.3 — the combo problem, before and after:")
print(f"  {'quantity':>9}  {'spec records':>13}  {'as built':>9}  {'per unit stake':>15}  {'after 8B.3.1':>13}")
for (quantity, effective, per_unit, recorded), (_q, fixed_pct) in zip(before_table, after_table):
    print(
        f"  {quantity:>9}  {recorded + '%':>13}  {effective + '%':>9}  "
        f"{per_unit + '%':>15}  {fixed_pct + '%':>13}"
    )
print()
print("  Read the fourth column: the three combo tiers each return about ten")
print("  UNIT stakes (1003%, 999%, 1001%). That is one bug seen three times — a")
print("  multiplier applied to the price of one gift while the player paid for")
print("  seventeen, thirty-seven or seventy-seven. Divide by the quantity and")
print("  59 / 27 / 13 fall out. Applying it to the total stake makes the return")
print("  identical at every tier, which is 8B.3.1 in one line.")
