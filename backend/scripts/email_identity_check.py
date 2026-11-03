"""Spec §12 sender identities — what each email leaves as, and the DNS to check. READ ONLY.

    cd backend && .venv/bin/python -m scripts.email_identity_check --dry-run

Prints, from the configuration this process would send with:

  * the two identity switches (EMAIL_IDENTITY_INFO_ENABLED,
    EMAIL_IDENTITY_SUPPORT_ENABLED — default false; the Functions read the same
    two names from their own environment, so set them on both or neither);
  * the identity table: auth / security / transactional always leave from
    no-reply@; info@ and support@ leave as themselves only when switched on,
    and otherwise fall back to no-reply@ (owner question Q8);
  * every §12 template with its identity, From, Reply-To (always none) and
    whether it is tracked (never, for auth and security);
  * the DNS records the owner must publish or check for each sending domain —
    SPF, the DKIM CNAMEs s1/s2._domainkey, the return path, DMARC — as
    instructions with the `dig` command that verifies each one.

There is no live mode. It opens no connection, sends nothing, resolves no DNS,
and prints no secret: the API key is reported only as set / not set, and an
address on a public mailbox domain (a personal mailbox) is masked.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: The two switches, by their environment names (backend settings and Functions env).
SWITCHES = (
    ("EMAIL_IDENTITY_INFO_ENABLED", "email_identity_info_enabled", "info@"),
    ("EMAIL_IDENTITY_SUPPORT_ENABLED", "email_identity_support_enabled", "support@"),
)


def _shown(mail, address: str) -> str:
    """An address as it may be printed: a personal mailbox is masked."""
    address = str(address or "").strip()
    if not address:
        return "(none)"
    domain = mail._domain_of(address)
    if domain in mail.PUBLIC_MAILBOX_DOMAINS:
        return f"***@{domain}  <-- a public mailbox domain: can never be DKIM/DMARC-aligned"
    return address


def report(settings=None, mail=None) -> list[str]:
    """The whole printout as lines. Pure: reads settings, touches nothing."""
    if settings is None:
        from app.config import settings  # noqa: PLC0415
    if mail is None:
        from app.services import email as mail  # noqa: PLC0415

    out: list[str] = []
    add = out.append
    add("Spec §12 email identity check — DRY RUN (no network, no secrets, nothing sent)")
    add("")
    add("── Switches (backend settings; the Functions read the same names from their env) ──")
    for env_name, attr, mailbox in SWITCHES:
        on = bool(getattr(settings, attr, False))
        add(f"  {env_name:<34} = {'true ' if on else 'false'}"
            f"  → {mailbox} {'leaves as itself — NOT allowed by the owner decision of 3 Nov 2026' if on else 'falls back to no-reply@ (required: automated mail never leaves from info@/support@)'}")
    add(f"  {'SendGrid API key':<34} = {'set' if str(getattr(settings, 'sendgrid_api_key', '') or '').strip() else 'NOT set'}")
    add(f"  {'EMAIL_PROVIDER':<34} = {str(getattr(settings, 'email_provider', '') or 'sendgrid')}")
    add("")

    add("── Identity table ──")
    add(f"  {'identity':<14} {'switch':<34} {'From':<34} {'Reply-To':<9} tracking")
    domains: dict[str, str] = {}
    for identity in mail.SenderIdentity:
        r = mail.identity_resolution(identity)
        switch = str(r["switch"]).upper() if r["switch"] else "always on"
        add(f"  {r['identity']:<14} {switch:<34} {_shown(mail, r['from']):<34} "
            f"{(r['reply_to'] or '(none)'):<9} {r['tracking']}")
        if r["fallback"]:
            add(f"  {'':<14} note: {r['fallback']}")
        domain = mail._domain_of(r["from"])
        if domain and domain not in mail.PUBLIC_MAILBOX_DOMAINS:
            domains.setdefault(domain, r["from"])
    # The addresses info@ / support@ WOULD use once switched on — the DNS for
    # them must be right before the switch is flipped, not after.
    for label, resolver in (("info", mail._info_address), ("support", mail._support_address)):
        address, _name = resolver()
        domain = mail._domain_of(address)
        if domain and domain not in mail.PUBLIC_MAILBOX_DOMAINS:
            domains.setdefault(domain, address)
        add(f"  once switched on, {label} would leave as: {_shown(mail, address)}")
    add("")

    # QA #47 (owner decision, 3 Nov 2026): the two CONTACT addresses people are
    # told to write to. They never send automated mail.
    from app.core import contacts

    add("── Contacts shown to people (QA #47 — never senders of automated mail) ──")
    add(f"  {'CONTACT_SUPPORT_EMAIL':<34} = {contacts.support_email()}")
    add(f"  {'CONTACT_INFO_EMAIL':<34} = {contacts.info_email()}")
    add(f"  {'List-Unsubscribe mailto':<34} = {mail.unsubscribe_mailbox()}")
    add(f"  These must RECEIVE mail: check  dig +short MX {contacts.official_domain()}  (empty = they bounce).")
    add("")

    add("── Templates (Reply-To is never set; auth/security are never tracked) ──")
    add(f"  {'template':<30} {'identity':<14} {'From':<30} {'Reply-To':<9} {'tracking':<9} retried")
    for name, template in mail.TEMPLATES.items():
        r = mail.identity_resolution(template.identity)
        add(f"  {name:<30} {str(template.identity):<14} {_shown(mail, r['from']):<30} "
            f"{(r['reply_to'] or '(none)'):<9} {template.tracking:<9} "
            f"{'yes' if template.retryable else ('no (minted once)' if str(template.identity) == 'auth' else 'no')}")
    add("  Functions (functions/src/mail.ts): partner registration/approval mail = transactional,")
    add("  weekly payout report = info (switchable); one-time codes = auth. Same switch names.")
    add("")

    add("── DNS the owner must publish / check (nothing here is looked up) ──")
    if not domains:
        add("  No sending domain is configured on a domain you control (MAIL_FROM is empty or a")
        add("  public mailbox). Set MAIL_FROM=no-reply@<your domain> first.")
    for domain in sorted(domains):
        add(f"  Domain: {domain}")
        add("    1. DKIM — SendGrid → Settings → Sender Authentication → Authenticate Your Domain.")
        add("       Publish the two CNAMEs SendGrid gives you (the numbers are yours, not these):")
        add(f"         CNAME  s1._domainkey.{domain}  →  s1.domainkey.u<NNNN>.wl.sendgrid.net")
        add(f"         CNAME  s2._domainkey.{domain}  →  s2.domainkey.u<NNNN>.wl.sendgrid.net")
        add(f"       check: dig +short CNAME s1._domainkey.{domain}")
        add(f"              dig +short CNAME s2._domainkey.{domain}")
        add("    2. Return path (aligns SPF) — the third CNAME from the same page:")
        add(f"         CNAME  em<NNNN>.{domain}  →  u<NNNN>.wl.sendgrid.net")
        add("    3. SPF — ONE v=spf1 record per host; add the include to an existing record:")
        add(f"         TXT    mail.{domain}  \"v=spf1 include:sendgrid.net ~all\"")
        add(f"       check: dig +short TXT mail.{domain}   (and dig +short TXT {domain})")
        add("    4. DMARC — start at p=none with reports; tighten only after clean reports:")
        add(f"         TXT    _dmarc.{domain}  \"v=DMARC1; p=none; rua=mailto:<a mailbox you read>; fo=1; adkim=r; aspf=r\"")
        add(f"       check: dig +short TXT _dmarc.{domain}   (report to an existing mailbox — do not invent one)")
        add("    5. Then click Verify in SendGrid and send one test message to a mailbox you own;")
        add("       its headers must show spf=pass, dkim=pass (d=" + domain + ") and dmarc=pass.")
    add("")
    add("── info@ / support@ as senders: keep both switches OFF (owner decision, 3 Nov 2026) ──")
    add("  * Automated mail must not appear to come from info@ or support@ — it leaves from no-reply@.")
    add("  * info@ and support@ are contacts: make sure both mailboxes exist and someone reads them.")
    add("  * No Reply-To is ever added; emails tell people to WRITE to support@ instead of replying.")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the identities, templates and DNS checklist (the only mode)")
    args = ap.parse_args(argv)
    if not args.dry_run:
        print("Nothing done: this script only has a --dry-run mode (it never touches the network).",
              file=sys.stderr)
        return 2
    print("\n".join(report()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
