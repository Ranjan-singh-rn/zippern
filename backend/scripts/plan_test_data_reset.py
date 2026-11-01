"""DRY-RUN plan for the production test-data reset. READ ONLY — CANNOT DELETE.

    cd backend && .venv/bin/python -m scripts.plan_test_data_reset \
        --owner-uid UID1 --owner-uid UID2 --owner-uid UID3 \
        [--out reset-plan.json]

THIS SCRIPT CONTAINS NO DELETE, UPDATE OR WRITE CALL. It imports no delete
helper. It reads Firebase Auth, Firestore, Storage and Mongo, and writes ONE
local JSON file describing what a reset WOULD do. Executing that plan is a
separate, not-yet-written step that needs explicit approval.

Why not `scripts/reset_test_data.py`: that tool empties the Mongo `audit` and
`ledger` collections wholesale and takes its owner list from a seed file with
no count check. Both contradict the reset policy. Do not run it for this reset.

── THE ALLOWLIST (fail closed) ─────────────────────────────────────────────

Exactly what survives as a PERSON, and nothing derived from a role filter:

  * the three Owners — resolved from Mongo `staff` (role=owner). The run
    REFUSES unless there are exactly three, each with a uid that is a live
    Firebase Auth account, AND the three uids equal the `--owner-uid` values the
    operator typed. "Everyone except role=owner" is never computed.
  * each Owner's linked app identities — any OTHER Auth account carrying the
    Owner's staff email or staff phone (an owner's phone-OTP account). Listed
    separately so a split owner is visible, and preserved.
  * the Observer — exactly one Mongo `staff` row with role=observer, whose email
    is `settings.observer_email`. It has NO Firebase Auth account by design; if
    one is found the run refuses (the identity model would be different from the
    one this plan assumes).

── CLASSIFICATION ──────────────────────────────────────────────────────────

  PRESERVE           allowlisted identities and everything they own; all
                     configuration; rules/indexes (not data — never touched).
  RESET              kept, but test residue on it cleared (e.g. an Owner's
                     users doc carrying partner flags from testing).
  DELETE             test identities and their operational records.
  RETAIN_FOR_AUDIT   financial and audit history: ledger, audit, recharges,
                     sales, payouts, reconciliation, balances of removed holders.
                     Kept until a retention decision says otherwise.
  UNCLASSIFIED       a collection or Storage prefix this plan does not know.
                     Any UNCLASSIFIED entry is a BLOCKER: the plan is not
                     executable until somebody decides what it is.

The plan ends with a self-check: no allowlisted uid appears in any DELETE row.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

# ── Static policy ────────────────────────────────────────────────────────────

FS_CONFIG = frozenset({
    "bagItems", "appConfig", "gifts", "diamondPacks", "rechargePackages", "paymentConfig",
    "contentConfig", "policies", "levelConfig", "roleDefinitions", "departments",
    "officialConfig", "systemConfig", "financeConfig",
})
#: Documents ARE accounts, keyed by uid.
FS_IDENTITY_BY_UID = frozenset({"users", "publicProfiles", "crmUsers",
                                "contactVerifications"})  # RC D15: the server's ledger of verified contacts
#: Partner replicas; owner resolved from ownerUid / crmUid / secondRoleOwnerUid.
FS_PARTNER = frozenset({"agencies", "sellers"})
#: Derived public mirrors of a partner collection, keyed by the SAME id and
#: written only by a trigger (`syncPublicSeller`). A mirror survives exactly
#: when its source partner survives; an orphan mirror is deleted. Mirrors are
#: classified after every other collection (see `firestore_order`).
FS_PARTNER_MIRROR = {"publicSellers": "sellers"}
#: Money and payout history in Firestore.
FS_FINANCIAL = frozenset({
    "rechargeRequests", "coinPurchaseRequests", "withdrawalRequests", "salaryRequests",
    "giftTransactions", "platformRevenue", "hostPayouts", "weeklyPayoutReports",
    "weeklyStatements", "giftEvents",
})
#: Per-user operational records; owner resolved from a uid field.
FS_PER_USER = {
    "hostApplications": ("uid", "userId", "applicantUid"),
    "hostVerification": ("uid", "userId"),
    "verifiedIdentities": ("uid",),
    "notifications": ("userId", "uid"),
    "approvalRequests": ("uid", "requestedBy", "userId"),
    "supportTickets": ("uid", "userId"),
    "techTickets": ("uid", "userId"),
    "appeals": ("uid", "userId"),
    "reports": ("reporterId", "uid"),
    "feedback": ("uid", "userId"),
    "feedbackTickets": ("userId", "uid"),
    "pkInvites": ("hostAUid", "fromUid", "uid"),
    "callHistory": ("uid", "callerId"),
    "calls": ("callerId", "uid"),
    "liveRooms": ("hostId", "uid"),
    "partyRooms": ("hostId", "ownerId", "uid"),
    "bannedDevices": ("uid",),
    "identityReleases": ("uid",),
    "giftPairs": ("senderId", "uid"),
    # RC (2026-10-20): refused sign-in identity changes (`identity.ts`), and the
    # app build each account last reported (D18; keyed by uid, no uid field —
    # the owner is the document id).
    "identityChangeRefusals": ("uid",),
    "appBuildReports": (),
}
#: Pure test residue, safe to clear wholesale (allowlisted ids still spared).
FS_EPHEMERAL = frozenset({
    # quickLoginChallenges: single-use sign-in nonces, minutes-long, keyed by
    # a random id — never anybody's data.
    # quickLoginRate: per-credential failure counters with a cool-off; swept by
    # `sweepQuickLoginTokens` anyway.
    "quickLoginTokens", "quickLoginChallenges", "quickLoginRate", "guestDeviceBindings",
    "guestUidBindings",
    "callIdempotency", "giftIdempotency",
    "walletIdempotency", "adminAlerts", "broadcasts",
    # RC: the app's 6-digit email codes and their rate counters (`emailOtp.ts`).
    "emailOtpChallenges", "emailOtpRate",
})

#: Activity history: sign-in events and chat threads. Kept as history by
#: default; deleted under `--fresh`.
FS_ACTIVITY = frozenset({"authEvents", "conversations"})

MONGO_RETAIN = frozenset({
    "audit", "ledger", "recharges", "partner_sales", "subagency_payouts", "reconciliation",
    "weekly_business_reports", "cards", "email_deliveries",
    # Decision history added after 2026-10-09: transfers (C3), role appeals,
    # money freezes. Kept like the rest of the history; deleted under --fresh.
    "transfer_requests", "role_appeals", "money_freezes",
})
MONGO_CONFIG = frozenset({
    "rates", "chance_mechanics", "chance_configs", "report_subscriptions", "scheduled_runs",
    "alert_state",
    # P0-10: the DATA CANARY (`ops_canary/target`) that every destructive run
    # must find — it proves the database belongs to the project. Deleting it
    # would make the NEXT reset refuse; it is configuration, never data.
    "ops_canary",
})
#: One-per-subject locks; the subject is the `uid` field, or the `_id` itself
#: (`host_application_locks/{uid}`), or the part after "kind:" (`transfer_locks`).
MONGO_LOCKS = frozenset({"host_application_locks", "role_appeal_locks", "transfer_locks"})
#: Rate counters keyed by hashed IPs / addresses — nobody's data.
MONGO_DISPOSABLE = frozenset({"public_appeal_rate"})
MONGO_EPHEMERAL = frozenset({"sessions", "observer_otp"})

STORAGE_OWNED_PREFIXES = (
    "users", "profiles", "avatars", "kyc", "rechargeProofs", "hostVerification",
    "agencies", "sellers", "chat", "moments", "stories", "covers",
    "profileMedia", "appealEvidence", "coinPurchases",
    # `coinPurchaseProofs/{sellerUid}/…` (uid-keyed) and
    # `sellerDocs/{sellerId|signup|crm}/…` (seller KYC, partner-keyed).
    "coinPurchaseProofs", "sellerDocs",
    # Every other storage.rules prefix that holds a person's or partner's file.
    # Flat ones (`sellerPaymentProofs/{file}`, `evidence/{kind}/{file}`) have no
    # owner segment, so they are always test residue under a reset.
    "payoutScreenshots", "sellerPaymentProofs", "sellerQr", "rechargeScreenshots",
    "recharges", "evidence", "feedbackAttachments", "roomThumbs", "hostPhotos",
)
#: `appBuilds/` holds the APKs `appConfig/androidUpdate` links to — deleting it
#: breaks the in-app updater. `contentAssets/` holds what contentConfig links to.
STORAGE_CONFIG_PREFIXES = ("gifts", "bagItems", "banners", "app", "config", "public", "apk",
                           "appBuilds", "contentAssets",
                           # Flat `crmProfilePhotos/{file}` — no owner in the path, and
                           # the Owners' own CRM pictures live here. Kept, not guessed at.
                           "crmProfilePhotos",
                           # The managed Firestore exports (`gcloud firestore export` into the
                           # default bucket, written by the deploy tooling's Step 1). They are the
                           # restore source of the very reset being planned: never deleted, and
                           # never a blocker that would stop the reset they protect.
                           "zipper-backups")

#: The economy counters an Owner's users doc is reset to 0 under `--fresh`
#: (the ledger they summarise is being deleted). Plus the partner flags.
OWNER_RESET_ZERO = ("diamonds", "beans", "beansAvailable", "totalGemsSpent", "totalGiftsReceived",
                    "totalGiftsSent", "hostCallEarnings", "hostGiftEarnings", "level", "wealthLevel")


class AllowlistError(RuntimeError):
    """The Owner/Observer set could not be resolved unambiguously. Fail closed."""


@dataclass
class Allowlist:
    owner_uids: list[str]
    owner_linked_uids: dict[str, str] = field(default_factory=dict)  # linked uid → owner uid
    observer: dict = field(default_factory=dict)

    @property
    def uids(self) -> set[str]:
        return set(self.owner_uids) | set(self.owner_linked_uids)

    def fingerprint(self) -> str:
        blob = json.dumps({"owners": sorted(self.owner_uids),
                           "linked": sorted(self.owner_linked_uids),
                           "observer": self.observer.get("uid")}, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()


# ── Pure: allowlist resolution ───────────────────────────────────────────────

def resolve_allowlist(
    staff_rows: list[dict],
    explicit_owner_uids: list[str],
    observer_email: str,
    auth_get: Callable[[str], Any | None],
    auth_by_email: Callable[[str], Any | None],
    auth_by_phone: Callable[[str], Any | None],
) -> Allowlist:
    """Every check fails closed. `auth_*` return an object with `.uid` or None."""
    owners = [r for r in staff_rows if str(r.get("role", "")).strip() == "owner"]
    if len(owners) != 3:
        raise AllowlistError(f"expected exactly 3 Owner staff rows, found {len(owners)}")
    owner_uids = [str(r.get("uid") or "").strip() for r in owners]
    if any(not u for u in owner_uids) or len(set(owner_uids)) != 3:
        raise AllowlistError(f"Owner staff rows do not carry 3 distinct uids: {owner_uids}")
    explicit = sorted({u.strip() for u in explicit_owner_uids if u.strip()})
    if explicit != sorted(owner_uids):
        raise AllowlistError(
            f"--owner-uid values {explicit} do not equal the Owner uids in Mongo staff "
            f"{sorted(owner_uids)}")
    for uid in owner_uids:
        if auth_get(uid) is None:
            raise AllowlistError(f"Owner uid {uid} has no Firebase Auth account")

    linked: dict[str, str] = {}
    for row in owners:
        ouid = str(row["uid"]).strip()
        email = str(row.get("email") or "").strip().lower()
        phone = str(row.get("phone") or "").strip()
        if phone and not phone.startswith("+"):
            phone = f"+91{phone}"
        for found in (auth_by_email(email) if email else None,
                      auth_by_phone(phone) if phone else None):
            if found is not None and found.uid != ouid:
                if found.uid in owner_uids:
                    raise AllowlistError(f"Owner identities overlap: {found.uid}")
                linked[found.uid] = ouid

    observers = [r for r in staff_rows if str(r.get("role", "")).strip() == "observer"]
    if len(observers) != 1:
        raise AllowlistError(f"expected exactly 1 Observer staff row, found {len(observers)}")
    obs = observers[0]
    if str(obs.get("email") or "").strip().lower() != observer_email.strip().lower():
        raise AllowlistError("Observer staff email does not match settings.observer_email")
    obs_uid = str(obs.get("uid") or "").strip()
    if obs_uid and auth_get(obs_uid) is not None:
        raise AllowlistError("Observer unexpectedly has a Firebase Auth account; refusing")
    if auth_by_email(observer_email) is not None:
        raise AllowlistError("a Firebase Auth account carries the Observer email; refusing")
    return Allowlist(owner_uids=sorted(owner_uids), owner_linked_uids=linked,
                     observer={"uid": obs_uid, "email": obs.get("email"),
                               "_id": str(obs.get("_id"))})


# ── Pure: classification ─────────────────────────────────────────────────────

def _first(doc: dict, keys: Iterable[str]) -> str:
    for k in keys:
        v = doc.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def firestore_order(collections: Iterable[Any]) -> list[Any]:
    """Collections in classification order: partner mirrors LAST, so the
    partners they mirror have already been decided. Used by planner and executor."""
    return sorted(collections, key=lambda c: (c.id in FS_PARTNER_MIRROR, c.id))


def classify_firestore(name: str, docs: list[tuple[str, dict]], allow: Allowlist,
                       removed_partner_ids: set[str],
                       kept_partner_ids: set[str] | None = None) -> list[dict]:
    keep = allow.uids
    kept = kept_partner_ids if kept_partner_ids is not None else set()
    rows: list[dict] = []
    if name in FS_PARTNER_MIRROR:
        for doc_id, _d in docs:
            if doc_id in kept:
                rows.append({"collection": name, "id": doc_id, "action": "PRESERVE", "owner": "",
                             "why": f"public mirror of a kept {FS_PARTNER_MIRROR[name]} record"})
            else:
                rows.append({"collection": name, "id": doc_id, "action": "DELETE", "owner": "",
                             "why": f"public mirror of a removed or missing {FS_PARTNER_MIRROR[name]} record"})
        for r in rows:
            r["store"] = "firestore"
        return rows
    if name in FS_CONFIG:
        return [{"store": "firestore", "collection": name, "id": "*", "action": "PRESERVE",
                 "count": len(docs), "why": "configuration"}]
    if name in FS_FINANCIAL or name in FS_ACTIVITY:
        return [{"store": "firestore", "collection": name, "id": "*", "action": "RETAIN_FOR_AUDIT",
                 "count": len(docs), "why": "financial history"}]
    for doc_id, d in docs:
        if name in FS_IDENTITY_BY_UID:
            if doc_id in keep:
                residue = name == "users" and (d.get("isAgent") or d.get("isSeller"))
                action = "RESET" if residue else "PRESERVE"
                why = "allowlisted identity" + ("; clear isAgent/isSeller test flags" if residue else "")
            else:
                action, why = "DELETE", "test identity"
            rows.append({"collection": name, "id": doc_id, "action": action, "owner": doc_id, "why": why})
        elif name in FS_PARTNER:
            owner = _first(d, ("ownerUid", "crmUid", "secondRoleOwnerUid"))
            if owner and owner in keep:
                kept.add(doc_id)
                rows.append({"collection": name, "id": doc_id, "action": "PRESERVE", "owner": owner,
                             "why": "partner owned by an allowlisted identity"})
            else:
                removed_partner_ids.add(doc_id)
                rows.append({"collection": name, "id": doc_id, "action": "DELETE", "owner": owner,
                             "why": "test partner"})
        elif name in FS_PER_USER:
            owner = _first(d, FS_PER_USER[name]) or (doc_id if doc_id in keep else "")
            action = "PRESERVE" if owner in keep else "DELETE"
            rows.append({"collection": name, "id": doc_id, "action": action, "owner": owner,
                         "why": "owned by allowlisted identity" if action == "PRESERVE" else "test record"})
        elif name in FS_EPHEMERAL:
            action = "PRESERVE" if doc_id in keep else "DELETE"
            rows.append({"collection": name, "id": doc_id, "action": action, "owner": "",
                         "why": "ephemeral test residue"})
        else:
            return [{"store": "firestore", "collection": name, "id": "*", "action": "UNCLASSIFIED",
                     "count": len(docs), "why": "unknown collection — needs a decision"}]
    for r in rows:
        r["store"] = "firestore"
    return rows


def classify_mongo(name: str, docs: list[dict], allow: Allowlist,
                   removed_partner_ids: set[str]) -> list[dict]:
    keep = allow.uids
    if name in MONGO_RETAIN:
        return [{"store": "mongo", "collection": name, "id": "*", "action": "RETAIN_FOR_AUDIT",
                 "count": len(docs), "why": "audit / financial history"}]
    if name in MONGO_CONFIG:
        return [{"store": "mongo", "collection": name, "id": "*", "action": "PRESERVE",
                 "count": len(docs), "why": "configuration"}]
    if name in MONGO_DISPOSABLE:
        return [{"store": "mongo", "collection": name, "id": "*", "action": "DELETE",
                 "count": len(docs), "why": "rate counters — nobody's data"}]
    rows = []
    for d in docs:
        _id = str(d.get("_id"))
        if name == "staff":
            uid = str(d.get("uid") or "")
            role = str(d.get("role") or "")
            if uid in allow.owner_uids or _id == allow.observer.get("_id"):
                action, why = "PRESERVE", f"allowlisted {role}"
            else:
                action, why = "DELETE", f"non-allowlisted staff ({role}) — confirm each"
            rows.append({"collection": name, "id": _id, "action": action, "owner": uid, "why": why})
        elif name == "partners":
            owner = str(d.get("owner_crm_uid") or "")
            if owner in keep:
                rows.append({"collection": name, "id": _id, "action": "PRESERVE", "owner": owner,
                             "why": "partner owned by allowlisted identity"})
            else:
                removed_partner_ids.add(_id)
                rows.append({"collection": name, "id": _id, "action": "DELETE", "owner": owner,
                             "why": "test partner (history copies remain in audit/ledger)"})
        elif name == "partner_role_claims":
            owner = _id.split(":", 1)[1] if ":" in _id else str(d.get("uid") or "")
            action = "PRESERVE" if owner in keep else "DELETE"
            rows.append({"collection": name, "id": _id, "action": action, "owner": owner,
                         "why": "one-agency-family sentinel"})
        elif name in MONGO_EPHEMERAL:
            owner = str(d.get("uid") or "")
            action = "PRESERVE" if owner in keep or owner == allow.observer.get("uid") else "DELETE"
            rows.append({"collection": name, "id": _id, "action": action, "owner": owner,
                         "why": "session/otp"})
        elif name == "balances":
            holder = str(d.get("holder_id") or "")
            if holder in keep:
                action = "PRESERVE"
            else:
                action = "RETAIN_FOR_AUDIT"
            rows.append({"collection": name, "id": _id, "action": action, "owner": holder,
                         "why": "balance must reconcile with the retained ledger"})
        elif name in MONGO_LOCKS:
            owner = str(d.get("uid") or (_id.split(":", 1)[1] if ":" in _id else _id))
            action = "PRESERVE" if owner in keep else "DELETE"
            rows.append({"collection": name, "id": _id, "action": action, "owner": owner,
                         "why": "one-per-subject lock"})
        elif name in ("player_protection", "player_protection_flags", "chance_player_flags",
                      "chance_exposure", "chance_rounds"):
            owner = str(d.get("uid") or d.get("player_uid") or _id)
            action = "PRESERVE" if owner in keep else "DELETE"
            rows.append({"collection": name, "id": _id, "action": action, "owner": owner,
                         "why": "per-player test state"})
        else:
            return [{"store": "mongo", "collection": name, "id": "*", "action": "UNCLASSIFIED",
                     "count": len(docs), "why": "unknown collection — needs a decision"}]
    for r in rows:
        r["store"] = "mongo"
    return rows


def classify_auth(users: list[dict], allow: Allowlist) -> list[dict]:
    out = []
    for u in users:
        if u["uid"] in allow.owner_uids:
            action, why = "PRESERVE", "Owner"
        elif u["uid"] in allow.owner_linked_uids:
            action, why = "PRESERVE", f"linked identity of Owner {allow.owner_linked_uids[u['uid']]}"
        else:
            action, why = "DELETE", "test account"
        out.append({"store": "auth", "collection": "auth", "id": u["uid"], "action": action,
                    "owner": u["uid"], "why": why, "email": u.get("email"), "phone": u.get("phone")})
    return out


def storage_action(path: str, allow: Allowlist, kept_partner_ids: Iterable[str] = ()) -> str:
    """One Storage object's action. Pure; used by the planner AND the executor.

    An owned object survives when any path segment is an allowlisted uid or
    the id of a partner that survives (`sellerDocs/{sellerId}/…`)."""
    parts = path.split("/")
    top = parts[0]
    if top in STORAGE_CONFIG_PREFIXES:
        return "PRESERVE"
    if top in STORAGE_OWNED_PREFIXES:
        spared = allow.uids | set(kept_partner_ids)
        if any(seg in spared for seg in parts[1:]):
            return "PRESERVE"
        return "DELETE" if len(parts) > 1 else "UNCLASSIFIED"
    return "UNCLASSIFIED"


def classify_storage(paths: list[str], allow: Allowlist, removed_partner_ids: set[str],
                     kept_partner_ids: Iterable[str] = ()) -> list[dict]:
    kept = set(kept_partner_ids)
    buckets: dict[tuple[str, str], int] = Counter()
    for p in paths:
        buckets[(p.split("/")[0], storage_action(p, allow, kept))] += 1
    return [{"store": "storage", "collection": top + "/", "id": "*", "action": a, "count": n,
             "why": "by path owner segment"} for (top, a), n in sorted(buckets.items())]


def apply_fresh_policy(rows: list[dict], allow: Allowlist) -> list[dict]:
    """`--fresh`: nothing survives except the identities themselves. Pure.

      * RETAIN_FOR_AUDIT → DELETE (ledger, audit, money and activity history,
        including the Owners' own).
      * Owner-owned OPERATIONAL records (partners, applications, notifications,
        role sentinels, tokens…) → DELETE.
      * Owner identity docs: users → RESET (partner flags off, economy to 0);
        crmUsers → RESET (partner residue removed); publicProfiles PRESERVE.
      * Untouched: Auth accounts and Mongo staff of the allowlist, their live
        sessions, configuration, Owner Storage objects, UNCLASSIFIED (still a
        blocker).
    """
    out = []
    for r in rows:
        r = dict(r)
        coll, store = r["collection"], r["store"]
        if r["action"] == "RETAIN_FOR_AUDIT":
            r["action"], r["why"] = "DELETE", "fresh start: " + r.get("why", "")
        elif r["action"] in ("PRESERVE", "RESET") and r.get("id") != "*":
            if not is_identity_row(r):
                r["action"], r["why"] = "DELETE", "fresh start: owner-owned operational record"
            elif store == "firestore" and coll in ("users", "crmUsers"):
                r["action"], r["why"] = "RESET", "fresh start: clear partner flags / economy"
        out.append(r)
    return out


def is_identity_row(r: dict) -> bool:
    """A row that IS a person's account (not something they own)."""
    return (r["store"] == "auth"
            or (r["store"] == "firestore" and r["collection"] in FS_IDENTITY_BY_UID)
            or (r["store"] == "mongo" and r["collection"] in ("staff",) + tuple(MONGO_EPHEMERAL)))


def self_check(rows: list[dict], allow: Allowlist, fresh: bool = False) -> list[str]:
    """Every violation is a refusal. Empty list = the plan is safe as written.

    Always: no allowlisted ACCOUNT (Auth, users/publicProfiles/crmUsers, Mongo
    staff, their sessions) is in a DELETE row. Without `--fresh`, also nothing
    they OWN. Under `--fresh` owned operational records are deleted by design.
    """
    keep = allow.uids | ({allow.observer.get("uid")} - {""})
    obs_id = allow.observer.get("_id")
    bad = []
    for r in rows:
        if r["action"] != "DELETE":
            continue
        hits = r.get("id") in keep or r.get("owner") in keep or (
            r["store"] == "mongo" and r["collection"] == "staff" and r.get("id") == obs_id)
        if hits and (is_identity_row(r) or not fresh):
            bad.append(f"{r['store']}/{r['collection']}/{r['id']} would DELETE an allowlisted identity")
    staff_kept = {r["owner"] for r in rows if r["store"] == "mongo" and r["collection"] == "staff"
                  and r["action"] == "PRESERVE"}
    if not set(allow.owner_uids) <= staff_kept and any(
            r["store"] == "mongo" and r["collection"] == "staff" for r in rows):
        bad.append("not every Owner staff row is PRESERVE")
    auth_kept = {r["id"] for r in rows if r["store"] == "auth" and r["action"] == "PRESERVE"}
    if any(r["store"] == "auth" for r in rows) and not set(allow.owner_uids) <= auth_kept:
        bad.append("not every Owner Auth account is PRESERVE")
    return bad


# ── I/O ──────────────────────────────────────────────────────────────────────

async def gather_and_plan(owner_uids: list[str], fresh: bool = False) -> dict:
    from firebase_admin import auth as fb_auth

    from app.config import settings
    from app.db import firebase, mongo

    def _safe(fn):
        def inner(v):
            try:
                return fn(v)
            except Exception:  # noqa: BLE001
                return None
        return inner

    firebase.init()
    # No `ensure_indexes()`: this planner READS. Index builds are DDL, and they
    # belong to the deployed backend's startup — not to a reset tool, which
    # would otherwise build the repository's indexes on production early.
    await mongo.connect(ensure=False)
    db = mongo.get_db()
    try:
        staff = [r async for r in db["staff"].find({})]
        allow = resolve_allowlist(staff, owner_uids, settings.observer_email,
                                  _safe(fb_auth.get_user), _safe(fb_auth.get_user_by_email),
                                  _safe(fb_auth.get_user_by_phone_number))

        rows: list[dict] = []
        removed_partners: set[str] = set()
        auth_users = [{"uid": u.uid, "email": u.email, "phone": u.phone_number}
                      for u in fb_auth.list_users().iterate_all()]
        rows += classify_auth(auth_users, allow)

        kept_partners: set[str] = set()
        client = firebase.firestore_client()
        for coll in firestore_order(client.collections()):
            docs = [(d.id, d.to_dict() or {}) for d in coll.stream()]
            rows += classify_firestore(coll.id, docs, allow, removed_partners, kept_partners)

        for name in sorted(await db.list_collection_names()):
            docs = [d async for d in db[name].find({})]
            rows += classify_mongo(name, docs, allow, removed_partners)

        try:
            paths = [b.name for b in firebase.storage_bucket().list_blobs()]
        except Exception as exc:  # noqa: BLE001
            paths = []
            rows.append({"store": "storage", "collection": "*", "id": "*", "action": "UNCLASSIFIED",
                         "count": 0, "why": f"storage not listable: {exc}"})
        # Under --fresh every partner is removed, so no partner id spares a file
        # (the executor's storage_action is called without kept ids, to match).
        rows += classify_storage(paths, allow, removed_partners, () if fresh else kept_partners)
    finally:
        await mongo.disconnect()

    if fresh:
        rows = apply_fresh_policy(rows, allow)
    violations = self_check(rows, allow, fresh=fresh)
    totals: dict[str, dict[str, int]] = defaultdict(Counter)
    for r in rows:
        totals[r["action"]][f"{r['store']}/{r['collection']}"] += r.get("count", 1)
    return {
        "mode": "DRY_RUN — nothing was written",
        "policy": "fresh" if fresh else "retain-history",
        "allowlist": {"owners": allow.owner_uids, "owner_linked_uids": allow.owner_linked_uids,
                      "observer": allow.observer, "fingerprint": allow.fingerprint()},
        "totals": {k: dict(v) for k, v in totals.items()},
        "blockers": violations + [f"UNCLASSIFIED {r['store']}/{r['collection']}"
                                  for r in rows if r["action"] == "UNCLASSIFIED"],
        "rows": rows,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--owner-uid", action="append", default=[], required=True,
                    help="an Owner uid, exactly three times")
    ap.add_argument("--out", default="reset-plan.json")
    ap.add_argument("--fresh", action="store_true",
                    help="delete ALL history too (ledger, audit, money, activity), incl. the Owners'")
    args = ap.parse_args()
    try:
        plan = asyncio.run(gather_and_plan(args.owner_uid, fresh=args.fresh))
    except AllowlistError as exc:
        print(f"REFUSED (fail closed): {exc}")
        return 2
    with open(args.out, "w") as fh:
        json.dump(plan, fh, indent=2, default=str)
    print(plan["mode"])
    print("allowlist:", json.dumps(plan["allowlist"], indent=2))
    for action, per in sorted(plan["totals"].items()):
        print(f"\n{action}: {sum(per.values())}")
        for k, n in sorted(per.items()):
            print(f"    {k:<44} {n:>7}")
    print("\nBLOCKERS:" if plan["blockers"] else "\nNo blockers.")
    for b in plan["blockers"]:
        print("   ", b)
    print(f"\nFull plan written to {args.out}. Nothing was deleted.")
    return 1 if plan["blockers"] else 0


if __name__ == "__main__":
    sys.exit(main())
