"""Stand-ins that let the real Part 8A code run with no database and no network.

The same approach `tests/fakes.py` takes for partner creation, extended to what
the reporting, alerting and email path actually touches. **Everything under
`app/` in the tests that use this is the real, unmodified code** — the delivery
recorder, the suppression state, the detectors, the templates. What is replaced
is the I/O underneath them:

  * `install_stubs()` puts minimal fakes for pydantic, pymongo, motor, bson,
    firebase, jose and FastAPI into `sys.modules` **before** any app module is
    imported. `app/config.py` is left real, so every test runs against the
    thresholds the deployment actually ships with.
  * `FakeDb` is a small Mongo. It is not a toy: it enforces unique indexes on
    insert, understands the query and update operators this code depends on,
    and supports the `$or` + `upsert` pattern the alert suppression rests on.
    A fake that let a duplicate through, or that ignored the `$or`, would make
    the deduplication tests pass for the wrong reason.
  * `FakeSendGrid` is the provider. It records what it was given and returns
    whatever status the test asks for, so a 403 from an unverified `MAIL_FROM`
    goes through the *real* `_send_via_provider` and produces the real error
    text rather than a message the test wrote itself.
"""

from __future__ import annotations

import re
import sys
import types
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping


# ══════════════════════════════════════════════════════════════════════════════
#  Module stubs
# ══════════════════════════════════════════════════════════════════════════════


def _module(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, mod)
    return mod


class DuplicateKeyError(Exception):
    """`pymongo.errors.DuplicateKeyError`. Caught by name in the real code, so
    it has to be the same class object the real code imported."""


class PyMongoError(Exception):
    pass


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: Any = None, **_k):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _Status:
    HTTP_200_OK = 200
    HTTP_201_CREATED = 201
    HTTP_400_BAD_REQUEST = 400
    HTTP_401_UNAUTHORIZED = 401
    HTTP_403_FORBIDDEN = 403
    HTTP_404_NOT_FOUND = 404
    HTTP_409_CONFLICT = 409
    #: A scheduled job that raised. The router turns it into this after writing
    #: the failed run to the log, so the failure path is exercisable here.
    HTTP_500_INTERNAL_SERVER_ERROR = 500
    HTTP_503_SERVICE_UNAVAILABLE = 503


class Depends:
    def __init__(self, dependency=None):
        self.dependency = dependency


class Request:
    """`fastapi.Request`, reduced to the two things `app/core/deps.py` reads.

    `scope["route"]` is where Starlette puts the matched route before any
    dependency runs, and `route.path` is the **templated** path — the same
    string that appears in `PARTNER_REACHABLE`, whatever ids the caller put in
    the URL. Both are read and neither is written, so a stand-in that carries a
    method and an object with a `.path` exercises the real predicate.
    """

    def __init__(self, method: str = "GET", path: str = ""):
        self.method = method.upper()
        self.scope: dict[str, Any] = {}
        if path:
            self.scope["route"] = types.SimpleNamespace(path=path)


def _passthrough(default=None, **_k):
    return default


class _APIRouter:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.routes: list[dict] = []

    def _register(self, method):
        def decorator(path, **kwargs):
            def wrap(fn):
                self.routes.append({"method": method, "path": path, "fn": fn})
                return fn

            return wrap

        return decorator

    def __getattr__(self, name):
        if name in {"get", "post", "put", "patch", "delete"}:
            return self._register(name)
        raise AttributeError(name)


class _BaseModel:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


class _PydanticBaseSettings:
    """`pydantic_settings.BaseSettings` without pydantic.

    `app/config.py` declares annotated class attributes with defaults, which are
    ordinary class attributes — so plain lookup gives every setting its real
    shipped default. That is deliberate: the alert tests assert against the
    thresholds the deployment ships with, not against numbers invented here.
    """

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)


class ObjectId:
    def __init__(self, value: Any = None):
        text = str(value or "")
        if len(text) != 24:
            raise ValueError(f"{value!r} is not a valid ObjectId")
        self._value = text

    def __str__(self) -> str:
        return self._value

    def __eq__(self, other: object) -> bool:
        return str(other) == self._value

    def __hash__(self) -> int:
        return hash(self._value)


class _ReturnDocument:
    BEFORE = False
    AFTER = True


#: What the fake Firebase Auth was asked to do, so a test can assert it was
#: asked at all. Cleared by `reset_auth_calls()` between cases.
#:
#: Module-level rather than per-test state because the stub functions are
#: installed once into `sys.modules` and shared by every test in the process.
AUTH_CALLS: dict[str, list] = {"disabled": [], "revoked": []}


def reset_auth_calls() -> None:
    AUTH_CALLS["disabled"].clear()
    AUTH_CALLS["revoked"].clear()


def install_stubs() -> None:
    """Install everything. Must run before any `app.*` import."""
    _module(
        "pydantic_settings",
        BaseSettings=_PydanticBaseSettings,
        SettingsConfigDict=lambda **kw: dict(**kw),
    )
    _module("pydantic", BaseModel=_BaseModel, Field=_passthrough)
    _module("bson", ObjectId=ObjectId)

    pymongo = _module(
        "pymongo", ASCENDING=1, DESCENDING=-1, ReturnDocument=_ReturnDocument
    )
    pymongo.MongoClient = object
    _module(
        "pymongo.errors",
        DuplicateKeyError=DuplicateKeyError,
        PyMongoError=PyMongoError,
    )

    _module("motor")
    _module(
        "motor.motor_asyncio",
        AsyncIOMotorClient=object,
        AsyncIOMotorDatabase=object,
        AsyncIOMotorClientSession=object,
    )

    firebase_admin = _module(
        "firebase_admin", App=object, initialize_app=lambda *a, **k: object()
    )
    _module(
        "firebase_admin.auth",
        UserNotFoundError=type("UserNotFoundError", (Exception,), {}),
        verify_id_token=lambda *a, **k: {},
        get_user_by_email=lambda *a, **k: None,
        # `_staff_for_authenticated_uid` asks this whether a uid recorded on a
        # staff row still names a LIVE auth account — which is how it tells two
        # real identities for one person (refuse) from an unreachable row
        # (repair). None is the safe default: no account. A test that needs the
        # other answer overrides it, as `test_partner_session` does.
        get_user=lambda *a, **k: None,
        create_user=lambda *a, **k: None,
        generate_password_reset_link=lambda *a, **k: "",
        # ── Revocation ───────────────────────────────────────────────────────
        #
        # Recorded rather than ignored, because the thing worth asserting about
        # a revocation is that it HAPPENED. Deactivating staff used to flip two
        # application flags and leave the Firebase credential working for ever;
        # `firebase.set_user_disabled` is what closes that, and a stub that
        # silently swallowed the call would let the hole reopen with every test
        # still green.
        #
        # `disabled_calls` and `revoked_uids` are read by
        # `tests/test_staff_directory.py`. A test that wants the failure path
        # overrides these with something that raises.
        update_user=lambda uid, **k: AUTH_CALLS["disabled"].append((uid, k)),
        revoke_refresh_tokens=lambda uid: AUTH_CALLS["revoked"].append(uid),
    )
    _module(
        "firebase_admin.credentials",
        Certificate=lambda *a, **k: object(),
        ApplicationDefault=lambda *a, **k: object(),
    )
    # The three write sentinels the Admin SDK exports through
    # `from google.cloud.firestore import *`, and which `app/services/users.py`
    # reaches for as `fb_firestore.DELETE_FIELD` / `.ArrayUnion` / `.ArrayRemove`.
    #
    # They are the real classes from `tests/fakes.py` rather than throwaway
    # objects, because the fake Firestore has to *apply* them: a moderation
    # write that deletes `suspendedUntil` and array-removes a uid from
    # `sourceAccounts` is only actually tested if the document afterwards looks
    # the way Firestore would have left it. A stub that swallowed them would
    # make every device-ban test pass without proving anything.
    from tests.fakes import ArrayRemove, ArrayUnion, DeleteField

    _module(
        "firebase_admin.firestore",
        client=lambda *a, **k: None,
        DELETE_FIELD=DeleteField(),
        ArrayUnion=ArrayUnion,
        ArrayRemove=ArrayRemove,
        SERVER_TIMESTAMP=object(),
    )

    google = sys.modules.get("google") or _module("google")
    cloud = _module("google.cloud")
    firestore_v1 = _module("google.cloud.firestore_v1", GeoPoint=object)
    # `BaseQuery` is imported for a type annotation by `app/services/users.py`,
    # which `app/routers/users.py` pulls in — so it has to exist by name. It
    # also carries the two sort directions `list_warnings` and
    # `list_banned_devices` order by, which are plain constants on the real
    # class; `FieldFilter` is the real little value object from `tests/fakes.py`
    # so a fake collection can read what a filter actually asked for rather
    # than ignoring it.
    from tests.fakes import FieldFilter as _FieldFilter

    _module(
        "google.cloud.firestore_v1.base_query",
        BaseQuery=types.SimpleNamespace(ASCENDING="ASCENDING", DESCENDING="DESCENDING"),
        FieldFilter=_FieldFilter,
    )
    firestore_v1.base_query = sys.modules["google.cloud.firestore_v1.base_query"]
    cloud.firestore_v1 = firestore_v1
    google.cloud = cloud

    _module(
        "jose",
        JWTError=type("JWTError", (Exception,), {}),
        jwt=types.SimpleNamespace(
            encode=lambda *a, **k: "token", decode=lambda *a, **k: {}
        ),
    )

    _module(
        "fastapi",
        APIRouter=_APIRouter,
        Body=_passthrough,
        Depends=Depends,
        Header=_passthrough,
        HTTPException=HTTPException,
        Query=_passthrough,
        Request=Request,
        status=_Status,
    )
    _module(
        "fastapi.responses",
        StreamingResponse=lambda *a, **k: None,
    )
    _module(
        "fastapi.middleware.cors", CORSMiddleware=object
    )


# ══════════════════════════════════════════════════════════════════════════════
#  A small Mongo
# ══════════════════════════════════════════════════════════════════════════════


def _copy(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_copy(v) for v in value]
    return value


def _dig(doc: Any, path: str) -> Any:
    for part in str(path).split("."):
        if isinstance(doc, Mapping):
            doc = doc.get(part)
        else:
            return None
    return doc


def _set_path(doc: dict, path: str, value: Any) -> None:
    parts = str(path).split(".")
    target = doc
    for part in parts[:-1]:
        nxt = target.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            target[part] = nxt
        target = nxt
    target[parts[-1]] = value


def _cmp_ok(actual: Any, want: Any) -> bool:
    """One field against one condition. Only the operators this code uses."""
    if isinstance(want, Mapping) and any(str(k).startswith("$") for k in want):
        for op, operand in want.items():
            if op == "$in":
                if actual not in operand:
                    return False
            elif op == "$nin":
                if actual in operand:
                    return False
            elif op == "$ne":
                if actual == operand:
                    return False
            elif op == "$gt":
                if actual is None or not actual > operand:
                    return False
            elif op == "$gte":
                if actual is None or not actual >= operand:
                    return False
            elif op == "$lt":
                if actual is None or not actual < operand:
                    return False
            elif op == "$lte":
                if actual is None or not actual <= operand:
                    return False
            elif op == "$exists":
                if (actual is not None) != bool(operand):
                    return False
            elif op == "$regex":
                if actual is None or re.search(str(operand), str(actual)) is None:
                    return False
            else:  # pragma: no cover
                raise NotImplementedError(f"FakeDb does not implement {op}")
        return True
    return actual == want


def _matches(doc: Mapping, query: Mapping) -> bool:
    for key, want in query.items():
        if key == "$or":
            if not any(_matches(doc, clause) for clause in want):
                return False
            continue
        if key == "$and":
            if not all(_matches(doc, clause) for clause in want):
                return False
            continue
        if not _cmp_ok(_dig(doc, key), want):
            return False
    return True


def _sorted(docs: list[dict], spec) -> list[dict]:
    if not spec:
        return docs
    if isinstance(spec, str):
        spec = [(spec, 1)]
    for key, direction in reversed(list(spec)):
        docs = sorted(
            docs,
            key=lambda d, k=key: (_dig(d, k) is None, _sort_key(_dig(d, k))),
            reverse=direction < 0,
        )
    return docs


def _sort_key(value: Any) -> Any:
    if value is None:
        return 0
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, (int, float)):
        return value
    return str(value)


class FakeCursor:
    def __init__(self, docs: list[dict]):
        self._docs = docs

    def sort(self, key, direction=1):
        self._docs = _sorted(self._docs, key if isinstance(key, list) else [(key, direction)])
        return self

    def skip(self, n):
        self._docs = self._docs[n:]
        return self

    def limit(self, n):
        if n:
            self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        async def gen():
            for doc in self._docs:
                yield _copy(doc)

        return gen()


class FakeCollection:
    def __init__(self, name: str, unique: tuple[str, ...] = ()):
        self.name = name
        self.docs: list[dict] = []
        self.unique = unique
        self._seq = 0
        #: Set to an exception to make every write fail — used to prove that a
        #: send with no delivery record is refused rather than sent.
        self.fail_writes: Exception | None = None

    # ── writes ────────────────────────────────────────────────────────────
    def _next_id(self) -> str:
        self._seq += 1
        return f"{self.name}-{self._seq:016d}"

    def _check_unique(self, doc: Mapping, exclude: Any = None) -> None:
        for field in self.unique:
            value = _dig(doc, field)
            if value is None:
                continue
            for other in self.docs:
                if other is exclude or other.get("_id") == exclude:
                    continue
                if _dig(other, field) == value:
                    raise DuplicateKeyError(
                        f"E11000 duplicate key on {field}: {value!r}"
                    )

    async def insert_one(self, doc: dict, session=None):
        if self.fail_writes:
            raise self.fail_writes
        doc = _copy(doc)
        doc.setdefault("_id", self._next_id())
        if any(d.get("_id") == doc["_id"] for d in self.docs):
            raise DuplicateKeyError(f"E11000 duplicate key on _id: {doc['_id']!r}")
        self._check_unique(doc)
        self.docs.append(doc)
        return types.SimpleNamespace(inserted_id=doc["_id"])

    def _apply(self, doc: dict, update: Mapping) -> None:
        for path, value in (update.get("$set") or {}).items():
            _set_path(doc, path, _copy(value))
        for path, value in (update.get("$inc") or {}).items():
            current = _dig(doc, path) or 0
            _set_path(doc, path, int(current) + int(value))
        for path, value in (update.get("$push") or {}).items():
            existing = _dig(doc, path)
            if not isinstance(existing, list):
                existing = []
            existing.append(_copy(value))
            _set_path(doc, path, existing)

    async def update_one(self, query: Mapping, update: Mapping, upsert: bool = False,
                         session=None):
        if self.fail_writes:
            raise self.fail_writes
        for doc in self.docs:
            if _matches(doc, query):
                self._apply(doc, update)
                return types.SimpleNamespace(
                    matched_count=1, modified_count=1, upserted_id=None
                )

        if not upsert:
            return types.SimpleNamespace(
                matched_count=0, modified_count=0, upserted_id=None
            )

        # Mongo builds the new document from the query's top-level equalities
        # plus $setOnInsert and $set. `$or` contributes nothing, which is
        # precisely what makes the claim-or-collide pattern work.
        doc: dict = {}
        for key, want in query.items():
            if key.startswith("$"):
                continue
            if not (isinstance(want, Mapping) and any(str(k).startswith("$") for k in want)):
                _set_path(doc, key, _copy(want))
        for path, value in (update.get("$setOnInsert") or {}).items():
            _set_path(doc, path, _copy(value))
        self._apply(doc, update)
        doc.setdefault("_id", self._next_id())
        self._check_unique(doc)
        self.docs.append(doc)
        return types.SimpleNamespace(
            matched_count=0, modified_count=0, upserted_id=doc["_id"]
        )

    async def update_many(self, query: Mapping, update: Mapping, session=None):
        n = 0
        for doc in self.docs:
            if _matches(doc, query):
                self._apply(doc, update)
                n += 1
        return types.SimpleNamespace(matched_count=n, modified_count=n)

    async def find_one_and_update(self, query, update, return_document=True, session=None):
        for doc in self.docs:
            if _matches(doc, query):
                before = _copy(doc)
                self._apply(doc, update)
                return _copy(doc) if return_document else before
        return None

    async def delete_one(self, query: Mapping, session=None):
        for i, doc in enumerate(self.docs):
            if _matches(doc, query):
                self.docs.pop(i)
                return types.SimpleNamespace(deleted_count=1)
        return types.SimpleNamespace(deleted_count=0)

    async def delete_many(self, query: Mapping, session=None):
        keep = [d for d in self.docs if not _matches(d, query)]
        removed = len(self.docs) - len(keep)
        self.docs = keep
        return types.SimpleNamespace(deleted_count=removed)

    # ── reads ─────────────────────────────────────────────────────────────
    def find(self, query: Mapping | None = None, *_a, **_k) -> FakeCursor:
        return FakeCursor([_copy(d) for d in self.docs if _matches(d, query or {})])

    async def find_one(self, query: Mapping | None = None, sort=None, session=None):
        found = [_copy(d) for d in self.docs if _matches(d, query or {})]
        found = _sorted(found, sort)
        return found[0] if found else None

    async def count_documents(self, query: Mapping | None = None, session=None) -> int:
        return sum(1 for d in self.docs if _matches(d, query or {}))

    def aggregate(self, pipeline: list[Mapping], *_a, **_k) -> FakeCursor:
        docs = [_copy(d) for d in self.docs]
        for stage in pipeline:
            (op, spec), = stage.items()
            if op == "$match":
                docs = [d for d in docs if _matches(d, spec)]
            elif op == "$sort":
                docs = _sorted(docs, list(spec.items()))
            elif op == "$limit":
                docs = docs[: int(spec)]
            elif op == "$skip":
                docs = docs[int(spec):]
            elif op == "$group":
                docs = _group(docs, spec)
            elif op == "$project":
                docs = [{k: _dig(d, k) for k in spec} for d in docs]
            else:  # pragma: no cover
                raise NotImplementedError(f"FakeDb does not implement {op}")
        return FakeCursor(docs)

    async def create_index(self, *_a, **_k):
        return "ok"


def _field(doc: Mapping, expr: Any) -> Any:
    if isinstance(expr, str) and expr.startswith("$"):
        return _dig(doc, expr[1:])
    if isinstance(expr, Mapping):
        return {k: _field(doc, v) for k, v in expr.items()}
    return expr


def _group(docs: list[dict], spec: Mapping) -> list[dict]:
    id_expr = spec.get("_id")
    buckets: dict[Any, list[dict]] = {}
    order: list[Any] = []
    for doc in docs:
        key = _field(doc, id_expr)
        hashable = _hashable(key)
        if hashable not in buckets:
            buckets[hashable] = []
            order.append((hashable, key))
        buckets[hashable].append(doc)

    out = []
    for hashable, key in order:
        rows = buckets[hashable]
        entry: dict = {"_id": key}
        for field, accumulator in spec.items():
            if field == "_id":
                continue
            (acc_op, acc_expr), = accumulator.items()
            values = [_field(r, acc_expr) for r in rows]
            if acc_op == "$sum":
                if acc_expr == 1:
                    entry[field] = len(rows)
                else:
                    entry[field] = sum(v or 0 for v in values)
            elif acc_op == "$max":
                real = [v for v in values if v is not None]
                entry[field] = max(real, key=_sort_key) if real else None
            elif acc_op == "$min":
                real = [v for v in values if v is not None]
                entry[field] = min(real, key=_sort_key) if real else None
            elif acc_op == "$push":
                entry[field] = values
            elif acc_op == "$addToSet":
                seen, uniq = set(), []
                for v in values:
                    h = _hashable(v)
                    if h not in seen:
                        seen.add(h)
                        uniq.append(v)
                entry[field] = uniq
            elif acc_op == "$first":
                entry[field] = values[0] if values else None
            else:  # pragma: no cover
                raise NotImplementedError(f"FakeDb does not implement {acc_op}")
        out.append(entry)
    return out


def _hashable(value: Any) -> Any:
    if isinstance(value, dict):
        return tuple(sorted((k, _hashable(v)) for k, v in value.items()))
    if isinstance(value, list):
        return tuple(_hashable(v) for v in value)
    return value


class FakeDb:
    """Collections, with the unique indexes `app/db/mongo.py` declares.

    The indexes are the point. `email_deliveries.dedupe_key` and
    `alert_state.key` are what make an email send once and an alert fire once,
    and a fake without them would test nothing.
    """

    UNIQUE = {
        "email_deliveries": ("dedupe_key",),
        "alert_state": ("key",),
        "staff": ("email",),
        "ledger": ("idempotency_key",),
    }

    def __init__(self) -> None:
        self.collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name: str) -> FakeCollection:
        if name not in self.collections:
            self.collections[name] = FakeCollection(name, self.UNIQUE.get(name, ()))
        return self.collections[name]

    def seed(self, name: str, docs: Iterable[Mapping]) -> None:
        collection = self[name]
        for doc in docs:
            collection.docs.append(_copy(dict(doc)))


# ══════════════════════════════════════════════════════════════════════════════
#  The provider
# ══════════════════════════════════════════════════════════════════════════════


class _Response:
    def __init__(self, status_code: int, body: bytes = b"", message_id: str = ""):
        self.status_code = status_code
        self.body = body
        self.headers = {"X-Message-Id": message_id} if message_id else {}


class HTTPError(Exception):
    """`python_http_client.exceptions.HTTPError`, faithfully.

    Faithfully in the one way that matters: **`str()` on it is the constant
    "HTTP Error N: Reason" and every word of the provider's explanation is on
    `.body`, where nothing was reading it.** That is the whole shape of the bug
    the delivery tests exist to hold shut, so the stub has to have it.
    """

    def __init__(self, status_code, reason, body=b"", headers=None):
        self.status_code = status_code
        self.reason = reason
        self.body = body
        self.headers = headers or {}
        super().__init__(f"HTTP Error {status_code}: {reason}")

    def __str__(self) -> str:  # noqa: D105 — deliberately says nothing useful
        return f"HTTP Error {self.status_code}: {self.reason}"


class BadRequestsError(HTTPError):
    """What SendGrid's SDK raises on a 400. The class the live log named."""


_REASONS = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
}


class FakeSendGrid:
    """A `sendgrid` module good enough for the real `_send_via_provider`.

    The real function is exercised: it builds the Mail object, adds the plain
    text alternative, the headers and the attachments, calls `send`, and reads
    whatever comes back. The test only decides what the API answers.

    **A non-2xx raises**, exactly as `python_http_client` does — returning a
    response object for a 400 would let the code under test pass through a path
    the live system never takes.
    """

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.next_status = 202
        self.next_body = b""
        self.next_message_id = "msg-0001"
        self.next_headers: dict | None = None
        self.raise_on_send: Exception | None = None
        #: Set False to answer a non-2xx with a response object instead of an
        #: exception — the path a stub or a future SDK would take.
        self.raise_on_error_status = True

    def install(self) -> None:
        # Lift any import block left by `uninstall_sendgrid()` first, or the
        # stub goes into a `sys.modules` that the meta-path finder still
        # refuses, and every send after the 'SDK not installed' test would
        # keep reporting a missing SDK.
        reinstall_sendgrid()
        outer = self

        class SendGridAPIClient:
            def __init__(self, api_key=None):
                # The key reaches the client and stops there. It is never
                # stored on a sent record, and the test asserts that.
                self.api_key = api_key
                self.client = types.SimpleNamespace(timeout=None)

            def send(self, message):
                if outer.raise_on_send:
                    raise outer.raise_on_send
                outer.sent.append(
                    {
                        "to": message.to_email,
                        "subject": message.subject,
                        "html": message.html_content,
                        "text": message.plain_text_content,
                        "from": message.from_email,
                        "reply_to": message.reply_to,
                        "headers": dict(message.headers),
                        "attachments": list(message.attachments),
                    }
                )
                status = int(outer.next_status)
                if status >= 300 and outer.raise_on_error_status:
                    error = BadRequestsError if status == 400 else HTTPError
                    headers = outer.next_headers
                    if headers is None:
                        headers = (
                            {"X-Message-Id": outer.next_message_id}
                            if outer.next_message_id
                            else {}
                        )
                    raise error(
                        status, _REASONS.get(status, "Error"), outer.next_body, headers
                    )
                return _Response(status, outer.next_body, outer.next_message_id)

        _module("sendgrid", SendGridAPIClient=SendGridAPIClient)
        _module(
            "sendgrid.helpers",
        )
        _module(
            "sendgrid.helpers.mail",
            Mail=_Mail,
            Content=lambda _type, value: value,
            Email=lambda address, name=None: address,
            To=lambda address, name=None: address,
            Attachment=lambda *a, **k: {"parts": a},
            FileContent=lambda v: v,
            FileName=lambda v: v,
            FileType=lambda v: v,
            Disposition=lambda v: v,
            Header=lambda key, value: (key, value),
        )


class _Mail:
    def __init__(self, from_email=None, to_emails=None, subject=None,
                 plain_text_content=None, html_content=None):
        self.from_email = from_email
        self.to_email = to_emails
        self.subject = subject
        self.plain_text_content = plain_text_content
        self.html_content = html_content
        self.reply_to = None
        self.attachments: list[Any] = []
        self.headers: dict[str, str] = {}

    def add_attachment(self, attachment):
        self.attachments.append(attachment)

    def add_header(self, header):
        key, value = header
        self.headers[str(key)] = str(value)


_SENDGRID_MODULES = ("sendgrid", "sendgrid.helpers", "sendgrid.helpers.mail")


class _BlockedImport:
    """A meta-path finder that refuses to find the named modules.

    Dropping a name from `sys.modules` does not make it unimportable — it only
    clears the cache, so the next `import` goes back to disk and succeeds if the
    package is actually installed. This finder sits at the front of
    `sys.meta_path` and raises `ImportError` before any real one is consulted,
    which is the only way to simulate absence on a machine that has the package.
    """

    def __init__(self, names: tuple[str, ...]) -> None:
        self.names = set(names)

    def find_module(self, fullname: str, path: Any = None) -> Any:  # legacy API
        return self.find_spec(fullname, path)

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname in self.names or fullname.split(".")[0] in self.names:
            raise ImportError(f"No module named {fullname!r}")
        return None


_sendgrid_blocker: _BlockedImport | None = None


def uninstall_sendgrid() -> None:
    """Remove the provider SDK entirely — the 'not installed' path.

    Clearing `sys.modules` alone was not enough, and the way it failed was
    exactly backwards: the test passed on machines *without* the SendGrid SDK
    and failed on machines with it. So it was green in a bare sandbox and red on
    a properly provisioned dev machine — and red in the deploy preflight, which
    blocked a release over a healthy backend.

    `email.py` reaches the 'SDK not installed' branch through
    `from sendgrid import SendGridAPIClient` raising `ImportError`. Popping the
    module only empties the cache; with sendgrid genuinely installed the import
    resolves from site-packages, no `ImportError` is raised, the real client is
    constructed, and the assertion that the failure names the missing library
    fails. Blocking at `sys.meta_path` makes the absence real either way.

    Paired with `PROVIDER.install()`, which calls `reinstall_sendgrid()`.
    """
    global _sendgrid_blocker
    for name in _SENDGRID_MODULES:
        sys.modules.pop(name, None)
    if _sendgrid_blocker is None:
        _sendgrid_blocker = _BlockedImport(_SENDGRID_MODULES)
        sys.meta_path.insert(0, _sendgrid_blocker)


def reinstall_sendgrid() -> None:
    """Undo `uninstall_sendgrid()` so the stub can be installed again."""
    global _sendgrid_blocker
    if _sendgrid_blocker is not None:
        try:
            sys.meta_path.remove(_sendgrid_blocker)
        except ValueError:
            pass
        _sendgrid_blocker = None


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)
