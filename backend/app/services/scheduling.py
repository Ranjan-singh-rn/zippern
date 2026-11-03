"""Scheduled reports and the transactional sweep — spec 8A.3, and 8A.2's triggers.

Nothing in this module computes a figure. Every money number in every report
below comes from `app/services/reports.py` by calling it — `cash_position`,
`channel_breakdown`, `margin_report`, `outstanding_liabilities`,
`agency_statement_range`, `seller_statement_range`, `audit_summary`,
`dashboard`. That is the whole point of 8A.6.3: two definitions of revenue is
the problem this system was rebuilt to remove, and a second one would be created
the moment a report emailed a figure it worked out for itself.

**What it does own.** Which reports exist, what period each covers, who each
goes to, and what an email says when a section could not be produced.

**A section that fails says so.** `_section()` catches the report's own refusal
and keeps the text. `_render()` prints it as a critical block. There is no path
in this module by which a failed computation becomes a zero, an empty table, or
a missing heading (8A.6.5 / 9.15).

**A report that reaches nobody is a failed run.** Recipients come from
`notify.py`, which reads the staff record. A resolution with no addresses is
recorded as an error on the run, with the reason, rather than as a send of zero
emails.

**Every send is idempotent.** Each delivery carries a `dedupe_key` built from
the report, the period and the recipient, and `email_deliveries.dedupe_key` is
unique — so Cloud Scheduler retrying a trigger that already ran sends nothing a
second time.

Money is integer INR minor units (paise) throughout.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

from app.config import settings
from app.services import alerts
from app.services import email as mail
from app.services import notify
from app.services.notify import Audience

log = logging.getLogger(__name__)

OWNERS = str(Audience.OWNERS)
OBSERVER = str(Audience.OBSERVER)
FINANCE = str(Audience.FINANCE_ADMIN)

#: How far back a transactional sweep looks for an event that still owes an
#: email. Generous on purpose: the sweep is the only trigger these emails have
#: while the money path itself does not call `email.py`, and re-running it is
#: free because every send carries a unique `dedupe_key`. A rejection decided
#: five weeks ago and never notified is still a rejection nobody explained.
SWEEP_WINDOW_DAYS = 30


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _db():
    from app.db.mongo import get_db

    return get_db()


def _c(name: str):
    return _db()[name]


# ══════════════════════════════════════════════════════════════════════════════
#  Periods — in the reader's calendar, queried in UTC
# ══════════════════════════════════════════════════════════════════════════════
#
# Every window below is half-open, `[since, until)`, matching
# `reports.resolve_window`, so consecutive reports never double-count a movement
# and never miss one.
#
# They are also resolved in the **business timezone** (`REPORT_TIMEZONE`,
# Asia/Kolkata) and only then converted to UTC. This is the difference between a
# daily report that covers the day its reader thinks it does and one that does
# not: at UTC+05:30, [00:00 UTC, 24:00 UTC) is 05:30 yesterday morning to 05:30
# this morning locally. It drops the whole of yesterday evening — the busiest
# hours of a live-streaming business — and silently folds this morning in
# instead. The figures would be arithmetically correct and would answer a
# question nobody asked.
#
# Nothing about the ledger changes. Timestamps are stored and compared in UTC
# throughout; this decides only where the day is cut, and every report already
# prints the bounds it used.
#
# The on-demand endpoints in `routers/reports.py` are deliberately untouched: a
# caller who passes explicit `since`/`until` means exactly what they passed.

#: Zones with a fixed offset that the fallback below can honour exactly. A zone
#: is only here if it observes no daylight saving, because a fixed offset for a
#: zone that shifts twice a year is a wrong answer for half the year and a
#: silent one. Asia/Kolkata has observed none since 1945.
_FIXED_OFFSET_ZONES: dict[str, int] = {
    "Asia/Kolkata": 330,
    "Asia/Calcutta": 330,
    "UTC": 0,
    "Etc/UTC": 0,
}


def business_tz() -> Any:
    """The timezone the scheduled reports are cut in, or a loud refusal.

    Prefers the real zone from `zoneinfo`. A slim container image without the
    `tzdata` package has no zone database, so the documented fixed offset is
    used for a zone that provably has one — and anything else raises rather than
    quietly reporting on UTC days and labelling them as local ones.
    """
    name = str(getattr(settings, "report_timezone", "") or "UTC").strip() or "UTC"
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception as exc:  # noqa: BLE001 — no zone database in this image
        minutes = _FIXED_OFFSET_ZONES.get(name)
        if minutes is None:
            raise RuntimeError(
                f"REPORT_TIMEZONE is '{name}' and this deployment has no time "
                f"zone database to resolve it ({type(exc).__name__}: {exc}). "
                "Install the 'tzdata' package in the image, or set "
                "REPORT_TIMEZONE to one of "
                f"{', '.join(sorted(_FIXED_OFFSET_ZONES))}. The report is NOT "
                "produced against UTC instead — a window labelled as local days "
                "that is really UTC days is worse than no window."
            ) from exc
        log.warning(
            "No time zone database is available, so REPORT_TIMEZONE '%s' is "
            "being honoured as its documented fixed offset of %+d minutes. "
            "This is exact for '%s', which observes no daylight saving.",
            name,
            minutes,
            name,
        )
        return timezone(timedelta(minutes=minutes))


def _local(moment: datetime) -> datetime:
    """One UTC instant, seen in the business timezone."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(business_tz())


def _utc(moment: datetime) -> datetime:
    return moment.astimezone(timezone.utc)


def day_key(moment: datetime) -> str:
    """The business-calendar date an instant falls on, e.g. '2026-02-28'.

    Used for the dedupe key and the stored period, so "the daily report for the
    28th" is the 28th as the reader lived it. Taking `.date()` off the UTC start
    of the window would name the 27th for an IST day.
    """
    return _local(moment).date().isoformat()


def month_key(moment: datetime) -> str:
    """The business-calendar month an instant falls in, e.g. '2026-02'."""
    return _local(moment).strftime("%Y-%m")


def yesterday(now: datetime | None = None) -> tuple[datetime, datetime]:
    """[start of yesterday, start of today) — business days, returned in UTC."""
    local = _local(now or _now())
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return _utc(today - timedelta(days=1)), _utc(today)


def last_month(now: datetime | None = None) -> tuple[datetime, datetime]:
    """[first moment of last month, first moment of this month) — in UTC.

    The months are business-calendar months. `timedelta(days=1)` off the first
    of this month lands in the previous month whatever its length, so February
    needs no special case and no 30-day assumption.
    """
    local = _local(now or _now())
    this_month = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_start = (this_month - timedelta(days=1)).replace(day=1)
    return _utc(prev_start), _utc(this_month)


def last_week(now: datetime | None = None) -> tuple[datetime, datetime, str]:
    """The most recently closed ISO week — [Monday, Monday) in UTC, and its label.

    Deliberately **not** cut in the business timezone, and deliberately not
    computed here. An ISO week in this system is whatever
    `commission.resolve_period` says it is, because that is the window agency
    commission is billed over; a weekly statement measured over a different
    seven days from the commission on it is the disagreement 9.13 exists to
    prevent. The daily and monthly reports have no such twin and are cut locally.
    """
    label = last_closed_iso_week(now)
    since, until, label = _weekly_window(label)
    return since, until, label


#: The periods a partner statement run can be asked for by name. An unattended
#: scheduler must not do calendar arithmetic of its own — the Cloud Function
#: that fires the weekly statement job says `period=last-week` and this module
#: decides what that means, so the window on a statement and the window on the
#: commission inside it come from the same place.
STATEMENT_PERIODS: dict[str, str] = {
    "last-month": "The last complete calendar month, in the business timezone. "
                  "The formal monthly record — 8A.3.10.",
    "last-week": "The most recently closed ISO week, [Monday 00:00 UTC, next "
                 "Monday 00:00 UTC) — the same window agency commission is "
                 "billed over. 8A.3.6 / 8A.3.7.",
}


def statement_period(name: str, now: datetime | None = None) -> tuple[datetime, datetime]:
    """Resolve a named statement period, or refuse by name."""
    key = str(name or "").strip().lower()
    if key == "last-month":
        return last_month(now)
    if key == "last-week":
        since, until, _ = last_week(now)
        return since, until
    raise ValueError(
        f"'{name}' is not a statement period. Known: "
        f"{', '.join(sorted(STATEMENT_PERIODS))}."
    )


def _label(since: datetime, until: datetime) -> str:
    """The period, written the way it will be read — in the business timezone."""
    start = _local(since)
    end = _local(until - timedelta(seconds=1))
    if (until - since) <= timedelta(days=1, hours=1):
        return start.strftime("%d %b %Y")
    return f"{start.strftime('%d %b %Y')} – {end.strftime('%d %b %Y')}"


# ══════════════════════════════════════════════════════════════════════════════
#  Sections — a report, or the reason there is none
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Section:
    """One block of a scheduled email.

    Exactly one of `envelope` and `error` is set. There is no third state, and
    in particular there is no "empty" state — an empty *period* is a report that
    produced no rows and says so in its own words, which is a successful report.
    """

    title: str
    envelope: dict | None = None
    error: str | None = None
    attachment: mail.Attachment | None = None

    @property
    def ok(self) -> bool:
        return self.envelope is not None


async def _section(
    title: str,
    produce: Awaitable[Any],
    *,
    attach: bool = True,
) -> Section:
    """Run one report, keeping its refusal if it refuses.

    `reports.ReportError` carries the report's own explanation of why it could
    not be produced. That text is what the email prints — not a generic
    "unavailable", and never a zero.
    """
    from app.services.reports import ReportError

    try:
        report = await produce
    except ReportError as exc:
        return Section(title=title, error=str(exc))
    except Exception as exc:  # noqa: BLE001 — one bad section, not the whole mail
        log.exception("Report section '%s' failed", title)
        return Section(
            title=title,
            error=(
                f"{type(exc).__name__}: {exc}. This section was not computed. "
                "Treat it as unknown — it is not a zero and not an empty period."
            ),
        )

    attachment = None
    if attach:
        try:
            attachment = mail.Attachment(
                filename=report.filename(), data=report.csv().encode("utf-8")
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("CSV for '%s' could not be built: %s", title, exc)

    envelope = report.as_dict()
    envelope["title"] = title or envelope.get("title")
    return Section(title=title, envelope=envelope, attachment=attachment)


def _render(sections: Sequence[Section]) -> str:
    """Every section, in order, with failures shown as failures."""
    parts: list[str] = []
    for section in sections:
        if section.ok:
            parts.append(
                mail.report_body(
                    section.envelope,
                    attached=section.attachment.filename if section.attachment else None,
                )
            )
            continue
        parts.append(
            f'<h2 style="font-size:16px;margin:26px 0 10px">{mail.esc(section.title)}</h2>'
            + mail.callout(
                section.error or "No reason was recorded.",
                "critical",
                heading="Could not be computed — this is not a zero",
            )
        )
    return "".join(parts)


def _attachments(
    sections: Sequence[Section],
) -> tuple[list[mail.Attachment], list[dict]]:
    """The CSVs that can actually be sent, and why any of them cannot.

    Two sections of one email can produce the same filename — `Report.filename()`
    is `{name}_{period_slug}.csv` and nothing stops two sections sharing a name
    and a period. `mail.prepare_attachments` renames the second deterministically
    rather than letting two identically-named files reach one mailbox, and drops
    anything the provider would refuse, naming it.
    """
    return mail.prepare_attachments(
        [s.attachment for s in sections if s.attachment is not None]
    )


def _attachment_note(
    sections: Sequence[Section],
    attached: Sequence[mail.Attachment] = (),
    omitted: Sequence[Mapping[str, Any]] = (),
) -> str:
    """What is attached, what is not, and why not — in the email itself.

    `attached` is the *prepared* list, so the names in the note are the names on
    the files, including any that were renamed to keep them apart.
    """
    files = [a.filename for a in attached]
    failed = [s.title for s in sections if not s.ok]
    note = (
        f"Attached: {', '.join(files)}. The tables in this email are previews; "
        "the CSVs are the reports."
        if files
        else "No CSV is attached to this email."
    )
    if failed:
        note += (
            f" {len(failed)} section(s) could not be computed and are shown as "
            f"failures rather than as zeroes: {', '.join(failed)}."
        )
    if omitted:
        # Never a silent absence. The reader is told which file is missing and
        # the reason, so a missing CSV is not read as an empty one.
        note += " " + mail.omission_sentence(omitted)
    return note


# ══════════════════════════════════════════════════════════════════════════════
#  Sending
# ══════════════════════════════════════════════════════════════════════════════


async def _send_report(
    *,
    kind: str,
    spec: str,
    report_key: str,
    cadence: str,
    audiences: Sequence[str],
    subject: str,
    title: str,
    preheader: str,
    intro: str,
    sections: Sequence[Section],
    sensitivity: str,
    period_key: str,
) -> dict:
    """Resolve, render, deliver. Returns what happened, including nothing."""
    people = await notify.resolve(audiences, report=report_key, cadence=cadence)
    result: dict[str, Any] = {
        "report": report_key,
        "spec": spec,
        "cadence": cadence,
        "period": period_key,
        "sections": [
            {"title": s.title, "ok": s.ok, "error": s.error} for s in sections
        ],
        "failed_sections": [s.title for s in sections if not s.ok],
        "recipients": people.summary(),
    }

    if not people.ok:
        result["sent"] = 0
        result["error"] = people.why_empty()
        log.error("%s not sent: %s", report_key, result["error"])
        return result

    # Decided before the body is written, so the body can say what is missing.
    attachments, omitted = _attachments(sections)
    result["attachments"] = [a.filename for a in attachments]
    result["attachments_omitted"] = list(omitted)
    if omitted:
        log.warning(
            "%s: %d attachment(s) omitted — %s",
            report_key, len(omitted),
            "; ".join(f"{o['filename']}: {o['reason']}" for o in omitted),
        )

    html = mail.page(
        title=title,
        preheader=preheader,
        body=mail.build_scheduled_report(
            intro=intro,
            bodies=[_render(sections)],
            attachment_note=_attachment_note(sections, attachments, omitted),
            unsubscribe_note=(
                f"Ask an owner to mute '{report_key}' at the {cadence} cadence "
                "for your address, or use the unsubscribe link your mail client "
                "shows next to the sender"
            ),
        ),
    )

    rows = await mail.deliver_many(
        people.recipients,
        kind=kind,
        spec=spec,
        subject=subject,
        html=html,
        sensitivity=sensitivity,
        dedupe_prefix=f"{report_key}:{cadence}:{period_key}",
        meta={"report": report_key, "period": period_key, "cadence": cadence},
        attachments=attachments,
        # A scheduled report is bulk mail by every definition a receiver uses:
        # machine-generated, repeated on a timetable, to a standing list. So it
        # leaves from the bulk identity and carries the unsubscribe headers
        # Gmail and Yahoo have required of bulk senders since February 2024.
        identity=mail.SenderIdentity.BULK,
        unsubscribe=mail.Unsubscribe(report=report_key, cadence=cadence),
    )
    result["sent"] = sum(1 for r in rows if r.get("outcome") == str(mail.Outcome.SENT))
    result["outcomes"] = [r.get("outcome") for r in rows]
    result["error"] = None
    return result


# ══════════════════════════════════════════════════════════════════════════════
#  The run log — what ran, when, on whose behalf, and how it ended
# ══════════════════════════════════════════════════════════════════════════════
#
# An unattended job that fails silently is indistinguishable from one that was
# never scheduled, and both look exactly like a quiet week. So every trigger
# leaves a row in `scheduled_runs` whatever happens to it:
#
#   * it finished           → `status: "ok"`;
#   * it finished with a section, a sweep or a detector that did not run, or
#     with an audience that resolved to nobody
#                           → `status: "degraded"`, with what failed;
#   * it raised             → `status: "failed"`, with the exception, written by
#     `record_failure()` from the router's own error path — the job never gets
#     to write its own summary in that case, which is exactly when the row
#     matters most;
#   * the row itself could not be written
#                           → `recorded: false` on the returned summary, so the
#     caller's HTTP response and the scheduler's log say so even though the
#     database could not.
#
# Every row also carries **who asked**. A Sunday that ran twice because somebody
# re-ran it by hand is a different fact from a Sunday that ran twice because the
# scheduler retried, and `trigger` / `triggered_by` is what tells them apart.


#: Set by the router for the life of one request. A `ContextVar` rather than an
#: argument because the summaries are built five levels down and threading an
#: actor through every one of them would put the caller's identity into the
#: signature of functions that have no business with it.
_TRIGGER: ContextVar[dict] = ContextVar("scheduled_run_trigger", default={})


@contextmanager
def triggered_by(actor: Mapping[str, Any] | None, *, source: str = ""):
    """Record who this run is on behalf of, for as long as the block lasts.

    `source` is "schedule" when a service credential presented the key and
    "person" when a session did — derived from the actor rather than passed in,
    so a route cannot claim to be a schedule.
    """
    from app.core.roles import is_system

    actor = dict(actor or {})
    machine = is_system(actor.get("role"))
    token = _TRIGGER.set(
        {
            "trigger": source or ("schedule" if machine else "person"),
            "triggered_by": {
                # Never an email and never a session id — the run log is read by
                # anyone with oversight, and this is an attribution, not a
                # contact detail.
                "uid": str(actor.get("uid") or ""),
                "name": str(actor.get("name") or ""),
                "role": str(actor.get("role") or ""),
                "service_credential": actor.get("service_credential"),
            },
        }
    )
    try:
        yield
    finally:
        _TRIGGER.reset(token)


def _problems(summary: Mapping[str, Any]) -> list[str]:
    """Everything on this run that a person needs to know did not work.

    Gathered from the summary the job built rather than from exceptions, because
    the jobs in this module are deliberately partial-failure tolerant: one
    section, one sweep or one detector failing does not stop the rest, and the
    result is a run that succeeded at delivering an incomplete answer.
    """
    out: list[str] = []
    for key in ("errors", "failed_sections", "failed_sweeps", "failed_detectors"):
        for entry in summary.get(key) or []:
            out.append(f"{key}: {entry}")
    for report in summary.get("reports") or []:
        if isinstance(report, Mapping) and report.get("error"):
            out.append(f"{report.get('report', 'report')}: {report['error']}")

    # Partner statements, whether this run *is* the statement run or whether the
    # monthly pack ran it. A statement that could not be produced and one that
    # could not be delivered are both a partner who has not been told what they
    # are owed, and both belong on the run's problem list. Named by partner id
    # only — the address is already on `detail` and does not need repeating in
    # a summary line.
    for source in (summary, summary.get("statements")):
        if not isinstance(source, Mapping):
            continue
        prefix = "statements" if source is not summary else "statement"
        for entry in source.get("errors") or []:
            if source is not summary:
                out.append(f"{prefix}: {entry}")
        for entry in source.get("failed_statements") or []:
            partner = entry.get("partner_id") if isinstance(entry, Mapping) else entry
            out.append(f"{prefix}: {partner} could not be produced")
        for entry in source.get("undeliverable") or []:
            partner = entry.get("partner_id") if isinstance(entry, Mapping) else entry
            outcome = entry.get("outcome") if isinstance(entry, Mapping) else ""
            out.append(f"{prefix}: {partner} was not reachable ({outcome})")
    return out


def _verdict(summary: Mapping[str, Any]) -> tuple[str, list[str]]:
    problems = _problems(summary)
    return ("degraded" if problems else "ok"), problems


async def record_run(summary: dict) -> dict:
    """Stamp a finished run with its verdict and its trigger, and store it.

    Mutates and returns the summary the job is about to hand back, so the HTTP
    response and the stored row are the same object and cannot disagree.
    """
    from pymongo.errors import PyMongoError

    from app.db.mongo import C

    status, problems = _verdict(summary)
    summary["status"] = status
    summary["ok"] = status == "ok"
    summary["problems"] = problems
    summary.update(_TRIGGER.get() or {"trigger": "unknown", "triggered_by": {}})

    try:
        await _c(C.SCHEDULED_RUNS).insert_one(dict(summary))
        summary["recorded"] = True
    except (PyMongoError, RuntimeError) as exc:
        log.error("Could not record the scheduled run '%s': %s", summary.get("job"), exc)
        summary["recorded"] = False
        summary["record_error"] = (
            f"The job ran, and its outcome could NOT be written to the run log "
            f"({type(exc).__name__}: {exc}). Nothing on /notifications/runs will "
            "show this run. Treat the response body as the only record of it."
        )
    return summary


async def record_failure(
    job: str, *, spec: str = "", error: BaseException | str, started_at: datetime
) -> dict:
    """Write the run a job never got to write, because it raised.

    Called from the router's error path. Without it, a trigger that throws leaves
    the run log looking exactly like a trigger that was never fired — and the
    owner's answer to "did the Sunday report run?" would be a shrug.
    """
    from pymongo.errors import PyMongoError

    from app.db.mongo import C

    reason = (
        f"{type(error).__name__}: {error}"
        if isinstance(error, BaseException)
        else str(error)
    )
    summary: dict[str, Any] = {
        "job": job,
        "spec": spec,
        "started_at": started_at,
        "finished_at": _now(),
        "status": "failed",
        "ok": False,
        "emails_accepted": 0,
        "errors": [reason],
        "problems": [reason],
        "note": (
            "This job raised before it could report on itself. Nothing it would "
            "have sent was sent, and it is NOT a run that found nothing to do."
        ),
        **(_TRIGGER.get() or {"trigger": "unknown", "triggered_by": {}}),
    }
    try:
        await _c(C.SCHEDULED_RUNS).insert_one(dict(summary))
        summary["recorded"] = True
    except (PyMongoError, RuntimeError) as exc:
        log.error("Could not record the FAILED run '%s': %s", job, exc)
        summary["recorded"] = False
    return summary


#: The old private name, kept so the call sites below read unchanged.
_record_run = record_run


# ══════════════════════════════════════════════════════════════════════════════
#  Sections that reports.py has no function for
# ══════════════════════════════════════════════════════════════════════════════
#
# These are counts of records, not money. Anything with a rupee sign on it comes
# from reports.py; nothing below computes one.


async def _new_accounts(since: datetime, until: datetime) -> Section:
    """New partners in the period — 8A.3.1's "new users/hosts/partners".

    Partners are counted from the business record. **Users and hosts are not
    counted here**, and the section says so rather than reporting zero: those
    live in Firestore and there is no server-side report over them yet (10.23).
    A blank line labelled "new users" would be read as "nobody joined".
    """
    from app.db.mongo import C
    from app.services.reports import Report

    try:
        rows: list[dict] = []
        pipeline = [
            {"$match": {"created_at": {"$gte": since, "$lt": until}}},
            {"$group": {"_id": {"kind": "$kind", "status": "$status"}, "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
        ]
        total = 0
        async for row in _c(C.PARTNERS).aggregate(pipeline):
            total += int(row["n"])
            rows.append(
                {
                    "kind": row["_id"].get("kind", "unknown"),
                    "status": row["_id"].get("status", "unknown"),
                    "count": int(row["n"]),
                }
            )
    except Exception as exc:  # noqa: BLE001
        return Section(
            title="New partners",
            error=f"{type(exc).__name__}: {exc}. Partner counts were not read.",
        )

    report = Report(
        name="new_partners",
        title="New partners",
        period={
            "since": since,
            "until": until,
            "bounds": "[since, until) — start inclusive, end exclusive",
        },
        columns=[("kind", "Kind"), ("status", "Status"), ("count", "Records created")],
        rows=rows,
        totals={"partners_created": total},
        warnings=[
            "New users and new hosts are not in this figure. They are held in "
            "Firestore and no server-side report covers them yet (10.23), so "
            "they are stated as absent rather than as zero.",
        ],
    )
    report.note_if_empty(
        "No partner record was created in this period. This is an empty period, "
        "not a measured zero."
    )
    return Section(title="New partners", envelope=report.as_dict(), attachment=None)


def _exception_section(findings: Sequence[Mapping[str, Any]]) -> Section:
    """8A.3.3 — the exception list, including detectors that could not run."""
    from app.services.reports import Report

    rows = [
        {
            "spec": f.get("spec", ""),
            "watch": f.get("id", ""),
            "status": f.get("status", ""),
            "severity": f.get("severity", ""),
            "detail": f.get("headline") or f.get("reason", ""),
            "action": f.get("action", ""),
        }
        for f in findings
    ]
    unchecked = [f for f in findings if f.get("status") in {"failed", "not_applicable"}]
    live = [f for f in findings if f.get("status") == "ok"]

    report = Report(
        name="exceptions",
        title="Exceptions",
        period={"as_at": _now()},
        columns=[
            ("spec", "Spec"),
            ("watch", "Watch"),
            ("status", "Status"),
            ("severity", "Severity"),
            ("detail", "Detail"),
            ("action", "What to do"),
        ],
        rows=rows,
        totals={
            "open_exceptions": len(live),
            "checks_that_did_not_run": len(unchecked),
        },
        warnings=(
            [
                f"{len(unchecked)} check(s) did not run or do not apply here. "
                "They are listed with their reason. A check that did not run is "
                "not a check that passed."
            ]
            if unchecked
            else []
        ),
    )
    return Section(title="Exceptions", envelope=report.as_dict(), attachment=None)


# ══════════════════════════════════════════════════════════════════════════════
#  DAILY — 8A.3.1, 8A.3.2, 8A.3.3
# ══════════════════════════════════════════════════════════════════════════════


async def daily(now: datetime | None = None) -> dict:
    """Yesterday: money in, money out, what is waiting, what is stuck.

    Three separate emails to three different audiences, because 8A.3 asks for
    three and because a Finance worklist mailed to the Observer is noise that
    trains them to skip the one that matters (8A.1.4).
    """
    from app.core.roles import Role
    from app.services import reports as rpt

    started = _now()

    # ── Housekeeping before the reporting ────────────────────────────────────
    #
    # Timed suspensions end here. A suspension is enforced with `isBanned`
    # because the app has one gate — so something has to lift it, and nothing
    # did: the end date would have sat in the CRM looking like a promise while
    # the account stayed locked out for ever.
    #
    # It RESUMES rather than unbans. `users_svc.resume_user` is what ends a
    # suspension: it clears the suspension and its schedule, audits the lift as
    # `user.resumed`, and touches no device. The sweep used to unban, which
    # wrote `user.unbanned` against people who had never been banned and — far
    # worse for an unattended job — deleted `bannedDevices` records that Ops had
    # placed for their own reasons. A nightly job quietly releasing barred
    # handsets is precisely the kind of thing nobody would have noticed.
    #
    # It rides on the daily run rather than a scheduler of its own because a
    # new scheduled job is a Cloud Function, a Pub/Sub topic, a SCHEDULE entry
    # and a canary test, for work that takes milliseconds once a day. The cost
    # is precision: a suspension lifts at the next daily run after it expires,
    # not to the minute — so the CRM says "lifts on or after", and a reviewer
    # who needs it gone sooner presses Resume.
    suspensions: dict = {}
    try:
        from app.services import users as users_svc

        suspensions = await users_svc.lift_expired_suspensions(
            # `system:` is not decoration. `audit._entry` REFUSES a system actor
            # whose uid does not carry the prefix, because an unattended job
            # that reads in `/audit` as a colleague is exactly what the prefix
            # exists to prevent — and this actor said plain "system", so every
            # single lift raised ValueError inside `audit.record` and landed in
            # `failed`. The sweep has therefore never successfully ended a
            # suspension; it only looked as though it had, because the failures
            # were collected into a list rather than raised.
            {
                "uid": "system:suspension_sweep",
                "name": "Scheduled job",
                "role": "system",
            }
        )
        if suspensions.get("lifted"):
            log.info("Resumed %d expired suspensions", len(suspensions["lifted"]))
        if suspensions.get("failed"):
            log.error(
                "%d expired suspension(s) could not be resumed: %s",
                len(suspensions["failed"]),
                suspensions["failed"],
            )
    except Exception as exc:  # noqa: BLE001 — never let this stop the reports
        log.error("Expired suspensions could not be lifted: %s", exc)
        suspensions = {"error": str(exc)}

    # §5: a timed HOST-ROLE suspension ends the same way — `resume_host`, the
    # same Host record working again, audited as `host.resumed` by the machine
    # (its own `system:` uid), on or after its date. Only the role was paused,
    # so only the role is resumed; the account is not this sweep's business.
    host_suspensions: dict = {}
    try:
        from app.services import users as users_svc

        host_suspensions = await users_svc.lift_expired_host_suspensions(
            {
                "uid": "system:host_suspension_sweep",
                "name": "Scheduled job",
                "role": "system",
            }
        )
        if host_suspensions.get("lifted"):
            log.info("Resumed %d expired Host-role suspensions", len(host_suspensions["lifted"]))
        if host_suspensions.get("failed"):
            log.error(
                "%d expired Host-role suspension(s) could not be resumed: %s",
                len(host_suspensions["failed"]),
                host_suspensions["failed"],
            )
    except Exception as exc:  # noqa: BLE001 — never let this stop the reports
        log.error("Expired Host-role suspensions could not be lifted: %s", exc)
        host_suspensions = {"error": str(exc)}

    since, until = yesterday(now)
    # The business-calendar date, not `since.date()`. At UTC+05:30 the window
    # for the 28th starts at 18:30 UTC on the 27th, and a dedupe key naming the
    # 27th would let the 27th's report and the 28th's collide.
    period_key = day_key(since)
    label = _label(since, until)

    try:
        rates = await rpt.load_rates()
    except Exception as exc:  # noqa: BLE001
        log.error("Rates could not be loaded for the daily run: %s", exc)
        rates = None

    results: list[dict] = []

    # ── 8A.3.1 Business summary → owners + Observer ──────────────────────────
    summary_sections = [
        await _section("Cash position", rpt.cash_position(since, until, rates)),
        await _section("Reseller versus direct", rpt.channel_breakdown(since, until, rates)),
        await _section("Owed and receivable, right now", rpt.outstanding_liabilities(rates)),
        await _new_accounts(since, until),
        await _section(
            "Queues, ageing and anything overdue",
            rpt.dashboard(Role.OWNER, None, rates),
            attach=False,
        ),
    ]
    results.append(
        await _send_report(
            kind="report.daily_business_summary",
            spec="8A.3.1",
            report_key="daily_business_summary",
            cadence="daily",
            audiences=(OWNERS, OBSERVER),
            subject=f"Zipper daily business summary — {label}",
            title="Daily business summary",
            preheader="Cash in by channel, cash out, net position, what is waiting.",
            intro=(
                f"Yesterday, {label}, generated from the ledger. Every figure "
                "is money that actually moved, not imputed consumption (9.43)."
            ),
            sections=summary_sections,
            sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
            period_key=period_key,
        )
    )

    # ── 8A.3.2 Finance worklist → the Finance admin ──────────────────────────
    worklist_sections = [
        await _section(
            "Your worklist — awaiting verification, awaiting signature, overdue, failed",
            rpt.dashboard(Role.FINANCE_ADMIN, "finance", rates),
            attach=False,
        ),
        await _section(
            "Finance throughput, last 7 days",
            rpt.team_throughput("finance", _now() - timedelta(days=7), _now()),
        ),
    ]
    try:
        findings = await alerts.open_findings()
    except Exception as exc:  # noqa: BLE001
        findings = []
        worklist_sections.append(
            Section(
                title="Exceptions",
                error=f"The exception scan could not run: {type(exc).__name__}: {exc}.",
            )
        )
    else:
        worklist_sections.append(_exception_section(findings))

    results.append(
        await _send_report(
            kind="report.daily_finance_worklist",
            spec="8A.3.2",
            report_key="daily_finance_worklist",
            cadence="daily",
            audiences=(FINANCE,),
            subject=f"Zipper Finance worklist — {label}",
            title="Finance worklist",
            preheader="Awaiting verification, awaiting signature, overdue credit, failed executions.",
            intro=(
                "What is waiting on Finance this morning. Every line links back "
                "to a card on the money board."
            ),
            sections=worklist_sections,
            sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
            period_key=period_key,
        )
    )

    # ── 8A.3.3 Exception report → owners + Observer, only if there is one ────
    live = [f for f in findings if f.get("status") == "ok"]
    unchecked = [f for f in findings if f.get("status") == "failed"]
    if live or unchecked:
        results.append(
            await _send_report(
                kind="report.daily_exceptions",
                spec="8A.3.3",
                report_key="daily_exceptions",
                cadence="daily",
                audiences=(OWNERS, OBSERVER),
                subject=(
                    f"Zipper exceptions — {len(live)} open, "
                    f"{len(unchecked)} check(s) did not run — {label}"
                ),
                title="Exception report",
                preheader=f"{len(live)} open exception(s).",
                intro=(
                    "This email is only sent when there is something on it "
                    "(8A.3.3). Each line is a condition that is true now; each "
                    "was also alerted on individually unless it was inside its "
                    "repeat window."
                ),
                sections=[_exception_section(findings)],
                sensitivity=str(mail.Sensitivity.OPERATIONAL),
                period_key=period_key,
            )
        )
    else:
        results.append(
            {
                "report": "daily_exceptions",
                "spec": "8A.3.3",
                "sent": 0,
                "error": None,
                "note": (
                    "Not sent — every check ran and none is currently true. "
                    "8A.3.3: only sent when there is something on it."
                ),
            }
        )

    summary = {
        "job": "reports.daily",
        "started_at": started,
        "finished_at": _now(),
        "period": {"since": since, "until": until},
        "emails_accepted": sum(int(r.get("sent") or 0) for r in results),
        "reports": results,
        # Recorded on the run, so a suspension that failed to lift is visible in
        # the job history rather than only in a log line nobody reads.
        "suspensions_lifted": suspensions,
        "host_suspensions_lifted": host_suspensions,
        "errors": [r["error"] for r in results if r.get("error")],
    }
    await _record_run(summary)
    return summary


# ══════════════════════════════════════════════════════════════════════════════
#  MONTHLY — 8A.3.9, 8A.3.10, 8A.3.11, 8A.3.12
# ══════════════════════════════════════════════════════════════════════════════


async def monthly(now: datetime | None = None, *, with_statements: bool = True) -> dict:
    """Last calendar month: the P&L, the accounting pack, the audit summary,
    and every partner's formal monthly statement."""
    from app.services import reports as rpt

    started = _now()
    since, until = last_month(now)
    # Business-calendar month. `since` is 18:30 UTC on the last day of the month
    # before, so `since.strftime` would name the wrong month entirely.
    period_key = month_key(since)
    label = _local(since).strftime("%B %Y")

    try:
        rates = await rpt.load_rates()
    except Exception as exc:  # noqa: BLE001
        log.error("Rates could not be loaded for the monthly run: %s", exc)
        rates = None

    results: list[dict] = []

    # ── 8A.3.9 Profit and loss → owners + Observer ───────────────────────────
    pnl_sections = [
        await _section(
            "Profit and loss — revenue, payouts, commission, net margin",
            rpt.margin_report(since, until, rates),
        ),
        await _section("Revenue by channel", rpt.channel_breakdown(since, until, rates)),
        await _section("Revenue, month by month", rpt.revenue_summary(since, until, "month", rates)),
        await _section("Payouts — value that actually left", rpt.payout_summary(since, until, rates)),
        await _section("Outstanding liabilities at month end", rpt.outstanding_liabilities(rates)),
    ]
    results.append(
        await _send_report(
            kind="report.monthly_pnl",
            spec="8A.3.9",
            report_key="monthly_pnl",
            cadence="monthly",
            audiences=(OWNERS, OBSERVER),
            subject=f"Zipper profit and loss — {label}",
            title=f"Profit and loss — {label}",
            preheader="Revenue by channel, payouts, commission, net margin.",
            intro=(
                f"{label} in full, generated from the ledger. Reseller and "
                "direct are reported separately — different margin, different "
                "growth, different risk (9.13)."
            ),
            sections=pnl_sections,
            sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
            period_key=period_key,
        )
    )

    # ── 8A.3.11 Accounting pack → Finance + Observer ─────────────────────────
    pack_sections = [
        await _section("Cash movements", rpt.cash_position(since, until, rates)),
        await _section("Payouts", rpt.payout_summary(since, until, rates)),
        await _section("Agencies — one row each", rpt.all_partners_summary("agency", since, until, rates)),
        await _section("Sellers — one row each", rpt.all_partners_summary("seller", since, until, rates)),
        await _section("Every money action, by actor and type", rpt.audit_summary(since, until, None)),
    ]
    results.append(
        await _send_report(
            kind="report.monthly_accounting_pack",
            spec="8A.3.11",
            report_key="monthly_accounting_pack",
            cadence="monthly",
            audiences=(FINANCE, OBSERVER),
            subject=f"Zipper accounting pack — {label}",
            title=f"Accounting pack — {label}",
            preheader="Full transaction export, in a format an accountant can import.",
            intro=(
                f"The {label} pack. Every attached CSV is the same bytes the "
                "portal produces for the same report and period, so a figure "
                "here and a figure exported by hand cannot disagree."
            ),
            sections=pack_sections,
            sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
            period_key=period_key,
        )
    )

    # ── 8A.3.12 Audit summary → owners + Observer ────────────────────────────
    audit_sections = [
        await _section("Money actions by actor and by type", rpt.audit_summary(since, until, None)),
    ]
    results.append(
        await _send_report(
            kind="report.monthly_audit_summary",
            spec="8A.3.12",
            report_key="monthly_audit_summary",
            cadence="monthly",
            audiences=(OWNERS, OBSERVER),
            subject=f"Zipper audit summary — {label}",
            title=f"Audit summary — {label}",
            preheader="Every money action for the month, by actor and by type.",
            intro=(
                f"The governance review for {label}. Who did what, to what, and "
                "why — including everything an unattended job did, which is "
                "marked as machine action rather than reading as a colleague."
            ),
            sections=audit_sections,
            sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
            period_key=period_key,
        )
    )

    statements: dict[str, Any] = {"skipped": True}
    if with_statements:
        # 8A.3.10 — the formal monthly record for every agency and seller.
        statements = await partner_statements(
            since=since, until=until, cadence="monthly", spec="8A.3.10"
        )

    summary = {
        "job": "reports.monthly",
        "started_at": started,
        "finished_at": _now(),
        "period": {"since": since, "until": until},
        "emails_accepted": sum(int(r.get("sent") or 0) for r in results)
        + int(statements.get("emails_accepted") or 0),
        "reports": results,
        "statements": statements,
        "errors": [r["error"] for r in results if r.get("error")],
    }
    await _record_run(summary)
    return summary


# ══════════════════════════════════════════════════════════════════════════════
#  PARTNER STATEMENTS — 8A.3.6, 8A.3.7, 8A.3.10
# ══════════════════════════════════════════════════════════════════════════════


async def partner_statements(
    *,
    since: datetime | None = None,
    until: datetime | None = None,
    cadence: str = "monthly",
    spec: str = "8A.3.10",
    kinds: Sequence[str] = ("agency", "seller"),
    limit: int = 1000,
) -> dict:
    """Send every approved partner their own statement.

    The API can already *produce* these — `/reports/agencies/{id}/statement` and
    `/reports/sellers/{id}/statement`. Nothing scheduled or delivered them
    (10.21), which is the half this function fills. The figures are the report
    service's, unchanged: the statement a partner is emailed and the statement a
    staff member pulls over HTTP are the same object.

    Historical periods reproduce exactly, because the underlying report reads
    the ledger entries themselves rather than re-deriving from today's rates
    (9.18 / 8A.5.3).
    """
    from app.services import reports as rpt

    started = _now()
    if since is None or until is None:
        since, until = last_month()
    # Business-calendar dates on both ends, so the period key on a partner's
    # statement reads as the period they were told about.
    period_key = f"{day_key(since)}_{day_key(until - timedelta(seconds=1))}"
    label = _label(since, until)

    try:
        rates = await rpt.load_rates()
    except Exception as exc:  # noqa: BLE001
        log.error("Rates could not be loaded for the statement run: %s", exc)
        rates = None

    sent = 0
    per_partner: list[dict] = []
    errors: list[str] = []

    for kind in kinds:
        try:
            partners = await notify.approved_partners(kind, limit=limit)
        except Exception as exc:  # noqa: BLE001
            errors.append(
                f"The {kind} list could not be read ({type(exc).__name__}: {exc}), "
                f"so no {kind} statement was sent on this run."
            )
            continue

        for partner in partners:
            partner_id = str(partner.get("_id") or "")
            name = str(partner.get("name") or partner_id)
            is_seller = kind == "seller"

            section = await _section(
                f"Statement — {name}",
                (
                    rpt.seller_statement_range(partner_id, since, until, rates)
                    if is_seller
                    else rpt.agency_statement_range(partner_id, since, until, rates)
                ),
            )

            recipient = await notify.partner_recipient(partner)

            # QA #47: replies to no-reply@ are not read — say where to write.
            from app.core import contacts

            intro = (
                "Your statement for the period below, generated from the same "
                "ledger the business runs on. If a figure here does not match "
                f"your own record, write to {contacts.support_email()} with the reference "
                "and we will show you the entries behind it — you should never have to "
                "ask what you are owed."
            )

            statement_files, statement_omitted = _attachments([section])

            html = mail.page(
                title=f"Your Zipper statement — {label}",
                preheader=f"{name}: your statement for {label}.",
                body=mail.build_scheduled_report(
                    intro=intro,
                    bodies=[_render([section])],
                    attachment_note=_attachment_note(
                        [section], statement_files, statement_omitted
                    ),
                    unsubscribe_note=(
                        "This is your own account record and is not optional "
                        "mail; reply if the address is wrong"
                    ),
                ),
            )

            row = await mail.deliver(
                kind=f"statement.{kind}",
                spec=spec,
                recipient=recipient,
                subject=f"Your Zipper statement — {label}",
                html=html,
                sensitivity=mail.Sensitivity.PARTNER_OWN,
                dedupe_key=f"statement:{kind}:{partner_id}:{cadence}:{period_key}",
                meta={
                    "partner_id": partner_id,
                    "kind": kind,
                    "period": period_key,
                    "section_ok": section.ok,
                },
                attachments=statement_files,
                # A partner's own statement is transactional, not bulk: it is
                # their account record and the template says it is not optional
                # mail. It therefore carries no unsubscribe header, because it
                # would be an unsubscribe nobody would honour.
                identity=mail.SenderIdentity.TRANSACTIONAL,
            )
            if row.get("outcome") == str(mail.Outcome.SENT):
                sent += 1
            per_partner.append(
                {
                    "partner_id": partner_id,
                    "kind": kind,
                    "outcome": row.get("outcome"),
                    "statement_ok": section.ok,
                    "statement_error": section.error,
                    "to": row.get("to"),
                }
            )

    summary = {
        "job": "reports.partner_statements",
        "spec": spec,
        "cadence": cadence,
        "started_at": started,
        "finished_at": _now(),
        "period": {"since": since, "until": until},
        "partners": len(per_partner),
        "emails_accepted": sent,
        "failed_statements": [
            p for p in per_partner if not p["statement_ok"]
        ],
        "undeliverable": [
            p for p in per_partner
            if p["outcome"] in {str(mail.Outcome.NO_ADDRESS), str(mail.Outcome.FAILED)}
        ],
        "errors": errors,
        "detail": per_partner,
    }
    await _record_run(summary)
    return summary


# ══════════════════════════════════════════════════════════════════════════════
#  TRANSACTIONAL SWEEP — the triggers for 8A.2
# ══════════════════════════════════════════════════════════════════════════════
#
# The money path — `partner_ops.py`, `cards.py` — does not call `email.py`, and
# this module does not edit it. So these emails are driven by a sweep over the
# records those modules already write: the rejection reason on the partner, the
# UTR on the executed card, the due date on the seller's credit.
#
# That is not a workaround for the record's sake. Every send carries a
# `dedupe_key` derived from the event itself, and `email_deliveries.dedupe_key`
# is unique, so the sweep is idempotent however often it runs — and an email
# owed because of a decision taken while the mail provider was down still goes
# out on the next sweep instead of being lost with the request that took it.


def _sweep_window() -> datetime:
    return _now() - timedelta(days=SWEEP_WINDOW_DAYS)


async def _sweep_rejections() -> list[dict]:
    """8A.2.5 / 9.17 — rejected, with the reason, and whether they may reapply."""
    from app.db.mongo import C
    from app.services.partners import PartnerStatus

    out: list[dict] = []
    cursor = _c(C.PARTNERS).find(
        {
            "status": str(PartnerStatus.REJECTED),
            "rejected_at": {"$gte": _sweep_window()},
        }
    ).limit(500)

    async for partner in cursor:
        recipient = await notify.partner_recipient(partner)
        row = await mail.send_partner_rejected(
            recipient=recipient,
            partner_id=str(partner.get("_id")),
            kind=str(partner.get("kind") or ""),
            reason=str(partner.get("rejection_reason") or ""),
            rejected_at=partner.get("rejected_at"),
            # Nothing in the record marks a decision as final, so the honest
            # answer is the one the spec prefers: they may reapply, and the
            # email says what to fix first.
            may_reapply=True,
        )
        out.append({"partner_id": str(partner.get("_id")), "outcome": row.get("outcome")})
    return out


async def _sweep_deactivations() -> list[dict]:
    """8A.2.13 — deactivated, with the reason and what happens to the balance."""
    from app.db.mongo import C
    from app.services.money import Currency, HolderType, get_balance
    from app.services.partners import PartnerKind, PartnerStatus

    out: list[dict] = []
    cursor = _c(C.PARTNERS).find(
        {
            "status": str(PartnerStatus.SUSPENDED),
            "deactivated_at": {"$gte": _sweep_window()},
        }
    ).limit(500)

    async for partner in cursor:
        partner_id = str(partner.get("_id"))
        kind = str(partner.get("kind") or "")
        balance_minor: int | None = None
        label = "Balance held"
        if kind != str(PartnerKind.SELLER):
            # An agency's commission balance is already in paise, so it is a
            # money figure and is printed as one. A seller's balance is coins,
            # which is not money and is deliberately not rendered as rupees.
            try:
                balance_minor = await get_balance(
                    HolderType.AGENCY, partner_id, Currency.COMMISSION
                )
                label = "Commission still owed to you"
            except Exception as exc:  # noqa: BLE001
                log.warning("Balance unreadable for %s: %s", partner_id, exc)
                balance_minor = None

        row = await mail.send_account_deactivated(
            recipient=await notify.partner_recipient(partner),
            partner_id=partner_id,
            kind=kind,
            reason=str(partner.get("deactivation_reason") or ""),
            deactivated_at=partner.get("deactivated_at"),
            balance_minor=balance_minor,
            balance_label=label,
        )
        out.append({"partner_id": partner_id, "outcome": row.get("outcome")})
    return out


async def _payout_cards(stage: str, timestamp_field: str) -> list[dict]:
    from app.db.mongo import C
    from app.services.money import HolderType

    cursor = _c(C.CARDS).find(
        {
            "stage": stage,
            "currency": "commission",
            "subject.type": str(HolderType.AGENCY),
            timestamp_field: {"$gte": _sweep_window()},
        }
    ).limit(500)
    return [card async for card in cursor]


async def _partner_for(partner_id: str) -> dict | None:
    from app.db.mongo import C

    return await _c(C.PARTNERS).find_one({"_id": partner_id})


async def _sweep_payouts_approved() -> list[dict]:
    """8A.2.7 — approved: amount, period, expected date."""
    from app.services.cards import Stage

    out: list[dict] = []
    for card in await _payout_cards(str(Stage.APPROVED), "signed_at"):
        partner_id = str((card.get("subject") or {}).get("id") or "")
        partner = await _partner_for(partner_id)
        if partner is None:
            out.append({"card_id": str(card.get("_id")), "outcome": "no_partner_record"})
            continue
        signed_at = card.get("signed_at")
        row = await mail.send_payout_approved(
            recipient=await notify.partner_recipient(partner),
            card_id=str(card.get("_id")),
            partner_id=partner_id,
            amount_minor=int(card.get("amount") or 0),
            period_label=str((card.get("payload") or {}).get("period") or card.get("title") or ""),
            signed_at=signed_at,
            expected_by=(signed_at + timedelta(days=3)) if isinstance(signed_at, datetime) else None,
        )
        out.append({"card_id": str(card.get("_id")), "outcome": row.get("outcome")})
    return out


async def _sweep_payouts_paid() -> list[dict]:
    """8A.2.8 — paid: amount, UTR, date. The partner's receipt."""
    from app.services.cards import Stage
    from app.services.money import Currency, HolderType, get_balance

    out: list[dict] = []
    for card in await _payout_cards(str(Stage.EXECUTED), "executed_at"):
        partner_id = str((card.get("subject") or {}).get("id") or "")
        partner = await _partner_for(partner_id)
        if partner is None:
            out.append({"card_id": str(card.get("_id")), "outcome": "no_partner_record"})
            continue
        payload = card.get("payload") or {}
        result = card.get("execution_result") or {}
        # The bank's own reference, as the execution recorded it. Never
        # reconstructed — a receipt carrying a UTR we invented is worse than one
        # that says the UTR is being retrieved.
        utr = str(payload.get("payment_ref") or result.get("payment_ref") or "")

        try:
            outstanding = await get_balance(
                HolderType.AGENCY, partner_id, Currency.COMMISSION
            )
        except Exception:  # noqa: BLE001
            outstanding = None

        row = await mail.send_payout_paid(
            recipient=await notify.partner_recipient(partner),
            card_id=str(card.get("_id")),
            partner_id=partner_id,
            amount_minor=int(card.get("amount") or 0),
            utr=utr,
            paid_at=card.get("executed_at") or payload.get("paid_at"),
            period_label=str(payload.get("period") or ""),
            outstanding_minor=outstanding,
        )
        out.append(
            {
                "card_id": str(card.get("_id")),
                "outcome": row.get("outcome"),
                "utr_present": bool(utr),
            }
        )
    return out


async def _sweep_credit_due() -> list[dict]:
    """8A.2.10 — credit due in N days, to the seller."""
    from app.db.mongo import C
    from app.services.partners import PartnerKind

    days = int(settings.credit_due_notice_days)
    now = _now()
    cursor = _c(C.PARTNERS).find(
        {
            "kind": str(PartnerKind.SELLER),
            "credit.outstanding": {"$gt": 0},
            "credit.due_at": {"$gte": now, "$lte": now + timedelta(days=days)},
        }
    ).limit(500)

    out: list[dict] = []
    async for seller in cursor:
        credit = seller.get("credit") or {}
        due_at = credit.get("due_at")
        remaining = max(0, (due_at - now).days) if isinstance(due_at, datetime) else days
        row = await mail.send_credit_due(
            recipient=await notify.partner_recipient(seller),
            seller_id=str(seller.get("_id")),
            outstanding_coins=int(credit.get("outstanding") or 0),
            due_at=due_at,
            days=max(1, remaining),
        )
        out.append({"seller_id": str(seller.get("_id")), "outcome": row.get("outcome")})
    return out


async def _sweep_credit_overdue() -> list[dict]:
    """8A.2.11, the seller half. The Finance half is an alert (8A.4).

    `send_credit_overdue_to_seller` sets no dedupe key on purpose — an overdue
    debt is a standing condition, not an event, so cadence is enforced here with
    the same suppression state the alerts use. One email per
    CREDIT_OVERDUE_REPEAT_HOURS, not one per sweep.
    """
    from app.services import partners as partner_svc

    out: list[dict] = []
    for seller in await partner_svc.overdue_sellers(limit=500):
        seller_id = str(seller["id"])
        outstanding = int(seller.get("outstanding") or 0)
        claim = await alerts.claim(
            f"credit_overdue.seller:{seller_id}",
            alert="credit_overdue.seller",
            spec="8A.2.11",
            fingerprint=str(outstanding),
            window_hours=int(settings.credit_overdue_repeat_hours),
            meta={"seller_id": seller_id},
        )
        if not claim.fired:
            out.append({"seller_id": seller_id, "outcome": "suppressed_repeat",
                        "reason": claim.reason})
            continue

        partner = await _partner_for(seller_id)
        if partner is None:
            out.append({"seller_id": seller_id, "outcome": "no_partner_record"})
            continue

        row = await mail.send_credit_overdue_to_seller(
            recipient=await notify.partner_recipient(partner),
            seller_id=seller_id,
            outstanding_coins=outstanding,
            due_at=seller.get("due_at"),
            days_overdue=int(seller.get("days_overdue") or 0),
        )
        out.append({"seller_id": seller_id, "outcome": row.get("outcome")})
    return out


#: The sweep stops re-attempting an Owner notice after this many attempts —
#: three hours at one every fifteen minutes. The row stays `pending`, the
#: `owner_notice_failed` alert keeps naming it, and an Owner can retry it by
#: hand from the CRM once the cause (usually a missing address on the staff
#: record) is fixed. Without a cap a permanently failing address would add a
#: delivery row every fifteen minutes for ever.
OWNER_NOTICE_SWEEP_MAX_ATTEMPTS = 12


#: QA #53: how far back the appeal receipts look. An appeal is decided in days,
#: and a receipt for a long-pending one would still be true, but nothing older
#: than this is ever new.
APPEAL_RECEIPT_WINDOW_DAYS = 7


async def _sweep_appeal_receipts() -> list[dict]:
    """QA #53 / §5 — "we received your appeal", for every PENDING account appeal.

    The app (a banned or suspended account writing its own appeal) and the
    device-key path (`submitAccountAppeal`) write `appeals` without the backend,
    so nothing told the person it had arrived. This pass sends the receipt for
    each `kind: ban` appeal still pending — once: the notice is keyed on the
    appeal and `email_deliveries.dedupe_key` refuses a second email. An appeal
    already decided is skipped; its decision notice says more.
    """
    import asyncio

    from app.services import notices  # local: notices imports email, as this module does

    since = _now() - timedelta(days=APPEAL_RECEIPT_WINDOW_DAYS)
    out: list[dict] = []
    for appeal_id, appeal in await asyncio.to_thread(_appeals_since, since):
        if str(appeal.get("kind") or "") != "ban" or str(appeal.get("status") or "pending") != "pending":
            continue
        uid = str(appeal.get("subjectUid") or "").strip()
        if not uid or not _receipt_source_ok(appeal, uid):
            continue
        # Security review (3 Nov 2026): only an account that IS restricted has
        # anything to appeal — a receipt to anyone else is noise at best.
        if not await asyncio.to_thread(_is_restricted, uid):
            continue
        # The reference is the server's own (public form) or none — never the
        # document id, which a client chose.
        result = await notices.appeal_receipt(uid, appeal_id, str(appeal.get("reference") or ""), show_id=False)
        outcome = result.get("emailOutcome") or ("in_app_only" if result.get("inApp") else str(mail.Outcome.FAILED))
        out.append({"appeal_id": appeal_id, "outcome": outcome, "in_app": bool(result.get("inApp"))})
    return out


def _receipt_source_ok(appeal: Mapping[str, Any], subject_uid: str) -> bool:
    """Security review (3 Nov 2026): who wrote the appeal decides whether its
    subject is written to.

    * the account itself — `raisedByUid == subjectUid`. The app writes these
      (the rules pin `raisedByUid` to the signed-in uid) and so does the
      device-key path in the Functions;
    * the public appeal form — written by THIS server with `raisedByUid` ""
      and `raisedByRole` "public", which no client write can produce.

    Anything else — an agency contesting on someone's behalf, which the rules
    let it file for any subject — is not a receipt this person asked for, and
    sending one would let a partner mail branded "appeal received" messages to
    arbitrary users.
    """
    raised_by = str(appeal.get("raisedByUid") or "").strip()
    if raised_by:
        return raised_by == subject_uid
    return str(appeal.get("raisedByRole") or "") == "public"


def _is_restricted(uid: str) -> bool:
    """Blocking: is `users/{uid}` banned or suspended right now?"""
    from app.db import firebase

    snap = firebase.firestore_client().collection("users").document(uid).get()
    if not getattr(snap, "exists", False):
        return False
    d = snap.to_dict() or {}
    state = str(d.get("accountState") or "")
    return state in ("banned", "suspended") or bool(d.get("isBanned")) or bool(d.get("isSuspended"))


#: The most appeals one sweep reads — a flood of documents cannot make it run unbounded.
APPEAL_RECEIPT_MAX_SCAN = 5_000


def _appeals_since(since: datetime) -> list[tuple[str, dict]]:
    """Blocking: `(id, data)` of the appeals created at or after `since`, oldest
    first, a page of 500 at a time (≤ APPEAL_RECEIPT_MAX_SCAN).

    Paged, so a burst of documents cannot push genuine ones out of a single
    `limit`. One single-field range filter and the same field's order, so no
    composite index is needed. Raises when Firestore cannot be read — the sweep
    is then reported `failed`, never as "nothing owed".
    """
    from google.cloud.firestore_v1.base_query import FieldFilter

    from app.db import firebase

    out: list[tuple[str, dict]] = []
    last = None
    while len(out) < APPEAL_RECEIPT_MAX_SCAN:
        query = (
            firebase.firestore_client().collection("appeals")
            .where(filter=FieldFilter("createdAt", ">=", since))
            .order_by("createdAt")
            .limit(500)
        )
        if last is not None:
            query = query.start_after(last)
        page = list(query.stream())
        out.extend((snap.id, snap.to_dict() or {}) for snap in page)
        if len(page) < 500:
            break
        last = page[-1]
    return out


async def _sweep_owner_notices() -> list[dict]:
    """B1 / §8: re-attempt every Owner money notification still pending."""
    from app.services import owner_mail

    return await owner_mail.retry_pending(max_attempts=OWNER_NOTICE_SWEEP_MAX_ATTEMPTS)


async def _sweep_email_retries() -> list[dict]:
    """Spec §12: re-send every failed, retryable template delivery that is due.

    Each `email_deliveries` row written by `email.send_template` carries its
    recipe; `email.retry_failed` rebuilds and re-sends it in place, with the
    gaps doubling from one sweep interval up to a day and a cap on attempts
    (`EMAIL_RETRY_MAX_SWEEPS`), and updates the in-app notice's delivery state.
    Rows not yet due are reported as `not_due`, never counted as failures.
    """
    rows = await mail.retry_failed(limit=200)
    return [r for r in rows if r.get("outcome") != "not_due"]


async def _sweep_notice_retries() -> list[dict]:
    """Spec §12: write every parked in-app notice (a Firestore write that failed
    when the business action ran) through the one notice writer. Rows are
    `in_app_written` / `failed` / `gave_up` — never counted as emails sent."""
    from app.services import notices  # local: notices imports email, as this module does

    return await notices.retry_parked(limit=200)


async def _sweep_replica_repair() -> list[dict]:
    """B1 / M-1: replay CRM balance deltas that never reached Firestore.

    One row per stale balance, in the sweep's own vocabulary: `sent` when the
    replica is back in step, `failed` when it is still behind (the alert
    `replica_drift` then names it)."""
    from app.services import money

    summary = await money.repair_replica_drift(limit=200)
    return [
        {
            "holder": f"{d.get('holder_type')}/{d.get('holder_id')}/{d.get('currency')}",
            "outcome": str(mail.Outcome.SENT) if d.get("ok") else str(mail.Outcome.FAILED),
            "replayed": d.get("replayed", 0),
            "already_applied": d.get("already_applied", 0),
            "error": d.get("error"),
        }
        for d in summary.get("details", [])
    ]


SWEEPS: tuple[tuple[str, str, Callable[[], Awaitable[list[dict]]]], ...] = (
    ("rejections", "8A.2.5", _sweep_rejections),
    ("deactivations", "8A.2.13", _sweep_deactivations),
    ("payouts_approved", "8A.2.7", _sweep_payouts_approved),
    ("payouts_paid", "8A.2.8", _sweep_payouts_paid),
    ("credit_due", "8A.2.10", _sweep_credit_due),
    ("credit_overdue", "8A.2.11", _sweep_credit_overdue),
    # QA #53 — the receipt for an appeal written by the app or the device key.
    ("appeal_receipts", "§5", _sweep_appeal_receipts),
    # B1 — not email owed by a record, but the same shape of job: something
    # the record says is still owed, retried until it is not.
    ("owner_notices", "§8 owner-alone", _sweep_owner_notices),
    # §12 — every template email that failed and may be sent again.
    ("email_retries", "§12", _sweep_email_retries),
    # §12 — in-app notices whose Firestore write failed, parked for retry.
    ("notice_retries", "§12", _sweep_notice_retries),
    ("replica_drift_repair", "M-1", _sweep_replica_repair),
)


async def transactional_sweep(only: Sequence[str] | None = None) -> dict:
    """Send every transactional email that is owed and has not been sent.

    One failing sweep does not stop the others, and a sweep that could not run
    is recorded as `failed` — never as a sweep that found nothing to send.
    """
    started = _now()
    wanted = set(only or [])
    sections: list[dict] = []
    accepted = 0

    for name, spec, run in SWEEPS:
        if wanted and name not in wanted:
            continue
        try:
            rows = await run()
        except Exception as exc:  # noqa: BLE001
            log.exception("Transactional sweep '%s' failed", name)
            sections.append(
                {
                    "sweep": name,
                    "spec": spec,
                    "status": "failed",
                    "reason": (
                        f"{type(exc).__name__}: {exc}. No email was sent for this "
                        "one; it is unknown whether any was owed."
                    ),
                }
            )
            continue

        ok = sum(1 for r in rows if r.get("outcome") == str(mail.Outcome.SENT))
        accepted += ok
        sections.append(
            {
                "sweep": name,
                "spec": spec,
                "status": "ok",
                "candidates": len(rows),
                "accepted": ok,
                "already_sent": sum(
                    1 for r in rows if r.get("outcome") == str(mail.Outcome.DUPLICATE)
                ),
                "suppressed": sum(
                    1 for r in rows if r.get("outcome") == "suppressed_repeat"
                ),
                "failures": [
                    r for r in rows
                    if r.get("outcome") in {
                        str(mail.Outcome.FAILED),
                        str(mail.Outcome.NO_ADDRESS),
                        str(mail.Outcome.NOT_CONFIGURED),
                        "no_partner_record",
                    }
                ],
            }
        )

    summary = {
        "job": "email.transactional_sweep",
        "started_at": started,
        "finished_at": _now(),
        "window_days": SWEEP_WINDOW_DAYS,
        "emails_accepted": accepted,
        "failed_sweeps": [s["sweep"] for s in sections if s["status"] == "failed"],
        "sections": sections,
    }
    await _record_run(summary)
    return summary


# ══════════════════════════════════════════════════════════════════════════════
#  WEEKLY — the owner's business report
# ══════════════════════════════════════════════════════════════════════════════
#
# "every sunday i want report of all host their work their payout whether they
#  are eligible or not their respective agency sub agency or main agency and
#  their eligibility of commission gain and how much each everything. how much
#  seller credit in that week, how much user recharge everything i want. based on
#  the report we got everything highest recharged users, highest gift received
#  host, highest lucky gift played by who everything right along with financial
#  report like this much pay this much profit and all. profit is like the money
#  we received for selling coin - our all expenditure"
#
# Six sections, all of them computed by `reports.py` and none of them by this
# module. Three things make this the report and not a second opinion:
#
#   * **One window governs everything.** The ISO week label resolves through
#     `commission.resolve_period` — the same call the accrual makes — so host
#     eligibility, agency billing, recharges and the P&L all cover exactly the
#     same [Monday 00:00 UTC, next Monday 00:00 UTC). The Cloud Function used to
#     measure hosts over a rolling seven days while commission was measured over
#     the ISO week, and had to carry a paragraph explaining that the two figures
#     on the same page did not describe the same days. They now do.
#   * **It is a record.** The document is written before the email is sent and
#     is never updated. Re-reading 2026-W33 next March gives what it gave on the
#     Sunday, which is the whole reason for storing it rather than recomputing.
#   * **Regenerating doubles nothing.** The store is keyed on the week and the
#     unique `_id` index refuses a second insert; the email carries a dedupe key
#     per recipient and `email_deliveries.dedupe_key` refuses a second send. A
#     re-run after a mail outage therefore still delivers, because the send is
#     retried against the *stored* report and deduplicated at the mailbox — it
#     does not recompute, and it cannot double-send.

#: A stored section keeps at most this many rows inline. The CSV attached to the
#: email is always complete; this only bounds the Mongo document, which has a
#: hard 16 MB ceiling. A section that is trimmed says so in the stored record.
STORED_ROW_LIMIT = 3_000


def last_closed_iso_week(now: datetime | None = None) -> str:
    """The label of the most recent ISO week that has completely finished.

    The job fires on a Sunday evening, when the current ISO week (Monday to
    Sunday) has not yet closed. Reporting on it would report on a week still in
    progress and would then have to be corrected. So the report always covers
    the week *before* the one the job runs in, and each ISO week is reported
    exactly once, by the run that happens after it has closed.
    """
    now = now or _now()
    closed = now - timedelta(days=7)
    iso = closed.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _weekly_window(week_label: str) -> tuple[datetime, datetime, str]:
    """[Monday, Monday) for an ISO week label, via the commission engine.

    Deliberately not computed here. `commission.resolve_period` is what decides
    the window commission is billed over, and a second implementation of the
    same calendar arithmetic is exactly how the report and the accrual would
    come to disagree about which days a week contains.
    """
    from app.services.commission import CommissionError, resolve_period

    try:
        since, until, label = resolve_period(week_label)
    except CommissionError as exc:
        raise ValueError(
            f"'{week_label}' is not a week this server can date: {exc}"
        ) from exc
    return since, until, label


async def _stored_week(week_label: str, revision: int) -> dict | None:
    from app.db.mongo import C

    return await _c(C.WEEKLY_BUSINESS_REPORTS).find_one(
        {"_id": _week_id(week_label, revision)}
    )


def _week_id(week_label: str, revision: int) -> str:
    return week_label if revision == 0 else f"{week_label}#r{revision}"


async def _next_revision(week_label: str) -> int:
    """How many revisions of this week already exist."""
    from app.db.mongo import C

    return await _c(C.WEEKLY_BUSINESS_REPORTS).count_documents(
        {"week_label": week_label}
    )


def _stored_section(section: Section) -> dict:
    """One section, reduced to what is worth keeping forever."""
    if not section.ok:
        return {
            "title": section.title,
            "ok": False,
            "error": section.error,
            "note": (
                "This section could not be computed when the report was "
                "generated. It is stored as a failure. It is not a zero."
            ),
        }
    envelope = dict(section.envelope or {})
    rows = list(envelope.get("rows") or [])
    trimmed = len(rows) > STORED_ROW_LIMIT
    if trimmed:
        envelope["rows"] = rows[:STORED_ROW_LIMIT]
        envelope["rows_trimmed"] = {
            "kept": STORED_ROW_LIMIT,
            "total": len(rows),
            "note": (
                f"{len(rows):,} rows were produced and the first "
                f"{STORED_ROW_LIMIT:,} are stored, to stay inside the document "
                "size limit. The totals above are over ALL rows and are "
                "complete. The CSV attached to the email is also complete."
            ),
        }
    return {
        "title": section.title,
        "ok": True,
        "error": None,
        "row_count": len(rows),
        "trimmed": trimmed,
        "attachment": section.attachment.filename if section.attachment else None,
        "envelope": envelope,
    }


async def _store_week(document: Mapping[str, Any]) -> tuple[dict, bool]:
    """Write the report exactly once. Returns (document, was_already_there).

    The insert is what decides, not a read before it. Two triggers racing the
    same Sunday collide on `_id` and the second one is answered with the first
    one's report — so the numbers a person is shown are the numbers that were
    stored, whichever call got there first.
    """
    from pymongo.errors import DuplicateKeyError, PyMongoError

    from app.db.mongo import C

    doc = dict(document)
    try:
        await _c(C.WEEKLY_BUSINESS_REPORTS).insert_one(doc)
        return doc, False
    except DuplicateKeyError:
        existing = await _c(C.WEEKLY_BUSINESS_REPORTS).find_one({"_id": doc["_id"]})
        if existing is not None:
            log.info(
                "Weekly business report %s was already stored; the stored one is "
                "authoritative and nothing was overwritten.",
                doc["_id"],
            )
            return existing, True
        raise
    except (PyMongoError, RuntimeError) as exc:
        raise RuntimeError(
            f"The weekly business report for {doc.get('week_label')} was computed "
            f"but could not be stored ({exc}). It has NOT been emailed: a report "
            "that is not a record cannot be reconciled later, and sending it "
            "would create figures nobody can check."
        ) from exc


async def read_week(week_label: str) -> list[dict]:
    """Every stored revision of one week, oldest first. The record, re-read."""
    from app.db.mongo import C

    cursor = (
        _c(C.WEEKLY_BUSINESS_REPORTS)
        .find({"week_label": week_label})
        .sort("revision", 1)
    )
    return [doc async for doc in cursor]


def _needs_a_person(sections: Sequence[Section]) -> list[str]:
    """What an owner has to act on, gathered from the sections themselves.

    A failed section always qualifies. So does any warning the report shouted in
    capitals — `reports.py` uses an opening capitalised clause for exactly the
    conditions that are not routine.
    """
    out: list[str] = []
    for section in sections:
        if not section.ok:
            out.append(f"{section.title}: NOT COMPUTED — {section.error}")
            continue
        for warning in (section.envelope or {}).get("warnings") or []:
            head = str(warning).split(".")[0]
            if head and head[:4].isupper():
                out.append(f"{section.title}: {warning}")
    return out


async def weekly(
    week_label: str | None = None,
    now: datetime | None = None,
    *,
    force: bool = False,
    top_n: int = 10,
) -> dict:
    """The owner's Sunday report: hosts, agencies, money in, boards, and the P&L.

    `force` stores a new revision beside the original rather than replacing it,
    and is for a week whose sections failed and have since been fixed. It never
    edits what was already stored.
    """
    from app.services import reports as rpt

    started = _now()
    label = (week_label or last_closed_iso_week(now)).strip()
    since, until, label = _weekly_window(label)
    window_note = (
        f"{since.date().isoformat()} 00:00 UTC to {until.date().isoformat()} "
        "00:00 UTC — start inclusive, end exclusive. This is the ISO week "
        f"{label}, and it is the window every figure in this report covers, "
        "including the one commission is billed over."
    )

    revision = 0
    if force:
        revision = max(1, await _next_revision(label))

    existing = await _stored_week(label, revision)
    reused = existing is not None

    if reused:
        stored = existing
        sections: list[Section] = []
        log.info(
            "Weekly business report %s is already stored. Re-using it — the "
            "figures do not move — and re-attempting delivery, which is "
            "deduplicated per recipient.",
            _week_id(label, revision),
        )
    else:
        try:
            rates = await rpt.load_rates()
        except Exception as exc:  # noqa: BLE001
            log.error("Rates could not be loaded for the weekly run: %s", exc)
            rates = None
        try:
            thresholds = await rpt.load_thresholds()
        except Exception as exc:  # noqa: BLE001
            log.error("Thresholds could not be loaded for the weekly run: %s", exc)
            thresholds = None

        # Order is the order the email reads in: the P&L first, because it is
        # the question, then the tables that explain it.
        sections = [
            await _section(
                "Profit and loss — what we took, what we spent, what is left",
                rpt.profit_and_loss(since, until, rates),
            ),
            await _section(
                "Money in — user recharges and seller credit",
                rpt.money_in(since, until, rates),
            ),
            # 8B.7 and 8B.8. Gross gaming revenue is a revenue line of its own,
            # so it sits beside money in rather than inside it, and the margin
            # model sits beside the revenue rather than under it — the ratio is
            # what governs profitability (8B.8.5) and it is not a footnote to
            # the takings.
            await _section(
                "Gross gaming revenue — per mechanic, per country, per day",
                rpt.chance_revenue(since, until, rates),
            ),
            await _section(
                "Game margin — bean-payout ratio per mechanic",
                rpt.chance_margin(since, until, rates),
            ),
            await _section(
                "Agencies — billing, band, rate and commission",
                rpt.agency_week(label, since, until, rates),
            ),
            await _section(
                "Hosts — work, payout due, and eligibility with the reason",
                rpt.host_week(since, until, rates, thresholds),
            ),
            # 8B.9 and 8B.9A, immediately after the hosts, because it is read
            # against them: the rule is game revenue rising while host earnings
            # hold steady, and the two figures belong on the same screen.
            await _section(
                "Games against the host economy — the cannibalisation guard",
                rpt.chance_cannibalisation(since, until, rates),
            ),
            await _section(
                "Leaderboards — recharges, gifts received, lucky-gift spend",
                rpt.leaderboards(since, until, rates, top_n),
            ),
        ]

        stored = {
            "_id": _week_id(label, revision),
            "week_label": label,
            "revision": revision,
            "since": since,
            "until": until,
            "window_note": window_note,
            "generated_at": started,
            "sections": [_stored_section(s) for s in sections],
            "failed_sections": [s.title for s in sections if not s.ok],
            "needs_a_person": _needs_a_person(sections),
            "immutable": (
                "This document is written once and never updated. Re-reading "
                "this week later gives these figures, which is what makes it a "
                "record rather than a recomputation."
            ),
        }
        stored, raced = await _store_week(stored)
        if raced:
            reused = True

    # Rebuild the send from whatever is authoritative — the stored document.
    if not sections:
        sections = _sections_from_stored(stored)

    result = await _send_report(
        kind="report.weekly_business",
        spec="owner request — weekly business report",
        report_key="weekly_business",
        cadence="weekly",
        audiences=(OWNERS, OBSERVER),
        subject=_weekly_subject(label, stored),
        title=f"Zipper weekly business report — {label}",
        preheader=(
            "Profit and loss, hosts and their eligibility, agency commission, "
            "recharges and seller credit, gross gaming revenue and whether the "
            "games are feeding the host economy or eating it."
        ),
        intro=(
            f"The week {label} — {window_note} Every figure comes from the "
            "ledger, the card board and the app's own records, and every one of "
            "them says which. Where something could not be computed it is shown "
            "as a failure; where the business does not record something at all "
            "it is shown as unknown. Nothing on this page is a zero standing in "
            "for a missing number."
        ),
        sections=sections,
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        period_key=str(stored.get("_id") or label),
    )

    summary = {
        "job": "reports.weekly",
        "started_at": started,
        "finished_at": _now(),
        "week_label": label,
        "revision": revision,
        "report_id": stored.get("_id"),
        "period": {"since": since, "until": until},
        "stored": True,
        "regenerated": not reused,
        "reused_stored_report": reused,
        "failed_sections": list(stored.get("failed_sections") or []),
        "needs_a_person": list(stored.get("needs_a_person") or []),
        "emails_accepted": int(result.get("sent") or 0),
        "reports": [result],
        "errors": [result["error"]] if result.get("error") else [],
    }
    await _record_run(summary)
    return summary


def _sections_from_stored(stored: Mapping[str, Any]) -> list[Section]:
    """Turn a stored report back into sections, so a re-send is the same email.

    A re-send after a mail outage must deliver what was stored, not a fresh
    computation — otherwise the email and the record would disagree about the
    same week.
    """
    out: list[Section] = []
    for entry in stored.get("sections") or []:
        if not entry.get("ok"):
            out.append(Section(title=entry.get("title", ""), error=entry.get("error")))
            continue
        envelope = dict(entry.get("envelope") or {})
        attachment = None
        try:
            from app.services.reports import to_csv

            csv_text = to_csv(
                envelope.get("rows") or [],
                [
                    (c.get("key", ""), c.get("header", ""))
                    for c in envelope.get("columns") or []
                ],
            )
            name = entry.get("attachment") or f"{envelope.get('report', 'report')}.csv"
            attachment = mail.Attachment(filename=name, data=csv_text.encode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — the body still goes out
            log.warning("Stored CSV for '%s' could not be rebuilt: %s", entry.get("title"), exc)
        out.append(
            Section(title=entry.get("title", ""), envelope=envelope, attachment=attachment)
        )
    return out


def _weekly_subject(label: str, stored: Mapping[str, Any]) -> str:
    """The subject line says what happened before anyone opens the mail.

    Sentence case, deliberately. This line used to end "COULD NOT BE COMPUTED",
    which says exactly the same thing and is scored as shouting by every content
    filter there is — on the one email of the week that most needs to be read.
    `mail.subject_problems()` is asserted over the whole catalogue in the tests.
    """
    failed = list(stored.get("failed_sections") or [])
    needs = list(stored.get("needs_a_person") or [])
    if failed:
        return (
            f"Zipper weekly business report — {label} — "
            f"{len(failed)} section(s) could not be computed"
        )

    profit = None
    for entry in stored.get("sections") or []:
        totals = ((entry.get("envelope") or {}).get("totals")) or {}
        if "profit_inr_minor" in totals:
            profit = totals
            break
    if profit is not None:
        bound = "" if profit.get("complete") else " (upper bound)"
        head = f"profit {mail.money(int(profit['profit_inr_minor']))}{bound}"
    else:
        head = "profit not computed"

    if needs:
        return f"Zipper weekly business report — {label} — {head} — {len(needs)} to look at"
    return f"Zipper weekly business report — {label} — {head}"


# ══════════════════════════════════════════════════════════════════════════════
#  What is scheduled, what fires it, and when
# ══════════════════════════════════════════════════════════════════════════════
#
# These are not suggestions any more. Each entry names the Cloud Function that
# fires it (`functions/src/index.ts`), and the cron is the one that function is
# deployed with — so `GET /api/notifications/schedule` and the deployed schedule
# are read from the same table, and a drift between them is a diff rather than a
# discovery.
#
# **The clock is Asia/Kolkata, stated on every row.** Cron in a scheduler that
# thinks in UTC is how a "daily 08:00" report arrives at 13:30 and covers a day
# that ended at breakfast. Both the firing time *and* the period the job covers
# are the reader's local ones — see `business_tz()` above for the second half of
# that.
#
# `run_job` is the value the job writes into `scheduled_runs.job`. It differs
# from `job` because one trigger can produce more than one run row (the monthly
# pack also runs the partner statements), and the run log is keyed on what
# actually ran.

SCHEDULE_TIMEZONE = "Asia/Kolkata"

SCHEDULE: tuple[dict, ...] = (
    {
        "job": "transactional-sweep",
        "run_job": "email.transactional_sweep",
        "spec": "8A.2.5 / 8A.2.7 / 8A.2.8 / 8A.2.10 / 8A.2.11 / 8A.2.13",
        "endpoint": "POST /api/notifications/jobs/transactional-sweep",
        "function": "scheduledTransactionalSweep",
        "cron": "*/15 * * * *",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "Every 15 minutes, all day.",
        "covers": "Every transactional email owed by a record and not yet sent. "
                  "Frequent on purpose: a partner learning they were rejected "
                  "should not wait for a nightly batch.",
    },
    {
        "job": "alerts",
        "run_job": "alerts.scan",
        "spec": "8A.4.1 – 8A.4.9, 8A.2.11, 8A.2.15",
        "endpoint": "POST /api/notifications/jobs/alerts",
        "function": "scheduledAlertScan",
        "cron": "*/30 * * * *",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "Every 30 minutes, all day.",
        "covers": "Every exception condition. Repeats are suppressed by "
                  "`alert_state`, so a frequent schedule does not produce "
                  "frequent email — one per condition per repeat window.",
    },
    {
        # Registered late. `scheduledReconciliation` has been deployed and
        # running nightly, and both its trigger routes accept the reporting
        # credential — but it was never added to this table, so it appeared in
        # none of the places this table feeds: not on the jobs board, not in
        # `last_runs()`, and not in the "this job has never run" detection.
        #
        # That last one is the reason it matters. The whole point of the
        # overview is to notice a job that has stopped, and a job the overview
        # does not know about cannot be noticed. A nightly comparison of the
        # app's Firestore economy against the Mongo ledger could have failed
        # every night for a month in silence.
        #
        # Two canary tests caught it, each from a different direction — the
        # count of `.timeZone(BUSINESS_TIMEZONE)` in index.ts against the length
        # of this tuple, and the list of routes accepting a service credential.
        # Both were doing exactly what they are for.
        "job": "reconcile",
        "run_job": "economy.reconcile",
        "spec": "8A.8 — app economy vs ledger",
        "endpoint": "POST /api/notifications/jobs/reconcile",
        "function": "scheduledReconciliation",
        "cron": "0 3 * * *",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "03:00 IST, every day.",
        "covers": "Yesterday's diamond and bean movement in Firestore against "
                  "the Mongo ledger. Runs before the 07:00 reports so a "
                  "divergence is known by the time anyone reads the numbers "
                  "built on it.",
    },
    {
        "job": "daily",
        "run_job": "reports.daily",
        "spec": "8A.3.1 / 8A.3.2 / 8A.3.3",
        "endpoint": "POST /api/notifications/jobs/daily",
        "function": "scheduledDailyReports",
        "cron": "0 7 * * *",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "07:00 IST, every day.",
        "covers": "Yesterday — the whole of it, 00:00 to 24:00 IST, finished "
                  "seven hours before the email lands. Business summary, "
                  "Finance worklist, exception report.",
    },
    {
        "job": "weekly-business",
        "run_job": "reports.weekly",
        "spec": "owner request — the weekly business report",
        "endpoint": "POST /api/reports/jobs/weekly-business",
        "function": "scheduledWeeklyBusinessReport",
        "cron": "30 7 * * 1",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "07:30 IST, Monday.",
        "covers": "The ISO week that closed at 05:30 IST this morning "
                  "(00:00 UTC). Hosts and eligibility, agency commission, "
                  "recharges, seller credit, gross gaming revenue, the game "
                  "margin model, the cannibalisation guard, leaderboards, "
                  "P&L. Monday rather "
                  "than Sunday evening because the week has to have finished "
                  "before it can be reported on — a Sunday-evening run would "
                  "report the week before last.",
    },
    {
        "job": "partner-statements",
        "run_job": "reports.partner_statements",
        "spec": "8A.3.6 / 8A.3.7",
        "endpoint": "POST /api/notifications/jobs/partner-statements"
                    "?cadence=weekly&period=last-week",
        "function": "scheduledPartnerStatements",
        "cron": "0 9 * * 1",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "09:00 IST, Monday.",
        "covers": "Every approved agency and seller, for the ISO week that "
                  "closed. Ninety minutes after the business report so the "
                  "owners see the week before the partners are told about it.",
    },
    {
        "job": "monthly",
        "run_job": "reports.monthly",
        "spec": "8A.3.9 / 8A.3.10 / 8A.3.11 / 8A.3.12",
        "endpoint": "POST /api/notifications/jobs/monthly",
        "function": "scheduledMonthlyReports",
        "cron": "0 8 1 * *",
        "timezone": SCHEDULE_TIMEZONE,
        "when": "08:00 IST, the 1st of the month.",
        "covers": "Last calendar month, cut at midnight IST. P&L, accounting "
                  "pack, audit summary, and every partner's formal monthly "
                  "statement (which records its own run under "
                  "reports.partner_statements).",
    },
)

SCHEDULE_BY_JOB: dict[str, dict] = {entry["job"]: entry for entry in SCHEDULE}


async def recent_runs(limit: int = 50, job: str | None = None) -> list[dict]:
    from app.db.mongo import C

    query = {"job": job} if job else {}
    cursor = (
        _c(C.SCHEDULED_RUNS)
        .find(query)
        .sort("started_at", -1)
        .limit(max(1, min(limit, 200)))
    )
    out = []
    async for doc in cursor:
        doc.pop("_id", None)
        out.append(doc)
    return out


async def _latest_run(run_job: str) -> dict | None:
    from app.db.mongo import C

    cursor = _c(C.SCHEDULED_RUNS).find({"job": run_job}).sort("started_at", -1).limit(1)
    async for doc in cursor:
        doc.pop("_id", None)
        return doc
    return None


#: How long after a job's own cadence its silence stops being normal. Generous —
#: this is "nobody has heard from it", not a missed tick.
_OVERDUE_AFTER_HOURS: dict[str, int] = {
    "transactional-sweep": 2,
    "alerts": 3,
    "daily": 30,
    "weekly-business": 8 * 24,
    "partner-statements": 8 * 24,
    "monthly": 33 * 24,
}


async def last_runs() -> list[dict]:
    """Every scheduled job: when it last ran, and whether it worked.

    The answer to the only question an owner actually asks about a scheduler.
    A job that has *never* run is reported as `never`, which is deliberately not
    the same as a job that ran and found nothing — the first is a deployment
    that was not finished, the second is a quiet Tuesday.
    """
    now = _now()
    out: list[dict] = []
    for entry in SCHEDULE:
        row: dict[str, Any] = {
            "job": entry["job"],
            "spec": entry["spec"],
            "endpoint": entry["endpoint"],
            "function": entry["function"],
            "cron": entry["cron"],
            "timezone": entry["timezone"],
            "when": entry["when"],
            "covers": entry["covers"],
        }
        try:
            latest = await _latest_run(entry["run_job"])
        except Exception as exc:  # noqa: BLE001
            row.update(
                status="unknown",
                last_run_at=None,
                detail=(
                    f"The run log could not be read ({type(exc).__name__}: {exc}). "
                    "This says nothing about whether the job ran."
                ),
            )
            out.append(row)
            continue

        if latest is None:
            row.update(
                status="never",
                last_run_at=None,
                detail=(
                    "This job has never run. That is a deployment that is not "
                    "finished, not a period with nothing in it — check that "
                    f"the Cloud Function {entry['function']} is deployed and "
                    "holds ZIPPER_REPORTING_KEY (DEPLOYMENT.md § 9)."
                ),
            )
            out.append(row)
            continue

        started = latest.get("started_at")
        age_hours = _age_hours(started)
        overdue_after = _OVERDUE_AFTER_HOURS.get(entry["job"], 48)
        # A run older than the job's own cadence allows means the schedule has
        # stopped, whatever the last run said about itself.
        stalled = age_hours is not None and age_hours > overdue_after

        row.update(
            status=str(latest.get("status") or "unknown"),
            ok=bool(latest.get("ok")),
            last_run_at=started,
            finished_at=latest.get("finished_at"),
            age_hours=age_hours,
            trigger=latest.get("trigger"),
            triggered_by=latest.get("triggered_by"),
            emails_accepted=latest.get("emails_accepted"),
            problems=list(latest.get("problems") or latest.get("errors") or []),
            recorded=latest.get("recorded", True),
            stalled=stalled,
            detail=(
                f"Last ran {age_hours} hours ago, which is past the "
                f"{overdue_after}h this job should never be silent for. The "
                "schedule has stopped firing it."
                if stalled
                else ""
            ),
        )
        out.append(row)

    now_local = _local(now)
    for row in out:
        row["as_at"] = now_local.isoformat()
    return out


def _age_hours(at: datetime | None) -> float | None:
    if not isinstance(at, datetime):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return round((_now() - at).total_seconds() / 3600, 1)
