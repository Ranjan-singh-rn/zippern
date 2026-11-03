"""The coin-seller business, completed (B9, 3 Nov 2026).

What already existed and is reused, not re-invented: seller inventory is `coins` on the money core
(`money.apply_movement`, deterministic idempotency keys, never negative); Zipper → seller purchases and staff-raised
lending are owner-signed cards (`partner_ops`); seller → user sales are staff-verified recharges and sales.

What this module adds — every movement through `apply_movement`, every decision audited:

  * **Tiers.** `appConfig/economy.sellerTiers` = {tierId: {name, wholesalePriceInr}} (₹ per lakh). A seller's
    `tier` (Mongo `partners.tier`, mirrored to `sellers/{id}.tier`) decides the wholesale price their purchase is
    checked against; no tier, or a tier no longer priced, is the published wholesale price. A tier price above
    retail is a typo, not a price, and is ignored. Normal users' diamond price is untouched (`diamondPackPriceInr`).
  * **Seller-to-seller trades.** A seller buys coins from another seller: the buyer files (amount paid, payment
    reference), staff verify and an owner approves — the selling seller's coins move to the buyer under
    `strade:{id}:debit` / `strade:{id}:credit`. Refused: a seller trading with themselves; a circular trade (back to
    the seller you bought from inside seven days, or while a trade the other way is pending); a reused payment
    reference; a buyer whose credit is overdue. A selling seller short of coins leaves it pending with the shortfall.
  * **Borrowing.** A credit limit per seller (`partners.credit.limit`, set by the Owner). A seller may ask to borrow
    within it; the request is a lending card like a staff-raised one (owner-signed). With a limit set, nobody — staff
    included — lends past it. A new loan never pushes back the due date of money already owed.
  * **Self-use.** Where the Owner allows it (`appConfig/economy.sellerSelfUseAllowed`), a seller moves coins into
    their own app wallet as diamonds — recorded as self-use, never as a sale, so it earns nothing and inflates no
    sales figure. Off by default.
  * **Profit.** What the seller paid for inventory, what they sold it for, and the margin — from the ledger and the
    sale records, with the definitions stated.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from pymongo import ReturnDocument

from app.core import audit
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import partners as partner_svc
from app.services.money import (
    Currency,
    DuplicateMovement,
    HolderType,
    InsufficientBalance,
    Movement,
    apply_movement,
    get_balance,
)
from app.services.partner_ops import (
    PartnerOpsError,
    _approved_partner,
    _now,
    _partner,
    _positive,
    _non_negative,
    _public,
    _require_reason,
    _sync_partner_doc,
    _who,
    request_lending,
)
from app.services.partners import PartnerKind

log = logging.getLogger(__name__)

TRADES = "seller_trades"
FS_TRADES = "sellerTrades"
CIRCULAR_WINDOW = timedelta(days=7)
MAX_BORROW_DAYS = 30
CLIENT_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")
DIAMONDS_PER_LAKH = 100_000


async def _fs(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


# ══════════════════════════════════════════════════════════════════════════════
#  Tiers
# ══════════════════════════════════════════════════════════════════════════════


# The tier parser lives with the rates it is read with (reports.load_rates); re-exported here.
from app.services.reports import parse_seller_tiers  # noqa: E402,F401


def tier_price_per_lakh(rates: Any, partner: Mapping | None) -> float | None:
    """The wholesale price for this seller's tier, or None (then the published wholesale price applies)."""
    tier = str((partner or {}).get("tier") or "")
    tiers = getattr(rates, "seller_tiers", None) or {}
    spec = tiers.get(tier) if tier else None
    return float(spec["price_per_lakh"]) if spec else None


async def set_seller_tier(seller_id: str, tier: str, reason: str, actor: dict) -> dict:
    """Put a seller on a tier ('' = none). Only a tier that has a price can be given."""
    from app.services import reports

    reason = _require_reason(reason)
    partner = await _partner(seller_id, PartnerKind.SELLER)
    tier = (tier or "").strip()
    rates = await reports.load_rates()
    tiers = getattr(rates, "seller_tiers", None) or {}
    if tier and tier not in tiers:
        raise PartnerOpsError(
            f"There is no priced tier '{tier}'. Tiers are set in the economy settings: "
            f"{', '.join(sorted(tiers)) or 'none yet'}."
        )
    before = str(partner.get("tier") or "")
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": seller_id},
        {"$set": {"tier": tier, "updated_at": _now()},
         "$push": {"tier_history": {"at": _now(), "from": before, "to": tier, "by": _who(actor), "reason": reason}}},
        return_document=ReturnDocument.AFTER,
    )
    await audit.record(
        actor=actor, action="seller.tier_set", subject_type="partner", subject_id=seller_id, reason=reason,
        before={"tier": before}, after={"tier": tier},
    )
    synced = _sync_partner_doc(updated or partner, {"tier": tier, "tierName": (tiers.get(tier) or {}).get("name", "")})
    return {"seller_id": seller_id, "tier": tier, "tier_name": (tiers.get(tier) or {}).get("name", ""), "replica_synced": synced}


# ══════════════════════════════════════════════════════════════════════════════
#  Credit limit and borrow requests
# ══════════════════════════════════════════════════════════════════════════════


async def set_credit_limit(seller_id: str, coins: int, reason: str, actor: dict) -> dict:
    """The most this seller may owe at once, in coins. 0 = no borrowing by request (staff lending unchanged)."""
    reason = _require_reason(reason)
    coins = _non_negative(coins, "Credit limit")
    partner = await _partner(seller_id, PartnerKind.SELLER)
    before = int(((partner.get("credit") or {}).get("limit")) or 0)
    await get_db()[C.PARTNERS].update_one(
        {"_id": seller_id}, {"$set": {"credit.limit": coins, "updated_at": _now()}},
    )
    await audit.record(
        actor=actor, action="seller.credit_limit_set", subject_type="partner", subject_id=seller_id, reason=reason,
        before={"limit": before}, after={"limit": coins},
    )
    return {"seller_id": seller_id, "credit_limit": coins}


def borrowing_headroom(partner: Mapping) -> tuple[int, int, int]:
    """(limit, outstanding, headroom) — headroom is what may still be borrowed (0 with no limit)."""
    credit = partner.get("credit") or {}
    limit = int(credit.get("limit") or 0)
    outstanding = int(credit.get("outstanding") or 0)
    return limit, outstanding, max(0, limit - outstanding) if limit > 0 else 0


async def request_borrow(seller_id: str, coins: int, days: int, reason: str, actor: dict) -> dict:
    """A seller asks to borrow inventory. Within their limit, not overdue; an owner still signs it."""
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= MAX_BORROW_DAYS:
        raise PartnerOpsError(f"Choose a repayment date 1 to {MAX_BORROW_DAYS} days away.")
    partner = await _approved_partner(seller_id, PartnerKind.SELLER)
    limit, outstanding, headroom = borrowing_headroom(partner)
    if limit <= 0:
        raise PartnerOpsError("Borrowing is not open for this seller. Zipper sets a credit limit first.")
    if coins > headroom:
        raise PartnerOpsError(
            f"That would take what you owe to {outstanding + coins:,} coins; your limit is {limit:,}. "
            f"You can borrow up to {headroom:,} now."
        )
    due_at = _now() + timedelta(days=days)
    card = await request_lending(seller_id, coins, due_at, "Requested by the seller", reason, actor)
    card["requested_by_seller"] = True
    return card


# ══════════════════════════════════════════════════════════════════════════════
#  Seller-to-seller trades
# ══════════════════════════════════════════════════════════════════════════════


class TradeStatus:
    PENDING = "pending"
    APPROVING = "approving"
    APPROVED = "approved"
    REJECTED = "rejected"


def _trade_mirror(trade: Mapping, extra: Mapping | None = None) -> bool:
    try:
        firebase.firestore_client().collection(FS_TRADES).document(str(trade["_id"])).set({
            "buyerSellerId": trade.get("buyer_id"), "sellerSellerId": trade.get("seller_id"),
            "coins": int(trade.get("coins") or 0), "amountPaidMinor": int(trade.get("amount_paid_minor") or 0),
            "status": trade.get("status"), "createdAt": trade.get("created_at"), "updatedAt": _now(),
            **(dict(extra) if extra else {}),
        }, merge=True)
        return True
    except Exception:  # noqa: BLE001 — Mongo is authoritative; the mirror is for the app
        log.warning("seller trade mirror failed for %s", trade.get("_id"))
        return False


async def request_trade(
    buyer_id: str, seller_id: str, coins: int, amount_paid_minor: int, payment_ref: str,
    client_request_id: str, actor: dict,
) -> dict:
    """The buyer seller files: "I paid this seller for these coins." Nothing moves until approved."""
    coins = _positive(coins, "Coins")
    amount_paid_minor = _non_negative(amount_paid_minor, "Amount paid")
    ref = (payment_ref or "").strip()
    if not ref:
        raise PartnerOpsError("A payment reference (UTR, transaction id) is required to match the money.")
    if buyer_id == seller_id:
        raise PartnerOpsError("A seller cannot buy from their own stock.")
    crid = (client_request_id or "").strip()
    if not CLIENT_REQUEST_ID.fullmatch(crid):
        raise PartnerOpsError("This request could not be read. Update the app and try again.")
    db = get_db()
    earlier = await db[TRADES].find_one({"buyer_id": buyer_id, "client_request_id": crid})
    if earlier:
        out = _public(earlier)
        out["replayed"] = True
        return out
    buyer = await _approved_partner(buyer_id, PartnerKind.SELLER)
    seller = await _approved_partner(seller_id, PartnerKind.SELLER)
    if buyer.get("is_active") is False or seller.get("is_active") is False:
        raise PartnerOpsError("Both sellers must be active to trade.")
    # Both sellers are the same person behind two records: a trade between them is a self-trade too.
    if buyer.get("owner_crm_uid") and buyer.get("owner_crm_uid") == seller.get("owner_crm_uid"):
        raise PartnerOpsError("Both seller records belong to the same person — that is trading with yourself.")
    allowed, why = await partner_svc.can_take_inventory(buyer_id)
    if not allowed:
        raise PartnerOpsError(why)
    now = _now()
    circular = await db[TRADES].find_one({
        "buyer_id": seller_id, "seller_id": buyer_id,
        "$or": [
            {"status": {"$in": [TradeStatus.PENDING, TradeStatus.APPROVING]}},
            {"status": TradeStatus.APPROVED, "approved_at": {"$gte": now - CIRCULAR_WINDOW}},
        ],
    })
    if circular:
        raise PartnerOpsError(
            "These coins would go straight back to the seller who just bought from you. "
            "Circular trades are refused for seven days after a trade."
        )
    reused = await db[TRADES].find_one({"seller_id": seller_id, "payment_ref": ref, "status": {"$ne": TradeStatus.REJECTED}})
    if reused:
        raise PartnerOpsError(f"Payment reference {ref} is already on another trade with this seller.")
    doc = {
        "_id": uuid.uuid4().hex, "buyer_id": buyer_id, "seller_id": seller_id, "coins": coins,
        "amount_paid_minor": amount_paid_minor, "payment_ref": ref, "client_request_id": crid,
        "status": TradeStatus.PENDING, "created_at": now, "created_by": _who(actor), "history": [],
        "buyer_name": str(buyer.get("name") or ""), "seller_name": str(seller.get("name") or ""),
    }
    await db[TRADES].insert_one(doc)
    await audit.record(
        actor=actor, action="seller.trade_filed", subject_type="seller_trade", subject_id=doc["_id"],
        reason=f"{buyer_id} bought {coins} coins from {seller_id} against {ref}",
        after={"status": TradeStatus.PENDING, "coins": coins, "amount_paid_minor": amount_paid_minor},
    )
    await _fs(_trade_mirror, doc)
    out = _public(doc)
    out["replayed"] = False
    return out


async def approve_trade(trade_id: str, reason: str, actor: dict) -> dict:
    """Staff verified the payment; an owner approves. The selling seller's coins move to the buyer, once."""
    reason = _require_reason(reason)
    db = get_db()
    trade = await db[TRADES].find_one({"_id": trade_id})
    if trade is None:
        raise PartnerOpsError("Trade not found.")
    if trade.get("status") != TradeStatus.PENDING:
        raise PartnerOpsError(f"This trade is {trade.get('status')}, not pending. Nothing was moved.")
    if trade.get("disputed"):
        raise PartnerOpsError(
            "The selling seller says they were not paid for this trade. Settle that first — reject it, and the buyer "
            "can file again with proof. Nothing was moved."
        )
    seller_id, buyer_id, coins = str(trade["seller_id"]), str(trade["buyer_id"]), int(trade["coins"])
    from app.services import money_freeze

    try:
        await money_freeze.assert_subject_not_frozen("partner", seller_id, db=db)
        await money_freeze.assert_subject_not_frozen("partner", buyer_id, db=db)
    except money_freeze.MoneyFrozen as exc:
        raise PartnerOpsError(str(exc)) from exc
    claimed = await db[TRADES].find_one_and_update(
        {"_id": trade_id, "status": TradeStatus.PENDING},
        {"$set": {"status": TradeStatus.APPROVING, "updated_at": _now()}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        raise PartnerOpsError("This trade was already decided. Nothing was moved twice.")
    meta = {"trade_id": trade_id, "amount_paid_minor": int(trade.get("amount_paid_minor") or 0),
            "buyer_id": buyer_id, "seller_id": seller_id}
    try:
        try:
            await apply_movement(Movement(
                holder_type=HolderType.SELLER, holder_id=seller_id, currency=Currency.COINS, amount=-coins,
                action=audit.Action.INVENTORY_DEBIT, reason=reason, actor=actor,
                idempotency_key=f"strade:{trade_id}:debit", meta=meta,
            ))
        except DuplicateMovement:
            pass
        except InsufficientBalance as exc:
            await db[TRADES].update_one({"_id": trade_id}, {"$set": {
                "status": TradeStatus.PENDING, "updated_at": _now(),
                "shortfall": {"available": exc.available, "needed": exc.requested, "at": _now()},
            }})
            await _fs(_trade_mirror, {**trade, "status": TradeStatus.PENDING}, {"note": "The selling seller does not have enough coins yet."})
            raise PartnerOpsError(
                f"{trade.get('seller_name') or seller_id} holds {exc.available:,} coins; this needs {exc.requested:,}. "
                "The trade stays pending until they top up."
            ) from exc
        try:
            await apply_movement(Movement(
                holder_type=HolderType.SELLER, holder_id=buyer_id, currency=Currency.COINS, amount=coins,
                action=audit.Action.INVENTORY_CREDIT, reason=reason, actor=actor,
                idempotency_key=f"strade:{trade_id}:credit", meta=meta,
            ))
        except DuplicateMovement:
            pass
    except PartnerOpsError:
        raise
    except Exception:
        await db[TRADES].update_one({"_id": trade_id, "status": TradeStatus.APPROVING},
                                    {"$set": {"status": TradeStatus.PENDING, "updated_at": _now()}})
        raise
    now = _now()
    updated = await db[TRADES].find_one_and_update(
        {"_id": trade_id},
        {"$set": {"status": TradeStatus.APPROVED, "approved_at": now, "approved_by": _who(actor), "approval_reason": reason,
                  "updated_at": now},
         "$push": {"history": {"at": now, "status": TradeStatus.APPROVED, "by": _who(actor), "reason": reason}}},
        return_document=ReturnDocument.AFTER,
    )
    await db[C.PARTNERS].update_one({"_id": seller_id}, {"$inc": {"total_coins_traded_out": coins}, "$set": {"updated_at": now}})
    await db[C.PARTNERS].update_one({"_id": buyer_id}, {"$inc": {"total_coins_traded_in": coins}, "$set": {"updated_at": now}})
    await audit.record(
        actor=actor, action="seller.trade_approved", subject_type="seller_trade", subject_id=trade_id, reason=reason,
        before={"status": TradeStatus.PENDING}, after={"status": TradeStatus.APPROVED},
        meta={"ledger_keys": [f"strade:{trade_id}:debit", f"strade:{trade_id}:credit"], **meta},
    )
    await _fs(_trade_mirror, updated or trade)
    return _public(updated or trade)


async def dispute_trade(trade_id: str, seller_id: str, reason: str, actor: dict) -> dict:
    """The selling seller says they were not paid. It decides nothing — it stops approval until staff look."""
    reason = _require_reason(reason)
    now = _now()
    updated = await get_db()[TRADES].find_one_and_update(
        {"_id": trade_id, "seller_id": seller_id, "status": TradeStatus.PENDING},
        {"$set": {"disputed": True, "dispute_reason": reason, "disputed_at": now, "disputed_by": _who(actor), "updated_at": now},
         "$push": {"history": {"at": now, "status": "disputed", "by": _who(actor), "reason": reason}}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError("Only a pending trade you are selling in can be disputed.")
    await audit.record(
        actor=actor, action="seller.trade_disputed", subject_type="seller_trade", subject_id=trade_id, reason=reason,
        after={"disputed": True},
    )
    await _fs(_trade_mirror, updated, {"disputed": True})
    return _public(updated)


async def reject_trade(trade_id: str, reason: str, actor: dict) -> dict:
    """Refuse a pending trade (staff, or the selling seller). Nothing has moved, so nothing moves back."""
    reason = _require_reason(reason)
    now = _now()
    updated = await get_db()[TRADES].find_one_and_update(
        {"_id": trade_id, "status": TradeStatus.PENDING},
        {"$set": {"status": TradeStatus.REJECTED, "rejected_at": now, "rejected_by": _who(actor), "rejection_reason": reason,
                  "updated_at": now},
         "$push": {"history": {"at": now, "status": TradeStatus.REJECTED, "by": _who(actor), "reason": reason}}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError("Only a pending trade can be rejected.")
    await audit.record(
        actor=actor, action="seller.trade_rejected", subject_type="seller_trade", subject_id=trade_id, reason=reason,
        before={"status": TradeStatus.PENDING}, after={"status": TradeStatus.REJECTED},
    )
    await _fs(_trade_mirror, updated)
    return _public(updated)


async def get_trade(trade_id: str) -> dict:
    doc = await get_db()[TRADES].find_one({"_id": trade_id})
    if doc is None:
        raise PartnerOpsError("Trade not found.")
    return _public(doc)


async def list_trades(seller_id: str | None = None, status: str | None = None, limit: int = 200) -> list[dict]:
    q: dict[str, Any] = {}
    if seller_id:
        q["$or"] = [{"buyer_id": seller_id}, {"seller_id": seller_id}]
    if status:
        q["status"] = status
    rows = [d async for d in get_db()[TRADES].find(q)]
    rows.sort(key=lambda d: d.get("created_at") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return [_public(d) for d in rows[: max(1, min(limit, 500))]]


# ══════════════════════════════════════════════════════════════════════════════
#  Self-use
# ══════════════════════════════════════════════════════════════════════════════


def _self_use_allowed() -> bool:
    try:
        snap = firebase.firestore_client().collection("appConfig").document("economy").get()
        return bool(snap.exists and (snap.to_dict() or {}).get("sellerSelfUseAllowed") is True)
    except Exception:  # noqa: BLE001 — unreadable means not allowed
        return False


async def use_inventory_for_self(seller_id: str, coins: int, client_request_id: str, reason: str, actor: dict) -> dict:
    """Coins → the seller's own app wallet as diamonds, where the Owner allows it. Never a sale."""
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")
    crid = (client_request_id or "").strip()
    if not CLIENT_REQUEST_ID.fullmatch(crid):
        raise PartnerOpsError("This request could not be read. Update the app and try again.")
    if not await _fs(_self_use_allowed):
        raise PartnerOpsError("Using your own inventory for calls and gifts is not switched on by Zipper.")
    partner = await _approved_partner(seller_id, PartnerKind.SELLER)
    owner_uid = str(partner.get("owner_crm_uid") or "")
    if not owner_uid:
        raise PartnerOpsError("This seller record has no app account to credit.")
    key = f"selfuse:{seller_id}:{crid}"
    meta = {"self_use": True, "seller_id": seller_id, "owner_uid": owner_uid}
    try:
        await apply_movement(Movement(
            holder_type=HolderType.SELLER, holder_id=seller_id, currency=Currency.COINS, amount=-coins,
            action=audit.Action.INVENTORY_DEBIT, reason=reason, actor=actor, idempotency_key=f"{key}:coins", meta=meta,
        ))
    except DuplicateMovement:
        return {"seller_id": seller_id, "coins": coins, "replayed": True}
    except InsufficientBalance as exc:
        raise PartnerOpsError(f"You hold {exc.available:,} coins; this needs {exc.requested:,}.") from exc
    try:
        await apply_movement(Movement(
            holder_type=HolderType.USER, holder_id=owner_uid, currency=Currency.DIAMONDS, amount=coins,
            action=audit.Action.BALANCE_CREDIT, reason=reason, actor=actor, idempotency_key=f"{key}:diamonds", meta=meta,
        ))
    except DuplicateMovement:
        pass
    await get_db()[C.PARTNERS].update_one({"_id": seller_id}, {"$inc": {"total_self_use": coins}, "$set": {"updated_at": _now()}})
    return {"seller_id": seller_id, "coins": coins, "credited_uid": owner_uid, "replayed": False}


# ══════════════════════════════════════════════════════════════════════════════
#  Profit
# ══════════════════════════════════════════════════════════════════════════════

PROFIT_DEFINITIONS = {
    "purchase_cost_minor": "What the seller paid for inventory: Zipper purchases (cash recorded on each signed card) and "
                           "coins bought from other sellers (the amount on each approved trade).",
    "revenue_minor": "What the seller's buyers paid: approved INR recharges, approved sales, and coins sold to other sellers.",
    "cost_of_sold_minor": "Coins sold × the seller's average purchase cost per coin. Borrowed coins carry no cost until "
                          "repaid, so a seller selling borrowed stock shows a higher margin until the repayment.",
    "gross_profit_minor": "revenue − cost of the coins sold. Self-use is not a sale and is not counted.",
}


async def seller_profit(seller_id: str) -> dict:
    """Purchase price, inventory, borrowing, sales and profit for one seller — all in paise, from the records."""
    partner = await _partner(seller_id, PartnerKind.SELLER)
    db = get_db()
    purchased_coins = purchase_cost = borrowed = 0
    async for row in db[C.LEDGER].find({"holder_type": str(HolderType.SELLER), "holder_id": seller_id,
                                         "currency": str(Currency.COINS)}):
        key = str(row.get("idempotency_key") or "")
        amount = int(row.get("amount") or 0)
        meta = row.get("meta") or {}
        if key.startswith("card:") and key.endswith(":coins") and amount > 0:
            purchased_coins += amount
            purchase_cost += int(meta.get("amount_paid_minor") or 0)
        elif key.startswith("strade:") and key.endswith(":credit") and amount > 0:
            purchased_coins += amount
            purchase_cost += int(meta.get("amount_paid_minor") or 0)
        elif key.startswith("card:") and key.endswith(":lend") and amount > 0:
            borrowed += amount
    coins_sold = revenue = 0
    other_currency = 0
    async for r in db[C.RECHARGES].find({"seller_id": seller_id, "status": "approved"}):
        if str(r.get("currency") or "INR").upper() != "INR":
            other_currency += 1
            continue
        coins_sold += int(r.get("credited_diamonds") or r.get("diamonds") or 0)
        revenue += int(r.get("amount_minor") or 0)
    async for s in db["partner_sales"].find({"seller_id": seller_id, "status": "approved"}):
        coins_sold += int(s.get("diamonds") or 0)
        revenue += int(s.get("amount_paid_minor") or 0)
    async for t in db[TRADES].find({"seller_id": seller_id, "status": TradeStatus.APPROVED}):
        coins_sold += int(t.get("coins") or 0)
        revenue += int(t.get("amount_paid_minor") or 0)
    avg_cost = (purchase_cost / purchased_coins) if purchased_coins else 0.0
    cost_of_sold = int(round(coins_sold * avg_cost))
    limit, outstanding, headroom = borrowing_headroom(partner)
    inventory = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    return {
        "seller_id": seller_id, "tier": str(partner.get("tier") or ""),
        "inventory_coins": inventory,
        "purchased_coins": purchased_coins, "purchase_cost_minor": purchase_cost,
        "avg_cost_inr_per_lakh": round(avg_cost * DIAMONDS_PER_LAKH / 100, 2),
        "borrowed_coins_total": borrowed, "credit_limit": limit, "credit_outstanding": outstanding, "borrow_headroom": headroom,
        "coins_sold": coins_sold, "revenue_minor": revenue,
        "avg_sale_inr_per_lakh": round((revenue / coins_sold) * DIAMONDS_PER_LAKH / 100, 2) if coins_sold else 0.0,
        "cost_of_sold_minor": cost_of_sold, "gross_profit_minor": revenue - cost_of_sold,
        "self_use_coins": int(partner.get("total_self_use") or 0),
        "excluded_non_inr_recharges": other_currency,
        "definitions": PROFIT_DEFINITIONS,
    }
