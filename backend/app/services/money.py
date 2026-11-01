"""The money core.

Every balance movement in the business goes through `apply_movement`. There is
no other write path. Spec 1.2 of BUILD-PLAN.md, Part 5 and Part 6 of CRM-FLOW.md.

Guarantees:
  * balance change + ledger entry + audit entry commit together, or not at all
  * a reason is mandatory
  * an idempotency key can never be applied twice
  * a debit cannot take a balance below zero unless explicitly permitted
  * Mongo is authoritative; Firestore is synced afterwards as a read replica

B1 (M-1): a replica sync that fails is recorded on the balance row
(`replica_stale`, `replica_pending`) **and is repaired** — by
`repair_replica_drift`, which replays every pending delta exactly once, keyed on
the ledger row that produced it — and alerted (`alerts.replica_drift`) until it
is. A buyer who paid cash and was credited in Mongo no longer waits on a flag
nobody reads.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from pymongo.errors import DuplicateKeyError

from app.core import audit
from app.core.compat import StrEnum
from app.db import firebase
from app.db.mongo import C, get_client, get_db

log = logging.getLogger(__name__)


class Currency(StrEnum):
    DIAMONDS = "diamonds"      # user spending currency
    BEANS = "beans"            # host earning currency
    COINS = "coins"            # seller inventory
    #: Agency commission balance, in **minor units (paise)**. The Firestore
    #: mirror `agencies.commissionBalance` carries the same paise figure (it is
    #: an `Increment` of every movement); `agencies.commissionBalanceInr` is
    #: the rupee value for display, written beside it by every sync (M-15).
    COMMISSION = "commission"


class HolderType(StrEnum):
    USER = "user"
    SELLER = "seller"
    AGENCY = "agency"


class InsufficientBalance(Exception):
    def __init__(self, holder_id: str, currency: str, available: int, requested: int):
        self.holder_id = holder_id
        self.currency = currency
        self.available = available
        self.requested = requested
        super().__init__(
            f"{holder_id} has {available} {currency}, cannot debit {requested}"
        )


class DuplicateMovement(Exception):
    """The same idempotency key was already applied."""


@dataclass(slots=True)
class Movement:
    holder_type: HolderType
    holder_id: str
    currency: Currency
    amount: int          # positive credits, negative debits
    action: str          # an audit.Action value
    reason: str
    actor: dict
    card_id: str | None = None
    idempotency_key: str | None = None
    allow_negative: bool = False
    meta: dict | None = None
    #: The Firestore side of this movement has **already been applied by the
    #: caller**, so `apply_movement` must not apply it a second time.
    #:
    #: Almost every movement is decided in Mongo and copied outward, which is
    #: what the delta sync below does. A host bean withdrawal is the one place
    #: that runs the other way: the figure that decides whether a host may be
    #: paid is Firestore's `beansAvailable`, and the debit has to happen under a
    #: Firestore transaction that re-checks it, or a card signed yesterday
    #: overdraws a host who converted beans away this morning. By the time the
    #: ledger row is written the money has already moved, and the sync here
    #: would move it again — paying the host once and debiting them twice.
    #:
    #: It is a flag rather than a second write path because there must go on
    #: being exactly one function that writes the ledger. What changes is who
    #: moved the live balance, not whether the movement is recorded.
    replica_applied_by_caller: bool = False
    #: M-18: the app-visible history row the replica sync writes beside the
    #: balance delta — `{"id": ..., "reason": ..., **fields}` — so a sale
    #: credit or an admin credit explains itself on the person's own history
    #: screen. Only meaningful for a USER holder (`diamondTransactions` /
    #: `beanTransactions`); the id is deterministic so a replayed sync (or the
    #: drift repair) writes one row, not two.
    history: dict | None = None


@dataclass(slots=True)
class MovementResult:
    ledger_id: str
    audit_id: str
    balance_before: int
    balance_after: int
    replica_synced: bool


async def get_balance(
    holder_type: HolderType, holder_id: str, currency: Currency
) -> int:
    doc = await get_db()[C.BALANCES].find_one(
        {
            "holder_type": str(holder_type),
            "holder_id": holder_id,
            "currency": str(currency),
        }
    )
    return int(doc["amount"]) if doc else 0


async def already_applied(idempotency_key: str | None) -> dict | None:
    """The ledger row this key already produced, or None.

    M-14: the question "has this movement happened" has to be answerable
    before any balance arithmetic, so a retried approval whose debit already
    landed is told "already applied" rather than "insufficient balance".
    """
    if not idempotency_key:
        return None
    return await get_db()[C.LEDGER].find_one({"idempotency_key": idempotency_key})


async def apply_movement(m: Movement) -> MovementResult:
    """Apply one balance movement atomically.

    Raises InsufficientBalance or DuplicateMovement. On success the ledger and
    audit log are already committed before Firestore is touched.

    M-14: the idempotency key is probed FIRST. A movement that already landed
    raises `DuplicateMovement` whatever the balance says now — the balance
    check used to run first, so a retry of a debit that had already been taken
    reported "insufficient" and a human then rejected a recharge whose seller
    had in fact been debited.
    """
    if m.amount == 0:
        raise ValueError("A movement of zero has no meaning")
    if not m.reason or not m.reason.strip():
        raise ValueError("Every movement requires a reason. Spec 6.1.4.")

    db = get_db()
    key = {
        "holder_type": str(m.holder_type),
        "holder_id": m.holder_id,
        "currency": str(m.currency),
    }
    now = datetime.now(timezone.utc)

    async with await get_client().start_session() as session:
        async with session.start_transaction():
            if m.idempotency_key:
                prior = await db[C.LEDGER].find_one(
                    {"idempotency_key": m.idempotency_key}, session=session
                )
                if prior is not None:
                    raise DuplicateMovement(
                        f"Movement {m.idempotency_key} was already applied"
                    )

            current = await db[C.BALANCES].find_one(key, session=session)
            before = int(current["amount"]) if current else 0
            after = before + m.amount

            if after < 0 and not m.allow_negative:
                raise InsufficientBalance(
                    m.holder_id, str(m.currency), before, abs(m.amount)
                )

            await db[C.BALANCES].update_one(
                key,
                {
                    "$set": {"amount": after, "updated_at": now},
                    "$setOnInsert": {**key, "created_at": now},
                },
                upsert=True,
                session=session,
            )

            ledger_doc = {
                **key,
                "at": now,
                "amount": m.amount,
                "balance_before": before,
                "balance_after": after,
                "action": m.action,
                "reason": m.reason.strip(),
                "actor": {
                    "uid": m.actor.get("uid", ""),
                    "name": m.actor.get("name", ""),
                    "role": m.actor.get("role", ""),
                },
                "card_id": m.card_id,
                "meta": m.meta or {},
            }
            if m.idempotency_key:
                ledger_doc["idempotency_key"] = m.idempotency_key

            try:
                ledger_result = await db[C.LEDGER].insert_one(
                    ledger_doc, session=session
                )
            except DuplicateKeyError as exc:
                # The probe above and this unique index are the same guarantee
                # seen from two sides: the probe answers a retry politely, the
                # index decides a race the probe could not see.
                raise DuplicateMovement(
                    f"Movement {m.idempotency_key} was already applied"
                ) from exc

            audit_id = await audit.record(
                actor=m.actor,
                action=m.action,
                subject_type=str(m.holder_type),
                subject_id=m.holder_id,
                reason=m.reason,
                before={str(m.currency): before},
                after={str(m.currency): after},
                card_id=m.card_id,
                meta={"amount": m.amount, **(m.meta or {})},
                session=session,
            )

    ledger_id = str(ledger_result.inserted_id)
    history = _history_for(m, ledger_id)

    # Committed. Now move the balance the app reads BY THIS MOVEMENT — not to
    # Mongo's post-movement total. The app spends diamonds through Cloud
    # Functions that Mongo never hears about, so `after` is only ever a lower
    # bound on the truth, and writing it over the live balance refunded every
    # gift and call charge since the CRM last touched this holder.
    #
    # Unless the caller moved it already — see `replica_applied_by_caller`. The
    # number has to move exactly once, and for a host withdrawal it moved under
    # a Firestore transaction before this ledger row existed.
    if m.replica_applied_by_caller:
        synced = True
    else:
        synced = await asyncio.to_thread(
            firebase.sync_balance_to_firestore,
            str(m.holder_type), m.holder_id, str(m.currency), m.amount,
            balance_after=after, history=history, marker_id=ledger_id,
        )
        if not synced:
            # The ledger is committed and the app's balance did not move. Say
            # so on the balance row, with the exact delta still owed, so
            # `find_replica_drift` and `repair_replica_drift` see the gap
            # instead of a silent False that a retry's DuplicateMovement then
            # hides. The repair replays this entry keyed on `ledger_id`.
            try:
                await db[C.BALANCES].update_one(key, {
                    "$set": {"replica_stale": True, "replica_stale_at": now},
                    "$push": {"replica_pending": {
                        "delta": m.amount, "idempotency_key": m.idempotency_key,
                        "ledger_id": ledger_id, "at": now,
                        "balance_after": after, "history": history,
                    }},
                })
            except Exception:  # noqa: BLE001 — logged loudly; the ledger stands
                log.exception("Could not mark %s/%s/%s replica_stale", m.holder_type, m.holder_id, m.currency)

    return MovementResult(
        ledger_id=ledger_id,
        audit_id=audit_id,
        balance_before=before,
        balance_after=after,
        replica_synced=synced,
    )


def _history_for(m: Movement, ledger_id: str) -> dict | None:
    """The app-visible history row this movement should leave, if any (M-18).

    Only a user's own currencies have a history screen. The row is a copy of
    what the caller asked for plus the two facts the app shows on every row:
    the direction and the amount. `ledgerId` ties it to the Mongo row.
    """
    if m.history is None or str(m.holder_type) != str(HolderType.USER):
        return None
    if str(m.currency) not in (str(Currency.DIAMONDS), str(Currency.BEANS)):
        return None
    row = dict(m.history)
    row_id = str(row.pop("id", "") or "").strip()
    if not row_id:
        return None
    return {
        "id": row_id,
        "type": "credit" if m.amount > 0 else "debit",
        "amount": abs(int(m.amount)),
        "reason": str(row.pop("reason", "") or m.reason),
        "ledgerId": ledger_id,
        **{str(k): v for k, v in row.items()},
    }


async def transfer(
    *,
    from_holder: tuple[HolderType, str],
    to_holder: tuple[HolderType, str],
    currency: Currency,
    amount: int,
    action: str,
    reason: str,
    actor: dict,
    card_id: str | None = None,
    idempotency_key: str | None = None,
) -> tuple[MovementResult, MovementResult]:
    """Move value between two holders.

    Applied as two movements. The debit runs first so an insufficient balance
    stops the transfer before anything is credited.
    """
    if amount <= 0:
        raise ValueError("Transfer amount must be positive")

    debit = await apply_movement(
        Movement(
            holder_type=from_holder[0],
            holder_id=from_holder[1],
            currency=currency,
            amount=-amount,
            action=action,
            reason=reason,
            actor=actor,
            card_id=card_id,
            idempotency_key=f"{idempotency_key}:debit" if idempotency_key else None,
            meta={"transfer_to": to_holder[1]},
        )
    )
    credit = await apply_movement(
        Movement(
            holder_type=to_holder[0],
            holder_id=to_holder[1],
            currency=currency,
            amount=amount,
            action=action,
            reason=reason,
            actor=actor,
            card_id=card_id,
            idempotency_key=f"{idempotency_key}:credit" if idempotency_key else None,
            meta={"transfer_from": from_holder[1]},
        )
    )
    return debit, credit


async def ledger_for(
    holder_type: HolderType,
    holder_id: str,
    currency: Currency | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict]:
    """One holder's full movement history — the partner statement source."""
    q: dict = {"holder_type": str(holder_type), "holder_id": holder_id}
    if currency:
        q["currency"] = str(currency)

    cursor = get_db()[C.LEDGER].find(q).sort("at", -1).skip(skip).limit(min(limit, 500))
    out = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        out.append(doc)
    return out


async def find_replica_drift(limit: int = 500) -> list[dict]:
    """Balances whose last Firestore sync failed.

    Used by the reconciliation job, the `replica_drift` alert detector and
    the repair below. A drift entry means Mongo is right and Firestore is
    stale — never the other way round.
    """
    cursor = get_db()[C.BALANCES].find({"replica_stale": True}).limit(limit)
    return [doc async for doc in cursor]


#: How many times the repair re-reads a balance row whose pending list moved
#: under it (a new sync failing while it was being repaired) before giving up
#: on that row for this run.
_REPAIR_CAS_ATTEMPTS = 5


async def repair_replica_drift(
    *, actor: Mapping[str, Any] | None = None, limit: int = 200,
) -> dict:
    """M-1 — replay every pending replica delta, once each, and clear the flag.

    For each stale balance row, each `replica_pending` entry is pushed to
    Firestore through `firebase.apply_replica_delta_once`, which writes the
    `Increment` (and the app-visible history row, if the movement carried one)
    in a transaction that first reads a marker keyed on the entry's **ledger
    id**. A delta that already reached Firestore — because the original sync
    did land and only its answer was lost, or because an earlier repair run
    died after the write — is skipped, so a repair can never double-credit.

    The Mongo bookkeeping is a compare-and-set on the exact pending list that
    was read: a sync failing concurrently appends to that list, the CAS
    misses, and the row is re-read rather than overwritten. Entries that were
    replayed move to `replica_repaired` (history is kept, never deleted);
    `replica_stale` clears only when nothing is left pending.

    Never raises for one row's failure: the row stays stale, the failure is
    recorded on it and in the audit log, and the `replica_drift` alert keeps
    pointing at it. Returns a summary the router and the sweep both report.
    """
    db = get_db()
    who = dict(actor or {"uid": "system:replica-repair", "name": "Replica repair",
                         "role": "system", "team": None})
    rows = await find_replica_drift(limit)
    summary = {"rows": len(rows), "repaired": 0, "replayed": 0, "already_applied": 0,
               "failed": 0, "details": []}

    for row in rows:
        key = {"holder_type": str(row.get("holder_type") or ""),
               "holder_id": str(row.get("holder_id") or ""),
               "currency": str(row.get("currency") or "")}
        label = f"{key['holder_type']}/{key['holder_id']}/{key['currency']}"
        outcome = await _repair_one(db, key, row, who)
        summary["details"].append({**key, **outcome})
        summary["replayed"] += outcome.get("replayed", 0)
        summary["already_applied"] += outcome.get("already_applied", 0)
        if outcome.get("ok"):
            summary["repaired"] += 1
        else:
            summary["failed"] += 1
            log.error("Replica repair of %s did not finish: %s", label, outcome.get("error"))
    return summary


async def _repair_one(db, key: dict, row: dict, actor: dict) -> dict:
    now = datetime.now(timezone.utc)
    #: Counted across the CAS passes of this run: an entry replayed in pass
    #: one and met again in pass two (because a concurrent failure made the
    #: row re-read) is one replay, not a replay and an "already applied".
    replayed = already = 0
    replayed_here: set[str] = set()
    for _attempt in range(_REPAIR_CAS_ATTEMPTS):
        pending = list(row.get("replica_pending") or [])
        done: list[dict] = []
        error: str | None = None
        for entry in pending:
            marker = str(entry.get("ledger_id") or entry.get("idempotency_key") or "")
            try:
                result = await asyncio.to_thread(
                    firebase.apply_replica_delta_once,
                    key["holder_type"], key["holder_id"], key["currency"],
                    int(entry.get("delta") or 0),
                    marker_id=marker,
                    balance_after=entry.get("balance_after"),
                    history=entry.get("history"),
                )
            except Exception as exc:  # noqa: BLE001 — this entry stays pending
                error = f"{type(exc).__name__}: {exc}"
                break
            if result.get("applied"):
                replayed += 1
                replayed_here.add(marker)
            elif marker not in replayed_here:
                already += 1
            done.append({**entry, "repaired_at": now,
                         "outcome": "replayed" if result.get("applied") or marker in replayed_here
                         else "already_applied"})

        remaining = pending[len(done):]
        update: dict = {
            "$set": {
                "replica_pending": remaining,
                "replica_stale": bool(remaining),
                "replica_repair_last_at": now,
                "replica_repair_last_error": error,
                "updated_at": now,
            },
        }
        if not remaining:
            update["$set"]["replica_stale_at"] = None
        res = await db[C.BALANCES].update_one(
            {**key, "replica_pending": row.get("replica_pending") or []}, update
        )
        if getattr(res, "matched_count", 1) != 1:
            # A sync failed (and pushed) while this row was being repaired.
            # Re-read and go again — the entries already replayed are keyed
            # on their ledger ids, so a second pass skips them.
            fresh = await db[C.BALANCES].find_one(key)
            if fresh is None:
                return {"ok": False, "error": "balance row vanished during repair"}
            row = fresh
            continue
        for entry in done:
            await db[C.BALANCES].update_one(key, {"$push": {"replica_repaired": entry}})

        if done:
            try:
                await audit.record(
                    actor=actor,
                    action=audit.Action.REPLICA_REPAIRED,
                    subject_type=key["holder_type"],
                    subject_id=key["holder_id"],
                    reason="Firestore replica brought back in step with the ledger.",
                    before={"pending": len(pending)},
                    after={"pending": len(remaining)},
                    meta={"currency": key["currency"], "replayed": replayed,
                          "already_applied": already,
                          "ledger_ids": [str(d.get("ledger_id") or "") for d in done]},
                )
            except Exception:  # noqa: BLE001
                log.exception("replica repair audit entry for %s could not be written", key)
        if error:
            try:
                await audit.record(
                    actor=actor,
                    action=audit.Action.REPLICA_REPAIR_FAILED,
                    subject_type=key["holder_type"],
                    subject_id=key["holder_id"],
                    reason=f"Firestore replica repair did not finish: {error}",
                    meta={"currency": key["currency"], "pending": len(remaining)},
                )
            except Exception:  # noqa: BLE001
                log.exception("replica repair failure audit entry for %s could not be written", key)
        return {"ok": not remaining, "replayed": replayed, "already_applied": already,
                "pending": len(remaining), "error": error}
    return {"ok": False, "error": "the pending list kept changing; try again"}
