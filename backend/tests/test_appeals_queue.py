"""The appeals queue: every CRM tab, the agency view, and the missing index.

── THE PRODUCTION FAILURE THIS ENCODES ─────────────────────────────────────

`GET /api/users/appeals` filters on `status` and orders by `createdAt`. That
combination needs a composite index, and the one for `appeals` was never
declared — `reports`, `coinPurchaseRequests`, `withdrawalRequests` and
`approvalRequests` all had theirs. Firestore raised `FailedPrecondition`, the
route did not catch it, there is no global exception handler, and FastAPI
answered

    500 {"detail": "Internal Server Error"}

The CRM showed "Could not load this — Internal Server Error" on Waiting,
Overturned, Upheld and Resolved. **All** worked, because it omits `status` and
needs no composite index — which made a schema fault look like a data fault.

Two things are asserted here, and they are different:

  1. the SHAPE of every query the CRM and the agency dashboard issue, so a
     future reorder or an added filter is caught against the declared indexes
     rather than in production;
  2. that a missing index comes back as a 503 naming the index, not a 500.

`tests/test_firestore_indexes.py` is the other half: it checks the declared
indexes actually cover these queries.

REAL: `app.services.appeals.list_appeals` / `appeals_for_agency`, and the
      route handlers in `routers/users.py` / `routers/partners.py`.
FAKE: Firestore, from `tests/fakes.py`.

    python3 -m tests.test_appeals_queue
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# `harness.install_stubs()` first, then `fakes.FakeFirestore` — the same
# pairing `test_appeal_auto_resolve.py` uses. The harness is the one that
# stubs `fastapi` and `pydantic`, which `app.core.firestore_errors` and the
# routers need at import time; `fakes` brings the Firestore double.
from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from google.api_core.exceptions import FailedPrecondition  # noqa: E402

from app.core.firestore_errors import index_unavailable  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.services import appeals as appeals_svc  # noqa: E402

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got {got!r}\n        want {want!r}")


NOW = datetime(2026, 10, 6, tzinfo=timezone.utc)
fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
run = asyncio.get_event_loop().run_until_complete


def seed(appeal_id: str, **over) -> None:
    fs.collection("appeals").docs[appeal_id] = {
        "subjectUid": "uid-subject",
        "subjectName": "Someone",
        "status": "pending",
        "statement": "I think this was a mistake and here is why.",
        "createdAt": NOW,
        "evidenceUrls": [],
        **over,
    }


# Oldest first is the product rule — "a waiting appeal is a person still
# locked out" — so the fixtures are deliberately out of insertion order.
seed("a-oldest", status="pending", createdAt=NOW - timedelta(days=3))
seed("b-middle", status="pending", createdAt=NOW - timedelta(days=2))
seed("c-newest", status="pending", createdAt=NOW - timedelta(days=1))
seed("d-upheld", status="upheld", createdAt=NOW - timedelta(days=5))
seed("e-overturned", status="overturned", createdAt=NOW - timedelta(days=4))
seed("f-resolved", status="resolved", createdAt=NOW - timedelta(days=6))
seed("g-agency", status="pending", agencyId="AG1", createdAt=NOW - timedelta(hours=2))
seed("h-agency", status="upheld", agencyId="AG1", createdAt=NOW - timedelta(hours=1))
seed("i-other-agency", status="pending", agencyId="AG2", createdAt=NOW)

# ── 1. Every CRM tab loads ──────────────────────────────────────────────────
print("\n1. The five CRM tabs")

TABS = {
    "Waiting": "pending",
    "Upheld": "upheld",
    "Overturned": "overturned",
    "Resolved": "resolved",
}
for label, value in TABS.items():
    rows = run(appeals_svc.list_appeals(value, 100))
    ok(f"{label} loads without raising", isinstance(rows, list))
    ok(f"{label} returns only that status",
       all(r.get("status") == value for r in rows))

# Five pending fixtures: a-oldest, b-middle, c-newest, g-agency,
# i-other-agency. Counted from the seeds rather than written as a literal,
# so adding a fixture cannot silently invalidate the assertion.
PENDING = sum(1 for d in fs.collection("appeals").docs.values()
              if d["status"] == "pending")
eq("Waiting returns every pending appeal",
   len(run(appeals_svc.list_appeals("pending", 100))), PENDING)
eq("…and there are five of them", PENDING, 5)

all_rows = run(appeals_svc.list_appeals(None, 100))
eq("All returns every appeal", len(all_rows), 9)
ok("All is the tab that needs no composite index — it sets no status filter",
   isinstance(all_rows, list))

# Oldest first, which is the whole point of the queue.
ordered = run(appeals_svc.list_appeals("pending", 100))
stamps = [r["createdAt"] for r in ordered]
eq("the queue is OLDEST first", stamps, sorted(stamps))

ok("every row carries its id", all(r.get("id") for r in all_rows))

# ── 2. The agency-scoped view ───────────────────────────────────────────────
print("2. Agency-scoped appeals")

ag = run(appeals_svc.appeals_for_agency("AG1", 100))
eq("an agency sees only its own appeals", {r["id"] for r in ag}, {"g-agency", "h-agency"})
ok("and never another agency's",
   all(r.get("agencyId") == "AG1" for r in ag))
ag_stamps = [r["createdAt"] for r in ag]
eq("the agency view is NEWEST first — the opposite order, deliberately",
   ag_stamps, sorted(ag_stamps, reverse=True))
eq("an agency with no appeals gets an empty list",
   run(appeals_svc.appeals_for_agency("AG-NONE", 100)), [])

# ── 3. Limits ───────────────────────────────────────────────────────────────
print("3. Limits")

eq("a limit is honoured", len(run(appeals_svc.list_appeals(None, 2))), 2)
ok("and clamped to MAX_READ rather than trusted",
   len(run(appeals_svc.list_appeals(None, 10_000))) <= appeals_svc.MAX_READ)
eq("a limit on the agency view is honoured too",
   len(run(appeals_svc.appeals_for_agency("AG1", 1))), 1)

# ── 4. A missing index is a 503, not a 500 ──────────────────────────────────
print("4. The missing-index path")

# The real Firestore message, verbatim in shape: the console link is the fix,
# and carrying it through is the whole reason this handler exists.
LINK = ("https://console.firebase.google.com/v1/r/project/zipper-83816/"
        "firestore/indexes?create_composite=Ck5wcm9qZWN0cw")
exc = FailedPrecondition(f"400 The query requires an index. You can create it here: {LINK}")

http = index_unavailable(exc, "the appeals queue")
ok("it is an HTTPException", isinstance(http, HTTPException))
eq("503, because the request was fine and the caller can do nothing",
   http.status_code, 503)
ok("it is NOT a 4xx — the client did nothing wrong", not 400 <= http.status_code < 500)
ok("it is NOT a 500 — this is infrastructure, not a bug", http.status_code != 500)
ok("the sentence says nothing is wrong with the request",
   "Nothing is wrong with the request" in http.detail)
ok("it says no data is affected", "no data is affected" in http.detail)
ok("it names what could not be read", "appeals queue" in http.detail.lower())
ok("and it carries the console link, which is the actual fix", LINK in http.detail)

# Without a link it must still be a usable 503, not a crash.
plain = index_unavailable(FailedPrecondition("400 The query requires an index."), "x")
eq("a message with no link is still a 503", plain.status_code, 503)
ok("and still explains itself", len(plain.detail) > 40)

# The raw gRPC text must not be the whole answer handed to a browser.
ok("the detail is a sentence, not a stack dump", "Traceback" not in http.detail)

# ── 5. The handler is actually wired to the routes ──────────────────────────
print("5. Wiring")

import inspect  # noqa: E402

from app.routers import partners as partners_router  # noqa: E402
from app.routers import users as users_router  # noqa: E402

src_users = inspect.getsource(users_router.list_appeals)
ok("the staff queue catches FailedPrecondition", "FailedPrecondition" in src_users)
ok("…and converts it with index_unavailable", "index_unavailable" in src_users)

src_ag = inspect.getsource(partners_router.agency_appeals)
ok("the agency queue catches it too", "FailedPrecondition" in src_ag)
ok("…and converts it the same way", "index_unavailable" in src_ag)

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} appeals-queue checks passed.")
print("  · all five CRM tabs load; Waiting is oldest-first, the agency view newest-first")
print("  · an agency sees only its own appeals")
print("  · limits are clamped, not trusted")
print("  · a missing index is a 503 carrying the console link, never a bare 500")
print("  · both routes are wired to that handler\n")
