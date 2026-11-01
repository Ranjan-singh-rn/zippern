"""Owner multi-factor authentication — TOTP, enforced by the server (P1-A3).

Replaces the CRM's three-question "security gate". That gate ran in the
browser: the answers were stored in plain text on `crmUsers/{uid}.gateAnswers`
(readable by every member of staff under the `crmUsers` read rule) and compared
in JavaScript, so anyone holding the password could skip it with the dev tools,
and the API never knew whether it had been passed.

What this does instead
----------------------
* An Owner signs in exactly as before and is issued a session with
  `mfa=False`. `deps.current_user` allows such a session only the routes in
  `MFA_PENDING_ROUTES` — status, enrol, verify, `me`, sign-out.
* First sign-in: `start_enrolment` creates a TOTP secret (RFC 6238, SHA-1,
  6 digits, 30 s — what every authenticator app speaks), stored ENCRYPTED with
  `settings.owner_mfa_encryption_key` (Fernet). `confirm_enrolment` checks a
  code from the app, returns ten one-time recovery codes (stored only as salted
  SHA-256 hashes) and an upgraded session.
* Every later sign-in: `verify` checks a TOTP code or a recovery code and
  returns an upgraded session (`mfa=True`); the pending one is revoked.
* Replay: the last accepted time-step is stored, and a code for that step or an
  earlier one is refused. Brute force: `owner_mfa_max_failures` wrong codes in a
  row lock the factor for `owner_mfa_lock_minutes`; the lock is audited and the
  Owner is notified.
* Lost device: the Observer resets an Owner's MFA (`reset_by_observer`) with a
  reason. Every session of that Owner is revoked; the next sign-in enrols again.
  The Observer cannot read or set a secret — only remove it.

Fail closed: with no encryption key configured, enrolment is refused, so an
Owner cannot complete sign-in. That is a rollout prerequisite, not a fallback.

── B3: the Observer uses the SAME factor ─────────────────────────────────────

Spec §8: the Observer "requires authenticator-app TOTP for CRM login … No
alternate password-only bypass." The Observer has no password at all — its
first factor is the one-time code emailed to a separate mailbox
(`security.request_observer_code` / `verify_observer_code`), and that code now
buys a PENDING session (`mfa=False`) exactly as an Owner's password does. The
second factor is this module, unchanged in mechanism: the binding lives in the
same `owner_mfa` collection under the Observer's synthetic uid
(`observer:<email>` — the uid on its `staff` row, which `scripts/reset/seed.py`
writes and `crm_directory.NOT_MIRRORED` explains), sealed with the same key,
with the same recovery codes, replay guard and lockout.

Three differences, each deliberate:

  * `required_for(Role.OBSERVER)` is always True. `settings.owner_mfa_required`
    is the Owner roll-out switch and does not reach the Observer: there is no
    bypass flag for the identity that provisions Owners.
  * The Observer gets no Firestore/Storage binding (`mint_owner_session` stays
    Owner-only). It has no Firebase account and no `crmUsers` document, so
    there is nothing to bind; the upgraded session reports
    `firestore_binding: not_applicable`.
  * Nobody resets the Observer's factor through the API — there is no identity
    above it. Recovery is its ten recovery codes; losing those too is a
    deliberate operator action on the `owner_mfa` row (see the B3 report).

Nothing here ever logs, audits or returns a secret after enrolment, a code, or
a recovery code (other than the recovery codes once, to their owner).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import struct
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from app.config import settings
from app.core import audit
from app.core.roles import Role
from app.db.mongo import C, get_db

log = logging.getLogger(__name__)

DIGITS = 6
PERIOD = 30
#: ±1 step: tolerates 30 s of clock drift either way and nothing more.
WINDOW = 1
RECOVERY_CODES = 10

#: (method, route template) an Owner session WITHOUT MFA may call.
MFA_PENDING_ROUTES = frozenset({
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/signout"),
    ("GET", "/api/auth/mfa/status"),
    ("POST", "/api/auth/mfa/enrol/start"),
    ("POST", "/api/auth/mfa/enrol/confirm"),
    ("POST", "/api/auth/mfa/verify"),
})


class MfaError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(d: datetime | None) -> datetime | None:
    if d is None:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ── Encryption at rest ────────────────────────────────────────────────────────

def _fernet():
    key = (settings.owner_mfa_encryption_key or "").strip()
    if not key:
        raise MfaError(
            "Owner MFA is not configured on this server (OWNER_MFA_ENCRYPTION_KEY is not set). "
            "Ask whoever runs the deployment to set it.", 503)
    from cryptography.fernet import Fernet  # shipped with python-jose[cryptography]
    try:
        return Fernet(key.encode())
    except Exception as exc:  # noqa: BLE001 — a malformed key is a configuration error
        raise MfaError("Owner MFA is misconfigured on this server (the encryption key is invalid).", 503) from exc


def _seal(secret_b32: str) -> str:
    return _fernet().encrypt(secret_b32.encode()).decode()


def _open(token: str) -> str:
    from cryptography.fernet import InvalidToken
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        # The key was rotated without re-enrolling. Not the Owner's fault and
        # not something a retry fixes: the Observer must reset.
        raise MfaError("This account's MFA cannot be read with the current server key. "
                       "Ask the Observer to reset your MFA.", 503) from exc


# ── TOTP (RFC 6238 over RFC 4226) ─────────────────────────────────────────────

def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret_b32: str) -> bytes:
    pad = "=" * (-len(secret_b32) % 8)
    return base64.b32decode(secret_b32.upper() + pad)


def hotp(secret_b32: str, counter: int) -> str:
    digest = hmac.new(_key(secret_b32), struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def step_at(t: float | None = None) -> int:
    return int((time.time() if t is None else t) // PERIOD)


def match_step(secret_b32: str, code: str, *, at: float | None = None) -> int | None:
    """The time-step `code` is valid for (within the window), or None."""
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(code) != DIGITS:
        return None
    now = step_at(at)
    for step in range(now - WINDOW, now + WINDOW + 1):
        if hmac.compare_digest(hotp(secret_b32, step), code):
            return step
    return None


def provisioning_uri(secret_b32: str, account: str) -> str:
    issuer = settings.owner_mfa_issuer
    label = quote(f"{issuer}:{account}")
    return (f"otpauth://totp/{label}?secret={secret_b32}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={PERIOD}")


# ── Recovery codes ────────────────────────────────────────────────────────────

_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i


def _new_recovery_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def _norm_recovery(code: str) -> str:
    return "".join(ch for ch in str(code or "").lower() if ch.isalnum())


def _hash_recovery(code: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{_norm_recovery(code)}".encode()).hexdigest()


def _issue_recovery_codes() -> tuple[list[str], list[dict]]:
    codes = [_new_recovery_code() for _ in range(RECOVERY_CODES)]
    stored = []
    for c in codes:
        salt = secrets.token_hex(8)
        stored.append({"salt": salt, "hash": _hash_recovery(c, salt), "used_at": None})
    return codes, stored


# ── Records ───────────────────────────────────────────────────────────────────

#: The identities that carry a second factor. `security.issue_session` writes
#: the `mfa` claim for exactly these roles (through `uses_mfa`, read lazily so
#: the session layer does not import this module at start-up), and
#: `deps.current_user` confines a session without it to `MFA_PENDING_ROUTES`.
MFA_ROLES: frozenset[Role] = frozenset({Role.OWNER, Role.OBSERVER})

#: The prefix of the Observer's synthetic uid (`staff.uid` is `observer:<email>`).
OBSERVER_UID_PREFIX = "observer:"


def _is_owner(user: dict) -> bool:
    return str(user.get("role")) == str(Role.OWNER)


def _is_observer(user: dict) -> bool:
    return str(user.get("role")) == str(Role.OBSERVER)


def uses_mfa(role) -> bool:
    """Does this role sign in with a second factor at all?"""
    try:
        return Role(str(role)) in MFA_ROLES
    except ValueError:
        return False


def required_for(role) -> bool:
    """Is the second factor ENFORCED for this role right now?

    The Owner's answer is the roll-out switch `settings.owner_mfa_required`.
    The Observer's answer is always yes: spec §8 allows no bypass for the
    identity that provisions, suspends and deactivates Owners, so no setting
    can switch it off.
    """
    if not uses_mfa(role):
        return False
    if Role(str(role)) == Role.OBSERVER:
        return True
    return bool(settings.owner_mfa_required)


def _label(user: dict) -> str:
    """'Owner' or 'Observer' — for the notices, never for a decision."""
    return "Observer" if _is_observer(user) else "Owner"


def _require_owner(user: dict) -> None:
    """The Owner-only steps (the Firestore/Storage binding)."""
    if not _is_owner(user):
        raise MfaError("Only Owner accounts use this sign-in step.", 403)


def _require_mfa_identity(user: dict) -> None:
    """The steps shared by every identity that carries a second factor."""
    if not uses_mfa(user.get("role")):
        raise MfaError("Only Owner and Observer accounts use this sign-in step.", 403)


async def _record(uid: str) -> dict | None:
    return await get_db()[C.OWNER_MFA].find_one({"uid": uid})


async def status(user: dict) -> dict:
    """What the sign-in screen needs to know. Never a secret."""
    _require_mfa_identity(user)
    rec = await _record(str(user["uid"]))
    enrolled = bool(rec and rec.get("enrolled_at"))
    locked_until = _aware((rec or {}).get("locked_until"))
    locked = bool(locked_until and locked_until > _now())
    return {
        "required": required_for(user.get("role")),
        "enrolled": enrolled,
        "verified": bool(user.get("mfa_verified")),
        "configured": bool((settings.owner_mfa_encryption_key or "").strip()),
        "locked_until": locked_until.isoformat() if locked else None,
        "recovery_codes_left": sum(1 for c in (rec or {}).get("recovery", []) if not c.get("used_at")) if enrolled else 0,
        #: B3 — which identity this factor belongs to, so one client screen
        #: serves both. The Observer has no Firestore binding step.
        "identity": str(user.get("role")),
        "firestore_binding_applies": _is_owner(user),
    }


async def start_enrolment(user: dict) -> dict:
    """Create (or replace) a PENDING secret. Refused once enrolled — only the
    Observer can remove an enrolled factor, so a stolen password cannot swap
    the Owner's authenticator for the thief's.

    For the Observer the pending session that reaches here has ALREADY passed
    the emailed code (`verify_observer_code` is the only way to an Observer
    session), which is the "enrol only from a session that passed the first
    factor" rule — the same shape as an Owner enrolling behind its password."""
    _require_mfa_identity(user)
    uid = str(user["uid"])
    rec = await _record(uid)
    if rec and rec.get("enrolled_at"):
        raise MfaError("MFA is already set up for this account. If you lost your authenticator, "
                       + ("use a recovery code." if _is_observer(user)
                          else "use a recovery code or ask the Observer to reset it."), 409)
    secret = new_secret()
    sealed = _seal(secret)  # raises 503 when not configured — before anything is written
    expires = _now() + timedelta(minutes=settings.owner_mfa_enrol_minutes)
    await get_db()[C.OWNER_MFA].update_one(
        {"uid": uid},
        {"$set": {"uid": uid, "pending_secret": sealed, "pending_expires_at": expires,
                  "identity": str(user.get("role")), "updated_at": _now()},
         "$setOnInsert": {"created_at": _now(), "failures": 0}},
        upsert=True,
    )
    account = str(user.get("email") or uid)
    return {
        # Returned once, to the Owner, so their authenticator can be set up.
        "secret": secret,
        "otpauth_uri": provisioning_uri(secret, account),
        "expires_at": expires.isoformat(),
        "digits": DIGITS,
        "period": PERIOD,
    }


async def _locked(rec: dict) -> None:
    until = _aware(rec.get("locked_until"))
    if until and until > _now():
        raise MfaError(f"Too many wrong codes. Try again after {until.strftime('%H:%M UTC')}.", 429)


async def _fail(user: dict, rec: dict, why: str) -> None:
    """Count a wrong code, lock on the threshold, audit, then raise."""
    db = get_db()
    failures = int(rec.get("failures") or 0) + 1
    patch: dict = {"failures": failures, "last_failure_at": _now()}
    locked = failures >= int(settings.owner_mfa_max_failures)
    if locked:
        patch["locked_until"] = _now() + timedelta(minutes=settings.owner_mfa_lock_minutes)
        patch["failures"] = 0
    await db[C.OWNER_MFA].update_one({"uid": rec["uid"]}, {"$set": patch})
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_FAILED, subject_type="auth.mfa",
                       subject_id=str(rec["uid"]), reason=why,
                       meta={"failures": failures, "identity": str(user.get("role"))})
    if locked:
        await audit.record(actor=user, action=audit.Action.OWNER_MFA_LOCKED, subject_type="auth.mfa",
                           subject_id=str(rec["uid"]),
                           reason=f"{settings.owner_mfa_max_failures} wrong codes in a row",
                           meta={"minutes": settings.owner_mfa_lock_minutes, "identity": str(user.get("role"))})
        if _is_observer(user):
            advice = ("If this was not you, somebody holds a sign-in code from the delivery mailbox: "
                      "check who can read it, and tell the Owners.")
        else:
            advice = "If this was not you, change your password and tell the Observer."
        await _notify(str(rec["uid"]), "locked", f"mfa_locked_{rec['uid']}_{int(time.time())}",
                      "Your Zipper CRM sign-in was locked",
                      f"Several wrong verification codes were entered for your {_label(user)} account. "
                      f"Sign-in is paused for {settings.owner_mfa_lock_minutes} minutes. " + advice)
        raise MfaError("Too many wrong codes. Sign-in is paused for a few minutes.", 429)
    raise MfaError("That code is not right. Check the time on your phone and try again.", 401)


async def confirm_enrolment(user: dict, code: str) -> list[str]:
    """Check the first code from the authenticator; return the recovery codes."""
    _require_mfa_identity(user)
    uid = str(user["uid"])
    rec = await _record(uid)
    if not rec or not rec.get("pending_secret"):
        raise MfaError("Start the set-up first.", 409)
    if rec.get("enrolled_at"):
        raise MfaError("MFA is already set up for this account.", 409)
    await _locked(rec)
    if (_aware(rec.get("pending_expires_at")) or _now()) <= _now():
        raise MfaError("The set-up expired. Start again.", 410)
    secret = _open(rec["pending_secret"])
    step = match_step(secret, code)
    if step is None:
        await _fail(user, rec, "Wrong code while setting up MFA")
    codes, stored = _issue_recovery_codes()
    result = await get_db()[C.OWNER_MFA].update_one(
        # Compare-and-set: two tabs confirming at once enrol once.
        {"uid": uid, "enrolled_at": None, "pending_secret": rec["pending_secret"]},
        {"$set": {"secret": rec["pending_secret"], "enrolled_at": _now(), "last_step": step,
                  "recovery": stored, "failures": 0, "locked_until": None, "updated_at": _now()},
         "$unset": {"pending_secret": "", "pending_expires_at": ""}},
    )
    if getattr(result, "matched_count", 1) == 0:
        raise MfaError("MFA was set up from another window. Sign in again.", 409)
    label = _label(user)
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_ENROLLED, subject_type="auth.mfa",
                       subject_id=uid, reason=f"{label} set up an authenticator app",
                       meta={"recovery_codes": RECOVERY_CODES, "identity": str(user.get("role"))})
    await _notify(uid, "enrolled", f"mfa_enrolled_{uid}_{step}",
                  f"Two-step sign-in is on for your {label} account",
                  f"An authenticator app was set up for your Zipper CRM {label} account. "
                  + ("If this was not you, somebody holds a sign-in code from the delivery mailbox: "
                     "check who can read it, and tell the Owners immediately."
                     if _is_observer(user) else "If this was not you, tell the Observer immediately."))
    return codes


async def verify(user: dict, *, code: str = "", recovery_code: str = "") -> dict:
    """Check a TOTP code or a recovery code. Returns `{"method": ...}`."""
    _require_mfa_identity(user)
    uid = str(user["uid"])
    rec = await _record(uid)
    if not rec or not rec.get("enrolled_at"):
        raise MfaError("MFA is not set up for this account yet.", 409)
    await _locked(rec)
    db = get_db()

    if recovery_code:
        target = _norm_recovery(recovery_code)
        for i, c in enumerate(rec.get("recovery") or []):
            if c.get("used_at"):
                continue
            if hmac.compare_digest(c.get("hash", ""), _hash_recovery(target, c.get("salt", ""))):
                result = await db[C.OWNER_MFA].update_one(
                    {"uid": uid, f"recovery.{i}.used_at": None},
                    {"$set": {f"recovery.{i}.used_at": _now(), "failures": 0, "updated_at": _now()}},
                )
                if getattr(result, "matched_count", 1) == 0:
                    break  # used concurrently — treat as wrong
                left = sum(1 for x in rec["recovery"] if not x.get("used_at")) - 1
                label = _label(user)
                await audit.record(actor=user, action=audit.Action.OWNER_MFA_RECOVERY_USED,
                                   subject_type="auth.mfa", subject_id=uid,
                                   reason=f"{label} signed in with a recovery code",
                                   meta={"left": left, "identity": str(user.get("role"))})
                await _notify(uid, "recovery", f"mfa_recovery_{uid}_{i}",
                              f"A recovery code was used on your {label} account",
                              f"Someone signed in to your Zipper CRM {label} account with a recovery code. "
                              f"{left} codes are left. If this was not you, "
                              + ("tell the Owners immediately." if _is_observer(user)
                                 else "tell the Observer immediately."))
                return {"method": "recovery_code", "recovery_codes_left": left}
        await _fail(user, rec, "Wrong recovery code")

    secret = _open(rec["secret"])
    step = match_step(secret, code)
    if step is None:
        await _fail(user, rec, "Wrong verification code")
    if step <= int(rec.get("last_step") or -1):
        # The same code twice (or an older one) — a replay, not a sign-in.
        await _fail(user, rec, "A verification code was reused")
    result = await db[C.OWNER_MFA].update_one(
        {"uid": uid, "last_step": rec.get("last_step")},
        {"$set": {"last_step": step, "failures": 0, "last_verified_at": _now(), "updated_at": _now()}},
    )
    if getattr(result, "matched_count", 1) == 0:
        await _fail(user, rec, "A verification code was reused")
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_VERIFIED, subject_type="auth.mfa",
                       subject_id=uid, reason=f"{_label(user)} passed two-step sign-in",
                       meta={"method": "totp", "identity": str(user.get("role"))})
    return {"method": "totp"}


async def regenerate_recovery_codes(user: dict, code: str) -> list[str]:
    """New recovery codes; the old ones stop working. Needs a verified session
    AND a fresh authenticator code, so a session left open is not enough."""
    _require_mfa_identity(user)
    if not user.get("mfa_verified"):
        raise MfaError("Finish two-step sign-in first.", 403)
    await verify(user, code=code)
    codes, stored = _issue_recovery_codes()
    uid = str(user["uid"])
    await get_db()[C.OWNER_MFA].update_one({"uid": uid}, {"$set": {"recovery": stored, "updated_at": _now()}})
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_CODES_REGENERATED, subject_type="auth.mfa",
                       subject_id=uid, reason=f"{_label(user)} replaced their recovery codes",
                       meta={"identity": str(user.get("role"))})
    return codes


async def reset_by_observer(observer: dict, owner_uid: str, reason: str) -> dict:
    """Remove an Owner's factor (lost phone). Observer only — checked by the
    route's dependency AND here. Revokes every session of that Owner."""
    if str(observer.get("role")) != str(Role.OBSERVER):
        raise MfaError("Only the Observer resets an Owner's MFA.", 403)
    reason = (reason or "").strip()
    if len(reason) < 10:
        raise MfaError("Say why (at least 10 characters). It is kept in the audit log.")
    db = get_db()
    owner = await db[C.STAFF].find_one({"uid": owner_uid})
    if not owner or str(owner.get("role")) != str(Role.OWNER):
        raise MfaError("No Owner with that id.", 404)
    rec = await _record(owner_uid)
    had = bool(rec and rec.get("enrolled_at"))
    await db[C.OWNER_MFA].delete_one({"uid": owner_uid})
    # B3 (§13 "security reset"): every API session of the Owner, their
    # Firestore/Storage bindings (P1-A3b, effective on the next request) and
    # their mobile credentials — the Firebase refresh tokens and the quick-login
    # credentials — through the one helper every revocation path shares.
    from app.core.security import revoke_sessions_for_uid

    revoked = await revoke_sessions_for_uid(
        owner_uid, "Observer reset the Owner's MFA", actor=observer, mobile=True)
    bindings_cleared = bool(revoked.get("mfa_bindings_cleared"))
    audit_id = await audit.record(
        actor=observer, action=audit.Action.OWNER_MFA_RESET, subject_type="auth.mfa",
        subject_id=owner_uid, reason=reason,
        before={"enrolled": had},
        after={"enrolled": False, "sessions": "revoked", "api_sessions": revoked.get("api_sessions"),
               "problems": revoked.get("problems") or []},
    )
    notified = await _notify(owner_uid, "reset", f"mfa_reset_{owner_uid}_{audit_id}",
                             "Your two-step sign-in was reset",
                             "The Observer reset the authenticator on your Zipper CRM Owner account and "
                             "signed you out everywhere. Next time you sign in you will set it up again. "
                             "If you did not ask for this, contact the Observer.",
                             email_to=owner)
    return {"uid": owner_uid, "was_enrolled": had, "sessions_revoked": True, "notified": notified,
            "firestore_bindings_cleared": bindings_cleared,
            "audit_id": str(audit_id)}


async def _notify(uid: str, kind: str, key: str, title: str, body: str, *, email_to: dict | None = None) -> bool:
    """In-app notice (and email when the staff row is given). Never raises.

    The Observer has no app account (its uid is synthetic), so it gets the
    email only — an in-app notice would be a document nobody can read."""
    ok = False
    if not uid.startswith(OBSERVER_UID_PREFIX):
        try:
            from app.services import notices
            ok = bool(await notices.deliver(uid, key, type="security", title=title, body=body,
                                            meta={"kind": f"owner_mfa.{kind}"}))
        except Exception:  # noqa: BLE001
            log.exception("could not deliver the MFA %s notice", kind)
    if email_to is None:
        try:
            email_to = await get_db()[C.STAFF].find_one({"uid": uid})
        except Exception:  # noqa: BLE001
            email_to = None
    if email_to and email_to.get("email"):
        try:
            from app.services import email as email_service
            await email_service.deliver(
                kind=f"owner_mfa.{kind}",
                spec="P1-A3",
                recipient=email_service.Recipient(
                    email=str(email_to["email"]), name=str(email_to.get("name", "")),
                    role=str(email_to.get("role", "")), uid=uid),
                subject=title,
                html=email_service.page(title=title, preheader=body,
                                        body=f'<p style="line-height:1.6">{email_service.esc(body)}</p>'),
                sensitivity=email_service.Sensitivity.OPERATIONAL,
                dedupe_key=key,
                meta={"kind": kind},
            )
            if uid.startswith(OBSERVER_UID_PREFIX):
                ok = True  # the email IS the Observer's notice
        except Exception:  # noqa: BLE001
            log.exception("could not email the MFA %s notice", kind)
    return ok


# ══════════════════════════════════════════════════════════════════════════════
# P1-A3b — per-session `mfa_sid`: the Owner MFA boundary for Firestore,
# Storage and privileged Cloud Functions
# ══════════════════════════════════════════════════════════════════════════════
#
# Firestore/Storage/Functions cannot see the API session — they see a Firebase
# ID token, and a Firebase ID token carries no per-session id. So after an
# Owner passes MFA the server issues ONE:
#
#   1. MINT (verify / enrol-confirm / retry): validate the caller's current
#      Firebase ID token (signature + revocation, uid = API session uid), the
#      MFA-verified API session and the active Owner row; create
#        ownerMfaSessions/{uid}.bindings.<sid> = {state: "minted", apiJti,
#          client, issuedFromAuthTime, expiresAt, createdAt}
#      with a random 128-bit `sid`, and a Firebase CUSTOM TOKEN carrying the
#      developer claim `mfa_sid = sid`. Developer claims live only in the ID
#      tokens of the Firebase session that redeems that custom token.
#   2. The client signs in with the custom token (CRM: its default auth; the
#      Android app: a separate `ownerWork` Firebase app).
#   3. CONFIRM: the client presents that session's ID token; the server checks
#      signature + revocation, uid, sign_in_provider == "custom", mfa_sid ==
#      the binding owned by THIS API session's jti, state "minted", unexpired,
#      then sets {state: "active", authTime: <that token's auth_time>}. Once.
#
# Rules / Functions accept Owner authority only when the presented token's
# mfa_sid names an ACTIVE, unexpired binding whose authTime equals the token's
# auth_time and the provider is "custom". A password/Google/phone sign-in — the
# same second or not — and any other custom token (quick login) carry no
# mfa_sid. A second redemption of the custom token gets another auth_time and
# fails. Everything fails closed: a binding that is not ACTIVE grants nothing.
#
# Never logged or audited: custom tokens, ID tokens, full sids (6-char prefix only).

SESSIONS_COLLECTION = "ownerMfaSessions"
MFA_SID_CLAIM = "mfa_sid"
MAX_BINDINGS = 10
BIND_CLIENTS = ("crm", "android")
#: A minted binding must be confirmed within the custom token's lifetime.
MINT_TTL = timedelta(hours=1)


def _sid_tag(sid: str) -> str:
    return (sid or "")[:6]


def _prune(bindings: dict, now: datetime) -> dict:
    """Drop expired bindings and unconfirmed ones past the mint window; cap the rest."""
    live = {}
    for sid, b in (bindings or {}).items():
        exp = _aware(b.get("expiresAt"))
        if not exp or exp <= now:
            continue
        if b.get("state") != "active" and (_aware(b.get("createdAt")) or now) + MINT_TTL <= now:
            continue
        live[sid] = b
    if len(live) > MAX_BINDINGS:
        keep = sorted(live.items(), key=lambda kv: _aware(kv[1].get("createdAt")) or now)[-MAX_BINDINGS:]
        live = dict(keep)
    return live


def _mutate(uid: str, change) -> dict:
    """Run `change(bindings) -> bindings` in a Firestore transaction; write or delete."""
    from app.db import firebase

    client = firebase.firestore_client()
    ref = client.collection(SESSIONS_COLLECTION).document(uid)
    try:
        from firebase_admin import firestore as fb_firestore
        transactional = fb_firestore.transactional
    except Exception:  # noqa: BLE001 — test stubs
        def transactional(fn):
            return fn

    @transactional
    def run(tx):
        snap = ref.get(transaction=tx)
        exists = getattr(snap, "exists", False)
        current = dict((snap.to_dict() or {}).get("bindings") or {}) if exists else {}
        now = _now()
        live = _prune(change(_prune(current, now)), now)
        if live:
            tx.set(ref, {"uid": uid, "bindings": live, "updatedAt": now})
        elif exists:
            tx.delete(ref)
        return live

    return run(client.transaction())


def _verify_firebase_token(id_token: str) -> dict:
    from app.db import firebase

    return firebase.verify_id_token(id_token)


def _create_custom_token(uid: str, sid: str) -> str:
    from app.db import firebase

    return firebase.create_custom_token(uid, {MFA_SID_CLAIM: sid})


async def _refuse(user: dict, why: str, message: str) -> dict:
    try:
        await audit.record(actor=user, action=audit.Action.OWNER_MFA_BIND_FAILED, subject_type="auth.mfa",
                           subject_id=str(user.get("uid", "")), reason=f"Binding refused: {why}")
    except Exception:  # noqa: BLE001
        log.exception("could not audit a refused MFA binding")
    return {"state": "failed", "reason": message}


async def _verified_owner_session(user: dict, api_jti: str) -> tuple[dict | None, str]:
    """(session record, '') when `api_jti` is the caller's live MFA-verified
    Owner session and the staff row is an active Owner; else (None, why)."""
    db = get_db()
    staff = await db[C.STAFF].find_one({"uid": str(user.get("uid", ""))})
    if not staff or str(staff.get("role")) != str(Role.OWNER) or not staff.get("is_active", True):
        return None, "not_active_owner"
    session = await db[C.SESSIONS].find_one({"jti": api_jti}) if api_jti else None
    if (not session or session.get("revoked") or session.get("uid") != user.get("uid")
            or not session.get("mfa_verified")):
        return None, "session_not_verified"
    return session, ""


async def mint_owner_session(user: dict, id_token: str, *, api_jti: str,
                             api_expires: datetime | None, client: str = "crm") -> dict:
    """Step 1. Never raises. Returns {"state": "minted", "custom_token", "expires_at"}
    or {"state": "missing_token"|"failed", "reason"}. Grants nothing by itself."""
    import asyncio

    uid = str(user.get("uid", ""))
    if not id_token:
        return {"state": "missing_token",
                "reason": "No Firebase sign-in was sent; Firestore and Storage stay locked."}
    if not _is_owner(user):
        return await _refuse(user, "not_owner", "Only an MFA-verified Owner session can be bound.")
    if client not in BIND_CLIENTS:
        client = "crm"
    session, why = await _verified_owner_session(user, api_jti)
    if session is None:
        return await _refuse(user, why, "The API session is not an MFA-verified Owner session.")
    try:
        decoded = await asyncio.to_thread(_verify_firebase_token, id_token)
    except Exception:  # noqa: BLE001 — invalid, expired or revoked: same answer
        return await _refuse(user, "invalid_token", "The Firebase sign-in could not be verified. Sign in again.")
    if str(decoded.get("uid") or decoded.get("sub") or "") != uid:
        return await _refuse(user, "uid_mismatch", "That Firebase sign-in belongs to a different account.")
    try:
        issued_from = int(decoded.get("auth_time"))
    except (TypeError, ValueError):
        return await _refuse(user, "no_auth_time", "The Firebase sign-in has no sign-in time.")

    expires = _aware(api_expires) or _aware(session.get("token_expires_at"))
    if not expires or expires <= _now():
        return await _refuse(user, "session_expired", "The API session has expired. Sign in again.")
    sid = secrets.token_urlsafe(16)
    old_sid = str(session.get("mfa_binding_id") or "")
    entry = {"state": "minted", "apiJti": api_jti, "client": client, "issuedFromAuthTime": issued_from,
             "expiresAt": expires, "createdAt": _now()}

    def add(b: dict) -> dict:
        if old_sid:
            b.pop(old_sid, None)   # a retry replaces this session's previous binding
        b[sid] = entry
        return b

    try:
        await asyncio.to_thread(_mutate, uid, add)
    except Exception:  # noqa: BLE001
        log.exception("owner MFA binding could not be written for %s", uid)
        return await _refuse(user, "write_failed", "Firestore could not be unlocked. Try again.")
    try:
        custom_token = await asyncio.to_thread(_create_custom_token, uid, sid)
    except Exception as exc:  # noqa: BLE001 — e.g. signBlob not permitted
        log.error("owner MFA custom token could not be minted for %s: %s", uid, type(exc).__name__)
        try:
            await asyncio.to_thread(_mutate, uid, lambda b: {k: v for k, v in b.items() if k != sid})
        except Exception:  # noqa: BLE001
            log.exception("could not remove an unminted binding for %s", uid)
        return await _refuse(user, "mint_failed", "The secure sign-in for this session could not be issued. Try again.")
    await get_db()[C.SESSIONS].update_one({"jti": api_jti}, {"$set": {"mfa_binding_id": sid}})
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_MINTED, subject_type="auth.mfa",
                       subject_id=uid, reason="Owner MFA session token issued",
                       meta={"client": client, "binding": _sid_tag(sid)})
    return {"state": "minted", "custom_token": custom_token, "expires_at": expires.isoformat()}


async def confirm_owner_session(user: dict, id_token: str) -> dict:
    """Step 3. The client presents the ID token of the session that redeemed the
    custom token. Never raises; {"state": "bound"} only when every check holds."""
    import asyncio

    uid = str(user.get("uid", ""))
    api_jti = str(user.get("jti") or "")
    if not _is_owner(user) or not user.get("mfa_verified"):
        return await _refuse(user, "not_verified", "Finish two-step sign-in first.")
    session, why = await _verified_owner_session(user, api_jti)
    if session is None:
        return await _refuse(user, why, "The API session is not an MFA-verified Owner session.")
    sid = str(session.get("mfa_binding_id") or "")
    if not sid:
        return await _refuse(user, "no_binding", "There is nothing to confirm for this session. Retry unlock.")
    if not id_token:
        return await _refuse(user, "missing_token", "The new Firebase sign-in was not sent.")
    try:
        decoded = await asyncio.to_thread(_verify_firebase_token, id_token)
    except Exception:  # noqa: BLE001
        return await _refuse(user, "invalid_token", "The Firebase sign-in could not be verified.")
    provider = str((decoded.get("firebase") or {}).get("sign_in_provider") or "")
    if str(decoded.get("uid") or decoded.get("sub") or "") != uid:
        return await _refuse(user, "uid_mismatch", "That Firebase sign-in belongs to a different account.")
    if provider != "custom" or str(decoded.get(MFA_SID_CLAIM) or "") != sid:
        return await _refuse(user, "sid_mismatch", "That Firebase sign-in is not this session's secure sign-in.")
    try:
        auth_time = int(decoded.get("auth_time"))
    except (TypeError, ValueError):
        return await _refuse(user, "no_auth_time", "The Firebase sign-in has no sign-in time.")

    outcome = {"state": "failed", "why": "missing"}

    def activate(b: dict) -> dict:
        cur = b.get(sid)
        if not cur:
            outcome["why"] = "missing"
        elif cur.get("apiJti") != api_jti:
            outcome["why"] = "other_session"
        elif cur.get("state") == "active":
            if cur.get("authTime") == auth_time:
                outcome.update(state="bound", why="")   # idempotent re-confirm of the same sign-in
            else:
                outcome["why"] = "replayed"             # the custom token redeemed again
        else:
            b[sid] = {**cur, "state": "active", "authTime": auth_time, "confirmedAt": _now()}
            outcome.update(state="bound", why="")
        return b

    try:
        await asyncio.to_thread(_mutate, uid, activate)
    except Exception:  # noqa: BLE001
        log.exception("owner MFA binding could not be confirmed for %s", uid)
        return await _refuse(user, "write_failed", "Firestore could not be unlocked. Try again.")
    if outcome["state"] != "bound":
        return await _refuse(user, outcome["why"], "This secure sign-in can no longer be confirmed. Retry unlock.")
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_BOUND, subject_type="auth.mfa",
                       subject_id=uid, reason="Owner MFA session confirmed for Firestore/Storage",
                       meta={"binding": _sid_tag(sid)})
    return {"state": "bound"}


async def carry_binding(old_jti: str, new_jti: str, uid: str, new_expires: datetime) -> str:
    """Session renewal: move this session's binding to `new_jti` and extend it.

    Only an existing binding owned by `old_jti` moves; a removed binding is
    never re-created. ANY failure revokes the binding (fail closed) and reports
    "failed" — the Owner uses Retry unlock."""
    import asyncio

    db = get_db()
    old = await db[C.SESSIONS].find_one({"jti": old_jti})
    sid = str((old or {}).get("mfa_binding_id") or "")
    if not sid:
        return "not_bound"
    moved = {"ok": False}

    def change(b: dict) -> dict:
        cur = b.get(sid)
        if cur and cur.get("apiJti") == old_jti:
            b[sid] = {**cur, "apiJti": new_jti, "expiresAt": _aware(new_expires)}
            moved["ok"] = True
        return b

    try:
        await asyncio.to_thread(_mutate, uid, change)
        if moved["ok"]:
            await db[C.SESSIONS].update_one({"jti": new_jti}, {"$set": {"mfa_binding_id": sid}})
            return "bound"
        return "not_bound"
    except Exception:  # noqa: BLE001
        log.exception("owner MFA binding could not be carried for %s; revoking it", uid)
        try:
            await asyncio.to_thread(_mutate, uid, lambda b: {k: v for k, v in b.items() if k != sid})
        except Exception:  # noqa: BLE001
            log.exception("…and could not be revoked; it lapses at its expiry")
        return "failed"


async def unbind_session(jti: str, actor: dict | None = None) -> bool:
    """Sign-out: remove ONLY the binding owned by this API session. Idempotent."""
    import asyncio

    db = get_db()
    session = await db[C.SESSIONS].find_one({"jti": jti})
    sid = str((session or {}).get("mfa_binding_id") or "")
    uid = str((session or {}).get("uid") or "")
    if not sid or not uid:
        return False
    removed = {"ok": False}

    def change(b: dict) -> dict:
        if sid in b and b[sid].get("apiJti") == jti:
            del b[sid]
            removed["ok"] = True
        return b

    try:
        await asyncio.to_thread(_mutate, uid, change)
    except Exception:  # noqa: BLE001
        log.exception("owner MFA binding could not be removed on sign-out for %s", uid)
        return False
    if removed["ok"] and actor is not None:
        await audit.record(actor=actor, action=audit.Action.OWNER_MFA_UNBOUND, subject_type="auth.mfa",
                           subject_id=uid, reason="Signed out", meta={"binding": _sid_tag(sid)})
    return removed["ok"]


async def unbind_sessions(uid: str, jtis: set[str] | frozenset[str], reason: str) -> bool:
    """B3 ("sign out everywhere ELSE"): remove the bindings owned by these API
    sessions, in one transaction, and leave every other binding of `uid` —
    the kept session's — standing. Idempotent; a binding already gone is
    success. False only when Firestore could not be written (logged)."""
    import asyncio

    wanted = {str(j) for j in jtis if j}
    if not wanted or not uid:
        return True

    def change(b: dict) -> dict:
        return {sid: entry for sid, entry in b.items() if str(entry.get("apiJti") or "") not in wanted}

    try:
        await asyncio.to_thread(_mutate, uid, change)
    except Exception:  # noqa: BLE001
        log.exception("owner MFA bindings of %d ended session(s) could not be removed for %s (%s)",
                      len(wanted), uid, reason)
        return False
    return True


async def clear_all_bindings(uid: str, reason: str, actor: dict | None = None) -> bool:
    """Observer reset, suspension, deactivation, role change: remove every
    binding of `uid`. Idempotent; a missing document is success."""
    import asyncio

    try:
        await asyncio.to_thread(_mutate, uid, lambda b: {})
    except Exception:  # noqa: BLE001
        log.exception("owner MFA bindings could not be cleared for %s", uid)
        return False
    if actor is not None:
        await audit.record(actor=actor, action=audit.Action.OWNER_MFA_UNBOUND, subject_type="auth.mfa",
                           subject_id=uid, reason=reason, meta={"all": True})
    return True
