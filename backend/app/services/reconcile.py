"""Reconciliation — does the app's economy agree with its own records, and do
the CRM's movements agree with their app-side mirrors?

── The exposure ──────────────────────────────────────────────────────────────

The app's money lives in Firestore. `settleGift` and the call functions write
`platformRevenue` there, and `reports.py` scans it to produce the revenue
figures the CRM shows. The business ledger — capital, expenses, partner
payouts, balance cards, recharges — lives in Mongo, written by
`app.services.money`, and every CRM movement of a user's diamonds is mirrored
into the app's own history (`users/{uid}/diamondTransactions`) and balance.

Two stores that are never compared do not stay equal. They drift for ordinary
reasons — a function that retried and wrote twice, a transaction that partly
failed, a sync that never landed — and the drift is invisible until the
month-end numbers do not add up and nobody can say when they stopped.

── What this compares, and why it is LIKE WITH LIKE (M-4) ───────────────────

The job used to sum Firestore `platformRevenue` against Mongo ledger rows whose
action was a CRM balance card and whose currency was spelled `"diamond"` — a
word the ledger never stores (`money.Currency.DIAMONDS` is `"diamonds"`). The
ledger side was therefore always zero rows: the platform cut from gifts and
calls is never posted to Mongo at all, so the two figures were never meant to
be equal, and a day with any gift at all raised an alert while a quiet day
"agreed". A control that cannot agree when things are right and cannot
disagree when they are wrong is not a control. Two comparisons replace it:

  1. **App economy, Firestore against Firestore.** For one IST day, every
     `platformRevenue` row (what the app says it earned) is matched by its own
     id — `transactionId` for a gift, `callId` for a call — against the event
     record the same transaction wrote (`giftTransactions/{id}`,
     `callHistory/{id}`), and the cut is recomputed from that record:
     `diamondCost − beansCredited − lucky.reward` for a gift,
     `diamondsCharged − beansCredited` for a call. A revenue row with no event,
     an event with no revenue row, two revenue rows for one event, and a cut
     that disagrees with its event are each a finding. The day's totals are
     compared in rupees within `RECONCILIATION_TOLERANCE_INR`.

  2. **CRM movements, Mongo against Firestore.** Every Mongo ledger row that
     moved a user's diamonds or beans in the window — a recharge credit, a
     refund reversal, a sale credit, a signed balance card — has exactly one
     mirror row in the user's app history with a deterministic id derived from
     its idempotency key (`recharge_{rid}`, `recharge_{rid}_reversal_{n}`,
     `sale_{id}`, `card_{id}`). Missing, duplicated (a second credit for the
     same recharge, as the legacy Cloud Function once wrote) and mismatched
     mirrors are each a finding, and so is a balance row still marked
     `replica_stale` (M-1).

It does not correct anything. A reconciliation job that silently repairs a
difference destroys the evidence of what caused it — the value is in the
alert, not in a fix. (The replica repair is a separate, explicit job.)
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from google.cloud.firestore_v1.base_query import FieldFilter

from app.config import settings
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import alerts, scheduling
from app.services.money import Currency, HolderType

log = logging.getLogger(__name__)

#: Rupee difference below which a day's app economy is considered to agree.
#:
#: Not zero: bean-to-rupee conversion floors, and a day with tens of thousands
#: of gifts accumulates a few rupees of rounding that mean nothing. Set low
#: enough that a single mispriced gift still shows. Read from the settings at
#: run time (`RECONCILIATION_TOLERANCE_INR`); this is the documented default.
TOLERANCE_INR = 10.0

#: Mongo ledger actions whose rows carry an app-side mirror for a user.
MIRRORED_ACTIONS = ("balance.credit", "balance.debit", "refund")

#: Findings kept inline on the stored day record; the counts are always whole.
MAX_STORED_FINDINGS = 200

_CARD_ID = re.compile(r"^[0-9a-f]{24}$")


def tolerance_inr() -> float:
    try:
        return float(settings.reconciliation_tolerance_inr)
    except (TypeError, ValueError, AttributeError):  # pragma: no cover
        return TOLERANCE_INR


async def _fs(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def _int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


# ══════════════════════════════════════════════════════════════════════════════
#  1. App economy — platformRevenue against the event records
# ══════════════════════════════════════════════════════════════════════════════


def _stream(collection: str, field: str, since: datetime, until: datetime):
    client = firebase.firestore_client()
    q = (
        client.collection(collection)
        .where(filter=FieldFilter(field, ">=", since))
        .where(filter=FieldFilter(field, "<", until))
    )
    return [(doc.id, doc.to_dict() or {}) for doc in q.stream()]


def _app_economy_blocking(since: datetime, until: datetime) -> dict[str, Any]:
    revenue = _stream("platformRevenue", "timestamp", since, until)
    gifts = _stream("giftTransactions", "createdAt", since, until)
    calls = _stream("callHistory", "endedAt", since, until)

    # The event records, keyed on their own id, with the cut each implies.
    expected: dict[str, dict] = {}
    for gid, g in gifts:
        lucky = g.get("lucky") if isinstance(g.get("lucky"), dict) else {}
        cost = _int(g.get("diamondCost"))
        beans = _int(g.get("beansCredited"))
        reward = _int(lucky.get("reward")) if lucky else 0
        expected[f"gift:{gid}"] = {"type": "gift", "id": gid, "cut": cost - beans - reward,
                                   "gross": cost, "payout": beans}
    unbilled = 0
    for cid, c in calls:
        charged = _int(c.get("diamondsCharged") if c.get("diamondsCharged") is not None else c.get("costDiamonds"))
        beans = _int(c.get("beansCredited") if c.get("beansCredited") is not None else c.get("beansEarned"))
        if charged <= 0:
            unbilled += 1
            continue  # an unbilled call writes no revenue row, by design
        expected[f"call:{cid}"] = {"type": "call", "id": cid, "cut": charged - beans,
                                   "gross": charged, "payout": beans}

    seen: dict[str, list[dict]] = {}
    totals = {"rows": 0, "grossDiamonds": 0, "platformCutDiamonds": 0, "payoutBeans": 0,
              "byType": {}}
    unkeyed = 0
    for rid, r in revenue:
        kind = str(r.get("type") or "?")
        totals["rows"] += 1
        totals["grossDiamonds"] += _int(r.get("grossDiamonds"))
        totals["platformCutDiamonds"] += _int(r.get("platformCut"))
        totals["payoutBeans"] += _int(r.get("payoutBeans"))
        totals["byType"][kind] = totals["byType"].get(kind, 0) + 1
        ref = r.get("transactionId") if kind == "gift" else r.get("callId") if kind == "call" else None
        if not ref:
            unkeyed += 1
            continue
        seen.setdefault(f"{kind}:{ref}", []).append({"revenue_id": rid, "cut": _int(r.get("platformCut"))})

    findings: list[dict] = []
    expected_cut = 0
    for key, ev in expected.items():
        expected_cut += ev["cut"]
        rows = seen.get(key, [])
        if not rows:
            findings.append({"kind": "missing_revenue", "side": "app", "key": key,
                             "detail": f"{ev['type']} {ev['id']} has no platformRevenue row (cut {ev['cut']})"})
            continue
        if len(rows) > 1:
            findings.append({"kind": "duplicate_revenue", "side": "app", "key": key,
                             "detail": f"{ev['type']} {ev['id']} has {len(rows)} platformRevenue rows: "
                                       + ", ".join(r["revenue_id"] for r in rows)})
        for r in rows:
            if r["cut"] != ev["cut"]:
                findings.append({"kind": "mismatched_cut", "side": "app", "key": key,
                                 "detail": f"{ev['type']} {ev['id']}: platformRevenue cut {r['cut']} "
                                           f"≠ event cut {ev['cut']} (row {r['revenue_id']})"})
    for key, rows in seen.items():
        if key not in expected:
            findings.append({"kind": "orphan_revenue", "side": "app", "key": key,
                             "detail": f"platformRevenue row(s) {', '.join(r['revenue_id'] for r in rows)} "
                                       f"name {key}, which has no event record in this window"})

    return {
        "revenue": totals,
        "events": {"gifts": len(gifts), "calls": len(calls) - unbilled, "unbilledCalls": unbilled,
                   "expectedCutDiamonds": expected_cut},
        "unkeyedRevenueRows": unkeyed,
        "findings": findings,
    }


async def _app_economy(since: datetime, until: datetime) -> dict[str, Any]:
    return await _fs(_app_economy_blocking, since, until)


# ══════════════════════════════════════════════════════════════════════════════
#  2. CRM movements — Mongo ledger rows against their app-side mirrors
# ══════════════════════════════════════════════════════════════════════════════

_RECHARGE_CREDIT = re.compile(r"^recharge:(?P<rid>[^:]+):diamonds$")
_RECHARGE_REFUND = re.compile(r"^recharge:(?P<rid>[^:]+):refund:(?P<n>\d+):diamonds$")
_SALE_CREDIT = re.compile(r"^sale:(?P<sid>[^:]+):diamonds$")


def mirror_id_for(row: Mapping[str, Any]) -> str | None:
    """The app history row id a Mongo ledger row must have, or None if the
    row is not one that carries a mirror (a host withdrawal, say, mirrors
    through `cardDebits`, which is checked by its own executor)."""
    key = str(row.get("idempotency_key") or "")
    m = _RECHARGE_CREDIT.match(key)
    if m:
        return f"recharge_{m.group('rid')}"
    m = _RECHARGE_REFUND.match(key)
    if m:
        return f"recharge_{m.group('rid')}_reversal_{m.group('n')}"
    m = _SALE_CREDIT.match(key)
    if m:
        return f"sale_{m.group('sid')}"
    if _CARD_ID.match(key):
        return f"card_{key}"
    return None


def _read_mirror_blocking(uid: str, collection: str, row_id: str) -> dict | None:
    snap = (
        firebase.firestore_client().collection("users").document(uid)
        .collection(collection).document(row_id).get()
    )
    return (snap.to_dict() or {}) if getattr(snap, "exists", False) else None


def _recharge_credit_rows_blocking(uid: str, rid: str) -> list[str]:
    q = (
        firebase.firestore_client().collection("users").document(uid)
        .collection("diamondTransactions")
        .where(filter=FieldFilter("rechargeRequestId", "==", rid))
    )
    return [doc.id for doc in q.stream() if str((doc.to_dict() or {}).get("type") or "credit") == "credit"]


async def _crm_movements(since: datetime, until: datetime) -> dict[str, Any]:
    cursor = get_db()[C.LEDGER].find({
        "at": {"$gte": since, "$lt": until},
        "holder_type": str(HolderType.USER),
        "currency": {"$in": [str(Currency.DIAMONDS), str(Currency.BEANS)]},
        "action": {"$in": list(MIRRORED_ACTIONS)},
    })
    rows = [doc async for doc in cursor]

    findings: list[dict] = []
    checked = unchecked = 0
    amount_diamonds = 0
    per_recharge: dict[str, int] = {}
    for row in rows:
        uid = str(row.get("holder_id") or "")
        amount = _int(row.get("amount"))
        if str(row.get("currency")) == str(Currency.DIAMONDS):
            amount_diamonds += amount
        rid = str((row.get("meta") or {}).get("recharge_id") or "")
        if rid and str(row.get("action")) == "balance.credit":
            per_recharge[rid] = per_recharge.get(rid, 0) + 1
        mirror_id = mirror_id_for(row)
        if mirror_id is None:
            unchecked += 1
            continue
        collection = "diamondTransactions" if str(row.get("currency")) == str(Currency.DIAMONDS) else "beanTransactions"
        checked += 1
        try:
            mirror = await _fs(_read_mirror_blocking, uid, collection, mirror_id)
        except Exception as exc:  # noqa: BLE001 — unreadable is not "missing"
            findings.append({"kind": "unreadable_mirror", "side": "crm", "key": mirror_id,
                             "detail": f"users/{uid}/{collection}/{mirror_id} could not be read: {exc}"})
            continue
        if mirror is None:
            findings.append({"kind": "missing_mirror", "side": "crm", "key": mirror_id,
                             "detail": f"ledger {row.get('idempotency_key')} ({amount:+d} {row.get('currency')}) "
                                       f"has no users/{uid}/{collection}/{mirror_id} row"})
            continue
        if _int(mirror.get("amount")) != abs(amount):
            findings.append({"kind": "mismatched_mirror", "side": "crm", "key": mirror_id,
                             "detail": f"users/{uid}/{collection}/{mirror_id} amount {_int(mirror.get('amount'))} "
                                       f"≠ ledger {abs(amount)}"})
        if rid and str(row.get("action")) == "balance.credit" and collection == "diamondTransactions":
            try:
                credits = await _fs(_recharge_credit_rows_blocking, uid, rid)
            except Exception as exc:  # noqa: BLE001
                findings.append({"kind": "unreadable_mirror", "side": "crm", "key": mirror_id,
                                 "detail": f"users/{uid}/diamondTransactions for recharge {rid} unreadable: {exc}"})
                continue
            if len(credits) > 1:
                findings.append({"kind": "duplicate_mirror", "side": "crm", "key": mirror_id,
                                 "detail": f"recharge {rid} has {len(credits)} credit rows in users/{uid}/"
                                           f"diamondTransactions: {', '.join(credits)}"})

    for rid, n in per_recharge.items():
        if n > 1:
            findings.append({"kind": "duplicate_ledger", "side": "crm", "key": f"recharge_{rid}",
                             "detail": f"recharge {rid} has {n} credit rows in the Mongo ledger"})

    stale = [doc async for doc in get_db()[C.BALANCES].find({"replica_stale": True})]
    for b in stale:
        pending = b.get("replica_pending") or []
        findings.append({"kind": "replica_stale", "side": "crm",
                         "key": f"{b.get('holder_type')}:{b.get('holder_id')}:{b.get('currency')}",
                         "detail": f"{len(pending)} pending delta(s) never reached Firestore "
                                   f"(sum {sum(_int(p.get('delta')) for p in pending):+d})"})

    return {
        "rows": len(rows),
        "checked": checked,
        "unchecked": unchecked,
        "amountDiamonds": amount_diamonds,
        "replicaStaleBalances": len(stale),
        "findings": findings,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  The day
# ══════════════════════════════════════════════════════════════════════════════


def _to_inr(diamonds: int, rate_per_diamond: float) -> float:
    return round(diamonds * rate_per_diamond, 2)


async def _rate_per_diamond() -> float:
    # Rate from the CRM's own config, so the comparison is in the same rupees
    # the finance screens use — not a constant that could disagree with them.
    from app.services import reports as reports_svc

    rates = await reports_svc.load_rates()
    return float(rates.diamond_pack_price_inr_per_lakh) / reports_svc.DIAMONDS_PER_LAKH


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

    app, crm = await asyncio.gather(
        _app_economy(since, until),
        _crm_movements(since, until),
    )

    per_diamond = await _rate_per_diamond()
    tolerance = tolerance_inr()

    revenue_cut = int(app["revenue"]["platformCutDiamonds"])
    expected_cut = int(app["events"]["expectedCutDiamonds"])
    fs_inr = _to_inr(revenue_cut, per_diamond)
    events_inr = _to_inr(expected_cut, per_diamond)
    gap_inr = round(fs_inr - events_inr, 2)

    findings = list(app["findings"]) + list(crm["findings"])
    counts: dict[str, int] = {}
    for f in findings:
        counts[f["kind"]] = counts.get(f["kind"], 0) + 1
    agrees = abs(gap_inr) <= tolerance and not findings

    record = {
        "dayKey": key,
        "since": since,
        "until": until,
        "app": {k: v for k, v in app.items() if k != "findings"},
        "crm": {k: v for k, v in crm.items() if k != "findings"},
        # Kept under the names the CRM panel already reads.
        "firestore": app["revenue"],
        "ledger": {"rows": crm["rows"], "amountDiamonds": crm["amountDiamonds"]},
        "firestoreInr": fs_inr,
        "eventsInr": events_inr,
        "ledgerInr": events_inr,
        "gapInr": gap_inr,
        "toleranceInr": tolerance,
        "findings": findings[:MAX_STORED_FINDINGS],
        "findingCounts": counts,
        "findingsTotal": len(findings),
        "agrees": agrees,
        "ratePerDiamond": per_diamond,
        "method": "platformRevenue vs giftTransactions/callHistory by id; Mongo user movements vs "
                  "users/{uid}/diamondTransactions|beanTransactions mirrors by idempotency key",
        "checkedAt": datetime.now(timezone.utc),
    }

    await get_db()[C.RECONCILIATION].update_one(
        {"dayKey": key}, {"$set": record}, upsert=True
    )

    if not agrees:
        # Named for the day, so a day that is still wrong tomorrow does not
        # re-alert, and a day whose findings CHANGE does.
        fingerprint = f"{key}:{gap_inr}:{len(findings)}:" + ",".join(
            f"{k}={v}" for k, v in sorted(counts.items())
        )
        sample = "; ".join(f["detail"] for f in findings[:5]) or "—"
        # The audience names are `notify.Audience` values. The old job passed
        # "owner" / "finance", which `notify.resolve` refuses outright — so even
        # on a day it did disagree, the alert raised a ValueError instead.
        await alerts.raise_now(
            alert="economy_reconciliation",
            spec="app-economy / M-4",
            severity="high",
            audience=[alerts.OWNERS, alerts.FINANCE],
            key=f"reconciliation:{key}",
            fingerprint=fingerprint,
            headline=(
                f"App economy and ledger disagree for {key}: "
                f"₹{abs(gap_inr):,.2f} gap, {len(findings)} finding(s)"
            ),
            rows=[
                ("Day (IST)", key),
                ("platformRevenue cut", f"₹{fs_inr:,.2f} across {app['revenue']['rows']} rows"),
                ("Gift/call events", f"₹{events_inr:,.2f} across {app['events']['gifts']} gifts, "
                                      f"{app['events']['calls']} calls"),
                ("Difference", f"₹{gap_inr:,.2f}"),
                ("CRM movements checked", f"{crm['checked']} of {crm['rows']} ledger rows"),
                ("Findings", ", ".join(f"{k}×{v}" for k, v in sorted(counts.items())) or "—"),
                ("First findings", sample),
            ],
            action=(
                "Open the reconciliation panel for that day. Each finding names the record "
                "on each side. Nothing has been corrected automatically — the difference is "
                "the evidence. A `replica_stale` finding is repaired by the replica-drift "
                "repair job once Firestore is reachable."
            ),
            threshold=f"±₹{tolerance:,.2f} on the day's cut, and zero findings",
            threshold_setting="RECONCILIATION_TOLERANCE_INR",
            meta={"dayKey": key, "gapInr": gap_inr, "findings": len(findings), "counts": counts},
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


async def days_not_agreeing(since: datetime, limit: int = 100) -> list[dict[str, Any]]:
    """Days checked since `since` that did not agree — for the alert detector."""
    cursor = (
        get_db()[C.RECONCILIATION]
        .find({"agrees": False, "checkedAt": {"$gte": since}})
        .sort("dayKey", -1)
        .limit(max(1, min(limit, 365)))
    )
    return [doc async for doc in cursor]
