"""QA #47 (owner decision, 3 Nov 2026) and the email / wording polish (#27, #33, #35, #39).

  * **#47 — one domain, three addresses.** zipperlive.org: no-reply@ SENDS every
    automated message; support@ and info@ are CONTACTS a person is told to
    write to, and nothing automated leaves from them (their switches stay off).
    Contacts are read from `app.core.contacts`, environment-overridable only on
    the official domain. Emails no longer tell people to "reply" (a reply goes to
    no-reply@, which nobody reads) — they name support@. The List-Unsubscribe
    mailto is support@, not an invented unsubscribe@.
  * **#27** — the footer "Questions about a figure in this email? Reply to it…"
    was on every email, including an approval with no figure in it. Notices and
    emails without figures now say where to write for help instead.
  * **#33** — a PENDING Sub-agency / Agency / Coin Seller application read
    "You already hold a …".
  * **#34** — an approved role waiting for ONE contact said it starts once
    "your phone number and email address are both verified".
  * **#35** — a seller's ID document is a "Government photo ID", as the app and
    the signup form call it, not "Registration proof".
  * **#39** — the staff invitation uses the CRM's role names ("Support Team")
    and no internal "(2.1.3)" reference.

REAL: `app.core.contacts`, `email.page` / `build_template` / `render` /
`identity_resolution` / `unsubscribe_mailbox`, `partner_applications.eligible_kinds`,
`documents`, `core.role_labels`. Stubbed I/O only.

    python3 -m tests.test_qa_email_identities
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.config import settings  # noqa: E402
from app.core import contacts  # noqa: E402
from app.core.role_labels import STAFF_ROLE_LABELS, staff_role_label  # noqa: E402
from app.services import email as mail  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(claim)


settings.mail_from = "no-reply@zipperlive.org"
settings.portal_url = "https://zipperlive.web.app"
settings.unsubscribe_email = ""
settings.email_identity_info_enabled = False
settings.email_identity_support_enabled = False

# ── #47: the three addresses, and what may override them ─────────────────────
eq("the defaults", [contacts.no_reply_email(), contacts.support_email(), contacts.info_email()],
   ["no-reply@zipperlive.org", "support@zipperlive.org", "info@zipperlive.org"])
eq("the config defaults are the official ones",
   [settings.contact_support_email, settings.contact_info_email, settings.official_email_domain],
   ["support@zipperlive.org", "info@zipperlive.org", "zipperlive.org"])
settings.contact_support_email = " Help@ZipperLive.org "
eq("an override on the official domain is honoured", contacts.support_email(), "help@zipperlive.org")
settings.contact_support_email = "someone.personal@gmail.com"
eq("…one elsewhere is refused", contacts.support_email(), "support@zipperlive.org")
settings.contact_support_email = "no-reply@zipperlive.org"
eq("…and the automated sender is never a contact", contacts.support_email(), "support@zipperlive.org")
settings.contact_support_email = "support@zipperlive.org"

for identity in ("auth", "security", "transactional", "info", "support"):
    eq(f"automated '{identity}' mail leaves from no-reply@ (switches off)",
       mail.identity_resolution(identity)["from"], "no-reply@zipperlive.org")
eq("no Reply-To on any identity", {mail.identity_resolution(i)["reply_to"] for i in ("auth", "info", "support")}, {""})

eq("List-Unsubscribe mails support@, not an invented unsubscribe@", mail.unsubscribe_mailbox(), "support@zipperlive.org")
settings.unsubscribe_email = "support@zipperlive.org"
eq("…an explicit UNSUBSCRIBE_EMAIL still wins", mail.unsubscribe_mailbox(), "support@zipperlive.org")
settings.unsubscribe_email = ""

# ── #27 / #47: the footer ─────────────────────────────────────────────────────
with_figures = mail.page(title="Statement", preheader="p", body="<p>₹1,000.00</p>")
ok("an email with figures says where to ask about one — support@ and the portal",
   "Questions about a figure in this email? Write to" in with_figures
   and 'href="mailto:support@zipperlive.org"' in with_figures and "https://zipperlive.web.app" in with_figures)
no_figures = mail.page(title="Approved", preheader="p", body="<p>You are approved.</p>", figures=False)
ok("one without figures says where to write for help", "Need help? Write to" in no_figures
   and 'href="mailto:support@zipperlive.org"' in no_figures)
ok("…and never mentions a figure", "Questions about a figure" not in no_figures)
for html in (with_figures, no_figures):
    ok("no email tells anybody to reply (replies go to no-reply@)", not re.search(r"[Rr]eply to (it|this email)", html))

# Found again in the E2E re-run (3 Nov 2026): "Your two-step sign-in was reset" ended with the figure footer and
# "Figures are generated from the ledger…". The default footer line no longer speaks of figures either, and every
# email without figures says so — the catalogue renders each the way its sender sends it.
ok("the default footer of an email without figures does not speak of figures",
   "Figures are generated" not in no_figures and "Sent automatically by Zipper." in no_figures)
ok("…and the one with figures still does", "Figures are generated from the ledger" in with_figures)
for name in ("staff_invitation", "observer_otp", "partner_received", "partner_approved", "partner_rejected",
             "account_deactivated"):
    _subject, html = mail.preview(name)
    ok(f"catalogue '{name}': no figure footer, the help line instead",
       "Questions about a figure" not in html and "Figures are generated" not in html and "Need help? Write to" in html)
for name in ("payout_approved", "payout_paid", "credit_due", "credit_overdue"):
    _subject, html = mail.preview(name)
    ok(f"catalogue '{name}': keeps the figure footer", "Questions about a figure in this email? Write to" in html)
ok("the Owner two-step notices (reset, enrolled, recovery code used) carry no figure footer",
   "figures=False)," in (ROOT / "app" / "services" / "owner_mfa.py").read_text())
ok("announcements carry no figure footer", "figures=False," in (ROOT / "app" / "services" / "broadcast.py").read_text())
_email_src = (ROOT / "app" / "services" / "email.py").read_text()
deact = _email_src[_email_src.index("async def send_account_deactivated("):_email_src.index("async def send_payout_approved(")]
ok("the deactivation email carries no figure footer", "figures=False," in deact)

built = mail.build_template("partner.awaiting_verification", {"title": "Agency approved — verify to start",
                                                              "body": "Your Agency application has been approved."})
ok("#27: the 'Agency approved — verify to start' email has no figure footer",
   "Questions about a figure" not in built.html and "Need help? Write to" in built.html)

rejected = mail.render("partner_rejected", name="QA Seller", kind_label="coin seller", reason="ID unreadable.",
                       facts="", next_steps="You may reapply.")
ok("the rejection says to WRITE to support@, quoting the reference",
   "write to\n  support@zipperlive.org quoting the reference" in rejected or "write to support@zipperlive.org" in " ".join(rejected.split()))
ok("…not to reply", "reply to this" not in rejected.lower())

src = (ROOT / "app" / "services" / "email.py").read_text()
ok("deactivation and credit-overdue emails name support@ instead of 'reply'",
   'f"Write to {_contacts.support_email()} if you want the decision reviewed, "' in src
   and 'f"{_contacts.support_email()} and say so' in src)
sched = (ROOT / "app" / "services" / "scheduling.py").read_text()
ok("the partner statement names support@", "write to {contacts.support_email()} with the reference" in sched)

templates = list((ROOT / "app" / "templates").glob("*.html"))
for t in templates:
    visible = re.sub(r"<!--.*?-->", "", t.read_text(), flags=re.S)
    ok(f"{t.name}: no 'reply to this email'", not re.search(r"reply to this\s+email", visible, re.I))
for t in ("partner_approved.html", "partner_rejected.html", "credit_due.html", "payout_approved.html",
          "staff_invitation.html"):
    visible = re.sub(r"<!--.*?-->", "", (ROOT / "app" / "templates" / t).read_text(), flags=re.S)
    ok(f"{t}: no internal section reference like (0.2.1) shown to the reader",
       not re.search(r"\(\d+\.\d+(?:\.\d+)?(?:\s*[,/]\s*\d+\.\d+(?:\.\d+)?)*\)", visible))

# ── #47: no old address in the backend's code or templates ───────────────────
OLD = re.compile(r"@zipperlive\.(?:com|app)\b|@zipper\.app\b|privacy@|unsubscribe@\{")
offenders = [str(p.relative_to(ROOT)) for p in list((ROOT / "app").rglob("*.py")) + templates
             if "__pycache__" not in str(p) and OLD.search(p.read_text())]
eq("no backend code or template names an old address", offenders, [])
# The Observer's sign-in address and code mailbox are a person's identity, chosen
# by the Owner and set explicitly in production (OBSERVER_EMAIL /
# OBSERVER_OTP_DELIVERY_EMAIL) — not a Zipper address, so not replaced (QA #48).
cfg = (ROOT / "app" / "config.py").read_text()
ok("the Observer defaults are the only personal addresses left in config, and are documented",
   len(re.findall(r"@gmail\.com", cfg)) == 2 and "observer_email" in cfg)

# ── #39: the staff invitation ────────────────────────────────────────────────
eq("the CRM's role names", [staff_role_label("support_member"), staff_role_label("finance_member"),
                            staff_role_label("owner")], ["Support Team", "Finance Team", "Business Owner"])
eq("an unknown role is tidied, as before", staff_role_label("new_role"), "New Role")
eq("every staff role has a label", len(STAFF_ROLE_LABELS), 14)
invite = mail.render("staff_invitation", invited_by="An Owner", role_label=staff_role_label("support_member"),
                     button="")
ok("the invitation says 'Support Team'", "<strong>Support Team</strong>" in invite)
ok("…and no '(2.1.3)'", "(2.1.3)" not in invite)

# ── #35: a seller's ID ────────────────────────────────────────────────────────
docs = (ROOT / "app" / "services" / "documents.py").read_text()
ok("#35: registrationProofUrl is a 'Government photo ID'", '"registrationProofUrl": "Government photo ID"' in docs)

# ── #33: a pending application is not a role held ────────────────────────────
pending_sub = {"id": "s1", "kind": "sub_agency", "status": "pending", "name": "Sub", "parent_id": "M1"}
t = apps.eligible_kinds({"partners": [pending_sub], "host": None, "pending_host_application": None})
eq("#33: a pending Sub-agency says it is with a reviewer", t["blocked"]["sub_agency"],
   "Your Sub-agency application is already with a reviewer.")
ok("…and the Agency choice does not say 'already hold'", "already hold" not in t["blocked"]["agency"])
pending_seller = {"id": "c1", "kind": "seller", "status": "pending", "name": "Coins", "parent_id": None}
t = apps.eligible_kinds({"partners": [pending_seller], "host": None, "pending_host_application": None})
eq("#33: a pending Coin Seller application likewise", t["blocked"]["seller"],
   "Your Coin Seller application is already with a reviewer.")
approved_agency = {"id": "a1", "kind": "agency", "status": "approved", "name": "Agency", "parent_id": None}
t = apps.eligible_kinds({"partners": [approved_agency], "host": None, "pending_host_application": None})
eq("…an APPROVED one still says it is held (unchanged)", t["blocked"]["agency"],
   "You already hold a Agency. One agency-family role per person.")

# ── #34: an approved role waiting for a contact does not claim BOTH are missing ─
waiting_agency = {"id": "a2", "kind": "agency", "status": "awaiting_verification", "name": "Agency", "parent_id": None}
waiting_seller = {"id": "c2", "kind": "seller", "status": "awaiting_verification", "name": "Coins", "parent_id": None}
t = apps.eligible_kinds({"partners": [waiting_agency, waiting_seller], "host": None,
                         "pending_host_application": {"status": "awaiting_verification"}})
for k in ("agency", "seller", "host"):
    ok(f"#34: the waiting {k} line points at what is still needed, above it",
       "see what is still needed above" in t["blocked"][k])
    ok(f"#34: …and no longer says both contacts are missing ({k})", "are both verified" not in t["blocked"][k])

print()
if failures:
    print(f"{len(failures)} of {checks} email identity / wording checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} email identity / wording checks passed.")
print("  · QA #47: zipperlive.org — no-reply@ sends, support@ / info@ are contacts; no 'reply to this email'")
print("  · QA #27 / #33 / #34 / #35 / #39: footers, pending and waiting wording, Government photo ID, staff role names")
