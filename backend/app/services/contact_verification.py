"""Decision 15 — is a login's phone AND email bound to it and verified?

A partner role (Agency, Sub-agency, Host, Coin Seller) starts only when the
login that holds it has BOTH a verified phone and a verified email, each proved
on its own. This module is the one place that answers that question. Approval,
activation, restoration and Host-invitation redemption all ask it.

── WHERE THE ANSWER COMES FROM ─────────────────────────────────────────────

**Never** a typed contact, a form field, `users/{uid}`, `crmUsers` or the
partner record. Only:

  * the Firebase Auth RECORD of that uid (`phone_number`, `email`,
    `email_verified`, its sign-in providers), and
  * `contactVerifications/{uid}`, a Firestore ledger that only servers write.
    It records each verification our own flows completed: the 6-digit email
    code (`functions/src/emailOtp.ts`) and the phone found bound after an SMS
    link (written by `check()` below).

**Phone.** Verified when the Auth record holds `phone_number`. Firebase sets
it only through an SMS credential (sign-in or link). The one server helper
that could set it without SMS, `firebase.update_user_phone`, has no caller.
`tests/test_rc_contact_verification.py` pins that, so a new caller fails a
test.

**Email.** A password-reset or "your login" email proves nothing. Neither
does Firebase's own `email_verified`, taken alone. Whether completing a
password reset marks the address verified is unknown (investigation U-05).
So the address counts only when Auth holds it verified AND one of these is
true:

  1. our server recorded a 6-digit-code verification of that exact address
     (`method: 'email_code'`), or
  2. a Google sign-in method with that same address is linked
     (`method: 'google'`; Google has proved it), or
  3. the account has NO password sign-in method (`method:
     'no_password_provider'`). A password reset can only touch an account
     that has a password. Without one, `email_verified` can only have come
     from our code flow (the only server writer of it) or from Google. This is
     what keeps app accounts verified before the ledger existed working.

A password login whose address Firebase marked verified by its own link (or
perhaps by a reset) therefore still needs our code. That is deliberate.

**A contact that belongs to another account** cannot be bound here at all:
Firebase keeps a phone number or an email on one account only. So the
person stays unverified, activation stays blocked, and `report_conflict`
alerts staff. Nothing is merged (open decision D3).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.db import firebase

log = logging.getLogger(__name__)

#: Server-written ledger of completed verifications, one document per uid.
LEDGER = "contactVerifications"

#: The machine-readable code every refusal carries.
VERIFICATION_REQUIRED = "CONTACT_VERIFICATION_REQUIRED"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _email_key(value: Any) -> str:
    return str(value or "").strip().lower()


def _providers(rec: Any) -> list[tuple[str, str]]:
    """`(provider_id, email)` for each sign-in method linked to the account."""
    out: list[tuple[str, str]] = []
    for info in list(getattr(rec, "provider_data", None) or []):
        pid = str(getattr(info, "provider_id", "") or "").strip()
        if pid:
            out.append((pid, _email_key(getattr(info, "email", ""))))
    return out


@dataclass
class Verification:
    uid: str
    phone: str = ""
    email: str = ""
    phone_verified: bool = False
    email_verified: bool = False
    #: How the email was proved: 'email_code' | 'google' | 'no_password_provider' | ''.
    email_method: str = ""
    #: The account has an address that is not proved (yet), for the screen.
    email_unproved: bool = False
    #: No Auth record behind the uid at all.
    no_account: bool = False
    #: Free-text notes for staff (never contact values).
    notes: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.phone_verified and self.email_verified

    @property
    def missing(self) -> list[str]:
        out = []
        if not self.phone_verified:
            out.append("phone")
        if not self.email_verified:
            out.append("email")
        return out

    def public(self) -> dict[str, Any]:
        """For the person's own screen. Contact values are masked."""
        return {
            "complete": self.complete,
            "missing": self.missing,
            "phone": {"verified": self.phone_verified, "masked": mask_phone(self.phone)},
            "email": {
                "verified": self.email_verified,
                "masked": mask_email(self.email),
                "unproved": self.email_unproved,
                "method": self.email_method,
            },
            "noAccount": self.no_account,
        }


def mask_phone(phone: str) -> str:
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    return f"••••{digits[-4:]}" if len(digits) >= 4 else ("" if not digits else "••••")


def mask_email(email: str) -> str:
    email = _email_key(email)
    if "@" not in email:
        return ""
    local, _, domain = email.partition("@")
    return f"{local[:1]}•••@{domain}"


def _read_ledger(uid: str) -> dict:
    """Blocking — `contactVerifications/{uid}`, or {}."""
    try:
        snap = firebase.firestore_client().collection(LEDGER).document(uid).get()
    except Exception:  # noqa: BLE001 — unknown proves nothing
        log.warning("contact ledger for %s could not be read", uid)
        return {}
    if not getattr(snap, "exists", False):
        return {}
    return snap.to_dict() or {}


def status(uid: str) -> Verification:
    """Blocking — the verification state of this login, from authoritative sources only."""
    uid = str(uid or "").strip()
    out = Verification(uid=uid)
    if not uid:
        out.no_account = True
        return out
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unknown is not verified
        rec = None
        out.notes.append("The sign-in account could not be read.")
    if rec is None:
        out.no_account = True
        return out

    out.phone = str(getattr(rec, "phone_number", "") or "").strip()
    out.phone_verified = bool(out.phone)

    out.email = _email_key(getattr(rec, "email", ""))
    auth_verified = bool(out.email) and bool(getattr(rec, "email_verified", False))
    providers = _providers(rec)
    provider_ids = {pid for pid, _ in providers}

    if auth_verified:
        ledger = _read_ledger(uid)
        recorded = _email_key(((ledger.get("email") or {}) if isinstance(ledger.get("email"), dict) else {}).get("address"))
        if recorded and recorded == out.email:
            out.email_verified, out.email_method = True, "email_code"
        elif any(pid == "google.com" and mail == out.email for pid, mail in providers):
            out.email_verified, out.email_method = True, "google"
        elif "password" not in provider_ids:
            out.email_verified, out.email_method = True, "no_password_provider"
    out.email_unproved = bool(out.email) and not out.email_verified
    return out


def record_phone(uid: str, phone: str) -> None:
    """Blocking — note in the ledger that this phone was found bound (SMS-linked)."""
    if not uid or not phone:
        return
    try:
        firebase.firestore_client().collection(LEDGER).document(uid).set(
            {"phone": {"number": phone, "verifiedAt": _now(), "method": "sms"}, "updatedAt": _now()},
            merge=True,
        )
    except Exception:  # noqa: BLE001 — the Auth record is the authority; the ledger is history
        log.warning("phone verification of %s could not be recorded", uid)


def record_email_code(uid: str, email: str) -> None:
    """Blocking — note that our 6-digit code proved this address (the Functions flow writes the same)."""
    email = _email_key(email)
    if not uid or not email:
        return
    firebase.firestore_client().collection(LEDGER).document(uid).set(
        {"email": {"address": email, "verifiedAt": _now(), "method": "email_code"}, "updatedAt": _now()},
        merge=True,
    )


def conflict_holder(uid: str, *, phone: str = "", email: str = "") -> str:
    """Blocking — the uid of ANOTHER account holding this phone or email, or ''."""
    try:
        if phone:
            other = firebase.get_user_by_phone(phone)
            if other is not None and str(getattr(other, "uid", "")) != uid:
                return str(getattr(other, "uid", ""))
        if email:
            other = firebase.get_user_by_email(_email_key(email))
            if other is not None and str(getattr(other, "uid", "")) != uid:
                return str(getattr(other, "uid", ""))
    except Exception:  # noqa: BLE001 — unknown is not a conflict to report
        log.warning("conflict lookup failed for %s", uid)
    return ""


def refusal_detail(v: Verification, message: str) -> dict[str, Any]:
    """The machine-readable refusal for an approval or activation that needs both."""
    return {
        "message": message,
        "code": VERIFICATION_REQUIRED,
        "requirement": "both",
        "missing": v.missing,
        "emailUnproved": v.email_unproved,
    }
