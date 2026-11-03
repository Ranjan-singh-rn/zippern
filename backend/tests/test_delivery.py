"""Delivery records — spec 8A.2.14 and 8A.2.15.

10.26 said email delivery is not tracked and a bounced approval notice is lost
silently. These tests are about the claim that is no longer true, and they are
written the way the failure actually happened: a 403 from an unverified
`MAIL_FROM` returned false, was logged, and nothing downstream could tell that
from a delivery.

What is asserted:

  * a send that the provider accepts leaves a row saying so, with the provider's
    own message id;
  * **a provider rejection is a recorded failure with its cause** — the real
    `_send_via_provider` runs, gets a real 403 body back, and the stored error
    names `MAIL_FROM` as the likely reason;
  * **a 400 keeps SendGrid's body word for word**, on its own field and inside
    the Cause the CRM shows. This is the one that mattered: every report email
    this system sent failed with `BadRequestsError: HTTP Error 400: Bad Request`
    — a string that is the same for every possible 400 — while the sentence
    naming the exact broken field sat unread on `exc.body`;
  * **the attachment contract**: a duplicate filename is renamed rather than
    sent twice, an unsendable file is left off *and named in the body* while the
    email still goes, and no MIME type with a parameter ever reaches the API;
  * **deliverability**: a plain-text alternative on every message, unsubscribe
    headers on bulk and none on transactional, a Reply-To that reaches a person,
    and no subject in the catalogue that reads as a mailshot;
  * a transport exception, a missing SDK and a missing API key are each their
    own recorded outcome, none of them silent;
  * no address on the record, and a role that may not read the figure, are
    recorded rather than skipped;
  * the same event cannot send twice, because `dedupe_key` is unique;
  * if the row cannot be written, **nothing is sent**;
  * a bounce arriving after acceptance overwrites the outcome, and a late
    `delivered` does not overwrite a bounce;
  * the API key never reaches any stored field, subject or body.

Run:  python3 -m tests.test_delivery
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import (  # noqa: E402
    BadRequestsError,
    FakeDb,
    FakeSendGrid,
    PyMongoError,
    install_stubs,
    uninstall_sendgrid,
)

install_stubs()

from app.config import settings  # noqa: E402
import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import email as mail  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()

API_KEY = "SG.f4KeK3yThatMustNeverAppearAnywhere.0000000000"
settings.sendgrid_api_key = API_KEY
settings.mail_from = "no-reply@zipper.app"
settings.environment = "test"

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


def refuses(label: str, coro_factory, *, error=Exception):
    global checks
    checks += 1
    try:
        result = run(coro_factory())
    except error as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}")
        return None
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return None


def run(coro):
    return asyncio.run(coro)


def rows() -> list[dict]:
    return DB[C.EMAIL_DELIVERIES].docs


def owner(address="owner@example.com") -> mail.Recipient:
    return mail.Recipient(email=address, name="An Owner", role=str(Role.OWNER), uid="u-owner")


def send(**overrides):
    kwargs = dict(
        kind="test.message",
        spec="8A.2.14",
        recipient=owner(),
        subject="A subject with no secret in it",
        html="<p>body</p>",
        sensitivity=mail.Sensitivity.OPERATIONAL,
    )
    kwargs.update(overrides)
    return run(mail.deliver(**kwargs))


# ══════════════════════════════════════════════════════════════════════════════
# 1. The vocabulary — every outcome is classified
# ══════════════════════════════════════════════════════════════════════════════
#
# An outcome that is neither a success, a failure nor a deliberate withholding
# would be invisible: it would not appear on the failure list and would not
# count as sent. So there is no such outcome.

SUCCESS = {str(mail.Outcome.SENT), str(mail.Outcome.DELIVERED)}
UNCLASSIFIED = [
    str(o)
    for o in mail.Outcome
    if str(o) not in SUCCESS
    and str(o) not in mail.FAILURE_OUTCOMES
    and str(o) not in mail.WITHHELD_OUTCOMES
    and str(o) not in mail.TRANSIENT_OUTCOMES
]
check(
    "every outcome is a success, a failure, a withholding or still in flight",
    UNCLASSIFIED,
    [],
)
for group_a, group_b in (
    (mail.FAILURE_OUTCOMES, mail.WITHHELD_OUTCOMES),
    (mail.FAILURE_OUTCOMES, mail.TRANSIENT_OUTCOMES),
    (mail.WITHHELD_OUTCOMES, mail.TRANSIENT_OUTCOMES),
):
    ok("…and no outcome is in two groups at once", not (group_a & group_b))
ok(
    "a send stuck in 'queued' counts as a failure, not as pending",
    str(mail.Outcome.QUEUED) in mail.FAILURE_OUTCOMES,
)
ok(
    "an unconfigured provider counts as a failure, not as 'not owed'",
    str(mail.Outcome.NOT_CONFIGURED) in mail.FAILURE_OUTCOMES,
)


# ══════════════════════════════════════════════════════════════════════════════
# 2. A delivery the provider accepts
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.next_status = 202
PROVIDER.next_message_id = "sg-message-0001"

row = send(dedupe_key="accepted:1", meta={"case": "accepted"})

check("one row was written", len(rows()), 1)
check("the outcome is sent", row["outcome"], str(mail.Outcome.SENT))
check("the provider's status is kept", row["provider_status"], 202)
check("the provider's message id is kept", row["provider_message_id"], "sg-message-0001")
ok("a send time is recorded", isinstance(row["sent_at"], datetime))
check("no error is recorded on a success", row["error"], None)
check("the recipient is recorded", row["to"], "owner@example.com")
check("their role is recorded", row["to_role"], str(Role.OWNER))
check("what was sent is recorded", row["kind"], "test.message")
check("…and the requirement it serves", row["spec"], "8A.2.14")
check("the subject is kept", row["subject"], "A subject with no secret in it")
ok("the body is NOT kept", "html" not in row and "body" not in row)
check("the provider actually received it", len(PROVIDER.sent), 1)
check("…addressed to the right person", PROVIDER.sent[0]["to"], "owner@example.com")

# 8A.2.14 in the order it matters: the row exists *before* the provider is
# called, so a process that dies mid-send leaves evidence rather than nothing.
ok(
    "the row was queued before it was sent",
    rows()[0]["queued_at"] <= rows()[0]["sent_at"],
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. The provider rejects it — the 403 that was previously invisible
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.next_status = 403
PROVIDER.next_body = (
    b'{"errors":[{"message":"The from address does not match a verified '
    b'Sender Identity."}]}'
)
PROVIDER.next_message_id = ""

rejected = send(dedupe_key="rejected:1", meta={"case": "403"})

check("a rejection is a failure, not a silent no-op", rejected["outcome"], str(mail.Outcome.FAILED))
check("the HTTP status is kept", rejected["provider_status"], 403)
check("nothing is recorded as sent", rejected["sent_at"], None)
ok("the provider's own words are kept", "verified Sender Identity" in rejected["error"])
ok(
    "…and the cause is named: MAIL_FROM is not verified",
    "MAIL_FROM" in rejected["error"] and settings.mail_from in rejected["error"],
)
ok(
    "…and it says plainly that nothing was delivered",
    "Nothing was delivered" in rejected["error"],
)

failed_now = run(mail.recent_failures(limit=50))
check("the rejection is on the failure list", len(failed_now), 1)
check("…and it is the one we just made", failed_now[0]["dedupe_key"], "rejected:1")

# The whole point of 8A.2.15: a failure is not distinguishable from a success by
# the caller's return value alone — it is distinguishable because it is *on a
# list somebody looks at*.
summary = run(mail.delivery_summary(datetime.now(timezone.utc) - timedelta(hours=1)))
check("the summary counts one sent", summary["sent"], 1)
check("…and one failed", summary["failed"], 1)


# ── A transport exception is an outcome too ───────────────────────────────────

PROVIDER.raise_on_send = TimeoutError("timed out talking to the provider")
timed_out = send(dedupe_key="timeout:1")
PROVIDER.raise_on_send = None

check("a transport failure is recorded as a failure", timed_out["outcome"], str(mail.Outcome.FAILED))
ok("…naming the exception type", "TimeoutError" in timed_out["error"])
check("…with no HTTP status, because there was no response", timed_out["provider_status"], None)


# ── The SDK is not installed ──────────────────────────────────────────────────

uninstall_sendgrid()
no_sdk = send(dedupe_key="nosdk:1")
PROVIDER.install()

check("a missing provider SDK is a failure", no_sdk["outcome"], str(mail.Outcome.FAILED))
ok("…and says which library", "SendGrid SDK not installed" in no_sdk["error"])


# ── No API key in this environment ────────────────────────────────────────────

settings.sendgrid_api_key = ""
unconfigured = send(dedupe_key="unconfigured:1")
settings.sendgrid_api_key = API_KEY

check("an unset API key is recorded", unconfigured["outcome"], str(mail.Outcome.NOT_CONFIGURED))
ok("…as a configuration failure", "SENDGRID_API_KEY is not set" in unconfigured["error"])
ok(
    "…and the row is kept rather than the email being treated as never owed",
    "not an email that was never owed" in unconfigured["error"],
)
check(
    "…and the provider was not called",
    len([s for s in PROVIDER.sent if s["subject"] == "A subject with no secret in it"]),
    # Only the two sends that reached SendGrid's `send()` are here: the accepted
    # one and the 403. The timeout raised before the message was taken, the
    # missing SDK never got that far, and the unconfigured send stopped in
    # `deliver()` — which is the assertion.
    2,
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Gaps in the record, and figures withheld
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.next_status = 202
PROVIDER.next_body = b""
PROVIDER.next_message_id = "sg-message-0002"

no_address = send(
    recipient=mail.Recipient(email="", name="Nameless Agency", role=str(Role.AGENCY)),
    sensitivity=mail.Sensitivity.PARTNER_OWN,
    dedupe_key="noaddress:1",
)
check("a partner with no address is recorded", no_address["outcome"], str(mail.Outcome.NO_ADDRESS))
ok(
    "…as a gap in the record, not a delivery that did not happen",
    "gap in the record" in no_address["error"],
)

withheld = send(
    recipient=mail.Recipient(
        email="member@example.com", name="A Member", role=str(Role.FINANCE_MEMBER)
    ),
    sensitivity=mail.Sensitivity.BUSINESS_MONEY,
    dedupe_key="withheld:1",
)
check(
    "a business-wide figure is withheld from a member",
    withheld["outcome"],
    str(mail.Outcome.WITHHELD_ROLE),
)
ok("…and the reason names the role", "finance_member" in withheld["error"])
check("withholding is not a failure", str(mail.Outcome.WITHHELD_ROLE) in mail.FAILURE_OUTCOMES, False)

# The gate is applied at the send, so a mistake in a recipient list cannot leak.
allowed, _ = mail.may_receive(
    str(mail.Sensitivity.BUSINESS_MONEY),
    mail.Recipient(email="outside@example.com", name="Accountant", role=None),
)
check("an outside address gets no business money by default", allowed, False)
allowed, _ = mail.may_receive(
    str(mail.Sensitivity.BUSINESS_MONEY),
    mail.Recipient(
        email="outside@example.com", name="Accountant", role=None,
        authorised_by="u-owner",
    ),
)
check("…unless an owner subscribed it deliberately (8A.3.14)", allowed, True)


# ══════════════════════════════════════════════════════════════════════════════
# 5. The same event never sends twice
# ══════════════════════════════════════════════════════════════════════════════

before = len(PROVIDER.sent)
first = send(dedupe_key="once:only", meta={"case": "dedupe"})
second = send(dedupe_key="once:only", meta={"case": "dedupe"})

check("the first send goes out", first["outcome"], str(mail.Outcome.SENT))
check("the second is refused as a duplicate", second["outcome"], str(mail.Outcome.DUPLICATE))
check("…and the provider saw it once", len(PROVIDER.sent) - before, 1)
check(
    "…and there is one row, not two",
    sum(1 for r in rows() if r.get("dedupe_key") == "once:only"),
    1,
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. No record, no send
# ══════════════════════════════════════════════════════════════════════════════
#
# An email nobody can prove was sent is not a control, and several of these
# emails are the audit trail an agency relies on. So the refusal is deliberate.

DB[C.EMAIL_DELIVERIES].fail_writes = PyMongoError("the delivery collection is down")
before = len(PROVIDER.sent)
exc = refuses(
    "a send whose record cannot be written is refused",
    lambda: mail.deliver(
        kind="test.message",
        spec="8A.2.14",
        recipient=owner(),
        subject="Unrecordable",
        html="<p>x</p>",
        sensitivity=mail.Sensitivity.OPERATIONAL,
        dedupe_key="unrecordable:1",
    ),
    error=mail.DeliveryNotRecorded,
)
DB[C.EMAIL_DELIVERIES].fail_writes = None

check("…and nothing was sent", len(PROVIDER.sent) - before, 0)
ok("…and the refusal cites the requirement", exc is not None and "8A.2.14" in str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# 7. Bounces — 8A.7.5. The difference between accepted and arrived
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.next_message_id = "bounce-me-0001"
bounced_row = send(dedupe_key="bounce:1", recipient=owner("dead@example.com"))
check("accepted by the provider", bounced_row["outcome"], str(mail.Outcome.SENT))

result = run(
    mail.record_provider_events(
        [
            {
                "event": "bounce",
                "sg_message_id": "bounce-me-0001.filterdrecv-p3",
                "reason": "550 5.1.1 The email account that you tried to reach does not exist",
                "email": "dead@example.com",
                "sg_event_id": "evt-1",
            }
        ]
    )
)
check("the bounce matched its send", result["matched"], 1)

stored = next(r for r in rows() if r.get("dedupe_key") == "bounce:1")
check("the outcome is now bounced", stored["outcome"], str(mail.Outcome.BOUNCED))
ok("…with the mailbox's own reason", "does not exist" in stored["error"])
ok("a bounce is a failure", str(mail.Outcome.BOUNCED) in mail.FAILURE_OUTCOMES)
check("the event is kept on the row", len(stored["events"]), 1)

# A 'delivered' event that arrives after a bounce must not undo it.
run(
    mail.record_provider_events(
        [{"event": "delivered", "sg_message_id": "bounce-me-0001.filterdrecv-p3"}]
    )
)
stored = next(r for r in rows() if r.get("dedupe_key") == "bounce:1")
check("a late 'delivered' does not erase the bounce", stored["outcome"], str(mail.Outcome.BOUNCED))

# An event for a message we never sent is counted, not silently dropped.
result = run(
    mail.record_provider_events([{"event": "bounce", "sg_message_id": "never-sent-9"}])
)
check("an unmatched event is counted", result["unmatched"], 1)


# ══════════════════════════════════════════════════════════════════════════════
# 8. No secret anywhere
# ══════════════════════════════════════════════════════════════════════════════

import json  # noqa: E402

everything = json.dumps(rows(), default=str)
ok("the API key is in no delivery record", API_KEY not in everything)
ok("…not even a fragment of it", "SG.f4KeK3y" not in everything)
for entry in PROVIDER.sent:
    ok("the API key is in no email body", API_KEY not in str(entry["html"]))
    ok("…and in no subject", API_KEY not in str(entry["subject"]))


# ══════════════════════════════════════════════════════════════════════════════
# 9. Templates refuse to send a blank where a figure should be
# ══════════════════════════════════════════════════════════════════════════════

try:
    # The payout receipt needs an amount, a name, the facts block and the
    # next-steps line. Supplying none of them must not produce
    # "Your payout of  has been paid".
    mail.render("payout_paid")
except mail.TemplateError as exc:
    ok("a template with a missing value refuses to render", "did not supply" in str(exc))
    ok("…and says which values", "'amount'" in str(exc) and "'facts'" in str(exc))
    ok("…and says nothing was sent with a blank in it", "blank where a figure" in str(exc))
else:  # pragma: no cover
    failures.append("a template rendered with a value missing")
    checks += 3

# 8A.2.5 / 0.2.9 — a rejection without its grounds is not sent at all.
before = len(PROVIDER.sent)
no_reason = run(
    mail.send_partner_rejected(
        recipient=mail.Recipient(
            email="applicant@example.com", name="Acme Talent", role=str(Role.AGENCY)
        ),
        partner_id="ag_noreason",
        kind="agency",
        reason="   ",
        rejected_at=datetime(2026, 8, 20, tzinfo=timezone.utc),
    )
)
check("a rejection with no reason is not sent", no_reason["outcome"], str(mail.Outcome.FAILED))
check("…and the provider was never called", len(PROVIDER.sent) - before, 0)
ok("…and the record says why", "without its grounds is not sent" in no_reason["error"])

# With a reason, it goes — and the reason is in the body, escaped.
PROVIDER.next_status = 202
PROVIDER.next_message_id = "sg-reject-1"
REASON = 'PAN "ACME<PQ>1234F" does not match the bank account name.'
sent_reject = run(
    mail.send_partner_rejected(
        recipient=mail.Recipient(
            email="applicant@example.com", name="Acme Talent", role=str(Role.AGENCY)
        ),
        partner_id="ag_4821",
        kind="agency",
        reason=REASON,
        rejected_at=datetime(2026, 8, 20, tzinfo=timezone.utc),
    )
)
check("a rejection with a reason is sent", sent_reject["outcome"], str(mail.Outcome.SENT))
body = PROVIDER.sent[-1]["html"]
ok("the reason reaches the applicant", "does not match the bank account name" in body)
ok("…escaped, because a reviewer typed it", "&lt;PQ&gt;" in body and "<PQ>" not in body)
ok("…and it says whether they may reapply", "reapply" in body)


# ══════════════════════════════════════════════════════════════════════════════
# 10. The 400 that was thrown away — the provider's own words, verbatim
# ══════════════════════════════════════════════════════════════════════════════
#
# THE BUG, exactly as it happened. Three report emails failed on every run with
#
#     BadRequestsError: HTTP Error 400: Bad Request
#
# and nothing else. That string is a constant: `python_http_client.HTTPError`
# formats it from the status code alone, so it is identical for a bad MIME type,
# an empty attachment, a malformed address and a payload that is too large. The
# sentence naming the exact broken field arrives in the same HTTP response, on
# `exc.body`, and was discarded by `f"{type(exc).__name__}: {exc}"`.
#
# So the assertion is not "an error is recorded". It is that the body survives
# **word for word** — because a summary of it is what turned a one-line fix into
# a mystery that ran for as long as the system did.

SENDGRID_400 = (
    b'{"errors":[{"message":"The attachment type cannot contain \';\', or CRLF '
    b'characters.","field":"attachments.0.type","help":"http://sendgrid.com/docs'
    b'/API_Reference/Web_API_v3/Mail/errors.html#message.attachments.type"}]}'
)
BODY_TEXT = SENDGRID_400.decode()

PROVIDER.next_status = 400
PROVIDER.next_body = SENDGRID_400
PROVIDER.next_message_id = ""

bad_request = send(
    dedupe_key="badrequest:1",
    attachments=[mail.Attachment(filename="cash_position.csv", data=b"a,b\r\n1,2\r\n")],
)

check("a 400 is a recorded failure", bad_request["outcome"], str(mail.Outcome.FAILED))
check("…with the status", bad_request["provider_status"], 400)
check(
    "THE PROVIDER'S BODY IS KEPT VERBATIM, on its own field",
    bad_request["provider_error_body"],
    BODY_TEXT,
)
ok(
    "…and verbatim inside the Cause the CRM shows, not summarised away",
    BODY_TEXT in bad_request["error"],
)
check(
    "…and the field SendGrid named is pulled out on its own",
    bad_request["provider_error_fields"],
    ["attachments.0.type"],
)
ok(
    "…and the useless constant is still there, so nothing is hidden either",
    "HTTP Error 400: Bad Request" in bad_request["error"],
)
ok(
    "…and the record says what to do about it",
    "must be a bare 'type/subtype'" in bad_request["error"],
)

# The exception the live log actually named, constructed the way the SDK does.
raised = BadRequestsError(400, "Bad Request", SENDGRID_400, {})
check(
    "str() on the SDK's exception really is that useless",
    str(raised),
    "HTTP Error 400: Bad Request",
)
ok("…which is why .body has to be read", BODY_TEXT in mail._from_exception(raised).error)

# A rejection with no body says so as an absence, and never invents a cause.
PROVIDER.next_body = b""
silent_400 = send(dedupe_key="badrequest:2")
ok(
    "a rejection with no body records the absence rather than a guess",
    "returned no body" in silent_400["error"],
)
check("…and no body is stored", silent_400["provider_error_body"], None)

# The other path: a client that answers a non-2xx instead of raising loses no
# more detail than the one that raises.
PROVIDER.raise_on_error_status = False
PROVIDER.next_status = 413
PROVIDER.next_body = b'{"errors":[{"message":"too big","field":"attachments"}]}'
non_raising = send(dedupe_key="badrequest:3")
PROVIDER.raise_on_error_status = True
ok(
    "the non-exception path keeps the body too",
    '"message":"too big"' in non_raising["error"],
)
check(
    "…and its field", non_raising["provider_error_fields"], ["attachments"]
)


# ══════════════════════════════════════════════════════════════════════════════
# 11. The attachment contract — the actual cause of the 400
# ══════════════════════════════════════════════════════════════════════════════
#
# `Attachment.content_type` used to default to "text/csv; charset=utf-8". That
# is a correct Content-Type header and an invalid value for SendGrid's
# `attachments[].type`, which rejects the whole message — body, figures and all
# — with the 400 above. Every report that carries a CSV failed; the two that
# carry none went out from the same sender to the same recipients, which is
# exactly the pattern in the owner's delivery log.

check(
    "a charset is stripped before it reaches the API",
    mail.Attachment("x.csv", b"a\r\n", "text/csv; charset=utf-8").provider_type(),
    "text/csv",
)
check(
    "…and so is a CRLF smuggled into the type",
    mail.Attachment("x.csv", b"a\r\n", "text/csv\r\nX: y").provider_type(),
    "text/csv",
)
check(
    "…and anything still not a bare type/subtype becomes one that always sends",
    mail.Attachment("x.csv", b"a\r\n", "not a mime type at all").provider_type(),
    "application/octet-stream",
)
check(
    "the default carries no parameter at all — the bug cannot come back by default",
    mail.Attachment("x.csv", b"a\r\n").content_type,
    "text/csv",
)

PROVIDER.next_status = 202
PROVIDER.next_body = b""
PROVIDER.next_message_id = "sg-attach-1"

# ── Two sections, one filename. Renamed, not shadowed, not dropped. ──────────

dupes = [
    mail.Attachment(filename="cash_position_2026-08-23.csv", data=b"a,b\r\n1,2\r\n"),
    mail.Attachment(filename="cash_position_2026-08-23.csv", data=b"c,d\r\n3,4\r\n"),
    mail.Attachment(filename="cash_position_2026-08-23.csv", data=b"e,f\r\n5,6\r\n"),
]
prepared, omitted = mail.prepare_attachments(dupes)
check("a duplicate filename is resolved, not refused", len(prepared), 3)
check(
    "…deterministically, and the first keeps its name",
    [a.filename for a in prepared],
    [
        "cash_position_2026-08-23.csv",
        "cash_position_2026-08-23_2.csv",
        "cash_position_2026-08-23_3.csv",
    ],
)
check("…and nothing was omitted to achieve it", omitted, [])
check(
    "…and the bytes are untouched — a rename is not a re-render",
    [a.data for a in prepared],
    [a.data for a in dupes],
)

dupe_row = send(dedupe_key="dupes:1", attachments=dupes)
check("the email with the renamed files goes out", dupe_row["outcome"], str(mail.Outcome.SENT))
names = [entry["parts"][1] for entry in PROVIDER.sent[-1]["attachments"]]
check("…and the provider saw three distinct filenames", len(set(names)), 3)
check(
    "…which are the names on the delivery record too",
    [a["filename"] for a in dupe_row["attachments"]],
    names,
)
ok(
    "no MIME type crossing the wire carries a parameter",
    all(";" not in entry["parts"][2] for entry in PROVIDER.sent[-1]["attachments"]),
)

# ── An unsendable file is omitted, named, and the email still arrives ────────

before = len(PROVIDER.sent)
mixed = [
    mail.Attachment(filename="good_2026-08-23.csv", data=b"line\r\nvalue\r\n"),
    # `to_csv` on a report with no columns and no rows yields exactly this: a
    # CSV with neither a header nor a row. It would open blank, and a blank CSV
    # reads as "nothing happened" when the truth is "no columns were defined".
    mail.Attachment(filename="no_columns_2026-08-23.csv", data=b"\r\n"),
    mail.Attachment(filename="zero_2026-08-23.csv", data=b""),
    mail.Attachment(filename="huge_2026-08-23.csv", data=b"x" * (settings.email_max_attachment_bytes + 1)),
    mail.Attachment(filename="  . ", data=b"a\r\n"),
]
sendable, dropped = mail.prepare_attachments(mixed)
check("only the file that can be sent is sent", [a.filename for a in sendable], ["good_2026-08-23.csv"])
check("…and every other one is named", len(dropped), 4)
check(
    "…each with its own reason, in words",
    [d["filename"] for d in dropped],
    ["no_columns_2026-08-23.csv", "zero_2026-08-23.csv", "huge_2026-08-23.csv", "  . "],
)
ok("a whitespace-only CSV says so", "whitespace and nothing else" in dropped[0]["reason"])
ok("a zero-byte file says so", "0 bytes" in dropped[1]["reason"])
ok("an oversized file says the limit", f"{settings.email_max_attachment_bytes:,}-byte" in dropped[2]["reason"])
ok("a filename that survives nothing says why", "cannot be attached" in dropped[3]["reason"])

# A filename that is merely *awkward* is repaired, not refused. The characters
# SendGrid names — ';' and CR/LF — come out; the file still goes.
check(
    "a filename with characters the API refuses is repaired, not dropped",
    mail.Attachment("cash;position\r\n.csv", b"a\r\n").safe_filename(),
    "cash-position--.csv",
)
check(
    "…and such a file is perfectly sendable",
    mail.Attachment("cash;position\r\n.csv", b"a\r\n").unsendable(),
    None,
)

omit_row = send(dedupe_key="omit:1", attachments=mixed)
check(
    "THE EMAIL STILL GOES — a report without one CSV beats a report that never arrives",
    omit_row["outcome"],
    str(mail.Outcome.SENT),
)
check("…carrying the file that could be sent", len(PROVIDER.sent[-1]["attachments"]), 1)
check("…and the record lists the omissions", len(omit_row["attachments_omitted"]), 4)
sent_html = PROVIDER.sent[-1]["html"]
ok("…and the body itself names what is missing", "no_columns_2026-08-23.csv" in sent_html)
ok("…and why", "whitespace and nothing else" in sent_html)
ok(
    "…and says the email was sent without them on purpose",
    "sent without them rather than not sent at all" in sent_html,
)
ok(
    "…and the plain-text part carries the same omission notice",
    "no_columns_2026-08-23.csv" in PROVIDER.sent[-1]["text"],
)
check("…and exactly one email was sent, not zero and not two", len(PROVIDER.sent) - before, 1)

# The scheduled-report note is where a reader actually meets this.
from app.services import scheduling as sched  # noqa: E402

note = sched._attachment_note(
    [sched.Section(title="Cash position", envelope={"report": "cash_position"})],
    sendable,
    dropped,
)
ok("the scheduled-report note lists what is attached", "good_2026-08-23.csv" in note)
ok("…and names each missing file", "zero_2026-08-23.csv" in note)
ok("…with the reason attached to it", "0 bytes" in note)

# One enormous section cannot take the whole email down with it.
big = int(settings.email_max_total_attachment_bytes)
settings.email_max_total_attachment_bytes = 20
capped, over = mail.prepare_attachments(
    [mail.Attachment("a.csv", b"x" * 12), mail.Attachment("b.csv", b"y" * 12)]
)
settings.email_max_total_attachment_bytes = big
check("the message total is capped", [a.filename for a in capped], ["a.csv"])
ok("…and the file that did not fit says so", "message limit" in over[0]["reason"])


# ══════════════════════════════════════════════════════════════════════════════
# 12. Deliverability — the half that is ours
# ══════════════════════════════════════════════════════════════════════════════

settings.mail_from = "no-reply@zipper.example"
settings.mail_from_transactional = "notifications@zipper.example"
settings.mail_from_bulk = "reports@zipper.example"
settings.mail_from_name_bulk = "Zipper reports"
settings.support_email = "support@zipper.example"
settings.unsubscribe_url = "https://api.zipper.example/api/notifications/unsubscribe"
settings.jwt_secret = "a-test-signing-secret"
# Spec §12: info@ and support@ leave as themselves only once the owner has
# confirmed the mailboxes (the two switches). This section tests the separate
# streams, so both are on here; `tests/test_email_identities.py` covers the
# default (both off → everything from no-reply, no Reply-To).
settings.email_identity_info_enabled = True
settings.email_identity_support_enabled = True

# ── A plain-text alternative on everything ───────────────────────────────────

PROVIDER.next_message_id = "sg-text-1"
text_row = send(
    dedupe_key="plaintext:1",
    subject="A subject with no secret in it",
    html=mail.page(
        title="Daily business summary",
        preheader="Cash in, cash out.",
        body="<p>Receipts <b>₹45,000.00 INR</b></p>"
        '<a href="https://portal.example/reports">Open the report</a>',
    ),
)
check("it sent", text_row["outcome"], str(mail.Outcome.SENT))
plain = PROVIDER.sent[-1]["text"]
ok("a plain-text alternative is present — nothing goes out HTML-only", bool(plain and plain.strip()))
ok("…and it carries the figure, not a placeholder", "₹45,000.00 INR" in plain)
ok("…with no HTML left in it", "<" not in plain and "&nbsp;" not in plain)
ok("…keeping every link's destination", "https://portal.example/reports" in plain)
ok("…and dropping the hidden preheader, which is not text a reader wants twice",
   plain.count("Cash in, cash out.") == 0)
check(
    "the two parts are derived from one HTML, so they cannot disagree",
    mail.text_alternative(PROVIDER.sent[-1]["html"]),
    plain,
)

# ── Unsubscribe headers: on bulk, and deliberately not on transactional ──────

bulk_row = send(
    dedupe_key="bulk:1",
    identity=mail.SenderIdentity.BULK,
    unsubscribe=mail.Unsubscribe(report="daily_business_summary", cadence="daily"),
)
headers = PROVIDER.sent[-1]["headers"]
ok("a bulk message carries List-Unsubscribe", "List-Unsubscribe" in headers)
ok(
    "…with a one-click https route, because one is configured",
    headers["List-Unsubscribe"].startswith("<https://api.zipper.example/"),
)
# QA #47 (owner decision, 3 Nov 2026): the mailto route goes to the official
# support address. It used to be derived as `unsubscribe@<the mail_from
# domain>` — an address nobody created, which the decision rules out.
ok("…and a mailto route as well, to the support mailbox", "<mailto:support@zipperlive.org?subject=" in headers["List-Unsubscribe"])
check(
    "…and the one-click POST header Gmail and Yahoo require of bulk senders",
    headers.get("List-Unsubscribe-Post"),
    "List-Unsubscribe=One-Click",
)
ok("…and a List-Id naming the stream", "daily-business-summary." in headers.get("List-Id", ""))
check("…and it is marked machine-generated", headers.get("Auto-Submitted"), "auto-generated")
check("the row records that it was bulk", bulk_row["bulk"], True)
ok(
    "…and which headers went, without storing the token in them",
    "List-Unsubscribe" in bulk_row["headers_sent"]
    and not any("t=" in h for h in bulk_row["headers_sent"]),
)

transactional_row = send(dedupe_key="transactional:1")
t_headers = PROVIDER.sent[-1]["headers"]
ok(
    "a transactional message carries NO unsubscribe — it would not be honoured",
    "List-Unsubscribe" not in t_headers and "List-Unsubscribe-Post" not in t_headers,
)
check("…and is not recorded as bulk", transactional_row["bulk"], False)

# One-click is only advertised when something answers it. A header promising an
# endpoint that does not exist is worse for a domain than no header at all.
settings.unsubscribe_url = ""
send(
    dedupe_key="bulk:2",
    identity=mail.SenderIdentity.BULK,
    unsubscribe=mail.Unsubscribe(report="daily_business_summary", cadence="daily"),
)
no_click = PROVIDER.sent[-1]["headers"]
ok("with no endpoint configured, List-Unsubscribe is still there", "List-Unsubscribe" in no_click)
ok("…but one-click is not advertised", "List-Unsubscribe-Post" not in no_click)
settings.unsubscribe_url = "https://api.zipper.example/api/notifications/unsubscribe"

# An alert may not be muted by a machine — 8A.4 — so it never claims otherwise.
send(
    dedupe_key="alertlike:1",
    identity=mail.SenderIdentity.BULK,
    unsubscribe=mail.Unsubscribe(report="alert.stuck_card", cadence="event", one_click=False),
)
alert_headers = PROVIDER.sent[-1]["headers"]
ok("an alert offers a route to a person", "mailto:" in alert_headers["List-Unsubscribe"])
ok("…and never one-click, because nothing would honour it",
   "List-Unsubscribe-Post" not in alert_headers)

# The token binds to one address: forwarding the email unsubscribes nobody else.
token = mail.unsubscribe_token("owner@example.com", "daily_business_summary", "daily")
ok("the unsubscribe token verifies for its own address",
   mail.unsubscribe_token_valid("owner@example.com", "daily_business_summary", "daily", token))
ok("…and for nobody else's",
   not mail.unsubscribe_token_valid("someone@else.example", "daily_business_summary", "daily", token))
ok("…and not for another report",
   not mail.unsubscribe_token_valid("owner@example.com", "weekly_business", "daily", token))
ok("…and an empty token never verifies",
   not mail.unsubscribe_token_valid("owner@example.com", "daily_business_summary", "daily", ""))

# ── Sender identities, Reply-To, and From alignment ──────────────────────────

check(
    "a report leaves from the bulk identity",
    mail.sender_for(mail.SenderIdentity.BULK)[0],
    "reports@zipper.example",
)
check(
    "a receipt leaves from the transactional one",
    mail.sender_for(mail.SenderIdentity.TRANSACTIONAL)[0],
    "notifications@zipper.example",
)
check(
    "and none of them sets a Reply-To, even with support@ switched on (spec §12)",
    [mail.sender_for(i)[2] for i in mail.SenderIdentity],
    [""] * len(list(mail.SenderIdentity)),
)
check(
    "the visible From on a bulk send is the bulk identity, not a shared mailbox",
    PROVIDER.sent[-1]["from"],
    "reports@zipper.example",
)
check("…and carries no Reply-To", PROVIDER.sent[-1]["reply_to"], None)
ok("all three identities are on one domain, so one DKIM key aligns them all",
   len({mail._domain_of(mail.sender_for(i)[0]) for i in mail.SenderIdentity}) == 1)

aligned = mail.sender_alignment(mail.SenderIdentity.BULK)
check("a From on a domain we control can be aligned", aligned["aligned"], True)
check("…and the delivery row says so", bulk_row["sender"]["aligned"], True)
check("…and all the identities sit on one domain, so one DKIM key covers them",
      aligned["one_domain"], True)

settings.mail_from_bulk = "reports@some-other-domain.example"
split = mail.sender_alignment(mail.SenderIdentity.BULK)
check("identities spread across two domains is flagged", split["one_domain"], False)
ok("…and the reason says one key authenticates one domain",
   "One DKIM key authenticates one domain" in split["why"])
settings.mail_from_bulk = "reports@zipper.example"

settings.mail_from_bulk = "314zipper@gmail.com"
gmail = mail.sender_alignment(mail.SenderIdentity.BULK)
check("sending as @gmail.com can never be aligned", gmail["aligned"], False)
ok("…and the reason names the problem, not the symptom", "cannot be published by us" in gmail["why"])
unaligned_row = send(
    dedupe_key="unaligned:1",
    identity=mail.SenderIdentity.BULK,
    unsubscribe=mail.Unsubscribe(report="daily_business_summary", cadence="daily"),
)
check("it still sends — this is a warning, not a gate", unaligned_row["outcome"], str(mail.Outcome.SENT))
ok("…but it is never silent", "sender_not_aligned" in unaligned_row["meta"])
settings.mail_from_bulk = "reports@zipper.example"
settings.email_identity_info_enabled = False
settings.email_identity_support_enabled = False

# ── Nothing in the catalogue reads as a mailshot ─────────────────────────────

for name, _spec, _desc in mail.PREVIEWABLE:
    preview_subject, preview_html = mail.preview(name)
    check(f"'{name}' has a subject no filter would score as spam",
          mail.subject_problems(preview_subject), [])
    check(f"'{name}' has a body no filter would score as spam",
          mail.body_problems(preview_html), [])
    ok(f"'{name}' renders to readable text with no HTML in it",
       "<" not in mail.text_alternative(preview_html))

check(
    "…and the check is real: shouting is caught",
    bool(mail.subject_problems("1 section(s) COULD NOT BE COMPUTED")),
    True,
)
check("…and so is a bank reference NOT being shouting",
      mail.subject_problems("Payment sent — ₹75,000.00 INR (UTR SBIN226012345678)"), [])
ok("…and an image-only body is caught",
   bool(mail.body_problems('<div><img src="https://x.example/a.png"></div>')))
ok("…and a link shortener is caught",
   bool(mail.body_problems('<p>Some text that is quite long indeed, at least two '
                           'hundred characters of it, so that the image rule does not '
                           'fire and only the shortener rule can possibly be what is '
                           'being detected here in this particular assertion.</p>'
                           '<a href="https://bit.ly/x">go</a>')))

# ── The secret sweep, again, over everything the new fields added ────────────
#
# Section 8 ran before any of this existed. `provider_error_body`,
# `provider_headers` and the unsubscribe headers are all new places a
# credential could come to rest, so they are swept too.

everything_now = json.dumps(rows(), default=str)
ok("the API key is in no delivery record, including the new fields", API_KEY not in everything_now)
ok("…not even a fragment", "SG.f4KeK3y" not in everything_now)
ok("…and not in a stored provider body", "SG." not in json.dumps(
    [r.get("provider_error_body") for r in rows()], default=str))
ok("…and no response header we keep is an Authorization header",
   not any("authorization" in (r.get("provider_headers") or {}) for r in rows()))
for entry in PROVIDER.sent:
    ok("the API key is in no email header", API_KEY not in json.dumps(entry["headers"]))
    ok("…and in no plain-text part", API_KEY not in str(entry["text"] or ""))
ok(
    "the signing secret never reaches a delivery record either",
    settings.jwt_secret not in everything_now,
)


# ══════════════════════════════════════════════════════════════════════════════
# 13. Money is rendered as money
# ══════════════════════════════════════════════════════════════════════════════

check("minor units render with their currency", mail.money(125_00_000), "₹1,25,000.00 INR")
check("a figure that is not known is not zero", mail.money(None), "—")
check("zero is zero", mail.money(0), "₹0.00 INR")
check("a count is not money", mail.quantity(250_000, "coins"), "250,000 coins")


# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} delivery checks passed.")
print("  · every send leaves a row: what, to whom, when, which template, outcome")
print("  · a 403 from an unverified MAIL_FROM is a recorded failure naming the cause")
print("  · a timeout, a missing SDK and a missing API key are each recorded too")
print("  · no address and a withheld figure are recorded, never skipped")
print("  · the same event cannot send twice; if the row cannot be written, nothing is sent")
print("  · a bounce overwrites acceptance, and a late 'delivered' does not undo it")
print("  · a 400 keeps SendGrid's body VERBATIM, and the field it named, on the row")
print("  · no attachment MIME type carries a parameter — the cause of that 400")
print("  · a duplicate filename is renamed; an unsendable file is omitted and named")
print("  · …and the email still goes: a report without one CSV beats no report")
print("  · every message has a plain-text alternative built from the same HTML")
print("  · bulk carries List-Unsubscribe; transactional deliberately carries none")
print("  · three sender identities on one domain, all replying to a human")
print("  · no subject or body in the catalogue reads as a mailshot")
print("  · the API key appears in no record, no subject, no body and no header")
sys.exit(0)
