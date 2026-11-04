"""A warning is only a warning if the person is told.

── WHAT WAS WRONG ──────────────────────────────────────────────────────────

`warn_user` wrote three things and the user could reach none of them:

  * `users/{uid}/warnings/{id}` — a subcollection with no reader, in the app
    or anywhere else;
  * `users/{uid}.warnings` — a counter;
  * an audit row in Mongo, which is staff-only by design.

The CRM's Warn form says, above the field, "What is being warned about. The
user may be shown this." They were not. The app's Official tab read the
`broadcasts` collection and nothing else, so a formally warned account showed
"Nothing from Zipper yet" — and an appeal against a warning nobody had
received was not something a person could think to file.

── THE COLLECTION, AND WHY THIS ONE ────────────────────────────────────────

There were two candidates, and only one of them can be read by its recipient:

  * `users/{uid}/notifications` — written by the CRM's `respondToTicket`. No
    Android reader. Its own source comment says so.
  * top-level `notifications` — written by four Cloud Functions, and carrying
    the one deployed rule in the codebase that addresses a notification to a
    user:

        match /notifications/{notifId} {
          allow read: if (request.auth != null
                          && resource.data.userId == request.auth.uid)
                      || isAdmin();
        }

The rule names `userId`. All four Functions wrote `targetUid`, which the rule
does not look at — so every notification they have ever written was denied to
the person it was for. The rule is deployed and live-verified and is not being
changed here, so the field is `userId` and the four writers are corrected to
match it. Section 5 asserts both halves of that against the real sources,
because the whole defect was a writer and a rule disagreeing about one field
name and nothing failing loudly when they did.

── WHAT IS ASSERTED ────────────────────────────────────────────────────────

  1. a warning produces a notice the recipient's own rule can read;
  2. it carries the reviewer's reason and NOT the reviewer;
  3. it is idempotent on the warning id, so a retry does not stack;
  4. delivery is best effort — a Firestore failure loses the notice, never
     the warning;
  5. the rule, the four Functions writers, the declared index and the Android
     reader all agree on `userId`.

REAL: `app.services.users.warn_user`.
FAKE: Firestore and Mongo, from `tests/harness.py` and `tests/fakes.py`.

    python3 -m tests.test_official_warning
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
REPO = ROOT.parent

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import users as svc  # noqa: E402

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


def run(coro):
    return asyncio.run(coro)


# ── The world ───────────────────────────────────────────────────────────────

db = FakeDb()
audit_mod.get_db = lambda: db          # type: ignore[assignment]
svc.get_db = lambda: db                # type: ignore[assignment]
fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

# Section 4 makes the notification write fail on purpose, and the service logs
# that at exception level — correct in production, a stack trace in the middle
# of a test table here. The behaviour is asserted, not read out of the log.
logging.getLogger("app.services.users").setLevel(logging.CRITICAL)

OPS = {"uid": "uid-ops", "name": "Priya Nair", "role": Role.OPS_ADMIN, "team": Team.OPS}
WHY = "Sharing another user's phone number in a public room, twice in one night."


def seed(uid: str, **over) -> None:
    fs.collection(svc.USERS).docs[uid] = {
        "name": f"user {uid}",
        "isBanned": False,
        "isSuspended": False,
        "accountState": "active",
        **over,
    }


def notices() -> dict[str, dict]:
    return fs.collection(svc.NOTIFICATIONS).docs


def notices_for(uid: str) -> list[dict]:
    return [d for d in notices().values() if d.get("userId") == uid]


# ══════════════════════════════════════════════════════════════════════════════
#  1. A warning reaches the person
# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The notice exists and is addressed to the user")

seed("u-warned")
res = run(svc.warn_user("u-warned", WHY, OPS))

mine = notices_for("u-warned")
eq("warning a user writes exactly one notice", len(mine), 1)

if not mine:
    # Something was written to `notifications` but it is not addressed to this
    # user — which is precisely the original defect, and the message has to
    # say so rather than let the next line raise an IndexError. Print what WAS
    # written so a field rename names itself.
    print(f"\n  nothing addressed to u-warned. The collection holds: "
          f"{json.dumps(list(notices().values()), default=str)}\n")
    failures.append(
        "the warning wrote no notice this user's own rule could read — "
        "check the field name against firestore.rules:2651 (`userId`)"
    )
    checks += 1

notice = mine[0] if mine else {}
eq("it is addressed on `userId` — the field the deployed read rule tests",
   notice.get("userId"), "u-warned")
ok("and NOT on `targetUid`, which that rule does not look at",
   "targetUid" not in notice,
   "a notice keyed on targetUid is denied to its own recipient")

eq("the body is the reviewer's own sentence", notice.get("body"), WHY)
eq("it is labelled a warning, so the app can mark it as one",
   notice.get("type"), "warning")
ok("it has a title", bool(notice.get("title")))
eq("it starts unread", notice.get("isRead"), False)
ok("it carries a timestamp — Firestore excludes a document from an "
   "orderBy on a field it does not have",
   notice.get("createdAt") is not None)

# The notice id is derived from the warning, which is what makes section 3
# work. Asserted here so a change to the id scheme fails loudly.
doc_id = next((k for k, v in notices().items() if v.get("userId") == "u-warned"), None)
eq("the notice id is derived from the warning id",
   doc_id, f"warning_{res['warning_id']}")

# ══════════════════════════════════════════════════════════════════════════════
#  2. It says what happened, not who did it
# ══════════════════════════════════════════════════════════════════════════════
print("2. The reviewer is not named")

blob = json.dumps(notice, default=str)
for label, secret in (
    ("the actor's uid", OPS["uid"]),
    ("the actor's name", OPS["name"]),
    ("the actor's role", str(OPS["role"])),
    ("the audit id", res["audit_id"]),
):
    ok(f"the notice does not carry {label}", secret not in blob,
       f"{secret!r} found in {blob}")

# `meta` is internal routing — which queue raised the warning, which report it
# came from. None of it is for the user.
seed("u-meta")
run(svc.warn_user("u-meta", WHY, OPS, meta={"report_id": "RPT-884", "queue": "ops"}))
meta_notices = notices_for("u-meta")
meta_blob = json.dumps(meta_notices[0] if meta_notices else {}, default=str)
ok("nor anything out of `meta`",
   bool(meta_notices) and "RPT-884" not in meta_blob and "queue" not in meta_blob)

# What the warning records internally is unchanged — the notice is an
# addition, not a replacement.
warnings_sub = fs.collection(svc.USERS).document("u-warned").collection(svc.WARNINGS)
entry = next(iter(warnings_sub.docs.values()), {})
eq("the internal warning still names the actor", entry.get("issuedBy"), OPS["uid"])
eq("…and their name", entry.get("issuedByName"), OPS["name"])
eq("the counter still moved", fs.collection(svc.USERS).docs["u-warned"]["warnings"], 1)
ok("the audit row is still written",
   any(d["subject"]["id"] == "u-warned" for d in db[C.AUDIT].docs))

# ══════════════════════════════════════════════════════════════════════════════
#  3. A retry does not stack
# ══════════════════════════════════════════════════════════════════════════════
print("3. Idempotence")

# Same warning, delivered twice — the CRM retrying a timed-out POST, or a
# double-press. The id is derived from the warning, so the second write lands
# on the same document.
run(svc._deliver_warning_notice("u-warned", WHY, res["warning_id"], notice.get("createdAt")))
eq("re-delivering the same warning does not add a second notice",
   len(notices_for("u-warned")), 1)

# Two genuinely different warnings are two notices, because each has its own
# warning id. An over-eager key (say, the uid alone) would silently overwrite
# the first one and the user would never see it.
run(svc.warn_user("u-warned", "A second, separate incident in a party room.", OPS))
eq("a second warning is a second notice", len(notices_for("u-warned")), 2)
ok("and the two have different bodies",
   len({n["body"] for n in notices_for("u-warned")}) == 2)

# ══════════════════════════════════════════════════════════════════════════════
#  4. Delivery is best effort; the warning is not
# ══════════════════════════════════════════════════════════════════════════════
print("4. A failed delivery never loses the warning")

seed("u-nodelivery")
fs.collection(svc.NOTIFICATIONS).fail_on("set")
try:
    failed = run(svc.warn_user("u-nodelivery", WHY, OPS))
except Exception as exc:  # noqa: BLE001
    failed = None
    failures.append(f"a Firestore failure on the notice raised {type(exc).__name__}({exc})")
    checks += 1
finally:
    fs.collection(svc.NOTIFICATIONS).clear_failures()

if failed is not None:
    checks += 1
    ok("the call still succeeds when the notice cannot be written", True)
    eq("the warning is still counted",
       fs.collection(svc.USERS).docs["u-nodelivery"]["warnings"], 1)
    sub = fs.collection(svc.USERS).document("u-nodelivery").collection(svc.WARNINGS)
    eq("the warning is still recorded", len(sub.docs), 1)
    ok("it is still audited",
       any(d["subject"]["id"] == "u-nodelivery" for d in db[C.AUDIT].docs))
    ok("and the caller still gets a warning id back", bool(failed.get("warning_id")))
    eq("no notice was written", len(notices_for("u-nodelivery")), 0)

# The ordering is the reason the above holds: the notice is written after the
# audit row, so there is no path where a delivery failure rolls back a
# decision that has already been made.
src = inspect.getsource(svc.warn_user)
deliver_at = src.find("_deliver_warning_notice")
ok("warn_user delivers the notice at all", deliver_at >= 0,
   "the call is gone — this is the state the bug report described: three "
   "records written, none of them reachable by the user")
ok("the notice is written AFTER the audit row",
   deliver_at >= 0 and src.index("audit.record") < deliver_at,
   "delivery must not precede the authoritative records")
ok("…and after the counter patch",
   deliver_at >= 0 and src.index("_patch_user") < deliver_at)

# The failure handling lives in the shared writer now — `services/notices`
# is the one mechanism for every Official message — so that is what is read.
from app.services import notices as notices_mod  # noqa: E402

delivery_src = inspect.getsource(svc._deliver_warning_notice)
ok("the warning helper delegates to the shared notice writer",
   "notices.official_warning(" in delivery_src or "notices.deliver(" in delivery_src)
# §12: `deliver` is the public entry; `deliver_notice` builds the document and
# `_write_in_app` is the one Firestore write — the failure handling lives there.
writer_src = inspect.getsource(notices_mod.deliver_notice) + inspect.getsource(notices_mod._write_in_app)
ok("the shared writer swallows its own failures", "except Exception" in writer_src)
ok("…and logs them rather than discarding them", "log.exception" in writer_src)
ok("…and addresses on userId", '"userId": uid' in writer_src)

# ══════════════════════════════════════════════════════════════════════════════
#  5. Every writer, the rule, the index and the reader agree on `userId`
# ══════════════════════════════════════════════════════════════════════════════
print("5. One field name, across four codebases")

# ── the deployed rule ───────────────────────────────────────────────────────
rules = (REPO / "firestore.rules").read_text()
block = re.search(
    r"match /notifications/\{\w+\}\s*\{(.*?)\n    \}", rules, re.S
)
ok("firestore.rules still has a /notifications block", block is not None)
if block:
    body = block.group(1)
    ok("the read rule still tests `userId`",
       "resource.data.userId == request.auth.uid" in body
       or "resource.data.get('userId', '') == request.auth.uid" in body,
       "if this rule changed, this whole design changed with it")
    ok("it does not test `targetUid`", "targetUid" not in body)

# ── the four Cloud Functions writers ────────────────────────────────────────
fn_src = (REPO / "functions" / "src" / "index.ts").read_text()
writers = re.findall(
    r"collection\('notifications'\)(?:\.add|\.doc\(\))?\s*(?:\)?\s*)",
    fn_src,
)
# One writer left in the Functions (payout_approved). The agency-approved
# notice and the recharge notices moved to the API, which writes every
# partner-lifecycle and recharge notice through `services/notices` — one
# mechanism, idempotent, addressed on `userId`.
eq("functions/src/index.ts has exactly one notification writer left", len(writers), 1)

# Field names only, with the explanatory comments stripped — the comments say
# "targetUid" on purpose, to record what was wrong.
code_only = "\n".join(
    line for line in fn_src.splitlines() if not line.strip().startswith("//")
)
eq("no writer emits `targetUid` any more", code_only.count("targetUid:"), 0)
ok("it emits `userId`", code_only.count("userId:") >= 1,
   f"found {code_only.count('userId:')}")

# ── the declared index ──────────────────────────────────────────────────────
#
# `userId ==` plus `orderBy(createdAt)` is an equality filter and an order on a
# DIFFERENT field, which is exactly the shape that needs a composite index —
# the same shape that took four of the five CRM appeal tabs down.
indexes = json.loads((REPO / "firestore.indexes.json").read_text())
declared = [
    [(f["fieldPath"], f.get("order")) for f in i["fields"]]
    for i in indexes["indexes"]
    if i["collectionGroup"] == "notifications"
]
ok("notifications(userId ASC, createdAt DESC) is declared",
   [("userId", "ASCENDING"), ("createdAt", "DESCENDING")] in declared,
   f"declared for notifications: {declared}")

# ── the Android reader ──────────────────────────────────────────────────────
chat_repo = (
    REPO / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper"
    / "app" / "data" / "repository" / "ChatRepository.kt"
).read_text()
ok("the app has a reader for this collection at all",
   "fun myNotificationsFlow(" in chat_repo,
   "the collection had writers and no reader; that was the defect")
ok("it reads the top-level `notifications` collection",
   'firestore.collection("notifications")' in chat_repo)
ok("it filters on `userId`", 'whereEqualTo("userId", myUid)' in chat_repo)
ok("…ordered newest first",
   'orderBy("createdAt", Query.Direction.DESCENDING)' in chat_repo)

# A reader nothing calls is the same as no reader. This is the assertion that
# would have failed on the original defect: four writers, a collection, and
# nothing on the screen asking for it.
view_model = (
    REPO / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper"
    / "app" / "ui" / "screens" / "messages" / "MessagesViewModel.kt"
).read_text()
ok("the Messages view-model actually collects it",
   "chatRepo.myNotificationsFlow(myUid)" in view_model,
   "a reader nothing calls is no reader")
ok("…into the state the Official tab renders",
   "notifications = notifications" in view_model)

screen = (
    REPO / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper"
    / "app" / "ui" / "screens" / "messages" / "MessagesScreen.kt"
).read_text()
# O5 (5 Nov 2026) added a third argument (what is new since the tab was last opened); both lists are still passed.
ok("the Official tab renders them beside the broadcasts",
   "OfficialTab(state.broadcasts, state.notifications" in screen)
ok("a warning is drawn differently from an announcement",
   "PersonalNoticeCard" in screen and "isWarning" in screen,
   "a moderation decision read as news is a decision missed")

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} official-warning checks passed.")
print("  · warning a user puts a readable notice in their inbox, keyed on `userId`")
print("  · it carries the reason and never the reviewer")
print("  · a retry overwrites; a second warning is a second notice")
print("  · a delivery failure loses the notice, never the warning")
print("  · rule, four Functions writers, index and Android reader all agree\n")
