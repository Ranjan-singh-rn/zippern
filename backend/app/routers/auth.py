"""Sign-in endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core import audit
from app.core.deps import current_user, own_session_uid, require_owner_provisioner
from app.core.roles import Role, capability_profile
from app.core.security import (
    SESSION_CLIENTS,
    AuthError,
    DirectoryUnavailable,
    ObserverCodeProofFailed,
    ObserverCodeRateLimited,
    ObserverDenied,
    issue_session,
    list_sessions,
    renew_at,
    renew_session,
    request_observer_code,
    revoke_session,
    revoke_sessions_for_uid,
    sign_in_with_firebase,
    verify_observer_code,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_address(request: Request | None) -> str | None:
    """The caller's address, for the session record and the code rate limit.

    BEST EFFORT, and the same reading `routers/public_appeals.py` uses: the
    left-most `X-Forwarded-For` entry is whatever the caller sent first, so a
    forged header buys a fresh per-address budget — which is why the GLOBAL
    code-request limit is the binding one. Never the connecting peer alone:
    on Cloud Run that is Google's proxy, shared by everyone.
    """
    if request is None:
        return None
    headers = getattr(request, "headers", None) or {}
    forwarded = str(headers.get("x-forwarded-for", "") or "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64] or None
    client = getattr(request, "client", None)
    host = getattr(client, "host", None) if client is not None else None
    return str(host)[:64] if host else None


def _user_agent(request: Request | None) -> str:
    headers = getattr(request, "headers", None) or {}
    return str(headers.get("user-agent", "") or "")


def _session_client(value: str) -> str:
    """`crm` or `android`, read off the body; anything else is the CRM."""
    value = str(value or "").strip().lower()
    return value if value in SESSION_CLIENTS else "crm"


class FirebaseSignIn(BaseModel):
    id_token: str = Field(min_length=10)
    #: B3 — which client this session is for (`crm` | `android`). Recorded on
    #: the session (for `GET /auth/sessions`) and used by the Owner MFA binding;
    #: it grants nothing.
    client: str = Field(default="crm", max_length=16)


class ObserverCodeRequest(BaseModel):
    """B-4: proof of a code the requester already holds, to replace it at once.
    Optional; an empty body is the ordinary request."""

    previous_code: str = Field(default="", max_length=10)


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
    sends the resulting ID token.

    An Owner's session comes back PENDING (`user.mfa.verified == false`) on
    the CRM and on Android alike; the client then runs the `/mfa/*` steps
    below. The Observer is refused here by name (`observer_denied`) — it has
    no Android access at all and signs in only at `/observer/*`.
    """
    ip = _client_address(request)
    client = _session_client(body.client)
    try:
        token, expires, profile = await sign_in_with_firebase(
            body.id_token, client=client, ip=ip, user_agent=_user_agent(request))
    except ObserverDenied as exc:
        # B3 / spec §8: audited by name so an attempt to reach the Observer
        # through Google-on-Android (or any provider) is visible on /audit.
        await audit.record(
            actor={"uid": "", "name": "", "role": ""},
            action=audit.Action.AUTH_OBSERVER_DENIED,
            subject_type="auth",
            subject_id="observer",
            reason=str(exc),
            meta={"ip": ip, "client": client},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": ObserverDenied.code, "message": str(exc)},
        ) from exc
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
            meta={"ip": ip, "client": client},
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
        meta={"method": "firebase", "ip": ip, "client": client},
    )
    return session_response(token, expires, await _with_mfa(profile, token))


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
    ip = _client_address(request)
    try:
        token, expires, profile = await renew_session(body.token, ip=ip)
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
async def observer_request_code(request: Request, body: ObserverCodeRequest | None = None):
    """Start observer sign-in.

    Generates a one-time code and emails it to the delivery mailbox — which is
    deliberately not the observer's own address, so holding the account is not
    enough to sign in. The code is never returned in the response.

    B-4: a request no longer voids the codes already out there (every live one
    stays valid for its TTL), the caller may prove the previous code to replace
    it at once, and requests are limited per address and globally — see
    `security.request_observer_code`. A limit answers 429; a wrong proof 401.
    """
    previous = str(getattr(body, "previous_code", "") or "") if body is not None else ""
    try:
        result = await request_observer_code(
            requested_by_ip=_client_address(request), previous_code=previous
        )
    except ObserverCodeRateLimited as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc
    except ObserverCodeProofFailed as exc:
        # A wrong `previous_code` is a failed guess, charged as one: 401.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc
    except AuthError as exc:
        # The resend cooldown — 429, as before.
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc

    return {
        "message": "A sign-in code has been sent.",
        "sent_to": result["sent_to"],
        "expires_in_minutes": result["expires_in_minutes"],
        "outstanding": result.get("outstanding", 1),
    }


@router.post("/observer/verify-code", response_model=SessionResponse)
async def observer_verify_code(body: ObserverCodeVerify, request: Request):
    """The first factor. Answers with a PENDING session (`user.mfa.verified ==
    false`): the Observer then enrols or verifies at `/mfa/*` exactly as an
    Owner does, and only the upgraded session reaches anything else."""
    ip = _client_address(request)
    try:
        token, expires, profile = await verify_observer_code(
            body.code, ip=ip, user_agent=_user_agent(request))
    except AuthError as exc:
        await audit.record(
            actor={"uid": "", "name": "Observer", "role": "observer"},
            action=audit.Action.LOGIN_FAILED,
            subject_type="auth",
            subject_id="observer",
            reason=str(exc),
            meta={"ip": ip},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    await audit.record(
        actor=profile,
        action=audit.Action.LOGIN_SUCCEEDED,
        subject_type="auth",
        subject_id=profile["uid"],
        reason="Observer passed the emailed code (first factor)",
        meta={"method": "otp", "ip": ip, "client": "crm"},
    )
    # The observer's session is `observer_session_ttl_minutes` — twelve hours,
    # unchanged — and `renew_session` refuses to renew it, so `renew_at` here
    # is the moment their browser will discover that and offer a new code.
    # B3: the `mfa` block tells the screen whether to enrol or to verify.
    return session_response(token, expires, await _with_mfa(profile, token))


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    """Who this session is, and what the server's own tables say it may do.

    The five identity keys are unchanged. The capability keys (mobile parity)
    let the Android app offer only the screens this session can use; they are
    computed from `roles.PERMISSIONS` and the session itself, grant nothing, and
    every route keeps its own check.
    """
    from app.services.owner_mfa import uses_mfa

    return {
        "uid": user["uid"],
        "email": user["email"],
        "name": user["name"],
        "role": str(user["role"]),
        "team": user["team"],
        # P1-A3 / B3: present on an Owner's or the Observer's session only.
        **({"mfa_verified": bool(user.get("mfa_verified"))} if uses_mfa(user["role"]) else {}),
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
        if user.get("role") == Role.OWNER:
            # P1-A3b: release THIS session's Firestore/Storage binding only —
            # another browser or the Android app keeps its own.
            from app.services import owner_mfa

            await owner_mfa.unbind_session(jti, actor=user)
        await revoke_session(jti, "Signed out")

    await audit.record(
        actor=user,
        action=audit.Action.SESSION_ENDED,
        subject_type="auth",
        subject_id=str(user.get("uid", "") or ""),
        reason="Signed out",
        meta={
            "method": "signout",
            "session": jti[:8],
            "ip": _client_address(request),
        },
    )
    return {"message": "Signed out"}


# ══════════════════════════════════════════════════════════════════════════════
# B3 / §13 (B-21) — the sessions a person holds, and "sign out everywhere"
# ══════════════════════════════════════════════════════════════════════════════
#
# A seven-day token that renews itself for three more days is a credential a
# person could not see and could not end from anywhere but the device it was
# on. These two routes close that: the list shows every live session of the
# caller's own uid (client, address, user agent, when), and revoke-all ends
# them. Both are self-scoped — `own_session_uid(user)`, no id in the request —
# so an agency or a seller can use them exactly as staff can, and nobody can
# name anybody else. A pending Owner/Observer session cannot reach either
# (`deps` confines it to the MFA routes).


class RevokeAllBody(BaseModel):
    #: Also end the session making the call. Off by default: "sign out
    #: everywhere ELSE" is what a person who just noticed a stray session
    #: wants, and the current device stays signed in to confirm it worked.
    include_current: bool = Field(default=False)


@router.get("/sessions")
async def my_sessions(user: dict = Depends(current_user)):
    """Every live session of the caller, newest first; the current one is
    flagged. Fingerprints only — never a token, never a full session id."""
    uid = own_session_uid(user)
    sessions = await list_sessions(uid, current_jti=str(user.get("jti") or ""))
    return {"sessions": sessions, "count": len(sessions)}


@router.post("/sessions/revoke-all")
async def revoke_all_my_sessions(
    request: Request, body: RevokeAllBody | None = None, user: dict = Depends(current_user),
):
    """Sign out everywhere (else). Every other live API session of the caller
    is revoked at once — effective on their next request — and, for an Owner,
    their Firestore/Storage MFA bindings go with them (P1-A3b). Quick login on
    the phone is NOT touched by this: a sign-out keeps it, by design (§13);
    a restriction or a security reset removes it through
    `security.revoke_sessions_for_uid(..., mobile=True)`."""
    uid = own_session_uid(user)
    include_current = bool(getattr(body, "include_current", False)) if body is not None else False
    jti = str(user.get("jti") or "")
    result = await revoke_sessions_for_uid(
        uid,
        "Signed out everywhere" + ("" if include_current else " else"),
        actor=user,
        keep_jti=None if include_current else (jti or None),
    )
    if include_current and user.get("role") == Role.OWNER and jti:
        from app.services import owner_mfa

        await owner_mfa.unbind_session(jti, actor=user)
    await audit.record(
        actor=user,
        action=audit.Action.SESSION_ENDED,
        subject_type="auth",
        subject_id=uid,
        reason="Signed out everywhere" + ("" if include_current else " else"),
        meta={"method": "revoke_all", "session": jti[:8], "revoked": result["api_sessions"],
              "ip": _client_address(request)},
    )
    return {
        "message": "Signed out everywhere." if include_current else "Signed out everywhere else.",
        "revoked": result["api_sessions"],
        "current_kept": not include_current,
        "problems": result.get("problems", []),
    }


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
    #: P1-A3b — the client's CURRENT Firebase ID token, so Firestore/Storage
    #: Owner authority can be bound to this sign-in. Optional: without it the
    #: API session is upgraded and Firestore/Storage stay locked (`firestore_binding`).
    firebase_id_token: str = Field(default="", max_length=8192)
    client: str = Field(default="crm", max_length=16)


class MfaVerify(BaseModel):
    code: str = Field(default="", max_length=12)
    recovery_code: str = Field(default="", max_length=20)
    firebase_id_token: str = Field(default="", max_length=8192)
    client: str = Field(default="crm", max_length=16)


class MfaBind(BaseModel):
    firebase_id_token: str = Field(min_length=10, max_length=8192)
    client: str = Field(default="crm", max_length=16)


class MfaBindConfirm(BaseModel):
    #: The ID token of the Firebase session that redeemed the custom token.
    firebase_id_token: str = Field(min_length=10, max_length=8192)


class MfaReset(BaseModel):
    reason: str = Field(min_length=10, max_length=1000)


async def _with_mfa(profile: dict, token: str | None = None) -> dict:
    """Tell the client where an Owner or the Observer stands, so it can show
    the right step (enrol / verify / nothing)."""
    from app.services import owner_mfa

    if not owner_mfa.uses_mfa(profile.get("role")):
        return profile

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
    # P1-A3b: a renewal reports what happened to the Firestore/Storage binding.
    carried = profile.pop("mfa_firestore_binding", None) if isinstance(profile, dict) else None
    if carried is not None:
        st = {**st, "firestore_binding": {"state": carried}}
    return {**profile, "mfa": st}


def _mfa_fail(exc) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


async def _upgraded_session(user: dict, firebase_id_token: str = "", client: str = "crm") -> SessionResponse:
    """Swap the pending Owner or Observer session for one that passed MFA,
    then — for an Owner — bind the caller's Firebase sign-in to it (P1-A3b).
    The binding result is reported in `user.mfa.firestore_binding`; a failed
    or missing binding grants nothing in Firestore or Storage, and the client
    is told so explicitly. The Observer has nothing to bind (no Firebase
    account, no `crmUsers` document): `not_applicable`.

    The new session keeps the old one's client and address: on Android the
    Owner's pending session was issued with `client: "android"` at `/signin`,
    and the upgraded one must read the same on `GET /auth/sessions`."""
    from app.core.security import _session_meta, verify_session
    from app.services import owner_mfa

    role = Role(str(user["role"]))
    old = str(user.get("jti") or "")
    meta = await _session_meta(old)
    if old:
        await revoke_session(old, "Upgraded after two-step sign-in")
    token, expires = await issue_session(
        uid=user["uid"], email=user.get("email", ""), name=user.get("name", ""),
        role=role, renewed_from=old or None, mfa_verified=True,
        client=str(meta.get("client") or _session_client(client)),
        ip=meta.get("ip"), user_agent=str(meta.get("user_agent") or ""),
    )
    new_jti = str((await verify_session(token)).get("jti") or "")
    if role == Role.OWNER:
        # Step 1 of the mfa_sid binding: a custom token for a NEW Firebase session
        # (CRM: replaces its sign-in; Android: the `ownerWork` app). The client
        # redeems it and calls /mfa/bind/confirm; until then nothing is unlocked.
        binding = await owner_mfa.mint_owner_session(
            user, firebase_id_token, api_jti=new_jti, api_expires=expires, client=client)
    else:
        binding = {"state": "not_applicable",
                   "reason": "The Observer has no Firestore or Storage access to unlock."}
    profile = {"uid": user["uid"], "email": user.get("email", ""), "name": user.get("name", ""),
               "role": str(role), "team": None}
    profile = await _with_mfa(profile, token)
    profile["mfa"] = {**profile.get("mfa", {}), "firestore_binding": binding}
    return session_response(token, expires, profile)


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
    session = await _upgraded_session(user, body.firebase_id_token, body.client)
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
    return await _upgraded_session(user, body.firebase_id_token, body.client)


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


@router.post("/mfa/bind")
async def mfa_bind(body: MfaBind, user: dict = Depends(current_user)):
    """Retry unlock: mint a fresh `mfa_sid` custom token for THIS verified
    Owner session (replacing its previous binding). The caller must present a
    current Firebase ID token of the same account. A pending session cannot
    reach this route (`deps` refuses it), so it never substitutes for MFA."""
    from app.core.security import _session_expiry
    from app.services import owner_mfa

    if user.get("role") != Role.OWNER or not user.get("mfa_verified"):
        raise HTTPException(status_code=403, detail="Finish two-step sign-in first.")
    expires = await _session_expiry(str(user.get("jti") or ""))
    return await owner_mfa.mint_owner_session(
        user, body.firebase_id_token, api_jti=str(user.get("jti") or ""), api_expires=expires,
        client=body.client)


@router.post("/mfa/bind/confirm")
async def mfa_bind_confirm(body: MfaBindConfirm, user: dict = Depends(current_user)):
    """Step 3: confirm the Firebase session that redeemed this API session's
    custom token. Only then do Firestore, Storage and the Owner callables
    accept its `mfa_sid`."""
    from app.services import owner_mfa

    if user.get("role") != Role.OWNER or not user.get("mfa_verified"):
        raise HTTPException(status_code=403, detail="Finish two-step sign-in first.")
    return await owner_mfa.confirm_owner_session(user, body.firebase_id_token)
