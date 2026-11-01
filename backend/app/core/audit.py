"""Append-only audit log.

Spec Part 6. Four things are always recorded: who, when, what (before → after),
and why. Entries are written inside the same transaction as the change they
describe, so a change can never exist without its history.

Nothing in this module updates or deletes. There is deliberately no such
function — not even for owners.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from motor.motor_asyncio import AsyncIOMotorClientSession

from app.core.roles import SYSTEM_ROLE
from app.db.mongo import C, get_db

# ── System actors ─────────────────────────────────────────────────────────────
#
# Most entries in this log were written by a person. A few are written by an
# unattended job holding a service credential (`app/core/security.py`). Those
# must be legible *as machine actions* at a glance — an owner scanning `/audit`
# should never have to work out whether "Weekly accrual" was a colleague.
#
# So a system actor is held to two rules the human path does not need:
# its uid is prefixed `system:`, and it has a name. And the prefix is reserved:
# a human actor cannot claim one.

SYSTEM_UID_PREFIX = "system:"


def is_system_actor(actor: Mapping[str, Any] | None) -> bool:
    return bool(actor) and str(actor.get("role", "")) == SYSTEM_ROLE


class Action:
    """Every auditable action. Spec 6.4."""

    # Money
    BALANCE_CREDIT = "balance.credit"
    BALANCE_DEBIT = "balance.debit"
    INVENTORY_CREDIT = "inventory.credit"
    INVENTORY_DEBIT = "inventory.debit"
    LENDING_ISSUE = "lending.issue"
    LENDING_REPAY = "lending.repay"
    LENDING_RECOVER = "lending.recover"
    LENDING_WRITE_OFF = "lending.write_off"
    COMMISSION_ACCRUE = "commission.accrue"
    # An accrual that was asked for and refused before anything was credited —
    # the sanity bound tripping, or a provisional slab table. Recorded because
    # a week that silently did not accrue is the failure this whole path exists
    # to prevent; the refusal has to be as visible as the accrual would be.
    COMMISSION_ACCRUE_REFUSED = "commission.accrue_refused"
    COMMISSION_PAY = "commission.pay"
    PAYOUT_EXECUTE = "payout.execute"
    WITHDRAWAL_PAY = "withdrawal.pay"
    REFUND = "refund"
    # Operating expenditure — the cost of running the company. Raised as a card
    # like any other movement of money, and paid only after an owner has signed.
    # Both entries carry the raiser's own reason, so `history_for("expense",
    # "2026-08:staff_salaries")` reads as a sentence rather than a stage change.
    EXPENSE_RAISED = "expense.raised"
    EXPENSE_PAID = "expense.paid"

    # Cards
    CARD_RAISED = "card.raised"
    CARD_VERIFIED = "card.verified"
    CARD_SIGNED = "card.signed"
    CARD_REJECTED = "card.rejected"
    CARD_EXECUTED = "card.executed"
    CARD_EXECUTION_FAILED = "card.execution_failed"

    # Partners
    PARTNER_APPROVED = "partner.approved"
    PARTNER_REJECTED = "partner.rejected"
    PARTNER_DEACTIVATED = "partner.deactivated"
    #: The role taken away. Not a deactivation (temporary, keeps the slot) and
    #: not a rejection (never approved). The record stays as history; the
    #: human's role-family slot is released. See `PartnerStatus.REVOKED`.
    PARTNER_REVOKED = "partner.revoked"
    #: An applicant filed for a partner role from the app, through the
    #: application route — as opposed to a staff member registering them.
    PARTNER_APPLIED = "partner.applied"
    #: Sub-agencies and hosts moved from a revoked agency to a replacement, or
    #: from a revoked sub-agency up to its parent. Written once per revocation
    #: with the full list, so the move is reconstructable.
    PARTNER_DEPENDENTS_TRANSFERRED = "partner.dependents_transferred"

    # Users
    #
    # ── FOUR MODERATION ACTIONS, NOT TWO AND A HALF ──────────────────────────
    #
    # Ban and Suspend are different acts and they reverse differently, so each
    # half of each pair is its own line in the log:
    #
    #   user.suspended  the account is restricted, temporarily. The DEVICE is
    #                   left alone, so another account may be used on that
    #                   handset. Reversed by `user.resumed`.
    #   user.resumed    a suspension lifted — by the nightly sweep when its term
    #                   ran out, or by a person. Touches no device.
    #   user.banned     the account is restricted and every device it has been
    #                   seen on is barred. Reversed by `user.unbanned`.
    #   user.unbanned   a ban lifted, and with it the device bans THIS account
    #                   caused. A device ban somebody placed on its own account
    #                   is not this operation's to lift and survives.
    #
    # `user.resumed` exists because un-suspending used to be done by calling
    # unban: the log said `user.unbanned` for an account that had never been
    # banned, and reading back a person's history could not tell a suspension
    # that expired from a ban a moderator decided to lift.
    USER_BANNED = "user.banned"
    USER_UNBANNED = "user.unbanned"
    USER_SUSPENDED = "user.suspended"
    USER_RESUMED = "user.resumed"
    USER_WARNED = "user.warned"
    HOST_GRANTED = "host.granted"
    HOST_REVOKED = "host.revoked"
    #: UGP-B: a revoked Host role re-activated from the person's EXISTING
    #: approved application, roster row and verification record — never a new
    #: application. Its own action so a restoration and a first grant can be
    #: told apart in a person's history.
    HOST_RESTORED = "host.restored"
    #: UGP-F (review): staff opened the signed links to an appeal's private
    #: attachments. Screenshots and videos a locked-out person sent are read
    #: only through these links, so who read them, and when, is on record.
    APPEAL_EVIDENCE_VIEWED = "appeal.evidence_viewed"
    #: A host application approved or refused. Separate from `host.granted` and
    #: `host.revoked`, which are about the *account*: one application can be
    #: decided before anybody has redeemed the referral code, and a host can be
    #: revoked for a reason that has nothing to do with the application they
    #: joined on. Both entries are written when a decision does both things, so
    #: `/audit` shows the application decision and its consequence separately.
    HOST_APPLICATION_APPROVED = "host.application_approved"
    HOST_APPLICATION_REJECTED = "host.application_rejected"
    #: A proposed change to a host's bank account, documents or legal identity,
    #: applied onto the live application by a reviewer. Separate from the two
    #: above for the same reason those are separate from `host.granted`: an
    #: application approved a year ago and a bank account changed today are
    #: different facts, and reading them as one is exactly how a redirected
    #: payout hides inside an approval nobody disputes.
    HOST_PENDING_CHANGES_APPLIED = "host.pending_changes_applied"
    HOST_PENDING_CHANGES_REJECTED = "host.pending_changes_rejected"
    #: A person confirmed, or refused to confirm, that a host is who their
    #: agency said they are. Not a cosmetic badge: approval sets
    #: `isVerifiedHost`, and the weekly payout run will not release a week for
    #: a host without it. This is the moment someone becomes payable.
    HOST_VERIFICATION_APPROVED = "host.verification_approved"
    HOST_VERIFICATION_REJECTED = "host.verification_rejected"
    SELLER_GRANTED = "user.seller_granted"
    SELLER_REVOKED = "user.seller_revoked"
    BALANCE_CHANGE_REQUESTED = "balance.change_requested"

    # Devices and moderation
    #
    # A device ban is its own act with its own entry even when a ban of an
    # account caused it, because the two have different subjects and different
    # blast radii: barring a handset locks out EVERY account on it, including
    # accounts nobody has decided anything about. `meta.source` on the entry
    # says which account caused it, or that Ops placed it on its own authority —
    # and that is what decides, later, whether an unban may lift it.
    DEVICE_BANNED = "device.banned"
    DEVICE_UNBANNED = "device.unbanned"
    REPORT_ACTIONED = "report.actioned"

    # Partner operations
    PARTNER_REACTIVATED = "partner.reactivated"
    #: A partner's login address rewritten to lower case on its Firestore
    #: document, by `scripts/normalise_partner_emails.py`. Its own action rather
    #: than a generic edit because of what it changes: `firestore.rules` binds
    #: an agency's `crmUsers` create and its `crmUid` back-link to
    #: `ownerEmail == request.auth.token.email`, and Firebase lower-cases the
    #: token address — so this is the write that turns a record its own owner
    #: was denied into one they can hold. Nothing else about the partner moves.
    PARTNER_EMAIL_NORMALISED = "partner.email_normalised"
    SALE_RECORDED = "sale.recorded"
    SALE_APPROVED = "sale.approved"
    # Manual recharge through a Coin Seller — the buyer-initiated request that
    # staff verify before any diamond moves. One action per state change so
    # the money trail reads in order: requested → approved|rejected →
    # refund_requested → refunded|refund_rejected.
    RECHARGE_REQUESTED = "recharge.requested"
    RECHARGE_APPROVED = "recharge.approved"
    RECHARGE_REJECTED = "recharge.rejected"
    RECHARGE_REFUND_REQUESTED = "recharge.refund_requested"
    RECHARGE_REFUNDED = "recharge.refunded"
    RECHARGE_REFUND_REJECTED = "recharge.refund_rejected"
    SUBAGENCY_PAID_PARENT = "subagency.paid_parent"
    SUBAGENCY_PARENT_PAID_SUB = "subagency.parent_paid_sub"

    # Configuration
    RATE_CHANGED = "rate.changed"
    CONFIG_CHANGED = "config.changed"

    # Access
    STAFF_CREATED = "staff.created"
    STAFF_ROLE_CHANGED = "staff.role_changed"
    STAFF_DEACTIVATED = "staff.deactivated"
    #: P1-B3 — staff access paused (reversible). Distinct from a deactivation.
    STAFF_SUSPENDED = "staff.suspended"
    #: P1-B2 — a suspended or deactivated staff member's access restored.
    STAFF_REACTIVATED = "staff.reactivated"
    #: P1-F — a notice (email / in-app) about an access change could not be delivered.
    STAFF_NOTICE_FAILED = "staff.notice_failed"

    # P1-D — ticket workflows, written by the server only (services/tickets.py).
    TICKET_CREATED = "ticket.created"
    TICKET_UPDATED = "ticket.updated"
    TICKET_ROUTED = "ticket.routed"
    #: The audit entry for a change was written and the Firestore write failed.
    TICKET_UPDATE_FAILED = "ticket.update_failed"
    #: P1-A3 — Owner multi-factor authentication. No entry carries a secret,
    #: a code or a recovery code.
    OWNER_MFA_ENROLLED = "owner_mfa.enrolled"
    OWNER_MFA_VERIFIED = "owner_mfa.verified"
    OWNER_MFA_FAILED = "owner_mfa.failed"
    OWNER_MFA_LOCKED = "owner_mfa.locked"
    OWNER_MFA_RECOVERY_USED = "owner_mfa.recovery_code_used"
    OWNER_MFA_CODES_REGENERATED = "owner_mfa.recovery_codes_regenerated"
    OWNER_MFA_RESET = "owner_mfa.reset"
    #: P1-A3b — a Firebase sign-in bound to / released from an MFA-verified API
    #: session (the Firestore/Storage Owner boundary). Never carries a token.
    OWNER_MFA_MINTED = "owner_mfa.minted"
    OWNER_MFA_BOUND = "owner_mfa.bound"
    OWNER_MFA_BIND_FAILED = "owner_mfa.bind_failed"
    OWNER_MFA_UNBOUND = "owner_mfa.unbound"
    #: MFA release, revision 4: an Owner's bindings could NOT be removed (a
    #: Firestore failure during a deactivation, a suspension or a role change).
    #: Until a retry removes them, a bound Firebase session may still pass the
    #: rules' Owner check, so it is searchable rather than only logged.
    OWNER_MFA_UNBIND_FAILED = "owner_mfa.unbind_failed"
    #: Salary, employment id, joining date or field charge set on a staff record
    #: by an owner or a team admin. Separate from `staff.role_changed` because it
    #: changes no authority at all — and separate from nothing, because it is the
    #: only place a pay figure is ever written and somebody has to be able to ask
    #: who wrote it. The before/after on the entry carries the amounts.
    STAFF_EMPLOYMENT_CHANGED = "staff.employment_changed"
    # A staff change that landed in Mongo and did not land in the Firestore
    # `crmUsers` directory the CRM shell reads. The account is half-created:
    # authoritative and unusable. Recorded as its own action because a partial
    # failure that only appeared in an error the caller could dismiss is how the
    # broken accounts got there in the first place — this is what
    # `scripts/repair_staff_accounts.py` exists to clear up.
    STAFF_MIRROR_FAILED = "staff.mirror_failed"
    #: A half-written account put back together after the fact, by
    #: `scripts/repair_staff_accounts.py`. Separate from `staff.created` because
    #: the account was not created here — it already existed, in one place.
    STAFF_MIRROR_REPAIRED = "staff.mirror_repaired"
    #: The Firebase login could not be disabled during a revocation.
    #:
    #: Its own action rather than a line in `staff.deactivated`, because this is
    #: the one part of a revocation that nothing else compensates for: the Mongo
    #: flag and the CRM document can both be re-applied by a repair, while a
    #: Firebase account left enabled is a working credential for somebody whose
    #: access was withdrawn. Searchable, so an operator can find every revocation
    #: that is still outstanding rather than relying on an error message that was
    #: shown once and dismissed.
    STAFF_FIREBASE_REVOKE_FAILED = "staff.firebase_revoke_failed"
    #: MFA release, revision 4: a deactivation (or suspension) that did not
    #: finish — any of the MFA bindings, the staff record, the CRM directory
    #: entry or the storage claim left as it was. One entry per attempt, listing
    #: what is outstanding (`meta.not_done`), so an operator can find every
    #: revocation that still has to be run again. The caller got an error, never
    #: a success. (P1 decision 1: the personal Firebase login is never part of a
    #: staff revocation, so it is never on this list.)
    STAFF_REVOCATION_INCOMPLETE = "staff.revocation_incomplete"

    #: A BAN was recorded but the Firebase credential behind it was not revoked.
    #:
    #: The sibling of `staff.firebase_revoke_failed`, and it exists for the same
    #: reason: the account is barred in our records while the credential that
    #: reaches the app is still live, and that is a state somebody has to go and
    #: finish by hand. Searchable so an operator can list every one that is
    #: still outstanding, rather than relying on a log line nobody is watching.
    USER_FIREBASE_REVOKE_FAILED = "user.firebase_revoke_failed"

    #: A mobile session was replaced by a sign-in on another device.
    #:
    #: Recorded against the account, not against a person, because the actor is
    #: the account itself. It is the only evidence that a displacement happened
    #: at all — the displaced device learns about it and nothing else did.
    SESSION_DISPLACED = "session.displaced"

    #: A session was given up deliberately. There was no logout event at all
    #: before this: a signed-out session was indistinguishable in the log from
    #: one that simply stopped being used.
    SESSION_ENDED = "session.ended"

    LOGIN_SUCCEEDED = "login.succeeded"
    LOGIN_FAILED = "login.failed"
    EXPORT = "export"


def _entry(
    *,
    actor: dict,
    action: str,
    subject_type: str,
    subject_id: str,
    reason: str,
    before: Any = None,
    after: Any = None,
    card_id: str | None = None,
    meta: dict | None = None,
) -> dict:
    uid = str(actor.get("uid", "") or "")
    name = str(actor.get("name", "") or "")

    if is_system_actor(actor):
        # An unattended actor with a blank name, or one wearing a uid that does
        # not announce itself as a machine, would read in `/audit` as a person.
        # Refuse to write it rather than produce an entry that misleads.
        if not uid.startswith(SYSTEM_UID_PREFIX) or not name:
            raise ValueError(
                "A system actor must have a name and a uid beginning "
                f"'{SYSTEM_UID_PREFIX}'. Got uid={uid!r}, name={name!r}."
            )
    elif uid.startswith(SYSTEM_UID_PREFIX):
        # The prefix is reserved. A human — or anything else with a role — may
        # not borrow it and hide behind the machine.
        raise ValueError(
            f"'{SYSTEM_UID_PREFIX}' uids are reserved for system actors; "
            f"{uid!r} carries role {actor.get('role', '')!r}."
        )

    return {
        "at": datetime.now(timezone.utc),
        "actor": {
            "uid": uid,
            "name": name,
            "role": actor.get("role", ""),
            "team": actor.get("team"),
            # Present and true only for a machine, so an owner reading the log
            # can filter on one field instead of pattern-matching a uid.
            "is_system": is_system_actor(actor),
        },
        "action": action,
        "subject": {"type": subject_type, "id": subject_id},
        "before": before,
        "after": after,
        "reason": reason,
        "card_id": card_id,
        "meta": meta or {},
    }


async def record(
    *,
    actor: dict,
    action: str,
    subject_type: str,
    subject_id: str,
    reason: str,
    before: Any = None,
    after: Any = None,
    card_id: str | None = None,
    meta: dict | None = None,
    session: AsyncIOMotorClientSession | None = None,
) -> str:
    """Write one audit entry.

    Pass the `session` of the transaction performing the change. Without it the
    entry is not atomic with the change, which defeats the point — so callers
    that mutate money must always pass one.
    """
    if not reason or not reason.strip():
        raise ValueError("An audit entry requires a reason. Spec 6.1.4.")

    doc = _entry(
        actor=actor,
        action=action,
        subject_type=subject_type,
        subject_id=subject_id,
        reason=reason.strip(),
        before=before,
        after=after,
        card_id=card_id,
        meta=meta,
    )
    result = await get_db()[C.AUDIT].insert_one(doc, session=session)
    return str(result.inserted_id)


async def query(
    *,
    scope: str,
    actor_uid: str | None = None,
    actor_team: str | None = None,
    filters: dict | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict]:
    """Read the audit log, constrained by the caller's scope. Spec 6.3.

    Entries written by a system actor behave like any other: `"all"` sees them
    (so owners and the observer do), and `"team"` does not, because a machine
    has no team — the same reason an owner's own entries are outside a team
    admin's scope. Filter them with `filters={"actor.is_system": True}` or by
    `actor.uid`; both are ordinary fields on the entry.
    """
    q: dict = dict(filters or {})

    if scope == "team":
        if not actor_team:
            return []
        q["actor.team"] = actor_team
    elif scope == "self":
        if not actor_uid:
            return []
        q["actor.uid"] = actor_uid
    elif scope != "all":
        return []

    cursor = get_db()[C.AUDIT].find(q).sort("at", -1).skip(skip).limit(min(limit, 500))
    out = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        out.append(doc)
    return out


async def history_for(subject_type: str, subject_id: str, limit: int = 200) -> list[dict]:
    """Everything that ever happened to one record — the answer to
    'reconstruct what happened to this account and who did it'."""
    cursor = (
        get_db()[C.AUDIT]
        .find({"subject.type": subject_type, "subject.id": subject_id})
        .sort("at", -1)
        .limit(min(limit, 500))
    )
    out = []
    async for doc in cursor:
        doc["id"] = str(doc.pop("_id"))
        out.append(doc)
    return out
