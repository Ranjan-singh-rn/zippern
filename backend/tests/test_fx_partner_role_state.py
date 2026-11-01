"""FX-04 — an approved partner's role reaches the app, whatever contact they hold.

RF-01 / B1-11 (reproduced as R2): a person who applied from the app with a
verified PHONE and no email got no `crmUsers` login document at submission
(`crm_directory.mirror` refused an empty address and the error was swallowed),
and approval then wrote one with `status` / `roleStatus` but no `role`. With no
`role`, `app_role_flags` / `deriveRoleFlags` answer "no role", so Mongo said
approved and the app never showed the Agency or Seller tile.

  * the app path writes the login document for a phone-only applicant too
    (no address on it, `emailProven: False` — nothing is invented);
  * approval writes `role` / `roles` when the login document has none;
  * the app flags follow the decision (`push_app_role_flags`);
  * an unrelated role already on the login is preserved;
  * an applicant with a verified email is unchanged.

Decision 15 (RC) changed what "approved" means for a phone-only applicant:
the role starts only with BOTH contacts verified. So sections 1–2 now run
the whole path — staff approval refused, the Owner's approval leaving the
role WAITING (no tile), the email verified, the role starting (tile on).

REAL: services.partner_applications, services.partner_ops, services.crm_directory.
FAKE: Mongo (`tests/fakes.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
      Firebase Auth (`firebase.get_user`, per uid). Guest rule real.

    python3 -m tests.test_fx_partner_role_state
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
from app.services import crm_directory as crm  # noqa: E402
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


run = asyncio.run
db = FakeDb()
fs = FakeFirestore()


async def fake_audit(**kw):
    return "audit-x"


for mod in (ops, partner_svc, roles, apps, money_mod, users_svc):
    mod.get_db = lambda: db  # type: ignore[assignment]
audit_mod.record = fake_audit
ops.audit.record = fake_audit
apps.audit.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUTH: dict[str, types.SimpleNamespace] = {}
firebase_mod.get_user = lambda uid: AUTH.get(uid)  # type: ignore[assignment]
logging.disable(logging.CRITICAL)

STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None}
WHY = "Reviewed and decided."

AGENCY_FORM = {
    "agencyName": "Skyline", "ownerName": "A", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "A", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SELLER_FORM = {
    "displayName": "Coins", "city": "Pune", "idDocUrls": ["https://x/id"],
    "payment": {"upiId": "coins@upi", "accountNumber": "999", "ifscCode": "SBIN0001", "bankName": "SBI"},
}


def person(uid: str, *, phone: str = "", email: str = "", verified: bool = False) -> None:
    AUTH[uid] = types.SimpleNamespace(uid=uid, phone_number=phone, email=email, email_verified=verified)
    doc = {"name": uid, "isProfileComplete": True, "accountState": "active", "isBanned": False, "isSuspended": False}
    if phone:
        doc["phoneNumber"] = phone
    if email and verified:
        doc["email"] = email
    fs.collection("users").docs[uid] = doc


def login(uid: str) -> dict | None:
    return fs.collection("crmUsers").docs.get(uid)


def flags(uid: str) -> dict:
    f = crm.app_role_flags(login(uid))
    return {"isAgent": f.get("isAgent"), "isSeller": f.get("isSeller")}


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. A phone-only Agency applicant — approved, and the app shows it")

person("PH-A", phone="+910000000301")
res = run(apps.submit_partner_application("PH-A", "agency", dict(AGENCY_FORM, ownerEmail=""), None, SERVICE))
A = res["id"]
doc = login("PH-A")
ok("a login document is written at submission for a phone-only applicant", doc is not None, repr(doc))
eq("…naming the capability", (doc or {}).get("role"), "agency")
eq("…pending", (doc or {}).get("status"), "pending")
eq("…linked to the record", (doc or {}).get("agencyId"), A)
eq("…with no address invented", (doc or {}).get("email", ""), "")
eq("…and not proven", (doc or {}).get("emailProven"), False)
eq("while pending, the app shows no Agency tile", flags("PH-A")["isAgent"], False)

# Decision 15: a phone alone does not start a role.
try:
    run(ops.approve_partner(A, WHY, STAFF))
    _staff = None
except ops.PartnerOpsError as exc:
    _staff = exc
ok("a reviewer's approval of a phone-only applicant is refused (both contacts needed)",
   isinstance(_staff, ops.ContactVerificationRequired), repr(_staff))
eq("…machine-readably, naming what is missing",
   (_staff.api_detail() if _staff else {}).get("missing"), ["email"])
eq("…and the record is still pending", db["partners"].docs[A]["status"], "pending")

run(ops.approve_partner(A, WHY, OWNER))
eq("the Owner's approval leaves the role WAITING", db["partners"].docs[A]["status"], "awaiting_verification")
eq("…inactive", db["partners"].docs[A]["is_active"], False)
eq("the login document names the role", (login("PH-A") or {}).get("role"), "agency")
eq("…awaiting verification, not approved", ((login("PH-A") or {}).get("roleStatus") or {}).get("agency"),
   "awaiting_verification")
eq("…and the app shows NO Agency tile yet", flags("PH-A")["isAgent"], False)
eq("…nothing pushed onto users/{uid}", bool(fs.collection("users").docs["PH-A"].get("isAgent")), False)

# The applicant verifies an email (the app's 6-digit code flow sets it on the
# Auth record; this login has no password sign-in method).
AUTH["PH-A"].email, AUTH["PH-A"].email_verified = "ph-a@x.test", True
started = run(ops.activate_for_login("PH-A", {"uid": "PH-A", "name": "PH-A", "role": "agency"}))
eq("once both are verified the role starts", [r.get("activated") for r in started], [True])
eq("…approved and active", (db["partners"].docs[A]["status"], db["partners"].docs[A]["is_active"]), ("approved", True))
eq("after the start the login is approved", (login("PH-A") or {}).get("status"), "approved")
eq("…and the derived app flag is on", flags("PH-A")["isAgent"], True)
eq("…and pushed onto users/{uid}", fs.collection("users").docs["PH-A"].get("isAgent"), True)
eq("starting it again is a no-op (redelivery)",
   [r.get("already_active") for r in run(ops.activate_for_login("PH-A", OWNER))], [])

# ══════════════════════════════════════════════════════════════════════════════
print("2. A phone-only Coin Seller — the same, and the login names the seller record")

person("PH-S", phone="+910000000302")
res = run(apps.submit_partner_application("PH-S", "seller", dict(SELLER_FORM, email=""), None, SERVICE))
S = res["id"]
eq("the seller login document links the seller record", (login("PH-S") or {}).get("sellerId"), S)
run(ops.approve_partner(S, WHY, OWNER))
eq("Owner-approved, waiting: role seller named", (login("PH-S") or {}).get("role"), "seller")
eq("…no Seller tile while waiting", bool(fs.collection("users").docs["PH-S"].get("isSeller")), False)
AUTH["PH-S"].email, AUTH["PH-S"].email_verified = "ph-s@x.test", True
run(ops.activate_partner_if_verified(S, {"uid": "PH-S", "name": "PH-S", "role": "seller"}))
eq("after the start: the app's Seller tile is on", fs.collection("users").docs["PH-S"].get("isSeller"), True)

# ══════════════════════════════════════════════════════════════════════════════
print("3. Approval of a record whose login document never existed writes the role")

person("NOLOGIN", phone="+910000000303", email="nologin@x.test", verified=True)
fs.collection("agencies").docs["AG-NOLOGIN"] = {
    "agencyName": "No login doc", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "NOLOGIN", "crmUid": "NOLOGIN", "source": "crm",
}
run(ops.ensure_partner_record("AG-NOLOGIN", SERVICE, "Registered."))
fs.collection("crmUsers").docs.pop("NOLOGIN", None)
ok("(precondition) no login document", login("NOLOGIN") is None)
run(ops.approve_partner("AG-NOLOGIN", WHY, STAFF))
eq("approval creates it WITH the role", (login("NOLOGIN") or {}).get("role"), "agency")
eq("…and the flag is on", flags("NOLOGIN")["isAgent"], True)

# ══════════════════════════════════════════════════════════════════════════════
print("4. An unrelated role on the same login is preserved")

person("TWO", phone="+910000000304", email="two@x.test", verified=True)
r1 = run(apps.submit_partner_application("TWO", "agency", dict(AGENCY_FORM, agencyName="Two A"), None, SERVICE))
run(ops.approve_partner(r1["id"], WHY, STAFF))
r2 = run(apps.submit_partner_application("TWO", "seller", dict(SELLER_FORM, displayName="Two S"), None, SERVICE))
run(ops.approve_partner(r2["id"], WHY, STAFF))
doc = login("TWO") or {}
eq("the login keeps the capability it was created with", doc.get("role"), "agency")
ok("…and holds both", sorted(doc.get("roles") or []) == ["agency", "seller"], repr(doc.get("roles")))
eq("…both tiles on", flags("TWO"), {"isAgent": True, "isSeller": True})
ok("Agency and Coin Seller are two distinct records", r1["id"] != r2["id"])

# ══════════════════════════════════════════════════════════════════════════════
print("5. A verified-email applicant is unchanged")

person("EM", phone="+910000000305", email="em@x.test", verified=True)
r = run(apps.submit_partner_application("EM", "agency", dict(AGENCY_FORM, agencyName="EM", ownerEmail="em@x.test"),
                                        None, SERVICE))
eq("the login document carries the proven address", (login("EM") or {}).get("email"), "em@x.test")
eq("…proven", (login("EM") or {}).get("emailProven"), True)
run(ops.approve_partner(r["id"], WHY, STAFF))
eq("…and approval turns the flag on", flags("EM")["isAgent"], True)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} FX-04 partner role-state checks passed.")
