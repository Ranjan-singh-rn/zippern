"""Decision 15 (RC) — approval is not activation until BOTH contacts are verified.

The confirmed rule, verbatim from the request:

  * The Owner may approve a CRM-created partner application even when contact
    verification is incomplete.
  * Approval must not activate the partner role until both phone and email
    are bound to the account and independently verified.
  * This applies to every partner role, including Agency, Sub-agency, Host,
    and Coin Seller.
  * Sending login credentials or a password-reset link by email is not proof
    of email verification.
  * Unverified partner accounts must have no partner privileges, dashboard
    access, or protected partner actions.
  * Enforce the rule on the server, not only in Android or CRM UI.
  * Once both contacts are verified, activate the role through the correct
    audited lifecycle path without creating duplicate records or identities.

Clarified with the user (RC-2): the scope is every partner application (app
self-applications included); only the Owner may approve while verification
is incomplete; verification is done on the partner's own login; a contact
that belongs to another ZIPPER account blocks activation and alerts staff,
and nothing is merged.

What runs here is the REAL service code against in-memory fakes — a
service-level integration test, NOT an end-to-end test. No HTTP server, no
emulator, no Firebase. The Firebase Auth record is chosen PER UID (phone,
email, `email_verified`, sign-in providers), because the whole subject is
which records count as verified; nothing here forces anyone verified.

REAL: services.contact_verification, partner_ops (approve / activate /
      restore / revoke), partner_activation, users (Host decisions, Host
      activation), partner_applications (submission, eligibility),
      core.security.resolve_partner_login, core.account_state.partner_refusal,
      core.deps (own_partner_id_or_403, own_session_uid), and the router
      functions of the self-scoped routes, called directly.
FAKE: Mongo (`tests/fakes.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
      Firebase Auth (`firebase.get_user*`, per uid), the Owner alert email.

    python3 -m tests.test_rc_contact_verification
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import auth_record, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
mongo.get_db = lambda: db  # type: ignore[assignment]


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

from app.core import account_state  # noqa: E402
from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import security  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

AUDIT: list[dict] = []


async def fake_audit(**kw):
    # The real entry builder runs, so a malformed actor (a system actor with no
    # name, a person borrowing the `system:` prefix) fails here as it would.
    audit_mod._entry(**{k: kw.get(k) for k in (
        "actor", "action", "subject_type", "subject_id", "reason", "before", "after", "card_id", "meta")})
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

# ── Firebase Auth, per uid ─────────────────────────────────────────────────
AUTH: dict[str, object] = {}
AUTH_DOWN: set[str] = set()


def _get_user(uid):
    if uid in AUTH_DOWN:
        raise RuntimeError("Firebase Auth is unreachable")
    return AUTH.get(uid)


def _by_phone(phone):
    return next((r for r in AUTH.values() if getattr(r, "phone_number", "") == phone), None)


def _by_email(email):
    e = str(email or "").strip().lower()
    return next((r for r in AUTH.values() if str(getattr(r, "email", "") or "").lower() == e), None)


firebase_mod.get_user = _get_user  # type: ignore[assignment]
firebase_mod.get_user_by_phone = _by_phone  # type: ignore[assignment]
firebase_mod.get_user_by_email = _by_email  # type: ignore[assignment]

from app.services import contact_verification as cv  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import partner_activation as activation  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import role_appeals  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, partner_svc, roles, apps, money_mod, users_svc, activation, security):
    if hasattr(mod, "get_db"):
        mod.get_db = lambda: db  # type: ignore[assignment]
for mod in (ops, apps, users_svc, activation):
    mod.audit.record = fake_audit

OWNER_MAIL: list[dict] = []


async def fake_email_owners(**kw):
    OWNER_MAIL.append(kw)
    return {"sent": 1}


role_appeals.email_owners = fake_email_owners
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
    except Exception as exc:  # noqa: BLE001 — the test inspects it
        return exc
    return None


run = asyncio.run

STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None,
           "service_credential": "partner-registration"}
WHY = "Documents checked against the originals."

AGENCY_FORM = {
    "agencyName": "Skyline", "ownerName": "A", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "A", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SELLER_FORM = {
    "displayName": "Coins", "city": "Pune", "idDocUrls": ["https://x/id"],
    "payment": {"upiId": "coins@upi", "accountNumber": "999", "ifscCode": "SBIN0001", "bankName": "SBI"},
}
HOST_FORM = {
    "hostName": "H", "age": "24", "country": "India", "callRate": "10",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"], "photoUrl": ["https://x/p"],
}


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False,
                                        "isProfileComplete": True, **over}


def auth(uid: str, *, phone: str = "", email: str = "", verified: bool = False,
         providers: tuple[str, ...] = ()) -> None:
    AUTH[uid] = auth_record(uid, phone=phone, email=email, email_verified=verified, providers=providers)


def ledger_email(uid: str, address: str) -> None:
    """What `verifyLoginEmailCode` / `verifyEmailBindCode` write after a 6-digit code."""
    fs.collection(cv.LEDGER).docs[uid] = {
        **fs.collection(cv.LEDGER).docs.get(uid, {}),
        "email": {"address": address, "verifiedAt": "t", "method": "email_code"},
    }


def partner(pid: str) -> dict:
    return db["partners"].docs.get(pid) or {}


def login(uid: str) -> dict:
    return fs.collection("crmUsers").docs.get(uid) or {}


def actions(subject_id: str) -> list[str]:
    return [a["action"] for a in AUDIT if a.get("subject_id") == subject_id]


def awaiting(pid: str) -> bool:
    p = partner(pid)
    return p.get("status") == "awaiting_verification" and p.get("is_active") is False


def started(pid: str) -> bool:
    p = partner(pid)
    return p.get("status") == "approved" and p.get("is_active") is True


def check_now(uid: str) -> dict:
    return run(activation.check_and_activate(uid, activation.activation_actor(uid)))


# A live main agency for sub-agencies and hosts to hang under (both contacts).
user("own-main")
auth("own-main", phone="+919700000001", email="main@x.test", verified=True)
fs.collection("agencies").docs["MAIN1"] = {
    "agencyName": "Main One", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "own-main", "crmUid": "own-main", "source": "self_signup",
}
run(ops.ensure_partner_record("MAIN1", SERVICE, "Registered."))
run(ops.approve_partner("MAIN1", WHY, STAFF))

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. What counts as verified — read from the Auth record and the server ledger only")

auth("V-none")
v = cv.status("V-none")
eq("neither contact: both missing", v.missing, ["phone", "email"])

auth("V-phone", phone="+910000000001")
eq("phone only: email missing", cv.status("V-phone").missing, ["email"])

auth("V-app-email", email="app@x.test", verified=True)  # app account: no password method
v = cv.status("V-app-email")
eq("an app account's verified email counts (no password sign-in method)",
   (v.email_verified, v.email_method), (True, "no_password_provider"))
eq("…and the phone is still missing", v.missing, ["phone"])

# The CRM-created login: a password account. Staff sent the credentials /
# set-password link — Firebase records nothing as verified for that.
auth("V-crm-sent", email="crm@x.test", verified=False, providers=("password",))
v = cv.status("V-crm-sent")
eq("credentials or a reset link SENT: the email is not verified", v.email_verified, False)
eq("…and is reported as an unproved address", v.email_unproved, True)

# Completing a reset (or Firebase's own link) marks `emailVerified` — still
# not our proof for a password account (U-05; the confirmed decision requires
# the server's own 6-digit code).
auth("V-crm-reset", email="reset@x.test", verified=True, providers=("password",))
v = cv.status("V-crm-reset")
eq("a password account whose address Firebase marked verified (reset/link): NOT verified here",
   v.email_verified, False)
eq("…unproved", v.email_unproved, True)

ledger_email("V-crm-reset", "reset@x.test")
v = cv.status("V-crm-reset")
eq("…until our 6-digit code is recorded for that exact address",
   (v.email_verified, v.email_method), (True, "email_code"))

auth("V-crm-moved", email="new@x.test", verified=True, providers=("password",))
ledger_email("V-crm-moved", "old@x.test")
eq("a code recorded for a DIFFERENT address proves nothing about this one",
   cv.status("V-crm-moved").email_verified, False)

auth("V-google", email="g@x.test", verified=True, providers=("password", "google.com"))
v = cv.status("V-google")
eq("a linked Google sign-in with the same address proves it",
   (v.email_verified, v.email_method), (True, "google"))

AUTH["V-google-other"] = auth_record("V-google-other", email="mine@x.test", email_verified=True,
                                     providers=("password",))
AUTH["V-google-other"].provider_data.append(type(AUTH["V-google-other"].provider_data[0])(
    provider_id="google.com", email="someone-else@x.test"))
eq("a Google sign-in for ANOTHER address does not prove this one",
   cv.status("V-google-other").email_verified, False)

auth("V-unverified", email="u@x.test", verified=False)
eq("an unverified address on an app account does not count", cv.status("V-unverified").email_verified, False)

v = cv.status("V-nobody")
eq("no Auth record: nothing verified, and said so", (v.no_account, v.missing), (True, ["phone", "email"]))

auth("V-down", phone="+910000000002", email="d@x.test", verified=True)
AUTH_DOWN.add("V-down")
eq("Auth unreachable: nothing counts (fail closed)", cv.status("V-down").complete, False)
AUTH_DOWN.discard("V-down")

auth("V-ledger-down", email="ld@x.test", verified=True, providers=("password",))
ledger_email("V-ledger-down", "ld@x.test")
_orig_read = cv._read_ledger
cv._read_ledger = lambda uid: {}  # the ledger could not be read
eq("ledger unreadable: a password account's email does not count", cv.status("V-ledger-down").email_verified, False)
cv._read_ledger = _orig_read

pub = cv.status("V-crm-reset").public()
ok("the person's own view masks the values", "reset@x.test" not in repr(pub) and "@x.test" in repr(pub), repr(pub))

# ══════════════════════════════════════════════════════════════════════════════
print("2. A CRM-created Agency approved before verification — approval ≠ activation")

user("CRM-A")
auth("CRM-A", email="crm-a@x.test", verified=False, providers=("password",))
fs.collection("agencies").docs["AG-CRM"] = {
    "agencyName": "Staff-made agency", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "CRM-A", "crmUid": "CRM-A", "source": "crm", "ownerEmail": "crm-a@x.test",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
fs.collection("crmUsers").docs["CRM-A"] = {"uid": "CRM-A", "role": "agency", "status": "pending",
                                           "agencyId": "AG-CRM", "isActive": True, "email": "crm-a@x.test"}
run(ops.ensure_partner_record("AG-CRM", SERVICE, "Registered."))

exc = refusal(ops.approve_partner("AG-CRM", WHY, STAFF))
ok("a reviewer (not the Owner) is refused", isinstance(exc, ops.ContactVerificationRequired), repr(exc))
eq("…machine-readably", (exc.api_detail() if exc else {}).get("code"), "CONTACT_VERIFICATION_REQUIRED")
eq("…naming both contacts", (exc.api_detail() if exc else {}).get("missing"), ["phone", "email"])
eq("…and nothing changed", partner("AG-CRM").get("status"), "pending")

res = run(ops.approve_partner("AG-CRM", WHY, OWNER))
eq("the Owner's approval succeeds", res.get("awaiting_verification"), True)
ok("…and the role WAITS: awaiting_verification, inactive", awaiting("AG-CRM"), repr(partner("AG-CRM")))
eq("…the approval is on record as the Owner's", (partner("AG-CRM").get("approved_by") or {}).get("uid"), "owner-1")
ok("…audited as approved-pending-verification",
   ops.Act.PARTNER_APPROVED_PENDING_VERIFICATION in actions("AG-CRM"), repr(actions("AG-CRM")))
ok("…and NOT as a start", ops.Act.PARTNER_ACTIVATED not in actions("AG-CRM"))
eq("the Firestore agency is not active", fs.collection("agencies").docs["AG-CRM"].get("isActive"), False)
eq("…and says what it waits for", fs.collection("agencies").docs["AG-CRM"].get("activationPending"),
   ["phone", "email"])
eq("the login's per-role status is awaiting (grants nothing in the rules / routing)",
   (login("CRM-A").get("roleStatus") or {}).get("agency"), "awaiting_verification")
eq("…the login stays signable, for the waiting room", login("CRM-A").get("isActive"), True)
eq("no app flag is derived from it", crm.app_role_flags(login("CRM-A")).get("isAgent"), False)
eq("no referral code was issued (that belongs to the start)",
   fs.collection("agencies").docs["AG-CRM"].get("referralCode"), None)

# Server-side: no privileges, no dashboard.
pl = run(security.resolve_partner_login("CRM-A", "crm-a@x.test", email_proven=False))
eq("sign-in gives the waiting-room session: no partner ids", dict(pl.partner_ids) if pl else None, {})
eq("…status awaiting_verification", pl.status if pl else None, "awaiting_verification")
sess = {"uid": "CRM-A", "role": "agency", "partner_ids": {}}
try:
    deps.own_partner_id_or_403(sess, "AG-CRM", kind="agency")
    _scoped = None
except Exception as e:  # noqa: BLE001
    _scoped = e
ok("every scoped partner route refuses that session (dashboard, money, statements)",
   getattr(_scoped, "status_code", None) == 403, repr(_scoped))
r = account_state.partner_refusal(partner("AG-CRM"))
eq("and a session that somehow named the record is refused", getattr(r, "reason", None),
   "partner_awaiting_verification")

# Approving again does not start it around the verification.
exc = refusal(ops.approve_partner("AG-CRM", WHY, OWNER))
ok("Approve again (even by the Owner) does not bypass it", isinstance(exc, ops.ContactVerificationRequired),
   repr(exc))
exc = refusal(ops.reactivate_partner("AG-CRM", WHY, OWNER))
ok("Restore on a waiting role does not bypass it either", isinstance(exc, ops.ContactVerificationRequired),
   repr(exc))
exc = refusal(ops.activate_partner_if_verified("AG-CRM", OWNER))
ok("nor does the staff Start button", isinstance(exc, ops.ContactVerificationRequired), repr(exc))
ok("…still waiting", awaiting("AG-CRM"))

# The person signs in and verifies — one contact at a time.
AUTH["CRM-A"].email_verified = True   # completes the set-password reset: Firebase marks it
out = check_now("CRM-A")
eq("password reset completed (Firebase says verified) — still not started", out["started"], [])
ok("…still waiting", awaiting("CRM-A") or awaiting("AG-CRM"))

AUTH["CRM-A"].phone_number = "+910000000111"   # the SMS link in the CRM panel
out = check_now("CRM-A")
eq("verified phone + unproved email: not started", out["started"], [])
ok("…still waiting", awaiting("AG-CRM"))
eq("…and the phone is noted in the server ledger", (fs.collection(cv.LEDGER).docs.get("CRM-A") or {})
   .get("phone", {}).get("method"), "sms")

ledger_email("CRM-A", "crm-a@x.test")   # the 6-digit code in the CRM panel
out = check_now("CRM-A")
eq("both verified: the role starts", [s.get("activated") for s in out["started"]], [True])
ok("…approved and active", started("AG-CRM"), repr(partner("AG-CRM")))
ok("…audited as a START by the system", ops.Act.PARTNER_ACTIVATED in actions("AG-CRM"))
start_entry = next(a for a in AUDIT if a.get("subject_id") == "AG-CRM" and a["action"] == ops.Act.PARTNER_ACTIVATED)
eq("…the actor is the contact-verification system, not the person", start_entry["actor"]["uid"],
   activation.ACTIVATION_ACTOR_UID)
ok("…and the reason names who asked", "CRM-A" in start_entry["reason"], start_entry["reason"])
eq("the Owner's approval stays the approval on record", (partner("AG-CRM").get("approved_by") or {}).get("uid"),
   "owner-1")
eq("…and the start names the system", (partner("AG-CRM").get("activated_by") or {}).get("uid"),
   activation.ACTIVATION_ACTOR_UID)
eq("…the start is recorded separately", (partner("AG-CRM").get("activation") or {}).get("state"), "started")
eq("the login is approved", (login("CRM-A").get("roleStatus") or {}).get("agency"), "approved")
eq("…the Firestore agency is active", fs.collection("agencies").docs["AG-CRM"].get("isActive"), True)
eq("…its waiting note is gone", "activationPending" in fs.collection("agencies").docs["AG-CRM"], False)
# (The referral code is issued at the start too; the shared fake's positional
# `where(...)` is not supported, so `_ensure_referral_code` cannot be observed
# here — it is covered by the approval suites.)
pl = run(security.resolve_partner_login("CRM-A", "crm-a@x.test", email_proven=False))
eq("sign-in now carries the agency id", dict(pl.partner_ids) if pl else None, {"agency": "AG-CRM"})
eq("one partner record, not two", [p["_id"] for p in db["partners"].docs.values() if p.get("owner_crm_uid") == "CRM-A"],
   ["AG-CRM"])

out = check_now("CRM-A")
eq("checking again starts nothing twice", out["started"], [])
eq("…one start in the audit trail", actions("AG-CRM").count(ops.Act.PARTNER_ACTIVATED), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("3. Each half alone stays inactive — every role (Agency, Sub-agency, Coin Seller)")

cases = [
    ("agency", None, AGENCY_FORM),
    ("sub_agency", "MAIN1", AGENCY_FORM),
    ("seller", None, SELLER_FORM),
]
for kind, parent, form in cases:
    for label, setup in (
        ("email-only", dict(email="EMAIL", verified=True)),
        ("phone-only", dict(phone="PHONE")),
    ):
        uid = f"H-{kind}-{label}"
        user(uid)
        digits = str(abs(hash(uid)) % 10**9).zfill(9)
        auth(uid, phone=("+91" + digits) if setup.get("phone") else "",
             email=f"{uid.lower()}@x.test" if setup.get("email") else "",
             verified=bool(setup.get("verified")))
        f = dict(form, agencyName=f"{kind} {label}", displayName=f"{kind} {label}")
        res = run(apps.submit_partner_application(uid, kind, f, parent, SERVICE))
        pid = res["id"]
        exc = refusal(ops.approve_partner(pid, WHY, STAFF))
        ok(f"{kind} {label}: a reviewer's approval is refused", isinstance(exc, ops.ContactVerificationRequired),
           repr(exc))
        run(ops.approve_partner(pid, WHY, OWNER))
        ok(f"{kind} {label}: the Owner's approval leaves it waiting", awaiting(pid), repr(partner(pid)))
        out = check_now(uid)
        eq(f"{kind} {label}: checking starts nothing", out["started"], [])
        ok(f"{kind} {label}: still waiting", awaiting(pid))
        flags = crm.app_role_flags(login(uid))
        eq(f"{kind} {label}: no app tile", (flags.get("isAgent"), flags.get("isSeller")), (False, False))
        # Now the missing half.
        if label == "email-only":
            AUTH[uid].phone_number = "+91" + digits
        else:
            AUTH[uid].email, AUTH[uid].email_verified = f"{uid.lower()}@x.test", True
        out = check_now(uid)
        eq(f"{kind} {label}: with the other half verified it starts", [s.get("activated") for s in out["started"]],
           [True])
        ok(f"{kind} {label}: approved and active", started(pid), repr(partner(pid)))

# ══════════════════════════════════════════════════════════════════════════════
print("4. Two activations at once start the role once")

user("RACE")
auth("RACE", email="race@x.test", verified=True)
res = run(apps.submit_partner_application("RACE", "seller", dict(SELLER_FORM, displayName="Race"), None, SERVICE))
RP = res["id"]
run(ops.approve_partner(RP, WHY, OWNER))
AUTH["RACE"].phone_number = "+910000000999"


async def _both():
    a = activation.activation_actor("RACE")
    return await asyncio.gather(
        ops.activate_partner_if_verified(RP, a),
        ops.activate_partner_if_verified(RP, a),
        return_exceptions=True,
    )


outs = run(_both())
eq("both calls answer without an error", [isinstance(o, Exception) for o in outs], [False, False])
eq("exactly one of them started it", sorted(bool(o.get("activated")) for o in outs), [False, True])
eq("one start in the audit trail", actions(RP).count(ops.Act.PARTNER_ACTIVATED), 1)
ok("approved and active", started(RP))

# ══════════════════════════════════════════════════════════════════════════════
print("5. A Host self-application — the same rule, on the Host lifecycle")

user("HOST-1")
auth("HOST-1", phone="+910000000201")   # phone sign-in, no email yet
res = run(apps.submit_host_application("HOST-1", dict(HOST_FORM), "MAIN1", SERVICE))
HA = res["id"]
exc = refusal(users_svc.decide_host_application(HA, True, WHY, STAFF))
ok("a reviewer's approval is refused", isinstance(exc, users_svc.HostContactVerificationRequired), repr(exc))
eq("…machine-readably", (exc.api_detail() if exc else {}).get("missing"), ["email"])
eq("…the application is still pending", fs.collection("hostApplications").docs[HA]["status"], "pending")

run(users_svc.decide_host_application(HA, True, WHY, OWNER))
app_doc = fs.collection("hostApplications").docs[HA]
eq("the Owner's approval: the application waits", app_doc["status"], "awaiting_verification")
eq("…saying for what", app_doc.get("activationPending"), ["email"])
eq("…not activated", app_doc.get("isActivated"), False)
eq("…and the account is NOT a Host", fs.collection("users").docs["HOST-1"].get("isHost"), None)

exc = refusal(apps.submit_host_application("HOST-1", dict(HOST_FORM), "MAIN1", SERVICE))
ok("a second Host application while one waits is refused", exc is not None, "it was accepted")
ok("…saying it is approved and waiting", exc is not None and "verified" in str(exc), str(exc))

out = check_now("HOST-1")
eq("checking before the email is verified starts nothing", [s for s in out["started"] if s.get("activated")], [])
eq("…the account is still not a Host", fs.collection("users").docs["HOST-1"].get("isHost"), None)

AUTH["HOST-1"].email, AUTH["HOST-1"].email_verified = "host1@x.test", True  # app 6-digit code
out = check_now("HOST-1")
eq("both verified: the Host role starts", [s.get("activated") for s in out["started"]], [True])
eq("…the account is a Host", fs.collection("users").docs["HOST-1"].get("isHost"), True)
eq("…of the agency it applied to", fs.collection("users").docs["HOST-1"].get("agencyId"), "MAIN1")
app_doc = fs.collection("hostApplications").docs[HA]
eq("…the application is approved and activated", (app_doc["status"], app_doc.get("isActivated")),
   ("approved", True))
eq("…its waiting note is gone", "activationPending" in app_doc, False)
eq("…on the roster once", list(fs.collection("agencies").document("MAIN1").collection("agencyHosts").docs).count("HOST-1"), 1)
grant = [a for a in AUDIT if a.get("subject_id") == "HOST-1" and a["action"] == audit_mod.Action.HOST_GRANTED]
eq("…granted through grant_host, audited once", len(grant), 1)
eq("…by the contact-verification system", grant[0]["actor"]["uid"] if grant else None,
   activation.ACTIVATION_ACTOR_UID)
out = check_now("HOST-1")
eq("checking again grants nothing twice", out["started"], [])
eq("…still one grant", len([a for a in AUDIT if a.get("subject_id") == "HOST-1"
                            and a["action"] == audit_mod.Action.HOST_GRANTED]), 1)

# A waiting Host application whose start is refused (the person was restricted
# in between) stays waiting, and one refusal does not stop anything else.
user("HOST-2")
auth("HOST-2", phone="+910000000202")
res = run(apps.submit_host_application("HOST-2", dict(HOST_FORM), "MAIN1", SERVICE))
HB = res["id"]
run(users_svc.decide_host_application(HB, True, WHY, OWNER))
fs.collection("users").docs["HOST-2"].update({"accountState": "suspended", "isSuspended": True, "isBanned": True})
AUTH["HOST-2"].email, AUTH["HOST-2"].email_verified = "host2@x.test", True
out = check_now("HOST-2")
eq("a restricted account's waiting Host role does not start", [s.get("activated") for s in out["started"]], [False])
ok("…and the refusal is reported for that application", bool(out["started"] and out["started"][0].get("refusal")),
   repr(out["started"]))
eq("…which keeps waiting", fs.collection("hostApplications").docs[HB]["status"], "awaiting_verification")
eq("…and the account is not a Host", fs.collection("users").docs["HOST-2"].get("isHost"), None)

# ══════════════════════════════════════════════════════════════════════════════
print("6. Restoring a revoked role needs both contacts — no waiting state, no bypass")

user("REV")
auth("REV", phone="+910000000301", email="rev@x.test", verified=True)
res = run(apps.submit_partner_application("REV", "seller", dict(SELLER_FORM, displayName="Rev"), None, SERVICE))
RV = res["id"]
run(ops.approve_partner(RV, WHY, STAFF))
ok("(precondition) a fully verified applicant starts at approval", started(RV))
db["partners"].docs[RV].update({"status": "revoked", "is_active": False})
AUTH["REV"].phone_number = ""   # the number moved to another account since
exc = refusal(ops.reactivate_partner(RV, "Reinstated after review.", OWNER))
ok("the Owner's restore is refused while a contact is missing", isinstance(exc, ops.ContactVerificationRequired),
   repr(exc))
eq("…still revoked", partner(RV).get("status"), "revoked")
AUTH["REV"].phone_number = "+910000000302"
exc = refusal(ops.reactivate_partner(RV, "Reinstated after review.", OWNER))
eq("with both verified the restore goes through", exc, None)
ok("…approved and active", started(RV))

# ══════════════════════════════════════════════════════════════════════════════
print("7. A contact held by another account — blocked, reported, nothing merged")

user("CONF")
auth("CONF", email="conf@x.test", verified=True)
auth("OTHER", phone="+910000000401")   # the person's other ZIPPER account holds the number
mail_before = len(OWNER_MAIL)
res = run(activation.report_conflict("CONF", "phone", "+910000000401", activation.activation_actor("CONF")))
eq("the conflict is recognised", res.get("conflict"), True)
ok("…audited on the person", activation.CONTACT_CONFLICT in actions("CONF"))
entry = next(a for a in AUDIT if a.get("subject_id") == "CONF" and a["action"] == activation.CONTACT_CONFLICT)
eq("…naming the other account (an id, not the number)", entry["after"].get("other_account"), "OTHER")
ok("…the number itself is masked", "+910000000401" not in repr(entry), repr(entry))
eq("…the Owners are alerted", len(OWNER_MAIL) - mail_before, 1)
eq("…both accounts are untouched (no merge)", (AUTH["OTHER"].phone_number, AUTH["CONF"].phone_number),
   ("+910000000401", ""))
res = run(activation.report_conflict("CONF", "phone", "+910000000499", activation.activation_actor("CONF")))
eq("a number nobody holds is not a conflict", res.get("conflict"), False)
eq("…and nobody is alerted", len(OWNER_MAIL) - mail_before, 1)

# The self-scoped routes answer the same either way — not an "is this number
# taken?" oracle — and act on the session's own uid only.
from app.routers import partner_ops as router  # noqa: E402

body = router.MyContactConflict(contact="phone", value="+910000000401")
a1 = run(router.my_verification_conflict(body, {"uid": "CONF", "role": "agency", "partner_ids": {}}))
body2 = router.MyContactConflict(contact="phone", value="+910000000488")
a2 = run(router.my_verification_conflict(body2, {"uid": "CONF", "role": "agency", "partner_ids": {}}))
eq("the route's answer does not reveal whether a conflict was found", a1, a2)
ok("the /me body has no field that could name another account",
   not any(f.endswith("uid") or f.endswith("_id") for f in getattr(router.MyContactConflict, "__annotations__", {})))
try:
    deps.own_session_uid({"role": "agency"})
    _no_uid = None
except Exception as e:  # noqa: BLE001
    _no_uid = e
eq("a session naming no account is refused by own_session_uid", getattr(_no_uid, "status_code", None), 403)
ov = run(router.my_verification({"uid": "CRM-A", "role": "agency", "partner_ids": {"agency": "AG-CRM"}}))
eq("/me/verification reports the caller's own state", ov["verification"]["complete"], True)

# ══════════════════════════════════════════════════════════════════════════════
print("8. Eligibility tells the applicant, before the form, that the role needs both")

el = run(apps.eligibility("V-phone"))
eq("activation requirement is 'both'", (el.get("activation") or {}).get("requirement"), "both")
eq("…and what is missing", (el.get("activation") or {}).get("missing"), ["email"])
eq("…while applying still needs only one (the FX-CR rule is unchanged)", el["contact"]["required"], False)

# ══════════════════════════════════════════════════════════════════════════════
print("9. No server path sets a phone number without SMS (the phone half's premise)")

import ast  # noqa: E402

src_files = [p for p in (ROOT / "app").rglob("*.py") if "__pycache__" not in str(p)]
callers: list[str] = []
setters: list[str] = []
creates: list[str] = []
for p in src_files:
    tree = ast.parse(p.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        name = fn.attr if isinstance(fn, ast.Attribute) else (fn.id if isinstance(fn, ast.Name) else "")
        if name == "update_user_phone":
            callers.append(f"{p.relative_to(ROOT)}:{node.lineno}")
        for kw in node.keywords:
            if kw.arg != "phone_number":
                continue
            valued = not (isinstance(kw.value, ast.Constant) and kw.value.value is None)
            if name == "update_user" and valued:
                setters.append(f"{p.relative_to(ROOT)}:{node.lineno}")
            if name == "create_user":
                creates.append(f"{p.relative_to(ROOT)}:{node.lineno}")
eq("nothing calls firebase.update_user_phone (comments do not count; calls do)", callers, [])
eq("the only Auth phone write with a value is that dead helper's body", setters, ["app/db/firebase.py:163"])
eq("no account is created with a phone number", creates, [])

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} Decision 15 contact-verification checks passed.")
