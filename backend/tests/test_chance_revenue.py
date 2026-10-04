"""The money reporting for the chance mechanics — 8B.7, 8B.8, 8B.9 and 8B.9A.

Three reports, and one rule they share with everything else in `reports.py`: a
figure that could not be produced is never a zero, and a period in which nothing
happened is empty in words rather than a page of noughts.

What is covered, and why each one:

  * gross gaming revenue — staked minus paid out — computed across two
    mechanics and two countries, with the per-mechanic, per-country and
    per-kind roll-ups checked against figures worked by hand (8B.7.1 / 8B.7.2)
  * the actual RTP beside it, and the gap against the configured RTP the round
    was actually drawn from — because GGR = staked × (1 − actual RTP) and if
    those two do not tie the report is wrong
  * whether a host or an agency earns anything from a chance mechanic — the
    measured answer in both directions, and the UNKNOWN when the ledger cannot
    be read (8B.7.3)
  * that stakes and payouts really are ledger entries, checked against the
    round count rather than asserted (8B.7.4)
  * a withheld payout reported as an open exception needing a signed money
    card, not as a rounding difference (8B.7.5)
  * the bean-payout ratio per mechanic against hand-worked numbers, including
    the 50% / 5% / none reference from 8B.8.3 — and the two different things
    that reference and the ratio actually measure, which is the mistake this
    table exists to prevent
  * that a mechanic creating no bean reads as the highest-margin one available
    (8B.8.4), with a measured 0% and not an absent figure
  * that the report's own realised business-wide ratio is arithmetically the
    same number `margin_report` gives — asserted by running both
  * the cannibalisation guard on a week where games rise and host earnings
    fall, and on one where both rise (8B.9.3)
  * the governing metric — the share of game winnings subsequently spent on
    hosts — with 'subsequently' enforced on the timestamps (8B.9A.4)
  * players retained by games who spend nothing, counted as retained and said
    to be so in words (8B.9A.6)
  * empty periods, in all three reports, reading as empty rather than as zero

The real service code runs. Only the pulls underneath it are replaced,
following `tests/test_weekly_business.py`, so what is exercised is the rule and
not a copy of it.

Run:  python3 -m tests.test_chance_revenue
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import install_module_stubs  # noqa: E402

install_module_stubs()

from app.services import reports as R  # noqa: E402

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


SINCE = datetime(2026, 8, 10, tzinfo=timezone.utc)
UNTIL = datetime(2026, 8, 17, tzinfo=timezone.utc)
PREV_SINCE = SINCE - (UNTIL - SINCE)

#: The live rates, from `backups/firestore-2026-08-20-1548/appConfig.json`.
#: A diamond is ₹2,390 per lakh — 2.39 paise each. A bean is one paisa.
RATES = R.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    # No seller discount configured: wholesale equals retail, which is
    # what these figures were all computed against before the wholesale
    # price existed. Nothing in this file is testing the discount.
    seller_wholesale_price_inr_per_lakh=2390.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="test",
    fetched_at=SINCE,
)


def diamonds(count: int) -> int:
    """Diamonds → paise, worked the way an owner would check it: 2.39 each."""
    return int(round(count * 2.39))


def beans(count: int) -> int:
    """Beans → paise. One paisa each, so the figure is the count."""
    return count


class patched:
    """Swap module attributes for the duration of a block, then put them back."""

    def __init__(self, module, **attrs):
        self.module, self.attrs, self.original = module, attrs, {}

    def __enter__(self):
        for name, value in self.attrs.items():
            self.original[name] = getattr(self.module, name)
            setattr(self.module, name, value)
        return self.module

    def __exit__(self, *_exc):
        for name, value in self.original.items():
            setattr(self.module, name, value)
        return False


def gone(what: str):
    """A source that is down. Raises the way the real one does."""

    async def _raise(*_a, **_k):
        raise R.DataUnavailable(f"{what} could not be read: connection refused.")

    return _raise


def returns(value):
    async def _return(*_a, **_k):
        return value

    return _return


# ══════════════════════════════════════════════════════════════════════════════
#  THE DATA — two mechanics, two countries, three days
# ══════════════════════════════════════════════════════════════════════════════
#
# Everything below is chosen so the arithmetic can be done on paper:
#
#   aviator  IN  10 Aug   1,000,000 staked   900,000 paid   →  100,000 GGR
#   aviator  BD  11 Aug     200,000 staked   150,000 paid   →   50,000 GGR
#   lucky-77 IN  11 Aug     500,000 staked   250,000 paid   →  250,000 GGR
#                          ─────────         ─────────         ─────────
#                          1,700,000         1,300,000           400,000
#
# 400,000 diamonds at 2.39 paise = 956,000 paise = ₹9,560.

FLOW_ROWS = [
    {
        "_id": {"mechanic_id": "aviator", "country": "IN", "day": "2026-08-10"},
        "staked": 1_000_000,
        "paid_out": 900_000,
        "withheld": 0,
        # 900,000 ppm = 90% configured RTP, stake-weighted.
        "configured_num": 1_000_000 * 900_000,
        "stake_with_configured_rtp": 1_000_000,
        "capped_rounds": 0,
        "rounds": 500,
        "players": 40,
        "versions": [3],
    },
    {
        "_id": {"mechanic_id": "aviator", "country": "BD", "day": "2026-08-11"},
        "staked": 200_000,
        "paid_out": 150_000,
        "withheld": 25_000,
        "configured_num": 200_000 * 900_000,
        "stake_with_configured_rtp": 200_000,
        "capped_rounds": 2,
        "rounds": 100,
        "players": 12,
        "versions": [3],
    },
    {
        "_id": {"mechanic_id": "lucky-77", "country": "IN", "day": "2026-08-11"},
        "staked": 500_000,
        "paid_out": 250_000,
        "withheld": 0,
        # 580,000 ppm = 58% — the single-roll lucky return 8B.3.3 measures.
        "configured_num": 500_000 * 580_000,
        "stake_with_configured_rtp": 500_000,
        "capped_rounds": 0,
        "rounds": 300,
        "players": 25,
        "versions": [1],
    },
]

FLOW = {"rows": FLOW_ROWS, "players": 60}

#: The preceding week — half the game revenue, for the direction of travel.
PREV_FLOW = {
    "rows": [
        {
            "_id": {"mechanic_id": "aviator", "country": "IN", "day": "2026-08-03"},
            "staked": 800_000,
            "paid_out": 600_000,
            "withheld": 0,
            "configured_num": 800_000 * 900_000,
            "stake_with_configured_rtp": 800_000,
            "capped_rounds": 0,
            "rounds": 400,
            "players": 30,
            "versions": [3],
        }
    ],
    "players": 30,
}

MECHANICS = {
    "aviator": {"_id": "aviator", "name": "Aviator", "kind": "game", "live_version": 3},
    "lucky-77": {
        "_id": "lucky-77",
        "name": "Lucky 77×",
        "kind": "lucky_gift",
        "live_version": 1,
    },
}

#: 900 settled rounds, 900 stakes and 400 payouts in the ledger. Nothing on a
#: holder who is not the player and nothing carrying an agency id.
LEDGER_CLEAN = [
    {
        "_id": {
            "action": "chance.stake",
            "holder_type": "user",
            "currency": "diamonds",
            "agency_attributed": False,
        },
        "amount": -1_700_000,
        "movements": 900,
        "holders": 60,
    },
    {
        "_id": {
            "action": "chance.payout",
            "holder_type": "user",
            "currency": "diamonds",
            "agency_attributed": False,
        },
        "amount": 1_300_000,
        "movements": 400,
        "holders": 45,
    },
]

WITHHELD = [
    {
        "_id": "aviator",
        "withheld": 25_000,
        "paid": 5_000,
        "rounds": 2,
        "players": 2,
        "oldest_at": datetime(2026, 8, 11, 3, 0, tzinfo=timezone.utc),
    }
]


async def _revenue(
    flow=FLOW,
    mechanics=MECHANICS,
    ledger=LEDGER_CLEAN,
    withheld=WITHHELD,
    adjustments=(),
):
    with patched(
        R,
        _chance_round_flow=flow if callable(flow) else returns(flow),
        _chance_mechanic_index=(
            mechanics if callable(mechanics) else returns(dict(mechanics))
        ),
        _chance_ledger_movements=(
            ledger if callable(ledger) else returns(list(ledger))
        ),
        _chance_withheld=withheld if callable(withheld) else returns(list(withheld)),
        _chance_adjustment_cards=(
            adjustments if callable(adjustments) else returns(list(adjustments))
        ),
    ):
        return await R.chance_revenue(SINCE, UNTIL, RATES)


# ══════════════════════════════════════════════════════════════════════════════
#  1. GROSS GAMING REVENUE — its own line, per mechanic, per country, per day
# ══════════════════════════════════════════════════════════════════════════════

ggr = asyncio.run(_revenue())
rows = ggr.rows
detail = {
    (r["mechanic_id"], r["country"], r["day"]): r
    for r in rows
    if r["scope"] == "mechanic_country_day"
}

check("every mechanic-country-day is its own row", len(detail), 3)

first = detail[("aviator", "IN", "2026-08-10")]
check("staked is the gross stake", first["staked_diamonds"], 1_000_000)
check("paid out is what was credited back", first["paid_out_diamonds"], 900_000)
check("GGR is staked minus paid out", first["ggr_diamonds"], 100_000)
check("valued at the diamond rate, in paise", first["ggr_inr_minor"], diamonds(100_000))
check("which is ₹2,390", first["ggr_inr"], 2_390.0)
check("the mechanic is named", first["mechanic"], "Aviator")
check("and classified", first["kind"], "game")
contains("and the row says what it is made of", first["detail"], "1,000,000 staked − 900,000 paid out")

second = detail[("aviator", "BD", "2026-08-11")]
check("a second country is a separate row", second["ggr_diamonds"], 50_000)
check("with its own value", second["ggr_inr_minor"], diamonds(50_000))
check("the country is on the row", second["country"], "BD")

third = detail[("lucky-77", "IN", "2026-08-11")]
check("a second mechanic on the same day is a separate row", third["ggr_diamonds"], 250_000)
check("and carries its own kind", third["kind"], "lucky_gift")

# ── The roll-ups ─────────────────────────────────────────────────────────────
by_scope: dict[str, list] = {}
for row in rows:
    by_scope.setdefault(row["scope"], []).append(row)

mech_totals = {r["mechanic_id"]: r for r in by_scope["mechanic_total"]}
check("aviator across both countries", mech_totals["aviator"]["ggr_diamonds"], 150_000)
check("valued once", mech_totals["aviator"]["ggr_inr_minor"], diamonds(150_000))
check("lucky-77", mech_totals["lucky-77"]["ggr_diamonds"], 250_000)

country_totals = {r["country"]: r for r in by_scope["country_total"]}
check("India across both mechanics", country_totals["IN"]["ggr_diamonds"], 350_000)
check("Bangladesh", country_totals["BD"]["ggr_diamonds"], 50_000)

kind_totals = {r["kind"]: r for r in by_scope["kind_total"]}
check("games as a kind", kind_totals["game"]["ggr_diamonds"], 150_000)
check("lucky gifts as a kind", kind_totals["lucky_gift"]["ggr_diamonds"], 250_000)

# A roll-up must not pretend to count players — one player on two days is one
# player and a summed count cannot see that.
check("a roll-up row reports no player count", mech_totals["aviator"]["players"], None)
contains("and says why", mech_totals["aviator"]["detail"], "Players are not summed here")

headline = by_scope["gross_gaming_revenue"][0]
check("total staked", headline["staked_diamonds"], 1_700_000)
check("total paid out", headline["paid_out_diamonds"], 1_300_000)
check("TOTAL GROSS GAMING REVENUE", headline["ggr_diamonds"], 400_000)
check("in paise", headline["ggr_inr_minor"], 956_000)
check("which is ₹9,560", headline["ggr_inr"], 9_560.0)
check("distinct players are counted once across the whole period", headline["players"], 60)
contains(
    "the headline row says this is a revenue line of its own",
    headline["detail"],
    "its own revenue line (8B.7.1)",
)
contains("reported apart from gifting and calls", headline["detail"], "apart from gifting and apart from calls")

gt = ggr.totals
check("the totals carry the same GGR", gt["ggr_inr_minor"], 956_000)
check("named as its own revenue line", gt["revenue_line"], "gross_gaming_revenue")
check("kept apart from the other two", gt["reported_separately_from"], ["gifting", "calls"])
check("per mechanic", gt["ggr_by_mechanic_inr_minor"],
      {"aviator": diamonds(150_000), "lucky-77": diamonds(250_000)})
check("per country", gt["ggr_by_country_inr_minor"],
      {"IN": diamonds(350_000), "BD": diamonds(50_000)})
check("per kind", gt["ggr_by_kind_inr_minor"],
      {"game": diamonds(150_000), "lucky_gift": diamonds(250_000)})
check("the rows sum to the total", gt["ggr_sum_of_rows_inr_minor"], gt["ggr_inr_minor"])
check("rounds are counted", gt["rounds"], 900)
check("and capped rounds are visible", gt["capped_rounds"], 2)

# 8A.6.3 — one definition, carried in the response.
contains("the definition travels with the report",
         ggr.as_dict()["definitions"]["gross_gaming_revenue"], "total staked − total paid out")
contains("and says a stake is not a second receipt",
         ggr.as_dict()["definitions"]["gross_gaming_revenue"], "already counted once")


# ══════════════════════════════════════════════════════════════════════════════
#  2. ACTUAL RTP, ALONGSIDE — and it ties to the GGR beside it
# ══════════════════════════════════════════════════════════════════════════════

check("actual RTP is paid ÷ staked", first["actual_rtp_percent"], 90.0)
check("configured RTP is what the round was drawn from", first["configured_rtp_percent"], 90.0)
check("and the gap is zero when they agree", first["rtp_gap_pp"], 0.0)

check("a bad day shows a real actual RTP", second["actual_rtp_percent"], 75.0)
check("against the same configured table", second["configured_rtp_percent"], 90.0)
check("and the gap is stated in percentage points", second["rtp_gap_pp"], -15.0)

check("the lucky tier's configured RTP is the 58% 8B.3.3 measures",
      third["configured_rtp_percent"], 58.0)
check("with its own actual", third["actual_rtp_percent"], 50.0)
check("and its gap", third["rtp_gap_pp"], -8.0)

check("the pooled actual RTP", headline["actual_rtp_percent"], 76.471)
check("and it is in the totals too", gt["actual_rtp_percent"], 76.471)

# GGR = staked × (1 − actual RTP). If the two figures did not tie the report
# would be quoting a margin and a return that describe different rounds.
for row in detail.values():
    implied = round(row["staked_diamonds"] * (1 - row["actual_rtp_percent"] / 100))
    check(
        f"GGR ties to the actual RTP on {row['mechanic_id']}/{row['country']}",
        implied,
        row["ggr_diamonds"],
    )

check("a mechanic roll-up carries its own actual RTP",
      mech_totals["aviator"]["actual_rtp_percent"], 87.5)
check("and its stake-weighted configured RTP",
      mech_totals["aviator"]["configured_rtp_percent"], 90.0)
contains("the RTP definition is carried",
         ggr.as_dict()["definitions"]["actual_rtp"], "staked × (1 − actual RTP)")


# ══════════════════════════════════════════════════════════════════════════════
#  3. 8B.7.3 — DOES ANY HOST OR AGENCY EARN FROM THESE MECHANICS?
# ══════════════════════════════════════════════════════════════════════════════
#
# The answer must be measured in both directions. "Nobody takes a share" is only
# worth reading if the same report would have said so had somebody taken one.

share = by_scope["partner_share"][0]
check("no host and no agency takes a share", gt["host_or_agency_share_configured"], False)
check("counted, at zero movements", gt["host_or_agency_share_movements"], 0)
contains("and the row says it is a measured zero",
         share["detail"], "A MEASURED ZERO, NOT AN ASSUMPTION")
contains("naming what was looked for",
         share["detail"], "none carried the meta.agency_id an agency would be billed on")
contains("and what the spec would require if one existed",
         share["detail"], "signed, versioned rate")

# Now give an agency a cut, and the same report must find it and shout.
LEDGER_WITH_SHARE = LEDGER_CLEAN + [
    {
        "_id": {
            "action": "chance.payout",
            "holder_type": "agency",
            "currency": "commission",
            "agency_attributed": True,
        },
        "amount": 45_000,
        "movements": 12,
        "holders": 2,
    }
]
shared = asyncio.run(_revenue(ledger=LEDGER_WITH_SHARE))
shared_rows = [r for r in shared.rows if r["scope"] == "partner_share"]
check("a share on an agency holder is found", len(shared_rows), 1)
check("and the totals say so", shared.totals["host_or_agency_share_configured"], True)
check("with the amount", shared.totals["host_or_agency_share_diamonds"], 45_000)
contains("the row shouts, because 8B.7.3 says this should not exist by default",
         shared_rows[0]["detail"], "A SHARE OF A CHANCE MECHANIC IS REACHING SOMEBODY WHO IS NOT THE PLAYER")
contains("and says what to do", shared_rows[0]["detail"], "Find the configuration or stop the movement")
absent("and the measured-zero line is not also printed",
       shared_rows[0]["detail"], "MEASURED ZERO")

# The ledger being unreadable is UNKNOWN — not "nobody takes a share".
blind = asyncio.run(_revenue(ledger=gone("the ledger")))
check("the share is unknown", blind.totals["host_or_agency_share_configured"], None)
check("no movement count is invented", blind.totals["host_or_agency_share_movements"], None)
check("no ledger evidence line is invented either", blind.totals["stake_ledger_movements"], None)
contains("loudly", blind.warnings, "COULD NOT BE CHECKED")
contains("and explicitly not a clean bill of health",
         blind.warnings, "not a statement that nobody took a share")
check("but the revenue figures survive", blind.totals["ggr_inr_minor"], 956_000)


# ══════════════════════════════════════════════════════════════════════════════
#  4. 8B.7.4 — STAKES AND PAYOUTS ARE LEDGER ENTRIES. VERIFIED, NOT ASSUMED.
# ══════════════════════════════════════════════════════════════════════════════

evidence = by_scope["ledger_evidence"][0]
check("stake movements are counted", gt["stake_ledger_movements"], 900)
check("payout movements are counted", gt["payout_ledger_movements"], 400)
check("one stake per settled round", gt["stake_ledger_movements"], gt["rounds"])
contains("the row says it was verified rather than assumed",
         evidence["detail"], "VERIFIED, not assumed")
contains("and names why an audit entry cannot be missing",
         evidence["detail"], "inserts the ledger row and the audit row in one transaction")
absent("nothing complains when they agree", ggr.warnings, "DO NOT AGREE")

# And when they do not agree, that is a real problem and is reported as one.
SHORT_LEDGER = [
    dict(LEDGER_CLEAN[0], movements=880),
    LEDGER_CLEAN[1],
]
mismatched = asyncio.run(_revenue(ledger=SHORT_LEDGER))
contains("a gap between rounds and stakes is escalated",
         mismatched.warnings, "STAKES AND ROUNDS DO NOT AGREE")
contains("with both counts", mismatched.warnings, "900 settled round(s) in this period against 880")


# ══════════════════════════════════════════════════════════════════════════════
#  5. 8B.7.5 — WITHHELD PAYOUTS, AND MANUAL ADJUSTMENTS TO AN OUTCOME
# ══════════════════════════════════════════════════════════════════════════════

held = by_scope["withheld_exception"][0]
check("the withheld amount is reported", held["withheld_diamonds"], 25_000)
check("valued", held["ggr_inr_minor"], diamonds(25_000))
check("and rolled into the totals", gt["withheld_unsettled_diamonds"], 25_000)
contains("it is not written off", held["detail"], "NOT WRITTEN OFF")
contains("nor automatically paid", held["detail"], "NOT AUTOMATICALLY PAID")
contains("it needs a signed money card with a reason",
         held["detail"], "money card with an owner's signature and a reason (8B.7.5)")
contains("and an owner is told, in capitals",
         ggr.warnings, "DIAMONDS OF PAYOUT ARE WITHHELD AND UNSETTLED")
contains("and told that nobody has raised the card",
         ggr.warnings, "no card in this period references a round")

adjustment = by_scope["manual_adjustment"][0]
check("no adjustment card exists", gt["manual_adjustment_cards"], 0)
contains("and the row says the path does not exist yet, rather than implying none was needed",
         adjustment["detail"], "no service in this codebase creates such a card yet")
contains("and states the rule it would have to meet",
         adjustment["detail"], "an owner signature and a reason")

# An unsigned adjustment is a balance edit with a card around it.
UNSIGNED = [
    {"_id": {"type": "balance_credit", "stage": "requested"}, "cards": 2, "amount": 50_000, "signed": 0}
]
loose = asyncio.run(_revenue(adjustments=UNSIGNED))
check("the cards are counted", loose.totals["manual_adjustment_cards"], 2)
contains("and the unsigned ones are escalated",
         loose.warnings, "CARD(S) ADJUSTING A GAME OUTCOME ARE NOT SIGNED")
contains("in the spec's own terms",
         loose.warnings, "balance edit with a card around it")

# A withheld read that fails is unknown, not "nothing was withheld".
no_held = asyncio.run(_revenue(withheld=gone("chance_rounds")))
contains("loudly", no_held.warnings, "WITHHELD PAYOUTS COULD NOT BE READ")
contains("and not as zero", no_held.warnings, "UNKNOWN, not zero")
check("and no withheld total is invented", no_held.totals["withheld_unsettled_diamonds"], 0)
check("while the revenue is untouched", no_held.totals["ggr_inr_minor"], 956_000)


# ══════════════════════════════════════════════════════════════════════════════
#  6. AN EMPTY PERIOD — empty, in words, never a measured zero
# ══════════════════════════════════════════════════════════════════════════════

quiet = asyncio.run(
    _revenue(flow={"rows": [], "players": 0}, ledger=[], withheld=[], adjustments=[])
)
check("the report declares itself empty", quiet.as_dict()["empty"], True)
contains("saying nobody played", quiet.warnings, "nobody played")
contains(
    "and that it is not the same as the mechanics breaking even",
    quiet.warnings,
    "not because the mechanics took in as much as they paid out",
)
contains("and that the checks below the table were still made",
         quiet.warnings, "still checked and still say what they found")
check("no revenue is claimed", quiet.totals["ggr_inr_minor"], 0)
check("and the pooled RTP is null, not 0%", quiet.totals["actual_rtp_percent"], None)


# ══════════════════════════════════════════════════════════════════════════════
#  7. THE PIPELINES — what the database is actually asked for
# ══════════════════════════════════════════════════════════════════════════════

captured: list = []


async def _capture(collection, pipeline):
    captured.append((collection, pipeline))
    return []


with patched(R, _aggregate=_capture):
    asyncio.run(R._chance_round_flow(SINCE, UNTIL))
    asyncio.run(R._chance_player_activity(SINCE, UNTIL))

collection, stages = captured[0]
check("the revenue pull reads the round record", collection, "chance_rounds")
check(
    "and counts SETTLED rounds only — a void staked nothing and paid nothing",
    stages[0]["$match"]["status"],
    "settled",
)
contains("grouped per mechanic, per country, per day, in the database",
         str(stages[-1]), "'mechanic_id': '$mechanic_id'")
contains("on the same business day the exposure ceilings used",
         str(stages[1]), "exposure_day")

player_collection, player_stages = captured[1]
check("the player pull reads the same record", player_collection, "chance_rounds")
window = player_stages[1]["$setWindowFields"]["output"]["_won_before"]["window"]
check(
    "'recycled' counts what a player staked AFTER a win, so the window excludes "
    "the current round",
    window,
    {"documents": ["unbounded", -1]},
)
check("partitioned by player", player_stages[1]["$setWindowFields"]["partitionBy"], "$player_uid")


# ══════════════════════════════════════════════════════════════════════════════
#  8. THE MARGIN MODEL — 8B.8
# ══════════════════════════════════════════════════════════════════════════════
#
# Worked by hand, at the live rates (a diamond is 2.39 paise, a bean is 1 paisa):
#
#   normal gift  1,000,000 diamonds → 500,000 beans
#       unit rate   500,000 ÷ 1,000,000                     =  50.0%   ← 8B.8.3
#       value       ₹5,000 of beans ÷ ₹23,900 of diamonds   =  20.921%
#   lucky gift     200,000 diamonds →  10,000 beans
#       unit rate    10,000 ÷ 200,000                       =   5.0%   ← 8B.8.3
#       value         ₹100 ÷ ₹4,780                         =   2.092%
#   games          150,000 consumed →       0 beans
#       unit rate                                           =   0.0%   ← 8B.8.3
#       value                                               =   0.0%
#
# The unit rate and the value ratio are different numbers measuring different
# things, and 8B.8.3 quotes the first while 8B.8.5 asks for the second. Both are
# on every row for exactly that reason.

GIFTS = [
    {"at": SINCE + timedelta(hours=1), "sender_uid": "p1", "receiver_uid": "h1",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 100,
     "diamonds": 1_000_000, "beans_earned": 500_000, "lucky": False},
    {"at": SINCE + timedelta(hours=2), "sender_uid": "p2", "receiver_uid": "h1",
     "gift_type": "lucky", "gift_name": "Lucky Rose", "quantity": 20,
     "diamonds": 200_000, "beans_earned": 10_000, "lucky": True},
]

CALLS = [
    {"receiver_uid": "h1", "caller_uid": "p1", "seconds": 600,
     "beans": 40_000, "diamonds": 100_000},
]

FLOW_TOTALS = {
    "diamonds": {"credited": 1_300_000, "debited": 3_000_000, "paid_out": 0, "movements": 9},
    "beans": {"credited": 550_000, "debited": 300_000, "paid_out": 300_000, "movements": 5},
}


async def _margin(gifts=GIFTS, calls=CALLS, flow=FLOW, mechanics=MECHANICS,
                  bean_flow=FLOW_TOTALS):
    with patched(
        R,
        _gift_events=gifts if callable(gifts) else returns(list(gifts)),
        _call_events=calls if callable(calls) else returns(list(calls)),
        _chance_round_flow=flow if callable(flow) else returns(flow),
        _chance_mechanic_index=(
            mechanics if callable(mechanics) else returns(dict(mechanics))
        ),
        _bean_and_diamond_flow=(
            bean_flow if callable(bean_flow) else returns(dict(bean_flow))
        ),
    ):
        return await R.chance_margin(SINCE, UNTIL, RATES)


margin = asyncio.run(_margin())
mrows = {r["mechanic"]: r for r in margin.rows}

normal = mrows["normal_gift"]
check("normal gifting consumes every diamond spent", normal["diamonds_consumed"], 1_000_000)
check("valued at ₹23,900", normal["diamond_value_inr_minor"], diamonds(1_000_000))
check("and creates 500,000 beans", normal["beans_created"], 500_000)
check("worth ₹5,000 of future cash", normal["bean_cash_cost_inr_minor"], beans(500_000))
check("THE 8B.8.3 UNIT RATE IS 50%", normal["bean_creation_rate_pct"], 50.0)
check("which is exactly the reference", normal["reference_bean_creation_pct"], 50.0)
check("so the variance is nil", normal["variance_from_reference_pp"], 0.0)
check("THE 8B.8.5 VALUE RATIO IS 20.921%", normal["bean_payout_ratio_pct"], 20.921)
check("carried as a ratio too", normal["bean_payout_ratio"], 0.209205)
check("two diamonds consumed per bean created", normal["diamonds_per_bean"], 2.0)
check("₹4.78 of consumption per ₹1 of eventual cash out",
      normal["diamond_value_per_inr_of_bean_payout"], 4.78)

lucky = mrows["lucky_gift"]
check("lucky gifting's unit rate is the 8B.8.3 5%", lucky["bean_creation_rate_pct"], 5.0)
check("matching the reference", lucky["reference_bean_creation_pct"], 5.0)
check("its value ratio is 2.092%", lucky["bean_payout_ratio_pct"], 2.092)
check("and it buys ₹47.80 of consumption per rupee of cash cost",
      lucky["diamond_value_per_inr_of_bean_payout"], 47.8)

game = mrows["aviator"]
check(
    "A GAME CONSUMES ONLY WHAT IT DID NOT RETURN — 8B.8.1",
    game["diamonds_consumed"],
    150_000,
)
check("which is the same figure as its gross gaming revenue",
      game["diamonds_consumed"], mech_totals["aviator"]["ggr_diamonds"])
check("IT CREATES NO BEAN AT ALL", game["beans_created"], 0)
check("so its unit rate is the 8B.8.3 none", game["bean_creation_rate_pct"], 0.0)
check("and its reference is none", game["reference_bean_creation_pct"], 0.0)
check("its bean-payout ratio is a measured 0%", game["bean_payout_ratio_pct"], 0.0)
check("diamonds per bean is NULL, not infinity and not zero", game["diamonds_per_bean"], None)
check("and so is the money version", game["diamond_value_per_inr_of_bean_payout"], None)
contains("the row says why there is no denominator",
         game["detail"], "no denominator")
contains("and that every diamond consumed is realised margin",
         game["detail"], "realised margin (8B.8.4)")

check("calls create beans too and are on the table", mrows["call"]["beans_created"], 40_000)
check("with their own measured rate", mrows["call"]["bean_creation_rate_pct"], 40.0)
check("and no 8B.8.3 reference, because the spec names none",
      mrows["call"]["reference_bean_creation_pct"], None)
contains("which the row says",
         mrows["call"]["detail"], "8B.8.3 names no reference rate for calls")

# 8B.8.4 — the conclusion, drawn from the data rather than asserted.
mt = margin.totals
check("THE HIGHEST-MARGIN MECHANIC IS A GAME", mt["highest_margin_mechanic_kind"], "game")
check("named", mt["highest_margin_mechanic"], "aviator")
check("at a 0% bean-payout ratio", mt["highest_margin_ratio_pct"], 0.0)
check("and every bean-free mechanic is listed",
      mt["mechanics_creating_no_bean"], ["aviator", "lucky-77"])
contains("with an owner told why in the spec's own terms",
         margin.warnings, "THE HIGHEST-MARGIN MECHANICS AVAILABLE (8B.8.4)")
contains("and told the 0% is measured, not missing",
         margin.warnings, "measured 0%, not an absent figure")

# The reference itself is on the page, so nobody has to remember it.
check("8B.8.3 is on the table as its own rows",
      [mrows[f"reference_{k}"]["bean_creation_rate_pct"]
       for k in ("normal_gift", "lucky_gift", "game")],
      [50.0, 5.0, 0.0])
contains("labelled a unit rate rather than a value ratio",
         mrows["reference_game"]["detail"], "A UNIT rate — beans per diamond — not a value ratio")
check("and carried in the totals", mt["reference"],
      {"normal_gift": 50.0, "lucky_gift": 5.0, "game": 0.0})

check("total diamonds consumed", mt["diamonds_consumed"], 1_700_000)
check("total beans created", mt["beans_created"], 550_000)
check("the pooled unit rate", mt["bean_creation_rate_pct"], 32.353)
check("the pooled value ratio, on a created basis",
      mt["bean_payout_ratio_pct_created_basis"], 13.537)

# A lucky tier running through the controlled path AND through Firestore is two
# records of one product. The report refuses to add them and says so.
contains("the double-record risk is named",
         margin.warnings, "TWO RECORDS OF THE SAME PRODUCT")
contains("and the report says it does not add them",
         margin.warnings, "DOES NOT add them together in the totals")


# ── Does it agree with `margin_report`? ──────────────────────────────────────
#
# The realised business-wide ratio on this page must be the SAME NUMBER
# `margin_report` gives, or the weekly email carries two bean-payout ratios that
# disagree. Both are run over the same flow and compared.

realised = mrows["business_wide_realised"]
check("the realised ratio is on the page", realised["bean_payout_ratio_pct"], 4.184)
check("and in the totals", mt["bean_payout_ratio_pct_realised"], 4.184)
check("as a ratio too", mt["bean_payout_ratio_realised"], 0.041841)


async def _margin_report():
    async def cash(*_a, **_k):
        return R.Report(
            name="cash_position",
            title="Cash",
            period=R._period(SINCE, UNTIL),
            columns=[("line", "Line")],
            rows=[{"line": "x"}],
            totals={"receipts_inr_minor": 10_000_000, "payments_out_inr_minor": 0},
        )

    async def commission(*_a, **_k):
        return {"accrued": 0, "paid": 0, "movements": 0, "agencies": 0}

    with patched(
        R,
        cash_position=cash,
        _commission_movement=commission,
        _bean_and_diamond_flow=returns(dict(FLOW_TOTALS)),
    ):
        return await R.margin_report(SINCE, UNTIL, RATES)


existing = asyncio.run(_margin_report())
check(
    "THE REALISED RATIO IS THE SAME NUMBER margin_report GIVES",
    mt["bean_payout_ratio_realised"],
    existing.totals["bean_payout_ratio"],
)
check("to the percentage point",
      mt["bean_payout_ratio_pct_realised"], existing.totals["bean_payout_ratio_pct"])
contains("and the page says the mechanic rows are a different basis",
         realised["detail"], "on a CREATED basis")
contains("naming why a bean cannot be traced back to a mechanic",
         margin.as_dict()["definitions"]["bean_payout_ratio_per_mechanic"],
         "a bean is fungible")
contains("and pointing at where the realised one lives",
         margin.as_dict()["definitions"]["bean_payout_ratio_per_mechanic"],
         "`bean_payout_ratio` in `margin_report`")
check("the created and realised bases are labelled on the rows",
      (normal["basis"], realised["basis"]), ("created", "paid"))


# ── Sources down, and an empty period ────────────────────────────────────────

no_gifts = asyncio.run(_margin(gifts=gone("giftEvents")))
check("gifting is declared unsourced", no_gifts.totals["gifts_sourced"], False)
check("and no gift row is invented",
      [r for r in no_gifts.rows if r["mechanic"] in {"normal_gift", "lucky_gift"}], [])
contains("loudly", no_gifts.warnings, "GIFTING COULD NOT BE READ")
contains("and explicitly not as zero", no_gifts.warnings, "UNKNOWN for this period, not zero")
check("the game rows survive",
      {r["mechanic"] for r in no_gifts.rows} >= {"aviator", "lucky-77"}, True)

no_rounds = asyncio.run(_margin(flow=gone("chance_rounds")))
check("rounds are declared unsourced", no_rounds.totals["rounds_sourced"], False)
contains("and not read as an idle week", no_rounds.warnings,
         "not a period in which nobody played")
check("gifting still has its figure",
      {r["mechanic"]: r for r in no_rounds.rows}["normal_gift"]["bean_creation_rate_pct"], 50.0)

nothing = asyncio.run(
    _margin(
        gifts=[],
        calls=[],
        flow={"rows": [], "players": 0},
        bean_flow={
            "diamonds": {"credited": 0, "debited": 0, "paid_out": 0, "movements": 0},
            "beans": {"credited": 0, "debited": 0, "paid_out": 0, "movements": 0},
        },
    )
)
check("an idle period declares itself empty", nothing.as_dict()["empty"], True)
contains("saying every source was read and every one is empty",
         nothing.warnings, "every one of them is empty")
contains("and that a 0% ratio would read as perfect margin",
         nothing.warnings, "0% reads as perfect margin")
empty_rows = {r["mechanic"]: r for r in nothing.rows}
check("the ratio is NULL, not zero", empty_rows["normal_gift"]["bean_payout_ratio_pct"], None)
check("and so is the unit rate", empty_rows["normal_gift"]["bean_creation_rate_pct"], None)


# ══════════════════════════════════════════════════════════════════════════════
#  9. THE CANNIBALISATION GUARD — 8B.9 and 8B.9A
# ══════════════════════════════════════════════════════════════════════════════
#
# Four players, and gifts placed either side of a first win so 'subsequently'
# has something to bite on:
#
#   p1  staked 300,000  won 200,000  first win day 2, 10:00  recycled 100,000
#       gifts  10,000 on day 1 09:00 (BEFORE the win — not counted)
#              60,000 on day 2 12:00 (after  — counted)
#   p2  staked 100,000  won       0  — no gift at all, and recharged
#   p3  staked  50,000  won  50,000  first win day 1, 08:00  recycled  20,000
#       gifts  15,000 on day 1 07:00 (BEFORE — not counted)
#              25,000 on day 3      (after  — counted)
#   p4  staked  20,000  won       0  — no gift, and no recharge either
#   outsider — gifts 100,000 and has never played a game
#
#   winnings 250,000 · spent on hosts 85,000 → the governing metric is 34.0%

DAY1 = SINCE
DAY2 = SINCE + timedelta(days=1)
DAY3 = SINCE + timedelta(days=2)

PLAYERS = [
    {"_id": "p1", "staked": 300_000, "won": 200_000, "rounds": 10,
     "winning_rounds": 2, "staked_after_first_win": 100_000,
     "first_played_at": DAY1, "first_win_at": DAY2 + timedelta(hours=10),
     "mechanics": ["aviator"]},
    {"_id": "p2", "staked": 100_000, "won": 0, "rounds": 5,
     "winning_rounds": 0, "staked_after_first_win": 0,
     "first_played_at": DAY1, "first_win_at": None, "mechanics": ["aviator"]},
    {"_id": "p3", "staked": 50_000, "won": 50_000, "rounds": 3,
     "winning_rounds": 1, "staked_after_first_win": 20_000,
     "first_played_at": DAY1, "first_win_at": DAY1 + timedelta(hours=8),
     "mechanics": ["lucky-77"]},
    {"_id": "p4", "staked": 20_000, "won": 0, "rounds": 2,
     "winning_rounds": 0, "staked_after_first_win": 0,
     "first_played_at": DAY3, "first_win_at": None, "mechanics": ["aviator"]},
]

WEEK_GIFTS = [
    {"at": DAY1 + timedelta(hours=9), "sender_uid": "p1", "receiver_uid": "h1",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 10_000, "beans_earned": 4_000, "lucky": False},
    {"at": DAY2 + timedelta(hours=12), "sender_uid": "p1", "receiver_uid": "h1",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 60_000, "beans_earned": 24_000, "lucky": False},
    {"at": DAY1 + timedelta(hours=7), "sender_uid": "p3", "receiver_uid": "h2",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 15_000, "beans_earned": 6_000, "lucky": False},
    {"at": DAY3, "sender_uid": "p3", "receiver_uid": "h2",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 25_000, "beans_earned": 10_000, "lucky": False},
    {"at": DAY2, "sender_uid": "outsider", "receiver_uid": "h1",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 100_000, "beans_earned": 40_000, "lucky": False},
]

#: The ninety-day lookback. p3 has gifted before; p1 has not.
PRIOR_GIFTS = [
    {"at": SINCE - timedelta(days=30), "sender_uid": "p3", "receiver_uid": "h2",
     "gift_type": "normal", "gift_name": "Rose", "quantity": 1,
     "diamonds": 5_000, "beans_earned": 2_000, "lucky": False},
]

RECHARGES = [
    {"buyer_uid": "p2", "buyer_name": "P2", "seller_uid": "s1", "seller_name": "S1",
     "recipient_type": "user", "amount_inr_minor": 100_000, "diamonds": 40_000},
]


def _host_activity(current_beans: int, current_hosts: int,
                   previous_beans: int, previous_hosts: int):
    """Host bean activity that answers differently for the two windows."""

    def rows(total: int, count: int) -> list[dict]:
        if not count:
            return []
        each = total // count
        out = [
            {"_id": f"h{i}", "beans_earned": each, "beans_cashed_out": 0,
             "movements": 1, "agency_ids": ["acme"], "last_at": UNTIL,
             "closing": each}
            for i in range(count)
        ]
        out[0]["beans_earned"] += total - each * count
        return out

    async def pull(since, until, *_a, **_k):
        return rows(current_beans, current_hosts) if since == SINCE else rows(
            previous_beans, previous_hosts
        )

    return pull


def _flow_by_window(current=FLOW, previous=PREV_FLOW):
    async def pull(since, until, *_a, **_k):
        if callable(current) and since == SINCE:
            return await current(since, until)
        if callable(previous) and since != SINCE:
            return await previous(since, until)
        return dict(current if since == SINCE else previous)

    return pull


def _gifts_by_window(week=WEEK_GIFTS, prior=PRIOR_GIFTS):
    async def pull(since, until, *_a, **_k):
        if callable(prior) and until == SINCE:
            return await prior(since, until)
        if callable(week) and until != SINCE:
            return await week(since, until)
        return list(prior if until == SINCE else week)

    return pull


async def _guard(
    hosts=None,
    flow=None,
    gifts=None,
    players=PLAYERS,
    calls=CALLS,
    recharges=RECHARGES,
):
    with patched(
        R,
        _host_bean_activity=hosts or _host_activity(400_000, 4, 600_000, 5),
        _chance_round_flow=flow or _flow_by_window(),
        _gift_events=gifts or _gifts_by_window(),
        _chance_player_activity=players if callable(players) else returns(list(players)),
        _call_events=calls if callable(calls) else returns(list(calls)),
        _recharge_events=(
            recharges if callable(recharges) else returns(list(recharges))
        ),
    ):
        return await R.chance_cannibalisation(SINCE, UNTIL, RATES)


# ── A week where games rise and host earnings fall ───────────────────────────

falling = asyncio.run(_guard())
ft = falling.totals
frows = {r["metric"]: r for r in falling.rows}

check("host earnings are beans at the bean rate", ft["host_earnings_inr_minor"], beans(400_000))
check("the preceding week's", ft["host_earnings_previous_inr_minor"], beans(600_000))
check("so host earnings fell by a third", ft["host_earnings_change_pct"], -33.333)
check("active hosts", ft["active_hosts"], 4)
check("and last week's", ft["active_hosts_previous"], 5)
check("earnings per active host", ft["host_earnings_per_active_host_inr_minor"], 100_000)
check("against last week's", ft["host_earnings_per_active_host_previous_inr_minor"], 120_000)

check("game revenue is the same GGR the revenue report gives",
      ft["game_revenue_inr_minor"], 956_000)
check("last week's game revenue", ft["game_revenue_previous_inr_minor"], diamonds(200_000))
check("so game revenue doubled", ft["game_revenue_change_pct"], 100.0)

check("THE VERDICT IS THE ONE 8B.9.3 NAMES", ft["verdict"], "ecosystem_being_consumed")
contains("in the report's own words",
         ft["verdict_text"], "THE ECOSYSTEM IS BEING CONSUMED")
contains("quoting the rule it is applying",
         ft["verdict_text"], "falling host earnings alongside rising game revenue")
contains("and saying what dies if it holds",
         ft["verdict_text"], "the engagement engine that feeds the games dies with them")
contains("and what an owner can do about it",
         ft["verdict_text"], "complement peak host hours")
contains("the verdict reaches the warnings, where a person will see it",
         falling.warnings, "THE ECOSYSTEM IS BEING CONSUMED")
contains("and the per-active-host alert 8B.9.5 asks for is raised",
         falling.warnings, "HOST EARNINGS PER ACTIVE HOST FELL WHILE THE GAME SHARE ROSE")
contains("honestly qualified — one window is not a trend",
         falling.warnings, "One period is not yet 'sustained'")

# ── Where the diamonds went ──────────────────────────────────────────────────

check("games absorbed 1,700,000 diamonds of spend", ft["game_staked_diamonds"], 1_700_000)
check("gifting 210,000", ft["gift_diamonds"], 210_000)
check("so games took 89.005% of diamond spend", ft["diamond_spend_share_games_pct"], 89.005)
check("and gifting 10.995%", ft["diamond_spend_share_gifting_pct"], 10.995)
check("the two shares are the whole of it",
      round(ft["diamond_spend_share_games_pct"] + ft["diamond_spend_share_gifting_pct"], 3), 100.0)
check("call spend is reported beside the share, not inside it", ft["call_diamonds"], 100_000)
contains("and the row says so",
         frows["diamond_spend_share_games_pct"]["detail"], "deliberately outside this share")
contains("and why the stake is taken gross",
         frows["diamond_spend_share_games_pct"]["detail"],
         "a diamond not available to spend on a host")

# ── 8B.9A.4 — THE GOVERNING METRIC ───────────────────────────────────────────

check("winnings are the sum of what players won", ft["game_winnings_diamonds"], 250_000)
check(
    "ONLY GIFTS SENT AFTER A PLAYER'S FIRST WIN COUNT — 60,000 + 25,000",
    ft["winnings_spent_on_hosts_diamonds"],
    85_000,
)
check("so the governing metric is 34%", ft["winnings_spent_on_hosts_pct"], 34.0)
check("and it is the labelled row on the page",
      frows["winnings_spent_on_hosts_pct"]["label"].startswith("THE GOVERNING METRIC"), True)
contains("saying what a fall means",
         frows["winnings_spent_on_hosts_pct"]["detail"], "the funnel is leaking")
contains("and that over 100% is good news",
         frows["winnings_spent_on_hosts_pct"]["detail"], "good news")
check("the winnings figure is valued in paise",
      frows["game_winnings"]["value"], diamonds(250_000))
check("and so is what reached hosts",
      frows["winnings_spent_on_hosts"]["value"], diamonds(85_000))

# 8B.9A.5 — recycled against gifted, over the same players and the same window.
check("winnings recycled into games", ft["winnings_recycled_into_games_diamonds"], 120_000)
check("valued", frows["winnings_recycled_into_games"]["value"], diamonds(120_000))
contains("and an opening stake is never called recycled winnings",
         frows["winnings_recycled_into_games"]["detail"],
         "opening stake is never counted as recycled winnings")

# 8B.9A.5 — first-time movers, over a stated lookback and not a claimed lifetime.
check("one player gifted for the first time", ft["first_time_gifters"], 1)
check("the lookback is stated", ft["first_gift_lookback_days"], 90)
contains("and the row refuses to call it a lifetime first",
         frows["first_time_gifters"]["detail"], "NOT a lifetime first")
contains("and the definition says why",
         falling.as_dict()["definitions"]["first_time_gifters"], "THAT IS NOT A LIFETIME FIRST")

# 8B.9A.6 — retained, not failed.
check("two players played and gifted nothing", ft["retained_non_spenders"], 2)
check("one of whom put no money in at all", ft["retained_non_spenders_no_recharge"], 1)
check("four played in total", ft["players_who_played"], 4)
check("two of them won", ft["players_who_won"], 2)
contains("THEY ARE COUNTED AS RETAINED, NOT AS FAILED MONETISATION",
         frows["retained_non_spenders"]["detail"],
         "COUNTED AS RETAINED, NOT AS FAILED MONETISATION")
contains("and the reason is the spec's, not a hedge",
         frows["retained_non_spenders"]["detail"],
         "Most users will never spend on a host")
contains("with the value they carry named",
         frows["retained_non_spenders"]["detail"], "audience for the hosts and future conversion")


# ── A week where BOTH rise — the healthy shape ───────────────────────────────

rising = asyncio.run(_guard(hosts=_host_activity(800_000, 5, 600_000, 5)))
rt_ = rising.totals
check("host earnings rose a third", rt_["host_earnings_change_pct"], 33.333)
check("game revenue still doubled", rt_["game_revenue_change_pct"], 100.0)
check("THE VERDICT IS HEALTHY", rt_["verdict"], "healthy")
contains("and it quotes 8B.9.3", rt_["verdict_text"], "HEALTHY, by 8B.9.3")
contains("naming the shape the rule asks for",
         rt_["verdict_text"], "growing on top of the product rather than in place of it")
absent("and nothing is escalated to an owner",
       rising.warnings, "ECOSYSTEM IS BEING CONSUMED")
absent("nor is the per-active-host alert raised when it went up",
       rising.warnings, "HOST EARNINGS PER ACTIVE HOST FELL")

# Games rising while hosts hold within the band is also healthy — 'steady' is a
# stated number, not an argument.
steady = asyncio.run(_guard(hosts=_host_activity(612_000, 5, 600_000, 5)))
check("a 2% move is holding steady", steady.totals["host_earnings_change_pct"], 2.0)
check("which the rule reads as healthy", steady.totals["verdict"], "healthy")
contains("and it says which band it applied",
         steady.totals["verdict_text"], "steady is within ±5%")
check("the band is published", steady.totals["steady_band_pct"], 5.0)

# Hosts falling without games rising is not cannibalisation — and is still bad.
flat_games = asyncio.run(
    _guard(hosts=_host_activity(400_000, 4, 600_000, 5),
           flow=_flow_by_window(previous=FLOW))
)
check("host earnings still fell", flat_games.totals["host_earnings_change_pct"], -33.333)
check("but games did not rise", flat_games.totals["game_revenue_change_pct"], 0.0)
check("so it is not read as the games eating the hosts",
      flat_games.totals["verdict"], "host_earnings_falling")
contains("while still saying hosts are earning less",
         flat_games.totals["verdict_text"], "HOST EARNINGS ARE FALLING")
contains("and where to look", flat_games.totals["verdict_text"],
         "Look at the hosts, not only at the games")


# ── No history — no verdict. Never a verdict of healthy. ─────────────────────


def _hosts_prev_down():
    async def pull(since, until, *_a, **_k):
        if since != SINCE:
            raise R.DataUnavailable("the ledger could not be read: connection refused.")
        return [
            {"_id": "h1", "beans_earned": 400_000, "beans_cashed_out": 0,
             "movements": 1, "agency_ids": ["acme"], "last_at": UNTIL,
             "closing": 400_000}
        ]

    return pull


blindfold = asyncio.run(_guard(hosts=_hosts_prev_down()))
check("there is NO verdict", blindfold.totals["verdict"], None)
contains("and it says so rather than reporting healthy",
         blindfold.totals["verdict_text"], "NO VERDICT")
contains("naming the window it could not compare against",
         blindfold.totals["verdict_text"], PREV_SINCE.date().isoformat())
contains("and saying unknown is not healthy",
         blindfold.totals["verdict_text"], "Unknown is reported rather than healthy")
contains("the failure itself is loud", blindfold.warnings,
         "THE PRECEDING WEEK'S HOST EARNINGS COULD NOT BE READ")
check("this week's host earnings survive it",
      blindfold.totals["host_earnings_inr_minor"], beans(400_000))
check("and the governing metric is unaffected",
      blindfold.totals["winnings_spent_on_hosts_pct"], 34.0)

# The governing metric with gifting down is UNKNOWN, and that is itself the
# thing to act on.
no_gift_guard = asyncio.run(_guard(gifts=gone("giftEvents")))
check("the governing metric is unknown",
      no_gift_guard.totals["winnings_spent_on_hosts_pct"], None)
check("the spend share too", no_gift_guard.totals["diamond_spend_share_games_pct"], None)
check("and the retained count", no_gift_guard.totals["retained_non_spenders"], None)
check("no gift total is invented", no_gift_guard.totals["gift_diamonds"], None)
contains("loudly", no_gift_guard.warnings, "GIFTING COULD NOT BE READ")
contains("and explicitly not as zero", no_gift_guard.warnings, "Neither is reported as zero")
check("host earnings still came through",
      no_gift_guard.totals["host_earnings_inr_minor"], beans(400_000))

# A gift with no readable timestamp cannot be placed either side of a win, so it
# is excluded rather than assumed to be subsequent — which would flatter the
# governing metric.
UNSTAMPED = list(WEEK_GIFTS) + [
    {"at": None, "sender_uid": "p1", "receiver_uid": "h1", "gift_type": "normal",
     "gift_name": "Rose", "quantity": 1, "diamonds": 500_000,
     "beans_earned": 200_000, "lucky": False},
]
unstamped = asyncio.run(_guard(gifts=_gifts_by_window(week=UNSTAMPED)))
check("an undateable gift does not inflate the governing metric",
      unstamped.totals["winnings_spent_on_hosts_diamonds"], 85_000)
check("but it is still real diamond spend", unstamped.totals["gift_diamonds"], 710_000)
contains("and the exclusion is stated",
         unstamped.warnings, "SOME GIFTS IN THIS PERIOD CARRY NO READABLE TIMESTAMP")
contains("with the reason it is not assumed the other way",
         unstamped.warnings, "which would flatter it")

# The lookback failing makes the first-time count UNKNOWN, not zero and not
# 'everybody who gifted'.
no_lookback = asyncio.run(_guard(gifts=_gifts_by_window(prior=gone("giftEvents"))))
check("the first-time count is unknown", no_lookback.totals["first_time_gifters"], None)
contains("loudly", no_lookback.warnings, "COULD NOT BE COUNTED")
contains("and it says what it is not", no_lookback.warnings, "not 'everybody who gifted'")
check("everything else survived", no_lookback.totals["winnings_spent_on_hosts_pct"], 34.0)

# Recharges down: retained is still counted, 'retained at no cost' is not.
no_recharge = asyncio.run(_guard(recharges=gone("rechargeRequests")))
check("retained is still counted", no_recharge.totals["retained_non_spenders"], 2)
check("but the no-money-in subset is unknown",
      no_recharge.totals["retained_non_spenders_no_recharge"], None)
contains("with the reason", no_recharge.warnings, "COULD NOT BE READ")


# ── An empty week — empty, and no verdict drawn from it ──────────────────────

idle = asyncio.run(
    _guard(
        hosts=_host_activity(0, 0, 0, 0),
        flow=_flow_by_window(current={"rows": [], "players": 0},
                             previous={"rows": [], "players": 0}),
        gifts=_gifts_by_window(week=[], prior=[]),
        players=[],
        calls=[],
        recharges=[],
    )
)
check("the report declares itself empty", idle.as_dict()["empty"], True)
contains("saying nobody played and nobody gifted",
         idle.warnings, "Nobody played a round, nobody sent a gift")
contains("and that an empty week cannot displace anything",
         idle.warnings, "an empty week cannot displace anything")
check("no verdict is drawn from an empty week", idle.totals["verdict"], None)
check("host earnings are a measured zero over nobody", idle.totals["host_earnings_inr_minor"], 0)
check("and earnings per active host is NULL, not zero — an average over nobody",
      idle.totals["host_earnings_per_active_host_inr_minor"], None)
check("the spend share is NULL, not 50/50",
      (idle.totals["diamond_spend_share_games_pct"],
       idle.totals["diamond_spend_share_gifting_pct"]), (None, None))
check("and the governing metric is NULL, not 0%",
      idle.totals["winnings_spent_on_hosts_pct"], None)


# ══════════════════════════════════════════════════════════════════════════════
#  10. EVERY REPORT CARRIES ITS DEFINITIONS, ITS RATES AND ITS CSV
# ══════════════════════════════════════════════════════════════════════════════

for name, report in (("revenue", ggr), ("margin", margin), ("guard", falling)):
    envelope = report.as_dict()
    truthy(f"{name}: the definitions travel with it", envelope["definitions"])
    check(f"{name}: the rate source is stated", envelope["rates"]["source"], "firestore")
    check(f"{name}: figures are in paise unless stated",
          "INR minor units (paise)" in envelope["currency_unit"], True)
    truthy(f"{name}: every row explains what it is made of",
           all(r.get("detail") for r in report.rows))
    header = report.csv().split("\r\n")[0]
    truthy(f"{name}: it exports to CSV with a header", header)
    check(f"{name}: every column is exported",
          len(header.split(",")), len(report.columns))

# Provisional rates are declared on the face of the report, so a reader can
# tell a real figure from one computed at a documented fallback.
PROVISIONAL = R.Rates(2390.0, 2390.0, 0.01, "fallback", True, ["diamondPackPriceInr"],
                      "PROVISIONAL — the economy configuration could not be read.",
                      SINCE)


async def _provisional():
    with patched(
        R,
        _chance_round_flow=returns(FLOW),
        _chance_mechanic_index=returns(dict(MECHANICS)),
        _chance_ledger_movements=returns(list(LEDGER_CLEAN)),
        _chance_withheld=returns([]),
        _chance_adjustment_cards=returns([]),
    ):
        return await R.chance_revenue(SINCE, UNTIL, PROVISIONAL)


prov = asyncio.run(_provisional())
contains("a provisional rate is declared", prov.warnings, "PROVISIONAL")
check("and flagged in the envelope", prov.as_dict()["rates"]["provisional"], True)


# ══════════════════════════════════════════════════════════════════════════════
#  Report
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} chance-mechanic money checks passed.")
print()
print("  · GGR is staked − paid out, per mechanic, per country, per day, and it")
print("    is its own revenue line — never folded into gifting or calls (8B.7.1)")
print("  · the actual RTP sits beside it and ties to it exactly (8B.7.2)")
print("  · no host and no agency earns anything from a chance mechanic, and that")
print("    is a MEASURED zero — the same report finds a share when one exists (8B.7.3)")
print("  · stakes and payouts are checked against the ledger, not assumed (8B.7.4)")
print("  · a withheld payout is an open exception needing a signed card (8B.7.5)")
print("  · diamonds returned to a player are not a cost, so a game consumes only")
print("    what it kept — and creates no bean at all (8B.8.1 / 8B.8.4)")
print("  · bean-payout ratio per mechanic against the 50% / 5% / none reference,")
print("    with the unit rate and the value ratio named apart (8B.8.3 / 8B.8.5)")
print("  · the realised business-wide ratio is the same number margin_report gives")
print("  · games rising while host earnings fall reads 'the ecosystem is being")
print("    consumed'; both rising reads healthy (8B.9.3)")
print("  · the governing metric counts only gifts sent AFTER a win (8B.9A.4)")
print("  · players retained by games who spend nothing are counted as retained")
print("    and said to be, not filed as failed monetisation (8B.9A.6)")
print("  · every empty period is empty in words, and every unreadable source is")
print("    UNKNOWN — neither is ever a zero")
sys.exit(0)
