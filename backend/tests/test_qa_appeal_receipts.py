"""QA (3 Nov 2026) — the appeal receipt (#53) and the ban reason in the notice (E1b).

  * **#53** — a banned or suspended person who appealed was never told it had
    arrived: `notices.appeal_received` and the `appeal.received` template
    existed, and nothing called them. The public appeal form now sends the
    receipt at once; the transactional sweep sends it for the appeals the app
    and the device key write without the backend. Once per appeal, however
    often the sweep runs; never for a decided appeal, a report contest, or an
    appeal older than the window.
  * **E1b** — the ban (and suspension) notice reached the app without its
    reason. The sentence now carries it ("… Reason: <reason>"), and the email
    shows it once — the separate Reason box is dropped when the sentence has it.

REAL: `scheduling.transactional_sweep`, `notices.appeal_receipt`,
`notices.account_restriction`, `email.build_template`, over the in-memory
Firestore, the harness Mongo and FakeSendGrid (tests/harness.py).

    python3 -m tests.test_qa_appeal_receipts
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, FakeSendGrid, install_stubs, verified_auth  # noqa: E402

install_stubs()

from app.config import settings  # noqa: E402
import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

FS = FakeFirestore()
firebase_mod.firestore_client = lambda: FS  # type: ignore[assignment]
firebase_mod.get_user = lambda uid: verified_auth(uid)  # type: ignore[assignment]

from app.services import email as mail  # noqa: E402
from app.services import notices  # noqa: E402
from app.services import scheduling  # noqa: E402

PROVIDER = FakeSendGrid()
PROVIDER.install()
PROVIDER.next_status = 202

settings.sendgrid_api_key = "SG.FAKE-TEST-KEY-appeal-receipts-0123"
settings.environment = "test"
settings.email_provider = "sendgrid"
settings.mail_from = "no-reply@zipperlive.org"

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(claim)


def run(coro):
    return asyncio.run(coro)


def notice(key: str) -> dict | None:
    return FS.collection("notifications").docs.get(key)


NOW = datetime.now(timezone.utc)
APPEALS = FS.collection("appeals").docs


def appeal(**over) -> dict:
    base = {
        "subjectUid": "u-banned", "subjectName": "QA User Two", "raisedByUid": "u-banned",
        "raisedByRole": "self", "agencyId": "", "kind": "ban", "reportId": "",
        "statement": "I did not send those messages; please look again.",
        "evidenceUrls": [], "status": "pending", "createdAt": NOW - timedelta(hours=1),
    }
    base.update(over)
    return base


USERS = FS.collection("users").docs
USERS["u-banned"] = {"accountState": "banned", "isBanned": True}
USERS["u-public"] = {"accountState": "suspended", "isSuspended": True, "isBanned": True}
USERS["u-victim"] = {"accountState": "banned", "isBanned": True}
USERS["u-free"] = {"accountState": "active", "isBanned": False}
USERS["u-old"] = {"accountState": "banned", "isBanned": True}
USERS["u-decided"] = {"accountState": "banned", "isBanned": True}

# The app's own appeal (written by the client), a public-form appeal with its
# reference, and the ones that must NOT get a receipt.
APPEALS["self_u-banned_banned"] = appeal()
APPEALS["pub_1"] = appeal(subjectUid="u-public", raisedByUid="", raisedByRole="public", reference="ZA-1A2B3C4D")
APPEALS["self_u-decided_banned"] = appeal(subjectUid="u-decided", raisedByUid="u-decided", status="upheld")
APPEALS["contest_ag1_r1"] = appeal(subjectUid="u-host", raisedByUid="ag-owner", raisedByRole="agency",
                                    kind="report", agencyId="ag1", reportId="r1")
APPEALS["self_u-old_banned"] = appeal(subjectUid="u-old", raisedByUid="u-old", createdAt=NOW - timedelta(days=30))
APPEALS["self__banned"] = appeal(subjectUid="")
# Security review (3 Nov 2026): the rules let an approved agency file a `ban`
# appeal for ANY subject at any id — a receipt from that would let a partner
# mail "appeal received" to arbitrary users, quoting an id it chose.
APPEALS["Click-this-link-to-restore-your-account"] = appeal(subjectUid="u-victim", raisedByUid="ag-owner",
                                                           raisedByRole="agency", agencyId="ag1")
# A self-appeal from an account that is not restricted: nothing to appeal.
APPEALS["self_u-free_banned"] = appeal(subjectUid="u-free", raisedByUid="u-free")


def section(summary: dict, name: str) -> dict:
    return next(s for s in summary["sections"] if s["sweep"] == name)


# ── #53: the sweep sends the receipt — once ──────────────────────────────────
ok("the sweep is registered", any(name == "appeal_receipts" for name, _s, _f in scheduling.SWEEPS))

first = run(scheduling.transactional_sweep(["appeal_receipts"]))
sec = section(first, "appeal_receipts")
eq("it ran", (sec["status"], first["failed_sweeps"]), ("ok", []))
eq("two pending account appeals in the window: two receipts, by email too", (sec["candidates"], sec["accepted"]), (2, 2))

app_notice = notice("appeal_received_self_u-banned_banned") or {}
eq("the app's appeal: an Official message to the person",
   (app_notice.get("userId"), app_notice.get("type"), app_notice.get("title")),
   ("u-banned", "appeal_received", "Your appeal has been received"))
ok("…saying it is with a reviewer and the Owner decides",
   "is with a reviewer" in str(app_notice.get("body")) and "An Owner takes the final decision" in str(app_notice.get("body")))
pub_notice = notice("appeal_received_pub_1") or {}
ok("the public appeal's receipt carries its reference", "Reference: ZA-1A2B3C4D." in str(pub_notice.get("body")))
eq("…and the email went to each account's verified address",
   sorted(m["to"] for m in PROVIDER.sent if "appeal" in m["subject"].lower()),
   ["u-banned@x.test", "u-public@x.test"])

for skipped, why in (("self_u-decided_banned", "a decided appeal"), ("contest_ag1_r1", "a report contest"),
                     ("self_u-old_banned", "an appeal older than the window"), ("self__banned", "an appeal with no subject"),
                     ("Click-this-link-to-restore-your-account", "an appeal an agency filed for someone else"),
                     ("self_u-free_banned", "an account that is not restricted")):
    ok(f"no receipt for {why}", notice(f"appeal_received_{skipped}") is None)
eq("…so nothing reached the agency's chosen subject", [m["to"] for m in PROVIDER.sent if m["to"] == "u-victim@x.test"], [])
app_mail = next((m for m in PROVIDER.sent if m["to"] == "u-banned@x.test"), {})
ok("the app appeal's email quotes no client-chosen id", "self_u-banned_banned" not in str(app_mail.get("html")))
pub_mail = next((m for m in PROVIDER.sent if m["to"] == "u-public@x.test"), {})
ok("the public appeal's email quotes the server's reference", "ZA-1A2B3C4D" in str(pub_mail.get("html")))

sent_before = len(PROVIDER.sent)
FS.collection("notifications").docs["appeal_received_self_u-banned_banned"]["read"] = True
second = run(scheduling.transactional_sweep(["appeal_receipts"]))
sec2 = section(second, "appeal_receipts")
eq("a second sweep sends nothing new", (sec2["accepted"], sec2["already_sent"], len(PROVIDER.sent) - sent_before), (0, 2, 0))
eq("…and leaves the notice as the person left it (read stays read)",
   (notice("appeal_received_self_u-banned_banned") or {}).get("read"), True)

# A decision taken before the sweep reaches an appeal: no receipt after it.
USERS["u-late"] = {"accountState": "banned", "isBanned": True}
APPEALS["self_u-late_banned"] = appeal(subjectUid="u-late", raisedByUid="u-late", status="overturned")
run(scheduling.transactional_sweep(["appeal_receipts"]))
ok("an appeal decided before the sweep gets no receipt", notice("appeal_received_self_u-late_banned") is None)

# Firestore unreadable: the sweep is FAILED, not "nothing owed".
real = firebase_mod.firestore_client
firebase_mod.firestore_client = lambda: (_ for _ in ()).throw(RuntimeError("Firestore unreachable"))  # type: ignore[assignment]
broken = run(scheduling.transactional_sweep(["appeal_receipts"]))
firebase_mod.firestore_client = real  # type: ignore[assignment]
eq("an unreadable appeals collection is a failed sweep", broken["failed_sweeps"], ["appeal_receipts"])

# The public form calls the same writer at once.
src = (ROOT / "app" / "services" / "public_appeals.py").read_text()
ok("the public appeal form sends the receipt immediately", "await notices.appeal_receipt(uid, appeal_id, reference)" in src)

# ── E1b: the ban reason is in the Official message, and once in the email ────
PROVIDER.sent.clear()
run(notices.account_restriction("u-ban2", "banned", "Repeated abusive messages in public rooms.", "audit-ban-2"))
ban = notice("account_banned_audit-ban-2") or {}
eq("the ban notice says the reason in its sentence",
   ban.get("body"), "Your account has been banned from Zipper. Reason: Repeated abusive messages in public rooms.")
eq("…and keeps it as its own field", ban.get("reason"), "Repeated abusive messages in public rooms.")
html = next(m["html"] for m in PROVIDER.sent if m["to"] == "u-ban2@x.test")
ok("the email carries the reason", "Repeated abusive messages in public rooms." in html)
ok("…without a second Reason box repeating it", ">Reason</div>" not in html)

run(notices.account_restriction("u-sus2", "suspended", "Spam", "audit-sus-2",
                                until=datetime(2026, 11, 4, 10, 15, tzinfo=timezone.utc)))
eq("a suspension says its end (IST) and its reason",
   (notice("account_suspended_audit-sus-2") or {}).get("body"),
   "Your account has been suspended and cannot use Zipper until 4 Nov 2026, 3:45 pm IST. Reason: Spam")
run(notices.account_restriction("u-res2", "resumed", "Appeal accepted", "audit-res-2"))
ok("a resume carries no reason", "Reason" not in str((notice("account_resumed_audit-res-2") or {}).get("body")))
run(notices.account_restriction("u-ban3", "banned", "", "audit-ban-3"))
eq("a ban recorded without a reason is not given an empty one",
   (notice("account_banned_audit-ban-3") or {}).get("body"), "Your account has been banned from Zipper.")

# The Reason box still appears when the sentence does NOT carry the reason.
built = mail.build_template("appeal.decided", {"title": "Your appeal was not accepted",
                                               "body": "An Owner reviewed your appeal and did not accept it.",
                                               "reason": "The evidence supports the ban."})
ok("a reason the sentence does not carry keeps its own box", ">Reason</div>" in built.html
   and "The evidence supports the ban." in built.html)

print()
if failures:
    print(f"{len(failures)} of {checks} appeal receipt / ban reason checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} appeal receipt / ban reason checks passed.")
print("  · QA #53: the appeal receipt reaches the app and the verified email, once per appeal")
print("  · QA E1b: the ban and suspension notices carry the reason in the sentence, shown once in the email")
