"""The CRM directory — the Firestore half of a staff account.

A working staff account is **two** records, not one:

  * Mongo `staff` — what `app/core/security.py::sign_in_with_firebase` reads to
    resolve a role and issue an API session. Without it every API-backed screen
    refuses with "No account found. Contact your administrator."
  * Firestore `crmUsers/{uid}` — what the CRM shell reads to resolve a role and
    build navigation. Without it `zipper-crm/lib/auth.ts::crmSignIn` throws
    "CRM account not found. Contact your administrator." and the shell never
    opens.

Mongo is authoritative: it decides what a role may do. Firestore is a replica of
*who exists*, and this module is the only implementation of it. It used to live
as `mirror_to_firestore` inside `scripts/seed_accounts.py`, which is exactly why
the owners and the observer work and nothing created since does — the API and
the CRM's own /team screen each wrote one half and neither wrote the other.

Nothing here decides authority. Every mapping below is a translation between two
vocabularies for the same role; no role gains or loses a capability by passing
through this module.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.config import settings
from app.core.roles import ALL_PERMISSIONS, INTERNAL_ROLES, Role, permissions_of, team_of
from app.db import firebase

log = logging.getLogger(__name__)

COLLECTION = "crmUsers"

#: P1-E — the names-only staff list every member of staff may read (assignee
#: pickers, routing). `crmUsers` carries phone numbers and contact details and
#: is readable only by its owner, an Owner, and a department admin for their own
#: members (firestore.rules). Written here, by the Admin SDK, and by nothing else.
ROSTER = "staffRoster"
ROSTER_FIELDS = ("uid", "name", "role", "dept", "isActive")


def write_roster(uid: str, *, name: str, crm_role: str, dept: str | None, is_active: bool) -> str:
    """Upsert one roster row. Best effort: returns a note on failure, never raises.

    It only names people for pickers — it decides no access — so a failure here
    must not fail an invite or a deactivation that has otherwise landed."""
    try:
        firebase.firestore_client().collection(ROSTER).document(uid).set({
            "uid": uid, "name": name or "", "role": crm_role, "dept": dept or None,
            "isActive": bool(is_active), "updatedAt": datetime.now(timezone.utc),
        })
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("staffRoster/%s was not written: %s", uid, exc)
        return f"staffRoster/{uid} not written ({exc}); re-run scripts/backfill_staff_roster.py"


def set_roster_active(uid: str, is_active: bool) -> str:
    try:
        firebase.firestore_client().collection(ROSTER).document(uid).set(
            {"isActive": bool(is_active), "updatedAt": datetime.now(timezone.utc)}, merge=True)
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("staffRoster/%s isActive was not written: %s", uid, exc)
        return f"staffRoster/{uid} not updated ({exc})"

#: The Android app queries this on every login and stamps `crmRole` on the
#: account when it finds a match, so a staff member is recognised in the app as
#: well as in the CRM. It was written by `createCrmUser` in the browser; when
#: that path went away it came here, so nothing that used to happen stopped
#: happening. It is a convenience replica and **not** part of signing in, which
#: is why a failure to write it is logged rather than raised — see `mirror`.
IDENTITIES = "verifiedIdentities"

#: What a person should be told to run when the two halves disagree.
REPAIR_COMMAND = "cd backend && python -m scripts.repair_staff_accounts --confirm"


class DirectoryError(Exception):
    """The Firestore half could not be written or read. Safe to show a caller."""


# ══════════════════════════════════════════════════════════════════════════════
#  The two role vocabularies
# ══════════════════════════════════════════════════════════════════════════════
#
# The department roles are spelled identically on both sides — `tech_admin` is
# `tech_admin`. Only the two governance roles differ, and each for a reason:
#
#   * an owner becomes `superadmin`, because the CRM's vocabulary has no owner
#     tier and `superadmin` is what every Firestore rule and every
#     Firestore-backed screen already checks. This is the mapping
#     `scripts/seed_accounts.py` has always used;
#   * the observer maps to **nothing at all** — see `NOT_MIRRORED`.

CRM_ROLE: dict[Role, str] = {
    Role.OWNER: "superadmin",
    Role.APP_ADMIN: "app_admin",
    Role.APP_MEMBER: "app_member",
    Role.OPS_ADMIN: "ops_admin",
    Role.OPS_MEMBER: "ops_member",
    Role.FINANCE_ADMIN: "finance_admin",
    Role.FINANCE_MEMBER: "finance_member",
    Role.TECH_ADMIN: "tech_admin",
    Role.TECH_MEMBER: "tech_member",
    Role.SUPPORT_ADMIN: "support_admin",
    Role.SUPPORT_MEMBER: "support_member",
    Role.MARKETING_ADMIN: "marketing_admin",
    Role.MARKETING_MEMBER: "marketing_member",
}

#: Roles that must never gain a `crmUsers` document through this module, and why.
#: A role in here is not an error — it is a deliberate absence, and the reason is
#: carried so a script can print it rather than reporting a mystery.
NOT_MIRRORED: dict[Role, str] = {
    Role.OBSERVER: (
        "read-only by design — the CRM vocabulary has no read-only tier, so any "
        "document it were given would grant write access on every "
        "Firestore-backed page"
    ),
    Role.AGENCY: (
        "external partner — an agency's crmUsers document is written by the "
        "partner signup flow against its own auth token, not by staff management"
    ),
    Role.SELLER: (
        "external partner — a coin seller's crmUsers document is written by the "
        "partner signup flow against its own auth token, not by staff management"
    ),
}

#: The `crmUsers` field that links a login to its partner record, per capability.
#: These are the field names `firestore.rules` reads (`crmUserAgencyId()`) and
#: the ones `createAgencyAccount` / `createSellerAccount` write, so a document
#: written here is indistinguishable from one written by the signup flow.
PARTNER_LINK_FIELD: dict[Role, str] = {
    Role.AGENCY: "agencyId",
    Role.SELLER: "sellerId",
}

#: The CRM's spelling of each external role. Kept out of `CRM_ROLE` deliberately:
#: `CRM_ROLE` is the table `mirror` walks for a *staff* account and a partner in
#: it would make `mirror(role=Role.AGENCY)` — with no partner id — silently write
#: a partner document with no link on it, which is the one shape a `crmUsers`
#: document must never have. A partner is written only on the explicit path.
PARTNER_CRM_ROLE: dict[Role, str] = {
    Role.AGENCY: "agency",
    Role.SELLER: "seller",
}

#: The CRM spellings of every INTERNAL role (Owner = `superadmin`, department
#: admins and members). Derived from `CRM_ROLE` and `INTERNAL_ROLES`, so there
#: is one definition of "internal". Partner spellings are never in it.
INTERNAL_CRM_ROLES: frozenset[str] = frozenset(
    crm for role, crm in CRM_ROLE.items() if role in INTERNAL_ROLES
)

#: The reverse direction, used when repairing a `crmUsers` document that has no
#: Mongo row. `superadmin` is deliberately absent: see `MONGO_ROLE_REFUSED`.
MONGO_ROLE: dict[str, Role] = {
    crm: role for role, crm in CRM_ROLE.items() if role is not Role.OWNER
}

#: A CRM role that *could* be translated but must not be, by a script, without a
#: person deciding. Mapping `superadmin` back to `owner` would let a repair run
#: mint an account that can sign money.
MONGO_ROLE_REFUSED: dict[str, str] = {
    "superadmin": (
        "'superadmin' is the CRM spelling of 'owner', and an owner is the only "
        "role that can sign money. A script must not create one — ask an "
        "existing owner to invite them, or add them to scripts/seed_accounts.py"
    ),
    "agency": "external partner — its record lives in `partners`, not `staff`",
    "seller": "external partner — its record lives in `partners`, not `staff`",
}

#: Old generic role strings from before the department system. The CRM front end
#: normalises these on read (`LEGACY_ROLE_MAP` in `zipper-crm/lib/auth.ts`); the
#: same mapping is applied here so a legacy document repairs to the same role the
#: shell would already have shown its holder.
LEGACY_CRM_ROLE: dict[str, str] = {
    "admin": "app_admin",
    "ops": "ops_member",
    "tech": "tech_member",
    "finance": "finance_member",
    "support": "support_member",
}


def normalise_crm_role(raw: str) -> str:
    """A stored `crmUsers.role` as the front end would read it."""
    value = (raw or "").strip()
    return LEGACY_CRM_ROLE.get(value, value)


def crm_role_for(role: Role) -> str | None:
    """The CRM's spelling of a Mongo role, or None if it must have no document."""
    return CRM_ROLE.get(role)


def mongo_role_for(crm_role: str) -> Role | None:
    """The Mongo role a `crmUsers.role` corresponds to, or None if it maps to
    nothing this module is willing to create."""
    return MONGO_ROLE.get(normalise_crm_role(crm_role))


# ══════════════════════════════════════════════════════════════════════════════
#  Permissions
# ══════════════════════════════════════════════════════════════════════════════
#
# `DEFAULT_PERMISSIONS` is what `createCrmUser` used to write onto a `crmUsers`
# document and what `hasPermission` in `zipper-crm/lib/auth.ts` reads back. It is
# needed here because a document written with `permissions: []` leaves a
# `tech_admin` refused by every Firestore-backed screen — the same "the tab is
# there and it will not load" failure this module exists to end, in a different
# place.
#
# ── It is DERIVED, not transcribed ───────────────────────────────────────────
#
# This used to be a hand-copied table sitting beside `app/core/roles.py`, which
# meant the same twenty capabilities were written down three times: in
# `lib/auth.ts`, here, and nowhere at all on the server side that enforced them.
# Two of those three could drift and only one had a test.
#
# Now `app/core/roles.PERMISSIONS` is the single Python source and this is a
# projection of it into the CRM's vocabulary — the same translation `CRM_ROLE`
# already performs for role names, applied to the grant matrix. A role widened
# on the server is widened on the Firestore document by the same edit, and a
# permission granted on a screen is one the API will actually honour.
#
# The observer is absent, deliberately and unavoidably: it has no CRM spelling
# (see `NOT_MIRRORED`), so there is no key to put it under. That is the same
# absence `CRM_ROLE` already expresses and it needs no second statement.
#
# `tests/test_staff_directory.py` parses the TypeScript and fails if this drifts
# from it; `tests/test_permissions.py` does the same against `roles.PERMISSIONS`
# directly, so neither end of the derivation can rot silently.


def _crm_permission_table() -> dict[str, tuple[str, ...]]:
    """`roles.PERMISSIONS`, keyed and spelled the way a `crmUsers` document is.

    Order is `ALL_PERMISSIONS` order — the declaration order of the enum, which
    is the order of the `Permission` union in `lib/auth.ts`. A set has no order
    and a document whose `permissions` array reshuffled on every save would make
    every diff of a staff record unreadable.
    """
    table: dict[str, tuple[str, ...]] = {}
    for role, crm_name in {**CRM_ROLE, **PARTNER_CRM_ROLE}.items():
        held = permissions_of(role)
        table[crm_name] = tuple(str(p) for p in ALL_PERMISSIONS if p in held)
    return table


#: Every capability, as a `crmUsers` document spells it. Derived like everything
#: else here; kept under its original name so anything that imported it before
#: the table moved to `app/core/roles.py` still resolves.
_ALL_PERMISSIONS: tuple[str, ...] = tuple(str(p) for p in ALL_PERMISSIONS)

DEFAULT_PERMISSIONS: dict[str, tuple[str, ...]] = _crm_permission_table()


# ══════════════════════════════════════════════════════════════════════════════
#  What a write did
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Outcome:
    """What happened to the Firestore half, in a form a script can print.

    `action` is one of:

      * ``"written"``  — the document exists and matches the staff record
      * ``"absent_by_design"`` — the role must have no document, and has none
      * ``"removed"``  — the role must have no document, and one was deleted
    """

    action: str
    uid: str
    email: str
    crm_role: str | None
    detail: str
    #: (document id, the role it carried) for anything deleted on the observer
    #: path. Never empty when `action == "removed"`.
    removed: tuple[tuple[str, str], ...] = field(default=())

    @property
    def wrote_document(self) -> bool:
        return self.action == "written"


# ══════════════════════════════════════════════════════════════════════════════
#  Reads
# ══════════════════════════════════════════════════════════════════════════════


def _collection():
    try:
        return firebase.firestore_client().collection(COLLECTION)
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(f"Firestore is not available: {exc}") from exc


def read(uid: str) -> dict | None:
    """One `crmUsers` document by id, or None."""
    try:
        snap = _collection().document(uid).get()
    except DirectoryError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(f"Could not read crmUsers/{uid}: {exc}") from exc
    if not snap.exists:
        return None
    return snap.to_dict() or {}


def find_by_email(email: str) -> list[tuple[str, dict]]:
    """Every `crmUsers` document carrying this email, id first.

    Matched on email rather than id on purpose. The observer's Mongo uid is
    synthetic (``observer:<email>``) while any Firestore document it ever had was
    created under a real Firebase uid, so a lookup by id silently finds nothing.
    """
    lowered = (email or "").strip().lower()
    if not lowered:
        return []
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter

        found = list(
            _collection().where(filter=FieldFilter("email", "==", lowered)).stream()
        )
    except DirectoryError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(
            f"Could not search crmUsers for {lowered}: {exc}"
        ) from exc
    return [(snap.id, snap.to_dict() or {}) for snap in found]


def all_documents() -> list[tuple[str, dict]]:
    """Every `crmUsers` document, id first. Used by the repair script."""
    try:
        return [(snap.id, snap.to_dict() or {}) for snap in _collection().stream()]
    except DirectoryError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(f"Could not read the crmUsers collection: {exc}") from exc


# ══════════════════════════════════════════════════════════════════════════════
#  Writes
# ══════════════════════════════════════════════════════════════════════════════


_CRM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def _new_crm_id() -> str:
    """The human-readable 8-character id the team screen shows as `#A1B2C3D4`.

    Same alphabet and length as `generateCrmId` in `zipper-crm/lib/auth.ts`, so a
    document written here is indistinguishable from one written there.
    """
    import secrets

    return "".join(secrets.choice(_CRM_ID_ALPHABET) for _ in range(8))


def _identity_doc_id(phone: str, email: str) -> str:
    """The document id both writers key on: the phone, or the email flattened.

    Shared so a partner and a staff entry for the same person land on the same
    document rather than two, which is what `merge=True` below relies on.
    """
    normalised = "".join(phone.split())
    return normalised or email.replace("@", "_").replace(".", "_")


def write_partner_identity(
    *, email: str, phone: str, name: str, role: str, agency_id: str = ""
) -> str:
    """Let an approved agency or coin seller into their own app dashboard.

    ## The gap this closes

    `AgencyDashboardScreen` and `SellerDashboardScreen` are built and wired into
    the app's navigation, and no real partner could reach either of them. The
    app decides somebody is a partner from `isAgent` / `isSeller` on their user
    document; those are written by exactly one thing, `syncMyRoles`, which reads
    exactly one collection, `verifiedIdentities` — and `mirror()` skips writing
    partners into it, deliberately, because that collection is how the app
    decides somebody is STAFF.

    That reasoning is right and is not being undone here. An agency must not be
    badged as a member of the team. The mistake was that one collection was
    doing two jobs, so "not staff" and "no role at all" had become the same
    thing. A partner needs a role badge WITHOUT a `crmRole`, and this writes
    exactly that: `roles: ['agent']` or `['seller']`, and nothing else.
    `syncMyRoles` already maps both onto the right field and already copies
    `agencyId` across, so no app change is needed.

    ## Matched on phone OR email

    Whichever they sign in with. The app offers phone OTP and Google, the CRM
    uses email and password, and those can be two different Firebase accounts
    for the same person — so the identity has to be the human, not the uid.
    `syncMyRoles` already queries both arrays.

    Returns "" on success, or a sentence describing what went wrong. Never
    raises: a partner who cannot be told about is still an approved partner, and
    their status decision must not fail over a replica write.
    """
    if role not in ("agent", "seller"):
        return f"'{role}' is not an app partner role; nothing was written"

    normalised = "".join(phone.split())
    doc_id = _identity_doc_id(phone, email)
    entry: dict = {
        "phoneNumbers": [normalised] if normalised else [],
        "emails": [email] if email else [],
        "roles": [role],
        "name": name,
        "updatedAt": datetime.now(timezone.utc),
    }
    # Only an agent carries one. `syncMyRoles` reads it to stamp `agencyId` on
    # the user document, which is what points the dashboard at the right agency.
    if role == "agent" and agency_id:
        entry["agencyId"] = agency_id

    try:
        firebase.firestore_client().collection(IDENTITIES).document(doc_id).set(
            entry, merge=True
        )
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("verifiedIdentities/%s not written for partner %s: %s", doc_id, email, exc)
        return (
            f"the Android app's verifiedIdentities/{doc_id} entry was not "
            f"written ({exc}); they will not see their dashboard in the app "
            "until it is"
        )


def clear_partner_identity(*, email: str, phone: str, role: str) -> str:
    """Take the app role away again, on rejection, suspension or deactivation.

    Deletes the ROLE, not the document: the same person may hold a staff entry
    on the same id, and removing the document would sign them out of the team as
    well. An entry left holding no roles is harmless — `syncMyRoles` iterates
    the list and finds nothing to grant.
    """
    if role not in ("agent", "seller"):
        return ""
    doc_id = _identity_doc_id(phone, email)
    try:
        client = firebase.firestore_client()
        ref = client.collection(IDENTITIES).document(doc_id)
        snap = ref.get()
        if not getattr(snap, "exists", False):
            return ""
        roles = [r for r in (snap.to_dict() or {}).get("roles", []) if r != role]
        patch: dict = {"roles": roles, "updatedAt": datetime.now(timezone.utc)}
        # The agency link goes with the agent role. Leaving it behind would
        # point a removed partner's app at an agency they no longer run.
        if role == "agent":
            patch["agencyId"] = ""
        ref.set(patch, merge=True)
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("verifiedIdentities/%s not cleared for %s: %s", doc_id, email, exc)
        return (
            f"the Android app's verifiedIdentities/{doc_id} entry still grants "
            f"'{role}' ({exc}); they keep dashboard access in the app until it "
            "is removed"
        )


def _write_verified_identity(
    *, email: str, phone: str, name: str, crm_role: str
) -> str:
    """Link a phone and an email to a CRM role, for the Android app.

    Same document id and same fields `writeVerifiedIdentity` in
    `zipper-crm/lib/auth.ts` used, so an account created through the API is
    recognised by the app exactly as one created through the old browser path
    was. Returns "" on success, or a sentence describing what went wrong.
    """
    normalised = "".join(phone.split())
    doc_id = normalised or email.replace("@", "_").replace(".", "_")
    try:
        firebase.firestore_client().collection(IDENTITIES).document(doc_id).set(
            {
                "phoneNumbers": [normalised] if normalised else [],
                "emails": [email],
                "roles": [crm_role],
                "name": name,
                "updatedAt": datetime.now(timezone.utc),
            },
            merge=True,
        )
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("verifiedIdentities/%s not written for %s: %s", doc_id, email, exc)
        return (
            f"the Android app's verifiedIdentities/{doc_id} entry was not "
            f"written ({exc}); they will not be auto-detected as staff in the "
            "app until it is"
        )


#: Written onto `crmUsers/{uid}` once the number is on the Firebase account, so
#: the repair below runs at most once per partner instead of on every sign-in.
PHONE_ATTACHED_FIELD = "appPhoneAttached"


def attach_phone_to_login(uid: str, phone: str) -> str:
    """Put a phone number on a Firebase account, so app sign-in finds this uid.

    ── WHY THIS IS THE WHOLE PARTNER-IN-THE-APP FIX ──────────────────────────

    `syncMyRoles` decides whether somebody is an agency or a coin seller by
    reading `crmUsers/{uid}` — **by uid, and only by uid**. So the badge, the
    agency dashboard and the seller dashboard all depend on the app session
    landing on the SAME Firebase account the CRM login uses.

    Staff get that for free: `_attach_app_identity` puts their number on their
    account when they are invited, so phone OTP resolves to their CRM uid.
    Nothing did it for partners. An agency owner signing into the app with their
    phone got a different uid, no `crmUsers` document, no `isAgent` and no
    dashboard — while every CRM screen showed them as a fully approved agency.

    The partner's number was being written to `verifiedIdentities` instead, which
    was the right answer when `syncMyRoles` matched on phone and email. It reads
    `crmUsers/{uid}` now, and nothing reads that collection for role derivation
    any more, so the one mechanism built to tag partners in the app was writing
    to a file nobody opens.

    ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────

    Never raises. A number that already belongs to somebody else's account comes
    back from Firebase as a conflict, and taking a number off a live account is a
    decision rather than a side effect — so it is reported and the approval,
    or the sign-in, carries on without it.

    @return '' on success or when there is nothing to do; otherwise a sentence
        naming what could not be done and what it costs.
    """
    e164 = to_e164(phone)
    if not uid.strip() or not e164:
        return ""
    # ── Phase 1A (CONTACT-002): A TYPED NUMBER IS NEVER ATTACHED ────────────
    #
    # This used to call `update_user_phone(uid, <number from a form>)`. The
    # number was typed — by the applicant on an application, or by staff on an
    # invitation — and nobody had proved they hold it. Attaching it made that
    # unverified claim the account's sign-in identity: whoever later passed OTP
    # for the number landed on THIS uid, and the real holder of the number could
    # be locked out of, or into, an account that was not theirs.
    #
    # The number reaches the account only by the holder verifying it in the app
    # (`bindVerifiedIdentity`, phone OTP). If it is already on the account —
    # because they did exactly that — there is nothing to do.
    if typed_phone_already_verified(uid, e164):
        return ""
    return (
        "their phone was not attached to the sign-in: a typed number is never "
        "attached automatically. They add it by verifying it with an OTP in the "
        "app (Settings → add phone number)"
    )


def typed_phone_already_verified(uid: str, e164: str) -> bool:
    """Is this exact number already on the uid's Firebase account (OTP-verified)?"""
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001
        return False
    return bool(rec is not None and getattr(rec, "phone_number", None) == e164)


def typed_email_already_verified(uid: str, email: str) -> bool:
    """P0-5 (AUTHN-1): is this exact address on the uid's Firebase account, VERIFIED?

    The email twin of `typed_phone_already_verified`. A partner's address is
    typed into an application form; it is a claim, not an identity, until the
    sign-in itself holds it confirmed. Unknown is not verified.
    """
    wanted = (email or "").strip().lower()
    if not wanted or not uid:
        return False
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001
        return False
    if rec is None:
        return False
    held = str(getattr(rec, "email", "") or "").strip().lower()
    return held == wanted and bool(getattr(rec, "email_verified", False))


def ensure_app_phone(uid: str, document: dict | None) -> str:
    """Attach the partner's phone if it has not been attached yet. Idempotent.

    The self-healing half. Attaching at approval fixes every partner approved
    from now on; this fixes the ones approved before it existed, on their next
    sign-in, with no script for anybody to remember to run.

    Guarded by a marker on the `crmUsers` document the caller has already read,
    so the common path costs nothing: one dictionary lookup, no Firebase call and
    no extra Firestore read. It runs once per partner and then never again.
    """
    if not document or document.get(PHONE_ATTACHED_FIELD) is True:
        return ""
    phone = str(document.get("phone") or "").strip()
    if not phone:
        return ""

    note = attach_phone_to_login(uid, phone)
    if note:
        return note
    try:
        firebase.firestore_client().collection(COLLECTION).document(uid).set(
            {PHONE_ATTACHED_FIELD: True}, merge=True
        )
    except Exception as exc:  # noqa: BLE001
        # The number IS on the account; only the marker failed. Harmless — the
        # next sign-in simply re-attaches the same number, which Firebase
        # accepts, and tries the marker again.
        log.warning("Could not mark the phone attached for %s: %s", uid, exc)
    return ""


#: The country a BARE national number is assumed to belong to.
#:
#: Only ever applied to a number with no country code at all, where there is
#: genuinely nothing else to go on — never to one that already carries a `+`.
#: Configurable so that assuming India is a deployment decision rather than a
#: fact buried in a helper, and so a second market does not need a code change.
DEFAULT_DIAL_CODE = "+91"


def _digits(raw: str) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _phone_key(raw: str) -> str:
    """Every digit, country code included — the canonical identity key.

    It used to be the last TEN digits, mirroring `phoneKey` in the Cloud
    Functions, on the reasoning that an Indian mobile is ten digits and anything
    to the left is a country code. That made `+14155550100` and
    `+914155550100` one identity, and in `functions/src/identity.ts` the same key
    decided whose `phoneNumber` and `email` to blank. See `functions/src/phone.ts`
    for the whole note; this is the Python half of the same change.
    """
    return _digits(raw)


def _legacy_phone_key(raw: str) -> str:
    """The old ten-digit key, for reading records written before the change.

    Never written. `scripts/survey_phone_keys.py` uses it to report what a
    migration would face.
    """
    digits = _digits(raw)
    return digits[-10:] if len(digits) > 10 else digits


def to_e164(raw: str) -> str:
    """A storable international number, or '' when there is nothing usable.

    An already-international number is returned as it came, digits and leading
    `+` only. A bare national number gets [DEFAULT_DIAL_CODE] — the one place
    India is still assumed, narrowed to the one case where no alternative
    information exists.

    The length gate this replaces was `len(key) != 10 -> give up`, which
    silently refused to attach any number whose national part was not ten
    digits. Several countries' are not, so those staff and partners simply never
    got phone sign-in, with nothing on any screen to say why.
    """
    raw = str(raw or "").strip()
    digits = _digits(raw)
    if not digits:
        return ""
    if raw.startswith("+"):
        return "+" + digits
    # A leading zero on a number with no `+` is a TRUNK PREFIX, not a country
    # code — `098765 43210` is how an Indian number is often written down, and
    # reading its eleven digits as "already international" produced `+09876…`,
    # a number no country owns. Stripped before the length is judged.
    digits = digits.lstrip("0")
    if not digits:
        return ""
    if len(digits) > 10:
        return "+" + digits
    # A national number shorter than six digits is a typo in any country, not a
    # short foreign number — the shortest national subscriber numbers in use are
    # six or seven digits. The `len(key) != 10` gate this replaces happened to
    # catch that as a side effect of assuming India; said explicitly here, the
    # sanity check survives without the assumption.
    if len(digits) < 6:
        return ""
    return DEFAULT_DIAL_CODE + digits


#: Per-capability states that mean the capability is not held. Mirrors
#: `functions/src/crmRoles.ts::deriveRoleFlags` and `storageClaims.ts` — the
#: three readers of `roleStatus` must agree or the app tag, the storage claim
#: and the session disagree about whether somebody is an Agency.
WITHDRAWN_PARTNER_STATES = frozenset({"revoked", "rejected", "suspended"})

#: The only per-capability state that earns an app tag.
HELD_FOR_APP = "approved"

#: The app fields this module may write for a PARTNER. Nothing else on
#: `users/{uid}` — not isProfileComplete, not isSuspended/isBanned, not
#: isOfficial, not a staff crmRole — is ever touched by the push or the repair.
APP_ROLE_FIELDS = ("isAgent", "isSeller", "ownAgencyId", "agencyId", "crmRole")


def _capability_state(doc: dict, capability: str) -> str:
    """One capability's state: its own `roleStatus` entry, else the login's
    `status` (single-role and legacy documents carry only that), else
    'approved' (pre-status documents, which were approved by construction)."""
    statuses = doc.get("roleStatus") if isinstance(doc.get("roleStatus"), dict) else {}
    own = str(statuses.get(capability) or "").strip()
    if own:
        return own
    return str(doc.get("status") or "").strip() or HELD_FOR_APP


def app_role_flags(crm_doc: dict | None) -> dict:
    """The app-side role flags a `crmUsers` document earns. Pure.

    A capability earns its tag only when it is listed on the login (`roles`, or
    the primary `role` on a document with no list) AND its state is approved —
    never from the one `role` string alone (how Agency + Seller became "Seller
    only"), and never for a pending, revoked, rejected or suspended capability.
    Mirrors `functions/src/crmRoles.ts::deriveRoleFlags`.
    """
    doc = crm_doc or {}
    if not doc or doc.get("isActive") is False:
        return {"isAgent": False, "isSeller": False}
    role = str(doc.get("role") or "")
    listed = doc.get("roles") if isinstance(doc.get("roles"), list) and doc.get("roles") else [role]
    held = {str(r) for r in listed if str(r) and _capability_state(doc, str(r)) == HELD_FOR_APP}
    return {
        "isAgent": PARTNER_CRM_ROLE[Role.AGENCY] in held,
        "isSeller": PARTNER_CRM_ROLE[Role.SELLER] in held,
    }


def app_role_patch(crm_doc: dict | None, users_doc: dict) -> dict:
    """The minimal change that makes `users_doc` agree with `crm_doc`. Pure.

    Empty when they already agree — which is what makes the push and the repair
    idempotent. Only `APP_ROLE_FIELDS` can appear in the result.

      * isAgent / isSeller — set to the entitlement, independently.
      * ownAgencyId — the person's OWN Agency / Sub-agency, set while the Agency
        capability is held and removed when it is not.
      * agencyId — NEVER written with the person's own agency any more. It
        means one thing: the agency a HOST works under (commission, roster,
        payouts, live rooms). Overloading it with the owner's agency is what
        overwrote a Host's parent when they became a Sub-agency, and then
        deleted it on revocation. The only touch here is a one-off cleanup: a
        value equal to their own agency on someone who is NOT a Host is a
        leftover of the old overload and is removed. A Host's agencyId is never
        changed by this function.
      * crmRole — a partner value ('agency' / 'seller', written by the old
        `_attach_app_identity`) becomes '' as `syncMyRoles` writes it, so the
        badge does not render a partner as a staff label. A staff crmRole is
        never touched.
    """
    from firebase_admin import firestore as fb_firestore

    doc = crm_doc or {}
    users_doc = users_doc or {}
    flags = app_role_flags(doc)
    patch: dict = {}
    for key in ("isAgent", "isSeller"):
        if (users_doc.get(key) is True) != flags[key] or key not in users_doc:
            patch[key] = flags[key]
    own_agency = str(doc.get(PARTNER_LINK_FIELD[Role.AGENCY]) or "").strip()
    current_own = str(users_doc.get("ownAgencyId") or "").strip()
    if flags["isAgent"] and own_agency:
        if current_own != own_agency:
            patch["ownAgencyId"] = own_agency
    elif "ownAgencyId" in users_doc:
        patch["ownAgencyId"] = fb_firestore.DELETE_FIELD
    host_agency = str(users_doc.get("agencyId") or "").strip()
    if own_agency and host_agency == own_agency and users_doc.get("isHost") is not True:
        patch["agencyId"] = fb_firestore.DELETE_FIELD
    if str(users_doc.get("crmRole") or "") in PARTNER_CRM_ROLE.values():
        patch["crmRole"] = ""
    return patch


def push_app_role_flags(uid: str) -> str:
    """Write the current partner flags onto `users/{uid}`, if it exists. Blocking.

    Called after every partner decision (approve, reject, suspend, reactivate,
    revoke) so the Android app — which renders the Agency / Seller tag from
    `users/{uid}` through a live listener — changes at the moment of the
    decision, not at the person's next sign-in. `syncMyRoles` derives the same
    flags at sign-in and on every cold start; this is the push half.

    Does NOT create the document: `update`, not `set`, so a document deleted
    between the read and the write is refused rather than resurrected. Writes
    only `APP_ROLE_FIELDS`, and nothing at all when they already agree.
    Never raises — returns '' or a sentence.
    """
    uid = (uid or "").strip()
    if not uid:
        return ""
    try:
        crm_doc = read(uid)
        ref = firebase.firestore_client().collection("users").document(uid)
        snap = ref.get()
        if not snap.exists:
            return ""
        patch = app_role_patch(crm_doc, snap.to_dict() or {})
        if patch:
            ref.update(patch)
        return ""
    except Exception as exc:  # noqa: BLE001
        log.warning("users/%s role flags not pushed: %s", uid, exc)
        return f"the app role flags on users/{uid} were not updated ({exc})"


def _attach_app_identity(
    *,
    uid: str,
    email: str,
    phone: str,
    name: str,
    crm_role: str,
    agency_id: str | None = None,
    seller_id: str | None = None,
    email_proven: bool = False,
) -> str:
    """Make the CRM account and the app account ONE Firebase account.

    ── THE PROBLEM ──────────────────────────────────────────────────────────

    `isCrmUser()` in `firestore.rules` is
    `exists(/crmUsers/$(request.auth.uid))`. It keys on the **uid**. The CRM
    signs in with email and password; the app signs in with phone OTP, Google
    or as a guest. Those are different Firebase accounts for the same human —
    so a CRM admin who opened the Android app arrived holding a uid with no
    `crmUsers` document: no authority, no badge, and a second `users` document
    to go with it. Everything downstream was then matched on a *string* — the
    `verifiedIdentities` join — which silently broke the moment somebody
    changed their phone number.

    ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────

    Two things, both on the account that already exists:

    1. Attaches the phone number to that same Firebase user, so phone OTP in
       the app resolves to **this uid**. No linking screen, no second
       password, nothing for the person to understand — they sign in the way
       every other app user does and land on the account the CRM knows.

    2. Creates `users/{uid}` pre-tagged with the role, because the app refuses
       to sign in somebody whose user document is missing, and a CRM account
       has never had one.

    ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────

    It does not set `isProfileComplete`. Staff pick a display name, a gender
    and a date of birth like anyone else; pre-completing the profile would
    push them straight into a feed with no gender set, and gender decides call
    pricing.

    It does not resolve a phone-number conflict. If the number already belongs
    to another Firebase account — usually this same person's ordinary app
    account, made before they joined — detaching it is somebody's decision,
    not a side effect of saving a staff record. It is reported instead.

    Returns "" on success, or a sentence describing what did not happen. Never
    raises: a CRM account that works is not withheld because the app half is
    lagging.
    """
    if not uid:
        return ""

    observer = (settings.observer_email or "").strip().lower()
    if observer and email == observer:
        # The observer is read-only, has no Firebase account by design, and must
        # never acquire an app identity. `remove_observer_documents` exists for
        # the same reason.
        return ""

    notes: list[str] = []
    # ── E.164 in, E.164 out ──────────────────────────────────────────────────
    #
    # This block had three India assumptions stacked on each other, and the
    # third was the damaging one:
    #
    #   * `len(key) == 10` or give up — so a staff member whose national number
    #     is nine or eleven digits got no phone sign-in at all, silently;
    #   * `+91` prepended to a bare number — defensible as a default, and now
    #     `DEFAULT_DIAL_CODE` so it is a deployment decision;
    #   * `phoneNumber = f"+91{key}"` written UNCONDITIONALLY. `key` was the
    #     last ten digits, so a US staff member's `+1 415 555 0100` was stored
    #     on their own user document as `+914155550100` — a real Indian number
    #     belonging to somebody else, written over their own.
    #
    # Now: the number is normalised once and the SAME value is both attached to
    # Firebase and written to the document, so the two cannot disagree.
    e164 = to_e164(phone)
    key = _phone_key(e164)
    attached = False

    if e164:
        # Phase 1A (CONTACT-002): the typed number is NOT attached to the
        # Firebase account — see `attach_phone_to_login`. It is recorded on the
        # user document only when the account already holds it, verified.
        if typed_phone_already_verified(uid, e164):
            attached = True
        else:
            notes.append(
                "their phone was not attached to the sign-in (a typed number is "
                "never attached automatically); they verify it with an OTP in "
                "the app"
            )

    is_partner = crm_role in (PARTNER_CRM_ROLE.get(Role.AGENCY), PARTNER_CRM_ROLE.get(Role.SELLER))
    # From the WHOLE login (every capability, minus withdrawn ones), not from
    # the one role being written now — see `app_role_flags`.
    try:
        flags = app_role_flags(read(uid)) if is_partner else {"isAgent": False, "isSeller": False}
    except Exception:  # noqa: BLE001
        # Unknown is not "none" and not "the one role being written": leave the
        # flags as they are. `syncMyRoles` and the next push correct them.
        flags = {}
    # P0-5 (AUTHN-1): a partner's address reaches the app account only once the
    # sign-in holds it VERIFIED. A typed `ownerEmail` written here squatted the
    # address (its real owner was refused as `active_holder` when binding it)
    # and misrouted every lookup by email. Staff addresses are set by an Owner
    # through the audited staff API and are unchanged.
    app_email = email if (not is_partner or email_proven) else ""
    if is_partner and email and not email_proven:
        notes.append(
            "their email was not written to the app account: a partner's address "
            "is recorded there only once it is verified on the sign-in"
        )
    patch: dict = {
        "uid": uid,
        # '' for a partner, exactly as `syncMyRoles` writes it. Writing 'agency'
        # here while `syncMyRoles` wrote '' made the badge depend on which of
        # the two had written last.
        "crmRole": "" if is_partner else crm_role,
        **flags,
        # Staff carry the official badge; a partner does not — they are external.
        "isOfficial": not is_partner,
        "lastSeen": int(datetime.now(timezone.utc).timestamp() * 1000),
    }
    if app_email:
        patch["email"] = app_email
    if attached:
        # The number as Firebase now holds it, and the key derived from that
        # same value — never a reconstructed one.
        patch["phoneNumber"] = e164
        patch["phoneKey"] = key
    if agency_id and flags.get("isAgent"):
        # Only while the Agency capability is actually held (approved). Into
        # `ownAgencyId` — `agencyId` is the agency a Host works under.
        patch["ownAgencyId"] = agency_id
    if seller_id:
        patch["sellerId"] = seller_id

    try:
        client = firebase.firestore_client()
        ref = client.collection("users").document(uid)
        if not ref.get().exists:
            patch["isProfileComplete"] = False
            patch["createdAt"] = datetime.now(timezone.utc)
            patch["createdVia"] = "crm"
            # B19: the display name only seeds a document being CREATED. On an
            # existing app account it is the person's own — chosen at profile
            # setup — and applying for a role, or a staff record being saved,
            # must not replace it with a business or form name.
            patch["name"] = name or "Team"
        # Merge, always. This runs again on every role change and must never
        # flatten a profile the person has since filled in themselves.
        ref.set(patch, merge=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("users/%s not written for %s: %s", uid, email, exc)
        notes.append(
            f"their app account (users/{uid}) was not created ({exc}); they "
            "will not be able to sign in to the Android app until it is"
        )

    return "; ".join(notes)


def remove_observer_documents(email: str) -> tuple[tuple[str, str], ...]:
    """Delete every `crmUsers` document for an address that must not have one.

    Returns (document id, the role it carried) for each deletion, so the caller
    can say what write access was withdrawn rather than that "something" was.
    """
    removed: list[tuple[str, str]] = []
    for doc_id, data in find_by_email(email):
        try:
            _collection().document(doc_id).delete()
        except Exception as exc:  # noqa: BLE001
            raise DirectoryError(
                f"crmUsers/{doc_id} grants '{data.get('role', '')}' write access "
                f"to {email} and could not be deleted: {exc}"
            ) from exc
        removed.append((doc_id, str(data.get("role", ""))))
    return tuple(removed)


def mirror(
    *,
    uid: str,
    email: str,
    name: str,
    role: Role,
    created_by: str,
    phone: str = "",
    field_charge: str | None = None,
    reports_to: str | None = None,
    is_active: bool = True,
    partner_id: str | None = None,
    partner_status: str = "pending",
) -> Outcome:
    """Make the Firestore half agree with the Mongo record.

    For a role in `NOT_MIRRORED` this **removes** any document rather than
    writing one, and reports what it removed. That is not an edge case: it is the
    observer, and the whole point of the account.

    ── `partner_id` — an agency or a coin seller ────────────────────────────
    Supplied only by `partner_ops.attach_login`, and it is what distinguishes
    "this address must have no document" from "this address is the owner of that
    partner record". Without it `Role.AGENCY` and `Role.SELLER` behave exactly
    as they always have — they are in `NOT_MIRRORED`, and calling this for one
    *removes* documents — so every existing caller is untouched, including the
    repair script, which must keep reporting a partner rather than writing one.

    The partner branch shares this function's body rather than duplicating it:
    the same crmId minting, the same `createdBy` / `createdAt` preservation, the
    same one write, the same `Outcome`. What differs is the payload — a partner
    carries a link field (`agencyId` / `sellerId`), a `roles` array and a
    per-capability `roleStatus`, and carries no `dept`, no `reportsTo` and no
    permissions, because `DEFAULT_PERMISSIONS['agency']` is empty and a partner
    is authorised by the record they own, not by a permission list.

    Raises `DirectoryError` on any failure. It never returns quietly having done
    half the job — a caller that has already written the Mongo row needs to know,
    because a staff row with no CRM document is an account that cannot sign in.
    """
    email = (email or "").strip().lower()
    partner_id = str(partner_id or "").strip()
    # FX-04: a STAFF document is found by address and signs in with it, so it
    # needs one. A PARTNER login document is keyed by uid and is what the app's
    # role flags are derived from (`app_role_flags`, `deriveRoleFlags`): an
    # applicant who signed in with a verified PHONE and has no email must still
    # get one, or an approved partner never sees their role (RF-01). Such a
    # document carries no address and `emailProven: False` — nothing invented.
    if not email and not partner_id:
        raise DirectoryError("A crmUsers document needs an email address.")

    if partner_id and role not in PARTNER_LINK_FIELD:
        raise DirectoryError(
            f"A partner record was named for '{role}', which is not an external "
            "partner role. A link field on a staff document would give a staff "
            "account an agency's scope in the security rules, so nothing was "
            "written."
        )

    if role in NOT_MIRRORED and not partner_id:
        why = NOT_MIRRORED[role]
        removed = remove_observer_documents(email)
        if removed:
            return Outcome(
                action="removed",
                uid=uid,
                email=email,
                crm_role=None,
                detail=(
                    f"{email} is {role} — {why}. "
                    f"{len(removed)} document(s) granting write access removed."
                ),
                removed=removed,
            )
        return Outcome(
            action="absent_by_design",
            uid=uid,
            email=email,
            crm_role=None,
            detail=f"{email} is {role} — {why}. No document, which is correct.",
        )

    crm_role = (
        PARTNER_CRM_ROLE[role] if partner_id else CRM_ROLE.get(role)
    )
    if crm_role is None:
        raise DirectoryError(
            f"'{role}' has no CRM equivalent and no recorded reason to be "
            "absent, so nothing can be written for it. Add it to CRM_ROLE or to "
            "NOT_MIRRORED in app/services/crm_directory.py."
        )

    if not uid:
        raise DirectoryError(
            f"{email} has no Firebase uid. The document id must be the uid the "
            "CRM signs in with, so writing it under anything else creates a "
            "record nobody can reach."
        )

    existing = read(uid) or {}
    team = team_of(role)
    now = datetime.now(timezone.utc)

    payload: dict = {
        "uid": uid,
        "email": email,
        "name": name,
        "role": crm_role,
        "phone": phone or existing.get("phone", "") or "",
        # Reset from the role's defaults, not merged with what was there. A role
        # change that left the old role's permissions behind would keep a
        # demoted finance admin's `can_process_payout` on a Firestore screen.
        # `DEFAULT_PERMISSIONS` is empty for both partner roles, which is not an
        # oversight: an external partner is authorised by the record it owns.
        "permissions": list(DEFAULT_PERMISSIONS.get(crm_role, ())),
        "isActive": is_active,
        "createdBy": existing.get("createdBy") or created_by,
    }

    if partner_id:
        # The three fields that make this a partner's document, and the exact
        # ones `firestore.rules` and `lib/partnerRouting.ts` read. `roles` is
        # merged with whatever is there rather than replaced, so attaching a
        # login to the seller record of a login that already runs an agency does
        # not quietly withdraw the agency capability.
        held = [
            r
            for r in (existing.get("roles") or [existing.get("role", "")])
            if r in PARTNER_CRM_ROLE.values()
        ]
        payload[PARTNER_LINK_FIELD[role]] = partner_id
        payload["roles"] = held + ([crm_role] if crm_role not in held else [])
        payload["status"] = partner_status
        # ── A SECOND CAPABILITY DOES NOT REPLACE THE FIRST ──────────────────
        #
        # `role` and `status` name the capability the account was created
        # with; `roles` / `roleStatus` carry each capability. An Agency that
        # applies to be a Coin Seller too (the self-application path) used to
        # come out of here as `role: 'seller', status: 'pending'` — which
        # moved the Storage claim off `agency` (so the agency lost access to
        # its own KYC prefix) and routed an approved agency to the waiting
        # room. When the login already holds a different partner role, both
        # stay as they were and only the per-capability fields move.
        prior_role = str(existing.get("role") or "")
        if prior_role in PARTNER_CRM_ROLE.values() and prior_role != crm_role:
            payload["role"] = prior_role
            payload["status"] = existing.get("status") or partner_status
        payload["roleStatus"] = {
            **(existing.get("roleStatus") or {}),
            crm_role: partner_status,
        }
        # P0-5 (AUTHN-1): stamped by the server from the Auth record, never
        # from a form. Only a document whose address the sign-in itself holds
        # VERIFIED may be found by address (`core/security.py`'s fallback).
        email_proven = typed_email_already_verified(uid, email)
        payload["emailProven"] = email_proven
    else:
        payload["dept"] = str(team) if team else None
        payload["fieldCharge"] = field_charge or None
        payload["reportsTo"] = reports_to or None

    # Written once and never rewritten — the team screen shows it, and a value
    # that changed on every save would not identify anybody.
    if not existing.get("crmId"):
        payload["crmId"] = _new_crm_id()
    if not existing.get("createdAt"):
        payload["createdAt"] = now
        payload["lastLoginAt"] = existing.get("lastLoginAt")

    try:
        _collection().document(uid).set(payload, merge=True)
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(
            f"Could not write crmUsers/{uid} for {email}: {exc}"
        ) from exc

    # Not part of signing in. A failure here leaves a complete, working account
    # that the Android app has not been told about, so it is reported rather
    # than raised — refusing an otherwise-finished account over it would be the
    # replica breaking the record again, in a third place.
    #
    # Skipped entirely for a partner. `verifiedIdentities` is how the Android app
    # decides somebody is *staff* and stamps `crmRole` on their account; writing
    # an agency into it would mark an external partner as a member of the team in
    # the app, which is the opposite of what this document says.
    identity_note = (
        ""
        if partner_id
        else _write_verified_identity(
            email=email, phone=str(payload["phone"]), name=name, crm_role=crm_role
        )
    )

    # One uid on both surfaces. Reported, never raised — see the docstring.
    app_note = _attach_app_identity(
        uid=uid,
        email=email,
        phone=str(payload["phone"]),
        name=name,
        crm_role=crm_role,
        agency_id=payload.get(PARTNER_LINK_FIELD[Role.AGENCY]) if partner_id else None,
        seller_id=payload.get(PARTNER_LINK_FIELD[Role.SELLER]) if partner_id else None,
        email_proven=bool(payload.get("emailProven")) if partner_id else True,
    )

    # P1-E: staff only — a partner is not on the staff roster.
    roster_note = "" if partner_id else write_roster(
        uid, name=name, crm_role=crm_role, dept=payload.get("dept"), is_active=is_active)

    detail = f"{email} → {crm_role}" + ("" if is_active else " (no access)")
    if partner_id:
        detail += f" ({PARTNER_LINK_FIELD[role]}={partner_id}, {partner_status})"
    for note in (identity_note, app_note, roster_note):
        if note:
            detail += f"; {note}"
    return Outcome(
        action="written",
        uid=uid,
        email=email,
        crm_role=crm_role,
        detail=detail,
    )


def set_active(*, uid: str, email: str, role: Role, is_active: bool) -> Outcome:
    """Carry an activation change across to Firestore.

    Deactivation has to reach both halves or it is not a deactivation: the API
    revoking a session stops nothing if `crmUsers.isActive` still says true, and
    the shell will open on the Firestore-backed screens.
    """
    email = (email or "").strip().lower()

    if role in NOT_MIRRORED:
        # Nothing to flip, but re-assert the absence — this is the one moment a
        # stray document for a read-only account would be noticed.
        removed = remove_observer_documents(email)
        if removed:
            return Outcome(
                action="removed",
                uid=uid,
                email=email,
                crm_role=None,
                detail=(
                    f"{email} is {role} and had {len(removed)} document(s) it "
                    "should never have had. Removed."
                ),
                removed=removed,
            )
        return Outcome(
            action="absent_by_design",
            uid=uid,
            email=email,
            crm_role=None,
            detail=f"{email} is {role} — no document to change, which is correct.",
        )

    existing = read(uid)
    if existing is None:
        # Nothing to update, and saying "done" would be a lie. The account is
        # already half-missing; the caller decides what to do about it.
        raise DirectoryError(
            f"{email} has no crmUsers/{uid} document, so its access could not "
            f"be changed there. Repair with:  {REPAIR_COMMAND}"
        )

    try:
        _collection().document(uid).set({"isActive": is_active}, merge=True)
    except Exception as exc:  # noqa: BLE001
        raise DirectoryError(
            f"Could not set isActive={is_active} on crmUsers/{uid} "
            f"for {email}: {exc}"
        ) from exc

    roster_note = "" if existing.get("agencyId") or existing.get("sellerId") else set_roster_active(uid, is_active)
    return Outcome(
        action="written",
        uid=uid,
        email=email,
        crm_role=str(existing.get("role", "")) or None,
        detail=f"{email} → {'active' if is_active else 'no access'}" + (f"; {roster_note}" if roster_note else ""),
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Async wrappers
# ══════════════════════════════════════════════════════════════════════════════
#
# The Firestore Admin client is blocking. The service layer is not, so every call
# from it goes through a worker thread rather than stalling the event loop for
# the length of a round trip to Google.


async def amirror(**kwargs) -> Outcome:
    return await asyncio.to_thread(lambda: mirror(**kwargs))


async def aset_active(**kwargs) -> Outcome:
    return await asyncio.to_thread(lambda: set_active(**kwargs))


async def aread(uid: str) -> dict | None:
    return await asyncio.to_thread(read, uid)
