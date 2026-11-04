"""The money board.

Spec Part 5. Teams do the work, owners sign, nothing moves money without a
signature.

    Requested → Under Review → Awaiting Sign-off → Approved → Executed

Approved and Executed are separate on purpose: if the transfer fails, the card
is visibly stuck rather than silently lost (5.2.6).

Rules enforced here, not in the UI:
  * a member's card is verified by their own admin           (5.5.1)
  * an admin's own card is verified by a different admin     (5.5.2)
  * nothing skips Under Review, including an owner's card    (5.5.4)
  * rejection requires a reason                              (5.5.5)
  * only an owner rejects a verified or signed card          (B-2)

── THE OWNER-ALONE DECISION (master spec §8) ────────────────────────────────

    "One Owner may raise, verify, sign and execute a money card alone. This
     intentionally overrides the older two-Owner separation model. Audit every
     step. Notify other Owners in-app and by email with actor, action, amount
     and card reference. Department staff never approve final money movement.
     No state transition may be skipped."

So the three refusals that used to keep two humans on every card — the raiser
cannot verify, the raiser cannot sign, the verifier cannot sign — **no longer
apply when the actor is an Owner**. They still apply to everybody else: a
Finance admin who raised a card cannot verify it, and nobody but an Owner
signs or executes. What replaces the second person is the record and the
telling: every stage still writes its own audit entry, even when one Owner
runs them back to back (`owner_fast_path`), and every signature, execution,
recharge approval, refund decision and frozen-money decision is pushed to the
other active Owners in-app and by email (`owner_mail`).

One refusal is deliberately kept: an Owner does not sign a card whose
**subject is themselves** (their own capital drawings). That is not the
two-Owner model, it is self-dealing, and the decision does not mention it —
`SELF_SUBJECT_NEEDS_ANOTHER_OWNER` is the flag, marked OWNER_DECISION_PENDING.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from bson import ObjectId

from app.core import audit
from app.core import roles as R
from app.core.compat import StrEnum
from app.core.roles import Role, Team
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)

#: Master spec §8, confirmed: one Owner may take a card through every stage.
OWNER_ALONE = True

#: OWNER_DECISION_PENDING — an Owner still cannot sign the card that pays
#: *them* (`subject.id == signer`). Set False to let the owner-alone rule cover
#: self-subject cards too; nothing else reads this flag.
SELF_SUBJECT_NEEDS_ANOTHER_OWNER = True

#: Owner decision, 5 Nov 2026: "if owner signs something, that will be a final decision … if owner signs, coins will
#: be directly automatically added — no extra clicking." An Owner's signature on a card whose execution only moves
#: coins or diamonds inside Zipper runs that execution in the same request. Payouts are NOT in this set: their
#: execution records a bank transfer a person makes first (with its reference), so that step stays theirs.
AUTO_EXECUTE_ON_OWNER_SIGN = True

#: Owner decision, 5 Nov 2026: "one owner, if it is doing something, let it be done; the other owners just get to
#: know." A card an Owner raises from a staff screen is reviewed, verified and signed by them in the same step
#: (`complete_if_owner` → `owner_fast_path`: every stage still writes its own audit entry, the other Owners are told).
OWNER_COMPLETES_OWN_CARDS = True


class Stage(StrEnum):
    REQUESTED = "requested"
    UNDER_REVIEW = "under_review"
    AWAITING_SIGNOFF = "awaiting_signoff"
    APPROVED = "approved"
    EXECUTED = "executed"
    REJECTED = "rejected"
    FAILED = "failed"


#: The stages a card can still be decided from — what "pending" means on the
#: board, in the hold-for-review queue and in the freeze snapshots.
PENDING_STAGES: frozenset[str] = frozenset(
    {str(Stage.REQUESTED), str(Stage.UNDER_REVIEW), str(Stage.AWAITING_SIGNOFF), str(Stage.APPROVED)}
)


class CardType(StrEnum):
    """Everything that goes on this board. Spec 5.3."""

    BALANCE_CREDIT = "balance_credit"
    BALANCE_DEBIT = "balance_debit"
    SELLER_COIN_PURCHASE = "seller_coin_purchase"
    LENDING_ISSUE = "lending_issue"
    LENDING_REPAY = "lending_repay"
    LENDING_RECOVER = "lending_recover"
    LENDING_WRITE_OFF = "lending_write_off"
    COMMISSION_PAYOUT = "commission_payout"
    SUBAGENCY_PAYOUT = "subagency_payout"
    HOST_WITHDRAWAL = "host_withdrawal"
    SALARY_REQUEST = "salary_request"
    WEEKLY_PAYOUT = "weekly_payout"
    RATE_CHANGE = "rate_change"
    PRICING_CHANGE = "pricing_change"
    FX_OVERRIDE = "fx_override"
    PROMOTION = "promotion"
    REFUND = "refund"
    BAD_DEBT_WRITE_OFF = "bad_debt_write_off"

    #: The configuration of a chance mechanic — a lucky gift tier, a game. The
    #: outcome table and its probabilities, the stake denominations, the maximum
    #: single win and the countries it is enabled in (8B.2.8). Raised by
    #: `app/services/chance.py`, which is the only thing that creates one.
    #:
    #: **Its own type rather than `RATE_CHANGE` or `PRICING_CHANGE`.** Either
    #: would have carried the five stages correctly — the argument is not about
    #: the stage machine but about what the board and the reports do with
    #: `type`. A rate change is what an agency's commission slab moves on and a
    #: pricing change is what a diamond pack costs: both are partner-facing,
    #: both are quoted in statements, and the P&L already groups cards by type
    #: over a window on a dedicated index. An odds table, a payout ceiling and a
    #: country list are none of those things. Filed as a rate change, "every
    #: rate change this quarter" starts returning probability tables, and the
    #: question a regulator asks — "every change to the Indian country list for
    #: this mechanic, and who signed each one" — becomes a string search inside
    #: payloads instead of a query. One type, one filter, and separation of
    #: duties, the audit trail and the five stages are inherited unchanged.
    CHANCE_CONFIG_CHANGE = "chance_config_change"

    #: Money leaving the company to run the company — a salary, a server bill, a
    #: gateway fee, a tax payment. Raised by `app/services/expenses.py`, which is
    #: the only thing that creates one, and carries its category in
    #: `payload.category`. One type rather than eight because the category is
    #: *data* about the money and the five stages are the same either way; eight
    #: types would give eight boards to drain and eight places for the rules to
    #: drift apart.
    OPERATING_EXPENSE = "operating_expense"

    #: An owner putting their own money into the business, and taking it back.
    #:
    #: **Neither of these is revenue and neither is a cost**, and getting that
    #: wrong is the difference between a business that looks profitable and one
    #: that is. Money an owner puts in arrives in the bank exactly like a coin
    #: seller's payment does — but the seller bought something and the owner did
    #: not. Counting it as revenue reports a company funding itself as a company
    #: earning. Taking it back out is the repayment of that, not an expense, so
    #: counting it as a cost reports a repaid loan as a loss.
    #:
    #: They belong to a third thing the reports call the capital account:
    #: cash movements that change what the business owes its owners and never
    #: touch profit. `/reports/capital` reports what each owner has put in, taken
    #: back and is still owed.
    #:
    #: Their own types rather than a category on `OPERATING_EXPENSE` for the
    #: reason above: an expense is subtracted from profit by definition, and a
    #: category that must be excluded from the one thing its type exists to feed
    #: is a trap someone eventually falls into.
    OWNER_CAPITAL_IN = "owner_capital_in"
    OWNER_DRAWINGS = "owner_drawings"


#: B-3: the card types the GENERIC `POST /api/cards` route may raise. Every
#: type with a raise route of its own (coin purchase, lending, repayment,
#: recovery, write-off, commission/sub-agency/host payouts, balance changes,
#: expenses, capital, chance configuration) is refused there, because those
#: routes carry the validations a signer relies on — the price check, the
#: duplicate-UTR scan, `can_take_inventory`, the live wallet read — and a card
#: raised past them looks exactly like an honest one. Nothing in the CRM calls
#: the generic route (`zipper-crm/lib/api.ts` declares `cards.raise` and no
#: page uses it), so the allow-list is the configuration-only types that have
#: no executor and move no balance.
GENERIC_RAISE_TYPES: frozenset[str] = frozenset(
    {
        str(CardType.RATE_CHANGE),
        str(CardType.PRICING_CHANGE),
        str(CardType.FX_OVERRIDE),
        str(CardType.PROMOTION),
        str(CardType.REFUND),
    }
)


#: The card types a partner may read when they are the **subject** of one.
#:
#: An allowlist, for the same reason `deps.PARTNER_REACHABLE` is one: the
#: failure mode of a new card type is silence, and "everything except the ones
#: we remembered to exclude" is a rule that quietly widens every time somebody
#: adds a member to `CardType`. A type added tomorrow is invisible to partners
#: until it appears here, in a diff, next to this comment.
#:
#: Each of these is *this partner's own money*, and each is raised by staff
#: about them — which is exactly why they were unreadable before. A seller who
#: has been lent inventory could see the ledger line and not the card, so
#: "where has the repayment I made got to" had no answer anywhere.
#:
#:   * `seller_coin_purchase` — usually theirs already, but staff raise one on a
#:     seller's behalf when the payment arrives some other way (4.3.5).
#:   * the four lending types and `bad_debt_write_off` — credit issued to them,
#:     a repayment, a recovery from their stock, a debt written off (4.3.7,
#:     4.3.10, 4.3.13, 4.3.17). Every one of these changes what they owe.
#:   * `commission_payout` — money we owe *them* (4.2).
#:   * `subagency_payout` — the sub-agency is the subject, and 4.2.6 says a
#:     payout is not closed until leg 2 is confirmed. Without the card the sub
#:     sees its balance fall to zero on leg 1 and cannot tell "Zipper has paid
#:     my parent" from "I have been paid".
#:
#: Everything NOT here stays staff-only, and the ones that matter are worth
#: naming: `balance_credit` / `balance_debit` are a user's account and carry a
#: user uid as the subject; `operating_expense`, `salary_request`,
#: `weekly_payout`, `rate_change`, `pricing_change`, `fx_override`, `promotion`,
#: `refund` and `chance_config_change` are the company's own books and the
#: company's own configuration — an odds table on a card is not a partner's
#: money and its subject is not a partner record.
PARTNER_SUBJECT_CARD_TYPES: frozenset[str] = frozenset(
    {
        str(CardType.SELLER_COIN_PURCHASE),
        str(CardType.LENDING_ISSUE),
        str(CardType.LENDING_REPAY),
        str(CardType.LENDING_RECOVER),
        str(CardType.LENDING_WRITE_OFF),
        str(CardType.BAD_DEBT_WRITE_OFF),
        str(CardType.COMMISSION_PAYOUT),
        str(CardType.SUBAGENCY_PAYOUT),
    }
)

#: The `subject.type` values that mean "a partner record". A card's subject id
#: is only a partner id when its subject type says so — `balance_credit` carries
#: a Firebase uid in the same field, and matching on the id alone would rest on
#: two id spaces never colliding.
PARTNER_SUBJECT_TYPES: frozenset[str] = frozenset({"seller", "agency"})

#: What a staff member looks like to a partner. A partner is entitled to know
#: their card was verified and signed — that is the state of their own money —
#: and not to know which named employee did it, or which team they sit on.
ZIPPER: dict = {"uid": "", "name": "Zipper", "role": "internal", "team": None}


class CardError(Exception):
    """Rejected by a board rule. The message is safe to show the caller."""


@dataclass(slots=True)
class NewCard:
    type: CardType
    team: Team
    title: str
    amount: int
    currency: str
    reason: str
    subject_type: str
    subject_id: str
    payload: dict
    evidence: list[dict] | None = None
    auto_verified: bool = False
    auto_verified_note: str | None = None


async def raise_card(card: NewCard, actor: dict) -> dict:
    """Create a card. Spec 5.2.1."""
    if not card.reason.strip():
        raise CardError("A reason is required.")
    if card.amount == 0:
        raise CardError("A card must carry a non-zero amount.")

    now = datetime.now(timezone.utc)

    # A payment proven by the bank or a gateway needs no human verification.
    # Spec 5.3.1 / 8C.2.5.
    stage = Stage.AWAITING_SIGNOFF if card.auto_verified else Stage.REQUESTED

    doc = {
        "type": str(card.type),
        "team": str(card.team),
        "title": card.title,
        "amount": card.amount,
        "currency": card.currency,
        "reason": card.reason.strip(),
        "subject": {"type": card.subject_type, "id": card.subject_id},
        "payload": card.payload,
        "evidence": card.evidence or [],
        "stage": str(stage),
        "requested_by": _who(actor),
        "created_at": now,
        "updated_at": now,
        "review_started_by": None,
        "review_started_at": None,
        "verified_by": None,
        "verified_at": None,
        "verification_note": card.auto_verified_note if card.auto_verified else None,
        "auto_verified": card.auto_verified,
        "signed_by": None,
        "signed_at": None,
        "executed_at": None,
        "execution_result": None,
        "rejected_by": None,
        "rejected_at": None,
        "rejection_reason": None,
    }

    result = await get_db()[C.CARDS].insert_one(doc)
    card_id = str(result.inserted_id)

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_RAISED,
        subject_type="card",
        subject_id=card_id,
        reason=card.reason,
        after={"stage": str(stage), "amount": card.amount, "currency": card.currency},
        card_id=card_id,
        meta={"type": str(card.type), "auto_verified": card.auto_verified},
    )

    doc["id"] = card_id
    doc.pop("_id", None)
    return doc


async def start_review(card_id: str, actor: dict) -> dict:
    """Move a card into Under Review. Spec 5.2.2.

    Its own audit entry (`card.review_started`) and its own timestamp, so a
    card's history can prove the stage was passed through and not skipped
    (5.5.4 / B-23). Conditional on the card still being `requested`: two
    reviewers opening it at once record one start.
    """
    card = await _get(card_id)
    if card["stage"] != Stage.REQUESTED:
        raise CardError(f"Card is {card['stage']}, not awaiting review.")

    _assert_can_verify(card, actor)
    await _record_review_start(card, actor)
    return await _get(card_id, as_dict=True)


async def _record_review_start(card: dict, actor: dict) -> str:
    card_id = str(card["_id"])
    now = datetime.now(timezone.utc)
    res = await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id), "stage": str(Stage.REQUESTED)},
        {"$set": {
            "stage": str(Stage.UNDER_REVIEW),
            "review_started_by": _who(actor),
            "review_started_at": now,
            "updated_at": now,
        }},
    )
    if getattr(res, "matched_count", 1) != 1:
        latest = await _get(card_id)
        raise CardError(f"Card is {latest['stage']}, not awaiting review.")
    return await audit.record(
        actor=actor,
        action=audit.Action.CARD_REVIEW_STARTED,
        subject_type="card",
        subject_id=card_id,
        reason="Review started",
        before={"stage": str(Stage.REQUESTED)},
        after={"stage": str(Stage.UNDER_REVIEW)},
        card_id=card_id,
    )


async def verify(card_id: str, actor: dict, note: str) -> dict:
    """Verification complete — hand to owners. Spec 5.2.3.

    B-23 — NOTHING SKIPS UNDER REVIEW. A card that is still `requested` is not
    moved straight to `awaiting_signoff`: the Under Review transition is
    recorded first — its own stage write, its own audit entry, its own
    timestamp and reviewer — and only then is the verification written. The
    caller that pressed "verify" on a fresh card did look at it; what changes
    is that the record now says so. `start_review` first, then `verify`, is
    the same two writes made by two requests.

    B-6 — the stage write is conditional on the stage this read, so a verify
    racing a reject cannot resurrect a rejected card.
    """
    if not note.strip():
        raise CardError("Verification requires a note describing what was checked.")

    card = await _get(card_id)
    if card["stage"] not in (Stage.REQUESTED, Stage.UNDER_REVIEW):
        raise CardError(f"Card is {card['stage']} and cannot be verified.")

    _assert_can_verify(card, actor)

    if card["stage"] == Stage.REQUESTED:
        await _record_review_start(card, actor)

    now = datetime.now(timezone.utc)
    res = await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id), "stage": str(Stage.UNDER_REVIEW)},
        {
            "$set": {
                "stage": str(Stage.AWAITING_SIGNOFF),
                "verified_by": _who(actor),
                "verified_at": now,
                "verification_note": note.strip(),
                "updated_at": now,
            }
        },
    )
    if getattr(res, "matched_count", 1) != 1:
        latest = await _get(card_id)
        raise CardError(f"Card is {latest['stage']} and cannot be verified.")

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_VERIFIED,
        subject_type="card",
        subject_id=card_id,
        reason=note,
        before={"stage": str(Stage.UNDER_REVIEW)},
        after={"stage": str(Stage.AWAITING_SIGNOFF)},
        card_id=card_id,
    )
    return await _get(card_id, as_dict=True)


async def sign(card_id: str, actor: dict, note: str = "") -> dict:
    """Owner signature. Spec 5.2.4.

    B-6 — conditional on the card still awaiting signature: a sign racing a
    reject loses instead of turning a rejected card into an approved one.
    After the signature the other Owners are told (§8); a failure to tell
    them never undoes the signature — it is recorded and retried.
    """
    if not R.can_sign_money(actor["role"]):
        raise CardError("Only a business owner can sign this.")

    card = await _get(card_id)
    if card["stage"] != Stage.AWAITING_SIGNOFF:
        raise CardError(
            f"Card is {card['stage']}. Only verified cards can be signed."
        )

    # ── The two-person refusals, kept for everybody who is not an Owner ──────
    #
    # §8: one Owner may raise, verify and sign the same card. Only an Owner
    # reaches this function at all (`can_sign_money`), so under the decision
    # these two checks are switched off by `OWNER_ALONE`; they are kept in the
    # code, not deleted, because the decision is a flag the business can
    # reverse, and because a reader of the audit should see what was relaxed.
    owner_alone = OWNER_ALONE and R.is_owner_value(actor.get("role"))
    if not owner_alone:
        # 5.5.3 — nobody signs their own request.
        if card["requested_by"]["uid"] == actor["uid"]:
            raise CardError("You raised this card. Another owner must sign it.")

        # Separation of duties: the person who verified cannot also sign.
        verifier = card.get("verified_by") or {}
        if verifier.get("uid") == actor["uid"]:
            raise CardError(
                "You verified this card. Someone else must sign it."
            )

    # ── Nor the person the money is FOR ──────────────────────────────────────
    #
    # `routers/capital.py` and `services/capital.py` both state that an owner
    # cannot sign their own capital card. The two checks above compare the
    # signer against the RAISER and the VERIFIER, and an owner whose capital
    # card was raised by a finance admin is neither — so owner A could legally
    # sign the card that pays owner A. `subject` is set by every caller that
    # has one (`capital.py` writes `subject_type="owner"`, `subject_id=<owner
    # uid>`), so this reads as "you are the subject of this movement" rather
    # than being specific to capital. A card with no subject is unaffected.
    # Kept under the owner-alone decision (OWNER_DECISION_PENDING): self-dealing
    # is not the two-Owner model the decision overrides.
    subject = card.get("subject") or {}
    if SELF_SUBJECT_NEEDS_ANOTHER_OWNER and subject.get("id") and subject.get("id") == actor["uid"]:
        raise CardError(
            "This card pays you. Another owner must sign it."
        )

    now = datetime.now(timezone.utc)
    res = await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id), "stage": str(Stage.AWAITING_SIGNOFF)},
        {
            "$set": {
                "stage": str(Stage.APPROVED),
                "signed_by": _who(actor),
                "signed_at": now,
                "signature_note": note.strip() or None,
                "owner_alone": bool(
                    owner_alone
                    and (
                        card["requested_by"]["uid"] == actor["uid"]
                        or (card.get("verified_by") or {}).get("uid") == actor["uid"]
                    )
                ),
                "updated_at": now,
            }
        },
    )
    if getattr(res, "matched_count", 1) != 1:
        latest = await _get(card_id)
        raise CardError(f"Card is {latest['stage']}. Only verified cards can be signed.")

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_SIGNED,
        subject_type="card",
        subject_id=card_id,
        reason=note.strip() or "Approved",
        before={"stage": str(Stage.AWAITING_SIGNOFF)},
        after={"stage": str(Stage.APPROVED)},
        card_id=card_id,
        meta={
            "amount": card["amount"], "currency": card["currency"],
            "owner_alone": owner_alone,
            "raised_by_signer": card["requested_by"]["uid"] == actor["uid"],
            "verified_by_signer": (card.get("verified_by") or {}).get("uid") == actor["uid"],
        },
    )
    signed = await _get(card_id, as_dict=True)
    signed["owner_notice"] = await _notify_owners(signed, actor, "card_signed")
    auto = await _auto_execute_after_owner_sign(signed, actor)
    if auto is not None:
        notice = signed.get("owner_notice")
        signed = auto
        signed.setdefault("owner_notice", notice)
    return signed


async def _auto_execute_after_owner_sign(card: dict, actor: dict) -> dict | None:
    """Owner decision (5 Nov 2026): an Owner's signature on a coin / diamond card moves it at once.

    Runs the type's own registered executor — the same code, checks, idempotency keys, claim and audit as the
    separate execute step it replaces — so nothing about HOW the money moves changes, only that nobody has to click
    a second time. Returns the card as it is afterwards, or None when this card is not one that executes on
    signature. An execution that fails (a frozen account, a short balance) leaves the card exactly where the
    executor leaves it (approved, or failed with its reason) and says so; the signature itself stands.
    """
    if not (AUTO_EXECUTE_ON_OWNER_SIGN and R.is_owner_value(actor.get("role"))):
        return None
    card_type = str(card.get("type") or "")
    if card_type not in AUTO_EXECUTE_TYPES or str(card.get("stage")) != str(Stage.APPROVED):
        return None
    executor = EXECUTORS.get(card_type)
    if executor is None:
        return None
    card_id = str(card.get("id") or card.get("_id") or "")
    try:
        result = await executor(card_id, actor, payment_ref="")
        out = await _get(card_id, as_dict=True)
        out["auto_executed"] = True
        if isinstance(result, dict) and result.get("owner_notice") is not None:
            out["execution_notice"] = result["owner_notice"]
        return out
    except Exception as exc:  # noqa: BLE001 — the signature is committed; say what the execution did
        log.warning("Auto-execution after the Owner's signature failed for card %s: %s", card_id, exc)
        out = await _get(card_id, as_dict=True)
        out["auto_executed"] = False
        out["auto_execute_error"] = str(exc)
        return out


async def reject(card_id: str, actor: dict, reason: str) -> dict:
    """Reject at any stage before execution. Spec 5.5.5 / B-2.

    Who may: before verification, the owning team's admin, Finance or an
    Owner (the same people who could verify it); once verified or signed,
    only an Owner. A writing member of another department cannot refuse a
    card they could never have verified, and nobody below an Owner can undo
    an Owner's signature.
    """
    if not reason.strip():
        raise CardError("Rejection requires a reason.")

    card = await _get(card_id)
    if card["stage"] in (Stage.EXECUTED, Stage.REJECTED):
        raise CardError(f"Card is already {card['stage']}.")

    _assert_can_reject(card, actor)

    # UGP review: once an execution has started (`claim_execution`), money may
    # already have left the live balance — a debit is taken from Firestore
    # before the ledger is written. Rejecting it then would leave the money
    # gone, no ledger row and a card that says "rejected". The way forward is
    # to run the execution again: every step of it is idempotent on the card.
    if card["stage"] == Stage.APPROVED and card.get("execution_claimed_at"):
        raise CardError(
            "This card's execution has already started, so money may have moved. "
            "Run the execution again to finish it — it cannot be rejected now."
        )

    now = datetime.now(timezone.utc)
    # Conditional on the stage just read, and — for an approved card — on no
    # execution having started since: a reject racing an execution loses
    # instead of overwriting it.
    query: dict = {"_id": ObjectId(card_id), "stage": str(card["stage"])}
    if card["stage"] == Stage.APPROVED:
        query["execution_claimed_at"] = {"$exists": False}
    res = await get_db()[C.CARDS].update_one(
        query,
        {
            "$set": {
                "stage": str(Stage.REJECTED),
                "rejected_by": _who(actor),
                "rejected_at": now,
                "rejection_reason": reason.strip(),
                "updated_at": now,
            }
        },
    )
    if getattr(res, "matched_count", 1) != 1:
        raise CardError("The card changed while it was being rejected. Reload it and try again.")

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_REJECTED,
        subject_type="card",
        subject_id=card_id,
        reason=reason,
        before={"stage": card["stage"]},
        after={"stage": str(Stage.REJECTED)},
        card_id=card_id,
    )
    return await _get(card_id, as_dict=True)


async def claim_execution(card_id: str, actor: dict) -> None:
    """Mark an APPROVED card as being executed — the point of no return.

    UGP review. Called by an executor immediately BEFORE the first step that
    can move money it cannot take back by itself (a live-balance debit). From
    then on the card cannot be rejected (`reject` refuses), so a crash between
    the money moving and the card being closed can only end one way: the
    execution is run again, and every step of it is idempotent on the card.

    Idempotent: a retry of an interrupted execution finds the card still
    approved and claimed, keeps the first claim, and carries on. Refuses a card
    that is not approved — including one a reject got to first.

    B1 (M-12): every executor now claims — coin purchases, lending, repayments,
    recoveries, write-offs, commission and sub-agency payouts, expenses and
    capital, not only withdrawals and balance debits.
    """
    now = datetime.now(timezone.utc)
    oid = ObjectId(card_id)
    await get_db()[C.CARDS].update_one(
        {"_id": oid, "stage": str(Stage.APPROVED), "execution_claimed_at": {"$exists": False}},
        {"$set": {"execution_claimed_at": now, "execution_claimed_by": _who(actor), "updated_at": now}},
    )
    card = await _get(card_id)
    if card["stage"] != Stage.APPROVED or not card.get("execution_claimed_at"):
        raise CardError(f"Card is {card['stage']}, not approved for execution.")


async def mark_executed(
    card_id: str, actor: dict, result: dict, succeeded: bool
) -> dict:
    """Record what happened when the money actually moved. Spec 5.2.5 / 5.2.6."""
    card = await _get(card_id)
    if card["stage"] != Stage.APPROVED:
        raise CardError(f"Card is {card['stage']}, not approved for execution.")

    now = datetime.now(timezone.utc)
    stage = Stage.EXECUTED if succeeded else Stage.FAILED

    # Conditional on the card still being approved (UGP review): two
    # executions finishing at once, or an execution racing a reject, record
    # one outcome — the second finds the card already decided and says so.
    res = await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id), "stage": str(Stage.APPROVED)},
        {
            "$set": {
                "stage": str(stage),
                "executed_at": now if succeeded else None,
                "executed_by": _who(actor) if succeeded else None,
                "execution_result": result,
                "updated_at": now,
            }
        },
    )
    if getattr(res, "matched_count", 1) != 1:
        latest = await _get(card_id)
        raise CardError(f"Card is {latest['stage']}, not approved for execution.")

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_EXECUTED
        if succeeded
        else audit.Action.CARD_EXECUTION_FAILED,
        subject_type="card",
        subject_id=card_id,
        reason="Money moved" if succeeded else "Execution failed",
        before={"stage": str(Stage.APPROVED)},
        after={"stage": str(stage)},
        card_id=card_id,
        meta=result,
    )
    done = await _get(card_id, as_dict=True)
    if succeeded:
        done["owner_notice"] = await _notify_owners(done, actor, "card_executed")
    return done


#: The card types an Owner's signature executes at once (`AUTO_EXECUTE_ON_OWNER_SIGN`): coin and diamond
#: movements inside Zipper — a seller's purchased inventory, a loan and its repayment, recovery and write-off, and a
#: user's balance credit or debit. Never a payout (commission, host withdrawal, sub-agency, expense, capital).
AUTO_EXECUTE_TYPES: frozenset[str] = frozenset({
    str(CardType.SELLER_COIN_PURCHASE),
    str(CardType.LENDING_ISSUE),
    str(CardType.LENDING_REPAY),
    str(CardType.LENDING_RECOVER),
    str(CardType.BAD_DEBT_WRITE_OFF),
    str(CardType.BALANCE_CREDIT),
    str(CardType.BALANCE_DEBIT),
})


# ── Execution registry, for the owner fast path ───────────────────────────────
#
# Execution is type-specific (`partner_ops.execute_coin_purchase`,
# `users.execute_balance_card`, `expenses.execute_expense`, …) and those modules
# import this one, so the board cannot import them back. They register instead:
# one callable per type, `async (card_id, actor, *, payment_ref="") -> dict`.

Executor = Callable[..., Awaitable[dict]]
EXECUTORS: dict[str, Executor] = {}


def register_executor(card_type: CardType | str, fn: Executor) -> None:
    EXECUTORS[str(card_type)] = fn


async def owner_fast_path(
    card_id: str,
    actor: dict,
    *,
    verification_note: str,
    signature_note: str = "",
    execute: bool = False,
    payment_ref: str = "",
) -> dict:
    """§8 — one Owner takes a card from wherever it is to signed (and executed).

    **Every transition still happens, in order, with its own audit entry**:
    `requested → under_review` (`card.review_started`), `→ awaiting_signoff`
    (`card.verified`), `→ approved` (`card.signed`) and, when `execute` is
    asked for and the type has a registered executor, `→ executed`
    (`card.executed`, written by that executor). Nothing is skipped and
    nothing is written as one combined step; what this adds is one request
    and one entry (`card.owner_fast_path`) saying the sequence was run as a
    whole by one person.

    Each step is conditional on the stage it expects (B-6), so two Owners
    running this on the same card at once produce one sequence: the loser's
    first write misses and it is told what the card is now. A step that fails
    leaves the card exactly at the stage reached — visible on the board — and
    the error names it.

    Owner only. The other Owners are told by the signature and the execution
    exactly as they are when the steps are taken one at a time.
    """
    if not (OWNER_ALONE and R.is_owner_value(actor.get("role"))):
        raise CardError("Only a business owner may take a card through every stage alone.")
    if not str(verification_note or "").strip():
        raise CardError("Verification requires a note describing what was checked.")

    steps: list[dict] = []
    card = await _get(card_id)
    if card["stage"] in (Stage.EXECUTED, Stage.REJECTED, Stage.FAILED):
        raise CardError(f"Card is already {card['stage']}.")

    if card["stage"] == Stage.REQUESTED:
        await start_review(card_id, actor)
        steps.append({"stage": str(Stage.UNDER_REVIEW), "action": audit.Action.CARD_REVIEW_STARTED})
        card = await _get(card_id)
    if card["stage"] == Stage.UNDER_REVIEW:
        await verify(card_id, actor, verification_note)
        steps.append({"stage": str(Stage.AWAITING_SIGNOFF), "action": audit.Action.CARD_VERIFIED})
        card = await _get(card_id)
    auto_error: str | None = None
    sign_notice: dict | None = None
    if card["stage"] == Stage.AWAITING_SIGNOFF:
        signed = await sign(card_id, actor, signature_note)
        steps.append({"stage": str(Stage.APPROVED), "action": audit.Action.CARD_SIGNED})
        sign_notice = signed.get("owner_notice")
        if signed.get("auto_executed") is False:
            auto_error = str(signed.get("auto_execute_error") or "The execution after the signature did not go through.")
        card = await _get(card_id)

    executed: dict | None = None
    if card["stage"] == Stage.EXECUTED:
        # The Owner's signature already executed it (`AUTO_EXECUTE_ON_OWNER_SIGN`).
        steps.append({"stage": str(Stage.EXECUTED), "action": audit.Action.CARD_EXECUTED})
        executed = {"by_signature": True}
        execute = False
    elif auto_error is not None:
        # The signature already ran the execution and it was refused (a frozen account, a short balance). Running
        # it a second time a moment later would be refused for the same reason; the reason is reported instead.
        execute = False
    if execute:
        executor = EXECUTORS.get(str(card.get("type")))
        if executor is None:
            raise CardError(
                f"A {card.get('type')} card is executed from its own route; the fast path "
                "stopped at the signature. Execute it there."
            )
        executed = await executor(card_id, actor, payment_ref=payment_ref)
        steps.append({"stage": str(Stage.EXECUTED), "action": audit.Action.CARD_EXECUTED})

    await audit.record(
        actor=actor,
        action=audit.Action.CARD_OWNER_FAST_PATH,
        subject_type="card",
        subject_id=card_id,
        reason=verification_note.strip(),
        before={"stage": card["stage"] if not steps else str(steps[0]["stage"])},
        after={"stage": str(steps[-1]["stage"]) if steps else card["stage"]},
        card_id=card_id,
        meta={"steps": [s["action"] for s in steps], "executed": executed is not None,
              "amount": card.get("amount"), "currency": card.get("currency")},
    )
    out = await _get(card_id, as_dict=True)
    out["fast_path"] = {"steps": steps, "executed": executed}
    if sign_notice is not None:
        # Whether the other Owners were told of the signature — the board says so after a one-click approval.
        out["owner_notice"] = sign_notice
    if executed is not None:
        out["auto_executed"] = True
    if auto_error is not None:
        out["auto_executed"] = False
        out["auto_execute_error"] = auto_error
    return out


async def complete_if_owner(card: dict, actor: dict, note: str = "") -> dict:
    """Owner decision (5 Nov 2026): a card an Owner raises is done in the same step.

    Runs `owner_fast_path` for an Owner actor (every stage, each with its own audit entry; the other Owners told),
    executing it too when its type executes on signature. Anyone else's card is returned untouched and waits for an
    Owner as before. A refusal on the way (the self-dealing rule: an Owner does not sign a card that pays them) leaves
    the card at the stage it reached, on the board, and says why.
    """
    if not (OWNER_COMPLETES_OWN_CARDS and OWNER_ALONE and R.is_owner_value(actor.get("role"))):
        return card
    card_id = str(card.get("id") or card.get("_id") or "")
    if not card_id:
        return card
    if str(card.get("stage") or "") in (str(Stage.EXECUTED), str(Stage.REJECTED), str(Stage.FAILED)):
        # A replayed request answered with a card that is already finished: nothing left to do.
        return card
    note = (note or "").strip()
    try:
        done = await owner_fast_path(
            card_id, actor,
            verification_note=note if len(note) >= 3 else "Raised by an Owner and approved by them in the same step",
            signature_note=note,
            execute=str(card.get("type") or "") in AUTO_EXECUTE_TYPES,
        )
    except Exception as exc:  # noqa: BLE001 — the card was raised; say where it stopped and why
        if not isinstance(exc, CardError):
            log.warning("Owner completion of card %s stopped: %s", card_id, exc)
        done = await _get(card_id, as_dict=True)
        done["owner_complete_error"] = str(exc)
    # What the raising call added to its answer (a duplicate-reference warning, the outstanding debt) stays on it.
    for k, v in card.items():
        done.setdefault(k, v)
    return done


# ── Telling the other Owners ──────────────────────────────────────────────────


async def _notify_owners(card: dict, actor: dict, action: str) -> dict:
    """§8: push a card signature / execution to every other active Owner.

    Best effort and LAST: the stage and its audit entry are already committed.
    `owner_mail` records what it could not deliver and the sweep retries it;
    nothing here ever raises into the business action.
    """
    try:
        from app.services import owner_mail  # local: keeps the import graph acyclic

        return await owner_mail.notify_other_owners(
            actor=actor,
            action=action,
            reference=str(card.get("id") or card.get("_id") or ""),
            reference_type="card",
            amount=card.get("amount"),
            currency=str(card.get("currency") or ""),
            title=str(card.get("title") or card.get("type") or "card"),
            card_type=str(card.get("type") or ""),
            subject=card.get("subject") or {},
        )
    except Exception as exc:  # noqa: BLE001 — the signature stands
        log.exception("Owner notification for card %s (%s) failed", card.get("id"), action)
        return {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}


# ── Reading the board ─────────────────────────────────────────────────────────


async def board_for(user: dict, stage: Stage | None = None, limit: int = 100) -> list[dict]:
    """What this person should be looking at.

    An external partner is answered with the cards they raised themselves **and
    the cards raised about them**, and nothing else. It is a branch of its own,
    above the ones written for staff, rather than an accident of `team_of`
    returning None for an external role. Spec 5.2 / 4.3.6 — a seller who has
    paid us can see where the request got to, and `approved` is not `executed`.

    THE SUBJECT HALF, AND WHY IT IS NEW.
      This used to be `requested_by.uid == me` alone, on the reasoning that a
      lending, repayment, recovery or write-off card is raised by staff *about*
      a partner and reaches them through their statement once executed. That is
      true and it is not enough. A seller who has been lent inventory owes us
      coins from the moment the card is signed, and until it is executed there
      is nothing in their statement at all — so the one screen that could tell
      them a debt was being created showed them nothing. "Where has the
      repayment I sent got to" had no answer anywhere in the portal.

      So a partner now also sees a card whose **subject is them**. Three
      conditions, all of them, all in the query rather than in a screen:

        * `subject.id` is one of the partner ids on their own session. That is
          the partner record id — `request_lending` and every other raiser pass
          `subject_id=seller_id` / `agency_id` — read from the session by
          `_partner_ids`, never from the request.
        * `subject.type` says the subject IS a partner record. `balance_credit`
          carries a Firebase uid in the same field.
        * the card's type is on `PARTNER_SUBJECT_CARD_TYPES`, which is an
          allowlist. A staff-only type is not on it and a new type is not on it
          until somebody puts it there.

      What comes back still goes through `partner_view`, which is now doing more
      than narrowing duplicate references: a card staff raised names the staff
      who raised, verified and signed it, and that is not the partner's.
    """
    q: dict = {}
    role: Role = user["role"]

    if stage:
        q["stage"] = str(stage)

    if R.is_external(role):
        own = _partner_ids(user)
        mine: list[dict] = [{"requested_by.uid": user["uid"]}]
        if own:
            mine.append(
                {
                    "subject.id": {"$in": sorted(own)},
                    "subject.type": {"$in": sorted(PARTNER_SUBJECT_TYPES)},
                    "type": {"$in": sorted(PARTNER_SUBJECT_CARD_TYPES)},
                }
            )
        # `$or`, not two queries: an applicant under review holds no partner id
        # and is answered with their own cards exactly as before, and a partner
        # who raised a card that is also about them gets it once.
        q["$or"] = mine
        cursor = get_db()[C.CARDS].find(q).sort("created_at", -1).limit(min(limit, 500))
        return [
            partner_view(_public(doc), own, user.get("uid", ""))
            async for doc in cursor
        ]

    if R.can_read_all(role):
        pass  # owners and observer see every team
    elif R.is_team_admin(role):
        q["team"] = str(R.team_of(role))
    else:
        q["$or"] = [
            {"requested_by.uid": user["uid"]},
            {"team": str(R.team_of(role))} if R.team_of(role) else {"_id": None},
        ]

    cursor = get_db()[C.CARDS].find(q).sort("created_at", -1).limit(min(limit, 500))
    return [_public(doc) async for doc in cursor]


def _partner_ids(user: dict) -> set[str]:
    """Every partner record this session holds, from the session and nowhere else.

    The same thing `deps.partner_ids_of` reads, restated here rather than
    imported: `app.core.deps` imports FastAPI and this module is service code
    that a job or a script calls with no request in sight.
    """
    return {
        str(v)
        for v in dict(user.get("partner_ids") or {}).values()
        if str(v or "").strip()
    }


def _their_side(who: object, own_uid: str) -> dict | None:
    """One `requested_by` / `verified_by` / `signed_by` / `rejected_by` block as
    a partner may read it.

    The caller's own block is returned untouched — it is them. Anybody else's
    becomes `ZIPPER`: the *fact* survives, so "verified" is still visibly
    verified and the timestamp beside it still stands, and the named employee,
    their uid, their role and their team do not travel to an outside business.
    `None` stays `None`, because "not verified yet" and "verified by somebody"
    are different states and flattening them would be a lie about the card.
    """
    if not isinstance(who, dict):
        return None
    if own_uid and str(who.get("uid") or "") == own_uid:
        return who
    return dict(ZIPPER)


def partner_view(card: dict, own_ids: set[str], own_uid: str = "") -> dict:
    """A card as the partner it belongs to may read it.

    `board_for` answers an external session with the cards they raised **and the
    cards raised about them**, and the POST that creates one returns the caller
    their own. Everything that reaches a partner goes through here.

    THREE THINGS ARE NARROWED, AND EACH FOR ITS OWN REASON.

    1. **The duplicate-payment-reference evidence.**
       `find_duplicate_payment_refs` searches **every card in the business** for
       the same UTR and writes the result into the payload so an owner sees the
       collision before signing (spec 5.3 / 8C.2.5). Handed back unfiltered to
       the seller who typed the reference, that turns
       `POST /partner-ops/sellers/{id}/coin-purchases` into an oracle: submit
       somebody else's reference and read their partner id, the amount and the
       stage straight out of `payload.duplicate_of` — on the response, and again
       every time they list the board.

       So it is narrowed to the caller's own records, and the flag and the
       warning are recomputed from what survives. A seller re-submitting a
       reference they have used before still sees their own earlier card, which
       is the useful half. A seller probing a stranger's reference sees an empty
       list, no flag and no warning — which is also the true answer to "which of
       my cards already carries this reference".

    2. **Who did it.** New, and necessary the moment a partner can see a card
       *staff* raised. A lending card names the team member who raised it, the
       admin who verified it and the owner who signed it — three named
       employees, their uids, their roles and their teams, on a document handed
       to an outside business. The partner is entitled to the state of their own
       money, not to the staff directory, so every block that is not the
       caller's own becomes `ZIPPER`.

    3. **The internal notes.** `verification_note` is what the verifier checked
       and `signature_note` is what the owner said while signing; both are
       written for colleagues and neither is written to be read by the subject.
       They are dropped. `reason` and `rejection_reason` are **kept** — a
       partner told their card was refused and not told why is exactly the
       failure `reject_partner` exists to fix.

    **Nothing is redacted for an internal caller.** The owner's view of a
    collision, which is the fraud control, and the verifier's name, which is the
    separation of duties, are both untouched: this function is called only where
    the reader is external.
    """
    card = dict(card)

    # ── 1. The duplicate evidence ────────────────────────────────────────────
    payload = card.get("payload")
    if isinstance(payload, dict) and "duplicate_of" in payload:
        raw = payload.get("duplicate_of")
        mine = [
            entry
            for entry in (raw if isinstance(raw, list) else [])
            if isinstance(entry, dict) and str(entry.get("subject_id") or "") in own_ids
        ]
        card["payload"] = {
            **payload,
            "duplicate_of": mine,
            "duplicate_reference": bool(mine),
        }
        # The warning counts the collisions, so it is rewritten from what is
        # left rather than kept — a count of six over a list of one is the leak
        # again, in a sentence.
        card.pop("warning", None)
        if mine:
            ref = str(payload.get("payment_ref") or "")
            card["warning"] = (
                f"Payment reference {ref} is already on "
                f"{len(mine)} earlier card(s) of yours. Confirm this is a separate "
                "payment."
            )

    # ── 2. Who did it ────────────────────────────────────────────────────────
    for field in ("requested_by", "review_started_by", "verified_by", "signed_by",
                  "rejected_by", "executed_by", "execution_claimed_by"):
        if field in card:
            card[field] = _their_side(card.get(field), own_uid)

    # ── 3. The internal notes ────────────────────────────────────────────────
    for field in ("verification_note", "signature_note"):
        if field in card:
            card[field] = None
    # The hold marker names the staff member who placed it; a partner is told
    # that the item is held, not by whom.
    held = card.get("held")
    if isinstance(held, dict):
        card["held"] = {k: v for k, v in held.items() if k not in ("by", "released_by")}

    return card


async def awaiting_my_signature(user: dict, limit: int = 200) -> list[dict]:
    """An owner's queue — verified cards they are allowed to sign.

    Under the owner-alone decision an owner's own requests are in it too (they
    may sign them); with the decision off they are excluded (5.5.3). A card
    whose subject is the owner is never listed: nobody signs the card that
    pays them.
    """
    if not R.can_sign_money(user["role"]):
        return []

    q: dict = {"stage": str(Stage.AWAITING_SIGNOFF)}
    if not OWNER_ALONE:
        q["requested_by.uid"] = {"$ne": user["uid"]}
    if SELF_SUBJECT_NEEDS_ANOTHER_OWNER:
        q["subject.id"] = {"$ne": user["uid"]}
    cursor = (
        get_db()[C.CARDS]
        .find(q)
        .sort("created_at", 1)  # oldest first — the queue should drain
        .limit(min(limit, 500))
    )
    return [_public(doc) async for doc in cursor]


async def waiting_on_me(user: dict) -> dict:
    """The inbox. Spec 7.3."""
    role: Role = user["role"]
    db = get_db()

    counts = {"to_verify": 0, "to_sign": 0, "mine_pending": 0}

    if R.can_sign_money(role):
        q: dict = {"stage": str(Stage.AWAITING_SIGNOFF)}
        if not OWNER_ALONE:
            q["requested_by.uid"] = {"$ne": user["uid"]}
        if SELF_SUBJECT_NEEDS_ANOTHER_OWNER:
            q["subject.id"] = {"$ne": user["uid"]}
        counts["to_sign"] = await db[C.CARDS].count_documents(q)

    if R.is_team_admin(role) or role == Role.FINANCE_ADMIN:
        vq: dict = {"stage": {"$in": [str(Stage.REQUESTED), str(Stage.UNDER_REVIEW)]}}
        if role != Role.FINANCE_ADMIN:
            vq["team"] = str(R.team_of(role))
        counts["to_verify"] = await db[C.CARDS].count_documents(vq)

    counts["mine_pending"] = await db[C.CARDS].count_documents(
        {
            "requested_by.uid": user["uid"],
            "stage": {
                "$in": [
                    str(Stage.REQUESTED),
                    str(Stage.UNDER_REVIEW),
                    str(Stage.AWAITING_SIGNOFF),
                ]
            },
        }
    )
    counts["total"] = counts["to_verify"] + counts["to_sign"]
    return counts


# ── Internals ─────────────────────────────────────────────────────────────────


def _who(actor: dict) -> dict:
    return {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
        "team": str(actor["team"]) if actor.get("team") else None,
    }


def _assert_can_verify(card: dict, actor: dict) -> None:
    role: Role = actor["role"]

    # 5.5.1 / 5.5.2 — nobody verifies their own request. §8 lifts this for an
    # Owner and for nobody else: a Finance admin who raised a card still hands
    # it to another admin.
    owner_alone = OWNER_ALONE and R.is_owner_value(actor.get("role"))
    if card["requested_by"]["uid"] == actor["uid"] and not owner_alone:
        raise CardError(
            "You raised this card. Someone else must verify it."
        )

    card_team = Team(card["team"]) if card.get("team") else None
    if not R.can_verify_money(role, card_team):
        raise CardError(
            "Verification is done by the owning team's admin, or by Finance."
        )


def _assert_can_reject(card: dict, actor: dict) -> None:
    """B-2 — who may refuse a card, by stage."""
    role = actor["role"]
    if R.can_sign_money(role):
        return
    stage = str(card.get("stage") or "")
    if stage in (str(Stage.REQUESTED), str(Stage.UNDER_REVIEW)):
        card_team = Team(card["team"]) if card.get("team") else None
        if R.can_verify_money(role, card_team):
            return
        raise CardError(
            "Only the owning team's admin, Finance or an owner can reject a card."
        )
    raise CardError("Only an owner can reject a card that has been verified or signed.")


async def _get(card_id: str, as_dict: bool = False) -> dict:
    try:
        oid = ObjectId(card_id)
    except Exception as exc:  # noqa: BLE001
        raise CardError("Card not found.") from exc

    doc = await get_db()[C.CARDS].find_one({"_id": oid})
    if doc is None:
        raise CardError("Card not found.")
    return _public(doc) if as_dict else doc


def _public(doc: dict) -> dict:
    doc = dict(doc)
    doc["id"] = str(doc.pop("_id"))
    return doc
