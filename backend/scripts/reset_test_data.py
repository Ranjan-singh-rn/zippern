"""Clear this project's data after testing, keeping the owners and the setup.

WHAT THIS IS FOR
----------------
There is one environment, and there is not going to be a second one. So testing
means putting real records into the live system and then getting them out again,
and doing that by hand across the Firebase console, Firebase Auth and Atlas is
where most of an evening goes. Something is always missed, and a half-deleted
partner is worse than a whole one — the login exists and the record does not, so
the next test fails for a reason unrelated to what was being tested.

This does it in one command, in the right order, and shows you exactly what it
will touch before touching anything.

WHAT IT KEEPS
-------------
Two kinds of thing survive, and the second is the one people forget:

  * **Who you are.** The owner accounts and the observer — in Firebase Auth, in
    `crmUsers`, in `users` and `publicProfiles`, and in the Mongo `staff`
    collection. Deleting your own login while clearing test data is a bad
    afternoon.

    All five, and they used to be three. `users/{uid}` and
    `publicProfiles/{uid}` were emptied wholesale, so an owner kept their CRM
    login and lost the app half of the same account — the Android app refuses
    anybody whose user document is missing, which reads as a broken app rather
    than as something this script did.

    Matched on **uid**, resolved from the address, the phone number, the Mongo
    `staff` row and Firebase Auth — see `_kept_uids`. Matching on the address
    alone missed a phone-only login, which is how most people open the app.

  * **What you have set up.** `bagItems`, `appConfig`, `gifts`, `diamondPacks`,
    `rechargePackages`, `paymentConfig`, `contentConfig`, `policies`.

    `appConfig` matters more than the rest put together. It holds the commission
    slab table, the bean rate, the diamond price and the bank details a seller
    pays into. Wipe it and every money report in the CRM starts printing
    PROVISIONAL, commission cannot be computed at all, and the purchase dialog
    has no account number to show. It is configuration you decided, not data a
    test produced, and it is kept by default for that reason.

    `--include-config` removes them too, and names each one first.

WHAT IT CLEARS
--------------
Everything else. Partners and their logins, hosts, app users, the money board,
the ledger, balances, sales, payouts, every application queue, tickets, live
rooms, transactions, reports and the audit log.

ORDER
-----
Money rows, then the Firestore replica, then the login, then the Auth account.
Reversed, a failure halfway leaves an account that can still sign in and reach
nothing at all.

USAGE
-----
    python -m scripts.reset_test_data                    # show what would go
    python -m scripts.reset_test_data --confirm          # do it
    python -m scripts.reset_test_data --confirm --include-config
    python -m scripts.reset_test_data --keep a@b.com     # spare one more login

`--confirm` alone is not enough for a full wipe: it asks you to type the number
of records it is about to delete. That is deliberate friction on a command that
cannot be undone.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.db import firebase
from app.db import mongo
from app.db.mongo import C

# ── What survives ────────────────────────────────────────────────────────────

#: Configuration you entered, not data a test produced. Kept unless
#: `--include-config`. `appConfig` is the one that would hurt: commission slabs,
#: bean rate, diamond price, and the bank account a seller pays into.
CONFIG_COLLECTIONS = (
    "bagItems",
    "appConfig",
    "gifts",
    "diamondPacks",
    "rechargePackages",
    "paymentConfig",
    "contentConfig",
    "policies",
    # The XP and beans ladders the CRM Levels page writes. Configuration, not
    # data a test produced — and `getHostLadder` falls back to a hardcoded table
    # if it is missing, so wiping it silently reverts every threshold you set.
    "levelConfig",
)

#: Everything a test can produce. Emptied wholesale.
DATA_COLLECTIONS = (
    # partners and people
    "agencies",
    "sellers",
    "users",
    # Three of the entries below are filtered rather than emptied — the owners
    # and the observer keep their documents in each. See `SPARED_BY_UID`.
    "crmUsers",
    "verifiedIdentities",
    # queues a form fills
    "hostApplications",
    "approvalRequests",
    "coinPurchaseRequests",
    "rechargeRequests",
    "salaryRequests",
    "withdrawalRequests",
    # app activity
    "liveRooms",
    "giftEvents",
    "platformRevenue",
    "hostPayouts",
    "weeklyPayoutReports",
    "notifications",
    "broadcasts",
    # support and moderation
    "supportTickets",
    "techTickets",
    "bannedDevices",
    "reports",
    "feedback",
    # ── Added after the first version of this script ──────────────────────────
    #
    # Every one of these was being LEFT BEHIND by a "full" reset, and three of
    # them break the next test rather than merely cluttering it:
    #
    #   quickLoginTokens — a credential. Left behind, it redeems into an account
    #     the reset just deleted, and the tester is signed in as a ghost.
    #   partyRooms — `isActive: true` with no host and no seats, sitting at the
    #     top of the room list for ever.
    #   publicProfiles — the discovery feed reads THIS, not `users`. Clearing
    #     `users` alone leaves a feed full of people who no longer exist.
    "quickLoginTokens",
    # The device→guest map. Pure test residue once the accounts it names are
    # gone, and confusing residue: a binding that outlives its account answers
    # "this handset already has a guest" about a uid that no longer exists.
    #
    # It does recover on its own — a binding whose `users` document has gone is
    # read as a dead pointer and replaced — but only after the ten-minute grace
    # window that tells an in-flight first launch apart from a purged one. Ten
    # minutes of a reset looking broken is ten minutes of debugging the reset.
    "guestDeviceBindings",
    "identityReleases",
    "partyRooms",
    "publicProfiles",
    "hostVerification",
    "callHistory",
    "calls",
    "giftPairs",
    "giftTransactions",
    "adminAlerts",
    "appeals",
    # Replay guards. Harmless to keep, but they are pure test residue and they
    # make a re-run of the same test look like a replay.
    "callIdempotency",
    "giftIdempotency",
    "walletIdempotency",
    "weeklyStatements",
)

#: Every Mongo collection except `staff`, which is filtered rather than emptied.
MONGO_COLLECTIONS = (
    C.OBSERVER_OTP, C.SESSIONS, C.AUDIT, C.LEDGER, C.BALANCES, C.CARDS,
    C.PARTNERS, C.RATES, C.SALES, C.SUBAGENCY_PAYOUTS, C.EMAIL_DELIVERIES,
    C.ALERT_STATE, C.REPORT_SUBSCRIPTIONS, C.SCHEDULED_RUNS,
    C.CHANCE_MECHANICS, C.CHANCE_CONFIGS, C.CHANCE_ROUNDS,
)


def _protected_emails(extra: list[str]) -> set[str]:
    """Addresses this script must never delete, whatever else it is told.

    Shared with `scripts/reset_firestore.py`, which imports it rather than
    keeping a second list. Two protection lists would be one protection list and
    one that is out of date, and the one that is out of date is the one that
    deletes an owner.
    """
    from app.config import settings

    protected = {
        str(settings.observer_email or "").strip().lower(),
        str(settings.observer_otp_delivery_email or "").strip().lower(),
    }
    try:
        from scripts.seed_accounts import OWNERS

        protected |= {str(o.get("email", "")).strip().lower() for o in OWNERS}
    except Exception as exc:  # noqa: BLE001
        # A missing seed list must never silently disable the guard — without it
        # this script would happily delete the owners it exists to protect.
        print(f"  !! Could not read the owner list ({exc}).")
        print("     Refusing to continue: the protection list would be incomplete.")
        raise SystemExit(2) from exc
    protected |= {e.strip().lower() for e in extra if e.strip()}
    protected.discard("")
    return protected


def _split_keeps(extra: list[str]) -> tuple[list[str], list[str]]:
    """Sort `--keep` values into addresses and phone numbers.

    `--keep` used to mean "an email address", and that quietly could not spare
    the one kind of account most likely to need it: a PHONE-ONLY login, which is
    how the app signs most people in and which carries no address to name it by.
    Asking for it on the command line looked like it worked — the value was added
    to the protected-address set, matched nothing, and the account was deleted.

    Split on a leading `+` and on being otherwise all digits, so both spellings
    of a number work and an address can never be mistaken for one.
    """
    emails: list[str] = []
    phones: list[str] = []
    for raw in extra:
        v = raw.strip()
        if not v:
            continue
        if "@" in v:
            emails.append(v)
        elif v.startswith("+") or v.replace(" ", "").replace("-", "").isdigit():
            phones.append(v.replace(" ", "").replace("-", ""))
        else:
            # Neither shape. Kept as an address so the value still reaches the
            # Mongo `staff` lookup rather than being dropped in silence.
            emails.append(v)
    return emails, phones


def _protected_phones(extra: list[str] | None = None) -> set[str]:
    """The owners' phone numbers, E.164, from the same seed list.

    Protection used to key on the email address and nothing else, and that misses
    a real account: the Android app signs in with phone OTP, so an owner can hold
    a Firebase account carrying their number and **no email at all**. Such an
    account matches no protected address, so `_delete_auth_except` deleted it —
    taking the login the owner uses on their phone with it, while the CRM login
    survived and made the loss look like something else.

    The numbers come from `scripts/seed_accounts.OWNERS`, which is the same place
    the addresses come from, so there is still one list to maintain. The observer
    has no phone and no Firebase account by design and contributes nothing here.
    """
    numbers = {
        # Anything named on the command line, normalised the same way the staff
        # lookup below normalises a stored number.
        (n if n.startswith("+") else f"+91{n}")
        for n in (extra or [])
        if n.strip()
    }
    try:
        from scripts.seed_accounts import OWNERS
    except Exception:  # noqa: BLE001 — `_protected_emails` already refused above
        return numbers
    return numbers | {
        str(o.get("phone", "")).strip()
        for o in OWNERS
        if str(o.get("phone", "")).strip()
    }


async def _kept_uids(protected: set[str], db, keep_phones: list[str] | None = None) -> set[str]:
    """Every uid that must survive, found four ways rather than one.

    One address can sit on several Firebase accounts and one person can sit on
    several ids, so this asks every record that knows about them:

      1. **Firebase Auth by email** — the CRM login. What this used to do, and
         on its own it misses everything below.
      2. **Firebase Auth by phone** — the app login. See `_protected_phones`.
      3. **The Mongo `staff` row** — the id this API authorises against, which is
         also the id `crmUsers`, `users` and `publicProfiles` are filed under.
         It is read even when the Auth lookups found nothing, because a uid that
         names no live Auth account is exactly the orphaned-row case
         `security._staff_for_authenticated_uid` exists to repair, and deleting
         its documents would turn a repairable account into a lost one.
      4. **Whatever the staff row says their phone is** — an owner who changed
         their number after the seed list was written.

    A failure in any one lookup is not fatal, but it is printed: a quietly
    incomplete protection list is the failure this whole function exists to stop.
    """
    from firebase_admin import auth as fb_auth

    uids: set[str] = set()

    def _auth(lookup, value: str) -> None:
        """Add the uid behind one identifier. No account for it is normal — the
        observer has none by design — so a miss is silent."""
        try:
            uids.add(lookup(value).uid)
        except Exception:  # noqa: BLE001
            pass

    for email in protected:
        _auth(fb_auth.get_user_by_email, email)

    phones = set(_protected_phones(keep_phones))

    rows = db[C.STAFF].find({"email": {"$in": list(protected)}})
    async for row in rows:
        uid = str(row.get("uid", "") or "").strip()
        if uid:
            uids.add(uid)
        phone = str(row.get("phone", "") or "").strip()
        if phone:
            phones.add(phone if phone.startswith("+") else f"+91{phone}")

    for phone in phones:
        _auth(fb_auth.get_user_by_phone_number, phone)

    uids.discard("")
    return uids


#: Collections filtered by uid rather than emptied, because a document in them is
#: an ACCOUNT and one of those accounts is the person running this.
#:
#: `users` and `publicProfiles` are the two that were missing, and they are the
#: app half of exactly the same person. `crm_directory._attach_app_identity`
#: creates `users/{uid}` for every staff account so that a CRM login can open the
#: Android app at all, and the discovery feed reads `publicProfiles`. Clearing
#: both wholesale left an owner who could still sign in to the CRM and was
#: refused by the app — "your user document is missing" — with nothing on either
#: screen connecting that to a reset run the week before.
SPARED_BY_UID = ("crmUsers", "users", "publicProfiles")


def _doomed_staff(protected: set[str], keep_uids: set[str]) -> dict:
    """The Mongo `staff` rows this run may delete — matched on address OR uid.

    Address alone was not enough. The filter was `{"email": {"$nin": protected}}`
    and Mongo treats a **missing** field as not-in, so a staff row carrying no
    email — a phone-only account, or one written before the address was
    recorded — was deleted by a filter written to protect it. The observer is the
    same shape from the other direction: its uid is synthetic
    (`observer:<email>`) and matches no Firebase account, so only the address
    ever protected it.

    Requiring a row to fail BOTH tests before it is deleted means either half
    alone is enough to save somebody, which is the right way round for a guard on
    an irreversible delete.
    """
    return {
        "email": {"$nin": list(protected)},
        "uid": {"$nin": list(keep_uids)},
    }


def _count(collection: str) -> int:
    try:
        return sum(1 for _ in firebase.firestore_client().collection(collection).stream())
    except Exception:  # noqa: BLE001
        return 0


def _clear(collection: str, keep_ids: set[str]) -> int:
    """Empty a Firestore collection, sparing `keep_ids`. Returns the count."""
    client = firebase.firestore_client()
    removed = 0
    while True:
        batch = [
            s for s in client.collection(collection).limit(300).stream()
            if s.id not in keep_ids
        ]
        if not batch:
            return removed
        for snap in batch:
            snap.reference.delete()
            removed += 1
        if len(batch) < 300:
            return removed


def _delete_auth_except(keep_uids: set[str]) -> int:
    """Every Firebase Auth account except the ones being kept."""
    from firebase_admin import auth as fb_auth

    removed = 0
    page = fb_auth.list_users()
    doomed = [u.uid for u in page.iterate_all() if u.uid not in keep_uids]
    for uid in doomed:
        try:
            fb_auth.delete_user(uid)
            removed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"      auth {uid}: {exc}")
    return removed


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--confirm", action="store_true", help="actually delete")
    ap.add_argument(
        "--include-config",
        action="store_true",
        help="also wipe appConfig, gifts, bagItems and the rest of the setup",
    )
    ap.add_argument(
        "--keep", action="append", default=[],
        help="an email address OR a phone number to spare, on top of the owners "
             "and the observer. Repeatable.",
    )
    args = ap.parse_args()

    # P0-10 (OPS-C): the target, named and confirmed, before anything connects.
    from app.core.destructive import DestructiveRefused, require_data_canary, require_destructive_target
    try:
        print(require_destructive_target("reset_test_data", writes=args.confirm))
    except DestructiveRefused as exc:
        print(f"\n  ✗ {exc}\n")
        return 2

    firebase.init()
    await mongo.connect()
    db = mongo.get_db()
    if args.confirm:
        try:
            await require_data_canary(db, "reset_test_data")
        except DestructiveRefused as exc:
            print(f"\n  ✗ {exc}\n")
            await mongo.disconnect()
            return 2

    keep_emails, keep_phones = _split_keeps(args.keep)
    protected = _protected_emails(keep_emails)
    keep_uids = await _kept_uids(protected, db, keep_phones)

    print()
    print("═" * 70)
    print("  RESET" + ("" if args.confirm else "   —  DRY RUN, nothing will be written"))
    print("═" * 70)
    print()
    print("  KEEPING")
    for email in sorted(protected):
        print(f"    login   {email}")
    # Phone numbers are listed too, and for the same reason the addresses are:
    # this block is how you check an irreversible command before running it. A
    # `--keep +91...` that quietly matched nothing used to look identical to one
    # that worked, and the account it failed to spare is the kind with no address
    # to notice its absence by.
    for phone in sorted(_protected_phones(keep_phones)):
        print(f"    login   {phone}")
    if not args.include_config:
        print(f"    config  {', '.join(CONFIG_COLLECTIONS)}")
    else:
        print("    config  NOTHING — --include-config was passed")
        print("            appConfig holds the commission slabs, the bean rate,")
        print("            the diamond price and the bank account sellers pay")
        print("            into. Every money report will read PROVISIONAL until")
        print("            you enter them again.")
    print(
        f"    {len(keep_uids)} account id(s) matched those addresses, their "
        "phone numbers and their staff rows"
    )
    print(f"    spared by id in {', '.join(SPARED_BY_UID)} and in Firebase Auth")
    print()

    # ── count first, delete second ───────────────────────────────────────────
    print("  WOULD REMOVE")
    total = 0

    fs_targets = list(DATA_COLLECTIONS) + (
        list(CONFIG_COLLECTIONS) if args.include_config else []
    )
    for name in fs_targets:
        n = _count(name)
        if name in SPARED_BY_UID:
            # An approximation, and it can only under-report: it assumes every
            # spared uid has a document in this collection. That is the safe
            # direction for a figure the operator is about to type back as a
            # confirmation — it never claims something will survive that will
            # not.
            n = max(0, n - len(keep_uids))
        if n:
            total += n
            print(f"    firestore  {name:<24} {n:>7,}")

    for name in MONGO_COLLECTIONS:
        n = await db[name].count_documents({})
        if n:
            total += n
            print(f"    mongo      {name:<24} {n:>7,}")

    staff_doomed = await db[C.STAFF].count_documents(_doomed_staff(protected, keep_uids))
    if staff_doomed:
        total += staff_doomed
        print(f"    mongo      {'staff (non-owner)':<24} {staff_doomed:>7,}")

    from firebase_admin import auth as fb_auth

    auth_doomed = sum(
        1 for u in fb_auth.list_users().iterate_all() if u.uid not in keep_uids
    )
    if auth_doomed:
        total += auth_doomed
        print(f"    auth       {'accounts':<24} {auth_doomed:>7,}")

    print(f"    {'':<11}{'':<24} {'-' * 7}")
    print(f"    {'TOTAL':<11}{'':<24} {total:>7,}")
    print()

    if total == 0:
        print("  Nothing to remove.")
        print()
        await mongo.disconnect()
        return 0

    if not args.confirm:
        print("  DRY RUN — re-run with --confirm to apply.")
        print()
        await mongo.disconnect()
        return 0

    # Friction on purpose. This cannot be undone, and `--confirm` on its own is
    # one shell-history arrow-up away from being run by accident.
    print(f"  This will permanently delete {total:,} record(s).")
    try:
        typed = input(f"  Type {total} to continue, or anything else to stop: ").strip()
    except (EOFError, KeyboardInterrupt):
        typed = ""
    if typed != str(total):
        print("\n  Stopped. Nothing was written.\n")
        await mongo.disconnect()
        return 1

    # ── apply ────────────────────────────────────────────────────────────────
    print()
    print("  Applying…")
    print()

    for name in MONGO_COLLECTIONS:
        res = await db[name].delete_many({})
        if res.deleted_count:
            print(f"    mongo      {name:<24} {res.deleted_count:>7,}")

    res = await db[C.STAFF].delete_many(_doomed_staff(protected, keep_uids))
    if res.deleted_count:
        print(f"    mongo      {'staff (non-owner)':<24} {res.deleted_count:>7,}")

    for name in fs_targets:
        spare = keep_uids if name in SPARED_BY_UID else set()
        n = _clear(name, spare)
        if n:
            print(f"    firestore  {name:<24} {n:>7,}")

    n = _delete_auth_except(keep_uids)
    if n:
        print(f"    auth       {'accounts':<24} {n:>7,}")

    print()
    print("  Done.")
    print()
    print("  Sign out and back in before retesting — the CRM caches the login")
    print("  record, so an open tab is still holding one that no longer exists.")
    if not args.include_config:
        print()
        print("  Your setup is untouched: rates, gifts, bag items, packs and the")
        print("  bank details a seller pays into are all still there.")
    print()
    await mongo.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
