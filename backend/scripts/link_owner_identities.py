"""Attach each owner's phone number to the Firebase account they already have.

    cd backend && python -m scripts.link_owner_identities            # report only
    cd backend && python -m scripts.link_owner_identities --apply    # do it

── WHAT THIS FIXES ──────────────────────────────────────────────────────────

`seed_accounts.py` created the three owners with `"phone": ""`. `crm.mirror()`
takes a phone and passes it to `_attach_app_identity`, which is the mechanism
that puts the number on the *same* Firebase account the CRM signs in with — so
phone OTP in the Android app resolves to the uid that owns the `crmUsers`
document. With no number there was nothing to attach, and the owners had no
route into the app at all: Google collided with their password account and
phone OTP resolved to nobody.

── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────

It creates no Firebase account. If an owner's address has none, that is
reported and skipped — creating one here would mint a *second* identity for a
person who already has one, which is the exact failure this whole change
exists to remove.

It deletes nothing, ever. If a phone number already belongs to a different
Firebase account, that account is described in full and the owner is skipped.
Taking a live number off somebody is a decision with a person on the other end
of it; it is not a side effect of a migration script.

It creates no `users/{uid}` document that already exists. `_attach_app_identity`
merges, and only adds `isProfileComplete`/`createdAt`/`createdVia` when the
document is genuinely absent.

The existing uid stays canonical throughout. Nothing here writes a uid.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from firebase_admin import auth as fb_auth

from app.core.roles import Role
from app.db import firebase, mongo
from app.db.mongo import C
from app.services import crm_directory as crm

#: The canonical owner list. Kept in step with `scripts/seed_accounts.py`,
#: which is the file that creates them — if a number changes, change it in
#: both or the next seed run will quietly put the old one back.
OWNERS = [
    {"email": "soumyaranjan.singh7@gmail.com", "name": "Soumya Ranjan Singh", "phone": "+918908641811"},
    {"email": "tanishque50@gmail.com",         "name": "Tanishque",           "phone": "+918755785838"},
    {"email": "baapaadmi0101@gmail.com",       "name": "Alex",                "phone": "+917359766004"},
]


def _phone_key(raw: str) -> str:
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    return digits[-10:] if len(digits) > 10 else digits


def _providers(user) -> str:
    provs = [p.provider_id for p in (user.provider_data or [])]
    return ", ".join(provs) if provs else "<none — anonymous>"


def _describe_conflict(client, holder) -> None:
    """Everything worth knowing about the account that holds the number."""
    print(f"      uid       : {holder.uid}")
    print(f"      email     : {holder.email or '— none —'}")
    print(f"      providers : {_providers(holder)}")
    print(f"      created   : {datetime.fromtimestamp(holder.user_metadata.creation_timestamp / 1000, tz=timezone.utc):%Y-%m-%d}")
    try:
        snap = client.collection("users").document(holder.uid).get()
    except Exception as exc:  # noqa: BLE001
        print(f"      users doc : could not read ({exc})")
        return
    if not snap.exists:
        print("      users doc : none — this is an auth account with no app profile")
        return
    d = snap.to_dict() or {}
    print(f"      users doc : name={d.get('name')!r} diamonds={d.get('diamonds', 0)} "
          f"beans={d.get('beans', 0)} isHost={d.get('isHost', False)} "
          f"state={d.get('accountState', 'active')}")


async def one(client, owner: dict, apply: bool) -> bool:
    """Returns True when this owner ends up correctly linked."""
    email = owner["email"].strip().lower()
    name = owner["name"]
    phone = owner["phone"].strip()
    key = _phone_key(phone)

    print(f"\n  {name}  <{email}>")

    # ── The account must already exist. We never create one here. ────────────
    user = firebase.get_user_by_email(email)
    if user is None:
        print("    ✗ no Firebase account for this address.")
        print("      Not creating one — that would be a second identity for a")
        print("      person who is supposed to have exactly one. Run")
        print("      `python -m scripts.seed_accounts` if this owner is genuinely new.")
        return False

    uid = user.uid
    print(f"    uid       : {uid}  (canonical — unchanged)")
    print(f"    providers : {_providers(user)}")
    print(f"    auth phone: {user.phone_number or '— none —'}")
    print(f"    email verified: {'YES' if user.email_verified else 'NO'}")

    # ── The unverified-email trap, which destroys the password door ──────────
    #
    # This is the one step that can lose something, and it loses it silently.
    #
    # Firebase's "one account per email address" has an exception. Signing in
    # with Google against an existing PASSWORD account whose email is NOT
    # verified does not raise `account-exists-with-different-credential` — the
    # case the CRM handles by asking for the password and then linking. Instead
    # Firebase treats the password account as possibly planted by somebody who
    # never owned the mailbox, links Google, and REMOVES THE PASSWORD PROVIDER.
    #
    # The owner would sign in with Google, see nothing wrong, and discover
    # weeks later that email and password no longer works, with nothing
    # anywhere explaining why. That breaks the requirement outright: the
    # password has to keep working, and it is the fallback for the day Google
    # is the thing that is broken.
    #
    # `seed_accounts.py` created these three with `email_verified=False`.
    # Setting a password through the emailed link flips it to true, so an owner
    # who has done that is already safe — but "already safe, probably" is not a
    # guarantee, and the failure is invisible.
    #
    # ── WHY MARKING IT VERIFIED IS LEGITIMATE HERE, AND ONLY HERE ───────────
    #
    # `email_verified` means "the project vouches for this address". For these
    # three it does: the accounts were created BY this project, from addresses
    # the owners supplied, and the set-password link was delivered to those
    # mailboxes. Asserting it is what the Admin SDK exists for.
    #
    # It is scoped to the three addresses hard-coded in OWNERS above and must
    # not be generalised. Marking an arbitrary address verified would hand
    # whoever holds the account a trusted identity nobody checked — which is
    # the exact attack the unverified flag exists to stop.
    if not user.email_verified:
        if not apply:
            print("    → would mark the email verified, so Google LINKS to this")
            print("      account instead of silently removing its password")
        else:
            try:
                fb_auth.update_user(uid, email_verified=True)
                print("    ✓ email marked verified — the password door is now safe")
                print("      from a Google sign-in (see the note in this script)")
            except Exception as exc:  # noqa: BLE001
                print(f"    ✗ could not mark the email verified: {exc}")
                print("      DO NOT connect Google for this owner yet — doing so")
                print("      would remove their password. Have them set their")
                print("      password from the emailed link first, which verifies")
                print("      the address, then re-run this.")
                return False

    # ── Is the number free? ──────────────────────────────────────────────────
    holder = None
    try:
        holder = fb_auth.get_user_by_phone_number(phone)
    except fb_auth.UserNotFoundError:
        holder = None
    except Exception as exc:  # noqa: BLE001
        print(f"    ✗ could not check who holds {phone}: {exc}")
        return False

    if holder is not None and holder.uid != uid:
        print(f"    ✗ CONFLICT — {phone} already belongs to another account.")
        _describe_conflict(client, holder)
        print("      Nothing was changed. Resolve this deliberately: either that")
        print("      account releases the number, or this owner uses a different")
        print("      one. `scripts/inspect_identity.py` shows the full picture and")
        print("      `firebase.clear_user_phone(uid)` is the release, if it is the")
        print("      same person's old test account.")
        return False

    already = holder is not None and holder.uid == uid
    if already:
        print(f"    ✓ {phone} is already on this account.")
    elif not apply:
        print(f"    → would attach {phone} to {uid}")
    else:
        try:
            firebase.update_user_phone(uid, phone)
            print(f"    ✓ attached {phone} to {uid}")
        except Exception as exc:  # noqa: BLE001
            print(f"    ✗ could not attach {phone}: {exc}")
            return False

    if not apply:
        print("    → would refresh the Mongo staff row, crmUsers and users/{uid}")
        return True

    # ── The Mongo staff row — authoritative for the role, and it holds the
    #    phone the CRM shows. Only these two fields; nothing else is touched.
    await mongo.get_db()[C.STAFF].update_one(
        {"email": email},
        {"$set": {"phone": phone, "name": name,
                  "updated_at": datetime.now(timezone.utc)}},
    )
    print("    ✓ Mongo staff row updated (phone, name)")

    # ── crmUsers + users/{uid}, through the one tested path ──────────────────
    # `mirror()` preserves crmId, createdBy, createdAt and lastLoginAt, resets
    # permissions from the role's defaults (identical for an owner re-run), and
    # then calls `_attach_app_identity`, which merges `users/{uid}` rather than
    # replacing it. Re-running this is a no-op.
    try:
        outcome = crm.mirror(
            uid=uid,
            email=email,
            name=name,
            role=Role.OWNER,
            created_by="owner-identity-link",
            phone=phone,
        )
        print(f"    ✓ {outcome.detail}")
    except crm.DirectoryError as exc:
        print(f"    ✗ could not mirror: {exc}")
        return False

    return True


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="actually write. Without it this only reports.")
    args = ap.parse_args()

    firebase.init()
    await mongo.connect()
    client = firebase.firestore_client()

    print(f"\n{'═' * 74}")
    print("  OWNER IDENTITY LINK" + ("" if args.apply else "   — DRY RUN, nothing is written"))
    print(f"{'═' * 74}")

    ok = 0
    for owner in OWNERS:
        if await one(client, owner, args.apply):
            ok += 1

    print(f"\n  {ok} of {len(OWNERS)} owners linked.")
    if ok == len(OWNERS) and args.apply:
        print("\n  Phone OTP in the app now resolves to the existing owner uid.")
        print("  Google in the app starts working once each owner connects Google")
        print("  in the CRM (Settings → Authentication → Connect Google).")
    elif not args.apply:
        print("\n  Re-run with --apply to write.")

    await mongo.disconnect()
    print()
    return 0 if ok == len(OWNERS) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
