"""MongoDB connection and index setup.

The ledger and audit log live here. Transactions are used for every money
mutation, which is why the deployment must be a replica set — a standalone
mongod cannot start a session transaction.
"""

from __future__ import annotations

import logging

from motor.motor_asyncio import (
    AsyncIOMotorClient,
    AsyncIOMotorDatabase,
)
from pymongo import ASCENDING, DESCENDING

from app.config import settings
from app.core import isolation

log = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    if _client is None:
        raise RuntimeError("Mongo client not initialised — call connect() first")
    return _client


def get_db() -> AsyncIOMotorDatabase:
    return get_client()[settings.mongo_db]


# ── Collections ───────────────────────────────────────────────────────────────
# Named centrally so nothing is referenced by a bare string.

class C:
    STAFF = "staff"                 # CRM staff and owners
    OBSERVER_OTP = "observer_otp"   # one-time codes for observer login
    SESSIONS = "sessions"           # issued session tokens (revocable)
    #: P1-A3 — one row per Owner: encrypted TOTP secret, hashed recovery codes,
    #: failure counter / lock, last accepted time-step (replay guard).
    OWNER_MFA = "owner_mfa"
    AUDIT = "audit"                 # append-only history
    LEDGER = "ledger"               # every balance movement
    BALANCES = "balances"           # current balance per holder
    CARDS = "cards"                 # approval cards
    PARTNERS = "partners"           # agencies and sellers
    RATES = "rates"                 # versioned economy rates
    SALES = "partner_sales"         # seller → buyer diamond sales
    #: A buyer's manual recharge through a Coin Seller: the buyer pays the
    #: seller outside the app, files the reference and proof, and STAFF verify
    #: before any diamond moves. The decision side of `rechargeRequests` — the
    #: Firestore document of the same id is the app-readable mirror.
    RECHARGES = "recharges"
    SUBAGENCY_PAYOUTS = "subagency_payouts"  # two-leg payouts via a parent agency
    #: UGP-F: send counters for the PUBLIC appeal form (per hashed client
    #: address and per account). Counters only — never an address in clear.
    PUBLIC_APPEAL_RATE = "public_appeal_rate"

    # ── Reporting, email and alerts — Part 8A ────────────────────────────────
    # One row per attempted send, written before the provider is called and
    # updated with the outcome. An email nobody can prove was sent is not a
    # control (8A.2.14 / 8A.2.15).
    EMAIL_DELIVERIES = "email_deliveries"
    # One row per alert condition, carrying when it was last emailed. This is
    # what stops the same condition mailing every hour (8A.1.4).
    ALERT_STATE = "alert_state"
    # Who gets which report, at which cadence, and who has turned one off
    # (8A.3.13 – 8A.3.15).
    REPORT_SUBSCRIPTIONS = "report_subscriptions"
    # One row per scheduled job run: when it ran, what it sent, what failed.
    SCHEDULED_RUNS = "scheduled_runs"
    # ── Chance mechanics — Part 8B ───────────────────────────────────────────
    # One document per mechanic (a lucky gift tier, a game): what it is called
    # and which configuration version is in force. `_id` is the mechanic key,
    # so a second creation of the same key collides on Mongo's own unique index
    # rather than producing a duplicate with different odds.
    CHANCE_MECHANICS = "chance_mechanics"
    # One document per configuration version — the full outcome table, the
    # stake denominations, the maximum single win and the enabled countries.
    # Written once, never edited: a change is a new version, on a card an owner
    # signs (8B.2.8), and a live round settles on the version it was committed
    # against rather than on whatever is current (0.6.2 / 9.8).
    CHANCE_CONFIGS = "chance_configs"
    # One document per round, written before the payout is credited (8B.1.5)
    # and retained so any player's history can be reconstructed (8B.5.5).
    CHANCE_ROUNDS = "chance_rounds"
    # One document per *budget* — a mechanic's lifetime position against its
    # reserve, one mechanic-day, one player-mechanic-day, and the cross-mechanic
    # day (8B.4.3 / 8B.4.4). Each is a counter, and each is consumed by a
    # **conditional** update whose filter carries the ceiling, so two rounds
    # settling in the same millisecond cannot both slip under it: the loser's
    # update matches nothing and is answered with whatever headroom is actually
    # left. See `chance._consume` — the race is decided by Mongo, not by Python.
    #
    # This collection is a control, never a record. The record is
    # `chance_rounds`, which is what every reported figure is computed from.
    CHANCE_EXPOSURE = "chance_exposure"
    # One document per player who has been flagged, keyed by their uid (8B.5.4).
    # A freeze stops them opening or playing a round and touches nothing else —
    # no balance moves, no round is reversed, no account is banned.
    CHANCE_PLAYER_FLAGS = "chance_player_flags"

    # ── Player protection — Part 8B.6 ────────────────────────────────────────
    # One document per player, `_id` = their uid: the loss limits in force and
    # who set each, a self-exclusion, a cooling-off period, a staff suspension
    # and the state of their current session. It holds **no balance and no money
    # field of any kind** — a limit stops a play, it never moves a diamond — and
    # it is the record `player_protection.gate_play` refuses on. If it cannot be
    # read the play does not happen (a protection that fails open is not one).
    #
    # Deliberately separate from `chance_player_flags` above, which is 8B.5.4's
    # anti-fraud freeze. The two answer different questions about the same
    # player — "is this account being abused" and "did this person ask us to
    # stop them" — and one row that meant both would make either impossible to
    # reason about.
    PLAYER_PROTECTION = "player_protection"
    # One document per detected harm pattern (8B.6.4), awaiting review by a
    # named person (8B.6.5). Nothing in this system closes one automatically:
    # `player_protection.review_flag` is the only writer of a `reviewed` status
    # and it refuses a machine actor outright.
    PLAYER_PROTECTION_FLAGS = "player_protection_flags"

    # The owner's weekly business report, stored as a record. One document per
    # ISO week, written once and never updated — re-reading a past week has to
    # give the same figures it gave on the Sunday, or it is not a record. A
    # deliberate re-run stores a new revision beside the original rather than
    # overwriting it.
    WEEKLY_BUSINESS_REPORTS = "weekly_business_reports"
    #: One row per day, comparing Firestore's app economy against the Mongo
    #: ledger. The app's money lives in Firestore and the books live here;
    #: nothing compared them before, so the two could drift indefinitely
    #: without anyone knowing when it started.
    RECONCILIATION = "reconciliation"
    #: B1 — one row per Owner-notification event (`_id` = the deterministic
    #: event key `owner_money:{ref}:{action}`): who was told, how, and whether
    #: every delivery succeeded. A row that is still `pending` is retried by
    #: the transactional sweep and raised by the `owner_notice_failed` alert.
    OWNER_NOTICES = "owner_notices"


async def connect(*, ensure: bool = True) -> None:
    """Connect, behind the isolation check, then build the indexes.

    `ensure=False` skips `ensure_indexes()` — which is DDL — for read-only
    tools (`scripts/d17_legacy_partners.py`'s survey) that must not change a
    database they only read. The isolation check runs either way.
    """
    global _client
    # Before a client exists: outside production only a MongoDB on this machine
    # is allowed, and a production run off Cloud Run must be confirmed. So the
    # `ensure_indexes()` below can never run against a database this process was
    # not meant to reach. See app/core/isolation.py.
    isolation.assert_mongo_allowed(settings)
    _client = AsyncIOMotorClient(settings.mongo_uri, tz_aware=True)
    await _client.admin.command("ping")
    log.info("Connected to MongoDB (%s)", settings.mongo_db)
    if ensure:
        await ensure_indexes()


async def disconnect() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


# ── One payment reference per seller — and ONLY real references ──────────────
#
# This used to be `unique=True, sparse=True` on `(seller_id, reference)`. A
# sparse COMPOUND index indexes every document that has ANY of its fields, so a
# request with a `seller_id` and no `reference` was indexed as
# `(seller, null)` — and the second proof-only request to the same seller was
# refused as a duplicate. A partial index on "reference is a non-empty string"
# indexes exactly the requests that carry a real reference, which is the rule.
RECHARGE_REFERENCE_KEY = [("seller_id", ASCENDING), ("reference", ASCENDING)]
#: MFA release, revision 4 — see `ensure_indexes`.
OWNER_MFA_UID_INDEX = "owner_mfa_uid_unique"

RECHARGE_REFERENCE_INDEX = "recharges_seller_reference_unique"
RECHARGE_REFERENCE_FILTER = {"reference": {"$gt": ""}}


async def ensure_recharge_reference_index(db) -> str:
    """Make the reference index the partial one. Idempotent; touches nothing else.

    Returns "present", "created" or "replaced". Only an index on EXACTLY this
    key pattern is ever dropped, and only when it is not already the partial
    unique one. No document is read or written. If creation fails (it can only
    fail on real duplicate references already stored) the failure is logged at
    ERROR and re-raised — the submit path still refuses a reused reference with
    its own lookup, but nobody is allowed to believe the index exists.
    """
    coll = db[C.RECHARGES]
    info = await coll.index_information()
    outcome = "created"
    for name, spec in info.items():
        key = [(str(k), int(v)) for k, v in spec.get("key", [])]
        if key != RECHARGE_REFERENCE_KEY:
            continue
        if spec.get("unique") and spec.get("partialFilterExpression") == RECHARGE_REFERENCE_FILTER:
            return "present"
        await coll.drop_index(name)
        outcome = "replaced"
    try:
        await coll.create_index(
            RECHARGE_REFERENCE_KEY,
            name=RECHARGE_REFERENCE_INDEX,
            unique=True,
            partialFilterExpression=RECHARGE_REFERENCE_FILTER,
        )
    except Exception:
        log.exception("recharges: the (seller_id, reference) unique index could not be built")
        raise
    log.info("recharges: reference index %s", outcome)
    return outcome


#: RF-30: one recharge request per (buyer, app request id). The app sends the
#: same id on every retry of one form, so a reply lost to a timeout can be
#: asked for again without filing twice; two copies racing in are resolved by
#: this index and `services.recharges` answers the loser with the winner.
#: Partial on a non-empty id, so requests from older apps (no id) take no part.
RECHARGE_REQUEST_ID_KEY = [("buyer_uid", ASCENDING), ("client_request_id", ASCENDING)]
RECHARGE_REQUEST_ID_INDEX = "recharges_buyer_request_id_unique"
RECHARGE_REQUEST_ID_FILTER = {"client_request_id": {"$gt": ""}}


async def ensure_recharge_request_id_index(db) -> str:
    """Build the one-request-per-app-id index. Idempotent; reads and writes no documents.

    No stored request carries `client_request_id` before this release, so the
    build cannot meet a duplicate.
    """
    return await db[C.RECHARGES].create_index(
        RECHARGE_REQUEST_ID_KEY,
        name=RECHARGE_REQUEST_ID_INDEX,
        unique=True,
        partialFilterExpression=RECHARGE_REQUEST_ID_FILTER,
    )


#: UGP-D (review): ONE deduction card per warning. Two requests in flight with
#: the same request id both look for the warning's card, both find none and
#: both raise one; signing both would take the money twice. With this index the
#: second insert is refused and `services.users` answers with the first card.
#: Partial on a string `payload.warning_id`, so no other card takes part.
WARNING_CARD_KEY = [("payload.warning_id", ASCENDING)]
WARNING_CARD_INDEX = "cards_one_per_warning"
WARNING_CARD_FILTER = {"payload.warning_id": {"$type": "string"}}


async def ensure_warning_card_index(db) -> str:
    """Build the one-card-per-warning index. Idempotent; reads and writes no documents."""
    return await db[C.CARDS].create_index(
        WARNING_CARD_KEY,
        name=WARNING_CARD_INDEX,
        unique=True,
        partialFilterExpression=WARNING_CARD_FILTER,
    )


async def ensure_indexes() -> None:
    """Create indexes. Safe to run repeatedly."""
    db = get_db()

    await db[C.STAFF].create_index([("email", ASCENDING)], unique=True)
    await db[C.STAFF].create_index([("role", ASCENDING), ("is_active", ASCENDING)])
    await db[C.STAFF].create_index([("reports_to", ASCENDING)])
    # A department admin's staff list is now scoped by department rather than by
    # who invited whom — `services/staff.list_staff` queries `team` + `role` +
    # `is_active`, and `reports_to` is a display field. The index above is kept
    # because the field is still written and read for display.
    await db[C.STAFF].create_index(
        [("team", ASCENDING), ("role", ASCENDING), ("is_active", ASCENDING)]
    )

    # OTPs expire on their own. TTL index removes spent and stale codes.
    await db[C.OBSERVER_OTP].create_index([("email", ASCENDING)])
    await db[C.OBSERVER_OTP].create_index("expires_at", expireAfterSeconds=0)

    await db[C.SESSIONS].create_index([("jti", ASCENDING)], unique=True)
    await db[C.SESSIONS].create_index("expires_at", expireAfterSeconds=0)

    # P1-A3 (MFA release, revision 4): one enrolment record per Owner.
    # `owner_mfa.start_enrolment` upserts on `uid`; without a unique index two
    # simultaneous first starts could each insert a row. With it, the losing upsert
    # is retried by Mongo as an update. Created on an empty collection (stage 1 never
    # writes it), so it is instant. A failure is logged at ERROR, never swallowed:
    # the release checks the start-up log for this line before the key is attached.
    try:
        await db[C.OWNER_MFA].create_index(
            [("uid", ASCENDING)], unique=True, name=OWNER_MFA_UID_INDEX
        )
    except Exception:  # noqa: BLE001 — start-up continues; enrolment is not yet possible without the key
        log.exception("owner_mfa: the uid unique index could not be built")

    # Audit is append-only and queried by actor, subject and time.
    await db[C.AUDIT].create_index([("at", DESCENDING)])
    await db[C.AUDIT].create_index([("actor.uid", ASCENDING), ("at", DESCENDING)])
    await db[C.AUDIT].create_index([("actor.team", ASCENDING), ("at", DESCENDING)])
    await db[C.AUDIT].create_index([("subject.type", ASCENDING), ("subject.id", ASCENDING), ("at", DESCENDING)])
    await db[C.AUDIT].create_index([("action", ASCENDING), ("at", DESCENDING)])
    await db[C.AUDIT].create_index([("card_id", ASCENDING)])

    await db[C.LEDGER].create_index([("holder_type", ASCENDING), ("holder_id", ASCENDING), ("at", DESCENDING)])
    await db[C.LEDGER].create_index([("currency", ASCENDING), ("at", DESCENDING)])
    await db[C.LEDGER].create_index([("card_id", ASCENDING)])
    # Idempotency — the same operation key can never be applied twice.
    await db[C.LEDGER].create_index([("idempotency_key", ASCENDING)], unique=True, sparse=True)

    await db[C.BALANCES].create_index(
        [("holder_type", ASCENDING), ("holder_id", ASCENDING), ("currency", ASCENDING)],
        unique=True,
    )

    await db[C.CARDS].create_index([("stage", ASCENDING), ("created_at", DESCENDING)])
    await db[C.CARDS].create_index([("team", ASCENDING), ("stage", ASCENDING)])
    await db[C.CARDS].create_index([("requested_by.uid", ASCENDING), ("created_at", DESCENDING)])

    # A partner's `_id` is the Firestore agency/seller document id. Mongo's own
    # `_id` index is unique and cannot be dropped, and that is what makes
    # `partner_ops.ensure_partner_record` idempotent: a second creation raises
    # DuplicateKeyError and is answered with the record that already exists,
    # rather than producing a second one or resetting the first.
    await db[C.PARTNERS].create_index([("kind", ASCENDING), ("status", ASCENDING)])
    # Unique **and sparse**: a partner whose Firestore document has no crmId is
    # written with the key absent, never with an explicit null — a sparse index
    # still indexes nulls, so one null would block every later one.
    await db[C.PARTNERS].create_index([("crm_id", ASCENDING)], unique=True, sparse=True)
    # `list_partners` sorts on this; without the index every partner listing is
    # an in-memory sort of the whole collection.
    await db[C.PARTNERS].create_index([("created_at", DESCENDING)])
    # `partners.sub_agencies_of` — a parent's sub-agencies and what it owes each.
    await db[C.PARTNERS].create_index([("kind", ASCENDING), ("parent_id", ASCENDING)])
    # `partners.overdue_sellers` — the recovery worklist, and the credit
    # exposure aggregate beside it.
    await db[C.PARTNERS].create_index(
        [("kind", ASCENDING), ("credit.due_at", ASCENDING)]
    )

    await db[C.RATES].create_index([("key", ASCENDING), ("effective_from", DESCENDING)])

    # Duplicate-payment detection scans cards by payment reference. Without this
    # index it is a full collection scan on every coin purchase, and the check
    # would quietly get slower until someone turned it off.
    await db[C.CARDS].create_index([("payload.payment_ref", ASCENDING)], sparse=True)
    await db[C.CARDS].create_index([("stage", ASCENDING), ("executed_at", DESCENDING)])

    # ── Operating expenditure ────────────────────────────────────────────────
    #
    # The profit statement groups executed expense cards by category over a date
    # window on every run, and the Sunday email runs it for every owner. Without
    # this the P&L scans the whole card collection each time, and it would get
    # slower with every card the business ever raised.
    await db[C.CARDS].create_index(
        [("type", ASCENDING), ("stage", ASCENDING), ("executed_at", DESCENDING)]
    )
    # The recurring worklist and the register, which ask "what is on the books
    # for this month" rather than "what was paid in this window".
    await db[C.CARDS].create_index(
        [("payload.period", ASCENDING), ("payload.category", ASCENDING)], sparse=True
    )
    # Duplicate-invoice detection, shown on the card before an owner signs.
    await db[C.CARDS].create_index([("payload.invoice_ref", ASCENDING)], sparse=True)
    # UGP-D: one deduction card per warning (see WARNING_CARD_INDEX).
    await ensure_warning_card_index(db)

    await db[C.SALES].create_index([("seller_id", ASCENDING), ("created_at", DESCENDING)])
    await db[C.SALES].create_index([("status", ASCENDING), ("created_at", DESCENDING)])
    await db[C.SALES].create_index([("buyer_uid", ASCENDING), ("created_at", DESCENDING)])
    # Recharges: the CRM queue by status, a buyer's own list, a seller's own
    # list — and the duplicate-reference check, which is per seller because two
    # sellers' banks may legitimately issue the same UTR.
    await db[C.RECHARGES].create_index([("status", ASCENDING), ("created_at", DESCENDING)])
    await db[C.RECHARGES].create_index([("buyer_uid", ASCENDING), ("created_at", DESCENDING)])
    await db[C.RECHARGES].create_index([("seller_id", ASCENDING), ("created_at", DESCENDING)])
    await ensure_recharge_reference_index(db)
    await ensure_recharge_request_id_index(db)   # RF-30

    await db[C.SUBAGENCY_PAYOUTS].create_index([("status", ASCENDING), ("created_at", DESCENDING)])
    await db[C.SUBAGENCY_PAYOUTS].create_index([("card_id", ASCENDING)])
    await db[C.SUBAGENCY_PAYOUTS].create_index([("parent_id", ASCENDING), ("sub_id", ASCENDING)])

    # ── Delivery records — 8A.2.14 / 8A.2.15 ─────────────────────────────────
    #
    # `dedupe_key` is unique and sparse, and it is the whole idempotency story
    # for email. A record is inserted *before* the provider is called, so two
    # Cloud Run instances racing on the same event, or Cloud Scheduler retrying
    # a trigger that already ran, collide here and the second one does not send.
    await db[C.EMAIL_DELIVERIES].create_index(
        [("dedupe_key", ASCENDING)], unique=True, sparse=True
    )
    await db[C.EMAIL_DELIVERIES].create_index([("queued_at", DESCENDING)])
    await db[C.EMAIL_DELIVERIES].create_index([("outcome", ASCENDING), ("queued_at", DESCENDING)])
    await db[C.EMAIL_DELIVERIES].create_index([("kind", ASCENDING), ("queued_at", DESCENDING)])
    await db[C.EMAIL_DELIVERIES].create_index([("to", ASCENDING), ("queued_at", DESCENDING)])
    # The SendGrid event webhook arrives keyed only by the provider's message
    # id, so a bounce can only be matched back to a send through this index.
    await db[C.EMAIL_DELIVERIES].create_index(
        [("provider_message_id", ASCENDING)], sparse=True
    )

    # ── Alert suppression state — 8A.1.4 ─────────────────────────────────────
    await db[C.ALERT_STATE].create_index([("key", ASCENDING)], unique=True)
    await db[C.ALERT_STATE].create_index([("alert", ASCENDING), ("last_sent_at", DESCENDING)])

    # ── Subscriptions — 8A.3.13 / 8A.3.15 ────────────────────────────────────
    # One row per (report, cadence, address): the same person can hold the daily
    # summary and not the weekly one.
    await db[C.REPORT_SUBSCRIPTIONS].create_index(
        [("report", ASCENDING), ("cadence", ASCENDING), ("email", ASCENDING)],
        unique=True,
    )
    await db[C.REPORT_SUBSCRIPTIONS].create_index([("email", ASCENDING)])

    # ── Scheduled run log ────────────────────────────────────────────────────
    await db[C.SCHEDULED_RUNS].create_index([("job", ASCENDING), ("started_at", DESCENDING)])

    # ── The weekly business report, as a record ──────────────────────────────
    #
    # `_id` is the ISO week for revision 0 and `{week}#r{n}` for a deliberate
    # re-run, so Mongo's own unique `_id` index is what makes generation
    # idempotent: a second run of the same week collides on insert and is
    # answered with the document that already exists, rather than producing a
    # second report or overwriting the first. That is the same mechanism
    # `partner_ops.ensure_partner_record` relies on, and for the same reason —
    # a read-then-write check loses a race, a unique index does not.
    await db[C.WEEKLY_BUSINESS_REPORTS].create_index(
        [("week_label", ASCENDING), ("revision", ASCENDING)]
    )
    await db[C.WEEKLY_BUSINESS_REPORTS].create_index([("generated_at", DESCENDING)])

    # ── Chance mechanics — Part 8B ───────────────────────────────────────────
    #
    # `chance_configs` is unique on (mechanic_id, version) and that uniqueness is
    # the concurrency control on the whole configuration path: two people
    # proposing a change at the same moment compute the same next version and
    # the second one collides on insert, rather than both being signed and one
    # silently winning. Nothing here is ever updated in place except the status
    # of a version, so a signed table cannot be edited after the signature.
    await db[C.CHANCE_CONFIGS].create_index(
        [("mechanic_id", ASCENDING), ("version", ASCENDING)], unique=True
    )
    await db[C.CHANCE_CONFIGS].create_index(
        [("mechanic_id", ASCENDING), ("status", ASCENDING)]
    )
    await db[C.CHANCE_CONFIGS].create_index([("card_id", ASCENDING)], sparse=True)

    # `live_version: {$ne: null}` is the query behind `visible_mechanics`, which
    # runs on every catalogue request a player's app makes.
    await db[C.CHANCE_MECHANICS].create_index([("live_version", ASCENDING)])

    # A round is looked up by its own id on every play, by player for the
    # history (8B.5.5), and by mechanic and day for exposure and actual-versus-
    # theoretical RTP (8B.4.2 / 8B.5.1).
    await db[C.CHANCE_ROUNDS].create_index([("round_id", ASCENDING)], unique=True)
    await db[C.CHANCE_ROUNDS].create_index(
        [("player_uid", ASCENDING), ("played_at", DESCENDING)]
    )
    await db[C.CHANCE_ROUNDS].create_index(
        [("mechanic_id", ASCENDING), ("played_at", DESCENDING)]
    )
    await db[C.CHANCE_ROUNDS].create_index(
        [("country", ASCENDING), ("played_at", DESCENDING)]
    )
    await db[C.CHANCE_ROUNDS].create_index([("status", ASCENDING), ("played_at", DESCENDING)])
    # Unique **and sparse** — only an externally settled round has one. This is
    # what makes a third-party provider's retry idempotent: the second callback
    # collides here and is answered with the settlement that already happened,
    # rather than crediting the player twice (8B.1.4).
    await db[C.CHANCE_ROUNDS].create_index(
        [("provider_round_ref", ASCENDING)], unique=True, sparse=True
    )

    # ── Exposure counters — 8B.4.3 / 8B.4.4 ──────────────────────────────────
    #
    # `key` is unique, and that uniqueness is the whole concurrency control on
    # every payout ceiling in the system. A gate is consumed by
    # `update_one({"key": k, "paid_out": {"$lte": limit - amount}}, {"$inc": …})`
    # — one document, one atomic compare-and-increment. Two rounds settling at
    # the same instant cannot both match the filter, so they cannot both slip
    # under the ceiling; the second is answered with the headroom that is
    # genuinely left and the shortfall is withheld rather than minted. Exactly
    # the mechanism `alert_state.key` uses to make an alert fire once, applied
    # to money instead of to email.
    await db[C.CHANCE_EXPOSURE].create_index([("key", ASCENDING)], unique=True)
    await db[C.CHANCE_EXPOSURE].create_index(
        [("mechanic_id", ASCENDING), ("day", ASCENDING)]
    )
    await db[C.CHANCE_EXPOSURE].create_index([("kind", ASCENDING), ("day", ASCENDING)])

    # ── Frozen players — 8B.5.4 ──────────────────────────────────────────────
    # `_id` is the player uid, so a second freeze of the same player is an
    # update of one row rather than a second row that disagrees with the first.
    await db[C.CHANCE_PLAYER_FLAGS].create_index(
        [("frozen", ASCENDING), ("flagged_at", DESCENDING)]
    )

    # ── Player protection — 8B.6 ─────────────────────────────────────────────
    #
    # `_id` is the player uid, so there is exactly one protection record per
    # player and a second `self_exclude` is an update of that row rather than a
    # second row that disagrees with it. Mongo's own `_id` index is what makes
    # that true under a race — the same mechanism `partner_ops` relies on.
    #
    # The two secondary indexes are sweeps, not lookups: "whose cooling-off ends
    # today" and "whose self-exclusion term has been served", which is what a
    # support screen asks. Sparse, because most players have neither.
    await db[C.PLAYER_PROTECTION].create_index(
        [("cooling_off.until", ASCENDING)], sparse=True
    )
    await db[C.PLAYER_PROTECTION].create_index(
        [("self_exclusion.status", ASCENDING), ("self_exclusion.minimum_until", ASCENDING)],
        sparse=True,
    )

    # A flag is looked up by its own id on review, listed by status for the
    # queue, and listed by player on a support screen.
    await db[C.PLAYER_PROTECTION_FLAGS].create_index(
        [("flag_id", ASCENDING)], unique=True
    )
    await db[C.PLAYER_PROTECTION_FLAGS].create_index(
        [("status", ASCENDING), ("detected_at", DESCENDING)]
    )
    await db[C.PLAYER_PROTECTION_FLAGS].create_index(
        [("player_uid", ASCENDING), ("detected_at", DESCENDING)]
    )
    # **Unique while open.** One open flag per player per pattern, enforced by
    # the database rather than by the read-then-write in `raise_flags`: two
    # detections racing on the same pattern must not produce two identical cards
    # on somebody's queue, because a queue full of duplicates is a queue that
    # gets ignored, and an ignored queue looks like a control from the outside
    # while being none. A partial filter rather than a sparse index, so a
    # reviewed flag is out of the constraint entirely and the same pattern can
    # legitimately be raised again later.
    await db[C.PLAYER_PROTECTION_FLAGS].create_index(
        [("player_uid", ASCENDING), ("pattern", ASCENDING)],
        unique=True,
        partialFilterExpression={"status": "open"},
    )

    # The loss window in `player_protection.loss_in_window` matches on player,
    # status and a `played_at` range on every single play. The
    # (player_uid, played_at) index above serves it, but with status in the key
    # the aggregation never touches a committed or void round at all — and this
    # query runs before the stake moves, so its cost is on the hot path.
    await db[C.CHANCE_ROUNDS].create_index(
        [("player_uid", ASCENDING), ("status", ASCENDING), ("played_at", ASCENDING)]
    )

    log.info("MongoDB indexes ensured")
