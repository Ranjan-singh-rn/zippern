"""HT-2 test support — FakeFirestore's data and queries, with FAITHFUL transactions.

NOT a test (no `test_` prefix). Import AFTER `tests.harness.install_stubs()`.

`tests/fakes.FakeFirestore` models documents, subcollections, queries, batches
and auto-ids well, but its transaction applies each write at once and its
`transactional` is the identity: no retry, no conflict, no lost answer — so no
test built on it can see what HT-2 is about. `TxFirestore` keeps all of that and
replaces only the transaction:

  * the retry loop is the INSTALLED google-cloud-firestore's own
    (`tests.firestore_contention` reads `_Transactional` out of backend/.venv
    and installs it as `firebase_admin.firestore.transactional`);
  * reads made through a transaction are recorded; writes are buffered and
    applied all-or-nothing at commit; a commit is refused with ABORTED when a
    document it read has changed since (optimistic validation);
  * hooks, per caller (`acting(label, …)`, carried by a ContextVar so it
    survives `asyncio.to_thread`), script what Firestore can do to a caller:
      - `on_commit[label](tx)`   before a commit: raise to fail it (ABORTED, a
                                 503, a deadline…); raise `DeferCommit(err)` to
                                 fail it AND keep its writes for a late landing;
      - `after_commit[label](tx)` AFTER the writes were applied: raise to lose
                                 the answer (the client re-sends a commit, and
                                 an ABORTED there makes the library run the
                                 callback again on the committed state);
      - `on_read[label](tx, path)` before a transactional read;
      - `on_plain_read[label](path)` before a read outside a transaction;
      - `on_begin[label](tx)`    before an attempt begins: raise to fail the
                                 begin (the library then hides the error behind
                                 its own "cannot be rolled back" ValueError);
  * `land_deferred()` applies deferred commits whose reads are still current.
"""

from __future__ import annotations

import copy
from typing import Any, Callable

from tests.fakes import FakeDocument, FakeFirestore
from tests.firestore_contention import ACTOR, LIB, MAX_ATTEMPTS, Aborted, DeferCommit, NotFound

_orig_get = FakeDocument.get


def _path(doc: FakeDocument) -> str:
    return f"{doc.col.name}/{doc.id}"


class TxTransaction:
    """What the library's retry loop drives, over FakeFirestore documents."""

    _ids = iter(range(1, 10**9))

    def __init__(self, store: "TxFirestore", label: str, max_attempts: int):
        self._store, self.label = store, label
        self._max_attempts, self._read_only = max_attempts, False
        self._id: bytes | None = None
        self._reads: dict[str, tuple[FakeDocument, Any]] = {}
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
        hook = self._store.on_begin.get(self.label)
        if hook:
            # Raised BEFORE an id exists, as the real BeginTransaction call
            # fails: the library's `_rollback()` then raises its own ValueError
            # ("…cannot be rolled back") with this error in `__context__`.
            hook(self)
        self._id = f"{self.label}:{next(self._ids)}".encode()
        self._store.record("begin", self.label, self.attempt)

    def _rollback(self) -> None:
        if not self.in_progress:
            raise ValueError(LIB["_CANT_ROLLBACK"])
        self._store.record("rollback", self.label, self.attempt)
        self._clean_up()

    def _read(self, doc: FakeDocument):
        hook = self._store.on_read.get(self.label)
        if hook:
            hook(self, _path(doc))
        self._reads.setdefault(_path(doc), (doc, copy.deepcopy(doc.col.docs.get(doc.id))))
        return _orig_get(doc)

    def set(self, ref: FakeDocument, data: dict, merge: bool = False):
        self._writes.append(("set", ref, copy.deepcopy(data), merge))
        return self

    def update(self, ref: FakeDocument, data: dict):
        self._writes.append(("update", ref, copy.deepcopy(data), False))
        return self

    def delete(self, ref: FakeDocument):
        self._writes.append(("delete", ref, None, False))
        return self

    def _commit(self) -> list:
        if not self.in_progress:
            raise ValueError(LIB["_CANT_COMMIT"])
        hook = self._store.on_commit.get(self.label)
        if hook:
            try:
                hook(self)
            except DeferCommit as deferred:
                self._store.deferred.append((self.label, list(self._writes), dict(self._reads)))
                self._store.record("deferred", self.label, self.attempt)
                raise deferred.error
        stale = [p for p, (doc, seen) in self._reads.items() if doc.col.docs.get(doc.id) != seen]
        if stale:
            self._store.record("abort", self.label, self.attempt, "read-set-changed")
            raise Aborted(f"409 Transaction aborted: {stale[0]} changed after it was read")
        _apply(self._writes)
        self._store.record("commit", self.label, self.attempt, tuple(_path(w[1]) for w in self._writes))
        after = self._store.after_commit.get(self.label)
        if after:
            after(self)  # the writes are applied: this is a lost answer
        self._clean_up()
        return []


def _apply(writes: list[tuple]) -> None:
    """All of `writes` or none: an update of a missing document refuses them all."""
    exists: dict[str, bool] = {}
    for op, doc, _data, _merge in writes:
        key = _path(doc)
        present = exists.get(key, doc.id in doc.col.docs)
        if op == "update" and not present:
            raise NotFound(f"404 No document to update: {key}")
        exists[key] = op != "delete"
    for op, doc, data, merge in writes:
        if op == "set":
            doc.set(copy.deepcopy(data), merge=merge)
        elif op == "update":
            doc.update(copy.deepcopy(data))
        else:
            doc.delete()


class TxFirestore(FakeFirestore):
    def __init__(self) -> None:
        super().__init__()
        self.on_commit: dict[str, Callable] = {}
        self.after_commit: dict[str, Callable] = {}
        self.on_read: dict[str, Callable] = {}
        self.on_plain_read: dict[str, Callable] = {}
        self.on_begin: dict[str, Callable] = {}
        self.deferred: list[tuple] = []
        self.events: list[tuple] = []
        global CURRENT
        CURRENT = self

    def transaction(self, max_attempts: int | None = None, **_kw) -> TxTransaction:  # type: ignore[override]
        return TxTransaction(self, ACTOR.get(), max_attempts or MAX_ATTEMPTS)

    def record(self, *event) -> None:
        self.events.append(event)

    def events_of(self, kind: str, label: str) -> list[tuple]:
        return [e for e in self.events if e[0] == kind and e[1] == label]

    def land_deferred(self) -> list[bool]:
        """Apply each deferred commit whose reads are still current; True for each that landed."""
        landed = []
        for label, writes, reads in self.deferred:
            fresh = all(doc.col.docs.get(doc.id) == seen for doc, seen in reads.values())
            if fresh:
                _apply(writes)
                self.record("late-commit", label, 0, tuple(_path(w[1]) for w in writes))
            landed.append(fresh)
        self.deferred.clear()
        return landed

    def clear_hooks(self) -> None:
        self.on_begin.clear()
        self.on_commit.clear()
        self.after_commit.clear()
        self.on_read.clear()
        self.on_plain_read.clear()


CURRENT: TxFirestore | None = None


def _get(self: FakeDocument, transaction: Any = None):
    if isinstance(transaction, TxTransaction):
        return transaction._read(self)
    if CURRENT is not None:
        hook = CURRENT.on_plain_read.get(ACTOR.get())
        if hook:
            hook(_path(self))
    return _orig_get(self)


FakeDocument.get = _get  # type: ignore[assignment]


# ── Scripts ───────────────────────────────────────────────────────────────────


def lock_contention(tx) -> None:
    raise Aborted("409 Too much contention on these documents. Please try again.")


def fail_attempts(attempts: set[int] | None, error: Callable[[], BaseException] = lambda: Aborted("409")) -> Callable:
    """An on_commit hook: fail these attempts (all if None) with `error()`."""
    def hook(tx) -> None:
        if attempts is None or tx.attempt in attempts:
            raise error()
    return hook


def lose_answer(error: Callable[[], BaseException], attempts: set[int] | None = None) -> Callable:
    """An after_commit hook: the writes landed, the caller gets `error()` instead."""
    def hook(tx) -> None:
        if attempts is None or tx.attempt in attempts:
            raise error()
    return hook


def defer(error: Callable[[], BaseException]) -> Callable:
    """An on_commit hook: the commit does not land now — it may later (`land_deferred`)."""
    def hook(tx) -> None:
        raise DeferCommit(error())
    return hook
