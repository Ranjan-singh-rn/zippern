"""Partner records and their money.

Spec Part 0.2 / 0.4 and Part 4. This is the competitive proposition: an agency
or seller can see exactly what they earned, what they were paid and what is
outstanding, without asking anyone.

Everything here reads from the same ledger the business runs on, so what the
partner sees and what you see can never diverge.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.core.compat import StrEnum
from app.db.mongo import C, get_db
from app.services import commission
from app.services.money import Currency, HolderType, get_balance, ledger_for


class PartnerKind(StrEnum):
    AGENCY = "agency"
    SUB_AGENCY = "sub_agency"
    SELLER = "seller"


class PartnerStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    #: Temporary and operational. The business still exists, keeps its place
    #: in the one-agency-per-human rule, and `reactivate_partner` restores it
    #: exactly as it was. The CRM's "Deactivate" button writes this.
    SUSPENDED = "suspended"
    #: The role has been taken away. The record stays as history, nothing
    #: about its money or audit trail is touched, and it still counts for the
    #: combination rules and holds its role-family slot (C1): the person asks
    #: for it back with a reinstatement request, and only the Owner can restore
    #: it — as this same record. `partner_ops.revoke_partner` is the only
    #: writer. Distinct from suspending the person's account (moderation) and
    #: from deleting anything (never).
    REVOKED = "revoked"
    #: Decision 15 (RC). APPROVED by the Owner, but the role has NOT started:
    #: the login does not yet hold both a verified phone and a verified email
    #: (`services/contact_verification`). No privilege, no dashboard, no money
    #: path reads it as live — every check that requires `approved` refuses it
    #: by construction. `partner_ops.activate_partner_if_verified` moves it to
    #: APPROVED, audited, once both are verified. It holds its role-family slot
    #: like a pending application does.
    AWAITING_VERIFICATION = "awaiting_verification"


class CreditStanding(StrEnum):
    NONE = "none"          # no credit taken
    CURRENT = "current"    # borrowed, not yet due
    DUE_SOON = "due_soon"  # within 3 days of the due date
    OVERDUE = "overdue"    # past due — blocked from new inventory
    WRITTEN_OFF = "written_off"


@dataclass(slots=True)
class AgencyStatement:
    agency_id: str
    name: str
    commission_earned: int      # minor units (paise)
    commission_paid: int
    commission_outstanding: int
    host_count: int
    period_from: datetime | None
    period_to: datetime | None
    entries: list[dict]
    # How the commission for this period is derived: what the agency's hosts
    # cashed out, which band that selects, the rate, and each host's share. An
    # agency must be able to see where its number came from, not just what it
    # is (spec 0.1.5). Null only when the derivation itself could not be run,
    # in which case `commission_basis_error` says why.
    commission_basis: dict | None = None
    commission_basis_error: str | None = None
    commission_rule: str = ""


@dataclass(slots=True)
class SellerStatement:
    seller_id: str
    name: str
    coins_purchased: int
    coins_lent: int
    coins_sold: int
    coins_on_hand: int
    cash_paid_minor: int
    credit_outstanding: int
    credit_standing: CreditStanding
    credit_due_at: datetime | None
    entries: list[dict]


@dataclass(slots=True)
class SellerHistory:
    """Every movement involving one seller, in one time-ordered list.

    `SellerStatement` above is the coin ledger and nothing else, which is why
    neither the owner nor the seller could answer the two questions they each
    actually ask — *"how much business have I done with this person, in this
    period"* and *"what has happened on my account"*. Coins are only half of it:
    a purchase is rupees against a UTR, a sale is rupees taken from a named
    buyer, and a **repayment moves no coins at all** and so appears in that
    ledger nowhere.
    """

    seller_id: str
    name: str
    period_from: datetime | None
    period_to: datetime | None
    rows: list[dict]
    totals: dict
    #: What was read to build this, and whether each source hit its cap. A row
    #: missing because a limit truncated it must never look like a row that
    #: never existed.
    sources: dict
    truncated: bool
    note: str


# ── Agencies ──────────────────────────────────────────────────────────────────


async def agency_statement(
    agency_id: str,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 200,
) -> AgencyStatement:
    """Everything an agency is owed and has been paid. Spec 0.2.2 / 0.2.3."""
    db = get_db()
    partner = await db[C.PARTNERS].find_one({"_id": agency_id}) or {}

    outstanding = await get_balance(
        HolderType.AGENCY, agency_id, Currency.COMMISSION
    )

    entries = await ledger_for(
        HolderType.AGENCY, agency_id, Currency.COMMISSION, limit=limit
    )
    if since or until:
        entries = [
            e
            for e in entries
            if (not since or e["at"] >= since) and (not until or e["at"] <= until)
        ]

    earned = sum(e["amount"] for e in entries if e["amount"] > 0)
    paid = -sum(e["amount"] for e in entries if e["amount"] < 0)

    host_count = await db["agency_hosts"].count_documents(
        {"agency_id": agency_id, "active": True}
    )

    basis, basis_error = await _commission_basis(agency_id, partner, since, until)

    return AgencyStatement(
        agency_id=agency_id,
        name=partner.get("name", ""),
        commission_earned=earned,
        commission_paid=paid,
        commission_outstanding=outstanding,
        host_count=host_count,
        period_from=since,
        period_to=until,
        entries=entries,
        commission_basis=basis,
        commission_basis_error=basis_error,
        commission_rule=commission.RULE,
    )


async def _commission_basis(
    agency_id: str,
    partner: dict,
    since: datetime | None,
    until: datetime | None,
) -> tuple[dict | None, str | None]:
    """Derive this period's commission so the statement can explain it.

    Read-only: it credits nothing. It runs the same engine the accrual runs, so
    what the agency is shown and what it is paid cannot drift apart.

    With no window given the statement covers everything, and "everything" is
    not a commission period — so the current ISO week is used and named in the
    result rather than banding a lifetime total, which would pick a top band
    that no single period ever earned.
    """
    if not partner:
        return None, "No partner record, so no commission basis is derived."

    if since is not None and until is not None:
        period, window = "custom", (since, until)
    else:
        now = datetime.now(timezone.utc)
        iso = now.isocalendar()
        period, window = f"{iso[0]}-W{iso[1]:02d}", (None, None)

    try:
        return (
            await commission.compute_for_period(
                agency_id, period, window[0], window[1], partner
            ),
            None,
        )
    except commission.CommissionError as exc:
        # Refused, and said so. Never a silent zero dressed as a real figure.
        return None, str(exc)


async def agency_host_performance(
    agency_id: str, since: datetime | None = None, limit: int = 200
) -> list[dict]:
    """Per-host earnings for an agency. Spec 0.2.4.

    Aggregated from the ledger, so it always reconciles with what was paid.
    """
    match: dict = {
        "holder_type": str(HolderType.USER),
        "currency": str(Currency.BEANS),
        "amount": {"$gt": 0},
        "meta.agency_id": agency_id,
    }
    if since:
        match["at"] = {"$gte": since}

    pipeline = [
        {"$match": match},
        {
            "$group": {
                "_id": "$holder_id",
                "beans_earned": {"$sum": "$amount"},
                "movements": {"$sum": 1},
                "last_earned_at": {"$max": "$at"},
            }
        },
        {"$sort": {"beans_earned": -1}},
        {"$limit": min(limit, 500)},
    ]

    out = []
    async for row in get_db()[C.LEDGER].aggregate(pipeline):
        out.append(
            {
                "host_id": row["_id"],
                "beans_earned": row["beans_earned"],
                "movements": row["movements"],
                "last_earned_at": row["last_earned_at"],
            }
        )
    return out


async def sub_agencies_of(agency_id: str) -> list[dict]:
    """A parent's sub-agencies, with what the parent owes each. Spec 4.2.9."""
    cursor = get_db()[C.PARTNERS].find(
        {"kind": str(PartnerKind.SUB_AGENCY), "parent_id": agency_id}
    )
    out = []
    async for doc in cursor:
        sub_id = str(doc["_id"])
        out.append(
            {
                "id": sub_id,
                "name": doc.get("name", ""),
                "status": doc.get("status"),
                "owed_by_parent": await get_balance(
                    HolderType.AGENCY, sub_id, Currency.COMMISSION
                ),
            }
        )
    return out


# ── Sellers ───────────────────────────────────────────────────────────────────


async def seller_statement(seller_id: str, limit: int = 200) -> SellerStatement:
    """One reconciled view: bought, lent, sold, paid, outstanding. Spec 0.4.2.

    Replaces having to read four collections and do the arithmetic by hand.
    """
    db = get_db()
    partner = await db[C.PARTNERS].find_one({"_id": seller_id}) or {}

    on_hand = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    entries = await ledger_for(
        HolderType.SELLER, seller_id, Currency.COINS, limit=limit
    )

    purchased = sum(
        e["amount"]
        for e in entries
        if e["amount"] > 0 and e["action"].startswith("inventory")
    )
    lent = sum(
        e["amount"] for e in entries if e["amount"] > 0 and e["action"].startswith("lending")
    )
    sold = -sum(e["amount"] for e in entries if e["amount"] < 0)

    credit = partner.get("credit", {}) or {}
    outstanding = int(credit.get("outstanding", 0))
    due_at = credit.get("due_at")

    return SellerStatement(
        seller_id=seller_id,
        name=partner.get("name", ""),
        coins_purchased=purchased,
        coins_lent=lent,
        coins_sold=sold,
        coins_on_hand=on_hand,
        cash_paid_minor=int(partner.get("cash_paid_minor", 0)),
        credit_outstanding=outstanding,
        credit_standing=credit_standing(outstanding, due_at),
        credit_due_at=due_at,
        entries=entries,
    )


# ── One seller's whole record ─────────────────────────────────────────────────
#
# WHY THIS EXISTS AS A SEPARATE READ.
#
# `seller_statement` above answers "what is the coin position". It is the coin
# ledger, capped, coins-only, with no window — and four facts fall straight
# through it:
#
#   * **Rupees.** A purchase card carries `amount_paid_minor` and a UTR; the
#     ledger row carries the coins. `cash_paid_minor` on the partner record is
#     one lifetime `$inc` and cannot be scoped to a period, so "how much
#     business did I do with him in July" had no source anywhere.
#   * **Repayments.** `execute_repayment` writes **no ledger movement** — the
#     debt is denominated in coins that were issued and already sold, so what
#     closes is a number on the partner record (services/partner_ops.py). A
#     repayment therefore appears in the coin statement never, at any limit.
#     It is read here from the card and from `credit.history`.
#   * **Sales.** `partner_sales` holds the buyer and what the seller took for
#     the coins. The ledger sees only an unattributed inventory debit.
#   * **Anything not yet executed.** A card signed and not executed has moved
#     nothing, and both sides need to see it as exactly that rather than as
#     absent.
#
# The four sources are joined on `card_id`, which is the only identifier all of
# them share. A card is the canonical row wherever one exists, because a card is
# the thing a person decided; the ledger movement underneath it supplies what
# **actually** moved, which is not always what was asked for — a recovery takes
# up to the balance and no more (4.3.16).

#: Card types raised about a seller that belong on their history. Deliberately
#: the same set as `cards.PARTNER_SUBJECT_CARD_TYPES` minus the two agency ones:
#: a seller record never carries commission, so listing those types would only
#: ever produce an empty query.
SELLER_HISTORY_CARD_TYPES: frozenset[str] = frozenset(
    {
        "seller_coin_purchase",
        "lending_issue",
        "lending_repay",
        "lending_recover",
        "lending_write_off",
        "bad_debt_write_off",
    }
)

#: What each row is, in the words both audiences use for it. The seller's side
#: and the owner's side of the same movement are the same movement, so there is
#: one label rather than two that could drift apart.
_HISTORY_LABEL: dict[str, str] = {
    "coin_purchase": "Coins bought",
    "lending_issue": "Inventory lent on credit",
    "repayment": "Repayment of credit",
    "recovery": "Credit recovered from stock",
    "write_off": "Debt written off",
    "sale": "Coins sold to a buyer",
    "movement": "Ledger movement",
}

#: Ledger actions, for the movements that carry no card and no sale — an opening
#: load, a correction. Rare, and never silently dropped.
_ACTION_LABEL: dict[str, str] = {
    "inventory.credit": "Coins credited",
    "inventory.debit": "Coins debited",
    "lending.issue": "Credit issued",
    "lending.recover": "Credit recovered",
    "lending.write_off": "Debt written off",
}

#: The counterparty on everything that is not a sale. A purchase, a lending, a
#: repayment and a recovery are all between the seller and the business; only a
#: sale has a third party, and only a sale names one.
_ZIPPER = "Zipper"


def _utc(value: object) -> datetime | None:
    """A stored timestamp as an aware UTC datetime, or None.

    Mongo is opened `tz_aware=True`, so its datetimes arrive aware — but a
    `since`/`until` typed into a URL need not be, and one naive value in the
    list makes the whole sort raise. Everything is normalised on the way in so
    the comparison below can be a plain one.
    """
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _minor(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _row(
    at: datetime | None,
    kind: str,
    *,
    coins: int = 0,
    owed_delta: int = 0,
    amount_minor: int = 0,
    money: str = "none",
    reference: str = "",
    proof_url: str = "",
    counterparty: str = _ZIPPER,
    card_id: str | None = None,
    card_stage: str | None = None,
    settled: bool = False,
    reason: str = "",
    source: str = "card",
    extra: dict | None = None,
) -> dict:
    """One line of the history.

    `coins` is signed against the seller's **stock** and `owed_delta` is signed
    against what they **owe** — two different quantities that a single "amount"
    column would have to choose between. A repayment is the case that proves it:
    coins 0, owed_delta negative, rupees real.

    `settled` is the difference between a decision and a movement. A card that
    is signed and not executed has changed nothing, and a screen that renders it
    the same as an executed one is telling both sides the money has moved.
    """
    return {
        "at": at,
        "kind": kind,
        "what": _HISTORY_LABEL.get(kind, kind.replace("_", " ")),
        "coins": coins,
        "owed_delta": owed_delta,
        # Always paise, always non-negative. `money` says which way it went, so
        # nothing has to infer a direction from a sign.
        "amount_minor": amount_minor,
        "money": money,
        "reference": reference,
        "proof_url": proof_url,
        "counterparty": counterparty,
        "card_id": card_id,
        "card_stage": card_stage,
        "settled": settled,
        "reason": reason,
        "source": source,
        **(extra or {}),
    }


async def seller_history(
    seller_id: str,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 500,
) -> SellerHistory:
    """Every movement involving this seller, in one time-ordered list.

    Answers both halves of the same question with one read, so the owner's
    figure and the seller's figure cannot disagree: *what has this person done
    with me, and how much business is that*.
    """
    db = get_db()
    partner = await db[C.PARTNERS].find_one({"_id": seller_id}) or {}

    since = _utc(since)
    until = _utc(until)
    cap = max(1, min(limit, 1000))
    # Each source is read wider than the answer, because filtering to the window
    # happens after the four are joined — a card raised in June and executed in
    # July belongs to July, and only the join knows that.
    fetch = min(cap * 2, 1000)

    # ── 1. The coin ledger ───────────────────────────────────────────────────
    entries = await ledger_for(
        HolderType.SELLER, seller_id, Currency.COINS, limit=fetch
    )
    by_card: dict[str, list[dict]] = {}
    loose: list[dict] = []
    for entry in entries:
        card_id = str(entry.get("card_id") or "")
        if card_id:
            by_card.setdefault(card_id, []).append(entry)
        else:
            loose.append(entry)

    # ── 2. The cards raised about them ───────────────────────────────────────
    card_cursor = (
        db[C.CARDS]
        .find(
            {
                "subject.id": seller_id,
                "subject.type": str(HolderType.SELLER),
                "type": {"$in": sorted(SELLER_HISTORY_CARD_TYPES)},
            }
        )
        .sort("created_at", -1)
        .limit(fetch)
    )
    cards = [doc async for doc in card_cursor]

    # ── 3. The credit history on the record itself ───────────────────────────
    # This is where a repayment's *applied* figure lives — `execute_repayment`
    # writes no ledger row, so without this the amount on the card is a request
    # and nothing anywhere says what was actually taken off the debt.
    credit = partner.get("credit", {}) or {}
    events = [e for e in (credit.get("history") or []) if isinstance(e, dict)]
    credit_by_card: dict[str, dict] = {}
    for event in events:
        cid = str(event.get("card_id") or "")
        if cid:
            credit_by_card[cid] = event

    # ── 4. The sales they filed ──────────────────────────────────────────────
    sale_cursor = (
        db[C.SALES]
        .find({"seller_id": seller_id})
        .sort("created_at", -1)
        .limit(fetch)
    )
    sales = [doc async for doc in sale_cursor]

    rows: list[dict] = []
    seen_cards: set[str] = set()

    for card in cards:
        row = _card_row(card, by_card, credit_by_card)
        if row is not None:
            seen_cards.add(str(card.get("_id") or ""))
            rows.append(row)

    # A credit event whose card fell outside the card window still happened, and
    # a repayment is the one movement that has no other trace at all. Emitted
    # from the record so the seller's own repayments can never go missing.
    for event in events:
        cid = str(event.get("card_id") or "")
        if cid and cid in seen_cards:
            continue
        row = _credit_event_row(event)
        if row is not None:
            rows.append(row)

    for sale in sales:
        rows.append(_sale_row(sale))

    # Ledger movements attached to no card. A sale's inventory debit carries the
    # sale id in `meta` rather than a card id and is already covered by the sale
    # row above, so it is skipped rather than double-counted.
    for entry in loose:
        if str((entry.get("meta") or {}).get("sale_id") or ""):
            continue
        rows.append(_ledger_row(entry))

    # A movement whose card fell outside the card window. The card row would
    # have carried this movement's coins; without one the coins would simply
    # vanish from the list, which is the failure this whole read exists to fix.
    # Emitted as the bare movement it is — the debt half of the same event, if
    # there is one, came through `credit.history` above carrying zero coins, so
    # nothing is counted twice.
    for card_id, movements in by_card.items():
        if card_id in seen_cards:
            continue
        for entry in movements:
            rows.append(_ledger_row(entry))

    # ── The window, applied once, to the joined list ─────────────────────────
    def within(row: dict) -> bool:
        at = row.get("at")
        if not isinstance(at, datetime):
            # Undated is not "outside the window" — it is a row whose date we do
            # not have, and dropping it would silently shrink a total. Kept, and
            # the screens render the missing date as missing.
            return since is None and until is None
        if since is not None and at < since:
            return False
        if until is not None and at > until:
            return False
        return True

    rows = [r for r in rows if within(r)]
    rows.sort(key=lambda r: _utc(r.get("at")) or datetime.min.replace(
        tzinfo=timezone.utc
    ), reverse=True)

    truncated = len(rows) > cap
    rows = rows[:cap]

    return SellerHistory(
        seller_id=seller_id,
        name=partner.get("name", ""),
        period_from=since,
        period_to=until,
        rows=rows,
        totals=_history_totals(rows),
        sources={
            "ledger_entries": len(entries),
            "cards": len(cards),
            "credit_events": len(events),
            "sales": len(sales),
            "fetch_limit": fetch,
            "ledger_capped": len(entries) >= fetch,
            "cards_capped": len(cards) >= fetch,
            "sales_capped": len(sales) >= fetch,
        },
        truncated=truncated,
        note=(
            "Coin purchases, lending, repayments, recoveries, write-offs and "
            "sales in one list. A repayment moves no coins, so it carries a "
            "zero in the coin column and a real figure against the debt — it is "
            "read from the card and the credit history, not from the ledger, "
            "because the ledger never sees one. Rupee amounts are paise; divide "
            "by 100 exactly once. A row that is not settled has moved nothing."
        ),
    )


def _card_row(
    card: dict,
    by_card: dict[str, list[dict]],
    credit_by_card: dict[str, dict],
) -> dict | None:
    """One card as a history row, with what actually moved underneath it.

    The card says what was decided and the ledger says what happened, and they
    are not always the same number: a recovery takes up to the balance and
    leaves the shortfall outstanding (4.3.16), and a repayment is capped at the
    outstanding debt. Where a movement exists it wins; where none does the card
    is reported as the unsettled request it is.
    """
    card_id = str(card.get("_id") or "")
    kind_of = {
        "seller_coin_purchase": "coin_purchase",
        "lending_issue": "lending_issue",
        "lending_repay": "repayment",
        "lending_recover": "recovery",
        "lending_write_off": "write_off",
        "bad_debt_write_off": "write_off",
    }
    kind = kind_of.get(str(card.get("type") or ""))
    if kind is None:
        return None

    payload = card.get("payload") or {}
    stage = str(card.get("stage") or "")
    executed = stage == "executed"
    movements = by_card.get(card_id) or []
    event = credit_by_card.get(card_id) or {}

    # `executed_at` is when the money moved; `created_at` is when somebody asked
    # for it. An unexecuted card is dated by the ask, which is the only date it
    # has, and `settled` says which of the two this is.
    at = _utc(card.get("executed_at")) or _utc(card.get("created_at"))

    coins = sum(int(m.get("amount", 0)) for m in movements)
    requested = int(card.get("amount", 0))
    result = card.get("execution_result") or {}

    reference = str(payload.get("payment_ref") or "")
    proof = str(payload.get("evidence_url") or "")
    if not proof:
        for item in card.get("evidence") or []:
            if isinstance(item, dict) and item.get("url"):
                proof = str(item["url"])
                break

    owed_delta = 0
    amount_minor = 0
    money = "none"

    if kind == "coin_purchase":
        # The rupees are the whole point of this row and they live on the card,
        # never in the coin ledger.
        amount_minor = _minor(payload.get("amount_paid_minor"))
        money = "seller_paid_zipper" if amount_minor else "none"
    elif kind == "lending_issue":
        owed_delta = coins if executed else 0
    elif kind == "repayment":
        # No coin movement exists, ever. The applied figure comes from the
        # execution result, then the credit-history event, then the card.
        applied = _minor(result.get("coins_repaid")) or _minor(event.get("coins"))
        owed_delta = -(applied or requested) if executed else 0
        at = _utc(event.get("at")) or at
    elif kind == "recovery":
        recovered = _minor(result.get("recovered"))
        penalty = _minor(payload.get("penalty_coins"))
        owed_delta = (penalty - recovered) if executed else 0
    elif kind == "write_off":
        written = _minor(result.get("written_off")) or _minor(event.get("coins"))
        owed_delta = -(written or requested) if executed else 0

    return _row(
        at,
        kind,
        coins=coins,
        owed_delta=owed_delta,
        amount_minor=amount_minor,
        money=money,
        reference=reference,
        proof_url=proof,
        card_id=card_id,
        card_stage=stage,
        settled=executed,
        reason=str(card.get("reason") or ""),
        source="card",
        extra={
            "requested_coins": requested,
            "due_at": _utc(payload.get("due_at")),
            "penalty_coins": _minor(payload.get("penalty_coins")),
            "title": str(card.get("title") or ""),
        },
    )


def _credit_event_row(event: dict) -> dict | None:
    """A `credit.history` entry with no card in the window above it.

    Only reachable when the card list was truncated or the card was removed, and
    kept for exactly that case: a repayment has no ledger row, so this is its
    last remaining trace and losing it would tell a seller they never repaid.
    """
    kind = {
        "issued": "lending_issue",
        "repaid": "repayment",
        "recovered": "recovery",
        "written_off": "write_off",
    }.get(str(event.get("event") or ""))
    if kind is None:
        return None

    coins = _minor(event.get("coins"))
    owed = {
        "lending_issue": coins,
        "repayment": -coins,
        "recovery": _minor(event.get("penalty_coins")) - coins,
        "write_off": -coins,
    }[kind]

    return _row(
        _utc(event.get("at")),
        kind,
        # The stock movement, where there was one, is already in the ledger and
        # this row is not it — reporting coins here as well would double them.
        coins=0,
        owed_delta=owed,
        card_id=str(event.get("card_id") or "") or None,
        card_stage="executed",
        settled=True,
        reason="Recorded against the credit on this seller's record.",
        source="credit_history",
        extra={"requested_coins": coins, "due_at": _utc(event.get("due_at"))},
    )


def _sale_row(sale: dict) -> dict:
    """A sale the seller filed — the only row with a real counterparty.

    Coins leave the seller only when an owner approves it (4.3.9), so a pending
    sale carries zero coins and says so through `settled`. The rupees are what
    the seller took from the buyer, which is money that never touches us and is
    the other half of "how much business has this person done".
    """
    approved = str(sale.get("status") or "") == "approved"
    diamonds = _minor(sale.get("diamonds"))
    at = _utc(sale.get("approved_at")) or _utc(sale.get("created_at"))

    return _row(
        at,
        "sale",
        coins=-diamonds if approved else 0,
        amount_minor=_minor(sale.get("amount_paid_minor")),
        money="buyer_paid_seller",
        counterparty=str(sale.get("buyer_uid") or ""),
        card_stage=str(sale.get("status") or ""),
        settled=approved,
        reason=str(sale.get("reason") or ""),
        source="sale",
        extra={"requested_coins": diamonds, "sale_id": str(sale.get("_id") or "")},
    )


#: A bare ledger movement classified by the action `money.apply_movement` wrote.
#: Only reached when the card above a movement is not in the window, and the
#: kind matters even then: filing a lending under "bought" would put borrowed
#: coins into the purchase total, which is the one figure an owner reconciles
#: against their bank.
_ACTION_KIND: dict[str, str] = {
    "inventory.credit": "coin_purchase",
    "lending.issue": "lending_issue",
    "lending.recover": "recovery",
    "lending.write_off": "write_off",
}


def _ledger_row(entry: dict) -> dict:
    """A coin movement with no card and no sale row above it.

    An opening load, a correction, or a movement whose card fell outside the
    window. Listed rather than dropped: this history is only worth trusting if
    it is everything. It carries no rupees and no reference, because a bare
    ledger row genuinely has neither — an empty field here is the truth about
    the movement, not a read that failed.
    """
    action = str(entry.get("action") or "")
    row = _row(
        _utc(entry.get("at")),
        _ACTION_KIND.get(action, "movement"),
        coins=int(entry.get("amount", 0)),
        card_id=str(entry.get("card_id") or "") or None,
        settled=True,
        reason=str(entry.get("reason") or ""),
        source="ledger",
        extra={
            "action": action,
            "balance_after": entry.get("balance_after"),
            "ledger_id": str(entry.get("id") or ""),
        },
    )
    row["what"] = _ACTION_LABEL.get(action, action.replace(".", " ").replace("_", " "))
    return row


def _history_totals(rows: list[dict]) -> dict:
    """"How much business have I done with him in this period", added up.

    Every figure is summed from the rows above rather than from a lifetime
    counter on the partner record, which is why it can be scoped to a window at
    all — `cash_paid_minor` is a single `$inc` since the account opened and can
    answer no question about July.

    **Unsettled rows are excluded from every total and counted separately.** A
    signed-but-unexecuted purchase has moved no coins and paid no rupees; adding
    it in would report business that has not happened.

    A rejected or failed row is a third thing again, and is counted as neither.
    It is not business done and it is not business in flight — putting it in the
    pending count would have somebody chasing a card that was refused weeks ago.
    """
    totals = {
        "coins_bought": 0,
        "rupees_paid_minor": 0,
        "coins_sold": 0,
        "rupees_taken_minor": 0,
        "coins_lent": 0,
        "coins_repaid": 0,
        "coins_recovered": 0,
        "coins_written_off": 0,
        "movements": len(rows),
        "settled_movements": 0,
        "pending_movements": 0,
        "pending_coins": 0,
        "pending_rupees_minor": 0,
        "refused_movements": 0,
    }

    for row in rows:
        kind = row.get("kind")
        coins = int(row.get("coins") or 0)
        owed = int(row.get("owed_delta") or 0)
        minor = int(row.get("amount_minor") or 0)

        if not row.get("settled"):
            if str(row.get("card_stage") or "") in ("rejected", "failed"):
                totals["refused_movements"] += 1
                continue
            totals["pending_movements"] += 1
            totals["pending_coins"] += int(row.get("requested_coins") or 0)
            totals["pending_rupees_minor"] += minor
            continue

        totals["settled_movements"] += 1
        if kind == "coin_purchase":
            totals["coins_bought"] += coins
            totals["rupees_paid_minor"] += minor
        elif kind == "sale":
            totals["coins_sold"] += -coins
            totals["rupees_taken_minor"] += minor
        elif kind == "lending_issue":
            totals["coins_lent"] += coins or owed
        elif kind == "repayment":
            totals["coins_repaid"] += -owed
        elif kind == "recovery":
            totals["coins_recovered"] += -coins
        elif kind == "write_off":
            totals["coins_written_off"] += -owed
        elif kind == "movement":
            # A correction still changed the stock, so it belongs in whichever
            # direction it went rather than in a category it is not.
            if coins > 0:
                totals["coins_bought"] += coins
            else:
                totals["coins_sold"] += -coins

    return totals


def credit_standing(outstanding: int, due_at: datetime | None) -> CreditStanding:
    """Spec 4.3.11 / 4.3.12 — overdue credit blocks new inventory."""
    if outstanding <= 0:
        return CreditStanding.NONE
    if due_at is None:
        return CreditStanding.CURRENT

    now = datetime.now(timezone.utc)
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)

    if now > due_at:
        return CreditStanding.OVERDUE
    if now > due_at - timedelta(days=3):
        return CreditStanding.DUE_SOON
    return CreditStanding.CURRENT


async def can_take_inventory(seller_id: str) -> tuple[bool, str]:
    """Whether a seller may buy or borrow more. Spec 4.3.12."""
    partner = await get_db()[C.PARTNERS].find_one({"_id": seller_id})
    if partner is None:
        return False, "Seller not found."
    if partner.get("status") != str(PartnerStatus.APPROVED):
        return False, "Seller account is not approved."

    credit = partner.get("credit", {}) or {}
    standing = credit_standing(
        int(credit.get("outstanding", 0)), credit.get("due_at")
    )
    if standing is CreditStanding.OVERDUE:
        return False, (
            "Outstanding credit is overdue. Clear it before taking new inventory."
        )
    return True, ""


# ── Exposure across all partners ──────────────────────────────────────────────


async def total_credit_exposure() -> dict:
    """How much credit is out across every seller — a number nobody can
    currently answer. Spec 8B.4.2 in spirit, and the seller half of 0.4."""
    pipeline = [
        {"$match": {"kind": str(PartnerKind.SELLER)}},
        {
            "$group": {
                "_id": None,
                "total_outstanding": {"$sum": "$credit.outstanding"},
                "sellers_with_credit": {
                    "$sum": {"$cond": [{"$gt": ["$credit.outstanding", 0]}, 1, 0]}
                },
                "total_sellers": {"$sum": 1},
            }
        },
    ]
    async for row in get_db()[C.PARTNERS].aggregate(pipeline):
        row.pop("_id", None)
        return row
    return {"total_outstanding": 0, "sellers_with_credit": 0, "total_sellers": 0}


async def overdue_sellers(limit: int = 100) -> list[dict]:
    """Sellers past their due date — the recovery worklist."""
    now = datetime.now(timezone.utc)
    cursor = (
        get_db()[C.PARTNERS]
        .find(
            {
                "kind": str(PartnerKind.SELLER),
                "credit.outstanding": {"$gt": 0},
                "credit.due_at": {"$lt": now},
            }
        )
        .limit(limit)
    )
    out = []
    async for doc in cursor:
        credit = doc.get("credit", {})
        out.append(
            {
                "id": str(doc["_id"]),
                "name": doc.get("name", ""),
                "outstanding": credit.get("outstanding", 0),
                "due_at": credit.get("due_at"),
                "days_overdue": (now - credit["due_at"]).days
                if credit.get("due_at")
                else None,
            }
        )
    return out
