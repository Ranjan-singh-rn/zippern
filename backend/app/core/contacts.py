"""QA #47 (3 Nov 2026) — Zipper's email identities, in one place.

Owner decision, final: Zipper's email domain is **zipperlive.org** and it has
exactly three addresses.

    no-reply@zipperlive.org   the SENDER of every automated message — OTPs,
                              verification, password resets, security and
                              system notices. `settings.mail_from`.
    info@zipperlive.org       general business information — a CONTACT.
    support@zipperlive.org    customer support — a CONTACT.

Automated mail never leaves FROM info@ or support@: the `info` / `support`
sending switches (`email_identity_*_enabled`) stay off, so every identity
resolves to no-reply@ (see `email.identity_resolution`). What these two are for
is the sentence a person reads — "write to support@zipperlive.org" — in an
email footer, a template, a notice, the CRM and the app.

Environment-aware: CONTACT_SUPPORT_EMAIL / CONTACT_INFO_EMAIL override the
defaults per deployment, and an override that is not an address on the
official domain (or that names the no-reply sender) is refused here in favour
of the default — a typo cannot put a stranger's mailbox in front of a customer.
The CRM (`zipper-crm/lib/contacts.ts`), the Functions (`functions/src/mail.ts`)
and the app (`com.zipper.app.util.ZipperContacts`) carry the same three
addresses; `tests/test_qa_email_identities.py` checks they agree.

Pure: reads `settings`, nothing else.
"""

from __future__ import annotations

from app.config import settings

#: The defaults, spelled out once. Nothing else in this codebase writes them.
OFFICIAL_DOMAIN = "zipperlive.org"
NO_REPLY = f"no-reply@{OFFICIAL_DOMAIN}"
INFO = f"info@{OFFICIAL_DOMAIN}"
SUPPORT = f"support@{OFFICIAL_DOMAIN}"


def official_domain() -> str:
    return (str(getattr(settings, "official_email_domain", "") or "").strip().lower() or OFFICIAL_DOMAIN)


def _on_official_domain(value: str) -> bool:
    at = value.rfind("@")
    return at > 0 and " " not in value and value[at + 1:] == official_domain()


def _contact(override: object, fallback: str) -> str:
    v = str(override or "").strip().lower()
    if not v or not _on_official_domain(v) or v == no_reply_email():
        return fallback
    return v


def no_reply_email() -> str:
    """The automated sender — `mail_from` when it is on the official domain."""
    v = str(getattr(settings, "mail_from", "") or "").strip().lower()
    return v if v and _on_official_domain(v) else NO_REPLY


def support_email() -> str:
    """Where a person is told to write for help."""
    return _contact(getattr(settings, "contact_support_email", ""), SUPPORT)


def info_email() -> str:
    """Where a person is told to write for general business information."""
    return _contact(getattr(settings, "contact_info_email", ""), INFO)
