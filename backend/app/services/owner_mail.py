"""§8 — telling the other Owners that money moved.

    "One Owner may raise, verify, sign and execute a money card alone. …
     Audit every step. Notify other Owners in-app and by email with actor,
     action, amount and card reference."

What replaced the second signature is the telling, so the telling has to be
as dependable as a ledger row. Three properties, in order of importance:

**It never undoes the business action.** `notify_other_owners` is called after
the signature, the execution, the approval or the decision has been committed
and audited. Nothing here raises into the caller: a Firestore outage, a mail
provider refusing, an Owner with no address — all of those are *recorded* and
the action stands. "The money moved and the other Owners were not told" is a
state this module makes visible, not a state it prevents by refusing to move
money.

**It is idempotent.** Every event has one deterministic key —
``owner_money:{reference}:{action}`` — which is the `_id` of its row in
`owner_notices`, the id of each Owner's in-app notice (`{key}:{uid}`) and the
prefix of every email dedupe key. A signature retried after a timeout, an
execution replayed, a decision double-clicked: the second call finds the row
already `sent` and does nothing.

**It is retryable.** A row whose deliveries did not all succeed stays
`pending` with the outcome per Owner. `retry_pending` — run by the
transactional sweep every fifteen minutes and by an Owner from the CRM —
re-attempts only the halves that failed, under a fresh per-attempt dedupe key,
so a provider that was down at 10:00 does not leave an Owner untold at 10:15.
The `owner_notice_failed` alert names any row still pending after the
configured minutes (`ALERT_OWNER_NOTICE_PENDING_MINUTES`).

Who is told: every **active** staff account holding the Owner role except the
actor, resolved from the staff record by `notify.staff_with_roles` — the same
source every alert uses, and never a constant. The email goes out through
`email.deliver` (the recorded, role-gated, retrying path) with
`Sensitivity.BUSINESS_MONEY`; the in-app notice through `notices.deliver`.
This module adds no template file: the body is built from `email.facts` and
`email.callout`, which is enough for a four-line fact sheet.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

from app.config import settings
from app.core import audit
from app.core.roles import Role
from app.db.mongo import C, get_db
from app.services import email as mail
from app.services import notices, notify

log = logging.getLogger(__name__)

EVENT_PREFIX = "owner_money"
SPEC = "MASTER-SPEC §8 — Owner-alone money card"
NOTICE_TYPE = "owner_money"

#: Delivery outcomes that count as "this Owner has been told by email".
#: `withheld_role` cannot happen for an Owner, and `duplicate` means an earlier
#: attempt already sent it — which is the retry case working as designed.
_EMAIL_OK: frozenset[str] = frozenset(
    {str(mail.Outcome.SENT), str(mail.Outcome.DELIVERED), str(mail.Outcome.DUPLICATE)}
)

#: action → (verb phrase for the sentence, short label for the subject line).
ACTIONS: dict[str, tuple[str, str]] = {
    "card_signed": ("signed a money card", "Card signed"),
    "card_executed": ("executed a money card", "Card executed"),
    "recharge_approved": ("approved a recharge", "Recharge approved"),
    "refund_approved": ("approved a recharge refund", "Refund approved"),
    "refund_refused": ("refused a recharge refund", "Refund refused"),
    "freeze_release": ("released frozen money", "Frozen money released"),
    "freeze_withhold": ("withheld frozen money", "Frozen money withheld"),
    "freeze_adjust": ("adjusted frozen money", "Frozen money adjusted"),
    "sale_approved": ("approved a seller sale", "Sale approved"),
}

#: Email kinds, one per action, so `/notifications/deliveries` can be filtered
#: by them: `owner_money.card_signed`, `owner_money.recharge_approved`, …
def email_kind(action: str) -> str:
    return f"{EVENT_PREFIX}.{action}"


def event_key(reference: str, action: str) -> str:
    """The deterministic identity of one event. Retries land on the same key."""
    return f"{EVENT_PREFIX}:{str(reference or '').strip()}:{str(action or '').strip()}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _amount_text(amount: Any, currency: str) -> str:
    if amount is None:
        return "—"
    unit = str(currency or "").strip().lower()
    if unit in ("commission", "inr_minor", "inr", "paise"):
        return mail.money(int(amount))
    return mail.quantity(int(amount), unit or "units")


def _who(actor: Mapping[str, Any]) -> dict:
    return {"uid": str(actor.get("uid") or ""), "name": str(actor.get("name") or ""),
            "role": str(actor.get("role") or "")}


async def _other_owners(actor_uid: str) -> list[mail.Recipient]:
    people = await notify.staff_with_roles([Role.OWNER])
    return [p for p in people if str(p.uid or "") != actor_uid]


def _sentence(doc: Mapping[str, Any]) -> tuple[str, str, list[tuple[str, Any]]]:
    """(subject, body sentence, fact rows) for one event."""
    action = str(doc.get("action") or "")
    verb, label = ACTIONS.get(action, (action.replace("_", " "), action.replace("_", " ").title()))
    actor = doc.get("actor") or {}
    amount_text = _amount_text(doc.get("amount"), str(doc.get("currency") or ""))
    reference = str(doc.get("reference") or "")
    ref_type = str(doc.get("reference_type") or "item")
    title = str(doc.get("title") or "")
    subject = f"Zipper — {label}: {amount_text} ({ref_type} {reference[-8:] or reference})"
    body = (
        f"{actor.get('name') or 'An Owner'} ({actor.get('role') or 'owner'}) {verb}"
        f"{' — ' + title if title else ''}: {amount_text}. Reference {ref_type} {reference}."
    )
    rows: list[tuple[str, Any]] = [
        ("Actor", f"{actor.get('name') or '?'} ({actor.get('role') or '?'}, uid {actor.get('uid') or '?'})"),
        ("Action", label),
        ("Amount", amount_text),
        ("Reference", f"{ref_type} {reference}"),
        ("Title", title or None),
        ("Card type", doc.get("card_type") or None),
        ("Subject", (
            f"{(doc.get('subject') or {}).get('type')} {(doc.get('subject') or {}).get('id')}"
            if isinstance(doc.get("subject"), dict) and (doc.get("subject") or {}).get("id") else None
        )),
        ("Reason", doc.get("reason") or None),
        ("When", mail.when(doc.get("created_at"))),
    ]
    for extra in doc.get("rows") or []:
        if isinstance(extra, (list, tuple)) and len(extra) == 2:
            rows.append((str(extra[0]), extra[1]))
    return subject, body, rows


async def notify_other_owners(
    *,
    actor: Mapping[str, Any],
    action: str,
    reference: str,
    reference_type: str = "card",
    amount: Any = None,
    currency: str = "",
    title: str = "",
    card_type: str = "",
    subject: Mapping[str, Any] | None = None,
    reason: str = "",
    rows: Sequence[tuple[str, Any]] = (),
) -> dict:
    """Tell every other active Owner. Never raises. Returns the delivery state.

    `{"event_key", "status": "sent" | "pending" | "no_recipients" | "failed",
      "recipients": n, "deliveries": {uid: {"in_app": bool, "email": outcome}},
      "already": bool}`
    """
    key = event_key(reference, action)
    now = _now()
    try:
        db = get_db()
        await db[C.OWNER_NOTICES].update_one(
            {"_id": key},
            {"$setOnInsert": {
                "_id": key,
                "event_key": key,
                "action": str(action),
                "reference": str(reference),
                "reference_type": str(reference_type),
                "actor": _who(actor),
                "amount": int(amount) if isinstance(amount, (int, float)) and not isinstance(amount, bool) else None,
                "currency": str(currency or ""),
                "title": str(title or ""),
                "card_type": str(card_type or ""),
                "subject": dict(subject or {}),
                "reason": str(reason or ""),
                "rows": [list(r) for r in rows],
                "status": "pending",
                "attempts": 0,
                "deliveries": {},
                "created_at": now,
                "updated_at": now,
            }},
            upsert=True,
        )
        doc = await db[C.OWNER_NOTICES].find_one({"_id": key})
        if doc is None:  # pragma: no cover — the upsert just wrote it
            raise RuntimeError("owner_notices row not readable after upsert")
        if str(doc.get("status")) == "sent":
            # The business action was retried; the Owners were already told.
            return {"event_key": key, "status": "sent", "already": True,
                    "recipients": len(doc.get("deliveries") or {}),
                    "deliveries": doc.get("deliveries") or {}}
        return await _attempt(db, doc)
    except Exception as exc:  # noqa: BLE001 — the business action stands
        log.exception("Owner notification %s could not even be recorded", key)
        try:
            await audit.record(
                actor=dict(actor), action=audit.Action.OWNER_NOTICE_FAILED,
                subject_type="owner_notice", subject_id=key,
                card_id=str(reference) if reference_type == "card" else None,
                reason=f"Other Owners could not be notified ({type(exc).__name__}: {exc}).",
                meta={"event_key": key, "action": str(action), "stage": "record",
                      "reference_type": str(reference_type), "reference": str(reference)},
            )
        except Exception:  # noqa: BLE001
            log.exception("…and the failure could not be audited either")
        return {"event_key": key, "status": "failed", "error": f"{type(exc).__name__}: {exc}",
                "recipients": 0, "deliveries": {}}


async def _attempt(db, doc: dict) -> dict:
    """One delivery attempt over every Owner not yet fully told."""
    key = str(doc["_id"])
    attempt = int(doc.get("attempts") or 0) + 1
    now = _now()
    actor = doc.get("actor") or {}
    deliveries: dict[str, dict] = dict(doc.get("deliveries") or {})

    try:
        recipients = await _other_owners(str(actor.get("uid") or ""))
    except Exception as exc:  # noqa: BLE001
        await db[C.OWNER_NOTICES].update_one({"_id": key}, {"$set": {
            "attempts": attempt, "last_error": f"owners could not be resolved: {exc}",
            "last_attempt_at": now, "updated_at": now,
        }})
        await _audit_outcome(doc, "pending", attempt, deliveries, error=str(exc))
        return {"event_key": key, "status": "pending", "recipients": 0, "deliveries": deliveries,
                "error": f"owners could not be resolved: {exc}"}

    if not recipients:
        await db[C.OWNER_NOTICES].update_one({"_id": key}, {"$set": {
            "status": "no_recipients", "attempts": attempt, "last_attempt_at": now,
            "updated_at": now, "sent_at": now,
        }})
        await _audit_outcome(doc, "no_recipients", attempt, deliveries)
        return {"event_key": key, "status": "no_recipients", "recipients": 0, "deliveries": deliveries}

    subject, body, rows = _sentence(doc)
    html = mail.page(
        title=subject,
        preheader=body[:180],
        body=mail.callout(body, "warning", heading="Owner money action") + mail.facts(rows) + (
            '<p style="margin:16px 0 0;line-height:1.6;font-size:13px;color:#52525b">'
            "You are receiving this because one Owner may now take a money card through every "
            "stage alone (master spec §8) and every other Owner is told of each step. "
            "The full trail is in the CRM audit log under the reference above.</p>"
        ),
    )

    errors: list[str] = []
    for person in recipients:
        uid = str(person.uid or "") or f"email:{person.email}"
        state = dict(deliveries.get(uid) or {"in_app": False, "email": None})
        if not state.get("in_app"):
            state["in_app"] = await notices.deliver(
                str(person.uid or ""), f"{key}:{person.uid}",
                type=NOTICE_TYPE,
                title=subject.replace("Zipper — ", ""),
                body=body,
                meta={"eventKey": key, "action": str(doc.get("action") or ""),
                      "reference": str(doc.get("reference") or ""),
                      "referenceType": str(doc.get("reference_type") or ""),
                      "amount": doc.get("amount"), "currency": str(doc.get("currency") or ""),
                      "actorUid": str(actor.get("uid") or ""),
                      "actorName": str(actor.get("name") or "")},
            )
            if not state["in_app"]:
                errors.append(f"in-app notice for {uid} not written")
        if str(state.get("email") or "") not in _EMAIL_OK:
            try:
                row = await mail.deliver(
                    kind=email_kind(str(doc.get("action") or "")),
                    spec=SPEC,
                    recipient=person,
                    subject=subject,
                    html=html,
                    sensitivity=mail.Sensitivity.BUSINESS_MONEY,
                    dedupe_key=f"{key}:{uid}:a{attempt}",
                    meta={"event_key": key, "action": str(doc.get("action") or ""),
                          "reference": str(doc.get("reference") or ""),
                          "amount": doc.get("amount"), "currency": str(doc.get("currency") or ""),
                          "actor_uid": str(actor.get("uid") or ""), "attempt": attempt},
                )
                state["email"] = str(row.get("outcome") or "")
                if state["email"] not in _EMAIL_OK:
                    errors.append(f"email to {uid}: {state['email']} — {row.get('error') or ''}".strip())
            except Exception as exc:  # noqa: BLE001 — recorded, retried later
                log.exception("Owner notification email %s → %s failed", key, uid)
                state["email"] = "error"
                errors.append(f"email to {uid}: {type(exc).__name__}: {exc}")
        state["name"] = person.name
        deliveries[uid] = state

    complete = all(
        d.get("in_app") and str(d.get("email") or "") in _EMAIL_OK for d in deliveries.values()
    ) and len(deliveries) >= len(recipients)
    status = "sent" if complete else "pending"
    patch: dict = {
        "status": status, "attempts": attempt, "deliveries": deliveries,
        "last_attempt_at": now, "updated_at": now,
        "last_error": "; ".join(errors) if errors else None,
    }
    if complete:
        patch["sent_at"] = now
    await db[C.OWNER_NOTICES].update_one({"_id": key}, {"$set": patch})
    await _audit_outcome(doc, status, attempt, deliveries, error="; ".join(errors) if errors else None)
    return {"event_key": key, "status": status, "recipients": len(recipients),
            "deliveries": deliveries, "attempt": attempt,
            **({"error": "; ".join(errors)} if errors else {})}


async def _audit_outcome(doc: Mapping[str, Any], status: str, attempt: int,
                         deliveries: Mapping[str, Any], error: str | None = None) -> None:
    try:
        actor = dict(doc.get("actor") or {})
        reference_type = str(doc.get("reference_type") or "card")
        await audit.record(
            actor=actor or {"uid": "", "name": "", "role": ""},
            action=audit.Action.OWNER_NOTIFIED if status in ("sent", "no_recipients")
            else audit.Action.OWNER_NOTICE_FAILED,
            # The subject is the NOTIFICATION, keyed on its event, so the
            # history of the recharge / card / freeze itself stays the story of
            # that record; `card_id` and `meta.reference` tie the two together.
            subject_type="owner_notice",
            subject_id=str(doc.get("_id") or ""),
            card_id=str(doc.get("reference") or "") if reference_type == "card" else None,
            reason=(
                f"Other Owners notified of {doc.get('action')}."
                if status == "sent" else
                f"No other active Owner to notify of {doc.get('action')}."
                if status == "no_recipients" else
                f"Other Owners could not all be notified of {doc.get('action')}: {error or 'see deliveries'}. "
                "The action stands; the notice is retried by the sweep."
            ),
            after={"status": status},
            meta={"event_key": str(doc.get("_id") or ""), "action": str(doc.get("action") or ""),
                  "reference_type": reference_type, "reference": str(doc.get("reference") or ""),
                  "attempt": attempt, "amount": doc.get("amount"),
                  "currency": str(doc.get("currency") or ""),
                  "deliveries": {k: {"in_app": bool(v.get("in_app")), "email": v.get("email")}
                                 for k, v in dict(deliveries).items()}},
        )
    except Exception:  # noqa: BLE001
        log.exception("owner notification audit entry for %s could not be written", doc.get("_id"))


async def pending(limit: int = 200) -> list[dict]:
    """Rows not yet fully delivered, oldest first. The CRM's retry queue."""
    cursor = (
        get_db()[C.OWNER_NOTICES]
        .find({"status": "pending"})
        .sort("created_at", 1)
        .limit(max(1, min(int(limit), 500)))
    )
    out = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        out.append(doc)
    return out


async def retry_pending(limit: int = 100, *, max_attempts: int | None = None) -> list[dict]:
    """Re-attempt every pending notification. Run by the sweep and by an Owner.

    Returns one row per notification retried, in the shape the transactional
    sweep reports (`outcome` = `sent` | `failed`).
    """
    db = get_db()
    rows: list[dict] = []
    cursor = db[C.OWNER_NOTICES].find({"status": "pending"}).sort("created_at", 1).limit(max(1, min(int(limit), 500)))
    async for doc in cursor:
        if max_attempts is not None and int(doc.get("attempts") or 0) >= max_attempts:
            continue
        try:
            result = await _attempt(db, doc)
        except Exception as exc:  # noqa: BLE001
            log.exception("Owner notification retry for %s failed", doc.get("_id"))
            rows.append({"event_key": str(doc.get("_id")), "outcome": str(mail.Outcome.FAILED),
                         "error": f"{type(exc).__name__}: {exc}"})
            continue
        rows.append({
            "event_key": result["event_key"],
            "outcome": str(mail.Outcome.SENT) if result["status"] in ("sent", "no_recipients")
            else str(mail.Outcome.FAILED),
            "status": result["status"],
            "error": result.get("error"),
        })
    return rows


def stale_cutoff() -> datetime:
    """A pending row older than this is one the retries have not fixed."""
    return _now() - timedelta(minutes=int(settings.alert_owner_notice_pending_minutes))
