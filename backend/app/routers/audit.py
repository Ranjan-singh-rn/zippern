"""Audit log — read only, scoped by role. Spec 6.3."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from app.core import audit as svc
from app.core import roles as R
from app.core.deps import current_user, require_internal

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
async def read_log(
    action: str | None = Query(default=None),
    actor_uid: str | None = Query(default=None),
    subject_type: str | None = Query(default=None),
    subject_id: str | None = Query(default=None),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    skip: int = Query(default=0, ge=0),
    user: dict = Depends(require_internal),
):
    """Owners and the observer see everything, including each other.
    A team admin sees their team. Everyone else sees themselves."""
    filters: dict = {}
    if action:
        filters["action"] = action
    if subject_type:
        filters["subject.type"] = subject_type
    if subject_id:
        filters["subject.id"] = subject_id
    if actor_uid and R.can_read_all(user["role"]):
        filters["actor.uid"] = actor_uid
    if since or until:
        window: dict = {}
        if since:
            window["$gte"] = since
        if until:
            window["$lte"] = until
        filters["at"] = window

    return await svc.query(
        scope=R.audit_scope(user["role"]),
        actor_uid=user["uid"],
        actor_team=user.get("team"),
        filters=filters,
        limit=limit,
        skip=skip,
    )


@router.get("/history/{subject_type}/{subject_id}")
async def record_history(
    subject_type: str,
    subject_id: str,
    limit: int = Query(default=200, le=500),
    user: dict = Depends(require_internal),
):
    """Everything that ever happened to one record, and who did it.

    ── WHY A TEAM ADMIN IS NOW SCOPED HERE ──────────────────────────────────

    The gate was `can_read_all or is_team_admin` and the query took no scope at
    all, so any department admin could ask for ANY subject. On a `staff` subject
    that is the widest compensation read in the system: `set_employment` writes
    the salary figures into the entry's `before`/`after`, so
    `GET /audit/history/staff/{uid}` handed a marketing admin the full
    employment history — amounts included — of anybody in any department, owners
    among them.

    A department admin is now held to the people they actually manage, which is
    the same question `staff.manages()` answers for listing, editing and
    revoking. One definition of "yours", four places that use it.

    Other subject types are unchanged: a card, a partner, an agency is business
    history a team admin is entitled to read.
    """
    if R.can_read_all(user["role"]):
        return await svc.history_for(subject_type, subject_id, limit)
    if not R.is_team_admin(user["role"]):
        return []

    if subject_type == "staff":
        # The only subject whose history carries pay. Resolved against the live
        # record rather than against the entries, because the entries are the
        # thing being protected.
        from app.db.mongo import C, get_db
        from app.services import staff as staff_svc

        person = await get_db()[C.STAFF].find_one({"uid": subject_id})
        if person is None or not staff_svc.manages(user, person):
            return []

    return await svc.history_for(subject_type, subject_id, limit)
