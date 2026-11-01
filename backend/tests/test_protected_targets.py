"""An internal identity cannot be moderated through ordinary user management.

── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────

An Owner who has also signed into the Android app has a `users/{uid}`
document like anybody else. The CRM's `/users` pages that collection with no
staff exclusion, so all three production Owners appeared in the list with
Ban, Suspend, Grant host and Make seller beside their names — and nothing in
the backend refused. `ban_user` loaded the document and patched it.

The only accidental protection was that an Owner who had never opened the app
had no document to load. `scripts/inspect_identity` showed that all three
Owners have one.

Nor was there any self-target rule: the single `uid == actor["uid"]` check in
the whole API was `staff.deactivate`'s, covering one function.

── WHAT IS REAL HERE ────────────────────────────────────────────────────────

REAL: `app.services.users`, imported and called — the guard, and the nine
      service functions it is wired into.
FAKE: Firestore (`tests/fakes.FakeFirestore`) and Mongo (`harness.FakeDb`).

The three Owner uids below are the real production ones, used as FIXTURE
IDENTIFIERS only. Nothing here touches production: every read and write in
this file lands in an in-memory fake.

    python3 -m tests.test_protected_targets
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import users as svc  # noqa: E402

checks = 0
failures = 0


def ok(claim: str, cond: bool) -> None:
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
        print(f"  FAIL  {claim}")


# ── The real production identities, as fixtures ─────────────────────────────
OWNER_A = "q3htaaXWj4bTXpVKIl02vWgAwtI2"   # soumyaranjan.singh7@gmail.com
OWNER_B = "XIWhltIc91h35xRkxySpdmhFzb12"   # tanishque50@gmail.com
OWNER_C = "KVGmKZCzKsWj3osAFdo7KlWjJ6d2"   # baapaadmi0101@gmail.com
OWNERS = {
    OWNER_A: "soumyaranjan.singh7@gmail.com",
    OWNER_B: "tanishque50@gmail.com",
    OWNER_C: "baapaadmi0101@gmail.com",
}
APP_ADMIN = "T7XT5mvZHKbo3nd6zU0eBvFRSBu2"      # loolipop0101@gmail.com
OBSERVER_UID = "observer:314zipper@gmail.com"   # synthetic — no Firebase account
ORDINARY = "ordinary_app_user_uid"
HOST = "ordinary_host_uid"

fs = FakeFirestore()
db = FakeDb()
firebase_mod.firestore_client = lambda: fs
audit_mod.get_db = lambda: db
svc.get_db = lambda: db

run = asyncio.get_event_loop().run_until_complete


async def _seed() -> None:
    # Mongo staff — the authority. Note the Observer's SYNTHETIC uid.
    for uid, email in OWNERS.items():
        await db[C.STAFF].insert_one(
            {"uid": uid, "email": email, "role": str(Role.OWNER), "is_active": True}
        )
    await db[C.STAFF].insert_one({
        "uid": APP_ADMIN, "email": "loolipop0101@gmail.com",
        "role": str(Role.APP_ADMIN), "is_active": True,
    })
    await db[C.STAFF].insert_one({
        "uid": OBSERVER_UID, "email": "314zipper@gmail.com",
        "role": str(Role.OBSERVER), "is_active": True,
    })

    # Firestore app documents. All three Owners have one — that is the whole
    # problem, and it is production fact, not a contrivance.
    for uid, email in OWNERS.items():
        fs.collection("users").document(uid).set(
            {"name": "Owner", "email": email, "isBanned": False, "isSuspended": False}
        )
    fs.collection("users").document(APP_ADMIN).set(
        {"name": "App Admin", "email": "loolipop0101@gmail.com", "isBanned": False}
    )
    fs.collection("users").document(ORDINARY).set(
        {"name": "Ordinary", "email": "nobody@example.com", "isBanned": False}
    )
    fs.collection("users").document(HOST).set(
        {"name": "A Host", "email": "host@example.com", "isBanned": False, "isHost": True}
    )


run(_seed())

ACTOR = {"uid": OWNER_A, "role": str(Role.OWNER), "name": "Owner A", "team": "governance"}


def denied(claim: str, coro) -> None:
    """The call must raise ProtectedTarget — not merely fail some other way."""
    global checks, failures
    checks += 1
    try:
        run(coro)
    except svc.ProtectedTarget:
        return
    except Exception as exc:  # noqa: BLE001
        failures += 1
        print(f"  FAIL  {claim}\n        refused, but with {type(exc).__name__}: {exc}")
        return
    failures += 1
    print(f"  FAIL  {claim}\n        THE CALL SUCCEEDED")


def allowed(claim: str, coro) -> None:
    global checks, failures
    checks += 1
    try:
        run(coro)
    except svc.ProtectedTarget as exc:
        failures += 1
        print(f"  FAIL  {claim}\n        wrongly refused: {exc}")
    except Exception:  # noqa: BLE001
        # Some of these need more of the world than this file builds. What is
        # being asserted is only that the TARGET POLICY did not refuse them.
        pass


R = "A reason long enough to pass validation."


def every_action(target: str):
    """The ten ordinary user-management operations, against one subject."""
    return [
        ("ban", svc.ban_user(target, R, ACTOR)),
        ("unban", svc.unban_user(target, R, ACTOR)),
        ("suspend", svc.suspend_user(target, R, ACTOR, days=3)),
        ("resume", svc.resume_user(target, R, ACTOR)),
        ("warn", svc.warn_user(target, R, ACTOR)),
        ("grant_host", svc.grant_host(target, "", R, ACTOR)),
        ("revoke_host", svc.revoke_host(target, R, ACTOR)),
        ("seller_on", svc.set_seller_flag(target, True, R, ACTOR)),
        ("seller_off", svc.set_seller_flag(target, False, R, ACTOR)),
        ("balance", svc.request_balance_change(target, svc.Currency.DIAMONDS, 100, R, ACTOR)),
    ]


# ── 1. Owner → own uid ──────────────────────────────────────────────────────
print("\n1. An Owner cannot target their own account")
for name, coro in every_action(OWNER_A):
    denied(f"self {name} is denied", coro)

# ── 2. Owner → another Owner ────────────────────────────────────────────────
print("2. An Owner cannot target another Owner through /users")
for name, coro in every_action(OWNER_B):
    denied(f"Owner B {name} is denied", coro)
for name, coro in every_action(OWNER_C):
    denied(f"Owner C {name} is denied", coro)

# ── 3. Owner → Observer and department staff ────────────────────────────────
print("3. Nor the Observer, nor department staff")
for name, coro in every_action(APP_ADMIN):
    denied(f"app_admin {name} is denied", coro)

# ── The Observer, and why email is NOT matched ──────────────────────────────
#
# The Observer's staff row carries a synthetic uid, so a uid lookup cannot
# find it. An earlier guard also matched the subject's EMAIL for that reason.
# This asserts the opposite, because the email branch was wrong:
#
# The Observer has NO Firebase account, so `314zipper@gmail.com` is unclaimed
# and anybody could register it. The resulting app user is a STRANGER, not the
# Observer — `core/security.py` already refuses them an observer session — and
# an impostor must not inherit immunity the real Observer never needed.
#
# The real Observer is unreachable here regardless: `inspect_identity`
# confirms it has no `users/{uid}` document at all.
fs.collection("users").document("email_squatter").set(
    {"name": "?", "email": "314zipper@gmail.com", "isBanned": False}
)
allowed(
    "someone who registered the Observer's unclaimed address is an ordinary "
    "user and stays bannable — immunity does not follow an email string",
    svc.ban_user("email_squatter", R, ACTOR),
)
ok("and the real Observer has no app document to target",
   not fs.collection("users").document(OBSERVER_UID).get().exists)

# ── 4. Ordinary users are unaffected ────────────────────────────────────────
print("4. Ordinary subjects are untouched by the new rule")
for name, coro in every_action(ORDINARY):
    allowed(f"ordinary user {name} is not refused by target policy", coro)
for name, coro in every_action(HOST):
    allowed(f"ordinary host {name} is not refused by target policy", coro)

# ── 5. The guard reads Mongo, and only Mongo ────────────────────────────────
print("5. The authority is the Mongo staff row")

# A subject whose Firestore document CLAIMS to be staff, with no Mongo row.
# Believing the app document would be trusting client-reachable state.
fs.collection("users").document("pretender").set(
    {"name": "Pretender", "email": "pretender@example.com",
     "crmRole": "superadmin", "isOfficial": True, "isBanned": False}
)
allowed(
    "a users document claiming crmRole superadmin is NOT protected — "
    "the app document is not the authority",
    svc.ban_user("pretender", R, ACTOR),
)

# And the reverse: a Mongo row with no app document still protects the uid.
run(db[C.STAFF].insert_one(
    {"uid": "ghost_staff", "email": "ghost@example.com",
     "role": str(Role.FINANCE_ADMIN), "is_active": True}
))
denied("a staff row with no app document still protects the uid",
       svc.ban_user("ghost_staff", R, ACTOR))

# An unrecognised role in the staff collection fails CLOSED.
run(db[C.STAFF].insert_one(
    {"uid": "future_role", "email": "future@example.com",
     "role": "chief_vibes_officer", "is_active": True}
))
denied("an unrecognised staff role is treated as internal, not ignored",
       svc.ban_user("future_role", R, ACTOR))

# An EXTERNAL role on a staff row is not an internal identity.
run(db[C.STAFF].insert_one(
    {"uid": "partner_row", "email": "partner@example.com",
     "role": str(Role.AGENCY), "is_active": True}
))
fs.collection("users").document("partner_row").set(
    {"name": "Partner", "email": "partner@example.com", "isBanned": False}
)
allowed("an external role on a staff row is not protected",
        svc.ban_user("partner_row", R, ACTOR))

# ── 6. Automated restoration still works ────────────────────────────────────
print("6. The exempt paths are still open")

fs.collection("users").document(OWNER_B).set(
    {"name": "Owner B", "email": OWNERS[OWNER_B],
     "isSuspended": True, "isBanned": False, "accountState": "suspended"}
)
allowed(
    "the nightly sweep can still resume a protected account "
    "(enforce_target_policy=False)",
    svc.resume_user(OWNER_B, "Suspension period ended.", ACTOR,
                    enforce_target_policy=False),
)
allowed(
    "and an overturned appeal can still unban one",
    svc.unban_user(OWNER_B, "Appeal overturned.", ACTOR,
                   enforce_target_policy=False),
)

# ── 7. The guard itself, directly ───────────────────────────────────────────
print("7. ensure_ordinary_target, called directly")

for uid in OWNERS:
    row = run(svc.protected_staff_row(uid))
    ok(f"{uid[:12]}… resolves to a protected staff row", row is not None)
    ok(f"{uid[:12]}… is reported as owner", str((row or {}).get("role")) == "owner")

ok("an ordinary uid resolves to nothing",
   run(svc.protected_staff_row(ORDINARY)) is None)
ok("an empty uid resolves to nothing",
   run(svc.protected_staff_row("")) is None)
ok("the Observer's synthetic uid resolves when asked for directly",
   run(svc.protected_staff_row(OBSERVER_UID)) is not None)
ok("but an unrelated uid does not, whatever email it carries",
   run(svc.protected_staff_row("email_squatter")) is None)

# ── Result ──────────────────────────────────────────────────────────────────
# ── 9. An Ops device ban cannot bar a staff member's handset ────────────────
print("9. Ops device bans spare staff devices")
fs.collection("users").docs[OWNER_B] = {"name": "Owner B", "deviceId": "dev-owner-b"}
fs.collection("users").docs["u-plain-dev"] = {"name": "Plain", "deviceId": "dev-plain"}
denied("a manual ban NAMING an Owner is refused",
       svc.ban_device("dev-x", "android_id", R, [OWNER_B], ACTOR, manual=True))
denied("a manual ban of a device an Owner's profile records is refused, even unnamed",
       svc.ban_device("dev-owner-b", "android_id", R, [], ACTOR, manual=True))
ok("…nothing was written", "dev-owner-b" not in fs.collection("bannedDevices").docs)
allowed("an ordinary user's device can still be barred",
        svc.ban_device("dev-plain", "android_id", R, ["u-plain-dev"], ACTOR, manual=True))
ok("…and it was", "dev-plain" in fs.collection("bannedDevices").docs)

if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} protected-target checks passed.")
print("  · no Owner can ban, suspend, host-grant or seller-flag themselves")
print("  · nor any other Owner, the Observer, or department staff, via /users")
print("  · the authority is the Mongo staff row — never the app document")
print("  · the sweep and appeal overturn still restore a protected account\n")
