"""Ending a live stream, and muting a host. Spec 8.7.3 / 8.7.4.

`/live` has carried a disabled End button because no endpoint existed. Before
that there was something worse: the CRM wrote `isActive: false` onto the
Firestore room document from the browser — a change with no actor, no reason and
no audit entry, where the only evidence a stream had been cut was that it had
stopped. These tests cover the replacement.

What matters here is almost entirely the refusals, because the happy path is one
field on one document and the whole value of the endpoint is in what it will not
do:

  * a reason is mandatory and short ones do not count (8.7.4);
  * a room that does not exist, and a room that has already ended, are refused
    rather than answered "done" — a second press must not read as a second
    intervention;
  * ending a room is not a ban: the host's account is untouched;
  * only Ops and owners may do it. Everybody else who can *watch* /live —
    app, tech, support, finance, marketing — cannot cut a broadcast off, and the
    observer and every partner account are refused before that is even asked;
  * a Firestore write that fails leaves nothing recorded, so the audit log never
    describes an end that did not happen.

And mute, which this API can decide and **cannot enforce**: `hostMuted` is a
flag the Android app must honour. The endpoint says so in every response rather
than reporting success into a room that is still making noise.

No database and no network: `tests/harness.py` stubs the I/O and
`tests/fakes.py` provides the in-memory Firestore, so the code exercised is the
real `app/services/live.py` and the real routes in `app/routers/users.py`.

Run:  python3 -m tests.test_live_ops
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.routers import users as users_router  # noqa: E402
from app.services import live as live_svc  # noqa: E402

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


def refuses(label: str, factory) -> str:
    """This must be refused with a message, not quietly succeed."""
    global checks
    checks += 1
    try:
        result = asyncio.run(factory())
    except live_svc.LiveError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted LiveError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def forbids(label: str, fn) -> str:
    """This must be a 403, not an answer."""
    global checks
    checks += 1
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        if code == 403:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 403")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def rejects(label: str, fn) -> str:
    """A live-room rule refused this through the route — a 400 with a message."""
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


def run(coro):
    return asyncio.run(coro)


# ── The world ─────────────────────────────────────────────────────────────────

NOW = datetime(2026, 8, 24, 19, 30, tzinfo=timezone.utc)

db = FakeDb()
audit_mod.get_db = lambda: db

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs

# The messages logged when Firestore refuses are exactly right in production and
# are a stack trace in the middle of a test table here. The refusals themselves
# are asserted; nothing is read out of the log.
logging.getLogger("app.services.live").setLevel(logging.CRITICAL)


def room(room_id: str, **over) -> dict:
    doc = {
        "hostUid": "host-1",
        "hostName": "Anjali",
        "title": "Friday night",
        "viewerCount": 412,
        "totalGiftsReceived": 5_120,
        "isActive": True,
        "startedAt": NOW,
    }
    doc.update(over)
    fs.collection(live_svc.ROOMS).docs[room_id] = doc
    return doc


def stored(room_id: str) -> dict:
    return fs.collection(live_svc.ROOMS).docs[room_id]


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team}


OPS_ADMIN = internal("uid-ops-admin", Role.OPS_ADMIN, Team.OPS)
OPS_MEMBER = internal("uid-ops-member", Role.OPS_MEMBER, Team.OPS)
OWNER = internal("uid-owner", Role.OWNER)
APP_ADMIN = internal("uid-app-admin", Role.APP_ADMIN, Team.APP)
TECH_MEMBER = internal("uid-tech", Role.TECH_MEMBER, Team.TECH)
FINANCE_ADMIN = internal("uid-finance", Role.FINANCE_ADMIN, Team.FINANCE)
SUPPORT_ADMIN = internal("uid-support", Role.SUPPORT_ADMIN, Team.SUPPORT)
OBSERVER = internal("uid-observer", Role.OBSERVER)
SELLER = {
    "uid": "uid-seller",
    "name": "seller",
    "role": Role.SELLER,
    "team": None,
    "partner_ids": {"seller": "seller-1"},
}

REASON = "Host is showing another platform's stream over the top of their own."


def body(reason: str = REASON):
    return users_router.LiveReason(reason=reason)


def mute_body(muted: bool, reason: str = REASON):
    return users_router.MuteHost(muted=muted, reason=reason)


def entries(room_id: str) -> list[dict]:
    return [d for d in db[C.AUDIT].docs if d["subject"]["id"] == room_id]


# ══════════════════════════════════════════════════════════════════════════════
# 1. Ending a stream
# ══════════════════════════════════════════════════════════════════════════════

room("room-live")
result = run(users_router.end_live_room("room-live", body(), OPS_ADMIN))

check("the room is ended", result["ended"], True)
check("…and the host is named", result["host_uid"], "host-1")
check("…and the reason travels back", result["reason"], REASON)
check("the document is flagged inactive", stored("room-live")["isActive"], False)
check("…with the reason on it", stored("room-live")["endReason"], REASON)
check("…and who did it", stored("room-live")["endedBy"]["uid"], "uid-ops-admin")
check("…marked as a staff intervention", stored("room-live")["endedByStaff"], True)
ok("…and when", stored("room-live")["endedAt"] is not None)

log = entries("room-live")
check("exactly one audit entry", len(log), 1)
check("…as its own action", log[0]["action"], "live.room_ended")
check("…against the room", log[0]["subject"]["type"], "live_room")
check("…carrying the reason verbatim", log[0]["reason"], REASON)
check("…naming the actor", log[0]["actor"]["uid"], "uid-ops-admin")
check("…with the state before", log[0]["before"]["isActive"], True)
check("…and after", log[0]["after"]["isActive"], False)
check("…and what the room was worth when it was cut", log[0]["meta"]["gifts_at_end"], 5_120)
check("…and how many people were watching", log[0]["meta"]["viewers_at_end"], 412)
ok(
    "…and it says the app is what drops the stream, not this call",
    "the app is what drops" in log[0]["meta"]["enforcement"].lower()
    or "The app is what drops" in log[0]["meta"]["enforcement"],
)
ok(
    "the response says the same thing rather than implying the video was cut",
    "reads the flag" in result["note"],
)
ok("…and that this is not a ban", "not a ban" in result["note"])

# Ending a room is not moderation of the account. Nothing about the host moves.
ok("no user document was touched", "users" not in fs.collections)
ok("no ban was recorded", not any(d["action"].startswith("user.") for d in db[C.AUDIT].docs))


# ══════════════════════════════════════════════════════════════════════════════
# 2. The refusals
# ══════════════════════════════════════════════════════════════════════════════

# Already ended. Refused, not quietly successful — a double press must not read
# as two interventions, and it must not write a second entry.
before = len(db[C.AUDIT].docs)
message = rejects(
    "ending a room that has already ended",
    lambda: run(users_router.end_live_room("room-live", body(), OPS_ADMIN)),
)
ok("the refusal says it is not live", "not live" in message)
ok("…and says nothing was recorded twice", "second time" in message)
check("…and nothing was recorded twice", len(db[C.AUDIT].docs), before)

# A room that does not exist.
message = rejects(
    "ending a room that does not exist",
    lambda: run(users_router.end_live_room("room-nobody", body(), OPS_ADMIN)),
)
ok("the refusal names the room", "room-nobody" in message)
ok(
    "…and explains that a closed stream is deleted rather than kept",
    "already closed" in message,
)
check("…and wrote nothing", len(db[C.AUDIT].docs), before)

# A blank id.
rejects("ending with a blank room id", lambda: run(users_router.end_live_room("  ", body(), OPS_ADMIN)))

# The reason. 8.7.4 — every intervention is logged with one, and "ok" is not one.
room("room-reasons")
for bad in ("", "   ", "ok", "spam"):
    message = rejects(
        f"ending with the reason {bad!r}",
        lambda b=bad: run(users_router.end_live_room("room-reasons", body(b), OPS_ADMIN)),
    )
    ok(f"…and says why for {bad!r}", "reason" in message)
check("…and the room is still live", stored("room-reasons")["isActive"], True)
check("…and nothing was audited", entries("room-reasons"), [])

# Firestore refusing the write. The audit entry is written after the change and
# never before it, so a failed write must leave no entry describing an end that
# did not happen.
fs.collection(live_svc.ROOMS).fail_on("update", "room-reasons")
message = rejects(
    "ending when the room document cannot be written",
    lambda: run(users_router.end_live_room("room-reasons", body(), OPS_ADMIN)),
)
ok("the refusal says the stream is still live", "still live" in message)
check("…and nothing was recorded", entries("room-reasons"), [])
check("…and the room is untouched", stored("room-reasons")["isActive"], True)
fs.collection(live_svc.ROOMS).clear_failures()

# A read that fails is not "no such room". They need different messages because
# one is retryable and the other never will be.
fs.collection(live_svc.ROOMS).fail_on("get", "room-reasons")
message = rejects(
    "ending when the room cannot be read",
    lambda: run(users_router.end_live_room("room-reasons", body(), OPS_ADMIN)),
)
ok("a read failure is told apart from a room that does not exist", "read failure" in message)
fs.collection(live_svc.ROOMS).clear_failures()


# ══════════════════════════════════════════════════════════════════════════════
# 3. Who may do it
# ══════════════════════════════════════════════════════════════════════════════
#
# Ops and owners (3.4.5 / 8.7.3). Everyone else who can reach /live to watch is
# refused; the observer and every partner are refused by `require_write` before
# the narrowing is even consulted.

room("room-authority")

for actor in (OPS_ADMIN, OPS_MEMBER, OWNER):
    ok(f"{actor['role']} may intervene", live_svc.may_intervene(actor["role"]))
for actor in (APP_ADMIN, TECH_MEMBER, FINANCE_ADMIN, SUPPORT_ADMIN, OBSERVER, SELLER):
    ok(f"{actor['role']} may not intervene", not live_svc.may_intervene(actor["role"]))
ok("a machine credential may not intervene", not live_svc.may_intervene("system"))
ok("and neither may a role nobody has heard of", not live_svc.may_intervene("wholesaler"))

for actor in (APP_ADMIN, TECH_MEMBER, FINANCE_ADMIN, SUPPORT_ADMIN):
    detail = forbids(
        f"{actor['role']} cannot end a stream",
        lambda a=actor: run(users_router.end_live_room("room-authority", body(), a)),
    )
    ok(f"…and {actor['role']} is told what they CAN do", "banning the host" in detail)

check("…and the room is still live after all of them", stored("room-authority")["isActive"], True)
check("…and nothing was audited", entries("room-authority"), [])

# The observer and partners never reach the narrowing: `require_write` is the
# dependency and it refuses both, which is asserted against the real guard.
forbids(
    "the observer is refused by require_write, as everywhere",
    lambda: run(deps.require_write(OBSERVER)),
)
forbids(
    "a partner is refused by require_write, as everywhere",
    lambda: run(deps.require_write(SELLER)),
)
ok(
    "so neither live-room route is partner-reachable",
    ("POST", "/api/users/live-rooms/{room_id}/end") not in deps.PARTNER_REACHABLE
    and ("POST", "/api/users/live-rooms/{room_id}/mute") not in deps.PARTNER_REACHABLE,
)

# An owner and an ops member can both actually do it.
result = run(users_router.end_live_room("room-authority", body(), OWNER))
check("an owner ends a stream", result["ended"], True)
room("room-member")
check(
    "and so does an ops member",
    run(users_router.end_live_room("room-member", body(), OPS_MEMBER))["ended"],
    True,
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. Mute — recorded here, enforced by the app
# ══════════════════════════════════════════════════════════════════════════════

room("room-loud")
muted = run(users_router.mute_live_host("room-loud", mute_body(True), OPS_ADMIN))

check("the host is muted", muted["muted"], True)
check("…and was not before", muted["was_muted"], False)
check("the flag is on the room document", stored("room-loud")["hostMuted"], True)
check("…with the reason", stored("room-loud")["hostMuteReason"], REASON)
check("…and who set it", stored("room-loud")["hostMutedBy"]["uid"], "uid-ops-admin")

log = entries("room-loud")
check("one audit entry", len(log), 1)
check("…as its own action", log[0]["action"], "live.host_muted")
check("…carrying the reason", log[0]["reason"], REASON)
check("…with before and after", (log[0]["before"]["hostMuted"], log[0]["after"]["hostMuted"]), (False, True))

# The honest part, and the reason this endpoint is worth having at all.
ok(
    "the response says the Android app must honour the flag",
    "Android app" in muted["app_must_honour"],
)
ok(
    "…and that this API cannot silence anybody on its own",
    "cannot silence anybody" in muted["app_must_honour"],
)
ok(
    "…and what it means if the app does not read it yet",
    "changed nothing the audience can hear" in muted["app_must_honour"],
)
ok(
    "the audit entry says the same, so the log does not overstate it",
    "must" in log[0]["meta"]["enforcement"] and "audio publisher" in log[0]["meta"]["enforcement"],
)

# Muting twice is refused, for the same reason ending twice is.
before = len(db[C.AUDIT].docs)
message = rejects(
    "muting an already-muted host",
    lambda: run(users_router.mute_live_host("room-loud", mute_body(True), OPS_ADMIN)),
)
ok("the refusal says they are already muted", "already muted" in message)
check("…and nothing was recorded twice", len(db[C.AUDIT].docs), before)

# Unmuting is the same route, and carries its own reason: lifting an
# intervention is an intervention.
LIFT = "Host produced the rights document; the stream is legitimate."
unmuted = run(users_router.mute_live_host("room-loud", mute_body(False, LIFT), OWNER))
check("unmuting works through the same route", unmuted["muted"], False)
check("…and it was muted before", unmuted["was_muted"], True)
check("…the flag is cleared", stored("room-loud")["hostMuted"], False)
check("…and the mute stamp is cleared with it", stored("room-loud")["hostMutedAt"], None)
check("…audited as its own action", entries("room-loud")[-1]["action"], "live.host_unmuted")
check("…with the reason for lifting it", entries("room-loud")[-1]["reason"], LIFT)

rejects(
    "unmuting a host who is not muted",
    lambda: run(users_router.mute_live_host("room-loud", mute_body(False), OPS_ADMIN)),
)
for bad in ("", "no", "loud"):
    rejects(
        f"muting with the reason {bad!r}",
        lambda b=bad: run(users_router.mute_live_host("room-loud", mute_body(True, b), OPS_ADMIN)),
    )
check("…and the host is still unmuted", stored("room-loud")["hostMuted"], False)

for actor in (APP_ADMIN, FINANCE_ADMIN):
    forbids(
        f"{actor['role']} cannot mute a host",
        lambda a=actor: run(users_router.mute_live_host("room-loud", mute_body(True), a)),
    )
rejects(
    "muting a room that does not exist",
    lambda: run(users_router.mute_live_host("room-nobody", mute_body(True), OPS_ADMIN)),
)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} live-operations checks passed.")
print("  · a stream is ended by Ops or an owner, with a mandatory reason, and")
print("    exactly one audit entry naming who, what and why")
print("  · ending is not banning — the host's account is untouched")
print("  · a room that does not exist, one already ended, a short reason and a")
print("    Firestore write that fails all refuse and record nothing")
print("  · a read failure is told apart from a room that is not there")
print("  · app, tech, support, finance and marketing can watch and cannot cut;")
print("    the observer and every partner are refused by require_write first")
print("  · mute writes hostMuted and says, in the response and in the audit")
print("    entry, that the Android app must honour it — this API is not in the")
print("    media path and cannot silence anybody on its own")
sys.exit(0)
