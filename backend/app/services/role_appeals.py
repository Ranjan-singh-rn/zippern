"""Reinstatement of a revoked role: the person asks, a reviewer recommends, the
Owner decides (C2 / B05).

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

A revoked role used to be indistinguishable from one that was never held: the
one-per-person slot was released and the app offered "Join as …" again, so the
way back was a fresh application that re-created the role as a NEW record. Now
a revoked role still counts (`partner_applications`, C1) and the way back is
this: a request naming the revoked role, a recommendation from somebody who
reviews that kind of role, and a decision only the Owner can make. Restoring
calls the existing restore for that role — `users.restore_host` for a Host,
`partner_ops.reactivate_partner` on the SAME record for an Agency, Sub-agency
or Coin Seller — so every rule those already apply (restricted account, live
agency, the role table) still applies, and nothing is duplicated.

── THE DATA ────────────────────────────────────────────────────────────────

Mongo `role_appeals`:

    { _id: "ra_<token>", uid, kind, record_id,
      status: pending | recommended | restored | kept_revoked,
      statement, created_at, updated_at,
      recommendation: {by_uid, by_role, outcome, note, at} | null,
      decision:       {by_uid, outcome, note, at} | null }

plus `revoked_at` / `revoked_reason` (what the reviewer is looking at),
`filed_by`, and `history` — every recommendation and the decision, appended.

One OPEN request per (uid, kind), held by `role_appeal_locks` with
`_id = "<uid>:<kind>"`: inserted at submit (a duplicate key means "already
open", and the open one is returned), deleted at the decision. No index is
added for any of it — `_id` is the lock.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.core import audit
from app.core import roles as R
from app.core.roles import Permission
from app.db import firebase
from app.db.mongo import get_db
from app.services import notices

log = logging.getLogger(__name__)

ROLE_APPEALS = "role_appeals"
ROLE_APPEAL_LOCKS = "role_appeal_locks"

KINDS = ("host", "agency", "sub_agency", "seller")
OPEN_STATUSES = ("pending", "recommended")
OUTCOMES = ("restore", "keep_revoked")

STATEMENT_MIN = 20
STATEMENT_MAX = 2000
NOTE_MIN = 10
NOTE_MAX = 2000

#: How long a decision in flight holds the request (a crash leaves at most this).
DECIDE_LEASE_SECONDS = 120
#: How long a lock whose request document is not visible yet counts as a
#: request being filed right now rather than one a crash left behind.
LOCK_SETTLE_SECONDS = 30

OWNER_ONLY_DECIDE = "Only the Owner can decide a reinstatement."

#: Account states that may not file — the restricted and the leaving.
_BARRED_STATES = frozenset(
    {"suspended", "banned", "deleted", "permanently_deactivated", "recovery_pending"}
)


class Act:
    """Audit actions this module writes."""

    SUBMITTED = "role_appeal.submitted"
    RECOMMENDED = "role_appeal.recommended"
    RESTORED = "role_appeal.restored"
    KEPT_REVOKED = "role_appeal.kept_revoked"


class RoleAppealError(Exception):
    """Refused by a rule. The message is safe to show the caller."""

    status_code = 400


class RoleAppealForbidden(RoleAppealError):
    """Refused because of who is asking."""

    status_code = 403


class RoleAppealNotFound(RoleAppealError):
    status_code = 404


class RoleAppealConflict(RoleAppealError):
    """The request moved under the caller — decided, or being decided."""

    status_code = 409


# ── Small helpers ─────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return str(isoformat())
        except Exception:  # noqa: BLE001
            return None
    return value if isinstance(value, str) and value else None


def _moment(value: Any) -> float:
    ts = getattr(value, "timestamp", None)
    if callable(ts):
        try:
            return float(ts())
        except Exception:  # noqa: BLE001
            return 0.0
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _who(actor: dict) -> dict:
    return {"uid": str(actor.get("uid", "")), "role": str(actor.get("role", ""))}


def _require_note(note: str) -> str:
    text = (note or "").strip()
    if len(text) < NOTE_MIN:
        raise RoleAppealError(
            f"Say why, in at least {NOTE_MIN} characters. The note is the record "
            "of this decision."
        )
    return text[:NOTE_MAX]


def _require_outcome(outcome: str) -> str:
    value = str(outcome or "").strip()
    if value not in OUTCOMES:
        raise RoleAppealError("An outcome must be 'restore' or 'keep_revoked'.")
    return value


def may_review(actor: dict, kind: str) -> bool:
    """Whose recommendation counts for this kind of role (C2).

    `can_approve_kyc` for a Host, an Agency and a Sub-agency; `can_approve_seller`
    for a Coin Seller; the Owner for all of them.
    """
    role = (actor or {}).get("role")
    if R.is_owner_value(role):
        return True
    needed = Permission.CAN_APPROVE_SELLER if kind == "seller" else Permission.CAN_APPROVE_KYC
    return R.has_permission(role, needed)


def public_view(doc: dict) -> dict[str, Any]:
    """What the person who asked is shown. No reviewer is named."""
    decision = doc.get("decision") or None
    return {
        "id": str(doc.get("_id") or ""),
        "uid": str(doc.get("uid") or ""),
        "kind": str(doc.get("kind") or ""),
        "record_id": str(doc.get("record_id") or ""),
        "status": str(doc.get("status") or ""),
        "statement": str(doc.get("statement") or ""),
        "created_at": _iso(doc.get("created_at")),
        "updated_at": _iso(doc.get("updated_at")),
        "decision": (
            {
                "outcome": str(decision.get("outcome") or ""),
                "note": str(decision.get("note") or ""),
                "at": _iso(decision.get("at")),
            }
            if isinstance(decision, dict) else None
        ),
    }


def staff_view(doc: dict) -> dict[str, Any]:
    """What a reviewer and the Owner see: the whole request."""
    recommendation = doc.get("recommendation") or None
    decision = doc.get("decision") or None
    return {
        **public_view(doc),
        "revoked_at": _iso(doc.get("revoked_at")),
        "revoked_reason": str(doc.get("revoked_reason") or ""),
        "filed_by": doc.get("filed_by") or {},
        "recommendation": (
            {**recommendation, "at": _iso(recommendation.get("at"))}
            if isinstance(recommendation, dict) else None
        ),
        "decision": (
            {**decision, "at": _iso(decision.get("at"))}
            if isinstance(decision, dict) else None
        ),
    }


def _read_user(uid: str) -> dict | None:
    """Blocking — `users/{uid}`, or None when there is no such account."""
    snap = firebase.firestore_client().collection("users").document(uid).get()
    if not getattr(snap, "exists", False):
        return None
    return snap.to_dict() or {}


def _barred(user: dict | None) -> bool:
    """Is this account restricted or leaving? Then it files nothing."""
    if user is None:
        return True
    state = str(user.get("accountState") or "").strip().lower()
    return (
        state in _BARRED_STATES
        or user.get("isBanned") is True
        or user.get("isSuspended") is True
    )


async def _revoked_role(uid: str, kind: str, user: dict, db) -> dict | None:
    """The revoked role of this kind, as `{record_id, revoked_at, reason}`, or None."""
    from app.services import partner_applications as apps  # local: apps imports this module
    from app.services import partner_roles

    if kind == "host":
        if apps.host_state(user) != "revoked":
            return None
        return {
            "record_id": uid,
            "revoked_at": user.get("hostRevokedAt") or user.get("hostRemovedAt"),
            "reason": str(user.get("hostRevokedReason") or ""),
        }
    rows = [
        r for r in await partner_roles.records_owned_by(uid, db=db)
        if str(r.get("kind") or "") == kind and str(r.get("status") or "") == "revoked"
    ]
    if not rows:
        return None
    latest = max(rows, key=lambda r: _moment(r.get("revoked_at")))
    return {
        "record_id": str(latest["_id"]),
        "revoked_at": latest.get("revoked_at"),
        "reason": str(latest.get("revocation_reason") or ""),
    }


# ── What the eligibility answer shows (C1) ────────────────────────────────────


async def appeal_summary(
    uid: str, kind: str, record_id: str | None = None, *, db=None
) -> dict[str, str] | None:
    """`{id, status}` of the OPEN request for this role, else the latest, else None.

    `db` is the caller's handle, so `partner_applications` reads through the
    same one it was given.
    """
    handle = db if db is not None else get_db()
    try:
        rows = [r async for r in handle[ROLE_APPEALS].find({"uid": uid, "kind": kind})]
    except Exception:  # noqa: BLE001 — eligibility still answers without it
        log.warning("role appeals of %s could not be read", uid)
        return None
    if record_id:
        named = [r for r in rows if str(r.get("record_id") or "") == str(record_id)]
        rows = named or rows
    if not rows:
        return None
    rows.sort(key=lambda r: _moment(r.get("created_at")), reverse=True)
    open_rows = [r for r in rows if str(r.get("status") or "") in OPEN_STATUSES]
    pick = (open_rows or rows)[0]
    return {"id": str(pick["_id"]), "status": str(pick.get("status") or "")}


# ── Filing ────────────────────────────────────────────────────────────────────

_SETTLING = object()


async def _open_appeal_for_lock(db, lock_id: str):
    """The open request behind an existing lock — or `_SETTLING` while one is
    being written, or None once a stale lock has been cleared."""
    lock = await db[ROLE_APPEAL_LOCKS].find_one({"_id": lock_id})
    if lock is None:
        return None
    appeal = await db[ROLE_APPEALS].find_one({"_id": str(lock.get("appeal_id") or "")})
    if appeal is not None and str(appeal.get("status") or "") in OPEN_STATUSES:
        return appeal
    if appeal is None and _now().timestamp() - _moment(lock.get("created_at")) < LOCK_SETTLE_SECONDS:
        return _SETTLING
    # Decided, or never written: the lock is left over. Cleared conditionally,
    # so a lock somebody else has just re-taken is not removed.
    await db[ROLE_APPEAL_LOCKS].delete_one({"_id": lock_id, "appeal_id": lock.get("appeal_id")})
    return None


async def submit(uid: str, kind: str, statement: str, actor: dict) -> dict[str, Any]:
    """File a reinstatement request for one revoked role. Idempotent.

    Returns `{"appeal": <public view>, "existing": bool}` — `existing` is True
    when a request for this role was already open and is returned unchanged.
    """
    uid = str(uid or "").strip()
    kind = str(kind or "").strip()
    if not uid:
        raise RoleAppealError("A signed-in user is required.")
    if kind not in KINDS:
        raise RoleAppealError(
            "Choose the role to reinstate: Host, Agency, Sub-agency or Coin Seller."
        )
    text = (statement or "").strip()
    if not STATEMENT_MIN <= len(text) <= STATEMENT_MAX:
        raise RoleAppealError(
            f"Explain why the role should be reinstated, in {STATEMENT_MIN} to "
            f"{STATEMENT_MAX} characters."
        )

    user = await asyncio.to_thread(_read_user, uid)
    if user is None:
        raise RoleAppealError("Your account could not be found. Sign in again and retry.")
    if _barred(user):
        raise RoleAppealError(
            "This account is restricted, so a reinstatement cannot be requested "
            "until the restriction is lifted."
        )

    db = get_db()
    revoked = await _revoked_role(uid, kind, user, db)
    label = notices.role_label(kind)
    if revoked is None:
        raise RoleAppealError(f"There is no revoked {label} role on this account to reinstate.")

    # RC (confirmed): after a decision, another request needs new evidence or
    # a valid reason — a request that repeats one already decided for THIS
    # revocation is refused. The decided requests are kept untouched.
    from app.services import appeal_policy  # local: a leaf module

    decided_statements: list[str] = []
    async for prev in db[ROLE_APPEALS].find({"uid": uid, "kind": kind, "record_id": revoked["record_id"]}):
        if str(prev.get("status") or "") == "pending":
            continue
        same_revocation = (
            revoked.get("revoked_at") is None
            or prev.get("revoked_at") is None
            or _moment(prev.get("revoked_at")) == _moment(revoked.get("revoked_at"))
        )
        if same_revocation and str(prev.get("status") or "") == "kept_revoked":
            decided_statements.append(str(prev.get("statement") or ""))
    problem = appeal_policy.reappeal_problem(decided_statements, text, 0)
    if problem:
        raise RoleAppealError(problem)

    lock_id = f"{uid}:{kind}"
    appeal_id = "ra_" + secrets.token_urlsafe(12)
    now = _now()
    taken = False
    for _ in range(12):
        try:
            await db[ROLE_APPEAL_LOCKS].insert_one(
                {"_id": lock_id, "appeal_id": appeal_id, "uid": uid, "kind": kind, "created_at": now}
            )
            taken = True
            break
        except DuplicateKeyError:
            pass
        existing = await _open_appeal_for_lock(db, lock_id)
        if existing is _SETTLING:
            # A request for this role is being written this instant (a double
            # tap, a retried call). Wait for it rather than refuse.
            await asyncio.sleep(0.05)
            continue
        if existing is not None:
            return {"appeal": public_view(existing), "existing": True}
    if not taken:
        raise RoleAppealConflict(
            "A request for this role is being filed right now. Try again in a moment."
        )

    doc = {
        "_id": appeal_id,
        "uid": uid,
        "kind": kind,
        "record_id": revoked["record_id"],
        "status": "pending",
        "statement": text,
        "created_at": now,
        "updated_at": now,
        "recommendation": None,
        "decision": None,
        "revoked_at": revoked.get("revoked_at"),
        "revoked_reason": revoked.get("reason") or "",
        "filed_by": _who(actor),
        "history": [{"event": "submitted", "at": now, "by": _who(actor)}],
    }
    try:
        await db[ROLE_APPEALS].insert_one(doc)
    except Exception:
        await db[ROLE_APPEAL_LOCKS].delete_one({"_id": lock_id, "appeal_id": appeal_id})
        raise

    await audit.record(
        actor=actor,
        action=Act.SUBMITTED,
        subject_type="role_appeal",
        subject_id=appeal_id,
        reason=f"Reinstatement requested for a revoked {label} role.",
        before=None,
        after={"status": "pending", "kind": kind, "record_id": revoked["record_id"]},
        meta={"uid": uid, "kind": kind, "record_id": revoked["record_id"]},
    )
    return {"appeal": public_view(doc), "existing": False}


async def list_of(uid: str) -> dict[str, Any]:
    """`{"appeals": [...]}` for one person, newest first (public view)."""
    uid = str(uid or "").strip()
    rows = [r async for r in get_db()[ROLE_APPEALS].find({"uid": uid})]
    rows.sort(key=lambda r: _moment(r.get("created_at")), reverse=True)
    return {"appeals": [public_view(r) for r in rows]}


async def list_for_staff(actor: dict, status: str = "open", limit: int = 200) -> dict[str, Any]:
    """`{"appeals": [...]}` the caller may review, oldest first (staff view)."""
    kinds = [k for k in KINDS if may_review(actor, k)]
    if not kinds:
        raise RoleAppealForbidden("Your account cannot review reinstatement requests.")
    query: dict[str, Any] = {"kind": {"$in": kinds}}
    if str(status or "open") != "all":
        query["status"] = {"$in": list(OPEN_STATUSES)}
    rows = [r async for r in get_db()[ROLE_APPEALS].find(query)]
    rows.sort(key=lambda r: _moment(r.get("created_at")))
    return {"appeals": [staff_view(r) for r in rows[: max(1, min(int(limit), 500))]]}


# ── Owner notification ────────────────────────────────────────────────────────


async def email_owners(
    *, kind: str, subject: str, title: str, rows: list[tuple[str, Any]], dedupe_key: str,
) -> dict[str, Any]:
    """Tell the Owners by email, through the existing delivery path. Never raises.

    Recipients are the active Owner staff records (`notify.staff_with_roles`),
    the mail goes through `email.deliver` — recorded in the delivery log,
    gated by role, deduplicated on `dedupe_key` — and what happened is
    returned so the caller can say so. The audit entry the caller writes is
    the notification of record; this is the nudge.
    """
    try:
        from app.core.roles import Role
        from app.services import email as email_svc
        from app.services import notify

        owners = await notify.staff_with_roles([Role.OWNER])
        if not owners:
            return {"sent": 0, "outcomes": [], "note": "No active Owner record carries an email address."}
        html = email_svc.page(title=title, preheader=title, body=email_svc.facts(rows))
        outcomes = []
        for recipient in owners:
            row = await email_svc.deliver(
                kind=kind,
                spec="C2/C3",
                recipient=recipient,
                subject=subject,
                html=html,
                sensitivity=email_svc.Sensitivity.OPERATIONAL,
                dedupe_key=f"{dedupe_key}:{recipient.uid or recipient.email}",
                meta={"dedupe": dedupe_key},
            )
            outcomes.append(str(row.get("outcome") or ""))
        return {"sent": sum(1 for o in outcomes if o == "sent"), "outcomes": outcomes}
    except Exception as exc:  # noqa: BLE001 — the audit entry stands on its own
        log.warning("Owner email for %s was not sent: %s", dedupe_key, exc)
        return {"sent": 0, "outcomes": [], "note": f"Owner email not sent: {exc}"}


# ── Recommending ──────────────────────────────────────────────────────────────


async def recommend(appeal_id: str, outcome: str, note: str, actor: dict) -> dict[str, Any]:
    """A reviewer of this kind of role recommends restore or keep_revoked.

    Conditional on the status read (pending or recommended), so a request
    decided in the meantime is not reopened. The Owners are told: the audit
    entry `role_appeal.recommended`, and an email through the existing helper.
    """
    outcome = _require_outcome(outcome)
    text = _require_note(note)
    db = get_db()
    appeal = await db[ROLE_APPEALS].find_one({"_id": str(appeal_id or "").strip()})
    if appeal is None:
        raise RoleAppealNotFound("No reinstatement request with that id.")
    kind = str(appeal.get("kind") or "")
    label = notices.role_label(kind)
    if not may_review(actor, kind):
        raise RoleAppealForbidden(f"Your account cannot review a {label} reinstatement.")
    status = str(appeal.get("status") or "")
    if status not in OPEN_STATUSES:
        raise RoleAppealConflict(f"This request is already {status.replace('_', ' ')}.")

    now = _now()
    recommendation = {
        "by_uid": str(actor.get("uid", "")),
        "by_role": str(actor.get("role", "")),
        "outcome": outcome,
        "note": text,
        "at": now,
    }
    updated = await db[ROLE_APPEALS].find_one_and_update(
        {"_id": appeal["_id"], "status": status},
        {
            "$set": {"status": "recommended", "recommendation": recommendation, "updated_at": now},
            "$push": {"history": {"event": "recommended", "at": now, "by": _who(actor),
                                  "outcome": outcome, "note": text}},
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise RoleAppealConflict("This request changed while you were reviewing it. Reload it.")

    await audit.record(
        actor=actor,
        action=Act.RECOMMENDED,
        subject_type="role_appeal",
        subject_id=str(appeal["_id"]),
        reason=text,
        before={"status": status},
        after={"status": "recommended", "outcome": outcome},
        meta={"uid": appeal.get("uid"), "kind": kind, "record_id": appeal.get("record_id"),
              "notify": "owners"},
    )
    email = await email_owners(
        kind="role_appeal.recommended",
        subject=f"Reinstatement recommended: {label} — {outcome.replace('_', ' ')}",
        title=f"A {label} reinstatement is waiting for your decision",
        rows=[
            ("Request", str(appeal["_id"])),
            ("Role", label),
            ("Record", str(appeal.get("record_id") or "")),
            ("Recommendation", outcome.replace("_", " ")),
            ("Note", text),
            ("Recommended by", str(actor.get("name") or actor.get("uid") or "")),
        ],
        dedupe_key=f"role_appeal.recommended:{appeal['_id']}:{_iso(now)}",
    )
    return {"appeal": staff_view(updated), "owner_notified": {"audit": Act.RECOMMENDED, "email": email}}


# ── Deciding ──────────────────────────────────────────────────────────────────


def _lease_fresh(at: Any) -> bool:
    moment = _moment(at)
    return bool(moment) and (_now().timestamp() - moment) < DECIDE_LEASE_SECONDS


async def _restore(appeal: dict, note: str, actor: dict) -> dict[str, Any]:
    """Run the EXISTING restore for this role, with the Owner as actor."""
    kind = str(appeal.get("kind") or "")
    uid = str(appeal.get("uid") or "")
    record_id = str(appeal.get("record_id") or "")
    if kind == "host":
        from app.services import users as users_svc  # local: users imports this module's peers

        try:
            result = await users_svc.restore_host(uid, note, actor)
        except users_svc.UserError as exc:
            raise RoleAppealError(f"The Host role could not be restored: {exc}") from exc
        return {"kind": kind, "record_id": uid, "result": result}

    from app.services import partner_ops  # local: partner_ops imports this module's peers

    try:
        result = await partner_ops.reactivate_partner(record_id, note, actor)
    except partner_ops.PartnerOpsError as exc:
        raise RoleAppealError(
            f"The {notices.role_label(kind)} role could not be restored: {exc}"
        ) from exc
    return {"kind": kind, "record_id": record_id, "result": result}


#: FX-13 (RF-20) — what a request closed by a direct restore says.
CLOSED_BY_DIRECT_RESTORE = (
    "The role was restored directly by the Owner, so this request is closed. Nothing else changed."
)
MOOT_KEEP_REVOKED = (
    "This role is no longer revoked — it was restored directly — so there is nothing to keep "
    "revoked. The request has been closed as restored; nothing else changed."
)


async def close_after_direct_restore(uid: str, kind: str, actor: dict) -> list[str]:
    """FX-13 (RF-20) — a role restored WITHOUT its reinstatement request closes the request.

    The Owner can restore a revoked role directly (`restore_host`,
    `reactivate_partner`). The person's open request stayed open beside it, and
    "keep revoked" on it later closed it with a notice saying the role was
    still revoked — about a role that was live. Called by both restore paths;
    a request that is being decided right now (it holds a decision lease —
    `decide` restoring through those same paths) is left to that decision.

    Best effort, after the restore: the restore has happened. Returns the ids
    it closed. No notice is sent — the restore sends its own.
    """
    uid = str(uid or "").strip()
    kind = str(kind or "").strip()
    if not uid or kind not in KINDS:
        return []
    closed: list[str] = []
    now = _now()
    try:
        db = get_db()
        rows = [r async for r in db[ROLE_APPEALS].find(
            {"uid": uid, "kind": kind, "status": {"$in": list(OPEN_STATUSES)}}
        )]
    except Exception:  # noqa: BLE001 — best effort: the restore has happened
        log.exception("Could not read the open reinstatement requests of %s (%s)", uid, kind)
        return []
    for row in rows:
        if row.get("deciding_token") and _lease_fresh(row.get("deciding_at")):
            continue  # being decided — `decide` closes it
        decision = {"by_uid": str(actor.get("uid", "")), "outcome": "restore",
                    "note": CLOSED_BY_DIRECT_RESTORE, "at": now, "via": "direct_restore"}
        try:
            done = await db[ROLE_APPEALS].find_one_and_update(
                {"_id": row["_id"], "status": row.get("status")},
                {
                    "$set": {"status": "restored", "decision": decision, "updated_at": now,
                             "deciding_token": None, "deciding_at": None},
                    "$push": {"history": {"event": "restored", "at": now, "by": _who(actor),
                                          "note": CLOSED_BY_DIRECT_RESTORE}},
                },
                return_document=ReturnDocument.AFTER,
            )
        except Exception:  # noqa: BLE001
            log.exception("Could not close reinstatement request %s", row.get("_id"))
            continue
        if done is None:
            continue
        await db[ROLE_APPEAL_LOCKS].delete_one({"_id": f"{uid}:{kind}", "appeal_id": row["_id"]})
        await audit.record(
            actor=actor,
            action=Act.RESTORED,
            subject_type="role_appeal",
            subject_id=str(row["_id"]),
            reason=CLOSED_BY_DIRECT_RESTORE,
            before={"status": row.get("status")},
            after={"status": "restored"},
            meta={"uid": uid, "kind": kind, "record_id": row.get("record_id"), "via": "direct_restore"},
        )
        closed.append(str(row["_id"]))
    return closed


async def decide(appeal_id: str, outcome: str, note: str, actor: dict) -> dict[str, Any]:
    """The Owner restores the role (the SAME record) or keeps it revoked.

    Anyone but the Owner is refused with 403. The request is claimed with a
    conditional update on its open status before anything is restored, so two
    decisions cannot both run; the lock is released and the person is told.
    """
    if not R.is_owner_value((actor or {}).get("role")):
        raise RoleAppealForbidden(OWNER_ONLY_DECIDE)
    outcome = _require_outcome(outcome)
    text = _require_note(note)
    db = get_db()
    appeal = await db[ROLE_APPEALS].find_one({"_id": str(appeal_id or "").strip()})
    if appeal is None:
        raise RoleAppealNotFound("No reinstatement request with that id.")
    status = str(appeal.get("status") or "")
    if status not in OPEN_STATUSES:
        raise RoleAppealConflict(f"This request was already decided ({status.replace('_', ' ')}).")
    if appeal.get("deciding_token") and _lease_fresh(appeal.get("deciding_at")):
        raise RoleAppealConflict("Another decision on this request is in progress. Reload it in a moment.")

    token = secrets.token_urlsafe(12)
    now = _now()
    claimed = await db[ROLE_APPEALS].find_one_and_update(
        {"_id": appeal["_id"], "status": status, "deciding_token": appeal.get("deciding_token")},
        {"$set": {"deciding_token": token, "deciding_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        raise RoleAppealConflict("This request changed while you were deciding it. Reload it.")

    kind = str(appeal.get("kind") or "")
    uid = str(appeal.get("uid") or "")

    # FX-13 (RF-20): "keep revoked" is a statement about the role NOW. When
    # it is not revoked any more (restored directly, without this request),
    # keeping it revoked is moot: the request is closed as restored, the
    # person is NOT told their role stays revoked, and the Owner is told why.
    if outcome == "keep_revoked":
        user = await asyncio.to_thread(_read_user, uid) or {}
        still = await _revoked_role(uid, kind, user, db)
        if still is None:
            moot = {"by_uid": str(actor.get("uid", "")), "outcome": "restore",
                    "note": MOOT_KEEP_REVOKED, "at": now, "via": "already_restored"}
            await db[ROLE_APPEALS].update_one(
                {"_id": appeal["_id"], "deciding_token": token},
                {
                    "$set": {"status": "restored", "decision": moot, "updated_at": now,
                             "deciding_token": None, "deciding_at": None},
                    "$push": {"history": {"event": "restored", "at": now, "by": _who(actor),
                                          "note": MOOT_KEEP_REVOKED}},
                },
            )
            await db[ROLE_APPEAL_LOCKS].delete_one({"_id": f"{uid}:{kind}", "appeal_id": appeal["_id"]})
            raise RoleAppealConflict(MOOT_KEEP_REVOKED)

    final = "restored" if outcome == "restore" else "kept_revoked"
    decision = {"by_uid": str(actor.get("uid", "")), "outcome": outcome, "note": text, "at": now}
    try:
        restored = await _restore(appeal, text, actor) if outcome == "restore" else None
        updated = await db[ROLE_APPEALS].find_one_and_update(
            {"_id": appeal["_id"], "deciding_token": token},
            {
                "$set": {"status": final, "decision": decision, "updated_at": now,
                         "deciding_token": None, "deciding_at": None},
                "$push": {"history": {"event": final, "at": now, "by": _who(actor), "note": text}},
            },
            return_document=ReturnDocument.AFTER,
        )
        if updated is None:
            raise RoleAppealConflict(
                "Another decision took this request over while it was being decided. Reload it."
            )
    except Exception:
        await db[ROLE_APPEALS].update_one(
            {"_id": appeal["_id"], "deciding_token": token},
            {"$set": {"deciding_token": None, "deciding_at": None}},
        )
        raise

    await db[ROLE_APPEAL_LOCKS].delete_one({"_id": f"{uid}:{kind}", "appeal_id": appeal["_id"]})

    await audit.record(
        actor=actor,
        action=Act.RESTORED if outcome == "restore" else Act.KEPT_REVOKED,
        subject_type="role_appeal",
        subject_id=str(appeal["_id"]),
        reason=text,
        before={"status": status},
        after={"status": final},
        meta={"uid": uid, "kind": kind, "record_id": appeal.get("record_id"),
              "recommendation": (appeal.get("recommendation") or {}).get("outcome")},
    )
    if outcome == "restore":
        notified = await notices.role_appeal_restored(
            uid, kind, str(appeal["_id"]), str(appeal.get("record_id") or "")
        )
    else:
        notified = await notices.role_appeal_kept_revoked(uid, kind, str(appeal["_id"]), text)
    return {
        "appeal": staff_view(updated),
        "restored": (
            {"kind": restored["kind"], "record_id": restored["record_id"]} if restored else None
        ),
        "notified": notified,
    }
