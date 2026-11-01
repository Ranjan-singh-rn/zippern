"""Which partner roles one human may hold at once, enforced server-side.

── THE RULES ────────────────────────────────────────────────────────────────

                  Agency   Sub-agency   Coin Seller
    Agency          —          NO           YES
    Sub-agency      NO         —            YES
    Coin Seller    YES        YES            —

One human holds AT MOST ONE record from the agency family — a main Agency
*or* a Sub-agency, never both and never two of either — plus optionally one
Coin Seller.

A Sub-agency is a separate partner identity one level below an Agency. An
Agency legitimately has other humans as its sub-agencies; that parent/child
business relationship is a different thing from the Agency's own human also
holding a sub-agency role, and only the latter is forbidden.

── WHY THIS EXISTS ──────────────────────────────────────────────────────────

Production found one Firebase identity holding two main agencies:

    NqvNnhe6BY5GESpWjKIT  "Ruhan"  source=second_role  0 KYC documents
    mrXHV4SNmGhsdQ5d5k5Q  "Tan"    source=crm          3 KYC documents

Both carry `crmUid = ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2`. The session resolves only
the first, so the second is invisible to its own owner and visible to staff —
which is why it read as a KYC bug rather than a duplicate.

Every guard that existed was in the browser, and each was defeated a
different way:

  * `/agency-signup` checks for a duplicate and then does
    `if (existing.checked && matches.length > 0)` — so a lookup that could
    NOT be completed reads as "no duplicate" and the create proceeds.
    `/agencies/register` does the opposite and says so in a comment. One of
    the two was written carefully.

  * `requestSecondRole` asks `partnerRecordId(user, 'agency')`, which reads
    `crmUsers.agencyId` — a DENORMALISED field, not the records themselves.
    And `createAgencyAccount`/`createSellerAccount` write that document with
    `setDoc` and no `{merge: true}`, so any of them can erase the link the
    guard depends on. A guard that reads a field another writer can blank is
    not a guard.

  * Firestore Security Rules cannot help at all: answering "does another
    document already name this human" needs a collection query, and rules
    cannot query.

So the rule is enforced here, in the API, against Mongo — the one store no
client can write.

── HOW IT IS MADE RACE-SAFE WITHOUT A NEW INDEX ─────────────────────────────

Two simultaneous requests must not both pass a read-then-write check. The
usual answer is a unique compound index on `partners`, and it is the wrong
one here: **production currently holds the duplicate this module forbids**, so
a unique index would fail to build — and `ensure_indexes()` runs on every API
start, which would turn a data problem into an outage.

Instead each human's hold on a role family is claimed by inserting a sentinel
whose `_id` IS the claim:

    _id = "agency:ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2"

`_id` carries a unique index on every Mongo collection, always, with nothing
to build. Two concurrent inserts: one succeeds, the other raises
`DuplicateKeyError`. That is the whole mechanism, and it needs no
transaction, no new index, and no migration before it can be switched on.

The sentinel is a lock, not a second source of truth — `holder_of()` reads it
only to name who holds the family in an error message.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from pymongo.errors import DuplicateKeyError

from app.db.mongo import get_db

log = logging.getLogger(__name__)

#: The collection holding one sentinel per (human, role family).
PARTNER_ROLE_CLAIMS = "partner_role_claims"

#: Role family. Two records in the same family may not be held by one human.
AGENCY_FAMILY = "agency"
SELLER_FAMILY = "seller"

#: Partner kinds, as `partner_ops.PartnerKind` spells them, to their family.
#: `agency` and `sub_agency` share one family — that is the whole point.
_FAMILY_OF: dict[str, str] = {
    "agency": AGENCY_FAMILY,
    "sub_agency": AGENCY_FAMILY,
    "seller": SELLER_FAMILY,
}


#: How long a freshly taken claim is protected from hand-over (see
#: `claim_role_family`). Long enough to cover one approval's status write.
CLAIM_SETTLE = timedelta(seconds=60)


class RoleConflict(Exception):
    """This human already holds an incompatible partner role."""


# ── A revoked role is not "never applied" (C1 / B04) ──────────────────────────
#
# A revoked record keeps its place in the combination table and in the
# one-per-person lock. What the person may do about it is ask for it back —
# a reinstatement request decided by the Owner — not file a fresh application
# that would re-create the same role as a new record.

#: The sentence every refusal of a revoked kind carries. `{role}` is one of
#: Host / Agency / Sub-agency / Coin Seller.
REVOKED_REFUSAL = (
    "Your {role} role was revoked. Request reinstatement instead of applying again."
)

_ROLE_LABELS: dict[str, str] = {
    "host": "Host",
    "agency": "Agency",
    "sub_agency": "Sub-agency",
    "seller": "Coin Seller",
}


def revoked_refusal(kind: str) -> str:
    """`REVOKED_REFUSAL` for one kind, in the user's words."""
    k = str(kind or "").strip()
    return REVOKED_REFUSAL.format(role=_ROLE_LABELS.get(k, k.replace("_", "-").title()))


def family_of(kind: str) -> str | None:
    """The role family a partner kind belongs to, or None if unrecognised."""
    return _FAMILY_OF.get(str(kind or "").strip())


def allows(held: set[str], wanted: str) -> bool:
    """May a human holding `held` kinds also take `wanted`?

    Pure, and the one place the matrix is expressed. `held` is partner KINDS
    (`agency`, `sub_agency`, `seller`), not families — callers have kinds.
    """
    family = family_of(wanted)
    if family is None:
        return False
    return not any(family_of(k) == family for k in held)


def _claim_id(family: str, owner_uid: str) -> str:
    return f"{family}:{owner_uid}"


async def claim_role_family(
    owner_uid: str, kind: str, partner_id: str, *, actor: dict | None = None,
    decision: bool = False,
) -> None:
    """Reserve this human's hold on `kind`'s family, or raise `RoleConflict`.

    Call BEFORE creating the partner record. The insert is the lock: if a
    concurrent request is creating the same family for the same human, one of
    the two raises here and no second record is written.

    `owner_uid` must be the Firebase uid — the authoritative human identity.
    Email is deliberately not used: it is mutable, it is absent on some
    records, and `crmUid` is what every partner document already carries.
    """
    uid = str(owner_uid or "").strip()
    if not uid:
        # Refusing is the safe answer. A create whose owner cannot be
        # identified cannot be governed by a per-human rule, and allowing it
        # "because we could not tell" is exactly the fail-open that let the
        # duplicate through in the browser.
        raise RoleConflict(
            "This partner record names no Firebase identity, so the "
            "one-agency-per-human rule cannot be applied to it. Nothing was "
            "created. Link the record to a login and try again."
        )

    family = family_of(kind)
    if family is None:
        raise RoleConflict(f"'{kind}' is not a partner kind this rule knows.")

    doc = {
        "_id": _claim_id(family, uid),
        "owner_uid": uid,
        "family": family,
        "kind": str(kind),
        "partner_id": str(partner_id),
        "claimed_at": datetime.now(timezone.utc),
        "claimed_by": (actor or {}).get("uid", ""),
        "claimed_via": "decision" if decision else "create",
    }
    db = get_db()
    try:
        await db[PARTNER_ROLE_CLAIMS].insert_one(doc)
    except DuplicateKeyError:
        pass
    else:
        # ── THE SENTINEL IS THE LOCK; THE RECORDS ARE THE TRUTH ─────────────
        #
        # Taking the sentinel proves nobody is claiming this family RIGHT NOW.
        # It proves nothing about the past: this collection was created with
        # this rule, so it is empty for every partner that already exists.
        # Production holds two agencies for one human and not one claim
        # document describing either of them.
        #
        # Without this, the rule would only govern records created after it
        # shipped, and `attach_login` — whose whole job is records that
        # already exist — would wave through a second agency for somebody who
        # has run one for a year. That is the exact case this was asked for.
        #
        # So the sentinel goes in FIRST and the records are read UNDER it: a
        # concurrent caller is already blocked by `_id` while this runs, and
        # if the read turns up a live holder the sentinel is given straight
        # back. Checking before the insert instead would be the read-then-
        # write race the lock exists to remove.
        #
        # No backfill is needed and none is wanted — asking the authoritative
        # collection is what makes the sentinel's emptiness harmless.
        prior = await _live_record_in_family(uid, family, exclude=str(partner_id))
        if prior is None:
            return
        await db[PARTNER_ROLE_CLAIMS].delete_one({"_id": doc["_id"]})
        raise _conflict(family, {
            "kind": str(prior.get("kind") or family),
            "partner_id": str(prior.get("_id") or "unknown"),
        })

    held = await holder_of(uid, family)
    held_id = str((held or {}).get("partner_id", ""))

    # ── THE SAME HUMAN, THE SAME RECORD, TWICE IS NOT A CONFLICT ────────────
    #
    # Two different writers legitimately claim the same pairing. A partner
    # created from a Firestore document carrying `ownerUid` is claimed by
    # `ensure_partner_record`; `attach_login` later gives that same record a
    # CRM login for the same human and claims again. Nothing has changed
    # hands — the slot is already held by exactly this record — so refusing
    # would block the one operation this rule is supposed to permit, and
    # report it as a duplicate-agency violation while doing so.
    #
    # Checked before the release branch below, because the answer does not
    # depend on the holder's status: a SUSPENDED agency re-affirming its own
    # claim must succeed, even though a suspension does not release the slot
    # for anybody else.
    if held_id and held_id == str(partner_id):
        if decision:
            # Re-affirmed by an approval/reactivation: mark the claim as a
            # decision in flight (so a concurrent approval of ANOTHER record
            # cannot take it over in the moment before this record's status
            # changes), and do it as a compare-and-set — if somebody moved the
            # claim between the read and now, this record no longer holds it.
            kept = await db[PARTNER_ROLE_CLAIMS].find_one_and_update(
                {"_id": _claim_id(family, uid), "partner_id": held_id},
                {"$set": {"claimed_via": "decision", "claimed_at": datetime.now(timezone.utc)}},
            )
            if kept is None:
                raise _conflict(family, await holder_of(uid, family)) from None
        return

    # ── A REJECTED RECORD DOES NOT HOLD THE SLOT ────────────────────────────
    #
    # The rule is one agency-family record per human. An application that was
    # rejected must not bar the person from applying again —
    # `test_second_role` says so in as many words: "Released, so a fresh
    # application may be filed." A permanent claim would have made a single
    # rejection a life sentence, which is a worse bug than the one this module
    # exists to fix. A REVOKED record is different (C1): the role existed and
    # was taken away, so it keeps the slot until the Owner restores it or
    # keeps it revoked — see `_RELEASABLE_STATUSES`.
    #
    # The hand-over is a compare-and-set on the claim's own `partner_id`, so
    # it is as race-safe as the insert above: if two callers both find the
    # slot held by a dead record, the filter matches for exactly one of them
    # and the loser falls through to the refusal.
    # A claim an APPROVAL/REACTIVATION took moments ago belongs to a decision IN FLIGHT: approving or
    # reactivating a rejected/revoked record takes the slot first and changes
    # the record's status a moment later. In that window the holder still
    # reads as releasable, and handing it over would let two concurrent
    # approvals both succeed. So a fresh claim is never handed over.
    claimed_at = (held or {}).get("claimed_at")
    fresh = False
    if (held or {}).get("claimed_via") == "decision" and isinstance(claimed_at, datetime):
        at = claimed_at if claimed_at.tzinfo else claimed_at.replace(tzinfo=timezone.utc)
        fresh = datetime.now(timezone.utc) - at < CLAIM_SETTLE
    if held_id and not fresh and await _is_releasable(held_id):
        # ── COMPARE-AND-SET ON THE CLAIM'S VERSION, NOT ONLY ITS HOLDER ──────
        #
        # Phase 1A validation found this hand-over could let TWO concurrent
        # approvals both succeed for one human: the caller read the claim
        # (holder X, an old `create` claim, so "not fresh"), then X's own
        # approval re-affirmed it (`claimed_via: decision`, new `claimed_at`)
        # and approved X — and this CAS, matching on `partner_id` alone,
        # still matched and moved the slot away from the record that had just
        # been approved. Reproduced deterministically by
        # tests/test_partner_lifecycle.py "B3.6b".
        #
        # Matching the `claimed_at` / `claimed_via` that were READ makes the
        # hand-over fail if anybody touched the claim in between; the loser
        # then falls through to the refusal below.
        taken = await db[PARTNER_ROLE_CLAIMS].find_one_and_update(
            {
                "_id": _claim_id(family, uid),
                "partner_id": held_id,
                "claimed_at": (held or {}).get("claimed_at"),
                "claimed_via": (held or {}).get("claimed_via"),
            },
            {"$set": {
                "partner_id": str(partner_id),
                "kind": str(kind),
                "claimed_at": datetime.now(timezone.utc),
                "claimed_by": (actor or {}).get("uid", ""),
                "claimed_via": "decision" if decision else "create",
                "released_from": held_id,
            }},
        )
        if taken is not None:
            log.info(
                "partner role claim %s moved from %s to %s",
                _claim_id(family, uid), held_id, partner_id,
            )
            return
        held = await holder_of(uid, family)

    raise _conflict(family, held) from None


async def release_claim_of(owner_uid: str, kind: str, partner_id: str) -> bool:
    """Decision 16 (RC): a REJECTED application gives its slot back, now.

    The hand-over in `claim_role_family` already treats a rejected holder as
    releasable, so the next application by this human takes the slot anyway.
    Releasing it at the rejection makes the rule literal — "rejection releases
    the registration slot" — and keeps `holder_of()` from naming a refused
    application as what the person holds.

    A compare-and-delete on the claim's own `partner_id`: if the slot has
    already moved to a newer application (a re-application filed meanwhile),
    nothing is touched. Returns True when a claim was released.
    """
    uid = str(owner_uid or "").strip()
    family = family_of(kind)
    if not uid or family is None or not partner_id:
        return False
    try:
        res = await get_db()[PARTNER_ROLE_CLAIMS].delete_one(
            {"_id": _claim_id(family, uid), "partner_id": str(partner_id)}
        )
    except Exception:  # noqa: BLE001 — the hand-over still treats it as releasable
        log.warning("could not release the %s claim of %s for %s", family, uid, partner_id)
        return False
    return bool(getattr(res, "deleted_count", 0))


def _conflict(family: str, held: dict[str, Any] | None) -> RoleConflict:
    """The refusal, worded for the family that was actually refused.

    The explanation differs by family, and saying the wrong one is worse than
    saying none: a seller conflict reported as "an Agency and a Sub-agency are
    the same family" reads as a bug in the rule rather than a refusal of the
    request.

    One builder because there are now two callers — the sentinel collision and
    the pre-existing-record check — and two copies of a refusal message are two
    chances for one of them to describe a rule the code does not apply. That is
    the exact failure this module was written to fix.
    """
    existing_kind = str((held or {}).get("kind", family))
    if family == AGENCY_FAMILY:
        why = (
            "An Agency and a Sub-agency are the same family, so neither can be "
            "added to the other. A Coin Seller alongside either is allowed and "
            "is unaffected."
        )
    else:
        why = "A Coin Seller alongside an Agency or a Sub-agency is allowed."
    return RoleConflict(
        f"This person already holds a {existing_kind.replace('_', '-')} "
        f"({(held or {}).get('partner_id', 'unknown')}). One human may hold "
        f"one {family} record. {why} Nothing was created."
    )


async def _live_record_in_family(
    owner_uid: str, family: str, *, exclude: str = ""
) -> dict[str, Any] | None:
    """A partner record this human already holds in `family`, or None.

    Reads the authoritative `partners` collection, not the claim sentinels, so
    the rule applies to every record that exists — including the ones that
    predate this module and have no sentinel at all.

    `owner_crm_uid` is the field: it is what `resolve_partner_login` resolves a
    session against, which makes it the field that decides who a record
    actually belongs to. B07: a record whose Mongo link was never written but
    whose Firestore document names this human (`crmUid` / `ownerUid`) is found
    too — see `records_owned_by` — because many CRM-registered partners carry
    their owner only there, and a rule that cannot see them is not a rule.

    A REJECTED record is skipped, for the same reason `_is_releasable` exists:
    a refused application must not bar a later attempt. A REVOKED record is
    NOT skipped (C1): the role was held and taken away, and it keeps its place
    until the Owner decides a reinstatement request. `suspended` is not skipped
    either — the business still exists and keeps its place.
    """
    uid = str(owner_uid or "").strip()
    if not uid:
        return None

    for row in await records_owned_by(uid):
        if str(row.get("_id") or "") == exclude:
            continue
        if family_of(str(row.get("kind") or "")) != family:
            continue
        if str(row.get("status") or "").strip() in _RELEASABLE_STATUSES:
            continue
        return row
    return None


# ── Who a partner record belongs to (B07) ─────────────────────────────────────
#
# `owner_crm_uid` on the Mongo record is the authoritative link, and it is
# written at birth for every record created since ownership was written at
# creation. Many older or CRM-registered records do not carry it: the
# `/agencies/register` and `/sellers/register` screens write `crmUid` onto the
# Firestore document after the record exists, and nothing copied it across.
# Every per-person rule that read only the Mongo field therefore could not see
# those records, so their owner could be approved as a Host or for a second
# Agency. These two helpers are the one place the fallback lives.


def _owner_on_document(source: dict) -> str:
    """The human a Firestore agency/seller document names: `crmUid`, else `ownerUid`."""
    for field in ("crmUid", "ownerUid"):
        value = str((source or {}).get(field) or "").strip()
        if value:
            return value
    return ""


def _firestore_owner_of(record: dict) -> str:
    """Blocking — the owner named on the record's Firestore document, or ''."""
    from app.db import firebase

    collection = "sellers" if str(record.get("kind") or "") == "seller" else "agencies"
    try:
        snap = (
            firebase.firestore_client()
            .collection(collection)
            .document(str(record.get("_id") or ""))
            .get()
        )
    except Exception:  # noqa: BLE001 — unreadable is not an owner
        log.warning("Could not read the owner of %s/%s", collection, record.get("_id"))
        return ""
    if not getattr(snap, "exists", False):
        return ""
    return _owner_on_document(snap.to_dict() or {})


async def _persist_owner(record: dict, uid: str, db=None) -> None:
    """Write `owner_crm_uid` onto a record that still has none — conditionally.

    The filter carries the value that was READ (missing/None or ""), so a link
    written by somebody else in the meantime is never overwritten. Best effort:
    the answer is correct for this call either way.
    """
    from app.db.mongo import C

    try:
        await (db if db is not None else get_db())[C.PARTNERS].update_one(
            {"_id": record["_id"], "owner_crm_uid": record.get("owner_crm_uid")},
            {"$set": {
                "owner_crm_uid": uid,
                "owner_resolved_from": "firestore_document",
                "owner_resolved_at": datetime.now(timezone.utc),
            }},
        )
    except Exception:  # noqa: BLE001
        log.exception("owner_crm_uid could not be persisted on %s", record.get("_id"))


async def owner_uid_of(record: dict | None, *, db=None) -> str:
    """The human behind a partner record (B07).

    Mongo `owner_crm_uid` first; otherwise the Firestore document's `crmUid` /
    `ownerUid`, which is then persisted onto the Mongo record when it is still
    empty, so the next reader does not need Firestore.
    """
    if not record:
        return ""
    uid = str(record.get("owner_crm_uid") or "").strip()
    if uid:
        return uid
    import asyncio

    uid = await asyncio.to_thread(_firestore_owner_of, record)
    if uid:
        await _persist_owner(record, uid, db)
    return uid


def _linked_partner_ids(uid: str) -> list[str]:
    """Blocking — ids of the agency/seller documents whose owner is this human.

    "Owner" exactly as `owner_uid_of` reads it — `crmUid`, else `ownerUid` — so
    a document whose `ownerUid` names this person while its `crmUid` names a
    different login is that login's, here as everywhere else.
    """
    from google.cloud.firestore_v1.base_query import FieldFilter

    from app.db import firebase

    found: list[str] = []
    try:
        client = firebase.firestore_client()
        for collection in ("agencies", "sellers"):
            for field in ("crmUid", "ownerUid"):
                for snap in client.collection(collection).where(
                    filter=FieldFilter(field, "==", uid)
                ).stream():
                    if snap.id not in found and _owner_on_document(snap.to_dict() or {}) == uid:
                        found.append(snap.id)
    except Exception:  # noqa: BLE001 — the Mongo link still answers
        log.warning("Firestore owner links for %s could not be read", uid)
    return found


async def records_owned_by(owner_uid: str, *, db=None) -> list[dict]:
    """Every Mongo partner record this human owns, by either link (B07).

    The Mongo `owner_crm_uid` query, plus every record whose Firestore document
    names them while its Mongo link is still empty — and only then: a record
    whose Mongo link names somebody ELSE belongs to that somebody, whatever its
    Firestore document says. Found records get their link persisted.
    """
    import asyncio

    from app.db.mongo import C

    uid = str(owner_uid or "").strip()
    if not uid:
        return []
    handle = db if db is not None else get_db()
    rows: list[dict] = []
    seen: set[str] = set()
    async for row in handle[C.PARTNERS].find({"owner_crm_uid": uid}):
        seen.add(str(row.get("_id") or ""))
        rows.append(row)
    for pid in await asyncio.to_thread(_linked_partner_ids, uid):
        if pid in seen:
            continue
        row = await handle[C.PARTNERS].find_one({"_id": pid})
        if row is None or str(row.get("owner_crm_uid") or "").strip():
            continue
        seen.add(pid)
        await _persist_owner(row, uid, handle)
        rows.append({**row, "owner_crm_uid": uid})
    return rows


#: Statuses that mean the holder is no longer a live partner, so the slot is
#: free.
#:
#: ── THE LIFECYCLE, STATED ONCE ──────────────────────────────────────────────
#:
#:   pending    → holds the slot (an application in flight is a claim)
#:   approved   → holds the slot
#:   suspended  → holds the slot. A suspension is TEMPORARY and operational —
#:                the business still exists, `reactivate_partner` restores it
#:                unchanged — so the human keeps their place while it lasts.
#:   rejected   → releases it. A refused application must not bar a second.
#:   revoked    → HOLDS it (C1 / B04). The role was taken away, the record
#:                stays as history, and the way back is a reinstatement request
#:                the Owner decides — which restores THIS record. Releasing the
#:                slot here is what let a revoked role be re-created as a new
#:                record, i.e. treated as though it had never existed.
#:
#: `revoked` was missing, and so was the state itself: "Deactivate" in the CRM
#: wrote `suspended`, nothing ever wrote anything else, and `suspended` keeps
#: the slot — so a deactivated Agency, Sub-agency or Coin Seller could never
#: re-apply for that family, for ever, and no CRM surface could clear it.
#: Because Agency and Sub-agency share one family, a deactivated sub-agency
#: also barred that person from ever running a main agency. A suspension had
#: become a life sentence, which is exactly the outcome the rejection rule
#: below was written to prevent.
#:
#: `partner_ops.revoke_partner` is the only writer of `revoked`, and it no
#: longer calls `release_role_family`: the record-based check and the
#: sentinel agree that a revoked record still holds the slot.
_RELEASABLE_STATUSES = {"rejected"}


async def _is_releasable(partner_id: str) -> bool:
    """Has the holding record stopped holding the slot?

    A rejected record releases the slot. Nothing else does — not a revoked
    one (C1), which keeps it until the Owner decides its reinstatement.

    A MISSING record deliberately does not, though it looks like it should.
    `partner_ops.create` takes the claim BEFORE inserting the partner row, so
    between those two statements the claim exists and the row does not — and
    a concurrent second create reading "no row, therefore free" would take
    the lock straight off the caller who is mid-create. That would undo the
    whole point of claiming first. A genuinely orphaned claim is rarer than
    that race and is better fixed by hand than by a rule that silently
    defeats the lock.
    """
    from app.db.mongo import C

    row = await get_db()[C.PARTNERS].find_one({"_id": partner_id})
    if row is None:
        return False
    return str(row.get("status", "")).strip() in _RELEASABLE_STATUSES


async def release_role_family(owner_uid: str, kind: str) -> None:
    """Give the hold back.

    One kind of caller: the rollback path — a create or a login attachment
    that took the claim and then failed. A claim left behind would lock the
    human out of ever holding that family, a worse failure than the one it
    was guarding against.

    `partner_ops.revoke_partner` used to call this too, and that was the
    defect (B04): a revoked role is still held for the combination rules, so
    revocation keeps the claim and the record keeps its place.
    """
    uid = str(owner_uid or "").strip()
    family = family_of(kind)
    if not uid or family is None:
        return
    await get_db()[PARTNER_ROLE_CLAIMS].delete_one({"_id": _claim_id(family, uid)})


async def holder_of(owner_uid: str, family: str) -> dict[str, Any] | None:
    """The claim this human holds on `family`, or None. Read-only."""
    uid = str(owner_uid or "").strip()
    if not uid:
        return None
    return await get_db()[PARTNER_ROLE_CLAIMS].find_one({"_id": _claim_id(family, uid)})


async def families_held(owner_uid: str) -> dict[str, dict[str, Any]]:
    """Every family this human holds, keyed by family. Read-only."""
    uid = str(owner_uid or "").strip()
    if not uid:
        return {}
    out: dict[str, dict[str, Any]] = {}
    async for row in get_db()[PARTNER_ROLE_CLAIMS].find({"owner_uid": uid}):
        out[str(row.get("family"))] = row
    return out
