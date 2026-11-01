"""What one person holds, and which ROLE actions staff may take on it (UGP-B).

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

The CRM user page offered "Revoke host" and "Remove seller" to every ordinary
account — a guest with no role at all included — because it read no role
record before rendering. The rule it must follow:

  * determine the roles and their individual statuses before rendering;
  * no role → no role action;
  * ONE active role → Suspend the account only, no separate revoke;
  * SEVERAL roles → revoke one specific role, the others untouched;
  * restoring re-activates the existing record, never a duplicate.

This module is the single answer to "what does this person hold", read from the
authoritative records only — Mongo `partners` by `owner_crm_uid` for Agency,
Sub-agency and Coin Seller, `users/{uid}.isHost` plus `hostApplications` for
Host — and it decides the allowed role actions from that answer. The CRM renders
from it, and `revoke_host` / `revoke_partner` apply the same count on the server,
so the rule holds whatever a client sends.

Pure where it can be (`count_held`, `allowed_role_actions`,
`deduction_currencies`), so the matrix is unit-testable.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.db import firebase
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)

#: A partner record in one of these statuses is a role the person HOLDS for the
#: purpose of the one-role rule. Pending is an application, not a role; rejected
#: and revoked are history.
HELD_PARTNER_STATUSES = frozenset({"approved", "suspended"})

#: The same for the Host role. A SUSPENDED Host still holds the role (§5: the
#: slot and the record are kept while it is paused), exactly as a suspended
#: partner record does.
HELD_HOST_STATUSES = frozenset({"active", "suspended"})


def host_role_suspended(user: dict | None) -> bool:
    """Is this account's Host role paused (§5 partner role suspension)? Pure.

    The flag `users.suspend_host` writes and every gate reads — the Functions
    (`hostEligibility.hostRoleSuspension`) and `firestore.rules` (`mayGoLive`)
    ask the same strict question. `is True`, never truthiness: a stray string
    must not pause anybody's role.
    """
    return bool(user) and (user or {}).get("hostSuspended") is True


def _iso_or_none(value: Any) -> str | None:
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return str(isoformat())
        except Exception:  # noqa: BLE001 — a shape we do not recognise
            return None
    return None

#: The CRM's words for a role, keyed by the kind each record carries.
ROLE_LABELS = {
    "host": "Host",
    "agency": "Agency",
    "sub_agency": "Sub-agency",
    "seller": "Coin Seller",
}

#: OWNER_DECISION_PENDING (spec §5, B2): the master specification defines
#: partner role revocation as "permanent removal of one partner capability",
#: with no exception for a person who holds exactly one. The accepted flow
#: (UGP-B, below and in `users.revoke_host` / `partner_ops.
#: _refuse_single_role_revocation`) refuses to revoke a person's ONLY role and
#: points at an account suspension instead. Kept as the accepted flow; lifting
#: it is the Owner's call, and a one-line change at each of the two guards.
SINGLE_ROLE_REFUSAL = (
    "{label} is this person's only active role. A single role is not revoked "
    "on its own — suspend the account instead."
)


def count_held(roles: list[dict[str, Any]]) -> int:
    """How many roles the person actively holds (pure)."""
    n = 0
    for r in roles:
        if r.get("role") == "host":
            n += 1 if r.get("status") in HELD_HOST_STATUSES else 0
        elif str(r.get("status") or "") in HELD_PARTNER_STATUSES:
            n += 1
    return n


def _held(r: dict[str, Any]) -> bool:
    if r.get("role") == "host":
        return r.get("status") in HELD_HOST_STATUSES
    return str(r.get("status") or "") in HELD_PARTNER_STATUSES


def allowed_role_actions(roles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each role with the actions the CRM may offer on it (pure).

    `revoke` only when two or more roles are held and this one is held.
    `restore` for a partner record that is suspended or revoked, and for a
    revoked Host that has an approved application to restore from — the server
    re-checks everything when it is pressed. `resume` for a SUSPENDED Host
    (`POST /users/{uid}/resume-host`): the same record, lifted — never offered
    on a revoked one, which only comes back through reinstatement.
    """
    held = count_held(roles)
    out: list[dict[str, Any]] = []
    for r in roles:
        actions: list[str] = []
        if _held(r) and held >= 2:
            actions.append("revoke")
        if r.get("role") == "host":
            if r.get("status") == "revoked" and r.get("restorable"):
                actions.append("restore")
            elif r.get("status") == "suspended":
                actions.append("resume")
        elif str(r.get("status") or "") in ("suspended", "revoked"):
            actions.append("restore")
        out.append({**r, "actions": actions})
    return out


def deduction_currencies(roles: list[dict[str, Any]]) -> list[str]:
    """Which currency a warning deduction may take (pure) — brief D.

    Beans for a Host; diamonds for a User, Agency, Sub-agency or Coin Seller.
    A Host who ALSO holds a diamond role is offered both and staff choose (the
    open question is FLOW-MAP D6). Everyone else — including a person with no
    role — is a User, so diamonds.
    """
    host = any(r.get("role") == "host" and r.get("status") in HELD_HOST_STATUSES for r in roles)
    other = any(r.get("role") != "host" and _held(r) for r in roles)
    if host and other:
        return ["beans", "diamonds"]
    if host:
        return ["beans"]
    return ["diamonds"]


async def _fs(fn, *a, **kw):
    return await asyncio.to_thread(fn, *a, **kw)


def _host_applications_for(uid: str) -> list[dict[str, Any]]:
    """Every host application naming this person, by either link field."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    col = firebase.firestore_client().collection("hostApplications")
    seen: dict[str, dict[str, Any]] = {}
    for field in ("applicantUid", "activatedByUid"):
        try:
            for snap in col.where(filter=FieldFilter(field, "==", uid)).stream():
                d = snap.to_dict() or {}
                d["id"] = snap.id
                seen[snap.id] = d
        except Exception:  # noqa: BLE001 — a missing index must not blank the page
            log.exception("host applications by %s could not be read", field)
    return list(seen.values())


def latest_application(apps: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The most recently decided of these applications (pure).

    A person can have been approved more than once over the years; the roles
    view and `users.restore_host` must agree on which one is "the" application.
    """
    def _when(a: dict[str, Any]) -> float:
        for key in ("decidedAt", "activatedAt", "createdAt", "submittedAt"):
            v = a.get(key)
            ts = getattr(v, "timestamp", None)
            if callable(ts):
                try:
                    return float(ts())
                except Exception:  # noqa: BLE001 — try the next field
                    continue
        return 0.0

    return max(apps, key=_when) if apps else None


async def _partner_live(partner_id: str, *, db=None) -> bool:
    if not partner_id:
        return False
    row = await (db if db is not None else get_db())[C.PARTNERS].find_one({"_id": partner_id})
    return bool(row) and row.get("status") == "approved" and bool(row.get("is_active", True))


async def role_inventory(uid: str, *, user: dict | None = None, db=None) -> dict[str, Any]:
    """Every role record this person has, with status — authoritative sources only.

    `user` may be passed by a caller that has already read `users/{uid}`, and
    `db` by a caller that holds the Mongo handle it works against (the service
    modules each own theirs).
    """
    uid = str(uid or "").strip()
    db = db if db is not None else get_db()
    roles: list[dict[str, Any]] = []

    async for row in db[C.PARTNERS].find({"owner_crm_uid": uid}):
        kind = str(row.get("kind") or "")
        if kind not in ("agency", "sub_agency", "seller"):
            continue
        roles.append({
            "role": kind,
            "label": ROLE_LABELS.get(kind, kind),
            "id": str(row["_id"]),
            "name": str(row.get("name") or ""),
            "status": str(row.get("status") or ""),
            "is_active": bool(row.get("is_active", False)),
            "parent_id": row.get("parent_id"),
        })

    if user is None:
        snap = await _fs(firebase.firestore_client().collection("users").document(uid).get)
        user = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}

    apps = await _fs(_host_applications_for, uid)
    approved_apps = [a for a in apps if str(a.get("status") or "") == "approved"]
    # Latest first, so `[0]` below is the application `restore_host` would use.
    latest = latest_application(approved_apps)
    if latest is not None:
        approved_apps = [latest] + [a for a in approved_apps if a is not latest]
    pending_apps = [a for a in apps if str(a.get("status") or "") == "pending"]
    agency_id = str(user.get("agencyId") or "").strip()

    if user.get("isHost"):
        # §5: a suspended Host is still a Host — same record, same agency, same
        # verification — reported with its own status, term and reason.
        suspended = host_role_suspended(user)
        roles.append({
            "role": "host", "label": "Host", "status": "suspended" if suspended else "active",
            "verified": bool(user.get("isVerifiedHost")), "agency_id": agency_id,
            "application_id": (approved_apps[0]["id"] if approved_apps else ""),
            **({"suspended_until": _iso_or_none(user.get("hostSuspendedUntil")),
                "suspension_reason": str(user.get("hostSuspendedReason") or "")} if suspended else {}),
        })
    elif user.get("hostRevokedAt") or user.get("hostRemovedAt"):
        restore_agency = agency_id or str((approved_apps[0] if approved_apps else {}).get("agencyId") or "")
        # UGP review: a person who has APPLIED AGAIN since the revocation is
        # decided on that application (/kyc), not restored from the old one —
        # `restore_host` refuses while it is pending, so Restore is not offered.
        restorable = (bool(approved_apps) and not pending_apps
                      and await _partner_live(restore_agency, db=db))
        roles.append({
            "role": "host", "label": "Host", "status": "revoked",
            "verified": bool(user.get("isVerifiedHost")), "agency_id": restore_agency,
            "application_id": (approved_apps[0]["id"] if approved_apps else ""),
            "restorable": restorable,
            **({"pending_application_id": pending_apps[0]["id"]} if pending_apps else {}),
        })
    elif pending_apps:
        roles.append({
            "role": "host", "label": "Host", "status": "pending",
            "agency_id": str(pending_apps[0].get("agencyId") or ""),
            "application_id": pending_apps[0]["id"],
        })

    return {"uid": uid, "roles": roles, "held_count": count_held(roles)}


async def held_count(uid: str, *, db=None) -> int:
    """The one-role rule's input, for the server-side guards."""
    if not str(uid or "").strip():
        return 0
    return (await role_inventory(uid, db=db))["held_count"]


async def roles_for_crm(uid: str) -> dict[str, Any]:
    """The answer `GET /users/{uid}/roles` returns: inventory + allowed actions.

    `verified_contact` mirrors the backend guest rule (`is_unverified_guest`) so
    the page can say why a person has no partner options.
    """
    from app.services import partner_applications as apps  # local: avoids an import cycle

    inv = await role_inventory(uid)
    try:
        guest = await asyncio.to_thread(apps.is_unverified_guest, uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        guest = True
    return {
        "uid": inv["uid"],
        "held_count": inv["held_count"],
        "roles": allowed_role_actions(inv["roles"]),
        "deduction_currencies": deduction_currencies(inv["roles"]),
        "verified_contact": not guest,
    }
