"""Immediate alerts — spec 8A.4, and the exception half of 8A.2.

Nine conditions are named in 8A.4. Each one is a `Detector` below: what it
watches, the threshold that fires it, who is told, and how long it stays quiet
afterwards. Adding a tenth means adding a `Detector`, not editing `scan()`.

**The three properties that decide whether an alert is worth having.**

  1. *It fires when something is wrong.* Every detector reads the same
     collections the money path writes — cards, the ledger, the audit log, the
     partner records — never a cache and never a browser's view of them.
  2. *It goes to the right person.* Audiences are named (`owners`,
     `finance_admin`, `team_admin:finance`) and resolved from the staff record
     by `notify.py`. No address is written down in this file. An audience that
     resolves to nobody is reported as a failure of the run, not skipped.
  3. **It does not fire again every hour until it is fixed.** Every finding
     carries a `key` — the identity of the condition, not of the scan — and a
     `fingerprint` — what about it is currently true. `claim()` writes that key
     to `alert_state` under a unique index. Inside the repeat window the same
     key with the same fingerprint is refused, and nothing is sent. An alert
     that repeats every run trains people to ignore alerts, and then the one
     that mattered is ignored too (8A.1.4).

     The fingerprint is what stops suppression becoming silence: a duplicate
     payment reference that gains a *third* card has a different fingerprint,
     so it re-alerts immediately rather than waiting out the window.

**Thresholds are settings, never constants here.** Every one comes from
`app/config.py`, is stated in the email that fired, and names the environment
variable that would change it — so a reader can tell "this is unusual" from
"the threshold is set too low" without reading Python.

**A detector that cannot run is not a detector that found nothing.** `scan()`
records each detector's outcome separately as `ok`, `failed` or
`not_applicable`, and the daily exception report prints all three. Nothing in
this module ever turns an error into an empty list.

Money is integer INR minor units (paise) throughout; `email.money()` renders it
and always prints the currency.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Mapping, Sequence

from app.config import settings
from app.core import audit as audit_log
from app.services import email as mail
from app.services import notify
from app.services.notify import Audience

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _db():
    from app.db.mongo import get_db

    return get_db()


def _c(name: str):
    return _db()[name]


def _rupees_to_minor(rupees: int | float) -> int:
    """One conversion, in one place. 8A.4.4 is stated in whole rupees because
    that is how an owner thinks about it; every comparison after this line is in
    paise."""
    return int(round(float(rupees) * 100))


# ══════════════════════════════════════════════════════════════════════════════
#  Findings
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Finding:
    """One thing that is wrong, right now.

    `key` identifies the *condition*, so the same problem seen on the next scan
    collides with itself. `fingerprint` is what is currently true about it, so a
    condition that gets worse re-alerts instead of being suppressed.
    """

    key: str
    fingerprint: str
    headline: str
    rows: list[tuple[str, Any]]
    action: str
    meta: dict = field(default_factory=dict)
    #: Overrides the detector's audience — used by 8A.4.7, where the recipient
    #: is the team that owns the item.
    audience: tuple[str, ...] | None = None
    #: A body already rendered by a dedicated template, used where 8A.2 names a
    #: specific email rather than a generic alert.
    body_html: str | None = None
    subject: str | None = None


@dataclass(slots=True)
class Detector:
    """One numbered condition from 8A.4."""

    id: str
    spec: str
    #: One sentence, printed in the run summary and in the CRM.
    watches: str
    audience: tuple[str, ...]
    severity: str                                  # "warning" | "critical"
    sensitivity: str
    threshold_setting: str
    threshold_text: Callable[[], str]
    find: Callable[[], Awaitable[list[Finding]]]
    repeat_hours: Callable[[], int] = lambda: int(settings.alert_repeat_hours)
    #: Set when the condition cannot be evaluated in this deployment at all —
    #: a gateway mismatch with no gateway. Reported as `not_applicable`, which
    #: is a different fact from "no findings".
    unavailable: Callable[[], str | None] = lambda: None


# ══════════════════════════════════════════════════════════════════════════════
#  Repeat suppression — 8A.1.4
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Claim:
    fired: bool
    key: str
    reason: str
    occurrences: int = 0
    last_sent_at: datetime | None = None


async def claim(
    key: str,
    *,
    alert: str,
    spec: str,
    fingerprint: str,
    window_hours: int,
    meta: Mapping[str, Any] | None = None,
) -> Claim:
    """Take the right to send this alert, or be refused.

    One `update_one(..., upsert=True)` against a **unique** `key` index does the
    whole job, and the race is decided by the database rather than by this
    process:

      * the row does not exist        → inserted, and this run sends;
      * it exists, and either the window has passed or the fingerprint changed
                                      → updated, and this run sends;
      * it exists and neither is true → the update matches nothing, the upsert
        attempts an insert, the unique index refuses it, and this run does not
        send.

    Two workers scanning at the same second therefore produce one email, not
    two — which is the same guarantee `email_deliveries.dedupe_key` gives the
    transactional path.
    """
    from pymongo.errors import DuplicateKeyError, PyMongoError

    now = _now()
    cutoff = now - timedelta(hours=max(0, int(window_hours)))

    query = {
        "key": key,
        "$or": [
            {"last_sent_at": {"$lt": cutoff}},
            {"fingerprint": {"$ne": fingerprint}},
        ],
    }
    update = {
        "$set": {
            "alert": alert,
            "spec": spec,
            "fingerprint": fingerprint,
            "last_sent_at": now,
            "window_hours": int(window_hours),
            "meta": dict(meta or {}),
        },
        "$setOnInsert": {"key": key, "first_seen_at": now},
        "$inc": {"occurrences": 1},
    }

    from app.db.mongo import C

    try:
        result = await _c(C.ALERT_STATE).update_one(query, update, upsert=True)
    except DuplicateKeyError:
        existing = await _c(C.ALERT_STATE).find_one({"key": key}) or {}
        return Claim(
            fired=False,
            key=key,
            reason=(
                f"Already raised at {existing.get('last_sent_at')} and unchanged "
                f"since. The next email about it is due after {window_hours}h "
                "(ALERT_REPEAT_HOURS), or immediately if the condition worsens."
            ),
            occurrences=int(existing.get("occurrences", 0)),
            last_sent_at=existing.get("last_sent_at"),
        )
    except (PyMongoError, RuntimeError) as exc:
        # No suppression state means no way to promise this will not repeat.
        # Sending anyway is the lesser failure — a duplicate alert is noise, a
        # missed one is the thing 8A.4 exists to prevent — but it is recorded.
        log.error("Alert suppression state unavailable for %s: %s", key, exc)
        return Claim(
            fired=True,
            key=key,
            reason=f"Suppression state unavailable ({exc}); sent without dedupe.",
        )

    if result.matched_count or getattr(result, "upserted_id", None) is not None:
        existing = await _c(C.ALERT_STATE).find_one({"key": key}) or {}
        return Claim(
            fired=True,
            key=key,
            reason="First time, or the condition changed, or the window expired.",
            occurrences=int(existing.get("occurrences", 1)),
            last_sent_at=existing.get("last_sent_at"),
        )

    return Claim(fired=False, key=key, reason="Suppressed inside the repeat window.")


async def release(key: str) -> bool:
    """Forget a condition, so it alerts again the next time it is true.

    Called when something is resolved — a failed card re-executed, a duplicate
    reference cleared. Without this an alert that fires, is fixed, and recurs a
    day later would be suppressed as a repeat of the first one.
    """
    from app.db.mongo import C

    result = await _c(C.ALERT_STATE).delete_one({"key": key})
    return bool(getattr(result, "deleted_count", 0))


async def recent_state(limit: int = 200) -> list[dict]:
    """What has been raised, and when — the CRM's alert history."""
    from app.db.mongo import C

    cursor = (
        _c(C.ALERT_STATE).find({}).sort("last_sent_at", -1).limit(max(1, min(limit, 500)))
    )
    out = []
    async for doc in cursor:
        doc.pop("_id", None)
        out.append(doc)
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Shared queries
# ══════════════════════════════════════════════════════════════════════════════


def _lookback() -> datetime:
    """How far back a sweep looks.

    Capped so a job that has been switched off for a month does not wake up and
    email a month of history in one batch (ALERT_SCAN_MAX_LOOKBACK_HOURS).
    """
    return _now() - timedelta(hours=int(settings.alert_scan_max_lookback_hours))


async def _audit_since(actions: Sequence[str], since: datetime, limit: int = 200):
    from app.db.mongo import C

    cursor = (
        _c(C.AUDIT)
        .find({"action": {"$in": list(actions)}, "at": {"$gte": since}})
        .sort("at", -1)
        .limit(limit)
    )
    async for doc in cursor:
        yield doc


def _card_id(doc: Mapping[str, Any]) -> str:
    return str(doc.get("id") or doc.get("_id") or "")


def _age_hours(at: datetime | None) -> float | None:
    if not isinstance(at, datetime):
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return round((_now() - at).total_seconds() / 3600, 1)


def _amount_text(card: Mapping[str, Any]) -> str:
    """A card's amount, rendered in its own unit.

    Only the commission currency is minor units of rupees; coins and beans are
    counts. Printing a coin count with a rupee sign is how a figure ends up
    meaning two things.
    """
    currency = str(card.get("currency") or "")
    amount = card.get("amount")
    if currency == "commission":
        return mail.money(int(amount) if amount is not None else None)
    if amount is None:
        return "—"
    return mail.quantity(int(amount), currency or "units")


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.1 — company bank or gateway details changed
# ══════════════════════════════════════════════════════════════════════════════

#: What counts as a banking or gateway detail. Matched against the audit
#: subject, so a config key nobody thought of still trips it if it is named for
#: what it is.
_BANKING_SUBJECT = re.compile(
    r"bank|account|ifsc|upi|gateway|payout|razorpay|payu|cashfree|payment|"
    r"settlement|beneficiary|vpa|eCMS|virtual",
    re.IGNORECASE,
)


async def _find_bank_details_changed() -> list[Finding]:
    since = _lookback()
    out: list[Finding] = []
    async for entry in _audit_since(
        [audit_log.Action.CONFIG_CHANGED, audit_log.Action.RATE_CHANGED], since
    ):
        subject = entry.get("subject") or {}
        target = f"{subject.get('type', '')}/{subject.get('id', '')}"
        if not _BANKING_SUBJECT.search(target):
            continue
        entry_id = str(entry.get("_id"))
        actor = entry.get("actor") or {}
        out.append(
            Finding(
                key=f"bank_details:{entry_id}",
                fingerprint=entry_id,
                headline=(
                    f"A banking or payment-gateway detail was changed: {target}."
                ),
                rows=[
                    ("What changed", target),
                    ("Changed by", f"{actor.get('name', '?')} ({actor.get('role', '?')})"),
                    ("When", entry.get("at")),
                    ("Stated reason", entry.get("reason", "")),
                    ("Audit entry", entry_id),
                ],
                action=(
                    "Confirm with the person named above, by a channel other "
                    "than this email, that they made this change and that the "
                    "new details are correct. A changed beneficiary account is "
                    "how a payout run is diverted, and it is cheap to verify "
                    "and expensive not to."
                ),
                meta={"audit_id": entry_id, "subject": target},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.2 — FX / rate feed failed, last known rate held
# ══════════════════════════════════════════════════════════════════════════════


async def _find_rate_feed_failed() -> list[Finding]:
    from app.services import reports as rpt

    out: list[Finding] = []

    rates = await rpt.load_rates()
    if rates.provisional:
        missing = ", ".join(rates.missing) or "the economy configuration"
        out.append(
            Finding(
                key=f"rate_feed:provisional:{rates.source}",
                fingerprint="|".join(sorted(rates.missing)) or rates.source,
                headline=(
                    "The economy rate feed could not be read, so every money "
                    "report is running on documented fallback rates."
                ),
                rows=[
                    ("Rate source", rates.source),
                    ("Missing", missing),
                    (
                        "Diamond price held",
                        f"₹{rates.diamond_pack_price_inr_per_lakh:g} per "
                        f"{rpt.DIAMONDS_PER_LAKH:,} diamonds",
                    ),
                    ("Bean rate held", f"₹{rates.bean_to_inr:g} per bean"),
                    ("Read at", rates.fetched_at),
                ],
                action=(
                    "Check appConfig/economy in Firestore. Until it reads "
                    "cleanly, every report says PROVISIONAL on its face and no "
                    "figure produced from it should be quoted to a partner or "
                    "used to settle a payout."
                ),
                meta={"source": rates.source, "missing": list(rates.missing)},
            )
        )

    # A rate that has not moved in a long time is a different failure from one
    # that cannot be read: the feed answers, with something stale.
    from app.db.mongo import C

    stale_after = _now() - timedelta(hours=int(settings.alert_rate_stale_hours))
    latest = await _c(C.RATES).find_one({}, sort=[("effective_from", -1)])
    if latest:
        effective = latest.get("effective_from")
        if isinstance(effective, datetime):
            if effective.tzinfo is None:
                effective = effective.replace(tzinfo=timezone.utc)
            if effective < stale_after:
                out.append(
                    Finding(
                        key=f"rate_feed:stale:{latest.get('key', 'unknown')}",
                        fingerprint=effective.isoformat(),
                        headline=(
                            f"The rate '{latest.get('key', 'unknown')}' has not "
                            f"changed since {mail.when(effective)}, which is "
                            "longer than the staleness limit."
                        ),
                        rows=[
                            ("Rate", latest.get("key", "unknown")),
                            ("Last effective from", effective),
                            ("Age", f"{_age_hours(effective)} hours"),
                            (
                                "Staleness limit",
                                f"{settings.alert_rate_stale_hours} hours",
                            ),
                        ],
                        action=(
                            "Confirm the rate is deliberately unchanged rather "
                            "than the feed having stopped. A held rate is a "
                            "pricing decision when it is intended and a defect "
                            "when it is not, and both look identical on a "
                            "report."
                        ),
                        meta={"rate_key": latest.get("key")},
                    )
                )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.3 — duplicate payment reference detected
# ══════════════════════════════════════════════════════════════════════════════


async def _find_duplicate_payment_refs() -> list[Finding]:
    from app.db.mongo import C

    since = _now() - timedelta(days=int(settings.alert_duplicate_ref_lookback_days))
    pipeline = [
        {
            "$match": {
                "payload.payment_ref": {"$nin": [None, ""]},
                "created_at": {"$gte": since},
            }
        },
        {
            "$group": {
                "_id": "$payload.payment_ref",
                "cards": {"$push": {"id": "$_id", "amount": "$amount",
                                    "currency": "$currency", "stage": "$stage",
                                    "at": "$created_at", "subject": "$subject"}},
                "n": {"$sum": 1},
            }
        },
        {"$match": {"n": {"$gt": 1}}},
        {"$sort": {"n": -1}},
        {"$limit": 100},
    ]

    out: list[Finding] = []
    async for row in _c(C.CARDS).aggregate(pipeline):
        ref = str(row["_id"])
        cards = list(row.get("cards") or [])
        ids = sorted(str(c.get("id")) for c in cards)
        stages = ", ".join(sorted({str(c.get("stage")) for c in cards}))
        out.append(
            Finding(
                key=f"duplicate_ref:{ref}",
                # Every card id, so a third card on the same reference is a new
                # fact and re-alerts rather than being suppressed as a repeat.
                fingerprint="|".join(ids),
                headline=(
                    f"The payment reference {ref} appears on {len(cards)} "
                    "separate cards."
                ),
                rows=[
                    ("Payment reference", ref),
                    ("Cards carrying it", len(cards)),
                    ("Card ids", ", ".join(ids)),
                    ("Stages", stages),
                    ("Lookback", f"{settings.alert_duplicate_ref_lookback_days} days"),
                ],
                action=(
                    "Ask the bank whether one transfer arrived or several, "
                    "before any of these cards is executed. The same reference "
                    "on two cards is either one payment counted twice or two "
                    "payments recorded carelessly, and the two are corrected in "
                    "opposite directions (10.5)."
                ),
                meta={"payment_ref": ref, "card_ids": ids},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.4 / 8A.2.12 — a card above the owner-set amount, awaiting signature
# ══════════════════════════════════════════════════════════════════════════════


async def _find_large_card_awaiting_signature() -> list[Finding]:
    from app.db.mongo import C
    from app.services.cards import Stage

    threshold_minor = _rupees_to_minor(settings.alert_large_amount_inr)
    query = {
        # Only the commission currency is denominated in rupee minor units. A
        # coin count is not comparable to a rupee threshold and is not compared.
        "currency": "commission",
        "amount": {"$gte": threshold_minor},
        "stage": {
            "$in": [
                str(Stage.REQUESTED),
                str(Stage.UNDER_REVIEW),
                str(Stage.AWAITING_SIGNOFF),
            ]
        },
    }

    out: list[Finding] = []
    cursor = _c(C.CARDS).find(query).sort("amount", -1).limit(100)
    async for card in cursor:
        card_id = _card_id(card)
        raised = card.get("requested_by") or {}
        raised_by = f"{raised.get('name', '?')} ({raised.get('role', '?')})"
        amount = int(card.get("amount", 0))
        rows = [
            ("Amount", mail.money(amount)),
            ("Type", card.get("type", "")),
            ("Title", card.get("title", "")),
            ("Raised by", raised_by),
            ("Raised", card.get("created_at")),
            ("Stage", card.get("stage", "")),
            ("Waiting", f"{_age_hours(card.get('created_at'))} hours"),
            ("Card reference", card_id),
        ]
        out.append(
            Finding(
                key=f"large_card:{card_id}",
                # One email per card. The card sitting there for another day is
                # not new information; ageing is chased by 8A.4.7 instead.
                fingerprint=str(card.get("stage")),
                headline=(
                    f"{mail.money(amount)} is waiting for a signature — above "
                    f"the {mail.money(threshold_minor)} you set."
                ),
                rows=rows,
                action=(
                    "Open the money board and either sign it or reject it with "
                    "a reason. Nothing moves until one of you signs."
                ),
                meta={"card_id": card_id, "amount_minor": amount},
                body_html=mail.build_large_card_notice(
                    rows=rows,
                    raised_by=raised_by,
                    threshold=mail.money(threshold_minor),
                    suppression="one email per card, per stage",
                ),
                subject=f"Awaiting your signature — {mail.money(amount)}",
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.5 — execution failed, and money approved that has not moved
# ══════════════════════════════════════════════════════════════════════════════


async def _find_execution_failed() -> list[Finding]:
    from app.db.mongo import C
    from app.services.cards import Stage

    out: list[Finding] = []

    # (a) Signed, attempted, refused. The card is visibly stuck by design
    # (5.2.6) — this is what makes somebody look at it.
    cursor = _c(C.CARDS).find({"stage": str(Stage.FAILED)}).sort("updated_at", -1).limit(100)
    async for card in cursor:
        card_id = _card_id(card)
        result = card.get("execution_result") or {}
        error = str(result.get("error") or "no error recorded on the card")
        out.append(
            Finding(
                key=f"execution_failed:{card_id}",
                fingerprint=f"{card.get('updated_at')}",
                headline=(
                    f"A signed card failed to execute — {_amount_text(card)} was "
                    "authorised and the money did not move."
                ),
                rows=[
                    ("Amount", _amount_text(card)),
                    ("Type", card.get("type", "")),
                    ("Title", card.get("title", "")),
                    ("Signed by", (card.get("signed_by") or {}).get("name", "?")),
                    ("Signed", card.get("signed_at")),
                    ("Failure", error),
                    ("Card reference", card_id),
                ],
                action=(
                    "Establish whether the transfer left the bank. If it did, "
                    "the card is wrong and the ledger needs correcting; if it "
                    "did not, re-execute it. Do not raise a second card for the "
                    "same payment until you know which."
                ),
                meta={"card_id": card_id, "stage": str(Stage.FAILED)},
            )
        )

    # (b) Signed, and nothing has been attempted. Money an owner approved that
    # has not moved is the same exposure as a failure, discovered later.
    hours = int(settings.alert_signed_not_executed_hours)
    cutoff = _now() - timedelta(hours=hours)
    cursor = (
        _c(C.CARDS)
        .find({"stage": str(Stage.APPROVED), "signed_at": {"$lt": cutoff}})
        .sort("signed_at", 1)
        .limit(100)
    )
    async for card in cursor:
        card_id = _card_id(card)
        out.append(
            Finding(
                key=f"signed_not_executed:{card_id}",
                fingerprint=str(card.get("signed_at")),
                headline=(
                    f"{_amount_text(card)} was signed {_age_hours(card.get('signed_at'))} "
                    f"hours ago and still has not been executed."
                ),
                rows=[
                    ("Amount", _amount_text(card)),
                    ("Type", card.get("type", "")),
                    ("Title", card.get("title", "")),
                    ("Signed by", (card.get("signed_by") or {}).get("name", "?")),
                    ("Signed", card.get("signed_at")),
                    ("Waiting since signature", f"{_age_hours(card.get('signed_at'))} hours"),
                    ("Threshold", f"{hours} hours"),
                    ("Card reference", card_id),
                ],
                action=(
                    "Execute it, or reject it and say why. An approved card "
                    "that nobody executes is a liability the business has "
                    "accepted and a payment the partner has not received — the "
                    "worst of both."
                ),
                meta={"card_id": card_id, "hours": hours},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.6 — gateway settlement mismatch
# ══════════════════════════════════════════════════════════════════════════════

#: Written by a gateway settlement import. Nothing writes it today (10.17), so
#: the detector reports `not_applicable` rather than "all clear".
SETTLEMENTS = "gateway_settlements"


def _settlements_unavailable() -> str | None:
    if not settings.alert_settlement_tolerance_minor >= 0:
        return "ALERT_SETTLEMENT_TOLERANCE_MINOR is negative, which is not a tolerance."
    return None


async def _find_settlement_mismatch() -> list[Finding]:
    tolerance = int(settings.alert_settlement_tolerance_minor)
    try:
        count = await _c(SETTLEMENTS).count_documents({})
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"the settlement collection could not be read: {exc}") from exc

    if not count:
        # Distinguished from "no mismatch" by the caller, which reads this
        # marker and records the detector as not_applicable.
        raise NotApplicable(
            "No payment gateway is connected and no settlement file has ever "
            "been imported (10.17), so there is nothing to reconcile against. "
            "This is not a clean reconciliation — it is an absent one."
        )

    out: list[Finding] = []
    cursor = _c(SETTLEMENTS).find({"reconciled": {"$ne": True}}).limit(200)
    async for row in cursor:
        expected = int(row.get("expected_minor", 0))
        settled = int(row.get("settled_minor", 0))
        gap = settled - expected
        if abs(gap) <= tolerance:
            continue
        ref = str(row.get("settlement_id") or row.get("_id"))
        out.append(
            Finding(
                key=f"settlement_mismatch:{ref}",
                fingerprint=f"{expected}:{settled}",
                headline=(
                    f"Settlement {ref} differs from what was recorded by "
                    f"{mail.money(abs(gap))}."
                ),
                rows=[
                    ("Settlement", ref),
                    ("Recorded as received", mail.money(expected)),
                    ("Gateway settled", mail.money(settled)),
                    ("Difference", mail.money(gap)),
                    ("Tolerance", mail.money(tolerance)),
                    ("Settlement date", row.get("settled_at")),
                ],
                action=(
                    "Reconcile the settlement line by line before the next "
                    "payout run. A gap either way is unmatched money, and "
                    "unmatched money is never absorbed by silence (9.42)."
                ),
                meta={"settlement_id": ref, "difference_minor": gap},
            )
        )
    return out


class NotApplicable(Exception):
    """This condition cannot be evaluated in this deployment.

    Distinct from an error and from a clean result. `scan()` records it as its
    own outcome so a report never reads "0 mismatches" about a reconciliation
    that was never performed.
    """


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.7 — a queue item breaches its ageing limit
# ══════════════════════════════════════════════════════════════════════════════


async def _find_queue_ageing() -> list[Finding]:
    from app.db.mongo import C
    from app.services.cards import Stage

    team_hours = int(settings.alert_queue_age_hours)
    owner_hours = int(settings.alert_queue_escalate_hours)
    now = _now()
    open_stages = [
        str(Stage.REQUESTED),
        str(Stage.UNDER_REVIEW),
        str(Stage.AWAITING_SIGNOFF),
    ]

    out: list[Finding] = []
    cursor = (
        _c(C.CARDS)
        .find(
            {
                "stage": {"$in": open_stages},
                "created_at": {"$lt": now - timedelta(hours=team_hours)},
            }
        )
        .sort("created_at", 1)
        .limit(200)
    )
    async for card in cursor:
        card_id = _card_id(card)
        age = _age_hours(card.get("created_at")) or 0.0
        escalated = age >= owner_hours
        team = str(card.get("team") or "")

        # 8A.4.7 — "that team's admin, then owners if it persists". The
        # escalation is a separate key, so the team alert does not suppress it
        # and the owners are not told twice for the same breach.
        if escalated:
            audience = (str(Audience.OWNERS), f"{Audience.TEAM_ADMIN}:{team}")
            level = "owners"
            limit_text = f"{owner_hours} hours (escalation)"
        else:
            audience = (f"{Audience.TEAM_ADMIN}:{team}",)
            level = "team"
            limit_text = f"{team_hours} hours"

        if not team:
            # A card with no team has no team admin. It escalates immediately
            # rather than going nowhere.
            audience = (str(Audience.OWNERS),)
            level = "owners"

        out.append(
            Finding(
                key=f"queue_age:{card_id}:{level}",
                fingerprint=str(card.get("stage")),
                headline=(
                    f"A {card.get('stage')} card has been open for {age} hours, "
                    f"past its {limit_text} limit."
                ),
                rows=[
                    ("Title", card.get("title", "")),
                    ("Amount", _amount_text(card)),
                    ("Team", team or "unassigned"),
                    ("Stage", card.get("stage", "")),
                    ("Raised", card.get("created_at")),
                    ("Age", f"{age} hours"),
                    ("Ageing limit", limit_text),
                    ("Card reference", card_id),
                ],
                action=(
                    "Move it on or say why it is blocked. An item nobody is "
                    "acting on and nobody has explained is what makes a partner "
                    "chase staff for an answer (10.11)."
                ),
                audience=audience,
                meta={"card_id": card_id, "team": team, "level": level},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.8 — staff role changed or account deactivated
# ══════════════════════════════════════════════════════════════════════════════


async def _find_staff_access_changed() -> list[Finding]:
    since = _lookback()
    out: list[Finding] = []
    async for entry in _audit_since(
        [audit_log.Action.STAFF_ROLE_CHANGED, audit_log.Action.STAFF_DEACTIVATED],
        since,
    ):
        entry_id = str(entry.get("_id"))
        actor = entry.get("actor") or {}
        subject = entry.get("subject") or {}
        before = entry.get("before") or {}
        after = entry.get("after") or {}
        changed = entry.get("action") == audit_log.Action.STAFF_ROLE_CHANGED
        out.append(
            Finding(
                key=f"staff_access:{entry_id}",
                fingerprint=entry_id,
                headline=(
                    "A staff role was changed."
                    if changed
                    else "A staff account was deactivated."
                ),
                rows=[
                    ("Account", subject.get("id", "")),
                    ("Was", before.get("role") or before.get("is_active")),
                    ("Now", after.get("role") or after.get("is_active")),
                    ("Done by", f"{actor.get('name', '?')} ({actor.get('role', '?')})"),
                    ("When", entry.get("at")),
                    ("Stated reason", entry.get("reason", "")),
                ],
                action=(
                    "Confirm this was intended. Who holds which authority is "
                    "itself a governance record (Part 6), and a role change "
                    "nobody noticed is how an account keeps access it should "
                    "have lost."
                ),
                meta={"audit_id": entry_id, "uid": subject.get("id", "")},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  8A.4.9 — repeated failed logins on a staff account
# ══════════════════════════════════════════════════════════════════════════════


async def _find_failed_logins() -> list[Finding]:
    from app.db.mongo import C

    threshold = int(settings.alert_failed_login_threshold)
    window = int(settings.alert_failed_login_window_minutes)
    since = _now() - timedelta(minutes=window)

    pipeline = [
        {"$match": {"action": audit_log.Action.LOGIN_FAILED, "at": {"$gte": since}}},
        {
            "$group": {
                "_id": "$subject.id",
                "n": {"$sum": 1},
                "last": {"$max": "$at"},
                "first": {"$min": "$at"},
            }
        },
        {"$match": {"n": {"$gte": threshold}}},
        {"$sort": {"n": -1}},
        {"$limit": 50},
    ]

    out: list[Finding] = []
    async for row in _c(C.AUDIT).aggregate(pipeline):
        account = str(row["_id"] or "unknown")
        attempts = int(row["n"])
        # The window bucket is part of the key, so a fresh burst an hour later
        # is a new alert rather than a suppressed repeat of the first.
        bucket = row["last"].strftime("%Y%m%d%H") if isinstance(row["last"], datetime) else "?"
        out.append(
            Finding(
                key=f"failed_logins:{account}:{bucket}",
                fingerprint=str(attempts),
                headline=(
                    f"{attempts} failed sign-in attempts on {account} in the "
                    f"last {window} minutes."
                ),
                rows=[
                    ("Account", account),
                    ("Failed attempts", attempts),
                    ("Window", f"{window} minutes"),
                    ("Threshold", threshold),
                    ("First attempt", row.get("first")),
                    ("Last attempt", row.get("last")),
                ],
                action=(
                    "If this is not the account holder, deactivate the account "
                    "and revoke its sessions now, then contact them. If it is, "
                    "send them a password reset rather than telling them a "
                    "password over any channel."
                ),
                meta={"account": account, "attempts": attempts},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Credit overdue — 8A.2.11, the Finance half
# ══════════════════════════════════════════════════════════════════════════════


async def _find_credit_overdue() -> list[Finding]:
    from app.services import partners as partner_svc

    overdue = await partner_svc.overdue_sellers(limit=200)
    out: list[Finding] = []
    for seller in overdue:
        outstanding = int(seller.get("outstanding") or 0)
        days = seller.get("days_overdue")
        out.append(
            Finding(
                key=f"credit_overdue:{seller['id']}",
                # The amount, so a debt that grows re-alerts rather than being
                # suppressed at the figure it had when it first went overdue.
                fingerprint=str(outstanding),
                headline=(
                    f"{seller.get('name') or seller['id']} is "
                    f"{days} days overdue on "
                    f"{mail.quantity(outstanding, 'coins')} of credit."
                ),
                rows=[
                    ("Seller", seller.get("name") or seller["id"]),
                    ("Account", seller["id"]),
                    ("Outstanding", mail.quantity(outstanding, "coins")),
                    ("Was due", seller.get("due_at")),
                    ("Days overdue", days),
                    ("Standing", "Overdue — blocked from new inventory"),
                ],
                action=(
                    "The seller has been written to separately. Decide whether "
                    "to recover from their balance with the penalty in their "
                    "terms (9.10) or to accept a stated repayment plan. Credit "
                    "that is neither recovered nor written off stays an open "
                    "receivable on the books indefinitely."
                ),
                meta={"seller_id": seller["id"], "outstanding_coins": outstanding},
            )
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Failed deliveries — 8A.2.15
# ══════════════════════════════════════════════════════════════════════════════

#: An alert about undelivered mail must not itself become the thing it reports
#: on, so its own delivery rows are excluded from the sweep.
_SELF_KINDS = ("alert.delivery_failure",)


async def _find_delivery_failures() -> list[Finding]:
    since = _now() - timedelta(
        hours=int(settings.alert_delivery_failure_lookback_hours)
    )
    failures = [
        row
        for row in await mail.recent_failures(since=since, limit=200)
        if row.get("kind") not in _SELF_KINDS
    ]
    if not failures:
        return []

    by_outcome: dict[str, int] = {}
    by_kind: dict[str, int] = {}
    for row in failures:
        by_outcome[str(row.get("outcome"))] = by_outcome.get(str(row.get("outcome")), 0) + 1
        by_kind[str(row.get("kind"))] = by_kind.get(str(row.get("kind")), 0) + 1

    worst = sorted(by_outcome.items(), key=lambda kv: -kv[1])
    sample = failures[0]

    return [
        Finding(
            key="delivery_failures",
            fingerprint=f"{len(failures)}:{sorted(by_outcome.items())}",
            headline=(
                f"{len(failures)} emails did not reach their recipient in the "
                f"last {settings.alert_delivery_failure_lookback_hours} hours."
            ),
            rows=[
                ("Failed deliveries", len(failures)),
                ("By outcome", ", ".join(f"{k}: {v}" for k, v in worst)),
                ("Most affected", ", ".join(f"{k}: {v}" for k, v in
                                            sorted(by_kind.items(), key=lambda kv: -kv[1])[:4])),
                ("Most recent", sample.get("queued_at")),
                ("Most recent kind", sample.get("kind")),
                # The stored error, not a reconstruction. It never contains a
                # key: `deliver()` records the provider's response body, and no
                # credential is ever placed in one.
                ("Most recent cause", str(sample.get("error") or "")[:300]),
            ],
            action=(
                "Open the delivery list in the portal and read the causes. A "
                "403 means MAIL_FROM is not a verified sender and *nothing* is "
                "being delivered; a bounce means one address is dead and the "
                "partner behind it has not been told what they think they were "
                "told (8A.2.15)."
            ),
            meta={"count": len(failures), "by_outcome": by_outcome},
        )
    ]


# ══════════════════════════════════════════════════════════════════════════════
#  8B.4 / 8B.5 — chance mechanics: exposure, the reserve, and the odds
# ══════════════════════════════════════════════════════════════════════════════
#
# Four conditions, and one of them — the auto-suspend of 8B.4.5 — is also raised
# *immediately* by `chance.suspend_mechanic` through `raise_now` below rather
# than waiting for the next scan. Both paths exist on purpose and they are the
# same path underneath: the immediate one is what 8B.4.5 requires ("it does not
# keep paying while someone notices"), and the scheduled one is the backstop for
# the case the immediate send failed, which `claim()` makes cheap — a suspension
# already emailed is suppressed here, and one that was not is raised.
#
# Everything read below is read through `app/services/chance.py`, which is the
# only thing that knows how a reserve is modelled or how a divergence is judged.
# Re-deriving either here would give two answers to one question.


def _chance():
    from app.services import chance

    return chance


async def _find_chance_suspended() -> list[Finding]:
    """8B.4.5 — a mechanic that has stopped itself and is still stopped.

    The backstop for the immediate alert `chance.suspend_mechanic` sends through
    `raise_now`. Both use `claim()`, so a suspension already emailed is silently
    suppressed here and one whose email failed is raised on the next scan.
    """
    out: list[Finding] = []
    async for doc in _c("chance_mechanics").find({"suspended": {"$ne": None}}):
        state = doc.get("suspended") or {}
        breach = dict(state.get("breach") or {})
        mechanic_id = str(doc.get("_id"))
        out.append(
            Finding(
                key=f"chance:suspended:{mechanic_id}",
                fingerprint=str(state.get("at")),
                headline=(
                    f"{doc.get('name') or mechanic_id} is suspended and paying "
                    "nothing"
                ),
                rows=[
                    ("Mechanic", mechanic_id),
                    ("Suspended at", state.get("at")),
                    ("Suspended by", (state.get("by") or {}).get("name") or "the system"),
                    ("Automatic", "yes" if state.get("automatic") else "no"),
                    ("Reason", state.get("reason")),
                    ("Withheld on the breaching round", breach.get("withheld") or 0),
                ],
                action=(
                    "The mechanic is invisible to every player and accepts "
                    "nothing. It will not restart on its own: an owner resumes "
                    "it with a reason once they have decided whether the ceiling "
                    "was right, and raising a ceiling or a reserve is a signed "
                    "configuration card like any other change to money."
                ),
                meta={"mechanic_id": mechanic_id, "spec": "8B.4.5"},
            )
        )
    return out


async def _find_chance_reserve_low() -> list[Finding]:
    """8B.4.3 — the reserve is being consumed, before it is exhausted.

    The warning that makes the auto-suspend survivable. A mechanic that suspends
    with no notice looks like a fault; one that has been sending "80% of the
    reserve is gone" for a day looks like the control it is.
    """
    svc = _chance()
    threshold = int(getattr(settings, "chance_reserve_warning_ppm", 800_000))
    out: list[Finding] = []
    for position in await svc.exposure_snapshot():
        headline = position.get("headline") or {}
        consumed = headline.get("reserve_consumed_ppm")
        if consumed is None or consumed < threshold:
            continue
        if position.get("suspended"):
            continue  # the suspension alert is the louder one
        mechanic_id = position["mechanic_id"]
        out.append(
            Finding(
                key=f"chance:reserve_low:{mechanic_id}",
                # Every further 5% consumed re-alerts rather than waiting out
                # the window: a reserve going from 80% to 95% is news.
                fingerprint=f"{int(consumed) // 50_000}",
                headline=(
                    f"{position.get('name') or mechanic_id} has consumed "
                    f"{headline.get('reserve_consumed_percent')}% of its reserve"
                ),
                rows=[
                    ("Mechanic", mechanic_id),
                    ("Staked, lifetime", headline.get("staked")),
                    ("Paid out, lifetime", headline.get("paid_out")),
                    ("Position (staked − paid out)", headline.get("net")),
                    ("Reserve", headline.get("reserve")),
                    ("Headroom left", headline.get("headroom")),
                    ("Consumed", f"{headline.get('reserve_consumed_percent')}%"),
                    ("How the reserve was modelled", position.get("reserve_basis")),
                ],
                action=(
                    "Nothing has stopped and nothing needs to stop yet — a "
                    "reserve exists to be spent and short-run losses are certain "
                    "(8B.4.1). At zero headroom the mechanic auto-suspends. The "
                    "decisions available are to let it run, to lower the odds on "
                    "a signed card, or to raise the reserve on one — and the "
                    "guidance on the configuration card prices a three-sigma bad "
                    "run so the third is a number rather than a guess."
                ),
                meta={"mechanic_id": mechanic_id, "spec": "8B.4.3"},
            )
        )
    return out


async def _find_chance_rtp_divergence() -> list[Finding]:
    """8B.5.1 / 8B.5.2 — actual RTP outside the confidence bound.

    Two tests, and the pooled one is the one that matters. A single day beyond
    four sigma is raised because a day that far out is not luck; a week that
    stays beyond three sigma is raised because that is what 8B.5.2 means by
    *persistent*, and it is the shape a mis-set table, an exploit and a bug all
    make. Neither test is a percentage gap, and the alert names all three causes
    without choosing between them.
    """
    svc = _chance()
    out: list[Finding] = []
    async for doc in _c("chance_mechanics").find({"live_version": {"$ne": None}}):
        mechanic_id = str(doc.get("_id"))
        report = await svc.rtp_divergence(mechanic_id)
        pooled = report["pooled"]
        worst_day = next(
            (row for row in report["per_day"] if row["divergent"]), None
        )
        if not pooled["divergent"] and worst_day is None:
            continue
        subject = pooled if pooled["divergent"] else worst_day
        scope = (
            f"the {report['window_days']}-day window"
            if pooled["divergent"]
            else f"{worst_day['day']}"
        )
        out.append(
            Finding(
                key=f"chance:rtp:{mechanic_id}",
                fingerprint=f"{scope}:{subject['z_milli'] // 500}",
                headline=(
                    f"{doc.get('name') or mechanic_id} returned "
                    f"{subject['actual_rtp_percent']}% against a configured "
                    f"{subject['configured_rtp_percent']}% over {scope}"
                ),
                rows=[
                    ("Mechanic", mechanic_id),
                    ("Window", scope),
                    ("Rounds", subject["rounds"]),
                    ("Staked", subject["staked"]),
                    ("Paid out", subject["paid_out"]),
                    ("Expected payout, from the signed table", subject["expected_payout"]),
                    ("Configured RTP", f"{subject['configured_rtp_percent']}%"),
                    ("Actual RTP", f"{subject['actual_rtp_percent']}%"),
                    (
                        "Confidence bound on actual",
                        f"±{_ppm_percent(subject['confidence_band_ppm'])}% at "
                        f"{_sigma_text(subject['sigma_threshold_milli'])}",
                    ),
                    ("Standard deviations from expected", subject["z"]),
                    ("Capped rounds in the window", subject.get("capped_rounds")),
                    ("Configuration versions in play", subject.get("config_versions")),
                    ("Verdict", subject["verdict"]),
                ],
                action=(
                    "One of three things, and this alert deliberately does not "
                    "guess which: a configuration error (compare the live "
                    "version against the one before it — the diff is on the "
                    "card), an exploit (check whether the gap is concentrated in "
                    "a few players rather than spread across all of them), or a "
                    "bug (check the capped-round count, and that every payout "
                    "reconciles to a ledger movement). All three need attention "
                    "and all three look identical from here."
                ),
                meta={
                    "mechanic_id": mechanic_id,
                    "spec": "8B.5.2",
                    "z_milli": subject["z_milli"],
                    "causes": report["if_divergent"],
                },
            )
        )
    return out


async def _find_chance_player_anomaly() -> list[Finding]:
    """8B.5.3 — one player's figures do not look like anybody else's.

    Ops owns this queue (8B.5.6), so Ops is who it goes to. **It does not freeze
    anybody.** Freezing is a person's decision with a reason on it
    (`chance.freeze_player`), and an alert that acted on its own would be an
    automatic penalty applied on a statistical test, which 8B.5.4 refuses.
    """
    svc = _chance()
    out: list[Finding] = []
    for report in await svc.scan_player_anomalies():
        uid = report["player_uid"]
        kinds = sorted(f["kind"] for f in report["findings"])
        out.append(
            Finding(
                key=f"chance:player:{uid}",
                fingerprint=",".join(kinds),
                headline=(
                    f"Player {uid} — {', '.join(k.replace('_', ' ') for k in kinds)}"
                ),
                rows=[
                    ("Player", uid),
                    ("Window", f"{report['window_hours']} hours"),
                    ("Rounds", report["rounds"]),
                    ("Staked", report["staked"]),
                    ("Paid out", report["paid_out"]),
                    ("Their return", report["win_rate"].get("actual_rtp_percent")),
                    ("The table's return", report["win_rate"].get("configured_rtp_percent")),
                    ("Standard deviations", report["win_rate"].get("z")),
                    ("Already frozen", "yes" if report["frozen"] else "no"),
                ]
                + [(f["kind"].replace("_", " ").title(), f["detail"]) for f in report["findings"]],
                action=(
                    "Review the player's full round history — every round is "
                    "retained and queryable (8B.5.5). If the account should stop "
                    "playing while that happens, freeze it: that pauses chance "
                    "play only, moves no balance, reverses no round and is not a "
                    "ban (8B.5.4). Nothing has been done to this account "
                    "automatically."
                ),
                audience=("team_admin:ops", OWNERS),
                meta={"player_uid": uid, "spec": "8B.5.3", "kinds": kinds},
            )
        )
    return out


def _ppm_percent(ppm: Any) -> str:
    try:
        return f"{int(ppm) / 10_000:.4f}".rstrip("0").rstrip(".") or "0"
    except (TypeError, ValueError):  # pragma: no cover
        return "?"


def _sigma_text(milli: Any) -> str:
    try:
        return f"{int(milli) / 1_000:g} sigma"
    except (TypeError, ValueError):  # pragma: no cover
        return "?"


# ══════════════════════════════════════════════════════════════════════════════
#  The register
# ══════════════════════════════════════════════════════════════════════════════

OWNERS = str(Audience.OWNERS)
OBSERVER = str(Audience.OBSERVER)
FINANCE = str(Audience.FINANCE_ADMIN)

DETECTORS: tuple[Detector, ...] = (
    Detector(
        id="bank_details_changed",
        spec="8A.4.1",
        watches="A banking or payment-gateway detail changed in configuration.",
        audience=(OWNERS, OBSERVER),
        severity="critical",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting="ALERT_SCAN_MAX_LOOKBACK_HOURS",
        threshold_text=lambda: (
            "any change to a subject naming a bank account, UPI handle, "
            "gateway or beneficiary — there is no amount below which this is "
            "uninteresting"
        ),
        find=_find_bank_details_changed,
    ),
    Detector(
        id="rate_feed_failed",
        spec="8A.4.2",
        watches="The economy rate feed could not be read, or has not moved.",
        audience=(OWNERS, FINANCE),
        severity="warning",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="ALERT_RATE_STALE_HOURS",
        threshold_text=lambda: (
            "any fallback rate in use, or a rate unchanged for more than "
            f"{settings.alert_rate_stale_hours} hours"
        ),
        find=_find_rate_feed_failed,
    ),
    Detector(
        id="duplicate_payment_ref",
        spec="8A.4.3",
        watches="One payment reference on more than one card.",
        audience=(FINANCE, OWNERS),
        severity="critical",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="ALERT_DUPLICATE_REF_LOOKBACK_DAYS",
        threshold_text=lambda: (
            "any reference appearing on two or more cards raised in the last "
            f"{settings.alert_duplicate_ref_lookback_days} days"
        ),
        find=_find_duplicate_payment_refs,
    ),
    Detector(
        id="large_card_awaiting_signature",
        spec="8A.4.4 / 8A.2.12",
        watches="A card above the owner-set amount is waiting for a signature.",
        audience=(OWNERS,),
        severity="warning",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="ALERT_LARGE_AMOUNT_INR",
        threshold_text=lambda: (
            f"any card of {mail.money(_rupees_to_minor(settings.alert_large_amount_inr))} "
            "or more that is not yet signed"
        ),
        find=_find_large_card_awaiting_signature,
    ),
    Detector(
        id="execution_failed",
        spec="8A.4.5",
        watches=(
            "A signed card failed to execute, or was signed and never executed "
            "— money approved that has not moved."
        ),
        audience=(FINANCE, OWNERS),
        severity="critical",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="ALERT_SIGNED_NOT_EXECUTED_HOURS",
        threshold_text=lambda: (
            "any execution failure immediately, and any signed card still "
            f"unexecuted after {settings.alert_signed_not_executed_hours} hours"
        ),
        find=_find_execution_failed,
    ),
    Detector(
        id="settlement_mismatch",
        spec="8A.4.6",
        watches="A gateway settlement differs from what was recorded.",
        audience=(FINANCE, OWNERS),
        severity="critical",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="ALERT_SETTLEMENT_TOLERANCE_MINOR",
        threshold_text=lambda: (
            f"a difference above {mail.money(settings.alert_settlement_tolerance_minor)} "
            "— rounding at the aggregator is real, a rupee is not"
        ),
        find=_find_settlement_mismatch,
        unavailable=_settlements_unavailable,
    ),
    Detector(
        id="queue_ageing",
        spec="8A.4.7",
        watches="An open queue item past its ageing limit, escalating to owners.",
        audience=(OWNERS,),   # overridden per finding by the item's own team
        severity="warning",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting="ALERT_QUEUE_AGE_HOURS / ALERT_QUEUE_ESCALATE_HOURS",
        threshold_text=lambda: (
            f"{settings.alert_queue_age_hours} hours to the team admin, "
            f"{settings.alert_queue_escalate_hours} hours to the owners"
        ),
        find=_find_queue_ageing,
    ),
    Detector(
        id="staff_access_changed",
        spec="8A.4.8",
        watches="A staff role changed, or a staff account was deactivated.",
        audience=(OWNERS, OBSERVER),
        severity="warning",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting="ALERT_SCAN_MAX_LOOKBACK_HOURS",
        threshold_text=lambda: "every role change and every deactivation",
        find=_find_staff_access_changed,
    ),
    Detector(
        id="failed_logins",
        spec="8A.4.9",
        watches="Repeated failed sign-ins on one staff account.",
        audience=(OWNERS,),
        severity="critical",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting="ALERT_FAILED_LOGIN_THRESHOLD / _WINDOW_MINUTES",
        threshold_text=lambda: (
            f"{settings.alert_failed_login_threshold} failures on one account "
            f"inside {settings.alert_failed_login_window_minutes} minutes"
        ),
        find=_find_failed_logins,
    ),
    Detector(
        id="credit_overdue",
        spec="8A.2.11",
        watches="A seller's credit is past its due date.",
        audience=(FINANCE, OWNERS),
        severity="warning",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="CREDIT_OVERDUE_REPEAT_HOURS",
        threshold_text=lambda: "any outstanding credit past its due date",
        repeat_hours=lambda: int(settings.credit_overdue_repeat_hours),
        find=_find_credit_overdue,
    ),
    Detector(
        id="delivery_failures",
        spec="8A.2.15",
        watches="Email that the provider refused, bounced or dropped.",
        audience=(OWNERS, OBSERVER),
        severity="critical",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting="ALERT_DELIVERY_FAILURE_LOOKBACK_HOURS",
        threshold_text=lambda: (
            "any failed delivery in the last "
            f"{settings.alert_delivery_failure_lookback_hours} hours"
        ),
        find=_find_delivery_failures,
    ),
    # ── Part 8B — chance mechanics ───────────────────────────────────────────
    Detector(
        id="chance_mechanic_suspended",
        spec="8B.4.5",
        watches=(
            "A chance mechanic has auto-suspended on a payout ceiling and is "
            "paying nothing."
        ),
        audience=(OWNERS, FINANCE),
        severity="critical",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        # The ceilings that suspend a mechanic live in its **signed
        # configuration** (8B.4.3 / 8B.4.4), not in an environment variable —
        # they are money and they move on a card. This names the one
        # cross-mechanic backstop that is a setting.
        threshold_setting="CHANCE_PLATFORM_DAILY_PAYOUT_CEILING",
        threshold_text=lambda: (
            "any payout that would cross the reserve or a daily ceiling in the "
            "mechanic's signed configuration — those figures move on a card, "
            "not on a setting; the environment variable named here is only the "
            "backstop that applies across every mechanic at once"
        ),
        find=_find_chance_suspended,
    ),
    Detector(
        id="chance_reserve_low",
        spec="8B.4.3",
        watches="A chance mechanic is consuming its modelled reserve.",
        audience=(OWNERS, FINANCE),
        severity="warning",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting="CHANCE_RESERVE_WARNING_PPM",
        threshold_text=lambda: (
            f"{int(settings.chance_reserve_warning_ppm) / 10_000:g}% of the "
            "reserve consumed, and again on every further 5%"
        ),
        find=_find_chance_reserve_low,
    ),
    Detector(
        id="chance_rtp_divergence",
        spec="8B.5.1 / 8B.5.2",
        watches=(
            "Actual return to player outside the confidence bound of the signed "
            "outcome table."
        ),
        audience=(OWNERS, FINANCE),
        severity="critical",
        sensitivity=str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting=(
            "CHANCE_RTP_DAILY_SIGMA_MILLI / CHANCE_RTP_WINDOW_SIGMA_MILLI / "
            "CHANCE_RTP_MIN_ROUNDS"
        ),
        threshold_text=lambda: (
            f"{int(settings.chance_rtp_daily_sigma_milli) / 1_000:g} standard "
            "deviations on one day, or "
            f"{int(settings.chance_rtp_window_sigma_milli) / 1_000:g} sustained "
            f"over {settings.chance_rtp_window_days} days — computed from the "
            "variance of the signed table itself, and never below "
            f"{settings.chance_rtp_min_rounds} rounds whatever the figure says, "
            "because a small sample diverges by a lot and calling that an "
            "exploit is how the alert gets ignored"
        ),
        find=_find_chance_rtp_divergence,
    ),
    Detector(
        id="chance_player_anomaly",
        spec="8B.5.3",
        watches=(
            "A player's win rate, frequency or timing is outside what the "
            "configured odds and a human being can produce."
        ),
        # 8B.5.6 — Ops owns the exception queue. Overridden per finding.
        audience=("team_admin:ops", OWNERS),
        severity="warning",
        sensitivity=str(mail.Sensitivity.OPERATIONAL),
        threshold_setting=(
            "CHANCE_PLAYER_SIGMA_MILLI / CHANCE_PLAYER_MIN_ROUNDS / "
            "CHANCE_PLAYER_MAX_ROUNDS_PER_HOUR / CHANCE_PLAYER_MIN_ROUND_GAP_MS"
        ),
        threshold_text=lambda: (
            f"{int(settings.chance_player_sigma_milli) / 1_000:g} standard "
            f"deviations over at least {settings.chance_player_min_rounds} "
            f"rounds, more than {settings.chance_player_max_rounds_per_hour} "
            "rounds an hour, or two rounds closer together than "
            f"{settings.chance_player_min_round_gap_ms} ms"
        ),
        find=_find_chance_player_anomaly,
    ),
)

DETECTORS_BY_ID: dict[str, Detector] = {d.id: d for d in DETECTORS}


def catalogue() -> list[dict]:
    """What is watched, at what threshold, and who is told. For the CRM."""
    return [
        {
            "id": d.id,
            "spec": d.spec,
            "watches": d.watches,
            "audience": list(d.audience),
            "severity": d.severity,
            "threshold": d.threshold_text(),
            "threshold_setting": d.threshold_setting,
            "repeat_hours": d.repeat_hours(),
        }
        for d in DETECTORS
    ]


# ══════════════════════════════════════════════════════════════════════════════
#  scan() — run every detector, send what is new
# ══════════════════════════════════════════════════════════════════════════════


def _suppression_text(detector: Detector) -> str:
    return (
        f"one email per condition per {detector.repeat_hours()} hours, and "
        "immediately again if the condition changes"
    )


async def _send(detector: Detector, finding: Finding) -> dict:
    """Resolve the audience and deliver one finding."""
    audience = finding.audience or detector.audience
    people = await notify.resolve(audience)

    if not people.ok:
        return {
            "key": finding.key,
            "sent": 0,
            "delivered": [],
            "recipients": people.summary(),
            "error": people.why_empty(),
        }

    body = finding.body_html or mail.build_alert(
        headline=finding.headline,
        spec=detector.spec,
        severity=detector.severity,
        rows=finding.rows,
        action=finding.action,
        threshold=detector.threshold_text(),
        threshold_setting=detector.threshold_setting,
        suppression=_suppression_text(detector),
    )
    subject = finding.subject or f"Zipper alert — {finding.headline[:120]}"

    rows = await mail.deliver_many(
        people.recipients,
        kind=f"alert.{detector.id}",
        spec=detector.spec,
        subject=subject,
        html=mail.page(
            title=finding.headline[:120],
            preheader=finding.action[:180],
            body=body,
        ),
        sensitivity=detector.sensitivity,
        # One row per recipient per condition-state. Two workers racing the same
        # finding collide here as well as on the alert state.
        dedupe_prefix=f"alert:{detector.id}:{finding.key}:{finding.fingerprint}",
        meta={"alert": detector.id, "spec": detector.spec, **finding.meta},
        # Machine-generated and on a standing list, so it leaves from the bulk
        # identity and carries List-Unsubscribe — but **not** one-click. An
        # alert is deliberately not mutable by a POST: 8A.4 exists so that an
        # exception cannot be switched off, and alerts do not consult the
        # subscriptions table at all. The mailto route reaches a person who can
        # change the audience, which is the only honest way to stop these.
        identity=mail.SenderIdentity.BULK,
        unsubscribe=mail.Unsubscribe(
            report=f"alert.{detector.id}", cadence="event", one_click=False
        ),
    )

    return {
        "key": finding.key,
        "sent": sum(1 for r in rows if r.get("outcome") == str(mail.Outcome.SENT)),
        "outcomes": [r.get("outcome") for r in rows],
        "recipients": people.summary(),
        "error": None,
    }


async def raise_now(
    *,
    alert: str,
    spec: str,
    severity: str,
    audience: Sequence[str],
    key: str,
    fingerprint: str,
    headline: str,
    rows: Sequence[tuple[str, Any]],
    action: str,
    threshold: str,
    threshold_setting: str,
    meta: Mapping[str, Any] | None = None,
    sensitivity: str | None = None,
    repeat_hours: int | None = None,
) -> dict:
    """Send one alert immediately, outside the scan. Spec 8B.4.5.

    Every detector above is *pulled* by `scan()` on a schedule, and a schedule
    is the wrong shape for a mechanic that has just stopped paying: 8B.4.5 says
    it must not keep paying while somebody notices, and the same sentence
    applies to the telling. So a condition detected inside a live code path —
    today, a chance mechanic auto-suspending — pushes here instead of waiting.

    **It is the same machinery, not a second one.** The same `claim()` decides
    whether this has already been sent, the same `_send()` resolves the audience
    from the staff record, renders the same template, records the same delivery
    row and applies the same dedupe key. A parallel "urgent mailer" would be a
    second audience resolver, a second suppression store and a second set of
    delivery records — and the one used twice a year would be the one that was
    broken when it mattered.

    The caller decides what to do with a failure. `chance.suspend_mechanic`
    logs it and carries on, because the *stop* is not conditional on the email
    and the scheduled detector will raise the same condition on the next scan.
    """
    detector = Detector(
        id=alert,
        spec=spec,
        watches=headline,
        audience=tuple(audience),
        severity=severity,
        sensitivity=sensitivity or str(mail.Sensitivity.BUSINESS_MONEY),
        threshold_setting=threshold_setting,
        threshold_text=lambda: threshold,
        find=_never,
        repeat_hours=lambda: int(
            repeat_hours
            if repeat_hours is not None
            else settings.alert_repeat_hours
        ),
    )
    finding = Finding(
        key=key,
        fingerprint=fingerprint,
        headline=headline,
        rows=list(rows),
        action=action,
        meta=dict(meta or {}),
    )
    outcome = await claim(
        finding.key,
        alert=detector.id,
        spec=detector.spec,
        fingerprint=finding.fingerprint,
        window_hours=detector.repeat_hours(),
        meta=finding.meta,
    )
    if not outcome.fired:
        return {"key": finding.key, "sent": 0, "suppressed": True,
                "reason": outcome.reason}
    try:
        result = await _send(detector, finding)
    except Exception:  # noqa: BLE001
        # The state row says this was raised. Release it, so the scheduled
        # detector that watches the same condition raises it on the next scan
        # rather than treating an alert nobody received as one that was sent.
        await release(finding.key)
        raise
    result["suppressed"] = False
    return result


async def _never() -> list[Finding]:
    """A `Detector` built for `raise_now` is never scanned; it is pushed to."""
    return []


async def scan(only: Sequence[str] | None = None) -> dict:
    """Run every detector. Returns a per-detector account of what happened.

    Nothing here collapses an error into an empty result. Each detector ends as
    exactly one of:

      * `ok`             — it ran, and found what it found (possibly nothing);
      * `not_applicable` — it cannot be evaluated here, with the reason;
      * `failed`         — it could not run, with the reason.

    The daily exception report prints all three, so "no mismatches" and "the
    reconciliation never happened" can never be read as the same thing.
    """
    started = _now()
    wanted = set(only or [])
    sections: list[dict] = []
    fired = suppressed = sent = 0

    for detector in DETECTORS:
        if wanted and detector.id not in wanted:
            continue

        section: dict[str, Any] = {
            "id": detector.id,
            "spec": detector.spec,
            "watches": detector.watches,
            "threshold": detector.threshold_text(),
            "threshold_setting": detector.threshold_setting,
            "audience": list(detector.audience),
            "repeat_hours": detector.repeat_hours(),
        }

        blocked = detector.unavailable()
        if blocked:
            section.update(status="not_applicable", reason=blocked, findings=0)
            sections.append(section)
            continue

        try:
            findings = await detector.find()
        except NotApplicable as exc:
            section.update(status="not_applicable", reason=str(exc), findings=0)
            sections.append(section)
            continue
        except Exception as exc:  # noqa: BLE001 — one broken detector, not the run
            log.exception("Alert detector %s failed", detector.id)
            section.update(
                status="failed",
                reason=(
                    f"{type(exc).__name__}: {exc}. This condition was NOT "
                    "checked on this run — treat it as unknown, not as clear."
                ),
                findings=None,
            )
            sections.append(section)
            continue

        raised: list[dict] = []
        held: list[dict] = []
        for finding in findings:
            outcome = await claim(
                finding.key,
                alert=detector.id,
                spec=detector.spec,
                fingerprint=finding.fingerprint,
                window_hours=detector.repeat_hours(),
                meta=finding.meta,
            )
            if not outcome.fired:
                suppressed += 1
                held.append({"key": finding.key, "reason": outcome.reason})
                continue

            fired += 1
            try:
                result = await _send(detector, finding)
            except Exception as exc:  # noqa: BLE001
                log.exception("Alert %s could not be delivered", finding.key)
                # The state row already says this was raised. Release it so the
                # next scan tries again rather than treating an alert that was
                # never sent as one that was.
                await release(finding.key)
                raised.append({"key": finding.key, "sent": 0, "error": str(exc)})
                continue
            sent += int(result.get("sent") or 0)
            raised.append(result)

        section.update(
            status="ok",
            findings=len(findings),
            raised=raised,
            suppressed=held,
        )
        sections.append(section)

    summary = {
        "job": "alerts.scan",
        "started_at": started,
        "finished_at": _now(),
        "detectors": len(sections),
        "fired": fired,
        "suppressed": suppressed,
        "emails_accepted": sent,
        "failed_detectors": [s["id"] for s in sections if s.get("status") == "failed"],
        "not_applicable": [s["id"] for s in sections if s.get("status") == "not_applicable"],
        "sections": sections,
    }
    await _record_run(summary)
    return summary


async def _record_run(summary: dict) -> dict:
    """One run log for every unattended job, including this one.

    Delegated to `scheduling.record_run` rather than reimplemented, so an alert
    scan and a report run are stamped with the same verdict, the same trigger
    and the same "the row could not be written" behaviour — and appear on the
    same `/notifications/runs/last` page. Imported inside the function because
    `scheduling` imports this module at the top of its own.
    """
    from app.services.scheduling import record_run

    return await record_run(summary)


async def open_findings() -> list[dict]:
    """Everything currently wrong, without sending anything.

    Used by the daily exception report (8A.3.3), which must be able to state the
    exceptions whether or not each one was individually emailed.
    """
    out: list[dict] = []
    for detector in DETECTORS:
        blocked = detector.unavailable()
        if blocked:
            out.append({"id": detector.id, "spec": detector.spec,
                        "status": "not_applicable", "reason": blocked})
            continue
        try:
            findings = await detector.find()
        except NotApplicable as exc:
            out.append({"id": detector.id, "spec": detector.spec,
                        "status": "not_applicable", "reason": str(exc)})
            continue
        except Exception as exc:  # noqa: BLE001
            out.append({"id": detector.id, "spec": detector.spec,
                        "status": "failed", "reason": f"{type(exc).__name__}: {exc}"})
            continue
        for finding in findings:
            out.append(
                {
                    "id": detector.id,
                    "spec": detector.spec,
                    "status": "ok",
                    "severity": detector.severity,
                    "key": finding.key,
                    "headline": finding.headline,
                    "action": finding.action,
                    "meta": finding.meta,
                }
            )
    return out
