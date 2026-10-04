"""The owner's weekly business report.

Eight sections, one rule between them: **a figure that could not be produced is
never a zero**. These tests exist mostly to hold that rule down, because it is
the one that is easy to break by accident — a `try/except` that returns `0`
instead of raising looks like defensive programming and is actually a lie on a
finance report.

What is covered, and why each one:

  * a host above the threshold and a host below it — the below case must carry
    the figure and the shortfall, not a bare "no" (0.3.5)
  * an agency above the slab floor and one below it — the below case is a real
    zero and must say *why*, and the floor must be the live one
  * a week with no activity — `empty`, in words, never a page of zeroes
  * a section whose source is down — a warning and unknown columns, never zeroes
  * the P&L arithmetic, including an expense category with no entry for the
    period, which must make the profit an upper bound rather than silently
    inflating it (`tests/test_expenses.py` covers the recording path itself)
  * regenerating a week — the stored report is re-used, not recomputed, and
    nothing is stored or sent twice

The three chance-mechanic sections the week now carries — gross gaming revenue,
the game margin model and the cannibalisation guard (8B.7, 8B.8, 8B.9 / 8B.9A)
— are stubbed here like every other section, because what this file tests is
the weekly runner. The reports themselves are exercised against known figures
in `tests/test_chance_revenue.py`.

The real service code runs. Only the I/O underneath it is replaced, following
`tests/fakes.py`, so what is exercised is the rule and not a copy of it.

Run:  python3 -m tests.test_weekly_business
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

from app.services import commission as COM  # noqa: E402
from app.services import email as mail_module  # noqa: E402
from app.services import reports as R  # noqa: E402
from app.services import scheduling as S  # noqa: E402

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
    text = " ".join(haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() not in text.lower():
        failures.append(f"{label}\n    {needle!r} is not in: {text[:400]!r}")


def absent(label: str, haystack, needle: str) -> None:
    global checks
    checks += 1
    text = " ".join(haystack) if isinstance(haystack, (list, tuple)) else str(haystack)
    if needle.lower() in text.lower():
        failures.append(f"{label}\n    {needle!r} should NOT be in: {text[:400]!r}")


SINCE = datetime(2026, 8, 10, tzinfo=timezone.utc)
UNTIL = datetime(2026, 8, 17, tzinfo=timezone.utc)
WEEK = "2026-W33"

#: The live rates, from `backups/firestore-2026-08-20-1548/appConfig.json`.
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

#: The live threshold: appConfig/economy.weeklyMinPayoutInr = 2000.
LIVE_THRESHOLDS = R.thresholds_from_config({"weeklyMinPayoutInr": 2000})


def rupees(amount) -> int:
    return int(round(float(amount) * 100))


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


def yields(value):
    async def _return(*_a, **_k):
        return value
    return value if False else _return


# ══════════════════════════════════════════════════════════════════════════════
#  1. THRESHOLDS — read from config, never hardcoded
# ══════════════════════════════════════════════════════════════════════════════

check("live threshold is ₹2,000 in paise", LIVE_THRESHOLDS.min_payout_minor, 200_000)
check("live threshold is not provisional", LIVE_THRESHOLDS.provisional, False)
check("no bean threshold is configured", LIVE_THRESHOLDS.min_beans, None)
contains(
    "the missing bean rule is called out, with the key to set",
    LIVE_THRESHOLDS.warnings,
    "weeklyMinPayoutBeans",
)
contains(
    "and it names the owner's own words",
    LIVE_THRESHOLDS.warnings,
    "one lakh beans in a week",
)

# A config that cannot supply the threshold falls back and says so — it does not
# quietly use zero, which would make every host eligible.
missing = R.thresholds_from_config({})
check("fallback threshold is ₹2,000", missing.min_payout_minor, 200_000)
check("fallback is flagged provisional", missing.provisional, True)
contains("fallback says PROVISIONAL", missing.note, "PROVISIONAL")

# The bean rule is picked up the moment somebody configures it — no code change.
with_beans = R.thresholds_from_config(
    {"weeklyMinPayoutInr": 2000, "weeklyMinPayoutBeans": 100_000}
)
check("bean threshold read", with_beans.min_beans, 100_000)
check("and the key it came from is named", with_beans.min_beans_key, "weeklyMinPayoutBeans")


# ══════════════════════════════════════════════════════════════════════════════
#  2. HOST ELIGIBILITY — above, below, and the reason
# ══════════════════════════════════════════════════════════════════════════════

# 250,000 beans at ₹0.01 = ₹2,500 — above the ₹2,000 line.
ok, why = R._host_eligibility(250_000, rupees(2_500), LIVE_THRESHOLDS)
check("a host at ₹2,500 is eligible", ok, True)
contains("and is told the figure", why, "₹2,500.00")

# 120,000 beans = ₹1,200 — below the line by ₹800.
ok, why = R._host_eligibility(120_000, rupees(1_200), LIVE_THRESHOLDS)
check("a host at ₹1,200 is not eligible", ok, False)
contains("the shortfall is stated", why, "₹800.00 short")
contains("against the threshold that was applied", why, "₹2,000.00 weekly minimum")
absent("and it is never a bare no", why, "not eligible.")

# Exactly on the line is eligible — the threshold is a floor, not a barrier.
ok, _ = R._host_eligibility(200_000, rupees(2_000), LIVE_THRESHOLDS)
check("exactly ₹2,000 is eligible", ok, True)

# With the bean rule configured, BOTH must be met, and both shortfalls show.
ok, why = R._host_eligibility(90_000, rupees(2_500), with_beans)
check("₹2,500 but only 90k beans fails the bean rule", ok, False)
contains("the bean shortfall is stated too", why, "10,000 short")


# ══════════════════════════════════════════════════════════════════════════════
#  3. THE HOST TABLE — one above, one below, in one report
# ══════════════════════════════════════════════════════════════════════════════

HOST_ACTIVITY = [
    # ₹2,500 — eligible.
    {
        "_id": "host-rich",
        "beans_earned": 250_000,
        "beans_cashed_out": 0,
        "movements": 4,
        "agency_ids": ["acme"],
        "last_at": UNTIL,
        "closing": 250_000,
    },
    # ₹1,200 — below the line.
    {
        "_id": "host-poor",
        "beans_earned": 120_000,
        "beans_cashed_out": 0,
        "movements": 1,
        "agency_ids": ["acme-sub"],
        "last_at": UNTIL,
        "closing": 120_000,
    },
]

PARTNERS = {
    "acme": {"_id": "acme", "name": "Acme Talent", "kind": "agency", "status": "approved"},
    "acme-sub": {
        "_id": "acme-sub",
        "name": "Acme South",
        "kind": "sub_agency",
        "parent_id": "acme",
        "status": "approved",
    },
}

GIFTS = [
    {
        "sender_uid": "whale-1",
        "receiver_uid": "host-rich",
        "gift_type": "lucky",
        "gift_name": "Lucky Rose",
        "quantity": 3,
        "diamonds": 9_000,
        "beans_earned": 1_350,
        "lucky": True,
    },
    {
        "sender_uid": "whale-2",
        "receiver_uid": "host-rich",
        "gift_type": "normal",
        "gift_name": "Rose",
        "quantity": 10,
        "diamonds": 1_000,
        "beans_earned": 400,
        "lucky": False,
    },
    {
        "sender_uid": "whale-1",
        "receiver_uid": "host-poor",
        "gift_type": "normal",
        "gift_name": "Rose",
        "quantity": 2,
        "diamonds": 200,
        "beans_earned": 80,
        "lucky": False,
    },
]

CALLS = [
    {"receiver_uid": "host-rich", "caller_uid": "u1", "seconds": 600, "beans": 0, "diamonds": 0},
    {"receiver_uid": "host-rich", "caller_uid": "u2", "seconds": 300, "beans": 0, "diamonds": 0},
]


async def _hosts(activity=HOST_ACTIVITY, gifts=GIFTS, calls=CALLS, thresholds=LIVE_THRESHOLDS):
    async def act(*_a, **_k):
        return list(activity)

    async def parts(*_a, **_k):
        return dict(PARTNERS)

    async def names(*_a, **_k):
        return {"host-rich": "Rich Host", "host-poor": "Poor Host"}, []

    with patched(
        R,
        _host_bean_activity=act,
        _partner_index=parts,
        _gift_events=gifts if callable(gifts) else (lambda *a, **k: _async(list(gifts))),
        _call_events=calls if callable(calls) else (lambda *a, **k: _async(list(calls))),
        _user_names=names,
    ):
        return await R.host_week(SINCE, UNTIL, RATES, thresholds)


def _async(value):
    async def _inner():
        return value
    return _inner()


hosts = asyncio.run(_hosts())
rows = {r["host_id"]: r for r in hosts.rows}

check("both hosts are listed", sorted(rows), ["host-poor", "host-rich"])
check("the report is not empty", hosts.as_dict()["empty"], False)

rich = rows["host-rich"]
check("payout is beans at the bean rate", rich["payout_due_inr_minor"], rupees(2_500))
check("the eligible host is marked eligible", rich["eligible"], True)
check("and sits under a main agency", rich["agency_type"], "main agency")
check("named", rich["agency_name"], "Acme Talent")
check("gifts received are counted", rich["gifts_received"], 13)
check("gift value in diamonds", rich["gift_diamonds_received"], 10_000)
check("call minutes are sourced", rich["call_minutes"], 15.0)
check("calls are counted", rich["calls_received"], 2)

poor = rows["host-poor"]
check("the host below the line is still listed", poor["host_id"], "host-poor")
check("and is marked not eligible", poor["eligible"], False)
check("with the payout figure kept", poor["payout_due_inr_minor"], rupees(1_200))
contains("and the shortfall spelled out", poor["eligibility"], "₹800.00 short")
check("a sub-agency host says sub-agency", poor["agency_type"], "sub-agency")
check("and names the parent", poor["parent_agency_name"], "Acme Talent")

# 4.2.4 — a sub-agency is never paid directly. Naming the parent is not the
# same as saying the money goes through it, and the owner asked which.
contains("the sub-agency host's row says the money goes VIA the main agency",
         poor["paid_via"], "VIA the main agency Acme Talent")
contains("and describes both legs", poor["paid_via"], "an owner confirms the second leg")
contains("a main-agency host's row says it is paid directly",
         rich["paid_via"], "paid to it directly")
contains("the table itself explains the two-leg route",
         hosts.warnings, "we pay the MAIN agency")
check("and counts who is affected", hosts.totals["hosts_under_a_sub_agency"], 1)
check("the path is on the exported columns, not only in prose",
      "paid_via" in [k for k, _h in hosts.columns], True)

# The row count is 'hosts who moved a bean' and the report never lets that be
# read as 'every host'.
contains("the report states what it does NOT cover", hosts.warnings,
         "A host who earned nothing and cashed out nothing does NOT appear")
check("and refuses to invent a platform head-count",
      hosts.totals["hosts_on_platform"], None)

# A sub-agency with no parent has nobody to route commission to. That is a
# blocker before payday, not a footnote.
ORPHANED = {
    "acme": dict(PARTNERS["acme"]),
    "acme-sub": {"_id": "acme-sub", "name": "Acme South", "kind": "sub_agency",
                 "status": "approved"},
}


async def _hosts_orphan_sub():
    async def act(*_a, **_k):
        return list(HOST_ACTIVITY)

    async def parts(*_a, **_k):
        return dict(ORPHANED)

    async def names(*_a, **_k):
        return {}, []

    with patched(R, _host_bean_activity=act, _partner_index=parts,
                 _gift_events=lambda *a, **k: _async(list(GIFTS)),
                 _call_events=lambda *a, **k: _async(list(CALLS)),
                 _user_names=names):
        return await R.host_week(SINCE, UNTIL, RATES, LIVE_THRESHOLDS)


orphan = asyncio.run(_hosts_orphan_sub())
orphan_row = {r["host_id"]: r for r in orphan.rows}["host-poor"]
contains("a sub with no parent says the payee is NOT ON RECORD",
         orphan_row["paid_via"], "NOT ON RECORD")
contains("and it is escalated in capitals so it reaches an owner",
         orphan.warnings, "WHO GETS PAID IS UNCLEAR FOR 1 HOST(S)")
check("the host is still listed and still has a payout figure",
      orphan_row["payout_due_inr_minor"], rupees(1_200))

totals = hosts.totals
check("one host is eligible", totals["hosts_eligible"], 1)
check("one is below", totals["hosts_below_threshold"], 1)
check("payout for everybody", totals["payout_due_all_hosts_inr_minor"], rupees(3_700))
check("payout for the eligible only", totals["payout_due_eligible_only_inr_minor"], rupees(2_500))
check("gifts were sourced", totals["gifts_sourced"], True)
check("calls were sourced", totals["calls_sourced"], True)


# ══════════════════════════════════════════════════════════════════════════════
#  4. A SECTION WHOSE SOURCE IS DOWN — a warning, never a zero
# ══════════════════════════════════════════════════════════════════════════════

broken = asyncio.run(_hosts(gifts=gone("giftEvents"), calls=gone("platformRevenue")))
broken_rows = {r["host_id"]: r for r in broken.rows}

check("the report still produced its bean columns", len(broken.rows), 2)
check("beans are untouched by the outage", broken_rows["host-rich"]["beans_earned"], 250_000)
check("gifts are UNKNOWN, not zero", broken_rows["host-rich"]["gifts_received"], None)
check("gift value is UNKNOWN, not zero", broken_rows["host-rich"]["gift_diamonds_received"], None)
check("call minutes are UNKNOWN, not zero", broken_rows["host-rich"]["call_minutes"], None)
check("and the totals say gifts were not sourced", broken.totals["gifts_sourced"], False)
check("nor calls", broken.totals["calls_sourced"], False)
contains("a loud warning names the gift failure", broken.warnings, "GIFTS RECEIVED COULD NOT BE READ")
contains("and says they are not zero", broken.warnings, "not zero")
contains("a loud warning names the call failure", broken.warnings, "CALL ACTIVITY COULD NOT BE READ")
# The whole report must not be lost because one Firestore collection is down.
check("the payout figure survives the outage", broken_rows["host-rich"]["payout_due_inr_minor"], rupees(2_500))
check("and eligibility still resolves", broken_rows["host-rich"]["eligible"], True)


# ══════════════════════════════════════════════════════════════════════════════
#  5. A WEEK WITH NO ACTIVITY — empty, in words, not a page of zeroes
# ══════════════════════════════════════════════════════════════════════════════

quiet = asyncio.run(_hosts(activity=[], gifts=[], calls=[]))
check("no rows", quiet.rows, [])
check("and the report declares itself empty", quiet.as_dict()["empty"], True)
contains("in words a person can read", quiet.warnings, "empty period")
contains(
    "and it distinguishes absence from a measured zero",
    quiet.warnings,
    "not a week in which every host earned nothing",
)
contains(
    "and it says what an unexpected empty week would mean",
    quiet.warnings,
    "data problem",
)


# ══════════════════════════════════════════════════════════════════════════════
#  6. AGENCIES — above the floor, and below it
# ══════════════════════════════════════════════════════════════════════════════
#
# The floor is the live one: ₹25,001 for a main agency, ₹26,001 for a sub. It is
# not restated here — it is read out of the engine, so a test that passed while
# the floor moved would be a test of nothing.

MAIN_FLOOR = COM.floor_minor(COM.parse_slabs(COM.FALLBACK_MAIN_SLABS))
SUB_FLOOR = COM.floor_minor(COM.parse_slabs(COM.FALLBACK_SUB_SLABS))
check("the main floor is ₹25,001", MAIN_FLOOR, rupees(25_001))
check("the sub floor is ₹26,001", SUB_FLOOR, rupees(26_001))


def _billing_stub(beans_by_agency: dict[str, int]):
    async def load(kind):
        return COM.SlabTable(
            kind=kind,
            bands=COM.parse_slabs(COM.FALLBACK_SLABS[kind]),
            source="firestore",
            provisional=False,
            note="test",
        )

    async def billing(agency_id, since, until, bean_to_inr=None):
        beans = beans_by_agency.get(agency_id, 0)
        minor = COM._beans_to_minor(beans, 0.01)
        return {
            "agency_id": agency_id,
            "since": since,
            "until": until,
            "bounds": "[since, until)",
            "definition": COM.BILLING_DEFINITION,
            "basis": "host_cashouts",
            "beans_cashed_out": beans,
            "billing_minor": minor,
            "billing_inr": minor / 100,
            "bean_to_inr": 0.01,
            "bean_rate_note": "test",
            "bean_rate_provisional": False,
            "hosts": (
                [{"host_id": f"{agency_id}-h", "beans_cashed_out": beans,
                  "billing_minor": minor, "movements": 1, "last_at": until}]
                if beans
                else []
            ),
            "host_count": 1 if beans else 0,
            "beans_earned_not_cashed_out": 0,
            "warnings": [],
        }

    return load, billing


async def _agencies(beans_by_agency: dict[str, int], partners=None, legs=()):
    load, billing = _billing_stub(beans_by_agency)

    async def parts(*_a, **_k):
        return dict(partners if partners is not None else PARTNERS)

    async def open_legs(*_a, **_k):
        return list(legs)

    with patched(COM, load_slab_table=load, agency_billing=billing):
        with patched(
            R,
            _partner_index=parts,
            _open_subagency_legs=legs if callable(legs) else open_legs,
        ):
            return await R.agency_week(WEEK, SINCE, UNTIL, RATES)


# Acme bills ₹1,00,000 (1 crore beans at ₹0.01) → band 2, 7.5%.
# Acme South bills ₹20,000 → below the ₹26,001 sub floor → nothing.
agencies = asyncio.run(
    _agencies({"acme": 10_000_000, "acme-sub": 2_000_000})
)
arows = {r["agency_id"]: r for r in agencies.rows}

def progressive(total_rupees: int, table=None) -> int:
    """The commission rule, computed independently of the report."""
    from app.services import commission as _C
    bands = table or _C.parse_slabs(_C.FALLBACK_MAIN_SLABS)
    total = rupees(total_rupees)
    raw = 0
    for band in bands:
        if total < band.from_minor:
            break
        edge = band.from_minor - 1
        top = total if band.to_minor is None else min(total, band.to_minor)
        raw += (top - edge) * band.rate_bp
    return (raw + 5_000) // 10_000


acme = arows["acme"]
check("main agency billing", acme["billing_inr_minor"], rupees(100_000))
check("the band rate is shown", acme["rate_percent"], "7.5")
check("the progressive commission", acme["commission_inr_minor"], progressive(100_000))
check("it earns", acme["earns_commission"], True)
check("and it is a main agency", acme["agency_type"], "main agency")
contains("the band is named so the number is explainable", acme["band"], "7.5%")
contains("and the derivation is on the row", acme["why"], "charged band by band")

sub = arows["acme-sub"]
check("sub-agency billing", sub["billing_inr_minor"], rupees(20_000))
check("below the floor it earns nothing", sub["commission_inr_minor"], 0)
check("and is marked as not earning", sub["earns_commission"], False)
check("the floor on the row is the SUB floor", sub["floor_inr_minor"], SUB_FLOOR)
contains("the row says it is below the floor", sub["band"], "below the")
contains("and why that means zero", sub["why"], "below the ₹26,001.00 floor")
contains("and that the hosts are still paid", sub["why"], "hosts are paid their own payout in full")
check("it is a sub-agency", sub["agency_type"], "sub-agency")
check("with its parent named", sub["parent_agency_name"], "Acme Talent")

check("main and sub are counted apart", 
      (agencies.totals["main_agencies"], agencies.totals["sub_agencies"]), (1, 1))
contains("the main agency's row says we pay it directly", acme["paid_via"], "we pay it directly")
contains("the sub's row says it is NEVER paid directly", sub["paid_via"], "never paid directly")
contains("and names the main agency that receives leg 1", sub["paid_via"], "we pay Acme Talent")
contains("and says an owner has to record leg 2", sub["paid_via"], "an owner records it")
check("the route is an exported column", "paid_via" in [k for k, _h in agencies.columns], True)
check("with no leg outstanding, the figure is a real zero", 
      agencies.totals["open_subagency_legs"], 0)
check("and the source is confirmed read", agencies.totals["subagency_legs_sourced"], True)

# Money that left us and stopped at the parent belongs on the sub's own row.
STUCK = [{"_id": "acme-sub", "open_legs": 2, "amount_minor": rupees(40_000),
          "parent_ids": ["acme"], "oldest_at": SINCE}]
stuck_agencies = asyncio.run(_agencies({"acme": 10_000_000, "acme-sub": 2_000_000}, legs=STUCK))
stuck_rows = {r["agency_id"]: r for r in stuck_agencies.rows}
check("the open legs land on the SUB, not the parent",
      stuck_rows["acme-sub"]["open_payment_legs"], 2)
check("with the amount still in the air", 
      stuck_rows["acme-sub"]["open_leg_inr_minor"], rupees(40_000))
check("and the main agency's own row is untouched", stuck_rows["acme"]["open_payment_legs"], 0)
contains("a capitalised warning puts it in front of an owner",
         stuck_agencies.warnings, "SUB-AGENCY PAYOUT(S) WORTH ₹40,000.00 ARE STILL OPEN")
contains("saying the sub may never have seen the money",
         stuck_agencies.warnings, "no record that the sub-agency received anything")

# A card nobody has signed is not money stuck at a parent. The pull selects
# `parent_paid` only — leg 1 executed, leg 2 outstanding — so an unsigned
# payout cannot raise a false alarm on a report whose alarms have to be true.
captured: list = []


class _NoDocs:
    async def _run(self, collection, pipeline):
        captured.append((collection, pipeline))
        return []


with patched(R, _aggregate=_NoDocs()._run):
    asyncio.run(R._open_subagency_legs())
check("the open-leg pull reads the two-leg payout collection",
      captured[0][0], "subagency_payouts")
check("and matches ONLY leg-1-paid, leg-2-outstanding",
      captured[0][1][0], {"$match": {"status": "parent_paid"}})

# The legs collection being down is UNKNOWN — not 'all confirmed'.
blind_legs = asyncio.run(
    _agencies({"acme": 10_000_000, "acme-sub": 2_000_000}, legs=gone("subagency_payouts"))
)
check("the leg columns are unknown", 
      {r["agency_id"]: r for r in blind_legs.rows}["acme-sub"]["open_payment_legs"], None)
check("and no total is invented", blind_legs.totals["open_subagency_legs"], None)
check("the totals say the source was not read", blind_legs.totals["subagency_legs_sourced"], False)
contains("loudly", blind_legs.warnings, "OPEN SUB-AGENCY PAYMENT LEGS COULD NOT BE READ")
contains("and explicitly not 'all confirmed'", blind_legs.warnings, "not 'all confirmed'")
check("every other figure survived",
      blind_legs.totals["commission_inr_minor"], progressive(100_000))

# A sub-agency with no parent cannot be paid at all.
ORPHAN_AGENCIES = {
    "acme": dict(PARTNERS["acme"]),
    "acme-sub": {"_id": "acme-sub", "name": "Acme South", "kind": "sub_agency",
                 "status": "approved"},
}
orphan_ag = asyncio.run(
    _agencies({"acme": 10_000_000, "acme-sub": 4_000_000}, partners=ORPHAN_AGENCIES)
)
orphan_ag_row = {r["agency_id"]: r for r in orphan_ag.rows}["acme-sub"]
contains("the row says there is no main agency to route through",
         orphan_ag_row["paid_via"], "SUB-AGENCY WITH NO PARENT ON RECORD")
check("it is counted", orphan_ag.totals["sub_agencies_without_a_parent"], 1)
contains("and named", orphan_ag.warnings, "Acme South")
contains("with what to do about it", orphan_ag.warnings, "need a `parent_id` before the week is paid")
check("but its commission is still computed and shown, not withheld",
      orphan_ag_row["commission_inr_minor"] > 0, True)

check("one agency earns", agencies.totals["agencies_earning_commission"], 1)
check("one is below the floor", agencies.totals["agencies_below_floor"], 1)
check("none failed", agencies.totals["agencies_not_computed"], 0)
check("total commission", agencies.totals["commission_inr_minor"], progressive(100_000))

# A week where every agency billed nothing is EMPTY, not a table of zeroes.
nothing = asyncio.run(_agencies({}))
check("all-zero billing", nothing.totals["billing_inr_minor"], 0)
check("and the report declares itself empty", nothing.as_dict()["empty"], True)
contains("saying the zeroes are the absence of cash-outs", nothing.warnings, "absence of cash-outs")

# One agency the engine cannot compute must not become a zero, and must not
# cost the other agency its row.
BROKEN_PARTNERS = dict(PARTNERS)
BROKEN_PARTNERS["mystery"] = {"_id": "mystery", "name": "Mystery", "kind": "agency"}


async def _agencies_with_one_broken():
    load, _billing = _billing_stub({"acme": 10_000_000})

    async def billing(agency_id, since, until, bean_to_inr=None):
        if agency_id == "mystery":
            raise COM.MalformedSlabTable("the slab table for this agency is broken.")
        return await _billing(agency_id, since, until, bean_to_inr)

    async def parts(*_a, **_k):
        return dict(BROKEN_PARTNERS)

    async def open_legs(*_a, **_k):
        return []

    with patched(COM, load_slab_table=load, agency_billing=billing):
        with patched(R, _partner_index=parts, _open_subagency_legs=open_legs):
            return await R.agency_week(WEEK, SINCE, UNTIL, RATES)


partial = asyncio.run(_agencies_with_one_broken())
prows = {r["agency_id"]: r for r in partial.rows}
check("the broken agency's commission is UNKNOWN", prows["mystery"]["commission_inr_minor"], None)
check("not zero", prows["mystery"]["earns_commission"], None)
contains("and the row says it was not computed", prows["mystery"]["why"], "NOT COMPUTED")
check("it is counted as not computed", partial.totals["agencies_not_computed"], 1)
check("the healthy agency still got its figure", prows["acme"]["commission_inr_minor"], progressive(100_000))
contains("and a warning names the failure", partial.warnings, "could not be computed")


# ══════════════════════════════════════════════════════════════════════════════
#  7. THE P&L — the owner's definition, and what is missing from it
# ══════════════════════════════════════════════════════════════════════════════
#
#     "profit is like the money we received for selling coin - our all
#      expenditure"

line = R.ExpenditureLine

statement = R.profit_statement(
    rupees(1_000_000),
    [
        line("host_payouts", "Host payouts", rupees(400_000), "d", "ledger"),
        line("agency_commission_paid", "Commission paid", rupees(100_000), "d", "ledger"),
        line("seller_credit_written_off", "Written off", rupees(25_000), "d", "ledger"),
    ],
)
check("expenditure is the sum of the lines", statement["expenditure_inr_minor"], rupees(525_000))
check("profit is revenue minus expenditure", statement["profit_inr_minor"], rupees(475_000))
check("margin", statement["margin_pct"], 47.5)
check("with every line known, the statement is complete", statement["complete"], True)
check("and nothing is listed as missing", statement["unknown_lines"], [])

# A cost nobody records must NOT be treated as zero. It must make the profit an
# upper bound, and the statement must say which line is missing.
with_unknown = R.profit_statement(
    rupees(1_000_000),
    [
        line("host_payouts", "Host payouts", rupees(400_000), "d", "ledger"),
        line("taxes", "Taxes", None, "not recorded", "none"),
    ],
)
check("an unknown line is not added as zero", with_unknown["expenditure_inr_minor"], rupees(400_000))
check("the profit is the upper bound", with_unknown["profit_inr_minor"], rupees(600_000))
check("and the statement knows it is incomplete", with_unknown["complete"], False)
check("and names the line", with_unknown["unknown_lines"], ["taxes"])

# Zero revenue → the margin is undefined, never 0%.
zero_rev = R.profit_statement(0, [line("host_payouts", "H", rupees(100), "d", "ledger")])
check("margin on zero revenue is null", zero_rev["margin_pct"], None)
check("and the loss is still stated", zero_rev["profit_inr_minor"], -rupees(100))


async def _pnl(
    revenue_minor: int,
    payout_rows,
    credit_events=None,
    cash_warnings=(),
    expenses=None,
):
    async def cash(*_a, **_k):
        return R.Report(
            name="cash_position",
            title="Cash",
            period=R._period(SINCE, UNTIL),
            columns=[("line", "Line")],
            rows=[{"line": "x"}],
            totals={
                "receipts_inr_minor": revenue_minor,
                "payments_out_inr_minor": 0,
            },
            warnings=list(cash_warnings),
        )

    async def payouts(*_a, **_k):
        return list(payout_rows), sum(r["inr_minor"] for r in payout_rows), []

    async def credit(*_a, **_k):
        if credit_events is None:
            raise R.DataUnavailable("partners could not be read.")
        return list(credit_events)

    async def spend(*_a, **_k):
        # `None` here is a store that could not answer. `{}` — the default — is
        # the store answering honestly that no operating cost was recorded for
        # this period, which is the case that must still read as UNKNOWN.
        if expenses is None:
            return {}, []
        return {k: dict(v) for k, v in expenses.items()}, []

    with patched(
        R,
        cash_position=cash,
        _executed_payouts=payouts,
        _credit_events=credit,
        _expenditure_by_category=spend,
    ):
        return await R.profit_and_loss(SINCE, UNTIL, RATES)


PAYOUTS = [
    {"card_type": "host_withdrawal", "inr_minor": rupees(300_000), "cards": 12,
     "currency": "beans", "amount_native": 0, "rate_applied": "x"},
    {"card_type": "weekly_payout", "inr_minor": rupees(100_000), "cards": 3,
     "currency": "beans", "amount_native": 0, "rate_applied": "x"},
    {"card_type": "commission_payout", "inr_minor": rupees(90_000), "cards": 2,
     "currency": "commission", "amount_native": 0, "rate_applied": "x"},
    {"card_type": "subagency_payout", "inr_minor": rupees(10_000), "cards": 1,
     "currency": "commission", "amount_native": 0, "rate_applied": "x"},
]

# 1,000 coins written off, at ₹2,390 per lakh = ₹23.90 = 2,390 paise.
pnl = asyncio.run(
    _pnl(rupees(1_000_000), PAYOUTS, [{"_id": "written_off", "coins": 1_000, "events": 1}])
)
pt = pnl.totals
pnl_rows = {r["line"]: r for r in pnl.rows}
check("revenue is the cash receipts figure", pt["revenue_inr_minor"], rupees(1_000_000))
check("host payouts are bucketed by card type", pt["host_payouts_inr_minor"], rupees(400_000))
check("commission paid is bucketed separately", pt["agency_commission_paid_inr_minor"], rupees(100_000))
check("the write-off is valued at the coin rate", pt["seller_credit_written_off_inr_minor"], 2_390)
check(
    "profit = revenue − everything recorded going out",
    pt["profit_inr_minor"],
    rupees(1_000_000) - rupees(400_000) - rupees(100_000) - 2_390,
)
check(
    "EVERY cost this system cannot record is named, not just the easy three",
    sorted(pt["unknown_lines"]),
    [
        "binance_fees",
        "gateway_fees",
        "infrastructure",
        "marketing",
        "refunds_to_users",
        "staff_salaries",
        "taxes",
    ],
)
check("total paid out is one figure, not two the reader must add", 
      pt["total_paid_out_inr_minor"], rupees(500_000))
check("and the statement says the definition is the owner's own",
      pt["profit_definition_is_the_owners"], True)
contains(
    "the owner's words are quoted on the definition, not paraphrased away",
    R.DEFINITIONS["profit"],
    "profit is like the money we received for selling coin - our all expenditure",
)
contains(
    "and the profit LINE says whose definition it is",
    [r["line"] for r in pnl.rows],
    "owner's own definition",
)
contains(
    "a category with nothing entered for the period is named, and the report says so",
    pnl.warnings,
    "OPERATING COST CATEGORIES HAVE NO ENTRY FOR THIS PERIOD",
)
contains(
    "and says that one entry does not make the figure complete",
    pnl.warnings,
    "One recorded expense does not make the number complete",
)
contains(
    "and names it as an owner's decision rather than a number to fudge",
    pnl.warnings,
    "This is a decision for an owner",
)
contains(
    "salaries are named as unrecorded, not omitted",
    pnl_rows["Staff salaries and contractor pay"]["definition"],
    "NOT RECORDED FOR THIS PERIOD",
)
check("and carry no figure at all", pnl_rows["Staff salaries and contractor pay"]["inr_minor"], None)
contains(
    "the host `salary_request` card is distinguished from staff pay",
    pnl_rows["Staff salaries and contractor pay"]["definition"],
    "pays HOSTS",
)
check("servers are named", "Servers, Firebase, hosting and tooling" in pnl_rows, True)
check("marketing is named", "Marketing, campaigns and promoter spend" in pnl_rows, True)
contains(
    "and refunds are named as a path that exists but is never used",
    pnl_rows["Refunds to users"]["definition"],
    "no service in this codebase creates a refund card",
)
check("so the statement is not complete", pt["complete"], False)
contains("and the email will say it is an upper bound", pnl.warnings, "UPPER BOUND")

check("the tax line is unknown, not zero", pnl_rows["Taxes"]["inr_minor"], None)
contains(
    "and says so on its face",
    pnl_rows["Taxes"]["definition"],
    "NOT RECORDED FOR THIS PERIOD",
)
contains(
    "gateway fees likewise",
    pnl_rows["Payment gateway fees"]["definition"],
    "NOT RECORDED FOR THIS PERIOD",
)
truthy("every line carries its definition", all(r["definition"] for r in pnl.rows))
truthy("every line names its store", all(r["store"] for r in pnl.rows))

# A week where nothing at all moved is EMPTY, not a P&L of zeroes.
still = asyncio.run(_pnl(0, [], []))
check("nothing in, nothing out", still.totals["profit_inr_minor"], 0)
check("declares itself empty", still.as_dict()["empty"], True)
contains("saying nothing happened", still.warnings, "nothing happened")

# The write-off source being down must not silently zero that cost.
blind = asyncio.run(_pnl(rupees(1_000_000), PAYOUTS, None))
check("the unreadable cost is unknown", blind.totals["seller_credit_written_off_inr_minor"], None)
check("and is listed among the missing", "seller_credit_written_off" in blind.totals["unknown_lines"], True)
contains("with a warning", blind.warnings, "could not be read")


# ══════════════════════════════════════════════════════════════════════════════
#  8. MONEY IN — recharges, their channel, and seller credit
# ══════════════════════════════════════════════════════════════════════════════

RECHARGES = [
    {"buyer_uid": "u-whale", "buyer_name": "Whale", "seller_uid": "s1", "seller_name": "S1",
     "recipient_type": "user", "amount_inr_minor": rupees(5_000), "diamonds": 200_000},
    {"buyer_uid": "u-whale", "buyer_name": "Whale", "seller_uid": "s1", "seller_name": "S1",
     "recipient_type": "user", "amount_inr_minor": rupees(3_000), "diamonds": 120_000},
    {"buyer_uid": "u-small", "buyer_name": "Small", "seller_uid": "s2", "seller_name": "S2",
     "recipient_type": "user", "amount_inr_minor": rupees(500), "diamonds": 20_000},
    {"buyer_uid": "acme", "buyer_name": "Acme", "seller_uid": "s1", "seller_name": "S1",
     "recipient_type": "agency", "amount_inr_minor": rupees(9_000), "diamonds": 360_000},
]

CREDIT = [
    {"_id": "issued", "coins": 500_000, "events": 3, "sellers": ["s1", "s2"]},
    {"_id": "repaid", "coins": 300_000, "events": 2, "sellers": ["s1"]},
    {"_id": "written_off", "coins": 10_000, "events": 1, "sellers": ["s3"]},
]

STANDING = {
    "outstanding": 190_000,
    "sellers": 3,
    "with_debt": 2,
    "overdue_coins": 40_000,
    "overdue_sellers": 1,
}


# ── DUE DATES ARE RELATIVE TO NOW, NOT WRITTEN OUT ───────────────────────────
#
# `s2` carried the literal date 2026-09-30, and the assertion below is that a
# seller INSIDE their due date is not reported as overdue. That held until the
# 30th of September 2026, when the date arrived and the suite began failing on
# a calendar day rather than on a change to the code — which is the worst kind
# of red, because the thing it points at is not the thing that is wrong.
#
# Offsets say what the test actually means: one seller past their date, one
# comfortably before it. Neither can expire.
_NOW = datetime.now(timezone.utc)

PER_SELLER = [
    {"_id": "s1", "name": "Rocket Coins", "status": "approved", "outstanding": 150_000,
     "due_at": _NOW - timedelta(days=50), "events": 4,
     "issued": 400_000, "repaid": 300_000, "recovered": 0, "written_off": 0},
    {"_id": "s2", "name": "Nova Coins", "status": "approved", "outstanding": 40_000,
     "due_at": _NOW + timedelta(days=30), "events": 1,
     "issued": 100_000, "repaid": 0, "recovered": 0, "written_off": 0},
    {"_id": "s3", "name": "Gone Coins", "status": "approved", "outstanding": 0,
     "due_at": None, "events": 1,
     "issued": 0, "repaid": 0, "recovered": 0, "written_off": 10_000},
]


async def _money(recharges=RECHARGES, credit=CREDIT, standing=STANDING,
                 per_seller=PER_SELLER):
    async def rech(*_a, **_k):
        if callable(recharges) and not isinstance(recharges, list):
            return await recharges()
        return list(recharges)

    async def cred(*_a, **_k):
        return list(credit)

    async def stand(*_a, **_k):
        return dict(standing)

    async def sellers(*_a, **_k):
        return list(per_seller)

    with patched(
        R,
        _recharge_events=recharges if not isinstance(recharges, list) else rech,
        _credit_events=cred,
        _seller_credit_standing=stand,
        _credit_by_seller=per_seller if callable(per_seller) else sellers,
    ):
        return await R.money_in(SINCE, UNTIL, RATES)


money = asyncio.run(_money())
mt = money.totals
check("user recharges are counted", mt["user_recharges_count"], 3)
check("and summed", mt["user_recharges_inr_minor"], rupees(8_500))
check("agency top-ups are kept OUT of user recharges", mt["agency_topups_inr_minor"], rupees(9_000))
check("everything came through a seller", mt["recharges_via_seller_inr_minor"], rupees(8_500))
check("and direct is zero", mt["recharges_direct_inr_minor"], 0)

mrows = {r["line"]: r for r in money.rows}
contains(
    "the direct zero is labelled a structural zero, not a measurement",
    mrows["User recharges — direct, no seller"]["detail"],
    "STRUCTURAL ZERO",
)
check("credit advanced", mt["credit_advanced_coins"], 500_000)
check("credit repaid", mt["credit_repaid_coins"], 300_000)
check("credit written off", mt["credit_written_off_coins"], 10_000)
check("credit outstanding", mt["credit_outstanding_coins"], 190_000)
check("and how much is late", mt["credit_overdue_coins"], 40_000)
contains("an overdue seller is called out", money.warnings, "past their credit due date")

# "how much seller credit in that week" is not answerable without WHO.
named = {r["subject_id"]: r for r in money.rows if r["block"] == "seller_credit_by_seller"}
check("every seller with credit is named, not just totalled", sorted(named), ["s1", "s2", "s3"])
check("by name", named["s1"]["subject"], "Rocket Coins")
check("carrying what they still owe", named["s1"]["native_amount"], 150_000)
check("valued in paise at the coin rate, never a float", named["s1"]["inr_minor"], 358_500)
contains("the week's movement is spelled out per seller",
         named["s1"]["detail"], "advanced 400,000, repaid 300,000")
contains("and the one who is late is marked late", named["s1"]["detail"], "OVERDUE")
absent("a seller inside their due date is not", named["s2"]["detail"], "OVERDUE")
contains("a seller with no due date says so rather than looking current",
         named["s3"]["detail"], "no due date on record")
check("the who-column is exported", "subject" in [k for k, _h in money.columns], True)
check("and the aggregate lines say who they cover",
      {r["line"]: r["subject"] for r in money.rows}["Seller credit advanced this week"],
      "all sellers")
check("sellers named", mt["sellers_with_credit_named"], 3)
check("and the totals say the breakdown was read", mt["seller_credit_named_by_seller"], True)

# The per-seller read failing must not take the totals with it.
anon = asyncio.run(_money(per_seller=gone("the per-seller credit breakdown")))
check("the totals survive", anon.totals["credit_advanced_coins"], 500_000)
check("but the breakdown is declared missing", anon.totals["seller_credit_named_by_seller"], False)
check("and no seller row is invented",
      [r for r in anon.rows if r["block"] == "seller_credit_by_seller"], [])
contains("with the reason", anon.warnings, "WHICH SELLER HELD WHICH CREDIT COULD NOT BE READ")
contains("and no seller reported as square", anon.warnings, "No seller is reported as owing nothing")

# A seller who did nothing this week but still owes us is somebody's problem,
# so the pull keeps them rather than filtering on movement alone.
credit_pipeline: list = []


async def _capture_credit(collection, pipeline):
    credit_pipeline.append((collection, pipeline))
    return []


with patched(R, _aggregate=_capture_credit):
    asyncio.run(R._credit_by_seller(SINCE, UNTIL))
_coll, _stages = credit_pipeline[0]
check("the per-seller pull reads partner records", _coll, "partners")
check("keeping a seller with a balance but no movement this week",
      _stages[2],
      {"$match": {"$or": [{"_window.0": {"$exists": True}},
                          {"credit.outstanding": {"$gt": 0}}]}})

# Nobody holding credit is a measured result and says so in words.
square = asyncio.run(_money(credit=[], per_seller=[]))
contains("a week where every seller is square says exactly that",
         square.warnings, "every one of them is square")
contains("and calls it measured, not missing", square.warnings, "not a missing table")

# Firestore down: recharges unknown, seller credit still reported. Neither is zero.
no_recharges = asyncio.run(_money(recharges=gone("rechargeRequests")))
check("recharges are not sourced", no_recharges.totals["recharges_sourced"], False)
check("no user recharge total is invented", "user_recharges_inr_minor" in no_recharges.totals, False)
check("but seller credit still came through", no_recharges.totals["seller_credit_sourced"], True)
check("with its real figure", no_recharges.totals["credit_advanced_coins"], 500_000)
contains("and the failure is loud", no_recharges.warnings, "USER RECHARGES COULD NOT BE READ")
contains("and explicitly not a quiet week", no_recharges.warnings, "not a week in which nobody recharged")


# ══════════════════════════════════════════════════════════════════════════════
#  9. LEADERBOARDS — ranked, or named as not produced
# ══════════════════════════════════════════════════════════════════════════════


async def _boards(recharges=RECHARGES, gifts=GIFTS):
    async def rech(*_a, **_k):
        return list(recharges)

    async def gift(*_a, **_k):
        return list(gifts)

    async def names(*_a, **_k):
        return {"u-whale": "Whale", "host-rich": "Rich Host"}, []

    with patched(
        R,
        _recharge_events=recharges if not isinstance(recharges, list) else rech,
        _gift_events=gifts if not isinstance(gifts, list) else gift,
        _user_names=names,
    ):
        return await R.leaderboards(SINCE, UNTIL, RATES, 10)


boards = asyncio.run(_boards())
by_board: dict[str, list] = {}
for row in boards.rows:
    by_board.setdefault(row["board"], []).append(row)

top_recharge = by_board["Highest-recharging users"]
check("the biggest recharger is first", top_recharge[0]["subject_id"], "u-whale")
check("with both recharges summed", top_recharge[0]["value"], rupees(8_000))
check("and shown in rupees", top_recharge[0]["value_inr"], 8_000.0)
check("named", top_recharge[0]["subject_name"], "Whale")
check("an agency top-up never appears on the user board",
      [r["subject_id"] for r in top_recharge], ["u-whale", "u-small"])

top_gift = by_board["Hosts by gift value received"]
check("the most-gifted host is first", top_gift[0]["subject_id"], "host-rich")
check("gift value in diamonds", top_gift[0]["value"], 10_000)

top_lucky = by_board["Highest lucky-gift spend"]
check("lucky spend is attributed to the SENDER", top_lucky[0]["subject_id"], "whale-1")
check("and counts only the lucky gift", top_lucky[0]["value"], 9_000)

check("all three boards were produced", len(boards.totals["boards_produced"]), 3)
check("and none is missing", boards.totals["boards_not_produced"], [])
contains("game bets are declared absent, with the reason", boards.warnings, "gamingBets")
contains("and why they cannot be ranked", boards.warnings, "catch-all deny")

# One source down → that board is named as not produced. No board is faked.
half = asyncio.run(_boards(recharges=gone("rechargeRequests")))
check("the recharge board is missing", half.totals["boards_not_produced"], ["Highest-recharging users"])
check("the gift boards still came", len(half.totals["boards_produced"]), 2)
check("and no recharge rows were invented",
      [r for r in half.rows if r["board"] == "Highest-recharging users"], [])
contains("with the reason", half.warnings, "HIGHEST-RECHARGING USERS: not produced")

# ── EMPTY IS NOT ZERO, AND EMPTY IS NOT MISSING ──────────────────────────────
#
# A board that was produced and has nobody on it must be on the page saying
# "none", because a board that simply vanishes reads as a board nobody ran.

quiet_boards = asyncio.run(_boards(recharges=[], gifts=[]))
quiet_by_board = {}
for row in quiet_boards.rows:
    quiet_by_board.setdefault(row["board"], []).append(row)

check("ALL THREE BOARDS ARE STILL ON THE PAGE", sorted(quiet_by_board),
      ["Highest lucky-gift spend", "Highest-recharging users",
       "Hosts by gift value received"])
check("each with exactly one row", [len(v) for v in quiet_by_board.values()], [1, 1, 1])
check("all three were produced", len(quiet_boards.totals["boards_produced"]), 3)
check("none is reported as not produced", quiet_boards.totals["boards_not_produced"], [])
check("and all three are named as having no entries",
      len(quiet_boards.totals["boards_with_no_entries"]), 3)
check("nobody was ranked", quiet_boards.totals["entries_ranked"], 0)

lucky_empty = quiet_by_board["Highest lucky-gift spend"][0]
contains("A WEEK WITH NO LUCKY GIFT READS 'NONE WERE SENT'",
         lucky_empty["detail"], "NO LUCKY GIFT WAS SENT IN THIS PERIOD")
contains("and says so is not a spend of zero", lucky_empty["detail"], "not a spend of ₹0")
check("with a null value, never 0", lucky_empty["value"], None)
check("and no rupee figure either", lucky_empty["value_inr"], None)
check("and no rank", lucky_empty["rank"], None)

contains("the recharge board says nobody recharged",
         quiet_by_board["Highest-recharging users"][0]["detail"],
         "NOBODY RECHARGED IN THIS PERIOD")
check("with no value", quiet_by_board["Highest-recharging users"][0]["value"], None)
contains("the gift board says no gift was received",
         quiet_by_board["Hosts by gift value received"][0]["detail"],
         "NO GIFT WAS RECEIVED IN THIS PERIOD")
contains("and names live-room gifts as absent by construction",
         quiet_by_board["Hosts by gift value received"][0]["detail"], "liveRooms")

check("the report declares itself empty", quiet_boards.as_dict()["empty"], True)
contains("in words that say the rows are statements, not rankings of zero",
         quiet_boards.warnings, "not three rankings of zero")

# A "nobody" row is never given a looked-up name.
check("the empty row is not dressed up as a person",
      lucky_empty["subject_name"], "—")

# One empty board beside two full ones is still named.
one_empty = asyncio.run(_boards(gifts=[g for g in GIFTS if not g["lucky"]]))
check("only the lucky board is empty", one_empty.totals["boards_with_no_entries"],
      ["Highest lucky-gift spend"])
check("the report is NOT empty overall", one_empty.as_dict()["empty"], False)
check("and the other boards still rank people", one_empty.totals["entries_ranked"] > 0, True)


# ══════════════════════════════════════════════════════════════════════════════
#  10. IDEMPOTENT REGENERATION — nothing is stored or sent twice
# ══════════════════════════════════════════════════════════════════════════════
#
# The guarantee has two halves and they are enforced by two different things:
# the store is keyed on the week and the unique `_id` index refuses the second
# insert; the email is deduplicated per recipient by `email_deliveries`. This
# checks the first directly and the second by asserting that a re-run re-uses
# the stored report rather than recomputing it — which is what makes the two
# sends carry the same dedupe key.


class FakeStore:
    """Just enough of a Mongo collection for the weekly store to be exercised.

    `_id` uniqueness is real, because that — not the read before it — is what
    makes generation idempotent under a race.
    """

    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.inserts = 0
        self.runs: list[dict] = []

    async def find_one(self, query):
        if "_id" in query:
            return self.docs.get(query["_id"])
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items()):
                return doc
        return None

    async def insert_one(self, doc):
        from tests.fakes import DuplicateKeyError

        if doc["_id"] in self.docs:
            raise DuplicateKeyError(f"duplicate _id {doc['_id']}")
        self.docs[doc["_id"]] = doc
        self.inserts += 1
        return type("R", (), {"inserted_id": doc["_id"]})()

    async def count_documents(self, query):
        return sum(
            1
            for doc in self.docs.values()
            if all(doc.get(k) == v for k, v in query.items())
        )

    def find(self, query):
        matched = [
            d for d in self.docs.values()
            if all(d.get(k) == v for k, v in query.items())
        ]
        return _Cursor(matched)


class _Cursor:
    def __init__(self, docs):
        self.docs = list(docs)

    def sort(self, key, direction=1):
        self.docs.sort(key=lambda d: d.get(key), reverse=direction < 0)
        return self

    def __aiter__(self):
        async def gen():
            for doc in self.docs:
                yield doc
        return gen()


def _stub_weekly_reports():
    """Every section produces a tiny real Report, so storage is exercised."""

    def make(name, title, rows, totals):
        async def _build(*_a, **_k):
            return R.Report(
                name=name,
                title=title,
                period=R._period(SINCE, UNTIL),
                columns=[("a", "A")],
                rows=list(rows),
                totals=dict(totals),
            )
        return _build

    return {
        "profit_and_loss": make(
            "weekly_profit_and_loss", "P&L", [{"a": 1}],
            {"profit_inr_minor": rupees(475_000), "complete": False},
        ),
        "money_in": make("weekly_money_in", "Money in", [{"a": 1}], {}),
        # 8B.7 / 8B.8 / 8B.9. Stubbed like the rest: what is under test here is
        # the weekly runner, and `tests/test_chance_revenue.py` exercises the
        # three reports themselves against known data.
        "chance_revenue": make(
            "chance_gross_gaming_revenue", "GGR", [{"a": 1}], {}
        ),
        "chance_margin": make("chance_margin", "Game margin", [{"a": 1}], {}),
        "chance_cannibalisation": make(
            "chance_cannibalisation", "Cannibalisation", [{"a": 1}], {}
        ),
        "agency_week": make("weekly_agencies", "Agencies", [{"a": 1}], {}),
        "host_week": make("weekly_hosts", "Hosts", [{"a": 1}], {}),
        "leaderboards": make("weekly_leaderboards", "Boards", [{"a": 1}], {}),
        "load_rates": (lambda *a, **k: _async(RATES)),
        "load_thresholds": (lambda *a, **k: _async(LIVE_THRESHOLDS)),
    }


def run_weekly(store: FakeStore, sends: list, force: bool = False):
    async def send(**kwargs):
        sends.append(kwargs)
        return {"sent": len(kwargs.get("sections") or []), "error": None}

    async def record(summary):
        store.runs.append(dict(summary))

    with patched(R, **_stub_weekly_reports()):
        with patched(S, _c=lambda _name: store, _send_report=send, _record_run=record):
            return asyncio.run(S.weekly(WEEK, force=force))


store = FakeStore()
sends: list = []

first = run_weekly(store, sends)
check("the first run stored the week", store.inserts, 1)
check("under the week's own id", sorted(store.docs), [WEEK])
check("and reports it regenerated", first["regenerated"], True)
check("the report id is the week", first["report_id"], WEEK)
check("revision 0", first["revision"], 0)
stored_first = dict(store.docs[WEEK])

second = run_weekly(store, sends)
check("REGENERATING STORES NOTHING NEW", store.inserts, 1)
check("still one document", sorted(store.docs), [WEEK])
check("and the second run says it re-used", second["regenerated"], False)
check("and says so explicitly", second["reused_stored_report"], True)
check(
    "THE FIGURES DID NOT MOVE",
    store.docs[WEEK]["sections"],
    stored_first["sections"],
)
check("nor did the generation time", store.docs[WEEK]["generated_at"], stored_first["generated_at"])

# Both runs still attempt delivery — a re-run after a mail outage must deliver.
# They carry the same period key, which is what `email_deliveries.dedupe_key`
# collapses into a single send.
check("both runs attempted delivery", len(sends), 2)
check("with the same dedupe period key", sends[0]["period_key"], sends[1]["period_key"])
check("which is the stored report's id", sends[0]["period_key"], WEEK)
check("the P&L leads the email", sends[0]["sections"][0].title.startswith("Profit and loss"), True)

# A deliberate re-run stores a NEW revision beside the original, never over it.
third = run_weekly(store, sends, force=True)
check("a forced re-run stores a second document", store.inserts, 2)
check("beside the original", sorted(store.docs), [WEEK, f"{WEEK}#r1"])
check("as revision 1", third["revision"], 1)
check("the original is untouched", store.docs[WEEK]["sections"], stored_first["sections"])

# The record can be read back, oldest revision first.
revisions = asyncio.run(
    (lambda: (patched(S, _c=lambda _n: store).__enter__(), S.read_week(WEEK))[1])()
)
check("both revisions are readable", [d["revision"] for d in revisions], [0, 1])

# ── ONE SECTION FAILING MUST NOT COST THE OTHER FOUR ────────────────────────
#
# An unattended Sunday report that fails quietly is worse than none: the four
# sections that worked still have to arrive, and the email has to say which one
# did not.

def run_weekly_with_one_broken(store, sends):
    stubs = _stub_weekly_reports()

    async def broken(*_a, **_k):
        raise R.DataUnavailable("giftEvents could not be read: connection refused.")

    stubs["leaderboards"] = broken

    async def send(**kwargs):
        sends.append(kwargs)
        return {"sent": 1, "error": None}

    async def record(summary):
        store.runs.append(dict(summary))

    with patched(R, **stubs):
        with patched(S, _c=lambda _n: store, _send_report=send, _record_run=record):
            return asyncio.run(S.weekly("2026-W30"))


broken_store = FakeStore()
broken_sends: list = []
broken_run = run_weekly_with_one_broken(broken_store, broken_sends)

check("THE REPORT STILL WENT OUT", len(broken_sends), 1)
broken_sections = broken_sends[0]["sections"]
check("all eight sections are still in the email", len(broken_sections), 8)
check("seven of them carry a table", sum(1 for x in broken_sections if x.ok), 7)
check("the failed one is named on the run", broken_run["failed_sections"],
      ["Leaderboards — recharges, gifts received, lucky-gift spend"])
contains("and its own refusal is what the email prints",
         [x.error for x in broken_sections if not x.ok][0],
         "giftEvents could not be read")
broken_files, broken_omitted = S._attachments(broken_sections)
broken_note = S._attachment_note(broken_sections, broken_files, broken_omitted)
contains("the attachment note says a section is missing, and which",
         broken_note, "shown as failures rather than as zeroes")
contains("naming it", broken_note, "Leaderboards")
check("seven CSVs still go with it", len(broken_files), 7)
check("…and none of them was refused as unsendable", broken_omitted, [])
contains("the rendered body flags it as not-a-zero",
         S._render(broken_sections), "Could not be computed — this is not a zero")
# Sentence case, not shouting: the one email of the week that most needs to be
# read must not be scored as spam for saying so in capitals.
contains("the subject line says so before anyone opens the mail",
         broken_sends[0]["subject"], "could not be computed")
check("…and it says it without shouting, which filters score as spam",
      mail_module.subject_problems(broken_sends[0]["subject"]), [])
contains("and it is on the list of things needing a person",
         broken_run["needs_a_person"], "NOT COMPUTED")
check("the failure is stored, not lost",
      [x["ok"] for x in broken_store.docs["2026-W30"]["sections"]],
      [True, True, True, True, True, True, True, False])
contains("stored as a failure and explicitly not a zero",
         broken_store.docs["2026-W30"]["sections"][7]["note"], "It is not a zero")

# Re-reading that stored week rebuilds the same failure, not a fresh attempt.
rebuilt = S._sections_from_stored(broken_store.docs["2026-W30"])
check("the re-send carries the same failure", [x.ok for x in rebuilt],
      [True, True, True, True, True, True, True, False])


# The subject line leads with the P&L and flags the upper bound.
subject = S._weekly_subject(WEEK, stored_first)
contains("the subject carries the week", subject, WEEK)
contains("and the profit", subject, "profit")
contains("and that it is an upper bound", subject, "upper bound")

# A week with a failed section says so in the subject, before anyone opens it.
broken_stored = {
    "week_label": WEEK,
    "failed_sections": ["Hosts — work, payout due, and eligibility with the reason"],
    "needs_a_person": [],
    "sections": [],
}
contains(
    "a failed section reaches the subject line",
    S._weekly_subject(WEEK, broken_stored),
    "COULD NOT BE COMPUTED",
)


# ══════════════════════════════════════════════════════════════════════════════
#  11. THE WINDOW — one week, and the same one the accrual bills over
# ══════════════════════════════════════════════════════════════════════════════

since, until, label = S._weekly_window(WEEK)
check("the week starts on a Monday", since.weekday(), 0)
check("and is exactly seven days", (until - since), timedelta(days=7))
check("and keeps its label", label, WEEK)

# It is the commission engine's own window, not a second implementation.
com_since, com_until, _ = COM.resolve_period(WEEK)
check("host eligibility and commission cover the same days", (since, until), (com_since, com_until))

# The job runs on a Sunday evening, when the current week has not closed, so it
# reports the week before.
sunday = datetime(2026, 8, 23, 18, 29, tzinfo=timezone.utc)
check("a Sunday run reports the week that has closed", S.last_closed_iso_week(sunday), "2026-W33")
check("which is not the week the job is running in", sunday.isocalendar()[1], 34)

S._weekly_window("2026-W33")
try:
    S._weekly_window("last-week")
    failures.append("an undateable label should be refused, not guessed at")
    checks += 1
except ValueError:
    checks += 1


# ══════════════════════════════════════════════════════════════════════════════
#  Report
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} weekly business report checks passed.")
print()
print("  · a host above the line is eligible; one below keeps its figure and its shortfall")
print("  · an agency below the ₹26,001 sub floor earns a real, explained zero")
print("  · a source that is down produces UNKNOWN columns and a loud warning, never zeroes")
print("  · a week with no activity is empty, in words, and says what that would mean")
print("  · profit = revenue − expenditure, and an unrecorded cost makes it an upper bound")
print("  · regenerating a week stores nothing twice and moves no figure")
print("  · a sub-agency's money goes VIA its main agency, and both tables say so")
print("  · an open second leg is money that left us and may not have reached the sub")
print("  · seller credit is named seller by seller, with what each still owes")
print("  · an empty leaderboard says 'none were sent', with a null value, never ₹0")
print("  · an operating cost category with no entry for the period reads UNKNOWN, never zero")
print("  · one section failing costs the other seven nothing, and the email names it")
print("  · the week carries gross gaming revenue, the game margin model and the")
print("    cannibalisation guard as sections of their own (8B.7 / 8B.8 / 8B.9)")
sys.exit(0)
