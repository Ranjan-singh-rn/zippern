"""The money core.

Every balance movement in the business goes through `apply_movement`. There is
no other write path. Spec 1.2 of BUILD-PLAN.md, Part 5 and Part 6 of CRM-FLOW.md.

Guarantees:
  * balance change + ledger entry + audit entry commit together, or not at all
  * a reason is mandatory
  * an idempotency key can never be applied twice
  * a debit cannot take a balance below zero unless explicitly permitted
  * Mongo is authoritative; Firestore is synced afterwards as a read replica
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

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
    COMMISSION = "commission"  # agency commission balance, in minor units (paise)


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


async def apply_movement(m: Movement) -> MovementResult:
    """Apply one balance movement atomically.

    Raises InsufficientBalance or DuplicateMovement. On success the ledger and
    audit log are already committed before Firestore is touched.
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
        synced = firebase.sync_balance_to_firestore(
            str(m.holder_type), m.holder_id, str(m.currency), m.amount
        )

    return MovementResult(
        ledger_id=str(ledger_result.inserted_id),
        audit_id=audit_id,
        balance_before=before,
        balance_after=after,
        replica_synced=synced,
    )


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

    Used by the reconciliation job. A drift entry means Mongo is right and
    Firestore is stale — never the other way round.
    """
    cursor = get_db()[C.BALANCES].find({"replica_stale": True}).limit(limit)
    return [doc async for doc in cursor]
