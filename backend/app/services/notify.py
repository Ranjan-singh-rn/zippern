"""Who receives what, and where their address comes from.

Spec 8A.2 (transactional), 8A.3.13 – 8A.3.15 (subscriptions), 8A.4 (alerts).
`email.py` knows how to send; this module knows who to. The split matters: a
recipient list built from a hardcoded address is a recipient list nobody
maintains, and the first time an owner changes their mailbox the alerts stop
arriving at the person who needed them.

**Two sources of address, and no third.**

  * **Internal** — the `staff` collection in Mongo. Owners, the Observer and
    team admins are found by their `role`, active only. There is no fallback to
    a constant in this file, in `config.py` or anywhere else: if no owner is on
    the staff record, an owner-bound report resolves to *nobody* and says so,
    which is a visible configuration failure rather than mail going to whichever
    address somebody once typed into a settings default.
  * **Partner-facing** — the partner's own Firestore document
    (`agencies/{id}` or `sellers/{id}`), field `ownerEmail`. The Mongo partner
    record deliberately carries no email: the address is a contact detail the
    partner maintains, not a business record, and duplicating it would let the
    two drift.

**Nothing here decides whether an address may read a figure.** That is
`email.may_receive`, checked inside `deliver()` at the moment of sending, so a
mistake in a list built here cannot leak a business-wide money figure to an
external account.

An empty resolution is never silently treated as success. `Resolution.missing`
names every audience that resolved to nobody, and every caller in `alerts.py`
and `scheduling.py` reports it.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

from app.core import roles as R
from app.core.compat import StrEnum
from app.core.roles import Role, Team
from app.services.email import Recipient

log = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════════════════════
#  Audiences — the names an alert or a report asks for
# ══════════════════════════════════════════════════════════════════════════════


class Audience(StrEnum):
    """The groups Part 8A names. Nothing addresses an individual by name."""

    #: 8A.3.1 / 8A.4.4 — "all 3 owners".
    OWNERS = "owners"
    #: 8A.3.1 / 8A.4.1 — the read-only audit account.
    OBSERVER = "observer"
    #: 8A.3.2 / 8A.2.11 / 8A.4.3 — "the Finance admin".
    FINANCE_ADMIN = "finance_admin"
    #: 8A.3.8 / 8A.4.7 — "that team's admin". Written `team_admin:finance`.
    TEAM_ADMIN = "team_admin"


#: An audience name → the staff roles it resolves to. `team_admin` is
#: parameterised and handled separately.
_AUDIENCE_ROLES: dict[str, tuple[Role, ...]] = {
    str(Audience.OWNERS): (Role.OWNER,),
    str(Audience.OBSERVER): (Role.OBSERVER,),
    str(Audience.FINANCE_ADMIN): (Role.FINANCE_ADMIN,),
}


def admin_role_for(team: Team | str) -> Role | None:
    """The admin role of one department, derived from `roles.py`.

    Derived rather than written out, so adding a department in one place cannot
    leave an alert with nowhere to go.
    """
    wanted = str(team)
    for role in R.ADMIN_ROLES:
        if str(R.team_of(role)) == wanted:
            return role
    return None


def parse_audience(name: str) -> tuple[str, str | None]:
    """`"team_admin:finance"` → `("team_admin", "finance")`."""
    head, _, tail = str(name).partition(":")
    return head, (tail or None)


# ══════════════════════════════════════════════════════════════════════════════
#  The result of asking
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Resolution:
    """Who was found, who was not, and who asked not to be written to."""

    recipients: list[Recipient] = field(default_factory=list)
    #: audience name → how many live addresses it produced.
    resolved: dict[str, int] = field(default_factory=dict)
    #: Audiences that produced nobody. A configuration failure, reported as one.
    missing: list[str] = field(default_factory=list)
    #: Addresses that exist but have turned this report off (8A.3.15).
    muted: list[str] = field(default_factory=list)
    #: Outside addresses an owner deliberately subscribed (8A.3.14).
    subscribed: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.recipients)

    def why_empty(self) -> str:
        """A sentence an operator can act on. Never 'no recipients'."""
        if self.recipients:
            return ""
        parts = []
        if self.missing:
            parts.append(
                "no active staff record carries "
                + ", ".join(sorted(self.missing))
                + " — seed the owner and observer accounts "
                "(backend/scripts/seed_accounts.py) or invite them"
            )
        if self.muted:
            parts.append(
                f"{len(self.muted)} address(es) have turned this one off (8A.3.15)"
            )
        return (
            "Nothing was sent because there is nobody to send it to: "
            + "; ".join(parts or ["no audience was requested"])
            + "."
        )

    def summary(self) -> dict:
        return {
            "count": len(self.recipients),
            "resolved": dict(self.resolved),
            "missing": list(self.missing),
            "muted": list(self.muted),
            "subscribed": list(self.subscribed),
        }


# ══════════════════════════════════════════════════════════════════════════════
#  Internal addresses — the staff record, and only the staff record
# ══════════════════════════════════════════════════════════════════════════════


def _db():
    from app.db.mongo import get_db

    return get_db()


def _collection(name: str):
    return _db()[name]


async def staff_with_roles(roles: Sequence[Role | str]) -> list[Recipient]:
    """Every active staff account holding one of these roles.

    Sorted by email so two runs produce the same order, which makes a delivery
    log diffable.
    """
    from app.db.mongo import C

    wanted = sorted({str(r) for r in roles})
    if not wanted:
        return []

    cursor = _collection(C.STAFF).find(
        {"role": {"$in": wanted}, "is_active": True}
    )
    found: list[Recipient] = []
    async for doc in cursor:
        address = str(doc.get("email") or "").strip().lower()
        if not address:
            # A staff row with no address is a broken record, not a person to
            # skip quietly. It still becomes a Recipient, so `deliver()` writes
            # a `no_address` row naming the account (8A.2.15).
            log.warning(
                "Staff record %s (%s) has no email address on it.",
                doc.get("uid", "?"),
                doc.get("role", "?"),
            )
        found.append(
            Recipient(
                email=address,
                name=str(doc.get("name") or ""),
                role=str(doc.get("role") or ""),
                uid=str(doc.get("uid") or ""),
            )
        )
    found.sort(key=lambda r: (r.email, r.uid or ""))
    return found


async def _audience_recipients(name: str) -> list[Recipient]:
    head, param = parse_audience(name)

    if head == str(Audience.TEAM_ADMIN):
        if not param:
            raise ValueError(
                "'team_admin' must name a team, e.g. 'team_admin:finance'. "
                "An unqualified team admin is every team admin, which is not "
                "what 8A.4.7 asks for."
            )
        role = admin_role_for(param)
        if role is None:
            raise ValueError(
                f"'{param}' is not a department in roles.py, so it has no admin."
            )
        return await staff_with_roles([role])

    roles = _AUDIENCE_ROLES.get(head)
    if roles is None:
        raise ValueError(
            f"'{name}' is not an audience. Known: "
            f"{', '.join(sorted(_AUDIENCE_ROLES))}, team_admin:<team>."
        )
    return await staff_with_roles(roles)


# ══════════════════════════════════════════════════════════════════════════════
#  Subscriptions — 8A.3.13 / 8A.3.14 / 8A.3.15
# ══════════════════════════════════════════════════════════════════════════════
#
# A subscription row is an addition or a subtraction, never a replacement. An
# owner can add an outside accountant to the monthly pack, and anyone can turn
# one report off for their own address — but nobody can remove an owner from an
# alert by editing a subscription, because alerts do not consult this table.


async def subscriptions(report: str, cadence: str) -> list[dict]:
    from app.db.mongo import C

    cursor = _collection(C.REPORT_SUBSCRIPTIONS).find(
        {"report": report, "cadence": cadence}
    )
    return [doc async for doc in cursor]


async def set_subscription(
    *,
    report: str,
    cadence: str,
    email: str,
    name: str = "",
    muted: bool = False,
    authorised_by: str = "",
) -> dict:
    """Add, mute or unmute one address for one report at one cadence.

    `authorised_by` is the uid of the owner who took the decision. It is carried
    onto the `Recipient`, and `email.may_receive` uses it as the sole way an
    address with no role on record may be sent a business-wide money figure
    (8A.3.14). Nothing else sets it, so nothing subscribes an outside address by
    accident.
    """
    from app.db.mongo import C

    address = str(email or "").strip().lower()
    if "@" not in address:
        raise ValueError(f"'{email}' is not an email address.")

    doc = {
        "report": report,
        "cadence": cadence,
        "email": address,
        "name": name,
        "muted": bool(muted),
        "authorised_by": str(authorised_by or "") or None,
        "updated_at": datetime.now(timezone.utc),
    }
    await _collection(C.REPORT_SUBSCRIPTIONS).update_one(
        {"report": report, "cadence": cadence, "email": address},
        {"$set": doc, "$setOnInsert": {"created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return doc


# ══════════════════════════════════════════════════════════════════════════════
#  resolve() — the one call an alert or a report makes
# ══════════════════════════════════════════════════════════════════════════════


async def resolve(
    audiences: Iterable[str],
    *,
    report: str | None = None,
    cadence: str | None = None,
) -> Resolution:
    """Turn audience names into addresses.

    `report`/`cadence` are supplied for scheduled reports only. Alerts pass
    neither, and therefore cannot be muted — an alert somebody switched off is
    not an alert (8A.1.4 is about volume, not about opting out of exceptions).
    """
    out = Resolution()
    seen: dict[str, Recipient] = {}

    subs: list[dict] = []
    if report and cadence:
        try:
            subs = await subscriptions(report, cadence)
        except Exception as exc:  # noqa: BLE001
            # The report still goes to its standing audience. A subscription
            # table that cannot be read must not silence a report.
            log.error("Subscriptions for %s/%s unreadable: %s", report, cadence, exc)
            out.missing.append(f"subscriptions:{report}:{cadence} (unreadable)")

    muted = {
        str(s.get("email", "")).lower() for s in subs if s.get("muted")
    }

    for name in audiences:
        try:
            people = await _audience_recipients(name)
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.error("Audience '%s' could not be resolved: %s", name, exc)
            out.missing.append(f"{name} (lookup failed: {exc})")
            out.resolved[name] = 0
            continue

        live = 0
        for person in people:
            if person.email and person.email in muted:
                if person.email not in out.muted:
                    out.muted.append(person.email)
                continue
            key = person.email or f"uid:{person.uid}"
            if key in seen:
                continue
            seen[key] = person
            out.recipients.append(person)
            live += 1
        out.resolved[name] = live
        if not people:
            out.missing.append(name)

    # Deliberate additions — an accountant, an external auditor (8A.3.14).
    for sub in subs:
        if sub.get("muted"):
            continue
        address = str(sub.get("email", "")).strip().lower()
        if not address or address in seen:
            continue
        recipient = Recipient(
            email=address,
            name=str(sub.get("name") or ""),
            role=None,
            uid=None,
            authorised_by=sub.get("authorised_by"),
        )
        seen[address] = recipient
        out.recipients.append(recipient)
        out.subscribed.append(address)

    return out


# ══════════════════════════════════════════════════════════════════════════════
#  Partner addresses — from the partner's own document
# ══════════════════════════════════════════════════════════════════════════════

FS_AGENCIES = "agencies"
FS_SELLERS = "sellers"

#: Tried in order. `ownerEmail` is what `firestore.rules` matches a partner's
#: own token against, so it is the field the business already treats as the
#: partner's identity.
_ADDRESS_FIELDS = ("ownerEmail", "email", "contactEmail", "loginEmail")


def _read_partner_doc(collection: str, partner_id: str) -> dict:
    """Blocking Firestore read, run off the event loop by `partner_recipient`."""
    from app.db import firebase

    snapshot = firebase.firestore_client().collection(collection).document(
        partner_id
    ).get()
    if not snapshot.exists:
        return {}
    return snapshot.to_dict() or {}


def _collection_for(partner: Mapping[str, Any]) -> str:
    source = partner.get("source") or {}
    named = str(source.get("firestore_collection") or "").strip()
    if named in (FS_AGENCIES, FS_SELLERS):
        return named
    from app.services.partners import PartnerKind

    return FS_SELLERS if str(partner.get("kind")) == str(PartnerKind.SELLER) else FS_AGENCIES


async def partner_recipient(partner: Mapping[str, Any]) -> Recipient:
    """The address on a partner's own record.

    Returns a `Recipient` even when no address is found. That is deliberate:
    `deliver()` writes a `no_address` delivery row naming the partner, so a
    partner nobody can write to appears on the failure list instead of being a
    send that silently never happened (8A.2.15).
    """
    partner_id = str(partner.get("_id") or partner.get("id") or "")
    name = str(partner.get("name") or "")
    kind = str(partner.get("kind") or "")
    role = _role_for_kind(kind)

    try:
        doc = await asyncio.to_thread(
            _read_partner_doc, _collection_for(partner), partner_id
        )
    except Exception as exc:  # noqa: BLE001
        log.error("Could not read the Firestore document for %s: %s", partner_id, exc)
        doc = {}

    address = ""
    for key in _ADDRESS_FIELDS:
        candidate = str(doc.get(key) or "").strip().lower()
        if "@" in candidate:
            address = candidate
            break

    return Recipient(email=address, name=name or partner_id, role=role, uid=partner_id)


def _role_for_kind(kind: str) -> str:
    from app.services.partners import PartnerKind

    if kind == str(PartnerKind.SELLER):
        return str(Role.SELLER)
    return str(Role.AGENCY)


async def approved_partners(kind: str, limit: int = 1000) -> list[dict]:
    """Every approved, active partner of one kind — the statement run's list."""
    from app.db.mongo import C
    from app.services.partners import PartnerStatus

    query: dict[str, Any] = {
        "status": str(PartnerStatus.APPROVED),
        "is_active": True,
    }
    if kind == "agency":
        # A sub-agency is paid through its parent (9.9) but is still owed its own
        # statement, so both agency kinds are included.
        query["kind"] = {"$in": ["agency", "sub_agency"]}
    else:
        query["kind"] = kind

    cursor = _collection(C.PARTNERS).find(query).limit(max(1, min(limit, 5000)))
    return [doc async for doc in cursor]
