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
from firebase_admin import firestore as fb_firestore
from google.cloud.firestore_v1.base_query import BaseQuery, FieldFilter

from app.core import audit
from app.core.compat import StrEnum
from app.core.roles import Team
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
#: The invitation an agency files for a host it wants to recruit. Written by the
#: Invite Host modal on /agency-dashboard, decided by `decide_host_application`
#: below, and read by `checkReferralCode` / `activateHost` in the app.
HOST_APPLICATIONS = "hostApplications"

MAX_READ = 500                 # nothing here ever reads an unbounded collection


class UserError(Exception):
    """Rejected by a moderation rule. The message is safe to show the caller."""


class UserNotFound(UserError):
    """The subject does not exist."""


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


async def ban_user(
    uid: str,
    reason: str,
    actor: dict,
    meta: dict | None = None,
    ban_device_too: bool = True,
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
    reason = _require_reason(reason)
    user = await _load_user(uid)

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
        **_stamp(actor, "banned"),
    }
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
            # Which handsets this ban actually reached. Recorded on the entry
            # because it is the half a reviewer cannot see from the account
            # screen, and because `unban_user` is judged against it later.
            "affectedDeviceIds": barred,
            "known_device_ids": device_ids,
            "device_failures": device_failures,
            "devices_barred": len(barred),
            **(meta or {}),
        },
    )
    return _result(
        uid,
        before,
        after,
        audit_id,
        device_banned=bool(barred),
        devices_barred=barred,
        device_failures=device_failures,
        note=device_note,
    )


async def unban_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None
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
            **(meta or {}),
        },
    )
    return _result(
        uid, before, after, audit_id,
        device_unbanned=bool(released),
        devices_released=released,
        device_bans_kept=kept,
        device_failures=failures,
        note=device_note,
    )


async def suspend_user(
    uid: str,
    reason: str,
    actor: dict,
    meta: dict | None = None,
    days: int | None = None,
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
    """
    reason = _require_reason(reason)
    user = await _load_user(uid)

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

    await _patch_user(uid, patch)

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
            **(meta or {}),
        },
    )
    return _result(
        uid,
        before,
        after,
        audit_id,
        suspended_until=after["suspendedUntil"],
        note=(
            "The account is suspended and cannot use the app. No device was "
            "barred — another account may be used on the same phone. Lift it "
            "with Resume."
        ),
    )


async def resume_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None
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
        **_stamp(actor, "resumed"),
    }
    await _patch_user(uid, patch)

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
            **(meta or {}),
        },
    )
    return _result(
        uid,
        before,
        after,
        audit_id,
        device_unbanned=False,
        devices_released=[],
        note=(
            "The suspension is lifted and the account can use the app again. "
            "No device ban was touched — a suspension never placed one, and a "
            "device barred for another reason stays barred."
        ),
    )


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
            await resume_user(
                d.id,
                "Suspension period ended.",
                actor,
                meta={"lifted_by": "scheduled sweep"},
            )
            lifted.append(d.id)
        except Exception as exc:  # noqa: BLE001 — one failure must not stop the sweep
            failed.append({"uid": d.id, "error": str(exc)})

    return {"checked": len(docs), "lifted": lifted, "failed": failed}


async def warn_user(
    uid: str, reason: str, actor: dict, meta: dict | None = None
) -> dict:
    """Record a formal warning against an account.

    The warning is written with the real actor's uid and name. It used to be
    issued by "Admin", so a pattern of warnings could not be attributed to
    anyone and the user could not be told who to appeal to.
    """
    reason = _require_reason(reason)
    user = await _load_user(uid)

    count_before = int(user.get("warnings", 0) or 0)
    count_after = count_before + 1
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

    _, doc_ref = await _fs(_user_ref(uid).collection(WARNINGS).add, entry)
    await _patch_user(uid, {"warnings": count_after, "lastWarnedAt": now})

    before = {"warnings": count_before}
    after = {"warnings": count_after}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.USER_WARNED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={"warning_id": doc_ref.id, **(meta or {})},
    )
    return _result(uid, before, after, audit_id, warning_id=doc_ref.id)


async def grant_host(
    uid: str, agency_id: str, reason: str, actor: dict, meta: dict | None = None
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
    reason = _require_reason(reason)
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

    await _fs(batch.commit)

    if resolved_agency:
        # `merge=True` and no read first, so this repairs a missing row rather
        # than duplicating or clearing one. Mirrors `writeAgencyMembership` in
        # functions/src/hosts.ts, including the field names its readers use:
        # the weekly report reads `uid`/`name`, the dashboards read the rest.
        roster: dict = {
            "uid": uid,
            "name": str(app.get("hostName") or user.get("name") or ""),
            "agencyId": resolved_agency,
            "joinedAt": datetime.now(timezone.utc),
        }
        if app_id:
            roster["applicationId"] = app_id
        if patch.get("callRateBeans"):
            roster["callRateBeans"] = patch["callRateBeans"]
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

    after = {"isHost": True, "agencyId": patch.get("agencyId", before["agencyId"])}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.HOST_GRANTED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={"agency_id": after["agencyId"], **(meta or {})},
    )
    return _result(uid, before, after, audit_id)


async def revoke_host(
    uid: str, reason: str, actor: dict, meta: dict | None = None
) -> dict:
    """Remove host status.

    `agencyId` is left in place. The agency's commission statement is built
    from the ledger and refers to this link, so clearing it would orphan
    history that has already been paid on. Re-granting to a different agency
    overwrites it.
    """
    reason = _require_reason(reason)
    user = await _load_user(uid)

    if not user.get("isHost", False):
        raise UserError("This account is not a host.")

    before = {"isHost": True, "agencyId": user.get("agencyId", "")}

    patch: dict = {"isHost": False, "hostRemovedAt": datetime.now(timezone.utc)}
    patch.update(_stamp(actor, "hostRevoked"))
    await _patch_user(uid, patch)

    after = {"isHost": False, "agencyId": before["agencyId"]}
    audit_id = await audit.record(
        actor=actor,
        action=audit.Action.HOST_REVOKED,
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={"agency_id": before["agencyId"], **(meta or {})},
    )
    return _result(uid, before, after, audit_id)


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

    uid = str(app.get("activatedByUid") or "").strip()
    agency_id = str(app.get("agencyId") or "").strip()
    host_name = str(app.get("hostName") or app.get("name") or "").strip()

    before = {
        "status": app.get("status", ""),
        "kycStatus": app.get("kycStatus", ""),
    }

    # ── 1. The account. Audited by grant_host / revoke_host in their own right ──
    account: dict | None = None
    account_note = ""
    if approve and uid:
        # Already redeemed — grant now, so an invitation approved under the old
        # order is not left marked approved with no host behind it.
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

        if holder is None:
            account_note = (
                f"The account this application was redeemed by ({uid}) no longer "
                "exists, so there was no host status to revoke. The application "
                "is refused and the referral code will not work."
            )
        elif holder.get("isHost", False):
            account = await revoke_host(
                uid, reason, actor, meta={"application_id": application_id}
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
    await _fs(_host_application_ref(application_id).update, after)

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

    return {
        "application_id": application_id,
        "uid": uid,
        "before": before,
        "after": {"status": after["status"], "kycStatus": after["kycStatus"]},
        "audit_id": audit_id,
        "account": account,
        "note": account_note,
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
    uid: str, is_seller: bool, reason: str, actor: dict, meta: dict | None = None
) -> dict:
    """Grant or remove seller status."""
    reason = _require_reason(reason)
    user = await _load_user(uid)

    current = bool(user.get("isSeller", False))
    if current == bool(is_seller):
        raise UserError(
            f"This account is already {'a seller' if current else 'not a seller'}."
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
) -> dict:
    """Ask for a user's balance to be changed. Moves nothing.

    Adjusting a balance is a movement of value, so it goes on the money board
    like every other movement (Part 5). Direct writes to `diamonds` and `beans`
    are how balances and the ledger drifted apart; there is no direct path here
    by design. The money moves in `execute_balance_card`, after an owner signs.
    """
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
    uid = payload.get("uid") or (card.get("subject") or {}).get("id", "")
    if not uid:
        raise UserError("This card does not name a user.")

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
