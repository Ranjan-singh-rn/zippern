"""The composed email — spec 8A.7.2.

`test_delivery.py` holds the delivery layer to its contract. These tests hold
the thing built on top of it: a message a person types, aimed at an audience
they pick, which is the only email in this system whose recipients are chosen
by a human rather than derived from a record. That is the whole risk, and every
section below is about one way it can go wrong.

What is asserted:

  * **each audience resolves from the real source** — agencies and sellers from
    the Mongo `partners` record for who they are and the Firestore registration
    document for the address on each; app users from Firestore `users`; one
    named person by being *found* on one of those records rather than trusted
    because somebody typed it;
  * **a partial resolution refuses.** A Firestore collection that will not
    stream, a partner list that will not read, an unsubscribe table that will
    not answer, an audience over the ceiling — each is a refusal that sends
    nothing, records nothing and writes no audit entry. There is no path in
    this module that sends to "the part of the audience that resolved";
  * **an address that unsubscribed stays out** — of every audience, including a
    send to one named person — and gets an `unsubscribed_local` row in the
    delivery log saying it was skipped on purpose;
  * **attachments go through `email.prepare_attachments`**, so a duplicate
    filename is renamed and an oversized file is left off and named in the body
    while the message still goes;
  * **authority is graded by blast radius**: one person is a team admin's, every
    agency or seller is a marketing admin's, every app user is an owner's and
    nobody else's — not a marketing admin's, not a marketing member's, and never
    a machine's;
  * **the audit entry names the audience it actually resolved to**, address by
    address, not the label — and a send with no reason, or whose audit entry
    cannot be written, sends nothing;
  * **the count is a control**: above the threshold the caller must echo the
    exact number back, and a number that no longer matches is refused with the
    real one;
  * **one delivery layer**: every recipient has a row under the same
    `broadcast.<id>` kind, carrying `List-Unsubscribe` and the bulk sender;
  * **a throttle stops the send** and names every address it never attempted,
    rather than turning a rate limit into hundreds of recorded failures.

Run:  python3 -m tests.test_broadcast
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import (  # noqa: E402
    FakeDb,
    FakeSendGrid,
    PyMongoError,
    install_stubs,
)

install_stubs()

# The Firestore half. `harness.py` has no fake Firestore because nothing in the
# delivery layer touches one; the audience half of this module is mostly
# Firestore, so the one `fakes.py` already has is reused rather than written
# twice. Importing it installs nothing — only `install_module_stubs()` does
# that, and it is deliberately not called.
from tests.fakes import FakeFirestore, FieldFilter  # noqa: E402

# `harness.install_stubs` installs this same class now — it used to put a
# do-nothing lambda there, on the grounds that nothing in the delivery layer
# builds a filter, and every test that did build one had to patch over it here.
# The line stays because it is the thing this file depends on: the single-person
# lookup finds an app user by an indexed equality query rather than by reading
# the whole user collection, and that query is only exercised at all if the fake
# can read what the filter asked for. Re-asserting it costs nothing and means
# this test does not silently stop testing that if the harness changes again.
sys.modules["google.cloud.firestore_v1.base_query"].FieldFilter = FieldFilter  # type: ignore[attr-defined]

from app.config import settings  # noqa: E402
import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402

# `audit.py` imports `get_db` at module level, so patching `mongo.get_db` alone
# would leave the audit log writing to a database that does not exist.
audit_mod.get_db = lambda: DB  # type: ignore[assignment]

from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import broadcast as bc  # noqa: E402
from app.services import email as mail  # noqa: E402

FS = FakeFirestore()
fb._fs = FS  # type: ignore[assignment]

PROVIDER = FakeSendGrid()
PROVIDER.install()

settings.sendgrid_api_key = "SG.aKeyThatMustNotAppearOnAnyRow.000000000000"
settings.mail_from = "no-reply@zipper.app"
settings.mail_from_bulk = "news@zipper.app"
settings.mail_from_support = "support@zipper.app"
settings.mail_from_transactional = "hello@zipper.app"
settings.unsubscribe_url = "https://api.zipper.app/api/notifications/unsubscribe"
settings.environment = "test"
# Spec §12: the bulk (info) and support identities leave as themselves only
# once the owner confirms those mailboxes. This suite is about the streams
# being separate, so both switches are on; the off-by-default behaviour is
# pinned in `tests/test_email_identities.py`.
settings.email_identity_info_enabled = True
settings.email_identity_support_enabled = True

# Small and fast. The waves have to be small enough that a throttle test does
# not need six hundred fake users to produce three of them.
settings.broadcast_batch_size = 2
settings.broadcast_concurrency = 2
settings.broadcast_wave_pause_seconds = 0.0
settings.broadcast_throttle_waves_before_stop = 2
settings.broadcast_confirm_above = 3
settings.broadcast_max_recipients = 50


failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def contains(label: str, haystack: str, needle: str) -> None:
    global checks
    checks += 1
    if needle.lower() not in str(haystack).lower():
        failures.append(f"{label}\n    {needle!r} is not in {str(haystack)[:400]!r}")


def refuses(label: str, factory, *, error=bc.BroadcastError):
    """Run something that must be refused, and hand back the refusal."""
    global checks
    checks += 1
    try:
        result = run(factory())
    except error as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted {error.__name__}"
        )
        return None
    failures.append(f"{label}: was NOT refused — returned {str(result)[:200]!r}")
    return None


def run(coro):
    return asyncio.run(coro)


# ══════════════════════════════════════════════════════════════════════════════
#  The world
# ══════════════════════════════════════════════════════════════════════════════


def actor(role, uid="u-1", name="A Person") -> dict:
    return {"uid": uid, "name": name, "role": str(role), "team": None}


OWNER = actor(Role.OWNER, "u-owner", "An Owner")
MARKETING_ADMIN = actor(Role.MARKETING_ADMIN, "u-mkt-admin", "Marketing Admin")
MARKETING_MEMBER = actor(Role.MARKETING_MEMBER, "u-mkt-member", "Marketing Member")
SUPPORT_ADMIN = actor(Role.SUPPORT_ADMIN, "u-sup-admin", "Support Admin")
FINANCE_MEMBER = actor(Role.FINANCE_MEMBER, "u-fin", "Finance Member")
OBSERVER = actor(Role.OBSERVER, "u-obs", "The Observer")
AGENCY_SESSION = actor(Role.AGENCY, "u-ag", "An Agency")
MACHINE = {"uid": "system:reporting", "name": "Reporting job", "role": "system"}


def reset_world() -> None:
    """Rebuild every collection from scratch. Each section starts clean."""
    DB.collections.clear()
    FS.collections.clear()
    PROVIDER.sent.clear()
    PROVIDER.next_status = 202
    PROVIDER.next_body = b""
    PROVIDER.raise_on_send = None

    DB.seed(
        C.PARTNERS,
        [
            {"_id": "ag-1", "kind": "agency", "status": "approved", "is_active": True,
             "name": "North Agency"},
            {"_id": "ag-2", "kind": "sub_agency", "status": "approved", "is_active": True,
             "name": "North Sub"},
            {"_id": "ag-3", "kind": "agency", "status": "pending", "is_active": True,
             "name": "Not Approved Yet"},
            {"_id": "ag-4", "kind": "agency", "status": "approved", "is_active": False,
             "name": "Deactivated"},
            {"_id": "sl-1", "kind": "seller", "status": "approved", "is_active": True,
             "name": "First Seller"},
            {"_id": "sl-2", "kind": "seller", "status": "approved", "is_active": True,
             "name": "Second Seller"},
            {"_id": "sl-3", "kind": "seller", "status": "rejected", "is_active": True,
             "name": "Rejected Seller"},
        ],
    )
    DB.seed(
        C.STAFF,
        [
            {"uid": "u-owner", "email": "owner@zipper.app", "role": str(Role.OWNER),
             "name": "An Owner", "is_active": True},
            {"uid": "u-gone", "email": "gone@zipper.app", "role": str(Role.OPS_MEMBER),
             "name": "Left The Company", "is_active": False},
        ],
    )

    agencies = FS.collection("agencies")
    agencies.docs["ag-1"] = {"ownerEmail": "North@Agency.com", "name": "North Agency"}
    agencies.docs["ag-2"] = {"contactEmail": "sub@agency.com", "name": "North Sub"}
    # ag-3 and ag-4 have documents too — they are excluded by the *Mongo* record
    # being unapproved or inactive, not by an absent address, and a test that
    # left them out would not prove which of the two did the excluding.
    agencies.docs["ag-3"] = {"ownerEmail": "pending@agency.com"}
    agencies.docs["ag-4"] = {"ownerEmail": "deactivated@agency.com"}

    sellers = FS.collection("sellers")
    sellers.docs["sl-1"] = {"email": "one@seller.com", "name": "First Seller"}
    # sl-2 deliberately has no document at all: an approved partner nobody can
    # write to is a gap in the record, and it has to be visible as one.
    sellers.docs["sl-3"] = {"email": "rejected@seller.com"}

    users = FS.collection("users")
    users.docs["us-1"] = {"email": "Ann@example.com", "name": "Ann"}
    users.docs["us-2"] = {"email": "bob@example.com", "name": "Bob"}
    users.docs["us-3"] = {"email": "cara@example.com", "name": "Cara"}
    users.docs["us-4"] = {"name": "No Email At All", "phoneNumber": "+919000000000"}
    users.docs["us-5"] = {"email": "banned@example.com", "name": "Banned", "isBanned": True}
    users.docs["us-6"] = {"email": "bob@example.com", "name": "Bob's Second Account"}


def deliveries() -> list[dict]:
    return DB[C.EMAIL_DELIVERIES].docs


def audits() -> list[dict]:
    return DB[C.AUDIT].docs


def mute(address: str) -> None:
    """What `POST /api/notifications/unsubscribe` writes when a link is clicked."""
    DB.seed(
        C.REPORT_SUBSCRIPTIONS,
        [
            {
                "report": bc.STREAM,
                "cadence": bc.CADENCE,
                "email": address.strip().lower(),
                "muted": True,
            }
        ],
    )


MESSAGE = dict(
    subject="A short note about your account",
    body="Hello.\n\nThis is the first paragraph.\nStill the first.\n\nAnd a second.",
    reason="Testing the composer end to end.",
)


def send(audience: str, who=OWNER, **overrides):
    kwargs = dict(MESSAGE)
    kwargs.update(overrides)
    return run(bc.send(spec=audience, actor=who, **kwargs))


# ══════════════════════════════════════════════════════════════════════════════
# 1. The vocabulary it adds to the delivery layer
# ══════════════════════════════════════════════════════════════════════════════
#
# An announcement is the only class of mail an app user can ever receive: they
# have no role on record, and every other sensitivity refuses a roleless
# address. If that branch is wrong the whole feature silently withholds.

reset_world()

ok(
    "'announcement' is a real sensitivity",
    str(mail.Sensitivity.ANNOUNCEMENT) == "announcement",
)

for label, recipient in (
    ("an app user with no role at all", mail.Recipient(email="u@example.com")),
    ("an agency", mail.Recipient(email="a@x.com", role=str(Role.AGENCY))),
    ("a coin seller", mail.Recipient(email="s@x.com", role=str(Role.SELLER))),
    ("an owner", mail.Recipient(email="o@x.com", role=str(Role.OWNER))),
    ("a team member", mail.Recipient(email="m@x.com", role=str(Role.FINANCE_MEMBER))),
    ("an unrecognised role", mail.Recipient(email="?@x.com", role="something_else")),
):
    check(
        f"an announcement may be sent to {label}",
        mail.may_receive(mail.Sensitivity.ANNOUNCEMENT, recipient)[0],
        True,
    )

# And the classes that were already gated stay gated — adding one must not have
# opened the others.
check(
    "an app user still may not be sent a business-wide money figure",
    mail.may_receive(
        mail.Sensitivity.BUSINESS_MONEY, mail.Recipient(email="u@example.com")
    )[0],
    False,
)
check(
    "an agency still may not be sent operational mail",
    mail.may_receive(
        mail.Sensitivity.OPERATIONAL,
        mail.Recipient(email="a@x.com", role=str(Role.AGENCY)),
    )[0],
    False,
)

# `record_withheld` writes decisions. It must refuse to write a failure, or the
# delivery log would carry rows claiming nothing was attempted when something
# was.
try:
    run(
        mail.record_withheld(
            kind="broadcast.x", spec=bc.SPEC,
            recipient=mail.Recipient(email="a@b.com"),
            subject="s", sensitivity=mail.Sensitivity.ANNOUNCEMENT,
            outcome=mail.Outcome.FAILED, reason="r",
        )
    )
    failures.append("record_withheld accepted 'failed', which is not a withholding")
    checks += 1
except ValueError as exc:
    checks += 1
    contains("record_withheld says which outcomes it accepts", str(exc), "unsubscribed_local")


# ══════════════════════════════════════════════════════════════════════════════
# 2. Audience names — recognised, or refused. Never a silent nobody.
# ══════════════════════════════════════════════════════════════════════════════

async def _sync(fn, *args):
    """Let `refuses` drive a synchronous function too."""
    return fn(*args)


check(
    "'all_agencies' parses",
    bc.parse_audience("all_agencies"),
    (bc.Audience.ALL_AGENCIES, ""),
)
check(
    "a person audience keeps its address, lower-cased",
    bc.parse_audience("person:Someone@Example.COM"),
    (bc.Audience.PERSON, "someone@example.com"),
)

for bad, why in (
    ("everyone", "an audience nobody defined"),
    ("", "an empty audience"),
    ("person:", "a person with no address"),
    ("person:not-an-address", "a person whose address is not one"),
    ("all_users:banned", "a bare audience given a parameter it does not take"),
):
    exc = refuses(f"{why} is refused", lambda b=bad: _sync(bc.parse_audience, b))
    ok(f"{why} refusal says what an audience can be", exc is not None)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Authority — graded by how many people a mistake reaches
# ══════════════════════════════════════════════════════════════════════════════
#
# The table is printed at the end of the run, because "who can email every
# customer" is a question an owner should be able to answer by reading the test
# output rather than by reading the source.

AUTHORITY: list[tuple[str, dict, str, bool]] = [
    # audience,           actor,             label,               may send
    ("person:owner@zipper.app", OWNER, "owner", True),
    ("person:owner@zipper.app", MARKETING_ADMIN, "marketing_admin", True),
    ("person:owner@zipper.app", SUPPORT_ADMIN, "support_admin", True),
    ("person:owner@zipper.app", MARKETING_MEMBER, "marketing_member", False),
    ("person:owner@zipper.app", FINANCE_MEMBER, "finance_member", False),
    ("person:owner@zipper.app", OBSERVER, "observer", False),
    ("person:owner@zipper.app", AGENCY_SESSION, "agency", False),
    ("person:owner@zipper.app", MACHINE, "a machine credential", False),

    ("all_agencies", OWNER, "owner", True),
    ("all_agencies", MARKETING_ADMIN, "marketing_admin", True),
    ("all_agencies", SUPPORT_ADMIN, "support_admin", False),
    ("all_agencies", MARKETING_MEMBER, "marketing_member", False),
    ("all_agencies", OBSERVER, "observer", False),

    ("all_sellers", MARKETING_ADMIN, "marketing_admin", True),
    ("all_sellers", SUPPORT_ADMIN, "support_admin", False),

    ("all_users", OWNER, "owner", True),
    ("all_users", MARKETING_ADMIN, "marketing_admin", False),
    ("all_users", SUPPORT_ADMIN, "support_admin", False),
    ("all_users", MARKETING_MEMBER, "marketing_member", False),
    ("all_users", OBSERVER, "observer", False),
    ("all_users", AGENCY_SESSION, "agency", False),
    ("all_users", MACHINE, "a machine credential", False),
]

authority_rows: list[tuple[str, str, str]] = []
for audience_name, who, who_label, expected in AUTHORITY:
    audience, _param = bc.parse_audience(audience_name)
    try:
        bc.check_authority(who, audience)
        allowed, note = True, ""
    except bc.NotAuthorised as exc:
        allowed, note = False, str(exc)
    check(f"{who_label} → {audience_name}", allowed, expected)
    authority_rows.append(
        (audience_name, who_label, "may send" if allowed else f"refused: {note[:60]}…")
    )

# The Observer's refusal must be about being read-only, not about marketing. A
# refusal that names the wrong rule sends somebody to change the wrong thing.
try:
    bc.check_authority(OBSERVER, bc.Audience.PERSON)
except bc.NotAuthorised as exc:
    contains("the observer is refused for being read-only", str(exc), "read-only")

try:
    bc.check_authority(MACHINE, bc.Audience.PERSON)
except bc.NotAuthorised as exc:
    contains("a machine is refused for not being a person", str(exc), "no key to grant")

# Nobody outside the internal roles is on any allowlist.
for audience in bc.Audience:
    allowed, why = bc.authority_for(audience)
    ok(f"{audience}: somebody may send it", bool(allowed))
    ok(
        f"{audience}: every role that may send it is internal",
        all(r in (set(bc.R.INTERNAL_ROLES)) for r in allowed),
    )
    ok(f"{audience}: the refusal explains itself", len(why) > 40)

check(
    "only an owner may write to every app user",
    bc.authority_for(bc.Audience.ALL_USERS)[0],
    frozenset({Role.OWNER}),
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Each audience, resolved from the source that owns it
# ══════════════════════════════════════════════════════════════════════════════

reset_world()

agencies = run(bc.resolve("all_agencies"))
check(
    "all_agencies is every approved active agency AND sub-agency, and nobody else",
    [r.email for r in agencies.recipients],
    ["north@agency.com", "sub@agency.com"],
)
check(
    "an agency address is lower-cased on the way out",
    agencies.recipients[0].email,
    "north@agency.com",
)
check("an agency recipient carries the agency role", agencies.recipients[0].role, str(Role.AGENCY))
check("an agency recipient carries its partner id", agencies.recipients[0].uid, "ag-1")
contains("the agency audience names both of its sources", agencies.source, "mongo `partners`")
contains("the agency audience names both of its sources", agencies.source, "firestore `agencies`")

sellers = run(bc.resolve("all_sellers"))
check(
    "all_sellers excludes the rejected one",
    sorted(r.email for r in sellers.recipients if r.email),
    ["one@seller.com"],
)
check(
    "a seller with no registration document is still in the audience, with no address",
    [(r.uid, r.email) for r in sellers.recipients if not r.email],
    [("sl-2", "")],
)
check(
    "…and is named as a gap in the record before anything is sent",
    [g["id"] for g in sellers.no_address],
    ["sl-2"],
)
contains(
    "…with the reason a person can act on",
    sellers.no_address[0]["reason"],
    "no sellers document for this partner at all",
)

users = run(bc.resolve("all_users"))
check(
    "all_users is every user with an address, de-duplicated and lower-cased",
    [r.email for r in users.recipients],
    ["ann@example.com", "bob@example.com", "cara@example.com"],
)
check("an app user carries no role", users.recipients[0].role, None)
check("an app user carries their uid", users.recipients[0].uid, "us-1")
excluded = {e["reason"]: e["count"] for e in users.excluded}
check("the phone-only account is excluded and counted", any("phone-only" in r for r in excluded), True)
check("the banned account is excluded and counted", any("banned" in r for r in excluded), True)
check("the duplicate mailbox is excluded and counted", any("one mailbox" in r for r in excluded), True)
check("exactly one of each was excluded", sorted(excluded.values()), [1, 1, 1])

# One person, found on each of the four kinds of record there are.
for address, expected_role, expected_uid, where in (
    ("owner@zipper.app", str(Role.OWNER), "u-owner", "the staff record"),
    ("north@agency.com", str(Role.AGENCY), "ag-1", "an agency registration"),
    ("one@seller.com", str(Role.SELLER), "sl-1", "a seller registration"),
    ("ann@example.com", None, "us-1", "an app user profile"),
):
    found = run(bc.resolve(f"person:{address}"))
    check(f"one person is found in {where}", found.count, 1)
    check(f"…carrying the role on that record ({where})", found.recipients[0].role, expected_role)
    check(f"…and the id on that record ({where})", found.recipients[0].uid, expected_uid)

# A partner whose address was typed with a capital letter. Every partner whose
# owner did that has it stored as typed — which is what
# `scripts/normalise_partner_emails.py` exists to clean up — so a lookup that
# only matched the stored bytes would refuse a real agency as "not on any
# record", confidently and wrongly.
found = run(bc.resolve("person:NORTH@agency.com"))
check("a mis-cased partner address still finds the partner", found.recipients[0].uid, "ag-1")
check("…and is written to in lower case", found.recipients[0].email, "north@agency.com")

# The same for an app user. The indexed query cannot see `Ann@example.com`, so
# the bounded case-insensitive fallback has to — `us-1` is seeded mis-cased on
# purpose, because a profile written before the app normalised the field looks
# exactly like this.
found = run(bc.resolve("person:ann@example.com"))
check("a mis-cased app-user address is still found", found.recipients[0].uid, "us-1")

# And when the fallback could not look at everything, "not found" is not the
# answer it gives. A confident wrong refusal is how somebody concludes a real
# customer does not exist.
settings.broadcast_max_recipients = 2
exc = refuses(
    "an incomplete search does not report itself as 'not found'",
    lambda: bc.resolve("person:nobody@example.com"),
    error=bc.AudienceUnresolved,
)
contains("…it says the search was not complete", str(exc), "search was not complete")
contains("…and distinguishes the two answers", str(exc), "could not finish looking")
settings.broadcast_max_recipients = 50

# The rule that stops this being an open relay.
exc = refuses(
    "an address on no record at all is refused",
    lambda: bc.resolve("person:stranger@nowhere.example"),
    error=bc.AudienceUnresolved,
)
contains("…and the refusal says why", str(exc), "not on any record here")
contains("…and names the likely cause", str(exc), "typo")

check("nothing was sent while resolving", PROVIDER.sent, [])
check("nothing was recorded while resolving", deliveries(), [])


# ══════════════════════════════════════════════════════════════════════════════
# 5. A partial resolution refuses. This is the section that matters most.
# ══════════════════════════════════════════════════════════════════════════════
#
# Every case below is one where the audience is *knowable in part*. The whole
# design is that "in part" is not an answer: nothing is sent, no audit entry is
# written, and no delivery row exists — so a refused broadcast is indexable from
# the outside as one that never started.

reset_world()

FS.collection("agencies").fail_on("stream", exc=RuntimeError("503 Firestore unavailable"))
exc = refuses(
    "an agency audience whose addresses cannot be read is refused",
    lambda: bc.send(spec="all_agencies", actor=OWNER, **MESSAGE),
    error=bc.AudienceUnresolved,
)
contains("…the refusal names Firestore", str(exc), "firestore")
contains("…and says nothing was sent", str(exc), "nothing was sent")
contains(
    "…and says why a partial send would have been worse",
    str(exc),
    "indistinguishable",
)
check("a refused broadcast sends nothing", PROVIDER.sent, [])
check("a refused broadcast records no delivery", deliveries(), [])
check("a refused broadcast writes no audit entry", audits(), [])
FS.collection("agencies").clear_failures()

FS.collection("users").fail_on("stream", exc=RuntimeError("permission denied"))
refuses(
    "an app-user audience that cannot be streamed is refused",
    lambda: bc.send(spec="all_users", actor=OWNER, **MESSAGE),
    error=bc.AudienceUnresolved,
)
check("…and still nothing was sent", PROVIDER.sent, [])
check("…and still no audit entry", audits(), [])
FS.collection("users").clear_failures()

# The Mongo half failing is the same refusal from the other side.
class _Exploding:
    def find(self, *_a, **_k):
        raise PyMongoError("connection reset")


_real_getitem = FakeDb.__getitem__


def _explode_on(name: str):
    def patched(self, key):
        if key == name:
            return _Exploding()
        return _real_getitem(self, key)

    return patched


FakeDb.__getitem__ = _explode_on(C.PARTNERS)  # type: ignore[assignment]
exc = refuses(
    "a partner list that cannot be read is refused",
    lambda: bc.send(spec="all_sellers", actor=OWNER, **MESSAGE),
    error=bc.AudienceUnresolved,
)
contains("…the refusal names Mongo", str(exc), "mongo")
FakeDb.__getitem__ = _real_getitem  # type: ignore[assignment]

# The unsubscribe table failing. Deliberately stricter than `notify.resolve`.
FakeDb.__getitem__ = _explode_on(C.REPORT_SUBSCRIPTIONS)  # type: ignore[assignment]
exc = refuses(
    "a send whose opt-out list cannot be read is refused",
    lambda: bc.send(spec="all_users", actor=OWNER, **MESSAGE),
    error=bc.AudienceUnresolved,
)
contains("…the refusal is about the opt-outs", str(exc), "opted out")
contains("…and says a late broadcast beats an unchecked one", str(exc), "worse than a late one")
FakeDb.__getitem__ = _real_getitem  # type: ignore[assignment]
check("none of the four refusals sent anything", PROVIDER.sent, [])
check("none of the four refusals recorded anything", deliveries(), [])
check("none of the four refusals wrote an audit entry", audits(), [])

# An audience over the ceiling is refused whole rather than trimmed.
reset_world()
settings.broadcast_max_recipients = 2
exc = refuses(
    "an audience over the ceiling is refused, not truncated",
    lambda: bc.resolve("all_users"),
    error=bc.AudienceUnresolved,
)
contains("…the refusal states the ceiling", str(exc), "over the")
contains("…and says it was refused rather than trimmed", str(exc), "refused rather than trimmed")
settings.broadcast_max_recipients = 50


# ══════════════════════════════════════════════════════════════════════════════
# 6. An address that opted out stays out — of every audience
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
mute("bob@example.com")
DB.seed(
    C.REPORT_SUBSCRIPTIONS,
    [
        # An un-muted row. A subscription that says "yes" must not be read as
        # "no" by a filter that only looks at whether a row exists.
        {"report": bc.STREAM, "cadence": bc.CADENCE, "email": "cara@example.com",
         "muted": False},
        # A mute on a *different* stream. Turning off the daily report is not
        # turning off everything.
        {"report": "daily_business_summary", "cadence": "daily",
         "email": "ann@example.com", "muted": True},
    ],
)

check("the suppression list is exactly the muted broadcast rows", run(bc.suppressed()), {"bob@example.com"})

result = send("all_users")
check("the opted-out address is not written to", "bob@example.com" in [s["to"] for s in PROVIDER.sent], False)
check(
    "everybody else is",
    sorted(s["to"] for s in PROVIDER.sent),
    ["ann@example.com", "cara@example.com"],
)
check("an un-muted subscription row does not exclude anybody", "cara@example.com" in [s["to"] for s in PROVIDER.sent], True)
check("a mute on another stream does not exclude anybody", "ann@example.com" in [s["to"] for s in PROVIDER.sent], True)
check("the send reports how many it skipped", result["unsubscribed_skipped"], 1)

skipped = [d for d in deliveries() if d["to"] == "bob@example.com"]
check("the skip leaves exactly one delivery row", len(skipped), 1)
check("…recorded as a local unsubscribe", skipped[0]["outcome"], str(mail.Outcome.UNSUBSCRIBED_LOCAL))
check("…which the delivery log counts as a withholding, not a failure",
      skipped[0]["outcome"] in mail.WITHHELD_OUTCOMES, True)
check("…and never as a failure", skipped[0]["outcome"] in mail.FAILURE_OUTCOMES, False)
contains("…and says it was the recipient's decision", skipped[0]["error"], "decision, taken by the recipient")
check("…under the same broadcast kind as the rest", skipped[0]["kind"], result["kind"])
check("…and was never sent", skipped[0]["sent_at"], None)

check("the audit entry names who was skipped", audits()[0]["meta"]["unsubscribed_skipped"], ["bob@example.com"])
check(
    "the audit entry's resolved audience excludes them",
    audits()[0]["meta"]["audience_resolved"],
    ["ann@example.com", "cara@example.com"],
)

# The rule holds for one named person too. A composer that honours an opt-out
# for a mailshot and ignores it for a single send has not honoured it.
reset_world()
mute("ann@example.com")
exc = refuses(
    "a send to one person who opted out is refused",
    lambda: bc.send(spec="person:ann@example.com", actor=OWNER, **MESSAGE),
    error=bc.AudienceUnresolved,
)
contains("…and the refusal says so", str(exc), "unsubscribed")
check("…and nothing left the machine", PROVIDER.sent, [])


# ══════════════════════════════════════════════════════════════════════════════
# 7. The count is a control, not a dialog
# ══════════════════════════════════════════════════════════════════════════════

reset_world()  # three app users; the confirm threshold is 3

settings.broadcast_confirm_above = 2
exc = refuses(
    "a send over the threshold with no confirmation is refused",
    lambda: bc.send(spec="all_users", actor=OWNER, **MESSAGE),
)
contains("…and the refusal states the real number", str(exc), "3")
contains("…and says what to send back", str(exc), "confirm_recipients")
check("…having sent nothing", PROVIDER.sent, [])
check("…and written no audit entry", audits(), [])

exc = refuses(
    "a confirmation for the wrong number is refused",
    lambda: bc.send(spec="all_users", actor=OWNER, confirm_recipients=7, **MESSAGE),
)
contains("…naming what it actually resolves to", str(exc), "3")
contains("…and what was confirmed", str(exc), "7")
check("…having sent nothing", PROVIDER.sent, [])

result = send("all_users", confirm_recipients=3)
check("the right number goes through", result["accepted"], 3)

# Below the threshold no confirmation is asked for — the control is about size.
reset_world()
settings.broadcast_confirm_above = 10
result = send("all_users")
check("a small audience needs no confirmation", result["accepted"], 3)
settings.broadcast_confirm_above = 3


# ══════════════════════════════════════════════════════════════════════════════
# 8. One delivery layer. Every recipient is a row in the same log.
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
result = send("all_sellers", MARKETING_ADMIN)

rows = deliveries()
check("one delivery row per recipient, gaps included", len(rows), 2)
check("every row is the same kind", sorted({r["kind"] for r in rows}), [result["kind"]])
check("the kind names this send", result["kind"].startswith("broadcast."), True)
check("every row carries the spec", sorted({r["spec"] for r in rows}), [bc.SPEC])
check(
    "every row is classed as an announcement",
    sorted({r["sensitivity"] for r in rows}),
    [str(mail.Sensitivity.ANNOUNCEMENT)],
)
check("every row carries the broadcast id in its meta",
      sorted({r["meta"]["broadcast_id"] for r in rows}), [result["broadcast_id"]])
check("every row points back at the audit entry",
      sorted({r["meta"]["audit_id"] for r in rows}), [audits()[0]["_id"]])

sent_row = [r for r in rows if r["to"] == "one@seller.com"][0]
gap_row = [r for r in rows if r["to"] == ""][0]
check("the seller with an address was sent to", sent_row["outcome"], str(mail.Outcome.SENT))
check("the seller with none is a recorded gap", gap_row["outcome"], str(mail.Outcome.NO_ADDRESS))
check("…which the log counts as a failure to look at",
      gap_row["outcome"] in mail.FAILURE_OUTCOMES, True)
check("…naming the partner", gap_row["to_name"], "Second Seller")
check("the response counts the gap as a failure", result["failed"], 1)
check("the response counts the send as accepted", result["accepted"], 1)
check("the response links into the delivery log for this send",
      result["delivery_log"], f"/tech/email?kind={result['kind']}")

# The dedupe key is per recipient: one person's failure never suppresses
# another's, and the same broadcast cannot double-send.
check(
    "each row carries its own dedupe key",
    sorted(r["dedupe_key"] for r in rows),
    sorted([
        f"{result['broadcast_id']}:no-address:sl-2",
        f"{result['broadcast_id']}:one@seller.com",
    ]),
)

# TWO partners with no address must be TWO rows. The obvious implementation —
# handing everybody to `deliver_many` with a `dedupe_prefix` — keys on the
# address, so two empty addresses produce one key, the unique index catches the
# second, and it is filed as a `duplicate`. That would report one gap where
# there are two, which is the exact failure `no_address` exists to prevent.
reset_world()
DB.seed(
    C.PARTNERS,
    [{"_id": "sl-9", "kind": "seller", "status": "approved", "is_active": True,
      "name": "Also No Document"}],
)
result = send("all_sellers", MARKETING_ADMIN)
gaps = [r for r in deliveries() if r["outcome"] == str(mail.Outcome.NO_ADDRESS)]
check("two partners with no address leave two rows, not one", len(gaps), 2)
check(
    "…each naming the partner it is about",
    sorted(g["to_name"] for g in gaps),
    ["Also No Document", "Second Seller"],
)
check(
    "…on distinct dedupe keys",
    len({g["dedupe_key"] for g in gaps}),
    2,
)
check("…and neither is filed as a duplicate of the other",
      [g for g in deliveries() if g["outcome"] == str(mail.Outcome.DUPLICATE)], [])
check("the response counts both gaps as failures", result["failed"], 2)
again = run(
    bc._dispatch(
        [mail.Recipient(email="one@seller.com", name="First Seller", role=str(Role.SELLER))],
        kind=result["kind"], subject="s", html="<p>x</p>", attachments=[],
        identity=mail.SenderIdentity.BULK, unsubscribe=bc.unsubscribe_target(),
        broadcast_id=result["broadcast_id"], audit_id="a",
    )
)
check(
    "re-running the same broadcast sends nothing twice",
    again["sent_rows"][0]["outcome"],
    str(mail.Outcome.DUPLICATE),
)
check("…and no second message left the machine", len(PROVIDER.sent), 1)


# ══════════════════════════════════════════════════════════════════════════════
# 9. Bulk identity and the unsubscribe headers
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
result = send("all_users", confirm_recipients=3)

check("a mass send goes out as bulk", result["sender_identity"], str(mail.SenderIdentity.BULK))
check("…from the bulk address", PROVIDER.sent[0]["from"], "news@zipper.app")
check("…and no Reply-To (spec §12: never set, on any identity)", PROVIDER.sent[0]["reply_to"], None)

headers = PROVIDER.sent[0]["headers"]
ok("a broadcast carries List-Unsubscribe", "List-Unsubscribe" in headers)
ok("…and the one-click POST header, since a URL is configured",
   headers.get("List-Unsubscribe-Post") == "List-Unsubscribe=One-Click")
ok("…and a List-Id naming the stream", bc.STREAM in headers.get("List-Id", ""))

row = deliveries()[0]
check("the row says it was bulk", row["bulk"], True)
ok("…and records that the headers were attached", "List-Unsubscribe" in row["headers_sent"])
ok(
    "…without storing the per-address token anybody could replay",
    not any(
        "List-Unsubscribe=" in str(v) and "http" in str(v)
        for v in row["headers_sent"]
    ),
)

# The token in the header is the one the unsubscribe endpoint will accept, so
# the link in the footer is not decorative.
token_url = headers["List-Unsubscribe"].split(">")[0].lstrip("<")
token = token_url.split("t=")[1].split("&")[0]
ok(
    "the unsubscribe link carries a token the endpoint honours",
    mail.unsubscribe_token_valid("ann@example.com", bc.STREAM, bc.CADENCE, token),
)
ok(
    "…and that token unsubscribes nobody else",
    not mail.unsubscribe_token_valid("bob@example.com", bc.STREAM, bc.CADENCE, token),
)

# A sender who picks the transactional address for a mailshot is overridden,
# and told. The three streams exist to fail separately.
reset_world()
result = send("all_users", confirm_recipients=3, identity="transactional")
check("a mass send cannot leave from the transactional address",
      result["sender_identity"], str(mail.SenderIdentity.BULK))
contains("…and the override is explained", result["sender_identity_note"], "payout receipts")

# One person is a conversation: the support mailbox by default, not overridden.
reset_world()
result = send("person:ann@example.com", SUPPORT_ADMIN)
check("a single-person send defaults to the support identity",
      result["sender_identity"], str(mail.SenderIdentity.SUPPORT))
check("…and is not overridden", result["sender_identity_note"], "")
check("…from the mailbox a human reads", PROVIDER.sent[0]["from"], "support@zipper.app")
ok("…and still carries an unsubscribe route it will honour",
   "List-Unsubscribe" in PROVIDER.sent[0]["headers"])

reset_world()
result = send("person:ann@example.com", SUPPORT_ADMIN, identity="transactional")
check("a single-person send may choose its identity",
      result["sender_identity"], str(mail.SenderIdentity.TRANSACTIONAL))

exc = refuses(
    "an identity that does not exist is refused",
    lambda: bc.send(spec="person:ann@example.com", actor=SUPPORT_ADMIN,
                    identity="marketing", **MESSAGE),
)
contains("…listing the ones that do", str(exc), "transactional")


# ══════════════════════════════════════════════════════════════════════════════
# 10. Attachments — the shared preparation, and nothing else
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
big = b"x" * (int(settings.email_max_attachment_bytes) + 1)
result = send(
    "person:ann@example.com",
    SUPPORT_ADMIN,
    attachments=[
        mail.Attachment(filename="notes.csv", data=b"a,b\n1,2\n", content_type="text/csv"),
        # The same name twice: renamed, never shadowed and never dropped.
        mail.Attachment(filename="notes.csv", data=b"c,d\n3,4\n", content_type="text/csv"),
        # A charset in the type — the exact bug that made every report email
        # fail. It must never reach the provider.
        mail.Attachment(filename="terms.pdf", data=b"%PDF-1.4", content_type="application/pdf; charset=utf-8"),
        mail.Attachment(filename="huge.zip", data=big, content_type="application/zip"),
        mail.Attachment(filename="empty.txt", data=b"", content_type="text/plain"),
    ],
)

check(
    "a duplicate filename is renamed rather than dropped",
    [a["filename"] for a in result["attachments"]],
    ["notes.csv", "notes_2.csv", "terms.pdf"],
)
omitted = {o["filename"]: o["reason"] for o in result["attachments_omitted"]}
check("the oversized and the empty files are the ones left off",
      sorted(omitted), ["empty.txt", "huge.zip"])
contains("…and the size limit is stated", omitted["huge.zip"], "per-file limit")
check("the message still went", result["accepted"], 1)
contains("…and names every omission for the reader", result["attachments_note"], "huge.zip")
contains("…in the body of the email itself", PROVIDER.sent[0]["html"], "huge.zip")
contains("…including the empty one", PROVIDER.sent[0]["html"], "empty.txt")

wire_types = [a["parts"][2] for a in PROVIDER.sent[0]["attachments"]]
check(
    "no MIME type with a parameter ever reaches the provider",
    [t for t in wire_types if ";" in str(t)],
    [],
)
check("…the charset is stripped, not the type", "application/pdf" in wire_types, True)

row = deliveries()[0]
check("the delivery row lists what was attached",
      sorted(a["filename"] for a in row["attachments"]),
      ["notes.csv", "notes_2.csv", "terms.pdf"])
check("…and what was not, with the reason",
      sorted(o["filename"] for o in row["attachments_omitted"]),
      ["empty.txt", "huge.zip"])


# ══════════════════════════════════════════════════════════════════════════════
# 11. The audit entry — who, why, and exactly who it reached
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
result = send("all_agencies", MARKETING_ADMIN, reason="Notifying agencies of the new payout day.")

check("one send, one audit entry", len(audits()), 1)
entry = audits()[0]
check("the action names what happened", entry["action"], "broadcast.email_sent")
check("the subject is the broadcast", entry["subject"], {"type": "broadcast", "id": result["broadcast_id"]})
check("the reason is carried verbatim", entry["reason"], "Notifying agencies of the new payout day.")
check("the actor is the person who sent it", entry["actor"]["uid"], "u-mkt-admin")
check("…with the role they used", entry["actor"]["role"], str(Role.MARKETING_ADMIN))
check("the entry records the audience label", entry["after"]["audience"], "all_agencies")
check(
    "the entry records the audience as it RESOLVED, address by address",
    entry["meta"]["audience_resolved"],
    ["north@agency.com", "sub@agency.com"],
)
check(
    "…which is exactly who was written to",
    entry["meta"]["audience_resolved"],
    sorted(s["to"] for s in PROVIDER.sent),
)
contains("the entry says where the audience came from", entry["meta"]["audience_source"], "firestore")
check("the entry carries the subject line", entry["after"]["subject"], MESSAGE["subject"])
check("the entry carries the sender identity", entry["after"]["identity"], str(mail.SenderIdentity.BULK))
check("the response hands back the audit id", result["audit_id"], entry["_id"])

# A reason is mandatory, and it is refused before anything is resolved or sent.
reset_world()
for empty in ("", "   "):
    exc = refuses(
        f"a send with reason {empty!r} is refused",
        lambda e=empty: bc.send(
            spec="all_agencies", actor=MARKETING_ADMIN,
            subject=MESSAGE["subject"], body=MESSAGE["body"], reason=e,
        ),
    )
    contains("…and says why a reason is needed", str(exc), "six months from now")
check("…having sent nothing", PROVIDER.sent, [])
check("…and written nothing", audits(), [])

# An audit log that cannot be written is a send that does not happen.
reset_world()
DB[C.AUDIT].fail_writes = PyMongoError("audit collection is read-only")
exc = refuses(
    "a broadcast whose audit entry cannot be written sends nothing",
    lambda: bc.send(spec="all_agencies", actor=MARKETING_ADMIN, **MESSAGE),
)
contains("…and says so", str(exc), "nothing was sent")
check("…literally nothing", PROVIDER.sent, [])
check("…including no delivery rows", deliveries(), [])
DB[C.AUDIT].fail_writes = None


# ══════════════════════════════════════════════════════════════════════════════
# 12. The message itself
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
result = send("person:ann@example.com", SUPPORT_ADMIN)
html = PROVIDER.sent[0]["html"]
check("the subject is the subject", PROVIDER.sent[0]["subject"], MESSAGE["subject"])
contains("blank lines become paragraphs", html, "This is the first paragraph.<br>Still the first.")
contains("…and the second paragraph is its own", html, "And a second.")
ok("every message carries a plain-text alternative", len(PROVIDER.sent[0]["text"].strip()) > 20)

# Typed HTML arrives as characters. A composer is not a way to put a script tag
# in five thousand mailboxes with the company's DKIM signature on it.
reset_world()
send("person:ann@example.com", SUPPORT_ADMIN,
     body="<script>alert(1)</script> and <b>bold</b>")
html = PROVIDER.sent[0]["html"]
check("a typed script tag is escaped, not sent", "<script>" in html, False)
contains("…and arrives as the characters that were typed", html, "&lt;script&gt;")
check("typed markup is not honoured either", "<b>bold</b>" in html, False)

for bad_subject, why in (("", "an empty subject"), ("x" * 200, "a subject nobody will see the end of")):
    exc = refuses(
        f"{why} is refused",
        lambda s=bad_subject: bc.send(
            spec="person:ann@example.com", actor=SUPPORT_ADMIN,
            subject=s, body="hello", reason="r",
        ),
    )
    ok(f"{why} refusal explains itself", exc is not None and len(str(exc)) > 40)

exc = refuses(
    "an empty body is refused",
    lambda: bc.send(spec="person:ann@example.com", actor=SUPPORT_ADMIN,
                    subject="Hello", body="   ", reason="r"),
)
contains("…because it is the strongest spam signal there is", str(exc), "spam signal")

# Spam wording is a warning on the way out, not a refusal. Marketing knows
# things a regex does not; a composer that refuses is one people work around.
reset_world()
result = send("person:ann@example.com", SUPPORT_ADMIN, subject="URGENT FREE OFFER!!")
ok("a shouting subject is sent…", result["accepted"] == 1)
ok("…with the problem reported back to the sender", len(result["warnings"]) >= 1)
contains("…naming what a filter will object to", " ".join(result["warnings"]), "capitals")


# ══════════════════════════════════════════════════════════════════════════════
# 13. Throttling — a rate limit stops the send and names what it skipped
# ══════════════════════════════════════════════════════════════════════════════
#
# `deliver_many` has no backoff: a 429 is recorded as a failed delivery with the
# provider's own words. Riding through a throttle would turn a pause that would
# have cleared into hundreds of rows indistinguishable from real rejections, so
# the send stops instead — and the addresses it never tried are the answer to
# "what do I re-send".

reset_world()
users = FS.collection("users")
for n in range(10):
    users.docs[f"bulk-{n}"] = {"email": f"bulk{n}@example.com", "name": f"User {n}"}

PROVIDER.next_status = 429
PROVIDER.next_body = b'{"errors":[{"message":"too many requests"}]}'

resolved = run(bc.resolve("all_users"))
result = send("all_users", confirm_recipients=resolved.count)

check("the send stopped early", result["stopped_early"], True)
contains("…saying the provider rate-limited it", result["stop_reason"], "rate-limited")
ok("…and it did not attempt everybody", len(result["not_attempted"]) > 0)
check(
    "every address is either attempted or named as not attempted",
    len({d["to"] for d in deliveries()} | set(result["not_attempted"])),
    resolved.count,
)
check(
    "nothing is both attempted and reported as skipped",
    {d["to"] for d in deliveries()} & set(result["not_attempted"]),
    set(),
)
throttled = [d for d in deliveries() if d["provider_status"] == 429]
ok("the throttled attempts are recorded as failures", len(throttled) > 0)
check("…as failures the log surfaces", throttled[0]["outcome"] in mail.FAILURE_OUTCOMES, True)
contains("…keeping the provider's own words", str(throttled[0]["provider_error_body"]), "too many requests")

PROVIDER.next_status = 202
PROVIDER.next_body = b""


# ══════════════════════════════════════════════════════════════════════════════
# 14. The preview — the same numbers the send will use
# ══════════════════════════════════════════════════════════════════════════════

reset_world()
mute("bob@example.com")

view = run(bc.preview("all_users", user=OWNER))
check("the preview counts who will actually be written to", view["count"], 2)
check("…and separately how many resolved", view["resolved_count"], 3)
check("…and how many opted out", view["unsubscribed_count"], 1)
check("…naming them", view["unsubscribed"], ["bob@example.com"])
check("the sample is the audience when the audience is small", view["sample_is_all"], True)
check(
    "the sample is who will be written to",
    [s["email"] for s in view["sample"]],
    ["ann@example.com", "cara@example.com"],
)
check("the preview says a confirmation is not needed here", view["confirm_required"], False)
contains("the preview says where the audience came from", view["source"], "firestore `users`")
check("the preview sends nothing", PROVIDER.sent, [])
check("the preview records nothing", deliveries(), [])
check("the preview audits nothing", audits(), [])

# The preview is behind the same authority as the send: the sample is a list of
# customer addresses.
refuses(
    "a marketing admin cannot preview the whole customer base either",
    lambda: bc.preview("all_users", user=MARKETING_ADMIN),
    error=bc.NotAuthorised,
)
refuses(
    "and neither can the observer",
    lambda: bc.preview("all_agencies", user=OBSERVER),
    error=bc.NotAuthorised,
)

# The number the preview reports is the number the send demands back.
settings.broadcast_confirm_above = 1
view = run(bc.preview("all_users", user=OWNER))
check("the preview says a confirmation IS needed here", view["confirm_required"], True)
result = send("all_users", confirm_recipients=view["count"])
check("the preview's count is the one the send accepts", result["accepted"], view["count"])
settings.broadcast_confirm_above = 3


# ══════════════════════════════════════════════════════════════════════════════
# 15. The API key is on no row, in no subject, in no body
# ══════════════════════════════════════════════════════════════════════════════

import json  # noqa: E402

blob = json.dumps(deliveries() + audits(), default=str)
ok("the SendGrid key appears on nothing this module wrote", settings.sendgrid_api_key not in blob)
ok("nor does the JWT secret", (settings.jwt_secret or "\0") not in blob)


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

print()
print("Who may send a composed email, by audience")
print("─" * 78)
seen_pairs: set[tuple[str, str]] = set()
for audience_name, who_label, verdict in authority_rows:
    if (audience_name, who_label) in seen_pairs:
        continue
    seen_pairs.add((audience_name, who_label))
    print(f"  {audience_name:<26} {who_label:<22} {verdict}")
print("─" * 78)
print()

if failures:
    print(f"FAILED — {len(failures)} of {checks} checks\n")
    for failure in failures:
        print(f"  ✗ {failure}")
    sys.exit(1)

print(f"PASSED — {checks} checks")
