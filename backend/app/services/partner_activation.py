"""Decision 15 (RC) — "my role is approved; I have verified; start it".

One place for the person-facing side of the both-contacts rule, so the CRM
(a partner's own session) and the app (through the Cloud Function callables,
with the partner-registration service key) ask exactly the same thing:

  * `overview(uid)` — what is verified on this login, what is missing, and
    which approved roles are waiting for it;
  * `check_and_activate(uid, actor)` — re-read the verification from the
    authoritative sources, note an SMS-linked phone in the ledger, and start
    every waiting role whose contacts are now both verified;
  * `report_conflict(uid, contact, value, actor)` — the phone or email this
    person tried to verify belongs to ANOTHER ZIPPER account: activation
    stays blocked (Firebase keeps a contact on one account only), staff are
    alerted, and nothing is merged (open decision D3).

Nothing here starts a role on the caller's word. `partner_ops.
activate_partner_if_verified` and `users.activate_host_if_verified` both
re-read the verification and re-check the role table, the restriction and
the parent, exactly as at an approval.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from app.core import audit
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import contact_verification
from app.services.partners import PartnerStatus

log = logging.getLogger(__name__)

#: Audit action for a reported contact conflict.
CONTACT_CONFLICT = "contact.conflict_reported"

#: The actor that STARTS an Owner-approved role once both contacts are
#: verified. Deliberately not the person: they did not grant themselves
#: anything — the Owner approved, and the system started the role when the
#: precondition held. (A person acting on their own account is also refused
#: by `users.ensure_ordinary_target`, which would stop a Host role starting.)
ACTIVATION_ACTOR_UID = "system:contact-verification"
ACTIVATION_ACTOR_NAME = "Contact verification"


def activation_actor(account_uid: str, via: dict | None = None) -> dict:
    """The system actor for a start triggered by (or on behalf of) `account_uid`."""
    return {
        "uid": ACTIVATION_ACTOR_UID,
        "name": ACTIVATION_ACTOR_NAME,
        "role": "system",
        "team": None,
        # Not persisted by `audit._entry` (it keeps uid/name/role/team); the
        # trigger is written into each entry's reason/meta below instead.
        "triggered_by": str(account_uid or ""),
        "via": str((via or {}).get("uid") or ""),
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _awaiting_partners(uid: str) -> list[dict]:
    rows = []
    async for row in get_db()[C.PARTNERS].find(
        {"owner_crm_uid": uid, "status": str(PartnerStatus.AWAITING_VERIFICATION)}
    ):
        rows.append({"id": str(row.get("_id") or ""), "kind": str(row.get("kind") or ""),
                     "name": str(row.get("name") or "")})
    return rows


def _awaiting_host_applications(uid: str) -> list[dict]:
    """Blocking — this person's Host applications approved and waiting for contacts."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    out = []
    try:
        q = (
            firebase.firestore_client().collection("hostApplications")
            .where(filter=FieldFilter("applicantUid", "==", uid))
            .where(filter=FieldFilter("status", "==", "awaiting_verification"))
        )
        for snap in q.stream():
            d = snap.to_dict() or {}
            out.append({"id": snap.id, "kind": "host", "agency_id": str(d.get("agencyId") or "")})
    except Exception:  # noqa: BLE001 — the overview says what it could read
        log.warning("awaiting host applications of %s could not be read", uid)
    return out


async def overview(uid: str) -> dict[str, Any]:
    """What is verified, what is missing, and which approved roles wait for it."""
    uid = str(uid or "").strip()
    v = await asyncio.to_thread(contact_verification.status, uid)
    waiting = await _awaiting_partners(uid) + await asyncio.to_thread(_awaiting_host_applications, uid)
    return {"verification": v.public(), "waiting": waiting, "requirement": "both"}


async def check_and_activate(uid: str, actor: dict) -> dict[str, Any]:
    """Re-read the verification; start every waiting role it now allows.

    `actor` should be `activation_actor(uid, …)`: the system starts the role,
    on the account holder's request, because the Owner approved it and both
    contacts are now verified.
    """
    from app.services import partner_ops  # local: partner_ops imports this module's peers
    from app.services import users as users_svc

    uid = str(uid or "").strip()
    v = await asyncio.to_thread(contact_verification.status, uid)
    if v.phone_verified:
        await asyncio.to_thread(contact_verification.record_phone, uid, v.phone)
    started: list[dict] = []
    if v.complete and not v.no_account:
        for r in await partner_ops.activate_for_login(uid, actor):
            started.append({"id": r.get("id") or r.get("_id"), "kind": r.get("kind"),
                            "activated": bool(r.get("activated")),
                            **({"refusal": r["refusal"]} if r.get("refusal") else {})})
        for r in await users_svc.activate_host_if_verified(uid, actor):
            # HT-2: `recorded: false` (the role started, the application is not
            # yet recorded as approved — the next check finishes it), `busy`,
            # `conflict` and their sentence reach the caller instead of being
            # dropped here.
            started.append({"id": r.get("application_id"), "kind": "host",
                            "activated": bool(r.get("activated")),
                            **({"refusal": r["refusal"]} if r.get("refusal") else {}),
                            **{k: r[k] for k in ("recorded", "pending_completion", "busy", "conflict", "detail")
                               if k in r}})
    out = await overview(uid)
    out["started"] = started
    return out


async def report_conflict(uid: str, contact: str, value: str, actor: dict) -> dict[str, Any]:
    """The contact this person tried to bind is held by another account. Alert; merge nothing."""
    uid = str(uid or "").strip()
    contact = "phone" if str(contact) == "phone" else "email"
    holder = await asyncio.to_thread(
        contact_verification.conflict_holder, uid,
        phone=value if contact == "phone" else "", email=value if contact == "email" else "",
    )
    if not holder:
        return {"conflict": False}
    masked = (contact_verification.mask_phone(value) if contact == "phone"
              else contact_verification.mask_email(value))
    await audit.record(
        actor=actor,
        action=CONTACT_CONFLICT,
        subject_type="user",
        subject_id=uid,
        reason=(f"Tried to verify a {contact} ({masked}) that belongs to another ZIPPER account. "
                "The partner role stays inactive; nothing was merged."),
        before=None,
        after={"contact": contact, "other_account": holder},
        meta={"contact": contact, "masked": masked,
              "triggered_by": str(actor.get("triggered_by") or uid),
              "via": str(actor.get("via") or "")},
    )
    try:
        from app.services import role_appeals  # reuses the Owner email used for staff alerts

        await role_appeals.email_owners(
            kind="contact.conflict",
            subject="A partner's contact belongs to another ZIPPER account",
            title="Contact conflict — partner activation blocked",
            rows=[("Account", uid), ("Contact", f"{contact} {masked}"), ("Held by", holder)],
            dedupe_key=f"contact.conflict:{uid}:{contact}",
        )
    except Exception:  # noqa: BLE001 — the audit row is the record; email is a courtesy
        log.warning("owner alert for a contact conflict on %s was not sent", uid)
    return {"conflict": True, "contact": contact, "masked": masked}
