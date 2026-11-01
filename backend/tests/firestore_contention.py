"""HT-1 test support — Firestore transactions with the library's OWN retry loop.

NOT a test (no `test_` prefix, so the runner does not execute it on its own);
imported by `test_host_move_contention` and `test_appeal_claim_contention`
AFTER `tests.harness.install_stubs()`.

  * The retry loop is REAL: `_BaseTransactional`, `_Transactional` and
    `transactional` are read out of the INSTALLED google-cloud-firestore
    (backend/.venv) by `ast` and executed as written, and installed as
    `firebase_admin.firestore.transactional` — so the attempt count, the
    immediate retry, the rollback and the exhaustion error are the library's
    own. `VERSION` and `PIN` let a test check it is the version requirements.txt
    pins.
  * The server underneath is FAKE (`Server`): versioned documents,
    transactional reads recorded, writes buffered and applied atomically at
    commit, and a commit refused with ABORTED when anything it read has changed
    since. Hooks script the rest deterministically: ABORTED on chosen commit or
    read attempts (lock contention with no data change), a competitor's whole
    operation run between an attempt's reads and its commit, a failing plain
    read. Each transaction is labelled with the caller (`acting`), through a
    ContextVar so the label survives `asyncio.to_thread`.
  * `Aborted` stands in for `google.api_core.exceptions.Aborted` and is
    installed THERE, so the server that raises it, the library loop that
    catches it and `app.db.firebase.is_transaction_contention` that recognises
    it all meet the same class, as they do in production.
"""

from __future__ import annotations

import ast
import contextvars
import copy
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]

if "firebase_admin.firestore" not in sys.modules or "google.api_core.exceptions" not in sys.modules:
    raise RuntimeError("tests.firestore_contention needs tests.harness.install_stubs() to have run first")


def _site_packages() -> Path | None:
    candidates = [Path(p) for p in sys.path if p]
    candidates += sorted((ROOT / ".venv" / "lib").glob("python3*/site-packages"))
    for base in candidates:
        if (base / "google" / "cloud" / "firestore_v1" / "transaction.py").is_file():
            return base
    return None


SITE = _site_packages()
if SITE is None:
    print("HT-1: google-cloud-firestore is not installed in backend/.venv. This test executes the "
          "library's own transaction retry loop and cannot run without it.")
    sys.exit(1)

_pin = re.search(r"^google-cloud-firestore==(\S+)", (ROOT / "requirements.txt").read_text(encoding="utf-8"), re.M)
PIN = _pin.group(1) if _pin else None
VERSION = None
for _dist in sorted(SITE.glob("google_cloud_firestore-*.dist-info")):
    _m = re.search(r"^Version: (\S+)", (_dist / "METADATA").read_text(encoding="utf-8"), re.M)
    VERSION = _m.group(1) if _m else VERSION


def _library(path: Path, *names: str) -> str:
    """The exact source of the named top-level definitions/constants in `path`."""
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    found: dict[str, str] = {}
    for node in ast.parse(src).body:
        name = None
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        if name in names:
            start = min([d.lineno for d in getattr(node, "decorator_list", [])] + [node.lineno])
            found[name] = "\n".join(lines[start - 1:node.end_lineno])
    missing = [n for n in names if n not in found]
    if missing:
        print(f"HT-1: {path.name} of google-cloud-firestore {VERSION} no longer defines {missing} — update this test")
        sys.exit(1)
    return "\n\n".join(found[n] for n in names)


# ── The app under the usual stubs ────────────────────────────────────────────


class GoogleAPIError(Exception):
    """Stand-in for `google.api_core.exceptions.GoogleAPIError`, the base of every
    error the Google client raises — what `firebase.transaction_error_kind` sorts
    as "uncertain" unless it is contention."""


class Aborted(GoogleAPIError):
    """Stand-in for `google.api_core.exceptions.Aborted` (gRPC ABORTED → HTTP 409).

    ONE class object, met by the same three parties as in production: the
    server raises it, the library's retry loop catches it (`exceptions.Aborted`)
    and `firebase.is_transaction_contention` recognises it — all of them through
    `google.api_core.exceptions`.
    """


class ServiceUnavailable(GoogleAPIError):
    """A 503 — NOT contention: the outcome of a commit that fails this way is unknown."""


class DeadlineExceeded(GoogleAPIError):
    """A 504 — NOT contention: a commit can still land after the client gave up."""


class NotFound(GoogleAPIError):
    """404 from a commit that updates a missing document."""


class DeferCommit(Exception):
    """Raised by an `on_commit` hook: keep this attempt's writes for a LATE landing
    (`Server.land_deferred`) and fail the commit with `error` — a commit the server
    may still apply after the client stopped waiting."""

    def __init__(self, error: BaseException):
        super().__init__(str(error))
        self.error = error


API_EXCEPTIONS = sys.modules["google.api_core.exceptions"]
API_EXCEPTIONS.GoogleAPIError = GoogleAPIError
API_EXCEPTIONS.Aborted = Aborted
API_EXCEPTIONS.ServiceUnavailable = ServiceUnavailable
API_EXCEPTIONS.DeadlineExceeded = DeadlineExceeded
API_EXCEPTIONS.NotFound = NotFound

_FS_LIB = SITE / "google" / "cloud" / "firestore_v1"
LIB: dict[str, Any] = {"__name__": "google_cloud_firestore_transaction_loop", "exceptions": API_EXCEPTIONS}
exec(compile("\n\n".join([  # noqa: S102 — the installed library's own source
    "from __future__ import annotations",
    "from typing import Any, Callable, Optional",
    _library(_FS_LIB / "base_transaction.py", "MAX_ATTEMPTS", "_CANT_BEGIN", "_MISSING_ID_TEMPLATE",
             "_CANT_ROLLBACK", "_CANT_COMMIT", "_EXCEED_ATTEMPTS_TEMPLATE", "_BaseTransactional"),
    _library(_FS_LIB / "transaction.py", "_Transactional", "transactional"),
]), f"google-cloud-firestore-{VERSION}:transaction-loop", "exec"), LIB)
sys.modules["firebase_admin.firestore"].transactional = LIB["transactional"]
MAX_ATTEMPTS = LIB["MAX_ATTEMPTS"]
EXHAUSTED = LIB["_EXCEED_ATTEMPTS_TEMPLATE"].format(MAX_ATTEMPTS)


# ══════════════════════════════════════════════════════════════════════════════
#  The Firestore server underneath — versioned documents, atomic commits
# ══════════════════════════════════════════════════════════════════════════════

#: Which caller a transaction belongs to. A ContextVar, because `_move_host`
#: runs in `asyncio.to_thread`, which carries the context into the worker.
ACTOR: contextvars.ContextVar[str] = contextvars.ContextVar("actor", default="-")


def acting(label: str, fn: Callable, *args, **kwargs):
    token = ACTOR.set(label)
    try:
        return fn(*args, **kwargs)
    finally:
        ACTOR.reset(token)


def _set_path(doc: dict, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    for part in parts[:-1]:
        doc = doc.setdefault(part, {})
    doc[parts[-1]] = copy.deepcopy(value)


def _merge(doc: dict, data: dict) -> None:
    for key, value in data.items():
        if isinstance(value, dict) and isinstance(doc.get(key), dict):
            _merge(doc[key], value)
        else:
            doc[key] = copy.deepcopy(value)


class Server:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.docs: dict[str, dict] = {}
        self.versions: dict[str, int] = {}
        self.tick = 0
        self.events: list[tuple] = []
        #: label → fn(tx) run at the start of each commit attempt / before each
        #: transactional read / before each plain read. May raise.
        self.on_commit: dict[str, Callable] = {}
        self.on_read: dict[str, Callable] = {}
        self.on_plain_read: dict[str, Callable] = {}
        #: label → fn(tx) run AFTER a commit attempt's writes were applied; it may
        #: raise — the commit landed and its answer is lost.
        self.after_commit: dict[str, Callable] = {}
        #: commits a hook deferred (`DeferCommit`): (label, writes, reads) that
        #: `land_deferred` applies later, if what they read is unchanged.
        self.deferred: list[tuple] = []
        self.yield_between = False

    def record(self, *event) -> None:
        with self.lock:
            self.events.append(event)

    def apply(self, writes: list[tuple]) -> None:
        """All of `writes` or none of them."""
        with self.lock:
            staged: dict[str, dict | None] = {}

            def current(path: str) -> dict | None:
                return staged[path] if path in staged else self.docs.get(path)

            for op, path, data, merge in writes:
                if op == "update":
                    base = current(path)
                    if base is None:
                        raise NotFound(f"404 No document to update: {path}")
                    new = copy.deepcopy(base)
                    for key, value in data.items():
                        _set_path(new, key, value)
                elif op == "set":
                    base = current(path) if merge else None
                    new = copy.deepcopy(base) if base is not None else {}
                    _merge(new, data)
                else:
                    new = None
                staged[path] = new
            for path, new in staged.items():
                if new is None:
                    self.docs.pop(path, None)
                else:
                    self.docs[path] = new
                self.tick += 1
                self.versions[path] = self.tick

    def state(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.docs)

    def land_deferred(self) -> list[bool]:
        """Apply every deferred commit whose reads are still current; True for each that landed."""
        landed = []
        with self.lock:
            for label, writes, reads in self.deferred:
                fresh = all(self.versions.get(p, 0) == v for p, v in reads.items())
                if fresh:
                    self.apply(writes)
                    self.record("late-commit", label, 0, tuple(w[1] for w in writes))
                landed.append(fresh)
            self.deferred.clear()
        return landed

    def clear_hooks(self) -> None:
        self.after_commit.clear()
        self.on_commit.clear()
        self.on_read.clear()
        self.on_plain_read.clear()
        self.yield_between = False


class Snap:
    def __init__(self, ref: "DocRef", data: dict | None):
        self.reference, self.id, self._data = ref, ref.id, data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict | None:
        return copy.deepcopy(self._data) if self._data is not None else None


class DocRef:
    def __init__(self, server: Server, path: str):
        self.server, self.path, self.id = server, path, path.rsplit("/", 1)[-1]

    def collection(self, name: str) -> "ColRef":
        return ColRef(self.server, f"{self.path}/{name}")

    def get(self, transaction: "Transaction | None" = None) -> Snap:
        if transaction is not None:
            return transaction._read(self)
        hook = self.server.on_plain_read.get(ACTOR.get())
        if hook:
            hook(self.path)
        self.server.record("plain-read", ACTOR.get(), self.path)
        with self.server.lock:
            return Snap(self, copy.deepcopy(self.server.docs.get(self.path)))

    def set(self, data: dict, merge: bool = False) -> None:
        self.server.apply([("set", self.path, copy.deepcopy(data), merge)])

    def update(self, data: dict) -> None:
        self.server.apply([("update", self.path, copy.deepcopy(data), False)])

    def delete(self) -> None:
        self.server.apply([("delete", self.path, None, False)])


class ColRef:
    def __init__(self, server: Server, path: str):
        self.server, self.path = server, path

    def document(self, doc_id: str) -> DocRef:
        return DocRef(self.server, f"{self.path}/{doc_id}")

    def stream(self):
        prefix = self.path + "/"
        with self.server.lock:
            rows = [(p, copy.deepcopy(d)) for p, d in sorted(self.server.docs.items())
                    if p.startswith(prefix) and "/" not in p[len(prefix):]]
        return [Snap(DocRef(self.server, p), d) for p, d in rows]


class Transaction:
    """What the library's retry loop drives: `_begin`, `_commit`, `_rollback`,
    `_clean_up`, `_id`, `_max_attempts`, `_read_only` — with the semantics of
    `google.cloud.firestore_v1.transaction.Transaction`: a failed commit leaves
    the transaction in progress, rollback needs one in progress."""

    _ids = iter(range(1, 10**9))

    def __init__(self, server: Server, label: str, max_attempts: int):
        self._server, self.label = server, label
        self._max_attempts, self._read_only = max_attempts, False
        self._id: bytes | None = None
        self._reads: dict[str, int] = {}
        self._writes: list[tuple] = []
        self.attempt = 0

    @property
    def in_progress(self) -> bool:
        return self._id is not None

    def _clean_up(self) -> None:
        self._writes, self._reads, self._id = [], {}, None

    def _begin(self, retry_id: bytes | None = None) -> None:
        if self.in_progress:
            raise ValueError(LIB["_CANT_BEGIN"].format(self._id))
        self.attempt += 1
        self._id = f"{self.label}:{next(self._ids)}".encode()
        self._server.record("begin", self.label, self.attempt)

    def _rollback(self) -> None:
        if not self.in_progress:
            raise ValueError(LIB["_CANT_ROLLBACK"])
        self._server.record("rollback", self.label, self.attempt)
        self._clean_up()

    def _commit(self) -> list:
        if not self.in_progress:
            raise ValueError(LIB["_CANT_COMMIT"])
        hook = self._server.on_commit.get(self.label)
        if hook:
            try:
                hook(self)
            except DeferCommit as deferred:
                with self._server.lock:
                    self._server.deferred.append((self.label, list(self._writes), dict(self._reads)))
                    self._server.record("deferred", self.label, self.attempt)
                raise deferred.error
        if self._server.yield_between:
            time.sleep(0)
        with self._server.lock:
            stale = [p for p, v in self._reads.items() if self._server.versions.get(p, 0) != v]
            if stale:
                self._server.record("abort", self.label, self.attempt, "read-set-changed")
                raise Aborted(f"409 Transaction aborted: {stale[0]} changed after it was read")
            self._server.apply(self._writes)
            self._server.record("commit", self.label, self.attempt, tuple(w[1] for w in self._writes))
        after = self._server.after_commit.get(self.label)
        if after:
            # The writes are applied; an error here is a lost answer. Raised
            # BEFORE `_clean_up`, as the real client raises from the commit call.
            after(self)
        self._clean_up()
        return []

    def _read(self, ref: DocRef) -> Snap:
        hook = self._server.on_read.get(self.label)
        if hook:
            hook(self, ref.path)
        with self._server.lock:
            version = self._server.versions.get(ref.path, 0)
            data = copy.deepcopy(self._server.docs.get(ref.path))
        self._reads.setdefault(ref.path, version)
        if self._server.yield_between:
            time.sleep(0)
        return Snap(ref, data)

    def set(self, ref: DocRef, data: dict, merge: bool = False) -> None:
        self._writes.append(("set", ref.path, copy.deepcopy(data), merge))

    def update(self, ref: DocRef, data: dict) -> None:
        self._writes.append(("update", ref.path, copy.deepcopy(data), False))

    def delete(self, ref: DocRef) -> None:
        self._writes.append(("delete", ref.path, None, False))


class Client:
    def __init__(self, server: Server):
        self.server = server

    def collection(self, name: str) -> ColRef:
        return ColRef(self.server, name)

    def document(self, path: str) -> DocRef:
        return DocRef(self.server, path)

    def transaction(self, max_attempts: int | None = None) -> Transaction:
        return Transaction(self.server, ACTOR.get(), max_attempts or MAX_ATTEMPTS)


S = Server()
CLIENT = Client(S)


def lock_contention(tx) -> None:
    """ABORTED with no data change — what a lock conflict looks like to the client."""
    S.record("abort", tx.label, tx.attempt, "lock-contention")
    raise Aborted("409 Too much contention on these documents. Please try again.")


def abort_attempts(attempts: set[int] | None, then: Callable | None = None) -> Callable:
    """A commit hook: lock-contention ABORTED on these attempts (all, if None)."""
    def hook(tx) -> None:
        if then is not None:
            then(tx)
        if attempts is None or tx.attempt in attempts:
            lock_contention(tx)
    return hook


def events(kind: str, label: str) -> list[tuple]:
    with S.lock:
        return [e for e in S.events if e[0] == kind and e[1] == label]


