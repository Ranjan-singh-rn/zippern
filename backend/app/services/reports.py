"""Reporting, export and the dashboard.

Three things are wrong with reporting today and all three are fixed here.

  * **No date filtering anywhere** (10.8). Every figure in this module is
    computed over an explicit half-open window ``[since, until)``, stated in the
    response, defaulted to the last 30 days and capped at 400 so nobody
    accidentally scans the entire ledger.
  * **No export at all** (10.9). Every report renders to CSV, and every export
    writes an ``audit.Action.EXPORT`` entry — who exported what, when (8A.5.4).
  * **"Total payout" means four different things on four pages** (10.7). There
    is now one definition of revenue, one of payout, one of margin, one of the
    bean-payout ratio, they live in ``DEFINITIONS`` below, and every report
    carries them in its own response so the number can never drift from its
    meaning again (8A.6.3).

Everything is computed server-side from the ledger, the cards and the audit log
with Mongo aggregation pipelines — never by pulling documents into Python and
adding them up (8A.6.4). Grouping and summing happen in the database; Python
only values a handful of already-aggregated groups at the rates in force.

A report that cannot be produced raises ``ReportError``. It never returns a
silent zero — a blank report that looks like real data is worse than an error
(8A.6.5).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

from pymongo.errors import PyMongoError

from app.core import audit
from app.core import roles as R
from app.core.roles import Role, Team
from app.db import firebase
from app.db.mongo import C, get_db
from app.services.cards import CardType, Stage
# The chance mechanics' own vocabulary, imported rather than restated. The
# ledger actions a stake and a payout are written under, the status a finished
# round carries and the three kinds a mechanic can be are all decided in
# `app/services/chance.py`; a second copy of any of those strings here is a
# place where the report and the mechanic would come to disagree about what a
# game round is. Nothing in this module writes to that module.
from app.services.chance import Act as ChanceAct
from app.services.chance import MechanicKind, RoundStatus
# The expense categories are the profit statement's own line keys, character for
# character. That is why there is no mapping table between the two: a table is a
# place where a category can be added on one side and forgotten on the other,
# and a forgotten category is a cost that silently leaves the profit figure.
from app.services.expenses import CATEGORY_LABELS, REPORTED_CATEGORIES, ExpenseCategory
# `rupee_text` groups a figure the Indian way — ₹15,00,000.00. Every explanation
# this module writes about a threshold or a shortfall is read by an Indian owner
# or an Indian host, so it is grouped the way they would write it themselves.
# It is the same renderer the commission engine uses, so a floor quoted here and
# a floor quoted on an agency statement cannot be formatted differently.
from app.services.commission import rupee_text
from app.services.money import Currency, HolderType
from app.services.partners import PartnerKind

log = logging.getLogger(__name__)


# ── Errors ────────────────────────────────────────────────────────────────────


class ReportError(Exception):
    """The report cannot be produced, and the caller is told why.

    Never swallowed into an empty result. Spec 8A.6.5.
    """

    status_code = 400


class DataUnavailable(ReportError):
    """The underlying store could not answer. Not the caller's fault."""

    status_code = 503


# ── Window ────────────────────────────────────────────────────────────────────

DEFAULT_WINDOW_DAYS = 30
MAX_WINDOW_DAYS = 400


def _utc(value: datetime) -> datetime:
    """Every comparison in this module is in UTC. Naive input is assumed UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def resolve_window(
    since: datetime | None, until: datetime | None
) -> tuple[datetime, datetime]:
    """Settle the reporting period. Half-open: ``since`` inclusive, ``until``
    exclusive, so consecutive periods never double-count a movement.

    Both omitted → the last 30 days. Anything wider than 400 days is refused
    rather than silently truncated.
    """
    now = datetime.now(timezone.utc)

    if since is None and until is None:
        return now - timedelta(days=DEFAULT_WINDOW_DAYS), now
    if since is None:
        until = _utc(until)  # type: ignore[arg-type]
        return until - timedelta(days=DEFAULT_WINDOW_DAYS), until
    if until is None:
        return _utc(since), now

    since, until = _utc(since), _utc(until)
    if since >= until:
        raise ReportError(
            f"The period start ({since.isoformat()}) must be before its end "
            f"({until.isoformat()})."
        )
    if (until - since) > timedelta(days=MAX_WINDOW_DAYS):
        raise ReportError(
            f"That period is {(until - since).days} days. Reports are capped at "
            f"{MAX_WINDOW_DAYS} days so a request cannot scan the whole ledger. "
            "Ask for a narrower range."
        )
    return since, until


def _period(since: datetime, until: datetime) -> dict:
    return {
        "since": since,
        "until": until,
        "days": round((until - since).total_seconds() / 86400, 2),
        "bounds": "[since, until) — start inclusive, end exclusive",
    }


def period_slug(since: datetime, until: datetime) -> str:
    """The date range as it appears in an export filename."""
    return f"{since.date().isoformat()}_to_{until.date().isoformat()}"


# ── Rates ─────────────────────────────────────────────────────────────────────
#
# Diamonds and beans only become money at a rate, and the rate lives in
# Firestore `appConfig/economy`. If it cannot be read the report still
# generates, at documented fallbacks, and says so — a caller must be able to
# tell a real figure from a provisional one.

DIAMONDS_PER_LAKH = 100_000

FALLBACK_DIAMOND_PACK_PRICE_INR = 2390.0   # per lakh diamonds
FALLBACK_BEAN_TO_INR = 0.01                # per bean


@dataclass(slots=True)
class Rates:
    #: What a **user** pays for a lakh of diamonds. The retail price.
    diamond_pack_price_inr_per_lakh: float
    #: What a **coin seller** pays us for a lakh of diamonds. The wholesale
    #: price, and the discount that makes reselling worth doing.
    #:
    #: This did not exist. There was one diamond price in the entire system —
    #: the retail one — so a seller buying at an agreed wholesale rate was
    #: checked against what their own customers pay, and the purchase was
    #: refused for a mismatch that was the whole point of the arrangement.
    #:
    #: Falls back to the retail price when unset, which is a discount of zero:
    #: honest, and it never blocks a purchase because somebody has not filled
    #: the field in yet.
    seller_wholesale_price_inr_per_lakh: float
    bean_to_inr: float
    source: str                 # "firestore" | "firestore_partial" | "fallback"
    provisional: bool           # True when any figure below used a fallback
    missing: list[str]
    note: str
    fetched_at: datetime

    @property
    def seller_margin_inr_per_lakh(self) -> float:
        """What a seller keeps on a lakh of diamonds, collected from the buyer.

        Zipper never handles it: the seller buys at wholesale, sells at retail
        and takes the difference directly. So it is not a payout, it never
        appears on the money board, and it costs the business nothing beyond
        the discount already given.
        """
        return max(
            0.0,
            self.diamond_pack_price_inr_per_lakh
            - self.seller_wholesale_price_inr_per_lakh,
        )

    def as_dict(self) -> dict:
        return {
            "diamond_pack_price_inr_per_lakh": self.diamond_pack_price_inr_per_lakh,
            "seller_wholesale_price_inr_per_lakh": self.seller_wholesale_price_inr_per_lakh,
            "seller_margin_inr_per_lakh": self.seller_margin_inr_per_lakh,
            "diamonds_per_lakh": DIAMONDS_PER_LAKH,
            "bean_to_inr": self.bean_to_inr,
            "source": self.source,
            "provisional": self.provisional,
            "missing": list(self.missing),
            "note": self.note,
            "fetched_at": self.fetched_at,
        }


def _fallback_rates(reason: str, missing: list[str]) -> Rates:
    return Rates(
        diamond_pack_price_inr_per_lakh=FALLBACK_DIAMOND_PACK_PRICE_INR,
        # No discount when nothing can be read. Assuming one would quietly
        # give away margin on every purchase during a Firestore outage.
        seller_wholesale_price_inr_per_lakh=FALLBACK_DIAMOND_PACK_PRICE_INR,
        bean_to_inr=FALLBACK_BEAN_TO_INR,
        source="fallback",
        provisional=True,
        missing=missing,
        note=(
            f"PROVISIONAL — {reason} Figures use the documented fallbacks "
            f"(₹{FALLBACK_DIAMOND_PACK_PRICE_INR:g} per lakh diamonds, "
            f"₹{FALLBACK_BEAN_TO_INR:g} per bean) and are not authoritative."
        ),
        fetched_at=datetime.now(timezone.utc),
    )


def _read_economy_doc() -> dict:
    """Blocking Firestore read, run off the event loop by `load_rates`."""
    snapshot = firebase.firestore_client().collection("appConfig").document(
        "economy"
    ).get()
    if not snapshot.exists:
        return {}
    return snapshot.to_dict() or {}


async def load_rates() -> Rates:
    """Read `appConfig/economy` once.

    The router exposes this as a FastAPI dependency, and FastAPI caches a
    dependency result for the life of one request — so a report that values
    diamonds and beans reads Firestore once, not once per figure.
    """
    try:
        data = await asyncio.to_thread(_read_economy_doc)
    except Exception as exc:  # noqa: BLE001 — a rate outage must not lose the report
        log.warning("Could not read appConfig/economy: %s", exc)
        return _fallback_rates(
            "the economy configuration could not be read from Firestore.",
            ["diamondPackPriceInr", "giftRates.beanToInrRate"],
        )

    missing: list[str] = []

    raw_diamond = data.get("diamondPackPriceInr")
    try:
        diamond = float(raw_diamond)
        if diamond <= 0:
            raise ValueError
    except (TypeError, ValueError):
        diamond = FALLBACK_DIAMOND_PACK_PRICE_INR
        missing.append("diamondPackPriceInr")

    # The wholesale price a coin seller pays. Absent means no discount — the
    # seller pays what a user pays — rather than a fallback that would invent
    # a margin nobody agreed to. It is deliberately NOT added to `missing`:
    # unset is a real, valid answer here, not a rate that failed to load, and
    # marking every report PROVISIONAL because a discount is not configured
    # would be false.
    raw_wholesale = data.get("sellerWholesalePriceInr")
    try:
        wholesale = float(raw_wholesale)
        if wholesale <= 0 or wholesale > diamond:
            # Above retail is not a discount, it is a typo. Refuse it rather
            # than charge a seller more than their own customers pay.
            raise ValueError
    except (TypeError, ValueError):
        wholesale = diamond

    gift_rates = data.get("giftRates") or {}
    raw_bean = gift_rates.get("beanToInrRate") if isinstance(gift_rates, Mapping) else None
    try:
        bean = float(raw_bean)
        if bean <= 0:
            raise ValueError
    except (TypeError, ValueError):
        bean = FALLBACK_BEAN_TO_INR
        missing.append("giftRates.beanToInrRate")

    if not missing:
        return Rates(
            diamond_pack_price_inr_per_lakh=diamond,
            seller_wholesale_price_inr_per_lakh=wholesale,
            bean_to_inr=bean,
            source="firestore",
            provisional=False,
            missing=[],
            note="Rates read from Firestore appConfig/economy.",
            fetched_at=datetime.now(timezone.utc),
        )

    if len(missing) == 2:
        return _fallback_rates(
            "appConfig/economy holds neither rate.", missing
        )

    return Rates(
        diamond_pack_price_inr_per_lakh=diamond,
        seller_wholesale_price_inr_per_lakh=wholesale,
        bean_to_inr=bean,
        source="firestore_partial",
        provisional=True,
        missing=missing,
        note=(
            "PROVISIONAL — missing from appConfig/economy: "
            f"{', '.join(missing)}. Those figures use the documented fallback."
        ),
        fetched_at=datetime.now(timezone.utc),
    )


async def _rates(rates: Rates | None) -> Rates:
    return rates if rates is not None else await load_rates()


# ── Valuation ─────────────────────────────────────────────────────────────────
#
# One rule for turning any tracked quantity into rupees. Amounts in the
# `commission` currency are already minor units (paise) — divide by 100 for
# display. Everything reported by this module is in INR **minor units** unless
# a field name says otherwise.

_MINOR_CURRENCIES = {"commission", "inr_minor", "paise"}
_MAJOR_CURRENCIES = {"inr", "rupee", "rupees", "rs"}
_DIAMOND_LIKE = {"diamonds", "coins"}


def to_inr_minor(
    amount: float, currency: str, rates: Rates, *, retail: bool = False
) -> tuple[int, str]:
    """Value `amount` of `currency` in INR minor units, with the rule applied.

    Returns (paise, explanation). An unknown currency raises rather than
    quietly contributing zero to a total.

    ── Which diamond price ──────────────────────────────────────────────────
    Diamonds are valued at the **wholesale** price by default, and that is the
    right default rather than a cautious one.

    This product has no direct recharge path — no gateway and no in-app billing
    writes anywhere, a fact `weekly_money_in` states as a structural zero. Every
    diamond a user holds was therefore bought from a coin seller, and Zipper
    received the wholesale price for it. The retail price is what the seller's
    customer paid the seller; the difference never touches this business.

    Valuing consumed diamonds at retail claimed income Zipper never collected —
    about 19.5% of it — and it flowed into revenue, profit, margin and the
    bean-payout ratio. That last one is the worst of the four: the ratio is
    payouts over diamond value, the code itself says "lower is better", and an
    inflated denominator made the business look *more* profitable than it is on
    the metric it uses to judge itself.

    `retail=True` is for the few places where the question genuinely is what a
    *user* paid, rather than what Zipper received.
    """
    c = str(currency or "").strip().lower()

    if c in _MINOR_CURRENCIES:
        return int(round(amount)), "already INR minor units (paise), 1:1"
    if c in _MAJOR_CURRENCIES:
        return int(round(amount * 100)), "INR major units × 100"
    if c in _DIAMOND_LIKE:
        rate = (
            rates.diamond_pack_price_inr_per_lakh
            if retail
            else rates.seller_wholesale_price_inr_per_lakh
        )
        label = "retail" if retail else "wholesale"
        return (
            int(round(amount / DIAMONDS_PER_LAKH * rate * 100)),
            f"₹{rate:g} per {DIAMONDS_PER_LAKH:,} {c} ({label})",
        )
    if c == str(Currency.BEANS):
        return (
            int(round(amount * rates.bean_to_inr * 100)),
            f"₹{rates.bean_to_inr:g} per bean",
        )

    raise ReportError(
        f"No INR rate is defined for the currency '{currency}'. The report is "
        "withheld rather than reported with that value missing from the total."
    )


def inr(minor: int | float | None) -> float | None:
    """Minor units → rupees, for display. Spec: commission is paise."""
    if minor is None:
        return None
    return round(minor / 100, 2)


# ── The one definition of each figure ─────────────────────────────────────────

DEFINITIONS: dict[str, str] = {
    "revenue": (
        "Cash actually received in the period. A receipt is a positive ledger "
        "movement whose action is a credit or inventory purchase AND which "
        "carries cash evidence (meta.cash_minor, meta.amount_inr_minor, "
        "meta.gateway, meta.utr, meta.payment_ref or meta.channel). Its value "
        "is meta.cash_minor / meta.amount_inr_minor where recorded, otherwise "
        "the movement converted at the stated rate. Credits without cash "
        "evidence — promotions, corrections, game winnings — are reported "
        "separately as non-cash credits and are never counted as revenue. "
        "This is the daily cash position, not imputed diamond consumption "
        "(9.43)."
    ),
    "payout": (
        "Value that actually left the business: cards in stage 'executed' with "
        "executed_at inside the period, of a payout type (commission_payout, "
        "subagency_payout, host_withdrawal, weekly_payout, salary_request). "
        "Signed-but-not-executed is not a payout; a failed execution is not a "
        "payout. One definition, replacing the four that disagreed (10.7)."
    ),
    "commission": (
        "Accrued = positive movements on an agency's commission balance in the "
        "period. Paid = negative movements. Amounts in the commission currency "
        "are minor units (paise) — divide by 100 for display."
    ),
    "margin": (
        "net_margin = revenue − payouts − (commission accrued − commission "
        "paid). Payouts already contain the commission that was actually paid; "
        "the bracket is the change in what is still owed, so commission is "
        "recognised when earned and counted exactly once."
    ),
    "bean_payout_ratio": (
        "Cash out as a share of diamond value consumed: INR value of beans "
        "that became payouts ÷ INR value of diamonds consumed by users in the "
        "period. Returned diamonds are recirculated inventory and are not a "
        "cost; only beans become cash. This is the real profitability measure "
        "for this business (8B.8.2 / 8B.8.5). Lower is better."
    ),
    "channel": (
        "reseller = the movement is a seller's, or meta.channel says so. "
        "direct = meta.channel says so, or the movement carries a gateway "
        "reference. Anything else is reported as 'unattributed' and never "
        "folded into either channel (8A.6.2 / 9.13)."
    ),
    "currency": (
        "Every money figure in this report is INR minor units (paise) unless "
        "the field name states another unit. Divide by 100 for rupees."
    ),
}


def _definitions(*keys: str) -> dict:
    return {k: DEFINITIONS[k] for k in keys}


# ── The report envelope ───────────────────────────────────────────────────────


@dataclass(slots=True)
class Report:
    """One shape for every report, so JSON and CSV can never disagree.

    `rows` + `columns` are the exportable table; `totals` is the roll-up;
    `sections` is used only by the dashboard, which is not tabular.
    """

    name: str
    title: str
    period: dict
    columns: list[tuple[str, str]]
    rows: list[dict]
    totals: dict = field(default_factory=dict)
    definitions: dict = field(default_factory=dict)
    rates: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    sections: dict = field(default_factory=dict)
    empty_override: bool = False
    generated_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def as_dict(self) -> dict:
        out = {
            "report": self.name,
            "title": self.title,
            "generated_at": self.generated_at,
            "period": self.period,
            "currency_unit": "INR minor units (paise) unless stated otherwise",
            "rates": self.rates,
            "definitions": self.definitions,
            "columns": [{"key": k, "header": h} for k, h in self.columns],
            "rows": self.rows,
            "totals": self.totals,
            "warnings": self.warnings,
            "empty": self.empty_override or not self.rows,
        }
        if self.sections:
            out["sections"] = self.sections
        return out

    def csv(self) -> str:
        return to_csv(self.rows, self.columns)

    def filename(self) -> str:
        span = self.period.get("since"), self.period.get("until")
        if isinstance(span[0], datetime) and isinstance(span[1], datetime):
            return f"{self.name}_{period_slug(span[0], span[1])}.csv"
        return f"{self.name}_{datetime.now(timezone.utc).date().isoformat()}.csv"

    def note_if_empty(self, message: str) -> None:
        """An empty period is a legitimate answer, but it is never allowed to
        look like a real figure."""
        if not self.rows:
            self.warnings.append(message)

    def mark_empty(self, message: str) -> None:
        """For a report that always emits a total line: the rows exist, but
        there was nothing behind them. Say so, or the zeroes read as facts."""
        self.empty_override = True
        self.warnings.append(message)


# ── CSV ───────────────────────────────────────────────────────────────────────

_QUOTE_TRIGGERS = (",", '"', "\n", "\r")


def _cell(value: Any) -> str:
    """One value, rendered for a spreadsheet."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return _utc(value).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        # Avoid 0.30000000000000004 in an exported column.
        text = f"{value:.6f}".rstrip("0").rstrip(".")
        return text or "0"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, default=str, separators=(",", ":"))
    return str(value)


def _quote(text: str) -> str:
    needs = any(t in text for t in _QUOTE_TRIGGERS) or text != text.strip()
    if not needs:
        return text
    return '"' + text.replace('"', '""') + '"'


def to_csv(
    rows: Iterable[Mapping[str, Any]],
    columns: Sequence[str] | Sequence[tuple[str, str]] | None = None,
) -> str:
    """Correct CSV, RFC 4180.

    * a header row is always written
    * a field containing a comma, a quote, CR or LF is quoted
    * an embedded quote is escaped by doubling it
    * None is an empty field — not the text "None"
    * leading or trailing whitespace is preserved by quoting
    * rows are CRLF-terminated, including the last

    `columns` may be keys, or (key, header) pairs. Omitted, the keys of the
    supplied rows are used in order of first appearance.
    """
    rows = list(rows)

    pairs: list[tuple[str, str]] = []
    if columns:
        for col in columns:
            if isinstance(col, str):
                pairs.append((col, col))
            else:
                key, header = col
                pairs.append((str(key), str(header)))
    else:
        seen: dict[str, None] = {}
        for row in rows:
            for key in row:
                seen.setdefault(str(key), None)
        pairs = [(k, k) for k in seen]

    out: list[str] = [",".join(_quote(_cell(h)) for _, h in pairs)]
    for row in rows:
        out.append(",".join(_quote(_cell(row.get(k))) for k, _ in pairs))
    return "\r\n".join(out) + "\r\n"


# ── Mongo helpers ─────────────────────────────────────────────────────────────


def _db():
    try:
        return get_db()
    except RuntimeError as exc:
        raise DataUnavailable(
            "The reporting database is not connected, so no figure can be "
            "produced. Nothing is reported as zero."
        ) from exc


async def _aggregate(collection: str, pipeline: list[dict]) -> list[dict]:
    """Run one pipeline. Grouping and summing happen here, in the database."""
    try:
        cursor = _db()[collection].aggregate(pipeline, allowDiskUse=True)
        return [doc async for doc in cursor]
    except PyMongoError as exc:
        raise DataUnavailable(
            f"The '{collection}' aggregation could not be completed: {exc}. "
            "No partial figure is returned."
        ) from exc


async def _count(collection: str, query: dict) -> int:
    try:
        return await _db()[collection].count_documents(query)
    except PyMongoError as exc:
        raise DataUnavailable(f"Could not count '{collection}': {exc}") from exc


async def _find_one(collection: str, query: dict, sort: list | None = None) -> dict | None:
    try:
        return await _db()[collection].find_one(query, sort=sort)
    except PyMongoError as exc:
        raise DataUnavailable(f"Could not read '{collection}': {exc}") from exc


def _present(path: str) -> dict:
    """Aggregation expression: this field exists and is not null."""
    return {"$not": [{"$in": [{"$type": f"${path}"}, ["missing", "null"]]}]}


# ── Ledger classification ─────────────────────────────────────────────────────

RECEIPT_ACTIONS = [
    audit.Action.BALANCE_CREDIT,
    audit.Action.INVENTORY_CREDIT,
    audit.Action.LENDING_REPAY,
]

PAYOUT_CARD_TYPES = [
    str(CardType.COMMISSION_PAYOUT),
    str(CardType.SUBAGENCY_PAYOUT),
    str(CardType.HOST_WITHDRAWAL),
    str(CardType.WEEKLY_PAYOUT),
    str(CardType.SALARY_REQUEST),
]

BEAN_PAYOUT_ACTIONS = [audit.Action.PAYOUT_EXECUTE, audit.Action.WITHDRAWAL_PAY]

CASH_EVIDENCE_FIELDS = [
    "cash_minor",
    "amount_inr_minor",
    "gateway",
    "utr",
    "payment_ref",
    "channel",
]

CHANNEL_RESELLER = "reseller"
CHANNEL_DIRECT = "direct"
CHANNEL_UNATTRIBUTED = "unattributed"

_CHANNEL_EXPR = {
    "$switch": {
        "branches": [
            {
                "case": {"$in": ["$meta.channel", [CHANNEL_DIRECT, CHANNEL_RESELLER]]},
                "then": "$meta.channel",
            },
            {
                "case": {"$eq": ["$holder_type", str(HolderType.SELLER)]},
                "then": CHANNEL_RESELLER,
            },
            {"case": _present("meta.gateway"), "then": CHANNEL_DIRECT},
        ],
        "default": CHANNEL_UNATTRIBUTED,
    }
}

#: The rupees a movement actually brought in, read from whichever field the
#: writer used — **or null when none of them did**, which is what sends the row
#: down the "value it at a rate" path.
#:
#: `amount_paid_minor` was missing from this list, and its absence is the reason
#: every revenue figure in this system has been imputed rather than counted.
#:
#: `execute_coin_purchase` records what a seller actually paid under
#: `meta.amount_paid_minor` (`partner_ops.py`), and a coin purchase is the ONLY
#: point at which cash genuinely enters this business. Nothing anywhere writes
#: `cash_minor` or `amount_inr_minor` onto a ledger movement — I checked every
#: writer in the backend, the CRM and the Functions. So the two names looked for
#: here never matched anything, `_cash` resolved to null on every row, and the
#: whole coin amount fell through to `to_inr_minor()`.
#:
#: The row was still admitted as revenue, because `payment_ref` is in
#: `CASH_EVIDENCE_FIELDS` and that is what decides admission. So revenue was
#: reported as *coins × the retail diamond price* — the price the seller's own
#: customers pay — while the amount the seller actually transferred sat in the
#: same document, unread.
#:
#: That was wrong before the wholesale price existed and it is wronger now: at
#: ₹2,390 retail against ₹2,000 wholesale it overstates receipts by 19.5%, and
#: that number is the top line of the weekly P&L.
#:
#: Reading the recorded amount also fixes the case a rate can never fix — a
#: seller who paid a different agreed sum, which `request_coin_purchase` permits
#: with a stated reason. What they paid is a fact. It is on the card. Use it.
_CASH_MINOR_EXPR = {
    "$ifNull": [
        "$meta.cash_minor",
        {
            "$ifNull": [
                "$meta.amount_inr_minor",
                {"$ifNull": ["$meta.amount_paid_minor", None]},
            ]
        },
    ]
}

_HAS_CASH_EVIDENCE = {"$or": [_present(f"meta.{f}") for f in CASH_EVIDENCE_FIELDS]}


def _receipt_pipeline(since: datetime, until: datetime, extra_group: dict | None = None) -> list[dict]:
    group_id: dict = {"channel": "$_channel", "currency": "$currency", "cash": "$_evidence"}
    if extra_group:
        group_id.update(extra_group)
    return [
        {
            "$match": {
                "at": {"$gte": since, "$lt": until},
                "amount": {"$gt": 0},
                "action": {"$in": RECEIPT_ACTIONS},
            }
        },
        {
            "$addFields": {
                "_channel": _CHANNEL_EXPR,
                "_cash": _CASH_MINOR_EXPR,
                "_evidence": _HAS_CASH_EVIDENCE,
            }
        },
        {
            "$group": {
                "_id": group_id,
                "recorded_inr_minor": {
                    "$sum": {"$cond": [{"$ne": ["$_cash", None]}, "$_cash", 0]}
                },
                "unvalued_amount": {
                    "$sum": {"$cond": [{"$eq": ["$_cash", None]}, "$amount", 0]}
                },
                "movements": {"$sum": 1},
            }
        },
    ]


def _value_receipt_groups(
    groups: list[dict], rates: Rates
) -> tuple[dict[Any, dict], dict, list[str]]:
    """Turn aggregated receipt groups into INR, keyed by the group id.

    Returns (by_key, non_cash_summary, warnings). Nothing without cash evidence
    is ever added to a revenue total.
    """
    by_key: dict[Any, dict] = {}
    non_cash: dict[str, Any] = {"movements": 0, "by_currency": {}}
    warnings: list[str] = []

    for row in groups:
        gid = dict(row["_id"])
        has_cash = bool(gid.pop("cash", False))
        currency = gid.get("currency", "")

        if not has_cash:
            non_cash["movements"] += row["movements"]
            bucket = non_cash["by_currency"].setdefault(
                currency, {"amount": 0, "movements": 0}
            )
            bucket["amount"] += row["unvalued_amount"]
            bucket["movements"] += row["movements"]
            continue

        converted, rule = to_inr_minor(row["unvalued_amount"], currency, rates)
        key = tuple(sorted((k, v) for k, v in gid.items() if k != "currency"))
        entry = by_key.setdefault(
            key,
            {
                **{k: v for k, v in gid.items() if k != "currency"},
                "recorded_inr_minor": 0,
                "converted_inr_minor": 0,
                "receipts_inr_minor": 0,
                "movements": 0,
                "valuation": [],
            },
        )
        entry["recorded_inr_minor"] += int(row["recorded_inr_minor"])
        entry["converted_inr_minor"] += converted
        entry["receipts_inr_minor"] += int(row["recorded_inr_minor"]) + converted
        entry["movements"] += row["movements"]
        if converted and rule not in entry["valuation"]:
            entry["valuation"].append(f"{currency}: {rule}")

    if non_cash["movements"]:
        detail = ", ".join(
            f"{v['movements']} × {k} ({v['amount']:,})"
            for k, v in non_cash["by_currency"].items()
        )
        warnings.append(
            f"{non_cash['movements']} credit(s) in this period carry no cash "
            f"evidence and are excluded from revenue: {detail}. They are "
            "promotions, corrections or winnings, not money received."
        )

    for entry in by_key.values():
        entry["valuation"] = "; ".join(entry["valuation"]) or "recorded cash amounts"

    return by_key, non_cash, warnings


async def _executed_payouts(
    since: datetime, until: datetime, rates: Rates
) -> tuple[list[dict], int, list[str]]:
    """Payouts by card type — the single definition of money that left."""
    groups = await _aggregate(
        C.CARDS,
        [
            {
                "$match": {
                    "stage": str(Stage.EXECUTED),
                    "executed_at": {"$gte": since, "$lt": until},
                    "type": {"$in": PAYOUT_CARD_TYPES},
                }
            },
            {
                "$group": {
                    "_id": {"type": "$type", "currency": "$currency"},
                    "amount": {"$sum": {"$abs": "$amount"}},
                    "cards": {"$sum": 1},
                }
            },
            {"$sort": {"amount": -1}},
        ],
    )

    rows: list[dict] = []
    total = 0
    warnings: list[str] = []
    for row in groups:
        currency = row["_id"].get("currency", "")
        minor, rule = to_inr_minor(row["amount"], currency, rates)
        total += minor
        rows.append(
            {
                "card_type": row["_id"].get("type", ""),
                "currency": currency,
                "amount_native": row["amount"],
                "inr_minor": minor,
                "inr": inr(minor),
                "cards": row["cards"],
                "rate_applied": rule,
            }
        )

    stuck = await _count(
        C.CARDS,
        {
            "stage": {"$in": [str(Stage.APPROVED), str(Stage.FAILED)]},
            "type": {"$in": PAYOUT_CARD_TYPES},
            "signed_at": {"$gte": since, "$lt": until},
        },
    )
    if stuck:
        warnings.append(
            f"{stuck} signed payout card(s) in this period are approved or "
            "failed but not executed. They are deliberately excluded — money "
            "that has not left is not a payout."
        )

    return rows, total, warnings


#: Stages an expense card sits in while the money has *not* yet left. Counted
#: and reported, never subtracted — see `_expenditure_by_category`.
UNPAID_EXPENSE_STAGES = [
    str(Stage.REQUESTED),
    str(Stage.UNDER_REVIEW),
    str(Stage.AWAITING_SIGNOFF),
    str(Stage.APPROVED),
]


async def _expenditure_by_category(
    since: datetime, until: datetime, rates: Rates
) -> tuple[dict[str, dict], list[str]]:
    """Recorded operating cost for the window, grouped by expense category.

    **Cash basis, deliberately.** An expense counts in the period the money left
    — `executed_at` — exactly as revenue counts in the period the money arrived.
    The card's own `payload.period` is the month the cost is *for*, and it is
    reported beside the figure so that July's salary paid in August is visible
    as such; it never moves a rupee between periods. The owner reads a cash
    statement, and quietly accruing underneath it would change what his number
    means without telling him.

    A card that has been raised, verified, even signed, but not executed, has not
    cost the business anything yet. Those are counted and named in a warning
    rather than subtracted — the same rule `_executed_payouts` applies to a
    signed-but-unexecuted payout, for the same reason.
    """
    groups = await _aggregate(
        C.CARDS,
        [
            {
                "$match": {
                    "type": str(CardType.OPERATING_EXPENSE),
                    "stage": str(Stage.EXECUTED),
                    "executed_at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$group": {
                    "_id": {
                        "category": "$payload.category",
                        "currency": "$currency",
                    },
                    "amount": {"$sum": "$amount"},
                    "cards": {"$sum": 1},
                    "periods": {"$addToSet": "$payload.period"},
                }
            },
        ],
    )

    out: dict[str, dict] = {}
    warnings: list[str] = []
    stray: dict[str, int] = {}

    for row in groups:
        raw = str((row["_id"] or {}).get("category") or "")
        currency = str((row["_id"] or {}).get("currency") or "")
        # An unknown currency raises rather than contributing zero, which is the
        # rule everywhere in this module.
        minor, rule = to_inr_minor(row["amount"], currency, rates)

        key = raw
        if raw not in {str(c) for c in ExpenseCategory}:
            # Only reachable by writing to Mongo behind the service, which
            # validates the category. Fold it into `other` so the money is still
            # subtracted — dropping it would inflate the profit — and say loudly
            # where it went.
            stray[raw or "(blank)"] = stray.get(raw or "(blank)", 0) + minor
            key = str(ExpenseCategory.OTHER)

        entry = out.setdefault(
            key,
            {"inr_minor": 0, "cards": 0, "periods": [], "rates_applied": []},
        )
        entry["inr_minor"] += minor
        entry["cards"] += int(row.get("cards") or 0)
        for label in row.get("periods") or []:
            if label and label not in entry["periods"]:
                entry["periods"].append(str(label))
        if rule not in entry["rates_applied"]:
            entry["rates_applied"].append(rule)

    for entry in out.values():
        entry["periods"].sort()
        entry["inr"] = inr(entry["inr_minor"])

    if stray:
        detail = ", ".join(
            f"{name} ({inr(amount)})" for name, amount in sorted(stray.items())
        )
        warnings.append(
            f"{len(stray)} executed expense card(s) carry a category this "
            f"report does not know: {detail}. They ARE subtracted, counted "
            "under 'other operating expenditure', because dropping them would "
            "make the profit look larger than it is. Fix the category on the "
            "card so the cost appears on its own line."
        )

    unpaid = await _count(
        C.CARDS,
        {
            "type": str(CardType.OPERATING_EXPENSE),
            "stage": {"$in": UNPAID_EXPENSE_STAGES},
            "created_at": {"$gte": since, "$lt": until},
        },
    )
    if unpaid:
        warnings.append(
            f"{unpaid} expense card(s) raised in this period have not been paid "
            "yet. This statement is on a CASH basis — a cost counts when the "
            "money leaves — so those are deliberately not subtracted here and "
            "will appear in the period they are actually paid. They are real "
            "obligations all the same; the figure below is this period's cash, "
            "not this period's accrued cost."
        )

    return out, warnings


# ══════════════════════════════════════════════════════════════════════════════
#  MONEY REPORTING
# ══════════════════════════════════════════════════════════════════════════════


async def cash_position(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Receipts by channel, payments out, net. Spec 8A.3.1 / 9.43.

    The real revenue number: money actually received, as distinct from imputed
    diamond consumption.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    groups = await _aggregate(C.LEDGER, _receipt_pipeline(since, until))
    by_channel, non_cash, warnings = _value_receipt_groups(groups, rt)

    rows: list[dict] = []
    receipts_total = 0
    for key in sorted(by_channel, key=lambda k: dict(k).get("channel", "")):
        entry = by_channel[key]
        receipts_total += entry["receipts_inr_minor"]
        rows.append(
            {
                "line": "receipt",
                "channel": entry.get("channel", CHANNEL_UNATTRIBUTED),
                "detail": entry["valuation"],
                "movements": entry["movements"],
                "inr_minor": entry["receipts_inr_minor"],
                "inr": inr(entry["receipts_inr_minor"]),
            }
        )

    payout_rows, payouts_total, payout_warnings = await _executed_payouts(
        since, until, rt
    )
    warnings.extend(payout_warnings)
    for row in payout_rows:
        rows.append(
            {
                "line": "payment_out",
                "channel": row["card_type"],
                "detail": f"{row['amount_native']:,} {row['currency']} — {row['rate_applied']}",
                "movements": row["cards"],
                "inr_minor": -row["inr_minor"],
                "inr": inr(-row["inr_minor"]),
            }
        )

    net = receipts_total - payouts_total
    rows.extend(
        [
            {
                "line": "total_receipts",
                "channel": "all",
                "detail": "cash in",
                "movements": sum(e["movements"] for e in by_channel.values()),
                "inr_minor": receipts_total,
                "inr": inr(receipts_total),
            },
            {
                "line": "total_payments_out",
                "channel": "all",
                "detail": "executed payout cards",
                "movements": sum(r["cards"] for r in payout_rows),
                "inr_minor": -payouts_total,
                "inr": inr(-payouts_total),
            },
            {
                "line": "net_cash_position",
                "channel": "all",
                "detail": "receipts − payments out",
                "movements": None,
                "inr_minor": net,
                "inr": inr(net),
            },
        ]
    )

    report = Report(
        name="cash_position",
        title="Cash position",
        period=_period(since, until),
        columns=[
            ("line", "Line"),
            ("channel", "Channel / type"),
            ("detail", "Detail"),
            ("movements", "Items"),
            ("inr_minor", "INR (minor units)"),
            ("inr", "INR"),
        ],
        rows=rows,
        totals={
            "receipts_inr_minor": receipts_total,
            "payments_out_inr_minor": payouts_total,
            "net_inr_minor": net,
            "net_inr": inr(net),
            "receipts_by_channel": {
                dict(k).get("channel", CHANNEL_UNATTRIBUTED): v["receipts_inr_minor"]
                for k, v in by_channel.items()
            },
            "non_cash_credits_excluded": non_cash,
        },
        definitions=_definitions("revenue", "payout", "channel", "currency"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    if not by_channel and not payout_rows:
        report.mark_empty(
            "No receipt and no executed payout falls in this period. The "
            "totals below are zero because nothing happened, not because "
            "money was counted and came to nothing — this is an empty period."
        )
    return report


_GROUP_UNITS = {"day": "day", "week": "week", "month": "month"}


async def revenue_summary(
    since: datetime | None = None,
    until: datetime | None = None,
    group_by: str = "day",
    rates: Rates | None = None,
) -> Report:
    """Revenue over time, bucketed in the database with $dateTrunc.

    Answers "how much money came in this week", which nothing can answer today
    (10.8).
    """
    unit = _GROUP_UNITS.get(str(group_by).lower())
    if unit is None:
        raise ReportError(
            f"group_by must be one of day, week, month — not '{group_by}'."
        )

    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    bucket = {
        "$dateTrunc": {
            "date": "$at",
            "unit": unit,
            "timezone": "UTC",
            **({"startOfWeek": "monday"} if unit == "week" else {}),
        }
    }
    pipeline = _receipt_pipeline(since, until, {"bucket": "$_bucket"})
    pipeline[1]["$addFields"]["_bucket"] = bucket
    pipeline.append({"$sort": {"_id.bucket": 1}})

    groups = await _aggregate(C.LEDGER, pipeline)
    by_key, non_cash, warnings = _value_receipt_groups(groups, rt)

    rows: list[dict] = []
    per_channel: dict[str, int] = {}
    total = 0
    for key in sorted(
        by_key,
        key=lambda k: (dict(k).get("bucket") or datetime.min.replace(tzinfo=timezone.utc), dict(k).get("channel", "")),
    ):
        entry = by_key[key]
        starts = entry.get("bucket")
        channel = entry.get("channel", CHANNEL_UNATTRIBUTED)
        total += entry["receipts_inr_minor"]
        per_channel[channel] = per_channel.get(channel, 0) + entry["receipts_inr_minor"]
        rows.append(
            {
                "period_start": starts,
                "period_label": _bucket_label(starts, unit),
                "channel": channel,
                "movements": entry["movements"],
                "revenue_inr_minor": entry["receipts_inr_minor"],
                "revenue_inr": inr(entry["receipts_inr_minor"]),
                "valuation": entry["valuation"],
            }
        )

    report = Report(
        name=f"revenue_{unit}",
        title=f"Revenue by {unit}",
        period=_period(since, until),
        columns=[
            ("period_label", unit.capitalize()),
            ("period_start", "Period start (UTC)"),
            ("channel", "Channel"),
            ("movements", "Receipts"),
            ("revenue_inr_minor", "Revenue (INR minor units)"),
            ("revenue_inr", "Revenue (INR)"),
            ("valuation", "Rate applied"),
        ],
        rows=rows,
        totals={
            "group_by": unit,
            "revenue_inr_minor": total,
            "revenue_inr": inr(total),
            "by_channel": per_channel,
            "buckets": len({dict(k).get("bucket") for k in by_key}),
            "non_cash_credits_excluded": non_cash,
        },
        definitions=_definitions("revenue", "channel", "currency"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    report.note_if_empty("No cash receipts fall in this period.")
    return report


def _bucket_label(start: datetime | None, unit: str) -> str:
    if not isinstance(start, datetime):
        return ""
    start = _utc(start)
    if unit == "month":
        return start.strftime("%Y-%m")
    if unit == "week":
        iso = start.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    return start.date().isoformat()


async def payout_summary(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """One definition of payout: value that actually left, from executed cards.

    This is 10.7 closed — the four disagreeing "total payout" figures collapse
    into this one.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    rows, total, warnings = await _executed_payouts(since, until, rt)

    report = Report(
        name="payouts",
        title="Payouts — value that actually left",
        period=_period(since, until),
        columns=[
            ("card_type", "Card type"),
            ("currency", "Currency"),
            ("amount_native", "Amount (native units)"),
            ("cards", "Cards executed"),
            ("inr_minor", "Payout (INR minor units)"),
            ("inr", "Payout (INR)"),
            ("rate_applied", "Rate applied"),
        ],
        rows=rows,
        totals={
            "payouts_inr_minor": total,
            "payouts_inr": inr(total),
            "cards_executed": sum(r["cards"] for r in rows),
            "by_card_type": {r["card_type"]: r["inr_minor"] for r in rows},
        },
        definitions=_definitions("payout", "currency"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    report.note_if_empty("No payout card was executed in this period.")
    return report


async def _commission_movement(since: datetime, until: datetime) -> dict:
    """Commission accrued and paid in the period, in paise."""
    groups = await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "holder_type": str(HolderType.AGENCY),
                    "currency": str(Currency.COMMISSION),
                    "at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$group": {
                    "_id": None,
                    "accrued": {
                        "$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}
                    },
                    "paid": {
                        "$sum": {"$cond": [{"$lt": ["$amount", 0]}, {"$abs": "$amount"}, 0]}
                    },
                    "movements": {"$sum": 1},
                    "agencies": {"$addToSet": "$holder_id"},
                }
            },
            {
                "$project": {
                    "accrued": 1,
                    "paid": 1,
                    "movements": 1,
                    "agencies": {"$size": "$agencies"},
                }
            },
        ],
    )
    if not groups:
        return {"accrued": 0, "paid": 0, "movements": 0, "agencies": 0}
    row = groups[0]
    row.pop("_id", None)
    return row


async def _bean_and_diamond_flow(since: datetime, until: datetime) -> dict:
    """Diamonds consumed, beans created, beans paid out — all in native units."""
    groups = await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "at": {"$gte": since, "$lt": until},
                    "holder_type": str(HolderType.USER),
                    "currency": {"$in": [str(Currency.DIAMONDS), str(Currency.BEANS)]},
                }
            },
            {
                "$group": {
                    "_id": "$currency",
                    "credited": {
                        "$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}
                    },
                    "debited": {
                        "$sum": {"$cond": [{"$lt": ["$amount", 0]}, {"$abs": "$amount"}, 0]}
                    },
                    "paid_out": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$and": [
                                        {"$lt": ["$amount", 0]},
                                        {"$in": ["$action", BEAN_PAYOUT_ACTIONS]},
                                    ]
                                },
                                {"$abs": "$amount"},
                                0,
                            ]
                        }
                    },
                    "movements": {"$sum": 1},
                }
            },
        ],
    )
    out = {
        str(Currency.DIAMONDS): {"credited": 0, "debited": 0, "paid_out": 0, "movements": 0},
        str(Currency.BEANS): {"credited": 0, "debited": 0, "paid_out": 0, "movements": 0},
    }
    for row in groups:
        out[row["_id"]] = {
            "credited": row["credited"],
            "debited": row["debited"],
            "paid_out": row["paid_out"],
            "movements": row["movements"],
        }
    return out


async def margin_report(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Revenue, payouts, commission, net margin and the bean-payout ratio.

    Spec 8A.3.9 (monthly P&L) and 8B.8.5. The bean-payout ratio is the number
    that governs profitability here — diamonds returned to a player are
    recirculated inventory, only beans become cash.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    cash = await cash_position(since, until, rt)
    revenue = cash.totals["receipts_inr_minor"]
    payouts = cash.totals["payments_out_inr_minor"]

    commission = await _commission_movement(since, until)
    accrued = int(commission["accrued"])          # already paise
    paid = int(commission["paid"])
    liability_change = accrued - paid

    flow = await _bean_and_diamond_flow(since, until)
    diamonds_consumed = flow[str(Currency.DIAMONDS)]["debited"]
    beans_created = flow[str(Currency.BEANS)]["credited"]
    beans_paid_out = flow[str(Currency.BEANS)]["paid_out"]

    diamond_value, diamond_rule = to_inr_minor(
        diamonds_consumed, str(Currency.DIAMONDS), rt
    )
    bean_value, bean_rule = to_inr_minor(beans_paid_out, str(Currency.BEANS), rt)

    net_margin = revenue - payouts - liability_change

    warnings = list(cash.warnings)
    if diamond_value > 0:
        ratio = round(bean_value / diamond_value, 6)
        ratio_pct = round(ratio * 100, 3)
    else:
        ratio = None
        ratio_pct = None
        warnings.append(
            "No diamond consumption in this period, so the bean-payout ratio "
            "is undefined. It is reported as null, never as zero — a zero "
            "would read as perfect margin."
        )

    margin_pct = round(net_margin / revenue * 100, 3) if revenue else None
    if revenue == 0:
        warnings.append(
            "Revenue is zero for this period, so margin percentage is "
            "undefined and reported as null."
        )

    rows = [
        _metric("revenue", revenue, "inr_minor", "Cash received (see definition)"),
        _metric("payouts", payouts, "inr_minor", "Executed payout cards"),
        _metric("commission_accrued", accrued, "inr_minor", "Earned by agencies in period"),
        _metric("commission_paid", paid, "inr_minor", "Settled to agencies in period"),
        _metric(
            "commission_liability_change",
            liability_change,
            "inr_minor",
            "Accrued − paid; the new obligation created this period",
        ),
        _metric(
            "net_margin",
            net_margin,
            "inr_minor",
            "revenue − payouts − commission liability change",
        ),
        _metric("net_margin_pct_of_revenue", margin_pct, "percent", "null when revenue is zero"),
        _metric(
            "diamond_value_consumed",
            diamond_value,
            "inr_minor",
            f"{diamonds_consumed:,} diamonds @ {diamond_rule}",
        ),
        _metric(
            "bean_payout_value",
            bean_value,
            "inr_minor",
            f"{beans_paid_out:,} beans paid out @ {bean_rule}",
        ),
        _metric(
            "beans_created",
            beans_created,
            "beans",
            "Future cash liability created this period",
        ),
        _metric(
            "bean_payout_ratio",
            ratio,
            "ratio",
            "Cash out ÷ diamond value consumed. Lower is better (8B.8.5)",
        ),
        _metric("bean_payout_ratio_pct", ratio_pct, "percent", "The same figure as a percentage"),
    ]

    report = Report(
        name="margin",
        title="Margin and bean-payout ratio",
        period=_period(since, until),
        columns=[
            ("metric", "Metric"),
            ("value", "Value"),
            ("unit", "Unit"),
            ("value_inr", "INR"),
            ("note", "Note"),
        ],
        rows=rows,
        totals={
            "revenue_inr_minor": revenue,
            "payouts_inr_minor": payouts,
            "commission_accrued_inr_minor": accrued,
            "commission_paid_inr_minor": paid,
            "net_margin_inr_minor": net_margin,
            "net_margin_inr": inr(net_margin),
            "net_margin_pct": margin_pct,
            "bean_payout_ratio": ratio,
            "bean_payout_ratio_pct": ratio_pct,
            "diamonds_consumed": diamonds_consumed,
            "beans_created": beans_created,
            "beans_paid_out": beans_paid_out,
        },
        definitions=_definitions(
            "revenue", "payout", "commission", "margin", "bean_payout_ratio", "currency"
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    if not any((revenue, payouts, accrued, paid, diamonds_consumed, beans_created)):
        report.mark_empty(
            "Nothing moved in this period — no revenue, no payout, no "
            "commission, no diamond or bean activity. Every figure below is "
            "zero for want of data, not as a result."
        )
    return report


def _metric(name: str, value, unit: str, note: str) -> dict:
    return {
        "metric": name,
        "value": value,
        "unit": unit,
        "value_inr": inr(value) if unit == "inr_minor" else None,
        "note": note,
    }


async def channel_breakdown(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Reseller versus direct, reported separately. Spec 9.13 / 8A.6.2.

    Different margin, different growth, different risk — so they are never
    added together into one number.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    groups = await _aggregate(C.LEDGER, _receipt_pipeline(since, until))
    by_channel, non_cash, warnings = _value_receipt_groups(groups, rt)

    receipts: dict[str, dict] = {}
    for key, entry in by_channel.items():
        channel = entry.get("channel", CHANNEL_UNATTRIBUTED)
        bucket = receipts.setdefault(
            channel, {"receipts_inr_minor": 0, "movements": 0, "valuation": entry["valuation"]}
        )
        bucket["receipts_inr_minor"] += entry["receipts_inr_minor"]
        bucket["movements"] += entry["movements"]

    # Payouts are only attributed to a channel when the card says so.
    payout_groups = await _aggregate(
        C.CARDS,
        [
            {
                "$match": {
                    "stage": str(Stage.EXECUTED),
                    "executed_at": {"$gte": since, "$lt": until},
                    "type": {"$in": PAYOUT_CARD_TYPES},
                }
            },
            {
                "$addFields": {
                    "_channel": {
                        "$switch": {
                            "branches": [
                                {
                                    "case": {
                                        "$in": [
                                            "$payload.channel",
                                            [CHANNEL_DIRECT, CHANNEL_RESELLER],
                                        ]
                                    },
                                    "then": "$payload.channel",
                                }
                            ],
                            "default": CHANNEL_UNATTRIBUTED,
                        }
                    }
                }
            },
            {
                "$group": {
                    "_id": {"channel": "$_channel", "currency": "$currency"},
                    "amount": {"$sum": {"$abs": "$amount"}},
                    "cards": {"$sum": 1},
                }
            },
        ],
    )

    payouts: dict[str, dict] = {}
    for row in payout_groups:
        channel = row["_id"]["channel"]
        minor, _rule = to_inr_minor(row["amount"], row["_id"].get("currency", ""), rt)
        bucket = payouts.setdefault(channel, {"payouts_inr_minor": 0, "cards": 0})
        bucket["payouts_inr_minor"] += minor
        bucket["cards"] += row["cards"]

    total_receipts = sum(v["receipts_inr_minor"] for v in receipts.values())
    unattributed_payouts = payouts.get(CHANNEL_UNATTRIBUTED, {}).get("payouts_inr_minor", 0)

    rows: list[dict] = []
    for channel in sorted(set(receipts) | set(payouts)):
        r = receipts.get(channel, {"receipts_inr_minor": 0, "movements": 0})
        p = payouts.get(channel, {"payouts_inr_minor": 0, "cards": 0})
        contribution = r["receipts_inr_minor"] - p["payouts_inr_minor"]
        rows.append(
            {
                "channel": channel,
                "receipts_inr_minor": r["receipts_inr_minor"],
                "receipts_inr": inr(r["receipts_inr_minor"]),
                "receipt_count": r["movements"],
                "share_of_receipts_pct": (
                    round(r["receipts_inr_minor"] / total_receipts * 100, 3)
                    if total_receipts
                    else None
                ),
                "attributed_payouts_inr_minor": p["payouts_inr_minor"],
                "payout_cards": p["cards"],
                "contribution_inr_minor": contribution,
                "contribution_inr": inr(contribution),
            }
        )

    if unattributed_payouts:
        warnings.append(
            f"{inr(unattributed_payouts)} INR of executed payouts carry no "
            "channel on the card, so they sit in the 'unattributed' row rather "
            "than being spread across channels. Channel contribution is "
            "therefore before unattributed costs."
        )

    report = Report(
        name="channels",
        title="Channel breakdown — reseller versus direct",
        period=_period(since, until),
        columns=[
            ("channel", "Channel"),
            ("receipt_count", "Receipts"),
            ("receipts_inr_minor", "Receipts (INR minor units)"),
            ("receipts_inr", "Receipts (INR)"),
            ("share_of_receipts_pct", "Share of receipts %"),
            ("attributed_payouts_inr_minor", "Attributed payouts (INR minor units)"),
            ("payout_cards", "Payout cards"),
            ("contribution_inr_minor", "Contribution (INR minor units)"),
        ],
        rows=rows,
        totals={
            "receipts_inr_minor": total_receipts,
            "unattributed_payouts_inr_minor": unattributed_payouts,
            "non_cash_credits_excluded": non_cash,
        },
        definitions=_definitions("revenue", "payout", "channel", "currency"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    report.note_if_empty("No receipts on either channel in this period.")
    return report


# ══════════════════════════════════════════════════════════════════════════════
#  PARTNER REPORTING
# ══════════════════════════════════════════════════════════════════════════════


async def _window_statement(
    holder_type: HolderType,
    holder_id: str,
    currency: Currency,
    since: datetime,
    until: datetime,
) -> dict:
    """Opening balance, movement and closing balance for one holder.

    Reproducible for any past window: the opening balance is taken from the
    `balance_before` of the first movement inside the window, or from the
    `balance_after` of the last movement before it. That is what makes a March
    statement still say what it said in March (9.18).
    """
    base = {
        "holder_type": str(holder_type),
        "holder_id": holder_id,
        "currency": str(currency),
    }

    groups = await _aggregate(
        C.LEDGER,
        [
            {"$match": {**base, "at": {"$gte": since, "$lt": until}}},
            {"$sort": {"at": 1}},
            {
                "$group": {
                    "_id": None,
                    "credits": {
                        "$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}
                    },
                    "debits": {
                        "$sum": {"$cond": [{"$lt": ["$amount", 0]}, {"$abs": "$amount"}, 0]}
                    },
                    "net": {"$sum": "$amount"},
                    "movements": {"$sum": 1},
                    "opening": {"$first": "$balance_before"},
                    "closing": {"$last": "$balance_after"},
                    "first_at": {"$first": "$at"},
                    "last_at": {"$last": "$at"},
                }
            },
        ],
    )

    if groups:
        row = groups[0]
        row.pop("_id", None)
        return row

    prior = await _find_one(
        C.LEDGER, {**base, "at": {"$lt": since}}, sort=[("at", -1)]
    )
    opening = int(prior["balance_after"]) if prior else 0
    return {
        "credits": 0,
        "debits": 0,
        "net": 0,
        "movements": 0,
        "opening": opening,
        "closing": opening,
        "first_at": None,
        "last_at": None,
    }


async def agency_statement_range(
    agency_id: str,
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Commission earned, paid and outstanding for a period. Spec 0.2.2 / 9.18.

    Amounts are minor units (paise) — the `_inr` columns are the same figures
    divided by 100.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    partner = await _find_one(C.PARTNERS, {"_id": agency_id})
    if partner is None:
        raise ReportError(
            f"No agency '{agency_id}'. A statement is not produced for an "
            "unknown partner."
        )

    window = await _window_statement(
        HolderType.AGENCY, agency_id, Currency.COMMISSION, since, until
    )

    by_action = await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "holder_type": str(HolderType.AGENCY),
                    "holder_id": agency_id,
                    "currency": str(Currency.COMMISSION),
                    "at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$group": {
                    "_id": "$action",
                    "amount_minor": {"$sum": "$amount"},
                    "movements": {"$sum": 1},
                    "last_at": {"$max": "$at"},
                }
            },
            {"$sort": {"amount_minor": -1}},
        ],
    )

    rows = [
        {
            "action": row["_id"],
            "movements": row["movements"],
            "amount_minor": row["amount_minor"],
            "amount_inr": inr(row["amount_minor"]),
            "last_at": row["last_at"],
        }
        for row in by_action
    ]

    earned = int(window["credits"])
    paid = int(window["debits"])
    outstanding = int(window["closing"])

    report = Report(
        name=f"agency_statement_{agency_id}",
        title=f"Agency statement — {partner.get('name', agency_id)}",
        period=_period(since, until),
        columns=[
            ("action", "Action"),
            ("movements", "Movements"),
            ("amount_minor", "Amount (paise)"),
            ("amount_inr", "Amount (INR)"),
            ("last_at", "Last movement"),
        ],
        rows=rows,
        totals={
            "agency_id": agency_id,
            "name": partner.get("name", ""),
            "status": partner.get("status"),
            "opening_outstanding_minor": int(window["opening"]),
            "commission_earned_minor": earned,
            "commission_paid_minor": paid,
            "commission_outstanding_minor": outstanding,
            "commission_earned_inr": inr(earned),
            "commission_paid_inr": inr(paid),
            "commission_outstanding_inr": inr(outstanding),
            "movements": window["movements"],
            "first_movement_at": window["first_at"],
            "last_movement_at": window["last_at"],
        },
        definitions=_definitions("commission", "currency"),
        rates=rt.as_dict(),
    )
    report.note_if_empty(
        "No commission movement for this agency in this period. The opening "
        "and closing outstanding figures in `totals` are still correct."
    )
    return report


async def seller_statement_range(
    seller_id: str,
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Coins bought, lent, sold and on hand for a period, plus credit standing."""
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    partner = await _find_one(C.PARTNERS, {"_id": seller_id})
    if partner is None:
        raise ReportError(
            f"No seller '{seller_id}'. A statement is not produced for an "
            "unknown partner."
        )

    window = await _window_statement(
        HolderType.SELLER, seller_id, Currency.COINS, since, until
    )

    by_action = await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "holder_type": str(HolderType.SELLER),
                    "holder_id": seller_id,
                    "currency": str(Currency.COINS),
                    "at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$group": {
                    "_id": "$action",
                    "coins": {"$sum": "$amount"},
                    "movements": {"$sum": 1},
                    "cash_minor": {"$sum": {"$ifNull": ["$meta.cash_minor", 0]}},
                    "last_at": {"$max": "$at"},
                }
            },
            {"$sort": {"coins": -1}},
        ],
    )

    purchased = sum(r["coins"] for r in by_action if r["coins"] > 0 and str(r["_id"]).startswith("inventory"))
    lent = sum(r["coins"] for r in by_action if r["coins"] > 0 and str(r["_id"]).startswith("lending"))
    cash_in = sum(r["cash_minor"] for r in by_action)

    rows = [
        {
            "action": row["_id"],
            "movements": row["movements"],
            "coins": row["coins"],
            "cash_minor": row["cash_minor"],
            "cash_inr": inr(row["cash_minor"]),
            "last_at": row["last_at"],
        }
        for row in by_action
    ]

    credit = partner.get("credit", {}) or {}
    coin_value, coin_rule = to_inr_minor(int(window["closing"]), str(Currency.COINS), rt)

    report = Report(
        name=f"seller_statement_{seller_id}",
        title=f"Seller statement — {partner.get('name', seller_id)}",
        period=_period(since, until),
        columns=[
            ("action", "Action"),
            ("movements", "Movements"),
            ("coins", "Coins (signed)"),
            ("cash_minor", "Cash recorded (paise)"),
            ("cash_inr", "Cash recorded (INR)"),
            ("last_at", "Last movement"),
        ],
        rows=rows,
        totals={
            "seller_id": seller_id,
            "name": partner.get("name", ""),
            "status": partner.get("status"),
            "opening_coins": int(window["opening"]),
            "coins_in": int(window["credits"]),
            "coins_out": int(window["debits"]),
            "coins_purchased": purchased,
            "coins_lent": lent,
            "coins_on_hand": int(window["closing"]),
            "coins_on_hand_inr_minor": coin_value,
            "coins_on_hand_valuation": coin_rule,
            "cash_received_minor": cash_in,
            "cash_received_inr": inr(cash_in),
            "credit_outstanding_minor": int(credit.get("outstanding", 0)),
            "credit_due_at": credit.get("due_at"),
            "movements": window["movements"],
        },
        definitions=_definitions("revenue", "currency"),
        rates=rt.as_dict(),
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    report.note_if_empty(
        "No coin movement for this seller in this period. Opening and closing "
        "stock in `totals` are still correct."
    )
    return report


_PARTNER_KIND_SPEC = {
    "agency": (HolderType.AGENCY, Currency.COMMISSION, [str(PartnerKind.AGENCY), str(PartnerKind.SUB_AGENCY)]),
    "seller": (HolderType.SELLER, Currency.COINS, [str(PartnerKind.SELLER)]),
}


async def all_partners_summary(
    kind: str,
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """One row per partner — the weekly payout run. Spec 8A.3.5."""
    spec = _PARTNER_KIND_SPEC.get(str(kind).lower())
    if spec is None:
        raise ReportError(
            f"kind must be 'agency' or 'seller' — not '{kind}'."
        )
    holder_type, currency, partner_kinds = spec

    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    groups = await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "holder_type": str(holder_type),
                    "currency": str(currency),
                    "at": {"$gte": since, "$lt": until},
                }
            },
            {"$sort": {"at": 1}},
            {
                "$group": {
                    "_id": "$holder_id",
                    "credits": {
                        "$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}
                    },
                    "debits": {
                        "$sum": {"$cond": [{"$lt": ["$amount", 0]}, {"$abs": "$amount"}, 0]}
                    },
                    "movements": {"$sum": 1},
                    "opening": {"$first": "$balance_before"},
                    "closing": {"$last": "$balance_after"},
                    "last_at": {"$max": "$at"},
                }
            },
            {
                "$lookup": {
                    "from": C.PARTNERS,
                    "localField": "_id",
                    "foreignField": "_id",
                    "as": "_partner",
                }
            },
            {"$sort": {"credits": -1}},
        ],
    )

    is_agency = holder_type is HolderType.AGENCY
    rows: list[dict] = []
    total_credits = total_debits = total_closing = 0
    unknown = 0

    for row in groups:
        partner = (row.get("_partner") or [{}])[0]
        if not partner:
            unknown += 1
        credits, debits, closing = (
            int(row["credits"]),
            int(row["debits"]),
            int(row["closing"]),
        )
        total_credits += credits
        total_debits += debits
        total_closing += closing

        entry = {
            "partner_id": row["_id"],
            "name": partner.get("name", ""),
            "kind": partner.get("kind", ""),
            "status": partner.get("status", ""),
            "movements": row["movements"],
            "opening": int(row["opening"]),
            "closing": closing,
            "last_movement_at": row["last_at"],
        }
        if is_agency:
            entry.update(
                {
                    "commission_earned_minor": credits,
                    "commission_paid_minor": debits,
                    "commission_outstanding_minor": closing,
                    "commission_earned_inr": inr(credits),
                    "commission_paid_inr": inr(debits),
                    "commission_outstanding_inr": inr(closing),
                }
            )
        else:
            value, rule = to_inr_minor(closing, str(Currency.COINS), rt)
            entry.update(
                {
                    "coins_in": credits,
                    "coins_out": debits,
                    "coins_on_hand": closing,
                    "coins_on_hand_inr": inr(value),
                    "valuation": rule,
                    "credit_outstanding_minor": int(
                        (partner.get("credit") or {}).get("outstanding", 0)
                    ),
                }
            )
        rows.append(entry)

    if is_agency:
        columns = [
            ("partner_id", "Agency ID"),
            ("name", "Name"),
            ("status", "Status"),
            ("movements", "Movements"),
            ("commission_earned_minor", "Earned (paise)"),
            ("commission_paid_minor", "Paid (paise)"),
            ("commission_outstanding_minor", "Outstanding (paise)"),
            ("commission_earned_inr", "Earned (INR)"),
            ("commission_paid_inr", "Paid (INR)"),
            ("commission_outstanding_inr", "Outstanding (INR)"),
            ("last_movement_at", "Last movement"),
        ]
    else:
        columns = [
            ("partner_id", "Seller ID"),
            ("name", "Name"),
            ("status", "Status"),
            ("movements", "Movements"),
            ("coins_in", "Coins in"),
            ("coins_out", "Coins out"),
            ("coins_on_hand", "Coins on hand"),
            ("coins_on_hand_inr", "Stock value (INR)"),
            ("credit_outstanding_minor", "Credit outstanding (paise)"),
            ("last_movement_at", "Last movement"),
        ]

    warnings: list[str] = []
    if unknown:
        warnings.append(
            f"{unknown} ledger holder(s) in this period have no partner record. "
            "They are listed by id rather than dropped from the run."
        )

    total_partners = await _count(C.PARTNERS, {"kind": {"$in": partner_kinds}})
    silent = total_partners - len(rows)
    if silent > 0:
        warnings.append(
            f"{silent} {kind}(s) had no movement in this period and do not "
            "appear. Absence here means no activity, not a zero balance — use "
            "the individual statement for their standing."
        )

    report = Report(
        name=f"partners_{str(kind).lower()}_summary",
        title=f"All {kind} partners — period summary",
        period=_period(since, until),
        columns=columns,
        rows=rows,
        totals={
            "kind": str(kind).lower(),
            "partners_with_movement": len(rows),
            "partners_on_file": total_partners,
            "credits_total": total_credits,
            "debits_total": total_debits,
            "closing_total": total_closing,
            **(
                {
                    "commission_earned_inr": inr(total_credits),
                    "commission_paid_inr": inr(total_debits),
                    "commission_outstanding_inr": inr(total_closing),
                }
                if is_agency
                else {}
            ),
        },
        definitions=_definitions("commission", "currency"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    report.note_if_empty(f"No {kind} had any movement in this period.")
    return report


async def outstanding_liabilities(rates: Rates | None = None) -> Report:
    """Everything owed right now, to agencies and to hosts.

    Nobody can answer this today. It is a point-in-time figure, so it carries
    no date range — only a generation time.
    """
    rt = await _rates(rates)
    now = datetime.now(timezone.utc)

    groups = await _aggregate(
        C.BALANCES,
        [
            {
                "$match": {
                    "$or": [
                        {
                            "holder_type": str(HolderType.AGENCY),
                            "currency": str(Currency.COMMISSION),
                        },
                        {
                            "holder_type": str(HolderType.USER),
                            "currency": str(Currency.BEANS),
                        },
                        {
                            "holder_type": str(HolderType.SELLER),
                            "currency": str(Currency.COINS),
                        },
                    ],
                    "amount": {"$gt": 0},
                }
            },
            {
                "$group": {
                    "_id": {"holder_type": "$holder_type", "currency": "$currency"},
                    "amount": {"$sum": "$amount"},
                    "holders": {"$sum": 1},
                    "largest": {"$max": "$amount"},
                }
            },
            {"$sort": {"amount": -1}},
        ],
    )

    labels = {
        (str(HolderType.AGENCY), str(Currency.COMMISSION)): (
            "agency_commission",
            "Commission owed to agencies",
            True,
        ),
        (str(HolderType.USER), str(Currency.BEANS)): (
            "host_beans",
            "Beans held by hosts, payable on withdrawal",
            True,
        ),
        (str(HolderType.SELLER), str(Currency.COINS)): (
            "seller_stock",
            "Coin stock held by sellers (already paid for — not a liability)",
            False,
        ),
    }

    rows: list[dict] = []
    total_liability = 0
    for row in groups:
        key = (row["_id"]["holder_type"], row["_id"]["currency"])
        name, description, is_liability = labels.get(
            key, (f"{key[0]}_{key[1]}", "", False)
        )
        minor, rule = to_inr_minor(row["amount"], key[1], rt)
        if is_liability:
            total_liability += minor
        rows.append(
            {
                "liability": name,
                "description": description,
                "counts_as_liability": is_liability,
                "holders": row["holders"],
                "native_amount": row["amount"],
                "native_currency": key[1],
                "largest_single_holder": row["largest"],
                "inr_minor": minor,
                "inr": inr(minor),
                "rate_applied": rule,
            }
        )

    credit = await _aggregate(
        C.PARTNERS,
        [
            {
                "$match": {
                    "kind": str(PartnerKind.SELLER),
                    "credit.outstanding": {"$gt": 0},
                }
            },
            {
                "$group": {
                    "_id": None,
                    "outstanding": {"$sum": "$credit.outstanding"},
                    "sellers": {"$sum": 1},
                    "overdue": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$and": [
                                        _present("credit.due_at"),
                                        {"$lt": ["$credit.due_at", now]},
                                    ]
                                },
                                1,
                                0,
                            ]
                        }
                    },
                }
            },
        ],
    )
    receivable = int(credit[0]["outstanding"]) if credit else 0
    if credit:
        rows.append(
            {
                "liability": "seller_credit_receivable",
                "description": "Owed TO the business by sellers (a receivable, shown for net position)",
                "counts_as_liability": False,
                "holders": credit[0]["sellers"],
                "native_amount": receivable,
                "native_currency": "inr_minor",
                "largest_single_holder": None,
                "inr_minor": receivable,
                "inr": inr(receivable),
                "rate_applied": "already INR minor units (paise), 1:1",
            }
        )

    report = Report(
        name="outstanding_liabilities",
        title="Outstanding liabilities — as at now",
        period={
            "as_at": now,
            "bounds": "point in time — this report has no date range",
        },
        columns=[
            ("liability", "Liability"),
            ("description", "Description"),
            ("counts_as_liability", "Counts as liability"),
            ("holders", "Holders"),
            ("native_amount", "Amount (native units)"),
            ("native_currency", "Native currency"),
            ("inr_minor", "INR (minor units)"),
            ("inr", "INR"),
            ("rate_applied", "Rate applied"),
        ],
        rows=rows,
        totals={
            "total_owed_inr_minor": total_liability,
            "total_owed_inr": inr(total_liability),
            "seller_credit_receivable_minor": receivable,
            "net_position_inr_minor": receivable - total_liability,
            "sellers_overdue": int(credit[0]["overdue"]) if credit else 0,
        },
        definitions=_definitions("commission", "currency"),
        rates=rt.as_dict(),
    )
    if rt.provisional:
        report.warnings.append(rt.note)
    report.note_if_empty(
        "No positive agency, host or seller balance exists. If that is "
        "unexpected, the balances collection is empty — treat this as a data "
        "problem, not as nothing being owed."
    )
    return report


# ══════════════════════════════════════════════════════════════════════════════
#  TEAM REPORTING
# ══════════════════════════════════════════════════════════════════════════════

OPEN_STAGES = [
    str(Stage.REQUESTED),
    str(Stage.UNDER_REVIEW),
    str(Stage.AWAITING_SIGNOFF),
    str(Stage.APPROVED),
]

_STAGE_TIMESTAMPS = [
    ("raised", "created_at"),
    ("verified", "verified_at"),
    ("signed", "signed_at"),
    ("executed", "executed_at"),
    ("rejected", "rejected_at"),
]

_STAGE_DURATIONS = [
    ("raised_to_verified", "created_at", "verified_at"),
    ("verified_to_signed", "verified_at", "signed_at"),
    ("signed_to_executed", "signed_at", "executed_at"),
    ("raised_to_executed", "created_at", "executed_at"),
]


def _median_stage(name: str, start: str, end: str, since: datetime, until: datetime, team: str | None) -> list[dict]:
    """A $facet branch computing a median duration in the database.

    `$sortArray` + index arithmetic, so no document is pulled into Python.
    """
    match: dict = {end: {"$gte": since, "$lt": until}}
    if team:
        match["team"] = team
    return [
        {"$match": match},
        {"$project": {"_d": {"$subtract": [f"${end}", f"${start}"]}}},
        {"$match": {"_d": {"$gt": 0}}},
        {"$group": {"_id": None, "vals": {"$push": "$_d"}, "n": {"$sum": 1}}},
        {
            "$project": {
                "stage": {"$literal": name},
                "n": 1,
                "median_ms": {
                    "$let": {
                        "vars": {"s": {"$sortArray": {"input": "$vals", "sortBy": 1}}},
                        "in": {
                            "$cond": [
                                {"$eq": [{"$mod": ["$n", 2]}, 1]},
                                {
                                    "$arrayElemAt": [
                                        "$$s",
                                        {"$toInt": {"$floor": {"$divide": ["$n", 2]}}},
                                    ]
                                },
                                {
                                    "$avg": [
                                        {
                                            "$arrayElemAt": [
                                                "$$s",
                                                {
                                                    "$toInt": {
                                                        "$subtract": [
                                                            {"$divide": ["$n", 2]},
                                                            1,
                                                        ]
                                                    }
                                                },
                                            ]
                                        },
                                        {
                                            "$arrayElemAt": [
                                                "$$s",
                                                {"$toInt": {"$divide": ["$n", 2]}},
                                            ]
                                        },
                                    ]
                                },
                            ]
                        },
                    }
                },
            }
        },
    ]


async def team_throughput(
    team: str | Team | None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> Report:
    """Cards raised, verified, signed, executed, rejected — and how long each
    stage took. Spec 8A.3.8 / 10.11.

    `team=None` is every team, and only a caller who may read everything gets
    that (the router enforces it).
    """
    since, until = resolve_window(since, until)
    team_value = str(team) if team else None

    if team_value is not None and team_value not in {str(t) for t in Team}:
        raise ReportError(
            f"'{team_value}' is not a department. One of: "
            f"{', '.join(str(t) for t in Team)}."
        )

    facet: dict[str, list] = {}
    for name, field_name in _STAGE_TIMESTAMPS:
        match: dict = {field_name: {"$gte": since, "$lt": until}}
        if team_value:
            match["team"] = team_value
        facet[f"count_{name}"] = [{"$match": match}, {"$count": "n"}]

    for name, start, end in _STAGE_DURATIONS:
        facet[f"median_{name}"] = _median_stage(name, start, end, since, until, team_value)

    open_match: dict = {"stage": {"$in": OPEN_STAGES}}
    if team_value:
        open_match["team"] = team_value
    facet["open_by_stage"] = [
        {"$match": open_match},
        {"$group": {"_id": "$stage", "n": {"$sum": 1}, "oldest": {"$min": "$created_at"}}},
    ]
    facet["oldest_open"] = [
        {"$match": open_match},
        {"$sort": {"created_at": 1}},
        {"$limit": 1},
        {
            "$project": {
                "_id": 0,
                "card_id": {"$toString": "$_id"},
                "title": 1,
                "type": 1,
                "stage": 1,
                "team": 1,
                "amount": 1,
                "currency": 1,
                "created_at": 1,
                "requested_by": "$requested_by.name",
            }
        },
    ]

    # A $facet sub-pipeline cannot use an index, so the collection is narrowed
    # once — by team, and to cards that either moved in the period or are still
    # open — before the facet ever runs.
    prematch: dict = {
        "$or": [
            {field_name: {"$gte": since, "$lt": until}}
            for _, field_name in _STAGE_TIMESTAMPS
        ]
        + [{"stage": {"$in": OPEN_STAGES}}]
    }
    if team_value:
        prematch["team"] = team_value

    result = await _aggregate(C.CARDS, [{"$match": prematch}, {"$facet": facet}])
    data = result[0] if result else {}

    def _n(key: str) -> int:
        branch = data.get(key) or []
        return int(branch[0]["n"]) if branch else 0

    counts = {name: _n(f"count_{name}") for name, _ in _STAGE_TIMESTAMPS}

    rows: list[dict] = []
    for name, _field in _STAGE_TIMESTAMPS:
        rows.append(
            {
                "measure": f"cards_{name}",
                "kind": "count",
                "value": counts[name],
                "unit": "cards",
                "detail": "",
            }
        )

    medians: dict[str, float | None] = {}
    for name, start, end in _STAGE_DURATIONS:
        branch = data.get(f"median_{name}") or []
        if branch:
            hours = round(float(branch[0]["median_ms"]) / 3_600_000, 2)
            sample = int(branch[0]["n"])
        else:
            hours = None
            sample = 0
        medians[name] = hours
        rows.append(
            {
                "measure": f"median_{name}",
                "kind": "duration",
                "value": hours,
                "unit": "hours",
                "detail": (
                    f"median of {sample} card(s)"
                    if sample
                    else "no card completed this transition in the period — "
                    "reported as null, not zero"
                ),
            }
        )

    open_counts: dict[str, int] = {}
    for row in data.get("open_by_stage") or []:
        open_counts[row["_id"]] = row["n"]
        rows.append(
            {
                "measure": f"open_{row['_id']}",
                "kind": "queue",
                "value": row["n"],
                "unit": "cards",
                "detail": f"oldest raised {_utc(row['oldest']).isoformat()}"
                if row.get("oldest")
                else "",
            }
        )

    oldest = (data.get("oldest_open") or [None])[0]
    if oldest:
        age_days = round(
            (datetime.now(timezone.utc) - _utc(oldest["created_at"])).total_seconds()
            / 86400,
            2,
        )
        oldest["age_days"] = age_days
        rows.append(
            {
                "measure": "oldest_open_item",
                "kind": "queue",
                "value": age_days,
                "unit": "days old",
                "detail": f"{oldest.get('title', '')} ({oldest.get('stage')}, "
                f"card {oldest.get('card_id')})",
            }
        )

    report = Report(
        name=f"team_throughput_{team_value or 'all'}",
        title=f"Team throughput — {team_value or 'all teams'}",
        period=_period(since, until),
        columns=[
            ("measure", "Measure"),
            ("kind", "Kind"),
            ("value", "Value"),
            ("unit", "Unit"),
            ("detail", "Detail"),
        ],
        rows=rows,
        totals={
            "team": team_value or "all",
            "counts": counts,
            "median_hours": medians,
            "open_by_stage": open_counts,
            "open_total": sum(open_counts.values()),
            "oldest_open_item": oldest,
        },
        definitions={
            "counted_by": (
                "A card is counted in the stage whose timestamp falls inside "
                "the period — raised by created_at, verified by verified_at, "
                "signed by signed_at, executed by executed_at, rejected by "
                "rejected_at. A card can therefore appear in several counts, "
                "which is correct: it did several things."
            ),
            "median": (
                "Median, not mean — one stuck card should not move the number. "
                "Computed in the database. Null when no card completed that "
                "transition in the period."
            ),
        },
    )
    if not any(counts.values()) and not open_counts:
        report.mark_empty(
            "No card was raised, verified, signed, executed or rejected for "
            "this team in this period, and nothing is open. The zeroes mean no "
            "activity, not a measured result."
        )
    return report


MONEY_ACTIONS = [
    audit.Action.BALANCE_CREDIT,
    audit.Action.BALANCE_DEBIT,
    audit.Action.INVENTORY_CREDIT,
    audit.Action.INVENTORY_DEBIT,
    audit.Action.LENDING_ISSUE,
    audit.Action.LENDING_REPAY,
    audit.Action.LENDING_RECOVER,
    audit.Action.LENDING_WRITE_OFF,
    audit.Action.COMMISSION_ACCRUE,
    audit.Action.COMMISSION_PAY,
    audit.Action.PAYOUT_EXECUTE,
    audit.Action.WITHDRAWAL_PAY,
    audit.Action.REFUND,
    audit.Action.CARD_SIGNED,
    audit.Action.CARD_EXECUTED,
    audit.Action.CARD_EXECUTION_FAILED,
    audit.Action.RATE_CHANGED,
]


async def audit_summary(
    since: datetime | None = None,
    until: datetime | None = None,
    actor_team: str | None = None,
) -> Report:
    """Every money action in the period, by actor and by type. Spec 8A.3.12.

    The monthly governance review reads this. `actor_team` narrows it to one
    department for a team admin.
    """
    since, until = resolve_window(since, until)

    match: dict = {"at": {"$gte": since, "$lt": until}, "action": {"$in": MONEY_ACTIONS}}
    if actor_team:
        match["actor.team"] = str(actor_team)

    result = await _aggregate(
        C.AUDIT,
        [
            {"$match": match},
            {
                "$facet": {
                    "by_actor_action": [
                        {
                            "$group": {
                                "_id": {
                                    "uid": "$actor.uid",
                                    "name": "$actor.name",
                                    "role": "$actor.role",
                                    "team": "$actor.team",
                                    "action": "$action",
                                },
                                "count": {"$sum": 1},
                                "last_at": {"$max": "$at"},
                                "cards": {"$addToSet": "$card_id"},
                            }
                        },
                        {"$sort": {"count": -1}},
                        {"$limit": 2000},
                    ],
                    "by_action": [
                        {
                            "$group": {
                                "_id": "$action",
                                "count": {"$sum": 1},
                                "actors": {"$addToSet": "$actor.uid"},
                            }
                        },
                        {
                            "$project": {
                                "count": 1,
                                "actor_count": {"$size": "$actors"},
                            }
                        },
                        {"$sort": {"count": -1}},
                    ],
                    "by_actor": [
                        {
                            "$group": {
                                "_id": {
                                    "uid": "$actor.uid",
                                    "name": "$actor.name",
                                    "role": "$actor.role",
                                    "team": "$actor.team",
                                },
                                "count": {"$sum": 1},
                                "actions": {"$addToSet": "$action"},
                            }
                        },
                        {"$sort": {"count": -1}},
                        {"$limit": 500},
                    ],
                    "total": [{"$count": "n"}],
                }
            },
        ],
    )
    data = result[0] if result else {}

    rows = [
        {
            "actor_uid": row["_id"].get("uid", ""),
            "actor_name": row["_id"].get("name", ""),
            "actor_role": row["_id"].get("role", ""),
            "actor_team": row["_id"].get("team") or "",
            "action": row["_id"].get("action", ""),
            "count": row["count"],
            "cards_touched": len([c for c in row.get("cards", []) if c]),
            "last_at": row["last_at"],
        }
        for row in data.get("by_actor_action") or []
    ]

    by_action = {
        row["_id"]: {"count": row["count"], "distinct_actors": row["actor_count"]}
        for row in data.get("by_action") or []
    }
    by_actor = [
        {
            "uid": row["_id"].get("uid", ""),
            "name": row["_id"].get("name", ""),
            "role": row["_id"].get("role", ""),
            "team": row["_id"].get("team"),
            "count": row["count"],
            "distinct_actions": len(row.get("actions", [])),
        }
        for row in data.get("by_actor") or []
    ]
    total_branch = data.get("total") or []
    total = int(total_branch[0]["n"]) if total_branch else 0

    report = Report(
        name="audit_summary",
        title="Audit summary — money actions by actor and type",
        period=_period(since, until),
        columns=[
            ("actor_name", "Actor"),
            ("actor_role", "Role"),
            ("actor_team", "Team"),
            ("action", "Action"),
            ("count", "Count"),
            ("cards_touched", "Cards touched"),
            ("last_at", "Last at"),
            ("actor_uid", "Actor UID"),
        ],
        rows=rows,
        totals={
            "money_actions": total,
            "distinct_actors": len(by_actor),
            "by_action": by_action,
            "by_actor": by_actor,
            "scope": f"team={actor_team}" if actor_team else "all teams",
        },
        definitions={
            "money_actions": (
                "Only actions that move money or authorise it are counted: "
                + ", ".join(MONEY_ACTIONS)
            ),
        },
    )
    report.note_if_empty(
        "No money action was recorded in this period by anyone in scope. For a "
        "month-long window that is itself worth checking."
    )
    return report


# ══════════════════════════════════════════════════════════════════════════════
#  DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════


async def dashboard(
    user_role: Role | str,
    user_team: str | None = None,
    rates: Rates | None = None,
) -> Report:
    """Role-appropriate figures for the landing screen. Spec 8A.3.1 / 7.3.

    Owners and the observer see the whole business. A team admin sees their own
    team, plus — for Finance, who run the payments — the money blocks. A member
    sees their own work and their team's queue, and no business-wide money.
    Queue depths and anything overdue are always included.
    """
    role = Role(str(user_role))
    now = datetime.now(timezone.utc)
    sections: dict[str, Any] = {}
    rows: list[dict] = []
    warnings: list[str] = []

    def add(section: str, metric: str, value, unit: str, note: str = "") -> None:
        sections.setdefault(section, {})[metric] = value
        rows.append(
            {
                "section": section,
                "metric": metric,
                "value": value,
                "unit": unit,
                "note": note,
            }
        )

    sees_all = R.can_read_all(role)
    team = str(user_team) if user_team else (str(R.team_of(role)) if R.team_of(role) else None)
    sees_money = sees_all or role == Role.FINANCE_ADMIN
    scope_team = None if sees_all else team

    add("scope", "role", str(role), "role")
    add("scope", "team", team or "all", "team")
    add(
        "scope",
        "financial_visibility",
        "whole business" if sees_all else ("finance" if sees_money else "none"),
        "scope",
    )

    # ── Money — only for those who may see it ────────────────────────────────
    rt: Rates | None = None
    if sees_money:
        rt = await _rates(rates)
        for label, days in (("last_7_days", 7), ("last_30_days", 30)):
            cash = await cash_position(now - timedelta(days=days), now, rt)
            add("cash", f"receipts_{label}_inr_minor", cash.totals["receipts_inr_minor"], "inr_minor")
            add("cash", f"payments_out_{label}_inr_minor", cash.totals["payments_out_inr_minor"], "inr_minor")
            add("cash", f"net_{label}_inr_minor", cash.totals["net_inr_minor"], "inr_minor")
            warnings.extend(w for w in cash.warnings if w not in warnings)

        liabilities = await outstanding_liabilities(rt)
        add(
            "liabilities",
            "total_owed_inr_minor",
            liabilities.totals["total_owed_inr_minor"],
            "inr_minor",
            "Agencies and hosts, valued at the stated rates",
        )
        add(
            "liabilities",
            "seller_credit_receivable_minor",
            liabilities.totals["seller_credit_receivable_minor"],
            "inr_minor",
        )
        add(
            "liabilities",
            "sellers_overdue",
            liabilities.totals["sellers_overdue"],
            "sellers",
            "Past their due date — blocked from new inventory",
        )
        if rt.provisional and rt.note not in warnings:
            warnings.append(rt.note)

    # ── Queue depth ──────────────────────────────────────────────────────────
    queue_match: dict = {"stage": {"$in": OPEN_STAGES}}
    if scope_team:
        queue_match["team"] = scope_team

    queue = await _aggregate(
        C.CARDS,
        [
            {"$match": queue_match},
            {
                "$group": {
                    "_id": {"stage": "$stage", "team": "$team"},
                    "n": {"$sum": 1},
                    "oldest": {"$min": "$created_at"},
                }
            },
            {"$sort": {"n": -1}},
        ],
    )
    depth: dict[str, int] = {}
    per_team: dict[str, int] = {}
    for row in queue:
        stage = row["_id"]["stage"]
        card_team = row["_id"].get("team") or "unassigned"
        depth[stage] = depth.get(stage, 0) + row["n"]
        per_team[card_team] = per_team.get(card_team, 0) + row["n"]
    for stage, n in sorted(depth.items()):
        add("queues", f"open_{stage}", n, "cards")
    add("queues", "open_total", sum(depth.values()), "cards")
    if sees_all:
        sections.setdefault("queues", {})["by_team"] = per_team

    # ── Overdue and stuck ────────────────────────────────────────────────────
    three_days = now - timedelta(days=3)
    seven_days = now - timedelta(days=7)

    stale_match: dict = {
        "stage": str(Stage.AWAITING_SIGNOFF),
        "created_at": {"$lt": three_days},
    }
    failed_match: dict = {"stage": str(Stage.FAILED)}
    approved_match: dict = {
        "stage": str(Stage.APPROVED),
        "signed_at": {"$lt": three_days},
    }
    unreviewed_match: dict = {
        "stage": {"$in": [str(Stage.REQUESTED), str(Stage.UNDER_REVIEW)]},
        "created_at": {"$lt": seven_days},
    }
    if scope_team:
        for m in (stale_match, failed_match, approved_match, unreviewed_match):
            m["team"] = scope_team

    add(
        "overdue",
        "awaiting_signature_over_3_days",
        await _count(C.CARDS, stale_match),
        "cards",
        "Verified and waiting on an owner",
    )
    add(
        "overdue",
        "unreviewed_over_7_days",
        await _count(C.CARDS, unreviewed_match),
        "cards",
    )
    add(
        "overdue",
        "signed_not_executed_over_3_days",
        await _count(C.CARDS, approved_match),
        "cards",
        "Money authorised but not yet moved",
    )
    add(
        "overdue",
        "execution_failed",
        await _count(C.CARDS, failed_match),
        "cards",
        "Signed, attempted, did not move — visibly stuck, not lost (5.2.6)",
    )

    # ── Team activity ────────────────────────────────────────────────────────
    if scope_team or sees_all:
        throughput = await team_throughput(scope_team, now - timedelta(days=7), now)
        for measure, value in throughput.totals["counts"].items():
            add("last_7_days", f"cards_{measure}", value, "cards")
        oldest = throughput.totals.get("oldest_open_item")
        if oldest:
            add(
                "overdue",
                "oldest_open_item_days",
                oldest.get("age_days"),
                "days",
                f"{oldest.get('title', '')} ({oldest.get('stage')})",
            )

    if not sees_money:
        warnings.append(
            "Business-wide money figures are not shown for this role. Team "
            "queues and ageing are complete."
        )

    return Report(
        name="dashboard",
        title=f"Dashboard — {role}",
        period={"as_at": now, "bounds": "point in time, with 7 and 30 day windows"},
        columns=[
            ("section", "Section"),
            ("metric", "Metric"),
            ("value", "Value"),
            ("unit", "Unit"),
            ("note", "Note"),
        ],
        rows=rows,
        totals={"role": str(role), "team": team, "sees_whole_business": sees_all},
        sections=sections,
        definitions=_definitions("revenue", "payout", "currency"),
        rates=rt.as_dict() if rt is not None else {},
        warnings=warnings,
    )


# ══════════════════════════════════════════════════════════════════════════════
#  THE OWNER'S WEEKLY BUSINESS REPORT — hosts, agencies, money in, P&L
# ══════════════════════════════════════════════════════════════════════════════
#
# Everything below answers the weekly question an owner actually asks: who
# worked, what are they owed, is anyone eligible, what did each agency earn, how
# much money came in, and what is left after everything went out.
#
# It follows the rules the rest of this module already follows, and adds one.
#
#   * A figure that cannot be computed **raises**. It is never a zero.
#   * A period with no activity is **empty**, and says so in words.
#   * A quantity that this business does not record anywhere is reported as
#     **None** — an em dash on the page — with a note saying where it would have
#     to come from. It is never reported as zero, and the column is never
#     invented. Several lines below are None for exactly this reason and that is
#     the honest answer, not a gap to be filled with a plausible number.
#   * **New:** where a figure comes from Firestore rather than the ledger, the
#     row says so. The two stores are not equally authoritative — Mongo is the
#     business record, Firestore is what the phone wrote — and a reader settling
#     an argument needs to know which one a number came from.

#: A single Firestore window scan will read at most this many documents. Hitting
#: it means the week is bigger than this report was built for, and the section
#: **fails** rather than reporting the partial sum as a total. A truncated total
#: that looks complete is the worst outcome available here.
FIRESTORE_SCAN_LIMIT = 20_000

#: `get_all` is one RPC, but not an unbounded one. Names beyond this are left
#: unknown rather than fetched in a loop that could take minutes.
NAME_LOOKUP_LIMIT = 2_000

#: How many rows a leaderboard shows. The owner asked for "highest", not "all".
TOP_N = 10

FALLBACK_MIN_PAYOUT_INR = 2_000     # appConfig/economy.weeklyMinPayoutInr

#: The owner describes a second host threshold — "1 lakh beans in a week". No
#: key of any of these names exists in `appConfig/economy` as at the 2026-08-20
#: backup, and nothing in the product enforces a bean threshold. All three are
#: looked for so that whichever one an owner eventually writes is picked up
#: without a code change; until one exists the report says the rule is not
#: configured rather than inventing a number for it.
BEAN_THRESHOLD_KEYS = (
    "weeklyMinPayoutBeans",
    "weeklyMinBeans",
    "minWeeklyBeans",
)

DEFINITIONS.update(
    {
        "host_payout_due": (
            "A host's payout for the week is the beans credited to their ledger "
            "balance inside the period, valued at the bean → INR rate in force. "
            "Beans credited, not beans cashed out: this is what the business "
            "owes for the week's work. What was actually paid in the week is the "
            "payout definition, and the two differ whenever a payout lands in a "
            "different week from the work that earned it."
        ),
        "host_eligibility": (
            "A host is eligible when their payout for the week reaches "
            "appConfig/economy.weeklyMinPayoutInr — ₹2,000 in the live "
            "configuration. If a bean threshold is also configured, both must be "
            "met. A host below the line is listed with the figure and the "
            "shortfall, never omitted and never shown as a bare 'no': a host who "
            "cannot see why they were not paid has been given a silent "
            "difference (0.3.5)."
        ),
        "agency_commission_eligibility": (
            "An agency's billing for the week selects one band from its own slab "
            "table and that band's rate applies to the whole figure. Below the "
            "lowest band's floor — ₹25,001 for a main agency, ₹26,001 for a "
            "sub-agency — the agency earns nothing for the period. The floor "
            "affects agency commission only; the hosts are paid in full either "
            "way. The band, the rate and the floor are shown on every row so the "
            "number can be argued with rather than taken on trust."
        ),
        "recharge": (
            "A user recharge counts in the week its request reached 'approved' "
            "in Firestore `rechargeRequests` — that is when the diamonds were "
            "issued and the money was taken. The amount is the recorded "
            "`amountPaid` in rupees. Every recharge in this product passes "
            "through a coin seller; there is no direct gateway path, so the "
            "'direct' figure below is a structural zero and is labelled as one "
            "rather than reported as a measurement."
        ),
        "seller_credit": (
            "Coins advanced to sellers on credit, and what has come back. Taken "
            "from `partners.credit.history`, which records every issue, "
            "repayment, recovery and write-off with its date — the repayment and "
            "write-off paths deliberately write no ledger movement, so the "
            "history array is the only record that covers all four. Amounts are "
            "COINS, valued at the coin rate for the INR columns."
        ),
        "profit": (
            "THE OWNER'S OWN DEFINITION, in his words: \"profit is like the "
            "money we received for selling coin - our all expenditure\". "
            "Implemented as: money received for selling coins and diamonds − every "
            "expenditure the business records going out — payouts, commission "
            "settled, credit written off, and every operating cost entered on "
            "an expense card. Revenue is the cash receipts definition above. "
            "Expenditure is itemised by category, and any category with no "
            "entry for the period is shown as unknown rather than as zero — a "
            "profit computed with a cost missing is an upper bound, and this "
            "report says so on its face rather than presenting it as the "
            "answer."
        ),
        "source_store": (
            "ledger = MongoDB, the business record, authoritative. firestore = "
            "what the phone wrote, a real record of app activity but not the "
            "money spine. A figure's store is stated because the two are not "
            "equally authoritative and a reconciliation has to start somewhere."
        ),
        "host_coverage": (
            "This table lists every host who had at least one bean movement in "
            "the window. A host who earned nothing and cashed out nothing does "
            "NOT appear, and this server cannot say how many such hosts exist: "
            "the host roll lives in Firestore `users` and there is no "
            "server-side report over it (10.23). So the row count is 'hosts who "
            "moved a bean', never 'all hosts on the platform', and an absent "
            "host is an unknown rather than a host who earned zero."
        ),
        "subagency_payment_path": (
            "A sub-agency is never paid directly. Its commission is settled in "
            "two legs (4.2.4): leg 1, Zipper pays the MAIN agency; leg 2, the "
            "main agency pays the sub and an owner records that it did. The "
            "payout stays open until leg 2 is confirmed, so an open leg 2 means "
            "our money has left the business and the sub-agency may not yet "
            "have received it. Both legs are held in `subagency_payouts`."
        ),
        "operating_expenditure": (
            "Staff salaries, servers and infrastructure, marketing and campaign "
            "spend, payment-gateway fees, foreign-settlement fees, tax and "
            "refunds — the cost of running the company. Each is recorded on an "
            "operating-expense card carrying its category, in integer INR minor "
            "units, and each card goes through the same five stages as every "
            "other movement of money: raised by one person, verified by a "
            "second, signed by an owner, then paid. A category counts here in "
            "the period the money LEFT (cash basis), and the month the cost is "
            "*for* travels with the card as a label so a July bill paid in "
            "August is visible as one. A category with no card paid in the "
            "period is shown as UNKNOWN, never as zero — an empty payroll line "
            "means nobody entered the payroll, not that nobody was paid — and "
            "the profit stays labelled an upper bound until every category has "
            "something behind it."
        ),
    }
)


# ── Host payout thresholds ────────────────────────────────────────────────────


@dataclass(slots=True)
class PayoutThresholds:
    """What a host has to reach to be paid this week, and where it came from."""

    min_payout_minor: int
    min_beans: int | None
    min_beans_key: str | None
    source: str
    provisional: bool
    note: str
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "min_payout_inr_minor": self.min_payout_minor,
            "min_payout_inr": inr(self.min_payout_minor),
            "min_beans": self.min_beans,
            "min_beans_config_key": self.min_beans_key,
            "source": self.source,
            "provisional": self.provisional,
            "note": self.note,
        }


def thresholds_from_config(data: Mapping[str, Any] | None) -> PayoutThresholds:
    """Read the eligibility thresholds out of an `appConfig/economy` document.

    Split from the Firestore read so the rule can be tested without a network.
    """
    data = data or {}
    warnings: list[str] = []

    raw = data.get("weeklyMinPayoutInr")
    try:
        rupees = float(raw)
        if rupees < 0:
            raise ValueError
        minor = int(round(rupees * 100))
        source = "firestore"
        provisional = False
        note = f"Host eligibility ≥ {rupee_text(minor)} per week, from appConfig/economy."
    except (TypeError, ValueError):
        minor = FALLBACK_MIN_PAYOUT_INR * 100
        source = "fallback"
        provisional = True
        note = (
            "PROVISIONAL — appConfig/economy has no usable weeklyMinPayoutInr, "
            f"so the documented fallback of ₹{FALLBACK_MIN_PAYOUT_INR:,} per week "
            "was used. Eligibility below is not authoritative."
        )
        warnings.append(note)

    beans: int | None = None
    beans_key: str | None = None
    for key in BEAN_THRESHOLD_KEYS:
        if key not in data:
            continue
        try:
            candidate = int(data[key])
        except (TypeError, ValueError):
            warnings.append(
                f"appConfig/economy.{key} is {data[key]!r}, which is not a whole "
                "number of beans. The bean threshold was ignored and only the "
                "rupee threshold was applied."
            )
            continue
        if candidate < 0:
            continue
        beans, beans_key = candidate, key
        break

    if beans is None:
        warnings.append(
            "NO BEAN THRESHOLD IS CONFIGURED. The owner has described a second "
            "rule — 'one lakh beans in a week' — and it exists nowhere in this "
            "system: not in appConfig/economy, not in the CRM economy editor, "
            "not in the weekly job. Eligibility below therefore applies the "
            "rupee threshold ONLY. To turn the bean rule on, set "
            f"appConfig/economy.{BEAN_THRESHOLD_KEYS[0]} to 100000 and this "
            "report will apply it as a second condition from the next run, with "
            "no code change. Until then a host is eligible on rupees alone."
        )

    return PayoutThresholds(
        min_payout_minor=minor,
        min_beans=beans,
        min_beans_key=beans_key,
        source=source,
        provisional=provisional,
        note=note,
        warnings=warnings,
    )


async def load_thresholds() -> PayoutThresholds:
    """Read the eligibility thresholds. A Firestore outage falls back, loudly."""
    try:
        data = await asyncio.to_thread(_read_economy_doc)
    except Exception as exc:  # noqa: BLE001 — a config outage must not lose the report
        log.warning("Could not read appConfig/economy for thresholds: %s", exc)
        thresholds = thresholds_from_config(None)
        thresholds.warnings.insert(
            0,
            "PROVISIONAL — appConfig/economy could not be read "
            f"({type(exc).__name__}: {exc}), so host eligibility below uses the "
            "documented fallback threshold and must not be paid from.",
        )
        return thresholds
    return thresholds_from_config(data)


# ── Firestore window reads ────────────────────────────────────────────────────
#
# Every one of these is a **single-field range query on a timestamp**, which
# Firestore indexes automatically — no composite index has to be deployed before
# the first Sunday, and a missing index cannot silently fail the run. Any
# narrowing by status or type happens in Python afterwards, over one week of
# documents, which is cheap and cannot be defeated by a missing index.


def _fs_window(
    collection: str, timestamp_field: str, since: datetime, until: datetime
) -> list[dict]:
    """Blocking Firestore read of one collection over one window."""
    client = firebase.firestore_client()
    query = (
        client.collection(collection)
        .where(timestamp_field, ">=", since)
        .where(timestamp_field, "<", until)
        .order_by(timestamp_field)
        .limit(FIRESTORE_SCAN_LIMIT)
    )
    return [{**(doc.to_dict() or {}), "_id": doc.id} for doc in query.stream()]


async def _fs_scan(
    collection: str, timestamp_field: str, since: datetime, until: datetime
) -> list[dict]:
    """One window of a Firestore collection, or a refusal that says why."""
    try:
        docs = await asyncio.to_thread(
            _fs_window, collection, timestamp_field, since, until
        )
    except Exception as exc:  # noqa: BLE001 — surfaced as a refusal, never as zero
        raise DataUnavailable(
            f"Firestore collection '{collection}' could not be read for this "
            f"period ({type(exc).__name__}: {exc}). Nothing from it is reported, "
            "and nothing from it is reported as zero."
        ) from exc

    if len(docs) >= FIRESTORE_SCAN_LIMIT:
        raise DataUnavailable(
            f"'{collection}' returned {len(docs):,} documents for this period, "
            f"which is the {FIRESTORE_SCAN_LIMIT:,} scan cap. The figures would "
            "be a partial sum presented as a total, so the section is withheld. "
            "Narrow the period, or raise FIRESTORE_SCAN_LIMIT deliberately."
        )
    return docs


def _fs_names(uids: Sequence[str]) -> dict[str, str]:
    """Display names for a set of Firestore user ids, in one RPC."""
    client = firebase.firestore_client()
    refs = [client.collection("users").document(uid) for uid in uids]
    out: dict[str, str] = {}
    for snapshot in client.get_all(refs):
        if not getattr(snapshot, "exists", False):
            continue
        data = snapshot.to_dict() or {}
        name = data.get("name") or data.get("displayName") or ""
        if name:
            out[snapshot.id] = str(name)
    return out


async def _user_names(uids: Iterable[str]) -> tuple[dict[str, str], list[str]]:
    """(names, warnings). A name that cannot be read stays unknown, not blank."""
    wanted = sorted({str(u) for u in uids if u})
    if not wanted:
        return {}, []
    warnings: list[str] = []
    if len(wanted) > NAME_LOOKUP_LIMIT:
        warnings.append(
            f"{len(wanted):,} names were needed and only the first "
            f"{NAME_LOOKUP_LIMIT:,} were looked up. The rest are shown by id "
            "rather than being dropped from the table."
        )
        wanted = wanted[:NAME_LOOKUP_LIMIT]
    try:
        names = await asyncio.to_thread(_fs_names, wanted)
    except Exception as exc:  # noqa: BLE001 — a name is not a figure
        log.warning("User names could not be read: %s", exc)
        return {}, warnings + [
            f"Display names could not be read from Firestore ({type(exc).__name__}: "
            f"{exc}). Every row below is identified by id, which is exact. No "
            "figure is affected."
        ]
    return names, warnings


# ── The raw pulls, one per store ──────────────────────────────────────────────
#
# These are separate, named and private so that a test can replace any one of
# them and exercise the real rules over known data. Nothing here decides
# anything; every rule lives in the report function that calls them.


async def _host_bean_activity(since: datetime, until: datetime) -> list[dict]:
    """Per host: beans earned, beans cashed out, and the agency on the movement.

    Grouped in the database. `meta.agency_id` is the field the commission engine
    bills on (`commission.BILLING_DEFINITION`), so it is the field this report
    attributes a host by — one attribution rule, not two.
    """
    return await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "holder_type": str(HolderType.USER),
                    "currency": str(Currency.BEANS),
                    "at": {"$gte": since, "$lt": until},
                }
            },
            {"$sort": {"at": 1}},
            {
                "$group": {
                    "_id": "$holder_id",
                    "beans_earned": {
                        "$sum": {"$cond": [{"$gt": ["$amount", 0]}, "$amount", 0]}
                    },
                    "beans_cashed_out": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$and": [
                                        {"$lt": ["$amount", 0]},
                                        {"$in": ["$action", BEAN_PAYOUT_ACTIONS]},
                                    ]
                                },
                                {"$abs": "$amount"},
                                0,
                            ]
                        }
                    },
                    "movements": {"$sum": 1},
                    "agency_ids": {"$addToSet": "$meta.agency_id"},
                    "last_at": {"$max": "$at"},
                    "closing": {"$last": "$balance_after"},
                }
            },
            {"$sort": {"beans_earned": -1}},
        ],
    )


async def _partner_index() -> dict[str, dict]:
    """Every partner record, by id. Small collection; read once per report."""
    try:
        cursor = _db()[C.PARTNERS].find(
            {}, {"name": 1, "kind": 1, "parent_id": 1, "status": 1, "credit": 1}
        )
        return {str(doc["_id"]): doc async for doc in cursor}
    except PyMongoError as exc:
        raise DataUnavailable(
            f"The partner records could not be read ({exc}), so no host or "
            "agency can be attributed. Nothing is reported unattributed."
        ) from exc


async def _gift_events(since: datetime, until: datetime) -> list[dict]:
    """Firestore `giftEvents` for the window, normalised to what is written.

    Fields are the ones `GiftRepository.sendGift` actually writes: senderUid,
    receiverUid, giftType, totalCost (diamonds), beansEarned, quantity.

    `at` is the send's own timestamp — the field the window is already selected
    on — carried through so a caller that needs to know whether a gift came
    before or after something else can tell. It is only ever a datetime or
    None; a gift whose timestamp will not read is not given a made-up one.
    """
    rows = await _fs_scan("giftEvents", "timestamp", since, until)
    out: list[dict] = []
    for row in rows:
        at = row.get("timestamp")
        out.append(
            {
                "at": _utc(at) if isinstance(at, datetime) else None,
                "sender_uid": str(row.get("senderUid") or ""),
                "receiver_uid": str(row.get("receiverUid") or ""),
                "gift_type": str(row.get("giftType") or ""),
                "gift_name": str(row.get("giftName") or ""),
                "quantity": _int(row.get("quantity"), 0),
                "diamonds": _int(row.get("totalCost"), 0),
                "beans_earned": _int(row.get("beansEarned"), 0),
                # `luckyIsWin` is written only on a lucky send, so its presence
                # is the marker. `giftType` is the catalogue category and is the
                # primary test; this is the fallback for a catalogue that has
                # been renamed since the send.
                "lucky": str(row.get("giftType") or "").lower() == "lucky"
                or "luckyIsWin" in row,
            }
        )
    return out


async def _call_events(since: datetime, until: datetime) -> list[dict]:
    """Firestore `platformRevenue` call events — the only record of call time.

    That collection holds two unrelated document shapes: per-event documents
    written by the app, which carry `type`, and daily rollup documents keyed
    `YYYY-MM-DD`, which do not. Filtering on `type == 'call'` in Python selects
    the first and cannot accidentally include the second.
    """
    rows = await _fs_scan("platformRevenue", "timestamp", since, until)
    out: list[dict] = []
    for row in rows:
        if str(row.get("type") or "") != "call":
            continue
        out.append(
            {
                "receiver_uid": str(row.get("receiverUid") or ""),
                "caller_uid": str(row.get("callerUid") or ""),
                "seconds": _int(row.get("durationSeconds"), 0),
                "beans": _int(row.get("payoutBeans"), 0),
                "diamonds": _int(row.get("grossDiamonds"), 0),
            }
        )
    return out


async def _recharge_events(since: datetime, until: datetime) -> list[dict]:
    """Firestore `rechargeRequests` approved inside the window.

    Windowed on `approvedAt`, which is when the diamonds were issued and the
    money was taken. `approvedAt` is stamped on rejection too, so the status is
    checked here rather than assumed.
    """
    rows = await _fs_scan("rechargeRequests", "approvedAt", since, until)
    out: list[dict] = []
    for row in rows:
        if str(row.get("status") or "") != "approved":
            continue
        out.append(
            {
                "buyer_uid": str(row.get("buyerUid") or ""),
                "buyer_name": str(row.get("buyerName") or ""),
                "seller_uid": str(row.get("sellerUid") or ""),
                "seller_name": str(row.get("sellerName") or ""),
                # 'agency' tops up an agency's own wallet and is not a user
                # recharge. Absent means the legacy shape, which was users only.
                "recipient_type": str(row.get("recipientType") or "user"),
                "amount_inr_minor": _minor_from_major(row.get("amountPaid")),
                "diamonds": _int(row.get("diamondPackage"), 0),
            }
        )
    return out


async def _credit_events(since: datetime, until: datetime) -> list[dict]:
    """Seller credit events in the window, from `partners.credit.history`.

    Issue and recovery also write a ledger movement; repayment and write-off
    deliberately do not. The history array is therefore the only record that
    covers all four, and using it for all four is what makes the four figures
    below add up to each other.
    """
    return await _aggregate(
        C.PARTNERS,
        [
            {"$match": {"kind": str(PartnerKind.SELLER), "credit.history": {"$type": "array"}}},
            {"$unwind": "$credit.history"},
            {"$match": {"credit.history.at": {"$gte": since, "$lt": until}}},
            {
                "$group": {
                    "_id": "$credit.history.event",
                    "coins": {"$sum": "$credit.history.coins"},
                    "events": {"$sum": 1},
                    "sellers": {"$addToSet": "$_id"},
                }
            },
        ],
    )


async def _credit_by_seller(since: datetime, until: datetime) -> list[dict]:
    """The same credit history as `_credit_events`, but named seller by seller.

    "How much seller credit this week" is not answerable without "to whom" — an
    aggregate tells an owner the size of the exposure and nothing about who to
    ring. Grouped in the database, one row per seller, with the seller's own
    standing carried alongside so the week's movement and what they still owe
    are read on the same line.
    """
    return await _aggregate(
        C.PARTNERS,
        [
            {"$match": {"kind": str(PartnerKind.SELLER)}},
            {
                "$addFields": {
                    "_window": {
                        "$filter": {
                            "input": {"$ifNull": ["$credit.history", []]},
                            "as": "h",
                            "cond": {
                                "$and": [
                                    {"$gte": ["$$h.at", since]},
                                    {"$lt": ["$$h.at", until]},
                                ]
                            },
                        }
                    }
                }
            },
            # A seller with no movement this week but an unpaid balance is still
            # someone's problem, so they are kept.
            {
                "$match": {
                    "$or": [
                        {"_window.0": {"$exists": True}},
                        {"credit.outstanding": {"$gt": 0}},
                    ]
                }
            },
            {
                "$project": {
                    "name": 1,
                    "status": 1,
                    "outstanding": {"$ifNull": ["$credit.outstanding", 0]},
                    "due_at": "$credit.due_at",
                    "events": {"$size": "$_window"},
                    "issued": _credit_sum("_window", "issued"),
                    "repaid": _credit_sum("_window", "repaid"),
                    "recovered": _credit_sum("_window", "recovered"),
                    "written_off": _credit_sum("_window", "written_off"),
                }
            },
            {"$sort": {"issued": -1, "outstanding": -1, "_id": 1}},
        ],
    )


def _credit_sum(field_name: str, event: str) -> dict:
    """Sum one credit event's coins out of a filtered history array."""
    return {
        "$sum": {
            "$map": {
                "input": {
                    "$filter": {
                        "input": f"${field_name}",
                        "as": "e",
                        "cond": {"$eq": ["$$e.event", event]},
                    }
                },
                "as": "e",
                "in": {"$ifNull": ["$$e.coins", 0]},
            }
        }
    }


async def _open_subagency_legs() -> list[dict]:
    """Sub-agency payouts where our money HAS left but leg 2 is unconfirmed.

    `partner_ops.request_subagency_payout` opens both legs at once and closes
    the payout only when the parent confirms it paid the sub. `parent_paid` is
    the state in between: leg 1 executed, so the money is out of this business,
    and leg 2 outstanding, so there is no record the sub-agency ever saw it.

    Deliberately NOT the whole of "not closed". A `pending` payout is a card
    nobody has signed yet — no money has moved, and calling that money stuck at
    a parent would be a false alarm on a report that only works if its alarms
    are true.
    """
    # Imported here rather than at module scope: the states are `partner_ops`'
    # to name, and a literal here would silently stop matching the day that
    # module renames one.
    from app.services.partner_ops import PayoutStatus

    return await _aggregate(
        C.SUBAGENCY_PAYOUTS,
        [
            {"$match": {"status": PayoutStatus.PARENT_PAID}},
            {
                "$group": {
                    "_id": "$sub_id",
                    "open_legs": {"$sum": 1},
                    "amount_minor": {"$sum": {"$ifNull": ["$amount_minor", 0]}},
                    "parent_ids": {"$addToSet": "$parent_id"},
                    "oldest_at": {"$min": "$leg1.paid_at"},
                }
            },
        ],
    )


async def _seller_credit_standing(now: datetime) -> dict:
    """What sellers owe right now, and how much of it is late."""
    rows = await _aggregate(
        C.PARTNERS,
        [
            {"$match": {"kind": str(PartnerKind.SELLER)}},
            {
                "$group": {
                    "_id": None,
                    "outstanding": {"$sum": {"$ifNull": ["$credit.outstanding", 0]}},
                    "sellers": {"$sum": 1},
                    "with_debt": {
                        "$sum": {
                            "$cond": [{"$gt": [{"$ifNull": ["$credit.outstanding", 0]}, 0]}, 1, 0]
                        }
                    },
                    "overdue_coins": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$and": [
                                        {"$gt": [{"$ifNull": ["$credit.outstanding", 0]}, 0]},
                                        _present("credit.due_at"),
                                        {"$lt": ["$credit.due_at", now]},
                                    ]
                                },
                                "$credit.outstanding",
                                0,
                            ]
                        }
                    },
                    "overdue_sellers": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$and": [
                                        {"$gt": [{"$ifNull": ["$credit.outstanding", 0]}, 0]},
                                        _present("credit.due_at"),
                                        {"$lt": ["$credit.due_at", now]},
                                    ]
                                },
                                1,
                                0,
                            ]
                        }
                    },
                }
            },
        ],
    )
    if not rows:
        return {
            "outstanding": 0,
            "sellers": 0,
            "with_debt": 0,
            "overdue_coins": 0,
            "overdue_sellers": 0,
        }
    row = dict(rows[0])
    row.pop("_id", None)
    return row


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _minor_from_major(value: Any) -> int | None:
    """Rupees as the app recorded them → paise. `None` when nothing was recorded.

    None and zero are different facts and are kept apart all the way to the page.
    """
    if value is None:
        return None
    try:
        return int(round(float(value) * 100))
    except (TypeError, ValueError):
        return None


def _agency_label(kind: str) -> str:
    """The words the owner uses: 'main agency' or 'sub-agency'."""
    return "sub-agency" if str(kind) == str(PartnerKind.SUB_AGENCY) else "main agency"


# ── 1. Hosts, one row each ────────────────────────────────────────────────────


async def host_week(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
    thresholds: PayoutThresholds | None = None,
) -> Report:
    """Every host who moved a bean this week: their work, their payout, whether
    they are eligible and — when they are not — by exactly how much they missed.

    Beans come from the ledger. Gifts and call time come from Firestore, because
    that is where the app writes them and there is nowhere else they exist; each
    is fetched separately so that losing one does not cost the others, and a
    column that could not be read is None with a warning rather than zero.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)
    th = thresholds if thresholds is not None else await load_thresholds()

    activity = await _host_bean_activity(since, until)
    partners = await _partner_index()

    warnings: list[str] = list(th.warnings)
    if rt.provisional:
        warnings.append(rt.note)

    # Gifts received, per host. Firestore.
    gifts: dict[str, dict] = {}
    gifts_known = True
    try:
        for event in await _gift_events(since, until):
            if not event["receiver_uid"]:
                continue
            bucket = gifts.setdefault(
                event["receiver_uid"], {"count": 0, "diamonds": 0, "beans": 0}
            )
            bucket["count"] += max(event["quantity"], 1)
            bucket["diamonds"] += event["diamonds"]
            bucket["beans"] += event["beans_earned"]
    except ReportError as exc:
        gifts_known = False
        warnings.append(
            f"GIFTS RECEIVED COULD NOT BE READ. {exc} Those columns are shown as "
            "unknown for every host. They are not zero."
        )

    # Call time, per host. Firestore.
    calls: dict[str, dict] = {}
    calls_known = True
    try:
        for event in await _call_events(since, until):
            if not event["receiver_uid"]:
                continue
            bucket = calls.setdefault(event["receiver_uid"], {"calls": 0, "seconds": 0})
            bucket["calls"] += 1
            bucket["seconds"] += event["seconds"]
    except ReportError as exc:
        calls_known = False
        warnings.append(
            f"CALL ACTIVITY COULD NOT BE READ. {exc} Calls and minutes are shown "
            "as unknown for every host. They are not zero."
        )

    names, name_warnings = await _user_names(row["_id"] for row in activity)
    warnings.extend(name_warnings)

    rows: list[dict] = []
    eligible_count = 0
    total_payout = 0
    eligible_payout = 0
    total_beans = 0
    sub_without_parent = 0

    for row in activity:
        host_id = str(row["_id"])
        beans_earned = int(row["beans_earned"])
        total_beans += beans_earned
        payout_minor, rate_rule = to_inr_minor(beans_earned, str(Currency.BEANS), rt)
        total_payout += payout_minor

        agency_ids = [a for a in (row.get("agency_ids") or []) if a]
        agency_id = str(agency_ids[0]) if agency_ids else ""
        agency = partners.get(agency_id) or {}
        agency_kind = str(agency.get("kind") or "")
        parent = partners.get(str(agency.get("parent_id") or "")) or {}

        eligible, reason = _host_eligibility(beans_earned, payout_minor, th)
        if eligible:
            eligible_count += 1
            eligible_payout += payout_minor

        # Where this host's agency money goes. A sub-agency is never paid
        # directly (4.2.4), so a row that named only the sub would hide the
        # main agency that actually receives it.
        if not agency_id:
            route = "No agency on the movement — nothing bills to any agency"
        elif str(agency_kind) == str(PartnerKind.SUB_AGENCY):
            parent_name = parent.get("name") or str(agency.get("parent_id") or "")
            route = (
                f"Sub-agency. Commission on this host reaches "
                f"{agency.get('name') or agency_id} VIA the main agency "
                f"{parent_name or 'NOT ON RECORD'} — we pay the main agency, the "
                "main agency pays the sub, and an owner confirms the second leg."
            )
            if not parent_name:
                sub_without_parent += 1
        else:
            route = "Main agency. Commission is paid to it directly."

        gift = gifts.get(host_id) if gifts_known else None
        call = calls.get(host_id) if calls_known else None

        rows.append(
            {
                "host_id": host_id,
                "host_name": names.get(host_id) or "",
                "agency_id": agency_id,
                "agency_name": agency.get("name") or ("" if agency_id else ""),
                "agency_type": _agency_label(agency_kind) if agency_id else "",
                "parent_agency_id": str(agency.get("parent_id") or ""),
                "parent_agency_name": parent.get("name") or "",
                "paid_via": route,
                "beans_earned": beans_earned,
                "beans_cashed_out": int(row["beans_cashed_out"]),
                "bean_balance_after": int(row.get("closing") or 0),
                "gifts_received": (gift or {}).get("count") if gifts_known else None,
                "gift_diamonds_received": (gift or {}).get("diamonds") if gifts_known else None,
                "gift_beans_earned": (gift or {}).get("beans") if gifts_known else None,
                "calls_received": (call or {}).get("calls") if calls_known else None,
                "call_minutes": (
                    round((call or {}).get("seconds", 0) / 60, 1) if calls_known else None
                ),
                "payout_due_inr_minor": payout_minor,
                "payout_due_inr": inr(payout_minor),
                "eligible": eligible,
                "eligibility": reason,
                "ledger_movements": int(row["movements"]),
                "last_activity_at": row.get("last_at"),
                "rate_applied": rate_rule,
            }
        )

    if gifts_known and not gifts:
        warnings.append(
            "No gift was recorded in Firestore `giftEvents` for this period. "
            "Note that gifts sent inside a live room are written to "
            "`liveRooms/{room}/gifts` and never to `giftEvents`, so live-room "
            "gifting is absent from this report by construction, not by "
            "measurement."
        )
    if calls_known and not calls:
        warnings.append(
            "No call was recorded in Firestore `platformRevenue` for this "
            "period. Call time is written only by the app's call settlement; a "
            "silent week here means no settled call, not no calling."
        )

    unattributed = sum(1 for r in rows if not r["agency_id"])
    if unattributed:
        warnings.append(
            f"{unattributed} host(s) have no agency on their bean movements "
            "(`meta.agency_id`). They are listed with a blank agency rather than "
            "dropped, and their beans do not bill to any agency — which is also "
            "why they cannot appear in the agency table below."
        )
    if sub_without_parent:
        warnings.append(
            f"WHO GETS PAID IS UNCLEAR FOR {sub_without_parent} HOST(S). Their "
            "agency is a sub-agency with no `parent_id` on its partner record, "
            "and a sub-agency is only ever paid through its parent (4.2.4). "
            "There is no main agency to route that commission to. Fix the "
            "partner record before this week is paid."
        )

    subs = sum(1 for r in rows if r["agency_type"] == "sub-agency")
    if subs:
        warnings.append(
            f"{subs} of these hosts sit under a sub-agency. Money for a "
            "sub-agency does not go to the sub-agency: we pay the MAIN agency "
            "named in the 'Parent agency' column, and the main agency pays the "
            "sub. The 'Paid via' column says so on every row, and the payout is "
            "not closed until an owner confirms the second leg."
        )

    # Said on every run, not only on an empty one: a row count is only ever
    # 'hosts who moved a bean', and the difference matters when someone asks
    # why a host they expected is not on the page.
    warnings.append(DEFINITIONS["host_coverage"])

    report = Report(
        name="weekly_hosts",
        title="Hosts — work, payout and eligibility",
        period=_period(since, until),
        columns=[
            ("host_id", "Host ID"),
            ("host_name", "Host"),
            ("agency_name", "Agency"),
            ("agency_type", "Main or sub"),
            ("parent_agency_name", "Parent agency"),
            ("paid_via", "Paid via"),
            ("beans_earned", "Beans earned"),
            ("beans_cashed_out", "Beans cashed out"),
            ("gifts_received", "Gifts received"),
            ("gift_diamonds_received", "Gift value (diamonds)"),
            ("calls_received", "Calls"),
            ("call_minutes", "Call minutes"),
            ("payout_due_inr_minor", "Payout due (INR minor units)"),
            ("payout_due_inr", "Payout due (INR)"),
            ("eligible", "Eligible"),
            ("eligibility", "Why"),
            ("last_activity_at", "Last activity"),
            ("agency_id", "Agency ID"),
        ],
        rows=rows,
        totals={
            "hosts_with_activity": len(rows),
            "hosts_eligible": eligible_count,
            "hosts_below_threshold": len(rows) - eligible_count,
            "hosts_on_platform": None,  # unknowable here — see host_coverage
            "hosts_under_a_sub_agency": subs,
            "hosts_with_no_agency": unattributed,
            "beans_earned": total_beans,
            "payout_due_all_hosts_inr_minor": total_payout,
            "payout_due_eligible_only_inr_minor": eligible_payout,
            "thresholds": th.as_dict(),
            "gifts_sourced": gifts_known,
            "calls_sourced": calls_known,
        },
        definitions=_definitions(
            "host_payout_due",
            "host_eligibility",
            "host_coverage",
            "subagency_payment_path",
            "payout",
            "currency",
            "source_store",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    report.note_if_empty(
        "No host earned or cashed out a bean in this period. The ledger records "
        "no host activity at all for this week — that is an empty period, not a "
        "week in which every host earned nothing. If hosts were working, their "
        "beans are not reaching the ledger and that is a data problem to chase, "
        "not a payout of zero."
    )
    return report


def _host_eligibility(
    beans: int, payout_minor: int, th: PayoutThresholds
) -> tuple[bool, str]:
    """Eligible or not, and always the figure and the shortfall.

    Pure, so the rule can be tested directly. A host below the line is never
    given a bare "no": 0.3.5 says a payout that differs from expectation gets an
    explanation, and "no" without a number is not one.
    """
    reasons: list[str] = []
    meets_money = payout_minor >= th.min_payout_minor
    if not meets_money:
        short = th.min_payout_minor - payout_minor
        reasons.append(
            f"{rupee_text(payout_minor)} earned against a "
            f"{rupee_text(th.min_payout_minor)} weekly minimum — "
            f"{rupee_text(short)} short"
        )

    meets_beans = True
    if th.min_beans is not None:
        meets_beans = beans >= th.min_beans
        if not meets_beans:
            reasons.append(
                f"{beans:,} beans against a {th.min_beans:,} bean minimum "
                f"({th.min_beans - beans:,} short)"
            )

    if meets_money and meets_beans:
        detail = f"{rupee_text(payout_minor)} earned, at or above the "
        detail += f"{rupee_text(th.min_payout_minor)} weekly minimum"
        if th.min_beans is not None:
            detail += f", and {beans:,} beans at or above the {th.min_beans:,} minimum"
        return True, detail + "."

    return False, "Not eligible: " + "; ".join(reasons) + "."


# ── 2. Agencies, one row each ─────────────────────────────────────────────────


async def agency_week(
    period_label: str,
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Every agency's billing, band, rate and commission for the week.

    The commission engine is called once per agency — the same call the accrual
    makes — so what this report shows and what the agency is actually credited
    cannot drift apart. One agency that cannot be computed is one row that says
    so; it never becomes a zero and it never costs the other rows.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    from app.services import commission as com

    partners = await _partner_index()
    agencies = {
        pid: doc
        for pid, doc in partners.items()
        if str(doc.get("kind")) in {str(PartnerKind.AGENCY), str(PartnerKind.SUB_AGENCY)}
    }

    rows: list[dict] = []
    warnings: list[str] = []
    total_billing = 0
    total_commission = 0
    earning = 0
    failed = 0
    provisional_any = False

    # Sub-agency money leaves as a two-leg payout. An unconfirmed second leg is
    # money out of this business that the sub may never have seen, so it goes on
    # the sub's own row. Read separately: losing it must not cost the table.
    open_legs: dict[str, dict] = {}
    legs_known = True
    try:
        open_legs = {str(r["_id"]): r for r in await _open_subagency_legs()}
    except ReportError as exc:
        legs_known = False
        warnings.append(
            f"OPEN SUB-AGENCY PAYMENT LEGS COULD NOT BE READ. {exc} Whether a "
            "main agency has passed money on to its sub is unknown for every "
            "row below. It is not zero, and it is not 'all confirmed'."
        )

    for agency_id in sorted(agencies):
        partner = agencies[agency_id]
        kind = str(partner.get("kind") or "")
        is_sub = kind == str(PartnerKind.SUB_AGENCY)
        parent = partners.get(str(partner.get("parent_id") or "")) or {}
        parent_name = parent.get("name") or ""

        if not is_sub:
            route = "Main agency — we pay it directly."
        elif parent_name or partner.get("parent_id"):
            route = (
                "Sub-agency — never paid directly. Leg 1: we pay "
                f"{parent_name or str(partner.get('parent_id'))}. Leg 2: that "
                "main agency pays this sub, and an owner records it."
            )
        else:
            route = (
                "SUB-AGENCY WITH NO PARENT ON RECORD — there is no main agency "
                "to route this commission through, so it cannot be paid."
            )

        leg = open_legs.get(agency_id) or {}
        base = {
            "agency_id": agency_id,
            "agency_name": partner.get("name") or "",
            "agency_type": _agency_label(kind),
            "parent_agency_id": str(partner.get("parent_id") or ""),
            "parent_agency_name": parent_name,
            "paid_via": route,
            "status": partner.get("status") or "",
            "open_payment_legs": int(leg.get("open_legs") or 0) if legs_known else None,
            "open_leg_inr_minor": (
                int(leg.get("amount_minor") or 0) if legs_known else None
            ),
        }

        try:
            computed = await com.compute_for_period(
                agency_id, period_label, since, until, partner
            )
        except com.CommissionError as exc:
            failed += 1
            warnings.append(
                f"{base['agency_name'] or agency_id}: commission could not be "
                f"computed — {exc} That row shows unknown, not zero."
            )
            rows.append(
                {
                    **base,
                    "hosts_cashed_out": None,
                    "beans_cashed_out": None,
                    "billing_inr_minor": None,
                    "billing_inr": None,
                    "floor_inr_minor": None,
                    "band": "",
                    "rate_percent": None,
                    "commission_inr_minor": None,
                    "commission_inr": None,
                    "earns_commission": None,
                    "why": f"NOT COMPUTED — {exc}",
                    "provisional": None,
                }
            )
            continue

        breakdown = computed["breakdown"]
        billing = int(computed["billing"]["billing_minor"])
        commission_minor = int(computed["commission_minor"])
        matched = bool(breakdown["matched"])
        total_billing += billing
        total_commission += commission_minor
        if matched and commission_minor > 0:
            earning += 1
        if computed.get("provisional"):
            provisional_any = True

        rows.append(
            {
                **base,
                "hosts_cashed_out": int(computed["billing"]["host_count"]),
                "beans_cashed_out": int(computed["billing"]["beans_cashed_out"]),
                "billing_inr_minor": billing,
                "billing_inr": inr(billing),
                "floor_inr_minor": int(breakdown["floor_minor"]),
                "band": (breakdown["band"] or {}).get("label", "")
                if matched
                else f"below the {rupee_text(int(breakdown['floor_minor']))} floor",
                "rate_percent": breakdown["rate_percent"],
                "commission_inr_minor": commission_minor,
                "commission_inr": inr(commission_minor),
                "earns_commission": matched and commission_minor > 0,
                "why": breakdown["explanation"],
                "provisional": bool(computed.get("provisional")),
            }
        )

    if provisional_any:
        warnings.append(
            "PROVISIONAL — at least one agency's commission was computed from "
            "the documented fallback slab table because the live economy "
            "configuration could not be read. Those figures are not "
            "authoritative and must not be paid without confirming "
            "appConfig/economy."
        )
    if not agencies:
        warnings.append(
            "There are no agency or sub-agency partner records at all. This is "
            "not an agency that billed nothing — it is an empty partner "
            "collection, which is a data problem."
        )

    orphan_subs = [
        r["agency_name"] or r["agency_id"]
        for r in rows
        if r["agency_type"] == "sub-agency" and not r["parent_agency_id"]
    ]
    if orphan_subs:
        warnings.append(
            f"{len(orphan_subs)} SUB-AGENCY(IES) HAVE NO PARENT ON RECORD: "
            f"{', '.join(orphan_subs)}. A sub-agency is only ever paid through "
            "its main agency (4.2.4), so any commission shown for these cannot "
            "be routed to anybody. Their partner records need a `parent_id` "
            "before the week is paid."
        )

    if legs_known:
        stuck = sum(int((open_legs.get(r["agency_id"]) or {}).get("open_legs") or 0) for r in rows)
        stuck_minor = sum(
            int((open_legs.get(r["agency_id"]) or {}).get("amount_minor") or 0) for r in rows
        )
        if stuck:
            warnings.append(
                f"{stuck} SUB-AGENCY PAYOUT(S) WORTH {rupee_text(stuck_minor)} "
                "ARE STILL OPEN. Our money has been paid to the main agency but "
                "no owner has confirmed the main agency passed it on to the sub. "
                "Until leg 2 is confirmed there is no record that the "
                "sub-agency received anything."
            )

    report = Report(
        name="weekly_agencies",
        title="Agencies — billing, band and commission",
        period=_period(since, until),
        columns=[
            ("agency_id", "Agency ID"),
            ("agency_name", "Agency"),
            ("agency_type", "Main or sub"),
            ("parent_agency_name", "Parent agency"),
            ("paid_via", "How it is paid"),
            ("status", "Status"),
            ("hosts_cashed_out", "Hosts who cashed out"),
            ("beans_cashed_out", "Beans cashed out"),
            ("billing_inr_minor", "Billing (INR minor units)"),
            ("billing_inr", "Billing (INR)"),
            ("band", "Band"),
            ("rate_percent", "Rate %"),
            ("commission_inr_minor", "Commission (INR minor units)"),
            ("commission_inr", "Commission (INR)"),
            ("earns_commission", "Earns commission"),
            ("why", "Why"),
            ("open_payment_legs", "Open payment legs"),
            ("open_leg_inr_minor", "Open legs (INR minor units)"),
        ],
        rows=rows,
        totals={
            "period_label": period_label,
            "agencies_on_file": len(agencies),
            "main_agencies": sum(1 for r in rows if r["agency_type"] == "main agency"),
            "sub_agencies": sum(1 for r in rows if r["agency_type"] == "sub-agency"),
            "agencies_earning_commission": earning,
            "agencies_below_floor": len(rows) - earning - failed,
            "agencies_not_computed": failed,
            "sub_agencies_without_a_parent": len(orphan_subs),
            "open_subagency_legs": (
                sum(int(r["open_payment_legs"] or 0) for r in rows) if legs_known else None
            ),
            "open_subagency_legs_inr_minor": (
                sum(int(r["open_leg_inr_minor"] or 0) for r in rows) if legs_known else None
            ),
            "subagency_legs_sourced": legs_known,
            "billing_inr_minor": total_billing,
            "commission_inr_minor": total_commission,
            "commission_inr": inr(total_commission),
            "billing_definition": com.BILLING_DEFINITION,
        },
        definitions=_definitions(
            "agency_commission_eligibility",
            "subagency_payment_path",
            "commission",
            "currency",
            "source_store",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if rows and total_billing == 0 and not failed:
        report.mark_empty(
            "Every agency billed nothing this week. Billing is what an agency's "
            "hosts actually cashed out, so a week in which nobody cashed out "
            "bills nothing everywhere — the zeroes below are the absence of "
            "cash-outs, not a measured result. Those beans will bill in the week "
            "they are paid."
        )
    report.note_if_empty("No agency record exists to report on.")
    return report


# ── 3. Money in ───────────────────────────────────────────────────────────────


async def money_in(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """User recharges and seller credit for the week — how money arrived.

    Recharges are Firestore's record; seller credit is the business record. Both
    are stated with their store, because reconciling them starts with knowing
    which one to believe.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)
    now = datetime.now(timezone.utc)

    rows: list[dict] = []
    totals: dict[str, Any] = {}
    warnings: list[str] = []
    if rt.provisional:
        warnings.append(rt.note)

    # ── Recharges ────────────────────────────────────────────────────────────
    recharges_known = True
    user_total = agency_total = 0
    user_count = agency_count = 0
    unpriced = 0
    try:
        events = await _recharge_events(since, until)
    except ReportError as exc:
        recharges_known = False
        events = []
        warnings.append(
            f"USER RECHARGES COULD NOT BE READ. {exc} No recharge figure appears "
            "below. This is not a week in which nobody recharged."
        )

    if recharges_known:
        for event in events:
            amount = event["amount_inr_minor"]
            if amount is None:
                unpriced += 1
                continue
            if event["recipient_type"] == "agency":
                agency_total += amount
                agency_count += 1
            else:
                user_total += amount
                user_count += 1

        rows.append(
            _money_line(
                "recharge",
                "User recharges — through a coin seller",
                user_count,
                user_total,
                "firestore",
                "rechargeRequests with recipientType 'user', status 'approved', "
                "approvedAt inside the period",
            )
        )
        rows.append(
            _money_line(
                "recharge",
                "User recharges — direct, no seller",
                0,
                0,
                "n/a",
                "STRUCTURAL ZERO. This product has no direct recharge path — no "
                "payment gateway and no in-app billing writes anywhere. Every "
                "recharge goes through a coin seller. This line is zero because "
                "the path does not exist, not because nobody used it.",
            )
        )
        if agency_count:
            rows.append(
                _money_line(
                    "recharge",
                    "Agency wallet top-ups (not user recharges)",
                    agency_count,
                    agency_total,
                    "firestore",
                    "rechargeRequests with recipientType 'agency' — reported "
                    "separately so it is never added into user recharges",
                    subject="all agencies",
                )
            )
        if unpriced:
            warnings.append(
                f"{unpriced} approved recharge(s) carry no readable `amountPaid` "
                "and are excluded from the total rather than counted as zero "
                "rupees. The diamonds were still issued."
            )
        totals.update(
            {
                "user_recharges_count": user_count,
                "user_recharges_inr_minor": user_total,
                "user_recharges_inr": inr(user_total),
                "recharges_via_seller_inr_minor": user_total,
                "recharges_direct_inr_minor": 0,
                "agency_topups_inr_minor": agency_total,
            }
        )

    # ── Seller credit ────────────────────────────────────────────────────────
    credit_known = True
    try:
        by_event = {str(r["_id"]): r for r in await _credit_events(since, until)}
        standing = await _seller_credit_standing(now)
    except ReportError as exc:
        credit_known = False
        by_event, standing = {}, {}
        warnings.append(
            f"SELLER CREDIT COULD NOT BE READ. {exc} No credit figure appears "
            "below, and none is reported as zero."
        )

    # Who, by name. Read separately so that losing the per-seller breakdown
    # does not cost the totals, and vice versa.
    per_seller: list[dict] = []
    per_seller_known = credit_known
    if credit_known:
        try:
            per_seller = await _credit_by_seller(since, until)
        except ReportError as exc:
            per_seller_known = False
            warnings.append(
                f"WHICH SELLER HELD WHICH CREDIT COULD NOT BE READ. {exc} The "
                "totals below are still the real totals; only the name against "
                "each one is missing. No seller is reported as owing nothing."
            )

    if credit_known:
        for event, label, note in (
            ("issued", "Seller credit advanced this week", "coins lent to sellers"),
            ("repaid", "Seller credit repaid this week", "coins returned by sellers"),
            (
                "recovered",
                "Seller credit recovered this week",
                "coins taken back from a seller's stock, penalties included",
            ),
            (
                "written_off",
                "Seller credit written off this week",
                "bad debt an owner signed off — a real loss",
            ),
        ):
            row = by_event.get(event) or {}
            coins = int(row.get("coins") or 0)
            minor, rule = to_inr_minor(coins, str(Currency.COINS), rt)
            rows.append(
                {
                    "block": "seller_credit",
                    "subject": "all sellers",
                    "subject_id": "",
                    "line": label,
                    "items": int(row.get("events") or 0),
                    "native_amount": coins,
                    "native_unit": "coins",
                    "inr_minor": minor,
                    "inr": inr(minor),
                    "store": "ledger",
                    "detail": f"partners.credit.history event '{event}' — {note}; valued at {rule}",
                }
            )

        outstanding = int(standing.get("outstanding") or 0)
        overdue = int(standing.get("overdue_coins") or 0)
        out_minor, coin_rule = to_inr_minor(outstanding, str(Currency.COINS), rt)
        over_minor, _ = to_inr_minor(overdue, str(Currency.COINS), rt)
        rows.append(
            {
                "block": "seller_credit",
                "subject": "all sellers",
                "subject_id": "",
                "line": "Seller credit outstanding, as at now",
                "items": int(standing.get("with_debt") or 0),
                "native_amount": outstanding,
                "native_unit": "coins",
                "inr_minor": out_minor,
                "inr": inr(out_minor),
                "store": "ledger",
                "detail": (
                    "partners.credit.outstanding, summed across sellers. A "
                    f"point-in-time figure, not a movement. Valued at {coin_rule}"
                ),
            }
        )
        rows.append(
            {
                "block": "seller_credit",
                "subject": "all sellers",
                "subject_id": "",
                "line": "…of which overdue",
                "items": int(standing.get("overdue_sellers") or 0),
                "native_amount": overdue,
                "native_unit": "coins",
                "inr_minor": over_minor,
                "inr": inr(over_minor),
                "store": "ledger",
                "detail": "outstanding with credit.due_at already past",
            }
        )
        totals.update(
            {
                "credit_advanced_coins": int((by_event.get("issued") or {}).get("coins") or 0),
                "credit_repaid_coins": int((by_event.get("repaid") or {}).get("coins") or 0),
                "credit_recovered_coins": int((by_event.get("recovered") or {}).get("coins") or 0),
                "credit_written_off_coins": int(
                    (by_event.get("written_off") or {}).get("coins") or 0
                ),
                "credit_outstanding_coins": outstanding,
                "credit_outstanding_inr_minor": out_minor,
                "credit_overdue_coins": overdue,
                "sellers_overdue": int(standing.get("overdue_sellers") or 0),
            }
        )
        if standing.get("overdue_sellers"):
            warnings.append(
                f"{standing['overdue_sellers']} seller(s) are past their credit "
                f"due date, owing {rupee_text(over_minor)} between them. They are "
                "blocked from taking new inventory until it is cleared."
            )

    # ── Seller credit, seller by seller ──────────────────────────────────────
    if per_seller_known:
        for entry in per_seller:
            seller_id = str(entry.get("_id") or "")
            outstanding_coins = int(entry.get("outstanding") or 0)
            issued_coins = int(entry.get("issued") or 0)
            out_seller_minor, _ = to_inr_minor(
                outstanding_coins, str(Currency.COINS), rt
            )
            due_at = entry.get("due_at")
            late = bool(
                outstanding_coins > 0
                and isinstance(due_at, datetime)
                and _utc(due_at) < now
            )
            movement = (
                f"advanced {issued_coins:,}, repaid "
                f"{int(entry.get('repaid') or 0):,}, recovered "
                f"{int(entry.get('recovered') or 0):,}, written off "
                f"{int(entry.get('written_off') or 0):,} (coins)"
            )
            rows.append(
                {
                    "block": "seller_credit_by_seller",
                    "subject": entry.get("name") or seller_id,
                    "subject_id": seller_id,
                    "line": f"Seller credit — {entry.get('name') or seller_id}",
                    "items": int(entry.get("events") or 0),
                    "native_amount": outstanding_coins,
                    "native_unit": "coins",
                    "inr_minor": out_seller_minor,
                    "inr": inr(out_seller_minor),
                    "store": "ledger",
                    "detail": (
                        f"This week: {movement}. Still owed now: "
                        f"{outstanding_coins:,} coins"
                        + (
                            f", due {_utc(due_at).date().isoformat()}"
                            if isinstance(due_at, datetime)
                            else ", no due date on record"
                        )
                        + (" — OVERDUE." if late else ".")
                    ),
                }
            )
        if not per_seller:
            warnings.append(
                "No seller holds credit and none moved this week. Every seller "
                "record was read and every one of them is square — this is a "
                "measured result, not a missing table."
            )
        totals["sellers_with_credit_named"] = len(per_seller)

    totals["recharges_sourced"] = recharges_known
    totals["seller_credit_sourced"] = credit_known
    totals["seller_credit_named_by_seller"] = per_seller_known

    report = Report(
        name="weekly_money_in",
        title="Money in — user recharges and seller credit",
        period=_period(since, until),
        columns=[
            ("line", "Line"),
            ("subject", "Who"),
            ("items", "Items"),
            ("native_amount", "Amount (native units)"),
            ("native_unit", "Unit"),
            ("inr_minor", "INR (minor units)"),
            ("inr", "INR"),
            ("store", "Source store"),
            ("detail", "Definition"),
        ],
        rows=rows,
        totals=totals,
        definitions=_definitions("recharge", "seller_credit", "channel", "currency", "source_store"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if not recharges_known and not credit_known:
        report.mark_empty(
            "Neither recharges nor seller credit could be read, so this section "
            "reports nothing at all. Every figure is unknown. None of it is zero."
        )
    elif recharges_known and credit_known and not user_count and not by_event and not per_seller:
        report.mark_empty(
            "No recharge was approved and no seller credit moved in this period, "
            "and no seller is carrying a balance. Both stores were read "
            "successfully and both are genuinely empty for this week."
        )
    return report


def _money_line(
    block: str,
    line: str,
    items: int,
    minor: int,
    store: str,
    detail: str,
    subject: str = "all users",
) -> dict:
    return {
        "block": block,
        "subject": subject,
        "subject_id": "",
        "line": line,
        "items": items,
        "native_amount": inr(minor),
        "native_unit": "INR",
        "inr_minor": minor,
        "inr": inr(minor),
        "store": store,
        "detail": detail,
    }


# ── 4. Leaderboards ───────────────────────────────────────────────────────────


async def leaderboards(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
    top_n: int = TOP_N,
) -> Report:
    """Who recharged most, who received the most gifts, who played lucky hardest.

    Three boards, three separate reads. Each one that cannot be produced is
    named, with the reason, and no ranking is fabricated to fill the space.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)
    top_n = max(1, min(int(top_n), 100))

    rows: list[dict] = []
    warnings: list[str] = []
    produced: list[str] = []
    missing: list[str] = []
    if rt.provisional:
        warnings.append(rt.note)

    # ── Highest-recharging users ─────────────────────────────────────────────
    try:
        by_user: dict[str, dict] = {}
        for event in await _recharge_events(since, until):
            if event["recipient_type"] != "user" or not event["buyer_uid"]:
                continue
            amount = event["amount_inr_minor"]
            if amount is None:
                continue
            bucket = by_user.setdefault(
                event["buyer_uid"],
                {"minor": 0, "count": 0, "diamonds": 0, "name": event["buyer_name"]},
            )
            bucket["minor"] += amount
            bucket["count"] += 1
            bucket["diamonds"] += event["diamonds"]
        rows.extend(
            _board(
                "Highest-recharging users",
                by_user,
                key=lambda v: v["minor"],
                top_n=top_n,
                value=lambda v: v["minor"],
                unit="inr_minor",
                detail=lambda v: f"{v['count']} recharge(s), {v['diamonds']:,} diamonds",
                store="firestore",
                empty_note=(
                    "NOBODY RECHARGED IN THIS PERIOD. `rechargeRequests` was "
                    "read successfully and no request reached 'approved' inside "
                    "the window. There is no top spender to name — this is an "
                    "empty board, not a board of zero-rupee spenders."
                ),
            )
        )
        produced.append("Highest-recharging users")
        if not by_user:
            warnings.append(
                "Nobody recharged in this period. The board is on the page "
                "saying so rather than being left out."
            )
    except ReportError as exc:
        missing.append("Highest-recharging users")
        warnings.append(f"HIGHEST-RECHARGING USERS: not produced. {exc}")

    # ── Gifts received, and lucky spend — one read, two boards ───────────────
    try:
        events = await _gift_events(since, until)
    except ReportError as exc:
        missing.extend(["Hosts by gift value received", "Highest lucky-gift spend"])
        warnings.append(
            f"HOSTS BY GIFT RECEIVED and HIGHEST LUCKY-GIFT SPEND: not produced. {exc}"
        )
        events = None

    if events is not None:
        received: dict[str, dict] = {}
        lucky: dict[str, dict] = {}
        for event in events:
            if event["receiver_uid"]:
                bucket = received.setdefault(
                    event["receiver_uid"], {"diamonds": 0, "beans": 0, "count": 0}
                )
                bucket["diamonds"] += event["diamonds"]
                bucket["beans"] += event["beans_earned"]
                bucket["count"] += max(event["quantity"], 1)
            if event["lucky"] and event["sender_uid"]:
                bucket = lucky.setdefault(
                    event["sender_uid"], {"diamonds": 0, "count": 0}
                )
                bucket["diamonds"] += event["diamonds"]
                bucket["count"] += max(event["quantity"], 1)

        rows.extend(
            _board(
                "Hosts by gift value received",
                received,
                key=lambda v: v["diamonds"],
                top_n=top_n,
                value=lambda v: v["diamonds"],
                unit="diamonds",
                detail=lambda v: f"{v['count']:,} gift(s), {v['beans']:,} beans earned",
                store="firestore",
                empty_note=(
                    "NO GIFT WAS RECEIVED IN THIS PERIOD. `giftEvents` was read "
                    "successfully and holds no send inside the window, so no "
                    "host can be ranked. Note that live-room gifts are written "
                    "to `liveRooms/{room}/gifts` and never to `giftEvents`, so "
                    "they are absent from this board by construction."
                ),
            )
        )
        produced.append("Hosts by gift value received")

        rows.extend(
            _board(
                "Highest lucky-gift spend",
                lucky,
                key=lambda v: v["diamonds"],
                top_n=top_n,
                value=lambda v: v["diamonds"],
                unit="diamonds",
                detail=lambda v: f"{v['count']:,} lucky gift(s) sent",
                store="firestore",
                empty_note=(
                    "NO LUCKY GIFT WAS SENT IN THIS PERIOD. None were sent — "
                    "this is not a spend of ₹0. A lucky play is an ordinary "
                    "`giftEvents` document whose catalogue category is 'lucky'; "
                    "the collection was read and contains none."
                ),
            )
        )
        produced.append("Highest lucky-gift spend")
        if not lucky:
            warnings.append(
                "No lucky gift was sent in this period. A lucky play is an "
                "ordinary `giftEvents` document whose catalogue category is "
                "'lucky'; there is no separate lucky-gift collection."
            )
        if not received:
            warnings.append(
                "No gift was received by anyone in this period. The board is on "
                "the page saying so rather than being left out, because a board "
                "that is missing reads as a board that was not produced."
            )

    # A row with no rank is a board saying "nobody", not a competitor.
    ranked = [r for r in rows if r["rank"] is not None]

    # Names for everyone who appears.
    names, name_warnings = await _user_names(r["subject_id"] for r in rows)
    warnings.extend(name_warnings)
    for row in ranked:
        row["subject_name"] = names.get(row["subject_id"], "")

    warnings.append(
        "GAME SPEND IS NOT ON THIS REPORT. Bets are written to Firestore "
        "`gamingBets`, but that collection matches no rule in firestore.rules "
        "and therefore falls to the catch-all deny — no bet can currently be "
        "written by a client at all. A board over it would rank an empty "
        "collection and read as 'nobody played'. Lucky-gift spend above is the "
        "game-like spend this system does record."
    )

    report = Report(
        name="weekly_leaderboards",
        title="Leaderboards — recharges, gifts received, lucky-gift spend",
        period=_period(since, until),
        columns=[
            ("board", "Board"),
            ("rank", "Rank"),
            ("subject_name", "Who"),
            ("subject_id", "ID"),
            ("value", "Value"),
            ("unit", "Unit"),
            ("value_inr", "INR"),
            ("detail", "Detail"),
            ("store", "Source store"),
        ],
        rows=rows,
        totals={
            "boards_produced": produced,
            "boards_not_produced": missing,
            "boards_with_no_entries": [
                r["board"] for r in rows if r["rank"] is None
            ],
            "entries_ranked": len(ranked),
            "top_n": top_n,
        },
        definitions=_definitions("recharge", "currency", "source_store"),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if missing and not produced:
        report.mark_empty(
            "None of the three leaderboards could be produced. Each one's reason "
            "is above. No ranking is shown, and no board is shown as empty."
        )
    elif produced and not ranked:
        # Every board produced a "nobody" row, so `rows` is not empty even
        # though nothing was ranked. `mark_empty` is what says so.
        report.mark_empty(
            "Every board was produced and every one of them is empty: nobody "
            "recharged, nobody received a gift and nobody played a lucky gift "
            "in this period. The rows below are those three statements, not "
            "three rankings of zero."
        )
    report.note_if_empty("No board was produced and no reason was recorded.")
    return report


def _board(
    name: str,
    data: Mapping[str, dict],
    *,
    key,
    top_n: int,
    value,
    unit: str,
    detail,
    store: str,
    empty_note: str,
) -> list[dict]:
    """One leaderboard's rows, ranked, longest first.

    A board that was produced and has nobody on it emits one row saying so in
    words, with a null value. It never disappears from the table and it never
    shows a zero: a missing board reads as "we did not look", and a zero reads
    as "somebody spent nothing", and neither is what happened.
    """
    if not data:
        return [
            {
                "board": name,
                "rank": None,
                "subject_id": "",
                "subject_name": "—",
                "value": None,
                "unit": unit,
                "value_inr": None,
                "detail": empty_note,
                "store": store,
            }
        ]

    ordered = sorted(data.items(), key=lambda kv: (-key(kv[1]), kv[0]))[:top_n]
    out: list[dict] = []
    for position, (subject_id, entry) in enumerate(ordered, start=1):
        amount = value(entry)
        out.append(
            {
                "board": name,
                "rank": position,
                "subject_id": subject_id,
                "subject_name": entry.get("name", ""),
                "value": amount,
                "unit": unit,
                "value_inr": inr(amount) if unit == "inr_minor" else None,
                "detail": detail(entry),
                "store": store,
            }
        )
    return out


# ── 5. The P&L, in the owner's own definition ─────────────────────────────────
#
#     "profit is like the money we received for selling coin - our all
#      expenditure"


@dataclass(slots=True)
class ExpenditureLine:
    """One thing that went out, or one thing nobody records going out."""

    key: str
    label: str
    inr_minor: int | None       # None means NOT RECORDED — never zero
    definition: str
    store: str

    @property
    def known(self) -> bool:
        return self.inr_minor is not None


def profit_statement(
    revenue_minor: int, lines: Sequence[ExpenditureLine]
) -> dict:
    """Revenue − expenditure, and an honest account of what is missing.

    Pure arithmetic over already-decided figures, so it can be tested on its own
    and so there is exactly one place the owner's definition is implemented.

    A line whose value is unknown does not become zero and does not stop the
    statement. It reduces the statement's standing instead: with anything
    missing, the profit below is an **upper bound**, and `complete` is False so
    that every renderer has to say so.
    """
    known = [line for line in lines if line.known]
    unknown = [line for line in lines if not line.known]
    expenditure = sum(int(line.inr_minor or 0) for line in known)
    profit = int(revenue_minor) - expenditure
    return {
        "revenue_inr_minor": int(revenue_minor),
        "expenditure_inr_minor": expenditure,
        "profit_inr_minor": profit,
        "profit_inr": inr(profit),
        "margin_pct": (
            round(profit / revenue_minor * 100, 3) if revenue_minor else None
        ),
        "complete": not unknown,
        "unknown_lines": [line.key for line in unknown],
        "known_lines": [line.key for line in known],
    }


#: What each expense category *is*, in one sentence, appended to that line's
#: definition whether the line is known or missing. Written once so the reader
#: gets the same explanation either way.
_CATEGORY_NOTES: dict[str, str] = {
    str(ExpenseCategory.GATEWAY_FEES): (
        "What a payment gateway keeps out of money the business received. "
        "appConfig/economy.commissionConfig carries rates used for quoting; "
        "this line is the fee actually paid, on an expense card."
    ),
    str(ExpenseCategory.BINANCE_FEES): (
        "Binance and foreign settlement fees actually paid. "
        "appConfig/economy.commissionConfig carries a binanceFeePercent, but "
        "that is a quoting rate and was never a booked cost; this line is the "
        "fee that left the business."
    ),
    str(ExpenseCategory.TAXES): (
        "Tax actually paid in this period. "
        "appConfig/economy.commissionConfig carries a govtTaxPercent, but that "
        "is a quoting rate; this line is the payment."
    ),
    str(ExpenseCategory.STAFF_SALARIES): (
        "Employees and contractors. NOT the card type `salary_request`, which "
        "pays HOSTS and is already counted under host payouts above — the two "
        "have similar names and are different money. This is the business's "
        "largest fixed cost and it is the one most worth entering."
    ),
    str(ExpenseCategory.INFRASTRUCTURE): (
        "Servers, Firebase, hosting, SendGrid, tooling and software invoices."
    ),
    str(ExpenseCategory.MARKETING): (
        "Campaigns, broadcasts and promoter spend. Promotional coin grants are "
        "separately excluded from revenue as non-cash credits; this line is the "
        "money spent running the campaign."
    ),
    str(ExpenseCategory.REFUNDS_TO_USERS): (
        "Money returned to a user. The card type `refund` and the audit action "
        "`refund` both exist and no service in this codebase creates a refund "
        "card, so nothing is double-counted here: this line counts expense "
        "cards in the `refunds_to_users` category and nothing else."
    ),
    str(ExpenseCategory.OTHER): (
        "One-off costs that belong in none of the seven categories above."
    ),
}


def _expense_line(key: str, spend: dict[str, dict] | None) -> ExpenditureLine:
    """One expenditure line, from the recorded expense cards for the period.

    A category with entries becomes a figure. A category with none stays
    **unknown** — not zero. An empty `staff_salaries` does not mean nobody was
    paid this month; it means nobody entered it, and the two must not look the
    same on a page an owner makes decisions from.
    """
    label = CATEGORY_LABELS.get(key, key)
    note = _CATEGORY_NOTES.get(key, "")

    if spend is None:
        return ExpenditureLine(
            key,
            label,
            None,
            f"NOT KNOWN FOR THIS PERIOD. {note} Recorded expenditure could not "
            "be read at all for this window, so this cost is unknown rather "
            "than zero and the profit below is an upper bound by at least that "
            "amount.",
            "none",
        )

    entry = spend.get(key)
    if not entry:
        return ExpenditureLine(
            key,
            label,
            None,
            f"NOT RECORDED FOR THIS PERIOD. {note} No operating-expense card in "
            f"category `{key}` was executed inside this window. That is not the "
            "same as spending nothing: the cost is shown as unknown rather than "
            "zero, and the profit below is an upper bound by at least that "
            "amount. Record it as an expense card — raised by anyone, verified "
            "by a second person, signed by an owner, paid — and this line "
            "becomes a figure.",
            "none",
        )

    periods = ", ".join(entry["periods"]) or "unlabelled"
    return ExpenditureLine(
        key,
        label,
        int(entry["inr_minor"]),
        f"{note} {entry['cards']} executed operating-expense card(s) in "
        f"category `{key}` with executed_at inside this window, at "
        f"{entry['rates_applied'] and '; '.join(entry['rates_applied'])}. Cash "
        f"basis — the money actually left. Labelled as belonging to: {periods} "
        "(the month the cost is FOR; the figure is counted in the period it was "
        "PAID).",
        "ledger",
    )


async def profit_and_loss(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """The owner's definition: money received for selling coins − all expenditure.

    Every line states where it comes from and every line reconciles to the
    ledger or to a signed card.

    The seven costs this statement used to name and could not subtract —
    gateway fees, settlement fees, tax, salaries, infrastructure, marketing and
    refunds — are now recordable, on an operating-expense card that goes through
    the same five stages as every other movement of money. Each becomes a real
    figure in the period a card in that category was **paid**, and each stays
    **unknown** in a period where no card in that category was paid. So the
    profit stops being labelled an upper bound only when every one of the seven
    has something behind it; one recorded expense does not make the number look
    complete, which is the failure mode this design exists to prevent.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    cash = await cash_position(since, until, rt)
    revenue = int(cash.totals["receipts_inr_minor"])
    warnings = [w for w in cash.warnings]

    payout_rows, _payouts_total, payout_warnings = await _executed_payouts(
        since, until, rt
    )
    warnings.extend(payout_warnings)

    host_types = {
        str(CardType.HOST_WITHDRAWAL),
        str(CardType.WEEKLY_PAYOUT),
        str(CardType.SALARY_REQUEST),
    }
    agency_types = {str(CardType.COMMISSION_PAYOUT), str(CardType.SUBAGENCY_PAYOUT)}
    host_payouts = sum(r["inr_minor"] for r in payout_rows if r["card_type"] in host_types)
    agency_paid = sum(r["inr_minor"] for r in payout_rows if r["card_type"] in agency_types)

    written_off = 0
    try:
        for row in await _credit_events(since, until):
            if str(row["_id"]) == "written_off":
                written_off, _ = to_inr_minor(
                    int(row.get("coins") or 0), str(Currency.COINS), rt
                )
    except ReportError as exc:
        warnings.append(
            f"Seller credit written off could not be read ({exc}), so that cost "
            "is unknown for this period rather than zero, and the profit below "
            "is an upper bound by at least that amount."
        )
        written_off = None

    # Recorded operating cost, by category, for this window. A store that cannot
    # answer makes every category unknown — never zero.
    spend: dict[str, dict] | None
    try:
        spend, spend_warnings = await _expenditure_by_category(since, until, rt)
        warnings.extend(spend_warnings)
    except ReportError as exc:
        spend = None
        warnings.append(
            f"Recorded operating expenditure could not be read ({exc}), so every "
            "operating cost is unknown for this period rather than zero, and the "
            "profit below is an upper bound by at least that amount."
        )

    lines = [
        ExpenditureLine(
            "host_payouts",
            "Host payouts executed",
            host_payouts,
            "Executed cards of type host_withdrawal, weekly_payout or "
            "salary_request with executed_at in the period. Money that actually "
            "left; a signed-but-unexecuted card is not a cost.",
            "ledger",
        ),
        ExpenditureLine(
            "agency_commission_paid",
            "Agency and sub-agency commission paid",
            agency_paid,
            "Executed cards of type commission_payout or subagency_payout. This "
            "is commission SETTLED in the period, not commission earned — what "
            "was earned and not yet paid is a liability, not an expenditure.",
            "ledger",
        ),
        ExpenditureLine(
            "seller_credit_written_off",
            "Seller credit written off",
            written_off,
            "partners.credit.history entries with event 'written_off' dated in "
            "the period, valued at the coin rate. A signed bad-debt write-off is "
            "a real loss.",
            "ledger",
        ),
    ]

    # The seven operating costs, in the order the owner thinks about them. Each
    # is a figure if a card in that category was paid inside this window, and
    # unknown if none was — a category with no entries never reads as zero.
    lines.extend(_expense_line(str(cat), spend) for cat in REPORTED_CATEGORIES)

    # `other` is the eighth category and is treated differently on purpose. An
    # empty `staff_salaries` means the payroll was not entered; an empty `other`
    # means there were no one-offs, or that a one-off was not entered, and this
    # statement cannot tell those apart — so an empty `other` is not counted as a
    # missing line (it would make the statement permanently incomplete and the
    # phrase "upper bound" would stop meaning anything). It gets a line whenever
    # it has entries, so money recorded there is always subtracted, and a
    # standing note below whenever it does not.
    other_key = str(ExpenseCategory.OTHER)
    other_recorded = bool(spend and spend.get(other_key))
    if other_recorded:
        lines.append(_expense_line(other_key, spend))

    statement = profit_statement(revenue, lines)

    rows: list[dict] = [
        {
            "line": "Revenue — money received",
            "kind": "revenue",
            "inr_minor": revenue,
            "inr": inr(revenue),
            "store": "ledger",
            "definition": DEFINITIONS["revenue"],
        }
    ]
    for line in lines:
        rows.append(
            {
                "line": line.label,
                "kind": "expenditure",
                "inr_minor": -line.inr_minor if line.known else None,
                "inr": inr(-line.inr_minor) if line.known else None,
                "store": line.store,
                "definition": line.definition,
            }
        )
    rows.append(
        {
            "line": "Total expenditure (recorded lines only)",
            "kind": "subtotal",
            "inr_minor": -statement["expenditure_inr_minor"],
            "inr": inr(-statement["expenditure_inr_minor"]),
            "store": "ledger",
            "definition": "The sum of the expenditure lines above that are recorded.",
        }
    )
    rows.append(
        {
            "line": (
                "PROFIT — money received for selling coins less all "
                "expenditure (the owner's own definition)"
            ),
            "kind": "profit",
            "inr_minor": statement["profit_inr_minor"],
            "inr": statement["profit_inr"],
            "store": "ledger",
            "definition": DEFINITIONS["profit"],
        }
    )
    rows.append(
        {
            "line": "Margin",
            "kind": "ratio",
            "inr_minor": None,
            "inr": None,
            "store": "ledger",
            "definition": (
                f"{statement['margin_pct']}% of revenue."
                if statement["margin_pct"] is not None
                else "Undefined — revenue is zero, so a margin percentage has no "
                "meaning and is reported as null rather than as 0%."
            ),
        }
    )

    missing_categories = [
        key
        for key in statement["unknown_lines"]
        if key in {str(c) for c in REPORTED_CATEGORIES}
    ]

    if not statement["complete"]:
        warnings.append(
            "THIS PROFIT IS AN UPPER BOUND. "
            f"{len(statement['unknown_lines'])} expenditure line(s) have nothing "
            "recorded for this period and could not be subtracted: "
            f"{', '.join(statement['unknown_lines'])}. The real profit is lower "
            "by whatever those came to. They are shown as unknown rather than "
            "zero so that the gap is visible on the face of the statement."
        )
    if missing_categories:
        warnings.append(
            f"{len(missing_categories)} OPERATING COST CATEGORIES HAVE NO ENTRY "
            f"FOR THIS PERIOD: {', '.join(missing_categories)}. Each of them can "
            "now be recorded — raise an operating-expense card in that category, "
            "have a second person verify it, an owner sign it, and pay it — and "
            "each will become a real figure here the moment one is. Until every "
            "one of them has something behind it, this statement is subtracting "
            "part of the cost of running the company and calling the remainder "
            "profit. One recorded expense does not make the number complete. "
            "This is a decision for an owner: either every operating cost gets "
            "entered, or the word 'profit' on this page keeps meaning 'gross "
            "contribution before running the company'."
        )
    if not other_recorded:
        warnings.append(
            "No one-off expenditure was recorded in the 'other' category this "
            "period. That line is therefore absent rather than zero: this "
            "statement cannot tell a period with no one-off costs from a period "
            "whose one-off costs nobody entered, and it does not count the "
            "difference against the seven categories above, which it can."
        )
    if statement["complete"]:
        warnings.append(
            "Every expenditure line on this statement has a figure behind it, "
            "so the profit below is NOT an upper bound — it is revenue less "
            "everything this business recorded going out, on a cash basis. It "
            "is only as true as the entries: a cost that was never raised on a "
            "card is still invisible here, and no report can detect one."
        )
    if revenue == 0:
        warnings.append(
            "Revenue is zero for this period, so the margin is undefined and is "
            "reported as null."
        )
    if rt.provisional:
        warnings.append(rt.note)

    report = Report(
        name="weekly_profit_and_loss",
        title="Profit and loss — money received for selling coins, less everything out",
        period=_period(since, until),
        columns=[
            ("line", "Line"),
            ("kind", "Kind"),
            ("inr_minor", "INR (minor units)"),
            ("inr", "INR"),
            ("store", "Source store"),
            ("definition", "Definition"),
        ],
        rows=rows,
        totals={
            **statement,
            "revenue_inr": inr(revenue),
            "expenditure_inr": inr(statement["expenditure_inr_minor"]),
            "host_payouts_inr_minor": host_payouts,
            "agency_commission_paid_inr_minor": agency_paid,
            "total_paid_out_inr_minor": host_payouts + agency_paid,
            "total_paid_out_inr": inr(host_payouts + agency_paid),
            "profit_definition_is_the_owners": True,
            "seller_credit_written_off_inr_minor": written_off,
            # Recorded operating cost, by category, with the card count behind
            # each figure. A category absent from this map had no expense paid
            # in the window and is unknown on the statement, not zero.
            "operating_expenditure_by_category": (
                {k: dict(v) for k, v in spend.items()} if spend is not None else None
            ),
            "operating_expenditure_inr_minor": (
                sum(int(v["inr_minor"]) for v in spend.values())
                if spend is not None
                else None
            ),
            "operating_categories_missing": missing_categories,
            "expenditure_basis": "cash — a cost counts in the period it was paid",
        },
        definitions=_definitions(
            "profit",
            "revenue",
            "operating_expenditure",
            "payout",
            "commission",
            "currency",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )
    if revenue == 0 and statement["expenditure_inr_minor"] == 0:
        report.mark_empty(
            "No money came in and none went out in this period. Every figure on "
            "the statement is zero because nothing happened, not because the "
            "business took in as much as it spent."
        )
    return report


# ══════════════════════════════════════════════════════════════════════════════
#  CHANCE MECHANICS — THE MONEY. Spec 8B.7, 8B.8, 8B.9 and 8B.9A
# ══════════════════════════════════════════════════════════════════════════════
#
# Three reports, because an owner asks three different questions about the same
# rounds and answering them on one page would make each of them harder to read.
#
#   * `chance_revenue`      — 8B.7. Gross gaming revenue as its own line, per
#                             mechanic, per country, per day, with the actual
#                             RTP beside it. Plus the three things 8B.7 asks to
#                             be *verified* rather than assumed: whether any
#                             host or agency takes a share, whether stakes and
#                             payouts reach the ledger, and what is sitting
#                             withheld waiting for an owner's signature.
#   * `chance_margin`       — 8B.8. The margin model. Diamonds returned to a
#                             player are not a cost; the only cash outflow is a
#                             bean becoming a payout. Bean-payout ratio per
#                             mechanic, against the 50% / 5% / 0% reference.
#   * `chance_cannibalisation` — 8B.9 and 8B.9A. Whether the games are feeding
#                             the host economy or eating it.
#
# `app/services/chance.py` has a `margin_report` of its own and this does not
# replace it. That one is Ops-and-Finance's live position in **diamonds** —
# exposure against reserve, actual against configured RTP with a significance
# test, per mechanic, right now (8B.5.6). These are the **money** reports: INR
# minor units, an explicit half-open window, a CSV, and a definition attached to
# every figure. Neither module computes the other's numbers.

#: The ledger actions a stake and a payout are written under. Both come from
#: `chance.Act`, so "what a game round did to a balance" has one spelling.
CHANCE_STAKE_ACTIONS = [ChanceAct.STAKE]
CHANCE_PAYOUT_ACTIONS = [ChanceAct.PAYOUT]
CHANCE_MONEY_ACTIONS = [ChanceAct.STAKE, ChanceAct.PAYOUT]

#: Only a settled round is money. A round that voided staked nothing and paid
#: nothing; counting one would drag both the revenue and the RTP toward zero.
CHANCE_SETTLED = str(RoundStatus.SETTLED)

#: 8B.8.3, as written: normal gift creates 50% beans, lucky gift 5%, games none.
#:
#: **These are unit rates — beans created per diamond consumed — not value
#: ratios.** The distinction is the whole reason this constant is commented at
#: all. A bean and a diamond are not worth the same: at the live rates a diamond
#: is ₹0.0239 and a bean is ₹0.01, so a mechanic creating 50 beans per 100
#: diamonds is turning ₹2.39 of consumption into ₹0.50 of future cash cost — a
#: 50% unit rate and a ~20.9% value ratio. 8B.8.5 asks for the value ratio,
#: because that is the one that governs profitability; 8B.8.3's figures are the
#: unit rate. Both are reported, on the same row, each named for what it is.
REFERENCE_BEAN_CREATION_PCT: dict[str, float] = {
    "normal_gift": 50.0,
    "lucky_gift": 5.0,
    "game": 0.0,
}

#: How far back `chance_cannibalisation` looks to decide that a gift is a
#: player's **first**. There is no lifetime "has ever gifted" flag anywhere in
#: this business, and reconstructing one would mean scanning `giftEvents` from
#: the beginning of the product on every weekly run. So "first time" here means
#: "no gift in the ninety days before this period", the report says exactly
#: that in its own definition, and the number is never described as a lifetime
#: first.
FIRST_GIFT_LOOKBACK_DAYS = 90

#: 8B.9.3 says host earnings must "hold steady" while game revenue rises. Steady
#: needs a number or the rule cannot be reported against, and a week-on-week
#: figure that moves by a percent or two has not moved. Within ±5% is holding.
HOST_EARNINGS_STEADY_BAND_PCT = 5.0


DEFINITIONS.update(
    {
        "gross_gaming_revenue": (
            "GROSS GAMING REVENUE = total staked − total paid out, over settled "
            "rounds only, in diamonds, valued at the diamond rate in force. It "
            "is a REVENUE LINE OF ITS OWN (8B.7.1) and is never folded into "
            "gifting or calls: a diamond staked on a game is not a diamond "
            "given to a host, and adding them would hide which of the two is "
            "growing. It is also not cash — a stake was paid for in cash when "
            "the diamonds were bought, and that receipt is already counted once "
            "in the cash position. GGR is what the business KEPT of diamonds "
            "already sold; the cash statement is where the money arrived. A "
            "round that voided is excluded, because it staked nothing and paid "
            "nothing."
        ),
        "actual_rtp": (
            "ACTUAL RTP = diamonds paid out ÷ diamonds staked, for the same "
            "rounds the GGR line is made of, so that GGR = staked × (1 − actual "
            "RTP) exactly. CONFIGURED RTP is the stake-weighted mean of the "
            "`rtp_ppm_at_play` pinned on each round — the RTP of the odds table "
            "that round was actually drawn from, not whatever is live now. "
            "`chance.rtp_divergence` (8B.5.1) compares the same two figures on "
            "the payable stake and applies a significance test to the gap; this "
            "is the money version of the same comparison and the two agree "
            "wherever the multiplier applies to the total stake (8B.3.1). A gap "
            "here is a configuration error, an exploit or a bug (8B.5.2)."
        ),
        "chance_partner_share": (
            "Hosts and agencies earn nothing from a chance mechanic unless a "
            "share is deliberately designed, and if one ever is it is "
            "configured and signed like any other rate (8B.7.3). This line is "
            "MEASURED, not asserted: it counts every ledger movement in the "
            "period whose action is a chance stake or payout and which either "
            "sits on a holder that is not the player, or carries a "
            "`meta.agency_id` that would make it billable to an agency. Zero "
            "movements means no share exists in the data — not that nobody "
            "looked."
        ),
        "chance_ledger_evidence": (
            "8B.7.4 — a stake and a payout are ledger entries like any other "
            "movement of money and appear in the audit log. This line counts "
            "them: settled rounds against the ledger movements written under "
            "`chance.stake` and `chance.payout` for the same window. They are "
            "written by `money.apply_movement`, which inserts the ledger row "
            "and the audit row inside one transaction, so a round that moved a "
            "diamond without an audit entry is not a state this system can "
            "reach. A count that does not match the rounds is a real problem "
            "and is reported as one."
        ),
        "chance_withheld": (
            "A payout a ceiling refused to pay in full (8B.4.4). The round "
            "records what the table would have paid and what was actually "
            "credited; the difference is withheld and is NOT written off. It is "
            "an exception for a person to settle on a signed money card with a "
            "reason (8B.7.5), and nothing in this system credits, reverses or "
            "expires one. It is reported here as an open obligation, because a "
            "withheld payout nobody has settled is money the business has "
            "decided about but not told anybody about."
        ),
        "bean_creation": (
            "BEAN CREATION RATE = beans created ÷ diamonds consumed, in units, "
            "as a percentage. This is the figure 8B.8.3 quotes — normal gift "
            "50%, lucky gift 5%, games none — and it is a UNIT rate, not a "
            "money one. BEAN-PAYOUT RATIO is the money one: the INR value of "
            "the beans created ÷ the INR value of the diamonds consumed, at the "
            "rates in force (8B.8.5). The two differ because a bean and a "
            "diamond are not worth the same. Both are on every row, each named."
        ),
        "bean_payout_ratio_per_mechanic": (
            "Cash out as a share of diamond value consumed, FOR ONE MECHANIC, "
            "on a CREATED basis: the INR value of the beans that mechanic "
            "created ÷ the INR value of the diamonds it consumed (8B.8.5). "
            "Created, not paid, because a bean is fungible — once it is on a "
            "host's balance nothing records which gift made it, so a bean "
            "actually cashed out cannot be attributed back to a mechanic. Every "
            "bean created is a future payout, so this is the cash cost that "
            "mechanic committed the business to in the period. The realised "
            "business-wide figure — beans that actually became payouts ÷ "
            "diamonds consumed — is `bean_payout_ratio` in `margin_report`, and "
            "it is reported on this page beside the mechanics so the two can be "
            "read together rather than confused. LOWER IS BETTER."
        ),
        "diamonds_consumed": (
            "What a mechanic actually consumed, which is not the same as what "
            "passed through it. For gifting and calls, every diamond spent is "
            "consumed — nothing comes back. For a game, a diamond returned to "
            "the player as a payout was NOT consumed: it was already sold for "
            "cash and returning it recirculates inventory rather than costing "
            "anything (8B.8.1). So a game's consumption is staked − paid out, "
            "which is the same figure as its gross gaming revenue. That is why "
            "8B.8.4 calls games the highest-margin mechanic available: every "
            "diamond staked and not returned is realised margin, and no bean is "
            "ever created against it."
        ),
        "diamonds_per_bean_payout": (
            "8B.8.2 — the real profit measure: diamonds consumed per unit of "
            "bean payout, not house edge. Reported two ways on each row: in "
            "units (diamonds consumed ÷ beans created) and in money (INR of "
            "diamond value consumed ÷ INR of bean cash cost created). Higher is "
            "better — it is how much consumption the business gets for each "
            "rupee of cash it will one day pay out. Where a mechanic creates no "
            "bean at all there is no denominator, so it is reported as NULL "
            "with the reason, never as zero and never as a very large number."
        ),
        "host_earnings_week": (
            "Total host earnings for the period: beans credited to host "
            "balances inside the window, valued at the bean rate in force. It "
            "is the same figure, from the same pull, that the host table's "
            "'payout due' column is made of — one definition of what a week's "
            "work earned, not two. An ACTIVE HOST is one who was credited at "
            "least one bean in the window; a host who earned nothing is not "
            "counted as active and is not counted as a zero either, because "
            "this server cannot see the host roll (10.23)."
        ),
        "diamond_spend_share": (
            "Where the diamonds went (8B.9.4): the share of diamond spend "
            "absorbed by games against the share spent on gifting. Games = "
            "diamonds staked on settled chance rounds, at the gross stake, "
            "because that is what left the player's balance and was therefore "
            "not available to spend on a host. Gifting = diamonds spent on "
            "gifts. Call spend is reported beside them and excluded from the "
            "share, so the two figures in the share are the two 8B.9 puts in "
            "tension with each other."
        ),
        "winnings_to_hosts": (
            "THE GOVERNING METRIC (8B.9A.4): the share of game winnings "
            "subsequently spent on hosts. Numerator = diamonds a player spent "
            "on gifts AFTER their first winning round inside this period. "
            "Denominator = everything players won in the period. 'Subsequently' "
            "is enforced on the timestamps, and the whole calculation sits "
            "inside the one window so week can be compared with week. It can "
            "exceed 100%, which means players gifted more than they won and is "
            "good news. IF IT FALLS, THE FUNNEL IS LEAKING and games are "
            "becoming an end in themselves."
        ),
        "winnings_recycled": (
            "8B.9A.5 — of what players won, how much went back into games and "
            "how much went to hosts. Recycled into games = stake placed by a "
            "player in a round after they had already won something in this "
            "period, so a player's opening stake is never counted as recycled "
            "winnings. Spent on gifting = the numerator of the governing metric "
            "above. The two are measured over the same players and the same "
            "window and are directly comparable."
        ),
        "first_time_gifters": (
            "8B.9A.5 — players who moved from games to gifting for the first "
            "time: they played at least one round in this period, they sent a "
            "gift in this period, and they sent no gift in the "
            f"{FIRST_GIFT_LOOKBACK_DAYS} days before it. THAT IS NOT A LIFETIME "
            "FIRST. Nothing in this business records whether a user has ever "
            "gifted, and reconstructing it would mean scanning the whole gift "
            "history on every weekly run, so the lookback is stated instead of "
            "the claim being overstated. If the lookback cannot be read the "
            "count is UNKNOWN, never zero."
        ),
        "retained_non_spenders": (
            "8B.9A.6 — players retained by games who spend nothing on a host: "
            "they played at least one round in this period and sent no gift in "
            "it. THEY ARE COUNTED AS RETAINED, NOT AS FAILED MONETISATION. Most "
            "users will never spend on a host (8B.9A.1); a retained "
            "non-spending player is audience for the hosts and future "
            "conversion, and the only reason this line exists is so nobody "
            "reads it as a loss. Where recharges can be read, the count of "
            "those who also put no money in at all is shown beside it — the "
            "audience that costs nothing to keep."
        ),
        "cannibalisation_verdict": (
            "8B.9.3 — the rule this report exists to report against: healthy is "
            "GAME REVENUE RISING WHILE HOST EARNINGS HOLD STEADY. Falling host "
            "earnings alongside rising game revenue means the ecosystem is "
            "being consumed. Both figures are compared with the immediately "
            "preceding window of the same length. 'Holding steady' is a change "
            f"within ±{HOST_EARNINGS_STEADY_BAND_PCT:g}%, stated so the rule "
            "can be applied rather than argued about. Where the preceding "
            "window cannot be read there is NO VERDICT — it is reported as "
            "unknown, never as healthy."
        ),
    }
)


def _ratio_pct(numerator: int | float, denominator: int | float) -> float | None:
    """A percentage, or None when there is nothing to divide by.

    Never zero for an absent denominator. A bean-payout ratio of 0% reads as
    perfect margin and an RTP of 0% reads as a mechanic that pays nobody; both
    are the opposite of "we did not measure this".
    """
    if not denominator:
        return None
    return round(numerator / denominator * 100, 3)


def _change_pct(now: int | float | None, before: int | float | None) -> float | None:
    """Week-on-week change, or None when the comparison cannot be made."""
    if now is None or before is None or not before:
        return None
    return round((now - before) / abs(before) * 100, 3)


# ── The raw pulls, one per store ──────────────────────────────────────────────


async def _chance_round_flow(since: datetime, until: datetime) -> dict:
    """Settled rounds, grouped in the database by mechanic, country and day.

    Returns `{"rows": [...], "players": n}`. The distinct player count is taken
    in the same pipeline over all rounds, because summing the per-row counts
    would count a player active in two countries — or on two days — twice.
    """
    grouped = [
        {
            "$group": {
                "_id": {
                    "mechanic_id": "$mechanic_id",
                    "country": "$country",
                    "day": "$_day",
                },
                "staked": {"$sum": {"$ifNull": ["$total_stake", 0]}},
                "paid_out": {"$sum": {"$ifNull": ["$payout", 0]}},
                "withheld": {"$sum": {"$ifNull": ["$withheld", 0]}},
                # Stake-weighted configured RTP. Weighted by stake and not by
                # round, because a report that averaged a ₹1 round and a ₹10,000
                # round equally would answer a question nobody asked.
                "configured_num": {
                    "$sum": {
                        "$multiply": [
                            {"$ifNull": ["$total_stake", 0]},
                            {"$ifNull": ["$rtp_ppm_at_play", 0]},
                        ]
                    }
                },
                "stake_with_configured_rtp": {
                    "$sum": {
                        "$cond": [
                            {"$gt": [{"$ifNull": ["$rtp_ppm_at_play", 0]}, 0]},
                            {"$ifNull": ["$total_stake", 0]},
                            0,
                        ]
                    }
                },
                "capped_rounds": {
                    "$sum": {
                        "$cond": [
                            {
                                "$or": [
                                    {"$eq": ["$capped", True]},
                                    {"$eq": ["$ceiling_capped", True]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
                "rounds": {"$sum": 1},
                "player_set": {"$addToSet": "$player_uid"},
                "versions": {"$addToSet": "$config_version"},
            }
        },
        {
            "$project": {
                "staked": 1,
                "paid_out": 1,
                "withheld": 1,
                "configured_num": 1,
                "stake_with_configured_rtp": 1,
                "capped_rounds": 1,
                "rounds": 1,
                "versions": 1,
                "players": {"$size": "$player_set"},
            }
        },
        {"$sort": {"_id.day": 1, "_id.mechanic_id": 1, "_id.country": 1}},
    ]
    overall = [
        {"$group": {"_id": None, "player_set": {"$addToSet": "$player_uid"}}},
        {"$project": {"players": {"$size": "$player_set"}}},
    ]
    facets = await _aggregate(
        C.CHANCE_ROUNDS,
        [
            {
                "$match": {
                    "status": CHANCE_SETTLED,
                    "played_at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$addFields": {
                    # `exposure_day` is the business day the exposure ceilings
                    # were consumed against, written on the round itself. Using
                    # it means "per day" here and "per day" in the ceiling that
                    # suspended the mechanic mean the same day.
                    "_day": {
                        "$ifNull": [
                            "$exposure_day",
                            {
                                "$dateToString": {
                                    "format": "%Y-%m-%d",
                                    "date": "$played_at",
                                    "timezone": "UTC",
                                }
                            },
                        ]
                    }
                }
            },
            {"$facet": {"grouped": grouped, "overall": overall}},
        ],
    )
    if not facets:
        return {"rows": [], "players": 0}
    doc = facets[0]
    overall_rows = doc.get("overall") or []
    return {
        "rows": list(doc.get("grouped") or []),
        "players": int((overall_rows[0] or {}).get("players") or 0) if overall_rows else 0,
    }


async def _chance_mechanic_index() -> dict[str, dict]:
    """Every mechanic by id: its name, its kind and whether it is suspended."""
    try:
        cursor = _db()[C.CHANCE_MECHANICS].find(
            {}, {"name": 1, "kind": 1, "suspended": 1, "live_version": 1}
        )
        return {str(doc["_id"]): doc async for doc in cursor}
    except PyMongoError as exc:
        raise DataUnavailable(
            f"The chance mechanics could not be read ({exc}), so no round can "
            "be named or classified. Nothing is reported unclassified."
        ) from exc


async def _chance_ledger_movements(since: datetime, until: datetime) -> list[dict]:
    """Every ledger movement a chance round wrote, grouped. Spec 8B.7.3 / 8B.7.4.

    This is the pull that answers both of 8B.7's "verify, do not assume"
    questions at once: the stakes and payouts are here because they are ledger
    entries, and anything sitting on a holder who is not the player — or
    carrying the `meta.agency_id` the commission engine bills on — is a partner
    share, which 8B.7.3 says should not exist unless somebody designed one.
    """
    return await _aggregate(
        C.LEDGER,
        [
            {
                "$match": {
                    "at": {"$gte": since, "$lt": until},
                    "action": {"$in": CHANCE_MONEY_ACTIONS},
                }
            },
            {
                "$addFields": {
                    "_agency_attributed": _present("meta.agency_id"),
                }
            },
            {
                "$group": {
                    "_id": {
                        "action": "$action",
                        "holder_type": "$holder_type",
                        "currency": "$currency",
                        "agency_attributed": "$_agency_attributed",
                    },
                    "amount": {"$sum": "$amount"},
                    "movements": {"$sum": 1},
                    "holder_set": {"$addToSet": "$holder_id"},
                }
            },
            {
                "$project": {
                    "amount": 1,
                    "movements": 1,
                    "holders": {"$size": "$holder_set"},
                }
            },
            {"$sort": {"_id.action": 1, "_id.holder_type": 1}},
        ],
    )


async def _chance_withheld(since: datetime, until: datetime) -> list[dict]:
    """Rounds where a ceiling withheld part of a payout. Spec 8B.4.4 / 8B.7.5."""
    return await _aggregate(
        C.CHANCE_ROUNDS,
        [
            {
                "$match": {
                    "withheld": {"$gt": 0},
                    "played_at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$group": {
                    "_id": "$mechanic_id",
                    "withheld": {"$sum": "$withheld"},
                    "paid": {"$sum": {"$ifNull": ["$payout", 0]}},
                    "rounds": {"$sum": 1},
                    "player_set": {"$addToSet": "$player_uid"},
                    "oldest_at": {"$min": "$played_at"},
                }
            },
            {
                "$project": {
                    "withheld": 1,
                    "paid": 1,
                    "rounds": 1,
                    "oldest_at": 1,
                    "players": {"$size": "$player_set"},
                }
            },
            {"$sort": {"withheld": -1}},
        ],
    )


async def _chance_adjustment_cards(since: datetime, until: datetime) -> list[dict]:
    """Money cards raised to adjust a game outcome. Spec 8B.7.5.

    Selected by the round id on the card rather than by card type, because the
    type such a card would carry is a decision nobody has had to make yet: no
    service in this codebase creates one. The query is written anyway so that
    the day somebody does, it appears on this report without a code change —
    and until then the report says the count is a measured zero and names the
    path that does not exist, which is not the same as saying none was needed.
    """
    return await _aggregate(
        C.CARDS,
        [
            {
                "$match": {
                    "created_at": {"$gte": since, "$lt": until},
                    "$expr": {
                        "$or": [
                            _present("payload.round_id"),
                            _present("payload.chance_round_id"),
                            _present("meta.round_id"),
                        ]
                    },
                }
            },
            {
                "$group": {
                    "_id": {"type": "$type", "stage": "$stage"},
                    "cards": {"$sum": 1},
                    "amount": {"$sum": {"$abs": {"$ifNull": ["$amount", 0]}}},
                    "signed": {
                        "$sum": {
                            "$cond": [{"$ifNull": ["$signed_by", False]}, 1, 0]
                        }
                    },
                }
            },
        ],
    )


async def _chance_player_activity(since: datetime, until: datetime) -> list[dict]:
    """Per player: staked, won, when they first won, and what they staked after.

    `staked_after_first_win` is the 8B.9A.5 "recycled into games" figure and it
    is computed in the database, in one pass, with a running total of what the
    player had won **before** the current round. A player's opening stake is
    therefore never counted as recycled winnings, which is the whole point of
    the word "recycled".
    """
    return await _aggregate(
        C.CHANCE_ROUNDS,
        [
            {
                "$match": {
                    "status": CHANCE_SETTLED,
                    "played_at": {"$gte": since, "$lt": until},
                }
            },
            {
                "$setWindowFields": {
                    "partitionBy": "$player_uid",
                    "sortBy": {"played_at": 1},
                    "output": {
                        "_won_before": {
                            "$sum": {"$ifNull": ["$payout", 0]},
                            # Everything up to but NOT including this round.
                            "window": {"documents": ["unbounded", -1]},
                        }
                    },
                }
            },
            {
                "$group": {
                    "_id": "$player_uid",
                    "staked": {"$sum": {"$ifNull": ["$total_stake", 0]}},
                    "won": {"$sum": {"$ifNull": ["$payout", 0]}},
                    "rounds": {"$sum": 1},
                    "winning_rounds": {
                        "$sum": {
                            "$cond": [{"$gt": [{"$ifNull": ["$payout", 0]}, 0]}, 1, 0]
                        }
                    },
                    "staked_after_first_win": {
                        "$sum": {
                            "$cond": [
                                {"$gt": ["$_won_before", 0]},
                                {"$ifNull": ["$total_stake", 0]},
                                0,
                            ]
                        }
                    },
                    "first_played_at": {"$min": "$played_at"},
                    "first_win_at": {
                        "$min": {
                            "$cond": [
                                {"$gt": [{"$ifNull": ["$payout", 0]}, 0]},
                                "$played_at",
                                None,
                            ]
                        }
                    },
                    "mechanics": {"$addToSet": "$mechanic_id"},
                }
            },
            {"$sort": {"won": -1}},
        ],
    )


# ── 8B.7 — Gross gaming revenue as its own revenue line ───────────────────────


async def chance_revenue(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Gross gaming revenue, per mechanic, per country, per day, with the RTP.

    Spec 8B.7.1 and 8B.7.2. Underneath the table, the three things 8B.7 asks to
    be checked rather than taken on trust: whether any host or agency takes a
    share (8B.7.3), whether the stakes and payouts reached the ledger (8B.7.4),
    and what is sitting withheld waiting for an owner's signature (8B.7.5).
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    warnings: list[str] = []
    if rt.provisional:
        warnings.append(rt.note)

    flow = await _chance_round_flow(since, until)
    detail = flow["rows"]
    distinct_players = flow["players"]

    mechanics: dict[str, dict] = {}
    mechanics_known = True
    try:
        mechanics = await _chance_mechanic_index()
    except ReportError as exc:
        mechanics_known = False
        warnings.append(
            f"THE MECHANIC REGISTER COULD NOT BE READ. {exc} Every row below "
            "still carries its real figures and its mechanic id; the name and "
            "the kind — game, lucky gift or event — are shown as unknown rather "
            "than guessed at. No revenue figure is affected."
        )

    def kind_of(mechanic_id: str) -> str | None:
        if not mechanics_known:
            return None
        return str((mechanics.get(mechanic_id) or {}).get("kind") or "") or None

    def name_of(mechanic_id: str) -> str | None:
        if not mechanics_known:
            return None
        return str((mechanics.get(mechanic_id) or {}).get("name") or "") or None

    rows: list[dict] = []
    staked_total = paid_total = withheld_total = 0
    rounds_total = capped_total = 0
    row_value_sum = 0
    by_mechanic: dict[str, dict] = {}
    by_country: dict[str, dict] = {}
    by_kind: dict[str, dict] = {}

    def _bucket(store: dict, key: str) -> dict:
        return store.setdefault(
            key,
            {"staked": 0, "paid_out": 0, "withheld": 0, "rounds": 0, "configured_num": 0,
             "stake_with_configured_rtp": 0},
        )

    for group in detail:
        gid = group.get("_id") or {}
        mechanic_id = str(gid.get("mechanic_id") or "")
        country = str(gid.get("country") or "")
        day = str(gid.get("day") or "")
        staked = int(group.get("staked") or 0)
        paid = int(group.get("paid_out") or 0)
        withheld = int(group.get("withheld") or 0)
        ggr = staked - paid

        ggr_minor, diamond_rule = to_inr_minor(ggr, str(Currency.DIAMONDS), rt)
        staked_minor, _ = to_inr_minor(staked, str(Currency.DIAMONDS), rt)
        paid_minor, _ = to_inr_minor(paid, str(Currency.DIAMONDS), rt)

        staked_total += staked
        paid_total += paid
        withheld_total += withheld
        rounds_total += int(group.get("rounds") or 0)
        capped_total += int(group.get("capped_rounds") or 0)
        row_value_sum += ggr_minor

        configured_num = int(group.get("configured_num") or 0)
        configured_stake = int(group.get("stake_with_configured_rtp") or 0)
        configured_pct = (
            round(configured_num / staked / 10_000, 3) if staked and configured_num else None
        )
        actual_pct = _ratio_pct(paid, staked)

        for store, key in ((by_mechanic, mechanic_id), (by_country, country)):
            bucket = _bucket(store, key)
            bucket["staked"] += staked
            bucket["paid_out"] += paid
            bucket["withheld"] += withheld
            bucket["rounds"] += int(group.get("rounds") or 0)
            bucket["configured_num"] += configured_num
            bucket["stake_with_configured_rtp"] += configured_stake
        kind = kind_of(mechanic_id)
        if kind:
            bucket = _bucket(by_kind, kind)
            bucket["staked"] += staked
            bucket["paid_out"] += paid
            bucket["withheld"] += withheld
            bucket["rounds"] += int(group.get("rounds") or 0)
            bucket["configured_num"] += configured_num
            bucket["stake_with_configured_rtp"] += configured_stake

        rows.append(
            {
                "scope": "mechanic_country_day",
                "day": day,
                "mechanic_id": mechanic_id,
                "mechanic": name_of(mechanic_id),
                "kind": kind,
                "country": country,
                "rounds": int(group.get("rounds") or 0),
                "players": int(group.get("players") or 0),
                "staked_diamonds": staked,
                "paid_out_diamonds": paid,
                "ggr_diamonds": ggr,
                "ggr_inr_minor": ggr_minor,
                "ggr_inr": inr(ggr_minor),
                "staked_inr_minor": staked_minor,
                "paid_out_inr_minor": paid_minor,
                "actual_rtp_percent": actual_pct,
                "configured_rtp_percent": configured_pct,
                "rtp_gap_pp": (
                    round(actual_pct - configured_pct, 3)
                    if actual_pct is not None and configured_pct is not None
                    else None
                ),
                "withheld_diamonds": withheld,
                "capped_rounds": int(group.get("capped_rounds") or 0),
                "config_versions": sorted(
                    int(v) for v in (group.get("versions") or []) if v is not None
                ),
                "detail": (
                    f"{staked:,} staked − {paid:,} paid out = {ggr:,} diamonds, "
                    f"valued at {diamond_rule}"
                ),
            }
        )

    def _rollup(scope: str, store: dict[str, dict], label_key: str) -> None:
        for key in sorted(store):
            bucket = store[key]
            ggr = bucket["staked"] - bucket["paid_out"]
            minor, rule = to_inr_minor(ggr, str(Currency.DIAMONDS), rt)
            configured_pct = (
                round(bucket["configured_num"] / bucket["staked"] / 10_000, 3)
                if bucket["staked"] and bucket["configured_num"]
                else None
            )
            actual_pct = _ratio_pct(bucket["paid_out"], bucket["staked"])
            rows.append(
                {
                    "scope": scope,
                    "day": "",
                    "mechanic_id": key if label_key == "mechanic_id" else "",
                    "mechanic": name_of(key) if label_key == "mechanic_id" else "",
                    "kind": (
                        kind_of(key)
                        if label_key == "mechanic_id"
                        else (key if label_key == "kind" else None)
                    ),
                    "country": key if label_key == "country" else "",
                    "rounds": bucket["rounds"],
                    "players": None,
                    "staked_diamonds": bucket["staked"],
                    "paid_out_diamonds": bucket["paid_out"],
                    "ggr_diamonds": ggr,
                    "ggr_inr_minor": minor,
                    "ggr_inr": inr(minor),
                    "staked_inr_minor": to_inr_minor(
                        bucket["staked"], str(Currency.DIAMONDS), rt
                    )[0],
                    "paid_out_inr_minor": to_inr_minor(
                        bucket["paid_out"], str(Currency.DIAMONDS), rt
                    )[0],
                    "actual_rtp_percent": actual_pct,
                    "configured_rtp_percent": configured_pct,
                    "rtp_gap_pp": (
                        round(actual_pct - configured_pct, 3)
                        if actual_pct is not None and configured_pct is not None
                        else None
                    ),
                    "withheld_diamonds": bucket["withheld"],
                    "capped_rounds": None,
                    "config_versions": [],
                    "detail": (
                        f"Every day in the period, rolled up. "
                        f"{bucket['staked']:,} staked − {bucket['paid_out']:,} "
                        f"paid out, valued at {rule}. Players are not summed "
                        "here — one player active on two days is one player, "
                        "and this row cannot see that."
                    ),
                }
            )

    _rollup("mechanic_total", by_mechanic, "mechanic_id")
    _rollup("country_total", by_country, "country")
    if by_kind:
        _rollup("kind_total", by_kind, "kind")

    ggr_total = staked_total - paid_total
    ggr_total_minor, total_rule = to_inr_minor(ggr_total, str(Currency.DIAMONDS), rt)
    staked_total_minor, _ = to_inr_minor(staked_total, str(Currency.DIAMONDS), rt)
    paid_total_minor, _ = to_inr_minor(paid_total, str(Currency.DIAMONDS), rt)
    actual_total_pct = _ratio_pct(paid_total, staked_total)

    rows.append(
        {
            "scope": "gross_gaming_revenue",
            "day": "",
            "mechanic_id": "",
            "mechanic": "ALL MECHANICS",
            "kind": None,
            "country": "all",
            "rounds": rounds_total,
            "players": distinct_players,
            "staked_diamonds": staked_total,
            "paid_out_diamonds": paid_total,
            "ggr_diamonds": ggr_total,
            "ggr_inr_minor": ggr_total_minor,
            "ggr_inr": inr(ggr_total_minor),
            "staked_inr_minor": staked_total_minor,
            "paid_out_inr_minor": paid_total_minor,
            "actual_rtp_percent": actual_total_pct,
            "configured_rtp_percent": None,
            "rtp_gap_pp": None,
            "withheld_diamonds": withheld_total,
            "capped_rounds": capped_total,
            "config_versions": [],
            "detail": (
                "GROSS GAMING REVENUE — its own revenue line (8B.7.1), reported "
                "apart from gifting and apart from calls. "
                f"{staked_total:,} diamonds staked − {paid_total:,} paid out = "
                f"{ggr_total:,} diamonds, valued at {total_rule}."
            ),
        }
    )

    # ── 8B.7.3 / 8B.7.4 — the ledger, and who took a share out of it ─────────
    partner_movements: list[dict] | None = []
    partner_take = 0
    partner_rows = 0
    stake_movements = payout_movements = 0
    try:
        partner_movements = await _chance_ledger_movements(since, until)
    except ReportError as exc:
        partner_movements = None
        warnings.append(
            "WHETHER ANY HOST OR AGENCY TOOK A SHARE OF THESE ROUNDS COULD NOT "
            f"BE CHECKED. {exc} The line below is UNKNOWN. It is not a "
            "statement that nobody took a share — nobody was able to look."
        )

    if partner_movements is not None:
        for group in partner_movements:
            gid = group.get("_id") or {}
            action = str(gid.get("action") or "")
            holder_type = str(gid.get("holder_type") or "")
            attributed = bool(gid.get("agency_attributed"))
            movements = int(group.get("movements") or 0)
            if action == str(ChanceAct.STAKE):
                stake_movements += movements
            elif action == str(ChanceAct.PAYOUT):
                payout_movements += movements
            if holder_type != str(HolderType.USER) or attributed:
                partner_rows += 1
                partner_take += abs(int(group.get("amount") or 0))
                rows.append(
                    {
                        "scope": "partner_share",
                        "day": "",
                        "mechanic_id": "",
                        "mechanic": f"{holder_type} — {action}",
                        "kind": None,
                        "country": "",
                        "rounds": movements,
                        "players": int(group.get("holders") or 0),
                        "staked_diamonds": None,
                        "paid_out_diamonds": None,
                        "ggr_diamonds": None,
                        "ggr_inr_minor": None,
                        "ggr_inr": None,
                        "staked_inr_minor": None,
                        "paid_out_inr_minor": None,
                        "actual_rtp_percent": None,
                        "configured_rtp_percent": None,
                        "rtp_gap_pp": None,
                        "withheld_diamonds": None,
                        "capped_rounds": None,
                        "config_versions": [],
                        "detail": (
                            "A SHARE OF A CHANCE MECHANIC IS REACHING SOMEBODY "
                            "WHO IS NOT THE PLAYER. "
                            f"{movements:,} movement(s) worth "
                            f"{abs(int(group.get('amount') or 0)):,} "
                            f"{gid.get('currency')} on {holder_type} holders"
                            + (", carrying meta.agency_id" if attributed else "")
                            + ". 8B.7.3 permits this only where the share was "
                            "deliberately designed, and if it was it must be a "
                            "configured rate on a card an owner signed. Find "
                            "the configuration or stop the movement."
                        ),
                    }
                )

        if not partner_rows:
            rows.append(
                {
                    "scope": "partner_share",
                    "day": "",
                    "mechanic_id": "",
                    "mechanic": "Hosts and agencies",
                    "kind": None,
                    "country": "all",
                    "rounds": 0,
                    "players": 0,
                    "staked_diamonds": None,
                    "paid_out_diamonds": None,
                    "ggr_diamonds": None,
                    "ggr_inr_minor": 0,
                    "ggr_inr": 0.0,
                    "staked_inr_minor": None,
                    "paid_out_inr_minor": None,
                    "actual_rtp_percent": None,
                    "configured_rtp_percent": None,
                    "rtp_gap_pp": None,
                    "withheld_diamonds": None,
                    "capped_rounds": None,
                    "config_versions": [],
                    "detail": (
                        "NO HOST AND NO AGENCY EARNS ANYTHING FROM A CHANCE "
                        "MECHANIC. A MEASURED ZERO, NOT AN ASSUMPTION: every "
                        "chance stake and chance payout in this period sat on a "
                        "player's own balance, in diamonds, and none carried "
                        "the meta.agency_id an agency would be billed on. No "
                        "share is configured anywhere and no code path creates "
                        "one — 8B.7.3 says that is the default and that any "
                        "share would have to be a signed, versioned rate."
                    ),
                }
            )

        ledger_moves = stake_movements + payout_movements
        rows.append(
            {
                "scope": "ledger_evidence",
                "day": "",
                "mechanic_id": "",
                "mechanic": "Stakes and payouts in the ledger",
                "kind": None,
                "country": "all",
                "rounds": ledger_moves,
                "players": None,
                "staked_diamonds": None,
                "paid_out_diamonds": None,
                "ggr_diamonds": None,
                "ggr_inr_minor": None,
                "ggr_inr": None,
                "staked_inr_minor": None,
                "paid_out_inr_minor": None,
                "actual_rtp_percent": None,
                "configured_rtp_percent": None,
                "rtp_gap_pp": None,
                "withheld_diamonds": None,
                "capped_rounds": None,
                "config_versions": [],
                "detail": (
                    f"8B.7.4 — VERIFIED, not assumed. {stake_movements:,} "
                    f"`chance.stake` and {payout_movements:,} `chance.payout` "
                    f"movements are in the ledger for this period against "
                    f"{rounds_total:,} settled round(s). Both are written by "
                    "money.apply_movement, which inserts the ledger row and the "
                    "audit row in one transaction, so a movement without an "
                    "audit entry is not a state this system can reach."
                ),
            }
        )
        if rounds_total and stake_movements != rounds_total:
            warnings.append(
                f"STAKES AND ROUNDS DO NOT AGREE. {rounds_total:,} settled "
                f"round(s) in this period against {stake_movements:,} "
                "`chance.stake` ledger movement(s). Every settled round takes "
                "its stake through the ledger, so these should be equal. A "
                "difference is either a round settled outside this window's "
                "stake — a play that crossed midnight — or a real gap between "
                "the round record and the money. Reconcile before the figures "
                "above are used."
            )

    # ── 8B.7.5 — withheld payouts and manual adjustments ─────────────────────
    withheld_groups: list[dict] | None
    try:
        withheld_groups = await _chance_withheld(since, until)
    except ReportError as exc:
        withheld_groups = None
        warnings.append(
            f"WITHHELD PAYOUTS COULD NOT BE READ. {exc} Whether a ceiling held "
            "money back in this period is UNKNOWN, not zero."
        )

    withheld_open = 0
    if withheld_groups is not None:
        for group in withheld_groups:
            mechanic_id = str(group.get("_id") or "")
            amount = int(group.get("withheld") or 0)
            withheld_open += amount
            minor, rule = to_inr_minor(amount, str(Currency.DIAMONDS), rt)
            rows.append(
                {
                    "scope": "withheld_exception",
                    "day": "",
                    "mechanic_id": mechanic_id,
                    "mechanic": name_of(mechanic_id),
                    "kind": kind_of(mechanic_id),
                    "country": "",
                    "rounds": int(group.get("rounds") or 0),
                    "players": int(group.get("players") or 0),
                    "staked_diamonds": None,
                    "paid_out_diamonds": int(group.get("paid") or 0),
                    "ggr_diamonds": None,
                    "ggr_inr_minor": minor,
                    "ggr_inr": inr(minor),
                    "staked_inr_minor": None,
                    "paid_out_inr_minor": None,
                    "actual_rtp_percent": None,
                    "configured_rtp_percent": None,
                    "rtp_gap_pp": None,
                    "withheld_diamonds": amount,
                    "capped_rounds": None,
                    "config_versions": [],
                    "detail": (
                        f"{amount:,} diamonds ({rule}) were withheld from "
                        f"{group.get('rounds')} round(s) across "
                        f"{group.get('players')} player(s) because a ceiling "
                        "bound (8B.4.4). NOT WRITTEN OFF and NOT AUTOMATICALLY "
                        "PAID. Each is an exception for a person to settle on a "
                        "money card with an owner's signature and a reason "
                        "(8B.7.5). Oldest in this period: "
                        f"{group.get('oldest_at')}."
                    ),
                }
            )
        if withheld_open:
            warnings.append(
                f"{withheld_open:,} DIAMONDS OF PAYOUT ARE WITHHELD AND "
                "UNSETTLED. A ceiling refused to pay them and nothing in this "
                "system pays, reverses or expires one. Every one of them needs "
                "a manual adjustment on a money card carrying an owner's "
                "signature and a reason (8B.7.5) — and no card in this period "
                "references a round, so none has been raised. The player has "
                "been told a number the business has not settled."
            )

    adjustments: list[dict] | None
    try:
        adjustments = await _chance_adjustment_cards(since, until)
    except ReportError as exc:
        adjustments = None
        warnings.append(
            f"MANUAL ADJUSTMENTS TO GAME OUTCOMES COULD NOT BE READ. {exc} The "
            "count is UNKNOWN for this period, not zero."
        )

    adjustment_cards = None
    if adjustments is not None:
        adjustment_cards = sum(int(g.get("cards") or 0) for g in adjustments)
        adjustment_signed = sum(int(g.get("signed") or 0) for g in adjustments)
        for group in adjustments:
            gid = group.get("_id") or {}
            rows.append(
                {
                    "scope": "manual_adjustment",
                    "day": "",
                    "mechanic_id": "",
                    "mechanic": str(gid.get("type") or ""),
                    "kind": None,
                    "country": "",
                    "rounds": int(group.get("cards") or 0),
                    "players": None,
                    "staked_diamonds": None,
                    "paid_out_diamonds": None,
                    "ggr_diamonds": None,
                    "ggr_inr_minor": int(group.get("amount") or 0),
                    "ggr_inr": inr(int(group.get("amount") or 0)),
                    "staked_inr_minor": None,
                    "paid_out_inr_minor": None,
                    "actual_rtp_percent": None,
                    "configured_rtp_percent": None,
                    "rtp_gap_pp": None,
                    "withheld_diamonds": None,
                    "capped_rounds": None,
                    "config_versions": [],
                    "detail": (
                        f"{group.get('cards')} card(s) of type "
                        f"{gid.get('type')} at stage {gid.get('stage')} name a "
                        f"chance round; {group.get('signed')} carry a "
                        "signature. 8B.7.5 requires an owner's signature and a "
                        "reason on every one."
                    ),
                }
            )
        if adjustment_cards and adjustment_signed < adjustment_cards:
            warnings.append(
                f"{adjustment_cards - adjustment_signed} CARD(S) ADJUSTING A "
                "GAME OUTCOME ARE NOT SIGNED. 8B.7.5 requires an owner's "
                "signature and a reason on a manual adjustment to an outcome. "
                "An unsigned one is a balance edit with a card around it."
            )
        if not adjustment_cards:
            rows.append(
                {
                    "scope": "manual_adjustment",
                    "day": "",
                    "mechanic_id": "",
                    "mechanic": "Manual adjustments to a game outcome",
                    "kind": None,
                    "country": "all",
                    "rounds": 0,
                    "players": None,
                    "staked_diamonds": None,
                    "paid_out_diamonds": None,
                    "ggr_diamonds": None,
                    "ggr_inr_minor": 0,
                    "ggr_inr": 0.0,
                    "staked_inr_minor": None,
                    "paid_out_inr_minor": None,
                    "actual_rtp_percent": None,
                    "configured_rtp_percent": None,
                    "rtp_gap_pp": None,
                    "withheld_diamonds": None,
                    "capped_rounds": None,
                    "config_versions": [],
                    "detail": (
                        "NO CARD IN THIS PERIOD ADJUSTS A GAME OUTCOME. A "
                        "measured zero over the card board — and worth reading "
                        "beside the withheld line above, because no service in "
                        "this codebase creates such a card yet. 8B.7.5 says a "
                        "manual adjustment is a money card with an owner "
                        "signature and a reason; the query that finds one is "
                        "here and will report it the day one exists."
                    ),
                }
            )

    report = Report(
        name="chance_gross_gaming_revenue",
        title="Gross gaming revenue — per mechanic, per country, per day",
        period=_period(since, until),
        columns=[
            ("scope", "Scope"),
            ("day", "Day"),
            ("mechanic", "Mechanic"),
            ("mechanic_id", "Mechanic ID"),
            ("kind", "Kind"),
            ("country", "Country"),
            ("rounds", "Rounds"),
            ("players", "Players"),
            ("staked_diamonds", "Staked (diamonds)"),
            ("paid_out_diamonds", "Paid out (diamonds)"),
            ("ggr_diamonds", "GGR (diamonds)"),
            ("ggr_inr_minor", "GGR (INR minor units)"),
            ("ggr_inr", "GGR (INR)"),
            ("actual_rtp_percent", "Actual RTP %"),
            ("configured_rtp_percent", "Configured RTP %"),
            ("rtp_gap_pp", "RTP gap (pp)"),
            ("withheld_diamonds", "Withheld (diamonds)"),
            ("capped_rounds", "Capped rounds"),
            ("detail", "What this is made of"),
        ],
        rows=rows,
        totals={
            "revenue_line": "gross_gaming_revenue",
            "reported_separately_from": ["gifting", "calls"],
            "staked_diamonds": staked_total,
            "paid_out_diamonds": paid_total,
            "ggr_diamonds": ggr_total,
            "ggr_inr_minor": ggr_total_minor,
            "ggr_inr": inr(ggr_total_minor),
            "staked_inr_minor": staked_total_minor,
            "paid_out_inr_minor": paid_total_minor,
            "actual_rtp_percent": actual_total_pct,
            "rounds": rounds_total,
            "players": distinct_players,
            "capped_rounds": capped_total,
            "withheld_diamonds": withheld_total,
            "withheld_unsettled_diamonds": withheld_open,
            "mechanics_reported": sorted(by_mechanic),
            "countries_reported": sorted(by_country),
            "mechanics_sourced": mechanics_known,
            "ggr_by_mechanic_inr_minor": {
                key: to_inr_minor(
                    bucket["staked"] - bucket["paid_out"], str(Currency.DIAMONDS), rt
                )[0]
                for key, bucket in by_mechanic.items()
            },
            "ggr_by_country_inr_minor": {
                key: to_inr_minor(
                    bucket["staked"] - bucket["paid_out"], str(Currency.DIAMONDS), rt
                )[0]
                for key, bucket in by_country.items()
            },
            "ggr_by_kind_inr_minor": {
                key: to_inr_minor(
                    bucket["staked"] - bucket["paid_out"], str(Currency.DIAMONDS), rt
                )[0]
                for key, bucket in by_kind.items()
            },
            "host_or_agency_share_movements": (
                partner_rows if partner_movements is not None else None
            ),
            "host_or_agency_share_diamonds": (
                partner_take if partner_movements is not None else None
            ),
            "host_or_agency_share_configured": (
                bool(partner_rows) if partner_movements is not None else None
            ),
            "stake_ledger_movements": (
                stake_movements if partner_movements is not None else None
            ),
            "payout_ledger_movements": (
                payout_movements if partner_movements is not None else None
            ),
            "manual_adjustment_cards": adjustment_cards,
            # Each row is valued and rounded on its own, so the rows sum to
            # within a paise or two of the total, which is valued once from the
            # summed diamonds. Both are published rather than one being quietly
            # forced to match the other.
            "ggr_sum_of_rows_inr_minor": row_value_sum,
        },
        definitions=_definitions(
            "gross_gaming_revenue",
            "actual_rtp",
            "chance_partner_share",
            "chance_ledger_evidence",
            "chance_withheld",
            "currency",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )

    if not detail:
        report.mark_empty(
            "No chance round settled in this period. There is no gross gaming "
            "revenue because nobody played, not because the mechanics took in "
            "as much as they paid out — the two look identical as a zero and "
            "are completely different facts. The lines below the table were "
            "still checked and still say what they found."
        )
    return report


# ── 8B.8 — The margin model: beans are the only cash cost ─────────────────────


def _margin_row(
    *,
    key: str,
    label: str,
    kind: str,
    store: str,
    diamonds_consumed: int,
    beans_created: int,
    rt: Rates,
    reference_pct: float | None,
    basis: str,
    detail: str,
) -> dict:
    """One mechanic's margin line. Pure, so the arithmetic can be tested alone.

    `diamonds_consumed` is already net of anything returned to the player — see
    the `diamonds_consumed` definition. `beans_created` is the future cash cost
    the mechanic committed to in the period.
    """
    diamond_minor, diamond_rule = to_inr_minor(
        diamonds_consumed, str(Currency.DIAMONDS), rt
    )
    bean_minor, bean_rule = to_inr_minor(beans_created, str(Currency.BEANS), rt)

    creation_pct = _ratio_pct(beans_created, diamonds_consumed)
    ratio_pct = _ratio_pct(bean_minor, diamond_minor)
    return {
        "mechanic": key,
        "label": label,
        "kind": kind,
        "store": store,
        "basis": basis,
        "diamonds_consumed": diamonds_consumed,
        "diamond_value_inr_minor": diamond_minor,
        "diamond_value_inr": inr(diamond_minor),
        "beans_created": beans_created,
        "bean_cash_cost_inr_minor": bean_minor,
        "bean_cash_cost_inr": inr(bean_minor),
        "bean_creation_rate_pct": creation_pct,
        "reference_bean_creation_pct": reference_pct,
        "variance_from_reference_pp": (
            round(creation_pct - reference_pct, 3)
            if creation_pct is not None and reference_pct is not None
            else None
        ),
        "bean_payout_ratio": (
            round(bean_minor / diamond_minor, 6) if diamond_minor else None
        ),
        "bean_payout_ratio_pct": ratio_pct,
        "diamonds_per_bean": (
            round(diamonds_consumed / beans_created, 4) if beans_created else None
        ),
        "diamond_value_per_inr_of_bean_payout": (
            round(diamond_minor / bean_minor, 4) if bean_minor else None
        ),
        "detail": (
            f"{detail} {diamonds_consumed:,} diamonds consumed at "
            f"{diamond_rule} = {rupee_text(diamond_minor)}; "
            f"{beans_created:,} beans created at {bean_rule} = "
            f"{rupee_text(bean_minor)} of future cash cost."
            + (
                " No bean is created by this mechanic, so there is no "
                "denominator: diamonds consumed per unit of bean payout is "
                "NULL rather than infinite, and every diamond consumed is "
                "realised margin (8B.8.4)."
                if not beans_created
                else ""
            )
        ),
    }


async def chance_margin(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """The margin model — bean-payout ratio per mechanic. Spec 8B.8.

    The insight this report is shaped by is 8B.8.1: **diamonds returned to a
    player are not a cost.** They were sold for cash before they were staked,
    and returning one recirculates inventory. The only true cash outflow in this
    business is a bean becoming a payout. So the mechanics are ranked by what
    they cost in beans per diamond consumed, not by house edge, and games — which
    create no bean at all — come out on top for the reason 8B.8.4 gives.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    warnings: list[str] = []
    if rt.provisional:
        warnings.append(rt.note)

    rows: list[dict] = []

    # ── Gifting, from Firestore. Normal against lucky. ───────────────────────
    gifts_known = True
    normal = {"diamonds": 0, "beans": 0, "gifts": 0}
    lucky = {"diamonds": 0, "beans": 0, "gifts": 0}
    try:
        for event in await _gift_events(since, until):
            bucket = lucky if event["lucky"] else normal
            bucket["diamonds"] += int(event["diamonds"])
            bucket["beans"] += int(event["beans_earned"])
            bucket["gifts"] += 1
    except ReportError as exc:
        gifts_known = False
        warnings.append(
            f"GIFTING COULD NOT BE READ. {exc} The normal-gift and lucky-gift "
            "rows are absent from this table — they are UNKNOWN for this "
            "period, not zero, and the mechanics below cannot be compared "
            "against them."
        )

    if gifts_known:
        rows.append(
            _margin_row(
                key="normal_gift",
                label="Normal gifting",
                kind="gift",
                store="firestore",
                diamonds_consumed=normal["diamonds"],
                beans_created=normal["beans"],
                rt=rt,
                reference_pct=REFERENCE_BEAN_CREATION_PCT["normal_gift"],
                basis="created",
                detail=(
                    f"{normal['gifts']:,} non-lucky gift(s) in Firestore "
                    "`giftEvents`. Every diamond spent on a gift is consumed — "
                    "nothing comes back to the sender."
                ),
            )
        )
        rows.append(
            _margin_row(
                key="lucky_gift",
                label="Lucky gifting",
                kind="gift",
                store="firestore",
                diamonds_consumed=lucky["diamonds"],
                beans_created=lucky["beans"],
                rt=rt,
                reference_pct=REFERENCE_BEAN_CREATION_PCT["lucky_gift"],
                basis="created",
                detail=(
                    f"{lucky['gifts']:,} lucky gift(s) in Firestore "
                    "`giftEvents`. The diamonds a lucky send returns to the "
                    "sender go back through the app's own path and are not "
                    "recorded on the gift event, so this row's consumption is "
                    "the gross send. Where a lucky tier runs through the "
                    "controlled path instead, it appears as its own mechanic "
                    "row below with its returns netted off."
                ),
            )
        )

    # ── Calls. Not named by 8B.8.3, but they create beans and so they cost ───
    calls_known = True
    call_diamonds = call_beans = call_count = 0
    try:
        for event in await _call_events(since, until):
            call_diamonds += int(event["diamonds"])
            call_beans += int(event["beans"])
            call_count += 1
    except ReportError as exc:
        calls_known = False
        warnings.append(
            f"CALL ACTIVITY COULD NOT BE READ. {exc} The call row is absent — "
            "UNKNOWN, not zero — so the mechanic rows below do not account for "
            "every bean created in this period."
        )

    if calls_known:
        rows.append(
            _margin_row(
                key="call",
                label="Calls",
                kind="call",
                store="firestore",
                diamonds_consumed=call_diamonds,
                beans_created=call_beans,
                rt=rt,
                reference_pct=None,
                basis="created",
                detail=(
                    f"{call_count:,} settled call(s) in Firestore "
                    "`platformRevenue`. 8B.8.3 names no reference rate for "
                    "calls, so the measured figure stands on its own. It is on "
                    "this table because a call creates beans and therefore "
                    "costs cash, and a margin page that showed only gifts and "
                    "games would be missing one of the three."
                ),
            )
        )

    # ── The chance mechanics. Consumption is net of what was returned. ───────
    flow_known = True
    per_mechanic: dict[str, dict] = {}
    try:
        flow = await _chance_round_flow(since, until)
        for group in flow["rows"]:
            gid = group.get("_id") or {}
            key = str(gid.get("mechanic_id") or "")
            bucket = per_mechanic.setdefault(
                key, {"staked": 0, "paid_out": 0, "rounds": 0}
            )
            bucket["staked"] += int(group.get("staked") or 0)
            bucket["paid_out"] += int(group.get("paid_out") or 0)
            bucket["rounds"] += int(group.get("rounds") or 0)
    except ReportError as exc:
        flow_known = False
        warnings.append(
            f"CHANCE ROUNDS COULD NOT BE READ. {exc} No mechanic row appears "
            "below. That is not a period in which nobody played."
        )

    mechanics: dict[str, dict] = {}
    mechanics_known = True
    if flow_known and per_mechanic:
        try:
            mechanics = await _chance_mechanic_index()
        except ReportError as exc:
            mechanics_known = False
            warnings.append(
                f"THE MECHANIC REGISTER COULD NOT BE READ. {exc} Each mechanic "
                "below keeps its real figures and its id; its name and kind are "
                "unknown, and no 8B.8.3 reference rate can be matched to it."
            )

    for key in sorted(per_mechanic):
        bucket = per_mechanic[key]
        record = mechanics.get(key) or {}
        kind = str(record.get("kind") or "") if mechanics_known else ""
        consumed = bucket["staked"] - bucket["paid_out"]
        reference = (
            REFERENCE_BEAN_CREATION_PCT.get("game")
            if kind in {str(MechanicKind.GAME), str(MechanicKind.EVENT)}
            else REFERENCE_BEAN_CREATION_PCT.get("lucky_gift")
            if kind == str(MechanicKind.LUCKY_GIFT)
            else None
        )
        rows.append(
            _margin_row(
                key=key,
                label=str(record.get("name") or key) if mechanics_known else key,
                kind=kind or "unknown",
                store="ledger",
                diamonds_consumed=consumed,
                # A chance round mints no bean. Every payout is credited in
                # diamonds, on the player's own balance, by `chance.settle`.
                beans_created=0,
                rt=rt,
                reference_pct=reference,
                basis="created",
                detail=(
                    f"{bucket['rounds']:,} settled round(s): "
                    f"{bucket['staked']:,} staked − {bucket['paid_out']:,} "
                    "returned to players. What came back was not consumed "
                    "(8B.8.1); what did not come back is this mechanic's gross "
                    "gaming revenue and its consumption at the same time."
                ),
            )
        )
        if kind == str(MechanicKind.LUCKY_GIFT) and gifts_known and lucky["gifts"]:
            warnings.append(
                f"'{key}' IS A LUCKY GIFT TIER AND FIRESTORE ALSO RECORDED "
                f"{lucky['gifts']:,} LUCKY GIFT(S) THIS PERIOD. Those are two "
                "records of the same product while the controlled path is being "
                "adopted: this table reports them as separate rows and DOES NOT "
                "add them together in the totals. Adding them would count the "
                "same diamonds twice; leaving one out would understate the "
                "cost. Reconcile the two stores before either row is quoted on "
                "its own."
            )

    # ── The reference, in one row, so nobody has to remember it ──────────────
    for key, label in (
        ("normal_gift", "Normal gift"),
        ("lucky_gift", "Lucky gift"),
        ("game", "Games"),
    ):
        reference = REFERENCE_BEAN_CREATION_PCT[key]
        rows.append(
            {
                "mechanic": f"reference_{key}",
                "label": f"8B.8.3 reference — {label}",
                "kind": "reference",
                "store": "spec",
                "basis": "reference",
                "diamonds_consumed": None,
                "diamond_value_inr_minor": None,
                "diamond_value_inr": None,
                "beans_created": None,
                "bean_cash_cost_inr_minor": None,
                "bean_cash_cost_inr": None,
                "bean_creation_rate_pct": reference,
                "reference_bean_creation_pct": reference,
                "variance_from_reference_pp": None,
                "bean_payout_ratio": None,
                "bean_payout_ratio_pct": None,
                "diamonds_per_bean": None,
                "diamond_value_per_inr_of_bean_payout": None,
                "detail": (
                    f"8B.8.3, as written: {label.lower()} creates "
                    f"{reference:g}% beans. A UNIT rate — beans per diamond — "
                    "not a value ratio. It is on this table so the measured "
                    "rate above can be read against the rate the business was "
                    "designed around, and a mechanic that has drifted from it "
                    "is visible without anybody having to look the figure up."
                ),
            }
        )

    # ── The realised business-wide figure, so the two can be read together ───
    realised_ratio = None
    realised_pct = None
    flow_totals: dict = {}
    try:
        totals_flow = await _bean_and_diamond_flow(since, until)
        diamonds_debited = int(totals_flow[str(Currency.DIAMONDS)]["debited"])
        beans_paid_out = int(totals_flow[str(Currency.BEANS)]["paid_out"])
        beans_credited = int(totals_flow[str(Currency.BEANS)]["credited"])
        diamond_minor, _ = to_inr_minor(diamonds_debited, str(Currency.DIAMONDS), rt)
        bean_minor, _ = to_inr_minor(beans_paid_out, str(Currency.BEANS), rt)
        realised_ratio = (
            round(bean_minor / diamond_minor, 6) if diamond_minor else None
        )
        realised_pct = _ratio_pct(bean_minor, diamond_minor)
        flow_totals = {
            "diamonds_debited": diamonds_debited,
            "beans_paid_out": beans_paid_out,
            "beans_credited": beans_credited,
            "diamond_value_inr_minor": diamond_minor,
            "bean_payout_value_inr_minor": bean_minor,
        }
        rows.append(
            {
                "mechanic": "business_wide_realised",
                "label": "Business-wide, realised — the same figure margin_report gives",
                "kind": "reconciliation",
                "store": "ledger",
                "basis": "paid",
                "diamonds_consumed": diamonds_debited,
                "diamond_value_inr_minor": diamond_minor,
                "diamond_value_inr": inr(diamond_minor),
                "beans_created": beans_credited,
                "bean_cash_cost_inr_minor": bean_minor,
                "bean_cash_cost_inr": inr(bean_minor),
                "bean_creation_rate_pct": _ratio_pct(beans_credited, diamonds_debited),
                "reference_bean_creation_pct": None,
                "variance_from_reference_pp": None,
                "bean_payout_ratio": realised_ratio,
                "bean_payout_ratio_pct": realised_pct,
                "diamonds_per_bean": (
                    round(diamonds_debited / beans_paid_out, 4)
                    if beans_paid_out
                    else None
                ),
                "diamond_value_per_inr_of_bean_payout": (
                    round(diamond_minor / bean_minor, 4) if bean_minor else None
                ),
                "detail": (
                    "THE REALISED FIGURE, ON A PAID BASIS, COMPUTED THE WAY "
                    "`margin_report` COMPUTES IT — beans that actually became "
                    "payouts ÷ every diamond users spent. It is on this page so "
                    "the two can be read together: the mechanic rows above are "
                    "on a CREATED basis, because a bean cannot be traced back "
                    "to the mechanic that made it, and their denominator nets a "
                    "game's returned diamonds off the consumption while this "
                    "one cannot see which debits were stakes that came back. "
                    f"{diamonds_debited:,} diamonds debited from users, "
                    f"{beans_credited:,} beans created, {beans_paid_out:,} "
                    "beans paid out."
                ),
            }
        )
    except ReportError as exc:
        warnings.append(
            f"THE REALISED BUSINESS-WIDE BEAN-PAYOUT RATIO COULD NOT BE READ. "
            f"{exc} The per-mechanic rows above are unaffected; only the "
            "reconciliation line against `margin_report` is missing, and it is "
            "missing rather than zero."
        )

    measured = [r for r in rows if r["kind"] not in {"reference", "reconciliation"}]
    with_ratio = [
        r for r in measured if r["bean_payout_ratio_pct"] is not None
    ]
    best = min(with_ratio, key=lambda r: r["bean_payout_ratio_pct"], default=None)
    zero_bean = [r for r in measured if r["beans_created"] == 0 and r["diamonds_consumed"]]

    if zero_bean:
        warnings.append(
            f"{len(zero_bean)} MECHANIC(S) CREATED NO BEAN THIS PERIOD AND ARE "
            "THEREFORE THE HIGHEST-MARGIN MECHANICS AVAILABLE (8B.8.4): "
            + ", ".join(sorted(r["label"] for r in zero_bean))
            + ". Every diamond they consumed is realised margin, because the "
            "only cash this business ever pays out is a bean, and none was "
            "made. Their bean-payout ratio is 0% and that is a measured 0%, not "
            "an absent figure — the diamonds are on the row beside it."
        )

    total_consumed = sum(int(r["diamonds_consumed"] or 0) for r in measured)
    total_beans = sum(int(r["beans_created"] or 0) for r in measured)
    total_diamond_minor = sum(int(r["diamond_value_inr_minor"] or 0) for r in measured)
    total_bean_minor = sum(int(r["bean_cash_cost_inr_minor"] or 0) for r in measured)

    report = Report(
        name="chance_margin",
        title="Margin model — bean-payout ratio per mechanic",
        period=_period(since, until),
        columns=[
            ("label", "Mechanic"),
            ("mechanic", "Key"),
            ("kind", "Kind"),
            ("basis", "Basis"),
            ("diamonds_consumed", "Diamonds consumed"),
            ("diamond_value_inr_minor", "Diamond value (INR minor units)"),
            ("beans_created", "Beans created"),
            ("bean_cash_cost_inr_minor", "Bean cash cost (INR minor units)"),
            ("bean_creation_rate_pct", "Bean creation rate % (units)"),
            ("reference_bean_creation_pct", "8B.8.3 reference %"),
            ("variance_from_reference_pp", "Variance (pp)"),
            ("bean_payout_ratio_pct", "Bean-payout ratio % (value)"),
            ("diamonds_per_bean", "Diamonds per bean"),
            ("diamond_value_per_inr_of_bean_payout", "₹ consumed per ₹ of bean payout"),
            ("store", "Source store"),
            ("detail", "What this is made of"),
        ],
        rows=rows,
        totals={
            "diamonds_consumed": total_consumed,
            "diamond_value_inr_minor": total_diamond_minor,
            "beans_created": total_beans,
            "bean_cash_cost_inr_minor": total_bean_minor,
            "bean_cash_cost_inr": inr(total_bean_minor),
            "bean_creation_rate_pct": _ratio_pct(total_beans, total_consumed),
            "bean_payout_ratio_pct_created_basis": _ratio_pct(
                total_bean_minor, total_diamond_minor
            ),
            "bean_payout_ratio_realised": realised_ratio,
            "bean_payout_ratio_pct_realised": realised_pct,
            "realised_basis": flow_totals or None,
            "highest_margin_mechanic": (best or {}).get("mechanic"),
            "highest_margin_mechanic_kind": (best or {}).get("kind"),
            "highest_margin_ratio_pct": (best or {}).get("bean_payout_ratio_pct"),
            "mechanics_creating_no_bean": sorted(r["mechanic"] for r in zero_bean),
            "reference": dict(REFERENCE_BEAN_CREATION_PCT),
            "gifts_sourced": gifts_known,
            "calls_sourced": calls_known,
            "rounds_sourced": flow_known,
            "mechanics_sourced": mechanics_known,
        },
        definitions=_definitions(
            "bean_creation",
            "bean_payout_ratio_per_mechanic",
            "bean_payout_ratio",
            "diamonds_consumed",
            "diamonds_per_bean_payout",
            "currency",
            "source_store",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )

    if not measured:
        report.mark_empty(
            "No gift, no call and no chance round in this period, so there is "
            "nothing to compute a margin over. Nothing was consumed and nothing "
            "was committed — this is an empty period, not a period of perfect "
            "margin."
        )
    elif not total_consumed:
        report.mark_empty(
            "Every source was read and every one of them is empty: no diamond "
            "was consumed by any mechanic in this period. The ratios below are "
            "null rather than zero, because a bean-payout ratio of 0% reads as "
            "perfect margin and no margin was made."
        )
    return report


# ── 8B.9 and 8B.9A — the cannibalisation guard ────────────────────────────────


def _guard_row(
    metric: str,
    label: str,
    value,
    unit: str,
    detail: str,
    *,
    previous=None,
    change_pct: float | None = None,
    spec: str = "",
) -> dict:
    return {
        "metric": metric,
        "label": label,
        "value": value,
        "unit": unit,
        "value_inr": inr(value) if unit == "inr_minor" and value is not None else None,
        "previous": previous,
        "previous_inr": (
            inr(previous) if unit == "inr_minor" and previous is not None else None
        ),
        "change_pct": change_pct,
        "spec": spec,
        "detail": detail,
    }


async def _host_earnings(
    since: datetime, until: datetime, rt: Rates
) -> tuple[int, int]:
    """(host earnings in INR minor units, active hosts) for one window.

    The same pull and the same valuation the host table's payout column uses, so
    "what hosts earned" has one definition on the weekly report and not two.
    """
    earnings = 0
    active = 0
    for row in await _host_bean_activity(since, until):
        beans = int(row.get("beans_earned") or 0)
        if beans <= 0:
            continue
        active += 1
        minor, _ = to_inr_minor(beans, str(Currency.BEANS), rt)
        earnings += minor
    return earnings, active


async def chance_cannibalisation(
    since: datetime | None = None,
    until: datetime | None = None,
    rates: Rates | None = None,
) -> Report:
    """Are the games feeding the host economy, or eating it? Spec 8B.9 / 8B.9A.

    The two specs pull in opposite directions on purpose. 8B.9A says games are a
    legitimate and important way to retain an audience most of whom will never
    spend on a host; 8B.9 says that if games displace gifting, host earnings
    fall, the good hosts leave, and the engine that feeds the games dies with
    them. This report holds both at once: it counts the retained non-spender as
    retained rather than as a failure, and it says in words when game revenue is
    rising while host earnings fall.
    """
    since, until = resolve_window(since, until)
    rt = await _rates(rates)

    span = until - since
    prev_since, prev_until = since - span, since

    warnings: list[str] = []
    if rt.provisional:
        warnings.append(rt.note)

    rows: list[dict] = []

    # ── Host earnings, this window and the one before ────────────────────────
    host_earnings = active_hosts = None
    try:
        host_earnings, active_hosts = await _host_earnings(since, until, rt)
    except ReportError as exc:
        warnings.append(
            f"HOST EARNINGS COULD NOT BE READ. {exc} The whole of 8B.9 is a "
            "comparison against host earnings, so without them there is no "
            "verdict on this page — not a verdict of healthy."
        )

    prev_host_earnings = prev_active_hosts = None
    try:
        prev_host_earnings, prev_active_hosts = await _host_earnings(
            prev_since, prev_until, rt
        )
    except ReportError as exc:
        warnings.append(
            f"THE PRECEDING WEEK'S HOST EARNINGS COULD NOT BE READ. {exc} The "
            "direction of travel is unknown for this period and no verdict is "
            "given. An unknown direction is not a healthy one."
        )

    # ── Game revenue, this window and the one before ─────────────────────────
    game_ggr = game_staked = game_paid = None
    prev_game_ggr = None
    rounds_known = True
    try:
        flow = await _chance_round_flow(since, until)
        game_staked = sum(int(g.get("staked") or 0) for g in flow["rows"])
        game_paid = sum(int(g.get("paid_out") or 0) for g in flow["rows"])
        game_ggr = game_staked - game_paid
    except ReportError as exc:
        rounds_known = False
        warnings.append(
            f"GAME REVENUE COULD NOT BE READ. {exc} Every game figure on this "
            "page is UNKNOWN for this period. None of them is zero."
        )
    if rounds_known:
        try:
            prev_flow = await _chance_round_flow(prev_since, prev_until)
            prev_game_ggr = sum(
                int(g.get("staked") or 0) - int(g.get("paid_out") or 0)
                for g in prev_flow["rows"]
            )
        except ReportError as exc:
            warnings.append(
                f"THE PRECEDING WEEK'S GAME REVENUE COULD NOT BE READ. {exc} "
                "The direction of travel is unknown and no verdict is given."
            )

    game_ggr_minor = (
        to_inr_minor(game_ggr, str(Currency.DIAMONDS), rt)[0]
        if game_ggr is not None
        else None
    )
    prev_game_ggr_minor = (
        to_inr_minor(prev_game_ggr, str(Currency.DIAMONDS), rt)[0]
        if prev_game_ggr is not None
        else None
    )

    # ── Gifting and calls, for the spend share ───────────────────────────────
    gifts_known = True
    gift_diamonds = 0
    gifts_by_sender: dict[str, list[dict]] = {}
    try:
        for event in await _gift_events(since, until):
            gift_diamonds += int(event["diamonds"])
            if event["sender_uid"]:
                gifts_by_sender.setdefault(event["sender_uid"], []).append(event)
    except ReportError as exc:
        gifts_known = False
        warnings.append(
            f"GIFTING COULD NOT BE READ. {exc} The share of diamond spend going "
            "to games against gifting is UNKNOWN for this period, and so is the "
            "governing metric. Neither is reported as zero."
        )

    call_diamonds = None
    try:
        call_diamonds = sum(int(e["diamonds"]) for e in await _call_events(since, until))
    except ReportError as exc:
        warnings.append(
            f"CALL SPEND COULD NOT BE READ. {exc} It is reported as unknown "
            "beside the share rather than as zero. It is not part of the share "
            "itself, so the games-against-gifting figure is unaffected."
        )

    # ── Player-level: winnings, where they went, who is retained ─────────────
    players_known = rounds_known
    activity: list[dict] = []
    if rounds_known:
        try:
            activity = await _chance_player_activity(since, until)
        except ReportError as exc:
            players_known = False
            warnings.append(
                f"PER-PLAYER GAME ACTIVITY COULD NOT BE READ. {exc} The "
                "governing metric — the share of game winnings spent on hosts "
                "— is UNKNOWN for this period. It is not zero, and a missing "
                "governing metric is itself the thing to act on."
            )

    winnings = sum(int(p.get("won") or 0) for p in activity)
    recycled = sum(int(p.get("staked_after_first_win") or 0) for p in activity)
    players_who_played = {str(p["_id"]) for p in activity}
    winners = [p for p in activity if int(p.get("won") or 0) > 0]

    spent_on_hosts = None
    if players_known and gifts_known:
        spent_on_hosts = 0
        for player in winners:
            first_win = player.get("first_win_at")
            if not isinstance(first_win, datetime):
                continue
            first_win = _utc(first_win)
            for gift in gifts_by_sender.get(str(player["_id"]), ()):
                at = gift.get("at")
                if isinstance(at, datetime) and _utc(at) > first_win:
                    spent_on_hosts += int(gift["diamonds"])
        if any(
            not isinstance(g.get("at"), datetime)
            for gifts in gifts_by_sender.values()
            for g in gifts
        ):
            warnings.append(
                "SOME GIFTS IN THIS PERIOD CARRY NO READABLE TIMESTAMP and "
                "cannot be placed before or after a player's first win. They "
                "are EXCLUDED from the governing metric rather than assumed to "
                "be subsequent, which would flatter it. They are still counted "
                "in the diamond spend share, which does not depend on ordering."
            )

    # ── First-time movers from games to gifting (8B.9A.5) ────────────────────
    first_time_gifters = None
    lookback_since = since - timedelta(days=FIRST_GIFT_LOOKBACK_DAYS)
    if players_known and gifts_known:
        try:
            prior_senders = {
                str(e["sender_uid"])
                for e in await _gift_events(lookback_since, since)
                if e["sender_uid"]
            }
            first_time_gifters = len(
                {
                    uid
                    for uid in gifts_by_sender
                    if uid in players_who_played and uid not in prior_senders
                }
            )
        except ReportError as exc:
            warnings.append(
                "PLAYERS MOVING FROM GAMES TO GIFTING FOR THE FIRST TIME COULD "
                f"NOT BE COUNTED. {exc} The "
                f"{FIRST_GIFT_LOOKBACK_DAYS}-day lookback that decides whether "
                "a gift is a first is unreadable, so the count is UNKNOWN. It "
                "is not zero, and it is not 'everybody who gifted'."
            )

    # ── Retained non-spenders (8B.9A.6) ──────────────────────────────────────
    retained = None
    retained_no_recharge = None
    if players_known and gifts_known:
        non_spenders = {uid for uid in players_who_played if uid not in gifts_by_sender}
        retained = len(non_spenders)
        try:
            rechargers = {
                str(e["buyer_uid"])
                for e in await _recharge_events(since, until)
                if e["buyer_uid"] and e["recipient_type"] != "agency"
            }
            retained_no_recharge = len(non_spenders - rechargers)
        except ReportError as exc:
            warnings.append(
                "WHETHER THOSE RETAINED PLAYERS ALSO PUT MONEY IN COULD NOT BE "
                f"READ. {exc} The count of players retained at no extraction at "
                "all is UNKNOWN. The retained count itself is unaffected."
            )

    # ── The rows ─────────────────────────────────────────────────────────────
    per_active_host = (
        host_earnings // active_hosts
        if host_earnings is not None and active_hosts
        else None
    )
    prev_per_active_host = (
        prev_host_earnings // prev_active_hosts
        if prev_host_earnings is not None and prev_active_hosts
        else None
    )

    rows.append(
        _guard_row(
            "host_earnings",
            "Total host earnings",
            host_earnings,
            "inr_minor",
            (
                "Beans credited to host balances inside the window, valued at "
                "the bean rate. The same pull and the same valuation the host "
                "table's 'payout due' column uses — one definition of what a "
                "week's work earned, not two."
            ),
            previous=prev_host_earnings,
            change_pct=_change_pct(host_earnings, prev_host_earnings),
            spec="8B.9.4",
        )
    )
    rows.append(
        _guard_row(
            "active_hosts",
            "Active hosts",
            active_hosts,
            "hosts",
            (
                "Hosts credited at least one bean in the window. A host who "
                "earned nothing is NOT counted here and is NOT counted as a "
                "zero either: the host roll lives in Firestore and this server "
                "has no report over it (10.23), so an absent host is unknown."
            ),
            previous=prev_active_hosts,
            change_pct=_change_pct(active_hosts, prev_active_hosts),
            spec="8B.9.4",
        )
    )
    rows.append(
        _guard_row(
            "host_earnings_per_active_host",
            "Host earnings per active host",
            per_active_host,
            "inr_minor",
            (
                "Total host earnings ÷ active hosts, in whole paise. Null when "
                "no host was active — an average over nobody is not zero. "
                "8B.9.5 makes a sustained decline in this figure alongside a "
                "rising game share an alert to owners, not a report to read "
                "later; this is the figure that alert would be raised on."
            ),
            previous=prev_per_active_host,
            change_pct=_change_pct(per_active_host, prev_per_active_host),
            spec="8B.9.4 / 8B.9.5",
        )
    )
    rows.append(
        _guard_row(
            "game_revenue",
            "Game revenue (gross gaming revenue)",
            game_ggr_minor,
            "inr_minor",
            (
                "Diamonds staked less diamonds paid back, valued at the diamond "
                "rate — the same figure, from the same pull, that the gross "
                "gaming revenue report reports (8B.7.1)."
            ),
            previous=prev_game_ggr_minor,
            change_pct=_change_pct(game_ggr_minor, prev_game_ggr_minor),
            spec="8B.9.3",
        )
    )

    total_spend = None
    game_share = gift_share = None
    if gifts_known and game_staked is not None:
        total_spend = game_staked + gift_diamonds
        game_share = _ratio_pct(game_staked, total_spend)
        gift_share = _ratio_pct(gift_diamonds, total_spend)
    rows.append(
        _guard_row(
            "diamond_spend_share_games_pct",
            "Share of diamond spend going to games",
            game_share,
            "percent",
            (
                f"{game_staked:,} diamonds staked on games against "
                f"{gift_diamonds:,} spent on gifts"
                if game_staked is not None and gifts_known
                else "Unknown — one of the two figures could not be read."
            )
            + ". The stake is taken gross, because a diamond staked was a "
            "diamond not available to spend on a host at that moment, whatever "
            "came back afterwards."
            + (
                f" Call spend was {call_diamonds:,} diamonds and is deliberately "
                "outside this share."
                if call_diamonds is not None
                else " Call spend is unknown and is outside this share either way."
            ),
            spec="8B.9.4",
        )
    )
    rows.append(
        _guard_row(
            "diamond_spend_share_gifting_pct",
            "Share of diamond spend going to gifting",
            gift_share,
            "percent",
            (
                "Gifting is the product; the monetisation mechanics ride on top "
                "of it (8B.9.1). This is the share that must not be displaced."
            ),
            spec="8B.9.4",
        )
    )

    winnings_minor = (
        to_inr_minor(winnings, str(Currency.DIAMONDS), rt)[0] if players_known else None
    )
    hosts_minor = (
        to_inr_minor(spent_on_hosts, str(Currency.DIAMONDS), rt)[0]
        if spent_on_hosts is not None
        else None
    )
    recycled_minor = (
        to_inr_minor(recycled, str(Currency.DIAMONDS), rt)[0] if players_known else None
    )
    governing_pct = (
        _ratio_pct(spent_on_hosts, winnings) if spent_on_hosts is not None else None
    )

    rows.append(
        _guard_row(
            "game_winnings",
            "Game winnings paid to players",
            winnings_minor,
            "inr_minor",
            (
                f"{winnings:,} diamonds won across {len(winners):,} winning "
                f"player(s) of {len(players_who_played):,} who played."
                if players_known
                else "Unknown — per-player game activity could not be read."
            ),
            spec="8B.9A.4",
        )
    )
    rows.append(
        _guard_row(
            "winnings_spent_on_hosts_pct",
            "THE GOVERNING METRIC — share of game winnings spent on hosts",
            governing_pct,
            "percent",
            (
                f"{spent_on_hosts:,} diamonds of gifts sent AFTER a player's "
                f"first win, against {winnings:,} diamonds won. "
                if spent_on_hosts is not None
                else "Unknown for this period. "
            )
            + "If it falls, the funnel is leaking and games are becoming an end "
            "in themselves (8B.9A.4). It can exceed 100%, which means players "
            "gifted more than they won and is good news.",
            spec="8B.9A.4",
        )
    )
    rows.append(
        _guard_row(
            "winnings_spent_on_hosts",
            "Winnings spent on gifting",
            hosts_minor,
            "inr_minor",
            (
                "Diamonds a player spent on gifts after their first winning "
                "round in this period. 'Subsequently' is enforced on the "
                "timestamps, not assumed."
            ),
            spec="8B.9A.5",
        )
    )
    rows.append(
        _guard_row(
            "winnings_recycled_into_games",
            "Winnings recycled into games",
            recycled_minor,
            "inr_minor",
            (
                f"{recycled:,} diamonds staked by a player in a round after "
                "they had already won something in this period. A player's "
                "opening stake is never counted as recycled winnings."
                if players_known
                else "Unknown — per-player game activity could not be read."
            ),
            spec="8B.9A.5",
        )
    )
    rows.append(
        _guard_row(
            "first_time_gifters",
            "Players who moved from games to gifting for the first time",
            first_time_gifters,
            "players",
            (
                "Played a round in this period, sent a gift in this period, and "
                f"sent no gift in the {FIRST_GIFT_LOOKBACK_DAYS} days before "
                "it. NOT a lifetime first — nothing in this business records "
                "whether a user has ever gifted, and the lookback is stated "
                "rather than the claim overstated."
            ),
            spec="8B.9A.5",
        )
    )
    rows.append(
        _guard_row(
            "retained_non_spenders",
            "Players retained by games who spend nothing on a host",
            retained,
            "players",
            (
                "Played at least one round and sent no gift. COUNTED AS "
                "RETAINED, NOT AS FAILED MONETISATION (8B.9A.6). Most users "
                "will never spend on a host; a retained non-spending player is "
                "audience for the hosts and future conversion, and a larger "
                "retained audience is what makes hosts want to work here "
                "(8B.9A.1)."
            ),
            spec="8B.9A.6",
        )
    )
    rows.append(
        _guard_row(
            "retained_non_spenders_no_recharge",
            "…of whom put no money in at all",
            retained_no_recharge,
            "players",
            (
                "Of the retained non-spenders, those with no approved recharge "
                "in the period. Audience kept at no extraction, which is what "
                "free daily entries are for (8B.12.7). Unknown, never zero, "
                "when recharges cannot be read."
            ),
            spec="8B.9A.6 / 8B.12.7",
        )
    )

    # ── 8B.9.3 — the rule, reported against ──────────────────────────────────
    game_change = _change_pct(game_ggr_minor, prev_game_ggr_minor)
    host_change = _change_pct(host_earnings, prev_host_earnings)
    verdict = None
    verdict_text: str

    if game_change is None or host_change is None:
        verdict_text = (
            "NO VERDICT. 8B.9.3 is a rule about direction — game revenue rising "
            "while host earnings hold steady — and the preceding period of the "
            "same length could not be compared "
            f"({prev_since.date().isoformat()} to {prev_until.date().isoformat()}). "
            "Unknown is reported rather than healthy. A verdict nobody can "
            "check is worse than none."
        )
    else:
        band = HOST_EARNINGS_STEADY_BAND_PCT
        games_rising = game_change > band
        hosts_falling = host_change < -band
        hosts_steady = abs(host_change) <= band
        if games_rising and hosts_falling:
            verdict = "ecosystem_being_consumed"
            verdict_text = (
                "THE ECOSYSTEM IS BEING CONSUMED. Game revenue rose "
                f"{game_change:+.1f}% while host earnings fell {host_change:+.1f}% "
                "against the preceding period. 8B.9.3 names this exactly: "
                "falling host earnings alongside rising game revenue means the "
                "ecosystem is being consumed. Games extract value; hosts create "
                "the reason users return (8B.9.1). If this holds, the good "
                "hosts leave and the engagement engine that feeds the games "
                "dies with them (8B.9.2). This is a decision for an owner "
                "now — cap the share of a user's spend games may absorb, or "
                "schedule them to complement peak host hours rather than "
                "compete with them (8B.9.6)."
            )
        elif games_rising and (hosts_steady or host_change > band):
            verdict = "healthy"
            verdict_text = (
                f"HEALTHY, by 8B.9.3. Game revenue rose {game_change:+.1f}% and "
                f"host earnings {host_change:+.1f}%, which is "
                + ("holding steady" if hosts_steady else "rising too")
                + f" (steady is within ±{band:g}%). This is the shape the rule "
                "asks for: the monetisation mechanic growing on top of the "
                "product rather than in place of it."
            )
        elif hosts_falling:
            verdict = "host_earnings_falling"
            verdict_text = (
                f"HOST EARNINGS ARE FALLING — {host_change:+.1f}% against the "
                f"preceding period — while game revenue moved {game_change:+.1f}%. "
                "Games are not rising enough for 8B.9.3's cannibalisation "
                "reading, so this is not the ecosystem being consumed by them. "
                "It is still hosts earning less, and 8B.9.2 says that is how "
                "the engagement engine dies whatever caused it. Look at the "
                "hosts, not only at the games."
            )
        else:
            verdict = "no_displacement"
            verdict_text = (
                f"NO DISPLACEMENT. Game revenue moved {game_change:+.1f}% and "
                f"host earnings {host_change:+.1f}% against the preceding "
                "period. Neither figure is rising fast enough to test 8B.9.3's "
                f"rule (rising means more than ±{band:g}%). Nothing here says "
                "games are eating the host economy; nothing here says they are "
                "feeding it either."
            )

    rows.append(
        _guard_row(
            "cannibalisation_verdict",
            "8B.9.3 — game revenue rising while host earnings hold steady",
            verdict,
            "verdict",
            verdict_text,
            previous=None,
            change_pct=None,
            spec="8B.9.3",
        )
    )

    if verdict == "ecosystem_being_consumed":
        warnings.append(verdict_text)
    elif verdict == "host_earnings_falling":
        warnings.append(verdict_text)
    elif verdict is None:
        warnings.append(verdict_text)

    if (
        per_active_host is not None
        and prev_per_active_host is not None
        and game_share is not None
        and per_active_host < prev_per_active_host
        and (game_change or 0) > HOST_EARNINGS_STEADY_BAND_PCT
    ):
        warnings.append(
            "HOST EARNINGS PER ACTIVE HOST FELL WHILE THE GAME SHARE ROSE — "
            f"{rupee_text(prev_per_active_host)} to {rupee_text(per_active_host)} "
            f"per active host, with games at {game_share:g}% of diamond spend. "
            "8B.9.5 says a sustained decline of this figure alongside a rising "
            "game share is an alert to owners, not a report to read later. One "
            "period is not yet 'sustained' — this report covers one window and "
            "cannot see a trend — but it is the first of them, and the next "
            "period's figure is the one that decides."
        )

    report = Report(
        name="chance_cannibalisation",
        title="Games against the host economy — the cannibalisation guard",
        period=_period(since, until),
        columns=[
            ("label", "Metric"),
            ("metric", "Key"),
            ("value", "Value"),
            ("unit", "Unit"),
            ("value_inr", "INR"),
            ("previous", "Preceding period"),
            ("previous_inr", "Preceding period (INR)"),
            ("change_pct", "Change %"),
            ("spec", "Spec"),
            ("detail", "What this is made of"),
        ],
        rows=rows,
        totals={
            "comparison_period": {
                "since": prev_since,
                "until": prev_until,
                "days": round(span.total_seconds() / 86400, 2),
                "note": (
                    "The immediately preceding window of the same length. Every "
                    "'change %' on this page is against it."
                ),
            },
            "host_earnings_inr_minor": host_earnings,
            "host_earnings_previous_inr_minor": prev_host_earnings,
            "host_earnings_change_pct": host_change,
            "active_hosts": active_hosts,
            "active_hosts_previous": prev_active_hosts,
            "host_earnings_per_active_host_inr_minor": per_active_host,
            "host_earnings_per_active_host_previous_inr_minor": prev_per_active_host,
            "game_revenue_inr_minor": game_ggr_minor,
            "game_revenue_previous_inr_minor": prev_game_ggr_minor,
            "game_revenue_change_pct": game_change,
            "game_staked_diamonds": game_staked,
            "game_paid_out_diamonds": game_paid,
            "gift_diamonds": gift_diamonds if gifts_known else None,
            "call_diamonds": call_diamonds,
            "diamond_spend_total": total_spend,
            "diamond_spend_share_games_pct": game_share,
            "diamond_spend_share_gifting_pct": gift_share,
            "game_winnings_diamonds": winnings if players_known else None,
            "winnings_spent_on_hosts_diamonds": spent_on_hosts,
            "winnings_recycled_into_games_diamonds": recycled if players_known else None,
            "winnings_spent_on_hosts_pct": governing_pct,
            "first_time_gifters": first_time_gifters,
            "first_gift_lookback_days": FIRST_GIFT_LOOKBACK_DAYS,
            "retained_non_spenders": retained,
            "retained_non_spenders_no_recharge": retained_no_recharge,
            "players_who_played": len(players_who_played) if players_known else None,
            "players_who_won": len(winners) if players_known else None,
            "verdict": verdict,
            "verdict_text": verdict_text,
            "steady_band_pct": HOST_EARNINGS_STEADY_BAND_PCT,
            "hosts_sourced": host_earnings is not None,
            "rounds_sourced": rounds_known,
            "players_sourced": players_known,
            "gifts_sourced": gifts_known,
        },
        definitions=_definitions(
            "host_earnings_week",
            "diamond_spend_share",
            "winnings_to_hosts",
            "winnings_recycled",
            "first_time_gifters",
            "retained_non_spenders",
            "cannibalisation_verdict",
            "gross_gaming_revenue",
            "currency",
        ),
        rates=rt.as_dict(),
        warnings=warnings,
    )

    if (
        rounds_known
        and gifts_known
        and host_earnings is not None
        and not players_who_played
        and not gift_diamonds
        and not host_earnings
    ):
        report.mark_empty(
            "Nobody played a round, nobody sent a gift and no host earned a "
            "bean in this period. Every figure below is empty for want of "
            "activity, not because games and gifting cancelled out — and an "
            "empty week cannot displace anything, so there is no verdict to "
            "draw from it."
        )
    return report


# ══════════════════════════════════════════════════════════════════════════════
#  EXPORT AUDIT
# ══════════════════════════════════════════════════════════════════════════════


async def record_export(user: dict, report: Report, row_count: int) -> str:
    """Every export is logged: who exported what, when. Spec 8A.5.4 / 6.4.

    The observer may export (9.5), so this is not a write the observer guard
    blocks — it is the record that makes read-only export accountable.
    """
    period = report.period
    since, until = period.get("since"), period.get("until")
    window = (
        f"{since.isoformat()} → {until.isoformat()}"
        if isinstance(since, datetime) and isinstance(until, datetime)
        else f"as at {period.get('as_at')}"
    )
    return await audit.record(
        actor={
            "uid": user.get("uid", ""),
            "name": user.get("name", ""),
            "role": str(user.get("role", "")),
            "team": str(user["team"]) if user.get("team") else None,
        },
        action=audit.Action.EXPORT,
        subject_type="report",
        subject_id=report.name,
        reason=f"CSV export of '{report.title}' for {window}",
        after={
            "format": "csv",
            "rows": row_count,
            "filename": report.filename(),
        },
        meta={
            "report": report.name,
            "period": window,
            "rows": row_count,
            "rates": report.rates.get("source"),
            "provisional_rates": bool(report.rates.get("provisional")),
        },
    )


# ── Self-check ────────────────────────────────────────────────────────────────
#
#     python3 -m app.services.reports
#
# The CSV writer is the one piece of this module with no database behind it and
# a great many ways to be subtly wrong, so it is checked directly.

if __name__ == "__main__":  # pragma: no cover
    import sys

    failures: list[str] = []

    def check(label: str, actual, expected) -> None:
        if actual != expected:
            failures.append(f"{label}\n      expected: {expected!r}\n      got:      {actual!r}")

    # Header row is always written, even with no data.
    check(
        "header only",
        to_csv([], [("a", "Alpha"), ("b", "Beta")]),
        "Alpha,Beta\r\n",
    )

    # Plain values, header from (key, header) pairs.
    check(
        "plain row",
        to_csv([{"a": 1, "b": "x"}], [("a", "Alpha"), ("b", "Beta")]),
        "Alpha,Beta\r\n1,x\r\n",
    )

    # A comma forces quoting.
    check(
        "comma quoted",
        to_csv([{"a": "Kolkata, WB"}], ["a"]),
        'a\r\n"Kolkata, WB"\r\n',
    )

    # An embedded quote is doubled, and the field is quoted.
    check(
        "quote doubled",
        to_csv([{"a": 'He said "yes"'}], ["a"]),
        'a\r\n"He said ""yes"""\r\n',
    )

    # A field that is nothing but a quote.
    check("bare quote", to_csv([{"a": '"'}], ["a"]), 'a\r\n""""\r\n')

    # Newlines and carriage returns are quoted, not stripped.
    check("newline quoted", to_csv([{"a": "one\ntwo"}], ["a"]), 'a\r\n"one\ntwo"\r\n')
    check("cr quoted", to_csv([{"a": "one\rtwo"}], ["a"]), 'a\r\n"one\rtwo"\r\n')

    # None is empty — never the text "None".
    check("none is empty", to_csv([{"a": None, "b": 0}], ["a", "b"]), "a,b\r\n,0\r\n")

    # A missing key behaves like None.
    check("missing key", to_csv([{"a": 1}], ["a", "b"]), "a,b\r\n1,\r\n")

    # Zero and False are values, not blanks.
    check("false renders", to_csv([{"a": False}], ["a"]), "a\r\nfalse\r\n")
    check("zero renders", to_csv([{"a": 0}], ["a"]), "a\r\n0\r\n")

    # Leading and trailing space survive, by quoting.
    check("space preserved", to_csv([{"a": " pad "}], ["a"]), 'a\r\n" pad "\r\n')

    # Datetimes are ISO 8601 in UTC.
    check(
        "datetime iso",
        to_csv([{"a": datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc)}], ["a"]),
        "a\r\n2026-03-01T09:30:00+00:00\r\n",
    )

    # Floats do not leak binary representation noise.
    check("float clean", to_csv([{"a": 0.1 + 0.2}], ["a"]), "a\r\n0.3\r\n")

    # A header containing a comma is quoted too.
    check(
        "header quoted",
        to_csv([{"a": 1}], [("a", "Amount, INR")]),
        '"Amount, INR"\r\n1\r\n',
    )

    # Columns omitted → keys in order of first appearance, union across rows.
    check(
        "derived columns",
        to_csv([{"b": 1}, {"a": 2}], None),
        "b,a\r\n1,\r\n,2\r\n",
    )

    # Nested values become compact JSON, still correctly quoted.
    check(
        "nested json",
        to_csv([{"a": {"x": 1, "y": 2}}], ["a"]),
        'a\r\n"{""x"":1,""y"":2}"\r\n',
    )

    # Round-trips through a real CSV parser.
    import csv as _csv
    import io as _io

    text = to_csv(
        [
            {"a": 'q"q', "b": "c,c", "c": None, "d": "l\nl", "e": " s "},
            {"a": 1, "b": 2.5, "c": True, "d": "", "e": "plain"},
        ],
        ["a", "b", "c", "d", "e"],
    )
    parsed = list(_csv.reader(_io.StringIO(text, newline="")))
    check("round-trip header", parsed[0], ["a", "b", "c", "d", "e"])
    check("round-trip row 1", parsed[1], ['q"q', "c,c", "", "l\nl", " s "])
    check("round-trip row 2", parsed[2], ["1", "2.5", "true", "", "plain"])
    check("round-trip row count", len(parsed), 3)

    # ── Valuation and window rules ───────────────────────────────────────────
    r = Rates(2390.0, 0.01, "firestore", False, [], "", datetime.now(timezone.utc))
    check("one lakh diamonds", to_inr_minor(100_000, "diamonds", r)[0], 239_000)
    check("coins value like diamonds", to_inr_minor(100_000, "coins", r)[0], 239_000)
    check("beans", to_inr_minor(10_000, "beans", r)[0], 10_000)
    check("commission is paise", to_inr_minor(5_000, "commission", r)[0], 5_000)
    check("rupees to paise", to_inr_minor(10, "inr", r)[0], 1_000)
    check("paise to rupees", inr(239_000), 2390.0)

    try:
        to_inr_minor(1, "gold", r)
        failures.append("unknown currency should raise, not return zero")
    except ReportError:
        pass

    s, u = resolve_window(None, None)
    check("default window is 30 days", round((u - s).total_seconds() / 86400), 30)

    try:
        resolve_window(
            datetime(2020, 1, 1, tzinfo=timezone.utc),
            datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        failures.append("a 6-year window should be refused")
    except ReportError:
        pass

    try:
        resolve_window(
            datetime(2026, 1, 2, tzinfo=timezone.utc),
            datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        failures.append("a reversed window should be refused")
    except ReportError:
        pass

    if failures:
        print(f"\n{len(failures)} FAILED\n")
        for f in failures:
            print("  ✗", f)
        sys.exit(1)

    print("\nAll report self-checks passed.")
    print("  · CSV quotes commas, quotes, CR, LF and padding; doubles embedded quotes")
    print("  · None is an empty field; zero and false are values")
    print("  · output round-trips through the stdlib CSV parser")
    print("  · currency valuation is explicit, and an unknown currency raises")
    print("  · the window defaults to 30 days and refuses anything over 400")
    sys.exit(0)
