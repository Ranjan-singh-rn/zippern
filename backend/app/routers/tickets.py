"""Ticket workflows — the only writer of team, feedback and support tickets (P1-D).

`require_write` on every route: internal, not the observer, never a partner
session (none of these routes is in `PARTNER_REACHABLE`). The service decides
which queue the caller may work (`tickets.may_work_team` / `may_triage`) and
derives every "who did this" field from the session and the Mongo staff row.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.deps import require_write
from app.services import tickets as svc
from app.services.tickets import TicketError

router = APIRouter(prefix="/tickets", tags=["tickets"])

_REQUEST_ID = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9_-]*$")


def _fail(exc: TicketError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


class TicketChange(BaseModel):
    changes: dict[str, Any]
    reason: str = Field(default="", max_length=2000)
    request_id: str = _REQUEST_ID


class NewTeamTicket(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=8000)
    category: str = "bug"
    priority: str = "medium"
    assignedTeam: str
    assignedTo: str = Field(default="", max_length=128)
    request_id: str = _REQUEST_ID


class RouteTicket(BaseModel):
    team: str
    note: str = Field(min_length=3, max_length=2000)
    assign_to: str = Field(default="", max_length=128)
    request_id: str = _REQUEST_ID


@router.post("/team", status_code=status.HTTP_201_CREATED)
async def create_team_ticket(body: NewTeamTicket, user: dict = Depends(require_write)):
    try:
        return await svc.create_team_ticket(body.model_dump(exclude={"request_id"}), user, body.request_id)
    except TicketError as exc:
        raise _fail(exc) from exc


@router.post("/{kind}/{ticket_id}/update")
async def update_ticket(kind: str, ticket_id: str, body: TicketChange, user: dict = Depends(require_write)):
    """`kind` ∈ team | feedback | support. Only allow-listed fields change."""
    try:
        return await svc.update(kind, ticket_id, body.changes, user, body.reason, body.request_id)
    except TicketError as exc:
        raise _fail(exc) from exc


@router.post("/support/{ticket_id}/route", status_code=status.HTTP_201_CREATED)
async def route_support_ticket(ticket_id: str, body: RouteTicket, user: dict = Depends(require_write)):
    try:
        return await svc.route_support_ticket(ticket_id, body.team, body.note, user,
                                              body.assign_to, body.request_id)
    except TicketError as exc:
        raise _fail(exc) from exc
