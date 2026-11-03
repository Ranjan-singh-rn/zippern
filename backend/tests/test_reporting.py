"""Scheduled reports, partner statements and the transactional sweep.

Spec 8A.3.1 – 8A.3.3 (daily), 8A.3.6 / 8A.3.7 / 8A.3.10 (statements),
8A.3.9 – 8A.3.12 (monthly), 8A.6.5 (a report never sends blank or zero), and
the 8A.2 triggers that 10.20 and 10.22 say do not exist.

**What is real and what is not.** `app/services/scheduling.py` is the real
module under test, unmodified: the periods, the audiences, the section
handling, the dedupe keys and the sweeps are all its own. The *report
functions* it calls — `cash_position`, `margin_report`,
`agency_statement_range` and the rest — are replaced with stand-ins that return
real `reports.Report` objects, or raise the real `reports.ReportError`.

That boundary is deliberate. `reports.py` computes its figures with `$facet`,
`$lookup`, `$dateTrunc` and `$switch` inside MongoDB; a fake that reimplemented
those would be a second implementation of exactly the arithmetic 8A.6.3 exists
to keep singular. What matters here is the contract: scheduling asks the report
service for every figure and never works one out, a section that refuses is
printed as a refusal, and a section that is empty says so instead of showing
zero. The last check in this file asserts the first half of that statically —
`scheduling.py` contains no money arithmetic of its own.

Run:  python3 -m tests.test_reporting
"""

from __future__ import annotations

import asyncio
import re
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
CURRENT: dict[str, FakeDb] = {"db": DB}
mongo.get_db = lambda: CURRENT["db"]  # type: ignore[assignment]


def use(db: FakeDb) -> None:
    CURRENT["db"] = db


from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import email as mail  # noqa: E402
from app.services import money as money_svc  # noqa: E402
from app.services import notify  # noqa: E402
from app.services import reports as rpt  # noqa: E402
from app.services import scheduling  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()
PROVIDER.next_status = 202

settings.sendgrid_api_key = "SG.reporting-test-key.000000000000"
settings.environment = "test"

NOW = datetime.now(timezone.utc)

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


def bodies() -> list[str]:
    return [s["html"] for s in PROVIDER.sent]


def report_of(result: dict, key: str) -> dict:
    for entry in result["reports"]:
        if entry.get("report") == key:
            return entry
    raise AssertionError(f"no report {key} in {[r.get('report') for r in result['reports']]}")


# ══════════════════════════════════════════════════════════════════════════════
# Stand-ins for the report service
# ══════════════════════════════════════════════════════════════════════════════

RATES = rpt.Rates(
    diamond_pack_price_inr_per_lakh=2390.0,
    # No seller discount configured: wholesale equals retail, which is
    # what these figures were all computed against before the wholesale
    # price existed. Nothing in this file is testing the discount.
    seller_wholesale_price_inr_per_lakh=2390.0,
    bean_to_inr=0.01,
    source="firestore",
    provisional=False,
    missing=[],
    note="Rates read from Firestore appConfig/economy.",
    fetched_at=NOW,
)


def money_report(name: str, title: str, since, until, total: int) -> rpt.Report:
    return rpt.Report(
        name=name,
        title=title,
        period={
            "since": since,
            "until": until,
            "bounds": "[since, until) — start inclusive, end exclusive",
        },
        columns=[("line", "Line"), ("channel", "Channel"), ("inr_minor", "INR (minor)")],
        rows=[
            {"line": "receipt", "channel": "direct", "inr_minor": total // 2},
            {"line": "receipt", "channel": "reseller", "inr_minor": total - total // 2},
        ],
        totals={"receipts_inr_minor": total, "net_inr_minor": total},
        rates=RATES.as_dict(),
    )


def empty_report(name: str, title: str, since, until) -> rpt.Report:
    report = rpt.Report(
        name=name,
        title=title,
        period={"since": since, "until": until, "bounds": "[since, until)"},
        columns=[("line", "Line"), ("inr_minor", "INR (minor)")],
        rows=[],
        totals={},
        rates=RATES.as_dict(),
    )
    report.note_if_empty(
        "No receipt and no executed payout falls in this period. This is an "
        "empty period, not a measured zero."
    )
    return report


class Stubs:
    """What each report function does on the next call."""

    def __init__(self) -> None:
        self.fail: set[str] = set()
        self.empty: set[str] = set()
        self.calls: list[str] = []

    def install(self) -> None:
        for fname in (
            "cash_position", "channel_breakdown", "revenue_summary",
            "payout_summary", "margin_report", "outstanding_liabilities",
            "all_partners_summary", "audit_summary", "team_throughput",
            "dashboard", "agency_statement_range", "seller_statement_range",
        ):
            setattr(rpt, fname, self._make(fname))
        rpt.load_rates = self._rates

    async def _rates(self):
        self.calls.append("load_rates")
        return RATES

    def _make(self, fname: str):
        async def fn(*args, **kwargs):
            self.calls.append(fname)
            if fname in self.fail:
                raise rpt.ReportError(
                    f"{fname} could not be produced: the ledger is not "
                    "reachable, so no figure is available. Nothing is reported "
                    "as zero."
                )
            since = NOW - timedelta(days=1)
            until = NOW
            for arg in args:
                if isinstance(arg, datetime):
                    since, until = arg, until
                    break
            if fname in self.empty:
                return empty_report(fname, fname.replace("_", " ").title(), since, until)
            return money_report(
                fname, fname.replace("_", " ").title(), since, until, 16_750_000
            )

        return fn


STUBS = Stubs()
STUBS.install()

# The Firestore lookup a partner's address comes from.
PARTNER_DOCS = {
    ("agencies", "ag_4821"): {"agencyName": "Acme Talent",
                              "ownerEmail": "acme@partner.test"},
    ("agencies", "ag_9002"): {"agencyName": "Northern", "ownerEmail": "north@partner.test"},
    ("agencies", "ag_noemail"): {"agencyName": "Silent Agency"},   # no address at all
    ("sellers", "sl_119"): {"displayName": "Ravi Traders",
                            "ownerEmail": "ravi@partner.test"},
}
notify._read_partner_doc = lambda collection, pid: PARTNER_DOCS.get((collection, pid), {})


async def _balance(holder_type, holder_id, currency, session=None):
    return {"ag_9002": 15_00_000}.get(str(holder_id), 0)


money_svc.get_balance = _balance


# ══════════════════════════════════════════════════════════════════════════════
# The staff record
# ══════════════════════════════════════════════════════════════════════════════

STAFF = [
    {"uid": "u-owner-1", "email": "owner1@zipper.test", "name": "Tanishque",
     "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-owner-2", "email": "owner2@zipper.test", "name": "Soumya",
     "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-observer", "email": "observer@zipper.test", "name": "Observer",
     "role": str(Role.OBSERVER), "is_active": True},
    {"uid": "u-fin", "email": "finance@zipper.test", "name": "Priya",
     "role": str(Role.FINANCE_ADMIN), "is_active": True},
]
DB.seed(C.STAFF, STAFF)
DB.seed(
    C.PARTNERS,
    [
        {"_id": "ag_4821", "kind": "agency", "name": "Acme Talent",
         "status": "approved", "is_active": True,
         "created_at": NOW - timedelta(hours=6),
         "source": {"firestore_collection": "agencies"}},
        {"_id": "ag_noemail", "kind": "agency", "name": "Silent Agency",
         "status": "approved", "is_active": True,
         "created_at": NOW - timedelta(hours=6),
         "source": {"firestore_collection": "agencies"}},
        {"_id": "sl_119", "kind": "seller", "name": "Ravi Traders",
         "status": "approved", "is_active": True,
         "created_at": NOW - timedelta(days=40),
         "source": {"firestore_collection": "sellers"},
         "credit": {"outstanding": 250_000, "due_at": NOW + timedelta(days=2)}},
    ],
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Periods are half-open, correct, and cut in the reader's calendar
# ══════════════════════════════════════════════════════════════════════════════
#
# The windows are stored and queried in UTC and *decided* in REPORT_TIMEZONE
# (Asia/Kolkata, UTC+05:30). At that offset, local midnight is 18:30 UTC the
# evening before — so a daily report covering [00:00 UTC, 24:00 UTC) would drop
# the whole of yesterday evening, the busiest part of the day for this business,
# and fold this morning in instead. These checks are written in UTC on purpose:
# they are checking the conversion, not restating it.

IST = timezone(timedelta(hours=5, minutes=30))

check("the business clock is the owner's", settings.report_timezone, "Asia/Kolkata")

# 09:30 UTC on 1 March is 15:00 IST on 1 March, so "yesterday" is 28 February.
since, until = scheduling.yesterday(datetime(2026, 3, 1, 9, 30, tzinfo=timezone.utc))
check("yesterday starts at local midnight", since,
      datetime(2026, 2, 27, 18, 30, tzinfo=timezone.utc))
check("…and ends at local midnight today", until,
      datetime(2026, 2, 28, 18, 30, tzinfo=timezone.utc))
check("…which is 28 February where the reader is",
      since.astimezone(IST), datetime(2026, 2, 28, tzinfo=IST))
check("…and it is exactly one day long", until - since, timedelta(days=1))
check("…and the period key names the day the reader lived",
      scheduling.day_key(since), "2026-02-28")

# The hour that would be lost if the day were cut in UTC: 22:00 IST on the 28th.
peak = datetime(2026, 2, 28, 22, 0, tzinfo=IST).astimezone(timezone.utc)
ok("yesterday evening is inside yesterday", since <= peak < until)
# …and the hour that would wrongly be pulled in: 02:00 IST on the 1st.
this_morning = datetime(2026, 3, 1, 2, 0, tzinfo=IST).astimezone(timezone.utc)
ok("this morning is not", not (since <= this_morning < until))

# A run just after local midnight still reports the day that just ended, not the
# one before it — the 05:30 window where a UTC cut and a local cut disagree.
since, until = scheduling.yesterday(datetime(2026, 3, 1, 1, 0, tzinfo=timezone.utc))
check("a run at 06:30 IST still reports the day that just ended",
      scheduling.day_key(since), "2026-02-28")

since, until = scheduling.last_month(datetime(2026, 1, 14, tzinfo=timezone.utc))
check("last month from January is December", since,
      datetime(2025, 11, 30, 18, 30, tzinfo=timezone.utc))
check("…ending at the first of January, locally", until,
      datetime(2025, 12, 31, 18, 30, tzinfo=timezone.utc))
check("…and the period key says December, not November",
      scheduling.month_key(since), "2025-12")

since, until = scheduling.last_month(datetime(2026, 3, 5, tzinfo=timezone.utc))
check("…and February is handled without a 30-day assumption", since,
      datetime(2026, 1, 31, 18, 30, tzinfo=timezone.utc))
check("…February being 28 days here, exactly", until - since, timedelta(days=28))

# The weekly statement period is deliberately NOT cut locally: it is the ISO
# week the commission engine bills over, so a statement and the commission on it
# cannot cover different days.
wk_since, wk_until = scheduling.statement_period("last-week")
check("the weekly statement window is a whole ISO week",
      wk_until - wk_since, timedelta(days=7))
check("…starting on a Monday at 00:00 UTC", (wk_since.weekday(), wk_since.hour), (0, 0))

mo_since, mo_until = scheduling.statement_period("last-month")
check("…and last-month is the calendar month", (mo_since, mo_until),
      scheduling.last_month())

try:
    scheduling.statement_period("last-fortnight")
except ValueError as exc:
    ok("an unknown statement period is refused by name", "last-fortnight" in str(exc))
    ok("…and says which ones exist", "last-week" in str(exc))
else:
    ok("an unknown statement period is refused by name", False)


# ══════════════════════════════════════════════════════════════════════════════
# 2. A section that cannot be computed says so — 8A.6.5 / 9.15
# ══════════════════════════════════════════════════════════════════════════════

STUBS.fail = {"channel_breakdown"}
first = run(scheduling.daily())
STUBS.fail = set()

summary = report_of(first, "daily_business_summary")
check("the failed section is named on the run", summary["failed_sections"],
      ["Reseller versus direct"])
check("…and the report still went out", summary["sent"], 3)

summary_html = next(h for h in bodies() if "Daily business summary" in h)
ok("the failed section appears in the email", "Reseller versus direct" in summary_html)
ok("…marked as a failure, not a figure",
   "Could not be computed — this is not a zero" in summary_html)
ok("…carrying the report service's own reason",
   "the ledger is not reachable" in summary_html)
ok("…and saying nothing is reported as zero",
   "Nothing is reported as zero" in summary_html)
ok("…while the sections that worked still show their figures",
   "₹1,67,500.00 INR" in summary_html)

# The critical block is visually distinct — a failure that reads like a heading
# is a failure people scroll past.
ok("a failed section is rendered in the critical tone", "#fef2f2" in summary_html)

# And a report that produced no rows says that, without a totals table. Run on
# its own database, because the same day's summary has already been sent above
# and the dedupe key would — correctly — refuse to send it twice.
empty_db = FakeDb()
empty_db.seed(C.STAFF, STAFF)
use(empty_db)
STUBS.empty = {"cash_position"}
PROVIDER.sent.clear()
run(scheduling.daily())
STUBS.empty = set()
use(DB)
empty_html = next(h for h in bodies() if "Daily business summary" in h)
ok("an empty period says so", "Nothing to report" in empty_html)
ok("…in the report's own words",
   "empty period, not a measured zero" in empty_html)
ok("…and shows no total for it",
   "Receipts inr" not in empty_html.split("Nothing to report")[1].split("<h2")[0])


# ══════════════════════════════════════════════════════════════════════════════
# 3. Who each daily report goes to — 8A.3.1 / 8A.3.2 / 8A.3.3
# ══════════════════════════════════════════════════════════════════════════════

rows = DB[C.EMAIL_DELIVERIES].docs


def recipients_of(kind: str) -> list[str]:
    return sorted({r["to"] for r in rows if r["kind"] == kind})


check(
    "the business summary goes to the owners and the Observer",
    recipients_of("report.daily_business_summary"),
    ["observer@zipper.test", "owner1@zipper.test", "owner2@zipper.test"],
)
check(
    "the Finance worklist goes to the Finance admin, and nobody else",
    recipients_of("report.daily_finance_worklist"),
    ["finance@zipper.test"],
)
ok(
    "the worklist is not mailed to the Observer",
    "observer@zipper.test" not in recipients_of("report.daily_finance_worklist"),
)
for row in rows:
    if row["kind"].startswith("report."):
        check(
            f"{row['kind']} is sent as a business-money figure",
            row["sensitivity"],
            str(mail.Sensitivity.BUSINESS_MONEY),
        )
        ok(f"{row['kind']} names its spec point", bool(row["spec"]))
        ok(f"{row['kind']} carries its CSV", len(row["attachments"]) > 0)


# ══════════════════════════════════════════════════════════════════════════════
# 4. The exception report is only sent when there is something on it — 8A.3.3
# ══════════════════════════════════════════════════════════════════════════════

quiet = [r for r in first["reports"] if r["report"] == "daily_exceptions"]
check("the exception report was considered", len(quiet), 1)
check("…and not sent, because nothing is wrong", quiet[0]["sent"], 0)
ok("…and the run says exactly that",
   "only sent when there is something on it" in quiet[0]["note"])

DB.seed(
    C.CARDS,
    [
        {"_id": "card-broken", "type": "commission_payout", "team": "finance",
         "title": "Failed payout", "amount": 40_00_000, "currency": "commission",
         "stage": "failed",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-1", "name": "Tanishque", "role": "owner"},
         "signed_at": NOW - timedelta(hours=5), "updated_at": NOW - timedelta(hours=4),
         "created_at": NOW - timedelta(hours=8),
         "execution_result": {"error": "Beneficiary account closed"},
         "subject": {"type": "agency", "id": "ag_9002"}},
    ],
)
PROVIDER.sent.clear()
with_exception = run(scheduling.daily())
exceptions = report_of(with_exception, "daily_exceptions")
check("now it is sent", exceptions["sent"], 3)
exception_html = next(h for h in bodies() if "Exception report" in h)
ok("…listing the failed execution", "execution_failed" in exception_html)
ok("…with what to do about it", "What to do" in exception_html or "Beneficiary" in exception_html)
ok("…and naming checks that did not run or do not apply",
   "did not run" in exception_html or "not apply" in exception_html)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Re-running a day sends nothing twice
# ══════════════════════════════════════════════════════════════════════════════

before = len(PROVIDER.sent)
repeat = run(scheduling.daily())
check("a retried trigger sends no email", repeat["emails_accepted"], 0)
check("…and the provider is not called again", len(PROVIDER.sent), before)
check(
    "…because every recipient's row already exists, and is recorded as a duplicate",
    set(repeat["reports"][0]["outcomes"]),
    {str(mail.Outcome.DUPLICATE)},
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. A report with nobody to send it to — 8A.6.5 in the other direction
# ══════════════════════════════════════════════════════════════════════════════

no_staff = FakeDb()
no_staff.seed(C.STAFF, [s for s in STAFF if s["role"] != str(Role.OWNER)
                        and s["role"] != str(Role.OBSERVER)])
use(no_staff)
lonely = run(scheduling.daily())
lonely_summary = report_of(lonely, "daily_business_summary")
check("nothing was sent", lonely_summary["sent"], 0)
ok("…and the run says why", "nobody to send it to" in lonely_summary["error"])
ok("…naming the audiences that resolved to nobody",
   "owners" in lonely_summary["error"] and "observer" in lonely_summary["error"])
ok("…and telling the owner how to fix it",
   "seed_accounts" in lonely_summary["error"])
ok("the run collects the error", len(lonely["errors"]) >= 1)
use(DB)


# ══════════════════════════════════════════════════════════════════════════════
# 7. Partner statements — 8A.3.6 / 8A.3.7 / 8A.3.10
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.sent.clear()
statements = run(
    scheduling.partner_statements(
        since=NOW - timedelta(days=30), until=NOW, cadence="monthly"
    )
)

check("every approved partner got a statement attempt", statements["partners"], 3)
sent_to = sorted(r["to"] for r in rows if r["kind"].startswith("statement."))
check(
    "the agency and the seller are written to at their own addresses",
    [a for a in sent_to if a],
    ["acme@partner.test", "ravi@partner.test"],
)
for row in rows:
    if row["kind"].startswith("statement."):
        check(
            "a statement is the partner's own money, not the business's",
            row["sensitivity"],
            str(mail.Sensitivity.PARTNER_OWN),
        )

# The partner with no address on their Firestore document is a gap in the
# record, and it appears on the run as one.
check("the partner with no address is undeliverable", len(statements["undeliverable"]), 1)
check("…and is named", statements["undeliverable"][0]["partner_id"], "ag_noemail")
check("…with the outcome recorded", statements["undeliverable"][0]["outcome"],
      str(mail.Outcome.NO_ADDRESS))

statement_html = next(h for h in bodies() if "Your Zipper statement" in h)
ok("a statement carries the branding and is safe to forward",
   "ZIPPER" in statement_html)
ok("…and invites the partner to ask about any figure",
   "never have to ask what you are owed" in statement_html)
ok("…and every figure states its currency", "INR" in statement_html)
ok("…with the CSV attached", any(
    len(r["attachments"]) > 0 for r in rows if r["kind"].startswith("statement.")))

# Re-running the same period sends nothing twice.
again = run(scheduling.partner_statements(
    since=NOW - timedelta(days=30), until=NOW, cadence="monthly"))
check("the same statement is not sent twice", again["emails_accepted"], 0)

# A statement that cannot be computed still reaches the partner, saying so —
# silence would leave them to chase staff, which is the thing 9.16 removes.
STUBS.fail = {"agency_statement_range"}
PROVIDER.sent.clear()
broken = run(
    scheduling.partner_statements(
        since=NOW - timedelta(days=60), until=NOW - timedelta(days=30),
        cadence="adhoc", kinds=("agency",),
    )
)
STUBS.fail = set()
check("the failure is named on the run", len(broken["failed_statements"]), 2)
broken_html = next(h for h in bodies() if "Your Zipper statement" in h)
ok("…and the partner is told the figure could not be produced",
   "Could not be computed" in broken_html)
ok("…rather than being shown a zero", "₹0.00" not in broken_html)


# ══════════════════════════════════════════════════════════════════════════════
# 8. The transactional sweep — the 8A.2 triggers
# ══════════════════════════════════════════════════════════════════════════════

DB.seed(
    C.PARTNERS,
    [
        {"_id": "ag_rejected", "kind": "agency", "name": "Rejected Talent",
         "status": "rejected", "is_active": False,
         "rejection_reason": "The PAN on the KYC document does not match the "
                             "name on the bank account supplied.",
         "rejected_at": NOW - timedelta(hours=4),
         "created_at": NOW - timedelta(days=2),
         "source": {"firestore_collection": "agencies"}},
        {"_id": "ag_gone", "kind": "agency", "name": "Deactivated Talent",
         "status": "suspended", "is_active": False,
         "deactivation_reason": "Repeated late submission of host records.",
         "deactivated_at": NOW - timedelta(hours=3),
         "created_at": NOW - timedelta(days=90),
         "source": {"firestore_collection": "agencies"}},
        # The agency behind the executed payout below. Its record has to exist
        # for the receipt to be addressed — see the card with no partner record
        # further down for what happens when it does not.
        {"_id": "ag_9002", "kind": "agency", "name": "Northern",
         "status": "approved", "is_active": True,
         "created_at": NOW - timedelta(days=120),
         "source": {"firestore_collection": "agencies"}},
        {"_id": "sl_late", "kind": "seller", "name": "Late Traders",
         "status": "approved", "is_active": True,
         "created_at": NOW - timedelta(days=60),
         "source": {"firestore_collection": "sellers"},
         "credit": {"outstanding": 90_000, "due_at": NOW - timedelta(days=6)}},
    ],
)
PARTNER_DOCS[("agencies", "ag_rejected")] = {"ownerEmail": "rejected@partner.test"}
PARTNER_DOCS[("agencies", "ag_gone")] = {"ownerEmail": "gone@partner.test"}
PARTNER_DOCS[("sellers", "sl_late")] = {"ownerEmail": "late@partner.test"}

DB.seed(
    C.CARDS,
    [
        # 8A.2.7 — signed, not yet paid.
        {"_id": "card-approved", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — Acme", "amount": 75_00_000,
         "currency": "commission", "stage": "approved",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-1", "name": "Tanishque", "role": "owner"},
         "signed_at": NOW - timedelta(hours=2),
         "created_at": NOW - timedelta(hours=6),
         "payload": {"period": "2026-W33"},
         "subject": {"type": "agency", "id": "ag_4821"}},
        # 8A.2.8 — paid, with the bank's own reference.
        {"_id": "card-paid", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — Northern", "amount": 60_00_000,
         "currency": "commission", "stage": "executed",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-2", "name": "Soumya", "role": "owner"},
         "signed_at": NOW - timedelta(hours=8),
         "executed_at": NOW - timedelta(hours=7),
         "created_at": NOW - timedelta(hours=12),
         "payload": {"payment_ref": "SBIN226012345678", "period": "2026-W32"},
         "subject": {"type": "agency", "id": "ag_9002"}},
        # Executed against an agency with no business record. Nobody can be
        # written to, and that is reported rather than skipped.
        {"_id": "card-orphan", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — unknown", "amount": 10_00_000,
         "currency": "commission", "stage": "executed",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-2", "name": "Soumya", "role": "owner"},
         "signed_at": NOW - timedelta(hours=9),
         "executed_at": NOW - timedelta(hours=8),
         "created_at": NOW - timedelta(hours=14),
         "payload": {"payment_ref": "SBIN226099999999"},
         "subject": {"type": "agency", "id": "ag_missing"}},
    ],
)

# QA #53: the appeal-receipt sweep reads `appeals` from Firestore. An empty
# in-memory Firestore for the length of the sweep runs below — this module is
# about the 8A.2 emails; the receipts have their own (tests/test_qa_appeal_receipts.py).
from tests.fakes import FakeFirestore  # noqa: E402
from app.db import firebase as _firebase_mod  # noqa: E402

_REAL_FIRESTORE_CLIENT = _firebase_mod.firestore_client
_SWEEP_FS = FakeFirestore()
_firebase_mod.firestore_client = lambda: _SWEEP_FS  # type: ignore[assignment]

PROVIDER.sent.clear()
sweep = run(scheduling.transactional_sweep())
check("every sweep ran", len(sweep["sections"]), len(scheduling.SWEEPS))
check("none failed", sweep["failed_sweeps"], [])


def sweep_section(name: str) -> dict:
    return next(s for s in sweep["sections"] if s["sweep"] == name)


# ── 8A.2.5 rejection, with the reason ────────────────────────────────────────
check("the rejection notice went out", sweep_section("rejections")["accepted"], 1)
reject_html = next(h for h in bodies() if "not approved" in h)
ok("…carrying the reason from the record",
   "PAN on the KYC document does not match" in reject_html)
ok("…and telling them what to fix", "reapply" in reject_html)
check("…to the applicant's own address",
      [r["to"] for r in rows if r["kind"] == "partner.rejected"],
      ["rejected@partner.test"])

# ── 8A.2.13 deactivation ─────────────────────────────────────────────────────
check("the deactivation notice went out", sweep_section("deactivations")["accepted"], 1)
gone_html = next(h for h in bodies() if "deactivated" in h.lower())
ok("…with the grounds", "Repeated late submission" in gone_html)
ok("…and says the balance is not cancelled", "stays owed" in gone_html)

# ── 8A.2.7 payout approved ───────────────────────────────────────────────────
check("the approval notice went out", sweep_section("payouts_approved")["accepted"], 1)
approved_html = next(h for h in bodies() if "Authorised — not yet paid" in h)
ok("…stating the amount", "₹75,000.00 INR" in approved_html)
ok("…the period", "2026-W33" in approved_html)
ok("…and an expected date", "Expected in your account by" in approved_html)

# ── 8A.2.8 payout paid, with the UTR ─────────────────────────────────────────
check("the receipt went out", sweep_section("payouts_paid")["accepted"], 1)
check("…and both executed payouts were considered",
      sweep_section("payouts_paid")["candidates"], 2)
check(
    "a payout to an agency with no business record is reported, not skipped",
    sweep_section("payouts_paid")["failures"],
    [{"card_id": "card-orphan", "outcome": "no_partner_record"}],
)
paid_html = next(h for h in bodies() if "Payment sent — your receipt" in h)
ok("the UTR is the bank's own reference from the card",
   "SBIN226012345678" in paid_html)
ok("…the amount is stated in rupees", "₹60,000.00 INR" in paid_html)
ok("…and it is described as the receipt", "receipt" in paid_html)
paid_row = next(r for r in rows if r["kind"] == "payout.paid")
check("the UTR is on the delivery record too", paid_row["meta"]["utr"],
      "SBIN226012345678")
check("…with the amount in minor units", paid_row["meta"]["amount_minor"], 60_00_000)
check("…and its currency named", paid_row["meta"]["currency"], "INR")

# ── 8A.2.10 credit due ───────────────────────────────────────────────────────
check("the due-soon notice went out", sweep_section("credit_due")["accepted"], 1)
due_html = next(h for h in bodies() if "falls due" in h)
ok("…stating the outstanding amount as a count of coins, not rupees",
   "250,000 coins" in due_html)
ok("…and the due date", "Due" in due_html)

# ── 8A.2.11 credit overdue, to the seller ────────────────────────────────────
check("the overdue notice went out", sweep_section("credit_overdue")["accepted"], 1)
overdue_html = next(h for h in bodies() if "overdue" in h.lower() and "coins" in h)
ok("…saying the account is blocked from new inventory",
   "blocked from new inventory" in overdue_html)
ok("…and that a stated plan is treated differently from silence",
   "stated plan is treated differently from silence" in overdue_html)

# ── Everything is idempotent, and the overdue notice has a cadence ───────────
before = len(PROVIDER.sent)
second_sweep = run(scheduling.transactional_sweep())
check("a second sweep sends nothing", second_sweep["emails_accepted"], 0)
check("…and the provider is not called again", len(PROVIDER.sent), before)
check(
    "the overdue seller is suppressed by cadence, not by a dedupe key",
    sweep_section_two := next(
        s for s in second_sweep["sections"] if s["sweep"] == "credit_overdue"
    )["suppressed"],
    1,
)
check(
    "…and the others by their dedupe key",
    next(s for s in second_sweep["sections"] if s["sweep"] == "rejections")["already_sent"],
    1,
)


# ── A sweep that cannot run is reported, not counted as nothing to send ──────

original = scheduling._sweep_rejections


async def _broken():
    raise RuntimeError("the partners collection is unreachable")


scheduling.SWEEPS = tuple(
    (name, spec, _broken if name == "rejections" else fn)
    for name, spec, fn in scheduling.SWEEPS
)
broken_sweep = run(scheduling.transactional_sweep(["rejections"]))
scheduling.SWEEPS = tuple(
    (name, spec, original if name == "rejections" else fn)
    for name, spec, fn in scheduling.SWEEPS
)

section = broken_sweep["sections"][0]
check("a broken sweep is reported as failed", section["status"], "failed")
ok("…with the reason", "partners collection is unreachable" in section["reason"])
ok("…and says it is unknown whether any email was owed",
   "unknown whether any was owed" in section["reason"])
check("…and the run names it", broken_sweep["failed_sweeps"], ["rejections"])

_firebase_mod.firestore_client = _REAL_FIRESTORE_CLIENT  # type: ignore[assignment]


# ══════════════════════════════════════════════════════════════════════════════
# 9. Monthly — 8A.3.9 / 8A.3.11 / 8A.3.12
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER.sent.clear()
month = run(scheduling.monthly(with_statements=False))
check("three internal reports go out", len(month["reports"]), 3)
check("the P&L goes to owners and the Observer",
      report_of(month, "monthly_pnl")["sent"], 3)
check("the accounting pack goes to Finance and the Observer",
      report_of(month, "monthly_accounting_pack")["sent"], 2)
check("the audit summary goes to owners and the Observer",
      report_of(month, "monthly_audit_summary")["sent"], 3)
ok("the P&L asks the report service for the margin", "margin_report" in STUBS.calls)
ok("…and for the channel split", "channel_breakdown" in STUBS.calls)
pack_recipients = sorted(
    {r["to"] for r in rows if r["kind"] == "report.monthly_accounting_pack"}
)
check("the accounting pack is not mailed to the owners", pack_recipients,
      ["finance@zipper.test", "observer@zipper.test"])


# ══════════════════════════════════════════════════════════════════════════════
# 9a. The run log — a job that fails is never a job that was never scheduled
# ══════════════════════════════════════════════════════════════════════════════
#
# An unattended job that falls over silently looks exactly like a scheduler that
# was never wired up, and both look exactly like a quiet week. Three separate
# things have to hold for the run log to be worth reading:
#
#   * a run that worked says so, and one that limped says *that* instead;
#   * a run that raised leaves a row anyway, written from the error path;
#   * every row says who asked, so a deliberate re-run is visibly a re-run.

runs_seen = DB[C.SCHEDULED_RUNS].docs
ok("every job so far left a run row", len(runs_seen) >= 4)
ok("…and each carries a verdict", all("status" in r for r in runs_seen))
check("the monthly run that worked is 'ok'",
      next(r for r in reversed(runs_seen) if r["job"] == "reports.monthly")["status"],
      "ok")

# A run that delivered what it could and failed a section is neither a success
# nor a failure. Collapsing it into either is how a report that has been missing
# a section for a month goes unnoticed.
degraded = scheduling._verdict(
    {"job": "reports.daily", "failed_sections": ["Cash position"], "errors": []}
)
check("a run with a failed section is degraded", degraded[0], "degraded")
ok("…and says which section", "Cash position" in degraded[1][0])
check("a run with nothing wrong is ok",
      scheduling._verdict({"job": "x", "errors": [], "failed_sections": []})[0], "ok")
check("an audience that resolved to nobody also degrades the run",
      scheduling._verdict(
          {"job": "x", "reports": [{"report": "daily_business_summary",
                                    "error": "nobody to send it to"}]}
      )[0],
      "degraded",
)

# Who asked. Written by the router, read here through the same context manager.
SERVICE_ACTOR = {"uid": "system:reporting", "name": "Scheduled reporting (automated)",
                 "role": "system", "service_credential": "reporting"}
PERSON_ACTOR = {"uid": "u_owner", "name": "Priya", "role": "owner"}

with scheduling.triggered_by(SERVICE_ACTOR):
    machine_run = run(scheduling.transactional_sweep(["credit_due"]))
check("a run fired by the schedule says so", machine_run["trigger"], "schedule")
check("…and names the credential, not a person",
      machine_run["triggered_by"]["service_credential"], "reporting")

with scheduling.triggered_by(PERSON_ACTOR):
    person_run = run(scheduling.transactional_sweep(["credit_due"]))
check("a run fired by a person says so", person_run["trigger"], "person")
check("…and names them", person_run["triggered_by"]["name"], "Priya")
ok("…so a deliberate re-run is visibly a re-run, not a second scheduled firing",
   machine_run["trigger"] != person_run["trigger"])
ok("no email address of the person who asked is kept on the run",
   "email" not in person_run["triggered_by"])

# A job that raises never reaches its own `record_run`. This is the row the
# router writes instead — without it the log is silent about exactly the run
# that mattered most.
failed_row = run(
    scheduling.record_failure(
        "reports.daily",
        spec="8A.3.1",
        error=RuntimeError("Mongo is unreachable"),
        started_at=datetime.now(timezone.utc),
    )
)
check("a job that raised is recorded as failed", failed_row["status"], "failed")
check("…having sent nothing", failed_row["emails_accepted"], 0)
ok("…with the exception on it", "Mongo is unreachable" in failed_row["errors"][0])
ok("…and saying it is not a run that found nothing to do",
   "NOT a run that found nothing" in failed_row["note"])
ok("…and it is in the log", any(
    r.get("status") == "failed" for r in DB[C.SCHEDULED_RUNS].docs))

# What an owner opens to ask "is any of this actually running?".
overview = run(scheduling.last_runs())
check("every scheduled job is listed", len(overview), len(scheduling.SCHEDULE))
ok("…each with the clock it fires on",
   all(r["timezone"] == "Asia/Kolkata" for r in overview))
ok("…and the Cloud Function that fires it",
   all(r["function"].startswith("scheduled") for r in overview))
daily_row = next(r for r in overview if r["job"] == "daily")
ok("a job that has run is not reported as 'never'", daily_row["status"] != "never")
ok("…and carries when it last ran", daily_row["last_run_at"] is not None)
weekly_row = next(r for r in overview if r["job"] == "weekly-business")
check("a job that has never run says 'never'", weekly_row["status"], "never")
ok("…and says that is a deployment that is not finished, not an empty period",
   "not a period with nothing in it" in weekly_row["detail"])
ok("…naming the function and the secret to check",
   "scheduledWeeklyBusinessReport" in weekly_row["detail"]
   and "ZIPPER_REPORTING_KEY" in weekly_row["detail"])

# The schedule the API publishes and the schedule the functions are deployed
# with must be the same table, or the two drift without anything noticing.
INDEX_TS = (ROOT.parent / "functions" / "src" / "index.ts")
if INDEX_TS.exists():
    index_src = INDEX_TS.read_text()
    for entry in scheduling.SCHEDULE:
        ok(f"{entry['function']} exists and is exported",
           f"export const {entry['function']}" in index_src)
        ok(f"…on {entry['cron']!r}, the cron the API publishes",
           f".schedule('{entry['cron']}')" in index_src
           or f"schedule: '{entry['cron']}'" in index_src)
    ok("the functions' clock is the one the backend cuts its periods in",
       f"const BUSINESS_TIMEZONE = '{scheduling.SCHEDULE_TIMEZONE}'" in index_src)
    ok("…and every scheduled function is deployed on it",
       index_src.count(".timeZone(BUSINESS_TIMEZONE)") == len(scheduling.SCHEDULE))
    ok("…presenting the reporting credential, not the accrual one",
       "const REPORTING_KEY_ENV = 'ZIPPER_REPORTING_KEY'" in index_src
       and "secrets: [REPORTING_KEY_ENV]" in index_src)
    ok("…and a job that cannot run throws rather than returning quietly",
       "throw new Error(message)" in index_src)


# ══════════════════════════════════════════════════════════════════════════════
# 9b. The trigger endpoints, exercised
# ══════════════════════════════════════════════════════════════════════════════
#
# The real router function, the real dependency, the real service-credential
# check — over the fake database and the fake provider. What is being checked is
# the wiring the scheduler depends on: that the reporting key gets in, that the
# accrual key does not, that a second firing sends nothing twice, and that a job
# which falls over comes back as a loud 500 with a row already in the run log.

from app.routers import notifications as api  # noqa: E402

REPORTING_KEY = "zpr_rp_" + "Q9wErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefGHIJ"
ACCRUAL_KEY = "zpr_wa_" + "Zx1Cv2Bn3Ma4Sd5Fg6Hj7Kl8Qw9Er0TyUiOpAsDfGhJkLz"
settings.service_key_reporting = REPORTING_KEY
settings.service_key_weekly_accrual = ACCRUAL_KEY

machine = run(api.team_admin_or_reporting_service(
    authorization="", x_service_key=REPORTING_KEY))
check("the reporting key resolves to the reporting machine",
      machine["uid"], "system:reporting")
check("…which is a system actor, not a role", machine["role"], "system")

for label, key in (("a wrong key", REPORTING_KEY[:-1] + "Z"),
                   ("the accrual key", ACCRUAL_KEY)):
    try:
        run(api.team_admin_or_reporting_service(authorization="", x_service_key=key))
    except Exception as exc:
        check(f"{label} is refused at the reporting trigger",
              getattr(exc, "status_code", None), 401)
    else:
        ok(f"{label} is refused at the reporting trigger", False)

# The sweep is the cheapest job to fire twice, and the one the schedule fires
# most often — every 15 minutes. It must be free to re-run.
before = len([d for d in DB[C.EMAIL_DELIVERIES].docs if d.get("outcome") == "sent"])
sweep_machine = run(api.team_admin_or_email_sweep_service(
    authorization="", x_service_key=REPORTING_KEY))
one = run(api.run_transactional_sweep(only=None, actor=sweep_machine))
two = run(api.run_transactional_sweep(only=None, actor=sweep_machine))
after = len([d for d in DB[C.EMAIL_DELIVERIES].docs if d.get("outcome") == "sent"])
check("firing the sweep twice sends nothing the second time",
      two["emails_accepted"], 0)
check("…and writes no second delivery for anything the first one sent",
      after - before, one["emails_accepted"])
check("both runs are on the log as runs", one["trigger"], "schedule")

# A job that raises. The router is the only thing that can record this — the job
# never reaches its own `record_run` — and the response has to say so.
real_daily = scheduling.daily


async def _explodes(*_a, **_k):
    raise RuntimeError("the ledger is unreachable")


scheduling.daily = _explodes
try:
    run(api.run_daily(actor=machine))
except Exception as exc:
    detail = getattr(exc, "detail", {})
    check("a job that raises is a 500", getattr(exc, "status_code", None), 500)
    ok("…naming the job", detail.get("job") == "reports.daily")
    ok("…saying it sent nothing", "sent nothing" in detail.get("message", ""))
    ok("…carrying the exception", "ledger is unreachable" in detail.get("message", ""))
    ok("…confirming the failure was recorded", detail.get("recorded") is True)
    ok("…and saying where to look for it",
       "runs/last" in detail.get("where_to_look", ""))
else:
    ok("a job that raises is a 500", False)
finally:
    scheduling.daily = real_daily

after_failure = run(scheduling.last_runs())
daily_after = next(r for r in after_failure if r["job"] == "daily")
check("…and the failed attempt is the daily job's last run",
      daily_after["status"], "failed")
ok("…not silently absent, which is what a scheduler that never fired looks like",
   daily_after["last_run_at"] is not None)


# ══════════════════════════════════════════════════════════════════════════════
# 10. Every figure came from the report service
# ══════════════════════════════════════════════════════════════════════════════
#
# 8A.6.3: one definition of revenue. Asserted on the source, because it is the
# property and not any single result that matters — a second definition would
# appear here as arithmetic, or as a rate constant, inside scheduling.py.

SRC = (ROOT / "app" / "services" / "scheduling.py").read_text()
ok(
    "scheduling.py multiplies nothing by a rate",
    not re.search(r"\*\s*(rate|bean_to_inr|diamond_pack|100\b)", SRC),
)
ok(
    "…and defines no fallback rate of its own",
    "FALLBACK_" not in SRC and "bean_to_inr" not in SRC,
)
ok(
    "…and reads its figures from the report service",
    SRC.count("rpt.") >= 12,
)
for figure in (
    "cash_position", "margin_report", "channel_breakdown", "payout_summary",
    "outstanding_liabilities", "audit_summary", "agency_statement_range",
    "seller_statement_range",
):
    ok(f"{figure} is called, not reimplemented", f"rpt.{figure}(" in SRC)

ALERTS_SRC = (ROOT / "app" / "services" / "alerts.py").read_text()
ok(
    "alerts.py takes its rates from the report service too",
    "rpt.load_rates()" in ALERTS_SRC,
)

# The one conversion this code does own is stated in whole rupees by an owner
# and converted once. There is exactly one place it happens.
ok(
    "the rupee threshold is converted to paise in exactly one function",
    ALERTS_SRC.count("def _rupees_to_minor") == 1
    and ALERTS_SRC.count("* 100") == 1,
)


# ══════════════════════════════════════════════════════════════════════════════
# 11. Nothing leaks
# ══════════════════════════════════════════════════════════════════════════════

import json  # noqa: E402

KEY = settings.sendgrid_api_key
ok("the API key is in no report body", not any(KEY in h for h in bodies()))
ok("…and in no delivery record", KEY not in json.dumps(rows, default=str))
ok("…and in no run log", KEY not in json.dumps(DB[C.SCHEDULED_RUNS].docs, default=str))


# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} reporting checks passed.")
print("  · a section that cannot be computed prints its refusal, never a zero")
print("  · an empty period says so and shows no totals (8A.6.5)")
print("  · daily and monthly reports reach the audiences 8A.3 names, and no others")
print("  · the exception report is sent only when there is something on it")
print("  · re-running any job sends nothing twice")
print("  · a report with nobody to send it to is an error naming the empty audience")
print("  · partner statements reach the partner's own address, with the CSV attached")
print("  · rejection reason, payout UTR, credit due and overdue all go out once")
print("  · every money figure comes from reports.py — none is computed here")
sys.exit(0)
