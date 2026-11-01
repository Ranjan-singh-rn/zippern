"""Outbound email: the transport, the delivery record, and the wording.

Spec Part 8A.2. Three things live here and nothing else does — who is allowed to
receive what is `notify.py`, when something is sent is `scheduling.py` and
`alerts.py`, and what the figures are is `reports.py`. No figure is computed in
this module.

**What is actually guaranteed**, because the previous docstring in this file
claimed a delivery record and bounce handling that did not exist:

  * Every send through `deliver()` writes a row to `email_deliveries` **before**
    the provider is called, carrying what was sent, to whom, when, and with what
    outcome (8A.2.14). If that row cannot be written, the mail is **not sent** —
    an unrecorded send is not a control, and several of these emails are the
    audit trail an agency relies on.
  * Every terminal outcome is recorded, including failure: an HTTP 403 from an
    unverified `MAIL_FROM`, a timeout, a transport exception, an address that
    does not exist on the record, and a recipient whose role may not read the
    figure. `recent_failures()` and `GET /api/reports/deliveries/failures` make
    them visible (8A.2.15).
  * Bounces, drops, deferrals and spam reports are ingested from the SendGrid
    Event Webhook by `record_provider_events()` and update the delivery row that
    produced them, matched on the provider's message id (8A.7.5).
  * `dedupe_key` is unique in the database. Two workers racing the same event,
    or Cloud Scheduler retrying a trigger that already ran, collide on the
    insert and the second one does not send.
  * **A provider rejection keeps the provider's own words.** `str()` on a
    `python_http_client.BadRequestsError` is the constant string "HTTP Error
    400: Bad Request" and the entire explanation — including the exact field
    that is wrong — is on `.body`. `_from_exception` records the body verbatim
    on `provider_error_body`, the named fields on `provider_error_fields`, and
    puts the body inside `error` as well, which is what `/tech/email` shows in
    its Cause column. A reason that arrived over the network is never discarded
    one frame below where it was needed. That mistake cost this system every
    report email it tried to send for as long as it tried to send them.
  * **An attachment that cannot be sent is left off and named**, never allowed
    to take the email down with it (`prepare_attachments`). A report that
    arrives without one CSV is far better than a report that does not arrive,
    and the body says which file is missing and why.
  * **Nothing goes out HTML-only.** Every message carries a plain-text
    alternative derived from the same HTML, so the two cannot disagree.
  * **Bulk and scheduled mail carries `List-Unsubscribe`**, plus
    `List-Unsubscribe-Post` when — and only when — a one-click endpoint is
    configured to answer it. Transactional mail carries neither, because an
    unsubscribe nobody would honour is worse than none.

**What is not guaranteed, stated plainly.** Two legacy sends — the staff
invitation and the observer sign-in code — are called synchronously from files
this module does not own and cannot be made to await. They use a blocking
recorder (`_record_blocking`) which writes through pymongo rather than motor.
They are recorded to the same standard, but they hold the event loop for the
duration of the provider call. That was already true before this module existed;
it is named here rather than hidden.

Units: every money figure crossing this module is an **integer in INR minor
units (paise)** and is rendered by `money()`, which always prints the currency.
"""

from __future__ import annotations

import base64
import html as _html
import json
import logging
import random
import re
import time
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from app.config import settings
from app.core import roles as R
from app.core.compat import StrEnum
from app.core.roles import Role
from app.services.commission import rupee_text

log = logging.getLogger(__name__)

# The SendGrid SDK's HTTP layer (python-http-client) logs every request at DEBUG:
# the whole body — a sign-in code, a set-password link — and the headers, which
# carry `Authorization: Bearer <key>`. Production runs at INFO, so none of that is
# written today; pinning the library at WARNING keeps it that way even if the
# root level is ever lowered.
logging.getLogger("python_http_client").setLevel(logging.WARNING)

PROVIDER = "sendgrid"


# ══════════════════════════════════════════════════════════════════════════════
#  Vocabulary
# ══════════════════════════════════════════════════════════════════════════════


class Outcome(StrEnum):
    """How a send ended. Every one of these is a row in `email_deliveries`."""

    QUEUED = "queued"                # recorded, provider not yet answered
    SENT = "sent"                    # the provider accepted it
    DELIVERED = "delivered"          # the provider confirmed the mailbox took it
    FAILED = "failed"                # the provider refused, timed out, or threw
    BOUNCED = "bounced"              # the mailbox rejected it after acceptance
    DROPPED = "dropped"              # the provider suppressed it (prior bounce…)
    DEFERRED = "deferred"            # temporarily refused, provider retrying
    SPAM = "spam_report"             # marked as spam by the recipient
    UNSUBSCRIBED = "unsubscribed"    # the recipient opted out at the provider
    NO_ADDRESS = "no_address"        # nothing to send to — a gap in the record
    NOT_CONFIGURED = "not_configured"  # no SENDGRID_API_KEY in this environment
    WITHHELD_ROLE = "withheld_role"  # this role may not read this figure
    UNSUBSCRIBED_LOCAL = "unsubscribed_local"  # turned off in subscriptions
    SUPPRESSED_REPEAT = "suppressed_repeat"    # same condition, inside the window
    DUPLICATE = "duplicate"          # this exact event was already sent


#: Outcomes an operator needs to look at. Everything here surfaces on
#: `GET /api/reports/deliveries/failures` and in the daily exception report.
FAILURE_OUTCOMES: frozenset[str] = frozenset(
    {
        str(Outcome.FAILED),
        str(Outcome.BOUNCED),
        str(Outcome.DROPPED),
        str(Outcome.SPAM),
        str(Outcome.NO_ADDRESS),
        str(Outcome.NOT_CONFIGURED),
        # A send stuck in `queued` means the process died between recording and
        # the provider answering. That is a failure, not a pending item.
        str(Outcome.QUEUED),
    }
)

#: The provider has the message and is still trying. Not a success and not yet
#: a failure — but never silent: it is counted separately by
#: `delivery_summary()` so a mailbox that is soft-refusing everything shows up
#: as a rising number rather than as mail nobody can account for. A deferral
#: that never resolves ends as a bounce or a drop, both of which are failures.
TRANSIENT_OUTCOMES: frozenset[str] = frozenset({str(Outcome.DEFERRED)})

#: Outcomes that mean "we deliberately did not send". Not failures — decisions.
WITHHELD_OUTCOMES: frozenset[str] = frozenset(
    {
        str(Outcome.WITHHELD_ROLE),
        str(Outcome.UNSUBSCRIBED_LOCAL),
        str(Outcome.UNSUBSCRIBED),
        str(Outcome.SUPPRESSED_REPEAT),
        str(Outcome.DUPLICATE),
    }
)


class Sensitivity(StrEnum):
    """What class of information the mail carries. Enforced in `deliver()`.

    This is the gate that keeps a business-wide money figure away from a role
    that cannot read one. It is checked at the moment of sending, not when the
    recipient list is built, so a bug in a recipient list cannot leak a figure.
    """

    #: Queue depth, ageing, an operational alert. Any internal role.
    OPERATIONAL = "operational"
    #: The whole business's money — revenue, payouts, margin, liabilities.
    #: Owners, the Observer and team admins, mirroring the rule the reports
    #: router applies to the same figures (`_require_business_financials`).
    BUSINESS_MONEY = "business_money"
    #: One partner's own money. Theirs by right (0.2.2), and readable by anyone
    #: who may read the whole business anyway.
    PARTNER_OWN = "partner_own"
    #: A credential — an invitation link, a one-time code. Addressee only.
    CREDENTIAL = "credential"
    #: A message a person composed for an audience — an announcement, a notice,
    #: a marketing mail. **It carries no figure at all, and that is what makes
    #: it sendable to anybody**, including an app user who has no role on record
    #: and could therefore never be told anything else by this module.
    #:
    #: The gate below cannot inspect a body, so this class is a *declaration*
    #: rather than a check, and it is the only one that is. That is exactly why
    #: authority for a composed send is not `require_internal`: see
    #: `services/broadcast.py::authority_for`, where the right to declare it is
    #: narrowed by how many people the declaration reaches.
    ANNOUNCEMENT = "announcement"


@dataclass(slots=True)
class Recipient:
    """One addressee, and enough about them to decide what they may receive."""

    email: str
    name: str = ""
    role: str | None = None       # a `Role` value, or None for an outside address
    uid: str | None = None
    #: Set when an owner deliberately subscribed an outside address to a
    #: business-money report (8A.3.14). Carries that owner's uid, so the
    #: decision is attributable.
    authorised_by: str | None = None

    def as_dict(self) -> dict:
        return {
            "email": self.email,
            "name": self.name,
            "role": self.role,
            "uid": self.uid,
            "authorised_by": self.authorised_by,
        }


#: A bare MIME type — `type/subtype`, no parameters. Anything else is refused
#: by SendGrid, see `Attachment.provider_type()`.
_MIME = re.compile(r"^[a-z0-9][a-z0-9!#$&^_+-]{0,60}/[a-z0-9][a-z0-9!#$&^_.+-]{0,80}$")

#: Characters that may not appear in a filename crossing the API. `;` and CR/LF
#: are the ones SendGrid names; the path separators and the control range are
#: ours, because a filename is written to a recipient's disk.
_FILENAME_BANNED = re.compile(r"[;\r\n\t\x00-\x1f\x7f/\\]")

#: The longest filename that survives every mail client intact.
MAX_FILENAME_CHARS = 180


@dataclass(slots=True)
class Attachment:
    """A file to hang off the mail. `data` is the exact bytes.

    Report CSVs are produced by `Report.csv()` — the same call `/reports?
    format=csv` makes — so an emailed table and an exported table are the same
    bytes, not two renderings that could drift (8A.6.3).

    **`content_type` carries no parameters, and this is the bug that made every
    report email fail.** It used to default to `"text/csv; charset=utf-8"`,
    which is a correct Content-Type header and an invalid value for SendGrid's
    `attachments[].type` field. SendGrid answers the whole request with

        HTTP 400
        {"errors":[{"message":"The attachment type cannot contain ';', or CRLF
         characters.","field":"attachments.0.type", …}]}

    — so the message was rejected entire, body and all, every single time. That
    is why the three reports carrying CSVs failed on every run while the two
    that carry none went out from the same sender to the same recipients.
    `provider_type()` now strips parameters on the way to the API whatever a
    caller sets, so this cannot come back by someone writing a charset again.
    """

    filename: str
    data: bytes
    #: A bare MIME type. A charset belongs on the MIME part SendGrid builds, not
    #: in this field — see the class docstring.
    content_type: str = "text/csv"

    def summary(self) -> dict:
        return {
            "filename": self.filename,
            "content_type": self.content_type,
            "bytes": len(self.data),
        }

    # ── What actually crosses the wire ────────────────────────────────────────

    def provider_type(self) -> str:
        """The value for SendGrid's `attachments[].type`, guaranteed acceptable.

        Parameters are dropped, case is normalised, and anything that is still
        not a bare `type/subtype` becomes `application/octet-stream` — a
        pessimistic type that always sends beats a precise one that 400s.
        """
        # A MIME type contains no whitespace, so the first token is the whole of
        # it: this drops `; charset=utf-8`, and also anything smuggled in after
        # a CR or LF, which is the other thing SendGrid names in that 400.
        base = re.split(r"[;\s]", str(self.content_type or ""), maxsplit=1)[0]
        base = base.strip().lower()
        return base if _MIME.match(base) else "application/octet-stream"

    def safe_filename(self) -> str:
        """The filename with everything the API refuses taken out of it."""
        name = _FILENAME_BANNED.sub("-", str(self.filename or "")).strip().strip(".")
        if len(name) <= MAX_FILENAME_CHARS:
            return name
        stem, dot, ext = name.rpartition(".")
        if dot and len(ext) <= 12:
            return stem[: MAX_FILENAME_CHARS - len(ext) - 1] + "." + ext
        return name[:MAX_FILENAME_CHARS]

    def unsendable(self) -> str | None:
        """Why this file cannot be attached, in words, or None if it can.

        Called **before** the message is built. An attachment that would make
        the provider reject the message is left off and named in the body,
        because a report that arrives without one CSV is far better than a
        report that does not arrive.
        """
        if not self.safe_filename():
            return (
                f"its filename ({self.filename!r}) is empty once the characters "
                "an email API refuses — ';', CR, LF, tabs and path separators — "
                "are removed, and a file with no name cannot be attached"
            )
        size = len(self.data)
        if size == 0:
            return (
                "it is 0 bytes. An empty attachment is rejected by the provider "
                "and tells a reader nothing; the section it belongs to says in "
                "the body whether the period was empty or the report failed"
            )
        if not self.data.strip():
            return (
                f"it is {size} byte(s) of whitespace and nothing else — a CSV "
                "with neither a header nor a row. It would open blank, which "
                "reads as 'no data' when the truth is 'no columns were defined'"
            )
        limit = int(settings.email_max_attachment_bytes)
        if size > limit:
            return (
                f"it is {size:,} bytes, over the {limit:,}-byte per-file limit. "
                "Run the same report from the portal with ?format=csv for the "
                "whole table"
            )
        return None


def _dedupe_filename(name: str, taken: set[str]) -> str:
    """`x.csv`, then `x_2.csv`, then `x_3.csv`. Deterministic, order-stable.

    Two sections of one email can legitimately share a report name and a period
    — `Report.filename()` is `{name}_{period_slug}.csv` and nothing stops two
    sections producing the same one. Two attachments with the same filename in
    one message is not something a recipient can untangle, so the second is
    renamed rather than shadowing the first or being dropped.
    """
    if name.casefold() not in taken:
        taken.add(name.casefold())
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(2, 1000):
        candidate = f"{stem}_{n}{'.' + ext if ext else ''}"
        if candidate.casefold() not in taken:
            taken.add(candidate.casefold())
            return candidate
    raise ValueError(f"'{name}' could not be made unique after 998 attempts.")


def prepare_attachments(
    attachments: Sequence[Attachment],
) -> tuple[list[Attachment], list[dict]]:
    """Everything that can be sent, and a named reason for everything that cannot.

    Returns `(sendable, omitted)`. `omitted` entries are
    `{"filename", "bytes", "reason"}` and are meant to be read by a person: they
    go into the email's own attachment note and onto the delivery record, so an
    absent CSV is a stated omission rather than a file somebody notices is
    missing three weeks later.

    Four things happen here and nothing else does:

      1. an attachment that cannot be sent is left out, with its reason;
      2. duplicate filenames are resolved deterministically;
      3. the running total is capped, so one enormous section cannot take the
         whole email down with it — the sections that fit still arrive;
      4. filenames are sanitised.

    This never raises. A failure to attach is not a failure to deliver.
    """
    sendable: list[Attachment] = []
    omitted: list[dict] = []
    taken: set[str] = set()
    total = 0
    ceiling = int(settings.email_max_total_attachment_bytes)

    for attachment in attachments:
        reason = attachment.unsendable()
        if reason is None and total + len(attachment.data) > ceiling:
            reason = (
                f"the message already carries {total:,} bytes of attachments and "
                f"adding {len(attachment.data):,} more would pass the "
                f"{ceiling:,}-byte message limit. The earlier files were kept "
                "and this one was left off, so the email still arrives"
            )
        if reason is not None:
            omitted.append(
                {
                    "filename": attachment.filename,
                    "bytes": len(attachment.data),
                    "reason": reason,
                }
            )
            log.warning(
                "Attachment '%s' (%d bytes) omitted: %s",
                attachment.filename, len(attachment.data), reason,
            )
            continue

        name = _dedupe_filename(attachment.safe_filename(), taken)
        total += len(attachment.data)
        sendable.append(
            Attachment(
                filename=name,
                data=attachment.data,
                content_type=attachment.content_type,
            )
        )

    return sendable, omitted


def omission_sentence(omitted: Sequence[Mapping[str, Any]]) -> str:
    """The omissions, as a sentence for the body of the email. 8A.6.5 in spirit.

    Names every file and its reason. A reader must never have to work out that
    something is missing — and must never read a missing CSV as an empty one.
    """
    if not omitted:
        return ""
    parts = [
        f"{entry.get('filename') or 'an unnamed file'} — {entry.get('reason') or 'no reason recorded'}"
        for entry in omitted
    ]
    lead = (
        "1 file could not be attached and was left off"
        if len(parts) == 1
        else f"{len(parts)} files could not be attached and were left off"
    )
    return (
        f"{lead}: {'; '.join(parts)}. The email was sent without them rather "
        "than not sent at all. Nothing in the figures above depends on the "
        "missing file — run the same report from the portal with ?format=csv "
        "for the whole table."
    )


def omission_html(omitted: Sequence[Mapping[str, Any]]) -> str:
    """The same sentence, as a warning block for an email body."""
    sentence = omission_sentence(omitted)
    if not sentence:
        return ""
    return (
        '<p style="color:#92400e;font-size:12px;margin:18px 0 0;line-height:1.6">'
        f"⚠ {esc(sentence)}</p>"
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Templates — 8A.7.2, Marketing owns the wording
# ══════════════════════════════════════════════════════════════════════════════

TEMPLATE_DIR = Path(__file__).resolve().parents[1] / "templates"

_TRIPLE = re.compile(r"\{\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}\}")
_DOUBLE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

_cache: dict[str, str] = {}


class TemplateError(Exception):
    """A template asked for something the caller did not supply.

    Raised rather than substituting a blank, because "Your payout of  has been
    paid" is worse than a recorded failure somebody investigates.
    """


def _template(name: str) -> str:
    if settings.is_production and name in _cache:
        return _cache[name]
    path = (TEMPLATE_DIR / f"{name}.html").resolve()
    if TEMPLATE_DIR.resolve() not in path.parents:
        raise TemplateError(f"'{name}' is not a template in {TEMPLATE_DIR}.")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise TemplateError(f"Template '{name}' could not be read: {exc}") from exc
    _cache[name] = text
    return text


def esc(value: Any) -> str:
    """Anything a person typed, made safe to put in HTML.

    A rejection reason is free text written by a reviewer. It reaches an
    applicant's mailbox, so it is escaped once, here, on the way in.
    """
    return _html.escape("" if value is None else str(value), quote=True)


def render(template: str, /, **values: Any) -> str:
    """Fill one template. `{{ x }}` escapes; `{{{ x }}}` inserts raw HTML.

    The template name is **positional-only**. Several templates have a field
    called `name` — a partner's name — and with a keyword parameter every one of
    `render("partner_rejected", name=...)`, `partner_approved`, `payout_paid`,
    `credit_due` and `account_deactivated` raised `TypeError: got multiple
    values for argument 'name'` at the moment of sending. The `/` makes the
    template's own field namespace complete: any word can be a field, including
    `template`.
    """
    text = _template(template)

    missing: list[str] = []

    def triple(match: re.Match) -> str:
        key = match.group(1)
        if key not in values:
            missing.append(key)
            return ""
        return str(values[key])

    def double(match: re.Match) -> str:
        key = match.group(1)
        if key not in values:
            missing.append(key)
            return ""
        return esc(values[key])

    out = _DOUBLE.sub(double, _TRIPLE.sub(triple, text))
    if missing:
        raise TemplateError(
            f"Template '{template}' needs {sorted(set(missing))}, which the caller "
            "did not supply. The mail was not built, so nothing was sent with a "
            "blank where a figure should be."
        )
    return out


def page(*, title: str, preheader: str, body: str, footer: str = "") -> str:
    """Wrap a rendered body in the branded shell (8A.6.6)."""
    return render(
        "base",
        title=title,
        preheader=preheader,
        body=body,
        portal_url=settings.portal_url,
        footer=footer
        or "Sent automatically by the Zipper business portal. Figures are "
        "generated from the ledger at the time this email was built.",
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Presentation helpers — currency, tables, banners
# ══════════════════════════════════════════════════════════════════════════════


def money(minor: int | None, *, currency: str = "INR") -> str:
    """Integer minor units → a figure that states its currency.

    `None` is "not known", printed as an em dash. It is never printed as zero —
    a missing figure and a zero figure are different facts.
    """
    if minor is None:
        return "—"
    return f"{rupee_text(int(minor))} {currency}"


def quantity(value: int | float | None, unit: str) -> str:
    """A non-money quantity — beans, coins, cards — with its unit attached."""
    if value is None:
        return "—"
    return f"{value:,} {unit}"


def when(value: Any, *, with_time: bool = True) -> str:
    """A timestamp a person can read, always in UTC and saying so."""
    if value is None:
        return "—"
    if not isinstance(value, datetime):
        return str(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%d %b %Y, %H:%M UTC" if with_time else "%d %b %Y")


def facts(rows: Sequence[tuple[str, Any]]) -> str:
    """A label/value block. Values are escaped; labels are ours."""
    cells = []
    for label, value in rows:
        if value is None or value == "":
            continue
        cells.append(
            '<tr>'
            '<td style="padding:7px 14px 7px 0;color:#71717a;font-size:13px;'
            'vertical-align:top;white-space:nowrap">' + esc(label) + "</td>"
            '<td style="padding:7px 0;font-size:14px;vertical-align:top">'
            + esc(value)
            + "</td></tr>"
        )
    if not cells:
        return ""
    return (
        '<table role="presentation" cellpadding="0" cellspacing="0" '
        'style="width:100%;border-collapse:collapse;background:#fafafa;'
        'border:1px solid #e4e4e7;border-radius:8px;padding:6px 14px">'
        "<tbody>" + "".join(cells) + "</tbody></table>"
    )


def button(label: str, href: str) -> str:
    return (
        f'<a href="{esc(href)}" style="display:inline-block;background:#18181b;'
        'color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;'
        'font-weight:600;font-size:14px">' + esc(label) + "</a>"
    )


_TONES = {
    "neutral": ("#fafafa", "#e4e4e7", "#52525b"),
    "warning": ("#fffbeb", "#fde68a", "#92400e"),
    "critical": ("#fef2f2", "#fecaca", "#991b1b"),
    "empty": ("#f8fafc", "#cbd5e1", "#334155"),
}


def callout(text: str, tone: str = "neutral", *, heading: str = "") -> str:
    bg, border, fg = _TONES.get(tone, _TONES["neutral"])
    head = (
        f'<div style="font-size:12px;letter-spacing:.6px;text-transform:uppercase;'
        f'color:{fg};font-weight:600;margin:0 0 6px">{esc(heading)}</div>'
        if heading
        else ""
    )
    return (
        f'<div style="background:{bg};border:1px solid {border};border-radius:8px;'
        f'padding:14px 16px;margin:0 0 16px">{head}'
        f'<div style="line-height:1.6;font-size:14px;color:#18181b">{esc(text)}</div>'
        "</div>"
    )


# ── Rendering a report envelope ───────────────────────────────────────────────
#
# The input is the dict a `reports.Report` produces — `report`, `title`,
# `period`, `rates`, `columns`, `rows`, `totals`, `warnings`, `empty`. Nothing
# is recomputed here; this only decides how the report's own answers are shown.

_SKIP_TOTAL_KEYS = {"group_by", "role", "team", "sees_whole_business"}


def _pair_key(key: str) -> str | None:
    """`net_inr` is `net_inr_minor` divided by 100. Show one, not both."""
    if key.endswith("_inr"):
        return f"{key}_minor"
    return None


def _value_text(key: str, value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, datetime):
        return when(value)
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, default=str, separators=(", ", ": "))[:400]
    if key.endswith("_minor") and isinstance(value, (int, float)):
        return money(int(value))
    if key.endswith("_pct") or key.endswith("_percent"):
        return f"{value}%"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _label(key: str) -> str:
    return key.replace("_inr_minor", "").replace("_minor", "").replace("_", " ").strip().capitalize()


def report_body(envelope: Mapping[str, Any], *, attached: str | None = None) -> str:
    """One report, rendered for an email body.

    Three rules, and they are the reason this function exists rather than a
    generic table printer:

      * **An empty report says so and shows no totals** (8A.6.5). A period in
        which nothing happened must never render as ``₹0.00`` next to the word
        "revenue" — a zero that looks like a measurement is worse than no
        number at all.
      * **A provisional report says which rate it used** and repeats the
        report's own note verbatim (the `rates` block, 8A.6.1).
      * **The body is a preview; the CSV is the report.** Only the first
        `EMAIL_REPORT_PREVIEW_ROWS` rows appear, and the body says how many were
        left out, so nobody reads a truncated table as the whole answer.
    """
    title = str(envelope.get("title") or envelope.get("report") or "Report")
    period = envelope.get("period") or {}
    rates = envelope.get("rates") or {}
    warnings = list(envelope.get("warnings") or [])
    is_empty = bool(envelope.get("empty"))
    rows = list(envelope.get("rows") or [])
    columns = list(envelope.get("columns") or [])

    parts: list[str] = [
        f'<h2 style="font-size:16px;margin:26px 0 10px">{esc(title)}</h2>'
    ]

    # Period and generation time — 8A.6.1, on every report without exception.
    if "since" in period and "until" in period:
        span = (
            f"{when(period.get('since'), with_time=False)} to "
            f"{when(period.get('until'), with_time=False)} "
            f"({period.get('bounds', '[since, until)')})"
        )
    elif "as_at" in period:
        span = f"as at {when(period.get('as_at'))}"
    else:
        span = "period not stated by the report"
    parts.append(
        '<p style="color:#71717a;font-size:12px;margin:0 0 12px;line-height:1.6">'
        f"Period: {esc(span)}<br>"
        f"Generated: {esc(when(envelope.get('generated_at')))}"
        "</p>"
    )

    # Provisional rates — say which rate was used, and that it is not final.
    if rates.get("provisional"):
        used = []
        if rates.get("diamond_pack_price_inr_per_lakh") is not None:
            used.append(
                f"₹{rates['diamond_pack_price_inr_per_lakh']:g} per "
                f"{rates.get('diamonds_per_lakh', 100000):,} diamonds"
            )
        if rates.get("bean_to_inr") is not None:
            used.append(f"₹{rates['bean_to_inr']:g} per bean")
        parts.append(
            callout(
                f"{rates.get('note', 'This report is provisional.')} "
                f"Rate source: {rates.get('source', 'unknown')}. "
                + (f"Applied: {'; '.join(used)}." if used else "")
                + (
                    f" Missing from configuration: {', '.join(rates['missing'])}."
                    if rates.get("missing")
                    else ""
                ),
                "warning",
                heading="Provisional — not the final figure",
            )
        )
    elif rates:
        parts.append(
            '<p style="color:#71717a;font-size:12px;margin:0 0 12px">'
            f"Rates applied: {esc(rates.get('note', ''))}</p>"
        )

    if is_empty:
        # 8A.6.5. No totals table, no zeroes. The explanation is the report's
        # own words, which say why the period is empty.
        explanation = " ".join(warnings) or (
            "There is nothing in this period. No figure is shown, because a "
            "zero here would be read as a measurement rather than an absence."
        )
        parts.append(callout(explanation, "empty", heading="Nothing to report"))
        if attached:
            parts.append(
                '<p style="color:#71717a;font-size:12px;margin:0">'
                f"The attached {esc(attached)} carries the same answer, with the "
                "period and the rates on it.</p>"
            )
        return "".join(parts)

    # Totals.
    totals = envelope.get("totals") or {}
    total_rows: list[tuple[str, Any]] = []
    for key, value in totals.items():
        if key in _SKIP_TOTAL_KEYS:
            continue
        pair = _pair_key(key)
        if pair and pair in totals:
            continue  # the minor-unit sibling is shown instead
        total_rows.append((_label(key), _value_text(key, value)))
    if total_rows:
        parts.append(facts(total_rows))

    # A preview of the table. The CSV is the table.
    limit = max(0, int(settings.email_report_preview_rows))
    if rows and columns and limit:
        head = "".join(
            '<th style="text-align:left;padding:6px 10px 6px 0;font-size:12px;'
            'color:#71717a;border-bottom:1px solid #e4e4e7;white-space:nowrap">'
            + esc(col.get("header", col.get("key", "")))
            + "</th>"
            for col in columns
        )
        body_rows = []
        for row in rows[:limit]:
            cells = "".join(
                '<td style="padding:6px 10px 6px 0;font-size:13px;'
                'border-bottom:1px solid #f4f4f5;vertical-align:top">'
                + esc(_value_text(str(col.get("key", "")), row.get(col.get("key"))))
                + "</td>"
                for col in columns
            )
            body_rows.append(f"<tr>{cells}</tr>")
        parts.append(
            '<div style="overflow-x:auto;margin:14px 0 0">'
            '<table role="presentation" cellpadding="0" cellspacing="0" '
            'style="width:100%;border-collapse:collapse">'
            f"<thead><tr>{head}</tr></thead><tbody>{''.join(body_rows)}</tbody>"
            "</table></div>"
        )
        if len(rows) > limit:
            parts.append(
                '<p style="color:#71717a;font-size:12px;margin:8px 0 0">'
                f"Showing {limit} of {len(rows):,} rows. The attached CSV has "
                "all of them — this table is a preview, not a shorter answer.</p>"
            )

    for warning in warnings:
        parts.append(
            '<p style="color:#92400e;font-size:12px;margin:10px 0 0;'
            f'line-height:1.6">⚠ {esc(warning)}</p>'
        )

    return "".join(parts)


# ══════════════════════════════════════════════════════════════════════════════
#  The role gate — never send a figure to someone who may not read it
# ══════════════════════════════════════════════════════════════════════════════


def may_receive(sensitivity: str, recipient: Recipient) -> tuple[bool, str]:
    """May this addressee be told this class of thing?

    Mirrors `routers/reports.py::_require_business_financials` deliberately: the
    same rule decides who may pull a business-wide money report over HTTP and
    who may be sent one by mail. Two different answers to that question is how a
    figure ends up in the wrong inbox.
    """
    sensitivity = str(sensitivity)
    raw_role = recipient.role
    role: Role | None
    try:
        role = Role(str(raw_role)) if raw_role else None
    except ValueError:
        role = None  # an unrecognised role is treated as an outside address

    if sensitivity in (str(Sensitivity.CREDENTIAL), str(Sensitivity.PARTNER_OWN)):
        return True, ""

    if sensitivity == str(Sensitivity.ANNOUNCEMENT):
        # Anybody. An announcement carries no figure, so there is nothing here
        # for a role gate to protect — and an app user, who is the point of the
        # class, has no role on record at all. What limits an announcement is
        # who may *send* one and to how many (`broadcast.authority_for`) and
        # whether the recipient has opted out (`broadcast.suppressed`), both of
        # which are decided before this function is reached.
        return True, ""

    if sensitivity == str(Sensitivity.OPERATIONAL):
        if role is None:
            return (
                bool(recipient.authorised_by),
                "Operational mail goes to internal accounts. This address is "
                "not one, and no owner has subscribed it.",
            )
        if R.is_internal(role):
            return True, ""
        return False, f"{role} is an external account; operational mail is internal."

    if sensitivity == str(Sensitivity.BUSINESS_MONEY):
        if role is None:
            if recipient.authorised_by:
                return True, ""
            return False, (
                "Business-wide money figures are not sent to an address with no "
                "role on record. An owner can subscribe an outside address "
                "deliberately (8A.3.14); nothing does it by accident."
            )
        if R.can_read_all(role) or R.is_team_admin(role):
            return True, ""
        return False, (
            f"{role} may not read business-wide money. Owners, the Observer and "
            "team admins may; a team member sees their own team's work. The "
            "same rule the reports API applies (1.1.3 / 1.4)."
        )

    return False, f"Unknown sensitivity '{sensitivity}' — refused rather than guessed."


# ══════════════════════════════════════════════════════════════════════════════
#  Delivery records — 8A.2.14 / 8A.2.15
# ══════════════════════════════════════════════════════════════════════════════


class DeliveryNotRecorded(Exception):
    """The delivery row could not be written, so nothing was sent.

    Refusing to send is the deliberate choice. An email nobody can prove was
    sent is not a control, and the emails in this module are the record an
    agency relies on.
    """


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _deliveries():
    from app.db.mongo import C, get_db

    return get_db()[C.EMAIL_DELIVERIES]


def _record_doc(
    *,
    kind: str,
    spec: str,
    recipient: Recipient,
    subject: str,
    sensitivity: str,
    dedupe_key: str | None,
    meta: Mapping[str, Any] | None,
    attachments: Sequence[Attachment],
) -> dict:
    return {
        "kind": kind,                       # what was sent
        "spec": spec,                       # the numbered requirement it serves
        "to": recipient.email.strip().lower(),
        "to_name": recipient.name,
        "to_role": recipient.role,
        "to_uid": recipient.uid,
        "authorised_by": recipient.authorised_by,
        "subject": subject,                 # never the body — no figures at rest here
        "sensitivity": str(sensitivity),
        "dedupe_key": dedupe_key,
        "queued_at": _now(),
        "sent_at": None,
        "outcome": str(Outcome.QUEUED),
        "provider": PROVIDER,
        "provider_message_id": None,
        "provider_status": None,
        "provider_reason": None,
        "provider_headers": {},
        #: The provider's rejection, verbatim and unsummarised. Never a
        #: paraphrase, never truncated by us — see `_from_exception`.
        "provider_error_body": None,
        #: The exact field the provider named, e.g. `attachments.0.type`.
        "provider_error_fields": [],
        "error": None,
        "attempts": 0,
        "attachments": [a.summary() for a in attachments],
        #: Files that could not be sent, each with the reason, so an absent CSV
        #: is a stated omission rather than something a reader has to notice.
        "attachments_omitted": [],
        "bulk": False,
        "headers_sent": [],
        "meta": dict(meta or {}),
        "events": [],
        #: Spec §12 — which identity this left under and whether it was tracked.
        #: Filled by `deliver()`; a withheld row keeps the defaults.
        "identity": None,
        "tracking": None,
        #: How many sweep retries have been made, and when the next may run.
        "retry_count": 0,
        "retry_after": None,
        "last_attempt_at": None,
        #: The recipe a sweep re-renders from (`template` + safe `params`),
        #: present only for retryable template sends; never for a code.
        "retry": None,
        #: `{"userId", "eventKey"}` of the in-app notice this email belongs to,
        #: so a retry can update that notice's delivery state.
        "notice": None,
    }


async def _insert_record(doc: dict) -> tuple[Any, bool]:
    """Write the row before sending. Returns (id, is_duplicate)."""
    from pymongo.errors import DuplicateKeyError, PyMongoError

    try:
        result = await _deliveries().insert_one(doc)
        return result.inserted_id, False
    except DuplicateKeyError:
        return None, True
    except (PyMongoError, RuntimeError) as exc:
        raise DeliveryNotRecorded(
            f"The delivery record for '{doc['kind']}' → {doc['to']} could not be "
            f"written ({exc}), so the email was not sent. Spec 8A.2.14."
        ) from exc


async def _close_record(record_id: Any, patch: dict) -> None:
    from pymongo.errors import PyMongoError

    try:
        await _deliveries().update_one({"_id": record_id}, {"$set": patch})
    except (PyMongoError, RuntimeError):
        # The mail has already gone out. Losing the outcome is bad, and the row
        # stays in `queued`, which `FAILURE_OUTCOMES` treats as a failure — so
        # it surfaces rather than disappearing.
        log.exception(
            "Delivery record %s could not be closed. It stays 'queued' and will "
            "show as a failure, which is the correct reading: the outcome is "
            "genuinely unknown.",
            record_id,
        )


async def _record_only(doc: dict, outcome: Outcome, error: str) -> dict:
    """Write a row for a send that deliberately did not happen."""
    doc = dict(doc)
    doc["outcome"] = str(outcome)
    doc["error"] = error
    doc["sent_at"] = None
    record_id, duplicate = await _insert_record(doc)
    if duplicate:
        doc["outcome"] = str(Outcome.DUPLICATE)
        doc["error"] = "This exact event was already recorded; nothing re-sent."
    doc["id"] = str(record_id) if record_id else None
    return doc


async def record_withheld(
    *,
    kind: str,
    spec: str,
    recipient: Recipient,
    subject: str,
    sensitivity: Sensitivity | str,
    outcome: Outcome,
    reason: str,
    dedupe_key: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> dict:
    """Write a delivery row for a message a *caller* decided not to send.

    `deliver()` already records the two withholdings it decides itself — no
    address, and a role that may not read the figure. This is for the third
    kind, which is decided before `deliver()` is reached and would otherwise be
    invisible: a recipient who has unsubscribed from the stream.

    It exists so there is still exactly one delivery log. An address dropped
    silently in a caller's list comprehension is indistinguishable, on
    `/tech/email`, from an address that was never in the audience — and "did the
    person who opted out get it anyway" is precisely the question the log has to
    be able to answer. `outcome` must be one of `WITHHELD_OUTCOMES`: this writes
    decisions, never failures, and never anything that was actually sent.

    Nothing leaves the machine on this path. There is no provider call.
    """
    if str(outcome) not in WITHHELD_OUTCOMES:
        raise ValueError(
            f"'{outcome}' is not a withholding. `record_withheld` writes rows "
            f"for messages deliberately not sent; the ones it accepts are "
            f"{', '.join(sorted(WITHHELD_OUTCOMES))}. A failure is recorded by "
            "`deliver()` itself, which is the only thing that knows there was "
            "an attempt to fail."
        )
    doc = _record_doc(
        kind=kind,
        spec=spec,
        recipient=recipient,
        subject=subject,
        sensitivity=str(sensitivity),
        dedupe_key=dedupe_key,
        meta=meta,
        attachments=(),
    )
    return await _record_only(doc, outcome, reason)


# ══════════════════════════════════════════════════════════════════════════════
#  Who it comes from — 8A.7, and the half of deliverability that is ours
# ══════════════════════════════════════════════════════════════════════════════
#
# Landing in spam is two problems wearing one coat. The half that is DNS — SPF,
# DKIM, DMARC, a domain that is actually ours — is written down for the owner in
# DEPLOYMENT.md §"Email deliverability", because only they can publish a record.
# The half that is ours is here: a plain-text alternative, the unsubscribe
# headers a bulk sender is required to carry, no Reply-To (spec §12), and the
# sender identities on one authenticated domain instead of everything leaving
# from one mailbox.


class SenderIdentity(StrEnum):
    """Which visible From an email leaves from. Spec §12, the identity table.

        auth | security | transactional  →  no-reply@<domain>   always
        info                             →  info@<domain>       switchable
        support                          →  support@<domain>    switchable
        bulk                             →  the `info` stream   (legacy name)

    The three no-reply streams share one address and differ in what they are
    allowed to carry and how they are sent: `auth` and `security` mail is
    never tracked (a click-tracked reset link is a live token routed through a
    third party's redirect) and `auth` mail is never re-rendered by a retry
    sweep (a code is minted once). `info` and `support` are separable at the
    address level so their reputations can fail separately — but only once the
    owner has confirmed those mailboxes exist (`EMAIL_IDENTITY_*_ENABLED`),
    because a From that nobody can reply to is worse than no-reply.
    """

    #: OTP, verification, password reset. Untracked, never re-rendered.
    AUTH = "auth"
    #: Sign-in notices, MFA changes, access changes. Untracked.
    SECURITY = "security"
    #: One person's own event — an approval, a receipt, a decision.
    TRANSACTIONAL = "transactional"
    #: General platform information: scheduled reports, platform news.
    INFO = "info"
    #: Support communications — a ticket reply, a conversation.
    SUPPORT = "support"
    #: Legacy name for the `info` stream. Kept so `identity=BULK` call sites
    #: (reports, alerts, broadcasts) keep working; it resolves exactly as INFO.
    BULK = "bulk"


#: identity → (stream, local part, the settings switch that turns it on).
#: A switch of `None` means the identity is always its stream. This table is
#: what `sender_for`, the delivery row and `scripts/email_identity_check.py`
#: all read, so there is one answer to "which address does X leave from".
IDENTITY_TABLE: dict[str, tuple[str, str, str | None]] = {
    str(SenderIdentity.AUTH): ("no-reply", "no-reply", None),
    str(SenderIdentity.SECURITY): ("no-reply", "no-reply", None),
    str(SenderIdentity.TRANSACTIONAL): ("no-reply", "no-reply", None),
    str(SenderIdentity.INFO): ("info", "info", "email_identity_info_enabled"),
    str(SenderIdentity.BULK): ("info", "info", "email_identity_info_enabled"),
    str(SenderIdentity.SUPPORT): ("support", "support", "email_identity_support_enabled"),
}

#: Identities whose mail is never tracked (click, open, subscription, GA).
UNTRACKED_IDENTITIES: frozenset[str] = frozenset(
    {str(SenderIdentity.AUTH), str(SenderIdentity.SECURITY)}
)


#: Sending "as" one of these can never be aligned: nobody outside the provider
#: can publish SPF or DKIM for gmail.com, so mail claiming to be from one and
#: sent through SendGrid fails DMARC at every serious receiver.
PUBLIC_MAILBOX_DOMAINS: frozenset[str] = frozenset(
    {
        "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com",
        "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com",
        "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
        "rediffmail.com", "zoho.com", "gmx.com", "mail.com", "yandex.com",
    }
)


def _domain_of(address: str) -> str:
    return str(address or "").rpartition("@")[2].strip().lower()


def _masked(address: str) -> str:
    """What a log line may say about a recipient: `***@domain`, never the address.

    The delivery row keeps the full address — that is the record. A log line is
    copied into places nobody audits, so it carries only enough to tell one
    mail system from another.
    """
    return f"***@{_domain_of(address) or '?'}"


def _switch_on(name: str | None) -> bool:
    return bool(name) and bool(getattr(settings, str(name), False))


def _no_reply_address() -> tuple[str, str]:
    """The always-on stream: MAIL_FROM_TRANSACTIONAL, else MAIL_FROM."""
    address = str(settings.mail_from_transactional or settings.mail_from or "").strip()
    name = settings.mail_from_name_transactional or settings.mail_from_name
    return address, name


def _info_address() -> tuple[str, str]:
    """The `info` stream once its switch is on: MAIL_FROM_INFO, else the legacy
    MAIL_FROM_BULK, else `info@<the mail_from domain>`."""
    domain = _domain_of(settings.mail_from)
    address = str(
        getattr(settings, "mail_from_info", "") or settings.mail_from_bulk
        or (f"info@{domain}" if domain else "")
    ).strip()
    name = (
        getattr(settings, "mail_from_name_info", "") or settings.mail_from_name_bulk
        or settings.mail_from_name
    )
    return address, name


def _support_address() -> tuple[str, str]:
    """The `support` stream once its switch is on: MAIL_FROM_SUPPORT (which
    SENDGRID_REPLY_TO populates), else SUPPORT_EMAIL, else `support@<domain>`."""
    domain = _domain_of(settings.mail_from)
    address = str(
        settings.mail_from_support or settings.support_email
        or (f"support@{domain}" if domain else "")
    ).strip()
    return address, settings.mail_from_name


def identity_resolution(identity: SenderIdentity | str) -> dict:
    """Everything about how one identity leaves, as a record. No secret in it.

    `{"identity", "stream", "switch", "enabled", "from", "from_name",
      "reply_to", "tracking", "fallback"}` — `fallback` says why the From is
    not the identity's own address (its switch is off), so the delivery row and
    the identity check script can both show the owner what actually happened.
    """
    key = str(identity or SenderIdentity.TRANSACTIONAL)
    stream, _local, switch = IDENTITY_TABLE.get(key, IDENTITY_TABLE[str(SenderIdentity.TRANSACTIONAL)])
    enabled = switch is None or _switch_on(switch)
    fallback = ""
    if stream == "info" and enabled:
        address, name = _info_address()
    elif stream == "support" and enabled:
        address, name = _support_address()
    else:
        address, name = _no_reply_address()
        if switch is not None:
            fallback = (
                f"{switch.upper()} is off, so the '{key}' identity leaves from the "
                "no-reply address until the owner confirms its mailbox (Q8)."
            )
    # Spec §12: no Reply-To, on any identity, switch or no switch. A reply goes
    # to the From — and once support@ is switched on, support mail's From IS
    # support@, so replies to support reach it without a header that could
    # point at a mailbox nobody reads (Q8).
    reply_to = ""
    return {
        "identity": key,
        "stream": stream,
        "switch": switch,
        "enabled": bool(enabled),
        "from": address,
        "from_name": name,
        "reply_to": reply_to,
        "tracking": "off" if key in UNTRACKED_IDENTITIES else "default",
        "fallback": fallback,
    }


def sender_for(identity: SenderIdentity | str) -> tuple[str, str, str]:
    """`(from_email, from_name, reply_to)` for one identity — spec §12.

    Resolved through `IDENTITY_TABLE`: the three no-reply streams always leave
    from `mail_from` (or MAIL_FROM_TRANSACTIONAL); `info` and `support` leave
    from their own address only when their switch is on, and otherwise fall
    back to no-reply. `reply_to` is always empty (spec §12: no Reply-To) and
    is kept in the tuple only so existing callers keep their shape.
    """
    resolved = identity_resolution(identity)
    return resolved["from"], resolved["from_name"], resolved["reply_to"]


def identity_for_kind(kind: str, sensitivity: Sensitivity | str = "") -> SenderIdentity:
    """The identity a send of this `kind` belongs to when the caller named none.

    Callers that this module owns name their identity on the template. The
    legacy callers that do not (`owner_mfa`, `staff`, `alerts`, `broadcast`)
    are classified from the kind: a credential is `auth`, an access or MFA
    change is `security`, everything else is `transactional`.
    """
    kind = str(kind or "")
    if str(sensitivity) == str(Sensitivity.CREDENTIAL) or kind in _CREDENTIAL_KINDS:
        return SenderIdentity.AUTH
    if kind in _SECURITY_KINDS or kind.startswith(_SECURITY_KIND_PREFIXES):
        return SenderIdentity.SECURITY
    return SenderIdentity.TRANSACTIONAL


def tracking_for(identity: SenderIdentity | str, kind: str = "", sensitivity: Sensitivity | str = "") -> str:
    """`"off"` for auth and security mail (and any credential), else `"default"`."""
    if str(identity) in UNTRACKED_IDENTITIES or _is_auth_mail(kind, sensitivity):
        return "off"
    return "default"


def sender_alignment(identity: SenderIdentity | str = SenderIdentity.TRANSACTIONAL) -> dict:
    """Whether this From can ever pass DMARC, and why not when it cannot.

    Recorded on the delivery row. It is not a guess about a spam folder: a From
    on a domain the sender does not control cannot carry an aligned SPF or DKIM
    signature, and that is a fact checkable from the address alone.
    """
    address, _name, reply_to = sender_for(identity)
    domain = _domain_of(address)
    public = domain in PUBLIC_MAILBOX_DOMAINS
    # All three identities must sit on one domain, or one DKIM key cannot cover
    # them and the reputation of one stream stops helping the others.
    domains = {_domain_of(sender_for(i)[0]) for i in SenderIdentity} | {
        _domain_of(settings.mail_from)
    }
    split = len(domains - {""}) > 1
    return {
        "from": address,
        "domain": domain,
        "reply_to": reply_to,
        "aligned": bool(domain) and not public,
        "one_domain": not split,
        "domains": sorted(d for d in domains if d),
        "why": (
            (
                "The sender identities are spread across "
                f"{', '.join(sorted(d for d in domains if d))}. One DKIM key "
                "authenticates one domain, so a From on any other is unaligned "
                "however well the main one is set up — put all of MAIL_FROM, "
                "MAIL_FROM_TRANSACTIONAL, MAIL_FROM_BULK and MAIL_FROM_SUPPORT "
                "on the domain authenticated in SendGrid."
            )
            if split and domain and not public
            else ""
            if domain and not public
            else (
                f"'{address}' is on {domain or 'no domain at all'}, a public "
                "mailbox provider. SPF and DKIM for it are published by that "
                "provider and cannot be published by us, so mail sent through "
                "SendGrid claiming this From is unaligned and will be treated "
                "as suspicious however good the content is. The only fix is a "
                "domain we control — DEPLOYMENT.md §'Email deliverability'."
            )
        ),
    }


# ── The plain-text alternative ────────────────────────────────────────────────
#
# An HTML-only message is one of the strongest single spam signals there is, and
# it is also unreadable in a client that refuses HTML. The text part is derived
# from the same HTML, so the two can never say different things.

_HIDDEN = re.compile(r"<span[^>]*display\s*:\s*none[^>]*>.*?</span>", re.I | re.S)
_DROP = re.compile(r"<(script|style|head)\b.*?</\1>", re.I | re.S)
_LINK = re.compile(r'<a\b[^>]*\bhref=["\']([^"\']*)["\'][^>]*>(.*?)</a>', re.I | re.S)
_BREAK = re.compile(r"</?(br|tr|p|div|h[1-6]|li|table|thead|tbody)\b[^>]*>", re.I)
_CELL = re.compile(r"</(td|th)>", re.I)
_TAG = re.compile(r"<[^>]+>")
_BLANKS = re.compile(r"\n{3,}")


def _link_text(match: re.Match) -> str:
    """`<a href="X">Y</a>` → `Y [X]`, with the URL kept.

    Square brackets, not angle brackets: the tag stripper two lines later would
    eat `<https://…>` as if it were markup, which is how a "click here" with no
    destination gets into a plain-text part — useless to a reader and a
    phishing pattern to a filter.
    """
    href = match.group(1).strip()
    label = _TAG.sub("", match.group(2)).strip()
    if not href:
        return label
    if not label or _html.unescape(label) == _html.unescape(href):
        return href
    return f"{label} [{href}]"


def text_alternative(html: str) -> str:
    """The same email, as text. Never a second version of anything.

    Links keep their destination rather than being dropped, because "click here"
    with no URL is both useless and a phishing pattern.
    """
    text = _DROP.sub(" ", str(html or ""))
    text = _HIDDEN.sub(" ", text)
    text = _LINK.sub(_link_text, text)
    text = _CELL.sub("\t", text)
    text = _BREAK.sub("\n", text)
    text = _TAG.sub("", text)
    text = _html.unescape(text)
    lines = [re.sub(r"[ \t]+", lambda m: "\t" if "\t" in m.group(0) else " ", ln).strip()
             for ln in text.splitlines()]
    text = _BLANKS.sub("\n\n", "\n".join(lines)).strip()
    return text or "This message has no text content."


# ── Unsubscribe — Gmail and Yahoo, bulk senders, since February 2024 ─────────


@dataclass(slots=True)
class Unsubscribe:
    """Where a recipient of a bulk stream goes to stop receiving it.

    Presence of this on a `deliver()` call is what makes a message *bulk*: it
    gets `List-Unsubscribe`, a `List-Id`, and `Auto-Submitted: auto-generated`.

    `one_click` is only honoured when `settings.unsubscribe_url` is configured,
    because `List-Unsubscribe-Post: List-Unsubscribe=One-Click` promises an
    endpoint that answers. Advertising one-click and then not answering is worse
    for a domain's reputation than never advertising it, so the header is
    omitted rather than made up.
    """

    #: The key `notify.subscriptions` stores, e.g. `daily_business_summary`.
    report: str
    #: `daily` | `weekly` | `monthly`.
    cadence: str = ""
    #: False for a stream that cannot be muted by a machine — an alert is
    #: switched off by a person changing an audience, not by a POST.
    one_click: bool = True

    def summary(self) -> dict:
        return {
            "report": self.report,
            "cadence": self.cadence,
            "one_click": bool(self.one_click),
        }


def unsubscribe_token(address: str, report: str, cadence: str) -> str:
    """A tamper-proof handle on exactly one (address, report, cadence).

    It is not a credential: it grants nothing except muting that one stream for
    that one address, which is the recipient's own decision to take. It is
    derived, never stored, and never written to a log or a delivery record.
    """
    import hashlib
    import hmac

    payload = f"{str(address).strip().lower()}|{report}|{cadence}".encode()
    return hmac.new(
        settings.jwt_secret.encode(), payload, hashlib.sha256
    ).hexdigest()[:32]


def unsubscribe_token_valid(address: str, report: str, cadence: str, token: str) -> bool:
    import hmac

    return hmac.compare_digest(
        unsubscribe_token(address, report, cadence), str(token or "")
    )


def unsubscribe_mailbox() -> str:
    """The mailbox a `mailto:` unsubscribe reaches. Must not bounce."""
    if settings.unsubscribe_email:
        return settings.unsubscribe_email
    domain = _domain_of(settings.mail_from)
    return f"unsubscribe@{domain}" if domain else ""


def unsubscribe_url_for(address: str, target: Unsubscribe) -> str:
    """The RFC 8058 one-click URL, or "" when none is configured."""
    from urllib.parse import quote, urlencode

    base = str(settings.unsubscribe_url or "").strip()
    if not base or not target.one_click:
        return ""
    query = urlencode(
        {
            "e": str(address).strip().lower(),
            "r": target.report,
            "c": target.cadence,
            "t": unsubscribe_token(address, target.report, target.cadence),
        },
        quote_via=quote,
    )
    return f"{base}{'&' if '?' in base else '?'}{query}"


def bulk_headers(address: str, target: Unsubscribe) -> dict[str, str]:
    """Every header a bulk or scheduled message must carry.

    `List-Unsubscribe` is present unconditionally — a mailto to a mailbox a
    person reads is a real unsubscribe route, and Gmail and Yahoo have required
    the header on bulk mail since February 2024. `List-Unsubscribe-Post` is
    added only when a one-click endpoint is actually configured.
    """
    routes: list[str] = []
    url = unsubscribe_url_for(address, target)
    if url:
        routes.append(f"<{url}>")
    mailbox = unsubscribe_mailbox()
    if mailbox:
        subject = f"unsubscribe {target.report}:{target.cadence}".strip().rstrip(":")
        routes.append(f"<mailto:{mailbox}?subject={subject.replace(' ', '%20')}>")

    headers: dict[str, str] = {}
    if routes:
        headers["List-Unsubscribe"] = ", ".join(routes)
    if url:
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

    domain = _domain_of(sender_for(SenderIdentity.BULK)[0])
    if domain and target.report:
        stream = re.sub(r"[^a-z0-9]+", "-", target.report.lower()).strip("-")
        headers["List-Id"] = f"{target.report} <{stream}.reports.{domain}>"
    # RFC 3834. Stops an out-of-office reply storm against a report nobody sent
    # by hand, and marks the message as machine-generated for the receiver.
    headers["Auto-Submitted"] = "auto-generated"
    return headers


# ── Wording that reads as spam ────────────────────────────────────────────────

_SHORTENERS: frozenset[str] = frozenset(
    {
        "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
        "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc", "s.id",
    }
)
#: Two or more all-capital *words* in a row. Deliberately not "any run of
#: capitals": `UTR SBIN226012345678` on a payment receipt is a bank reference,
#: not shouting, and a check that cannot tell those apart would be turned off.
_CAPS_RUN = re.compile(r"\b[A-Z]{3,}(?:[ ]+[A-Z]{2,})+\b")
_PUNCT_RUN = re.compile(r"[!?]{2,}|!{1,}\?|\?{1,}!")


def subject_problems(subject: str) -> list[str]:
    """Everything in a subject line that a filter reads as shouting.

    Used by the test suite over the whole catalogue, so a new template cannot
    quietly introduce `URGENT!!! FREE` and be discovered in a spam folder.
    """
    subject = str(subject or "")
    out: list[str] = []
    shouted = _CAPS_RUN.findall(subject)
    if shouted:
        out.append(
            f"shouts in capitals: {', '.join(repr(s.strip()) for s in shouted)}. "
            "Sentence case says the same thing and is not scored as spam."
        )
    letters = [c for c in subject if c.isalpha()]
    if len(letters) >= 10 and all(c.isupper() for c in letters):
        out.append("is entirely in capitals.")
    if _PUNCT_RUN.search(subject):
        out.append("repeated '!' or '?'. One is enough; more reads as a mailshot.")
    if subject.count("$") or "₹₹" in subject:
        out.append("a bare currency symbol run in the subject.")
    if len(subject) > 140:
        out.append(f"is {len(subject)} characters; over 140 is truncated everywhere.")
    if not subject.strip():
        out.append("is empty. An empty subject is refused by most receivers.")
    return out


def body_problems(html: str) -> list[str]:
    """Spam signals in a rendered body: no text, only images, shortened links."""
    html = str(html or "")
    out: list[str] = []
    text = text_alternative(html)
    images = len(re.findall(r"<img\b", html, re.I))
    if images and len(text) < 200:
        out.append(
            f"{images} image(s) and only {len(text)} characters of text — an "
            "image-only body is scored as spam and is unreadable with images off."
        )
    for href in re.findall(r'href=["\']([^"\']+)["\']', html, re.I):
        host = href.split("//")[-1].split("/")[0].split("?")[0].strip().lower()
        if host in _SHORTENERS:
            out.append(f"links through the shortener {host}; link to the real URL.")
    if not text.strip():
        out.append("has no text at all once the HTML is removed.")
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  The provider
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class ProviderResult:
    ok: bool
    status: int | None = None
    message_id: str | None = None
    error: str | None = None
    #: **The provider's own answer, byte for byte, decoded.** This is the field
    #: that did not exist and whose absence turned a one-line fix into a
    #: mystery: `str()` on a `python_http_client.BadRequestsError` is the
    #: constant string "HTTP Error 400: Bad Request", and every word of the
    #: explanation — including the exact field that is wrong — is in `.body`.
    body: str = ""
    reason: str = ""
    #: The `field` values SendGrid named, e.g. `["attachments.0.type"]`.
    fields: list[str] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    #: How many times SendGrid was asked. More than one only after an attempt
    #: that provably never reached it or that it refused unprocessed — never
    #: after one it may have accepted (see `_attempt_class`).
    attempts: int = 1
    #: The last attempt may have been accepted: a timeout or a dropped
    #: connection after the request was written, or a 500/502/504. Recorded as a
    #: failure and deliberately NOT sent again, so a slow success cannot become
    #: a second email.
    outcome_unknown: bool = False
    #: One entry per attempt — status, exception class, classification. No
    #: body, no address, no key.
    attempt_log: list[dict] = field(default_factory=list)


#: Response headers worth keeping. An allowlist rather than "everything minus a
#: denylist", so a header the provider adds tomorrow cannot carry a credential
#: onto a delivery record by default.
_KEPT_HEADERS = ("x-message-id", "x-request-id", "date", "content-type")


def _headers_dict(raw: Any) -> dict[str, str]:
    """The response headers we keep, lower-cased, never a credential."""
    if raw is None:
        return {}
    try:
        items = raw.items()
    except AttributeError:
        try:
            items = dict(raw).items()
        except Exception:  # noqa: BLE001
            return {}
    out: dict[str, str] = {}
    for key, value in items:
        name = str(key).lower()
        if name in _KEPT_HEADERS:
            out[name] = str(value)
    return out


def _decode(body: Any) -> str:
    """The provider's body as text, whatever shape the SDK handed it over in."""
    if body is None:
        return ""
    if isinstance(body, (bytes, bytearray)):
        return bytes(body).decode("utf-8", errors="replace")
    return str(body)


def _named_fields(body_text: str) -> list[str]:
    """The `field` values out of a SendGrid error body, in order.

    SendGrid answers a rejection with
    `{"errors":[{"message": …, "field":"attachments.0.type", "help": …}]}`.
    The field is the whole diagnosis, so it is pulled out and stored on its own
    as well as being kept inside the verbatim body.
    """
    try:
        parsed = json.loads(body_text)
    except (ValueError, TypeError):
        return []
    errors = parsed.get("errors") if isinstance(parsed, Mapping) else None
    if not isinstance(errors, list):
        return []
    return [
        str(e["field"])
        for e in errors
        if isinstance(e, Mapping) and e.get("field") not in (None, "")
    ]


def _hint(status: int | None, body_text: str, fields: Sequence[str]) -> str:
    """A sentence naming the likely cause, appended to — never replacing — the body."""
    joined = " ".join(fields).lower()
    if any(f.startswith("attachments") for f in fields):
        if ".type" in joined:
            return (
                " | SendGrid is refusing the attachment's MIME type. Its "
                "`attachments[].type` must be a bare 'type/subtype' with no "
                "parameters — 'text/csv; charset=utf-8' is rejected outright and "
                "takes the whole message with it. `Attachment.provider_type()` "
                "strips parameters before the send, so seeing this means "
                "something bypassed it."
            )
        if ".filename" in joined:
            return (
                " | SendGrid is refusing the attachment's filename. It may not "
                "be empty and may not contain ';' or CR/LF. "
                "`Attachment.safe_filename()` removes those."
            )
        if ".content" in joined:
            return (
                " | SendGrid is refusing the attachment's content: it must be "
                "non-empty and base64. `Attachment.unsendable()` is meant to "
                "have left an empty file off before this point."
            )
        return " | The rejection is about an attachment; the field above says which."
    if status == 403:
        return (
            f" | 403 from SendGrid almost always means MAIL_FROM "
            f"({settings.mail_from}) is not a verified sender. Verify it under "
            "Settings → Sender Authentication, or set MAIL_FROM to an address "
            "that already is. Nothing was delivered."
        )
    if status == 401:
        return (
            " | 401 means the API key was not accepted. Rotate it in SendGrid "
            "and update the secret; the key itself is never printed here."
        )
    if status == 413:
        return (
            " | 413 means the whole request was too large. "
            "EMAIL_MAX_TOTAL_ATTACHMENT_BYTES caps this before the send."
        )
    return ""


def _from_exception(exc: Exception) -> ProviderResult:
    """Turn a provider exception into a recorded outcome that keeps its reason.

    `python_http_client` raises `BadRequestsError` and friends, whose `str()` is
    the fixed text "HTTP Error 400: Bad Request" and whose `.body` holds the
    entire explanation. Recording only the former is how a one-line
    configuration mistake stayed unexplained across every run: the reason was
    fetched over the network, arrived intact, and was thrown away one frame
    below where it was needed.
    """
    status_raw = getattr(exc, "status_code", None)
    try:
        status = int(status_raw) if status_raw is not None else None
    except (TypeError, ValueError):
        status = None

    body_text = _decode(getattr(exc, "body", None))
    reason = _decode(getattr(exc, "reason", None))
    headers = _headers_dict(getattr(exc, "headers", None))
    fields = _named_fields(body_text)

    detail = f"{type(exc).__name__}: {exc}"
    if status is not None:
        detail += f" | HTTP {status}"
    if reason and reason.lower() not in detail.lower():
        detail += f" {reason}"
    if fields:
        detail += f" | field(s): {', '.join(fields)}"
    if body_text:
        # Verbatim, in full, unsummarised. This is the whole point.
        detail += f" | provider said: {body_text}"
    else:
        detail += (
            " | the provider returned no body, so there is nothing more it said. "
            "That is recorded as an absence, not as a cause."
        )
    detail += _hint(status, body_text, fields)

    return ProviderResult(
        False,
        status=status,
        error=detail,
        body=body_text,
        reason=reason,
        fields=fields,
        headers=headers,
    )


# ── Retries: only when SendGrid provably did not take the message ─────────────
#
# A timeout can arrive AFTER SendGrid accepted a message: the request was
# written, SendGrid queued it, and the answer was lost on the way back. Sending
# it again would deliver the same email twice. So an attempt is repeated only
# when it provably never reached SendGrid, or SendGrid refused it unprocessed:
#
#   retryable  urllib's `URLError` — raised only while connecting or writing
#              the request; python-http-client lets it through unchanged — and
#              HTTP 429 / 503 (refused; nothing was accepted).
#   unknown    a timeout, a reset or a broken answer while waiting for the
#              reply (TimeoutError, ConnectionError, http.client.HTTPException),
#              HTTP 500 / 502 / 504, and anything unrecognised. Never repeated;
#              recorded as a failure that may nevertheless have been delivered.
#   permanent  every other 4xx — the request itself is wrong; repeating it
#              cannot help.

#: SendGrid refused these unprocessed; asking again cannot produce a second email.
_RETRYABLE_STATUSES = frozenset({429, 503})
#: Answers that do not say whether the message was taken — a server or gateway
#: error can come back after SendGrid accepted it.
_UNKNOWN_STATUSES = frozenset({500, 502, 504})
#: No attempt starts with less than this left of the send budget.
_MIN_ATTEMPT_SECONDS = 5.0
#: However EMAIL_MAX_ATTEMPTS is set, one send never asks more often than this.
_MAX_ATTEMPTS_CEILING = 5

#: Tests only: point the real SDK at a local server. Always None in production.
_PROVIDER_HOST: str | None = None
#: Injectable so that a retry test does not wait in real time.
_sleep = time.sleep
_jitter = random.random
_clock = time.monotonic


def _status_class(status: int | None) -> str:
    if status is None:
        return "unknown"
    if 200 <= status < 300:
        return "accepted"
    if status in _RETRYABLE_STATUSES:
        return "retryable"
    if status in _UNKNOWN_STATUSES or status >= 500:
        return "unknown"
    if 400 <= status < 500:
        return "permanent"
    return "unknown"


def _attempt_class(status: int | None, exc: BaseException | None) -> str:
    """`accepted`, `retryable`, `unknown` or `permanent` — for one attempt."""
    if exc is None:
        return _status_class(status)
    # urllib raises URLError only from the request phase of
    # `AbstractHTTPHandler.do_open` (connect, TLS, write). HTTPError is a
    # URLError subclass that carries a real answer, so it goes by its status.
    if isinstance(exc, urllib.error.URLError) and not isinstance(exc, urllib.error.HTTPError):
        return "retryable"
    if status is not None:
        return _status_class(status)
    # TimeoutError, ConnectionError, http.client.HTTPException (RemoteDisconnected,
    # IncompleteRead, BadStatusLine) and anything unrecognised: raised while
    # waiting for the answer, so the request may have been taken.
    return "unknown"


def _retry_after_seconds(source: Any) -> float | None:
    """The wait a refusal asked for: `Retry-After` (seconds) or `X-RateLimit-Reset` (epoch)."""
    raw = getattr(source, "headers", None) if source is not None else None
    if raw is None:
        return None

    def header(name: str) -> Any:
        try:
            value = raw.get(name)
        except AttributeError:
            return None
        if value is None and isinstance(raw, Mapping):
            for key, candidate in raw.items():
                if str(key).lower() == name.lower():
                    return candidate
        return value

    after = header("Retry-After")
    if after is not None:
        try:
            return max(0.0, float(str(after).strip()))
        except ValueError:
            return None
    reset = header("X-RateLimit-Reset")
    if reset is not None:
        try:
            return max(0.0, float(str(reset).strip()) - time.time())
        except ValueError:
            return None
    return None


def _result_from_response(response: Any) -> ProviderResult:
    """What one answer from the SDK means. A non-2xx is reached here only by a
    client that does not raise on one — a stub, or a future SDK."""
    status = int(getattr(response, "status_code", 0) or 0)
    raw_headers = getattr(response, "headers", None)
    kept = _headers_dict(raw_headers)
    message_id = kept.get("x-message-id")
    if message_id is None:
        try:
            message_id = (raw_headers or {}).get("X-Message-Id")
        except AttributeError:
            message_id = None

    if 200 <= status < 300:
        return ProviderResult(
            True, status=status, message_id=message_id, headers=kept
        )

    # The SDK raises on a non-2xx, so this path is reached only by a client that
    # does not — a stub, or a future SDK. It loses no more detail than the one
    # above: same body, same fields, same hint.
    body_text = _decode(getattr(response, "body", None))
    fields = _named_fields(body_text)
    detail = f"HTTP {status}"
    if fields:
        detail += f" | field(s): {', '.join(fields)}"
    detail += (
        f" | provider said: {body_text}"
        if body_text
        else " | the provider returned no body, so there is nothing more it said."
    )
    detail += _hint(status, body_text, fields)
    return ProviderResult(
        False,
        status=status,
        message_id=message_id,
        error=detail,
        body=body_text,
        fields=fields,
        headers=kept,
    )


def _send_via_provider(
    *, to_email: str, to_name: str, subject: str, html: str,
    attachments: Sequence[Attachment],
    text: str = "",
    identity: SenderIdentity | str = SenderIdentity.TRANSACTIONAL,
    headers: Mapping[str, str] | None = None,
    track: bool = True,
    retry: bool = False,
) -> ProviderResult:
    """One send to SendGrid. Every failure path returns, none raise.

    What leaves here that did not before: a plain-text alternative alongside the
    HTML, the bulk headers when the caller supplied any, a From chosen by
    stream, and — on failure — the provider's own explanation rather than the
    SDK's constant summary of it.

    `retry=True` allows up to EMAIL_MAX_ATTEMPTS attempts inside
    EMAIL_SEND_BUDGET_SECONDS, but only after an attempt SendGrid provably did
    not take (see `_attempt_class`). An attempt that may have been accepted is
    never repeated; the result says `outcome_unknown` instead. With the default
    `retry=False` there is exactly one attempt, as before.

    `track=False` turns click, open, subscription and Google Analytics tracking
    off for this message, whatever the account default is. It is used for codes,
    set-password links and account-access mail (`_is_auth_mail`).
    """
    # Imported here, not at module scope: this module must be importable — and
    # its templates renderable and previewable — on a machine that has no
    # provider SDK installed.
    try:
        from sendgrid import SendGridAPIClient
        from sendgrid.helpers.mail import (
            Attachment as SgAttachment,
            ClickTracking,
            Content,
            Disposition,
            Email,
            FileContent,
            FileName,
            FileType,
            Ganalytics,
            Header,
            Mail,
            OpenTracking,
            SubscriptionTracking,
            To,
            TrackingSettings,
        )
    except ImportError as exc:
        return ProviderResult(False, error=f"SendGrid SDK not installed: {exc}")

    from_email, from_name, reply_to = sender_for(identity)

    message = Mail(
        from_email=Email(from_email, from_name),
        to_emails=To(to_email, to_name or None),
        subject=subject,
        # text/plain first, which is both what the API requires and what stops a
        # message being HTML-only — one of the strongest spam signals there is.
        plain_text_content=text or text_alternative(html),
        html_content=Content("text/html", html),
    )
    if reply_to:
        message.reply_to = Email(reply_to)

    for name, value in (headers or {}).items():
        message.add_header(Header(str(name), str(value)))

    for attachment in attachments:
        message.add_attachment(
            SgAttachment(
                FileContent(base64.b64encode(attachment.data).decode("ascii")),
                FileName(attachment.safe_filename()),
                # Bare MIME type. A parameter here is a 400 for the whole
                # message — see `Attachment.provider_type()`.
                FileType(attachment.provider_type()),
                Disposition("attachment"),
            )
        )

    if not track:
        tracking = TrackingSettings()
        tracking.click_tracking = ClickTracking(False, False)
        tracking.open_tracking = OpenTracking(False)
        tracking.subscription_tracking = SubscriptionTracking(False)
        tracking.ganalytics = Ganalytics(False)
        message.tracking_settings = tracking

    max_attempts = (
        max(1, min(int(getattr(settings, "email_max_attempts", 3)), _MAX_ATTEMPTS_CEILING))
        if retry
        else 1
    )
    budget = float(getattr(settings, "email_send_budget_seconds", 30))
    base_delay = max(0.0, float(getattr(settings, "email_retry_base_delay_seconds", 1.0)))
    # Only a test ever sets a host; production always talks to the SDK default.
    host = {"host": _PROVIDER_HOST} if _PROVIDER_HOST else {}
    started = _clock()
    attempt_log: list[dict] = []
    result = ProviderResult(False, error="SendGrid was not called.")
    note = ""

    for attempt in range(1, max_attempts + 1):
        remaining = budget - (_clock() - started)
        timeout = max(1.0, min(float(settings.email_timeout_seconds), remaining))
        failure: BaseException | None = None
        response: Any = None
        try:
            client = SendGridAPIClient(settings.sendgrid_api_key, **host)
            client.client.timeout = timeout
            response = client.send(message)
        except Exception as exc:  # noqa: BLE001 — a transport failure is an outcome
            failure = exc
            result = _from_exception(exc)
        else:
            result = _result_from_response(response)

        verdict = _attempt_class(result.status, failure)
        attempt_log.append(
            {
                "attempt": attempt,
                "status": result.status,
                "error": type(failure).__name__ if failure is not None else None,
                "class": verdict,
            }
        )
        if verdict != "retryable":
            break
        if attempt >= max_attempts:
            if max_attempts > 1:
                note = (
                    f" | Gave up after {attempt} attempts; SendGrid did not take "
                    "the message on any of them."
                )
            break
        delay = base_delay * (2 ** (attempt - 1)) * (1.0 + 0.25 * _jitter())
        asked = _retry_after_seconds(failure if failure is not None else response)
        if asked is not None:
            delay = max(delay, asked)
        if (_clock() - started) + delay + _MIN_ATTEMPT_SECONDS > budget:
            note = (
                f" | Not retried: waiting {delay:.0f} s would leave less than "
                f"{_MIN_ATTEMPT_SECONDS:.0f} s of the {budget:g} s send budget "
                "(EMAIL_SEND_BUDGET_SECONDS). SendGrid did not take the message."
            )
            break
        _sleep(delay)

    result.attempts = len(attempt_log)
    result.attempt_log = attempt_log
    if attempt_log and attempt_log[-1]["class"] == "unknown":
        result.outcome_unknown = True
        note += (
            " | Outcome unknown: SendGrid may have accepted this message before the "
            "answer was lost, so it was deliberately not sent again — a second "
            "attempt could deliver it twice."
        )
    if note and not result.ok:
        result.error = (result.error or "") + note
    return result


# ══════════════════════════════════════════════════════════════════════════════
#  deliver() — the one way anything leaves this system
# ══════════════════════════════════════════════════════════════════════════════

#: Mail that carries a code, a set-password link, or a change to who may sign
#: in. Tracking is off for it: click tracking would route a live reset token
#: through SendGrid's redirect and click logs, an open pixel serves nobody, and
#: an unsubscribe link — if clicked — would make SendGrid suppress every later
#: code sent to that address.
#: Kinds that carry a credential — a code, a set-password link. Identity `auth`.
_CREDENTIAL_KINDS = frozenset({"observer.otp", "staff.invitation"})
#: Kinds that change or report who may sign in. Identity `security`.
_SECURITY_KINDS = frozenset({"staff.access_added", "staff.suspended", "staff.deactivated",
                             "staff.active", "staff.role_changed"})
_SECURITY_KIND_PREFIXES = ("owner_mfa.", "security.")
_AUTH_KINDS = _CREDENTIAL_KINDS | _SECURITY_KINDS
_AUTH_KIND_PREFIXES = _SECURITY_KIND_PREFIXES


def _is_auth_mail(kind: str, sensitivity: Sensitivity | str) -> bool:
    if str(sensitivity) == str(Sensitivity.CREDENTIAL):
        return True
    kind = str(kind or "")
    return kind in _AUTH_KINDS or kind.startswith(_AUTH_KIND_PREFIXES)


def _provider_problem() -> str | None:
    """Why nothing may go out through the configured provider, or None.

    EMAIL_PROVIDER names the one provider this service sends through. Any other
    value — including a deliberate "disabled" — stops every send at the same
    point a missing key does, and is recorded the same way.
    """
    configured = str(getattr(settings, "email_provider", PROVIDER) or "").strip().lower()
    if configured == PROVIDER:
        return None
    return (
        f"EMAIL_PROVIDER is '{configured or '(empty)'}' and '{PROVIDER}' is the only "
        "provider this service sends through, so nothing was delivered. The "
        "record is kept: this is a configuration failure, not an email that was "
        "never owed."
    )


def _attempt_fields(result: ProviderResult) -> dict[str, Any]:
    """The retry evidence a delivery row carries — only when there is any."""
    extra: dict[str, Any] = {}
    if result.outcome_unknown:
        extra["provider_outcome_unknown"] = True
    if result.outcome_unknown or result.attempts > 1:
        extra["provider_attempts"] = [dict(entry) for entry in result.attempt_log]
    return extra


#: Outcomes a sweep may re-attempt. `queued` only once stale (the process died
#: between recording and the answer), and `failed` only when the provider
#: provably did not take the message (`provider_outcome_unknown` unset).
RETRYABLE_OUTCOMES: frozenset[str] = frozenset(
    {str(Outcome.FAILED), str(Outcome.NOT_CONFIGURED), str(Outcome.QUEUED)}
)

#: The sweep runs every fifteen minutes; a retry waits this long after the
#: first failure and twice as long after each later one, up to a day.
_RETRY_BASE_MINUTES = 15
_RETRY_CAP_MINUTES = 24 * 60


def retry_eligibility(row: Mapping[str, Any], *, now: datetime | None = None) -> tuple[bool, str]:
    """May this delivery row be sent again, and if not, why not.

    Pure, so the sweep and the tests agree on the rule:

      * `sent`, `delivered`, a bounce, a withholding — never;
      * `failed` / `not_configured` — yes, unless the provider may already have
        taken it (`provider_outcome_unknown`), which a second send could
        duplicate;
      * `queued` — only once older than EMAIL_STALE_QUEUED_MINUTES;
      * never more than EMAIL_RETRY_MAX_SWEEPS times, and never before
        `retry_after`.
    """
    now = now or _now()
    outcome = str(row.get("outcome") or "")
    if outcome not in RETRYABLE_OUTCOMES:
        return False, f"outcome '{outcome}' is not retryable"
    if row.get("provider_outcome_unknown"):
        return False, "the provider may already have accepted it; a second send could duplicate"
    if outcome == str(Outcome.QUEUED):
        queued_at = row.get("queued_at")
        stale_after = timedelta(minutes=int(getattr(settings, "email_stale_queued_minutes", 30)))
        if not isinstance(queued_at, datetime):
            return False, "queued with no timestamp"
        if queued_at.tzinfo is None:
            queued_at = queued_at.replace(tzinfo=timezone.utc)
        if queued_at > now - stale_after:
            return False, "still queued — the send may be in progress"
    limit = int(getattr(settings, "email_retry_max_sweeps", 6))
    if int(row.get("retry_count") or 0) >= limit:
        return False, f"retried {limit} times already; left for a person"
    after = row.get("retry_after")
    if isinstance(after, datetime):
        if after.tzinfo is None:
            after = after.replace(tzinfo=timezone.utc)
        if after > now:
            return False, f"not due until {when(after)}"
    return True, ""


def _next_retry_at(retry_count: int, now: datetime) -> datetime:
    minutes = min(_RETRY_BASE_MINUTES * (2 ** max(0, retry_count - 1)), _RETRY_CAP_MINUTES)
    return now + timedelta(minutes=minutes)


def _safe_params(values: Mapping[str, Any] | None) -> dict:
    """Only what a retry may store: strings, numbers, booleans, None, and flat
    lists of those (fact rows become `[label, value]` pairs). Never an object,
    never a code — a template that carries a credential is not retryable at all."""
    out: dict[str, Any] = {}
    for key, value in (values or {}).items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[str(key)] = value
        elif isinstance(value, datetime):
            out[str(key)] = value.isoformat()
        elif isinstance(value, (list, tuple)):
            rows = []
            for item in value:
                if isinstance(item, (list, tuple)):
                    rows.append([("" if v is None else str(v)) for v in item])
                elif isinstance(item, (str, int, float, bool)) or item is None:
                    rows.append(item)
            out[str(key)] = rows
    return out


async def deliver(
    *,
    kind: str,
    spec: str,
    recipient: Recipient,
    subject: str,
    html: str,
    sensitivity: Sensitivity | str,
    dedupe_key: str | None = None,
    meta: Mapping[str, Any] | None = None,
    attachments: Sequence[Attachment] = (),
    identity: SenderIdentity | str | None = None,
    unsubscribe: Unsubscribe | None = None,
    retry: Mapping[str, Any] | None = None,
    notice: Mapping[str, Any] | None = None,
) -> dict:
    """Record, gate, send, record the outcome. Returns the delivery row.

    Order matters and is the whole design:

      1. **No address** → recorded as `no_address`. A partner with no email on
         the record is a gap in the record, and it becomes visible here rather
         than being lost as a no-op.
      2. **Role gate** → recorded as `withheld_role`. Checked at the send, so a
         mistake in a recipient list cannot leak a figure.
      3. **Prepare the attachments.** Anything that cannot be sent is left off
         and named in the body — a report that arrives without one CSV is far
         better than a report that does not arrive (see `prepare_attachments`).
      4. **Insert the row**, with the unique `dedupe_key`. A collision means
         this event was already recorded: if that earlier row is a failure a
         sweep may retry (`retry_eligibility`), the same row is sent again in
         place; otherwise nothing is sent twice.
      5. **Send**, off the event loop.
      6. **Close the row** with the provider's message id and status, or with
         the error *and the provider's own words for it*. Either way there is a
         row, and the row says why.

    `identity` names the §12 sender identity. Callers this module owns always
    pass one; a caller that passes none gets `identity_for_kind`, so an MFA
    notice is `security` and a code is `auth` without those files changing.
    Tracking is off for `auth` and `security` whatever the account default is.

    `unsubscribe` marks the message as bulk: it carries `List-Unsubscribe`, a
    `List-Id` and `Auto-Submitted`. Leave it None for transactional mail, which
    must not advertise an unsubscribe it would not honour.

    `retry` is the recipe (`{"template", "params"}`) a sweep re-renders from
    when this send fails; `notice` is `{"userId", "eventKey"}` of the in-app
    notice the email belongs to. Both are stored on the row and nowhere else.

    Raises `DeliveryNotRecorded` only when step 4 fails — in which case nothing
    was sent, deliberately.
    """
    import asyncio

    if identity is None:
        identity = identity_for_kind(kind, sensitivity)
    identity = str(identity)
    tracking = tracking_for(identity, kind, sensitivity)

    attachments = list(attachments)
    doc = _record_doc(
        kind=kind,
        spec=spec,
        recipient=recipient,
        subject=subject,
        sensitivity=str(sensitivity),
        dedupe_key=dedupe_key,
        meta=meta,
        attachments=attachments,
    )
    doc["identity"] = identity
    doc["tracking"] = tracking
    if retry and retry.get("template"):
        doc["retry"] = {"template": str(retry["template"]), "params": _safe_params(retry.get("params"))}
    if notice and notice.get("userId") and notice.get("eventKey"):
        doc["notice"] = {"userId": str(notice["userId"]), "eventKey": str(notice["eventKey"])}

    address = doc["to"]
    if not address or "@" not in address:
        return await _record_only(
            doc,
            Outcome.NO_ADDRESS,
            "No usable email address is on the record for this recipient, so "
            f"'{kind}' could not be delivered. This is a gap in the record, not "
            "a delivery that merely did not happen.",
        )

    allowed, why = may_receive(str(sensitivity), recipient)
    if not allowed:
        log.warning("Withheld '%s' from %s: %s", kind, _masked(address), why)
        return await _record_only(doc, Outcome.WITHHELD_ROLE, why)

    # Every rule about what may be attached is applied here, once, before the
    # message is built — not discovered by the provider rejecting the whole
    # email. A file that cannot be sent is left off *and named in the body*.
    attachments, omitted = prepare_attachments(attachments)
    doc["attachments"] = [a.summary() for a in attachments]
    if omitted:
        doc["attachments_omitted"] = list(omitted)
        doc["meta"]["attachments_omitted"] = [
            f"{o['filename']}: {o['reason']}" for o in omitted
        ]
        html += omission_html(omitted)

    alignment = sender_alignment(identity)
    doc["sender"] = alignment
    if not alignment["aligned"] or not alignment["one_domain"]:
        # Not a failure — the mail still goes — but never silent either. This is
        # the single largest reason mail lands in spam and it is visible on the
        # row that carries it.
        doc["meta"]["sender_not_aligned"] = alignment["why"]

    headers: dict[str, str] = {}
    if unsubscribe is not None:
        headers = bulk_headers(address, unsubscribe)
        doc["bulk"] = True
        doc["meta"]["unsubscribe"] = unsubscribe.summary()
        # The header values themselves carry a per-address token; only the
        # header *names* are recorded, so the record proves the headers were
        # attached without storing a handle anyone could replay from the log.
        doc["headers_sent"] = sorted(headers)
    else:
        doc["bulk"] = False

    text = text_alternative(html)

    record_id, duplicate = await _insert_record(doc)
    resend_of: dict | None = None
    if duplicate:
        # The event was recorded before. If that earlier attempt failed in a
        # way a sweep may retry, this call IS the retry: the same row is sent
        # again in place. Otherwise nothing is sent twice.
        existing, eligible = await _existing_row(dedupe_key)
        if not eligible:
            log.info("'%s' → %s already recorded (dedupe %s).", kind, _masked(address), dedupe_key)
            doc["outcome"] = str(Outcome.DUPLICATE)
            doc["error"] = "Already sent for this event; nothing re-sent."
            doc["existing_outcome"] = str((existing or {}).get("outcome") or "")
            return doc
        resend_of = existing
        record_id = resend_of["_id"]
        doc = {**resend_of, "subject": subject, "identity": identity, "tracking": tracking}
        doc.pop("_id", None)

    doc["id"] = str(record_id)
    attempt_patch = _retry_bookkeeping(resend_of)

    problem = _provider_problem()
    if problem is not None:
        patch = {
            "outcome": str(Outcome.NOT_CONFIGURED),
            "attempts": 1,
            "error": problem,
            **attempt_patch,
        }
        await _close_record(record_id, patch)
        doc.update(patch)
        log.error("Email '%s' to %s not sent — EMAIL_PROVIDER is not '%s'.", kind, _masked(address), PROVIDER)
        return doc

    if not settings.sendgrid_api_key:
        patch = {
            "outcome": str(Outcome.NOT_CONFIGURED),
            "attempts": 1,
            "error": (
                "SENDGRID_API_KEY is not set in this environment, so nothing "
                "was delivered. The record is kept: this is a configuration "
                "failure, not an email that was never owed."
            ),
            **attempt_patch,
        }
        await _close_record(record_id, patch)
        doc.update(patch)
        log.error("Email '%s' to %s not sent — SENDGRID_API_KEY is unset.", kind, _masked(address))
        return doc

    result = await asyncio.to_thread(
        _send_via_provider,
        to_email=address,
        to_name=recipient.name,
        subject=subject,
        html=html,
        attachments=attachments,
        text=text,
        identity=identity,
        headers=headers,
        # Codes, set-password links, access changes and every `auth` /
        # `security` identity go out untracked.
        track=tracking != "off",
        # Bulk mail (reports, broadcasts) keeps exactly one attempt: a broadcast
        # stops on the first 429 by design, and pacing is its job, not ours.
        retry=unsubscribe is None,
    )

    patch: dict[str, Any] = {
        "attempts": result.attempts,
        "provider_status": result.status,
        "provider_message_id": result.message_id,
        # Kept whether or not it failed, so a 202 that later bounces still shows
        # what the provider said at the moment it accepted the message.
        "provider_reason": result.reason or None,
        "provider_headers": result.headers or {},
        **attempt_patch,
    }
    patch.update(_attempt_fields(result))
    if result.ok:
        patch["outcome"] = str(Outcome.SENT)
        patch["sent_at"] = _now()
        patch["error"] = None
        patch["provider_error_body"] = None
        patch["provider_error_fields"] = []
        patch["retry_after"] = None
        log.info("Email '%s' → %s accepted (%s).", kind, _masked(address), result.status)
    else:
        patch["outcome"] = str(Outcome.FAILED)
        patch["error"] = result.error
        # The provider's answer, unedited and on its own field, so nothing that
        # reformats `error` can lose it and nobody has to parse a sentence to
        # get at it. `/tech/email` shows `error`; this is the raw evidence.
        patch["provider_error_body"] = result.body or None
        patch["provider_error_fields"] = list(result.fields)
        log.error(
            "Email '%s' → %s FAILED (HTTP %s)%s: %s",
            kind, _masked(address), result.status,
            f" on {', '.join(result.fields)}" if result.fields else "",
            result.error,
        )

    await _close_record(record_id, patch)
    doc.update(patch)
    return doc


async def _existing_row(dedupe_key: str | None) -> tuple[dict | None, bool]:
    """`(the earlier row for this key, whether it may be sent again now)`."""
    from pymongo.errors import PyMongoError

    if not dedupe_key:
        return None, False
    try:
        existing = await _deliveries().find_one({"dedupe_key": dedupe_key})
    except (PyMongoError, RuntimeError):
        return None, False
    if not existing:
        return None, False
    eligible, _why = retry_eligibility(existing)
    return dict(existing), eligible


def _retry_bookkeeping(resend_of: Mapping[str, Any] | None) -> dict[str, Any]:
    """The retry counters for the patch that closes this attempt.

    A first send schedules its first retry (`retry_after`) in case it fails; a
    re-send counts itself and pushes the next window out. A send that succeeds
    clears `retry_after` in the caller.
    """
    now = _now()
    count = int((resend_of or {}).get("retry_count") or 0) + (1 if resend_of is not None else 0)
    return {
        "retry_count": count,
        "retry_after": _next_retry_at(count + 1, now),
        "last_attempt_at": now,
    }


async def deliver_many(
    recipients: Iterable[Recipient],
    *,
    kind: str,
    spec: str,
    subject: str,
    html: str,
    sensitivity: Sensitivity | str,
    dedupe_prefix: str | None = None,
    meta: Mapping[str, Any] | None = None,
    attachments: Sequence[Attachment] = (),
    identity: SenderIdentity | str = SenderIdentity.TRANSACTIONAL,
    unsubscribe: Unsubscribe | None = None,
) -> list[dict]:
    """The same mail to several people, one delivery row each.

    A dedupe key is per recipient — one person's send failing or being withheld
    never suppresses another's. So is the unsubscribe header: the token in it
    binds to one address, so forwarding the email cannot unsubscribe anyone else.
    """
    out: list[dict] = []
    for recipient in recipients:
        key = (
            f"{dedupe_prefix}:{recipient.email.strip().lower()}"
            if dedupe_prefix
            else None
        )
        out.append(
            await deliver(
                kind=kind,
                spec=spec,
                recipient=recipient,
                subject=subject,
                html=html,
                sensitivity=sensitivity,
                dedupe_key=key,
                meta=meta,
                attachments=attachments,
                identity=identity,
                unsubscribe=unsubscribe,
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Provider events — bounces and drops. 8A.7.5
# ══════════════════════════════════════════════════════════════════════════════

#: SendGrid event name → the outcome it puts the delivery into.
_EVENT_OUTCOME: dict[str, Outcome] = {
    "delivered": Outcome.DELIVERED,
    "bounce": Outcome.BOUNCED,
    "blocked": Outcome.BOUNCED,
    "dropped": Outcome.DROPPED,
    "deferred": Outcome.DEFERRED,
    "spamreport": Outcome.SPAM,
    "unsubscribe": Outcome.UNSUBSCRIBED,
    "group_unsubscribe": Outcome.UNSUBSCRIBED,
}

#: `delivered` never overwrites a later, worse fact.
_TERMINAL = {str(Outcome.BOUNCED), str(Outcome.DROPPED), str(Outcome.SPAM)}


async def record_provider_events(events: Sequence[Mapping[str, Any]]) -> dict:
    """Ingest a SendGrid Event Webhook batch. Spec 8A.7.5 / 8A.2.15.

    A bounce is the difference between "SendGrid accepted it" and "the mailbox
    took it". Without this, a partner whose address is dead looks exactly like a
    partner who was told. Matched on `sg_message_id`, which is the id
    `deliver()` stored when the message was accepted.
    """
    from pymongo.errors import PyMongoError

    matched = 0
    unmatched = 0
    applied: dict[str, int] = {}

    for event in events:
        name = str(event.get("event") or "").lower()
        outcome = _EVENT_OUTCOME.get(name)
        if outcome is None:
            continue

        raw_id = str(event.get("sg_message_id") or "")
        # SendGrid appends a suffix after a dot on webhook ids; the id stored at
        # send time is the part before it.
        message_id = raw_id.split(".")[0] if raw_id else ""
        if not message_id:
            unmatched += 1
            continue

        entry = {
            "event": name,
            "at": _now(),
            "reason": event.get("reason") or event.get("response") or "",
            "email": event.get("email", ""),
            "sg_event_id": event.get("sg_event_id", ""),
        }

        query: dict[str, Any] = {"provider_message_id": {"$regex": f"^{re.escape(message_id)}"}}
        update: dict[str, Any] = {"$push": {"events": entry}}
        if str(outcome) in _TERMINAL or name == "delivered":
            update["$set"] = {"outcome": str(outcome)}
            if str(outcome) in _TERMINAL:
                update["$set"]["error"] = (
                    f"{name}: {entry['reason']}" if entry["reason"] else name
                )
        else:
            update["$set"] = {"last_provider_event": name}

        if name == "delivered":
            # Do not undo a bounce that arrived first.
            query["outcome"] = {"$nin": list(_TERMINAL)}

        try:
            result = await _deliveries().update_one(query, update)
        except (PyMongoError, RuntimeError) as exc:
            log.error("Could not apply provider event %s: %s", name, exc)
            unmatched += 1
            continue

        if result.matched_count:
            matched += 1
            applied[name] = applied.get(name, 0) + 1
        else:
            unmatched += 1

    return {"matched": matched, "unmatched": unmatched, "by_event": applied}


# ══════════════════════════════════════════════════════════════════════════════
#  Visibility — what the CRM shows
# ══════════════════════════════════════════════════════════════════════════════


def _public(doc: Mapping[str, Any]) -> dict:
    out = dict(doc)
    if "_id" in out:
        out["id"] = str(out.pop("_id"))
    return out


async def recent_deliveries(
    *, limit: int = 100, kind: str | None = None, outcome: str | None = None,
    to: str | None = None, since: datetime | None = None,
) -> list[dict]:
    query: dict[str, Any] = {}
    if kind:
        query["kind"] = kind
    if outcome:
        query["outcome"] = outcome
    if to:
        query["to"] = to.strip().lower()
    if since:
        query["queued_at"] = {"$gte": since}

    cursor = _deliveries().find(query).sort("queued_at", -1).limit(max(1, min(limit, 500)))
    return [_public(doc) async for doc in cursor]


async def recent_failures(
    *, limit: int = 100, since: datetime | None = None
) -> list[dict]:
    """Everything an operator has to look at. Spec 8A.2.15."""
    query: dict[str, Any] = {"outcome": {"$in": sorted(FAILURE_OUTCOMES)}}
    if since:
        query["queued_at"] = {"$gte": since}
    cursor = _deliveries().find(query).sort("queued_at", -1).limit(max(1, min(limit, 500)))
    return [_public(doc) async for doc in cursor]


async def delivery_summary(since: datetime) -> dict:
    """Counts by outcome since a moment — the shape of the exception report."""
    pipeline = [
        {"$match": {"queued_at": {"$gte": since}}},
        {"$group": {"_id": "$outcome", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}},
    ]
    by_outcome: dict[str, int] = {}
    async for row in _deliveries().aggregate(pipeline):
        by_outcome[str(row["_id"])] = int(row["n"])
    return {
        "since": since,
        "by_outcome": by_outcome,
        "sent": by_outcome.get(str(Outcome.SENT), 0)
        + by_outcome.get(str(Outcome.DELIVERED), 0),
        "failed": sum(by_outcome.get(o, 0) for o in FAILURE_OUTCOMES),
        "withheld": sum(by_outcome.get(o, 0) for o in WITHHELD_OUTCOMES),
        "in_flight": sum(by_outcome.get(o, 0) for o in TRANSIENT_OUTCOMES),
    }


# ══════════════════════════════════════════════════════════════════════════════
#  The legacy synchronous sends
# ══════════════════════════════════════════════════════════════════════════════
#
# `services/staff.py` and `core/security.py` call these two without awaiting.
# Both are files this module does not own, so the signatures stay: a plain
# function returning bool. They record through pymongo rather than motor, which
# blocks — as the provider call already did before this module existed.

_sync_client = None


def _record_blocking(doc: dict) -> Any:
    """Insert a delivery row from a synchronous caller.

    Returns the inserted id, or raises `DeliveryNotRecorded`. Same rule as the
    async path: no record, no send.
    """
    global _sync_client

    from app.core import isolation
    from app.db.mongo import C
    from pymongo import MongoClient
    from pymongo.errors import DuplicateKeyError, PyMongoError

    try:
        if _sync_client is None:
            # This client bypasses `mongo.connect()`, so it carries the same
            # refusal: outside production, a MongoDB on this machine only. A
            # refusal surfaces as DeliveryNotRecorded — no record, no send.
            isolation.assert_mongo_allowed(settings)
            _sync_client = MongoClient(
                settings.mongo_uri,
                tz_aware=True,
                serverSelectionTimeoutMS=5_000,
            )
        return _sync_client[settings.mongo_db][C.EMAIL_DELIVERIES].insert_one(doc).inserted_id
    except DuplicateKeyError:
        return None
    except (PyMongoError, Exception) as exc:  # noqa: BLE001
        raise DeliveryNotRecorded(
            f"The delivery record for '{doc['kind']}' → {doc['to']} could not be "
            f"written ({exc}), so the email was not sent."
        ) from exc


def _close_blocking(record_id: Any, patch: dict) -> None:
    from app.db.mongo import C

    if record_id is None or _sync_client is None:
        return
    try:
        _sync_client[settings.mongo_db][C.EMAIL_DELIVERIES].update_one(
            {"_id": record_id}, {"$set": patch}
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "Delivery record %s not closed; it stays 'queued' and reads as a "
            "failure, which is correct — the outcome is unknown.",
            record_id,
        )


def _deliver_blocking(
    *, kind: str, spec: str, recipient: Recipient, subject: str, html: str,
    sensitivity: Sensitivity, meta: Mapping[str, Any] | None = None,
    identity: SenderIdentity | str | None = None,
) -> bool:
    if identity is None:
        identity = identity_for_kind(kind, sensitivity)
    identity = str(identity)
    tracking = tracking_for(identity, kind, sensitivity)
    doc = _record_doc(
        kind=kind,
        spec=spec,
        recipient=recipient,
        subject=subject,
        sensitivity=str(sensitivity),
        dedupe_key=None,
        meta=meta,
        attachments=(),
    )
    doc["identity"] = identity
    doc["tracking"] = tracking
    # A code or a set-password link is minted once: never a retry recipe.
    doc["retry"] = None
    if not doc["to"] or "@" not in doc["to"]:
        doc["outcome"] = str(Outcome.NO_ADDRESS)
        doc["error"] = "No usable address on the record."
        _record_blocking(doc)
        return False

    problem = _provider_problem()
    if problem is not None:
        doc["outcome"] = str(Outcome.NOT_CONFIGURED)
        doc["error"] = problem
        _record_blocking(doc)
        log.error("Email '%s' to %s not sent — EMAIL_PROVIDER is not '%s'.", kind, _masked(doc["to"]), PROVIDER)
        return False

    if not settings.sendgrid_api_key:
        doc["outcome"] = str(Outcome.NOT_CONFIGURED)
        doc["error"] = "SENDGRID_API_KEY is not set in this environment."
        _record_blocking(doc)
        log.error("Email '%s' to %s not sent — SENDGRID_API_KEY is unset.", kind, _masked(doc["to"]))
        return False

    record_id = _record_blocking(doc)
    result = _send_via_provider(
        to_email=doc["to"], to_name=recipient.name, subject=subject, html=html,
        attachments=(),
        # A code and a set-password link are `auth`; an access change is
        # `security`. All three leave from no-reply. Never bulk: none carries
        # an unsubscribe, because none is optional mail.
        identity=identity,
        # All three senders here are a code, a set-password link or an access
        # change: untracked. A refusal SendGrid provably did not act on is
        # retried; anything that may have been accepted is not.
        track=tracking != "off",
        retry=True,
    )
    _close_blocking(
        record_id,
        {
            "attempts": result.attempts,
            "provider_status": result.status,
            "provider_message_id": result.message_id,
            "provider_reason": result.reason or None,
            "provider_headers": result.headers or {},
            "provider_error_body": result.body or None,
            "provider_error_fields": list(result.fields),
            "outcome": str(Outcome.SENT if result.ok else Outcome.FAILED),
            "sent_at": _now() if result.ok else None,
            "error": result.error,
            **_attempt_fields(result),
        },
    )
    if result.ok:
        # The same line `deliver()` writes for an accepted message: kind, masked
        # address and the provider's status — never the code or link itself.
        # Without it a delivered code left no trace in the logs at all, and the
        # release check (11-deploy-backend-no-traffic.command) could not confirm
        # that the backend's key works.
        log.info("Email '%s' → %s accepted (%s).", kind, _masked(doc["to"]), result.status)
    else:
        log.error(
            "Email '%s' → %s FAILED (HTTP %s)%s: %s",
            kind, _masked(doc["to"]), result.status,
            f" on {', '.join(result.fields)}" if result.fields else "",
            result.error,
        )
    return result.ok


def send_staff_invitation(
    *, to_email: str, name: str, role_label: str, set_password_link: str,
    invited_by: str,
) -> bool:
    """Welcome a new staff member and let them set their own password. 8A.2.1."""
    body = render(
        "staff_invitation",
        invited_by=invited_by,
        role_label=role_label,
        button=button("Set your password", set_password_link),
    )
    return _deliver_blocking(
        kind="staff.invitation",
        spec="8A.2.1",
        recipient=Recipient(email=to_email, name=name),
        subject=f"You have been added to Zipper as {role_label}",
        html=page(
            title="Welcome to Zipper",
            preheader=f"{invited_by} has added you as {role_label}.",
            body=body,
        ),
        sensitivity=Sensitivity.CREDENTIAL,
        meta={"role_label": role_label},
        identity=SenderIdentity.AUTH,
    )


def send_staff_access_added(
    *, to_email: str, name: str, role_label: str, invited_by: str,
) -> bool:
    """Tell an EXISTING Zipper user that they now have CRM access. 8A.2.2.

    The sibling of [send_staff_invitation], and the difference is the whole
    point: this one carries no link and no credential.

    `invite()` reuses the Firebase account when the address already has one —
    deliberately, because one person is meant to hold one uid carrying their
    password, their Google identity and their phone number. What it used to do
    as well was mail that person a password-reset link, which is a live
    credential for an account they are already using, worded as though the
    account were new. Anyone following the instruction would reset the password
    on their own app login.

    `Sensitivity.OPERATIONAL` rather than `CREDENTIAL`: it carries no link, no
    code and no money figure — only the fact that an internal role was granted,
    to the person it was granted to, who by this point holds the staff row that
    makes them internal.
    """
    body = render(
        "staff_access_added",
        invited_by=invited_by,
        role_label=role_label,
    )
    return _deliver_blocking(
        kind="staff.access_added",
        spec="8A.2.2",
        recipient=Recipient(email=to_email, name=name),
        subject=f"You now have Zipper {role_label} access",
        html=page(
            title="Your Zipper access has changed",
            preheader=f"{invited_by} has added you as {role_label}.",
            body=body,
        ),
        sensitivity=Sensitivity.OPERATIONAL,
        meta={"role_label": role_label},
        identity=SenderIdentity.SECURITY,
    )


def send_observer_otp(code: str, ttl_minutes: int) -> bool:
    """Deliver the observer's one-time login code.

    Sent to the delivery address, which is deliberately a different mailbox from
    the account identity — holding the account is not enough to sign in.
    """
    body = render(
        "observer_otp",
        account_email=settings.observer_email,
        code=code,
        ttl_minutes=ttl_minutes,
    )
    # The code itself is never written to the delivery record. The record proves
    # a code was sent, to whom and when; it is not a place to keep a credential.
    delivered = _deliver_blocking(
        kind="observer.otp",
        spec="2.2",
        recipient=Recipient(email=settings.observer_otp_delivery_email, name="Observer"),
        subject="Your Zipper observer sign-in code",
        html=page(
            title="Zipper — Observer sign-in",
            preheader="Your one-time sign-in code.",
            body=body,
        ),
        sensitivity=Sensitivity.CREDENTIAL,
        meta={"ttl_minutes": ttl_minutes},
        identity=SenderIdentity.AUTH,
    )

    # The code is never written to a log either — in no environment. (A
    # development fallback used to print it when the mail did not go out; a valid
    # sign-in code in a log is a credential in a log.) Tests read the code from
    # the fake provider's captured message instead.
    return delivered


# ══════════════════════════════════════════════════════════════════════════════
#  The transactional catalogue — 8A.2
# ══════════════════════════════════════════════════════════════════════════════
#
# Each builder states its spec number, who it goes to and what triggers it. None
# of them computes a figure: every amount arrives already decided by the ledger,
# a card, or a report.


def _kind_label(kind: str | None) -> str:
    return {
        "agency": "agency",
        "sub_agency": "sub-agency",
        "seller": "coin seller",
    }.get(str(kind or "").lower(), "partner")


def _reference(partner_id: str) -> str:
    return str(partner_id)


async def send_partner_application_received(
    *, recipient: Recipient, partner_id: str, kind: str, applied_at: datetime | None,
) -> dict:
    """8A.2.3 — application received. To: the applicant. Trigger: record created."""
    body = render(
        "partner_received",
        kind_label=_kind_label(kind),
        name=recipient.name or "there",
        facts=facts(
            [
                ("Reference", _reference(partner_id)),
                ("Applied", when(applied_at)),
                ("Account type", _kind_label(kind).title()),
            ]
        ),
    )
    return await deliver(
        kind="partner.application_received",
        spec="8A.2.3",
        recipient=recipient,
        subject=f"We have your Zipper {_kind_label(kind)} application ({_reference(partner_id)})",
        html=page(
            title="Application received",
            preheader=f"Reference {_reference(partner_id)}. We will write either way.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"partner.application_received:{partner_id}",
        meta={"partner_id": partner_id, "kind": kind},
    )


async def send_partner_approved(
    *, recipient: Recipient, partner_id: str, kind: str, approved_at: datetime | None,
) -> dict:
    """8A.2.4 — approved. To: the partner. Trigger: status → approved."""
    body = render(
        "partner_approved",
        kind_label=_kind_label(kind),
        name=recipient.name or "there",
        facts=facts(
            [
                ("Reference", _reference(partner_id)),
                ("Account type", _kind_label(kind).title()),
                ("Approved", when(approved_at)),
            ]
        ),
        button=button("Open your portal", settings.portal_url),
    )
    return await deliver(
        kind="partner.approved",
        spec="8A.2.4",
        recipient=recipient,
        subject=f"Your Zipper {_kind_label(kind)} account is approved",
        html=page(
            title="You are approved",
            preheader="Your account is active. Here is what you get from today.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"partner.approved:{partner_id}:{when(approved_at)}",
        meta={"partner_id": partner_id, "kind": kind},
    )


async def send_partner_rejected(
    *,
    recipient: Recipient,
    partner_id: str,
    kind: str,
    reason: str,
    rejected_at: datetime | None,
    may_reapply: bool = True,
) -> dict:
    """8A.2.5 — rejected, **with the reason**. To: the applicant.

    Trigger: `partner_ops.reject_partner` writes `rejection_reason`, which is
    mandatory on the backend. The reason has always been stored; not sending it
    was the gap. Part 0.1.6 and 0.2.9 — the grounds are written down, and the
    person they are about is the one who gets told.
    """
    reason = (reason or "").strip()
    if not reason:
        # The record says a reason is mandatory. If one is missing, the mail is
        # not sent with an empty box where the grounds should be — the absence
        # is recorded as a failure and somebody fixes the record.
        return await _record_only(
            _record_doc(
                kind="partner.rejected",
                spec="8A.2.5",
                recipient=recipient,
                subject="Rejection notice not sent — no reason on the record",
                sensitivity=str(Sensitivity.PARTNER_OWN),
                dedupe_key=f"partner.rejected.noreason:{partner_id}",
                meta={"partner_id": partner_id},
                attachments=(),
            ),
            Outcome.FAILED,
            "The rejection carries no reason on the record, and a rejection "
            "without its grounds is not sent (8A.2.5 / 0.2.9). Add the reason "
            "to the partner record and the notice goes out on the next sweep.",
        )

    next_steps = (
        "You may reapply once the point above is addressed. A new application "
        "goes into the same queue and is judged on the same published rules — "
        "there is no penalty for having been rejected once."
        if may_reapply
        else "This decision is final for this application, and we are not "
        "accepting a further one at this time. If circumstances change "
        "materially, write to us before applying again."
    )

    body = render(
        "partner_rejected",
        kind_label=_kind_label(kind),
        name=recipient.name or "there",
        reason=reason,
        next_steps=next_steps,
        facts=facts(
            [
                ("Reference", _reference(partner_id)),
                ("Decision", "Not approved"),
                ("Decided", when(rejected_at)),
                ("May reapply", "Yes" if may_reapply else "Not at this time"),
            ]
        ),
    )
    return await deliver(
        kind="partner.rejected",
        spec="8A.2.5",
        recipient=recipient,
        subject=f"Your Zipper {_kind_label(kind)} application was not approved",
        html=page(
            title="Your application was not approved",
            preheader="The reason is in this email, in full.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"partner.rejected:{partner_id}:{when(rejected_at)}",
        meta={"partner_id": partner_id, "kind": kind, "may_reapply": may_reapply},
    )


async def send_account_deactivated(
    *,
    recipient: Recipient,
    partner_id: str,
    kind: str,
    reason: str,
    deactivated_at: datetime | None,
    balance_minor: int | None = None,
    balance_label: str = "Balance held",
) -> dict:
    """8A.2.13 — deactivated, with the reason. To: the account holder.

    Trigger: `partner_ops.deactivate_partner`. 0.2.9 — written grounds, and
    notice. The balance is passed in from the ledger; nothing is computed here.
    """
    reason = (reason or "").strip() or "No reason was recorded on the account."
    body = render(
        "account_deactivated",
        kind_label=_kind_label(kind),
        name=recipient.name or "there",
        reason=reason,
        at=when(deactivated_at),
        facts=facts(
            [
                ("Reference", _reference(partner_id)),
                ("Status", "Deactivated"),
                ("Effective", when(deactivated_at)),
                (balance_label, money(balance_minor) if balance_minor is not None else None),
            ]
        ),
        next_steps=(
            "Reply to this email if you want the decision reviewed. State the "
            "reference above. If you are owed money, it stays owed and is paid "
            "on the published schedule — deactivation does not cancel it."
        ),
    )
    return await deliver(
        kind="partner.deactivated",
        spec="8A.2.13",
        recipient=recipient,
        subject="Your Zipper account has been deactivated",
        html=page(
            title="Your account has been deactivated",
            preheader="The grounds are in this email. Your balance is untouched.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"partner.deactivated:{partner_id}:{when(deactivated_at)}",
        meta={"partner_id": partner_id, "kind": kind},
    )


async def send_payout_approved(
    *,
    recipient: Recipient,
    card_id: str,
    partner_id: str,
    amount_minor: int,
    period_label: str,
    signed_at: datetime | None,
    expected_by: datetime | None = None,
) -> dict:
    """8A.2.7 — payout approved. To: the partner. Amount, period, expected date.

    Trigger: a payout card reaching stage `approved` (signed). The amount is the
    card's own amount — the figure an owner signed, not a re-derivation of it.
    """
    body = render(
        "payout_approved",
        name=recipient.name or "there",
        facts=facts(
            [
                ("Amount approved", money(amount_minor)),
                ("Period", period_label),
                ("Signed off", when(signed_at)),
                ("Expected in your account by", when(expected_by, with_time=False)),
                ("Reference", card_id),
                ("Status", "Authorised — not yet paid"),
            ]
        ),
    )
    return await deliver(
        kind="payout.approved",
        spec="8A.2.7",
        recipient=recipient,
        subject=f"Payout approved — {money(amount_minor)} for {period_label}",
        html=page(
            title="Your payout has been approved",
            preheader=f"{money(amount_minor)} for {period_label}. The receipt follows when it is paid.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"payout.approved:{card_id}",
        meta={
            "card_id": card_id,
            "partner_id": partner_id,
            "amount_minor": amount_minor,
            "currency": "INR",
        },
    )


async def send_payout_paid(
    *,
    recipient: Recipient,
    card_id: str,
    partner_id: str,
    amount_minor: int,
    utr: str,
    paid_at: datetime | None,
    period_label: str = "",
    outstanding_minor: int | None = None,
) -> dict:
    """8A.2.8 — payout paid. To: the partner. **This is their receipt.**

    Trigger: a payout card reaching stage `executed`. The UTR is the bank's own
    reference, taken from the card's execution result. 0.2.3 — every payment
    carries its date and reference.
    """
    utr = (utr or "").strip()
    body = render(
        "payout_paid",
        name=recipient.name or "there",
        amount=money(amount_minor),
        facts=facts(
            [
                ("Amount paid", money(amount_minor)),
                ("UTR / bank reference", utr or "not recorded on the transfer"),
                ("Paid", when(paid_at)),
                ("Period", period_label),
                ("Card reference", card_id),
                (
                    "Still outstanding after this payment",
                    money(outstanding_minor) if outstanding_minor is not None else None,
                ),
            ]
        ),
        next_steps=(
            "Nothing. The money has left our account and this email is your "
            "receipt. Your ledger on the portal shows this payment with the "
            "same reference and the same date."
            if utr
            else "The transfer has been executed but no UTR was recorded "
            "against it. We are retrieving it from the bank and will send it to "
            "you. Do not treat the absence of a UTR as a failed payment — the "
            "money left on the date above."
        ),
    )
    return await deliver(
        kind="payout.paid",
        spec="8A.2.8",
        recipient=recipient,
        subject=f"Payment sent — {money(amount_minor)}"
        + (f" (UTR {utr})" if utr else ""),
        html=page(
            title="Payment sent — your receipt",
            preheader=f"{money(amount_minor)} paid" + (f", UTR {utr}." if utr else "."),
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"payout.paid:{card_id}",
        meta={
            "card_id": card_id,
            "partner_id": partner_id,
            "amount_minor": amount_minor,
            "currency": "INR",
            "utr": utr,
        },
    )


async def send_credit_due(
    *,
    recipient: Recipient,
    seller_id: str,
    outstanding_coins: int,
    due_at: datetime | None,
    days: int,
) -> dict:
    """8A.2.10 — credit due in N days. To: the seller. Amount and due date.

    Trigger: `partners.credit_standing` reports `due_soon`. The outstanding
    figure is the seller's own balance from the partner record.
    """
    day_text = "1 day" if days == 1 else f"{days} days"
    body = render(
        "credit_due",
        name=recipient.name or "there",
        days=day_text,
        facts=facts(
            [
                ("Outstanding", quantity(outstanding_coins, "coins")),
                ("Due", when(due_at, with_time=False)),
                ("Account", seller_id),
                ("Standing today", "Current — not late"),
            ]
        ),
    )
    return await deliver(
        kind="credit.due_soon",
        spec="8A.2.10",
        recipient=recipient,
        subject=f"Your credit falls due in {day_text}",
        html=page(
            title=f"Your credit falls due in {day_text}",
            preheader=f"{outstanding_coins:,} coins outstanding, due {when(due_at, with_time=False)}.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=f"credit.due_soon:{seller_id}:{when(due_at, with_time=False)}",
        meta={"seller_id": seller_id, "outstanding_coins": outstanding_coins},
    )


async def send_credit_overdue_to_seller(
    *,
    recipient: Recipient,
    seller_id: str,
    outstanding_coins: int,
    due_at: datetime | None,
    days_overdue: int,
) -> dict:
    """8A.2.11 (seller half) — credit overdue. To: the seller."""
    day_text = "1 day" if days_overdue == 1 else f"{days_overdue} days"
    body = render(
        "credit_overdue",
        opening=(
            f"{recipient.name or 'Your account'} — your credit passed its due "
            f"date {day_text} ago and is outstanding. The account is blocked "
            "from taking new inventory until it clears."
        ),
        facts=facts(
            [
                ("Outstanding", quantity(outstanding_coins, "coins")),
                ("Was due", when(due_at, with_time=False)),
                ("Overdue by", day_text),
                ("Account", seller_id),
                ("Standing", "Overdue — blocked from new inventory"),
            ]
        ),
        next_steps=(
            "Repay the outstanding amount and the block lifts as soon as the "
            "payment is recorded. If you cannot clear it in full, reply to this "
            "email and say so — a stated plan is treated differently from "
            "silence. Unrepaid credit is recoverable from your balance with the "
            "penalty stated in your terms (9.10), and you get notice before "
            "that happens (0.4.4)."
        ),
        footnote=(
            "This is one email per overdue period, not one per day. Your full "
            "ledger — bought, lent, sold, paid, outstanding — is on the portal."
        ),
    )
    return await deliver(
        kind="credit.overdue.seller",
        spec="8A.2.11",
        recipient=recipient,
        subject=f"Overdue: {outstanding_coins:,} coins, due {when(due_at, with_time=False)}",
        html=page(
            title="Your credit is overdue",
            preheader=f"{outstanding_coins:,} coins, {day_text} past the due date.",
            body=body,
        ),
        sensitivity=Sensitivity.PARTNER_OWN,
        identity=SenderIdentity.TRANSACTIONAL,
        dedupe_key=None,   # repeat suppression handles cadence, not the key
        meta={
            "seller_id": seller_id,
            "outstanding_coins": outstanding_coins,
            "days_overdue": days_overdue,
        },
    )


def build_alert(
    *,
    headline: str,
    spec: str,
    severity: str,
    rows: Sequence[tuple[str, Any]],
    action: str,
    threshold: str,
    threshold_setting: str,
    suppression: str,
    detail_html: str = "",
) -> str:
    """One alert body. Used by `alerts.py` for all of 8A.4."""
    tone = "critical" if severity.lower() == "critical" else "warning"
    bg, border, fg = _TONES[tone]
    return render(
        "alert",
        headline=headline,
        spec=spec,
        severity=severity.upper(),
        tone_bg=bg,
        tone_border=border,
        tone_text=fg,
        facts=facts(rows),
        detail=detail_html,
        action=action,
        threshold=threshold,
        threshold_setting=threshold_setting,
        suppression=suppression,
    )


def build_large_card_notice(
    *,
    rows: Sequence[tuple[str, Any]],
    raised_by: str,
    threshold: str,
    suppression: str,
) -> str:
    """8A.2.12 / 8A.4.4 — a card above the owner-set amount, awaiting signature.

    This one has its own template rather than using `build_alert`, because it is
    not really an exception: it is a request for a decision, addressed to the
    three people who can take it. The wording says what happens next rather than
    what went wrong.
    """
    return render(
        "large_card_awaiting_signature",
        facts=facts(rows),
        raised_by=raised_by,
        threshold=threshold,
        suppression=suppression,
    )


def build_scheduled_report(
    *,
    intro: str,
    bodies: Sequence[str],
    attachment_note: str,
    unsubscribe_note: str,
) -> str:
    """One scheduled email carrying one or more rendered report bodies."""
    return render(
        "scheduled_report",
        intro=intro,
        reports="".join(bodies),
        attachment_note=attachment_note,
        definitions_url=f"{settings.portal_url.rstrip('/')}/api/reports/definitions",
        unsubscribe_note=unsubscribe_note,
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Spec §12 — the template catalogue, one identity and one dedupe key each
# ══════════════════════════════════════════════════════════════════════════════
#
# Every message in §12's list is one entry here: what it is about (`spec`),
# which identity it leaves under, whether it is tracked, whether a sweep may
# re-render it, and how its dedupe key is formed. The wording of the message
# itself arrives in `params` — the same safe `title` / `body` the in-app notice
# shows, plus fact rows — so an email and its notice can never say different
# things, and nothing here needs a new HTML file: the body is built from
# `page`, `callout`, `facts` and `button`.
#
# What a template never carries: a code, a secret, a recovery code, another
# person's contact details, or who on staff took the decision. `_safe_params`
# keeps the retry recipe to plain values, and a template that would have to
# carry a credential (`observer.otp`, `staff.invitation`) is `retryable=False`
# and is not re-rendered by any sweep.


@dataclass(frozen=True)
class Template:
    """One §12 message. `trigger` and `audience` are documentation the check
    script prints; the rest decides how the email is built and sent."""

    name: str
    spec: str
    identity: SenderIdentity
    sensitivity: Sensitivity
    audience: str
    trigger: str
    tone: str = "neutral"
    heading: str = ""
    retryable: bool = True
    #: None → the generic builder (`_notice_body`). A builder returns the inner
    #: HTML; `page()` wraps it.
    build: Callable[[Mapping[str, Any]], str] | None = None

    @property
    def tracking(self) -> str:
        return "off" if str(self.identity) in UNTRACKED_IDENTITIES else "default"


def _t(name: str, spec: str, identity: SenderIdentity, audience: str, trigger: str, *,
       sensitivity: Sensitivity = Sensitivity.PARTNER_OWN, tone: str = "neutral",
       heading: str = "", retryable: bool = True) -> Template:
    return Template(name=name, spec=spec, identity=identity, sensitivity=sensitivity,
                    audience=audience, trigger=trigger, tone=tone, heading=heading,
                    retryable=retryable)


_TX = SenderIdentity.TRANSACTIONAL
_SEC = SenderIdentity.SECURITY

#: name → Template. Order is the order the check script prints them in.
TEMPLATES: dict[str, Template] = {t.name: t for t in (
    # ── auth / security: built by their own senders above; listed so the
    #    identity check and the catalogue tests see them. Never re-rendered.
    _t("observer.otp", "2.2", SenderIdentity.AUTH, "observer",
       "POST /auth/observer/request-code", sensitivity=Sensitivity.CREDENTIAL, retryable=False),
    _t("staff.invitation", "8A.2.1", SenderIdentity.AUTH, "new staff member",
       "staff.invite — set-password link", sensitivity=Sensitivity.CREDENTIAL, retryable=False),
    _t("staff.access_added", "8A.2.2", _SEC, "existing user given CRM access",
       "staff.invite on an existing account", sensitivity=Sensitivity.OPERATIONAL, retryable=False),
    _t("security.notice", "P1-A3", _SEC, "staff / owner",
       "owner_mfa.* and staff.* access changes (classified by kind)",
       sensitivity=Sensitivity.OPERATIONAL),
    # ── partner applications (§12 "partner applications")
    # Agency / sub-agency / seller receipts and approvals are mailed by the
    # Functions triggers (mailLog marker), their rejections by the 8A.2.5 sweep;
    # the backend sends these three for a Host application (one email per event).
    _t("partner.application_received", "8A.2.3", _TX, "applicant",
       "host application submitted (agency/seller: Functions onAgencyRegistered, onSellerRegistered)"),
    _t("partner.approved", "8A.2.4", _TX, "partner",
       "host application approved (agency/seller: Functions onAgencyApproved, onSellerApproved)",
       tone="neutral", heading="Approved"),
    _t("partner.rejected", "8A.2.5", _TX, "applicant",
       "host application rejected (agency/seller: the 8A.2.5 rejection sweep)",
       tone="warning", heading="Not approved"),
    _t("partner.awaiting_verification", "RC D15", _TX, "partner",
       "partner_ops.approve_partner with an unverified contact", tone="warning",
       heading="Verify to start"),
    _t("partner.held", "RC D17", _TX, "partner", "partner_ops: active legacy role paused for verification",
       tone="warning", heading="Role paused"),
    # ── role changes, per role (§12 "role changes")
    _t("role.suspended", "§4", _TX, "role holder",
       "a non-partner role suspended (agency/seller deactivation: the 8A.2.13 sweep)",
       tone="warning", heading="Role suspended"),
    _t("role.resumed", "§4", _TX, "role holder", "partner_ops.reactivate_partner", heading="Role active again"),
    _t("role.revoked", "§4 / C1", _TX, "role holder", "partner_ops.revoke_partner / users.revoke_host",
       tone="critical", heading="Role revoked"),
    _t("agency.host_changed", "§5", _TX, "agency owner",
       "users.revoke_host / restore_host / suspend_host / resume_host — the host's agency is told",
       heading="Your roster changed"),
    # §5 partner role suspension, Host capability: only the role pauses, so it
    # leaves as a role change (transactional), like `role.suspended` — the
    # account itself is untouched (that one is `account.suspended`, security).
    _t("host.suspended", "§5", _TX, "host", "users.suspend_host", tone="warning",
       heading="Host role suspended"),
    _t("host.resumed", "§5", _TX, "host", "users.resume_host / expired host-suspension sweep",
       heading="Host role active again"),
    # ── warning / suspension / ban (§12 "warning/suspension/ban")
    _t("user.warning", "UGP", _TX, "user", "users.warn_user", tone="warning", heading="Official warning"),
    _t("account.suspended", "§5", _SEC, "user", "users.suspend_user", tone="critical",
       heading="Account suspended"),
    _t("account.resumed", "§5", _SEC, "user", "users.resume_user / expired suspension sweep",
       heading="Account active again"),
    _t("account.banned", "§5", _SEC, "user", "users.ban_user", tone="critical", heading="Account banned"),
    _t("account.unbanned", "§5", _SEC, "user", "users.unban_user", heading="Ban lifted"),
    # ── appeals (§12 "appeals")
    _t("appeal.received", "§5", _TX, "appellant", "appeal filed (public form / app)", heading="Appeal received"),
    _t("appeal.recommended", "§5", _TX, "owners", "appeals.recommend_appeal",
       sensitivity=Sensitivity.OPERATIONAL, heading="Decision needed"),
    _t("appeal.decided", "§5", _TX, "appellant", "appeals.decide_appeal", heading="Appeal decided"),
    # ── reinstatement (§12 "appeals" — role reinstatement)
    _t("role_appeal.requested", "C2", _TX, "requester + owners", "role_appeals.submit",
       heading="Reinstatement requested"),
    _t("role_appeal.recommended", "C2", _TX, "owners", "role_appeals.recommend",
       sensitivity=Sensitivity.OPERATIONAL, heading="Decision needed"),
    _t("role_appeal.decided", "C2", _TX, "requester", "role_appeals.decide", heading="Reinstatement decided"),
    # ── transfers (§12 "transfers": source, target, affected person)
    # PARTNER_OWN, not OPERATIONAL: the Host and the two agency owners are
    # external accounts, and OPERATIONAL mail would be withheld from them. The
    # message names one transfer and no business-wide figure.
    _t("transfer.requested", "§6", _TX, "owners + source + target + affected person",
       "transfer_requests.request", heading="Transfer requested"),
    _t("transfer.decided", "§6", _TX, "source + target + affected person",
       "transfer_requests.decide", heading="Transfer decided"),
    # ── recharge / refund (§12 "recharge/refund")
    _t("recharge.approved", "M", _TX, "buyer + seller", "recharges.approve", heading="Recharge approved"),
    _t("recharge.refunded", "M", _TX, "buyer + seller", "recharges.refund", tone="warning",
       heading="Recharge refunded"),
    # ── Owner alert (§12 "Owner alerts")
    _t("owner.money_action", "§8", _TX, "other owners", "owner_mail.notify_other_owners",
       sensitivity=Sensitivity.BUSINESS_MONEY, tone="warning", heading="Owner money action"),
    _t("owner.alert", "§12", _TX, "owners", "role_appeals.email_owners — an Owner alert outside the catalogue",
       sensitivity=Sensitivity.OPERATIONAL, tone="warning", heading="Owner alert"),
    # ── support (§12 "support")
    _t("support.ticket_reply", "WP-D", SenderIdentity.SUPPORT, "ticket author",
       "tickets: a reply on a support / feedback ticket", heading="Zipper replied"),
    # ── department vacancy (§9)
    _t("department.vacancy", "§9", _TX, "owners", "staff: a department loses / regains its Admin",
       sensitivity=Sensitivity.OPERATIONAL, tone="warning", heading="Department"),
)}


def template_dedupe_key(name: str, related_id: str, recipient_key: str = "") -> str:
    """Deterministic: the template, the thing it is about, and — for a fan-out —
    who it went to. A retried business action produces the same key, so the
    unique index on `email_deliveries.dedupe_key` sends it once."""
    key = f"{name}:{str(related_id or '').strip()}"
    if recipient_key:
        key += f":{str(recipient_key).strip()}"
    return key


def _rows_of(value: Any) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for item in value or []:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            out.append((str(item[0]), item[1]))
    return out


def _notice_body(template: Template, params: Mapping[str, Any]) -> str:
    """The generic §12 body: the notice's sentence in a callout, the facts, what
    to do next, a button when there is somewhere to go, and a footnote."""
    body = str(params.get("body") or "")
    parts = [callout(body, template.tone, heading=template.heading)]
    rows = _rows_of(params.get("rows"))
    if rows:
        parts.append(facts(rows))
    if params.get("reason"):
        parts.append(callout(str(params["reason"]), "neutral", heading="Reason"))
    if params.get("next_steps"):
        parts.append(
            '<p style="margin:16px 0 0;line-height:1.6;font-size:14px">'
            + esc(params["next_steps"]) + "</p>"
        )
    if params.get("button_url"):
        parts.append(
            '<p style="margin:18px 0 0">'
            + button(str(params.get("button_label") or "Open Zipper"), str(params["button_url"]))
            + "</p>"
        )
    if params.get("footnote"):
        parts.append(
            '<p style="margin:16px 0 0;font-size:12px;color:#71717a;line-height:1.6">'
            + esc(params["footnote"]) + "</p>"
        )
    return "".join(parts)


@dataclass(slots=True)
class BuiltMessage:
    template: str
    identity: str
    tracking: str
    subject: str
    html: str
    text: str
    dedupe_key: str


def build_template(name: str, params: Mapping[str, Any], *, related_id: str = "",
                   recipient_key: str = "") -> BuiltMessage:
    """Render one catalogue template with `params`. Pure; nothing is sent."""
    template = TEMPLATES.get(str(name))
    if template is None:
        raise TemplateError(f"'{name}' is not a §12 template. Known: {', '.join(sorted(TEMPLATES))}.")
    title = str(params.get("title") or template.heading or "Zipper")
    subject = str(params.get("subject") or title)
    inner = (template.build or (lambda p: _notice_body(template, p)))(params)
    html = page(
        title=title,
        preheader=str(params.get("preheader") or params.get("body") or title)[:180],
        body=inner,
        footer=str(params.get("footer") or (
            "Sent automatically by Zipper. This message was also placed in your "
            "Zipper inbox (Messages → Official)."
        )),
    )
    return BuiltMessage(
        template=template.name,
        identity=str(template.identity),
        tracking=template.tracking,
        subject=subject,
        html=html,
        text=text_alternative(html),
        dedupe_key=template_dedupe_key(template.name, related_id or str(params.get("related_id") or ""),
                                       recipient_key),
    )


async def send_template(
    name: str,
    recipient: Recipient,
    params: Mapping[str, Any],
    *,
    related_id: str = "",
    recipient_key: str = "",
    meta: Mapping[str, Any] | None = None,
    notice: Mapping[str, Any] | None = None,
    dedupe_key: str | None = None,
    kind: str | None = None,
    retry_recipe: bool = True,
) -> dict:
    """Send one catalogue template through `deliver()`. **Never raises.**

    This is the one email path the notice writer and every §12 call site use.
    A failure — a template error, a provider refusal, a database that would
    not take the delivery row — comes back as a dict with `outcome` set, is
    logged without the body, and never reaches the business action that asked
    for it. A provider failure leaves a `failed` row carrying the recipe, and
    `retry_failed()` sends it again on a later sweep.

    `kind` overrides the delivery row's `kind` for callers that filter the log
    by action (`owner_money.card_signed`); `retry_recipe=False` is for a caller
    that runs its own retries (`owner_mail`) and must not be retried twice.
    """
    try:
        built = build_template(name, params, related_id=related_id, recipient_key=recipient_key)
    except Exception as exc:  # noqa: BLE001 — a template bug is a recorded failure
        log.error("Template '%s' could not be built: %s", name, exc)
        return {"outcome": str(Outcome.FAILED), "error": f"template: {exc}", "template": str(name),
                "retryable": False}
    template = TEMPLATES[str(name)]
    related = related_id or str(params.get("related_id") or "")
    try:
        return await deliver(
            kind=kind or template.name,
            spec=template.spec,
            recipient=recipient,
            subject=built.subject,
            html=built.html,
            sensitivity=template.sensitivity,
            dedupe_key=dedupe_key or built.dedupe_key,
            meta={**dict(meta or {}), "template": template.name, "related_id": related},
            identity=template.identity,
            retry=(
                {"template": template.name, "params": {**_safe_params(params), "related_id": related}}
                if template.retryable and retry_recipe else None
            ),
            notice=notice,
        )
    except DeliveryNotRecorded as exc:
        log.error("Template '%s' → %s not recorded, so not sent: %s", name, _masked(recipient.email), exc)
        return {"outcome": "not_recorded", "error": str(exc), "template": template.name, "retryable": False}
    except Exception as exc:  # noqa: BLE001 — the business action stands
        log.exception("Template '%s' → %s failed unexpectedly", name, _masked(recipient.email))
        return {"outcome": str(Outcome.FAILED), "error": f"{type(exc).__name__}: {exc}",
                "template": template.name, "retryable": False}


async def retry_failed(limit: int = 100) -> list[dict]:
    """Re-send every failed, retryable template delivery that is due. Spec §12.

    Run by the transactional sweep. Each row is rebuilt from its own recipe —
    the template name and the safe params it was first built from — and sent
    again through `deliver()`, which recognises the row by its dedupe key and
    sends it in place (`retry_eligibility` decides). Never raises; returns one
    row per attempt in the sweep's vocabulary.
    """
    from pymongo.errors import PyMongoError

    now = _now()
    try:
        cursor = _deliveries().find(
            {"retry.template": {"$exists": True}, "outcome": {"$in": sorted(RETRYABLE_OUTCOMES)}}
        ).sort("queued_at", 1).limit(max(1, min(int(limit), 500)))
        candidates = [row async for row in cursor]
    except (PyMongoError, RuntimeError) as exc:
        log.error("Failed deliveries could not be listed for retry: %s", exc)
        return [{"outcome": str(Outcome.FAILED), "error": f"list: {exc}"}]

    out: list[dict] = []
    for row in candidates:
        eligible, why = retry_eligibility(row, now=now)
        if not eligible:
            out.append({"dedupe_key": row.get("dedupe_key"), "outcome": "not_due", "reason": why})
            continue
        recipe = row.get("retry") or {}
        recipient = Recipient(
            email=str(row.get("to") or ""), name=str(row.get("to_name") or ""),
            role=row.get("to_role"), uid=row.get("to_uid"), authorised_by=row.get("authorised_by"),
        )
        params = dict(recipe.get("params") or {})
        result = await send_template(
            str(recipe.get("template")), recipient, params,
            related_id=str(params.get("related_id") or ""),
            dedupe_key=row.get("dedupe_key"),
            meta=row.get("meta"),
            notice=row.get("notice"),
        )
        state = {"dedupe_key": row.get("dedupe_key"), "template": recipe.get("template"),
                 "outcome": result.get("outcome"), "error": result.get("error")}
        out.append(state)
        notice = row.get("notice") or {}
        if notice.get("userId") and notice.get("eventKey"):
            try:
                from app.services import notices  # local: notices imports this module

                await notices.mark_email_state(
                    str(notice["userId"]), str(notice["eventKey"]),
                    notices.email_state_of(result),
                    error=str(result.get("error") or "")[:300],
                )
            except Exception:  # noqa: BLE001
                log.exception("notice %s: email state not updated after retry", notice.get("eventKey"))
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Previews — 8A.7.3, every template previewable before it goes live
# ══════════════════════════════════════════════════════════════════════════════

_SAMPLE_AT = datetime(2026, 8, 21, 9, 30, tzinfo=timezone.utc)


def _sample_report() -> dict:
    return {
        "report": "cash_position",
        "title": "Cash position",
        "generated_at": _SAMPLE_AT,
        "period": {
            "since": datetime(2026, 8, 14, tzinfo=timezone.utc),
            "until": datetime(2026, 8, 21, tzinfo=timezone.utc),
            "bounds": "[since, until) — start inclusive, end exclusive",
        },
        "rates": {
            "source": "firestore",
            "provisional": False,
            "note": "Rates read from Firestore appConfig/economy.",
        },
        "columns": [
            {"key": "line", "header": "Line"},
            {"key": "channel", "header": "Channel"},
            {"key": "inr_minor", "header": "INR (minor units)"},
        ],
        "rows": [
            {"line": "receipt", "channel": "direct", "inr_minor": 4_500_000},
            {"line": "receipt", "channel": "reseller", "inr_minor": 12_250_000},
        ],
        "totals": {"receipts_inr_minor": 16_750_000, "net_inr_minor": 9_250_000},
        "warnings": [],
        "empty": False,
    }


def preview(name: str) -> tuple[str, str]:
    """Render a template with sample data. Returns (subject, html).

    Nothing is sent, no record is written, no live figure is read.
    """
    samples: dict[str, Any] = {
        "staff_invitation": lambda: (
            "You have been added to Zipper as Finance Admin",
            page(
                title="Welcome to Zipper",
                preheader="Set your password.",
                body=render(
                    "staff_invitation",
                    invited_by="Tanishque",
                    role_label="Finance Admin",
                    button=button("Set your password", settings.portal_url),
                ),
            ),
        ),
        "observer_otp": lambda: (
            "Your Zipper observer sign-in code",
            page(
                title="Zipper — Observer sign-in",
                preheader="Your one-time sign-in code.",
                body=render(
                    "observer_otp",
                    account_email=settings.observer_email,
                    code="418302",
                    ttl_minutes=settings.otp_ttl_minutes,
                ),
            ),
        ),
        "partner_received": lambda: (
            "We have your Zipper agency application (ag_4821)",
            page(
                title="Application received",
                preheader="Reference ag_4821.",
                body=render(
                    "partner_received",
                    kind_label="agency",
                    name="Acme Talent",
                    facts=facts(
                        [("Reference", "ag_4821"), ("Applied", when(_SAMPLE_AT))]
                    ),
                ),
            ),
        ),
        "partner_approved": lambda: (
            "Your Zipper agency account is approved",
            page(
                title="You are approved",
                preheader="Your account is active.",
                body=render(
                    "partner_approved",
                    kind_label="agency",
                    name="Acme Talent",
                    facts=facts(
                        [("Reference", "ag_4821"), ("Approved", when(_SAMPLE_AT))]
                    ),
                    button=button("Open your portal", settings.portal_url),
                ),
            ),
        ),
        "partner_rejected": lambda: (
            "Your Zipper agency application was not approved",
            page(
                title="Your application was not approved",
                preheader="The reason is in this email.",
                body=render(
                    "partner_rejected",
                    kind_label="agency",
                    name="Acme Talent",
                    reason=(
                        "The PAN on the KYC document does not match the name on "
                        "the bank account supplied. Both must be in the same "
                        "legal entity's name before an agency can be paid."
                    ),
                    next_steps=(
                        "You may reapply once the point above is addressed."
                    ),
                    facts=facts(
                        [
                            ("Reference", "ag_4821"),
                            ("Decision", "Not approved"),
                            ("Decided", when(_SAMPLE_AT)),
                            ("May reapply", "Yes"),
                        ]
                    ),
                ),
            ),
        ),
        "account_deactivated": lambda: (
            "Your Zipper account has been deactivated",
            page(
                title="Your account has been deactivated",
                preheader="The grounds are in this email.",
                body=render(
                    "account_deactivated",
                    kind_label="coin seller",
                    name="Ravi Traders",
                    reason="Credit outstanding for 46 days with no repayment plan.",
                    at=when(_SAMPLE_AT),
                    facts=facts([("Reference", "sl_119"), ("Status", "Deactivated")]),
                    next_steps="Reply to this email to have the decision reviewed.",
                ),
            ),
        ),
        "payout_approved": lambda: (
            f"Payout approved — {money(75_00_000)} for 2026-W33",
            page(
                title="Your payout has been approved",
                preheader="Authorised, not yet paid.",
                body=render(
                    "payout_approved",
                    name="Acme Talent",
                    facts=facts(
                        [
                            ("Amount approved", money(75_00_000)),
                            ("Period", "2026-W33"),
                            ("Status", "Authorised — not yet paid"),
                        ]
                    ),
                ),
            ),
        ),
        "payout_paid": lambda: (
            f"Payment sent — {money(75_00_000)} (UTR SBIN226012345678)",
            page(
                title="Payment sent — your receipt",
                preheader="Your receipt.",
                body=render(
                    "payout_paid",
                    name="Acme Talent",
                    amount=money(75_00_000),
                    facts=facts(
                        [
                            ("Amount paid", money(75_00_000)),
                            ("UTR / bank reference", "SBIN226012345678"),
                            ("Paid", when(_SAMPLE_AT)),
                        ]
                    ),
                    next_steps="Nothing. The money has left our account.",
                ),
            ),
        ),
        "credit_due": lambda: (
            "Your credit falls due in 3 days",
            page(
                title="Your credit falls due in 3 days",
                preheader="Reminder, not a demand.",
                body=render(
                    "credit_due",
                    name="Ravi Traders",
                    days="3 days",
                    facts=facts(
                        [
                            ("Outstanding", quantity(250_000, "coins")),
                            ("Due", when(_SAMPLE_AT, with_time=False)),
                        ]
                    ),
                ),
            ),
        ),
        "credit_overdue": lambda: (
            "Overdue: 250,000 coins",
            page(
                title="Your credit is overdue",
                preheader="Past the due date.",
                body=render(
                    "credit_overdue",
                    opening="Your credit passed its due date 6 days ago.",
                    facts=facts(
                        [
                            ("Outstanding", quantity(250_000, "coins")),
                            ("Overdue by", "6 days"),
                        ]
                    ),
                    next_steps="Repay and the block lifts as soon as it is recorded.",
                    footnote="One email per overdue period, not one per day.",
                ),
            ),
        ),
        "large_card_awaiting_signature": lambda: (
            f"Awaiting your signature — {money(250_00_000)}",
            page(
                title="A large card is waiting for a signature",
                preheader="Above your alert threshold.",
                body=render(
                    "large_card_awaiting_signature",
                    facts=facts(
                        [
                            ("Amount", money(250_00_000)),
                            ("Type", "commission_payout"),
                            ("Raised by", "Priya (Finance)"),
                        ]
                    ),
                    raised_by="Priya (Finance)",
                    threshold=money(settings.alert_large_amount_inr * 100),
                    suppression="one email per card",
                ),
            ),
        ),
        "alert": lambda: (
            "Zipper alert — duplicate payment reference",
            page(
                title="Duplicate payment reference",
                preheader="Two cards carry the same bank reference.",
                body=build_alert(
                    headline="Two cards carry the payment reference UTR9931204.",
                    spec="8A.4.3",
                    severity="critical",
                    rows=[
                        ("Payment reference", "UTR9931204"),
                        ("Cards", "2"),
                        ("Combined amount", money(180_00_000)),
                    ],
                    action=(
                        "Confirm with the bank whether one transfer or two "
                        "arrived before either card is executed."
                    ),
                    threshold="any reference appearing on more than one card",
                    threshold_setting="ALERT_DUPLICATE_REF_LOOKBACK_DAYS",
                    suppression="once per reference, re-alerting if a further card appears",
                ),
            ),
        ),
        "scheduled_report": lambda: (
            "Zipper daily business summary — 21 Aug 2026",
            page(
                title="Daily business summary",
                preheader="Cash in, cash out, net position.",
                body=build_scheduled_report(
                    intro="Yesterday's position, generated from the ledger.",
                    bodies=[report_body(_sample_report(), attached="cash_position.csv")],
                    attachment_note="The full table is attached as cash_position.csv.",
                    unsubscribe_note="Ask an owner to turn it off for your address.",
                ),
            ),
        ),
        "scheduled_report_empty": lambda: (
            "Zipper daily business summary — 21 Aug 2026",
            page(
                title="Daily business summary",
                preheader="Nothing moved yesterday.",
                body=build_scheduled_report(
                    intro="Yesterday's position, generated from the ledger.",
                    bodies=[
                        report_body(
                            {
                                **_sample_report(),
                                "empty": True,
                                "rows": [],
                                "warnings": [
                                    "No receipt and no executed payout falls in "
                                    "this period. This is an empty period, not a "
                                    "measured zero."
                                ],
                            },
                            attached="cash_position.csv",
                        )
                    ],
                    attachment_note="The attached CSV says the same.",
                    unsubscribe_note="Ask an owner to turn it off for your address.",
                ),
            ),
        ),
        "scheduled_report_provisional": lambda: (
            "Zipper daily business summary — 21 Aug 2026 (provisional)",
            page(
                title="Daily business summary",
                preheader="Provisional — the rate feed could not be read.",
                body=build_scheduled_report(
                    intro="Yesterday's position, generated from the ledger.",
                    bodies=[
                        report_body(
                            {
                                **_sample_report(),
                                "rates": {
                                    "source": "fallback",
                                    "provisional": True,
                                    "diamond_pack_price_inr_per_lakh": 2390.0,
                                    "diamonds_per_lakh": 100_000,
                                    "bean_to_inr": 0.01,
                                    "missing": [
                                        "diamondPackPriceInr",
                                        "giftRates.beanToInrRate",
                                    ],
                                    "note": (
                                        "PROVISIONAL — the economy configuration "
                                        "could not be read from Firestore."
                                    ),
                                },
                            },
                            attached="cash_position.csv",
                        )
                    ],
                    attachment_note="The attached CSV carries the same rate note.",
                    unsubscribe_note="Ask an owner to turn it off for your address.",
                ),
            ),
        ),
    }

    builder = samples.get(name)
    if builder is None:
        raise TemplateError(
            f"No preview for '{name}'. Available: {', '.join(sorted(samples))}."
        )
    return builder()


PREVIEWABLE: tuple[tuple[str, str, str], ...] = (
    ("staff_invitation", "8A.2.1", "New staff member — set-your-password link"),
    ("observer_otp", "2.2", "Observer sign-in code, to the delivery mailbox"),
    ("partner_received", "8A.2.3", "Applicant — confirmation with reference number"),
    ("partner_approved", "8A.2.4", "Partner — welcome, login link, next steps"),
    ("partner_rejected", "8A.2.5", "Partner — with the reason, and whether they may reapply"),
    ("payout_approved", "8A.2.7", "Partner — amount, period, expected date"),
    ("payout_paid", "8A.2.8", "Partner — amount, UTR, date. Their receipt"),
    ("credit_due", "8A.2.10", "Seller — amount and due date, 3 days out"),
    ("credit_overdue", "8A.2.11", "Seller and the Finance admin"),
    ("large_card_awaiting_signature", "8A.2.12", "All three owners"),
    ("account_deactivated", "8A.2.13", "Account holder, with the reason"),
    ("alert", "8A.4", "An immediate alert, with its threshold and suppression"),
    ("scheduled_report", "8A.3", "A scheduled report with figures"),
    ("scheduled_report_empty", "8A.6.5", "The same report on an empty period — says so, never ₹0"),
    ("scheduled_report_provisional", "8A.6.1", "The same report on fallback rates — says which rate"),
)
