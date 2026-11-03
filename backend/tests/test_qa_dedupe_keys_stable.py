"""E2E round 2 (3 Nov 2026) — an email's dedupe key does not follow the display format.

Found on the local copy: the transactional sweep (`rejections`, 30-day window)
mailed "Your coin seller application was not approved" to an applicant who had
been mailed it the day before. Four senders built their `dedupe_key` from
`when()` — the words a person reads — and QA #54 changed those words from UTC
("02 Nov 2026, 22:03 UTC") to IST ("3 Nov 2026, 3:33 am IST"). Every key changed
with them, so after the deploy the sweep would send again every "approved",
"not approved", "deactivated" and "credit due soon" email still in its window.

Pinned here:

  * `dedupe_stamp` writes exactly what the keys were recorded with before QA #54
    (UTC), for every kind of value the senders pass;
  * an email recorded before the deploy, with the old key, is refused as a
    duplicate by the new code — the provider is not called — for all four;
  * the email still SHOWS the time in IST (QA #54 is kept);
  * no `dedupe_key` anywhere in the backend is built from `when(` again.

REAL: `app.services.email` senders and `deliver`, over the in-memory Mongo with
its unique index on `email_deliveries.dedupe_key` and the fake provider
(tests/harness.py).

    python3 -m tests.test_qa_dedupe_keys_stable
"""

from __future__ import annotations

import ast
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs  # noqa: E402

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
settings.sendgrid_api_key = "SG.test-key-for-the-fake-provider-only.000"
settings.mail_from = "no-reply@zipperlive.org"
settings.environment = "test"

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def run(coro):
    return asyncio.run(coro)


def legacy_when(value, *, with_time: bool = True) -> str:
    """`email.when` as it was before QA #54 (git HEAD cf64145) — what production keys hold."""
    if value is None:
        return "—"
    if not isinstance(value, datetime):
        return str(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%d %b %Y, %H:%M UTC" if with_time else "%d %b %Y")


# ── 1. The stamp is the pre-QA #54 text, for every value a sender passes ──────
IST = timezone(timedelta(hours=5, minutes=30))
samples = [
    datetime(2026, 11, 2, 22, 3, tzinfo=timezone.utc),         # the rejection seen locally
    datetime(2026, 11, 2, 22, 3),                               # naive: read as UTC
    datetime(2026, 11, 3, 3, 33, tzinfo=IST),                   # the same moment, in IST
    datetime(2026, 1, 5, 0, 5, tzinfo=timezone.utc),            # single-digit day and hour
    None,
    "2026-11-02T22:03:00Z",                                     # a value that is not a datetime
]
for value in samples:
    eq(f"dedupe_stamp({value!r}) is the pre-QA #54 text", mail.dedupe_stamp(value), legacy_when(value))
    eq(f"…date only too ({value!r})", mail.dedupe_stamp(value, with_time=False), legacy_when(value, with_time=False))
eq("the local case, word for word", mail.dedupe_stamp(samples[0]), "02 Nov 2026, 22:03 UTC")
ok("…while what a person reads stays IST (QA #54)", mail.when(samples[0]) == "3 Nov 2026, 3:33 am IST",
   mail.when(samples[0]))


# ── 2. An email recorded before the deploy is not sent again ──────────────────
def recipient(address: str, role: str = str(Role.SELLER)) -> mail.Recipient:
    return mail.Recipient(email=address, name="QA Applicant", role=role, uid="u-applicant")


AT = datetime(2026, 11, 2, 22, 3, tzinfo=timezone.utc)
DUE = datetime(2026, 11, 9, 18, 30, tzinfo=timezone.utc)
cases = [
    ("partner.approved", "seller_1", AT,
     lambda: mail.send_partner_approved(recipient=recipient("a@example.com"), partner_id="seller_1",
                                        kind="seller", approved_at=AT)),
    ("partner.rejected", "seller_2", AT,
     lambda: mail.send_partner_rejected(recipient=recipient("b@example.com"), partner_id="seller_2",
                                        kind="seller", reason="The ID photo is not readable.", rejected_at=AT)),
    ("partner.deactivated", "seller_3", AT,
     lambda: mail.send_account_deactivated(recipient=recipient("c@example.com"), partner_id="seller_3",
                                           kind="seller", reason="Repeated payment disputes.",
                                           deactivated_at=AT)),
]
for kind, pid, at, sender in cases:
    old_key = f"{kind}:{pid}:{legacy_when(at)}"
    # An explicit _id, as every real row has (the fake skips id-less rows in its unique check).
    DB.seed(C.EMAIL_DELIVERIES, [{"_id": f"pre-deploy-{kind}", "dedupe_key": old_key, "kind": kind,
                                  "outcome": str(mail.Outcome.SENT), "recorded_by": "the release before QA #54"}])
    before = len(PROVIDER.sent)
    out = run(sender())
    eq(f"{kind}: recorded before the deploy → refused as a duplicate", out.get("outcome"), str(mail.Outcome.DUPLICATE))
    eq(f"{kind}: …and the provider was not called", len(PROVIDER.sent) - before, 0)
    eq(f"{kind}: …one row for the event, not two",
       sum(1 for r in DB[C.EMAIL_DELIVERIES].docs if str(r.get("dedupe_key", "")).startswith(f"{kind}:{pid}:")), 1)

# Credit due soon: the key carries the due DATE (no time).
old_credit = f"credit.due_soon:seller_4:{legacy_when(DUE, with_time=False)}"
DB.seed(C.EMAIL_DELIVERIES, [{"_id": "pre-deploy-credit", "dedupe_key": old_credit, "kind": "credit.due_soon",
                               "outcome": str(mail.Outcome.SENT)}])
before = len(PROVIDER.sent)
credit = run(mail.send_credit_due(recipient=recipient("d@example.com"), seller_id="seller_4",
                                  outstanding_coins=1200, due_at=DUE, days=3))
eq("credit.due_soon: recorded before the deploy → refused as a duplicate", credit.get("outcome"),
   str(mail.Outcome.DUPLICATE))
eq("credit.due_soon: …and the provider was not called", len(PROVIDER.sent) - before, 0)

# A NEW event goes out once, shows IST, and is keyed in the stable form.
fresh_at = datetime(2026, 11, 3, 13, 48, tzinfo=timezone.utc)
before = len(PROVIDER.sent)
fresh = run(mail.send_partner_rejected(recipient=recipient("e@example.com"), partner_id="seller_5", kind="seller",
                                       reason="E2E round 2: a generated test image.", rejected_at=fresh_at))
eq("a new rejection is sent", fresh.get("outcome"), str(mail.Outcome.SENT))
row = next(r for r in DB[C.EMAIL_DELIVERIES].docs if str(r.get("dedupe_key", "")).startswith("partner.rejected:seller_5:"))
eq("…keyed with the stable UTC stamp", row["dedupe_key"], "partner.rejected:seller_5:03 Nov 2026, 13:48 UTC")
ok("…and the email says the time in IST", "3 Nov 2026, 7:18 pm IST" in PROVIDER.sent[-1]["html"])
again = run(mail.send_partner_rejected(recipient=recipient("e@example.com"), partner_id="seller_5", kind="seller",
                                       reason="E2E round 2: a generated test image.", rejected_at=fresh_at))
eq("…and the sweep's next run does not send it again", [again.get("outcome"), len(PROVIDER.sent) - before],
   [str(mail.Outcome.DUPLICATE), 1])

# ── 3. No dedupe key is built from the display format again ───────────────────
offenders: list[str] = []
for path in (ROOT / "app").rglob("*.py"):
    if "__pycache__" in str(path):
        continue
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.keyword) or node.arg != "dedupe_key":
            continue
        for sub in ast.walk(node.value):
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id in {"when", "date_label"}:
                offenders.append(f"{path.relative_to(ROOT)}:{node.value.lineno}")
eq("no dedupe_key is built from when() (the words a person reads)", offenders, [])

print()
if failures:
    print(f"{len(failures)} of {checks} stable dedupe-key checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} stable dedupe-key checks passed.")
print("  · E2E round 2: an email recorded before the IST change is not sent again; keys no longer follow the display")
