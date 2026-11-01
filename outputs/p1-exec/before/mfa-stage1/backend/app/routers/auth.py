"""Sign-in endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core import audit
from app.core.deps import current_user, require_owner_provisioner
from app.core.roles import Role, capability_profile
from app.core.security import (
    AuthError,
    DirectoryUnavailable,
    issue_session,
    renew_at,
    renew_session,
    request_observer_code,
    revoke_session,
    sign_in_with_firebase,
    verify_observer_code,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


class FirebaseSignIn(BaseModel):
    id_token: str = Field(min_length=10)


class ObserverCodeVerify(BaseModel):
    code: str = Field(min_length=4, max_length=10)


class SessionRefresh(BaseModel):
    """The session being replaced. It is the credential, so nothing else is
    needed and nothing else is read — see `POST /auth/refresh`."""

    token: str = Field(min_length=10)


class SessionResponse(BaseModel):
    token: str
    expires_at: str
    #: When the client should renew, from `settings.session_renew_before_minutes`.
    #: Served rather than assumed so shortening a session is one environment
    #: variable and not a redeploy of the browser bundle.
    #:
    #: Equal to `expires_at` for a session that cannot be renewed — the
    #: observer's — which is how the browser is told not to try.
    renew_at: str
    user: dict


def session_response(token: str, expires, profile: dict) -> SessionResponse:
    """The one shape every session endpoint answers with.

    Built here rather than three times, because `renew_at` depends on the role
    and a caller that forgot to pass it would hand the observer a renewal
    schedule they cannot keep.
    """
    return SessionResponse(
        token=token,
        expires_at=expires.isoformat(),
        renew_at=renew_at(expires, Role(profile["role"])).isoformat(),
        user=profile,
    )


@router.post("/signin", response_model=SessionResponse)
async def signin(body: FirebaseSignIn, request: Request):
    """Staff, owners and partners. The client authenticates with Firebase and
    sends the resulting ID token."""
    try:
        token, expires, profile = await sign_in_with_firebase(body.id_token)
    except DirectoryUnavailable as exc:
        # NOT a failed login, and deliberately not recorded as one.
        #
        # The credential was never judged — the directory that holds the answer
        # could not be read. Recording this as LOGIN_FAILED would put a row
        # against an innocent person's name for every retry, and the failed-login
        # alert would fire at the owners about an attack that is really an
        # outage. 503 says it is ours, and a monitor watching 5xx will see it.
        log.error("Sign-in could not be completed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except AuthError as exc:
        await audit.record(
            actor={"uid": "", "name": "", "role": ""},
            action=audit.Action.LOGIN_FAILED,
            subject_type="auth",
            subject_id="firebase",
            reason=str(exc),
            meta={"ip": request.client.host if request.client else None},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    await audit.record(
        actor=profile,
        action=audit.Action.LOGIN_SUCCEEDED,
        subject_type="auth",
        subject_id=profile["uid"],
        reason="Signed in",
        meta={"method": "firebase", "ip": request.client.host if request.client else None},
    )
    return session_response(token, expires, await _with_mfa(profile))


@router.post("/refresh", response_model=SessionResponse)
async def refresh(body: SessionRefresh, request: Request):
    """Replace a session with a fresh one, without asking anybody anything.

    This is what stops the CRM throwing people back to the login page. The
    browser calls it when a session is within a day of expiring, when a tab
    comes back to the foreground, and once when a call is refused with a 401 —
    and everything it does is invisible unless it fails.

    ── Why it takes no session dependency ───────────────────────────────────
    There is no `Depends(current_user)` here on purpose, and it is not a gap:
    the body carries a token signed with the API's own secret, and
    `renew_session` verifies that signature, the issuer, the expiry window, the
    revocation record and the account behind it before it issues anything. A
    caller with no valid token gets a 401 from the same code that would have
    produced it a layer higher up.

    Two things follow from it, and both are wanted:

      * `current_user` refuses an external session on any route not named in
        `PARTNER_REACHABLE`. An agency and a coin seller need to renew exactly
        as staff do — the owner's complaint names "seller or agency details" —
        and this way they renew through the identical path rather than through
        an exception carved into the partner allowlist.
      * A session that has *already* expired can be presented. That is the
        whole of the grace window; a dependency that verifies expiry first
        would refuse the very case renewal exists for.

    Every refusal is a 401 with the reason on it, and the CRM's response to one
    is to ask for a password. It never retries a refusal.
    """
    ip = request.client.host if request.client else None
    try:
        token, expires, profile = await renew_session(body.token)
    except AuthError as exc:
        # Recorded, because a refused renewal is the interesting one: it is a
        # deactivated account still holding a token, a revoked session being
        # presented again, or somebody returning after a long absence. The
        # successful ones are recorded below for the same reason a sign-in is.
        await audit.record(
            actor={"uid": "", "name": "", "role": ""},
            action=audit.Action.LOGIN_FAILED,
            subject_type="auth",
            subject_id="refresh",
            reason=str(exc),
            meta={"method": "refresh", "ip": ip},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    # A week-long credential that renews itself needs a trail, and this is it:
    # every renewal is one audit entry naming who, when and from where, so a
    # session quietly living on somebody else's machine is visible on /audit
    # rather than being indistinguishable from the holder's own use.
    await audit.record(
        actor=profile,
        action=audit.Action.LOGIN_SUCCEEDED,
        subject_type="auth",
        subject_id=profile["uid"],
        reason="Session renewed",
        meta={"method": "refresh", "ip": ip},
    )
    return session_response(token, expires, await _with_mfa(profile, token))


@router.post("/observer/request-code")
async def observer_request_code(request: Request):
    """Start observer sign-in.

    Generates a one-time code and emails it to the delivery mailbox — which is
    deliberately not the observer's own address, so holding the account is not
    enough to sign in. The code is never returned in the response.
    """
    try:
        result = await request_observer_code(
            requested_by_ip=request.client.host if request.client else None
        )
    except AuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc

    return {
        "message": "A sign-in code has been sent.",
        "sent_to": result["sent_to"],
        "expires_in_minutes": result["expires_in_minutes"],
    }


@router.post("/observer/verify-code", response_model=SessionResponse)
async def observer_verify_code(body: ObserverCodeVerify, request: Request):
    try:
        token, expires, profile = await verify_observer_code(body.code)
    except AuthError as exc:
        await audit.record(
            actor={"uid": "", "name": "Observer", "role": "observer"},
            action=audit.Action.LOGIN_FAILED,
            subject_type="auth",
            subject_id="observer",
            reason=str(exc),
            meta={"ip": request.client.host if request.client else None},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    await audit.record(
        actor=profile,
        action=audit.Action.LOGIN_SUCCEEDED,
        subject_type="auth",
        subject_id=profile["uid"],
        reason="Observer signed in",
        meta={"method": "otp", "ip": request.client.host if request.client else None},
    )
    # The observer's session is `observer_session_ttl_minutes` — twelve hours,
    # unchanged — and `renew_session` refuses to renew it, so `renew_at` here
    # is the moment their browser will discover that and offer a new code.
    return session_response(token, expires, profile)


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    """Who this session is, and what the server's own tables say it may do.

    The five identity keys are unchanged. The capability keys (mobile parity)
    let the Android app offer only the screens this session can use; they are
    computed from `roles.PERMISSIONS` and the session itself, grant nothing, and
    every route keeps its own check.
    """
    return {
        "uid": user["uid"],
        "email": user["email"],
        "name": user["name"],
        "role": str(user["role"]),
        "team": user["team"],
        # P1-A3: present on an Owner session only.
        **({"mfa_verified": bool(user.get("mfa_verified"))} if user["role"] == Role.OWNER else {}),
        **capability_profile(
            user["role"], user.get("partner_ids"), user.get("partner_status")
        ),
    }


@router.post("/signout")
async def signout(request: Request, user: dict = Depends(current_user)):
    """Give up this session.

    Revokes the caller's own `jti` and nothing else: signing out of one browser
    does not sign the person out of another, which is what they expect and what
    every other product does.

    ── Why there is an audit entry now ──────────────────────────────────────
    #
    There was none. A deliberate sign-out and a session that simply stopped
    being used were indistinguishable in the log, so "when did they last have
    access" could not be answered for any account — including an owner's — and a
    revocation had no record of having been asked for.

    The entry names the actor, because by this point they are authenticated, and
    carries no token: `jti` is a credential and is reduced to a short
    fingerprint so two entries can be told apart without either being replayable.
    """
    jti = str(user.get("jti", "") or "")
    if jti:
        await revoke_session(jti)

    await audit.record(
        actor=user,
        action=audit.Action.SESSION_ENDED,
        subject_type="auth",
        subject_id=str(user.get("uid", "") or ""),
        reason="Signed out",
        meta={
            "method": "signout",
            "session": jti[:8],
            "ip": request.client.host if request.client else None,
        },
    )
    return {"message": "Signed out"}


# ══════════════════════════════════════════════════════════════════════════════
# Owner two-step sign-in (P1-A3)
# ══════════════════════════════════════════════════════════════════════════════
#
# An Owner's session from `/signin` carries `mfa=False`, and `deps.current_user`
# refuses it on every route except the ones below (plus `me` and `signout`).
# `/mfa/verify` and `/mfa/enrol/confirm` answer with a NEW session carrying
# `mfa=True`; the pending one is revoked in the same step.


class MfaCode(BaseModel):
    code: str = Field(default="", max_length=12)


class MfaVerify(BaseModel):
    code: str = Field(default="", max_length=12)
    recovery_code: str = Field(default="", max_length=20)


class MfaReset(BaseModel):
    reason: str = Field(min_length=10, max_length=1000)


async def _with_mfa(profile: dict, token: str | None = None) -> dict:
    """Tell the CRM where an Owner stands, so it can show the right step."""
    if str(profile.get("role")) != str(Role.OWNER):
        return profile
    from app.services import owner_mfa

    verified = False
    if token:
        try:
            from app.core.security import verify_session

            verified = bool((await verify_session(token)).get("mfa_verified"))
        except AuthError:
            verified = False
    try:
        st = await owner_mfa.status({**profile, "mfa_verified": verified})
    except Exception:  # noqa: BLE001
        # Advisory only — `deps.current_user` enforces MFA whatever this says,
        # so a failed status read must not fail a sign-in or a renewal. The
        # CRM calls `/auth/mfa/status` again before showing the step.
        log.exception("could not read the MFA status of %s", profile.get("uid"))
        st = {"required": True, "enrolled": None, "verified": verified}
    return {**profile, "mfa": st}


def _mfa_fail(exc) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


async def _upgraded_session(user: dict) -> SessionResponse:
    """Swap the pending Owner session for one that passed MFA."""
    old = str(user.get("jti") or "")
    if old:
        await revoke_session(old)
    token, expires = await issue_session(
        uid=user["uid"], email=user.get("email", ""), name=user.get("name", ""),
        role=Role.OWNER, renewed_from=old or None, mfa_verified=True,
    )
    profile = {"uid": user["uid"], "email": user.get("email", ""), "name": user.get("name", ""),
               "role": str(Role.OWNER), "team": None}
    return session_response(token, expires, await _with_mfa(profile, token))


@router.get("/mfa/status")
async def mfa_status(user: dict = Depends(current_user)):
    from app.services import owner_mfa

    try:
        return await owner_mfa.status(user)
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc


@router.post("/mfa/enrol/start")
async def mfa_enrol_start(user: dict = Depends(current_user)):
    """A new authenticator secret for the Owner to scan. Shown once."""
    from app.services import owner_mfa

    try:
        return await owner_mfa.start_enrolment(user)
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc


@router.post("/mfa/enrol/confirm")
async def mfa_enrol_confirm(body: MfaCode, user: dict = Depends(current_user)):
    """First code from the app → recovery codes (shown once) and a full session."""
    from app.services import owner_mfa

    try:
        codes = await owner_mfa.confirm_enrolment(user, body.code)
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc
    session = await _upgraded_session(user)
    return {"recovery_codes": codes, "session": session.model_dump()}


@router.post("/mfa/verify", response_model=SessionResponse)
async def mfa_verify(body: MfaVerify, user: dict = Depends(current_user)):
    from app.services import owner_mfa

    if not body.code and not body.recovery_code:
        raise HTTPException(status_code=400, detail="Enter the code from your authenticator app.")
    try:
        await owner_mfa.verify(user, code=body.code, recovery_code=body.recovery_code)
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc
    return await _upgraded_session(user)


@router.post("/mfa/recovery-codes")
async def mfa_new_recovery_codes(body: MfaCode, user: dict = Depends(current_user)):
    """Replace the recovery codes. Needs a verified session and a fresh code
    (this route is NOT open to a pending session — `deps` refuses it)."""
    from app.services import owner_mfa

    try:
        return {"recovery_codes": await owner_mfa.regenerate_recovery_codes(user, body.code)}
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc


@router.post("/mfa/owners/{owner_uid}/reset")
async def mfa_reset_owner(owner_uid: str, body: MfaReset, user: dict = Depends(require_owner_provisioner)):
    """Observer only: remove an Owner's authenticator (lost phone). Every
    session of that Owner ends; they set MFA up again on next sign-in."""
    from app.services import owner_mfa

    try:
        return await owner_mfa.reset_by_observer(user, owner_uid, body.reason)
    except owner_mfa.MfaError as exc:
        raise _mfa_fail(exc) from exc
