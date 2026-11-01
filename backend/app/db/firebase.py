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
from app.core import isolation

log = logging.getLogger(__name__)

_app: firebase_admin.App | None = None
_fs = None


def init() -> None:
    global _app, _fs
    if _app is not None:
        return

    # Before any credential is read: outside production only the local
    # emulators under a demo- project are allowed, and a production run off
    # Cloud Run must be confirmed. See app/core/isolation.py.
    isolation.assert_firebase_allowed(settings)
    if not settings.is_production:
        _init_local_emulators()
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


def _init_local_emulators() -> None:
    """Outside production: the emulators, a demo project, and no credential.

    Anonymous credentials, never the service-account key or Application Default
    Credentials: the emulators accept them and a real Google endpoint does not,
    so even a request that somehow missed its emulator could not authenticate as
    anybody. Firebase Auth switches to its own emulator credential by itself
    once FIREBASE_AUTH_EMULATOR_HOST is set. `isolation.firebase_problems()` has
    already required all three emulator hosts on this machine.
    """
    global _app, _fs
    from google.auth.credentials import AnonymousCredentials

    isolation.export_emulator_environment(settings)
    options = {"projectId": settings.firebase_project_id.strip()}
    if settings.firebase_storage_bucket:
        options["storageBucket"] = settings.firebase_storage_bucket
    _app = firebase_admin.initialize_app(AnonymousCredentials(), options)
    _fs = firestore.client()
    log.warning(
        "Firebase Admin initialised against the LOCAL EMULATORS (project %s); "
        "no credentials loaded",
        options["projectId"],
    )


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


def get_user_by_phone(phone_e164: str):
    """RC (Decision 15): the Firebase Auth account holding this phone, or None."""
    try:
        return fb_auth.get_user_by_phone_number(phone_e164)
    except fb_auth.UserNotFoundError:
        return None
    except ValueError:
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


def revoke_sessions(uid: str) -> str:
    """Phase 1A (SESSION-003): end every live session WITHOUT disabling the login.

    A suspension must still let the person sign in to be told they are
    suspended (and to appeal), so the account is not disabled — but the tokens
    already issued must stop working now, not in an hour. Revoking refresh
    tokens stops new ID tokens; the caller also moves `credentialsValidAfter`
    past now so the rules refuse the ones already out there.

    @return '' on success, or a sentence describing what could not be done.
    """
    uid = (uid or "").strip()
    if not uid:
        return "No account id was given."
    try:
        fb_auth.revoke_refresh_tokens(uid)
        return ""
    except fb_auth.UserNotFoundError:
        return ""
    except Exception as exc:  # noqa: BLE001 — surfaced, never swallowed
        log.exception("could not revoke refresh tokens for %s", uid)
        return f"The live sessions could not be revoked: {exc}"


#: Where `functions/src/quickLogin.ts` keeps the mobile quick-login credentials:
#: one document per credential, id = sha256(secret), field `uid` = the holder.
QUICK_LOGIN_COLLECTION = "quickLoginTokens"


def revoke_quick_login(uid: str) -> str:
    """B3 / §13 (security reset): delete every quick-login credential of `uid`.

    The credential is what lets "Continue as …" walk back into an account
    with no password; `redeemQuickLogin` already refuses a banned, suspended or
    deleted account at redemption, and a displaced device loses its own. This
    is the server-side revocation for the cases those do not cover — a reset
    of the person's security (an Observer MFA reset, "sign out everywhere"
    with a reset) — called from `security.revoke_sessions_for_uid`.

    Never reads or logs a secret: the documents are keyed by a hash and are
    deleted by reference. @return '' on success, or a sentence saying what
    could not be done.
    """
    uid = (uid or "").strip()
    if not uid:
        return "No account id was given."
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter  # local: as users.py uses it

        client = firestore_client()
        query = client.collection(QUICK_LOGIN_COLLECTION).where(
            filter=FieldFilter("uid", "==", uid)
        ).limit(100)
        removed = 0
        for snap in query.stream():
            snap.reference.delete()
            removed += 1
        if removed:
            log.info("Revoked %d quick-login credential(s) for %s", removed, uid)
        return ""
    except Exception as exc:  # noqa: BLE001 — surfaced, never swallowed
        log.exception("could not revoke the quick-login credentials of %s", uid)
        return f"The quick-login credentials could not be revoked: {exc}"


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
    #: Paise, exactly as Mongo holds it (`money.Currency.COMMISSION`). The
    #: rupee figure the CRM shows is `commissionBalanceInr`, written beside it
    #: by `_balance_fields` on every sync (M-15).
    ("agency", "commission"): ("agencies", "commissionBalance"),
}

#: The app's history subcollection for each user currency (M-18).
_HISTORY_COLLECTION = {"diamonds": "diamondTransactions", "beans": "beanTransactions"}

#: `{collection}/{holder}/replicaSyncs/{ledger_id}` — the server-only marker
#: that a CRM movement's delta reached the live balance. Written in the same
#: batch/transaction as the `Increment`, read first by the drift repair, so a
#: delta is applied once however many times it is replayed (M-1).
REPLICA_SYNCS = "replicaSyncs"


def _balance_fields(holder_type: str, currency: str, field: str, delta: int,
                    balance_after: int | None) -> dict:
    """The fields one balance sync writes on the holder's document."""
    fields: dict = {field: firestore.Increment(int(delta))}
    if holder_type == "agency" and currency == "commission":
        # Mongo sees every commission movement (nothing in the app moves it),
        # so an ABSOLUTE rupee mirror is correct here and self-healing — unlike
        # diamonds, where the app spends behind Mongo's back and only a delta
        # is honest. The unit of the paise field is stated on the document so
        # a reader cannot mistake 12,500 paise for ₹12,500 (M-15).
        fields["commissionBalanceUnit"] = "paise"
        if balance_after is not None:
            fields["commissionBalanceInr"] = int(balance_after) / 100
    return fields


def _history_doc(history: dict | None) -> dict | None:
    if not history or not str(history.get("id") or "").strip():
        return None
    row = {k: v for k, v in dict(history).items() if k != "id"}
    row.setdefault("timestamp", firestore.SERVER_TIMESTAMP)
    return row


def sync_balance_to_firestore(
    holder_type: str,
    holder_id: str,
    currency: str,
    delta: int,
    *,
    balance_after: int | None = None,
    history: dict | None = None,
    marker_id: str = "",
) -> bool:
    """Apply a CRM movement to the balance the Android app reads. Blocking.

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

    B1: three things travel with the delta, in ONE batch so they land together
    or not at all —

      * the app-visible history row (`history`, M-18): a sale credit or an
        admin credit now explains itself on the person's history screen;
      * the `replicaSyncs/{marker_id}` marker (M-1): the proof this delta
        reached the live balance, which is what lets `apply_replica_delta_once`
        replay a failed sync without ever applying it twice;
      * for agency commission, the rupee mirror `commissionBalanceInr` (M-15).

    Returns True on success. A failure here does not invalidate the ledger —
    Mongo is already correct, the balance row is marked `replica_stale`, the
    `replica_drift` alert names it and the repair replays it.
    """
    target = _FIELD_MAP.get((holder_type, currency))
    if target is None:
        log.warning("No Firestore mapping for %s/%s", holder_type, currency)
        return False
    if delta == 0:
        return True

    collection, field = target
    try:
        client = firestore_client()
        ref = client.collection(collection).document(holder_id)
        batch = client.batch()
        # `set(..., merge=True)` rather than `update()`: a holder whose
        # Firestore document does not exist yet (a seller created in the CRM
        # before their first sign-in) raised NotFound and lost the sync.
        batch.set(ref, _balance_fields(holder_type, currency, field, delta, balance_after), merge=True)
        row = _history_doc(history) if holder_type == "user" else None
        if row is not None:
            batch.set(ref.collection(_HISTORY_COLLECTION[currency]).document(str(history["id"])), row)
        if marker_id:
            batch.set(ref.collection(REPLICA_SYNCS).document(str(marker_id)), {
                "delta": int(delta), "currency": currency,
                "historyId": str((history or {}).get("id") or ""),
                "timestamp": firestore.SERVER_TIMESTAMP,
            })
        batch.commit()
        return True
    except Exception:  # noqa: BLE001 — never let a replica failure break the ledger
        log.exception(
            "Firestore balance sync failed for %s/%s/%s (delta %s) — Mongo is "
            "committed; the balance row is marked stale for repair",
            holder_type,
            holder_id,
            currency,
            delta,
        )
        return False


def apply_replica_delta_once(
    holder_type: str,
    holder_id: str,
    currency: str,
    delta: int,
    *,
    marker_id: str,
    balance_after: int | None = None,
    history: dict | None = None,
) -> dict:
    """M-1 — replay one failed balance sync, exactly once. Blocking.

    A transaction reads `replicaSyncs/{marker_id}` first: present means this
    ledger row's delta already reached the live balance (the original sync
    landed and only its answer was lost, or an earlier repair wrote it), and
    nothing is written. Absent, the `Increment`, the history row and the
    marker are written together. Raises on a Firestore failure — the caller
    leaves the entry pending and says so.

    Returns `{"applied": bool}`.
    """
    target = _FIELD_MAP.get((holder_type, currency))
    if target is None:
        raise ValueError(f"No Firestore mapping for {holder_type}/{currency}")
    if not marker_id:
        raise ValueError("A replica replay needs the ledger id it is keyed on")
    collection, field = target
    client = firestore_client()
    ref = client.collection(collection).document(holder_id)
    marker_ref = ref.collection(REPLICA_SYNCS).document(str(marker_id))
    row = _history_doc(history) if holder_type == "user" else None

    @firestore.transactional
    def _replay(transaction) -> dict:
        marker = marker_ref.get(transaction=transaction)
        if getattr(marker, "exists", False):
            return {"applied": False}
        if int(delta) != 0:
            transaction.set(ref, _balance_fields(holder_type, currency, field, delta, balance_after), merge=True)
        if row is not None:
            transaction.set(ref.collection(_HISTORY_COLLECTION[currency]).document(str(history["id"])), row)
        transaction.set(marker_ref, {
            "delta": int(delta), "currency": currency,
            "historyId": str((history or {}).get("id") or ""),
            "repaired": True,
            "timestamp": firestore.SERVER_TIMESTAMP,
        })
        return {"applied": True}

    return _replay(client.transaction())


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


#: P0-7 (FIN-5): the two Firestore queues a host payout can settle. Both are a
#: host's beans paid out in cash — `salaryRequests` is the same thing filed by
#: the host's agency — so both are paid ONLY by an executed host-withdrawal card.
PAYOUT_REQUEST_COLLECTIONS = ("withdrawalRequests", "salaryRequests")
#: A request in one of these may still be paid. `paid`, `distributed` and
#: `rejected` are final.
PAYOUT_REQUEST_PAYABLE = ("pending", "approved")

#: HT-2 — `users/{uid}/cardDebits/{debit_id}`: the server-only record that a
#: card's bean debit committed. No rule matches it, so no client can read or
#: write it (`firestore.rules` denies everything unmatched).
CARD_DEBITS = "cardDebits"
DEBIT_NOT_APPLIED = (
    "The database was busy and did not apply the debit: no debit is recorded for it. "
    "Running it again is safe — it cannot debit twice."
)
DEBIT_UNKNOWN = (
    "The database did not confirm the debit, and none is recorded for it yet — but it may "
    "still complete. Running it again is safe: it records the debit if it happened and "
    "makes it once if it did not."
)


class PayoutRequestNotPayable(Exception):
    """The request a host-withdrawal card settles cannot be paid (again)."""


class PayoutRequestAlreadySettled(PayoutRequestNotPayable):
    """The request is already paid BY THIS VERY CARD — a repeated or raced execution."""


def payout_request_beans(collection: str, data: dict) -> int:
    """The beans a payout request asks for: `beans`, or `beansEarned` on a salary request."""
    value = data.get("beansEarned" if collection == "salaryRequests" else "beans")
    return int(value) if isinstance(value, (int, float)) else 0


def payout_request_holder(data: dict) -> str:
    """The host a payout request is for. `hostUid`; older rows carry `uid`."""
    return str(data.get("hostUid") or data.get("uid") or "").strip()


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


def debit_host_beans(
    uid: str, amount: int, settle: dict | None = None, history: dict | None = None,
    *, debit_id: str = "", record_history: dict | None = None,
) -> dict:
    """Take `amount` beans out of a host's live wallet, or refuse. Blocking.

    P0-7 (FIN-5): with `settle` — `{"collection", "id", "card_id",
    "payment_ref"}` — the payout request the card was raised for is marked
    `paid` IN THE SAME TRANSACTION, and the debit is refused if that request is
    not the host's, is already paid, or is final. One request is paid once, and
    a request can only become `paid` together with the debit that pays it.

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

    HT-2 — IDEMPOTENT ON `debit_id` (a withdrawal card passes its card id). A
    server-only marker, `users/{uid}/cardDebits/{debit_id}`, is written in the
    same transaction as the debit and read before anything else. Without it a
    card raised without a payout request carried no idempotency key at all:
    when a commit was applied but its answer lost, the library ran this
    callback again on the debited wallet and debited it AGAIN. With it, a
    replay returns the recorded figures (`replayed`) and moves nothing. After a
    Firestore error the marker (or the `history` row) is read again: there →
    the recorded figures (`verified_after_error`); not there →
    `TransactionNotApplied` / `TransactionOutcomeUnknown`, never "nothing was
    debited". Refusals are raised exactly as before.
    """
    if amount <= 0:
        raise ValueError("A withdrawal must be for a positive number of beans")

    amount = int(amount)
    client = firestore_client()
    ref = client.collection("users").document(uid)
    request_ref = None
    if settle:
        collection = str(settle.get("collection") or "")
        request_id = str(settle.get("id") or "").strip()
        if collection not in PAYOUT_REQUEST_COLLECTIONS or not request_id:
            raise PayoutRequestNotPayable("The card names no payout request this can settle.")
        request_ref = client.collection(collection).document(request_id)

    # UGP-D: with `history = {"id", "reason"}` the debit is IDEMPOTENT on that
    # id and leaves an app-visible `beanTransactions` row, written in the same
    # transaction — the same guarantee `clawback_user_diamonds` gives. Used for
    # a signed balance card; a withdrawal keeps using `settle`.
    history_ref = (
        ref.collection("beanTransactions").document(str(history["id"]))
        if history and history.get("id") else None
    )
    marker_ref = ref.collection(CARD_DEBITS).document(str(debit_id)) if debit_id else None

    def _replay(record) -> dict:
        p = record.to_dict() or {}
        return {
            "beans_available_before": int(p.get("availableBefore") or 0),
            "beans_before": int(p.get("beansBefore") or 0),
            "agency_id": str(p.get("agencyId") or ""),
            "replayed": True,
        }

    @firestore.transactional
    def _debit(transaction) -> dict:
        prior = history_ref.get(transaction=transaction) if history_ref is not None else None
        marker = marker_ref.get(transaction=transaction) if marker_ref is not None else None
        snap = ref.get(transaction=transaction)
        if prior is not None and getattr(prior, "exists", False):
            return _replay(prior)
        if marker is not None and getattr(marker, "exists", False):
            return _replay(marker)  # HT-2: this card's debit already committed
        if not getattr(snap, "exists", False):
            # No document is not "zero available" — it is an account that does
            # not exist, and nothing should be paid against it.
            raise HostBeansUnavailable(uid, 0, amount)

        # Every read before any write — a Firestore transaction requires it.
        request_snap = request_ref.get(transaction=transaction) if request_ref is not None else None
        if request_ref is not None:
            if not getattr(request_snap, "exists", False):
                raise PayoutRequestNotPayable("The payout request this card was raised for no longer exists.")
            req = request_snap.to_dict() or {}
            if payout_request_holder(req) != uid:
                raise PayoutRequestNotPayable("The payout request is for a different host than this card.")
            status = str(req.get("status") or "")
            if status == "paid" and str(req.get("cardId") or "") == str(settle.get("card_id") or "x"):
                raise PayoutRequestAlreadySettled("The payout request is already paid by this card.")
            if status not in PAYOUT_REQUEST_PAYABLE:
                raise PayoutRequestNotPayable(
                    f"The payout request is already '{status}', so it cannot be paid again."
                )
            # The card pays exactly what was requested — a smaller card must
            # not close a larger request as `paid`.
            asked = payout_request_beans(str(settle.get("collection") or ""), req)
            if asked != amount:
                raise PayoutRequestNotPayable(
                    f"The card is for {amount:,} beans but the request is for {asked:,}."
                )

        data = snap.to_dict() or {}
        if request_ref is not None and str(settle.get("collection")) == "salaryRequests":
            # A salary request is filed by an agency for ITS host. The host's
            # beans are paid out to that agency, so they must still be one.
            if str((request_snap.to_dict() or {}).get("agencyId") or "") != str(data.get("agencyId") or ""):
                raise PayoutRequestNotPayable(
                    "The salary request was filed by an agency this host does not belong to."
                )
        available = data.get("beansAvailable")
        available = int(available) if isinstance(available, (int, float)) else 0
        held = data.get("beans")
        held = int(held) if isinstance(held, (int, float)) else 0

        if available < amount:
            raise HostBeansUnavailable(uid, available, amount)
        # UGP review: a signed balance card (`history`) moves both fields, so it
        # must not push `beans` below zero either. Older CRM debits reduced
        # `beans` alone, so wallets with `beansAvailable > beans` exist. The
        # withdrawal path (`settle`) is left exactly as it was.
        if history_ref is not None and held < amount:
            raise HostBeansUnavailable(uid, min(available, held), amount)

        transaction.update(
            ref,
            {
                "beansAvailable": firestore.Increment(-amount),
                "beans": firestore.Increment(-amount),
            },
        )
        if history_ref is not None:
            transaction.set(
                history_ref,
                {
                    "type": "debit",
                    "amount": amount,
                    "availableBefore": available,
                    "beansBefore": held,
                    "agencyId": str(data.get("agencyId") or "").strip(),
                    "reason": str(history.get("reason") or ""),
                    "timestamp": firestore.SERVER_TIMESTAMP,
                },
            )
        if record_history and str(record_history.get("id") or "").strip():
            # M-17: a host withdrawal leaves the app-visible `beanTransactions`
            # row too — the host sees "paid out, UTR …" rather than an
            # unexplained drop. Written in the same transaction as the debit,
            # under a deterministic id, so a replay (caught by the marker
            # above) never writes it twice. Unlike `history`, this row is NOT
            # the idempotency token and does not change the balance guards.
            transaction.set(
                ref.collection("beanTransactions").document(str(record_history["id"])),
                {
                    "type": "debit",
                    "amount": amount,
                    "availableBefore": available,
                    "beansBefore": held,
                    "balanceAfter": held - amount,
                    "agencyId": str(data.get("agencyId") or "").strip(),
                    "reason": str(record_history.get("reason") or "withdrawal"),
                    "reasonLabel": str(record_history.get("label") or "Withdrawal paid"),
                    "paymentRef": str(record_history.get("payment_ref") or ""),
                    "cardId": str(record_history.get("card_id") or debit_id or ""),
                    "context": "withdrawal",
                    "timestamp": firestore.SERVER_TIMESTAMP,
                },
            )
        if request_ref is not None:
            transaction.update(
                request_ref,
                {
                    "status": "paid",
                    "paidAt": firestore.SERVER_TIMESTAMP,
                    "paidVia": "card",
                    "cardId": str(settle.get("card_id") or ""),
                    "paymentRef": str(settle.get("payment_ref") or ""),
                    "beansDebited": amount,
                },
            )
        if marker_ref is not None:
            transaction.set(
                marker_ref,
                {
                    "debitId": str(debit_id),
                    "amount": amount,
                    "availableBefore": available,
                    "beansBefore": held,
                    "agencyId": str(data.get("agencyId") or "").strip(),
                    "settles": f"{settle.get('collection')}/{settle.get('id')}" if request_ref is not None else "",
                    "timestamp": firestore.SERVER_TIMESTAMP,
                },
            )
        return {
            "beans_available_before": available,
            "beans_before": held,
            "agency_id": str(data.get("agencyId") or "").strip(),
        }

    try:
        return _debit(client.transaction())
    except Exception as exc:
        kind = transaction_error_kind(exc)
        token_ref = marker_ref or history_ref
        if kind is None or token_ref is None:
            raise
        log.warning("bean debit of %s for %s failed in Firestore (%s); reading it again", amount, uid, exc)
        try:
            record = token_ref.get()
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("bean debit of %s for %s: its record could not be read again", amount, uid)
            raise TransactionOutcomeUnknown(DEBIT_UNKNOWN) from exc
        if getattr(record, "exists", False):
            return {**_replay(record), "verified_after_error": True}
        raise unresolved(kind, DEBIT_NOT_APPLIED, DEBIT_UNKNOWN) from exc


WARNING_NOT_APPLIED = (
    "The database was busy and did not record the warning. Send the same request again — "
    "it cannot warn twice."
)
WARNING_UNKNOWN = (
    "The database did not confirm the warning, and it is not recorded yet — but it may "
    "still complete. Send the same request again: it cannot warn twice."
)


def create_warning_once(uid: str, warning_id: str, entry: dict) -> bool:
    """Create `users/{uid}/warnings/{warning_id}` and count it — ONCE. Blocking.

    UGP-D: the warning id is derived from the CRM's request id, so a retried
    request lands here with the same id. The existence check and both writes
    are one transaction: a second call finds the warning and writes nothing,
    so a timeout-and-retry is one warning, one count, not two.

    Returns True when this call created it, False when it already existed —
    including when this call's own commit landed but its answer was lost (the
    replay that False leads to finishes everything, keyed on the warning).
    """
    client = firestore_client()
    user_ref = client.collection("users").document(uid)
    ref = user_ref.collection("warnings").document(warning_id)

    @firestore.transactional
    def _create(transaction) -> bool:
        snap = ref.get(transaction=transaction)
        if getattr(snap, "exists", False):
            return False
        transaction.set(ref, entry)
        transaction.update(
            user_ref,
            {"warnings": firestore.Increment(1), "lastWarnedAt": entry.get("issuedAt")},
        )
        return True

    # HT-2: after a Firestore error the warning is read again. There → False,
    # exactly as when an earlier attempt or request created it: the caller's
    # replay finishes the card, the audit and the notice, each keyed on the
    # warning. Not there → `TransactionNotApplied` / `TransactionOutcomeUnknown`.
    try:
        return _create(client.transaction())
    except Exception as exc:
        kind = transaction_error_kind(exc)
        if kind is None:
            raise
        log.warning("warning %s for %s failed in Firestore (%s); reading it again", warning_id, uid, exc)
        try:
            snap = ref.get()
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("warning %s for %s could not be read again", warning_id, uid)
            raise TransactionOutcomeUnknown(WARNING_UNKNOWN) from exc
        if getattr(snap, "exists", False):
            return False
        raise unresolved(kind, WARNING_NOT_APPLIED, WARNING_UNKNOWN) from exc


# ── What a failed Firestore transaction call does, and does not, tell you ──────
#
# HT-2. A transaction call that raises is in one of three states, and the error
# alone cannot tell them apart:
#
#   * COMMITTED — an attempt's commit was applied but its answer was lost. The
#     client re-sends a commit on UNAVAILABLE / RESOURCE_EXHAUSTED
#     (google-cloud-firestore 2.28.1, `transports/base.py`, `commit`
#     default_retry), and a re-sent commit of an applied transaction can come
#     back as an error. If that error is ABORTED the library even runs the
#     callback AGAIN, on the state it has just committed.
#   * NOT APPLIED — Firestore aborted every attempt (ABORTED, or the library's
#     retry-exhaustion `ValueError` built on it) and nothing of it is visible.
#   * UNKNOWN — a deadline, an unavailable or internal error, a transport
#     error: a commit can still be applied after the client stopped waiting.
#
# So no error is taken as proof that nothing committed. Each transaction in this
# backend writes an OPERATION TOKEN in the same commit as its effect, its
# callback recognises that token FIRST (so a re-run attempt, or a retried call,
# returns what was committed instead of acting twice), and after a Firestore
# error the caller re-reads the token outside the transaction. What the re-read
# cannot find is reported as `TransactionNotApplied` (Firestore aborted it; try
# again) or `TransactionOutcomeUnknown` (it may still land; try again — the
# retry recognises it if it did), never as "nothing happened". Exceptions raised
# by the transaction's own code — a refusal, a bug — are definite and pass
# through unchanged.


class TransactionNotApplied(Exception):
    """HT-2 — Firestore aborted the transaction, and its effect is not there.

    Re-read after the failure: no trace of this operation. Trying again is
    safe: every transaction here recognises its own committed effect, so a
    retry can neither act twice nor miss an effect that did land.
    """

    status_code = 409
    outcome = "not_applied"


class TransactionOutcomeUnknown(Exception):
    """HT-2 — whether the transaction committed could not be established.

    The effect was not visible when re-read (or the re-read failed), but a
    commit can still be applied after the client stopped waiting. Never report
    this as "nothing happened". Trying again is safe for the same reason as
    above: the retry recognises the effect if it lands.
    """

    status_code = 503
    outcome = "unknown"


def _single_error_kind(exc: BaseException) -> str | None:
    if is_transaction_contention(exc):
        return "contended"
    try:
        from google.api_core import exceptions as api_exceptions
    except ImportError:  # pragma: no cover — the Admin SDK depends on it
        api_exceptions = None
    api_error = getattr(api_exceptions, "GoogleAPIError", None)
    if isinstance(api_error, type) and isinstance(exc, api_error):
        return "uncertain"
    try:
        from google.auth import exceptions as auth_exceptions
    except ImportError:  # pragma: no cover
        auth_exceptions = None
    auth_error = getattr(auth_exceptions, "GoogleAuthError", None)
    if isinstance(auth_error, type) and isinstance(exc, auth_error):
        return "uncertain"
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return "uncertain"
    return None


def transaction_error_kind(exc: BaseException) -> str | None:
    """HT-2 — `"contended"`, `"uncertain"`, or None for an error of our own code.

      * "contended": Firestore aborted it (`is_transaction_contention`);
      * "uncertain": any other Firestore / Google API error, an auth refresh or
        a transport error — the commit may or may not have been applied;
      * None: raised by the transaction's own code (a refusal, a bug). Such an
        error is definite: the callback raised, so that attempt wrote nothing,
        and an earlier attempt that committed would have been recognised by the
        token check every callback here makes first.

    The library can HIDE the real error: after any failure it calls
    `_rollback()`, and when the failure was a `begin` (no transaction id yet)
    `_rollback()` raises its own `ValueError("The transaction has no
    transaction ID, so it cannot be rolled back.")`, with the real error only in
    `__context__`. So an error whose cause / context chain holds a Firestore or
    transport error is "uncertain" too — a failed `begin` on a LATER attempt
    can follow an attempt whose commit was applied.

    Either non-None answer means "re-read the operation's token before saying
    anything".
    """
    kind = _single_error_kind(exc)
    if kind is not None:
        return kind
    seen: set[int] = set()
    inner = exc.__cause__ or exc.__context__
    while inner is not None and id(inner) not in seen and len(seen) < 10:
        seen.add(id(inner))
        if _single_error_kind(inner) is not None:
            return "uncertain"
        inner = inner.__cause__ or inner.__context__
    return None


def unresolved(kind: str | None, not_applied: str, unknown: str) -> Exception:
    """HT-2 — the typed error for a failure whose effect the re-read did not find."""
    if kind == "contended":
        return TransactionNotApplied(not_applied)
    return TransactionOutcomeUnknown(unknown)


def is_transaction_contention(exc: BaseException) -> bool:
    """HT-1: True only when Firestore aborted a transaction for contention.

    Under contention the client library aborts a transaction: an aborted
    COMMIT is retried at once, five attempts in all, then reported as
    `ValueError("Failed to commit transaction in 5 attempts.")` raised from the
    last `Aborted`; an `Aborted` raised by a READ inside the transaction is not
    retried at all. Exactly those two shapes are recognised:
      * `google.api_core.exceptions.Aborted` (gRPC ABORTED);
      * the library's retry-exhaustion `ValueError`, caused by an `Aborted`.
    HT-2: ABORTED says the LAST attempt did not commit. It does not prove that
    no earlier attempt did (see the section note above), so a caller re-reads
    its operation token before giving any "lost" or "not applied" result. Every
    other failure is not recognised here (`transaction_error_kind` sorts them).
    """
    try:
        from google.api_core import exceptions as api_exceptions
    except ImportError:  # pragma: no cover — the Admin SDK depends on it
        return False
    aborted = getattr(api_exceptions, "Aborted", None)
    if not isinstance(aborted, type):
        return False
    if isinstance(exc, aborted):
        return True
    if type(exc) is not ValueError or not isinstance(exc.__cause__, aborted):
        return False
    # google-cloud-firestore 2.28.1 (pinned in requirements.txt):
    # `_EXCEED_ATTEMPTS_TEMPLATE = "Failed to commit transaction in {:d} attempts."`
    text, head, tail = str(exc), "Failed to commit transaction in ", " attempts."
    count = text[len(head):-len(tail)] if text.startswith(head) and text.endswith(tail) else ""
    return count != "" and all(c in "0123456789" for c in count)


# ── A short lease on a document awaiting ONE decision (B17 / B40) ─────────────
#
# A host application and an account appeal are each decided once, and the
# decision does something BEFORE it is stamped on the document — grants or
# revokes a Host, lifts a ban. Checking the status and writing it at the end is
# check-then-write: two reviewers could both pass the check and both act, and
# an approve racing a refuse could leave the account granted and the document
# refused. The lease is the compare-and-set that comes first: it is taken in a
# transaction against the status that was read, the decision's side effects run
# only while it is held, and the final stamp is conditional on still holding
# it. A crash leaves at most a lease that lapses after `DECISION_LEASE_SECONDS`.
#
# A field rather than a status value, so no reader of `status` ever sees an
# intermediate state it does not know.

DECISION_LEASE_FIELD = "decisionInFlight"
#: HT-2 — the lease token under which the document's current decision was
#: recorded, written in the same commit as the decision. It is what tells a
#: completion whose answer was lost from one that never landed; the lease field
#: itself is deleted by the completion, as before.
DECISION_TOKEN_FIELD = "decisionToken"
DECISION_LEASE_SECONDS = 120


class DecisionConflict(Exception):
    """The document moved, or another decision holds it. `reason` says which.

    HT-2 adds two reasons, for a claim whose transaction failed and whose lease
    the re-read did not find: "contended" (Firestore aborted it) and "unknown"
    (its outcome could not be established — a lease that did land lapses after
    `DECISION_LEASE_SECONDS`). Nothing was decided in either case.
    """

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


class DecisionNotRecorded(Exception):
    """HT-2 — the lease is still ours, but the decision stamp could not be confirmed.

    `outcome` is "not_applied" (Firestore aborted it and nothing of it is
    visible) or "unknown" (it may still land). Completing again under the same
    lease is safe: `complete_decision` recognises a stamp it already wrote.
    """

    def __init__(self, message: str, *, outcome: str) -> None:
        super().__init__(message)
        self.outcome = outcome


CLAIM_CONTENDED = (
    "Another change to this was being saved at the same moment, so the decision did "
    "not start. Nothing was decided — try again."
)
CLAIM_UNKNOWN = (
    "The database did not confirm that the decision started. Nothing was decided "
    "yet — try again in a moment."
)


def _lease_fresh(lease, now) -> bool:
    at = lease.get("at") if isinstance(lease, dict) else None
    if not hasattr(at, "timestamp"):
        return False
    try:
        return (now.timestamp() - float(at.timestamp())) < DECISION_LEASE_SECONDS
    except Exception:  # noqa: BLE001 — an unreadable stamp is not a live lease
        return False


def _lease_token(data: dict | None) -> str:
    lease = (data or {}).get(DECISION_LEASE_FIELD)
    return str(lease.get("token") or "") if isinstance(lease, dict) else ""


def claim_decision(
    ref, *, expected_status: str, actor_uid: str,
    status_field: str = "status", default_status: str = "",
) -> str:
    """Take the decision lease on `ref`, or raise `DecisionConflict`. Blocking.

    Refused when the document is gone, when its status is no longer the one
    the caller read (`expected_status`; a missing field reads as
    `default_status`), or when another decision holds a lease that has not
    lapsed. Returns the lease token the two calls below need.

    HT-2: an attempt that finds THIS call's lease already there (an earlier
    attempt committed it and its answer was lost) has the lease — it used to be
    refused as "somebody else is deciding" by its own lease. After a Firestore
    error the document is read again: our lease there → claimed; otherwise the
    usual refusal, or `DecisionConflict` with reason "contended" / "unknown".
    """
    import secrets
    from datetime import datetime, timezone

    client = firestore_client()
    token = secrets.token_urlsafe(12)
    now = datetime.now(timezone.utc)

    def _verdict(data: dict | None) -> str:
        if data is None:
            return "missing"
        if _lease_token(data) == token:
            return ""
        if str(data.get(status_field) or default_status) != str(expected_status):
            return "changed"
        if _lease_fresh(data.get(DECISION_LEASE_FIELD), now):
            return "in_flight"
        return "free"

    @firestore.transactional
    def _claim(transaction) -> str:
        snap = ref.get(transaction=transaction)
        verdict = _verdict(snap.to_dict() or {} if getattr(snap, "exists", False) else None)
        if verdict != "free":
            return verdict
        transaction.update(
            ref, {DECISION_LEASE_FIELD: {"token": token, "by": actor_uid, "at": now}}
        )
        return ""

    try:
        outcome = _claim(client.transaction())
    except Exception as exc:
        kind = transaction_error_kind(exc)
        if kind is None:
            raise
        log.warning("decision claim on %s failed (%s); reading it again", getattr(ref, "path", ref), exc)
        try:
            snap = ref.get()
            outcome = _verdict(snap.to_dict() or {} if getattr(snap, "exists", False) else None)
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("decision claim on %s: the document could not be read again", getattr(ref, "path", ref))
            raise DecisionConflict(CLAIM_UNKNOWN, reason="unknown") from exc
        if outcome == "free":
            raise DecisionConflict(
                CLAIM_CONTENDED if kind == "contended" else CLAIM_UNKNOWN,
                reason="contended" if kind == "contended" else "unknown",
            ) from exc
    if outcome == "in_flight":
        raise DecisionConflict(
            "Somebody else is deciding this right now. Reload it in a moment.",
            reason=outcome,
        )
    if outcome:
        raise DecisionConflict(
            "This was decided or changed while you were looking at it. Reload it.",
            reason=outcome,
        )
    return token


def complete_decision(
    ref, token: str, patch: dict, *, expected_status: str,
    status_field: str = "status", default_status: str = "",
) -> bool:
    """Stamp the decision — only while this call's lease still holds. Blocking.

    Returns False, writing nothing, when the lease has been taken over or the
    status has moved; the caller reports that rather than overwriting.

    HT-2: the stamp carries the lease token (`decisionToken`), so True also
    means "this lease's decision is already recorded" — by an earlier attempt
    whose answer was lost, or by an earlier call under the same lease. It used
    to come back False ("changed while being decided") for a decision that HAD
    been recorded, and the caller then skipped the audit, the lock release and
    the notice. Recognition needs the token AND the status the stamp writes: a
    status nobody but the server can set. After a Firestore error the document
    is read again: recorded → True; lease gone or status moved → False; lease
    still ours → `DecisionNotRecorded` ("not_applied" or "unknown").
    """
    client = firestore_client()
    decided = str(patch.get(status_field) or "")

    def _recorded(data: dict) -> bool:
        return data.get(DECISION_TOKEN_FIELD) == token and (
            not decided or str(data.get(status_field) or default_status) == decided
        )

    def _still_ours(data: dict) -> bool:
        return _lease_token(data) == token and (
            str(data.get(status_field) or default_status) == str(expected_status)
        )

    @firestore.transactional
    def _finish(transaction) -> bool:
        snap = ref.get(transaction=transaction)
        if not getattr(snap, "exists", False):
            return False
        data = snap.to_dict() or {}
        if _recorded(data):
            return True
        if not _still_ours(data):
            return False
        transaction.update(
            ref, {**patch, DECISION_TOKEN_FIELD: token, DECISION_LEASE_FIELD: firestore.DELETE_FIELD}
        )
        return True

    try:
        return bool(_finish(client.transaction()))
    except Exception as exc:
        kind = transaction_error_kind(exc)
        if kind is None:
            raise
        log.warning("decision stamp on %s failed (%s); reading it again", getattr(ref, "path", ref), exc)
        try:
            snap = ref.get()
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("decision stamp on %s: the document could not be read again", getattr(ref, "path", ref))
            raise DecisionNotRecorded(
                "The decision could not be confirmed as recorded.", outcome="unknown"
            ) from exc
        data = (snap.to_dict() or {}) if getattr(snap, "exists", False) else None
        if data is not None and _recorded(data):
            return True
        if data is None or not _still_ours(data):
            return False
        raise DecisionNotRecorded(
            "The decision was not recorded: the database "
            + ("was busy and aborted it." if kind == "contended" else "did not confirm it."),
            outcome="not_applied" if kind == "contended" else "unknown",
        ) from exc


def complete_decision_retry_once(
    ref, token: str, patch: dict, *, expected_status: str,
    status_field: str = "status", default_status: str = "",
) -> bool:
    """HT-2 — `complete_decision`, tried once more when its stamp was not confirmed.

    For a decision whose effects (a grant, a revocation, a lifted ban) are
    already committed: leaving the stamp unwritten is what leaves the system
    inconsistent, and completing again under the same lease cannot write it
    twice (`decisionToken`). One more call, not a loop; if that is not
    confirmed either, `DecisionNotRecorded` reaches the caller, which says so.
    """
    try:
        return complete_decision(
            ref, token, patch, expected_status=expected_status,
            status_field=status_field, default_status=default_status,
        )
    except DecisionNotRecorded:
        log.warning("decision stamp on %s not confirmed; completing once more", getattr(ref, "path", ref))
        return complete_decision(
            ref, token, patch, expected_status=expected_status,
            status_field=status_field, default_status=default_status,
        )


def release_decision(ref, token: str) -> str:
    """Give a lease back after a decision failed part-way. Blocking; never raises.

    HT-2: says what happened instead of swallowing it — "released" (it was ours
    and it is gone), "not_held" (it was not ours any more, or the decision was
    recorded), "failed" (it could not be released; it lapses by itself after
    `DECISION_LEASE_SECONDS`, and until then the item reads as being decided).
    A failure is logged as an ERROR with its cause. It still never raises: it
    runs inside other error paths, and raising would hide the error that matters.
    """
    path = getattr(ref, "path", ref)
    #: An attempt of THIS call queued the delete. If the lease is then found
    #: gone, that is this release having landed (its answer lost), not "not
    #: held". Read only to interpret an ABSENT lease: an attempt that was rolled
    #: back finds the lease still ours and deletes it again.
    queued: list[bool] = []
    try:
        client = firestore_client()

        @firestore.transactional
        def _release(transaction) -> str:
            snap = ref.get(transaction=transaction)
            data = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
            if _lease_token(data) == token:
                queued.append(True)
                transaction.update(ref, {DECISION_LEASE_FIELD: firestore.DELETE_FIELD})
                return "released"
            return "released" if queued and not data.get(DECISION_LEASE_FIELD) else "not_held"

        return _release(client.transaction())
    except Exception:  # noqa: BLE001 — reported, see the docstring
        try:
            snap = ref.get()
            data = (snap.to_dict() or {}) if getattr(snap, "exists", False) else {}
            if _lease_token(data) != token:
                return "released"
        except Exception:  # noqa: BLE001
            pass
        log.error(
            "The decision lease on %s was not released; it lapses in %ss and the item reads "
            "as being decided until then", path, DECISION_LEASE_SECONDS, exc_info=True,
        )
        return "failed"


CLAWBACK_NOT_APPLIED = (
    "The database was busy and did not take the diamonds back: nothing is recorded as "
    "taken. Running it again is safe — it cannot take twice."
)
CLAWBACK_UNKNOWN = (
    "The database did not confirm taking the diamonds back, and nothing is recorded as "
    "taken yet — but it may still complete. Running it again is safe: it records what was "
    "taken if it happened and takes it once if it did not."
)


class LiveBalanceShort(Exception):
    """UGP-D: the live balance will not cover a debit that must be taken whole."""

    def __init__(self, uid: str, available: int, requested: int):
        super().__init__(f"available {available}, requested {requested}")
        self.uid = uid
        self.available = available
        self.requested = requested


def clawback_user_diamonds(
    uid: str, requested: int, *, reason: str, history_id: str, require_full: bool = False,
) -> dict:
    """Take back up to `requested` diamonds from a user's LIVE balance. Blocking.

    THE AUTHORITATIVE WRITE FOR A RECHARGE REVERSAL, for the same reason
    `debit_host_beans` is: the number that says how many of a credited batch
    are still there lives only in Firestore, and it is moved by gifts and
    calls Mongo never hears about. A refund decided from the Mongo balance
    would "reverse" diamonds the person has already spent and drive the live
    wallet negative.

    So this runs inside a Firestore transaction that re-reads `diamonds`,
    takes `min(requested, available)`, never less than zero, and writes the
    app-visible history row in the same transaction. The caller records the
    Mongo movement afterwards with `replica_applied_by_caller=True`, exactly
    as a host withdrawal does, and records the shortfall — the part already
    spent — as unrecoverable rather than inventing a negative balance.

    Returns `{"taken": n, "available_before": m}`. A missing document takes
    nothing: there is no wallet to take from.

    HT-2: after a Firestore error the history row is read again — there: the
    recorded outcome (`verified_after_error`); not there:
    `TransactionNotApplied` / `TransactionOutcomeUnknown`.
    """
    if requested <= 0:
        raise ValueError("A clawback must be for a positive number of diamonds")

    requested = int(requested)
    client = firestore_client()
    ref = client.collection("users").document(uid)
    history = ref.collection("diamondTransactions").document(history_id)

    @firestore.transactional
    def _take(transaction) -> dict:
        # IDEMPOTENT ON `history_id`. The history row is written in the SAME
        # transaction as the debit, so its existence proves this exact clawback
        # already happened. A replay — a retry after a crash between this
        # transaction and the caller's bookkeeping — returns the recorded
        # outcome and moves nothing. Both reads happen before any write, as a
        # Firestore transaction requires.
        prior = history.get(transaction=transaction)
        snap = ref.get(transaction=transaction)
        if getattr(prior, "exists", False):
            p = prior.to_dict() or {}
            return {
                "taken": int(p.get("amount") or 0),
                "available_before": int(p.get("availableBefore") or 0),
                "replayed": True,
            }
        if not getattr(snap, "exists", False):
            # UGP review: a debit that must be taken WHOLE cannot be "taken" from
            # a wallet that does not exist — refusing is what stops the caller
            # from ledgering a debit and closing the card with nothing taken.
            if require_full:
                raise LiveBalanceShort(uid, 0, requested)
            return {"taken": 0, "available_before": 0, "replayed": False}
        data = snap.to_dict() or {}
        available = data.get("diamonds")
        available = int(available) if isinstance(available, (int, float)) else 0
        # UGP-D: a signed debit (a warning deduction, a balance adjustment) is
        # taken WHOLE or not at all. The recharge reversal keeps its "take what
        # is still there" behaviour by not asking for this.
        if require_full and available < requested:
            raise LiveBalanceShort(uid, available, requested)
        taken = max(0, min(requested, available))
        if taken > 0:
            transaction.update(ref, {"diamonds": firestore.Increment(-taken)})
            transaction.set(
                history,
                {
                    "type": "debit",
                    "amount": taken,
                    "availableBefore": available,
                    "requested": requested,
                    "reason": reason,
                    "timestamp": firestore.SERVER_TIMESTAMP,
                },
            )
        return {"taken": taken, "available_before": available, "replayed": False}

    # HT-2: after a Firestore error the history row is read again — written in
    # the same transaction as the debit, it is the record that it committed.
    try:
        return _take(client.transaction())
    except Exception as exc:
        kind = transaction_error_kind(exc)
        if kind is None:
            raise
        log.warning("diamond clawback %s failed in Firestore (%s); reading it again", history_id, exc)
        try:
            prior = history.get()
        except Exception:  # noqa: BLE001 — what is known is reported below
            log.exception("diamond clawback %s: its history row could not be read again", history_id)
            raise TransactionOutcomeUnknown(CLAWBACK_UNKNOWN) from exc
        if getattr(prior, "exists", False):
            p = prior.to_dict() or {}
            return {
                "taken": int(p.get("amount") or 0),
                "available_before": int(p.get("availableBefore") or 0),
                "replayed": True,
                "verified_after_error": True,
            }
        raise unresolved(kind, CLAWBACK_NOT_APPLIED, CLAWBACK_UNKNOWN) from exc


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


def create_custom_token(uid: str, developer_claims: dict) -> str:
    """P1-A3b: a Firebase custom token for `uid` carrying `developer_claims`.

    On Cloud Run the Admin SDK signs through the IAM `signBlob` API, which needs
    the runtime service account to hold `roles/iam.serviceAccountTokenCreator`
    on itself and the IAM Service Account Credentials API enabled. Against the
    Auth emulator the SDK emits an unsigned token the emulator accepts.
    The returned token is a credential: never log it.
    """
    token = fb_auth.create_custom_token(uid, developer_claims)
    return token.decode() if isinstance(token, bytes) else str(token)
