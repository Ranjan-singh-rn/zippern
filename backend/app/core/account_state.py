"""ONE authoritative answer to "is this account still allowed in?".

── The state this exists for ────────────────────────────────────────────────

Before this module, the per-request account-state check was a single line
inside `_confirm_role_on_record`, reachable only from `require_permission`. That
covered 22 route mounts. Everything else — every `require_internal`,
`require_owner`, `require_team_admin` and bare `require_write` route, and every
route carrying only `current_user` — checked nothing at all.

For a **partner** it was worse than partial: there was no per-request state
check anywhere. `own_partner_id_or_403` compares a requested id against the
session's own claim, never against `partners.status`. A partner suspended by any
path that does not call `_revoke_partner_sessions` kept a working session until
it expired, seven days later.

The holes are not theoretical. `renew_session` already names the three doors a
change arrives through that revoke nothing: "a script, a migration or a hand
edit". `services/partner_ops` revokes on reject and deactivate and on nothing
else — not on a second-role grant, not on an approval that moved a capability.

── What this does about it ──────────────────────────────────────────────────

`current_user` now consults this on EVERY authenticated request, for every
identity type, against the record that is entitled to answer:

    staff / owner / observer  →  Mongo `staff`     : row exists, `is_active`
    agency / seller           →  Mongo `partners`  : `status`, `is_active`

── Why it is cached, and what the cache costs ───────────────────────────────

Re-reading on every request is a second round trip per call. The answer is
therefore stamped on the session document — which `verify_session` already reads
— and refreshed at most every `auth_state_recheck_seconds`.

That bounds both sides of the trade honestly:

  * cost       : one extra read and one extra write per session per interval,
                 not per request
  * staleness  : a deactivation is honoured within the interval even when
                 nothing revoked the session

Set the interval to 0 to check on every request. The default is 60 seconds.

**Revocation is still the primary control**, and this is the backstop. A change
that revokes takes effect on the very next request through the `revoked` flag,
with no window at all. This module exists for the changes that do not.

── And the app account behind the session (C4) ──────────────────────────────

After the record above has answered, every session is also asked whether the
APP account of the same uid is suspended or banned — `users/{uid}` in
Firestore, the one record that says so. Suspending or banning an account used
to stop the app and leave the same person's agency or coin-seller portal fully
working. The read is best effort: an unreadable document refuses nobody,
because moderation also revokes the sessions outright (`services/users`) and
this is the backstop for the ones that predate it.

── What it deliberately does NOT do ─────────────────────────────────────────

It does not read `crmUsers`. `crmUsers.isActive` is read by `firestore.rules`,
which runs in Google's infrastructure and not in this process; a stale mirror is
a separate failure with its own repair script and its own audit entry.

It does not decide authorisation. Whether this account may perform the action is
`roles.py` and the permission dependencies. This answers only whether the
account may act at all.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from app.config import settings
from app.core import roles as R

log = logging.getLogger("zipper.account_state")


class AccountRefused(Exception):
    """This account may not act. The message is shown to the person."""

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message)
        self.message = message
        #: A short machine-readable cause, for logs and for the client to branch
        #: on. Never includes a name, an address or anything about the actor.
        self.reason = reason


#: Stamped on the session document so the answer can be reused.
CHECKED_AT_FIELD = "state_checked_at"


# ══════════════════════════════════════════════════════════════════════════════
#  The authoritative verdicts — pure, and therefore directly testable
# ══════════════════════════════════════════════════════════════════════════════


def staff_refusal(row: Mapping[str, Any] | None) -> AccountRefused | None:
    """Why this staff row may not act, or None.

    `row` is a Mongo `staff` document, or None when there is no row.
    """
    if row is None:
        # Every internal session is minted from a staff row. Its absence means
        # the row went away under a live token — a reset, a deletion, a repair
        # that moved the uid. There is no record to establish anything from.
        return AccountRefused(
            "Your staff record could not be found. Sign in again.",
            reason="staff_record_missing",
        )
    # P1-B3: `is_active` decides; `status` only names which kind of inactive.
    if not row.get("is_active", True):
        if str(row.get("status") or "") == "suspended":
            return AccountRefused(
                "This staff account is suspended. Your personal app account is not affected.",
                reason="staff_suspended",
            )
        return AccountRefused(
            "This account has been deactivated.",
            reason="staff_deactivated",
        )
    return None


def partner_refusal(record: Mapping[str, Any] | None) -> AccountRefused | None:
    """Why this partner record may not act, or None.

    `record` is a Mongo `partners` document, or None when there is no record.

    The vocabulary is `services/partners.PartnerStatus`. It is read as a string
    rather than imported as an enum so that an unrecognised value — a hand edit,
    a half-finished migration — **refuses** rather than comparing unequal to
    every branch and falling through to allow.
    """
    if record is None:
        return AccountRefused(
            "Your partner record could not be found. Sign in again.",
            reason="partner_record_missing",
        )

    status = str(record.get("status", "") or "").strip().lower()
    # Decision 15 (RC): approved, not started. Said before the inactive check,
    # because the record IS inactive and "deactivated" would be untrue.
    if status == "awaiting_verification":
        return AccountRefused(
            "Your role has been approved. It starts once both your phone number and "
            "your email address are verified on this account.",
            reason="partner_awaiting_verification",
        )

    # §5 / §6 (B2): a REVOKED role is refused as revoked — its own reason, said
    # before the inactive check (a revoked record is inactive too, and
    # "deactivated" would hide the one fact the person and the CRM need: the
    # way back is a reinstatement request the Owner decides).
    if status == "revoked":
        return AccountRefused(
            "This role was revoked. You can request reinstatement from the app.",
            reason="partner_revoked",
        )

    if record.get("is_active") is False:
        return AccountRefused(
            "This account has been deactivated.",
            reason="partner_deactivated",
        )

    if status == "approved":
        return None
    if status == "pending":
        return AccountRefused(
            "Your application is still under review.",
            reason="partner_pending",
        )
    if status == "rejected":
        return AccountRefused(
            "This application was not approved.",
            reason="partner_rejected",
        )
    if status == "suspended":
        return AccountRefused(
            "This account has been deactivated.",
            reason="partner_suspended",
        )
    # Unknown: fail closed, and say so in the log rather than to the person.
    log.warning("Partner record carries an unrecognised status %r; refusing.", status)
    return AccountRefused(
        "This account cannot be used at the moment.",
        reason="partner_status_unknown",
    )


#: C4 — the refusal for a session whose APP account is suspended or banned.
ACCOUNT_RESTRICTED_MESSAGE = (
    "This account is suspended or banned. Partner access is closed until it is lifted."
)

#: `users/{uid}.accountState` values that restrict an account. The same two
#: `services/users.restriction_of` reads; the deletion states are a different
#: question with a different answer and are not restrictions here.
_RESTRICTED_STATES = frozenset({"suspended", "banned"})


def app_account_refusal(user_doc: Mapping[str, Any] | None) -> AccountRefused | None:
    """Why the APP account behind a session refuses it, or None. Pure.

    `user_doc` is `users/{uid}`, or None when there is none — an account with
    no app document has no app restriction to honour.
    """
    if not user_doc:
        return None
    state = str(user_doc.get("accountState") or "").strip().lower()
    if (
        state in _RESTRICTED_STATES
        or user_doc.get("isBanned") is True
        or user_doc.get("isSuspended") is True
    ):
        return AccountRefused(ACCOUNT_RESTRICTED_MESSAGE, reason="account_restricted")
    return None


def _read_app_account(uid: str) -> dict | None:
    """Blocking — `users/{uid}`, or None when absent or unreadable."""
    from app.db import firebase

    try:
        snap = firebase.firestore_client().collection("users").document(uid).get()
    except Exception as exc:  # noqa: BLE001 — unreadable refuses nobody; see the module note
        log.warning("users/%s could not be read for the account check: %s", uid, exc)
        return None
    if not getattr(snap, "exists", False):
        return None
    return snap.to_dict() or {}


async def app_account_refusal_for(uid: str) -> AccountRefused | None:
    """C4 — the app-account refusal for a uid, read now. Used at sign-in,
    renewal and on every session re-check."""
    import asyncio

    uid = str(uid or "").strip()
    if not uid:
        return None
    return app_account_refusal(await asyncio.to_thread(_read_app_account, uid))


def is_due(checked_at: Any, *, now: datetime | None = None, interval: int | None = None) -> bool:
    """Is the cached answer old enough to re-read?

    A missing or unparseable stamp is **due** — an answer we cannot date is not
    an answer we may rely on.
    """
    seconds = settings.auth_state_recheck_seconds if interval is None else interval
    if seconds <= 0:
        return True
    if not isinstance(checked_at, datetime):
        return True
    moment = now or datetime.now(timezone.utc)
    stamp = checked_at if checked_at.tzinfo else checked_at.replace(tzinfo=timezone.utc)
    return (moment - stamp) >= timedelta(seconds=seconds)


# ══════════════════════════════════════════════════════════════════════════════
#  The per-request check
# ══════════════════════════════════════════════════════════════════════════════


async def assert_may_act(user: Mapping[str, Any]) -> None:
    """Refuse unless the account behind this session may still act.

    Raises `AccountRefused`. The caller turns that into an HTTP status; this
    module does not import FastAPI, so that it stays usable from a script and
    directly testable.

    A **service actor** is exempt: it has no account to deactivate, its authority
    is the credential itself, and `verify_service_key` has already established
    that. A machine credential is withdrawn by removing it from the environment.
    """
    from app.db.mongo import C, get_db

    role = user.get("role")
    if role is not None and R.is_system(role):
        return

    jti = str(user.get("jti", "") or "")
    uid = str(user.get("uid", "") or "")
    if not uid:
        raise AccountRefused(
            "This session names no account.", reason="session_without_account"
        )

    db = get_db()

    # The cached answer lives on the session document, which `verify_session`
    # has already read — but it read it before this function was called, and
    # re-reading one indexed document is cheaper than threading it through every
    # caller. Skipped entirely when the interval is 0.
    if jti and settings.auth_state_recheck_seconds > 0:
        record = await db[C.SESSIONS].find_one(
            {"jti": jti}, {CHECKED_AT_FIELD: 1}
        )
        if record is not None and not is_due(record.get(CHECKED_AT_FIELD)):
            return

    refusal = await _read_authoritative_refusal(db, user, uid, role)
    if refusal is not None:
        log.info(
            "Refusing session %s for %s: %s",
            jti[:8] or "<none>",
            uid,
            refusal.reason,
        )
        raise refusal

    if jti and settings.auth_state_recheck_seconds > 0:
        await db[C.SESSIONS].update_one(
            {"jti": jti},
            {"$set": {CHECKED_AT_FIELD: datetime.now(timezone.utc)}},
        )


async def _read_authoritative_refusal(
    db: Any, user: Mapping[str, Any], uid: str, role: Any
) -> AccountRefused | None:
    """Read the record entitled to answer, and ask it — then the app account."""
    from app.db.mongo import C

    if role is not None and R.is_external(role):
        # A partner session carries a capability → partner id map. EVERY record
        # it names must still be good: holding one approved capability does not
        # entitle the session to keep carrying a suspended one.
        #
        # An applicant under review has no ids: `own_partner_id_or_403`
        # already refuses every scoped route for that session, so there is no
        # record to re-check, and refusing here would stop them reading their
        # own waiting room. Their app account is still checked below.
        partner_ids = dict(user.get("partner_ids") or {})
        for capability, partner_id in partner_ids.items():
            record = await db[C.PARTNERS].find_one({"_id": str(partner_id)})
            refusal = partner_refusal(record)
            if refusal is not None:
                log.info(
                    "Partner capability %s (%s) refused: %s",
                    capability,
                    partner_id,
                    refusal.reason,
                )
                return refusal
    else:
        row = await db[C.STAFF].find_one({"uid": uid})
        refusal = staff_refusal(row)
        if refusal is not None:
            return refusal

    # C4 — after the partner/staff answer, for EVERY session: a suspended or
    # banned app account closes the same uid's CRM access. Staff protected from
    # moderation cannot be restricted, so this changes nothing for them.
    return await app_account_refusal_for(uid)
