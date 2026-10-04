"""Agency commission engine tests.

The commission slab engine decides what every agency in the business is owed.
It is pure arithmetic over a configured table, so it can be verified directly —
no database, no Firestore, no network — and it is verified against the **real**
slab table, read out of `backups/firestore-2026-08-20-1548/appConfig.json`,
rather than against bands invented for the test.

Run:  python3 -m tests.test_commission
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import commission as C  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def refuses(label: str, fn, *, error=C.CommissionError) -> None:
    """This input must be refused, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = fn()
    except error:
        return
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}")
        return
    failures.append(f"{label}: was NOT refused — returned {result!r}")


# ── The real slab tables ──────────────────────────────────────────────────────

BACKUP = ROOT / "backups" / "firestore-2026-08-20-1548" / "appConfig.json"


def live_config() -> dict:
    docs = json.loads(BACKUP.read_text())
    economy = next(d for d in docs if d["id"] == "economy")
    return economy["data"]["commissionConfig"]


CONFIG = live_config()
MAIN_RAW = CONFIG["mainAgencySlabs"]
SUB_RAW = CONFIG["subAgencySlabs"]

MAIN = C.parse_slabs(MAIN_RAW)
SUB = C.parse_slabs(SUB_RAW)

check("live main table has 9 bands", len(MAIN), 9)
check("live sub table has 9 bands", len(SUB), 9)
check("main floor is ₹25,001", C.floor_minor(MAIN), 25_001 * 100)
check("sub floor is ₹26,001", C.floor_minor(SUB), 26_001 * 100)

# The fallbacks must be the live tables, not a second opinion.
check("fallback main matches live", C.FALLBACK_MAIN_SLABS, [
    {k: s[k] for k in ("from", "to", "rate")} for s in MAIN_RAW
])
check("fallback sub matches live", C.FALLBACK_SUB_SLABS, [
    {k: s[k] for k in ("from", "to", "rate")} for s in SUB_RAW
])


def rupees(amount) -> int:
    """A rupee figure as integer paise, without ever touching a float."""
    from decimal import Decimal

    return int((Decimal(str(amount)) * 100).to_integral_value())


def commission(amount, slabs=MAIN) -> int:
    minor, _ = C.commission_for(rupees(amount), slabs)
    return minor


# ══════════════════════════════════════════════════════════════════════════════
# 1. The worked examples the owner confirmed. Main agency, live slabs.
# ══════════════════════════════════════════════════════════════════════════════

check("₹10,000 — below the floor", commission(10_000), 0)
check("₹25,000 — below the floor", commission(25_000), 0)

# ₹10,00,000, band by band. The owner confirmed this figure against a table of
# the slices, so it is written out the same way rather than as one constant:
#      5%  × ₹50,000      =    ₹2,500.00
#    7.5%  × ₹75,000      =    ₹5,625.00
#     10%  × ₹1,50,000    =   ₹15,000.00
#     14%  × ₹2,00,000    =   ₹28,000.00
#     16%  × ₹3,00,000    =   ₹48,000.00
#     18%  × ₹1,99,999.01 =   ₹35,999.82
#                           ─────────────
#                            ₹1,35,124.82
check("₹10,00,000 — progressive", commission(1_000_000), rupees("135124.82"))
check("₹1,00,00,000 — progressive", commission(10_000_000), rupees("2333124.75"))

# The same figures as the arithmetic the rule describes, so a wrong
# implementation cannot pass by agreeing with a hardcoded constant.
def by_hand(total_rupees) -> int:
    """The rule, written out independently of the implementation."""
    total = rupees(total_rupees)
    raw = 0
    for band in MAIN:
        if total < band.from_minor:
            break
        lower_edge = band.from_minor - 1
        ceiling = total if band.to_minor is None else min(total, band.to_minor)
        raw += (ceiling - lower_edge) * band.rate_bp
    return (raw + 5_000) // 10_000


for amount in (25_001, 100_000, 1_000_000, 10_000_000, 4_37_512):
    check(f"₹{amount:,} matches the rule computed by hand",
          commission(amount), by_hand(amount))


# ── Progressive, not flat ─────────────────────────────────────────────────────
# The rule changed here deliberately. It was flat by band — the total picked one
# band and that rate applied to everything — and the owner confirmed against a
# worked example that it should be progressive, each slice at its own rate.
#
# On ₹10,00,000 that is the difference between ₹1,80,000 and ₹1,35,124.82:
# ₹44,875 per agency per period, so it is asserted from both directions.

_, at_lakh = C.commission_for(rupees(100_000), MAIN)
check("several bands are crossed, not one", at_lakh["bands_crossed"], 2)
check("the slices are reported", len(at_lakh["slices"]), 2)
check(
    "the slices sum to the total that is paid",
    sum(s["slice_minor"] for s in at_lakh["slices"]),
    rupees(100_000) - (rupees(25_001) - 1),
)
check(
    "the effective rate is BELOW the top band's rate",
    float(at_lakh["effective_rate_percent"]) < float(at_lakh["rate_percent"]),
    True,
)

flat_at_lakh = rupees(100_000) * 750 // 10_000
check("progressive is not the flat figure", commission(100_000) != flat_at_lakh, True)
check("and it is smaller", commission(100_000) < flat_at_lakh, True)

# The part below the floor never attracts a rate, however large the total.
_, at_crore = C.commission_for(rupees(10_000_000), MAIN)
check("the sub-floor slice is excluded", at_crore["untaxed_minor"], rupees(25_001) - 1)

# Flat had a cliff: one more rupee of billing at a band edge could pay
# thousands more. Progressive must not.
before = commission(75_000)
after = commission(75_001)
check("no cliff at a band edge", after - before < rupees(1), True)
check("and it still goes up", after > before, True)

# More billing never earns less. Under flat this held only because the rates
# rise; under progressive it is structural, and worth pinning.
worst, last = 0, -1
for step in range(0, 3_000_000, 7_919):
    now = commission(step)
    if now < last:
        worst += 1
    last = now
check("more billing never earns less", worst, 0)


# ══════════════════════════════════════════════════════════════════════════════
# 2. The floor. Deliberate, and it stays.
# ══════════════════════════════════════════════════════════════════════════════

check("₹0 earns nothing", commission(0), 0)
check("₹1 earns nothing", commission(1), 0)
check("one paisa below the floor", commission("25000.99"), 0)
# Exactly on the floor: one paisa is inside the first band, so the commission is
# effectively nothing. Under the old flat rule this paid 5% of the whole
# ₹25,001 — ₹1,250 — which meant a rupee of extra billing at the floor was worth
# ₹1,250. Progressive removes that cliff, and this is where it shows most.
check("exactly on the floor", commission(25_001), 0)
check("just above the floor pays on the excess only", commission(26_001), rupees("50.00"))

_, below = C.commission_for(rupees(10_000), MAIN)
check("below the floor: no band matched", below["matched"], False)
check("below the floor: no band named", below["band"], None)
check("below the floor: the floor is stated", below["floor_minor"], 25_001 * 100)
check(
    "below the floor: the explanation says hosts are still paid",
    "hosts are paid their own payout in full" in below["explanation"].lower()
    or "paid their own payout" in below["explanation"],
    True,
)

# Sub-agencies have their own, higher floor.
check("sub floor: ₹26,000 earns nothing", commission(26_000, SUB), 0)
check("sub floor: exactly ₹26,001 earns nothing yet", commission(26_001, SUB), 0)
check("sub: ₹27,001 pays 5% of the ₹1,000 excess", commission(27_001, SUB), rupees(50))
check(
    "a sub-agency at ₹26,000 is below its floor while a main agency is above it",
    (commission(26_000, SUB), commission(26_000, MAIN) > 0),
    (0, True),
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Band boundaries — every declared bound, both tables.
# ══════════════════════════════════════════════════════════════════════════════

for name, table, raw in (("main", MAIN, MAIN_RAW), ("sub", SUB, SUB_RAW)):
    ordered = sorted(raw, key=lambda s: s["from"])
    for i, slab in enumerate(ordered):
        band = table[i]
        low, high, rate_bp = slab["from"], slab["to"], band.rate_bp

        check(
            f"{name} band {i + 1}: exactly ₹{low:,} takes {band.rate_percent}%",
            C.commission_for(rupees(low), table)[1]["band"]["index"],
            i,
        )
        check(
            f"{name} band {i + 1}: exactly ₹{high:,} takes {band.rate_percent}%",
            C.commission_for(rupees(high), table)[1]["band"]["index"],
            i,
        )
        # Progressive: at the bottom edge of a band, that band contributes
        # one paisa. Everything paid is what the bands BELOW it charged.
        lower_total = 0
        for prev in table[:i]:
            edge = prev.from_minor - 1
            top = prev.to_minor if prev.to_minor is not None else rupees(low)
            lower_total += (min(rupees(low), top) - edge) * prev.rate_bp
        check(
            f"{name} band {i + 1}: ₹{low:,} pays only what the bands below charged",
            C.commission_for(rupees(low), table)[0],
            (lower_total + rupees(low) - (band.from_minor - 1) - 1 + 0) * 0
            + (lower_total + (1 * rate_bp) + 5_000) // 10_000,
        )
        if i + 1 < len(ordered):
            # The 99 paise between one band's `to` and the next band's `from`
            # are a writing convention, not a hole. They stay in the band below.
            check(
                f"{name} band {i + 1}: ₹{high:,}.50 stays in this band",
                C.commission_for(rupees(f"{high}.50"), table)[1]["band"]["index"],
                i,
            )
            check(
                f"{name} band {i + 2}: ₹{ordered[i + 1]['from']:,} moves up",
                C.commission_for(rupees(ordered[i + 1]["from"]), table)[1]["band"]["index"],
                i + 1,
            )


# ══════════════════════════════════════════════════════════════════════════════
# 4. The top band is open-ended.
# ══════════════════════════════════════════════════════════════════════════════
#
# The live main table's top band is written 25,00,001–50,00,000. The old
# implementation only treated a band as uncapped at `to >= 999_999_999`, so
# above ₹50 lakh the excess earned nothing and the effective rate *fell*. It
# cannot now.

check("top main band is open-ended", MAIN[-1].to_minor, None)
check("top sub band is open-ended", SUB[-1].to_minor, None)

# Progressive, so these are the sum of every band, not 25% of the total. They
# are asserted against the by-hand rule rather than against constants — a
# hundred crore of billing is not a figure anyone should be checking by eye.
for amount in (5_000_000, 5_000_001, 50_000_000, 1_000_000_000):
    check(f"₹{amount:,} — every band, summed", commission(amount), by_hand(amount))

# The top band is what the excess is charged at, and it must keep being charged
# however far past the declared ceiling the billing goes.
step = commission(50_000_001) - commission(50_000_000)
check("a rupee past ₹5cr is charged at the top band's 25%", step, rupees(1) * 25 // 100)

previous_rate = -1.0
for amount in (5_000_000, 5_000_001, 10_000_000, 50_000_000, 1_000_000_000):
    rate = commission(amount) / rupees(amount)
    check(f"effective rate never falls at ₹{amount:,}", rate >= previous_rate, True)
    previous_rate = rate
# Under progressive the effective rate rises towards the top band's rate but
# never reaches it — the lower slices are always in there, pulling it down. That
# is the defining property of the rule, so it is asserted rather than the flat
# equality this used to make.
check("effective rate approaches but never reaches 25%", previous_rate < 0.25, True)
check("and at a hundred crore it is very close", round(previous_rate, 3), 0.25)

check("sub top band uncapped at ₹1cr", commission(10_000_000, SUB),
      C.commission_for(rupees(10_000_000), SUB)[0])
check("sub at ₹1cr is charged across every band", 
      C.commission_for(rupees(10_000_000), SUB)[1]["bands_crossed"], 9)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Money is integers. Rounding is half-up, once, and stated.
# ══════════════════════════════════════════════════════════════════════════════

refuses("a float billing figure", lambda: C.commission_for(2_500_100.0, MAIN))
refuses("a string billing figure", lambda: C.commission_for("2500100", MAIN))
refuses("a boolean billing figure", lambda: C.commission_for(True, MAIN))
refuses("a negative billing figure", lambda: C.commission_for(-1, MAIN))

# Rounding is half-up on the summed products, once. At ₹25,001.10 the charged
# slice is 11 paise above the floor edge; 11 × 5% = 0.55 paise, which rounds to
# 1. The neighbours either side of the half establish the direction.
check("half a paisa rounds up", C.commission_for(2_500_110, MAIN)[0], 1)
check("well under a half rounds down", C.commission_for(2_500_105, MAIN)[0], 0)
check("well over rounds up", C.commission_for(2_500_120, MAIN)[0], 1)

for amount in (25_001, 100_000, 1_000_000, 10_000_000):
    result = commission(amount)
    check(f"₹{amount:,} commission is an int", isinstance(result, int), True)

_, explained = C.commission_for(rupees(100_000), MAIN)
check("the rounding rule is stated in the breakdown", "half-up" in explained["rounding"], True)
check("the rule is stated in the breakdown", "Progressive by band" in explained["rule"], True)
check("and it says no single rate covers the whole amount",
      "No single rate is ever applied to the whole amount" in explained["rule"], True)


# ══════════════════════════════════════════════════════════════════════════════
# 6. The breakdown explains the figure.
# ══════════════════════════════════════════════════════════════════════════════

_, b = C.commission_for(rupees(1_500_000), MAIN)
check("matched", b["matched"], True)
check("band lower bound", b["band"]["from_minor"], rupees(1_200_001))
check("band upper bound", b["band"]["to_minor"], rupees(1_800_001) - 1)
check("band rate", b["band"]["rate_percent"], "21")
check("billing the rate applied to", b["billing_minor"], rupees(1_500_000))
# Progressive: ₹15,00,000 crosses seven bands, and 21% applies only to the part
# above ₹12,00,001. Flat would have paid 21% of the whole ₹15,00,000 — ₹3,15,000.
check("commission", b["commission_minor"], by_hand(1_500_000))
check("and it is well below the flat figure", b["commission_minor"] < rupees(315_000), True)
check("commission in rupees", b["commission_inr"], by_hand(1_500_000) / 100)
check("seven bands were crossed", b["bands_crossed"], 7)
check("every band is listed for context", len(b["bands_considered"]), 9)
for token in ("₹15,00,000.00", "21%"):
    check(f"explanation mentions {token}", token in b["explanation"], True)


# ══════════════════════════════════════════════════════════════════════════════
# 7. A malformed table refuses. It never pays zero, and never pays a guess.
# ══════════════════════════════════════════════════════════════════════════════

refuses("an empty table", lambda: C.parse_slabs([]), error=C.MalformedSlabTable)
refuses("a missing table", lambda: C.parse_slabs(None), error=C.MalformedSlabTable)
refuses("a table that is not a list", lambda: C.parse_slabs({"from": 1}), error=C.MalformedSlabTable)
refuses("a string instead of a table", lambda: C.parse_slabs("5%"), error=C.MalformedSlabTable)
refuses(
    "a slab that is not a mapping",
    lambda: C.parse_slabs([[25_001, 75_000, 5]]),
    error=C.MalformedSlabTable,
)
refuses(
    "a slab with no rate",
    lambda: C.parse_slabs([{"from": 25_001, "to": 75_000}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a slab with no lower bound",
    lambda: C.parse_slabs([{"to": 75_000, "rate": 5}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a non-numeric rate",
    lambda: C.parse_slabs([{"from": 25_001, "to": 75_000, "rate": "five"}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a negative rate",
    lambda: C.parse_slabs([{"from": 25_001, "to": 75_000, "rate": -5}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a rate above 100%",
    lambda: C.parse_slabs([{"from": 25_001, "to": 75_000, "rate": 140}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a rate finer than a basis point",
    lambda: C.parse_slabs([{"from": 25_001, "to": 75_000, "rate": 5.005}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a negative bound",
    lambda: C.parse_slabs([{"from": -1, "to": 75_000, "rate": 5}]),
    error=C.MalformedSlabTable,
)
refuses(
    "a fractional bound",
    lambda: C.parse_slabs([{"from": 25_000.5, "to": 75_000, "rate": 5}]),
    error=C.MalformedSlabTable,
)
refuses(
    "an upper bound below its lower bound",
    lambda: C.parse_slabs([{"from": 75_000, "to": 25_001, "rate": 5}]),
    error=C.MalformedSlabTable,
)
refuses(
    "overlapping bands",
    lambda: C.parse_slabs(
        [
            {"from": 25_001, "to": 80_000, "rate": 5},
            {"from": 75_001, "to": 150_000, "rate": 7.5},
        ]
    ),
    error=C.MalformedSlabTable,
)
refuses(
    "two bands with the same lower bound",
    lambda: C.parse_slabs(
        [
            {"from": 25_001, "to": 75_000, "rate": 5},
            {"from": 25_001, "to": 90_000, "rate": 9},
        ]
    ),
    error=C.MalformedSlabTable,
)
refuses(
    "a real gap between bands",
    lambda: C.parse_slabs(
        [
            {"from": 25_001, "to": 75_000, "rate": 5},
            {"from": 100_001, "to": 150_000, "rate": 7.5},
        ]
    ),
    error=C.MalformedSlabTable,
)
refuses("no bands at all", lambda: C.commission_for(500_000, []), error=C.MalformedSlabTable)

# A table written out of order is a formatting accident, not a different rule.
shuffled = C.parse_slabs(list(reversed(MAIN_RAW)))
check("an out-of-order table sorts", [b.rate_bp for b in shuffled], [b.rate_bp for b in MAIN])
check("and gives the same answer", C.commission_for(rupees(100_000), shuffled)[0], commission(100_000))

# A single-band table is legal: it is one open-ended band above its floor.
one = C.parse_slabs([{"from": 25_001, "to": 999_999_999, "rate": 5}])
check("single band is open-ended", one[0].to_minor, None)
check("single band below floor", C.commission_for(rupees(25_000), one)[0], 0)
# One open-ended band: 5% of everything above the floor edge, not of the whole.
check("single band above floor", C.commission_for(rupees(10_000_000), one)[0],
      ((rupees(10_000_000) - (rupees(25_001) - 1)) * 500 + 5_000) // 10_000)


# ══════════════════════════════════════════════════════════════════════════════
# 8. Apportioning one agency figure across the hosts that produced it.
# ══════════════════════════════════════════════════════════════════════════════

check("shares sum to the total", sum(C.apportion(100, [1, 1, 1])), 100)
check("largest remainder, not a lost paisa", sorted(C.apportion(100, [1, 1, 1])), [33, 33, 34])
check("one host takes it all", C.apportion(12_345, [7]), [12_345])
check("no hosts", C.apportion(500, []), [])
check("all-zero weights pay nobody", C.apportion(500, [0, 0]), [0, 0])
check("a zero-weight host gets nothing", C.apportion(100, [0, 1]), [0, 100])
check("proportional split", C.apportion(1_000, [750, 250]), [750, 250])
for total, weights in ((999_983, [17, 3, 5, 91, 1]), (7, [1, 1, 1, 1, 1, 1, 1, 1])):
    check(f"shares of {total} sum exactly", sum(C.apportion(total, weights)), total)


# ══════════════════════════════════════════════════════════════════════════════
# 9. Periods.
# ══════════════════════════════════════════════════════════════════════════════

start, end, label = C.resolve_period("2026-W33")
check("ISO week label kept", label, "2026-W33")
check("ISO week starts Monday", (start.year, start.month, start.day), (2026, 8, 10))
check("ISO week is seven days", (end - start).days, 7)
check("half-open window", end > start, True)

start, end, _ = C.resolve_period("2026-08")
check("month starts on the 1st", (start.year, start.month, start.day), (2026, 8, 1))
check("month ends at the next 1st", (end.year, end.month, end.day), (2026, 9, 1))

start, end, _ = C.resolve_period("2026-12")
check("December rolls the year", (end.year, end.month), (2027, 1))

custom_since = datetime(2026, 8, 1, tzinfo=timezone.utc)
custom_until = datetime(2026, 8, 8, tzinfo=timezone.utc)
start, end, label = C.resolve_period("custom", custom_since, custom_until)
check("an explicit window is honoured", (start, end), (custom_since, custom_until))
check("its label is kept", label, "custom")

refuses("a blank period", lambda: C.resolve_period(""))
refuses("an undateable label with no window", lambda: C.resolve_period("last-week"))
refuses("a half-stated window", lambda: C.resolve_period("custom", custom_since, None))
refuses("week 60", lambda: C.resolve_period("2026-W60"))
refuses("month 13", lambda: C.resolve_period("2026-13"))
refuses(
    "a reversed window",
    lambda: C.resolve_period("custom", custom_until, custom_since),
)
refuses(
    "a window longer than the cap",
    lambda: C.resolve_period(
        "custom",
        datetime(2020, 1, 1, tzinfo=timezone.utc),
        datetime(2026, 1, 1, tzinfo=timezone.utc),
    ),
)


# ══════════════════════════════════════════════════════════════════════════════
# 10. Which table serves which partner.
# ══════════════════════════════════════════════════════════════════════════════

check("an agency takes the main table", C.kind_of({"kind": "agency"}), C.AgencyKind.MAIN)
check("a sub-agency takes its own", C.kind_of({"kind": "sub_agency"}), C.AgencyKind.SUB)
check("an unstated kind defaults to main", C.kind_of({}), C.AgencyKind.MAIN)
check("main config key", C.CONFIG_KEY[C.AgencyKind.MAIN], "mainAgencySlabs")
check("sub config key", C.CONFIG_KEY[C.AgencyKind.SUB], "subAgencySlabs")


# ══════════════════════════════════════════════════════════════════════════════
# 11. The whole derivation, with the ledger and the config stubbed.
# ══════════════════════════════════════════════════════════════════════════════
#
# The band is chosen by the **agency's** total, never per host. Two hosts each
# below the floor still earn the agency commission when their total clears it —
# this is the property that makes the flat-band rule agency-level.

SINCE = datetime(2026, 8, 10, tzinfo=timezone.utc)
UNTIL = datetime(2026, 8, 17, tzinfo=timezone.utc)


def stub_engine(hosts: list[tuple[str, int]], kind: C.AgencyKind = C.AgencyKind.MAIN):
    """Replace the two I/O calls with fixed answers. The arithmetic is real."""
    bean_rate = 0.01  # ₹0.01 per bean, the live rate

    async def load(k):
        return C.SlabTable(
            kind=k,
            bands=C.parse_slabs(MAIN_RAW if k is C.AgencyKind.MAIN else SUB_RAW),
            source="firestore",
            provisional=False,
            note="test",
        )

    async def billing(agency_id, since, until, bean_to_inr=None):
        total_beans = sum(b for _, b in hosts)
        return {
            "agency_id": agency_id,
            "since": since,
            "until": until,
            "bounds": "[since, until)",
            "definition": C.BILLING_DEFINITION,
            "basis": "host_cashouts",
            "beans_cashed_out": total_beans,
            "billing_minor": C._beans_to_minor(total_beans, bean_rate),
            "billing_inr": C._beans_to_minor(total_beans, bean_rate) / 100,
            "bean_to_inr": bean_rate,
            "bean_rate_note": "test",
            "bean_rate_provisional": False,
            "hosts": [
                {
                    "host_id": h,
                    "beans_cashed_out": b,
                    "billing_minor": C._beans_to_minor(b, bean_rate),
                    "movements": 1,
                    "last_at": until,
                }
                for h, b in hosts
            ],
            "host_count": len(hosts),
            "beans_earned_not_cashed_out": 0,
            "warnings": [],
        }

    return load, billing


def run_compute(hosts, kind=C.AgencyKind.MAIN, partner=None):
    load, billing = stub_engine(hosts, kind)
    original = (C.load_slab_table, C.agency_billing)
    C.load_slab_table, C.agency_billing = load, billing
    try:
        return asyncio.run(
            C.compute_for_period(
                "acme",
                "custom",
                SINCE,
                UNTIL,
                partner or {"name": "Acme", "kind": "agency"},
            )
        )
    finally:
        C.load_slab_table, C.agency_billing = original


# ₹1,00,000 of billing = 1,00,00,000 beans at ₹0.01.
result = run_compute([("host-a", 6_000_000), ("host-b", 4_000_000)])
check("billing derived from beans", result["billing"]["billing_minor"], rupees(100_000))
AT_LAKH = by_hand(100_000)
check("commission is the agency figure", result["commission_minor"], AT_LAKH)
check("top band reached", result["breakdown"]["band"]["rate_percent"], "7.5")
check("shares sum to the agency figure",
      sum(h["share_minor"] for h in result["hosts"]), AT_LAKH)
# 60/40 of the agency figure, apportioned by beans cashed out. Asserted as a
# proportion within one paisa rather than as an exact figure: the split is
# largest-remainder, so which host gets the odd paisa is a property of the
# remainders and not something to hardcode.
a, b_ = result["hosts"][0]["share_minor"], result["hosts"][1]["share_minor"]
check("host A's share is 60%", abs(a - AT_LAKH * 6 // 10) <= 1, True)
check("host B's share is 40%", abs(b_ - AT_LAKH * 4 // 10) <= 1, True)
check("and the two are exactly the agency figure", a + b_, AT_LAKH)
check("nothing provisional", result["provisional"], False)

# Two hosts, each ₹15,000 — under the floor alone, ₹30,000 together.
together = run_compute([("host-a", 1_500_000), ("host-b", 1_500_000)])
check("the agency total picks the band", together["billing"]["billing_minor"], rupees(30_000))
AT_30K = by_hand(30_000)
check("above the floor together", together["commission_minor"], AT_30K)
check("and it is only charged on the excess above the floor",
      AT_30K, ((rupees(30_000) - (rupees(25_001) - 1)) * 500 + 5_000) // 10_000)
halves = [h["share_minor"] for h in together["hosts"]]
check("split evenly to the paisa", abs(halves[0] - halves[1]) <= 1, True)
check("and the halves are exactly the total", sum(halves), AT_30K)

alone, _ = C.commission_for(rupees(15_000), MAIN)
check("either host alone would earn nothing", alone, 0)

# A sub-agency runs through the same engine, on its own table.
sub = run_compute(
    [("host-c", 10_000_000)],
    C.AgencyKind.SUB,
    {"name": "Acme Sub", "kind": "sub_agency"},
)
check("sub-agency uses the sub table", sub["agency_kind"], "sub")
check("sub-agency floor is its own", sub["breakdown"]["floor_minor"], 26_001 * 100)
check("sub-agency rate at ₹1,00,000", sub["breakdown"]["rate_percent"], "6")
# Progressive on the sub table too: 5% on the slice to ₹75,000 and 6% only on
# the part above it, not 6% of the whole ₹1,00,000.
sub_by_hand = 0
for band in SUB:
    if rupees(100_000) < band.from_minor:
        break
    edge = band.from_minor - 1
    top_ = rupees(100_000) if band.to_minor is None else min(rupees(100_000), band.to_minor)
    sub_by_hand += (top_ - edge) * band.rate_bp
sub_by_hand = (sub_by_hand + 5_000) // 10_000
check("sub-agency commission", sub["commission_minor"], sub_by_hand)
check("and it is below the flat 6% figure", sub["commission_minor"] < rupees(6_000), True)

# The same billing pays a main agency more than a sub-agency — different table,
# same engine.
main_same = run_compute([("host-c", 10_000_000)])
check("main earns more than sub on identical billing",
      main_same["commission_minor"] > sub["commission_minor"], True)

# A period that bills nothing is a real zero, explained, not an error.
nothing = run_compute([])
check("no hosts cashed out", nothing["commission_minor"], 0)
check("and it says why", nothing["breakdown"]["matched"], False)
check("no host lines", nothing["hosts"], [])


# ── Report ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} commission checks passed.")
print()
print("Worked examples — live main-agency slabs:")
print(f"{'billing':>18}  {'expected':>18}  {'actual':>18}  band")
for amount, expected in (
    (10_000, 0),
    (25_000, 0),
    (25_001, rupees("1250.05")),
    (100_000, rupees(7_500)),
    (10_000_000, rupees(2_500_000)),
):
    got, why = C.commission_for(rupees(amount), MAIN)
    band = why["band"]["label"] if why["band"] else "below the ₹25,001 floor"
    print(
        f"{C.rupee_text(rupees(amount)):>18}  "
        f"{C.rupee_text(expected):>18}  "
        f"{C.rupee_text(got):>18}  {band}"
    )
