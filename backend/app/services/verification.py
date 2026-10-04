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

    before = {
        "status": d.get("status", ""),
        "isVerifiedHost": d.get("status") == "verified",
    }

    now = datetime.now(timezone.utc)
    approved = verdict == "verified"

    patch: dict[str, Any] = {
        "status": verdict,
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

    await _fs(_ref(uid).update, patch)

    # Second write, deliberately not batched with the first. If this one fails,
    # the verification record still shows the verdict and a retry is obvious;
    # the reverse — a payable flag with no record of who set it — is the state
    # worth avoiding.
    await _fs(
        firebase.firestore_client().collection(USERS).document(uid.strip()).update,
        {"isVerifiedHost": approved},
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

    return {
        "uid": uid,
        "before": before,
        "after": after,
        "audit_id": audit_id,
        # Rejecting does not destroy anything: unreleased weeks are skipped by
        # the payout run, not discarded, so passing later pays all of it.
        "beansHeldNotLost": not approved,
    }
