"""Application settings, loaded from environment."""

import os
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core import isolation


def _env_file() -> str:
    """Which dotenv file this process reads. Exactly one, never a merge.

    `ZIPPER_ENV_FILE` names it explicitly. Otherwise `.env.local` — the local
    development configuration (emulators, a MongoDB on this machine) — is used
    whenever it exists, and `.env` only when it does not. One file rather than
    `.env` overlaid with `.env.local`, so a value left out of the local file can
    never fall through to whatever `.env` holds. Relative to the working
    directory, as before. Containers ship neither file (see backend/Dockerfile).
    """
    chosen = os.environ.get("ZIPPER_ENV_FILE", "").strip()
    if chosen:
        return chosen
    return ".env.local" if os.path.exists(".env.local") else ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_env_file(), extra="ignore")

    environment: str = "development"
    api_port: int = 8080

    # MongoDB — must be a replica set; transactions are required for the ledger.
    mongo_uri: str = "mongodb://localhost:27017/?replicaSet=rs0"
    mongo_db: str = "zipper"

    # Firebase
    firebase_credentials_path: str = "../serviceAccountKey.json"
    firebase_project_id: str = ""
    #: Storage bucket for the mobile app's uploads. Needed to mint signed URLs
    #: for host verification photographs — `firebase_admin.storage.bucket()`
    #: raises without it, and the default is NOT derivable from the project id:
    #: this project uses the newer `.firebasestorage.app` suffix, not
    #: `.appspot.com`. It matches the bucket in firebase.json.
    firebase_storage_bucket: str = "zipper-83816.firebasestorage.app"

    #: The local emulators, outside production only. Read from the environment
    #: or the env file; `firebase.init()` refuses to start a non-production
    #: process unless all three are set and on this machine, and then exports
    #: them for the SDKs. See app/core/isolation.py. Never set in production.
    firestore_emulator_host: str = ""
    firebase_auth_emulator_host: str = ""
    storage_emulator_host: str = ""

    # ── Session tokens ───────────────────────────────────────────────────────
    jwt_secret: str = "change-me"
    jwt_issuer: str = "zipper-api"

    #: How long a session token is honoured. **Seven days**, which is the figure
    #: the owner asked for, and every one of these is an environment variable
    #: rather than a constant so it can be shortened without a deploy.
    #:
    #: It was 720 — twelve hours — and twelve hours is the whole of the
    #: complaint. Somebody who signs in at nine in the morning is refused by
    #: nine that evening, and the CRM's only answer to a refusal was to clear
    #: the token and say the session had ended. A week means the ordinary
    #: working rhythm — a laptop closed on Friday and opened on Monday — never
    #: reaches the expiry at all, and `session_renew_before_minutes` below means
    #: somebody who is using the CRM never gets near it either.
    #:
    #: A week is not free, and the mitigation is `renew_session` in
    #: `app/core/security.py`: every renewal rotates the token, revokes the one
    #: it replaced, and re-reads the account from Mongo. A stolen token is worth
    #: at most the remainder of one window, and is dead the moment the real
    #: holder's browser renews or an admin deactivates them.
    session_ttl_minutes: int = 10_080

    #: The observer's session, deliberately NOT the figure above.
    #:
    #: The observer has no password and no Firebase login: each sign-in is a
    #: one-time code delivered to a mailbox that is not the account address, and
    #: `renew_session` refuses to renew an observer session for the same reason.
    #: Making a one-time code into a week-long credential would undo the control
    #: it exists to be. Twelve hours is exactly what it was before this change.
    observer_session_ttl_minutes: int = 720

    # ── Owner MFA (P1-A3) ───────────────────────────────────────────────────
    #: An Owner session is limited to the MFA routes until it has passed a TOTP
    #: (or recovery-code) check. Replaces the browser-only three-question gate.
    owner_mfa_required: bool = True
    #: Fernet key (urlsafe base64, 32 bytes) that encrypts TOTP secrets at rest.
    #: Generate with `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
    #: and deliver it like JWT_SECRET (Secret Manager). Unset = enrolment is
    #: refused (fail closed): an Owner cannot finish signing in until it is set.
    owner_mfa_encryption_key: str = ""
    #: Shown in the authenticator app beside the account name.
    owner_mfa_issuer: str = "Zipper CRM"
    #: Consecutive wrong codes before the account's MFA is locked for a while.
    owner_mfa_max_failures: int = 5
    owner_mfa_lock_minutes: int = 15
    #: How long a started-but-unconfirmed enrolment stays valid.
    owner_mfa_enrol_minutes: int = 15

    #: How long after a token's `exp` it may still be renewed silently.
    #:
    #: This is the "long time no see" line, and it is the only place it is
    #: drawn. Inside it the CRM renews without a word; outside it the person is
    #: asked to sign in again. Three days on top of a seven-day token means
    #: somebody has to be away from the CRM for ten days before they are asked
    #: for a password — which is the owner's "if they are regularly visiting" in
    #: numbers, with a long weekend of margin on it.
    #:
    #: The renewal window is also why a session *record* outlives its token: see
    #: `issue_session`, which sets the reaping timestamp to `exp` plus this, so
    #: the revocation flag is still there to be read during the grace period.
    session_renewal_grace_minutes: int = 4_320

    #: How stale an account-state answer may be, in seconds, on the hot path.
    #:
    #: `verify_session` reads the session document and trusts the role claim on
    #: it. That was the whole of the per-request check, so a staff member whose
    #: row was deactivated by a path that does not revoke sessions — a script, a
    #: migration, a hand edit in Atlas — kept every non-permission-gated route,
    #: and a partner kept *everything*, because no per-request state check
    #: existed for one at all.
    #:
    #: Re-reading the authoritative record on every request would be a second
    #: database round trip per call. Instead the answer is cached on the session
    #: document and refreshed at most this often, which bounds BOTH the cost (one
    #: extra read and write per session per minute) and the staleness (a
    #: deactivation is honoured within a minute even when nothing revoked).
    #:
    #: Set to 0 to check on every request — correct, and more expensive.
    auth_state_recheck_seconds: int = 60

    #: When the browser should renew. Served on every session response as
    #: `renew_at`, so the CRM does not carry a second copy of this number.
    #:
    #: One day before expiry. With a seven-day token that is six days of
    #: ordinary use before the first renewal, and any visit after that renews;
    #: the renewal is a single POST that nothing on screen waits for.
    session_renew_before_minutes: int = 1_440

    # Observer access
    observer_email: str = "314zipper@gmail.com"
    observer_otp_delivery_email: str = "soumyars675@gmail.com"
    otp_ttl_minutes: int = 10
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 60
    #: B-4 (B3): `POST /auth/observer/request-code` is unauthenticated. A new
    #: request no longer voids the codes already out there, and on top of the
    #: resend cooldown it is limited per calling address AND globally over a
    #: window — the global one is the limit nobody can dodge, and it also
    #: bounds the mail the delivery mailbox can be made to receive. With a
    #: 60 s cooldown and a 10-minute TTL at most ten codes can ever be live.
    otp_request_window_minutes: int = 10
    otp_request_limit_per_ip: int = 3
    otp_request_limit_global: int = 8
    #: The Observer's second factor (authenticator app) has NO switch: spec §8
    #: allows no bypass for the identity that provisions Owners. It shares the
    #: Owner MFA settings above (encryption key, lockout, enrolment window).

    # Email
    sendgrid_api_key: str = ""
    mail_from: str = "no-reply@zipper.app"
    mail_from_name: str = "Zipper"

    # Where partner-facing mail points people. Used in links only; no figure is
    # ever derived from it.
    portal_url: str = "https://zipper.web.app"
    # The address a partner replies to. Empty falls back to `mail_from`.
    support_email: str = ""

    # ── Sender identities — one domain, three visible addresses ──────────────
    #
    # Every one of these must be on the **same authenticated domain** as
    # `mail_from`. That is not a style preference: SPF and DKIM align on the
    # domain, and a From on a domain SendGrid is not authenticated for is
    # unaligned mail, which is what lands in spam (see DEPLOYMENT.md §"Email
    # deliverability"). `email.sender_alignment()` checks this at send time and
    # records the answer on the delivery row rather than leaving it to be
    # guessed from a spam folder.
    #
    # Empty means "use `mail_from`", so a deployment that sets nothing behaves
    # exactly as it did before these settings existed.

    #: A person's own event — an approval, a receipt, a one-time code. Replies
    #: to it are expected and go to a human.
    mail_from_transactional: str = ""
    mail_from_name_transactional: str = ""
    #: Scheduled reports and alerts. Machine-generated, high volume, unsubscribe
    #: headers attached. Kept apart from the transactional address so that a
    #: reputation problem on the report stream cannot stop a payout receipt.
    mail_from_bulk: str = ""
    mail_from_name_bulk: str = ""
    #: The mailbox a human actually reads. Used as `Reply-To` on everything, so
    #: a partner replying to a no-reply address still reaches somebody.
    #: Empty falls back to `support_email`, then to `mail_from`.
    mail_from_support: str = ""

    #: Where a `List-Unsubscribe` mailto: points. Empty is derived as
    #: `unsubscribe@<the mail_from domain>`, which must be a real mailbox or an
    #: alias that reaches one — Gmail checks that it does not hard-bounce.
    unsubscribe_email: str = ""
    #: The RFC 8058 one-click endpoint. `List-Unsubscribe-Post` is only ever
    #: emitted when this is set, because a one-click header pointing at nothing
    #: is worse for reputation than no header at all. Set it to
    #: `https://<api host>/api/notifications/unsubscribe` — the route exists and
    #: is token-authenticated; see `routers/notifications.py`.
    unsubscribe_url: str = ""

    # A send that hangs is a send nobody can account for. SendGrid is given this
    # long and no longer; a timeout is recorded as a failed delivery (8A.2.15).
    email_timeout_seconds: int = 20
    # SendGrid's hard ceiling is ~30 MB total; a report CSV that exceeds this is
    # linked rather than attached, and the mail says so.
    email_max_attachment_bytes: int = 5_000_000
    # Everything on one message, base64 included. SendGrid's documented limit is
    # 30 MB for the whole request; this leaves room for the body and the headers.
    email_max_total_attachment_bytes: int = 20_000_000
    # How many rows of a report are shown in the email body. The full table is
    # always the attached CSV — the body is a preview, never a second version.
    email_report_preview_rows: int = 12

    # ── Provider, retries and the SendGrid names ────────────────────────────
    #
    # EMAIL_PROVIDER names the one provider mail goes through. Anything other
    # than "sendgrid" — a deliberate "disabled" included — sends nothing and
    # records the delivery as not_configured, exactly like a missing key.
    email_provider: str = "sendgrid"
    #: One send asks SendGrid at most this many times (capped at 5), and asks
    #: again only after an attempt SendGrid provably did not take — see
    #: `email._attempt_class`. Bulk mail always makes exactly one attempt.
    email_max_attempts: int = 3
    #: The first wait between attempts; the second is twice this, plus jitter.
    email_retry_base_delay_seconds: float = 1.0
    #: The whole send — every attempt and wait. No attempt starts with less
    #: than 5 s of it left.
    email_send_budget_seconds: int = 30
    #: The names the SendGrid configuration uses. When set, each replaces its
    #: older counterpart — SENDGRID_FROM_EMAIL → MAIL_FROM, SENDGRID_FROM_NAME →
    #: MAIL_FROM_NAME, SENDGRID_REPLY_TO → MAIL_FROM_SUPPORT — once, in
    #: `get_settings()` (see `apply_sendgrid_names`), so every use of the sender
    #: (alignment, unsubscribe mailbox, hints) sees one value. Empty leaves the
    #: older names in charge.
    sendgrid_from_email: str = ""
    sendgrid_from_name: str = ""
    sendgrid_reply_to: str = ""

    # ── Composed broadcasts — a person writing to a whole audience (8A.7.2) ──
    #
    # Every other email this system sends is generated from a record: a payout
    # was approved, a week ended, a threshold tripped. A broadcast is the one
    # a person types, and its blast radius is the whole customer base — so the
    # limits below are not tuning knobs, they are the shape of what one click
    # is allowed to do.

    #: The most recipients one composed send may reach. An audience larger than
    #: this is **refused**, not truncated: half a broadcast is worse than none,
    #: because nobody can tell from the outside which half arrived.
    #:
    #: The number is arithmetic, not taste. `email.deliver_many` sends serially,
    #: one blocking provider call per recipient, and the send happens inside the
    #: HTTP request that asked for it. At roughly 200 ms a message and
    #: `broadcast_concurrency` slices in flight, 2,000 recipients is about 50
    #: seconds — inside Cloud Run's default 300 s request timeout with room to
    #: spare. Raising this without moving the send onto a queue is how a
    #: broadcast ends up half-delivered by a timeout.
    broadcast_max_recipients: int = 2_000

    #: Above this many recipients the request must echo the exact resolved count
    #: back before anything is sent. The count is the last chance to notice the
    #: audience is wrong, so above a certain size seeing it is not optional.
    broadcast_confirm_above: int = 25

    #: How many messages one `deliver_many` slice carries. Small enough that a
    #: throttle is noticed within a second or two rather than after a thousand
    #: messages have already been refused.
    broadcast_batch_size: int = 25

    #: How many slices are in flight at once. Each is a serial `deliver_many`,
    #: so this is the real send concurrency against SendGrid. SendGrid's own
    #: documented limit for the v3 mail send endpoint is far above this; the
    #: ceiling that matters is our own thread pool.
    broadcast_concurrency: int = 8

    #: Seconds to wait between waves. Deliberate politeness: a broadcast is not
    #: urgent, and a sender that paces itself never discovers the throttle.
    broadcast_wave_pause_seconds: float = 0.5

    #: Consecutive waves that may come back throttled (HTTP 429) before the send
    #: stops. Stopping names every address that was never attempted, which is
    #: the only honest thing to do — continuing into a throttle turns a
    #: recoverable pause into a thousand recorded failures.
    broadcast_throttle_waves_before_stop: int = 3

    # ── Unattended service credentials ───────────────────────────────────────
    #
    # A standing key held by a machine, not a person. It is read here like every
    # other secret so it arrives from Secret Manager as a Cloud Run environment
    # variable and never from a file in the repo. See
    # `app/core/security.py` → SERVICE_CREDENTIALS for what it unlocks, which is
    # an explicit allowlist of two operations and nothing else.
    #
    # Empty means "no machine may call anything". That is the default, and a
    # deployment that never sets it is a deployment with no machine identity.
    service_key_weekly_accrual: str = ""

    # The sanity bound on one unattended accrual: the most commission a single
    # agency may be credited for a single period without a person looking at it.
    #
    # ₹12,50,000 = 125,000,000 paise. That is 25% — the top rate in the live
    # main-agency table — of ₹50,00,000, the upper bound the live table's own
    # top band declares. The table's authors wrote ₹50 lakh of billing in a
    # period as the largest figure they had in mind; above the commission that
    # implies, the run is outside the shape of the configured business and a
    # person should look before a liability is created. Nothing is capped or
    # truncated at this line — the accrual is refused whole, loudly, and a team
    # admin can still accrue it by hand after checking the ledger.
    service_accrual_max_minor: int = 125_000_000

    # The credential the scheduled jobs present to run reporting, alerting and
    # transactional email (8A.2, 8A.3, 8A.4). It unlocks exactly seven routes —
    # the six `/api/notifications/jobs/*` and `/provider-events` triggers, plus
    # `POST /api/reports/jobs/weekly-business` — and nothing else. No money moves
    # on any of them: the credential holds no commission operation at all.
    #
    # Read by `app/core/security.py` → `REPORTING`, which is the only thing that
    # reads it; nothing else in the API looks at this attribute.
    #
    # Same shape and same rules as `service_key_weekly_accrual`: at least
    # `security.MIN_SERVICE_KEY_CHARS` characters, compared by digest, empty
    # means no machine may call anything. It is deliberately a *different* key
    # from the accrual one so that leaking the ability to email a report does
    # not also grant the ability to create a commission liability.
    service_key_reporting: str = ""

    # The credential the two Firestore onboarding triggers present to register a
    # newly created agency or coin seller with the API, so the application lands
    # in the pending queue on /kyc, /agencies and /sellers instead of existing
    # only in Firestore where no staff screen can see it.
    #
    # It unlocks exactly one operation — `partner.register`, one route,
    # `POST /api/partner-ops/partners` — and nothing else. That route creates an
    # empty record: zero coins, zero credit, zero commission, zero cash,
    # `pending` and inactive. Approval remains a human decision behind
    # `require_write`, and every `/execute` and `/approve` still needs an owner.
    #
    # Read by `app/core/security.py` → `PARTNER_REGISTRATION`, which is the only
    # thing that reads it.
    #
    # A THIRD, DIFFERENT VALUE from the two above, deliberately. This one is
    # held by a trigger that fires on every public signup, so it is the most
    # frequently exercised machine path there is; it must not carry the ability
    # to accrue commission or to email a business-wide figure. Same rules
    # otherwise: at least `security.MIN_SERVICE_KEY_CHARS` characters, compared
    # by digest, empty means no machine may call anything — and an applicant
    # then sits in Firestore invisible to staff until somebody runs
    # `python -m scripts.backfill_partners --confirm`, which is the bug this
    # credential exists to stop.
    service_key_partner_registration: str = ""

    # ── Virtual account numbers — spec 4.3.4 / 8C.1 ──────────────────────────
    #
    # A VAN is a unique account number the **bank** maps onto one real, KYC-
    # compliant business current account (8C.1.1). Every payment into it says who
    # paid, how much and when, with no UTR to type and no screenshot to accept
    # (8C.1.5). Spec 4.3.4 issues one to every coin seller on approval.
    #
    # **It cannot be switched on yet.** HDFC sells this as eCMS, and 8C.8.7 is
    # explicit that the account underneath must be a business current account,
    # not a personal one. The owner is on a personal account, so there is no
    # collection account to map anything onto.
    #
    # These four settings are therefore **empty by default, and empty means "no
    # VAN is issued"** — never a fabricated number, never a prefix plus a
    # sequence, never anything derived from a partner id. `van_bank_configured()`
    # in `app/services/partner_ops.py` is the single predicate that reads them,
    # and with any one of them blank it answers False and the seller's record
    # says plainly that none has been issued and why.
    #
    # Configuring them is necessary but **not sufficient**: the number itself is
    # allocated by the bank, so an eCMS client must also be registered through
    # `partner_ops.register_van_allocator`. Configuration without a client issues
    # nothing and says so, which is the safe direction — a number this system
    # invented is not an account anyone can pay into.

    #: The collection provider. "hdfc_ecms" once the current account exists.
    #: Empty is the live value today and means no VAN is issued to anybody.
    van_provider: str = ""
    #: The IFSC every VAN under the collection account carries. The bank gives
    #: it; it is a fact about the account, not a format we choose.
    van_ifsc: str = ""
    #: The beneficiary name a payer must see when they add the VAN as a payee.
    #: Wrong here and a payment is rejected at the payer's own bank.
    van_beneficiary_name: str = ""
    #: The real current account every VAN maps onto (8C.1.3 — the VAN is an
    #: identifier, not a separate pot). Recorded on the partner's record so a
    #: statement line can be traced back to the account it actually landed in.
    van_collection_account: str = ""

    # ── The business day — which days a "daily" report covers ────────────────
    #
    # The ledger is stored in UTC and every window in `reports.py` is UTC. That
    # is right for arithmetic and wrong for a report: an owner in Mumbai reading
    # "yesterday" at breakfast means the calendar day that just ended where they
    # are, not [00:00 UTC, 24:00 UTC), which for them started and finished at
    # 05:30 in the morning and quietly folded five and a half hours of this
    # morning into it.
    #
    # So the *periods* the scheduled reports cover are resolved in this zone and
    # then converted to UTC before anything is queried. Only
    # `services/scheduling.py` reads this, and only to decide period boundaries
    # and the labels printed on them — no figure is computed from it, and the
    # on-demand `/api/reports/*` endpoints are untouched, because a caller who
    # passes explicit `since`/`until` means exactly what they passed.
    #
    # Asia/Kolkata is UTC+05:30 all year and has observed no daylight saving
    # since 1945, so the offset is a constant rather than something that shifts
    # a report window twice a year. A zone that *does* observe DST would still
    # work — the conversion is done with a real tzinfo — but the fallback below
    # would not, and `scheduling.business_tz()` refuses rather than guessing.
    report_timezone: str = "Asia/Kolkata"

    # ── Alert thresholds — 8A.4 ──────────────────────────────────────────────
    #
    # Every one of these is a setting, not a constant in the detector. An owner
    # who wants to be told about ₹50,000 rather than ₹1,00,000 changes an
    # environment variable; nobody edits Python to retune an alert.

    # 8A.4.4 / 8A.2.12 — "an owner-set amount". Stated in whole rupees because
    # that is how an owner thinks about it; converted to minor units once, in
    # `alerts.py`, and never re-derived.
    alert_large_amount_inr: int = 100_000

    # 8A.2.12 / 8A.4.7 — a card verified and waiting on a signature this long.
    alert_awaiting_signature_hours: int = 72
    # 8A.4.5 companion — signed, authorised, and the money still has not moved.
    alert_signed_not_executed_hours: int = 24
    # 8A.4.7 — any open queue item older than this breaches its ageing limit…
    alert_queue_age_hours: int = 48
    # …and past this it stops being the team's problem and becomes an owner's.
    alert_queue_escalate_hours: int = 96
    # 8A.4.9 — this many failed logins on one staff account inside this window.
    alert_failed_login_threshold: int = 5
    alert_failed_login_window_minutes: int = 60
    # 8A.4.3 — how far back the duplicate-payment-reference sweep looks.
    alert_duplicate_ref_lookback_days: int = 90
    # 8A.4.6 — a gateway settlement is allowed to differ from the recorded
    # receipt by this many minor units (paise) before it is a mismatch. Rounding
    # at the aggregator is real; a rupee is not.
    alert_settlement_tolerance_minor: int = 100
    # 8A.4.2 — the economy rate feed is stale after this long without a change.
    alert_rate_stale_hours: int = 48
    # 8A.2.15 — how far back the failed-delivery sweep looks.
    alert_delivery_failure_lookback_hours: int = 24
    # 8A.2.10 — "credit due in 3 days".
    credit_due_notice_days: int = 3
    # 8A.2.11 — an overdue seller is reminded on this cadence, not every scan.
    credit_overdue_repeat_hours: int = 72

    # ── Money integrity — B1 ─────────────────────────────────────────────────
    #
    # M-1: a Firestore balance replica left behind by a failed sync is alerted
    # once it has been stale this long. The transactional sweep repairs it
    # every 15 minutes; a replica still stale after this many minutes is one
    # the repair could not fix, which is what the alert is for.
    alert_replica_stale_minutes: int = 10
    # §8 Owner-alone decisions: the other Owners must be told. A notification
    # that is still pending (in-app or email not delivered) after this long is
    # raised as an alert; the sweep keeps retrying it meanwhile.
    alert_owner_notice_pending_minutes: int = 30
    # M-11 / M-14: a recharge or sale claimed by a process that died — status
    # `approving` / `refunding` / `failed` — is raised once it is this old.
    alert_money_claim_stale_minutes: int = 30
    # M-4: the rupee difference below which a day's app economy (Firestore
    # platformRevenue) and its own ledgers are considered to agree.
    reconciliation_tolerance_inr: float = 10.0

    # M-5 — OWNER_DECISION_PENDING. How many whole weeks a closed earnings week
    # is held before it is released for withdrawal. The spec says "the exact
    # settlement policy remains an Owner decision"; `0` keeps the behaviour the
    # Cloud Function has today (a week is released on the Monday after it
    # closes). The release itself runs in `functions/src/payouts.ts`; this
    # setting is published by `GET /api/reports/payout-policy` so the CRM, the
    # app and the Function read one figure.
    payout_release_arrears_weeks: int = 0

    # ── Repeat suppression — how an alert avoids becoming noise ──────────────
    #
    # The same condition, still true, does not email again inside this window.
    # 8A.1.4: mail that becomes noise gets ignored, and then a real alert gets
    # ignored too.
    alert_repeat_hours: int = 24
    # A scan asked to cover "since the last run" never looks further back than
    # this, so a job that has been off for a month does not wake up and send a
    # month of history in one go.
    alert_scan_max_lookback_hours: int = 72

    # ── Chance mechanics — exposure and monitoring, 8B.4 / 8B.5 ──────────────
    #
    # The *money* limits of a chance mechanic — its reserve and its per-round,
    # per-player-per-day and platform-per-day ceilings — are **not** here. They
    # are part of the signed, versioned configuration of the mechanic itself
    # (8B.2.8 / 8B.4.3), because they are money and money changes on a card.
    # See `app/services/chance.py` → `_exposure_rules`.
    #
    # What is here is everything that is *not* a per-mechanic money figure: the
    # one cross-mechanic backstop, and the statistics that decide when a run of
    # bad luck stops being a run of bad luck.

    #: 8B.4.4, the widest reading — "platform-wide per day" across **every**
    #: mechanic at once, not per mechanic. A mechanic's own daily ceiling is in
    #: its signed configuration; this is the aggregate above all of them, and it
    #: has no mechanic to hang a configuration card on, so it is a setting like
    #: every other threshold in this file.
    #:
    #: **Zero means no cross-mechanic ceiling**, which is the shipped default —
    #: with one lucky gift tier live the per-mechanic ceilings are the whole of
    #: the control, and a second ceiling that nobody has sized is a number that
    #: gets raised until it means nothing (8B.4.1).
    chance_platform_daily_payout_ceiling: int = 0

    #: 8B.4.3 — how much of the reserve may be consumed before an owner is told,
    #: in ppm of the reserve. 800,000 ppm is 80%: the mechanic is still paying,
    #: still inside its modelled range, and somebody has a day's notice before
    #: the auto-suspend rather than finding out from the suspension itself.
    chance_reserve_warning_ppm: int = 800_000

    # ── 8B.5.1 / 8B.5.2 — actual RTP against configured RTP ──────────────────
    #
    # These are **sigmas in thousandths**, not percentages, and that is the
    # whole argument of 8B.4.1 expressed as a number. A flat "actual is more
    # than 5% above configured" alert fires constantly on a small day and never
    # on a large one, because the spread of a sample shrinks with its size. The
    # detector therefore compares the observed payout against the *exact*
    # variance of the configured outcome table (Σp(m−μ)², computed on integers
    # from the signed table itself) and alerts on how many standard deviations
    # away it landed. That number is comparable across mechanics, across days
    # and across stake sizes; a percentage gap is not.

    #: A single day, per mechanic. 4σ two-sided is about one day in 16,000 by
    #: chance — roughly one false alert every forty years at ten mechanics.
    #: A day this far out is not variance.
    chance_rtp_daily_sigma_milli: int = 4_000

    #: The **persistent** gap of 8B.5.2, pooled over a rolling window. Pooling
    #: buys power, so the bar comes down to 3σ: a 3σ excursion sustained over a
    #: week is not a run of luck, and it is exactly the shape a mis-set table,
    #: an exploit or a bug produces. One day at 3σ is ignored deliberately.
    chance_rtp_window_sigma_milli: int = 3_000
    chance_rtp_window_days: int = 7

    #: No alert below this many rounds however extreme the figure. The normal
    #: approximation the sigma rests on is invalid in the tail of a heavy-tailed
    #: multiplier distribution at small N — three rounds containing one 50× is a
    #: 6σ event and an entirely ordinary evening. The figure is still reported;
    #: it is not *alerted* on.
    chance_rtp_min_rounds: int = 200

    # ── 8B.5.3 — player-level anomaly detection ──────────────────────────────

    #: One player's own return against the table's. Higher than the mechanic's
    #: bar, and for a reason that has nothing to do with the player: this test
    #: runs against every active player every day, so the multiple-comparison
    #: correction is the threshold. 5σ is about one player in 3.5 million.
    chance_player_sigma_milli: int = 5_000
    #: And never below this many rounds, for the reason above.
    chance_player_min_rounds: int = 30

    #: 8B.5.3 "unusual frequency". A person tapping a gift as fast as a person
    #: can tap manages a few a second in bursts and nothing like this sustained.
    chance_player_max_rounds_per_hour: int = 240

    #: 8B.5.3 "impossible timing". Two settled rounds closer together than this,
    #: or a round played sooner than this after its own commitment was
    #: published, is a script rather than a person — and a round played *before*
    #: it was committed is a clock or an ordering fault, which is flagged
    #: whatever the figures below say.
    chance_player_min_round_gap_ms: int = 250
    chance_player_min_commit_to_play_ms: int = 50

    #: How far back the player sweep looks on each scan.
    chance_anomaly_lookback_hours: int = 24

    # ── Player protection — 8B.6 ─────────────────────────────────────────────
    #
    # Read by `app/services/player_protection.py` and by nothing else. Every
    # threshold in that module is one of these, because an owner who wants a
    # session reminder every thirty minutes rather than every sixty should
    # change an environment variable, not a detector.
    #
    # 8B.6.6 — "these protect the business as much as the player" — is why the
    # figures sit here beside the alert thresholds rather than in a compliance
    # document. They are operating limits on how much one account can lose us in
    # a day and how long one person can sit in a loop, and they are tuned the
    # same way every other limit in this system is.
    #
    # Diamonds are whole numbers; so is every figure below.

    #: The house's own daily and weekly loss ceilings, applied to **every**
    #: player. `0` means the business sets none and only a player's own limit or
    #: one imposed on a review applies.
    #:
    #: They default to 0 because a number invented here would silently become
    #: the product's behaviour in every market on the next deploy, and this
    #: figure is a commercial decision with a regulatory shadow over it
    #: (8B.0.3). Set them and the rule in `effective_limit` does the rest: the
    #: **lowest** limit set by anybody is the one enforced, so a house ceiling
    #: can never be loosened by a player and a player can always go below it.
    protection_default_daily_loss_limit: int = 0
    protection_default_weekly_loss_limit: int = 0

    #: The largest loss limit this system will store. Not a protection — a
    #: sanity bound, so a fat finger cannot write a number that reads as a limit
    #: and behaves as none.
    protection_max_loss_limit: int = 10_000_000

    #: How long a **raised** limit waits before it takes effect. A reduction is
    #: always immediate; only a loosening waits.
    #:
    #: This is the difference between a limit and a suggestion. A player who
    #: reaches their limit and can raise it in the same minute has been asked a
    #: question at the worst possible moment rather than protected. Twenty-four
    #: hours puts the decision on the other side of a night's sleep, and the old
    #: lower limit is enforced throughout.
    protection_limit_increase_delay_hours: int = 24

    #: The shortest self-exclusion this system will accept. Six months.
    #:
    #: A self-exclusion that can be set for an hour is a cooling-off period with
    #: a frightening name, and offering both would mean somebody reaching for
    #: the serious tool and getting the light one. The light one exists below.
    #: Nothing — not the player, not support, not an owner — shortens a term
    #: once it has started.
    protection_min_self_exclusion_days: int = 180

    #: The gap between a player asking for a served exclusion to be lifted and
    #: the earliest moment a member of staff may decide. Three days.
    #:
    #: The moment somebody asks to be let back in is the moment they are least
    #: well placed to judge whether they should be. The wait *is* the control.
    protection_exclusion_reflection_hours: int = 72

    #: The bounds on a cooling-off period a player sets for themselves. Below
    #: the floor it is a pause between two taps rather than a break; above the
    #: ceiling the honest tool is a self-exclusion, and unlike this one, that
    #: does not end on its own.
    protection_min_cooling_off_hours: int = 24
    protection_max_cooling_off_days: int = 90

    # ── 8B.6.3 — session reminders ───────────────────────────────────────────
    #: How often, in minutes of continuous play, a reminder falls due.
    protection_session_reminder_minutes: int = 60
    #: How long a break between two rounds ends a session. A session is derived
    #: from `chance_rounds` rather than reported by the app, so this gap is the
    #: whole definition of "continuous" — see `player_protection.session_from`.
    protection_session_gap_minutes: int = 30

    # ── 8B.6.4 — the harm patterns ───────────────────────────────────────────
    #: Escalating stakes after losses: this many consecutive losing rounds with
    #: a non-falling stake, ending at least this multiple of where it started.
    #: All three conditions together, because each alone is ordinary play.
    protection_harm_escalation_rounds: int = 5
    protection_harm_escalation_multiple: int = 3
    #: A sustained session — three hours of continuous play.
    protection_harm_session_minutes: int = 180
    #: Rapid repeat play — this many rounds inside this many minutes. Distinct
    #: from the session check, which is duration; this one is rate, and it
    #: catches somebody tapping without reading at minute nine.
    protection_harm_rapid_rounds: int = 20
    protection_harm_rapid_window_minutes: int = 10

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}


# ══════════════════════════════════════════════════════════════════════════════
#  Required secrets
# ══════════════════════════════════════════════════════════════════════════════
#
# `jwt_secret` has a source default of "change-me". That default exists so a
# developer can clone and run, and it is fine there — but it signs every session
# token this API issues, and it also derives the unsubscribe HMAC. Outside
# development a deployment that forgot to set it would mint session tokens
# anyone holding this repository could forge, silently and with no symptom.
#
# So the process refuses to start instead. A boot failure naming the variable is
# recoverable in a minute; a signing key the whole internet knows is not
# detectable at all.
#
# Development is exempt on purpose: making `uvicorn app.main:app` require a
# secret would be a tax on every contributor for no security gain on a laptop.

#: The placeholder values a deployment must never run with.
PLACEHOLDER_SECRETS = frozenset({"", "change-me", "changeme", "secret", "test"})

#: Minimum length for a signing secret. Below this, a key is guessable by brute
#: force regardless of how carefully it was generated.
MIN_SECRET_CHARS = 32

#: The only accepted values of ENVIRONMENT. Anything else refuses to start.
VALID_ENVIRONMENTS = frozenset({"development", "test", "production", "prod"})


class InsecureConfiguration(RuntimeError):
    """A required secret is missing, placeholder, or too short to be a secret."""


def secret_problems(s: "Settings") -> list[str]:
    """Every reason this configuration must not run, as sentences.

    Pure and importable, so `tests/test_auth_hardening.py` can exercise it
    without constructing an application or setting environment variables.

    Returns an empty list for a development environment: see the note above.
    """
    problems: list[str] = []

    # Fail closed on the environment itself. `is_production` gates every check
    # below, so a missing or misspelled ENVIRONMENT used to silently select the
    # development path — placeholder JWT secret accepted, wildcard CORS.
    env = (s.environment or "").strip().lower()
    if env not in VALID_ENVIRONMENTS:
        problems.append(
            f"ENVIRONMENT={s.environment!r} is not one of {sorted(VALID_ENVIRONMENTS)}."
        )
    # Cloud Run always sets K_SERVICE. A container running there is production,
    # whatever ENVIRONMENT says.
    if os.environ.get("K_SERVICE") and not s.is_production:
        problems.append(
            "Running on Cloud Run (K_SERVICE is set) but ENVIRONMENT is not 'production'."
        )
    if not s.is_production:
        return problems

    value = (s.jwt_secret or "").strip()
    if value.lower() in PLACEHOLDER_SECRETS:
        problems.append(
            "JWT_SECRET is unset or still the source placeholder. It signs every "
            "session token this API issues; a known value is a forgeable session."
        )
    elif len(value) < MIN_SECRET_CHARS:
        problems.append(
            f"JWT_SECRET is {len(value)} characters. At least {MIN_SECRET_CHARS} "
            "are required for a signing key."
        )

    # The service credentials are already length-floored where they are compared
    # (`core/security.MIN_SERVICE_KEY_CHARS`), and a short one is treated as
    # unset rather than accepted — so a missing one costs an automated job, not
    # a security boundary, and is deliberately NOT a boot failure here.

    return problems


def assert_secure_configuration(s: "Settings | None" = None) -> None:
    """Raise unless this configuration is safe to serve production traffic."""
    problems = secret_problems(s if s is not None else settings)
    if problems:
        raise InsecureConfiguration(
            "Refusing to start. "
            + " ".join(problems)
            + " Set the variable and redeploy."
        )


def apply_sendgrid_names(s: "Settings") -> "Settings":
    """SENDGRID_FROM_EMAIL / SENDGRID_FROM_NAME / SENDGRID_REPLY_TO, when set,
    replace MAIL_FROM / MAIL_FROM_NAME / MAIL_FROM_SUPPORT.

    Applied once, to the settings object the process uses, so the sender has a
    single value everywhere it is read. A plain function rather than a pydantic
    validator: it behaves the same on the real settings class and on the
    stand-ins the tests use.
    """
    for new, old in (
        ("sendgrid_from_email", "mail_from"),
        ("sendgrid_from_name", "mail_from_name"),
        ("sendgrid_reply_to", "mail_from_support"),
    ):
        value = str(getattr(s, new, "") or "").strip()
        if value:
            setattr(s, old, value)
    return s


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    apply_sendgrid_names(s)
    # Outside production no email leaves this process, whatever the env file
    # holds: the key is dropped here and every delivery records not_configured.
    isolation.disable_outbound_email_outside_production(s)
    return s


settings = get_settings()
