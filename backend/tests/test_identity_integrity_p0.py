"""P0-5 (AUTHN-1) — a typed partner address is a claim, not an identity.

Before this, an app partner application's typed `ownerEmail` was mirrored onto
`users/{uid}.email` and `crmUsers/{uid}.email` through the Admin SDK:

  * on `users` it squatted the address — its real owner was refused as
    `active_holder` when binding it — and misrouted every lookup by email;
  * on `crmUsers` the backend's proven-email fallback matched it, so a token
    proving that address under ANOTHER uid was handed this partner's document.

Now:

  * the login document carries the address the SIGN-IN holds verified when
    there is one, and the typed address only when there is not;
  * every partner login document is stamped `emailProven` by the server, from
    the Firebase Auth record;
  * a partner's address reaches `users/{uid}` only when proven, and an address
    already there is never blanked;
  * the sign-in fallback matches only `emailProven: true` documents;
  * staff mirrors are unchanged.

Run:  python3 -m tests.test_identity_integrity_p0
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

_email = types.ModuleType("app.services.email")
_email.send_staff_invitation = lambda **kw: None
_email.send_staff_access_added = lambda **kw: None
sys.modules.setdefault("app.services.email", _email)

from app.core import security  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import partner_applications as pa  # noqa: E402

store = FakeFirestore()
crm.firebase.firestore_client = lambda: store
fb.firestore_client = lambda: store


class AuthUser:
    def __init__(self, uid, email=None, email_verified=False, phone=None):
        self.uid = uid
        self.email = email
        self.email_verified = email_verified
        self.phone_number = phone
        self.provider_data = []


auth_records: dict[str, AuthUser] = {}
fb.get_user = lambda uid: auth_records.get(uid)

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def eq(label: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}\n    want {want!r}\n    got  {got!r}")


def users_doc(uid: str) -> dict:
    snap = store.collection("users").document(uid).get()
    return snap.to_dict() if snap.exists else {}


def crm_doc(uid: str) -> dict:
    snap = store.collection("crmUsers").document(uid).get()
    return snap.to_dict() if snap.exists else {}


def mirror_partner(uid: str, email: str, partner_id: str = "ag-1"):
    return crm.mirror(
        uid=uid, email=email, name="Owner", role=Role.AGENCY, created_by="system",
        phone="", partner_id=partner_id, partner_status="pending",
    )


# ══════════════════════════════════════════════════════════════════════════════
#  1. A typed address the sign-in does not hold never reaches `users`
# ══════════════════════════════════════════════════════════════════════════════

auth_records["p-phone-only"] = AuthUser("p-phone-only", phone="+919800000001")
out = mirror_partner("p-phone-only", "victim@example.test")
eq("typed + not on the sign-in: users/{uid} gets no email", users_doc("p-phone-only").get("email"), None)
eq("…and the login document is stamped unproven", crm_doc("p-phone-only").get("emailProven"), False)
ok("…and the outcome says why", "only once it is verified" in out.detail)

auth_records["p-unverified"] = AuthUser("p-unverified", email="typed@example.test", email_verified=False)
mirror_partner("p-unverified", "typed@example.test")
eq("on the sign-in but UNVERIFIED: still no users email", users_doc("p-unverified").get("email"), None)
eq("…and still unproven", crm_doc("p-unverified").get("emailProven"), False)

auth_records["p-other"] = AuthUser("p-other", email="real@example.test", email_verified=True)
mirror_partner("p-other", "typed@example.test")
eq("a typed address that differs from the verified one is not written to users",
   users_doc("p-other").get("email"), None)
eq("…and is unproven", crm_doc("p-other").get("emailProven"), False)

# ══════════════════════════════════════════════════════════════════════════════
#  2. A verified address on the sign-in is written, and proven
# ══════════════════════════════════════════════════════════════════════════════

auth_records["p-verified"] = AuthUser("p-verified", email="Owner@Example.test", email_verified=True)
mirror_partner("p-verified", "owner@example.test")
eq("verified on the sign-in: users/{uid}.email is written",
   users_doc("p-verified").get("email"), "owner@example.test")
eq("…and the login document is proven", crm_doc("p-verified").get("emailProven"), True)

# ══════════════════════════════════════════════════════════════════════════════
#  3. An address already on the app account is never blanked
# ══════════════════════════════════════════════════════════════════════════════

store.collection("users").document("p-has-email").set({"name": "x", "email": "mine@example.test"})
auth_records["p-has-email"] = AuthUser("p-has-email", phone="+919800000002")
mirror_partner("p-has-email", "someone-else@example.test")
eq("an unproven mirror leaves the existing users email alone",
   users_doc("p-has-email").get("email"), "mine@example.test")

# ══════════════════════════════════════════════════════════════════════════════
#  4. Staff mirrors are unchanged
# ══════════════════════════════════════════════════════════════════════════════

crm.mirror(uid="s-ops", email="ops@zipper.test", name="Ops", role=Role.OPS_ADMIN,
           created_by="owner-a")
eq("a staff mirror still writes the staff address to users", users_doc("s-ops").get("email"),
   "ops@zipper.test")
ok("…and carries no emailProven stamp", "emailProven" not in crm_doc("s-ops"))

# ══════════════════════════════════════════════════════════════════════════════
#  5. The sign-in fallback matches only server-proven documents
# ══════════════════════════════════════════════════════════════════════════════

store.collection("crmUsers").document("old-unproven").set({
    "uid": "old-unproven", "email": "squat@example.test", "role": "agency",
    "agencyId": "ag-squat", "isActive": True, "emailProven": False,
})
store.collection("crmUsers").document("old-legacy").set({
    "uid": "old-legacy", "email": "legacy@example.test", "role": "agency",
    "agencyId": "ag-legacy", "isActive": True,
})
store.collection("crmUsers").document("old-proven").set({
    "uid": "old-proven", "email": "proven@example.test", "role": "agency",
    "agencyId": "ag-proven", "isActive": True, "emailProven": True,
})
doc, _ = security._crm_partner_document("new-uid", "squat@example.test", email_proven=True)
eq("a PROVEN token under another uid gets nothing from an unproven document", doc, {})
doc, _ = security._crm_partner_document("new-uid", "legacy@example.test", email_proven=True)
eq("…nor from a document with no stamp at all", doc, {})
doc, _ = security._crm_partner_document("new-uid", "proven@example.test", email_proven=True)
eq("a server-proven document still resolves a recreated login", doc.get("agencyId"), "ag-proven")
doc, _ = security._crm_partner_document("old-unproven", "", email_proven=False)
eq("the document's own uid still resolves it, stamp or not", doc.get("agencyId"), "ag-squat")

# ══════════════════════════════════════════════════════════════════════════════
#  6. The application uses the sign-in's verified address, not the typed one
# ══════════════════════════════════════════════════════════════════════════════

_vle = getattr(pa, "_verified_login_email", None)
if _vle is None:
    ok("partner_applications._verified_login_email exists", False)
else:
    eq("_verified_login_email: a verified address, lower-cased", _vle("p-verified"), "owner@example.test")
    eq("_verified_login_email: unverified → ''", _vle("p-unverified"), "")
    eq("_verified_login_email: none on the sign-in → ''", _vle("p-phone-only"), "")
    eq("_verified_login_email: no Auth record → ''", _vle("nobody"), "")

mirrored: list[dict] = []


async def _capture_mirror(**kw):
    mirrored.append(kw)
    return crm.Outcome(action="written", uid=kw["uid"], email=kw["email"], crm_role="agency", detail="")


async def _noop(*a, **k):
    return None


async def _user_doc(uid):
    return {"name": "applicant"}


async def _ensure(partner_id, actor, reason, kind):
    return ({"_id": partner_id}, True, [])


async def _submitted(uid, kind, pid):
    return True


pa.crm.amirror = _capture_mirror
pa._user_doc = _user_doc
pa._refuse_if_ineligible = _noop
pa.ops.ensure_partner_record = _ensure
pa.ops._generate_crm_id = lambda: "CRM-1"
pa.audit.record = _noop
pa.notices.partner_submitted = _submitted

FORM = {
    "agencyName": "Skyline", "ownerName": "A", "ownerPhone": "+911", "ownerEmail": "typed@example.test",
    "address": "1 Road", "paymentType": "india", "accountHolderName": "A", "accountNumber": "123",
    "ifscCode": "HDFC0001", "bankName": "HDFC", "branch": "Main",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None}

asyncio.run(pa.submit_partner_application("p-other", "agency", FORM, None, SERVICE))
eq("a verified sign-in: the login document gets the VERIFIED address, not the typed one",
   mirrored[-1]["email"], "real@example.test")
asyncio.run(pa.submit_partner_application("p-phone-only", "agency", FORM, None, SERVICE))
eq("no verified address: the typed one is used (and stamped unproven by mirror)",
   mirrored[-1]["email"], "typed@example.test")
agency = [d for d in store.collection("agencies").docs.values() if d.get("ownerUid") == "p-other"]
eq("the typed address stays on the partner record as contact information",
   agency[0].get("ownerEmail") if agency else None, "typed@example.test")

# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} P0-5 identity-integrity checks passed.")
sys.exit(0)
