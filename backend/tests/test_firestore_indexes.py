"""Every Firestore query that needs a composite index has one declared.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

`list_appeals` filtered on `status` and ordered by `createdAt`. Firestore needs
a composite index for that, and `firestore.indexes.json` did not declare one —
`reports`, `coinPurchaseRequests`, `withdrawalRequests` and `approvalRequests`
all had theirs. The query raised `FailedPrecondition` in production and the CRM
showed "Internal Server Error" on four of its five appeal tabs.

Nothing could have caught it. The fakes in `tests/fakes.py` have no index
model — a double will always answer a query a real Firestore refuses — so no
amount of service-level testing would have found it. The check has to be
static: read the queries out of the source, read the declarations out of the
JSON, and compare.

── THE RULE BEING CHECKED ──────────────────────────────────────────────────

A Firestore query needs a composite index when it combines one or more
equality filters with an `order_by` on a DIFFERENT field. Equality-only
queries do not: Firestore serves those by merging single-field indexes
(zigzag merge join), which is why

    where(subjectUid ==) + where(status ==) + limit(1)

at `services/appeals.py:537` needs nothing declared, and why the "All" tab —
`order_by(createdAt)` with no filter — kept working while the other four
failed.

── SCOPE ───────────────────────────────────────────────────────────────────

This parses `app/services/appeals.py` specifically. It is deliberately not a
whole-codebase scanner: a regex over 26 service modules would produce false
confidence, because a query assembled across several statements would be
missed and the test would still pass. Appeals is the collection that broke;
the pattern here is small enough to extend by hand when another collection
needs it.

    python3 -m tests.test_firestore_indexes
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

REPO = ROOT.parent
INDEXES = REPO / "firestore.indexes.json"
APPEALS_SVC = ROOT / "app" / "services" / "appeals.py"

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def declared(collection: str) -> list[list[tuple[str, str]]]:
    """Every declared composite index for a collection, as field/order pairs."""
    data = json.loads(INDEXES.read_text())
    out = []
    for idx in data.get("indexes", []):
        if idx.get("collectionGroup") != collection:
            continue
        out.append([(f["fieldPath"], f.get("order") or f.get("arrayConfig", ""))
                    for f in idx["fields"]])
    return out


# ── 1. The file itself ──────────────────────────────────────────────────────
print("\n1. firestore.indexes.json")

ok("the file exists", INDEXES.exists(), str(INDEXES))
raw = json.loads(INDEXES.read_text())
ok("it parses as JSON", isinstance(raw, dict))
ok("it has an `indexes` array", isinstance(raw.get("indexes"), list))
ok("every entry names a collection group",
   all(i.get("collectionGroup") for i in raw["indexes"]))
# Both scopes are legitimate: three indexes are COLLECTION_GROUP, used by
# collection-group queries. An earlier draft of this test asserted COLLECTION
# for all 45 and failed against the real file — the assertion was wrong, not
# the data.
ok("every entry declares a valid query scope",
   all(i.get("queryScope") in {"COLLECTION", "COLLECTION_GROUP"}
       for i in raw["indexes"]))
# A field is either ordered or an array-contains. `conversations.participants`
# and `publicProfiles.languageCodes` are the latter and carry `arrayConfig`
# instead of `order`.
ok("every field has a path and either an order or an arrayConfig",
   all(f.get("fieldPath")
       and (f.get("order") in {"ASCENDING", "DESCENDING"}
            or f.get("arrayConfig") == "CONTAINS")
       for i in raw["indexes"] for f in i["fields"]))

# A duplicate declaration is accepted by the CLI but means two people added
# the same index and neither noticed the other.
seen = [json.dumps(i, sort_keys=True) for i in raw["indexes"]]
ok("no duplicate index declarations", len(seen) == len(set(seen)),
   f"{len(seen) - len(set(seen))} duplicate(s)")

# ── 2. The appeals queries, read out of the source ──────────────────────────
print("2. The appeals queries")

src = APPEALS_SVC.read_text()

# Each entry: the function, the equality field, the order field + direction,
# and the index it therefore requires. Asserted against the source so a
# changed direction or a renamed field fails here rather than in production.
EXPECTED = [
    # list_appeals — the CRM queue. ASCENDING on purpose: "a waiting appeal is
    # a person still locked out", so oldest first.
    ("status", "createdAt", "ASCENDING"),
    # appeals_for_agency — the agency dashboard. DESCENDING: most recent
    # decision first.
    ("agencyId", "createdAt", "DESCENDING"),
]

ok("list_appeals still filters on status",
   'FieldFilter("status", "==", str(status))' in src)
ok("list_appeals still orders by createdAt ASCENDING",
   'order_by("createdAt", direction=BaseQuery.ASCENDING)' in src,
   "direction changed — the declared index no longer matches")
ok("appeals_for_agency still filters on agencyId",
   'FieldFilter("agencyId", "==", agency_id.strip())' in src)
ok("appeals_for_agency still orders by createdAt DESCENDING",
   'order_by("createdAt", direction=BaseQuery.DESCENDING)' in src,
   "direction changed — the declared index no longer matches")

# The equality-only query, which deliberately needs NO composite index.
ok("the pending-dedupe query is equality-only (no order_by, so no index)",
   'FieldFilter("subjectUid", "==", uid)' in src
   and 'FieldFilter("status", "==", str(AppealStatus.PENDING))' in src)

# ── 3. Each query has a matching declaration ────────────────────────────────
print("3. Query → declared index")

appeals_indexes = declared("appeals")
ok("appeals has at least three composite indexes", len(appeals_indexes) >= 3,
   f"found {len(appeals_indexes)}")

for eq_field, order_field, direction in EXPECTED:
    want = [(eq_field, "ASCENDING"), (order_field, direction)]
    ok(f"declared: {eq_field} ASC + {order_field} {direction[:4]}",
       want in appeals_indexes,
       f"missing — the CRM/agency query on {eq_field} will 503 until it exists")

# The Android query, which was already declared and must stay.
ok("the Android myAppeals() index is still declared "
   "(subjectUid ASC + createdAt DESC)",
   [("subjectUid", "ASCENDING"), ("createdAt", "DESCENDING")] in appeals_indexes,
   "removing it breaks the app's own appeal history")

# ── 4. Nothing was lost ─────────────────────────────────────────────────────
print("4. Existing indexes preserved")

# These are the other CRM queues. If a future edit to this file drops one, the
# same outage happens on a different screen.
for collection in ("reports", "coinPurchaseRequests", "withdrawalRequests",
                   "approvalRequests", "feedbackTickets"):
    ok(f"{collection} still has at least one index", len(declared(collection)) >= 1)

ok("the file still declares 40+ indexes in total", len(raw["indexes"]) >= 40,
   f"only {len(raw['indexes'])}")

# ── Result ──────────────────────────────────────────────────────────────────
# ── B6. The CRM /users list filters ─────────────────────────────────────────
print("B6. /users filter + sort indexes")
import re as _re  # noqa: E402
_page = (ROOT.parent / "zipper-crm" / "app" / "users" / "page.tsx").read_text()
_flags = sorted(set(_re.findall(r"where\('(is\w+)', '==', true\)", _page)))
_sorts = sorted(set(_re.findall(r"field: '(\w+)'", _page)))
ok("the page's filters are the three flags", _flags == ["isBanned", "isHost", "isSeller"], str(_flags))
ok("the page's sorts are createdAt / diamonds / beans", _sorts == ["beans", "createdAt", "diamonds"], str(_sorts))
_users = declared("users")
for _f in _flags:
    for _s in _sorts:
        ok(f"users: {_f} == true + orderBy({_s} desc) has an index",
           [(_f, "ASCENDING"), (_s, "DESCENDING")] in _users)
ok("no duplicate users index", len(_users) == len({tuple(x) for x in _users}))

# ── Android dashboards ──────────────────────────────────────────────────────
print("Android agency / seller dashboards")
ok("weeklyPayoutReports: agencyOwnerUid + createdAt desc (My agency)",
   [("agencyOwnerUid", "ASCENDING"), ("createdAt", "DESCENDING")] in declared("weeklyPayoutReports"))
ok("rechargeRequests: sellerUid + status + createdAt desc (seller dashboard)",
   [("sellerUid", "ASCENDING"), ("status", "ASCENDING"), ("createdAt", "DESCENDING")] in declared("rechargeRequests"))

# ── FX-14 (RF-23). The users service ───────────────────────────────────────
# `lift_expired_suspensions` — the daily job that ends a suspension whose term
# is over — combines an equality (`isSuspended == True`) with a RANGE on a
# different field (`suspendedUntil <= now`). Firestore needs a composite index
# for that, and none was declared: the query raised `FailedPrecondition`, the
# job only logged it, and no suspension ever lifted itself. Read out of the
# source, like the appeals queries above, so a changed filter fails here.
print("FX-14 users service queries")
USERS_SVC = ROOT / "app" / "services" / "users.py"
_usrc = USERS_SVC.read_text()
_lift = _usrc[_usrc.index("async def lift_expired_suspensions("):]
_lift = _lift[:_lift.index("\nasync def ", 1) if "\nasync def " in _lift[1:] else len(_lift)]
ok("lift_expired_suspensions still filters isSuspended == True",
   'FieldFilter("isSuspended", "==", True)' in _lift)
ok("…and a range on suspendedUntil",
   'FieldFilter("suspendedUntil", "<=", now)' in _lift,
   "the range changed — re-derive the index it needs")
ok("…with no order_by (the range field is the index's last field)",
   "order_by(" not in _lift)
ok("users: isSuspended ASC + suspendedUntil ASC is declared (the suspension lift)",
   [("isSuspended", "ASCENDING"), ("suspendedUntil", "ASCENDING")] in declared("users"),
   "missing — the daily suspension lift fails with FailedPrecondition")

# Every other query in users.py that combines an equality with a range or an
# order_by on another field. Listed by hand (see SCOPE above); a new one makes
# this count change and fail until it is looked at.
_combined = re.findall(r'FieldFilter\("(\w+)", "(<=|>=|<|>)"', _usrc)
ok("users.py has exactly one range filter (the suspension lift)",
   _combined == [("suspendedUntil", "<=")], str(_combined))
# The ordered queries. An order with no equality filter is served by the
# automatic single-field index; one with an equality filter needs a declared
# composite. Each is named so a new one fails here until it is looked at.
_ordered = re.findall(r'order_by\("(\w+)"', _usrc)
ok("users.py orders exactly three queries (warnings, banned devices, reports)",
   _ordered == ["issuedAt", "bannedAt", "createdAt"], str(_ordered))
ok("list_warnings / list_banned_devices order with no filter (no composite needed)",
   ".collection(WARNINGS)\n        .order_by(\"issuedAt\"" in _usrc
   and 'col.order_by("bannedAt"' in _usrc)
ok("the reports queue (status == + createdAt desc) has its index",
   [("status", "ASCENDING"), ("createdAt", "DESCENDING")] in declared("reports"))

# ── RC: the weekly payout report (functions/src/index.ts) ──────────────────
# `weeklyPayoutReportGenerator` reads each Host's own
# `users/{uid}/beanTransactions` with `type == 'credit'` and a RANGE on
# `timestamp`. An equality plus a range on another field needs a composite
# index, and none was declared. The error is caught and only logged per Host
# ("Bean tx fetch failed"), so every Host's week read as 0 beans and nobody
# reached the payout threshold. A collection-GROUP index does not serve this
# collection query, and the `type` field override keeps only a collection-group
# single-field index — so the declaration must be COLLECTION scope. Read out of
# the Functions source, so a changed query fails here.
print("RC weekly payout report (Functions)")
FN_INDEX = REPO / "functions" / "src" / "index.ts"
_fsrc = FN_INDEX.read_text()
_at = _fsrc.index(".collection('users').doc(hostUid).collection('beanTransactions')")
_q = _fsrc[_at:_fsrc.index(".get()", _at)]
ok("the report filters type == 'credit'", ".where('type', '==', 'credit')" in _q, _q)
ok("…and a range on timestamp",
   ".where('timestamp', '>=', weekStart)" in _q and ".where('timestamp', '<=', now)" in _q, _q)
ok("…with no orderBy (the range field is the index's last field)", ".orderBy(" not in _q, _q)
ok("…and it is the only beanTransactions query in index.ts",
   _fsrc.count(".collection('beanTransactions')") == 1)
_bt = [[(f["fieldPath"], f.get("order")) for f in i["fields"]]
       for i in raw["indexes"]
       if i.get("collectionGroup") == "beanTransactions" and i.get("queryScope") == "COLLECTION"]
ok("beanTransactions: type ASC + timestamp ASC is declared at COLLECTION scope",
   [("type", "ASCENDING"), ("timestamp", "ASCENDING")] in _bt,
   "missing — every Host's weekly beans read as 0 (the error is only logged)")
ok("…the collection-group (reason, timestamp desc) index the CRM uses is kept",
   any(i.get("collectionGroup") == "beanTransactions" and i.get("queryScope") == "COLLECTION_GROUP"
       and [(f["fieldPath"], f.get("order")) for f in i["fields"]] == [("reason", "ASCENDING"), ("timestamp", "DESCENDING")]
       for i in raw["indexes"]))

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    print("\nA query that mixes an equality filter with an order on another "
          "field needs a composite index declared in firestore.indexes.json.\n")
    sys.exit(1)
print(f"\nAll {checks} index checks passed.")
print("  · both appeals queries have a declared composite index, in the")
print("    direction the source actually orders by")
print("  · the equality-only dedupe query correctly needs none")
print("  · the Android myAppeals() index is preserved")
print("  · no duplicates, and the other CRM queues still have theirs\n")
