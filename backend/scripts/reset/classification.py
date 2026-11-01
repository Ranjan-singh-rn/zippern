"""THE TABLE. Every collection, subcollection, Storage prefix and Auth account the
reset knows about, and what happens to it. Nothing here is inferred at run time.

── THE RULE ──────────────────────────────────────────────────────────────────

Spec §14: "Delete only approved operational data: users, partners, money
history/ledgers, recharges, cards, tickets, appeals, KYC/uploads (profileMedia,
kyc, hostVerification), Auth accounts in approved scope, Mongo ledgers and audit
data. Keep app config, economy settings, gift catalogue, levels, Android update
document, app builds and Hosting configuration/assets." The Owner decided the
reset INCLUDES the existing Owner and Observer logins (re-seeded afterwards by
`seed.py` from a list the Owner supplies).

So each name below is one of:

  DELETE   a person's, partner's or staff member's record, anything derived from
           their activity, and all money / audit history. Deleted per id from a
           frozen manifest — never as a collection.
  KEEP     configuration, catalogues, content, and the system's own state that
           names no person and holds no money (the data canary, the scheduler's
           run log, alert suppression keys, versioned rates, chance tables).
           Never read for ids, never touched; counted so `postcheck` can prove
           it is unchanged.
  UNKNOWN  anything NOT in this file. The plan REFUSES with the name and the
           count; a person adds it here, deliberately, and re-plans.

A Storage prefix that holds personal files but was NOT approved for deletion
(seller documents, appeal evidence, payout screenshots …) is listed under
`STORAGE_UNDECIDED`: its objects are reported as UNKNOWN so the Owner decides
(move the prefix to DELETE or KEEP). Nothing is guessed.

Sources for the names: `firestore.rules` (every top-level `match`), the
Functions and app sources, `app/db/mongo.py` (`C.*`) plus the literal names in
`app/services/*.py`, `storage.rules`, and the logs of the 2026-10 reset.
`tests/test_reset_tooling.py` fails if a rules collection is missing here.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

DELETE = "DELETE"
KEEP = "KEEP"
UNKNOWN = "UNKNOWN"

# ══════════════════════════════════════════════════════════════════════════════
#  Firestore — top-level collections
# ══════════════════════════════════════════════════════════════════════════════

FIRESTORE_KEEP: dict[str, str] = {
    "appConfig": "app config: economy (rates), androidUpdate, paymentCredentials, profileOptions, dailyRewards, control, moderation",
    "gifts": "gift catalogue",
    "giftLottieData": "gift catalogue: animation JSON for the gift form",
    "bagItems": "catalogue: frames, entrances, bubbles, profile cards",
    "levelConfig": "levels (host / wealth ladders; `levels` subcollection)",
    "contentConfig": "app content configuration (and its nested documents)",
    "policies": "content: terms, privacy, community guidelines",
    "announcements": "content: staff-authored announcements shown in the app",
    "paymentConfig": "config: payment settings per country",
    "rechargePackages": "catalogue: recharge packages",
    "diamondPacks": "catalogue: diamond packs",
    "coinPackages": "catalogue: coin packages",
    "opsCanary": "ops: the Functions-side data canary (`opsCanary/target`)",
}

FIRESTORE_DELETE: dict[str, str] = {
    # ── people and their logins ──
    "users": "app accounts (every subcollection goes with the document)",
    "publicProfiles": "discovery mirror of users",
    "crmUsers": "CRM logins — staff, partners, and the Owners (re-seeded)",
    "staffRoster": "names-only staff list derived from crmUsers",
    "verifiedIdentities": "staff/partner identity cross-check for the app login (re-seeded for Owners)",
    "contactVerifications": "server ledger of verified contacts per uid",
    "identityResolutions": "per-login identity resolution records",
    "identityReleases": "identity release records (sign-in identity changes)",
    "identityChangeRefusals": "refused sign-in identity changes",
    "ownerMfaSessions": "Owner MFA bindings (Owners are re-seeded and re-enrol)",
    "guestDeviceBindings": "device → guest account map",
    "guestUidBindings": "guest uid bindings",
    "bannedDevices": "moderation: device bans tied to accounts",
    "authEvents": "sign-in events",
    "quickLoginTokens": "sign-in credentials (tokens)",
    "quickLoginChallenges": "sign-in nonces",
    "quickLoginRate": "sign-in rate counters",
    "emailOtpChallenges": "email OTP challenges",
    "emailOtpRate": "email OTP rate counters",
    "appBuildReports": "per-account last-reported app build",
    # ── partners ──
    "agencies": "agencies and sub-agencies (with agencyHosts, commissionLedger)",
    "sellers": "coin sellers (with rechargeHistory, diamondLending)",
    "publicSellers": "public mirror of sellers",
    "hostApplications": "partner / host applications",
    "approvalRequests": "approval queue entries",
    "kycSubmissions": "KYC submissions",
    "hostKyc": "host KYC and bank details",
    "hostVerification": "host verification records",
    # ── money and payouts ──
    "rechargeRequests": "recharges",
    "coinPurchaseRequests": "coin purchase requests",
    "coinPurchases": "legacy coin purchase records",
    "withdrawalRequests": "host withdrawal requests",
    "salaryRequests": "agency salary requests",
    "hostPayouts": "host payouts",
    "weeklyPayoutReports": "weekly payout reports (money history)",
    "platformRevenue": "platform revenue rows (money history)",
    "platformRevenueDaily": "daily revenue roll-ups derived from platformRevenue (money history)",
    "rateLimits": "abuse token buckets keyed by device/IP for unauthenticated callables (activity-derived)",
    "mailLog": "partner-email delivery markers (who was mailed what; activity-derived)",
    "platformStats": "aggregated stats derived from user activity",
    "giftEvents": "gift events (money movements)",
    "giftTransactions": "gift transactions (money movements)",
    "giftPairs": "sender/receiver gift pair records (with gifts)",
    "giftIdempotency": "gift replay guards",
    "walletIdempotency": "wallet replay guards",
    "callIdempotency": "call replay guards",
    # ── activity ──
    "calls": "calls (with messages)",
    "callHistory": "call history",
    "pkInvites": "PK invites between hosts",
    "liveRooms": "live rooms (with comments, gifts, viewers)",
    "partyRooms": "party rooms (with seats, listeners, messages, seatRequests, seatInvites, gifts)",
    "conversations": "chat threads (with messages)",
    "reports": "user reports",
    "appeals": "appeals",
    "notifications": "notifications",
    "broadcasts": "broadcast messages sent to users",
    "adminAlerts": "admin alerts raised by user activity",
    # ── tickets of every kind ──
    "techTickets": "tickets",
    "opsTickets": "tickets",
    "supportTickets": "tickets",
    "feedbackTickets": "tickets",
    "crmSupportTickets": "tickets",
    "feedback": "legacy feedback records",
    # ── legacy top-level copies seen in earlier resets ──
    "weeklyStatements": "legacy top-level weekly statements (money history)",
}

#: Subcollections the walker may meet UNDER A DELETE DOCUMENT, keyed by the
#: immediate parent collection name. A subcollection name not listed for its
#: parent is UNKNOWN and the plan refuses. KEEP parents are never walked.
FIRESTORE_SUBCOLLECTIONS: dict[str, frozenset[str]] = {
    "users": frozenset({
        "giftShowcase", "topFans", "fcmTokens", "blocked", "liked", "likedBy", "ownedItems",
        "followers", "following", "warnings", "diamondTransactions", "dailyStats",
        "weeklyEarnings", "weeklyStatements", "beanTransactions", "giftsSent", "giftsReceived",
        "notifications", "devices", "dailyClaims", "cardDebits",
    }),
    "agencies": frozenset({"agencyHosts", "commissionLedger"}),
    "sellers": frozenset({"rechargeHistory", "diamondLending"}),
    "liveRooms": frozenset({"comments", "gifts", "viewers"}),
    "partyRooms": frozenset({"seats", "listeners", "messages", "seatRequests", "seatInvites", "gifts", "private"}),
    "conversations": frozenset({"messages"}),
    "calls": frozenset({"messages"}),
    "giftPairs": frozenset({"gifts"}),
    "weeklyPayoutReports": frozenset({"hostPayouts"}),
}

# ══════════════════════════════════════════════════════════════════════════════
#  MongoDB
# ══════════════════════════════════════════════════════════════════════════════

MONGO_KEEP: dict[str, str] = {
    "rates": "economy settings: versioned rates",
    "chance_mechanics": "economy config: chance mechanics",
    "chance_configs": "economy config: signed chance tables",
    "ops_canary": "ops: the data canary that proves the database belongs to the project",
    "scheduled_runs": "the scheduler's own run log; names no person, holds no money",
    "alert_state": "alert suppression keys; names no person, holds no money",
}

MONGO_DELETE: dict[str, str] = {
    "staff": "CRM staff rows including the Owners and the Observer (re-seeded)",
    "observer_otp": "Observer one-time codes",
    "sessions": "issued API sessions",
    "owner_mfa": "Owner TOTP secrets / recovery codes (Owners re-enrol)",
    "audit": "audit data",
    "ledger": "money ledger",
    "balances": "money balances",
    "cards": "approval cards",
    "partners": "agencies and sellers",
    "partner_sales": "seller → buyer sales (money history)",
    "recharges": "recharges (money history)",
    "subagency_payouts": "sub-agency payouts (money history)",
    "weekly_business_reports": "weekly business reports (money history)",
    "reconciliation": "ledger reconciliation rows",
    "owner_notices": "Owner money-notification delivery state (names Owners; money history)",
    "department_vacancies": "department Admin vacancy state (names staff; re-derived after re-seed)",
    "notice_outbox": "in-app notices parked after a failed Firestore write (names users; activity-derived)",
    "email_deliveries": "email delivery records (audit data; name recipients)",
    "report_subscriptions": "report subscriptions keyed by staff email",
    "public_appeal_rate": "public appeal form rate counters",
    "chance_rounds": "player rounds (money movements)",
    "chance_exposure": "payout exposure counters derived from rounds",
    "chance_player_flags": "per-player fraud flags",
    "player_protection": "per-player protection state",
    "player_protection_flags": "per-player harm flags",
    "role_appeals": "role appeals",
    "role_appeal_locks": "per-user appeal locks",
    "transfer_requests": "transfer requests (money movements)",
    "transfer_locks": "per-user transfer locks",
    "money_freezes": "money freezes",
    "host_application_locks": "per-user application locks",
    "partner_role_claims": "one-agency-family sentinels per uid",
    "agency_hosts": "agency roster rows",
}

# ══════════════════════════════════════════════════════════════════════════════
#  Cloud Storage — top-level prefixes (the first path segment)
# ══════════════════════════════════════════════════════════════════════════════

#: Exactly the three uploads prefixes the spec approves for deletion.
STORAGE_DELETE: dict[str, str] = {
    "profileMedia": "uploads: profile media of app accounts",
    "kyc": "uploads: KYC of agencies, sub-agencies, hosts and applicants",
    "hostVerification": "uploads: host verification photos",
}

STORAGE_KEEP: dict[str, str] = {
    "appBuilds": "app builds (the APKs appConfig/androidUpdate links to)",
    "contentAssets": "app content assets (contentConfig links to them)",
    "gifts": "gift catalogue assets",
    "bagItems": "catalogue assets",
    "banners": "content assets",
    "app": "content assets",
    "config": "config assets",
    "public": "public assets",
    "apk": "app builds (legacy prefix)",
    "zipper-backups": "the managed Firestore exports and the copies this tooling writes — never deleted",
}

#: Personal or partner files whose deletion the spec did NOT approve. Reported
#: as UNKNOWN so the Owner decides; move each to STORAGE_DELETE or STORAGE_KEEP.
STORAGE_UNDECIDED: dict[str, str] = {
    "appealEvidence": "appeal evidence uploaded by users",
    "sellerDocs": "seller KYC documents (signup/, crm/, {sellerId}/)",
    "sellerQr": "seller payment QR images",
    "sellerPaymentProofs": "seller payment proofs",
    "coinPurchaseProofs": "coin purchase proofs per seller uid",
    "coinPurchases": "coin purchase files per seller",
    "recharges": "recharge files per seller",
    "rechargeProofs": "recharge proofs per buyer",
    "rechargeScreenshots": "recharge screenshots per request",
    "payoutScreenshots": "payout screenshots per report/agency",
    "evidence": "flat evidence files",
    "feedbackAttachments": "feedback attachments per uid",
    "roomThumbs": "room thumbnails",
    "hostPhotos": "host photos per agency",
    "crmProfilePhotos": "CRM profile photos (flat; the Owners' own pictures live here)",
    # Prefixes an earlier planner listed as owned-by-user; none seen in 2026-10.
    "users": "legacy per-user files", "profiles": "legacy per-user files",
    "avatars": "legacy per-user files", "agencies": "legacy per-partner files",
    "sellers": "legacy per-partner files", "chat": "legacy chat media",
    "moments": "legacy media", "stories": "legacy media", "covers": "legacy media",
}

#: Prefixes the backup copies: everything that may be deleted or is undecided.
STORAGE_BACKUP_PREFIXES: tuple[str, ...] = tuple(sorted(set(STORAGE_DELETE) | set(STORAGE_UNDECIDED)))

# ══════════════════════════════════════════════════════════════════════════════
#  Firebase Auth
# ══════════════════════════════════════════════════════════════════════════════

#: Owner decision: EVERY Auth account is in scope, Owners and Observer included.
AUTH_SCOPE = DELETE
AUTH_WHY = "every Firebase Auth account (Owner decision: the Owner and Observer logins are re-seeded)"


# ══════════════════════════════════════════════════════════════════════════════
#  Lookups
# ══════════════════════════════════════════════════════════════════════════════

def classify_firestore(collection: str) -> str:
    if collection in FIRESTORE_DELETE:
        return DELETE
    if collection in FIRESTORE_KEEP:
        return KEEP
    return UNKNOWN


def classify_subcollection(parent_collection: str, sub: str) -> str:
    """A subcollection met under a DELETE document: DELETE if known, else UNKNOWN."""
    return DELETE if sub in FIRESTORE_SUBCOLLECTIONS.get(parent_collection, frozenset()) else UNKNOWN


def classify_mongo(collection: str) -> str:
    if collection.startswith("system."):
        return KEEP
    if collection in MONGO_DELETE:
        return DELETE
    if collection in MONGO_KEEP:
        return KEEP
    return UNKNOWN


def storage_prefix(name: str) -> str:
    return (name or "").split("/", 1)[0]


def classify_storage(name: str) -> str:
    top = storage_prefix(name)
    if top in STORAGE_DELETE:
        # Everything under the prefix, folder placeholders ("kyc/a1/") included.
        # An object named exactly like the prefix ("kyc", no slash) is not
        # under it and is refused rather than guessed at.
        return DELETE if "/" in name else UNKNOWN
    if top in STORAGE_KEEP:
        return KEEP
    return UNKNOWN


def why(store: str, name: str) -> str:
    tables = {
        "firestore": (FIRESTORE_DELETE, FIRESTORE_KEEP),
        "mongo": (MONGO_DELETE, MONGO_KEEP),
        "storage": (STORAGE_DELETE, STORAGE_KEEP, STORAGE_UNDECIDED),
    }
    for t in tables.get(store, ()):
        if name in t:
            return t[name]
    return "not in the table"


def table_fingerprint() -> str:
    """A hash of the table, recorded in every manifest, so a manifest planned
    under one table cannot be executed under another."""
    import hashlib
    import json

    blob = json.dumps({
        "firestore_keep": sorted(FIRESTORE_KEEP), "firestore_delete": sorted(FIRESTORE_DELETE),
        "subcollections": {k: sorted(v) for k, v in sorted(FIRESTORE_SUBCOLLECTIONS.items())},
        "mongo_keep": sorted(MONGO_KEEP), "mongo_delete": sorted(MONGO_DELETE),
        "storage_keep": sorted(STORAGE_KEEP), "storage_delete": sorted(STORAGE_DELETE),
        "storage_undecided": sorted(STORAGE_UNDECIDED), "auth": AUTH_SCOPE,
    }, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def self_check() -> list[str]:
    """Overlaps are bugs: a name may be in exactly one list."""
    problems = []
    for a, b, label in ((FIRESTORE_KEEP, FIRESTORE_DELETE, "firestore"),
                        (MONGO_KEEP, MONGO_DELETE, "mongo"),
                        (STORAGE_KEEP, STORAGE_DELETE, "storage keep/delete"),
                        (STORAGE_KEEP, STORAGE_UNDECIDED, "storage keep/undecided"),
                        (STORAGE_DELETE, STORAGE_UNDECIDED, "storage delete/undecided")):
        both = set(a) & set(b)
        if both:
            problems.append(f"{label}: in two lists: {sorted(both)}")
    return problems


# ── firestore.rules parser (used by the completeness test and by `plan --check-table`) ──

_MATCH_RE = re.compile(r"^\s*match\s+(/\S+)\s*\{")


def rules_top_level_collections(rules_path: str | Path) -> list[str]:
    """Every top-level collection named by a `match /x/{…}` directly under
    `match /databases/{database}/documents`. Wildcard first segments are skipped."""
    depth = 0
    found: list[str] = []
    for raw in Path(rules_path).read_text(encoding="utf-8").splitlines():
        line = raw.split("//", 1)[0]
        m = _MATCH_RE.match(line)
        if m and depth == 2:
            first = m.group(1).strip("/").split("/", 1)[0]
            if first and not first.startswith("{"):
                found.append(first)
        depth += line.count("{") - line.count("}")
    out: list[str] = []
    for name in found:
        if name not in out:
            out.append(name)
    return out


def rules_subcollections(rules_path: str | Path) -> dict[str, set[str]]:
    """parent top-level collection → subcollection names declared directly under it
    (`match /users/{uid} { match /fcmTokens/{id} {…} }` → {"users": {"fcmTokens"}})."""
    depth = 0
    open_matches: list[tuple[int, str]] = []   # (depth the match opened at, first segment)
    out: dict[str, set[str]] = {}
    for raw in Path(rules_path).read_text(encoding="utf-8").splitlines():
        line = raw.split("//", 1)[0]
        m = _MATCH_RE.match(line)
        if m:
            while open_matches and open_matches[-1][0] >= depth:
                open_matches.pop()
            segs = [s for s in m.group(1).strip("/").split("/") if s]
            name = segs[0] if segs else ""
            if depth == 3 and open_matches and open_matches[-1][0] == 2 \
                    and name and not name.startswith("{") and not open_matches[-1][1].startswith("{"):
                out.setdefault(open_matches[-1][1], set()).add(name)
            open_matches.append((depth, name))
        depth += line.count("{") - line.count("}")
    return out


def known_names(store: str) -> Iterable[str]:
    if store == "firestore":
        return sorted(set(FIRESTORE_KEEP) | set(FIRESTORE_DELETE))
    if store == "mongo":
        return sorted(set(MONGO_KEEP) | set(MONGO_DELETE))
    if store == "storage":
        return sorted(set(STORAGE_KEEP) | set(STORAGE_DELETE) | set(STORAGE_UNDECIDED))
    return ()
