"""Report exactly who exists, under which uid, with which providers. READ ONLY.

    cd backend && python -m scripts.inspect_identity

THIS SCRIPT WRITES NOTHING. It opens no transaction, creates no user, deletes
no document and repairs nothing. Every Firebase and Mongo call below is a read.
That is the point: before anything is linked or migrated, the mapping has to be
understood, and a script that also "fixes while it looks" destroys the evidence
of what the state actually was.

── WHAT IT ANSWERS ──────────────────────────────────────────────────────────

For each governance account, and then for the database as a whole:

  * the Firebase Auth uid, and every provider attached to it
  * whether the email is VERIFIED — which decides whether a Google sign-in
    LINKS to this account or SILENTLY REMOVES ITS PASSWORD (see below)
  * the Mongo `staff` row and the Firestore `crmUsers/{uid}` document
  * the app-side `users/{uid}` document
  * every OTHER account that holds the same email or the same phone number,
    because those are the duplicates a migration has to resolve first

── THE ONE FINDING THAT MATTERS MOST ────────────────────────────────────────

Firebase's "one account per email address" has an exception people get bitten
by. Signing in with Google against an existing password account whose email is
**not verified** does not fail — Firebase treats the password account as
possibly planted by an attacker, and UNLINKS THE PASSWORD. The owner's CRM
login stops working and nothing says why.

If the email IS verified, the same attempt raises
`auth/account-exists-with-different-credential`, the password survives, and the
pending credential can be linked after the password is proved. That is the safe
path.

So `emailVerified` is not a detail here. It is the difference between a
migration and an outage, and this script prints it in capitals for that reason.
"""

from __future__ import annotations

import asyncio
import sys
from collections import Counter
from datetime import datetime, timezone

from firebase_admin import auth as fb_auth

from app.config import settings
from app.db import firebase, mongo
from app.db.mongo import C

# The people this is really about. Phone numbers are the ones the owners gave;
# they are used ONLY to ask "who holds this number today", never to write.
OWNERS = [
    {"email": "soumyaranjan.singh7@gmail.com", "name": "Soumya Ranjan Singh", "phone": "+918908641811"},
    {"email": "tanishque50@gmail.com",         "name": "Tanishque",           "phone": "+918755785838"},
    {"email": "baapaadmi0101@gmail.com",       "name": "Alex",                "phone": "+917359766004"},
]


def _phone_key(raw: str) -> str:
    """Last ten digits — mirrors `phoneKey` in functions/src/identity.ts."""
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return digits[-10:] if len(digits) > 10 else digits


def _providers(user) -> list[str]:
    """The provider ids on an auth account, e.g. ['password', 'google.com']."""
    out = [p.provider_id for p in (user.provider_data or [])]
    # An anonymous account has no provider_data at all. Say so rather than
    # printing an empty list that reads like a bug.
    return out or ["<none — anonymous or phone-only>"]


def _ts(ms) -> str:
    if not ms:
        return "—"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _auth_user(email: str):
    try:
        return fb_auth.get_user_by_email(email)
    except fb_auth.UserNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"    ! could not read auth for {email}: {exc}")
        return None


def _auth_user_by_phone(e164: str):
    try:
        return fb_auth.get_user_by_phone_number(e164)
    except fb_auth.UserNotFoundError:
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"    ! could not read auth for {e164}: {exc}")
        return None


def _doc(client, collection: str, doc_id: str) -> dict | None:
    if not doc_id:
        return None
    try:
        snap = client.collection(collection).document(doc_id).get()
        return snap.to_dict() if snap.exists else None
    except Exception as exc:  # noqa: BLE001
        print(f"    ! could not read {collection}/{doc_id}: {exc}")
        return None


def _query(client, collection: str, field: str, value):
    if value in ("", None):
        return []
    try:
        return list(client.collection(collection).where(field, "==", value).limit(10).stream())
    except Exception as exc:  # noqa: BLE001
        print(f"    ! could not query {collection}.{field}=={value}: {exc}")
        return []


async def person(client, entry: dict, expected_role: str) -> dict:
    """Everything known about one human, across all four stores."""
    email = entry["email"].strip().lower()
    phone = entry.get("phone", "").strip()
    key = _phone_key(phone)

    print(f"\n{'─' * 78}")
    print(f"  {entry['name']}  <{email}>")
    print(f"{'─' * 78}")

    findings: dict = {"email": email, "issues": []}

    # ── 1. Firebase Auth ─────────────────────────────────────────────────────
    user = _auth_user(email)
    if user is None:
        print("  FIREBASE AUTH   : NO ACCOUNT for this address")
        findings["issues"].append("no Firebase Auth account")
        uid = ""
    else:
        uid = user.uid
        provs = _providers(user)
        print(f"  FIREBASE AUTH   : uid = {uid}")
        print(f"    providers     : {', '.join(provs)}")
        print(f"    email         : {user.email}")
        verified = bool(user.email_verified)
        print(f"    EMAIL VERIFIED: {'YES' if verified else 'NO'}")
        if not verified:
            print("      ⚠  A Google sign-in on this address will REMOVE THE PASSWORD")
            print("         rather than raise a collision. Fix by verifying the email")
            print("         BEFORE anyone connects Google. See the module docstring.")
            findings["issues"].append("email not verified — Google would strip the password")
        print(f"    phone on auth : {user.phone_number or '— none —'}")
        print(f"    disabled      : {user.disabled}")
        print(f"    created       : {_ts(user.user_metadata.creation_timestamp)}")
        print(f"    last sign-in  : {_ts(user.user_metadata.last_sign_in_timestamp)}")
        findings["uid"] = uid
        findings["providers"] = provs
        findings["auth_phone"] = user.phone_number or ""

        if "google.com" in provs:
            print("    → Google is ALREADY linked to this uid.")
        if user.phone_number and _phone_key(user.phone_number) != key and key:
            print(f"    ⚠  auth phone differs from the one supplied ({phone})")
            findings["issues"].append("auth phone differs from supplied phone")

    # ── 2. Mongo staff — the authoritative role ──────────────────────────────
    staff = await mongo.get_db()[C.STAFF].find_one({"email": email})
    if staff is None:
        print("  MONGO staff     : NO ROW")
        findings["issues"].append("no Mongo staff row")
    else:
        srole = str(staff.get("role", ""))
        suid = str(staff.get("uid", ""))
        print(f"  MONGO staff     : role = {srole}   is_active = {staff.get('is_active')}")
        print(f"    staff.uid     : {suid}")
        findings["role"] = srole
        if expected_role and srole != expected_role:
            print(f"    ⚠  expected role '{expected_role}'")
            findings["issues"].append(f"role is '{srole}', expected '{expected_role}'")
        if uid and suid and suid != uid:
            print(f"    ⚠  staff.uid does NOT match the auth uid ({uid})")
            findings["issues"].append("staff.uid != auth uid")

    # ── 3. Firestore crmUsers/{uid} — what the CRM shell reads ───────────────
    crm_doc = _doc(client, "crmUsers", uid) if uid else None
    if crm_doc is None:
        print(f"  crmUsers/{uid or '?'}: ABSENT")
        if expected_role != "observer":
            findings["issues"].append("no crmUsers document — CRM sign-in would fail")
    else:
        print(f"  crmUsers/{uid}")
        print(f"    role          : {crm_doc.get('role')}")
        print(f"    email         : {crm_doc.get('email')}")
        print(f"    phone         : {crm_doc.get('phone') or '— none —'}")
        print(f"    isActive      : {crm_doc.get('isActive')}")
        findings["crm_role"] = crm_doc.get("role")

    # ── 4. Firestore users/{uid} — the app side ──────────────────────────────
    app_doc = _doc(client, "users", uid) if uid else None
    if app_doc is None:
        print(f"  users/{uid or '?'}  : ABSENT  (the app refuses a sign-in without one)")
        findings["issues"].append("no users/{uid} app document")
    else:
        print(f"  users/{uid}")
        print(f"    name          : {app_doc.get('name')}")
        print(f"    phoneNumber   : {app_doc.get('phoneNumber') or '—'}   phoneKey: {app_doc.get('phoneKey') or '—'}")
        print(f"    email         : {app_doc.get('email') or '—'}")
        print(f"    crmRole       : {app_doc.get('crmRole') or '—'}")
        print(f"    profileComplete: {app_doc.get('isProfileComplete')}")
        print(f"    accountState  : {app_doc.get('accountState', 'active')}")
        print(f"    isBanned      : {app_doc.get('isBanned')}   isSuspended: {app_doc.get('isSuspended')}")

    # ── 5. Who else holds this identity ──────────────────────────────────────
    print("  DUPLICATES")
    dupes = 0

    if key:
        holder = _auth_user_by_phone(f"+91{key}" if not phone.startswith("+") else phone)
        if holder is None:
            print(f"    phone {phone}: held by NOBODY in Firebase Auth — free to attach")
        elif holder.uid == uid:
            print(f"    phone {phone}: already on this same account ✓")
        else:
            dupes += 1
            print(f"    ⚠  phone {phone} is held by a DIFFERENT auth account: {holder.uid}")
            print(f"       ({holder.email or 'no email'}, providers: {', '.join(_providers(holder))})")
            other = _doc(client, "users", holder.uid)
            if other:
                print(f"       its users/{holder.uid}: name={other.get('name')!r} "
                      f"diamonds={other.get('diamonds')} beans={other.get('beans')} "
                      f"isHost={other.get('isHost')} state={other.get('accountState','active')}")
            findings["issues"].append(f"phone held by other uid {holder.uid}")

    for doc in _query(client, "users", "email", email):
        if doc.id != uid:
            dupes += 1
            d = doc.to_dict()
            print(f"    ⚠  another users doc with this email: {doc.id} (name={d.get('name')!r})")
            findings["issues"].append(f"duplicate users doc {doc.id} by email")

    if key:
        for doc in _query(client, "users", "phoneKey", key):
            if doc.id != uid:
                dupes += 1
                d = doc.to_dict()
                print(f"    ⚠  another users doc with this phoneKey: {doc.id} (name={d.get('name')!r})")
                findings["issues"].append(f"duplicate users doc {doc.id} by phoneKey")

    for doc in _query(client, "crmUsers", "email", email):
        if doc.id != uid:
            dupes += 1
            print(f"    ⚠  another crmUsers doc with this email: {doc.id} "
                  f"(role={doc.to_dict().get('role')})")
            findings["issues"].append(f"duplicate crmUsers doc {doc.id}")

    n = await mongo.get_db()[C.STAFF].count_documents({"email": email})
    if n > 1:
        dupes += 1
        print(f"    ⚠  {n} Mongo staff rows share this email")
        findings["issues"].append(f"{n} staff rows")

    if dupes == 0:
        print("    none ✓")

    return findings


async def census(client) -> None:
    """The shape of the whole database, so nothing is assumed."""
    print(f"\n\n{'═' * 78}")
    print("  CENSUS — every account in the project")
    print(f"{'═' * 78}\n")

    combos: Counter = Counter()
    total = 0
    anon = 0
    by_uid: dict[str, list[str]] = {}
    email_to_uids: dict[str, list[str]] = {}
    phone_to_uids: dict[str, list[str]] = {}

    page = fb_auth.list_users()
    while page:
        for u in page.users:
            total += 1
            provs = sorted(p.provider_id for p in (u.provider_data or []))
            if not provs:
                anon += 1
                combos["<anonymous / no provider>"] += 1
            else:
                combos[" + ".join(provs)] += 1
            by_uid[u.uid] = provs
            if u.email:
                email_to_uids.setdefault(u.email.lower(), []).append(u.uid)
            if u.phone_number:
                phone_to_uids.setdefault(_phone_key(u.phone_number), []).append(u.uid)
        page = page.get_next_page()

    print(f"  Firebase Auth accounts: {total}   (anonymous: {anon})")
    print("  Provider combinations:")
    for combo, count in combos.most_common():
        print(f"    {count:>5}  {combo}")

    multi = {e: u for e, u in email_to_uids.items() if len(u) > 1}
    print(f"\n  Emails on more than one auth account: {len(multi)}")
    for e, uids in list(multi.items())[:20]:
        print(f"    {e}: {', '.join(uids)}")

    multi_p = {p: u for p, u in phone_to_uids.items() if len(u) > 1}
    print(f"  Phone numbers on more than one auth account: {len(multi_p)}")
    for p, uids in list(multi_p.items())[:20]:
        print(f"    {p}: {', '.join(uids)}")

    linked = sum(1 for p in by_uid.values() if "password" in p and "google.com" in p)
    print(f"\n  Accounts with BOTH password and google.com linked: {linked}")
    print(f"  Accounts with a phone provider: "
          f"{sum(1 for p in by_uid.values() if 'phone' in p)}")

    # Firestore side
    for coll in ("users", "crmUsers", "verifiedIdentities"):
        try:
            n = sum(1 for _ in client.collection(coll).select([]).stream())
            print(f"  Firestore {coll}: {n} documents")
        except Exception as exc:  # noqa: BLE001
            print(f"  Firestore {coll}: could not count ({exc})")

    # Orphans — a users doc whose uid names no auth account can never be reached.
    orphans = []
    try:
        for doc in client.collection("users").select([]).stream():
            if doc.id not in by_uid:
                orphans.append(doc.id)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! could not scan users for orphans: {exc}")
    print(f"  users/ documents with NO Firebase Auth account behind them: {len(orphans)}")
    for o in orphans[:20]:
        print(f"    {o}")
    if len(orphans) > 20:
        print(f"    … and {len(orphans) - 20} more")

    crm_orphans = []
    try:
        for doc in client.collection("crmUsers").select([]).stream():
            if doc.id not in by_uid:
                crm_orphans.append(doc.id)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! could not scan crmUsers: {exc}")
    print(f"  crmUsers/ documents with NO auth account (unreachable): {len(crm_orphans)}")
    for o in crm_orphans[:20]:
        print(f"    {o}")

    n_staff = await mongo.get_db()[C.STAFF].count_documents({})
    print(f"  Mongo staff rows: {n_staff}")


async def main() -> int:
    firebase.init()
    await mongo.connect()
    client = firebase.firestore_client()

    print(f"\n{'═' * 78}")
    print("  IDENTITY INSPECTION — READ ONLY, NOTHING IS MODIFIED")
    print(f"  project: {settings.firebase_project_id or '(from credentials)'}")
    print(f"  run at : {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'═' * 78}")

    print("\n\n  THE THREE OWNERS")
    results = []
    for owner in OWNERS:
        results.append(await person(client, owner, "owner"))

    print("\n\n  THE OBSERVER  (must never be reachable from the app)")
    results.append(
        await person(
            client,
            {"email": settings.observer_email, "name": "Observer", "phone": ""},
            "observer",
        )
    )

    await census(client)

    print(f"\n\n{'═' * 78}")
    print("  SUMMARY OF ISSUES")
    print(f"{'═' * 78}")
    any_issue = False
    for r in results:
        if r["issues"]:
            any_issue = True
            print(f"\n  {r['email']}")
            for issue in r["issues"]:
                print(f"    • {issue}")
    if not any_issue:
        print("\n  None. Every account resolves cleanly.")

    print("\n  Nothing above was written. Migration is a separate, explicit step.\n")

    await mongo.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
