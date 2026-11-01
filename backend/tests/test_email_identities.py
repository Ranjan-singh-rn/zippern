"""Spec §12 — sender identities, the template catalogue and the ONE notice writer.

The real `email.deliver()` / `send_template()` / `retry_failed()` and the real
`notices.deliver_notice()` run against `FakeSendGrid`, the harness Mongo and the
in-memory Firestore. What is asserted:

  * **identity resolution** — auth / security / transactional always leave from
    no-reply@; info@ and support@ only when their switch is on (default off),
    otherwise no-reply@; Reply-To is never set, switch or no switch;
  * the switch names are the same on both sides (backend settings ↔
    `functions/src/mail.ts`);
  * **tracking is off** on the wire for auth and security mail, untouched for
    transactional;
  * **no code, set-password link or API key** in any captured log record or
    delivery row, with the root logger at DEBUG;
  * **every catalogue template renders** (subject, escaped HTML, text part);
  * **stable dedupe keys** — template keys and notice eventKeys are
    deterministic, so a retried business action sends once;
  * **a failure is a retryable record and never reaches the business action**:
    a provider refusal leaves a `failed` row with its recipe, the notice says
    `pending`, the sweep re-sends the same row and the notice says `sent`; a
    Firestore outage parks the notice and the sweep writes it later;
  * **the notice writer's contract** — userId, eventKey, type, title, body,
    relatedId, createdAt, read AND isRead, delivery — and its idempotency on
    the eventKey (a repeat never resets `read` and never sends a second email);
  * one email per event: partner events whose email the Functions / the 8A.2
    sweep own carry none here and say so in `delivery.emailVia`;
  * `scripts/email_identity_check.py --dry-run` prints the identities, the
    templates and the DNS checklist, and no secret.

Run:  python3 -m tests.test_email_identities
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import re
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, auth_record, install_stubs, verified_auth  # noqa: E402

install_stubs()

from app import config as cfg  # noqa: E402
from app.config import settings  # noqa: E402
import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

FS = FakeFirestore()
firebase_mod.firestore_client = lambda: FS  # type: ignore[assignment]

#: uid → Auth record. Unknown uids get a verified address (`<uid>@x.test`).
AUTH: dict = {"unverified-1": auth_record("unverified-1", email="unverified-1@x.test", email_verified=False)}
firebase_mod.get_user = lambda uid: AUTH.get(uid) or verified_auth(uid)  # type: ignore[assignment]

from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import email as mail  # noqa: E402
from app.services import notices  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()

API_KEY = "SG.FAKE-TEST-KEY-identities-0123456789"
settings.sendgrid_api_key = API_KEY
settings.environment = "test"
settings.email_provider = "sendgrid"
settings.mail_from = "no-reply@zipperlive.org"
settings.mail_from_name = "ZIPPER Live"
settings.mail_from_transactional = ""
settings.mail_from_bulk = ""
settings.mail_from_support = ""
settings.support_email = ""
settings.mail_from_info = ""
settings.mail_from_name_info = ""
settings.email_identity_info_enabled = False
settings.email_identity_support_enabled = False
settings.email_max_attempts = 3
settings.email_retry_base_delay_seconds = 1.0
settings.email_send_budget_seconds = 30
settings.email_timeout_seconds = 20
settings.email_retry_max_sweeps = 6
settings.unsubscribe_url = "https://api.zipper.example/api/notifications/unsubscribe"
settings.jwt_secret = "a-test-signing-secret"
settings.portal_url = "https://portal.zipper.example"
settings.observer_email = "observer@zipper.example"
settings.observer_otp_delivery_email = "observer-codes@zipper.example"

# A clock that only moves when the code under test waits.
CLOCK = [1000.0]
mail._clock = lambda: CLOCK[0]
mail._sleep = lambda s: CLOCK.__setitem__(0, CLOCK[0] + float(s))
mail._jitter = lambda: 0.0

# The synchronous path (codes, invitations) records in memory here.
BLOCKING_ROWS: list[dict] = []


def _record_blocking(doc: dict):
    BLOCKING_ROWS.append(dict(doc))
    return len(BLOCKING_ROWS) - 1


def _close_blocking(record_id, patch: dict) -> None:
    if record_id is not None:
        BLOCKING_ROWS[record_id].update(patch)


mail._record_blocking = _record_blocking  # type: ignore[assignment]
mail._close_blocking = _close_blocking  # type: ignore[assignment]


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

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label + (f"\n    {detail}" if detail else ""))


def run(coro):
    return asyncio.run(coro)


def reset_provider() -> None:
    PROVIDER.queue.clear()
    PROVIDER.sent.clear()
    PROVIDER.next_status = 202
    PROVIDER.next_body = b""
    PROVIDER.next_message_id = "msg-ok"
    PROVIDER.next_headers = None
    PROVIDER.raise_on_send = None


def rows() -> list[dict]:
    return DB[C.EMAIL_DELIVERIES].docs


def rows_for(key: str) -> list[dict]:
    return [r for r in rows() if r.get("dedupe_key") == key]


def notice(doc_id: str) -> dict | None:
    return FS.collection("notifications").docs.get(doc_id)


def tracking_off(sent: dict) -> bool:
    t = sent.get("tracking")
    return (t is not None and t.click_tracking.enable is False and t.click_tracking.enable_text is False
            and t.open_tracking.enable is False and t.subscription_tracking.enable is False
            and t.ganalytics.enable is False)


def owner(uid: str = "u-owner-1", address: str = "owner1@zipperlive.org") -> mail.Recipient:
    return mail.Recipient(email=address, name="An Owner", role=str(Role.OWNER), uid=uid)


# ══════════════════════════════════════════════════════════════════════════════
# 1. The identity table, and the two switches (default off)
# ══════════════════════════════════════════════════════════════════════════════

check("EMAIL_IDENTITY_INFO_ENABLED ships false", cfg.Settings.email_identity_info_enabled, False)
check("EMAIL_IDENTITY_SUPPORT_ENABLED ships false", cfg.Settings.email_identity_support_enabled, False)
check("the shipped From is no-reply@zipperlive.org", cfg.Settings.mail_from, "no-reply@zipperlive.org")
check("the identity table names exactly the §12 identities (+ the legacy bulk alias)",
      sorted(mail.IDENTITY_TABLE), sorted(["auth", "security", "transactional", "info", "support", "bulk"]))
check("auth / security / transactional are never switchable",
      [mail.IDENTITY_TABLE[i][2] for i in ("auth", "security", "transactional")], [None, None, None])
check("info / support are switched by the two settings",
      [mail.IDENTITY_TABLE[i][2] for i in ("info", "support")],
      ["email_identity_info_enabled", "email_identity_support_enabled"])

for identity in mail.SenderIdentity:
    r = mail.identity_resolution(identity)
    check(f"switches off: '{identity}' leaves from no-reply@", r["from"], "no-reply@zipperlive.org")
    check(f"…and '{identity}' has no Reply-To", r["reply_to"], "")
for identity in ("info", "bulk", "support"):
    ok(f"…and '{identity}' says WHY it fell back (Q8)",
       "Q8" in mail.identity_resolution(identity)["fallback"])
check("an unknown identity resolves as transactional", mail.identity_resolution("nonsense")["from"],
      "no-reply@zipperlive.org")

settings.email_identity_info_enabled = True
check("info switched on: info@ on the mail_from domain", mail.sender_for("info")[0], "info@zipperlive.org")
check("…the legacy bulk name resolves exactly as info", mail.sender_for("bulk")[0], "info@zipperlive.org")
check("…support stays no-reply until ITS switch is on", mail.sender_for("support")[0], "no-reply@zipperlive.org")
settings.email_identity_support_enabled = True
check("support switched on: support@", mail.sender_for("support")[0], "support@zipperlive.org")
check("…and still no Reply-To on any identity",
      sorted({mail.sender_for(i)[2] for i in mail.SenderIdentity}), [""])
check("…and auth / security / transactional are untouched by either switch",
      [mail.sender_for(i)[0] for i in ("auth", "security", "transactional")], ["no-reply@zipperlive.org"] * 3)
settings.mail_from_info = "hello@zipperlive.org"
check("MAIL_FROM_INFO names the info address when set", mail.sender_for("info")[0], "hello@zipperlive.org")
settings.mail_from_info = ""
settings.email_identity_info_enabled = False
settings.email_identity_support_enabled = False

# The Functions read the SAME two names from their environment.
MAIL_TS = ROOT.parent / "functions" / "src" / "mail.ts"
if MAIL_TS.exists():
    ts = MAIL_TS.read_text(encoding="utf-8")
    for env_name in ("EMAIL_IDENTITY_INFO_ENABLED", "EMAIL_IDENTITY_SUPPORT_ENABLED"):
        ok(f"functions/src/mail.ts reads {env_name}", env_name in ts)
        check(f"…which is the backend setting {env_name.lower()}",
              hasattr(cfg.Settings, env_name.lower()), True)
    ts_code = re.sub(r"//.*|/\*[\s\S]*?\*/", "", ts)
    ok("…and puts no Reply-To on the message", "message.replyTo" not in ts_code
       and "replyTo: who" not in ts_code and "replyTo: ''" in ts_code)
else:  # pragma: no cover — the suite copies functions/src next to backend
    ok("functions/src/mail.ts is present beside the backend", False, str(MAIL_TS))

# ══════════════════════════════════════════════════════════════════════════════
# 2. Tracking on the wire, and the identity on the row
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
_n = [0]


def send(**overrides) -> dict:
    _n[0] += 1
    kwargs = dict(kind="test.message", spec="§12", recipient=owner(), subject="A subject",
                  html="<p>body</p>", sensitivity=mail.Sensitivity.OPERATIONAL, dedupe_key=f"ids:{_n[0]}")
    kwargs.update(overrides)
    return run(mail.deliver(**kwargs))


row = send(identity=mail.SenderIdentity.AUTH)
check("auth: sent", row["outcome"], "sent")
ok("auth: click, open, subscription and GA tracking are all off on the wire", tracking_off(PROVIDER.sent[-1]))
check("…and the row records identity auth / tracking off", (row["identity"], row["tracking"]), ("auth", "off"))
check("…from no-reply, with no Reply-To", (PROVIDER.sent[-1]["from"], PROVIDER.sent[-1]["reply_to"]),
      ("no-reply@zipperlive.org", None))
row = send(identity=mail.SenderIdentity.SECURITY)
ok("security: tracking off on the wire", tracking_off(PROVIDER.sent[-1]))
check("…recorded", (row["identity"], row["tracking"]), ("security", "off"))
row = send(identity=mail.SenderIdentity.TRANSACTIONAL)
check("transactional: the account default is left alone (no override sent)", PROVIDER.sent[-1]["tracking"], None)
check("…recorded", (row["identity"], row["tracking"]), ("transactional", "default"))
row = send(kind="owner_mfa.enrolled", identity=None)
check("a caller that names no identity is classified from its kind (MFA → security)", row["identity"], "security")
ok("…and goes out untracked", tracking_off(PROVIDER.sent[-1]))
row = send(identity=None, sensitivity=mail.Sensitivity.CREDENTIAL)
check("…a credential with no identity is auth", row["identity"], "auth")
for name, template in mail.TEMPLATES.items():
    if str(template.identity) in ("auth", "security"):
        check(f"template '{name}' is untracked", template.tracking, "off")

# ══════════════════════════════════════════════════════════════════════════════
# 3. No code, link or key in a log record or a delivery row
# ══════════════════════════════════════════════════════════════════════════════

CODE = "482913"
LINK_SECRET = "oobCode-SECRET-LINK-7731"
LOGS.lines.clear()
reset_provider()
ok("the observer code is sent", mail.send_observer_otp(CODE, 10))
ok("…and the code reaches the provider (it is in the email)", CODE in PROVIDER.sent[-1]["html"])
ok("a staff invitation is sent", mail.send_staff_invitation(
    to_email="new.staff@zipperlive.org", name="New Staff", role_label="Support Admin",
    set_password_link=f"https://zipper.example/reset?oobCode={LINK_SECRET}", invited_by="An Owner"))
check("the code and the invitation leave as auth, untracked",
      [(r["identity"], r["tracking"]) for r in BLOCKING_ROWS[-2:]], [("auth", "off"), ("auth", "off")])
check("…with no retry recipe (minted once, never re-rendered)", [r.get("retry") for r in BLOCKING_ROWS[-2:]],
      [None, None])
PROVIDER.raise_on_send = urllib.error.URLError("connection refused")
mail.send_observer_otp(CODE, 10)          # a failure is logged too — still without the code
PROVIDER.raise_on_send = None
everything = "\n".join(LOGS.lines)
ok("captured logs exist (the check is not vacuous)", len(LOGS.lines) > 0)
ok("no log record holds the sign-in code", CODE not in everything)
ok("no log record holds the set-password link", LINK_SECRET not in everything)
ok("no log record holds the API key", API_KEY not in everything)
ok("no delivery row holds the code or the link",
   not any(CODE in repr(r) or LINK_SECRET in repr(r) for r in BLOCKING_ROWS + rows()))
ok("no full recipient address is logged",
   "observer-codes@zipper.example" not in everything and "new.staff@zipperlive.org" not in everything)

# ══════════════════════════════════════════════════════════════════════════════
# 4. Every template renders; dedupe keys are stable
# ══════════════════════════════════════════════════════════════════════════════

CATEGORIES = {
    "auth": {"observer.otp", "staff.invitation"},
    "partner applications": {"partner.application_received", "partner.approved", "partner.rejected"},
    "role changes": {"role.suspended", "role.resumed", "role.revoked"},
    "warning/suspension/ban": {"user.warning", "account.suspended", "account.banned"},
    "appeals": {"appeal.received", "appeal.decided", "role_appeal.decided"},
    "transfers": {"transfer.requested", "transfer.decided"},
    "recharge/refund": {"recharge.approved", "recharge.refunded"},
    "Owner alerts": {"owner.money_action", "owner.alert"},
    "support": {"support.ticket_reply"},
    "department vacancy": {"department.vacancy"},
}
for category, names in CATEGORIES.items():
    ok(f"§12 '{category}' has its templates in the catalogue", names <= set(mail.TEMPLATES),
       str(sorted(names - set(mail.TEMPLATES))))

PARAMS = {"title": "A title", "body": "Body with <script>alert(1)</script> & more",
          "rows": [["Reference", "R-1"], ["Amount", "100"]], "reason": "Because <b>x</b>",
          "next_steps": "Do this next.", "button_url": "https://portal.zipper.example/x",
          "button_label": "Open", "footnote": "A footnote."}
for name, template in mail.TEMPLATES.items():
    try:
        built = mail.build_template(name, PARAMS, related_id="rel-1", recipient_key="who-1")
    except Exception as exc:  # noqa: BLE001
        ok(f"template '{name}' renders", False, f"{type(exc).__name__}: {exc}")
        continue
    ok(f"'{name}': a subject", bool(built.subject.strip()))
    ok(f"'{name}': the body is in the HTML, escaped",
       "&lt;script&gt;" in built.html and "<script>alert" not in built.html)
    ok(f"'{name}': a plain-text part", "Body with" in built.text)
    check(f"'{name}': identity from the table", built.identity in mail.IDENTITY_TABLE, True)
    check(f"'{name}': deterministic dedupe key", built.dedupe_key, f"{name}:rel-1:who-1")
    again = mail.build_template(name, PARAMS, related_id="rel-1", recipient_key="who-1")
    check(f"'{name}': the same inputs give the same key", again.dedupe_key, built.dedupe_key)
ok("an unknown template is refused, not guessed", not mail.TEMPLATES.get("no.such.template"))
check("template keys: name, record, recipient", mail.template_dedupe_key("transfer.decided", "tr_1", "source:o-1"),
      "transfer.decided:tr_1:source:o-1")
check("…and without a recipient", mail.template_dedupe_key("appeal.decided", "ap_9"), "appeal.decided:ap_9")

# ══════════════════════════════════════════════════════════════════════════════
# 5. The notice writer's contract and its idempotency on eventKey
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
first = run(notices.deliver_notice(
    "user-1", "warning_w-1", type="warning", title="Official warning",
    body="Contact someone@gmail.com is not allowed here.", related_id="w-1",
    email=notices.EmailLeg(template="user.warning", rows=[("Reference", "w-1")]),
))
doc = notice("warning_w-1") or {}
check("the in-app document is written under the eventKey", first["inApp"], True)
check("…addressed on userId (the field the rule reads)", doc.get("userId"), "user-1")
check("…carrying eventKey, type and relatedId", (doc.get("eventKey"), doc.get("type"), doc.get("relatedId")),
      ("warning_w-1", "warning", "w-1"))
check("…read AND isRead, both false", (doc.get("read"), doc.get("isRead")), (False, False))
ok("…createdAt is a timestamp", isinstance(doc.get("createdAt"), datetime))
ok("…an email address in free text is masked", "someone@gmail.com" not in doc.get("body", "")
   and "***@gmail.com" in doc.get("body", ""))
check("…delivery: in-app true, email sent", ((doc.get("delivery") or {}).get("inApp"),
                                             (doc.get("delivery") or {}).get("email")), (True, "sent"))
check("the email went to the person's VERIFIED address", PROVIDER.sent[-1]["to"], "user-1@x.test")
warn_rows = [r for r in rows() if (r.get("notice") or {}).get("eventKey") == "warning_w-1"]
check("one delivery row, linked to the notice", len(warn_rows), 1)
check("…keyed on the template and the record", warn_rows[0]["dedupe_key"], "user.warning:w-1")
ok("…with a retry recipe of plain values", warn_rows[0]["retry"]["template"] == "user.warning"
   and all(isinstance(v, (str, int, float, bool, list, type(None))) for v in warn_rows[0]["retry"]["params"].values()))

FS.collection("notifications").docs["warning_w-1"]["read"] = True       # the person reads it
FS.collection("notifications").docs["warning_w-1"]["isRead"] = True
sent_before = len(PROVIDER.sent)
again = run(notices.deliver_notice(
    "user-1", "warning_w-1", type="warning", title="Official warning", body="Changed wording",
    related_id="w-1", email=notices.EmailLeg(template="user.warning", rows=[("Reference", "w-1")]),
))
doc = notice("warning_w-1") or {}
check("a repeat lands on the SAME document", (again["inApp"], again["existed"]), (True, True))
check("…and never resets read / isRead", (doc.get("read"), doc.get("isRead")), (True, True))
check("…nor rewrites the body", "Changed wording" in doc.get("body", ""), False)
check("…and sends no second email", len(PROVIDER.sent), sent_before)
check("…while the notice still says the email was sent", again["email"], "sent")
check("one document per eventKey", sum(1 for k in FS.collection("notifications").docs if k == "warning_w-1"), 1)

skipped = run(notices.deliver_notice(
    "unverified-1", "warning_w-2", type="warning", title="Official warning", body="x", related_id="w-2",
    email=notices.EmailLeg(template="user.warning"),
))
check("no verified address → the email is skipped, not failed", skipped["email"], "skipped")
check("…and nothing was sent to the unverified address",
      any(s["to"] == "unverified-1@x.test" for s in PROVIDER.sent), False)

# Deterministic eventKeys from the domain helpers: a retried action, one notice.
reset_provider()
run(notices.account_restriction("user-2", "suspended", "Spam", "audit-77"))
run(notices.account_restriction("user-2", "suspended", "Spam", "audit-77"))
check("account_restriction keys on the audit entry", "account_suspended_audit-77" in FS.collection("notifications").docs,
      True)
check("…a retried suspension is one email", len([s for s in PROVIDER.sent if s["to"] == "user-2@x.test"]), 1)
check("…sent under the security identity, untracked", tracking_off(PROVIDER.sent[-1]), True)

# ══════════════════════════════════════════════════════════════════════════════
# 6. A failure is a retryable record; the business action is unaffected
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
BUSINESS: list[str] = []


async def a_business_action() -> str:
    """Commit the authoritative record FIRST, then tell the person — as every caller does."""
    await DB["business_records"].insert_one({"_id": "decision-1", "status": "decided"})
    BUSINESS.append("committed")
    await notices.appeal_decided("user-3", "ap-1", "upheld", "The evidence stands.")
    return "decided"


PROVIDER.raise_on_send = urllib.error.URLError("connection refused")      # SendGrid unreachable
outcome = run(a_business_action())
PROVIDER.raise_on_send = None
check("the business action completes although the email failed", outcome, "decided")
ok("…and its record stands", any(d.get("_id") == "decision-1" for d in DB["business_records"].docs))
failed = rows_for("appeal.decided:ap-1")
check("the failure is ONE recorded row", len(failed), 1)
check("…outcome failed, provider provably did not take it",
      (failed[0]["outcome"], bool(failed[0].get("provider_outcome_unknown"))), ("failed", False))
ok("…carrying its recipe", (failed[0].get("retry") or {}).get("template") == "appeal.decided")
check("…and the notice says the email is pending", (notice("appeal_decided_ap-1") or {}).get("delivery", {}).get("email"),
      "pending")
eligible, why = mail.retry_eligibility(failed[0], now=datetime.now(timezone.utc))
check("not retried before its window", eligible, False)
eligible, _ = mail.retry_eligibility(failed[0], now=datetime.now(timezone.utc) + timedelta(hours=2))
check("…retryable once due", eligible, True)

for r in rows_for("appeal.decided:ap-1"):
    r["retry_after"] = datetime.now(timezone.utc) - timedelta(minutes=1)
sent_before = len(PROVIDER.sent)
swept = run(mail.retry_failed())
check("the sweep re-sends it", [s.get("outcome") for s in swept if s.get("dedupe_key") == "appeal.decided:ap-1"],
      ["sent"])
check("…in place: still one row for the event", len(rows_for("appeal.decided:ap-1")), 1)
check("…now sent, counted as a retry", (rows_for("appeal.decided:ap-1")[0]["outcome"],
                                        rows_for("appeal.decided:ap-1")[0]["retry_count"]), ("sent", 1))
check("…one email on the wire", len(PROVIDER.sent) - sent_before, 1)
check("…and the notice's delivery state follows", (notice("appeal_decided_ap-1") or {})["delivery"]["email"], "sent")
check("a second sweep sends nothing more", [s for s in run(mail.retry_failed())
                                             if s.get("dedupe_key") == "appeal.decided:ap-1"
                                             and s.get("outcome") == "sent"], [])

# A provider that MAY have accepted it (500) is never re-sent: a duplicate cannot be taken back.
reset_provider()
PROVIDER.next_status = 500
run(notices.appeal_decided("user-4", "ap-2", "overturned", "Reviewed."))
PROVIDER.next_status = 202
unknown = rows_for("appeal.decided:ap-2")[0]
check("a 500 is recorded as outcome-unknown", bool(unknown.get("provider_outcome_unknown")), True)
check("…never eligible for a retry", mail.retry_eligibility(unknown, now=datetime.now(timezone.utc)
                                                             + timedelta(days=2))[0], False)
check("…and the notice says failed, not pending", (notice("appeal_decided_ap-2") or {})["delivery"]["email"], "failed")

# Firestore down: the notice is parked, the action stands, the sweep writes it later.
reset_provider()
FS.collection("notifications").fail_on("set", "appeal_received_ap-3")
FS.collection("notifications").fail_on("get", "appeal_received_ap-3")
parked = run(notices.deliver_notice(
    "user-5", "appeal_received_ap-3", type="appeal_received", title="Your appeal has been received",
    body="Filed.", related_id="ap-3", email=notices.EmailLeg(template="appeal.received"),
))
check("a failed in-app write is reported, not raised", (parked["inApp"], parked["parked"]), (False, True))
check("…the email leg still ran", parked["email"], "sent")
outbox = [d for d in DB[notices.NOTICE_OUTBOX].docs if d.get("_id") == "appeal_received_ap-3"]
check("…the notice is parked under its eventKey", len(outbox), 1)
check("…pending", outbox[0]["status"], "pending")
FS.collection("notifications").clear_failures()
retried = run(notices.retry_parked())
check("the sweep writes the parked notice", [r["outcome"] for r in retried if r["eventKey"] == "appeal_received_ap-3"],
      ["in_app_written"])
written = notice("appeal_received_ap-3") or {}
check("…with the full contract", (written.get("userId"), written.get("eventKey"), written.get("read"),
                                  written.get("isRead")), ("user-5", "appeal_received_ap-3", False, False))
check("…and the email state it had", written.get("delivery", {}).get("email"), "sent")
check("…and the outbox row is closed", [d["status"] for d in DB[notices.NOTICE_OUTBOX].docs
                                        if d.get("_id") == "appeal_received_ap-3"], ["written"])
from app.services import scheduling  # noqa: E402

ok("both retries are registered sweeps",
   {"email_retries", "notice_retries"} <= {name for name, _s, _f in scheduling.SWEEPS})

# A template bug or a database refusal is a returned failure, never an exception.
broken = run(mail.send_template("no.such.template", owner(), {"title": "x"}))
check("an unknown template comes back as a failure, not an exception", broken["outcome"], "failed")

# ══════════════════════════════════════════════════════════════════════════════
# 7. Who is told — affected parties, the Owners, and one email per event
# ══════════════════════════════════════════════════════════════════════════════

reset_provider()
ok_approved = run(notices.partner_approved("u-agency-1", "agency", "AG-1"))
doc = notice("partner_approved_AG-1") or {}
check("an agency approval is written in-app", ok_approved, True)
check("…but carries no second email: the Functions trigger owns it",
      (doc["delivery"]["email"], doc["delivery"].get("emailVia")),
      ("skipped", notices.EMAIL_VIA_FUNCTIONS_APPROVED))
check("…nothing sent from here", len(PROVIDER.sent), 0)
run(notices.partner_rejected("u-seller-1", "seller", "SL-1", "Documents unreadable"))
check("a seller rejection: the 8A.2.5 sweep owns the email",
      (notice("partner_rejected_SL-1") or {})["delivery"].get("emailVia"), notices.EMAIL_VIA_SWEEP_REJECTED)
run(notices.partner_suspended("u-agency-1", "agency", "AG-1", "Late statements"))
check("an agency deactivation: the 8A.2.13 sweep owns the email",
      (notice("partner_suspended_AG-1") or {})["delivery"].get("emailVia"), notices.EMAIL_VIA_SWEEP_DEACTIVATED)
run(notices.partner_submitted("u-agency-2", "sub_agency", "AG-2"))
check("a sub-agency application: the Functions onCreate trigger owns the receipt",
      (notice("partner_submitted_AG-2") or {})["delivery"].get("emailVia"), notices.EMAIL_VIA_FUNCTIONS_REGISTERED)
check("…still nothing sent from here", len(PROVIDER.sent), 0)
run(notices.host_application_approved("u-host-1", "HA-1"))
check("a Host approval (no other sender) is emailed from here", [s["to"] for s in PROVIDER.sent], ["u-host-1@x.test"])

# The Owners as a group: one notice and one email each, keyed per Owner.
from app.services import notify  # noqa: E402

OWNERS = [owner("u-owner-1", "owner1@zipperlive.org"), owner("u-owner-2", "owner2@zipperlive.org")]


async def _owners(_roles):
    return list(OWNERS)


notify.staff_with_roles = _owners  # type: ignore[assignment]
reset_provider()
told = run(notices.notify_owners("dept_vacancy:finance:1", type="department_vacancy", title="Finance has no Admin",
                                 body="Members report to the Owner.", template="department.vacancy",
                                 related_id="finance:1", rows=[("Department", "Finance")]))
check("every Owner gets an in-app notice", sorted(told["notified"]), ["u-owner-1", "u-owner-2"])
check("…keyed per Owner", sorted(k for k in FS.collection("notifications").docs if k.startswith("dept_vacancy:")),
      ["dept_vacancy:finance:1:u-owner-1", "dept_vacancy:finance:1:u-owner-2"])
check("…and one email each", sorted(s["to"] for s in PROVIDER.sent), ["owner1@zipperlive.org", "owner2@zipperlive.org"])
run(notices.notify_owners("dept_vacancy:finance:1", type="department_vacancy", title="Finance has no Admin",
                          body="Members report to the Owner.", template="department.vacancy",
                          related_id="finance:1"))
check("a repeat of the same event sends nothing more", len(PROVIDER.sent), 2)

# Transfers reach the affected person and the agencies (PARTNER_OWN, never withheld).
reset_provider()
run(notices.transfer_requested_person("u-host-9", "host", "TR-1", "Main A", "Main B"))
check("the affected Host is emailed about a requested transfer", [s["to"] for s in PROVIDER.sent], ["u-host-9@x.test"])
check("…not withheld by the internal-only gate", rows_for("transfer.requested:TR-1:u-host-9")[0]["outcome"], "sent")

# ══════════════════════════════════════════════════════════════════════════════
# 8. scripts/email_identity_check.py --dry-run
# ══════════════════════════════════════════════════════════════════════════════

from scripts import email_identity_check as identity_check  # noqa: E402

buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = identity_check.main(["--dry-run"])
out = buf.getvalue()
check("the dry run exits 0", code, 0)
for needle in ("EMAIL_IDENTITY_INFO_ENABLED", "EMAIL_IDENTITY_SUPPORT_ENABLED", "no-reply@zipperlive.org",
               "s1._domainkey.zipperlive.org", "s2._domainkey.zipperlive.org", "include:sendgrid.net",
               "_dmarc.zipperlive.org", "Reply-To", "dig +short"):
    ok(f"the dry run prints {needle}", needle in out)
for name in mail.TEMPLATES:
    ok(f"…and lists template {name}", name in out)
ok("…and never the API key", API_KEY not in out)
check("…which it reports only as set", "SendGrid API key                   = set" in out, True)
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    check("without --dry-run it refuses (there is no live mode)", identity_check.main([]), 2)
settings.mail_from_support = "someone.personal@gmail.com"
masked = "\n".join(identity_check.report())
ok("a personal mailbox configured anywhere is printed masked", "someone.personal@gmail.com" not in masked
   and "***@gmail.com" in masked)
settings.mail_from_support = ""

# ══════════════════════════════════════════════════════════════════════════════

ROOT_LOGGER.removeHandler(LOGS)

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} email-identity checks passed.")
print("  · auth/security/transactional from no-reply@; info@/support@ only when switched on; no Reply-To")
print("  · tracking off on the wire for auth and security; no code, link or key in any log or row")
print("  · every §12 template renders with a deterministic dedupe key")
print("  · one notice writer: full contract, idempotent on eventKey, read never reset")
print("  · email failure → retryable row, re-sent in place; Firestore failure → parked, written later")
print("  · the business action is never affected; one email per event; Owners told one each")
print("  · the identity check dry run prints the DNS checklist and no secret")
sys.exit(0)
