"""P1-G — `scripts/survey_legacy_roles.py` is strictly read-only.

Runs the real survey against recording fakes for Firebase and Mongo. Any write
method (Firestore set/update/delete/add/batch, Mongo insert/update/delete/
index creation) raises and fails the test. Also checks it asks Mongo for
`connect(ensure=False)` (no index DDL), counts legacy roles and orphans, and
prints no uid, name, email or phone.

Run:  python3 -m tests.test_p1_survey_readonly
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import install_module_stubs  # noqa: E402

install_module_stubs()

from app.db import firebase, mongo  # noqa: E402
from scripts import survey_legacy_roles as survey  # noqa: E402

writes: list[str] = []
connect_calls: list[dict] = []


class NoWrite:
    def __getattr__(self, name):
        if name in {"set", "update", "delete", "add", "batch", "create", "insert_one", "insert_many",
                    "update_one", "update_many", "delete_one", "delete_many", "replace_one",
                    "create_index", "create_indexes", "drop", "bulk_write", "find_one_and_update"}:
            def refuse(*a, **k):
                writes.append(name)
                raise AssertionError(f"write attempted: {name}")
            return refuse
        raise AttributeError(name)


class Snap(NoWrite):
    def __init__(self, id_, data):
        self.id, self._d = id_, data
        self.reference = NoWrite()

    def to_dict(self):
        return dict(self._d)


class Coll(NoWrite):
    def __init__(self, docs):
        self._docs = docs

    def stream(self):
        return iter([Snap(k, v) for k, v in self._docs.items()])

    def document(self, *_):
        return NoWrite()


class Client(NoWrite):
    project = "demo-zipper"

    def __init__(self, cols):
        self._cols = cols

    def collection(self, name):
        return Coll(self._cols.get(name, {}))


class Cursor:
    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        self._it = iter(self._rows)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class MColl(NoWrite):
    def __init__(self, rows):
        self._rows = rows

    def find(self, *_a, **_k):
        return Cursor(self._rows)


class MDb:
    def __init__(self, cols):
        self._cols = cols

    def __getitem__(self, name):
        return MColl(self._cols.get(name, []))


CRM = {
    "u-legacy-admin": {"role": "admin", "name": "SECRET-NAME", "phone": "+910000000001", "email": "a@x.test"},
    "u-legacy-ops": {"role": "ops", "isActive": False},
    "u-app": {"role": "app_admin"},
    "u-orphan": {"role": "tech_member"},
    "u-agency": {"role": "agency", "roles": ["agency"]},
}
STAFF = [
    {"uid": "u-legacy-admin", "role": "app_admin"},
    {"uid": "u-app", "role": "app_admin"},
    {"uid": "u-nodoc", "role": "support_member"},
    {"uid": "observer:x", "role": "observer"},
]

firebase.init = lambda: None
firebase.firestore_client = lambda: Client({"crmUsers": CRM})


async def fake_connect(**kw):
    connect_calls.append(kw)


mongo.connect = fake_connect
import app.db.mongo as mongo_mod  # noqa: E402
mongo_mod.get_db = lambda: MDb({"staff": STAFF})

out = io.StringIO()
with contextlib.redirect_stdout(out):
    rc = asyncio.run(survey._run())
text = out.getvalue()

failures: list[str] = []


def ok(label, cond):
    if not cond:
        failures.append(label)


ok("no write of any kind was attempted", writes == [])
ok("Mongo is connected with ensure=False (no index DDL)", connect_calls == [{"ensure": False}])
ok("exit code 3 when legacy strings exist", rc == 3)
ok("legacy admin counted", "admin: 1" in text and "ops: 1" in text)
ok("two legacy documents flagged", "legacy documents: 2" in text)
ok("orphan crmUsers staff doc counted (no staff row)", "orphaned crmUsers staff documents (no Mongo staff row): 2" in text)
ok("staff row with no crmUsers doc counted, observer excluded", "Mongo staff rows with no crmUsers document (observer excluded): 1" in text)
ok("partners are not counted as orphans", "agency active" not in text)
for secret in ("u-legacy-admin", "u-orphan", "SECRET-NAME", "+910000000001", "a@x.test", "u-nodoc"):
    ok(f"does not print {secret!r}", secret not in text)

if failures:
    print(text)
    print(f"{len(failures)} survey read-only checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print("All survey read-only checks passed.")
