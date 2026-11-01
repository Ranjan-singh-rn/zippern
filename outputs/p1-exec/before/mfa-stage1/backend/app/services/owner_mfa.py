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

def _is_owner(user: dict) -> bool:
    return str(user.get("role")) == str(Role.OWNER)


def _require_owner(user: dict) -> None:
    if not _is_owner(user):
        raise MfaError("Only Owner accounts use this sign-in step.", 403)


async def _record(uid: str) -> dict | None:
    return await get_db()[C.OWNER_MFA].find_one({"uid": uid})


async def status(user: dict) -> dict:
    """What the sign-in screen needs to know. Never a secret."""
    _require_owner(user)
    rec = await _record(str(user["uid"]))
    enrolled = bool(rec and rec.get("enrolled_at"))
    locked_until = _aware((rec or {}).get("locked_until"))
    locked = bool(locked_until and locked_until > _now())
    return {
        "required": bool(settings.owner_mfa_required),
        "enrolled": enrolled,
        "verified": bool(user.get("mfa_verified")),
        "configured": bool((settings.owner_mfa_encryption_key or "").strip()),
        "locked_until": locked_until.isoformat() if locked else None,
        "recovery_codes_left": sum(1 for c in (rec or {}).get("recovery", []) if not c.get("used_at")) if enrolled else 0,
    }


async def start_enrolment(user: dict) -> dict:
    """Create (or replace) a PENDING secret. Refused once enrolled — only the
    Observer can remove an enrolled factor, so a stolen password cannot swap
    the Owner's authenticator for the thief's."""
    _require_owner(user)
    uid = str(user["uid"])
    rec = await _record(uid)
    if rec and rec.get("enrolled_at"):
        raise MfaError("MFA is already set up for this account. If you lost your authenticator, "
                       "use a recovery code or ask the Observer to reset it.", 409)
    secret = new_secret()
    sealed = _seal(secret)  # raises 503 when not configured — before anything is written
    expires = _now() + timedelta(minutes=settings.owner_mfa_enrol_minutes)
    await get_db()[C.OWNER_MFA].update_one(
        {"uid": uid},
        {"$set": {"uid": uid, "pending_secret": sealed, "pending_expires_at": expires,
                  "updated_at": _now()},
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
                       subject_id=str(rec["uid"]), reason=why, meta={"failures": failures})
    if locked:
        await audit.record(actor=user, action=audit.Action.OWNER_MFA_LOCKED, subject_type="auth.mfa",
                           subject_id=str(rec["uid"]),
                           reason=f"{settings.owner_mfa_max_failures} wrong codes in a row",
                           meta={"minutes": settings.owner_mfa_lock_minutes})
        await _notify(str(rec["uid"]), "locked", f"mfa_locked_{rec['uid']}_{int(time.time())}",
                      "Your Zipper CRM sign-in was locked",
                      f"Several wrong verification codes were entered for your Owner account. "
                      f"Sign-in is paused for {settings.owner_mfa_lock_minutes} minutes. "
                      "If this was not you, change your password and tell the Observer.")
        raise MfaError("Too many wrong codes. Sign-in is paused for a few minutes.", 429)
    raise MfaError("That code is not right. Check the time on your phone and try again.", 401)


async def confirm_enrolment(user: dict, code: str) -> list[str]:
    """Check the first code from the authenticator; return the recovery codes."""
    _require_owner(user)
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
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_ENROLLED, subject_type="auth.mfa",
                       subject_id=uid, reason="Owner set up an authenticator app",
                       meta={"recovery_codes": RECOVERY_CODES})
    await _notify(uid, "enrolled", f"mfa_enrolled_{uid}_{step}",
                  "Two-step sign-in is on for your Owner account",
                  "An authenticator app was set up for your Zipper CRM Owner account. "
                  "If this was not you, tell the Observer immediately.")
    return codes


async def verify(user: dict, *, code: str = "", recovery_code: str = "") -> dict:
    """Check a TOTP code or a recovery code. Returns `{"method": ...}`."""
    _require_owner(user)
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
                await audit.record(actor=user, action=audit.Action.OWNER_MFA_RECOVERY_USED,
                                   subject_type="auth.mfa", subject_id=uid,
                                   reason="Owner signed in with a recovery code", meta={"left": left})
                await _notify(uid, "recovery", f"mfa_recovery_{uid}_{i}",
                              "A recovery code was used on your Owner account",
                              f"Someone signed in to your Zipper CRM Owner account with a recovery code. "
                              f"{left} codes are left. If this was not you, tell the Observer immediately.")
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
                       subject_id=uid, reason="Owner passed two-step sign-in", meta={"method": "totp"})
    return {"method": "totp"}


async def regenerate_recovery_codes(user: dict, code: str) -> list[str]:
    """New recovery codes; the old ones stop working. Needs a verified session
    AND a fresh authenticator code, so a session left open is not enough."""
    _require_owner(user)
    if not user.get("mfa_verified"):
        raise MfaError("Finish two-step sign-in first.", 403)
    await verify(user, code=code)
    codes, stored = _issue_recovery_codes()
    uid = str(user["uid"])
    await get_db()[C.OWNER_MFA].update_one({"uid": uid}, {"$set": {"recovery": stored, "updated_at": _now()}})
    await audit.record(actor=user, action=audit.Action.OWNER_MFA_CODES_REGENERATED, subject_type="auth.mfa",
                       subject_id=uid, reason="Owner replaced their recovery codes")
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
    await db[C.SESSIONS].update_many({"uid": owner_uid}, {"$set": {"revoked": True}})
    audit_id = await audit.record(
        actor=observer, action=audit.Action.OWNER_MFA_RESET, subject_type="auth.mfa",
        subject_id=owner_uid, reason=reason,
        before={"enrolled": had}, after={"enrolled": False, "sessions": "revoked"},
    )
    notified = await _notify(owner_uid, "reset", f"mfa_reset_{owner_uid}_{audit_id}",
                             "Your two-step sign-in was reset",
                             "The Observer reset the authenticator on your Zipper CRM Owner account and "
                             "signed you out everywhere. Next time you sign in you will set it up again. "
                             "If you did not ask for this, contact the Observer.",
                             email_to=owner)
    return {"uid": owner_uid, "was_enrolled": had, "sessions_revoked": True, "notified": notified,
            "audit_id": str(audit_id)}


async def _notify(uid: str, kind: str, key: str, title: str, body: str, *, email_to: dict | None = None) -> bool:
    """In-app notice (and email when the staff row is given). Never raises."""
    ok = False
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
        except Exception:  # noqa: BLE001
            log.exception("could not email the MFA %s notice", kind)
    return ok
