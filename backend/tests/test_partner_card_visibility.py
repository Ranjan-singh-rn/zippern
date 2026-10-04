"""What a partner can see on the money board, and what still stops there.

`services/cards.board_for` used to answer an external session with
`requested_by.uid == me` and nothing else. A seller therefore saw the purchase
cards they raised and **nothing about lending, repayment, recovery or
write-off** — the cards staff raise about them. A seller who had been lent
inventory owed us coins from the moment the card was signed and had no view of
the debt's card at all, only a ledger line that appears once it is executed.

So a partner now also sees a card whose **subject is them**. That is a widening,
and a widening on a route an outside business can reach is only as good as what
holds it in place, so these tests are about the edges rather than the happy
path:

  * a seller sees a lending, repayment, recovery and write-off card raised about
    them by staff — and the ledger line is not the only evidence any more;
  * a seller sees none of another partner's cards, whoever raised them and
    whatever type they are;
  * a staff-only card type is invisible even when its subject id happens to
    match, and a `balance_credit` card — which carries a Firebase uid in the
    same `subject.id` field — is invisible for two reasons rather than one;
  * everything that reaches a partner has the staff who raised, verified and
    signed it replaced by "Zipper", the internal notes dropped, and the
    duplicate-payment-reference evidence narrowed exactly as before;
  * and none of the three internal branches of `board_for` moved.

The scope is read from the **session**, never from the request. `subject.id` is
the partner record id — confirmed here against `services/partner_ops.py` by
raising the cards through the real `request_lending` / `request_repayment` /
`request_recovery` / `write_off_debt` rather than by writing card documents by
hand, so if any of them ever stopped putting the partner id there this test
fails rather than passing against a shape invented in it.

Run:  python3 -m tests.test_partner_card_visibility
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services.cards import CardType, NewCard  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def run(coro):
    return asyncio.run(coro)


# ── The world ─────────────────────────────────────────────────────────────────

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)
DUE = NOW + timedelta(days=30)


def partner(pid: str, kind: str, **extra) -> dict:
    return {
        "_id": pid,
        "kind": kind,
        "name": f"{pid} Ltd",
        "status": "approved",
        "is_active": True,
        "credit": {"outstanding": 0, "due_at": None, "history": []},
        "cash_paid_minor": 0,
        "total_coins_sold": 0,
        "created_at": NOW,
        **extra,
    }


db = FakeDb()
db.seed(
    C.PARTNERS,
    [
        partner("seller-mine", "seller"),
        partner("seller-theirs", "seller"),
        partner("agency-mine", "sub_agency", parent_id="agency-parent"),
        partner("agency-parent", "agency"),
    ],
)

for _mod in (audit_mod, cards_svc, money_mod, ops, partner_svc):
    _mod.get_db = lambda _db=db: _db

# `cards.verify` / `sign` look a card up by `ObjectId(card_id)`, so the fake
# collection has to mint ids that really are ObjectIds. The harness's default
# `cards-0000000000000001` is 22 characters and the real `bson.ObjectId` — and
# the harness's stand-in — refuse it.
_card_seq = iter(range(1, 10_000))
db[C.CARDS]._next_id = lambda: f"{next(_card_seq):024x}"

ops._sync_partner_doc = lambda partner, fields: True


def session(uid: str, role: Role, ids: dict) -> dict:
    """An external session, exactly as `verify_session` builds one."""
    return {"uid": uid, "name": uid, "role": role, "team": None, "partner_ids": ids}


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team, "partner_ids": {}}


SELLER = session("uid-seller", Role.SELLER, {"seller": "seller-mine"})
OTHER = session("uid-other", Role.SELLER, {"seller": "seller-theirs"})
SUB = session("uid-sub", Role.AGENCY, {"agency": "agency-mine"})
APPLICANT = session("uid-applicant", Role.SELLER, {})

STAFF = internal("uid-finance", Role.FINANCE_ADMIN, Team.FINANCE)
OWNER = internal("uid-owner", Role.OWNER)
MEMBER = internal("uid-member", Role.FINANCE_MEMBER, Team.FINANCE)


def board(user: dict) -> list[dict]:
    return run(cards_svc.board_for(user))


def ids_on(user: dict) -> set[str]:
    return {c["id"] for c in board(user)}


# ══════════════════════════════════════════════════════════════════════════════
# 1. The cards staff raise about a seller — the gap this closes
# ══════════════════════════════════════════════════════════════════════════════
#
# Raised through the real service functions, so `subject.id` is whatever
# `partner_ops` actually writes rather than whatever this file assumed.

lend = run(
    ops.request_lending(
        "seller-mine", 50_000, DUE, "Repay within 30 days.",
        "Seller is trading well and asked for stock on credit.", STAFF,
    )
)
check("a lending card's subject IS the partner id", lend["subject"]["id"], "seller-mine")
check("…and its subject type says so", lend["subject"]["type"], "seller")

# Give the seller a debt so the three cards that need one can be raised.
run(
    db[C.PARTNERS].update_one(
        {"_id": "seller-mine"}, {"$set": {"credit.outstanding": 50_000}}
    )
)

repay = run(
    ops.request_repayment(
        "seller-mine", 20_000, "UTR-REPAY-1", "Seller paid ₹500 against the debt.", STAFF
    )
)
recover = run(
    ops.request_recovery(
        "seller-mine", 10_000, 1_000, "Debt is past due; recovering from stock.", STAFF
    )
)
write_off = run(
    ops.write_off_debt(
        "seller-mine", 5_000, "Unrecoverable after three attempts; booking the loss.", STAFF
    )
)
staff_purchase = run(
    ops.request_coin_purchase(
        "seller-mine", 1_000, 250_000, "UTR-STAFF-1", "", STAFF,
        "Payment arrived by bank transfer; raising on the seller's behalf.",
    )
)
own_purchase = run(
    ops.request_coin_purchase(
        "seller-mine", 500, 125_000, "UTR-OWN-1", "", SELLER,
        "Paid ₹1,250 for 500 coins.",
    )
)

mine = board(SELLER)
seen = {c["id"] for c in mine}

for label, card in (
    ("credit issued to them", lend),
    ("their repayment", repay),
    ("a recovery from their stock", recover),
    ("a debt written off against them", write_off),
    ("a purchase staff raised on their behalf", staff_purchase),
    ("the purchase they raised themselves", own_purchase),
):
    ok(f"a seller sees {label}", card["id"] in seen)

check("and sees exactly those six", len(mine), 6)
ok(
    "every card on their board is about them or raised by them",
    all(
        c["subject"]["id"] == "seller-mine"
        or (c["requested_by"] or {}).get("uid") == "uid-seller"
        for c in mine
    ),
)

# The point of it: the debt's card is readable before it is executed, which is
# the window in which the ledger says nothing at all.
lend_seen = [c for c in mine if c["id"] == lend["id"]][0]
check("…and the lending card is readable at 'requested'", lend_seen["stage"], "requested")
check("…carrying the amount", lend_seen["amount"], 50_000)
check("…and the reason it was raised with", lend_seen["reason"], lend["reason"])


# ══════════════════════════════════════════════════════════════════════════════
# 2. Never another partner's card
# ══════════════════════════════════════════════════════════════════════════════

run(db[C.PARTNERS].update_one({"_id": "seller-theirs"}, {"$set": {"credit.outstanding": 90_000}}))
their_lend = run(
    ops.request_lending(
        "seller-theirs", 90_000, DUE, "", "Stock on credit for the other seller.", STAFF
    )
)
their_recover = run(
    ops.request_recovery("seller-theirs", 9_000, 0, "Recovering the other seller's debt.", STAFF)
)
their_purchase = run(
    ops.request_coin_purchase(
        "seller-theirs", 2_000, 500_000, "UTR-THEIRS-1", "", OTHER, "Their own purchase."
    )
)

mine = ids_on(SELLER)
for label, card in (
    ("another seller's lending card", their_lend),
    ("another seller's recovery card", their_recover),
    ("another seller's own purchase card", their_purchase),
):
    ok(f"a seller never sees {label}", card["id"] not in mine)

theirs = ids_on(OTHER)
ok("…and it works in both directions", lend["id"] not in theirs)
ok("…including the cards each raised themselves", own_purchase["id"] not in theirs)
check("the other seller sees only their own three", len(theirs), 3)

# An agency is not a seller, and a seller is not an agency.
ok("a seller sees no agency's cards", not (ids_on(SELLER) & ids_on(SUB)))

# An applicant under review holds no partner id at all. The subject clause must
# not degenerate into "every card whose subject is missing" for them.
check("an applicant with no partner id sees nothing", board(APPLICANT), [])


# ══════════════════════════════════════════════════════════════════════════════
# 3. A staff-only card type is invisible even when the subject matches
# ══════════════════════════════════════════════════════════════════════════════
#
# Two independent reasons hold each of these out: the type is not on
# `PARTNER_SUBJECT_CARD_TYPES`, and for the user-account ones the subject type
# is not a partner record either. Both are asserted, because relying on one of
# them would be relying on two id spaces never colliding.


async def raise_raw(card_type: CardType, subject_type: str, subject_id: str) -> dict:
    return await cards_svc.raise_card(
        NewCard(
            type=card_type,
            team=Team.FINANCE,
            title=f"{card_type} — staff only",
            amount=100_000,
            currency="inr",
            reason="Raised by staff; not a partner's to read.",
            subject_type=subject_type,
            subject_id=subject_id,
            payload={"category": "staff_salaries", "note": "internal"},
        ),
        STAFF,
    )


STAFF_ONLY = [
    (CardType.BALANCE_CREDIT, "user", "seller-mine"),
    (CardType.BALANCE_DEBIT, "user", "seller-mine"),
    (CardType.OPERATING_EXPENSE, "expense", "2026-08:staff_salaries"),
    (CardType.SALARY_REQUEST, "seller", "seller-mine"),
    (CardType.WEEKLY_PAYOUT, "seller", "seller-mine"),
    (CardType.RATE_CHANGE, "seller", "seller-mine"),
    (CardType.PRICING_CHANGE, "seller", "seller-mine"),
    (CardType.FX_OVERRIDE, "seller", "seller-mine"),
    (CardType.PROMOTION, "seller", "seller-mine"),
    (CardType.REFUND, "seller", "seller-mine"),
    (CardType.HOST_WITHDRAWAL, "seller", "seller-mine"),
]

hidden: list[str] = []
for card_type, subject_type, subject_id in STAFF_ONLY:
    raw = run(raise_raw(card_type, subject_type, subject_id))
    hidden.append(raw["id"])
    ok(
        f"{card_type} is not on the partner allowlist",
        str(card_type) not in cards_svc.PARTNER_SUBJECT_CARD_TYPES,
    )

mine = ids_on(SELLER)
for card_type, card_id in zip((c[0] for c in STAFF_ONLY), hidden):
    ok(f"a seller cannot see a {card_type} card aimed at their own id", card_id not in mine)

check(
    "the seller's board is still the same six",
    len(board(SELLER)),
    6,
)

# The property, rather than the eleven cases above: EVERY type in the enum that
# is not on the allowlist is invisible, even raised with `subject_type: seller`
# and this seller's own id — which is the most favourable shape an attacker or a
# careless new raiser could give it. A card type added to `CardType` tomorrow is
# covered by this loop on the next run, without anybody remembering to add it.
for card_type in CardType:
    if str(card_type) in cards_svc.PARTNER_SUBJECT_CARD_TYPES:
        continue
    raw = run(raise_raw(card_type, "seller", "seller-mine"))
    ok(
        f"{card_type} is invisible to the partner it names",
        raw["id"] not in ids_on(SELLER),
    )

check(
    "and the allowlist is exactly the partner-money types",
    sorted(cards_svc.PARTNER_SUBJECT_CARD_TYPES),
    [
        "bad_debt_write_off",
        "commission_payout",
        "lending_issue",
        "lending_recover",
        "lending_repay",
        "lending_write_off",
        "seller_coin_purchase",
        "subagency_payout",
    ],
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Nothing newly visible names a member of staff
# ══════════════════════════════════════════════════════════════════════════════
#
# A card staff raised carries three named employees by the time it is signed.
# The partner is entitled to the state of their own money, not to the directory.

run(cards_svc.verify(lend["id"], internal("uid-admin", Role.FINANCE_ADMIN, Team.FINANCE),
                     "Checked the seller's standing and the due date."))
run(cards_svc.sign(lend["id"], OWNER, "Approved — terms are as agreed."))

signed = [c for c in board(SELLER) if c["id"] == lend["id"]][0]

check("the raiser becomes Zipper", signed["requested_by"], dict(cards_svc.ZIPPER))
check("the verifier becomes Zipper", signed["verified_by"], dict(cards_svc.ZIPPER))
check("the signer becomes Zipper", signed["signed_by"], dict(cards_svc.ZIPPER))
check("and a stage nobody has reached stays null", signed["rejected_by"], None)
check("the verification note is dropped", signed["verification_note"], None)
check("the signature note is dropped", signed["signature_note"], None)

# The facts survive — the partner must still be able to see that their card is
# signed and when, which is the whole point of being able to read it.
check("…while the stage is intact", signed["stage"], "approved")
ok("…and the verification timestamp is intact", signed["verified_at"] is not None)
ok("…and the signature timestamp is intact", signed["signed_at"] is not None)

blob = repr(board(SELLER))
for leaked in ("uid-finance", "uid-admin", "uid-owner", "finance_admin", "Checked the seller"):
    ok(f"no staff detail reaches the partner: {leaked}", leaked not in blob)
ok("…and their own uid still does, on their own card", "uid-seller" in blob)

# The people who verify and sign are unchanged for everyone internal — that is
# the separation of duties and it is not redacted from anybody.
staff_view = [c for c in board(STAFF) if c["id"] == lend["id"]][0]
check("staff still see who verified", staff_view["verified_by"]["uid"], "uid-admin")
check("…and who signed", staff_view["signed_by"]["uid"], "uid-owner")
ok("…and the verification note", "Checked the seller" in staff_view["verification_note"])


# ══════════════════════════════════════════════════════════════════════════════
# 5. The duplicate-reference narrowing still holds on everything
# ══════════════════════════════════════════════════════════════════════════════
#
# It used to run on cards a partner raised. It must now also run on the cards
# raised ABOUT them — a repayment card carries a payment reference too, and
# `find_duplicate_payment_refs` searches every card in the business for it.

run(
    ops.request_coin_purchase(
        "seller-theirs", 100, 25_000, "UTR-SHARED", "", OTHER, "Their purchase."
    )
)
shared = run(
    ops.request_repayment(
        "seller-mine", 1_000, "UTR-SHARED", "Repayment against the same reference.", STAFF
    )
)
ok(
    "the staff view of the collision is intact — that is the fraud control",
    any(d["subject_id"] == "seller-theirs" for d in shared["payload"]["duplicate_of"]),
)

seller_view = [c for c in board(SELLER) if c["id"] == shared["id"]][0]
check(
    "…and the partner's copy of that same card names nobody else",
    seller_view["payload"]["duplicate_of"],
    [],
)
check("…nor even that it collided", seller_view["payload"]["duplicate_reference"], False)
ok("…and carries no warning counting other people's cards", "warning" not in seller_view)


# ══════════════════════════════════════════════════════════════════════════════
# 6. A sub-agency, and the internal branches
# ══════════════════════════════════════════════════════════════════════════════

sub_payout = run(
    cards_svc.raise_card(
        NewCard(
            type=CardType.SUBAGENCY_PAYOUT,
            team=Team.FINANCE,
            title="Sub-agency payout — 5,000.00 via agency-parent Ltd",
            amount=500_000,
            currency="commission",
            reason="Weekly commission, routed through the parent.",
            subject_type="agency",
            subject_id="agency-mine",
            payload={"parent_id": "agency-parent", "sub_id": "agency-mine"},
        ),
        STAFF,
    )
)
sub_board = board(SUB)
check("a sub-agency sees the payout it is the subject of", len(sub_board), 1)
check("…which is that one", sub_board[0]["id"], sub_payout["id"])
ok("…and a seller does not", sub_payout["id"] not in ids_on(SELLER))

# None of the three internal branches moved. The member one matters most: it
# reads `$or` on the caller's team, and collapsing it to `requested_by.uid` —
# which is what the external branch does for its first clause — would blind
# every staff member to their own team's board.
every = len(db[C.CARDS].docs)
check("an owner still sees every card in the business", len(board(OWNER)), every)
check("a team admin still sees their team's board", len(board(STAFF)), every)
check(
    "a team member still sees their team's board though they raised none of it",
    len(board(MEMBER)),
    every,
)
ok("…and the board really is bigger than any partner's view of it", every > len(board(SELLER)))


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} partner-card-visibility checks passed.")
print("  · a seller sees the lending, repayment, recovery and write-off cards")
print("    staff raise about them — at 'requested', before any ledger line exists")
print("  · and none of another partner's, in either direction, whoever raised them")
print("  · an applicant holding no partner id sees nothing rather than everything")
print("  · every staff-only card type is invisible even aimed at their own id,")
print("    and the allowlist decides it rather than a list of exclusions")
print("  · the raiser, verifier and signer become 'Zipper' and the internal")
print("    notes are dropped, while the stages and timestamps survive intact")
print("  · staff keep the full view — the collision and the separation of duties")
print("  · and the three internal branches of board_for are unchanged")
sys.exit(0)
