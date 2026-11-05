"""O12 — closing a party room from the CRM's party monitor (Owner, 5 Nov 2026).

The party twin of `test_live_ops`'s live end:

  * Ops or an Owner only (the same `_require_intervener` as the live end); the observer, finance, the app team and
    partners are refused;
  * a reason of at least six characters;
  * a room that does not exist, or has already closed, is refused — a second press is not a second intervention;
  * the teardown is the app's own (`closeRoom` in functions/src/party.ts): the room is flagged closed with its counts
    at 0, its seats removed, everybody's `isInParty` / `partyRoomId` cleared (seat holders, listeners, host), a private
    room's password hash removed — and who, when and why written beside it;
  * an audit entry is written AFTER the change, never before; a failed write leaves no entry;
  * the host's account is untouched — closing a room is not a ban.

REAL: `app/services/live.py`, `app/routers/users.py`. FAKE: Mongo (`harness.FakeDb`), Firestore (`fakes.FakeFirestore`).

    python3 -m tests.test_party_room_end
"""

from __future__ import annotations

import asyncio
import logging
import sys
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
from app.services import live as live_svc  # noqa: E402

failures: list[str] = []
checks = 0


def eq(label, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}\n    want {want!r}\n    got  {got!r}")


def ok(label, cond) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def refused(label, fn, status: int) -> str:
    global checks
    checks += 1
    try:
        result = asyncio.run(fn())
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "status_code", None) == status:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}), want {status}")
        return ""
    failures.append(f"{label}: NOT refused — {result!r}")
    return ""


db = FakeDb()
audit_mod.get_db = lambda: db
fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs
logging.getLogger("app.services.live").setLevel(logging.CRITICAL)


def staff(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team}


OPS = staff("uid-ops", Role.OPS_MEMBER, Team.OPS)
OWNER = staff("uid-owner", Role.OWNER)
APP = staff("uid-app", Role.APP_ADMIN, Team.APP)
FIN = staff("uid-fin", Role.FINANCE_ADMIN, Team.FINANCE)
OBSERVER = staff("uid-observer", Role.OBSERVER)
REASON = "Explicit content on the seats, reported twice."

rooms = fs.collection(live_svc.PARTY_ROOMS)
rooms.docs["P1"] = {"hostUid": "host-1", "hostName": "Riya", "title": "Late night", "isActive": True,
                    "visibility": "private", "listenerCount": 3, "occupantCount": 2}
rooms.subcollection("P1", "seats").docs.update({"1": {"uid": "host-1"}, "2": {"uid": "seat-2"}})
rooms.subcollection("P1", "listeners").docs.update({"l-1": {"uid": "l-1"}, "l-2": {"uid": "l-2"}, "seat-2": {"uid": "seat-2"}})
rooms.subcollection("P1", "private").docs["secret"] = {"passwordHash": "x", "passwordSalt": "y"}
users = fs.collection("users")
for uid in ("host-1", "seat-2", "l-1", "l-2", "bystander"):
    users.docs[uid] = {"name": uid, "isInParty": uid != "bystander", "partyRoomId": "P1" if uid != "bystander" else "",
                       "isBanned": False}


def end(room_id: str, user: dict, reason: str = REASON):
    return users_router.end_party_room(room_id, users_router.LiveReason(reason=reason), user=user)


# ── Who ───────────────────────────────────────────────────────────────────────
print("\n1. Ops or an Owner only")
for who in (APP, FIN, OBSERVER):
    refused(f"{who['role']} may not close a party room", lambda who=who: end("P1", who), 403)
eq("…and the room is still open", rooms.docs["P1"]["isActive"], True)

# ── The close ─────────────────────────────────────────────────────────────────
print("2. Ops closes it: the app's teardown, plus who and why")
res = asyncio.run(end("P1", OPS))
room = rooms.docs["P1"]
eq("the room is closed", (room["isActive"], room["listenerCount"], room["occupantCount"]), (False, 0, 0))
eq("…by staff, with the reason", (room["endedByStaff"], room["endReason"]), (True, REASON))
ok("…and who", room["endedBy"].get("uid") == "uid-ops")
eq("the seats are removed", rooms.subcollection("P1", "seats").docs, {})
eq("the private room's password hash is removed", rooms.subcollection("P1", "private").docs, {})
for uid in ("host-1", "seat-2", "l-1", "l-2"):
    eq(f"{uid} is no longer in a party", (users.docs[uid]["isInParty"], users.docs[uid]["partyRoomId"]), (False, ""))
eq("a bystander is untouched", users.docs["bystander"]["isInParty"], False)
eq("the host's account is not banned", users.docs["host-1"]["isBanned"], False)
eq("the answer counts what it cleared", (res["seats_cleared"], res["people_cleared"]), (2, 4))
entries = [d for d in db[C.AUDIT].docs if d["subject"]["id"] == "P1"]
eq("one audit entry", len(entries), 1)
eq("…its action", entries[0]["action"], live_svc.Act.PARTY_ROOM_ENDED)

# ── Refusals ──────────────────────────────────────────────────────────────────
print("3. A second press, an unknown room, a short reason")
said = refused("an already-closed room", lambda: end("P1", OWNER), 400)
ok("…says it was already closed", "already closed" in said)
eq("…and records nothing a second time", len([d for d in db[C.AUDIT].docs if d["subject"]["id"] == "P1"]), 1)
refused("an unknown room", lambda: end("nope", OWNER), 400)
rooms.docs["P2"] = {"hostUid": "host-2", "isActive": True}
# The body model asks for six characters; the service asks again (the harness stubs pydantic's checks).
said = refused("a reason under six characters", lambda: end("P2", OWNER, "bad"), 400)
ok("…says why", "reason" in said.lower())
eq("…and the room is still open", rooms.docs["P2"]["isActive"], True)

# ── A failed write records nothing ────────────────────────────────────────────
print("4. A failed write leaves no audit entry")
real = fs.batch


def failing_batch():
    b = real()
    b.fail_on_commit = True
    return b


fs.batch = failing_batch  # type: ignore[assignment]
refused("a write that fails", lambda: end("P2", OWNER), 400)
fs.batch = real  # type: ignore[assignment]
eq("…the room is still open", rooms.docs["P2"]["isActive"], True)
eq("…and nothing was recorded", [d for d in db[C.AUDIT].docs if d["subject"]["id"] == "P2"], [])

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} party-room-end checks passed.")
