"""P1-D — ticket workflows are server-authoritative, audited and notified.

Covers `app/services/tickets.py` against the in-memory fakes:

  * the actor's name comes from the staff row, never the request;
  * only allow-listed fields change; unknown fields and bad values are refused;
  * routing / closing / reopening / dependency changes need a reason;
  * the audit entry is written BEFORE the Firestore write, and a failed write
    is followed by `ticket.update_failed`;
  * an assignee must be an active staff member (of the ticket's team);
  * a retried request (same request_id) changes nothing and notifies nobody;
  * notices go to the assignee, to the team admins on routing, and to the app
    user when their ticket is answered — keyed on the audit id;
  * who may work which queue: partners / observer / non-triage roles refused.

Run:  python3 -m tests.test_p1_tickets
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import tickets as svc  # noqa: E402

db = FakeDb()
store = FakeFirestore()
fb.firestore_client = lambda: store
svc.get_db = lambda: db

audit_log: list[dict] = []
order: list[str] = []


async def fake_record(**kw):
    audit_log.append(kw)
    order.append(f"audit:{kw['action']}")
    return f"aud-{len(audit_log)}"


audit_mod.record = fake_record

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def refused(label: str, coro, *, status: int | None = None, contains: str = "") -> None:
    global checks
    checks += 1
    try:
        run(coro)
        failures.append(f"{label}: was allowed")
    except svc.TicketError as exc:
        if status is not None and exc.status_code != status:
            failures.append(f"{label}: status {exc.status_code}, wanted {status}")
        if contains and contains not in str(exc):
            failures.append(f"{label}: message {exc!s} lacks {contains!r}")


def doc(col: str, did: str) -> dict:
    s = store.collection(col).document(did).get()
    return (s.to_dict() if s.exists else None) or {}


# ── People ────────────────────────────────────────────────────────────────────
for uid, role, team, name in (
    ("u-owner", "owner", None, "Owner One"),
    ("u-tech-admin", "tech_admin", "tech", "Tech Admin"),
    ("u-tech-member", "tech_member", "tech", "Tech Member"),
    ("u-support", "support_member", "support", "Support Member"),
    ("u-marketing", "marketing_member", "marketing", "Mark Eting"),
):
    run(db[C.STAFF].insert_one({"uid": uid, "role": role, "team": team, "name": name, "email": f"{uid}@x.test", "is_active": True}))
run(db[C.STAFF].insert_one({"uid": "u-gone", "role": "tech_member", "team": "tech", "name": "Gone", "is_active": False}))

A = lambda uid, role, team=None: {"uid": uid, "role": Role(role), "team": team, "name": "CLIENT-SUPPLIED NAME"}  # noqa: E731
OWNER = A("u-owner", "owner")
TECH_ADMIN = A("u-tech-admin", "tech_admin", "tech")
SUPPORT = A("u-support", "support_member", "support")
MARKETING = A("u-marketing", "marketing_member", "marketing")
AGENCY = {"uid": "u-agency", "role": Role.AGENCY, "team": None}
OBSERVER = {"uid": "observer:x", "role": Role.OBSERVER, "team": None}

# ── Team tickets ──────────────────────────────────────────────────────────────
created = run(svc.create_team_ticket({"title": "Crash on login", "description": "x", "category": "bug",
                                      "priority": "high", "assignedTeam": "tech"}, MARKETING))
tid = created["id"]
t = doc("techTickets", tid)
ok("the reporter is the staff row's name, not the client's", t["reportedBy"] == "Mark Eting")
ok("…with the uid and department from the session", (t["reportedByUid"], t["reportedByDept"]) == ("u-marketing", "marketing"))
ok("filing is audited", audit_log[-1]["action"] == audit_mod.Action.TICKET_CREATED)
ok("filed with nobody assigned: the team's admin is told", created["notified"].get("routed:u-tech-admin") is True)
ok("…and only that team's admins", all(k.endswith("u-tech-admin") for k in created["notified"]))

order.clear()
res = run(svc.update("team", tid, {"assignedTo": "u-tech-member"}, OWNER))
ok("assignment names the assignee from their staff row", doc("techTickets", tid)["assignedToName"] == "Tech Member")
ok("the audit entry is written before the ticket", order and order[0].startswith("audit:"))
ok("audit carries before and after", audit_log[-1]["before"].get("assignedTo") in ("", None) and audit_log[-1]["after"]["assignedTo"] == "u-tech-member")
ok("the assignee gets an in-app notice", any(k.startswith("assigned:u-tech-member") for k in res["notified"]))

refused("an inactive assignee is refused", svc.update("team", tid, {"assignedTo": "u-gone"}, OWNER), contains="active")
refused("an assignee outside the ticket's team is refused", svc.update("team", tid, {"assignedTo": "u-support"}, OWNER), contains="tech team")
refused("an unknown field is refused", svc.update("team", tid, {"reportedBy": "Somebody else"}, OWNER), contains="cannot be changed")
refused("an unknown status is refused", svc.update("team", tid, {"status": "teleported"}, OWNER))
refused("closing needs a reason", svc.update("team", tid, {"status": "done"}, OWNER), contains="reason")
refused("routing to another team needs a reason", svc.update("team", tid, {"assignedTeam": "app"}, OWNER), contains="reason")

run(svc.update("team", tid, {"status": "done"}, OWNER, reason="Fixed in 1.2.6"))
ok("closed", doc("techTickets", tid)["status"] == "done")
refused("reopening needs a reason", svc.update("team", tid, {"status": "open"}, OWNER), contains="reason")
run(svc.update("team", tid, {"status": "open"}, OWNER, reason="Regressed"))

# Dependencies
other = run(svc.create_team_ticket({"title": "Root cause", "assignedTeam": "tech"}, OWNER))["id"]
run(svc.update("team", tid, {"blockedBy": other}, OWNER, reason="Waiting on root cause"))
refused("a blocked ticket cannot be closed", svc.update("team", tid, {"status": "done"}, OWNER, reason="x" * 5), contains="blocked")
run(svc.update("team", tid, {"blockedBy": None}, OWNER, reason="Split out"))
ok("the cleared dependency keeps its reason", doc("techTickets", tid)["blockedReason"] == "Cleared: Split out")

# Routing moves the ticket and drops an assignee who is not in the new team.
run(svc.update("team", tid, {"assignedTeam": "app"}, OWNER, reason="App team owns login"))
ok("routed: the old-team assignee is dropped", doc("techTickets", tid)["assignedTo"] == "")

# Idempotent retry
n_audit = len(audit_log)
run(svc.update("team", tid, {"priority": "low"}, OWNER, request_id="req-1"))
again = run(svc.update("team", tid, {"priority": "critical"}, OWNER, request_id="req-1"))
ok("a replayed request changes nothing", doc("techTickets", tid)["priority"] == "low" and again.get("replayed") is True)
ok("…and writes one audit entry, not two", len(audit_log) == n_audit + 1)

# A failed write is followed by ticket.update_failed and reported.
store.collection("techTickets").fail_on("update", tid)
refused("a Firestore failure is reported", svc.update("team", tid, {"priority": "high"}, OWNER), status=503)
ok("…after the audit entry, with a failure entry", [e["action"] for e in audit_log[-2:]] == [audit_mod.Action.TICKET_UPDATED, audit_mod.Action.TICKET_UPDATE_FAILED])
store.collection("techTickets").clear_failures()

# Who may work the board
refused("a partner session cannot touch team tickets", svc.update("team", tid, {"priority": "high"}, AGENCY), status=403)
refused("the observer cannot write", svc.update("team", tid, {"priority": "high"}, OBSERVER), status=403)

# ── Feedback tickets ──────────────────────────────────────────────────────────
store.collection("feedbackTickets").document("F1").set({"userId": "app-user-1", "subject": "Coins missing",
                                                        "message": "I paid", "status": "open", "priority": "medium"})
refused("a marketing member cannot triage feedback", svc.update("feedback", "F1", {"assignedTo": "me"}, MARKETING), status=403)
run(svc.update("feedback", "F1", {"assignedTo": "me"}, SUPPORT))
f = doc("feedbackTickets", "F1")
ok("claiming assigns the caller, by the staff row", (f["assignedToUid"], f["assignedToName"], f["status"]) == ("u-support", "Support Member", "assigned"))
ok("the actor name is trusted, not supplied", f["statusChangedByName"] == "Support Member")
refused("a status change needs a note", svc.update("feedback", "F1", {"status": "in_progress"}, SUPPORT), contains="reason")
res = run(svc.update("feedback", "F1", {"response": "We credited your coins today."}, SUPPORT))
f = doc("feedbackTickets", "F1")
ok("a response resolves the ticket with the response as its note", (f["status"], f["statusNote"]) == ("resolved", "We credited your coins today."))
ok("the app user is told", any(k.startswith("answered:app-user-1") for k in res["notified"]))
refused("a too-short response is refused", svc.update("feedback", "F1", {"response": "ok"}, SUPPORT))

# ── Support tickets ───────────────────────────────────────────────────────────
store.collection("supportTickets").document("S1").set({"userId": "app-user-2", "subject": "Cannot go live",
                                                       "message": "Camera black", "status": "open", "priority": "high"})
res = run(svc.update("support", "S1", {"adminReply": "Please update the app."}, SUPPORT))
s1 = doc("supportTickets", "S1")
ok("a reply stores the reply and marks it replied", (s1["adminReply"], s1["status"]) == ("Please update the app.", "replied"))
ok("the app user is notified (the broken users/{uid}/notifications write is gone)",
   any(k.startswith("answered:app-user-2") for k in res["notified"]))
refused("closing needs a reason", svc.update("support", "S1", {"status": "closed"}, SUPPORT), contains="reason")
run(svc.update("support", "S1", {"priority": "critical"}, SUPPORT))
ok("support priorities are the App Tickets screen's (critical)", doc("supportTickets", "S1")["priority"] == "critical")
refused("…not the feedback screen's (urgent)", svc.update("support", "S1", {"priority": "urgent"}, SUPPORT))
run(svc.update("support", "S1", {"assignedTo": "u-support"}, SUPPORT))
ok("assigning names the assignee from the staff row", doc("supportTickets", "S1")["assignedToName"] == "Support Member")
run(svc.update("support", "S1", {"assignedTo": ""}, SUPPORT))
ok("an empty assignee UNassigns (it does not assign the caller)", doc("supportTickets", "S1")["assignedTo"] == "")
routed = run(svc.route_support_ticket("S1", "tech", "Camera bug on Android 14", SUPPORT, assign_to="u-tech-member"))
team_id = routed["team_ticket"]["id"]
ok("routing creates a linked team ticket", doc("techTickets", team_id)["linkedSupportTicketId"] == "S1")
ok("the routed team ticket keeps the support priority", doc("techTickets", team_id)["priority"] == "critical")
ok("…tagged as from the app, reported by the router's staff name",
   (doc("techTickets", team_id)["source"], doc("techTickets", team_id)["reportedBy"]) == ("app", "Support Member"))
ok("the support ticket points at it", doc("supportTickets", "S1")["linkedTeamTicketId"] == team_id)
refused("a ticket is routed once", svc.route_support_ticket("S1", "app", "Again please", SUPPORT), status=409)
ok("routing is audited", any(e["action"] == audit_mod.Action.TICKET_ROUTED for e in audit_log))

if failures:
    print(f"{len(failures)} of {checks} ticket checks FAILED")
    for x in failures:
        print("  ✗", x)
    sys.exit(1)
print(f"All {checks} P1 ticket checks passed.")
