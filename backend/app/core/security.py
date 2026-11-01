"""Authentication and session issuance.

Three ways in — two for people, one for a machine:

  * **Staff, owners and partners** sign in with Firebase Auth. The client sends
    the Firebase ID token; we verify it and resolve the role from Mongo.

    Two collections, in a fixed order. `staff` is read first and wins: somebody
    who is both an employee and an agency owner is an employee, and the partner
    collection is not even consulted for them. Only when there is no `staff` row
    does `resolve_partner_login` look in `partners` — so an external session is
    something a caller falls through to, never something they can choose.

  * **The observer** has no stored password. Each sign-in generates a one-time
    code, delivered to a mailbox that is deliberately not the account address.
    Holding the observer email is not sufficient to sign in.

  * **A service credential** is a standing key held by an unattended job. It
    issues no session, carries no JWT and has no role. It resolves to a named
    system actor and an explicit allowlist of operations — see
    `SERVICE_CREDENTIALS` at the foot of this module.

Codes are stored hashed, expire, are single-use, and are rate limited.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Mapping

from jose import JWTError, jwt

from app.config import settings
from app.core.roles import SYSTEM_ROLE, Role, is_external, team_of
from app.db import firebase
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)


class DirectoryUnavailable(Exception):
    """We could not check who this is — as distinct from deciding they are nobody.

    Sign-in reads `crmUsers` to find the partner record behind a Firebase login.
    When that read fails, the old code swallowed the exception, carried on with
    an empty document, found no partner, and returned the same "No account
    found" a stranger gets — which the router turned into **401**.

    So a Firestore outage told every agency and every coin seller that their
    password was wrong. They cannot tell those apart, and the honest ones retry,
    reset a password that was never broken, and eventually phone somebody.

    An infrastructure failure must never present as an authentication failure.
    401 is a statement about the person; this is a statement about us, and it
    belongs in the 500s where a monitor will see it.
    """


class AuthError(Exception):
    """Authentication failed. The message is safe to return to the caller."""


class IdentityConflictError(AuthError):
    """One person, two accounts — and the system refuses to guess which.

    Raised when a token authenticates uid A while the staff row for that
    address records a *different* uid B that is a live Firebase account. That
    is not a failed login and it is not a repair job: it is two real identities
    for one human, and picking either one silently is how somebody ends up
    holding another person's role.

    A subclass of `AuthError` so every existing `except AuthError` still
    catches it and still answers 401 — what changes is the message, which says
    what actually happened instead of "no account found".
    """


# ── Session tokens ────────────────────────────────────────────────────────────


def is_renewable(role: Role) -> bool:
    """May a session for this role be renewed without a fresh sign-in?

    Everybody but the observer. Their credential is a one-time code delivered
    to a mailbox that is deliberately not the account address; a session minted
    from it that renewed itself indefinitely would turn a single code into a
    standing password, which is the exact control the code exists to be.

    One predicate, read by three things — how long the session lasts, the
    `renew_at` the browser is told to come back at, and `renew_session` itself
    — so "the observer does not renew" cannot be true in two of them and
    quietly forgotten in the third.
    """
    return role != Role.OBSERVER


def session_ttl_for(role: Role) -> int:
    """How many minutes a session for this role lasts.

    One branch, and it is the observer's. Everybody else gets
    `settings.session_ttl_minutes` — a week — because they can renew silently
    and a renewal re-reads the account from Mongo.
    """
    if not is_renewable(role):
        return int(settings.observer_session_ttl_minutes)
    return int(settings.session_ttl_minutes)


async def issue_session(
    *,
    uid: str,
    email: str,
    name: str,
    role: Role,
    partner_ids: Mapping[str, str] | None = None,
    partner_status: str | None = None,
    renewed_from: str | None = None,
    mfa_verified: bool = False,
) -> tuple[str, datetime]:
    """Mint a session token.

    `partner_ids` and `partner_status` are written **only** for an external
    partner, and are absent from every internal token exactly as they were
    before this parameter existed — an owner's session is byte-for-byte the
    session it was.

    `partner_ids` maps a capability (`"agency"` / `"seller"`) to the one partner
    record the holder may read for it. It is the whole of an external session's
    authority: `app/core/deps.py::own_partner_id_or_403` compares a requested id
    against these values and nothing else. An empty mapping is therefore a
    session that can reach no partner record at all, which is precisely what a
    pending applicant is given.

    `renewed_from` is the `jti` this session replaces, recorded so a chain of
    renewals can be read back from the `sessions` collection. It is written on
    the record and never on the token — it is not authority, it is history.

    ── Two expiry timestamps, and why ───────────────────────────────────────
    The token's `exp` is the real expiry and the only one anything is decided
    on: `verify_session` refuses past it. The **record's** `expires_at` is a
    different thing — it is what the TTL index in `app/db/mongo.py` reaps on —
    and it is set later, at `exp` plus the renewal grace.

    That gap is deliberate. `renew_session` accepts a token that expired inside
    the grace window, and the first thing it does is read this record to find
    out whether the session was revoked. If the record were reaped at `exp`
    there would be nothing left to read, and "revoked" and "expired half an
    hour ago" would be indistinguishable — which is the one distinction that
    must never blur, because a revoked session staying revoked depends on it.
    """
    jti = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=session_ttl_for(role))
    reap_at = expires + timedelta(minutes=settings.session_renewal_grace_minutes)
    team = team_of(role)

    scoped = {
        str(k): str(v)
        for k, v in dict(partner_ids or {}).items()
        if str(v or "").strip()
    }

    claims = {
        "sub": uid,
        "email": email,
        "name": name,
        "role": str(role),
        "team": str(team) if team else None,
        "jti": jti,
        "iss": settings.jwt_issuer,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
    }
    record: dict = {
        "jti": jti,
        "uid": uid,
        "email": email,
        "role": str(role),
        "issued_at": now,
        #: What the TTL index reaps on — the token's expiry plus the renewal
        #: grace, so the revocation flag outlives the token it belongs to.
        "expires_at": reap_at,
        #: What the token itself says. The one figure `verify_session` honours.
        "token_expires_at": expires,
        "revoked": False,
        "renewed_from": renewed_from,
    }
    if role == Role.OWNER:
        # P1-A3: whether THIS session passed the Owner's second factor. Only an
        # Owner token carries it; `deps.current_user` limits an Owner session
        # without it to the MFA routes. Set only by `services/owner_mfa`.
        claims["mfa"] = bool(mfa_verified)
        record["mfa_verified"] = bool(mfa_verified)
    if partner_ids is not None or partner_status is not None:
        claims["partners"] = scoped
        claims["partner_status"] = partner_status or ""
        record["partners"] = scoped
        record["partner_status"] = partner_status or ""

    token = jwt.encode(claims, settings.jwt_secret, algorithm="HS256")

    # Recorded so a session can be revoked before it expires.
    await get_db()[C.SESSIONS].insert_one(record)
    return token, expires


async def verify_session(token: str) -> dict:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
        )
    except JWTError as exc:
        raise AuthError("Session is invalid or has expired") from exc

    record = await get_db()[C.SESSIONS].find_one({"jti": claims.get("jti")})
    if record is None:
        raise AuthError("Session not found")
    if record.get("revoked"):
        raise AuthError("Session has been revoked")

    role = Role(claims["role"])
    partner_ids = {
        str(k): str(v)
        for k, v in dict(claims.get("partners") or {}).items()
        if str(v or "").strip()
    }
    if not is_external(role):
        # A staff token has no partner scope and must never acquire one. If a
        # forged or stale claim carries partner ids on an internal role they are
        # dropped here rather than trusted — an internal session's authority
        # comes from its role, and mixing the two vocabularies is how a scope
        # check ends up reading the wrong field.
        partner_ids = {}

    return {
        "uid": claims["sub"],
        "email": claims.get("email", ""),
        "name": claims.get("name", ""),
        "role": role,
        "team": claims.get("team"),
        "jti": claims.get("jti"),
        #: Capability → the one partner record this session may read for it.
        "partner_ids": partner_ids,
        #: Kept for readers written before a login could hold two capabilities.
        #: The agency record if there is one, otherwise the seller record.
        "partner_id": partner_ids.get("agency") or partner_ids.get("seller") or "",
        "partner_status": str(claims.get("partner_status") or ""),
        #: P1-A3 — True only on an Owner session that passed MFA. The session
        #: record must agree: a claim cannot be upgraded without a new token,
        #: and the record is written by the same call that signs it.
        "mfa_verified": bool(claims.get("mfa")) and bool(record.get("mfa_verified")),
    }


async def _session_expiry(jti: str) -> datetime | None:
    """The token expiry recorded for a session (P1-A3b binding lifetime)."""
    record = await get_db()[C.SESSIONS].find_one({"jti": jti}) if jti else None
    return (record or {}).get("token_expires_at")


async def revoke_session(jti: str) -> None:
    await get_db()[C.SESSIONS].update_one({"jti": jti}, {"$set": {"revoked": True}})


# ── Renewal ───────────────────────────────────────────────────────────────────
#
# The complaint this exists for: "when checking seller or try to view seller or
# agency details or refresh it comes back to login page ask to login again."
# Nothing renewed anything. A session lasted twelve hours, and the only code
# that ran when one was refused cleared the token and told the person it had
# ended. So the answer is not merely a longer token — it is that an active
# session is replaced before it dies, and that a refusal to replace it is a
# decision made against the account as it stands *now*, not against a claim.
#
# ── Why this and not the alternatives ────────────────────────────────────────
#
#   * **Not sliding expiry on use.** `verify_session` is one indexed read on
#     every request in the API. Extending the session on use makes it a read
#     and a write on every request, on the hot path of every screen, to move a
#     timestamp that is only ever consulted at renewal. It also never refuses:
#     a session that extends itself whenever it is used has no answer at all to
#     "this account was deactivated", because deactivation is a fact about the
#     account and use is a fact about the token.
#
#   * **Not re-exchanging the Firebase ID token by itself.** That is what
#     `sign_in_with_firebase` already is, and the CRM already calls it. It is
#     the right thing for *establishing* a session and it is what still runs
#     when there is no session to renew. But it cannot be the renewal path,
#     for one reason: Firebase's own session never expires. It sits in
#     IndexedDB and its refresh token is honoured indefinitely, so a CRM built
#     on re-exchange alone can never distinguish somebody who was here
#     yesterday from somebody who was last here in March — and "long time no
#     see" was half the request. The previous session token is the only thing
#     in the system that carries that information, so renewal is built on it.
#
#   * **So: renewal presents the session it wants to replace.** The token is
#     evidence of continuity and nothing more; every grant below is re-read
#     from Mongo. What it buys is the one question Firebase cannot answer —
#     *when did this person last hold a live session here* — which is exactly
#     the line between renewing in silence and asking for a password.
#
# ── What it refuses, and in what order ───────────────────────────────────────
#
#   1. A token that is not ours, or has been tampered with.
#   2. A token whose expiry is further in the past than the grace window —
#      "you have been away a long time". This is checked before the database is
#      touched, so a very old token costs a signature check and nothing more.
#   3. The observer, always. Their rules are unchanged and this is the change
#      that would have altered them.
#   4. A session with no record, or a revoked one. `services/staff.py` revokes
#      every session for a uid on deactivation and on a role change, so both of
#      those land here — and a revoked session stays revoked whatever the rest
#      of the world says, which is why this is checked before the account is.
#   5. An account that no longer holds the role on the token: deactivated,
#      demoted, or gone. Read from `staff` and `partners`, never from the claim.
#
# Nothing here is best-effort. Every refusal is an `AuthError`, the router
# turns it into a 401, and the CRM's answer to a refused renewal is to ask for
# a password — which is the correct end of "and if expire also… asking relogin".


async def renew_session(token: str) -> tuple[str, datetime, dict]:
    """Replace a live or recently expired session with a fresh one.

    Returns the same triple as `sign_in_with_firebase` — token, expiry,
    profile — because the caller does the same thing with it.

    The session presented is **revoked** before the replacement is issued, so
    exactly one token is live at a time and a renewal cannot be replayed. That
    is deliberate and it has a cost: two browser tabs renewing the same session
    at the same moment means the second one is refused. `lib/api.ts` handles
    that by re-reading shared storage and retrying once, and only once.
    """
    now = datetime.now(timezone.utc)

    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            issuer=settings.jwt_issuer,
            # The whole point is to look at a token that may have expired. The
            # signature, the issuer and every other claim are verified exactly
            # as `verify_session` verifies them; `exp` is checked below by hand
            # because the answer here is a window rather than a yes/no.
            options={"verify_exp": False},
        )
    except JWTError as exc:
        raise AuthError("Session is invalid. Sign in again.") from exc

    expires_at = int(claims.get("exp") or 0)
    if not expires_at:
        raise AuthError("Session is invalid. Sign in again.")

    expired_by = now - datetime.fromtimestamp(expires_at, timezone.utc)
    grace = timedelta(minutes=settings.session_renewal_grace_minutes)
    if expired_by > grace:
        # The "long time no see" refusal, and the only one of these a person
        # who has done nothing wrong will ever see. It says what happened.
        raise AuthError(
            "It has been a while since you last used the CRM. "
            "Sign in again to continue."
        )

    role = Role(claims["role"])
    if not is_renewable(role):
        raise AuthError(
            "Observer access is granted one sign-in at a time. "
            "Request a new code to continue."
        )

    jti = str(claims.get("jti") or "")
    db = get_db()
    record = await db[C.SESSIONS].find_one({"jti": jti}) if jti else None
    if record is None:
        raise AuthError("Session not found. Sign in again.")
    if record.get("revoked"):
        # Deactivation and a role change both land here — `services/staff.py`
        # revokes every session for the uid before it changes anything else.
        raise AuthError("This session has been ended. Sign in again.")

    uid = str(claims["sub"])
    email = str(claims.get("email") or "").lower()

    # ── Who they are now, read from Mongo ────────────────────────────────────
    # Same resolution as `sign_in_with_firebase`, and for the same reason: the
    # uid in `sub` is the canonical identity, staff is read first and wins, and
    # an email that matches a row recording a DIFFERENT live account is a
    # conflict rather than a match. A partner who has since been given a staff
    # row is not renewed into their old external session — the role changed,
    # and a role change is a re-login.
    #
    # `email_proven=True` here, unlike at sign-in: there is no ID token to
    # inspect, but this session exists because `sign_in_with_firebase` already
    # demanded that proof. Renewal is not a second front door.
    staff = await _staff_for_authenticated_uid(uid, email, email_proven=True)

    if staff is not None:
        if not staff.get("is_active", True):
            raise AuthError("This account has been deactivated.")
        await _refuse_restricted_app_account(uid)

        current = Role(staff["role"])
        if current != role:
            # Belt and braces: `change_role` already revoked this session, so
            # this line should be unreachable through the CRM. It is here for
            # the role that was changed by a script, a migration or a hand
            # edit, none of which go through the service that revokes.
            raise AuthError("Your role has changed. Sign in again.")

        name = str(staff.get("name", ""))
        await revoke_session(jti)
        # P1-A3: a renewal continues the SAME sign-in, so an Owner who passed
        # MFA keeps it and one who has not still has not. An Observer reset of
        # the Owner's MFA revokes every session, so nothing stale renews.
        mfa_ok = bool(claims.get("mfa")) and bool(record.get("mfa_verified"))
        new_token, expires = await issue_session(
            uid=uid, email=email, name=name, role=current, renewed_from=jti,
            mfa_verified=mfa_ok,
        )
        log.info("Renewed the session of %s (%s)", uid, current)
        profile = {
            "uid": uid,
            "email": email,
            "name": name,
            "role": str(current),
            "team": str(team_of(current)) if team_of(current) else None,
        }
        if current == Role.OWNER and mfa_ok and record.get("mfa_binding_id"):
            # P1-A3b: the Firestore/Storage binding follows a VALID renewal —
            # moved to the new jti and extended to the new expiry. A binding
            # removed by sign-out, reset or suspension is never re-created.
            from app.services import owner_mfa

            new_jti = str((await verify_session(new_token)).get("jti") or "")
            profile["mfa_firestore_binding"] = await owner_mfa.carry_binding(jti, new_jti, uid, expires)
        return new_token, expires, profile

    if not is_external(role):
        # An internal session whose `staff` row has gone. Falling through to
        # the partner branch would answer "you are an agency" to a departed
        # owner if a `crmUsers` document happened to name one.
        raise AuthError("This account no longer has access. Sign in again.")

    # ── An external partner ──────────────────────────────────────────────────
    # `resolve_partner_login` is the same function sign-in uses, run again from
    # nothing: it re-reads `partners`, honours `crmUsers.isActive`, and raises
    # on a rejected or suspended record. The partner ids that come back are the
    # ones it resolves now — the claim's are not consulted, not merged and not
    # used as a fallback, so a capability withdrawn since sign-in is gone from
    # the renewed session and one granted since is present in it.
    # True, for the reason the staff lookup is given True on renewal: the proof
    # happened at sign-in, and a live session is the evidence of it. Re-deriving
    # it from a renewal token would refuse every partner an hour after they
    # signed in, because a renewal carries no provider claim.
    partner = await resolve_partner_login(uid, email, email_proven=True)
    if partner is None:
        raise AuthError("No account found. Contact your administrator.")
    if partner.role != role:
        raise AuthError("Your role has changed. Sign in again.")

    await revoke_session(jti)
    new_token, expires = await issue_session(
        uid=uid,
        email=email,
        name=partner.name,
        role=partner.role,
        partner_ids=partner.partner_ids,
        partner_status=partner.status,
        renewed_from=jti,
    )
    log.info(
        "Renewed the session of partner %s (%s), scope %s",
        uid,
        partner.role,
        sorted(partner.partner_ids),
    )
    return new_token, expires, partner.profile(uid, email)


def renew_at(expires: datetime, role: Role | None = None) -> datetime:
    """When the browser should come back and renew this session.

    Served on every session response so the CRM holds no second copy of
    `session_renew_before_minutes`.

    Two things it must never do, and both were live bugs before this took a
    role:

      * **Never point before the session was issued.** The lead time is a
        setting and the TTL is a setting, and nothing stops the first being
        larger than the second. The observer is exactly that case today — a
        twelve-hour session with a one-day lead — and an unclamped subtraction
        told their browser to renew twelve hours *before* they signed in, so
        the CRM would have renewed on the first frame, been refused (they are
        not renewable), and thrown them straight back to the login screen. The
        clamp is half the TTL, so the lead is always inside the session.

      * **Never send a session that cannot renew to be renewed.** For the
        observer this is the expiry itself: there is nothing to come back
        early for, and the browser discovers the session has ended at the
        moment it actually ends, which is when it should.
    """
    if role is not None and not is_renewable(role):
        return expires

    ttl = session_ttl_for(role) if role is not None else int(settings.session_ttl_minutes)
    lead = min(int(settings.session_renew_before_minutes), max(ttl // 2, 1))
    return expires - timedelta(minutes=lead)


# ── Resolving a token to a staff row ──────────────────────────────────────────
#
# THE AUTHENTICATED UID IS THE CANONICAL IDENTITY. Everything below exists to
# keep that true.
#
# There used to be two lines here:
#
#     staff = await db[C.STAFF].find_one({"uid": uid})
#     if staff is None and email:
#         staff = await db[C.STAFF].find_one({"email": email})
#
# and the second one was a hole wide enough to drive an owner session through.
# `email` comes off the ID token, and a Firebase token bearing an address is
# not a claim to the *account* that address belongs to — Google, phone-plus-
# profile-email and a fresh password signup can all produce one. So anybody
# who signed in as uid B while a staff row recorded uid A for the same Gmail
# was issued a real session carrying A's role, and `issue_session` then stamped
# it with uid B. Two identities, one role, no record of the substitution.
#
# Adding Google to the CRM would have made this routine rather than obscure: a
# Google sign-in mints a NEW uid for an address that already has a password
# account, so every owner's first Google login would have taken that path.
#
# What replaces it distinguishes two genuinely different situations.
#
#   CONFLICT   the row names uid A, A is a live Firebase account, and the
#              token is uid B. Two real accounts. Refused, and named as such,
#              because resolving it means linking providers or retiring one of
#              them, and both are decisions with a person attached.
#
#   ORPHAN     the row names no uid at all, or names one that no longer exists
#              in Firebase Auth. Nobody can ever produce a token for it, so the
#              row is unreachable. Adopting it is the repair — but only for a
#              token that PROVED control of the address, and the adoption is
#              written down and audited rather than left implicit.


def _sign_in_provider(decoded: dict) -> str:
    fb = decoded.get("firebase")
    return str(fb.get("sign_in_provider", "")) if isinstance(fb, dict) else ""


def _proves_email(decoded: dict) -> bool:
    """Did this token prove control of the mailbox it carries?

    Two conditions, and both matter.

    `email_verified` alone is not enough, because it is a property of the
    account rather than of this sign-in: an account can carry a verified
    address and have been entered by phone OTP, which proves a handset and
    says nothing about the inbox.

    So the provider has to be one that authenticated against the address
    itself. `password` did — the password was set through that mailbox.
    `google.com` did — Google asserts the address it returns. Nothing else
    does.
    """
    if not decoded.get("email"):
        return False
    if decoded.get("email_verified") is not True:
        return False
    return _sign_in_provider(decoded) in ("password", "google.com")


async def _staff_for_authenticated_uid(
    uid: str, email: str, *, email_proven: bool
) -> dict | None:
    """The staff row belonging to this uid, or None. Never somebody else's.

    `email_proven` says whether the caller has demonstrated control of the
    address — see `_proves_email`. Renewal passes True because the proof
    happened at sign-in and the session is evidence of it.
    """
    db = get_db()

    row = await db[C.STAFF].find_one({"uid": uid})
    if row is not None:
        return row

    if not email:
        return None

    candidate = await db[C.STAFF].find_one({"email": email})
    if candidate is None:
        return None

    # The observer is decided before anything else, and by ROLE. Its row
    # carries the synthetic uid `observer:<email>`, which `firebase.get_user`
    # correctly reports as no account — so without this line the orphan branch
    # below would treat the observer as a repairable row and adopt it onto
    # whichever uid just presented that Gmail. That is the original hole with
    # a new name.
    if str(candidate.get("role", "")) == str(Role.OBSERVER):
        return candidate

    recorded = str(candidate.get("uid", "") or "")

    if recorded and recorded != uid:
        # `firebase.get_user` already answers None for a uid that names no
        # account and for a synthetic one like `observer:<email>`. Anything
        # else out of it — Auth unreachable, a quota, a malformed credential —
        # means we cannot tell a conflict from a repair, and guessing either
        # way is wrong: guess "conflict" and an outage locks out every staff
        # member whose row needs repairing; guess "repair" and an outage is a
        # window for adopting somebody else's row.
        #
        # `DirectoryUnavailable` is the existing answer to this shape of
        # problem and it lands in the 500s, where a monitor sees it. An
        # infrastructure failure must not present as an authentication failure.
        try:
            existing = firebase.get_user(recorded)
        except Exception as exc:  # noqa: BLE001
            log.error(
                "Could not check whether uid %s still exists while resolving %s: %s",
                recorded, email, exc,
            )
            raise DirectoryUnavailable(
                "Could not verify this account right now. Try again shortly."
            ) from exc
        if existing is not None:
            log.warning(
                "Identity conflict for %s: token uid %s, staff row uid %s. "
                "Both are live Firebase accounts; refusing to choose.",
                email, uid, recorded,
            )
            raise IdentityConflictError(
                "This email already has a Zipper account signed in a different "
                "way. Sign in with your original method, then connect this one "
                "from Settings so both reach the same account."
            )

    if not email_proven:
        log.warning(
            "Refused an unproven email match for %s (token uid %s, row uid %r). "
            "The sign-in did not demonstrate control of the address.",
            email, uid, recorded,
        )
        return None

    # ── AN UNREACHABLE ROW IS A REPAIR JOB, NOT A SIGN-IN ────────────────────
    #
    # This used to ADOPT the row: rewrite `staff.uid` to whichever uid had just
    # proved the mailbox, and hand back the role. The reasoning was that a row
    # whose recorded uid names no Firebase account can never be reached by
    # anyone, so binding it to a uid that CAN be authenticated is the repair —
    # and proving control of the address is the whole of the control.
    #
    # That reasoning had a hole, and it was opened wider by a change made the
    # same week. `_proves_email` accepts `sign_in_provider == "password"`, which
    # until recently no app account could ever produce. The Android app's guest
    # email-binding uses Firebase's email-LINK sign-in, and
    # `EmailAuthProvider.PROVIDER_ID` is the literal string `"password"` — it is
    # Firebase's one email provider with two sign-in methods. So any app user
    # who binds an email now carries a `password` provider with no password on
    # it, and the public "forgot password" form will happily set one. The chain
    # ends with an ordinary app user holding a token that satisfies every test
    # above and walking into a departed staff member's role.
    #
    # The fix is not a better test of who is asking. It is that a sign-in is the
    # wrong moment to rewrite an identity record at all: it happens on an
    # unauthenticated person's say-so, on a path with no reviewer and no audit
    # entry. `scripts/repair_staff_accounts.py` exists for exactly this, runs
    # with the Admin SDK under somebody's hand, and reports what it changed.
    #
    # So: refuse, name the situation, and log it loudly enough to be found.
    log.error(
        "Unreachable staff row for %s: recorded uid %r names no Firebase "
        "account, and uid %s proved the address. NOT adopting — run "
        "scripts/repair_staff_accounts.py to rebind it deliberately.",
        email, recorded, uid,
    )
    raise IdentityConflictError(
        "This account needs to be reconnected before you can sign in. "
        "Contact an administrator."
    )


# ── C4 — a restricted app account gets no CRM session ─────────────────────────


async def _refuse_restricted_app_account(uid: str) -> None:
    """Refuse sign-in or renewal for a uid whose APP account is suspended or banned.

    The same verdict `core/account_state` applies to a live session on every
    re-check, applied at the two moments a session is minted. Raises
    `AuthError` with the account-restricted sentence.
    """
    from app.core.account_state import app_account_refusal_for  # local: keeps the import graph flat

    refusal = await app_account_refusal_for(uid)
    if refusal is not None:
        log.info("Refused a CRM session for %s: %s", uid, refusal.reason)
        raise AuthError(refusal.message)


# ── Firebase sign-in (staff, owners, partners) ────────────────────────────────


async def sign_in_with_firebase(id_token: str) -> tuple[str, datetime, dict]:
    try:
        decoded = firebase.verify_id_token(id_token)
    except Exception as exc:  # noqa: BLE001
        raise AuthError("Could not verify sign-in") from exc

    uid = decoded.get("uid", "")
    email = (decoded.get("email") or "").lower()

    # Computed once and shared by both lookups below. The staff path and the
    # partner path are entitled to exactly the same proof, and deriving it twice
    # is how they came to disagree about it in the first place.
    proves_email = _proves_email(decoded)

    staff = await _staff_for_authenticated_uid(uid, email, email_proven=proves_email)

    # ── The observer is never reachable from a Firebase token ────────────────
    #
    # It is a read-only identity with `can_read_all`, and — deliberately —
    # NO FIREBASE ACCOUNT AT ALL (`scripts/seed_accounts.py`: "Deliberately no
    # Firebase account and no password"). Its Mongo row carries the synthetic
    # uid `observer:<email>`, so the uid lookup above can never match it.
    #
    # The email fallback on the line above could, and that was a live hole. The
    # address is unclaimed in Firebase precisely because it has no account, so
    # anyone able to sign in with that Gmail — via Google on the app, or any
    # other Firebase provider — minted a token bearing it, fell through to the
    # email lookup, and was issued a genuine observer session with read access
    # to the whole business. No password required, because there is no password
    # to require.
    #
    # The observer signs in at /observer with a one-time code mailed to a
    # SEPARATE address. That is the only door, and this closes the other one.
    if staff is not None and str(staff.get("role", "")) == str(Role.OBSERVER):
        log.warning(
            "Refused a Firebase-token observer session for %s (uid %s). "
            "The observer signs in only via the emailed code at /observer.",
            email or "<no email>",
            uid,
        )
        raise AuthError("This account cannot sign in here.")

    if staff is not None:
        # ── Staff takes precedence, always ──────────────────────────────────
        # Somebody can be both: an ops member who also owns an agency. The
        # `staff` row wins, and it wins *before* the partner collection is even
        # read, so there is no ordering to get wrong later. The consequence is
        # deliberate — they get an internal session with no partner scope on it,
        # and read their own agency the way any other staff member does.
        if not staff.get("is_active", True):
            raise AuthError("This account has been deactivated.")
        await _refuse_restricted_app_account(uid)

        role = Role(staff["role"])
        name = staff.get("name", "")

        token, expires = await issue_session(
            uid=uid, email=email, name=name, role=role
        )
        return (
            token,
            expires,
            {
                "uid": uid,
                "email": email,
                "name": name,
                "role": str(role),
                "team": str(team_of(role)) if team_of(role) else None,
            },
        )

    # ── No staff row. An external partner, or nobody. ───────────────────────
    #
    # `_proves_email` was already computed for the staff lookup above; the
    # partner lookup is entitled to exactly the same proof and no more.
    partner = await resolve_partner_login(uid, email, email_proven=proves_email)
    if partner is None:
        raise AuthError("No account found. Contact your administrator.")

    token, expires = await issue_session(
        uid=uid,
        email=email,
        name=partner.name,
        role=partner.role,
        partner_ids=partner.partner_ids,
        partner_status=partner.status,
    )
    return token, expires, partner.profile(uid, email)


# ── Partner sign-in (an agency or a coin seller) ──────────────────────────────
#
# An external partner has no row in `staff` and never will — `crm_directory`
# says so in `NOT_MIRRORED`, and `MONGO_ROLE_REFUSED` refuses to invent one.
# Their business record is in Mongo `partners`; their login is a Firebase uid.
# The join between the two already exists and is **not** invented here:
#
#   * `crmUsers/{uid}.agencyId` / `.sellerId` — written by the signup flows in
#     `zipper-crm/lib/auth.ts`, and the exact field `firestore.rules` binds an
#     agency's own reads to (`crmUserAgencyId()`).
#   * `crmUsers/{uid}.roles` — every capability the login holds once it holds
#     more than one (`zipper-crm/lib/partnerRouting.ts`).
#   * `partners.owner_crm_uid` — the same uid, on the Mongo record, written by
#     `partner_ops.request_second_role` and by the attach-login endpoint.
#
# Mongo is read first and is what decides. Firestore is consulted for the link
# and never for the verdict: a `crmUsers` document claiming `status: approved`
# grants nothing, because approval is a `partners` record's `status` field and
# that is the only field looked at below. A partner who could edit their own
# Firestore document — the rules permit them a narrow write on it — can at most
# name a partner record; whether that record can do anything is answered from
# Mongo.


#: What a `partners` record's `kind` is worth as a capability name on a session.
#: Two names, because a sub-agency reads an agency's statement.
_CAPABILITY = {"agency": "agency", "sub_agency": "agency", "seller": "seller"}


@dataclass(frozen=True, slots=True)
class PartnerLogin:
    """A resolved external partner: who they are, and what they may reach.

    `partner_ids` is empty for an applicant still under review. That is not a
    degenerate case to be tidied away — it is the whole of the pending decision
    (see `resolve_partner_login`), and every scope check in the API reads this
    mapping, so an empty one is a session that cannot reach a partner record.
    """

    role: Role
    name: str
    status: str
    partner_ids: Mapping[str, str]

    @property
    def has_access(self) -> bool:
        return bool(self.partner_ids)

    def profile(self, uid: str, email: str) -> dict:
        return {
            "uid": uid,
            "email": email,
            "name": self.name,
            "role": str(self.role),
            "team": None,
            # The portal reads these to decide between a dashboard and a
            # waiting room, so the answer is on the sign-in response rather
            # than behind a second call the pending account cannot make.
            "partner_ids": dict(self.partner_ids),
            "partner_status": self.status,
            "access": "records" if self.has_access else "none",
        }


def _crm_partner_document(
    uid: str, email: str, *, email_proven: bool = False
) -> tuple[dict, bool]:
    """`(document, unreadable)` — the `crmUsers` document behind this login.

    ── `email_proven` IS THE AUTHORISATION GATE, NOT A HINT ──────────────────

    The address fallback below returns a document filed under a DIFFERENT uid,
    and the caller seeds `_claimed_partner_ids` from it — so that document is
    not merely a link, it is the authority on the resulting session. Ungated,
    the chain read:

        email on the token  →  find a crmUsers doc under another uid
                            →  inherit its partner id

    which is email matching used as an authorisation mechanism. Firebase's
    one-account-per-address rule happens to make it unexploitable today, but
    nothing here asserted that, `email_verified` was not consulted at all, and
    the staff path next door had already decided not to rely on it — which is
    exactly why `_staff_for_authenticated_uid` takes this same flag. Two sibling
    functions disagreeing about the rule is the rule drifting.

    So the fallback now requires what the staff one requires: a token that
    authenticated AGAINST the address — `password` or `google.com`, verified.
    See `_proves_email`. A phone-OTP session proves a handset and says nothing
    about an inbox, so it resolves by uid or not at all.

    ── THE REST, UNCHANGED ───────────────────────────────────────────────────

    A staff document is ignored rather than refused: the caller has already
    established there is no `staff` row, so a `crmUsers` document naming a staff
    role is a half-created staff account, and answering "you are an agency"
    because of it would be worse than answering "no account found".

    **`unreadable` is the second return value and not an afterthought.**
    Firestore being unreachable was treated as "no document", on the reasoning
    that `partners.owner_crm_uid` carries the same link. It does — for records
    that have it. A partner whose link lives only in Firestore then resolved to
    nothing, and nothing means "No account found", and that means 401.

    So the caller has to be able to tell an empty answer from an absent one. An
    empty document with `unreadable=True` is not a verdict, and nobody may be
    turned away on it.
    """
    from app.services import crm_directory as crm

    unreadable = False

    try:
        found = crm.read(uid) or {}
    except Exception:  # noqa: BLE001
        log.warning("crmUsers/%s could not be read during sign-in", uid)
        found = {}
        unreadable = True

    if not found and email and email_proven:
        try:
            for doc_id, data in crm.find_by_email(email):
                # P0-5 (AUTHN-1): only a document whose address the server
                # stamped as verified on ITS OWN sign-in. A typed partner
                # address lands on a login document unproven, and matching it
                # here attached another uid to that partner.
                if data.get("emailProven") is not True:
                    continue
                if str(data.get("role", "")) in _CAPABILITY:
                    # Matched on address because a partner whose document was
                    # written under a different uid — a login recreated after a
                    # deletion — is otherwise invisible. Reachable only with a
                    # token that authenticated against this very address, which
                    # is what makes the match a claim about a person rather than
                    # a string comparison. Logged either way: a partner resolved
                    # by address and not by uid is a record that wants repairing.
                    log.info(
                        "Partner sign-in matched crmUsers/%s by proven email "
                        "rather than by uid",
                        doc_id,
                    )
                    return dict(data), False
        except Exception:  # noqa: BLE001
            log.warning("crmUsers could not be searched for a partner address")
            unreadable = True
    elif not found and email and not email_proven:
        # Not an error and not a refusal — just not a match. The uid lookup
        # above is the only one this session is entitled to, and Mongo's
        # `owner_crm_uid` link in the caller is still consulted, so a partner
        # whose record is properly linked signs in by phone exactly as before.
        log.info(
            "Partner sign-in for uid %s resolved by uid only; the token does "
            "not prove its email address",
            uid,
        )

    if str(found.get("role", "")) in _CAPABILITY:
        return found, False
    return {}, unreadable


def _claimed_partner_ids(document: Mapping) -> dict[str, str]:
    """The partner ids a `crmUsers` document names, by capability.

    `roles` gates which links are read, exactly as `partnerRolesOf` does in the
    CRM: a document carrying a stray `sellerId` but no seller capability names
    no seller. It cannot escalate anything either way — the id is then looked up
    in Mongo, and an id whose record is not approved grants nothing.
    """
    primary = str(document.get("role", "")).strip()
    if primary not in _CAPABILITY:
        return {}

    declared = document.get("roles")
    held = {_CAPABILITY[primary]}
    if isinstance(declared, (list, tuple)):
        held |= {
            _CAPABILITY[str(r)] for r in declared if str(r) in _CAPABILITY
        }

    links = {"agency": "agencyId", "seller": "sellerId"}
    out: dict[str, str] = {}
    for capability in held:
        value = str(document.get(links[capability]) or "").strip()
        if value:
            out[capability] = value
    return out


async def _rejection_of_login(db, uid: str, document: Mapping) -> str:
    """Decision 16 (RC): the rejection sentence when EVERY record of this login was rejected; else ''."""
    from app.services import partners as partner_svc

    ids = set(_claimed_partner_ids(document).values())
    rows: list[dict] = []
    async for record in db[C.PARTNERS].find({"owner_crm_uid": uid}):
        rows.append(record)
        ids.discard(str(record.get("_id") or ""))
    for pid in ids:
        record = await db[C.PARTNERS].find_one({"_id": pid})
        if record is not None:
            rows.append(record)
    if not rows:
        return ""
    rejected = str(partner_svc.PartnerStatus.REJECTED)
    if any(str(r.get("status") or "") != rejected for r in rows):
        return ""

    def _when(r: dict) -> str:
        return str(r.get("rejected_at") or r.get("updated_at") or "")

    latest = max(rows, key=_when)
    reason = str(latest.get("rejection_reason") or "").strip()
    return (
        "This application was not approved"
        + (f": {reason}" if reason else ".")
        + " You may apply again — a new application is reviewed on its own."
    )


async def resolve_partner_login(
    uid: str, email: str, *, email_proven: bool = False
) -> PartnerLogin | None:
    """Resolve a Firebase login to an external partner, or refuse, or None.

    `email_proven` is passed straight to `_crm_partner_document` and is the
    difference between resolving this partner by their uid and resolving them by
    an address someone typed. It defaults to False so a caller that forgets it
    gets the narrow, uid-only behaviour rather than the permissive one.

    Returns None when the login names no partner record at all — the caller
    turns that into the same "No account found" a stranger has always been
    given, because a stranger and an applicant who never registered are
    indistinguishable and the message must not tell them apart.

    Raises `AuthError` when a record is found and it must not have a session.

    ── The decision on a pending applicant ──────────────────────────────────
    A partner whose record is `pending` is given a session with **no partner
    ids on it**, rather than being refused outright. Two reasons, and the second
    is the one that matters:

      1. It is the behaviour the product needs. The applicant's portal has a
         waiting room (`PARTNER_PENDING` in `lib/partnerRouting.ts`) and a
         rejection reason to show, and neither is reachable without a session.
         Refusing gives them "No account found. Contact your administrator." —
         the exact dead end this whole path exists to remove.
      2. It can do nothing, and that does not depend on remembering to check
         `status` anywhere. Authority for an external session is
         `partner_ids`, and a pending applicant's is empty, so every scoped
         route refuses on the same comparison that refuses somebody else's id.
         There is no "pending" branch to forget: an approved partner reaching
         their own record and a pending one reaching anything take the identical
         code path and the pending one loses. Outside those routes the session
         is on the deny-by-default allowlist in `app/core/deps.py`, which is a
         list of eight read-only routes and contains no money endpoint at all.

    Rejection and deactivation are refusals rather than empty sessions: there is
    nothing to wait for, and the account should stop working.
    """
    from app.services import partners as partner_svc

    db = get_db()
    document, directory_unreadable = await asyncio.to_thread(
        _crm_partner_document, uid, email, email_proven=email_proven
    )

    if document:
        # ── Self-heal: put their phone on their Firebase account ─────────────
        #
        # Attaching at approval covers every partner approved from here on.
        # This covers the ones approved before that existed, on their next CRM
        # sign-in, so nobody has to remember to run anything.
        #
        # Costs nothing on the common path: `document` has already been read,
        # and a marker on it means the Firebase call happens once per partner
        # and never again. Best-effort by construction — `ensure_app_phone`
        # never raises, because failing a sign-in over a phone number would be a
        # far worse outcome than the missing app badge it is fixing.
        from app.services import crm_directory as _crm

        phone_note = await asyncio.to_thread(_crm.ensure_app_phone, uid, document)
        if phone_note:
            log.warning("Partner app sign-in for %s: %s", uid, phone_note)

    if document and document.get("isActive") is False:
        # The CRM's own deactivation control (`agencies.ts` writes exactly this
        # when an agency account is switched off). Honoured before anything is
        # granted, so turning a partner off in the CRM turns off the API too.
        #
        # Decision 16 (RC): a REJECTION also leaves the login inactive, and
        # "deactivated" is untrue for somebody whose application was simply
        # refused — they are entitled to the reason, and to apply again. So
        # when every record this login names was rejected (nothing live,
        # pending or waiting), the refusal says so, with the reason. Still no
        # session either way.
        rejected_only = await _rejection_of_login(db, uid, document)
        if rejected_only:
            raise AuthError(rejected_only)
        raise AuthError("This account has been deactivated.")

    candidates = _claimed_partner_ids(document)

    # The Mongo side of the link, which is authoritative and needs no network.
    # It is a union with the Firestore claim rather than a fallback: a partner
    # whose `crmUsers` document was never written — the orphan the attach-login
    # endpoint exists for — is reachable through this alone.
    async for record in db[C.PARTNERS].find({"owner_crm_uid": uid}):
        capability = _CAPABILITY.get(str(record.get("kind", "")))
        if capability:
            candidates.setdefault(capability, str(record["_id"]))

    if not candidates:
        if directory_unreadable:
            # Mongo answered and named no partner, but the Firestore half of the
            # link could not be read — and for a partner whose `crmUsers`
            # document is the only place that link exists, this is precisely the
            # case that must not be reported as "no account".
            #
            # Returning None here sends the caller down the stranger path and
            # out as 401, which tells a legitimate agency their password is
            # wrong during an outage they cannot see and cannot fix.
            raise DirectoryUnavailable(
                "We cannot verify your account right now because the staff and "
                "partner directory could not be read. This is a problem at our "
                "end, not with your email or your password — nothing about your "
                "account has changed. Please try again in a few minutes."
            )
        return None

    granted: dict[str, str] = {}
    pending: dict[str, str] = {}
    awaiting_verification = False
    rejections: list[str] = []
    deactivations: list[str] = []
    name = str(document.get("name") or "").strip()

    for capability, partner_id in sorted(candidates.items()):
        record = await db[C.PARTNERS].find_one({"_id": partner_id})
        if record is None:
            # A `crmUsers` document naming a partner that was never registered.
            # Nothing to grant and nothing to refuse.
            continue

        # The record's own kind decides the capability, never the claim that
        # led us to it. A document with `agencyId` pointing at a seller record
        # gets a seller's scope, or none.
        actual = _CAPABILITY.get(str(record.get("kind", "")))
        if actual is None:
            log.error(
                "Partner %s carries kind %r, which is not a partner kind. No "
                "session scope was granted for it.",
                partner_id,
                record.get("kind"),
            )
            continue

        status = str(record.get("status") or "")
        active = bool(record.get("is_active", False))
        name = name or str(record.get("name") or "").strip()

        if status == str(partner_svc.PartnerStatus.APPROVED) and active:
            granted.setdefault(actual, partner_id)
        elif status in (
            str(partner_svc.PartnerStatus.PENDING),
            # Decision 15 (RC): the same waiting-room session as pending — no
            # partner ids, nothing to read — so the person can sign in and
            # verify the contacts their role is waiting for.
            str(partner_svc.PartnerStatus.AWAITING_VERIFICATION),
        ):
            pending.setdefault(actual, partner_id)
            if status == str(partner_svc.PartnerStatus.AWAITING_VERIFICATION):
                awaiting_verification = True
        elif status == str(partner_svc.PartnerStatus.REJECTED):
            # The reason is `reject_partner`'s, stored on the record and shown
            # verbatim. A rejected applicant currently reapplies because nobody
            # ever told them why; the refusal is the one place they will read it.
            rejections.append(
                "This application was not approved"
                + (
                    f": {record.get('rejection_reason')}"
                    if record.get("rejection_reason")
                    else "."
                )
            )
        else:
            deactivations.append("This account has been deactivated.")

    if granted or pending:
        # C4: a partner whose APP account is suspended or banned is given no
        # session — not a scoped one and not a waiting-room one. Checked only
        # now, when there is a partner to answer for, so a stranger is still
        # told "No account found" and nothing more. Sign-in and renewal both
        # come through here.
        await _refuse_restricted_app_account(uid)

    if granted:
        # At least one live capability. A rejected or suspended *second* record
        # simply contributes no scope — it is not a reason to lock the partner
        # out of the business they are still running.
        role = Role.AGENCY if "agency" in granted else Role.SELLER
        return PartnerLogin(
            role=role,
            name=name,
            status=str(partner_svc.PartnerStatus.APPROVED),
            partner_ids=granted,
        )

    if pending:
        role = Role.AGENCY if "agency" in pending else Role.SELLER
        return PartnerLogin(
            role=role,
            name=name,
            status=(
                str(partner_svc.PartnerStatus.AWAITING_VERIFICATION)
                if awaiting_verification
                else str(partner_svc.PartnerStatus.PENDING)
            ),
            partner_ids={},
        )

    # Nothing live and nothing waiting. Rejection is reported ahead of
    # suspension for a partner holding one of each, because it is the one they
    # can act on — and either way no session is issued.
    if rejections:
        raise AuthError(rejections[0])
    if deactivations:
        raise AuthError(deactivations[0])

    return None


# ── Observer sign-in (one-time code) ──────────────────────────────────────────


def _hash_code(code: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{code}".encode()).hexdigest()


async def request_observer_code(requested_by_ip: str | None = None) -> dict:
    """Generate a one-time code and email it to the delivery mailbox.

    The response never contains the code, and never reveals whether delivery
    succeeded in a way that could be used to probe the mailbox.
    """
    db = get_db()
    email = settings.observer_email.lower()
    now = datetime.now(timezone.utc)

    recent = await db[C.OBSERVER_OTP].find_one(
        {"email": email, "created_at": {"$gt": now - timedelta(
            seconds=settings.otp_resend_cooldown_seconds
        )}}
    )
    if recent is not None:
        raise AuthError(
            f"A code was sent recently. Wait "
            f"{settings.otp_resend_cooldown_seconds} seconds before requesting another."
        )

    # Any outstanding codes are void once a new one is issued.
    await db[C.OBSERVER_OTP].delete_many({"email": email})

    code = f"{secrets.randbelow(1_000_000):06d}"
    salt = secrets.token_hex(16)
    expires = now + timedelta(minutes=settings.otp_ttl_minutes)

    await db[C.OBSERVER_OTP].insert_one(
        {
            "email": email,
            "code_hash": _hash_code(code, salt),
            "salt": salt,
            "created_at": now,
            "expires_at": expires,
            "attempts": 0,
            "used": False,
            "requested_from": requested_by_ip,
        }
    )

    from app.services import email as email_service

    delivered = email_service.send_observer_otp(code, settings.otp_ttl_minutes)
    if not delivered and settings.is_production:
        log.error("Observer OTP could not be delivered")

    return {
        "sent_to": _mask_email(settings.observer_otp_delivery_email),
        "expires_in_minutes": settings.otp_ttl_minutes,
    }


async def verify_observer_code(code: str) -> tuple[str, datetime, dict]:
    """Exchange a valid code for a session."""
    db = get_db()
    email = settings.observer_email.lower()
    now = datetime.now(timezone.utc)

    record = await db[C.OBSERVER_OTP].find_one({"email": email, "used": False})
    if record is None:
        raise AuthError("No sign-in code is outstanding. Request a new one.")

    if record["expires_at"] < now:
        await db[C.OBSERVER_OTP].delete_one({"_id": record["_id"]})
        raise AuthError("That code has expired. Request a new one.")

    if record["attempts"] >= settings.otp_max_attempts:
        await db[C.OBSERVER_OTP].delete_one({"_id": record["_id"]})
        raise AuthError("Too many incorrect attempts. Request a new code.")

    expected = record["code_hash"]
    supplied = _hash_code(code.strip(), record["salt"])

    if not hmac.compare_digest(expected, supplied):
        await db[C.OBSERVER_OTP].update_one(
            {"_id": record["_id"]}, {"$inc": {"attempts": 1}}
        )
        remaining = settings.otp_max_attempts - record["attempts"] - 1
        raise AuthError(
            f"That code is not correct. {max(remaining, 0)} attempts remaining."
        )

    # Single use — consumed the moment it succeeds.
    await db[C.OBSERVER_OTP].delete_one({"_id": record["_id"]})

    # ── THE RECORD MUST EXIST, AND IT MUST BE ACTIVE ─────────────────────────
    #
    # This used to read the observer row and carry on without it: a missing row
    # produced a synthetic uid of `observer:{email}` and a session was issued
    # anyway, and a row present but DEACTIVATED was never consulted at all. So
    # the one account that can read the whole business, and the one account that
    # provisions owners, could be signed in after it had been switched off — and
    # could be signed in against a row that was never created.
    #
    # The address is already pinned: a code is only ever delivered to the
    # configured observer mailbox. But "we only mail it to the right place" is a
    # delivery control, not an authorisation one, and it says nothing about
    # whether the account is still meant to work.
    #
    # Both failures now refuse before a session exists, and they refuse with the
    # same sentence: which of the two it was is in the log and is not something
    # an unauthenticated caller is entitled to learn.
    observer = await db[C.STAFF].find_one({"email": email, "role": str(Role.OBSERVER)})
    if observer is None:
        log.error("Observer sign-in refused: no observer record for %s.", email)
        raise AuthError("This account cannot sign in.")
    if not observer.get("is_active", True):
        log.warning("Observer sign-in refused: the observer record is deactivated.")
        raise AuthError("This account cannot sign in.")

    uid = str(observer.get("uid", "") or "")
    if not uid:
        log.error("Observer record carries no uid; refusing to issue a session.")
        raise AuthError("This account cannot sign in.")
    name = observer.get("name", "Observer")

    token, expires = await issue_session(
        uid=uid, email=email, name=name, role=Role.OBSERVER
    )
    profile = {
        "uid": uid,
        "email": email,
        "name": name,
        "role": str(Role.OBSERVER),
        "team": None,
    }
    return token, expires, profile


def _mask_email(value: str) -> str:
    try:
        local, domain = value.split("@", 1)
    except ValueError:
        return "***"
    shown = local[:2] if len(local) > 2 else local[:1]
    return f"{shown}{'*' * max(len(local) - len(shown), 3)}@{domain}"


# ══════════════════════════════════════════════════════════════════════════════
# Service credentials — an unattended machine, not a person
# ══════════════════════════════════════════════════════════════════════════════
#
# The weekly commission accrual runs on a Sunday-night Cloud Function with
# nobody watching, and it creates a liability the business will later pay. That
# needs an identity. This is it, and it is built on the assumption that the key
# will one day leak.
#
# Four things bound the damage if it does:
#
#   1. **An allowlist, not a role.** A credential names the exact operations it
#      may perform. Adding a route does not widen it; only editing the tuple
#      below does, and that edit is visible in a diff next to this comment. A
#      role drifts as predicates are added — `Op` cannot.
#   2. **No session, no JWT, no role.** A service key is never exchanged for a
#      session token, so it cannot be replayed into any route that takes
#      `Authorization: Bearer`. Two dependencies in `app/core/deps.py` look at
#      the `X-Service-Key` header. Nothing else in the API reads it.
#   3. **It cannot move cash.** Accrual credits a commission *balance*. Paying
#      that balance is `/commission-payouts/{card}/execute`, which is
#      `Depends(require_owner)` and needs a signed card. Neither operation
#      below appears in any cash path.
#   4. **It is audited as itself.** Every entry it writes carries
#      `uid: "system:weekly-accrual"`, `role: "system"`. It never borrows a
#      person's name and is never blank — `app/core/audit.py` refuses both.
#
# The key itself never appears in a log line, an exception message or a
# response body, truncated or otherwise. Comparison is over SHA-256 digests
# with `hmac.compare_digest`, which is constant time *and* fixed length, so
# neither the value nor its length is observable through timing.


class Op:
    """Every operation a service credential can be granted.

    This is the whole vocabulary. A string that is not a member here cannot be
    granted, and `verify_service_key` refuses an operation it does not
    recognise rather than treating an unknown name as harmless.
    """

    # ── Money. Held only by the weekly accrual credential. ───────────────────
    COMMISSION_ACCRUE = "commission.accrue"
    COMMISSION_PREVIEW = "commission.preview"

    # ── Reporting, alerting and email — Part 8A. Held only by the reporting
    #    credential. None of these moves a balance, signs a card, or creates a
    #    liability; the worst a leaked reporting key can do is send a report to
    #    the people who were already going to receive it, and fill the delivery
    #    log doing it. ──────────────────────────────────────────────────────
    REPORTS_SEND = "reports.send"      # 8A.3 — generate and email a report
    ALERTS_SCAN = "alerts.scan"        # 8A.4 — run the exception detectors
    EMAIL_SWEEP = "email.sweep"        # 8A.2 — send transactional mail that is owed
    EMAIL_EVENTS = "email.events"      # 8A.7.5 — ingest provider bounce webhooks

    # ── Onboarding. Held only by the partner-registration credential. It brings
    #    an empty, pending business record into existence for an agency or
    #    seller that already exists in Firestore, and it does nothing else. It
    #    approves nobody, moves no balance and creates no liability. ──────────
    PARTNER_REGISTER = "partner.register"
    # ── Self-application from the app. Held by the SAME partner-registration
    #    credential (one key, no new production configuration): the Cloud
    #    Function callables the app uses present it, carrying the signed-in
    #    user's uid, and this API applies every rule — eligibility, the
    #    one-agency-per-human family, parent validation — before writing a
    #    PENDING record that holds nothing. Same blast radius as registering:
    #    queue noise a reviewer rejects. It also reads eligibility and the list
    #    of agencies a sub-agency or host may hang under, both of which the app
    #    shows to its own users anyway. ─────────────────────────────────────
    PARTNER_APPLY = "partner.apply"
    # ── A buyer's recharge request, filed from the app through a callable,
    #    with the same credential. Creates a PENDING request that moves
    #    nothing; the credit is a separate staff decision. ─────────────────
    RECHARGE_REQUEST = "recharge.request"


KNOWN_OPERATIONS: frozenset[str] = frozenset(
    {
        Op.COMMISSION_ACCRUE,
        Op.COMMISSION_PREVIEW,
        Op.REPORTS_SEND,
        Op.ALERTS_SCAN,
        Op.EMAIL_SWEEP,
        Op.EMAIL_EVENTS,
        Op.PARTNER_REGISTER,
        Op.PARTNER_APPLY,
        Op.RECHARGE_REQUEST,
    }
)

# A key shorter than this is treated as unset. 32 characters is the floor, not
# the recommendation — `backend/scripts/generate_service_key.py` mints 64.
MIN_SERVICE_KEY_CHARS = 32


@dataclass(frozen=True)
class ServiceCredential:
    """One machine identity: where its key comes from, who it is, what it may do."""

    id: str
    settings_attr: str          # attribute on `settings`, fed by the env var
    env_var: str                # the Cloud Run environment variable name
    actor: Mapping[str, object]
    operations: frozenset[str] = field(default_factory=frozenset)

    def may(self, operation: str) -> bool:
        return operation in self.operations


WEEKLY_ACCRUAL = ServiceCredential(
    id="weekly-accrual",
    settings_attr="service_key_weekly_accrual",
    env_var="SERVICE_KEY_WEEKLY_ACCRUAL",
    actor={
        "uid": "system:weekly-accrual",
        "email": "",
        "name": "Weekly accrual (automated)",
        "role": SYSTEM_ROLE,
        "team": None,
        # Carried so a reader of `/audit` can tell *which* machine credential
        # wrote an entry, not merely that some machine did.
        "service_credential": "weekly-accrual",
    },
    operations=frozenset({Op.COMMISSION_ACCRUE, Op.COMMISSION_PREVIEW}),
)

#: Part 8A. Cloud Scheduler runs five unattended jobs — the daily reports, the
#: monthly pack, partner statements, the alert scan and the transactional sweep
#: — and SendGrid posts delivery events to a webhook. All six are this
#: credential's, and it holds **a separate key from the accrual one on purpose**
#: (`config.py::service_key_reporting` says why): leaking the ability to email a
#: report must not also grant the ability to create a commission liability.
#:
#: Note what is not here. There is no `commission.accrue`, no `commission.pay`,
#: nothing that touches a balance and nothing that reads the audit log. The
#: reporting jobs *send* figures to people already entitled to them — the role
#: gate in `email.may_receive` is applied to every recipient at the moment of
#: sending, so even a leaked key cannot redirect a business-wide money figure to
#: an address of the attacker's choosing: recipients come from the staff record,
#: not from the request.
REPORTING = ServiceCredential(
    id="reporting",
    settings_attr="service_key_reporting",
    env_var="SERVICE_KEY_REPORTING",
    actor={
        "uid": "system:reporting",
        "email": "",
        "name": "Scheduled reporting (automated)",
        "role": SYSTEM_ROLE,
        "team": None,
        "service_credential": "reporting",
    },
    operations=frozenset(
        {Op.REPORTS_SEND, Op.ALERTS_SCAN, Op.EMAIL_SWEEP, Op.EMAIL_EVENTS}
    ),
)

#: Onboarding. The Firestore triggers `registerAgencyPartner` /
#: `registerSellerPartner` fire the instant a CRM screen writes an `agencies` or
#: `sellers` document, and register that partner with the API so it lands in the
#: pending queue on /kyc, /agencies and /sellers. Before this existed an
#: applicant was in Firestore, had a login, got the acknowledgement email and
#: appeared on **no staff screen** — the only way to approve them was
#: `scripts/backfill_partners.py`.
#:
#: **Why a third credential rather than an operation on one of the two above.**
#: The blast radius of this key is different from either, in both directions:
#:
#:   * It must not be able to accrue. `partner.register` on WEEKLY_ACCRUAL would
#:     mean a key held by a trigger that fires on *every public signup* could
#:     also create a commission liability. That is precisely backwards — this is
#:     the most frequently exercised, least privileged machine path in the
#:     system and it would inherit the most dangerous grant.
#:   * The accrual key must not be able to register. A credential that runs once
#:     a week, unwatched, should not gain the ability to mint business entities
#:     the rest of the week.
#:   * Nor REPORTING. `email.sweep` and friends send figures to people already
#:     entitled to them and create nothing; creating the record every money flow
#:     resolves against is a different kind of act, and folding it into the
#:     reporting allowlist would mean leaking the ability to email a report also
#:     granted the ability to bring partners into existence.
#:
#: **What a leak of this one costs.** The worst it can do is create empty,
#: `pending`, inactive records — and only for ids that already name a real
#: Firestore `agencies` or `sellers` document, because `ensure_partner_record`
#: refuses anything else. It cannot approve (that is `require_write`), cannot
#: load inventory (a signed card), cannot accrue, cannot pay. A record it
#: creates holds zero coins, zero credit, zero commission and zero cash, and
#: creating one twice is a no-op. The realistic damage is queue noise that a
#: reviewer rejects.
PARTNER_REGISTRATION = ServiceCredential(
    id="partner-registration",
    settings_attr="service_key_partner_registration",
    env_var="SERVICE_KEY_PARTNER_REGISTRATION",
    actor={
        "uid": "system:partner-registration",
        "email": "",
        "name": "Partner registration (automated)",
        "role": SYSTEM_ROLE,
        "team": None,
        "service_credential": "partner-registration",
    },
    operations=frozenset({Op.PARTNER_REGISTER, Op.PARTNER_APPLY, Op.RECHARGE_REQUEST}),
)

SERVICE_CREDENTIALS: tuple[ServiceCredential, ...] = (
    WEEKLY_ACCRUAL,
    REPORTING,
    PARTNER_REGISTRATION,
)


# Three credentials, and no operation in two of them. A credential that can do
# everything is not a credential — checked here rather than left to review,
# because the failure mode is silent: adding an operation to the wrong tuple
# would widen a key with nothing to notice it.
def _assert_disjoint() -> None:
    seen: dict[str, str] = {}
    for credential in SERVICE_CREDENTIALS:
        for operation in credential.operations:
            if operation in seen:
                raise RuntimeError(
                    f"Operation {operation!r} is granted to both "
                    f"{seen[operation]!r} and {credential.id!r}. Service "
                    "credentials are separated by what they may do; an "
                    "operation held by two of them separates nothing."
                )
            if operation not in KNOWN_OPERATIONS:
                raise RuntimeError(
                    f"{credential.id!r} grants {operation!r}, which is not in "
                    "KNOWN_OPERATIONS and therefore cannot be checked."
                )
            seen[operation] = credential.id


_assert_disjoint()


def _configured_key(credential: ServiceCredential) -> str:
    return str(getattr(settings, credential.settings_attr, "") or "")


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def verify_service_key(supplied: str, operation: str) -> dict:
    """Resolve a presented service key to its system actor, or refuse.

    `operation` is the thing the caller is about to do. A valid key for the
    wrong operation is refused as firmly as an invalid key — that is the point
    of the allowlist.

    Returns a **copy** of the actor, so a caller mutating what it gets back
    cannot edit the credential for every later request.
    """
    if operation not in KNOWN_OPERATIONS:
        # A caller asking about an operation nobody declared is a programming
        # error, and the safe answer to an unknown question is "no".
        log.error(
            "Service credential asked about unknown operation %r — refused.",
            operation,
        )
        raise AuthError("Service credential is not recognised.")

    presented = _digest(supplied or "")
    matched: ServiceCredential | None = None

    for credential in SERVICE_CREDENTIALS:
        configured = _configured_key(credential)
        if len(configured) < MIN_SERVICE_KEY_CHARS:
            if configured:
                log.error(
                    "%s is set but is shorter than %d characters, so it is "
                    "treated as unset and every call using it is refused.",
                    credential.env_var,
                    MIN_SERVICE_KEY_CHARS,
                )
            # Burn an equivalent comparison so an unconfigured deployment and a
            # wrong key are indistinguishable from the outside.
            hmac.compare_digest(presented, _digest(secrets.token_urlsafe(48)))
            continue
        # No `break`: every credential is compared on every call, so the number
        # of comparisons does not depend on which one matched.
        if hmac.compare_digest(presented, _digest(configured)):
            matched = credential

    if matched is None:
        # Deliberately says nothing about which credential, whether any key is
        # configured, or how the presented value differed.
        log.warning("A service key was presented and was not recognised.")
        raise AuthError("Service credential is not recognised.")

    if not matched.may(operation):
        # A *valid* key reaching for something outside its allowlist is the
        # signature of a leaked key being explored. It is an error, not a
        # warning, and it names the credential and the operation — never the key.
        log.error(
            "Service credential %r presented a valid key for %r, which is not "
            "in its allowlist %s. Refused.",
            matched.id,
            operation,
            sorted(matched.operations),
        )
        raise AuthError(
            "This credential is not permitted to perform that operation."
        )

    return dict(matched.actor)


def is_service_actor(actor: Mapping[str, object] | None) -> bool:
    """Was this actor resolved from a service key rather than a session?"""
    if not actor:
        return False
    return str(actor.get("role", "")) == SYSTEM_ROLE
