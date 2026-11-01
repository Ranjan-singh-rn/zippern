"""P1-A3 (MFA release, revision 4): one Owner MFA enrolment record per Owner.

`owner_mfa.start_enrolment` upserts on `uid`. Without a unique index on `uid`, two
simultaneous first starts for one Owner could each insert a row, and the readers
(`find_one({"uid": …})`) would then see whichever came first. Revision 4 builds the
index in `ensure_indexes()`, which every revision runs at start-up.

What this checks, against the in-memory Mongo that enforces unique indexes:
  1. `ensure_indexes()` builds `owner_mfa` {uid: 1}, unique, named `owner_mfa_uid_unique`,
     and running it again is harmless (idempotent, as on every start-up).
  2. With it, a second `owner_mfa` row for the same Owner is refused.
  3. If the index cannot be built (duplicates already there), start-up does not crash,
     and the failure is logged at ERROR with the line the release checks for.

Run:  python3 -m tests.test_p2_owner_mfa_index
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

from app.db import mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def run(c):
    return asyncio.get_event_loop().run_until_complete(c)


# ── 1. Built, unique, named, idempotent ─────────────────────────────────────────────────────────
db = FakeDb()
mongo.get_db = lambda: db
run(mongo.ensure_indexes())
spec = db[C.OWNER_MFA].indexes.get(mongo.OWNER_MFA_UID_INDEX)
ok("1a ensure_indexes() builds the owner_mfa uid index", spec is not None)
ok("1b on uid alone, ascending", bool(spec) and spec["key"] == [("uid", 1)])
ok("1c unique", bool(spec) and spec["unique"] is True)
ok("1d named owner_mfa_uid_unique", mongo.OWNER_MFA_UID_INDEX == "owner_mfa_uid_unique")
try:
    run(mongo.ensure_indexes())
    again = None
except Exception as exc:  # noqa: BLE001
    again = exc
ok("1e running it again (every start-up) is harmless", again is None)

# ── 2. A second row for the same Owner is refused ───────────────────────────────────────────────
run(db[C.OWNER_MFA].insert_one({"uid": "own1", "pending_secret": "sealed"}))
try:
    run(db[C.OWNER_MFA].insert_one({"uid": "own1", "pending_secret": "sealed-2"}))
    dup = None
except Exception as exc:  # noqa: BLE001
    dup = exc
ok("2a a second owner_mfa row for one Owner is refused", dup is not None and "duplicate" in str(dup).lower())
ok("2b another Owner is unaffected",
   run(db[C.OWNER_MFA].insert_one({"uid": "own2", "pending_secret": "sealed"})) is not None)

# ── 3. Cannot be built: start-up continues, the failure is logged at ERROR ──────────────────────
db2 = FakeDb()
run(db2[C.OWNER_MFA].insert_one({"uid": "own9"}))
run(db2[C.OWNER_MFA].insert_one({"uid": "own9"}))      # duplicates from before the index existed
mongo.get_db = lambda: db2
cap = _Capture()
mongo.log.addHandler(cap)
try:
    run(mongo.ensure_indexes())
    crashed = None
except Exception as exc:  # noqa: BLE001
    crashed = exc
mongo.log.removeHandler(cap)
ok("3a start-up does not crash when the index cannot be built", crashed is None)
ok("3b the index was not built over duplicates", mongo.OWNER_MFA_UID_INDEX not in db2[C.OWNER_MFA].indexes)
ok("3c the failure is logged at ERROR with the line the release checks for",
   any("owner_mfa: the uid unique index could not be built" in line for line in cap.lines))

# ── 4. Wiring ────────────────────────────────────────────────────────────────────────────────────
src = (ROOT / "app" / "db" / "mongo.py").read_text()
body = src[src.find("async def ensure_indexes("):]
ok("4a the index is built inside ensure_indexes()", "db[C.OWNER_MFA].create_index(" in body
   and "unique=True, name=OWNER_MFA_UID_INDEX" in body)

if failures:
    print(f"{len(failures)} of {checks} owner_mfa index checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} owner_mfa index checks passed.")
