"""Exception alerts — spec 8A.4.1 to 8A.4.9, and 8A.2.11 / 8A.2.15.

10.24 said a bank detail change, a duplicate payment or a failed execution
notifies nobody. These tests seed each of those conditions into the collections
the money path actually writes, run the real detectors, and check three things
about every one of them:

  1. **it fires** when the condition is true;
  2. **it does not fire again** on the next scan while the condition is
     unchanged — an alert that repeats every run trains people to ignore
     alerts, and then the one that mattered is ignored too (8A.1.4);
  3. **it fires again immediately when the condition worsens**, because
     suppression that survives a change is silence.

And two things about the run as a whole: a detector that cannot run is reported
as `failed` rather than as finding nothing, and an alert whose audience resolves
to nobody is reported as an error rather than as a send of zero emails.

Recipient resolution is tested here too, because "the alert fired" and "the
right person was told" are different claims and 10.24 needs both.

Run:  python3 -m tests.test_alerts
"""

from __future__ import annotations

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

# Some services bind `get_db` at import (`from app.db.mongo import get_db`), so
# swapping the attribute later would not reach them. One indirection through a
# mutable holder means every module — however it imported — sees the same
# database, and a test can swap the whole world underneath them.
CURRENT: dict[str, FakeDb] = {"db": DB}
mongo.get_db = lambda: CURRENT["db"]  # type: ignore[assignment]


def use(db: FakeDb) -> None:
    CURRENT["db"] = db

from app.core import audit as audit_log  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import alerts  # noqa: E402
from app.services import email as mail  # noqa: E402
from app.services import notify  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()
PROVIDER.next_status = 202

settings.sendgrid_api_key = "SG.test-key-never-appears-in-output.0000"
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


def section(result: dict, detector_id: str) -> dict:
    for s in result["sections"]:
        if s["id"] == detector_id:
            return s
    raise AssertionError(f"no section for {detector_id}")


def emails_for(detector_id: str) -> list[dict]:
    return [
        row
        for row in DB[C.EMAIL_DELIVERIES].docs
        if row.get("kind") == f"alert.{detector_id}"
    ]


# ══════════════════════════════════════════════════════════════════════════════
# The world, as the money path would have written it
# ══════════════════════════════════════════════════════════════════════════════

DB.seed(
    C.STAFF,
    [
        {"uid": "u-owner-1", "email": "owner1@zipper.test", "name": "Tanishque",
         "role": str(Role.OWNER), "is_active": True},
        {"uid": "u-owner-2", "email": "owner2@zipper.test", "name": "Soumya",
         "role": str(Role.OWNER), "is_active": True},
        {"uid": "u-owner-3", "email": "owner3@zipper.test", "name": "Third Owner",
         "role": str(Role.OWNER), "is_active": False},          # left the business
        {"uid": "u-observer", "email": "observer@zipper.test", "name": "Observer",
         "role": str(Role.OBSERVER), "is_active": True},
        {"uid": "u-fin", "email": "finance@zipper.test", "name": "Priya",
         "role": str(Role.FINANCE_ADMIN), "is_active": True},
        {"uid": "u-ops", "email": "ops@zipper.test", "name": "Ops Admin",
         "role": str(Role.OPS_ADMIN), "is_active": True},
        {"uid": "u-member", "email": "member@zipper.test", "name": "A Member",
         "role": str(Role.FINANCE_MEMBER), "is_active": True},
    ],
)

DB.seed(
    C.CARDS,
    [
        # 8A.4.4 — above the ₹1,00,000 threshold, waiting on a signature.
        {"_id": "card-big", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — Acme", "amount": 250_00_000,
         "currency": "commission", "stage": "awaiting_signoff",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(hours=2), "signed_at": None,
         "subject": {"type": "agency", "id": "ag_4821"}},
        # Below the threshold. Must NOT fire.
        {"_id": "card-small", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — small", "amount": 99_999_00,
         "currency": "commission", "stage": "awaiting_signoff",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(hours=2),
         "subject": {"type": "agency", "id": "ag_0002"}},
        # A coin purchase of 5,00,000 coins. A count, not rupees — it must not
        # be compared against a rupee threshold.
        {"_id": "card-coins", "type": "seller_coin_purchase", "team": "finance",
         "title": "Coin purchase", "amount": 5_00_000, "currency": "coins",
         "stage": "awaiting_signoff",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(hours=1),
         "payload": {"payment_ref": "UTR9931204"},
         "subject": {"type": "seller", "id": "sl_119"}},
        # 8A.4.3 — the same bank reference on a second card.
        {"_id": "card-dupe", "type": "seller_coin_purchase", "team": "finance",
         "title": "Coin purchase (again)", "amount": 5_00_000, "currency": "coins",
         "stage": "requested",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(hours=1),
         "payload": {"payment_ref": "UTR9931204"},
         "subject": {"type": "seller", "id": "sl_119"}},
        # 8A.4.5(a) — signed, attempted, refused.
        {"_id": "card-failed", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — Bright Stars", "amount": 40_00_000,
         "currency": "commission", "stage": "failed",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-1", "name": "Tanishque", "role": "owner"},
         "signed_at": NOW - timedelta(hours=5), "updated_at": NOW - timedelta(hours=4),
         "created_at": NOW - timedelta(hours=8),
         "execution_result": {"error": "Beneficiary account closed (bank code 34)"},
         "subject": {"type": "agency", "id": "ag_9001"}},
        # 8A.4.5(b) — signed 30 hours ago and never executed. Threshold is 24.
        {"_id": "card-stuck", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — Northern", "amount": 60_00_000,
         "currency": "commission", "stage": "approved",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-2", "name": "Soumya", "role": "owner"},
         "signed_at": NOW - timedelta(hours=30),
         "created_at": NOW - timedelta(hours=40),
         "subject": {"type": "agency", "id": "ag_9002"}},
        # Signed two hours ago. Inside the limit — must NOT fire.
        {"_id": "card-fresh", "type": "commission_payout", "team": "finance",
         "title": "Commission payout — fresh", "amount": 10_00_000,
         "currency": "commission", "stage": "approved",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_by": {"uid": "u-owner-1", "name": "Tanishque", "role": "owner"},
         "signed_at": NOW - timedelta(hours=2),
         "created_at": NOW - timedelta(hours=3),
         "subject": {"type": "agency", "id": "ag_9003"}},
        # 8A.4.7 — open for 60 hours: past the 48h team limit, inside the 96h
        # escalation, so this one is the ops admin's problem and not an owner's.
        {"_id": "card-aged", "type": "balance_credit", "team": "ops",
         "title": "Balance correction", "amount": 5_000, "currency": "diamonds",
         "stage": "under_review",
         "requested_by": {"uid": "u-ops", "name": "Ops Admin", "role": "ops_admin"},
         "created_at": NOW - timedelta(hours=60)},
        # 8A.4.7 escalated — 120 hours old, past 96. Owners as well.
        {"_id": "card-ancient", "type": "balance_debit", "team": "ops",
         "title": "Balance correction, older", "amount": 9_000, "currency": "diamonds",
         "stage": "requested",
         "requested_by": {"uid": "u-ops", "name": "Ops Admin", "role": "ops_admin"},
         "created_at": NOW - timedelta(hours=120)},
    ],
)

DB.seed(
    C.AUDIT,
    [
        # 8A.4.1
        {"_id": "aud-bank", "action": audit_log.Action.CONFIG_CHANGED,
         "at": NOW - timedelta(hours=3),
         "actor": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "subject": {"type": "config", "id": "payoutBankAccount"},
         "reason": "Updated the payout beneficiary account"},
        # Not a banking subject — must NOT fire.
        {"_id": "aud-other", "action": audit_log.Action.CONFIG_CHANGED,
         "at": NOW - timedelta(hours=3),
         "actor": {"uid": "u-ops", "name": "Ops Admin", "role": "ops_admin"},
         "subject": {"type": "config", "id": "splashScreenImage"},
         "reason": "New splash art"},
        # 8A.4.8
        {"_id": "aud-role", "action": audit_log.Action.STAFF_ROLE_CHANGED,
         "at": NOW - timedelta(hours=1),
         "actor": {"uid": "u-owner-1", "name": "Tanishque", "role": "owner"},
         "subject": {"type": "staff", "id": "u-member"},
         "before": {"role": "finance_member"}, "after": {"role": "finance_admin"},
         "reason": "Promoted"},
    ]
    # 8A.4.9 — five failures on one account inside the hour, and four on
    # another, which is below the threshold and must NOT fire.
    + [
        {"_id": f"aud-fail-{i}", "action": audit_log.Action.LOGIN_FAILED,
         "at": NOW - timedelta(minutes=5 * i + 1),
         "actor": {"uid": "u-member", "name": "A Member", "role": "finance_member"},
         "subject": {"type": "staff", "id": "u-fin"}, "reason": "Wrong password"}
        for i in range(5)
    ]
    + [
        {"_id": f"aud-nearly-{i}", "action": audit_log.Action.LOGIN_FAILED,
         "at": NOW - timedelta(minutes=5 * i + 1),
         "actor": {"uid": "u-ops", "name": "Ops Admin", "role": "ops_admin"},
         "subject": {"type": "staff", "id": "u-ops"}, "reason": "Wrong password"}
        for i in range(4)
    ],
)

DB.seed(
    C.PARTNERS,
    [
        {"_id": "sl_overdue", "kind": "seller", "name": "Ravi Traders",
         "status": "approved", "is_active": True,
         "credit": {"outstanding": 250_000, "due_at": NOW - timedelta(days=6)}},
        # Due in two days — not overdue. Must NOT fire.
        {"_id": "sl_current", "kind": "seller", "name": "Current Traders",
         "status": "approved", "is_active": True,
         "credit": {"outstanding": 100_000, "due_at": NOW + timedelta(days=2)}},
    ],
)

# A rate that last moved eight days ago — well past the 48-hour staleness limit.
DB.seed(
    C.RATES,
    [{"key": "diamondPackPriceInr", "effective_from": NOW - timedelta(days=8)}],
)

# One failed delivery already on the record, so 8A.2.15 has something to report.
DB.seed(
    C.EMAIL_DELIVERIES,
    [
        {"kind": "partner.rejected", "spec": "8A.2.5", "to": "dead@example.com",
         "outcome": "bounced", "queued_at": NOW - timedelta(hours=2),
         "error": "bounce: 550 5.1.1 mailbox does not exist",
         "dedupe_key": "seed-bounce-1"},
    ],
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Recipient resolution — who would be told, before anything is sent
# ══════════════════════════════════════════════════════════════════════════════

owners = run(notify.resolve([str(notify.Audience.OWNERS)]))
check("two active owners resolve", len(owners.recipients), 2)
check(
    "…and they come from the staff record",
    sorted(r.email for r in owners.recipients),
    ["owner1@zipper.test", "owner2@zipper.test"],
)
ok(
    "a deactivated owner is not written to",
    "owner3@zipper.test" not in [r.email for r in owners.recipients],
)
check("the audience is reported as resolved", owners.missing, [])

both = run(
    notify.resolve([str(notify.Audience.OWNERS), str(notify.Audience.OBSERVER)])
)
check("owners plus observer is three people", len(both.recipients), 3)

finance = run(notify.resolve([str(notify.Audience.FINANCE_ADMIN)]))
check("the finance admin resolves", [r.email for r in finance.recipients],
      ["finance@zipper.test"])

team = run(notify.resolve(["team_admin:ops"]))
check("a team admin is found by their department", [r.email for r in team.recipients],
      ["ops@zipper.test"])
check("…derived from roles.py, not written down",
      str(notify.admin_role_for("finance")), "finance_admin")

# Deduplication across audiences: the finance admin asked for twice is one send.
twice = run(notify.resolve([str(notify.Audience.FINANCE_ADMIN), "team_admin:finance"]))
check("the same person asked for twice gets one email", len(twice.recipients), 1)

# An audience with nobody in it is a configuration failure that says so.
DB[C.STAFF].docs = [d for d in DB[C.STAFF].docs if d["role"] != str(Role.OBSERVER)]
empty = run(notify.resolve([str(notify.Audience.OBSERVER)]))
check("an audience with nobody in it resolves to nobody", empty.ok, False)
check("…and names the audience", empty.missing, ["observer"])
ok("…and says what to do about it", "seed the owner and observer" in empty.why_empty())
DB.seed(
    C.STAFF,
    [{"uid": "u-observer", "email": "observer@zipper.test", "name": "Observer",
      "role": str(Role.OBSERVER), "is_active": True}],
)

# An audience nobody declared is refused rather than guessed at.
try:
    run(notify.resolve(["everyone"]))
except ValueError as exc:
    ok("an unknown audience is refused", "is not an audience" in str(exc))
except Exception as exc:  # noqa: BLE001  # pragma: no cover
    failures.append(f"unknown audience raised {type(exc).__name__}: {exc}")
else:  # pragma: no cover
    failures.append("an unknown audience was accepted")

try:
    run(notify.resolve(["team_admin"]))
except ValueError as exc:
    ok("'team_admin' with no team is refused", "must name a team" in str(exc))
except Exception:  # noqa: BLE001  # pragma: no cover
    failures.append("unqualified team_admin raised the wrong error")
else:  # pragma: no cover
    failures.append("'team_admin' with no team was accepted")


# ══════════════════════════════════════════════════════════════════════════════
# 2. The catalogue — every numbered condition in 8A.4 has a detector
# ══════════════════════════════════════════════════════════════════════════════

specs = {d.spec for d in alerts.DETECTORS}
for numbered in (
    "8A.4.1", "8A.4.2", "8A.4.3", "8A.4.4 / 8A.2.12", "8A.4.5",
    "8A.4.6", "8A.4.7", "8A.4.8", "8A.4.9",
):
    ok(f"{numbered} has a detector", numbered in specs)

for entry in alerts.catalogue():
    ok(f"{entry['id']} states what it watches", bool(entry["watches"]))
    ok(f"{entry['id']} states its threshold", bool(entry["threshold"]))
    ok(
        f"{entry['id']} names the setting that changes it",
        bool(entry["threshold_setting"]) and entry["threshold_setting"].isupper()
        or "/" in entry["threshold_setting"],
    )
    ok(f"{entry['id']} names who is told", bool(entry["audience"]))
    ok(f"{entry['id']} has a repeat window", entry["repeat_hours"] > 0)


# ══════════════════════════════════════════════════════════════════════════════
# 3. The first scan — everything true fires exactly once
# ══════════════════════════════════════════════════════════════════════════════

first = run(alerts.scan())

check("every detector reported", len(first["sections"]), len(alerts.DETECTORS))
check("nothing was suppressed on the first run", first["suppressed"], 0)
check("no detector failed", first["failed_detectors"], [])

# ── 8A.4.1 bank details ───────────────────────────────────────────────────────
bank = section(first, "bank_details_changed")
check("8A.4.1 fired once", bank["findings"], 1)
bank_mail = [s["html"] for s in PROVIDER.sent if "payoutBankAccount" in s["html"]]
ok("…on the bank account change, and the email names what changed", bool(bank_mail))
ok("…and says who changed it", any("Priya" in h for h in bank_mail))
ok("…and not on the splash screen",
   not any("splashScreenImage" in s["html"] for s in PROVIDER.sent))
check("…and it went to owners and the Observer", bank["raised"][0]["sent"], 3)

# ── 8A.4.2 rate feed ──────────────────────────────────────────────────────────
rate = section(first, "rate_feed_failed")
ok("8A.4.2 fired", rate["findings"] >= 1)
ok(
    "…because the economy config is unreadable here, and it says so rather "
    "than reporting a rate",
    any("provisional" in r["key"] for r in rate["raised"]),
)
ok("…and separately because a rate has not moved in 8 days",
   any("stale" in r["key"] for r in rate["raised"]))

# ── 8A.4.3 duplicate reference ────────────────────────────────────────────────
dupe = section(first, "duplicate_payment_ref")
check("8A.4.3 fired once", dupe["findings"], 1)
check("…keyed on the reference", dupe["raised"][0]["key"], "duplicate_ref:UTR9931204")
check("…to Finance and the owners", dupe["raised"][0]["sent"], 3)

# ── 8A.4.4 large card ─────────────────────────────────────────────────────────
big = section(first, "large_card_awaiting_signature")
check("8A.4.4 fired for the ₹2,50,000 card only", big["findings"], 1)
check("…and not for the one below the threshold",
      big["raised"][0]["key"], "large_card:card-big")
check("…to the owners, and nobody else", big["raised"][0]["sent"], 2)
body = PROVIDER.sent[-1]["html"] if PROVIDER.sent else ""
ok("a large-card notice is sent to owners", any(
    "₹2,50,000.00" in s["html"] for s in PROVIDER.sent))

# ── 8A.4.5 execution ──────────────────────────────────────────────────────────
exe = section(first, "execution_failed")
check("8A.4.5 fired twice — one failure and one stuck payment", exe["findings"], 2)
keys = sorted(r["key"] for r in exe["raised"])
check("…the failed execution and the signed-but-unmoved card", keys,
      ["execution_failed:card-failed", "signed_not_executed:card-stuck"])
ok("…and not the card signed two hours ago",
   "card-fresh" not in str(exe["raised"]))
ok("the bank's own failure reason is carried",
   any("Beneficiary account closed" in s["html"] for s in PROVIDER.sent))

# ── 8A.4.6 settlement ─────────────────────────────────────────────────────────
settle = section(first, "settlement_mismatch")
check("8A.4.6 reports that it cannot be evaluated here", settle["status"], "not_applicable")
ok("…and says why", "No payment gateway is connected" in settle["reason"])
ok(
    "…and refuses to be read as a clean reconciliation",
    "not a clean reconciliation" in settle["reason"],
)
check("…so it reports no findings, not zero mismatches", settle["findings"], 0)

# ── 8A.4.7 queue ageing ───────────────────────────────────────────────────────
queue = section(first, "queue_ageing")
check("8A.4.7 fired for both aged cards", queue["findings"], 2)
levels = sorted(r["key"] for r in queue["raised"])
check("…one at team level and one escalated", levels,
      ["queue_age:card-aged:team", "queue_age:card-ancient:owners"])
team_alert = next(r for r in queue["raised"] if r["key"].endswith(":team"))
check("the 60-hour card goes to the ops admin alone", team_alert["sent"], 1)
owner_alert = next(r for r in queue["raised"] if r["key"].endswith(":owners"))
check("the 120-hour card also reaches the owners", owner_alert["sent"], 3)

# ── 8A.4.8 staff access ───────────────────────────────────────────────────────
access = section(first, "staff_access_changed")
check("8A.4.8 fired on the role change", access["findings"], 1)
check("…to owners and the Observer", access["raised"][0]["sent"], 3)

# ── 8A.4.9 failed logins ──────────────────────────────────────────────────────
logins = section(first, "failed_logins")
check("8A.4.9 fired on the account with five failures", logins["findings"], 1)
ok("…and not on the one with four", "u-ops" not in str(logins["raised"]))
ok("…keyed on the account", logins["raised"][0]["key"].startswith("failed_logins:u-fin:"))

# ── 8A.2.11 credit overdue ────────────────────────────────────────────────────
credit = section(first, "credit_overdue")
check("the overdue seller fired", credit["findings"], 1)
check("…keyed on the seller", credit["raised"][0]["key"], "credit_overdue:sl_overdue")
ok("…and the seller due in two days did not", "sl_current" not in str(credit["raised"]))

# ── 8A.2.15 delivery failures ─────────────────────────────────────────────────
delivery = section(first, "delivery_failures")
check("the bounced rejection notice fired", delivery["findings"], 1)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Every alert says what fired it and how often it will repeat
# ══════════════════════════════════════════════════════════════════════════════

alert_bodies = [s["html"] for s in PROVIDER.sent if "Repeat suppression" in s["html"]]
ok("alert emails state their repeat suppression", len(alert_bodies) > 0)
for html in alert_bodies:
    ok("…and the threshold that fired them", "Threshold:" in html)
    ok("…and the environment variable that changes it", "<code>" in html)
ok(
    "the settings named in an alert are real settings",
    all(
        hasattr(settings, name.lower())
        for entry in alerts.catalogue()
        for name in entry["threshold_setting"].replace("/", " ").split()
        if name.isupper() and not name.startswith("_")
    ),
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. The second scan — nothing repeats
# ══════════════════════════════════════════════════════════════════════════════

sent_after_first = len(PROVIDER.sent)
second = run(alerts.scan())

check("the second scan sent no email at all", second["emails_accepted"], 0)
check("…and the provider was not called again", len(PROVIDER.sent), sent_after_first)
check("…because everything was suppressed", second["fired"], 0)
check("…and the count of suppressions matches the count of conditions",
      second["suppressed"], first["fired"])

for detector_id in (
    "bank_details_changed", "duplicate_payment_ref",
    "large_card_awaiting_signature", "execution_failed", "queue_ageing",
    "staff_access_changed", "failed_logins", "credit_overdue",
):
    s = section(second, detector_id)
    ok(f"{detector_id} still sees the condition", (s["findings"] or 0) > 0)
    check(f"{detector_id} raised nothing the second time", s["raised"], [])
    ok(f"{detector_id} says why it stayed quiet",
       all("Already raised" in h["reason"] or "repeat window" in h["reason"]
           for h in s["suppressed"]))

check(
    "no second email exists for the large card",
    len(emails_for("large_card_awaiting_signature")),
    2,  # the two owners, once each — not four
)


# ══════════════════════════════════════════════════════════════════════════════
# 6. A condition that worsens re-alerts immediately
# ══════════════════════════════════════════════════════════════════════════════
#
# This is the difference between suppression and silence. A third card on the
# same reference, or a debt that grows, is new information.

DB.seed(
    C.CARDS,
    [
        {"_id": "card-dupe-3", "type": "seller_coin_purchase", "team": "finance",
         "title": "Coin purchase (third)", "amount": 5_00_000, "currency": "coins",
         "stage": "requested",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(minutes=30),
         "payload": {"payment_ref": "UTR9931204"},
         "subject": {"type": "seller", "id": "sl_119"}},
    ],
)
third = run(alerts.scan(["duplicate_payment_ref"]))
dupe3 = section(third, "duplicate_payment_ref")
check("a third card on the same reference re-alerts at once", len(dupe3["raised"]), 1)
ok("…and says there are now three", "3" in str(dupe3["raised"][0]))

fourth = run(alerts.scan(["duplicate_payment_ref"]))
check("…and then goes quiet again", section(fourth, "duplicate_payment_ref")["raised"], [])

# The same for a growing debt.
DB[C.PARTNERS].docs[0]["credit"]["outstanding"] = 400_000
grew = run(alerts.scan(["credit_overdue"]))
check("a debt that grows re-alerts", len(section(grew, "credit_overdue")["raised"]), 1)
again = run(alerts.scan(["credit_overdue"]))
check("…once", section(again, "credit_overdue")["raised"], [])


# ══════════════════════════════════════════════════════════════════════════════
# 7. A resolved condition can fire again
# ══════════════════════════════════════════════════════════════════════════════

released = run(alerts.release("large_card:card-big"))
check("the raised state can be released", released, True)
after_release = run(alerts.scan(["large_card_awaiting_signature"]))
check(
    "…and the same condition then alerts again",
    len(section(after_release, "large_card_awaiting_signature")["raised"]),
    1,
)
check("releasing something that was never raised is False",
      run(alerts.release("nothing:here")), False)


# ══════════════════════════════════════════════════════════════════════════════
# 8. Conditions that should not fire at all
# ══════════════════════════════════════════════════════════════════════════════

fresh_db = FakeDb()
fresh_db.seed(C.STAFF, DB[C.STAFF].docs)
fresh_db.seed(
    C.CARDS,
    [
        {"_id": "quiet-1", "type": "commission_payout", "team": "finance",
         "title": "Small payout", "amount": 50_00_00, "currency": "commission",
         "stage": "awaiting_signoff",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "created_at": NOW - timedelta(hours=1),
         "payload": {"payment_ref": "UTR-unique-1"},
         "subject": {"type": "agency", "id": "ag_1"}},
        {"_id": "quiet-2", "type": "commission_payout", "team": "finance",
         "title": "Executed cleanly", "amount": 20_00_000, "currency": "commission",
         "stage": "executed",
         "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
         "signed_at": NOW - timedelta(hours=6),
         "executed_at": NOW - timedelta(hours=5),
         "created_at": NOW - timedelta(hours=9),
         "payload": {"payment_ref": "UTR-unique-2"},
         "subject": {"type": "agency", "id": "ag_2"}},
    ],
)
use(fresh_db)

quiet = run(
    alerts.scan(
        [
            "bank_details_changed", "duplicate_payment_ref",
            "large_card_awaiting_signature", "execution_failed",
            "queue_ageing", "staff_access_changed", "failed_logins",
            "credit_overdue", "delivery_failures",
        ]
    )
)
check("a healthy business raises nothing", quiet["fired"], 0)
check("…and sends nothing", quiet["emails_accepted"], 0)
check("…and no detector failed", quiet["failed_detectors"], [])
for s in quiet["sections"]:
    check(f"{s['id']} found nothing to raise", s["findings"], 0)

use(DB)


# ══════════════════════════════════════════════════════════════════════════════
# 9. A detector that cannot run is not a detector that found nothing
# ══════════════════════════════════════════════════════════════════════════════

original = alerts._find_duplicate_payment_refs


async def _broken():
    raise RuntimeError("the cards collection is unreachable")


alerts.DETECTORS_BY_ID["duplicate_payment_ref"].find = _broken
try:
    broken_run = run(alerts.scan(["duplicate_payment_ref"]))
finally:
    alerts.DETECTORS_BY_ID["duplicate_payment_ref"].find = original

broken = section(broken_run, "duplicate_payment_ref")
check("a broken detector is reported as failed", broken["status"], "failed")
check("…not as zero findings", broken["findings"], None)
ok("…with the reason", "cards collection is unreachable" in broken["reason"])
ok("…and says the condition is unknown, not clear",
   "treat it as unknown, not as clear" in broken["reason"].lower()
   or "not as clear" in broken["reason"])
check("…and the run names it", broken_run["failed_detectors"], ["duplicate_payment_ref"])
check("…and nothing was sent for it", broken_run["emails_accepted"], 0)


# ══════════════════════════════════════════════════════════════════════════════
# 10. An alert with nobody to send it to is an error, not a quiet success
# ══════════════════════════════════════════════════════════════════════════════

no_staff = FakeDb()
no_staff.seed(C.CARDS, [
    {"_id": "lonely", "type": "commission_payout", "team": "finance",
     "title": "Nobody to tell", "amount": 500_00_000, "currency": "commission",
     "stage": "awaiting_signoff",
     "requested_by": {"uid": "u-fin", "name": "Priya", "role": "finance_admin"},
     "created_at": NOW - timedelta(hours=1),
     "subject": {"type": "agency", "id": "ag_x"}},
])
use(no_staff)

lonely = run(alerts.scan(["large_card_awaiting_signature"]))
raised = section(lonely, "large_card_awaiting_signature")["raised"][0]
check("the alert fired", raised["key"], "large_card:lonely")
check("…but nothing was sent", raised["sent"], 0)
ok("…and the run says why", "nobody to send it to" in (raised["error"] or ""))
ok("…naming the audience that is empty", "owners" in (raised["error"] or ""))

use(DB)


# ══════════════════════════════════════════════════════════════════════════════
# 11. Two scans at once produce one email
# ══════════════════════════════════════════════════════════════════════════════
#
# The suppression state carries a unique index on `key`, so the race is decided
# by the database rather than by whichever process checked first.


async def _race():
    return await asyncio.gather(
        alerts.claim("race:1", alert="x", spec="8A.4", fingerprint="a", window_hours=24),
        alerts.claim("race:1", alert="x", spec="8A.4", fingerprint="a", window_hours=24),
    )


won = run(_race())
check("exactly one of two concurrent claims wins", sum(1 for c in won if c.fired), 1)
ok("…and the loser says it was already raised",
   any("Already raised" in c.reason or "repeat window" in c.reason
       for c in won if not c.fired))


# ══════════════════════════════════════════════════════════════════════════════
# 12. No secret in any alert
# ══════════════════════════════════════════════════════════════════════════════

import json  # noqa: E402

KEY = settings.sendgrid_api_key
ok("the API key is in no alert body", not any(KEY in s["html"] for s in PROVIDER.sent))
ok("…in no subject", not any(KEY in str(s["subject"]) for s in PROVIDER.sent))
ok("…and in no alert state row",
   KEY not in json.dumps(DB[C.ALERT_STATE].docs, default=str))
ok("…and in no delivery row",
   KEY not in json.dumps(DB[C.EMAIL_DELIVERIES].docs, default=str))


# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} alert checks passed.")
print("  · every numbered condition in 8A.4 has a detector, a threshold and an audience")
print("  · each fires once on the condition and stays quiet on the next scan")
print("  · a condition that worsens re-alerts immediately; a released one can fire again")
print("  · a healthy business raises nothing at all")
print("  · a detector that cannot run reports 'failed', never zero findings")
print("  · 8A.4.6 reports 'not applicable' with its reason — never a clean reconciliation")
print("  · an alert with nobody to send it to is an error naming the empty audience")
print("  · two concurrent scans produce one email, decided by the unique index")
sys.exit(0)
