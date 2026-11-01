"""Manual recharge through a Coin Seller — verified by staff, credited once.

── THE SHAPE OF THE PROBLEM ────────────────────────────────────────────────

There is no payment gateway. A buyer pays a Coin Seller outside the app (UPI,
bank transfer, Binance, cash) and the diamonds must then appear in the app.
Two systems existed for that and neither was fit:

  * **Path A** — `rechargeRequests` in Firestore, approved by the SELLER's own
    tap in the Android seller dashboard, credited by a Cloud Function on the
    status flip. Non-idempotent (a random ledger id, no marker, and the rules
    let `approved → pending → approved` credit twice), with no proof, no
    reference, no staff verification and no Mongo ledger row. Nothing in any
    codebase creates one any more.
  * **Path B** — `partner_sales` in Mongo, moved through `money.apply_movement`
    with unique idempotency keys. The real ledger. But seller-filed, owner-
    approved on a single click, with no buyer-side request, no proof and no
    reversal.

This module is Path B with the buyer's request in front of it and a reversal
model behind it. It does not invent a third ledger: every diamond moves
through `apply_movement` with a deterministic `idempotency_key`, so a double
click, a retried request or a replayed call cannot credit or debit twice —
the second attempt raises `DuplicateMovement` and is treated as already done.

── THE LIFECYCLE ───────────────────────────────────────────────────────────

    pending          buyer filed; nothing has moved
      ├─ approved    staff verified the payment; seller coins → buyer diamonds
      └─ rejected    staff refused; nothing moved
    approved
      └─ refund_pending   a refund was requested; nothing has moved yet
            ├─ refunded         every credited diamond was still there and
            │                   was taken back; seller's coins restored
            ├─ reversed         PART of the credit was still there; that part
            │                   was taken back, the rest is recorded as spent
            └─ approved         the refund was refused; back to approved

Every transition is a compare-and-set on `status` in Mongo, so two staff
clicking the same button resolve to one decision and the loser is told what
the winner did. Every transition is audited and mirrored to the Firestore
`rechargeRequests/{id}` document the app and the seller dashboard read.

── WHAT A REVERSAL IS ALLOWED TO DO ────────────────────────────────────────

Take back only what is still there. The live balance is Firestore
`users.diamonds`, moved by gifts and calls Mongo never sees, so the clawback
runs as a Firestore transaction (`firebase.clawback_user_diamonds`) that
re-reads the balance and takes `min(outstanding, available)`. The shortfall
is recorded as `unrecoverable_diamonds` — spent — and the status says
`reversed` rather than `refunded`. The balance never goes negative and no
figure is invented. Whether the person owes money for the spent part is a
business decision recorded in the reason, not a ledger write.

A refund never bans anyone. Fraud enforcement is the existing moderation path
(`users.ban_user`, with its device bans and audit trail), reached by a human
who has decided it is fraud. This module records facts for that decision and
takes no action on an account.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.core import audit
from app.core.compat import StrEnum
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import notices
from app.services.money import (
    Currency,
    DuplicateMovement,
    HolderType,
    InsufficientBalance,
    Movement,
    apply_movement,
)
from app.services.partner_ops import PartnerOpsError, _public, _require_reason, _who
from app.services.partners import PartnerKind, PartnerStatus

log = logging.getLogger(__name__)

FS_RECHARGES = "rechargeRequests"
MAX_DIAMONDS = 1_000_000


class RechargeStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    REFUND_PENDING = "refund_pending"
    REFUNDED = "refunded"      # the whole credit came back
    REVERSED = "reversed"      # part of it came back; the rest was spent


PAYMENT_METHODS = ("upi", "bank", "binance", "cash", "international", "other")

#: RF-30: the app's id for ONE recharge form, the same on every retry of it.
#: Unique per buyer (`mongo.RECHARGE_REQUEST_ID_INDEX`). Optional — an older
#: app sends none and nothing about its requests changes.
CLIENT_REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{8,64}")

#: The fields a repeat must carry unchanged to be the SAME request.
_REPLAY_FIELDS = ("seller_id", "diamonds", "amount_minor", "currency", "payment_method", "proof_url")


def _same_request(earlier: dict, now: dict) -> bool:
    if any(earlier.get(f) != now.get(f) for f in _REPLAY_FIELDS):
        return False
    # `reference` is omitted from the stored document when blank.
    return str(earlier.get("reference") or "") == str(now.get("reference") or "")


class RefundStepNotConfirmed(PartnerOpsError):
    """HT-2 — a refund's live clawback could not be confirmed, and none is recorded. 409 / 503."""

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


async def _replay(db, buyer_uid: str, client_request_id: str, now: dict) -> dict[str, Any] | None:
    """RF-30: the request this buyer already filed with this id, if any.

    Same details → the stored request, unchanged, marked `replayed`; nothing is
    filed, notified or audited again. Different details → refused, so one id
    can never stand for two payments. None → no earlier request; file it.
    """
    earlier = await db[C.RECHARGES].find_one(
        {"buyer_uid": buyer_uid, "client_request_id": client_request_id}
    )
    if earlier is None:
        return None
    if not _same_request(earlier, now):
        raise PartnerOpsError(
            f"This request was already sent with different details (request {earlier['_id']}). "
            "Check Messages → Official before sending another."
        )
    out = _public(earlier)
    out["replayed"] = True
    return out


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _fs(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


async def _recharge(recharge_id: str) -> dict:
    doc = await get_db()[C.RECHARGES].find_one({"_id": str(recharge_id or "").strip()})
    if doc is None:
        raise PartnerOpsError("No recharge request with that id.")
    return doc


def _mirror(recharge: dict, fields: dict) -> bool:
    """Best effort — the Firestore document the app and seller dashboard read."""
    try:
        firebase.firestore_client().collection(FS_RECHARGES).document(
            str(recharge["_id"])
        ).set(fields, merge=True)
        return True
    except Exception:  # noqa: BLE001
        log.exception("rechargeRequests/%s mirror failed — Mongo is authoritative", recharge.get("_id"))
        return False


def _history_row(uid: str, row_id: str, data: dict) -> bool:
    """The app's diamond history. Deterministic id → idempotent."""
    try:
        firebase.firestore_client().collection("users").document(uid).collection(
            "diamondTransactions"
        ).document(row_id).set(data)
        return True
    except Exception:  # noqa: BLE001
        log.exception("diamondTransactions/%s for %s failed", row_id, uid)
        return False


async def _cas(recharge_id: str, from_status: str, update: dict) -> dict | None:
    """Compare-and-set on status. None means somebody else moved it first."""
    return await get_db()[C.RECHARGES].find_one_and_update(
        {"_id": recharge_id, "status": from_status},
        update,
        return_document=ReturnDocument.AFTER,
    )


#: A working status ('approving', 'refunding') older than this belongs to a
#: process that died mid-step. It may be re-claimed: every money step behind it
#: is idempotent (ledger keys, the clawback's history-row guard), so resuming
#: finishes the job instead of repeating it.
STALE_CLAIM = timedelta(minutes=10)


async def _claim(recharge_id: str, from_status: str, working: str, now: datetime) -> dict | None:
    """Move `from_status → working`, or re-take a STALE `working` claim.

    None means somebody else holds a live claim (or already finished)."""
    doc = await _cas(recharge_id, from_status, {
        "$set": {"status": working, "updated_at": now, "claimed_at": now},
    })
    if doc is not None:
        return doc
    return await get_db()[C.RECHARGES].find_one_and_update(
        {"_id": recharge_id, "status": working, "claimed_at": {"$lt": now - STALE_CLAIM}},
        {"$set": {"updated_at": now, "claimed_at": now}},
        return_document=ReturnDocument.AFTER,
    )


async def _notify_both(recharge: dict, event: str, *, diamonds: int, reason: str = "") -> dict:
    buyer = await notices.recharge_event(
        str(recharge.get("buyer_uid") or ""), str(recharge["_id"]), event,
        diamonds=diamonds, reason=reason, seller_name=str(recharge.get("seller_name") or ""),
    )
    seller_uid = str(recharge.get("seller_owner_uid") or "")
    seller = False
    if seller_uid:
        seller = await notices.recharge_event(
            seller_uid, str(recharge["_id"]), event, diamonds=diamonds, reason=reason, for_seller=True,
        )
    return {"buyer": buyer, "seller": seller}


# ── 1. The buyer files ──────────────────────────────────────────────────────

async def submit_recharge(
    buyer_uid: str,
    seller_id: str,
    *,
    diamonds: int,
    amount_minor: int,
    currency: str,
    payment_method: str,
    reference: str,
    proof_url: str,
    actor: dict,
    client_request_id: str = "",
) -> dict[str, Any]:
    """A buyer says "I paid this seller; here is the proof". Nothing moves.

    Refused if the seller is not an approved, active Coin Seller; if the
    amounts are not positive; if the same seller has already been named with
    the same reference (the duplicate-UTR check `/coin-purchases` already
    does for inventory purchases, applied here for the same reason).

    RF-30: with a `client_request_id`, a repeat of the same form by the same
    buyer returns the request already filed instead of filing a second one —
    the app's answer to a filing whose reply was lost to a timeout. Checked
    before the seller's state and the reference clash, so a repeat is
    recognised even when those would now refuse it.
    """
    buyer_uid = str(buyer_uid or "").strip()
    seller_id = str(seller_id or "").strip()
    if not buyer_uid or not seller_id:
        raise PartnerOpsError("A buyer and a seller are required.")
    diamonds = int(diamonds or 0)
    amount_minor = int(amount_minor or 0)
    if diamonds <= 0 or diamonds > MAX_DIAMONDS:
        raise PartnerOpsError("Say how many diamonds you are buying.")
    if amount_minor <= 0:
        raise PartnerOpsError("Say how much you paid.")
    method = str(payment_method or "").strip().lower()
    if method not in PAYMENT_METHODS:
        raise PartnerOpsError("Choose how you paid.")
    reference = str(reference or "").strip()[:128]
    proof_url = str(proof_url or "").strip()
    if not reference and not proof_url.startswith("https://"):
        raise PartnerOpsError(
            "Add the payment reference (UTR / transaction id) or a screenshot "
            "of the payment, so it can be verified."
        )
    currency = (str(currency or "").strip().upper() or "INR")[:8]
    client_request_id = str(client_request_id or "").strip()
    if client_request_id and not CLIENT_REQUEST_ID.fullmatch(client_request_id):
        raise PartnerOpsError("This request could not be read. Update the app and try again.")
    asked = {"seller_id": seller_id, "diamonds": diamonds, "amount_minor": amount_minor,
             "currency": currency, "payment_method": method, "proof_url": proof_url,
             "reference": reference}

    db = get_db()
    if client_request_id:
        replayed = await _replay(db, buyer_uid, client_request_id, asked)
        if replayed is not None:
            return replayed
    seller = await db[C.PARTNERS].find_one({"_id": seller_id})
    if (
        seller is None
        or str(seller.get("kind") or "") != str(PartnerKind.SELLER)
        or str(seller.get("status") or "") != str(PartnerStatus.APPROVED)
        or not seller.get("is_active", False)
    ):
        raise PartnerOpsError("That seller is not accepting recharges right now.")
    if str(seller.get("owner_crm_uid") or "") == buyer_uid:
        raise PartnerOpsError("A seller cannot recharge their own account this way.")

    if reference:
        clash = await db[C.RECHARGES].find_one({"seller_id": seller_id, "reference": reference})
        if clash is not None:
            raise PartnerOpsError(
                f"Reference {reference} has already been submitted for this seller "
                f"(request {clash['_id']}, {clash.get('status')}). Each payment can "
                "be used once."
            )

    now = _now()
    ref = firebase.firestore_client().collection(FS_RECHARGES).document()
    recharge_id = ref.id
    doc = {
        "_id": recharge_id,
        "buyer_uid": buyer_uid,
        "seller_id": seller_id,
        "seller_owner_uid": str(seller.get("owner_crm_uid") or ""),
        "seller_name": str(seller.get("name") or ""),
        "diamonds": diamonds,
        "amount_minor": amount_minor,
        "currency": currency,
        "payment_method": method,
        "proof_url": proof_url,
        "status": str(RechargeStatus.PENDING),
        "credited_diamonds": 0,
        "refunded_diamonds": 0,
        "unrecoverable_diamonds": 0,
        "created_at": now,
        "updated_at": now,
        "created_by": _who(actor),
        "source": "app",
        "history": [{"at": now, "status": "pending", "by": _who(actor)}],
    }
    if reference:
        doc["reference"] = reference  # partial unique index: key omitted when blank
    if client_request_id:
        doc["client_request_id"] = client_request_id  # RF-30, unique per buyer; omitted when blank

    try:
        await db[C.RECHARGES].insert_one(doc)
    except DuplicateKeyError as exc:
        # Two copies of the same form in flight (RF-30): the first one in won;
        # this one is answered with it. Otherwise (seller_id, reference) under
        # a race — nothing else is unique here.
        if client_request_id:
            replayed = await _replay(db, buyer_uid, client_request_id, asked)
            if replayed is not None:
                return replayed
        raise PartnerOpsError(
            f"Reference {reference} has already been submitted for this seller."
        ) from exc

    # The app-readable mirror, same id, legacy field names kept so the seller
    # dashboard and the weekly report keep reading it.
    mirrored = await _fs(_mirror, doc, {
        "buyerUid": buyer_uid,
        "sellerUid": doc["seller_owner_uid"],
        "sellerPartnerId": seller_id,
        "sellerName": doc["seller_name"],
        "diamondPackage": diamonds,
        "amountPaid": amount_minor / 100,
        "currency": currency,
        "paymentMethod": method,
        "transactionRef": reference,
        "paymentScreenshotUrl": proof_url,
        "status": "pending",
        "verifiedByStaff": False,
        "createdAt": now,
    })

    await audit.record(
        actor=actor,
        action=audit.Action.RECHARGE_REQUESTED,
        subject_type="recharge",
        subject_id=recharge_id,
        reason=f"Buyer {buyer_uid} filed a recharge through seller {seller_id}.",
        before=None,
        after={"status": "pending", "diamonds": diamonds, "amount_minor": amount_minor,
               "currency": currency, "payment_method": method},
        meta={"buyer_uid": buyer_uid, "seller_id": seller_id, "reference": reference},
    )
    notified = await _notify_both(doc, "submitted", diamonds=diamonds)
    out = _public(doc)
    out["replica_synced"] = mirrored
    out["notified"] = notified
    return out


# ── 2. Staff decide ─────────────────────────────────────────────────────────

async def approve_recharge(recharge_id: str, reason: str, actor: dict) -> dict[str, Any]:
    """Staff have verified the payment. Seller coins → buyer diamonds, once.

    The status moves `pending → approved` under a compare-and-set FIRST, so a
    second click finds nothing to move and is told so. Then the two
    movements run with deterministic idempotency keys, so even a retry that
    somehow got past the CAS cannot double-credit. If the seller lacks coins
    the status is put back to pending with the shortfall on the record — the
    buyer has paid, and the request stays in the queue until the seller tops
    up.
    """
    reason = _require_reason(reason)
    recharge = await _recharge(recharge_id)
    rid = str(recharge["_id"])
    diamonds = int(recharge.get("diamonds") or 0)
    buyer_uid = str(recharge.get("buyer_uid") or "")
    seller_id = str(recharge.get("seller_id") or "")
    now = _now()

    if recharge.get("status") not in (str(RechargeStatus.PENDING), "approving"):
        raise PartnerOpsError(
            f"This recharge is {recharge.get('status')}, not pending. Nothing was moved."
        )
    # RC (confirmed, CRM-FLOW 9.48): a frozen Coin Seller's inventory does not
    # move until the Owner decides; the request stays pending.
    from app.services import money_freeze  # local: keeps the import graph acyclic

    try:
        await money_freeze.assert_subject_not_frozen("partner", seller_id, db=get_db())
    except money_freeze.MoneyFrozen as exc:
        raise PartnerOpsError(str(exc)) from exc

    # Claim the decision. The loser of a double-click gets None here; a claim
    # abandoned by a dead process is re-taken after STALE_CLAIM.
    claimed = await _claim(rid, str(RechargeStatus.PENDING), "approving", now)
    if claimed is None:
        fresh = await _recharge(rid)
        raise PartnerOpsError(
            f"This recharge was already decided ({fresh.get('status')}). Nothing was moved twice."
        )

    try:
        # 1. The seller's inventory first. Never credit what nobody holds.
        try:
            await apply_movement(Movement(
                holder_type=HolderType.SELLER, holder_id=seller_id,
                currency=Currency.COINS, amount=-diamonds,
                action=audit.Action.INVENTORY_DEBIT, reason=reason, actor=actor,
                idempotency_key=f"recharge:{rid}:coins",
                meta={"recharge_id": rid, "buyer_uid": buyer_uid},
            ))
        except DuplicateMovement:
            pass  # already debited by an earlier attempt that died before the CAS
        except InsufficientBalance as exc:
            await get_db()[C.RECHARGES].update_one({"_id": rid}, {
                "$set": {"status": str(RechargeStatus.PENDING), "updated_at": _now(),
                         "shortfall": {"available": exc.available, "needed": exc.requested, "at": _now()}},
            })
            await _fs(_mirror, recharge, {"status": "pending",
                                          "transferErrorReason": "The seller does not have enough coins yet. The request stays in the queue."})
            raise PartnerOpsError(
                f"{recharge.get('seller_name') or seller_id} holds {exc.available} coins; "
                f"this needs {exc.requested}. The request stays pending until they top up."
            ) from exc

        # 2. The buyer's diamonds.
        try:
            await apply_movement(Movement(
                holder_type=HolderType.USER, holder_id=buyer_uid,
                currency=Currency.DIAMONDS, amount=diamonds,
                action=audit.Action.BALANCE_CREDIT, reason=reason, actor=actor,
                idempotency_key=f"recharge:{rid}:diamonds",
                meta={"recharge_id": rid, "seller_id": seller_id},
            ))
        except DuplicateMovement:
            pass
    except PartnerOpsError:
        raise
    except Exception:
        # Something other than a rule failed between the CAS and the credit.
        # Put the status back so a human can retry; the idempotency keys make
        # the retry safe.
        await get_db()[C.RECHARGES].update_one(
            {"_id": rid, "status": "approving"},
            {"$set": {"status": str(RechargeStatus.PENDING), "updated_at": _now()}},
        )
        raise

    updated = await get_db()[C.RECHARGES].find_one_and_update(
        {"_id": rid},
        {"$set": {
            "status": str(RechargeStatus.APPROVED),
            "credited_diamonds": diamonds,
            "approved_at": now, "approved_by": _who(actor), "approval_reason": reason,
            "reviewed_at": now, "reviewed_by": _who(actor),
            "updated_at": now,
        }, "$push": {"history": {"at": now, "status": "approved", "by": _who(actor), "reason": reason}}},
        return_document=ReturnDocument.AFTER,
    )
    await get_db()[C.PARTNERS].update_one(
        {"_id": seller_id}, {"$inc": {"total_coins_sold": diamonds}, "$set": {"updated_at": now}}
    )

    await audit.record(
        actor=actor, action=audit.Action.RECHARGE_APPROVED, subject_type="recharge",
        subject_id=rid, reason=reason,
        before={"status": "pending"}, after={"status": "approved", "credited_diamonds": diamonds},
        meta={"buyer_uid": buyer_uid, "seller_id": seller_id,
              "ledger_keys": [f"recharge:{rid}:coins", f"recharge:{rid}:diamonds"]},
    )

    # The app-visible history row and the mirror. The mirror marks the credit
    # as made by the ledger, which is what tells the legacy Cloud Function NOT
    # to credit a second time.
    await _fs(_history_row, buyer_uid, f"recharge_{rid}", {
        "type": "credit", "amount": diamonds,
        "relatedUserName": str(recharge.get("seller_name") or ""),
        "reason": f"Recharge via {recharge.get('seller_name') or 'seller'} — verified by Zipper",
        "rechargeRequestId": rid, "timestamp": now,
    })
    mirrored = await _fs(_mirror, updated, {
        "status": "approved", "approvedAt": now, "approvedBy": actor.get("uid", ""),
        "verifiedByStaff": True, "creditedByLedger": True, "creditedDiamonds": diamonds,
    })

    notified = await _notify_both(updated, "approved", diamonds=diamonds)
    out = _public(updated)
    out["replica_synced"] = mirrored
    out["notified"] = notified
    return out


async def reject_recharge(recharge_id: str, reason: str, actor: dict) -> dict[str, Any]:
    reason = _require_reason(reason)
    recharge = await _recharge(recharge_id)
    rid = str(recharge["_id"])
    now = _now()
    updated = await _cas(rid, str(RechargeStatus.PENDING), {
        "$set": {"status": str(RechargeStatus.REJECTED), "rejection_reason": reason,
                 "reviewed_at": now, "reviewed_by": _who(actor), "updated_at": now},
        "$push": {"history": {"at": now, "status": "rejected", "by": _who(actor), "reason": reason}},
    })
    if updated is None:
        fresh = await _recharge(rid)
        raise PartnerOpsError(f"This recharge is {fresh.get('status')}, not pending. Nothing was changed.")

    await audit.record(
        actor=actor, action=audit.Action.RECHARGE_REJECTED, subject_type="recharge",
        subject_id=rid, reason=reason, before={"status": "pending"},
        after={"status": "rejected"}, meta={"buyer_uid": recharge.get("buyer_uid"),
                                           "seller_id": recharge.get("seller_id")},
    )
    mirrored = await _fs(_mirror, updated, {"status": "rejected", "rejectedReason": reason,
                                             "reviewedAt": now, "reviewedBy": actor.get("uid", "")})
    notified = await _notify_both(updated, "rejected", diamonds=int(recharge.get("diamonds") or 0), reason=reason)
    out = _public(updated)
    out["replica_synced"] = mirrored
    out["notified"] = notified
    return out


# ── 3. Refund / reversal ────────────────────────────────────────────────────

async def request_refund(recharge_id: str, reason: str, actor: dict) -> dict[str, Any]:
    """Open a refund review on an approved recharge. Nothing moves."""
    reason = _require_reason(reason)
    recharge = await _recharge(recharge_id)
    rid = str(recharge["_id"])
    now = _now()
    # One logical refund = one refund cycle, numbered HERE, under the status
    # CAS, before any money can move. Every key the decision uses derives from
    # it, so no retry can ever compute a different one.
    cycle = int(recharge.get("refund_cycle") or 0) + 1
    updated = await _cas(rid, str(RechargeStatus.APPROVED), {
        "$set": {"status": str(RechargeStatus.REFUND_PENDING), "refund_reason": reason,
                 "refund_cycle": cycle,
                 "refund_requested_at": now, "refund_requested_by": _who(actor), "updated_at": now},
        "$push": {"history": {"at": now, "status": "refund_pending", "by": _who(actor), "reason": reason}},
    })
    if updated is None:
        fresh = await _recharge(rid)
        raise PartnerOpsError(
            f"A refund can be requested only on an approved recharge; this one is "
            f"{fresh.get('status')}. Nothing was changed."
        )
    await audit.record(
        actor=actor, action=audit.Action.RECHARGE_REFUND_REQUESTED, subject_type="recharge",
        subject_id=rid, reason=reason, before={"status": "approved"},
        after={"status": "refund_pending"}, meta={"buyer_uid": recharge.get("buyer_uid")},
    )
    mirrored = await _fs(_mirror, updated, {"status": "refund_pending", "refundReason": reason})
    notified = await _notify_both(updated, "refund_requested", diamonds=int(recharge.get("diamonds") or 0))
    out = _public(updated)
    out["replica_synced"] = mirrored
    out["notified"] = notified
    return out


async def decide_refund(recharge_id: str, approve: bool, reason: str, actor: dict) -> dict[str, Any]:
    """Approve or refuse the refund. Approval takes back only what is still there.

        outstanding   = credited − already refunded
        recoverable   = min(outstanding, live balance)   ← Firestore transaction
        unrecoverable = outstanding − recoverable         ← spent; recorded, never invented

    `refunded` when recoverable == outstanding, `reversed` when it was less.
    The seller's coins are restored by exactly the recovered amount. The
    reversal is idempotent: the clawback is one Firestore transaction behind
    a status CAS, and the Mongo movements carry per-attempt keys so a replay
    after a crash cannot debit the buyer twice.
    """
    reason = _require_reason(reason)
    recharge = await _recharge(recharge_id)
    rid = str(recharge["_id"])
    buyer_uid = str(recharge.get("buyer_uid") or "")
    seller_id = str(recharge.get("seller_id") or "")
    now = _now()

    resumable = approve and recharge.get("status") == "refunding"
    if recharge.get("status") != str(RechargeStatus.REFUND_PENDING) and not resumable:
        raise PartnerOpsError(
            f"No refund is under review on this recharge (it is {recharge.get('status')}). "
            "Nothing was changed."
        )

    if not approve:
        updated = await _cas(rid, str(RechargeStatus.REFUND_PENDING), {
            "$set": {"status": str(RechargeStatus.APPROVED), "refund_rejection_reason": reason,
                     "refund_decided_at": now, "refund_decided_by": _who(actor), "updated_at": now},
            "$push": {"history": {"at": now, "status": "refund_rejected", "by": _who(actor), "reason": reason}},
        })
        if updated is None:
            raise PartnerOpsError("The refund was already decided. Nothing was changed.")
        await audit.record(
            actor=actor, action=audit.Action.RECHARGE_REFUND_REJECTED, subject_type="recharge",
            subject_id=rid, reason=reason, before={"status": "refund_pending"},
            after={"status": "approved"}, meta={"buyer_uid": buyer_uid},
        )
        mirrored = await _fs(_mirror, updated, {"status": "approved", "refundRejectedReason": reason})
        notified = await _notify_both(updated, "refund_rejected",
                                      diamonds=int(recharge.get("diamonds") or 0), reason=reason)
        out = _public(updated)
        out["replica_synced"] = mirrored
        out["notified"] = notified
        return out

    credited = int(recharge.get("credited_diamonds") or 0)
    already = int(recharge.get("refunded_diamonds") or 0)
    outstanding = max(0, credited - already)
    # The deterministic identity of THIS refund (see request_refund). Records
    # opened before refund_cycle existed fall back to counting their opened
    # refund cycles, which is also fixed once the refund is pending.
    attempt = int(recharge.get("refund_cycle") or 0) or len(
        [h for h in recharge.get("history", []) if h.get("status") == "refund_pending"]
    ) or 1

    claimed = await _claim(rid, str(RechargeStatus.REFUND_PENDING), "refunding", now)
    if claimed is None:
        raise PartnerOpsError("The refund was already decided. Nothing was moved twice.")

    taken = 0
    available_before = 0
    try:
        if outstanding > 0:
            result = await _fs(
                firebase.clawback_user_diamonds, buyer_uid, outstanding,
                reason=f"Recharge {rid} reversed — {reason}",
                history_id=f"recharge_{rid}_reversal_{attempt}",
            )
            taken = int(result.get("taken") or 0)
            available_before = int(result.get("available_before") or 0)

        if taken > 0:
            # The ledger records what the live balance actually gave back.
            try:
                await apply_movement(Movement(
                    holder_type=HolderType.USER, holder_id=buyer_uid,
                    currency=Currency.DIAMONDS, amount=-taken,
                    action=audit.Action.REFUND, reason=reason, actor=actor,
                    idempotency_key=f"recharge:{rid}:refund:{attempt}:diamonds",
                    allow_negative=True, replica_applied_by_caller=True,
                    meta={"recharge_id": rid, "attempt": attempt, "outstanding": outstanding},
                ))
            except DuplicateMovement:
                pass
            try:
                await apply_movement(Movement(
                    holder_type=HolderType.SELLER, holder_id=seller_id,
                    currency=Currency.COINS, amount=taken,
                    action=audit.Action.REFUND, reason=reason, actor=actor,
                    idempotency_key=f"recharge:{rid}:refund:{attempt}:coins",
                    meta={"recharge_id": rid, "attempt": attempt},
                ))
            except DuplicateMovement:
                pass
    except Exception as exc:
        await get_db()[C.RECHARGES].update_one(
            {"_id": rid, "status": "refunding"},
            {"$set": {"status": str(RechargeStatus.REFUND_PENDING), "updated_at": _now()}},
        )
        if isinstance(exc, (firebase.TransactionNotApplied, firebase.TransactionOutcomeUnknown)):
            # HT-2: the reversal's history row was read again and is not there.
            # The refund is back under review; approving again replays on the
            # same history id, so nothing is taken twice.
            raise RefundStepNotConfirmed(
                f"{exc} The refund is back under review: approve it again — it cannot take twice.",
                status_code=exc.status_code,
            ) from exc
        raise

    unrecoverable = outstanding - taken
    final = RechargeStatus.REFUNDED if unrecoverable == 0 else RechargeStatus.REVERSED
    updated = await get_db()[C.RECHARGES].find_one_and_update(
        {"_id": rid},
        {"$set": {
            "status": str(final),
            "refunded_diamonds": already + taken,
            "unrecoverable_diamonds": int(recharge.get("unrecoverable_diamonds") or 0) + unrecoverable,
            "refund_decided_at": now, "refund_decided_by": _who(actor), "refund_decision_reason": reason,
            "updated_at": now,
        }, "$push": {"history": {
            "at": now, "status": str(final), "by": _who(actor), "reason": reason,
            "outstanding": outstanding, "available_before": available_before,
            "taken": taken, "unrecoverable": unrecoverable,
        }}},
        return_document=ReturnDocument.AFTER,
    )
    if taken > 0:
        await get_db()[C.PARTNERS].update_one(
            {"_id": seller_id}, {"$inc": {"total_coins_sold": -taken}, "$set": {"updated_at": now}}
        )

    await audit.record(
        actor=actor, action=audit.Action.RECHARGE_REFUNDED, subject_type="recharge",
        subject_id=rid, reason=reason, before={"status": "refund_pending", "credited": credited,
                                                "already_refunded": already},
        after={"status": str(final), "taken": taken, "unrecoverable": unrecoverable,
               "available_before": available_before},
        meta={"buyer_uid": buyer_uid, "seller_id": seller_id, "attempt": attempt,
              "note": "unrecoverable diamonds were already spent; no negative balance was created"},
    )
    mirrored = await _fs(_mirror, updated, {
        "status": str(final), "refundedDiamonds": already + taken,
        "unrecoverableDiamonds": unrecoverable, "refundDecidedAt": now,
    })
    notified = await _notify_both(updated, str(final), diamonds=taken, reason=reason)
    out = _public(updated)
    out["taken"] = taken
    out["unrecoverable"] = unrecoverable
    out["available_before"] = available_before
    out["replica_synced"] = mirrored
    out["notified"] = notified
    return out


# ── 4. Reading ──────────────────────────────────────────────────────────────

async def list_recharges(status: str | None = None, limit: int = 200,
                         seller_id: str | None = None, buyer_uid: str | None = None) -> list[dict]:
    query: dict[str, Any] = {}
    if status:
        query["status"] = str(status)
    if seller_id:
        query["seller_id"] = seller_id
    if buyer_uid:
        query["buyer_uid"] = buyer_uid
    cursor = get_db()[C.RECHARGES].find(query).sort("created_at", -1).limit(min(int(limit), 500))
    return [_public(d) async for d in cursor]


async def get_recharge(recharge_id: str) -> dict:
    return _public(await _recharge(recharge_id))
