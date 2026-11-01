"""Short-lived access to a KYC or identity document.

── THE PROBLEM THIS REPLACES ────────────────────────────────────────────────

Every KYC document in the product was stored as the string
``getDownloadURL()`` returned — ``.../o/<object>?alt=media&token=<uuid>``.
That is a **permanent bearer credential**. A download URL carries its own
token and Storage Security Rules are not consulted when one is used, so
whoever holds the string reads the file: forever, unauthenticated, from
anywhere, long after the person left the company or the agency was rejected.
It survives in browser history, in a forwarded support email, in a screenshot,
and in any database row that ever copied it.

Tightening ``storage.rules`` does not touch this, which is the point worth
being clear about: the rules govern the SDK path, and a download URL does not
take the SDK path.

── WHAT REPLACES IT ─────────────────────────────────────────────────────────

The CRM asks this service for a document. The service authorises the caller
against the partner record, resolves the stored string to a bucket object, and
mints a v4 signed URL good for fifteen minutes. The permanent URL never leaves
the API.

── NO MIGRATION, AND WHY NONE IS NEEDED ─────────────────────────────────────

``verification._object_name`` already parses all three spellings that exist in
the data — a ``gs://`` path, a ``getDownloadURL()`` result with the object name
percent-encoded after ``/o/``, and a bare object path. So every
``kycDocUrls`` value already stored resolves to an object without being
rewritten. Nothing is backfilled and no document moves.

The stored strings stay as they are deliberately. They are the record of where
the file is; what changes is that they stop being handed to a browser.

── AUTHORISATION ────────────────────────────────────────────────────────────

Internal staff are gated on ``CAN_APPROVE_KYC`` — the same capability that
guards the host-verification queue, which is the same decision by another
name. Partners are allowed their own record and nothing else: an agency may
see the documents on its own agency, a seller on its own seller record. A host
or ordinary app user has no route here at all, because this router sits behind
``current_user`` and an app account has no API session.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core import roles as R
from app.core.deps import partner_ids_of
from app.core.roles import Permission, Role
from app.db import firebase
from app.services.verification import _sign

log = logging.getLogger(__name__)


class DocumentError(Exception):
    """The request cannot be served."""


class DocumentNotFound(DocumentError):
    """No such partner record, or it carries no documents."""


class DocumentForbidden(DocumentError):
    """The caller may not see this record's documents."""


#: Where each kind's documents live, and which fields hold them.
#:
#: Spelled out per kind rather than inferred, because the three differ and the
#: differences are load-bearing: an agency keeps three strings in an array, a
#: seller keeps a single registration proof string AND an array of
#: ``{label, url}`` maps written by the staff registration form, and a host
#: application keeps three strings plus a reference photograph.
_SOURCES: dict[str, dict[str, Any]] = {
    "agency": {
        "collection": "agencies",
        "arrays": ["kycDocUrls"],
        "labelled": [],
        "singles": [],
    },
    "seller": {
        "collection": "sellers",
        "arrays": [],
        "labelled": ["idDocUrls"],
        "singles": ["registrationProofUrl", "qrCodeUrl"],
    },
    "host": {
        "collection": "hostApplications",
        "arrays": ["kycDocUrls"],
        "labelled": [],
        "singles": ["photoUrl"],
    },
    # Sensitive financial evidence: the screenshot a seller attaches when they
    # say they have paid us for coin inventory. `BuyCoinScreen.kt:200` uploads
    # it to `coinPurchaseProofs/{sellerUid}/` and writes the download URL onto
    # the request document, so it had the same permanent-bearer-URL problem as
    # the KYC documents and is fixed the same way.
    "coin_purchase": {
        "collection": "coinPurchaseRequests",
        "arrays": [],
        "labelled": [],
        "singles": ["paymentProofUrl"],
    },
}

#: The slot name for each single-valued field. A caller may ask for one slot
#: rather than a whole record, which is what keeps a list view to ONE signature
#: per row instead of all three KYC documents it is not going to show.
_SLOT_OF = {
    "photoUrl": "photo",
    "registrationProofUrl": "proof",
    "qrCodeUrl": "qr",
    "paymentProofUrl": "proof",
}

#: Default labels for the three-document agency and host arrays, in the order
#: the signup forms upload them. Matches the CRM's own labelling.
_ARRAY_LABELS = ["Aadhaar", "PAN", "Bank passbook"]


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _collect(
    record: dict[str, Any], spec: dict[str, Any], slots: set[str] | None = None
) -> list[dict[str, str]]:
    """Every document on a record, as ``{slot, label, stored}`` triples.

    ``slots`` filters to the named slots. Signing is not free — each URL is a
    v4 signature — so a list view asking for fifty reference photographs must
    not also sign a hundred and fifty KYC documents it will never render.
    """
    out: list[dict[str, str]] = []

    def want(slot: str) -> bool:
        return slots is None or slot in slots

    for field in spec["arrays"]:
        for i, raw in enumerate(record.get(field) or []):
            stored = _text(raw)
            slot = f"doc{i + 1}"
            if stored and want(slot):
                label = _ARRAY_LABELS[i] if i < len(_ARRAY_LABELS) else f"Document {i + 1}"
                out.append({"slot": slot, "label": label, "stored": stored})

    for field in spec["labelled"]:
        for i, entry in enumerate(record.get(field) or []):
            if isinstance(entry, dict):
                stored = _text(entry.get("url"))
                slot = f"id{i + 1}"
                if stored and want(slot):
                    out.append({
                        "slot": slot,
                        "label": _text(entry.get("label")) or "Document",
                        "stored": stored,
                    })

    for field in spec["singles"]:
        stored = _text(record.get(field))
        slot = _SLOT_OF.get(field, field)
        if stored and want(slot):
            label = {
                "registrationProofUrl": "Registration proof",
                "photoUrl": "Reference photo",
                "qrCodeUrl": "Payment QR",
                "paymentProofUrl": "Payment proof",
            }.get(field, "Document")
            out.append({"slot": slot, "label": label, "stored": stored})

    return out


def _may_see(
    actor: dict, kind: str, record_id: str, record: dict[str, Any] | None = None
) -> bool:
    """Is this caller entitled to this record's documents?

    ── THE GATE IS "MAY VIEW", NOT "MAY DECIDE" ─────────────────────────────

    An earlier version of this gated on ``CAN_APPROVE_KYC``, reasoning that
    reviewing a document is the KYC decision by another name. The permission
    table says otherwise: ``CAN_APPROVE_KYC`` is held by **owner and ops_admin
    alone**, while ``/kyc``, ``/agencies``, ``/sellers`` and ``/hosts`` are all
    open to ``app_admin``, ``ops_member`` and the finance roles. So that gate
    would have shown half the review team a queue whose every document 403s —
    and the obvious "fix" for that, in a hurry, is to widen something.

    ``CAN_VIEW_AGENCIES`` / ``CAN_VIEW_SELLERS`` are the capabilities that
    actually mean "may look at this partner", and they are what the screens
    showing these documents are gated on.

    ── OBSERVER IS EXPLICIT, BECAUSE THE TABLE GIVES IT NOTHING ─────────────

    ``Role.OBSERVER`` holds no permission at all — it "reads everything,
    writes nothing" (spec 1.1), which the CRM implements as
    ``isObserver || canAccess(...)`` on each page rather than as table rows.
    ``has_permission`` therefore answers False for every question about it, so
    the read-only tier has to be named here or the observer silently loses the
    one thing it exists to do.

    ── MONEY EVIDENCE ASKS A DIFFERENT QUESTION ─────────────────────────────

    A coin-purchase proof is a bank screenshot, not an identity document, and
    it is gated on ``CAN_COIN_OPERATIONS`` — owner and the two finance roles.
    Deliberately NOT ``CAN_VIEW_FINANCE``, which ``app_admin`` also holds:
    being able to see finance summaries is not being entitled to a named
    seller's bank transfer screenshot.

    ── PARTNERS ────────────────────────────────────────────────────────────

    Scoped by ``partner_ids_of``, the session-derived authority
    ``own_partner_id_or_403`` uses everywhere else. Deliberately NOT by
    matching ``ownerUid``/``crmUid`` on the record: those are client-written
    at signup, so authorising on them would let a partner reach a record by
    writing its own uid into it.

    ``coin_purchase`` is the one kind keyed on an auto-id rather than a
    partner id, so whose it is can only be read off ``sellerUid`` — also
    client-written, but compared *against the session's own* partner ids, so
    a forged value can only ever narrow access, never widen it.

    A host application has no partner session that owns it, so ``host`` has no
    external branch at all — staff only, by omission.
    """
    role = str(actor.get("role", ""))
    is_observer = role == str(Role.OBSERVER)

    if kind == "coin_purchase":
        if is_observer or R.has_permission(role, Permission.CAN_COIN_OPERATIONS):
            return True
        seller_uid = _text((record or {}).get("sellerUid"))
        return bool(seller_uid) and seller_uid in partner_ids_of(actor, "seller")

    needed = (
        Permission.CAN_VIEW_SELLERS if kind == "seller" else Permission.CAN_VIEW_AGENCIES
    )
    if is_observer or R.has_permission(role, needed):
        return True

    if kind not in ("agency", "seller"):
        return False

    return record_id in partner_ids_of(actor, kind)


async def documents_for(
    kind: str, record_id: str, actor: dict, slots: set[str] | None = None
) -> dict[str, Any]:
    """Signed, short-lived links to one record's documents.

    Raises rather than returning an empty list when the caller is not
    entitled, so a partner probing another agency's id is refused rather than
    told "no documents" — which would confirm the record exists.
    """
    spec = _SOURCES.get(kind)
    if spec is None:
        raise DocumentError(f"Unknown document kind '{kind}'.")

    rid = (record_id or "").strip()
    if not rid:
        raise DocumentError("A record id is required.")

    snap = firebase.firestore_client().collection(spec["collection"]).document(rid).get()
    if not snap.exists:
        raise DocumentNotFound("No such record.")
    record = snap.to_dict() or {}

    if not _may_see(actor, kind, rid, record):
        raise DocumentForbidden("You cannot view this record's documents.")

    documents = []
    for item in _collect(record, spec, slots):
        url, problem = _sign(item["stored"])
        documents.append({
            "slot": item["slot"],
            "label": item["label"],
            # The signed URL, or None with a sentence saying why. Never the
            # stored permanent URL — that is the whole point of this service.
            "url": url,
            "error": problem,
        })

    return {
        "kind": kind,
        "id": rid,
        "documents": documents,
        # Stated so the CRM can re-request rather than render a dead image.
        "expires_in_seconds": 15 * 60,
    }


#: The most documents one batch may ask for. Each URL is a v4 signature, which
#: is real CPU, and an unbounded list is a free way to make the API work hard.
#: Fifty rows is more than any list page renders.
MAX_BATCH = 100


async def documents_batch(
    refs: list[dict[str, Any]], actor: dict
) -> dict[str, Any]:
    """Signed URLs for many records in one request.

    ── WHY A BATCH EXISTS ───────────────────────────────────────────────────

    The host lists render a reference photograph per row. Through
    :func:`documents_for` that is one HTTP request per row — fifty requests to
    draw one page, each with its own auth round-trip. The alternative the CRM
    had been using was to render the permanent ``?alt=media&token=`` URL
    straight out of Firestore, which is the thing this whole service exists to
    stop. So: one request, many records.

    ── AUTHORISATION IS PER RECORD, NOT PER REQUEST ─────────────────────────

    Every ref is resolved and authorised on its own, through the same
    :func:`_may_see` the single-record route uses. A batch is not a trust
    boundary: an agency asking for fifty host applications gets URLs for the
    ones it recruited and nothing for the rest.

    ── AN UNAUTHORISED REF IS OMITTED, NOT REFUSED ──────────────────────────

    It does not appear in the response at all, and the whole call still
    succeeds. Two reasons. A list page containing one row the caller may not
    see should render the other forty-nine rather than fail outright. And an
    explicit "forbidden" per ref would answer "does this record exist?" for
    ids the caller cannot see, which is an existence oracle the single-record
    route avoids by raising the same way for missing and forbidden.

    Keys are ``"{kind}:{id}"``.
    """
    if not isinstance(refs, list):
        raise DocumentError("refs must be a list.")
    if len(refs) > MAX_BATCH:
        raise DocumentError(f"At most {MAX_BATCH} documents may be requested at once.")

    out: dict[str, Any] = {}
    seen: set[str] = set()

    for ref in refs:
        if not isinstance(ref, dict):
            continue
        kind = _text(ref.get("kind"))
        rid = _text(ref.get("id"))
        spec = _SOURCES.get(kind)
        if spec is None or not rid:
            continue

        key = f"{kind}:{rid}"
        if key in seen:
            # A list can name the same record twice. Sign it once.
            continue
        seen.add(key)

        raw_slots = ref.get("slots")
        slots = {_text(x) for x in raw_slots if _text(x)} if isinstance(raw_slots, list) else None

        try:
            snap = (
                firebase.firestore_client()
                .collection(spec["collection"])
                .document(rid)
                .get()
            )
        except Exception as exc:  # noqa: BLE001 — one bad id must not fail the page
            log.warning("batch documents: could not read %s: %s", key, exc)
            continue
        if not snap.exists:
            continue
        record = snap.to_dict() or {}

        if not _may_see(actor, kind, rid, record):
            continue

        documents = []
        for item in _collect(record, spec, slots):
            url, problem = _sign(item["stored"])
            documents.append({
                "slot": item["slot"],
                "label": item["label"],
                "url": url,
                "error": problem,
            })
        if documents:
            out[key] = documents

    return {"documents": out, "expires_in_seconds": 15 * 60}
