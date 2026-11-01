"""CONTACT-002 (Phase 1A): a TYPED phone never reaches a Firebase account.

── WHAT THIS FILE USED TO ASSERT, AND WHY IT IS REVERSED ─────────────────────

It asserted that partner approval, and every partner sign-in, called
`update_user_phone(uid, <number from the application form>)`. That number was
typed — by the applicant or by staff — and nobody had proved they hold it.
Attaching it made an unverified claim the account's sign-in identity: whoever
passed OTP for that number afterwards landed on this uid, and the real holder of
the number could be locked out of, or into, an account that was not theirs.

Phase 1A removes the automatic attach. The number reaches the account only by
its holder verifying it with an OTP in the app (`bindVerifiedIdentity`). These
checks pin that: no path calls `update_user_phone` with a typed number, the
caller is told why, and a number the account ALREADY holds (verified) is
recognised so the sign-in self-heal marker still settles.

Run:  python3 -m tests.test_partner_app_login
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.db import firebase as fb  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402

store = FakeFirestore()
crm.firebase.firestore_client = lambda: store
fb.firestore_client = lambda: store

#: Every number Firebase was asked to attach, as (uid, e164).
attached: list[tuple[str, str]] = []
#: Numbers that belong to somebody else's account.
taken: set[str] = set()


def fake_update_user_phone(uid: str, e164: str) -> None:
    if e164 in taken:
        raise RuntimeError("auth/phone-number-already-exists")
    attached.append((uid, e164))


crm.firebase.update_user_phone = fake_update_user_phone
fb.update_user_phone = fake_update_user_phone

#: uid → the number already VERIFIED on that Firebase account.
verified_on_account: dict[str, str] = {}


class _Rec:
    def __init__(self, uid: str):
        self.uid = uid
        self.phone_number = verified_on_account.get(uid)


crm.firebase.get_user = lambda uid: _Rec(uid)
fb.get_user = crm.firebase.get_user

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


# ══════════════════════════════════════════════════════════════════════════════
#  attach_phone_to_login never attaches a typed number
# ══════════════════════════════════════════════════════════════════════════════

attached.clear()
note = crm.attach_phone_to_login("uid-1", "9033247342")
ok("a typed number is NOT attached to the Firebase account", attached == [])
ok("and the caller is told why, and how the person adds it",
   "not attached" in note and "OTP" in note)

attached.clear()
check("a number already verified on the account is recognised, not re-attached",
      (verified_on_account.update({"uid-2": "+919033247342"}) or
       crm.attach_phone_to_login("uid-2", "+91 90332 47342")), "")
check("…with no Firebase write", attached, [])

check("a blank number does nothing", crm.attach_phone_to_login("uid-4", ""), "")
check("a blank uid does nothing", crm.attach_phone_to_login("", "9033247342"), "")

# The takeover shape: the typed number is somebody else's. Before Phase 1A this
# depended on Firebase reporting the conflict; an UNUSED number was simply taken.
attached.clear()
crm.attach_phone_to_login("uid-attacker", "9811111111")
check("an unused number typed onto an application is not claimed", attached, [])


# ══════════════════════════════════════════════════════════════════════════════
#  Approval attaches nothing typed
# ══════════════════════════════════════════════════════════════════════════════

store.collection("agencies").document("ag-1").set(
    {
        "ownerEmail": "owner@agency.com",
        "ownerPhone": "9033247342",
        "agencyName": "Bright Stars",
        "crmUid": "fb-agency-1",
        "status": "approved",
    }
)
attached.clear()
ops._sync_app_partner_role(
    {"_id": "ag-1", "kind": "agency", "name": "Bright Stars"},
    {"status": "approved", "isActive": True},
)
check("approving an agency does NOT attach the typed owner phone", attached, [])
ok("the identity document is still written for staff lookup",
   store.collection("verifiedIdentities").document("9033247342").get().exists)

store.collection("sellers").document("sl-1").set(
    {"email": "seller@coins.com", "phone": "9812345678", "displayName": "Coin Corner",
     "ownerUid": "fb-seller-1", "isApproved": True}
)
attached.clear()
ops._sync_app_partner_role(
    {"_id": "sl-1", "kind": "seller", "name": "Coin Corner"},
    {"status": "approved", "isActive": True},
)
check("approving a seller attaches nothing either", attached, [])


# ══════════════════════════════════════════════════════════════════════════════
#  The sign-in self-heal attaches nothing typed
# ══════════════════════════════════════════════════════════════════════════════

doc = {"role": "agency", "phone": "9033247342", "isActive": True}
store.collection("crmUsers").document("fb-old-1").set(dict(doc))
attached.clear()
note = crm.ensure_app_phone("fb-old-1", doc)
check("sign-in does not attach the typed number", attached, [])
ok("it reports instead", note != "")
after = store.collection("crmUsers").document("fb-old-1").get().to_dict()
ok("and does NOT mark it done", after.get(crm.PHONE_ATTACHED_FIELD) is not True)

# Once the partner has verified it in the app, the next sign-in settles.
verified_on_account["fb-old-1"] = "+919033247342"
check("after an in-app OTP verify, sign-in settles", crm.ensure_app_phone("fb-old-1", after), "")
check("still with no Firebase write", attached, [])
marker = store.collection("crmUsers").document("fb-old-1").get().to_dict()
check("and records that it is done", marker.get(crm.PHONE_ATTACHED_FIELD), True)

attached.clear()
check("a partner with no phone on record is skipped",
      crm.ensure_app_phone("fb-old-2", {"role": "seller"}), "")
check("and a missing document is skipped", crm.ensure_app_phone("fb-old-3", None), "")


# ══════════════════════════════════════════════════════════════════════════════
#  Staff invitation (_attach_app_identity) attaches nothing typed
# ══════════════════════════════════════════════════════════════════════════════

attached.clear()
note = crm._attach_app_identity(uid="staff-1", email="s@zipper.test", phone="9822222222",
                                name="S", crm_role="ops_member")
check("a staff invitation does not attach the typed phone", attached, [])
user = store.collection("users").document("staff-1").get().to_dict() or {}
ok("and does not write it onto the user document as an identity key",
   "phoneNumber" not in user and "phoneKey" not in user)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} CONTACT-002 checks passed.")
print("  · no typed phone is ever attached to a Firebase account")
print("  · approval, sign-in self-heal and staff invitation all refuse it")
print("  · a number verified in the app is recognised and settles the marker")
sys.exit(0)
