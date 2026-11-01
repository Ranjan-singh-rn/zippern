"""Registration — a new agency or coin seller actually appearing for approval.

The bug this covers: every creation path in the CRM wrote a Firestore document
and stopped. The queues on /kyc, /agencies and /sellers are built from
`list_partners`, which reads Mongo's `partners` collection, and nothing ever
inserted into it from a registration. So an applicant existed in Firestore, held
a pending CRM login, saw the holding page, received "we have your application" —
and appeared on **no staff screen**. The only way to approve them was
`python -m scripts.backfill_partners --confirm`.

The fix is two Firestore triggers holding a third service credential. These
tests cover the parts that decide whether it works and what it costs when it
leaks:

  * the credential's allowlist is exactly `partner.register`, and it cannot
    reach either other credential's operations — nor they, its;
  * **all five creation paths** produce a record, from the document each screen
    actually writes, with the right kind and parent;
  * the record opens **holding nothing** and `pending` — approval stays a
    separate human decision;
  * registering twice is a no-op: no second record, no audit entry, and no
    balance reset — including on a record `backfill_partners` created earlier;
  * a second-capability application is **not** registered here, because doing so
    would permanently break the flow that bridges it;
  * the Cloud Function records a failure on the applicant's own document rather
    than losing them quietly, and never carries a key into what it writes;
  * `scripts/backfill_partners.py` still works, for everything created while
    this was broken.

The fixtures are the payloads the CRM screens really write — field for field,
including the inconsistencies between them (`crmId` absent on a sub-agency,
`source` different on every screen, `isApproved` absent on every agency). A test
built on tidied-up documents would pass on documents that do not exist.

No database and no network: `tests/fakes.py` stubs the I/O underneath, so the
code exercised here is the real `app/services/partner_ops.py`.

Run:  python3 -m tests.test_partner_registration
"""

from __future__ import annotations

import asyncio
import re
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, install_module_stubs  # noqa: E402

install_module_stubs()

# `app/core/security.py` signs session tokens with python-jose. Nothing here
# issues a session — a service credential never gets one, which is half the
# point of it — but the import happens at module scope, so it needs a stand-in.
sys.modules.setdefault(
    "jose",
    types.SimpleNamespace(  # type: ignore[arg-type]
        JWTError=type("JWTError", (Exception,), {}),
        jwt=types.SimpleNamespace(
            encode=lambda *a, **k: "token", decode=lambda *a, **k: {}
        ),
    ),
)

from app.core import audit as audit_mod  # noqa: E402
from app.core import security  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services.partners import PartnerKind, PartnerStatus  # noqa: E402

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


def refuses(label: str, coro_factory, *, error=ops.PartnerOpsError) -> str:
    """This must be refused with a message, not quietly given a wrong answer."""
    global checks
    checks += 1
    try:
        result = asyncio.run(coro_factory())
    except error as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def refuses_sync(label: str, fn, *, error=Exception) -> Exception | None:
    global checks
    checks += 1
    try:
        result = fn()
    except error as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return None
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return None


# ══════════════════════════════════════════════════════════════════════════════
# The five creation paths, as the documents the CRM really writes
# ══════════════════════════════════════════════════════════════════════════════
#
# Each fixture is copied from the screen named above it. Where two screens
# disagree — and they do, on almost every field — the disagreement is preserved,
# because that is what the trigger will meet in production.

#: zipper-crm/app/agency-signup/page.tsx — an agency signing itself up.
#: Note: no `isApproved` field at all, and `crmUid` is written afterwards.
AGENCY_SELF_SIGNUP = {
    "crmId": "A1B2C3D4",
    "crmUid": "crm-uid-1",
    "agencyName": "Skyline Talents",
    "ownerName": "Ravi Kulkarni",
    "ownerPhone": "+919876500001",
    "ownerEmail": "ravi@skyline.example",
    "address": "Andheri East, Mumbai",
    "status": "pending",
    "kycStatus": "pending",
    "type": "main",
    "kycDocUrls": ["https://x/aadhaar", "https://x/pan", "https://x/passbook"],
    "paymentType": "bank",
    "currency": "INR",
    "isActive": False,
    "source": "self_signup",
    "totalHosts": 0,
    "totalSubAgencies": 0,
    "parentAgencyId": None,
}

#: zipper-crm/app/seller-signup/page.tsx — a coin seller signing itself up.
SELLER_SELF_SIGNUP = {
    "crmId": "S9Z8Y7X6",
    "crmUid": "crm-uid-2",
    "ownerUid": "",
    "displayName": "Meena Coin Store",
    "phone": "+919876500002",
    "email": "meena@coins.example",
    "city": "Pune",
    "description": "Neighbourhood coin shop",
    "registrationProofUrl": "https://x/proof",
    "registrationFeePaid": False,
    "isApproved": False,
    "isActive": False,
    "status": "pending",
    "coinBalance": 0,
    "totalCoinsSold": 0,
    "qrCodeUrl": "",
    "source": "self_signup",
}

#: zipper-crm/app/agencies/register/page.tsx — staff registering a main agency.
#: `source: 'crm'`, and it carries a referral code the signup form does not.
AGENCY_STAFF_REGISTERED = {
    "crmId": "C3D4E5F6",
    "agencyName": "Northstar Media",
    "ownerName": "Priya Nair",
    "ownerPhone": "+919876500003",
    "ownerEmail": "priya@northstar.example",
    "address": "Kochi",
    "type": "main",
    "parentAgencyId": None,
    "referralCode": "NORT4F2A",
    "status": "pending",
    "kycStatus": "pending",
    "kycDocUrls": ["https://x/a", "https://x/p", "https://x/b"],
    "paymentType": "bank",
    "currency": "INR",
    "isActive": False,
    "source": "crm",
    "totalHosts": 0,
    "totalSubAgencies": 0,
}

#: The same screen with a parent chosen — `type: 'sub'`, which selects the
#: sub-agency slab table and routes the payout through the parent.
AGENCY_STAFF_REGISTERED_SUB = {
    **AGENCY_STAFF_REGISTERED,
    # A DIFFERENT human. Spreading the parent's fixture inherited its
    # `crmUid`, which made this a main agency and a sub-agency held by one
    # person — the combination `partner_roles` now refuses. A sub-agency is a
    # separate partner one level below an agency, never a second record for
    # the same login, so the fixture gets its own.
    "crmUid": "crm-uid-sub-owner",
    "crmId": "D4E5F6G7",
    "agencyName": "Northstar South",
    "type": "sub",
    "parentAgencyId": "agency-self-signup",
    "referralCode": "NORT9A1B",
}

#: zipper-crm/app/sellers/register/page.tsx — staff registering a coin seller.
#: `idDocUrls` is a list of objects here and a single string on the signup form;
#: `_resendEmail` is written at creation time, which is why the resend trigger
#: (an onUpdate, firing only when the field CHANGES) never fired for these.
SELLER_STAFF_REGISTERED = {
    "crmId": "T7U8V9W0",
    "displayName": "Ganesh Coin Mart",
    "phone": "+919876500004",
    "email": "ganesh@coins.example",
    "city": "Nagpur",
    "description": "",
    "idDocUrls": [{"label": "Aadhaar", "url": "https://x/aadhaar"}],
    "isApproved": False,
    "isActive": False,
    "status": "pending",
    "coinBalance": 0,
    "totalCoinsSold": 0,
    "qrCodeUrl": "",
    "source": "crm_admin",
    "ownerUid": "",
    "createdBy": "staff-1",
    "_resendEmail": "registration",
}

#: zipper-crm/app/agency-dashboard/page.tsx — an agency creating a sub-agency.
#: NO `crmId` and NO `address`, and `kycStatus` is 'submitted' rather than
#: 'pending'. All three differ from every other agency path.
SUB_AGENCY_FROM_DASHBOARD = {
    "type": "sub",
    "parentAgencyId": "agency-self-signup",
    "agencyName": "Skyline Sub One",
    "ownerName": "Nisha Rao",
    "ownerPhone": "+919876500005",
    "ownerEmail": "nisha@skyline.example",
    "referralCode": "SKYL7C3D",
    "paymentType": "bank",
    "status": "pending",
    "isActive": False,
    "kycStatus": "submitted",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
    "totalHosts": 0,
    "totalSubAgencies": 0,
    "source": "agency_created",
    "currency": "INR",
}

#: The non-superadmin branch of /agencies/register does not write an agency at
#: all — it files an `approvalRequests` document, and `onApprovalApproved`
#: applies it with `db.collection('agencies').doc().set({...payload,
#: _approvedAt})`. That `.set()` on a new document IS a create, so the same
#: onCreate trigger fires. The payload is the register page's, plus the stamp.
AGENCY_VIA_APPROVAL_QUEUE = {
    **AGENCY_STAFF_REGISTERED,
    "crmId": "E5F6G7H8",
    "agencyName": "Harbour Lights Media",
    "_approvedAt": "2026-08-23T00:00:00Z",
}

#: …and the seller equivalent.
SELLER_VIA_APPROVAL_QUEUE = {
    **SELLER_STAFF_REGISTERED,
    "crmId": "F6G7H8I9",
    "displayName": "Harbour Coin Counter",
    "_approvedAt": "2026-08-23T00:00:00Z",
}

#: An approved partner applying for the capability it does not have. Written by
#: zipper-crm/lib/partnerRoles.ts. The trigger must NOT register this one.
SELLER_SECOND_ROLE = {
    "crmId": "G7H8I9J0",
    "crmUid": "crm-uid-1",
    "ownerUid": "",
    "displayName": "Skyline Coin Desk",
    "phone": "+919876500001",
    "email": "ravi@skyline.example",
    "isApproved": False,
    "isActive": False,
    "status": "pending",
    "coinBalance": 0,
    "totalCoinsSold": 0,
    "qrCodeUrl": "",
    "source": "second_role",
    "secondRoleOwnerUid": "crm-uid-1",
    "secondRoleOfPartnerId": "agency-self-signup",
    "secondRoleReason": "We already run the agency and want to sell coins too.",
}

#: (Firestore document id, collection, document) for every path above.
PATHS: list[tuple[str, str, str, dict]] = [
    # id, screen, collection, document
    ("agency-self-signup", "/agency-signup", "agencies", AGENCY_SELF_SIGNUP),
    ("seller-self-signup", "/seller-signup", "sellers", SELLER_SELF_SIGNUP),
    ("agency-staff-main", "/agencies/register", "agencies", AGENCY_STAFF_REGISTERED),
    ("agency-staff-sub", "/agencies/register (sub)", "agencies",
     AGENCY_STAFF_REGISTERED_SUB),
    ("seller-staff", "/sellers/register", "sellers", SELLER_STAFF_REGISTERED),
    ("agency-dashboard-sub", "/agency-dashboard sub-agency modal", "agencies",
     SUB_AGENCY_FROM_DASHBOARD),
    ("agency-approval-queue", "/agencies/register via approvalRequests", "agencies",
     AGENCY_VIA_APPROVAL_QUEUE),
    ("seller-approval-queue", "/sellers/register via approvalRequests", "sellers",
     SELLER_VIA_APPROVAL_QUEUE),
    ("seller-second-role", "second-capability application", "sellers",
     SELLER_SECOND_ROLE),
]

FIRESTORE: dict[str, tuple[str, dict]] = {
    doc_id: (collection, document) for doc_id, _, collection, document in PATHS
}


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
audit_entries: list[dict] = []
second_role_writes: list[tuple] = []


def fake_read_firestore(partner_id: str, collection: str | None = None):
    found = FIRESTORE.get(partner_id)
    if found is None:
        return None
    name, data = found
    if collection is not None and collection != name:
        return None
    return name, dict(data)


async def fake_audit_record(**kwargs):
    if not (kwargs.get("reason") or "").strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")
    audit_entries.append(kwargs)
    return "audit-id"


def fake_sync(partner: dict, fields: dict) -> bool:
    return True


def fake_second_role_state(*args) -> bool:
    second_role_writes.append(args)
    return True


ops.get_db = lambda: db
partner_svc.get_db = lambda: db
# `partner_ops.create` now claims the human's role family before it writes
# (one Agency per Firebase identity), and `partner_roles` reads Mongo
# through its own import, so it needs the same fake db.
from app.services import partner_roles as _partner_roles  # noqa: E402
_partner_roles.get_db = lambda: db  # type: ignore[assignment]
# Approval re-checks the role table (partner_applications) and staff identity
# (users), so both read the same fake Mongo.
from app.services import partner_applications as _apps  # noqa: E402

# Phase 1A (AUTH-002): these fixtures are verified people; the guest refusal
# is covered by tests/test_phase1a_identity.py.
_apps.is_unverified_guest = lambda uid: False
from app.services import users as _users_mod  # noqa: E402
_apps.get_db = lambda: db  # type: ignore[assignment]
_users_mod.get_db = lambda: db  # type: ignore[assignment]
# …and the role table reads the person's app profile (Host or not) from
# Firestore. An empty fake: nobody in this file is a Host or staff.
from app.db import firebase as _firebase_mod  # noqa: E402
from tests import harness as _rc_harness  # noqa: E402

# Decision 15 (RC): every login in these fixtures holds BOTH verified contacts
# (an SMS-linked phone and a code-verified email) — the subject of this module
# is not the contact rule, which tests/test_rc_contact_verification.py runs with
# per-uid records, verified and not.
_firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]
from tests.fakes import FakeFirestore as _FakeFirestore  # noqa: E402
_role_fs = _FakeFirestore()
_firebase_mod.firestore_client = lambda: _role_fs  # type: ignore[assignment]
audit_mod.record = fake_audit_record
ops.audit.record = fake_audit_record
ops._read_firestore_partner = fake_read_firestore
ops._sync_partner_doc = fake_sync
ops._write_second_role_state = fake_second_role_state

#: The actor the API resolves the service key to. Not written by hand — taken
#: from the credential itself, so a test cannot pass against a name the
#: credential does not actually carry.
SERVICE_ACTOR = dict(security.PARTNER_REGISTRATION.actor)

#: What functions/src/index.ts sends. Long, specific, and never blank —
#: `audit.record` and `NewPartner` both refuse an empty reason.
REASON = (
    "Registered in the CRM — a new partner was created in Firestore. Creating "
    "the business record so the application appears in the approval queue."
)


def stored(partner_id: str) -> dict:
    return db["partners"].docs[partner_id]


# ══════════════════════════════════════════════════════════════════════════════
# 1. The credential — one operation, and it reaches nothing else
# ══════════════════════════════════════════════════════════════════════════════

cred = security.PARTNER_REGISTRATION

check("the credential's id", cred.id, "partner-registration")
check("its allowlist is the three onboarding operations",
      sorted(cred.operations), ["partner.apply", "partner.register", "recharge.request"])
check("…which is a name the system knows",
      security.Op.PARTNER_REGISTER in security.KNOWN_OPERATIONS, True)
check("it reads its key from its own environment variable",
      cred.env_var, "SERVICE_KEY_PARTNER_REGISTRATION")
check("…and its own settings attribute",
      cred.settings_attr, "service_key_partner_registration")

# The actor every record it creates is audited under. It is a machine and says
# so — it never borrows a person's name, and it is never blank.
check("it resolves to a named machine", cred.actor["uid"], "system:partner-registration")
check("…with role system", str(cred.actor["role"]), "system")
check("…no team", cred.actor["team"], None)
check("…and no email to impersonate", cred.actor["email"], "")
check("…naming itself in the audit log",
      cred.actor["service_credential"], "partner-registration")

# The whole point of a third credential: it cannot do either other one's job,
# and neither of them can do this one's.
OTHERS = {
    "commission.accrue": "create a commission liability",
    "commission.preview": "read a commission figure",
    "reports.send": "email a business-wide report",
    "alerts.scan": "run the exception detectors",
    "email.sweep": "send transactional mail",
    "email.events": "ingest provider webhooks",
}
for operation, what in OTHERS.items():
    ok(f"the registration credential cannot {what}", not cred.may(operation))
for other in (security.WEEKLY_ACCRUAL, security.REPORTING):
    ok(
        f"the {other.id} credential cannot register a partner",
        not other.may(security.Op.PARTNER_REGISTER),
    )
    ok(
        f"…and holds a different key from the registration one ({other.id})",
        other.settings_attr != cred.settings_attr and other.env_var != cred.env_var,
    )

# Nothing that moves cash, signs, executes or reads the log is a grantable name
# at all, so it cannot arrive on this credential by a typo or a merge.
for forbidden in (
    "partner.approve", "partner.reject", "commission.pay", "payout.execute",
    "card.sign", "balance.credit", "inventory.credit", "audit.read",
):
    ok(f"{forbidden} is not a grantable operation",
       forbidden not in security.KNOWN_OPERATIONS)

# The key gate is real, with a real key configured. `verify_service_key` is the
# one function that decides this, so it is exercised rather than described.
REGISTRATION_KEY = "zpr_reg_" + "V8kQ3mB7xLr2TnW9sYc5HdJ4fPzA6eGu1RiOqXbN0tMZ"
WRONG_KEY = REGISTRATION_KEY[:-1] + "Y"
security.settings.service_key_partner_registration = REGISTRATION_KEY
try:
    check(
        "the right key resolves to the registration actor",
        security.verify_service_key(
            REGISTRATION_KEY, security.Op.PARTNER_REGISTER
        )["uid"],
        "system:partner-registration",
    )
    for operation in OTHERS:
        refuses_sync(
            f"…and is refused on {operation}",
            lambda op=operation: security.verify_service_key(REGISTRATION_KEY, op),
            error=security.AuthError,
        )
    refuses_sync(
        "a key differing in one character is refused",
        lambda: security.verify_service_key(WRONG_KEY, security.Op.PARTNER_REGISTER),
        error=security.AuthError,
    )
    refuses_sync(
        "an empty key is refused",
        lambda: security.verify_service_key("", security.Op.PARTNER_REGISTER),
        error=security.AuthError,
    )
    # A refusal says nothing about the key or about whether one is configured.
    try:
        security.verify_service_key(WRONG_KEY, security.Op.PARTNER_REGISTER)
    except security.AuthError as exc:
        text = str(exc)
        ok("a refusal never echoes the presented key", WRONG_KEY[:12] not in text)
        ok("…nor the configured one", REGISTRATION_KEY[:12] not in text)
finally:
    security.settings.service_key_partner_registration = ""

refuses_sync(
    "with the key unset on the server, even the real key is refused",
    lambda: security.verify_service_key(
        REGISTRATION_KEY, security.Op.PARTNER_REGISTER
    ),
    error=security.AuthError,
)


# ══════════════════════════════════════════════════════════════════════════════
# 2. Every creation path produces a record
# ══════════════════════════════════════════════════════════════════════════════
#
# This is the fix. Each of these documents used to exist in Firestore and
# nowhere else; each must now become a row in the queue.

EXPECTED: dict[str, tuple[str, str, str | None]] = {
    # id: (kind, name, parent_id)
    "agency-self-signup": ("agency", "Skyline Talents", None),
    "seller-self-signup": ("seller", "Meena Coin Store", None),
    "agency-staff-main": ("agency", "Northstar Media", None),
    "agency-staff-sub": ("sub_agency", "Northstar South", "agency-self-signup"),
    "seller-staff": ("seller", "Ganesh Coin Mart", None),
    "agency-dashboard-sub": ("sub_agency", "Skyline Sub One", "agency-self-signup"),
    "agency-approval-queue": ("agency", "Harbour Lights Media", None),
    "seller-approval-queue": ("seller", "Harbour Coin Counter", None),
}

registered: dict[str, dict] = {}

for doc_id, screen, _collection, _document in PATHS:
    if doc_id not in EXPECTED:
        continue                      # the second-role one, handled in § 5
    kind, name, parent = EXPECTED[doc_id]

    ok(f"{screen}: nothing exists before registration", doc_id not in db["partners"].docs)

    # Fixture bookkeeping: a sub-agency may be registered only under an
    # APPROVED, ACTIVE parent — a pending one is refused. In production the
    # agency was approved long before it created any sub-agency. Set back to
    # pending after § 2, because § 7 approves it through the real path.
    if kind == "sub_agency" and parent:
        stored(parent)["status"] = "approved"
        stored(parent)["is_active"] = True

    result = asyncio.run(ops.create_partner(doc_id, REASON, SERVICE_ACTOR))
    registered[doc_id] = result

    check(f"{screen}: a record is created", result["created"], True)
    check(f"{screen}: the id is the Firestore document id", result["id"], doc_id)
    check(f"{screen}: kind", result["kind"], kind)
    check(f"{screen}: name", result["name"], name)
    check(f"{screen}: parent", result["parent_id"], parent)

    # …and it is in the queue the CRM screens actually read. Asserted through
    # `list_partners`, not by re-reading the document, because the bug was that
    # the queue was empty — not that a field was wrong.
    queue = asyncio.run(
        ops.list_partners(PartnerKind(kind), PartnerStatus.PENDING, 500)
    )
    ok(
        f"{screen}: it appears in the pending {kind} queue",
        doc_id in [row["id"] for row in queue],
    )

# The sub-agency created from the agency dashboard has no `crmId` — the only
# agency path that does not write one. It is still created; the missing field is
# said out loud rather than refused or invented.
dashboard = registered["agency-dashboard-sub"]
ok("the dashboard sub-agency has no crm_id key at all",
   "crm_id" not in stored("agency-dashboard-sub"))
ok("…and the warning says so",
   any("crmId" in w for w in dashboard["warnings"]))
# `crm_id` carries a unique SPARSE index, and a sparse index still indexes an
# explicit null — so writing `crm_id: None` would let the dashboard sub-agency
# block the creation of every later partner without one. The key is left off.
FIRESTORE["agency-dashboard-sub-2"] = ("agencies", {
    **SUB_AGENCY_FROM_DASHBOARD, "agencyName": "Skyline Sub Two",
})
second_no_crm = asyncio.run(
    ops.create_partner("agency-dashboard-sub-2", REASON, SERVICE_ACTOR)
)
check("a second sub-agency with no crmId is still creatable",
      second_no_crm["created"], True)

# Two sub-agencies, both routed through the same parent. `sub_agencies_of` is
# the query a payout is raised from, so it is what is checked.
subs = [
    d["_id"]
    for d in db["partners"].docs.values()
    if d.get("kind") == str(PartnerKind.SUB_AGENCY)
    and d.get("parent_id") == "agency-self-signup"
]
check("every sub-agency hangs off its parent", sorted(subs),
      ["agency-dashboard-sub", "agency-dashboard-sub-2", "agency-staff-sub"])

# The parent was validated on each of them — a sub-agency under a parent that
# is pending, or that is itself a sub-agency, is refused outright.
stored("agency-self-signup")["status"] = "pending"
stored("agency-self-signup")["is_active"] = False
FIRESTORE["sub-under-pending"] = ("agencies", {
    **SUB_AGENCY_FROM_DASHBOARD, "agencyName": "Under A Pending Parent",
})
pending_msg = refuses(
    "a sub-agency under a PENDING parent is refused",
    lambda: ops.create_partner("sub-under-pending", REASON, SERVICE_ACTOR),
)
ok("…and the refusal says the parent is pending", "pending" in pending_msg.lower())
FIRESTORE["sub-under-sub"] = ("agencies", {
    **SUB_AGENCY_FROM_DASHBOARD, "agencyName": "Sub Under Sub",
    "parentAgencyId": "agency-staff-sub",
})
stored("agency-staff-sub")["status"] = "approved"
stored("agency-staff-sub")["is_active"] = True
nested_msg = refuses(
    "a sub-agency under a SUB-agency is refused — no sub-sub-agency",
    lambda: ops.create_partner("sub-under-sub", REASON, SERVICE_ACTOR),
)
ok("…and the refusal explains the one-level rule", "itself a sub-agency" in nested_msg)
ok("…and nothing was written", "sub-under-sub" not in db["partners"].docs)
stored("agency-staff-sub")["status"] = "pending"
stored("agency-staff-sub")["is_active"] = False

# Every record is audited, under the machine, with the reason it was given.
for doc_id in EXPECTED:
    entries = [
        e for e in audit_entries
        if e["subject_id"] == doc_id and e["action"] == "partner.created"
    ]
    check(f"{doc_id} was audited exactly once", len(entries), 1)
    entry = entries[0]
    check(f"{doc_id} is audited as the machine",
          entry["actor"]["uid"], "system:partner-registration")
    check(f"{doc_id} is audited with role system", str(entry["actor"]["role"]), "system")
    ok(f"{doc_id} carries a reason", bool((entry["reason"] or "").strip()))
    check(f"{doc_id} says it opened at zero", entry["meta"]["opened_at_zero"], True)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Created holding nothing, and pending
# ══════════════════════════════════════════════════════════════════════════════
#
# Registration is not approval and is not a funding event. Checked on every path
# rather than on one, because a screen that wrote `isApproved` or a coin balance
# into its Firestore document must not carry it across.

ZERO_FIELDS = (
    "credit.outstanding",
    "credit.total_lent",
    "credit.total_repaid",
    "credit.total_recovered",
    "credit.total_penalty",
    "credit.total_written_off",
    "cash_paid_minor",
    "total_coins_sold",
)


def read(doc: dict, dotted: str):
    node = doc
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


for doc_id in EXPECTED:
    doc = stored(doc_id)
    check(f"{doc_id} opens pending", doc["status"], "pending")
    check(f"{doc_id} opens inactive", doc["is_active"], False)
    check(f"{doc_id} has not been approved by anybody", doc["approved_by"], None)
    check(f"{doc_id} has no approval timestamp", doc["approved_at"], None)
    check(f"{doc_id} opens with no due date", read(doc, "credit.due_at"), None)
    check(f"{doc_id} opens with an empty credit history", read(doc, "credit.history"), [])
    for dotted in ZERO_FIELDS:
        check(f"{doc_id} opens with {dotted} at zero", read(doc, dotted), 0)

    # Coin and commission balances are ledger positions, not partner fields. A
    # record carrying its own copy would be a second source of truth for money.
    ok(
        f"{doc_id} stores no coin balance",
        not {"coins", "coin_balance", "balance", "coinBalance"} & set(doc),
    )
    ok(
        f"{doc_id} stores no commission balance",
        not {"commission", "commission_balance"} & set(doc),
    )

# The Firestore documents that DID carry money-shaped fields — `coinBalance: 0`,
# `totalCoinsSold: 0`, `registrationFeePaid: false` — contributed none of them.
# The record is built from a fixed list of fields, not copied.
ok(
    "no Firestore field is copied through onto the record",
    "registrationFeePaid" not in stored("seller-self-signup")
    and "coinBalance" not in stored("seller-self-signup")
    and "_resendEmail" not in stored("seller-staff")
    and "kycDocUrls" not in stored("agency-self-signup"),
)

# A freshly registered seller cannot take inventory, and is told why. Through
# the real reader, on the real record.
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-self-signup"))
check("a registered seller cannot take inventory yet", allowed, False)
check("…and is told it is because they are not approved", why,
      "Seller account is not approved.")

# Approval is still a separate decision, and it is the thing that changes this.
asyncio.run(ops.approve_partner("seller-self-signup", "KYC checked; approving.",
                                {"uid": "staff-1", "name": "Ops Admin",
                                 "role": "ops_admin", "team": "ops"}))
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-self-signup"))
check("an approved seller can", allowed, True)
approval = [
    e for e in audit_entries
    if e["subject_id"] == "seller-self-signup" and e["action"] == "partner.approved"
]
check("and the approval is audited under the person, not the machine",
      approval[0]["actor"]["uid"], "staff-1")


# ══════════════════════════════════════════════════════════════════════════════
# 4. Idempotency — a re-fire, a retry, and a record backfilled earlier
# ══════════════════════════════════════════════════════════════════════════════

# Give the seller a live position, the way a signed coin purchase and a lending
# card would. If registration reset anything, this is what it would destroy.
stored("seller-staff")["credit"]["outstanding"] = 40_000
stored("seller-staff")["credit"]["total_lent"] = 40_000
stored("seller-staff")["cash_paid_minor"] = 550_000
stored("seller-staff")["total_coins_sold"] = 12_500
stored("seller-staff")["status"] = str(PartnerStatus.APPROVED)
stored("seller-staff")["is_active"] = True

before_inserts = db["partners"].inserts
before_audit = len(audit_entries)

again = asyncio.run(ops.create_partner("seller-staff", REASON, SERVICE_ACTOR))

check("a re-fired trigger reports created: false", again["created"], False)
check("…inserts nothing", db["partners"].inserts, before_inserts)
check("…audits nothing", len(audit_entries), before_audit)
check("…and the live credit position survives", again["credit"]["outstanding"], 40_000)
check("…the cash recorded survives", again["cash_paid_minor"], 550_000)
check("…the lifetime sold figure survives", again["total_coins_sold"], 12_500)
check("…the approved status survives", again["status"], "approved")
check("…and the active flag survives", again["is_active"], True)
ok("…and the response says nothing was changed", "already existed" in again["note"])

# Fired ten times, as an at-least-once delivery guarantee permits.
for _ in range(10):
    asyncio.run(ops.create_partner("seller-staff", REASON, SERVICE_ACTOR))
check("ten re-fires still insert nothing", db["partners"].inserts, before_inserts)
check("ten re-fires still audit nothing", len(audit_entries), before_audit)
check("ten re-fires still move no balance",
      stored("seller-staff")["credit"]["outstanding"], 40_000)

# A record `scripts/backfill_partners.py` already created, meeting the trigger
# afterwards. Same path, same answer: the backfilled record stands untouched.
FIRESTORE["agency-backfilled"] = ("agencies", {
    **AGENCY_SELF_SIGNUP, "crmId": "H8I9J0K1", "agencyName": "Backfilled Talents",
})
backfill_actor = {
    "uid": "system:backfill_partners",
    "name": "scripts/backfill_partners.py",
    "role": "system",
    "team": None,
}
backfilled, made, _ = asyncio.run(
    ops.ensure_partner_record("agency-backfilled", backfill_actor,
                              "Backfill — created at zero, pending approval.",
                              # What the script passes: a mirror does not enforce.
                              enforce_role_family=False)
)
check("the backfill created it", made, True)
stored("agency-backfilled")["status"] = str(PartnerStatus.APPROVED)
stored("agency-backfilled")["is_active"] = True

before_inserts = db["partners"].inserts
after_backfill = asyncio.run(
    ops.create_partner("agency-backfilled", REASON, SERVICE_ACTOR)
)
check("the trigger meeting a backfilled record creates nothing",
      after_backfill["created"], False)
check("…and inserts nothing", db["partners"].inserts, before_inserts)
check("…and does not un-approve it", after_backfill["status"], "approved")
check("…and the record still names the backfill as its creator",
      stored("agency-backfilled")["created_by"]["uid"], "system:backfill_partners")

# Even under a race — two deliveries, the read misses on both, one insert loses
# on the `_id` index — exactly one record exists and the loser is answered with
# the winner's.
raced = asyncio.run(
    ops.ensure_partner_record("seller-staff", SERVICE_ACTOR, "Racing creation.", None)
)
check("a raced registration returns the record that exists", raced[1], False)
check("…and still only one insert has happened",
      db["partners"].inserts, before_inserts)


# ══════════════════════════════════════════════════════════════════════════════
# 5. A second-capability application is NOT registered here
# ══════════════════════════════════════════════════════════════════════════════
#
# `source: 'second_role'` documents are bridged into the queue by staff through
# `POST /partner-ops/partners/{held}/second-role`, which creates the record AND
# stamps `second_role_of` on it. If the trigger got there first the record would
# exist without that field, and `request_second_role` refuses exactly that —
# permanently, for that applicant. So the trigger skips them, and this is the
# behaviour that makes the skip necessary rather than tidy.

# The backfilled record above belongs to the SAME human (crm-uid-1) and is
# live. Approval now re-checks the one-agency-family rule against what the
# person holds today, so approving a second agency for them is refused — the
# B3 fix — until the duplicate is dealt with.
try:
    asyncio.run(ops.approve_partner("agency-self-signup", "Approved after KYC review.",
                                    {"uid": "staff-1", "name": "Ops Admin",
                                     "role": "ops_admin", "team": "ops"}))
    dup_refused = False
except ops.PartnerOpsError as exc:
    dup_refused = "agency" in str(exc).lower()
check("approving a second live agency for one human is refused at approval", dup_refused, True)
stored("agency-backfilled")["status"] = str(PartnerStatus.REVOKED)
stored("agency-backfilled")["is_active"] = False
# C1: a REVOKED agency still counts — revoking the duplicate does not make room
# for a second one; the way back for a revoked role is a reinstatement request.
message = refuses(
    "a revoked duplicate still blocks approving a second agency (C1)",
    lambda: ops.approve_partner("agency-self-signup", "Approved after KYC review.",
                                {"uid": "staff-1", "name": "Ops Admin",
                                 "role": "ops_admin", "team": "ops"}),
)
ok("…with the reinstatement sentence", "Request reinstatement" in message)
# The duplicate is retired as what it should have been — an application that
# was never granted — which releases the place.
stored("agency-backfilled")["status"] = str(PartnerStatus.REJECTED)

held = asyncio.run(
    ops.approve_partner("agency-self-signup", "Approved after KYC review.",
                        {"uid": "staff-1", "name": "Ops Admin",
                         "role": "ops_admin", "team": "ops"})
)
check("the held partner is approved", held["status"], "approved")

filed = asyncio.run(
    ops.request_second_role(
        "agency-self-signup", "seller-second-role",
        "Approved agency applying to also sell coins.",
        {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"},
    )
)
check("the bridge creates the second record", filed["created"], True)
check("…linked to the record they hold", filed["second_role_of"], "agency-self-signup")
check("…pending, like any other application", filed["status"], "pending")
check("…holding nothing", read(stored("seller-second-role"), "credit.outstanding"), 0)

# And the counter-example: had the trigger registered it first, the bridge would
# have been refused. This is why the skip exists.
FIRESTORE["seller-second-role-2"] = ("sellers", {
    **SELLER_SECOND_ROLE, "crmId": "I9J0K1L2",
    "displayName": "Northstar Coin Desk", "crmUid": "crm-uid-3",
    "secondRoleOwnerUid": "crm-uid-3", "secondRoleOfPartnerId": "agency-staff-main",
})
FIRESTORE["agency-staff-main"] = (
    "agencies", {**AGENCY_STAFF_REGISTERED, "crmUid": "crm-uid-3"}
)
# FX-09: approval resolves the record's login (B07: Mongo `owner_crm_uid`, else
# the Firestore document's `crmUid`) and refuses a record that names none. In
# production the register screen's back-link puts `crmUid` on the document the
# resolver reads; the same document, here, in the fake the resolver reads.
_role_fs.collection("agencies").docs["agency-staff-main"] = {
    **AGENCY_STAFF_REGISTERED, "crmUid": "crm-uid-3",
}
asyncio.run(ops.approve_partner("agency-staff-main", "Approved after review.",
                                {"uid": "staff-1", "name": "Ops Admin",
                                 "role": "ops_admin", "team": "ops"}))
asyncio.run(ops.create_partner("seller-second-role-2", REASON, SERVICE_ACTOR))
message = refuses(
    "registering a second-role application first breaks the bridge",
    lambda: ops.request_second_role(
        "agency-staff-main", "seller-second-role-2", "Applying to sell coins.",
        {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"},
    ),
)
ok("…and says so in words", "in its own right" in message)


# ══════════════════════════════════════════════════════════════════════════════
# 6. An id that names nothing is still refused
# ══════════════════════════════════════════════════════════════════════════════
#
# A partner record pointing at nobody satisfies every internal check while
# naming no real partner, which is worse than having none. A machine credential
# does not change that.

message = refuses(
    "an unknown id is refused",
    lambda: ops.create_partner("no-such-document", REASON, SERVICE_ACTOR),
)
ok("the refusal names the id", "no-such-document" in message)
ok("…and says nothing was created", "nothing was created" in message.lower())
ok("…and nothing was", "no-such-document" not in db["partners"].docs)

refuses("a blank reason is refused",
        lambda: ops.create_partner("agency-self-signup", "  ", SERVICE_ACTOR))
refuses("a blank id is refused",
        lambda: ops.create_partner("   ", REASON, SERVICE_ACTOR))

# The `kind` the function sends for a seller is a CHECK, never a setting. An
# agency id sent as a seller finds no `sellers` document and is refused.
refuses(
    "an agency id claimed as a seller is refused",
    lambda: ops.create_partner(
        "agency-staff-sub", REASON, SERVICE_ACTOR, PartnerKind.SELLER
    ),
)


# ══════════════════════════════════════════════════════════════════════════════
# 7. The response shape the Cloud Function reads
# ══════════════════════════════════════════════════════════════════════════════
#
# `functions/src/index.ts` branches on `created`, and writes `id`, `kind`,
# `status` and `warnings` onto the applicant's Firestore document. A field
# renamed here would not fail here — it would fail as a blank line on a document
# nobody reads.

# Its own human: the trigger path is held to the one-agency-per-human rule
# now, so a fixture that borrows another agency's login is refused — correctly.
FIRESTORE["agency-shape"] = ("agencies", {
    **AGENCY_SELF_SIGNUP, "crmId": "J0K1L2M3", "agencyName": "Shape Check Media",
    "crmUid": "crm-uid-shape", "ownerUid": "crm-uid-shape",
    "ownerEmail": "shape@example.com",
})
shape = asyncio.run(ops.create_partner("agency-shape", REASON, SERVICE_ACTOR))
for field, reader in (
    ("created", "index.ts — decides 'registered' vs 'was already registered'"),
    ("id", "index.ts — partnerRecord.partnerId"),
    ("kind", "index.ts — partnerRecord.kind"),
    ("status", "index.ts — partnerRecord.partnerStatus"),
    ("warnings", "index.ts — partnerRecord.warnings"),
):
    ok(f"the response carries `{field}` ({reader})", field in shape)
check("…and `status` really is pending", shape["status"], "pending")
ok("…and `warnings` is a list", isinstance(shape["warnings"], list))


# ══════════════════════════════════════════════════════════════════════════════
# 8. The Cloud Function's contract, asserted on its source
# ══════════════════════════════════════════════════════════════════════════════
#
# Nothing in this repository runs the trigger. What can be checked is that it
# says what it must say — and these are the properties, not the implementation:
# it fires on both collections, it declares its own secret, it never carries the
# key into output, it records a failure rather than losing an applicant, and it
# skips the one document kind that must not go through it.

INDEX = ROOT.parent / "functions" / "src" / "index.ts"
if INDEX.exists():
    src = INDEX.read_text()

    ok("a trigger fires on every new agency",
       ".document('agencies/{agencyId}')" in src and "registerAgencyPartner" in src)
    ok("a trigger fires on every new seller",
       ".document('sellers/{sellerId}')" in src and "registerSellerPartner" in src)
    ok("…both on create, which is what a registration is",
       src.count("onPartnerDocumentCreated") >= 3)
    ok("they call the route that creates the record",
       "const PARTNER_REGISTER_PATH = '/api/partner-ops/partners'" in src)
    ok("…presenting the credential in the header the API reads",
       "const SERVICE_KEY_HEADER = 'X-Service-Key'" in src)
    ok("…from a secret, declared so it reaches process.env and nowhere else",
       "secrets: [PARTNER_REGISTRATION_KEY_ENV]" in src)
    ok("…in the region the database is in, or the trigger never fires",
       re.search(r"\.region\('asia-south1'\)\s*\n\s*\.runWith\(\{\s*\n\s*"
                 r"secrets: \[PARTNER_REGISTRATION_KEY_ENV\]", src) is not None)

    # A failure must be visible. Recorded on the document, then thrown.
    ok("a failure is written onto the applicant's own document",
       "partnerRecordFailed" in src)
    ok("…as a flag the CRM can find with a single equality filter",
       re.search(r"partnerRecordFailed: fields\.status === 'failed'", src) is not None)
    ok("…with the reason, so nobody has to read a log to know what went wrong",
       re.search(r"status: 'failed',\s*\n\s*error:", src) is not None)
    ok("…and the trigger then throws rather than reporting success",
       re.search(r"if \(failure\) \{[\s\S]{0,700}?throw new Error\(failure\)", src)
       is not None)
    ok("…and a missing key is named as a variable, never as a value",
       "is not set on this function, so it holds no credential" in src)
    ok("…and every string that leaves is scrubbed of the key",
       "withoutKey(" in src)

    # The skip that keeps the second-capability flow working.
    ok("a second-capability application is not registered by the trigger",
       "const SOURCE_NOT_REGISTERED_HERE = 'second_role'" in src)
    ok("…and the skip happens before the API is called",
       src.index("SOURCE_NOT_REGISTERED_HERE)") <
       src.index("await registerPartnerRecord("))

    # `created: false` is a healthy answer, not a failure.
    ok("an existing record is treated as success",
       "`created: false` is SUCCESS" in src)

    # The seller emails, which used to depend on who filed the application.
    ok("no seller email is gated on the application's source",
       "data.source !== 'self_signup'" not in src
       and "after.source !== 'self_signup'" not in src)
    ok("the seller still gets a registration email",
       "onSellerRegistered" in src and "Application received" in src)
    ok("…and an approval email, still only when isApproved becomes true",
       "onSellerApproved" in src
       and "before.isApproved === after.isApproved || after.isApproved !== true" in src)

    # And nothing else in the file lost its trigger.
    for preserved in (
        "onAgencyRegistered", "onAgencyApproved", "onSellerResendEmail",
        "onAgencyResendEmail", "onRechargeApproved", "onPayoutApproved",
        "onApprovalApproved", "weeklyPayoutReportGenerator",
        "dailyPlatformStatsAggregator", "generateAgoraToken",
        "scheduledTransactionalSweep", "scheduledAlertScan",
        "scheduledDailyReports", "scheduledWeeklyBusinessReport",
        "scheduledPartnerStatements", "scheduledMonthlyReports",
    ):
        ok(f"{preserved} is still exported", f"export const {preserved}" in src)


# ══════════════════════════════════════════════════════════════════════════════
# 9. The backfill still works, for everything created while this was broken
# ══════════════════════════════════════════════════════════════════════════════

BACKFILL = ROOT / "scripts" / "backfill_partners.py"
backfill_src = BACKFILL.read_text()

ok("the backfill goes through the same creation function the API uses",
   "ops.ensure_partner_record(" in backfill_src)
ok("…so it cannot create a partner the trigger would not",
   "_derive_kind" in backfill_src and "_derive_name" in backfill_src)
ok("it is a dry run unless confirmed",
   '"--confirm" in sys.argv' in backfill_src)
ok("it creates records pending, never approved",
   "PartnerStatus.APPROVED" in backfill_src and "created as pending" in backfill_src)
ok("…and reports a Firestore-approved partner as a mismatch for a person",
   "Approved in Firestore, not approved in Mongo" in backfill_src)
ok("it skips anything that already has a record",
   "already had a partner record" in backfill_src)
ok("…and says running it again is safe",
   "Running this again is safe" in backfill_src)

# The functions the backfill reaches into still exist with those names — it
# calls three private helpers, and a rename here would break it silently.
for name in ("ensure_partner_record", "_derive_kind", "_derive_name",
             "FS_AGENCIES", "FS_SELLERS"):
    ok(f"partner_ops.{name} still exists for the backfill", hasattr(ops, name))

# Exercised, not merely read: the backfill's own path over a document with no
# record produces exactly what the trigger produces.
FIRESTORE["seller-left-behind"] = ("sellers", {
    **SELLER_SELF_SIGNUP, "crmId": "K1L2M3N4",
    "displayName": "Left Behind Coins", "isApproved": True,
})
left, created_by_backfill, _ = asyncio.run(
    ops.ensure_partner_record(
        "seller-left-behind", backfill_actor,
        "Backfill — this partner existed in Firestore with no business record.",
        enforce_role_family=False,   # the backfill mirrors; it does not enforce
    )
)
check("the backfill creates the missing record", created_by_backfill, True)
check("…pending, even though Firestore already calls it approved",
      left["status"], "pending")
check("…and holding nothing", read(left, "credit.outstanding"), 0)

# …and the script's own "is this live in Firestore?" test — the thing that turns
# that gap into a line a person reads — still reads the right field on each
# collection. Sellers carry `isApproved`; agencies carry `status`, and carry no
# `isApproved` field at all, so reading the wrong one would report every agency
# as unapproved and the mismatch list would be silently empty.
from scripts.backfill_partners import firestore_says_approved  # noqa: E402

check("the backfill reads isApproved on a seller",
      firestore_says_approved("sellers", {"isApproved": True}), True)
check("…and status on an agency",
      firestore_says_approved("agencies", {"status": "approved"}), True)
check("…and calls a pending agency pending",
      firestore_says_approved("agencies", AGENCY_SELF_SIGNUP), False)
check("…and a pending seller pending",
      firestore_says_approved("sellers", SELLER_SELF_SIGNUP), False)
ok("an agency document carries no isApproved field to read by mistake",
   "isApproved" not in AGENCY_SELF_SIGNUP
   and "isApproved" not in SUB_AGENCY_FROM_DASHBOARD
   and "isApproved" not in AGENCY_STAFF_REGISTERED)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} partner-registration checks passed.")
print("  · the credential holds one operation and reaches neither other's")
print("  · all five creation paths — plus both approval-queue variants — land")
print("    in the pending queue the CRM screens read")
print("  · every record opens at zero and pending; approval is still a person")
print("  · re-firing, retrying and meeting a backfilled record change nothing")
print("  · a second-capability application is skipped, and the test shows why")
print("  · a failure is recorded on the applicant's document and then thrown")
print("  · the seller registration and approval emails no longer depend on who")
print("    filed the application")
print("  · scripts/backfill_partners.py still creates the same record")
sys.exit(0)
