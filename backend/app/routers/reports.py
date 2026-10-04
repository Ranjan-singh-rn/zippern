"""Reporting, export and dashboard endpoints.

Every report here is date-ranged, every report exports to CSV, and every export
is logged. Those three things do not exist in the CRM today (10.8, 10.9,
8A.5.4).

Shape of every endpoint:

    GET /api/reports/<name>?since=…&until=…&format=json|csv

* `since` and `until` are optional. Omit both and you get the last 30 days.
  Give only `since` and it runs to now. The period is half-open —
  `[since, until)` — so consecutive reports never double-count a movement.
  Anything wider than 400 days is refused, so a stray request cannot scan the
  whole ledger.
* `format=csv` returns a streamed `text/csv` attachment named for the report
  and its date range, and writes an `audit.Action.EXPORT` entry naming who
  exported what, when. If that entry cannot be written the export is refused —
  an unlogged export is the thing 8A.5.4 exists to prevent.

Who sees what:

* `can_read_all` — owners and the Observer — see the whole business. The
  Observer can export; read-only without export is not an audit function (9.5).
* A team admin sees business-wide financials and their own team where a report
  is team-scoped. Asking for another team is a 403, not a silently empty page.
* A member gets a 403 on business-wide financial reports, and their own team's
  throughput and dashboard.

External accounts never reach this router at all — `require_internal`. Partners
read their own statements through `/partners`, which scopes them to themselves.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterator

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from app.core import roles as R
from app.core.deps import require_internal, team_admin_or_reporting_service
from app.core.roles import Role, Team
from app.services import reports as svc
from app.services import scheduling as svc_schedule
from app.services.reports import Rates, Report, ReportError

router = APIRouter(prefix="/reports", tags=["reports"])


# ── Shared plumbing ───────────────────────────────────────────────────────────


async def request_rates() -> Rates:
    """Economy rates, read once per request.

    FastAPI caches a dependency result for the life of one request, so a report
    that values both diamonds and beans reads Firestore once.
    """
    return await svc.load_rates()


async def _produce(coro) -> Report:
    """Run a report, turning a refusal into an HTTP error with the reason.

    A report that cannot be produced never comes back as zeroes (8A.6.5).
    """
    try:
        return await coro
    except ReportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(name: str) -> str:
    """A report name can contain a partner id that came from the URL, and that
    id must never reach a response header unfiltered."""
    cleaned = _UNSAFE_FILENAME.sub("-", name).strip("-.") or "report"
    return cleaned[:120]


def _chunks(text: str, size: int = 64 * 1024) -> Iterator[str]:
    for i in range(0, len(text), size):
        yield text[i : i + size]


async def _deliver(report: Report, fmt: str, user: dict):
    """JSON, or a logged CSV download."""
    if fmt.lower() != "csv":
        return report.as_dict()

    body = report.csv()

    try:
        await svc.record_export(user, report, len(report.rows))
    except (PyMongoError, RuntimeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "The export was not produced because it could not be recorded "
                f"in the audit log ({exc}). Exports are logged — who exported "
                "what, and when — and an unlogged export is not issued."
            ),
        ) from exc

    filename = _safe_filename(report.filename())
    return StreamingResponse(
        _chunks(body),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Report-Name": _safe_filename(report.name),
            "X-Report-Rows": str(len(report.rows)),
            "X-Report-Rates": _safe_filename(str(report.rates.get("source", "n/a"))),
        },
    )


# ── Scope ─────────────────────────────────────────────────────────────────────


def _require_business_financials(user: dict) -> None:
    """Business-wide money is for owners, the Observer and team admins.

    A member sees their own work and their team's queues, not the company's
    cash position.
    """
    role: Role = user["role"]
    if R.can_read_all(role) or R.is_team_admin(role):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "Business-wide financial reports are available to owners, the "
            "Observer and team admins. Your team's throughput and your own "
            "dashboard are available to you."
        ),
    )


def _scoped_team(user: dict, requested: Team | None) -> str | None:
    """Which team this caller may report on.

    Returns None for "every team", which only `can_read_all` ever gets.
    """
    role: Role = user["role"]
    if R.can_read_all(role):
        return str(requested) if requested else None

    own = R.team_of(role)
    if own is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account belongs to no team, so it has no team report.",
        )
    if requested is not None and str(requested) != str(own):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You can report on {own} only. Ask an owner for another "
                "team's figures."
            ),
        )
    return str(own)


# ── Query parameters ──────────────────────────────────────────────────────────

_SINCE = Query(
    default=None,
    description="Start of the period, inclusive. Defaults to 30 days before the end.",
)
_UNTIL = Query(
    default=None,
    description="End of the period, exclusive. Defaults to now.",
)
_FORMAT = Query(
    default="json",
    alias="format",
    pattern="^(json|csv)$",
    description="json, or csv for a logged spreadsheet export.",
)


# ══════════════════════════════════════════════════════════════════════════════
#  MONEY
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/cash-position")
async def cash_position(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Receipts by channel, payments out, net — the daily cash position.

    Actual money received, not imputed diamond consumption (9.43). Computed
    from the ledger and from executed cards, never estimated.
    """
    _require_business_financials(user)
    report = await _produce(svc.cash_position(since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/revenue")
async def revenue(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    group_by: str = Query(
        default="day",
        pattern="^(day|week|month)$",
        description="Bucket size. Grouping happens in the database.",
    ),
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Revenue by day, week or month — "how much came in this week" (10.8)."""
    _require_business_financials(user)
    report = await _produce(svc.revenue_summary(since, until, group_by, rates))
    return await _deliver(report, fmt, user)


@router.get("/payouts")
async def payouts(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Payouts — one definition: value that actually left, from executed cards.

    This replaces the four different meanings of "total payout" on four Finance
    pages (10.7). Signed-but-unexecuted is not a payout and is reported as a
    warning instead.
    """
    _require_business_financials(user)
    report = await _produce(svc.payout_summary(since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/margin")
async def margin(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Revenue, payouts, commission, net margin and the bean-payout ratio.

    The bean-payout ratio — cash out as a share of diamond value consumed — is
    the real profitability measure for this business (8B.8.5).
    """
    _require_business_financials(user)
    report = await _produce(svc.margin_report(since, until, rates))
    return await _deliver(report, fmt, user)


# ── Chance mechanics — 8B.7, 8B.8, 8B.9, 8B.9A ────────────────────────────────
#
# Three endpoints because they answer three different questions and an owner
# reads them at different moments: what the games earned, what they cost, and
# whether they are eating the thing that feeds them. All three are
# business-wide money and are scoped exactly like the cash position.
#
# `/chance/*` under the chance router is Ops' live view in diamonds — exposure,
# reserve, RTP divergence, the exception queue. These are Finance's, in rupees,
# over a stated window, with a CSV and a logged export.


@router.get("/chance-revenue")
async def chance_revenue(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Gross gaming revenue — its own revenue line, apart from gifting and calls.

    Staked minus paid out, per mechanic, per country, per day, with the actual
    RTP beside it (8B.7.1 / 8B.7.2). Underneath the table: whether any host or
    agency takes a share (8B.7.3), whether the stakes and payouts reached the
    ledger (8B.7.4), and what is withheld awaiting an owner's signature
    (8B.7.5). Each of those is measured, not asserted.
    """
    _require_business_financials(user)
    report = await _produce(svc.chance_revenue(since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/chance-margin")
async def chance_margin(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Bean-payout ratio per mechanic — the number that governs profitability.

    Diamonds returned to a player are not a cost; they were already sold for
    cash (8B.8.1). The only true cash outflow is a bean becoming a payout, so
    the mechanics are ranked by beans created per diamond consumed (8B.8.2 /
    8B.8.5) against the 50% / 5% / none reference in 8B.8.3.
    """
    _require_business_financials(user)
    report = await _produce(svc.chance_margin(since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/cannibalisation")
async def cannibalisation(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Are the games feeding the host economy or eating it? 8B.9 and 8B.9A.

    Host earnings, earnings per active host and the active host count; the
    share of diamond spend going to games against gifting; the governing
    metric — the share of game winnings subsequently spent on hosts (8B.9A.4);
    winnings recycled into games against spent on gifting; first-time movers;
    and the players games retained who spend nothing, counted as retained
    rather than as failed monetisation (8B.9A.6).

    The period defaults to the last 30 days like every other report here. The
    weekly run asks for a week, which is the cadence 8B.9.4 and 8B.9A.5 name.
    """
    _require_business_financials(user)
    report = await _produce(svc.chance_cannibalisation(since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/channels")
async def channels(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Reseller versus direct, reported separately — different margin,
    different growth, different risk (9.13)."""
    _require_business_financials(user)
    report = await _produce(svc.channel_breakdown(since, until, rates))
    return await _deliver(report, fmt, user)


# ══════════════════════════════════════════════════════════════════════════════
#  PARTNERS
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/agencies/{agency_id}/statement")
async def agency_statement(
    agency_id: str,
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Commission earned, paid and outstanding for any past window.

    Reproducible: opening and closing balances come from the ledger entries
    themselves, so March still says what March said (9.18). Amounts in the
    commission currency are minor units — paise. Divide by 100 for rupees, or
    read the `_inr` columns.
    """
    _require_business_financials(user)
    report = await _produce(
        svc.agency_statement_range(agency_id, since, until, rates)
    )
    return await _deliver(report, fmt, user)


@router.get("/sellers/{seller_id}/statement")
async def seller_statement(
    seller_id: str,
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Coins bought, lent, sold and on hand for a period, with credit standing."""
    _require_business_financials(user)
    report = await _produce(
        svc.seller_statement_range(seller_id, since, until, rates)
    )
    return await _deliver(report, fmt, user)


@router.get("/partners/summary")
async def partners_summary(
    kind: str = Query(
        default="agency",
        pattern="^(agency|seller)$",
        description="agency or seller — one row per partner.",
    ),
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """One row per partner — the weekly payout run (8A.3.5).

    Partners with no movement in the period are not listed, and the report says
    how many those are, so an absent row is never mistaken for a zero balance.
    """
    _require_business_financials(user)
    report = await _produce(svc.all_partners_summary(kind, since, until, rates))
    return await _deliver(report, fmt, user)


@router.get("/liabilities")
async def liabilities(
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Total owed to agencies and hosts right now, plus seller receivables.

    A point-in-time figure, so it takes no date range. Nobody can answer this
    today.
    """
    _require_business_financials(user)
    report = await _produce(svc.outstanding_liabilities(rates))
    return await _deliver(report, fmt, user)


# ══════════════════════════════════════════════════════════════════════════════
#  TEAMS
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/team-throughput")
async def team_throughput(
    team: Team | None = Query(
        default=None,
        description="Omit for every team — only owners and the Observer may.",
    ),
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    user: dict = Depends(require_internal),
):
    """Cards raised, verified, signed, executed and rejected; the median time in
    each stage; and the oldest item still open (8A.3.8, 10.11).

    Medians, not means — one stuck card should not move the number. A stage
    nobody completed in the period reports null, never zero.
    """
    scoped = _scoped_team(user, team)
    report = await _produce(svc.team_throughput(scoped, since, until))
    return await _deliver(report, fmt, user)


@router.get("/audit-summary")
async def audit_summary(
    since: datetime | None = _SINCE,
    until: datetime | None = _UNTIL,
    fmt: str = _FORMAT,
    user: dict = Depends(require_internal),
):
    """Every money action in the period, by actor and by type (8A.3.12).

    The monthly governance review. Owners and the Observer see every actor; a
    team admin sees their own department.
    """
    role: Role = user["role"]
    scope = R.audit_scope(role)
    if scope == "all":
        team = None
    elif scope == "team":
        team = user.get("team") or (
            str(R.team_of(role)) if R.team_of(role) else None
        )
        if not team:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This account belongs to no team, so it has no team audit summary.",
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "The audit summary covers other people's money actions and is "
                "for owners, the Observer and team admins. Your own history is "
                "available at /audit."
            ),
        )

    report = await _produce(svc.audit_summary(since, until, team))
    return await _deliver(report, fmt, user)


# ══════════════════════════════════════════════════════════════════════════════
#  DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/dashboard")
async def dashboard(
    fmt: str = _FORMAT,
    rates: Rates = Depends(request_rates),
    user: dict = Depends(require_internal),
):
    """Role-appropriate figures, queue depths and anything overdue (8A.3.1).

    Owners and the Observer see the whole business. A team admin sees their own
    team — and Finance, who run the payments, also see the money blocks. A
    member sees their team's queues and ageing, and the report says plainly
    that the money figures are withheld rather than showing zeroes.
    """
    role: Role = user["role"]
    team = user.get("team") or (str(R.team_of(role)) if R.team_of(role) else None)
    report = await _produce(svc.dashboard(role, team, rates))
    return await _deliver(report, fmt, user)


# ══════════════════════════════════════════════════════════════════════════════
#  THE OWNER'S WEEKLY BUSINESS REPORT
# ══════════════════════════════════════════════════════════════════════════════
#
# **Authority.** The trigger is `Op.REPORTS_SEND`, held by the `reporting`
# service credential and by any team admin. No new operation was added and
# nothing was added to the weekly-accrual credential's allowlist, and both of
# those are deliberate:
#
#   * `Op.REPORTS_SEND` already means exactly this — "generate and email a
#     scheduled report" — and this is a scheduled report. Minting a second
#     operation for the same act would make the allowlist longer without making
#     it narrower, and an allowlist nobody can hold in their head stops being a
#     control.
#   * It is **not** on the accrual credential. `config.py` states the reason for
#     keeping the two keys apart: leaking the ability to email a report must not
#     also grant the ability to create a commission liability. This report reads
#     the same ledger the accrual writes to, and putting it behind the accrual
#     key would have quietly undone that separation for the sake of one route.
#
# What the credential can do with it is bounded by what the route does: build a
# report, store one document, and send mail to addresses resolved from the staff
# record. Recipients never come from the request, so a leaked reporting key
# cannot redirect a business-wide money figure anywhere.


class WeeklyBusinessRequest(BaseModel):
    week: str | None = Field(
        default=None,
        description=(
            "ISO week, e.g. 2026-W33. Omitted, the most recently closed week is "
            "used — the job runs on a Sunday, when the current week has not "
            "finished, and a report on a week still in progress would have to be "
            "corrected."
        ),
    )
    force: bool = Field(
        default=False,
        description=(
            "Store a NEW revision beside the original rather than re-using it. "
            "For a week whose sections failed and have since been fixed. It "
            "never edits what was already stored."
        ),
    )
    top_n: int = Field(default=10, ge=1, le=100, description="Leaderboard length.")


@router.post("/jobs/weekly-business", status_code=status.HTTP_201_CREATED)
async def run_weekly_business(
    body: WeeklyBusinessRequest | None = None,
    user: dict = Depends(team_admin_or_reporting_service),
):
    """Build, store and email the owner's weekly business report.

    Idempotent on two axes and for two different reasons. The report is stored
    under the week's own id, so a second trigger for the same week is answered
    with the document that already exists and the figures do not move. The email
    carries a dedupe key per recipient, so a second trigger sends nothing twice —
    but a trigger that runs after a mail outage *does* deliver, because it
    re-sends the stored report rather than skipping.

    Never returns a partial success as a success: `failed_sections` and
    `needs_a_person` are in the response, and the caller is expected to say so.
    """
    body = body or WeeklyBusinessRequest()
    started = datetime.now(timezone.utc)

    # Who asked, on every run row this produces. `force=True` from a person is
    # the deliberate re-run the docstring above describes, and the run log says
    # so rather than showing two identical Sundays.
    with svc_schedule.triggered_by(user):
        try:
            return await svc_schedule.weekly(
                body.week, force=body.force, top_n=body.top_n
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
            ) from exc
        except ReportError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except RuntimeError as exc:
            # The report was computed and could not be stored. It was
            # deliberately not emailed — see `scheduling._store_week`. Recorded
            # as a failed run so it does not read as a Monday that never fired.
            await svc_schedule.record_failure(
                "reports.weekly",
                spec="owner request — the weekly business report",
                error=exc,
                started_at=started,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
            ) from exc
        except Exception as exc:  # noqa: BLE001
            await svc_schedule.record_failure(
                "reports.weekly",
                spec="owner request — the weekly business report",
                error=exc,
                started_at=started,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=(
                    f"The weekly business report failed and was not sent. "
                    f"{type(exc).__name__}: {exc}. It is on "
                    "GET /api/notifications/runs/last with status 'failed'."
                ),
            ) from exc


@router.get("/weekly-business/{week}")
async def weekly_business(week: str, user: dict = Depends(require_internal)):
    """Re-read a stored week. The figures are the ones that were stored.

    This is the point of keeping the report: an argument in March about what
    happened in August is settled by reading what was written in August, not by
    recomputing it against a ledger that has moved since.
    """
    _require_business_financials(user)
    try:
        revisions = await svc_schedule.read_week(week.strip())
    except (PyMongoError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                f"The stored weekly reports could not be read ({exc}). No figure "
                "is returned — an empty answer here would read as 'that week had "
                "no report', which is a different fact."
            ),
        ) from exc

    if not revisions:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"No weekly business report is stored for '{week}'. That means "
                "the job did not run for that week — it does not mean the week "
                "was empty. Trigger it with POST /api/reports/jobs/weekly-business."
            ),
        )
    for doc in revisions:
        doc["id"] = str(doc.pop("_id"))
    return {
        "week": week,
        "revisions": revisions,
        "current": revisions[0],
        "note": (
            "Revision 0 is what the Sunday job stored and is never edited. A "
            "later revision is a deliberate re-run and sits beside it."
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  DEFINITIONS
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/definitions")
async def definitions(user: dict = Depends(require_internal)):
    """The one definition of each figure (8A.6.3).

    Revenue, payout, margin, commission, the bean-payout ratio and channel mean
    exactly this, in every report and on every screen. Publishing them here is
    what stops "total payout" meaning four different things again.
    """
    return {
        "definitions": svc.DEFINITIONS,
        "units": {
            "money": "INR minor units (paise) unless a field name says otherwise",
            "commission": "minor units (paise) — divide by 100 for display",
            "diamonds_per_lakh": svc.DIAMONDS_PER_LAKH,
        },
        "window": {
            "default_days": svc.DEFAULT_WINDOW_DAYS,
            "max_days": svc.MAX_WINDOW_DAYS,
            "bounds": "[since, until) — start inclusive, end exclusive",
        },
        "rate_fallbacks": {
            "diamondPackPriceInr": svc.FALLBACK_DIAMOND_PACK_PRICE_INR,
            "giftRates.beanToInrRate": svc.FALLBACK_BEAN_TO_INR,
            "note": (
                "Used only when appConfig/economy cannot supply the rate. Any "
                "report that falls back says so and marks itself provisional."
            ),
        },
        "export": {
            "format": "?format=csv on any report endpoint",
            "logged": "Every export writes an audit entry (action 'export').",
        },
    }
