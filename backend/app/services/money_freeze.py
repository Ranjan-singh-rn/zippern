"""RC (confirmed) — money behind a suspension, ban or revocation is FROZEN for
the Owner's review.

The rule, from the request and CRM-FLOW 9.48:

    "On suspension or role revocation, freeze pending earnings and transfers
    for Owner review. The Owner decides whether to release, withhold, or
    adjust them."

and, clarified with the user (RC-2), all four kinds:

    Host earnings · Agency / Sub-agency money · Coin Seller money · pending
    transfers (money already on its way out: payout, withdrawal and coin cards
    raised but not executed).

── WHAT A FREEZE IS ────────────────────────────────────────────────────────

One document per SUBJECT in `money_freezes`: an account (`user:{uid}`) or a
partner record (`partner:{id}`). It is written at the moment of the
suspension, ban or revocation, BEFORE the state change, so there is never a
restricted account whose money still moves. It records the cause, a snapshot of
what was pending, and — later — the Owner's decision.

While a freeze is `frozen` (or `withheld`), every path that would pay the
subject out, or move money it is owed, refuses with `MoneyFrozen`:

  * the weekly bean release and `convertBeans` (Cloud Functions) — through
    `users/{uid}.payoutHold`, which the release already honoured and nothing
    used to write;
  * host withdrawals, commission payouts, sub-agency payout legs, coin
    purchases and lending to a seller — at the one place each card is taken
    for execution (`partner_ops._card_ready`);
  * a Coin Seller's sales and recharges (which move its inventory).

Money coming BACK to Zipper (repayments, recoveries) and the Owner's own
write-offs are not blocked: freezing them would only grow the exposure.

── THE OWNER'S DECISION ────────────────────────────────────────────────────

`decide(…)` — Owner only, with a mandatory note:

  * `release`  — the freeze is lifted; what was pending may proceed.
  * `withhold` — it stays blocked (the decision is recorded; nothing moves).
  * `adjust`   — the Owner records the adjustment (an amount, a direction and
    a note) and the freeze is lifted. The adjustment itself is NOT a new money
    path: it is carried out through the existing two-person balance cards, and
    this record says what the Owner decided so it can be reconciled.

Nothing is released automatically — not by Resume, not by Unban, not by a
restoration. The Owner decides.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from app.core import audit
from app.core import roles as R
from app.db import firebase
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)

FREEZES = "money_freezes"

#: The two collections `partner_ops` owns, named here so a hold can reach them
#: without importing that module (which imports this one).
SALES = "partner_sales"
SUBAGENCY_PAYOUTS = "subagency_payouts"

#: B1 (spec §5 "Pending cards/requests go to Finance/Owner review; do not
#: auto-approve, cancel or execute"): the freeze causes that also put every
#: pending item of the subject on the held-for-review list.
REVOCATION_CAUSES = frozenset({"role_revoked", "host_revoked", "seller_revoked",
                               "agency_revoked", "sub_agency_revoked"})
HELD_ROLE_REVOKED = "role_revoked"

#: Statuses of a recharge / sale / sub-agency payout that are still undecided.
PENDING_RECHARGE_STATUSES = ("pending", "approving", "refund_pending", "refunding")
PENDING_SALE_STATUSES = ("pending", "approving", "failed")

#: Statuses that still block money.
BLOCKING = frozenset({"frozen", "withheld"})

DECISIONS = ("release", "withhold", "adjust")

#: Audit actions.
FROZEN = "money.frozen"
DECIDED = "money.freeze_decided"

#: The four kinds the user confirmed.
HOST_EARNINGS = "host_earnings"
AGENCY_MONEY = "agency_money"
SELLER_MONEY = "seller_money"
PENDING_TRANSFERS = "pending_transfers"

#: Card types that pay a frozen subject out, or move money it is owed. Money
#: coming back (repayments, recoveries) and write-offs are not here.
BLOCKED_CARD_TYPES = frozenset({
    "host_withdrawal", "salary_request", "commission_payout", "subagency_payout",
    "seller_coin_purchase", "lending_issue", "weekly_payout",
})


class MoneyFrozen(Exception):
    """This money is frozen for the Owner's review. Safe to show staff."""

    status_code = 409

    def __init__(self, message: str, *, freeze: dict | None = None) -> None:
        super().__init__(message)
        self.freeze = freeze or {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _db(db=None):
    """The caller's database handle (the module that triggered the freeze), so
    a freeze always lands in the same store as the change that caused it."""
    return db if db is not None else get_db()


def key_of(subject_type: str, subject_id: str) -> str:
    return f"{subject_type}:{subject_id}"


def _who(actor: dict | None) -> dict:
    a = actor or {}
    return {"uid": str(a.get("uid") or ""), "name": str(a.get("name") or ""), "role": str(a.get("role") or "")}


async def active_freeze(subject_type: str, subject_id: str, *, db=None) -> dict | None:
    """The freeze that still blocks this subject's money, or None."""
    if not subject_id:
        return None
    doc = await _db(db)[FREEZES].find_one({"_id": key_of(subject_type, str(subject_id))})
    if doc and str(doc.get("status") or "") in BLOCKING:
        return doc
    return None


def _message(doc: dict) -> str:
    cause = (doc.get("causes") or [{}])[-1]
    what = str(cause.get("label") or cause.get("action") or "a restriction")
    status = str(doc.get("status") or "frozen")
    verb = "withheld by the Owner" if status == "withheld" else "frozen for the Owner's review"
    return (
        f"This money is {verb} after {what}. Nothing was paid or moved. The Owner releases, "
        "withholds or adjusts it on the frozen-money queue."
    )


async def _snapshot_user(uid: str, db=None) -> dict[str, Any]:
    """What was pending for a Host at the freeze: beans, and cards not yet executed."""
    out: dict[str, Any] = {"cards": []}
    try:
        snap = await asyncio.to_thread(firebase.firestore_client().collection("users").document(uid).get)
        data = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
        out["beans"] = int(data.get("beans") or 0)
        out["beansAvailable"] = int(data.get("beansAvailable") or 0)
    except Exception:  # noqa: BLE001 — the snapshot is a record, not a gate
        log.warning("freeze snapshot: users/%s could not be read", uid)
    out["cards"] = await _pending_cards("user", uid, db)
    return out


async def _pending_cards(subject_type: str, subject_id: str, db=None) -> list[dict]:
    rows: list[dict] = []
    try:
        async for c in _db(db)[C.CARDS].find({"subject.id": str(subject_id)}):
            if str(c.get("stage") or "") in ("executed", "rejected", "failed"):
                continue
            if str(c.get("type") or "") not in BLOCKED_CARD_TYPES:
                continue
            rows.append({"id": str(c.get("_id")), "type": str(c.get("type") or ""),
                         "amount": c.get("amount"), "currency": c.get("currency"),
                         "stage": str(c.get("stage") or "")})
    except Exception:  # noqa: BLE001
        log.warning("freeze snapshot: cards of %s:%s could not be read", subject_type, subject_id)
    return rows


async def freeze(
    subject_type: str, subject_id: str, *, kinds: list[str], cause: str, label: str,
    reason: str, actor: dict, owner_uid: str = "", snapshot: dict | None = None, db=None,
) -> dict:
    """Freeze (or keep frozen) this subject's money. Idempotent per subject.

    A second cause on a subject already frozen is APPENDED; a subject whose
    earlier freeze was released is frozen again (a new cause is a new review).
    """
    if not subject_id:
        raise ValueError("A freeze needs a subject.")
    now = _now()
    k = key_of(subject_type, str(subject_id))
    cause_doc = {"action": cause, "label": label, "reason": reason, "at": now, "by": _who(actor)}
    db = _db(db)
    existing = await db[FREEZES].find_one({"_id": k})
    if existing and str(existing.get("status") or "") in BLOCKING:
        merged = list(dict.fromkeys(list(existing.get("kinds") or []) + list(kinds)))
        await db[FREEZES].update_one(
            {"_id": k},
            {"$push": {"causes": cause_doc}, "$set": {"kinds": merged, "updated_at": now}},
        )
        doc = await db[FREEZES].find_one({"_id": k}) or existing
    else:
        doc = {
            "_id": k,
            "subject": {"type": subject_type, "id": str(subject_id)},
            "owner_uid": owner_uid,
            "kinds": list(dict.fromkeys(kinds)),
            "status": "frozen",
            "causes": [cause_doc],
            "snapshot": snapshot or {},
            "frozen_at": now,
            # A subject frozen again after a release keeps the earlier decisions.
            "decisions": list((existing or {}).get("decisions") or []),
            "updated_at": now,
        }
        await db[FREEZES].update_one(
            {"_id": k}, {"$set": {kk: vv for kk, vv in doc.items() if kk != "_id"}}, upsert=True,
        )
    await audit.record(
        actor=actor, action=FROZEN, subject_type=subject_type, subject_id=str(subject_id),
        reason=f"Money frozen for Owner review after {label}. {reason}".strip(),
        before={"status": str((existing or {}).get("status") or "")},
        after={"status": "frozen", "kinds": doc.get("kinds")},
        meta={"cause": cause, "snapshot": snapshot or {}},
    )
    return doc


async def freeze_user(
    uid: str, *, cause: str, label: str, reason: str, actor: dict, include_partners: bool = True,
    db=None,
) -> list[dict]:
    """Freeze a person's Host earnings — and, when the whole ACCOUNT is
    restricted, the money of every partner record they own.

    A revocation cause also puts the person's pending cards on the
    held-for-review list (`hold_pending_items_for_revoked_role`)."""
    db = _db(db)
    out = [await freeze("user", uid, kinds=[HOST_EARNINGS, PENDING_TRANSFERS], cause=cause, label=label,
                        reason=reason, actor=actor, owner_uid=uid,
                        snapshot=await _snapshot_user(uid, db), db=db)]
    if cause in REVOCATION_CAUSES:
        out[0]["held_items"] = await _hold_best_effort("host", uid, reason, actor, db)
    if include_partners:
        from app.services import partner_roles  # local: partner_roles is a leaf

        for row in await partner_roles.records_owned_by(uid, db=db):
            if str(row.get("status") or "") in ("rejected", "pending"):
                continue
            out.append(await freeze_partner(str(row.get("_id")), row=row, cause=cause, label=label,
                                            reason=reason, actor=actor, db=db))
    return out


async def freeze_partner(
    partner_id: str, *, cause: str, label: str, reason: str, actor: dict, row: dict | None = None,
    db=None,
) -> dict:
    """Freeze one partner record's money (its kind decides which of the four).

    A revocation cause also puts the record's pending cards, recharges, sales
    and sub-agency payouts on the held-for-review list."""
    db = _db(db)
    if row is None:
        row = await db[C.PARTNERS].find_one({"_id": partner_id}) or {}
    kind = str(row.get("kind") or "")
    kinds = [SELLER_MONEY if kind == "seller" else AGENCY_MONEY, PENDING_TRANSFERS]
    snapshot = {"cards": await _pending_cards("partner", partner_id, db),
                "balance": row.get("balance"), "kind": kind}
    doc = await freeze("partner", partner_id, kinds=kinds, cause=cause, label=label, reason=reason,
                       actor=actor, owner_uid=str(row.get("owner_crm_uid") or ""), snapshot=snapshot, db=db)
    if cause in REVOCATION_CAUSES:
        doc["held_items"] = await _hold_best_effort(kind or "partner", partner_id, reason, actor, db)
    return doc


async def _hold_best_effort(partner_kind: str, partner_id: str, reason: str, actor: dict, db) -> dict:
    """The hold never fails the revocation it rides on: the freeze is the
    control, the hold is the Finance board's visibility. A failure is
    recorded (log + audit) and the revoke response carries it."""
    try:
        return await hold_pending_items_for_revoked_role(partner_kind, partner_id, reason, actor, db=db)
    except Exception as exc:  # noqa: BLE001
        log.exception("pending items of %s:%s could not be put on hold", partner_kind, partner_id)
        try:
            await audit.record(
                actor=actor, action=audit.Action.MONEY_ITEM_HELD,
                subject_type="partner" if partner_kind != "host" else "user", subject_id=str(partner_id),
                reason=f"Pending items could NOT be put on hold after revocation: {type(exc).__name__}: {exc}",
                after={"held": 0, "error": str(exc)},
                meta={"partner_kind": partner_kind, "held_reason": HELD_ROLE_REVOKED, "failed": True},
            )
        except Exception:  # noqa: BLE001
            log.exception("…and the failure could not be audited")
        return {"held": 0, "error": f"{type(exc).__name__}: {exc}"}


# ── Held for review (B1, spec §5 / §11) ──────────────────────────────────────
#
# "Pending cards/requests go to Finance/Owner review; do not auto-approve,
#  cancel or execute."
#
# A hold is a MARKER on the item itself — `held: {reason: 'role_revoked', …}`
# on the card, the recharge, the sale or the sub-agency payout — never a copy
# in a second collection, so the board shows the same document the decision
# will be taken on. Nothing about the item's stage or status changes: the
# freeze (above) is what stops money moving; the hold is what puts the item in
# front of Finance and the Owner with the reason it is waiting. They decide it
# through the ordinary routes — reject it, or release the freeze and execute
# it — and `release_hold` lifts the marker when an item should proceed.


def _held_marker(partner_kind: str, partner_id: str, reason: str, actor: dict, now: datetime) -> dict:
    return {
        "reason": HELD_ROLE_REVOKED,
        "partner_kind": str(partner_kind or ""),
        "partner_id": str(partner_id or ""),
        "note": str(reason or ""),
        "at": now,
        "by": _who(actor),
    }


async def _hold_in(db, collection: str, queries: list[dict], item_type: str, marker: dict, actor: dict,
                   label_of) -> list[dict]:
    """Mark every item matching any of `queries` (one query per field — plain
    equality queries, so both the database and every fake of it answer them
    the same way). Idempotent: an item already held is skipped."""
    held: list[dict] = []
    seen: set[str] = set()
    for query in queries:
        async for item in db[collection].find(query):
            item_id = item.get("_id")
            if str(item_id) in seen:
                continue
            seen.add(str(item_id))
            if isinstance(item.get("held"), dict):
                # Already on the list — or RELEASED from it by Finance / an
                # Owner, whose decision a replay of the same revocation must
                # not undo. (A later revocation of a reinstated partner finds
                # its pending items without a marker, because an item decided
                # in the meantime is no longer pending.)
                continue
            res = await db[collection].update_one(
                {"_id": item_id},
                {"$set": {"held": marker, "updated_at": marker["at"]}},
            )
            if getattr(res, "matched_count", 1) != 1:
                continue
            await _audit_hold(item, item_id, item_type, marker, actor, label_of)
            held.append({"item_type": item_type, "id": str(item_id), "label": label_of(item)})
    return held


async def _audit_hold(item: dict, item_id, item_type: str, marker: dict, actor: dict, label_of) -> None:
    await audit.record(
        actor=actor, action=audit.Action.MONEY_ITEM_HELD, subject_type=item_type,
        subject_id=str(item_id),
        reason=f"Held for Finance/Owner review after a role revocation. {marker['note']}".strip(),
        before={"held": False}, after={"held": True, "held_reason": HELD_ROLE_REVOKED},
        card_id=str(item_id) if item_type == "card" else str(item.get("card_id") or "") or None,
        meta={"item_type": item_type, "partner_kind": marker["partner_kind"],
              "partner_id": marker["partner_id"], "label": label_of(item)},
    )


async def hold_pending_items_for_revoked_role(
    partner_kind: str, partner_id: str, reason: str, actor: dict, *, db=None,
) -> dict:
    """Put every pending money item of a revoked partner on the Finance board.

    `partner_kind` is `seller` / `agency` / `sub_agency` (then `partner_id` is
    the partner record id) or `host` (then it is the user's uid). Cards whose
    subject or payload names the partner, recharges through a seller, a
    seller's sales and the sub-agency payouts the partner is a party to are
    all marked `held.reason = 'role_revoked'`. Nothing is approved, cancelled
    or executed; each item is decided by Finance or an Owner. Idempotent — an
    item already held is left as it is.
    """
    from app.services.cards import PENDING_STAGES  # local: cards is a leaf of this module's graph

    db = _db(db)
    pid = str(partner_id or "").strip()
    if not pid:
        raise ValueError("A hold needs the partner it is for.")
    now = _now()
    marker = _held_marker(partner_kind, pid, reason, actor, now)
    held: list[dict] = []

    pending = {"stage": {"$in": sorted(PENDING_STAGES)}}
    card_queries = [{**pending, field: pid} for field in (
        "subject.id", "payload.host_id", "payload.seller_id", "payload.agency_id",
        "payload.sub_id", "payload.parent_id", "payload.uid",
    )]
    held += await _hold_in(db, C.CARDS, card_queries, "card", marker, actor,
                           lambda c: f"{c.get('type')} {c.get('amount')} {c.get('currency')} ({c.get('stage')})")

    if str(partner_kind) != "host":
        held += await _hold_in(
            db, C.RECHARGES,
            [{"seller_id": pid, "status": {"$in": list(PENDING_RECHARGE_STATUSES)}}],
            "recharge", marker, actor,
            lambda r: f"recharge {r.get('diamonds')} diamonds for {r.get('buyer_uid')} ({r.get('status')})",
        )
        held += await _hold_in(
            db, SALES,
            [{"seller_id": pid, "status": {"$in": list(PENDING_SALE_STATUSES)}}],
            "sale", marker, actor,
            lambda s: f"sale {s.get('diamonds')} diamonds to {s.get('buyer_uid')} ({s.get('status')})",
        )
        held += await _hold_in(
            db, SUBAGENCY_PAYOUTS,
            [{"status": {"$ne": "closed"}, "parent_id": pid}, {"status": {"$ne": "closed"}, "sub_id": pid}],
            "subagency_payout", marker, actor,
            lambda p: f"sub-agency payout {p.get('amount_minor')} paise ({p.get('status')})",
        )

    return {"held": len(held), "items": held, "partner_kind": str(partner_kind), "partner_id": pid}


async def list_held_items(limit: int = 200, *, db=None, include_released: bool = False) -> dict:
    """Everything on the held-for-review list, newest hold first, by kind."""
    from app.services.cards import PENDING_STAGES

    db = _db(db)
    lim = max(1, min(int(limit), 500))

    def _live(doc: dict) -> bool:
        held = doc.get("held")
        if not isinstance(held, dict):
            return False
        return include_released or not held.get("released_at")

    def _rows(collection: str, extra: dict) -> Any:
        return db[collection].find({"held": {"$exists": True}, **extra}).sort("updated_at", -1).limit(lim)

    out: dict[str, list] = {"cards": [], "recharges": [], "sales": [], "subagency_payouts": []}
    async for c in _rows(C.CARDS, {"stage": {"$in": sorted(PENDING_STAGES)}}):
        if _live(c):
            c["id"] = str(c.pop("_id"))
            out["cards"].append(c)
    async for r in _rows(C.RECHARGES, {"status": {"$in": list(PENDING_RECHARGE_STATUSES)}}):
        if _live(r):
            r["id"] = str(r.pop("_id"))
            out["recharges"].append(r)
    async for s in _rows(SALES, {"status": {"$in": list(PENDING_SALE_STATUSES)}}):
        if _live(s):
            s["id"] = str(s.pop("_id"))
            out["sales"].append(s)
    async for p in _rows(SUBAGENCY_PAYOUTS, {"status": {"$ne": "closed"}}):
        if _live(p):
            p["id"] = str(p.pop("_id"))
            out["subagency_payouts"].append(p)
    out["total"] = sum(len(v) for v in out.values())
    return out


_HELD_COLLECTIONS = {"card": C.CARDS, "recharge": C.RECHARGES, "sale": SALES,
                     "subagency_payout": SUBAGENCY_PAYOUTS}


def can_decide_held(actor: dict | None) -> bool:
    """Finance (its admin) or an Owner — the two the spec names."""
    role = str((actor or {}).get("role") or "")
    return R.is_owner_value(role) or role == str(R.Role.FINANCE_ADMIN)


async def release_hold(item_type: str, item_id: str, reason: str, actor: dict, *, db=None) -> dict:
    """Finance or an Owner lifts a hold so the item can be decided normally.

    The marker is kept with `released_at/by/reason` — history, never deleted.
    """
    if not can_decide_held(actor):
        raise PermissionError("Only Finance or an Owner may release a held item.")
    collection = _HELD_COLLECTIONS.get(str(item_type or ""))
    if collection is None:
        raise ValueError("item_type must be one of card, recharge, sale, subagency_payout.")
    reason = str(reason or "").strip()
    if len(reason) < 5:
        raise ValueError("Say why — the note is the record of this decision.")
    db = _db(db)
    now = _now()
    lookup: Any = str(item_id or "").strip()
    if collection == C.CARDS or collection in (SALES, SUBAGENCY_PAYOUTS):
        from bson import ObjectId

        try:
            lookup = ObjectId(lookup)
        except Exception as exc:  # noqa: BLE001
            raise LookupError("No held item with that id.") from exc
    res = await db[collection].find_one_and_update(
        {"_id": lookup, "held": {"$exists": True}, "held.released_at": {"$exists": False}},
        {"$set": {"held.released_at": now, "held.released_by": _who(actor),
                  "held.release_reason": reason, "updated_at": now}},
    )
    if res is None:
        raise LookupError("No held item with that id, or it was already released.")
    await audit.record(
        actor=actor, action=audit.Action.MONEY_ITEM_RELEASED, subject_type=str(item_type),
        subject_id=str(item_id), reason=reason,
        before={"held": True}, after={"held": False},
        card_id=str(item_id) if item_type == "card" else None,
        meta={"item_type": str(item_type), "held_reason": (res.get("held") or {}).get("reason")},
    )
    doc = await db[collection].find_one({"_id": lookup}) or {}
    doc["id"] = str(doc.pop("_id", item_id))
    return doc


def hold_fields(label: str) -> dict:
    """The Firestore fields that stop a Host's beans moving (`releaseBeansForWeek`,
    `convertBeans`), written in the SAME write as the restriction."""
    return {"payoutHold": True, "payoutHoldReason": f"frozen_for_owner_review: {label}",
            "payoutHoldAt": _now()}


async def assert_subject_not_frozen(subject_type: str, subject_id: str, *, db=None) -> None:
    doc = await active_freeze(subject_type, subject_id, db=db)
    if doc:
        raise MoneyFrozen(_message(doc), freeze=doc)


async def assert_card_not_frozen(card: dict, *, db=None) -> None:
    """Refuse a card that would pay out (or move money owed to) a frozen subject."""
    if str(card.get("type") or "") not in BLOCKED_CARD_TYPES:
        return
    subject = card.get("subject") or {}
    sid = str(subject.get("id") or "")
    stype = str(subject.get("type") or "")
    payload = card.get("payload") or {}
    candidates: list[tuple[str, str]] = []
    if stype == "user":
        candidates.append(("user", sid))
    elif stype in ("agency", "seller", "partner"):
        candidates.append(("partner", sid))
    for k in ("sub_agency_id", "parent_id", "agency_id", "seller_id", "host_uid"):
        v = str(payload.get(k) or "").strip()
        if v:
            candidates.append(("user" if k == "host_uid" else "partner", v))
    for st, si in candidates:
        await assert_subject_not_frozen(st, si, db=db)


async def list_freezes(status: str | None = None, limit: int = 200, *, db=None) -> list[dict]:
    q: dict = {}
    if status:
        q["status"] = status
    rows: list[dict] = []
    async for d in _db(db)[FREEZES].find(q).sort("frozen_at", -1).limit(min(limit, 500)):
        d["id"] = str(d.pop("_id"))
        rows.append(d)
    return rows


async def decide(
    key: str, decision: str, note: str, actor: dict, *, adjustment: dict | None = None, db=None,
) -> dict:
    """The Owner releases, withholds or adjusts a frozen subject's money."""
    if not R.is_owner_value((actor or {}).get("role")):
        raise PermissionError("Only an Owner may release, withhold or adjust frozen money.")
    decision = str(decision or "").strip()
    if decision not in DECISIONS:
        raise ValueError("Choose release, withhold or adjust.")
    note = str(note or "").strip()
    if len(note) < 5:
        raise ValueError("Say why — the note is the record of this decision.")
    db = _db(db)
    doc = await db[FREEZES].find_one({"_id": key})
    if doc is None:
        raise LookupError("No frozen money found for that subject.")
    status_now = str(doc.get("status") or "")
    if status_now not in BLOCKING:
        raise ValueError(f"This freeze was already {status_now}.")
    adj: dict[str, Any] = {}
    if decision == "adjust":
        a = dict(adjustment or {})
        try:
            amount = int(a.get("amount") or 0)
        except (TypeError, ValueError):
            amount = 0
        if amount <= 0 or str(a.get("direction") or "") not in ("increase", "decrease"):
            raise ValueError("An adjustment needs a positive amount and a direction (increase or decrease).")
        adj = {"amount": amount, "direction": str(a.get("direction")),
               "currency": str(a.get("currency") or ""), "note": note,
               "carried_out_by": "a balance card (two-person) — not by this decision"}
    new_status = {"release": "released", "withhold": "withheld", "adjust": "adjusted"}[decision]
    now = _now()
    entry = {"at": now, "by": _who(actor), "decision": decision, "note": note, **({"adjustment": adj} if adj else {})}
    # Compare-and-set on the status read, so two Owners deciding at once record one decision.
    res = await db[FREEZES].find_one_and_update(
        {"_id": key, "status": status_now},
        {"$set": {"status": new_status, "decided_at": now, "decided_by": _who(actor), "updated_at": now},
         "$push": {"decisions": entry}},
    )
    if res is None:
        raise ValueError("This freeze changed while it was being decided. Reload it and decide again.")
    subject = doc.get("subject") or {}
    if subject.get("type") == "user" and new_status in ("released", "adjusted"):
        await _lift_hold(str(subject.get("id") or ""), db)
    await audit.record(
        actor=actor, action=DECIDED, subject_type=str(subject.get("type") or ""),
        subject_id=str(subject.get("id") or ""), reason=note,
        before={"status": status_now}, after={"status": new_status},
        meta={"decision": decision, **({"adjustment": adj} if adj else {})},
    )
    out = {**(await db[FREEZES].find_one({"_id": key}) or {}), "id": key}
    # §8: a frozen-money decision is one Owner's; the others are told. Best
    # effort and last — the decision above is committed and audited.
    try:
        from app.services import owner_mail  # local: keeps the import graph acyclic

        snapshot = doc.get("snapshot") or {}
        amount = adj.get("amount") if adj else snapshot.get("beansAvailable", snapshot.get("beans"))
        out["owner_notice"] = await owner_mail.notify_other_owners(
            actor=actor, action=f"freeze_{decision}", reference=key, reference_type="money_freeze",
            amount=amount if isinstance(amount, int) else None,
            currency=(adj.get("currency") if adj else ("beans" if subject.get("type") == "user" else "")),
            title=f"Frozen money of {subject.get('type')} {subject.get('id')}",
            subject=dict(subject), reason=note,
            rows=[("Decision", new_status), ("Kinds", ", ".join(doc.get("kinds") or []))],
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Owner notification for freeze decision %s failed", key)
        out["owner_notice"] = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
    return out


async def _lift_hold(uid: str, db=None) -> None:
    """The Host's beans may move again — only if no other freeze still holds them."""
    if not uid or await active_freeze("user", uid, db=db):
        return
    try:
        from firebase_admin import firestore as fb_fs

        await asyncio.to_thread(
            firebase.firestore_client().collection("users").document(uid).set,
            {"payoutHold": False, "payoutHoldReason": fb_fs.DELETE_FIELD, "payoutHoldAt": fb_fs.DELETE_FIELD},
            merge=True,
        )
    except Exception:  # noqa: BLE001
        log.exception("payoutHold could not be lifted for %s after release", uid)
