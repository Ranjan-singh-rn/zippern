"""Applying for a partner role from the app — and what a user may apply for.

── WHERE THIS SITS ─────────────────────────────────────────────────────────

The Android app never calls this API directly; it has no session here and
there is no Firebase-ID-token dependency. It calls Cloud Functions callables
(`submitPartnerApplication`, `submitHostApplication`, `partnerEligibility`,
`partnerParents`), which present the partner-registration service key and
forward the signed-in user's uid from `context.auth`. So:

    app  →  callable (verifies auth, forwards uid)  →  THIS MODULE

and every rule lives here, server-side, against the authoritative Mongo
`partners` collection. The callable is a thin authenticated proxy; it decides
nothing. A client that bypasses the callable and writes Firestore directly is
caught by the registration trigger, which lands in `ensure_partner_record`
with the same enforcement.

── THE ROLE MODEL ──────────────────────────────────────────────────────────

What a human may ADD, given what they hold:

    holds nothing            → Host, Agency, Sub-agency, Coin Seller
    Host under a MAIN agency → Sub-agency, Coin Seller
    Host under a SUB-agency  → Coin Seller
    Agency                   → Coin Seller
    Sub-agency               → Coin Seller
    Coin Seller              → Host, Agency, Sub-agency

Forbidden, always: a second agency-family record (Agency + Agency, Agency +
Sub-agency, Sub-agency + Sub-agency) and a second Coin Seller. Held means
pending, approved, suspended or REVOKED; rejected records hold nothing.

A revoked role (a revoked partner record, or a revoked Host) still constrains
the table exactly like a held one, so restoring it can never produce a
forbidden pair — and its own kind is refused with `REVOKED_REFUSAL`: the way
back is a reinstatement request (`services/role_appeals`), not a new record.

Those rules compose: a person with several roles gets the INTERSECTION of
what each role still permits. Agency + Seller → nothing further (the agency
forbids the family; the seller forbids a second seller; Host is forbidden to
an Agency). Host-under-main + Seller → Sub-agency only.

The family rule itself (one agency-family record per human) is enforced by
`partner_roles.claim_role_family` under an `_id` lock at creation; what this
module adds is the rest of the table, and the parent rules, BEFORE a record
is written — so an ineligible application is refused with a sentence rather
than created and rejected.

Spec §3 (B2): the ONE shared eligibility function is `assert_eligible`,
called at every door — application, invitation, approval, restoration and
migration — see the section headed "THE ONE SHARED ELIGIBILITY FUNCTION".
Spec §4: a decided (rejected) application is never replayed into an approval
(`DECIDED_REFUSAL`); the person applies again and that is a new record.
Owner, Observer and staff are refused by name (`internal_refusal`).

── OWNERSHIP ───────────────────────────────────────────────────────────────

Every document this module writes carries `ownerUid` = the signed-in uid,
written by the server. It is never taken from the request body. That is the
field `onAgencyApproved` addresses its notice to, the field
`ensure_partner_record` resolves `owner_crm_uid` from, and the field the
one-agency-per-human rule needs to see the record at all.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from pymongo.errors import DuplicateKeyError

from app.core import audit
from app.core.account_state import app_account_refusal
from app.core.roles import partner_role_for
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import crm_directory as crm
from app.services import notices
from app.services import partner_ops as ops
from app.services import partner_roles
from app.services import user_roles
from app.services.partner_ops import PartnerOpsError
from app.services.partners import PartnerKind, PartnerStatus

log = logging.getLogger(__name__)

#: What counts as HOLDING a role for the purpose of eligibility. Rejected
#: records are history and hold nothing. A REVOKED record is held (C1): it
#: constrains the table and blocks its own kind with `REVOKED_REFUSAL`.
HELD_STATUSES = {
    str(PartnerStatus.PENDING),
    str(PartnerStatus.APPROVED),
    str(PartnerStatus.SUSPENDED),
    str(PartnerStatus.REVOKED),
    # Decision 15: approved, waiting for verified contacts — held like pending.
    str(PartnerStatus.AWAITING_VERIFICATION),
}

#: C1 — `blocked[kind]` for a revoked kind. One sentence, owned by
#: `partner_roles` so the creation and approval paths say the same thing.
REVOKED_REFUSAL = partner_roles.REVOKED_REFUSAL

#: B32 — one pending self-filed Host application per person, held by an `_id`
#: lock (`_id` = the applicant's uid) for as long as the application is pending.
HOST_APPLICATION_LOCKS = "host_application_locks"

#: How long a lock whose application document is not yet visible counts as an
#: application being filed right now rather than a lock left by a crash.
HOST_LOCK_SETTLE = 60  # seconds

KINDS = ("host", "agency", "sub_agency", "seller")

#: The table above, as "what each held role still allows to be ADDED".
_ALLOWS: dict[str, frozenset[str]] = {
    "host_under_main": frozenset({"sub_agency", "seller"}),
    "host_under_sub": frozenset({"seller"}),
    # A Host whose agency link is missing (legacy data). Host + Agency is
    # forbidden for every Host, and Sub-agency is allowed only under a known
    # main agency, so this Host may add a Coin Seller role only.
    "host_unattached": frozenset({"seller"}),
    "agency": frozenset({"seller"}),
    # RC (confirmed role rule): a Sub-agency under main Agency X may ALSO be a
    # Host under X — and nowhere else (not under another agency, not under
    # any sub-agency). The "under X only" half is the parent pin
    # (`eligible_kinds` → `parent_for`), enforced wherever a parent is chosen
    # or a role is decided.
    "sub_agency": frozenset({"seller", "host"}),
    "seller": frozenset({"host", "agency", "sub_agency"}),
}

#: The sentence for a pinned parent, by the kind being added.
PINNED_PARENT_REFUSAL = {
    "host": (
        "As a Sub-agency of {parent}, you may be a Host only directly under {parent} — "
        "not under another agency and not under any sub-agency."
    ),
    "sub_agency": (
        "As a Host under {parent}, you may be a Sub-agency only under {parent}."
    ),
}


class ApplicationError(PartnerOpsError):
    """Refused by an eligibility or validation rule. Safe to show the applicant."""


#: The machine-readable refusal for "no verified contact" (approved contact
#: rule). The API returns it in the error detail, the callable forwards it in
#: `HttpsError.details`, and the app routes on it to phone / email
#: verification instead of showing a dead-end sentence.
CONTACT_REQUIRED = "CONTACT_REQUIRED"


class ContactRequired(ApplicationError):
    """The applicant holds no VERIFIED phone or email. Machine-readable.

    `requirement` is `"one_of"`: one verified contact is enough for every
    partner application — the only operation that needs BOTH is redeeming an
    agency's Host invitation (`functions/src/hosts.ts`), which is not decided
    here. `missing` names the contacts that would satisfy it; `email_unverified`
    says the account HAS an email that only needs confirming.
    """

    code = CONTACT_REQUIRED

    def __init__(self, message: str, *, missing: list[str], email_unverified: bool,
                 requirement: str = "one_of") -> None:
        super().__init__(message)
        self.missing = list(missing)
        self.email_unverified = bool(email_unverified)
        self.requirement = requirement

    def api_detail(self) -> dict[str, Any]:
        """The structured error `detail` the API returns for this refusal: the
        same sentence as `message` (which `functions/src/index.ts → apiMessage`
        already reads) plus the machine-readable code and what is missing.
        Routers call this by duck typing (`api_detail`), so the HTTP layer does
        not depend on this module."""
        return {
            "message": str(self),
            "code": self.code,
            "requirement": self.requirement,
            "missing": list(self.missing),
            "emailUnverified": self.email_unverified,
        }


def refusal_detail(exc: Exception) -> Any:
    """What the API sends as the error `detail` for a refusal.

    A plain sentence for every ordinary refusal — unchanged, so every existing
    reader keeps working — and the structured `api_detail()` for a refusal
    that carries one (`ContactRequired`).
    """
    detail = getattr(exc, "api_detail", None)
    return detail() if callable(detail) else str(exc)


# ── Firestore plumbing ───────────────────────────────────────────────────────

async def _fs(fn, *args, **kwargs):
    return await asyncio.to_thread(fn, *args, **kwargs)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _user_doc(uid: str) -> dict:
    snap = await _fs(firebase.firestore_client().collection("users").document(uid).get)
    if not snap.exists:
        raise ApplicationError("Your account could not be found. Sign in again and retry.")
    return snap.to_dict() or {}


async def _pending_host_application(uid: str) -> dict | None:
    """A self-filed host application still awaiting a decision — or, Decision 15
    (RC), approved and waiting for verified contacts — if any. Either one will
    become the Host role, so either one binds like a held Host."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    def _q():
        for status in ("pending", "awaiting_verification"):
            q = (
                firebase.firestore_client()
                .collection("hostApplications")
                .where(filter=FieldFilter("applicantUid", "==", uid))
                .where(filter=FieldFilter("status", "==", status))
                .limit(1)
            )
            for snap in q.stream():
                d = snap.to_dict() or {}
                d["id"] = snap.id
                return d
        return None

    return await _fs(_q)


# ── What a user holds, and what they may add ────────────────────────────────

INTERNAL_REFUSAL = (
    "ZIPPER staff accounts cannot hold partner roles. Partner roles are for "
    "people outside the company."
)

#: §8 — the Owner and the Observer are refused by name: neither may hold a
#: partner or department role, and the sentence should say which governance
#: identity is being refused rather than call them "staff".
OWNER_REFUSAL = "An Owner cannot hold a partner role (Host, Agency, Sub-agency or Coin Seller)."
OBSERVER_REFUSAL = "The Observer cannot hold a partner role (Host, Agency, Sub-agency or Coin Seller)."


def internal_refusal(internal_role: Any) -> str:
    """The refusal for an internal identity, by what it is (pure)."""
    role = str(internal_role or "").strip().lower()
    if role in ("owner", "superadmin"):
        return OWNER_REFUSAL
    if role == "observer":
        return OBSERVER_REFUSAL
    return INTERNAL_REFUSAL


GUEST_REFUSAL = (
    "Guest accounts cannot apply for partner or host roles. Add and verify your "
    "phone number or email first."
)


def is_unverified_guest(uid: str) -> bool:
    """AUTH-002 (Phase 1A): is this uid a guest, judged from VERIFIED identity?

    Read from the Firebase Auth record — never from `users/{uid}`, whose
    contact fields were client-written. A person is a guest unless the account
    carries an OTP-verified phone number or a verified email. A missing record
    is treated as a guest (fail closed): nothing about it is verified.
    """
    uid = (uid or "").strip()
    if not uid:
        return True
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        return True
    if rec is None:
        return True
    phone = str(getattr(rec, "phone_number", "") or "").strip()
    email = str(getattr(rec, "email", "") or "").strip()
    email_ok = bool(email) and bool(getattr(rec, "email_verified", False))
    return not (phone or email_ok)


def contact_status(uid: str) -> dict[str, bool]:
    """Blocking — what the Firebase Auth RECORD holds, for the contact rule.

    The same source `is_unverified_guest` reads, never `users/{uid}` or a form:
    `phone` (OTP-verified by construction), `email` (present at all) and
    `email_verified`. A missing record, or an error, holds nothing.
    """
    out = {"phone": False, "email": False, "email_verified": False}
    uid = (uid or "").strip()
    if not uid:
        return out
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        return out
    if rec is None:
        return out
    out["phone"] = bool(str(getattr(rec, "phone_number", "") or "").strip())
    out["email"] = bool(str(getattr(rec, "email", "") or "").strip())
    out["email_verified"] = out["email"] and bool(getattr(rec, "email_verified", False))
    return out


def contact_required_error(uid: str) -> ContactRequired:
    """Blocking — the machine-readable refusal for an applicant with no verified contact."""
    status_ = contact_status(uid)
    return ContactRequired(
        GUEST_REFUSAL,
        missing=["phone", "email"],
        email_unverified=status_["email"] and not status_["email_verified"],
    )


def contact_block(uid: str, guest: bool) -> dict[str, Any]:
    """Blocking — the eligibility answer's `contact` block, for the app to show
    BEFORE the form: whether a verified contact is still required, and which.
    """
    if not guest:
        return {"required": False, "code": "", "requirement": "one_of", "missing": [], "emailUnverified": False}
    err = contact_required_error(uid)
    return {
        "required": True,
        "code": err.code,
        "requirement": err.requirement,
        "missing": list(err.missing),
        "emailUnverified": err.email_unverified,
        "message": str(err),
    }


def _verified_login_email(uid: str) -> str:
    """P0-5 (AUTHN-1): the sign-in's own address, if Firebase holds it verified; else ''."""
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        return ""
    if rec is None or not bool(getattr(rec, "email_verified", False)):
        return ""
    return str(getattr(rec, "email", "") or "").strip().lower()


async def internal_identity(uid: str) -> str:
    """The internal role this uid holds, or '' for an ordinary person.

    Reuses the two authoritative sources the rest of the system already uses,
    rather than a third definition:

      * Mongo `staff` through `users.protected_staff_row` — the same check that
        protects Owners, the Observer and every department role from user
        moderation (fail-closed on unknown roles);
      * `crmUsers/{uid}.role`, read through `crm_directory`, when it is one of
        the CRM spellings of an internal role (`superadmin` = Owner,
        `<team>_admin` / `<team>_member`). A partner login's `agency` / `seller`
        is not internal.

    NOT the app's `isOfficial` badge or `crmRole` field: those are display
    state, written by sync, and must never decide eligibility.
    """
    uid = (uid or "").strip()
    if not uid:
        return ""
    from app.services import users as users_svc  # local: keeps this module's import graph light

    row = await users_svc.protected_staff_row(uid)
    if row is not None:
        return str(row.get("role") or "staff")
    try:
        doc = await crm.aread(uid)
    except Exception:  # noqa: BLE001 — Mongo staff is the authority; this is a second net
        doc = None
    role = crm.normalise_crm_role(str((doc or {}).get("role") or ""))
    if role and (role in crm.INTERNAL_CRM_ROLES or role == "observer"):
        return role
    return ""


def _iso(value: Any) -> str:
    """A stored moment as ISO text, or '' — for the eligibility payload."""
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return str(isoformat())
        except Exception:  # noqa: BLE001 — a shape we do not recognise
            return ""
    return value.strip() if isinstance(value, str) else ""


def _moment(value: Any) -> float | None:
    """A stored moment as epoch seconds, or None when it cannot be read."""
    ts = getattr(value, "timestamp", None)
    if callable(ts):
        try:
            return float(ts())
        except Exception:  # noqa: BLE001
            return None
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def host_state(user: dict | None) -> str:
    """`"active"`, `"suspended"`, `"revoked"` or `""` for one `users/{uid}`
    document. Pure.

    Suspended (§5 partner role suspension) = a Host whose role is paused by
    `users.suspend_host`: still `isHost`, still holding the slot, the agency
    and the record — only Host actions stop until `resume_host`.

    Revoked (C1) = not a Host now, a revocation stamp on the document
    (`hostRevokedAt`, or the older `hostRemovedAt`), and no restore after it.
    `restore_host` sets `isHost` back, so in practice a revocation stamp on a
    non-Host IS a standing revocation; the restore comparison is a guard for a
    document whose stamps say otherwise.
    """
    user = user or {}
    if user.get("isHost"):
        return "suspended" if user_roles.host_role_suspended(user) else "active"
    revoked = user.get("hostRevokedAt") or user.get("hostRemovedAt")
    if not revoked:
        return ""
    restored = user.get("hostRestoredAt")
    if restored:
        r, v = _moment(restored), _moment(revoked)
        if r is not None and v is not None and r >= v:
            return ""
    return "revoked"


async def held_roles(uid: str) -> dict[str, Any]:
    """Everything this human currently holds, from authoritative records.

    Partner roles come from Mongo `partners` (`owner_crm_uid` — or, B07, the
    Firestore document's `crmUid`/`ownerUid` for a record whose Mongo link was
    never written), status in `HELD_STATUSES`, which includes `revoked` (C1).
    Host comes from `users/{uid}.isHost` — or a standing revocation, as
    `status: revoked` — with the kind of its agency resolved from Mongo so
    "host under main" and "host under sub" can be told apart. A pending
    self-filed host application also counts as holding Host, so a person
    cannot file two.

    `revoked` lists every revoked role with its open or latest reinstatement
    request (C1/C2), so the app can offer "Request reinstatement" instead of
    "Join as …".
    """
    out: dict[str, Any] = {
        "uid": uid,
        "internal": await internal_identity(uid),
        "guest": await asyncio.to_thread(is_unverified_guest, uid),
        "partners": [],
        "host": None,
        "pending_host_application": None,
        "revoked": [],
    }
    for row in await partner_roles.records_owned_by(uid, db=get_db()):
        status = str(row.get("status") or "")
        if status not in HELD_STATUSES:
            continue
        revoked = status == str(PartnerStatus.REVOKED)
        out["partners"].append({
            "id": str(row["_id"]),
            "kind": str(row.get("kind") or ""),
            "status": status,
            "name": str(row.get("name") or ""),
            "parent_id": row.get("parent_id"),
            "revoked_at": _iso(row.get("revoked_at")) if revoked else "",
            "revoked_reason": str(row.get("revocation_reason") or "") if revoked else "",
        })

    try:
        user = await _user_doc(uid)
    except ApplicationError:
        user = {}
    state = host_state(user)
    if state:
        agency_id = str(user.get("agencyId") or "").strip()
        parent_kind = ""
        if agency_id:
            parent = await get_db()[C.PARTNERS].find_one({"_id": agency_id})
            parent_kind = str((parent or {}).get("kind") or "")
        out["host"] = {
            "agency_id": agency_id,
            "parent_kind": parent_kind,
            "verified": bool(user.get("isVerifiedHost")),
            "status": state,
            "revoked_at": (
                _iso(user.get("hostRevokedAt") or user.get("hostRemovedAt"))
                if state == "revoked" else ""
            ),
            # §5: a paused Host role says until when and why (the app shows it).
            **({"suspended_until": _iso(user.get("hostSuspendedUntil")) or None,
                "suspension_reason": str(user.get("hostSuspendedReason") or "")}
               if state == "suspended" else {}),
        }
    if state not in ("active", "suspended"):
        pending = await _pending_host_application(uid)
        if pending:
            p_agency = str(pending.get("agencyId") or "").strip()
            p_parent = await get_db()[C.PARTNERS].find_one({"_id": p_agency}) if p_agency else None
            out["pending_host_application"] = {
                "id": pending["id"],
                "agency_id": p_agency,
                "parent_kind": str((p_parent or {}).get("kind") or ""),
                "status": str(pending.get("status") or "pending"),
            }
    out["revoked"] = await _revoked_roles(uid, out, user)
    return out


async def _revoked_roles(uid: str, held: dict[str, Any], user: dict) -> list[dict[str, Any]]:
    """C1 `revoked`: `[{kind, record_id, revoked_at, reason, appeal}]`.

    `appeal` is the open or latest reinstatement request for that role
    (`services/role_appeals`), or None. For a Host, `record_id` is the uid.
    """
    from app.services import role_appeals  # local: role_appeals imports this module

    rows: list[dict[str, Any]] = []
    for p in held.get("partners", []):
        if p.get("status") != str(PartnerStatus.REVOKED):
            continue
        rows.append({
            "kind": p["kind"],
            "record_id": p["id"],
            "revoked_at": p.get("revoked_at", ""),
            "reason": p.get("revoked_reason", ""),
            "appeal": await role_appeals.appeal_summary(uid, p["kind"], p["id"], db=get_db()),
        })
    host = held.get("host") or {}
    if host.get("status") == "revoked":
        rows.append({
            "kind": "host",
            "record_id": uid,
            "revoked_at": host.get("revoked_at", ""),
            "reason": str(user.get("hostRevokedReason") or ""),
            "appeal": await role_appeals.appeal_summary(uid, "host", uid, db=get_db()),
        })
    return rows


def eligible_kinds(held: dict[str, Any]) -> dict[str, Any]:
    """Apply the table to what is held. Pure, so the matrix is unit-testable.

    Returns `{"options": [...], "blocked": {kind: reason}}` — the reasons are
    for the app to show beside a greyed-out choice, in the user's words.
    """
    # Internal identities hold no partner role, ever — before any other rule
    # (§3 / §8: Owner + any other role, Observer + any other role, Staff +
    # partner role are all prohibited). The sentence names the Owner and the
    # Observer, whose exclusion is a governance rule rather than a staffing one.
    if held.get("internal"):
        return {"options": [], "blocked": {k: internal_refusal(held.get("internal")) for k in KINDS}}
    # AUTH-002 (Phase 1A): a guest holds no partner or host role, ever.
    if held.get("guest"):
        return {"options": [], "blocked": {k: GUEST_REFUSAL for k in KINDS}}

    allowed: set[str] = set(KINDS)
    blocked: dict[str, str] = {}
    constraints: list[frozenset[str]] = []
    # RC role rule: the one parent a second role may sit under, by kind.
    parent_for: dict[str, str] = {}

    for p in held.get("partners", []):
        k = p["kind"]
        # C1: a REVOKED record constrains exactly like a held one, so restoring
        # it can never produce a forbidden pair. Its own kind says "request
        # reinstatement"; a live record's sentence wins where both exist, which
        # is why the revoked branch only fills what is still empty.
        revoked = str(p.get("status") or "") == str(PartnerStatus.REVOKED)
        if k in ("agency", "sub_agency"):
            constraints.append(_ALLOWS[k])
            label = notices.role_label(k)
            if k == "sub_agency":
                # RC role rule: Host directly under this sub-agency's MAIN agency only.
                main_of_sub = str(p.get("parent_id") or "").strip()
                if main_of_sub:
                    parent_for["host"] = main_of_sub
                else:
                    # No main agency to pin the Host to: the pair cannot be
                    # checked, so it is not offered.
                    constraints.append(frozenset({"seller"}))
                    blocked.setdefault(
                        "host",
                        "Your Sub-agency names no main agency, so a Host role cannot be "
                        "matched to it. Contact ZIPPER staff.",
                    )
            if revoked:
                sibling = "sub_agency" if k == "agency" else "agency"
                blocked.setdefault(k, partner_roles.revoked_refusal(k))
                blocked.setdefault(
                    sibling,
                    f"Your {label} role was revoked and still counts: one "
                    "agency-family role per person. Request reinstatement instead.",
                )
                if k == "agency":
                    blocked.setdefault("host", f"An {label} cannot also be a Host, and a revoked one still counts.")
            elif str(p.get("status") or "") == str(PartnerStatus.PENDING):
                # QA #33: an application with a reviewer is not a role held —
                # "You already hold a Sub-agency" told a person whose first
                # application was still waiting that they had one.
                blocked[k] = f"Your {label} application is already with a reviewer."
                sibling = "sub_agency" if k == "agency" else "agency"
                blocked.setdefault(
                    sibling,
                    f"Your {label} application is with a reviewer. One agency-family role per person.",
                )
                if k == "agency":
                    blocked["host"] = f"An {label} cannot also be a Host, and your {label} application is with a reviewer."
            else:
                blocked["agency"] = f"You already hold a {label}. One agency-family role per person."
                blocked["sub_agency"] = blocked["agency"]
                if k == "agency":
                    blocked["host"] = f"An {label} cannot also be a Host."
                if str(p.get("status") or "") == str(PartnerStatus.AWAITING_VERIFICATION):
                    # Decision 15 (RC): approved, not started — say that, not "you hold".
                    # QA #34: which contact is missing is on the screen above this line.
                    blocked[k] = (
                        f"Your {label} role is approved. It starts once your contact details "
                        "are verified — see what is still needed above."
                    )
        elif k == "seller":
            constraints.append(_ALLOWS["seller"])
            if revoked:
                blocked.setdefault("seller", partner_roles.revoked_refusal("seller"))
            elif str(p.get("status") or "") == str(PartnerStatus.AWAITING_VERIFICATION):
                blocked["seller"] = (
                    "Your Coin Seller role is approved. It starts once your contact details "
                    "are verified — see what is still needed above."
                )
            elif str(p.get("status") or "") == str(PartnerStatus.PENDING):
                blocked["seller"] = "Your Coin Seller application is already with a reviewer."  # QA #33
            else:
                blocked["seller"] = "You already hold a Coin Seller role."

    # A PENDING Host application binds like a held Host: it will become one on
    # approval, so whatever a Host under that parent may not add, the applicant
    # may not add either. (It used to block only a second Host application, so
    # Host + Agency was reachable by filing both before either was decided.)
    # A REVOKED Host binds the same way (C1).
    host = held.get("host") or held.get("pending_host_application")
    if host:
        pk = host.get("parent_kind") or ""
        key = (
            "host_under_sub" if pk == "sub_agency"
            else "host_under_main" if pk == "agency"
            else "host_unattached"
        )
        constraints.append(_ALLOWS[key])
        held_host = held.get("host")
        if held_host and str(held_host.get("status") or "active") == "revoked":
            blocked["host"] = partner_roles.revoked_refusal("host")
        elif held_host and str(held_host.get("status") or "") == "suspended":
            # §5: the role is paused, not gone — it comes back when resumed.
            blocked["host"] = "Your Host role is suspended. It is the same role and comes back when it is resumed."
        elif held_host:
            blocked["host"] = "You are already a Host."
        elif str((held.get("pending_host_application") or {}).get("status") or "") == "awaiting_verification":
            blocked["host"] = (
                "Your Host application is approved. It starts once your contact details "
                "are verified — see what is still needed above."
            )
        else:
            blocked["host"] = "Your Host application is already with a reviewer."
        if key == "host_under_main":
            blocked.setdefault("agency", "A Host under an agency cannot also run a main agency.")
            # RC role rule: a Sub-agency only under the main agency this Host is under.
            host_parent = str(host.get("agency_id") or "").strip()
            if host_parent:
                parent_for["sub_agency"] = host_parent
        elif key == "host_under_sub":
            blocked.setdefault("agency", "A Host under a sub-agency can add a Coin Seller role only.")
            blocked.setdefault("sub_agency", blocked["agency"])

    for c in constraints:
        allowed &= set(c)

    options = [k for k in KINDS if k in allowed]
    return {
        "options": options,
        "blocked": {k: v for k, v in blocked.items() if k not in allowed},
        # RC role rule: the only parent the kind may be added under.
        "parent_for": {k: v for k, v in parent_for.items() if k in options},
    }


def parent_pin_refusal(table: dict[str, Any], kind: str, parent_id: str, parent_name: str = "") -> str:
    """'' when `parent_id` is allowed for `kind`; otherwise the sentence (RC role rule)."""
    pinned = str((table.get("parent_for") or {}).get(kind) or "").strip()
    if not pinned or str(parent_id or "").strip() == pinned:
        return ""
    return PINNED_PARENT_REFUSAL.get(kind, "That agency cannot be chosen for this role.").format(
        parent=parent_name or pinned
    )


async def eligibility(uid: str) -> dict[str, Any]:
    uid = str(uid or "").strip()
    if not uid:
        raise ApplicationError("A signed-in user is required.")
    held = await held_roles(uid)
    table = eligible_kinds(held)
    # `revoked` at the top level too (C1), where the app reads it. `contact`
    # (approved contact rule): whether a verified contact is still required,
    # machine-readable, so the app can explain it and route to verification
    # before the form is filled in. Not required for internal staff, who are
    # refused for a different reason.
    contact = await asyncio.to_thread(
        contact_block, uid, bool(held.get("guest")) and not held.get("internal")
    )
    # Decision 15 (RC): applying needs ONE verified contact (above); the role
    # STARTS only with BOTH. Said before the form, so nobody is surprised by
    # an approved role that has not started.
    from app.services import contact_verification  # local: keeps the import graph acyclic

    v = await asyncio.to_thread(contact_verification.status, uid)
    activation = {
        "requirement": "both",
        "complete": v.complete,
        "missing": v.missing,
        "emailUnproved": v.email_unproved,
    }
    return {**table, "held": held, "revoked": held.get("revoked", []), "contact": contact,
            "activation": activation}


# ── The parents a sub-agency or host may hang under ─────────────────────────

def _live_partner(row: dict | None, kind: str | None = None) -> bool:
    """Approved, active — and of `kind`, when one is named. Pure."""
    if not row:
        return False
    if kind is not None and str(row.get("kind") or "") != kind:
        return False
    return (
        str(row.get("status") or "") == str(PartnerStatus.APPROVED)
        and bool(row.get("is_active", False))
    )


def _current_agency_names(ids: list[str]) -> dict[str, str]:
    """Blocking — B20: each agency's CURRENT name, from its Firestore document.

    The Mongo `name` is written once, at creation, and a rename lands only on
    the Firestore document — so the Host selector and the application showed
    a name the agency no longer uses. One batched read; an id that cannot be
    read is simply absent and the caller keeps the Mongo name.
    """
    wanted = [i for i in dict.fromkeys(str(x or "").strip() for x in ids) if i]
    if not wanted:
        return {}
    out: dict[str, str] = {}
    try:
        client = firebase.firestore_client()
        refs = [client.collection(ops.FS_AGENCIES).document(i) for i in wanted]
        get_all = getattr(client, "get_all", None)
        snaps = list(get_all(refs)) if callable(get_all) else [ref.get() for ref in refs]
        for snap in snaps:
            if getattr(snap, "exists", False):
                name = ops._derive_name(ops.FS_AGENCIES, snap.to_dict() or {})
                if name:
                    out[str(snap.id)] = name
    except Exception:  # noqa: BLE001 — a stale name is better than no list
        log.warning("current agency names could not be read; using the Mongo names")
    return out


async def eligible_parents(for_kind: str) -> list[dict[str, Any]]:
    """Approved, active agencies that may take a sub-agency (main only) or a
    host (main agencies and sub-agencies, the latter labelled with their parent).

    Read from Mongo so a suspended, revoked or merely-pending agency never
    appears; the app shows this list and nothing else, and the server
    re-validates the chosen id on submission regardless.

    B21: a sub-agency is offered only while its MAIN agency is approved and
    active — the same rule its own approval applies. B20: names are the
    agencies' current Firestore names, the Mongo name being the fallback.
    """
    kinds = [str(PartnerKind.AGENCY)]
    if for_kind == "host":
        kinds.append(str(PartnerKind.SUB_AGENCY))
    cursor = get_db()[C.PARTNERS].find(
        {"kind": {"$in": kinds}, "status": str(PartnerStatus.APPROVED), "is_active": True}
    )
    rows = [row async for row in cursor]
    live_mains = {
        str(r["_id"]) for r in rows
        if str(r.get("kind") or "") == str(PartnerKind.AGENCY) and _live_partner(r)
    }
    names = await asyncio.to_thread(
        _current_agency_names,
        [str(r["_id"]) for r in rows] + [str(r.get("parent_id") or "") for r in rows],
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        pid = str(row["_id"])
        kind = str(row.get("kind") or "")
        parent = str(row.get("parent_id") or "")
        if kind == str(PartnerKind.SUB_AGENCY) and parent not in live_mains:
            continue
        out.append({
            "id": pid,
            "name": names.get(pid) or str(row.get("name") or ""),
            "kind": kind,
            "parent_id": row.get("parent_id"),
            "parent_name": (names.get(parent) if parent else "") or str(row.get("parent_name") or ""),
        })
    out.sort(key=lambda r: (r["kind"] != "agency", r["name"].lower()))
    return out


async def _validate_host_parent(parent_id: str, applicant_uid: str) -> dict:
    """A host's agency: an approved, active MAIN agency or SUB-agency.

    B21: a sub-agency qualifies only while its own main agency is approved and
    active. B07: "your own agency" is decided from the resolved owner, so a
    record whose owner sits only on its Firestore document is still yours.
    """
    pid = str(parent_id or "").strip()
    if not pid:
        raise ApplicationError("Choose the agency you want to join.")
    parent = await get_db()[C.PARTNERS].find_one({"_id": pid})
    if parent is None or str(parent.get("kind") or "") not in (
        str(PartnerKind.AGENCY), str(PartnerKind.SUB_AGENCY)
    ):
        raise ApplicationError("That agency does not exist. Choose one from the list.")
    if (
        str(parent.get("status") or "") != str(PartnerStatus.APPROVED)
        or not parent.get("is_active", False)
    ):
        raise ApplicationError(
            f"{parent.get('name') or 'That agency'} is not accepting hosts right now."
        )
    if str(parent.get("kind") or "") == str(PartnerKind.SUB_AGENCY):
        main = await get_db()[C.PARTNERS].find_one({"_id": str(parent.get("parent_id") or "")})
        if not _live_partner(main, str(PartnerKind.AGENCY)):
            raise ApplicationError(
                f"{parent.get('name') or 'That agency'} is not accepting hosts right "
                "now — its main agency is not active."
            )
    if await partner_roles.owner_uid_of(parent, db=get_db()) == applicant_uid:
        raise ApplicationError("You cannot join your own agency as a host.")
    return parent


# ── Submitting ──────────────────────────────────────────────────────────────

def _referral_code(stem: str) -> str:
    """A server-minted referral code. The app never chooses one."""
    alphabet = ops._REFERRAL_ALPHABET
    head = "".join(ch for ch in (stem or "").upper() if ch in alphabet)[:4].ljust(4, "Z")
    return head + "".join(secrets.choice(alphabet) for _ in range(4))


_STR_FIELDS_AGENCY = (
    "agencyName", "ownerName", "ownerPhone", "ownerEmail", "address",
    "paymentType", "country", "binanceUid", "accountHolderName", "accountNumber",
    "ifscCode", "bankName", "branch", "upiId", "currency",
)
_STR_FIELDS_SELLER = (
    "displayName", "phone", "email", "city", "description",
)
_PAYMENT_FIELDS = (
    # The Coin Seller settlement block. Mirrors what the agency form already
    # collects for bank/UPI/Binance, plus a QR image and a free-text
    # international method, which is all the business has asked for.
    "accountHolderName", "accountNumber", "ifscCode", "bankName", "branch",
    "upiId", "upiQrUrl", "binanceUid", "internationalMethod", "internationalDetails",
    "currency",
)


def _clean(form: dict, allowed: tuple[str, ...]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in allowed:
        value = form.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            out[key] = text[:500]
    return out


def _stored_url_ok(url: str) -> bool:
    """An uploaded file's link: https — or, in the local test copy only, a
    Storage-emulator link (`isolation.is_local_emulator_media_url`)."""
    from app.config import settings
    from app.core import isolation

    return url.startswith("https://") or isolation.is_local_emulator_media_url(settings, url)


def _urls(form: dict, key: str, max_items: int = 3) -> list[str]:
    raw = form.get(key) or []
    if not isinstance(raw, list):
        return []
    return [u for u in (str(x).strip() for x in raw) if _stored_url_ok(u)][:max_items]


# ══════════════════════════════════════════════════════════════════════════════
#  THE ONE SHARED ELIGIBILITY FUNCTION (spec §3)
# ══════════════════════════════════════════════════════════════════════════════
#
# "The backend must enforce one shared role-eligibility function during
# application, invitation, approval, restoration and migration." That function
# is `assert_eligible` below. Every door onto a partner or Host role goes
# through it, naming the door it is:
#
#     application   `submit_partner_application`, `submit_host_application`,
#                   `refuse_client_created_registration` (a client-created
#                   Firestore document), `reapply_sub_agency`
#     invitation    an agency's Host invitation being decided
#                   (`users.decide_host_application` → `grant_host`)
#     approval      `partner_ops.approve_partner` / `reactivate_partner` (through
#                   `_enforce_role_rules_at_decision`)
#     restoration   `users.restore_host`, a decided reinstatement request
#                   (`role_appeals.decide` → the existing restore)
#     migration     `partner_ops.attach_login` (B16) — a record that already
#                   exists being bound to a login
#
# The table itself is `eligible_kinds` (pure) over `held_roles` (authoritative
# records). What the contexts differ in is only WHAT IS EXCLUDED from "held"
# (the record being decided is not held against itself) and the closing words.
# Nothing else — not the Owner/Observer/staff exclusion, not the family rule,
# not the revoked-kind refusal, not the parent pin — varies by door.
#
# The three older names (`recheck_at_decision`, `recheck_host_restore`,
# `_refuse_if_ineligible`) are kept as thin wrappers so no caller changes.

ELIGIBILITY_CONTEXTS = ("application", "invitation", "approval", "restoration", "migration")

_CLOSING = {
    "application": "",
    "invitation": " Nothing was approved.",
    "approval": " Nothing was approved.",
    "restoration": " Nothing was restored.",
    "migration": " Nothing was approved.",
}

#: §4 — a DECIDED application is never replayed into approval. A rejected
#: record stays rejected as history (Decision 16: the person applies again,
#: and that is a NEW record); an approved one is approved once.
DECIDED_REFUSAL = (
    "This application was already decided ({status}). A decided application is "
    "never replayed into an approval: the person applies again, which is a new "
    "record, and the decided one stays as history."
)


async def _decided_record_refusal(partner_id: str) -> str:
    """'' unless `partner_id` names a record whose decision is final (rejected)."""
    pid = str(partner_id or "").strip()
    if not pid:
        return ""
    row = await get_db()[C.PARTNERS].find_one({"_id": pid})
    status = str((row or {}).get("status") or "")
    if status == str(PartnerStatus.REJECTED):
        return DECIDED_REFUSAL.format(status=status)
    return ""


async def assert_eligible(
    uid: str,
    kind: str,
    *,
    context: str,
    exclude_partner_id: str = "",
    exclude_host_application_id: str = "",
    ignore_guest: bool = False,
    parent_id: str = "",
    parent_name: str = "",
    restoring_host: bool = False,
) -> dict[str, Any]:
    """May `uid` hold `kind`, judged NOW, for this `context`? Raises ApplicationError.

    Returns what the person holds (the `held_roles` answer, after exclusions),
    so a caller that needs the parent pin can read it without a second query.

      * `exclude_partner_id` — the partner record being decided is not held
        against itself (approval / migration);
      * `exclude_host_application_id` — the host application being decided is
        not held against itself (invitation / restoration);
      * `restoring_host` — the revoked Host role itself is not held against its
        own restoration; its agency is checked against the parent pin;
      * `ignore_guest` — `partner_ops.attach_login` (B16) only: the login it
        attaches is created by staff with an unverified address, which is not
        the app-guest case the guest rule exists for. Every other rule applies.

    §4: in the `approval` and `migration` contexts the excluded record is read,
    and a REJECTED one is refused with `DECIDED_REFUSAL` — a decided application
    cannot be replayed into an approval.
    """
    kind = str(kind or "").strip()
    if context not in ELIGIBILITY_CONTEXTS:
        raise ValueError(f"'{context}' is not an eligibility context: {ELIGIBILITY_CONTEXTS}")
    if kind not in KINDS:
        raise ApplicationError("Choose Host, Agency, Sub-agency or Coin Seller.")
    closing = _CLOSING[context]

    if context in ("approval", "migration") and exclude_partner_id:
        decided = await _decided_record_refusal(exclude_partner_id)
        if decided:
            raise ApplicationError(decided)

    held = await held_roles(uid)
    if ignore_guest:
        held["guest"] = False
    if exclude_partner_id:
        held["partners"] = [p for p in held.get("partners", []) if p.get("id") != exclude_partner_id]
    pending = held.get("pending_host_application")
    if pending and exclude_host_application_id and pending.get("id") == exclude_host_application_id:
        held["pending_host_application"] = None
    restoring = held.get("host") or {}
    if restoring_host:
        held["host"] = None

    table = eligible_kinds(held)
    if kind not in table["options"]:
        if context == "application" and held.get("guest") and not held.get("internal"):
            # Approved contact rule: no verified contact is refused with the
            # machine-readable `ContactRequired` (same sentence as before), so
            # the caller can route to verification. Staff are refused as staff.
            raise await asyncio.to_thread(contact_required_error, uid)
        if context == "application":
            fallback = f"You cannot apply as a {notices.role_label(kind)} right now."
        else:
            fallback = f"This person cannot hold a {notices.role_label(kind)} {'role ' if kind == 'host' else ''}now."
        raise ApplicationError((table["blocked"].get(kind) or fallback) + closing)

    # RC role rule: the second role sits under the one parent it may.
    pin_against = parent_id if not restoring_host else str(restoring.get("agency_id") or "")
    if pin_against:
        pinned = parent_pin_refusal(table, kind, pin_against, parent_name)
        if pinned:
            raise ApplicationError(pinned + closing)
    return held


async def recheck_at_decision(
    uid: str, kind: str, *, exclude_partner_id: str = "", exclude_host_application_id: str = "",
    ignore_guest: bool = False, parent_id: str = "",
) -> None:
    """Re-run the role table at APPROVAL / REACTIVATION time. Raises ApplicationError.

    An application was checked when it was filed; the person may have gained
    a role since (or filed two at once). The record being decided is removed
    from what they hold, so the question is "may somebody holding everything
    ELSE add this?" — the same table, the same answer as at submission.

    A revoked role is part of "everything else" (C1): a new record of a
    revoked kind is refused with `REVOKED_REFUSAL` here too, so it cannot be
    approved even when it reached the queue by a path that did not check.

    `ignore_guest` is for `partner_ops.attach_login` (B16) only: the login it
    attaches is created by staff with an unverified address, which is not the
    app-guest case the guest rule exists for. Every other rule still applies.

    The one shared function is `assert_eligible`; this is the approval /
    invitation / migration door onto it (a host application being decided is
    an invitation; a partner record with a login being attached is a migration).
    """
    # A host application being decided is the invitation door; a partner record
    # is the approval door. (`attach_login` is the migration door and arrives
    # here too — the exclusion and the refusal are the same as an approval's.)
    context = "invitation" if (exclude_host_application_id and not exclude_partner_id) else "approval"
    await assert_eligible(
        uid, kind, context=context,
        exclude_partner_id=exclude_partner_id,
        exclude_host_application_id=exclude_host_application_id,
        ignore_guest=ignore_guest, parent_id=parent_id,
    )


async def recheck_host_restore(uid: str, *, exclude_host_application_id: str = "") -> None:
    """The role table for RESTORING a revoked Host. Raises ApplicationError.

    The revoked Host itself is not held against its own restoration; the rest
    of the table applies, with the confirmed role rule (RC): a Sub-agency under
    main Agency X may be a Host only directly under X. So a Host who went on to
    hold a Sub-agency of the SAME main agency may have the Host role back (the
    old B33 case, now the rule itself); a Host whose Sub-agency sits under a
    different agency may not. The restoration door onto `assert_eligible`.
    """
    await assert_eligible(
        uid, "host", context="restoration",
        exclude_host_application_id=exclude_host_application_id, restoring_host=True,
    )


async def _refuse_if_ineligible(uid: str, kind: str) -> dict[str, Any]:
    """The application door onto `assert_eligible`."""
    return await assert_eligible(uid, kind, context="application")


#: Sources a CLIENT writes when it creates an `agencies` / `sellers` document
#: itself — the signed-in CRM public signup forms. `firestore.rules` pins every
#: non-staff create arm to this value. One definition, in `partner_ops`.
CLIENT_CREATED_SOURCES = ops.CLIENT_CREATED_SOURCES


async def refuse_client_created_registration(uid: str, kind: str) -> None:
    """Approved contact rule — "a Firestore create must not bypass the server's
    application eligibility checks". Raises ApplicationError.

    A document a client created straight in Firestore is registered by the
    trigger through `ensure_partner_record`, which on its own applies only the
    one-agency claim, the revoked-kind refusal and the parent check. This holds
    the person it names to the SAME checks the app's application path applies
    before it writes anything (`submit_partner_application`): not restricted,
    and eligible by the whole table — staff refused, guest refused with
    `ContactRequired`, every forbidden combination refused.

    A missing `users/{uid}` document is not a restriction: a brand-new CRM
    signup login usually has none yet.
    """
    uid = str(uid or "").strip()
    if not uid:
        return
    try:
        user = await _user_doc(uid)
    except ApplicationError:
        user = {}
    if user.get("isBanned") or user.get("isSuspended") or str(user.get("accountState") or "") in (
        "banned", "suspended"
    ):
        raise ApplicationError("This account cannot apply for a partner role right now. Nothing was created.")
    await _refuse_if_ineligible(uid, kind)


async def submit_partner_application(
    uid: str, kind: str, form: dict, parent_id: str | None, actor: dict
) -> dict[str, Any]:
    """File an Agency, Sub-agency or Coin Seller application for `uid`.

    Order, and why:

      1. eligibility — the whole table, from authoritative records;
      2. parent validation (sub-agency) — before anything is written;
      3. the Firestore document, with `ownerUid` and `crmUid` SET BY THE
         SERVER, `status: pending`, and nothing that could approve it;
      4. `ensure_partner_record` — the same path every partner takes. It
         re-validates the parent and takes the one-agency-per-human claim
         under the `_id` lock; two simultaneous applications from one person
         resolve to exactly one record. If it refuses, the Firestore document
         just written is deleted again, so nothing is left half-made;
      5. the `crmUsers` login document, pending, so the CRM portal routes the
         person to the waiting room rather than nowhere;
      6. the audit row and the "application received" notice.
    """
    uid = str(uid or "").strip()
    kind = str(kind or "").strip()
    if kind not in ("agency", "sub_agency", "seller"):
        raise ApplicationError("Choose Agency, Sub-agency or Coin Seller.")
    if not uid:
        raise ApplicationError("A signed-in user is required.")
    form = dict(form or {})

    user = await _user_doc(uid)
    # RF-27: every restriction in every spelling (`accountState` first, then
    # the flags) — the same reading as the session check. Was `isBanned` only.
    if app_account_refusal(user) is not None:
        raise ApplicationError("This account cannot apply for a partner role.")

    held_now = await _refuse_if_ineligible(uid, kind)

    parent: dict | None = None
    if kind == "sub_agency":
        parent = await ops._validate_parent_agency(parent_id or "", uid)
        # RC role rule: a Host under main Agency Y may be a Sub-agency only under Y.
        pinned = parent_pin_refusal(eligible_kinds(held_now), "sub_agency", str(parent["_id"]),
                                    str(parent.get("name") or ""))
        if pinned:
            raise ApplicationError(pinned + " Nothing was filed.")

    now = _now()
    client = firebase.firestore_client()

    if kind == "seller":
        fields = _clean(form, _STR_FIELDS_SELLER)
        if not fields.get("displayName"):
            raise ApplicationError("A display name is required.")
        proof = _urls(form, "idDocUrls", 1) or _urls(form, "registrationProofUrl", 1)
        if not proof:
            raise ApplicationError("Upload one government-issued photo ID.")
        payment = _clean(form.get("payment") or {}, _PAYMENT_FIELDS)
        if not any(payment.get(k) for k in ("upiId", "upiQrUrl", "binanceUid", "accountNumber", "internationalDetails")):
            raise ApplicationError(
                "Add at least one way buyers can pay you — UPI, a QR code, a bank "
                "account, Binance, or an international method."
            )
        doc = {
            **fields,
            "email": fields.get("email") or str(user.get("email") or "").lower(),
            "phone": fields.get("phone") or str(user.get("phone") or ""),
            "registrationProofUrl": proof[0],
            # Settlement details. Bank account numbers are NOT public — only
            # `upiId`, `upiQrUrl` and `binanceUid` reach `publicSellers`
            # (see functions/src/publicSeller.ts). The full block is read in
            # the CRM behind staff authorisation like any KYC field.
            "payment": payment,
            "status": "pending",
            "isApproved": False,
            "isActive": False,
            "kycStatus": "submitted",
            "registrationFeePaid": False,
            "coinBalance": 0,
            "totalCoinsSold": 0,
            "qrCodeUrl": payment.get("upiQrUrl", ""),
            "crmId": ops._generate_crm_id(),
            "source": "self_app",
            "ownerUid": uid,
            "crmUid": uid,
            "createdAt": now,
            "updatedAt": now,
        }
        collection = ops.FS_SELLERS
    else:
        fields = _clean(form, _STR_FIELDS_AGENCY)
        if not fields.get("agencyName"):
            raise ApplicationError("An agency name is required.")
        kyc = _urls(form, "kycDocUrls", 3)
        if len(kyc) < 3:
            raise ApplicationError("Upload all three identity documents.")
        if fields.get("paymentType") == "foreign":
            if not fields.get("binanceUid"):
                raise ApplicationError("A Binance UID is required for international payout.")
        elif not (fields.get("accountNumber") and fields.get("ifscCode") and fields.get("bankName")):
            raise ApplicationError("Bank account number, IFSC and bank name are required.")
        doc = {
            **fields,
            "ownerEmail": fields.get("ownerEmail") or str(user.get("email") or "").lower(),
            "ownerPhone": fields.get("ownerPhone") or str(user.get("phone") or ""),
            "kycDocUrls": kyc,
            "crmId": ops._generate_crm_id(),
            "type": "sub" if kind == "sub_agency" else "main",
            "parentAgencyId": str(parent["_id"]) if parent else None,
            "status": "pending",
            "isActive": False,
            "kycStatus": "submitted",
            "currency": fields.get("currency") or ("USD" if fields.get("paymentType") == "foreign" else "INR"),
            "totalHosts": 0,
            "source": "self_app",
            "ownerUid": uid,
            "crmUid": uid,
            "createdAt": now,
            "updatedAt": now,
        }
        collection = ops.FS_AGENCIES

    # 3. The document. Auto id — it becomes the partner `_id`.
    ref = client.collection(collection).document()
    await _fs(ref.set, doc)
    partner_id = ref.id

    # 4. The record, through the same door as every other partner.
    try:
        record, created, warnings = await ops.ensure_partner_record(
            partner_id, actor, f"Self-application from the app by {uid}.",
            PartnerKind(kind),
        )
    except Exception:
        # Nothing half-made: the document is deleted again, whatever refused
        # or failed. The rule that refused is the same one the Firestore
        # trigger would have applied, so the outcome is identical either way;
        # this just keeps the applicant's sentence intact and the queue clean.
        try:
            await _fs(ref.delete)
        except Exception:  # noqa: BLE001
            log.exception("Could not remove refused application %s/%s", collection, partner_id)
        raise

    # 5. The login document, pending. Same writer as `attach_login`.
    #
    # P0-5 (AUTHN-1): the login's address is the one the SIGN-IN holds
    # verified, when it holds one. The typed address stays on the partner
    # record (`ownerEmail` / `email`) as contact information; it reaches the
    # login document only when there is nothing verified to use, and is then
    # stamped `emailProven: false` and never written to `users/{uid}`.
    try:
        await crm.amirror(
            uid=uid,
            email=(await asyncio.to_thread(_verified_login_email, uid))
            or str(doc.get("ownerEmail") or doc.get("email") or ""),
            name=str(doc.get("ownerName") or doc.get("displayName") or doc.get("agencyName") or ""),
            role=partner_role_for(kind),
            created_by=actor.get("uid", ""),
            phone=str(doc.get("ownerPhone") or doc.get("phone") or ""),
            is_active=True,
            partner_id=partner_id,
            partner_status=str(PartnerStatus.PENDING),
        )
    except Exception:  # noqa: BLE001
        log.exception("crmUsers/%s was not written for application %s", uid, partner_id)

    # 6. Audited as an application, and the applicant told.
    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_APPLIED,
        subject_type="partner",
        subject_id=partner_id,
        reason=f"Applied as {kind} from the app.",
        before=None,
        after={"kind": kind, "status": "pending", "owner_uid": uid,
               "parent_id": doc.get("parentAgencyId")},
        meta={"applicant_uid": uid, "source": "self_app", "warnings": warnings},
    )
    notified = await notices.partner_submitted(uid, kind, partner_id)

    return {
        "id": partner_id,
        "kind": kind,
        "status": "pending",
        "parent_id": doc.get("parentAgencyId"),
        "created": created,
        "warnings": warnings,
        "notified": notified,
    }


_HOST_FIELDS = (
    "hostName", "age", "dob", "country", "callRate",
    "paymentType", "binanceUid", "accountHolderName", "accountNumber",
    "ifscCode", "bankName", "branch", "upiId", "currency",
)


def _verified_contact(uid: str) -> tuple[str, str]:
    """Blocking — L3/B48: `(phone, email)` the sign-in itself holds VERIFIED.

    The phone on a Firebase account is OTP-verified by construction; the email
    counts only with `email_verified`. Nothing is taken from `users/{uid}` or
    the request body — both are client-written — so an application can only
    name contact details the applicant has proven they control.
    """
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        return "", ""
    if rec is None:
        return "", ""
    phone = str(getattr(rec, "phone_number", "") or "").strip()
    email = str(getattr(rec, "email", "") or "").strip().lower()
    if not bool(getattr(rec, "email_verified", False)):
        email = ""
    return phone, email


def _host_lock_is_stale(lock: dict) -> bool:
    """Blocking — B32: is this host-application lock left over rather than live?

    Live while its application is pending, or while an application written
    moments ago is not visible yet (`HOST_LOCK_SETTLE`). Stale once the
    application has been decided, or when it never appeared at all.
    """
    app_id = str(lock.get("application_id") or "").strip()
    if not app_id:
        return True
    try:
        snap = firebase.firestore_client().collection("hostApplications").document(app_id).get()
    except Exception:  # noqa: BLE001 — cannot tell, so it is not stale
        return False
    if getattr(snap, "exists", False):
        return str((snap.to_dict() or {}).get("status") or "pending") != "pending"
    claimed = lock.get("claimed_at")
    moment = _moment(claimed)
    return moment is None or (_now().timestamp() - moment) >= HOST_LOCK_SETTLE


async def _take_host_application_lock(uid: str, application_id: str) -> None:
    """B32 — one pending self-filed Host application per person, under an `_id` lock.

    `_refuse_if_ineligible` reads "is an application pending?" before anything
    is written, so two submits at the same moment both passed it and both
    wrote. The insert below is the lock: exactly one of two concurrent callers
    gets it. A lock whose application has been decided is released here as
    well as at the decision, so a person is never barred by a stale one.
    """
    db = get_db()
    doc = {"_id": uid, "application_id": application_id, "claimed_at": _now()}
    for _ in range(3):
        try:
            await db[HOST_APPLICATION_LOCKS].insert_one(doc)
            return
        except DuplicateKeyError:
            pass
        held = await db[HOST_APPLICATION_LOCKS].find_one({"_id": uid})
        if held is None:
            continue
        if await asyncio.to_thread(_host_lock_is_stale, held):
            await db[HOST_APPLICATION_LOCKS].delete_one(
                {"_id": uid, "application_id": held.get("application_id")}
            )
            continue
        break
    raise ApplicationError("Your Host application is already with a reviewer.")


async def release_host_application_lock(uid: str, application_id: str, *, db=None) -> None:
    """Give the B32 lock back — only if it is still this application's. Never raises."""
    uid = str(uid or "").strip()
    if not uid or not application_id:
        return
    try:
        await (db if db is not None else get_db())[HOST_APPLICATION_LOCKS].delete_one(
            {"_id": uid, "application_id": application_id}
        )
    except Exception:  # noqa: BLE001 — a stale lock is released by the next submit
        log.warning("host application lock for %s was not released", uid)


async def submit_host_application(
    uid: str, form: dict, parent_id: str, actor: dict
) -> dict[str, Any]:
    """File a Host application for `uid` — the same fields the agency's Invite
    Host form collects, written server-side, under a validated parent.

    The referral code is minted here and the application is `pending`. On
    approval `decide_host_application` sees `applicantUid` and grants the role
    directly (unverified); the code exists for consistency with invitations
    and so the agency can see it, not because this applicant must redeem it.
    """
    uid = str(uid or "").strip()
    if not uid:
        raise ApplicationError("A signed-in user is required.")
    form = dict(form or {})
    user = await _user_doc(uid)
    # RF-27: every restriction in every spelling, as above.
    if app_account_refusal(user) is not None:
        raise ApplicationError("This account cannot apply to be a Host right now.")

    held = await _refuse_if_ineligible(uid, "host")
    parent = await _validate_host_parent(parent_id, uid)
    # RC role rule: a Sub-agency of main Agency X may be a Host only under X.
    pinned = parent_pin_refusal(eligible_kinds(held), "host", str(parent["_id"]),
                                str(parent.get("name") or ""))
    if pinned:
        raise ApplicationError(pinned + " Nothing was filed.")

    fields = _clean(form, _HOST_FIELDS)
    name = fields.get("hostName") or str(user.get("name") or "").strip()
    if not name:
        raise ApplicationError("Your name is required.")
    kyc = _urls(form, "kycDocUrls", 3)
    if len(kyc) < 3:
        raise ApplicationError("Upload all three identity documents.")
    photo = _urls(form, "photoUrl", 1)
    if not photo:
        raise ApplicationError("A clear reference photo is required for facial verification.")

    # L3/B48: identity contact from the VERIFIED sign-in only.
    verified_phone, verified_email = await asyncio.to_thread(_verified_contact, uid)
    # B20: the agency's current name, not the one Mongo recorded at creation.
    agency_name = (
        (await asyncio.to_thread(_current_agency_names, [str(parent["_id"])])).get(str(parent["_id"]))
        or str(parent.get("name") or "")
    )

    now = _now()
    doc = {
        **fields,
        "hostName": name,
        "photoUrl": photo[0],
        "kycDocUrls": kyc,
        "kycStatus": "submitted",
        # Identity: from the signed-in account, never typed again — and only
        # what that account holds verified (L3): neither `users/{uid}` nor the
        # form body, both of which the client writes.
        "applicantUid": uid,
        "applicantPhone": verified_phone,
        "applicantEmail": verified_email,
        # Relationship: the validated parent. `agencyId` is the DIRECT parent
        # (a sub-agency's own id when joining under one), exactly as the
        # Invite Host form writes it, so the earnings hierarchy is unchanged.
        "agencyId": str(parent["_id"]),
        "agencyName": agency_name,
        "agencyKind": str(parent.get("kind") or ""),
        "referralCode": _referral_code(agency_name),
        "status": "pending",
        "isActivated": False,
        "source": "self_app",
        "createdAt": now,
        "createdBy": uid,
        "createdByName": name,
        "updatedAt": now,
    }
    client = firebase.firestore_client()
    ref = client.collection("hostApplications").document()
    # B32: the per-person lock, taken before the document exists and given
    # back if writing it fails.
    await _take_host_application_lock(uid, ref.id)
    try:
        await _fs(ref.set, doc)
    except Exception:
        await release_host_application_lock(uid, ref.id)
        raise

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_APPLIED,
        subject_type="host_application",
        subject_id=ref.id,
        reason="Applied as host from the app.",
        before=None,
        after={"kind": "host", "status": "pending", "agency_id": doc["agencyId"]},
        meta={"applicant_uid": uid, "source": "self_app", "agency_kind": doc["agencyKind"]},
    )
    notified = await notices.host_application_submitted(uid, ref.id)
    return {
        "id": ref.id,
        "kind": "host",
        "status": "pending",
        "agency_id": doc["agencyId"],
        "agency_kind": doc["agencyKind"],
        "notified": notified,
    }


# ── What a user has pending, for the app and the CRM user page ──────────────

#: Decision 16 (RC): the `source` of a re-application the API writes itself.
#: The registration trigger skips it (functions/src/index.ts) and
#: `firestore.rules` refuses it on every client create, exactly like `self_app`.
SOURCE_REAPPLY = "reapply"


async def reapply_sub_agency(
    parent_id: str, email: str, form: dict, actor: dict, *, reason: str = "",
) -> dict[str, Any]:
    """Decision 16 (RC) — a fresh Sub-agency application after a rejection.

    The confirmed rule: rejection releases the registration slot; the person
    may apply again, including under the same Agency; the rejected application
    and its decision history are preserved; the new application is a NEW record;
    concurrent submissions create no duplicate and no orphan.

    This is the door for the one path that could not do it — a parent agency
    adding, from its dashboard, a sub-agency whose LOGIN already exists from the
    rejected attempt (`createUserWithEmailAndPassword` refuses an address that
    has an account, so the dashboard could never file the second application).
    The app's own path (`submit_partner_application`) already files a fresh
    record after a rejection and is unchanged.

    The login is found by its address, and only one kind of login qualifies:
    one whose agency-family records are ALL rejected and include a rejected
    Sub-agency. Anything else — a live or revoked family record, a staff
    identity, an address with no such history — is refused, so this cannot
    hang an application on somebody else's account.

    Order, as in `submit_partner_application`: checks first; the Firestore
    document (source `reapply`, `reapplicationOf` naming the rejected record);
    `ensure_partner_record`, which takes the one-agency claim under its `_id`
    lock (two simultaneous re-applications resolve to one record — the loser's
    document is deleted again); then the login document is re-pointed at the
    new record, and the re-application is audited.
    """
    email = str(email or "").strip().lower()
    if "@" not in email:
        raise ApplicationError("Enter the sub-agency owner's email address.")
    form = dict(form or {})

    rec = await asyncio.to_thread(firebase.get_user_by_email, email)
    if rec is None:
        raise ApplicationError(
            "No Zipper login uses this address, so there is no earlier application to "
            "follow. Use Add Sub-Agency to create a new one."
        )
    uid = str(getattr(rec, "uid", "") or "").strip()
    if not uid:
        raise ApplicationError("The login for this address could not be read. Nothing was created.")
    if await internal_identity(uid):
        raise ApplicationError(INTERNAL_REFUSAL)

    family = [
        r for r in await partner_roles.records_owned_by(uid, db=get_db())
        if partner_roles.family_of(str(r.get("kind") or "")) == partner_roles.AGENCY_FAMILY
    ]
    rejected_subs = [
        r for r in family
        if str(r.get("kind") or "") == str(PartnerKind.SUB_AGENCY)
        and str(r.get("status") or "") == str(PartnerStatus.REJECTED)
    ]
    live = [r for r in family if str(r.get("status") or "") != str(PartnerStatus.REJECTED)]
    if live:
        held = live[0]
        raise ApplicationError(
            f"This person already holds a {str(held.get('kind') or 'agency').replace('_', '-')} "
            f"record ({held.get('_id')}) that is {held.get('status')}. One agency-family record "
            "per person. Nothing was created."
        )
    if not rejected_subs:
        raise ApplicationError(
            "This address belongs to a Zipper login with no rejected Sub-agency application, "
            "so it cannot be re-applied for here. Ask the person to apply themselves, or "
            "contact ZIPPER staff. Nothing was created."
        )

    # The role table, as the parent-created path applies it: the combinations
    # (a Host under another agency, a revoked role, …) — but not the guest arm,
    # because a parent-created login is a fresh password account; the contact
    # rule that matters for it is Decision 15, at activation. The same shared
    # function as every other door (§3), with the parent pin applied to the
    # validated parent.
    parent = await ops._validate_parent_agency(parent_id or "", uid)
    try:
        await assert_eligible(
            uid, "sub_agency", context="application", ignore_guest=True,
            parent_id=str(parent["_id"]), parent_name=str(parent.get("name") or ""),
        )
    except ApplicationError as exc:
        text = str(exc)
        raise ApplicationError(
            text if text.endswith("Nothing was created.") else text + " Nothing was created."
        ) from exc

    fields = _clean(form, _STR_FIELDS_AGENCY)
    if not fields.get("agencyName"):
        raise ApplicationError("A sub-agency name is required.")
    kyc = _urls(form, "kycDocUrls", 3)
    if len(kyc) < 3:
        raise ApplicationError("Upload all three identity documents.")
    if fields.get("paymentType") == "foreign":
        if not fields.get("binanceUid"):
            raise ApplicationError("A Binance UID is required for international payout.")
    elif not (fields.get("accountNumber") and fields.get("ifscCode") and fields.get("bankName")):
        raise ApplicationError("Bank account number, IFSC and bank name are required.")

    def _moment_of(r: dict) -> float:
        m = _moment(r.get("rejected_at") or r.get("updated_at") or r.get("created_at"))
        return m if m is not None else 0.0

    previous = max(rejected_subs, key=_moment_of)
    previous_id = str(previous.get("_id") or "")

    now = _now()
    doc = {
        **fields,
        "ownerEmail": email,
        "ownerPhone": fields.get("ownerPhone") or "",
        "kycDocUrls": kyc,
        "crmId": ops._generate_crm_id(),
        "type": "sub",
        "parentAgencyId": str(parent["_id"]),
        "status": "pending",
        "isActive": False,
        "kycStatus": "submitted",
        "currency": fields.get("currency") or ("USD" if fields.get("paymentType") == "foreign" else "INR"),
        "totalHosts": 0,
        "totalSubAgencies": 0,
        "source": SOURCE_REAPPLY,
        "ownerUid": uid,
        "crmUid": uid,
        # The application this one follows. The old record is not touched.
        "reapplicationOf": previous_id,
        "createdByUid": str(actor.get("uid") or ""),
        "createdAt": now,
        "updatedAt": now,
    }
    client = firebase.firestore_client()
    ref = client.collection(ops.FS_AGENCIES).document()
    await _fs(ref.set, doc)
    partner_id = ref.id

    why = (reason or "").strip() or (
        f"Fresh Sub-agency application after the rejection of {previous_id}, "
        f"filed under {parent['_id']}."
    )
    try:
        record, created, warnings = await ops.ensure_partner_record(
            partner_id, actor, why, PartnerKind.SUB_AGENCY,
        )
    except Exception:
        # Nothing half-made: the loser of a concurrent pair, or a refusal,
        # leaves no document behind.
        try:
            await _fs(ref.delete)
        except Exception:  # noqa: BLE001
            log.exception("Could not remove refused re-application agencies/%s", partner_id)
        raise

    # The login follows the NEW record (it still pointed at the rejected one).
    login_note = ""
    try:
        await crm.amirror(
            uid=uid,
            email=email,
            name=str(fields.get("ownerName") or fields.get("agencyName") or ""),
            role=partner_role_for("sub_agency"),
            created_by=str(actor.get("uid") or ""),
            phone=str(fields.get("ownerPhone") or ""),
            is_active=True,
            partner_id=partner_id,
            partner_status=str(PartnerStatus.PENDING),
        )
    except Exception:  # noqa: BLE001
        log.exception("crmUsers/%s was not re-pointed to re-application %s", uid, partner_id)
        login_note = (
            "The login could not be re-pointed at the new application; staff can repair "
            "it with Attach login. The application itself was filed."
        )

    await audit.record(
        actor=actor,
        action=REAPPLIED,
        subject_type="partner",
        subject_id=partner_id,
        reason=why,
        before=None,
        after={"kind": "sub_agency", "status": "pending", "owner_uid": uid,
               "parent_id": doc["parentAgencyId"]},
        meta={"reapplication_of": previous_id, "source": SOURCE_REAPPLY, "warnings": warnings},
    )
    notified = await notices.partner_submitted(uid, "sub_agency", partner_id)
    return {
        "id": partner_id,
        "kind": "sub_agency",
        "status": "pending",
        "reapplication_of": previous_id,
        "owner_uid": uid,
        "parent_id": doc["parentAgencyId"],
        "record_created": created,
        "warnings": list(warnings) + ([login_note] if login_note else []),
        "notified": notified,
    }


#: Decision 16 (RC): the audit action of a re-application.
REAPPLIED = "partner.reapplied"


async def applications_of(uid: str) -> list[dict[str, Any]]:
    """Every partner-role application this human has, newest first, with status.

    Used by the app's role screen ("your Agency application is pending") and
    by the CRM user page, which shows Review / Approve / Reject for pending
    ones instead of the direct-grant buttons that used to be there.
    """
    uid = str(uid or "").strip()
    out: list[dict[str, Any]] = []
    for row in await partner_roles.records_owned_by(uid, db=get_db()):
        out.append({
            "id": str(row["_id"]),
            "kind": str(row.get("kind") or ""),
            "status": str(row.get("status") or ""),
            "name": str(row.get("name") or ""),
            "parent_id": row.get("parent_id"),
            "created_at": row.get("created_at"),
            "rejection_reason": row.get("rejection_reason"),
            "revocation_reason": row.get("revocation_reason"),
        })

    from google.cloud.firestore_v1.base_query import FieldFilter

    # B34: the application a revoked Host joined on still says `approved` —
    # it was, and `restore_host` restores from it — but the ROLE is revoked,
    # and that is what the person's list has to say, with the reason.
    try:
        user = await _user_doc(uid)
    except Exception:  # noqa: BLE001 — the list still renders without it
        user = {}
    host_revoked = host_state(user) == "revoked"

    def _hosts():
        rows = []
        q = (
            firebase.firestore_client()
            .collection("hostApplications")
            .where(filter=FieldFilter("applicantUid", "==", uid))
        )
        for snap in q.stream():
            d = snap.to_dict() or {}
            status = str(d.get("status") or "")
            revoked_row = host_revoked and status == "approved"
            rows.append({
                "id": snap.id,
                "kind": "host",
                "status": "revoked" if revoked_row else status,
                "name": str(d.get("hostName") or ""),
                "parent_id": d.get("agencyId"),
                "created_at": d.get("createdAt"),
                "rejection_reason": d.get("rejectionReason"),
                "revocation_reason": (
                    str(user.get("hostRevokedReason") or "") if revoked_row else None
                ),
            })
        return rows

    try:
        out.extend(await _fs(_hosts))
    except Exception:  # noqa: BLE001
        log.exception("host applications for %s could not be read", uid)

    out.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return out
