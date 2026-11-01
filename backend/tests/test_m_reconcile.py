"""B1 — M-4: the nightly reconciliation compares like with like and catches
missing, duplicate and mismatched entries on both sides.

  * App economy: `platformRevenue` rows matched by id against the event
    records the same transaction wrote (`giftTransactions`, `callHistory`),
    with the cut recomputed from the record.
  * CRM movements: every Mongo ledger row that moved a user's diamonds in the
    window against its `diamondTransactions` mirror, keyed on the row's
    idempotency key — the literal is `money.Currency.DIAMONDS` ("diamonds"),
    never the misspelt `"diamond"` the old job queried.

A clean day agrees with zero findings and no alert. Then, one injected case at
a time: a gift with no revenue row, a revenue row with no gift, two revenue
rows for one call, a cut that disagrees with its event, a recharge credit with
no mirror, a mirror with the wrong amount, a recharge the legacy function
credited a second time, a balance still replica_stale. Each is a named finding;
the day no longer agrees; the alert is raised once under the day's key; the
scheduled detector re-finds the day; the record keeps every finding.

REAL: `services/reconcile`, `services/alerts` (raise_now, detector), `money`.
FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`), SendGrid.

    python3 -m tests.test_m_reconcile
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs  # noqa: E402

install_stubs()
PROVIDER = FakeSendGrid()
PROVIDER.install()

import app.db.mongo as mongo  # noqa: E402
from app.config import settings  # noqa: E402

settings.sendgrid_api_key = "SG.test-key-never-appears-in-output.0000"

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.services import alerts, reconcile  # noqa: E402

logging.disable(logging.CRITICAL)
run = asyncio.run
checks = 0
failures: list[str] = []


def ok(claim, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


DB.seed(C.STAFF, [
    {"uid": "u-owner", "email": "owner@zipper.test", "name": "Owner", "role": str(Role.OWNER), "is_active": True},
    {"uid": "u-fin", "email": "fin@zipper.test", "name": "Fin", "role": str(Role.FINANCE_ADMIN), "is_active": True},
])


async def _rate():
    return 0.02   # ₹2,000 per lakh — a rate with an exact decimal, so the arithmetic is readable


reconcile._rate_per_diamond = _rate  # type: ignore[assignment]

DAY = datetime(2026, 10, 30, 0, 0, tzinfo=timezone.utc)
AT = DAY + timedelta(hours=10)


def gift(gid: str, cost: int, beans: int, reward: int = 0, at: datetime = AT) -> None:
    doc = {"senderUid": "s", "receiverUid": "r", "diamondCost": cost, "beansCredited": beans, "createdAt": at}
    if reward:
        doc["lucky"] = {"reward": reward, "multiplier": 10}
    fs.collection("giftTransactions").docs[gid] = doc
    fs.collection("platformRevenue").docs[f"rev-{gid}"] = {
        "type": "gift", "grossDiamonds": cost, "payoutBeans": beans, "platformCut": cost - beans - reward,
        "transactionId": gid, "timestamp": at,
    }


def call(cid: str, charged: int, beans: int, at: datetime = AT) -> None:
    fs.collection("callHistory").docs[cid] = {"diamondsCharged": charged, "beansCredited": beans, "endedAt": at}
    fs.collection("platformRevenue").docs[f"rev-{cid}"] = {
        "type": "call", "grossDiamonds": charged, "payoutBeans": beans, "platformCut": charged - beans,
        "callId": cid, "timestamp": at,
    }


def ledger(uid: str, key: str, amount: int, action: str = "balance.credit", rid: str = "", at: datetime = AT) -> None:
    DB[C.LEDGER].docs.append({
        "_id": f"L-{key}", "holder_type": "user", "holder_id": uid, "currency": "diamonds", "amount": amount,
        "action": action, "at": at, "idempotency_key": key, "meta": {"recharge_id": rid} if rid else {},
    })


def mirror(uid: str, row_id: str, amount: int, rid: str = "", kind: str = "credit") -> None:
    fs.collection("users").document(uid).collection("diamondTransactions").docs[row_id] = {
        "type": kind, "amount": amount, "rechargeRequestId": rid, "timestamp": AT,
    }


def findings(record: dict) -> dict[str, int]:
    return dict(record["findingCounts"])


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. A clean day agrees with zero findings")

gift("g1", 1_000, 500)
gift("g2", 200, 100, reward=50)          # a lucky gift: the cut nets off the reward
call("c1", 600, 300)
call("c0", 0, 0)                         # an unbilled call writes no revenue row
del fs.collection("platformRevenue").docs["rev-c0"]
ledger("buyer-1", "recharge:R1:diamonds", 1_000, rid="R1")
mirror("buyer-1", "recharge_R1", 1_000, rid="R1")
ledger("buyer-2", "recharge:R2:refund:1:diamonds", -400, action="refund", rid="R2")
mirror("buyer-2", "recharge_R2_reversal_1", 400, kind="debit")
ledger("buyer-3", "sale:S1:diamonds", 250)
mirror("buyer-3", "sale_S1", 250)
ledger("buyer-4", "0123456789abcdef01234567", 30)
mirror("buyer-4", "card_0123456789abcdef01234567", 30)
# Yesterday's noise is outside the window.
gift("g-old", 5_000, 2_500, at=DAY - timedelta(hours=3))
ledger("buyer-9", "recharge:R-old:diamonds", 9_999, rid="R-old", at=DAY - timedelta(days=1))

rec = run(reconcile.reconcile_day(DAY))
eq("the day agrees", rec["agrees"], True)
eq("…with no findings", rec["findingsTotal"], 0)
eq("the app side: revenue rows and events for this day only", (rec["app"]["revenue"]["rows"], rec["app"]["events"]["gifts"], rec["app"]["events"]["calls"]), (3, 2, 1))
eq("…the cut matches the events: 500 + 50 + 300", (rec["app"]["revenue"]["platformCutDiamonds"], rec["app"]["events"]["expectedCutDiamonds"]), (850, 850))
eq("the CRM side checked every mirrored row of the day", (rec["crm"]["rows"], rec["crm"]["checked"]), (4, 4))
eq("…and the currency literal is the ledger's", reconcile.MIRRORED_ACTIONS[0], "balance.credit")
ok("the query names 'diamonds', never 'diamond'", "diamonds" in str(reconcile.Currency.DIAMONDS))
eq("the gap in rupees is zero", rec["gapInr"], 0.0)
eq("…the record is stored under the day", [d["dayKey"] for d in DB[C.RECONCILIATION].docs], [rec["dayKey"]])
eq("…and nothing was emailed", len(PROVIDER.sent), 0)
eq("the scheduled detector finds nothing", run(alerts._find_reconciliation_disagreement()), [])

# ══════════════════════════════════════════════════════════════════════════════
print("2. App side — missing, orphan, duplicate and mismatched entries")

fs.collection("giftTransactions").docs["g-missing"] = {"diamondCost": 100, "beansCredited": 50, "createdAt": AT}
rec = run(reconcile.reconcile_day(DAY))
eq("a gift with no revenue row is a finding", findings(rec).get("missing_revenue"), 1)
eq("…the day no longer agrees", rec["agrees"], False)
ok("…and the finding names the gift", any("g-missing" in f["detail"] for f in rec["findings"]))
del fs.collection("giftTransactions").docs["g-missing"]

fs.collection("platformRevenue").docs["rev-orphan"] = {"type": "gift", "platformCut": 7, "grossDiamonds": 10,
                                                        "payoutBeans": 3, "transactionId": "g-nowhere", "timestamp": AT}
rec = run(reconcile.reconcile_day(DAY))
eq("a revenue row with no event is a finding", findings(rec).get("orphan_revenue"), 1)
del fs.collection("platformRevenue").docs["rev-orphan"]

fs.collection("platformRevenue").docs["rev-c1-again"] = dict(fs.collection("platformRevenue").docs["rev-c1"])
rec = run(reconcile.reconcile_day(DAY))
eq("two revenue rows for one call is a duplicate", findings(rec).get("duplicate_revenue"), 1)
eq("…and the aggregate gap shows the double count (300 × ₹0.02)", rec["gapInr"], 6.0)
del fs.collection("platformRevenue").docs["rev-c1-again"]

fs.collection("platformRevenue").docs["rev-g1"]["platformCut"] = 480
rec = run(reconcile.reconcile_day(DAY))
eq("a cut that disagrees with its event is a mismatch", findings(rec).get("mismatched_cut"), 1)
ok("…naming both figures", any("480" in f["detail"] and "500" in f["detail"] for f in rec["findings"]))
fs.collection("platformRevenue").docs["rev-g1"]["platformCut"] = 500

# ══════════════════════════════════════════════════════════════════════════════
print("3. CRM side — missing, mismatched, duplicated mirrors; stale replicas")

ledger("buyer-5", "recharge:R5:diamonds", 700, rid="R5")
rec = run(reconcile.reconcile_day(DAY))
eq("a recharge credit with no app history row is a finding", findings(rec).get("missing_mirror"), 1)
ok("…naming the row the app should have", any("recharge_R5" in f["detail"] for f in rec["findings"]))
mirror("buyer-5", "recharge_R5", 70, rid="R5")
rec = run(reconcile.reconcile_day(DAY))
eq("a mirror with the wrong amount is a mismatch", findings(rec).get("mismatched_mirror"), 1)
fs.collection("users").document("buyer-5").collection("diamondTransactions").docs["recharge_R5"]["amount"] = 700
rec = run(reconcile.reconcile_day(DAY))
eq("…fixed, the day agrees again", rec["agrees"], True)

# The legacy Cloud Function credited the same recharge under a random id.
mirror("buyer-5", "legacy-random-id", 700, rid="R5")
rec = run(reconcile.reconcile_day(DAY))
eq("a second credit row for one recharge is a duplicate mirror", findings(rec).get("duplicate_mirror"), 1)
del fs.collection("users").document("buyer-5").collection("diamondTransactions").docs["legacy-random-id"]

# Two ledger rows crediting one recharge.
ledger("buyer-5", "recharge:R5:diamonds:again", 700, rid="R5")
rec = run(reconcile.reconcile_day(DAY))
eq("two ledger credits for one recharge is a duplicate ledger row", findings(rec).get("duplicate_ledger"), 1)
DB[C.LEDGER].docs = [d for d in DB[C.LEDGER].docs if d["idempotency_key"] != "recharge:R5:diamonds:again"]

DB.seed(C.BALANCES, [{"holder_type": "user", "holder_id": "buyer-7", "currency": "diamonds", "amount": 10,
                      "replica_stale": True, "replica_pending": [{"delta": 10, "ledger_id": "L-x"}]}])
rec = run(reconcile.reconcile_day(DAY))
eq("a balance still replica_stale is a finding (M-1)", findings(rec).get("replica_stale"), 1)
DB[C.BALANCES].docs.clear()

# ══════════════════════════════════════════════════════════════════════════════
print("4. The alert — once per day, again when the findings change, and the detector agrees")

PROVIDER.sent.clear()
DB[C.ALERT_STATE].docs.clear()
DB[C.EMAIL_DELIVERIES].docs.clear()
fs.collection("platformRevenue").docs["rev-g1"]["platformCut"] = 480
rec = run(reconcile.reconcile_day(DAY))
eq("a disagreeing day raises the alert", len(PROVIDER.sent), 2)
eq("…to the Owner and Finance", sorted(s["to"] for s in PROVIDER.sent), ["fin@zipper.test", "owner@zipper.test"])
ok("…naming the finding", any("480" in s["html"] for s in PROVIDER.sent))
state = [d for d in DB[C.ALERT_STATE].docs if d["key"] == f"reconciliation:{rec['dayKey']}"]
eq("…under the day's key", len(state), 1)
run(reconcile.reconcile_day(DAY))
eq("the same findings again send nothing", len(PROVIDER.sent), 2)
fs.collection("platformRevenue").docs["rev-g1"]["platformCut"] = 470
run(reconcile.reconcile_day(DAY))
eq("a changed gap re-alerts", len(PROVIDER.sent), 4)
found = run(alerts._find_reconciliation_disagreement())
eq("the scheduled detector re-finds the day under the same key", [f.key for f in found], [f"reconciliation:{rec['dayKey']}"])
scan = run(alerts.scan(["reconciliation_disagreement"]))
eq("…and the scan is suppressed by the alert the job already raised", (scan["fired"], scan["suppressed"]), (0, 1))
ok("the stored record keeps the findings", DB[C.RECONCILIATION].docs[0]["findings"])
eq("…and their counts", DB[C.RECONCILIATION].docs[0]["findingCounts"], {"mismatched_cut": 1})
ok("the detector is on the scheduled scan", "reconciliation_disagreement" in alerts.DETECTORS_BY_ID)

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} reconciliation checks passed.")
