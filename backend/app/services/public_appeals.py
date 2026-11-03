"""The PUBLIC appeal: filed from a web page, without signing in (UGP-F).

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

Appeals could only be filed from inside the Android app: with a session (a
banned login is disabled, so usually none), or through the device-key callable
`submitAccountAppeal`, which needs the quick-login credential of the SAME
install. A person on a new phone, after a reinstall, or simply on a computer
had no way to appeal at all.

── WHAT IT IS, AND WHAT IT IS NOT ──────────────────────────────────────────

  * It writes the EXISTING `appeals` collection, `kind: ban`, `status:
    pending` — the inbox, the decision and its audit are the ones staff already
    use (`services/appeals.py`). No parallel appeal system.
  * It NEVER lifts anything. Filing an appeal changes no restriction; only a
    reviewer's overturn does.
  * The account is identified by its account ID (the full ID shown on the
    Banned / Suspended screens), or by the display name together with the
    8-character ID shown on the profile — a "safe name lookup": the person
    supplies both, and the answer carries a masked name and nothing else.
  * WHAT THE PAGE CAN STILL TELL A STRANGER (UGP review — stated, not hidden):
    whether an appeal can be filed for the account those details name. That
    is what the page is for. A missing account and an unrestricted one get the
    SAME answer, and nothing more is ever returned without a session — not
    ban versus suspension, not who decided it, not the reference of an appeal
    already pending. Proof of possession (FLOW-MAP D9) and a fully generic
    answer (D11) are the decisions that would close the rest.
  * Attachments: up to 3 — images (JPEG / PNG / WebP, ≤ 5 MB) or video (MP4 /
    MOV / WebM, ≤ 20 MB) — typed from their CONTENT, not the browser's claim,
    stored privately in Storage and shown to staff only through short-lived
    signed links. No download URL is ever stored.
  * Rate-limited per client address (hashed) and per account. One pending
    appeal per account, the same rule `submitAccountAppeal` applies.
  * `originalDecidedBy` is set from who banned or suspended the account, so the
    four-eyes check in `decide_appeal` finally has something to compare with.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from google.cloud.firestore_v1.base_query import FieldFilter

from app.core import audit
from app.db import firebase
from app.db.mongo import C, get_db
from app.services import users as users_svc

log = logging.getLogger(__name__)

APPEALS = "appeals"
SOURCE = "public_web"

MIN_STATEMENT = 20          # the app's and the rules' bounds (AppealStatement, firestore.rules)
MAX_STATEMENT = 2000
MAX_FILES = 3
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_VIDEO_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 30 * 1024 * 1024   # under Cloud Run's 32 MiB request ceiling

LOOKUPS_PER_HOUR_PER_CLIENT = 20
SUBMITS_PER_HOUR_PER_CLIENT = 5
SUBMITS_PER_DAY_PER_ACCOUNT = 3

#: Who the audit entry names. A system actor: the filer is not a staff member
#: and has no session; the appeal itself records what they said.
PUBLIC_ACTOR = {"uid": "system:public_appeal", "name": "Public appeal form", "role": "system", "team": None}

APPEAL_SUBMITTED = "appeal.submitted"

NOT_FOUND = (
    "We could not find a restricted account with those details. Check the "
    "account ID on your Banned or Suspended screen and try again."
)
ALREADY_PENDING = (
    "An appeal for this account is already being reviewed. You will be able to "
    "file another once it has been decided."
)
#: §5 — "account-matching contact verification, mismatch error". The person
#: must give the phone number or the email address that is ON the account (the
#: Firebase Auth record — the verified identity, never the client-written
#: profile). A wrong one is refused with its own sentence, distinct from
#: NOT_FOUND, because the account was found and the proof was not.
CONTACT_REQUIRED = (
    "Enter the phone number or the email address that is on the account, so we "
    "can match the appeal to it."
)
CONTACT_MISMATCH = (
    "The contact details you entered do not match the ones on this account. "
    "Use the phone number or email address the account was registered with."
)


def normalise_contact(value: str) -> str:
    """One comparable form for a phone number or an email (pure).

    An email is lower-cased and stripped. A phone number is reduced to its
    digits with any trunk-prefix zeros dropped; `contact_matches` then accepts
    a number typed with or without the country code, so `+91 98765 43210`,
    `098765 43210` and `9876543210` all name one number.
    """
    text = str(value or "").strip()
    if "@" in text:
        return text.lower()
    return re.sub(r"\D", "", text).lstrip("0")


def contact_matches(supplied: str, phone: str, email: str) -> bool:
    """Does `supplied` name the account's phone or email (pure)?

    A phone matches when the shorter of the two digit strings (at least six
    digits) is the tail of the longer — the national number with or without
    its country code. Never a prefix match: a country code alone is not a
    phone number.
    """
    want = normalise_contact(supplied)
    if not want:
        return False
    if "@" in want:
        return bool(email) and want == normalise_contact(email)
    have = normalise_contact(phone)
    if len(want) < 6 or len(have) < 6:
        return False
    short, long_ = (want, have) if len(want) <= len(have) else (have, want)
    return long_.endswith(short)


def _account_contacts(uid: str) -> tuple[str, str]:
    """Blocking — `(phone, email)` from the Firebase Auth record; '' when absent.

    The email counts whether or not it is marked verified: it is the address
    the account was registered with, which is what the person is asked for.
    """
    try:
        rec = firebase.get_user(uid)
    except Exception:  # noqa: BLE001 — unreadable holds nothing
        return "", ""
    if rec is None:
        return "", ""
    return (
        str(getattr(rec, "phone_number", "") or "").strip(),
        str(getattr(rec, "email", "") or "").strip(),
    )


async def _refuse_unless_contact_matches(uid: str, contact: str) -> None:
    """Raise `PublicAppealError` unless `contact` names the account's phone or email."""
    if not str(contact or "").strip():
        raise PublicAppealError(CONTACT_REQUIRED)
    phone, email = await _fs(_account_contacts, uid)
    if not contact_matches(contact, phone, email):
        raise PublicAppealError(CONTACT_MISMATCH)


class PublicAppealError(Exception):
    """Refused. The message is written for the person on the public page."""


class RateLimited(PublicAppealError):
    pass


@dataclass(frozen=True)
class Upload:
    filename: str
    data: bytes


# ── Pure helpers (unit-tested) ───────────────────────────────────────────────

#: ISO base-media major brands that are an MP4 video (not HEIC/AVIF/M4A/3GP).
_MP4_BRANDS = frozenset({
    b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1",
    b"M4V ", b"mmp4", b"dash", b"MSNV",
})

#: A full account id (a Firebase uid) and the short profile id: letters and
#: digits (and `-`/`_` for the full id). Anything else — a `/` in particular,
#: which would address a sub-collection document — is not an account.
_FULL_ID = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
_SHORT_ID = re.compile(r"^[A-Za-z0-9]{6,12}$")

def sniff(data: bytes) -> tuple[str, str, str] | None:
    """`(content_type, kind, extension)` from the file's own bytes, or None."""
    head = data[:16]
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "image", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "image", "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", "image", "webp"
    if head[4:8] == b"ftyp":
        # The major brand decides it (UGP review): `ftyp` alone is also HEIC,
        # AVIF, M4A and 3GP. Only the brands phones and browsers write for an
        # MP4 or a QuickTime movie are video here.
        brand = head[8:12]
        if brand == b"qt  ":
            return "video/quicktime", "video", "mov"
        if brand in _MP4_BRANDS:
            return "video/mp4", "video", "mp4"
        return None
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm", "video", "webm"
    return None


def validate_uploads(files: list[Upload]) -> list[dict[str, Any]]:
    """Each upload typed and sized, or PublicAppealError. Nothing is stored."""
    files = [f for f in files if f.data]
    if len(files) > MAX_FILES:
        raise PublicAppealError(f"Attach at most {MAX_FILES} files.")
    out: list[dict[str, Any]] = []
    total = 0
    for f in files:
        kind = sniff(f.data)
        if kind is None:
            raise PublicAppealError(
                "Only screenshots (JPEG, PNG, WebP) and short videos (MP4, MOV, WebM) can be attached."
            )
        content_type, what, ext = kind
        size = len(f.data)
        limit = MAX_IMAGE_BYTES if what == "image" else MAX_VIDEO_BYTES
        if size > limit:
            raise PublicAppealError(
                f"Each {'image' if what == 'image' else 'video'} can be at most {limit // (1024 * 1024)} MB."
            )
        total += size
        out.append({"content_type": content_type, "kind": what, "ext": ext, "size": size, "data": f.data})
    if total > MAX_TOTAL_BYTES:
        raise PublicAppealError(f"All attachments together can be at most {MAX_TOTAL_BYTES // (1024 * 1024)} MB.")
    return out


def validate_statement(statement: str) -> str:
    text = (statement or "").strip()
    if len(text) < MIN_STATEMENT:
        raise PublicAppealError(f"Tell us what happened in at least {MIN_STATEMENT} characters.")
    if len(text) > MAX_STATEMENT:
        raise PublicAppealError(f"Keep the message under {MAX_STATEMENT} characters.")
    return text


def mask_name(name: str) -> str:
    """'Guest yrfdp' → 'G**** y****' — enough to recognise, too little to harvest."""
    parts = [p for p in str(name or "").split() if p]
    if not parts:
        return "—"
    return " ".join(p[0] + "*" * min(max(len(p) - 1, 1), 6) for p in parts[:3])


def reference_for(appeal_id: str) -> str:
    """A short, quotable reference that is not the document id itself."""
    digest = hashlib.sha256(f"appeal-ref:{appeal_id}".encode()).hexdigest()
    return "ZA-" + digest[:8].upper()


def client_key(client_address: str) -> str:
    """The rate-limit key for a client. The address itself is never stored."""
    return "c_" + hashlib.sha256(f"ugp-appeal:{client_address or 'unknown'}".encode()).hexdigest()[:32]


# ── Rate limits ──────────────────────────────────────────────────────────────

def _aware(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return None


async def _allow(key: str, limit: int, window: timedelta) -> bool:
    """Spend one unit of `key`'s budget, or refuse. Race-safe (UGP review).

    The increment is ONE conditional update — "still inside the window and
    under the limit" — so two requests at once cannot both read `limit - 1`
    and both go through. Only opening a fresh window is a read-then-write, and
    the worst it can do under a race is let a second request open the same
    window with count 1.
    """
    col = get_db()[C.PUBLIC_APPEAL_RATE]
    now = datetime.now(timezone.utc)
    spent = await col.find_one_and_update(
        {"_id": key, "window_start": {"$gt": now - window}, "count": {"$lt": limit}},
        {"$inc": {"count": 1}},
    )
    if spent is not None:
        return True
    row = await col.find_one({"_id": key})
    start = _aware((row or {}).get("window_start"))
    if row is None or start is None or now - start >= window:
        await col.update_one({"_id": key}, {"$set": {"window_start": now, "count": 1}}, upsert=True)
        return True
    return False


async def _over_budget(key: str, limit: int, window: timedelta) -> bool:
    """Read-only: has `key` already spent its budget in the current window?"""
    row = await get_db()[C.PUBLIC_APPEAL_RATE].find_one({"_id": key})
    start = _aware((row or {}).get("window_start"))
    if row is None or start is None or datetime.now(timezone.utc) - start >= window:
        return False
    return int(row.get("count") or 0) >= limit


async def client_over_submit_budget(client_address: str) -> bool:
    """For the route, BEFORE it reads a request body: is this client already
    out of submissions for the hour? Spends nothing — `submit` does that."""
    return await _over_budget(
        client_key(client_address) + ":submit", SUBMITS_PER_HOUR_PER_CLIENT, timedelta(hours=1)
    )


# ── Finding the account ──────────────────────────────────────────────────────

async def _fs(fn, *a, **kw):
    return await asyncio.to_thread(fn, *a, **kw)


def _users():
    return firebase.firestore_client().collection("users")


async def resolve_account(account_id: str, display_name: str = "") -> tuple[str, dict] | None:
    """`(uid, user)` for the account these details name, or None. Never raises."""
    account_id = (account_id or "").strip()
    name = (display_name or "").strip()
    if not (_FULL_ID.match(account_id) or _SHORT_ID.match(account_id)):
        return None
    try:
        if len(account_id) >= 20:
            snap = await _fs(_users().document(account_id).get)
            if getattr(snap, "exists", False):
                return snap.id, (snap.to_dict() or {})
            return None
        # The 8-character profile ID is the uid's prefix, upper-cased — so it is
        # only safe together with the exact display name.
        if 6 <= len(account_id) <= 12 and name:
            prefix = account_id.upper()
            seen: dict[str, dict] = {}
            for variant in {name, name.lower(), name.title()}:
                def _q(v=variant):
                    return list(_users().where(filter=FieldFilter("name", "==", v)).limit(25).stream())
                for snap in await _fs(_q):
                    if snap.id.upper().startswith(prefix):
                        seen[snap.id] = snap.to_dict() or {}
            if len(seen) == 1:
                uid, user = next(iter(seen.items()))
                return uid, user
    except Exception:  # noqa: BLE001 — an unreadable lookup is "not found"
        log.exception("public appeal lookup failed")
    return None


async def _decided_statements_for(uid: str, since: Any = None) -> list[str]:
    """RC: the statements of this account's DECIDED appeals for the current restriction."""
    cut = _aware(since)

    def _q():
        out: list[str] = []
        q = (
            firebase.firestore_client().collection(APPEALS)
            .where(filter=FieldFilter("subjectUid", "==", uid))
            .limit(50)
        )
        for snap in q.stream():
            d = snap.to_dict() or {}
            if str(d.get("status") or "pending") == "pending":
                continue
            created = _aware(d.get("createdAt"))
            if cut is not None and created is not None and created < cut:
                continue
            out.append(str(d.get("statement") or ""))
        return out

    return await _fs(_q)


async def _pending_appeal_for(uid: str) -> dict | None:
    def _q():
        q = (
            firebase.firestore_client().collection(APPEALS)
            .where(filter=FieldFilter("subjectUid", "==", uid))
            .where(filter=FieldFilter("status", "==", "pending"))
            .limit(1)
        )
        for snap in q.stream():
            return {"id": snap.id, **(snap.to_dict() or {})}
        return None

    return await _fs(_q)


async def lookup(
    account_id: str, display_name: str, client_address: str, contact: str = "",
) -> dict[str, Any]:
    """What the public page may be told about these details — and no more.

    §5: the contact (phone or email on the account) must match before anything
    beyond NOT_FOUND is said. A found account with a wrong contact is refused
    with `CONTACT_MISMATCH` — a distinct answer, as the spec asks, and one that
    is only reachable for an account that IS restricted (an unrestricted one
    answers NOT_FOUND first, so the mismatch error never confirms a ban).
    """
    if not await _allow(client_key(client_address) + ":lookup", LOOKUPS_PER_HOUR_PER_CLIENT, timedelta(hours=1)):
        raise RateLimited("Too many lookups from here. Try again in an hour.")
    found = await resolve_account(account_id, display_name)
    if found is None:
        return {"state": "not_found", "message": NOT_FOUND}
    uid, user = found
    restriction = users_svc.restriction_of(user)
    if not restriction:
        # The same answer as a missing account, on purpose.
        return {"state": "not_found", "message": NOT_FOUND}
    await _refuse_unless_contact_matches(uid, contact)
    # UGP review: nothing beyond "an appeal can (or cannot yet) be filed" —
    # not ban versus suspension, and not a pending appeal's reference, which
    # belongs to whoever filed it.
    if await _pending_appeal_for(uid):
        return {
            "state": "appeal_pending",
            "name_hint": mask_name(user.get("name", "")),
            "message": "An appeal for this account is already being reviewed.",
        }
    return {
        "state": "appealable",
        "name_hint": mask_name(user.get("name", "")),
    }


# ── Filing ───────────────────────────────────────────────────────────────────

def _upload_blob(path: str, data: bytes, content_type: str) -> None:
    from firebase_admin import storage as fb_storage

    fb_storage.bucket().blob(path).upload_from_string(data, content_type=content_type)


def _delete_blob(path: str) -> None:
    try:
        from firebase_admin import storage as fb_storage

        fb_storage.bucket().blob(path).delete()
    except Exception:  # noqa: BLE001 — best effort
        log.warning("public appeal: could not remove %s", path)


async def submit(
    account_id: str, display_name: str, statement: str, files: list[Upload], client_address: str,
    contact: str = "",
) -> dict[str, Any]:
    """File the appeal. Returns `{reference, status}`. Lifts nothing.

    §5: the contact must match the account (`_refuse_unless_contact_matches`);
    rate limits per client and per account, and one pending appeal per account,
    are the duplicate protection.
    """
    text = validate_statement(statement)
    checked = validate_uploads(files)

    if not await _allow(client_key(client_address) + ":submit", SUBMITS_PER_HOUR_PER_CLIENT, timedelta(hours=1)):
        raise RateLimited("Too many appeals from here. Try again in an hour.")

    found = await resolve_account(account_id, display_name)
    if found is None:
        raise PublicAppealError(NOT_FOUND)
    uid, user = found
    restriction = users_svc.restriction_of(user)
    if not restriction:
        raise PublicAppealError(NOT_FOUND)
    await _refuse_unless_contact_matches(uid, contact)
    if await _pending_appeal_for(uid):
        raise PublicAppealError(ALREADY_PENDING)
    # RC (confirmed): after a decision, another appeal needs new evidence or a
    # valid reason. Read against this restriction's decided appeals only.
    from app.services import appeal_policy  # local: a leaf module

    since = user.get("suspendedAt") if restriction == "suspended" else user.get("bannedAt")
    problem = appeal_policy.reappeal_problem(await _decided_statements_for(uid, since), text, len(checked))
    if problem:
        raise PublicAppealError(problem)
    if not await _allow(f"a_{uid}:submit", SUBMITS_PER_DAY_PER_ACCOUNT, timedelta(days=1)):
        raise RateLimited("Too many appeals for this account today. Try again tomorrow.")

    # UGP review: one pending appeal per account is a check-then-create, so two
    # submissions at once could both pass it. The account's filing is
    # serialised on a short lock row (unique `_id`); a lock left by a crashed
    # request is taken over once it is older than `_LOCK_TTL`.
    token = await _take_filing_lock(uid)
    if token is None:
        raise RateLimited("An appeal for this account is being filed right now. Try again in a minute.")
    try:
        return await _file(uid, user, restriction, text, checked)
    finally:
        await _release_filing_lock(uid, token)


_LOCK_TTL = timedelta(minutes=2)


async def _take_filing_lock(uid: str) -> str | None:
    """The account's filing lock, as a token only its holder can release — or
    None while somebody else holds it. A lock older than `_LOCK_TTL` (its
    holder crashed, or is still uploading on a very slow link) is taken over
    WITH A NEW TOKEN, so the slow holder's release cannot free it for a third."""
    col = get_db()[C.PUBLIC_APPEAL_RATE]
    now = datetime.now(timezone.utc)
    token = secrets.token_hex(8)
    try:
        await col.insert_one({"_id": f"lock_{uid}", "at": now, "token": token})
        return token
    except Exception as exc:  # noqa: BLE001 — only a duplicate means "held"
        if type(exc).__name__ != "DuplicateKeyError":
            raise
    stale = await col.find_one_and_update(
        {"_id": f"lock_{uid}", "at": {"$lt": now - _LOCK_TTL}},
        {"$set": {"at": now, "token": token}},
    )
    return token if stale is not None else None


async def _release_filing_lock(uid: str, token: str) -> None:
    try:
        await get_db()[C.PUBLIC_APPEAL_RATE].delete_one({"_id": f"lock_{uid}", "token": token})
    except Exception:  # noqa: BLE001 — it goes stale on its own
        log.warning("public appeal: filing lock not released")


async def _file(
    uid: str, user: dict, restriction: str, text: str, checked: list[dict[str, Any]],
) -> dict[str, Any]:
    """The filing itself, under the account's filing lock — which is why the
    pending check is made again here: the one before the lock is only the
    cheap early answer."""
    if await _pending_appeal_for(uid):
        raise PublicAppealError(ALREADY_PENDING)

    ref = firebase.firestore_client().collection(APPEALS).document()
    appeal_id = ref.id
    reference = reference_for(appeal_id)

    stored: list[dict[str, Any]] = []
    try:
        for i, f in enumerate(checked):
            path = f"appealEvidence/public/{appeal_id}/{i + 1}_{secrets.token_hex(4)}.{f['ext']}"
            await _fs(_upload_blob, path, f["data"], f["content_type"])
            stored.append({"path": path, "contentType": f["content_type"], "kind": f["kind"], "size": f["size"]})
    except Exception as exc:  # noqa: BLE001
        for s in stored:
            await _fs(_delete_blob, s["path"])
        log.exception("public appeal: attachment upload failed")
        raise PublicAppealError("The attachments could not be uploaded. Try again.") from exc

    decided_by = str(
        (user.get("suspendedBy") if restriction == "suspended" else user.get("bannedBy")) or ""
    )
    doc = {
        "subjectUid": uid,
        "subjectName": str(user.get("name") or ""),
        "raisedByUid": "",
        "raisedByName": "Public appeal form",
        "raisedByRole": "public",
        "agencyId": "",
        "kind": "ban",
        "reportId": "",
        "statement": text,
        # Never a download URL: staff read these through short-lived signed links.
        "evidenceUrls": [],
        "evidence": stored,
        "status": "pending",
        "createdAt": datetime.now(timezone.utc),
        "originalDecidedBy": decided_by,
        "source": SOURCE,
        "reference": reference,
        "restrictionAtFiling": restriction,
    }
    try:
        await _fs(ref.set, doc)
    except Exception as exc:  # noqa: BLE001
        for s in stored:
            await _fs(_delete_blob, s["path"])
        log.exception("public appeal: the appeal could not be written")
        raise PublicAppealError("Your appeal could not be saved. Try again.") from exc

    try:
        await audit.record(
            actor=PUBLIC_ACTOR,
            action=APPEAL_SUBMITTED,
            subject_type="appeal",
            subject_id=appeal_id,
            reason="Appeal filed through the public form.",
            after={"status": "pending"},
            meta={"subject_uid": uid, "source": SOURCE, "attachments": len(stored),
                  "reference": reference, "restriction": restriction},
        )
    except Exception:  # noqa: BLE001 — the appeal is filed; the log entry is not a reason to fail it
        log.exception("public appeal %s: audit entry not written", appeal_id)

    # QA #53: the account is told the appeal was received — in its Official
    # inbox and at its verified email, never on this unauthenticated page (which
    # already shows the reference). Never raises; the sweep retries a miss.
    from app.services import notices  # local: notices imports email, which imports settings

    try:
        await notices.appeal_receipt(uid, appeal_id, reference)
    except Exception:  # noqa: BLE001 — the appeal is filed; the notice is retried by the sweep
        log.exception("public appeal %s: the receipt notice was not delivered", appeal_id)

    return {"reference": reference, "status": "pending"}


# ── Staff: the evidence, through short-lived links ───────────────────────────

async def evidence_links(appeal_id: str) -> list[dict[str, Any]]:
    """Signed 15-minute links for an appeal's private attachments."""
    from app.services.verification import _sign  # the existing signer (IAM-capable)

    snap = await _fs(firebase.firestore_client().collection(APPEALS).document(appeal_id).get)
    if not getattr(snap, "exists", False):
        raise PublicAppealError("No appeal with that id.")
    data = snap.to_dict() or {}
    out: list[dict[str, Any]] = []
    for item in data.get("evidence") or []:
        path = str(item.get("path") or "")
        if not path.startswith("appealEvidence/"):
            continue
        url, error = await asyncio.to_thread(_sign, path)
        out.append({
            "url": url, "error": error, "kind": item.get("kind", ""),
            "contentType": item.get("contentType", ""), "size": item.get("size", 0),
        })
    return out
