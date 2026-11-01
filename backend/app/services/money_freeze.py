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
    restricted, the money of every partner record they own."""
    db = _db(db)
    out = [await freeze("user", uid, kinds=[HOST_EARNINGS, PENDING_TRANSFERS], cause=cause, label=label,
                        reason=reason, actor=actor, owner_uid=uid,
                        snapshot=await _snapshot_user(uid, db), db=db)]
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
    """Freeze one partner record's money (its kind decides which of the four)."""
    db = _db(db)
    if row is None:
        row = await db[C.PARTNERS].find_one({"_id": partner_id}) or {}
    kind = str(row.get("kind") or "")
    kinds = [SELLER_MONEY if kind == "seller" else AGENCY_MONEY, PENDING_TRANSFERS]
    snapshot = {"cards": await _pending_cards("partner", partner_id, db),
                "balance": row.get("balance"), "kind": kind}
    return await freeze("partner", partner_id, kinds=kinds, cause=cause, label=label, reason=reason,
                        actor=actor, owner_uid=str(row.get("owner_crm_uid") or ""), snapshot=snapshot, db=db)


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
    return {**(await db[FREEZES].find_one({"_id": key}) or {}), "id": key}


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
