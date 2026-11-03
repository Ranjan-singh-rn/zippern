"""Composed email — the one message a person writes, to an audience they pick.

Spec 8A.7.2. Every other email this system sends is generated from a record: a
payout was approved, a week ended, a threshold tripped. Nobody types those. This
module is the other kind — a subject, a body, some files, and a choice of who
gets it — and it exists because the CRM had no way at all to write to its own
customers except by opening Gmail.

**It is not a second delivery path.** A composed message is built here and then
handed to `email.deliver_many`, one row per recipient in `email_deliveries`,
with the same role gate, the same attachment preparation, the same bounce
handling and the same failure reporting as a payout receipt. `/tech/email` shows
a broadcast beside everything else, because if the composer had its own sender
the delivery log would stop being the truth about what this business sends.

Four things shape the module, and each of them is a refusal rather than a
best-effort:

  1. **An audience is resolved whole or not at all.** "All coin sellers" means
     every approved, active seller. If the partner list reads but the Firestore
     documents carrying their addresses do not, the answer is not "the 340 we
     could resolve" — it is a refusal, because a half-sent broadcast is
     indistinguishable from a fully-sent one from the outside and nobody can
     tell afterwards which half arrived. `AudienceUnresolved` is raised and
     nothing is written, recorded or sent.

  2. **A person who opted out stays out.** The suppression list is
     `notify.subscriptions("broadcast", "")` — the same table the RFC 8058
     one-click endpoint writes to (`routers/notifications.py::
     one_click_unsubscribe`), so the unsubscribe link in the footer of a
     broadcast actually works. If that table cannot be read, the send is
     refused. This is deliberately stricter than `notify.resolve`, which lets a
     scheduled report go out to its standing audience when the table is
     unreadable: a report to five staff who asked for it is not the same risk as
     a mailshot to every customer with no way to check who said no.

  3. **Authority scales with blast radius**, not with the verb. See
     `authority_for`.

  4. **The count is a control, not a decoration.** Above
     `settings.broadcast_confirm_above` the caller must send back the exact
     number the audience resolved to. Getting it wrong is a refusal that states
     the real figure. A UI confirmation dialog can be clicked through; this
     cannot, and it is the same check whether the request came from the CRM or
     from curl.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

from app.config import settings
from app.core import audit
from app.core import roles as R
from app.core.compat import StrEnum
from app.core.roles import Role
from app.services import email as mail
from app.services import notify

log = logging.getLogger(__name__)


#: Everything this module sends wears this `spec` on its delivery row.
SPEC = "8A.7.2"

#: The stream key a composed message belongs to, in `report_subscriptions`.
#: One key for every composed send, deliberately: a recipient turning this off
#: is saying "stop writing to me", not "stop writing to me about that one
#: campaign". A campaign-level opt-out would need a campaign-level list, and
#: nobody would ever reconcile the two.
STREAM = "broadcast"
#: A broadcast has no cadence — it happens when a person decides it does. Kept
#: as the empty string because that is what `unsubscribe_token`,
#: `bulk_headers` and the one-click endpoint's `c` parameter all default to, so
#: a link generated here is honoured by the endpoint unchanged.
CADENCE = ""


class Action:
    """Audit actions this module adds.

    `core/audit.py` has no entry for sending mail and is not this module's to
    edit, so these follow the same `noun.verb` convention every other service
    uses and read identically in `/audit`.
    """

    #: One composed send, written **before** the first message leaves. See
    #: `send()` for why it is before and not after.
    BROADCAST_SENT = "broadcast.email_sent"


# ══════════════════════════════════════════════════════════════════════════════
#  Refusals
# ══════════════════════════════════════════════════════════════════════════════


class BroadcastError(Exception):
    """Refused by a rule in this module. The message is safe to show a caller."""


class AudienceUnresolved(BroadcastError):
    """The audience could not be established in full, so nothing was sent.

    Its own class because it is the one failure that must never degrade into a
    partial send. Everything that raises it does so *before* the audit entry is
    written, so a refused broadcast leaves no trace of having been half-started.
    """


class NotAuthorised(BroadcastError):
    """This account may not write to this many people."""


# ══════════════════════════════════════════════════════════════════════════════
#  Audiences
# ══════════════════════════════════════════════════════════════════════════════


class Audience(StrEnum):
    """The four things a sender can choose. There is no fifth, on purpose.

    A free-form filter — "everyone in Bihar who spent over ₹500" — is a
    different feature with a different risk: nobody reviewing the send can tell
    from the label who it reached. These four are each a sentence a person can
    check against the preview.
    """

    #: Every approved, active agency and sub-agency. A sub-agency is a business
    #: of its own that happens to be paid through a parent (9.9), so it is
    #: written to in its own right — the same rule `notify.approved_partners`
    #: applies to statements.
    ALL_AGENCIES = "all_agencies"
    #: Every approved, active coin seller.
    ALL_SELLERS = "all_sellers"
    #: Every app user with an email address on their profile. The whole customer
    #: base.
    ALL_USERS = "all_users"
    #: One named person, found by address in one of the records above. Not an
    #: arbitrary address: see `_find_person`.
    PERSON = "person"


#: Firestore collections. Named here rather than inline so the two places that
#: read them cannot drift; `notify.py` holds the same two names for the same
#: reason and this module reuses its address-field list below.
FS_AGENCIES = "agencies"
FS_SELLERS = "sellers"
FS_USERS = "users"

#: The order `notify.partner_recipient` tries, reused rather than restated. A
#: partner's address lives on a different field depending on which registration
#: form created the record, and a second copy of that list here is a second
#: thing to forget to update.
PARTNER_ADDRESS_FIELDS: tuple[str, ...] = tuple(notify._ADDRESS_FIELDS)

#: What an app user's address is called on their Firestore profile. One field:
#: `app/routers/users.py` and the CRM's user screens both read `email` and
#: nothing else, so a second candidate here would be inventing a field.
USER_ADDRESS_FIELD = "email"


def parse_audience(spec: str) -> tuple[Audience, str]:
    """`"person:a@b.com"` → `(Audience.PERSON, "a@b.com")`. Refuses anything else.

    An audience this function does not recognise is a refusal, never a fallback
    to "nobody" — an audience that silently resolves to zero people is how a
    broadcast reports success and reaches no one.
    """
    head, _, tail = str(spec or "").strip().partition(":")
    head = head.strip().lower()
    param = tail.strip()

    try:
        audience = Audience(head)
    except ValueError:
        raise BroadcastError(
            f"'{spec}' is not an audience. It is one of: "
            f"{', '.join(str(a) for a in Audience if a is not Audience.PERSON)}, "
            "or person:<email address>."
        ) from None

    if audience is Audience.PERSON:
        if "@" not in param:
            raise BroadcastError(
                "A single-person send needs an address — 'person:name@example.com'. "
                f"Got {spec!r}."
            )
    elif param:
        raise BroadcastError(
            f"'{head}' takes no parameter, and {param!r} was given. An audience "
            "that quietly ignores part of what it was asked for is not one "
            "anybody can check."
        )
    return audience, param.lower()


def audience_label(audience: Audience, param: str = "") -> str:
    """The audience as a sentence, for a confirmation screen and the audit log."""
    return {
        Audience.ALL_AGENCIES: "every approved, active agency and sub-agency",
        Audience.ALL_SELLERS: "every approved, active coin seller",
        Audience.ALL_USERS: "every app user with an email address",
        Audience.PERSON: f"one person — {param}",
    }[audience]


# ══════════════════════════════════════════════════════════════════════════════
#  Authority — 1.2 / 1.4, and the size of the hole a mistake makes
# ══════════════════════════════════════════════════════════════════════════════
#
# The question is not "is this person allowed to send email". It is "how many
# strangers is this person allowed to put a message in front of, in one click,
# with the company's name on it". Those are different questions and they have
# different answers, so authority here is graded by audience rather than granted
# once for the route.
#
#   one person        → any team admin, or an owner.
#       This is customer care: Support replying to somebody who wrote in, Ops
#       chasing one agency for a document. It reaches exactly the person named
#       and the address had to be found on a real record first, so the worst
#       case is one wasted email. Refusing it to Support would mean the feature
#       does not do the thing the owner asked for ("later we have customer care
#       like email, noreply or reply kind of email").
#
#   every agency,     → a marketing admin, or an owner.
#   every seller
#       A few hundred businesses we hold a contract with. Marketing owns the
#       wording of partner-facing mail already — `services/email.py` says so at
#       the template section, 8A.7.2 — and these are the people the company
#       talks to on purpose. A marketing *member* is deliberately not on this
#       list: a member drafts, an admin decides it goes. That is the same shape
#       as every other admin/member split in `roles.py`, and it costs one
#       conversation rather than a retraction.
#
#   every app user    → an owner, and nobody else.
#       This is the whole customer base and the blast radius is the business's
#       reputation, not its inbox. A bad broadcast here cannot be recalled, is
#       read by people who never agreed to hear from us about anything except
#       their account, and every spam complaint it earns is charged against the
#       sending domain — which is the same domain the payout receipts and the
#       password resets leave from. `roles.py::can_sign_money` reserves
#       irreversible things for owners for exactly this reason, and there is no
#       principled difference between "moves money out of the company" and
#       "spends the company's deliverability".
#
#       This is the "owner signature" for the largest audience, and it is a
#       signature rather than a card on the money board on purpose: a card
#       (`services/cards.py`) needs a verifier and a signer who are different
#       people, which is right for money and wrong for a message that is
#       time-sensitive and moves nothing. Marketing composes it; an owner is the
#       one who presses send. The audit entry names them.
#
# Two roles are refused at every size, before any of this is consulted:
# the Observer (`can_write` is false — 1.1.4) and any external partner. A
# machine credential has no route here at all: no service credential in
# `core/security.py` carries a broadcast operation, and there is deliberately
# none to add.


def authority_for(audience: Audience) -> tuple[frozenset[Role], str]:
    """Who may send to this audience, and the sentence explaining why not."""
    if audience is Audience.PERSON:
        return (
            frozenset(R.ADMIN_ROLES | {Role.OWNER}),
            "Writing to one named person is a team admin's or an owner's to do. "
            "A team member raises it with their admin.",
        )
    if audience is Audience.ALL_USERS:
        return (
            frozenset({Role.OWNER}),
            "A message to every app user is the whole customer base, it cannot "
            "be recalled, and every spam complaint it earns is charged against "
            "the domain the payout receipts leave from. An owner sends this "
            "one. Compose it and ask an owner to press send.",
        )
    return (
        frozenset({Role.MARKETING_ADMIN, Role.OWNER}),
        "A message to every agency or every coin seller goes out over "
        "Marketing's name, so a marketing admin or an owner sends it. A "
        "marketing member drafts it.",
    )


def check_authority(user: Mapping[str, Any], audience: Audience) -> Role:
    """Refuse the send unless this account may reach this audience.

    Returns the caller's role, so the caller does not re-derive it and the two
    cannot disagree.
    """
    raw = user.get("role")

    if R.is_system(raw):
        raise NotAuthorised(
            "A composed message is written by a person and signed with their "
            "name in the audit log. No machine credential may send one, and "
            "there is no key to grant."
        )
    try:
        role = Role(str(raw))
    except ValueError:
        raise NotAuthorised(
            f"{raw!r} is not a role this system issues, so what it may send is "
            "not a question with an answer. Nothing was sent."
        ) from None

    if not R.is_internal(role):
        raise NotAuthorised("Not available to partner accounts.")
    if not R.can_write(role):
        raise NotAuthorised("The observer account is read-only.")

    allowed, why = authority_for(audience)
    if role not in allowed:
        raise NotAuthorised(why)

    # ── `can_send_broadcasts`, and only for a bulk audience ──────────────────
    #
    # The CRM grants this capability to Marketing and the owners, and a broadcast
    # is what it is named for. It is asserted here rather than as a dependency on
    # `POST /broadcasts/email`, because the audience arrives in the body and a
    # route-level gate could only ask for the strictest reading of it — which
    # would take `person` away from the five department admins the clause above
    # deliberately gives it to. Writing to one named person is a customer-care
    # reply, not a broadcast; Support answering a ticket by email is the whole
    # reason `authority_for(PERSON)` is written the way it is.
    #
    # For the three bulk audiences the two rules agree today: `authority_for`
    # already narrows them to a marketing admin or an owner, both of whom hold
    # the capability. This is therefore not a narrowing but a floor — if that
    # role set is ever widened, a role the CRM says may not broadcast still
    # cannot, and the widening has to happen in `roles.PERMISSIONS` where both
    # halves of the system read it.
    if audience is not Audience.PERSON and not R.has_permission(
        role, R.Permission.CAN_SEND_BROADCASTS
    ):
        raise NotAuthorised(
            "Sending to a whole audience needs the 'can_send_broadcasts' "
            "permission, which this account does not have. Writing to one named "
            "person is still open to you. Nothing was sent."
        )
    return role


# ══════════════════════════════════════════════════════════════════════════════
#  Resolution — from the record, in full, or not at all
# ══════════════════════════════════════════════════════════════════════════════


class Resolved:
    """One audience, turned into addresses, with everything that was left out.

    `recipients` is what will be written to. The other three lists are the
    reason the count is what it is, and they are all reported *before* the send
    so a sender can look at the numbers and stop.
    """

    __slots__ = ("audience", "param", "recipients", "no_address", "excluded", "source")

    def __init__(
        self,
        audience: Audience,
        param: str,
        recipients: list[mail.Recipient],
        *,
        no_address: list[dict],
        excluded: list[dict],
        source: str,
    ) -> None:
        self.audience = audience
        self.param = param
        #: Sorted by address, so two resolutions of the same audience produce
        #: the same order and a delivery log is diffable.
        self.recipients = recipients
        #: Records that are part of the audience and carry no usable address.
        #: A gap in the record, shown to the sender rather than silently
        #: dropped — for a partner these still become `no_address` delivery rows.
        self.no_address = no_address
        #: Records deliberately left out, each with the reason.
        self.excluded = excluded
        #: Where the audience came from, in words. Printed on the preview so
        #: nobody has to guess whether "all users" means Mongo or Firestore.
        self.source = source

    @property
    def count(self) -> int:
        return len(self.recipients)

    def sample(self, n: int = 25) -> list[dict]:
        """Enough of the audience to see it is the right set."""
        return [
            {"email": r.email, "name": r.name, "role": r.role, "uid": r.uid}
            for r in self.recipients[: max(0, n)]
        ]

    def summary(self, *, sample_size: int = 25) -> dict:
        return {
            "audience": str(self.audience),
            "param": self.param,
            "label": audience_label(self.audience, self.param),
            "source": self.source,
            "count": self.count,
            "sample": self.sample(sample_size),
            "sample_is_all": self.count <= sample_size,
            "no_address": self.no_address[:50],
            "no_address_count": len(self.no_address),
            "excluded": self.excluded[:50],
            "excluded_count": len(self.excluded),
        }


def _fs():
    from app.db import firebase

    return firebase.firestore_client()


def _stream(collection: str, cap: int | None = None) -> list[tuple[str, dict]]:
    """Documents from one Firestore collection, as (id, data). Blocking.

    `cap` is passed straight to Firestore's own `limit`, not applied after the
    fact — the point is to stop the query, not to trim the answer. Callers ask
    for one more than their ceiling so that a full result is itself the signal
    that the audience is too large, which is a bounded read rather than a
    hundred thousand documents fetched in order to be refused.

    Any exception is left to propagate. That is the whole contract of this
    function: a collection that could not be read in full must not come back
    looking like a collection that happens to be small.
    """
    query = _fs().collection(collection)
    if cap is not None:
        query = query.limit(int(cap))
    return [(snap.id, snap.to_dict() or {}) for snap in query.stream()]


def _find_by_field(collection: str, field: str, value: str) -> list[tuple[str, dict]]:
    """Documents where one field equals one value. An indexed lookup, blocking.

    Firestore maintains a single-field index automatically, so this needs no
    configuration — and it is the difference between finding one customer and
    reading every customer to find one. Two matches would mean two records share
    an address, which the caller decides what to do about; this only reports it.
    """
    from google.cloud.firestore_v1.base_query import FieldFilter

    return [
        (snap.id, snap.to_dict() or {})
        for snap in _fs()
        .collection(collection)
        .where(filter=FieldFilter(field, "==", value))
        .limit(5)
        .stream()
    ]


def _unresolved(collection: str, what: str, exc: Exception) -> AudienceUnresolved:
    return AudienceUnresolved(
        f"{what} could not be read from Firestore ('{collection}': {exc}), so "
        "there is no way to know who is in this audience. Nothing was sent. "
        "This is deliberate: sending to the part of the audience that did "
        "resolve would be indistinguishable, afterwards, from having sent to "
        "all of it."
    )


async def _read_collection(
    collection: str, *, what: str, cap: int | None = None
) -> list[tuple[str, dict]]:
    try:
        return await asyncio.to_thread(_stream, collection, cap)
    except Exception as exc:  # noqa: BLE001 — every failure is the same refusal
        raise _unresolved(collection, what, exc) from exc


async def _lookup(collection: str, field: str, value: str, *, what: str):
    try:
        return await asyncio.to_thread(_find_by_field, collection, field, value)
    except Exception as exc:  # noqa: BLE001
        raise _unresolved(collection, what, exc) from exc


def _address_from(doc: Mapping[str, Any], fields: Sequence[str]) -> str:
    for key in fields:
        candidate = str(doc.get(key) or "").strip().lower()
        if "@" in candidate:
            return candidate
    return ""


def _too_many(count: int, what: str) -> AudienceUnresolved:
    return AudienceUnresolved(
        f"{what} comes to {count:,} recipients, over the "
        f"{settings.broadcast_max_recipients:,} this endpoint will send in one "
        "request. It is refused rather than trimmed, because a broadcast that "
        "silently reached the first two thousand of an audience is a broadcast "
        "nobody can account for. Sending to an audience this size needs the "
        "send moved onto a queue — see 'What still needs doing' in the "
        "broadcast section of the README."
    )


async def _resolve_partners(kind: str) -> Resolved:
    """Every approved, active partner of one kind, with the address on its record.

    Two sources and both are named, because they answer different halves:

      * **Mongo `partners`** says who the audience *is*. It is the business
        record — approved, active, this kind — and `notify.approved_partners`
        applies exactly the definition the statement run applies, so "every
        agency" here and "every agency" on the monthly statement mean the same
        set.
      * **Firestore `agencies` / `sellers`** says where each one is *written
        to*. The address lives on the registration document the partner's own
        owner controls, which is why it is not duplicated into Mongo.

    Read in one stream rather than one document per partner: five hundred
    sequential Firestore gets inside an HTTP request is a timeout, and a
    per-document read would have to decide what to do about the four hundredth
    one failing — which is the question this module refuses to answer partially.
    """
    audience = (
        Audience.ALL_AGENCIES if kind == "agency" else Audience.ALL_SELLERS
    )
    ceiling = int(settings.broadcast_max_recipients)

    # `notify.approved_partners` clamps its own limit at 5,000. Asking for more
    # than that would come back clamped and look complete, so the ceiling is
    # checked against the clamp rather than trusted.
    if ceiling + 1 > 5_000:
        raise AudienceUnresolved(
            f"BROADCAST_MAX_RECIPIENTS is {ceiling:,}, and the partner list "
            "cannot be read beyond 5,000 records in one query "
            "(`notify.approved_partners`). Above that the audience cannot be "
            "shown to be complete, so it is refused rather than assumed."
        )

    try:
        partners = await notify.approved_partners(kind, limit=ceiling + 1)
    except Exception as exc:  # noqa: BLE001
        raise AudienceUnresolved(
            f"The partner list could not be read from Mongo ({exc}), so who is "
            "in this audience is unknown. Nothing was sent."
        ) from exc

    if len(partners) > ceiling:
        raise _too_many(len(partners), audience_label(audience).capitalize())

    collection = FS_AGENCIES if kind == "agency" else FS_SELLERS
    documents = dict(
        await _read_collection(
            collection, what=f"The {kind} registration documents"
        )
    )

    recipients: list[mail.Recipient] = []
    no_address: list[dict] = []
    role = str(Role.SELLER if kind == "seller" else Role.AGENCY)

    for partner in partners:
        partner_id = str(partner.get("_id") or partner.get("id") or "")
        name = str(partner.get("name") or "") or partner_id
        doc = documents.get(partner_id) or {}
        address = _address_from(doc, PARTNER_ADDRESS_FIELDS)
        if not address:
            # A partner on the approved list with no address anywhere on their
            # registration document. Not a resolution failure — the record was
            # read successfully and this is what it says — but a gap in the
            # record all the same, so it is named on the preview and it still
            # becomes a `no_address` delivery row naming the partner (8A.2.15).
            no_address.append(
                {
                    "id": partner_id,
                    "name": name,
                    "reason": (
                        f"no address on {collection}/{partner_id}"
                        if partner_id in documents
                        else f"no {collection} document for this partner at all"
                    ),
                }
            )
        recipients.append(
            mail.Recipient(email=address, name=name, role=role, uid=partner_id)
        )

    recipients.sort(key=lambda r: (r.email, r.uid or ""))
    return Resolved(
        audience,
        "",
        recipients,
        no_address=no_address,
        excluded=[],
        source=(
            f"Mongo `partners` (approved and active, kind {kind}) for who they "
            f"are; Firestore `{collection}` for the address on each one's own "
            "registration document."
        ),
    )


async def _resolve_users() -> Resolved:
    """Every app user with an address, from Firestore `users`.

    Two exclusions, and both are counted rather than quietly applied:

      * **no email on the profile.** An app account can be created with a phone
        number alone, and those accounts are not part of an *email* audience at
        all — they are not a gap in a record the way an agency with no address
        is. They are excluded and counted. Writing a `no_address` delivery row
        for each would put thousands of rows on the failure list and make
        `/tech/email` useless for the failures that are real.
      * **banned accounts.** An account we have ejected is not somebody to send
        marketing to; continuing to mail one is how a domain earns spam
        complaints from exactly the people most likely to file them.
    """
    ceiling = int(settings.broadcast_max_recipients)
    # One more than the ceiling. A result that comes back full is the audience
    # saying it is bigger than this endpoint will send to, established without
    # reading the whole collection to find out.
    #
    # Note that the exclusions below happen *after* the cap, so a collection of
    # `ceiling + 1` documents where several are phone-only accounts refuses even
    # though the sendable audience would have fitted. That is the conservative
    # direction and it is the right one: the alternative is paging the entire
    # user collection on every preview to find out.
    documents = await _read_collection(
        FS_USERS, what="The app user profiles", cap=ceiling + 1
    )

    recipients: list[mail.Recipient] = []
    excluded: list[dict] = []
    no_email = 0
    banned = 0

    for uid, doc in documents:
        if bool(doc.get("isBanned")):
            banned += 1
            continue
        address = str(doc.get(USER_ADDRESS_FIELD) or "").strip().lower()
        if "@" not in address:
            no_email += 1
            continue
        recipients.append(
            mail.Recipient(
                email=address,
                name=str(doc.get("name") or "") or uid,
                # No role. An app user is not staff and not a partner, which is
                # why an announcement is the only class of mail `may_receive`
                # will ever let them have.
                role=None,
                uid=uid,
            )
        )

    if no_email:
        excluded.append(
            {
                "count": no_email,
                "reason": (
                    "no email address on the profile — a phone-only account, "
                    "which is not part of an email audience"
                ),
            }
        )
    if banned:
        excluded.append(
            {"count": banned, "reason": "the account is banned"}
        )

    # De-duplicate by address: two accounts can share one mailbox, and one
    # person receiving the same broadcast twice reads as a system that has lost
    # count of them.
    seen: dict[str, mail.Recipient] = {}
    duplicates = 0
    for recipient in recipients:
        if recipient.email in seen:
            duplicates += 1
            continue
        seen[recipient.email] = recipient
    if duplicates:
        excluded.append(
            {
                "count": duplicates,
                "reason": (
                    "a second account on an address already in this audience — "
                    "one mailbox receives one copy"
                ),
            }
        )

    unique = sorted(seen.values(), key=lambda r: (r.email, r.uid or ""))
    if len(documents) > ceiling:
        raise _too_many(len(documents), "Every app user")

    return Resolved(
        Audience.ALL_USERS,
        "",
        unique,
        no_address=[],
        excluded=excluded,
        source=(
            f"Firestore `{FS_USERS}` — the app user profiles, read in full. "
            "The whole collection is streamed; a read that fails is a refusal, "
            "not a shorter list."
        ),
    )


async def _find_person(address: str) -> mail.Recipient:
    """One address, matched against a real record, or a refusal.

    **A composed send is not an open relay, and this is what stops it being
    one.** `routers/notifications.py` states the invariant the rest of Part 8A
    keeps — "recipients are never taken from a request" — and a customer-care
    reply cannot keep it literally, because the whole point is to write to the
    person who wrote in. So the address is taken from the request and then
    *found*: in the staff record, in a partner's registration document, or on an
    app user's profile. An address on none of them is refused.

    That has three effects worth stating. A typo goes nowhere. Nobody can use
    the CRM to mail an arbitrary stranger from the company's domain. And the
    recipient arrives carrying the role on their record, so `email.may_receive`
    is deciding about a known person rather than about a string somebody typed.
    """
    address = str(address or "").strip().lower()

    # 1. Staff — Mongo, the authoritative record for an internal account.
    try:
        from app.db.mongo import C, get_db

        staff = await get_db()[C.STAFF].find_one(
            {"email": address, "is_active": True}
        )
    except Exception as exc:  # noqa: BLE001
        raise AudienceUnresolved(
            f"The staff record could not be searched for {address} ({exc}), so "
            "whether that address belongs to somebody here is unknown. Nothing "
            "was sent."
        ) from exc
    if staff:
        return mail.Recipient(
            email=address,
            name=str(staff.get("name") or ""),
            role=str(staff.get("role") or ""),
            uid=str(staff.get("uid") or ""),
        )

    # 2. The two partner collections — **streamed, and compared case-insensitively.**
    #
    # An indexed equality query would be the obvious choice and is the wrong one
    # here, for a reason this repository already has a migration script about:
    # partner addresses are not reliably lower-cased on the record.
    # `scripts/normalise_partner_emails.py` exists because every partner whose
    # owner typed a capital letter has `ownerEmail: "North@Agency.com"` stored
    # as typed. An `== "north@agency.com"` query finds none of them, so a
    # support reply to that agency would be refused as "not on any record here"
    # — a confident, wrong refusal, which is worse than a slow lookup.
    #
    # These two collections are bounded by the business (hundreds of partners,
    # not hundreds of thousands) and capped below in any case, so reading them
    # is affordable. `_address_from` lower-cases both sides, which is the same
    # comparison `notify.partner_recipient` makes.
    cap = int(settings.broadcast_max_recipients) + 1
    for collection, role in (
        (FS_AGENCIES, str(Role.AGENCY)),
        (FS_SELLERS, str(Role.SELLER)),
    ):
        documents = await _read_collection(
            collection, what=f"The `{collection}` records", cap=cap
        )
        for doc_id, doc in documents:
            if _address_from(doc, PARTNER_ADDRESS_FIELDS) == address:
                return mail.Recipient(
                    email=address,
                    name=str(doc.get("name") or doc.get("agencyName") or "") or doc_id,
                    role=role,
                    uid=doc_id,
                )

    # 3. App users — **the indexed lookup first, because this is the collection
    # that is actually large.** Streaming it to find one person is the
    # difference between a query and a timeout, and it is the common case: a
    # user's `email` comes from their Firebase Auth profile, and Firebase
    # lower-cases the address on the token.
    found = await _lookup(
        FS_USERS, USER_ADDRESS_FIELD, address, what="The app user profiles"
    )
    for doc_id, doc in found:
        return mail.Recipient(
            email=address,
            name=str(doc.get("name") or "") or doc_id,
            role=None,
            uid=doc_id,
        )

    # …and then a bounded scan, because "comes from Firebase Auth" is a claim
    # about how the app writes the field today, not a constraint the database
    # enforces. A profile carrying `Ann@example.com` exists as far as Firestore
    # is concerned, and the query above cannot see it.
    #
    # The scan is capped. If the collection is *larger* than the cap, the honest
    # answer is not "not found" — it is "I could not look at all of them", and
    # those two must not come back as the same sentence. A confident wrong
    # refusal is how somebody concludes a real customer does not exist.
    cap = int(settings.broadcast_max_recipients) + 1
    profiles = await _read_collection(
        FS_USERS, what="The app user profiles", cap=cap
    )
    for doc_id, doc in profiles:
        if str(doc.get(USER_ADDRESS_FIELD) or "").strip().lower() == address:
            return mail.Recipient(
                email=address,
                name=str(doc.get("name") or "") or doc_id,
                role=None,
                uid=doc_id,
            )

    if len(profiles) >= cap:
        raise AudienceUnresolved(
            f"{address} was not found, but the search was not complete: it is "
            "not a staff account, not an agency or seller registration, and no "
            f"app user profile stores it in lower case — and there are more "
            f"than {cap - 1:,} profiles, so the case-insensitive fallback could "
            "not look at all of them. Nothing was sent, because 'I did not find "
            "them' and 'I could not finish looking' are different answers and "
            "this is the second one. If the address is right, it is stored with "
            "a capital letter on a profile past the search limit."
        )

    raise AudienceUnresolved(
        f"{address} is not on any record here — not a staff account, not an "
        "agency or seller registration, and not an app user profile. It is "
        "refused rather than sent to: this composer writes to people the "
        "business has a record of, and an address that matches nothing is far "
        "more often a typo than a customer."
    )


async def resolve(spec: str) -> Resolved:
    """Turn an audience name into the addresses it means, in full or not at all."""
    audience, param = parse_audience(spec)
    if audience is Audience.ALL_AGENCIES:
        return await _resolve_partners("agency")
    if audience is Audience.ALL_SELLERS:
        return await _resolve_partners("seller")
    if audience is Audience.ALL_USERS:
        return await _resolve_users()

    recipient = await _find_person(param)
    return Resolved(
        Audience.PERSON,
        param,
        [recipient],
        no_address=[],
        excluded=[],
        source=(
            "Matched against the staff record in Mongo, then the agency, seller "
            "and app-user records in Firestore. An address on none of them is "
            "refused."
        ),
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Unsubscribes — the same table the one-click endpoint writes to
# ══════════════════════════════════════════════════════════════════════════════


async def suppressed() -> set[str]:
    """Every address that has turned composed mail off.

    Read from `report_subscriptions` under the `broadcast` key — which is where
    `POST /api/notifications/unsubscribe` writes when a recipient clicks the
    link in the footer, so the link is not decorative.

    **An unreadable table is a refusal, not a warning.** `notify.resolve` makes
    the opposite call for a scheduled report and is right to: a report to five
    people who asked for it should still arrive when a collection hiccups. A
    marketing broadcast to the entire customer base with no way to check who
    said no is the other case entirely — the cost of a delayed broadcast is
    nothing, and the cost of mailing people who opted out is a complaint rate
    that follows the domain around for months.
    """
    try:
        rows = await notify.subscriptions(STREAM, CADENCE)
    except Exception as exc:  # noqa: BLE001
        raise AudienceUnresolved(
            f"The unsubscribe list could not be read ({exc}), so there is no way "
            "to tell who has opted out. Nothing was sent. A broadcast that "
            "cannot prove it respected an opt-out is worse than a late one."
        ) from exc
    return {
        str(row.get("email") or "").strip().lower()
        for row in rows
        if row.get("muted")
    }


def unsubscribe_target() -> mail.Unsubscribe:
    """The `List-Unsubscribe` header block a composed message carries.

    On **every** composed send, including one to a single person. This module
    honours the opt-out for every audience, so advertising it for every audience
    is honest — and `email.Unsubscribe` is also what marks the message bulk,
    which is what Gmail and Yahoo have required of a sender at this volume since
    February 2024.
    """
    return mail.Unsubscribe(report=STREAM, cadence=CADENCE, one_click=True)


# ══════════════════════════════════════════════════════════════════════════════
#  The message itself
# ══════════════════════════════════════════════════════════════════════════════

_PARAGRAPH = re.compile(r"\n\s*\n")

MAX_SUBJECT_CHARS = 140
MAX_BODY_CHARS = 20_000


def render(subject: str, body: str) -> str:
    """A typed message, as the HTML that will actually be sent.

    **The body is plain text and is escaped.** A composer that accepted HTML
    would be putting whatever a staff member pasted into thousands of mailboxes
    with the company's DKIM signature on it — a tracking pixel, a form, a script
    some other tool left in the clipboard. Escaping it costs the sender bold
    text and buys back the guarantee that a broadcast contains what its author
    typed and nothing else.

    Blank lines become paragraphs and single newlines become breaks, which is
    what everybody means when they type into a box. The result goes through
    `email.page`, the same shell every other Zipper email uses, so a broadcast
    is recognisably from the same company as the payout receipt — and
    `email.deliver` derives the plain-text alternative from it exactly as it
    does for everything else.
    """
    paragraphs = [p.strip() for p in _PARAGRAPH.split(str(body or "")) if p.strip()]
    html_body = "".join(
        '<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#27272a">'
        + mail.esc(paragraph).replace("\n", "<br>")
        + "</p>"
        for paragraph in paragraphs
    )
    return mail.page(
        title=subject,
        # The preheader is what a mail client shows beside the subject. The
        # first line of the message is the honest thing to put there; a
        # separate teaser is a second subject line nobody reviewed.
        preheader=(paragraphs[0][:140] if paragraphs else subject),
        body=html_body,
        footer=(
            "Sent by the Zipper team. If you would rather not receive messages "
            "like this one, use the unsubscribe link your mail client shows for "
            "this message and we will stop."
        ),
        # QA #27: an announcement is words, not figures.
        figures=False,
    )


def message_problems(subject: str, html: str) -> list[str]:
    """Everything about this message that a spam filter reads badly.

    Warnings, not refusals. `email.subject_problems` and `email.body_problems`
    are the same checks the test suite runs over the template catalogue, so a
    composed message is held to the standard the generated ones are — but a
    person writing to a customer is allowed to know better than a heuristic,
    and a composer that refuses to send "URGENT" is a composer people work
    around by using Gmail.
    """
    return [f"The subject {p}" for p in mail.subject_problems(subject)] + [
        f"The body {p}" for p in mail.body_problems(html)
    ]


def validate(subject: str, body: str) -> tuple[str, str]:
    """The two refusals about the message itself. Everything else is a warning."""
    subject = str(subject or "").strip()
    body = str(body or "").strip()
    if not subject:
        raise BroadcastError(
            "A subject is required. An empty subject is refused outright by "
            "most receivers, so this would not arrive anywhere."
        )
    if len(subject) > MAX_SUBJECT_CHARS:
        raise BroadcastError(
            f"The subject is {len(subject)} characters. Over {MAX_SUBJECT_CHARS} "
            "is truncated by every mail client, so the end of it would not be "
            "read by anybody."
        )
    if not body:
        raise BroadcastError(
            "A body is required. A message with a subject and nothing in it is "
            "the strongest single spam signal there is."
        )
    if len(body) > MAX_BODY_CHARS:
        raise BroadcastError(
            f"The body is {len(body):,} characters, over the "
            f"{MAX_BODY_CHARS:,} limit. Attach the long version as a file."
        )
    return subject, body


def identity_for(audience: Audience, chosen: str | None) -> tuple[mail.SenderIdentity, str]:
    """Which From this leaves under, and a note when it is not the one asked for.

    A single-person send is a conversation and defaults to **support**, the
    mailbox a human reads — replying to a customer from an address that ignores
    replies is the failure `email.sender_for` already exists to stop.

    Anything larger is forced to **bulk** whatever the sender picked, and that
    override is not negotiable. The three identities are separate precisely so
    their reputations can fail separately (`email.SenderIdentity`): a mailshot
    that earns complaints from the transactional address takes the payout
    receipts and the password resets down with it. The sender is told it was
    overridden rather than having it happen quietly.
    """
    wanted = str(chosen or "").strip().lower()
    if wanted:
        try:
            picked = mail.SenderIdentity(wanted)
        except ValueError:
            raise BroadcastError(
                f"'{chosen}' is not a sender identity. It is one of: "
                f"{', '.join(str(i) for i in mail.SenderIdentity)}."
            ) from None
    else:
        picked = (
            mail.SenderIdentity.SUPPORT
            if audience is Audience.PERSON
            else mail.SenderIdentity.BULK
        )

    if audience is Audience.PERSON:
        return picked, ""
    if picked is mail.SenderIdentity.BULK:
        return picked, ""
    return (
        mail.SenderIdentity.BULK,
        f"You chose the {picked} sender; a message to more than one person was "
        "sent from the bulk address instead. The three identities exist so a "
        "reputation problem on one stream cannot stop another, and a mailshot "
        "leaving from the transactional address would put the payout receipts "
        "behind the same complaint rate.",
    )


# ══════════════════════════════════════════════════════════════════════════════
#  Preview — the count, before it is irreversible
# ══════════════════════════════════════════════════════════════════════════════


async def preview(
    spec: str,
    *,
    user: Mapping[str, Any],
    sample_size: int = 25,
) -> dict:
    """Who this audience currently resolves to, sending nothing.

    Behind the same authority as the send. The sample is a list of customer
    email addresses; somebody who may not write to an audience has no business
    reading it either.
    """
    audience, param = parse_audience(spec)
    check_authority(user, audience)

    resolved = await resolve(spec)
    muted = await suppressed()
    kept = [r for r in resolved.recipients if r.email not in muted]
    dropped = sorted({r.email for r in resolved.recipients} & muted)

    out = resolved.summary(sample_size=sample_size)
    out.update(
        {
            # `count` on a preview is the number that will actually be written
            # to. The unsubscribed are already out of it, because a confirmation
            # number that includes people who will not receive the message is a
            # number the sender cannot check anything against.
            "count": len(kept),
            "resolved_count": resolved.count,
            "sample": [
                {"email": r.email, "name": r.name, "role": r.role, "uid": r.uid}
                for r in kept[: max(0, sample_size)]
            ],
            "sample_is_all": len(kept) <= sample_size,
            "unsubscribed_count": len(dropped),
            "unsubscribed": dropped[:50],
            "confirm_required": len(kept) > int(settings.broadcast_confirm_above),
            "confirm_above": int(settings.broadcast_confirm_above),
            "max_recipients": int(settings.broadcast_max_recipients),
            "may_send": True,
            "note": (
                "This is who the audience resolves to right now. It is resolved "
                "again at the moment of sending — if a partner is approved "
                "between this preview and that send, the number will differ, "
                "and the send refuses rather than proceeding on a count that no "
                "longer matches."
            ),
        }
    )
    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Sending
# ══════════════════════════════════════════════════════════════════════════════


def _chunks(items: Sequence[Any], size: int) -> list[Sequence[Any]]:
    size = max(1, int(size))
    return [items[i : i + size] for i in range(0, len(items), size)]


def _throttled(rows: Iterable[Mapping[str, Any]]) -> bool:
    """Did the provider answer any of these with a rate limit?

    SendGrid answers a rate limit with HTTP 429. `email._from_exception` records
    the status verbatim on `provider_status`, so this reads the recorded fact
    rather than pattern-matching an error sentence.
    """
    return any(str(row.get("provider_status")) == "429" for row in rows)


def _new_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"bcast_{stamp}_{secrets.token_hex(3)}"


async def send(
    *,
    spec: str,
    subject: str,
    body: str,
    reason: str,
    actor: Mapping[str, Any],
    identity: str | None = None,
    attachments: Sequence[mail.Attachment] = (),
    confirm_recipients: int | None = None,
) -> dict:
    """Compose one message and send it, through the one delivery layer.

    The order is the design, and every step before the audit entry is a place
    the whole thing can still be refused with nothing having happened:

      1. **Validate the message** — a subject and a body, both within limits.
      2. **Check authority against the audience**, not against the route.
      3. **Resolve the audience in full.** Anything short of complete raises.
      4. **Read the opt-outs.** Unreadable is a refusal.
      5. **Check the confirmation count** against what actually resolved.
      6. **Prepare the attachments** through `email.prepare_attachments`, once,
         so the omissions are known before the first message rather than
         discovered on the delivery rows afterwards.
      7. **Write the audit entry.** If it cannot be written, nothing is sent.
      8. **Record the withheld** — one `unsubscribed_local` row per opted-out
         address, so the log says they were deliberately skipped.
      9. **Send**, in paced waves, through `email.deliver_many`.

    ── Why the audit entry is written before the send, not after ──────────────
    The audit log is append-only by design (`core/audit.py` has no update and no
    delete, deliberately), so an entry cannot be written first and completed
    later. Something has to be chosen. Writing it first means a process that
    dies half way through a broadcast still leaves a signed record of who
    authorised it, what it said and exactly which addresses it was aimed at —
    and the delivery rows say how far it got. Writing it afterwards would mean
    the one thing lost in a crash is the answer to "who sent this".

    So the split is: the **audit entry** carries the authorisation and the
    resolved audience; the **delivery log** carries the outcomes, one row per
    recipient, which is what it is for. Nothing is recorded twice.
    """
    subject, body = validate(subject, body)
    reason = str(reason or "").strip()
    if not reason:
        raise BroadcastError(
            "A reason is required, and it is written into the audit log beside "
            "the audience. 'Who sent this to everybody, and why' has to have an "
            "answer six months from now."
        )

    audience, param = parse_audience(spec)
    role = check_authority(actor, audience)

    resolved = await resolve(spec)
    muted = await suppressed()

    recipients = [r for r in resolved.recipients if r.email not in muted]
    dropped = sorted({r.email for r in resolved.recipients} & muted)
    by_address = {r.email: r for r in resolved.recipients}

    if not recipients:
        raise AudienceUnresolved(
            f"{audience_label(audience, param).capitalize()} resolves to nobody "
            "to write to"
            + (
                f" — {len(dropped)} address(es) in it have unsubscribed"
                if dropped
                else ""
            )
            + ". Nothing was sent, and that is a statement about the audience "
            "rather than about the message."
        )

    threshold = int(settings.broadcast_confirm_above)
    if len(recipients) > threshold:
        if confirm_recipients is None:
            raise BroadcastError(
                f"This will be sent to {len(recipients):,} people. Send the "
                "request again with that exact number as `confirm_recipients` "
                "to confirm it. Above "
                f"{threshold:,} recipients the count has to be looked at, "
                "because it is the last thing that can catch the wrong audience."
            )
        if int(confirm_recipients) != len(recipients):
            raise BroadcastError(
                f"The audience resolves to {len(recipients):,} people and the "
                f"request confirmed {int(confirm_recipients):,}. Nothing was "
                "sent. The audience is resolved again at the moment of sending, "
                "so a number that no longer matches means the audience changed "
                "between the preview and now — look at it again."
            )

    # Prepared **twice, deliberately.** This call is for the answer — so the
    # sender is told which files were left off and why, in the same response
    # that tells them the message went, rather than having to open a delivery
    # row to find out. `deliver()` prepares again from the *originals* below,
    # and that second pass is the one that counts: it is what adds the omission
    # sentence to the body the recipient reads and writes `attachments_omitted`
    # onto the delivery row.
    #
    # Passing the already-prepared list to `deliver()` instead would be the
    # obvious saving and is a bug: the omissions would have been stripped out
    # one frame earlier, so the second preparation would find nothing to report,
    # the email would arrive silently missing a file, and the row would claim
    # nothing was left off. `prepare_attachments` is idempotent — a prepared
    # attachment passes every check and its filename is already unique — so
    # running it twice costs a pass over the list and buys the note.
    original = list(attachments)
    sendable, omitted = mail.prepare_attachments(original)
    html = render(subject, body)
    identity_used, identity_note = identity_for(audience, identity)
    unsubscribe = unsubscribe_target()

    broadcast_id = _new_id()
    kind = f"broadcast.{broadcast_id}"

    # ── The record of who authorised this, and exactly who it was aimed at ──
    try:
        audit_id = await audit.record(
            actor=dict(actor),
            action=Action.BROADCAST_SENT,
            subject_type="broadcast",
            subject_id=broadcast_id,
            reason=reason,
            before=None,
            after={
                "subject": subject,
                "audience": str(audience),
                "audience_label": audience_label(audience, param),
                "identity": str(identity_used),
                "recipients": len(recipients),
                "attachments": [a.filename for a in sendable],
            },
            meta={
                "broadcast_id": broadcast_id,
                "kind": kind,
                "spec": SPEC,
                "role": str(role),
                # The audience as it actually resolved, address by address, at
                # the moment of sending. Not the label: "all sellers" six months
                # from now is a different set of people, and the question a
                # complaint raises is "was I on that list", which only the list
                # answers.
                "audience_resolved": [r.email for r in recipients],
                "audience_source": resolved.source,
                "unsubscribed_skipped": dropped,
                "no_address": resolved.no_address,
                "excluded": resolved.excluded,
                "attachments_omitted": omitted,
                "sender_identity_note": identity_note,
            },
        )
    except Exception as exc:  # noqa: BLE001
        raise BroadcastError(
            f"The audit entry for this broadcast could not be written ({exc}), "
            "so nothing was sent. A message to "
            f"{len(recipients):,} people with no record of who authorised it is "
            "not something this system will produce."
        ) from exc

    # ── The opted-out, recorded as skipped rather than silently absent ──────
    for address in dropped:
        recipient = by_address.get(address) or mail.Recipient(email=address)
        try:
            await mail.record_withheld(
                kind=kind,
                spec=SPEC,
                recipient=recipient,
                subject=subject,
                sensitivity=mail.Sensitivity.ANNOUNCEMENT,
                outcome=mail.Outcome.UNSUBSCRIBED_LOCAL,
                reason=(
                    "This address has unsubscribed from messages the Zipper "
                    "team composes, so it was deliberately left out of this "
                    "one. Not a failure — a decision, taken by the recipient."
                ),
                dedupe_key=f"{broadcast_id}:{address}",
                meta={"broadcast_id": broadcast_id, "audit_id": audit_id},
            )
        except mail.DeliveryNotRecorded:
            # The row could not be written. The person is still not sent to —
            # the exclusion is the point and it holds either way — but the log
            # will not show why they were absent, so say so loudly.
            log.exception(
                "Broadcast %s: could not record the unsubscribe skip for %s.",
                broadcast_id,
                address,
            )

    # ── The send itself ────────────────────────────────────────────────────
    rows = await _dispatch(
        recipients,
        kind=kind,
        subject=subject,
        html=html,
        attachments=original,
        identity=identity_used,
        unsubscribe=unsubscribe,
        broadcast_id=broadcast_id,
        audit_id=audit_id,
    )

    outcomes: dict[str, int] = {}
    for row in rows["sent_rows"]:
        outcomes[str(row.get("outcome"))] = outcomes.get(str(row.get("outcome")), 0) + 1

    accepted = sum(
        outcomes.get(o, 0) for o in (str(mail.Outcome.SENT), str(mail.Outcome.DELIVERED))
    )
    failed = sum(outcomes.get(o, 0) for o in mail.FAILURE_OUTCOMES)

    return {
        "broadcast_id": broadcast_id,
        "kind": kind,
        "spec": SPEC,
        "audit_id": audit_id,
        "subject": subject,
        "audience": str(audience),
        "audience_label": audience_label(audience, param),
        "audience_source": resolved.source,
        "sender_identity": str(identity_used),
        "sender_identity_note": identity_note,
        "sender": mail.sender_alignment(identity_used),
        "bulk": True,
        "unsubscribe": unsubscribe.summary(),
        "recipients": len(recipients),
        "attempted": len(rows["sent_rows"]),
        "accepted": accepted,
        "failed": failed,
        "by_outcome": outcomes,
        "unsubscribed_skipped": len(dropped),
        "no_address": resolved.no_address,
        "excluded": resolved.excluded,
        "attachments": [a.summary() for a in sendable],
        "attachments_omitted": omitted,
        "attachments_note": mail.omission_sentence(omitted),
        "not_attempted": rows["not_attempted"],
        "stopped_early": rows["stopped_early"],
        "stop_reason": rows["stop_reason"],
        "warnings": message_problems(subject, html),
        "delivery_log": f"/tech/email?kind={kind}",
        "note": (
            "Every recipient has a row in the delivery log under this kind, "
            "including the ones that failed and the ones deliberately skipped. "
            "'accepted' means the provider took the message, not that a mailbox "
            "did — a bounce arrives later and rewrites the row."
        ),
    }


async def _dispatch(
    recipients: Sequence[mail.Recipient],
    *,
    kind: str,
    subject: str,
    html: str,
    attachments: Sequence[mail.Attachment],
    identity: mail.SenderIdentity,
    unsubscribe: mail.Unsubscribe,
    broadcast_id: str,
    audit_id: str,
) -> dict:
    """Send to everybody, paced, and stop honestly if the provider throttles.

    `email.deliver_many` is a serial loop — one blocking provider call per
    recipient, no batching and no backoff, which is exactly right for the five
    recipients of a scheduled report and is not a plan for two thousand. So the
    list is cut into `broadcast_batch_size` slices, `broadcast_concurrency` of
    them are run at once, and there is a pause between waves. Every message
    still goes through `deliver_many` → `deliver`, so the row it leaves is
    identical to every other row in the log.

    **A throttle stops the send rather than being ridden through.** SendGrid
    answers a rate limit with 429; `deliver` records that as a failed delivery
    with the provider's own words, and carrying on into a throttle turns a
    pause that would have cleared into hundreds of permanent-looking failures
    nobody can distinguish from real rejections. After
    `broadcast_throttle_waves_before_stop` consecutive throttled waves the send
    stops and **names every address it never attempted** — which is the only
    honest answer, and is what makes a resend possible.
    """
    batch = max(1, int(settings.broadcast_batch_size))
    lanes = max(1, int(settings.broadcast_concurrency))
    pause = max(0.0, float(settings.broadcast_wave_pause_seconds))
    patience = max(1, int(settings.broadcast_throttle_waves_before_stop))

    # ── The addressless are handled first, and one at a time ────────────────
    #
    # `deliver_many` derives its dedupe key from `dedupe_prefix` and the
    # recipient's **address**, which is exactly right for everybody who has one
    # and silently wrong for everybody who does not: two approved partners with
    # no address on their registration document produce the same key
    # `"<broadcast id>:"`, the unique index on `email_deliveries.dedupe_key`
    # catches the second, and it is recorded as a `duplicate` — so two gaps in
    # the record appear on `/tech/email` as one. The gap is the whole reason
    # `no_address` exists as an outcome; collapsing two of them into one is the
    # failure this module is meant to make impossible.
    #
    # So they go through `deliver()` directly, which is the same function
    # `deliver_many` loops over, with a key built from the partner id — unique
    # by construction, because a partner id is. Each one leaves its own row
    # naming the partner nobody can write to.
    addressed = [r for r in recipients if r.email and "@" in r.email]
    gaps = [r for r in recipients if not (r.email and "@" in r.email)]

    gap_rows: list[dict] = []
    for gap in gaps:
        gap_rows.append(
            await mail.deliver(
                kind=kind,
                spec=SPEC,
                recipient=gap,
                subject=subject,
                html=html,
                sensitivity=mail.Sensitivity.ANNOUNCEMENT,
                dedupe_key=f"{broadcast_id}:no-address:{gap.uid or gap.name}",
                meta={"broadcast_id": broadcast_id, "audit_id": audit_id},
                attachments=attachments,
                identity=identity,
                unsubscribe=unsubscribe,
            )
        )

    slices = _chunks(addressed, batch)
    waves = _chunks(slices, lanes)

    sent_rows: list[dict] = list(gap_rows)
    not_attempted: list[str] = []
    throttled_run = 0
    stopped_early = False
    stop_reason = ""

    for index, wave in enumerate(waves):
        results = await asyncio.gather(
            *(
                mail.deliver_many(
                    slice_,
                    kind=kind,
                    spec=SPEC,
                    subject=subject,
                    html=html,
                    sensitivity=mail.Sensitivity.ANNOUNCEMENT,
                    # One key per (broadcast, address). Re-running the same
                    # broadcast id cannot double-send to anybody, and one
                    # person's failure never suppresses another's.
                    dedupe_prefix=broadcast_id,
                    meta={"broadcast_id": broadcast_id, "audit_id": audit_id},
                    attachments=attachments,
                    identity=identity,
                    unsubscribe=unsubscribe,
                )
                for slice_ in wave
            ),
            return_exceptions=True,
        )

        wave_rows: list[dict] = []
        for slice_, result in zip(wave, results):
            if isinstance(result, BaseException):
                # `deliver` records its own failures, so reaching here means
                # something below it fell over — `DeliveryNotRecorded`, most
                # likely, which means those messages were deliberately not sent.
                log.error(
                    "Broadcast %s: a slice of %d failed outright: %s",
                    broadcast_id,
                    len(slice_),
                    result,
                )
                not_attempted.extend(r.email for r in slice_)
                continue
            wave_rows.extend(result)

        sent_rows.extend(wave_rows)

        if _throttled(wave_rows):
            throttled_run += 1
            log.warning(
                "Broadcast %s: wave %d came back throttled (%d/%d).",
                broadcast_id, index + 1, throttled_run, patience,
            )
        else:
            throttled_run = 0

        remaining = [r for w in waves[index + 1 :] for s in w for r in s]

        if throttled_run >= patience:
            stopped_early = True
            stop_reason = (
                f"SendGrid rate-limited {throttled_run} waves in a row, so the "
                f"send stopped with {len(remaining):,} recipient(s) never "
                "attempted rather than turning a throttle into hundreds of "
                "recorded failures. The addresses are listed; re-send to them "
                "once the limit clears."
            )
            not_attempted.extend(r.email for r in remaining)
            break

        if remaining and pause:
            await asyncio.sleep(pause)

    return {
        "sent_rows": sent_rows,
        "not_attempted": sorted(set(not_attempted)),
        "stopped_early": stopped_early,
        "stop_reason": stop_reason,
    }
