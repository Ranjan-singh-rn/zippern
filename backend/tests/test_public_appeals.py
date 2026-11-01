"""UGP-F — the PUBLIC appeal: filed from a web page, without signing in.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * identification by the full account ID, or display name + 8-character
    profile ID ("safe name lookup"); an ambiguous name is not a match;
  * a missing account and an UNRESTRICTED one get the same answer, so the page
    cannot be used to learn who is banned; the answer carries a masked name;
  * attachments are typed from their CONTENT (a renamed PDF or HTML page is
    refused), capped per kind and in total, stored privately — the appeal holds
    object paths, never a download URL — and staff read them through signed
    links only;
  * the appeal lands in the EXISTING `appeals` collection as `pending`, with a
    reference, `originalDecidedBy` set from who restricted the account, and an
    `appeal.submitted` audit entry; the restriction is untouched;
  * one pending appeal per account; rate limits per client and per account;
  * a failed upload leaves no appeal and no stray object behind.

REAL: services.public_appeals (and users.restriction_of).
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
Storage (the two blob helpers are replaced with recorders).

    python3 -m tests.test_public_appeals
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

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.services import public_appeals as pub  # noqa: E402

UPLOADED: list[tuple[str, str, int]] = []
DELETED: list[str] = []
FAIL_UPLOAD_AT: list[int] = []


def fake_upload(path: str, data: bytes, content_type: str) -> None:
    if FAIL_UPLOAD_AT and len(UPLOADED) == FAIL_UPLOAD_AT[0]:
        raise RuntimeError("storage down")
    UPLOADED.append((path, content_type, len(data)))


pub._upload_blob = fake_upload  # type: ignore[assignment]
pub._delete_blob = lambda path: DELETED.append(path)  # type: ignore[assignment]
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


def refuses(claim: str, coro, kind=pub.PublicAppealError) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 100
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 50
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100
MOV = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 100
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 100
PDF = b"%PDF-1.7\n" + b"\x00" * 100
HTML = b"<html><script>alert(1)</script></html>"
STATEMENT = "I was banned by mistake — I never sent those messages, please look again."
LONG_UID = "TESTLONGaaaa1111bbbb2222cccc44"   # a synthetic fixture uid


def users():
    return fs.collection("users").docs


def appeals():
    return fs.collection("appeals").docs


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Attachments are typed from their content")

eq("jpeg", pub.sniff(JPEG)[0], "image/jpeg")
eq("png", pub.sniff(PNG)[0], "image/png")
eq("webp", pub.sniff(WEBP)[0], "image/webp")
eq("mp4", pub.sniff(MP4)[0], "video/mp4")
eq("mov", pub.sniff(MOV)[0], "video/quicktime")
eq("webm", pub.sniff(WEBM)[0], "video/webm")
eq("a PDF is not accepted", pub.sniff(PDF), None)
eq("an HTML page renamed .jpg is not accepted", pub.sniff(HTML), None)
U = pub.Upload
refuses("more than 3 files", asyncio.to_thread(pub.validate_uploads, [U("a", JPEG)] * 4))
refuses("an image over 5 MB", asyncio.to_thread(
    pub.validate_uploads, [U("a", JPEG + b"\x00" * (5 * 1024 * 1024))]))
refuses("a video over 20 MB", asyncio.to_thread(
    pub.validate_uploads, [U("a", MP4 + b"\x00" * (20 * 1024 * 1024))]))
refuses("a disguised file", asyncio.to_thread(pub.validate_uploads, [U("x.jpg", HTML)]))
eq("empty file fields are ignored", len(pub.validate_uploads([U("a", b""), U("b", PNG)])), 1)
refuses("a message under 20 characters", asyncio.to_thread(pub.validate_statement, "too short"))
refuses("a message over 2000 characters", asyncio.to_thread(pub.validate_statement, "x" * 2001))
eq("a masked name", pub.mask_name("Guest yrfdp"), "G**** y****")
ok("a reference is short and stable", pub.reference_for("abc") == pub.reference_for("abc")
   and pub.reference_for("abc").startswith("ZA-") and len(pub.reference_for("abc")) == 11)

# ══════════════════════════════════════════════════════════════════════════════
print("2. Identification says nothing about who is restricted")

users()[LONG_UID] = {"name": "Guest yrfdp", "isBanned": True, "accountState": "banned",
                     "banReason": "spam", "bannedBy": "staff-ban-1", "email": "secret@x.test"}
users()["FREEaaaa1111bbbb2222cccc33"] = {"name": "Free user", "accountState": "active"}

r = run(pub.lookup(LONG_UID, "", "203.0.113.5"))
eq("a banned account by full ID → appealable", r["state"], "appealable")
eq("…with a MASKED name only", r["name_hint"], "G**** y****")
ok("…and no private field", "secret" not in str(r) and "spam" not in str(r) and "staff-ban-1" not in str(r))
r_free = run(pub.lookup("FREEaaaa1111bbbb2222cccc33", "", "203.0.113.5"))
r_none = run(pub.lookup("NOPEaaaa1111bbbb2222cccc33", "", "203.0.113.5"))
eq("an UNRESTRICTED account answers exactly like a missing one", r_free, r_none)
eq("…not_found", r_free["state"], "not_found")

eq("name + 8-character profile ID finds it",
   run(pub.lookup(LONG_UID[:8].upper(), "Guest yrfdp", "203.0.113.5"))["state"], "appealable")
eq("an 8-character ID without the name is not enough",
   run(pub.lookup(LONG_UID[:8].upper(), "", "203.0.113.5"))["state"], "not_found")
users()[LONG_UID[:8] + "ZZZZZZZZZZZZZZZZZZZZ"] = {"name": "Guest yrfdp", "isBanned": True}
eq("an AMBIGUOUS name + prefix is not a match",
   run(pub.lookup(LONG_UID[:8].upper(), "Guest yrfdp", "203.0.113.5"))["state"], "not_found")
del users()[LONG_UID[:8] + "ZZZZZZZZZZZZZZZZZZZZ"]

# ══════════════════════════════════════════════════════════════════════════════
print("3. Filing — the existing appeals collection, nothing lifted")

out = run(pub.submit(LONG_UID, "", STATEMENT, [U("s.jpg", JPEG), U("v.mp4", MP4)], "203.0.113.5"))
eq("filed as pending", out["status"], "pending")
ok("…with a reference", out["reference"].startswith("ZA-"))
eq("one appeal written", len(appeals()), 1)
appeal_id, doc = next(iter(appeals().items()))
eq("…about the right account", doc["subjectUid"], LONG_UID)
eq("…kind ban, pending, from the public form", (doc["kind"], doc["status"], doc["source"]),
   ("ban", "pending", "public_web"))
eq("…the statement kept", doc["statement"], STATEMENT)
eq("…NO download URLs", doc["evidenceUrls"], [])
eq("…private object paths with their types", [(e["kind"], e["contentType"]) for e in doc["evidence"]],
   [("image", "image/jpeg"), ("video", "video/mp4")])
ok("…under appealEvidence/public/<appeal>/", all(e["path"].startswith(f"appealEvidence/public/{appeal_id}/")
                                                 for e in doc["evidence"]))
eq("…four-eyes anchor: who banned them", doc["originalDecidedBy"], "staff-ban-1")
eq("…the reference stored for staff", doc["reference"], out["reference"])
eq("the restriction is UNTOUCHED", (users()[LONG_UID]["isBanned"], users()[LONG_UID]["accountState"]),
   (True, "banned"))
ok("audited as appeal.submitted", any(e["action"] == "appeal.submitted" and e["subject_id"] == appeal_id
                                      for e in AUDIT))

eq("a second appeal while one is pending: lookup says so",
   run(pub.lookup(LONG_UID, "", "198.51.100.9"))["state"], "appeal_pending")
refuses("…and filing is refused", pub.submit(LONG_UID, "", STATEMENT, [], "198.51.100.9"))
eq("…still one appeal", len(appeals()), 1)
refuses("an unrestricted account cannot be appealed", pub.submit(
    "FREEaaaa1111bbbb2222cccc33", "", STATEMENT, [], "198.51.100.9"))

# ══════════════════════════════════════════════════════════════════════════════
print("4. A failed upload leaves nothing behind")

users()["BAN2aaaa1111bbbb2222cccc33"] = {"name": "Second", "isBanned": True, "accountState": "banned"}
UPLOADED.clear()
FAIL_UPLOAD_AT.append(1)
refuses("an upload failure refuses the appeal", pub.submit(
    "BAN2aaaa1111bbbb2222cccc33", "", STATEMENT, [U("a.png", PNG), U("b.png", PNG)], "192.0.2.10"))
FAIL_UPLOAD_AT.clear()
ok("…no appeal for that account", all(d["subjectUid"] != "BAN2aaaa1111bbbb2222cccc33" for d in appeals().values()))
eq("…and the object already uploaded was removed", len(DELETED), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Rate limits")

for i in range(pub.SUBMITS_PER_HOUR_PER_CLIENT - 1):   # one submit already counted for 192.0.2.10
    uid = f"RATE{i:04d}aaaa1111bbbb2222cc"
    users()[uid] = {"name": f"r{i}", "isBanned": True, "accountState": "banned"}
    run(pub.submit(uid, "", STATEMENT, [], "192.0.2.10"))
users()["RATEXXXXaaaa1111bbbb2222cc"] = {"name": "rx", "isBanned": True, "accountState": "banned"}
refuses("a client over its hourly submits is refused", pub.submit(
    "RATEXXXXaaaa1111bbbb2222cc", "", STATEMENT, [], "192.0.2.10"), kind=pub.RateLimited)

for i in range(pub.LOOKUPS_PER_HOUR_PER_CLIENT):
    run(pub.lookup("NOPEaaaa1111bbbb2222cccc33", "", "192.0.2.99"))
refuses("a client over its hourly lookups is refused", pub.lookup(
    "NOPEaaaa1111bbbb2222cccc33", "", "192.0.2.99"), kind=pub.RateLimited)
ok("no client address is stored in clear",
   all("192.0.2" not in str(row) and "203.0.113" not in str(row) for row in DB[mongo.C.PUBLIC_APPEAL_RATE].docs))

# ══════════════════════════════════════════════════════════════════════════════
print("6. Staff read the attachments through signed links only")

from app.services import verification as ver  # noqa: E402

ver._sign = lambda path: (f"https://signed.example/{path}?X-Goog-Expires=900", "")  # type: ignore[assignment]
links = run(pub.evidence_links(appeal_id))
eq("one link per attachment", len(links), 2)
ok("…signed, short-lived", all("X-Goog-Expires=900" in l["url"] for l in links))
eq("…with the kind for the player", [l["kind"] for l in links], ["image", "video"])
refuses("an unknown appeal id", pub.evidence_links("nope"))

src = (ROOT / "app" / "main.py").read_text()
ok("the public router is mounted", "app.include_router(public_appeals.router" in src)
rsrc = (ROOT / "app" / "routers" / "public_appeals.py").read_text()
ok("the public routes take no session dependency", "Depends(" not in rsrc)

# ══════════════════════════════════════════════════════════════════════════════
print("7. Review fixes")

# 7.1 The lookup says whether an appeal can be filed — and nothing more.
users()["BAN7aaaa1111bbbb2222cccc33"] = {"name": "Seven Person", "isSuspended": True, "accountState": "suspended",
                                         "suspendedBy": "staff-sus-7"}
r7 = run(pub.lookup("BAN7aaaa1111bbbb2222cccc33", "", "203.0.113.70"))
eq("appealable carries ONLY the state and a masked name", sorted(r7), ["name_hint", "state"])
ok("…not ban versus suspension", "suspend" not in str(r7).lower() and "ban" not in str(r7).lower())
r7p = run(pub.lookup(LONG_UID, "", "203.0.113.70"))
eq("an account with an appeal pending says so", r7p["state"], "appeal_pending")
ok("…without the pending appeal's reference", "reference" not in r7p and "ZA-" not in str(r7p))

# 7.2 Only an account id is an account id.
for bad in (LONG_UID + "/warnings/w1", "../" + LONG_UID, LONG_UID[:10] + " " + LONG_UID[10:], "<script>alert(1)</script>xxxxxxxx"):
    eq(f"{bad[:24]!r}… is not an account", run(pub.resolve_account(bad, "Guest yrfdp")), None)

# 7.3 `ftyp` alone is not a video.
HEIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 100
AVIF = b"\x00\x00\x00\x18ftypavif" + b"\x00" * 100
M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 100
ISOM = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 100
for name, blob in (("HEIC", HEIC), ("AVIF", AVIF), ("M4A audio", M4A)):
    eq(f"a {name} file is not accepted as a video", pub.sniff(blob), None)
eq("an isom MP4 is", pub.sniff(ISOM)[0], "video/mp4")

# 7.4 Two submissions at once for one account → one appeal.
users()["RACEaaaa1111bbbb2222cccc33"] = {"name": "Race Person", "isBanned": True, "accountState": "banned"}


async def _two():
    return await asyncio.gather(
        pub.submit("RACEaaaa1111bbbb2222cccc33", "", STATEMENT, [], "203.0.113.81"),
        pub.submit("RACEaaaa1111bbbb2222cccc33", "", STATEMENT, [], "203.0.113.82"),
        return_exceptions=True,
    )


outcomes = run(_two())
eq("two concurrent submissions for one account file ONE appeal",
   sum(1 for d in appeals().values() if d["subjectUid"] == "RACEaaaa1111bbbb2222cccc33"), 1)
ok("…the other is refused, not filed", sum(isinstance(o, pub.PublicAppealError) for o in outcomes) == 1, repr(outcomes))
ok("…and the filing lock is released", not any(str(d.get("_id", "")).startswith("lock_RACE")
                                               for d in DB[mongo.C.PUBLIC_APPEAL_RATE].docs))

# 7.5 A lock left by a crashed request is taken over once stale.
from datetime import datetime as _dt, timedelta as _td, timezone as _tz  # noqa: E402

users()["LOCKaaaa1111bbbb2222cccc33"] = {"name": "Lock Person", "isBanned": True, "accountState": "banned"}
DB[mongo.C.PUBLIC_APPEAL_RATE].docs.append({"_id": "lock_LOCKaaaa1111bbbb2222cccc33",
                                            "at": _dt.now(_tz.utc) - _td(minutes=5)})
eq("a stale filing lock does not block the account for ever",
   run(pub.submit("LOCKaaaa1111bbbb2222cccc33", "", STATEMENT, [], "203.0.113.90"))["status"], "pending")

# …and only its holder can release it: a slow holder whose lock was taken over
# cannot free the new holder's lock for a third request.
t_old = run(pub._take_filing_lock("TOKNaaaa1111bbbb2222cccc33"))
ok("a free lock is taken, with a token", bool(t_old))
eq("…a second taker is refused while it is fresh", run(pub._take_filing_lock("TOKNaaaa1111bbbb2222cccc33")), None)
row = next(d for d in DB[mongo.C.PUBLIC_APPEAL_RATE].docs if d.get("_id") == "lock_TOKNaaaa1111bbbb2222cccc33")
row["at"] = _dt.now(_tz.utc) - _td(minutes=5)          # its holder is slow
t_new = run(pub._take_filing_lock("TOKNaaaa1111bbbb2222cccc33"))
ok("a stale lock is taken over WITH A NEW TOKEN", bool(t_new) and t_new != t_old)
run(pub._release_filing_lock("TOKNaaaa1111bbbb2222cccc33", t_old))
ok("the slow holder's release does NOT free the new holder's lock",
   any(d.get("_id") == "lock_TOKNaaaa1111bbbb2222cccc33" for d in DB[mongo.C.PUBLIC_APPEAL_RATE].docs))
run(pub._release_filing_lock("TOKNaaaa1111bbbb2222cccc33", t_new))
ok("…the new holder's release does",
   not any(d.get("_id") == "lock_TOKNaaaa1111bbbb2222cccc33" for d in DB[mongo.C.PUBLIC_APPEAL_RATE].docs))

# 7.6 The route refuses an over-budget client BEFORE it reads the body.
ok("over budget is known without spending", run(pub.client_over_submit_budget("192.0.2.10")) is True)
eq("…and a fresh client is not over it", run(pub.client_over_submit_budget("192.0.2.250")), False)
ok("the route takes the body itself (no Form/File parameters)",
   "Form(" not in rsrc and "File(" not in rsrc and "async def submit(request: Request):" in rsrc)
body_at = rsrc.index("await request.form(")
ok("…checking the declared size first", rsrc.index('request.headers.get("content-length"') < body_at)
ok("…and the client's budget first", rsrc.index("await svc.client_over_submit_budget(client)") < body_at)
ok("…with a cap on how many files the parser accepts", "request.form(max_files=svc.MAX_FILES + 1" in rsrc)

# 7.7 Staff evidence: the deciding permission, and audited.
usrc = (ROOT / "app" / "routers" / "users.py").read_text()
ev = usrc[usrc.index('"/appeals/{appeal_id}/evidence"') - 40:]
ok("the evidence route needs can_ban_users",
   'dependencies=[Depends(require_permission(Permission.CAN_BAN_USERS))]' in ev[:300])
ok("…and audits every opening", "Action.APPEAL_EVIDENCE_VIEWED" in ev[:2500])

# ══════════════════════════════════════════════════════════════════════════════
print("8. RC — another appeal after a decision needs new evidence or a new reason")

from app.services import appeal_policy  # noqa: E402

eq("RC: no earlier decision → allowed", appeal_policy.reappeal_problem([], STATEMENT), "")
ok("RC: the same statement after a decision → refused",
   appeal_policy.reappeal_problem([STATEMENT], "  " + STATEMENT.upper() + " ") == appeal_policy.REAPPEAL_REFUSAL)
eq("RC: a new reason → allowed", appeal_policy.reappeal_problem([STATEMENT], "Something different happened."), "")
eq("RC: new evidence → allowed", appeal_policy.reappeal_problem([STATEMENT], STATEMENT, 1), "")

RA_UID = "TESTREAPPaaaa1111bbbb2222cc"
users()[RA_UID] = {"name": "Guest reapp", "isBanned": True, "accountState": "banned", "banReason": "spam",
                   "bannedBy": "staff-ban-1"}
fs.collection("appeals").docs["decided-1"] = {"subjectUid": RA_UID, "kind": "ban", "status": "upheld",
                                              "statement": STATEMENT, "source": "public_web"}
msg = refuses("RC: the public form refuses the decided statement again (no new files)",
              pub.submit(RA_UID, "", STATEMENT, [], "203.0.113.77"))
ok("RC: …saying what is needed", "new evidence" in msg, msg)
again = run(pub.submit(RA_UID, "", "Since the decision I found proof the messages were sent by someone else.",
                       [], "203.0.113.78"))
eq("RC: …a NEW reason is filed", again["status"], "pending")
eq("RC: …the decided appeal is untouched", fs.collection("appeals").docs["decided-1"]["status"], "upheld")

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} public-appeal checks passed.")
print("  · identified by account ID or name + profile ID; restriction never revealed")
print("  · content-typed, capped, private attachments; signed links for staff")
print("  · the existing appeals collection, pending, audited; nothing lifted")
print("  · one pending per account; rate limits per client and per account")
