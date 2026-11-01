"""B2 (Phase 1A.2) — ACCT-001: a suspension never overwrites or clears a ban.

Suspending an account that was banned used to succeed, and it REPLACED the ban:
`accountState` became 'suspended' and the ban's reason was overwritten. From then
on Unban refused the account ("suspended, not banned"), while Resume — or the
nightly sweep, once a timed suspension's term ran out — cleared `isBanned` and let
the account back into the app, with the device bans the ban had placed left
behind and nothing on the record saying why.

Both ways into a suspension are covered:

  * the direct one — `POST /users/{uid}/suspend` → `users.suspend_user`;
  * the report-driven one — `users.action_report(..., 'suspend')`, which calls
    the same service function and carries the decision out BEFORE closing the
    report, so a refused suspension must leave the report open and unaudited.

And the two ways a suspension ends — Resume and `lift_expired_suspensions` — are
shown not to lift the ban afterwards.

Controls, so the fix cannot be "refuse everything": suspending an ordinary
account, re-suspending a suspended one with a new term, banning a suspended one,
suspending again after an Unban, and a report suspending an ordinary account all
still work.

No database and no network: `tests/harness.py` stubs the I/O and `tests/fakes.py`
provides the in-memory Firestore. Everything under `app/` is the real code.

Run:  python3 -m tests.test_suspend_ban_precedence
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
    """Refused through the route — a 400 with a message."""
    global checks
    checks += 1
    try:
        result = fn()
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "status_code", None) == 400:
            return str(getattr(exc, "detail", ""))
        failures.append(f"{label}: raised {type(exc).__name__}({exc}) — wanted 400")
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


def refuses(label: str, fn) -> str:
    """Refused by the service — a `UserError` with a message."""
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


def succeeds(label: str, fn):
    """Must go through. A refusal is recorded as a failure instead of crashing the run."""
    global checks
    checks += 1
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        detail = getattr(exc, "detail", None) or str(exc)
        failures.append(f"{label}: was refused — {type(exc).__name__}: {detail}")
        return None


def run(coro):
    return asyncio.run(coro)


# ══════════════════════════════════════════════════════════════════════════════
#  The world — the same fakes and field names as tests/test_moderation.py
# ══════════════════════════════════════════════════════════════════════════════

db = FakeDb()
audit_mod.get_db = lambda: db  # type: ignore[assignment]
svc.get_db = lambda: db  # type: ignore[assignment]

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

# A suspension revokes the account's sessions; a REFUSED one must not.
revoked: list[str] = []
firebase_mod.revoke_sessions = lambda uid: (revoked.append(uid), "")[1]  # type: ignore[assignment]

logging.getLogger("app.services.users").setLevel(logging.CRITICAL)


def internal(uid: str, role: Role, team=None) -> dict:
    return {"uid": uid, "name": uid, "role": role, "team": team}


OPS = internal("uid-ops", Role.OPS_ADMIN, Team.OPS)
OWNER = internal("uid-owner", Role.OWNER)

# The nightly sweep's actor, read out of scheduling.py exactly as
# test_moderation does, so this stays true if somebody changes it.
_SCHEDULING = (ROOT / "app" / "services" / "scheduling.py").read_text()
_found = re.search(r'"uid":\s*"([^"]+)"', _SCHEDULING.split("lift_expired_suspensions(", 1)[1][:1200])
SWEEP = {"uid": _found.group(1) if _found else "", "name": "Scheduled job", "role": "system"}

BAN_WHY = "Ran a fake-recharge scheme across four party rooms."
SUSPEND_WHY = "Abusive messages in a party room after a written warning."


def user(uid: str, *, devices: tuple[str, ...] = (), **over) -> dict:
    doc = {"name": f"user {uid}", "isBanned": False, "isSuspended": False, "accountState": "active"}
    doc.update(over)
    fs.collection(svc.USERS).docs[uid] = dict(doc)
    for device_id in devices:
        fs.collection(svc.USERS).document(uid).collection(svc.DEVICES).docs[device_id] = {
            "deviceId": device_id, "platform": "android",
        }
    return doc


def stored(uid: str) -> dict:
    return fs.collection(svc.USERS).docs.get(uid, {})


def actions(uid: str) -> list[str]:
    return [d["action"] for d in db[C.AUDIT].docs if d["subject"]["id"] == uid]


def report(report_id: str, target_uid: str) -> None:
    fs.collection(svc.REPORTS).docs[report_id] = {
        "status": "pending",
        "targetUid": target_uid,
        "reporterUid": "u-reporter",
        "reason": "Posting scam links in a party room.",
    }


def report_doc(report_id: str) -> dict:
    return fs.collection(svc.REPORTS).docs.get(report_id, {})


def reason_body(text: str):
    return users_router.Reason(reason=text)


def suspend_body(text: str, days: int | None = None):
    return users_router.Suspend(reason=text, days=days)


ok("the sweep's actor was found in scheduling.py", bool(SWEEP["uid"]))


# ══════════════════════════════════════════════════════════════════════════════
#  1. The direct path — POST /users/{uid}/suspend on a banned account
# ══════════════════════════════════════════════════════════════════════════════

user("u-banned", devices=("phone-b1",))
succeeds("seed: the account is banned", lambda: run(users_router.ban_user("u-banned", reason_body(BAN_WHY), OPS)))
check("seed: it is banned", stored("u-banned").get("accountState"), "banned")

banned_before = dict(stored("u-banned"))
audit_before = actions("u-banned")
revoked.clear()

msg = rejects(
    "suspending a banned account through the route is refused (400)",
    lambda: run(users_router.suspend_user("u-banned", suspend_body(SUSPEND_WHY), OPS)),
)
ok("…and the refusal says the account is banned", "banned" in msg.lower())
ok("…and names Unban as the way to change it", "unban" in msg.lower())
check("the account document is untouched", stored("u-banned"), banned_before)
check("…it is still banned", stored("u-banned").get("accountState"), "banned")
check("…and still carries the BAN's reason", stored("u-banned").get("banReason"), BAN_WHY)
check("no audit entry was written for the refused suspension", actions("u-banned"), audit_before)
check("…and it revoked no sessions", revoked, [])

rejects(
    "a TIMED suspension of a banned account is refused too",
    lambda: run(users_router.suspend_user("u-banned", suspend_body(SUSPEND_WHY, days=3), OPS)),
)
ok("…and no end date was written for the sweep to act on", "suspendedUntil" not in stored("u-banned"))
check("…the document is still untouched", stored("u-banned"), banned_before)

# A ban recorded before `accountState` existed: only `isBanned` says so.
user("u-legacy-ban", isBanned=True, banReason="Old ban, before accountState.")
del fs.collection(svc.USERS).docs["u-legacy-ban"]["accountState"]
legacy_before = dict(stored("u-legacy-ban"))
refuses(
    "a ban recorded only as isBanned (no accountState) is recognised and refused",
    lambda: run(svc.suspend_user("u-legacy-ban", SUSPEND_WHY, OPS)),
)
check("…and that document is untouched too", stored("u-legacy-ban"), legacy_before)


# ══════════════════════════════════════════════════════════════════════════════
#  2. The ban is still a ban afterwards — Resume cannot lift it, Unban can
# ══════════════════════════════════════════════════════════════════════════════

msg = refuses(
    "Resume still refuses the account — the ban was not turned into a suspension",
    lambda: run(svc.resume_user("u-banned", "Term over.", OPS)),
)
ok("…and the refusal names Unban", "unban" in msg.lower())
check("…the account is still shut out", stored("u-banned").get("isBanned"), True)

succeeds(
    "Unban still lifts it, because it is still a ban",
    lambda: run(users_router.unban_user("u-banned", reason_body("Reviewed: the scheme was another user."), OWNER)),
)
check("…and the account is active again", stored("u-banned").get("accountState"), "active")
check("…with the BAN's reason preserved as the previous reason",
      stored("u-banned").get("previousBanReason"), BAN_WHY)


# ══════════════════════════════════════════════════════════════════════════════
#  3. The nightly sweep cannot lift a ban through a suspension's term
# ══════════════════════════════════════════════════════════════════════════════

user("u-banned-timed", devices=("phone-t1",))
succeeds("seed: banned", lambda: run(users_router.ban_user("u-banned-timed", reason_body(BAN_WHY), OPS)))
rejects(
    "a one-day suspension of the banned account is refused",
    lambda: run(users_router.suspend_user("u-banned-timed", suspend_body(SUSPEND_WHY, days=1), OPS)),
)
# Two days pass. If a term had been written, it has now run out.
_doc = fs.collection(svc.USERS).docs["u-banned-timed"]
if "suspendedUntil" in _doc:
    _doc["suspendedUntil"] = datetime.now(timezone.utc) - timedelta(days=1)
swept = run(svc.lift_expired_suspensions(SWEEP))
ok("the nightly sweep lifted nothing for the banned account", "u-banned-timed" not in swept["lifted"])
check("…it is still banned", stored("u-banned-timed").get("accountState"), "banned")
check("…still shut out of the app", stored("u-banned-timed").get("isBanned"), True)
check("…with the ban's own reason", stored("u-banned-timed").get("banReason"), BAN_WHY)
ok("…and the log holds no 'user.resumed' for it", "user.resumed" not in actions("u-banned-timed"))


# ══════════════════════════════════════════════════════════════════════════════
#  4. The report-driven path — action_report(…, 'suspend') on a banned account
# ══════════════════════════════════════════════════════════════════════════════

user("u-reported", devices=("phone-r1",))
succeeds("seed: banned", lambda: run(users_router.ban_user("u-reported", reason_body(BAN_WHY), OPS)))
report("rep-banned", "u-reported")

reported_before = dict(stored("u-reported"))
report_before = dict(report_doc("rep-banned"))
audit_count_before = len(db[C.AUDIT].docs)
revoked.clear()

msg = refuses(
    "deciding a report with 'suspend' against a banned account is refused",
    lambda: run(svc.action_report("rep-banned", "suspend", SUSPEND_WHY, OPS, days=7)),
)
ok("…with the same explanation, naming Unban", "unban" in msg.lower())
check("the reported account is untouched", stored("u-reported"), reported_before)
check("the report stays OPEN — nothing was enforced, so nothing is closed",
      report_doc("rep-banned"), report_before)
check("no audit entry at all — neither a suspension nor a report decision",
      len(db[C.AUDIT].docs), audit_count_before)
check("…and no sessions were revoked", revoked, [])


# ══════════════════════════════════════════════════════════════════════════════
#  5. Controls — what must still work
# ══════════════════════════════════════════════════════════════════════════════

user("u-ok")
succeeds("an ordinary account can be suspended",
         lambda: run(users_router.suspend_user("u-ok", suspend_body(SUSPEND_WHY, days=2), OPS)))
check("…it is suspended", stored("u-ok").get("accountState"), "suspended")
succeeds("a suspended account can be re-suspended with a new term",
         lambda: run(users_router.suspend_user("u-ok", suspend_body("Extended after review.", days=5), OPS)))
check("…the new term applies", stored("u-ok").get("suspensionDays"), 5)
succeeds("a suspended account can still be BANNED — a ban outranks a suspension",
         lambda: run(users_router.ban_user("u-ok", reason_body(BAN_WHY), OPS)))
check("…it is banned", stored("u-ok").get("accountState"), "banned")
ok("…and the suspension's term went with it", "suspendedUntil" not in stored("u-ok"))
succeeds("…then unbanned", lambda: run(users_router.unban_user("u-ok", reason_body("Appeal upheld."), OWNER)))
succeeds("once unbanned, the account can be suspended again",
         lambda: run(users_router.suspend_user("u-ok", suspend_body(SUSPEND_WHY), OPS)))
check("…it is suspended", stored("u-ok").get("accountState"), "suspended")

user("u-reported-ok")
report("rep-ok", "u-reported-ok")
succeeds("a report can still suspend an ordinary account",
         lambda: run(svc.action_report("rep-ok", "suspend", SUSPEND_WHY, OPS, days=3)))
check("…the account is suspended", stored("u-reported-ok").get("accountState"), "suspended")
check("…and the report is closed as actioned", report_doc("rep-ok").get("status"), "actioned")


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} suspend/ban precedence checks passed.")
print("  · suspending a banned account is refused — through the route (400) and")
print("    through a report decision, which then stays open and unaudited")
print("  · the refusal names Unban; the account, its ban reason, its audit log")
print("    and its sessions are left exactly as they were")
print("  · Resume still refuses the account and Unban still lifts it, because it")
print("    is still a ban; the nightly sweep never resumes it")
print("  · ordinary suspensions, re-suspensions, ban-over-suspension and")
print("    suspension after an Unban all still work")
sys.exit(0)
