"""The user-facing inbox: one writer for every Official message.

── WHAT THIS IS ────────────────────────────────────────────────────────────

The Android app's Messages → Official tab reads two things: `broadcasts`
(everybody) and the top-level `notifications` collection filtered on
`userId == auth.uid` (this person). This module writes the second. It is the
mechanism `warn_user` was given when warnings turned out to be reaching nobody,
generalised so that an approval, a rejection, a revocation or a recharge
outcome is delivered the same way, with the same guarantees, by the same code.

── THE THREE GUARANTEES ────────────────────────────────────────────────────

**Addressed on `userId`.** The deployed rule is

    match /notifications/{notifId} {
      allow read: if (request.auth != null
                      && resource.data.userId == request.auth.uid) || isAdmin();
    }

so `userId` is the only field that makes a message readable by its recipient.
It is a positional argument here and cannot be omitted.

**Idempotent.** The document id is the caller's `key`, never auto-generated.
An approval that is retried, a decide endpoint that is double-clicked, a
trigger that fires twice — all land on the same document and the person sees
one message. Choose keys that name the EVENT, not the moment:
`partner_approved_{partner_id}`, `recharge_rejected_{recharge_id}`.

**Best effort, and LAST.** Nothing here raises. The caller has already
committed the authoritative record — the partner status, the audit row, the
ledger movement — and a notice that cannot be written is a delivery problem,
not a reason to unwind a decision. Callers therefore invoke this after their
own writes and never inside a transaction they would want rolled back.

── WHAT A NOTICE CARRIES, AND WHAT IT NEVER DOES ───────────────────────────

`title`, `body`, a `type` the app can badge on, an optional `reason` (the
reviewer's words, which the CRM already tells reviewers may be shown), and
`meta` for small structured facts the app may want (a role, a status, an id).
It never carries the acting staff member's uid, name or role, the audit id, or
internal routing fields. Who decided is internal; the person is told WHAT was
decided and WHY.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from app.db import firebase

log = logging.getLogger(__name__)

#: The collection. `app.services.users.NOTIFICATIONS` points at this same name
#: and the comment there explains why it is `userId` and not `targetUid`.
NOTIFICATIONS = "notifications"


async def deliver(
    user_id: str,
    key: str,
    *,
    type: str,  # noqa: A002 — mirrors the document field
    title: str,
    body: str,
    reason: str = "",
    meta: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> bool:
    """Write (or overwrite) one Official message for `user_id`. Never raises.

    Returns True if the write succeeded, False if it did not — so a caller can
    report `notified: false` without the decision itself having failed.
    """
    uid = str(user_id or "").strip()
    doc_id = str(key or "").strip()
    if not uid or not doc_id:
        log.warning("notice not delivered: uid=%r key=%r", uid, doc_id)
        return False

    document: dict[str, Any] = {
        "userId": uid,
        "type": str(type),
        "title": str(title),
        "body": str(body),
        "isRead": False,
        "createdAt": now or datetime.now(timezone.utc),
    }
    if reason:
        document["reason"] = str(reason)
    if meta:
        # Only plain, small values. A notice is read on a phone and stored for
        # ever; it is not the place for a record dump.
        document["meta"] = {
            str(k): v for k, v in meta.items()
            if isinstance(v, (str, int, float, bool)) or v is None
        }

    try:
        await asyncio.to_thread(
            firebase.firestore_client()
            .collection(NOTIFICATIONS)
            .document(doc_id)
            .set,
            document,
        )
        return True
    except Exception:  # noqa: BLE001
        log.exception("notice %s for %s could not be delivered", doc_id, uid)
        return False


# ── Partner-role lifecycle ───────────────────────────────────────────────────
#
# One function per event rather than one generic one with a `status` argument,
# because the sentences are different and the person is reading them, not a
# parser. Every one of these names the role, says what happened, and — where
# there is one — says what to do next.

_ROLE_LABEL = {
    "agency": "Agency",
    "sub_agency": "Sub-agency",
    "seller": "Coin Seller",
    "host": "Host",
}


def role_label(kind: str) -> str:
    return _ROLE_LABEL.get(str(kind or "").strip(), str(kind or "partner").title())


async def partner_submitted(uid: str, kind: str, partner_id: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_submitted_{partner_id}",
        type="partner_submitted",
        title=f"{label} application received",
        body=(
            f"Your {label} application has been submitted and is with a "
            "reviewer. You will be told here when a decision is made."
        ),
        meta={"role": str(kind), "partnerId": partner_id, "status": "pending"},
    )


async def partner_approved(uid: str, kind: str, partner_id: str, next_step: str = "") -> bool:
    label = role_label(kind)
    body = f"Your {label} application has been approved."
    if next_step:
        body += f" {next_step}"
    return await deliver(
        uid, f"partner_approved_{partner_id}",
        type="partner_approved",
        title=f"{label} application approved",
        body=body,
        meta={"role": str(kind), "partnerId": partner_id, "status": "approved"},
    )


async def partner_awaiting_verification(
    uid: str, kind: str, partner_id: str, missing: list[str]
) -> bool:
    """Decision 15 (RC): approved, not started — what is still to verify."""
    label = role_label(kind)
    what = " and ".join({"phone": "your phone number", "email": "your email address"}.get(m, m) for m in missing)
    return await deliver(
        uid, f"partner_awaiting_verification_{partner_id}",
        type="partner_awaiting_verification",
        title=f"{label} approved — verify to start",
        body=(
            f"Your {label} application has been approved. Your role starts as soon as "
            f"{what or 'your contacts'} {'is' if len(missing) == 1 else 'are'} verified on your account."
        ),
        meta={"role": str(kind), "partnerId": partner_id, "status": "awaiting_verification",
              "missing": list(missing)},
    )


async def partner_held_for_verification(
    uid: str, kind: str, partner_id: str, missing: list[str]
) -> bool:
    """D17: an ACTIVE legacy role paused until both contacts are verified."""
    label = role_label(kind)
    what = " and ".join({"phone": "your phone number", "email": "your email address"}.get(m, m) for m in missing)
    return await deliver(
        uid, f"partner_held_for_verification_{partner_id}",
        type="partner_awaiting_verification",
        title=f"Verify to keep using your {label} role",
        body=(
            f"Your {label} role is paused until {what or 'your contacts'} "
            f"{'is' if len(missing) == 1 else 'are'} verified on your account. "
            "It starts again by itself as soon as both are verified."
        ),
        meta={"role": str(kind), "partnerId": partner_id, "status": "awaiting_verification",
              "missing": list(missing), "held": True},
    )


async def partner_rejected(uid: str, kind: str, partner_id: str, reason: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_rejected_{partner_id}",
        type="partner_rejected",
        title=f"{label} application not approved",
        body=(
            f"Your {label} application was not approved."
            + (f" Reason: {reason}" if reason else "")
            + " You may apply again once the reason has been addressed."
        ),
        reason=reason,
        meta={"role": str(kind), "partnerId": partner_id, "status": "rejected"},
    )


async def partner_suspended(uid: str, kind: str, partner_id: str, reason: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_suspended_{partner_id}",
        type="partner_suspended",
        title=f"{label} role suspended",
        body=(
            f"Your {label} role has been suspended."
            + (f" Reason: {reason}" if reason else "")
            + " Your account and your other roles are not affected."
        ),
        reason=reason,
        meta={"role": str(kind), "partnerId": partner_id, "status": "suspended"},
    )


async def partner_reactivated(uid: str, kind: str, partner_id: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_reactivated_{partner_id}",
        type="partner_reactivated",
        title=f"{label} role reactivated",
        body=f"Your {label} role is active again.",
        meta={"role": str(kind), "partnerId": partner_id, "status": "approved"},
    )


async def partner_revoked(uid: str, kind: str, partner_id: str, reason: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_revoked_{partner_id}",
        type="partner_revoked",
        title=f"{label} role revoked",
        body=(
            f"Your {label} role has been revoked."
            + (f" Reason: {reason}" if reason else "")
            + " Your account and your other roles remain active. Your history "
            "is kept. If you believe this was a mistake, you can request "
            "reinstatement from the app."
        ),
        reason=reason,
        meta={"role": str(kind), "partnerId": partner_id, "status": "revoked"},
    )


# ── Reinstatement of a revoked role (C2) ─────────────────────────────────────

async def role_appeal_restored(uid: str, kind: str, appeal_id: str, record_id: str) -> bool:
    """The Owner granted a reinstatement request: the SAME role is back."""
    label = role_label(kind)
    return await deliver(
        uid, f"role_appeal_restored_{appeal_id}",
        type="role_appeal_restored",
        title=f"{label} role reinstated",
        body=(
            f"Your request was accepted and your {label} role is active again, "
            "with your existing records and history."
        ),
        meta={"role": str(kind), "appealId": appeal_id, "recordId": record_id,
              "status": "restored"},
    )


async def role_appeal_kept_revoked(uid: str, kind: str, appeal_id: str, reason: str) -> bool:
    """The Owner refused a reinstatement request. The reason is the answer."""
    label = role_label(kind)
    return await deliver(
        uid, f"role_appeal_kept_revoked_{appeal_id}",
        type="role_appeal_kept_revoked",
        title=f"{label} role stays revoked",
        body=(
            f"Your request to reinstate your {label} role was reviewed and the "
            "role stays revoked."
            + (f" Reason: {reason}" if reason else "")
        ),
        reason=reason,
        meta={"role": str(kind), "appealId": appeal_id, "status": "kept_revoked"},
    )


async def partner_transferred(
    uid: str, kind: str, partner_id: str, from_name: str, to_name: str
) -> bool:
    """A host or sub-agency told their parent changed because the old one was revoked."""
    label = role_label(kind)
    return await deliver(
        uid, f"partner_transferred_{partner_id}_{uid}",
        type="partner_transferred",
        title="Your agency has changed",
        body=(
            f"Your {label} relationship has been moved from {from_name or 'your previous agency'} "
            f"to {to_name}. Your earnings history is unchanged."
        ),
        meta={"role": str(kind), "partnerId": partner_id},
    )


async def transfer_agency_notice(
    agency_owner_uid: str, request_id: str, *, side: str, kind: str, subject_name: str,
    from_name: str, to_name: str,
) -> bool:
    """§6 Transfers — "notify source/target/affected": the SOURCE or TARGET agency's
    owner is told that a transfer the Owner approved moved somebody out of, or
    into, their agency. Keyed on the request and the side, so one decision is
    one message per agency."""
    label = role_label(kind)
    if side == "source":
        title = f"A {label} has moved out of your agency"
        body = (
            f"{subject_name or 'A ' + label} has been transferred from {from_name or 'your agency'} "
            f"to {to_name}. Earnings already recorded under your agency are unchanged."
        )
    else:
        title = f"A {label} has joined your agency by transfer"
        body = (
            f"{subject_name or 'A ' + label} has been transferred to {to_name or 'your agency'} "
            f"from {from_name or 'their previous agency'}. Earnings from now on are recorded under your agency."
        )
    return await deliver(
        agency_owner_uid, f"transfer_{request_id}_{side}",
        type=f"transfer_{side}",
        title=title,
        body=body,
        meta={"role": str(kind), "transferId": request_id, "side": side},
    )


# ── Department vacancy (§9) ─────────────────────────────────────────────────

async def department_vacancy(owner_uid: str, team: str, team_label: str, *, opened: bool,
                             since_epoch: int) -> bool:
    """§9 — ONE notice per Owner per vacancy: "<Department> has no Admin"
    (members report to the Owner until a replacement is appointed), and its
    closing. Keyed on the vacancy's opening moment, so a retried deactivation
    delivers once and a later vacancy is a new message."""
    # The key names the recipient too: one document per Owner per vacancy, or
    # the second Owner's notice would overwrite the first's.
    if opened:
        return await deliver(
            owner_uid, f"department_vacancy_{team}_{since_epoch}_{owner_uid}",
            type="department_vacancy",
            title=f"{team_label} has no Admin",
            body=(
                f"{team_label} has no active department Admin. Its members report to the "
                "Owner until a replacement Admin is appointed."
            ),
            meta={"team": team, "vacancy": True},
        )
    return await deliver(
        owner_uid, f"department_vacancy_closed_{team}_{since_epoch}_{owner_uid}",
        type="department_vacancy_closed",
        title=f"{team_label} has an Admin again",
        body=f"A department Admin is in place for {team_label}. Its members report to that Admin again.",
        meta={"team": team, "vacancy": False},
    )


# ── Host ────────────────────────────────────────────────────────────────────

async def host_application_submitted(uid: str, application_id: str) -> bool:
    return await deliver(
        uid, f"host_submitted_{application_id}",
        type="host_submitted",
        title="Host application received",
        body="Your Host application has been submitted and is with a reviewer.",
        meta={"role": "host", "applicationId": application_id, "status": "pending"},
    )


async def host_application_approved(uid: str, application_id: str) -> bool:
    return await deliver(
        uid, f"host_approved_{application_id}",
        type="host_approved",
        title="Host application approved",
        body=(
            "Your Host application has been approved. Complete your profile "
            "and facial verification to become a verified Host."
        ),
        meta={"role": "host", "applicationId": application_id, "status": "approved",
              "nextAction": "face_verification"},
    )


async def host_application_rejected(uid: str, application_id: str, reason: str) -> bool:
    return await deliver(
        uid, f"host_rejected_{application_id}",
        type="host_rejected",
        title="Host application not approved",
        body=(
            "Your Host application was not approved."
            + (f" Reason: {reason}" if reason else "")
        ),
        reason=reason,
        meta={"role": "host", "applicationId": application_id, "status": "rejected"},
    )


async def host_revoked(uid: str, reason: str) -> bool:
    return await deliver(
        uid, f"host_revoked_{uid}_{int(datetime.now(timezone.utc).timestamp())}",
        type="host_revoked",
        title="Host role revoked",
        body=(
            "Your Host role has been revoked."
            + (f" Reason: {reason}" if reason else "")
            + " Your account and your earnings history are not affected."
        ),
        reason=reason,
        meta={"role": "host", "status": "revoked"},
    )


async def agency_host_revoked(
    agency_owner_uid: str, agency_id: str, host_uid: str, host_name: str, reason: str,
    *, change: str = "revoked",
) -> bool:
    """§5 Revoke Host — "notify host and agency": the agency's owner is told.

    Keyed on the host and the moment, like `host_revoked`, so a later
    revoke-then-restore-then-revoke is a second message.
    """
    who = host_name or host_uid
    return await deliver(
        agency_owner_uid,
        f"agency_host_{change}_{agency_id}_{host_uid}_{int(datetime.now(timezone.utc).timestamp())}",
        type=f"agency_host_{change}",
        title=f"A Host on your roster was {change}",
        body=(
            f"{who}'s Host role has been {change}."
            + (f" Reason: {reason}" if reason else "")
            + " Their earnings history under your agency is unchanged."
        ),
        reason=reason,
        meta={"role": "host", "agencyId": agency_id, "hostUid": host_uid, "status": change},
    )


async def host_restored(uid: str, application_id: str, revoked_at_epoch: int) -> bool:
    """UGP-B: the Host role re-activated from the person's existing records.

    Keyed on the revocation it reverses, so a retried restore is one message and
    a later revoke-then-restore is a second, distinct one.
    """
    return await deliver(
        uid, f"host_restored_{uid}_{revoked_at_epoch}",
        type="host_restored",
        title="Host role restored",
        body=(
            "Your Host role is active again, under the same agency and with your "
            "earnings history unchanged."
        ),
        meta={"role": "host", "applicationId": application_id, "status": "approved"},
    )


async def host_verification_required(uid: str) -> bool:
    return await deliver(
        uid, f"host_verification_required_{uid}",
        type="host_verification_required",
        title="Facial verification required",
        body="Complete facial verification in your profile to become a verified Host.",
        meta={"role": "host", "nextAction": "face_verification"},
    )


async def host_verification_decided(uid: str, approved: bool, reason: str = "") -> bool:
    if approved:
        return await deliver(
            uid, f"host_verification_approved_{uid}",
            type="host_verification_approved",
            title="You are a verified Host",
            body="Your facial verification has been approved.",
            meta={"role": "host", "status": "verified"},
        )
    return await deliver(
        uid, f"host_verification_rejected_{uid}",
        type="host_verification_rejected",
        title="Facial verification not approved",
        body=(
            "Your facial verification was not approved."
            + (f" Reason: {reason}" if reason else "")
            + " You can try again from your profile."
        ),
        reason=reason,
        meta={"role": "host", "status": "verification_rejected",
              "nextAction": "face_verification"},
    )


# ── Recharge ────────────────────────────────────────────────────────────────

async def recharge_event(
    uid: str, recharge_id: str, event: str, *, diamonds: int, reason: str = "",
    seller_name: str = "", for_seller: bool = False,
) -> bool:
    """One of submitted | approved | rejected | refund_requested | refunded | reversed | refund_rejected."""
    who = "seller" if for_seller else "buyer"
    titles = {
        "submitted": ("Recharge request received", "Recharge request from a buyer"),
        "approved": ("Recharge approved", "Recharge approved"),
        "rejected": ("Recharge not approved", "Recharge not approved"),
        "refund_requested": ("Refund under review", "Refund under review"),
        "refunded": ("Recharge refunded", "Recharge refunded"),
        "reversed": ("Recharge partly reversed", "Recharge partly reversed"),
        "refund_rejected": ("Refund not approved", "Refund not approved"),
    }
    title_pair = titles.get(event, (event.replace("_", " ").title(),) * 2)
    title = title_pair[1] if for_seller else title_pair[0]
    via = f" via {seller_name}" if seller_name and not for_seller else ""
    bodies = {
        "submitted": (
            f"Your request for {diamonds} diamonds{via} has been received and is "
            "being verified by Zipper. Diamonds are credited once the payment is confirmed.",
            f"A buyer has submitted a recharge of {diamonds} diamonds through you. "
            "Zipper will verify the payment.",
        ),
        "approved": (
            f"Your payment has been verified and {diamonds} diamonds have been credited.",
            f"A recharge of {diamonds} diamonds through you has been verified and credited.",
        ),
        "rejected": (
            f"Your recharge request for {diamonds} diamonds was not approved."
            + (f" Reason: {reason}" if reason else ""),
            f"A recharge of {diamonds} diamonds through you was not approved."
            + (f" Reason: {reason}" if reason else ""),
        ),
        "refund_requested": (
            f"A refund of your {diamonds}-diamond recharge is under review.",
            f"A refund of a {diamonds}-diamond recharge through you is under review.",
        ),
        "refunded": (
            f"Your {diamonds}-diamond recharge has been refunded and the diamonds reversed."
            + (f" {reason}" if reason else ""),
            f"A {diamonds}-diamond recharge through you has been refunded.",
        ),
        "reversed": (
            f"Your recharge has been partly reversed: {diamonds} diamonds were still "
            "available and have been taken back."
            + (f" {reason}" if reason else ""),
            f"A recharge through you has been partly reversed ({diamonds} diamonds).",
        ),
        "refund_rejected": (
            "The refund request on your recharge was not approved."
            + (f" Reason: {reason}" if reason else ""),
            "A refund request on a recharge through you was not approved.",
        ),
    }
    pair = bodies.get(event, ("", ""))
    body = pair[1] if for_seller else pair[0]
    return await deliver(
        uid, f"recharge_{event}_{recharge_id}_{who}",
        type=f"recharge_{event}",
        title=title,
        body=body,
        reason=reason,
        meta={"rechargeId": recharge_id, "diamonds": int(diamonds), "status": event},
    )
