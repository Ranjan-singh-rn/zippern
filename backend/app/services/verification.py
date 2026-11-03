"""Host identity verification review.

The agency uploads a photograph when it registers a host. The host takes a live
capture in the app. Something compares them. When the comparison is unsure — and
until a server-side face provider is configured, that is every time — a person
decides here.

── Why the review lives in this backend and not in a Cloud Function ───────────

Because of the audit log. Approving a verification is what sets
`users/{uid}.isVerifiedHost`, and that flag is what `releaseBeansForWeek` checks
before it releases a week's earnings for withdrawal. So a verification approval
is the moment someone becomes payable, and it belongs in the same append-only
trail as bans, balance cards and payouts — which is Mongo, written by
`app.core.audit`, and read by `/audit`.

A Cloud Function cannot write that trail. A first cut of this had the callable
write an `auditLog` collection in Firestore instead, which nothing reads: a
decision about a person's identity and their ability to be paid, recorded
somewhere no owner would ever look. Two trails is worse than one, so there is
one review path and it is this.

── Faces are not served from a public bucket ──────────────────────────────────

Face images are biometric data under India's DPDP Act. Reviewers see them
through short-lived signed URLs minted per review, rather than by holding
standing read access to a bucket of photographs. The URL outlives the decision
by minutes, not forever.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core import audit
from app.db import firebase

log = logging.getLogger(__name__)

VERIFICATION = "hostVerification"
USERS = "users"

#: How long a reviewer's view of a face stays valid. Long enough to look at two
#: photographs and decide; short enough that a copied link is not a standing
#: grant.
SIGNED_URL_TTL = timedelta(minutes=15)

#: Only these are awaiting a human. `pending_capture` means the host has not
#: submitted yet, and is not a queue item.
REVIEWABLE = ("pending_manual",)


class VerificationError(Exception):
    """Something the caller can fix."""


class VerificationNotFound(VerificationError):
    pass


class VerificationNotApplied(VerificationError):
    """HT-2 — the decision's transaction failed and the decision is not visible.

    409 when the database aborted it, 503 when its outcome could not be
    established (it may still land). Deciding again is safe: a decision that
    landed makes the record no longer reviewable, so it cannot be applied twice.
    """

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


REVIEW_NOT_APPLIED = (
    "The database was busy and did not record this decision: the verification is still "
    "waiting for one. Decide it again — it cannot be applied twice."
)
REVIEW_UNKNOWN = (
    "The database did not confirm this decision, and it is not recorded yet — but it may "
    "still complete. Reload the verification before deciding again; deciding again is "
    "safe, it cannot be applied twice."
)


async def _fs(fn, *args, **kwargs):
    """Firestore's client is synchronous; keep it off the event loop."""
    return await asyncio.to_thread(fn, *args, **kwargs)


def _ref(uid: str):
    if not uid or not uid.strip():
        raise VerificationError("A host id is required.")
    return firebase.firestore_client().collection(VERIFICATION).document(uid.strip())


def _require_reason(reason: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < 3:
        # The note is the whole value of a manual review. "Rejected" with no
        # words is indistinguishable from a misclick six months later, and the
        # host is told to ask their agency to re-upload — so somebody has to be
        # able to find out what was actually wrong.
        raise VerificationError("A note is required — say what you saw.")
    return reason


# ── Reading the queue ─────────────────────────────────────────────────────────


async def list_pending(limit: int = 50) -> list[dict[str, Any]]:
    """Hosts waiting on a human decision, oldest first.

    Oldest first on purpose: a verification queue sorted newest-first quietly
    strands whoever has been waiting longest, and they are the one who cannot
    withdraw.
    """
    col = firebase.firestore_client().collection(VERIFICATION)
    query = col.where("status", "in", list(REVIEWABLE)).limit(limit)
    docs = await _fs(lambda: list(query.stream()))

    rows = []
    for doc in docs:
        d = doc.to_dict() or {}
        rows.append(
            {
                "uid": doc.id,
                "hostName": d.get("hostName", ""),
                "agencyId": d.get("agencyId", ""),
                "status": d.get("status", ""),
                "attemptCount": int(d.get("attemptCount", 0) or 0),
                "aiScore": d.get("aiScore"),
                "aiThreshold": d.get("aiThreshold"),
                "aiProvider": d.get("aiProvider"),
                # Why it reached a human: below threshold, or no comparator at
                # all. A reviewer reads those two situations differently.
                "manualReason": d.get("manualReason")
                or ("below_threshold" if d.get("aiScore") is not None else "no_ai"),
                "capturedAt": d.get("capturedAt"),
                "lastRejectedAt": d.get("lastRejectedAt"),
            }
        )
    rows.sort(key=lambda r: (r.get("capturedAt") is None, r.get("capturedAt")))
    return rows


def _iam_signing_kwargs() -> dict[str, Any]:
    """Arguments that let Cloud Run sign a URL it has no private key for.

    ── THE FAILURE THIS FIXES ───────────────────────────────────────────────

    `generate_signed_url` signs with an RSA private key. A service-account JSON
    file contains one, so this works on a laptop. The API does not run on a
    laptop: the container copies `app` and `scripts` and nothing else, so on
    Cloud Run `firebase.init()` falls through to `ApplicationDefault()` and the
    runtime credentials are a bearer TOKEN from the metadata server with no key
    anywhere in them. Every call raised:

        you need a private key to sign credentials

    which `_sign` caught and turned into `None`, which the review dialog
    rendered — correctly, for what it was told — as "the photograph exists but
    could not be signed for viewing". Both faces, every host, every time. The
    manual review queue could not show a single face, which is the only thing
    it is for.

    Google's answer is to sign through the IAM `signBlob` API instead: hand
    `generate_signed_url` the runtime account's address and an access token and
    it asks IAM to do the signing. That needs the runtime service account to
    hold `roles/iam.serviceAccountTokenCreator` ON ITSELF — deploy.sh grants it.

    Returns `{}` when the credentials can sign by themselves, in which case the
    plain path is used and nothing changes locally.
    """
    from google.auth import default as google_default
    from google.auth.transport import requests as ga_requests

    creds, _ = google_default()

    # A key-bearing credential signs itself. `signer` exists on both kinds, so
    # the private key is what distinguishes them.
    if getattr(creds, "signer", None) is not None and getattr(
        creds, "signer_email", None
    ) is not None and hasattr(creds, "private_key_id"):
        return {}

    if not creds.valid:
        creds.refresh(ga_requests.Request())

    email = getattr(creds, "service_account_email", "") or ""
    if not email or email == "default":
        raise VerificationError(
            "The API's runtime service account could not be identified, so a "
            "face image cannot be signed for viewing."
        )
    return {"service_account_email": email, "access_token": creds.token}


def _object_name(url_or_path: str) -> str:
    """The bucket object name behind a `gs://` path or a download URL.

    Both spellings occur: the agency dashboard stores the `getDownloadURL()`
    result, and the app stores whatever it was handed.
    """
    from urllib.parse import unquote, urlparse

    if url_or_path.startswith("gs://"):
        return url_or_path.split("/", 3)[3]
    if "://" in url_or_path:
        path = urlparse(url_or_path).path
        # .../o/<url-encoded-object-name>
        if "/o/" in path:
            return unquote(path.split("/o/", 1)[1])
        return unquote(path.lstrip("/"))
    return url_or_path


def _emulator_view_url(object_name: str) -> str | None:
    """LOCAL TEST COPY ONLY — a viewing link for an object in the Storage emulator.

    The emulator has no signing key and no IAM, so `generate_signed_url` cannot
    work there and every KYC document, host face and appeal attachment showed
    "could not be signed" in the local copy. Outside production, and only while
    the Storage emulator is in use, this returns the object's download-token
    link as a same-origin path (`/v0/b/...`), which the local CRM proxies to
    the emulator (zipper-crm/next.config.js, dev + emulator only). Production
    returns None before anything else is looked at.
    """
    import os
    import uuid
    from urllib.parse import quote

    from app.config import settings
    from app.core import isolation

    if isolation.is_production(settings):
        return None
    if not isolation.emulator_value(settings, "STORAGE_EMULATOR_HOST", "storage_emulator_host", os.environ):
        return None

    from firebase_admin import storage as fb_storage

    bucket = fb_storage.bucket()
    blob = bucket.get_blob(object_name)
    if blob is None:
        return None
    meta = dict(blob.metadata or {})
    token = str(meta.get("firebaseStorageDownloadTokens", "") or "").split(",")[0].strip()
    if not token:
        # Written by an Admin SDK, which sets no token: give it one (emulator only).
        token = str(uuid.uuid4())
        meta["firebaseStorageDownloadTokens"] = token
        blob.metadata = meta
        blob.patch()
    return f"/v0/b/{bucket.name}/o/{quote(object_name, safe='')}?alt=media&token={quote(token, safe='')}"


def _sign(url_or_path: str) -> tuple[str | None, str]:
    """Mint a short-lived signed URL for an object in the app's bucket.

    Returns `(url, error)`. The error is a sentence for the reviewer, and it
    exists because the two ways this fails need opposite responses and used to
    be indistinguishable: a photograph the agency never uploaded is a finding
    about the host, and a signing credential that cannot sign is an outage that
    blocks every host in the queue. Both rendered as a grey box.
    """
    if not url_or_path:
        return None, ""

    try:
        local = _emulator_view_url(_object_name(url_or_path))
        if local:
            return local, ""

        from firebase_admin import storage as fb_storage

        blob = fb_storage.bucket().blob(_object_name(url_or_path))
        expiry = datetime.now(timezone.utc) + SIGNED_URL_TTL
        try:
            # v4 explicitly: it is the only scheme the IAM signing path below
            # supports, and leaving the version to the library's default would
            # make the two paths behave differently.
            return blob.generate_signed_url(
                expiration=expiry, method="GET", version="v4"
            ), ""
        except Exception:
            kwargs = _iam_signing_kwargs()
            if not kwargs:
                raise
            return blob.generate_signed_url(
                expiration=expiry, method="GET", version="v4", **kwargs
            ), ""
    except Exception as exc:  # noqa: BLE001 — the message is the point
        # One unreadable image must not take the queue down, so this is still
        # caught. What is new is that it is no longer silent.
        log.warning("Could not sign a verification image: %s", exc)
        return None, (
            f"This image could not be signed for viewing: {exc}. "
            "The image is in the bucket — what failed is the API's ability to "
            "mint a link to it, so this affects every host in the queue, not "
            "this one. If it names a private key, the API's service account "
            "needs roles/iam.serviceAccountTokenCreator on itself."
        )


async def get_for_review(uid: str) -> dict[str, Any]:
    """One case, with both faces behind signed URLs."""
    snap = await _fs(_ref(uid).get)
    if not snap.exists:
        raise VerificationNotFound("No verification record for that host.")
    d = snap.to_dict() or {}

    agency_url, agency_err = await asyncio.to_thread(_sign, d.get("agencyPhotoUrl", ""))
    capture_url, capture_err = await asyncio.to_thread(_sign, d.get("captureUrl", ""))

    return {
        "uid": uid,
        "hostName": d.get("hostName", ""),
        "agencyId": d.get("agencyId", ""),
        "applicationId": d.get("applicationId", ""),
        "status": d.get("status", ""),
        "attemptCount": int(d.get("attemptCount", 0) or 0),
        "aiScore": d.get("aiScore"),
        "aiThreshold": d.get("aiThreshold"),
        "aiProvider": d.get("aiProvider"),
        "capturedAt": d.get("capturedAt"),
        "agencyPhotoSignedUrl": agency_url,
        "captureSignedUrl": capture_url,
        "agencyPhotoMissing": not d.get("agencyPhotoUrl"),
        "captureMissing": not d.get("captureUrl"),
        # Present only when an image that EXISTS could not be linked to. A
        # reviewer seeing this is looking at an outage, not at a host with no
        # documents, and must not reject somebody over it.
        "signingError": agency_err or capture_err,
        "previousNote": d.get("manualNote", ""),
        "lastRejectedAt": d.get("lastRejectedAt"),
    }


# ── The decision ──────────────────────────────────────────────────────────────


def _apply_review(uid: str, expected_status: str, patch: dict, approved: bool) -> bool:
    """Blocking — the verdict and `isVerifiedHost`, together, or nothing (B37).

    Returns False, writing nothing, when the record's status is no longer the
    one the reviewer was shown.

    HT-2: with a `reviewId` in the patch (`review` always sends one), a decision
    whose answer was lost is recognised — the record carries this review's id
    and verdict — and reported as applied. It used to come back False ("changed
    while you were reviewing"), leaving a host verified or rejected with no
    audit entry and no notice, and a re-review refused. After a Firestore error
    the record is read again: this review there → True; status moved → False;
    still waiting → `firebase.TransactionNotApplied` / `TransactionOutcomeUnknown`.
    """
    from firebase_admin import firestore

    client = firebase.firestore_client()
    ver_ref = _ref(uid)
    user_ref = client.collection(USERS).document(uid.strip())
    review_id = str(patch.get("reviewId") or "")
    decided = str(patch.get("status") or "")

    def _ours(data: dict) -> bool:
        return bool(review_id) and data.get("reviewId") == review_id and str(data.get("status") or "") == decided

    @firestore.transactional
    def _apply(transaction) -> bool:
        snap = ver_ref.get(transaction=transaction)
        if not getattr(snap, "exists", False):
            return False
        data = snap.to_dict() or {}
        if _ours(data):
            return True  # HT-2: an earlier attempt of this review committed
        if str(data.get("status") or "") != expected_status:
            return False
        transaction.update(ver_ref, patch)
        transaction.update(user_ref, {"isVerifiedHost": approved})
        return True

    try:
        return bool(_apply(client.transaction()))
    except Exception as exc:
        kind = firebase.transaction_error_kind(exc)
        if kind is None or not review_id:
            raise
        log.warning("verification decision for %s failed in Firestore (%s); reading it again", uid, exc)
        try:
            snap = ver_ref.get()
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("verification decision for %s: the record could not be read again", uid)
            raise firebase.TransactionOutcomeUnknown(REVIEW_UNKNOWN) from exc
        data = (snap.to_dict() or {}) if getattr(snap, "exists", False) else None
        if data is not None and _ours(data):
            return True
        if data is None or str(data.get("status") or "") != expected_status:
            return False
        raise firebase.unresolved(kind, REVIEW_NOT_APPLIED, REVIEW_UNKNOWN) from exc


async def review(uid: str, verdict: str, reason: str, actor: dict) -> dict[str, Any]:
    """Approve or reject a host's identity.

    Approving sets `users/{uid}.isVerifiedHost`, which unlocks the verified
    badge, featuring, PK battles, the host's own call rate — and withdrawals.
    """
    if verdict not in ("verified", "rejected"):
        raise VerificationError("Verdict must be 'verified' or 'rejected'.")
    reason = _require_reason(reason)

    snap = await _fs(_ref(uid).get)
    if not snap.exists:
        raise VerificationNotFound("No verification record for that host.")
    d = snap.to_dict() or {}

    if d.get("status") == "verified" and verdict == "verified":
        raise VerificationError("That host is already verified.")
    # B37: a decision is made on a SUBMITTED capture — the state the review
    # queue lists — and on nothing else. Deciding a record still waiting for
    # the host's capture, or one already decided, used to be accepted and
    # simply overwrote it.
    if str(d.get("status") or "") not in REVIEWABLE:
        raise VerificationError(
            "There is no submitted capture waiting for a decision on this host "
            f"(the record is '{d.get('status') or 'unknown'}'). Reload the queue."
        )

    before = {
        "status": d.get("status", ""),
        "isVerifiedHost": d.get("status") == "verified",
    }

    now = datetime.now(timezone.utc)
    approved = verdict == "verified"

    patch: dict[str, Any] = {
        "status": verdict,
        # HT-2: this review's id, so a decision that landed can be told from
        # one that did not (the record is written by the server only).
        "reviewId": secrets.token_urlsafe(12),
        "manualReviewedBy": actor.get("uid", ""),
        "manualReviewedByName": actor.get("name", ""),
        "manualReviewedByRole": str(actor.get("role", "")),
        "manualReviewedAt": now,
        "manualNote": reason,
        "updatedAt": now,
    }
    if approved:
        patch["verifiedAt"] = now
        patch["verifiedBy"] = "manual"
    else:
        patch["lastRejectedAt"] = now

    # B37: both writes in ONE transaction, conditional on the status that was
    # read. Two reviewers deciding the same capture used to both write, the
    # last one winning; and the verdict and the payable flag were two writes,
    # so a failure between them left the record and the flag disagreeing. Now
    # either both land, against the capture that was reviewed, or neither does.
    try:
        applied = await _fs(_apply_review, uid, str(d.get("status") or ""), patch, approved)
    except (firebase.TransactionNotApplied, firebase.TransactionOutcomeUnknown) as exc:
        raise VerificationNotApplied(str(exc), status_code=exc.status_code) from exc
    if not applied:
        raise VerificationError(
            "This verification changed while you were reviewing it. Reload it "
            "and check what it says now."
        )

    after = {"status": verdict, "isVerifiedHost": approved}
    audit_id = await audit.record(
        actor=actor,
        action=(
            audit.Action.HOST_VERIFICATION_APPROVED
            if approved
            else audit.Action.HOST_VERIFICATION_REJECTED
        ),
        subject_type="user",
        subject_id=uid,
        reason=reason,
        before=before,
        after=after,
        meta={
            "hostName": d.get("hostName", ""),
            "agencyId": d.get("agencyId", ""),
            # The AI's opinion at the time, so a decision can be read back
            # against what the reviewer was actually looking at.
            "aiScore": d.get("aiScore"),
            "aiThreshold": d.get("aiThreshold"),
            "aiProvider": d.get("aiProvider"),
            "attemptCount": int(d.get("attemptCount", 0) or 0),
        },
    )

    # Tell the host. Approval is the moment they become a verified Host;
    # rejection says so and points at the retry. Delivered last and best
    # effort — the verdict and its audit row are already committed.
    from app.services import notices

    notified = await notices.host_verification_decided(uid, approved, reason if not approved else "")

    return {
        "uid": uid,
        "before": before,
        "after": after,
        "audit_id": audit_id,
        # Rejecting does not destroy anything: unreleased weeks are skipped by
        # the payout run, not discarded, so passing later pays all of it.
        "beansHeldNotLost": not approved,
        "notified": notified,
    }
