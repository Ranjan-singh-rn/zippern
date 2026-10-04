"""Firebase Admin — token verification and Firestore balance sync.

Firestore holds the balances the Android app reads. Mongo is the ledger and the
source of truth. This module only ever pushes a value that Mongo already
committed.
"""

from __future__ import annotations

import logging
import os

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials, firestore

from app.config import settings

log = logging.getLogger(__name__)

_app: firebase_admin.App | None = None
_fs = None


def init() -> None:
    global _app, _fs
    if _app is not None:
        return

    path = settings.firebase_credentials_path
    if path and os.path.exists(path):
        cred = credentials.Certificate(path)
    else:
        # On Cloud Run the default service account is used.
        cred = credentials.ApplicationDefault()

    # The bucket has to be named at init: `storage.bucket()` with no argument
    # reads it from here, and host verification signs URLs for faces stored in
    # it. Without this the review queue raises rather than showing a photograph.
    options = {}
    if settings.firebase_storage_bucket:
        options["storageBucket"] = settings.firebase_storage_bucket
    _app = firebase_admin.initialize_app(cred, options or None)
    _fs = firestore.client()
    log.info("Firebase Admin initialised")


def firestore_client():
    if _fs is None:
        raise RuntimeError("Firebase not initialised — call init() first")
    return _fs


def storage_bucket():
    """The project's Storage bucket, named at `init()`.

    `firebase_admin.storage.bucket()` with no argument reads the name from the
    app options, which `init()` sets from `settings.firebase_storage_bucket` —
    so calling it before `init()` raises rather than silently picking a default.
    Wrapped here so callers do not each import `firebase_admin.storage` and
    rediscover that.
    """
    from firebase_admin import storage as fb_storage

    if _app is None:
        raise RuntimeError("Firebase not initialised — call init() first")
    return fb_storage.bucket()


def verify_id_token(token: str) -> dict:
    """Verify a Firebase ID token. Raises on anything invalid or revoked."""
    return fb_auth.verify_id_token(token, check_revoked=True)


def get_user_by_email(email: str):
    try:
        return fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        return None


def get_user(uid: str):
    """The Firebase Auth account behind a uid, or None.

    A `crmUsers` document is keyed by the uid its holder signs in with, so a
    document whose id names no auth account is unreachable — nobody can ever
    produce a token for it. `scripts/repair_staff_accounts.py` uses this to tell
    a repairable account from an orphaned document.
    """
    try:
        return fb_auth.get_user(uid)
    except fb_auth.UserNotFoundError:
        return None
    except ValueError:
        # An id that is not a well-formed uid at all — a synthetic
        # "observer:<email>", say. Not an auth account, and not an error.
        return None


def update_user_phone(uid: str, phone_e164: str) -> None:
    """Attach a phone number to an existing Firebase account.

    ── WHY THIS IS THE WHOLE CRM-AND-APP FIX ────────────────────────────────

    The CRM signs in with email and password; the Android app signs in with
    phone OTP. Firebase treats those as two accounts, and `isCrmUser()` in
    `firestore.rules` keys on the **uid** — so the same human held CRM
    authority under one uid and none under the other.

    Once the number is on the CRM's own account, phone OTP in the app resolves
    to that uid. One account, one `users/{uid}`, one `crmUsers/{uid}`, and
    every uid-keyed rule simply works.

    Raises on conflict — `auth/phone-number-already-exists` when the number
    belongs to somebody else's account — because taking a number off a live
    account is a decision, not a side effect. The caller reports it.
    """
    fb_auth.update_user(uid, phone_number=phone_e164)


def set_user_disabled(uid: str, disabled: bool) -> str:
    """Disable or re-enable a Firebase account, and kill its live tokens.

    ── WHY REVOKING APPLICATION FLAGS WAS NOT REVOKING ACCESS ────────────────

    Deactivating staff flipped `staff.is_active` in Mongo and `isActive` on
    `crmUsers`, and stopped there. The Firebase credential was untouched, so a
    revoked person kept a working login for ever: they could still authenticate,
    still mint fresh ID tokens, still receive a password reset, and were held out
    only by two application-level checks. If either of those writes failed — and
    the mirror is best-effort, with a repair script named in the error — the CRM
    shell opened for them until somebody ran it.

    Disabling is the half that cannot be got around by a bug in ours.

    ── WHY BOTH CALLS ────────────────────────────────────────────────────────

    `disabled=True` refuses NEW sign-ins. It does not invalidate an ID token
    already issued, and those live for an hour — so a revocation at 10:00 would
    leave a session usable until 11:00. `revoke_refresh_tokens` sets the cutoff
    that makes the existing one unacceptable too. Neither does the other's job.

    ── IDENTITY ──────────────────────────────────────────────────────────────

    Takes a **uid** and nothing else. Resolving the target by email would be the
    one mistake that matters here: two accounts can share an address across
    systems, and disabling the wrong Firebase account locks out a person nobody
    revoked while leaving the revoked one signing in.

    Idempotent. Disabling an already-disabled account is a no-op to Firebase, and
    a missing account is reported rather than raised — there is nothing to revoke
    and that is not a failure.

    @return '' on success, or a sentence describing what could not be done. The
        caller must not report a revocation as complete while this is non-empty.
    """
    uid = (uid or "").strip()
    if not uid:
        return "No account id was given, so no Firebase account was changed."
    try:
        fb_auth.update_user(uid, disabled=disabled)
        if disabled:
            # Only on the way out. Re-enabling must not revoke the tokens of a
            # session the person has legitimately just started.
            fb_auth.revoke_refresh_tokens(uid)
        return ""
    except fb_auth.UserNotFoundError:
        # No Firebase account for this staff row. Normal for the observer, which
        # has none by design, and for a row whose account was removed by hand.
        return ""
    except Exception as exc:  # noqa: BLE001 — surfaced, never swallowed
        log.exception("could not set disabled=%s on firebase uid %s", disabled, uid)
        return f"The Firebase login could not be {'disabled' if disabled else 're-enabled'}: {exc}"


def clear_user_phone(uid: str) -> None:
    """Detach whatever phone number is on this account.

    Used when two accounts turn out to be one person and the one not kept has
    to release the number so the keeper can claim it.
    """
    fb_auth.update_user(uid, phone_number=None)


_FIELD_MAP = {
    ("user", "diamonds"): ("users", "diamonds"),
    ("user", "beans"): ("users", "beans"),
    ("seller", "coins"): ("sellers", "coinBalance"),
    ("agency", "commission"): ("agencies", "commissionBalance"),
}


def sync_balance_to_firestore(
    holder_type: str,
    holder_id: str,
    currency: str,
    delta: int,
) -> bool:
    """Apply a CRM movement to the balance the Android app reads.

    THIS APPLIES A DELTA, NOT AN ABSOLUTE.

    It used to write Mongo's post-movement balance straight over the Firestore
    field, on the reasoning that Mongo is the ledger and Firestore is a replica
    of it. That is only true if Mongo sees every movement — and it does not.
    Diamonds are spent inside the app: a gift, a minute of a call, a recharge.
    Those run in Cloud Functions against Firestore and are never posted to
    Mongo. So a CRM top-up of 100 diamonds, computed from a Mongo balance that
    had not heard about the last three hours of spending, silently REFUNDED
    every gift the user had sent since the CRM last touched them.

    Incrementing keeps both sides honest: Mongo owns the CRM's own history,
    Firestore owns the live balance, and each CRM movement moves the live
    balance by exactly what the CRM decided — nothing more.

    The two ledgers are reconciled by the nightly job, which compares them and
    reports drift rather than having one stamp on the other.

    Returns True on success. A failure here does not invalidate the ledger —
    Mongo is already correct and reconciliation will report the divergence.
    """
    target = _FIELD_MAP.get((holder_type, currency))
    if target is None:
        log.warning("No Firestore mapping for %s/%s", holder_type, currency)
        return False
    if delta == 0:
        return True

    collection, field = target
    try:
        # `set(..., merge=True)` rather than `update()`: a holder whose
        # Firestore document does not exist yet (a seller created in the CRM
        # before their first sign-in) raised NotFound and lost the sync.
        firestore_client().collection(collection).document(holder_id).set(
            {field: firestore.Increment(int(delta))}, merge=True
        )
        return True
    except Exception:  # noqa: BLE001 — never let a replica failure break the ledger
        log.exception(
            "Firestore balance sync failed for %s/%s/%s (delta %s) — Mongo is "
            "committed, reconciliation will report the gap",
            holder_type,
            holder_id,
            currency,
            delta,
        )
        return False


class HostBeansUnavailable(Exception):
    """A host's live `beansAvailable` will not cover the withdrawal asked for.

    Carries both figures because the only useful thing to say to the person
    holding the card is which two numbers disagreed.
    """

    def __init__(self, uid: str, available: int, requested: int):
        self.uid = uid
        self.available = available
        self.requested = requested
        super().__init__(
            f"{uid} has {available} beans available to withdraw, not {requested}"
        )


def read_host_wallet(uid: str) -> dict | None:
    """The `users/{uid}` fields a host payout decision turns on, or None.

    `read_firestore_balance` cannot answer this. It is built on `_FIELD_MAP`,
    which knows one field per currency — `beans` for a user — and a withdrawal
    is decided by `beansAvailable`, which is a different number entirely:
    `functions/src/payouts.ts` releases a completed week into `beansAvailable`
    one week in arrears, so `beans` includes earnings that are not yet payable
    and paying against it would pay a week early.

    `agencyId` comes back in the same read because the ledger row the payout
    writes has to carry it — `app/services/commission.py` computes an agency's
    billing from bean debits whose `meta.agency_id` names the agency, so a
    payout that does not record the host's agency is a payout that agency is
    never paid commission on.

    Raises rather than returning None when Firestore cannot be read. The two
    cases need different answers: a host with no document must not be paid, and
    an unreadable Firestore must not be mistaken for one — the first is final
    and the second is a retry.
    """
    snap = firestore_client().collection("users").document(uid).get()
    if not getattr(snap, "exists", False):
        return None

    data = snap.to_dict() or {}

    def _count(key: str) -> int:
        value = data.get(key)
        return int(value) if isinstance(value, (int, float)) else 0

    return {
        "beans": _count("beans"),
        "beans_available": _count("beansAvailable"),
        "agency_id": str(data.get("agencyId") or "").strip(),
        "is_verified_host": data.get("isVerifiedHost") is True,
        "name": str(data.get("name") or data.get("displayName") or "").strip(),
    }


def debit_host_beans(uid: str, amount: int) -> dict:
    """Take `amount` beans out of a host's live wallet, or refuse. Blocking.

    THIS IS THE AUTHORITATIVE WRITE FOR A HOST WITHDRAWAL, not a replica of one.

    Everywhere else in this module Mongo decides and Firestore follows. Here it
    is the other way round, and it has to be: the number that says whether a
    host may be paid lives only in Firestore, it is moved by Cloud Functions
    Mongo never hears about, and the failure being fixed is a host being paid in
    cash while the beans stayed in their wallet — from where `convertBeans`
    turns them into diamonds and the same earnings are collected twice.

    So the debit runs inside a Firestore transaction that re-reads
    `beansAvailable` and aborts if it no longer covers the amount. A card is
    raised, verified and signed over hours or days, and in that time the host
    may have converted beans away; without the re-read a stale card would drive
    the balance negative and hand the host an overdraft.

    Both fields move together in one `update`. `beansAvailable` is the
    withdrawable slice of `beans`, so paying out of the first without reducing
    the second leaves the total claiming money that has already left the
    business — and `convertBeans` spends `beans`.

    Returns what the document held *before* the debit, including the host's
    `agencyId`, read inside the same transaction so the commission row cannot be
    attributed to an agency the host had already left.
    """
    if amount <= 0:
        raise ValueError("A withdrawal must be for a positive number of beans")

    amount = int(amount)
    client = firestore_client()
    ref = client.collection("users").document(uid)

    @firestore.transactional
    def _debit(transaction) -> dict:
        snap = ref.get(transaction=transaction)
        if not getattr(snap, "exists", False):
            # No document is not "zero available" — it is an account that does
            # not exist, and nothing should be paid against it.
            raise HostBeansUnavailable(uid, 0, amount)

        data = snap.to_dict() or {}
        available = data.get("beansAvailable")
        available = int(available) if isinstance(available, (int, float)) else 0
        held = data.get("beans")
        held = int(held) if isinstance(held, (int, float)) else 0

        if available < amount:
            raise HostBeansUnavailable(uid, available, amount)

        transaction.update(
            ref,
            {
                "beansAvailable": firestore.Increment(-amount),
                "beans": firestore.Increment(-amount),
            },
        )
        return {
            "beans_available_before": available,
            "beans_before": held,
            "agency_id": str(data.get("agencyId") or "").strip(),
        }

    return _debit(client.transaction())


def read_firestore_balance(holder_type: str, holder_id: str, currency: str) -> int | None:
    """The live balance the app is actually showing, or None if unreadable.

    Reconciliation needs to compare against this; nothing else should, because
    a read here followed by a write is exactly the overwrite this module now
    avoids.
    """
    target = _FIELD_MAP.get((holder_type, currency))
    if target is None:
        return None
    collection, field = target
    try:
        snap = firestore_client().collection(collection).document(holder_id).get()
        if not snap.exists:
            return None
        value = snap.get(field)
        return int(value) if isinstance(value, (int, float)) else 0
    except Exception:  # noqa: BLE001
        log.exception("Firestore balance read failed for %s/%s", holder_id, currency)
        return None
