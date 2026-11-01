"""P0-7 (FIN-5) — a payout request is paid only through a ledgered card.

Before this, CRM "Mark paid" wrote `status: 'paid'` and the bank proof straight
onto `withdrawalRequests/{id}` (and `salaryRequests/{id}`): no bean debit, no
ledger row, no link to any card. The host's earnings stayed convertible and
withdrawable after the business had paid them — a payout the books never saw,
and a second payout waiting to happen. The host-withdrawal card that does
debit and ledger existed, but nothing tied it to the request.

Now:

  * a card can be raised FOR a request — `request_collection` + `request_id` —
    and only for one that exists, is this host's, and is still payable;
  * a second live card for the same request is refused;
  * executing the card marks the request `paid` IN THE SAME Firestore
    transaction as the debit, and a request already paid refuses the whole
    execution: nothing debited, the card failed;
  * salary requests are paid the same way;
  * an unlinked card behaves exactly as before.

(The browser half — `firestore.rules` refusing `paid` — is in
tests/firestore.phase1a.rules.test.mjs.)

Run:  python3 -m tests.test_payout_ledger_p0
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def start_transaction(self):
        return _FakeTransaction()


class _FakeClient:
    async def start_session(self):
        return _FakeSession()


mongo.get_client = lambda: _FakeClient()  # type: ignore[assignment]

from app.db.mongo import C  # noqa: E402

import app.db.firebase as firebase  # noqa: E402
from tests.fakes import FakeFirestore  # noqa: E402

FS = FakeFirestore()
firebase.firestore_client = lambda: FS  # type: ignore[assignment]
firebase.sync_balance_to_firestore = lambda *a, **k: True  # type: ignore[assignment]

from app.core.roles import Role, Team  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402

_SEQ = {"n": 0}


def _card_id() -> str:
    _SEQ["n"] += 1
    return f"{_SEQ['n']:024x}"


DB[C.CARDS]._next_id = _card_id  # type: ignore[assignment]

failures: list[str] = []
checks = 0


def eq(label: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}\n    want {want!r}\n    got  {got!r}")


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(coro):
    return asyncio.run(coro)


def refused(label: str, coro) -> str:
    global checks
    checks += 1
    try:
        run(coro)
    except ops.PartnerOpsError as exc:
        return str(exc)
    except TypeError as exc:   # the pre-fix signature has no request arguments
        failures.append(f"{label}: not supported ({exc})")
        return ""
    failures.append(f"{label}: was NOT refused")
    return ""


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team, "partner_ids": {}}


RAISER = internal("uid-finance-a", Role.FINANCE_ADMIN, Team.FINANCE)
VERIFIER = internal("uid-finance-b", Role.FINANCE_ADMIN, Team.FINANCE)
OWNER = internal("uid-owner", Role.OWNER)


def doc(path: str) -> dict:
    col, did = path.split("/")
    snap = FS.collection(col).document(did).get()
    return snap.to_dict() if snap.exists else {}


def host(uid: str, beans: int) -> None:
    FS.collection("users").document(uid).set({
        "name": uid, "beans": beans, "beansAvailable": beans, "agencyId": "ag-1",
        "isVerifiedHost": True,
    })


def sign(card_id: str) -> None:
    run(cards_svc.verify(card_id, VERIFIER, "Checked against the request."))
    run(cards_svc.sign(card_id, OWNER, "Approved."))


def raise_for(uid: str, beans: int, collection: str = "", rid: str = "") -> dict:
    if collection or rid:
        return run(ops.request_host_withdrawal(uid, beans, "Paying the queued request.", RAISER,
                                               request_collection=collection, request_id=rid))
    return run(ops.request_host_withdrawal(uid, beans, "Ad-hoc payout.", RAISER))


# ══════════════════════════════════════════════════════════════════════════════
#  1. A card raised FOR a withdrawal request, executed: debit + ledger + paid
# ══════════════════════════════════════════════════════════════════════════════

host("h1", 10_000)
FS.collection("withdrawalRequests").document("wr1").set({"hostUid": "h1", "beans": 4_000, "status": "approved"})

try:
    card = raise_for("h1", 4_000, "withdrawalRequests", "wr1")
except TypeError as exc:
    card = None
    ok(f"request_host_withdrawal accepts the request it pays ({exc})", False)

if card is not None:
    eq("the card carries the request it settles", card["payload"].get("request_id"), "wr1")
    refused("a SECOND card for the same request is refused",
            ops.request_host_withdrawal("h1", 1_000, "Again.", RAISER,
                                        request_collection="withdrawalRequests", request_id="wr1"))
    sign(card["id"])
    run(ops.execute_host_withdrawal(card["id"], "UTR-1", OWNER))
    eq("executing it debits the host", doc("users/h1").get("beansAvailable"), 6_000)
    eq("…marks the request paid", doc("withdrawalRequests/wr1").get("status"), "paid")
    eq("…with the card that paid it", doc("withdrawalRequests/wr1").get("cardId"), card["id"])
    eq("…and the bank reference", doc("withdrawalRequests/wr1").get("paymentRef"), "UTR-1")
    rows = [r for r in DB[C.LEDGER].docs if str(r.get("card_id")) == card["id"]]
    eq("…and writes exactly one ledger row", len(rows), 1)

# ══════════════════════════════════════════════════════════════════════════════
#  2. Raise-time refusals
# ══════════════════════════════════════════════════════════════════════════════

host("h2", 10_000)
FS.collection("withdrawalRequests").document("wr-paid").set({"hostUid": "h2", "status": "paid"})
FS.collection("withdrawalRequests").document("wr-other").set({"hostUid": "someone-else", "status": "approved"})
refused("a request already PAID cannot get a card",
        ops.request_host_withdrawal("h2", 100, "x reason", RAISER,
                                    request_collection="withdrawalRequests", request_id="wr-paid"))
refused("a request for ANOTHER host cannot get this host's card",
        ops.request_host_withdrawal("h2", 100, "x reason", RAISER,
                                    request_collection="withdrawalRequests", request_id="wr-other"))
refused("a request that does not exist cannot get a card",
        ops.request_host_withdrawal("h2", 100, "x reason", RAISER,
                                    request_collection="withdrawalRequests", request_id="nope"))
refused("only the two payout queues can be named",
        ops.request_host_withdrawal("h2", 100, "x reason", RAISER,
                                    request_collection="users", request_id="h2"))

# The card pays EXACTLY the request (review finding: a 1-bean card must not close
# a 4,000-bean request as paid).
FS.collection("withdrawalRequests").document("wr-amount").set({"hostUid": "h2", "beans": 4_000, "status": "approved"})
refused("a card for LESS than the request is refused",
        ops.request_host_withdrawal("h2", 1, "x reason", RAISER,
                                    request_collection="withdrawalRequests", request_id="wr-amount"))
refused("a card for MORE than the request is refused",
        ops.request_host_withdrawal("h2", 5_000, "x reason", RAISER,
                                    request_collection="withdrawalRequests", request_id="wr-amount"))

# ══════════════════════════════════════════════════════════════════════════════
#  3. Two cards raced past the raise check: the second execution moves nothing
# ══════════════════════════════════════════════════════════════════════════════

host("h3", 10_000)
FS.collection("withdrawalRequests").document("wr3").set({"hostUid": "h3", "beans": 1_000, "status": "approved"})
try:
    first = raise_for("h3", 1_000, "withdrawalRequests", "wr3")
    # Simulate the race: a second card written as if both raises had passed the
    # check at the same moment.
    second_id = _card_id()
    raw = dict(next(d for d in DB[C.CARDS].docs if str(d.get("_id")) == first["id"]))
    raw["_id"] = second_id
    DB[C.CARDS].docs.append(raw)
    if True:
        sign(first["id"])
        sign(second_id)
        run(ops.execute_host_withdrawal(first["id"], "UTR-3A", OWNER))
        refused("executing the SECOND card for a paid request is refused",
                ops.execute_host_withdrawal(second_id, "UTR-3B", OWNER))
        eq("…and nothing was debited twice", doc("users/h3").get("beansAvailable"), 9_000)
        eq("…the request records the FIRST payment", doc("withdrawalRequests/wr3").get("paymentRef"), "UTR-3A")
        eq("…and the second card is failed",
           next(d for d in DB[C.CARDS].docs if str(d.get("_id")) == second_id).get("stage"), "failed")
except TypeError as exc:
    ok(f"race scenario needs request-linked cards ({exc})", False)

# ══════════════════════════════════════════════════════════════════════════════
#  4. Salary requests are paid the same way
# ══════════════════════════════════════════════════════════════════════════════

host("h4", 5_000)
FS.collection("salaryRequests").document("sr1").set(
    {"hostUid": "h4", "agencyId": "ag-1", "beansEarned": 2_000, "amountInr": 200, "status": "approved"})
try:
    sal = raise_for("h4", 2_000, "salaryRequests", "sr1")
    sign(sal["id"])
    run(ops.execute_host_withdrawal(sal["id"], "UTR-SAL", OWNER))
    eq("a salary request is paid by its card", doc("salaryRequests/sr1").get("status"), "paid")
    eq("…and the host's beans go with it", doc("users/h4").get("beansAvailable"), 3_000)
except TypeError as exc:
    ok(f"salary requests can be paid by a card ({exc})", False)

# A salary request is an agency's request for ITS host.
FS.collection("salaryRequests").document("sr-other").set(
    {"hostUid": "h4", "agencyId": "ag-OTHER", "beansEarned": 100, "amountInr": 10, "status": "approved"})
refused("a salary request filed by ANOTHER agency than the host's cannot get a card",
        ops.request_host_withdrawal("h4", 100, "x reason", RAISER,
                                    request_collection="salaryRequests", request_id="sr-other"))

# ══════════════════════════════════════════════════════════════════════════════
#  4b. The same card executed twice (a double submit, a lost response)
# ══════════════════════════════════════════════════════════════════════════════

host("h6", 2_000)
FS.collection("withdrawalRequests").document("wr6").set({"hostUid": "h6", "beans": 500, "status": "approved"})
try:
    c6 = raise_for("h6", 500, "withdrawalRequests", "wr6")
    sign(c6["id"])
    run(ops.execute_host_withdrawal(c6["id"], "UTR-6", OWNER))
    # Put the card back to `approved`, as a raced second call would have found it.
    raw6 = next(d for d in DB[C.CARDS].docs if str(d.get("_id")) == c6["id"])
    raw6["stage"] = "approved"
    refused("executing the SAME card again is refused",
            ops.execute_host_withdrawal(c6["id"], "UTR-6", OWNER))
    eq("…nothing is debited twice", doc("users/h6").get("beansAvailable"), 1_500)
    # HT-2: the second execution finds this card's debit (keyed on the card) and
    # its ledger row already there, refuses, and CLOSES the card as executed —
    # the truth — instead of leaving it approved for ever (a crash between the
    # ledger row and the close used to strand it that way). Never "failed".
    eq("…and the card is NOT marked failed (it did not fail): it is closed as executed",
       raw6.get("stage"), "executed")
except TypeError as exc:
    ok(f"double execution scenario needs request-linked cards ({exc})", False)

# ══════════════════════════════════════════════════════════════════════════════
#  5. An unlinked card is unchanged
# ══════════════════════════════════════════════════════════════════════════════

host("h5", 3_000)
plain = raise_for("h5", 500)
ok("an unlinked card names no request", "request_id" not in plain["payload"])
sign(plain["id"])
run(ops.execute_host_withdrawal(plain["id"], "UTR-5", OWNER))
eq("…and still pays the host", doc("users/h5").get("beansAvailable"), 2_500)

# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} P0-7 payout-ledger checks passed.")
sys.exit(0)
