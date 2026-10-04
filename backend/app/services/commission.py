"""Agency commission — the slab engine, and the single source of truth for it.

Until now this arithmetic lived in `zipper-crm/lib/commission.ts`, in a browser,
and the API accepted whatever figure the browser sent. What an agency is owed is
a money fact about the business; it is computed here, from the ledger, and the
caller supplies only the period. Spec 0.1.5 / 0.6.3.

**The rule, in plain English.**

  * An agency's **billing for the period** is the total its hosts cashed out in
    that period, valued in rupees.
  * That one figure selects **one band** from the agency's slab table.
  * The band's rate applies to the **whole** billing figure. This is a flat rate
    by band, not a progressive/marginal calculation — ₹1 crore of billing earns
    25% of ₹1 crore, not 25% of the slice above ₹25 lakh.
  * Below the lowest band's floor (₹25,001 for a main agency, ₹26,001 for a
    sub-agency in the live configuration) the agency earns **nothing**. The
    floor is deliberate. Hosts are still paid their own payout in full; the
    floor affects the agency's commission and nothing else.
  * The **top band is open-ended**. Its declared upper bound is ignored for
    matching: above its lower bound the rate applies with no cap, so the
    effective rate can never fall as an agency bills more.

**Units and rounding.** Every money figure in this module is an integer in
minor units (paise). Rates are held as integer basis points — 7.5% is 750 bp —
so nothing here is a float. The commission is
``(billing_minor * rate_bp + 5_000) // 10_000``: exact integer arithmetic,
rounded half-up to the nearest paisa, ties going to the agency. It is applied
**once** to the whole billing figure, so there is exactly one rounding step per
period and per-band rounding drift cannot exist.

**A malformed slab table refuses.** An empty table, an unreadable rate, a gap
between bands or an overlap raises `CommissionError` rather than quietly paying
zero or quietly paying the wrong band. A wrong commission that looks plausible
is worse than a refusal that names the problem.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any

from app.core.compat import StrEnum

# Firestore, Mongo and the ledger vocabulary are imported *inside* the four
# functions that touch them, not here. The rule this module encodes is the most
# consequential arithmetic in the business, and it should be readable and
# testable on its own — `import app.services.commission` needs no database, no
# Firebase credentials and no network, so `tests/test_commission.py` runs the
# real engine rather than a copy of it.
#
# `app/services/partners.py` reads this module for the statement breakdown, so
# the sub-agency kind constant is named here rather than imported back from it.
SUB_AGENCY_KIND = "sub_agency"

log = logging.getLogger(__name__)


# ── Errors ────────────────────────────────────────────────────────────────────


class CommissionError(Exception):
    """The commission cannot be computed, and the caller is told why.

    Never swallowed into a zero. A zero commission is a real answer only when a
    real billing figure fell below the floor.
    """

    status_code = 400


class MalformedSlabTable(CommissionError):
    """The configured slab table cannot be trusted, so nothing is paid from it."""

    status_code = 503


# ── Kinds ─────────────────────────────────────────────────────────────────────


class AgencyKind(StrEnum):
    MAIN = "main"
    SUB = "sub"


CONFIG_KEY = {
    AgencyKind.MAIN: "mainAgencySlabs",
    AgencyKind.SUB: "subAgencySlabs",
}


def kind_of(partner: Mapping[str, Any]) -> AgencyKind:
    """Which slab table serves this partner record.

    One engine serves both; only the table differs, and a sub-agency's table
    carries its own floor.
    """
    if str(partner.get("kind", "")) == SUB_AGENCY_KIND:
        return AgencyKind.SUB
    return AgencyKind.MAIN


# ── Bands ─────────────────────────────────────────────────────────────────────
#
# The configured table states bounds in **rupees** and rates in percent:
#
#     {"from": 25001, "to": 75000, "rate": 5}
#
# `from` is inclusive, `to` is inclusive, and consecutive bands are written as
# `to`, `to + 1` — 75000 then 75001. That convention leaves the 99 paise between
# ₹75,000.00 and ₹75,001.00 in no band at all, which is a writing convention
# rather than an intent to exclude them. So a band's effective range in minor
# units runs from its own `from` up to the next band's `from`, exclusive, and
# every paisa above the floor lands in exactly one band.
#
# A *real* gap — a table where one band ends at 75000 and the next begins at
# 100001 — is not a writing convention. It is refused.

MINOR_PER_MAJOR = 100
BASIS_POINTS_PER_PERCENT = 100
BASIS_POINTS_PER_UNIT = 10_000

# The CRM writes a `to` of 999,999,999 on the last band to mean "no cap". The
# top band is open-ended whatever its `to` says, so that sentinel needs no
# special handling here — a table that instead caps its top band at ₹50,00,000,
# as the live one does, behaves identically.


@dataclass(frozen=True, slots=True)
class Band:
    """One slab, in minor units, with its rate in integer basis points."""

    index: int
    from_minor: int              # inclusive
    to_minor: int | None         # inclusive; None on the open-ended top band
    rate_bp: int                 # 750 == 7.5%
    declared_from: int           # as configured, in rupees
    declared_to: int             # as configured, in rupees

    @property
    def open_ended(self) -> bool:
        return self.to_minor is None

    def contains(self, billing_minor: int) -> bool:
        if billing_minor < self.from_minor:
            return False
        return self.to_minor is None or billing_minor <= self.to_minor

    @property
    def rate_percent(self) -> str:
        """The rate as it reads to a human — "7.5", not 7.500000000000001."""
        return _trim(Decimal(self.rate_bp) / BASIS_POINTS_PER_PERCENT)

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "from_minor": self.from_minor,
            "to_minor": self.to_minor,
            "from_inr": self.from_minor / MINOR_PER_MAJOR,
            "to_inr": None if self.to_minor is None else self.to_minor / MINOR_PER_MAJOR,
            "rate_percent": self.rate_percent,
            "rate_basis_points": self.rate_bp,
            "open_ended": self.open_ended,
            "declared_from_inr": self.declared_from,
            "declared_to_inr": self.declared_to,
            "label": self.label,
        }

    @property
    def label(self) -> str:
        low = rupee_text(self.from_minor)
        if self.to_minor is None:
            return f"{low} and above @ {self.rate_percent}%"
        return f"{low} – {rupee_text(self.to_minor)} @ {self.rate_percent}%"


def _trim(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text


def rupee_text(minor: int) -> str:
    """Paise as rupees, grouped the Indian way — ₹15,00,000.00, not ₹1,500,000.00.

    Every explanation this module writes is read by an Indian agency, so the
    figure is grouped the way they would write it themselves.
    """
    sign = "-" if minor < 0 else ""
    whole, paise = divmod(abs(int(minor)), MINOR_PER_MAJOR)
    text = str(whole)
    if len(text) > 3:
        head, tail = text[:-3], text[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        text = ",".join(groups + [tail])
    return f"{sign}₹{text}.{paise:02d}"


def _rupees(raw: Any, label: str, index: int) -> int:
    """A configured bound, in whole rupees. Anything else refuses."""
    try:
        amount = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise MalformedSlabTable(
            f"Slab {index + 1} has a '{label}' of {raw!r}, which is not a number. "
            "No commission is computed from a table that cannot be read."
        ) from exc
    if amount != amount.to_integral_value():
        raise MalformedSlabTable(
            f"Slab {index + 1} has a '{label}' of {raw!r}. Slab bounds are whole "
            "rupees; a fractional bound is ambiguous and is refused rather than "
            "rounded silently."
        )
    if amount < 0:
        raise MalformedSlabTable(
            f"Slab {index + 1} has a negative '{label}' ({raw!r})."
        )
    return int(amount)


def _rate_bp(raw: Any, index: int) -> int:
    """A configured percentage, as integer basis points."""
    try:
        percent = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise MalformedSlabTable(
            f"Slab {index + 1} has a rate of {raw!r}, which is not a number."
        ) from exc
    if percent < 0 or percent > 100:
        raise MalformedSlabTable(
            f"Slab {index + 1} has a rate of {percent}%, which is outside 0–100%."
        )
    bp = percent * BASIS_POINTS_PER_PERCENT
    if bp != bp.to_integral_value():
        raise MalformedSlabTable(
            f"Slab {index + 1} has a rate of {percent}%. Rates are held as whole "
            "basis points (two decimal places); a finer rate cannot be applied "
            "exactly, so it is refused rather than rounded."
        )
    return int(bp)


def parse_slabs(raw_slabs: Any) -> list[Band]:
    """Turn a configured slab table into bands, or refuse.

    Sorted by lower bound — a table written out of order is a formatting
    accident, not a different rule — then validated:

      * the table must not be empty
      * bounds must be whole, non-negative rupees, with ``to >= from``
      * bands must not overlap
      * bands must be consecutive: each ``from`` is the previous ``to`` + 1

    The last band is made open-ended: its configured ``to`` is kept for display
    but ignored for matching, because the top band has no cap.
    """
    if raw_slabs is None or not isinstance(raw_slabs, Sequence) or isinstance(raw_slabs, (str, bytes)):
        raise MalformedSlabTable(
            "The commission slab table is missing or is not a list of slabs. "
            "No commission is computed."
        )
    entries = list(raw_slabs)
    if not entries:
        raise MalformedSlabTable(
            "The commission slab table is empty. An empty table is not the same "
            "as a zero rate, so nothing is paid from it."
        )

    parsed: list[tuple[int, int, int]] = []
    for i, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            raise MalformedSlabTable(
                f"Slab {i + 1} is {entry!r}, not a slab with from / to / rate."
            )
        missing = [k for k in ("from", "to", "rate") if entry.get(k) is None]
        if missing:
            raise MalformedSlabTable(
                f"Slab {i + 1} is missing {', '.join(missing)}. A slab without a "
                "bound or a rate cannot be applied."
            )
        low = _rupees(entry["from"], "from", i)
        high = _rupees(entry["to"], "to", i)
        rate = _rate_bp(entry["rate"], i)
        if high < low:
            raise MalformedSlabTable(
                f"Slab {i + 1} runs from ₹{low:,} to ₹{high:,} — its upper bound "
                "is below its lower bound."
            )
        parsed.append((low, high, rate))

    parsed.sort(key=lambda t: (t[0], t[1]))

    for i in range(1, len(parsed)):
        prev_low, prev_high, _ = parsed[i - 1]
        low, high, _ = parsed[i]
        if low <= prev_high:
            raise MalformedSlabTable(
                f"Slabs ₹{prev_low:,}–₹{prev_high:,} and ₹{low:,}–₹{high:,} "
                "overlap. Two bands could claim the same billing figure, so no "
                "band is chosen and nothing is paid until the table is fixed."
            )
        if low != prev_high + 1:
            raise MalformedSlabTable(
                f"There is a gap between ₹{prev_high:,} and ₹{low:,} in the slab "
                f"table — billing of ₹{prev_high + 1:,} falls in no band. The "
                "table is refused rather than quietly paying the band below."
            )

    bands: list[Band] = []
    last = len(parsed) - 1
    for i, (low, high, rate) in enumerate(parsed):
        if i == last:
            to_minor = None                       # top band: no cap
        else:
            # Runs up to the next band's floor, so the paise between ₹75,000.00
            # and ₹75,001.00 belong to the band below rather than to nothing.
            to_minor = parsed[i + 1][0] * MINOR_PER_MAJOR - 1
        bands.append(
            Band(
                index=i,
                from_minor=low * MINOR_PER_MAJOR,
                to_minor=to_minor,
                rate_bp=rate,
                declared_from=low,
                declared_to=high,
            )
        )
    return bands


def floor_minor(bands: Sequence[Band]) -> int:
    """The lowest band's lower bound — below this an agency earns nothing."""
    if not bands:
        raise MalformedSlabTable("No bands, so there is no floor to apply.")
    return bands[0].from_minor


# ── The engine ────────────────────────────────────────────────────────────────

RULE = (
    "Progressive by band, like income tax. Each slice of the agency's billing "
    "is charged at the rate of the band it falls in — the first slice at the "
    "lowest band's rate, the next at the next band's rate, and so on. No single "
    "rate is ever applied to the whole amount. Below the lowest band's lower "
    "bound the agency earns nothing, and that part never attracts a rate even "
    "when the total is far above it. The top band is open-ended."
)

ROUNDING = (
    "Integer paise throughout. Each band contributes slice_minor × "
    "rate_basis_points exactly; the products are summed and the total is "
    "rounded once — (Σ + 5000) ÷ 10000, integer division, half-up to the "
    "nearest paisa, ties to the agency. Rounding once at the end rather than "
    "per band means the parts always add up to the total, and there is exactly "
    "one rounding step per period however many bands were crossed."
)


def commission_for(
    billing_minor: int, slabs: Sequence[Band]
) -> tuple[int, dict]:
    """The commission on `billing_minor` paise of billing, and why.

    Returns ``(commission_minor, breakdown)``. The breakdown names the band that
    matched, its bounds, its rate and the billing the rate applied to — every
    commission figure in this product has to be explainable to the agency that
    receives it.
    """
    if isinstance(billing_minor, bool) or not isinstance(billing_minor, int):
        raise CommissionError(
            f"Billing must be a whole number of paise, not {billing_minor!r}. "
            "Money is never a float here."
        )
    if billing_minor < 0:
        raise CommissionError(
            f"Billing of {billing_minor} paise is negative. A negative period "
            "total is a ledger problem, not a commission of zero."
        )
    if not slabs:
        raise MalformedSlabTable(
            "No commission bands are configured, so no band can be chosen."
        )

    low = floor_minor(slabs)
    base: dict = {
        "billing_minor": billing_minor,
        "billing_inr": billing_minor / MINOR_PER_MAJOR,
        "rule": RULE,
        "rounding": ROUNDING,
        "floor_minor": low,
        "floor_inr": low / MINOR_PER_MAJOR,
        "bands_considered": [b.as_dict() for b in slabs],
    }

    if billing_minor < low:
        return 0, {
            **base,
            "matched": False,
            "band": None,
            "rate_percent": "0",
            "rate_basis_points": 0,
            "commission_minor": 0,
            "commission_inr": 0.0,
            "effective_rate_percent": "0",
            "explanation": (
                f"Billing of {rupee_text(billing_minor)} is below the "
                f"{rupee_text(low)} floor, so the agency earns no "
                "commission for this period. The hosts are paid their own payout "
                "in full — the floor applies to agency commission only."
            ),
        }

    top = next((b for b in slabs if b.contains(billing_minor)), None)
    if top is None:  # unreachable while parse_slabs guarantees contiguity
        raise MalformedSlabTable(
            f"Billing of {rupee_text(billing_minor)} falls in no "
            "configured band. Nothing is paid until the table is fixed."
        )

    # Walk the bands from the bottom, charging each slice at its own rate.
    #
    # `from_minor` is the first paisa the band charges for, so the paisa below
    # it is the band's lower edge and the slice is everything between that edge
    # and whichever comes first — the band's own ceiling, or the billing total.
    #
    # The products are accumulated unrounded and rounded once at the end (see
    # ROUNDING), so the per-band figures shown to the agency always add up to
    # the total they are paid.
    slices: list[dict] = []
    raw_total = 0
    for band in slabs:
        if billing_minor < band.from_minor:
            break
        lower_edge = band.from_minor - 1
        ceiling = billing_minor if band.to_minor is None else min(billing_minor, band.to_minor)
        slice_minor = ceiling - lower_edge
        if slice_minor <= 0:
            continue

        product = slice_minor * band.rate_bp
        raw_total += product
        slices.append(
            {
                "band_index": band.index,
                "band_label": band.label,
                "from_minor": band.from_minor,
                "to_minor": band.to_minor,
                "rate_percent": band.rate_percent,
                "rate_basis_points": band.rate_bp,
                "slice_minor": slice_minor,
                "slice_inr": slice_minor / MINOR_PER_MAJOR,
                # Indicative only — the rounding happens once, on the total.
                "commission_minor": (product + 5_000) // BASIS_POINTS_PER_UNIT,
            }
        )

    commission_minor = (raw_total + 5_000) // BASIS_POINTS_PER_UNIT

    # What the agency actually earns as a share of what it billed. Under a
    # progressive table this is always *below* the top band's rate, and it is
    # the number an agency will quote at you — so it is computed, not assumed.
    effective = (
        _trim(
            (Decimal(commission_minor) * 100 / Decimal(billing_minor)).quantize(
                Decimal("0.01")
            )
        )
        if billing_minor
        else "0"
    )

    untaxed = min(billing_minor, low - 1)
    return commission_minor, {
        **base,
        "matched": True,
        # The highest band reached. Kept under the same key as before so every
        # existing reader — the agency dashboard, the statements, the weekly
        # report — keeps working; what changed is that it is now the *top* band
        # crossed rather than the only one applied.
        "band": top.as_dict(),
        "rate_percent": top.rate_percent,
        "rate_basis_points": top.rate_bp,
        "slices": slices,
        "bands_crossed": len(slices),
        "untaxed_minor": untaxed,
        "untaxed_inr": untaxed / MINOR_PER_MAJOR,
        "commission_minor": commission_minor,
        "commission_inr": commission_minor / MINOR_PER_MAJOR,
        "effective_rate_percent": effective,
        "explanation": (
            f"Billing of {rupee_text(billing_minor)} is charged band by band. "
            f"The first {rupee_text(untaxed)} is below the "
            f"{rupee_text(low)} floor and attracts nothing; the rest is split "
            f"across {len(slices)} band"
            f"{'' if len(slices) == 1 else 's'}, each slice at its own rate, up "
            f"to {top.rate_percent}% on the part above "
            f"{rupee_text(top.from_minor)}. That comes to "
            f"{rupee_text(commission_minor)} — an effective rate of "
            f"{effective}% on the whole billing, which is lower than the top "
            "band's rate because only the top slice is charged at it."
        ),
    }


def apportion(total_minor: int, weights: Sequence[int]) -> list[int]:
    """Split `total_minor` across `weights` so the parts sum to it exactly.

    Largest-remainder: each share is the exact proportion floored, then the
    leftover paise go to the largest remainders. Used to attribute one
    agency-level commission figure to the hosts that produced it — the band was
    chosen by the agency's total, so a host's share is a share of that total,
    never a separate calculation.
    """
    total_weight = sum(weights)
    if total_weight <= 0 or not weights:
        return [0] * len(weights)

    shares = [total_minor * w // total_weight for w in weights]
    remainder = total_minor - sum(shares)
    if remainder:
        order = sorted(
            range(len(weights)),
            key=lambda i: (-(total_minor * weights[i] % total_weight), -weights[i], i),
        )
        for i in order[:remainder]:
            shares[i] += 1
    return shares


# ── Loading the live table ────────────────────────────────────────────────────
#
# Slabs live in Firestore `appConfig/economy` → `commissionConfig`, edited from
# the Economy Config page. This follows `app/services/reports.py`: read once,
# and if the read fails fall back to the documented table while saying loudly
# that the figure is provisional. A caller must always be able to tell a real
# figure from a provisional one.
#
# The fallbacks below are the live tables as at the 2026-08-20 backup. They are
# not invented bands, and they are not authoritative — anything computed from
# them is marked provisional.

FALLBACK_MAIN_SLABS: list[dict] = [
    {"from": 25_001, "to": 75_000, "rate": 5},
    {"from": 75_001, "to": 150_000, "rate": 7.5},
    {"from": 150_001, "to": 300_000, "rate": 10},
    {"from": 300_001, "to": 500_000, "rate": 14},
    {"from": 500_001, "to": 800_000, "rate": 16},
    {"from": 800_001, "to": 1_200_000, "rate": 18},
    {"from": 1_200_001, "to": 1_800_000, "rate": 21},
    {"from": 1_800_001, "to": 2_500_000, "rate": 23},
    {"from": 2_500_001, "to": 5_000_000, "rate": 25},
]

FALLBACK_SUB_SLABS: list[dict] = [
    {"from": 26_001, "to": 75_000, "rate": 5},
    {"from": 75_001, "to": 150_000, "rate": 6},
    {"from": 150_001, "to": 300_000, "rate": 7},
    {"from": 300_001, "to": 500_000, "rate": 8},
    {"from": 500_001, "to": 800_000, "rate": 9},
    {"from": 800_001, "to": 1_200_000, "rate": 10},
    {"from": 1_200_001, "to": 1_800_000, "rate": 11},
    {"from": 1_800_001, "to": 2_500_000, "rate": 12},
    {"from": 2_500_001, "to": 5_000_000, "rate": 12.5},
]

FALLBACK_SLABS = {
    AgencyKind.MAIN: FALLBACK_MAIN_SLABS,
    AgencyKind.SUB: FALLBACK_SUB_SLABS,
}

FALLBACK_BEAN_TO_INR = 0.01     # matches reports.FALLBACK_BEAN_TO_INR


@dataclass(slots=True)
class SlabTable:
    """A table of bands, and how much to trust it."""

    kind: AgencyKind
    bands: list[Band]
    source: str                 # "firestore" | "fallback"
    provisional: bool
    note: str
    fetched_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def as_dict(self) -> dict:
        return {
            "kind": str(self.kind),
            "config_key": CONFIG_KEY[self.kind],
            "source": self.source,
            "provisional": self.provisional,
            "note": self.note,
            "fetched_at": self.fetched_at,
            "floor_minor": floor_minor(self.bands),
            "floor_inr": floor_minor(self.bands) / MINOR_PER_MAJOR,
            "bands": [b.as_dict() for b in self.bands],
        }


def _read_economy_doc() -> dict:
    """Blocking Firestore read, run off the event loop by `load_slab_table`."""
    from app.db import firebase

    snapshot = (
        firebase.firestore_client().collection("appConfig").document("economy").get()
    )
    if not snapshot.exists:
        return {}
    return snapshot.to_dict() or {}


def _fallback_table(kind: AgencyKind, reason: str) -> SlabTable:
    return SlabTable(
        kind=kind,
        bands=parse_slabs(FALLBACK_SLABS[kind]),
        source="fallback",
        provisional=True,
        note=(
            f"PROVISIONAL — {reason} The documented fallback slab table for a "
            f"{kind} agency was used. Any figure computed from it is not "
            "authoritative and must not be paid without confirming the live "
            "configuration."
        ),
    )


async def load_slab_table(kind: AgencyKind) -> SlabTable:
    """Read `appConfig/economy` → `commissionConfig` for one kind of agency.

    A Firestore outage falls back, loudly. A table that is *present but
    malformed* does **not** fall back: it raises, because silently paying a
    different table than the one the owner edited is exactly the failure this
    module exists to prevent.
    """
    try:
        data = await asyncio.to_thread(_read_economy_doc)
    except Exception as exc:  # noqa: BLE001 — a config outage must not lose the figure
        log.warning("Could not read appConfig/economy for slabs: %s", exc)
        return _fallback_table(
            kind, "the economy configuration could not be read from Firestore."
        )

    config = data.get("commissionConfig")
    if not isinstance(config, Mapping):
        return _fallback_table(
            kind, "appConfig/economy holds no commissionConfig block."
        )

    raw = config.get(CONFIG_KEY[kind])
    if raw is None:
        return _fallback_table(
            kind,
            f"appConfig/economy → commissionConfig has no {CONFIG_KEY[kind]}.",
        )

    # Malformed → raises. That is deliberate; see the docstring.
    bands = parse_slabs(raw)
    return SlabTable(
        kind=kind,
        bands=bands,
        source="firestore",
        provisional=False,
        note=(
            f"Slabs read from Firestore appConfig/economy → commissionConfig."
            f"{CONFIG_KEY[kind]} ({len(bands)} bands, floor "
            f"{rupee_text(floor_minor(bands))})."
        ),
    )


async def load_bean_rate() -> tuple[float, bool, str]:
    """Beans → INR, with the same provisional signalling as the slab table."""
    try:
        data = await asyncio.to_thread(_read_economy_doc)
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read appConfig/economy for the bean rate: %s", exc)
        return (
            FALLBACK_BEAN_TO_INR,
            True,
            "PROVISIONAL — the bean rate could not be read; "
            f"₹{FALLBACK_BEAN_TO_INR:g} per bean was assumed.",
        )

    gift_rates = data.get("giftRates")
    raw = gift_rates.get("beanToInrRate") if isinstance(gift_rates, Mapping) else None
    try:
        rate = float(raw)
        if rate <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return (
            FALLBACK_BEAN_TO_INR,
            True,
            "PROVISIONAL — giftRates.beanToInrRate is missing from "
            f"appConfig/economy; ₹{FALLBACK_BEAN_TO_INR:g} per bean was assumed.",
        )
    return rate, False, f"₹{rate:g} per bean, from appConfig/economy."


# ── Periods ───────────────────────────────────────────────────────────────────

MAX_PERIOD_DAYS = 400


def resolve_period(
    period: str, since: datetime | None = None, until: datetime | None = None
) -> tuple[datetime, datetime, str]:
    """Settle the window a commission run covers.

    Half-open ``[since, until)``, like every other period in this system, so two
    consecutive periods can never both claim the same cash-out.

    `period` is the label that appears in the idempotency key and on the
    agency's statement. ``2026-W33`` (ISO week) and ``2026-08`` (calendar month)
    are understood and resolve to their own window; any other label is accepted
    as a name but then requires explicit `since` / `until`, because a period
    nobody can date cannot be computed from the ledger.
    """
    label = (period or "").strip()
    if not label:
        raise CommissionError(
            "A period is required (for example 2026-W33). Commission must be "
            "attributable to the period that produced it."
        )

    derived = _window_from_label(label)
    if since is None and until is None:
        if derived is None:
            raise CommissionError(
                f"'{label}' is not a period this server can date. Use an ISO week "
                "(2026-W33) or a month (2026-08), or pass an explicit since/until."
            )
        start, end = derived
    else:
        if since is None or until is None:
            raise CommissionError(
                "Give both since and until, or neither — a half-stated window "
                "would silently pick its own other end."
            )
        start, end = _utc(since), _utc(until)

    if start >= end:
        raise CommissionError(
            f"The period start ({start.isoformat()}) must be before its end "
            f"({end.isoformat()})."
        )
    if (end - start) > timedelta(days=MAX_PERIOD_DAYS):
        raise CommissionError(
            f"That period is {(end - start).days} days. Commission periods are "
            f"capped at {MAX_PERIOD_DAYS} days."
        )
    return start, end, label


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _window_from_label(label: str) -> tuple[datetime, datetime] | None:
    """``2026-W33`` → that ISO week; ``2026-08`` → that calendar month."""
    text = label.upper().replace(" ", "")
    if "-W" in text:
        year_text, _, week_text = text.partition("-W")
        try:
            year, week = int(year_text), int(week_text)
        except ValueError:
            return None
        if not 1 <= week <= 53:
            return None
        try:
            start = datetime.fromisocalendar(year, week, 1).replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            return None
        return start, start + timedelta(days=7)

    parts = text.split("-")
    if len(parts) == 2 and all(p.isdigit() for p in parts):
        year, month = int(parts[0]), int(parts[1])
        if not 1 <= month <= 12:
            return None
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        end = (
            datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            if month == 12
            else datetime(year, month + 1, 1, tzinfo=timezone.utc)
        )
        return start, end
    return None


# ── Billing, from the ledger ──────────────────────────────────────────────────

BILLING_DEFINITION = (
    "An agency's billing for a period is the total its hosts cashed out in that "
    "period: bean debits on a host's balance whose action is a payout "
    "(payout.execute, withdrawal.pay) and whose meta.agency_id names the "
    "agency, valued at the bean → INR rate in force. Beans a host earned but "
    "has not cashed out are not billing — they are reported alongside, and they "
    "become billing in the period they are actually paid."
)

def cashout_actions() -> list[str]:
    """The ledger actions that mean "a host was actually paid"."""
    from app.core import audit

    return [audit.Action.PAYOUT_EXECUTE, audit.Action.WITHDRAWAL_PAY]


async def agency_billing(
    agency_id: str,
    since: datetime,
    until: datetime,
    bean_to_inr: float | None = None,
) -> dict:
    """What an agency's hosts cashed out in ``[since, until)``, per host.

    Grouped and summed in the database, never by pulling the ledger into Python.
    """
    if bean_to_inr is None:
        rate, provisional, rate_note = await load_bean_rate()
    else:
        rate, provisional, rate_note = (
            float(bean_to_inr),
            False,
            f"₹{float(bean_to_inr):g} per bean, supplied by the caller.",
        )

    cashouts = await _aggregate_hosts(
        agency_id, since, until, negative=True, actions=cashout_actions()
    )
    earnings = await _aggregate_hosts(agency_id, since, until, negative=False)

    hosts: list[dict] = []
    total_beans = 0
    for row in cashouts:
        beans = int(row["beans"])
        total_beans += beans
        hosts.append(
            {
                "host_id": row["_id"],
                "beans_cashed_out": beans,
                # Each host's own rupee figure, rounded once, for display only.
                # The commission is never computed per host — see `apportion`.
                "billing_minor": _beans_to_minor(beans, rate),
                "movements": int(row["movements"]),
                "last_at": row.get("last_at"),
            }
        )
    hosts.sort(key=lambda h: (-h["beans_cashed_out"], h["host_id"]))

    # The agency total is converted once from the agency's total beans, so it
    # can never disagree with the sum of the per-host figures by a rounding step.
    billing_minor = _beans_to_minor(total_beans, rate)
    beans_earned = sum(int(r["beans"]) for r in earnings)

    warnings: list[str] = []
    if provisional:
        warnings.append(rate_note)
    if not hosts and beans_earned:
        warnings.append(
            f"This agency's hosts earned {beans_earned:,} beans in this period "
            "but cashed nothing out, so its billing is zero. Commission is "
            "earned when a host is paid, not when the beans are credited — this "
            "period genuinely bills nothing, and those beans will bill in the "
            "period they are cashed out."
        )

    return {
        "agency_id": agency_id,
        "since": since,
        "until": until,
        "bounds": "[since, until) — start inclusive, end exclusive",
        "definition": BILLING_DEFINITION,
        "basis": "host_cashouts",
        "beans_cashed_out": total_beans,
        "billing_minor": billing_minor,
        "billing_inr": billing_minor / MINOR_PER_MAJOR,
        "bean_to_inr": rate,
        "bean_rate_note": rate_note,
        "bean_rate_provisional": provisional,
        "hosts": hosts,
        "host_count": len(hosts),
        "beans_earned_not_cashed_out": beans_earned,
        "warnings": warnings,
    }


def _beans_to_minor(beans: int, bean_to_inr: float) -> int:
    """Beans → paise. The rate is a configured decimal like 0.01; it is taken
    through `Decimal` so 0.01 means one paisa and not 0.010000000000000000208."""
    return int(
        (Decimal(int(beans)) * Decimal(str(bean_to_inr)) * MINOR_PER_MAJOR).to_integral_value()
    )


async def _aggregate_hosts(
    agency_id: str,
    since: datetime,
    until: datetime,
    negative: bool,
    actions: Iterable[str] | None = None,
) -> list[dict]:
    from app.db.mongo import C, get_db
    from app.services.money import Currency, HolderType

    match: dict = {
        "holder_type": str(HolderType.USER),
        "currency": str(Currency.BEANS),
        "meta.agency_id": agency_id,
        "at": {"$gte": since, "$lt": until},
        "amount": {"$lt": 0} if negative else {"$gt": 0},
    }
    if actions:
        match["action"] = {"$in": list(actions)}

    pipeline = [
        {"$match": match},
        {
            "$group": {
                "_id": "$holder_id",
                "beans": {"$sum": {"$abs": "$amount"}},
                "movements": {"$sum": 1},
                "last_at": {"$max": "$at"},
            }
        },
        {"$sort": {"beans": -1}},
    ]
    return [row async for row in get_db()[C.LEDGER].aggregate(pipeline)]


# ── The whole computation, in one place ───────────────────────────────────────


async def compute_for_period(
    agency_id: str,
    period: str,
    since: datetime | None = None,
    until: datetime | None = None,
    partner: Mapping[str, Any] | None = None,
) -> dict:
    """Billing, band, commission and each host's share — the whole derivation.

    This is what the accrual endpoint credits and what the agency's statement
    shows. Nothing about the figure is left to the caller.
    """
    start, end, label = resolve_period(period, since, until)

    if partner is None:
        from app.db.mongo import C, get_db

        partner = await get_db()[C.PARTNERS].find_one({"_id": agency_id})
        if partner is None:
            raise CommissionError(
                f"No agency '{agency_id}'. Commission is not computed for an "
                "unknown partner."
            )

    kind = kind_of(partner)
    table = await load_slab_table(kind)
    billing = await agency_billing(agency_id, start, end)
    commission_minor, breakdown = commission_for(billing["billing_minor"], table.bands)

    shares = apportion(
        commission_minor, [h["beans_cashed_out"] for h in billing["hosts"]]
    )
    host_lines = [
        {
            **host,
            "share_minor": share,
            "share_inr": share / MINOR_PER_MAJOR,
            "share_note": (
                f"{host['beans_cashed_out']:,} of {billing['beans_cashed_out']:,} "
                f"beans cashed out ({_pct(host['beans_cashed_out'], billing['beans_cashed_out'])}"
                f"% of the agency's billing) — the band was chosen by the "
                "agency's total, and this is that commission's share, not a "
                "separate calculation."
            ),
        }
        for host, share in zip(billing["hosts"], shares)
    ]

    warnings = list(billing["warnings"])
    if table.provisional:
        warnings.append(table.note)

    return {
        "agency_id": agency_id,
        "agency_name": partner.get("name", ""),
        "agency_kind": str(kind),
        "period": label,
        "since": start,
        "until": end,
        "currency_unit": "INR minor units (paise)",
        "billing": billing,
        "slab_table": table.as_dict(),
        "breakdown": breakdown,
        "commission_minor": commission_minor,
        "commission_inr": commission_minor / MINOR_PER_MAJOR,
        "hosts": host_lines,
        "warnings": warnings,
        "provisional": table.provisional or billing["bean_rate_provisional"],
    }


def _pct(part: int, whole: int) -> str:
    if whole <= 0:
        return "0"
    return _trim(
        (Decimal(part) * 100 / Decimal(whole)).quantize(Decimal("0.001"))
    )
