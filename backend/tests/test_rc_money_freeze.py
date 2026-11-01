"""RC (confirmed, CRM-FLOW 9.48) — money behind a suspension, ban or revocation
is frozen for the Owner's review.

    "On suspension or role revocation, freeze pending earnings and transfers
    for Owner review. The Owner decides whether to release, withhold, or
    adjust them."   — all four kinds (RC-2): Host earnings, Agency/Sub-agency
    money, Coin Seller money, pending transfers.

What runs here: the REAL services (users.suspend/ban/revoke_host/resume,
partner_ops.deactivate/revoke/execute_*/approve_sale, recharges.approve,
money_freeze) against in-memory fakes. Service-level, NOT end-to-end. The
weekly bean release and `convertBeans` read `users/{uid}.payoutHold` in the
Cloud Functions; that the hold is WRITTEN is asserted here, that it is READ is
asserted in `functions/test/rcMoneyFreeze.test.js`.

    python3 -m tests.test_rc_money_freeze
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import ObjectId, install_stubs, verified_auth  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
mongo.get_db = lambda: db  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
firebase_mod.get_user = verified_auth  # type: ignore[assignment]
firebase_mod.revoke_sessions = lambda uid: ""  # type: ignore[assignment]
firebase_mod.set_user_disabled = lambda uid, disabled: None  # type: ignore[assignment]

from app.services import money_freeze as mf  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import recharges as recharges_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, partner_svc, roles, users_svc, mf, recharges_svc):
    if hasattr(mod, "get_db"):
        mod.get_db = lambda: db  # type: ignore[assignment]
for mod in (ops, users_svc, mf):
    mod.audit.record = fake_audit
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refusal(coro) -> Exception | None:
    try:
        asyncio.run(coro)
    except Exception as exc:  # noqa: BLE001
        return exc
    return None


run = asyncio.run
STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
FIN = {"uid": "fin-1", "name": "Finance", "role": "finance_admin", "team": "finance"}
WHY = "Repeated policy breaches, under review."

_seq = [0]


def card(ctype: str, subject_type: str, subject_id: str, amount: int = 1000, **payload) -> str:
    """An Owner-signed card nobody has executed — what an execute path takes."""
    _seq[0] += 1
    oid = ObjectId(f"{_seq[0]:024x}")
    db["cards"].docs[str(oid)] = {
        "_id": oid, "type": ctype, "stage": "approved", "amount": amount, "currency": "INR",
        "subject": {"type": subject_type, "id": subject_id}, "payload": payload,
        "reason": "test", "team": "finance",
    }
    return str(oid)


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active", "isBanned": False,
                                        "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    db["partners"].docs[pid] = {"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, **over}


def freeze_of(key: str) -> dict:
    return db[mf.FREEZES].docs.get(key) or {}


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. A suspended Host — earnings frozen, nothing pays out, resume releases nothing")

user("H1", isHost=True, agencyId="AG1", isVerifiedHost=True, beans=5000, beansAvailable=3000)
W1 = card("host_withdrawal", "user", "H1", 3000)
run(users_svc.suspend_user("H1", WHY, STAFF))
f = freeze_of("user:H1")
eq("the Host's money is frozen", f.get("status"), "frozen")
ok("…naming the cause", (f.get("causes") or [{}])[-1].get("action") == "account_suspended", repr(f.get("causes")))
eq("…with Host earnings and pending transfers", sorted(f.get("kinds") or []), ["host_earnings", "pending_transfers"])
eq("…and a snapshot of what was pending", [c["id"] for c in (f.get("snapshot") or {}).get("cards", [])], [W1])
eq("the beans stop moving in the same write (payoutHold)", fs.collection("users").docs["H1"].get("payoutHold"), True)
exc = refusal(ops.execute_host_withdrawal(W1, "UTR123", FIN))
ok("a signed withdrawal is refused", isinstance(exc, ops.MoneyFrozenError), repr(exc))
ok("…saying it waits for the Owner", exc is not None and "Owner" in str(exc), str(exc))
eq("…and the card is untouched", db["cards"].docs[W1]["stage"], "approved")

run(users_svc.resume_user("H1", "Investigation closed.", STAFF))
eq("lifting the suspension does NOT release the money", freeze_of("user:H1").get("status"), "frozen")
eq("…the hold stays", fs.collection("users").docs["H1"].get("payoutHold"), True)

# ══════════════════════════════════════════════════════════════════════════════
print("2. Only the Owner decides — release, withhold or adjust, with a note")

exc = refusal(mf.decide("user:H1", "release", "Cleared after review.", FIN, db=db))
ok("Finance cannot release", isinstance(exc, PermissionError), repr(exc))
exc = refusal(mf.decide("user:H1", "release", "", OWNER, db=db))
ok("a decision needs a note", isinstance(exc, ValueError), repr(exc))
exc = refusal(mf.decide("user:H1", "adjust", "Partial.", OWNER, db=db, adjustment={"amount": 0}))
ok("an adjustment needs an amount and a direction", isinstance(exc, ValueError), repr(exc))

run(mf.decide("user:H1", "release", "Cleared after review.", OWNER, db=db))
eq("the Owner releases it", freeze_of("user:H1").get("status"), "released")
eq("…the hold is lifted", fs.collection("users").docs["H1"].get("payoutHold"), False)
eq("…the decision is recorded", [d["decision"] for d in freeze_of("user:H1").get("decisions") or []], ["release"])
eq("the withdrawal is no longer blocked by a freeze",
   refusal(mf.assert_card_not_frozen(db["cards"].docs[W1], db=db)), None)
exc = refusal(mf.decide("user:H1", "withhold", "Changed my mind.", OWNER, db=db))
ok("a decided freeze cannot be decided again", isinstance(exc, ValueError), repr(exc))
ok("decisions are audited", any(a["action"] == mf.DECIDED for a in AUDIT))

# ══════════════════════════════════════════════════════════════════════════════
print("3. A suspended Coin Seller role — inventory and money frozen; money coming back is not")

user("S-own")
partner("SELL1", "S-own", "seller")
fs.collection("sellers").docs["SELL1"] = {"status": "approved", "isApproved": True, "isActive": True,
                                          "ownerUid": "S-own", "crmUid": "S-own"}
CP = card("seller_coin_purchase", "seller", "SELL1", 50000)
LEND = card("lending_issue", "seller", "SELL1", 20000)
REPAY = card("lending_repay", "seller", "SELL1", 5000)
run(ops.deactivate_partner("SELL1", WHY, STAFF))
eq("the seller record's money is frozen", freeze_of("partner:SELL1").get("status"), "frozen")
eq("…as Coin Seller money", "seller_money" in (freeze_of("partner:SELL1").get("kinds") or []), True)
ok("a coin purchase is refused", isinstance(refusal(ops.execute_coin_purchase(CP, FIN)), ops.MoneyFrozenError))
ok("lending is refused", isinstance(refusal(ops.execute_lending(LEND, FIN)), ops.MoneyFrozenError))
exc = refusal(ops.execute_repayment(REPAY, FIN))
ok("a REPAYMENT (money back to Zipper) is not blocked by the freeze",
   not isinstance(exc, ops.MoneyFrozenError), repr(exc))

db[ops.SALES].docs["a" * 24] = {"_id": ObjectId("a" * 24), "seller_id": "SELL1", "buyer_uid": "B1",
                                 "diamonds": 100, "status": "pending"}
exc = refusal(ops.approve_sale("a" * 24, "Paid in cash.", OWNER))
ok("a sale (moves the seller's inventory) is refused", isinstance(exc, ops.MoneyFrozenError), repr(exc))
db["recharges"].docs["rq-1"] = {"_id": "rq-1", "seller_id": "SELL1", "buyer_uid": "B1", "diamonds": 100,
                                "status": "pending"}
exc = refusal(recharges_svc.approve_recharge("rq-1", "Payment seen.", FIN))
ok("a recharge through the frozen seller is refused", exc is not None and "frozen" in str(exc), repr(exc))
eq("…and stays pending", db["recharges"].docs["rq-1"]["status"], "pending")

run(mf.decide("partner:SELL1", "withhold", "Fraud suspected; keep it.", OWNER, db=db))
eq("the Owner withholds it", freeze_of("partner:SELL1").get("status"), "withheld")
ok("…and it stays blocked", isinstance(refusal(ops.execute_coin_purchase(CP, FIN)), ops.MoneyFrozenError))

# ══════════════════════════════════════════════════════════════════════════════
print("4. A revoked Agency — commission payouts frozen; the Owner adjusts")

user("A-own")
partner("AG1", "A-own", "agency")
partner("SELL-A", "A-own", "seller")   # a second role, so the revocation is allowed
fs.collection("agencies").docs["AG1"] = {"status": "approved", "isActive": True, "type": "main",
                                         "ownerUid": "A-own", "crmUid": "A-own"}
PAY = card("commission_payout", "agency", "AG1", 12000)
run(ops.revoke_partner("AG1", WHY, OWNER))
eq("the agency's money is frozen", freeze_of("partner:AG1").get("status"), "frozen")
eq("…as Agency money", "agency_money" in (freeze_of("partner:AG1").get("kinds") or []), True)
ok("a signed commission payout is refused",
   isinstance(refusal(ops.execute_commission_payout(PAY, "NEFT1", FIN)), ops.MoneyFrozenError))
run(mf.decide("partner:AG1", "adjust", "Pay half; the rest was earned on fake calls.", OWNER, db=db,
              adjustment={"amount": 6000, "direction": "decrease", "currency": "INR"}))
f = freeze_of("partner:AG1")
eq("the Owner's adjustment is recorded and the freeze lifted", f.get("status"), "adjusted")
eq("…with the amount and direction", (f.get("decisions") or [{}])[-1].get("adjustment", {}).get("amount"), 6000)
ok("…and says it is carried out by a balance card, not by this decision",
   "balance card" in (f.get("decisions") or [{}])[-1].get("adjustment", {}).get("carried_out_by", ""))

# ══════════════════════════════════════════════════════════════════════════════
print("5. A ban freezes the person AND every partner record they own")

user("P-ban", isHost=True, agencyId="AG9", beans=100)
partner("SELL-BAN", "P-ban", "seller")
partner("AG-BAN-PEND", "P-ban", "agency", status="pending")   # a pending application has no money
run(users_svc.ban_user("P-ban", WHY, STAFF, ban_device_too=False))
eq("the person is frozen", freeze_of("user:P-ban").get("status"), "frozen")
eq("…and the seller record they own", freeze_of("partner:SELL-BAN").get("status"), "frozen")
eq("…but not a pending application (it holds nothing)", freeze_of("partner:AG-BAN-PEND"), {})
eq("…and the beans are on hold", fs.collection("users").docs["P-ban"].get("payoutHold"), True)

# ══════════════════════════════════════════════════════════════════════════════
print("6. A revoked Host role — the Host's earnings only")

user("H-rev", isHost=True, agencyId="AG1", beans=700)
partner("SELL-H", "H-rev", "seller")    # a second role, so the Host revocation is allowed
run(users_svc.revoke_host("H-rev", WHY, STAFF, enforce_target_policy=False))
eq("the Host's earnings are frozen", freeze_of("user:H-rev").get("status"), "frozen")
eq("…the seller role (still live) is NOT frozen by a Host revocation", freeze_of("partner:SELL-H"), {})
eq("…and the hold is set", fs.collection("users").docs["H-rev"].get("payoutHold"), True)

# ══════════════════════════════════════════════════════════════════════════════
print("7. A second cause on a frozen subject is appended, not a new freeze")

run(mf.freeze("user", "H-rev", kinds=["host_earnings"], cause="account_suspended", label="a suspension",
              reason="Also suspended.", actor=STAFF, db=db))
eq("two causes, one freeze", len(freeze_of("user:H-rev").get("causes") or []), 2)
eq("…still frozen", freeze_of("user:H-rev").get("status"), "frozen")

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f_ in failures:
        print("  ✗ " + f_)
    sys.exit(1)
print(f"All {checks} RC money-freeze checks passed.")
