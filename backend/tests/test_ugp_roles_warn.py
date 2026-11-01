"""UGP — role-aware CRM actions, Host restore, warning deductions, live debits.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  B. Role-aware actions, from authoritative records only:
     * a guest / ordinary user holds no role → no role action at all (S1);
     * ONE active role → no revoke (suspend the account); the server refuses;
     * TWO roles → each may be revoked on its own;
     * a revoked Host is restored from the EXISTING application, roster and
       verification — no new record, verification state kept;
     * a decided host application cannot be decided again into a revoke;
     * reject = pending only; restore = suspended/revoked only; approve on a
       suspended/revoked record IS the restore.
  D. Warning with an optional deduction:
     * currency from the roles (user → diamonds, host → beans, both only for a
       Host with a diamond role); the live balance must cover it; a wrong
       currency or a short balance records NOTHING;
     * the deduction is a `balance_debit` card linked to the warning (money is
       never direct); audited with currency, amount and card;
     * idempotent on the CRM's request id — one warning, one count, one card;
     * the card executes against the LIVE balance, whole or not at all, with
       the app-visible history row, and a replay never debits twice.

REAL: services.users, services.user_roles, services.partner_ops, money, cards.
FAKE: Mongo (`tests/harness.FakeDb`) and Firestore (`tests/fakes.FakeFirestore`).

    python3 -m tests.test_ugp_roles_warn
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]


class _Tx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class _Session(_Tx):
    def start_transaction(self):
        return _Tx()


class _Client:
    async def start_session(self):
        return _Session()


mongo.get_client = lambda: _Client()  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
# Decision 15 (RC): every account in these fixtures holds BOTH verified contacts
# (an SMS-linked phone and a code-verified email) — the subject of this module
# is not the contact rule, which tests/test_rc_contact_verification.py runs with
# per-uid records, verified and not.
from tests import harness as _rc_harness  # noqa: E402

firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    # Also the shape the real recorder stores (`audit._entry`), so code that
    # READS the audit log — a retry checking whether its row exists — sees it.
    await DB[C.AUDIT].insert_one({
        "action": kw.get("action"),
        "subject": {"type": kw.get("subject_type"), "id": kw.get("subject_id")},
        "meta": kw.get("meta") or {},
    })
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import user_roles as ur  # noqa: E402
from app.services import users as svc  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402
from app.services.users import UserError  # noqa: E402

apps.is_unverified_guest = lambda uid: False  # fixtures are verified people
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


def refuses(claim: str, coro, kind=(UserError, PartnerOpsError)) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:  # type: ignore[misc]
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run
STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner", "role": "superadmin", "team": None}
#: C2: restoring a REVOKED role is the Owner's decision. The session role of an
#: Owner is `owner` (the Mongo vocabulary every session speaks).
THE_OWNER = {"uid": "owner-2", "name": "Owner", "role": "owner", "team": None}
WHY = "Reviewed and decided by staff."


def users():
    return fs.collection("users").docs


def user(uid: str, **over) -> None:
    users()[uid] = {"name": f"user {uid}", "accountState": "active", "isBanned": False,
                    "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, **over})


def warnings_of(uid: str) -> dict:
    return fs.collection("users").document(uid).collection("warnings").docs


def cards_for(uid: str) -> list[dict]:
    return [c for c in DB[C.CARDS].docs if (c.get("payload") or {}).get("uid") == uid]


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The rules, pure")

R = lambda **kw: kw  # noqa: E731
eq("no roles → nothing held", ur.count_held([]), 0)
eq("no roles → no actions", ur.allowed_role_actions([]), [])
one = [R(role="host", status="active")]
eq("one active role → held 1", ur.count_held(one), 1)
eq("…and NO revoke on it", ur.allowed_role_actions(one)[0]["actions"], [])
two = [R(role="host", status="active"), R(role="seller", id="S", status="approved")]
eq("two roles → revoke on each",
   [r["actions"] for r in ur.allowed_role_actions(two)], [["revoke"], ["revoke"]])
eq("a pending application is not a role", ur.count_held([R(role="agency", status="pending")]), 0)
eq("suspended IS held", ur.count_held([R(role="agency", status="suspended"), R(role="seller", status="approved")]), 2)
acts = ur.allowed_role_actions([R(role="agency", status="suspended"), R(role="seller", status="approved")])
eq("a suspended role with another → revoke + restore", acts[0]["actions"], ["revoke", "restore"])
eq("a revoked partner → restore only", ur.allowed_role_actions([R(role="seller", status="revoked")])[0]["actions"], ["restore"])
eq("a revoked Host that is restorable → restore",
   ur.allowed_role_actions([R(role="host", status="revoked", restorable=True)])[0]["actions"], ["restore"])
eq("a revoked Host that is not restorable → nothing",
   ur.allowed_role_actions([R(role="host", status="revoked", restorable=False)])[0]["actions"], [])
eq("currency: a user → diamonds", ur.deduction_currencies([]), ["diamonds"])
eq("currency: a host → beans", ur.deduction_currencies(one), ["beans"])
eq("currency: an agency → diamonds", ur.deduction_currencies([R(role="agency", status="approved")]), ["diamonds"])
eq("currency: Host + Coin Seller → both (D6)", ur.deduction_currencies(two), ["beans", "diamonds"])

# ══════════════════════════════════════════════════════════════════════════════
print("2. The inventory, from authoritative records")

user("g-guest", name="Guest yrfdp")
inv = run(ur.roles_for_crm("g-guest"))
eq("a guest with no records holds nothing (S1)", inv["roles"], [])
eq("…held_count 0", inv["held_count"], 0)

partner("AG1", "own-ag1", "agency")          # a live main agency for hosts
user("own-ag1")
user("h-only", isHost=True, agencyId="AG1", isVerifiedHost=True)
inv = run(ur.roles_for_crm("h-only"))
eq("a single-role host: one role", [r["role"] for r in inv["roles"]], ["host"])
eq("…with NO revoke offered", inv["roles"][0]["actions"], [])
eq("…deductions in beans", inv["deduction_currencies"], ["beans"])

user("h-two", isHost=True, agencyId="AG1", beansAvailable=500, beans=800, diamonds=30)
partner("S-two", "h-two", "seller")
inv = run(ur.roles_for_crm("h-two"))
eq("Host + Coin Seller: both listed", sorted(r["role"] for r in inv["roles"]), ["host", "seller"])
ok("…each revocable", all("revoke" in r["actions"] for r in inv["roles"]))

# ══════════════════════════════════════════════════════════════════════════════
print("3. One role → suspend only; two → revoke one")

m = refuses("revoking a single-role Host is refused", svc.revoke_host("h-only", WHY, STAFF))
ok("…saying to suspend the account", "only active role" in m and "suspend" in m.lower(), m)
eq("…and the host is untouched", users()["h-only"]["isHost"], True)

run(svc.revoke_host("h-two", WHY, STAFF))
eq("with a second role, Host may be revoked", users()["h-two"]["isHost"], False)
eq("…the Coin Seller role is untouched", next(p for p in DB[C.PARTNERS].docs if p["_id"] == "S-two")["status"], "approved")

user("a-only")
partner("AG-only", "a-only", "agency")
m = refuses("revoking a single-role Agency is refused", ops.revoke_partner("AG-only", WHY, STAFF))
ok("…with the one-role sentence", "only active role" in m, m)
partner("AG-pend", "a-only", "agency", status="pending")
m = refuses("revoking a PENDING application is refused (reject it)", ops.revoke_partner("AG-pend", WHY, STAFF))
ok("…pointing at Reject", "Reject" in m, m)

# ══════════════════════════════════════════════════════════════════════════════
print("4. Reject / restore / approve keep to their own cases")

m = refuses("rejecting an APPROVED record is refused", ops.reject_partner("AG-only", WHY, STAFF))
ok("…naming the right actions", "pending" in m and "Revoke" in m, m)
m = refuses("restoring a PENDING record is refused", ops.reactivate_partner("AG-pend", WHY, STAFF))
ok("…pointing at Approve", "Approve" in m, m)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Host restore — the existing records, nothing new")

user("h-rest", isHost=False, agencyId="AG1", isVerifiedHost=True, hostRevokedAt=__import__("datetime").datetime(2026, 10, 1),
     callRateBeans=40)
fs.collection("hostApplications").docs["app-rest"] = {"applicantUid": "h-rest", "status": "approved",
                                                       "agencyId": "AG1", "hostName": "Rina"}
fs.collection("hostVerification").docs["h-rest"] = {"status": "verified", "attemptCount": 2}
inv = run(ur.roles_for_crm("h-rest"))
eq("a revoked Host with an approved application under a live agency is restorable",
   [r.get("actions") for r in inv["roles"] if r["role"] == "host"], [["restore"]])
apps_before = len(fs.collection("hostApplications").docs)
m = refuses("C2: a non-Owner cannot restore a revoked Host", svc.restore_host("h-rest", WHY, STAFF),
            kind=svc.OwnerOnly)
ok("C2: …told it is the Owner's decision", "Only the Owner" in m, m)
eq("C2: …and nothing changed", users()["h-rest"]["isHost"], False)
out = run(svc.restore_host("h-rest", WHY, THE_OWNER))
eq("restore → isHost", users()["h-rest"]["isHost"], True)
eq("…same agency", users()["h-rest"]["agencyId"], "AG1")
eq("…verification KEPT as it was", fs.collection("hostVerification").docs["h-rest"]["status"], "verified")
eq("…isVerifiedHost untouched", users()["h-rest"]["isVerifiedHost"], True)
eq("…no new application", len(fs.collection("hostApplications").docs), apps_before)
ok("…roster row written on the same agency",
   "h-rest" in fs.collection("agencies").document("AG1").collection("agencyHosts").docs)
ok("…audited as host.restored", any(e.get("action") == "host.restored" for e in AUDIT))
ok("…and the person told", any(n.get("type") == "host_restored" for n in notices_for("h-rest")))
m = refuses("restoring an active Host is refused", svc.restore_host("h-rest", WHY, STAFF))

user("h-dead", agencyId="AG-gone", hostRevokedAt=__import__("datetime").datetime(2026, 10, 1))
fs.collection("hostApplications").docs["app-dead"] = {"applicantUid": "h-dead", "status": "approved", "agencyId": "AG-gone"}
partner("AG-gone", "own-gone", "agency", status="revoked")
m = refuses("restore under an agency that is not live is refused (D15)", svc.restore_host("h-dead", WHY, THE_OWNER))
ok("…saying why", "agency" in m.lower(), m)
eq("…nothing written", users()["h-dead"].get("isHost"), None)

user("h-banned", agencyId="AG1", hostRevokedAt=__import__("datetime").datetime(2026, 10, 1), isBanned=True,
     accountState="banned")
fs.collection("hostApplications").docs["app-banned"] = {"applicantUid": "h-banned", "status": "approved", "agencyId": "AG1"}
m = refuses("restoring a role on a restricted account is refused", svc.restore_host("h-banned", WHY, THE_OWNER))
ok("…even for the Owner, saying to lift the restriction", "restricted" in m, m)
user("h-never")
refuses("restoring somebody who was never a Host is refused", svc.restore_host("h-never", WHY, STAFF))

# A decided application cannot be decided again into a revoke.
m = refuses("refusing an APPROVED host application is refused",
            svc.decide_host_application("app-rest", False, WHY, STAFF))
ok("…pointing at Revoke host / suspend", "Revoke host" in m, m)
eq("…and the host is still a host", users()["h-rest"]["isHost"], True)
m = refuses("re-approving a decided application of an active host is refused",
            svc.decide_host_application("app-rest", True, WHY, STAFF))

# ══════════════════════════════════════════════════════════════════════════════
print("6. Warning with an optional deduction")

user("u-plain", diamonds=120)
r = run(svc.warn_user("u-plain", "Spam in a public room.", STAFF))
eq("a warning without a deduction still works", r.get("deduction"), None)
eq("…counted", users()["u-plain"]["warnings"], 1)
eq("…no card", cards_for("u-plain"), [])

r = run(svc.warn_user("u-plain", "Abusive messages to a host.", STAFF,
                      request_id="req-u-plain-1", deduction={"currency": "diamonds", "amount": 50}))
ded = r["deduction"]
eq("deduction: diamonds for an ordinary user", ded["currency"], "diamonds")
eq("…amount", ded["amount"], 50)
eq("…NOT moved yet — a card an owner signs", ded["moved"], False)
cs = cards_for("u-plain")
eq("…exactly one card", len(cs), 1)
eq("…a balance_debit", cs[0]["type"], "balance_debit")
eq("…for minus the amount", cs[0]["amount"], -50)
eq("…linked to the warning", cs[0]["payload"]["warning_id"], r["warning_id"])
eq("the live balance is untouched until execution", users()["u-plain"]["diamonds"], 120)
w = warnings_of("u-plain")[r["warning_id"]]
eq("the warning records the deduction", (w["deduction"]["currency"], w["deduction"]["amount"]), ("diamonds", 50))
aud = [e for e in AUDIT if e.get("action") == "user.warned" and (e.get("meta") or {}).get("warning_id") == r["warning_id"]]
eq("audited once, with currency, amount and card", (aud[0]["meta"]["deduction"]["currency"],
   aud[0]["meta"]["deduction"]["amount"], aud[0]["meta"]["deduction"]["card_id"]), ("diamonds", 50, cs[0]["_id"].__str__()))

again = run(svc.warn_user("u-plain", "Abusive messages to a host.", STAFF,
                          request_id="req-u-plain-1", deduction={"currency": "diamonds", "amount": 50}))
eq("a retried request is the SAME warning", again["warning_id"], r["warning_id"])
ok("…marked as a replay", again.get("replayed") is True)
eq("…counted once", users()["u-plain"]["warnings"], 2)
eq("…one card, not two", len(cards_for("u-plain")), 1)
eq("…one notice for it", len([n for n in notices_for("u-plain") if r["warning_id"] in str(n)]) <= 1, True)

before = (len(warnings_of("u-plain")), len(cards_for("u-plain")), users()["u-plain"]["warnings"])
m = refuses("beans from a non-host is refused", svc.warn_user(
    "u-plain", "Reason here.", STAFF, request_id="req-u-plain-2", deduction={"currency": "beans", "amount": 5}))
ok("…naming the currency that applies", "diamonds" in m, m)
m = refuses("more than the live balance is refused", svc.warn_user(
    "u-plain", "Reason here.", STAFF, request_id="req-u-plain-3", deduction={"currency": "diamonds", "amount": 121}))
ok("…saying what is there", "120" in m, m)
eq("…and NOTHING was recorded by either", (len(warnings_of("u-plain")), len(cards_for("u-plain")),
   users()["u-plain"]["warnings"]), before)
refuses("a zero deduction is refused", svc.warn_user(
    "u-plain", "Reason here.", STAFF, request_id="req-u-plain-0", deduction={"currency": "diamonds", "amount": 0}))

user("h-beans", isHost=True, agencyId="AG1", beansAvailable=40, beans=300)
m = refuses("a host's deduction is checked against RELEASED beans (D7)", svc.warn_user(
    "h-beans", "Missed a booked call.", STAFF, request_id="req-h-beans-0", deduction={"currency": "beans", "amount": 41}))
ok("…saying released beans", "released beans" in m, m)
r_b = run(svc.warn_user("h-beans", "Missed a booked call.", STAFF, request_id="req-h-beans-1",
                        deduction={"currency": "beans", "amount": 40}))
eq("a host's deduction is in beans", r_b["deduction"]["currency"], "beans")
refuses("diamonds from a host-only account is refused", svc.warn_user(
    "h-beans", "Reason here.", STAFF, request_id="req-h-beans-2", deduction={"currency": "diamonds", "amount": 1}))

# ══════════════════════════════════════════════════════════════════════════════
print("7. Executing the card — against the LIVE balance, once")


_oid = iter(range(1, 10_000))


def approve_card(card: dict) -> str:
    """Verified and signed (the board's stages are tested elsewhere). The fake
    Mongo's auto ids are not 24-character ObjectIds, so the card is re-keyed to
    one the executor's `ObjectId(card_id)` accepts."""
    card["_id"] = f"{next(_oid):024x}"
    card["stage"] = "approved"
    return str(card["_id"])


cid = approve_card(cards_for("u-plain")[0])
res = run(svc.execute_balance_card(cid, OWNER))
eq("diamonds taken from the live balance", users()["u-plain"]["diamonds"], 70)
hist = fs.collection("users").document("u-plain").collection("diamondTransactions").docs
ok("…with the app-visible history row", f"card_{cid}" in hist)
eq("…card executed", next(c for c in DB[C.CARDS].docs if str(c["_id"]) == cid)["stage"], "executed")
ok("…ledgered once", sum(1 for row in DB[C.LEDGER].docs if row.get("idempotency_key") == cid) == 1)
eq("…the warning shows the deduction taken",
   warnings_of("u-plain")[r["warning_id"]]["deduction"]["status"], "executed")

# A crash after the Firestore debit and before the ledger: replay must not debit twice.
user("u-crash", diamonds=100)
rc = run(svc.warn_user("u-crash", "Second offence.", STAFF, request_id="req-u-crash",
                       deduction={"currency": "diamonds", "amount": 30}))
card_c = cards_for("u-crash")[0]
cid_c = approve_card(card_c)
run(asyncio.to_thread(firebase_mod.clawback_user_diamonds, "u-crash", 30,
                      reason="x", history_id=f"card_{cid_c}", require_full=True))
eq("(the first attempt debited the live balance)", users()["u-crash"]["diamonds"], 70)
run(svc.execute_balance_card(cid_c, OWNER))
eq("the replayed execution did NOT debit again", users()["u-crash"]["diamonds"], 70)

# Short live balance: the card fails, nothing moves.
user("u-short", diamonds=60)
run(svc.warn_user("u-short", "Third offence.", STAFF, request_id="req-u-short",
                  deduction={"currency": "diamonds", "amount": 60}))
users()["u-short"]["diamonds"] = 10   # spent between the request and the signature
cid_s = approve_card(cards_for("u-short")[0])
m = refuses("a debit the live balance no longer covers is refused at execution",
            svc.execute_balance_card(cid_s, OWNER))
eq("…nothing taken", users()["u-short"]["diamonds"], 10)
eq("…card marked failed", next(c for c in DB[C.CARDS].docs if str(c["_id"]) == cid_s)["stage"], "failed")

# Beans: both the released slice and the total move together.
cid_b = approve_card(cards_for("h-beans")[0])
run(svc.execute_balance_card(cid_b, OWNER))
eq("beans: beansAvailable debited", users()["h-beans"]["beansAvailable"], 0)
eq("beans: beans debited with it", users()["h-beans"]["beans"], 260)
ok("…with a beanTransactions row",
   f"card_{cid_b}" in fs.collection("users").document("h-beans").collection("beanTransactions").docs)

# ══════════════════════════════════════════════════════════════════════════════
print("8. The route asks for can_adjust_balance before a deduction")

src = (ROOT / "app" / "routers" / "users.py").read_text()
ok("the warn route enforces the deduction permission",
   "await enforce_permission(user, _WARN_DEDUCTION_PERMISSION)" in src)
ok("…which is can_adjust_balance", "_WARN_DEDUCTION_PERMISSION = Permission.CAN_ADJUST_BALANCE" in src)
ok("the roles read is on the router", '@router.get("/{uid}/roles")' in src)
ok("restore-host is gated like revoke-host",
   '"/{uid}/restore-host",\n    dependencies=[Depends(require_permission(Permission.CAN_APPROVE_KYC))]' in src)

# ══════════════════════════════════════════════════════════════════════════════
print("9. Review fixes — the money path and the role guards")

from datetime import datetime as _dt  # noqa: E402

from app.services import cards as cards_svc  # noqa: E402
from app.services.cards import CardError  # noqa: E402

run(mongo.ensure_warning_card_index(DB))
ANY = (UserError, PartnerOpsError, CardError)


def card_of(cid: str) -> dict:
    return next(c for c in DB[C.CARDS].docs if str(c["_id"]) == cid)


def ledger_rows(cid: str) -> int:
    return sum(1 for row in DB[C.LEDGER].docs if row.get("idempotency_key") == cid)


# 9.1 A replay never raises a card from what the STORED warning says.
user("u-plant", diamonds=5)
wid = svc.warning_id_for("u-plant", "req-plant-1")
firebase_mod.create_warning_once("u-plant", wid, {
    "reason": "planted", "issuedAt": _dt(2026, 10, 1), "issuedBy": STAFF["uid"],
    "deduction": {"currency": "diamonds", "amount": 99999, "balanceAtRequest": 5, "status": "requested"},
})
m = refuses("a retry WITHOUT a deduction cannot pick one up from the stored warning",
            svc.warn_user("u-plant", "Spam in a room.", STAFF, request_id="req-plant-1"))
ok("…said to be a different warning", "different warning" in m, m)
eq("…no card raised", cards_for("u-plant"), [])
wid2 = svc.warning_id_for("u-plant", "req-plant-2")
firebase_mod.create_warning_once("u-plant", wid2, {
    "reason": "planted", "issuedAt": _dt(2026, 10, 1), "issuedBy": "somebody-else",
})
m = refuses("a request id another reviewer's warning holds is refused",
            svc.warn_user("u-plant", "Spam in a room.", STAFF, request_id="req-plant-2"))
ok("…naming the other reviewer", "another reviewer" in m, m)
eq("…still no card", cards_for("u-plant"), [])

# 9.2 A first attempt that died after the warning: the retry finishes it — once.
user("u-died", diamonds=100)
wid3 = svc.warning_id_for("u-died", "req-died")
firebase_mod.create_warning_once("u-died", wid3, {
    "reason": "Second offence in a room.", "issuedAt": _dt(2026, 10, 2), "issuedBy": STAFF["uid"],
    "deduction": {"currency": "diamonds", "amount": 25, "balanceAtRequest": 100, "status": "requested"},
})
aud_before = len([e for e in AUDIT if (e.get("meta") or {}).get("warning_id") == wid3])
r3 = run(svc.warn_user("u-died", "Second offence in a room.", STAFF, request_id="req-died",
                       deduction={"currency": "diamonds", "amount": 25}))
ok("the retry is a replay", r3.get("replayed") is True)
eq("…raises the card the first attempt never got to", len(cards_for("u-died")), 1)
eq("…for the stored amount", cards_for("u-died")[0]["amount"], -25)
warned = [e for e in AUDIT if e.get("action") == "user.warned" and (e.get("meta") or {}).get("warning_id") == wid3]
eq("…writes the missing user.warned audit row", (aud_before, len(warned)), (0, 1))
ok("…and delivers the notice", f"warning_{wid3}" in fs.collection("notifications").docs)
run(svc.warn_user("u-died", "Second offence in a room.", STAFF, request_id="req-died",
                  deduction={"currency": "diamonds", "amount": 25}))
eq("a second retry adds nothing (one card, one audit row)",
   (len(cards_for("u-died")), len([e for e in AUDIT if e.get("action") == "user.warned"
                                   and (e.get("meta") or {}).get("warning_id") == wid3])), (1, 1))
m = refuses("a retry asking for a DIFFERENT amount is refused",
            svc.warn_user("u-died", "Second offence in a room.", STAFF, request_id="req-died",
                          deduction={"currency": "diamonds", "amount": 26}))

# 9.2b A replay does not mark a notice the person has already READ as unread.
note_doc = fs.collection("notifications").docs[f"warning_{wid3}"]
note_doc["isRead"] = True
run(svc.warn_user("u-died", "Second offence in a room.", STAFF, request_id="req-died",
                  deduction={"currency": "diamonds", "amount": 25}))
eq("a retry leaves an already-read notice read", fs.collection("notifications").docs[f"warning_{wid3}"]["isRead"], True)

# 9.2c A malformed stored warning is a clean refusal, not a crash.
user("u-malformed", diamonds=50)
wid_m = svc.warning_id_for("u-malformed", "req-malformed")
firebase_mod.create_warning_once("u-malformed", wid_m, {
    "reason": "planted", "issuedAt": _dt(2026, 10, 1), "issuedBy": STAFF["uid"], "deduction": {"amount": "lots"},
})
m = refuses("a malformed stored deduction is refused cleanly",
            svc.warn_user("u-malformed", "Spam in a room.", STAFF, request_id="req-malformed",
                          deduction={"currency": "diamonds", "amount": 5}))
ok("…saying it is malformed", "malformed" in m, m)
eq("…and no card", cards_for("u-malformed"), [])

# 9.3 Two raises in flight for one warning → one card (the unique index decides).
user("u-race", diamonds=100)
plan = {"currency": "diamonds", "amount": 10, "balance_at_request": 100}


async def _both():
    return await asyncio.gather(
        svc._raise_warning_deduction_card("u-race", users()["u-race"], "w_race", plan, WHY, STAFF),
        svc._raise_warning_deduction_card("u-race", users()["u-race"], "w_race", plan, WHY, STAFF),
    )


a_card, b_card = run(_both())
eq("two in-flight raises for one warning → ONE card",
   len([c for c in DB[C.CARDS].docs if (c.get("payload") or {}).get("warning_id") == "w_race"]), 1)
eq("…both answer with it", a_card["id"], b_card["id"])

# 9.4 Strict amounts; a deduction needs a request id.
for bad in (True, 2.9, "5", None):
    refuses(f"amount {bad!r} is refused", svc.warn_user(
        "u-race", "Reason here.", STAFF, request_id=f"req-bad-{bad}", deduction={"currency": "diamonds", "amount": bad}))
m = refuses("a deduction without a request id is refused", svc.warn_user(
    "u-race", "Reason here.", STAFF, deduction={"currency": "diamonds", "amount": 5}))
ok("…saying why", "request id" in m, m)

# 9.5 The point of no return: a claimed execution cannot be rejected; a re-run finishes it.
user("u-claim", diamonds=100)
run(svc.warn_user("u-claim", "Third offence.", STAFF, request_id="req-claim",
                  deduction={"currency": "diamonds", "amount": 20}))
cid_k = approve_card(cards_for("u-claim")[0])
run(cards_svc.claim_execution(cid_k, OWNER))
run(asyncio.to_thread(firebase_mod.clawback_user_diamonds, "u-claim", 20,
                      reason="x", history_id=f"card_{cid_k}", require_full=True))
eq("(the interrupted attempt took the money; no ledger row yet)", (users()["u-claim"]["diamonds"], ledger_rows(cid_k)), (80, 0))
m = refuses("rejecting a card whose execution has started is refused",
            cards_svc.reject(cid_k, THE_OWNER, "Changed my mind."), kind=ANY)  # B-2: an Owner rejects a signed card
ok("…saying to run it again", "Run the execution again" in m, m)
eq("…the card is still approved", card_of(cid_k)["stage"], "approved")
run(svc.execute_balance_card(cid_k, OWNER))
eq("the re-run finishes it: no second debit, one ledger row, executed",
   (users()["u-claim"]["diamonds"], ledger_rows(cid_k), card_of(cid_k)["stage"]), (80, 1, "executed"))
user("u-rej", diamonds=100)
run(svc.warn_user("u-rej", "Fourth offence.", STAFF, request_id="req-rej",
                  deduction={"currency": "diamonds", "amount": 20}))
cid_r = approve_card(cards_for("u-rej")[0])
run(cards_svc.reject(cid_r, THE_OWNER, "Not warranted."))  # B-2: only an Owner rejects a signed card
eq("an approved card nobody has started executing can still be rejected", card_of(cid_r)["stage"], "rejected")
m = refuses("…and a rejected card cannot then be executed", svc.execute_balance_card(cid_r, OWNER))
eq("…nothing moved", users()["u-rej"]["diamonds"], 100)

# 9.6 A wallet that is gone takes nothing and ledgers nothing.
user("u-gone", diamonds=50)
run(svc.warn_user("u-gone", "Fifth offence.", STAFF, request_id="req-gone",
                  deduction={"currency": "diamonds", "amount": 10}))
cid_g = approve_card(cards_for("u-gone")[0])
del users()["u-gone"]
refuses("executing against a missing wallet is refused", svc.execute_balance_card(cid_g, OWNER))
eq("…no ledger row, card failed", (ledger_rows(cid_g), card_of(cid_g)["stage"]), (0, "failed"))

# 9.7 Beans: a card never drives `beans` below zero.
user("h-floor", isHost=True, agencyId="AG1", beansAvailable=50, beans=20)
m = refuses("planning already counts `beans`, not only the released slice", svc.warn_user(
    "h-floor", "Missed calls.", STAFF, request_id="req-floor-0", deduction={"currency": "beans", "amount": 50}))
ok("…saying what can be taken", "20" in m, m)
users()["h-floor"]["beans"] = 60
run(svc.warn_user("h-floor", "Missed calls.", STAFF, request_id="req-floor",
                  deduction={"currency": "beans", "amount": 50}))
users()["h-floor"]["beans"] = 20       # spent between the request and the signature
cid_f = approve_card(cards_for("h-floor")[0])
refuses("a beans debit larger than `beans` is refused at execution", svc.execute_balance_card(cid_f, OWNER))
eq("…nothing moved", (users()["h-floor"]["beansAvailable"], users()["h-floor"]["beans"]), (50, 20))

# 9.8 The money moves on the account the signer was shown.
user("u-subj", diamonds=100)
user("u-other", diamonds=100)
DB[C.CARDS].docs.append({"_id": f"{next(_oid):024x}", "type": "balance_debit", "stage": "approved",
                         "amount": -10, "currency": "diamonds", "reason": "x",
                         "subject": {"type": "user", "id": "u-subj"}, "payload": {"uid": "u-other"}})
cid_m = str(DB[C.CARDS].docs[-1]["_id"])
refuses("a card whose payload names another account than its subject moves nothing",
        svc.execute_balance_card(cid_m, OWNER))
eq("…both balances untouched", (users()["u-subj"]["diamonds"], users()["u-other"]["diamonds"]), (100, 100))
csrc = (ROOT / "app" / "routers" / "cards.py").read_text()
ok("the generic card route refuses balance cards",
   "if body.type in _BALANCE_CARD_TYPES:" in csrc and "CardType.BALANCE_DEBIT" in csrc)
ok("the warn route refuses a deduction without a request id",
   "A warning with a deduction needs a request_id." in src)
ok("…and takes the amount strictly", "amount: int = Field(ge=1, le=10_000_000, strict=True)" in src)

# 9.9 Suspend only what is held; restore nothing onto a restricted account.
user("own-st")
for st in ("pending", "rejected", "revoked"):
    partner(f"S-{st}", "own-st", "seller", status=st)
    refuses(f"suspending a {st.upper()} record is refused", ops.deactivate_partner(f"S-{st}", WHY, STAFF))
    eq(f"…it stays {st}", next(p for p in DB[C.PARTNERS].docs if p["_id"] == f"S-{st}")["status"], st)
user("own-ban", isBanned=True, accountState="banned")
partner("S-ban", "own-ban", "seller", status="suspended")
m = refuses("restoring a role onto a BANNED owner is refused", ops.reactivate_partner("S-ban", WHY, STAFF))
ok("…saying to lift the restriction", "restricted" in m, m)
refuses("…and Approve (which delegates to it) is refused too", ops.approve_partner("S-ban", WHY, STAFF))
eq("…the record is still suspended", next(p for p in DB[C.PARTNERS].docs if p["_id"] == "S-ban")["status"], "suspended")

user("h-revban", agencyId="AG1", hostRevokedAt=_dt(2026, 10, 1), isBanned=True, accountState="banned")
fs.collection("hostApplications").docs["app-revban"] = {"applicantUid": "h-revban", "status": "rejected",
                                                        "agencyId": "AG1"}
refuses("approving an application of a revoked AND banned Host is refused",
        svc.decide_host_application("app-revban", True, WHY, STAFF))
eq("…no Host role granted", users()["h-revban"].get("isHost"), None)

# 9.10 Refusing a pending application keeps a single-role Host's only role.
user("h-legacy", isHost=True, agencyId="AG1")
fs.collection("hostApplications").docs["app-legacy"] = {"applicantUid": "h-legacy", "status": "pending",
                                                        "agencyId": "AG1"}
res_l = run(svc.decide_host_application("app-legacy", False, WHY, STAFF))
eq("the application is refused", fs.collection("hostApplications").docs["app-legacy"]["status"], "rejected")
eq("…the Host role is kept (one role → suspend, never revoke)", users()["h-legacy"]["isHost"], True)

# 9.11 Restore uses the LATEST approved application.
user("h-twoapps", agencyId="AG1", hostRevokedAt=_dt(2026, 10, 1))
fs.collection("hostApplications").docs["app-old"] = {"applicantUid": "h-twoapps", "status": "approved",
                                                     "agencyId": "AG1", "decidedAt": _dt(2025, 1, 1)}
fs.collection("hostApplications").docs["app-new"] = {"applicantUid": "h-twoapps", "status": "approved",
                                                     "agencyId": "AG1", "decidedAt": _dt(2026, 9, 1)}
run(svc.restore_host("h-twoapps", WHY, THE_OWNER))
eq("restore re-uses the latest approved application",
   fs.collection("agencies").document("AG1").collection("agencyHosts").docs["h-twoapps"]["applicationId"], "app-new")

# 9.12 A revoked Host who has applied again is decided on that application, not restored.
user("h-reapplied", agencyId="AG1", hostRevokedAt=_dt(2026, 10, 1))
fs.collection("hostApplications").docs["app-ra-old"] = {"applicantUid": "h-reapplied", "status": "approved", "agencyId": "AG1"}
fs.collection("hostApplications").docs["app-ra-new"] = {"applicantUid": "h-reapplied", "status": "pending", "agencyId": "AG1"}
inv = run(ur.roles_for_crm("h-reapplied"))
eq("no Restore while a new application is pending",
   [r.get("actions") for r in inv["roles"] if r["role"] == "host"], [[]])

# 9.13 The shop flag is not a side door round the one-role rule.
user("s-flag", isSeller=True)
partner("S-flag", "s-flag", "seller", status="approved")
m = refuses("clearing the shop flag of an approved Coin Seller is refused",
            svc.set_seller_flag("s-flag", False, WHY, STAFF, enforce_target_policy=False))
ok("…pointing at the record", "seller record" in m, m)
eq("…the flag stays", users()["s-flag"]["isSeller"], True)
user("s-stale", isSeller=True)
run(svc.set_seller_flag("s-stale", False, WHY, STAFF, enforce_target_policy=False))
eq("a stale flag with no record behind it can still be cleared", users()["s-stale"]["isSeller"], False)

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} UGP role/warning checks passed.")
print("  · role actions only from authoritative records; one role → suspend only")
print("  · Host restore re-uses the existing application, roster and verification")
print("  · warning deduction: role-derived currency, live balance, a linked card, idempotent")
print("  · the card executes against the live balance, whole or not at all, once")
