"""The user-facing inbox: ONE writer for every Official message — spec §12.

── WHAT THIS IS ────────────────────────────────────────────────────────────

The Android app's Messages → Official tab reads two things: `broadcasts`
(everybody) and the top-level `notifications` collection filtered on
`userId == auth.uid` (this person). This module writes the second, and — the
§12 extension — it owns the EMAIL that accompanies a notice as well, so one
event produces one in-app document and one recorded, retryable email from the
same safe wording, through the same function, with the same guarantees.

── THE CONTRACT (spec §12) ─────────────────────────────────────────────────

Every notice document carries:

    userId      the canonical Firebase uid — the ONLY field that makes the
                document readable by its recipient under the deployed rule
                `resource.data.userId == request.auth.uid`;
    eventKey    the deterministic key the caller chose (also the document id);
    type        what the app badges on (`warning`, `partner_approved`, …);
    title, body the safe message — no code, no secret, no other person's
                contact details, never the acting staff member;
    reason      the reviewer's words, when there are any (optional);
    relatedId   the record the event is about (a partner id, a card id, …);
    createdAt   when it was first written;
    read / isRead
                both written, both False at birth — the app reads either
                during the transition from `isRead` to `read`;
    delivery    `{"inApp": bool, "email": sent | pending | failed | skipped,
                  "emailError": "", "updatedAt": …}` (+ `emailVia` when
                another sender owns the email for this event).

**Idempotent on `eventKey`.** The document id is the key, never auto-generated,
so a retried approval, a double-clicked decide, a trigger that fires twice all
land on ONE document — and a repeat never resets `read`: an existing document
is left as the person left it, only its delivery state is updated.

**Retryable.** The email leg goes through `email.send_template`, which
records a row in `email_deliveries` before the provider is called and keeps
the recipe (template + safe params) on the row. A provider failure leaves the
row `failed` with the recipe, the notice says `email: pending`, and the
transactional sweep (`email.retry_failed`) sends it again — then updates the
notice through `mark_email_state`. An in-app write that fails is parked in
Mongo (`notice_outbox`, keyed on the eventKey) and written by the same sweep
(`retry_parked`). Neither failure ever reaches the business action.

**One email per event.** Where another sender already owns an event's email
(the Functions partner triggers; the 8A.2 record-driven sweep), the notice
carries none and says so in `delivery.emailVia` — see `EMAIL_VIA_*`.

**Best effort, and LAST.** Nothing here raises. The caller has already
committed the authoritative record — the partner status, the audit row, the
ledger movement — and a notice that cannot be written is a delivery problem,
not a reason to unwind a decision. Callers invoke this after their own writes
and never inside a transaction they would want rolled back.

── WHO IS TOLD ─────────────────────────────────────────────────────────────

The person, and the business parties the event touches: an agency for its
host, both agencies on a transfer, the other Owners on a money action or a
department vacancy. `notify_owners` is the fan-out for the Owners: one
document per Owner per event (`{key}:{uid}`), one email each.

Where the address comes from — never from the notice itself:

  * an app user: the Firebase Auth record, and only when that address is
    VERIFIED (`app_user_recipient`). An unverified address is not written
    to; the email leg is `skipped`, which is not a failure;
  * a partner (agency, sub-agency, seller): the partner's own Firestore
    document, `ownerEmail` (`notify.partner_recipient`). A partner with no
    address is a gap in the record and is recorded as `no_address`;
  * staff and Owners: the staff record (`notify.staff_with_roles`).
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from app.config import settings
from app.db import firebase
from app.services import email as mail

log = logging.getLogger(__name__)

#: The collection. `app.services.users.NOTIFICATIONS` points at this same name
#: and the comment there explains why it is `userId` and not `targetUid`.
NOTIFICATIONS = "notifications"

#: The four email states a notice may carry (spec §12).
EMAIL_SENT = "sent"
EMAIL_PENDING = "pending"
EMAIL_FAILED = "failed"
EMAIL_SKIPPED = "skipped"

_EMAIL_ADDRESS = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def safe_text(value: Any) -> str:
    """A title, body or reason made safe for a document the person reads.

    Only one thing is masked: an email address, which in a reviewer's free
    text is almost always somebody else's (`***@domain` keeps enough to make
    sense of the sentence). Digits are left alone — a bank reference or a card
    id in a sentence is the point of the sentence.
    """
    text = "" if value is None else str(value)
    return _EMAIL_ADDRESS.sub(lambda m: f"***@{m.group(1)}", text)


# ══════════════════════════════════════════════════════════════════════════════
#  The email leg
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class EmailLeg:
    """The email half of a notice: which §12 template, to whom, with what facts.

    `recipient` is used as given when set. Otherwise it is resolved from the
    notice's uid (and `kind` / `partner_id` for a partner-role event) by
    `recipient_for`. `required=False` means a person with no verified address
    simply gets no email (`skipped`); `required=True` (partners, staff) means a
    missing address is recorded as a `no_address` failure.
    """

    template: str
    recipient: mail.Recipient | None = None
    kind: str = ""
    partner_id: str = ""
    rows: list[tuple[str, Any]] = field(default_factory=list)
    subject: str = ""
    next_steps: str = ""
    button_url: str = ""
    button_label: str = ""
    footnote: str = ""
    recipient_key: str = ""
    required: bool = False
    #: Overrides the delivery row's `kind` (filterable in `/tech/email`) when a
    #: caller's existing kind is more specific than the template name.
    kind_override: str = ""


def email_state_of(result: Mapping[str, Any] | None) -> str:
    """The notice's `delivery.email` for one `email.send_template` result."""
    if not result:
        return EMAIL_SKIPPED
    outcome = str(result.get("outcome") or "")
    if outcome in (str(mail.Outcome.SENT), str(mail.Outcome.DELIVERED)):
        return EMAIL_SENT
    if outcome == str(mail.Outcome.DUPLICATE):
        earlier = str(result.get("existing_outcome") or "")
        if earlier in (str(mail.Outcome.SENT), str(mail.Outcome.DELIVERED), ""):
            return EMAIL_SENT
        return EMAIL_PENDING if earlier in mail.RETRYABLE_OUTCOMES else EMAIL_FAILED
    if outcome in mail.RETRYABLE_OUTCOMES:
        # The row carries the recipe and the sweep retries it — unless the
        # provider may already have taken it, which is never sent again.
        return EMAIL_FAILED if result.get("provider_outcome_unknown") else EMAIL_PENDING
    return EMAIL_FAILED


def _verified_auth_email(uid: str) -> tuple[str, str]:
    """Blocking: `(email, display_name)` from Firebase Auth, email only if verified."""
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        return "", ""
    if rec is None:
        return "", ""
    name = str(getattr(rec, "display_name", "") or "")
    email = str(getattr(rec, "email", "") or "").strip().lower()
    if not email or not bool(getattr(rec, "email_verified", False)):
        return "", name
    return email, name


async def app_user_recipient(uid: str, name: str = "") -> mail.Recipient:
    """The address an app user may be written to: their VERIFIED sign-in email.

    Empty when there is none. That is the normal case for a phone sign-up and
    is treated as `skipped`, never as a failure.
    """
    uid = str(uid or "").strip()
    if not uid:
        return mail.Recipient(email="", name=name, role=None, uid="")
    try:
        email, display = await asyncio.to_thread(_verified_auth_email, uid)
    except Exception:  # noqa: BLE001
        email, display = "", ""
    return mail.Recipient(email=email, name=name or display, role=None, uid=uid)


_PARTNER_KINDS = frozenset({"agency", "sub_agency", "seller"})


async def recipient_for(uid: str, *, kind: str = "", partner_id: str = "", name: str = "") -> mail.Recipient:
    """Where the email for this notice goes — see the module docstring."""
    if str(kind) in _PARTNER_KINDS and partner_id:
        from app.services import notify  # local: notify imports email, which this module imports

        try:
            recipient = await notify.partner_recipient({"_id": partner_id, "kind": str(kind), "name": name})
        except Exception as exc:  # noqa: BLE001
            log.warning("partner %s: address not resolved: %s", partner_id, exc)
            recipient = mail.Recipient(email="", name=name, role=None, uid=partner_id)
        # The notice is addressed to the human; the email row names the same uid.
        recipient.uid = str(uid or recipient.uid or "")
        return recipient
    return await app_user_recipient(uid, name)


# ══════════════════════════════════════════════════════════════════════════════
#  The writer
# ══════════════════════════════════════════════════════════════════════════════


def _plain_meta(meta: Mapping[str, Any] | None) -> dict:
    # Only plain, small values. A notice is read on a phone and stored for
    # ever; it is not the place for a record dump.
    out: dict[str, Any] = {}
    for key, value in (meta or {}).items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            out[str(key)] = value
        elif isinstance(value, (list, tuple)) and all(isinstance(v, (str, int, float, bool)) for v in value):
            out[str(key)] = list(value)
    return out


def _fs_notice(doc_id: str):
    return firebase.firestore_client().collection(NOTIFICATIONS).document(doc_id)


async def _write_in_app(doc_id: str, document: dict) -> tuple[bool, bool]:
    """`(written_or_present, existed)`. A document that already exists is left
    exactly as the person left it — `read` included."""
    ref = _fs_notice(doc_id)
    try:
        snap = await asyncio.to_thread(ref.get)
        if getattr(snap, "exists", False):
            return True, True
    except Exception:  # noqa: BLE001 — unknown: write; an overwritten read flag is the lesser harm
        log.warning("notice %s: existence could not be checked; writing", doc_id)
    try:
        await asyncio.to_thread(ref.set, document)
        return True, False
    except Exception:  # noqa: BLE001
        log.exception("notice %s could not be delivered in-app", doc_id)
        return False, False


async def mark_email_state(user_id: str, key: str, state: str, *, error: str = "") -> bool:
    """Update one notice's `delivery.email`. Never raises; False if not updated."""
    doc_id = str(key or "").strip()
    if not doc_id or state not in (EMAIL_SENT, EMAIL_PENDING, EMAIL_FAILED, EMAIL_SKIPPED):
        return False
    patch = {
        "delivery.email": state,
        "delivery.emailError": safe_text(error)[:300] if error else "",
        "delivery.updatedAt": _now(),
    }
    try:
        await asyncio.to_thread(_fs_notice(doc_id).update, patch)
        return True
    except Exception as exc:  # noqa: BLE001 — the document may not exist (in-app leg failed)
        log.warning("notice %s for %s: email state %s not recorded: %s", doc_id, user_id, state, exc)
        return False


# ── The in-app leg's retry: a parked notice ──────────────────────────────────
#
# A Firestore write that fails (an outage, a quota) must not lose the notice and
# must not reach the business action. The document is parked in Mongo under its
# eventKey, exactly as it would have been written, and the transactional sweep
# (`scheduling._sweep_notice_retries` → `retry_parked`) writes it later through
# the same `_write_in_app` — so a notice that did land in the meantime is left
# alone. A parked document never holds a code: a notice never carries one.

#: Mongo collection of parked in-app notices (`_id` = the eventKey).
NOTICE_OUTBOX = "notice_outbox"
PARKED_PENDING = "pending"
PARKED_WRITTEN = "written"
PARKED_GAVE_UP = "gave_up"


async def _park(doc_id: str, document: dict, error: str) -> bool:
    """Record an in-app notice whose write failed. Never raises."""
    try:
        from app.db.mongo import get_db  # local: keeps this module importable without Mongo

        now = _now()
        await get_db()[NOTICE_OUTBOX].update_one(
            {"_id": doc_id},
            {"$set": {"userId": str(document.get("userId") or ""), "document": document,
                      "status": PARKED_PENDING, "last_error": str(error or "")[:300],
                      "updated_at": now, "next_attempt_at": now},
             "$setOnInsert": {"created_at": now, "attempts": 0}},
            upsert=True,
        )
        return True
    except Exception:  # noqa: BLE001 — logged; the caller already reports inApp False
        log.exception("notice %s: the failed in-app write could not be parked for retry", doc_id)
        return False


async def retry_parked(limit: int = 200, *, now: datetime | None = None) -> list[dict]:
    """Write every parked in-app notice that is due. Never raises.

    One row per notice: `{"eventKey", "outcome": "in_app_written" | "failed" |
    "gave_up", "attempts"}`. The gaps double from 15 minutes, and after
    EMAIL_RETRY_MAX_SWEEPS attempts the notice is left `gave_up` for a person.
    """
    from datetime import timedelta

    now = now or _now()
    limit_attempts = int(getattr(settings, "email_retry_max_sweeps", 6) or 6)
    try:
        from app.db.mongo import get_db

        coll = get_db()[NOTICE_OUTBOX]
        rows = [r async for r in coll.find({"status": PARKED_PENDING}).limit(max(1, min(int(limit), 500)))]
    except Exception as exc:  # noqa: BLE001
        log.error("parked notices could not be listed: %s", exc)
        return [{"outcome": "failed", "error": f"list: {exc}"}]
    out: list[dict] = []
    for row in rows:
        due = row.get("next_attempt_at")
        if isinstance(due, datetime):
            due = due if due.tzinfo else due.replace(tzinfo=timezone.utc)
            if due > now:
                continue
        doc_id = str(row.get("_id") or "")
        attempts = int(row.get("attempts") or 0) + 1
        written, _existed = await _write_in_app(doc_id, dict(row.get("document") or {}))
        if written:
            patch = {"status": PARKED_WRITTEN, "attempts": attempts, "written_at": now, "updated_at": now}
            outcome = "in_app_written"
            await _refresh_email_state(str(row.get("userId") or ""), doc_id)
        elif attempts >= limit_attempts:
            patch = {"status": PARKED_GAVE_UP, "attempts": attempts, "updated_at": now}
            outcome = "gave_up"
        else:
            wait = min(15 * (2 ** (attempts - 1)), 24 * 60)
            patch = {"attempts": attempts, "updated_at": now, "next_attempt_at": now + timedelta(minutes=wait)}
            outcome = "failed"
        try:
            await coll.update_one({"_id": doc_id}, {"$set": patch})
        except Exception:  # noqa: BLE001
            log.exception("parked notice %s: state not updated", doc_id)
        out.append({"eventKey": doc_id, "outcome": outcome, "attempts": attempts})
    return out


async def _refresh_email_state(uid: str, doc_id: str) -> None:
    """A notice written late takes its email state from the delivery row, which
    an email retry may have moved on while the notice was parked. Never raises."""
    try:
        from app.db.mongo import C, get_db

        row = await get_db()[C.EMAIL_DELIVERIES].find_one({"notice.eventKey": doc_id})
        if row:
            await mark_email_state(uid, doc_id, email_state_of(row),
                                   error=str(row.get("error") or "") if row.get("outcome") != "sent" else "")
    except Exception:  # noqa: BLE001
        log.warning("parked notice %s: email state not refreshed", doc_id)


#: Events whose EMAIL another sender already owns. The notice carries no second
#: email for them — its `delivery.email` is `skipped` and `delivery.emailVia`
#: names the sender — so one event is still one email:
#:   * an agency / sub-agency / seller application and its approval: the
#:     Functions triggers on `agencies/{id}` / `sellers/{id}` (`onAgencyRegistered`,
#:     `onSellerRegistered`, `onAgencyApproved`, `onSellerApproved`), each
#:     deduplicated by a `mailLog/{docId}_{kind}` marker;
#:   * a partner's rejection and deactivation: the record-driven transactional
#:     sweep (8A.2.5 / 8A.2.13), deduplicated on `email_deliveries.dedupe_key`.
EMAIL_VIA_FUNCTIONS_REGISTERED = "functions:onAgencyRegistered|onSellerRegistered"
EMAIL_VIA_FUNCTIONS_APPROVED = "functions:onAgencyApproved|onSellerApproved"
EMAIL_VIA_SWEEP_REJECTED = "sweep:rejections (8A.2.5)"
EMAIL_VIA_SWEEP_DEACTIVATED = "sweep:deactivations (8A.2.13)"


async def deliver_notice(
    user_id: str,
    key: str,
    *,
    type: str,  # noqa: A002 — mirrors the document field
    title: str,
    body: str,
    reason: str = "",
    meta: Mapping[str, Any] | None = None,
    related_id: str = "",
    email: EmailLeg | None = None,
    email_via: str = "",
    now: datetime | None = None,
) -> dict:
    """THE writer. Returns `{"eventKey", "userId", "inApp", "existed", "parked",
    "email", "emailError", "emailOutcome"}`. Never raises.

    `email_via` (only without an `email` leg) names the sender that owns this
    event's email, so the notice says where its email went instead of
    pretending there was none.
    """
    uid = str(user_id or "").strip()
    doc_id = str(key or "").strip()
    out: dict[str, Any] = {"eventKey": doc_id, "userId": uid, "inApp": False, "existed": False,
                           "parked": False, "email": EMAIL_SKIPPED, "emailError": "", "emailOutcome": None}
    if not uid or not doc_id:
        log.warning("notice not delivered: uid=%r key=%r", uid, doc_id)
        return out

    created = now or _now()
    document: dict[str, Any] = {
        "userId": uid,
        "eventKey": doc_id,
        "type": str(type),
        "title": safe_text(title),
        "body": safe_text(body),
        "relatedId": str(related_id or ""),
        "createdAt": created,
        "read": False,
        "isRead": False,
        "delivery": {
            "inApp": True,
            "email": EMAIL_PENDING if email is not None else EMAIL_SKIPPED,
            "emailError": "",
            "updatedAt": created,
        },
    }
    if email is None and email_via:
        document["delivery"]["emailVia"] = str(email_via)
    if reason:
        document["reason"] = safe_text(reason)
    plain = _plain_meta(meta)
    if plain:
        document["meta"] = plain

    in_app, existed = await _write_in_app(doc_id, document)
    out["inApp"] = bool(in_app)
    out["existed"] = bool(existed)

    if email is None:
        if not in_app:
            out["parked"] = await _park(doc_id, document, "in-app write failed")
        return out

    # ── The email leg: recorded, role-gated, retryable; never raises ─────────
    try:
        recipient = email.recipient
        if recipient is None:
            recipient = await recipient_for(uid, kind=email.kind, partner_id=email.partner_id)
        if not recipient.email and not email.required:
            out["email"] = EMAIL_SKIPPED
            out["emailError"] = "no verified email address on the account"
        else:
            params: dict[str, Any] = {
                "title": document["title"],
                "body": document["body"],
                "subject": email.subject or document["title"],
                "rows": [[str(label), ("" if value is None else str(value))] for label, value in email.rows
                         if value not in (None, "")],
                "next_steps": email.next_steps,
                "button_url": email.button_url,
                "button_label": email.button_label,
                "footnote": email.footnote,
                "related_id": str(related_id or ""),
            }
            if reason:
                params["reason"] = document["reason"]
            result = await mail.send_template(
                email.template, recipient, params,
                related_id=str(related_id or doc_id),
                recipient_key=email.recipient_key,
                meta={"notice_type": str(type)},
                notice={"userId": uid, "eventKey": doc_id},
                kind=email.kind_override or None,
            )
            out["emailOutcome"] = result.get("outcome")
            out["email"] = email_state_of(result)
            out["emailError"] = safe_text(result.get("error") or "")[:300] if out["email"] != EMAIL_SENT else ""
    except Exception as exc:  # noqa: BLE001 — the business action stands
        log.exception("notice %s for %s: the email leg failed", doc_id, uid)
        out["email"] = EMAIL_FAILED
        out["emailError"] = exc.__class__.__name__[:300]

    if in_app:
        await mark_email_state(uid, doc_id, out["email"], error=out["emailError"])
    else:
        # Parked with the email state as it stands; the email retry sweep keeps
        # `delivery.email` current once the document exists.
        document["delivery"] = {**document["delivery"], "email": out["email"],
                                "emailError": out["emailError"], "inApp": True}
        out["parked"] = await _park(doc_id, document, "in-app write failed")
    return out


async def deliver(
    user_id: str,
    key: str,
    *,
    type: str,  # noqa: A002 — mirrors the document field
    title: str,
    body: str,
    reason: str = "",
    meta: Mapping[str, Any] | None = None,
    related_id: str = "",
    email: EmailLeg | None = None,
    email_via: str = "",
    now: datetime | None = None,
) -> bool:
    """Write one Official message for `user_id` (and its email, when asked).

    Returns True if the in-app document is present after the call — written
    now, or already there from an earlier delivery — so a caller can report
    `notified: false` without the decision itself having failed. The full
    delivery state is `deliver_notice`'s return value.
    """
    result = await deliver_notice(
        user_id, key, type=type, title=title, body=body, reason=reason, meta=meta,
        related_id=related_id, email=email, email_via=email_via, now=now,
    )
    return bool(result["inApp"])


# ── The Owners, as a group ────────────────────────────────────────────────────


async def notify_owners(
    key: str,
    *,
    type: str,  # noqa: A002
    title: str,
    body: str,
    template: str,
    related_id: str = "",
    rows: Sequence[tuple[str, Any]] = (),
    meta: Mapping[str, Any] | None = None,
    exclude_uid: str = "",
    next_steps: str = "",
) -> dict:
    """One notice + one email per active Owner, keyed `{key}:{uid}`. Never raises.

    `{"owners": n, "notified": [uid…], "email": {uid: state}, "note": ""}` —
    the shape `role_appeals.email_owners` callers already read (`sent`,
    `outcomes`) is derived from it there.
    """
    from app.core.roles import Role
    from app.services import notify

    out: dict[str, Any] = {"owners": 0, "notified": [], "email": {}, "note": ""}
    try:
        owners = await notify.staff_with_roles([Role.OWNER])
    except Exception as exc:  # noqa: BLE001
        log.warning("Owners could not be listed for %s: %s", key, exc)
        out["note"] = f"the Owners could not be listed: {exc}"
        return out
    owners = [o for o in owners if o.uid and o.uid != str(exclude_uid or "")]
    out["owners"] = len(owners)
    if not owners:
        out["note"] = "No active Owner record carries an email address."
        return out
    for owner in owners:
        result = await deliver_notice(
            owner.uid, f"{key}:{owner.uid}",
            type=type, title=title, body=body, meta=meta, related_id=related_id,
            email=EmailLeg(template=template, recipient=owner, rows=list(rows),
                           recipient_key=owner.uid, required=True, next_steps=next_steps),
        )
        if result["inApp"]:
            out["notified"].append(owner.uid)
        out["email"][owner.uid] = result["email"]
    return out


# ── Partner-role lifecycle ───────────────────────────────────────────────────
#
# One function per event rather than one generic one with a `status` argument,
# because the sentences are different and the person is reading them, not a
# parser. Every one of these names the role, says what happened, and — where
# there is one — says what to do next. Each carries its §12 email leg.

_ROLE_LABEL = {
    "agency": "Agency",
    "sub_agency": "Sub-agency",
    "seller": "Coin Seller",
    "host": "Host",
}


def role_label(kind: str) -> str:
    return _ROLE_LABEL.get(str(kind or "").strip(), str(kind or "partner").title())


def _portal() -> str:
    return str(settings.portal_url or "").rstrip("/")


def _partner_leg(template: str, kind: str, partner_id: str, *, rows: Sequence[tuple[str, Any]] = (),
                 next_steps: str = "", button: bool = False) -> EmailLeg:
    return EmailLeg(
        template=template, kind=str(kind), partner_id=str(partner_id),
        rows=[("Role", role_label(kind)), ("Reference", partner_id), *rows],
        next_steps=next_steps,
        button_url=(_portal() if button and _portal() else ""),
        button_label="Open your portal" if button else "",
        # A partner's record is expected to carry an address; a host is an app
        # user whose verified email may be absent.
        required=str(kind) in _PARTNER_KINDS,
    )


def _leg_unless_owned(kind: str, via: str, leg: EmailLeg) -> dict[str, Any]:
    """`{"email": leg}` — or, for an agency / sub-agency / seller, whose email for
    this event another sender owns (see `EMAIL_VIA_*`), `{"email": None,
    "email_via": via}`: one event, one email."""
    if str(kind) in _PARTNER_KINDS:
        return {"email": None, "email_via": via}
    return {"email": leg}


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
        related_id=partner_id,
        **_leg_unless_owned(kind, EMAIL_VIA_FUNCTIONS_REGISTERED,
                            _partner_leg("partner.application_received", kind, partner_id,
                                         next_steps="Nothing to do now. We will write either way.")),
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
        related_id=partner_id,
        **_leg_unless_owned(kind, EMAIL_VIA_FUNCTIONS_APPROVED,
                            _partner_leg("partner.approved", kind, partner_id, button=True)),
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
        related_id=partner_id,
        email=_partner_leg("partner.awaiting_verification", kind, partner_id,
                           rows=[("Still to verify", ", ".join(missing))],
                           next_steps="Verify the contact above in the app and the role starts by itself."),
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
        related_id=partner_id,
        email=_partner_leg("partner.held", kind, partner_id,
                           rows=[("Still to verify", ", ".join(missing))],
                           next_steps="Verify the contact above in the app; nothing else is needed."),
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
        related_id=partner_id,
        **_leg_unless_owned(kind, EMAIL_VIA_SWEEP_REJECTED,
                            _partner_leg("partner.rejected", kind, partner_id,
                                         next_steps="You may reapply once the point above is addressed; a "
                                                    "new application is judged on the same published rules.")),
    )


#: QA #50: the words for the fields a partner may propose a change to
#: (`partner_ops.APPLICABLE_FIELDS`). Names only — a notice never repeats the
#: values, which are bank details and identity documents.
_DETAIL_LABELS = {
    "accountHolderName": "account holder name", "accountNumber": "bank account number",
    "bankAccount": "bank account number", "ifscCode": "IFSC code", "bankName": "bank name",
    "branch": "branch", "upiId": "UPI ID", "binanceUid": "Binance UID",
    "paymentType": "payment method", "currency": "payout currency",
    "kycDocUrls": "identity documents", "idDocUrls": "identity documents",
    "registrationProofUrl": "government photo ID", "dob": "date of birth", "country": "country",
    "agencyName": "agency name", "displayName": "name", "hostName": "name", "ownerName": "name",
    "phone": "phone number", "applicantPhone": "phone number", "ownerPhone": "phone number",
    "email": "email address", "applicantEmail": "email address", "ownerEmail": "email address",
    "address": "address",
}

#: The payout fields — a change to one of these is a change to where money goes.
_PAYOUT_DETAILS = frozenset({
    "accountHolderName", "accountNumber", "bankAccount", "ifscCode", "bankName", "branch",
    "upiId", "binanceUid", "paymentType", "currency",
})


def detail_labels(fields: Sequence[str]) -> list[str]:
    """The fields of a proposed change in words, each once, in the order given.

    A key this list does not know is "other details" — never the key itself: a
    proposal's keys are written by whoever proposed it (security review,
    3 Nov 2026), and a notice must not repeat text somebody else chose.
    """
    out: list[str] = []
    for f in fields:
        label = _DETAIL_LABELS.get(str(f), "other details")
        if label not in out:
            out.append(label)
    return out


async def partner_details_decided(
    uid: str, kind: str, partner_id: str, *, applied: bool, fields: Sequence[str],
    reason: str = "", decision_id: str = "",
) -> bool:
    """QA #50 — a partner is told when the bank or KYC change they proposed is
    applied or refused. Nothing used to tell them: an applied change simply
    appeared, a refused one silently reverted (the reason sat on a dashboard
    they had no reason to open). Keyed on the decision's audit entry, so a
    second proposal decided later is a second notice."""
    label = role_label(kind)
    names = detail_labels(fields)
    what = ", ".join(names) if names else "details"
    key = f"partner_details_{'applied' if applied else 'rejected'}_{decision_id or partner_id}"
    if applied:
        body = f"The change you proposed to your {label} details has been reviewed and applied: {what}."
        if any(str(f) in _PAYOUT_DETAILS for f in fields):
            body += " Payouts go to the new details from now on."
        title = f"{label} details updated"
    else:
        body = (
            f"The change you proposed to your {label} details was not applied."
            + (f" Reason: {reason}" if reason else "")
            + " Your current details stay as they were. You can propose the change again "
              "once the point above is addressed."
        )
        title = f"{label} detail change not applied"
    return await deliver(
        uid, key,
        type="partner_details_decided",
        title=title,
        body=body,
        reason="" if applied else reason,
        meta={"role": str(kind), "partnerId": partner_id, "status": "applied" if applied else "rejected",
              "fields": list(names)},
        related_id=decision_id or partner_id,
        email=_partner_leg("partner.details_decided", kind, partner_id,
                           rows=[("Change", "Applied" if applied else "Not applied"), ("Details", what)]),
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
        related_id=partner_id,
        **_leg_unless_owned(kind, EMAIL_VIA_SWEEP_DEACTIVATED,
                            _partner_leg("role.suspended", kind, partner_id,
                                         next_steps="Money already owed to you stays owed and is paid on "
                                                    "the published schedule. Ask through the app if you "
                                                    "want the decision reviewed.")),
    )


async def partner_reactivated(uid: str, kind: str, partner_id: str) -> bool:
    label = role_label(kind)
    return await deliver(
        uid, f"partner_reactivated_{partner_id}",
        type="partner_reactivated",
        title=f"{label} role reactivated",
        body=f"Your {label} role is active again.",
        meta={"role": str(kind), "partnerId": partner_id, "status": "approved"},
        related_id=partner_id,
        email=_partner_leg("role.resumed", kind, partner_id, button=True),
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
        related_id=partner_id,
        email=_partner_leg("role.revoked", kind, partner_id,
                           next_steps="Your records and history are kept. A reinstatement request "
                                      "can be filed from the app and is decided by an Owner."),
    )


# ── Reinstatement of a revoked role (C2) ─────────────────────────────────────

async def role_appeal_requested(uid: str, kind: str, appeal_id: str, record_id: str) -> bool:
    """The person is told their request is filed; the Owners are told separately
    (`role_appeals.submit` → `notify_owners`)."""
    label = role_label(kind)
    return await deliver(
        uid, f"role_appeal_requested_{appeal_id}",
        type="role_appeal_requested",
        title=f"{label} reinstatement requested",
        body=(
            f"Your request to reinstate your {label} role has been filed and is with "
            "a reviewer. An Owner takes the final decision; you will be told here."
        ),
        meta={"role": str(kind), "appealId": appeal_id, "recordId": record_id, "status": "pending"},
        related_id=appeal_id,
        email=EmailLeg(template="role_appeal.requested",
                       rows=[("Role", label), ("Request", appeal_id)]),
    )


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
        related_id=appeal_id,
        email=EmailLeg(template="role_appeal.decided",
                       rows=[("Role", label), ("Request", appeal_id), ("Decision", "Reinstated")]),
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
        related_id=appeal_id,
        email=EmailLeg(template="role_appeal.decided",
                       rows=[("Role", label), ("Request", appeal_id), ("Decision", "Stays revoked")]),
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
        related_id=partner_id,
        email=EmailLeg(template="transfer.decided", kind=str(kind),
                       partner_id=partner_id if str(kind) in _PARTNER_KINDS else "",
                       rows=[("Role", label), ("From", from_name), ("To", to_name), ("Decision", "Approved")],
                       recipient_key=uid),
    )


async def transfer_refused(uid: str, kind: str, request_id: str, to_name: str, note: str) -> bool:
    """§6 — the affected person is told a requested transfer was NOT approved."""
    label = role_label(kind)
    return await deliver(
        uid, f"transfer_{request_id}_refused_{uid}",
        type="transfer_refused",
        title="A transfer of your role was not approved",
        body=(
            f"A request to move your {label} role to {to_name or 'another agency'} was "
            "reviewed by an Owner and not approved. Nothing about your agency has changed."
        ),
        reason=note,
        meta={"role": str(kind), "transferId": request_id, "status": "rejected"},
        related_id=request_id,
        email=EmailLeg(template="transfer.decided", rows=[("Role", label), ("Request", request_id),
                                                           ("Decision", "Not approved")],
                       recipient_key=uid),
    )


async def transfer_requested_person(uid: str, kind: str, request_id: str, from_name: str, to_name: str) -> bool:
    """§6 — the affected person is told a transfer of their role is waiting for the Owner."""
    label = role_label(kind)
    return await deliver(
        uid, f"transfer_{request_id}_requested_{uid}",
        type="transfer_requested",
        title="A transfer of your role has been requested",
        body=(
            f"A request to move your {label} role from {from_name or 'your agency'} to "
            f"{to_name or 'another agency'} has been filed and is waiting for an Owner's "
            "decision. Nothing changes until it is decided; you will be told here."
        ),
        meta={"role": str(kind), "transferId": request_id, "status": "pending"},
        related_id=request_id,
        email=EmailLeg(template="transfer.requested",
                       rows=[("Role", label), ("From", from_name), ("To", to_name), ("Request", request_id)],
                       recipient_key=uid),
    )


async def transfer_agency_notice(
    agency_owner_uid: str, request_id: str, *, side: str, kind: str, subject_name: str,
    from_name: str, to_name: str, decision: str = "approved", agency_id: str = "",
    agency_kind: str = "agency",
) -> bool:
    """§6 Transfers — "notify source/target/affected": the SOURCE or TARGET agency's
    owner is told that a transfer moved somebody out of, or into, their agency
    (`decision="approved"`), is waiting for the Owner (`"requested"`), or was
    refused (`"rejected"`). Keyed on the request, the side and the decision, so
    one decision is one message per agency."""
    label = role_label(kind)
    who = subject_name or f"A {label}"
    if decision == "requested":
        title = (f"A {label} may move out of your agency" if side == "source"
                 else f"A {label} may join your agency by transfer")
        body = (
            f"A request to transfer {who} from {from_name or 'your agency'} to {to_name or 'another agency'} "
            "is waiting for an Owner's decision. Nothing changes until it is decided."
        )
    elif decision == "rejected":
        title = f"A {label} transfer was not approved"
        body = (
            f"The request to transfer {who} from {from_name or 'their agency'} to "
            f"{to_name or 'another agency'} was reviewed by an Owner and not approved. Nothing has changed."
        )
    elif side == "source":
        title = f"A {label} has moved out of your agency"
        body = (
            f"{who} has been transferred from {from_name or 'your agency'} "
            f"to {to_name}. Earnings already recorded under your agency are unchanged."
        )
    else:
        title = f"A {label} has joined your agency by transfer"
        body = (
            f"{who} has been transferred to {to_name or 'your agency'} "
            f"from {from_name or 'their previous agency'}. Earnings from now on are recorded under your agency."
        )
    suffix = "" if decision == "approved" else f"_{decision}"
    return await deliver(
        agency_owner_uid, f"transfer_{request_id}_{side}{suffix}",
        type=f"transfer_{side}" if decision == "approved" else f"transfer_{side}_{decision}",
        title=title,
        body=body,
        meta={"role": str(kind), "transferId": request_id, "side": side, "status": decision},
        related_id=request_id,
        email=EmailLeg(template="transfer.requested" if decision == "requested" else "transfer.decided",
                       kind=agency_kind if agency_id else "", partner_id=agency_id,
                       rows=[("Role", label), ("Who", who), ("From", from_name), ("To", to_name),
                             ("Request", request_id), ("Decision", decision.title())],
                       recipient_key=f"{side}:{agency_owner_uid}", required=bool(agency_id)),
    )


# ── Department vacancy (§9) ─────────────────────────────────────────────────

async def department_vacancy(owner_uid: str, team: str, team_label: str, *, opened: bool,
                             since_epoch: int, recipient: mail.Recipient | None = None,
                             cause: str = "") -> bool:
    """§9 — ONE notice per Owner per vacancy: "<Department> has no Admin"
    (members report to the Owner until a replacement is appointed), and its
    closing. Keyed on the vacancy's opening moment, so a retried deactivation
    delivers once and a later vacancy is a new message. With `recipient` (the
    Owner's staff record) the email leg goes with it."""
    rows = [("Department", team_label),
            ("Members report to", "Owner (vacancy)" if opened else "the department Admin"),
            ("Cause", cause)]
    leg = (EmailLeg(template="department.vacancy", recipient=recipient, rows=rows,
                    recipient_key=owner_uid, required=True) if recipient is not None else None)
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
            related_id=f"{team}:{since_epoch}",
            email=leg,
        )
    return await deliver(
        owner_uid, f"department_vacancy_closed_{team}_{since_epoch}_{owner_uid}",
        type="department_vacancy_closed",
        title=f"{team_label} has an Admin again",
        body=f"A department Admin is in place for {team_label}. Its members report to that Admin again.",
        meta={"team": team, "vacancy": False},
        related_id=f"{team}:{since_epoch}",
        email=leg,
    )


# ── Host ────────────────────────────────────────────────────────────────────

async def host_application_submitted(uid: str, application_id: str) -> bool:
    return await deliver(
        uid, f"host_submitted_{application_id}",
        type="host_submitted",
        title="Host application received",
        body="Your Host application has been submitted and is with a reviewer.",
        meta={"role": "host", "applicationId": application_id, "status": "pending"},
        related_id=application_id,
        email=EmailLeg(template="partner.application_received",
                       rows=[("Role", "Host"), ("Reference", application_id)]),
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
        related_id=application_id,
        email=EmailLeg(template="partner.approved", rows=[("Role", "Host"), ("Reference", application_id)],
                       next_steps="Complete your profile and facial verification in the app."),
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
        related_id=application_id,
        email=EmailLeg(template="partner.rejected", rows=[("Role", "Host"), ("Reference", application_id)]),
    )


async def host_revoked(uid: str, reason: str) -> bool:
    stamp = int(datetime.now(timezone.utc).timestamp())
    return await deliver(
        uid, f"host_revoked_{uid}_{stamp}",
        type="host_revoked",
        title="Host role revoked",
        body=(
            "Your Host role has been revoked."
            + (f" Reason: {reason}" if reason else "")
            + " Your account and your earnings history are not affected."
        ),
        reason=reason,
        meta={"role": "host", "status": "revoked"},
        related_id=f"{uid}:{stamp}",
        email=EmailLeg(template="role.revoked", rows=[("Role", "Host")],
                       next_steps="A reinstatement request can be filed from the app and is decided by an Owner."),
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
    stamp = int(datetime.now(timezone.utc).timestamp())
    return await deliver(
        agency_owner_uid,
        f"agency_host_{change}_{agency_id}_{host_uid}_{stamp}",
        type=f"agency_host_{change}",
        title=f"A Host on your roster was {change}",
        body=(
            f"{who}'s Host role has been {change}."
            + (f" Reason: {reason}" if reason else "")
            + " Their earnings history under your agency is unchanged."
        ),
        reason=reason,
        meta={"role": "host", "agencyId": agency_id, "hostUid": host_uid, "status": change},
        related_id=f"{agency_id}:{host_uid}:{stamp}",
        email=EmailLeg(template="agency.host_changed", kind="agency", partner_id=agency_id,
                       rows=[("Host", who), ("Change", change.title()), ("Agency", agency_id)],
                       recipient_key=agency_owner_uid, required=True),
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
        related_id=f"{uid}:{revoked_at_epoch}",
        email=EmailLeg(template="role.resumed", rows=[("Role", "Host")]),
    )


async def host_suspended(uid: str, reason: str, audit_id: str, *, until: datetime | None = None) -> bool:
    """§5 partner role suspension, Host: the person is told — with the reason
    and the end date — that only the Host role is paused.

    Keyed on the audit entry of the suspension, so a retried delivery is one
    message and a later suspension of the same person is a second one.
    """
    term = f"until {mail.when(until)}" if until else "until it is resumed"
    return await deliver(
        uid, f"host_suspended_{uid}_{audit_id or 'x'}",
        type="host_suspended",
        title="Host role suspended",
        body=(
            f"Your Host role is suspended {term}."
            + (f" Reason: {reason}" if reason else "")
            + " Until then you cannot go live or take paid calls as a Host. Your account, your "
            "other roles, your agency and your earnings history are unchanged; host money "
            "already earned stays yours and is held for review."
        ),
        reason=reason,
        meta={"role": "host", "status": "suspended", "until": until.isoformat() if until else None},
        related_id=str(audit_id or uid),
        email=EmailLeg(template="host.suspended",
                       rows=[("Role", "Host"), ("Until", mail.when(until) if until else "Until it is resumed")],
                       next_steps="Ask through the app if you want the decision reviewed."),
    )


async def host_resumed(uid: str, audit_id: str) -> bool:
    """The SAME Host role working again (§5), by a person or at the end of its
    term. Keyed on the resume's audit entry, like `host_suspended`."""
    return await deliver(
        uid, f"host_resumed_{uid}_{audit_id or 'x'}",
        type="host_resumed",
        title="Host role active again",
        body=(
            "Your Host role is active again — the same role, under the same agency, with "
            "your earnings history unchanged."
        ),
        meta={"role": "host", "status": "active"},
        related_id=str(audit_id or uid),
        email=EmailLeg(template="host.resumed", rows=[("Role", "Host")]),
    )


async def host_verification_required(uid: str) -> bool:
    return await deliver(
        uid, f"host_verification_required_{uid}",
        type="host_verification_required",
        title="Facial verification required",
        body="Complete facial verification in your profile to become a verified Host.",
        meta={"role": "host", "nextAction": "face_verification"},
        related_id=uid,
    )


async def host_verification_decided(uid: str, approved: bool, reason: str = "") -> bool:
    if approved:
        return await deliver(
            uid, f"host_verification_approved_{uid}",
            type="host_verification_approved",
            title="You are a verified Host",
            body="Your facial verification has been approved.",
            meta={"role": "host", "status": "verified"},
            related_id=uid,
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
        related_id=uid,
    )


# ── Warning / suspension / ban (§5, §12) ─────────────────────────────────────

async def official_warning(uid: str, warning_id: str, reason: str, *, issued_at: datetime | None = None) -> bool:
    """An official warning. The body is the reviewer's sentence, which the CRM
    already tells reviewers may be shown; who moderated is never carried."""
    return await deliver(
        uid, f"warning_{warning_id}",
        type="warning",
        title="Official warning",
        body=reason,
        related_id=warning_id,
        now=issued_at,
        email=EmailLeg(template="user.warning", rows=[("Reference", warning_id)],
                       footnote="Repeated warnings can lead to a suspension or a ban of the account."),
    )


_RESTRICTION_TEXT = {
    "suspended": ("Your Zipper account is suspended",
                  "Your account has been suspended and cannot use Zipper{until}."),
    "resumed": ("Your Zipper account is active again",
                "The suspension on your account has been lifted. Sign in again to continue."),
    "banned": ("Your Zipper account is banned",
               "Your account has been banned from Zipper."),
    "unbanned": ("Your Zipper ban has been lifted",
                 "The ban on your account has been lifted. Sign in again to continue."),
}


async def account_restriction(
    uid: str, change: str, reason: str, audit_id: str, *, until: datetime | None = None,
) -> bool:
    """§5 — the person is told of a suspension, a resume, a ban or an unban,
    with the reason, keyed on the audit entry so a retry delivers once."""
    title, body = _RESTRICTION_TEXT.get(change, (f"Your Zipper account was {change}", f"Your account was {change}."))
    body = body.format(until=f" until {mail.when(until)}" if until else "")
    # QA (3 Nov 2026, E1b): the ban notice reached the app without its reason —
    # it rode only in the `reason` field, which no shipped app build displayed.
    # Said in the sentence now, as every other decision notice does; the email
    # shows it once (`email._notice_body` skips the Reason box when the body
    # already carries it) and the app shows it once (`MessagesTabs.reasonLine`).
    if change in ("suspended", "banned") and safe_text(reason):
        body += f" Reason: {safe_text(reason)}"
    next_steps = (
        "If you believe this is a mistake you can appeal: open the appeal form from the "
        "sign-in screen or the Zipper website and quote your account id."
        if change in ("suspended", "banned") else ""
    )
    return await deliver(
        uid, f"account_{change}_{audit_id or uid}",
        type=f"account_{change}",
        title=title,
        body=body,
        reason=reason if change in ("suspended", "banned") else "",
        meta={"status": change, **({"until": until.isoformat()} if until else {})},
        related_id=str(audit_id or uid),
        email=EmailLeg(template=f"account.{change}",
                       rows=[("Status", change.title())] + ([("Until", mail.when(until))] if until else []),
                       next_steps=next_steps),
    )


# ── Appeals (§5) ────────────────────────────────────────────────────────────

async def appeal_receipt(uid: str, appeal_id: str, reference: str = "", *, show_id: bool = True) -> dict:
    """QA #53 — "we received your appeal", in the app and by email.

    The notice and its template existed and nothing sent them. Keyed on the
    appeal (`appeal_received_{id}`), so the public form's immediate call and the
    transactional sweep's later pass (which covers the app's and the device
    key's appeals, written without the backend) deliver it once. Returns
    `deliver_notice`'s state; never raises.
    """
    return await deliver_notice(
        uid, f"appeal_received_{appeal_id}",
        type="appeal_received",
        title="Your appeal has been received",
        body=(
            "Your appeal has been filed and is with a reviewer. An Owner takes the final "
            "decision; you will be told the outcome here."
            + (f" Reference: {reference}." if reference else "")
        ),
        meta={"appealId": appeal_id, "status": "pending", **({"reference": reference} if reference else {})},
        related_id=appeal_id,
        # Security review: the email quotes the server's reference, or nothing —
        # an appeal written by a client has an id the client chose.
        email=EmailLeg(template="appeal.received",
                       rows=[("Reference", reference or (appeal_id if show_id else ""))]),
    )


async def appeal_received(uid: str, appeal_id: str, reference: str = "") -> bool:
    return bool((await appeal_receipt(uid, appeal_id, reference))["inApp"])


async def appeal_decided(uid: str, appeal_id: str, verdict: str, reason: str) -> bool:
    """`verdict` is `overturned` (restriction lifted) or `upheld`."""
    lifted = str(verdict) == "overturned"
    return await deliver(
        uid, f"appeal_decided_{appeal_id}",
        type="appeal_decided",
        title="Your appeal was accepted" if lifted else "Your appeal was not accepted",
        body=(
            "An Owner reviewed your appeal and accepted it. The restriction it was about has "
            "been lifted; sign in again to continue."
            if lifted else
            "An Owner reviewed your appeal and did not accept it. The restriction on your "
            "account stays in place."
        ),
        reason=reason,
        meta={"appealId": appeal_id, "status": str(verdict)},
        related_id=appeal_id,
        email=EmailLeg(template="appeal.decided",
                       rows=[("Appeal", appeal_id), ("Decision", "Accepted" if lifted else "Not accepted")]),
    )


# ── Support (WP-D) ──────────────────────────────────────────────────────────

async def ticket_reply(uid: str, ticket_id: str, title: str, *, key: str) -> bool:
    """A reply on a support / feedback ticket — identity `support`."""
    return await deliver(
        uid, key,
        type="ticket",
        title="Zipper replied to your ticket",
        body=f"There is a reply on “{title}”. Open Messages → Feedback to read it.",
        meta={"queue": "support", "ticket_id": ticket_id},
        related_id=ticket_id,
        email=EmailLeg(template="support.ticket_reply", rows=[("Ticket", ticket_id), ("Subject", title)],
                       next_steps="Open the Zipper app, Messages → Feedback, to read and answer the reply."),
    )


# ── Recharge ────────────────────────────────────────────────────────────────

#: The recharge events that also go out by email (§12 "recharge/refund").
_RECHARGE_EMAILED = frozenset({"approved", "refunded"})


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
            f"Your request for {diamonds} diamonds{via} has been received. "
            "Diamonds are credited as soon as the seller confirms your payment.",
            f"A buyer paid you for {diamonds} diamonds. Check your account and approve it in "
            "Work → Recharges (if you still owe borrowed coins, Zipper verifies it instead).",
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
    leg = None
    if event in _RECHARGE_EMAILED:
        leg = EmailLeg(
            template=f"recharge.{event}",
            rows=[("Recharge", recharge_id), ("Diamonds", diamonds)]
            + ([("Seller", seller_name)] if seller_name and not for_seller else []),
            recipient_key=who,
        )
    return await deliver(
        uid, f"recharge_{event}_{recharge_id}_{who}",
        type=f"recharge_{event}",
        title=title,
        body=body,
        reason=reason,
        meta={"rechargeId": recharge_id, "diamonds": int(diamonds), "status": event},
        related_id=recharge_id,
        email=leg,
    )
