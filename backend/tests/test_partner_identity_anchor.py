"""The Firebase uid is the identity anchor — on the partner path too.

── THE RULE ──────────────────────────────────────────────────────────────────

    Firebase uid  →  CRM user/role  →  app role and tag

and never

    email  →  find another uid  →  inherit its role

Authentication providers — a password, a phone number, a Google identity — are
things attached to ONE Firebase account. They are not separate identities, and
matching on one of them is not authorisation.

── WHERE IT WAS NOT TRUE ─────────────────────────────────────────────────────

`_staff_for_authenticated_uid` was hardened for this: uid first, an address
fallback only on a token that authenticated against that address, and an
unreachable row refused rather than adopted.

`_crm_partner_document` — its sibling, two hundred lines away — was not. Its
address fallback had no gate at all, and the document it returns is not merely a
link: `resolve_partner_login` seeds `_claimed_partner_ids` from it, and those
partner ids ARE the authority on the session. So the second chain above was
reachable, on any token carrying the address.

It was not exploitable, because Firebase allows one account per email address,
so a token bearing an agency's address could only belong to the agency's own
account. But nothing here said so, `email_verified` was not consulted, and the
path next door had already decided not to rely on that invariant. A rule that
holds in one of two sibling functions is a rule in the process of drifting.

Run:  python3 -m tests.test_partner_identity_anchor
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# `harness` rather than `fakes`: this test imports `app.core.security`, which
# needs the `jose` stub, and only `harness.install_stubs` provides it.
from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import security  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

store = FakeFirestore()
crm.firebase.firestore_client = lambda: store
fb.firestore_client = lambda: store

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


# The agency, filed under the uid its CRM login uses.
AGENCY_UID = "fb-agency-live"
AGENCY_EMAIL = "owner@brightstars.com"
store.collection("crmUsers").document(AGENCY_UID).set(
    {
        "uid": AGENCY_UID,
        "email": AGENCY_EMAIL,
        "role": "agency",
        "agencyId": "ag-1",
        "isActive": True,
        # P0-5 (AUTHN-1): the server stamped this address as verified on the
        # login's own Auth record — the only kind of document the address
        # fallback may match. tests/test_identity_integrity_p0.py covers the
        # unproven case.
        "emailProven": True,
    }
)


def document_for(uid: str, email: str, *, proven: bool) -> dict:
    doc, _unreadable = security._crm_partner_document(uid, email, email_proven=proven)
    return doc


# ══════════════════════════════════════════════════════════════════════════════
#  The uid always wins, and needs no help
# ══════════════════════════════════════════════════════════════════════════════

found = document_for(AGENCY_UID, AGENCY_EMAIL, proven=True)
check("the agency resolves by its own uid", found.get("agencyId"), "ag-1")

# The point: phone OTP carries no email proof, and the partner must still sign
# in. This is the whole reason the phone is attached to their Firebase account.
found = document_for(AGENCY_UID, "", proven=False)
check("and by uid alone, with no email on the token at all",
      found.get("agencyId"), "ag-1")

found = document_for(AGENCY_UID, AGENCY_EMAIL, proven=False)
check("an unproven email does not stop a correct uid resolving",
      found.get("agencyId"), "ag-1")


# ══════════════════════════════════════════════════════════════════════════════
#  A stranger's uid inherits nothing from a matching address
# ══════════════════════════════════════════════════════════════════════════════

STRANGER = "fb-someone-else"

found = document_for(STRANGER, AGENCY_EMAIL, proven=False)
check("a different uid bearing the agency's address gets NOTHING", found, {})
ok("so no partner id can be claimed from it", "agencyId" not in found)

# Every unproven provider, one at a time. A phone-OTP session is the realistic
# one — it is how the app signs people in — and it must never be a route to a
# role it did not authenticate into.
for label in ("phone OTP", "an anonymous guest", "a provider we do not trust"):
    found = document_for(STRANGER, AGENCY_EMAIL, proven=False)
    check(f"{label} inherits nothing", found, {})

# ── The default is the narrow one ─────────────────────────────────────────────
#
# A caller that forgets the keyword gets uid-only behaviour, not the permissive
# fallback. Forgetting must fail closed.
doc, _ = security._crm_partner_document(STRANGER, AGENCY_EMAIL)
check("omitting the flag entirely is treated as unproven", doc, {})


# ══════════════════════════════════════════════════════════════════════════════
#  With proof, the stale-uid case still works
# ══════════════════════════════════════════════════════════════════════════════

# This is what the fallback exists for: a partner whose `crmUsers` document was
# written under a uid that no longer signs in — a login recreated after a
# deletion. They prove the address with their CRM password, so they are
# recognised and the record can be repaired.
found = document_for("fb-recreated-login", AGENCY_EMAIL, proven=True)
check("a proven address still finds a document filed under an old uid",
      found.get("agencyId"), "ag-1")

ok("which is the ONLY way an address resolves a partner",
   document_for("fb-recreated-login", AGENCY_EMAIL, proven=False) == {})


# ══════════════════════════════════════════════════════════════════════════════
#  A staff document is never answered as a partner
# ══════════════════════════════════════════════════════════════════════════════

store.collection("crmUsers").document("fb-staff-1").set(
    {"uid": "fb-staff-1", "email": "ops@zipper.com", "role": "ops_admin", "isActive": True}
)

found = document_for("fb-staff-1", "ops@zipper.com", proven=True)
check("a staff role is not a partner capability", found, {})
found = document_for("fb-other", "ops@zipper.com", proven=True)
check("and cannot be inherited by address either", found, {})


# ══════════════════════════════════════════════════════════════════════════════
#  `_proves_email` is what the gate is made of
# ══════════════════════════════════════════════════════════════════════════════

# Restated here because the partner path now depends on it. Proof means the
# token authenticated against the ADDRESS — not that the account happens to
# carry a verified one, which says nothing about how this session began.
ok("a verified password sign-in proves the address", security._proves_email({
    "email": AGENCY_EMAIL, "email_verified": True,
    "firebase": {"sign_in_provider": "password"},
}))
ok("so does Google", security._proves_email({
    "email": AGENCY_EMAIL, "email_verified": True,
    "firebase": {"sign_in_provider": "google.com"},
}))
ok("phone OTP does NOT, even on an account with a verified address",
   not security._proves_email({
       "email": AGENCY_EMAIL, "email_verified": True,
       "firebase": {"sign_in_provider": "phone"},
   }))
ok("nor does an unverified address", not security._proves_email({
    "email": AGENCY_EMAIL, "email_verified": False,
    "firebase": {"sign_in_provider": "password"},
}))
ok("nor a token with no address at all", not security._proves_email({
    "email_verified": True, "firebase": {"sign_in_provider": "password"},
}))


# ══════════════════════════════════════════════════════════════════════════════
#  Unreadable is still not the same as absent
# ══════════════════════════════════════════════════════════════════════════════

# The gate must not have turned a Firestore outage into "no account found",
# which is a 401 for every properly linked partner.
original_read = crm.read
crm.read = lambda uid: (_ for _ in ()).throw(RuntimeError("Firestore is unavailable"))

doc, unreadable = security._crm_partner_document(AGENCY_UID, AGENCY_EMAIL, email_proven=False)
check("an outage reports itself rather than answering 'no document'", unreadable, True)
check("with no document", doc, {})

crm.read = original_read


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} partner identity-anchor checks passed.")
print("  · a partner resolves by uid, with or without an email on the token")
print("  · a different uid bearing their address inherits nothing")
print("  · the address fallback needs a token that authenticated against it")
print("  · omitting the flag fails closed")
print("  · a staff document is never answered as a partner capability")
print("  · and a Firestore outage is still distinguishable from no account")
sys.exit(0)
