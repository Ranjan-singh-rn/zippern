"""Money-side hooks a role revocation or a transfer needs (spec §5 / §6).

── WHY THIS FILE EXISTS ────────────────────────────────────────────────────

The identity / role / moderation side of the backend (B2) and the money side
(B1: `partner_ops`, `money`, `cards`, `recharges`, `money_freeze`, …) are owned
by different people in this phase. A revocation has to reach into the money
board — "pending cards/requests go to Finance/Owner review, never
auto-approve/cancel/execute" — and the role side must not edit the money
modules to do it. So the CONTRACT lives here: the signatures the role side
calls, with what each must guarantee, and the money side implements them.

── IMPLEMENTED (B1) ────────────────────────────────────────────────────────

Both hooks delegate to `app/services/money_freeze.py`, which is where the
held-for-review list lives:

  * A hold is a MARKER on the item — `held: {reason: 'role_revoked',
    partner_kind, partner_id, note, at, by}` on the card, the recharge, the
    sale or the sub-agency payout — never a new stage. The card's stage machine
    (requested → under_review → awaiting_signoff → approved → executed) is
    untouched, so "no state transition may be skipped" still holds and the item
    is decided through its ordinary route. `HELD_FOR_REVOCATION_REVIEW` names
    the QUEUE (what the CRM lists via `GET /api/partner-ops/held-items`), not a
    stage value.
  * The money freeze placed by the revocation (`money_freeze.freeze_partner` /
    `freeze_user`, cause in `money_freeze.REVOCATION_CAUSES`) already puts the
    subject's pending items on the list, so a call here after the freeze holds
    nothing new and reports the same ids — idempotent by construction.
  * Nothing here approves, cancels or executes; balances and ledgers are not
    touched; a seller with nothing pending gets an empty, successful answer.

OWNER_DECISION_PENDING: "pending money on revocation = held queue for
Finance/Owner" is the stated default this contract implements. Whether a held
item is later executed, rejected or re-raised is decided item by item by
Finance / the Owner on the money board, never here.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

#: The name of the review queue a revoked partner's pending money goes to.
#: Spelled here so both sides agree; it is the `held.reason` value the items
#: carry (`money_freeze.HELD_ROLE_REVOKED`) seen from the role side.
HELD_FOR_REVOCATION_REVIEW = "held_revocation_review"


async def hold_pending_money_for_revoked_seller(
    partner_id: str, *, reason: str, actor: dict, db: Any = None,
) -> dict[str, Any]:
    """Park every PENDING card and request of a revoked Coin Seller for Finance/Owner review.

    Idempotent: a second call holds nothing new and reports the same ids. Never
    raises — a failure is reported in the answer (and audited by
    `money_freeze`) so the revocation it rides on completes.

    Returns `{"implemented": True, "partner_id", "cards_held": [ids],
    "requests_held": [ids], "newly_held": n, "queue":
    HELD_FOR_REVOCATION_REVIEW}`.
    """
    from app.services import money_freeze

    pid = str(partner_id or "").strip()
    try:
        held = await money_freeze.hold_pending_items_for_revoked_role(
            "seller", pid, reason, actor, db=db,
        )
        listed = await money_freeze.list_held_items(db=db)
    except Exception as exc:  # noqa: BLE001 — the revocation must still complete
        log.exception("hold_pending_money_for_revoked_seller(%s) failed", pid)
        return {
            "implemented": True, "partner_id": pid, "cards_held": [], "requests_held": [],
            "newly_held": 0, "queue": HELD_FOR_REVOCATION_REVIEW,
            "error": f"{type(exc).__name__}: {exc}",
            "note": "The hold could not be recorded; the money freeze placed by the revocation "
                    "still refuses every payout, purchase and sale for this record.",
        }

    def _mine(items: list[dict]) -> list[str]:
        return [str(i["id"]) for i in items if str((i.get("held") or {}).get("partner_id") or "") == pid]

    return {
        "implemented": True,
        "partner_id": pid,
        "cards_held": _mine(listed.get("cards") or []),
        "requests_held": (
            _mine(listed.get("recharges") or [])
            + _mine(listed.get("sales") or [])
            + _mine(listed.get("subagency_payouts") or [])
        ),
        "newly_held": int(held.get("held") or 0),
        "queue": HELD_FOR_REVOCATION_REVIEW,
        "note": (
            "Held items keep their stage/status and carry held.reason='role_revoked'; "
            "Finance or an Owner decides each one through its ordinary route "
            "(GET /api/partner-ops/held-items lists them)."
        ),
    }


async def pending_money_summary(subject_type: str, subject_id: str, *, db: Any = None) -> dict[str, Any]:
    """What is pending for a subject about to be revoked or transferred — for the CRM dialog.

    Read-only; never raises. `subject_type` is `user` (a host, by uid) or
    `partner` (an agency / sub-agency / seller record id).
    """
    from app.services import money_freeze

    stype = "user" if str(subject_type) == "user" else "partner"
    sid = str(subject_id or "").strip()
    out: dict[str, Any] = {
        "implemented": True, "subject": {"type": stype, "id": sid},
        "cards": [], "open_requests": [], "beans_pending": 0, "coin_balance": 0,
    }
    if not sid:
        return out
    try:
        if stype == "user":
            snapshot = await money_freeze._snapshot_user(sid, db)
            out["cards"] = list(snapshot.get("cards") or [])
            out["beans_pending"] = int(snapshot.get("beans") or 0)
            out["beans_available"] = int(snapshot.get("beansAvailable") or 0)
        else:
            from app.db.mongo import C, get_db
            from app.services.money import Currency, HolderType

            d = db if db is not None else get_db()
            # Every pending card about this record, whatever its type — the
            # dialog shows what is waiting, not only what the freeze blocks.
            from app.services.cards import PENDING_STAGES

            out["cards"] = [
                {"id": str(c.get("_id")), "type": str(c.get("type") or ""), "amount": c.get("amount"),
                 "currency": c.get("currency"), "stage": str(c.get("stage") or ""),
                 "held": bool(isinstance(c.get("held"), dict) and not c["held"].get("released_at"))}
                async for c in d[C.CARDS].find({"subject.id": sid, "stage": {"$in": sorted(PENDING_STAGES)}})
            ]
            balance = await d[C.BALANCES].find_one({
                "holder_type": str(HolderType.SELLER), "holder_id": sid, "currency": str(Currency.COINS),
            })
            out["coin_balance"] = int((balance or {}).get("amount") or 0)
            commission = await d[C.BALANCES].find_one({
                "holder_type": str(HolderType.AGENCY), "holder_id": sid, "currency": str(Currency.COMMISSION),
            })
            out["commission_balance_minor"] = int((commission or {}).get("amount") or 0)
            async for r in d[C.RECHARGES].find({"seller_id": sid, "status": {"$in": list(money_freeze.PENDING_RECHARGE_STATUSES)}}):
                out["open_requests"].append({"kind": "recharge", "id": str(r.get("_id")), "status": r.get("status"),
                                             "diamonds": r.get("diamonds"), "buyer_uid": r.get("buyer_uid")})
            async for s in d[money_freeze.SALES].find({"seller_id": sid, "status": {"$in": list(money_freeze.PENDING_SALE_STATUSES)}}):
                out["open_requests"].append({"kind": "sale", "id": str(s.get("_id")), "status": s.get("status"),
                                             "diamonds": s.get("diamonds"), "buyer_uid": s.get("buyer_uid")})
    except Exception as exc:  # noqa: BLE001 — a dialog, not a decision
        log.exception("pending_money_summary(%s:%s) failed", stype, sid)
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out
