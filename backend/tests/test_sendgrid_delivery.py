"""SendGrid production email — retries, tracking, sender, provider switch, logs.

The real `deliver()`, `_deliver_blocking()` and `_send_via_provider()` run; the
provider is `FakeSendGrid`, scripted one answer per attempt. What is asserted:

  * **a send is repeated only when SendGrid provably did not take it** — a
    connection that never opened (urllib's URLError), a 429 or a 503 — and
    never after one it may have accepted: a timeout, a reset or a dropped answer
    after the request was written, a 500 / 502 / 504. Those are recorded as
    failures with `provider_outcome_unknown`, and the scripted next answer is
    left unconsumed, which proves no second attempt was made;
  * one delivery row per email however many attempts, with the real count in
    `attempts` and the per-attempt classes in `provider_attempts`;
  * the limits: EMAIL_MAX_ATTEMPTS (capped at 5), the 1 s / 2 s waits,
    Retry-After / X-RateLimit-Reset honoured only inside the send budget, and
    no attempt started with less than 5 s of the budget left;
  * **bulk mail keeps exactly one attempt** — reports and broadcasts stop on
    the first refusal, as they always did;
  * click, open, subscription and Google Analytics tracking are OFF for codes,
    set-password links and access changes, and untouched for everything else;
  * EMAIL_PROVIDER other than "sendgrid" sends nothing and records
    `not_configured`, exactly like a missing key;
  * SENDGRID_FROM_EMAIL / SENDGRID_FROM_NAME / SENDGRID_REPLY_TO replace
    MAIL_FROM / MAIL_FROM_NAME / MAIL_FROM_SUPPORT when set;
  * **no sign-in code, set-password link, API key or full recipient address in
    any log record**, with the root logger at DEBUG, in development and in
    production, whether or not the mail went out.

Run:  python3 -m tests.test_sendgrid_delivery
"""

from __future__ import annotations

import asyncio
import http.client
import inspect
import logging
import sys
import time
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs  # noqa: E402

install_stubs()

from app import config as cfg  # noqa: E402
from app.config import settings  # noqa: E402
import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import email as mail  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()

API_KEY = "SG.FAKE-TEST-KEY-0123456789.sendgrid-delivery"
settings.sendgrid_api_key = API_KEY
settings.environment = "test"
settings.mail_from = "no-reply@zipperlive.org"
settings.mail_from_name = "ZIPPER Live"
settings.mail_from_support = ""
settings.support_email = ""
settings.mail_from_transactional = ""
settings.mail_from_bulk = ""
settings.email_provider = "sendgrid"
settings.email_max_attempts = 3
settings.email_retry_base_delay_seconds = 1.0
settings.email_send_budget_seconds = 30
settings.email_timeout_seconds = 20
settings.unsubscribe_url = "https://api.zipper.example/api/notifications/unsubscribe"
settings.unsubscribe_email = "unsubscribe@zipperlive.org"
settings.jwt_secret = "a-test-signing-secret"
# Never the shipped observer defaults: test addresses only.
settings.observer_email = "observer@zipper.example"
settings.observer_otp_delivery_email = "observer-codes@zipper.example"

# ── A clock that only moves when the code under test waits ───────────────────
CLOCK = [1000.0]
SLEEPS: list[float] = []


def _fake_sleep(seconds: float) -> None:
    SLEEPS.append(round(float(seconds), 3))
    CLOCK[0] += float(seconds)


mail._clock = lambda: CLOCK[0]
mail._sleep = _fake_sleep
mail._jitter = lambda: 0.0

# ── Every log record, at DEBUG, from every logger ────────────────────────────


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        text = f"{record.name} {record.levelname} {record.getMessage()}"
        if record.exc_info:
            text += " " + logging.Formatter().formatException(record.exc_info)
        self.lines.append(text)


LOGS = _Capture()
ROOT_LOGGER = logging.getLogger()
ROOT_LOGGER.addHandler(LOGS)
ROOT_LOGGER.setLevel(logging.DEBUG)

# ── The synchronous path's records, in memory (it normally opens its own client)
BLOCKING_ROWS: list[dict] = []


def _record_blocking(doc: dict):
    BLOCKING_ROWS.append(dict(doc))
    return len(BLOCKING_ROWS) - 1


def _close_blocking(record_id, patch: dict) -> None:
    if record_id is not None:
        BLOCKING_ROWS[record_id].update(patch)


mail._record_blocking = _record_blocking  # type: ignore[assignment]
mail._close_blocking = _close_blocking  # type: ignore[assignment]

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def run(coro):
    return asyncio.run(coro)


def rows() -> list[dict]:
    return DB[C.EMAIL_DELIVERIES].docs


def owner(address: str = "owner@example.com") -> mail.Recipient:
    return mail.Recipient(email=address, name="An Owner", role=str(Role.OWNER), uid="u-owner")


def reset_provider() -> None:
    PROVIDER.queue.clear()
    PROVIDER.next_status = 202
    PROVIDER.next_body = b""
    PROVIDER.next_message_id = "msg-ok"
    PROVIDER.next_headers = None
    PROVIDER.raise_on_send = None
    SLEEPS.clear()


_counter = [0]


def send(**overrides) -> dict:
    _counter[0] += 1
    kwargs = dict(
        kind="test.message",
        spec="SG-1",
        recipient=owner(),
        subject="A subject with no secret in it",
        html="<p>body</p>",
        sensitivity=mail.Sensitivity.OPERATIONAL,
        dedupe_key=f"sg-test:{_counter[0]}",
    )
    kwargs.update(overrides)
    return run(mail.deliver(**kwargs))


def rows_for(key: str) -> list[dict]:
    return [r for r in rows() if r.get("dedupe_key") == key]


def everything(value) -> str:
    return repr(value)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Defaults and the provider switch
# ══════════════════════════════════════════════════════════════════════════════

check("EMAIL_PROVIDER ships as sendgrid", cfg.Settings.email_provider, "sendgrid")
check("EMAIL_MAX_ATTEMPTS ships as 3", cfg.Settings.email_max_attempts, 3)
check("the first wait ships as 1 s", cfg.Settings.email_retry_base_delay_seconds, 1.0)
check("the whole send is budgeted at 30 s", cfg.Settings.email_send_budget_seconds, 30)
check("the per-attempt timeout is unchanged at 20 s", cfg.Settings.email_timeout_seconds, 20)
check("SENDGRID_FROM_EMAIL ships empty", cfg.Settings.sendgrid_from_email, "")
check("SENDGRID_REPLY_TO ships empty — no Reply-To is configured", cfg.Settings.sendgrid_reply_to, "")

reset_provider()
before = len(PROVIDER.sent)
settings.email_provider = "disabled"
disabled = send()
settings.email_provider = "sendgrid"
check("EMAIL_PROVIDER=disabled records not_configured", disabled["outcome"], str(mail.Outcome.NOT_CONFIGURED))
ok("…naming EMAIL_PROVIDER", "EMAIL_PROVIDER" in (disabled["error"] or ""))
check("…and SendGrid is never called", len(PROVIDER.sent) - before, 0)
ok("…and the key is not in the row", API_KEY not in everything(disabled))

settings.email_provider = "  SendGrid "
spaced = send()
settings.email_provider = "sendgrid"
check("EMAIL_PROVIDER is compared without case or surrounding spaces", spaced["outcome"], str(mail.Outcome.SENT))

settings.sendgrid_api_key = ""
before = len(PROVIDER.sent)
no_key = send()
settings.sendgrid_api_key = API_KEY
check("no key: not_configured, as before", no_key["outcome"], str(mail.Outcome.NOT_CONFIGURED))
ok("…with the existing wording", "SENDGRID_API_KEY is not set" in (no_key["error"] or ""))
check("…and SendGrid is never called", len(PROVIDER.sent) - before, 0)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Accepted first time
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
before = len(PROVIDER.sent)
accepted = send(dedupe_key="sg:accepted")
check("a 202 is sent", accepted["outcome"], str(mail.Outcome.SENT))
check("…in one attempt", accepted["attempts"], 1)
check("…one row", len(rows_for("sg:accepted")), 1)
check("…one message reached SendGrid", len(PROVIDER.sent) - before, 1)
ok("…and a plain success carries no retry evidence",
   "provider_outcome_unknown" not in accepted and "provider_attempts" not in accepted)
check("the first attempt is given the full per-attempt timeout", PROVIDER.timeouts[-1], 20.0)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Rejected — permanent, never repeated
# ══════════════════════════════════════════════════════════════════════════════

for status, body in (
    (400, b'{"errors":[{"message":"Does not contain a valid address.","field":"personalizations.0.to.0.email"}]}'),
    (401, b'{"errors":[{"message":"The provided authorization grant is invalid, expired, or revoked"}]}'),
    (403, b'{"errors":[{"message":"The from address does not match a verified Sender Identity."}]}'),
):
    reset_provider()
    PROVIDER.queue[:] = [status, 202]
    PROVIDER.next_body = body
    before = len(PROVIDER.sent)
    row = send(dedupe_key=f"sg:perm:{status}")
    check(f"HTTP {status} is a failure", row["outcome"], str(mail.Outcome.FAILED))
    check(f"…in exactly one attempt ({status})", row["attempts"], 1)
    check(f"…the scripted 202 was never used ({status})", PROVIDER.queue, [202])
    check(f"…one message reached SendGrid ({status})", len(PROVIDER.sent) - before, 1)
    ok(f"…keeping SendGrid's words ({status})", body.decode()[20:50] in (row["error"] or ""))
    ok(f"…not marked unknown ({status})", "provider_outcome_unknown" not in row)
    ok(f"…and the key is in no field of the row ({status})", API_KEY not in everything(row))
    check(f"…and no wait ({status})", SLEEPS, [])


# ══════════════════════════════════════════════════════════════════════════════
# 4. Refused unprocessed — retried, one row, one accepted message
# ══════════════════════════════════════════════════════════════════════════════

for status in (429, 503):
    reset_provider()
    PROVIDER.queue[:] = [status, 202]
    before = len(PROVIDER.sent)
    row = send(dedupe_key=f"sg:retry:{status}")
    check(f"{status} then 202 is sent", row["outcome"], str(mail.Outcome.SENT))
    check(f"…in two attempts ({status})", row["attempts"], 2)
    check(f"…one row ({status})", len(rows_for(f"sg:retry:{status}")), 1)
    check(f"…both requests reached SendGrid, only the second was accepted ({status})",
          len(PROVIDER.sent) - before, 2)
    check(f"…each attempt is classified ({status})",
          [(a["status"], a["class"]) for a in row.get("provider_attempts", [])],
          [(status, "retryable"), (202, "accepted")])
    check(f"…after a 1 s wait ({status})", SLEEPS, [1.0])
    ok(f"…and the attempt log holds no address or key ({status})",
       "@" not in everything(row.get("provider_attempts")) and API_KEY not in everything(row))

reset_provider()
PROVIDER.queue[:] = [urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")), 202]
before = len(PROVIDER.sent)
refused = send(dedupe_key="sg:urlerror")
check("a connection that never opened (URLError) is retried and sent", refused["outcome"], str(mail.Outcome.SENT))
check("…in two attempts", refused["attempts"], 2)
check("…and only the second reached SendGrid", len(PROVIDER.sent) - before, 1)
check("…classified as retryable", refused["provider_attempts"][0]["class"], "retryable")
check("…named by its exception class", refused["provider_attempts"][0]["error"], "URLError")

reset_provider()
PROVIDER.queue[:] = [503, 503, 503, 202]
gave_up = send(dedupe_key="sg:gaveup")
check("three refusals: failed", gave_up["outcome"], str(mail.Outcome.FAILED))
check("…after exactly EMAIL_MAX_ATTEMPTS attempts", gave_up["attempts"], 3)
check("…waiting 1 s, then 2 s", SLEEPS, [1.0, 2.0])
check("…leaving the fourth answer unused", PROVIDER.queue, [202])
ok("…and saying it gave up", "Gave up after 3 attempts" in (gave_up["error"] or ""))
ok("…which is not an unknown outcome — SendGrid refused every one", "provider_outcome_unknown" not in gave_up)

reset_provider()
settings.email_max_attempts = 1
PROVIDER.queue[:] = [503, 202]
single = send(dedupe_key="sg:max1")
settings.email_max_attempts = 3
check("EMAIL_MAX_ATTEMPTS=1 means one attempt", single["attempts"], 1)
check("…and the 202 is left unused", PROVIDER.queue, [202])

reset_provider()
settings.email_max_attempts = 99
settings.email_send_budget_seconds = 1000
PROVIDER.queue[:] = [503] * 7
capped = send(dedupe_key="sg:cap")
settings.email_max_attempts = 3
settings.email_send_budget_seconds = 30
check("EMAIL_MAX_ATTEMPTS is capped at 5", capped["attempts"], 5)
PROVIDER.queue.clear()


# ══════════════════════════════════════════════════════════════════════════════
# 5. Retry-After, X-RateLimit-Reset and the send budget
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
PROVIDER.queue[:] = [429, 202]
PROVIDER.next_headers = {"Retry-After": "3"}
asked = send(dedupe_key="sg:retry-after")
check("a 429 asking for 3 s is retried after 3 s", SLEEPS, [3.0])
check("…and sent", asked["outcome"], str(mail.Outcome.SENT))

reset_provider()
PROVIDER.queue[:] = [429, 202]
PROVIDER.next_headers = {"Retry-After": "120"}
too_long = send(dedupe_key="sg:retry-after-long")
check("a 429 asking for 120 s is not retried inside a 30 s budget", too_long["attempts"], 1)
check("…no wait at all", SLEEPS, [])
ok("…and the row says why", "Not retried" in (too_long["error"] or ""))
check("…still a plain failure, not unknown", "provider_outcome_unknown" in too_long, False)

reset_provider()
PROVIDER.queue[:] = [429, 202]
PROVIDER.next_headers = {"X-RateLimit-Reset": str(int(time.time()) + 600)}
reset_far = send(dedupe_key="sg:ratelimit-reset")
check("X-RateLimit-Reset ten minutes away is not waited for", reset_far["attempts"], 1)

reset_provider()
settings.email_send_budget_seconds = 5.5
PROVIDER.queue[:] = [503, 202]
tight = send(dedupe_key="sg:budget")
check("no attempt starts with less than 5 s of the budget left", tight["attempts"], 1)
check("…so the first attempt is given what the budget allows", PROVIDER.timeouts[-1], 5.5)
settings.email_send_budget_seconds = 30


# ══════════════════════════════════════════════════════════════════════════════
# 6. May have been accepted — NEVER repeated
# ══════════════════════════════════════════════════════════════════════════════

for label, first in (
    ("TimeoutError", TimeoutError("timed out")),
    ("ConnectionResetError", ConnectionResetError(104, "Connection reset by peer")),
    ("RemoteDisconnected", http.client.RemoteDisconnected("Remote end closed connection without response")),
    ("HTTP 500", 500),
    ("HTTP 502", 502),
    ("HTTP 504", 504),
):
    reset_provider()
    PROVIDER.queue[:] = [first, 202]
    row = send(dedupe_key=f"sg:unknown:{label}")
    check(f"{label}: recorded as a failure", row["outcome"], str(mail.Outcome.FAILED))
    check(f"{label}: exactly one attempt", row["attempts"], 1)
    check(f"{label}: the scripted 202 was never used — no second send", PROVIDER.queue, [202])
    check(f"{label}: marked outcome-unknown", row.get("provider_outcome_unknown"), True)
    check(f"{label}: one attempt in the log, classified unknown",
          [a["class"] for a in row.get("provider_attempts", [])], ["unknown"])
    ok(f"{label}: the row says it may have arrived and was not re-sent",
       "Outcome unknown" in (row["error"] or "") and "not sent again" in (row["error"] or ""))
    check(f"{label}: no wait", SLEEPS, [])


# ══════════════════════════════════════════════════════════════════════════════
# 7. Bulk mail keeps exactly one attempt
# ══════════════════════════════════════════════════════════════════════════════

for label, first in (
    ("429", 429),
    ("503", 503),
    ("URLError", urllib.error.URLError("no route to host")),
):
    reset_provider()
    PROVIDER.queue[:] = [first, 202]
    row = send(
        dedupe_key=f"sg:bulk:{label}",
        identity=mail.SenderIdentity.BULK,
        unsubscribe=mail.Unsubscribe(report="daily_business_summary", cadence="daily"),
    )
    check(f"bulk {label}: one attempt", row["attempts"], 1)
    check(f"bulk {label}: failed, as it always was", row["outcome"], str(mail.Outcome.FAILED))
    check(f"bulk {label}: the 202 is left unused", PROVIDER.queue, [202])

reset_provider()
PROVIDER.next_status = 429
before = len(PROVIDER.sent)
batch = run(
    mail.deliver_many(
        [owner("a1@example.com"), owner("a2@example.com"), owner("a3@example.com")],
        kind="report.daily_business_summary",
        spec="SG-7",
        subject="Daily summary",
        html="<p>figures</p>",
        sensitivity=mail.Sensitivity.OPERATIONAL,
        dedupe_prefix="sg:many",
        identity=mail.SenderIdentity.BULK,
        unsubscribe=mail.Unsubscribe(report="daily_business_summary", cadence="daily"),
    )
)
check("a throttled bulk batch makes one call per recipient", len(PROVIDER.sent) - before, 3)
check("…every row says 429, so a broadcast still stops on it",
      [r["provider_status"] for r in batch], [429, 429, 429])
check("…with no wait anywhere", SLEEPS, [])


# ══════════════════════════════════════════════════════════════════════════════
# 8. Tracking: off for codes, set-password links and access changes
# ══════════════════════════════════════════════════════════════════════════════


def tracking_off(tracking) -> bool:
    return (
        tracking is not None
        and tracking.click_tracking.enable is False
        and tracking.click_tracking.enable_text is False
        and tracking.open_tracking.enable is False
        and tracking.subscription_tracking.enable is False
        and tracking.ganalytics.enable is False
    )


reset_provider()
CODE = "842913"
delivered = mail.send_observer_otp(CODE, 10)
check("the observer code is delivered", delivered, True)
ok("…untracked: click, text-click, open, subscription and GA all off",
   tracking_off(PROVIDER.sent[-1]["tracking"]))
ok("…the code is in the message", CODE in PROVIDER.sent[-1]["html"] and CODE in PROVIDER.sent[-1]["text"])
check("…sent to the delivery mailbox", PROVIDER.sent[-1]["to"], "observer-codes@zipper.example")
ok("…and the code is not on the delivery row", CODE not in everything(BLOCKING_ROWS[-1]))
check("…whose attempts are counted", BLOCKING_ROWS[-1]["attempts"], 1)

reset_provider()
LINK = "https://zipper.example/__/auth/action?mode=resetPassword&oobCode=LINK-TOKEN-7731"
invited = mail.send_staff_invitation(
    to_email="new.staff@example.com", name="New Staff", role_label="Finance Admin",
    set_password_link=LINK, invited_by="An Owner",
)
check("a staff invitation is delivered", invited, True)
ok("…untracked, so the set-password link is never rewritten through a redirect",
   tracking_off(PROVIDER.sent[-1]["tracking"]))
ok("…the link is in the body", "LINK-TOKEN-7731" in PROVIDER.sent[-1]["html"])
ok("…and not on the row", "LINK-TOKEN-7731" not in everything(BLOCKING_ROWS[-1]))

reset_provider()
added = mail.send_staff_access_added(
    to_email="existing.staff@example.com", name="Existing", role_label="Support Admin",
    invited_by="An Owner",
)
check("staff access added is delivered", added, True)
ok("…untracked", tracking_off(PROVIDER.sent[-1]["tracking"]))

reset_provider()
mfa_row = send(kind="owner_mfa.reset", dedupe_key="sg:mfa")
check("an Owner MFA notice is sent", mfa_row["outcome"], str(mail.Outcome.SENT))
ok("…untracked", tracking_off(PROVIDER.sent[-1]["tracking"]))

reset_provider()
cred_row = send(kind="test.some_credential", sensitivity=mail.Sensitivity.CREDENTIAL, dedupe_key="sg:cred")
check("any CREDENTIAL mail is sent", cred_row["outcome"], str(mail.Outcome.SENT))
ok("…untracked", tracking_off(PROVIDER.sent[-1]["tracking"]))

reset_provider()
notice = send(kind="partner.approved", dedupe_key="sg:notice")
check("a partner notice is sent", notice["outcome"], str(mail.Outcome.SENT))
check("…with tracking left to the account default", PROVIDER.sent[-1]["tracking"], None)

reset_provider()
report = send(
    kind="report.weekly_business", dedupe_key="sg:report",
    identity=mail.SenderIdentity.BULK,
    unsubscribe=mail.Unsubscribe(report="weekly_business", cadence="weekly"),
)
check("a report is sent", report["outcome"], str(mail.Outcome.SENT))
check("…with tracking left to the account default", PROVIDER.sent[-1]["tracking"], None)

check("_is_auth_mail: observer.otp", mail._is_auth_mail("observer.otp", mail.Sensitivity.CREDENTIAL), True)
check("_is_auth_mail: staff.access_added (operational)",
      mail._is_auth_mail("staff.access_added", mail.Sensitivity.OPERATIONAL), True)
check("_is_auth_mail: owner_mfa.enrolled", mail._is_auth_mail("owner_mfa.enrolled", "operational"), True)
check("_is_auth_mail: payout.paid", mail._is_auth_mail("payout.paid", mail.Sensitivity.PARTNER_OWN), False)


# ══════════════════════════════════════════════════════════════════════════════
# 9. The sender: SENDGRID_* names over MAIL_* names
# ══════════════════════════════════════════════════════════════════════════════

s = cfg.Settings(
    mail_from="old@zipper.example", mail_from_name="Zipper", mail_from_support="",
    sendgrid_from_email="  no-reply@zipperlive.org ", sendgrid_from_name="ZIPPER Live",
    sendgrid_reply_to="",
)
cfg.apply_sendgrid_names(s)
check("SENDGRID_FROM_EMAIL replaces MAIL_FROM (trimmed)", s.mail_from, "no-reply@zipperlive.org")
check("SENDGRID_FROM_NAME replaces MAIL_FROM_NAME", s.mail_from_name, "ZIPPER Live")
check("an empty SENDGRID_REPLY_TO leaves MAIL_FROM_SUPPORT alone", s.mail_from_support, "")

s = cfg.Settings(mail_from="old@zipper.example", mail_from_name="Zipper", mail_from_support="help@zipper.example",
                 sendgrid_from_email="", sendgrid_from_name="", sendgrid_reply_to="")
cfg.apply_sendgrid_names(s)
check("with no SENDGRID_* names, MAIL_FROM stays in charge", s.mail_from, "old@zipper.example")
check("…and MAIL_FROM_NAME", s.mail_from_name, "Zipper")
check("…and MAIL_FROM_SUPPORT", s.mail_from_support, "help@zipper.example")

s = cfg.Settings(mail_from_support="", sendgrid_reply_to="support@zipperlive.org")
cfg.apply_sendgrid_names(s)
check("SENDGRID_REPLY_TO, once set, becomes MAIL_FROM_SUPPORT", s.mail_from_support, "support@zipperlive.org")

source = inspect.getsource(getattr(cfg.get_settings, "__wrapped__", cfg.get_settings))
ok("get_settings() applies the SENDGRID_* names before anything reads the sender",
   "apply_sendgrid_names(s)" in source
   and source.index("apply_sendgrid_names(s)") < source.index("disable_outbound_email_outside_production"))

reset_provider()
from_row = send(dedupe_key="sg:from")
check("mail leaves from no-reply@zipperlive.org", PROVIDER.sent[-1]["from"], "no-reply@zipperlive.org")
check("…with no support@ Reply-To: it falls back to the From address", PROVIDER.sent[-1]["reply_to"],
      "no-reply@zipperlive.org")
check("…and the row records the aligned sender", from_row["sender"]["from"], "no-reply@zipperlive.org")
check("…on one domain", from_row["sender"]["domain"], "zipperlive.org")


# ══════════════════════════════════════════════════════════════════════════════
# 10. Logs: no code, no link, no key, no full address
# ══════════════════════════════════════════════════════════════════════════════

CODES = iter(["731905", "640218", "557302", "918264", "302719", "476150", "829043", "165387"])
for environment in ("development", "production"):
    settings.environment = environment
    for case, script in (
        ("delivered", [202]),
        ("rejected", [403]),
        ("timed out", [TimeoutError("timed out")]),
        ("refused then delivered", [503, 202]),
    ):
        reset_provider()
        code = next(CODES)
        PROVIDER.queue[:] = list(script)
        mail.send_observer_otp(code, 10)
        ok(f"{environment} / {case}: the observer code is in no log record",
           not any(code in line for line in LOGS.lines))
    # No key at all — the path that used to print the code outside production.
    reset_provider()
    settings.sendgrid_api_key = ""
    code = "593108"
    result = mail.send_observer_otp(code, 10)
    settings.sendgrid_api_key = API_KEY
    check(f"{environment} / no key: not delivered", result, False)
    ok(f"{environment} / no key: the code is STILL in no log record",
       not any(code in line for line in LOGS.lines))
settings.environment = "test"

ok("the staff set-password link is in no log record", not any("LINK-TOKEN-7731" in line for line in LOGS.lines))
ok("the API key is in no log record", not any(API_KEY in line for line in LOGS.lines))
ok("a full recipient address is in no log record",
   not any(a in line for line in LOGS.lines
           for a in ("owner@example.com", "observer-codes@zipper.example", "new.staff@example.com")))
ok("…while failures are still logged, masked to ***@domain",
   any("***@example.com" in line and "FAILED" in line for line in LOGS.lines))
check("python_http_client is pinned at WARNING", logging.getLogger("python_http_client").level, logging.WARNING)
ok("…so its request/headers DEBUG lines cannot be emitted even with the root at DEBUG",
   logging.getLogger("python_http_client.client").getEffectiveLevel() >= logging.WARNING
   and ROOT_LOGGER.level == logging.DEBUG)
check("the masking helper", mail._masked("Someone.Else@Example.COM"), "***@example.com")


# ══════════════════════════════════════════════════════════════════════════════

ROOT_LOGGER.removeHandler(LOGS)

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} SendGrid delivery checks passed.")
print("  · retried only after URLError / 429 / 503 — never after a timeout, reset or 500/502/504")
print("  · one row per email; attempts and per-attempt classes recorded; outcome-unknown flagged")
print("  · max attempts (capped at 5), 1 s / 2 s waits, Retry-After and the send budget respected")
print("  · bulk mail keeps one attempt; a throttled batch still stops on its 429s")
print("  · tracking off for codes, set-password links, access changes and any CREDENTIAL mail")
print("  · EMAIL_PROVIDER other than sendgrid sends nothing; SENDGRID_* names override MAIL_*")
print("  · no code, link, key or full address in any log record, at DEBUG, in dev and production")
sys.exit(0)
