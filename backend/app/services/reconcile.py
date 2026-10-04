"""Reconciliation — does the app's economy agree with the books?

── The exposure ──────────────────────────────────────────────────────────────

The app's money lives in Firestore. `settleGift` and the call functions write
`platformRevenue` there, and `reports.py` scans it to produce the revenue
figures the CRM shows. The business ledger — capital, expenses, partner
payouts, balance cards — lives in Mongo, written by `app.services.money`.

Nothing has ever compared the two. That was already true of the recharge flow
before any of this, and the Cloud Functions widened it: every gift and every
minute of call time now lands in Firestore and nowhere else.

Two stores that are never compared do not stay equal. They drift for ordinary
reasons — a function that retried and wrote twice, a transaction that partly
failed, a rate someone changed in the middle of a day — and the drift is
invisible until the month-end numbers do not add up and nobody can say when
they stopped. By then the window for working out *why* has closed.

── What this does ────────────────────────────────────────────────────────────

Once a night, for the day that just ended in IST:

  1. Sum Firestore `platformRevenue` — what the app says it earned.
  2. Sum the Mongo ledger's platform-revenue movements for the same window.
  3. Compare. Within tolerance, record the day as reconciled and stop.
  4. Outside it, raise an alert naming the day, both figures and the gap.

It does not correct anything. A reconciliation job that silently repairs a
difference destroys the evidence of what caused it — the value is in the
alert, not in a fix.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from app.db import firebase
from app.db.mongo import C, get_db
from app.services import alerts, scheduling

#: Rupee difference below which a day is considered to agree.
#:
#: Not zero: bean-to-rupee conversion floors, and a day with tens of thousands
#: of gifts accumulates a few rupees of rounding that mean nothing. Set low
#: enough that a single mispriced gift still shows.
TOLERANCE_INR = 10.0

#: Ledger actions that represent platform revenue from the app.
REVENUE_ACTIONS = ("balance.credit", "balance.debit")


async def _fs(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


async def _firestore_revenue(since: datetime, until: datetime) -> dict[str, Any]:
    """Platform cut recorded by the app, in diamonds, for one window."""
    client = firebase.firestore_client()

    def _run():
        q = (
            client.collection("platformRevenue")
            .where("timestamp", ">=", since)
            .where("timestamp", "<", until)
        )
        gross = 0
        cut = 0
        payout = 0
        n = 0
        by_type: dict[str, int] = {}
        for doc in q.stream():
            d = doc.to_dict() or {}
            gross += int(d.get("grossDiamonds") or 0)
            cut += int(d.get("platformCut") or 0)
            payout += int(d.get("payoutBeans") or 0)
            by_type[str(d.get("type", "?"))] = by_type.get(str(d.get("type", "?")), 0) + 1
            n += 1
        return {
            "rows": n,
            "grossDiamonds": gross,
            "platformCutDiamonds": cut,
            "payoutBeans": payout,
            "byType": by_type,
        }

    return await _fs(_run)


async def _ledger_revenue(since: datetime, until: datetime) -> dict[str, Any]:
    """The same window as the books record it."""
    cursor = get_db()[C.LEDGER].aggregate(
        [
            {
                "$match": {
                    "at": {"$gte": since, "$lt": until},
                    "action": {"$in": list(REVENUE_ACTIONS)},
                    "currency": "diamond",
                }
            },
            {
                "$group": {
                    "_id": None,
                    "rows": {"$sum": 1},
                    "amount": {"$sum": "$amount"},
                }
            },
        ]
    )
    out = {"rows": 0, "amountDiamonds": 0}
    async for doc in cursor:
        out = {"rows": int(doc.get("rows", 0)), "amountDiamonds": int(doc.get("amount", 0))}
    return out


def _to_inr(diamonds: int, rate_per_diamond: float) -> float:
    return round(diamonds * rate_per_diamond, 2)


async def reconcile_day(
    day: datetime | None = None,
    actor: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare one IST day. Returns the comparison whether or not it agrees."""
    since, until = scheduling.yesterday(day) if day is None else (
        day,
        day + timedelta(days=1),
    )
    key = scheduling.day_key(since)

    fs, ledger = await asyncio.gather(
        _firestore_revenue(since, until),
        _ledger_revenue(since, until),
    )

    # Rate from the CRM's own config, so the comparison is in the same rupees
    # the finance screens use — not a constant that could disagree with them.
    from app.services import reports as reports_svc

    rates = await reports_svc.load_rates()
    per_diamond = (
        float(rates.diamond_pack_price_inr_per_lakh) / reports_svc.DIAMONDS_PER_LAKH
    )

    fs_inr = _to_inr(fs["platformCutDiamonds"], per_diamond)
    ledger_inr = _to_inr(ledger["amountDiamonds"], per_diamond)
    gap_inr = round(fs_inr - ledger_inr, 2)
    agrees = abs(gap_inr) <= TOLERANCE_INR

    record = {
        "dayKey": key,
        "since": since,
        "until": until,
        "firestore": fs,
        "ledger": ledger,
        "firestoreInr": fs_inr,
        "ledgerInr": ledger_inr,
        "gapInr": gap_inr,
        "toleranceInr": TOLERANCE_INR,
        "agrees": agrees,
        "ratePerDiamond": per_diamond,
        "checkedAt": datetime.now(timezone.utc),
    }

    await get_db()[C.RECONCILIATION].update_one(
        {"dayKey": key}, {"$set": record}, upsert=True
    )

    if not agrees:
        # Named for the day, so a day that is still wrong tomorrow does not
        # re-alert, and a different day does.
        await alerts.raise_now(
            alert="economy_reconciliation",
            spec="app-economy",
            severity="high",
            audience=["owner", "finance"],
            key=f"reconciliation:{key}",
            fingerprint=f"{key}:{gap_inr}",
            headline=f"App economy and ledger disagree for {key} by ₹{abs(gap_inr):,.2f}",
            rows=[
                ("Day (IST)", key),
                ("Firestore platformRevenue", f"₹{fs_inr:,.2f} across {fs['rows']} rows"),
                ("Mongo ledger", f"₹{ledger_inr:,.2f} across {ledger['rows']} rows"),
                ("Difference", f"₹{gap_inr:,.2f}"),
                ("By type", ", ".join(f"{k}×{v}" for k, v in sorted(fs["byType"].items())) or "—"),
            ],
            action=(
                "Compare giftEvents and callHistory for that day against the ledger. "
                "Nothing has been corrected automatically — the difference is the evidence."
            ),
            threshold=f"±₹{TOLERANCE_INR:,.2f}",
            threshold_setting="RECONCILIATION_TOLERANCE_INR",
            meta={"dayKey": key, "gapInr": gap_inr},
        )

    return record


async def recent(limit: int = 30) -> list[dict[str, Any]]:
    """The last N days checked, newest first. Powers the CRM panel."""
    cursor = (
        get_db()[C.RECONCILIATION].find({}).sort("dayKey", -1).limit(max(1, min(limit, 365)))
    )
    out = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        out.append(doc)
    return out
