"""The REAL SendGrid SDK against a local HTTP server — what actually goes over the wire.

`tests/test_sendgrid_delivery.py` drives the code with a fake SDK. This module
drives it with the real one — sendgrid 6.11.0 over python-http-client 3.3.7 —
pointed at a server on 127.0.0.1 that answers as the test scripts it. No other
host is contacted. What is asserted:

  * the JSON SendGrid would receive: the From (address and name), the plain-text
    and HTML parts, `tracking_settings` with click, open, subscription and
    Google Analytics tracking all disabled for authentication mail and absent
    for everything else, and the Reply-To;
  * the real exceptions are classified as designed: 400 and 401 are permanent
    (one request); 429 and 503 are retried (two requests, one accepted); 500 is
    an unknown outcome (one request, never repeated); a server that reads the
    whole request and never answers is an unknown outcome after exactly ONE
    request; a closed port (urllib's URLError — nothing was sent) is retried;
  * the API key reaches the server in the Authorization header and nowhere
    else: no log record carries it, nor the sign-in code, even with the root
    logger at DEBUG — the SDK's HTTP layer logs every request body and header
    at DEBUG, which is why `app/services/email.py` pins it at WARNING.

Settings: the real pydantic-settings when it is installed (the exact-dependency
venv), where the SENDGRID_* environment names are also read for real; the
test stand-ins otherwise, and that one sub-check is then reported NOT RUN.

Run:  python3 -m tests.test_sendgrid_sdk_http
"""

from __future__ import annotations

import json
import logging
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    import pydantic_settings  # noqa: F401

    REAL_SETTINGS = True
except ImportError:
    REAL_SETTINGS = False
    from tests.harness import install_stubs  # noqa: E402

    install_stubs()

try:
    import sendgrid  # noqa: F401
    import python_http_client  # noqa: F401
except ImportError as exc:  # pragma: no cover - environment problem, not a pass
    print(f"FAILED: the real SendGrid SDK is not importable ({exc}); this module needs it.")
    sys.exit(2)

from app import config as cfg  # noqa: E402
from app.config import settings  # noqa: E402
from app.services import email as mail  # noqa: E402

API_KEY = "SG.FAKE-TEST-KEY-0123456789.sdk-http"
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
settings.email_timeout_seconds = 2
settings.observer_email = "observer@zipper.example"
settings.observer_otp_delivery_email = "observer-codes@zipper.example"

SLEEPS: list[float] = []
mail._sleep = lambda s: SLEEPS.append(round(float(s), 3))  # retry waits are recorded, not slept
mail._jitter = lambda: 0.0

BLOCKING_ROWS: list[dict] = []
mail._record_blocking = lambda doc: (BLOCKING_ROWS.append(dict(doc)), len(BLOCKING_ROWS) - 1)[1]  # type: ignore[assignment]
mail._close_blocking = lambda rid, patch: BLOCKING_ROWS[rid].update(patch) if rid is not None else None  # type: ignore[assignment]


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


# ── The local "SendGrid" ──────────────────────────────────────────────────────


class Server:
    def __init__(self) -> None:
        self.script: list[tuple] = []
        self.requests: list[dict] = []
        self.release = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args) -> None:  # silence the server's own log
                return

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw.decode("utf-8"))
                except ValueError:
                    body = None
                outer.requests.append(
                    {"path": self.path, "authorization": self.headers.get("Authorization"), "json": body}
                )
                step = outer.script.pop(0) if outer.script else ("respond", 202, b"", {"X-Message-Id": "srv-0"})
                if step[0] == "hang":
                    # Read everything, answer nothing: the request was taken.
                    outer.release.wait(15)
                    self.close_connection = True
                    return
                _, status, payload, headers = step
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def reset(self, *steps: tuple) -> None:
        self.script[:] = list(steps)
        self.requests.clear()
        self.release.clear()
        SLEEPS.clear()

    def stop(self) -> None:
        self.release.set()
        self.httpd.shutdown()
        self.httpd.server_close()


def ok_step(status: int = 202, message_id: str = "srv-1") -> tuple:
    return ("respond", status, b"", {"X-Message-Id": message_id})


def error_step(status: int, message: str) -> tuple:
    payload = json.dumps({"errors": [{"message": message, "field": None, "help": None}]}).encode()
    return ("respond", status, payload, {"Content-Type": "application/json"})


SERVER = Server()
mail._PROVIDER_HOST = f"http://127.0.0.1:{SERVER.port}"

failures: list[str] = []
checks = 0
not_run: list[str] = []


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


def provider_send(*, track: bool = True, retry: bool = True, to: str = "owner@example.com",
                  html: str = "<p>Hello <b>there</b></p>") -> "mail.ProviderResult":
    return mail._send_via_provider(
        to_email=to, to_name="An Owner", subject="A subject", html=html,
        attachments=(), identity=mail.SenderIdentity.TRANSACTIONAL, track=track, retry=retry,
    )


# ══════════════════════════════════════════════════════════════════════════════
# 1. What goes over the wire
# ══════════════════════════════════════════════════════════════════════════════

SERVER.reset(ok_step())
auth = provider_send(track=False)
check("202: accepted", auth.ok, True)
check("…in one request", len(SERVER.requests), 1)
check("…to the Mail Send path", SERVER.requests[0]["path"], "/v3/mail/send")
check("…with the key in the Authorization header, where it belongs",
      SERVER.requests[0]["authorization"], f"Bearer {API_KEY}")
sent = SERVER.requests[0]["json"] or {}
check("From is no-reply@zipperlive.org, \"ZIPPER Live\"", sent.get("from"),
      {"email": "no-reply@zipperlive.org", "name": "ZIPPER Live"})
check("a plain-text part first, then HTML", [c.get("type") for c in sent.get("content", [])],
      ["text/plain", "text/html"])
check("tracking is off — click (and text), open, subscription and Google Analytics",
      sent.get("tracking_settings"),
      {
          "click_tracking": {"enable": False, "enable_text": False},
          "open_tracking": {"enable": False},
          "subscription_tracking": {"enable": False},
          "ganalytics": {"enable": False},
      })
check("no Reply-To on the wire (spec §12: never set, on any identity)",
      sent.get("reply_to"), None)
check("the message id SendGrid returned is kept", auth.message_id, "srv-1")

SERVER.reset(ok_step())
notice = provider_send(track=True)
check("a notice is accepted", notice.ok, True)
ok("…and carries no tracking_settings at all — the account default applies",
   "tracking_settings" not in (SERVER.requests[0]["json"] or {}))


# ══════════════════════════════════════════════════════════════════════════════
# 2. The real exceptions, classified
# ══════════════════════════════════════════════════════════════════════════════

for status, message in ((400, "Does not contain a valid address."),
                        (401, "The provided authorization grant is invalid, expired, or revoked")):
    SERVER.reset(error_step(status, message), ok_step())
    res = provider_send()
    check(f"{status}: permanent failure", res.ok, False)
    check(f"{status}: exactly one request", len(SERVER.requests), 1)
    check(f"{status}: one attempt", res.attempts, 1)
    check(f"{status}: the status is kept", res.status, status)
    ok(f"{status}: SendGrid's words are kept", message in (res.error or ""))
    check(f"{status}: not unknown", res.outcome_unknown, False)
    ok(f"{status}: and the key is in no field of the result", API_KEY not in repr(res))

for status in (429, 503):
    SERVER.reset(error_step(status, "try later"), ok_step(message_id="srv-2"))
    res = provider_send()
    check(f"{status} then 202: accepted", res.ok, True)
    check(f"{status} then 202: two requests reached the server", len(SERVER.requests), 2)
    check(f"{status} then 202: two attempts", res.attempts, 2)
    check(f"{status} then 202: after a 1 s wait", SLEEPS, [1.0])
    check(f"{status} then 202: the accepted message's id", res.message_id, "srv-2")

SERVER.reset(error_step(500, "internal error"), ok_step())
res = provider_send()
check("500: failed", res.ok, False)
check("500: exactly one request — never repeated", len(SERVER.requests), 1)
check("500: outcome unknown", res.outcome_unknown, True)

SERVER.reset(("hang",), ok_step())
started = time.monotonic()
res = provider_send()
elapsed = time.monotonic() - started
SERVER.release.set()
check("a server that took the request and never answered: failed", res.ok, False)
check("…after exactly ONE request — a timeout is never retried", len(SERVER.requests), 1)
check("…outcome unknown", res.outcome_unknown, True)
check("…one attempt", res.attempts, 1)
ok("…classified from the real exception (a timeout)",
   res.attempt_log and res.attempt_log[0]["error"] in {"TimeoutError", "timeout"})
ok("…within the per-attempt timeout (2 s here), not the old 20 s", elapsed < 10)
ok("…and the row text says it may have arrived", "Outcome unknown" in (res.error or ""))

probe = socket.socket()
probe.bind(("127.0.0.1", 0))
closed_port = probe.getsockname()[1]
probe.close()
mail._PROVIDER_HOST = f"http://127.0.0.1:{closed_port}"
SERVER.reset()
res = provider_send()
mail._PROVIDER_HOST = f"http://127.0.0.1:{SERVER.port}"
check("a closed port (nothing was sent): failed", res.ok, False)
check("…retried up to EMAIL_MAX_ATTEMPTS", res.attempts, 3)
check("…every attempt a URLError, classified retryable",
      [(a["error"], a["class"]) for a in res.attempt_log], [("URLError", "retryable")] * 3)
check("…waiting 1 s then 2 s", SLEEPS, [1.0, 2.0])
check("…not unknown: SendGrid never received anything", res.outcome_unknown, False)
check("…and the live server saw nothing", len(SERVER.requests), 0)

SERVER.reset(error_step(503, "busy"), ok_step())
res = provider_send(retry=False)
check("retry=False (bulk): one request even on a 503", len(SERVER.requests), 1)
check("…one attempt", res.attempts, 1)


# ══════════════════════════════════════════════════════════════════════════════
# 3. The observer code and the key, through the real SDK, with DEBUG logging on
# ══════════════════════════════════════════════════════════════════════════════

CODE = "604871"
SERVER.reset(ok_step(message_id="srv-otp"))
delivered = mail.send_observer_otp(CODE, 10)
check("the observer code is delivered through the real SDK", delivered, True)
body = SERVER.requests[0]["json"] if SERVER.requests else {}
ok("…the code is in the message body", CODE in json.dumps(body))
check("…to the delivery mailbox", (body or {}).get("personalizations", [{}])[0].get("to"),
      [{"email": "observer-codes@zipper.example", "name": "Observer"}])
check("…untracked", (body or {}).get("tracking_settings", {}).get("open_tracking"), {"enable": False})
ok("the code is in no log record", not any(CODE in line for line in LOGS.lines))
ok("the API key is in no log record", not any(API_KEY in line for line in LOGS.lines))
ok("the SDK's request lines (PAYLOAD / HEADERS) are not emitted",
   not any("PAYLOAD" in line or "HEADERS" in line for line in LOGS.lines))
check("python_http_client stays at WARNING with the root logger at DEBUG",
      logging.getLogger("python_http_client.client").getEffectiveLevel(), logging.WARNING)


# ══════════════════════════════════════════════════════════════════════════════
# 4. The SENDGRID_* environment names, read by the real settings class
# ══════════════════════════════════════════════════════════════════════════════

if REAL_SETTINGS:
    saved = {k: os.environ.get(k) for k in ("SENDGRID_FROM_EMAIL", "SENDGRID_FROM_NAME", "EMAIL_PROVIDER", "MAIL_FROM")}
    os.environ.update({
        "SENDGRID_FROM_EMAIL": "no-reply@zipperlive.org",
        "SENDGRID_FROM_NAME": "ZIPPER Live",
        "EMAIL_PROVIDER": "sendgrid",
        "MAIL_FROM": "old@zipper.example",
    })
    try:
        real = cfg.apply_sendgrid_names(cfg.Settings(_env_file=None))
        check("real settings: SENDGRID_FROM_EMAIL from the environment wins over MAIL_FROM",
              real.mail_from, "no-reply@zipperlive.org")
        check("real settings: SENDGRID_FROM_NAME from the environment", real.mail_from_name, "ZIPPER Live")
        check("real settings: EMAIL_PROVIDER from the environment", real.email_provider, "sendgrid")
        check("real settings: no Reply-To configured", real.mail_from_support, "")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
else:
    not_run.append("SENDGRID_* names read from the environment by the real pydantic-settings "
                   "(not installed here; runs on the exact-dependency venv)")


# ══════════════════════════════════════════════════════════════════════════════

SERVER.stop()
ROOT_LOGGER.removeHandler(LOGS)

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} real-SDK checks passed ({'real' if REAL_SETTINGS else 'stand-in'} settings).")
for item in not_run:
    print(f"  NOT RUN: {item}")
print("  · From, text+HTML, Reply-To and tracking_settings exactly as SendGrid receives them")
print("  · 400/401 one request; 429/503 retried; 500 and a silent server never repeated")
print("  · a closed port (URLError) is retried; the key goes only in the Authorization header")
print("  · no code, key or SDK request line in any log record with the root logger at DEBUG")
sys.exit(0)
