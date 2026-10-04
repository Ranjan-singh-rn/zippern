"""A partner's phone reaches their Firebase account — automatically, both ways.

── THE DEFECT ────────────────────────────────────────────────────────────────

`syncMyRoles` decides whether somebody is an agency or a coin seller by reading
`crmUsers/{uid}` — **by uid, and only by uid**. So the badge, the agency
dashboard and the seller dashboard all depend on the app session landing on the
same Firebase account the CRM login uses.

Staff get that for free: their number is put on their account when they are
invited, so phone OTP resolves to their CRM uid. Nothing did it for partners. An
agency owner signing into the app with their phone got a DIFFERENT uid, no
`crmUsers` document, no `isAgent` and no dashboard — while every screen in the
CRM showed them as a fully approved agency.

The number was being written to `verifiedIdentities` instead. That was right
when `syncMyRoles` matched on phone and email; it reads `crmUsers/{uid}` now and
nothing reads that collection for role derivation at all, so the one mechanism
built to tag partners in the app was writing to a file nobody opens.

── WHY TWO PLACES ────────────────────────────────────────────────────────────

Approval fixes every partner approved from now on. Sign-in fixes the ones
approved before this existed. Neither needs anybody to run anything, which is
the actual requirement: a repair script that has to be remembered is a repair
that does not happen.

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
#  The number is normalised the way Firebase needs it
# ══════════════════════════════════════════════════════════════════════════════

attached.clear()
check("a ten-digit Indian number is given a country code",
      crm.attach_phone_to_login("uid-1", "9033247342"), "")
check("and reaches Firebase in E.164", attached[-1], ("uid-1", "+919033247342"))

attached.clear()
crm.attach_phone_to_login("uid-2", "+91 90332 47342")
check("spaces and an existing country code are handled",
      attached[-1], ("uid-2", "+919033247342"))

attached.clear()
crm.attach_phone_to_login("uid-3", "090332-47342")
check("so is a leading zero and a dash", attached[-1], ("uid-3", "+919033247342"))

# ── Nothing to do is not an error ─────────────────────────────────────────────
attached.clear()
check("a blank number does nothing", crm.attach_phone_to_login("uid-4", ""), "")
check("a short number does nothing", crm.attach_phone_to_login("uid-4", "12345"), "")
check("and a blank uid does nothing", crm.attach_phone_to_login("", "9033247342"), "")
check("without calling Firebase at all", attached, [])

# ── A conflict is reported, never raised ──────────────────────────────────────
#
# The number belongs to another account. Taking it off a live account is a
# decision, not a side effect, so this reports and the caller carries on.
taken.add("+919999988888")
note = crm.attach_phone_to_login("uid-5", "9999988888")
ok("a number owned by another account is refused", note != "")
ok("and the message says what it costs them",
   "phone sign-in" in note and "app" in note)
taken.clear()


# ══════════════════════════════════════════════════════════════════════════════
#  Approval attaches it, automatically
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

ok("approving an agency attaches the owner's phone", len(attached) == 1)
check("to the uid the CRM login uses", attached[0], ("fb-agency-1", "+919033247342"))

# The verifiedIdentities write still happens — staff read that collection in the
# CRM — but it is no longer what gets them into the app.
ok("and the identity document is still written",
   store.collection("verifiedIdentities").document("9033247342").get().exists)

# ── A seller is the same, by its own field names ──────────────────────────────
store.collection("sellers").document("sl-1").set(
    {
        "email": "seller@coins.com",
        "phone": "9812345678",
        "displayName": "Coin Corner",
        "ownerUid": "fb-seller-1",
        "isApproved": True,
    }
)

attached.clear()
ops._sync_app_partner_role(
    {"_id": "sl-1", "kind": "seller", "name": "Coin Corner"},
    {"status": "approved", "isActive": True},
)
check("approving a seller attaches theirs too",
      attached[0], ("fb-seller-1", "+919812345678"))

# ── A refusal attaches nothing ────────────────────────────────────────────────
attached.clear()
ops._sync_app_partner_role(
    {"_id": "ag-1", "kind": "agency", "name": "Bright Stars"},
    {"status": "rejected", "isActive": False},
)
check("a rejection attaches no phone", attached, [])


# ══════════════════════════════════════════════════════════════════════════════
#  Sign-in heals the partners approved before any of this existed
# ══════════════════════════════════════════════════════════════════════════════

doc = {"role": "agency", "phone": "9033247342", "isActive": True}
store.collection("crmUsers").document("fb-old-1").set(dict(doc))

attached.clear()
check("the first sign-in attaches it", crm.ensure_app_phone("fb-old-1", doc), "")
check("once", attached, [("fb-old-1", "+919033247342")])

marker = store.collection("crmUsers").document("fb-old-1").get().to_dict()
check("and records that it was done", marker.get(crm.PHONE_ATTACHED_FIELD), True)

# ── And never again ───────────────────────────────────────────────────────────
#
# This runs on every partner sign-in, so a Firebase write each time would be
# both wasteful and a rate limit waiting to happen.
attached.clear()
crm.ensure_app_phone("fb-old-1", marker)
check("a later sign-in calls Firebase not at all", attached, [])

# ── Nothing to heal ───────────────────────────────────────────────────────────
attached.clear()
check("a partner with no phone on record is skipped",
      crm.ensure_app_phone("fb-old-2", {"role": "seller"}), "")
check("and a missing document is skipped", crm.ensure_app_phone("fb-old-3", None), "")
check("with no Firebase calls", attached, [])

# ── A failure does not set the marker ─────────────────────────────────────────
#
# Otherwise one conflict would mark the partner done for ever, and the self-heal
# would never try again after the number was freed.
taken.add("+919999977777")
blocked = {"role": "agency", "phone": "9999977777"}
store.collection("crmUsers").document("fb-old-4").set(dict(blocked))

note = crm.ensure_app_phone("fb-old-4", blocked)
ok("a conflict is reported from the sign-in path too", note != "")
after = store.collection("crmUsers").document("fb-old-4").get().to_dict()
ok("and the partner is NOT marked done",
   after.get(crm.PHONE_ATTACHED_FIELD) is not True)

taken.clear()
attached.clear()
ok("so a later sign-in tries again", crm.ensure_app_phone("fb-old-4", after) == "")
check("and succeeds once the number is free",
      attached, [("fb-old-4", "+919999977777")])


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} partner app-login checks passed.")
print("  · approval attaches the partner's phone to their Firebase account")
print("  · so phone OTP in the app lands on the uid syncMyRoles reads")
print("  · sign-in heals partners approved before this existed, once each")
print("  · a number owned by someone else is reported, never forced")
print("  · and a failed attach is retried rather than marked done")
sys.exit(0)
