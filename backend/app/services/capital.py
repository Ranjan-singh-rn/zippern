"""The owners' capital account — money in from their own pocket, and back out.

WHY THIS EXISTS SEPARATELY FROM EVERYTHING ELSE
-----------------------------------------------
A business is funded before it earns. The owners put their own money in to buy
the first inventory, pay the first bills and cover the gap until coin sellers
start paying. Later, when it is running, they take that money back out.

Both movements are real cash and both must be visible. **Neither is profit.**

  * Money an owner puts in lands in the bank exactly as a coin seller's payment
    does. But the seller bought something and the owner did not — they are owed
    it back. Counted as revenue, a company funding itself reads as a company
    earning, and the margin is whatever the owners happened to deposit.
  * Taking it back out is the repayment of that debt, not a cost of trading.
    Counted as an expense, a repaid loan reads as a loss and the business looks
    like it is bleeding money in the very month it finally afforded to pay its
    founders back.

So there are three kinds of money here, not two:

  ┌─ trading ──────────────────────────────────────────────────────────────┐
  │ revenue   cash in from sellers and users        → profit               │
  │ costs     payouts, commission, salaries, tax    → profit               │
  ├─ capital ──────────────────────────────────────────────────────────────┤
  │ capital in    an owner funds the business       → NOT profit, cash up  │
  │ drawings out  an owner takes it back            → NOT profit, cash down│
  └────────────────────────────────────────────────────────────────────────┘

The first two decide whether the business works. The third decides who owns
what. A shop's books have kept them apart for a very long time, and the reason
is that mixing them makes both numbers meaningless.

HOW IT WORKS HERE
-----------------
Both movements are cards on the same money board as everything else, with the
same five stages and the same separation of duties. An owner putting money in
still cannot sign their own card — the other owner does. That is not ceremony:
"how much did I put in" is a question three partners will one day disagree
about, and the answer needs two names on it.

`contribution_of()` reports, per owner, what they have put in, taken back, and
are still owed. That figure is a liability of the business, not equity it can
spend.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from app.core import audit as audit_log
from app.core.roles import Team
from app.db.mongo import C, get_db
from app.services import cards as card_svc
from app.services.cards import CardType, NewCard, Stage

CURRENCY = "INR"

#: What a capital movement may be recorded against. Kept deliberately short —
#: this is not a second expense taxonomy, it is the two directions money moves
#: between the business and the people who own it.
DIRECTIONS = ("in", "out")

LABELS = {
    CardType.OWNER_CAPITAL_IN: "Capital introduced",
    CardType.OWNER_DRAWINGS: "Drawings",
}


class CapitalError(Exception):
    """A capital movement that must not be recorded."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _minor(value: Any, what: str) -> int:
    """Rupees in paise, as an integer, or a refusal.

    A float is refused rather than rounded. `12345.6` paise is not a quantity of
    money and silently turning it into `12346` invents six paise that nobody
    decided on — small here, and the same reasoning that keeps the whole ledger
    in integers.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise CapitalError(
            f"{what} must be a whole number of paise. ₹1,000 is 100000."
        )
    if value <= 0:
        raise CapitalError(f"{what} must be more than zero.")
    return value


async def record(
    *,
    direction: str,
    owner_uid: str,
    owner_name: str,
    amount_minor: int,
    method: str,
    reference: str,
    reason: str,
    actor: Mapping,
) -> dict:
    """Raise a capital card. **Moves nothing** — an owner signs, then executes.

    `reference` is the bank reference for the transfer. It is required in both
    directions for the same reason a payout needs one: a movement between the
    business and an owner that cannot be matched against a bank statement is
    exactly the movement that should be easiest to prove.
    """
    if direction not in DIRECTIONS:
        raise CapitalError(f"Direction must be one of {', '.join(DIRECTIONS)}.")
    if not str(owner_uid or "").strip():
        raise CapitalError("Say which owner this is for.")
    amount_minor = _minor(amount_minor, "Amount")

    ref = str(reference or "").strip()
    if not ref:
        raise CapitalError(
            "A bank reference (UTR, transaction id) is required. A movement "
            "between the business and an owner has to be provable against a "
            "statement, in both directions."
        )
    if len(str(reason or "").strip()) < 3:
        raise CapitalError("Give a reason of at least 3 characters.")

    card_type = (
        CardType.OWNER_CAPITAL_IN if direction == "in" else CardType.OWNER_DRAWINGS
    )

    who = str(owner_name or owner_uid)
    return await card_svc.raise_card(
        NewCard(
            type=card_type,
            team=Team.FINANCE,
            title=f"{LABELS[card_type]} — {who} — ₹{amount_minor / 100:,.2f}",
            amount=amount_minor,
            currency=CURRENCY,
            reason=str(reason).strip(),
            subject_type="owner",
            subject_id=str(owner_uid),
            payload={
                "direction": direction,
                "owner_uid": str(owner_uid),
                "owner_name": str(owner_name or ""),
                "amount_minor": amount_minor,
                "method": str(method or "bank").strip(),
                "reference": ref,
                # Stated on the card so no reader has to infer it. This is the
                # single most important fact about a capital movement and the
                # one a report must not get wrong.
                "excluded_from_profit": True,
                "basis": "cash",
            },
            evidence=[{"kind": "transfer", "ref": ref, "url": ""}],
            # Never auto-verified. Money moving between the business and the
            # people who own it is precisely the movement that needs a second
            # person, whichever direction it goes.
            auto_verified=False,
        ),
        dict(actor),
    )


async def mark_settled(card_id: str, actor: Mapping) -> dict:
    """The transfer happened. Owner only — this is the money actually moving.

    There is no balance to update and no ledger row to write: the business's
    cash position is derived from executed cards, so executing *is* the record.
    What this adds is the audit entry and the timestamp the capital account is
    then computed over.
    """
    card = await card_svc._get(card_id, as_dict=True)
    if card is None:
        raise CapitalError("No such card.")
    if str(card.get("type")) not in {
        str(CardType.OWNER_CAPITAL_IN),
        str(CardType.OWNER_DRAWINGS),
    }:
        raise CapitalError("That card is not a capital movement.")
    if str(card.get("stage")) != str(Stage.APPROVED):
        raise CapitalError(
            f"This card is {card.get('stage')}, not approved. An owner has to "
            "sign it before the money moves."
        )

    out = await card_svc.mark_executed(
        card_id,
        dict(actor),
        result={"settled_at": _now().isoformat()},
        succeeded=True,
    )
    payload = card.get("payload") or {}
    await audit_log.record(
        actor=dict(actor),
        action=audit_log.Action.CARD_EXECUTED,
        subject_type="owner_capital",
        subject_id=str(payload.get("owner_uid") or ""),
        reason=str(card.get("reason") or ""),
        meta={
            "direction": payload.get("direction"),
            "amount_minor": payload.get("amount_minor"),
            "reference": payload.get("reference"),
            "card_id": card_id,
        },
    )
    return out


async def contribution_of(owner_uid: str | None = None) -> list[dict]:
    """What each owner has put in, taken back, and is still owed.

    Executed cards only. A signed capital card whose transfer has not happened
    is not money the business holds, and reporting it as such would overstate
    both the cash and the debt.

    `outstanding` is what the business owes that owner. It is a **liability**,
    not a pot to spend: a positive figure means they have funded the company by
    that much and have not been repaid.
    """
    db = get_db()
    query: dict = {
        "type": {
            "$in": [str(CardType.OWNER_CAPITAL_IN), str(CardType.OWNER_DRAWINGS)]
        },
        "stage": str(Stage.EXECUTED),
    }
    if owner_uid:
        query["payload.owner_uid"] = str(owner_uid)

    by_owner: dict[str, dict] = {}
    async for card in db[C.CARDS].find(query).sort("executed_at", 1):
        payload = card.get("payload") or {}
        uid = str(payload.get("owner_uid") or "")
        if not uid:
            continue
        row = by_owner.setdefault(
            uid,
            {
                "owner_uid": uid,
                "owner_name": str(payload.get("owner_name") or ""),
                "introduced_minor": 0,
                "drawn_minor": 0,
                "outstanding_minor": 0,
                "movements": [],
            },
        )
        amount = int(payload.get("amount_minor") or 0)
        inbound = str(card.get("type")) == str(CardType.OWNER_CAPITAL_IN)
        if inbound:
            row["introduced_minor"] += amount
        else:
            row["drawn_minor"] += amount
        row["movements"].append(
            {
                "card_id": str(card.get("_id")),
                "direction": "in" if inbound else "out",
                "amount_minor": amount,
                "reference": str(payload.get("reference") or ""),
                "method": str(payload.get("method") or ""),
                "reason": str(card.get("reason") or ""),
                "executed_at": card.get("executed_at"),
            }
        )

    for row in by_owner.values():
        row["outstanding_minor"] = row["introduced_minor"] - row["drawn_minor"]
        row["owner_name"] = row["owner_name"] or row["owner_uid"]

    return sorted(by_owner.values(), key=lambda r: -r["outstanding_minor"])


async def totals() -> dict:
    """The capital account in one line, for the P&L to declare and exclude."""
    rows = await contribution_of()
    introduced = sum(r["introduced_minor"] for r in rows)
    drawn = sum(r["drawn_minor"] for r in rows)
    return {
        "owners": len(rows),
        "introduced_minor": introduced,
        "drawn_minor": drawn,
        "outstanding_minor": introduced - drawn,
        "note": (
            "Capital introduced by the owners and drawings taken back out. "
            "Both are cash movements and neither is trading: they are excluded "
            "from revenue, from expenditure and from profit. `outstanding` is "
            "what the business still owes its owners."
        ),
    }
