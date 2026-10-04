"""Scheduling, alerting and delivery visibility — the HTTP surface of Part 8A.

Three kinds of endpoint live here and nothing else does.

  * **Job triggers** (`/jobs/*`). Each is behind `_person_or_service`, so it is
    reachable either by a team admin with a session or by Cloud Scheduler
    holding the reporting service credential — the same pattern the weekly
    accrual established. Nothing here moves money; the credential that reaches
    these routes holds no money operation at all (`core/security.py::REPORTING`).

  * **Visibility** (`/deliveries`, `/alerts`, `/runs`). What was sent, to whom,
    whether it arrived, and what was raised. This is the answer to "did the
    agency actually get their rejection reason" (8A.2.14) and to "why has
    nothing arrived" (8A.2.15 / 8A.7.5).

  * **Previews** (`/email-templates`). Every template rendered with sample data,
    sent to nobody, recorded nowhere (8A.7.3).

**Recipients are never taken from a request.** No endpoint here accepts an
address to send to. Who receives a report is resolved from the staff record by
`services/notify.py`, and who may receive a class of figure is decided inside
`email.deliver()`. A caller can make a report go out; a caller cannot make it go
to them.

**A job that sent nothing returns why.** Every trigger answers with the run
summary, including per-section failures, unresolved audiences and suppressed
alerts. A 200 from these routes means the job ran, not that everything worked —
read `errors` and `failed_sections`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core import roles as R
from app.core.deps import (
    internal_or_email_events_service,
    require_internal,
    require_owner,
    team_admin_or_alerts_service,
    team_admin_or_reporting_service,
    team_admin_or_email_sweep_service,
    team_admin_or_reporting_service,
)
from app.core.roles import Role
from app.services import alerts as alert_svc
from app.services import email as mail
from app.services import notify
from app.services import reconcile
from app.services import scheduling

router = APIRouter(prefix="/notifications", tags=["notifications"])


# ── Scope ─────────────────────────────────────────────────────────────────────


def _require_oversight(user: dict) -> None:
    """Who may read the delivery log.

    A delivery row carries the subject line, and a subject line carries a
    figure — "Payout approved — ₹75,000.00". So the same rule the reports
    router applies to business-wide money applies here: owners, the Observer and
    team admins. A member sees their own work, not the company's mail.
    """
    role = user.get("role")
    if R.is_system(role):
        # A machine triggers jobs; it does not read the log its own sends
        # produced. Nothing routes it here, and this makes that independent of
        # which dependency happens to guard the route.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This is a reading route and requires a person.",
        )
    role = Role(str(role))
    if R.can_read_all(role) or R.is_team_admin(role):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "The delivery and alert log is available to owners, the Observer "
            "and team admins. Subject lines in it carry money figures."
        ),
    )


def _parse_dt(value: str | None, label: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{label} is not an ISO-8601 timestamp: {value!r}",
        ) from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ══════════════════════════════════════════════════════════════════════════════
#  Job triggers — the schedule, or a team admin on demand
# ══════════════════════════════════════════════════════════════════════════════
#
# **Every trigger leaves a row, including the ones that fall over.** The jobs
# themselves record their own summary at the end, which covers the ordinary case
# and the partial-failure case. `run_job()` below covers the third: a job that
# raises never reaches its own `record_run`, and without this the run log would
# be silent about it — indistinguishable from a scheduler that was never wired
# up. That silence is the exact failure this whole section exists to remove, so
# it is closed here rather than left to whoever reads the Cloud Function's log.
#
# The 500 that comes back names the job and carries the reason, because the
# thing on the other end of these routes is an unattended process whose only
# way of telling anyone is to fail loudly.


async def run_job(job: str, spec: str, actor: dict, coro):
    """Run one scheduled job on behalf of `actor`, and record it either way.

    `scheduling.triggered_by` stamps every run row this produces — including the
    ones written deeper down, like the partner statements the monthly pack runs
    — with who asked and whether it was the schedule or a person. A Sunday that
    ran twice because an owner re-ran it is a different fact from one that ran
    twice because the scheduler retried, and this is what tells them apart.
    """
    started = datetime.now(timezone.utc)
    with scheduling.triggered_by(actor):
        try:
            return await coro
        except HTTPException:
            # Already an answer with a reason in it — a bad detector name, a
            # period that is not a period. Not a failed run.
            raise
        except Exception as exc:  # noqa: BLE001
            failure = await scheduling.record_failure(
                job, spec=spec, error=exc, started_at=started
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "job": job,
                    "spec": spec,
                    "message": (
                        f"The job '{job}' failed and sent nothing. "
                        f"{type(exc).__name__}: {exc}"
                    ),
                    "recorded": failure.get("recorded", False),
                    "where_to_look": (
                        "GET /api/notifications/runs/last — this attempt is on "
                        "it with status 'failed'."
                        if failure.get("recorded")
                        else "The failure could ALSO not be written to the run "
                        "log, so nothing but this response records it. The "
                        "database is very likely the underlying problem."
                    ),
                },
            ) from exc


@router.post("/jobs/daily")
async def run_daily(
    actor: dict = Depends(team_admin_or_reporting_service),
):
    """8A.3.1 – 8A.3.3. Yesterday's business summary, Finance worklist and
    exception report.

    "Yesterday" is the business day — 00:00 to 24:00 in `REPORT_TIMEZONE`,
    Asia/Kolkata — converted to UTC before anything is queried. The job fires at
    07:00 IST, so the day it covers finished seven hours earlier and is whole.

    Idempotent: each email carries a dedupe key built from the report and that
    local date, so a retried trigger sends nothing a second time. Re-running it
    by hand after a mail outage *does* deliver anything that never went out.
    """
    return await run_job(
        "reports.daily", "8A.3.1/8A.3.2/8A.3.3", actor, scheduling.daily()
    )


@router.post("/jobs/monthly")
async def run_monthly(
    with_statements: bool = Query(
        default=True,
        description=(
            "Also send every partner their monthly statement (8A.3.10). Turn "
            "off to send only the internal pack."
        ),
    ),
    actor: dict = Depends(team_admin_or_reporting_service),
):
    """8A.3.9 – 8A.3.12. Last calendar month: P&L, accounting pack, audit
    summary, and every partner's formal statement.

    The month is a business-timezone month, so a report headed "August" covers
    1 August 00:00 IST to 1 September 00:00 IST.
    """
    return await run_job(
        "reports.monthly",
        "8A.3.9/8A.3.10/8A.3.11/8A.3.12",
        actor,
        scheduling.monthly(with_statements=with_statements),
    )


@router.post("/jobs/partner-statements")
async def run_partner_statements(
    period: str = Query(
        default="last-month",
        description=(
            "Named period: last-month (8A.3.10) or last-week (8A.3.6/8A.3.7). "
            "Resolved here, not by the caller — an unattended scheduler doing "
            "its own calendar arithmetic is how a statement and the commission "
            "on it come to cover different days. Ignored if since/until are given."
        ),
    ),
    since: str | None = Query(
        default=None,
        description="ISO-8601 start, inclusive. Overrides `period`.",
    ),
    until: str | None = Query(
        default=None, description="ISO-8601 end, exclusive. Overrides `period`."
    ),
    cadence: str = Query(
        default="monthly",
        pattern="^(weekly|monthly|adhoc)$",
        description="Recorded on the delivery and used for the dedupe key.",
    ),
    kind: str = Query(
        default="both",
        pattern="^(agency|seller|both)$",
    ),
    actor: dict = Depends(team_admin_or_reporting_service),
):
    """8A.3.6 / 8A.3.7 — the delivery half of partner statements.

    The figures are `reports.agency_statement_range` and
    `reports.seller_statement_range` unchanged, so a past period reproduces
    exactly at that period's rates (9.18 / 8A.5.3).

    The dedupe key carries the cadence and the period, so the weekly Monday run
    and the monthly run on the 1st are two different statements rather than a
    duplicate — and re-firing either sends nothing twice.
    """
    kinds = ("agency", "seller") if kind == "both" else (kind,)

    resolved_since = _parse_dt(since, "since")
    resolved_until = _parse_dt(until, "until")
    if resolved_since is None or resolved_until is None:
        try:
            resolved_since, resolved_until = scheduling.statement_period(period)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
            ) from exc

    return await run_job(
        "reports.partner_statements",
        "8A.3.6/8A.3.7",
        actor,
        scheduling.partner_statements(
            since=resolved_since,
            until=resolved_until,
            cadence=cadence,
            spec="8A.3.6/8A.3.7",
            kinds=kinds,
        ),
    )


@router.post("/jobs/alerts")
async def run_alerts(
    only: str | None = Query(
        default=None,
        description=(
            "Comma-separated detector ids to run. Omit for all of them. See "
            "GET /notifications/alerts for the list."
        ),
    ),
    actor: dict = Depends(team_admin_or_alerts_service),
):
    """8A.4.1 – 8A.4.9. Run every exception detector and send what is newly true.

    Safe to schedule frequently: repeats are suppressed by
    `alert_state`, so a half-hourly scan of a condition that stays true produces
    one email per repeat window, not one per scan (8A.1.4).
    """
    ids = [part.strip() for part in (only or "").split(",") if part.strip()]
    unknown = [i for i in ids if i not in alert_svc.DETECTORS_BY_ID]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"No such detector: {', '.join(unknown)}. Known: "
                f"{', '.join(sorted(alert_svc.DETECTORS_BY_ID))}."
            ),
        )
    return await run_job(
        "alerts.scan", "8A.4.1-8A.4.9", actor, alert_svc.scan(ids or None)
    )


@router.post("/jobs/transactional-sweep")
async def run_transactional_sweep(
    only: str | None = Query(
        default=None,
        description="Comma-separated sweep names. Omit for all of them.",
    ),
    actor: dict = Depends(team_admin_or_email_sweep_service),
):
    """8A.2.5 / 8A.2.7 / 8A.2.8 / 8A.2.10 / 8A.2.11 / 8A.2.13.

    Sends every transactional email a record says is owed and the delivery log
    says has not gone out. Idempotent by `email_deliveries.dedupe_key`.
    """
    names = {name for name, _, _ in scheduling.SWEEPS}
    ids = [part.strip() for part in (only or "").split(",") if part.strip()]
    unknown = [i for i in ids if i not in names]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No such sweep: {', '.join(unknown)}. Known: {', '.join(sorted(names))}.",
        )
    return await run_job(
        "email.transactional_sweep",
        "8A.2.5/8A.2.7/8A.2.8/8A.2.10/8A.2.11/8A.2.13",
        actor,
        scheduling.transactional_sweep(ids or None),
    )


@router.post("/provider-events")
async def provider_events(
    events: list[dict] = Body(
        default_factory=list,
        description="A SendGrid Event Webhook batch.",
    ),
    actor: dict = Depends(internal_or_email_events_service),
):
    """8A.7.5 — bounces, drops, deferrals and spam reports.

    A bounce is the difference between "SendGrid accepted it" and "the mailbox
    took it". Without this, a partner whose address is dead looks exactly like a
    partner who was told.

    Point the SendGrid Event Webhook here and give it the reporting service key
    in the `X-Service-Key` header.
    """
    if not isinstance(events, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A SendGrid event batch is a JSON array.",
        )
    return await mail.record_provider_events(events)


# ══════════════════════════════════════════════════════════════════════════════
#  Delivery visibility — 8A.2.14 / 8A.2.15
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/deliveries")
async def deliveries(
    kind: str | None = Query(default=None, description="e.g. partner.rejected"),
    outcome: str | None = Query(default=None, description="e.g. sent, failed, bounced"),
    to: str | None = Query(default=None, description="Exact recipient address."),
    since: str | None = Query(default=None, description="ISO-8601."),
    limit: int = Query(default=100, ge=1, le=500),
    user: dict = Depends(require_internal),
):
    """Every attempted send: what, to whom, when, and how it ended (8A.2.14).

    This is where "did the agency actually get their rejection reason" is
    answered. Filter by `to` for one partner, or by `kind` for one template.
    """
    _require_oversight(user)
    rows = await mail.recent_deliveries(
        limit=limit,
        kind=kind,
        outcome=outcome,
        to=to,
        since=_parse_dt(since, "since"),
    )
    return {
        "deliveries": rows,
        "count": len(rows),
        "note": (
            "The subject line is stored; the body is not. A delivery record "
            "proves what was sent and to whom — it is not a second copy of the "
            "figures, and it never holds a credential."
        ),
    }


@router.get("/deliveries/failures")
async def delivery_failures(
    hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=500),
    user: dict = Depends(require_internal),
):
    """Everything that did not arrive. Spec 8A.2.15.

    `queued` counts as a failure: a row stuck in queued means the process died
    between recording the send and the provider answering, so the outcome is
    genuinely unknown — which is not the same as delivered.
    """
    _require_oversight(user)
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = await mail.recent_failures(since=since, limit=limit)
    return {
        "failures": rows,
        "count": len(rows),
        "window_hours": hours,
        "outcomes_counted_as_failure": sorted(mail.FAILURE_OUTCOMES),
    }


@router.get("/deliveries/summary")
async def delivery_summary(
    hours: int = Query(default=24, ge=1, le=720),
    user: dict = Depends(require_internal),
):
    """Counts by outcome — the shape of the delivery half of the exception report."""
    _require_oversight(user)
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    return await mail.delivery_summary(since)


# ══════════════════════════════════════════════════════════════════════════════
#  Alerts — what is watched, and what has been raised
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/alerts")
async def alert_catalogue(user: dict = Depends(require_internal)):
    """Every detector: what it watches, its threshold, who is told, and how long
    it stays quiet after firing (8A.4)."""
    _require_oversight(user)
    return {
        "detectors": alert_svc.catalogue(),
        "suppression": (
            "An alert is keyed on the condition, not on the scan. Inside its "
            "repeat window the same condition, unchanged, sends nothing. A "
            "condition that changes — a third card on a duplicate reference, a "
            "growing debt — re-alerts immediately."
        ),
    }


@router.get("/alerts/raised")
async def alerts_raised(
    limit: int = Query(default=200, ge=1, le=500),
    user: dict = Depends(require_internal),
):
    """What has been raised and when — the suppression state, read directly.

    If somebody says "I was not told", this is the record that answers it, and
    `/deliveries?kind=alert.<id>` says whether the email arrived.
    """
    _require_oversight(user)
    return {"raised": await alert_svc.recent_state(limit)}


@router.get("/alerts/open")
async def alerts_open(user: dict = Depends(require_internal)):
    """Everything currently wrong, without sending anything.

    Detectors that could not run are listed with their reason and status
    `failed`; conditions that cannot apply here are `not_applicable`. A check
    that did not run is never reported as a check that passed.
    """
    _require_oversight(user)
    findings = await alert_svc.open_findings()
    return {
        "findings": findings,
        "open": sum(1 for f in findings if f.get("status") == "ok"),
        "did_not_run": [f for f in findings if f.get("status") == "failed"],
        "not_applicable": [f for f in findings if f.get("status") == "not_applicable"],
    }


@router.delete("/alerts/raised/{key:path}")
async def release_alert(key: str, user: dict = Depends(require_owner)):
    """Forget one raised condition, so it can alert again.

    Used after something is fixed. Without it, a condition that fires, is
    resolved, and recurs the next day would be suppressed as a repeat of the
    first occurrence.
    """
    released = await alert_svc.release(key)
    if not released:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No alert state is held under the key {key!r}.",
        )
    return {"released": key}


# ══════════════════════════════════════════════════════════════════════════════
#  Scheduled runs
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/schedule")
async def schedule(user: dict = Depends(require_internal)):
    """What runs, when, in whose clock, and which Cloud Function fires it.

    The system still does not schedule itself — Cloud Scheduler does, through
    the functions named on each row (`functions/src/index.ts`, DEPLOYMENT.md
    § 9). This table and those functions carry the same cron, so a drift between
    what the API says is scheduled and what actually fires is a diff in one file
    rather than something discovered on a quiet Monday.
    """
    _require_oversight(user)
    return {
        "timezone": scheduling.SCHEDULE_TIMEZONE,
        "clock": (
            "Every cron below is read in "
            f"{scheduling.SCHEDULE_TIMEZONE}, and every period a job covers is "
            "cut in the same zone. A 'daily' report covers the local calendar "
            "day, not [00:00 UTC, 24:00 UTC)."
        ),
        "statement_periods": scheduling.STATEMENT_PERIODS,
        "jobs": list(scheduling.SCHEDULE),
        "last_run": "GET /api/notifications/runs/last",
    }


@router.get("/runs/last")
async def last_runs(user: dict = Depends(require_internal)):
    """When each scheduled job last ran, and whether it worked.

    The page an owner opens to answer "is any of this actually running?".
    Every job is listed whether or not it has ever run, and four outcomes are
    kept apart on purpose:

      * `ok`        — it ran and everything in it worked;
      * `degraded`  — it ran, delivered what it could, and something in it did
        not: a section that could not be computed, an audience that resolved to
        nobody, a detector that could not be evaluated. Read `problems`;
      * `failed`    — it raised and sent nothing;
      * `never`     — no run has ever been recorded, which means the schedule
        was never wired up rather than that the period was empty.

    `stalled` is set independently of all four: a job whose last run was `ok`
    three weeks ago is not a healthy job.
    """
    _require_oversight(user)
    rows = await scheduling.last_runs()
    return {
        "jobs": rows,
        "healthy": [r["job"] for r in rows if r.get("status") == "ok" and not r.get("stalled")],
        "needs_attention": [
            r["job"]
            for r in rows
            if r.get("stalled") or r.get("status") in {"failed", "never", "degraded", "unknown"}
        ],
        "timezone": scheduling.SCHEDULE_TIMEZONE,
        "note": (
            "'degraded' is a run that happened and was incomplete — it is not a "
            "success and it is not a failure, and collapsing it into either is "
            "how a report that has been missing a section for a month goes "
            "unnoticed."
        ),
    }


@router.get("/runs")
async def runs(
    job: str | None = Query(
        default=None,
        description=(
            "The value in `scheduled_runs.job` — e.g. reports.daily, "
            "alerts.scan, email.transactional_sweep. GET /schedule maps each "
            "scheduled job to its `run_job`."
        ),
    ),
    limit: int = Query(default=50, ge=1, le=200),
    user: dict = Depends(require_internal),
):
    """The log of unattended runs: when each ran, what it sent, what failed.

    Each row carries `status`, `trigger` ("schedule" or "person") and
    `triggered_by`, so a deliberate re-run is visibly a re-run and not a second
    scheduled firing.
    """
    _require_oversight(user)
    return {"runs": await scheduling.recent_runs(limit=limit, job=job)}


# ══════════════════════════════════════════════════════════════════════════════
#  Subscriptions — 8A.3.13 / 8A.3.14 / 8A.3.15
# ══════════════════════════════════════════════════════════════════════════════


class SubscriptionIn(BaseModel):
    report: str = Field(description="e.g. monthly_accounting_pack")
    cadence: str = Field(description="daily | weekly | monthly")
    email: str
    name: str = ""
    muted: bool = Field(
        default=False,
        description="True turns this report off for this address (8A.3.15).",
    )


@router.post("/subscriptions", status_code=status.HTTP_201_CREATED)
async def set_subscription(body: SubscriptionIn, user: dict = Depends(require_owner)):
    """Add an outside address to a report, or turn a report off for an address.

    Owners only, because subscribing an address with no role on record is the
    single way a business-wide money figure reaches someone outside the staff
    list (8A.3.14). The owner's uid is stored on the row and travels with the
    recipient, so `email.may_receive` can point at the decision that allowed it.

    A subscription is an addition or a subtraction. It never replaces a standing
    audience, and alerts do not consult this table at all — an exception nobody
    can switch off is the point of 8A.4.
    """
    try:
        return await notify.set_subscription(
            report=body.report,
            cadence=body.cadence,
            email=body.email,
            name=body.name,
            muted=body.muted,
            authorised_by=user.get("uid", ""),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@router.get("/subscriptions")
async def list_subscriptions(
    report: str = Query(...),
    cadence: str = Query(...),
    user: dict = Depends(require_internal),
):
    _require_oversight(user)
    return {"subscriptions": await notify.subscriptions(report, cadence)}


# ── One-click unsubscribe — RFC 8058, and Gmail/Yahoo's bulk-sender rule ─────


@router.post("/unsubscribe", status_code=status.HTTP_200_OK)
async def one_click_unsubscribe(
    e: str = Query(..., description="The address to mute. Bound into the token."),
    r: str = Query(..., description="The report key."),
    c: str = Query("", description="The cadence."),
    t: str = Query(..., description="The signature from the List-Unsubscribe header."),
):
    """Turn one scheduled report off for one address. **Deliberately unauthenticated.**

    RFC 8058 one-click is a POST made by the recipient's *mail provider*, not by
    the recipient's browser session — Gmail sends it from its own infrastructure
    with no cookie, so requiring a login here would mean advertising a one-click
    unsubscribe that never works, which is worse for a domain's reputation than
    advertising none. `settings.unsubscribe_url` is empty by default and the
    `List-Unsubscribe-Post` header is only emitted once it is set, so nothing
    points at this route until an operator says it may.

    What stops it being an open mute switch is `t`: an HMAC over
    `address|report|cadence` keyed with the application secret, generated per
    recipient in `email.unsubscribe_token`. Holding one token mutes exactly one
    address for exactly one report — the recipient's own decision, which is the
    entire point — and forwarding the email gives the recipient of the forward
    no power over anyone else's subscription.

    Three things it deliberately cannot do:

      * **it cannot silence an alert.** `alerts.py` does not consult the
        subscriptions table at all (8A.4), and its List-Unsubscribe is a mailto
        to a person for exactly this reason;
      * **it cannot mute a partner's own statement**, which carries no
        unsubscribe header because it is that partner's account record;
      * **it cannot reveal anything.** The answer is the same shape whether or
        not the address was ever subscribed, and no figure, name or role is
        returned.
    """
    address = str(e or "").strip().lower()
    if not mail.unsubscribe_token_valid(address, r, c, t):
        # Same message for a bad signature and a malformed address: an
        # unsubscribe endpoint is not a place to confirm whether an address is
        # on a list.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That unsubscribe link is not valid for this address.",
        )
    try:
        await notify.set_subscription(
            report=r, cadence=c, email=address, muted=True
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    return {
        "unsubscribed": True,
        "report": r,
        "cadence": c,
        "note": (
            "This address will no longer receive that report. It changes "
            "nothing else: alerts, your own account records and anything "
            "addressed to you personally still arrive."
        ),
    }


@router.get("/unsubscribe")
async def one_click_unsubscribe_page(
    e: str = Query(...), r: str = Query(...), c: str = Query(""), t: str = Query(...),
):
    """The same thing for a person who clicked the link in a mail client that
    renders it as a URL rather than making the POST itself."""
    return await one_click_unsubscribe(e=e, r=r, c=c, t=t)


@router.get("/audiences/{name:path}")
async def preview_audience(name: str, user: dict = Depends(require_internal)):
    """Who an audience name currently resolves to — 'owners', 'observer',
    'finance_admin', 'team_admin:finance'.

    Answers "who would be told" before a threshold is changed, and shows an
    audience that resolves to nobody as the configuration failure it is.
    """
    _require_oversight(user)
    try:
        resolution = await notify.resolve([name])
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    return {
        "audience": name,
        **resolution.summary(),
        # Addresses, not names — this is the check that an alert is going
        # somewhere real.
        "addresses": [r.email or "(no address on the staff record)"
                      for r in resolution.recipients],
        "problem": resolution.why_empty() or None,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  Template previews — 8A.7.3
# ══════════════════════════════════════════════════════════════════════════════


@router.get("/email-templates")
async def email_templates(user: dict = Depends(require_internal)):
    """Every template, its spec point and who it goes to. Nothing is sent."""
    return {
        "templates": [
            {"name": name, "spec": spec, "goes_to": goes_to}
            for name, spec, goes_to in mail.PREVIEWABLE
        ],
        "preview": "GET /api/notifications/email-templates/{name}/preview",
        "note": (
            "Marketing owns the wording in app/templates; Tech owns delivery in "
            "services/email.py. Changing a sentence needs no Python change "
            "(8A.7.2)."
        ),
    }


@router.get("/email-templates/{name}/preview")
async def preview_template(name: str, user: dict = Depends(require_internal)):
    """One template rendered with sample data.

    No live figure is read, no delivery row is written and nothing is sent
    (8A.7.3). Returned as JSON so a caller can show either the subject or the
    HTML; the HTML is a full email body.
    """
    try:
        subject, html = mail.preview(name)
    except mail.TemplateError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    return {"template": name, "subject": subject, "html": html, "sent": False}


# ── Reconciliation ────────────────────────────────────────────────────────────


@router.post("/jobs/reconcile")
async def run_reconcile(
    day: str | None = Query(
        default=None,
        description="IST day as YYYY-MM-DD. Omit for yesterday.",
    ),
    actor: dict = Depends(team_admin_or_reporting_service),
):
    """Compare the app's Firestore economy against the Mongo ledger for one day.

    The app's money is written by Cloud Functions into Firestore; the business
    ledger lives here. Nothing compared the two, so they could drift for weeks
    before a month-end figure looked wrong and nobody could say when it started.

    Corrects nothing on purpose — a job that silently repairs a difference
    destroys the evidence of what caused it. A day outside tolerance raises an
    alert to owner and finance, keyed on the day so it does not repeat daily.
    """
    when = None
    if day:
        try:
            when = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="day must be YYYY-MM-DD.",
            ) from exc
    return await run_job(
        "economy.reconcile",
        "app-economy",
        actor,
        reconcile.reconcile_day(when, actor),
    )


@router.get("/reconciliation")
async def reconciliation_history(
    limit: int = Query(30, ge=1, le=365),
    actor: dict = Depends(team_admin_or_reporting_service),
):
    """The last N days checked, newest first, with both figures and the gap."""
    return await reconcile.recent(limit)
