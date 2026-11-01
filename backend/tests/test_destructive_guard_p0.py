"""P0-10 (OPS-C) — the reset, purge and seed scripts name and confirm their target.

`app/core/destructive.py` is the gate; this pins what it decides and that the
five scripts the audit names call it before they connect, and check the data
canary before they write:

    execute_test_data_reset · reset_test_data · reset_firestore ·
    purge_app_balances · seed_accounts

Pure: fake settings objects, a fake database, and a read of the scripts'
source. Nothing connects anywhere.

Run:  python3 -m tests.test_destructive_guard_p0
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core import destructive as D  # noqa: E402

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def refused(label: str, fn, needle: str = "") -> None:
    global checks
    checks += 1
    try:
        fn()
    except D.DestructiveRefused as exc:
        if needle and needle not in str(exc):
            failures.append(f"{label}: refused, but not for the expected reason ({exc})")
        return
    failures.append(f"{label}: was NOT refused")


tmp = Path(tempfile.mkdtemp())
KEY_REAL = tmp / "key-real.json"
KEY_REAL.write_text(json.dumps({"project_id": "real-project-1"}))   # no secret material
KEY_OTHER = tmp / "key-other.json"
KEY_OTHER.write_text(json.dumps({"project_id": "some-other-project"}))


def local(**over):
    base = dict(
        environment="development", firebase_project_id="demo-zipper",
        mongo_uri="mongodb://127.0.0.1:27017/?directConnection=true",
        firestore_emulator_host="127.0.0.1:8080", firebase_auth_emulator_host="127.0.0.1:9099",
        storage_emulator_host="http://127.0.0.1:9199", firebase_storage_bucket="",
        firebase_credentials_path="",
    )
    base.update(over)
    return types.SimpleNamespace(**base)


def prod(key=KEY_REAL, **over):
    base = dict(environment="production", firebase_project_id="real-project-1",
                mongo_uri="mongodb+srv://x/", firebase_credentials_path=str(key))
    base.update(over)
    return types.SimpleNamespace(**base)


ACK = {"ZIPPER_ALLOW_PRODUCTION_ACCESS": "real-project-1"}
CONFIRM = {"ZIPPER_CONFIRM_DESTRUCTIVE": "reset_test_data:real-project-1"}

# ── Local ─────────────────────────────────────────────────────────────────────
line = D.require_destructive_target("reset_test_data", writes=True, settings=local(), environ={})
ok("a local run is allowed and says it is LOCAL", "LOCAL" in line)
refused("a 'local' run pointed at a remote MongoDB is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=True,
                                             settings=local(mongo_uri="mongodb+srv://cluster/"), environ={}))
refused("a 'local' run with a real project id is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=True,
                                             settings=local(firebase_project_id="real-project-1"), environ={}))

# ── Production mode ───────────────────────────────────────────────────────────
refused("production with no acknowledgement is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=False, settings=prod(), environ={}),
        "ZIPPER_ALLOW_PRODUCTION_ACCESS")
refused("Cloud Run's K_SERVICE does not exempt a script",
        lambda: D.require_destructive_target("reset_test_data", writes=False, settings=prod(),
                                             environ={"K_SERVICE": "zipper-api"}),
        "ZIPPER_ALLOW_PRODUCTION_ACCESS")
refused("a key for ANOTHER project is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=False,
                                             settings=prod(key=KEY_OTHER), environ=ACK),
        "different project")
refused("no readable key is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=False,
                                             settings=prod(key=tmp / "missing.json"), environ=ACK))
refused("a WRITE without the typed confirmation is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=True, settings=prod(), environ=ACK),
        "ZIPPER_CONFIRM_DESTRUCTIVE")
refused("a confirmation typed for ANOTHER script is refused",
        lambda: D.require_destructive_target("reset_test_data", writes=True, settings=prod(),
                                             environ={**ACK, "ZIPPER_CONFIRM_DESTRUCTIVE": "seed_accounts:real-project-1"}))
line = D.require_destructive_target("reset_test_data", writes=False, settings=prod(), environ=ACK)
ok("a confirmed READ-ONLY run is allowed and names the project", "real-project-1" in line and "read-only" in line)
line = D.require_destructive_target("reset_test_data", writes=True, settings=prod(), environ={**ACK, **CONFIRM})
ok("a confirmed WRITE names the project", "real-project-1" in line and "for writes" in line)


# ── The data canary ───────────────────────────────────────────────────────────
class _Coll:
    def __init__(self, doc):
        self.doc = doc

    async def find_one(self, q):
        return self.doc


class _Db(dict):
    def __getitem__(self, k):
        return dict.get(self, k, _Coll(None))


def canary(db, settings):
    return lambda: asyncio.run(D.require_data_canary(db, "reset_test_data", settings=settings))


refused("production with NO canary refuses every destructive write", canary(_Db(), prod()), "canary")
refused("a canary naming ANOTHER project refuses",
        canary(_Db({D.CANARY_COLLECTION: _Coll({"_id": "target", "firebase_project_id": "x"})}), prod()))
asyncio.run(D.require_data_canary(_Db({D.CANARY_COLLECTION: _Coll({"_id": "target", "firebase_project_id": "real-project-1"})}),
                                  "reset_test_data", settings=prod()))
ok("a canary naming this project passes", True)
asyncio.run(D.require_data_canary(_Db(), "reset_test_data", settings=local()))
ok("a local run needs no canary", True)

# ── The five scripts call the gate, in order ──────────────────────────────────
SCRIPTS = {
    "execute_test_data_reset": "execute_test_data_reset.py",
    "reset_test_data": "reset_test_data.py",
    "reset_firestore": "reset_firestore.py",
    "purge_app_balances": "purge_app_balances.py",
    "seed_accounts": "seed_accounts.py",
}
for name, file in SCRIPTS.items():
    src = (ROOT / "scripts" / file).read_text()
    gate = src.find(f'require_destructive_target("{name}"')
    init = src.find("firebase.init()")
    # Any `mongo.connect(...)` call connects — including `connect(ensure=False)`,
    # which the reset tools use so a reset never builds indexes (DDL).
    connect = src.find("await mongo.connect(", init)
    can = src.find(f'require_data_canary(', gate)
    ok(f"{file}: names and confirms its target", gate >= 0)
    ok(f"{file}: …before Firebase is initialised", gate >= 0 and init >= 0 and gate < init)
    ok(f"{file}: checks the data canary", can >= 0)
    # The canary is checked after connecting (it is a read) — find the LAST
    # connect before the canary call.
    last_connect = src.rfind("await mongo.connect(", 0, can) if can >= 0 else -1
    ok(f"{file}: …after connecting to MongoDB", can >= 0 and last_connect >= 0 and last_connect < can)

# ── Result ────────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} P0-10 destructive-guard checks passed.")
sys.exit(0)
