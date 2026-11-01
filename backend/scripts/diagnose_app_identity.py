"""Why does this partner see "Setup Profile" / no Agency tag in the app? READ ONLY.

    cd backend && .venv/bin/python -m scripts.diagnose_app_identity EMAIL_OR_UID [--phone +91...]

THIS SCRIPT WRITES NOTHING. No document, claim, account or session is created,
updated or deleted. Every call is a read. Safe on the real Ruhan account and on
the CRM-created agency.

It walks the whole chain the Android app depends on, in order:

  Firebase Auth (by email, by phone, by uid)
    → users/{uid}            what the app reads: isProfileComplete, isAgent/isSeller
    → crmUsers/{uid}         role, roles, roleStatus, agencyId, sellerId, isActive
    → Mongo partners         owner_crm_uid → status per capability
    → Mongo staff            (a partner should have none)
    → custom claims          {role, aid} for Storage
    → Mongo sessions         partners / partner_status on live sessions

and then names every condition that produces the reported symptom:

  SPLIT_UID            the phone and the email are on DIFFERENT Firebase
                       accounts. Phone OTP in the app lands on the uid with no
                       crmUsers document → no tag, and a fresh users doc with
                       isProfileComplete=false → "Setup Profile". The CRM's
                       attach_phone_to_login refused because the number was
                       already taken.
  NO_USERS_DOC         the CRM uid has never opened the app.
  PROFILE_INCOMPLETE   users/{uid}.isProfileComplete is not true. Separate from
                       role approval by design: approval never completes a profile.
  EMAIL_GUARD_DEADLOCK another users doc carries the same email; the old
                       saveUserProfile guard refused to save the profile for ever
                       (fixed in AuthRepository — a new app build is required).
  FLAGS_STALE          users/{uid}.isAgent/isSeller disagree with what crmUsers
                       entitles. Fixed by syncMyRoles on next cold start / sign-in
                       and by the backend push at decision time.
  CLAIM_MISMATCH       the Storage custom claim disagrees with crmUsers.
  NO_CRM_LOGIN         no crmUsers document on any uid found.
  PARTNER_NOT_LINKED   a Mongo partner names this human but not this uid.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from app.db import firebase, mongo
from app.db.mongo import C
from app.services.crm_directory import app_role_flags


def _fs():
    return firebase.firestore_client()


def _auth_record(u) -> dict:
    return {
        "uid": u.uid,
        "email": u.email,
        "phone": u.phone_number,
        "disabled": u.disabled,
        "providers": [p.provider_id for p in (u.provider_data or [])],
        "claims": u.custom_claims or {},
        "created": getattr(u.user_metadata, "creation_timestamp", None),
        "last_sign_in": getattr(u.user_metadata, "last_sign_in_timestamp", None),
    }


def _doc(collection: str, doc_id: str) -> dict | None:
    snap = _fs().collection(collection).document(doc_id).get()
    return (snap.to_dict() or {}) if snap.exists else None


def _where(collection: str, field: str, value: str) -> list[tuple[str, dict]]:
    from google.cloud.firestore_v1.base_query import FieldFilter

    if not value:
        return []
    q = _fs().collection(collection).where(filter=FieldFilter(field, "==", value))
    return [(d.id, d.to_dict() or {}) for d in q.stream()]


def _pick(doc: dict | None, *keys: str) -> dict:
    return {k: (doc or {}).get(k) for k in keys}


async def diagnose(key: str, phone: str | None) -> dict[str, Any]:
    from firebase_admin import auth as fb_auth

    accounts: dict[str, dict] = {}

    def _add(fn, value):
        try:
            u = fn(value)
            accounts.setdefault(u.uid, _auth_record(u))
            return u
        except Exception:  # noqa: BLE001 — no account is an answer, not an error
            return None

    if "@" in key:
        _add(fb_auth.get_user_by_email, key.strip().lower())
        email = key.strip().lower()
    else:
        u = _add(fb_auth.get_user, key.strip())
        email = (u.email or "").lower() if u else ""
    phones = {phone} if phone else set()
    for a in list(accounts.values()):
        if a["phone"]:
            phones.add(a["phone"])

    # Every uid crmUsers / users associate with this email or phone.
    for coll in ("crmUsers", "users"):
        for field in ("email",):
            for uid, _ in _where(coll, field, email):
                _add(fb_auth.get_user, uid)
        for p in list(phones):
            for uid, _ in _where(coll, "phone", p):
                _add(fb_auth.get_user, uid)
    for p in list(phones):
        _add(fb_auth.get_user_by_phone_number, p)
    for a in list(accounts.values()):
        if a["phone"]:
            phones.add(a["phone"])

    db = mongo.get_db()
    out: dict[str, Any] = {"query": key, "email": email, "phones": sorted(phones), "uids": {}}
    findings: list[str] = []

    crm_uids = []
    for uid, auth in accounts.items():
        users = _doc("users", uid)
        crm = _doc("crmUsers", uid)
        partners = [p async for p in db[C.PARTNERS].find({"owner_crm_uid": uid})]
        staff = await db[C.STAFF].find_one({"uid": uid})
        sessions = [s async for s in db[C.SESSIONS].find({"uid": uid, "revoked": False})]
        entitled = app_role_flags(crm) if crm else {"isAgent": False, "isSeller": False}
        row = {
            "auth": auth,
            "users": _pick(users, "isProfileComplete", "isAgent", "isSeller", "crmRole",
                           "isOfficial", "agencyId", "email", "phone", "name", "isGuest")
                     if users is not None else None,
            "crmUsers": _pick(crm, "role", "roles", "roleStatus", "status", "isActive",
                              "agencyId", "sellerId", "ownerUid", "crmUid", "email", "phone")
                        if crm is not None else None,
            "entitled_app_flags": entitled,
            "mongo_partners": [
                {"id": p["_id"], "kind": p.get("kind"), "status": p.get("status"),
                 "is_active": p.get("is_active"), "parent_id": p.get("parent_id")}
                for p in partners
            ],
            "mongo_staff": _pick(staff, "role", "email", "status") if staff else None,
            "live_sessions": [
                {"role": s.get("role"), "partners": s.get("partners"),
                 "partner_status": s.get("partner_status"), "issued_at": str(s.get("issued_at"))}
                for s in sessions
            ],
        }
        out["uids"][uid] = row
        if crm is not None:
            crm_uids.append(uid)
            if users is None:
                findings.append(f"NO_USERS_DOC {uid}: CRM login has never opened the app")
            else:
                if users.get("isProfileComplete") is not True:
                    findings.append(f"PROFILE_INCOMPLETE {uid}: users.isProfileComplete="
                                    f"{users.get('isProfileComplete')!r}")
                if (bool(users.get("isAgent")), bool(users.get("isSeller"))) != (
                        entitled["isAgent"], entitled["isSeller"]):
                    findings.append(f"FLAGS_STALE {uid}: users isAgent/isSeller="
                                    f"{users.get('isAgent')}/{users.get('isSeller')} "
                                    f"but crmUsers entitles {entitled['isAgent']}/{entitled['isSeller']}")
            claim_role = (auth["claims"] or {}).get("role")
            want = "agency" if entitled["isAgent"] else ("seller" if entitled["isSeller"] else None)
            if claim_role != want:
                findings.append(f"CLAIM_MISMATCH {uid}: claim role={claim_role!r}, expected {want!r}")
        if users is not None and crm is None and accounts and len(accounts) > 1:
            findings.append(f"SPLIT_UID {uid}: app account (phone={auth['phone']}, "
                            f"email={auth['email']}) has NO crmUsers — the CRM login is a different uid")
        # Email guard: another users doc with the same email.
        u_email = (users or {}).get("email") or auth["email"]
        if u_email:
            others = [d for d, _ in _where("users", "email", str(u_email).lower()) if d != uid]
            if others and (users or {}).get("isProfileComplete") is not True:
                findings.append(f"EMAIL_GUARD_DEADLOCK {uid}: users/{others} already carry "
                                f"{u_email} (old app build refuses to save the profile)")

    if not crm_uids:
        findings.append("NO_CRM_LOGIN: no crmUsers document on any uid for this email/phone")

    # Partners that name this human by email but a different uid.
    for coll, field in (("agencies", "ownerEmail"), ("sellers", "email")):
        for pid, d in _where(coll, field, email):
            linked = d.get("crmUid") or d.get("ownerUid")
            if linked and linked not in accounts:
                findings.append(f"PARTNER_NOT_LINKED {coll}/{pid}: crmUid/ownerUid={linked} "
                                "is not any account found for this email/phone")

    out["findings"] = findings or ["OK: no identity defect found"]
    return out


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("key", help="email address or Firebase uid")
    ap.add_argument("--phone", help="E.164 phone the person signs in to the app with")
    args = ap.parse_args()
    firebase.init()
    await mongo.connect()
    try:
        result = await diagnose(args.key, args.phone)
    finally:
        await mongo.disconnect()
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
