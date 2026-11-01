"""Staff endpoints.

── Who may change the team ───────────────────────────────────────────────────

`can_manage_team` is on all four writes here — inviting, changing a role,
setting employment details and revoking access. The CRM's own description of it
is "Invite, edit, deactivate CRM staff", which is those four exactly. It closes
two holes the audit named:

  * **`POST /staff` was `require_team_admin`**, which is any of the six
    department admins plus an owner. `finance_admin` and `tech_admin` do **not**
    hold `can_manage_team` in `zipper-crm/lib/auth.ts`, so the CRM hid the invite
    control from them and the API handed it over anyway. They are now refused,
    and `assignable_roles` continues to narrow what the remaining admins may
    hand out to members of their own department.
  * **`POST /staff/{uid}/deactivate` was `require_write`**, i.e. every staff
    role there is, while `PATCH /{uid}/role` right beside it is owner-only in
    the service. Revoking somebody's access is an authority change in the same
    sense granting it is — it is how an account stops being able to sign a card
    — so it is now at least as strict as a role change: `can_manage_team` on the
    door, and `services/staff.deactivate`'s existing owner / own-reports rules
    unchanged underneath.

`PATCH /{uid}/role` keeps its owner-only check in `services/staff.change_role`
and gains `can_manage_team` on top. The owner gate is not replaced by it and
must not be: every owner holds every permission, so a permission alone would be
a strictly weaker rule wearing a stricter name.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field

from app.core.deps import (
    current_user,
    require_owner_provisioner,
    require_permission,
    require_team_admin,
    require_write,
)
from app.core.roles import Permission, Role
from app.services import staff as svc
from app.services.staff import Invitation, StaffError

router = APIRouter(prefix="/staff", tags=["staff"])

#: Inviting, changing a role and revoking access are one capability, so they are
#: one object rather than three copies of a line.
_MANAGE_TEAM = Depends(require_permission(Permission.CAN_MANAGE_TEAM))


def _fail(exc: StaffError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


class InviteBody(BaseModel):
    email: EmailStr
    name: str = Field(min_length=2, max_length=120)
    role: Role
    phone: str = Field(default="", max_length=30)
    field_charge: str = Field(default="", max_length=120)


class RoleChange(BaseModel):
    role: Role
    reason: str = Field(min_length=3, max_length=500)


class Reason(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class EmploymentChange(BaseModel):
    """The business facts about a person, all optional, all set by somebody else.

    Every field is `None` by default and `None` means "leave it alone" — the
    route sends only what was supplied, so an owner editing a salary cannot
    accidentally blank an employment id that was not on the form.

    `salary_minor` is in the smallest currency unit, like every other money
    figure in this API. A rupee amount here would be the one float in the
    system, and payroll is not where to start keeping money in floats.
    """

    employment_id: str | None = Field(default=None, max_length=40)
    salary_minor: int | None = Field(default=None, ge=0)
    salary_currency: str | None = Field(default=None, min_length=3, max_length=3)
    joined_at: str | None = Field(default=None, max_length=40)
    field_charge: str | None = Field(default=None, max_length=120)
    reason: str = Field(min_length=3, max_length=500)


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    """The caller's own staff record — salary and employment id included.

    Takes no uid, so it cannot be pointed at anybody else. That is the whole of
    its access control and it is why this exists as a separate route rather than
    as a special case inside `GET /staff/{uid}`: salary must not be reachable by
    naming an id, and the surest way to guarantee that is not to accept one.

    Not on `PARTNER_REACHABLE`, so an agency or coin seller session is refused
    here by `current_user` before this function runs. They have no staff record;
    their profile is the partner document their dashboard already reads."""
    return await svc.read_own(user)


@router.get("/assignable-roles")
async def assignable_roles(user: dict = Depends(current_user)):
    """Which roles this person may hand out — drives the invite form."""
    return {"roles": [str(r) for r in svc.assignable_roles(user["role"])]}


@router.post(
    "", status_code=status.HTTP_201_CREATED, dependencies=[_MANAGE_TEAM]
)
async def invite(body: InviteBody, user: dict = Depends(require_team_admin)):
    """Invite a staff member. They receive a set-password link; no password is
    ever set or seen by the inviter.

    This is the only path that creates a staff account, and it creates **both**
    of the records one needs: the Mongo row this API authorises against, and the
    Firestore `crmUsers` document the CRM shell reads to resolve a role. A 400
    from here can mean the Mongo half was written and the Firestore half was
    not — the message says so explicitly and carries the command that repairs
    it. Show it verbatim."""
    try:
        return await svc.invite(
            Invitation(
                email=str(body.email),
                name=body.name,
                role=body.role,
                phone=body.phone,
                field_charge=body.field_charge,
            ),
            user,
        )
    except StaffError as exc:
        raise _fail(exc) from exc


class ProvisionOwnerBody(BaseModel):
    """An owner to provision. Note what is absent: a role.

    The observer cannot name one. The handler hardcodes `Role.OWNER`, so the
    only account this endpoint can produce is an owner — no department admin, no
    member, and not a second observer. That is the narrowing, expressed as the
    shape of the request rather than as a check somebody can forget.
    """

    email: EmailStr
    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(default="", max_length=30)
    reason: str = Field(min_length=3, max_length=500)


@router.post("/owners", status_code=status.HTTP_201_CREATED)
async def provision_owner(
    body: ProvisionOwnerBody,
    user: dict = Depends(require_owner_provisioner),
):
    """The observer provisions an owner. Its one and only write.

    ── WHY A SEPARATE ROUTE ─────────────────────────────────────────────────

    `POST /staff` is `require_write` + `can_manage_team`, and both refuse the
    observer: read-only by design (spec 1.1.4), holding none of the twenty
    capabilities. Letting it through there would have meant carving a hole in
    `require_write`, which guards every write the observer is deliberately kept
    away from.

    So this route stands alongside it with a guard of its own
    (`require_owner_provisioner` — the observer, and nothing else) and a body
    that cannot carry a role. The service is the same `invite`, which validates
    against `assignable_roles(OBSERVER)` — a list with exactly one entry. Three
    independent narrowings, and the observer still has no Firebase account and
    no `crmUsers` document.

    A reason is mandatory. Provisioning an owner is the most consequential
    account creation in the system and the audit entry has to say why.
    """
    try:
        return await svc.invite(
            Invitation(
                email=str(body.email),
                name=body.name,
                role=Role.OWNER,
                phone=body.phone,
                field_charge="",
            ),
            user,
            reason=body.reason,
        )
    except StaffError as exc:
        raise _fail(exc) from exc


@router.get("")
async def list_staff(
    include_inactive: bool = Query(default=False),
    user: dict = Depends(current_user),
):
    """Owners and observer see everyone; a team admin sees their own reports."""
    return await svc.list_staff(user, include_inactive)


@router.get("/overview")
async def overview(user: dict = Depends(current_user)):
    """Headcount per department."""
    return await svc.team_overview(user)


@router.patch("/{uid}/role", dependencies=[_MANAGE_TEAM])
async def change_role(uid: str, body: RoleChange, user: dict = Depends(require_write)):
    """Owners only — changing a role changes authority, and revokes any live
    session so the new role takes effect immediately.

    Both records move. A stale `crmUsers.role` means the shell shows one thing
    and this API enforces another.

    The owner check lives in `services/staff.change_role` and is untouched;
    `can_manage_team` is additional. Moving the owner check out here to a
    permission would have widened this route to five more roles."""
    try:
        return await svc.change_role(uid, body.role, user, body.reason)
    except StaffError as exc:
        raise _fail(exc) from exc


@router.patch("/{uid}/employment", dependencies=[_MANAGE_TEAM])
async def set_employment(
    uid: str,
    body: EmploymentChange,
    user: dict = Depends(require_team_admin),
):
    """Set somebody's salary, employment id, joining date or field charge.

    These are the fields `/profile` shows its holder as locked, and this is the
    route that unlocks them for the two people entitled to write them. The
    dependency is the outer gate — a team admin or an owner, never a member and
    never the observer — and the service applies the two rules that matter:

      * a team admin is scoped to their own direct reports;
      * pay is owners only, whoever the target is.

    A reason is mandatory and the change is audited with before and after, so a
    salary figure always has a name and a sentence attached to it."""
    try:
        return await svc.set_employment(
            uid,
            body.model_dump(exclude_none=True, exclude={"reason"}),
            user,
            body.reason,
        )
    except StaffError as exc:
        raise _fail(exc) from exc


@router.post("/{uid}/deactivate", dependencies=[_MANAGE_TEAM])
async def deactivate(uid: str, body: Reason, user: dict = Depends(require_write)):
    """Revoke access, in both places. The record is kept so history stays
    attributable.

    Revoking the API session alone stops nothing: `crmSignIn` reads
    `crmUsers.isActive`, and while that still says true the shell opens.

    This was `require_write` — every staff role, including the marketing member
    who could therefore switch off the finance admin. It is now `can_manage_team`
    like the two routes above it, on top of the service's own rules: an owner is
    deactivated only by an owner, and a team admin only reaches their own direct
    reports."""
    try:
        return await svc.deactivate(uid, user, body.reason)
    except StaffError as exc:
        raise _fail(exc) from exc


@router.post("/owners/{uid}/deactivate")
async def deactivate_owner(
    uid: str,
    body: Reason,
    user: dict = Depends(require_owner_provisioner),
):
    """Phase 1A (STAFF-001): the observer removes an Owner. Nobody else can.

    The counterpart of `POST /staff/owners`, behind the same observer-only
    guard. The service refuses the last active Owner (counted, not hardcoded)
    and revokes the login, the CRM directory entry and the storage claim
    exactly as for any other deactivation."""
    try:
        target = await svc.get_db()[svc.C.STAFF].find_one({"uid": uid})
        if target is None or str(target.get("role", "")) != str(Role.OWNER):
            raise StaffError("That account is not an owner.")
        return await svc.deactivate(uid, user, body.reason)
    except StaffError as exc:
        raise _fail(exc) from exc
