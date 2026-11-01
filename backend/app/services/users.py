"""Users, moderation, device bans and the reports queue.

Spec 5.6. A user is app runtime state, so the profile itself stays in Firestore
where the Android app reads it. What Mongo owns is the *record of what was done
to that account*: every function here writes an audit entry naming the real
actor, with before → after values. Moderation used to record the literal string
"Admin", which attributed nothing to nobody — `user_history` exists so an
account can be reconstructed and every action traced to a person.

Two rules shape the module:

  * **Moderation is direct.** A ban, warning or host grant takes effect
    immediately — no owner signature (5.6).
  * **Money is never direct.** A balance change becomes a card on the money
    board and moves nothing until an owner signs it and execution runs.

And one distinction, because getting it wrong is what this module was last
rebuilt for: **a suspension is not a ban**. A suspension restricts an account
and leaves the handset alone, so another account may be used on the same phone;
a ban bars every device the account has been seen on. They are therefore lifted
by different operations — Resume and Unban — which refuse each other's cases by
name. See the block above `ban_user`.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId
from pymongo.errors import DuplicateKeyError
from firebase_admin import firestore as fb_firestore
from google.cloud.firestore_v1.base_query import BaseQuery, FieldFilter

from app.core import audit
from app.services import money_freeze
from app.core.compat import StrEnum
from app.core.roles import INTERNAL_ROLES, Role, Team
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import cards
from app.services.cards import CardError, CardType, NewCard, Stage
from app.services.money import (
    Currency,
    DuplicateMovement,
    HolderType,
    InsufficientBalance,
    Movement,
    apply_movement,
)

log = logging.getLogger(__name__)


# ── Firestore layout ──────────────────────────────────────────────────────────

USERS = "users"
WARNINGS = "warnings"          # subcollection of users/{uid}
#: Every device an account has signed in from, written by `rememberDevice` in
#: `functions/src/identity.ts` on each `startMobileSession`. It replaces
#: `users/{uid}.deviceId`, which was written ONCE at profile setup and never
#: refreshed — so "ban the device this account uses" banned the handset they
#: signed up on, possibly sold since, while the phone in their hand stayed
#: clean. `ban_user` bars every document in here.
DEVICES = "devices"            # subcollection of users/{uid}
BANNED_DEVICES = "bannedDevices"
REPORTS = "reports"
#: The user-facing inbox — the app's "Official" tab. Top-level, addressed by
#: `userId`.
#:
#: `userId` and NOT `targetUid`, because `userId` is what the deployed rule
#: enforces (`firestore.rules:2651`):
#:
#:     allow read: if request.auth != null
#:                 && resource.data.userId == request.auth.uid
#:
#: The four writers in `functions/src/index.ts` emit `targetUid`, so every
#: notification they have ever written is unreadable by the person it
#: addresses — the rule matches no field and denies the read. The rule is live
#: and verified and is not being changed in this task, so this writer is
#: written to match it, and those four are corrected to match it too.
NOTIFICATIONS = "notifications"
#: The invitation an agency files for a host it wants to recruit. Written by the
#: Invite Host modal on /agency-dashboard, decided by `decide_host_application`
#: below, and read by `checkReferralCode` / `activateHost` in the app.
HOST_APPLICATIONS = "hostApplications"

MAX_READ = 500                 # nothing here ever reads an unbounded collection


class UserError(Exception):
    """Rejected by a moderation rule. The message is safe to show the caller."""


class UserNotFound(UserError):
    """The subject does not exist."""


class DecisionNotRecordedError(UserError):
    """HT-2 — a decision's effects are committed, but the decision is not recorded.

    The account was updated under the decision lease, and the application's
    stamp could not be confirmed (twice). The lease is given back by the
    caller, so deciding again is possible at once — and safe: an approval finds
    the Host already granted from this agency (B22) and only records it; a
    refusal finds nothing left to revoke. `outcome` is "not_applied" or
    "unknown" (409 / 503).
    """

    def __init__(self, message: str, *, outcome: str) -> None:
        super().__init__(message)
        self.outcome = outcome
        self.status_code = 503 if outcome == "unknown" else 409


class LiveStepNotConfirmed(UserError):
    """HT-2 — a Firestore write keyed for retry could not be confirmed, and it is not there.

    A live balance debit or a warning: re-read after the failure, its record is
    absent. 409 when the database aborted it, 503 when the outcome is unknown
    (it may still land). Repeating the same request (the same card, the same
    request id) is safe: it is keyed, so it cannot act twice.
    """

    def __init__(self, message: str, *, outcome: str) -> None:
        super().__init__(message)
        self.outcome = outcome
        self.status_code = 503 if outcome == "unknown" else 409


class HostContactVerificationRequired(UserError):
    """Decision 15 (RC): the Host role cannot start — both contacts are not verified."""

    def __init__(self, verification, message: str):
        super().__init__(message)
        self.verification = verification

    def api_detail(self) -> dict:
        from app.services import contact_verification  # local: keeps the import graph acyclic

        return contact_verification.refusal_detail(self.verification, str(self))


class ProtectedTarget(UserError):
    """This uid may not be acted on through ordinary user management.

    Mapped to 403 rather than 400 by `routers/users._fail`: the request is
    well-formed and the caller is authenticated, they are simply not permitted
    against this subject.
    """


class OwnerOnly(UserError):
    """C2: this decision is the Owner's — restoring a revoked role.

    Mapped to 403 by `routers/users._fail`, like `ProtectedTarget`: the request
    is well-formed, the caller simply is not the one who may make it.
    """


#: C2 — the sentence a non-Owner gets for restoring a revoked Host role.
OWNER_ONLY_RESTORE = (
    "Only the Owner can restore a revoked role. Recommend it on the person's "
    "reinstatement request instead."
)


def _actor_is_owner(actor: dict | None) -> bool:
    from app.core.roles import is_owner_value

    return is_owner_value((actor or {}).get("role"))


# ── WHO MAY NOT BE TARGETED THROUGH ORDINARY USER MANAGEMENT ─────────────────
#
# An internal identity — Owner, Observer, or any department role — that has
# also signed into the Android app has a `users/{uid}` document like anybody
# else. `/users` in the CRM pages that collection with no staff exclusion, so
# the Owner appeared in the list with Ban, Suspend, Grant host and Make seller
# beside their name, and NOTHING IN THE BACKEND REFUSED. `ban_user` loaded the
# document and patched it; the only accidental protection was that an owner
# who had never opened the app had no document to load.
#
# ── THE AUTHORITY IS MONGO, AND ONLY MONGO ───────────────────────────────────
#
# Not `crmUsers.role` (client-written for partners), not `isHost`/`isSeller`
# on the user document (app flags, not identity), not anything the caller
# sends. The Mongo `staff` collection is the one record no client can write —
# it is created solely by `POST /staff` behind `require_write` +
# `can_manage_team`.
#
# ── MATCHED ON uid ALONE, AND THAT IS DELIBERATE ─────────────────────────────
#
# An earlier version of this also matched the subject's EMAIL against the
# staff collection, reasoning that the Observer's Mongo row carries a
# synthetic uid (`observer:<email>`) that a uid lookup can never find. A test
# of that branch showed it was either redundant or actively wrong:
#
#   * For staff WITH a Firebase account, the email adds nothing. Firebase
#     enforces one account per address and the staff row carries that
#     account's uid, so the uid match has already fired.
#
#   * For the Observer, which has NO Firebase account, an app document
#     bearing `314zipper@gmail.com` is not the Observer. That address is
#     unclaimed precisely because there is no account behind it, so anybody
#     could register it — and the resulting app user is a stranger, who
#     should be bannable like any other. `core/security.py` already refuses
#     them an observer SESSION; protecting their app account would hand an
#     impostor immunity the real Observer never needed.
#
# The Observer is unreachable here anyway: `inspect_identity` confirms it has
# no `users/{uid}` document, so `_load_user` raises `UserNotFound` before any
# of this is consulted.


def _is_internal_role(raw: object) -> bool:
    """Is this staff row an internal identity? Unknown strings count as yes.

    Fail-closed deliberately. A role this build does not recognise sitting in
    the staff collection is far more likely to be an internal role added after
    this code shipped than an external one, and the cost of the two mistakes
    is not symmetrical: wrongly protecting an account means somebody files a
    ticket, wrongly exposing one means an Owner can be banned from the API.
    """
    text = str(raw or "").strip()
    if not text:
        return True
    try:
        return Role(text) in INTERNAL_ROLES
    except ValueError:
        return True


async def protected_staff_row(uid: str) -> dict | None:
    """The Mongo staff row protecting this subject, or None.

    Read-only. Returns the row rather than a bool so callers can name the
    person in an audit entry or an error.
    """
    uid = (uid or "").strip()
    if not uid:
        return None

    row = await get_db()[C.STAFF].find_one({"uid": uid})
    if row is None:
        return None
    return row if _is_internal_role(row.get("role")) else None


async def ensure_ordinary_target(uid: str, actor: dict, *, action: str) -> None:
    """Refuse an ordinary user-management action on a protected subject.

    Two refusals, and they are different rules:

    * **self** — nobody moderates their own account, whoever they are. The
      only self-target guard that existed anywhere in this API was
      `staff.deactivate`'s, which covers one function.
    * **internal staff** — an Owner, the Observer or any department role is
      managed through the staff APIs (`POST /staff`, `PATCH
      /staff/{uid}/role`, `POST /staff/{uid}/deactivate`), which carry their
      own authority rules. Those are untouched; this closes the side door.

    One Mongo read, on a collection holding five rows in production.
    """
    uid = (uid or "").strip()
    actor_uid = str(actor.get("uid", "")).strip()

    if uid and uid == actor_uid:
        raise ProtectedTarget(
            f"You cannot {action} your own account. If this needs doing, it "
            "goes through another member of staff."
        )

    row = await protected_staff_row(uid)
    if row is not None:
        raise ProtectedTarget(
            f"{row.get('email') or uid} is an internal {row.get('role', 'staff')} "
            f"account and cannot be {action}ed through user management. Internal "
            "accounts are managed through the staff APIs."
        )


class DeviceType(StrEnum):
    ANDROID_ID = "android_id"
    IMEI = "imei"


class AccountState(StrEnum):
    """`users/{uid}.accountState` — which state an account is in.

    **The values are shared with `functions/src/accounts.ts`** (`STATE_ACTIVE`,
    `STATE_RECOVERY_PENDING`, `STATE_PERMANENTLY_DEACTIVATED`) and with the
    `Decision` union in `functions/src/identity.ts`. Three runtimes read this
    field — Python here, TypeScript in the Cloud Functions, Kotlin in the app —
    and none of them can import from another, so the strings are duplicated and
    each copy says so. If one changes they all must.

    ── WHY THIS FIELD AND `isBanned` BOTH EXIST ──────────────────────────────

    `isBanned` is the app's single gate: rules, Cloud Functions and the Android
    client all read it, and it means "this account cannot use the product". It
    is true for BOTH a suspension and a ban, and it stays that way — widening
    every reader of it to understand two flags would be a much larger and much
    riskier change than adding a field that says which.

    `accountState` is that field. `isBanned` says whether the account is shut
    out; `accountState` says why, and therefore what will let it back in:

        suspended  temporary, the DEVICE is untouched, lifted by Resume.
        banned     the account and every device it was seen on, lifted by Unban.

    `isSuspended` stays as well, because the CRM's user screen renders it and
    `lift_expired_suspensions` queries on it — Firestore cannot filter on "this
    field is one of these two values" as cheaply as on a boolean.

    A document written before this field existed has none, and `restriction_of`
    below is what reads those correctly rather than treating them as active.
    """

    ACTIVE = "active"
    #: Deletion requested, inside the grace window. Recoverable in one tap.
    RECOVERY_PENDING = "recovery_pending"
    #: Grace elapsed. The login is gone and the identity released; the history
    #: stays for the life of the CRM.
    PERMANENTLY_DEACTIVATED = "permanently_deactivated"
    #: Restricted by a moderator, temporarily. Set by `suspend_user`.
    SUSPENDED = "suspended"
    #: Restricted by a moderator, and every device barred. Set by `ban_user`.
    BANNED = "banned"


class ReportAction(StrEnum):
    WARN = "warn"
    SUSPEND = "suspend"
    BAN = "ban"
    #: Take beans back. Raises a card an owner signs — it does NOT move a
    #: balance here. A moderator who can debit an account on their own word is
    #: a moderator who can quietly take money, and the whole point of the board
    #: is that value moves only with a second signature.
    DEDUCT = "deduct"
    DISMISS = "dismiss"


class ReportStatus(StrEnum):
    PENDING = "pending"
    REVIEWED = "reviewed"
    ACTIONED = "actioned"
    DISMISSED = "dismissed"


# ── There used to be a second `class Action` here ─────────────────────────────
#
# It declared eleven names and collided BY VALUE with `audit.Action` on nine of
# them — `user.suspended`, `device.banned`, `device.unbanned`, `report.actioned`,
# the seller pair, the balance request. Its docstring justified itself by saying
# `audit.Action` "has no entry for device bans, the reports queue, the seller
# flag or a balance request", and that had stopped being true: every one of those
# is declared there. So the log was written from two enumerations that happened
# to agree, and the next person to add a value to one of them would have found
# out they disagreed by reading `/audit`.
#
# There is one enumeration now. The four host-application names that really were
# only here have moved to `audit.Action` beside the rest, and every call site in
# this module says `audit.Action.…`.


# The currencies a user can actually hold. Coins belong to sellers and
# commission to agencies — neither can be credited to a user account.
USER_CURRENCIES: frozenset[Currency] = frozenset({Currency.DIAMONDS, Currency.BEANS})


# ── Firestore plumbing ────────────────────────────────────────────────────────


async def _fs(fn: Callable, *args, **kwargs):
    """Run a synchronous Firestore call off the event loop.

    The Admin SDK client is blocking. Mongo work goes through motor, so a
    blocking Firestore call in the same request would be the only thing
    stalling the loop.
    """
    return await asyncio.to_thread(fn, *args, **kwargs)


def _user_ref(uid: str):
    if not uid or not uid.strip():
        raise UserError("A user id is required.")
    return firebase.firestore_client().collection(USERS).document(uid.strip())


async def _load_user(uid: str) -> dict:
    snap = await _fs(_user_ref(uid).get)
    if not snap.exists:
        raise UserNotFound("User not found.")
    return snap.to_dict() or {}


async def _patch_user(uid: str, patch: dict) -> None:
    await _fs(_user_ref(uid).update, patch)


# ── FX-10 (RF-15): the roster row's own state ───────────────────────────────
#
# `agencies/{agencyId}/agencyHosts/{uid}` is what the weekly payout report, the
# agency's app screen and the revoke cascade read as "this agency's hosts".
# Nothing removed or flagged a row when the role ended, so all three kept
# counting revoked (and purged) Hosts. A row now says whether it is current:
# `active: False` plus when and why it stopped. An absent `active` is a row
# written before this — current, as every reader always treated it.
ROSTER_ACTIVE = "active"
ROSTER_REMOVED_AT = "removedAt"
ROSTER_REMOVED_REASON = "removedReason"


def roster_removal_fields(why: str, when: Any) -> dict:
    """The fields that mark a roster row as no longer current."""
    return {ROSTER_ACTIVE: False, ROSTER_REMOVED_AT: when, ROSTER_REMOVED_REASON: why}


def roster_current_fields() -> dict:
    """The fields a (re)grant or a restore writes: current, and nothing left of a removal."""
    return {
        ROSTER_ACTIVE: True,
        ROSTER_REMOVED_AT: fb_firestore.DELETE_FIELD,
        ROSTER_REMOVED_REASON: fb_firestore.DELETE_FIELD,
    }


def roster_row_is_current(row: dict) -> bool:
    """Is this roster row a CURRENT host? `active` absent → yes (a legacy row)."""
    return (row or {}).get(ROSTER_ACTIVE) is not False


def _roster_ref(agency_id: Any, uid: str):
    agency_id = str(agency_id or "").strip()
    if not agency_id:
        return None
    return (
        firebase.firestore_client()
        .collection("agencies")
        .document(agency_id)
        .collection("agencyHosts")
        .document(uid)
    )


async def load_user(uid: str) -> dict:
    """The user document, or `UserNotFound`.

    Public because `services/appeals` needs to know whether an account is
    currently banned before it decides whether an overturn has anything to
    lift. Reaching into `_load_user` from another module would work today and
    break silently the first time this one is refactored.
    """
    return await _load_user(uid)


# `clear_suspension_schedule(uid)` used to live here, and `services/appeals` had
# to remember to call it after every unban. That was the shape of the underlying
# defect in miniature: the operation that lifted a restriction did not know what
# kind of restriction it was lifting, so clearing up after it was somebody else's
# job and could be forgotten. Every operation now clears the schedule it is
# responsible for — `resume_user` because it is ending the suspension,
# `ban_user` and `unban_user` because a ban replaces a suspension rather than
# coexisting with one. There is nothing left for a caller to remember.


def restriction_of(user: dict) -> str:
    """Is this account suspended, banned, or neither — as one of `AccountState`.

    ── WHY THIS IS A FUNCTION AND NOT `user["accountState"]` ─────────────────

    Every account restricted before `accountState` carried a moderation value
    has no moderation value on it. There are only two fields those documents
    have, and they are enough to answer correctly:

        isSuspended=True   → a suspension, whatever `isBanned` says. `suspend_user`
                             has always set both, and a stray suspension left
                             with `isBanned` false is still a suspension.
        isBanned=True only → a ban.

    So a document written last year resolves to the same answer a document
    written today does, and `resume_user` / `unban_user` can each refuse the
    other's case without a migration having to run first.

    `accountState` wins when it carries a moderation value, because it is the
    only one of the three that can say "banned" and "suspended" apart on its
    own. The deletion states are NOT restrictions and are not returned here: a
    deleted account is a different question with a different answer screen, and
    conflating the two would have Unban offered for somebody who asked to leave.

    Returns `""` for an account under no restriction.
    """
    state = str(user.get("accountState") or "").strip()
    if state in (str(AccountState.SUSPENDED), str(AccountState.BANNED)):
        return state
    if user.get("isSuspended", False):
        return str(AccountState.SUSPENDED)
    if user.get("isBanned", False):
        return str(AccountState.BANNED)
    return ""


def _host_application_ref(application_id: str):
    if not application_id or not application_id.strip():
        raise UserError("A host application id is required.")
    return (
        firebase.firestore_client()
        .collection(HOST_APPLICATIONS)
        .document(application_id.strip())
    )


#: Where the liveness check lives. One name, so a typo cannot create a second
#: collection that every reader ignores.
HOST_VERIFICATION = "hostVerification"


def _host_verification_ref(uid: str):
    return (
        firebase.firestore_client().collection(HOST_VERIFICATION).document(uid.strip())
    )


def host_verification_seed(
    uid: str,
    *,
    agency_id: str = "",
    application_id: str = "",
    host_name: str = "",
    agency_photo_url: str = "",
) -> dict:
    """The opening state of a host's liveness check.

    ── WHY THIS EXISTS AS A NAMED FUNCTION ───────────────────────────────────

    There are two ways to become a host and they were writing different things.
    `activateHost` (functions/src/hosts.ts) opens this record as part of the
    transaction that grants host status; `grant_host` — the staff escape hatch,
    used when somebody cannot redeem a code — did not open it at all.

    That is not a cosmetic gap. `submitHostCapture` refuses outright when the
    record is missing ("Verification has not been set up for this account"), so
    a host created by the escape hatch could never submit a capture, could never
    be verified, and therefore could never go live and could never be paid. The
    escape hatch for one broken path led into another.

    ── WHAT THE READERS NEED ─────────────────────────────────────────────────

    Every field here is read by something, and leaving one out is how a row
    renders blank in a queue nobody can then action:

      * `status: 'pending_capture'` — deliberately NOT in `REVIEWABLE`
        (services/verification.py). The host has not submitted anything yet, so
        this is a record that exists, not a queue item wasting a reviewer's time.
      * `hostName`, `agencyId`, `attemptCount` — the reviewer's list columns.
      * `agencyPhotoUrl` — the photograph the capture is compared against. Empty
        here when there is no application, and `submitHostCapture` already
        handles that: it routes to `pending_manual` with
        `manualReason: 'no_agency_photo'` rather than failing.
      * `applicationId` — the audit trail back to the invitation, when there was
        one.

    ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────

    `isVerifiedHost` is not written by anything here, in either path. Granting
    host status is a statement about an agency relationship; verification is a
    statement about a face, made by a reviewer looking at two photographs. The
    four states — applied, activated, capture submitted, verified — stay
    distinct, and this only opens the third one's door.

    Mirrors the `tx.set(verRef, …)` payload in functions/src/hosts.ts. The two
    cannot share code across the language boundary, so they are kept in step by
    `test_host_verification_seed_matches_activate_host` instead.
    """
    now = datetime.now(timezone.utc)
    return {
        "uid": uid.strip(),
        "status": "pending_capture",
        "agencyPhotoUrl": agency_photo_url or "",
        "agencyId": agency_id or "",
        "applicationId": application_id or "",
        "hostName": host_name or "",
        "attemptCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }


def _stamp(actor: dict, verb: str) -> dict:
    """Flat actor fields written into Firestore.

    Deliberately flat and string-valued: the Android app and the CRM read
    `bannedBy` and friends directly, so a nested actor map would change a shape
    they already depend on. The uid is the attributable part; the name is there
    so a human reading the document does not have to look it up.
    """
    return {
        f"{verb}By": actor.get("uid", ""),
        f"{verb}ByName": actor.get("name", ""),
        f"{verb}ByRole": str(actor.get("role", "")),
        f"{verb}At": datetime.now(timezone.utc),
    }


def _require_reason(reason: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise UserError("A reason is required for every action.")
    return reason


def _result(uid: str, before: Any, after: Any, audit_id: str, **extra) -> dict:
    return {"uid": uid, "before": before, "after": after, "audit_id": audit_id, **extra}


def _iso(value: Any) -> str:
    """A Firestore timestamp as a string, for a before/after block.

    The audit entry is JSON on its way to the CRM, and a Firestore `Timestamp`
    is not a datetime — it is the client library's own type. Recording it raw
    put an object into the log whose rendering depended on which serialiser saw
    it first. Anything that cannot be read as a moment becomes "", because an
    empty end date and a mangled one look the same on screen and only one of
    them is honest.
    """
    isoformat = getattr(value, "isoformat", None)
    if not callable(isoformat):
        return ""
    try:
        return str(isoformat())
    except Exception:  # noqa: BLE001 — a shape we do not recognise
        return ""


# ══════════════════════════════════════════════════════════════════════════════
#  Moderation — four operations, spec 5.6
# ══════════════════════════════════════════════════════════════════════════════
#
# They take effect on the call. Moderation needs no owner signature (5.6); money
# always does, which is why a bean deduction further down raises a card instead.
#
#                 account      device            another account on that phone?
#   suspend       restricted   NOT barred        yes
#   resume        active       untouched         —
#   ban           restricted   every one barred  no
#   unban         active       this account's    —
#                              bans lifted
#
# ── WHY RESUME AND UNBAN ARE NOT THE SAME FUNCTION ───────────────────────────
#
# Un-suspending used to BE `unban_user`. Two things followed from that, and both
# of them were wrong in ways nobody could see from the CRM:
#
#   * the log said `user.unbanned` for an account that had never been banned, so
#     a suspension that expired on schedule and a ban a moderator decided to lift
#     were the same line in somebody's history;
#   * unbanning lifted a device ban unconditionally — so lifting a SUSPENSION,
#     which bars no device at all, would delete a `bannedDevices` record that
#     Ops had placed for reasons of their own, and hand a barred handset back to
#     whoever happened to be suspended on it.
#
# So they are two functions, each refuses the other's case by name, and the
# refusal says which one to use. `restriction_of` above is what tells them
# apart, including on documents written before `accountState` existed.


# ── C4 — a restricted app account loses its CRM partner access ───────────────
#
# Suspending or banning an account stopped the app and nothing else: the same
# person's agency or coin-seller portal went on working, on a live session and
# on every renewal of it. The roles themselves are NOT touched — a suspension
# is about the account, and lifting it must give back exactly the roles that
# are still approved — so what changes is access: every CRM session of the uid
# is revoked (the helper partner revocation uses), `crmUsers/{uid}` is marked
# `accountRestricted` for the Firestore rules, and `core/account_state` refuses
# the uid at the next request, sign-in and renewal while the restriction lasts.
# All best effort and reported: the moderation decision itself never fails on
# them.


def _set_account_restricted(uid: str, restricted: bool) -> bool:
    """Blocking — `crmUsers/{uid}.accountRestricted`, only if that document exists."""
    try:
        ref = firebase.firestore_client().collection("crmUsers").document(uid)
        if not getattr(ref.get(), "exists", False):
            return False
        ref.update({"accountRestricted": bool(restricted)})
        return True
    except Exception as exc:  # noqa: BLE001 — reported, never raised
        log.warning("crmUsers/%s accountRestricted=%s not written: %s", uid, restricted, exc)
        return False


def _set_seller_listings_restricted(seller_ids: list[str], restricted: bool) -> int:
    """Blocking — `sellers/{id}.ownerRestricted` on each seller document that exists.

    The public directory (`publicSellers`, mirrored from `sellers` by the
    Functions trigger `syncPublicSeller`) leaves out a seller whose owner
    account is restricted (`publicSeller.isPubliclyVisible`). The seller's
    `status` — the ROLE — is not touched: an account action must not revoke or
    suspend roles, and lifting it must give back exactly what was approved.
    """
    written = 0
    for sid in seller_ids:
        try:
            ref = firebase.firestore_client().collection("sellers").document(sid)
            if not getattr(ref.get(), "exists", False):
                continue
            ref.update({"ownerRestricted": bool(restricted)})
            written += 1
        except Exception as exc:  # noqa: BLE001 — reported, never raised
            log.warning("sellers/%s ownerRestricted=%s not written: %s", sid, restricted, exc)
    return written


async def _owned_seller_ids(uid: str) -> list[str]:
    """Every seller record this human owns, by either owner link (B07)."""
    from app.services import partner_roles  # local: keeps this module's import graph light

    try:
        rows = await partner_roles.records_owned_by(uid)
    except Exception as exc:  # noqa: BLE001 — the restriction stands regardless
        log.warning("seller records of %s could not be listed: %s", uid, exc)
        return []
    return [str(r.get("_id")) for r in rows if str(r.get("kind") or "") == "seller" and r.get("_id")]


async def _revoke_api_sessions(uid: str) -> int:
    """Every live API session of this uid — partner or otherwise — revoked. Never raises.

    The same sweep `partner_ops._revoke_partner_sessions` makes, keyed on the
    uid the sessions were issued to. A suspension (§5) revokes "all CRM sessions
    for the UID"; a resume revokes the stale ones so the person authenticates
    afresh. Reported as a count; the restriction or the lift stands regardless.
    """
    from app.services import partner_ops  # local: partner_ops imports this module's peers

    try:
        return await partner_ops._revoke_partner_sessions({"owner_crm_uid": uid})
    except Exception as exc:  # noqa: BLE001 — the decision stands regardless
        log.warning("API sessions of %s were not revoked: %s", uid, exc)
        return 0


async def _close_crm_access(uid: str) -> dict:
    revoked = await _revoke_api_sessions(uid)
    flagged = await _fs(_set_account_restricted, uid, True)
    hidden = await _fs(_set_seller_listings_restricted, await _owned_seller_ids(uid), True)
    return {"crm_sessions_revoked": revoked, "crm_login_flagged": flagged,
            "seller_listings_hidden": hidden}


async def _reopen_crm_access(uid: str) -> dict:
    """The restriction is lifted. Roles are not touched: whatever is still
    approved works again at the next sign-in, and nothing else does. A seller
    listing comes back only if the seller record itself is still approved —
    `isPubliclyVisible` decides that from the record, not from this flag."""
    flagged = await _fs(_set_account_restricted, uid, False)
    shown = await _fs(_set_seller_listings_restricted, await _owned_seller_ids(uid), False)
    return {"crm_login_flagged": flagged, "seller_listings_unflagged": shown}


#: §5 Ban — what a ban records besides its reason. `category` is the kind of
#: breach (free text from a short list the CRM offers; the server does not
#: constrain the vocabulary beyond length), `evidence` is a list of references
#: (report ids, storage paths, URLs) — never files. `scope` is what the ban
#: reaches: the account alone, or the account and every handset it was seen on.
BAN_SCOPE_ACCOUNT = "account"
BAN_SCOPE_ACCOUNT_AND_DEVICES = "account_and_devices"
BAN_SCOPES = (BAN_SCOPE_ACCOUNT, BAN_SCOPE_ACCOUNT_AND_DEVICES)
MAX_BAN_EVIDENCE = 10


def _ban_details(category: str | None, evidence: list | None) -> dict:
    """The category and evidence of a ban, bounded (pure)."""
    cat = str(category or "").strip()[:80]
    refs = [str(e).strip()[:500] for e in (evidence or []) if str(e or "").strip()][:MAX_BAN_EVIDENCE]
    return {"category": cat, "evidence": refs}


async def ban_user(
    uid: str,
    reason: str,
    actor: dict,
    meta: dict | None = None,
    ban_device_too: bool = True,
    *,
    enforce_target_policy: bool = True,
    category: str | None = None,
    evidence: list | None = None,
) -> dict:
    """Ban an account, and every handset it has been seen on.

    Takes effect immediately — no signature needed (5.6).

    ── WHY THE DEVICE GOES WITH IT ──────────────────────────────────────────

    Banning an account alone bans a row in a database, not a person. Thirty
    seconds and a new phone number produces a fresh account on the same handset
    and the same behaviour starts again — which is the entire economics of
    abuse on a product where signing up is free.

    So the ban reaches the device: `bannedDevices/{deviceId}`, keyed by the id
    the Android app reads on launch, which locks that handset for EVERY
    account. That is the point and it is also the cost — a shared phone, a
    refurbished handset, a family device — so it is stated plainly here rather
    than discovered later, it is audited as its own act, and `unban_user` lifts
    it again. `ban_device_too=False` exists for the case where a reviewer wants
    the account closed and the handset left alone.

    ── EVERY DEVICE, NOT "THE" DEVICE ───────────────────────────────────────

    This used to ban exactly one handset: whatever was on `users/{uid}.deviceId`.
    That field is written ONCE, at profile setup, and never refreshed — and it
    was client-writable until recently, so somebody expecting a ban could point
    it at a device that does not exist. The usual outcome was that the ban
    landed on a phone the person had sold two years ago while the one in their
    hand stayed clean.

    `users/{uid}/devices` is the replacement: `rememberDevice` in
    `functions/src/identity.ts` writes a document there on every
    `startMobileSession`, server-side. Every one of them is barred here, and
    each record carries this uid in `sourceAccounts` so `unban_user` can undo
    exactly what this call did and nothing else. `deviceId` is still read as a
    fallback, for accounts that have not signed in since the subcollection
    started being written.

    ── WHAT FAILURE LOOKS LIKE ──────────────────────────────────────────────

    The device half is best-effort, per device. If one write fails the others
    still happen and the ACCOUNT ban still stands — a ban that half-succeeded
    is better than one that rolled itself back because a second write missed —
    and the response names how many handsets were actually barred, because a
    reviewer who is told "banned" and assumes the phone went with it is the
    person who will be surprised in a week.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="ban")

    reason = _require_reason(reason)
    user = await _load_user(uid)
    details = _ban_details(category, evidence)
    scope = BAN_SCOPE_ACCOUNT_AND_DEVICES if ban_device_too else BAN_SCOPE_ACCOUNT

    before = {
        "isBanned": bool(user.get("isBanned", False)),
        "isSuspended": bool(user.get("isSuspended", False)),
        "accountState": user.get("accountState", ""),
        "banReason": user.get("banReason", ""),
    }

    patch = {
        "accountState": str(AccountState.BANNED),
        "isBanned": True,
        # A ban is not a suspension, so the suspension flags come OFF. Banning
        # somebody who was suspended must not leave `isSuspended` true, or the
        # nightly sweep would find them, resume them, and quietly undo a ban
        # nobody asked it to touch.
        "isSuspended": False,
        "suspendedUntil": fb_firestore.DELETE_FIELD,
        "suspensionDays": fb_firestore.DELETE_FIELD,
        "banReason": reason,
        # §5: scope, category and evidence travel with the ban, on the account
        # (what the app and the CRM read) as well as on the audit entry. The
        # actor and the time are `_stamp` below.
        "banScope": scope,
        "banCategory": details["category"],
        "banEvidence": details["evidence"],
        # Phase 1A (SESSION-003) / §5 "alternate login methods bound to the same
        # UID": every token issued before now — whatever provider minted it —
        # is refused by the rules (`sessionCurrent`) and by the callables. The
        # restriction is on the UID, so every sign-in method that resolves to
        # it is closed by it. Monotonic — never lowered below a cut-off another
        # path already set.
        "credentialsValidAfter": max(
            int(user.get("credentialsValidAfter") or 0),
            int(datetime.now(timezone.utc).timestamp()) + 1,
        ),
        # GOV B42: the owner-update rule now refuses a banned account, so the app
        # can no longer clear its own presence. Cleared here, server-side, or the
        # account would stay "online" in every list for good.
        "isOnline": False,
        **_stamp(actor, "banned"),
        # RC (confirmed, CRM-FLOW 9.48): the Host's beans stop moving in the
        # same write as the ban — the weekly release and `convertBeans` read it.
        **money_freeze.hold_fields("a ban"),
    }
    # RC: money behind the ban is frozen for the Owner's review FIRST, so there
    # is never a banned account whose money still moves.
    await money_freeze.freeze_user(uid, cause="account_banned", label="a ban", reason=reason, actor=actor,
                                   db=get_db())
    await _patch_user(uid, patch)

    # ── THE CREDENTIAL DIES WITH THE ACCOUNT ─────────────────────────────────
    #
    # Flipping `isBanned` stopped the app and the security rules from serving
    # the account. It did NOT stop the account: the Firebase credential stayed
    # valid, so a held ID token kept working for its remaining hour and the
    # refresh token kept minting new ones indefinitely. "Banned" was a flag our
    # own code agreed to honour, not a withdrawal of access.
    #
    # `set_user_disabled(uid, True)` does both halves — disables the account so
    # no new token can be minted, and revokes the refresh tokens so the ones
    # already out there cannot be renewed. It is the same call staff
    # deactivation has always made; it was simply never made for an app user.
    #
    # Quick Login is killed by the existing Firestore trigger
    # (`functions/src/identity.ts::revokeQuickLoginOnRestriction`), which fires
    # on the transition into `isBanned` that `_patch_user` has just written.
    #
    # Best-effort and audited either way: a Firebase outage must not cost us the
    # ban. A failure is recorded as its own searchable action so an operator can
    # list the accounts whose credentials are still live.
    firebase_problem = await asyncio.to_thread(firebase.set_user_disabled, uid, True)
    if firebase_problem:
        log.error("ban_user: Firebase credential not revoked for %s: %s", uid, firebase_problem)
        await audit.record(
            actor=actor,
            action=audit.Action.USER_FIREBASE_REVOKE_FAILED,
            subject_type="user",
            subject_id=uid,
            before={"firebase_login": "enabled"},
            after={"firebase_login": "STILL ENABLED"},
            reason=(
                "The account was banned but its Firebase credential could not be "
                "revoked, so the held token still works. Disable it by hand."
            ),
            meta={"error": firebase_problem},
        )

    # C4: the same person's CRM partner access closes with the account.
    crm_access = await _close_crm_access(uid)

    device_ids: list[str] = []
    barred: list[str] = []
    device_failures: list[dict] = []
    device_note = ""

    if ban_device_too:
        device_ids = await _devices_of(uid, user)
        for device_id in device_ids:
            try:
                await ban_device(
                    device_id,
                    str(DeviceType.ANDROID_ID),
                    f"{reason} (device of banned account {uid})",
                    [uid],
                    actor,
                    source_uid=uid,
                )
                barred.append(device_id)
            except Exception as exc:  # noqa: BLE001 — never lose the account ban
                log.error("ban_user: device ban failed for %s/%s: %s", uid, device_id, exc)
                device_failures.append({"device_id": device_id, "error": str(exc)})

        if not device_ids:
            device_note = (
                "The account is banned. No device has ever been recorded against "
                "it, so there is no handset to bar — a new account can be created "
                "on the same phone. It will be barred the next time this account "
                "signs in, by the propagation rule in resolveIdentity."
            )
        elif device_failures:
            device_note = (
                f"The account is banned and {len(barred)} of {len(device_ids)} "
                "handset(s) were barred with it. These could not be: "
                + "; ".join(f"{f['device_id']} ({f['error']})" for f in device_failures)
                + ". Those handsets can still be used to sign up again."
            )
        else:
            device_note = (
                f"The account is banned and {len(barred)} handset(s) were barred "
                "with it. Any account on those handsets is now locked out."
            )
    else:
        device_note = (
            "The account is banned. No handset was barred, because this ban was "
            "raised with the device left alone — a new account can be created on "
            "the same phone."
        )

    after = {
        "accountState": str(AccountState.BANNED),
        "isBanned": True,
        "isSuspended": False,
        "banReason": reason,
        "banScope": scope,
        "banCategory": details["category"],
    }
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_BANNED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "name": user.get("name", ""),
            # §5: scope, category and evidence — the actor and the time are on
            # the entry itself. `partner_roles_touched: False` is the statement
            # that a ban does not itself revoke a partner role.
            "scope": scope,
            "category": details["category"],
            "evidence": details["evidence"],
            "partner_roles_touched": False,
            # Which handsets this ban actually reached. Recorded on the entry
            # because it is the half a reviewer cannot see from the account
            # screen, and because `unban_user` is judged against it later.
            "affectedDeviceIds": barred,
            "known_device_ids": device_ids,
            "device_failures": device_failures,
            "devices_barred": len(barred),
            "crm_access": crm_access,
            **(meta or {}),
        },
    )
    # §5 / §12: the person is told, with the reason — in-app and by email —
    # after the ban and its audit entry are committed. Never raises.
    await _notify_restriction(uid, "banned", reason, audit_id)
    return _result(
        uid,
        before,
        after,
        audit_id,
        scope=scope,
        category=details["category"],
        evidence=details["evidence"],
        device_banned=bool(barred),
        devices_barred=barred,
        device_failures=device_failures,
        crm_access=crm_access,
        note=device_note,
    )


async def unban_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Lift a ban, and with it the device bans THIS account caused.

    The original `banReason` is moved to `previousBanReason` rather than being
    blanked. Wiping it destroyed the only record of why someone was banned, so
    a repeat offender looked identical to a first-time one.

    ── IT REFUSES A SUSPENSION, AND SAYS WHICH BUTTON TO PRESS ──────────────

    A suspended account is lifted by `resume_user`, not by this. The two are
    not interchangeable: resuming touches no device, and unbanning goes through
    the `bannedDevices` records — so unbanning a suspension would reach for
    handsets this account never caused to be barred. The refusal names Resume
    rather than just declining, because "This account is not banned" in front of
    somebody looking at a locked-out account is a dead end.

    ── WHY THE DEVICE HALF IS SURGICAL NOW ──────────────────────────────────

    It used to delete exactly one `bannedDevices` document — whatever was on
    `users/{uid}.deviceId` — unconditionally, with a comment arguing that a
    moderator lifting a ban is the person deciding the handset is allowed back.
    That reasoning does not survive contact with the fact that a device ban is
    not per-account: `bannedDevices/{id}` locks out EVERYBODY on that handset,
    and it may have been placed by Ops for a reason that has nothing to do with
    this person. Deleting it handed a barred phone back to whoever was unbanned
    nearest to it.

    `sourceAccounts` is what makes it surgical. `barDevice` in
    `functions/src/identity.ts` and `ban_device` below both record which
    accounts caused a record to exist; this removes THIS uid from each one, and
    the document is deleted only when

        · nothing is left in `sourceAccounts` — no other banned account is
          holding the handset barred — AND
        · `manualBan` is not true — Ops did not place it on their own
          authority.

    A device barred by two banned accounts stays barred when one of them is
    unbanned. A device Ops barred independently stays barred whatever happens
    to the accounts on it. Both were lost before, silently.

    Best-effort in the same direction as the ban: the ACCOUNT unban always
    stands, and the response says which handsets were released and which were
    not, with the reason.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="unban")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    restriction = restriction_of(user)
    if restriction == str(AccountState.SUSPENDED):
        raise UserError(
            "This account is suspended, not banned. Use Resume — it lifts the "
            "suspension and correctly leaves every device ban alone."
        )
    if not restriction:
        raise UserError("This account is not banned.")

    original = user.get("banReason", "") or ""
    before = {
        "accountState": user.get("accountState", ""),
        "isBanned": bool(user.get("isBanned", False)),
        "isSuspended": bool(user.get("isSuspended", False)),
        "banReason": original,
    }

    patch = {
        "accountState": str(AccountState.ACTIVE),
        "isBanned": False,
        "banReason": "",
        "previousBanReason": original,
        "isSuspended": False,
        "suspendedUntil": fb_firestore.DELETE_FIELD,
        "suspensionDays": fb_firestore.DELETE_FIELD,
        **_stamp(actor, "unbanned"),
    }
    await _patch_user(uid, patch)

    # The ban disabled the Firebase account, so lifting the ban has to enable it
    # again or the person is unbanned on paper and still cannot sign in — a
    # state nothing in the product would explain to them or to the reviewer.
    #
    # `set_user_disabled(uid, False)` deliberately does NOT revoke refresh
    # tokens: re-enabling must not kill a session the person has legitimately
    # just started. That asymmetry is in `db/firebase.py` and is the reason the
    # revoke sits behind `if disabled`.
    firebase_problem = await asyncio.to_thread(firebase.set_user_disabled, uid, False)
    if firebase_problem:
        log.error("unban_user: Firebase account not re-enabled for %s: %s", uid, firebase_problem)

    # C4: CRM access returns for whatever role is still approved — no role is
    # touched here, so a role revoked meanwhile stays revoked.
    crm_access = await _reopen_crm_access(uid)

    released, kept, failures = await _release_device_bans(
        uid, f"{reason} (account {uid} unbanned)", actor
    )

    device_note = ""
    if released:
        device_note = (
            f"{len(released)} handset(s) were released with the account."
        )
    if kept:
        # Named rather than counted. A person who is unbanned and still cannot
        # sign in needs to be told which phone and why, or the next thing that
        # happens is a support ticket saying the unban did not work.
        device_note += (
            (" " if device_note else "")
            + f"{len(kept)} device ban(s) stay in force and are NOT this "
            "account's to lift: "
            + "; ".join(f"{k['device_id']} ({k['because']})" for k in kept)
            + ". They will still block this account on those handsets."
        )
    if failures:
        device_note += (
            (" " if device_note else "")
            + "These device bans could not be touched: "
            + "; ".join(f"{f['device_id']} ({f['error']})" for f in failures)
            + ". The account is unbanned regardless."
        )
    if not (released or kept or failures):
        device_note = (
            "The account is unbanned. No device ban named it, so there was "
            "nothing to release."
        )

    after = {
        "accountState": str(AccountState.ACTIVE),
        "isBanned": False,
        "isSuspended": False,
        "banReason": "",
        "previousBanReason": original,
    }
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_UNBANNED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "original_ban_reason": original,
            # What this unban actually reached, and — as importantly — what it
            # deliberately did not. A record kept because Ops placed it, or
            # because another banned account is still holding it up, is the
            # thing somebody will come back and ask about.
            "affectedDeviceIds": released,
            "device_bans_kept": kept,
            "device_failures": failures,
            "devices_released": len(released),
            "crm_access": crm_access,
            **(meta or {}),
        },
    )
    await _notify_restriction(uid, "unbanned", reason, audit_id)
    return _result(
        uid, before, after, audit_id,
        device_unbanned=bool(released),
        devices_released=released,
        device_bans_kept=kept,
        device_failures=failures,
        crm_access=crm_access,
        note=device_note,
    )


async def suspend_user(
    uid: str,
    reason: str,
    actor: dict,
    meta: dict | None = None,
    days: int | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Suspend an account, for a stated number of days or until lifted by hand.

    ── WHAT A SUSPENSION IS, AND WHAT IT IS NOT ─────────────────────────────

    It is a restriction on an ACCOUNT. It bars no device, and that is the whole
    of the difference between it and a ban: a suspended person may go back to
    the login screen and sign in with a different, eligible account on the same
    phone. A banned one may not. `resolveIdentity` in
    `functions/src/identity.ts` enforces exactly that split — it bars the
    handset for a ban and deliberately does not for a suspension.

    The Android app still has one gate, `isBanned`, and every security rule and
    Cloud Function reads it, so a suspension sets it: the account cannot use the
    product. `accountState: 'suspended'` is what says WHY, so the app can show
    a screen with an end date on it instead of the permanent-ban screen, and so
    `resume_user` and `unban_user` can tell each other's cases apart.

    This used to set `isBanned` and stamp the `banned*` actor fields, and write
    nothing else. A suspension was therefore indistinguishable from a ban on the
    document: the app showed a permanent-ban screen to somebody who had been
    suspended for three days, and the log recorded a ban that had never been
    decided. The actor fields are `suspendedBy*` now, so who suspended somebody
    and who banned them are two facts.

    ── WHY A DATE, AND WHY IT IS NOT A PROMISE THE UI MAKES ──────────────────

    This used to be indefinite, deliberately: an end date shown in the CRM with
    nothing to act on it would let a suspension "expire" on screen while the
    app kept the account locked out for ever — worse than no date at all.

    `days` is honoured now because something does act on it:
    `lift_expired_suspensions` runs on a schedule, RESUMES everyone whose
    `suspendedUntil` has passed, and audits each lift. So the date is a fact
    about what will happen, not a label.

    Omitting `days` keeps the old behaviour exactly — `suspendedUntil` is not
    written, the sweep never picks it up, and it stays in force until somebody
    resumes by hand. Which is still the right shape for "off the platform while
    we investigate".

    ── IT REFUSES A BANNED ACCOUNT (B2, ACCT-001) ───────────────────────────

    A ban outranks a suspension, so a banned account is refused by name and
    told to use Unban first. See the comment at the check.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="suspend")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    # B2 (ACCT-001): a suspension must never overwrite or clear a ban. It used
    # to: suspending a banned account set the state to 'suspended' and replaced
    # the ban's reason, so from then on Unban refused it ("suspended, not
    # banned") while Resume — or the nightly sweep, once a timed term ran out —
    # cleared `isBanned` and let the account back in, with the device bans the
    # ban had placed left behind. Refused here, before anything is written, so
    # the direct route and a report decision (`action_report` carries the
    # decision out BEFORE it closes the report) both leave the account, its
    # sessions, its audit log and the report exactly as they were.
    if restriction_of(user) == str(AccountState.BANNED):
        raise UserError(
            "This account is banned, and a ban outranks a suspension: suspending "
            "it would replace the ban and let Resume or the end of the term lift "
            "it. To turn the ban into a suspension, Unban it first, then suspend it."
        )

    if days is not None:
        if days < 1 or days > 365:
            raise UserError("A suspension runs from 1 to 365 days.")

    before = {
        "accountState": user.get("accountState", ""),
        "isBanned": bool(user.get("isBanned", False)),
        "isSuspended": bool(user.get("isSuspended", False)),
        "banReason": user.get("banReason", ""),
    }

    until = (
        datetime.now(timezone.utc) + timedelta(days=days) if days is not None else None
    )

    patch: dict = {
        "accountState": str(AccountState.SUSPENDED),
        # The app's one gate. A suspended account cannot use the product — the
        # difference from a ban is the DEVICE, which this touches not at all.
        "isBanned": True,
        "isSuspended": True,
        "banReason": reason,
        # GOV B42: as for a ban — the app can no longer write its own presence.
        "isOnline": False,
        # Phase 1A (SESSION-003): every token issued before now is refused by
        # the rules (`sessionCurrent`) and by the callables. Monotonic — never
        # lowered below a cut-off another path already set.
        "credentialsValidAfter": max(
            int(user.get("credentialsValidAfter") or 0),
            int(datetime.now(timezone.utc).timestamp()) + 1,
        ),
        **_stamp(actor, "suspended"),
    }
    if until is not None:
        patch["suspendedUntil"] = until
        patch["suspensionDays"] = days
    else:
        # An indefinite suspension must clear any date left by an earlier
        # timed one, or the sweep would lift this one on the old schedule.
        patch["suspendedUntil"] = fb_firestore.DELETE_FIELD
        patch["suspensionDays"] = fb_firestore.DELETE_FIELD

    # RC (confirmed, CRM-FLOW 9.48): pending earnings and transfers are frozen
    # for the Owner's review — FIRST, and the Host's beans stop in the same
    # write as the suspension. Lifting the suspension does not release them.
    patch.update(money_freeze.hold_fields("a suspension"))
    await money_freeze.freeze_user(uid, cause="account_suspended", label="a suspension", reason=reason,
                                   actor=actor, db=get_db())
    await _patch_user(uid, patch)

    # Phase 1A (SESSION-003): and the refresh tokens, so no new ID token is
    # minted on the old sign-in. Reported, never swallowed.
    session_problem = await asyncio.to_thread(firebase.revoke_sessions, uid)
    if session_problem:
        log.error("suspend_user: sessions not revoked for %s: %s", uid, session_problem)

    # C4: the same person's CRM partner access closes with the account.
    crm_access = await _close_crm_access(uid)

    after = {
        "accountState": str(AccountState.SUSPENDED),
        "isBanned": True,
        "isSuspended": True,
        "banReason": reason,
        "suspendedUntil": until.isoformat() if until else "",
    }
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_SUSPENDED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "lifted_by": "scheduled sweep" if until else "manual resume",
            "days": days,
            # Empty, and stated rather than omitted: "we barred no handset" is
            # the defining fact about a suspension, and an entry that simply
            # did not mention devices would read as one where nobody checked.
            "affectedDeviceIds": [],
            "devices_barred": 0,
            "crm_access": crm_access,
            **(meta or {}),
        },
    )
    await _notify_restriction(uid, "suspended", reason, audit_id, until=until)
    return _result(
        uid,
        before,
        after,
        audit_id,
        suspended_until=after["suspendedUntil"],
        crm_access=crm_access,
        note=(
            "The account is suspended and cannot use the app. No device was "
            "barred — another account may be used on the same phone. Lift it "
            "with Resume."
        ),
    )


async def resume_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Lift a suspension. Touches no device, ever.

    ── WHY THIS IS NOT `unban_user` WITH A DIFFERENT NAME ───────────────────

    Un-suspending used to be a call to `unban_user`, and that was wrong twice
    over. It wrote `user.unbanned` into the audit log for an account that had
    never been banned — so an expired suspension and a moderator's decision to
    lift a ban were the same line in somebody's history, and neither could be
    counted. And it went on to delete a `bannedDevices` document, which a
    suspension never creates: the record it deleted belonged to somebody else's
    decision, usually Ops', and a handset that was supposed to stay barred came
    back because an unrelated person's three-day suspension ran out.

    So this does the account and nothing else. There is no device path in this
    function at all, which is the point — a suspension bars no handset, so
    there is nothing here for a resume to undo.

    ── THE TWO REFUSALS ─────────────────────────────────────────────────────

    A BANNED account is refused by name, and told to use Unban. If Resume could
    clear a ban the two operations would be aliases again, and a ban would be
    liftable by whichever button somebody reached for — without the device bans
    it caused ever being lifted with it, leaving the person unbanned and still
    walled out.

    An account under no restriction is refused as well, rather than being
    written to "just in case": resuming somebody who is already active would
    stamp a resume on their record and put a line in their history saying a
    restriction was lifted that never existed.

    ── AND WHAT IT DOES ACCEPT ──────────────────────────────────────────────

    A suspension **whether or not `isBanned` is true**. `unban_user` refused
    anything with `isBanned` false, which meant a stray suspension — one where
    the flag came off but `isSuspended` stayed on, which was possible for as
    long as the field was client-writable — could not be cleared by any
    endpoint at all. The account showed as suspended in the CRM for ever and
    nothing would lift it.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="resume")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    restriction = restriction_of(user)
    if restriction == str(AccountState.BANNED):
        raise UserError(
            "This account is banned, not suspended. Use Unban — it lifts the "
            "ban and the device bans that came with it."
        )
    if not restriction:
        raise UserError("This account is not suspended.")

    original = user.get("banReason", "") or ""
    before = {
        "accountState": user.get("accountState", ""),
        "isBanned": bool(user.get("isBanned", False)),
        "isSuspended": True,
        "banReason": original,
        "suspendedUntil": _iso(user.get("suspendedUntil")),
    }

    patch = {
        "accountState": str(AccountState.ACTIVE),
        "isBanned": False,
        "isSuspended": False,
        "banReason": "",
        # Kept, exactly as an unban keeps it. Wiping the reason destroyed the
        # only record of why somebody was restricted, so a repeat offender
        # looked identical to a first-time one.
        "previousBanReason": original,
        # The schedule goes with the suspension. Left behind, it would have the
        # nightly sweep finding an account it has nothing to do to, for ever.
        "suspendedUntil": fb_firestore.DELETE_FIELD,
        "suspensionDays": fb_firestore.DELETE_FIELD,
        # §5 Resume: "revoke stale sessions and require fresh authentication".
        # Every token issued before this moment — including one minted during
        # the suspension by any sign-in method bound to the uid — is refused by
        # the rules and the callables; the person signs in again and their
        # access is recomputed from each role's OWN status at that sign-in.
        "credentialsValidAfter": max(
            int(user.get("credentialsValidAfter") or 0),
            int(datetime.now(timezone.utc).timestamp()) + 1,
        ),
        **_stamp(actor, "resumed"),
    }
    await _patch_user(uid, patch)

    # §5 Resume: the stale sessions. The Firebase refresh tokens (so no new ID
    # token is minted on a sign-in that predates the suspension) and every CRM
    # API session of the uid. Reported, never swallowed; the resume stands.
    session_problem = await asyncio.to_thread(firebase.revoke_sessions, uid)
    if session_problem:
        log.error("resume_user: sessions not revoked for %s: %s", uid, session_problem)
    stale_sessions = await _revoke_api_sessions(uid)

    # C4: CRM access returns for whatever role is still approved — no role is
    # touched here, so a role revoked meanwhile stays revoked. Access is
    # recomputed from each role's own status (`account_state.partner_refusal`
    # per record) at the next sign-in: a revoked or suspended role stays
    # disabled, and nothing here releases frozen money (`money_freeze`).
    crm_access = await _reopen_crm_access(uid)
    crm_access["stale_sessions_revoked"] = stale_sessions
    crm_access["fresh_authentication_required"] = True
    crm_access["money_released"] = False

    after = {
        "accountState": str(AccountState.ACTIVE),
        "isBanned": False,
        "isSuspended": False,
        "banReason": "",
        "previousBanReason": original,
    }
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_RESUMED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "original_suspension_reason": original,
            # Stated, not omitted. An empty list here is the assertion that a
            # resume reached no handset — which is the property that separates
            # it from an unban, and the one somebody will want to check.
            "affectedDeviceIds": [],
            "devices_released": 0,
            "crm_access": crm_access,
            **(meta or {}),
        },
    )
    await _notify_restriction(uid, "resumed", reason, audit_id)
    return _result(
        uid,
        before,
        after,
        audit_id,
        device_unbanned=False,
        devices_released=[],
        crm_access=crm_access,
        note=(
            "The suspension is lifted and the account can use the app again. "
            "No device ban was touched — a suspension never placed one, and a "
            "device barred for another reason stays barred."
        ),
    )


async def _notify_restriction(
    uid: str, change: str, reason: str, audit_id: Any, *, until: datetime | None = None,
) -> None:
    """§12: tell the person of a suspension / resume / ban / unban. Never raises,
    and runs AFTER the authoritative patch and its audit entry."""
    from app.services import notices

    try:
        await notices.account_restriction(uid, change, reason, str(audit_id or ""), until=until)
    except Exception:  # noqa: BLE001 — a delivery problem, never a reason to unwind
        log.exception("account %s: the '%s' notice was not delivered", uid, change)


async def lift_expired_suspensions(actor: dict, limit: int = 200) -> dict:
    """Resume everyone whose timed suspension has run out.

    Run on a schedule. Each lift is a real `resume_user` call, so it is audited
    against the person as `user.resumed` with the reason saying what lifted it —
    and NOT as `user.unbanned`, which is what this used to write. An expired
    suspension and a moderator lifting a ban are different facts and the log has
    to be able to tell them apart.

    Because it goes through `resume_user`, it also inherits that function's
    refusals: an account that is banned rather than suspended is left alone and
    appears in `failed` with the reason, instead of being quietly unbanned by a
    nightly job nobody is watching.

    A suspension with no `suspendedUntil` is never touched — that is the
    indefinite kind, and it ends when a human decides it does.
    """
    now = datetime.now(timezone.utc)
    col = firebase.firestore_client().collection(USERS)
    query = (
        col.where(filter=FieldFilter("isSuspended", "==", True))
        .where(filter=FieldFilter("suspendedUntil", "<=", now))
        .limit(min(limit, MAX_READ))
    )
    docs = await _fs(lambda: list(query.stream()))

    lifted: list[str] = []
    failed: list[dict] = []
    for d in docs:
        try:
            # `resume_user` clears `suspendedUntil` and `suspensionDays` itself,
            # so there is no second write here. There used to be one, patching
            # the schedule off after the unban — which meant an account whose
            # unban succeeded and whose second write failed stayed in this
            # query for ever, being lifted again every night.
            # `enforce_target_policy=False`: this is the nightly sweep, not a
            # person acting through user management. The target-protection
            # guard refuses internal identities and self-targeting, both of
            # which are about WHO is pressing a button — neither applies to a
            # scheduled job, and leaving it on would abort the whole sweep for
            # every ordinary user the moment one protected account was found
            # holding a stale suspension.
            await resume_user(
                d.id,
                "Suspension period ended.",
                actor,
                meta={"lifted_by": "scheduled sweep"},
                enforce_target_policy=False,
            )
            lifted.append(d.id)
        except Exception as exc:  # noqa: BLE001 — one failure must not stop the sweep
            failed.append({"uid": d.id, "error": str(exc)})

    return {"checked": len(docs), "lifted": lifted, "failed": failed}


#: §5 Warning — "Do not invent an automatic warning count threshold."
#:
#: OWNER_DECISION_PENDING: whether a number of warnings should ever escalate by
#: itself is the Owner's decision and has not been made. Until it is, this is
#: `None` and NOTHING in this module (or anywhere else in the backend) reads the
#: `warnings` counter to restrict, revoke, revoke sessions or freeze money. A
#: warning is a recorded moderation notice: an immutable event linked to the uid
#: and, when it came from one, the source report; the person is told; the
#: history is readable (`list_warnings`, `GET /users/{uid}/warnings`).
WARNING_AUTO_THRESHOLD: int | None = None  # OWNER_DECISION_PENDING


async def warn_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
    request_id: str | None = None,
    deduction: dict | None = None,
) -> dict:
    """Record a formal warning against an account — optionally with a deduction.

    §5: a warning ALONE blocks no login, revokes no role, revokes no session
    and freezes no money. It is an immutable event — the `warnings` entry's
    reason, issuer and time are written once and never rewritten (only the
    status of a linked deduction moves as its card is decided) — linked to the
    uid and to the source report when `meta.report_id` names one. There is no
    automatic count threshold (`WARNING_AUTO_THRESHOLD`).

    The warning is written with the real actor's uid and name. It used to be
    issued by "Admin", so a pattern of warnings could not be attributed to
    anyone and the user could not be told who to appeal to.

    ── UGP-D: THE OPTIONAL DEDUCTION ─────────────────────────────────────────

    `deduction = {"currency", "amount"}`. The currency follows the person's
    AUTHORITATIVE roles (`user_roles.deduction_currencies`): beans for a Host,
    diamonds for a User, Agency, Sub-agency or Coin Seller — both offered only
    for a Host who also holds a diamond role. The live balance the app shows
    must cover the amount now (released `beansAvailable` for beans), or the
    whole request is refused and NOTHING is recorded, so staff can correct it.

    The warning takes effect at once (moderation is direct). The deduction does
    not: "money is never direct" (module header), so it becomes a
    `balance_debit` card linked to the warning — verified and signed on the
    money board like every other balance change, and executed against the live
    balance by `execute_balance_card`. The route checks `can_adjust_balance`
    before this is reached.

    ── UGP-D: IDEMPOTENT ON THE CLIENT'S REQUEST ID ──────────────────────────

    With `request_id`, the warning's id is derived from it and the warning is
    created in a transaction that refuses to create it twice. A retried request
    (a timeout, a double-press) returns the first outcome — no second warning,
    no second count, no second card, no second notice.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="warn")

    reason = _require_reason(reason)
    # UGP review: money is never moved on a request that cannot be retried
    # safely. Without a request id, a timed-out request repeated by the client
    # is a second warning and a second card.
    if deduction and not request_id:
        raise UserError("A warning with a deduction needs a request id, so a retry cannot deduct twice.")
    user = await _load_user(uid)

    # A retry of a request that already created its warning is answered from
    # that warning — BEFORE the deduction is re-planned against a balance that
    # may since have changed, and without trusting anything but what this
    # request itself carries (see `_replay_warning`).
    warning_id = warning_id_for(uid, request_id) if request_id else ""
    if request_id:
        prior = await _load_warning(uid, warning_id)
        if prior is not None:
            return await _replay_warning(uid, user, warning_id, prior, actor, reason, deduction)

    plan = await _plan_warning_deduction(uid, user, deduction) if deduction else None

    count_before = int(user.get("warnings", 0) or 0)
    now = datetime.now(timezone.utc)

    entry = {
        "reason": reason,
        "issuedAt": now,
        "issuedBy": actor.get("uid", ""),
        "issuedByName": actor.get("name", ""),
        "issuedByRole": str(actor.get("role", "")),
    }
    if meta:
        entry.update({k: v for k, v in meta.items() if v is not None})
    if plan:
        entry["deduction"] = {
            "currency": plan["currency"],
            "amount": plan["amount"],
            "balanceAtRequest": plan["balance_at_request"],
            "status": "requested",
        }

    if request_id:
        try:
            created = await _fs(firebase.create_warning_once, uid, warning_id, entry)
        except (firebase.TransactionNotApplied, firebase.TransactionOutcomeUnknown) as exc:
            # HT-2: the warning was read again and is not there; the same request
            # id makes a resend safe.
            raise LiveStepNotConfirmed(str(exc), outcome=exc.outcome) from exc
        if not created:
            # Lost a race with the same request: answer as the replay would.
            prior = await _load_warning(uid, warning_id) or {}
            return await _replay_warning(uid, user, warning_id, prior, actor, reason, deduction)
    else:
        _, doc_ref = await _fs(_user_ref(uid).collection(WARNINGS).add, entry)
        warning_id = doc_ref.id
        # Atomic, rather than the read-then-write it was: two warnings issued
        # at once both count.
        await _patch_user(
            uid, {"warnings": fb_firestore.Increment(1), "lastWarnedAt": now}
        )

    card = None
    if plan:
        card = await _raise_warning_deduction_card(uid, user, warning_id, plan, reason, actor)

    before = {"warnings": count_before}
    after = {"warnings": count_before + 1}
    audit_meta = {"warning_id": warning_id, **(meta or {})}
    if plan:
        audit_meta["deduction"] = {
            "currency": plan["currency"], "amount": plan["amount"],
            "card_id": (card or {}).get("id", ""), "result": "card_raised",
        }
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_WARNED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta=audit_meta,
        card_id=(card or {}).get("id") or None,
    )

    # ── AND TELL THE PERSON ─────────────────────────────────────────────────
    #
    # Until now "Warn" wrote three things — the subcollection entry above, the
    # counter, and the audit row — and not one of them was reachable by the
    # user. The CRM told staff "The user may be shown this"; the app's Official
    # tab said "Nothing from Zipper yet". A warning nobody receives is not a
    # warning, and it cannot be appealed.
    #
    # LAST, and deliberately after the audit. The authoritative record is the
    # subcollection entry plus the audit row, both already committed by the
    # time this runs. Delivery is best effort: if Firestore refuses this write
    # the warning still happened, still counts, and is still in the history.
    # The reverse order would let a delivery failure lose the decision.
    await _deliver_warning_notice(uid, reason, warning_id, now)

    return _result(
        uid, before, after, audit_id, warning_id=warning_id,
        deduction=_deduction_view(plan, card),
    )


def warning_id_for(uid: str, request_id: str) -> str:
    """The warning's id for one client request — the same request, the same id."""
    import hashlib

    digest = hashlib.sha256(f"{uid}\x00{request_id}".encode()).hexdigest()
    return f"w_{digest[:24]}"


def _deduction_view(plan: dict | None, card: dict | None) -> dict | None:
    if not plan:
        return None
    return {
        "currency": plan["currency"],
        "amount": plan["amount"],
        "card_id": (card or {}).get("id", ""),
        "card_stage": (card or {}).get("stage", ""),
        "moved": False,
        "note": (
            "No money has moved. The deduction is a card on the money board and "
            "an owner has to sign it before it is taken from the live balance."
        ),
    }


def _parse_deduction(deduction: dict) -> tuple[str, int]:
    """`(currency, amount)` from a request, or UserError. Strict on purpose:
    `True` is not 1 and 2.9 is not 2 (UGP review) — an amount of money is a
    whole number the person typed, or the request is refused."""
    currency = str((deduction or {}).get("currency") or "").strip()
    raw = (deduction or {}).get("amount")
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise UserError("The deduction amount must be a whole number.")
    if raw < 1:
        raise UserError("A deduction must be at least 1.")
    return currency, int(raw)


async def _load_warning(uid: str, warning_id: str) -> dict | None:
    snap = await _fs(_user_ref(uid).collection(WARNINGS).document(warning_id).get)
    return (snap.to_dict() or {}) if getattr(snap, "exists", False) else None


async def _plan_warning_deduction(uid: str, user: dict, deduction: dict) -> dict:
    """Validate a warning deduction against the authoritative roles and the
    LIVE balance. Raises UserError; writes nothing."""
    currency, amount = _parse_deduction(deduction)

    from app.services import user_roles  # local: keeps the import graph acyclic

    inventory = await user_roles.role_inventory(uid, user=user, db=get_db())
    allowed = user_roles.deduction_currencies(inventory["roles"])
    if currency not in allowed:
        raise UserError(
            f"A deduction from this account is taken in {' or '.join(allowed)}, "
            f"not '{currency or 'nothing'}'. Nothing was recorded."
        )

    def _count(v: Any) -> int:
        return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

    if currency == "beans":
        # Released beans — and never more than `beans` itself, which execution
        # also debits (UGP review: the two checks must agree, or a card is
        # raised that can only fail).
        live = min(_count(user.get("beansAvailable")), _count(user.get("beans")))
        what = "released beans"
    else:
        live, what = _count(user.get("diamonds")), "diamonds"
    if live < amount:
        raise UserError(
            f"This account has {live:,} {what}, so {amount:,} cannot be deducted. "
            "Nothing was recorded."
        )
    return {"currency": currency, "amount": amount, "balance_at_request": live}


async def _find_warning_card(warning_id: str) -> dict | None:
    existing = await get_db()[C.CARDS].find_one(
        {"payload.warning_id": warning_id, "type": str(CardType.BALANCE_DEBIT)}
    )
    if not existing:
        return None
    out = dict(existing)
    out["id"] = str(out.pop("_id", ""))
    return out


async def _raise_warning_deduction_card(
    uid: str, user: dict, warning_id: str, plan: dict, reason: str, actor: dict,
) -> dict:
    """One `balance_debit` card per warning — found again on a retry, never doubled.

    The look-up alone is not enough: two requests in flight with the same
    request id both find nothing. The unique index on `payload.warning_id`
    (`mongo.ensure_warning_card_index`) refuses the second insert, and the
    loser answers with the winner's card.
    """
    existing = await _find_warning_card(warning_id)
    if existing:
        return existing

    name = user.get("name", "") or uid
    currency, amount = plan["currency"], plan["amount"]
    try:
        card = await cards.raise_card(
            NewCard(
                type=CardType.BALANCE_DEBIT,
                team=Team.FINANCE,
                title=f"Warning deduction: {amount} {currency} — {name}",
                amount=-amount,
                currency=currency,
                reason=reason,
                subject_type="user",
                subject_id=uid,
                payload={
                    "uid": uid,
                    "name": name,
                    "currency": currency,
                    "amount": -amount,
                    "balance_before_request": plan["balance_at_request"],
                    "source": "warning",
                    "warning_id": warning_id,
                },
            ),
            actor,
        )
    except CardError as exc:
        raise UserError(str(exc)) from exc
    except DuplicateKeyError:
        winner = await _find_warning_card(warning_id)
        if winner is None:
            raise
        return winner

    await audit.record(
        actor=actor,
        action=audit.Action.BALANCE_CHANGE_REQUESTED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        after={"requested": {currency: -amount}},
        card_id=card["id"],
        meta={"card_type": str(CardType.BALANCE_DEBIT), "stage": card["stage"],
              "source": "warning", "warning_id": warning_id},
    )
    try:
        await _fs(
            _user_ref(uid).collection(WARNINGS).document(warning_id).update,
            {"deductionCardId": card["id"]},
        )
    except Exception:  # noqa: BLE001 — the card is found again by its payload
        log.warning("warning %s: card id not written back", warning_id)
    return card


async def _replay_warning(
    uid: str, user: dict, warning_id: str, prior: dict, actor: dict,
    reason: str, deduction: dict | None,
) -> dict:
    """A retried request: answer with what the first one did, and finish what
    an interrupted first attempt left undone.

    UGP review — the STORED warning is never trusted to carry money. Staff can
    write `users/{uid}/warnings` from a browser (firestore.rules), and the
    warning id is derived from a request id the caller chooses, so a document
    planted at that id could otherwise turn a plain retry into a deduction
    card that skipped the permission check, the currency rule and the balance
    check. So a replay:

      * must come from the reviewer who issued the warning;
      * must ask for exactly what the warning records — the same deduction
        (currency and amount) or none. The route has already enforced
        `can_adjust_balance` on a request that carries one;
      * re-checks the currency against the person's roles before raising a card
        the first attempt never got to (one it did raise is just found again).

    Then the audit row and the person's notice — both keyed on the warning, so
    neither is written twice — in case the first attempt died before them.
    """
    if str(prior.get("issuedBy") or "") != str(actor.get("uid") or ""):
        raise UserError(
            "This request id belongs to a warning another reviewer issued. Nothing was changed."
        )
    stored = prior.get("deduction") or None
    if stored is not None and (
        not isinstance(stored, dict)
        or isinstance(stored.get("amount"), bool)
        or not isinstance(stored.get("amount"), int)
    ):
        # Staff can write warning documents from a browser; a malformed one is
        # refused cleanly rather than crashing the retry.
        raise UserError(
            "The warning this request id points at is malformed. Nothing was "
            "changed — start a new warning."
        )
    stored_key = (
        (str(stored.get("currency") or ""), int(stored["amount"])) if stored else None
    )
    asked_key = _parse_deduction(deduction) if deduction else None
    if stored_key != asked_key:
        raise UserError(
            "This request id was already used for a different warning. Nothing was "
            "changed — start a new warning."
        )

    plan = None
    card = None
    if stored_key:
        plan = {"currency": stored_key[0], "amount": stored_key[1],
                "balance_at_request": int(stored.get("balanceAtRequest") or 0)}
        card = await _find_warning_card(warning_id)
        if card is None:
            from app.services import user_roles  # local: keeps the import graph acyclic

            inventory = await user_roles.role_inventory(uid, user=user, db=get_db())
            if stored_key[0] not in user_roles.deduction_currencies(inventory["roles"]):
                raise UserError(
                    f"A deduction in {stored_key[0]} no longer applies to this account. "
                    "The warning stands; no deduction card was raised."
                )
            card = await _raise_warning_deduction_card(
                uid, user, warning_id, plan, str(prior.get("reason") or reason), actor
            )

    count = int(user.get("warnings", 0) or 0)
    before, after = {"warnings": max(0, count - 1)}, {"warnings": count}
    audit_id = ""
    already = await get_db()[C.AUDIT].find_one({
        "action": str(audit.Action.USER_WARNED),
        "subject.id": uid,
        "meta.warning_id": warning_id,
    })
    if already is None:
        audit_meta: dict = {"warning_id": warning_id, "completed_on_retry": True}
        if plan:
            audit_meta["deduction"] = {
                "currency": plan["currency"], "amount": plan["amount"],
                "card_id": (card or {}).get("id", ""), "result": "card_raised",
            }
        audit_id = await audit.record(
            actor=actor,
            action=audit.Action.USER_WARNED,
            subject_type="user",
            subject_id=uid,
            reason=str(prior.get("reason") or reason),
            before=before,
            after=after,
            meta=audit_meta,
            card_id=(card or {}).get("id") or None,
        )
    issued_at = prior.get("issuedAt")
    if not isinstance(issued_at, datetime):
        issued_at = datetime.now(timezone.utc)
    # Only if the first attempt never delivered it: re-delivering would mark a
    # notice the person has already read as unread again (UGP review).
    from app.services import notices as _notices

    try:
        delivered = await _fs(
            firebase.firestore_client().collection(_notices.NOTIFICATIONS)
            .document(f"warning_{warning_id}").get
        )
        already_delivered = bool(getattr(delivered, "exists", False))
    except Exception:  # noqa: BLE001 — unknown: deliver, an unread notice is the lesser harm
        already_delivered = False
    if not already_delivered:
        await _deliver_warning_notice(uid, str(prior.get("reason") or reason), warning_id, issued_at)

    return _result(
        uid, before, after, audit_id,
        warning_id=warning_id, replayed=True, deduction=_deduction_view(plan, card),
    )


async def _deliver_warning_notice(
    uid: str, reason: str, warning_id: str, now: datetime
) -> None:
    """Put an official warning in the user's inbox. Never raises.

    ── WHAT THE USER SEES, AND WHAT THEY DO NOT ────────────────────────────

    `reason` is the sentence the reviewer wrote, and the CRM already tells
    them it may be shown — the Warn form says so above the field. What is NOT
    carried, and why `actor` is not a parameter here: the actor's uid, name or
    role, the audit id, and anything in `meta`. Who moderated an account is
    internal, and naming the staff member on the warning invites them to be
    contacted about it directly.

    ── IDEMPOTENT ON THE WARNING ID ────────────────────────────────────────

    The document id is derived from the warning, so a retried request — the
    CRM's own retry, a double-press, a timed-out POST the caller repeats —
    overwrites rather than stacking a second identical notice in somebody's
    inbox. Each distinct warning still gets its own notice, because each gets
    its own `warning_id`.
    """
    # `services/notices.deliver` is the one writer for every Official message
    # — approvals, rejections, revocations and recharges go through the same
    # function with the same three guarantees (addressed on `userId`,
    # idempotent on the key, never raises). This was the first caller; it was
    # generalised rather than copied.
    from app.services import notices

    # §12: the same writer carries the email (`user.warning`, to the person's
    # verified address only; skipped — not failed — when there is none).
    await notices.official_warning(uid, warning_id, reason, issued_at=now)


async def grant_host(
    uid: str, agency_id: str, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Make a user a host, optionally attached to an agency.

    ── WHAT THIS WRITES, AND WHAT IT USED TO LEAVE BEHIND ────────────────────

    `activateHost` — the Cloud Function a host triggers by redeeming a referral
    code — writes four things: the user document, the application, the
    verification record, and the agency's roster row under
    `agencies/{id}/agencyHosts/{uid}`.

    This path wrote one of the four. A host granted here was therefore:

      * missing `callRateBeans`, so the CRM showed their call rate as an em
        dash and the call functions charged the platform base rate rather than
        the rate the agency agreed;
      * missing their roster row, and the roster is the ONLY statement anywhere
        that an agency has a given host. The weekly commission report iterates
        it, so the agency earned nothing on that host's beans — silently, with
        the host visible on every other screen;
      * missing the VERIFICATION RECORD, which was the worst of the three.
        `submitHostCapture` refuses outright when it is absent, so this host
        could never submit a face capture, could never be verified, and
        `isVerifiedHost` gates going live, their own call rate and every weekly
        payout release. The escape hatch for a host who could not redeem a code
        led straight into a host who could never be paid.

    So the three missing pieces are written here too, from the host's own
    application where one exists. None of it is invented: no application means
    no agreed rate, and the rate is simply left unset rather than guessed.

    The user document and the verification record go in ONE BATCH, so a failure
    cannot leave `isHost: true` behind with no way to verify it. See
    `host_verification_seed` for what the record holds and why.

    `isVerifiedHost` is NOT written — granting host status is not a statement
    about somebody's face, and the capture is the host's own act. The four
    states stay distinct: applied, activated, capture submitted, verified.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="grant host to")

    reason = _require_reason(reason)

    # The role table, re-checked at the grant: an Agency or Sub-agency may not
    # also be a Host, whatever was true when the application was filed. The
    # application being decided is not counted against itself.
    from app.services import partner_applications as apps  # local: apps imports this module

    try:
        await apps.recheck_at_decision(
            uid, "host",
            exclude_host_application_id=str((meta or {}).get("application_id") or ""),
            # RC role rule: a Sub-agency of main Agency X is a Host only under X.
            parent_id=str(agency_id or "").strip(),
        )
    except apps.ApplicationError as exc:
        raise UserError(str(exc)) from exc
    user = await _load_user(uid)

    before = {
        "isHost": bool(user.get("isHost", False)),
        "agencyId": user.get("agencyId", ""),
    }

    patch: dict = {"isHost": True, "hostAddedAt": datetime.now(timezone.utc)}
    patch.update(_stamp(actor, "hostGranted"))
    if agency_id and agency_id.strip():
        patch["agencyId"] = agency_id.strip()

    resolved_agency = patch.get("agencyId", before["agencyId"])

    # B18: the agency is re-validated at the GRANT, not only when the
    # application was filed — it may have been suspended or revoked since, and
    # a sub-agency's own main agency must still be live too. The same checks
    # the application had to pass (`_validate_host_parent`), and the same ones
    # `restore_host` and the app's referral path already apply.
    if resolved_agency:
        try:
            await apps._validate_host_parent(resolved_agency, uid)
        except apps.ApplicationError as exc:
            raise UserError(
                f"{exc} The Host role was not granted — decide the application "
                "again once the agency is active, or refuse it."
            ) from exc
    app_id = str((meta or {}).get("application_id") or "").strip()
    app: dict = {}
    if app_id:
        snap = await _fs(_host_application_ref(app_id).get)
        if snap.exists:
            app = snap.to_dict() or {}

    # The agreed rate, if there is an application and the user has no rate yet.
    # An existing rate is never overwritten: a host may have moved themselves
    # up the level ladder since, and `setCallRate` clamps to their own rung.
    rate = app.get("callRate")
    if rate and not user.get("callRateBeans"):
        try:
            patch["callRateBeans"] = int(rate)
        except (TypeError, ValueError):
            pass

    # ── The user document and the verification record, in one batch ──────────
    #
    # This is the half-created host. `isHost: true` with no verification record
    # is an account that looks completely healthy on every CRM screen and can
    # never be verified — so can never go live and can never be paid — with
    # nothing on either side saying why. A Firestore batch is atomic, so either
    # both land or neither does and the person is simply not a host yet.
    #
    # The record is only seeded when it is ABSENT. A host who already has one —
    # granted after a part-finished activation, say — keeps their attempt count,
    # their capture and their rejection history; a merge that rewrote
    # `createdAt` and reset `attemptCount` to zero would quietly undo a
    # reviewer's work.
    batch = firebase.firestore_client().batch()
    batch.update(_user_ref(uid), patch)

    existing_ver = await _fs(_host_verification_ref(uid).get)
    if not existing_ver.exists:
        batch.set(
            _host_verification_ref(uid),
            host_verification_seed(
                uid,
                agency_id=resolved_agency or "",
                application_id=app_id,
                host_name=str(app.get("hostName") or user.get("name") or ""),
                # Only an application carries a photograph to compare against.
                # Absent is fine and already handled: `submitHostCapture` routes
                # a capture with nothing to compare to straight to manual review.
                agency_photo_url=str(app.get("photoUrl") or ""),
            ),
        )
    else:
        # B23: the record's history — status, attempts, capture, rejections —
        # stays exactly as it is, but it names the agency and application the
        # Host belongs to NOW. Left alone, the reviewer's queue showed the old
        # agency after a re-grant.
        ver_patch: dict = {"updatedAt": datetime.now(timezone.utc)}
        if resolved_agency:
            ver_patch["agencyId"] = resolved_agency
        if app_id:
            ver_patch["applicationId"] = app_id
        batch.update(_host_verification_ref(uid), ver_patch)

    await _fs(batch.commit)

    if resolved_agency:
        # `merge=True` and no read first, so this repairs a missing row rather
        # than duplicating or clearing one. Mirrors `writeAgencyMembership` in
        # functions/src/hosts.ts, including the field names its readers use:
        # the weekly report reads `uid`/`name`, the dashboards read the rest.
        roster = _host_roster_row(
            uid, str(app.get("hostName") or user.get("name") or ""), resolved_agency,
            app_id, patch.get("callRateBeans"),
        )
        await _fs(
            firebase.firestore_client()
            .collection("agencies")
            .document(resolved_agency)
            .collection("agencyHosts")
            .document(uid)
            .set,
            roster,
            merge=True,
        )

    # FX-12 (RF-05 / DUP-06): the person's OTHER open host applications are
    # closed now that they hold the role — they would otherwise sit in /kyc as
    # a second application for somebody who is already a Host, and refusing
    # one later was how RF-04 took the role away.
    superseded = await supersede_other_host_applications(uid, app_id, actor)

    after = {"isHost": True, "agencyId": patch.get("agencyId", before["agencyId"])}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.HOST_GRANTED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={"agency_id": after["agencyId"], "superseded_applications": superseded, **(meta or {})},
    )
    return _result(uid, before, after, audit_id, superseded_applications=superseded)


def _host_roster_row(uid: str, name: str, agency_id: str, application_id: str, call_rate) -> dict:
    """The roster row a grant writes under `agencies/{agency}/agencyHosts/{uid}`.

    Mirrors `writeAgencyMembership` in functions/src/hosts.ts, including the
    field names its readers use: the weekly report reads `uid`/`name`, the
    dashboards read the rest.
    """
    roster: dict = {
        "uid": uid,
        "name": name,
        "agencyId": agency_id,
        "joinedAt": datetime.now(timezone.utc),
        # FX-10: a grant makes the row current again, whatever it said.
        **roster_current_fields(),
    }
    if application_id:
        roster["applicationId"] = application_id
    if call_rate:
        roster["callRateBeans"] = call_rate
    return roster


#: HT-2 — what an activation reports when the role started but the application
#: could not be recorded as approved, and what it reports when another decision
#: took the application over first.
ACTIVATION_NOT_RECORDED = (
    "The Host role has started, but the application could not be recorded as approved "
    "yet: the database did not confirm it. The next check finishes it; nothing is "
    "granted twice."
)
ACTIVATION_SUPERSEDED = (
    "The Host role has started, but another decision took this application over before "
    "it could be recorded here. Reload it to see how it was recorded."
)


async def _host_granted_for_application(uid: str, application_id: str, user: dict | None) -> bool:
    """HT-2 — did a grant from THIS application already land?

    `grant_host` writes `isHost` on the account and this application's id on the
    host's verification record in ONE batch, so the pair is the trace of a grant
    made from this application — an activation that was interrupted after the
    grant (the decision stamp failed, or something after the batch did). Agency
    equality alone, which a reviewer's decision uses (B22), would also match a
    Host of the same agency granted from somewhere else.
    """
    if not application_id or not user or not user.get("isHost"):
        return False
    ver = await _fs(_host_verification_ref(uid).get)
    return bool(getattr(ver, "exists", False)) and (
        str((ver.to_dict() or {}).get("applicationId") or "") == application_id
    )


async def _resume_host_grant(
    uid: str, user: dict, app: dict, application_id: str, reason: str, actor: dict,
) -> dict:
    """HT-2 — finish a grant from this application that an interruption left part-done.

    Runs under the application's decision lease. Re-granting is refused by the
    role table ("You are already a Host") — that refusal is what used to leave
    the application `awaiting_verification` for good — and would re-stamp the
    grant. So only the steps after `grant_host`'s batch are repeated, each
    idempotent: the roster row when it is missing or not current (an existing
    current row, its `joinedAt` and its rate are left alone); the person's other
    open applications closed; and the `HOST_GRANTED` audit entry written only
    when none exists for this application.
    """
    agency = str(user.get("agencyId") or app.get("agencyId") or "").strip()
    roster_repaired = False
    if agency:
        row_ref = (
            firebase.firestore_client().collection("agencies").document(agency)
            .collection("agencyHosts").document(uid)
        )
        row = await _fs(row_ref.get)
        if not getattr(row, "exists", False) or not roster_row_is_current(row.to_dict() or {}):
            await _fs(
                row_ref.set,
                _host_roster_row(
                    uid, str(app.get("hostName") or user.get("name") or ""), agency,
                    application_id, user.get("callRateBeans"),
                ),
                merge=True,
            )
            roster_repaired = True
    superseded = await supersede_other_host_applications(uid, application_id, actor)
    prior = next(
        (e for e in await audit.history_for("user", uid)
         if e.get("action") == audit.Action.HOST_GRANTED
         and str((e.get("meta") or {}).get("application_id") or "") == application_id),
        None,
    )
    after = {"isHost": True, "agencyId": agency}
    if prior is not None:
        audit_id = str(prior.get("id") or "")
    else:
        audit_id = await audit.record(
            actor=actor,
            action=audit.Action.HOST_GRANTED,
            subject_type="user",
            subject_id=uid,
            reason=reason,
            before={"isHost": True, "agencyId": agency},
            after=after,
            meta={"agency_id": agency, "application_id": application_id, "activation": "contacts_verified",
                  "resumed_after_interruption": True, "superseded_applications": superseded},
        )
    return _result(uid, None, after, audit_id, superseded_applications=superseded,
                   resumed=True, roster_repaired=roster_repaired)


#: FX-12 — what a superseded application says, to the person and to /kyc.
SUPERSEDED_REASON = (
    "Closed: this person became a Host through another application ({by}), so this "
    "one was not decided on its merits. Nothing else changed."
)


async def activate_host_if_verified(uid: str, actor: dict) -> list[dict]:
    """Decision 15 (RC) — start a Host role the Owner approved while contacts were pending.

    Each of this person's applications in `awaiting_verification` is started
    once their account holds BOTH a verified phone and a verified email, read
    from the authoritative sources (never from the caller). The application is
    taken with the same decision lease every decision uses, so two concurrent
    calls grant the role once; the grant itself is `grant_host`, audited, with
    the role table and the agency re-checked as at any grant.
    """
    from app.services import contact_verification  # local: keeps the import graph acyclic

    uid = str(uid or "").strip()
    out: list[dict] = []
    if not uid:
        return out
    col = firebase.firestore_client().collection(HOST_APPLICATIONS)
    snaps = await _fs(lambda: list(col.where(filter=FieldFilter("applicantUid", "==", uid)).stream()))
    waiting = [sn for sn in snaps if str((sn.to_dict() or {}).get("status") or "") == "awaiting_verification"]
    if not waiting:
        return out
    verification = await asyncio.to_thread(contact_verification.status, uid)
    trigger = str(actor.get("triggered_by") or "").strip()
    started_reason = "Both contacts verified; the Host role approved earlier has started." + (
        f" Checked at the request of account {trigger}." if trigger else ""
    )
    for snap in waiting:
        app = snap.to_dict() or {}
        if not verification.complete:
            out.append({"application_id": snap.id, "activated": False,
                        "refusal": contact_verification.refusal_detail(
                            verification, "The Host role starts once both contacts are verified.")})
            continue
        app_ref = _host_application_ref(snap.id)
        try:
            lease = await _fs(
                firebase.claim_decision, app_ref,
                expected_status="awaiting_verification", actor_uid=str(actor.get("uid", "")),
                default_status="pending",
            )
        except firebase.DecisionConflict as exc:
            out.append({"application_id": snap.id, "activated": False, "busy": True,
                        **({"detail": str(exc)} if exc.reason in ("contended", "unknown") else {})})
            continue
        resumed = False
        try:
            # The restriction, the role table and the agency are re-checked by
            # `restore`-grade rules inside `grant_host`; a refusal there leaves
            # THIS application waiting and is reported for it alone — one
            # application that cannot start must not stop the others.
            prior = None
            try:
                prior = await _load_user(uid)
            except UserNotFound:
                prior = None
            if prior is not None and restriction_of(prior):
                raise UserError(
                    "This account is suspended or banned, so the approved Host role "
                    "cannot start until that is lifted."
                )
            if await _host_granted_for_application(uid, snap.id, prior):
                # HT-2: an earlier run granted the role from this application
                # and stopped before the application was recorded. Finish it;
                # never grant twice.
                account = await _resume_host_grant(uid, prior, app, snap.id, started_reason, actor)
                resumed = True
            else:
                account = await grant_host(
                    uid, str(app.get("agencyId") or ""),
                    started_reason,
                    actor, meta={"application_id": snap.id, "activation": "contacts_verified"},
                )
        except UserError as exc:
            await _fs(firebase.release_decision, app_ref, lease)
            out.append({"application_id": snap.id, "activated": False, "refusal": str(exc)})
            continue
        except Exception:
            await _fs(firebase.release_decision, app_ref, lease)
            raise
        # ── The role has started. Now the application must say so ─────────────
        #
        # HT-2: `complete_decision_retry_once` recognises a stamp it already wrote
        # (an answer lost after the commit) and tries a stamp it could not
        # confirm once more under the same lease. The approval is audited only
        # when the application IS recorded as approved — it used to be audited
        # even when the stamp came back False, and a failed stamp used to escape
        # as an error with the lease held and the application stuck.
        now = datetime.now(timezone.utc)
        try:
            stamped = await _fs(
                firebase.complete_decision_retry_once, app_ref, lease,
                {"status": "approved", "kycStatus": "approved", "isActivated": True,
                 "activatedByUid": uid, "activatedAt": now, "activationStartedAt": now,
                 "activationPending": fb_firestore.DELETE_FIELD, "updatedAt": now},
                expected_status="awaiting_verification", default_status="pending",
            )
        except firebase.DecisionNotRecorded as exc:
            released = await _fs(firebase.release_decision, app_ref, lease)
            log.error(
                "Host role of %s started from application %s, but the application could not be "
                "recorded as approved (%s); lease %s. The next activation check finishes it.",
                uid, snap.id, exc.outcome, released,
            )
            out.append({"application_id": snap.id, "activated": True, "recorded": False,
                        "pending_completion": True, "outcome": exc.outcome,
                        "lease_released": released == "released",
                        "detail": ACTIVATION_NOT_RECORDED, "account": account})
            continue
        if not stamped:
            log.error(
                "Host role of %s started from application %s, but another decision took the "
                "application over before it was recorded", uid, snap.id,
            )
            out.append({"application_id": snap.id, "activated": True, "recorded": False,
                        "conflict": True, "detail": ACTIVATION_SUPERSEDED, "account": account})
            continue
        await audit.record(
            actor=actor,
            action=audit.Action.HOST_APPLICATION_APPROVED,
            subject_type="host_application",
            subject_id=snap.id,
            reason=started_reason,
            before={"status": "awaiting_verification"},
            after={"status": "approved", "kycStatus": "approved"},
            meta={"agency_id": str(app.get("agencyId") or ""), "uid": uid,
                  "activation": "contacts_verified",
                  "host_grant_audit_id": (account or {}).get("audit_id", ""),
                  **({"resumed_after_interruption": True} if resumed else {})},
        )
        await asyncio.to_thread(contact_verification.record_phone, uid, verification.phone)
        out.append({"application_id": snap.id, "activated": True, "recorded": True, "account": account,
                    **({"resumed": True} if resumed else {})})
    return out


async def supersede_other_host_applications(uid: str, keep_application_id: str, actor: dict) -> list[str]:
    """FX-12 — close the person's other OPEN host applications; release their locks.

    "Open" is a self-application of this account (`applicantUid == uid`) still
    pending and never redeemed. An agency's invitation names no account until it
    is redeemed, so it is never matched here — /kyc flags it as the same person
    instead. Each one is stamped as a refusal (both status fields, through
    `_host_decision_fields`, so no screen can read it as pending) plus
    `supersededBy` / `supersededAt`, and its B32 lock is given back.

    Best effort, after the grant: the grant has happened, and a failure here
    leaves an application a reviewer can still refuse — which FX-01 makes safe.
    Returns the ids it closed.
    """
    uid = str(uid or "").strip()
    keep = str(keep_application_id or "").strip()
    if not uid:
        return []
    from app.services import partner_applications as apps  # local: apps imports this module

    col = firebase.firestore_client().collection("hostApplications")
    try:
        snaps = await _fs(lambda: list(col.where(filter=FieldFilter("applicantUid", "==", uid)).stream()))
    except Exception:  # noqa: BLE001
        log.exception("Could not read the other host applications of %s", uid)
        return []
    now = datetime.now(timezone.utc)
    note = SUPERSEDED_REASON.format(by=keep or "a direct grant")
    closed: list[str] = []
    for snap in snaps:
        if snap.id == keep:
            continue
        data = snap.to_dict() or {}
        # Decision 15 (RC): an application the Owner approved that is still
        # WAITING for verified contacts is open too — once the person holds the
        # role through another application it can never start (`grant_host`
        # refuses a second grant), so leaving it would wait forever.
        if (str(data.get("status") or "pending") not in ("pending", "awaiting_verification")
                or data.get("isActivated") is True):
            continue
        try:
            await _fs(
                col.document(snap.id).update,
                {**_host_decision_fields(False, note, actor, now),
                 "supersededBy": keep, "supersededAt": now,
                 "activationPending": fb_firestore.DELETE_FIELD},
            )
        except Exception:  # noqa: BLE001
            log.exception("Could not close superseded host application %s", snap.id)
            continue
        closed.append(snap.id)
        await apps.release_host_application_lock(uid, snap.id)
    return closed


async def revoke_host(
    uid: str, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Remove host status.

    `agencyId` is left in place. The agency's commission statement is built
    from the ledger and refers to this link, so clearing it would orphan
    history that has already been paid on. Re-granting to a different agency
    overwrites it.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="revoke host from")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    if not user.get("isHost", False):
        raise UserError("This account is not a host.")

    # UGP-B: ONE active role → suspend the account, never a separate revoke.
    # Counted from the authoritative records (Mongo `partners` + this flag), so
    # the rule holds whatever a client offered.
    from app.services import user_roles  # local: user_roles reads this module's peers

    if await user_roles.held_count(uid, db=get_db()) < 2:
        raise UserError(user_roles.SINGLE_ROLE_REFUSAL.format(label="Host"))

    before = {"isHost": True, "agencyId": user.get("agencyId", "")}

    patch: dict = {"isHost": False, "hostRemovedAt": datetime.now(timezone.utc)}
    patch.update(_stamp(actor, "hostRevoked"))
    # B34 / C1: the reason travels with the revocation, so the person's own
    # applications list and the eligibility answer can say why — not only the
    # audit log and a notice that scrolls away.
    patch["hostRevokedReason"] = reason
    # RC (confirmed): the revoked Host's pending earnings are frozen for the
    # Owner's review, first; the beans stop in the same write as the revocation.
    patch.update(money_freeze.hold_fields("the Host role's revocation"))
    await money_freeze.freeze_user(uid, cause="host_revoked", label="the Host role's revocation",
                                   reason=reason, actor=actor, include_partners=False, db=get_db())
    # FX-10 (RF-15): the roster row is marked INACTIVE in the same write as the
    # account. It used to stay exactly as it was, so the weekly payout report,
    # the agency's app screen and the revoke-with-dependents cascade — which
    # all read the roster and nothing else — went on counting a revoked Host.
    # Marked, not deleted: the row is the history of who was on the roster,
    # and `restore_host` re-activates the same row.
    roster_ref = _roster_ref(before["agencyId"], uid)
    roster_snap = await _fs(roster_ref.get) if roster_ref is not None else None
    if roster_snap is not None and roster_snap.exists:
        batch = firebase.firestore_client().batch()
        batch.update(_user_ref(uid), patch)
        batch.update(roster_ref, roster_removal_fields("revoked", patch["hostRemovedAt"]))
        await _fs(batch.commit)
    else:
        await _patch_user(uid, patch)

    # §5 Revoke Host: "stop live/call". Every room this Host is streaming in is
    # ended through the existing intervention (`live.end_room`), audited as
    # its own act with this revocation's reason. Best effort and reported: the
    # revocation is committed above, and a room that cannot be closed is named
    # rather than hidden. Calls are ended by the app when it reads the flags
    # (`isHost: false` is refused by the call functions); the backend has no
    # call-control path of its own.
    live_rooms = await _end_live_rooms_of(uid, reason, actor)

    after = {"isHost": False, "agencyId": before["agencyId"]}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.HOST_REVOKED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "agency_id": before["agencyId"],
            "live_rooms_ended": live_rooms["ended"],
            "live_rooms_not_ended": live_rooms["failed"],
            # Stated: the person's account and their other roles are untouched.
            "account_touched": False,
            "other_roles_touched": False,
            **(meta or {}),
        },
    )
    # Tell the person — and their agency (§5: "notify host and agency"). The
    # audit row and the account patch are committed; this is delivery, best
    # effort, and last.
    from app.services import notices

    notified_host = await notices.host_revoked(uid, reason)
    notified_agency = await _notify_agency_of_host_change(
        before["agencyId"], uid, str(user.get("name") or ""), "revoked", reason,
    )
    return _result(
        uid, before, after, audit_id,
        live_rooms_ended=live_rooms["ended"],
        live_rooms_not_ended=live_rooms["failed"],
        notified={"host": notified_host, "agency": notified_agency},
    )


async def _end_live_rooms_of(uid: str, reason: str, actor: dict) -> dict:
    """End every ACTIVE live room hosted by `uid`. Never raises.

    Returns `{"ended": [room ids], "failed": [{"room_id", "error"}]}`.
    """
    from app.services import live as live_svc  # local: live imports this module's peers

    out: dict[str, list] = {"ended": [], "failed": []}
    try:
        def _rooms() -> list[str]:
            q = (
                firebase.firestore_client().collection(live_svc.ROOMS)
                .where(filter=FieldFilter("hostUid", "==", uid))
                .where(filter=FieldFilter("isActive", "==", True))
                .limit(20)
            )
            return [snap.id for snap in q.stream()]

        rooms = await _fs(_rooms)
    except Exception as exc:  # noqa: BLE001 — the revocation stands; say what happened
        log.warning("live rooms of %s could not be listed: %s", uid, exc)
        return {"ended": [], "failed": [{"room_id": "", "error": f"rooms could not be listed: {exc}"}]}
    for room_id in rooms:
        try:
            await live_svc.end_room(room_id, f"{reason} (Host role revoked)", actor)
            out["ended"].append(room_id)
        except Exception as exc:  # noqa: BLE001 — reported, never swallowed
            log.warning("live room %s of %s not ended on revocation: %s", room_id, uid, exc)
            out["failed"].append({"room_id": room_id, "error": str(exc)})
    return out


async def _notify_agency_of_host_change(
    agency_id: str, host_uid: str, host_name: str, change: str, reason: str,
) -> bool:
    """Tell the agency's owner that one of their Hosts was revoked (§5). Never raises."""
    from app.services import notices
    from app.services import partner_roles

    agency_id = str(agency_id or "").strip()
    if not agency_id:
        return False
    try:
        agency = await get_db()[C.PARTNERS].find_one({"_id": agency_id})
        owner = await partner_roles.owner_uid_of(agency, db=get_db()) if agency else ""
    except Exception as exc:  # noqa: BLE001
        log.warning("agency %s owner could not be resolved for the host notice: %s", agency_id, exc)
        return False
    if not owner or owner == host_uid:
        return False
    return await notices.agency_host_revoked(
        owner, agency_id, host_uid, host_name, reason, change=change,
    )


async def restore_host(
    uid: str, reason: str, actor: dict,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Restore a REVOKED Host role from the person's existing records (UGP-B).

    "Restoration restores the existing role and records, no duplicates": the
    approved application the person joined on is re-used, the agency roster row
    is re-written onto the same agency, and the verification record is kept as
    it is — a host verified before the revocation is still verified, and one
    who was not still has to capture. No new application, no new record.

    Refused when there is nothing to restore (never a host, or no approved
    application), when the account is restricted (lift that first), when the
    host's agency is no longer an approved, active agency (the roster would
    point at nobody — FLOW-MAP D15), or when the role table no longer allows a
    Host alongside what the person holds now.

    C2: turning a revoked role back is the Owner's decision — directly here,
    or through a decided reinstatement request (`services/role_appeals`),
    which calls this with the Owner as actor. Anyone else is refused with
    `OwnerOnly` (403).

    B33: the role table is applied the way the Host was held — first. A Host
    under a main agency who went on to hold a Sub-agency (a permitted order)
    may have the Host role back; see `partner_applications.recheck_host_restore`.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="restore host to")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    if user.get("isHost", False):
        raise UserError("This account is already a host.")
    revoked_at = user.get("hostRevokedAt") or user.get("hostRemovedAt")
    if not revoked_at:
        raise UserError("This account has no revoked Host role to restore.")
    if not _actor_is_owner(actor):
        raise OwnerOnly(OWNER_ONLY_RESTORE)
    if restriction_of(user):
        raise UserError(
            "This account is restricted. Lift the suspension or ban before "
            "restoring a role."
        )

    from app.services import user_roles  # local: keeps the import graph acyclic

    apps_on_file = await asyncio.to_thread(user_roles._host_applications_for, uid)
    approved = [a for a in apps_on_file if str(a.get("status") or "") == "approved"]
    if not approved:
        raise UserError(
            "There is no approved Host application to restore from. The person "
            "has to apply again."
        )
    # The LATEST approved application, not whichever the query returned first
    # (UGP review): a person can have been approved twice over the years. The
    # roles view (`user_roles.role_inventory`) names the same one.
    app = user_roles.latest_application(approved) or approved[0]
    app_id = str(app.get("id") or "")
    agency_id = str(user.get("agencyId") or app.get("agencyId") or "").strip()
    if not agency_id or not await user_roles._partner_live(agency_id, db=get_db()):
        raise UserError(
            "The agency this Host worked under is not an approved, active agency "
            "any more, so the role cannot be restored onto it."
        )

    from app.services import partner_applications as apps  # local: apps imports this module

    try:
        await apps.recheck_host_restore(uid, exclude_host_application_id=app_id)
    except apps.ApplicationError as exc:
        raise UserError(str(exc)) from exc

    # Decision 15 (RC): restoring the role STARTS it again, so the account must
    # hold both verified contacts, as at a first approval. Not even the Owner
    # restores around it; the person verifies first (the app does both).
    from app.services import contact_verification  # local: keeps the import graph acyclic

    verification = await asyncio.to_thread(contact_verification.status, uid)
    if not verification.complete:
        raise HostContactVerificationRequired(
            verification,
            "Restoring the Host role needs BOTH a verified phone number and a verified "
            f"email address on the account (missing: {', '.join(verification.missing)}). "
            "Nothing was restored.",
        )

    now = datetime.now(timezone.utc)
    before = {"isHost": False, "agencyId": user.get("agencyId", "")}
    patch: dict = {"isHost": True, "hostRestoredAt": now, "agencyId": agency_id}
    patch.update(_stamp(actor, "hostRestored"))

    # The roster row, re-written onto the SAME agency (merge: a surviving row is
    # repaired, never duplicated).
    roster: dict = {
        "uid": uid,
        "name": str(app.get("hostName") or user.get("name") or ""),
        "agencyId": agency_id,
        "applicationId": app_id,
        "restoredAt": now,
        # FX-10: the SAME row, current again — `revoke_host` marked it inactive.
        **roster_current_fields(),
    }
    if user.get("callRateBeans"):
        roster["callRateBeans"] = user.get("callRateBeans")

    # The account, the roster row and — only if it went missing — the
    # verification record, in ONE batch, for the reason `grant_host` gives. An
    # existing verification record is kept exactly as it is: its status,
    # attempts and reviewer history are history. The roster row is in the
    # batch too (UGP review): written after it, a failure left a Host with no
    # roster row and no way to run the restore again ("already a host").
    batch = firebase.firestore_client().batch()
    batch.update(_user_ref(uid), patch)
    batch.set(
        firebase.firestore_client()
        .collection("agencies")
        .document(agency_id)
        .collection("agencyHosts")
        .document(uid),
        roster,
        merge=True,
    )
    existing_ver = await _fs(_host_verification_ref(uid).get)
    if not existing_ver.exists:
        batch.set(
            _host_verification_ref(uid),
            host_verification_seed(
                uid,
                agency_id=agency_id,
                application_id=app_id,
                host_name=str(app.get("hostName") or user.get("name") or ""),
                agency_photo_url=str(app.get("photoUrl") or ""),
            ),
        )
    await _fs(batch.commit)

    after = {"isHost": True, "agencyId": agency_id}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.HOST_RESTORED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={"agency_id": agency_id, "application_id": app_id,
              "verified": bool(user.get("isVerifiedHost"))},
    )

    from app.services import notices

    try:
        epoch = int(revoked_at.timestamp())  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 — a legacy string stamp still keys a notice
        epoch = 0
    await notices.host_restored(uid, app_id, epoch)
    # FX-13 (RF-20): a reinstatement request left open beside this restore is
    # closed (one being decided right now is left to its own decision).
    from app.services import role_appeals  # local: role_appeals imports this module

    closed = await role_appeals.close_after_direct_restore(uid, "host", actor)
    return _result(uid, before, after, audit_id, closed_requests=closed)


# ── The host application decision — one writer, both status fields ────────────
#
# WHY THIS FUNCTION EXISTS AT ALL.
#
# Agencies and coin sellers are decided in exactly one place: `approve_partner`
# and `reject_partner` in `services/partner_ops.py`, which write every status
# field a partner document carries through one helper (`_fs_status_fields`) so
# `status`, `isActive`, `isApproved` and `kycStatus` cannot end up disagreeing.
#
# Hosts never got that treatment. A `hostApplications` document had THREE
# writers of its decision and only one of them wrote both fields:
#
#   * the `add_host` approval queue, which wrote `status: 'approved'` and never
#     touched `kycStatus`;
#   * /kyc, which wrote both, with a reason and a decider;
#   * /hosts, which wrote `kycStatus` alone, from a free-text dropdown, with no
#     reason, no decider and no timestamp.
#
# So the two fields drifted, and `hostDecisionOf` on /kyc exists to REPORT that
# drift rather than guess past it — an application saying `status: approved` and
# `kycStatus: pending` is held as pending and shown to a person. That detector is
# a safety net for records that have already diverged; this function is what
# stops new ones being made. The other two writers are gone.
#
# WHY IT IS HERE AND NOT IN `partner_ops.py`.
#
# A host is not a `partners` row. Every helper in that module resolves a Mongo
# `partners` document by id (`_partner`), maps a `PartnerKind` onto the
# `agencies` or `sellers` collection (`_fs_collection`), and syncs status back to
# one of those two documents (`_sync_partner_doc`). A host application has none
# of it: no Mongo record, no kind, no balances, no commission, no cards. Putting
# it there would mean a second, parallel set of helpers sharing nothing with the
# ones beside them, which is a second module wearing the first one's name.
#
# What a host application decision actually IS, is the thing this module already
# does — a decision about an app account, taken directly, recorded in the Mongo
# audit log with a mandatory reason (5.6). `grant_host` and `revoke_host` are
# right here, and they are the authoritative half of the decision; the stamp on
# the application is the half that clears the queue and tells the applicant. They
# have to be one call, or the next person writes one without the other again.
#
# It is also deliberately NOT a Cloud Function, for the reason
# `services/verification.py` gives about the host identity review: a function
# cannot write the append-only Mongo trail that `/audit` reads. A decision about
# whether somebody may earn on this platform, recorded somewhere no owner ever
# looks, is the same failure in a different collection.


def _host_decision_fields(
    approve: bool, reason: str, actor: dict, now: datetime
) -> dict:
    """The application's status fields as one decision writes them.

    The counterpart of `partner_ops._fs_status_fields`, and it exists for the
    same reason: `status` and `kycStatus` are written **together, from one
    place**, so there is no arrangement of calls that can leave them disagreeing.

    `kycStatus` moves with the decision because the decision IS the verification.
    /kyc renders the applicant's Aadhaar, PAN and bank passbook inline on the
    screen that carries these buttons — approving is the act of having looked at
    them. A rejection withdraws the claim rather than leaving a stale `approved`
    beside a refused application.

    `rejectionReason` is blanked on approval rather than left behind: an earlier
    refusal that has since been overturned is history, and reading it off a live
    approved application says the opposite of what happened.
    """
    verdict = "approved" if approve else "rejected"
    return {
        "status": verdict,
        "kycStatus": verdict,
        "rejectionReason": "" if approve else reason,
        "decidedAt": now,
        "decidedBy": actor.get("name", ""),
        "decidedByUid": actor.get("uid", ""),
        "decidedByRole": str(actor.get("role", "")),
        "decisionReason": reason,
        "updatedAt": now,
    }


async def decide_host_application(
    application_id: str, approve: bool, reason: str, actor: dict
) -> dict:
    """Approve or refuse one host application. The only writer of its decision.

    Does both halves of what the decision means, in one call:

      1. the **account** — `grant_host` on approval, `revoke_host` on a refusal
         of somebody who currently holds host status. Each writes its own audit
         entry, so the grant and the application decision are two facts in the
         log rather than one entry implying the other;
      2. the **application** — `status` and `kycStatus` written together, with
         who decided, when, and why.

    The account is written first. If the second write fails the host has been
    granted and the application still sits in the queue, which is visible and
    fixable by deciding it again; the reverse — an application marked approved
    for a host nobody granted — is invisible, and invisible is the failure mode
    this whole path exists to remove.

    **APPROVAL IS THE GATE, AND IT COMES FIRST.**

    This used to refuse an approval until somebody had already redeemed the
    referral code, on the reasoning that granting host status needs a uid and
    there is no uid before then. True as far as it went — and it put the
    decision in the wrong place. The code worked from the moment the agency
    created the invitation, so an applicant became a host, linked to an agency
    and earning at an agreed rate, BEFORE anyone had looked at their Aadhaar
    card, PAN card or bank passbook. The reviewer's approval arrived afterwards
    and could only ratify what had already happened. A screen that says
    "Pending Approval" while the thing it gates has already occurred is worse
    than no gate at all.

    So approving now marks the APPLICATION, which needs no account:

        agency invites  →  pending
        reviewer approves the documents  →  approved     ← this call
        applicant redeems the code       →  becomes a host

    `activateHost` refuses a code whose application is not approved, so the
    decision made here is what lets somebody in. When the applicant has already
    redeemed — which is possible for an invitation approved under the old order
    — the account is granted here as before, so nothing half-done is left
    behind.

    **Refusal works either way.** Refusing an invitation nobody has redeemed is
    exactly the case a reviewer needs: it cancels the invitation, and
    `checkReferralCode` refuses the code from that moment on.
    """
    reason = _require_reason(reason)

    snap = await _fs(_host_application_ref(application_id).get)
    if not snap.exists:
        raise UserNotFound("No host application with that id.")
    app = snap.to_dict() or {}

    # UGP-B: a decision is made ONCE. Refusing an application that is already
    # approved was a second, unguarded way to revoke a Host — it skipped the
    # one-role rule and stamped the application "rejected" over a decision a
    # reviewer had already made. Revoking is `revoke_host`; restoring is
    # `restore_host`. Approving again stays possible only as the documented
    # repair of a half-finished approval (the account never became a host).
    current = str(app.get("status") or "pending")
    if current == "approved" and not approve:
        raise UserError(
            "This application is already approved. To take the Host role away use "
            "Revoke host (or suspend the account if Host is their only role)."
        )
    if current == "rejected" and not approve:
        raise UserError("This application has already been refused.")
    if current == "rejected" and approve:
        # §4: a decided application is never replayed into an approval. The
        # refusal is history; the person applies again (a NEW application),
        # exactly as a rejected partner record is never approved (Decision 16).
        raise UserError(
            "This application was already refused. A decided application is never "
            "replayed into an approval — the person applies again, and the refused "
            "application stays as history."
        )
    if current == "approved" and approve:
        holder_uid = str(app.get("activatedByUid") or app.get("applicantUid") or "").strip()
        holder = None
        if holder_uid:
            try:
                holder = await _load_user(holder_uid)
            except UserNotFound:
                holder = None
        if holder is None or holder.get("isHost") or holder.get("hostRevokedAt"):
            raise UserError(
                "This application is already approved."
                + (" To bring back a revoked Host use Restore host."
                   if holder is not None and holder.get("hostRevokedAt") else "")
            )

    # Two ways an application can name its human:
    #   * `activatedByUid` — an agency-filed invitation whose code the person
    #     has already redeemed in the app;
    #   * `applicantUid`   — a SELF-application, filed from the app by the
    #     signed-in user, who is therefore known from the moment it exists.
    # Either way, if a uid is known, approval grants the role directly; the
    # referral-code redemption step exists only for invitations addressed to
    # somebody who has not signed in yet.
    uid = str(app.get("activatedByUid") or app.get("applicantUid") or "").strip()
    applicant_uid = str(app.get("applicantUid") or "").strip()
    agency_id = str(app.get("agencyId") or "").strip()
    host_name = str(app.get("hostName") or app.get("name") or "").strip()

    before = {
        "status": app.get("status", ""),
        "kycStatus": app.get("kycStatus", ""),
    }

    # ── B17: the decision is taken against the status just read ─────────────
    #
    # A lease on the application, compare-and-set in a transaction, BEFORE the
    # account is touched: a second reviewer deciding the same application at
    # the same moment is refused here rather than granting or revoking a Host
    # alongside this decision. Released if anything below fails, and the final
    # stamp is conditional on still holding it.
    app_ref = _host_application_ref(application_id)
    try:
        lease = await _fs(
            firebase.claim_decision, app_ref,
            expected_status=current, actor_uid=str(actor.get("uid", "")),
            default_status="pending",
        )
    except firebase.DecisionConflict as exc:
        raise UserError(str(exc)) from exc
    try:
        return await _decide_host_application_under_lease(
            application_id, app, app_ref, lease, current, approve, reason, actor,
            uid, applicant_uid, agency_id, host_name, before,
        )
    except Exception:
        await _fs(firebase.release_decision, app_ref, lease)
        raise


async def _decide_host_application_under_lease(
    application_id: str, app: dict, app_ref, lease: str, current: str,
    approve: bool, reason: str, actor: dict,
    uid: str, applicant_uid: str, agency_id: str, host_name: str, before: dict,
) -> dict:
    """`decide_host_application`, from the moment its lease is held."""
    # ── 1. The account. Audited by grant_host / revoke_host in their own right ──
    account: dict | None = None
    account_note = ""
    awaiting_verification = None
    if approve and uid:
        # UGP review: approving an application of somebody whose Host role was
        # REVOKED gives the role back — a restoration by another door — so it
        # takes restoration's rule: not onto a banned or suspended account
        # (`restore_host` refuses the same). A first-time applicant is
        # unaffected; what a restriction means for a fresh approval is listed
        # for decision in the report.
        try:
            prior_holder = await _load_user(uid)
        except UserNotFound:
            prior_holder = None
        if (prior_holder is not None
                and (prior_holder.get("hostRevokedAt") or prior_holder.get("hostRemovedAt"))
                and not prior_holder.get("isHost")
                and restriction_of(prior_holder)):
            raise UserError(
                "This person's Host role was revoked and their account is restricted. "
                "Lift the suspension or ban before giving the role back. Nothing was changed."
            )
        if (
            prior_holder is not None
            and prior_holder.get("isHost")
            and str(prior_holder.get("agencyId") or "").strip() == agency_id
        ):
            # B22: the grant already happened — a half-finished approval being
            # retried, or a Host of this agency whose application is decided
            # late. Granting again would be refused ("already a Host") and the
            # application could never be stamped; the decision is recorded and
            # nothing about the account changes.
            account_note = (
                "This person is already a Host of this agency, so only the "
                "decision was recorded."
            )
        else:
            # ── Decision 15 (RC): approval is not activation ────────────────
            # The Host role starts only when the person's login holds BOTH a
            # verified phone and a verified email. Without both, only the
            # Owner may approve, and the application WAITS — approved,
            # granting nothing — until `activate_host_if_verified` grants it.
            from app.services import contact_verification  # local: acyclic

            verification = await asyncio.to_thread(contact_verification.status, uid)
            if not verification.complete:
                if not _actor_is_owner(actor):
                    raise HostContactVerificationRequired(
                        verification,
                        "The Host role can start only once the applicant's account has BOTH a "
                        "verified phone number and a verified email address (missing: "
                        f"{', '.join(verification.missing)}). The Owner can approve it now, and "
                        "it will start by itself as soon as both are verified. Nothing was approved.",
                    )
                awaiting_verification = verification
                account_note = (
                    "Approved by the Owner. The Host role starts as soon as both the phone "
                    "number and the email address are verified on the account."
                )
            else:
                # Already redeemed — grant now, so an invitation approved under the
                # old order is not left marked approved with no host behind it.
                account = await grant_host(
                    uid, agency_id, reason, actor, meta={"application_id": application_id}
                )
    elif approve:
        # Not redeemed yet, which is the normal case: the decision is recorded
        # on the application and `activateHost` grants the account when the
        # applicant enters their code.
        account_note = (
            "Approved. The referral code now works — host status is granted "
            "when the applicant signs in and enters it."
        )
    elif uid:
        # `revoke_host` refuses an account that is not a host, and rightly — but
        # refusing an *application* from somebody who never became one is the
        # ordinary case, not an error, and letting that refusal escape would stop
        # the application ever being stamped. So the state is read first and the
        # response says which of the two happened.
        #
        # A uid naming no `users` document is treated the same way, for the same
        # reason: the account is gone and there is nothing to revoke, and a
        # reviewer must still be able to refuse the application. Refusing to
        # decide it would leave the invitation live against a deleted account.
        try:
            holder = await _load_user(uid)
        except UserNotFound:
            holder = None

        # ── FX-01: ONLY THE ROLE THIS APPLICATION GRANTED ───────────────────
        #
        # The person behind this application may be a Host through ANOTHER
        # one — an agency invitation they redeemed, or a duplicate filed before
        # the one-pending lock existed. Refusing this leftover used to call
        # `revoke_host` all the same, so a reviewer clearing a duplicate from
        # /kyc silently took away a live role (RF-04). The role came from this
        # application only if it is the one that was redeemed for this person:
        # `isActivated` with `activatedByUid` naming them (the legacy order,
        # where a code was redeemed before the decision).
        granted_here = (
            app.get("isActivated") is True
            and str(app.get("activatedByUid") or "").strip() == uid
        ) or (
            # HT-2: an approval whose grant landed but whose stamp could not be
            # recorded (DecisionNotRecordedError, or an activation left
            # `pending_completion`) never wrote `isActivated`. The grant's own
            # trace — `isHost` plus this application on the verification record,
            # one batch — says the role came from HERE, so refusing the
            # application takes back the role it granted.
            await _host_granted_for_application(uid, application_id, holder)
        )

        if holder is None:
            account_note = (
                f"The account this application was redeemed by ({uid}) no longer "
                "exists, so there was no host status to revoke. The application "
                "is refused and the referral code will not work."
            )
        elif holder.get("isHost", False) and not granted_here:
            account_note = (
                "The applicant is already a Host through another application, so "
                "their Host role was not touched. Only this application is refused. "
                "To take the role away, revoke it on the account (or suspend it)."
            )
        elif holder.get("isHost", False):
            try:
                account = await revoke_host(
                    uid, reason, actor, meta={"application_id": application_id}
                )
            except UserError as exc:
                # UGP review: the one-role rule. Refusing the APPLICATION still
                # has to be possible — otherwise it sits pending forever — but
                # it no longer takes a person's only role away with it.
                from app.services import user_roles  # local: keeps the import graph acyclic

                if user_roles.SINGLE_ROLE_REFUSAL.format(label="Host") not in str(exc):
                    raise
                account_note = (
                    "The applicant is already a Host and it is their only role, so the "
                    "role was kept — suspend the account to take it away. The "
                    "application is refused."
                )
        else:
            account_note = (
                "The applicant's account is not a host, so nothing was revoked. "
                "The application is refused and the referral code will not work."
            )
    else:
        account_note = (
            "Nobody redeemed this referral code, so there was no account to "
            "revoke. The invitation is cancelled."
        )

    # ── 2. The application. Both status fields, together, with the audit fields ─
    now = datetime.now(timezone.utc)
    after = _host_decision_fields(approve, reason, actor, now)
    if awaiting_verification is not None:
        # Decision 15: the documents are approved; the ROLE waits. Its own
        # status, so no reader takes it for an approved, activated Host and
        # `activateHost`'s "approved" gate never opens the code for it.
        after.update({
            "status": "awaiting_verification",
            "activationPending": awaiting_verification.missing,
        })
    elif approve and uid and not app.get("isActivated"):
        # C5 / B08: approving for a KNOWN person is the activation — the role
        # is granted here, not by a referral code redeemed later. Left at
        # `isActivated: false`, the CRM listed the same human twice: once as
        # an active Host and once as an application awaiting activation.
        after.update({"isActivated": True, "activatedByUid": uid, "activatedAt": now})
    # HT-2: a stamp whose answer was lost is recognised (it used to come back
    # False — "changed while it was being decided" — for a decision that WAS
    # recorded, skipping the lock release, the audit and the notice), and a
    # stamp that could not be confirmed is tried once more under the lease.
    try:
        stamped = await _fs(
            firebase.complete_decision_retry_once, app_ref, lease, after,
            expected_status=current, default_status="pending",
        )
    except firebase.DecisionNotRecorded as exc:
        raise DecisionNotRecordedError(
            "This application's decision was carried out" + (
                " (the account was updated)" if account is not None else ""
            ) + ", but the application could not be recorded as decided: the database "
            + ("was busy." if exc.outcome == "not_applied" else "did not confirm it.")
            + " Decide it again to record it — nothing is granted or revoked twice.",
            outcome=exc.outcome,
        ) from exc
    if not stamped:
        raise UserError(
            "This application changed while it was being decided. Reload it and "
            "check what it says now."
        )
    if applicant_uid:
        # B32: the one-pending-application lock goes with the decision.
        from app.services import partner_applications as apps  # local: apps imports this module

        await apps.release_host_application_lock(applicant_uid, application_id)

    audit_id = await audit.record(
        actor=actor,
        action=(
            audit.Action.HOST_APPLICATION_APPROVED
            if approve
            else audit.Action.HOST_APPLICATION_REJECTED
        ),
        subject_type="host_application",
        subject_id=application_id,
        reason=reason,
        before=before,
        after={"status": after["status"], "kycStatus": after["kycStatus"]},
        meta={
            "host_name": host_name,
            "agency_id": agency_id,
            # Empty until the applicant redeems their code. Recorded as empty
            # rather than omitted, because "refused before anyone claimed it" is
            # a different fact from "we did not record who it was".
            "uid": uid,
            "host_status_changed": account is not None,
            "host_grant_audit_id": (account or {}).get("audit_id", ""),
        },
    )

    # ── 3. Tell the applicant. LAST; never a reason for the decision to fail.
    #
    # The person is told on the account that will see it: the applicant's own
    # uid for a self-application, or the account that redeemed the code for an
    # invitation. An invitation nobody has redeemed yet has nobody to tell —
    # they learn the outcome when they enter the code, as before.
    from app.services import notices

    notify_uid = applicant_uid or uid
    notified = False
    if notify_uid:
        if approve:
            notified = await notices.host_application_approved(notify_uid, application_id)
        else:
            notified = await notices.host_application_rejected(notify_uid, application_id, reason)

    return {
        "application_id": application_id,
        "uid": uid,
        "before": before,
        "after": {"status": after["status"], "kycStatus": after["kycStatus"]},
        "audit_id": audit_id,
        "account": account,
        "note": account_note,
        "notified": notified,
    }


# ── A proposed change to a host's payout or identity details ──────────────────
#
# **Why this lives here and not in `partner_ops`.**
#
# `hostApplications` has exactly one owner in this codebase, and it is this
# module: `HOST_APPLICATIONS`, `_host_application_ref` and the only writer of an
# application's decision are all above. `partner_ops` works off the Mongo
# `partners` collection — every function there begins by resolving a partner
# record — and a host has none. There is no `partners` row for a host, no
# `kind`, no balance and no commission ledger; a host is an app account plus an
# invitation, and the invitation is a Firestore document this module already
# owns end to end.
#
# Putting the host case in `partner_ops` would give `hostApplications` a second
# writer in a second module, which is the precise failure the header comment on
# `decide_host_application` describes: three screens wrote that document, only
# one of them wrote both status fields, and they drifted until no screen agreed
# with any other about whether an application had been decided. So agencies and
# sellers are decided in `partner_ops.apply_pending_changes`, hosts are decided
# here, and neither collection has two owners.
#
# **The four-eyes rule is sharper here than anywhere else.** A host has no
# dashboard of their own — they cannot propose anything — so every proposal on
# this collection was written by staff or by the recruiting agency on the host's
# behalf. `firestore.rules` says so explicitly: an admin may propose a change to
# a host's payout or identity fields, and only a superadmin may write one
# straight onto the record. The check below enforces the other half of it, that
# the proposer and the applier are two different people. A single ops_admin must
# not be able to redirect a host's earnings on their own authority, and an
# agency proposing a change to a host it recruited must certainly not.


def _host_pending_changes_of(app: dict) -> dict:
    """The proposal on a host application, or `{}`."""
    block = app.get("pendingChanges")
    if not isinstance(block, dict):
        return {}
    fields = block.get("fields")
    if not isinstance(fields, dict) or not fields:
        return {}
    return block


def _host_proposer_of(block: dict) -> dict:
    by = block.get("submittedBy")
    by = by if isinstance(by, dict) else {}
    return {
        "uid": str(by.get("uid") or ""),
        "name": str(by.get("name") or ""),
        "role": str(by.get("role") or ""),
    }


async def decide_host_pending_changes(
    application_id: str, approve: bool, reason: str, actor: dict
) -> dict:
    """Apply or refuse a proposed change to a host's payout or identity details.

    Approving writes the proposed values onto the application and clears the
    proposal. Refusing clears the proposal and touches no live field at all —
    the host goes on being paid into the account somebody already verified,
    which is the entire point of proposing rather than writing.

    Nothing outside the payout and identity sets is ever written. Firestore
    constrains only which top-level keys a proposal may occupy, not what may be
    inside it, so a proposal naming `isActivated` or `activatedByUid` would
    otherwise be applied by a reviewer who thought they were approving a bank
    account. The allow-list is shared with `partner_ops` so the two cannot drift
    apart, and it is imported inside the function rather than at module scope:
    that module is the heavier of the two and importing it here at import time
    would couple this one to the whole partner money stack for one frozenset.

    **`status` is not touched.** Whether the application itself is approved is a
    different decision with its own call and its own audit action. A bank
    account changing on an already-approved host must not read, afterwards, as
    though somebody re-approved the application.
    """
    from app.services.partner_ops import APPLICABLE_FIELDS

    reason = _require_reason(reason)

    snap = await _fs(_host_application_ref(application_id).get)
    if not snap.exists:
        raise UserNotFound("No host application with that id.")
    app = snap.to_dict() or {}

    block = _host_pending_changes_of(app)
    if not block:
        raise UserError(
            "There is no proposed change waiting on this host application. It "
            "may have been decided by somebody else already — reload the queue."
        )

    proposer = _host_proposer_of(block)
    if proposer["uid"] and proposer["uid"] == str(actor.get("uid") or ""):
        raise UserError(
            "You proposed this change, so you cannot be the one who decides it. "
            "A host's bank account needs a second pair of eyes; ask a colleague "
            "to review it."
        )

    fields = block.get("fields")
    fields = fields if isinstance(fields, dict) else {}
    allowed = {str(k): v for k, v in fields.items() if str(k) in APPLICABLE_FIELDS}
    refused = sorted(str(k) for k in fields if str(k) not in APPLICABLE_FIELDS)

    if approve and not allowed:
        raise UserError(
            "This proposal contains nothing that may be applied to a host "
            f"application: {', '.join(refused) or 'it is empty'}. Reject it — a "
            "proposal naming fields nobody is allowed to change this way is "
            "worth looking into rather than quietly discarding."
        )

    now = datetime.now(timezone.utc)
    # Where `kycStatus` stood before the proposal moved it to 'submitted'. Not
    # guessed: restoring a refused proposal to 'rejected' would tell a host
    # whose documents were verified a year ago that their KYC has been refused.
    previous = str(block.get("previousKycStatus") or "") or "pending"
    before = {key: app.get(key) for key in allowed} if approve else {
        "pendingChanges": sorted(str(k) for k in fields)
    }

    if approve:
        merged = {**app, **allowed}
        documents = any(
            isinstance(merged.get(f), (list, tuple))
            and any(
                (v.get("url") if isinstance(v, dict) else v) for v in merged.get(f) or []
            )
            for f in ("kycDocUrls", "docUrls", "idDocUrls")
        )
        patch: dict = {
            **allowed,
            "pendingChanges": fb_firestore.DELETE_FIELD,
            "kycStatus": "approved" if documents else previous,
            "reapprovedAt": now,
            "reapprovedBy": actor.get("uid", ""),
            "reapprovedByName": actor.get("name", ""),
            "reapprovalReason": reason,
            "pendingChangesRejectedAt": fb_firestore.DELETE_FIELD,
            "pendingChangesRejectedBy": fb_firestore.DELETE_FIELD,
            "pendingChangesRejectionReason": fb_firestore.DELETE_FIELD,
        }
    else:
        patch = {
            "pendingChanges": fb_firestore.DELETE_FIELD,
            "kycStatus": previous,
            "pendingChangesRejectedAt": now,
            "pendingChangesRejectedBy": actor.get("name", "") or actor.get("uid", ""),
            "pendingChangesRejectionReason": reason,
        }

    await _fs(_host_application_ref(application_id).update, patch)

    audit_id = await audit.record(
        actor=actor,
        action=(
            audit.Action.HOST_PENDING_CHANGES_APPLIED
            if approve
            else audit.Action.HOST_PENDING_CHANGES_REJECTED
        ),
        subject_type="host_application",
        subject_id=application_id,
        reason=reason,
        before=before,
        after=allowed if approve else {"pendingChanges": None, "kycStatus": previous},
        meta={
            "host_name": str(app.get("hostName") or app.get("name") or ""),
            "agency_id": str(app.get("agencyId") or ""),
            "uid": str(app.get("activatedByUid") or ""),
            "fields": sorted(allowed) if approve else sorted(str(k) for k in fields),
            # The other half of four eyes. The log has to be able to show that
            # the person who asked and the person who agreed were two people.
            "proposed_by": proposer,
            "proposed_at": str(block.get("submittedAt") or ""),
            "proposal_note": str(block.get("note") or ""),
            "refused_fields": refused,
        },
    )

    return {
        "application_id": application_id,
        "approved": approve,
        "applied": sorted(allowed) if approve else [],
        "refused": refused,
        "audit_id": audit_id,
        "note": (
            (
                ""
                if not refused
                else "Applied the payout and identity fields. These were in the "
                f"proposal and were NOT written, because nothing may change them "
                f"this way: {', '.join(refused)}."
            )
            if approve
            else "Nothing on the application changed — the host keeps being paid "
            "into the account already on file. The reason is stored on the "
            "record."
        ),
    }


async def set_seller_flag(
    uid: str, is_seller: bool, reason: str, actor: dict, meta: dict | None = None,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Grant or remove seller status."""
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="change the seller flag on")

    reason = _require_reason(reason)
    user = await _load_user(uid)

    current = bool(user.get("isSeller", False))
    if current == bool(is_seller):
        raise UserError(
            f"This account is already {'a seller' if current else 'not a seller'}."
        )

    if not is_seller:
        # UGP review: clearing the flag is CLEANUP — a badge left behind by a
        # record that is gone. While the person holds an approved Coin Seller
        # record the flag follows that record, and clearing it was a side door
        # round the one-role rule (the older CRM's "Remove seller"). Taking the
        # role away is Suspend or Revoke on the record.
        from app.services import user_roles  # local: keeps the import graph acyclic

        inventory = await user_roles.role_inventory(uid, user=user, db=get_db())
        if any(r.get("role") == "seller" and r.get("status") == "approved" for r in inventory["roles"]):
            raise UserError(
                "This person holds an approved Coin Seller record, and the shop flag "
                "follows it. To take the role away, suspend or revoke the seller record "
                "(or suspend the account if it is their only role). Nothing was changed."
            )

    now = datetime.now(timezone.utc)
    patch: dict = {"isSeller": bool(is_seller)}
    patch.update(_stamp(actor, "sellerFlagSet"))
    patch["sellerSince" if is_seller else "sellerRemovedAt"] = now

    await _patch_user(uid, patch)

    before = {"isSeller": current}
    after = {"isSeller": bool(is_seller)}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.SELLER_GRANTED if is_seller else audit.Action.SELLER_REVOKED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta=meta or {},
    )
    return _result(uid, before, after, audit_id)


# ── Reading a user's record ───────────────────────────────────────────────────


async def list_warnings(uid: str, limit: int = 100) -> list[dict]:
    """Warnings issued against an account, newest first."""
    query = (
        _user_ref(uid)
        .collection(WARNINGS)
        .order_by("issuedAt", direction=BaseQuery.DESCENDING)
        .limit(min(limit, MAX_READ))
    )
    docs = await _fs(lambda: list(query.stream()))
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


async def user_history(uid: str, limit: int = 200) -> list[dict]:
    """Everything that ever happened to this account, and who did it.

    This is the point of routing moderation through the API: the answer comes
    from the append-only Mongo audit log, not from Firestore, so it cannot be
    edited by whoever performed the action.
    """
    return await audit.history_for("user", uid, limit)


# ── Balance changes — money, so they become cards ─────────────────────────────


async def request_balance_change(
    uid: str,
    currency: Currency,
    amount: int,
    reason: str,
    actor: dict,
    *,
    enforce_target_policy: bool = True,
) -> dict:
    """Ask for a user's balance to be changed. Moves nothing.

    Adjusting a balance is a movement of value, so it goes on the money board
    like every other movement (Part 5). Direct writes to `diamonds` and `beans`
    are how balances and the ledger drifted apart; there is no direct path here
    by design. The money moves in `execute_balance_card`, after an owner signs.
    """
    if enforce_target_policy:
        await ensure_ordinary_target(uid, actor, action="adjust the balance of")

    reason = _require_reason(reason)

    if amount == 0:
        raise UserError("A balance change of zero has no meaning.")

    try:
        currency = Currency(currency)
    except ValueError as exc:
        raise UserError(f"Unknown currency '{currency}'.") from exc

    if currency not in USER_CURRENCIES:
        raise UserError(
            f"A user cannot hold {currency}. "
            f"Choose one of: {', '.join(sorted(str(c) for c in USER_CURRENCIES))}."
        )

    # Fail on a mistyped uid now, rather than after an owner has signed it.
    user = await _load_user(uid)
    name = user.get("name", "") or uid

    credit = amount > 0
    card_type = CardType.BALANCE_CREDIT if credit else CardType.BALANCE_DEBIT
    verb = "Credit" if credit else "Debit"

    try:
        card = await cards.raise_card(
            NewCard(
                type=card_type,
                team=Team.FINANCE,
                title=f"{verb} {abs(amount)} {currency} — {name}",
                amount=amount,
                currency=str(currency),
                reason=reason,
                subject_type="user",
                subject_id=uid,
                payload={
                    "uid": uid,
                    "name": name,
                    "currency": str(currency),
                    "amount": amount,
                    "balance_before_request": int(user.get(str(currency), 0) or 0),
                },
            ),
            actor,
        )
    except CardError as exc:
        raise UserError(str(exc)) from exc

    # `raise_card` audits against the card. This second entry is against the
    # user, so a balance request shows up in `user_history` alongside the bans
    # and warnings instead of only on the board.
    await audit.record(
        actor=actor,
        action=audit.Action.BALANCE_CHANGE_REQUESTED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        after={"requested": {str(currency): amount}},
        card_id=card["id"],
        meta={"card_type": str(card_type), "stage": card["stage"]},
    )
    return card


async def execute_balance_card(card_id: str, actor: dict) -> dict:
    """Move the money for a signed balance card.

    Approved and Executed are separate stages (5.2.6): the signature authorises
    the movement, this performs it. The card id is the idempotency key, so a
    retry after a timeout can never double-apply.
    """
    card = await _load_card(card_id)

    card_type = card.get("type")
    if card_type not in (str(CardType.BALANCE_CREDIT), str(CardType.BALANCE_DEBIT)):
        raise UserError(f"Card {card_id} is a {card_type} card, not a balance change.")

    if card.get("stage") != str(Stage.APPROVED):
        raise UserError(
            f"Card is {card.get('stage')}, not approved. "
            "It must be verified and signed by an owner first."
        )

    payload = card.get("payload") or {}
    subject = card.get("subject") or {}
    uid = payload.get("uid") or subject.get("id", "")
    if not uid:
        raise UserError("This card does not name a user.")
    # UGP review: the money moves on the account the signer was SHOWN. The
    # signature checks ("this card pays you") read `subject`; a payload naming a
    # different account would move a balance nobody approved. Refused before
    # anything moves; the card stays as it is for a person to look at.
    if subject.get("id") and str(subject.get("id")) != str(uid):
        raise UserError(
            "This card's subject and the account it would move do not match. Nothing was moved."
        )

    amount = int(card.get("amount", 0))
    if amount == 0:
        raise UserError("This card carries no amount.")

    # A card can be raised through the generic board endpoint, so its currency
    # is not guaranteed to be one a user can hold.
    try:
        currency = Currency(card.get("currency"))
    except ValueError as exc:
        raise UserError(f"Unknown currency '{card.get('currency')}'.") from exc
    if currency not in USER_CURRENCIES:
        raise UserError(f"A user cannot hold {currency}.")

    action = (
        audit.Action.BALANCE_CREDIT if amount > 0 else audit.Action.BALANCE_DEBIT
    )

    # UGP-D: a DEBIT is taken from the LIVE balance — the number the app shows
    # and spends — inside a Firestore transaction that re-reads it, takes the
    # whole amount or refuses, and writes the app-visible history row; only then
    # is the Mongo ledger written, with `replica_applied_by_caller`. The credit
    # path below is unchanged.
    #
    # It used to guard the Mongo tally (which never sees gifts, calls or
    # purchases) and then push an unguarded `Increment(-n)` to Firestore, so a
    # signed debit could drive a live balance negative, and a beans debit left
    # `beansAvailable` — what a payout reads — untouched.
    if amount < 0:
        return await _execute_debit_on_live_balance(card, card_id, uid, currency, -amount, action, actor)

    try:
        movement = await apply_movement(
            Movement(
                holder_type=HolderType.USER,
                holder_id=uid,
                currency=currency,
                amount=amount,
                action=action,
                reason=card.get("reason", "Balance adjustment"),
                actor=actor,
                card_id=card_id,
                idempotency_key=card_id,
                meta={"card_type": card.get("type")},
                # M-18: the app-visible history row (`diamondTransactions` /
                # `beanTransactions` `card_{id}`), written beside the balance
                # delta, so an admin credit explains itself on the person's
                # history screen as the debit path's row already does.
                history={
                    "id": f"card_{card_id}",
                    "reason": card.get("reason", "Balance adjustment"),
                    "reasonLabel": "Credit by Zipper",
                    "cardId": card_id,
                    "context": "admin_credit",
                },
            )
        )
    except InsufficientBalance as exc:
        # The card is left visibly failed rather than silently lost (5.2.6).
        await _close_card(
            card_id,
            actor,
            {
                "error": "insufficient_balance",
                "message": str(exc),
                "available": exc.available,
                "requested": exc.requested,
                "uid": uid,
                "currency": str(currency),
            },
            succeeded=False,
        )
        raise UserError(f"{exc}. The card has been marked failed.") from exc
    except DuplicateMovement as exc:
        # The ledger already holds this card's movement, so the money moved and
        # only the card was left behind. Finish the card rather than refusing.
        log.warning("Balance card %s was already applied to the ledger", card_id)
        await _close_card(
            card_id,
            actor,
            {"note": "Already applied — ledger entry exists for this card.",
             "uid": uid, "currency": str(currency), "amount": amount},
            succeeded=True,
        )
        raise UserError(
            "This card was already executed. The card has been closed."
        ) from exc

    return await _close_card(
        card_id,
        actor,
        {
            "uid": uid,
            "currency": str(currency),
            "amount": amount,
            "ledger_id": movement.ledger_id,
            "balance_before": movement.balance_before,
            "balance_after": movement.balance_after,
            "replica_synced": movement.replica_synced,
        },
        succeeded=True,
    )


async def _exec_balance_card(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    """§8: the balance-card executor as the owner fast path calls it."""
    return await execute_balance_card(card_id, actor)


cards.register_executor(CardType.BALANCE_CREDIT, _exec_balance_card)
cards.register_executor(CardType.BALANCE_DEBIT, _exec_balance_card)


async def _execute_debit_on_live_balance(
    card: dict, card_id: str, uid: str, currency: Currency, amount: int,
    action: str, actor: dict,
) -> dict:
    """Debit a signed balance card from the live Firestore balance, then ledger it.

    UGP review — ORDER AND THE POINT OF NO RETURN. The live debit comes first
    (it is the one that can refuse), the ledger second. So the card is CLAIMED
    before the live step (`cards.claim_execution`): from then on it cannot be
    rejected, and a crash between the two steps leaves an approved, claimed
    card whose execution is simply run again — the live step replays on its
    history id and the ledger on the card id, so nothing is taken twice.
    """
    reason = card.get("reason", "Balance adjustment")
    history_id = f"card_{card_id}"
    try:
        await cards.claim_execution(card_id, actor)
    except CardError as exc:
        raise UserError(str(exc)) from exc
    try:
        if currency == Currency.DIAMONDS:
            live = await asyncio.to_thread(
                firebase.clawback_user_diamonds, uid, amount,
                reason=reason, history_id=history_id, require_full=True,
            )
            live_before = int(live.get("available_before") or 0)
            # Whole or nothing — `require_full` refuses a short or missing
            # wallet; anything else taken here is a bug, not a partial debit.
            if int(live.get("taken") or 0) != amount:
                raise firebase.LiveBalanceShort(uid, int(live.get("taken") or 0), amount)
        else:
            live = await asyncio.to_thread(
                firebase.debit_host_beans, uid, amount, None,
                {"id": history_id, "reason": reason},
            )
            live_before = int(live.get("beans_available_before") or 0)
    except (firebase.TransactionNotApplied, firebase.TransactionOutcomeUnknown) as exc:
        # HT-2: the live step's history row was read again and is not there. The
        # card stays approved and claimed — "run again" is the recovery this path
        # was built for (it replays on the history id and the card id) — so say
        # that, instead of a bare 500.
        raise LiveStepNotConfirmed(
            f"{exc} The card is still approved: execute it again — it cannot take twice.",
            outcome=exc.outcome,
        ) from exc
    except (firebase.LiveBalanceShort, firebase.HostBeansUnavailable) as exc:
        available = int(getattr(exc, "available", 0) or 0)
        await _close_card(
            card_id,
            actor,
            {
                "error": "insufficient_live_balance",
                "message": (
                    f"The account holds {available:,} "
                    f"{'released beans' if currency != Currency.DIAMONDS else 'diamonds'}; "
                    f"{amount:,} cannot be taken."
                ),
                "available": available,
                "requested": amount,
                "uid": uid,
                "currency": str(currency),
            },
            succeeded=False,
        )
        await _mark_warning_deduction(card, "failed")
        raise UserError(
            f"The live balance ({available:,}) does not cover {amount:,} {currency}. "
            "Nothing was taken and the card has been marked failed."
        ) from exc

    try:
        movement = await apply_movement(
            Movement(
                holder_type=HolderType.USER,
                holder_id=uid,
                currency=currency,
                amount=-amount,
                action=action,
                reason=reason,
                actor=actor,
                card_id=card_id,
                idempotency_key=card_id,
                # The live balance already moved and already refused to go
                # below zero; the Mongo tally is only the CRM's own history and
                # may legitimately not cover it (see `firebase.py`).
                allow_negative=True,
                replica_applied_by_caller=True,
                meta={"card_type": card.get("type"), "live_history_id": history_id,
                      "source": (card.get("payload") or {}).get("source", "")},
            )
        )
    except DuplicateMovement:
        log.warning("Balance card %s was already applied to the ledger", card_id)
        await _mark_warning_deduction(card, "executed")
        await _close_card(
            card_id,
            actor,
            {"note": "Already applied — ledger entry exists for this card.",
             "uid": uid, "currency": str(currency), "amount": -amount},
            succeeded=True,
        )
        raise UserError("This card was already executed. The card has been closed.")

    await _mark_warning_deduction(card, "executed")
    return await _close_card(
        card_id,
        actor,
        {
            "uid": uid,
            "currency": str(currency),
            "amount": -amount,
            "ledger_id": movement.ledger_id,
            "live_balance_before": live_before,
            "live_balance_after": live_before - amount,
            "live_replayed": bool(live.get("replayed")),
            "history_id": history_id,
            "replica_synced": True,
        },
        succeeded=True,
    )


async def _mark_warning_deduction(card: dict, status: str) -> None:
    """Best effort: show on the warning whether its deduction was taken."""
    payload = card.get("payload") or {}
    if payload.get("source") != "warning" or not payload.get("warning_id"):
        return
    try:
        await _fs(
            _user_ref(str(payload.get("uid") or ""))
            .collection(WARNINGS)
            .document(str(payload["warning_id"]))
            .update,
            {"deduction.status": status, "deduction.cardId": str(card.get("_id") or card.get("id") or "")},
        )
    except Exception:  # noqa: BLE001 — the card and the ledger are the record
        log.warning("warning %s: deduction status not written", payload.get("warning_id"))


async def _close_card(
    card_id: str, actor: dict, result: dict, succeeded: bool
) -> dict:
    """Record the outcome on the card, translating board errors for the caller."""
    try:
        return await cards.mark_executed(card_id, actor, result, succeeded)
    except CardError as exc:
        raise UserError(str(exc)) from exc


async def _load_card(card_id: str) -> dict:
    try:
        oid = ObjectId(card_id)
    except Exception as exc:  # noqa: BLE001
        raise UserNotFound("Card not found.") from exc

    doc = await get_db()[C.CARDS].find_one({"_id": oid})
    if doc is None:
        raise UserNotFound("Card not found.")
    doc["id"] = str(doc.pop("_id"))
    return doc


# ══════════════════════════════════════════════════════════════════════════════
#  Device bans
# ══════════════════════════════════════════════════════════════════════════════
#
# ── WHY A DEVICE BAN HAS TO REMEMBER WHY IT EXISTS ───────────────────────────
#
# `bannedDevices/{deviceId}` locks out a HANDSET, for every account that will
# ever hold it. That is the point — it is what stops somebody signing out,
# making a second account and carrying on — and it means the record is not
# owned by whichever account happened to cause it.
#
# Without a record of the cause, lifting a ban had two options and both were
# wrong. Leave every handset barred for ever, or delete the document and release
# a phone that Ops barred separately for reasons of their own. The old
# `unban_user` took the second option, unconditionally, on a device id read off
# a field the client could write.
#
# So each record carries two things beyond the ban itself:
#
#   sourceAccounts   the uids whose ban caused this record. `ban_user` adds its
#                    uid to every handset it bars, `unban_user` removes it
#                    again, and the record survives while anybody is left on
#                    the list. Written identically by `barDevice` in
#                    `functions/src/identity.ts`, which bars the handset in
#                    front of a banned account at sign-in.
#   manualBan        Ops placed this on their own authority. It is nobody's
#                    account's to lift and no unban will ever delete it.
#
# `userUids` is the older field the CRM's ban list renders, kept in step with
# `sourceAccounts` so that screen does not have to change.


def _device_ref(device_id: str):
    if not device_id or not device_id.strip():
        raise UserError("A device id is required.")
    return (
        firebase.firestore_client()
        .collection(BANNED_DEVICES)
        .document(device_id.strip())
    )


def _string_list(value: Any) -> list[str]:
    """A Firestore array field as a list of non-empty strings.

    Defensive because these arrays are read to decide whether a handset stays
    barred. A field that is missing, null, or somehow not a list has to answer
    "nobody is holding this up" rather than raising in the middle of an unban
    that has already written the account half.
    """
    if not isinstance(value, (list, tuple)):
        return []
    return [str(v).strip() for v in value if str(v or "").strip()]


async def _devices_of(uid: str, user: dict) -> list[str]:
    """Every device id this account has been seen on, newest first is not needed.

    Two sources, unioned, because they cover different eras of the same fact:

      `users/{uid}/devices`   written by `rememberDevice` on every
                              `startMobileSession`. Server-side, one document
                              per handset, and the one that is actually right.
      `users/{uid}.deviceId`  the single value that came before it, written once
                              at profile setup. Read as a FALLBACK only, for an
                              account that has not signed in since the
                              subcollection started being written — an old
                              account with one stale id is still better than no
                              device ban at all.

    A failure to read the subcollection returns what it can rather than raising:
    this is called from inside `ban_user`, and a ban that refused itself because
    a device listing timed out would be the worse outcome by a distance.
    """
    found: list[str] = []
    try:
        docs = await _fs(
            lambda: list(
                _user_ref(uid).collection(DEVICES).limit(MAX_READ).stream()
            )
        )
        for d in docs:
            device_id = str(d.id or "").strip()
            if device_id and device_id not in found:
                found.append(device_id)
    except Exception as exc:  # noqa: BLE001 — never refuse a ban over a listing
        log.error("Could not list devices for %s: %s", uid, exc)

    legacy = str(user.get("deviceId") or "").strip()
    if legacy and legacy not in found:
        found.append(legacy)
    return found


async def _device_bans_caused_by(uid: str, user: dict) -> list[str]:
    """Every `bannedDevices` document this account is named on.

    Three queries rather than one, and each answers a case the others miss:

      sourceAccounts  the records `ban_user` and `barDevice` wrote. The
                      authoritative list, and the only one that can say a
                      record has more than one cause.
      userUids        the same question asked of records written before
                      `sourceAccounts` existed. Those have exactly one uid on
                      them and no source list, so an unban that only consulted
                      `sourceAccounts` would leave every pre-existing cascade
                      ban in place for ever with nothing able to lift it.
      deviceId        the legacy single field, for the record `ban_user` barred
                      from it on an account with no `devices` subcollection.

    Queried rather than derived from `users/{uid}/devices`, because a handset
    can be barred by the sign-in propagation rule on a device this account has
    never completed a session on — `resolveIdentity` bars before
    `startMobileSession` runs. Deriving would silently miss exactly those.
    """
    fs = firebase.firestore_client()
    col = fs.collection(BANNED_DEVICES)
    found: list[str] = []

    for field in ("sourceAccounts", "userUids"):
        try:
            docs = await _fs(
                lambda f=field: list(
                    col.where(filter=FieldFilter(f, "array_contains", uid))
                    .limit(MAX_READ)
                    .stream()
                )
            )
        except Exception as exc:  # noqa: BLE001 — never refuse an unban over a query
            log.error("Could not query %s device bans for %s: %s", field, uid, exc)
            continue
        for d in docs:
            if d.id not in found:
                found.append(d.id)

    legacy = str(user.get("deviceId") or "").strip()
    if legacy and legacy not in found:
        found.append(legacy)
    return found


async def _release_device_bans(
    uid: str, reason: str, actor: dict
) -> tuple[list[str], list[dict], list[dict]]:
    """Take this account off every device ban it caused. Returns (released, kept, failed).

    **This is the fix for the defect that mattered most.** The record is deleted
    only when nothing is holding it up:

      · `sourceAccounts` is empty once this uid comes off it — no other banned
        account is keeping that handset barred; and
      · `manualBan` is not true — Ops did not place it themselves.

    Otherwise the uid is removed and the document stays, so the handset stays
    barred and the reason it is barred is still recorded. `kept` says which and
    why, so the caller can put it in front of a person instead of reporting a
    clean unban over a phone that is still walled off.

    Deletion is the right lift, not `isActive: false`: both Android read paths
    check only that the document EXISTS, so a soft unban leaves the handset
    locked out for ever with no way back.

    `ArrayRemove` rather than a computed list, so a `barDevice` running
    concurrently in a Cloud Function — arrayUnion, from a sign-in happening
    right now — cannot be clobbered by a list this function read a moment ago.
    The audit entry records the value it will read back as, because a transform
    sentinel is not something the log can store.
    """
    released: list[str] = []
    kept: list[dict] = []
    failed: list[dict] = []

    try:
        user = await _load_user(uid)
    except UserNotFound:
        user = {}

    for device_id in await _device_bans_caused_by(uid, user):
        try:
            ref = _device_ref(device_id)
            snap = await _fs(ref.get)
            if not snap.exists:
                # Already gone — lifted by hand, or by another account's unban.
                # Not a failure and not a release: there was nothing to do.
                continue

            before = snap.to_dict() or {}
            sources = [s for s in _string_list(before.get("sourceAccounts")) if s != uid]
            uids = [s for s in _string_list(before.get("userUids")) if s != uid]
            manual = before.get("manualBan") is True

            if sources or manual:
                await _fs(
                    ref.set,
                    {
                        "sourceAccounts": fb_firestore.ArrayRemove([uid]),
                        "userUids": fb_firestore.ArrayRemove([uid]),
                    },
                    merge=True,
                )
                kept.append(
                    {
                        "device_id": device_id,
                        "because": (
                            "Ops barred this handset on their own authority"
                            if manual
                            else f"{len(sources)} other banned account(s) are still "
                            "on this handset"
                        ),
                        "manual_ban": manual,
                        "remaining_sources": len(sources),
                    }
                )
                await audit.record(
                    actor=actor,
                    action=audit.Action.DEVICE_UNBANNED,
                    subject_type="device",
                    subject_id=device_id,
                    reason=(
                        f"{reason} — this account was removed from the ban, which "
                        "STAYS IN FORCE."
                    ),
                    before=before,
                    after={
                        **before,
                        "sourceAccounts": sources,
                        "userUids": uids,
                    },
                    meta={
                        "released": False,
                        "kept_because_manual": manual,
                        "remaining_sources": sources,
                        "source_removed": uid,
                    },
                )
                continue

            await _fs(ref.delete)
            released.append(device_id)
            await audit.record(
                actor=actor,
                action=audit.Action.DEVICE_UNBANNED,
                subject_type="device",
                subject_id=device_id,
                reason=reason,
                before=before,
                after=None,
                meta={
                    "released": True,
                    "original_ban_reason": before.get("reason", ""),
                    "originally_banned_by": before.get("bannedBy", ""),
                    "source_removed": uid,
                    "user_uids": _string_list(before.get("userUids")),
                },
            )
        except Exception as exc:  # noqa: BLE001 — never lose the account unban
            log.error("Could not release device ban %s for %s: %s", device_id, uid, exc)
            failed.append({"device_id": device_id, "error": str(exc)})

    return released, kept, failed


async def ban_device(
    device_id: str,
    device_type: str,
    reason: str,
    user_uids: list[str],
    actor: dict,
    manual: bool = False,
    source_uid: str = "",
) -> dict:
    """Ban a device.

    **The document id is the device id.** The Android app enforces the ban by
    reading `bannedDevices/{deviceId}` directly, so a document with a generated
    id is never found and the ban does nothing at all. Keying by device id also
    makes re-banning idempotent instead of piling up duplicate rows.

    ── `manual`, AND WHY IT DECIDES WHETHER A BAN CAN BE AUTO-LIFTED ────────

    Two things call this. `ban_user` cascades, naming the account that caused
    the bar in `source_uid`, and that bar is undone when the account is
    unbanned. Ops call it directly from `POST /users/devices/bans`, for a
    handset they have decided about on its own evidence — a device farm, a
    stolen phone, a reseller's test rig — and that has nothing to do with any
    account.

    `manualBan: true` is what keeps the second kind alive. Without it an
    Ops-placed ban was deleted the moment any account on that handset was
    unbanned, by code that believed it was tidying up after itself.

    ── WHY THIS MERGES ──────────────────────────────────────────────────────

    It used to `set()` the whole document, so a second banned account on the
    same handset overwrote the first one's entry and `manualBan` with it. It
    merges now, and `sourceAccounts` / `userUids` accumulate with `ArrayUnion`
    — the same transform `barDevice` uses in the Cloud Function, so the two
    writers of this collection cannot undo each other.
    """
    reason = _require_reason(reason)
    device_id = device_id.strip()

    try:
        device_type = str(DeviceType(device_type))
    except ValueError as exc:
        raise UserError(
            f"Unknown device type '{device_type}'. "
            f"Expected one of: {', '.join(str(d) for d in DeviceType)}."
        ) from exc

    # An Ops ban (`manual`) must not bar a ZIPPER staff member's handset: a
    # device ban locks every account on it out of the app through
    # `resolveIdentity`, which is a side door around the staff protection that
    # covers ban/suspend/warn. Checked against the accounts named AND every
    # account whose profile records this device. A cascade from `ban_user`
    # already passed `ensure_ordinary_target` for its account.
    if manual:
        named = _string_list(user_uids)

        def _on_device() -> list[str]:
            q = (firebase.firestore_client().collection("users")
                 .where(filter=FieldFilter("deviceId", "==", device_id)).limit(50))
            return [d.id for d in q.stream()]

        on_device = await _fs(_on_device)
        for uid in dict.fromkeys(named + on_device):
            row = await protected_staff_row(uid)
            if row is not None:
                raise ProtectedTarget(
                    f"This device is used by {row.get('email') or uid}, an internal "
                    f"{row.get('role', 'staff')} account. Staff devices cannot be barred "
                    "through user management."
                )

    ref = _device_ref(device_id)
    snap = await _fs(ref.get)
    before = snap.to_dict() if snap.exists else None

    # Every uid this ban is being attributed to. `source_uid` is the account
    # whose ban cascaded here; `user_uids` is whatever the caller named, which
    # for an Ops ban is "these are the accounts we saw on it" and is evidence
    # rather than a cause.
    sources = _string_list(user_uids)
    if source_uid and source_uid not in sources:
        sources.append(source_uid)

    existing_sources = _string_list((before or {}).get("sourceAccounts"))
    existing_uids = _string_list((before or {}).get("userUids"))

    patch: dict = {
        "deviceId": device_id,
        "deviceType": device_type,
        "reason": reason,
        "isActive": True,
        **_stamp(actor, "banned"),
    }
    # `manualBan` is only ever turned ON here. A cascade arriving on a handset
    # Ops already barred must not quietly downgrade it into one an unban may
    # delete — the Ops decision outlives every account on the device.
    if manual:
        patch["manualBan"] = True
    if sources:
        patch["sourceAccounts"] = fb_firestore.ArrayUnion(sources)
        patch["userUids"] = fb_firestore.ArrayUnion(sources)
    elif before is None:
        # A manual ban naming nobody still needs the fields to exist, or the
        # `array_contains` queries in `_device_bans_caused_by` skip it and an
        # `unban_user` cannot even see that it declined to touch it.
        patch["sourceAccounts"] = []
        patch["userUids"] = []

    await _fs(ref.set, patch, merge=True)

    # What the document will read back as. Recorded rather than the patch,
    # because the patch contains transform sentinels and an audit entry has to
    # be a value somebody can read six months from now.
    after = {
        **(before or {}),
        **{k: v for k, v in patch.items() if k not in ("sourceAccounts", "userUids")},
        "sourceAccounts": existing_sources + [s for s in sources if s not in existing_sources],
        "userUids": existing_uids + [s for s in sources if s not in existing_uids],
        "manualBan": manual or (before or {}).get("manualBan") is True,
    }

    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.DEVICE_BANNED,
        subject_type="device",
        subject_id=device_id,
        reason=reason,
        before=before,
        after=after,
        meta={
            "device_type": device_type,
            "user_uids": sources,
            # Which of the two kinds this is. It is what decides, later,
            # whether an account's unban is allowed to delete this record.
            "manual_ban": bool(after["manualBan"]),
            "source": (
                "ops"
                if manual
                else (f"ban of account {source_uid}" if source_uid else "unattributed")
            ),
            "source_uid": source_uid or None,
        },
    )
    return {"device_id": device_id, "before": before, "after": after, "audit_id": audit_id}


async def unban_device(device_id: str, reason: str, actor: dict) -> dict:
    """Lift a device ban by deleting the document. A person's explicit decision.

    Both Android read paths check only that the document exists — neither reads
    `isActive`. A soft unban therefore left the device locked out forever with
    no way back, which is worse than losing the row. The audit entry below
    keeps the history that the deleted document would have held.

    **Unconditional, unlike the release inside `unban_user`.** That one is a
    side effect of an account decision and must not reach a ban it did not
    cause, so it consults `sourceAccounts` and `manualBan`. This is somebody
    standing in front of the device ban list having decided about THIS HANDSET,
    which is the one case where deleting it whatever caused it is the right
    answer. Both source lists are recorded on the entry, so what the deletion
    overrode is still readable.
    """
    reason = _require_reason(reason)
    device_id = device_id.strip()

    ref = _device_ref(device_id)
    snap = await _fs(ref.get)
    if not snap.exists:
        raise UserNotFound("No ban exists for this device.")

    before = snap.to_dict() or {}
    await _fs(ref.delete)

    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.DEVICE_UNBANNED,
        subject_type="device",
        subject_id=device_id,
        reason=reason,
        before=before,
        after=None,
        meta={
            "released": True,
            "original_ban_reason": before.get("reason", ""),
            "originally_banned_by": before.get("bannedBy", ""),
            "user_uids": _string_list(before.get("userUids")),
            # What this deletion overrode. A record with sources on it was
            # holding a handset barred for accounts that are still banned, and
            # a record with `manualBan` was somebody else's decision — both are
            # legitimate to override from here, and both are worth reading back.
            "source_accounts": _string_list(before.get("sourceAccounts")),
            "was_manual_ban": before.get("manualBan") is True,
        },
    )
    return {"device_id": device_id, "before": before, "after": None, "audit_id": audit_id}


async def list_banned_devices(limit: int = 100) -> list[dict]:
    """Currently banned devices, newest first.

    Bounded — this collection only ever grows.
    """
    col = firebase.firestore_client().collection(BANNED_DEVICES)
    query = col.order_by("bannedAt", direction=BaseQuery.DESCENDING).limit(
        min(limit, MAX_READ)
    )
    docs = await _fs(lambda: list(query.stream()))
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


# ── Reports queue ─────────────────────────────────────────────────────────────


async def list_reports(status: str | None = None, limit: int = 100) -> list[dict]:
    """The reports queue, newest first."""
    col = firebase.firestore_client().collection(REPORTS)

    query = col
    if status:
        query = query.where(filter=FieldFilter("status", "==", str(status)))
    query = query.order_by("createdAt", direction=BaseQuery.DESCENDING).limit(
        min(limit, MAX_READ)
    )

    docs = await _fs(lambda: list(query.stream()))
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


async def action_report(
    report_id: str,
    action: str,
    reason: str,
    actor: dict,
    days: int | None = None,
    beans: int | None = None,
) -> dict:
    """Decide a report — and carry the decision out.

    Choosing `ban` bans the reported user. Previously this wrote the word
    "ban" into `actionTaken` and nothing else happened, so the queue recorded
    decisions that were never enforced and the reporter was told an account had
    been dealt with when it had not.

    Both halves are audited: the user action against the user, the decision
    against the report, each carrying the other's id.

    ── THE FIVE OUTCOMES, AND WHY THEY ARE NOT INTERCHANGEABLE ───────────────

    A report is a claim by one person about another, and the reviewer is
    deciding two things at once: is it true, and what does it deserve. The
    severity is the reviewer's judgement — a first rude message and a scam are
    both "justified" — so all five are available on every report and none is
    suggested by the queue.

      dismiss   the claim does not stand. Nothing happens to the account, and
                the reason is kept: a pattern of dismissed reports against one
                host is itself evidence, and so is a reporter who files them.
      warn      recorded against the account and counted. No money, no lockout.
      deduct    beans taken back. `beans` is required and must be positive; it
                is subtracted, so the caller states a quantity, not a sign.
                This RAISES A CARD — an owner signs before anything moves.
      suspend   off the platform. `days` optional: with it the suspension lifts
                itself, without it a human lifts it.
      ban       account closed.

    `days` and `beans` belong to exactly one action each and are refused
    elsewhere, rather than ignored — a reviewer who types 7 days into a warning
    has misunderstood what they are about to do, and silently dropping it
    confirms the misunderstanding.
    """
    reason = _require_reason(reason)

    try:
        action = ReportAction(action)
    except ValueError as exc:
        raise UserError(
            f"Unknown action '{action}'. "
            f"Expected one of: {', '.join(str(a) for a in ReportAction)}."
        ) from exc

    if not report_id or not report_id.strip():
        raise UserError("A report id is required.")

    ref = firebase.firestore_client().collection(REPORTS).document(report_id.strip())
    snap = await _fs(ref.get)
    if not snap.exists:
        raise UserNotFound("Report not found.")

    report = snap.to_dict() or {}
    status_before = report.get("status", str(ReportStatus.PENDING))
    if status_before in (str(ReportStatus.ACTIONED), str(ReportStatus.DISMISSED)):
        raise UserError(f"This report is already {status_before}.")

    target_uid = (report.get("targetUid") or "").strip()
    if action is not ReportAction.DISMISS and not target_uid:
        raise UserError("This report does not name a user, so it can only be dismissed.")

    # A quantity that belongs to a different action is a misunderstanding, not
    # a stray field. Say so rather than dropping it.
    if days is not None and action is not ReportAction.SUSPEND:
        raise UserError("A number of days only applies to a suspension.")
    if beans is not None and action is not ReportAction.DEDUCT:
        raise UserError("A bean amount only applies to a deduction.")
    if action is ReportAction.DEDUCT:
        if beans is None or beans <= 0:
            raise UserError(
                "Say how many beans to take back — a positive number. It is "
                "subtracted from the account, so do not send it as a negative."
            )

    # Carry out the decision first. If the user action fails, the report stays
    # open rather than being closed against something that never happened.
    outcome: dict | None = None
    link = {"report_id": report_id, "reported_reason": report.get("reason", "")}

    if action is ReportAction.WARN:
        outcome = await warn_user(target_uid, reason, actor, meta=link)
    elif action is ReportAction.SUSPEND:
        outcome = await suspend_user(target_uid, reason, actor, meta=link, days=days)
    elif action is ReportAction.BAN:
        outcome = await ban_user(target_uid, reason, actor, meta=link)
    elif action is ReportAction.DEDUCT:
        # Nothing moves here. This raises a FINANCE card on the money board
        # carrying the report id, and the beans leave the account when an owner
        # signs it — the same path as every other movement of value. A
        # moderator deciding a report cannot also move money on their own.
        outcome = await request_balance_change(
            target_uid,
            Currency.BEANS,
            -abs(int(beans or 0)),
            f"{reason} (report {report_id})",
            actor,
        )

    now = datetime.now(timezone.utc)
    status_after = (
        str(ReportStatus.DISMISSED)
        if action is ReportAction.DISMISS
        else str(ReportStatus.ACTIONED)
    )

    # Four of the five outcomes return a moderation `_result` carrying an
    # `audit_id`. The fifth — deduct — returns a CARD, because nothing has
    # happened yet and the audit entry that matters is the one `raise_card`
    # wrote against the card. Reading `audit_id` off it would raise, so both
    # shapes are read for what they actually carry.
    outcome_audit_id = (outcome or {}).get("audit_id")
    outcome_card_id = (outcome or {}).get("id") if action is ReportAction.DEDUCT else None

    patch = {
        "status": status_after,
        "actionTaken": str(action),
        "reviewReason": reason,
        "reviewedBy": actor.get("uid", ""),
        "reviewedByName": actor.get("name", ""),
        "reviewedAt": now,
        # The link back to what actually happened, and to who did it.
        "outcomeAuditId": outcome_audit_id,
        "outcomeUid": target_uid or None,
        # A deduction is not done when the report is decided — it is a card an
        # owner still has to sign. Stored so the queue can say "raised", not
        # "taken", and so somebody can follow it to the board.
        "outcomeCardId": outcome_card_id,
        "suspensionDays": days if action is ReportAction.SUSPEND else None,
        "deductBeans": abs(int(beans)) if action is ReportAction.DEDUCT and beans else None,
    }
    await _fs(ref.update, patch)

    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.REPORT_ACTIONED,
        subject_type="report",
        subject_id=report_id,
        reason=reason,
        before={"status": status_before, "actionTaken": report.get("actionTaken")},
        after={"status": status_after, "actionTaken": str(action)},
        meta={
            "target_uid": target_uid,
            "reporter_uid": report.get("reporterUid", ""),
            "outcome_audit_id": outcome_audit_id,
            "outcome_card_id": outcome_card_id,
            # A deduction is RAISED, not enforced: the beans move when an owner
            # signs the card. Reporting it as enforced would be the same lie
            # this function was written to end.
            "enforced": outcome is not None and action is not ReportAction.DEDUCT,
        },
    )

    return {
        "report_id": report_id,
        "action": str(action),
        "status": status_after,
        "target_uid": target_uid or None,
        "enforced": outcome is not None and action is not ReportAction.DEDUCT,
        "card_id": outcome_card_id,
        "outcome": outcome,
        "audit_id": audit_id,
    }


# ── Buyer lookup for a seller filing a sale ─────────────────────────────────

def _mask_email(email: str) -> str:
    local, _, domain = (email or "").partition("@")
    if not domain:
        return ""
    return (local[:2] + "•••") + "@" + domain


def _mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    return f"•••••{digits[-4:]}" if len(digits) >= 4 else ""


async def lookup_buyers(term: str, *, limit: int = 5) -> list[dict]:
    """Find app accounts by an EXACT uid, email address or phone number.

    For a coin seller filing a sale: the CRM cannot list `users` (the rules
    keep that to staff, correctly — it is everyone's contact details), so the
    seller names the buyer and the API resolves exactly that person. No browse,
    no partial match; contact details come back masked, enough to confirm the
    right person, not enough to harvest anyone. Deleted accounts are skipped.
    """
    from app.services import crm_directory as crm

    q = (term or "").strip()
    if len(q) < 3:
        return []

    def _run() -> list[tuple[str, dict]]:
        col = firebase.firestore_client().collection("users")
        found: dict[str, dict] = {}
        snap = col.document(q).get() if "/" not in q else None
        if snap is not None and snap.exists:
            found[snap.id] = snap.to_dict() or {}
        if "@" in q:
            for value in {q, q.lower()}:
                for d in col.where(filter=FieldFilter("email", "==", value)).limit(limit).stream():
                    found[d.id] = d.to_dict() or {}
        else:
            e164 = crm.to_e164(q)
            key = crm._phone_key(e164) if e164 else ""
            if key:
                for d in col.where(filter=FieldFilter("phoneKey", "==", key)).limit(limit).stream():
                    found[d.id] = d.to_dict() or {}
            if e164:
                for d in col.where(filter=FieldFilter("phoneNumber", "==", e164)).limit(limit).stream():
                    found[d.id] = d.to_dict() or {}
        return list(found.items())[:limit]

    rows = await _fs(_run)
    out = []
    for uid, d in rows:
        if d.get("isDeleted") or d.get("accountState") in ("deleted", "purged"):
            continue
        out.append({
            "uid": uid,
            "name": str(d.get("name") or d.get("displayName") or "Unnamed"),
            "email": _mask_email(str(d.get("email") or "")),
            "phone": _mask_phone(str(d.get("phoneNumber") or d.get("phone") or "")),
        })
    return out


# ── "Is this email / phone already registered for a role?" ─────────────────

#: Statuses that no longer hold an address: a refused or withdrawn application
#: must not stop the same person applying again.
_RELEASED_PARTNER_STATUSES = frozenset({"rejected", "revoked"})

_ROLE_SOURCES = (
    # (kind, collection, email field, phone field)
    ("agency", "agencies", "ownerEmail", "ownerPhone"),
    ("seller", "sellers", "email", "phone"),
)


def _phone_variants(raw: str) -> list[str]:
    """The spellings a stored phone may have: E.164, and the bare national
    number for an Indian one (older forms stored it without a code)."""
    from app.services import crm_directory as crm

    e164 = crm.to_e164(raw)
    out = {e164} if e164 else set()
    if e164.startswith("+91"):
        out.add(e164[3:])
        out.add("+91 " + e164[3:])
    return [v for v in out if v]


async def registration_availability(email: str, phone: str, kind: str = "") -> dict:
    """Which partner role, if any, already holds this email / phone. Read-only.

    Answers the signup form field by field, so an applicant is told the moment
    they type an address that is already registered — not after filling in
    four pages and pressing Submit. Exact matches only; names and ids are never
    returned, only the role it is registered for. Refused and revoked records
    do not count.
    """
    email = (email or "").strip().lower()
    phone = (phone or "").strip()
    # UGP-G (I-5): `kind` narrows the question to ONE role. The public seller
    # signup needs "is there already a Coin Seller on this address?" — and
    # cannot ask Firestore itself, because `sellers` is not listable outside
    # staff — while an Agency on the same address is allowed (Agency + Seller).
    # Without it the first match (an agency) answered for both.
    only = (kind or "").strip()
    sources = tuple(s for s in _ROLE_SOURCES if not only or s[0] == only)

    def _run() -> dict:
        col = firebase.firestore_client().collection
        result = {"email": None, "phone": None}
        for kind, coll, email_field, phone_field in sources:
            if email and result["email"] is None:
                for d in col(coll).where(filter=FieldFilter(email_field, "==", email)).limit(5).stream():
                    if str((d.to_dict() or {}).get("status") or "") not in _RELEASED_PARTNER_STATUSES:
                        result["email"] = kind
                        break
            if phone and result["phone"] is None:
                for variant in _phone_variants(phone):
                    hit = False
                    for d in col(coll).where(filter=FieldFilter(phone_field, "==", variant)).limit(5).stream():
                        if str((d.to_dict() or {}).get("status") or "") not in _RELEASED_PARTNER_STATUSES:
                            hit = True
                            break
                    if hit:
                        result["phone"] = kind
                        break
        return result

    if not email and not phone:
        return {"email": None, "phone": None}
    return await _fs(_run)

