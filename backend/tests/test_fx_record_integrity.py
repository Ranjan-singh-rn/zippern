"""FX phase A + the approved contact rule — record integrity, executed.

What this pins (outputs/gov-phase/RUNTIME-FLOW-AND-DUPLICATE-DOCUMENT-INVESTIGATION.md):

  FX-06  `ensure_partner_record` refuses, for the registration SERVICE actor, a
         Firestore document that names no owner AND no source — the shape of a
         document re-created by a failed trigger write (DUP-02). Ownerless
         documents WITH a source (staff register screens, before the login
         link lands) and owned documents without a source stay accepted.
  FX-09  `approve_partner` refuses a record that names no login ("attach a
         login first") and a record whose owner is suspended or banned — a
         FIRST approval is held to the account restriction like a restore is.
  CONTACT (approved rule) — before any partner application is accepted the
         applicant holds at least one VERIFIED contact on the Firebase Auth
         record; otherwise the refusal is machine-readable
         (`code == "CONTACT_REQUIRED"`, `missing`, `email_unverified`) and
         nothing is written. A typed contact never counts. A document created
         straight in Firestore by a client (`source == 'self_signup'`) is held
         to the same eligibility when the trigger registers it — no bypass.

Unlike most partner suites, the guest rule is NOT stubbed here: the fake
Firebase Auth record is chosen per uid, so the real `is_unverified_guest` runs.

REAL: services.partner_applications, services.partner_ops, services.partner_roles.
FAKE: Mongo (`tests/fakes.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
      Firebase Auth (`firebase.get_user`, per uid).

    python3 -m tests.test_fx_record_integrity
"""

from __future__ import annotations

import asyncio
import logging
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402

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
    """The exception the coroutine raised, or None if it succeeded."""
    try:
        asyncio.run(coro)
    except Exception as exc:  # noqa: BLE001 — the test inspects it
        return exc
    return None


run = asyncio.run

db = FakeDb()
fs = FakeFirestore()
AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


for mod in (ops, partner_svc, roles, apps, money_mod, users_svc):
    mod.get_db = lambda: db  # type: ignore[assignment]
audit_mod.record = fake_audit
ops.audit.record = fake_audit
apps.audit.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

# ── Firebase Auth, per uid ─────────────────────────────────────────────────
AUTH: dict[str, types.SimpleNamespace] = {}


def auth_user(uid: str, *, phone: str = "", email: str = "", verified: bool = False) -> None:
    AUTH[uid] = types.SimpleNamespace(uid=uid, phone_number=phone, email=email, email_verified=verified)


firebase_mod.get_user = lambda uid: AUTH.get(uid)  # type: ignore[assignment]
logging.disable(logging.CRITICAL)

STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None,
           "service_credential": "partner-registration"}
WHY = "Reviewed and decided."


def user(uid: str, **over) -> None:
    """A users/{uid} document. No contact fields: contacts come from AUTH only."""
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str) -> dict | None:
    return db["partners"].docs.get(pid)


AGENCY_FORM = {
    "agencyName": "Skyline", "ownerName": "A", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "A", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SELLER_FORM = {
    "displayName": "Coins R Us", "city": "Pune", "idDocUrls": ["https://x/id"],
    "payment": {"upiId": "coins@upi", "accountNumber": "999", "ifscCode": "SBIN0001", "bankName": "SBI"},
}
HOST_FORM = {
    "hostName": "H", "age": "24", "country": "India", "callRate": "10",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"], "photoUrl": ["https://x/p"],
}


def agencies_docs_of(uid: str) -> list[str]:
    return [i for i, d in fs.collection("agencies").docs.items() if d.get("ownerUid") == uid]


# A live main agency for sub-agencies and hosts to hang under.
user("own-main")
# Decision 15 (RC): the main agency's login holds BOTH contacts, so it may start.
auth_user("own-main", phone="+919700000001", email="main@x.test", verified=True)
fs.collection("agencies").docs["MAIN1"] = {
    "agencyName": "Main One", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "own-main", "crmUid": "own-main", "source": "self_signup",
}
run(ops.ensure_partner_record("MAIN1", SERVICE, "Registered."))
run(ops.approve_partner("MAIN1", WHY, STAFF))

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. FX-06 — a source-less, owner-less document is not a registration")

fs.collection("agencies").docs["STUB1"] = {
    "partnerRecord": {"status": "failed", "error": "No agencies document"}, "partnerRecordFailed": True,
}
exc = refusal(ops.create_partner("STUB1", "Registered by the trigger.", SERVICE))
ok("the service actor's registration of a stub is refused", exc is not None, f"raised: {exc!r}")
eq("…and no Mongo record exists for it", partner("STUB1"), None)
ok("…and the refusal says why", exc is not None and "owner" in str(exc).lower(), str(exc))

# Designed states that must keep working:
fs.collection("agencies").docs["REG1"] = {
    "agencyName": "Registered by staff", "type": "main", "status": "pending", "kycStatus": "submitted",
    "source": "crm", "crmId": "CRMREG01",
}
exc = refusal(ops.create_partner("REG1", "Registered.", SERVICE))
eq("an ownerless document WITH a source (staff register, link pending) is still registered", exc, None)
ok("…as a pending record", (partner("REG1") or {}).get("status") == "pending")

user("legacy-owner")
auth_user("legacy-owner", email="legacy@x.test", verified=True)
fs.collection("agencies").docs["LEG1"] = {
    "agencyName": "Legacy", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "legacy-owner",
}
exc = refusal(ops.create_partner("LEG1", "Registered.", SERVICE))
eq("an OWNED document with no source (legacy) is still registered", exc, None)

fs.collection("agencies").docs["STUB2"] = {"partnerRecord": {"status": "failed"}}
exc = refusal(ops.create_partner("STUB2", "Staff creates the business record by hand.", STAFF))
eq("a STAFF actor may still create a record from such a document (FX-06 scope: the service actor)", exc, None)

# ══════════════════════════════════════════════════════════════════════════════
print("2. FX-09 — approval needs a login, and an unrestricted one")

exc = refusal(ops.approve_partner("REG1", WHY, STAFF))
ok("approving a record that names no login is refused", exc is not None, f"raised: {exc!r}")
ok("…saying to attach a login first", exc is not None and "login" in str(exc).lower(), str(exc))
eq("…and it is still pending", (partner("REG1") or {}).get("status"), "pending")

for state, over in (("suspended", {"accountState": "suspended", "isSuspended": True, "isBanned": True}),
                    ("banned", {"accountState": "banned", "isBanned": True})):
    uid = f"own-{state}"
    user(uid)
    auth_user(uid, email=f"{uid}@x.test", verified=True)
    pid = f"AG-{state}"
    fs.collection("agencies").docs[pid] = {
        "agencyName": f"Agency {state}", "type": "main", "status": "pending", "kycStatus": "submitted",
        "ownerUid": uid, "crmUid": uid, "source": "self_signup",
    }
    run(ops.ensure_partner_record(pid, SERVICE, "Registered."))
    fs.collection("users").docs[uid].update(over)  # restricted AFTER applying
    exc = refusal(ops.approve_partner(pid, WHY, STAFF))
    ok(f"a FIRST approval for a {state} owner is refused", exc is not None, f"raised: {exc!r}")
    ok(f"…naming the restriction ({state})", exc is not None and "restrict" in str(exc).lower(), str(exc))
    eq(f"…and the record stays pending ({state})", (partner(pid) or {}).get("status"), "pending")

# The success case, and an unrelated role preserved.
user("own-clean")
# Decision 15 (RC): both contacts, so the success case may start.
auth_user("own-clean", phone="+919700000002", email="clean@x.test", verified=True)
fs.collection("sellers").docs["SELL-clean"] = {
    "displayName": "Clean seller", "status": "pending", "isApproved": False, "isActive": False,
    "ownerUid": "own-clean", "crmUid": "own-clean", "source": "self_signup", "email": "clean@x.test",
}
run(ops.ensure_partner_record("SELL-clean", SERVICE, "Registered."))
run(ops.approve_partner("SELL-clean", WHY, STAFF))
fs.collection("agencies").docs["AG-clean"] = {
    "agencyName": "Clean agency", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "own-clean", "crmUid": "own-clean", "source": "self_signup",
}
run(ops.ensure_partner_record("AG-clean", SERVICE, "Registered."))
exc = refusal(ops.approve_partner("AG-clean", WHY, STAFF))
eq("an owned record whose owner is unrestricted and verified is approved", exc, None)
eq("…approved", (partner("AG-clean") or {}).get("status"), "approved")
eq("…and the owner's unrelated Coin Seller record is untouched", (partner("SELL-clean") or {}).get("status"),
   "approved")
ok("Agency and Coin Seller stay two distinct records", partner("AG-clean") is not None
   and partner("SELL-clean") is not None and "AG-clean" != "SELL-clean")

# ══════════════════════════════════════════════════════════════════════════════
print("3. CONTACT — submission needs one verified contact; the refusal is machine-readable")

cases = {
    "email-only": dict(email="e1@x.test", verified=True),
    "phone-only": dict(phone="+910000000101"),
    "neither": dict(),
    "unverified-email": dict(email="u1@x.test", verified=False),
}
for label, contact in cases.items():
    for kind in ("agency", "sub_agency", "seller", "host"):
        uid = f"c-{label}-{kind}"
        user(uid)
        auth_user(uid, **contact)
        form = dict(SELLER_FORM if kind == "seller" else HOST_FORM if kind == "host" else AGENCY_FORM)
        # A TYPED contact never counts — the form carries one in every case.
        form.update({"ownerEmail": "typed@x.test", "ownerPhone": "+919999999999",
                     "email": "typed@x.test", "phone": "+919999999999",
                     "applicantEmail": "typed@x.test", "applicantPhone": "+919999999999"})
        if kind == "host":
            coro = apps.submit_host_application(uid, form, "MAIN1", SERVICE)
        else:
            coro = apps.submit_partner_application(uid, kind, form, "MAIN1" if kind == "sub_agency" else None,
                                                   SERVICE)
        exc = refusal(coro)
        allowed = label in ("email-only", "phone-only")
        if allowed:
            eq(f"{label} → {kind} application accepted", exc, None)
        else:
            ok(f"{label} → {kind} application refused", exc is not None, "it was accepted")
            eq(f"{label} → {kind}: machine-readable code", getattr(exc, "code", None), "CONTACT_REQUIRED")
            eq(f"{label} → {kind}: what is missing", sorted(getattr(exc, "missing", []) or []), ["email", "phone"])
            eq(f"{label} → {kind}: the unverified email is named", getattr(exc, "email_unverified", None),
               label == "unverified-email")
            eq(f"{label} → {kind}: one verified contact is enough", getattr(exc, "requirement", None), "one_of")
            if kind != "host":
                eq(f"{label} → {kind}: nothing was written in Firestore", agencies_docs_of(uid)
                   + [i for i, d in fs.collection("sellers").docs.items() if d.get("ownerUid") == uid], [])
            else:
                eq(f"{label} → host: no host application was written",
                   [i for i, d in fs.collection("hostApplications").docs.items() if d.get("applicantUid") == uid], [])

# No Auth record at all — fail closed, same machine-readable refusal.
user("c-noauth")
exc = refusal(apps.submit_partner_application("c-noauth", "agency", AGENCY_FORM, None, SERVICE))
eq("a uid with no Auth record is refused CONTACT_REQUIRED", getattr(exc, "code", None), "CONTACT_REQUIRED")

# The detail the API returns for it (what the router sends and the callable forwards).
exc = refusal(apps.submit_partner_application("c-neither-agency", "agency", AGENCY_FORM, None, SERVICE))
detail = apps.refusal_detail(exc) if hasattr(apps, "refusal_detail") else None
ok("the API detail is a dict carrying the code", isinstance(detail, dict) and detail.get("code") == "CONTACT_REQUIRED",
   repr(detail))
ok("…with the message for the screen", isinstance(detail, dict) and bool(detail.get("message")), repr(detail))
ok("…and what is missing", isinstance(detail, dict) and sorted(detail.get("missing") or []) == ["email", "phone"],
   repr(detail))
plain = apps.refusal_detail(apps.ApplicationError("x")) if hasattr(apps, "refusal_detail") else None
eq("an ordinary refusal stays a plain sentence", plain, "x")

# Eligibility tells the app the same thing BEFORE the form is filled in.
el = run(apps.eligibility("c-neither-agency"))
ok("eligibility carries a contact block for a guest", isinstance(el.get("contact"), dict), repr(el.get("contact")))
eq("…required", (el.get("contact") or {}).get("required"), True)
eq("…and the code", (el.get("contact") or {}).get("code"), "CONTACT_REQUIRED")
el2 = run(apps.eligibility("c-unverified-email-agency"))
eq("…and names an unverified email", (el2.get("contact") or {}).get("emailUnverified"), True)
el3 = run(apps.eligibility("c-email-only-agency"))
eq("a verified person's contact block says not required", (el3.get("contact") or {}).get("required"), False)

# ══════════════════════════════════════════════════════════════════════════════
print("4. CONTACT / no bypass — a client-created Firestore document is held to the same rules")


def client_doc(pid: str, uid: str, *, collection: str = "agencies") -> None:
    if collection == "agencies":
        fs.collection("agencies").docs[pid] = {
            "agencyName": f"Direct {pid}", "type": "main", "status": "pending", "kycStatus": "pending",
            "ownerUid": uid, "source": "self_signup", "ownerEmail": "typed@x.test",
        }
    else:
        fs.collection("sellers").docs[pid] = {
            "displayName": f"Direct {pid}", "status": "pending", "isApproved": False, "isActive": False,
            "ownerUid": uid, "source": "self_signup", "email": "typed@x.test",
        }


# A Host creating an agency document directly (Host + Agency is forbidden).
user("d-host", isHost=True, agencyId="MAIN1")
auth_user("d-host", phone="+910000000201")
client_doc("DIRECT-host", "d-host")
exc = refusal(ops.create_partner("DIRECT-host", "Registered by the trigger.", SERVICE))
ok("a Host's directly-created agency document is refused at registration", exc is not None, f"raised: {exc!r}")
eq("…no Mongo record", partner("DIRECT-host"), None)

# A guest (no verified contact) creating one directly.
user("d-guest")
auth_user("d-guest", email="g@x.test", verified=False)
client_doc("DIRECT-guest", "d-guest", collection="sellers")
exc = refusal(ops.create_partner("DIRECT-guest", "Registered by the trigger.", SERVICE, partner_svc.PartnerKind.SELLER))
ok("a guest's directly-created seller document is refused", exc is not None, f"raised: {exc!r}")
eq("…CONTACT_REQUIRED", getattr(exc, "code", None), "CONTACT_REQUIRED")
eq("…no Mongo record", partner("DIRECT-guest"), None)

# Staff creating one directly.
user("d-staff")
auth_user("d-staff", email="staff@x.test", verified=True)
run(db["staff"].insert_one({"_id": "staff-row-d", "uid": "d-staff", "role": "ops_admin", "email": "staff@x.test",
                            "active": True}))
client_doc("DIRECT-staff", "d-staff")
exc = refusal(ops.create_partner("DIRECT-staff", "Registered by the trigger.", SERVICE))
ok("an internal staff account's directly-created agency is refused", exc is not None, f"raised: {exc!r}")

# A banned account creating one directly.
user("d-banned", accountState="banned", isBanned=True)
auth_user("d-banned", email="b@x.test", verified=True)
client_doc("DIRECT-banned", "d-banned")
exc = refusal(ops.create_partner("DIRECT-banned", "Registered by the trigger.", SERVICE))
ok("a banned account's directly-created agency is refused", exc is not None, f"raised: {exc!r}")

# The legitimate CRM public signup: a new, verified login, holding nothing.
user("d-fresh")
auth_user("d-fresh", email="fresh@x.test", verified=True)
client_doc("DIRECT-fresh", "d-fresh")
exc = refusal(ops.create_partner("DIRECT-fresh", "Registered by the trigger.", SERVICE))
eq("a verified, eligible public signup is still registered", exc, None)
ok("…pending", (partner("DIRECT-fresh") or {}).get("status") == "pending")

# A staff-source document whose login is unverified is NOT newly blocked at
# registration (whether such logins are exempt is FX-17, a business decision).
user("d-stafflogin", createdVia="crm")
auth_user("d-stafflogin", email="sl@x.test", verified=False)
fs.collection("agencies").docs["STAFFSRC"] = {
    "agencyName": "Staff source", "type": "main", "status": "pending", "kycStatus": "submitted",
    "crmUid": "d-stafflogin", "source": "crm", "crmId": "CRMSTF01",
}
exc = refusal(ops.create_partner("STAFFSRC", "Registered by the trigger.", SERVICE))
eq("a staff-registered document is registered as before (decision FX-17 pending)", exc, None)

# Idempotency of the registration path is unchanged.
again = run(ops.create_partner("DIRECT-fresh", "Registered again (redelivery).", SERVICE))
eq("registering the same document twice is a no-op", again.get("created"), False)
eq("…one record", sum(1 for p in db["partners"].docs.values() if p.get("_id") == "DIRECT-fresh"), 1)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} FX record-integrity and contact-rule checks passed.")
