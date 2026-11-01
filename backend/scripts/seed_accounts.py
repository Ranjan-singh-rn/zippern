"""Create the governance accounts — the owners and the observer.

Run once against a fresh database:

    cd backend && python -m scripts.seed_accounts

Owners sign in through Firebase Auth, so each needs a Firebase account. This
script creates the Firebase user if missing and emails a set-password link.

The observer has no password at all — sign-in is a one-time code emailed to the
delivery mailbox on every attempt.

── HOW MANY OWNERS THERE ACTUALLY ARE ────────────────────────────────────────

The governance model is **three** owners (spec 1.2). `OWNERS` below lists
**two**, and the third is commented out because that person does not exist yet.
The code for them is left in place, ready to uncomment.

That gap is not cosmetic and it is not a to-do buried in a list. Two rules run
on every card: an owner cannot sign one they raised (5.5.3), and whoever
verified it cannot sign it (`cards.sign`). With two owners the system works and
has no slack — if one of them raised or verified a card, the other is the only
person alive who can sign it, and if that person is away, on leave, or is the
one who raised it, the money stops. Three owners is what turns "somebody else
must sign" into a rule with a spare.

So this script says out loud, every time it runs, how many owners exist against
how many the model calls for. It refuses nothing: two owners is a working
system and this is a statement of where it stands, not a gate.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timezone

from firebase_admin import auth as fb_auth

from app.config import settings
from app.core.roles import Role
from app.db import firebase, mongo
from app.db.mongo import C  # noqa: F401  — used in the summary below
from app.services import crm_directory as crm

# ── Edit these before running ────────────────────────────────────────────────

#: How many owners the governance model calls for. Spec 1.2 — "the three
#: business owners". Read only to report the shortfall below; nothing is
#: refused on it.
OWNERS_BY_DESIGN = 3

#: The owners that actually exist. All three, as of the third being added.
#:
#: Lower-cased deliberately. Firebase stores the address on an ID token
#: lower-cased, and `_protected_emails` in `scripts/reset_test_data.py`
#: compares against this list case-insensitively by lower-casing both sides —
#: but `crm_directory` and the Firestore rules match the token address as-is.
#: An owner seeded with a capital letter is an owner whose protections quietly
#: do not match them.
#:
#: What adding a third owner actually changes, beyond one more login:
#:
#:   * Nobody signs a card they raised, and nobody signs one they verified.
#:     With two owners, one of them touching a card left exactly one eligible
#:     signer — so a card raised by one and verified by the other could be
#:     signed by nobody at all, and an owner on a flight stopped payments.
#:     Three makes that a routine morning instead of a deadlock.
#:   * Every owner can see the other two on `/audit`, which is the point of
#:     three rather than two: no pair can quietly agree something.
#:
#: ── THE PHONE NUMBER IS NOT OPTIONAL ─────────────────────────────────────
#:
#: These three were seeded with `"phone": ""`, and that one blank is why no
#: owner could reach the Android app for months. `mirror()` below passes the
#: phone to `_attach_app_identity`, which puts the number on the SAME Firebase
#: account the CRM signs in with — that is the whole mechanism by which phone
#: OTP in the app lands on the uid that owns the `crmUsers` document. With no
#: number there was nothing to attach, so phone OTP resolved to nobody and
#: Google collided with the password account. Both doors shut.
#:
#: `scripts/link_owner_identities.py` repaired the three accounts that already
#: existed. These values are here so that a re-run, a restore or a new project
#: does not undo it.
OWNERS = [
    {"email": "tanishque50@gmail.com", "name": "Tanishque", "phone": "+918755785838"},
    {"email": "soumyaranjan.singh7@gmail.com", "name": "Soumya Ranjan Singh", "phone": "+918908641811"},
    {"email": "baapaadmi0101@gmail.com", "name": "Alex", "phone": "+917359766004"},
]

OBSERVER = {
    "email": settings.observer_email,   # 314zipper@gmail.com
    "name": "Observer",
}


def mirror_to_firestore(
    *, uid: str, email: str, name: str, role: Role, phone: str = ""
) -> None:
    """Write the matching crmUsers document, for roles that should have one.

    The CRM front end still reads Firestore `crmUsers` to resolve a role and
    build navigation, while the API keeps the authoritative record in Mongo.
    Owners need both or they cannot sign in to the CRM.

    **The observer deliberately gets no Firestore record.** The old role
    vocabulary has no read-only tier — its lowest useful value is 'superadmin',
    which grants full write access on every Firestore-backed page. Mirroring an
    observer there would hand the read-only account complete control, which is
    the opposite of what the role exists for. The observer signs in at
    /observer and uses the API-backed screens, where read-only is enforced.

    The behaviour above now lives in `app/services/crm_directory.py`, so this
    script, `POST /staff` and `scripts/repair_staff_accounts.py` all write the
    same document. It used to live only here, which is precisely why accounts
    seeded by this script work and accounts created since do not. This function
    is the printing wrapper and nothing else.
    """
    try:
        # `phone` is what makes this one account rather than two. See the note
        # on OWNERS above: omitting it is the bug this argument exists to stop
        # recurring.
        outcome = crm.mirror(
            uid=uid, email=email, name=name, role=role, created_by="seed",
            phone=phone,
        )
    except crm.DirectoryError as exc:
        if role in crm.NOT_MIRRORED:
            print(f"  crmUsers skipped for observer ({email}) — read-only by design")
            print(f"    ⚠  could not check for an old record: {exc}")
        else:
            print(f"  ⚠  could not mirror {email} to Firestore: {exc}")
        return

    if outcome.action == "written":
        print(f"  crmUsers mirrored: {email} → {outcome.crm_role}")
        return

    print(f"  crmUsers skipped for observer ({email}) — read-only by design")
    for doc_id, had_role in outcome.removed:
        print(f"    removed crmUsers/{doc_id} — it granted '{had_role}' write access")
    if not outcome.removed:
        print("    no crmUsers record — correct")


async def upsert_staff(
    *, uid: str, email: str, name: str, role: Role, phone: str = ""
) -> None:
    now = datetime.now(timezone.utc)
    await mongo.get_db()[C.STAFF].update_one(
        {"email": email.lower()},
        {
            "$set": {
                "uid": uid,
                "email": email.lower(),
                "name": name,
                "role": str(role),
                "phone": phone,
                "is_active": True,
                "updated_at": now,
            },
            "$setOnInsert": {"created_at": now, "created_by": "seed"},
        },
        upsert=True,
    )
    print(f"  staff record ready: {email}  →  {role}")
    mirror_to_firestore(uid=uid, email=email, name=name, role=role, phone=phone)


def ensure_firebase_user(email: str, name: str) -> str:
    """Create the auth account if missing, and email a set-password link.

    The link is never printed. It is a live credential — anyone holding it can
    take over the account — so it goes to the owner's inbox and nowhere else.
    """
    from app.services import email as email_service

    existing = firebase.get_user_by_email(email)
    uid = existing.uid if existing else None

    if uid is None:
        # ── `email_verified=True`, and it is not cosmetic ────────────────────
        #
        # This was False, and that one flag silently destroys the password door
        # the moment an owner connects Google.
        #
        # Firebase's "one account per email address" has an exception for an
        # UNVERIFIED password account: a Google sign-in on the same address does
        # not raise `account-exists-with-different-credential` — the collision
        # the CRM handles by demanding the password and then linking. Firebase
        # instead assumes the password account may have been planted by somebody
        # who never owned the mailbox, links Google, and REMOVES THE PASSWORD
        # PROVIDER. The owner notices weeks later, when email and password stops
        # working and nothing explains why. The password is the fallback for the
        # day Google is what is broken, so losing it quietly is the worst
        # possible way to lose it.
        #
        # Asserting it is legitimate here and nowhere else: this script creates
        # the account, from an address the owner supplied, and mails the
        # set-password link to that mailbox. The project genuinely does vouch
        # for the address. Doing the same for an address that arrived from a
        # form would hand whoever holds the account a trusted identity nobody
        # checked, which is the attack the flag exists to stop.
        created = fb_auth.create_user(
            email=email, display_name=name, email_verified=True
        )
        uid = created.uid
        print(f"  firebase account created: {email}")
    else:
        print(f"  firebase account already existed: {email}")
        # Same reasoning, for an account seeded before the line above changed.
        # `scripts/link_owner_identities.py` repairs the three that exist; this
        # keeps a re-run, a restore or a retargeted project from undoing it.
        if not existing.email_verified:
            try:
                fb_auth.update_user(uid, email_verified=True)
                print("    email marked verified — protects the password from a")
                print("    Google sign-in; see the note above")
            except Exception as exc:  # noqa: BLE001
                print(f"    ⚠  could not mark the email verified: {exc}")
                print("       Connecting Google for this owner would remove their")
                print("       password. Have them set it from the emailed link")
                print("       first, which verifies the address.")

    try:
        link = fb_auth.generate_password_reset_link(email)
    except Exception as exc:  # noqa: BLE001
        print(f"  ⚠  could not generate a set-password link: {exc}")
        return uid

    sent = email_service.send_staff_invitation(
        to_email=email,
        name=name,
        role_label="Business Owner",
        set_password_link=link,
        invited_by="Zipper setup",
    )
    if sent:
        print(f"  → set-password email sent to {email}")
    else:
        print(
            f"  ⚠  could not email {email}. Send a reset from the Firebase console:\n"
            f"     Authentication → {email} → Reset password"
        )
    return uid


async def main() -> int:
    # One email, one role. An address used as both owner and observer would
    # silently overwrite itself here, leaving whichever ran last — and the
    # observer is meant to be a separate person who only watches.
    observer_email = OBSERVER["email"].strip().lower()
    clashes = [o for o in OWNERS if o["email"].strip().lower() == observer_email]
    if clashes:
        print(
            f"\n  ✗ {observer_email} is listed as both an owner and the observer.\n"
            f"    These must be different people — the observer exists to watch\n"
            f"    the owners, which does not work if they are the same account.\n"
            f"    Remove it from OWNERS, or change OBSERVER_EMAIL in .env.\n"
        )
        return 1

    seen: set[str] = set()
    for o in OWNERS:
        email = o["email"].strip().lower()
        if email in seen:
            print(f"\n  ✗ {email} appears twice in OWNERS.\n")
            return 1
        seen.add(email)

    # P0-10 (OPS-C): seeding writes Owner and Observer accounts — the target is
    # named and confirmed before anything connects, and the database must name it.
    from app.core.destructive import DestructiveRefused, require_data_canary, require_destructive_target
    try:
        print(require_destructive_target("seed_accounts", writes=True))
    except DestructiveRefused as exc:
        print(f"\n  ✗ {exc}\n")
        return 2

    firebase.init()
    await mongo.connect()
    try:
        await require_data_canary(mongo.get_db(), "seed_accounts")
    except DestructiveRefused as exc:
        print(f"\n  ✗ {exc}\n")
        await mongo.disconnect()
        return 2

    print(f"\nOwners — {len(OWNERS)} configured of the {OWNERS_BY_DESIGN} the")
    print("governance model calls for (spec 1.2).")
    if len(OWNERS) < OWNERS_BY_DESIGN:
        missing = OWNERS_BY_DESIGN - len(OWNERS)
        print(
            f"  ⚠  {missing} owner(s) short. The third row in OWNERS is commented\n"
            "     out in this file because that person does not exist yet. Two\n"
            "     owners is a working system with no slack: an owner cannot sign\n"
            "     a card they raised (5.5.3) and whoever verified it cannot sign\n"
            "     it either, so with two, one owner touching a card leaves\n"
            "     exactly one person alive who can sign it."
        )
    if not OWNERS:
        print("  none configured — edit OWNERS in this file")
    for owner in OWNERS:
        uid = ensure_firebase_user(owner["email"], owner["name"])
        await upsert_staff(
            uid=uid, email=owner["email"], name=owner["name"], role=Role.OWNER,
            phone=owner.get("phone", ""),
        )

    print("\nObserver")
    # Deliberately no Firebase account and no password. Sign-in is by one-time
    # code only, delivered to a mailbox that is not this address.
    await upsert_staff(
        uid=f"observer:{OBSERVER['email'].lower()}",
        email=OBSERVER["email"],
        name=OBSERVER["name"],
        role=Role.OBSERVER,
    )
    print(f"  sign-in codes will be delivered to: {settings.observer_otp_delivery_email}")

    # Show the end state, so a mistake is visible rather than assumed.
    print("\nAccounts now in the system")
    cursor = mongo.get_db()[C.STAFF].find({}, {"email": 1, "role": 1, "is_active": 1})
    rows = [d async for d in cursor]
    for d in sorted(rows, key=lambda r: (r.get("role", ""), r.get("email", ""))):
        state = "" if d.get("is_active", True) else "  (inactive)"
        print(f"  {d.get('role',''):<10} {d.get('email','')}{state}")

    owners = [d for d in rows if d.get("role") == str(Role.OWNER)]
    observers = [d for d in rows if d.get("role") == str(Role.OBSERVER)]
    print(
        f"\n  {len(owners)} owner(s) of the {OWNERS_BY_DESIGN} the model calls for, "
        f"{len(observers)} observer(s)"
    )
    if len(owners) < 2:
        print(
            "  ⚠  Fewer than two owners. Nobody can sign a card they raised, and\n"
            "     whoever verifies cannot sign — so money cannot move until there\n"
            "     are at least two."
        )
    elif len(owners) < OWNERS_BY_DESIGN:
        print(
            f"  ⚠  {OWNERS_BY_DESIGN - len(owners)} short of the three-owner\n"
            "     sign-off model. Money moves, but with no spare signer: the one\n"
            "     owner who did not raise or verify a card is the only person who\n"
            "     can sign it. Uncomment the third row in OWNERS and re-run this\n"
            "     script when that person exists."
        )

    await mongo.disconnect()
    print("\nDone.\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
