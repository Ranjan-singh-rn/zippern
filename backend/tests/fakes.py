"""Stubs that let the real service code run with no database and no network.

`tests/test_commission.py` needs none of this: the commission engine imports
nothing heavy on purpose, so the test exercises the real engine directly.
`app/services/partner_ops.py` cannot be written that way — it is the module that
talks to Mongo and Firestore — so the I/O underneath it is stubbed instead, and
the code under test is the real code, unmodified.

Two layers:

  * `install_module_stubs()` puts minimal fakes for the third-party packages in
    `sys.modules` **before** `app.services.partner_ops` is imported. Nothing
    here pretends to be a database; each fake is the smallest object that
    satisfies what the import chain reads at import time.
  * `FakeDb` / `FakeCollection` are an in-memory stand-in for the one collection
    these tests touch, with real `_id` uniqueness — which is the behaviour the
    idempotency of `ensure_partner_record` actually rests on.
"""

from __future__ import annotations

import sys
import types
from typing import Any


# ── Third-party module stubs ──────────────────────────────────────────────────


def _module(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


class PyMongoError(Exception):
    """Stands in for `pymongo.errors.PyMongoError`, the base of them all.

    `app/services/reports.py` imports it at module scope and catches it around
    every aggregation, so it has to exist before that module is imported — and
    it has to be the *same class object*, or an `except PyMongoError` in the
    service would not catch what a fake collection raises.
    """


class DuplicateKeyError(PyMongoError):
    """Stands in for `pymongo.errors.DuplicateKeyError`.

    The real one is what a unique-index violation raises, and
    `ensure_partner_record` catches it by name — so it has to be the same class
    object the service imported, which is why the fake is installed before the
    service is. It subclasses `PyMongoError` exactly as the real one does, so a
    handler written for the base class catches it here too.
    """


class ObjectId:
    """Enough of `bson.ObjectId` for the card helpers to import."""

    def __init__(self, value: Any = None):
        text = str(value or "")
        if len(text) != 24:
            raise ValueError(f"{value!r} is not a valid ObjectId")
        self._value = text

    def __str__(self) -> str:
        return self._value

    def __eq__(self, other: object) -> bool:
        return isinstance(other, ObjectId) and str(other) == self._value

    def __hash__(self) -> int:
        return hash(self._value)


class _ReturnDocument:
    BEFORE = False
    AFTER = True


class _BaseSettings:
    """`pydantic_settings.BaseSettings` without pydantic.

    `app/config.py` declares annotated class attributes with defaults, which are
    ordinary class attributes — so plain attribute lookup gives every setting its
    documented default. Nothing in these tests reads a setting that matters.
    """

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)


class FieldFilter:
    """`google.cloud.firestore_v1.base_query.FieldFilter`, enough of it."""

    def __init__(self, field_path: str, op: str, value: Any):
        self.field_path = field_path
        self.op_string = op
        self.value = value


# ── Write sentinels ───────────────────────────────────────────────────────────
#
# `DELETE_FIELD`, `ArrayUnion` and `ArrayRemove` are values the Admin SDK
# recognises inside a write and turns into a server-side transform. The fake
# Firestore below APPLIES them rather than storing them, because the moderation
# code depends on what they mean and not merely on having called them:
#
#   · resuming a suspension DELETES `suspendedUntil`, and the nightly sweep's
#     query is `isSuspended == true AND suspendedUntil <= now` — a fake that
#     stored the sentinel as a value would leave the account matching that
#     query for ever and the test would not notice;
#   · unbanning an account ARRAY-REMOVES its uid from `bannedDevices.
#     sourceAccounts`, and whether that list is then empty is the whole of the
#     decision about whether the handset is released or stays barred.


class DeleteField:
    """`firestore.DELETE_FIELD` — remove the key entirely."""

    def __repr__(self) -> str:  # pragma: no cover - debugging only
        return "DELETE_FIELD"


class ArrayUnion:
    """`firestore.ArrayUnion([...])` — append the values that are not there."""

    def __init__(self, values: Any):
        self.values = list(values or [])


class ArrayRemove:
    """`firestore.ArrayRemove([...])` — drop every occurrence of each value."""

    def __init__(self, values: Any):
        self.values = list(values or [])


def _apply_transform(existing: Any, value: Any) -> tuple[bool, Any]:
    """`(keep, new_value)` for one field of a write.

    `keep` is False only for `DELETE_FIELD`, which is the one case where the
    key has to disappear rather than take a new value.
    """
    if isinstance(value, DeleteField):
        return False, None
    if isinstance(value, ArrayUnion):
        current = list(existing) if isinstance(existing, list) else []
        for item in value.values:
            if item not in current:
                current.append(item)
        return True, current
    if isinstance(value, ArrayRemove):
        current = list(existing) if isinstance(existing, list) else []
        return True, [item for item in current if item not in value.values]
    return True, _deep_copy(value)


#: What the fake Firebase Auth was asked to do, so a test can assert it was
#: asked at all. Module-level because the stub functions are installed once into
#: `sys.modules` and shared by every test in the process.
AUTH_CALLS: dict[str, list] = {"disabled": [], "revoked": []}


def reset_auth_calls() -> None:
    AUTH_CALLS["disabled"].clear()
    AUTH_CALLS["revoked"].clear()


def install_module_stubs() -> None:
    """Install the fakes. Safe to call more than once."""
    if "app.services.partner_ops" in sys.modules:  # pragma: no cover
        raise RuntimeError(
            "install_module_stubs() must run before app.services is imported."
        )

    _module(
        "pydantic_settings",
        BaseSettings=_BaseSettings,
        SettingsConfigDict=lambda **kw: dict(**kw),
    )

    _module("bson", ObjectId=ObjectId)

    pymongo = _module(
        "pymongo",
        ASCENDING=1,
        DESCENDING=-1,
        ReturnDocument=_ReturnDocument,
    )
    pymongo.errors = _module(
        "pymongo.errors",
        PyMongoError=PyMongoError,
        DuplicateKeyError=DuplicateKeyError,
    )

    motor = _module("motor")
    motor.motor_asyncio = _module(
        "motor.motor_asyncio",
        AsyncIOMotorClient=object,
        AsyncIOMotorDatabase=object,
        AsyncIOMotorClientSession=object,
    )

    firebase_admin = _module(
        "firebase_admin",
        App=object,
        initialize_app=lambda *a, **k: object(),
    )
    firebase_admin.auth = _module(
        "firebase_admin.auth",
        UserNotFoundError=type("UserNotFoundError", (Exception,), {}),
        verify_id_token=lambda *a, **k: {},
        get_user_by_email=lambda *a, **k: None,
        get_user=lambda *a, **k: None,
        create_user=lambda *a, **k: None,
        generate_password_reset_link=lambda *a, **k: "",
        # ── Revocation ───────────────────────────────────────────────────────
        #
        # Recorded, not swallowed. The point of a revocation test is that the
        # credential was actually revoked: deactivating staff used to flip two
        # application flags and leave the Firebase login working indefinitely,
        # and a stub that quietly accepted the call would let that reopen with
        # every test still passing.
        #
        # Read through `auth_calls()`. A test wanting the failure path replaces
        # these with something that raises.
        update_user=lambda uid, **k: AUTH_CALLS["disabled"].append((uid, k)),
        revoke_refresh_tokens=lambda uid: AUTH_CALLS["revoked"].append(uid),
    )
    firebase_admin.credentials = _module(
        "firebase_admin.credentials",
        Certificate=lambda *a, **k: object(),
        ApplicationDefault=lambda *a, **k: object(),
    )
    firebase_admin.firestore = _module(
        "firebase_admin.firestore", client=lambda *a, **k: None
    )

    google = sys.modules.get("google") or _module("google")
    cloud = _module("google.cloud")
    firestore_v1 = _module("google.cloud.firestore_v1", GeoPoint=object)
    # A real little object rather than `object()`. `crm_directory.find_by_email`
    # builds one and hands it to `.where(filter=...)`, and the observer rule —
    # match on email, never on uid — is only actually exercised if the fake
    # Firestore can read what the filter asked for.
    base_query = _module(
        "google.cloud.firestore_v1.base_query",
        FieldFilter=FieldFilter,
    )
    firestore_v1.base_query = base_query
    cloud.firestore_v1 = firestore_v1
    google.cloud = cloud


# ── An in-memory collection with real `_id` uniqueness ────────────────────────


def _deep_copy(value: Any) -> Any:
    """Copy the way a database round trip does — the caller cannot reach in and
    mutate a stored document by holding on to what it inserted."""
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(v) for v in value]
    return value


def _set_path(doc: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    target = doc
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value


def _read_path(doc: Any, path: str) -> Any:
    """`credit.outstanding` on a nested document, or None."""
    node = doc
    for part in str(path).split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


def _expr(doc: dict, expr: Any) -> Any:
    """One aggregation expression: a field reference, `$cond`, `$gt`, or a
    literal. Only the operators the partner aggregates actually use."""
    if isinstance(expr, str) and expr.startswith("$"):
        return _read_path(doc, expr[1:])
    if isinstance(expr, dict):
        if "$cond" in expr:
            test, then, otherwise = expr["$cond"]
            return then if _expr(doc, test) else otherwise
        if "$gt" in expr:
            left, right = (_expr(doc, e) for e in expr["$gt"])
            return left is not None and left > right
    return expr


def _group(docs: list[dict], spec: dict) -> list[dict]:
    buckets: dict[Any, list[dict]] = {}
    order: list[Any] = []
    for doc in docs:
        key = _expr(doc, spec.get("_id"))
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append(doc)

    out: list[dict] = []
    for key in order:
        rows = buckets[key]
        entry: dict = {"_id": key}
        for field, accumulator in spec.items():
            if field == "_id":
                continue
            ((acc_op, acc_expr),) = accumulator.items()
            if acc_op != "$sum":  # pragma: no cover
                raise NotImplementedError(f"FakeDb does not implement {acc_op}")
            if acc_expr == 1:
                entry[field] = len(rows)
            else:
                entry[field] = sum(int(_expr(r, acc_expr) or 0) for r in rows)
        out.append(entry)
    return out


class FakeCursor:
    """What `find()` hands back: sort, limit, and async iteration.

    Enough for `list_partners`, which is the queue the CRM's /agencies and
    /sellers screens read — so a test can assert that an application really does
    land in it rather than assert that a function was called.
    """

    def __init__(self, docs: list[dict]):
        self._docs = docs

    def sort(self, key: str, direction: int = 1) -> "FakeCursor":
        self._docs = sorted(
            self._docs,
            key=lambda d: (d.get(key) is None, _sort_key(d.get(key))),
            reverse=direction < 0,
        )
        return self

    def skip(self, n: int) -> "FakeCursor":
        self._docs = self._docs[n:]
        return self

    def limit(self, n: int) -> "FakeCursor":
        if n:
            self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        async def gen():
            for doc in self._docs:
                yield _deep_copy(doc)

        return gen()


def _sort_key(value: Any) -> Any:
    """Order `None`, datetimes, numbers and strings without comparing types."""
    if value is None:
        return 0
    if hasattr(value, "timestamp"):
        return value.timestamp()
    if isinstance(value, (int, float)):
        return value
    return str(value)


class FakeCollection:
    """The handful of operations the creation and approval paths use.

    `_id` uniqueness is enforced on insert exactly as Mongo enforces it, because
    that — not the read before it — is what makes creation idempotent under a
    race, and a fake that let a duplicate through would make the test pass for
    the wrong reason.
    """

    def __init__(self, name: str, unique: tuple[str, ...] = ()):
        self.name = name
        self.docs: dict[Any, dict] = {}
        self.unique = unique
        self.inserts = 0

    async def find_one(self, query: dict, session: Any = None) -> dict | None:
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items()):
                return _deep_copy(doc)
        return None

    def find(self, query: dict | None = None) -> FakeCursor:
        return FakeCursor(
            [
                _deep_copy(d)
                for d in self.docs.values()
                if all(d.get(k) == v for k, v in (query or {}).items())
            ]
        )

    def aggregate(self, pipeline: list[dict]) -> FakeCursor:
        """`$match` and `$group`, which is what the partner aggregates use.

        `partners.total_credit_exposure` is a `$match` on `kind` followed by a
        `$group` that sums `credit.outstanding` and counts. It is one of the
        readers that must keep meaning exactly what it meant once a login can
        hold two partner records, so it is exercised rather than described — and
        that needs a fake that really groups.
        """
        docs = [_deep_copy(d) for d in self.docs.values()]
        for stage in pipeline:
            ((op, spec),) = stage.items()
            if op == "$match":
                docs = [
                    d
                    for d in docs
                    if all(_read_path(d, k) == v for k, v in spec.items())
                ]
            elif op == "$group":
                docs = _group(docs, spec)
            else:  # pragma: no cover
                raise NotImplementedError(f"FakeDb does not implement {op}")
        return FakeCursor(docs)

    async def insert_one(self, doc: dict, session: Any = None) -> Any:
        # `partners` documents carry their own `_id` (the Firestore id) and the
        # uniqueness of it is what these tests rest on. `staff` does not — Mongo
        # mints one — so one is minted here rather than making the caller invent
        # a field the real collection does not have.
        if "_id" not in doc:
            doc = {**doc, "_id": f"{self.name}-{len(self.docs) + 1}"}
        _id = doc["_id"]
        if _id in self.docs:
            raise DuplicateKeyError(f"E11000 duplicate key on _id: {_id!r}")
        for field in self.unique:
            if field not in doc:
                continue
            if any(other.get(field) == doc[field] for other in self.docs.values()):
                raise DuplicateKeyError(
                    f"E11000 duplicate key on {field}: {doc[field]!r}"
                )
        self.docs[_id] = _deep_copy(doc)
        self.inserts += 1
        return types.SimpleNamespace(inserted_id=_id)

    async def update_one(self, query: dict, update: dict, upsert: bool = False,
                         session: Any = None) -> Any:
        doc = await self._raw(query)
        if doc is None:
            if not upsert:
                return types.SimpleNamespace(modified_count=0, upserted_id=None)
            # Mongo seeds an upsert from the equality terms of the query, then
            # applies `$setOnInsert` and `$set`. `scripts/repair_staff_accounts`
            # depends on that being an insert-or-nothing, so a second run — or a
            # parallel one — cannot overwrite a row somebody has since edited.
            seed: dict = {
                k: v for k, v in query.items() if not str(k).startswith("$")
            }
            seed.update(_deep_copy(update.get("$setOnInsert") or {}))
            self._apply(seed, {"$set": update.get("$set") or {}})
            result = await self.insert_one(seed)
            return types.SimpleNamespace(
                modified_count=0, upserted_id=result.inserted_id
            )
        self._apply(doc, update)
        return types.SimpleNamespace(modified_count=1, upserted_id=None)

    async def update_many(self, query: dict, update: dict, session: Any = None) -> Any:
        touched = 0
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items()):
                self._apply(doc, update)
                touched += 1
        return types.SimpleNamespace(modified_count=touched)

    async def find_one_and_update(
        self, query: dict, update: dict, return_document: bool = True,
        session: Any = None,
    ) -> dict | None:
        doc = await self._raw(query)
        if doc is None:
            return None
        before = _deep_copy(doc)
        self._apply(doc, update)
        return _deep_copy(doc) if return_document else before

    async def _raw(self, query: dict) -> dict | None:
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items()):
                return doc
        return None

    @staticmethod
    def _apply(doc: dict, update: dict) -> None:
        for path, value in (update.get("$set") or {}).items():
            _set_path(doc, path, value)
        for path, value in (update.get("$inc") or {}).items():
            parts = path.split(".")
            target = doc
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = int(target.get(parts[-1], 0)) + int(value)
        for path, value in (update.get("$push") or {}).items():
            parts = path.split(".")
            target = doc
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target.setdefault(parts[-1], []).append(_deep_copy(value))


class FakeDb:
    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            unique = ("crm_id",) if name == "partners" else ()
            self.collections[name] = FakeCollection(name, unique)
        return self.collections[name]


# ── An in-memory Firestore ────────────────────────────────────────────────────
#
# `app/services/crm_directory.py` is the module that writes the `crmUsers`
# document a staff account cannot sign in to the CRM without, so its tests have
# to run the real thing rather than assert that a function was called. This is
# the smallest Firestore that supports what it does: set-with-merge, get, delete,
# stream, and an equality `where` — that last one because the observer rule
# matches on **email, not uid**, and a fake that ignored the filter would make
# that test pass no matter which field the code looked at.


class FakeSnapshot:
    def __init__(self, ref: "FakeDocument", data: dict | None):
        self.id = ref.id
        self.reference = ref
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict | None:
        return _deep_copy(self._data) if self._data is not None else None


class FakeDocument:
    """One document, and the doorway to its subcollections.

    `col` rather than `collection`, because `collection` is a METHOD on a real
    document reference — `users/{uid}.collection('devices')` is how the device
    subcollection is reached, and `ban_user` walks it to find every handset an
    account has signed in from. The attribute was named `collection` here and
    nothing could have both.
    """

    def __init__(self, collection: "FakeFsCollection", doc_id: str):
        self.col = collection
        self.id = doc_id

    # ── Subcollections ────────────────────────────────────────────────────
    #
    # Held on the PARENT collection, keyed by (document id, name), so the
    # devices of two different accounts cannot be confused for each other and
    # so a test can reach in and seed one.

    def collection(self, name: str) -> "FakeFsCollection":
        return self.col.subcollection(self.id, name)

    @staticmethod
    def _write(data: dict, doc: dict, *, dotted_paths: bool) -> dict:
        """Apply one write's fields onto a document, honouring the sentinels.

        `dotted_paths` is the difference between the two write methods and it
        is Firestore's, not an invention here: `update()` reads `a.b` as a path
        into a nested map, `set()` reads it as a field whose name contains a
        dot. Collapsing the two would have `set()` quietly restructure any
        document whose key had a dot in it.
        """
        for key, value in data.items():
            key = str(key)
            parts = key.split(".") if dotted_paths else [key]

            target = doc
            missing = False
            for part in parts[:-1]:
                nxt = target.get(part)
                if not isinstance(nxt, dict):
                    if isinstance(value, DeleteField):
                        missing = True
                        break
                    nxt = {}
                    target[part] = nxt
                target = nxt
            if missing:
                continue

            leaf = parts[-1]
            keep, resolved = _apply_transform(target.get(leaf), value)
            if keep:
                target[leaf] = resolved
            else:
                # DELETE_FIELD. Popping the key is what makes the sweep's
                # `suspendedUntil <= now` query stop matching a resumed
                # account — a fake that stored a sentinel instead would leave
                # it being resumed again every night.
                target.pop(leaf, None)
        return doc

    def set(self, data: dict, merge: bool = False) -> None:
        self.col.writes.append((self.id, _deep_copy(data), merge))
        self.col.fail_if_asked("set", self.id)
        if merge and self.id in self.col.docs:
            self._write(data, self.col.docs[self.id], dotted_paths=False)
        else:
            self.col.docs[self.id] = self._write(data, {}, dotted_paths=False)

    def update(self, data: dict) -> None:
        """Firestore's `update`: merge into a document that must already exist.

        The "must already exist" half is the point. `_sync_partner_doc` tries
        `update` first and falls back to a `crmId` lookup when it raises, and
        that fallback is only exercised if the fake really does refuse a write
        to a document that is not there.
        """
        self.col.fail_if_asked("update", self.id)
        if self.id not in self.col.docs:
            raise RuntimeError(
                f"404 No document to update: {self.col.name}/{self.id}"
            )
        self.col.writes.append((self.id, _deep_copy(data), True))
        self._write(data, self.col.docs[self.id], dotted_paths=True)

    def get(self) -> FakeSnapshot:
        self.col.fail_if_asked("get", self.id)
        return FakeSnapshot(self, self.col.docs.get(self.id))

    def delete(self) -> None:
        self.col.fail_if_asked("delete", self.id)
        self.col.docs.pop(self.id, None)
        self.col.deleted.append(self.id)


def _compare(left: Any, op: str, right: Any) -> bool:
    """One `where` clause, for the operators this codebase actually queries with.

    `<=` is here because the expired-suspension sweep is
    `isSuspended == true AND suspendedUntil <= now`, and `array_contains`
    because that is how `unban_user` finds every device ban naming an account.
    A fake that answered those with "not implemented" would leave the two
    queries that decide who gets let back into the product untested.
    """
    if op == "==":
        return left == right
    if op == "!=":
        return left != right
    if op == "array_contains":
        return isinstance(left, (list, tuple)) and right in left
    if op == "array_contains_any":
        return isinstance(left, (list, tuple)) and any(v in left for v in right or [])
    if op == "in":
        return left in (right or [])
    if left is None:
        # Firestore does not match a missing field against an inequality, and
        # neither does this: an account with no `suspendedUntil` is the
        # indefinite kind and the sweep must never pick it up.
        return False
    try:
        if op == "<":
            return left < right
        if op == "<=":
            return left <= right
        if op == ">":
            return left > right
        if op == ">=":
            return left >= right
    except TypeError:  # pragma: no cover — a field of the wrong shape
        return False
    raise NotImplementedError(f"FakeFirestore does not implement '{op}'")


class FakeQuery:
    def __init__(self, collection: "FakeFsCollection", rows: list[tuple[str, dict]]):
        self.collection = collection
        self.rows = rows

    def where(self, filter: Any = None, **_kw) -> "FakeQuery":  # noqa: A002
        if filter is None:
            return self
        path = filter.field_path
        op = getattr(filter, "op_string", "==")
        value = filter.value
        return FakeQuery(
            self.collection,
            [(i, d) for i, d in self.rows if _compare(_read_path(d, path), op, value)],
        )

    def order_by(self, field: str, direction: Any = "ASCENDING") -> "FakeQuery":
        rows = sorted(
            self.rows,
            key=lambda row: (_read_path(row[1], field) is None,
                             _sort_key(_read_path(row[1], field))),
            reverse=str(direction).upper().endswith("DESCENDING"),
        )
        return FakeQuery(self.collection, rows)

    def select(self, _fields: Any) -> "FakeQuery":
        """A projection. The fake returns whole documents regardless.

        Honest about it rather than silently dropping fields: nothing in this
        codebase reads anything but `d.id` off a projected query, and a fake
        that really did strip fields would fail loudly the day somebody did.
        """
        return self

    def limit(self, n: int) -> "FakeQuery":
        """Firestore's `limit`. Real, not a no-op.

        `services/broadcast.py` reads the app-user collection with
        `limit(ceiling + 1)` and refuses when it comes back full — that is how
        it can say "this audience is larger than I will send to" without
        reading a hundred thousand documents to find out. A fake that ignored
        the limit would let the ceiling test pass while the production query it
        stands for was unbounded.
        """
        return FakeQuery(self.collection, self.rows[: max(0, int(n))])

    def stream(self):
        self.collection.fail_if_asked("stream", "")
        return [
            FakeSnapshot(FakeDocument(self.collection, i), d) for i, d in self.rows
        ]


class FakeFsCollection:
    def __init__(self, name: str):
        self.name = name
        self.docs: dict[str, dict] = {}
        self.writes: list[tuple[str, dict, bool]] = []
        self.deleted: list[str] = []
        #: (operation, doc id or "" for any) → the exception to raise. This is
        #: how the partial-failure tests make Firestore fail on cue, which is
        #: the one behaviour that cannot be provoked any other way.
        self.failures: dict[tuple[str, str], Exception] = {}
        #: (parent document id, subcollection name) → its own collection.
        self.subcollections: dict[tuple[str, str], "FakeFsCollection"] = {}

    def subcollection(self, doc_id: str, name: str) -> "FakeFsCollection":
        key = (doc_id, name)
        if key not in self.subcollections:
            self.subcollections[key] = FakeFsCollection(f"{self.name}/{doc_id}/{name}")
        return self.subcollections[key]

    def fail_on(self, operation: str, doc_id: str = "", exc: Exception | None = None):
        self.failures[(operation, doc_id)] = exc or RuntimeError(
            "503 Firestore is unavailable"
        )

    def clear_failures(self) -> None:
        self.failures.clear()

    def fail_if_asked(self, operation: str, doc_id: str) -> None:
        for key in ((operation, doc_id), (operation, "")):
            exc = self.failures.get(key)
            if exc is not None:
                raise exc

    def document(self, doc_id: str) -> FakeDocument:
        return FakeDocument(self, doc_id)

    def where(self, filter: Any = None, **kw) -> FakeQuery:  # noqa: A002
        return FakeQuery(self, list(self.docs.items())).where(filter, **kw)

    def order_by(self, field: str, direction: Any = "ASCENDING") -> FakeQuery:
        return FakeQuery(self, list(self.docs.items())).order_by(field, direction)

    def select(self, fields: Any) -> FakeQuery:
        return FakeQuery(self, list(self.docs.items())).select(fields)

    def limit(self, n: int) -> FakeQuery:
        return FakeQuery(self, list(self.docs.items())).limit(n)

    def stream(self):
        return FakeQuery(self, list(self.docs.items())).stream()


class FakeWriteBatch:
    """A Firestore batch: queued writes that all land, or none do.

    Atomicity is the property under test, not an incidental detail. `grant_host`
    puts the user document and the host's verification record in one batch
    precisely so a failure cannot leave `isHost: true` behind with no way to
    verify it — a host who looks healthy on every CRM screen and can never be
    paid. A fake that applied each write as it was queued would make that test
    pass whether the real code batched or not.

    `fail_on_commit` lets a test prove the other half: nothing at all is written.
    """

    def __init__(self, store: "FakeFirestore") -> None:
        self._store = store
        self._queued: list[tuple] = []
        self.fail_on_commit = False

    def set(self, ref, data, merge: bool = False):
        self._queued.append(("set", ref, data, merge))
        return self

    def update(self, ref, data):
        self._queued.append(("update", ref, data, False))
        return self

    def delete(self, ref):
        self._queued.append(("delete", ref, None, False))
        return self

    def commit(self):
        if self.fail_on_commit:
            raise RuntimeError("batch commit failed")
        for kind, ref, data, merge in self._queued:
            if kind == "set":
                ref.set(data, merge=merge) if merge else ref.set(data)
            elif kind == "update":
                ref.update(data)
            else:
                ref.delete()
        self._queued.clear()
        return []


class FakeFirestore:
    def __init__(self) -> None:
        self.collections: dict[str, FakeFsCollection] = {}
        #: Handed out by `batch()`. A test can set `fail_on_commit` on it to
        #: prove that a failed batch writes nothing.
        self.last_batch: FakeWriteBatch | None = None

    def collection(self, name: str) -> FakeFsCollection:
        if name not in self.collections:
            self.collections[name] = FakeFsCollection(name)
        return self.collections[name]

    def batch(self) -> FakeWriteBatch:
        self.last_batch = FakeWriteBatch(self)
        return self.last_batch
