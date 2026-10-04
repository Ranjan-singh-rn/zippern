"""Staff management.

Spec 1.3.3 and Part 2.1. Owners invite anyone; a team admin invites members of
their own team only. Nobody sets a password — the invited person receives a
link and sets their own.

Every change is audited, because who has access is itself a governance record.

**A staff account is two records.** The Mongo row here is what the API reads to
authorise a call; a Firestore `crmUsers` document is what the CRM shell reads to
resolve a role and build navigation. An account with only the first can call the
API and cannot get past the CRM login. An account with only the second opens the
shell, renders every tab, and then reports that it cannot load data on every
API-backed screen — which is the failure this module now exists to make
impossible. Both halves are written here, by `app/services/crm_directory.py`,
which is the single implementation shared with `scripts/seed_accounts.py` and
`scripts/repair_staff_accounts.py`.

Order is deliberate and uniform: **Mongo first, Firestore second.** Of the two
ways a half-written account can fail, one is much better than the other. A staff
row with no `crmUsers` document refuses the CRM login outright with a message,
so nothing half-works and nobody is misled. A `crmUsers` document with no staff
row is the reported bug — the shell opens, the nav is complete, and every screen
that needs the API says it cannot load. So the authoritative record goes first
and the replica second, and a failure of the second is raised, audited as
`staff.mirror_failed`, and told to the caller with the repair command in the
message. It is never swallowed.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone

from firebase_admin import auth as fb_auth

from app.core import audit
from app.core import roles as R
from app.core.roles import Role
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import crm_directory as crm

log = logging.getLogger(__name__)


class StaffError(Exception):
    """Rejected by a staff rule. Safe to show the caller."""


@dataclass(slots=True)
class Invitation:
    email: str
    name: str
    role: Role
    phone: str = ""
    field_charge: str = ""


def manages(actor: dict, person: Mapping) -> bool:
    """May this actor manage this staff record?

    ── WHY THIS REPLACED `reports_to == actor['uid']` ────────────────────────

    `reports_to` was written once, at invite time, to the uid of whoever sent
    the invitation — and then used as the authorisation key in three places:
    `list_staff` scoped a team admin's entire view by it, and `deactivate` and
    `set_employment` refused on it. So authority was "I invited you", which is a
    fact about the past rather than a position in the organisation, and it was
    wrong in three distinct ways:

      * an owner who invited a member directly left that member's own
        department admin with no authority over them at all;
      * two admins in one department each saw only their own invitees, never the
        department they run;
      * and a transfer did not move authority. Somebody moved from Ops to
        Finance still reported to the `ops_admin` who first invited them, so the
        admin of the department they had LEFT kept the power to revoke them —
        while Finance, who now manage them, could not see them.

    The organisation model is a hierarchy of positions:

        Owner  →  department admin  →  department member

    so authority comes from the actor's role and the target's department, both of
    which are read from the records at the moment of the decision. Nobody's
    authority depends on who typed their email address a year ago.

    ── WHAT A DEPARTMENT ADMIN MAY NOT DO ────────────────────────────────────

    Their own department's MEMBERS, and nothing else. Not another department at
    any tier, not an owner, not the observer, and not a fellow admin of their own
    department — an admin is appointed by an owner and is managed by one, which
    is what keeps a department from being taken over from inside it.
    """
    actor_role: Role = actor["role"]
    if R.can_read_all(actor_role) or R.is_owner(actor_role):
        return True
    if not R.is_team_admin(actor_role):
        return False

    target_role_raw = str(person.get("role", ""))
    try:
        target_role = Role(target_role_raw)
    except ValueError:
        # A role this build does not know — a legacy string, or one left by a
        # hand edit. Fail closed: an unreadable position is not a position a
        # department admin may act on.
        return False

    # Members only. See the note above on why a sibling admin is excluded.
    if target_role not in R.MEMBER_ROLES:
        return False

    actor_team = R.team_of(actor_role)
    return actor_team is not None and R.team_of(target_role) == actor_team


def assignable_roles(actor_role: Role) -> list[Role]:
    """Which roles this person may hand out. Spec 1.3.3.

    An owner may appoint anyone. A team admin may only create members of their
    own team — never another admin, and never outside their department.

    ── THIS IS THE NARROWING, NOT THE PERMISSION ─────────────────────────────

    Two different questions, and conflating them produced a wrong fix once
    already. `CAN_MANAGE_TEAM` answers "may you create staff at all" and is
    enforced on `POST /staff`; this answers "which roles, then", and it is
    enforced again inside `invite`.

    `finance_admin` and `tech_admin` did not hold the permission, so the form
    offered them a role the endpoint refused. The fix attempted here was to
    return `[]` for anybody without the permission — which removed their Invite
    button and quietly wrote "Finance and Tech do not run their own departments"
    into the role model. The organisation model says the opposite, so the
    permission was granted instead and this function is back to doing one job.
    """
    # ── The observer provisions owners, and only owners ──────────────────────
    #
    # Its position at the top of the organisation —
    #
    #     Observer → Owners → six departments → admin → member
    #
    # with no CRM presence and no other write anywhere. This list is what
    # `invite` enforces, so one entry here is the whole of its authority: not a
    # department admin, not a member, not an agency, not a seller, not a host,
    # and NOT another observer. There is one observer, permanently, and it
    # cannot clone itself.
    if actor_role == Role.OBSERVER:
        return [Role.OWNER]

    if actor_role == Role.OWNER:
        # `Role.OBSERVER` is deliberately absent. The observer is a single
        # permanent identity defined by `settings.observer_email`, seeded by
        # `scripts/seed_accounts.py`, and an invited one would be broken in four
        # ways at once: `crm_directory.NOT_MIRRORED` gives it no CRM document,
        # the invitation mails a "set your password" link for an account whose
        # only door is an emailed code, that code is delivered to one fixed
        # mailbox regardless of who the account belongs to, and
        # `security.py` refuses any Firebase-token observer session. Offering it
        # was offering an account that cannot sign in.
        return [Role.OWNER, *sorted(R.STAFF_ROLES, key=str)]

    if R.is_team_admin(actor_role):
        team = R.team_of(actor_role)
        return [r for r in R.MEMBER_ROLES if R.team_of(r) == team]

    return []


# ── The second half ───────────────────────────────────────────────────────────


async def _crm_document_present(person: dict) -> bool:
    """Does this staff row already have its Firestore half?

    Only ever used to make a refusal more informative, so a Firestore that
    cannot be reached answers "yes" — the message then says nothing about the
    directory rather than accusing it of being missing on no evidence.
    """
    try:
        role = Role(person.get("role", ""))
    except ValueError:
        return True
    if role in crm.NOT_MIRRORED:
        return True
    try:
        return await crm.aread(str(person.get("uid", ""))) is not None
    except crm.DirectoryError:
        return True


async def _carry_to_crm(
    *,
    actor: dict,
    what: str,
    reason: str,
    uid: str,
    email: str,
    call,
) -> crm.Outcome:
    """Run one Firestore directory write, and be loud if it fails.

    `call` is a zero-argument coroutine factory so the two shapes — a full mirror
    and an activation flip — share one failure path.

    The Mongo change has already happened by the time this runs. That is the
    point of the ordering, and it is also why this cannot simply log: the account
    is now in the exact half-written state that produced the original bug, and
    the only acceptable outcome is that somebody is told, in the response and in
    the audit log, with the command that fixes it.

    ── What the API does about the divergence, and what it cannot ───────────

    Raising here reports it; it does not undo it. The Mongo row now holds the new
    role, the caller has just been shown an error, and the `crmUsers` document
    still holds the old one — so the operator most likely to notice has been told
    the operation failed.

    The server side of that is closed in `app/core/deps._confirm_role_on_record`:
    every permission-gated route re-reads the role from this collection before it
    grants anything, so no sensitive action is ever taken on a role that was only
    ever a claim on a token. Mongo is authoritative and this function has already
    written it, so what that check enforces is that the API and the record agree
    at the moment it matters.

    The Firestore side cannot be closed from here. `crmUsers.permissions` and
    `crmUsers.isActive` are read by `firestore.rules`, in the browser, and a
    stale document keeps granting whatever it says until `REPAIR_COMMAND` is run.
    That is why the failure is raised rather than logged, and why the command is
    in the message rather than in a runbook.
    """
    try:
        return await call()
    except crm.DirectoryError as exc:
        await audit.record(
            actor=actor,
            action=audit.Action.STAFF_MIRROR_FAILED,
            subject_type="staff",
            subject_id=uid,
            reason=(
                f"{what} was written to the API record and could not be carried "
                f"to the CRM directory: {exc}"
            ),
            after={"crm_user_document": "out of step with the staff record"},
            meta={"email": email, "error": str(exc), "repair": crm.REPAIR_COMMAND},
        )
        log.error("crmUsers write failed for %s during %s: %s", email, what, exc)
        raise StaffError(
            f"{what} was saved to the API record for {email}, and the CRM "
            f"directory entry the sign-in screen reads was not written. "
            f"Until that is repaired this account will not behave correctly in "
            f"the CRM. Nothing else was changed.\n\n"
            f"Reason: {exc}\n\n"
            f"Repair it with:  {crm.REPAIR_COMMAND}"
        ) from exc


async def invite(inv: Invitation, actor: dict, reason: str = "") -> dict:
    """Create a staff account — both records — and email a set-password link.

    The link goes out last, and only if both halves landed. Telling somebody to
    set a password for an account that cannot sign in wastes their afternoon and
    hides the failure behind a support ticket.

    `reason` is optional and used only where the caller has one worth recording:
    `POST /staff/owners` demands it, because provisioning an owner is the most
    consequential account creation in the system and the audit entry should say
    why rather than "Invited X as owner". An ordinary departmental invitation
    needs no justification beyond the role itself.
    """
    email = inv.email.strip().lower()
    if "@" not in email:
        raise StaffError("A valid email address is required.")
    if not inv.name.strip():
        raise StaffError("A name is required.")

    allowed = assignable_roles(actor["role"])
    if inv.role not in allowed:
        raise StaffError(
            f"You cannot assign the role '{inv.role}'. "
            f"Available to you: {', '.join(str(r) for r in allowed) or 'none'}."
        )

    # ── There is exactly one observer, and this is not how it is made ────────
    #
    # Refused for everybody, including an owner, rather than relying on it being
    # absent from every `assignable_roles` list. It is the one role whose account
    # this function cannot actually produce: no CRM document by design, a
    # "set your password" email for an account whose only door is an emailed
    # code, that code delivered to one fixed mailbox whoever the account is for,
    # and `security.py` refusing any Firebase-token observer session outright.
    #
    # The observer is `settings.observer_email`, seeded once by
    # `scripts/seed_accounts.py`. A second one is not a configuration this
    # system has.
    if inv.role == Role.OBSERVER:
        raise StaffError(
            "The observer is a single permanent account and cannot be invited. "
            "It is configured as OBSERVER_EMAIL and seeded by "
            "scripts/seed_accounts.py."
        )

    db = get_db()
    already = await db[C.STAFF].find_one({"email": email})
    if already:
        # Say *which* half exists. "An account already exists" on an account that
        # cannot sign in is the least useful sentence in the system — it is the
        # message somebody gets when they try to fix a half-created account by
        # re-inviting, which is the obvious thing to try.
        raise StaffError(
            f"An account already exists for {email}."
            + (
                ""
                if await _crm_document_present(already)
                else (
                    " Its CRM directory entry is missing, which is why it may "
                    "appear not to work. Re-inviting will not fix that — repair "
                    f"it with:  {crm.REPAIR_COMMAND}"
                )
            )
        )

    # ── The credential ───────────────────────────────────────────────────────
    #
    # Firebase owns it. For a NEW account a random password is set and
    # immediately made irrelevant by the reset link — nobody, including the
    # inviter, ever knows it.
    #
    # An address that already has an account REUSES that account, and that is
    # deliberate: one person is meant to hold one uid carrying their password,
    # their Google identity and their phone number, so the CRM and the app are
    # the same account rather than two strangers who happen to share an inbox.
    #
    # What must not happen is doing it silently. Most of these people are
    # already Zipper APP users, and the flow used to mail them a password-reset
    # link — a live credential for an account they are using every day, worded
    # as though the account were new. Anyone following the instruction would
    # reset the password on their own login.
    existing = firebase.get_user_by_email(email)
    reused_account = existing is not None
    if existing:
        uid = existing.uid
        # Any provider at all means somebody can already sign in as this
        # account: a password they chose, a Google identity, a phone number.
        # `provider_data` excludes the synthetic `firebase` entry, so an empty
        # list really does mean an account nobody can reach.
        has_own_sign_in = bool(getattr(existing, "provider_data", None))
        email_already_proven = bool(getattr(existing, "email_verified", False))
    else:
        created = fb_auth.create_user(
            email=email,
            display_name=inv.name.strip(),
            password=secrets.token_urlsafe(32),
            # FALSE, and deliberately so. Nothing has proved this person reads
            # this mailbox yet — the address was typed by whoever is inviting
            # them. The set-password link below is the proof: the password it
            # replaces is 32 random bytes that were never disclosed to anybody,
            # so knowing a working password for this account is only possible by
            # having opened the email. Firebase marks the address verified when
            # that reset completes, which is what later lets them connect
            # Google; `completeGoogleLink` refuses an unverified address because
            # on one, Firebase links Google by REMOVING the password provider
            # instead of reporting the collision.
            email_verified=False,
        )
        uid = created.uid
        has_own_sign_in = False
        email_already_proven = False

    # A reset link only where it is the invitation. On a reused account it is a
    # credential nobody asked for; `send_staff_access_added` says what happened
    # instead and carries nothing.
    reset_link = ""
    link_problem = ""
    if not has_own_sign_in:
        try:
            reset_link = fb_auth.generate_password_reset_link(email)
        except Exception as exc:  # noqa: BLE001
            link_problem = str(exc)
            log.exception("Could not generate a set-password link for %s", email)

    now = datetime.now(timezone.utc)
    doc = {
        "uid": uid,
        "email": email,
        "name": inv.name.strip(),
        "phone": inv.phone.strip(),
        "role": str(inv.role),
        "team": str(R.team_of(inv.role)) if R.team_of(inv.role) else None,
        "field_charge": inv.field_charge.strip() or None,
        # A member reports to whoever invited them; an owner-invited admin
        # reports to that owner.
        "reports_to": actor["uid"],
        "is_active": True,
        "created_at": now,
        "created_by": {"uid": actor["uid"], "name": actor.get("name", "")},
        "updated_at": now,
    }
    await db[C.STAFF].insert_one(doc)

    # Audited before the mirror, so the row is never unaudited for an instant.
    # The log is append-only, so success is recorded by absence: a
    # `staff.created` with no `staff.mirror_failed` after it for the same
    # subject is an account with both halves.
    await audit.record(
        actor=actor,
        action=audit.Action.STAFF_CREATED,
        subject_type="staff",
        subject_id=uid,
        reason=reason.strip() or f"Invited {inv.name.strip()} as {inv.role}",
        after={"email": email, "role": str(inv.role)},
        meta={
            "reports_to": actor["uid"],
            "crm_role": crm.crm_role_for(inv.role),
            "crm_user_document": (
                "not written — " + crm.NOT_MIRRORED[inv.role]
                if inv.role in crm.NOT_MIRRORED
                else "written in the same call; a failure appears as "
                "staff.mirror_failed"
            ),
        },
    )

    mirrored = await _carry_to_crm(
        actor=actor,
        what=f"The invitation of {inv.name.strip()} as {inv.role}",
        reason=f"Invited {inv.name.strip()} as {inv.role}",
        uid=uid,
        email=email,
        call=lambda: crm.amirror(
            uid=uid,
            email=email,
            name=inv.name.strip(),
            role=inv.role,
            created_by=actor["uid"],
            phone=inv.phone.strip(),
            field_charge=inv.field_charge.strip() or None,
            reports_to=actor["uid"],
            is_active=True,
        ),
    )

    from app.services import email as email_service

    # ── Telling them ─────────────────────────────────────────────────────────
    #
    # Reported honestly, which it was not before. The screen said "Invitation
    # sent to {email}" unconditionally, while the send was skipped entirely
    # whenever the link could not be generated — so an account could exist in
    # both stores, be audited as created, be announced as invited, and nobody
    # had been written to at all. The only trace was a log line.
    role_label = str(inv.role).replace("_", " ").title()
    invited_by = actor.get("name", "your administrator")
    notified = ""
    try:
        if reset_link:
            email_service.send_staff_invitation(
                to_email=email,
                name=inv.name.strip(),
                role_label=role_label,
                set_password_link=reset_link,
                invited_by=invited_by,
            )
            notified = "invitation sent — they set their own password"
        elif has_own_sign_in:
            email_service.send_staff_access_added(
                to_email=email,
                name=inv.name.strip(),
                role_label=role_label,
                invited_by=invited_by,
            )
            notified = (
                "this address already had a Zipper account, so their access was "
                "added to it — they sign in exactly as they do now, and no "
                "password link was sent"
            )
        else:
            notified = (
                "NOTHING WAS SENT — a set-password link could not be generated"
                + (f" ({link_problem})" if link_problem else "")
                + ". The account exists; ask them to use Forgot password."
            )
    except Exception as exc:  # noqa: BLE001 — the account is made either way
        log.exception("Could not notify %s of their staff invitation", email)
        notified = f"NOTHING WAS SENT — the email could not be delivered ({exc})."

    doc.pop("_id", None)
    # Named in the response as well as the log, so the caller can see that the
    # account it just created is the two-record kind rather than assume it.
    doc["crm_user_document"] = mirrored.action
    doc["crm_role"] = mirrored.crm_role
    doc["notification"] = notified
    doc["reused_existing_account"] = reused_account
    doc["email_already_verified"] = email_already_proven
    return doc


async def list_staff(actor: dict, include_inactive: bool = False) -> list[dict]:
    """Owners and the observer see everyone. A team admin sees their own reports."""
    q: dict = {}
    if not include_inactive:
        q["is_active"] = True

    role: Role = actor["role"]
    if R.can_read_all(role):
        pass
    elif R.is_team_admin(role):
        # ── Their department, not their invitees ────────────────────────────
        #
        # This was `reports_to == actor['uid']`, so a team admin saw only the
        # people they had personally invited: an owner-invited member of their
        # own department was invisible to them, and two admins in one department
        # each saw half of it.
        #
        # Scoped on `team` and narrowed to members, which is exactly what
        # `manages()` authorises — the list and the authority have to agree, or
        # the screen shows rows whose buttons 403.
        team = R.team_of(role)
        if team is None:
            q["uid"] = actor["uid"]
        else:
            q["team"] = str(team)
            q["role"] = {"$in": [str(r) for r in R.MEMBER_ROLES]}
    else:
        q["uid"] = actor["uid"]

    # ── Pay is removed on the way out, for everyone but an owner ─────────────
    #
    # `OWNER_ONLY_EMPLOYMENT_FIELDS` was a WRITE gate with no read counterpart.
    # This query returned whole documents — `doc.pop("_id")` and nothing else —
    # so a department admin who is explicitly refused permission to SET their
    # members' salaries received every one of them on the list screen. The CRM
    # does not render the fields, which is why it was not noticed; they were in
    # the HTTP response.
    #
    # Removed here rather than projected away in the query, because `read_own`
    # shares neither the query nor the scope and must keep returning them: a
    # person may always see their own pay.
    cursor = get_db()[C.STAFF].find(q).sort("created_at", -1)
    # Owners and the observer see pay; everybody else sees their OWN and nobody
    # else's. Row by row rather than caller by caller, so a department admin
    # keeps their own figure on the same screen that hides their reports'.
    sees_all_pay = R.is_owner(role) or R.can_read_all(role)
    out = []
    async for doc in cursor:
        doc.pop("_id", None)
        if not sees_all_pay and doc.get("uid") != actor["uid"]:
            for field in OWNER_ONLY_EMPLOYMENT_FIELDS:
                doc.pop(field, None)
        out.append(doc)
    return out


async def read_own(actor: dict) -> dict:
    """The caller's own staff row, whole.

    `/profile` needs this and cannot get it from Firestore. The `crmUsers`
    document is readable by every member of staff — `allow read: if isStaff() ||
    isOwner(uid)` in firestore.rules — so a salary mirrored there would publish
    everybody's pay to the whole team. Salary and employment id therefore live
    only on this row, and this is the only route that hands them out: it takes
    no uid at all, so there is no id for a caller to substitute for somebody
    else's.

    An account with no row is not an error here. The observer authenticates
    against the API and is deliberately absent from the CRM directory, and a
    session can outlive a row; both should see an empty profile rather than a
    failure, so this answers with `None`.
    """
    person = await get_db()[C.STAFF].find_one({"uid": actor["uid"]})
    if person is None:
        return {}
    person.pop("_id", None)
    return person


#: The business facts about a person that the person themself may not set.
#:
#: The split this enforces is the whole point of `/profile`: contact details
#: belong to their holder and are written straight to Firestore by the browser,
#: while everything below is a fact about the person's employment and is written
#: only here, by somebody with authority over them, with a reason, in the log.
EMPLOYMENT_FIELDS: tuple[str, ...] = (
    "employment_id",
    "salary_minor",
    "salary_currency",
    "joined_at",
    "field_charge",
)

#: Of those, the ones only an owner may touch.
#:
#: A team admin runs a department and may record who somebody is — their
#: employment id, their start date, what they are responsible for. Pay is not
#: that. It is money, it is the one field on this record that costs the business
#: something, and letting a department admin set their own reports' salaries
#: would put the entire payroll of a team behind one signature. Owners only.
OWNER_ONLY_EMPLOYMENT_FIELDS: frozenset[str] = frozenset(
    {"salary_minor", "salary_currency"}
)


async def set_employment(
    uid: str, changes: dict, actor: dict, reason: str
) -> dict:
    """Set the business fields on somebody's staff record.

    Never reachable by the person themself unless they are an owner — and an
    owner editing their own record is an owner setting a salary, which is what
    an owner is. The refusal that matters is the one below it: a team admin is
    scoped to their own direct reports and is refused the pay fields outright.
    """
    if not reason.strip():
        raise StaffError("A reason is required.")

    supplied = {k: v for k, v in changes.items() if k in EMPLOYMENT_FIELDS}
    if not supplied:
        raise StaffError("Nothing to change.")

    actor_role: Role = actor["role"]
    is_owner = R.is_owner(actor_role)

    if not is_owner:
        if not R.is_team_admin(actor_role):
            raise StaffError(
                "Only an owner or a team admin can set employment details."
            )
        touched_pay = sorted(set(supplied) & OWNER_ONLY_EMPLOYMENT_FIELDS)
        if touched_pay:
            raise StaffError(
                "Only an owner can set pay. Nothing was changed — ask an owner "
                "to set the salary, and file the rest separately."
            )

    db = get_db()
    person = await db[C.STAFF].find_one({"uid": uid})
    if person is None:
        raise StaffError("Account not found.")

    # Position, not provenance. See `manages()` — a department admin may edit
    # the members of their own department, whoever happened to invite them.
    if not manages(actor, person):
        raise StaffError("You can only edit members of your own department.")

    before = {k: person.get(k) for k in supplied}
    if before == supplied:
        raise StaffError("That is already what the record says.")

    await db[C.STAFF].update_one(
        {"uid": uid},
        {"$set": {**supplied, "updated_at": datetime.now(timezone.utc)}},
    )

    await audit.record(
        actor=actor,
        action=audit.Action.STAFF_EMPLOYMENT_CHANGED,
        subject_type="staff",
        subject_id=uid,
        reason=reason,
        before=before,
        after=supplied,
        meta={"email": str(person.get("email", ""))},
    )

    person.update(supplied)
    person.pop("_id", None)

    # `field_charge` is the one business field the CRM shell reads from
    # Firestore rather than from this API — it is on the team roster and on the
    # person's own profile header — so a change to it has to reach both halves
    # or the two records disagree about what somebody does. The other four are
    # Mongo-only by design and there is nothing to carry.
    #
    # SALARY IS NEVER MIRRORED, AND MUST NEVER BE ADDED HERE.
    #   `firestore.rules` grants `crmUsers` read to `isStaff() || isOwner(uid)`
    #   — every member of staff can read every one of those documents. A salary
    #   written there is a salary published to the whole company, quietly, with
    #   no screen showing it. That is why `/profile` reads pay from
    #   `GET /staff/me` instead of from the document it is already holding.
    #
    # Same mirror call `change_role` makes, for the same reason and with the
    # same failure handling: the Mongo write has already landed, so a Firestore
    # failure is raised and audited rather than swallowed.
    if "field_charge" in supplied:
        try:
            target_role = Role(str(person.get("role", "")))
        except ValueError:
            target_role = None

        # `mirror` treats a role in NOT_MIRRORED as an instruction to DELETE any
        # document for that address — which is right when it is reconciling a
        # whole account, and wrong here. This call is carrying one field across;
        # it has no business removing a record on the way. The observer is the
        # role that reaches this, and their absence from the directory is
        # already asserted by the paths that own it.
        if target_role is not None and target_role not in crm.NOT_MIRRORED:
            mirrored_role: Role = target_role
            await _carry_to_crm(
                actor=actor,
                what=f"The field charge change for {person.get('email', uid)}",
                reason=reason,
                uid=uid,
                email=str(person.get("email", "")),
                call=lambda: crm.amirror(
                    uid=uid,
                    email=str(person.get("email", "")),
                    name=str(person.get("name", "")),
                    role=mirrored_role,
                    created_by=actor["uid"],
                    phone=str(person.get("phone", "") or ""),
                    field_charge=person.get("field_charge"),
                    reports_to=person.get("reports_to"),
                    is_active=bool(person.get("is_active", True)),
                ),
            )

    return person


async def change_role(uid: str, new_role: Role, actor: dict, reason: str) -> dict:
    """Change someone's role. Owners only — this is an authority change."""
    if not R.is_owner(actor["role"]):
        raise StaffError("Only an owner can change a role.")
    if not reason.strip():
        raise StaffError("A reason is required.")

    db = get_db()
    person = await db[C.STAFF].find_one({"uid": uid})
    if person is None:
        raise StaffError("Account not found.")

    old_role = person["role"]
    if old_role == str(new_role):
        raise StaffError(f"Already {new_role}.")

    patch: dict = {
        "role": str(new_role),
        "team": str(R.team_of(new_role)) if R.team_of(new_role) else None,
        "updated_at": datetime.now(timezone.utc),
    }

    # ── `reports_to` is deliberately NOT touched ─────────────────────────────
    #
    # An earlier version re-pointed it at the actor whenever the department
    # changed, to stop the old department's admin keeping authority over
    # somebody who had left. It did stop that — by making the employee
    # owner-owned, and therefore invisible to the department that now runs
    # them. It was the right problem and the wrong mechanism, and it only
    # existed because `reports_to` was being used as an authorisation key.
    #
    # It no longer is. `manages()` derives authority from the actor's role and
    # the target's `team`, and `team` is written three lines above — so a
    # transfer moves authority to the new department and away from the old one
    # by itself, with no second field to keep in step. `reports_to` is left as
    # the historical record of who brought them in, which is all it ever was.
    await db[C.STAFF].update_one({"uid": uid}, {"$set": patch})

    await audit.record(
        actor=actor,
        action=audit.Action.STAFF_ROLE_CHANGED,
        subject_type="staff",
        subject_id=uid,
        reason=reason,
        before={"role": old_role},
        after={"role": str(new_role)},
    )

    # Existing sessions carry the old role in their token, so they are revoked.
    await db[C.SESSIONS].update_many({"uid": uid}, {"$set": {"revoked": True}})

    # And the CRM directory, or the shell shows one role while the API enforces
    # another — a `finance_admin` demoted to `finance_member` would keep the
    # finance department's navigation and its Firestore permissions, and find
    # out what actually changed one refused API call at a time.
    #
    # This also covers the two shapes of change that are not an ordinary edit: a
    # promotion to owner rewrites the document as `superadmin`, and a change to
    # observer **deletes** it, because the observer must hold no Firestore write
    # access at all.
    mirrored = await _carry_to_crm(
        actor=actor,
        what=f"The role change from {old_role} to {new_role}",
        reason=reason,
        uid=uid,
        email=str(person.get("email", "")),
        call=lambda: crm.amirror(
            uid=uid,
            email=str(person.get("email", "")),
            name=str(person.get("name", "")),
            role=new_role,
            created_by=actor["uid"],
            phone=str(person.get("phone", "") or ""),
            field_charge=person.get("field_charge"),
            reports_to=person.get("reports_to"),
            is_active=bool(person.get("is_active", True)),
        ),
    )

    person["role"] = str(new_role)
    person.pop("_id", None)
    person["crm_user_document"] = mirrored.action
    person["crm_role"] = mirrored.crm_role
    return person


async def deactivate(uid: str, actor: dict, reason: str) -> dict:
    """Revoke access. The record is kept — history must remain attributable."""
    if not reason.strip():
        raise StaffError("A reason is required.")

    db = get_db()
    person = await db[C.STAFF].find_one({"uid": uid})
    if person is None:
        raise StaffError("Account not found.")

    if uid == actor["uid"]:
        raise StaffError("You cannot deactivate your own account.")

    target_role = Role(person["role"])
    if R.is_owner(target_role) and not R.is_owner(actor["role"]):
        raise StaffError("Only an owner can deactivate an owner.")
    if not manages(actor, person):
        # One predicate for the three staff-management sites, so revoking,
        # editing and listing can never disagree about who a department admin
        # is responsible for. The old test — "did I invite you" — left the
        # admin of a department somebody had LEFT still able to revoke them.
        raise StaffError("You can only deactivate members of your own department.")

    # Sessions first. Whatever else fails below, the live token stops working —
    # a revocation that gets halfway should get the most valuable half done.
    await db[C.SESSIONS].update_many({"uid": uid}, {"$set": {"revoked": True}})
    await db[C.STAFF].update_one(
        {"uid": uid},
        {"$set": {"is_active": False, "updated_at": datetime.now(timezone.utc)}},
    )

    # ── The credential itself ────────────────────────────────────────────────
    #
    # Everything above this line is a flag in a database WE check. None of it
    # touches the Firebase account, so before this existed a revoked person kept
    # a working login indefinitely: they could still authenticate, still mint
    # fresh ID tokens, still receive a password reset, and were held out only by
    # two application-level reads. If either of those writes failed — and the CRM
    # mirror below is best-effort, with a repair script named in its error — the
    # shell opened for them until somebody ran it.
    #
    # Resolved by `uid`, never by the email address on the row. Two accounts can
    # share an address across systems, and disabling the wrong one locks out
    # somebody nobody revoked while leaving the revoked person signing in.
    #
    # Deliberately NOT a deletion: the Firebase account, the staff row and the
    # CRM document all survive, so history stays attributable and a reinstatement
    # is a re-enable rather than a rebuild.
    firebase_problem = await asyncio.to_thread(firebase.set_user_disabled, uid, True)

    await audit.record(
        actor=actor,
        action=audit.Action.STAFF_DEACTIVATED,
        subject_type="staff",
        subject_id=uid,
        reason=reason,
        before={"is_active": True},
        after={"is_active": False, "firebase_login": "disabled" if not firebase_problem else "STILL ENABLED"},
    )

    if firebase_problem:
        # Its own entry, so an operator can list every revocation still
        # outstanding instead of relying on an error that was shown once.
        await audit.record(
            actor=actor,
            action=audit.Action.STAFF_FIREBASE_REVOKE_FAILED,
            subject_type="staff",
            subject_id=uid,
            reason=firebase_problem,
            before={"firebase_disabled": False},
            after={"firebase_disabled": False},
        )

    # Revoking the API session is not revoking access. `crmSignIn` reads
    # `crmUsers.isActive`, and while that still says true the person can open
    # the shell and use every Firestore-backed screen on it. Both halves, or the
    # account is only partly gone.
    mirrored = await _carry_to_crm(
        actor=actor,
        what=f"The revocation of {person.get('email', uid)}'s access",
        reason=reason,
        uid=uid,
        email=str(person.get("email", "")),
        call=lambda: crm.aset_active(
            uid=uid,
            email=str(person.get("email", "")),
            role=target_role,
            is_active=False,
        ),
    )

    person["is_active"] = False
    person.pop("_id", None)
    person["crm_user_document"] = mirrored.action
    # Reported, not hidden. A revocation with the login still enabled is not a
    # completed revocation, and the one thing that must never happen is the
    # caller being told it is done while the person can still sign in.
    person["firebase_login"] = "disabled" if not firebase_problem else firebase_problem
    person["fully_revoked"] = not firebase_problem
    return person


async def team_overview(actor: dict) -> list[dict]:
    """Headcount per department. Spec 1.3.4."""
    if not R.can_read_all(actor["role"]):
        return []

    pipeline = [
        {"$match": {"is_active": True}},
        {"$group": {"_id": "$team", "count": {"$sum": 1},
                    "roles": {"$addToSet": "$role"}}},
        {"$sort": {"_id": 1}},
    ]
    out = []
    async for row in get_db()[C.STAFF].aggregate(pipeline):
        out.append(
            {"team": row["_id"] or "no team", "headcount": row["count"],
             "roles": sorted(row["roles"])}
        )
    return out
