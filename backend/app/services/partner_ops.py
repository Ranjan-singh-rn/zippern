"""Partner lifecycle — onboarding, inventory, credit, sales and commission.

`app/services/partners.py` is the read side: statements, standing, exposure.
This module is the write side. Everything that changes a partner's status or
moves their money happens here, and nowhere else.

The shape of it follows the spec:

  * Onboarding is a **team decision** — Ops approves or rejects, no owner
    signature, because no money moves at approval (3.3.3 / 9.2).
  * Everything that touches money is a **card** — raised by a team, verified by
    an admin, signed by an owner, then executed (Part 5). The request and the
    execution are separate functions here for exactly that reason.
  * Money only ever moves through `money.apply_movement`, always with an
    idempotency key derived from the card, so replaying an execution is a
    no-op rather than a second payment.

Mongo is the record. Firestore holds the `agencies` / `sellers` documents the
app and the CRM read, and is updated afterwards as a replica — a failure there
never invalidates what Mongo already committed.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from collections.abc import Callable, Mapping
from datetime import datetime, timezone

from bson import ObjectId
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.core import audit
from app.core.roles import Team, partner_role_for
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import cards as card_svc
from app.services import commission as commission_svc
from app.services import crm_directory as crm
from app.services import partners as partner_svc
from app.services.cards import CardError, CardType, NewCard, Stage
from app.services.money import (
    Currency,
    DuplicateMovement,
    HolderType,
    InsufficientBalance,
    Movement,
    apply_movement,
    get_balance,
)
from app.services.partners import PartnerKind, PartnerStatus

log = logging.getLogger(__name__)

# Collections owned by this module. `app/db/mongo.py` names the shared ones;
# these two are local to partner operations.
SALES = "partner_sales"
SUBAGENCY_PAYOUTS = "subagency_payouts"

MIN_REASON = 3


class PartnerOpsError(Exception):
    """Refused by a partner rule. The message is safe to show the caller."""


class Act:
    """Audit actions this module adds to the ones in `app.core.audit`."""

    PARTNER_CREATED = "partner.created"
    PARTNER_REACTIVATED = "partner.reactivated"
    SALE_RECORDED = "sale.recorded"
    SALE_APPROVED = "sale.approved"
    SUBAGENCY_PAID_PARENT = "subagency.paid_parent"
    SUBAGENCY_PARENT_PAID_SUB = "subagency.parent_paid_sub"
    SECOND_ROLE_REQUESTED = "partner.second_role_requested"
    SECOND_ROLE_APPROVED = "partner.second_role_approved"
    SECOND_ROLE_REJECTED = "partner.second_role_rejected"
    #: A permanent virtual account number issued to a partner by the bank
    #: (4.3.4 / 8C.1.4). Its own action because a VAN is a standing instruction
    #: to the world about where to send this partner's money: from the moment it
    #: exists, anything paid into it is credited to them without a human
    #: deciding so. The entry names the provider and the collection account it
    #: maps onto, so "who told the bank to point that number here" has an answer.
    VAN_ISSUED = "partner.van_issued"
    #: An issue that was asked for and did not happen. Recorded because a seller
    #: silently without a VAN is the failure mode this whole path exists to make
    #: visible — the alternative is a portal that shows nothing and nobody knows
    #: whether that is "not configured" or "the bank call failed".
    VAN_NOT_ISSUED = "partner.van_not_issued"
    #: A change a partner PROPOSED to their payout or identity details, applied
    #: onto the live record by a reviewer. Its own action rather than a generic
    #: edit, because this is the write that moves where money is sent — the
    #: exact thing an approved partner used to be able to do to themselves. The
    #: entry names both people: who applied it, and who asked for it.
    PENDING_CHANGES_APPLIED = "partner.pending_changes_applied"
    #: The same proposal refused. Recorded as loudly as an application, because
    #: a rejected bank change is evidence — of a mistake, or of an attempt — and
    #: a refusal that leaves no trace makes a pattern of them unfindable.
    PENDING_CHANGES_REJECTED = "partner.pending_changes_rejected"
    #: A login attached to a partner record that had none. Its own action, not
    #: a generic edit: this is the write that turns a record nobody could sign
    #: in to into one somebody can, and it is the only staff-operated path that
    #: creates a partner's credential. Reading `/audit` for a partner should
    #: show the moment it gained an owner, with the reason and who decided.
    LOGIN_ATTACHED = "partner.login_attached"


class SaleStatus:
    PENDING = "pending"
    APPROVED = "approved"
    FAILED = "failed"


class PayoutStatus:
    PENDING = "pending"                    # card raised, nothing paid
    PARENT_PAID = "parent_paid"            # leg 1 done, waiting on the parent
    CLOSED = "closed"                      # leg 2 confirmed


# ── Small helpers ─────────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _who(actor: dict) -> dict:
    return {
        "uid": actor.get("uid", ""),
        "name": actor.get("name", ""),
        "role": str(actor.get("role", "")),
        "team": str(actor["team"]) if actor.get("team") else None,
    }


def _reason(reason: str, fallback: str) -> str:
    """Use the caller's reason, or a specific generated one. Never blank —
    `apply_movement` and `audit.record` both refuse an empty reason."""
    text = (reason or "").strip()
    return text if len(text) >= MIN_REASON else fallback


def _require_reason(reason: str) -> str:
    text = (reason or "").strip()
    if len(text) < MIN_REASON:
        raise PartnerOpsError(
            f"A reason of at least {MIN_REASON} characters is required."
        )
    return text


def _positive(value: int, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise PartnerOpsError(f"{label} must be a whole number.")
    if value <= 0:
        raise PartnerOpsError(f"{label} must be greater than zero.")
    return value


def _non_negative(value: int, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise PartnerOpsError(f"{label} must be a whole number.")
    if value < 0:
        raise PartnerOpsError(f"{label} cannot be negative.")
    return value


def _public(doc: dict) -> dict:
    out = dict(doc)
    if "_id" in out:
        out["id"] = str(out.pop("_id"))
    return out


async def _partner(partner_id: str, kind: PartnerKind | None = None) -> dict:
    doc = await get_db()[C.PARTNERS].find_one({"_id": partner_id})
    if doc is None:
        raise PartnerOpsError(f"No partner record found for '{partner_id}'.")
    if kind is not None and doc.get("kind") != str(kind):
        raise PartnerOpsError(
            f"'{partner_id}' is a {doc.get('kind') or 'partner'}, not a {kind}."
        )
    return doc


async def _approved_partner(partner_id: str, kind: PartnerKind | None = None) -> dict:
    doc = await _partner(partner_id, kind)
    if doc.get("status") != str(PartnerStatus.APPROVED):
        raise PartnerOpsError(
            f"{doc.get('name') or partner_id} is {doc.get('status') or 'not approved'} "
            "— approve the account before moving money on it."
        )
    return doc


async def _card(card_id: str, expected: CardType) -> dict:
    try:
        oid = ObjectId(card_id)
    except Exception as exc:  # noqa: BLE001
        raise PartnerOpsError("Card not found.") from exc

    doc = await get_db()[C.CARDS].find_one({"_id": oid})
    if doc is None:
        raise PartnerOpsError("Card not found.")
    if doc.get("type") != str(expected):
        raise PartnerOpsError(
            f"Card {card_id} is a {doc.get('type')} card, not {expected}."
        )
    return doc


async def _card_ready(card_id: str, expected: CardType) -> dict:
    """A card an owner has signed and nobody has executed yet."""
    doc = await _card(card_id, expected)
    stage = doc.get("stage")
    if stage == str(Stage.EXECUTED):
        raise PartnerOpsError("This card has already been executed.")
    if stage != str(Stage.APPROVED):
        raise PartnerOpsError(
            f"Card is {stage}. Only a card signed by an owner can be executed."
        )
    return doc


async def _raise(card: NewCard, actor: dict) -> dict:
    try:
        return await card_svc.raise_card(card, actor)
    except CardError as exc:
        raise PartnerOpsError(str(exc)) from exc


async def _finish(card_id: str, actor: dict, result: dict, ok: bool) -> dict:
    try:
        return await card_svc.mark_executed(card_id, actor, result, ok)
    except CardError as exc:
        raise PartnerOpsError(str(exc)) from exc


async def _move(m: Movement) -> dict:
    """One balance movement, with card-derived idempotency, translated into
    messages a UI can show."""
    try:
        result = await apply_movement(m)
    except InsufficientBalance as exc:
        raise PartnerOpsError(
            f"{exc.holder_id} holds {exc.available} {exc.currency}; "
            f"this needs {exc.requested}."
        ) from exc
    except DuplicateMovement as exc:
        raise PartnerOpsError(
            "This movement was already applied — nothing was moved a second time."
        ) from exc
    return {
        "ledger_id": result.ledger_id,
        "balance_before": result.balance_before,
        "balance_after": result.balance_after,
        "replica_synced": result.replica_synced,
    }


# ── Firestore replica ─────────────────────────────────────────────────────────


def _fs_collection(kind: str | PartnerKind) -> str:
    return "sellers" if str(kind) == str(PartnerKind.SELLER) else "agencies"


def _sync_app_partner_role(partner: dict, fields: dict) -> None:
    """Grant or revoke this partner's own dashboard in the Android app.

    Hung off the status sync on purpose, because this is the one place every
    partner status decision already passes through — approve, reject, suspend
    and reactivate all land here. Anywhere else and app access would be a second
    thing to remember, and would drift from the status it is supposed to follow.
    That drift is exactly the class of bug the `kycStatus` mess was.

    The app reads `isAgent` / `isSeller`, which `syncMyRoles` sets from a
    `verifiedIdentities` entry — and partners were never written into that
    collection, so `AgencyDashboardScreen` and `SellerDashboardScreen` were
    built, routed, and unreachable by anybody who actually is one.

    Never raises. A partner who cannot be told about is still an approved
    partner, and their status decision must not fail over a replica write.
    """
    status = str(fields.get("status", ""))
    if not status:
        return

    kind = str(partner.get("kind", ""))
    role = "seller" if kind == str(PartnerKind.SELLER) else "agent"

    # The contact details are on the FIRESTORE document, not the Mongo record —
    # the Mongo partner carries the money and the lifecycle and has never held a
    # phone number or an email address. And contact details are exactly what
    # this needs, because an app sign-in is matched to a person rather than to a
    # uid: the CRM login is email and password, the app is phone OTP or Google,
    # and those are two different Firebase accounts for the same human.
    partner_id = str(partner["_id"])
    try:
        found = _read_firestore_partner(partner_id, _fs_collection(kind))
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read %s for app role sync: %s", partner_id, exc)
        return
    source = found[1] if found else {}

    email = str(
        source.get("ownerEmail") or source.get("email") or ""
    ).strip().lower()
    phone = str(
        source.get("ownerPhone") or source.get("phone") or ""
    ).strip()
    if not email and not phone:
        log.warning(
            "Partner %s has neither phone nor email; app role '%s' cannot be matched "
            "to a sign-in and was not written",
            partner.get("_id"),
            role,
        )
        return

    name = str(
        partner.get("name")
        or source.get("ownerName")
        or source.get("displayName")
        or source.get("agencyName")
        or ""
    ).strip()
    approved = status == str(PartnerStatus.APPROVED) and fields.get("isActive") is not False

    note = (
        crm.write_partner_identity(
            email=email,
            phone=phone,
            name=name,
            role=role,
            agency_id="" if role == "seller" else partner_id,
        )
        if approved
        else crm.clear_partner_identity(email=email, phone=phone, role=role)
    )
    if note:
        log.warning("App role sync for partner %s: %s", partner.get("_id"), note)

    # ── The half that actually lets them into the app ────────────────────────
    #
    # `write_partner_identity` above fills in `verifiedIdentities`, and that was
    # the whole mechanism back when `syncMyRoles` matched a sign-in on phone and
    # email. It reads `crmUsers/{uid}` now — by uid, and only by uid — so the app
    # session has to land on the SAME Firebase account the CRM login uses, and
    # nothing was making that happen for a partner.
    #
    # An agency owner signing in with phone OTP therefore got a different uid, no
    # `crmUsers` document, no `isAgent` and no dashboard, while every CRM screen
    # showed them fully approved. Staff never had this because their number is
    # attached when they are invited; this is the same call, at the equivalent
    # moment for a partner.
    #
    # Approval only. A rejected or suspended partner keeps whatever number is
    # already on their account — taking one off is a separate decision, and the
    # refusals that matter are enforced at sign-in, not by withholding a phone.
    if approved:
        uid = str(source.get("crmUid") or source.get("ownerUid") or "").strip()
        phone_note = crm.attach_phone_to_login(uid, phone)
        if phone_note:
            log.warning("Partner %s: %s", partner.get("_id"), phone_note)


def _sync_partner_doc(partner: dict, fields: dict) -> bool:
    """Push partner fields to the Firestore document the app and CRM read.

    Mongo is already committed by the time this runs. A failure is logged and
    reported, never raised — the record stands regardless of the replica.
    """
    # Their access to the app's partner dashboard follows the same decision.
    _sync_app_partner_role(partner, fields)

    collection = _fs_collection(partner.get("kind", ""))
    doc_id = str(partner["_id"])
    try:
        client = firebase.firestore_client()
        client.collection(collection).document(doc_id).update(fields)
        return True
    except Exception:  # noqa: BLE001
        log.warning(
            "Firestore update failed for %s/%s — trying the crm_id lookup",
            collection,
            doc_id,
        )

    crm_id = partner.get("crm_id")
    if not crm_id:
        log.exception(
            "Firestore partner sync failed for %s/%s — Mongo is authoritative",
            collection,
            doc_id,
        )
        return False

    try:
        client = firebase.firestore_client()
        query = (
            client.collection(collection)
            .where(filter=FieldFilter("crmId", "==", crm_id))
            .limit(1)
        )
        for snapshot in query.stream():
            snapshot.reference.update(fields)
            return True
    except Exception:  # noqa: BLE001
        log.exception(
            "Firestore partner sync failed for %s (crmId=%s) — Mongo is authoritative",
            collection,
            crm_id,
        )
    return False


def _fs_status_fields(
    kind: str,
    status: PartnerStatus,
    active: bool,
    verified_documents: bool = True,
) -> dict:
    """The status fields as each kind of partner document records them.

    Agencies and sellers do not spell approval the same way — a seller carries
    `isApproved` as well — so both are written and the two can never disagree.

    **`kycStatus` moves with the decision too, and that is the point.** It used
    to be an entirely separate field that approval never touched, so a partner
    could be `status: approved` and trading while `kycStatus: pending` — nobody
    had confirmed their identity documents and nothing anywhere said so. For a
    business that hands out inventory on credit and pays commission to bank
    accounts, an approved partner whose documents were never checked is not a
    tidiness problem.

    Approving *is* the act of verifying: every approve button in the CRM sits on
    a screen showing the documents, and `/kyc` renders them inline for exactly
    that reason. So an approval states the verification, and a rejection or a
    suspension withdraws it rather than leaving a stale `approved` behind.
    """
    approved = status is PartnerStatus.APPROVED
    fields: dict = {"status": str(status), "isActive": active}
    if str(kind) == str(PartnerKind.SELLER):
        fields["isApproved"] = approved

    if approved and verified_documents:
        fields["kycStatus"] = "approved"
    elif approved:
        # Approved to trade, but there were no documents to have verified — so
        # `kycStatus` is deliberately left where it is, at `pending`.
        #
        # Writing `approved` here would be false, and it would also lock them
        # out: the upload form on a partner's own dashboard renders only while
        # `kycStatus` is `pending` or `rejected`. Marking a partner verified
        # when nothing was verified therefore removes the one screen they could
        # have used to supply what was missing.
        #
        # This is the ordinary case for a second capability — the person passed
        # KYC on their first one and there is nothing new to check — and it is
        # exactly the case where they still have bank details to add.
        pass
    elif status in (PartnerStatus.REJECTED, PartnerStatus.SUSPENDED):
        # Not 'rejected' — the documents may be perfectly good and the refusal
        # about something else. It goes back to needing a decision, which is
        # the honest state and puts them back in the queue.
        fields["kycStatus"] = "pending"
    return fields


# ══════════════════════════════════════════════════════════════════════════════
# 0. Creation — the business record behind a Firestore agency or seller
# ══════════════════════════════════════════════════════════════════════════════
#
# Nothing used to insert into `partners`. The Firestore `agencies` / `sellers`
# document was created by the CRM, and the Mongo record that every money flow
# keys off simply never came into being — so a freshly registered seller could
# not be funded ("No partner record found for '{id}'"), and neither could any
# agency approved through the CRM.
#
# The partner `_id` **is** the Firestore document id. That is the whole join
# between the two systems, and it is why a partner id that names no Firestore
# document is refused here: a partner record for a partner that does not exist
# is worse than none — it would satisfy every `_partner()` check in this module
# while pointing at nobody.
#
# A partner is always created **holding nothing**: no coins, no credit, no
# commission, no cash recorded. An opening load is a separate signed card.

FS_AGENCIES = "agencies"
FS_SELLERS = "sellers"


def _read_firestore_partner(
    partner_id: str, collection: str | None = None
) -> tuple[str, dict] | None:
    """The Firestore agency or seller document behind this id, or None.

    Blocking — run off the event loop by `_firestore_partner`.
    """
    client = firebase.firestore_client()
    names = (collection,) if collection else (FS_AGENCIES, FS_SELLERS)
    for name in names:
        snapshot = client.collection(name).document(partner_id).get()
        if snapshot.exists:
            return name, (snapshot.to_dict() or {})
    return None


async def _firestore_partner(
    partner_id: str, kind: PartnerKind | None
) -> tuple[str, dict]:
    """Confirm the partner is real, and hand back the document it is built from.

    A Firestore outage is **not** treated as "this partner does not exist" —
    creating nothing is right in both cases, but the two need different messages
    because one is retryable and the other never will be.
    """
    collection = None if kind is None else _fs_collection(kind)
    try:
        found = await asyncio.to_thread(
            _read_firestore_partner, partner_id, collection
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Firestore lookup failed for partner %s", partner_id)
        raise PartnerOpsError(
            "The agency and seller documents could not be read from Firestore, "
            f"so '{partner_id}' cannot be confirmed as a real partner. Nothing "
            "was created — try again once Firestore is reachable."
        ) from exc

    if found is None:
        where = collection or f"{FS_AGENCIES} or {FS_SELLERS}"
        raise PartnerOpsError(
            f"No {where} document with id '{partner_id}'. A partner record for a "
            "partner that does not exist is worse than none, so nothing was "
            "created. Check the id — it is the Firestore document id, not the "
            "CRM id."
        )
    return found


def _derive_kind(collection: str, source: dict) -> PartnerKind:
    """Main agency, sub-agency or seller.

    This decides which commission slab table the partner is paid from
    (`commission.kind_of` reads exactly this field, comparing it to
    `"sub_agency"`), so it is taken from the partner's own document and never
    from whoever is calling.
    """
    if collection == FS_SELLERS:
        return PartnerKind.SELLER
    if str(source.get("type") or "").strip().lower() == "sub":
        return PartnerKind.SUB_AGENCY
    if str(source.get("parentAgencyId") or "").strip():
        # A parent without `type: 'sub'` is still a sub-agency. Reading it as a
        # main agency would pay it from the main table, which is the richer one.
        return PartnerKind.SUB_AGENCY
    return PartnerKind.AGENCY


def _derive_name(collection: str, source: dict) -> str:
    """What the partner is called on a statement, a card and a report."""
    keys = (
        ("displayName", "name", "ownerName")
        if collection == FS_SELLERS
        else ("agencyName", "name", "ownerName")
    )
    for key in keys:
        text = str(source.get(key) or "").strip()
        if text:
            return text
    return ""


def _new_partner_document(
    partner_id: str,
    collection: str,
    source: dict,
    actor: dict,
    reason: str,
    now: datetime,
) -> dict:
    """Every field the rest of this module, `app/services/partners.py`,
    `services/commission.py` and `services/reports.py` read — with every balance
    at zero.

    A field missing here does not fail now; it fails later, when somebody is
    trying to move money. So the list is derived from the readers, not invented:

      * `kind`      — `_partner`, `list_partners`, `_fs_collection`,
                      `commission.kind_of`, `partners.sub_agencies_of`,
                      `partners.total_credit_exposure`, `reports`.
      * `name`      — every statement, card title and report row.
      * `parent_id` — `partners.sub_agencies_of`, `request_subagency_payout`.
      * `status` / `is_active` — `_approved_partner`, `can_take_inventory`.
      * `credit.*`  — lending, repayment, recovery, write-off, credit standing,
                      the exposure aggregate and the overdue worklist.
      * `cash_paid_minor`  — `execute_coin_purchase` ($inc), `seller_statement`.
      * `total_coins_sold` — `approve_sale` ($inc), mirrored to Firestore.
      * `crm_id`    — the `_sync_partner_doc` fallback lookup.
      * `created_at`— `list_partners` sorts on it.
    """
    kind = _derive_kind(collection, source)
    parent_id = (
        (str(source.get("parentAgencyId") or "").strip() or None)
        if kind is PartnerKind.SUB_AGENCY
        else None
    )

    doc: dict = {
        # The Firestore document id. This is the join between the two systems.
        "_id": partner_id,
        "kind": str(kind),
        "name": _derive_name(collection, source),
        "parent_id": parent_id,
        # Created, not approved. Creation is a record; approval is a decision.
        "status": str(PartnerStatus.PENDING),
        "is_active": False,
        # ── Money — all of it opens at zero ──────────────────────────────────
        # A partner is never created holding inventory, credit or commission.
        # Coin and commission balances are not stored here at all: they live in
        # the ledger and are read through `money.get_balance`, so there is no
        # opening figure to write and none to get wrong. What is stored here is
        # the credit position and the two lifetime counters.
        "credit": {
            "outstanding": 0,
            "due_at": None,
            "terms": "",
            "total_lent": 0,
            "total_repaid": 0,
            "total_recovered": 0,
            "total_penalty": 0,
            "total_written_off": 0,
            "history": [],
        },
        "cash_paid_minor": 0,
        "total_coins_sold": 0,
        # ── Lifecycle ────────────────────────────────────────────────────────
        "approved_at": None,
        "approved_by": None,
        "approval_reason": None,
        "rejection_reason": None,
        "rejected_at": None,
        "rejected_by": None,
        "rejection_history": [],
        "created_at": now,
        "updated_at": now,
        "created_by": _who(actor),
        "creation_reason": reason,
        # Where this record came from, so it can be reconciled against Firestore
        # later without guessing which collection to look in.
        "source": {
            "firestore_collection": collection,
            "firestore_id": partner_id,
            "declared_type": str(source.get("type") or ""),
        },
    }

    crm_id = str(source.get("crmId") or "").strip()
    if crm_id:
        # `crm_id` carries a **unique sparse** index (`app/db/mongo.py`). A
        # sparse index still indexes an explicit null, so writing
        # `crm_id: None` here would let the first partner without a crmId block
        # the creation of every later one. The key is left off entirely instead.
        doc["crm_id"] = crm_id
    return doc


def _creation_warnings(doc: dict) -> list[str]:
    """Things worth saying out loud about a record that was still created.

    None of these is a reason to refuse — refusing would leave a paid-up partner
    unfundable over a blank field — but none of them should be silent either.
    """
    warnings: list[str] = []
    if not doc["name"]:
        warnings.append(
            "The Firestore document carries no name, so this partner will show "
            "as its id on statements and cards until the document is fixed."
        )
    if doc["kind"] == str(PartnerKind.SUB_AGENCY) and not doc["parent_id"]:
        warnings.append(
            "This is a sub-agency with no parentAgencyId. It is paid through its "
            "parent (4.2.4), so a payout cannot be raised for it until the "
            "Firestore document names one."
        )
    if "crm_id" not in doc:
        warnings.append(
            "The Firestore document carries no crmId. Status changes will still "
            "sync by document id; only the fallback lookup is unavailable."
        )
    return warnings


async def ensure_partner_record(
    partner_id: str,
    actor: dict,
    reason: str,
    kind: PartnerKind | None = None,
) -> tuple[dict, bool, list[str]]:
    """The Mongo partner record for `partner_id`, created from Firestore if it
    does not exist yet. Returns `(document, created, warnings)`.

    **A second call is a no-op, not an error.** It returns the record that is
    already there, untouched, with `created` False. That is deliberate: this
    runs from partner approval and from the registration screens, both of which
    are retried after a network blip, and both of which would otherwise report
    a failure for a partner that exists and is perfectly fine. An error would
    also tempt a caller into "create, and if it fails, reset" — which is exactly
    how a live balance gets zeroed. Callers that need to know read `created`.

    Uniqueness is enforced by Mongo's own `_id` index rather than by the read
    above it, so two simultaneous creations still produce exactly one record:
    the loser catches `DuplicateKeyError` and is answered with the winner's.
    """
    pid = (partner_id or "").strip()
    if not pid:
        raise PartnerOpsError("A partner id is required.")

    db = get_db()
    existing = await db[C.PARTNERS].find_one({"_id": pid})
    if existing is not None:
        if kind is not None and existing.get("kind") != str(kind):
            raise PartnerOpsError(
                f"'{pid}' already exists as a {existing.get('kind') or 'partner'}, "
                f"not a {kind}. Nothing was changed."
            )
        return existing, False, []

    collection, source = await _firestore_partner(pid, kind)
    doc = _new_partner_document(pid, collection, source, actor, reason, _now())

    if kind is not None and doc["kind"] != str(kind):
        # Only reachable for agencies: `_fs_collection` cannot tell a main
        # agency from a sub, so the caller's `kind` is checked against what the
        # document actually says and the document wins.
        raise PartnerOpsError(
            f"'{pid}' is a {doc['kind']} in Firestore, not a {kind}. The kind "
            "selects the commission slab table, so it is taken from the "
            "partner's own document and never from the caller. Nothing was "
            "created."
        )

    warnings = _creation_warnings(doc)

    try:
        await db[C.PARTNERS].insert_one(doc)
    except DuplicateKeyError as exc:
        raced = await db[C.PARTNERS].find_one({"_id": pid})
        if raced is not None:
            # Another caller won. One record exists, which is the point.
            return raced, False, []
        # Not the `_id` index, then — the only other unique index on this
        # collection is `crm_id`, and two partners cannot share one.
        clash = await db[C.PARTNERS].find_one({"crm_id": doc.get("crm_id")})
        raise PartnerOpsError(
            f"CRM id '{doc.get('crm_id')}' already belongs to partner "
            f"'{clash['_id'] if clash else 'unknown'}'. Two partners cannot "
            "share one CRM id, so nothing was created — fix the duplicate crmId "
            "in Firestore first."
        ) from exc

    await audit.record(
        actor=actor,
        action=Act.PARTNER_CREATED,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before=None,
        after={
            "kind": doc["kind"],
            "name": doc["name"],
            "status": doc["status"],
            "is_active": doc["is_active"],
            "parent_id": doc["parent_id"],
            "credit_outstanding": 0,
            "cash_paid_minor": 0,
            "total_coins_sold": 0,
        },
        meta={
            "firestore_collection": collection,
            "crm_id": doc.get("crm_id"),
            "opened_at_zero": True,
            "warnings": warnings,
        },
    )
    return doc, True, warnings


async def create_partner(
    partner_id: str,
    reason: str,
    actor: dict,
    kind: PartnerKind | None = None,
) -> dict:
    """Create the business record for an existing Firestore agency or seller.

    Moves no money and grants nothing: the partner is created `pending`,
    inactive and holding zero. Approving it is a separate decision, and loading
    it with inventory is a separate signed card.
    """
    reason = _require_reason(reason)
    doc, created, warnings = await ensure_partner_record(
        partner_id, actor, reason, kind
    )

    out = _public(doc)
    out["created"] = created
    out["warnings"] = warnings
    out["note"] = (
        "Created holding nothing — no coins, no credit, no commission, no cash "
        "recorded. An opening load is a separate coin purchase card."
        if created
        else "This partner record already existed. Nothing was created and "
        "nothing about the existing record was changed."
    )
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 0a. Attaching a login to a partner record that has none
# ══════════════════════════════════════════════════════════════════════════════
#
# A partner record with no `crmUid` and no `owner_crm_uid` is a business nobody
# can sign in as. The records exist — a sub-agency created from a parent's
# dashboard where the second Firebase app failed, an applicant whose `crmUsers`
# write was refused by the rules, every partner backfilled by
# `scripts/backfill_partners.py` — and until now there was no control anywhere,
# in the CRM or the API, that could give one an owner. The only remedy was
# editing Firestore by hand, which is unaudited, unreviewed and easy to point at
# the wrong document.
#
# WHAT THIS DOES AND DOES NOT DO.
#   It creates the Firebase Auth account if the address has none, writes the
#   `crmUsers` document through `crm_directory.mirror` — the same function and
#   the same payload builder that writes a staff member's, not a second
#   implementation — sets `owner_crm_uid` on the Mongo record and `crmUid` on
#   the Firestore one. It **approves nothing**. A pending partner given a login
#   is still pending, and `resolve_partner_login` hands them a session with no
#   partner ids on it. It moves no money and creates no liability. The account
#   it attaches can, at most, read the partner's own statement.
#
# WHY MONGO IS WRITTEN FIRST.
#   `owner_crm_uid` is the link sign-in resolves against on its own, without
#   Firestore. Writing it first and auditing it immediately means the grant is
#   never unaudited for an instant, and a Firestore failure afterwards leaves a
#   login that works against the API and is reported to the caller — rather than
#   a `crmUsers` document granting access that no audit entry describes.

def _normalise_email(value: str) -> str:
    email = (value or "").strip().lower()
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        raise PartnerOpsError("A valid email address is required.")
    return email


def _capability_of(kind: str | PartnerKind) -> str:
    """`"agency"` or `"seller"` — which capability a partner record is."""
    return "seller" if str(kind) == str(PartnerKind.SELLER) else "agency"


def _existing_crm_documents(email: str) -> list[tuple[str, dict]]:
    """Blocking — every `crmUsers` document already carrying this address."""
    return crm.find_by_email(email)


def _resolve_or_create_login(email: str, name: str) -> tuple[str, bool]:
    """Blocking — the Firebase uid for this address, creating one if needed.

    Reusing an existing account is right rather than convenient: a partner who
    already signs in to the Android app with this address has a uid, and minting
    a second one would leave them with a credential that opens the portal and a
    different credential that opens the app.

    The password is random and immediately irrelevant — the caller is given a
    reset link and nobody, including the staff member attaching the login, ever
    knows what was set.
    """
    existing = firebase.get_user_by_email(email)
    if existing is not None:
        return str(existing.uid), False

    created = fb_auth.create_user(
        email=email,
        display_name=name or email,
        password=secrets.token_urlsafe(32),
        email_verified=False,
    )
    return str(created.uid), True


async def attach_login(
    partner_id: str,
    email: str,
    reason: str,
    actor: dict,
    name: str = "",
    phone: str = "",
) -> dict:
    """Give a partner record with no login an owner who can sign in.

    Refused if:

      * the partner does not exist, or Firestore cannot confirm that it does —
        the `crmUid` back-link lives on that document, so a lookup that failed
        cannot tell "no login attached" from "we could not read it";
      * a login is **already** attached, on either side of the link. Re-pointing
        a partner at a different person is not a repair, it is a handover, and
        it would silently orphan whoever held it;
      * the address belongs to somebody else — a staff account, a `crmUsers`
        document naming a different partner, or another `partners` record whose
        `owner_crm_uid` is the same uid.

    None of those creates anything: every check runs before the Firebase account
    does.
    """
    reason = _require_reason(reason)
    email = _normalise_email(email)
    pid = (partner_id or "").strip()
    if not pid:
        raise PartnerOpsError("A partner id is required.")

    db = get_db()
    partner = await _partner(pid)
    capability = _capability_of(partner.get("kind", ""))
    role = partner_role_for(partner.get("kind", ""))

    # ── Is a login already attached? Both halves of the link. ────────────────
    held = str(partner.get("owner_crm_uid") or "").strip()
    collection, source = await _firestore_partner(pid, None)
    held = held or _crm_login_of(source)
    if held:
        raise PartnerOpsError(
            f"{partner.get('name') or pid} already has a login attached. "
            "Attaching a second one would leave the first holder signed in to a "
            "record that no longer names them, so nothing was changed. Detach "
            "the existing login first if this is a handover."
        )

    # ── Does the address belong to somebody else? ────────────────────────────
    if await db[C.STAFF].find_one({"email": email}) is not None:
        raise PartnerOpsError(
            f"{email} is a staff account. Staff and partners are different "
            "kinds of account and one address cannot be both — sign-in resolves "
            "staff first, so this partner would never be reached. Nothing was "
            "created."
        )

    try:
        found = await asyncio.to_thread(_existing_crm_documents, email)
    except crm.DirectoryError as exc:
        raise PartnerOpsError(
            f"The CRM directory could not be searched for {email}, so it could "
            "not be confirmed that the address is free. Nothing was created — "
            "try again once Firestore is reachable."
        ) from exc

    for doc_id, data in found:
        named = str(
            data.get("agencyId") or data.get("sellerId") or ""
        ).strip()
        if named != pid:
            raise PartnerOpsError(
                f"{email} already holds a CRM account"
                + (f" for partner '{named}'" if named else "")
                + ". One address is one login, so nothing was created. Use a "
                "different address, or attach that login's partner record "
                f"instead (crmUsers/{doc_id})."
            )

    uid, account_created = await asyncio.to_thread(
        _resolve_or_create_login, email, name.strip() or str(partner.get("name") or "")
    )

    clash = await db[C.PARTNERS].find_one({"owner_crm_uid": uid})
    if clash is not None and str(clash["_id"]) != pid:
        raise PartnerOpsError(
            f"That address already signs in as partner '{clash['_id']}'. A "
            "login holds at most one agency record and one seller record, and "
            "they are granted through the second-capability application, not by "
            "attaching a login twice. Nothing was changed."
        )

    # ── The grant. Mongo first, audited immediately. ─────────────────────────
    now = _now()
    updated = await db[C.PARTNERS].find_one_and_update(
        {"_id": pid},
        {
            "$set": {
                "owner_crm_uid": uid,
                "login_attached_at": now,
                "login_attached_by": _who(actor),
                "login_attach_reason": reason,
                "login_email": email,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=Act.LOGIN_ATTACHED,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before={"owner_crm_uid": None, "login_email": None},
        after={"owner_crm_uid": uid, "login_email": email},
        meta={
            "kind": partner.get("kind"),
            "capability": capability,
            "session_role": str(role),
            "firebase_account_created": account_created,
            "firestore_collection": collection,
            # Said out loud because it is what stops this being an approval
            # route wearing a different name.
            "partner_status_unchanged": partner.get("status"),
            "grants": (
                "a sign-in only. The partner's status, balances and approval "
                "are untouched; an unapproved partner still gets a session that "
                "can reach no record."
            ),
        },
    )

    # ── The replicas. Both best effort, both reported. ───────────────────────
    directory_note = ""
    try:
        outcome = await crm.amirror(
            uid=uid,
            email=email,
            name=name.strip() or str(partner.get("name") or "") or email,
            role=role,
            created_by=actor.get("uid", ""),
            phone=phone.strip(),
            is_active=True,
            partner_id=pid,
            partner_status=str(partner.get("status") or PartnerStatus.PENDING),
        )
        directory_written = outcome.wrote_document
        directory_note = outcome.detail
    except crm.DirectoryError as exc:
        directory_written = False
        directory_note = str(exc)
        log.exception(
            "crmUsers/%s was not written for partner %s. The Mongo link is "
            "committed and audited, so the API session works; the CRM shell "
            "will not open until the document exists.",
            uid,
            pid,
        )

    replica_synced = await asyncio.to_thread(
        _sync_partner_doc, updated or partner, {"crmUid": uid}
    )

    out = _public(updated or partner)
    out["owner_crm_uid"] = uid
    out["login_email"] = email
    out["firebase_account_created"] = account_created
    out["crm_user_document_written"] = directory_written
    out["crm_user_document_note"] = directory_note
    out["replica_synced"] = replica_synced
    out["set_password_link"] = await asyncio.to_thread(_password_reset_link, email)
    out["note"] = (
        "A login is attached. This grants a sign-in and nothing else — the "
        f"partner is still {partner.get('status') or 'pending'}, holds exactly "
        "what it held before, and an unapproved partner's session can reach no "
        "record at all."
    )
    if not directory_written:
        out["warning"] = (
            "The API session will work — sign-in resolves this partner from "
            "Mongo — but the CRM shell reads the Firestore crmUsers document "
            f"and that was not written: {directory_note}"
        )
    return out


def _password_reset_link(email: str) -> str:
    """Blocking — a set-password link, or "" if one could not be made.

    Never fatal. The account exists and is attached either way, and a staff
    member can send a reset from the Firebase console; refusing a finished
    attachment over an email link would be the replica breaking the record.
    """
    try:
        return str(fb_auth.generate_password_reset_link(email) or "")
    except Exception:  # noqa: BLE001
        log.exception("Could not generate a set-password link for %s", email)
        return ""


# ══════════════════════════════════════════════════════════════════════════════
# 0b. The second capability — an agency that is also a seller, and vice versa
# ══════════════════════════════════════════════════════════════════════════════
#
# One person, one login, two businesses. An approved agency may apply to sell
# coins, and an approved coin seller may apply to run an agency.
#
# WHAT DOES NOT HAPPEN HERE.
#   The two `partners` records are NOT merged, and no field on either changes
#   meaning. Commission is an agency liability denominated in paise; coin
#   inventory is a seller position denominated in coins. They live in different
#   ledgers under different holder types (`HolderType.AGENCY` /
#   `HolderType.SELLER`) and they stay there. Every reader of `kind` —
#   `_fs_collection`, `commission.kind_of`, `partners.total_credit_exposure`,
#   `partners.overdue_sellers`, `reports` — sees exactly what it saw before,
#   because each record still holds exactly one kind. Adding a capability adds a
#   RECORD, never a column.
#
# WHAT LINKS THEM.
#   Three fields, all new, all read by nothing that existed before:
#
#     * `second_role_of`  — on the NEW record: the id of the partner record this
#                           capability was granted alongside. Its presence is
#                           what makes this an application for a second role
#                           rather than an ordinary new partner, and it is the
#                           only thing that switches on the extra behaviour in
#                           `approve_partner` / `reject_partner`. A partner
#                           without it behaves precisely as it did before.
#     * `linked_partner_id` — on the HELD record: the reverse pointer. Set when
#                           the application is filed, cleared if it is rejected.
#     * `owner_crm_uid`   — on both: the single CRM login behind them. It is
#                           read from the partner's own Firestore document
#                           (`crmUid`) and never supplied by the caller, for the
#                           same reason `kind` is not: it decides who gets to see
#                           the money.
#
# APPROVAL IS STAFF WORK, AND IT IS THE SAME QUEUE.
#   Filing an application creates the second record `pending` and holding
#   nothing, through `ensure_partner_record` — the same function, the same zero
#   opening, the same audit entry. It therefore appears in
#   `list_partners(kind=..., status='pending')`, which IS the queue the CRM's
#   /agencies and /sellers screens already read, and it is approved with the
#   Approve button already on those screens. Coin inventory is real money; a
#   second capability is reviewed exactly like a first one.


def _counterpart_kind(kind: str | PartnerKind) -> PartnerKind:
    """The capability a partner of this kind does not already have.

    A sub-agency's counterpart is a seller, the same as a main agency's — a
    second capability is a new business, not a promotion within the agency
    hierarchy, so `_derive_kind` still reads it from its own Firestore document.
    """
    if str(kind) == str(PartnerKind.SELLER):
        return PartnerKind.AGENCY
    return PartnerKind.SELLER


def _crm_login_of(source: dict) -> str:
    """The CRM login behind a Firestore agency or seller document.

    Both signup flows write `crmUid` back onto the partner document as soon as
    the account exists. That back-link is the only statement anywhere that this
    partner and that login are the same person, so it is what is used — never a
    uid handed in by whoever is calling.
    """
    return str(source.get("crmUid") or "").strip()


def _second_role_crm_fields(kind: str | PartnerKind, status: str) -> dict:
    """What one capability's state looks like on the `crmUsers` document.

    `roles` is the full set the login holds and `roleStatus` is per capability.
    Neither replaces `role` or `status`: those keep naming the capability the
    account was created with, so every legacy document, every existing rules
    predicate and every screen that reads `role` keeps working untouched.

    **`roleStatus` is returned as a nested map, not as a dotted key**, and the
    difference is the whole reason a granted second capability never appeared
    to have been granted.

    Firestore's `update()` reads `"roleStatus.agency"` as a path into a map.
    `set(..., merge=True)` does not — it takes the key literally, so the write
    landed as a top-level field whose *name* contained a full stop, sitting
    beside an untouched `roleStatus` map that still said `pending`.

    Every reader looks at the map. So the approval succeeded, was audited, and
    changed nothing anybody could see: the partner's own dashboard went on
    showing "application under review" indefinitely, and no screen anywhere
    disagreed with it. Both writers here use `set(merge=True)` — deliberately,
    since the document may not exist — so the shape has to suit that call.

    A nested map merges correctly under `merge=True`: `roleStatus.seller` is
    left alone while `roleStatus.agency` is written.
    """
    name = "seller" if str(kind) == str(PartnerKind.SELLER) else "agency"
    return {"role_name": name, "roleStatus": {name: status}}


def _read_crm_user(uid: str) -> dict:
    """Blocking — the `crmUsers` document behind a login, or an empty dict."""
    client = firebase.firestore_client()
    snapshot = client.collection("crmUsers").document(uid).get()
    return (snapshot.to_dict() or {}) if snapshot.exists else {}


#: Characters a referral code is built from. No 0/O and no 1/I/L — the code is
#: read off a screen and typed into a phone by somebody else, and those are the
#: pairs that get mistyped.
_REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _ensure_referral_code(partner: dict) -> str:
    """Blocking — the agency's permanent referral code, creating one if absent.

    **This is how a host joins an agency.** The host types the code into the
    Android app, and that is the only link between the two; the agency's own
    Invite Host form refuses to open without one — *"Agency referral code is
    missing. Contact superadmin to set it."*

    Only one of the two ways an agency can be created ever generated a code.
    `app/agencies/register/page.tsx` (staff creating an agency) does; the public
    `/agency-signup` form does not, and never has. So every agency that signed
    itself up — which is the path the business actually promotes — was approved,
    told it was live, and then found it could not recruit a single host. Nothing
    reported this, because from the CRM's side the agency looked complete.

    Generated at approval, because that is the first moment the agency is real
    and it must exist before they reach their dashboard.

    **Never regenerated.** A code already on the document is returned untouched,
    whatever it looks like. Codes are printed, forwarded on WhatsApp and typed
    weeks later; changing one silently orphans every host still holding it.

    Best effort, like every other Firestore write in this module: Mongo is
    already committed and audited by the time this runs, and an unreachable
    replica must not unwind an approval that has been made. A failure returns
    empty and the caller warns.
    """
    doc_id = str(partner.get("_id") or "")
    if not doc_id or str(partner.get("kind", "")) == str(PartnerKind.SELLER):
        return ""

    try:
        client = firebase.firestore_client()
        collection = _fs_collection(partner.get("kind", ""))
        ref = client.collection(collection).document(doc_id)

        snap = ref.get()
        doc = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
        existing = str(doc.get("referralCode") or "").strip().upper()
        if existing:
            return existing

        # A readable stem from the name, so a person can tell whose code it is.
        name = str(doc.get("agencyName") or partner.get("name") or "AGENCY")
        stem = "".join(c for c in name.upper() if c.isalnum())[:4] or "AGCY"

        for _ in range(8):
            suffix = "".join(secrets.choice(_REFERRAL_ALPHABET) for _ in range(4))
            candidate = f"{stem}{suffix}"
            taken = list(
                client.collection(collection)
                .where("referralCode", "==", candidate)
                .limit(1)
                .stream()
            )
            if taken:
                continue
            ref.set({"referralCode": candidate}, merge=True)
            log.info("Issued referral code %s to agency %s", candidate, doc_id)
            return candidate

        log.error("Could not find a free referral code for agency %s", doc_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not issue a referral code for agency %s: %s", doc_id, exc)
    return ""


def _has_kyc_documents(partner: dict) -> bool:
    """Blocking — does this partner have any identity document on file?

    Agencies carry `kycDocUrls` (three strings); sellers carry `idDocUrls`
    (labelled objects) and may also have a `registrationProofUrl`. Any one of
    them counts. A read failure returns True rather than False: the check exists
    to raise a warning, and a warning raised because Firestore hiccuped would
    train people to ignore it.
    """
    try:
        snap = (
            firebase.firestore_client()
            .collection(_fs_collection(partner.get("kind", "")))
            .document(str(partner.get("_id") or ""))
            .get()
        )
    except Exception:  # noqa: BLE001
        return True
    if not getattr(snap, "exists", False):
        return True

    doc = snap.to_dict() or {}
    for field in ("kycDocUrls", "idDocUrls"):
        value = doc.get(field)
        if isinstance(value, (list, tuple)) and any(
            (v.get("url") if isinstance(v, dict) else v) for v in value
        ):
            return True
    return bool(str(doc.get("registrationProofUrl") or "").strip())


def _declared_second_role_of(partner: dict) -> str:
    """Blocking — the partner this record is a second capability of, if it says so.

    Read from the Firestore document rather than from Mongo, because the
    applicant writes it themselves at the moment they apply
    (`lib/partnerRoles.ts::requestSecondRole` → `secondRoleOfPartnerId`) and the
    Mongo record does not exist yet at that point.

    Only trusted to *identify* the held record. It grants nothing on its own:
    `_grant_second_role` re-reads that partner, and a claim naming a record the
    caller does not own fails there, on the same ownership check as everything
    else.
    """
    try:
        snap = (
            firebase.firestore_client()
            .collection(_fs_collection(partner.get("kind", "")))
            .document(str(partner.get("_id") or ""))
            .get()
        )
    except Exception:  # noqa: BLE001
        return ""
    if not getattr(snap, "exists", False):
        return ""

    doc = snap.to_dict() or {}
    if str(doc.get("source") or "") != "second_role":
        return ""
    return str(doc.get("secondRoleOfPartnerId") or "").strip()


def _login_uid_of(partner: dict) -> str:
    """The CRM login behind a partner, from Mongo first and Firestore second.

    `owner_crm_uid` is set on the Mongo record by the second-role flow and by
    `attach-login`; `crmUid` is written onto the Firestore document by all four
    signup paths. Either is authoritative and most partners have only one, so
    both are tried.
    """
    uid = str(partner.get("owner_crm_uid") or "").strip()
    if uid:
        return uid
    try:
        snap = (
            firebase.firestore_client()
            .collection(_fs_collection(partner.get("kind", "")))
            .document(str(partner.get("_id") or ""))
            .get()
        )
        return _crm_login_of(snap.to_dict() or {} if snap.exists else {})
    except Exception:  # noqa: BLE001 — a missing replica is not fatal here
        return ""


async def _revoke_partner_sessions(partner: dict) -> int:
    """Kill every live API session belonging to this partner's login.

    ── WHY A REFUSAL HAD TO WAIT SEVEN DAYS ─────────────────────────────────

    Rejecting or suspending a partner wrote Mongo, mirrored the decision onto
    the `agencies`/`sellers` document and onto `crmUsers`, and touched nothing
    else. Authority for an external session is `partner_ids`, which is stamped
    into the token at sign-in and never re-read — `own_partner_id_or_403`
    compares against the claim, not against `partners.status`. So a rejected or
    suspended seller kept filing coin purchases and sales until their token
    expired, and `session_ttl_minutes` is 10 080: seven days.

    Renewal was already closed — `renew_session` re-runs `resolve_partner_login`,
    which raises on a rejected or suspended record — so the hole was bounded.
    Bounded by a week is not closed.

    The uid is the one the session was issued to: `owner_crm_uid` on the Mongo
    record, which is what `resolve_partner_login` matches on. Reported rather
    than raised — a refusal that has already written the record must not fail
    because the session sweep did, and the caller surfaces the count.
    """
    uid = str(partner.get("owner_crm_uid") or "").strip()
    if not uid:
        return 0
    result = await get_db()[C.SESSIONS].update_many(
        {"uid": uid, "revoked": {"$ne": True}}, {"$set": {"revoked": True}}
    )
    return int(getattr(result, "modified_count", 0) or 0)


def _mirror_login_status(partner: dict, status: str) -> bool:
    """Put the partner's decided status onto their `crmUsers` login.

    **This is what makes an approval reach the person it is about.**

    `approve_partner` updated Mongo and mirrored the decision onto the
    `agencies`/`sellers` document, and stopped there. The CRM does not route on
    either of those — it routes on `crmUsers.status`, which was written
    `'pending'` at signup and which nothing in the running system ever changed.

    So an approved agency stayed `pending` to every screen that mattered, and
    the consequences ran a long way:

      * `allowedPartnerPaths` never added `/agency-dashboard`, so the owner was
        redirected to the waiting room and could not reach their own portal. The
        approval had visibly happened in the CRM and changed nothing for them.
      * The Invite Host form lives on that dashboard, so no host could be
        invited, so `hostApplications` stayed empty — and the host KYC queue,
        which has no other source, was empty for the same reason.
      * `availableSecondRole()` requires the primary capability to be approved,
        so the "also become a coin seller" card never appeared either.

    Four separate reports, one missing write.

    Best effort, like `_sync_partner_doc`: Mongo is committed and audited before
    this runs, and a Firestore outage must not unwind a decision. The caller
    reports whether the replica took it.
    """
    uid = _login_uid_of(partner)
    if not uid:
        # No login is attached yet — an orphan record, or a partner registered
        # by staff whose account was never created. Nothing to mirror onto, and
        # not an error: `attach-login` is the path that fixes it.
        return False

    fields = _second_role_crm_fields(partner.get("kind", ""), status)
    name = str(fields.pop("role_name"))
    try:
        from firebase_admin import firestore as fb_firestore

        firebase.firestore_client().collection("crmUsers").document(uid).set(
            {
                # Remove the field a dotted key created before that bug was
                # found: a top-level entry literally NAMED "roleStatus.agency",
                # sitting beside the real map and read by nothing. Harmless, but
                # it is the sort of residue that makes the next person doubt
                # which of the two is authoritative.
                f"roleStatus.{name}": fb_firestore.DELETE_FIELD,
                # `status` is what every legacy predicate and the routing table
                # read. `roleStatus.<name>` is the per-capability form a
                # dual-role login needs. Both, so neither reader is surprised.
                "status": status,
                **fields,
                "isActive": status in (str(PartnerStatus.APPROVED), "approved"),
            },
            merge=True,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Could not mirror status %r onto crmUsers/%s for partner %s: %s",
            status,
            uid,
            partner.get("_id"),
            exc,
        )
        return False


def _write_second_role_state(
    owner_uid: str,
    kind: str | PartnerKind,
    status: str,
    partner_id: str,
    held_partner_id: str,
) -> bool:
    """Put one capability's state on the login, and cross-link the two documents.

    Runs with the Admin SDK, which bypasses the security rules — deliberately.
    Granting a capability is a staff decision, and a decision a browser can make
    for itself is not a decision. The rules let a partner *apply* (write
    `roleStatus.x = 'pending'` bound to an application that names their verified
    email) and nothing more; only this function ever writes `approved`.

    Best effort, exactly like `_sync_partner_doc`: Mongo is already committed by
    the time this runs, and a Firestore outage must not unwind a decision that
    has been made and audited. It returns whether the replica took it.
    """
    fields = _second_role_crm_fields(kind, status)
    name = str(fields.pop("role_name"))
    link_field = "sellerId" if name == "seller" else "agencyId"

    try:
        client = firebase.firestore_client()
        existing = _read_crm_user(owner_uid)
        held = [
            r
            for r in (existing.get("roles") or [existing.get("role", "")])
            if r in ("agency", "seller")
        ]
        if status == "rejected":
            roles = [r for r in held if r != name]
        else:
            roles = held + ([name] if name not in held else [])

        # The link id is written whatever the outcome, including a rejection:
        # it is how the applicant's own screen finds the application it filed
        # and reads the reason it was refused. What a rejection withholds is the
        # capability itself, which is `roles` — and `roles` is the only thing
        # any screen or rule consults before showing money.
        payload: dict = {**fields, "roles": roles, link_field: partner_id}
        client.collection("crmUsers").document(owner_uid).set(payload, merge=True)

        # The two partner documents point at each other, so a staff member
        # looking at either one can see the other exists.
        counterpart = "sellers" if name == "seller" else "agencies"
        held_collection = "agencies" if name == "seller" else "sellers"
        granted = status == "approved"
        client.collection(held_collection).document(held_partner_id).set(
            {
                ("linkedSellerId" if name == "seller" else "linkedAgencyId"): (
                    partner_id if granted else ""
                ),
                ("isSeller" if name == "seller" else "isAgency"): granted,
            },
            merge=True,
        )
        client.collection(counterpart).document(partner_id).set(
            {
                ("linkedAgencyId" if name == "seller" else "linkedSellerId"): (
                    held_partner_id
                ),
                ("isAgency" if name == "seller" else "isSeller"): True,
            },
            merge=True,
        )
        return True
    except Exception:  # noqa: BLE001
        log.exception(
            "Could not write the %s capability (%s) for login %s to Firestore. "
            "Mongo is authoritative and the decision stands.",
            name,
            status,
            owner_uid,
        )
        return False


async def grant_second_capability(
    held_partner_id: str,
    kind: PartnerKind,
    name: str,
    phone: str,
    reason: str,
    actor: dict,
) -> dict:
    """Staff give an existing partner their second capability, start to finish.

    **The path that was missing.** A second capability could only ever begin
    with the partner applying from their own dashboard. There was no way for an
    owner to grant one, and the obvious substitute — creating a fresh agency on
    `/agencies/register` — does something quite different: it refuses outright
    if the address already holds a record, and otherwise makes a *separate*
    business with a *separate* login. The seller's own login gains nothing, so
    they sign in and are still told their application is under review, by a
    system that never received one.

    So this creates both halves and links them:

      1. the Firestore document, carrying `crmUid` — their existing login, read
         from the record they already hold and never supplied by the caller —
         plus `source: 'second_role'` and `secondRoleOfPartnerId`
      2. the Mongo partner record, holding nothing, with `second_role_of` set

    **It approves nothing.** The result is `pending`, exactly as an application
    the partner filed themselves would be, and it goes through the same review
    and the same Approve button. Creating a capability and granting it stay two
    decisions, because the second one is where somebody says the documents and
    the bank account are in order.

    Identity documents are carried over from the record they already hold. It is
    the same person and they were verified once; asking for the same Aadhaar a
    second time is friction with no reader. Bank details are **not** carried:
    an agency is paid and a seller pays, so a seller's record has no account to
    pay commission into, and that is a real gap the approver must chase.
    """
    reason = _require_reason(reason)
    held = await _approved_partner(held_partner_id)

    if str(held.get("kind", "")) == str(kind):
        raise PartnerOpsError(
            f"{held.get('name') or held_partner_id} is already a "
            f"{'coin seller' if kind is PartnerKind.SELLER else 'agency'}."
        )
    if held.get("linked_partner_id"):
        raise PartnerOpsError(
            f"{held.get('name') or held_partner_id} already holds a second "
            "capability. One login holds at most one of each kind."
        )

    uid = await asyncio.to_thread(_login_uid_of, held)
    if not uid:
        raise PartnerOpsError(
            "This partner has no CRM login attached, so there is nobody to "
            "grant a second capability to. Attach a login to the record first."
        )

    new_id = await asyncio.to_thread(
        _create_second_capability_doc, held, kind, name, phone, uid, reason
    )
    if not new_id:
        raise PartnerOpsError(
            "The record for the new capability could not be written. Nothing "
            "was created and nothing was granted."
        )

    return await request_second_role(
        partner_id=held_partner_id,
        new_partner_id=new_id,
        reason=reason,
        actor=actor,
    )


def _create_second_capability_doc(
    held: dict,
    kind: PartnerKind,
    name: str,
    phone: str,
    uid: str,
    reason: str,
) -> str:
    """Blocking — the Firestore document behind a staff-granted capability.

    Written with the Admin SDK, which bypasses the security rules. That is
    correct here and not a shortcut: the rules let a *partner* file an
    application about themselves, and this is a staff decision about somebody
    else. Every balance is pinned to zero regardless, and the record is
    `pending` — it can hold nothing and reach nothing until it is approved.
    """
    from firebase_admin import firestore as fb_firestore

    client = firebase.firestore_client()
    collection = "sellers" if kind is PartnerKind.SELLER else "agencies"

    source = {}
    try:
        snap = (
            client.collection(_fs_collection(held.get("kind", "")))
            .document(str(held["_id"]))
            .get()
        )
        source = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read %s for carry-over: %s", held.get("_id"), exc)

    email = str(
        source.get("ownerEmail") or source.get("email") or ""
    ).strip().lower()
    # The same person, verified once. Carried so the reviewer sees what was
    # already checked rather than an empty record.
    docs = source.get("kycDocUrls") or [
        d.get("url") for d in (source.get("idDocUrls") or []) if isinstance(d, dict)
    ]
    docs = [d for d in docs if d]

    common = {
        "crmId": _generate_crm_id(),
        "crmUid": uid,
        "status": "pending",
        "isActive": False,
        "source": "second_role",
        "secondRoleOwnerUid": uid,
        "secondRoleOfPartnerId": str(held["_id"]),
        "secondRoleReason": reason,
        "createdAt": fb_firestore.SERVER_TIMESTAMP,
    }

    if kind is PartnerKind.SELLER:
        payload = {
            **common,
            "displayName": name,
            "phone": phone,
            "email": email,
            # Money. Zero here, zero in the rules, and loaded only by a signed
            # coin-purchase card.
            "coinBalance": 0,
            "totalCoinsSold": 0,
            "registrationFeePaid": False,
            "qrCodeUrl": "",
            "idDocUrls": [{"label": "Carried from their agency record", "url": u} for u in docs],
        }
    else:
        payload = {
            **common,
            "agencyName": name,
            "ownerName": str(source.get("displayName") or source.get("ownerName") or name),
            "ownerPhone": phone,
            "ownerEmail": email,
            "type": "main",
            "parentAgencyId": None,
            "kycStatus": "pending",
            "kycDocUrls": docs,
            "currency": "INR",
            "totalHosts": 0,
            "totalSubAgencies": 0,
        }

    try:
        _, ref = client.collection(collection).add(payload)
        return str(ref.id)
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not create the second-capability document: %s", exc)
        return ""


def _generate_crm_id() -> str:
    """An 8-character human-readable id, matching `generateCrmId` in the CRM."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def request_second_role(
    partner_id: str,
    new_partner_id: str,
    reason: str,
    actor: dict,
) -> dict:
    """File an approved partner's application for the capability it lacks.

    Creates the second record **holding nothing** — zero coins, zero credit,
    zero commission, zero cash — and `pending`, through `ensure_partner_record`.
    An opening inventory load is a separate signed card, as it already is.

    Refused if the partner is not approved, if it already holds or has applied
    for the second capability, or if the Firestore document offered belongs to a
    different login. None of those leaves anything half-written: the only
    creation is `ensure_partner_record`'s, which is idempotent.
    """
    reason = _require_reason(reason)
    pid = (partner_id or "").strip()
    new_id = (new_partner_id or "").strip()
    if not pid or not new_id:
        raise PartnerOpsError("Both partner ids are required.")
    if pid == new_id:
        raise PartnerOpsError(
            "A partner cannot be its own second capability. The second record is "
            "a different agency or seller document, with its own balances."
        )

    held = await _approved_partner(pid)
    wanted = _counterpart_kind(held.get("kind", ""))

    existing_link = str(held.get("linked_partner_id") or "")
    if existing_link:
        raise PartnerOpsError(
            f"{held.get('name') or pid} already has a {wanted} record "
            f"('{existing_link}'). One login holds at most one of each kind — "
            "nothing was created."
        )

    _, held_source = await _firestore_partner(pid, None)
    owner_uid = _crm_login_of(held_source)
    if not owner_uid:
        raise PartnerOpsError(
            f"{held.get('name') or pid} has no CRM login on its Firestore "
            "document (`crmUid`), so there is nobody to grant a second "
            "capability to. Nothing was created."
        )

    _, new_source = await _firestore_partner(new_id, wanted)
    new_owner = _crm_login_of(new_source)
    if new_owner and new_owner != owner_uid:
        raise PartnerOpsError(
            f"'{new_id}' belongs to a different CRM login. A second capability "
            "is granted to the same person, on the same login — nothing was "
            "created."
        )

    doc, created, warnings = await ensure_partner_record(new_id, actor, reason, wanted)
    if not created and str(doc.get("second_role_of") or "") != pid:
        raise PartnerOpsError(
            f"'{new_id}' already exists as a {doc.get('kind') or 'partner'} in "
            "its own right. A second capability is a new record, not an existing "
            "partner adopted — nothing was changed."
        )

    now = _now()
    db = get_db()
    updated = await db[C.PARTNERS].find_one_and_update(
        {"_id": new_id},
        {
            "$set": {
                "second_role_of": pid,
                "owner_crm_uid": owner_uid,
                "second_role_requested_at": now,
                "second_role_requested_by": _who(actor),
                "second_role_reason": reason,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    await db[C.PARTNERS].update_one(
        {"_id": pid},
        {
            "$set": {
                "linked_partner_id": new_id,
                "owner_crm_uid": owner_uid,
                "updated_at": now,
            }
        },
    )

    await audit.record(
        actor=actor,
        action=Act.SECOND_ROLE_REQUESTED,
        subject_type="partner",
        subject_id=new_id,
        reason=reason,
        before=None,
        after={
            "kind": str(wanted),
            "status": str(PartnerStatus.PENDING),
            "second_role_of": pid,
            "owner_crm_uid": owner_uid,
        },
        meta={
            "held_partner_id": pid,
            "held_kind": held.get("kind"),
            "requested_kind": str(wanted),
            "record_created": created,
            "opened_at_zero": True,
            "warnings": warnings,
        },
    )

    replica = await asyncio.to_thread(
        _write_second_role_state, owner_uid, wanted, "pending", new_id, pid
    )

    out = _public(updated or doc)
    out["created"] = created
    out["warnings"] = warnings
    out["owner_crm_uid"] = owner_uid
    out["replica_synced"] = replica
    out["note"] = (
        f"Filed as a {wanted} application for the same login. It is in the "
        "pending queue with every other partner application, holding nothing — "
        "no coins, no credit, no commission. Approving it is a separate "
        "decision and an opening load is a separate signed card."
    )
    return out


async def _grant_second_role(partner: dict, reason: str, actor: dict) -> dict:
    """Approval's tail, and only for a record that is a second capability.

    A partner record without `second_role_of` never reaches this — the caller
    checks first — so a single-capability partner's approval is unchanged, down
    to the audit entries it writes.
    """
    held_id = str(partner.get("second_role_of") or "")
    owner_uid = str(partner.get("owner_crm_uid") or "")
    kind = str(partner.get("kind") or "")

    await audit.record(
        actor=actor,
        action=Act.SECOND_ROLE_APPROVED,
        subject_type="partner",
        subject_id=str(partner["_id"]),
        reason=reason,
        before={"status": str(PartnerStatus.PENDING)},
        after={
            "status": str(PartnerStatus.APPROVED),
            "kind": kind,
            "second_role_of": held_id,
            "owner_crm_uid": owner_uid,
        },
        meta={
            "held_partner_id": held_id,
            "granted_kind": kind,
            # Said out loud because it is the whole safety property: the record
            # this approval turns on holds nothing at all.
            "opened_at_zero": True,
            "balances_separate": (
                "Commission and coin inventory stay on their own records, in "
                "their own ledgers, under their own holder types."
            ),
        },
    )

    synced = await asyncio.to_thread(
        _write_second_role_state,
        owner_uid,
        kind,
        "approved",
        str(partner["_id"]),
        held_id,
    )
    return {
        "held_partner_id": held_id,
        "owner_crm_uid": owner_uid,
        "granted_kind": kind,
        "replica_synced": synced,
    }


async def _reject_second_role(partner: dict, reason: str, actor: dict) -> dict:
    """Rejection's tail. The reason travels, and the link is released."""
    held_id = str(partner.get("second_role_of") or "")
    owner_uid = str(partner.get("owner_crm_uid") or "")
    kind = str(partner.get("kind") or "")

    if held_id:
        await get_db()[C.PARTNERS].update_one(
            {"_id": held_id},
            {"$set": {"linked_partner_id": None, "updated_at": _now()}},
        )

    await audit.record(
        actor=actor,
        action=Act.SECOND_ROLE_REJECTED,
        subject_type="partner",
        subject_id=str(partner["_id"]),
        reason=reason,
        before={"status": str(PartnerStatus.PENDING)},
        after={"status": str(PartnerStatus.REJECTED), "rejection_reason": reason},
        meta={"held_partner_id": held_id, "refused_kind": kind},
    )

    synced = await asyncio.to_thread(
        _write_second_role_state,
        owner_uid,
        kind,
        "rejected",
        str(partner["_id"]),
        held_id,
    )
    return {
        "held_partner_id": held_id,
        "owner_crm_uid": owner_uid,
        "refused_kind": kind,
        "replica_synced": synced,
    }


# ══════════════════════════════════════════════════════════════════════════════
# 0c. Virtual account numbers — built ready, switched on when the bank exists
# ══════════════════════════════════════════════════════════════════════════════
#
# WHAT A VAN IS AND WHY IT MATTERS.
#   Spec 8C.1: a virtual account number is a unique account number the bank maps
#   onto one real, KYC-compliant business current account. To the payer it looks
#   like an ordinary account and takes NEFT, RTGS, IMPS and UPI; to us every
#   credit into it identifies the payer, the amount and the time (8C.1.5). 4.3.4
#   and 8C.1.4 issue one to every coin seller **on approval**, permanently, shown
#   in their portal.
#
#   That is what removes the UTR-and-screenshot dance. Today a seller pays us,
#   types a reference and uploads an image, and `find_duplicate_payment_refs`
#   exists to catch the same reference being submitted twice — a control that is
#   only necessary because the reference is typed by the person it identifies.
#   With a VAN the bank tells us who paid; nothing is typed and nothing is
#   duplicated.
#
# WHY IT IS NOT ON.
#   HDFC sells this as eCMS (8C.1.6 / 8C.8), and 8C.8.7 requires the account
#   underneath to be a **business current account**. The owner is on a personal
#   account. There is no collection account, so there is no range of virtual
#   numbers to allocate from, so no seller can be issued one.
#
# THE RULE THIS SECTION IS BUILT AROUND.
#   **A VAN is never synthesised.** Not from a prefix and a counter, not from a
#   partner id, not from a CRM id. A number this system invented is not an
#   account anyone can pay into, and putting one in a seller's portal would send
#   real money to a bank that has never heard of it. So there are exactly two
#   states — a number the bank issued, or no number and the reason why — and the
#   second one is what every record says today.
#
# WHAT HAPPENS WHEN THE BANK ACCOUNT OPENS.
#   1. Set `van_provider`, `van_ifsc`, `van_beneficiary_name` and
#      `van_collection_account` (app/config.py) from what HDFC issues.
#   2. Register an eCMS client with `register_van_allocator`. It is handed the
#      partner and must return the number **the bank allocated**; anything it
#      invents is the failure this design exists to prevent.
#   3. Approving a seller from then on issues one in the same flow, audited.
#   4. Sellers approved before then have none. `issue_virtual_account` is the
#      backfill for them, one partner at a time, each with its own reason and
#      its own audit entry — reachable at
#      `POST /partner-ops/partners/{id}/virtual-account`.
#
# Nothing else in this module changes when that happens. The UTR path stays
# exactly where it is: it is the live one, and a seller with no VAN still pays
# and sends a reference exactly as they do now.


#: What a bank statement line must carry before `identify_payer` can match it to
#: a seller. Written down here because the feed does not exist yet and the shape
#: of it is the contract with whoever builds it — a field missing from this list
#: is a credit that cannot be attributed to anybody.
#:
#: `credited_to` is the whole point: it is the **virtual** account number the
#: money landed in, not the collection account, and it is the only field that
#: identifies the payer. A feed that reports the collection account for every
#: line has told us nothing we did not know.
VAN_STATEMENT_LINE_FIELDS: dict[str, str] = {
    "credited_to": (
        "The virtual account number the credit landed in. This is the identity "
        "of the payer (8C.1.5) and the only field that can match a seller."
    ),
    "amount_minor": "Amount credited, in paise. Integer — never a rupee float.",
    "credited_at": "When the bank credited it, with a timezone.",
    "bank_reference": (
        "The bank's own reference for the credit (UTR/RRN). Not typed by the "
        "payer — it is what makes a replayed statement idempotent."
    ),
    "collection_account": (
        "The real current account underneath (8C.1.3). Checked against "
        "`van_collection_account` so a line from somebody else's feed cannot "
        "credit one of our sellers."
    ),
    "remitter_name": "Optional. Shown to the reviewer; never used to match.",
    "remitter_account": "Optional. Shown to the reviewer; never used to match.",
}


#: The bank's allocation call, or None. Registered by whoever wires the eCMS
#: client; there is no default implementation and there deliberately never will
#: be a local one, because "allocate a virtual account number" is an operation
#: only the bank can perform.
_van_allocator: Callable[[dict], Mapping[str, str]] | None = None


def register_van_allocator(
    allocator: Callable[[dict], Mapping[str, str]] | None,
) -> None:
    """Wire the bank's allocation call. `None` unregisters it.

    The allocator is handed the partner document and must return a mapping with
    at least `{"number": "<the account number the BANK issued>"}`. It may also
    return `ifsc` and `beneficiary_name` to override the configured ones — a
    bank that issues a per-VAN IFSC is a real thing and the configured value is
    only the default.

    It is called off the event loop (`asyncio.to_thread`), so a blocking HTTP
    client is fine.
    """
    global _van_allocator
    _van_allocator = allocator


def van_bank_configured() -> bool:
    """Is there a real collection account to map virtual numbers onto?

    All four settings, or none of it. A half-configured bank is not a bank: a
    number with no IFSC cannot be paid into, and a number with no beneficiary
    name is rejected at the payer's own bank. Absent is the live answer today
    and it means **not issued yet** — never a fabricated number.
    """
    return all(
        str(value or "").strip()
        for value in (
            settings.van_provider,
            settings.van_ifsc,
            settings.van_beneficiary_name,
            settings.van_collection_account,
        )
    )


#: The sentence a seller and a staff member both see when there is no VAN. One
#: string so the portal, the CRM and the audit log cannot describe the same
#: absence three different ways.
VAN_NO_BANK = (
    "No virtual account number has been issued. Virtual accounts need an HDFC "
    "eCMS collection account, and eCMS requires a business current account "
    "(8C.8.7) — Zipper does not hold one yet, so the bank has no number to "
    "issue. Nothing here is broken and nothing is missing from this record: "
    "until that account exists, payments are made the existing way and the "
    "payment reference is sent with them."
)

VAN_NO_ALLOCATOR = (
    "No virtual account number has been issued. A collection account is "
    "configured but no bank client is wired to allocate from it, and a VAN is "
    "issued by the bank — never generated here. Register an allocator with "
    "partner_ops.register_van_allocator, then issue one for this partner."
)

VAN_NOT_A_SELLER = (
    "Virtual account numbers are issued to coin sellers (8C.1.4). They are a "
    "collection instrument — they exist so money coming IN identifies who sent "
    "it — and an agency is paid by us rather than paying us."
)


def _van_record(partner: dict) -> dict:
    raw = partner.get("virtual_account")
    return dict(raw) if isinstance(raw, dict) else {}


def virtual_account_view(partner: dict) -> dict:
    """A partner's VAN as any reader may see it — the portal, the CRM, both.

    Two states and no third. Either a number the bank issued, with everything a
    payer needs to send money to it, or `issued: False` and a sentence saying
    why. There is no "unknown": a record with no `virtual_account` has not been
    issued one, which is a fact rather than a gap.

    **Deliberately does not carry who issued it.** This view is read by the
    partner themselves through `GET /partner-ops/partners/{id}`, and which staff
    member pressed the button is not theirs; it is on the `partner.van_issued`
    audit entry, where a staff member reading `/audit` for this partner finds it.
    """
    record = _van_record(partner)
    number = str(record.get("number") or "").strip()
    configured = van_bank_configured()

    if number:
        return {
            "issued": True,
            "number": number,
            "ifsc": record.get("ifsc") or "",
            "beneficiary_name": record.get("beneficiary_name") or "",
            "provider": record.get("provider") or "",
            "collection_account": record.get("collection_account") or "",
            "issued_at": record.get("issued_at"),
            "bank_configured": configured,
            "note": (
                "Permanent, and this partner's for life (8C.1.4). Every payment "
                "into it identifies the payer, so no payment reference has to be "
                "typed and no screenshot has to be accepted."
            ),
        }

    if not configured:
        reason = VAN_NO_BANK
    elif _van_allocator is None:
        reason = VAN_NO_ALLOCATOR
    else:
        reason = str(record.get("last_failure") or "").strip() or (
            "No virtual account number has been issued to this partner yet. The "
            "bank is configured, so one can be issued for them now."
        )

    return {
        "issued": False,
        "number": None,
        "ifsc": "",
        "beneficiary_name": "",
        "provider": "",
        "collection_account": "",
        "issued_at": None,
        "bank_configured": configured,
        "reason": reason,
    }


def _van_absent(reason: str) -> dict:
    """"No number, and here is why" — in the same shape as an issued one.

    Every caller of `virtual_account_view` gets the full set of keys whether or
    not a number exists, and so must every other path that answers the same
    question. A screen that reads `virtual_account.ifsc` off the approval
    response and `virtual_account.ifsc` off the record page must not find the
    key present on one and absent on the other.
    """
    view = virtual_account_view({})
    view["reason"] = reason
    return view


def _allocate_van(partner: dict) -> dict:
    """Blocking — ask the bank for this partner's number.

    Every failure mode returns rather than raises, because the caller is
    approval and approval must not fail over a bank that is down. What it must
    never do is return a number nobody asked the bank for.
    """
    if not van_bank_configured():
        return {"number": "", "why": VAN_NO_BANK}
    allocator = _van_allocator
    if allocator is None:
        return {"number": "", "why": VAN_NO_ALLOCATOR}

    try:
        issued = allocator(partner) or {}
    except Exception as exc:  # noqa: BLE001
        log.exception(
            "The bank refused or could not be reached when allocating a virtual "
            "account for partner %s",
            partner.get("_id"),
        )
        return {
            "number": "",
            "why": (
                "The bank could not allocate a virtual account number for this "
                f"partner: {exc}. Nothing was issued and no number was invented. "
                "The partner is otherwise unaffected — try again."
            ),
        }

    number = str(issued.get("number") or "").strip()
    if not number:
        return {
            "number": "",
            "why": (
                "The bank client returned no account number, so none was "
                "recorded. A blank answer is not a number and is never filled "
                "in from anywhere else."
            ),
        }

    return {
        "number": number,
        "ifsc": str(issued.get("ifsc") or settings.van_ifsc).strip(),
        "beneficiary_name": str(
            issued.get("beneficiary_name") or settings.van_beneficiary_name
        ).strip(),
        "provider": str(settings.van_provider).strip(),
        "collection_account": str(settings.van_collection_account).strip(),
    }


async def _ensure_virtual_account(partner: dict, reason: str, actor: dict) -> dict:
    """Issue this partner's VAN if they have none and the bank can give one.

    **Never regenerates.** A VAN is permanent (8C.1.4): a seller prints it,
    saves it as a payee, gives it to the people who pay them. Issuing a second
    one would silently orphan every standing instruction pointing at the first,
    and money paid into a number we had stopped watching would arrive nowhere.
    So an existing number is returned untouched, and the bank is not called.

    Best effort by design — this runs inside `approve_partner`, and a partner
    who is approved is approved whether or not a bank answered.
    """
    pid = str(partner.get("_id") or "")
    existing = _van_record(partner)
    if str(existing.get("number") or "").strip():
        view = virtual_account_view(partner)
        view["already_held"] = True
        view["note"] = (
            "This partner already holds a virtual account number, so none was "
            "issued. A VAN is permanent and is never regenerated — reissuing "
            "would orphan every standing instruction pointing at the old one."
        )
        return view

    if partner.get("kind") != str(PartnerKind.SELLER):
        return _van_absent(VAN_NOT_A_SELLER)

    allocated = _allocate_van(partner)
    number = allocated.get("number") or ""
    now = _now()

    if not number:
        why = str(allocated.get("why") or VAN_NO_BANK)

        if not van_bank_configured():
            # There is no bank. That is a standing fact about the business, not
            # an incident about this partner — it is identically true of every
            # seller and will be until the current account opens. Writing it to
            # the record and the audit log on every approval would put the same
            # sentence on every partner and an entry in `/audit` for a thing
            # that did not happen, which is how a log stops being read. The
            # answer lives in `virtual_account_view`, which derives it from the
            # configuration every time it is asked.
            return _van_absent(why)

        # The bank IS configured and issuance still did not happen: the client
        # is missing, or it raised, or it answered with nothing. That is an
        # incident about this partner, it is actionable, and a seller who was
        # supposed to get a number and did not must be visible rather than
        # merely blank. Recorded on the record so the portal and the CRM read
        # the same sentence, and audited.
        await get_db()[C.PARTNERS].update_one(
            {"_id": pid},
            {
                "$set": {
                    "virtual_account.last_attempt_at": now,
                    "virtual_account.last_failure": why,
                    "updated_at": now,
                }
            },
        )
        await audit.record(
            actor=actor,
            action=Act.VAN_NOT_ISSUED,
            subject_type="partner",
            subject_id=pid,
            reason=reason,
            before=None,
            after={"virtual_account_number": None},
            meta={
                "bank_configured": True,
                "provider": str(settings.van_provider or ""),
                "why": why,
                "fabricated": False,
                "payment_path": (
                    "unchanged — this seller pays as before and sends the "
                    "payment reference with it"
                ),
            },
        )
        return _van_absent(why)

    record = {
        "number": number,
        "ifsc": allocated.get("ifsc", ""),
        "beneficiary_name": allocated.get("beneficiary_name", ""),
        "provider": allocated.get("provider", ""),
        "collection_account": allocated.get("collection_account", ""),
        "issued_at": now,
        "issued_by": _who(actor),
        "issue_reason": reason,
    }
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": pid},
        {"$set": {"virtual_account": record, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=Act.VAN_ISSUED,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before={"virtual_account_number": None},
        after={"virtual_account_number": number},
        meta={
            "provider": record["provider"],
            "ifsc": record["ifsc"],
            "collection_account": record["collection_account"],
            "allocated_by": "the bank — this number was not generated here",
            "permanent": True,
        },
    )

    synced = await asyncio.to_thread(
        _sync_partner_doc,
        updated or partner,
        {
            "virtualAccountNumber": number,
            "virtualAccountIfsc": record["ifsc"],
            "virtualAccountName": record["beneficiary_name"],
            "virtualAccountIssuedAt": now,
        },
    )

    view = virtual_account_view(updated or {**partner, "virtual_account": record})
    view["replica_synced"] = synced
    return view


async def issue_virtual_account(partner_id: str, reason: str, actor: dict) -> dict:
    """Issue a VAN for an approved seller that has none — the backfill path.

    Every seller approved before the bank account existed has no number, and
    approval is not run twice. This is how they get one, one partner at a time,
    each with its own reason and its own audit entry.

    Refused for a partner that is not approved: a VAN is a standing instruction
    to accept money in this partner's name, and an application under review is
    not somebody we accept money for. Refused, loudly, if there is no bank —
    unlike the approval path, somebody is here asking for a number and telling
    them "done" while issuing nothing would be a lie.
    """
    reason = _require_reason(reason)
    partner = await _approved_partner(partner_id, PartnerKind.SELLER)

    existing = _van_record(partner)
    if str(existing.get("number") or "").strip():
        raise PartnerOpsError(
            f"{partner.get('name') or partner_id} already holds virtual account "
            f"{existing['number']}. A VAN is permanent (8C.1.4) and is never "
            "reissued — a second number would orphan every standing instruction "
            "pointing at the first. Nothing was changed."
        )

    if not van_bank_configured():
        raise PartnerOpsError(VAN_NO_BANK)
    if _van_allocator is None:
        raise PartnerOpsError(VAN_NO_ALLOCATOR)

    result = await _ensure_virtual_account(partner, reason, actor)
    if not result.get("issued"):
        raise PartnerOpsError(str(result.get("reason") or VAN_NO_BANK))
    return result


# ── The reconciliation seam ───────────────────────────────────────────────────
#
# The half that cannot be built: the bank feed. eCMS reports credits into the
# collection account — as a file drop, a webhook or a pull — and until there is
# an account there is nothing to report and nothing to poll. What CAN be built
# is the join, and this is it: given one statement line, which seller does this
# money belong to?
#
# It is deliberately only identification. It moves no coins, raises no card and
# changes no balance, because attributing a payment and acting on it are two
# decisions and only the first one is safe to make from a file. What comes next
# once a feed exists is a `seller_coin_purchase` card raised on the seller's
# behalf carrying `auto_verified=True` — spec 5.3.1 / 8C.2.5, a payment proven
# by the bank needs no human verification — which `cards.raise_card` already
# supports and which still needs an owner's signature before a coin exists.


async def partner_by_virtual_account(number: str) -> dict | None:
    """The partner a virtual account number belongs to, or None.

    Matched on the stored number and nothing else. No prefix arithmetic, no
    trimming to a suffix, no "close enough" — a VAN either is one we recorded
    the bank issuing or it is not ours.
    """
    van = str(number or "").strip()
    if not van:
        return None
    return await get_db()[C.PARTNERS].find_one({"virtual_account.number": van})


async def identify_payer(line: Mapping) -> dict:
    """Who paid, from one bank statement line. Spec 8C.1.5.

    `line` must carry the fields named in `VAN_STATEMENT_LINE_FIELDS`. The
    answer is always a dict with `matched` — never an exception for an
    unmatched line, because an unrecognised credit is an ordinary event in a
    real feed and it needs to be reported, not to abort the batch.

    Three things are refused rather than guessed:

      * a line for a different collection account. The VAN is an identifier on
        one real account (8C.1.3); a line from somebody else's feed carrying a
        number that happens to match ours must not credit our seller.
      * a blank or unknown virtual account. There is nobody to attribute it to,
        and attributing it to the nearest partner is how money lands in the
        wrong inventory.
      * a partner who is no longer approved. Their number stays theirs — it is
        permanent — but money arriving for a suspended seller is a thing a
        person should look at, not a thing to credit quietly.
    """
    van = str(line.get("credited_to") or "").strip()
    account = str(line.get("collection_account") or "").strip()
    reference = str(line.get("bank_reference") or "").strip()

    def unmatched(why: str) -> dict:
        return {
            "matched": False,
            "partner_id": None,
            "partner_name": "",
            "virtual_account": van,
            "bank_reference": reference,
            "amount_minor": line.get("amount_minor"),
            "credited_at": line.get("credited_at"),
            "reason": why,
            "required_fields": VAN_STATEMENT_LINE_FIELDS,
        }

    if not van:
        return unmatched(
            "The statement line names no virtual account number, so there is "
            "nobody it identifies. `credited_to` is the field that carries it."
        )
    if not reference:
        return unmatched(
            "The statement line carries no bank reference. Without one the same "
            "line cannot be told apart from a replay of it, so it is not "
            "attributed to anybody."
        )
    if not van_bank_configured():
        return unmatched(VAN_NO_BANK)
    if account and account != str(settings.van_collection_account).strip():
        return unmatched(
            f"This line credits collection account '{account}', which is not "
            "ours. A virtual account number is only an identifier on the "
            "account it was issued against (8C.1.3), so nothing was matched."
        )

    partner = await partner_by_virtual_account(van)
    if partner is None:
        return unmatched(
            f"No partner holds virtual account '{van}'. The credit is real and "
            "is in the bank; it is not attributed to anybody here, and nothing "
            "is guessed from the amount or the remitter name."
        )

    if partner.get("status") != str(PartnerStatus.APPROVED):
        return {
            **unmatched(
                f"{partner.get('name') or partner['_id']} holds this virtual "
                f"account but is {partner.get('status') or 'not approved'}. "
                "The number stays theirs — a VAN is permanent — but a credit "
                "arriving for an account we have stopped trading with is for a "
                "person to decide, not for a file to apply."
            ),
            "partner_id": str(partner["_id"]),
            "partner_name": partner.get("name", ""),
            "partner_status": partner.get("status"),
        }

    return {
        "matched": True,
        "partner_id": str(partner["_id"]),
        "partner_name": partner.get("name", ""),
        "partner_kind": partner.get("kind"),
        "partner_status": partner.get("status"),
        "virtual_account": van,
        "bank_reference": reference,
        "amount_minor": line.get("amount_minor"),
        "credited_at": line.get("credited_at"),
        "remitter_name": line.get("remitter_name") or "",
        # The idempotency key the follow-on card would carry, derived from the
        # bank's own reference rather than anything a person typed. Stated here
        # so the feed and the card agree on it before either exists.
        "idempotency_key": f"bank:{account or settings.van_collection_account}:{reference}",
        "next_step": (
            "Raise a seller_coin_purchase card for this partner with "
            "auto_verified=True (5.3.1 / 8C.2.5 — a payment proven by the bank "
            "needs no human verification). Nothing is credited until an owner "
            "signs it and it is executed."
        ),
    }


# ══════════════════════════════════════════════════════════════════════════════
# 1–4. Onboarding — a team decision, no owner signature. Spec 3.3.3 / 9.2
# ══════════════════════════════════════════════════════════════════════════════


async def approve_partner(
    partner_id: str,
    reason: str,
    actor: dict,
    kind: PartnerKind | None = None,
) -> dict:
    """Approve an application. The account becomes approved and active.

    No owner signature: nothing moves at approval, so this is skilled team work
    rather than a money decision (9.2).

    **Approval is also where the business record comes into existence.** A
    partner approved in the CRM but absent from Mongo is approved in name only —
    every money flow behind it refuses. So if there is no record yet, one is
    created here first, from the Firestore document, at zero. An id that names
    no Firestore agency or seller is still refused; approval creates a record
    for a real partner, never for an unknown one.

    Creating inside approval rides on approval's own authority rather than the
    team-admin guard on `POST /partner-ops/partners`, and that is the point: the
    reviewer has already decided this partner is real, and the `kind` is read
    from Firestore rather than supplied by anyone.

    **Approval is also where a coin seller is issued their permanent virtual
    account number** (4.3.4 / 8C.1.4) — the moment the spec names, so that is
    where the call sits. It is best effort and cannot fail an approval: with no
    HDFC eCMS collection account there is nothing to allocate from, so today it
    issues nothing and puts the reason on the response in `virtual_account`.
    Nothing is ever synthesised to fill the gap, and the seller's existing
    pay-and-send-a-reference path is untouched.
    """
    reason = _require_reason(reason)
    partner, record_created, warnings = await ensure_partner_record(
        partner_id, actor, reason, kind
    )

    if (
        partner.get("status") == str(PartnerStatus.APPROVED)
        and partner.get("is_active", True)
    ):
        raise PartnerOpsError("This partner is already approved and active.")

    # Approving states that the documents were checked, so `kycStatus` follows
    # the decision — but only when there were documents to check. With none,
    # `kycStatus` stays where it is and the partner keeps the upload form on
    # their own dashboard, which renders only while it is pending or rejected.
    has_documents = await asyncio.to_thread(_has_kyc_documents, partner)
    if not has_documents:
        warnings.append(
            "No identity documents are on file, so this partner is approved to "
            "trade but is NOT recorded as KYC-verified. They keep the upload "
            "form on their own dashboard — send them there to add documents and "
            "the bank account they are to be paid into."
        )

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id},
        {
            "$set": {
                "status": str(PartnerStatus.APPROVED),
                "is_active": True,
                "approved_at": now,
                "approved_by": _who(actor),
                "approval_reason": reason,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_APPROVED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.APPROVED), "is_active": True},
        meta={"kind": partner.get("kind")},
    )

    # ── A CAPABILITY CHANGED, SO THE SESSION CARRYING IT MUST BE REMINTED ────
    #
    # A partner session carries `partner_ids` as a CLAIM — a map of capability
    # to the one record it may read for that capability — and `own_partner_id_
    # or_403` compares a requested id against that claim rather than against
    # `partners`. The claim is written once, at sign-in.
    #
    # So an applicant who was signed in while under review holds a session with
    # NO ids on it: a session that can reach no partner record at all. Approving
    # them changed the record and left that session exactly as it was, and the
    # person stayed locked out of their own newly-approved portal until the
    # token expired — up to seven days — with nothing on screen explaining why.
    #
    # Revocation is the honest fix: the next request is refused, the CRM signs
    # them back in, and the new session carries the capability they now hold.
    # Rejection and deactivation have always done this; approval is the third
    # door onto the same field and was simply missed.
    out_sessions = await _revoke_partner_sessions(updated or partner)
    if out_sessions:
        log.info(
            "approve_partner: revoked %d session(s) so the new capability is picked up.",
            out_sessions,
        )

    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(
                partner.get("kind", ""),
                PartnerStatus.APPROVED,
                True,
                verified_documents=has_documents,
            ),
            "approvedAt": now,
            "approvedBy": actor.get("uid", ""),
            "rejectionReason": "",
        },
    )
    # The referral code — the only way a host can join this agency. Generated
    # here because the public signup form never made one, so a self-registered
    # agency reached its dashboard unable to recruit anybody.
    referral_code = await asyncio.to_thread(_ensure_referral_code, updated or partner)

    # The login itself. Without this the approval never reaches the person:
    # the CRM routes on `crmUsers.status`, not on Mongo and not on the partner
    # document, so an approved partner stayed locked in the waiting room.
    login_synced = await asyncio.to_thread(
        _mirror_login_status, updated or partner, str(PartnerStatus.APPROVED)
    )

    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    if referral_code:
        out["referral_code"] = referral_code
    elif str((updated or partner).get("kind", "")) != str(PartnerKind.SELLER):
        warnings.append(
            "No referral code could be issued for this agency, so hosts have no "
            "way to join it. Set one on the agency record before they recruit."
        )
    if not login_synced:
        warnings.append(
            "This partner has no CRM login attached, so the approval could not "
            "be written to one. They cannot sign in until a login is attached "
            "to the record."
        )
    # True when this approval is also what brought the business record into
    # existence. The CRM says so on the screen — an approval that quietly did
    # two things should not look like it did one.
    out["partner_record_created"] = record_created
    out["warnings"] = warnings

    # 4.3.4 / 8C.1.4 — the seller's permanent virtual account number. Never
    # fatal: an approval that is made is made, and a bank that is absent or
    # unreachable leaves the seller exactly where they already were, paying the
    # existing way. The response says which of the two happened.
    out["virtual_account"] = await _ensure_virtual_account(
        updated or partner, reason, actor
    )

    # A second capability for a login that already has one. `second_role_of` is
    # absent on every partner that is not one, so this is dead weight for an
    # ordinary approval and the path above is unchanged.
    #
    # It is read from the Firestore document as a fallback, and that fallback is
    # not defensive tidiness — it is the difference between the grant happening
    # and not.
    #
    # `second_role_of` is written by `request_second_role`, which runs only when
    # a staff member presses "Put in the queue" on /agencies or /sellers. That
    # button is easy to miss: the application also appears in the ordinary
    # partner list, where Approve is right there and works. Approving it from
    # the list left `second_role_of` unset, so this branch never ran, so the
    # capability was never granted — while the record itself went to `approved`
    # and looked completely finished. The partner kept being told their
    # application was under review by a system that believed it had approved it.
    #
    # The applicant's own document has said so all along: `requestSecondRole` in
    # `lib/partnerRoles.ts` writes `secondRoleOfPartnerId` at the moment they
    # apply. Reading it here means the bridge step is a convenience rather than
    # a load-bearing thing somebody has to remember.
    second_of = str((updated or partner).get("second_role_of") or "")
    if not second_of:
        second_of = await asyncio.to_thread(_declared_second_role_of, updated or partner)
        if second_of:
            await get_db()[C.PARTNERS].update_one(
                {"_id": partner["_id"]},
                {"$set": {"second_role_of": second_of, "updated_at": _now()}},
            )
            (updated or partner)["second_role_of"] = second_of
            log.info(
                "Partner %s is a second capability of %s, declared on its own "
                "document — linking it during approval.",
                partner["_id"],
                second_of,
            )

    if second_of:
        out["second_role"] = await _grant_second_role(updated or partner, reason, actor)
    return out


async def reject_partner(partner_id: str, reason: str, actor: dict) -> dict:
    """Reject an application — **the reason is stored on the record**.

    A rejected applicant today gets no explanation and simply reapplies, which
    puts the same file back in the same queue. The reason is written to Mongo
    and mirrored to the Firestore document the applicant's portal reads, so the
    next reviewer and the applicant both see why.
    """
    reason = _require_reason(reason)
    partner = await _partner(partner_id)

    if partner.get("status") == str(PartnerStatus.REJECTED):
        raise PartnerOpsError(
            "This application was already rejected: "
            f"{partner.get('rejection_reason') or 'no reason on record'}"
        )

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id},
        {
            "$set": {
                "status": str(PartnerStatus.REJECTED),
                "is_active": False,
                "rejection_reason": reason,   # mandatory, and kept
                "rejected_at": now,
                "rejected_by": _who(actor),
                "updated_at": now,
            },
            "$push": {
                "rejection_history": {
                    "at": now,
                    "reason": reason,
                    "by": _who(actor),
                }
            },
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_REJECTED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.REJECTED), "rejection_reason": reason},
        meta={"kind": partner.get("kind")},
    )

    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(partner.get("kind", ""), PartnerStatus.REJECTED, False),
            "rejectionReason": reason,
            "rejectedAt": now,
            "rejectedBy": actor.get("uid", ""),
        },
    )
    # The login too, or a rejected applicant keeps whatever access their last
    # decision gave them. Status has to move in lockstep with the record.
    login_synced = await asyncio.to_thread(
        _mirror_login_status, updated or partner, str(PartnerStatus.REJECTED)
    )
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    # The live token too. Everything above is a flag something re-reads at the
    # NEXT sign-in; this is what stops the current one.
    out["sessions_revoked"] = await _revoke_partner_sessions(updated or partner)

    # Refusing a second capability releases the link and takes the capability
    # off the login. The reason is already on the record above, and travels
    # into the second-role audit entry as well so the refusal is legible from
    # either side.
    if partner.get("second_role_of"):
        out["second_role"] = await _reject_second_role(updated or partner, reason, actor)
    return out


async def deactivate_partner(partner_id: str, reason: str, actor: dict) -> dict:
    """Suspend an active partner. The record is kept — history stays attributable."""
    reason = _require_reason(reason)
    partner = await _partner(partner_id)

    if not partner.get("is_active", False) and partner.get("status") == str(
        PartnerStatus.SUSPENDED
    ):
        raise PartnerOpsError("This partner is already deactivated.")

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id},
        {
            "$set": {
                "status": str(PartnerStatus.SUSPENDED),
                "is_active": False,
                "deactivated_at": now,
                "deactivated_by": _who(actor),
                "deactivation_reason": reason,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_DEACTIVATED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.SUSPENDED), "is_active": False},
        meta={"kind": partner.get("kind")},
    )

    synced = _sync_partner_doc(
        updated,
        _fs_status_fields(partner.get("kind", ""), PartnerStatus.SUSPENDED, False),
    )
    login_synced = await asyncio.to_thread(
        _mirror_login_status, updated or partner, str(PartnerStatus.SUSPENDED)
    )
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    # A suspension that leaves the current token working is a suspension that
    # starts in up to seven days. See `_revoke_partner_sessions`.
    out["sessions_revoked"] = await _revoke_partner_sessions(updated or partner)
    return out


async def reactivate_partner(partner_id: str, reason: str, actor: dict) -> dict:
    """Lift a suspension. Only a partner that was approved once can come back."""
    reason = _require_reason(reason)
    partner = await _partner(partner_id)

    if partner.get("is_active", False) and partner.get("status") == str(
        PartnerStatus.APPROVED
    ):
        raise PartnerOpsError("This partner is already active.")
    if partner.get("status") == str(PartnerStatus.REJECTED):
        raise PartnerOpsError(
            "This application was rejected, not suspended. Approve it instead."
        )

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id},
        {
            "$set": {
                "status": str(PartnerStatus.APPROVED),
                "is_active": True,
                "reactivated_at": now,
                "reactivated_by": _who(actor),
                "reactivation_reason": reason,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=Act.PARTNER_REACTIVATED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.APPROVED), "is_active": True},
        meta={"kind": partner.get("kind")},
    )

    synced = _sync_partner_doc(
        updated,
        _fs_status_fields(partner.get("kind", ""), PartnerStatus.APPROVED, True),
    )
    login_synced = await asyncio.to_thread(
        _mirror_login_status, updated or partner, str(PartnerStatus.APPROVED)
    )
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 4b. Re-approval — a change a partner PROPOSED to their payout or identity
# ══════════════════════════════════════════════════════════════════════════════
#
# An approved partner used to be able to replace their own bank account from
# their dashboard. The write set `kycStatus: 'submitted'` and put the new
# account number straight onto the live record, leaving `status: 'approved'`
# and `isActive: true` where they were — and every review queue keys off
# `status`, so the row went on reading approved and nobody looked again. A
# payout is a human reading that number off the record and paying it: approve
# once with clean documents, then swap the destination.
#
# So `firestore.rules` stopped letting a partner write any of those fields.
# What they may write instead is a `pendingChanges` block, and the live field
# does not move — money keeps going to the account somebody already verified
# while the new one waits here. Nobody is blocked from trading or earning
# meanwhile, which matters because replacing an expired document is the common,
# honest reason to be on that form.
#
# **Applying one is a reviewer's act and it runs here, not in a browser.** No
# clause in the rules lets any client write these fields, deliberately: the
# whole control would be worth nothing if the proposal and the application
# could be made by the same party with the same credential.
#
# Two things in this section are load-bearing and easy to lose in a refactor:
#
#   1. **The allow-list.** `proposesChangeOnly()` constrains which top-level
#      keys a partner may write, and says NOTHING about what may be inside
#      `pendingChanges`. A partner can park `{"coinBalance": 999999}` or
#      `{"status": "approved"}` in there. Without `_applicable_fields` below, a
#      reviewer clicking Apply on what looks like a bank change would mint coin
#      inventory or approve the applicant. The list is the same set the rules
#      protect, and nothing outside it is ever written.
#   2. **Proposer is not approver.** The person who proposed a change cannot be
#      the person who applies it. On `hostApplications` the rules already make
#      this explicit — an admin may propose, only a superadmin may write a
#      sensitive field directly — and the same check belongs on agencies and
#      sellers, where it also catches a staff account that happens to hold the
#      partner's own login.
#
# Unlike `_sync_partner_doc`, the Firestore write here is NOT a replica of a
# Mongo fact and a failure is not survivable. Mongo holds no bank account: the
# Firestore document IS the record for these fields, so a failed write means
# nothing happened and the caller has to be told so rather than shown a
# success with a warning attached.

#: Exactly `payoutFields()` in firestore.rules.
REAPPROVAL_PAYOUT_FIELDS = (
    "accountHolderName",
    "accountNumber",
    "bankAccount",
    "ifscCode",
    "bankName",
    "branch",
    "upiId",
    "binanceUid",
    "paymentType",
    "currency",
)

#: Exactly `identityFields()` in firestore.rules — the documents, the facts they
#: corroborate, and the contact pair `activateHost` matches a referral code
#: against.
REAPPROVAL_IDENTITY_FIELDS = (
    "kycDocUrls",
    "idDocUrls",
    "dob",
    "country",
    "agencyName",
    "displayName",
    "hostName",
    "ownerName",
    "phone",
    "applicantPhone",
    "email",
    "applicantEmail",
    "ownerEmail",
    # An agency spells its contact number `ownerPhone` and keeps an `address`
    # beside it. Both were in `identityFields()` in firestore.rules and in
    # neither of the two code lists, which failed in two places at once: the CRM
    # wrote them directly and was refused, and had a proposal carrying them
    # somehow arrived, this set would have dropped them on approval — a reviewer
    # pressing "apply" on a change that then did not happen.
    #
    # THREE COPIES OF ONE SET. This tuple, `REAPPROVAL_FIELDS` in
    # `zipper-crm/lib/pendingChanges.ts`, and `reapprovalFields()` in
    # `firestore.rules`. They cannot be shared across a Python service, a
    # browser bundle and a rules file, so they have to be changed together;
    # anything added to one belongs in the other two in the same commit.
    "ownerPhone",
    "address",
)

APPLICABLE_FIELDS: frozenset[str] = frozenset(
    REAPPROVAL_PAYOUT_FIELDS + REAPPROVAL_IDENTITY_FIELDS
)


def _pending_changes_of(doc: Mapping) -> dict:
    """The proposal on a partner document, or `{}` when there is none.

    A block whose `fields` map is empty counts as none. A reviewer cannot tell
    an empty proposal from a document that failed to read, and a queue row
    offering to apply nothing is worse than no row.
    """
    block = doc.get("pendingChanges")
    if not isinstance(block, Mapping):
        return {}
    fields = block.get("fields")
    if not isinstance(fields, Mapping) or not fields:
        return {}
    return dict(block)


def _applicable_fields(fields: Mapping) -> tuple[dict, list[str]]:
    """Split a proposal into what may be written and what must never be.

    See the note above: Firestore places no constraint at all on the contents
    of `pendingChanges`, so this is the only thing standing between a crafted
    proposal and a reviewer's Apply button.
    """
    allowed: dict = {}
    refused: list[str] = []
    for key, value in fields.items():
        name = str(key)
        if name in APPLICABLE_FIELDS:
            allowed[name] = value
        else:
            refused.append(name)
    return allowed, sorted(refused)


def _documents_on(doc: Mapping) -> bool:
    """Whether this document carries any identity document.

    The pure twin of `_has_kyc_documents`, which re-reads Firestore and answers
    True on a read failure because it only ever raises a warning. Here the
    answer decides what `kycStatus` is set to, so it is computed from the
    document already in hand and nothing is guessed.
    """
    for field in ("kycDocUrls", "idDocUrls"):
        value = doc.get(field)
        if isinstance(value, (list, tuple)) and any(
            (v.get("url") if isinstance(v, Mapping) else v) for v in value
        ):
            return True
    return bool(str(doc.get("registrationProofUrl") or "").strip())


def _proposer_of(block: Mapping) -> dict:
    by = block.get("submittedBy")
    by = by if isinstance(by, Mapping) else {}
    return {
        "uid": str(by.get("uid") or ""),
        "name": str(by.get("name") or ""),
        "role": str(by.get("role") or ""),
    }


async def _proposal(partner_id: str, actor: dict) -> tuple[str, dict, dict]:
    """The document, its proposal, and the checks both decisions share.

    Returns `(collection, document, pending_block)`.

    **No Mongo partner record is required.** A record can be proposed against
    before `registerAgencyPartner` ever ran — /kyc shows exactly those as
    "no business record" rows — and refusing to protect a bank account because
    a registration trigger did not fire would be the wrong way round. Nothing
    in either decision reads Mongo.
    """
    found = await asyncio.to_thread(_read_firestore_partner, partner_id)
    if found is None:
        raise PartnerOpsError(
            "No agency or seller with that id. A proposed change is applied to "
            "the document it was proposed on, and there is no such document."
        )
    collection, doc = found

    block = _pending_changes_of(doc)
    if not block:
        raise PartnerOpsError(
            "There is no proposed change waiting on this partner. It may have "
            "been decided by somebody else already — reload the queue."
        )

    proposer = _proposer_of(block)
    if proposer["uid"] and proposer["uid"] == str(actor.get("uid") or ""):
        raise PartnerOpsError(
            "You proposed this change, so you cannot be the one who decides it. "
            "A change to where money is sent needs a second pair of eyes; ask a "
            "colleague to review it."
        )
    return collection, doc, block


def _write_partner_document(collection: str, doc_id: str, fields: dict) -> None:
    """Blocking — write the partner document. Raises, and is meant to.

    Deliberately not `_sync_partner_doc`. That function swallows a failure
    because Mongo is already committed and Firestore is a replica of a status.
    Here Firestore IS the record — Mongo holds no bank account — so a failed
    write means the change did not happen, and saying otherwise would tell a
    reviewer a payout destination had moved when it had not.
    """
    firebase.firestore_client().collection(collection).document(doc_id).update(fields)


async def apply_pending_changes(partner_id: str, reason: str, actor: dict) -> dict:
    """Write a proposed change onto the live record and clear the proposal.

    This is the moment the payout destination actually moves, so it carries the
    same mandatory reason as an approval and leaves an audit entry naming who
    applied it, who proposed it, and every field with both of its values.

    `kycStatus` follows the same rule `_fs_status_fields` uses for an approval:
    applying states that the documents were checked, so it becomes 'approved' —
    but only where there are documents to have checked. With none it goes back
    to whatever it was before the proposal moved it to 'submitted', because
    writing 'approved' over an empty record is a claim nobody made and it also
    hides the upload form on the partner's own dashboard, which renders only
    while `kycStatus` is pending or rejected.
    """
    reason = _require_reason(reason)
    collection, doc, block = await _proposal(partner_id, actor)

    fields = block.get("fields")
    allowed, refused = _applicable_fields(fields if isinstance(fields, Mapping) else {})
    if not allowed:
        raise PartnerOpsError(
            "This proposal contains nothing that may be applied to a partner "
            f"record: {', '.join(refused) or 'it is empty'}. Reject it — a "
            "proposal naming fields nobody is allowed to change this way is "
            "worth looking into rather than quietly discarding."
        )

    now = _now()
    before = {key: doc.get(key) for key in allowed}
    merged = {**doc, **allowed}
    previous = str(block.get("previousKycStatus") or "") or "pending"

    patch: dict = {
        **allowed,
        "pendingChanges": fb_firestore.DELETE_FIELD,
        "kycStatus": "approved" if _documents_on(merged) else previous,
        "reapprovedAt": now,
        "reapprovedBy": actor.get("uid", ""),
        "reapprovedByName": actor.get("name", ""),
        "reapprovalReason": reason,
        # A refusal recorded against an earlier proposal is history the moment
        # a later one is applied. Left behind, the partner's dashboard would go
        # on telling them their change was turned down.
        "pendingChangesRejectedAt": fb_firestore.DELETE_FIELD,
        "pendingChangesRejectedBy": fb_firestore.DELETE_FIELD,
        "pendingChangesRejectionReason": fb_firestore.DELETE_FIELD,
    }

    try:
        await asyncio.to_thread(
            _write_partner_document, collection, partner_id, patch
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not apply pending changes for %s/%s", collection, partner_id)
        raise PartnerOpsError(
            "The record could not be written, so nothing has changed and the "
            "proposal is still waiting. Try again."
        ) from exc

    # Audited after the write, like every other decision that owns a Firestore
    # document rather than replicating one: an entry for a change that did not
    # land is a false record of a payout destination moving.
    audit_id = await audit.record(
        actor=actor,
        action=Act.PENDING_CHANGES_APPLIED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after=allowed,
        meta={
            "collection": collection,
            "fields": sorted(allowed),
            # Who asked for it. The whole point of the control is that this is
            # a different person from the actor above, and the log has to be
            # able to show that it was.
            "proposed_by": _proposer_of(block),
            "proposed_at": str(block.get("submittedAt") or ""),
            "proposal_note": str(block.get("note") or ""),
            # Anything the proposal named that is not applicable here. Normally
            # empty; a non-empty list is somebody writing keys into
            # `pendingChanges` that no form puts there.
            "refused_fields": refused,
        },
    )

    return {
        "partner_id": partner_id,
        "collection": collection,
        "applied": sorted(allowed),
        "refused": refused,
        "before": before,
        "after": allowed,
        "audit_id": audit_id,
        "note": (
            ""
            if not refused
            else "Applied the payout and identity fields. These were in the "
            f"proposal and were NOT written, because nothing may change them "
            f"this way: {', '.join(refused)}."
        ),
    }


async def reject_pending_changes(partner_id: str, reason: str, actor: dict) -> dict:
    """Refuse a proposed change. The live fields are not touched.

    Nothing about the partner's record moves — which is the point, and is also
    why the reason matters more here than almost anywhere else. The proposal
    disappears when it is refused, so without a reason on the document the
    partner sees their change silently revert to the old value and submits it
    again. That is exactly how this project ended up with four copies of one
    host application.

    `kycStatus` is restored to what the proposal recorded it as before it moved
    it to 'submitted'. Not 'rejected': an approved partner whose replacement
    document was refused still has the verified documents they were approved
    on, and marking their KYC rejected would say the opposite of what happened.
    """
    reason = _require_reason(reason)
    collection, doc, block = await _proposal(partner_id, actor)

    fields = block.get("fields")
    proposed = sorted(str(k) for k in (fields if isinstance(fields, Mapping) else {}))
    now = _now()
    previous = str(block.get("previousKycStatus") or "") or "pending"

    patch = {
        "pendingChanges": fb_firestore.DELETE_FIELD,
        "kycStatus": previous,
        "pendingChangesRejectedAt": now,
        "pendingChangesRejectedBy": actor.get("name", "") or actor.get("uid", ""),
        "pendingChangesRejectionReason": reason,
    }

    try:
        await asyncio.to_thread(
            _write_partner_document, collection, partner_id, patch
        )
    except Exception as exc:  # noqa: BLE001
        log.exception(
            "Could not reject pending changes for %s/%s", collection, partner_id
        )
        raise PartnerOpsError(
            "The record could not be written, so the proposal is still waiting. "
            "Try again."
        ) from exc

    audit_id = await audit.record(
        actor=actor,
        action=Act.PENDING_CHANGES_REJECTED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before={"pendingChanges": proposed},
        after={"pendingChanges": None, "kycStatus": previous},
        meta={
            "collection": collection,
            "fields": proposed,
            "proposed_by": _proposer_of(block),
            "proposed_at": str(block.get("submittedAt") or ""),
            "proposal_note": str(block.get("note") or ""),
        },
    )

    return {
        "partner_id": partner_id,
        "collection": collection,
        "refused": proposed,
        "kyc_status": previous,
        "audit_id": audit_id,
        "note": (
            "Nothing on the record changed. The reason is stored on it and "
            "shown on the partner's own dashboard, so they are told why rather "
            "than resubmitting the same change."
        ),
    }


async def list_partners(
    kind: PartnerKind | None = None,
    status: PartnerStatus | None = None,
    limit: int = 100,
) -> list[dict]:
    """The onboarding queue and the partner directory, in one query."""
    q: dict = {}
    if kind is not None:
        q["kind"] = str(kind)
    if status is not None:
        q["status"] = str(status)

    cursor = (
        get_db()[C.PARTNERS]
        .find(q)
        .sort("created_at", -1)
        .limit(max(1, min(limit, 500)))
    )
    # `virtual_account` is narrowed to the same view `get_partner` returns, so a
    # list row and a record page say the same thing about a VAN — and neither
    # carries the staff member who issued it.
    return [
        {**_public(doc), "virtual_account": virtual_account_view(doc)}
        async for doc in cursor
    ]


async def get_partner(partner_id: str) -> dict:
    """One partner record, with live standing attached.

    `virtual_account` is **replaced** by `virtual_account_view`, not passed
    through. This route is partner-reachable, so the raw sub-document — which
    names the staff member who issued the number — is not what goes back; the
    view carries what a payer needs and nothing about who pressed the button.
    It is always present and always answers: a number, or `issued: false` with
    the reason.
    """
    partner = await _partner(partner_id)
    out = _public(partner)
    out["virtual_account"] = virtual_account_view(partner)

    credit = partner.get("credit", {}) or {}
    out["credit_standing"] = str(
        partner_svc.credit_standing(
            int(credit.get("outstanding", 0)), credit.get("due_at")
        )
    )
    if partner.get("kind") == str(PartnerKind.SELLER):
        allowed, why = await partner_svc.can_take_inventory(partner_id)
        out["can_take_inventory"] = {"allowed": allowed, "reason": why}
        out["coins_on_hand"] = await get_balance(
            HolderType.SELLER, partner_id, Currency.COINS
        )
    else:
        out["commission_outstanding"] = await get_balance(
            HolderType.AGENCY, partner_id, Currency.COMMISSION
        )
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 5–7. Seller inventory — money, so cards. Spec 4.3.5 / 4.3.6
# ══════════════════════════════════════════════════════════════════════════════


async def find_duplicate_payment_refs(payment_ref: str, limit: int = 5) -> list[dict]:
    """Cards that already carry this payment reference.

    The same UTR can currently be submitted over and over. This does not block
    anything — a genuine re-submission exists — but it puts the earlier cards in
    front of the owner before they sign.
    """
    ref = (payment_ref or "").strip()
    if not ref:
        return []

    cursor = (
        get_db()[C.CARDS]
        .find({"payload.payment_ref": ref})
        .sort("created_at", -1)
        .limit(max(1, min(limit, 20)))
    )
    return [
        {
            "card_id": str(doc["_id"]),
            "type": doc.get("type"),
            "stage": doc.get("stage"),
            "amount": doc.get("amount"),
            "subject_id": (doc.get("subject") or {}).get("id"),
            "created_at": doc.get("created_at"),
        }
        async for doc in cursor
    ]


#: A rupee either side of the computed price. Rounding on a pack boundary, or a
#: bank truncating paise — not something to make anybody write a sentence about.
_PURCHASE_TOLERANCE_MINOR = 100

#: Words that mark a reason as actually addressing the amount. A seller pasting
#: "Paid for 100000 coins of inventory." — which is what the dialog prefills —
#: has explained nothing, and must not be able to wave a mismatch through.
_AMOUNT_WORDS = (
    "amount", "price", "rate", "differ", "less", "more", "short", "extra",
    "fee", "charge", "discount", "agreed", "part", "partial", "balance",
    "overpaid", "underpaid", "refund", "adjust", "₹", "rs",
)


def _explains_amount(reason: str) -> bool:
    """Does this reason actually say something about the money?"""
    text = (reason or "").strip().lower()
    return len(text) >= 12 and any(word in text for word in _AMOUNT_WORDS)


async def _expected_purchase_minor(coins: int) -> int | None:
    """What `coins` cost in paise at the published wholesale rate, or None.

    None means the rate could not be read — and in that case nothing is
    enforced. A price check that fires because Firestore was briefly unreachable
    would block honest purchases and teach everybody to write "rate outage" into
    the reason box, which is worse than not checking at all.
    """
    from app.services import reports

    try:
        rates = await reports.load_rates()
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read the diamond rate for a purchase check: %s", exc)
        return None

    # The WHOLESALE figure, not the retail one.
    #
    # This checked against `diamond_pack_price_inr_per_lakh` — what a *user*
    # pays. A coin seller buys at an agreed discount and resells at retail;
    # that spread is their entire reason for existing. Checking their payment
    # against retail therefore refused every correctly-priced purchase for a
    # mismatch that was the arrangement working exactly as intended.
    #
    # `seller_wholesale_price_inr_per_lakh` falls back to retail when no
    # discount is configured, so an unconfigured business behaves as before.
    per_lakh = float(getattr(rates, "seller_wholesale_price_inr_per_lakh", 0) or 0)
    if per_lakh <= 0:
        return None
    if getattr(rates, "provisional", False):
        # A fallback rate is a documented guess, not the business's price list.
        # Refusing a real payment against a guess is not a decision this should
        # be making on its own.
        return None
    return int(round(coins * per_lakh * 100 / reports.DIAMONDS_PER_LAKH))


async def request_coin_purchase(
    seller_id: str,
    coins: int,
    amount_paid_minor: int,
    payment_ref: str,
    evidence_url: str,
    actor: dict,
    reason: str = "",
) -> dict:
    """Seller pays for inventory — raise the card. Spec 4.3.5 / 4.3.6.

    Refuses outright if the seller is blocked (unapproved, or overdue credit),
    with the reason `can_take_inventory` gives so the UI can show it verbatim.
    """
    coins = _positive(coins, "Coins")
    amount_paid_minor = _non_negative(amount_paid_minor, "Amount paid")
    ref = (payment_ref or "").strip()
    if not ref:
        raise PartnerOpsError(
            "A payment reference (UTR, transaction id) is required to match the money."
        )

    # What these coins cost at the published wholesale rate.
    #
    # The amount used to be whatever the seller typed, and the API accepted it —
    # `ge=0`, so a seller could file a hundred thousand coins against ₹0 and the
    # card would look exactly like an honest one. The only arithmetic anywhere
    # was a warning painted on the staff review screen, which an owner can sign
    # straight past.
    #
    # A price list nobody enforces is not a price list. So the expected figure
    # is computed here, and a claim that does not match it is refused unless the
    # person filing says in the reason why it differs. A genuine discrepancy —
    # a bank fee, a part payment, an agreed rate for one deal — is a sentence
    # somebody has to write down, and it lands in the audit log with their name.
    expected_minor = await _expected_purchase_minor(coins)
    if expected_minor is not None and amount_paid_minor != expected_minor:
        difference = amount_paid_minor - expected_minor
        # A rupee either way is rounding, not a discrepancy worth a sentence.
        if abs(difference) > _PURCHASE_TOLERANCE_MINOR and not _explains_amount(reason):
            raise PartnerOpsError(
                f"{coins:,} coins cost ₹{expected_minor / 100:,.2f} at the "
                f"current rate, but ₹{amount_paid_minor / 100:,.2f} was entered "
                f"— a difference of ₹{abs(difference) / 100:,.2f}. Either correct "
                "the amount, or say in the reason why it differs. An amount that "
                "does not match the price list has to be explained before it is "
                "recorded, because after it is signed it becomes what the seller "
                "paid us."
            )

    await _partner(seller_id, PartnerKind.SELLER)
    allowed, why = await partner_svc.can_take_inventory(seller_id)
    if not allowed:
        raise PartnerOpsError(why)

    duplicates = await find_duplicate_payment_refs(ref)

    card = await _raise(
        NewCard(
            type=CardType.SELLER_COIN_PURCHASE,
            team=Team.FINANCE,
            title=f"Coin purchase — {coins:,} coins",
            amount=coins,
            currency=str(Currency.COINS),
            reason=_reason(
                reason,
                f"Seller {seller_id} purchased {coins} coins against payment {ref}",
            ),
            subject_type=str(HolderType.SELLER),
            subject_id=seller_id,
            payload={
                "coins": coins,
                "amount_paid_minor": amount_paid_minor,
                "payment_ref": ref,
                "evidence_url": (evidence_url or "").strip(),
                # Shown on the card so the owner sees it before signing.
                "duplicate_reference": bool(duplicates),
                "duplicate_of": duplicates,
            },
            evidence=(
                [{"kind": "payment_proof", "url": evidence_url.strip()}]
                if (evidence_url or "").strip()
                else []
            ),
        ),
        actor,
    )
    if duplicates:
        card["warning"] = (
            f"Payment reference {ref} has been used on "
            f"{len(duplicates)} earlier card(s). Confirm this is a separate payment."
        )
    return card


async def execute_coin_purchase(card_id: str, actor: dict) -> dict:
    """After the owner signs — credit the inventory. Spec 4.3.6.

    The idempotency key is the card, so executing twice credits once.
    """
    card = await _card_ready(card_id, CardType.SELLER_COIN_PURCHASE)
    seller_id = (card.get("subject") or {}).get("id", "")
    payload = card.get("payload") or {}
    coins = int(card.get("amount", 0))
    paid = int(payload.get("amount_paid_minor", 0))

    try:
        movement = await _move(
            Movement(
                holder_type=HolderType.SELLER,
                holder_id=seller_id,
                currency=Currency.COINS,
                amount=coins,
                action=audit.Action.INVENTORY_CREDIT,
                reason=card.get("reason", "Coin purchase"),
                actor=actor,
                card_id=card_id,
                idempotency_key=f"card:{card_id}:coins",
                meta={
                    "payment_ref": payload.get("payment_ref"),
                    "amount_paid_minor": paid,
                    "duplicate_reference": bool(payload.get("duplicate_reference")),
                },
            )
        )
    except PartnerOpsError as exc:
        await _finish(card_id, actor, {"error": str(exc)}, False)
        raise

    if paid:
        await get_db()[C.PARTNERS].update_one(
            {"_id": seller_id},
            {
                "$inc": {"cash_paid_minor": paid},
                "$set": {"updated_at": _now()},
            },
        )

    return await _finish(
        card_id,
        actor,
        {"coins_credited": coins, "amount_paid_minor": paid, **movement},
        True,
    )


# ══════════════════════════════════════════════════════════════════════════════
# 8–12. Seller credit. Spec 4.3.7 / 4.3.10 / 4.3.11–4.3.17
# ══════════════════════════════════════════════════════════════════════════════


async def request_lending(
    seller_id: str,
    coins: int,
    due_at: datetime,
    terms: str,
    reason: str,
    actor: dict,
) -> dict:
    """Lend inventory on credit. Owner signature required. Spec 4.3.7."""
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")
    if due_at is None:
        raise PartnerOpsError("A due date is required — credit without one is a gift.")

    await _partner(seller_id, PartnerKind.SELLER)
    allowed, why = await partner_svc.can_take_inventory(seller_id)
    if not allowed:
        raise PartnerOpsError(why)

    return await _raise(
        NewCard(
            type=CardType.LENDING_ISSUE,
            team=Team.FINANCE,
            title=f"Lend {coins:,} coins — due {due_at:%d %b %Y}",
            amount=coins,
            currency=str(Currency.COINS),
            reason=reason,
            subject_type=str(HolderType.SELLER),
            subject_id=seller_id,
            payload={
                "coins": coins,
                "due_at": due_at,
                "terms": (terms or "").strip(),
            },
        ),
        actor,
    )


async def execute_lending(card_id: str, actor: dict) -> dict:
    """Credit the coins **and** record the debt with its amount and due date.

    Both halves matter: crediting without recording the debt is how credit
    becomes invisible.
    """
    card = await _card_ready(card_id, CardType.LENDING_ISSUE)
    seller_id = (card.get("subject") or {}).get("id", "")
    payload = card.get("payload") or {}
    coins = int(card.get("amount", 0))
    due_at = payload.get("due_at")

    try:
        movement = await _move(
            Movement(
                holder_type=HolderType.SELLER,
                holder_id=seller_id,
                currency=Currency.COINS,
                amount=coins,
                action=audit.Action.LENDING_ISSUE,
                reason=card.get("reason", "Credit issued"),
                actor=actor,
                card_id=card_id,
                idempotency_key=f"card:{card_id}:lend",
                meta={"due_at": due_at, "terms": payload.get("terms")},
            )
        )
    except PartnerOpsError as exc:
        await _finish(card_id, actor, {"error": str(exc)}, False)
        raise

    now = _now()
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": seller_id},
        {
            "$inc": {"credit.outstanding": coins, "credit.total_lent": coins},
            "$set": {
                "credit.due_at": due_at,
                "credit.terms": payload.get("terms", ""),
                "credit.last_issued_at": now,
                "updated_at": now,
            },
            "$push": {
                "credit.history": {
                    "at": now,
                    "event": "issued",
                    "coins": coins,
                    "due_at": due_at,
                    "card_id": card_id,
                    "by": _who(actor),
                }
            },
        },
        return_document=ReturnDocument.AFTER,
    )
    outstanding = int(((updated or {}).get("credit") or {}).get("outstanding", coins))

    return await _finish(
        card_id,
        actor,
        {
            "coins_lent": coins,
            "due_at": due_at,
            "outstanding_after": outstanding,
            **movement,
        },
        True,
    )


async def request_repayment(
    seller_id: str,
    coins: int,
    payment_ref: str,
    reason: str,
    actor: dict,
) -> dict:
    """Seller repays credit. Spec 4.3.10.

    The debt is denominated in coins; repayment arrives as cash. No coin
    movement happens — the coins were already issued and sold. What closes is
    the outstanding balance on the partner record.
    """
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")

    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    if outstanding <= 0:
        raise PartnerOpsError("This seller has no outstanding credit to repay.")
    if coins > outstanding:
        raise PartnerOpsError(
            f"Repayment of {coins:,} exceeds the outstanding {outstanding:,}. "
            "Record the correct amount, or raise a separate card for the excess."
        )

    ref = (payment_ref or "").strip()
    duplicates = await find_duplicate_payment_refs(ref) if ref else []

    card = await _raise(
        NewCard(
            type=CardType.LENDING_REPAY,
            team=Team.FINANCE,
            title=f"Credit repayment — {coins:,} coins",
            amount=coins,
            currency=str(Currency.COINS),
            reason=reason,
            subject_type=str(HolderType.SELLER),
            subject_id=seller_id,
            payload={
                "coins": coins,
                "payment_ref": ref,
                "outstanding_before": outstanding,
                "duplicate_reference": bool(duplicates),
                "duplicate_of": duplicates,
            },
        ),
        actor,
    )
    if duplicates:
        card["warning"] = (
            f"Payment reference {ref} has been used on "
            f"{len(duplicates)} earlier card(s). Confirm this is a separate payment."
        )
    return card


async def execute_repayment(card_id: str, actor: dict) -> dict:
    """Close the debt by the repaid amount. Spec 4.3.10."""
    card = await _card_ready(card_id, CardType.LENDING_REPAY)
    seller_id = (card.get("subject") or {}).get("id", "")
    coins = int(card.get("amount", 0))

    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    applied = min(coins, outstanding)
    remaining = outstanding - applied

    now = _now()
    update: dict = {
        "$set": {
            "credit.outstanding": remaining,
            "credit.last_repaid_at": now,
            "updated_at": now,
        },
        "$inc": {"credit.total_repaid": applied},
        "$push": {
            "credit.history": {
                "at": now,
                "event": "repaid",
                "coins": applied,
                "card_id": card_id,
                "by": _who(actor),
            }
        },
    }
    if remaining == 0:
        # Debt closed — the due date no longer applies, and the seller is
        # unblocked for new inventory.
        update["$set"]["credit.due_at"] = None
    await get_db()[C.PARTNERS].update_one({"_id": seller_id}, update)

    await audit.record(
        actor=actor,
        action=audit.Action.LENDING_REPAY,
        subject_type="partner",
        subject_id=seller_id,
        reason=card.get("reason", "Credit repaid"),
        before={"outstanding": outstanding},
        after={"outstanding": remaining},
        card_id=card_id,
        meta={
            "coins": applied,
            "payment_ref": (card.get("payload") or {}).get("payment_ref"),
        },
    )

    return await _finish(
        card_id,
        actor,
        {
            "coins_repaid": applied,
            "outstanding_before": outstanding,
            "outstanding_after": remaining,
            "cleared": remaining == 0,
        },
        True,
    )


async def request_recovery(
    seller_id: str,
    coins: int,
    penalty_coins: int,
    reason: str,
    actor: dict,
) -> dict:
    """Recover unpaid credit from the seller's own balance. Spec 4.3.13–4.3.15.

    `penalty_coins` is a legitimate addition — a late penalty or recovery cost —
    so the total recovered may exceed the original debt (4.3.14). Both numbers
    are on the card so the owner sees the split before signing.
    """
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")
    penalty_coins = _non_negative(penalty_coins, "Penalty coins")

    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    if outstanding <= 0:
        raise PartnerOpsError("This seller has no outstanding credit to recover.")

    balance = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    target = coins + penalty_coins

    return await _raise(
        NewCard(
            type=CardType.LENDING_RECOVER,
            team=Team.FINANCE,
            title=(
                f"Recover {coins:,} coins"
                + (f" + {penalty_coins:,} penalty" if penalty_coins else "")
            ),
            amount=target,
            currency=str(Currency.COINS),
            reason=reason,
            subject_type=str(HolderType.SELLER),
            subject_id=seller_id,
            payload={
                "coins": coins,
                "penalty_coins": penalty_coins,
                "target": target,
                "outstanding_before": outstanding,
                "balance_at_request": balance,
                # Stated up front: recovery takes what is there and the rest
                # stays a receivable (4.3.16).
                "expected_shortfall": max(0, target - balance),
            },
        ),
        actor,
    )


async def execute_recovery(card_id: str, actor: dict) -> dict:
    """Debit what the seller actually holds; leave the rest as a receivable.

    Spec 4.3.13 / 4.3.16 — recovery takes up to the full balance, and any
    shortfall stays outstanding against the seller. It is never silently
    written off; that is a separate, explicit owner decision.
    """
    card = await _card_ready(card_id, CardType.LENDING_RECOVER)
    seller_id = (card.get("subject") or {}).get("id", "")
    payload = card.get("payload") or {}
    penalty = int(payload.get("penalty_coins", 0))
    target = int(card.get("amount", 0))

    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    balance = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    recovered = max(0, min(balance, target))

    movement: dict = {"ledger_id": None, "balance_before": balance, "balance_after": balance}
    if recovered > 0:
        try:
            movement = await _move(
                Movement(
                    holder_type=HolderType.SELLER,
                    holder_id=seller_id,
                    currency=Currency.COINS,
                    amount=-recovered,
                    action=audit.Action.LENDING_RECOVER,
                    reason=card.get("reason", "Credit recovery"),
                    actor=actor,
                    card_id=card_id,
                    idempotency_key=f"card:{card_id}:recover",
                    meta={"target": target, "penalty_coins": penalty},
                )
            )
        except PartnerOpsError as exc:
            await _finish(card_id, actor, {"error": str(exc)}, False)
            raise

    # The penalty is added to the debt, then everything recovered comes off it.
    remaining = max(0, outstanding + penalty - recovered)
    shortfall = max(0, target - recovered)

    now = _now()
    await get_db()[C.PARTNERS].update_one(
        {"_id": seller_id},
        {
            "$set": {
                "credit.outstanding": remaining,
                "credit.last_recovered_at": now,
                "updated_at": now,
            },
            "$inc": {
                "credit.total_recovered": recovered,
                "credit.total_penalty": penalty,
            },
            "$push": {
                "credit.history": {
                    "at": now,
                    "event": "recovered",
                    "coins": recovered,
                    "penalty_coins": penalty,
                    "shortfall": shortfall,
                    "card_id": card_id,
                    "by": _who(actor),
                }
            },
        },
    )

    result = {
        "target": target,
        "recovered": recovered,
        "shortfall": shortfall,
        "penalty_coins": penalty,
        "outstanding_before": outstanding,
        "outstanding_after": remaining,
        "note": (
            f"Balance covered {recovered:,} of {target:,}. "
            f"{shortfall:,} remains an open receivable against this seller."
            if shortfall
            else "Recovered in full."
        ),
        **movement,
    }
    return await _finish(card_id, actor, result, True)


async def write_off_debt(
    partner_id: str, coins: int, reason: str, actor: dict
) -> dict:
    """Raise a bad-debt write-off. Owner signature required. Spec 4.3.17.

    Writing off is a loss, not an adjustment, so it goes on the board like any
    other money decision and lands in the audit log as one.
    """
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")

    partner = await _partner(partner_id)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    if outstanding <= 0:
        raise PartnerOpsError("There is no outstanding debt to write off.")
    if coins > outstanding:
        raise PartnerOpsError(
            f"Write-off of {coins:,} exceeds the outstanding {outstanding:,}."
        )

    return await _raise(
        NewCard(
            type=CardType.BAD_DEBT_WRITE_OFF,
            team=Team.FINANCE,
            title=f"Write off bad debt — {coins:,} coins",
            amount=coins,
            currency=str(Currency.COINS),
            reason=reason,
            subject_type=str(HolderType.SELLER),
            subject_id=partner_id,
            payload={
                "coins": coins,
                "outstanding_before": outstanding,
                "is_loss": True,
            },
        ),
        actor,
    )


async def execute_write_off(card_id: str, actor: dict) -> dict:
    """Book the loss once an owner has signed. Spec 4.3.17."""
    card = await _card_ready(card_id, CardType.BAD_DEBT_WRITE_OFF)
    partner_id = (card.get("subject") or {}).get("id", "")
    coins = int(card.get("amount", 0))

    partner = await _partner(partner_id)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    written = min(coins, outstanding)
    remaining = outstanding - written

    now = _now()
    await get_db()[C.PARTNERS].update_one(
        {"_id": partner_id},
        {
            "$set": {
                "credit.outstanding": remaining,
                "credit.written_off_at": now,
                "updated_at": now,
            },
            "$inc": {"credit.total_written_off": written},
            "$push": {
                "credit.history": {
                    "at": now,
                    "event": "written_off",
                    "coins": written,
                    "card_id": card_id,
                    "by": _who(actor),
                }
            },
        },
    )

    await audit.record(
        actor=actor,
        action=audit.Action.LENDING_WRITE_OFF,
        subject_type="partner",
        subject_id=partner_id,
        reason=card.get("reason", "Bad debt written off"),
        before={"outstanding": outstanding},
        after={"outstanding": remaining},
        card_id=card_id,
        meta={"coins": written, "is_loss": True, "loss_coins": written},
    )

    return await _finish(
        card_id,
        actor,
        {
            "written_off": written,
            "outstanding_before": outstanding,
            "outstanding_after": remaining,
            "is_loss": True,
        },
        True,
    )


# ══════════════════════════════════════════════════════════════════════════════
# 13–14. Sales — the inventory decrement. Spec 4.3.8 / 4.3.9
# ══════════════════════════════════════════════════════════════════════════════


async def record_sale(
    seller_id: str,
    buyer_uid: str,
    diamonds: int,
    amount_paid_minor: int,
    actor: dict,
    reason: str = "",
) -> dict:
    """File a sale. Nothing moves until it is approved. Spec 4.3.8."""
    diamonds = _positive(diamonds, "Diamonds")
    amount_paid_minor = _non_negative(amount_paid_minor, "Amount paid")
    buyer = (buyer_uid or "").strip()
    if not buyer:
        raise PartnerOpsError("A buyer is required on a sale record.")
    if buyer == seller_id:
        raise PartnerOpsError(
            "Buyer and seller are the same account. A genuine sale has a distinct buyer."
        )

    seller = await _approved_partner(seller_id, PartnerKind.SELLER)

    now = _now()
    text = _reason(
        reason, f"Sale of {diamonds} diamonds by {seller.get('name') or seller_id}"
    )
    doc = {
        "seller_id": seller_id,
        "buyer_uid": buyer,
        "diamonds": diamonds,
        "amount_paid_minor": amount_paid_minor,
        "status": SaleStatus.PENDING,
        "reason": text,
        "recorded_by": _who(actor),
        "created_at": now,
        "updated_at": now,
        "approved_by": None,
        "approved_at": None,
    }
    result = await get_db()[SALES].insert_one(doc)
    sale_id = str(result.inserted_id)

    await audit.record(
        actor=actor,
        action=Act.SALE_RECORDED,
        subject_type="sale",
        subject_id=sale_id,
        reason=text,
        after={
            "seller_id": seller_id,
            "buyer_uid": buyer,
            "diamonds": diamonds,
            "status": SaleStatus.PENDING,
        },
        meta={"amount_paid_minor": amount_paid_minor},
    )

    doc["id"] = sale_id
    doc.pop("_id", None)
    return doc


async def approve_sale(sale_id: str, reason: str, actor: dict) -> dict:
    """Approve a sale — **debit the seller, then credit the buyer**. Spec 4.3.9.

    Approving a sale today changes neither balance, which is why a seller's
    inventory is really a purchase total rather than live stock. The debit runs
    first on purpose: if the seller does not hold the coins, the sale stops
    before any diamonds are minted.
    """
    reason = _require_reason(reason)

    try:
        oid = ObjectId(sale_id)
    except Exception as exc:  # noqa: BLE001
        raise PartnerOpsError("Sale not found.") from exc

    db = get_db()
    sale = await db[SALES].find_one({"_id": oid})
    if sale is None:
        raise PartnerOpsError("Sale not found.")
    if sale["status"] == SaleStatus.APPROVED:
        raise PartnerOpsError("This sale has already been approved.")

    seller_id = sale["seller_id"]
    buyer_uid = sale["buyer_uid"]
    diamonds = int(sale["diamonds"])

    # 1. Seller's inventory comes down first. If it is short, this raises and
    #    the sale stays pending — nothing was credited, so nothing to unwind.
    debit = await _move(
        Movement(
            holder_type=HolderType.SELLER,
            holder_id=seller_id,
            currency=Currency.COINS,
            amount=-diamonds,
            action=audit.Action.INVENTORY_DEBIT,
            reason=reason,
            actor=actor,
            idempotency_key=f"sale:{sale_id}:coins",
            meta={"sale_id": sale_id, "buyer_uid": buyer_uid},
        )
    )

    # 2. Only now does the buyer receive anything.
    try:
        credit = await _move(
            Movement(
                holder_type=HolderType.USER,
                holder_id=buyer_uid,
                currency=Currency.DIAMONDS,
                amount=diamonds,
                action=audit.Action.BALANCE_CREDIT,
                reason=reason,
                actor=actor,
                idempotency_key=f"sale:{sale_id}:diamonds",
                meta={"sale_id": sale_id, "seller_id": seller_id},
            )
        )
    except PartnerOpsError as exc:
        # The seller has been debited and the buyer has not been credited. Mark
        # the sale failed and shout — this needs a human, not a silent retry.
        await db[SALES].update_one(
            {"_id": oid},
            {
                "$set": {
                    "status": SaleStatus.FAILED,
                    "failure": str(exc),
                    "updated_at": _now(),
                }
            },
        )
        log.error(
            "Sale %s debited seller %s but could not credit buyer %s: %s",
            sale_id,
            seller_id,
            buyer_uid,
            exc,
        )
        raise PartnerOpsError(
            f"The seller was debited but the buyer could not be credited ({exc}). "
            "The sale is marked failed and needs a manual correction card."
        ) from exc

    now = _now()
    updated_sale = await db[SALES].find_one_and_update(
        {"_id": oid},
        {
            "$set": {
                "status": SaleStatus.APPROVED,
                "approved_by": _who(actor),
                "approved_at": now,
                "approval_reason": reason,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    # 3. Lifetime sold, on the record and on the document the CRM reads.
    partner = await db[C.PARTNERS].find_one_and_update(
        {"_id": seller_id},
        {
            "$inc": {"total_coins_sold": diamonds},
            "$set": {"updated_at": now},
        },
        return_document=ReturnDocument.AFTER,
    )
    total_sold = int((partner or {}).get("total_coins_sold", diamonds))
    synced = (
        _sync_partner_doc(partner, {"totalCoinsSold": total_sold})
        if partner
        else False
    )

    await audit.record(
        actor=actor,
        action=Act.SALE_APPROVED,
        subject_type="sale",
        subject_id=sale_id,
        reason=reason,
        before={"status": SaleStatus.PENDING},
        after={"status": SaleStatus.APPROVED},
        meta={
            "seller_id": seller_id,
            "buyer_uid": buyer_uid,
            "diamonds": diamonds,
            "seller_coins_after": debit["balance_after"],
            "buyer_diamonds_after": credit["balance_after"],
            "total_coins_sold": total_sold,
        },
    )

    out = _public(updated_sale)
    out["seller_coins_after"] = debit["balance_after"]
    out["buyer_diamonds_after"] = credit["balance_after"]
    out["total_coins_sold"] = total_sold
    out["replica_synced"] = synced
    return out


async def list_sales(
    seller_id: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> list[dict]:
    q: dict = {}
    if seller_id:
        q["seller_id"] = seller_id
    if status:
        q["status"] = status

    cursor = (
        get_db()[SALES].find(q).sort("created_at", -1).limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]


# ══════════════════════════════════════════════════════════════════════════════
# 15–17. Agency commission
# ══════════════════════════════════════════════════════════════════════════════


async def request_commission_payout(
    agency_id: str, amount_minor: int, reason: str, actor: dict
) -> dict:
    """Pay an agency what it has earned. Amounts are minor units (paise)."""
    reason = _require_reason(reason)
    amount_minor = _positive(amount_minor, "Amount")

    await _approved_partner(agency_id)
    outstanding = await get_balance(
        HolderType.AGENCY, agency_id, Currency.COMMISSION
    )
    if amount_minor > outstanding:
        raise PartnerOpsError(
            f"This agency has {outstanding} in commission outstanding; "
            f"a payout of {amount_minor} would overpay it."
        )

    return await _raise(
        NewCard(
            type=CardType.COMMISSION_PAYOUT,
            team=Team.FINANCE,
            title=f"Commission payout — {amount_minor / 100:,.2f}",
            amount=amount_minor,
            currency=str(Currency.COMMISSION),
            reason=reason,
            subject_type=str(HolderType.AGENCY),
            subject_id=agency_id,
            payload={
                "amount_minor": amount_minor,
                "outstanding_before": outstanding,
            },
        ),
        actor,
    )


async def execute_commission_payout(
    card_id: str, payment_ref: str, actor: dict
) -> dict:
    """Debit the commission balance and record how it was paid."""
    ref = (payment_ref or "").strip()
    if not ref:
        raise PartnerOpsError(
            "A payment reference is required — a payout with no reference "
            "cannot be reconciled against the bank."
        )

    card = await _card_ready(card_id, CardType.COMMISSION_PAYOUT)
    agency_id = (card.get("subject") or {}).get("id", "")
    amount_minor = int(card.get("amount", 0))

    try:
        movement = await _move(
            Movement(
                holder_type=HolderType.AGENCY,
                holder_id=agency_id,
                currency=Currency.COMMISSION,
                amount=-amount_minor,
                action=audit.Action.COMMISSION_PAY,
                reason=card.get("reason", "Commission paid"),
                actor=actor,
                card_id=card_id,
                idempotency_key=f"card:{card_id}:commission",
                meta={"payment_ref": ref},
            )
        )
    except PartnerOpsError as exc:
        await _finish(card_id, actor, {"error": str(exc), "payment_ref": ref}, False)
        raise

    now = _now()
    await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id)},
        {"$set": {"payload.payment_ref": ref, "payload.paid_at": now}},
    )

    return await _finish(
        card_id,
        actor,
        {"amount_minor": amount_minor, "payment_ref": ref, **movement},
        True,
    )


async def accrue_commission(
    agency_id: str,
    period: str,
    actor: dict,
    host_id: str = "",
    since: datetime | None = None,
    until: datetime | None = None,
    expected_amount_minor: int | None = None,
    reason: str = "",
) -> dict:
    """Credit earned commission. Used by the weekly payout run.

    **The server computes the amount.** The caller supplies the period; billing
    is derived from the ledger — what this agency's hosts actually cashed out in
    that window — and `app/services/commission.py` turns it into a figure at the
    band the live slab table selects. Until now this endpoint credited whatever
    `amount_minor` a browser sent, which meant an agency's commission was
    whatever someone typed. Spec 0.1.5 / 0.6.3.

    `expected_amount_minor` is optional and is only ever a **check**: if it does
    not match what the ledger produces, nothing is credited and the caller is
    told both figures. It can never set the amount.

    One movement is written per host, keyed `commission:{agency}:{host}:{period}`
    exactly as before, so re-running a period cannot accrue twice and existing
    callers keep working. The band is chosen once by the agency's total billing
    — a host's line is that one commission's share, apportioned by the beans it
    cashed out, with the parts summing to the total exactly. The full derivation
    goes into every movement's meta and into the audit entry, so any line of an
    agency's statement can be explained back to the ledger rows behind it.
    """
    partner = await _approved_partner(agency_id)
    host = (host_id or "").strip()

    try:
        computed = await commission_svc.compute_for_period(
            agency_id, period, since, until, partner
        )
    except commission_svc.CommissionError as exc:
        raise PartnerOpsError(str(exc)) from exc

    span = computed["period"]
    total_minor = int(computed["commission_minor"])
    lines = [h for h in computed["hosts"] if h["share_minor"] > 0]

    if host:
        lines = [h for h in lines if h["host_id"] == host]
        if not lines:
            raise PartnerOpsError(
                f"Host {host} cashed nothing out through "
                f"{computed['agency_name'] or agency_id} in {span}, so there is no "
                "commission to accrue for it. The agency billed "
                f"{commission_svc.rupee_text(computed['billing']['billing_minor'])} "
                f"across {computed['billing']['host_count']} host(s) in that period."
            )
        total_minor = sum(h["share_minor"] for h in lines)

    if total_minor <= 0:
        raise PartnerOpsError(
            f"{computed['breakdown']['explanation']} Nothing is accrued — a zero "
            "movement has no meaning, and this is a real zero rather than a "
            "missing figure."
        )

    if expected_amount_minor is not None and int(expected_amount_minor) != total_minor:
        raise PartnerOpsError(
            f"The amount supplied ({int(expected_amount_minor)} paise) does not "
            f"match what the ledger produces for {span} ({total_minor} paise). "
            f"{computed['breakdown']['explanation']} Nothing was credited. "
            "The server computes this figure; send only the period."
        )

    text = _reason(
        reason,
        f"Commission for {computed['agency_name'] or agency_id}, period {span}"
        + (f", host {host}" if host else ""),
    )

    accrued: list[dict] = []
    already: list[dict] = []
    credited_minor = 0
    for line in lines:
        share = int(line["share_minor"])
        movement = Movement(
            holder_type=HolderType.AGENCY,
            holder_id=agency_id,
            currency=Currency.COMMISSION,
            amount=share,
            action=audit.Action.COMMISSION_ACCRUE,
            reason=text,
            actor=actor,
            idempotency_key=f"commission:{agency_id}:{line['host_id']}:{span}",
            meta={
                "host_id": line["host_id"],
                "period": span,
                "agency_id": agency_id,
                # The whole derivation travels with the movement, so the
                # statement can explain this line without recomputing it.
                "commission_breakdown": _breakdown_meta(computed, line),
            },
        )
        try:
            result = await apply_movement(movement)
        except DuplicateMovement:
            # This host's leg of this period was accrued by an earlier run.
            # Re-running a period is a no-op per host, not a failure — the
            # hosts that have not been accrued yet must still go through.
            already.append(
                {"host_id": line["host_id"], "amount_minor": share}
            )
            continue
        except InsufficientBalance as exc:  # pragma: no cover — a credit cannot
            raise PartnerOpsError(str(exc)) from exc

        credited_minor += share
        accrued.append(
            {
                "host_id": line["host_id"],
                "amount_minor": share,
                "beans_cashed_out": line["beans_cashed_out"],
                "ledger_id": result.ledger_id,
                "balance_before": result.balance_before,
                "balance_after": result.balance_after,
                "replica_synced": result.replica_synced,
            }
        )

    if not accrued:
        raise PartnerOpsError(
            f"Every host's commission for {span} was already accrued "
            f"({total_minor} paise across {len(already)} host(s)). Nothing was "
            "credited a second time."
        )

    await audit.record(
        actor=actor,
        action=audit.Action.COMMISSION_ACCRUE,
        subject_type="partner",
        subject_id=agency_id,
        reason=text,
        after={
            "period": span,
            "commission_minor": total_minor,
            "credited_minor": credited_minor,
            "hosts_accrued": len(accrued),
            "hosts_already_accrued": len(already),
        },
        meta={
            "agency_id": agency_id,
            "agency_kind": computed["agency_kind"],
            "period": span,
            "since": computed["since"],
            "until": computed["until"],
            "billing_minor": computed["billing"]["billing_minor"],
            "beans_cashed_out": computed["billing"]["beans_cashed_out"],
            "band": computed["breakdown"]["band"],
            "rate_percent": computed["breakdown"]["rate_percent"],
            "rule": computed["breakdown"]["rule"],
            "rounding": computed["breakdown"]["rounding"],
            "explanation": computed["breakdown"]["explanation"],
            "slab_source": computed["slab_table"]["source"],
            "provisional": computed["provisional"],
            "amount_supplied_by_caller": (
                None if expected_amount_minor is None else int(expected_amount_minor)
            ),
            "hosts": [
                {
                    "host_id": a["host_id"],
                    "amount_minor": a["amount_minor"],
                    "beans_cashed_out": a["beans_cashed_out"],
                }
                for a in accrued
            ],
            "already_accrued": already,
        },
    )

    return {
        "agency_id": agency_id,
        "agency_name": computed["agency_name"],
        "agency_kind": computed["agency_kind"],
        "period": span,
        "since": computed["since"],
        "until": computed["until"],
        # `amount_minor` is what this period is worth, and keeps the name
        # earlier callers read. `credited_minor` is what this call moved — they
        # differ only when part of the period was already accrued.
        "amount_minor": total_minor,
        "amount_inr": total_minor / 100,
        "credited_minor": credited_minor,
        "credited_inr": credited_minor / 100,
        "already_accrued": already,
        "host_id": host or None,
        "scope": "one host" if host else "every host that cashed out",
        "accrued": accrued,
        "billing": computed["billing"],
        "breakdown": computed["breakdown"],
        "slab_table": computed["slab_table"],
        "hosts": computed["hosts"],
        "warnings": computed["warnings"],
        "provisional": computed["provisional"],
        "computed_by": "server, from the ledger — the caller supplied the period only",
    }


def _breakdown_meta(computed: dict, line: dict) -> dict:
    """The derivation, small enough to carry on every ledger movement."""
    return {
        "period": computed["period"],
        "since": computed["since"],
        "until": computed["until"],
        "agency_kind": computed["agency_kind"],
        "agency_billing_minor": computed["billing"]["billing_minor"],
        "agency_commission_minor": computed["commission_minor"],
        "band": computed["breakdown"]["band"],
        "rate_percent": computed["breakdown"]["rate_percent"],
        "floor_minor": computed["breakdown"]["floor_minor"],
        "rule": computed["breakdown"]["rule"],
        "rounding": computed["breakdown"]["rounding"],
        "explanation": computed["breakdown"]["explanation"],
        "host_beans_cashed_out": line["beans_cashed_out"],
        "host_share_minor": line["share_minor"],
        "host_share_note": line["share_note"],
        "slab_source": computed["slab_table"]["source"],
        "provisional": computed["provisional"],
        "billing_definition": computed["billing"]["definition"],
    }


async def commission_preview(
    agency_id: str,
    period: str,
    since: datetime | None = None,
    until: datetime | None = None,
) -> dict:
    """The same computation, without crediting anything.

    So a team member can see what a period will accrue — and what it is derived
    from — before anyone credits it.
    """
    partner = await _partner(agency_id)
    try:
        return await commission_svc.compute_for_period(
            agency_id, period, since, until, partner
        )
    except commission_svc.CommissionError as exc:
        raise PartnerOpsError(str(exc)) from exc


# ══════════════════════════════════════════════════════════════════════════════
# 17a. Host bean withdrawal — the host is paid, and the beans go away
# ══════════════════════════════════════════════════════════════════════════════
#
# `CardType.HOST_WITHDRAWAL` has existed since the board was written and the
# reports have always counted it, but nothing anywhere raised one and nothing
# executed one. A host's earnings were therefore paid in cash — by bank
# transfer, outside this system — while the beans stayed in Firestore, from
# where `functions/src/wallet.ts::convertBeans` turns them into diamonds. The
# same week's work could be collected twice, and the second collection looked
# like an ordinary conversion to everyone who saw it.
#
# The same silence is why agency commission reported zero. `commission.py`
# defines an agency's billing as what its hosts **cashed out** — bean debits
# carrying `meta.agency_id` whose action is `payout.execute` or
# `withdrawal.pay`. No withdrawal was ever executed, so no such row existed, so
# every agency billed nothing and earned nothing on hosts who were in fact
# being paid. The meta this writes is what turns that back on.
#
# WHERE THE NUMBER LIVES, AND WHY THE USUAL DIRECTION IS REVERSED.
#   Every other movement in this module is decided in Mongo and copied to
#   Firestore afterwards. This one cannot be. `beansAvailable` is written only
#   by `functions/src/payouts.ts`, which releases a completed week one week in
#   arrears, and it is spent only by Cloud Functions; Mongo has never seen any
#   of it and a Mongo balance would be a fiction. So the authoritative debit is
#   the Firestore one, it runs under a transaction that re-reads the figure, and
#   the Mongo movement is the ledger record of it.
#
#   That is why the movement carries `replica_applied_by_caller=True`. Without
#   it `apply_movement` would push its own `-beans` delta at `users/{uid}.beans`
#   on top of the debit the executor already made, and the host would be paid
#   once and debited twice. The number moves exactly once, in
#   `firebase.debit_host_beans`, and the ledger row explains it.


async def request_host_withdrawal(
    host_uid: str, beans: int, reason: str, actor: dict
) -> dict:
    """Raise a card to pay a host the beans they have available.

    Refused if the amount is more than the host's **current** `beansAvailable`.
    That figure is read live from Firestore rather than from the ledger for the
    reason in the section note above — Mongo does not hold it, and the number
    the host can see on their payout screen is the only honest bound on what
    they may be paid.

    The check here is not the protection; `execute_host_withdrawal` re-checks it
    inside a transaction, because a card sits on the board while a human reads
    it and the host goes on using the app in the meantime. This check exists so
    an impossible payout is refused at the moment somebody asks for it, instead
    of surviving a verification and a signature and failing at the till.
    """
    reason = _require_reason(reason)
    beans = _positive(beans, "Beans")

    uid = (host_uid or "").strip()
    if not uid:
        raise PartnerOpsError("A host uid is required.")

    try:
        wallet = await asyncio.to_thread(firebase.read_host_wallet, uid)
    except Exception as exc:  # noqa: BLE001
        log.exception("Firestore user lookup failed for host %s", uid)
        raise PartnerOpsError(
            f"The wallet for host '{uid}' could not be read from Firestore, so "
            "there is no figure to check this withdrawal against. Nothing was "
            "raised — try again once Firestore is reachable."
        ) from exc

    if wallet is None:
        raise PartnerOpsError(
            f"No users document with id '{uid}'. A withdrawal is paid against a "
            "host's own wallet, so a card cannot be raised for an account that "
            "does not exist."
        )

    available = int(wallet["beans_available"])
    if beans > available:
        raise PartnerOpsError(
            f"This host has {available:,} beans available to withdraw; a payout "
            f"of {beans:,} would pay them earnings that have not been released "
            "yet. Beans are released a week in arrears, so the rest becomes "
            "payable on the Monday after the week it was earned."
        )

    agency_id = str(wallet["agency_id"])
    warnings: list[str] = []
    if not agency_id:
        warnings.append(
            "This host's user document names no agencyId, so this payout will "
            "bill no agency and no commission will be earned on it. If the host "
            "does belong to an agency, fix the link before executing."
        )
    if not wallet["is_verified_host"]:
        warnings.append(
            "This host is not verified. The weekly release will not release "
            "another week for them until they are, so whatever is available "
            "here is all they will have."
        )

    card = await _raise(
        NewCard(
            type=CardType.HOST_WITHDRAWAL,
            team=Team.FINANCE,
            title=f"Host withdrawal — {beans:,} beans",
            amount=beans,
            currency=str(Currency.BEANS),
            reason=reason,
            # The subject is a Firebase uid, not a partner record id, exactly as
            # `balance_credit` carries one. `PARTNER_SUBJECT_TYPES` does not
            # include "user", so this never reaches a partner's board.
            subject_type=str(HolderType.USER),
            subject_id=uid,
            payload={
                "beans": beans,
                "host_id": uid,
                "host_name": wallet["name"],
                # The agency at the moment the card was raised. The executor
                # re-reads it and the ledger row carries what the executor saw,
                # so a host who changes agency between the two is billed to the
                # one that was actually theirs when they were paid. This copy is
                # here so the difference is visible on the card rather than
                # silent.
                "agency_id": agency_id,
                "beans_available_at_request": available,
                "is_verified_host": wallet["is_verified_host"],
            },
        ),
        actor,
    )
    if warnings:
        card["warnings"] = warnings
    return card


async def execute_host_withdrawal(
    card_id: str, payment_ref: str, actor: dict
) -> dict:
    """Pay the host, take the beans out of their wallet, and record it.

    ORDER, AND WHY IT IS THIS WAY ROUND.
      The Firestore debit runs first and the Mongo movement second. Either order
      can fail in the middle; they fail differently, and only one of the two
      failures is the bug this whole path exists to close.

      Mongo first would mean a Firestore write that does not happen leaves a
      ledger saying the host was paid while the beans are still in their wallet
      — which is precisely the double collection described above, now with a
      paper trail that says it did not happen.

      Firestore first means a Mongo write that does not happen leaves the host
      debited with no ledger row: they are owed a correction, the business has
      not lost anything twice, and the card is left `failed` and visibly stuck
      (5.2.6) with `firestore_debited` in its execution result so whoever picks
      it up knows the money has already moved. A failed card cannot be executed
      again — `_card_ready` only accepts `approved` — so there is no retry that
      could debit the wallet a second time.
    """
    ref = (payment_ref or "").strip()
    if not ref:
        raise PartnerOpsError(
            "A payment reference is required — a payout with no reference "
            "cannot be reconciled against the bank."
        )

    card = await _card_ready(card_id, CardType.HOST_WITHDRAWAL)
    host_uid = (card.get("subject") or {}).get("id", "")
    beans = int(card.get("amount", 0))

    # ── 1. The authoritative debit, guarded by a transaction ─────────────────
    try:
        debited = await asyncio.to_thread(firebase.debit_host_beans, host_uid, beans)
    except firebase.HostBeansUnavailable as exc:
        detail = (
            f"{host_uid} now has {exc.available:,} beans available, not "
            f"{exc.requested:,}. Nothing was paid and nothing was debited — the "
            "host has converted or been paid some of this since the card was "
            "raised. Raise a fresh card for what is actually available."
        )
        await _finish(card_id, actor, {"error": detail, "payment_ref": ref}, False)
        raise PartnerOpsError(detail) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("Firestore bean debit failed for host %s", host_uid)
        detail = (
            "The host's wallet could not be debited in Firestore, so nothing "
            "was paid. The card is marked failed rather than executed — raise a "
            f"fresh one once Firestore is reachable. ({exc})"
        )
        await _finish(card_id, actor, {"error": detail, "payment_ref": ref}, False)
        raise PartnerOpsError(detail) from exc

    agency_id = str(debited["agency_id"])

    # ── 2. The ledger row ────────────────────────────────────────────────────
    #
    # `holder_type: user` / `currency: beans` with a negative amount and the
    # action `withdrawal.pay` is exactly the shape `commission.agency_billing`
    # aggregates on, and `meta.agency_id` is what it groups by. `host_id` is
    # beside it because the movement's own `holder_id` is not meta, and every
    # other statement reader in this codebase looks in meta.
    #
    # `replica_applied_by_caller` because step 1 already moved the Firestore
    # figure. Without it the delta sync in `apply_movement` would take the same
    # beans out of `users/{uid}.beans` a second time.
    try:
        movement = await _move(
            Movement(
                holder_type=HolderType.USER,
                holder_id=host_uid,
                currency=Currency.BEANS,
                amount=-beans,
                action=audit.Action.WITHDRAWAL_PAY,
                reason=card.get("reason", "Host withdrawal paid"),
                actor=actor,
                card_id=card_id,
                idempotency_key=f"card:{card_id}:withdrawal",
                meta={
                    "payment_ref": ref,
                    "agency_id": agency_id,
                    "host_id": host_uid,
                    "beans_available_before": debited["beans_available_before"],
                    "beans_before": debited["beans_before"],
                },
                # The balances Mongo holds for a host are a record of CRM
                # movements only — the app credits and spends beans through
                # Cloud Functions Mongo never sees — so this would otherwise
                # refuse the debit as "insufficient" against a balance that was
                # never the host's real one. Firestore has already checked the
                # figure that matters, under a transaction, in step 1.
                allow_negative=True,
                replica_applied_by_caller=True,
            )
        )
    except PartnerOpsError as exc:
        detail = (
            f"The host's wallet WAS debited {beans:,} beans in Firestore, but "
            f"the ledger row could not be written ({exc}). The card is failed "
            "and needs a manual correction — the beans have gone and nothing "
            "records why."
        )
        log.error(
            "Host withdrawal %s debited %s beans from %s in Firestore but the "
            "Mongo movement failed: %s",
            card_id,
            beans,
            host_uid,
            exc,
        )
        await _finish(
            card_id,
            actor,
            {
                "error": detail,
                "payment_ref": ref,
                "firestore_debited": beans,
                "needs_manual_correction": True,
            },
            False,
        )
        raise PartnerOpsError(detail) from exc

    now = _now()
    await get_db()[C.CARDS].update_one(
        {"_id": ObjectId(card_id)},
        {
            "$set": {
                "payload.payment_ref": ref,
                "payload.paid_at": now,
                "payload.agency_id": agency_id,
            }
        },
    )

    return await _finish(
        card_id,
        actor,
        {
            "beans": beans,
            "payment_ref": ref,
            "host_id": host_uid,
            "agency_id": agency_id,
            "beans_available_before": debited["beans_available_before"],
            "beans_available_after": debited["beans_available_before"] - beans,
            **movement,
        },
        True,
    )


# ══════════════════════════════════════════════════════════════════════════════
# 18–19. Sub-agency — paid through the parent. Spec 4.2.4
# ══════════════════════════════════════════════════════════════════════════════


async def request_subagency_payout(
    parent_id: str, sub_id: str, amount_minor: int, reason: str, actor: dict
) -> dict:
    """A sub-agency's commission, routed through its parent. Spec 4.2.4.

    Two legs are recorded from the start:

      1. our payment to the main agency, and
      2. the main agency's onward payment to the sub.

    The payout is not closed until leg 2 is confirmed — otherwise money leaves
    us and the sub never sees it, with nothing on record showing that.
    """
    reason = _require_reason(reason)
    amount_minor = _positive(amount_minor, "Amount")

    sub = await _approved_partner(sub_id, PartnerKind.SUB_AGENCY)
    parent = await _approved_partner(parent_id)

    if sub.get("parent_id") != parent_id:
        raise PartnerOpsError(
            f"{sub.get('name') or sub_id} is not a sub-agency of "
            f"{parent.get('name') or parent_id}. Money must flow through the "
            "sub-agency's own parent."
        )

    outstanding = await get_balance(HolderType.AGENCY, sub_id, Currency.COMMISSION)
    if amount_minor > outstanding:
        raise PartnerOpsError(
            f"This sub-agency has {outstanding} in commission outstanding; "
            f"a payout of {amount_minor} would overpay it."
        )

    card = await _raise(
        NewCard(
            type=CardType.SUBAGENCY_PAYOUT,
            team=Team.FINANCE,
            title=(
                f"Sub-agency payout — {amount_minor / 100:,.2f} "
                f"via {parent.get('name') or parent_id}"
            ),
            amount=amount_minor,
            currency=str(Currency.COMMISSION),
            reason=reason,
            subject_type=str(HolderType.AGENCY),
            subject_id=sub_id,
            payload={
                "parent_id": parent_id,
                "sub_id": sub_id,
                "amount_minor": amount_minor,
                "outstanding_before": outstanding,
                "legs": ["zipper_to_parent", "parent_to_sub"],
            },
        ),
        actor,
    )

    now = _now()
    payout = {
        "card_id": card["id"],
        "parent_id": parent_id,
        "parent_name": parent.get("name", ""),
        "sub_id": sub_id,
        "sub_name": sub.get("name", ""),
        "amount_minor": amount_minor,
        "status": PayoutStatus.PENDING,
        "reason": reason,
        "leg1": {
            "description": "Zipper pays the main agency",
            "status": "pending",
            "paid_at": None,
            "payment_ref": None,
            "by": None,
        },
        "leg2": {
            "description": "Main agency pays the sub-agency",
            "status": "pending",
            "confirmed_at": None,
            "reason": None,
            "by": None,
        },
        "created_at": now,
        "updated_at": now,
        "requested_by": _who(actor),
    }
    result = await get_db()[SUBAGENCY_PAYOUTS].insert_one(payout)

    payout["id"] = str(result.inserted_id)
    payout.pop("_id", None)
    return {"card": card, "payout": payout, "payout_id": payout["id"]}


async def execute_subagency_payout(
    card_id: str, payment_ref: str, actor: dict
) -> dict:
    """Leg 1 — we pay the main agency, and the sub's balance is settled.

    The payout stays open: leg 2 is still outstanding until the parent confirms
    it has passed the money on.
    """
    ref = (payment_ref or "").strip()
    if not ref:
        raise PartnerOpsError(
            "A payment reference is required for the payment to the main agency."
        )

    card = await _card_ready(card_id, CardType.SUBAGENCY_PAYOUT)
    payload = card.get("payload") or {}
    sub_id = payload.get("sub_id") or (card.get("subject") or {}).get("id", "")
    parent_id = payload.get("parent_id", "")
    amount_minor = int(card.get("amount", 0))

    try:
        movement = await _move(
            Movement(
                holder_type=HolderType.AGENCY,
                holder_id=sub_id,
                currency=Currency.COMMISSION,
                amount=-amount_minor,
                action=audit.Action.COMMISSION_PAY,
                reason=card.get("reason", "Sub-agency commission paid via parent"),
                actor=actor,
                card_id=card_id,
                idempotency_key=f"card:{card_id}:subagency",
                meta={
                    "paid_to": parent_id,
                    "on_behalf_of": sub_id,
                    "payment_ref": ref,
                    "leg": "zipper_to_parent",
                },
            )
        )
    except PartnerOpsError as exc:
        await _finish(card_id, actor, {"error": str(exc), "payment_ref": ref}, False)
        raise

    now = _now()
    payout = await get_db()[SUBAGENCY_PAYOUTS].find_one_and_update(
        {"card_id": card_id},
        {
            "$set": {
                "status": PayoutStatus.PARENT_PAID,
                "leg1.status": "paid",
                "leg1.paid_at": now,
                "leg1.payment_ref": ref,
                "leg1.by": _who(actor),
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=Act.SUBAGENCY_PAID_PARENT,
        subject_type="subagency_payout",
        subject_id=str(payout["_id"]) if payout else card_id,
        reason=card.get("reason", "Sub-agency commission paid via parent"),
        after={"status": PayoutStatus.PARENT_PAID},
        card_id=card_id,
        meta={
            "parent_id": parent_id,
            "sub_id": sub_id,
            "amount_minor": amount_minor,
            "payment_ref": ref,
            "leg2_outstanding": True,
        },
    )

    await _finish(
        card_id,
        actor,
        {
            "amount_minor": amount_minor,
            "paid_to_parent": parent_id,
            "on_behalf_of": sub_id,
            "payment_ref": ref,
            "leg2_outstanding": True,
            **movement,
        },
        True,
    )

    return {
        "payout": _public(payout) if payout else None,
        "note": (
            "Leg 1 complete. This payout stays open until the main agency "
            "confirms it has paid the sub-agency."
        ),
    }


async def confirm_subagency_leg(payout_id: str, reason: str, actor: dict) -> dict:
    """Leg 2 — the parent confirms it has paid the sub. The payout closes."""
    reason = _require_reason(reason)

    try:
        oid = ObjectId(payout_id)
    except Exception as exc:  # noqa: BLE001
        raise PartnerOpsError("Payout not found.") from exc

    db = get_db()
    payout = await db[SUBAGENCY_PAYOUTS].find_one({"_id": oid})
    if payout is None:
        raise PartnerOpsError("Payout not found.")
    if payout["status"] == PayoutStatus.CLOSED:
        raise PartnerOpsError("This payout is already closed.")
    if payout["status"] != PayoutStatus.PARENT_PAID:
        raise PartnerOpsError(
            "The main agency has not been paid yet — leg 1 must complete first."
        )

    now = _now()
    updated = await db[SUBAGENCY_PAYOUTS].find_one_and_update(
        {"_id": oid},
        {
            "$set": {
                "status": PayoutStatus.CLOSED,
                "leg2.status": "confirmed",
                "leg2.confirmed_at": now,
                "leg2.reason": reason,
                "leg2.by": _who(actor),
                "closed_at": now,
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )

    await audit.record(
        actor=actor,
        action=Act.SUBAGENCY_PARENT_PAID_SUB,
        subject_type="subagency_payout",
        subject_id=payout_id,
        reason=reason,
        before={"status": PayoutStatus.PARENT_PAID},
        after={"status": PayoutStatus.CLOSED},
        card_id=payout.get("card_id"),
        meta={
            "parent_id": payout.get("parent_id"),
            "sub_id": payout.get("sub_id"),
            "amount_minor": payout.get("amount_minor"),
        },
    )
    return _public(updated)


async def open_subagency_payouts(
    limit: int = 100, partner_ids: set[str] | None = None
) -> list[dict]:
    """Payouts where our money has left but the sub has not been confirmed paid.

    This is the list that makes 4.2.4 enforceable rather than aspirational.

    `partner_ids` narrows it to the payouts those partners are a party to —
    parent on one, sub on the other. Passing it is how the route answers an
    agency without answering it about every other agency's money; `None` is the
    staff view and is what every existing caller gets. **An empty set is not
    `None`**: it is asked for as an explicit `is None` below rather than a
    truth test, so a caller that computes a partner's ids and finds none cannot
    silently fall back to the unscoped query.
    """
    query: dict = {"status": {"$ne": PayoutStatus.CLOSED}}
    if partner_ids is not None:
        ids = sorted(partner_ids)
        query["$or"] = [{"parent_id": {"$in": ids}}, {"sub_id": {"$in": ids}}]

    cursor = (
        get_db()[SUBAGENCY_PAYOUTS]
        .find(query)
        .sort("created_at", 1)
        .limit(max(1, min(limit, 500)))
    )
    return [_public(doc) async for doc in cursor]
