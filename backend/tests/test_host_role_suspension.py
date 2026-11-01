"""§5 partner role suspension, for the HOST capability — end to end on the backend.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * `POST /users/{uid}/suspend-host` pauses ONLY the Host role: `isHost`, the
    verification, the agency link, the rate, the roster row, the earnings and
    the account itself are untouched; the person's other role is untouched; the
    host's live rooms are ended; host money is frozen for the Owner's review;
    the host and their agency are told; one immutable `host.suspended` row.
  * the contract body: `{uid, host: {status: "suspended", suspendedUntil,
    reason}, notified: {host, agency}, audit_id}`; the same request again is
    `already: true` and writes nothing; other terms on a suspended Host, a
    non-Host, a revoked Host, a short reason or a bad term are 400.
  * the write is conditional on the Host state it was decided against.
  * `POST /users/{uid}/resume-host` gives back the status the record had
    before (`host.status`), clears the pause, keeps the stamps, releases no
    money, tells host + agency, writes `host.resumed`; a revoked Host is
    refused (reinstatement only), a revoke of a suspended Host ends the pause.
  * the role inventory and the eligibility answer report `suspended`, and a
    suspended Host still holds the role (one-role rule, deductions).
  * Support (no `can_approve_kyc`) and the Observer (no write) are refused by
    the gate revoke-host uses; Ops Admin and the Owner pass; self / staff
    targets are refused.
  * the daily sweep resumes a timed suspension whose date has passed, leaves an
    indefinite one alone, and is wired into `scheduling.daily` with a
    `system:` actor.

REAL: services.users, user_roles, partner_applications, notices, email,
money_freeze, live, core.audit, core.deps; routers.users.
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
Firebase Auth (`tests/harness.verified_auth`).

    python3 -m tests.test_host_role_suspension
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

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core.roles import Permission  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from tests import harness as _h  # noqa: E402

firebase_mod.get_user = _h.verified_auth  # type: ignore[assignment]
fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

from app.routers import users as users_router  # noqa: E402
from app.services import email as mail  # noqa: E402
from app.services import live as live_svc  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import user_roles as ur  # noqa: E402
from app.services import users as users_svc  # noqa: E402

apps.is_unverified_guest = lambda uid: False  # fixtures are verified people
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refused(claim: str, coro, kind=Exception):
    """The refusal (an instance of `kind`), or None and a failure."""
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc}) — wanted {kind.__name__}")
        return None
    failures.append(f"{claim}: was NOT refused")
    return None


run = asyncio.run
OPS = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner One", "role": "owner", "team": None}
SUPPORT = {"uid": "sup-1", "name": "Support Admin", "role": "support_admin", "team": "support"}
APP_ADMIN = {"uid": "app-1", "name": "App Admin", "role": "app_admin", "team": "app"}
OBSERVER = {"uid": "observer:obs@zipper.test", "name": "Observer", "role": "observer", "team": None}
AGENCY_SESSION = {"uid": "h-owner", "name": "Agency", "role": "agency", "team": None,
                  "partner_ids": {"agency": "AG-h"}}
WHY = "Repeated no-shows on booked calls this week."
HTTPException = _h.HTTPException

DB.seed(C.STAFF, [
    {"uid": "owner-1", "role": "owner", "is_active": True, "email": "owner1@zipper.test", "name": "Owner One"},
    {"uid": "ops-1", "role": "ops_admin", "is_active": True, "email": "ops1@zipper.test", "name": "Ops Admin",
     "team": "ops"},
    {"uid": "sup-1", "role": "support_admin", "is_active": True, "email": "sup1@zipper.test",
     "name": "Support Admin", "team": "support"},
    {"uid": "app-1", "role": "app_admin", "is_active": True, "email": "app1@zipper.test", "name": "App Admin",
     "team": "app"},
    {"uid": "observer:obs@zipper.test", "role": "observer", "is_active": True, "email": "obs@zipper.test",
     "name": "Observer"},
])


def user(uid: str, **over) -> dict:
    doc = {"name": f"user {uid}", "accountState": "active", "isBanned": False, "isSuspended": False,
           "email": f"{uid}@x.test", **over}
    fs.collection("users").docs[uid] = doc
    return doc


def stored(uid: str) -> dict:
    return fs.collection("users").docs[uid]


def partner(pid: str, owner: str, kind: str, status: str = "approved") -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, "crm_id": f"CRM-{pid}"})
    fs.collection("sellers" if kind == "seller" else "agencies").docs[pid] = {
        "agencyName" if kind != "seller" else "displayName": pid, "crmUid": owner, "ownerUid": owner,
        "status": status, "isActive": status == "approved"}


def record(pid: str) -> dict:
    return next(p for p in DB[C.PARTNERS].docs if p["_id"] == pid)


def roster(agency: str) -> dict:
    return fs.collection("agencies").document(agency).collection("agencyHosts").docs


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


def audit_rows(uid: str, action: str) -> list[dict]:
    return [e for e in DB[C.AUDIT].docs
            if e.get("action") == action and (e.get("subject") or {}).get("id") == uid]


def freeze_of(uid: str) -> dict | None:
    return next((d for d in DB["money_freezes"].docs if d["_id"] == f"user:{uid}"), None)


def host(uid: str, agency: str = "AG-h", **over) -> dict:
    doc = user(uid, isHost=True, isVerifiedHost=True, agencyId=agency, callRateBeans=900, beans=5000,
               beansAvailable=3000, hostCallEarnings=7000, hostGiftEarnings=1200, credentialsValidAfter=0, **over)
    roster(agency)[uid] = {"uid": uid, "name": f"user {uid}", "agencyId": agency, "active": True,
                           "callRateBeans": 900}
    fs.collection("hostVerification").docs[uid] = {"uid": uid, "status": "verified", "attemptCount": 1}
    return doc


def suspend_body(reason: str = WHY, days: int | None = None):
    return users_router.HostSuspend(reason=reason, days=days)


def reason_body(reason: str):
    return users_router.Reason(reason=reason)


# ── Fixtures: an agency with an owner, a Host who is also a Coin Seller ────────
user("h-owner")
partner("AG-h", "h-owner", "agency")
host("h-1")
partner("SL-h", "h-1", "seller")
fs.collection(live_svc.ROOMS).docs["room-h-1"] = {"hostUid": "h-1", "isActive": True, "hostName": "H"}
fs.collection(live_svc.ROOMS).docs["room-other"] = {"hostUid": "someone-else", "isActive": True, "hostName": "O"}

# ══════════════════════════════════════════════════════════════════════════════
print("1. Suspend: only the Host role pauses; record, roster, earnings and the other role stay")

ok("the audit actions are declared in the host role suspension block",
   audit_mod.Action.HOST_SUSPENDED == "host.suspended" and audit_mod.Action.HOST_RESUMED == "host.resumed")
src_audit = (ROOT / "app" / "core" / "audit.py").read_text()
ok("…under `# --- host role suspension ---`", "# --- host role suspension ---" in src_audit
   and src_audit.index("# --- host role suspension ---") < src_audit.index('HOST_SUSPENDED = "host.suspended"'))

out = run(users_router.suspend_host("h-1", suspend_body(days=3), OPS))
eq("the contract's keys", sorted(k for k in ("uid", "host", "notified", "audit_id") if k in out),
   ["audit_id", "host", "notified", "uid"])
eq("…host.status is suspended, with the reason", (out["host"]["status"], out["host"]["reason"]), ("suspended", WHY))
until = datetime.fromisoformat(out["host"]["suspendedUntil"])
ok("…suspendedUntil is the term from now (ISO)",
   timedelta(days=2, hours=23) < until - datetime.now(timezone.utc) <= timedelta(days=3), str(until))
eq("…host and agency notified", out["notified"], {"host": True, "agency": True})
ok("…an audit id", bool(out["audit_id"]))
eq("…not a repeat", out.get("already"), False)

doc = stored("h-1")
eq("the Host record is kept: isHost, verification, agency, rate",
   (doc["isHost"], doc["isVerifiedHost"], doc["agencyId"], doc["callRateBeans"]), (True, True, "AG-h", 900))
eq("…earnings untouched", (doc["beans"], doc["beansAvailable"], doc["hostCallEarnings"], doc["hostGiftEarnings"]),
   (5000, 3000, 7000, 1200))
eq("…the pause is on the record", (doc["hostSuspended"], doc["hostSuspendedReason"], doc["hostSuspensionDays"],
                                   doc["hostStatusBeforeSuspension"]), (True, WHY, 3, "active"))
PRIOR_STATUS = doc["hostStatusBeforeSuspension"]
ok("…with the date and the actor", isinstance(doc.get("hostSuspendedUntil"), datetime)
   and doc.get("hostSuspendedBy") == "ops-1" and doc.get("hostSuspendedByRole") == "ops_admin"
   and isinstance(doc.get("hostSuspendedAt"), datetime))
eq("the roster row is untouched (still current)", roster("AG-h")["h-1"],
   {"uid": "h-1", "name": "user h-1", "agencyId": "AG-h", "active": True, "callRateBeans": 900})
eq("the verification record is untouched", fs.collection("hostVerification").docs["h-1"]["status"], "verified")
eq("the ACCOUNT is not restricted and no session cut-off moved",
   (users_svc.restriction_of(doc), doc["accountState"], doc["isBanned"], doc["credentialsValidAfter"]),
   ("", "active", False, 0))
eq("the other role (Coin Seller) is untouched", (record("SL-h")["status"], record("SL-h")["is_active"]),
   ("approved", True))
eq("the Host's live room is ended, nobody else's",
   (fs.collection(live_svc.ROOMS).docs["room-h-1"]["isActive"], fs.collection(live_svc.ROOMS).docs["room-other"]["isActive"],
    out["live_rooms_ended"]), (False, True, ["room-h-1"]))
ok("…and the end reason names the suspension",
   "Host role suspended" in str(fs.collection(live_svc.ROOMS).docs["room-h-1"].get("endReason")))
ok("host money is frozen for the Owner's review (payout hold + freeze record)",
   doc.get("payoutHold") is True and (freeze_of("h-1") or {}).get("status") == "frozen"
   and any(c.get("action") == "role_suspended" for c in (freeze_of("h-1") or {}).get("causes", [])))
rows = audit_rows("h-1", "host.suspended")
eq("ONE host.suspended audit row", len(rows), 1)
ok("…naming the actor, the reason, before → after, the term and what was NOT touched",
   rows and rows[0]["actor"]["uid"] == "ops-1" and rows[0]["reason"] == WHY
   and rows[0]["before"]["hostStatus"] == "active" and rows[0]["after"]["hostStatus"] == "suspended"
   and rows[0]["meta"]["days"] == 3 and rows[0]["meta"]["account_touched"] is False
   and rows[0]["meta"]["other_roles_touched"] is False and rows[0]["meta"]["live_rooms_ended"] == ["room-h-1"],
   str(rows[:1]))
eq("…and its id is the one answered", str(rows[0]["_id"]) if rows else "", str(out["audit_id"]))
host_notes = [n for n in notices_for("h-1") if n["type"] == "host_suspended"]
ok("the host is told, with the reason and the term",
   len(host_notes) == 1 and WHY in host_notes[0]["body"] and "until" in host_notes[0]["body"], str(host_notes))
agency_notes = [n for n in notices_for("h-owner") if n["type"] == "agency_host_suspended"]
ok("the agency is told, naming the host", len(agency_notes) == 1 and agency_notes[0]["meta"]["hostUid"] == "h-1",
   str(agency_notes))
ok("the two email templates are catalogued as transactional role mail",
   str(mail.TEMPLATES["host.suspended"].identity) == "transactional"
   and str(mail.TEMPLATES["host.resumed"].identity) == "transactional")

inv = run(ur.roles_for_crm("h-1"))
host_row = next(r for r in inv["roles"] if r["role"] == "host")
eq("the role inventory reports the Host as suspended, with term and reason",
   (host_row["status"], host_row["suspension_reason"], bool(host_row["suspended_until"])), ("suspended", WHY, True))
eq("…a suspended Host still HOLDS the role (2 held: Host + Coin Seller)", inv["held_count"], 2)
eq("…its actions: revoke (two roles held) and resume", host_row["actions"], ["revoke", "resume"])
eq("…deductions still in beans as well", inv["deduction_currencies"], ["beans", "diamonds"])
held = run(apps.held_roles("h-1"))
eq("the app's eligibility answer says suspended too", (held["host"]["status"], held["host"]["suspension_reason"]),
   ("suspended", WHY))
eq("…and a second Host application is still refused", "host" in apps.eligible_kinds(held)["options"], False)

# ══════════════════════════════════════════════════════════════════════════════
print("2. Idempotent repeat; every other suspend refused with 400")

audit_before = len(DB[C.AUDIT].docs)
notes_before = len(fs.collection("notifications").docs)
again = run(users_router.suspend_host("h-1", suspend_body(days=3), OPS))
eq("the same request again answers the standing suspension with already: true",
   (again["already"], again["host"]["status"], again["host"]["reason"], again["uid"]), (True, "suspended", WHY, "h-1"))
eq("…the same end date", again["host"]["suspendedUntil"], out["host"]["suspendedUntil"])
eq("…the standing audit id", str(again["audit_id"]), str(out["audit_id"]))
eq("…nothing new written: no audit row, no notice", (len(DB[C.AUDIT].docs), len(fs.collection("notifications").docs)),
   (audit_before, notes_before))
eq("…nobody told twice", again["notified"], {"host": False, "agency": False})

exc = refused("other terms on a suspended Host are refused",
              users_router.suspend_host("h-1", suspend_body(reason="A different reason entirely."), OPS), HTTPException)
ok("…400, saying it is already suspended", exc is not None and exc.status_code == 400
   and "already suspended" in str(exc.detail), str(getattr(exc, "detail", "")))

user("u-plain")
exc = refused("a person who is not a Host", users_router.suspend_host("u-plain", suspend_body(), OPS), HTTPException)
ok("…400", exc is not None and exc.status_code == 400 and "not an approved Host" in str(exc.detail))
user("h-rev", isHost=False, agencyId="AG-h", hostRevokedAt=datetime(2026, 10, 1, tzinfo=timezone.utc))
exc = refused("a revoked Host", users_router.suspend_host("h-rev", suspend_body(), OPS), HTTPException)
ok("…400, naming the revocation", exc is not None and exc.status_code == 400 and "revoked" in str(exc.detail))
host("h-2")
exc = refused("a reason under ten characters", users_router.suspend_host("h-2", suspend_body(reason="too short"), OPS),
              HTTPException)
ok("…400", exc is not None and exc.status_code == 400)
for bad in (0, 366):
    exc = refused(f"a term of {bad} days", users_router.suspend_host("h-2", suspend_body(days=bad), OPS), HTTPException)
    ok(f"…{bad}: 400", exc is not None and exc.status_code == 400)
eq("…and none of those wrote anything", stored("h-2").get("hostSuspended"), None)

# The conditional write: decided against `active`, refused once it is not.
fs.collection("users").docs["h-race"] = {"isHost": True, "hostSuspended": True, "hostSuspendedReason": "x"}
found = users_svc._host_state_write("h-race", "active", {"hostSuspendedReason": "overwritten"})
eq("the state write is conditional — a changed record is not overwritten",
   (found, stored("h-race")["hostSuspendedReason"]), ("suspended", "x"))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Who may: the revoke-host gate — Support and the Observer never")

src = (ROOT / "app" / "routers" / "users.py").read_text()
for path in ("suspend-host", "resume-host"):
    ok(f"/{path} declares can_approve_kyc beside require_write",
       re.search(r'"/\{uid\}/' + path + r'",\s*dependencies=\[Depends\(require_permission\(Permission\.CAN_APPROVE_KYC\)\)\],\s*\)\s*'
                 r'async def \w+\(uid: str, body: \w+, user: dict = Depends\(require_write\)\)', src) is not None)
gate = deps.require_permission(Permission.CAN_APPROVE_KYC)
for who, session in (("Support", SUPPORT), ("App Admin", APP_ADMIN), ("the Observer", OBSERVER)):
    exc = refused(f"{who} is refused by the permission", gate(session), HTTPException)
    ok("…403", exc is not None and exc.status_code == 403)
exc = refused("the Observer is refused by require_write", deps.require_write(OBSERVER), HTTPException)
ok("…403, read-only", exc is not None and exc.status_code == 403)
exc = refused("an agency session is refused by require_write", deps.require_write(AGENCY_SESSION), HTTPException)
ok("…403", exc is not None and exc.status_code == 403)
for who, session in (("Ops Admin", OPS), ("the Owner", OWNER)):
    try:
        run(gate(session))
        ok(f"{who} passes the gate", True)
    except Exception as e:  # noqa: BLE001
        ok(f"{who} passes the gate", False, repr(e))
exc = refused("nobody suspends the Host role on their own account",
              users_svc.suspend_host("ops-1", WHY, OPS), users_svc.ProtectedTarget)
exc = refused("…or on an internal staff account", users_svc.suspend_host("sup-1", WHY, OPS), users_svc.ProtectedTarget)
exc = refused("…and the route says 403", users_router.suspend_host("ops-1", suspend_body(), OPS), HTTPException)
ok("…403", exc is not None and exc.status_code == 403)

# ══════════════════════════════════════════════════════════════════════════════
print("4. Resume: the same record, the status it had before")

res = run(users_router.resume_host("h-1", reason_body("Spoke to the host; booked calls honoured."), OPS))
eq("resume answers the status the record had before the suspension",
   (res["uid"], res["host"]["status"]), ("h-1", PRIOR_STATUS))
eq("…which is the inventory's word for a current Host", PRIOR_STATUS, "active")
eq("…notified both", res["notified"], {"host": True, "agency": True})
doc = stored("h-1")
eq("the pause is cleared", (doc.get("hostSuspended"), "hostSuspendedUntil" in doc, "hostSuspendedReason" in doc,
                            "hostSuspensionDays" in doc, "hostStatusBeforeSuspension" in doc),
   (False, False, False, False, False))
ok("…the stamps stay as history, the resume is stamped",
   doc.get("hostSuspendedBy") == "ops-1" and doc.get("hostResumedBy") == "ops-1")
eq("…the same record: Host, verified, same agency, same roster row",
   (doc["isHost"], doc["isVerifiedHost"], doc["agencyId"], roster("AG-h")["h-1"]["active"]), (True, True, "AG-h", True))
ok("…frozen money is NOT released by a resume (the Owner decides)",
   doc.get("payoutHold") is True and (freeze_of("h-1") or {}).get("status") == "frozen" and res["money_released"] is False)
rows = audit_rows("h-1", "host.resumed")
ok("ONE host.resumed row, with what it gave back",
   len(rows) == 1 and rows[0]["after"]["hostStatus"] == "active" and rows[0]["meta"]["lifted_by"] == "manual resume"
   and str(rows[0]["_id"]) == str(res["audit_id"]), str(rows))
ok("the host and the agency are told", any(n["type"] == "host_resumed" for n in notices_for("h-1"))
   and any(n["type"] == "agency_host_resumed" for n in notices_for("h-owner")))
eq("the role inventory is active again", next(r for r in run(ur.roles_for_crm("h-1"))["roles"] if r["role"] == "host")["status"],
   "active")
exc = refused("resuming a Host that is not suspended", users_router.resume_host("h-1", reason_body("Again, by mistake."), OPS),
              HTTPException)
ok("…400", exc is not None and exc.status_code == 400 and "not suspended" in str(exc.detail))
exc = refused("Support cannot resume either (same gate)", gate(SUPPORT), HTTPException)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Revoked is never resumed; revoking a suspended Host ends the pause")

exc = refused("a revoked Host is not resumed", users_router.resume_host("h-rev", reason_body("Please resume."), OPS),
              HTTPException)
ok("…400, pointing at reinstatement", exc is not None and exc.status_code == 400 and "reinstatement" in str(exc.detail))
run(users_svc.suspend_host("h-1", WHY, OPS))
eq("an indefinite suspension carries no date", ("hostSuspendedUntil" in stored("h-1"), stored("h-1")["hostSuspended"]),
   (False, True))
run(users_svc.revoke_host("h-1", "Revoked after the review of the suspension.", OPS))
doc = stored("h-1")
eq("revoking the suspended Host ends the role AND the pause", (doc["isHost"], doc["hostSuspended"],
                                                                "hostSuspendedReason" in doc), (False, False, False))
ok("…recorded on the revocation", (audit_rows("h-1", "host.revoked") or [{}])[-1].get("meta", {}).get(
    "host_suspension_superseded") is True)
exc = refused("…and it cannot be resumed afterwards", users_svc.resume_host("h-1", "Please resume it.", OPS),
              users_svc.UserError)
ok("…the refusal names reinstatement", exc is not None and "reinstatement" in str(exc))

# A single-role Host: still holds its only role while suspended; resume only.
host("h-only")
run(users_svc.suspend_host("h-only", WHY, OPS, days=2))
inv = run(ur.roles_for_crm("h-only"))
eq("a single-role suspended Host: held 1, actions resume only", (inv["held_count"], inv["roles"][0]["actions"]),
   (1, ["resume"]))
# A restricted account: the role is not resumed onto it.
stored("h-only").update({"accountState": "suspended", "isSuspended": True, "isBanned": True})
exc = refused("no resume onto a suspended account", users_svc.resume_host("h-only", "Lift it now.", OPS),
              users_svc.UserError)
ok("…saying to lift that first", exc is not None and "Lift that first" in str(exc))
stored("h-only").update({"accountState": "active", "isSuspended": False, "isBanned": False})

# ══════════════════════════════════════════════════════════════════════════════
print("6. The daily sweep resumes a timed suspension whose date has passed")

sched = (ROOT / "app" / "services" / "scheduling.py").read_text()
tail = sched.split("lift_expired_host_suspensions(", 1)[1][:600] if "lift_expired_host_suspensions(" in sched else ""
found_uid = re.search(r'"uid":\s*"([^"]+)"', tail)
SWEEP_UID = found_uid.group(1) if found_uid else ""
ok("scheduling.daily runs the Host sweep with a system actor", SWEEP_UID.startswith(audit_mod.SYSTEM_UID_PREFIX), SWEEP_UID)
ok("…and records it on the run", '"host_suspensions_lifted": host_suspensions' in sched)
SWEEP = {"uid": SWEEP_UID or "system:host_suspension_sweep", "name": "Scheduled job", "role": "system"}

host("h-timed")
run(users_svc.suspend_host("h-timed", WHY, OPS, days=1))
stored("h-timed")["hostSuspendedUntil"] = datetime.now(timezone.utc) - timedelta(hours=2)
host("h-forever")
run(users_svc.suspend_host("h-forever", WHY, OPS))
host("h-later")
run(users_svc.suspend_host("h-later", WHY, OPS, days=5))
swept = run(users_svc.lift_expired_host_suspensions(SWEEP))
eq("only the expired one is resumed (h-only's term is also still running)", (swept["lifted"], swept["failed"]),
   (["h-timed"], []))
eq("…the indefinite and the running ones stay suspended",
   (stored("h-forever")["hostSuspended"], stored("h-later")["hostSuspended"], stored("h-timed")["hostSuspended"]),
   (True, True, False))
rows = audit_rows("h-timed", "host.resumed")
ok("…audited as host.resumed by the machine, saying the sweep lifted it",
   len(rows) == 1 and rows[0]["actor"]["uid"] == SWEEP["uid"] and rows[0]["actor"]["is_system"] is True
   and rows[0]["meta"]["lifted_by"] == "scheduled sweep", str(rows))
again = run(users_svc.lift_expired_host_suspensions(SWEEP))
eq("a second run finds nothing to do", again["lifted"], [])

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} Host-role suspension checks passed.")
print("  · only the Host role pauses: record, verification, roster, earnings, account and other roles kept")
print("  · live rooms ended, host money frozen for the Owner, host + agency told, host.suspended / host.resumed audited")
print("  · idempotent repeat; non-Host / revoked / short reason / bad term refused; the write is conditional")
print("  · resume gives back the previous status; revoked is never resumed; the daily sweep lifts expired terms")
print("  · the revoke-host gate: Ops Admin and the Owner pass, Support and the Observer never\n")
