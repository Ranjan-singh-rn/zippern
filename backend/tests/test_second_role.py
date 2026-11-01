"""One partner, two capabilities — agency and coin seller on a single login.

The thing worth testing here is not that a second record can be created. It is
that creating one **changes nothing about the first**, that the money stays in
two places, and that a partner with one capability takes none of the new code
paths at all.

So the module is built around three claims:

  1. Filing a second capability creates a SECOND record, `pending`, holding
     nothing — not a column on the existing one.
  2. Approving it grants the capability and cross-links the two records, and the
     commission balance and the coin inventory are still two different things on
     two different records under two different holder types.
  3. A single-capability partner is byte-identical: same document, same fields,
     same audit entries, in the same order.

No database and no network: `tests/fakes.py` stubs the I/O underneath, so the
code exercised here is the real `app/services/partner_ops.py`.

Run:  python3 -m tests.test_second_role
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.services import money as money_mod  # noqa: E402
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


def refuses(label: str, coro_factory) -> str:
    global checks
    checks += 1
    try:
        result = asyncio.run(coro_factory())
    except ops.PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted PartnerOpsError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ── Firestore fixtures ────────────────────────────────────────────────────────
#
# `crmUid` is the load-bearing field: it is the ONLY statement anywhere that a
# partner document and a CRM login are the same person, and it is what the
# second-capability path reads rather than trusting a uid from the caller.

AGENCY = {
    "crmId": "A1B2C3D4",
    "crmUid": "login-ravi",
    "type": "main",
    "ownerEmail": "ravi@skyline.example",
    "agencyName": "Skyline Talents",
    "status": "pending",
}

# The seller document the agency above files as its second capability.
AGENCY_SECOND_SELLER = {
    "crmId": "S1S2S3S4",
    "crmUid": "login-ravi",
    "displayName": "Skyline Coin Desk",
    "email": "ravi@skyline.example",
    "source": "second_role",
    "isApproved": False,
    "isActive": False,
    "coinBalance": 0,
    "totalCoinsSold": 0,
}

SELLER = {
    "crmId": "S9Z8Y7X6",
    "crmUid": "login-meena",
    "displayName": "Meena Coin Store",
    "email": "meena@coins.example",
    "isApproved": False,
}

# The agency document the seller above files as its second capability.
SELLER_SECOND_AGENCY = {
    "crmId": "A9A8A7A6",
    "crmUid": "login-meena",
    "type": "main",
    "ownerEmail": "meena@coins.example",
    "agencyName": "Meena Talents",
    "source": "second_role",
    "status": "pending",
}

# A perfectly ordinary partner that never asks for anything. Its whole job is to
# prove that none of this touched it.
PLAIN_SELLER = {
    "crmId": "P1P2P3P4",
    "crmUid": "login-plain",
    "displayName": "Corner Shop Coins",
    "email": "plain@coins.example",
}

# Somebody else's seller account, already trading.
STRANGER_SELLER = {
    "crmId": "X1X2X3X4",
    "crmUid": "login-stranger",
    "displayName": "Stranger Coins",
    "email": "stranger@coins.example",
}

# A seller document with no CRM login written back onto it.
ORPHAN_SELLER = {"crmId": "O1O2O3O4", "displayName": "Orphan Coins"}

FIRESTORE: dict[str, tuple[str, dict]] = {
    "agency-ravi": ("agencies", AGENCY),
    "seller-ravi": ("sellers", AGENCY_SECOND_SELLER),
    "seller-meena": ("sellers", SELLER),
    "agency-meena": ("agencies", SELLER_SECOND_AGENCY),
    "seller-plain": ("sellers", PLAIN_SELLER),
    "seller-stranger": ("sellers", STRANGER_SELLER),
    "seller-orphan": ("sellers", ORPHAN_SELLER),
}


# ── Wiring ────────────────────────────────────────────────────────────────────

db = FakeDb()
audit_entries: list[dict] = []
synced: list[tuple[str, dict]] = []
#: Every `crmUsers` / cross-link write the Admin SDK would have made.
crm_writes: list[tuple[str, str, dict]] = []
crm_users: dict[str, dict] = {}


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
    synced.append((str(partner["_id"]), fields))
    return True


def fake_crm_write(
    owner_uid: str,
    kind,
    status: str,
    partner_id: str,
    held_partner_id: str,
) -> bool:
    """Stands in for `_write_second_role_state` — the Admin SDK half.

    It reproduces the same `roles` arithmetic against an in-memory `crmUsers`
    store, so the test asserts on the document a login would actually end up
    with rather than on the fact that a function was called.
    """
    name = "seller" if str(kind) == str(PartnerKind.SELLER) else "agency"
    link_field = "sellerId" if name == "seller" else "agencyId"
    existing = crm_users.setdefault(owner_uid, {})
    held = [
        r
        for r in (existing.get("roles") or [existing.get("role", "")])
        if r in ("agency", "seller")
    ]
    roles = (
        [r for r in held if r != name]
        if status == "rejected"
        else held + ([name] if name not in held else [])
    )
    existing["roles"] = roles
    existing.setdefault("roleStatus", {})[name] = status
    existing[link_field] = partner_id
    crm_writes.append((owner_uid, status, dict(existing)))
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
# The statement readers go through `money.get_balance` / `money.ledger_for`, and
# those are the real functions — a coin balance and a commission balance must be
# read the way production reads them, or "the money stays apart" proves nothing.
money_mod.get_db = lambda: db
audit_mod.record = fake_audit_record
ops.audit.record = fake_audit_record
ops._read_firestore_partner = fake_read_firestore
ops._sync_partner_doc = fake_sync
ops._write_second_role_state = fake_crm_write

ACTOR = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
REASON = "Registered through the CRM; creating the business record."
APPLY = "Owner asked to sell coins as well; filing the seller application."
APPROVE = "Reviewed the seller application; KYC on file; approving."
REFUSE = "ID proof does not match the agency's registered owner."


def stored(partner_id: str) -> dict:
    return db["partners"].docs[partner_id]


def actions_for(partner_id: str) -> list[str]:
    return [e["action"] for e in audit_entries if e["subject_id"] == partner_id]


# ══════════════════════════════════════════════════════════════════════════════
# 0. The starting state — two ordinary, approved, single-capability partners
# ══════════════════════════════════════════════════════════════════════════════

crm_users["login-ravi"] = {"role": "agency", "status": "approved"}
crm_users["login-meena"] = {"role": "seller", "status": "approved"}
crm_users["login-plain"] = {"role": "seller", "status": "approved"}

asyncio.run(ops.approve_partner("agency-ravi", REASON, ACTOR))
asyncio.run(ops.approve_partner("seller-meena", REASON, ACTOR))
plain_approval = asyncio.run(ops.approve_partner("seller-plain", REASON, ACTOR))

check("the agency is approved", stored("agency-ravi")["status"], "approved")
check("the seller is approved", stored("seller-meena")["status"], "approved")

# The control partner, recorded exactly as it stands before any of this runs.
PLAIN_BEFORE = {k: v for k, v in stored("seller-plain").items()}
PLAIN_AUDIT_BEFORE = actions_for("seller-plain")
PLAIN_CRM_BEFORE = dict(crm_users["login-plain"])

ok(
    "an ordinary approval carries no second-capability payload",
    "second_role" not in plain_approval,
)


# ══════════════════════════════════════════════════════════════════════════════
# 1. An approved agency applies to sell coins
# ══════════════════════════════════════════════════════════════════════════════

filed = asyncio.run(
    ops.request_second_role("agency-ravi", "seller-ravi", APPLY, ACTOR)
)

check("the application created a record", filed["created"], True)
check("of the counterpart kind", filed["kind"], "seller")
check("pending, not approved", filed["status"], "pending")
check("and inactive", filed["is_active"], False)
check("named from its own document", filed["name"], "Skyline Coin Desk")
check("pointing back at the agency", filed["second_role_of"], "agency-ravi")
check("on the agency's own login", filed["owner_crm_uid"], "login-ravi")
check("with the reason kept", filed["second_role_reason"], APPLY)

# ── Holding nothing. This is the point of the exercise. ───────────────────────
second = stored("seller-ravi")
check("opens with no coins lent", second["credit"]["total_lent"], 0)
check("opens with no credit outstanding", second["credit"]["outstanding"], 0)
check("opens with no due date", second["credit"]["due_at"], None)
check("opens with an empty credit history", second["credit"]["history"], [])
check("opens with no cash recorded", second["cash_paid_minor"], 0)
check("opens with nothing sold", second["total_coins_sold"], 0)
ok(
    "and stores no balance of its own — those are ledger positions",
    "coins" not in second and "coin_balance" not in second and "balance" not in second,
)

# ── The agency record is a SEPARATE record, and is not now a seller ───────────
agency = stored("agency-ravi")
check("the agency is still an agency", agency["kind"], "agency")
check("the seller is a seller", second["kind"], "seller")
ok("they are two records", agency["_id"] != second["_id"])
check("the agency points at its second record", agency["linked_partner_id"], "seller-ravi")
check("under the same login", agency["owner_crm_uid"], "login-ravi")
ok(
    "no coin position was invented on the agency record",
    agency["credit"]["outstanding"] == 0 and agency["total_coins_sold"] == 0,
)

# `kind` still means exactly what it meant. Checked through the real readers.
check(
    "the seller half is found by a seller query, and only the seller half",
    sorted(
        d["_id"]
        for d in db["partners"].docs.values()
        if d.get("kind") == str(PartnerKind.SELLER)
    ),
    ["seller-meena", "seller-plain", "seller-ravi"],
)
check(
    "the agency half is found by an agency query, and only the agency half",
    sorted(
        d["_id"]
        for d in db["partners"].docs.values()
        if d.get("kind") == str(PartnerKind.AGENCY)
    ),
    ["agency-ravi"],
)
check(
    "the Firestore replica for the seller half is the sellers collection",
    ops._fs_collection(second["kind"]),
    "sellers",
)
check(
    "and for the agency half it is the agencies collection",
    ops._fs_collection(agency["kind"]),
    "agencies",
)

# ── Audited, with the mandatory reason ───────────────────────────────────────
check(
    "filing audited the creation and the request",
    actions_for("seller-ravi"),
    ["partner.created", "partner.second_role_requested"],
)
request_entry = [
    e for e in audit_entries if e["action"] == ops.Act.SECOND_ROLE_REQUESTED
][-1]
check("the request carries the reason", request_entry["reason"], APPLY)
check("and names the partner it belongs to", request_entry["meta"]["held_partner_id"], "agency-ravi")
check("and says it opened at zero", request_entry["meta"]["opened_at_zero"], True)

refuses(
    "filing with a blank reason",
    lambda: ops.request_second_role("agency-ravi", "seller-ravi", " ", ACTOR),
)

# ── The login carries the capability, marked pending ─────────────────────────
#
# `roles` says which capabilities this login has applied for; `roleStatus` says
# how each one stands. That is the same division the legacy shape already has —
# `role: 'agency'` with `status: 'pending'` is a held role awaiting review — so
# an applied-for capability belongs in `roles` from the moment it is filed, and
# what withholds the dashboard is the status beside it.
check("the login now shows a pending seller capability",
      crm_users["login-ravi"]["roleStatus"]["seller"], "pending")
check("the capability is recorded, awaiting review",
      sorted(crm_users["login-ravi"]["roles"]), ["agency", "seller"])
ok("and it is NOT approved",
   crm_users["login-ravi"]["roleStatus"]["seller"] != "approved")
check("the login is linked to the seller record",
      crm_users["login-ravi"]["sellerId"], "seller-ravi")

# ── It is in the queue staff already use ─────────────────────────────────────
queue = asyncio.run(
    ops.list_partners(PartnerKind.SELLER, PartnerStatus.PENDING)
)
check(
    "the application is in the pending seller queue",
    [p["id"] for p in queue],
    ["seller-ravi"],
)

# A fresh seller cannot take inventory, for the ordinary reason.
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-ravi"))
check("an unapproved second capability cannot take inventory", allowed, False)
check("and is told why", why, "Seller account is not approved.")


# ══════════════════════════════════════════════════════════════════════════════
# 2. Filing twice, filing over somebody else, filing nonsense
# ══════════════════════════════════════════════════════════════════════════════

message = refuses(
    "a second application while one is outstanding",
    lambda: ops.request_second_role("agency-ravi", "seller-plain", APPLY, ACTOR),
)
ok("the refusal names the record already linked", "seller-ravi" in message)

message = refuses(
    "applying for a partner that belongs to another login",
    lambda: ops.request_second_role("seller-meena", "agency-ravi", APPLY, ACTOR),
)
ok("the refusal says it is a different login", "different CRM login" in message)
check(
    "and nothing was linked onto the seller",
    stored("seller-meena").get("linked_partner_id"),
    None,
)

message = refuses(
    "applying with a partner id that is its own",
    lambda: ops.request_second_role("seller-meena", "seller-meena", APPLY, ACTOR),
)
ok("the refusal explains the second record is a different one", "different" in message)

message = refuses(
    "an unapproved partner applying for a second capability",
    lambda: ops.request_second_role("seller-orphan", "agency-meena", APPLY, ACTOR),
)
ok("the refusal is about the partner not existing yet", "seller-orphan" in message)

# A partner document with no `crmUid` names no login, so there is nobody to
# grant anything to.
#
# FX-09: such a record can no longer be APPROVED ("attach a login first"), so an
# approved login-less record now exists only as legacy data, approved before
# that rule. It is created the way it would have been (approval), then shown to
# be refused today, and the legacy state is seeded directly for the rest of the
# scenario.
_fx09 = refuses(
    "FX-09: approving a record that names no login is refused",
    lambda: ops.approve_partner("seller-orphan", REASON, ACTOR),
)
ok("FX-09: …saying to attach a login first", "Attach a login first" in _fx09)
_legacy = stored("seller-orphan")
_legacy["status"] = "approved"
_legacy["is_active"] = True
message = refuses(
    "a partner with no CRM login applying",
    lambda: ops.request_second_role("seller-orphan", "agency-meena", APPLY, ACTOR),
)
ok("the refusal names the missing back-link", "crmUid" in message)

# An existing, trading partner cannot be adopted as somebody's second capability.
asyncio.run(ops.approve_partner("seller-stranger", REASON, ACTOR))
before_stranger = dict(stored("seller-stranger"))
message = refuses(
    "adopting an existing partner as a second capability",
    lambda: ops.request_second_role("agency-ravi", "seller-stranger", APPLY, ACTOR),
)
check("the stranger's record was not touched", stored("seller-stranger"), before_stranger)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Approving it — through the SAME approval every partner goes through
# ══════════════════════════════════════════════════════════════════════════════

approved = asyncio.run(ops.approve_partner("seller-ravi", APPROVE, ACTOR))

check("approved", approved["status"], "approved")
check("and active", approved["is_active"], True)
check("no second record was created by the approval", approved["partner_record_created"], False)
check("the approval names the capability it granted", approved["second_role"]["granted_kind"], "seller")
check("and the partner it belongs to", approved["second_role"]["held_partner_id"], "agency-ravi")
check("and the login", approved["second_role"]["owner_crm_uid"], "login-ravi")

# Still holding nothing. Approval is permission, not inventory.
after = stored("seller-ravi")
check("approval credited no coins", after["credit"]["total_lent"], 0)
check("approval recorded no cash", after["cash_paid_minor"], 0)
check("approval sold nothing", after["total_coins_sold"], 0)
check("approval left the credit history empty", after["credit"]["history"], [])
check("approval opened no credit", after["credit"]["outstanding"], 0)

# The audit trail says all three things happened, in order.
check(
    "the record's audit trail is complete",
    actions_for("seller-ravi"),
    [
        "partner.created",
        "partner.second_role_requested",
        "partner.approved",
        "partner.second_role_approved",
    ],
)
grant = [e for e in audit_entries if e["action"] == ops.Act.SECOND_ROLE_APPROVED][-1]
check("the grant carries the reason", grant["reason"], APPROVE)
check("and says the record opened at zero", grant["meta"]["opened_at_zero"], True)
ok(
    "and says the two balances stay apart",
    "own records" in grant["meta"]["balances_separate"],
)

# ── The login now holds both, and only both ──────────────────────────────────
login = crm_users["login-ravi"]
check("the login holds both capabilities", sorted(login["roles"]), ["agency", "seller"])
check("the seller capability is approved", login["roleStatus"]["seller"], "approved")
check("the agency link is untouched", login.get("agencyId"), None)
check("the seller link is set", login["sellerId"], "seller-ravi")
check(
    "the primary role field is unchanged — every legacy read still works",
    login["role"],
    "agency",
)
check("and so is the legacy status field", login["status"], "approved")

# ── The money is still in two places ─────────────────────────────────────────
#
# Give each half a live position the way an accrual and a coin purchase would.
# The balances go where the real code puts them — keyed on (holder_type,
# holder_id, currency) — so the readers below are the production readers, not a
# re-reading of the partner document.
stored("seller-ravi")["credit"]["outstanding"] = 40_000
stored("seller-ravi")["cash_paid_minor"] = 150_000
db["balances"].docs["bal-coins"] = {
    "_id": "bal-coins",
    "holder_type": "seller",
    "holder_id": "seller-ravi",
    "currency": "coins",
    "amount": 12_000,
}
db["balances"].docs["bal-commission"] = {
    "_id": "bal-commission",
    "holder_type": "agency",
    "holder_id": "agency-ravi",
    "currency": "commission",
    "amount": 250_000,
}

seller_view = asyncio.run(partner_svc.seller_statement("seller-ravi"))
check("the seller statement reads the seller record", seller_view.seller_id, "seller-ravi")
check("and its name", seller_view.name, "Skyline Coin Desk")
check("and its credit", seller_view.credit_outstanding, 40_000)
check("and its cash", seller_view.cash_paid_minor, 150_000)
check("and its coins on hand", seller_view.coins_on_hand, 12_000)

# Now the load-bearing pair. 12,000 coins and 250,000 paise are two different
# liabilities in two different currencies. Neither reader can see the other's.
coins_on_the_agency = asyncio.run(
    money_mod.get_balance(
        money_mod.HolderType.AGENCY, "agency-ravi", money_mod.Currency.COINS
    )
)
commission_on_the_seller = asyncio.run(
    money_mod.get_balance(
        money_mod.HolderType.SELLER, "seller-ravi", money_mod.Currency.COMMISSION
    )
)
check("the agency half holds no coins", coins_on_the_agency, 0)
check("the seller half holds no commission", commission_on_the_seller, 0)
check(
    "the commission is on the agency half, where it was put",
    asyncio.run(
        money_mod.get_balance(
            money_mod.HolderType.AGENCY, "agency-ravi", money_mod.Currency.COMMISSION
        )
    ),
    250_000,
)
check(
    "the coins are on the seller half, where they were put",
    asyncio.run(
        money_mod.get_balance(
            money_mod.HolderType.SELLER, "seller-ravi", money_mod.Currency.COINS
        )
    ),
    12_000,
)

# `get_partner` attaches the live position, and picks which one by `kind`. Two
# records, two answers — and no record answers both.
agency_record = asyncio.run(ops.get_partner("agency-ravi"))
seller_record = asyncio.run(ops.get_partner("seller-ravi"))
check("the agency record reports commission", agency_record["commission_outstanding"], 250_000)
ok("and no coin position", "coins_on_hand" not in agency_record)
check("the seller record reports coins", seller_record["coins_on_hand"], 12_000)
ok("and no commission position", "commission_outstanding" not in seller_record)

check(
    "the agency record carries no coin credit of its own",
    stored("agency-ravi")["credit"]["outstanding"],
    0,
)
check(
    "and no cash of its own",
    stored("agency-ravi")["cash_paid_minor"],
    0,
)
check(
    "the seller half never appears in a sub-agency query",
    asyncio.run(partner_svc.sub_agencies_of("agency-ravi")),
    [],
)

# The exposure aggregate counts sellers. The agency half must not be in it, and
# the seller half must be — once, not twice.
exposure = asyncio.run(partner_svc.total_credit_exposure())
check("credit exposure counts every seller record", exposure["total_sellers"], 5)
check("and the outstanding is the seller half's, once", exposure["total_outstanding"], 40_000)
check("and one seller has credit out", exposure["sellers_with_credit"], 1)

# An approved second capability can now take inventory, like any other seller.
stored("seller-ravi")["credit"]["outstanding"] = 0
allowed, why = asyncio.run(partner_svc.can_take_inventory("seller-ravi"))
check("an approved second capability can take inventory", allowed, True)
check("with nothing standing in the way", why, "")


# ══════════════════════════════════════════════════════════════════════════════
# 4. The other direction — a seller applies to run an agency
# ══════════════════════════════════════════════════════════════════════════════

reverse = asyncio.run(
    ops.request_second_role("seller-meena", "agency-meena", APPLY, ACTOR)
)
check("a seller's counterpart is an agency", reverse["kind"], "agency")
check("pending", reverse["status"], "pending")
check("linked back", reverse["second_role_of"], "seller-meena")
check("on the seller's login", reverse["owner_crm_uid"], "login-meena")
check("holding no commission", stored("agency-meena")["credit"]["outstanding"], 0)

asyncio.run(ops.approve_partner("agency-meena", APPROVE, ACTOR))
check(
    "the login holds both",
    sorted(crm_users["login-meena"]["roles"]),
    ["agency", "seller"],
)
check(
    "and its primary role is still seller",
    crm_users["login-meena"]["role"],
    "seller",
)
check(
    "the agency half is a main agency, from its own document",
    stored("agency-meena")["kind"],
    "agency",
)


# ══════════════════════════════════════════════════════════════════════════════
# 5. Rejection — the reason travels, and the capability is not granted
# ══════════════════════════════════════════════════════════════════════════════

FIRESTORE["seller-refused"] = (
    "sellers",
    {
        "crmId": "R1R2R3R4",
        "crmUid": "login-refused",
        "displayName": "Refused Coin Desk",
        "email": "refused@example.com",
    },
)
FIRESTORE["agency-refused"] = (
    "agencies",
    {
        "crmId": "R5R6R7R8",
        "crmUid": "login-refused",
        "agencyName": "Refused Talents",
        "type": "main",
    },
)
crm_users["login-refused"] = {"role": "seller", "status": "approved"}
asyncio.run(ops.approve_partner("seller-refused", REASON, ACTOR))
asyncio.run(ops.request_second_role("seller-refused", "agency-refused", APPLY, ACTOR))

rejected = asyncio.run(ops.reject_partner("agency-refused", REFUSE, ACTOR))

check("the application is rejected", rejected["status"], "rejected")
check("the reason is on the record", rejected["rejection_reason"], REFUSE)
check("and in the rejection history", rejected["rejection_history"][0]["reason"], REFUSE)
check("the refusal names the capability", rejected["second_role"]["refused_kind"], "agency")
check(
    "the link on the held record is released",
    stored("seller-refused")["linked_partner_id"],
    None,
)
check(
    "the login does NOT hold the agency capability",
    crm_users["login-refused"]["roles"],
    ["seller"],
)
check(
    "and is told it was refused",
    crm_users["login-refused"]["roleStatus"]["agency"],
    "rejected",
)
check(
    "the rejected record holds nothing",
    stored("agency-refused")["credit"]["outstanding"],
    0,
)
check(
    "the rejection is audited with its reason",
    [
        e["reason"]
        for e in audit_entries
        if e["action"] == ops.Act.SECOND_ROLE_REJECTED
    ],
    [REFUSE],
)
refuses(
    "rejecting with a blank reason",
    lambda: ops.reject_partner("agency-refused", "  ", ACTOR),
)

# Released, so a fresh application may be filed.
FIRESTORE["agency-refused-2"] = (
    "agencies",
    {"crmUid": "login-refused", "agencyName": "Refused Talents (again)", "type": "main"},
)
again = asyncio.run(
    ops.request_second_role("seller-refused", "agency-refused-2", APPLY, ACTOR)
)
check("a refused applicant may reapply", again["status"], "pending")


# ══════════════════════════════════════════════════════════════════════════════
# 6. A single-capability partner is untouched. Byte for byte.
# ══════════════════════════════════════════════════════════════════════════════

check("the plain partner's record is unchanged", stored("seller-plain"), PLAIN_BEFORE)
check("its audit trail is unchanged", actions_for("seller-plain"), PLAIN_AUDIT_BEFORE)
check("its login is unchanged", crm_users["login-plain"], PLAIN_CRM_BEFORE)
ok("it carries no second-capability link", "second_role_of" not in PLAIN_BEFORE)
ok("and no reverse link", "linked_partner_id" not in PLAIN_BEFORE)
# `owner_crm_uid` IS present on a plain partner now — written at creation
# from the Firestore document's `crmUid`, because a record that reaches Mongo
# belonging to nobody is a record the one-agency-per-human rule cannot see.
# The second-role flow is no longer the only writer, and this control checks
# the field is simply the login uid, not something the second-role path put
# there. (It used to assert absence; absence was the bug.)
ok("its owner uid is its own login, written at birth",
   PLAIN_BEFORE.get("owner_crm_uid") == "login-plain")

# Approving and rejecting an ordinary partner takes none of the new path.
FIRESTORE["seller-ordinary"] = (
    "sellers",
    {"crmUid": "login-ordinary", "displayName": "Ordinary Coins"},
)
ordinary = asyncio.run(ops.approve_partner("seller-ordinary", REASON, ACTOR))
ok("an ordinary approval reports no capability grant", "second_role" not in ordinary)
check(
    "and audits exactly creation and approval",
    actions_for("seller-ordinary"),
    ["partner.created", "partner.approved"],
)

FIRESTORE["seller-turned-down"] = (
    "sellers",
    {"crmUid": "login-turned-down", "displayName": "Turned Down Coins"},
)
asyncio.run(ops.create_partner("seller-turned-down", REASON, ACTOR))
turned_down = asyncio.run(ops.reject_partner("seller-turned-down", REFUSE, ACTOR))
ok("an ordinary rejection reports no capability refusal", "second_role" not in turned_down)
check(
    "and audits exactly creation and rejection",
    actions_for("seller-turned-down"),
    ["partner.created", "partner.rejected"],
)

# The counterpart mapping, stated directly. A sub-agency's second capability is
# a seller — a second capability is a new business, not a move within the agency
# hierarchy.
check("an agency's counterpart is a seller", ops._counterpart_kind(PartnerKind.AGENCY), PartnerKind.SELLER)
check("a sub-agency's counterpart is a seller", ops._counterpart_kind(PartnerKind.SUB_AGENCY), PartnerKind.SELLER)
check("a seller's counterpart is an agency", ops._counterpart_kind(PartnerKind.SELLER), PartnerKind.AGENCY)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} second-capability checks passed.")
print("  · an approved agency applies to sell coins, and a seller to run an agency")
print("  · the application is a SECOND record — pending, holding nothing, in the same queue")
print("  · approving grants the capability and still credits nothing")
print("  · commission and coin inventory stay on two records, in two ledgers")
print("  · every `kind` query returns exactly what it returned before")
print("  · a rejection carries its reason and grants nothing")
print("  · a single-capability partner's record, audit trail and login are unchanged")
sys.exit(0)
