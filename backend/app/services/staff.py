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
from datetime import datetime, timedelta, timezone

from firebase_admin import auth as fb_auth

from app.core import audit
from app.core import roles as R
from app.core.roles import Role
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import crm_directory as crm
from app.services import storage_claims

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

    # ── Phase 1A (STAFF-001/002) — the top of the hierarchy is not managed ──
    #
    # The observer is managed by nobody. An Owner is managed only by the
    # observer: Owners manage the departments, not each other. This used to
    # return True for any owner against any record, which let one Owner
    # deactivate or re-role another — or the last one.
    target_raw = str(person.get("role", ""))
    if target_raw == str(Role.OBSERVER):
        return False
    if target_raw == str(Role.OWNER):
        return R.is_observer(actor_role)
    if R.is_owner(actor_role):
        return True
    if R.is_observer(actor_role):
        # Reads everything (list_staff uses can_read_all); manages only Owners.
        return False
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
        # Phase 1A (STAFF-001): `Role.OWNER` is no longer here. Only the
        # observer provisions Owners (`POST /staff/owners`); an Owner minting
        # another Owner was a privilege escalation with no second party.
        return sorted(R.STAFF_ROLES, key=str)

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
        # MFA release, revision 4 (R2): this used to end "Nothing else was changed", which
        # was wrong for every caller — each of them has already written the API
        # record, and some have revoked sessions too. And the repair script only
        # writes a MISSING directory entry; it does not correct one that exists
        # but is out of date, so it is named only for that case.
        raise StaffError(
            f"{what} was saved to the API record for {email}, and the CRM "
            f"directory entry the sign-in screen reads was not written. "
            f"Until that is repaired this account will not behave correctly in "
            f"the CRM. Steps of this operation that ran before this one have not "
            f"been undone.\n\n"
            f"Reason: {exc}\n\n"
            f"If the directory entry is missing, repair it with:  {crm.REPAIR_COMMAND}  "
            f"(that does not correct an entry that exists but is out of date)."
        ) from exc


# ── P1-B3: the staff state model ──────────────────────────────────────────────
#
# `status` ∈ {active, suspended, deactivated}, ALWAYS written together with
# `is_active = (status == "active")` by `status_patch`. Access is decided by
# `is_active` alone — every existing guard and every legacy writer uses it — and
# `status` names which kind of inactive (see `status_of`). Legacy rows with no
# `status` read correctly as they are; no migration is needed to read them.
STATUS_ACTIVE = "active"
STATUS_SUSPENDED = "suspended"
STATUS_DEACTIVATED = "deactivated"
STAFF_STATUSES = (STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_DEACTIVATED)

#: Allowed transitions. Anything else is refused with a sentence.
TRANSITIONS: dict[str, frozenset[str]] = {
    STATUS_ACTIVE: frozenset({STATUS_SUSPENDED, STATUS_DEACTIVATED}),
    STATUS_SUSPENDED: frozenset({STATUS_ACTIVE, STATUS_DEACTIVATED}),
    STATUS_DEACTIVATED: frozenset({STATUS_ACTIVE}),
}


def status_of(row: Mapping) -> str:
    """The row's state.

    `is_active` decides active vs not — it is what every guard and every legacy
    writer (scripts, repairs) reads and writes — and `status` only says WHICH
    kind of inactive. So the two can never disagree about access: a row with
    `is_active: true` is active whatever an old `status` says, and a legacy row
    with no `status` and `is_active: false` is deactivated.
    """
    if row.get("is_active", True):
        return STATUS_ACTIVE
    raw = str(row.get("status") or "")
    return raw if raw in (STATUS_SUSPENDED, STATUS_DEACTIVATED) else STATUS_DEACTIVATED


def status_patch(status: str) -> dict:
    """The two fields, always written together."""
    if status not in STAFF_STATUSES:
        raise StaffError(f"'{status}' is not a staff status.")
    return {"status": status, "is_active": status == STATUS_ACTIVE}


#: P1-B4 — partner statuses that count as HOLDING a role, taken from the one
#: canonical definition (`partner_applications.HELD_STATUSES`: pending,
#: awaiting_verification, approved, suspended, revoked). This was a local copy
#: that had drifted — it left out `awaiting_verification` and `revoked`, so a
#: person with an Owner-approved role waiting on contact verification, or a
#: revoked role that can still be restored, could be hired as staff.
def _partner_held_statuses() -> frozenset[str]:
    from app.services import partner_applications as apps  # local: avoids an import cycle

    return frozenset(apps.HELD_STATUSES)


async def _partner_roles_held(uid: str) -> list[str]:
    """Partner records this uid owns in Mongo `partners` that still HOLD a role,
    as `kind (status)` — the authoritative store, the canonical held statuses."""
    held_statuses = _partner_held_statuses()
    kinds: set[str] = set()
    async for row in get_db()[C.PARTNERS].find({"owner_crm_uid": uid}):
        status = str(row.get("status") or "")
        if status in held_statuses:
            kinds.add(f"{row.get('kind') or 'partner'} ({status})")
    return sorted(kinds)


def _is_app_host(uid: str) -> bool:
    """`users/{uid}.isHost`. Best effort: an unreadable document is reported as
    not-a-host here, and `partner_applications.eligible_kinds` independently
    refuses Host to any internal account, so the pair cannot be created later."""
    try:
        snap = firebase.firestore_client().collection("users").document(uid).get()
        return bool(snap.exists and (snap.to_dict() or {}).get("isHost"))
    except Exception:  # noqa: BLE001
        log.warning("Could not read users/%s to check host status at invite", uid)
        return False


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
        # ── Phase 1A (SECURITY-004 / ROLE-001): staff never hold partner roles ─
        #
        # Reusing an existing account is how one human keeps one uid — but if
        # that uid already holds an agency, sub-agency or coin-seller role, or is
        # a host, making it staff would give one person both sides of a money
        # flow. Refused, and named. Unwinding the partner role first is an
        # explicit operator decision, not a side effect of an invitation.
        held_partner = await _partner_roles_held(uid)
        is_host = await asyncio.to_thread(_is_app_host, uid)
        if held_partner or is_host:
            what = ", ".join(held_partner) or "host"
            # P1-B4: refused, never resolved here. Ending a partner role (reject a
            # pending application, revoke an approved one) is its own authorised,
            # audited decision on the partner record; hiring never does it as a
            # side effect.
            raise StaffError(
                f"{email} has a partner record that conflicts with a staff role "
                f"({what}). Staff accounts cannot hold partner roles. Resolve the "
                "partner record first through its own decision (reject the "
                "application or revoke the role, with a reason) and then invite "
                "again. Nothing was created."
            )
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
        **status_patch(STATUS_ACTIVE),
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

    # ── The third record: the Storage role claim ─────────────────────────────
    #
    # A staff account is two records — this Mongo row and the `crmUsers`
    # document above — and neither is visible to `storage.rules`, which cannot
    # read Firestore. Without the claim a newly invited reviewer signs into the
    # CRM, sees the KYC queue, and is refused every document in it.
    #
    # Set here rather than by the Firestore trigger on purpose: the trigger can
    # only ever emit 'agency' or 'seller', because partner `crmUsers`
    # documents are client-written and a trigger that could emit an internal
    # role would be an escalation path. See `app/services/storage_claims.py`.
    claim_problem = await asyncio.to_thread(
        storage_claims.apply_for_role, uid, inv.role
    )
    doc["storage_role_claim"] = claim_problem or "granted"
    if claim_problem:
        log.warning("storage claim not granted for %s: %s", uid, claim_problem)

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
    """Change someone's role. Owners only — this is an authority change.

    Phase 1A (STAFF-002/003): an Owner moves people between DEPARTMENT roles
    (admin/member) and nothing else. Never to or from Owner or Observer, never a
    partner role, never their own role.
    """
    if not R.is_owner(actor["role"]):
        raise StaffError("Only an owner can change a role.")
    if not reason.strip():
        raise StaffError("A reason is required.")
    if uid == actor.get("uid"):
        raise StaffError("You cannot change your own role.")
    if new_role not in R.STAFF_ROLES:
        raise StaffError(
            f"'{new_role}' is not a department role. Owners are provisioned and "
            "removed by the observer; agency and seller are partner roles and are "
            "never given to staff."
        )

    db = get_db()
    person = await db[C.STAFF].find_one({"uid": uid})
    if person is None:
        raise StaffError("Account not found.")
    if str(person.get("role", "")) in (str(Role.OWNER), str(Role.OBSERVER)):
        raise StaffError(
            "An owner's or the observer's role cannot be changed here. Owners are "
            "managed by the observer."
        )

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

    role_audit_id = await audit.record(
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
    # P1-A3b: an Owner MFA binding must not outlive the Owner role. Unreachable in
    # this release (an Owner's role is refused above); kept as defence in depth and,
    # since MFA release revision 4, it reports a failure instead of ignoring it
    # (see the end).
    owner_bindings_problem = await _clear_owner_bindings_on_role_change(uid, str(old_role), actor)

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

    # The Storage role claim follows the Mongo row, which is the authority for
    # an internal role. Without this a promotion to finance_admin would reach
    # the CRM and the API but not `storage.rules`, so the person would be
    # refused the evidence files their new role exists to review.
    #
    # Reported, not raised: the role change has already been written and
    # audited, and failing the request now would leave the caller believing it
    # did not happen. `storage_role_claim` carries the problem forward the same
    # way `crm_user_document` carries a mirroring failure.
    claim_problem = await asyncio.to_thread(
        storage_claims.apply_for_role, uid, new_role
    )
    person["storage_role_claim"] = claim_problem or "updated"
    if claim_problem:
        log.warning("storage claim not updated for %s: %s", uid, claim_problem)

    # P1-F: told after the change has landed. Keyed on the audit entry.
    person["notified"] = await notify_access_change(
        person=person, change="role_changed", actor=actor,
        audit_id=str(role_audit_id or ""), new_role=str(new_role),
    )

    if owner_bindings_problem is not None:
        person["owner_mfa_bindings"] = "NOT CLEARED"
        raise StaffError(
            f"The role change of {person.get('email') or uid} was saved, but {owner_bindings_problem}. "
            "Until they are removed a bound Firebase session may still pass the Owner checks: "
            "the Observer must reset this account's MFA."
        )
    return person


async def _clear_owner_bindings_on_role_change(uid: str, old_role: str, actor: dict) -> str | None:
    """Remove every MFA binding of a former Owner. None when done (or not an Owner); else what failed.

    Never raises: the role change has been written by the time this runs, so the
    caller reports what is outstanding at the end instead of stopping half-way.
    """
    if old_role != str(Role.OWNER):
        return None
    from app.services import owner_mfa

    if not await owner_mfa.clear_all_bindings(uid, "Role changed away from Owner"):
        try:
            await audit.record(actor=actor, action=audit.Action.OWNER_MFA_UNBIND_FAILED, subject_type="auth.mfa",
                               subject_id=uid, reason="Role changed away from Owner, and the MFA bindings "
                               "could not be removed", meta={"all": True})
        except Exception:  # noqa: BLE001 — the failure is still reported to the caller
            log.exception("role change of %s: the unbind-failure audit entry was not written", uid)
        return "the former Owner's MFA bindings were NOT removed"
    try:
        await audit.record(actor=actor, action=audit.Action.OWNER_MFA_UNBOUND, subject_type="auth.mfa",
                           subject_id=uid, reason="Role changed away from Owner", meta={"all": True})
    except Exception:  # noqa: BLE001
        log.exception("role change of %s: the binding-removal audit entry was not written", uid)
        return "the removal of the former Owner's MFA bindings could not be recorded in the audit log"
    return None


#: R3 (MFA release, revision 4): Owner deactivations are serialised by a lease.
#:
#: "Is this the last active Owner?" and the write that changes the answer used to
#: be two separate steps, so two simultaneous deactivations of the last two active
#: Owners could both pass the check and leave none. The lease is one document with a
#: fixed `_id` — Mongo's own unique `_id` index is the mutex — held from the count to
#: the `is_active` write and given back in a `finally`. A process that dies holding
#: it leaves it for at most `_OWNER_LEASE_SECONDS`; the next deactivation then takes
#: it over, conditionally, so two of them cannot both take over the same stale lease.
#: Only Owner targets take it: no other deactivation changes the number of Owners.
#: In this tree a SUSPENSION of an Owner changes that number too (P1-B3), so it
#: takes the same lease.
STAFF_LOCKS = "staff_locks"
_OWNER_LEASE_ID = "owner-deactivation"
_OWNER_LEASE_SECONDS = 60
#: How long a second Owner deactivation waits for the first: step seconds × attempts.
_OWNER_LEASE_WAIT = (0.2, 25)


def _as_utc(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


async def _take_owner_lease(db) -> str | None:
    """Hold the Owner-deactivation lease; None if somebody else held it for the whole wait."""
    from pymongo.errors import DuplicateKeyError

    token = secrets.token_hex(16)
    step, attempts = _OWNER_LEASE_WAIT
    for _ in range(attempts):
        now = datetime.now(timezone.utc)
        expires = now + timedelta(seconds=_OWNER_LEASE_SECONDS)
        try:
            await db[STAFF_LOCKS].insert_one(
                {"_id": _OWNER_LEASE_ID, "holder": token, "expires_at": expires}
            )
            return token
        except DuplicateKeyError:
            held = await db[STAFF_LOCKS].find_one({"_id": _OWNER_LEASE_ID})
            until = _as_utc((held or {}).get("expires_at"))
            if held is not None and (until is None or until <= now):
                # Left over by a process that died. Taken over only if nobody has
                # just done the same: the update matches the stale holder exactly.
                taken = await db[STAFF_LOCKS].update_one(
                    {"_id": _OWNER_LEASE_ID, "holder": held.get("holder")},
                    {"$set": {"holder": token, "expires_at": expires}},
                )
                if getattr(taken, "modified_count", 0) == 1:
                    return token
        await asyncio.sleep(step)
    return None


async def _give_back_owner_lease(db, token: str) -> None:
    try:
        await db[STAFF_LOCKS].delete_one({"_id": _OWNER_LEASE_ID, "holder": token})
    except Exception:  # noqa: BLE001 — it expires by itself
        log.exception("the Owner-deactivation lease could not be released; it expires within %ss",
                      _OWNER_LEASE_SECONDS)


async def deactivate(uid: str, actor: dict, reason: str) -> dict:
    """Revoke staff access permanently-until-reactivated. P1-B1.

    The record is kept — history must remain attributable.

    ── WHAT CHANGED (approved decision 1) ─────────────────────────────────────
    This used to DISABLE THE FIREBASE ACCOUNT. `invite` deliberately reuses an
    existing account with the same email ("one person, one uid"), and most staff
    are app users, so disabling it locked the person out of their personal
    Zipper app account — wallet, diamonds, beans and host earnings — along with
    the CRM. The Firebase account is no longer touched. Staff access is revoked
    by everything that actually carries it:

      * API sessions revoked, and `staff.status` → deactivated (every session
        guard reads the Mongo row: `account_state.assert_may_act`, sign-in and
        renewal in `security.py`, and `require_permission` in `deps.py`, so an
        enabled personal login cannot mint or keep a staff session);
      * an Owner's Firestore/Storage MFA bindings removed (P1-A3b);
      * `crmUsers.isActive` → false, which turns off every Firestore staff grant
        (`isCrmUser()` reads it), and the CRM shell refuses the login;
      * the Storage role claim cleared. An ID token minted earlier keeps the
        claim until it expires (at most an hour) — the residual window is
        documented in the Phase 1 report; revoking the refresh token would sign
        the person out of the app, which decision 1 rules out.

    ── MFA release, revision 4 (R1–R4) ────────────────────────────────────────
    The caller is told a deactivation is done ONLY when all of it is done. Every
    step still runs whatever happened to the steps before it — API sessions, the
    Owner's MFA bindings, the staff record, the CRM directory entry, the storage
    claim and the audit trail — and anything that did not happen is named in one
    StaffError (HTTP 400), raised after the last step and audited as
    `staff.revocation_incomplete`. Nothing is undone; the row is marked
    `revocation_outstanding`, which is what lets the SAME transition be run
    again (an ordinary repeat of a complete deactivation is still refused as
    "already deactivated"), and running it again finishes it. A 200 therefore
    always means `fully_revoked: true`. Owner deactivations are serialised by a
    lease (R3) so the last-active-Owner count and the write it protects cannot
    race. The personal Firebase login is never part of this (decision 1), so it
    is never on the outstanding list.
    """
    return await _change_status(uid, actor, reason, STATUS_DEACTIVATED)


async def suspend(uid: str, actor: dict, reason: str) -> dict:
    """Pause staff access, reversibly. P1-B3. Same authority as deactivation,
    and — since it revokes the same things — the same revision 4 guarantees:
    reported as done only when all of it is done, and finishable by running it
    again."""
    return await _change_status(uid, actor, reason, STATUS_SUSPENDED)


async def reactivate(uid: str, actor: dict, reason: str) -> dict:
    """Restore a suspended or deactivated staff member's access. P1-B2.

    Authority is `manages()` — a department admin for their own team's members,
    an owner for department staff, the observer for owners — never self and
    never the observer. Old sessions stay revoked: the person signs in again and
    gets a fresh session; nothing silently comes back. The personal Firebase
    account is not touched. A login disabled by a deactivation made BEFORE
    decision 1 is reported (`personal_login_disabled`) and left for an explicit
    operator decision, because a disabled account may also be a moderation
    outcome that a staff reactivation must not undo.
    """
    return await _change_status(uid, actor, reason, STATUS_ACTIVE)


_VERB = {
    STATUS_DEACTIVATED: "deactivate",
    STATUS_SUSPENDED: "suspend",
    STATUS_ACTIVE: "reactivate",
}
_DONE = {
    STATUS_DEACTIVATED: "deactivated",
    STATUS_SUSPENDED: "suspended",
    STATUS_ACTIVE: "reactivated",
}
#: The operation as a noun — what the error messages and the audit trail call it.
_NOUN = {
    STATUS_DEACTIVATED: "deactivation",
    STATUS_SUSPENDED: "suspension",
    STATUS_ACTIVE: "reactivation",
}
_ACTION = {
    STATUS_DEACTIVATED: audit.Action.STAFF_DEACTIVATED,
    STATUS_SUSPENDED: audit.Action.STAFF_SUSPENDED,
    STATUS_ACTIVE: audit.Action.STAFF_REACTIVATED,
}
#: The reason on an Owner's binding-removal audit entry, per revocation.
_BINDING_REASON = {
    STATUS_DEACTIVATED: "Owner deactivated",
    STATUS_SUSPENDED: "Owner suspended",
}

#: R1: the staff-row field that names what an incomplete revocation left undone.
#: Written by the attempt that could not finish, removed by the one that does
#: (or by a reactivation). Its presence is what allows the same transition to
#: be run again; without it a repeat is refused as "already deactivated".
OUTSTANDING_FIELD = "revocation_outstanding"


def _transition(person: Mapping, to_status: str) -> bool:
    """Refuse an impossible transition with a sentence.

    Returns True when this is a RETRY of an incomplete revocation (R1): the row
    is already in `to_status` and carries `revocation_outstanding`, so the
    revocation steps run again to finish it.
    """
    current = status_of(person)
    if to_status in TRANSITIONS[current]:
        return False
    if current == to_status:
        if to_status != STATUS_ACTIVE and person.get(OUTSTANDING_FIELD):
            return True
        raise StaffError(f"This account is already {current}.")
    raise StaffError(f"A {current} account cannot be {_DONE[to_status]}.")


async def _change_status(uid: str, actor: dict, reason: str, to_status: str) -> dict:
    """The shared gate of suspend / deactivate / reactivate: the reason, the
    target, the transition and the authority. Then the direction decides."""
    verb = _VERB[to_status]
    if not reason.strip():
        raise StaffError("A reason is required.")

    db = get_db()
    person = await db[C.STAFF].find_one({"uid": uid})
    if person is None:
        raise StaffError("Account not found.")
    if uid == actor["uid"]:
        raise StaffError(f"You cannot {verb} your own account.")

    try:
        target_role = Role(person["role"])
    except ValueError as exc:
        raise StaffError("This record carries a role this build does not know; it cannot be changed here.") from exc
    if target_role == Role.OBSERVER:
        raise StaffError(f"The observer cannot be {_DONE[to_status]}.")

    retry = _transition(person, to_status)

    is_owner = R.is_owner(target_role)
    if is_owner and not R.is_observer(actor["role"]):
        # Owners are managed by the observer only (Phase 1A STAFF-001/003); and
        # never the last active one — counted under the lease, in `_revoke_access`.
        raise StaffError(f"Only the observer can {verb} an owner.")
    if not manages(actor, person):
        raise StaffError(f"You can only {verb} members of your own department.")

    if to_status == STATUS_ACTIVE:
        return await _restore_access(db, person, actor, reason, target_role)
    return await _revoke_access(db, person, actor, reason, to_status, target_role, retry=retry)


def _audit_collector(noun: str, uid: str, audit_failures: list[tuple[str, Exception]]):
    """`record(what, **entry)`: an audit write that is logged and COLLECTED when it
    fails, never raised (R1). A failed write must not stop a revocation half-way
    (account still active, CRM directory still open), so the caller raises once
    every revocation step has run — and is never told that a revocation missing
    an audit entry is complete; running it again records the entry."""

    async def record(what: str, **entry):
        try:
            return await audit.record(**entry)
        except Exception as exc:  # noqa: BLE001 — raised by the caller, never dropped
            log.exception("%s of %s: the %s audit entry was not written", noun, uid, what)
            audit_failures.append((what, exc))
            return None

    return record


async def _revoke_access(db, person: dict, actor: dict, reason: str, to_status: str,
                         target_role: Role, *, retry: bool) -> dict:
    """Suspend or deactivate: every step runs, and what did not happen is reported.

    `retry` (R1): the row is already in `to_status` with `revocation_outstanding`
    set by an attempt that could not finish; the steps run again to finish it.

    Order: lease (Owners) → last-active-Owner count → API sessions → the Owner's
    MFA bindings → the staff record (`is_active` + `status`) → lease given back →
    audit → storage claim → CRM directory entry → notice. The personal Firebase
    login is never touched (decision 1).
    """
    uid = str(person["uid"])
    email = str(person.get("email", ""))
    verb, noun = _VERB[to_status], _NOUN[to_status]
    is_owner = R.is_owner(target_role)

    lease = None
    if is_owner:
        lease = await _take_owner_lease(db)
        if lease is None:
            raise StaffError(
                "Another owner deactivation or suspension is in progress. Nothing was changed. "
                "Try again in a moment."
            )

    #: Audit entries that could not be written (R1): raised at the end, never dropped.
    audit_failures: list[tuple[str, Exception]] = []
    #: The parts of the revocation that did not happen, in words, and why.
    not_done: list[str] = []
    errors: list[Exception] = []
    record = _audit_collector(noun, uid, audit_failures)

    mfa_bindings_cleared = True
    active_written = True
    now = datetime.now(timezone.utc)
    try:
        if is_owner:
            # Read again under the lease: a deactivation that has just finished may
            # have changed both this record and the count.
            person = await db[C.STAFF].find_one({"uid": uid}) or person
            active_owners = await db[C.STAFF].count_documents(
                {"role": str(Role.OWNER), "is_active": True}
            )
            # An Owner already marked inactive (the revocation run again after a
            # partial failure) is not one of them, so it is not subtracted: running
            # again can never remove the last active Owner.
            if active_owners - (1 if person.get("is_active", True) else 0) < 1:
                raise StaffError(
                    "This is the last active owner. Provision another owner before "
                    f"you {verb} this one."
                )
            # And the transition again, on what the lease protects: a parallel run
            # that has just completed this one is refused as "already …".
            retry = _transition(person, to_status)
        current = status_of(person)
        #: A marker left by an earlier attempt (also on an ordinary transition away
        #: from a state that was never fully revoked): cleared by a complete run.
        had_marker = bool(person.get(OUTSTANDING_FIELD))

        # Sessions first. Whatever else fails below, the live token stops working —
        # a revocation that gets halfway should get the most valuable half done.
        await db[C.SESSIONS].update_many({"uid": uid}, {"$set": {"revoked": True}})

        # P1-A3b: an Owner's Firestore/Storage MFA bindings end with the Owner's
        # access. A binding is what lets a custom-token Firebase session act as an
        # Owner in the rules. Removed here, early, so that a failure further down
        # cannot leave one standing, and deleted rather than flagged, so that a
        # reactivation cannot bring one back. `clear_all_bindings` never raises: a
        # Firestore failure comes back as False, is audited as
        # `owner_mfa.unbind_failed`, and makes the revocation incomplete. Its audit
        # entries go through `record` like the rest (no actor is passed to it).
        if is_owner:
            from app.services import owner_mfa

            mfa_bindings_cleared = await owner_mfa.clear_all_bindings(uid, _BINDING_REASON[to_status])
            if mfa_bindings_cleared:
                await record(
                    "Owner MFA binding removal",
                    actor=actor,
                    action=audit.Action.OWNER_MFA_UNBOUND,
                    subject_type="auth.mfa",
                    subject_id=uid,
                    reason=_BINDING_REASON[to_status],
                    meta={"all": True},
                )
            else:
                not_done.append("the Owner's MFA bindings were NOT removed (Firestore write failed)")
                await record(
                    "Owner MFA binding removal failure",
                    actor=actor,
                    action=audit.Action.OWNER_MFA_UNBIND_FAILED,
                    subject_type="auth.mfa",
                    subject_id=uid,
                    reason=f"{_BINDING_REASON[to_status]}, and the MFA bindings could not be removed",
                    meta={"all": True},
                )

        # The record. Compare-and-set on the state we read, so two operators cannot
        # race a transition into a combination nobody chose. A retry re-writes the
        # same state and keeps the first attempt's reason and timestamps.
        patch: dict = {**status_patch(to_status), "updated_at": now}
        if not retry:
            patch.update({
                "status_changed_at": now,
                "status_changed_by": {"uid": actor["uid"], "name": actor.get("name", "")},
                "status_reason": reason.strip(),
            })
        # R4 (revision 4): a failed write here no longer stops the revocation with a
        # 500. The claim below is still cleared and the CRM entry switched off, and
        # the failure is reported at the end; the row still says active, so the
        # retry is an ordinary transition.
        try:
            res = await db[C.STAFF].update_one(
                {"uid": uid, "is_active": bool(person.get("is_active", True))},
                {"$set": patch},
            )
        except Exception as exc:  # noqa: BLE001 — reported below, never dropped
            log.exception("%s of %s: the staff record was not marked inactive", noun, uid)
            active_written = False
            not_done.append(f"the staff record was NOT marked inactive ({type(exc).__name__})")
            errors.append(exc)
        else:
            if getattr(res, "matched_count", 1) == 0:
                raise StaffError("This account changed while you were deciding. Reload it and try again.")
    finally:
        if lease is not None:
            await _give_back_owner_lease(db, lease)

    audit_id = await record(
        noun,
        actor=actor,
        action=_ACTION[to_status],
        subject_type="staff",
        subject_id=uid,
        reason=reason.strip(),
        before={"status": current, "is_active": current == STATUS_ACTIVE},
        after={
            "status": to_status if active_written else "NOT WRITTEN",
            "is_active": False if active_written else "NOT WRITTEN",
        },
        meta={"role": str(target_role), "personal_app_account": "unchanged",
              **({"retry": True} if retry else {})},
    )

    # ── The Storage claim and the CRM directory follow the record ────────────
    #
    # The claim is cleared BEFORE the directory write, so a directory failure
    # cannot leave the claim behind (R2: no step stops the ones after it). An ID
    # token already minted carries the claim until it expires; clearing it is
    # what keeps a later reactivation from handing the old access straight back
    # without re-granting it.
    claim_problem = await asyncio.to_thread(storage_claims.clear, uid)
    if claim_problem:
        log.warning("storage claim not cleared for %s: %s", uid, claim_problem)
        not_done.append(f"the storage role claim was NOT cleared ({claim_problem})")

    # Revoking the API session is not revoking access. `crmSignIn` reads
    # `crmUsers.isActive`, and while that still says true the person can open
    # the shell and use every Firestore-backed screen on it. Both halves, or the
    # account is only partly gone.
    #
    # R2 (revision 4): a CRM failure no longer ends the revocation here. It is
    # reported at the end with the step that fixes it — running the operation
    # again, which switches the entry off. (`scripts/repair_staff_accounts.py`
    # treats an existing entry as healthy, so it is not the fix for a stale
    # `isActive: true`; it is named only for a MISSING entry.)
    crm_document = "not changed"
    try:
        mirrored = await _carry_to_crm(
            actor=actor,
            what=f"The {noun} of {email or uid}'s access",
            reason=reason,
            uid=uid,
            email=email,
            call=lambda: crm.aset_active(
                uid=uid,
                email=email,
                role=target_role,
                is_active=False,
            ),
        )
        crm_document = mirrored.action
    except StaffError as exc:
        # `_carry_to_crm` has already audited it (`staff.mirror_failed`) and logged it.
        crm_document = "NOT switched off"
        not_done.append(
            f"the CRM directory entry was NOT switched off ({exc.__cause__ or 'directory write failed'})"
        )
        errors.append(exc)
    except Exception as exc:  # noqa: BLE001 — e.g. the CRM write failed AND its audit entry did too
        log.exception("%s of %s: the CRM directory step failed", noun, uid)
        crm_document = "NOT switched off"
        not_done.append(f"the CRM directory entry was NOT switched off ({type(exc).__name__})")
        errors.append(exc)

    # P1-F: told after the authoritative change, whatever a mirror did — the
    # person's access HAS changed at the API either way. Not again when an earlier
    # attempt already told them (keyed on its audit entry).
    if retry or had_marker:
        notified = {"in_app": False, "email": False, "note": "told by the first attempt"}
    else:
        notified = await notify_access_change(
            person=person, change=to_status, actor=actor, audit_id=str(audit_id or ""),
        )

    if active_written:
        person.update(status_patch(to_status))
    person.pop("_id", None)
    person.pop(OUTSTANDING_FIELD, None)
    person["crm_user_document"] = crm_document
    person["storage_role_claim"] = claim_problem or "cleared"
    person["personal_app_account"] = "unchanged"
    person["owner_mfa_bindings"] = (
        ("cleared" if mfa_bindings_cleared else f"NOT CLEARED - {verb} again to retry")
        if is_owner else "n/a"
    )
    person["notified"] = notified
    # Reported, never hidden: a revocation with any part outstanding is not a
    # completed revocation, and the one thing that must never happen is the caller
    # being told it is done while the person can still get in.
    person["fully_revoked"] = not (not_done or audit_failures)
    person["fully_applied"] = person["fully_revoked"]
    if not_done:
        # One searchable entry per incomplete revocation, so an operator can list
        # every revocation still outstanding.
        await record(
            "incomplete revocation",
            actor=actor,
            action=audit.Action.STAFF_REVOCATION_INCOMPLETE,
            subject_type="staff",
            subject_id=uid,
            reason=f"{noun.capitalize()} not complete: " + "; ".join(not_done),
            meta={"not_done": list(not_done)},
        )
    # The retry marker: what the next run has to finish, or nothing.
    marker_problem = await _note_outstanding(db, uid, noun, not_done, audit_failures,
                                             had=had_marker or retry)
    if not_done or audit_failures:
        cause = errors[0] if errors else (audit_failures[0][1] if audit_failures else None)
        raise StaffError(
            _incomplete(person, uid, noun, not_done, audit_failures, is_owner) + marker_problem
        ) from cause
    return person


async def _note_outstanding(db, uid: str, noun: str, not_done: list[str],
                            audit_failures: list[tuple[str, Exception]], *, had: bool) -> str:
    """Write (or remove) `revocation_outstanding` on the staff row. Best effort:
    returns "" or the sentence to append to the error when the write failed."""
    outstanding = list(not_done) + [
        f"audit entry not recorded: {what} ({type(exc).__name__})" for what, exc in audit_failures
    ]
    try:
        if outstanding:
            await db[C.STAFF].update_one({"uid": uid}, {"$set": {OUTSTANDING_FIELD: outstanding}})
        elif had:
            await db[C.STAFF].update_one({"uid": uid}, {"$unset": {OUTSTANDING_FIELD: ""}})
        return ""
    except Exception as exc:  # noqa: BLE001 — the error already names everything outstanding
        log.exception("%s of %s: the revocation_outstanding marker was not written", noun, uid)
        if not outstanding:
            return ""
        return (
            f" (The retry marker could not be written either: {type(exc).__name__}. If running the "
            f"{noun} again is refused as already done, reactivate the account and run it once more.)"
        )


def _incomplete(person: dict, uid: str, noun: str, not_done: list[str],
                audit_failures: list[tuple[str, Exception]], is_owner: bool) -> str:
    """What the caller is told when any part of a revocation did not happen."""
    done = ["API sessions ended"]
    if is_owner and str(person.get("owner_mfa_bindings")) == "cleared":
        done.append("Owner MFA bindings removed")
    if person.get("is_active") is False:
        done.append(f"staff record marked {person.get('status') or 'inactive'}")
    crm_document = str(person.get("crm_user_document", ""))
    if not crm_document.startswith("NOT"):
        done.append(f"CRM directory entry {crm_document}")
    if person.get("storage_role_claim") == "cleared":
        done.append("storage role claim cleared")
    text = f"The {noun} of {person.get('email') or uid} is NOT complete."
    if not_done:
        text += " Not done: " + "; ".join(not_done) + "."
    text += " Done: " + ", ".join(done) + "."
    if crm_document.startswith("NOT"):
        text += (f" If the CRM directory entry is missing, repair it with:  {crm.REPAIR_COMMAND}  "
                 f"(that does not correct an entry that exists but is out of date).")
    if audit_failures:
        text += " " + _unrecorded(noun, audit_failures)
    else:
        text += (f" Nothing has been undone: run the {noun} again to finish it. "
                 "Repeating it is safe.")
    text += " The person's personal Zipper app account was not touched."
    return text


def _unrecorded(noun: str, failures: list[tuple[str, Exception]]) -> str:
    """The sentence a caller gets when part of a revocation's audit trail is missing."""
    return (
        "The audit log could not record: "
        + ", ".join(f"{what} ({type(exc).__name__})" for what, exc in failures)
        + f". Nothing has been undone and the {noun} is NOT complete until it is "
        f"recorded: run the {noun} again."
    )


def _login_disabled(uid: str) -> bool:
    """Is the person's Firebase login disabled (e.g. by a pre-decision-1 deactivation)?"""
    try:
        user = firebase.get_user(uid)
    except Exception:  # noqa: BLE001
        return False
    return bool(getattr(user, "disabled", False))


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


async def _restore_access(db, person: dict, actor: dict, reason: str, target_role: Role) -> dict:
    """Reactivate (P1-B2): the record first, then the whole CRM document is
    re-mirrored (role, permissions, isActive) so a document that drifted while
    the account was out is put right, and the claim is re-granted after it."""
    uid = str(person["uid"])
    current = status_of(person)
    now = datetime.now(timezone.utc)

    # Compare-and-set on the state we read, so two operators cannot race a
    # transition into a combination nobody chose. A reactivated account has no
    # outstanding revocation: the marker goes with it.
    res = await db[C.STAFF].update_one(
        {"uid": uid, "is_active": bool(person.get("is_active", True))},
        {"$set": {**status_patch(STATUS_ACTIVE), "updated_at": now,
                  "status_changed_at": now,
                  "status_changed_by": {"uid": actor["uid"], "name": actor.get("name", "")},
                  "status_reason": reason.strip()},
         "$unset": {OUTSTANDING_FIELD: ""}},
    )
    if getattr(res, "matched_count", 1) == 0:
        raise StaffError("This account changed while you were deciding. Reload it and try again.")

    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.STAFF_REACTIVATED,
        subject_type="staff",
        subject_id=uid,
        reason=reason.strip(),
        before={"status": current, "is_active": False},
        after={"status": STATUS_ACTIVE, "is_active": True},
        meta={"role": str(target_role), "personal_app_account": "unchanged"},
    )

    mirror_error: StaffError | None = None
    try:
        mirrored = await _carry_to_crm(
            actor=actor,
            what=f"The reactivation of {person.get('email', uid)}",
            reason=reason,
            uid=uid,
            email=str(person.get("email", "")),
            call=lambda: crm.amirror(
                uid=uid,
                email=str(person.get("email", "")),
                name=str(person.get("name", "")),
                role=target_role,
                created_by=actor["uid"],
                phone=str(person.get("phone", "") or ""),
                field_charge=person.get("field_charge"),
                reports_to=person.get("reports_to"),
                is_active=True,
            ),
        )
    except StaffError as exc:
        mirror_error = exc
    claim_problem = await asyncio.to_thread(storage_claims.apply_for_role, uid, target_role)
    if claim_problem:
        log.warning("storage claim not updated for %s: %s", uid, claim_problem)

    # Told after the authoritative change, whatever a mirror did: the person's
    # access HAS changed at the API either way.
    notified = await notify_access_change(
        person=person, change=STATUS_ACTIVE, actor=actor, audit_id=str(audit_id or ""),
    )
    if mirror_error is not None:
        raise mirror_error

    person.update(status_patch(STATUS_ACTIVE))
    person.pop("_id", None)
    person.pop(OUTSTANDING_FIELD, None)
    person["crm_user_document"] = mirrored.action
    person["storage_role_claim"] = claim_problem or "granted"
    person["personal_app_account"] = "unchanged"
    person["fully_applied"] = not claim_problem
    person["notified"] = notified
    person["personal_login_disabled"] = await asyncio.to_thread(_login_disabled, uid)
    return person


# ── P1-F: telling the person ──────────────────────────────────────────────────

_CHANGE_TEXT = {
    STATUS_SUSPENDED: ("Your Zipper staff access is paused",
                       "Your staff access has been suspended. Your personal Zipper app account is not affected."),
    STATUS_DEACTIVATED: ("Your Zipper staff access has ended",
                         "Your staff access has been removed. Your personal Zipper app account is not affected."),
    STATUS_ACTIVE: ("Your Zipper staff access is restored",
                    "Your staff access has been restored. Sign in to the CRM again to continue."),
    "role_changed": ("Your Zipper staff role has changed",
                     "Your staff role is now {role}. Sign in again to see your new screens."),
}


async def notify_access_change(*, person: Mapping, change: str, actor: dict, audit_id: str,
                               new_role: str | None = None) -> dict:
    """Email + in-app notice, AFTER the authoritative change. Never raises.

    Idempotent on the audit id: the in-app notice's document id and the email's
    `dedupe_key` both name the event, so a retry delivers once. Carries no
    reason text, no credential, no employment detail — only what changed.
    A failure is recorded as `staff.notice_failed`, never swallowed silently.
    """
    from app.services import email as email_service
    from app.services import notices

    uid = str(person.get("uid", ""))
    title, body = _CHANGE_TEXT[change]
    role_label = (new_role or str(person.get("role", ""))).replace("_", " ").title()
    body = body.format(role=role_label)
    key = f"staff_{change}_{audit_id or uid}"

    in_app = await notices.deliver(uid, key, type="staff_access", title=title, body=body,
                                   meta={"change": change, "role": new_role or str(person.get("role", ""))})
    mailed = False
    try:
        row = await email_service.deliver(
            kind=f"staff.{change}",
            spec="P1-F",
            recipient=email_service.Recipient(
                email=str(person.get("email", "")), name=str(person.get("name", "")),
                role=new_role or str(person.get("role", "")), uid=uid,
            ),
            subject=title,
            html=email_service.page(title=title, preheader=body,
                                    body=f'<p style="line-height:1.6">{email_service.esc(body)}</p>'),
            sensitivity=email_service.Sensitivity.OPERATIONAL,
            dedupe_key=f"staff.{change}:{audit_id or uid}",
            meta={"change": change},
        )
        mailed = str((row or {}).get("outcome", "")) in ("sent", "delivered", "queued", "duplicate")
    except Exception as exc:  # noqa: BLE001
        log.exception("staff notice email failed for %s", uid)
        mailed = False
        row = {"error": str(exc)}
    if not in_app or not mailed:
        try:
            await audit.record(
                actor=actor, action=audit.Action.STAFF_NOTICE_FAILED, subject_type="staff",
                subject_id=uid, reason=f"Notice of '{change}' not fully delivered",
                meta={"in_app": in_app, "email": mailed, "event_audit_id": audit_id},
            )
        except Exception:  # noqa: BLE001
            log.exception("could not audit a failed staff notice for %s", uid)
    return {"in_app": in_app, "email": mailed}
