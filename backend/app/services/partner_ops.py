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
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from firebase_admin import auth as fb_auth
from firebase_admin import firestore as fb_firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.core import audit
from app.services import notices
from app.core import roles as R
from app.services import partner_roles
from app.services import contact_verification
from app.services import money_freeze
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


class PartnerOpsForbidden(PartnerOpsError):
    """Refused because of WHO is asking, not what was asked (C2 / C3).

    A subclass, so every existing `except PartnerOpsError` still catches it;
    `routers/partner_ops._fail` answers it with `status_code` (403) rather
    than 400.
    """

    status_code = 403


#: C2 — turning a REVOKED role back to approved is the Owner's decision.
OWNER_ONLY_RESTORE = (
    "Only the Owner can restore a revoked role. Recommend it on the person's "
    "reinstatement request instead."
)

#: C3 — a revocation that moves dependents is a transfer, and transfers are
#: decided by the Owner. `{n}` is how many hosts and sub-agencies would move.
OWNER_ONLY_TRANSFER = (
    "This revocation moves {n} hosts/sub-agencies. Transfers are decided by the "
    "Owner — file a transfer recommendation instead."
)


def _is_owner(actor: Mapping | None) -> bool:
    """Is this actor a business Owner? A raw session claim is accepted."""
    return R.is_owner_value((actor or {}).get("role"))


class Act:
    """Audit actions this module adds to the ones in `app.core.audit`."""

    PARTNER_CREATED = "partner.created"
    PARTNER_REACTIVATED = "partner.reactivated"
    #: Decision 15 (RC): approved by the Owner while the login's contacts were
    #: not both verified — the role waits, granting nothing.
    PARTNER_APPROVED_PENDING_VERIFICATION = "partner.approved_pending_verification"
    #: Decision 15 (RC): both contacts verified; the approved role started.
    PARTNER_ACTIVATED = "partner.activated"
    #: D17: an ACTIVE legacy role whose login lacks a verified phone or email,
    #: moved into `awaiting_verification` by the reviewed migration.
    PARTNER_HELD_FOR_VERIFICATION = "partner.held_for_verification"
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
    #: M-11: claimed by an approval in flight (compare-and-set from `pending`
    #: or `failed`); re-taken after `SALE_STALE_CLAIM` if the process died.
    APPROVING = "approving"
    APPROVED = "approved"
    #: Debited, not credited. Resumable — approving again continues.
    FAILED = "failed"


#: A sale left `approving` longer than this belongs to a process that died.
SALE_STALE_CLAIM = timedelta(minutes=10)


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
    """A card an owner has signed and nobody has executed yet.

    RC (confirmed, CRM-FLOW 9.48): and whose money is not FROZEN — a payout,
    withdrawal, coin purchase or loan for a subject whose money was frozen by a
    suspension, ban or revocation waits for the Owner's decision
    (`services/money_freeze`). This is the one place each such card is taken
    for execution, so no execute path can forget the check.
    """
    doc = await _card(card_id, expected)
    stage = doc.get("stage")
    if stage == str(Stage.EXECUTED):
        raise PartnerOpsError("This card has already been executed.")
    if stage != str(Stage.APPROVED):
        raise PartnerOpsError(
            f"Card is {stage}. Only a card signed by an owner can be executed."
        )
    try:
        await money_freeze.assert_card_not_frozen(doc, db=get_db())
    except money_freeze.MoneyFrozen as exc:
        raise MoneyFrozenError(str(exc)) from exc
    return doc


class MoneyFrozenError(PartnerOpsError):
    """RC: refused because the subject's money is frozen for the Owner's review."""

    status_code = 409


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


async def _move_once(m: Movement) -> tuple[dict, bool]:
    """A card's movement, or the record of it if it already happened (B-5).

    Every executor keys its ledger row on the card, so a replayed execution —
    a double click, a retry after a timeout, a second worker — finds the row
    already there. That used to be treated as a failure: the card was marked
    FAILED over money that had moved, could never be executed again, and
    invited a fresh (double) card. Now it is what it is: already applied. The
    stored row's figures come back and the caller closes the card as
    executed. `(movement, already_applied)`.
    """
    try:
        return await _move(m), False
    except PartnerOpsError as exc:
        if not isinstance(exc.__cause__, DuplicateMovement) or not m.idempotency_key:
            raise
        row = await get_db()[C.LEDGER].find_one({"idempotency_key": m.idempotency_key}) or {}
        return {
            "ledger_id": str(row.get("_id") or ""),
            "balance_before": int(row.get("balance_before") or 0),
            "balance_after": int(row.get("balance_after") or 0),
            "replica_synced": True,
            "already_applied": True,
        }, True


async def _claim(card_id: str, actor: dict) -> None:
    """M-12: every executor claims the card before its first write."""
    try:
        await card_svc.claim_execution(card_id, actor)
    except CardError as exc:
        raise PartnerOpsError(str(exc)) from exc


def _already_recorded(partner: dict, card_id: str) -> dict | None:
    """The `credit.history` entry this card already wrote, if any.

    An execution that crashed between the partner-record update and closing
    the card is run again; the entry is the proof the update landed, so the
    retry closes the card instead of applying the figure twice (M-12)."""
    for entry in ((partner.get("credit") or {}).get("history") or []):
        if isinstance(entry, dict) and str(entry.get("card_id") or "") == str(card_id):
            return entry
    return None


#: How many times a conditional credit update is re-read and retried when a
#: concurrent executor moved the figure under it.
_CREDIT_CAS_ATTEMPTS = 5


async def _update_credit_conditionally(
    seller_id: str, card_id: str, compute, *, kind: PartnerKind | None = PartnerKind.SELLER,
) -> tuple[dict, dict]:
    """Apply a change to `credit.outstanding` only if it is still what was read.

    `compute(partner) -> (update_doc, result)` builds the update from the
    outstanding figure it read; the write carries that figure in its filter,
    so a lending executing concurrently with a repayment cannot overwrite the
    other's figure — the loser re-reads and recomputes (M-12). A card whose
    entry is already in `credit.history` is not applied again.

    Returns `(partner_after, result)`; `result["replayed"]` is True when the
    entry already existed.
    """
    for _attempt in range(_CREDIT_CAS_ATTEMPTS):
        partner = await _partner(seller_id, kind)
        prior = _already_recorded(partner, card_id)
        if prior is not None:
            return partner, {"replayed": True, "entry": prior}
        outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
        update, result = compute(partner)
        filt: dict = {"_id": seller_id}
        if (partner.get("credit") or {}).get("outstanding") is not None:
            # The figure read is in the filter: a concurrent executor that
            # moved it makes this write miss. A record with no credit figure
            # yet (its first lending) has nothing to compare; the ledger key
            # and the history guard above still make that case idempotent.
            filt["credit.outstanding"] = outstanding
        updated = await get_db()[C.PARTNERS].find_one_and_update(
            filt, update, return_document=ReturnDocument.AFTER,
        )
        if updated is not None:
            return updated, {**result, "replayed": False}
    raise PartnerOpsError(
        "This seller's credit figure kept changing while the card was being executed. "
        "Nothing was applied — execute it again."
    )


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

    if status is PartnerStatus.AWAITING_VERIFICATION:
        # Decision 15 (RC): the documents WERE decided (approved), the role has
        # not started. `isActive`/`isApproved` stay false above, so no rules
        # helper, trigger email or public listing treats it as live.
        if verified_documents:
            fields["kycStatus"] = "approved"
        return fields

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
    # REVOKED leaves `kycStatus` exactly where it was. The identity was
    # verified; what has been withdrawn is the role, and the record is now
    # history rather than a file awaiting a decision.
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


async def _validate_parent_agency(parent_id: str, applicant_uid: str) -> dict:
    """The parent a new sub-agency may hang under — or a refusal saying why not.

    ── NEVER THE CLIENT'S WORD ─────────────────────────────────────────────

    `parentAgencyId` arrives on the Firestore document, which the browser or
    the app wrote. Until now it was copied straight into Mongo as `parent_id`
    with no check of any kind — not that it existed, not that it was an
    agency, not that it was a MAIN agency. The only things stopping a
    sub-agency under a sub-agency were two JSX conditionals that hid a button.
    A client that did not render the button could nest agencies arbitrarily
    deep, and the payout path at `request_subagency_payout` would have paid
    the nested one from a parent that is itself paid from a parent.

    The business rule is exactly one level: a Sub-agency sits under a MAIN
    Agency and nowhere else. So the parent must:

      * exist as a Mongo partner record (an id that names no record, or only
        a Firestore document nobody registered, is not an agency that can
        accept anyone);
      * be `kind: agency` — not `sub_agency` (no sub-sub-agency), not `seller`;
      * be `approved` and `is_active` — a pending, rejected, suspended or
        revoked agency cannot take on a sub-agency;
      * not belong to the applicant — one human cannot be a sub-agency of
        their own agency (and the role-family rule would refuse the pair
        anyway; this just says it in the right words).

    Reads Mongo only. The authoritative state of a partner is the Mongo
    record; the Firestore document is the replica the app reads.
    """
    pid = str(parent_id or "").strip()
    if not pid:
        raise PartnerOpsError(
            "A sub-agency must name the main agency it belongs to. Nothing was "
            "created."
        )
    parent = await get_db()[C.PARTNERS].find_one({"_id": pid})
    if parent is None:
        raise PartnerOpsError(
            f"'{pid}' is not a registered agency, so a sub-agency cannot be "
            "created under it. Nothing was created."
        )
    if str(parent.get("kind") or "") != str(PartnerKind.AGENCY):
        if str(parent.get("kind") or "") == str(PartnerKind.SUB_AGENCY):
            raise PartnerOpsError(
                f"'{parent.get('name') or pid}' is itself a sub-agency. A "
                "sub-agency sits exactly one level under a main agency; it "
                "cannot have sub-agencies of its own. Nothing was created."
            )
        raise PartnerOpsError(
            f"'{parent.get('name') or pid}' is a {parent.get('kind') or 'partner'}, "
            "not a main agency, so it cannot have a sub-agency. Nothing was created."
        )
    if (
        str(parent.get("status") or "") != str(PartnerStatus.APPROVED)
        or not parent.get("is_active", False)
    ):
        raise PartnerOpsError(
            f"'{parent.get('name') or pid}' is {parent.get('status') or 'not approved'}"
            + ("" if parent.get("is_active", False) else " and inactive")
            + ", so it cannot accept a sub-agency right now. Nothing was created."
        )
    uid = str(applicant_uid or "").strip()
    # B07: the parent's owner as resolved — Mongo first, its Firestore
    # document second — so an agency whose owner link never reached Mongo is
    # still recognised as the applicant's own.
    if uid and await partner_roles.owner_uid_of(parent, db=get_db()) == uid:
        raise PartnerOpsError(
            "You cannot register a sub-agency under your own agency. Nothing "
            "was created."
        )
    return parent


#: Sources a CLIENT writes when it creates an `agencies` / `sellers` document
#: itself (the signed-in CRM public signup forms). `firestore.rules` pins every
#: non-staff create arm to this value; `ensure_partner_record` holds documents
#: carrying it to the full application eligibility (approved contact rule).
CLIENT_CREATED_SOURCES = frozenset({"self_signup"})


def _is_service_actor(actor: Mapping[str, object] | None) -> bool:
    """Resolved from a service key rather than a session — the same test as
    `app.core.security.is_service_actor`, without importing the security layer
    into this service module."""
    return str((actor or {}).get("role") or "") == R.SYSTEM_ROLE


async def ensure_partner_record(
    partner_id: str,
    actor: dict,
    reason: str,
    kind: PartnerKind | None = None,
    *,
    enforce_role_family: bool = True,
) -> tuple[dict, bool, list[str]]:
    """The Mongo partner record for `partner_id`, created from Firestore if it
    does not exist yet. Returns `(document, created, warnings)`.

    `enforce_role_family=False` is for `scripts/backfill_partners.py` and
    nothing else: a MIRROR of records that already exist must represent what
    it finds, duplicates included, so they can be seen and corrected. Every
    path that CREATES a partner — a staff member registering one, the
    Firestore triggers behind the public signup forms, the application route
    the app calls — leaves it True and is held to the one-agency-per-human
    rule and to parent validation. It used to be keyed on "is the actor the
    system role", which the signup triggers also are, so every self-signed-up
    partner since launch skipped the rule. That was the hole.

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

    # ── ONE HUMAN, ONE AGENCY-FAMILY RECORD ─────────────────────────────────
    #
    # Claimed BEFORE the insert, because the claim is the lock. Two concurrent
    # creates for the same person reach `claim_role_family` and exactly one
    # gets past it — the other raises `RoleConflict` having written nothing.
    #
    # The owner is the Firebase uid off the Firestore record, never the email:
    # an address is mutable, is absent on some records, and `crmUid` is what
    # every partner document already carries. `ownerUid` is tried first
    # because the app-side signup writes that one; `crmUid` is what the CRM
    # paths write; `secondRoleOwnerUid` is what the second-capability flow
    # writes, and that flow is how the production duplicate was created.
    owner_uid = ""
    for field in ("ownerUid", "crmUid", "secondRoleOwnerUid"):
        owner_uid = str(source.get(field) or "").strip()
        if owner_uid:
            break

    # ── FX-06: A DOCUMENT WITH NO OWNER AND NO SOURCE IS NOT AN APPLICATION ──
    #
    # Every real creator stamps `source` (the app path `self_app`, the public
    # forms `self_signup`, staff `crm` / `crm_admin`, a parent's dashboard
    # `agency_created`, the second-capability flow `second_role`) or names a
    # human. A document with neither is what a failed registration-trigger
    # outcome write used to leave when it re-created a deleted application as
    # a stub (DUP-02). Registering it gave a nameless, ownerless pending
    # partner that a reviewer could approve. Refused for the registration
    # SERVICE actor — staff creating a record by hand from /kyc or a retry
    # are making a deliberate decision and keep that ability.
    if _is_service_actor(actor) and not owner_uid and not str(source.get("source") or "").strip():
        raise PartnerOpsError(
            f"'{pid}' names no owner and no source, so it is not an application "
            "anybody filed — most likely a document re-created by a failed "
            "write. Nothing was created."
        )

    # ── APPROVED CONTACT RULE: NO BYPASS THROUGH A CLIENT-CREATED DOCUMENT ──
    #
    # A document a client created straight in Firestore (`self_signup`, the
    # only source the rules allow a non-staff create to carry) is held to the
    # same eligibility the app's application path applies before writing:
    # restriction, staff, the contact rule and the whole combination table.
    # Not applied to a mirror (`enforce_role_family=False`).
    if (
        enforce_role_family
        and owner_uid
        and str(source.get("source") or "").strip() in CLIENT_CREATED_SOURCES
    ):
        from app.services import partner_applications as apps  # local: apps imports this module

        await apps.refuse_client_created_registration(owner_uid, doc["kind"])

    # ── An UNLINKED record belongs to no human yet ──────────────────────────
    #
    # `/agencies/register` creates the Firestore agency deliberately without
    # `crmUid` — "if the two writes below fail, the record is left with no
    # login attached, which is exactly what /agencies badges, so the state is
    # visible rather than invisible". So an agency with no owner is a designed
    # state, not corruption, and refusing to create its partner record would
    # break staff onboarding to enforce a rule that cannot even apply: a
    # record attached to nobody is not a second agency for anybody.
    #
    # It is warned about rather than waved through, because the rule has to be
    # applied at the moment somebody DOES link it — see the note in
    # `services/partner_roles`. That link happens in the browser today, which
    # is the remaining gap in this fix and is reported as one.
    # ── MIRRORING IS NOT CREATING ───────────────────────────────────────────
    #
    # `ensure_partner_record` serves two callers. A person registering a new
    # partner must be held to the one-agency-per-human rule. A SYSTEM actor —
    # `scripts/backfill_partners.py` — is mirroring Firestore records that
    # already exist into Mongo, and a mirror that refuses to represent the
    # data it finds is useless: it would stop partway through, and the
    # duplicate it baulked at would be the one thing you could no longer see
    # in Mongo.
    #
    # This matters right now, not hypothetically. Production holds two main
    # agencies for `ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2`, so a claiming backfill
    # would fail on the second one. The rule governs what may be CREATED from
    # here on; existing data is surfaced and corrected deliberately.
    #
    # The distinction is the EXPLICIT `enforce_role_family` flag, which only
    # the backfill script clears. It used to be "is the actor the system
    # role" — and the partner-registration service credential behind the
    # public signup triggers is ALSO the system role, so every agency and
    # seller who applied through `/agency-signup` or `/seller-signup` since
    # launch was mirrored in, unchecked, as though they were historical data.
    if not enforce_role_family:
        warnings.append(
            "Mirrored without enforcement, so the one-agency-per-human rule "
            "and parent validation were not applied. Existing duplicates are "
            "reported, not blocked."
        )
    else:
        # ── THE PARENT IS VALIDATED BEFORE ANYTHING IS CLAIMED ──────────────
        #
        # A sub-agency whose parent is not a live main agency is refused
        # outright. Before the claim so nothing has to be given back.
        if doc["kind"] == str(PartnerKind.SUB_AGENCY):
            parent = await _validate_parent_agency(doc["parent_id"], owner_uid)
            doc["parent_name"] = str(parent.get("name") or "")

        if not owner_uid:
            warnings.append(
                "This partner record names no Firebase login, so the "
                "one-agency-per-human rule could not be applied to it. It "
                "will be checked when a login is attached."
            )

    if enforce_role_family and owner_uid:
        # ── A REVOKED ROLE IS NOT RE-CREATED AS A NEW RECORD (C1 / B04) ─────
        #
        # Every creation path lands here — the CRM register screens through
        # `create_partner`, the registration triggers, approval of a record
        # that has no Mongo row yet. A person whose role of this kind was
        # revoked asks for it back; a fresh record would be the revoked role
        # treated as though it had never existed.
        for held in await partner_roles.records_owned_by(owner_uid, db=db):
            if (
                str(held.get("kind") or "") == doc["kind"]
                and str(held.get("status") or "") == str(PartnerStatus.REVOKED)
            ):
                raise PartnerOpsError(
                    partner_roles.revoked_refusal(doc["kind"]) + " Nothing was created."
                )
        try:
            await partner_roles.claim_role_family(
                owner_uid, doc["kind"], pid, actor=actor
            )
        except partner_roles.RoleConflict as exc:
            # ── A REFUSAL IS A 400, NOT A CRASH ─────────────────────────────
            #
            # Every router here does `except PartnerOpsError` -> 400 with the
            # message. `RoleConflict` is its own class and nothing catches
            # it, so without this it leaves as an unhandled 500: the caller
            # sees "Internal Server Error", the message explaining WHICH
            # agency they already hold is swallowed, and a rule working
            # exactly as designed reads as the server falling over.
            #
            # Re-raised rather than renamed at the source because
            # `partner_roles` must not import `partner_ops` — `partner_ops`
            # imports it.
            raise PartnerOpsError(str(exc)) from exc

    # ── OWNERSHIP IS WRITTEN AT BIRTH ───────────────────────────────────────
    #
    # `owner_crm_uid` is the field everything resolves a partner's human by:
    # sign-in (`resolve_partner_login`), session revocation, the login
    # mirror, and — decisively — `_live_record_in_family`, which is how the
    # one-agency-per-human rule sees records that predate the sentinel. It
    # was set only by `attach_login` and the second-role flow, never here. So
    # a record created with a perfectly good owner uid on its Firestore
    # document went into Mongo belonging to nobody, and the rule could not
    # see it the next time that human applied. Written now, on the same
    # insert, from the same uid the claim above was taken for.
    if owner_uid:
        doc["owner_crm_uid"] = owner_uid
        login_email = str(source.get("ownerEmail") or source.get("email") or "").strip().lower()
        if login_email:
            doc["login_email"] = login_email

    try:
        await db[C.PARTNERS].insert_one(doc)
    except DuplicateKeyError as exc:
        raced = await db[C.PARTNERS].find_one({"_id": pid})
        if raced is not None:
            # Another caller won the race on the partner record itself. One
            # record exists, which is the point. The claim stays: it now
            # names the human who holds this family, which is true either way.
            return raced, False, []
        # Not the `_id` index, then — the only other unique index on this
        # collection is `crm_id`, and two partners cannot share one.
        clash = await db[C.PARTNERS].find_one({"crm_id": doc.get("crm_id")})
        if enforce_role_family and owner_uid:
            await partner_roles.release_role_family(owner_uid, doc["kind"])
        raise PartnerOpsError(
            f"CRM id '{doc.get('crm_id')}' already belongs to partner "
            f"'{clash['_id'] if clash else 'unknown'}'. Two partners cannot "
            "share one CRM id, so nothing was created — fix the duplicate crmId "
            "in Firestore first."
        ) from exc
    except Exception:
        # The claim is a lock, not a record. Leaving one behind after a failed
        # insert would bar this person from ever holding the family — a worse
        # outcome than the duplicate it exists to prevent.
        if enforce_role_family and owner_uid:
            await partner_roles.release_role_family(owner_uid, doc["kind"])
        raise

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

    # ── THE FIRESTORE DOCUMENT LEARNS ITS OWNER TOO ─────────────────────────
    #
    # `onAgencyApproved` in the Functions reads `ownerUid` off the agency
    # document to address the approval notice, and `/agency-signup` never
    # wrote that field — only `crmUid`, and only after the trigger had already
    # fired. Mirroring the resolved uid back as `ownerUid` means every record
    # that reached Mongo with a human attached carries that human on both
    # sides, whichever field the form happened to write. Best effort, like
    # every replica write here; the Mongo record is already authoritative.
    if owner_uid and not str(source.get("ownerUid") or "").strip():
        await asyncio.to_thread(_sync_partner_doc, doc, {"ownerUid": owner_uid})

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
      * the address belongs to somebody else — a staff account, or a
        `crmUsers` document naming a different partner;
      * the human behind the address already holds a record in this record's
        ROLE FAMILY. This is the one-agency-per-human rule, and linking is the
        second way a human becomes an agency's owner: creating claims the
        family, and now so does attaching. One agency-family record (Agency
        *or* Sub-agency) plus one Coin Seller — so an agency owner may be
        given a coin-seller login, and may not be given a second agency.

    Every check but the last runs before the Firebase account is resolved. The
    family claim needs the uid, so it runs immediately after — before anything
    on the partner record is written, and released again if that write fails.
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

    # ── LINKING IS GOVERNED BY THE SAME RULE AS CREATING ────────────────────
    #
    # This is the moment a partner record acquires a human, and until now it
    # was the one such moment the one-agency-per-human rule did not reach.
    # Creating a record claims the family (`ensure_partner_record`); linking
    # an already-created one did not, so an unlinked agency could be attached
    # to somebody who already ran one — the duplicate this whole fix exists
    # to prevent, arriving through a different door.
    #
    # WHAT THIS REPLACES, AND WHY IT WAS WRONG. The check here was:
    #
    #     clash = await db[C.PARTNERS].find_one({"owner_crm_uid": uid})
    #     if clash is not None and str(clash["_id"]) != pid: refuse
    #
    # which refuses if the uid holds ANY other partner record. Its own
    # message said "a login holds at most one agency record and one seller
    # record" — the correct rule — but the code refused the second of those
    # outright. An agency being given a coin-seller login, or the reverse,
    # was rejected with a message describing it as permitted. The combination
    # the business requires was unreachable through this route.
    #
    # `claim_role_family` is the rule, in one place, for both doors: one
    # agency-family record (Agency *or* Sub-agency) per human, plus one Coin
    # Seller, enforced by `_id` uniqueness so two simultaneous links cannot
    # both win. Re-affirming a claim this same record already holds is not a
    # conflict and returns quietly.
    try:
        await partner_roles.claim_role_family(
            uid, str(partner.get("kind", "")), pid, actor=actor
        )
    except partner_roles.RoleConflict as exc:
        raise PartnerOpsError(str(exc)) from exc

    # B16: and the REST of the role table, exactly as approval applies it — the
    # lock alone let a Host be given an agency's login, or a Coin Seller a
    # second seller's. Run after the claim so a family conflict keeps its own
    # sentence; a refusal here gives the claim straight back. The guest rule is
    # not applied: the login being attached is created by staff, which is not
    # the app-guest case that rule exists for.
    from app.services import partner_applications as apps  # local: apps imports this module

    try:
        await apps.recheck_at_decision(
            uid, str(partner.get("kind", "")), exclude_partner_id=pid, ignore_guest=True,
            # RC role rule: the same parent pin approval applies.
            parent_id=(str(partner.get("parent_id") or "")
                       if str(partner.get("kind", "")) == str(PartnerKind.SUB_AGENCY) else ""),
        )
    except apps.ApplicationError as exc:
        await partner_roles.release_role_family(uid, str(partner.get("kind", "")))
        raise PartnerOpsError(
            str(exc).replace(" Nothing was approved.", "") + " No login was attached."
        ) from exc

    # ── The grant. Mongo first, audited immediately. ─────────────────────────
    #
    # Everything from here to the end of the audit entry runs under a
    # rollback: the claim was taken above, and a failure after it that left
    # it standing would bar this human from ever holding the family — worse
    # than the duplicate it prevents, and silent.
    now = _now()
    try:
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
        if updated is None:
            # The record went away between `_partner(pid)` above and here.
            # Nothing was linked, so the claim must not stand.
            raise PartnerOpsError(
                f"Partner '{pid}' no longer exists, so no login was attached "
                "and nothing was changed."
            )
    except Exception:
        await partner_roles.release_role_family(uid, str(partner.get("kind", "")))
        raise

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


async def _other_live_role(partner: dict) -> bool:
    """Does this partner's login hold ANOTHER approved, active record?

    Decides `crmUsers.isActive` when one of a dual-role login's capabilities
    is refused, suspended or revoked. `isActive` is per LOGIN: it gates the
    CRM shell, and `syncStorageRoleClaim` clears the Storage claim when it is
    false. Writing it from the status of the one record being decided —
    which is what happened before — meant that revoking the Agency from an
    Agency + Coin Seller human switched off the seller's portal and their KYC
    document access as collateral. The spec's own example: "Seller remains
    active". So it is computed across every record the login holds, in the
    async context, and handed to `_mirror_login_status`.
    """
    uid = str(partner.get("owner_crm_uid") or "").strip()
    if not uid:
        return False
    pid = str(partner.get("_id") or "")
    cursor = get_db()[C.PARTNERS].find(
        {"owner_crm_uid": uid, "status": str(PartnerStatus.APPROVED), "is_active": True}
    )
    async for row in cursor:
        if str(row.get("_id") or "") != pid:
            return True
    return False


async def _mirror_login(partner: dict, status: str) -> bool:
    """`_mirror_login_status`, with the other-live-role fact resolved first —
    then the app's role flags pushed from the updated login document, so the
    Android Agency / Seller tag follows the decision immediately rather than
    at the person's next sign-in."""
    other = await _other_live_role(partner)
    ok = await asyncio.to_thread(_mirror_login_status, partner, status, other)
    uid = await asyncio.to_thread(_login_uid_of, partner)
    if uid:
        note = await asyncio.to_thread(crm.push_app_role_flags, uid)
        if note:
            log.warning("Partner %s: %s", partner.get("_id"), note)
    return ok


def _mirror_login_status(partner: dict, status: str, other_live_role: bool = False) -> bool:
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
    # FX-04: a login document with no `role` is "not usable" to every reader of
    # role flags, so an approval that created (or met) one never reached the
    # app (RF-01). When the document names no role yet, it is given the one
    # this decision is about — `roles` too — and never over a role it has.
    try:
        existing_login = _read_crm_user(uid)
    except Exception:  # noqa: BLE001 — unknown: write the status as before
        existing_login = None
    if existing_login is not None and not str(existing_login.get("role") or "").strip():
        fields["role"] = name
        held = [r for r in (existing_login.get("roles") or []) if r]
        fields["roles"] = held + ([name] if name not in held else [])
        link_field = "sellerId" if name == "seller" else "agencyId"
        if not str(existing_login.get(link_field) or "").strip():
            fields[link_field] = str(partner.get("_id") or "")
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
                #
                # `status` is the LOGIN's: refusing, suspending or revoking one
                # capability while another is live must not route the person
                # to the waiting room for the one they still run. Their
                # per-capability `roleStatus` carries the refusal.
                "status": status if (other_live_role is False or status == str(PartnerStatus.APPROVED)) else str(PartnerStatus.APPROVED),
                **fields,
                # The LOGIN stays active while any of its capabilities is
                # live. See `_other_live_role`.
                "isActive": status in (
                    str(PartnerStatus.APPROVED), "approved",
                    # Decision 15 (RC): approved, waiting for verified contacts.
                    # The login must still sign in — to the waiting room, where
                    # the verification is done — so it stays active; its
                    # per-capability `roleStatus` grants nothing.
                    str(PartnerStatus.AWAITING_VERIFICATION),
                )
                or other_live_role,
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


async def _refuse_single_role_revocation(partner: dict) -> None:
    """UGP-B: ONE active role → suspend, never a separate revoke. Raises PartnerOpsError.

    Counted from the authoritative records — every `partners` row the owner
    holds approved or suspended, plus Host — through `user_roles`, the same
    count the CRM renders from. A record with no owner is a person holding
    exactly this one role.
    """
    from app.services import user_roles  # local: user_roles imports partner helpers lazily

    kind = str(partner.get("kind") or "")
    pid = str(partner.get("_id") or "")
    uid = await partner_roles.owner_uid_of(partner, db=get_db())  # B07
    count, counted_ids = 0, set()
    if uid:
        inv = await user_roles.role_inventory(uid, db=get_db())
        count = inv["held_count"]
        counted_ids = {r.get("id") for r in inv["roles"] if r.get("role") != "host"}
    if pid not in counted_ids and str(partner.get("status") or "") in user_roles.HELD_PARTNER_STATUSES:
        count += 1
    if count < 2:
        raise PartnerOpsError(
            user_roles.SINGLE_ROLE_REFUSAL.format(label=user_roles.ROLE_LABELS.get(kind, "This role"))
            + " Nothing was revoked."
        )


async def _refuse_restricted_owner(partner: dict, *, doing: str = "restoring this role") -> None:
    """UGP review: a role is not RESTORED onto a banned or suspended account.

    The rule `users.restore_host` already applies to a Host; reactivating a
    suspended or revoked partner record — directly, or through Approve, which
    delegates here — is the same act for the other roles. Lift the account's
    restriction first. A record whose owner has no app account has no account
    restriction to respect.

    FX-09: a FIRST approval is held to the same rule (`doing` names the act in
    the refusal) — granting a role to a suspended or banned account is no
    different from restoring one onto it.
    """
    uid = await partner_roles.owner_uid_of(partner, db=get_db())  # B07
    if not uid:
        return
    from app.services import users as users_svc  # local: users imports this module's peers

    try:
        owner = await users_svc.load_user(uid)
    except users_svc.UserNotFound:
        return
    if users_svc.restriction_of(owner):
        raise PartnerOpsError(
            "The owner's account is restricted. Lift the suspension or ban before "
            f"{doing}. Nothing was changed."
        )


async def _recheck_sub_agency_parent(partner: dict) -> None:
    """UGP-G: a sub-agency is approved or restored only under a LIVE main agency.

    The parent was validated when the record was created; it can have been
    suspended or revoked since, and approving a sub-agency under it would hang
    a live business off a dead one.
    """
    if str(partner.get("kind") or "") != str(PartnerKind.SUB_AGENCY):
        return
    try:
        await _validate_parent_agency(
            str(partner.get("parent_id") or ""),
            await partner_roles.owner_uid_of(partner, db=get_db()),  # B07
        )
    except PartnerOpsError as exc:
        raise PartnerOpsError(
            "This sub-agency's main agency cannot take it right now — "
            + str(exc).replace(" Nothing was created.", "")
            + " Nothing was changed."
        ) from exc


async def _enforce_role_rules_at_decision(
    partner: dict, actor: dict, *, ignore_guest: bool = False
) -> None:
    """Approval and reactivation re-check the role rules. Raises PartnerOpsError.

    1. The role table, against what the person holds NOW (not when they
       applied) — Host + Agency, Agency + Sub-agency and the rest stay
       impossible even if two applications were filed at once.
    2. The one-agency-family lock, through `partner_roles.claim_role_family` —
       the same lock creation takes. A REVOKED record's slot was released when
       it was revoked; approving or reactivating it must take the slot again,
       and is refused if another live agency-family record now holds it.

    Skipped only for a record that names no login yet: there is no human to
    apply a per-human rule to (it is applied when a login is attached).

    B07: the human is resolved from `owner_crm_uid`, falling back to the
    Firestore document's `crmUid` / `ownerUid` (and persisted when found), so a
    record whose Mongo link was never written is still held to the rules.
    C1: a REVOKED record of the same kind is part of what the person holds, so
    approving a NEW record of a revoked kind is refused with REVOKED_REFUSAL.
    """
    uid = await partner_roles.owner_uid_of(partner, db=get_db())
    kind = str(partner.get("kind") or "")
    pid = str(partner.get("_id") or "")
    if not uid or partner_roles.family_of(kind) is None:
        return
    from app.services import partner_applications as apps  # local: apps imports this module

    # `ignore_guest`: Decision 15 (RC) — where the both-contacts gate decides
    # contacts (a first approval, an activation, a restoration), the older
    # one-contact guest rule is not asked a second, weaker question.
    await apps.recheck_at_decision(
        uid, kind, exclude_partner_id=pid, ignore_guest=ignore_guest,
        # RC role rule: a Sub-agency sits only under the main agency its
        # holder is a Host under (when they are one).
        parent_id=str(partner.get("parent_id") or "") if kind == str(PartnerKind.SUB_AGENCY) else "",
    )
    try:
        await partner_roles.claim_role_family(uid, kind, pid, actor=actor, decision=True)
    except partner_roles.RoleConflict as exc:
        raise PartnerOpsError(str(exc)) from exc


async def approve_partner(
    partner_id: str,
    reason: str,
    actor: dict,
    kind: PartnerKind | None = None,
) -> dict:
    """Approve an application. The account becomes approved and active.

    No owner signature: nothing moves at approval, so this is skilled team work
    rather than a money decision (9.2).

    **Decision 15 (RC): approval is not activation.** The role starts only
    when the login holds BOTH a verified phone and a verified email
    (`services/contact_verification`). Without both, only the Owner may
    approve; the record then waits in `awaiting_verification` — approved,
    holding its slot, granting nothing — and `activate_partner_if_verified`
    starts it, audited, once both are verified. Anyone else gets a
    machine-readable `CONTACT_VERIFICATION_REQUIRED` refusal.

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

    # Decision 15 (RC): already approved by the Owner and waiting for verified
    # contacts. "Approve" again is only the activation check — it never starts
    # the role around the verification.
    if str(partner.get("status") or "") == str(PartnerStatus.AWAITING_VERIFICATION):
        return await activate_partner_if_verified(partner_id, actor, reason=reason)

    # UGP-B: ONE restore path. A suspended or revoked record was approved once;
    # "Approve" on it used to re-run first-approval side effects (referral
    # code, virtual account, second role, the "approved" notice and email). It
    # is a restoration, so it goes through `reactivate_partner` — the same
    # record, re-checked against the role table, with the restore notice.
    if str(partner.get("status") or "") in (
        str(PartnerStatus.SUSPENDED), str(PartnerStatus.REVOKED)
    ):
        restored = await reactivate_partner(partner_id, reason, actor)
        restored["restored"] = True
        return restored

    # ── FX-09: A FIRST APPROVAL NEEDS A LOGIN, AND AN UNRESTRICTED ONE ──────
    #
    # A record that names no login is a business nobody is held to: the
    # one-agency-per-person rule and the contact rule both skip it
    # (`_enforce_role_rules_at_decision` returns early), so approving it made
    # it live with no check at all. Attach a login first — attach-login runs
    # the full re-check — then approve. And a suspended or banned owner is not
    # granted a role, exactly as one is not restored onto them.
    if not await partner_roles.owner_uid_of(partner, db=get_db()):
        raise PartnerOpsError(
            "This record names no login, so nobody can be held to the "
            "one-agency-per-person rule or the contact rule. Attach a login "
            "first (Attach login on the record), then approve. Nothing was approved."
        )
    await _refuse_restricted_owner(partner, doing="approving it")

    await _enforce_role_rules_at_decision(partner, actor, ignore_guest=True)
    await _recheck_sub_agency_parent(partner)

    # ── Decision 15 (RC): approval is not activation ────────────────────────
    #
    # The role STARTS only when the login holds both a verified phone and a
    # verified email (`services/contact_verification`). With both, this is
    # the approval it always was. Without both, only the Owner may approve,
    # and the record waits — approved, holding its slot, granting nothing —
    # until `activate_partner_if_verified` starts it. Anyone else is told
    # what is missing, machine-readably.
    login_uid = await partner_roles.owner_uid_of(partner, db=get_db())
    verification = await asyncio.to_thread(contact_verification.status, login_uid)
    if not verification.complete:
        if not _is_owner(actor):
            raise ContactVerificationRequired(
                verification,
                "This role can start only once the applicant's login has BOTH a verified "
                "phone number and a verified email address"
                f" (missing: {', '.join(verification.missing)}). The Owner can approve it now, "
                "and it will start by itself as soon as both are verified. Nothing was approved.",
            )
        return await _approve_pending_verification(
            partner, reason, actor, verification,
            record_created=record_created, warnings=warnings,
        )

    return await _start_role(
        partner, reason, actor,
        expect_status=str(partner.get("status") or ""),
        action=audit.Action.PARTNER_APPROVED,
        record_created=record_created,
        warnings=warnings,
    )


class ContactVerificationRequired(PartnerOpsError):
    """Decision 15: both contacts are not verified yet. Carries the machine-readable detail."""

    def __init__(self, verification: "contact_verification.Verification", message: str):
        super().__init__(message)
        self.verification = verification

    def api_detail(self) -> dict:
        return contact_verification.refusal_detail(self.verification, str(self))


async def _approve_pending_verification(
    partner: dict,
    reason: str,
    actor: dict,
    verification: "contact_verification.Verification",
    *,
    record_created: bool,
    warnings: list[str],
) -> dict:
    """Decision 15 — the Owner approved; the role waits for verified contacts.

    The record is APPROVED in substance (`approved_at`, `approved_by`, the
    documents decided) but its status is `awaiting_verification` and it is
    inactive, so every privilege check that requires `approved` refuses it.
    The login stays signable, in the waiting room, so the person can verify.
    No referral code, no virtual account, no second-role grant, no "you're
    live" notice: those belong to the start of the role.
    """
    pid = str(partner["_id"])
    kind = str(partner.get("kind") or "")
    has_documents = await asyncio.to_thread(_has_kyc_documents, partner)
    now = _now()
    before = {"status": partner.get("status"), "is_active": partner.get("is_active", False)}
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": pid, "status": partner.get("status")},
        {
            "$set": {
                "status": str(PartnerStatus.AWAITING_VERIFICATION),
                "is_active": False,
                "approved_at": now,
                "approved_by": _who(actor),
                "approval_reason": reason,
                "activation": {
                    "state": str(PartnerStatus.AWAITING_VERIFICATION),
                    "missing": verification.missing,
                    "approved_at": now,
                    "approved_by": _who(actor),
                },
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError(
            "This record changed while it was being approved. Reload it and try again."
        )

    await audit.record(
        actor=actor,
        action=Act.PARTNER_APPROVED_PENDING_VERIFICATION,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.AWAITING_VERIFICATION), "is_active": False},
        meta={"kind": kind, "missing": verification.missing},
    )
    # The waiting room must show the new state, so the old session goes.
    await _revoke_partner_sessions(updated)

    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(
                kind, PartnerStatus.AWAITING_VERIFICATION, False,
                verified_documents=has_documents,
            ),
            "approvedAt": now,
            "approvedBy": actor.get("uid", ""),
            "rejectionReason": "",
            "activationPending": verification.missing,
        },
    )
    login_synced = await _mirror_login(updated, str(PartnerStatus.AWAITING_VERIFICATION))

    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    out["awaiting_verification"] = True
    out["missing"] = verification.missing
    out["partner_record_created"] = record_created
    out["warnings"] = warnings + [
        "Approved, but the role has NOT started: the login still needs a verified "
        + " and a verified ".join(verification.missing)
        + ". It starts by itself once both are verified."
    ]
    out["notified"] = await _notify_owner(
        updated,
        lambda uid, k, p: notices.partner_awaiting_verification(uid, k, p, verification.missing),
    )
    return out


async def hold_for_verification(partner_id: str, reason: str, actor: dict) -> dict:
    """D17 — an ACTIVE legacy role whose login lacks a verified phone or email waits.

    Decision 15 holds a NEW approval in `awaiting_verification` until both
    contacts are verified; D17 applies the same state to roles that started
    before the rule existed. The state is exactly the D15 one — inactive, so
    every privilege check that requires `approved` refuses it; the login stays
    signable, in the waiting room — and the way back is the D15 way back:
    `activate_partner_if_verified`, which re-reads the verification and starts
    the role again (its referral code and virtual account are `_ensure_*`, so
    nothing is minted twice). The original approval stays the approval on
    record; the hold is written beside it.

    Refused unless the record is APPROVED and ACTIVE and its login really does
    lack a verified contact — re-read here, never taken from a plan. The move is
    conditional on the status, so a record that changed since it was read is
    left alone. Only `scripts/d17_legacy_partners.py --apply` calls this, after
    the dry-run was reviewed and approved.
    """
    partner = await _partner(partner_id)
    pid = str(partner["_id"])
    kind = str(partner.get("kind") or "")
    if kind not in (str(PartnerKind.AGENCY), str(PartnerKind.SUB_AGENCY), str(PartnerKind.SELLER)):
        raise PartnerOpsError(f"{pid} is a {kind or 'record'}; only an agency, sub-agency or seller is held here.")
    if str(partner.get("status") or "") != str(PartnerStatus.APPROVED) or not partner.get("is_active", False):
        raise PartnerOpsError(f"{pid} is not an approved, active role; nothing to hold.")
    reason = _require_reason(reason)
    login_uid = await partner_roles.owner_uid_of(partner, db=get_db())
    if not login_uid:
        raise PartnerOpsError(f"{pid} has no login attached; there is nobody who could verify.")
    verification = await asyncio.to_thread(contact_verification.status, login_uid)
    if verification.complete:
        raise PartnerOpsError(f"{pid}: both contacts are verified on the login; nothing to hold.")

    has_documents = await asyncio.to_thread(_has_kyc_documents, partner)
    now = _now()
    before = {"status": partner.get("status"), "is_active": partner.get("is_active", False)}
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": pid, "status": str(PartnerStatus.APPROVED), "is_active": True},
        {
            "$set": {
                "status": str(PartnerStatus.AWAITING_VERIFICATION),
                "is_active": False,
                "activation": {
                    "state": str(PartnerStatus.AWAITING_VERIFICATION),
                    "missing": verification.missing,
                    "held_at": now,
                    "held_by": _who(actor),
                    "held_reason": reason,
                },
                "updated_at": now,
            }
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError(f"{pid} changed while it was being held. Nothing was changed.")

    await audit.record(
        actor=actor,
        action=Act.PARTNER_HELD_FOR_VERIFICATION,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.AWAITING_VERIFICATION), "is_active": False},
        meta={"kind": kind, "missing": verification.missing, "migration": "D17"},
    )
    # The capability is gone, so the session that carried it goes too.
    await _revoke_partner_sessions(updated)
    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(kind, PartnerStatus.AWAITING_VERIFICATION, False,
                                verified_documents=has_documents),
            "activationPending": verification.missing,
        },
    )
    login_synced = await _mirror_login(updated, str(PartnerStatus.AWAITING_VERIFICATION))
    out = _public(updated)
    out["held"] = True
    out["missing"] = verification.missing
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    out["notified"] = await _notify_owner(
        updated,
        lambda uid, k, p: notices.partner_held_for_verification(uid, k, p, verification.missing),
    )
    return out


async def activate_partner_if_verified(partner_id: str, actor: dict, *, reason: str = "") -> dict:
    """Decision 15 — start an approved role once both contacts are verified.

    The ONLY way out of `awaiting_verification`. Verification is re-read from
    the authoritative sources (never trusted from the caller), the person's
    restriction and the role table are re-checked as at any approval, and the
    move is conditional on the status — so two simultaneous calls start the
    role once. A role that already started is returned as it is.
    """
    partner = await _partner(partner_id)
    status = str(partner.get("status") or "")
    if status == str(PartnerStatus.APPROVED) and partner.get("is_active", False):
        out = _public(partner)
        out["activated"] = False
        out["already_active"] = True
        return out
    if status != str(PartnerStatus.AWAITING_VERIFICATION):
        raise PartnerOpsError("This role is not waiting for contact verification.")

    login_uid = await partner_roles.owner_uid_of(partner, db=get_db())
    verification = await asyncio.to_thread(contact_verification.status, login_uid)
    if not verification.complete:
        raise ContactVerificationRequired(
            verification,
            "The role starts once both a verified phone number and a verified email "
            f"address are on the login (missing: {', '.join(verification.missing)}).",
        )
    await _refuse_restricted_owner(partner, doing="starting it")
    await _enforce_role_rules_at_decision(partner, actor, ignore_guest=True)
    await _recheck_sub_agency_parent(partner)
    await asyncio.to_thread(contact_verification.record_phone, login_uid, verification.phone)

    trigger = str(actor.get("triggered_by") or "").strip()
    default_reason = "Both contacts verified; the role approved earlier has started." + (
        f" Checked at the request of account {trigger}." if trigger else ""
    )
    try:
        out = await _start_role(
            partner,
            reason or default_reason,
            actor,
            expect_status=str(PartnerStatus.AWAITING_VERIFICATION),
            action=Act.PARTNER_ACTIVATED,
            record_created=False,
            warnings=[],
        )
    except PartnerOpsError:
        # A concurrent call started it first: that is success, said once.
        now_row = await _partner(partner_id)
        if str(now_row.get("status") or "") == str(PartnerStatus.APPROVED) and now_row.get("is_active", False):
            out = _public(now_row)
            out["activated"] = False
            out["already_active"] = True
            return out
        raise
    out["activated"] = True
    return out


async def activate_for_login(uid: str, actor: dict) -> list[dict]:
    """Decision 15 — start every awaiting role of this login whose contacts are verified."""
    uid = str(uid or "").strip()
    results: list[dict] = []
    if not uid:
        return results
    async for row in get_db()[C.PARTNERS].find(
        {"owner_crm_uid": uid, "status": str(PartnerStatus.AWAITING_VERIFICATION)}
    ):
        pid = str(row.get("_id") or "")
        try:
            results.append(await activate_partner_if_verified(pid, actor))
        except PartnerOpsError as exc:
            detail = getattr(exc, "api_detail", None)
            results.append({"id": pid, "activated": False,
                            "refusal": detail() if callable(detail) else str(exc)})
    return results


async def _start_role(
    partner: dict,
    reason: str,
    actor: dict,
    *,
    expect_status: str,
    action: str,
    record_created: bool,
    warnings: list[str],
) -> dict:
    """The role starts: status approved and active, and everything that follows.

    Shared by a first approval with verified contacts and by the activation of
    a record the Owner approved earlier (Decision 15). One body, so the two
    can never drift: the same session sweep, replicas, referral code, login
    mirror, virtual account, second-role grant and notice.
    """
    partner_id = str(partner["_id"])
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
    # B17: conditional on the status read above. A concurrent decision that
    # moved the record first leaves this matching nothing, and it stops here —
    # before the audit row, the session sweep, the replicas and the notice.
    starting_awaited = expect_status == str(PartnerStatus.AWAITING_VERIFICATION)
    stamp: dict = {
        "status": str(PartnerStatus.APPROVED),
        "is_active": True,
        "updated_at": now,
    }
    if starting_awaited:
        # Decision 15: the Owner's approval stays the approval on record; this
        # is when the role STARTED, and who (or what) started it.
        stamp.update({
            "activated_at": now,
            "activated_by": _who(actor),
            "activation.state": "started",
            "activation.started_at": now,
        })
    else:
        stamp.update({
            "approved_at": now,
            "approved_by": _who(actor),
            "approval_reason": reason,
        })
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id, "status": expect_status},
        {"$set": stamp},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError(
            "This record changed while it was being approved. Reload it and try again."
        )

    await audit.record(
        actor=actor,
        action=action,
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

    from firebase_admin import firestore as _fb_fs  # local: the stubbed module in tests

    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(
                partner.get("kind", ""),
                PartnerStatus.APPROVED,
                True,
                verified_documents=has_documents,
            ),
            **(
                {"activatedAt": now, "activatedBy": actor.get("uid", ""),
                 "activationPending": _fb_fs.DELETE_FIELD}
                if starting_awaited else
                {"approvedAt": now, "approvedBy": actor.get("uid", "")}
            ),
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
    login_synced = await _mirror_login(updated or partner, str(PartnerStatus.APPROVED))

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

    # ── Tell the person. LAST, and never a reason for the above to fail. ────
    out["notified"] = await _notify_owner(
        updated or partner,
        lambda uid, kind, pid: notices.partner_approved(
            uid, kind, pid,
            next_step=(
                "Share your referral code with hosts to start onboarding."
                if str(kind) != str(PartnerKind.SELLER) else
                "You can now receive recharge requests from buyers."
            ),
        ),
    )
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
    # UGP-B: reject is the decision on an APPLICATION. On an approved,
    # suspended or revoked record it was an unguarded revocation — no dependents
    # check, no one-role rule — that overwrote the record's status.
    if str(partner.get("status") or str(PartnerStatus.PENDING)) != str(PartnerStatus.PENDING):
        raise PartnerOpsError(
            f"Only a pending application can be rejected; this one is "
            f"{partner.get('status')}. Use Suspend, Revoke or Restore instead."
        )

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    # B17: conditional on the (pending) status read above; on no match nothing
    # else happens.
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id, "status": partner.get("status")},
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
    if updated is None:
        raise PartnerOpsError(
            "This application changed while it was being rejected. Reload it and try again."
        )

    # Decision 16 (RC): rejection releases the registration slot. The record
    # and its decision history stay exactly as they are; a fresh application
    # (including under the same Agency) is a NEW record that takes the slot.
    slot_released = False
    owner_for_slot = await partner_roles.owner_uid_of(updated or partner, db=get_db())
    if owner_for_slot:
        slot_released = await partner_roles.release_claim_of(
            owner_for_slot, str(partner.get("kind") or ""), partner_id
        )

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_REJECTED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.REJECTED), "rejection_reason": reason},
        meta={"kind": partner.get("kind"), "slot_released": slot_released},
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
    login_synced = await _mirror_login(updated or partner, str(PartnerStatus.REJECTED))
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

    out["notified"] = await _notify_owner(
        updated or partner,
        lambda uid, kind, pid: notices.partner_rejected(uid, kind, pid, reason),
    )
    return out


async def deactivate_partner(partner_id: str, reason: str, actor: dict) -> dict:
    """Suspend an active partner. The record is kept — history stays attributable."""
    reason = _require_reason(reason)
    partner = await _partner(partner_id)

    if not partner.get("is_active", False) and partner.get("status") == str(
        PartnerStatus.SUSPENDED
    ):
        raise PartnerOpsError("This partner is already deactivated.")
    # UGP review: only a role that is HELD can be suspended. Suspending a
    # pending, rejected or revoked record turned it into a "suspended" one —
    # which counts as held (so the one-role rule could be walked round) and
    # which Restore then made approved without the approval's checks.
    status_now = str(partner.get("status") or "")
    if status_now != str(PartnerStatus.APPROVED):
        raise PartnerOpsError({
            str(PartnerStatus.PENDING): "This application has not been approved, so there is nothing to suspend. Reject it instead.",
            str(PartnerStatus.REJECTED): "This application was rejected, so there is nothing to suspend.",
            str(PartnerStatus.REVOKED): "This role was revoked, so there is nothing to suspend.",
        }.get(status_now, f"Only an approved partner can be suspended (this one is '{status_now or 'unknown'}')."))

    # RC (confirmed, CRM-FLOW 9.48): a role suspension freezes this record's
    # pending money for the Owner's review, first. Restoring does not release it.
    await money_freeze.freeze_partner(
        partner_id, row=partner, cause="role_suspended", label="a role suspension",
        reason=reason, actor=actor, db=get_db(),
    )

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    # Conditional on the status just checked, so a decision racing this one
    # (a revoke, a reject) is not overwritten by a suspension.
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id, "status": str(PartnerStatus.APPROVED)},
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
    if updated is None:
        raise PartnerOpsError("This record changed while it was being suspended. Reload it and try again.")

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
    login_synced = await _mirror_login(updated or partner, str(PartnerStatus.SUSPENDED))
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    # A suspension that leaves the current token working is a suspension that
    # starts in up to seven days. See `_revoke_partner_sessions`.
    out["sessions_revoked"] = await _revoke_partner_sessions(updated or partner)
    out["notified"] = await _notify_owner(
        updated or partner,
        lambda uid, kind, pid: notices.partner_suspended(uid, kind, pid, reason),
    )
    return out


async def reactivate_partner(partner_id: str, reason: str, actor: dict) -> dict:
    """Lift a suspension, or — Owner only — restore a revoked role.

    Only a partner that was approved once can come back, and it comes back as
    the SAME record. A role-level suspension keeps the permission it always
    had; a REVOKED record is the Owner's decision (C2), whether it arrives
    here directly, through Approve (which delegates here), or from a decided
    reinstatement request.
    """
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
    # Decision 15 (RC): an Owner-approved role WAITING for verified contacts was
    # never started, so there is nothing to restore — and "restoring" it here
    # would start it around the verification. Restore on it is the activation
    # check, exactly like Approve: it starts only if both contacts are verified.
    if str(partner.get("status") or "") == str(PartnerStatus.AWAITING_VERIFICATION):
        return await activate_partner_if_verified(partner_id, actor, reason=reason)
    # UGP-B: restoring is for a role that was held. A pending record was never
    # approved; "reactivating" it approved it without the approval's checks.
    if str(partner.get("status") or str(PartnerStatus.PENDING)) == str(PartnerStatus.PENDING):
        raise PartnerOpsError(
            "This application has not been approved yet, so there is nothing to "
            "restore. Approve it instead."
        )
    if partner.get("status") == str(PartnerStatus.REVOKED) and not _is_owner(actor):
        raise PartnerOpsForbidden(OWNER_ONLY_RESTORE)

    await _refuse_restricted_owner(partner)
    await _enforce_role_rules_at_decision(
        partner, actor,
        ignore_guest=str(partner.get("status") or "") == str(PartnerStatus.REVOKED),
    )
    await _recheck_sub_agency_parent(partner)

    # Decision 15 (RC): restoring a REVOKED role starts it again, so the login
    # must hold both verified contacts, exactly as at a first approval. (Lifting
    # a temporary suspension is not a new start and is not gated here — see
    # the RC report, INV-13.) The Owner cannot restore around it: there is no
    # "restore pending verification" state for a revoked role.
    if str(partner.get("status") or "") == str(PartnerStatus.REVOKED):
        login_uid = await partner_roles.owner_uid_of(partner, db=get_db())
        verification = await asyncio.to_thread(contact_verification.status, login_uid)
        if not verification.complete:
            raise ContactVerificationRequired(
                verification,
                "Restoring this role needs BOTH a verified phone number and a verified email "
                f"address on the login (missing: {', '.join(verification.missing)}). "
                "Nothing was restored.",
            )
    # `kycStatus: approved` only when there are documents behind it — the same
    # rule approval applies (I-3: restoration used to write it unconditionally).
    has_documents = await asyncio.to_thread(_has_kyc_documents, partner)

    now = _now()
    before = {
        "status": partner.get("status"),
        "is_active": partner.get("is_active", False),
    }
    # B17: conditional on the status read above (suspended or revoked).
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id, "status": partner.get("status")},
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
    if updated is None:
        raise PartnerOpsError(
            "This record changed while it was being restored. Reload it and try again."
        )

    await audit.record(
        actor=actor,
        action=Act.PARTNER_REACTIVATED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.APPROVED), "is_active": True},
        meta={"kind": partner.get("kind"), "restored_from": partner.get("status")},
    )

    synced = _sync_partner_doc(
        updated,
        _fs_status_fields(
            partner.get("kind", ""), PartnerStatus.APPROVED, True,
            verified_documents=has_documents,
        ),
    )
    login_synced = await _mirror_login(updated or partner, str(PartnerStatus.APPROVED))
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    # B39: the restored capability is not on any session issued while it was
    # withdrawn — `partner_ids` is stamped at sign-in. Revoking those sessions
    # sends the CRM back through sign-in, which mints one carrying it, exactly
    # as approval does.
    out["sessions_revoked"] = await _revoke_partner_sessions(updated or partner)
    out["notified"] = await _notify_owner(
        updated or partner,
        lambda uid, kind, pid: notices.partner_reactivated(uid, kind, pid),
    )
    # FX-13 (RF-20): restoring a REVOKED role closes the person's open
    # reinstatement request for it (one being decided right now is left to
    # its own decision). Lifting a suspension is not a reinstatement.
    out["closed_requests"] = []
    if partner.get("status") == str(PartnerStatus.REVOKED):
        from app.services import role_appeals  # local: role_appeals imports this module's peers

        owner = await partner_roles.owner_uid_of(partner, db=get_db())
        out["closed_requests"] = await role_appeals.close_after_direct_restore(
            owner, str(partner.get("kind") or ""), actor
        )
    return out


async def _notify_owner(partner: dict, send) -> bool:
    """Deliver a lifecycle notice to the human behind a partner record.

    `send(uid, kind, partner_id)` is one of the `notices.partner_*` writers.
    The uid is `owner_crm_uid` — the authoritative owner — falling back to
    the Firestore document's `crmUid`/`ownerUid` for records that predate
    ownership being written at creation. A record with no human attached
    returns False; there is nobody to tell, and `attach_login` is the repair.

    Never raises: the decision is committed and audited by the time this runs.
    """
    try:
        uid = await asyncio.to_thread(_login_uid_of, partner)
        if not uid:
            return False
        return bool(
            await send(uid, str(partner.get("kind") or ""), str(partner.get("_id") or ""))
        )
    except Exception:  # noqa: BLE001
        log.exception("lifecycle notice for partner %s was not delivered", partner.get("_id"))
        return False


# ══════════════════════════════════════════════════════════════════════════════
# 4a. Revocation — the role taken away, the human left standing
# ══════════════════════════════════════════════════════════════════════════════
#
# "Deactivate" writes `suspended`, keeps the record, and — because `suspended`
# keeps its place in the one-agency-per-human rule — barred the person from
# ever applying again. That is the right behaviour for a suspension and the
# wrong one for the thing staff were actually using it for, which was ending
# the relationship. There was no other button.
#
# Revocation is the ending. It is NOT:
#
#   * suspending the person's account — that is `users.suspend_user`, moderation;
#   * banning them — `users.ban_user`;
#   * deleting anything — the record, the ledger, the audit trail, the KYC
#     documents and the commission history all stay exactly as they are.
#
# It IS: this one partner record goes to `revoked` and inactive; its sessions
# are revoked; its role-family slot is KEPT (C1 — a revoked role still counts
# for the combination rules, and coming back is a reinstatement request the
# Owner decides, restoring this same record); the login stays active if it
# holds another live capability (Agency + Coin Seller → revoke the Agency →
# the Seller portal still opens); and the person is told, with the reason.
#
# ── DEPENDENTS ─────────────────────────────────────────────────────────────
#
# An agency may have sub-agencies and hosts hanging off it. Revoking it must
# not leave them attached to a dead parent, and must not silently detach them
# either. So:
#
#   * a MAIN agency with dependents is refused unless `transfer_to` names a
#     live main agency to receive them. The refusal lists what is attached so
#     the Owner can create or choose the replacement and try again;
#   * a SUB-agency's hosts move to its parent main agency by default, or to
#     `transfer_to` if given;
#   * each moved dependent is told. Earnings history is untouched: commission
#     and payout ledger rows carry `meta.agency_id` as it was at the time, so
#     repointing a host's current agency rewrites nothing historical and
#     double-counts nothing.
#
# There was no transfer mechanism anywhere in the four codebases before this,
# so this is the one; it moves the two relationships that exist (`parent_id`
# on a sub-agency, `users.agencyId` + the `agencyHosts` roster row on a host)
# and nothing else.


def _hosts_of(agency_id: str) -> list[dict]:
    """Blocking — the agency's CURRENT roster, `agencies/{id}/agencyHosts/*`.

    FX-10 (RF-15): a row `revoke_host` or the account purge marked inactive is
    not a host of this agency, so revoking the agency no longer "moves" a
    revoked Host onto the receiving agency's roster. A row with no `active`
    field predates the marker and is current.
    """
    from app.services import users as users_svc  # local: users imports partner peers

    out: list[dict] = []
    try:
        client = firebase.firestore_client()
        rows = client.collection("agencies").document(agency_id).collection("agencyHosts").stream()
        for snap in rows:
            data = snap.to_dict() or {}
            if not users_svc.roster_row_is_current(data):
                continue
            data["uid"] = str(data.get("uid") or snap.id)
            out.append(data)
    except Exception:  # noqa: BLE001
        log.exception("Could not read the roster of agency %s", agency_id)
    return out


HOST_MOVE_CONTENDED = (
    "Another change to this host was being saved at the same moment, so the move was "
    "not made: the host is still under the agency it was moving from. Try again — it "
    "cannot move the host twice."
)
HOST_MOVE_UNKNOWN = (
    "The database did not confirm whether the host was moved. The host is not under the "
    "new agency yet, but the move may still complete. Check the host's agency before "
    "anything else; trying again is safe — it cannot move the host twice."
)


class HostMoveContended(PartnerOpsError):
    """HT-1 — Firestore aborted a Host move under contention, and it is not there.

    The move is one Firestore transaction. When other writes to the same
    documents keep winning, the client library aborts it: an aborted COMMIT is
    retried at once, five attempts in all, and then reported as
    `ValueError("Failed to commit transaction in 5 attempts.")`; an `Aborted`
    raised by a READ inside the transaction is not retried at all. `_move_host`
    then reads the Host once more (HT-2: its own move id first — an error is no
    proof that nothing committed): moved by this call → True; moved by somebody
    else → False; still under the agency it was moving from → this (409), so the
    caller answers "try again" instead of passing a library error on as a 500.
    """

    status_code = 409


class HostMoveOutcomeUnknown(PartnerOpsError):
    """HT-2 — whether a Host move committed could not be established.

    A Firestore error other than ABORTED (a deadline, an unavailable or
    internal error, a transport error), or the read after it failing. The move
    is not visible, but a commit can still land after the client stopped
    waiting. 503. Retrying is safe: the move is a compare-and-set, so a move
    that did land makes the retry return False.
    """

    status_code = 503


def _move_host(
    host: dict, from_agency: str, to_agency: str, now: datetime, *, move_id: str = "",
) -> bool:
    """Blocking — repoint one host's current agency. History is untouched.

    B23: the host's verification record names the agency too (the reviewer's
    queue column), so it moves in the same write — only when it exists: an
    update on a missing record would fail the whole move, and creating a
    partial one would invent a verification nobody opened.

    FX-10 (RF-15 / RF-31):
      * COMPARE-AND-SET on `users/{uid}.agencyId`. It used to be overwritten
        unconditionally, so two moves of one host that both read it under A —
        an Owner transfer A→B and a revocation of A with transfer to C — both
        ran, and the host ended on whichever landed last, with a roster row
        left under the other. The move now happens only while the host is
        still under `from_agency`, inside one transaction; otherwise nothing is
        written and False is returned.
      * the application the host joined on is STAMPED (`transferredTo`,
        `transferredFrom`, `transferredAt`). It still says agency A, and the
        CRM roster counted an activated application of A as one of A's hosts —
        so a transferred host was counted under both agencies.

    HT-1 / HT-2: the move carries its own id (`transferId` on the destination
    roster row, which only the server writes), and the transaction recognises
    it first. A move whose answer was lost — the client re-sends a commit, and
    the library may run the callback again on the state it committed — is
    therefore reported as the move it is; it used to come back False ("another
    move won"), leaving the transfer request pending and the Host untold. After
    a Firestore error the Host is read again: moved by this call → True; no
    longer under `from_agency` → False; still under it → `HostMoveContended`
    (aborted) or `HostMoveOutcomeUnknown`. An error of the transaction's own
    code is re-raised unchanged.

    Returns True when this call moved the host. False: it did not, because the
    host was no longer under `from_agency`.
    """
    import secrets

    from firebase_admin import firestore as fb_firestore_tx

    client = firebase.firestore_client()
    uid = str(host.get("uid") or "")
    if not uid:
        return False
    user_ref = client.collection("users").document(uid)
    to_row = client.collection("agencies").document(to_agency).collection("agencyHosts").document(uid)
    from_row = client.collection("agencies").document(from_agency).collection("agencyHosts").document(uid)
    verification = client.collection("hostVerification").document(uid)
    app_id = str(host.get("applicationId") or "").strip()
    app_ref = client.collection("hostApplications").document(app_id) if app_id else None
    expected = str(from_agency or "").strip()
    destination = str(to_agency or "").strip()
    # HT-2: a transfer request passes its own id, so approving it again can
    # recognise a move that landed; a revocation's moves get a fresh one.
    move_id = str(move_id or "").strip() or secrets.token_urlsafe(12)

    def _agency_of(user) -> str:
        return str(((user.to_dict() or {}) if getattr(user, "exists", False) else {}).get("agencyId") or "").strip()

    def _ours(row) -> bool:
        return bool(getattr(row, "exists", False)) and (row.to_dict() or {}).get("transferId") == move_id

    @fb_firestore_tx.transactional
    def _run(tx) -> bool:
        current = _agency_of(user_ref.get(transaction=tx))
        if current != expected:
            # HT-2: under the destination with THIS move's id — an earlier
            # attempt committed and its answer was lost.
            return current == destination and _ours(to_row.get(transaction=tx))
        ver = verification.get(transaction=tx)
        app = app_ref.get(transaction=tx) if app_ref is not None else None
        tx.update(
            user_ref,
            {"agencyId": to_agency, "agencyTransferredAt": now, "agencyTransferredFrom": from_agency},
        )
        tx.set(
            to_row,
            {**{k: v for k, v in host.items() if k != "uid"}, "uid": uid, "agencyId": to_agency,
             "transferredFrom": from_agency, "transferredAt": now, "transferId": move_id},
            merge=True,
        )
        tx.delete(from_row)
        if getattr(ver, "exists", False):
            tx.update(verification, {"agencyId": to_agency, "updatedAt": now})
        if app is not None and getattr(app, "exists", False):
            tx.update(
                app_ref,
                {"transferredTo": to_agency, "transferredFrom": from_agency, "transferredAt": now},
            )
        return True

    try:
        return bool(_run(client.transaction()))
    except Exception as exc:
        kind = firebase.transaction_error_kind(exc)
        if kind is None:
            raise
        # HT-1 / HT-2: which documented result applies? The error does not say.
        log.warning("Host %s: the move %s→%s failed in Firestore (%s); reading it again",
                    uid, from_agency, to_agency, exc)
        try:
            now_under = _agency_of(user_ref.get())
            if now_under == destination and _ours(to_row.get()):
                return True  # this move landed; its answer was lost
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("Host %s: could not re-read the agency after the failed move", uid)
            raise HostMoveOutcomeUnknown(HOST_MOVE_UNKNOWN) from exc
        if now_under != expected:
            return False  # another move won: the compare-and-set result
        if kind == "contended":
            raise HostMoveContended(HOST_MOVE_CONTENDED) from exc
        raise HostMoveOutcomeUnknown(HOST_MOVE_UNKNOWN) from exc


async def _move_sub_agency(
    sub_id: str,
    from_id: str,
    from_name: str,
    to_agency: dict,
    reason: str,
    actor: dict,
    now: datetime,
    *,
    expect_parent: str | None = None,
) -> bool:
    """Repoint one sub-agency's parent, mirror it and tell its owner.

    The move revocation has always made, as one helper so an Owner-approved
    transfer (`services/transfer_requests`) makes exactly the same one.
    `expect_parent` makes the move conditional on the parent still being the
    one it was read as; False is returned when it no longer is. No balance
    and no ledger row moves — the relationship is the whole of it.
    """
    to_id = str(to_agency["_id"])
    query: dict = {"_id": sub_id}
    if expect_parent is not None:
        query["parent_id"] = expect_parent
    result = await get_db()[C.PARTNERS].update_one(
        query,
        {"$set": {"parent_id": to_id, "parent_name": str(to_agency.get("name") or ""),
                  "updated_at": now},
         "$push": {"parent_history": {"from": from_id, "to": to_id, "at": now,
                                      "reason": reason, "by": _who(actor)}}},
    )
    if expect_parent is not None and not int(getattr(result, "modified_count", 0) or 0):
        return False
    sub_row = await get_db()[C.PARTNERS].find_one({"_id": sub_id}) or {"_id": sub_id, "kind": "sub_agency"}
    await asyncio.to_thread(
        _sync_partner_doc, sub_row,
        {"parentAgencyId": to_id, "parentTransferredFrom": from_id, "parentTransferredAt": now},
    )
    await _notify_owner(
        sub_row,
        lambda uid, k, p, _from=from_name, _to=to_agency.get("name"):
            notices.partner_transferred(uid, k, p, str(_from or ""), str(_to or "")),
    )
    return True


async def _dependents_of(partner: dict) -> tuple[list[dict], list[dict]]:
    """`(live sub-agencies, roster hosts)` hanging off this partner. Read-only."""
    pid = str(partner["_id"])
    kind = str(partner.get("kind") or "")
    subs = (
        await partner_svc.sub_agencies_of(pid) if kind == str(PartnerKind.AGENCY) else []
    )
    live_subs = [s for s in subs if str(s.get("status")) not in ("revoked", "rejected")]
    hosts = await asyncio.to_thread(_hosts_of, pid)
    return live_subs, hosts


async def _transfer_target(
    partner: dict, to_agency: dict | None, live_subs: list[dict], hosts: list[dict]
) -> dict | None:
    """Where the dependents go, or None when there are none. Validates; writes nothing.

    Raises `PartnerOpsError` if there are dependents and nowhere valid to put
    them — before anything at all has changed.
    """
    pid = str(partner["_id"])
    kind = str(partner.get("kind") or "")
    if not live_subs and not hosts:
        return None

    if to_agency is None:
        if kind == str(PartnerKind.SUB_AGENCY) and partner.get("parent_id"):
            # A sub-agency's hosts go up to the parent unless told otherwise.
            to_agency = await get_db()[C.PARTNERS].find_one({"_id": str(partner["parent_id"])})
        if to_agency is None:
            raise PartnerOpsError(
                f"{partner.get('name') or pid} still has "
                f"{len(live_subs)} sub-agenc{'y' if len(live_subs) == 1 else 'ies'} and "
                f"{len(hosts)} host{'s' if len(hosts) != 1 else ''} attached. Name a "
                "replacement main agency (transfer_to) to receive them, or create "
                "one first. Nothing was revoked and nothing was moved."
            )

    to_id = str(to_agency["_id"])
    if to_id == pid:
        raise PartnerOpsError("A partner cannot receive its own dependents. Nothing was changed.")
    if (
        str(to_agency.get("kind") or "") != str(PartnerKind.AGENCY)
        or str(to_agency.get("status") or "") != str(PartnerStatus.APPROVED)
        or not to_agency.get("is_active", False)
    ):
        raise PartnerOpsError(
            f"'{to_agency.get('name') or to_id}' is not an approved, active main "
            "agency, so it cannot receive sub-agencies or hosts. Nothing was changed."
        )
    return to_agency


async def _transfer_dependents(
    partner: dict, to_agency: dict | None, reason: str, actor: dict, now: datetime,
    *, planned: tuple[list[dict], list[dict], dict | None] | None = None,
) -> dict:
    """Move a revoked agency's sub-agencies and hosts to `to_agency`.

    Returns what moved. Raises `PartnerOpsError` if there are dependents and
    nowhere to put them. `planned` is `(live_subs, hosts, target)` as already
    read and validated by the caller — `revoke_partner` validates BEFORE its
    conditional status write and moves after it, so a refusal can never come
    between the two.
    """
    pid = str(partner["_id"])
    kind = str(partner.get("kind") or "")
    if planned is None:
        live_subs, hosts = await _dependents_of(partner)
        to_agency = await _transfer_target(partner, to_agency, live_subs, hosts)
    else:
        live_subs, hosts, to_agency = planned
    if to_agency is None:
        return {"sub_agencies": [], "hosts": [], "to": None}
    to_id = str(to_agency["_id"])

    # FX-13 (RF-21): nothing is swallowed and nothing aborts half-way. The
    # revocation is already committed when this runs, so a failure used to
    # leave a half-moved agency — a host's failure logged and forgotten, a
    # sub-agency's failure thrown out of the endpoint AFTER the commit, so the
    # caller was told "failed" about a revocation that had happened. Every
    # move is now attempted, every failure is reported by name, the outcome is
    # recorded on the record (`dependents_transfer`), and running Revoke again
    # moves whatever is left (`revoke_partner` → resume).
    moved_subs: list[str] = []
    failed_subs: list[dict] = []
    skipped_subs: list[str] = []
    for sub in live_subs:
        sub_id = str(sub["id"])
        try:
            moved_one = await _move_sub_agency(
                sub_id, pid, str(partner.get("name") or ""), to_agency, reason, actor, now,
                expect_parent=pid,
            )
        except Exception as exc:  # noqa: BLE001 — reported below, not swallowed
            log.exception("Sub-agency %s could not be moved from %s to %s", sub_id, pid, to_id)
            failed_subs.append({"id": sub_id, "error": str(exc) or exc.__class__.__name__})
            continue
        if moved_one:
            moved_subs.append(sub_id)
        else:
            # No longer under this agency (moved by somebody else meanwhile).
            skipped_subs.append(sub_id)

    moved_hosts: list[str] = []
    failed_hosts: list[dict] = []
    skipped_hosts: list[str] = []
    for host in hosts:
        huid = str(host.get("uid") or "")
        if not huid:
            continue
        try:
            moved_one = await asyncio.to_thread(_move_host, host, pid, to_id, now)
        except Exception as exc:  # noqa: BLE001 — reported below, not swallowed
            log.exception("Host %s could not be moved from %s to %s", huid, pid, to_id)
            failed_hosts.append({"uid": huid, "error": str(exc) or exc.__class__.__name__})
            continue
        if not moved_one:
            # FX-10: the host is no longer under this agency — the CAS refused.
            skipped_hosts.append(huid)
            continue
        moved_hosts.append(huid)
        await notices.partner_transferred(
            huid, "host", pid, str(partner.get("name") or ""), str(to_agency.get("name") or "")
        )

    complete = not failed_subs and not failed_hosts
    record = {
        "to": to_id,
        "to_name": str(to_agency.get("name") or ""),
        "complete": complete,
        "failed_sub_agencies": [f["id"] for f in failed_subs],
        "failed_hosts": [f["uid"] for f in failed_hosts],
        "at": now,
    }
    try:
        await get_db()[C.PARTNERS].update_one({"_id": pid}, {"$set": {"dependents_transfer": record}})
    except Exception:  # noqa: BLE001 — the audit row below still says what happened
        log.exception("Could not record the dependents transfer on %s", pid)

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_DEPENDENTS_TRANSFERRED,
        subject_type="partner",
        subject_id=pid,
        reason=reason,
        before={"sub_agencies": [s["id"] for s in live_subs], "hosts": [h.get("uid") for h in hosts]},
        after={"to": to_id, "sub_agencies": moved_subs, "hosts": moved_hosts,
               "failed_sub_agencies": failed_subs, "failed_hosts": failed_hosts,
               "skipped_sub_agencies": skipped_subs, "skipped_hosts": skipped_hosts,
               "complete": complete},
        meta={"kind": kind},
    )
    return {"sub_agencies": moved_subs, "hosts": moved_hosts, "to": to_id,
            "to_name": str(to_agency.get("name") or ""),
            "failed_sub_agencies": failed_subs, "failed_hosts": failed_hosts,
            "skipped_sub_agencies": skipped_subs, "skipped_hosts": skipped_hosts,
            "complete": complete}


INCOMPLETE_TRANSFER_NOTE = (
    "Not every dependent could be moved{what}. The revocation itself is done. "
    "Run Revoke again with the same destination to move what is left — it "
    "changes nothing else."
)


def _incomplete_note(moved: dict) -> str:
    parts = []
    if moved.get("failed_sub_agencies"):
        parts.append(f"{len(moved['failed_sub_agencies'])} sub-agenc"
                     f"{'y' if len(moved['failed_sub_agencies']) == 1 else 'ies'}")
    if moved.get("failed_hosts"):
        parts.append(f"{len(moved['failed_hosts'])} host{'s' if len(moved['failed_hosts']) != 1 else ''}")
    return INCOMPLETE_TRANSFER_NOTE.format(what=f" ({' and '.join(parts)} failed)" if parts else "")


async def _resume_dependents_transfer(
    partner: dict, reason: str, actor: dict, transfer_to: str | None
) -> dict | None:
    """FX-13 (RF-21) — finish moving a REVOKED partner's dependents.

    None when there is nothing left to move (the caller then says "already
    revoked", as before). Owner only, like the first attempt; the destination
    is the one named now, else the one the first attempt recorded, and it is
    validated again — it may have been revoked in between.
    """
    live_subs, hosts = await _dependents_of(partner)
    if not live_subs and not hosts:
        return None
    if not _is_owner(actor):
        raise PartnerOpsForbidden(OWNER_ONLY_TRANSFER.format(n=len(live_subs) + len(hosts)))
    recorded = (partner.get("dependents_transfer") or {}).get("to")
    wanted = str(transfer_to or recorded or "").strip()
    target = await get_db()[C.PARTNERS].find_one({"_id": wanted}) if wanted else None
    if wanted and target is None:
        raise PartnerOpsError(
            f"'{wanted}' is not a registered agency, so nothing can be transferred to it. "
            "Nothing was changed."
        )
    destination = await _transfer_target(partner, target, live_subs, hosts)
    moved = await _transfer_dependents(
        partner, destination, reason, actor, _now(), planned=(live_subs, hosts, destination)
    )
    out = _public(partner)
    out["resumed"] = True
    out["dependents_moved"] = moved
    out["note"] = (
        "The role was already revoked; its remaining dependents were moved."
        if moved.get("complete") else _incomplete_note(moved)
    )
    return out


async def revoke_partner(
    partner_id: str, reason: str, actor: dict, transfer_to: str | None = None
) -> dict:
    """Take the role away. The record, the money and the history all stay.

    See the section comment above for what this is and is not. Three rules
    added since it was written:

      * C1 / B04 — the role-family slot is KEPT. A revoked role still counts
        for the combination rules, and the way back is a reinstatement request
        the Owner decides, which restores this same record;
      * C3 — a revocation that MOVES dependents (sub-agencies or hosts) is a
        transfer, and transfers are the Owner's decision. Anyone else is
        refused before anything is written and pointed at a transfer request.
        Revoking with no dependents keeps its permission;
      * B17 — the status write is conditional on the status read, and
        validation of where dependents go happens before it, so a concurrent
        decision cannot make both run and a refusal cannot land half-way.
    """
    reason = _require_reason(reason)
    partner = await _partner(partner_id)
    kind = str(partner.get("kind") or "")

    if partner.get("status") == str(PartnerStatus.REVOKED):
        # FX-13: resumable. A revocation whose dependents were not all moved
        # finishes moving them; one with nothing left says so, as before.
        resumed = await _resume_dependents_transfer(partner, reason, actor, transfer_to)
        if resumed is not None:
            return resumed
        raise PartnerOpsError(
            "This role was already revoked"
            + (f": {partner.get('revocation_reason')}" if partner.get("revocation_reason") else ".")
        )
    if partner.get("status") == str(PartnerStatus.REJECTED):
        raise PartnerOpsError(
            "This application was rejected and never held the role, so there "
            "is nothing to revoke."
        )
    if str(partner.get("status") or str(PartnerStatus.PENDING)) == str(PartnerStatus.PENDING):
        raise PartnerOpsError(
            "This application has not been approved, so there is no role to "
            "revoke. Reject it instead."
        )
    await _refuse_single_role_revocation(partner)

    now = _now()
    target: dict | None = None
    if transfer_to:
        target = await get_db()[C.PARTNERS].find_one({"_id": str(transfer_to).strip()})
        if target is None:
            raise PartnerOpsError(
                f"'{transfer_to}' is not a registered agency, so nothing can be "
                "transferred to it. Nothing was revoked."
            )

    # Dependents first — read and validated, nothing written. A refusal here
    # leaves everything exactly as it was.
    live_subs, hosts = await _dependents_of(partner)
    if (live_subs or hosts) and not _is_owner(actor):
        raise PartnerOpsForbidden(OWNER_ONLY_TRANSFER.format(n=len(live_subs) + len(hosts)))
    destination = await _transfer_target(partner, target, live_subs, hosts)

    # RC (confirmed, CRM-FLOW 9.48): the money behind the revocation is frozen
    # for the Owner's review — first, so it never moves after the role is gone.
    await money_freeze.freeze_partner(
        partner_id, row=partner, cause="role_revoked", label="the role's revocation",
        reason=reason, actor=actor, db=get_db(),
    )

    before = {"status": partner.get("status"), "is_active": partner.get("is_active", False)}
    # B17: conditional on the status read above. On no match, stop — nothing
    # has been moved, audited or told.
    updated = await get_db()[C.PARTNERS].find_one_and_update(
        {"_id": partner_id, "status": partner.get("status")},
        {
            "$set": {
                "status": str(PartnerStatus.REVOKED),
                "is_active": False,
                "revoked_at": now,
                "revoked_by": _who(actor),
                "revocation_reason": reason,
                "updated_at": now,
            },
            "$push": {"revocation_history": {"at": now, "reason": reason, "by": _who(actor)}},
        },
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise PartnerOpsError(
            "This record changed while it was being revoked. Reload it and try again."
        )

    moved = await _transfer_dependents(
        partner, destination, reason, actor, now, planned=(live_subs, hosts, destination)
    )

    # Spec §5 "Revoke Coin Seller": pending cards/requests go to Finance/Owner
    # review; nothing is approved, cancelled or executed. The freeze above
    # already put them on the held list (cause `role_revoked`); the hook is
    # idempotent and reports the ids so the audit entry names what is waiting.
    held_queue: dict | None = None
    if kind == str(PartnerKind.SELLER):
        from app.services import revocation_hooks  # local: the hook file imports nothing of ours at import time

        held_queue = await revocation_hooks.hold_pending_money_for_revoked_seller(
            partner_id, reason=reason, actor=actor,
        )

    await audit.record(
        actor=actor,
        action=audit.Action.PARTNER_REVOKED,
        subject_type="partner",
        subject_id=partner_id,
        reason=reason,
        before=before,
        after={"status": str(PartnerStatus.REVOKED), "is_active": False},
        meta={"kind": kind, "dependents_moved": moved, "role_family_kept": True,
              **({"held_queue": held_queue} if held_queue is not None else {})},
    )

    # ── The slot is KEPT (C1 / B04) ─────────────────────────────────────────
    #
    # This used to release the role-family claim, so the revoked role could
    # be re-applied for and re-created as a brand-new record — the revocation
    # treated as though the role had never existed. The claim now stays with
    # this record; a reinstatement request decided by the Owner restores it.

    synced = _sync_partner_doc(
        updated,
        {
            **_fs_status_fields(kind, PartnerStatus.REVOKED, False),
            "revokedAt": now,
            "revokedBy": actor.get("uid", ""),
            "revocationReason": reason,
        },
    )
    login_synced = await _mirror_login(updated or partner, str(PartnerStatus.REVOKED))
    out = _public(updated)
    out["replica_synced"] = synced
    out["login_synced"] = login_synced
    out["sessions_revoked"] = await _revoke_partner_sessions(updated or partner)
    out["dependents_moved"] = moved
    out["role_family_released"] = False
    out["notified"] = await _notify_owner(
        updated or partner,
        lambda uid, k, pid: notices.partner_revoked(uid, k, pid, reason),
    )
    out["note"] = (
        "The role is revoked. The person's account, their other roles, and "
        "every historical record are untouched. The role still counts for the "
        "combination rules; the person may request reinstatement, which the "
        "Owner decides."
    )
    if moved.get("to") and not moved.get("complete", True):
        out["note"] += " " + _incomplete_note(moved)
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

    # QA #50: the partner is told — the change appeared without a word before.
    notified = await _notify_details_decided(
        partner_id, collection, doc, applied=True, fields=sorted(allowed), reason="", decision_id=audit_id,
    )

    return {
        "partner_id": partner_id,
        "collection": collection,
        "applied": sorted(allowed),
        "refused": refused,
        "before": before,
        "after": allowed,
        "audit_id": audit_id,
        "notified": notified,
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

    # QA #50: the partner is told, with the reason — not only on a dashboard.
    notified = await _notify_details_decided(
        partner_id, collection, doc, applied=False, fields=proposed, reason=reason, decision_id=audit_id,
    )

    return {
        "partner_id": partner_id,
        "collection": collection,
        "refused": proposed,
        "kyc_status": previous,
        "audit_id": audit_id,
        "notified": notified,
        "note": (
            "Nothing on the record changed. The reason is stored on it, shown on "
            "the partner's own dashboard and sent to them as an Official message "
            "and email, so they are told why rather than resubmitting the same change."
        ),
    }


async def _notify_details_decided(
    partner_id: str, collection: str, doc: Mapping, *, applied: bool, fields: list[str],
    reason: str, decision_id: object,
) -> bool:
    """QA #50: tell the human behind the partner document. Never raises — the
    decision is written and audited by the time this runs.

    The human is the document's own `crmUid` back-link, falling back to the
    business record's `owner_crm_uid` (a proposal can predate that record, so
    neither is required). Nobody to tell is False, not an error.
    """
    from app.services import notices  # local: notices imports email, which imports settings

    try:
        kind = str(_derive_kind(collection, dict(doc)))
        uid = _crm_login_of(dict(doc))
        if not uid:
            record = await get_db()[C.PARTNERS].find_one({"_id": partner_id})
            uid = str((record or {}).get("owner_crm_uid") or "").strip()
        if not uid:
            return False
        return bool(await notices.partner_details_decided(
            uid, kind, partner_id, applied=applied, fields=fields, reason=reason,
            decision_id=str(decision_id or ""),
        ))
    except Exception:  # noqa: BLE001
        log.exception("partner %s: the detail-change notice was not delivered", partner_id)
        return False


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


async def _expected_purchase_minor(coins: int, partner: dict | None = None) -> int | None:
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
    # B9 (3 Nov 2026): a seller on a priced tier buys at that tier's price (seller_business.tier_price_per_lakh).
    from app.services.seller_business import tier_price_per_lakh

    tier_price = tier_price_per_lakh(rates, partner)
    if tier_price:
        per_lakh = tier_price
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
    seller_doc = await _partner(seller_id, PartnerKind.SELLER)
    expected_minor = await _expected_purchase_minor(coins, seller_doc)
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

    await _claim(card_id, actor)
    try:
        movement, replayed = await _move_once(
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

    if paid and not replayed:
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

    partner = await _partner(seller_id, PartnerKind.SELLER)
    allowed, why = await partner_svc.can_take_inventory(seller_id)
    if not allowed:
        raise PartnerOpsError(why)
    # B9 (3 Nov 2026): with a credit limit set, nobody lends past it — the limit is raised first, on the record.
    credit = partner.get("credit") or {}
    limit = int(credit.get("limit") or 0)
    outstanding = int(credit.get("outstanding") or 0)
    if limit > 0 and outstanding + coins > limit:
        raise PartnerOpsError(
            f"This would take the seller's debt to {outstanding + coins:,} coins, over their credit limit of "
            f"{limit:,}. Raise the limit first if Zipper agrees to lend more."
        )

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

    await _claim(card_id, actor)
    try:
        movement, _replayed = await _move_once(
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

    def _compute(partner: dict) -> tuple[dict, dict]:
        before = int((partner.get("credit") or {}).get("outstanding", 0))
        # B9 (3 Nov 2026): one due date governs the debt, and a new loan never pushes back money already owed —
        # while something is outstanding, the EARLIER of the two dates stands.
        prior_due = (partner.get("credit") or {}).get("due_at")
        effective_due = due_at
        if before > 0 and isinstance(prior_due, datetime) and isinstance(due_at, datetime):
            p = prior_due if prior_due.tzinfo else prior_due.replace(tzinfo=timezone.utc)
            d = due_at if due_at.tzinfo else due_at.replace(tzinfo=timezone.utc)
            effective_due = min(p, d)
        return (
            {
                "$inc": {"credit.outstanding": coins, "credit.total_lent": coins},
                "$set": {
                    "credit.due_at": effective_due,
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
            {"outstanding_before": before},
        )

    updated, applied = await _update_credit_conditionally(seller_id, card_id, _compute)
    outstanding = int(((updated or {}).get("credit") or {}).get("outstanding", coins))

    return await _finish(
        card_id,
        actor,
        {
            "coins_lent": coins,
            "due_at": due_at,
            "outstanding_after": outstanding,
            "debt_recorded": "replayed" if applied.get("replayed") else "recorded",
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
    *,
    amount_paid_minor: int = 0,
    extra: dict | None = None,
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
                # O7: what the seller says they paid, in paise (0 when staff record a repayment without it).
                "amount_paid_minor": max(0, int(amount_paid_minor or 0)),
                **(extra or {}),
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

    await _claim(card_id, actor)
    now = _now()

    def _compute(partner: dict) -> tuple[dict, dict]:
        outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
        applied = min(coins, outstanding)
        remaining = outstanding - applied
        update: dict = {
            # M-12: `$inc`, never a `$set` of a figure computed from a stale
            # read — and the filter carries the figure that was read.
            "$inc": {"credit.outstanding": -applied, "credit.total_repaid": applied},
            "$set": {"credit.last_repaid_at": now, "updated_at": now},
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
        return update, {"outstanding_before": outstanding, "applied": applied, "remaining": remaining}

    _updated, result = await _update_credit_conditionally(seller_id, card_id, _compute)
    if result.get("replayed"):
        entry = result["entry"]
        applied = int(entry.get("coins") or 0)
        partner = await _partner(seller_id, PartnerKind.SELLER)
        remaining = int((partner.get("credit") or {}).get("outstanding", 0))
        outstanding = remaining + applied
    else:
        outstanding, applied, remaining = result["outstanding_before"], result["applied"], result["remaining"]
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
                "idempotency_key": f"card:{card_id}:repay",
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
            "replayed": bool(result.get("replayed")),
        },
        True,
    )


async def request_recovery(
    seller_id: str,
    coins: int,
    penalty_coins: int,
    reason: str,
    actor: dict,
    *,
    extra: dict | None = None,
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
                **(extra or {}),
            },
        ),
        actor,
    )


#: O7 — the two ways a seller pays back borrowed coins.
REPAY_METHODS = ("payment", "return_coins")


async def request_seller_repayment(
    seller_id: str,
    coins: int,
    method: str,
    amount_paid_minor: int,
    payment_ref: str,
    reason: str,
    actor: dict,
) -> dict:
    """O7 (Owner, 5 Nov 2026): "if a seller borrowed coins from us, for those coins he needs to pay — and that
    payment is not in the app or the CRM." The seller says how they are paying back, from the app's Work tab or the
    CRM seller portal; staff can file the same on a seller's behalf.

      * ``payment`` — they paid Zipper for the borrowed coins (bank / UPI, with the reference and the amount). A
        ``lending_repay`` card: when one Owner approves it, the debt goes down. No coin moves; the coins were
        already issued.
      * ``return_coins`` — they hand back borrowed coins they have not sold, from their own inventory. A
        ``lending_recover`` card with no penalty: when one Owner approves it, those coins leave the inventory and
        the debt goes down by the same amount.

    Both are requests: nothing moves here. Refused when there is nothing owed, when more is offered than is owed,
    without a payment reference and amount (payment), or with more coins than the seller holds (return).
    """
    method = (method or "payment").strip().lower()
    if method not in REPAY_METHODS:
        raise PartnerOpsError("Choose how you are paying back: a payment to Zipper, or returning coins.")
    reason = _require_reason(reason)
    coins = _positive(coins, "Coins")

    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
    if outstanding <= 0:
        raise PartnerOpsError("There are no borrowed coins to pay back.")
    if coins > outstanding:
        raise PartnerOpsError(
            f"{coins:,} coins is more than the {outstanding:,} owed. Pay back at most what is owed."
        )
    by_partner = R.is_external(actor.get("role"))
    extra = {"method": method, "requested_by_partner": by_partner}

    if method == "payment":
        ref = (payment_ref or "").strip()
        if not ref:
            raise PartnerOpsError(
                "Give the payment reference (UTR or transaction id), so Zipper can match the money to you."
            )
        paid = _non_negative(amount_paid_minor, "Amount paid")
        if paid <= 0:
            raise PartnerOpsError("Enter the amount paid.")
        return await request_repayment(seller_id, coins, ref, reason, actor, amount_paid_minor=paid, extra=extra)

    balance = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    if coins > balance:
        raise PartnerOpsError(
            f"Only {balance:,} coins are in the inventory, so {coins:,} cannot be returned."
        )
    return await request_recovery(seller_id, coins, 0, reason, actor, extra=extra)


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

    await _claim(card_id, actor)
    partner = await _partner(seller_id, PartnerKind.SELLER)
    outstanding = int((partner.get("credit") or {}).get("outstanding", 0))

    # A replay of an interrupted execution: the debit is keyed on the card and
    # the record entry names it, so what was recovered the first time is what
    # is recovered — never a second slice of whatever the balance holds now.
    prior_entry = _already_recorded(partner, card_id)
    prior_row = await get_db()[C.LEDGER].find_one({"idempotency_key": f"card:{card_id}:recover"})
    if prior_row is not None:
        recovered = abs(int(prior_row.get("amount") or 0))
        balance = int(prior_row.get("balance_before") or 0)
    elif prior_entry is not None:
        recovered = int(prior_entry.get("coins") or 0)
        balance = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
    else:
        balance = await get_balance(HolderType.SELLER, seller_id, Currency.COINS)
        recovered = max(0, min(balance, target))

    movement: dict = {"ledger_id": None, "balance_before": balance, "balance_after": balance}
    if recovered > 0:
        try:
            movement, _replayed = await _move_once(
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

    shortfall = max(0, target - recovered)
    now = _now()

    def _compute(current: dict) -> tuple[dict, dict]:
        before = int((current.get("credit") or {}).get("outstanding", 0))
        # The penalty is added to the debt, then everything recovered comes
        # off it — as an increment on the figure read, never a `$set`.
        remaining = max(0, before + penalty - recovered)
        return (
            {
                "$inc": {
                    "credit.outstanding": remaining - before,
                    "credit.total_recovered": recovered,
                    "credit.total_penalty": penalty,
                },
                "$set": {"credit.last_recovered_at": now, "updated_at": now},
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
            {"outstanding_before": before, "remaining": remaining},
        )

    updated, applied = await _update_credit_conditionally(seller_id, card_id, _compute)
    remaining = int(((updated or {}).get("credit") or {}).get("outstanding", 0))
    if not applied.get("replayed"):
        outstanding = applied["outstanding_before"]

    result = {
        "target": target,
        "recovered": recovered,
        "shortfall": shortfall,
        "penalty_coins": penalty,
        "outstanding_before": outstanding,
        "outstanding_after": remaining,
        "replayed": bool(applied.get("replayed")),
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

    await _claim(card_id, actor)
    now = _now()

    def _compute(partner: dict) -> tuple[dict, dict]:
        outstanding = int((partner.get("credit") or {}).get("outstanding", 0))
        written = min(coins, outstanding)
        remaining = outstanding - written
        return (
            {
                "$inc": {"credit.outstanding": -written, "credit.total_written_off": written},
                "$set": {"credit.written_off_at": now, "updated_at": now},
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
            {"outstanding_before": outstanding, "written": written, "remaining": remaining},
        )

    _updated, result = await _update_credit_conditionally(partner_id, card_id, _compute, kind=None)
    if result.get("replayed"):
        written = int(result["entry"].get("coins") or 0)
        partner = await _partner(partner_id)
        remaining = int((partner.get("credit") or {}).get("outstanding", 0))
        outstanding = remaining + written
    else:
        outstanding, written, remaining = result["outstanding_before"], result["written"], result["remaining"]
        await audit.record(
            actor=actor,
            action=audit.Action.LENDING_WRITE_OFF,
            subject_type="partner",
            subject_id=partner_id,
            reason=card.get("reason", "Bad debt written off"),
            before={"outstanding": outstanding},
            after={"outstanding": remaining},
            card_id=card_id,
            meta={"coins": written, "is_loss": True, "loss_coins": written,
                  "idempotency_key": f"card:{card_id}:write_off"},
        )

    return await _finish(
        card_id,
        actor,
        {
            "written_off": written,
            "outstanding_before": outstanding,
            "outstanding_after": remaining,
            "is_loss": True,
            "replayed": bool(result.get("replayed")),
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
    """File a sale. Nothing moves until it is approved. Spec 4.3.8.

    M-11: the buyer must EXIST — a `users/{uid}` document the credit can land
    on. The credit is a `set(merge, Increment)`, which would otherwise mint an
    orphan document and destroy the seller's inventory into a non-account. A
    Firestore that cannot be read refuses the filing (retry), which is a
    different answer from "no such user" (final).
    """
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
    if buyer == str(seller.get("owner_crm_uid") or ""):
        raise PartnerOpsError(
            "Buyer and seller are the same account. A genuine sale has a distinct buyer."
        )

    try:
        wallet = await asyncio.to_thread(firebase.read_host_wallet, buyer)
    except Exception as exc:  # noqa: BLE001
        log.exception("Firestore user lookup failed for sale buyer %s", buyer)
        raise PartnerOpsError(
            f"The buyer '{buyer}' could not be read from Firestore, so the sale was not "
            "filed. Try again once Firestore is reachable."
        ) from exc
    if wallet is None:
        raise PartnerOpsError(
            f"No app account with uid '{buyer}'. A sale credits a buyer's own wallet, so it "
            "cannot be filed against an account that does not exist."
        )

    now = _now()
    text = _reason(
        reason, f"Sale of {diamonds} diamonds by {seller.get('name') or seller_id}"
    )
    doc = {
        "seller_id": seller_id,
        "seller_name": str(seller.get("name") or ""),
        "buyer_uid": buyer,
        "buyer_name": str(wallet.get("name") or ""),
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

    # RC (confirmed, CRM-FLOW 9.48): a frozen Coin Seller's inventory does not
    # move until the Owner decides.
    try:
        await money_freeze.assert_subject_not_frozen("partner", str(seller_id), db=get_db())
    except money_freeze.MoneyFrozen as exc:
        raise MoneyFrozenError(str(exc)) from exc

    # M-11 — CLAIM THE DECISION (compare-and-set on the status). `pending` and
    # `failed` (debited, not credited) both move to `approving`; a live
    # `approving` claim refuses, a stale one (a process that died mid-step) is
    # re-taken. Every money step behind the claim is idempotent on the sale,
    # so resuming finishes the job rather than repeating it.
    now = _now()
    claimed = await db[SALES].find_one_and_update(
        {"_id": oid, "status": {"$in": [SaleStatus.PENDING, SaleStatus.FAILED]}},
        {"$set": {"status": SaleStatus.APPROVING, "claimed_at": now, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed is None:
        claimed = await db[SALES].find_one_and_update(
            {"_id": oid, "status": SaleStatus.APPROVING, "claimed_at": {"$lt": now - SALE_STALE_CLAIM}},
            {"$set": {"claimed_at": now, "updated_at": now}},
            return_document=ReturnDocument.AFTER,
        )
    if claimed is None:
        fresh = await db[SALES].find_one({"_id": oid}) or sale
        raise PartnerOpsError(
            f"This sale is {fresh.get('status')} — it is being approved by another request, "
            "or was already decided. Nothing was moved twice."
        )

    async def _back_to(status: str, failure: str | None = None) -> None:
        patch: dict = {"status": status, "updated_at": _now()}
        if failure is not None:
            patch["failure"] = failure
        await db[SALES].update_one({"_id": oid, "status": SaleStatus.APPROVING}, {"$set": patch})

    # 1. Seller's inventory comes down first. If it is short, this raises and
    #    the sale stays pending — nothing was credited, so nothing to unwind.
    #    A debit that already landed (this sale resumed) is "continue", not a
    #    failure: the ledger row is keyed on the sale.
    try:
        debit, _debit_replayed = await _move_once(
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
    except PartnerOpsError:
        await _back_to(str(sale.get("status") or SaleStatus.PENDING))
        raise
    except Exception:
        await _back_to(str(sale.get("status") or SaleStatus.PENDING))
        raise

    # 2. Only now does the buyer receive anything — with the app-visible
    #    history row (`diamondTransactions/sale_{id}`) written beside the
    #    balance delta, so the buyer's history explains the credit (M-11/M-18).
    try:
        credit, _credit_replayed = await _move_once(
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
                history={
                    "id": f"sale_{sale_id}",
                    "reason": f"Diamonds bought from {sale.get('seller_name') or seller_id} — verified by Zipper",
                    "reasonLabel": "Diamond purchase",
                    "saleId": sale_id,
                    "sellerId": seller_id,
                    "context": "sale",
                },
            )
        )
    except Exception as exc:  # noqa: BLE001
        # The seller has been debited and the buyer has not been credited. Mark
        # the sale failed and shout. It is RESUMABLE: approving it again finds
        # the debit already applied and continues with the credit (M-11).
        await _back_to(SaleStatus.FAILED, failure=str(exc))
        log.error(
            "Sale %s debited seller %s but could not credit buyer %s: %s",
            sale_id,
            seller_id,
            buyer_uid,
            exc,
        )
        raise PartnerOpsError(
            f"The seller was debited but the buyer could not be credited ({exc}). "
            "The sale is marked failed; approve it again to finish the credit — "
            "the seller is not debited twice."
        ) from exc

    now = _now()
    updated_sale = await db[SALES].find_one_and_update(
        {"_id": oid, "status": SaleStatus.APPROVING},
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
    if updated_sale is None:
        fresh = await db[SALES].find_one({"_id": oid}) or {}
        raise PartnerOpsError(
            f"This sale was decided by another request ({fresh.get('status')}). Nothing was moved twice."
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
    out["resumed"] = str(sale.get("status") or "") == SaleStatus.FAILED
    # §8: one Owner's click minted diamonds — the other Owners are told.
    try:
        from app.services import owner_mail  # local: keeps the import graph acyclic

        out["owner_notice"] = await owner_mail.notify_other_owners(
            actor=actor, action="sale_approved", reference=sale_id, reference_type="sale",
            amount=diamonds, currency=str(Currency.DIAMONDS),
            title=f"Sale by {sale.get('seller_name') or seller_id} to {buyer_uid}",
            subject={"type": "seller", "id": str(seller_id)}, reason=reason,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("Owner notification for sale %s failed", sale_id)
        out["owner_notice"] = {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
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

    await _claim(card_id, actor)
    try:
        movement, _replayed = await _move_once(
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

    # B-22: a provisional slab table or bean rate (the live economy document
    # could not be read, a documented fallback was used) is refused on the
    # human path exactly as on the unattended one. `commission.py` itself
    # says a provisional figure "must not be paid without confirming the live
    # configuration"; a person looking at the preview sees the warning, and a
    # person who still wants the figure accrued confirms appConfig/economy
    # first. A liability created from a guess is a liability either way.
    if computed.get("provisional"):
        why = " ".join(computed.get("warnings") or []) or "The live economy configuration could not be read."
        raise PartnerOpsError(
            f"Commission for {computed['agency_name'] or agency_id} in {span} was NOT accrued: the "
            f"figure is provisional. {why} Confirm appConfig/economy and try again — a liability is "
            "never created from a fallback table."
        )

    # M-6 / B-7: the identity of an accrual is its WINDOW, not its label.
    # `2026-W40` and `2026-10`, or any label with an explicit since/until, over
    # the same cash-outs must not accrue twice. Two guards:
    #   * the ledger key carries the window (`commission:{agency}:{host}:{window}`),
    #     so the same window under any label is one movement per host;
    #   * a window that OVERLAPS one already accrued for this agency without
    #     being identical is refused outright — a month after its weeks, a week
    #     inside an accrued month, a shifted explicit range.
    window = commission_window_label(computed["since"], computed["until"])
    overlapping = await _overlapping_accruals(agency_id, computed["since"], computed["until"])
    clash = [o for o in overlapping if o.get("window") != window]
    if clash:
        first = clash[0]
        raise PartnerOpsError(
            f"The period {span} ({window}) overlaps commission already accrued for "
            f"{computed['agency_name'] or agency_id} — {first.get('period') or '?'} "
            f"({first.get('window') or '?'}, {len(clash)} ledger row(s)). The same cash-outs "
            "cannot be billed twice. Nothing was credited."
        )

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
        # The key every accrual before M-6 wrote — the label. Probed so that a
        # period accrued under the old key is recognised as done rather than
        # accrued again under the window key.
        legacy_key = f"commission:{agency_id}:{line['host_id']}:{span}"
        if await get_db()[C.LEDGER].find_one({"idempotency_key": legacy_key}) is not None:
            already.append({"host_id": line["host_id"], "amount_minor": share, "key": legacy_key})
            continue
        movement = Movement(
            holder_type=HolderType.AGENCY,
            holder_id=agency_id,
            currency=Currency.COMMISSION,
            amount=share,
            action=audit.Action.COMMISSION_ACCRUE,
            reason=text,
            actor=actor,
            idempotency_key=f"commission:{agency_id}:{line['host_id']}:{window}",
            meta={
                "host_id": line["host_id"],
                "period": span,
                "window": window,
                "agency_id": agency_id,
                # The whole derivation travels with the movement, so the
                # statement can explain this line without recomputing it.
                "commission_breakdown": _breakdown_meta(computed, line),
            },
        )
        try:
            result = await apply_movement(movement)
        except DuplicateMovement:
            # This host's leg of this window was accrued by an earlier run.
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
            "window": window,
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
        "window": window,
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


def commission_window_label(since: datetime, until: datetime) -> str:
    """The window as it appears in an accrual's idempotency key (M-6).

    Minute precision in UTC: `2026-09-28T00:00..2026-10-05T00:00`. Two labels
    that resolve to the same half-open window produce the same key."""
    def _fmt(value: datetime) -> str:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M")

    return f"{_fmt(since)}..{_fmt(until)}"


async def _overlapping_accruals(agency_id: str, since: datetime, until: datetime) -> list[dict]:
    """Earlier accruals of this agency whose window intersects `[since, until)`.

    Read from the ledger itself, not a registry: every accrual row carries its
    window in `meta.commission_breakdown.since/until` (rows written before
    M-6 included), so an accrual made under the label key is seen too.
    """
    cursor = get_db()[C.LEDGER].find({
        "holder_type": str(HolderType.AGENCY),
        "holder_id": agency_id,
        "currency": str(Currency.COMMISSION),
        "action": audit.Action.COMMISSION_ACCRUE,
        "meta.commission_breakdown.since": {"$lt": until},
        "meta.commission_breakdown.until": {"$gt": since},
    })
    out: list[dict] = []
    async for row in cursor:
        meta = row.get("meta") or {}
        breakdown = meta.get("commission_breakdown") or {}
        row_since, row_until = breakdown.get("since"), breakdown.get("until")
        if not isinstance(row_since, datetime) or not isinstance(row_until, datetime):
            continue
        out.append({
            "ledger_id": str(row.get("_id") or ""),
            "host_id": meta.get("host_id"),
            "period": meta.get("period"),
            "window": meta.get("window") or commission_window_label(row_since, row_until),
            "since": row_since, "until": row_until,
        })
    return out


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


def _read_payout_request(collection: str, request_id: str) -> dict | None:
    """Blocking — the Firestore payout request a card is raised for, or None."""
    snap = firebase.firestore_client().collection(collection).document(request_id).get()
    return (snap.to_dict() or {}) if getattr(snap, "exists", False) else None


async def _payout_request_for_card(
    host_uid: str, request_collection: str, request_id: str,
    beans: int = 0, host_agency_id: str = "",
) -> dict:
    """P0-7 (FIN-5): the payout request a host-withdrawal card will settle.

    Refused unless it exists, is this host's, is still payable, and has no
    other live card. The executor re-checks all of it inside the transaction
    that debits the wallet — this is so an impossible card is refused when it
    is asked for rather than after somebody has signed it.
    """
    collection = (request_collection or "").strip()
    rid = (request_id or "").strip()
    if collection not in firebase.PAYOUT_REQUEST_COLLECTIONS:
        raise PartnerOpsError(
            "A payout card settles a host withdrawal request or an agency salary "
            "request — name one of those."
        )
    if not rid:
        raise PartnerOpsError("The payout request id is missing.")
    try:
        req = await asyncio.to_thread(_read_payout_request, collection, rid)
    except Exception as exc:  # noqa: BLE001
        raise PartnerOpsError(
            "The payout request could not be read from Firestore, so no card was "
            "raised. Try again once Firestore is reachable."
        ) from exc
    if req is None:
        raise PartnerOpsError("That payout request does not exist.")
    if firebase.payout_request_holder(req) != host_uid:
        raise PartnerOpsError("That payout request is for a different host.")
    status = str(req.get("status") or "")
    if status not in firebase.PAYOUT_REQUEST_PAYABLE:
        raise PartnerOpsError(f"That payout request is '{status}', so it cannot be paid.")
    asked = firebase.payout_request_beans(collection, req)
    if asked != beans:
        raise PartnerOpsError(
            f"That request is for {asked:,} beans; a card that pays it must be for exactly that."
        )
    if collection == "salaryRequests" and str(req.get("agencyId") or "") != (host_agency_id or ""):
        raise PartnerOpsError(
            "That salary request was filed by an agency this host does not belong to."
        )
    live = await get_db()[C.CARDS].find_one({
        "type": str(CardType.HOST_WITHDRAWAL),
        "payload.request_collection": collection,
        "payload.request_id": rid,
        "stage": {"$nin": [str(Stage.REJECTED), str(Stage.FAILED)]},
    })
    if live is not None:
        raise PartnerOpsError(
            "A card for this payout request already exists. Work that card — or "
            "reject it — rather than raising a second one."
        )
    return req


async def request_host_withdrawal(
    host_uid: str, beans: int, reason: str, actor: dict,
    request_collection: str = "", request_id: str = "",
) -> dict:
    """Raise a card to pay a host the beans they have available.

    P0-7 (FIN-5): when the card is FOR a queued request (`request_collection`
    + `request_id`), the request is checked here and settled — marked `paid` —
    only by executing this card, in the same transaction as the debit.

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

    settles: dict | None = None
    if (request_collection or "").strip() or (request_id or "").strip():
        await _payout_request_for_card(uid, request_collection, request_id, beans, agency_id)
        settles = {
            "request_collection": request_collection.strip(),
            "request_id": request_id.strip(),
        }

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
                # P0-7: the queued request this card settles, if any.
                **(settles or {}),
            },
        ),
        actor,
    )
    if warnings:
        card["warnings"] = warnings
    return card


class WithdrawalDebitNotConfirmed(PartnerOpsError):
    """HT-2 — the withdrawal's Firestore debit could not be confirmed, and none is recorded.

    409 when the database aborted it, 503 when its outcome is unknown (it may
    still land). The card stays approved; executing the same card again is safe.
    """

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


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

    # P0-7 (FIN-5): the queued request this card settles is marked `paid` in the
    # SAME Firestore transaction as the debit — the only way any request
    # becomes paid — and a request already paid refuses the whole thing.
    payload = card.get("payload") or {}
    settle = None
    if payload.get("request_id"):
        settle = {
            "collection": payload.get("request_collection", ""),
            "id": payload.get("request_id", ""),
            "card_id": card_id,
            "payment_ref": ref,
        }

    # HT-2 — the point of no return, as for a signed balance card: from here on
    # the card cannot be rejected (`cards.reject` refuses a claimed card), so a
    # debit that may have landed can only be finished by executing THIS card
    # again — never abandoned for a fresh card that would debit again.
    try:
        await card_svc.claim_execution(card_id, actor)
    except CardError as exc:
        raise PartnerOpsError(str(exc)) from exc

    # ── 1. The authoritative debit, guarded by a transaction ─────────────────
    #
    # HT-2: keyed on the card (`debit_id`), so the debit happens once per card
    # whatever is retried — the library re-running an attempt after a lost
    # answer, this card executed again, two executions at once. A card raised
    # without a payout request used to carry no key at all, and a re-run could
    # debit the wallet twice.
    try:
        debited = await asyncio.to_thread(
            firebase.debit_host_beans, host_uid, beans, settle, debit_id=f"card_{card_id}",
            # M-17: the app-visible `beanTransactions/card_{id}` row, in the
            # same transaction as the debit, so the host sees "paid out, UTR …".
            record_history={
                "id": f"card_{card_id}", "card_id": card_id, "payment_ref": ref,
                "reason": "withdrawal", "label": f"Withdrawal paid — {beans:,} beans",
            },
        )
    except (firebase.TransactionNotApplied, firebase.TransactionOutcomeUnknown) as exc:
        # HT-2: NOT "nothing was paid — raise a fresh one". The re-read found no
        # debit for this card, and a fresh card would have its own key: if this
        # debit still lands, a second card debits the wallet again. The card is
        # left APPROVED; executing it again is safe (keyed on the card).
        log.error("Host withdrawal %s: the bean debit was not confirmed (%s)", card_id, exc.outcome)
        raise WithdrawalDebitNotConfirmed(
            f"{exc} The card is still approved: execute THIS card again (do not raise a new "
            "one) — it records the debit if it happened and makes it once if it did not.",
            status_code=exc.status_code,
        ) from exc
    except firebase.PayoutRequestAlreadySettled as exc:
        # A repeated or raced execution of THIS card: the first one debited and
        # settled. The card is not marked failed — it did not fail.
        raise PartnerOpsError(
            "This card has already paid its request; nothing was debited again. "
            "Reload the board."
        ) from exc
    except firebase.PayoutRequestNotPayable as exc:
        detail = (
            f"{exc} Nothing was paid and nothing was debited — the card is "
            "marked failed."
        )
        await _finish(card_id, actor, {"error": detail, "payment_ref": ref}, False)
        raise PartnerOpsError(detail) from exc
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
        if isinstance(exc.__cause__, DuplicateMovement):
            # HT-2: the ledger already holds THIS card's withdrawal (keyed on the
            # card), and the debit is keyed on the card too: another execution of
            # this card did the work, or one was interrupted after its ledger row.
            # Nothing moved again. The card is closed as executed — the same as a
            # signed balance card — instead of being left approved for ever, or
            # marked failed ("needs manual correction") over a payout that is
            # complete: an execution that lost the race to write the row used to
            # do exactly that.
            try:
                await _finish(card_id, actor, {
                    "note": "Already applied — the ledger already holds this card's withdrawal.",
                    "payment_ref": ref, "host_id": host_uid, "beans": beans,
                }, True)
            except PartnerOpsError:
                pass  # another execution of this card closed it first
            raise PartnerOpsError(
                ("This card has already paid its request; nothing was debited again."
                 if settle else
                 "This card has already been executed; nothing was debited again.")
                + " The card has been closed."
            ) from exc
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
            **({"settled_request": f"{settle['collection']}/{settle['id']}"} if settle else {}),
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

    await _claim(card_id, actor)
    try:
        movement, replayed = await _move_once(
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
    # Conditional on leg 1 still pending: a replayed execution finds it paid
    # and leaves the first record (who paid, when, which reference) untouched.
    payout = await get_db()[SUBAGENCY_PAYOUTS].find_one_and_update(
        {"card_id": card_id, "status": PayoutStatus.PENDING},
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
    if payout is None:
        payout = await get_db()[SUBAGENCY_PAYOUTS].find_one({"card_id": card_id})

    if not replayed:
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


# ══════════════════════════════════════════════════════════════════════════════
# Executors, registered for the owner fast path (§8)
# ══════════════════════════════════════════════════════════════════════════════
#
# `cards.owner_fast_path(..., execute=True)` runs the type's executor after the
# signature. The board cannot import this module (it imports the board), so
# each executor registers itself here, normalised to one signature:
# `async (card_id, actor, *, payment_ref="") -> dict`. A payout needs a bank
# reference and refuses without one, exactly as its own route does.


async def _exec_coin_purchase(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_coin_purchase(card_id, actor)


async def _exec_lending(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_lending(card_id, actor)


async def _exec_repayment(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_repayment(card_id, actor)


async def _exec_recovery(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_recovery(card_id, actor)


async def _exec_write_off(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_write_off(card_id, actor)


async def _exec_commission_payout(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_commission_payout(card_id, payment_ref, actor)


async def _exec_host_withdrawal(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_host_withdrawal(card_id, payment_ref, actor)


async def _exec_subagency_payout(card_id: str, actor: dict, *, payment_ref: str = "") -> dict:
    return await execute_subagency_payout(card_id, payment_ref, actor)


card_svc.register_executor(CardType.SELLER_COIN_PURCHASE, _exec_coin_purchase)
card_svc.register_executor(CardType.LENDING_ISSUE, _exec_lending)
card_svc.register_executor(CardType.LENDING_REPAY, _exec_repayment)
card_svc.register_executor(CardType.LENDING_RECOVER, _exec_recovery)
card_svc.register_executor(CardType.BAD_DEBT_WRITE_OFF, _exec_write_off)
card_svc.register_executor(CardType.COMMISSION_PAYOUT, _exec_commission_payout)
card_svc.register_executor(CardType.HOST_WITHDRAWAL, _exec_host_withdrawal)
card_svc.register_executor(CardType.SUBAGENCY_PAYOUT, _exec_subagency_payout)
