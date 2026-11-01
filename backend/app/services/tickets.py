"""Server-authoritative ticket workflows (P1-D).

Three Firestore collections carry the CRM's ticket work:

  * `techTickets`     — the cross-department Team Tickets board;
  * `feedbackTickets` — feedback an app user filed from the app;
  * `supportTickets`  — app support tickets (the /tickets triage).

Every privileged mutation of them used to be a browser `updateDoc`, with the
editor's name typed by the client (`statusChangedByName`, `assignedToName`,
`closedByName`), no audit entry and no notification. This module is now the
only writer: the CRM and the app call the routes in `routers/tickets.py`, and
`firestore.rules` refuses client writes to these documents (app users keep
CREATING their own feedback and support tickets).

For every mutation:

  * the actor is the verified session — uid, role, team and the NAME on their
    Mongo staff row; nothing about who acted is taken from the request;
  * only an allow-listed set of fields can change, each validated, and a state
    transition must be one the workflow has;
  * the AUDIT ENTRY IS WRITTEN FIRST, carrying before/after. If the Firestore
    write then fails, a `ticket.update_failed` entry follows. A mutation can
    therefore never land without an audit record; at worst an audit entry
    describes a change that a later entry says did not happen;
  * notices (in-app, `services/notices.deliver`) go to the affected people
    AFTER the write, keyed on the audit id, so a retry delivers once;
  * an optional `request_id` makes a retried call a no-op: the ticket keeps the
    last request id applied to it, and the same id again changes nothing.

Money is out of scope: no ticket operation touches a balance.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from app.core import audit
from app.core import roles as R
from app.core.roles import Role
from app.db import firebase
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)


class TicketError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


COLLECTION = {"team": "techTickets", "feedback": "feedbackTickets", "support": "supportTickets"}

TEAM_STATUSES = ("open", "in_progress", "review", "done")
TEAM_PRIORITIES = ("low", "medium", "high", "critical")
TEAM_CATEGORIES = ("bug", "feature", "content", "design", "testing", "support")
FEEDBACK_STATUSES = ("open", "assigned", "in_progress", "resolved", "closed")
FEEDBACK_PRIORITIES = ("low", "medium", "high", "urgent")
SUPPORT_STATUSES = ("open", "in_progress", "replied", "resolved", "closed")
# The App Tickets screen (`SupportTicketPriority`) uses `critical`; the feedback
# screens use `urgent`. Each allow-list matches the screen that writes it.
SUPPORT_PRIORITIES = ("low", "medium", "high", "critical")
TEAMS = tuple(str(t) for t in R.Team)


# ── Who may work which queue ──────────────────────────────────────────────────
#
# Team tickets: any member of staff who can write (the board is cross-
# department by design). Feedback and support triage: the people the Firestore
# rule admitted before this module existed — Owner, every department admin,
# Ops and Support — so moving the writes server-side changes WHO can act on
# nobody's ticket. The observer reads nothing here (no Firebase login) and is
# refused writes by `require_write` on the routes.

def _role(actor: dict) -> Role | None:
    try:
        return Role(str(actor.get("role", "")))
    except ValueError:
        return None


def may_work_team(actor: dict) -> bool:
    role = _role(actor)
    return role is not None and R.is_internal(role) and R.can_write(role)


def may_triage(actor: dict) -> bool:
    role = _role(actor)
    if role is None or not R.is_internal(role) or not R.can_write(role):
        return False
    return (
        R.is_owner(role)
        or R.is_team_admin(role)
        or str(role).startswith("ops_")
        or str(role).startswith("support_")
    )


# ── Staff identity, from the authoritative row ────────────────────────────────

async def _staff_row(uid: str) -> dict | None:
    if not uid:
        return None
    return await get_db()[C.STAFF].find_one({"uid": uid})


async def _actor_name(actor: dict) -> str:
    row = await _staff_row(str(actor.get("uid", "")))
    return str((row or {}).get("name") or actor.get("name") or actor.get("email") or "Zipper staff")


async def _assignee(uid: str, *, team: str | None) -> dict:
    """An assignee must be an ACTIVE staff member (of `team`, when given)."""
    row = await _staff_row(uid)
    if row is None or not row.get("is_active", True):
        raise TicketError("That assignee is not an active member of staff.")
    if team:
        row_team = str(row.get("team") or "")
        if str(row.get("role")) != str(Role.OWNER) and row_team != team:
            raise TicketError(f"That person is not in the {team} team.")
    return row


async def _team_admins(team: str) -> list[str]:
    out: list[str] = []
    async for row in get_db()[C.STAFF].find({"role": f"{team}_admin", "is_active": True}):
        if row.get("uid"):
            out.append(str(row["uid"]))
    return out


# ── Firestore access (sync client, run off the loop) ──────────────────────────

def _ref(kind: str, ticket_id: str):
    if kind not in COLLECTION:
        raise TicketError("Unknown ticket queue.", 404)
    tid = (ticket_id or "").strip()
    if not tid or "/" in tid:
        raise TicketError("Unknown ticket.", 404)
    return firebase.firestore_client().collection(COLLECTION[kind]).document(tid)


async def _read(kind: str, ticket_id: str) -> dict:
    snap = await asyncio.to_thread(_ref(kind, ticket_id).get)
    if not getattr(snap, "exists", False):
        raise TicketError("That ticket no longer exists.", 404)
    return dict(snap.to_dict() or {})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean(v: Any, *, max_len: int) -> str:
    s = str(v or "").strip()
    if len(s) > max_len:
        raise TicketError(f"Too long (at most {max_len} characters).")
    return s


def _require_reason(reason: str, what: str) -> str:
    r = (reason or "").strip()
    if len(r) < 3:
        raise TicketError(f"A reason is required to {what}.")
    if len(r) > 2000:
        raise TicketError("The reason is too long.")
    return r


# ── The patch builders: allow-list, validation, transitions ───────────────────

async def _team_patch(before: dict, changes: dict, actor: dict, reason: str) -> tuple[dict, list[str], str]:
    """Return (patch, events, reason-used). `events` name what happened, for notices."""
    patch: dict[str, Any] = {}
    events: list[str] = []
    allowed = {"status", "priority", "assignedTeam", "assignedTo", "title", "description",
               "category", "labels", "blockedBy"}
    unknown = set(changes) - allowed
    if unknown:
        raise TicketError(f"These fields cannot be changed here: {', '.join(sorted(unknown))}.")

    if "title" in changes:
        patch["title"] = _clean(changes["title"], max_len=200) or before.get("title", "")
    if "description" in changes:
        patch["description"] = _clean(changes["description"], max_len=8000)
    if "category" in changes:
        if changes["category"] not in TEAM_CATEGORIES:
            raise TicketError("Unknown category.")
        patch["category"] = changes["category"]
    if "labels" in changes:
        labels = changes["labels"]
        if not isinstance(labels, list) or len(labels) > 20:
            raise TicketError("Labels must be a short list.")
        patch["labels"] = [_clean(x, max_len=40) for x in labels if str(x).strip()]
    if "priority" in changes:
        if changes["priority"] not in TEAM_PRIORITIES:
            raise TicketError("Unknown priority.")
        patch["priority"] = changes["priority"]

    team = str(before.get("assignedTeam") or "")
    if "assignedTeam" in changes and changes["assignedTeam"] != team:
        new_team = str(changes["assignedTeam"] or "")
        if new_team not in TEAMS:
            raise TicketError("Unknown team.")
        reason = _require_reason(reason, "route a ticket to another team")
        patch["assignedTeam"] = new_team
        team = new_team
        events.append("routed")
        # A move to another team drops a person who is not in it.
        if "assignedTo" not in changes and before.get("assignedTo"):
            row = await _staff_row(str(before.get("assignedTo")))
            if row is None or str(row.get("team") or "") != new_team:
                patch["assignedTo"] = ""
                patch["assignedToName"] = ""

    if "assignedTo" in changes:
        uid = str(changes["assignedTo"] or "").strip()
        if uid and uid != before.get("assignedTo"):
            row = await _assignee(uid, team=team or None)
            patch["assignedTo"] = uid
            patch["assignedToName"] = str(row.get("name") or row.get("email") or "")
            events.append("assigned")
        elif not uid and before.get("assignedTo"):
            patch["assignedTo"] = ""
            patch["assignedToName"] = ""

    if "status" in changes:
        new = changes["status"]
        if new not in TEAM_STATUSES:
            raise TicketError("Unknown status.")
        old = str(before.get("status") or "open")
        if new != old:
            if new == "done":
                if before.get("blockedBy"):
                    raise TicketError("This ticket is blocked by another ticket. Clear the dependency first.")
                reason = _require_reason(reason, "close a ticket")
                events.append("closed")
            elif old == "done":
                reason = _require_reason(reason, "reopen a ticket")
                events.append("reopened")
            patch["status"] = new

    if "blockedBy" in changes:
        blocker = changes["blockedBy"]
        reason = _require_reason(reason, "change a ticket's dependency")
        if blocker:
            blocker = _clean(blocker, max_len=200)
            await _read("team", blocker)  # must exist
            patch["blockedBy"] = blocker
            patch["blockedReason"] = reason
            patch["blockedAt"] = _now()
        else:
            patch["blockedBy"] = None
            patch["blockedReason"] = f"Cleared: {reason}"
    return patch, events, reason


async def _feedback_patch(before: dict, changes: dict, actor: dict, reason: str) -> tuple[dict, list[str], str]:
    patch: dict[str, Any] = {}
    events: list[str] = []
    allowed = {"status", "priority", "assignedTo", "response"}
    unknown = set(changes) - allowed
    if unknown:
        raise TicketError(f"These fields cannot be changed here: {', '.join(sorted(unknown))}.")
    name = await _actor_name(actor)

    if "priority" in changes:
        if changes["priority"] not in FEEDBACK_PRIORITIES:
            raise TicketError("Unknown priority.")
        patch["priority"] = changes["priority"]
    if "assignedTo" in changes:
        target = str(changes["assignedTo"] or "").strip()
        uid = str(actor["uid"]) if target in ("", "me") else target
        row = await _assignee(uid, team=None)
        patch.update({
            "assignedTo": str(row.get("email") or uid),   # the CRM's existing key shape
            "assignedToUid": uid,
            "assignedToName": str(row.get("name") or row.get("email") or ""),
            "assignedAt": _now(),
        })
        if str(before.get("status") or "open") == "open":
            patch["status"] = "assigned"
        events.append("assigned")
    if "response" in changes:
        response = _clean(changes["response"], max_len=8000)
        if len(response) < 10:
            raise TicketError("Write a response of at least 10 characters.")
        patch["response"] = response
        changes = {**changes, "status": "resolved"}
        reason = reason.strip() or response
        events.append("answered")
    if "status" in changes:
        new = changes["status"]
        if new not in FEEDBACK_STATUSES:
            raise TicketError("Unknown status.")
        if new != str(before.get("status") or "open") or "response" in changes:
            reason = _require_reason(reason, "change a ticket's status")
            patch["status"] = new
            patch["statusNote"] = reason
            if new in ("resolved", "closed"):
                patch["resolvedAt"] = _now()
                events.append("closed")
    if patch:
        patch["statusChangedAt"] = _now()
        patch["statusChangedByName"] = name
        patch["statusChangedByUid"] = str(actor["uid"])
    return patch, events, reason


async def _support_patch(before: dict, changes: dict, actor: dict, reason: str) -> tuple[dict, list[str], str]:
    patch: dict[str, Any] = {}
    events: list[str] = []
    allowed = {"status", "priority", "assignedTo", "adminReply"}
    unknown = set(changes) - allowed
    if unknown:
        raise TicketError(f"These fields cannot be changed here: {', '.join(sorted(unknown))}.")
    name = await _actor_name(actor)

    if "priority" in changes:
        if changes["priority"] not in SUPPORT_PRIORITIES:
            raise TicketError("Unknown priority.")
        patch["priority"] = changes["priority"]
    if "assignedTo" in changes:
        target = str(changes["assignedTo"] or "").strip()
        if target == "me":
            target = str(actor["uid"])
        if not target:
            # "Unassigned" in the App Tickets screen: clear it, status unchanged.
            if before.get("assignedTo"):
                patch.update({"assignedTo": "", "assignedToName": ""})
        elif target != before.get("assignedTo"):
            row = await _assignee(target, team=None)
            patch.update({"assignedTo": target, "assignedToName": str(row.get("name") or row.get("email") or ""),
                          "status": "in_progress"})
            events.append("assigned")
    if "adminReply" in changes:
        reply = _clean(changes["adminReply"], max_len=8000)
        if len(reply) < 3:
            raise TicketError("Write a reply first.")
        patch.update({"adminReply": reply, "status": "replied", "repliedAt": _now(),
                      "repliedByName": name})
        events.append("answered")
    if "status" in changes and "adminReply" not in changes:
        new = changes["status"]
        if new not in SUPPORT_STATUSES:
            raise TicketError("Unknown status.")
        if new != str(before.get("status") or "open"):
            if new == "closed":
                reason = _require_reason(reason, "close a ticket")
                patch.update({"closeReason": reason, "closedAt": _now(), "closedByName": name})
                events.append("closed")
            elif str(before.get("status")) == "closed":
                reason = _require_reason(reason, "reopen a ticket")
                events.append("reopened")
            patch["status"] = new
    return patch, events, reason


_BUILDERS = {"team": _team_patch, "feedback": _feedback_patch, "support": _support_patch}


def _authorise(kind: str, actor: dict) -> None:
    ok = may_work_team(actor) if kind == "team" else may_triage(actor)
    if not ok:
        raise TicketError("Your account may not work this ticket queue.", 403)


# ── Public operations ─────────────────────────────────────────────────────────

async def update(kind: str, ticket_id: str, changes: dict, actor: dict,
                 reason: str = "", request_id: str = "") -> dict:
    """Apply an allow-listed change to one ticket. Audit first, notices last."""
    _authorise(kind, actor)
    if not isinstance(changes, dict) or not changes:
        raise TicketError("Nothing to change.")
    before = await _read(kind, ticket_id)
    if request_id and before.get("lastRequestId") == request_id:
        return {"id": ticket_id, **_serialisable(before), "replayed": True}

    patch, events, used_reason = await _BUILDERS[kind](before, changes, actor, reason)
    if not patch:
        raise TicketError("That is already what the ticket says.")
    patch["updatedAt"] = _now()
    if request_id:
        patch["lastRequestId"] = request_id

    shown_before = {k: before.get(k) for k in patch if k not in ("updatedAt", "lastRequestId")}
    shown_after = {k: v for k, v in patch.items() if k not in ("updatedAt", "lastRequestId")}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.TICKET_UPDATED,
        subject_type=f"ticket.{kind}",
        subject_id=ticket_id,
        reason=used_reason or f"Updated {kind} ticket",
        before=_serialisable(shown_before),
        after=_serialisable(shown_after),
        meta={"events": events, "collection": COLLECTION[kind]},
    )
    try:
        await asyncio.to_thread(_ref(kind, ticket_id).update, patch)
    except Exception as exc:  # noqa: BLE001
        await _record_failure(actor, kind, ticket_id, str(audit_id), exc)
        raise TicketError("The ticket could not be saved. Nothing changed; try again.", 503) from exc

    after = {**before, **patch}
    notified = await _notify(kind, ticket_id, before, after, events, str(audit_id))
    return {"id": ticket_id, **_serialisable(after), "audit_id": str(audit_id), "notified": notified}


async def create_team_ticket(body: dict, actor: dict, request_id: str = "") -> dict:
    """File a Team Ticket. The reporter is the session, never the form."""
    _authorise("team", actor)
    title = _clean(body.get("title"), max_len=200)
    if len(title) < 3:
        raise TicketError("A title of at least 3 characters is required.")
    description = _clean(body.get("description"), max_len=8000)
    category = body.get("category") or "bug"
    priority = body.get("priority") or "medium"
    team = str(body.get("assignedTeam") or "")
    if category not in TEAM_CATEGORIES or priority not in TEAM_PRIORITIES or team not in TEAMS:
        raise TicketError("Choose a valid category, priority and team.")
    assignee_uid = str(body.get("assignedTo") or "").strip()
    assignee = await _assignee(assignee_uid, team=team) if assignee_uid else None
    name = await _actor_name(actor)
    role = _role(actor)
    now = _now()
    doc = {
        "title": title, "description": description, "category": category, "priority": priority,
        "status": "open", "source": "crm", "assignedTeam": team,
        "assignedTo": assignee_uid, "assignedToName": str((assignee or {}).get("name") or ""),
        "reportedBy": name, "reportedByUid": str(actor["uid"]),
        "reportedByDept": str(R.team_of(role)) if role and R.team_of(role) else "",
        "labels": [], "attachmentUrls": [], "createdAt": now, "updatedAt": now,
    }
    # Unassigned: the team's admins are told it needs an owner.
    return await _create("team", doc, actor, request_id, events=["created", "assigned" if assignee_uid else "routed"])


async def route_support_ticket(ticket_id: str, team: str, note: str, actor: dict,
                               assign_to: str = "", request_id: str = "") -> dict:
    """Escalate an app support ticket to a department: a linked Team Ticket."""
    _authorise("support", actor)
    if team not in TEAMS:
        raise TicketError("Unknown team.")
    note = _require_reason(note, "route a ticket")
    support = await _read("support", ticket_id)
    if support.get("linkedTeamTicketId"):
        raise TicketError("This ticket has already been routed to a team.", 409)
    assignee = await _assignee(assign_to, team=team) if assign_to else None
    name = await _actor_name(actor)
    now = _now()
    message = str(support.get("message") or "")
    priority = str(support.get("priority") or "medium")
    priority = "critical" if priority == "urgent" else priority
    if priority not in TEAM_PRIORITIES:
        priority = "medium"
    doc = {
        "title": str(support.get("subject") or message[:60] or "Routed support ticket"),
        "description": f"{message}\n\n— Routed by Support: {note}",
        "category": "support", "priority": priority,
        "status": "open", "source": "app", "assignedTeam": team,
        "assignedTo": assign_to, "assignedToName": str((assignee or {}).get("name") or ""),
        "reportedBy": name, "reportedByUid": str(actor["uid"]), "reportedByDept": "support",
        "linkedSupportTicketId": ticket_id, "labels": [], "attachmentUrls": [],
        "createdAt": now, "updatedAt": now,
    }
    created = await _create("team", doc, actor, request_id, events=["created", "routed"] + (["assigned"] if assign_to else []))
    link = {"escalatedToTech": team == "tech", "escalatedTeam": team, "escalatedAt": now,
            "escalationNote": note, "linkedTeamTicketId": created["id"], "updatedAt": now}
    await audit.record(actor=actor, action=audit.Action.TICKET_ROUTED, subject_type="ticket.support",
                       subject_id=ticket_id, reason=note, before={"escalatedTeam": support.get("escalatedTeam")},
                       after={"escalatedTeam": team, "linkedTeamTicketId": created["id"]})
    try:
        await asyncio.to_thread(_ref("support", ticket_id).update, link)
    except Exception as exc:  # noqa: BLE001
        await _record_failure(actor, "support", ticket_id, "", exc)
        raise TicketError("The team ticket was created but the support ticket could not be linked. Try again.", 503) from exc
    return {"support_ticket_id": ticket_id, "team_ticket": created}


async def _create(kind: str, doc: dict, actor: dict, request_id: str, *, events: list[str]) -> dict:
    col = firebase.firestore_client().collection(COLLECTION[kind])
    ref = col.document(f"req_{request_id}") if request_id else col.document()
    if request_id:
        snap = await asyncio.to_thread(ref.get)
        if getattr(snap, "exists", False):
            return {"id": ref.id, **_serialisable(dict(snap.to_dict() or {})), "replayed": True}
    audit_id = await audit.record(actor=actor, action=audit.Action.TICKET_CREATED, subject_type=f"ticket.{kind}",
                                  subject_id=ref.id, reason=f"Filed: {doc.get('title', '')}"[:300],
                                  after=_serialisable({k: doc.get(k) for k in ("assignedTeam", "assignedTo", "priority", "status")}))
    try:
        await asyncio.to_thread(ref.set, doc)
    except Exception as exc:  # noqa: BLE001
        await _record_failure(actor, kind, ref.id, str(audit_id), exc)
        raise TicketError("The ticket could not be saved. Nothing changed; try again.", 503) from exc
    notified = await _notify(kind, ref.id, {}, doc, events, str(audit_id))
    return {"id": ref.id, **_serialisable(doc), "audit_id": str(audit_id), "notified": notified}


async def _record_failure(actor: dict, kind: str, ticket_id: str, audit_id: str, exc: Exception) -> None:
    try:
        await audit.record(actor=actor, action=audit.Action.TICKET_UPDATE_FAILED, subject_type=f"ticket.{kind}",
                           subject_id=ticket_id, reason="The ticket write did not land; the change above did not happen.",
                           meta={"error": str(exc)[:300], "audit_id": audit_id})
    except Exception:  # noqa: BLE001
        log.exception("could not audit a failed ticket write on %s/%s", kind, ticket_id)


# ── Notices ───────────────────────────────────────────────────────────────────

async def _notify(kind: str, ticket_id: str, before: dict, after: dict, events: list[str], audit_id: str) -> dict:
    """In-app notices to the people a change affects. Best effort, never raises."""
    from app.services import notices

    out: dict[str, bool] = {}
    title = str(after.get("title") or after.get("subject") or "a ticket")
    key = f"ticket_{kind}_{ticket_id}_{audit_id or 'x'}"

    async def send(uid: str, suffix: str, t: str, body: str, **meta: Any) -> None:
        if uid:
            out[f"{suffix}:{uid}"] = await notices.deliver(
                uid, f"{key}_{suffix}_{uid}"[:1400], type="ticket", title=t, body=body,
                meta={"queue": kind, "ticket_id": ticket_id, **meta},
            )

    if "assigned" in events:
        assignee = str(after.get("assignedToUid") or after.get("assignedTo") or "")
        if "@" not in assignee:
            await send(assignee, "assigned", "A ticket was assigned to you", f"“{title}” is now yours.")
    if kind == "team" and "routed" in events and not after.get("assignedTo"):
        for uid in await _team_admins(str(after.get("assignedTeam") or "")):
            await send(uid, "routed", "A ticket was routed to your team", f"“{title}” needs an owner.")
    if kind in ("feedback", "support") and "answered" in events:
        user = str(after.get("userId") or "")
        await send(user, "answered", "Zipper replied to your ticket",
                   "Open Messages → Feedback to read the reply.")
    return out


def _serialisable(d: dict) -> dict:
    out: dict = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, dict):
            out[k] = _serialisable(v)
        else:
            out[k] = v
    return out
