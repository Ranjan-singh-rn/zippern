"""The four moderation operations, and the ways they used to be two and a half.

Suspend, Resume, Ban and Unban. They were not four: un-suspending was a call to
`unban_user`, the CRM could not put a term on a suspension, a ban reached one
handset chosen years earlier, and an unban deleted a `bannedDevices` record
whatever had caused it. Every one of those is a defect nobody could see from the
CRM, and every one of them is asserted here as a property rather than described.

What this file holds shut, in the order the sections run:

  * **a suspension bars no device.** That single fact is the whole difference
    between the two restrictions — a suspended person may sign in with another
    account on the same phone, a banned one may not — and `resolveIdentity` in
    the Cloud Functions enforces it from `isSuspended`. So suspending writes
    `accountState: 'suspended'` and touches `bannedDevices` not at all, and an
    existing device ban is still there afterwards.
  * **a suspension can have a term, from the user screen.** `POST
    /users/{uid}/suspend` took only a reason, so every suspension raised there
    was indefinite and the nightly sweep could never end one. Only the reports
    queue could set a duration.
  * **Resume is not Unban.** Two audit actions, two refusals, and the refusals
    name each other. Resuming a ban would make them aliases; unbanning a
    suspension would send the device-release path looking for records the
    suspension never created.
  * **Resume works on a stray suspension.** `unban_user` refused anything with
    `isBanned` false, so a suspension whose flag had come off could not be
    lifted by any endpoint at all and sat on the account for ever.
  * **a ban bars every device**, from `users/{uid}/devices`, falling back to the
    single stale `deviceId` only when there is nothing else.
  * **an unban is surgical.** It removes the account from `sourceAccounts` and
    deletes the record ONLY when nothing is holding it up — no other banned
    account, and no `manualBan`. An Ops ban placed on a handset's own evidence
    survives. This is the most important assertion in the file: the old code
    deleted that record unconditionally, so a device Ops had barred came back
    the first time anybody near it was unbanned.
  * **the sweep resumes rather than unbans**, and its actor is a uid the audit
    log will accept — it was plain `"system"`, which `audit._entry` refuses, so
    every lift the sweep has ever attempted raised inside `audit.record` and was
    swallowed into a `failed` list nobody reads.
  * **an appeal reverses the right thing.** Overturning a suspension resumes;
    overturning a ban unbans and says which handsets stayed barred.

No database and no network: `tests/harness.py` stubs the I/O and
`tests/fakes.py` provides the in-memory Firestore — including the write
sentinels, because `DELETE_FIELD` and `ArrayRemove` are load-bearing here and a
fake that stored them instead of applying them would prove nothing. Everything
under `app/` is the real, unmodified code.

Run:  python3 -m tests.test_moderation
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.routers import users as users_router  # noqa: E402
from app.services import appeals as appeals_svc  # noqa: E402
from app.services import users as svc  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def rejects(label: str, fn) -> str:
    """A moderation rule refused this through the route — a 400 with a message."""
    global checks
    checks += 1
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        if code == 400:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 400")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def refuses(label: str, fn) -> str:
    """The service refused this — a `UserError` with a message."""
    global checks
    checks += 1
    try:
        result = fn()
    except svc.UserError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted UserError")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def not_found(label: str, fn) -> str:
    """A subject that does not exist is a 404, not a rule refusing a 400.

    They are different answers to different questions and the CRM shows them
    differently: a mistyped uid is the caller's slip, a rule refusing is the
    system telling them something about the account.
    """
    global checks
    checks += 1
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        if code == 404:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 404")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def run(coro):
    return asyncio.run(coro)


# ══════════════════════════════════════════════════════════════════════════════
#  The world
# ══════════════════════════════════════════════════════════════════════════════
#
# Field names are the real ones. `users/{uid}/devices` is written by
# `rememberDevice` in `functions/src/identity.ts`; `bannedDevices/{id}` with
# `sourceAccounts` and `manualBan` is written by `barDevice` there and by
# `ban_device` here. Nothing below is a shape invented for the test.

NOW = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)

db = FakeDb()
audit_mod.get_db = lambda: db  # type: ignore[assignment]

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

# The device-listing and device-release failures are logged in full, which is
# right in production and is a stack trace in the middle of a test table here.
# Every refusal is asserted; nothing is read out of the log.
logging.getLogger("app.services.users").setLevel(logging.CRITICAL)


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team}


OPS = internal("uid-ops", Role.OPS_ADMIN, Team.OPS)
OWNER = internal("uid-owner", Role.OWNER)
SUPPORT = internal("uid-support", Role.SUPPORT_ADMIN, Team.SUPPORT)

WHY = "Selling contact details in the chat of three different rooms."
LIFT = "Reviewed the chat logs; the messages were from a spoofed name."


def user(uid: str, *, devices: tuple[str, ...] = (), **over) -> dict:
    """Seed one account, and the handsets it has signed in from."""
    doc = {
        "name": f"user {uid}",
        "isBanned": False,
        "isSuspended": False,
        "accountState": "active",
    }
    doc.update(over)
    fs.collection(svc.USERS).docs[uid] = dict(doc)
    for device_id in devices:
        fs.collection(svc.USERS).document(uid).collection(svc.DEVICES).docs[
            device_id
        ] = {"deviceId": device_id, "platform": "android"}
    return doc


def device_ban(device_id: str, **over) -> dict:
    doc = {
        "deviceId": device_id,
        "deviceType": "android_id",
        "reason": "seeded",
        "isActive": True,
        "sourceAccounts": [],
        "userUids": [],
    }
    doc.update(over)
    fs.collection(svc.BANNED_DEVICES).docs[device_id] = dict(doc)
    return doc


def stored(uid: str) -> dict:
    return fs.collection(svc.USERS).docs.get(uid, {})


def bans() -> dict[str, dict]:
    return fs.collection(svc.BANNED_DEVICES).docs


def entries(uid: str) -> list[dict]:
    return [d for d in db[C.AUDIT].docs if d["subject"]["id"] == uid]


def actions(uid: str) -> list[str]:
    return [d["action"] for d in entries(uid)]


def reason_body(text: str = WHY):
    return users_router.Reason(reason=text)


def suspend_body(text: str = WHY, days: int | None = None):
    return users_router.Suspend(reason=text, days=days)


# ══════════════════════════════════════════════════════════════════════════════
#  1. Suspend — an account, and never a device
# ══════════════════════════════════════════════════════════════════════════════

user("u-suspend", devices=("phone-a", "phone-b"))
# A device ban that has nothing to do with this account, on a handset it uses.
# Suspending must not so much as read it, and resuming must not delete it.
device_ban("phone-a", manualBan=True, reason="Device farm — Ops.")

result = run(users_router.suspend_user("u-suspend", suspend_body(days=7), OPS))

check("the account is suspended", stored("u-suspend")["accountState"], "suspended")
check("…and flagged for the CRM", stored("u-suspend")["isSuspended"], True)
check(
    "…and shut out of the app, because the app has one gate",
    stored("u-suspend")["isBanned"],
    True,
)
check("…with the reason the app shows", stored("u-suspend")["banReason"], WHY)
check("…and a term", stored("u-suspend")["suspensionDays"], 7)
ok("…with an end date", stored("u-suspend").get("suspendedUntil") is not None)

# The actor fields say SUSPENDED, not BANNED. They used to say banned, so the
# document could not tell a three-day suspension from a permanent ban and the
# app showed the permanent-ban screen to people who had been suspended.
check("…attributed to whoever suspended them", stored("u-suspend")["suspendedBy"], "uid-ops")
ok("…and not stamped as a ban", "bannedBy" not in stored("u-suspend"))

# The whole of the difference between the two restrictions.
check("NO device was barred", sorted(bans()), ["phone-a"])
check("…and the one that was already barred is untouched", bans()["phone-a"]["sourceAccounts"], [])
check("…still Ops' own", bans()["phone-a"]["manualBan"], True)
ok("…and no device audit entry was written", not any(
    d["subject"]["type"] == "device" for d in db[C.AUDIT].docs
))

log = entries("u-suspend")
check("exactly one audit entry", len(log), 1)
check("…as its own action", log[0]["action"], "user.suspended")
check("…carrying the reason verbatim", log[0]["reason"], WHY)
check("…naming the actor", log[0]["actor"]["uid"], "uid-ops")
check("…with the term on it", log[0]["meta"]["days"], 7)
check(
    "…and the device list, stated as empty rather than omitted",
    log[0]["meta"]["affectedDeviceIds"],
    [],
)
check("…which is what a suspension means", log[0]["meta"]["devices_barred"], 0)
check("…and says the sweep will lift it", log[0]["meta"]["lifted_by"], "scheduled sweep")
ok("the response says no device was barred", "No device was barred" in result["note"])


# ── The term comes through the ROUTE, which is what was missing ──────────────
#
# `POST /users/{uid}/suspend` took a reason and nothing else, so every
# suspension raised from the user screen was indefinite and
# `lift_expired_suspensions` could not fire for one. Only the reports queue
# could set a duration, which meant the length of a suspension depended on which
# screen the reviewer happened to be looking at.

user("u-indefinite")
run(users_router.suspend_user("u-indefinite", suspend_body(), OPS))
ok(
    "omitting the term gives an indefinite suspension",
    "suspendedUntil" not in stored("u-indefinite"),
)
check(
    "…and the entry says a human ends it",
    entries("u-indefinite")[0]["meta"]["lifted_by"],
    "manual resume",
)

# Re-suspending indefinitely must clear a date left by an earlier timed one, or
# the sweep would end the new suspension on the old schedule.
user("u-retimed", suspendedUntil=NOW - timedelta(days=1), suspensionDays=3)
run(users_router.suspend_user("u-retimed", suspend_body(), OPS))
ok(
    "an indefinite suspension clears a stale end date",
    "suspendedUntil" not in stored("u-retimed"),
)

user("u-bounds")
for bad_days in (0, -3, 366, 4000):
    message = rejects(
        f"a suspension of {bad_days} days",
        lambda d=bad_days: run(
            users_router.suspend_user("u-bounds", suspend_body(days=d), OPS)
        ),
    )
    ok(f"…and says what the range is for {bad_days}", "1 to 365" in message)
check("…and the account is untouched", stored("u-bounds")["accountState"], "active")

for bad_reason in ("", "  ", "no"):
    rejects(
        f"suspending with the reason {bad_reason!r}",
        lambda r=bad_reason: run(
            users_router.suspend_user("u-bounds", suspend_body(r), OPS)
        ),
    )
check("…and still untouched", stored("u-bounds")["accountState"], "active")
check("…with nothing audited", entries("u-bounds"), [])


# ══════════════════════════════════════════════════════════════════════════════
#  2. Resume — its own operation, its own audit action, no device path
# ══════════════════════════════════════════════════════════════════════════════

resumed = run(users_router.resume_user("u-suspend", reason_body(LIFT), OWNER))

check("the account is active again", stored("u-suspend")["accountState"], "active")
check("…not suspended", stored("u-suspend")["isSuspended"], False)
check("…and not shut out", stored("u-suspend")["isBanned"], False)
check("…the reason is kept as history", stored("u-suspend")["previousBanReason"], WHY)
check("…and cleared from the live field", stored("u-suspend")["banReason"], "")
ok("the end date goes with it", "suspendedUntil" not in stored("u-suspend"))
ok("…and so does the term", "suspensionDays" not in stored("u-suspend"))
check("…attributed to whoever resumed them", stored("u-suspend")["resumedBy"], "uid-owner")

check(
    "it is audited as a RESUME, not as an unban",
    actions("u-suspend"),
    ["user.suspended", "user.resumed"],
)
check(
    "…with the reason it was lifted for",
    entries("u-suspend")[-1]["reason"],
    LIFT,
)
check(
    "…and the original suspension reason, so a repeat is not read as a first offence",
    entries("u-suspend")[-1]["meta"]["original_suspension_reason"],
    WHY,
)
check(
    "…asserting that it reached no handset",
    entries("u-suspend")[-1]["meta"]["affectedDeviceIds"],
    [],
)

# THE defect this whole split exists for. Resuming used to be unbanning, and
# unbanning deleted `bannedDevices/{deviceId}` unconditionally — so lifting a
# three-day suspension released a handset Ops had barred as a device farm.
check("Ops' device ban is still there", sorted(bans()), ["phone-a"])
check("…still marked as theirs", bans()["phone-a"]["manualBan"], True)
check("…with its own reason intact", bans()["phone-a"]["reason"], "Device farm — Ops.")
ok(
    "the response says so rather than implying a clean sweep",
    "No device ban was touched" in resumed["note"],
)

# Resuming somebody who is not suspended writes nothing. A resume stamped on an
# active account puts a line in their history saying a restriction was lifted
# that never existed.
message = rejects(
    "resuming an account under no restriction",
    lambda: run(users_router.resume_user("u-suspend", reason_body(LIFT), OPS)),
)
check("…and is told plainly", message, "This account is not suspended.")
check("…with nothing written", len(actions("u-suspend")), 2)

check(
    "resuming an account that does not exist is a 404, not a rule",
    not_found(
        "resuming an account that does not exist",
        lambda: run(users_router.resume_user("nobody", reason_body(LIFT), OPS)),
    ),
    "User not found.",
)
for bad_reason in ("", "x"):
    rejects(
        f"resuming with the reason {bad_reason!r}",
        lambda r=bad_reason: run(
            users_router.resume_user("u-indefinite", reason_body(r), OPS)
        ),
    )
check("…and the suspension stands", stored("u-indefinite")["isSuspended"], True)


# ── A stray suspension. Defect 3, and it had no endpoint at all ──────────────
#
# `isSuspended` was client-writable until recently, so an account could end up
# suspended with `isBanned` false. `unban_user` refused anything with `isBanned`
# false, so nothing could lift it: the CRM showed the account as suspended for
# ever and the sweep's query still found it every night.

user("u-stray", isSuspended=True, isBanned=False, banReason="Under review.")
check(
    "a stray suspension is still read as a suspension",
    svc.restriction_of(stored("u-stray")),
    "suspended",
)
run(users_router.resume_user("u-stray", reason_body(LIFT), OPS))
check("…and Resume lifts it", stored("u-stray")["isSuspended"], False)
check("…to active", stored("u-stray")["accountState"], "active")
check("…audited as a resume", actions("u-stray"), ["user.resumed"])

# And the same account read through a document written before `accountState`
# carried a moderation value at all.
check(
    "a legacy banned document is read as banned",
    svc.restriction_of({"isBanned": True}),
    "banned",
)
check(
    "a legacy suspended document is read as suspended, whatever isBanned says",
    svc.restriction_of({"isBanned": True, "isSuspended": True}),
    "suspended",
)
check("an ordinary account is under no restriction", svc.restriction_of({}), "")
check(
    "…and a DELETED account is not a restriction either",
    svc.restriction_of({"accountState": "recovery_pending", "isDeleted": True}),
    "",
)


# ══════════════════════════════════════════════════════════════════════════════
#  3. Ban — the account, and EVERY handset it has been seen on
# ══════════════════════════════════════════════════════════════════════════════

user("u-ban", devices=("dev-1", "dev-2", "dev-3"), deviceId="dev-stale")
banned = run(users_router.ban_user("u-ban", reason_body(), OPS))

check("the account is banned", stored("u-ban")["accountState"], "banned")
check("…and shut out", stored("u-ban")["isBanned"], True)
check(
    "…and NOT flagged as suspended, so the sweep can never resume a ban",
    stored("u-ban")["isSuspended"],
    False,
)
check("…stamped as a ban", stored("u-ban")["bannedBy"], "uid-ops")

check(
    "every device the account has signed in from is barred",
    sorted(d for d in bans() if d.startswith("dev-")),
    ["dev-1", "dev-2", "dev-3", "dev-stale"],
)
for device_id in ("dev-1", "dev-2", "dev-3"):
    check(
        f"…and {device_id} records what caused it",
        bans()[device_id]["sourceAccounts"],
        ["u-ban"],
    )
    check(
        f"…keeping the legacy field the CRM renders in step for {device_id}",
        bans()[device_id]["userUids"],
        ["u-ban"],
    )
    ok(
        f"…and {device_id} is not marked as an Ops ban",
        bans()[device_id].get("manualBan") is not True,
    )

log = [d for d in entries("u-ban") if d["action"] == "user.banned"]
check("one ban entry", len(log), 1)
check(
    "…naming every handset it reached",
    sorted(log[0]["meta"]["affectedDeviceIds"]),
    ["dev-1", "dev-2", "dev-3", "dev-stale"],
)
check("…and how many", log[0]["meta"]["devices_barred"], 4)
check("…with nothing having failed", log[0]["meta"]["device_failures"], [])
ok("…and each device ban is its own entry", len(
    [d for d in db[C.AUDIT].docs
     if d["action"] == "device.banned" and d["meta"].get("source_uid") == "u-ban"]
) == 4)
ok("the response counts the handsets rather than implying one", "4 handset(s)" in banned["note"])

# An account with no `devices` subcollection at all. The single stale field is
# the fallback and nothing else — better than no device ban, and the only thing
# there is for an account that has not signed in since the subcollection
# started being written.
user("u-old", deviceId="dev-old")
run(users_router.ban_user("u-old", reason_body(), OPS))
check("an old account falls back to the single stored device", "dev-old" in bans(), True)
check(
    "…and it is recorded as the cause",
    bans()["dev-old"]["sourceAccounts"],
    ["u-old"],
)

# And one with neither. The ACCOUNT ban still stands — a ban that rolled itself
# back because the second half had nothing to do would be far worse — and the
# response says plainly that the phone is not barred.
user("u-nodevice")
nodevice = run(users_router.ban_user("u-nodevice", reason_body(), OPS))
check("an account with no device is still banned", stored("u-nodevice")["isBanned"], True)
ok("…and the response says the handset is not barred", "no handset to bar" in nodevice["note"])
check(
    "…with an empty device list on the entry, not a missing one",
    [d for d in entries("u-nodevice") if d["action"] == "user.banned"][0]["meta"][
        "affectedDeviceIds"
    ],
    [],
)

# Banning somebody who is currently suspended must clear the suspension state,
# or the nightly sweep would find them, resume them, and undo the ban.
user("u-suspended-then-banned", isSuspended=True, accountState="suspended",
     suspendedUntil=NOW - timedelta(days=1), suspensionDays=2)
run(users_router.ban_user("u-suspended-then-banned", reason_body(), OWNER))
check(
    "banning a suspended account leaves it banned",
    stored("u-suspended-then-banned")["accountState"],
    "banned",
)
check(
    "…and not suspended, so the sweep cannot reach it",
    stored("u-suspended-then-banned")["isSuspended"],
    False,
)
ok(
    "…and the stale end date is gone with it",
    "suspendedUntil" not in stored("u-suspended-then-banned"),
)


# ══════════════════════════════════════════════════════════════════════════════
#  4. Unban — surgical, and this is the part that matters most
# ══════════════════════════════════════════════════════════════════════════════
#
# The old `unban_user` deleted `bannedDevices/{users/{uid}.deviceId}`
# unconditionally. Three things were wrong with that and each gets its own case
# below: it deleted a record a second banned account was still holding up, it
# deleted a record Ops had placed on their own authority, and it worked off a
# field that names one handset chosen at profile setup.

# `dev-2` is also held by a second banned account, and `dev-3` is an Ops ban
# that happened to land on a handset this person uses.
bans()["dev-2"]["sourceAccounts"].append("u-other-banned")
bans()["dev-2"]["userUids"].append("u-other-banned")
bans()["dev-3"]["manualBan"] = True

unbanned = run(users_router.unban_user("u-ban", reason_body(LIFT), OWNER))

check("the account is active again", stored("u-ban")["accountState"], "active")
check("…and not banned", stored("u-ban")["isBanned"], False)
check("…keeping why it was banned", stored("u-ban")["previousBanReason"], WHY)
check("…attributed to whoever lifted it", stored("u-ban")["unbannedBy"], "uid-owner")

check(
    "the handsets this ban alone was holding are released",
    sorted(unbanned["devices_released"]),
    ["dev-1", "dev-stale"],
)
ok("…and the records are actually gone", "dev-1" not in bans() and "dev-stale" not in bans())

kept = {k["device_id"]: k for k in unbanned["device_bans_kept"]}
check("…and two are kept", sorted(kept), ["dev-2", "dev-3"])
ok("dev-2 stays barred", "dev-2" in bans())
check(
    "…because another banned account is still on it",
    bans()["dev-2"]["sourceAccounts"],
    ["u-other-banned"],
)
ok(
    "…and the reason given is that one, not a shrug",
    "other banned account" in kept["dev-2"]["because"],
)
check("…and it is not called an Ops ban", kept["dev-2"]["manual_ban"], False)

ok("dev-3 stays barred", "dev-3" in bans())
check("…because Ops placed it themselves", kept["dev-3"]["manual_ban"], True)
check("…and this account came off it", bans()["dev-3"]["sourceAccounts"], [])
ok(
    "…and the record survives an empty source list because of the mark",
    bans()["dev-3"]["manualBan"] is True,
)
ok(
    "the response names the handsets that stay barred rather than reporting a clean unban",
    "dev-2" in unbanned["note"] and "dev-3" in unbanned["note"],
)
ok("…and says they will still block this account", "still block" in unbanned["note"])

log = [d for d in entries("u-ban") if d["action"] == "user.unbanned"]
check("one unban entry", len(log), 1)
check(
    "…naming what it released",
    sorted(log[0]["meta"]["affectedDeviceIds"]),
    ["dev-1", "dev-stale"],
)
check(
    "…and what it deliberately did not",
    sorted(k["device_id"] for k in log[0]["meta"]["device_bans_kept"]),
    ["dev-2", "dev-3"],
)

# A device ban that stayed in force is audited as a change, not as a release, so
# the log cannot be read as "this handset was let back in".
kept_entries = [
    d for d in db[C.AUDIT].docs
    if d["subject"]["id"] == "dev-3" and d["action"] == "device.unbanned"
]
check("the kept record has an entry of its own", len(kept_entries), 1)
check("…saying it was not released", kept_entries[-1]["meta"]["released"], False)
check("…and why", kept_entries[-1]["meta"]["kept_because_manual"], True)
ok("…with the ban stated as standing", "STAYS IN FORCE" in kept_entries[-1]["reason"])


# ── The two refusals that keep the pairs apart ───────────────────────────────

user("u-pairs", isSuspended=True, isBanned=True, accountState="suspended")
message = rejects(
    "unbanning a SUSPENDED account",
    lambda: run(users_router.unban_user("u-pairs", reason_body(LIFT), OPS)),
)
ok("…and it names the operation that does work", "Use Resume" in message)
ok("…and says why it matters", "device ban" in message)
check("…with the suspension untouched", stored("u-pairs")["isSuspended"], True)
check("…and nothing audited", entries("u-pairs"), [])

user("u-pairs-2", isBanned=True, accountState="banned", banReason=WHY)
message = rejects(
    "resuming a BANNED account",
    lambda: run(users_router.resume_user("u-pairs-2", reason_body(LIFT), OPS)),
)
check(
    "…and it names the operation that does work",
    message,
    "This account is banned, not suspended. Use Unban — it lifts the ban and "
    "the device bans that came with it.",
)
check("…with the ban untouched", stored("u-pairs-2")["isBanned"], True)
check("…and nothing audited", entries("u-pairs-2"), [])

message = rejects(
    "unbanning an account under no restriction",
    lambda: run(users_router.unban_user("u-stray", reason_body(LIFT), OPS)),
)
check("…and is told plainly", message, "This account is not banned.")

# The four actions are four distinct strings. They were three, because
# un-suspending wrote `user.unbanned`.
check(
    "the four operations are four audit actions",
    sorted({
        audit_mod.Action.USER_SUSPENDED,
        audit_mod.Action.USER_RESUMED,
        audit_mod.Action.USER_BANNED,
        audit_mod.Action.USER_UNBANNED,
    }),
    ["user.banned", "user.resumed", "user.suspended", "user.unbanned"],
)
ok(
    "…and `users.py` no longer declares a second Action enumeration beside audit's",
    not hasattr(svc, "Action"),
)


# ══════════════════════════════════════════════════════════════════════════════
#  5. Device bans placed by Ops, and the mark that keeps them alive
# ══════════════════════════════════════════════════════════════════════════════

ops_ban = run(
    users_router.ban_device(
        users_router.DeviceBan(
            device_id="dev-farm",
            device_type=svc.DeviceType.ANDROID_ID,
            reason="Twenty accounts in a week from one handset.",
            user_uids=["u-seen-1", "u-seen-2"],
            manual=True,
        ),
        OPS,
    )
)
check("an Ops ban is marked as one", bans()["dev-farm"]["manualBan"], True)
check(
    "…and the accounts seen on it are recorded",
    sorted(bans()["dev-farm"]["sourceAccounts"]),
    ["u-seen-1", "u-seen-2"],
)
check("…and audited as an Ops decision", ops_ban["audit_id"] != "", True)
check(
    "…which the entry says in words",
    [d for d in db[C.AUDIT].docs if d["subject"]["id"] == "dev-farm"][-1]["meta"]["source"],
    "ops",
)

# Unbanning one of the accounts named on it must NOT delete it. This is the
# exact case the old code got wrong.
user("u-seen-1", isBanned=True, accountState="banned", deviceId="dev-farm")
run(users_router.unban_user("u-seen-1", reason_body(LIFT), OWNER))
ok("unbanning an account named on an Ops ban leaves it in force", "dev-farm" in bans())
check("…with that account removed from it", bans()["dev-farm"]["sourceAccounts"], ["u-seen-2"])
check("…and still marked as Ops'", bans()["dev-farm"]["manualBan"], True)

# A cascade landing on a handset Ops already barred must not downgrade the mark.
user("u-cascade", devices=("dev-farm",))
run(users_router.ban_user("u-cascade", reason_body(), OPS))
check("a cascade onto an Ops ban keeps the mark", bans()["dev-farm"]["manualBan"], True)
check(
    "…and accumulates rather than overwriting",
    sorted(bans()["dev-farm"]["sourceAccounts"]),
    ["u-cascade", "u-seen-2"],
)
run(users_router.unban_user("u-cascade", reason_body(LIFT), OWNER))
ok("…and unbanning it again leaves the Ops ban standing", "dev-farm" in bans())

# The direct device-unban endpoint is the one place an override is right: a
# person looking at the device list, deciding about the handset itself.
run(users_router.unban_device("dev-farm", reason_body("Handset was resold; new owner."), OWNER))
ok("Ops can still lift their own device ban outright", "dev-farm" not in bans())
last = [d for d in db[C.AUDIT].docs if d["subject"]["id"] == "dev-farm"][-1]
check("…and the entry records what it overrode", last["meta"]["was_manual_ban"], True)
check("…including who was still on it", last["meta"]["source_accounts"], ["u-seen-2"])


# ══════════════════════════════════════════════════════════════════════════════
#  6. The nightly sweep
# ══════════════════════════════════════════════════════════════════════════════
#
# Two things were wrong with it and neither was visible: it called `unban_user`,
# and its actor was a uid `audit._entry` refuses. The second meant every lift it
# has ever attempted raised inside `audit.record` and was collected into a
# `failed` list nobody reads — so the sweep has never actually ended a
# suspension, while looking exactly like a sweep that found nothing to do.
#
# The actor is read out of `scheduling.py` itself rather than written here, so
# this stays true if somebody changes it.

SCHEDULING = (ROOT / "app" / "services" / "scheduling.py").read_text()
tail = SCHEDULING.split("lift_expired_suspensions(", 1)[1][:1200]
found = re.search(r'"uid":\s*"([^"]+)"', tail)
SWEEP_UID = found.group(1) if found else ""

ok("the daily run passes an actor to the sweep", bool(SWEEP_UID))
ok(
    "…and it is a machine uid the audit log will accept",
    SWEEP_UID.startswith(audit_mod.SYSTEM_UID_PREFIX),
)
SWEEP = {"uid": SWEEP_UID, "name": "Scheduled job", "role": "system"}

# Plain "system" is what was there, and it is refused — asserted rather than
# described, so the fix cannot be undone without this failing.
#
# Note what the failure actually leaves behind, because it is the reason this
# mattered so much: every operation in this module writes the account and THEN
# audits it, so a refused audit entry leaves the suspension lifted with no
# record of who or what lifted it. A sweep that "found nothing to do" every
# night was in fact resuming people into an empty log.
user("u-broken-actor", isSuspended=True, isBanned=True, accountState="suspended",
     banReason=WHY, suspendedUntil=datetime.now(timezone.utc) - timedelta(hours=3),
     suspensionDays=3)
broken = run(
    svc.lift_expired_suspensions(
        {"uid": "system", "name": "Scheduled job", "role": "system"}
    )
)
check("a machine actor without the prefix lifts nothing", broken["lifted"], [])
check("…and the failure is reported rather than swallowed", len(broken["failed"]), 1)
check("…naming the account", broken["failed"][0]["uid"], "u-broken-actor")
ok(
    "…and the rule that refused it",
    "system:" in broken["failed"][0]["error"],
)
check("…with nothing whatever in the audit log", entries("u-broken-actor"), [])

# The real actor, and the real sweep.
user("u-expired", isSuspended=True, isBanned=True, accountState="suspended",
     banReason=WHY, suspendedUntil=datetime.now(timezone.utc) - timedelta(hours=2),
     suspensionDays=3)
user("u-untimed", isSuspended=True, isBanned=True, accountState="suspended")
user("u-future", isSuspended=True, isBanned=True, accountState="suspended",
     suspendedUntil=datetime.now(timezone.utc) + timedelta(days=5), suspensionDays=5)
device_ban("dev-sweep", manualBan=True, reason="Unrelated Ops ban.")

swept = run(svc.lift_expired_suspensions(SWEEP))

check("the expired suspension is lifted", swept["lifted"], ["u-expired"])
check("…and nothing failed", swept["failed"], [])
check("…the account is active", stored("u-expired")["accountState"], "active")
ok("…its end date is gone", "suspendedUntil" not in stored("u-expired"))
check(
    "…and it is audited as a resume, not as an unban",
    actions("u-expired"),
    ["user.resumed"],
)
check(
    "…by a machine, legibly",
    entries("u-expired")[-1]["actor"]["is_system"],
    True,
)
check(
    "…saying what lifted it",
    entries("u-expired")[-1]["meta"]["lifted_by"],
    "scheduled sweep",
)
check("…with the reason on the entry", entries("u-expired")[-1]["reason"], "Suspension period ended.")

check("an indefinite suspension is never swept", stored("u-untimed")["isSuspended"], True)
check("…and audited not at all", entries("u-untimed"), [])
check("a suspension still running is left alone", stored("u-future")["isSuspended"], True)
ok("and the sweep touched no device ban", "dev-sweep" in bans())

# Running it again finds nothing — the account is out of the query because the
# schedule really was cleared, not merely flagged.
again = run(svc.lift_expired_suspensions(SWEEP))
check("a second run has nothing to do", again["lifted"], [])
check("…and does not re-audit", len(actions("u-expired")), 1)


# ══════════════════════════════════════════════════════════════════════════════
#  7. Appeals reverse the right thing
# ══════════════════════════════════════════════════════════════════════════════
#
# `decide_appeal` called `unban_user` for both kinds, on the reasoning that a
# suspension IS a ban with a flag. True of the account fields and false of
# everything else: overturning a suspension went on to delete a device ban the
# suspension had never created.

APPEAL_REASON = "The chat logs show a different host; this was the wrong account."


def appeal(appeal_id: str, subject_uid: str, **over) -> None:
    doc = {
        "kind": "ban",
        "status": "pending",
        "subjectUid": subject_uid,
        "raisedByUid": subject_uid,
        "createdAt": NOW,
    }
    doc.update(over)
    fs.collection(appeals_svc.APPEALS).docs[appeal_id] = doc


user("u-appeal-susp", isSuspended=True, isBanned=True, accountState="suspended",
     banReason=WHY, devices=("dev-appeal",))
device_ban("dev-appeal", manualBan=True, reason="Ops: shared handset at a cafe.")
appeal("appeal-susp", "u-appeal-susp")

decided = run(appeals_svc.decide_appeal("appeal-susp", "overturned", APPEAL_REASON, OPS))
check("an overturned suspension is resumed", stored("u-appeal-susp")["accountState"], "active")
check("…and audited as a resume", "user.resumed" in actions("u-appeal-susp"), True)
ok("…never as an unban", "user.unbanned" not in actions("u-appeal-susp"))
ok("the unrelated Ops device ban survives the overturn", "dev-appeal" in bans())
ok(
    "…and the response says no device was touched",
    any("No device ban was touched" in r for r in decided["reversed"]),
)

user("u-appeal-ban", isBanned=True, accountState="banned", banReason=WHY,
     devices=("dev-ap-1", "dev-ap-2"))
device_ban("dev-ap-1", sourceAccounts=["u-appeal-ban"], userUids=["u-appeal-ban"])
device_ban("dev-ap-2", sourceAccounts=["u-appeal-ban", "u-somebody-else"],
           userUids=["u-appeal-ban", "u-somebody-else"])
appeal("appeal-ban", "u-appeal-ban")

decided = run(appeals_svc.decide_appeal("appeal-ban", "overturned", APPEAL_REASON, OWNER))
check("an overturned ban is unbanned", stored("u-appeal-ban")["accountState"], "active")
check("…and audited as an unban", "user.unbanned" in actions("u-appeal-ban"), True)
ok("…the handset it alone held is released", "dev-ap-1" not in bans())
ok("…and the one somebody else holds is not", "dev-ap-2" in bans())
ok(
    "…with the appellant told which handset still blocks them",
    any("dev-ap-2" in o for o in decided["outstanding"]),
)
ok(
    "…and told what WAS released",
    any("released with it" in r for r in decided["reversed"]),
)

user("u-appeal-clean")
appeal("appeal-clean", "u-appeal-clean")
decided = run(appeals_svc.decide_appeal("appeal-clean", "overturned", APPEAL_REASON, OPS))
ok(
    "an appeal about an unrestricted account says so rather than writing anything",
    any("no restriction" in r for r in decided["reversed"]),
)
check("…and nothing was written to the account", stored("u-appeal-clean")["accountState"], "active")


# ══════════════════════════════════════════════════════════════════════════════
#  8. Every one of the four is audited with a named actor and a reason
# ══════════════════════════════════════════════════════════════════════════════

MODERATION = {"user.suspended", "user.resumed", "user.banned", "user.unbanned"}
moderation_entries = [d for d in db[C.AUDIT].docs if d["action"] in MODERATION]
ok("there are moderation entries to check", len(moderation_entries) >= 8)
for entry in moderation_entries:
    ok(
        f"{entry['action']} on {entry['subject']['id']} names an actor",
        bool(entry["actor"]["uid"]) and bool(entry["actor"]["name"]),
    )
    ok(
        f"{entry['action']} on {entry['subject']['id']} carries a reason",
        bool((entry["reason"] or "").strip()),
    )
    ok(
        f"{entry['action']} on {entry['subject']['id']} records the devices it reached",
        "affectedDeviceIds" in entry["meta"],
    )
    ok(
        f"{entry['action']} on {entry['subject']['id']} is against the user",
        entry["subject"]["type"] == "user",
    )

# A suspension and a resume reach no handset; a ban and an unban may. Stated as
# a property over every entry rather than case by case, so a change that made
# resume touch a device would fail here whatever route introduced it.
for entry in moderation_entries:
    if entry["action"] in ("user.suspended", "user.resumed"):
        ok(
            f"{entry['action']} on {entry['subject']['id']} barred and released nothing",
            entry["meta"]["affectedDeviceIds"] == [],
        )

# Support can moderate — `require_write` admits every internal role — which is
# asserted so the four routes are not accidentally read as Ops-only.
user("u-support")
run(users_router.suspend_user("u-support", suspend_body(days=1), SUPPORT))
check("a support admin may suspend", stored("u-support")["isSuspended"], True)
check("…attributed to them", entries("u-support")[0]["actor"]["uid"], "uid-support")


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} moderation checks passed.")
print("  · a suspension restricts the account and bars NO device, so another")
print("    account may be used on the same phone — and an unrelated Ops device")
print("    ban is still there afterwards")
print("  · a suspension can carry a term from the user screen, which it could")
print("    not before: every one raised there was indefinite and unsweepable")
print("  · Resume is its own operation with its own audit action; it refuses a")
print("    banned account by name, and Unban refuses a suspended one")
print("  · Resume lifts a stray suspension with isBanned false, which no")
print("    endpoint could do at all")
print("  · a ban bars every device in users/{uid}/devices, falling back to the")
print("    single stale deviceId only when there is nothing else")
print("  · an unban removes the account from sourceAccounts and deletes the")
print("    record only when nothing holds it up — an Ops manualBan and a second")
print("    banned account each keep a handset barred, and the caller is told")
print("  · the nightly sweep resumes rather than unbans, and its actor is a")
print("    system: uid the audit log accepts — the old one was refused by")
print("    audit._entry on every single lift")
print("  · an overturned appeal resumes a suspension and unbans a ban, and says")
print("    which handsets stayed barred either way")
sys.exit(0)
