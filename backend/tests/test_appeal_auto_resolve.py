"""A restriction lifted by hand, with an appeal still waiting.

`overturned` means a reviewer read the appeal and found the original decision
wrong. An administrator lifting a suspension early has found nothing of the
sort — they may have had a reason that has nothing to do with the appeal at all.
Writing `overturned` for both would put a false statement in the moderation
record, and the appeals module argues against exactly that kind of lie
elsewhere in its own docstring.

So there is a fourth status, `resolved`, and this file is about the three
questions it raises:

  WHEN does it get written?   Only when an administrator lifts a restriction
                              through the HTTP endpoint. Not the nightly sweep,
                              not `decide_appeal`'s own reversal.
  WHO appears to have done it? Nobody. No `decidedBy`, no reviewer identity —
                              populating those would manufacture a reviewer who
                              never read the appeal, and would quietly satisfy
                              the four-eyes check next time anybody looked.
  CAN a reviewer choose it?   No. `resolved` is not a verdict, and
                              `decide_appeal` refuses it explicitly.

── THE TEST THAT MATTERS MOST ────────────────────────────────────────────────

`natural suspension expiry leaves the appeal pending`. Expiry is the COMMON
path — most suspensions end by running out, not by being lifted. If that case
ever auto-resolved, the queue would drain itself and the appeals nobody had
read would look answered.

── WHAT IS REAL HERE AND WHAT IS NOT ─────────────────────────────────────────

REAL: `appeals.auto_resolve_pending` and `decide_appeal`, the router handlers,
      and the audit writer, all imported and called.
FAKE: Firestore and Mongo, from `tests/fakes.py`.

The fake transaction applies writes immediately and does not model contention
(see `fakes.FakeTransaction`). So the compare-and-set is genuinely exercised —
a second call finds the status moved and writes nothing — but a true concurrent
race is not, and no claim is made that it is.

Run:  python3 -m tests.test_appeal_auto_resolve
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
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


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── Fixtures ─────────────────────────────────────────────────────────────────

ADMIN = {"uid": "admin1", "name": "Ops Admin", "role": "ops_admin"}
OTHER = {"uid": "admin2", "name": "Second Admin", "role": "ops_admin"}
#: The sweep runs as the system, not as a person.
SYSTEM = {"uid": "system", "name": "Scheduled sweep", "role": "system"}

fs: FakeFirestore
db: FakeDb


def reset() -> None:
    """A clean store, with the modules repointed at it.

    The same two seams `test_moderation.py` uses: `audit.get_db` for Mongo and
    `firebase.firestore_client` for Firestore. `appeals` and `users` both reach
    Firestore through `firebase.firestore_client()` at call time rather than
    holding a client, so patching the one function covers both.
    """
    global fs, db
    fs = FakeFirestore()
    db = FakeDb()
    firebase_mod._fs = fs
    firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
    audit_mod.get_db = lambda: db  # type: ignore[assignment]
    # `users.ensure_ordinary_target` reads the Mongo `staff` collection to
    # decide whether a subject is a protected internal identity, so the
    # service needs the same fake db the audit writer has.
    svc.get_db = lambda: db  # type: ignore[assignment]


def seed_user(uid: str, **fields) -> None:
    base = {"uid": uid, "name": "Test Person", "isBanned": False, "isSuspended": False}
    base.update(fields)
    fs.collection("users").document(uid).set(base)


def seed_appeal(appeal_id: str, uid: str, status: str = "pending", **extra) -> None:
    doc = {
        "subjectUid": uid,
        "subjectName": "Test Person",
        "raisedByUid": uid,
        "raisedByName": "Test Person",
        "raisedByRole": "self",
        "agencyId": "",
        "kind": "ban",
        "reportId": "",
        "statement": "I believe this restriction was applied in error, please review.",
        "evidenceUrls": [],
        "status": status,
        "createdAt": datetime.now(timezone.utc),
        "originalDecidedBy": "",
    }
    doc.update(extra)
    fs.collection("appeals").document(appeal_id).set(doc)


def appeal(appeal_id: str) -> dict:
    return fs.collection("appeals").document(appeal_id).get().to_dict() or {}


def audit_actions() -> list[str]:
    return [e.get("action") for e in db[C.AUDIT].docs]


# ── 1 & 2. Manual removal resolves a pending appeal ──────────────────────────

print("── manual removal, with an appeal waiting ───────────────────────────────")

reset()
seed_user("u1", isBanned=True, banReason="spam", accountState="banned")
seed_appeal("a1", "u1")
run(appeals_svc.auto_resolve_pending("u1", ADMIN, trigger="unban"))
check("1. manual unban resolves the pending appeal", appeal("a1")["status"], "resolved")
check(
    "1. the reason says what actually happened",
    appeal("a1")["decisionReason"],
    appeals_svc.AUTO_RESOLVE_REASON,
)
ok("1. it is marked as auto-resolved", appeal("a1").get("autoResolved") is True)
ok("1. the trigger is recorded", appeal("a1").get("resolvedTrigger") == "unban")

reset()
seed_user("u2", isSuspended=True, accountState="suspended")
seed_appeal("a2", "u2")
run(appeals_svc.auto_resolve_pending("u2", ADMIN, trigger="resume"))
check("2. manual resume resolves the pending appeal", appeal("a2")["status"], "resolved")
ok("2. the trigger distinguishes it from an unban",
   appeal("a2").get("resolvedTrigger") == "resume")

# ── No fake reviewer, ever ───────────────────────────────────────────────────

ok("no decidedBy is written", not appeal("a2").get("decidedBy"))
ok("no decidedByName is written", not appeal("a2").get("decidedByName"))
ok("no decidedByRole is written", not appeal("a2").get("decidedByRole"))
ok("no decidedAt is written", appeal("a2").get("decidedAt") is None)
check(
    "who lifted the RESTRICTION is recorded separately",
    appeal("a2").get("resolvedBy"),
    "admin1",
)

# ── The original appeal survives ─────────────────────────────────────────────

ok("the statement is preserved", appeal("a2")["statement"].startswith("I believe"))
check("the raiser is preserved", appeal("a2")["raisedByUid"], "u2")
check("the kind is preserved", appeal("a2")["kind"], "ban")

# ── Audit ────────────────────────────────────────────────────────────────────

ok("a distinct audit action is written", "appeal.auto_resolved" in audit_actions())
ok(
    "it is NOT recorded as an overturn",
    "appeal.overturned" not in audit_actions(),
)
entry = next(e for e in db[C.AUDIT].docs if e["action"] == "appeal.auto_resolved")
check("the audit says no review happened", entry["meta"]["reviewed"], False)
check("the audit names the appeal", entry["meta"]["appeal_id"], "a2")

# ── 3 & 4. Nothing pending — nothing happens ─────────────────────────────────

print("── no pending appeal ────────────────────────────────────────────────────")

reset()
seed_user("u3", isBanned=True)
result = run(appeals_svc.auto_resolve_pending("u3", ADMIN, trigger="unban"))
check("3. unban with no appeal at all returns nothing", result, None)
check("3. and writes no audit entry", audit_actions(), [])

reset()
seed_user("u4", isSuspended=True)
result = run(appeals_svc.auto_resolve_pending("u4", ADMIN, trigger="resume"))
check("4. resume with no appeal at all returns nothing", result, None)

# ── 10. An already-decided appeal is never touched ───────────────────────────

reset()
seed_user("u5", isBanned=True)
seed_appeal("a5", "u5", status="upheld", decisionReason="The ban stands.",
            decidedBy="reviewer1")
run(appeals_svc.auto_resolve_pending("u5", ADMIN, trigger="unban"))
check("10. an upheld appeal keeps its verdict", appeal("a5")["status"], "upheld")
check("10. and keeps its reviewer", appeal("a5")["decidedBy"], "reviewer1")
check("10. and its reason is not overwritten",
      appeal("a5")["decisionReason"], "The ban stands.")

reset()
seed_user("u6", isBanned=True)
seed_appeal("a6", "u6", status="overturned")
run(appeals_svc.auto_resolve_pending("u6", ADMIN, trigger="unban"))
check("10. an overturned appeal is left alone", appeal("a6")["status"], "overturned")

# ── Another account's pending appeal is not collateral ───────────────────────

reset()
seed_user("mine", isBanned=True)
seed_user("theirs", isBanned=True)
seed_appeal("a-mine", "mine")
seed_appeal("a-theirs", "theirs")
run(appeals_svc.auto_resolve_pending("mine", ADMIN, trigger="unban"))
check("only the subject's appeal moves", appeal("a-mine")["status"], "resolved")
check("someone else's stays pending", appeal("a-theirs")["status"], "pending")

# ── 9. Idempotency ───────────────────────────────────────────────────────────

print("── repeated removal ─────────────────────────────────────────────────────")

reset()
seed_user("u7", isBanned=True)
seed_appeal("a7", "u7")
first = run(appeals_svc.auto_resolve_pending("u7", ADMIN, trigger="unban"))
stamp = appeal("a7")["resolvedAt"]
second = run(appeals_svc.auto_resolve_pending("u7", OTHER, trigger="unban"))
third = run(appeals_svc.auto_resolve_pending("u7", OTHER, trigger="unban"))
ok("9. the first call resolves it", first is not None)
check("9. the second call is a no-op", second, None)
check("9. the third too", third, None)
check("9. the timestamp is not rewritten", appeal("a7")["resolvedAt"], stamp)
check("9. the first admin stays on the record", appeal("a7")["resolvedBy"], "admin1")
check(
    "9. exactly one audit entry for one event",
    audit_actions().count("appeal.auto_resolved"),
    1,
)

# ── 5. Natural expiry must NOT resolve — the one that matters most ───────────

print("── natural suspension expiry ────────────────────────────────────────────")

reset()
past = datetime.now(timezone.utc) - timedelta(days=1)
seed_user("u8", isSuspended=True, accountState="suspended", suspendedUntil=past)
seed_appeal("a8", "u8")
run(svc.lift_expired_suspensions(SYSTEM))
check(
    "5. the sweep still lifts the suspension",
    (fs.collection("users").document("u8").get().to_dict() or {}).get("isSuspended"),
    False,
)
check(
    "5. BUT the appeal stays pending — nobody answered it",
    appeal("a8")["status"],
    "pending",
)
ok(
    "5. and no auto-resolution was audited",
    "appeal.auto_resolved" not in audit_actions(),
)

# ── 6 & 7. decide_appeal still owns the real verdicts ────────────────────────

print("── reviewer decisions ───────────────────────────────────────────────────")

reset()
seed_user("u9", isBanned=True, accountState="banned", banReason="spam")
seed_appeal("a9", "u9")
run(appeals_svc.decide_appeal("a9", "overturned", "Reviewed, the ban was wrong.", ADMIN))
check("6. an overturn is recorded as overturned", appeal("a9")["status"], "overturned")
ok("6. NOT as resolved", appeal("a9")["status"] != "resolved")
check("6. and the reviewer is named", appeal("a9")["decidedBy"], "admin1")
ok("6. audited as an overturn", "appeal.overturned" in audit_actions())
ok(
    "6. the reversal did not also auto-resolve it",
    audit_actions().count("appeal.auto_resolved") == 0,
)

reset()
seed_user("u10", isBanned=True, accountState="banned")
seed_appeal("a10", "u10")
run(appeals_svc.decide_appeal("a10", "upheld", "The original decision stands.", ADMIN))
check("7. an uphold is recorded as upheld", appeal("a10")["status"], "upheld")
check("7. and the reason reaches the record",
      appeal("a10")["decisionReason"], "The original decision stands.")

# ── 8. `resolved` is not a verdict ───────────────────────────────────────────

print("── resolved is not a reviewer verdict ───────────────────────────────────")


def refused(label: str, fn) -> str:
    global checks
    checks += 1
    try:
        fn()
    except appeals_svc.AppealError as exc:
        return str(exc)
    failures.append(f"{label}: was NOT refused")
    return ""


reset()
seed_user("u11", isBanned=True, accountState="banned")
seed_appeal("a11", "u11")
msg = refused(
    "8. a reviewer cannot submit 'resolved'",
    lambda: run(appeals_svc.decide_appeal("a11", "resolved", "trying it on", ADMIN)),
)
ok("8. and is told what a verdict must be", "upheld" in msg and "overturned" in msg)
check("8. the appeal is untouched", appeal("a11")["status"], "pending")

refused(
    "8. 'pending' is still refused as a verdict",
    lambda: run(appeals_svc.decide_appeal("a11", "pending", "trying it on", ADMIN)),
)
refused(
    "8. and so is anything else",
    lambda: run(appeals_svc.decide_appeal("a11", "dismissed", "trying it on", ADMIN)),
)
ok(
    "8. RESOLVED is in the enum but not in VERDICTS",
    appeals_svc.AppealStatus.RESOLVED not in appeals_svc.VERDICTS
    and appeals_svc.AppealStatus.RESOLVED in set(appeals_svc.AppealStatus),
)
check(
    "8. VERDICTS is exactly the two real ones",
    {str(v) for v in appeals_svc.VERDICTS},
    {"upheld", "overturned"},
)

# ── 11. Four-eyes is unchanged ───────────────────────────────────────────────

print("── four eyes ────────────────────────────────────────────────────────────")

reset()
seed_user("u12", isBanned=True, accountState="banned")
seed_appeal("a12", "u12", originalDecidedBy="admin1")
msg = refused(
    "11. the original decider still cannot decide their own appeal",
    lambda: run(appeals_svc.decide_appeal("a12", "overturned", "Changed my mind.", ADMIN)),
)
ok("11. and is told why", "cannot decide" in msg.lower())
run(appeals_svc.decide_appeal("a12", "overturned", "Reviewed by a second pair of eyes.", OTHER))
check("11. a different reviewer may", appeal("a12")["status"], "overturned")

# ── Auto-resolution does not create a reviewer who could later self-approve ──

reset()
seed_user("u13", isBanned=True)
seed_appeal("a13", "u13", originalDecidedBy="admin1")
run(appeals_svc.auto_resolve_pending("u13", ADMIN, trigger="unban"))
ok(
    "auto-resolution leaves originalDecidedBy alone",
    appeal("a13")["originalDecidedBy"] == "admin1",
)
ok(
    "and writes no decidedBy that four-eyes would later read",
    not appeal("a13").get("decidedBy"),
)

# ── 12. Regression: the duplicate rule is untouched ──────────────────────────

print("── the duplicate-appeal rule is unchanged ───────────────────────────────")

reset()
seed_user("u14", isBanned=True)
seed_appeal("a14", "u14", kind="report")
run(appeals_svc.auto_resolve_pending("u14", ADMIN, trigger="unban"))
check(
    "a pending appeal of ANY kind is resolved — no kind filter was added",
    appeal("a14")["status"],
    "resolved",
)

# UGP review: an appeal from the public web form does not block the owner's own,
# so two can be pending at once — and lifting the restriction resolves BOTH.
reset()
seed_user("u15", isBanned=True)
seed_appeal("a15-web", "u15", source="public_web", raisedByUid="", raisedByRole="public")
seed_appeal("a15-app", "u15")
out15 = run(appeals_svc.auto_resolve_pending("u15", ADMIN, trigger="unban"))
check("two pending appeals: the public-web one is resolved", appeal("a15-web")["status"], "resolved")
check("…and the owner's own one too", appeal("a15-app")["status"], "resolved")
ok("…the answer names the second as well", len((out15 or {}).get("also_resolved", [])) == 1)
check("…each with its own audit entry",
      sum(1 for a in audit_actions() if a == "appeal.auto_resolved"), 2)

# …and when a reviewer OVERTURNS one of the two, the restriction is lifted and
# the other has nothing left to decide: it is resolved too, with its own trigger.
reset()
seed_user("u16", isBanned=True, accountState="banned", bannedBy="staff-ban-16")
seed_appeal("a16-app", "u16")
seed_appeal("a16-web", "u16", source="public_web", raisedByUid="", raisedByRole="public")
out16 = run(appeals_svc.decide_appeal("a16-app", "overturned", "The evidence shows it was not them.", OTHER))
check("the overturned appeal is overturned", appeal("a16-app")["status"], "overturned")
check("…the other pending appeal is resolved", appeal("a16-web")["status"], "resolved")
check("…as triggered by the overturn", appeal("a16-web").get("resolvedTrigger"), "appeal_overturned")
check("…with a reason that says what happened", appeal("a16-web")["decisionReason"],
      appeals_svc.OVERTURN_RESOLVE_REASON)
check("…and the decision says so", out16.get("also_resolved"), ["a16-web"])

src = (ROOT / "app" / "services" / "appeals.py").read_text(encoding="utf-8")
block = src[src.index("async def auto_resolve_pending"):]
ok(
    "the query filters on subjectUid and status only",
    '"subjectUid", "=="' in block and '"status", "=="' in block,
)
ok(
    "and never on kind",
    '"kind", "=="' not in block,
)

# ── THE WIRING. Found missing by mutation testing. ───────────────────────────
#
# Everything above calls `auto_resolve_pending` directly, which proves the
# function and proves nothing about whether anything CALLS it. Deleting the two
# lines in `routers/users.py` left every assertion above green — so the feature
# could have been disconnected in production and this file would not have
# noticed. These go through the route handlers instead.

print("── the route handlers actually call it ──────────────────────────────────")


def reason(text: str = "Lifting this after review of the circumstances."):
    return users_router.Reason(reason=text)


reset()
seed_user("r1", isBanned=True, accountState="banned", banReason="spam")
seed_appeal("ar1", "r1")
res = run(users_router.unban_user("r1", reason(), ADMIN))
check("POST /{uid}/unban resolves the pending appeal", appeal("ar1")["status"], "resolved")
ok("and the response reports it", isinstance(res, dict) and "appeal_resolved" in res)
check(
    "the response names the appeal",
    (res.get("appeal_resolved") or {}).get("appeal_id"),
    "ar1",
)

reset()
seed_user("r2", isSuspended=True, accountState="suspended")
seed_appeal("ar2", "r2")
res = run(users_router.resume_user("r2", reason(), ADMIN))
check("POST /{uid}/resume resolves the pending appeal", appeal("ar2")["status"], "resolved")
ok("and reports it too", "appeal_resolved" in res)

reset()
seed_user("r3", isBanned=True, accountState="banned")
res = run(users_router.unban_user("r3", reason(), ADMIN))
ok(
    "with no appeal, the response carries no resolution key",
    "appeal_resolved" not in res,
)

# A failure in the appeal half must never cost the unban. The restriction is
# already lifted by then, and an appeal left pending is a queue item — not a
# person locked out.
reset()
seed_user("r4", isBanned=True, accountState="banned")
seed_appeal("ar4", "r4")
_real = appeals_svc.auto_resolve_pending


async def _explode(*a, **k):
    raise RuntimeError("firestore unavailable")


appeals_svc.auto_resolve_pending = _explode  # type: ignore[assignment]
try:
    res = run(users_router.unban_user("r4", reason(), ADMIN))
    ok("an auto-resolve failure does not fail the unban", isinstance(res, dict))
    check(
        "and the account is still unbanned",
        (fs.collection("users").document("r4").get().to_dict() or {}).get("isBanned"),
        False,
    )
finally:
    appeals_svc.auto_resolve_pending = _real  # type: ignore[assignment]


# ── The inner compare-and-set, exercised on its own ──────────────────────────
#
# Also found by mutation testing: removing the `status != pending` guard INSIDE
# the transaction broke nothing, because the outer query already filters on
# pending and short-circuits on the second call.
#
# The guard is not redundant — it covers the window between the query and the
# transaction, where a reviewer could decide the same appeal in the CRM. The
# fake cannot produce real contention, so the window is simulated: the status
# is moved after the query has selected the document and before the
# transactional read sees it.

print("── the compare-and-set inside the transaction ───────────────────────────")

reset()
seed_user("r5", isBanned=True)
seed_appeal("ar5", "r5")

_doc_get = type(fs.collection("appeals").document("ar5")).get
_flipped = {"done": False}


def _get_racing(self, transaction=None):
    # On the transactional read only, and only once: pretend a reviewer just
    # decided this appeal in the CRM a microsecond ago.
    if transaction is not None and not _flipped["done"]:
        _flipped["done"] = True
        self.col.docs[self.id]["status"] = "upheld"
    return _doc_get(self, transaction=transaction)


type(fs.collection("appeals").document("ar5")).get = _get_racing  # type: ignore[assignment]
try:
    out = run(appeals_svc.auto_resolve_pending("r5", ADMIN, trigger="unban"))
    check("a verdict that landed first is not overwritten", appeal("ar5")["status"], "upheld")
    check("and the auto-resolve reports it did nothing", out, None)
    ok("no audit entry for a resolution that did not happen",
       "appeal.auto_resolved" not in audit_actions())
finally:
    type(fs.collection("appeals").document("ar5")).get = _doc_get  # type: ignore[assignment]


# ── Report ───────────────────────────────────────────────────────────────────

print()
if failures:
    print(f"{len(failures)} FAILED of {checks} checks:\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"All {checks} appeal auto-resolution checks passed.")
print("  · a manual unban or resume closes a pending appeal as `resolved`")
print("  · no reviewer identity is invented, and four-eyes stays honest")
print("  · natural suspension expiry leaves the appeal PENDING")
print("  · `decide_appeal` still owns `upheld` and `overturned`, and refuses `resolved`")
print("  · repeating a removal writes nothing a second time")
print()
print("  The fake transaction does not model contention — the compare-and-set is")
print("  exercised, a genuine concurrent race is not.")
