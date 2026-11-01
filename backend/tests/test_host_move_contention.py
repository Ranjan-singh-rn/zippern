"""HT-1 — Host-transfer contention: a losing move gives its documented result.

── WHAT THE MAC RUN SHOWED ─────────────────────────────────────────────────

Candidate f88988afe615b135, the real-emulator half
(`tests/crosssys/backend_transactions.crosssys.py`, section C, round 4): two
moves of one Host raced, A→B and A→C, and came back as

    (ValueError('Failed to commit transaction in 5 attempts.'), True)

A→C committed. A→B's transaction was aborted on every one of its five
attempts — google-cloud-firestore retries an aborted commit at once, five
attempts in all, then raises that ValueError from the last `Aborted`. Every
round-4 ownership check passed: this was NOT an atomicity defect. But the
losing call did not give the result `_move_host` documents (False: the Host is
no longer under the agency it was moving from), and the library's error went
on to the callers — an Owner approving a transfer got a 500, a revocation
recorded "Failed to commit transaction in 5 attempts." as the host's failure.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  1. the compare-and-set is unchanged: sequential moves, a stale `from`, and a
     race the library's retry resolves;
  2. round 4 replayed exactly — exhaustion after the competitor committed →
     False, the winner's writes intact, nothing written by the loser;
  3. exhaustion with no competitor → `HostMoveContended` (409), nothing
     written, and the same move succeeds when tried again;
  4. an `Aborted` from a READ, which the library does not retry → the same two
     results;
  5. nothing else is converted: a 503, a deadline, any other ValueError, a
     look-alike ValueError not caused by `Aborted`, an error in the body — each
     reaches the caller as the very same object;
  6. 2-way and 5-way races on real threads with forced exhaustion: at most one
     winner, never two owners, never a lost Host, roster / verification /
     application always agree with `users/{uid}.agencyId`, and every loser told
     to try again gets the documented result when it does;
  7. the callers: `transfer_requests.decide` answers 409 (the route too) and
     keeps the request pending with its lease released; the revocation loop
     records a resumable failure with a readable sentence; a Host is told
     "your agency has changed" only by the move that committed.

── WHAT IS REAL / WHAT IS FAKE ─────────────────────────────────────────────

REAL: `partner_ops._move_host`, `HostMoveContended`, `_transfer_dependents`;
      `firebase.is_transaction_contention`; `transfer_requests.request` / `decide` /
      `_execute` and its router; and — the point of this file — the
      transaction RETRY LOOP: `_BaseTransactional`, `_Transactional` and
      `transactional` are read out of the INSTALLED google-cloud-firestore
      (backend/.venv; its version must equal the requirements.txt pin) by `ast`
      and executed as written. The attempt count, the immediate retry, the
      rollback and the exhaustion error are the library's own.
FAKE: the Firestore server underneath (`tests/firestore_contention.Server`):
      versioned documents, transactional reads recorded, writes buffered and
      applied atomically at commit, a commit refused with ABORTED when anything
      it read has changed since; plus scripted ABORTED on chosen attempts (lock
      contention with no data change) and a competitor's whole move run
      between an attempt's reads and its commit. Mongo (`harness.FakeDb`),
      audit and notices are in-memory recorders.

Service-level tests against an in-memory model — NOT end-to-end. The
real-emulator half is tests/crosssys/backend_transactions.crosssys.py.

    python3 -m tests.test_host_move_contention
"""

from __future__ import annotations

import asyncio
import logging
import random
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

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


from tests.harness import FakeDb, install_stubs, verified_auth  # noqa: E402

install_stubs()

from tests.firestore_contention import (  # noqa: E402
    ACTOR, CLIENT, EXHAUSTED, MAX_ATTEMPTS, PIN, S, VERSION, Aborted, DeadlineExceeded, NotFound,
    ServiceUnavailable, abort_attempts, acting, events, lock_contention,
)

# ── Wiring ───────────────────────────────────────────────────────────────────

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

firebase_mod.firestore_client = lambda: CLIENT  # type: ignore[assignment]
firebase_mod.get_user = verified_auth  # type: ignore[assignment]
AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.routers import transfer_requests as router  # noqa: E402
from app.services import notices as notices_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import transfer_requests as svc  # noqa: E402

NOTICES: list[tuple] = []


async def fake_partner_transferred(uid, kind, partner_id, from_name, to_name):
    NOTICES.append((uid, kind, partner_id, to_name))
    return True


notices_mod.partner_transferred = fake_partner_transferred
apps.is_unverified_guest = lambda uid: False
logging.disable(logging.CRITICAL)
run = asyncio.run

_move_host = ops._move_host
#: Read with getattr so this file also RUNS against the code before the fix and
#: reports what is missing, rather than failing to import.
HMC = getattr(ops, "HostMoveContended", None)
SENTENCE = getattr(ops, "HOST_MOVE_CONTENDED", None)
#: HT-2 — a move whose outcome could not be established (absent before HT-2).
HMU = getattr(ops, "HostMoveOutcomeUnknown", None)


def unknown(outcome) -> bool:
    return HMU is not None and isinstance(outcome, HMU)


def contended(outcome) -> bool:
    return HMC is not None and isinstance(outcome, HMC)


def call(label: str, *args):
    """`_move_host(*args)` as `label`; the exception, if it raised."""
    try:
        return acting(label, _move_host, *args)
    except Exception as exc:  # noqa: BLE001 — returned and asserted on
        return exc


def show(outcome) -> str:
    return repr(outcome) if isinstance(outcome, Exception) else str(outcome)


T0 = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
_seq = iter(range(1, 10**6))


def seed_host(agency: str, **over) -> tuple[str, str, dict]:
    n = next(_seq)
    uid, app_id = f"host-{n}", f"app-{n}"
    row = {"uid": uid, "name": f"Host {n}", "agencyId": agency, "applicationId": app_id, "isActive": True}
    S.apply([
        ("set", f"users/{uid}", {"name": f"Host {n}", "isHost": True, "agencyId": agency,
                                 "accountState": "active", "isBanned": False, "isSuspended": False, **over}, False),
        ("set", f"agencies/{agency}/agencyHosts/{uid}", row, False),
        ("set", f"hostVerification/{uid}", {"uid": uid, "agencyId": agency, "status": "verified"}, False),
        ("set", f"hostApplications/{app_id}", {"applicantUid": uid, "agencyId": agency, "status": "approved"}, False),
    ])
    return uid, app_id, row


def check_state(tag: str, uid: str, app_id: str, origin: str,
                movers: list[tuple[str, datetime]], outcomes: list) -> None:
    """The business invariant, read back from the store.

    `movers[i]` is `(destination, now)` of the i-th call and `outcomes[i]` what
    it returned (or raised). Every call passes its own `now`, so whose write
    landed can be told from the documents themselves.
    """
    ok(f"{tag}: every result is True, False or HostMoveContended",
       all(o is True or o is False or contended(o) for o in outcomes), ", ".join(map(show, outcomes)))
    winners = [i for i, o in enumerate(outcomes) if o is True]
    ok(f"{tag}: at most one call reports that it moved the Host", len(winners) <= 1, ", ".join(map(show, outcomes)))
    places = sorted({origin, *(m[0] for m in movers)})
    user = S.docs.get(f"users/{uid}") or {}
    rows = [a for a in places if f"agencies/{a}/agencyHosts/{uid}" in S.docs]
    ver = S.docs.get(f"hostVerification/{uid}") or {}
    app = S.docs.get(f"hostApplications/{app_id}") or {}
    if len(winners) == 1:
        target, at = movers[winners[0]]
        row = S.docs.get(f"agencies/{target}/agencyHosts/{uid}") or {}
        ok(f"{tag}: the Host is under the winner's agency", user.get("agencyId") == target, repr(user.get("agencyId")))
        ok(f"{tag}: …moved from the origin, at the winner's time",
           user.get("agencyTransferredFrom") == origin and user.get("agencyTransferredAt") == at,
           repr((user.get("agencyTransferredFrom"), user.get("agencyTransferredAt"))))
        ok(f"{tag}: exactly one roster row, the winner's", rows == [target], repr(rows))
        ok(f"{tag}: …written by the winner", row.get("agencyId") == target and row.get("transferredFrom") == origin
           and row.get("transferredAt") == at, repr(row))
        ok(f"{tag}: the verification record names the winner",
           ver.get("agencyId") == target and ver.get("updatedAt") == at, repr(ver))
        ok(f"{tag}: the application is stamped once, by the winner",
           (app.get("transferredTo"), app.get("transferredFrom"), app.get("transferredAt")) == (target, origin, at),
           repr(app))
    elif not winners:
        ok(f"{tag}: nobody moved it, so nobody may say it was moved elsewhere (False)",
           all(contended(o) for o in outcomes), ", ".join(map(show, outcomes)))
        ok(f"{tag}: the Host is untouched under the origin",
           user.get("agencyId") == origin and "agencyTransferredFrom" not in user and rows == [origin]
           and ver.get("agencyId") == origin and "updatedAt" not in ver and "transferredTo" not in app,
           repr((user.get("agencyId"), rows, ver, app)))


def no_writes_by(tag: str, label: str, since: int = 0) -> None:
    with S.lock:
        commits = [e for e in S.events[since:] if e[0] == "commit" and e[1] == label]
    ok(f"{tag}: the losing call committed no write", all(not e[3] for e in commits), repr(commits))


# ══════════════════════════════════════════════════════════════════════════════
print("\n0. The retry loop under test is the installed, pinned library's")

eq("google-cloud-firestore installed in backend/.venv is the version requirements.txt pins", VERSION, PIN)
eq("…which makes five attempts", MAX_ATTEMPTS, 5)
eq("…and reports exhaustion with this sentence", EXHAUSTED, "Failed to commit transaction in 5 attempts.")
ok("HostMoveContended exists, is a PartnerOpsError and answers 409",
   HMC is not None and issubclass(HMC, ops.PartnerOpsError) and getattr(HMC, "status_code", None) == 409)

# ══════════════════════════════════════════════════════════════════════════════
print("1. The compare-and-set is unchanged")

uid, app_id, row = seed_host("A1")
r = call("solo", dict(row), "A1", "B1", T0)
check_state("sequential move", uid, app_id, "A1", [("B1", T0)], [r])
eq("…reported as moved", r, True)
eq("…in one attempt", len(events("begin", "solo")), 1)
before = S.state()
r2 = call("stale", dict(row), "A1", "C1", T0 + timedelta(seconds=1))
eq("a move from an agency the Host is no longer under is refused (False)", r2, False)
ok("…and writes nothing", S.state() == before)

uid, app_id, row = seed_host("A2")
competitor: dict[str, Any] = {}
S.on_commit["race-B"] = lambda tx: (
    competitor.setdefault("C", call("race-C", dict(row), "A2", "C2", T0 + timedelta(seconds=2)))
    if tx.attempt == 1 else None)
outB = call("race-B", dict(row), "A2", "B2", T0 + timedelta(seconds=1))
S.clear_hooks()
check_state("a race the library's retry resolves", uid, app_id, "A2",
            [("B2", T0 + timedelta(seconds=1)), ("C2", T0 + timedelta(seconds=2))], [outB, competitor.get("C")])
eq("…the loser re-read on its second attempt and reported False",
   (outB, len(events("begin", "race-B"))), (False, 2))
no_writes_by("…", "race-B")

# ══════════════════════════════════════════════════════════════════════════════
print("2. Round 4, replayed: every attempt aborted, the competitor committed first")

uid, app_id, row = seed_host("A3")
t_b, t_c = T0 + timedelta(seconds=10), T0 + timedelta(seconds=11)
competitor.clear()


def competitor_commits_first(tx) -> None:
    if tx.attempt == MAX_ATTEMPTS and "C" not in competitor:
        competitor["C"] = call("r4-C", dict(row), "A3", "C3", t_c)


S.on_commit["r4-B"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=competitor_commits_first)
outB = call("r4-B", dict(row), "A3", "B3", t_b)
S.clear_hooks()
print(f"   outcomes (B, C) = ({show(outB)}, {show(competitor.get('C'))})")
eq("the competitor committed", competitor.get("C"), True)
eq("the loser used every attempt the library allows", len(events("begin", "r4-B")), MAX_ATTEMPTS)
eq("…every one of them aborted", len(events("abort", "r4-B")), MAX_ATTEMPTS)
ok("the loser did not raise the library's error", not isinstance(outB, ValueError), show(outB))
eq("the loser reports the documented result: False (no longer under the origin)", outB, False)
check_state("round 4", uid, app_id, "A3", [("B3", t_b), ("C3", t_c)], [outB, competitor.get("C")])
no_writes_by("round 4", "r4-B")
ok("…and the decision came from reading the Host again",
   any(e[2] == f"users/{uid}" for e in events("plain-read", "r4-B")))

# Same destination: an Owner transfer A→B racing a revocation of A to B.
uid, app_id, row = seed_host("A4")
competitor.clear()
S.on_commit["same-B"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=lambda tx: (
    competitor.setdefault("C", call("same-C", dict(row), "A4", "B4", t_c)) if tx.attempt == MAX_ATTEMPTS else None))
outB = call("same-B", dict(row), "A4", "B4", t_b)
S.clear_hooks()
eq("same destination: the loser still reports False, not success", (outB, competitor.get("C")), (False, True))
check_state("same destination", uid, app_id, "A4", [("B4", t_b), ("B4", t_c)], [outB, competitor.get("C")])
no_writes_by("same destination", "same-B")

# ══════════════════════════════════════════════════════════════════════════════
print("3. Exhaustion with nobody else committing — 409, nothing written, try again works")

uid, app_id, row = seed_host("A5")
before = S.state()
S.on_commit["ex-B"] = abort_attempts(None)
outB = call("ex-B", dict(row), "A5", "B5", t_b)
S.clear_hooks()
print(f"   outcome = {show(outB)}")
cause = getattr(outB, "__cause__", None)
ok("HostMoveContended, not the library's ValueError", contended(outB), show(outB))
eq("…status 409", getattr(outB, "status_code", None), 409)
eq("…with the sentence a person can act on", str(outB), SENTENCE)
ok("…the cause chain keeps the library's error and its Aborted",
   isinstance(cause, ValueError) and str(cause) == EXHAUSTED and isinstance(cause.__cause__, Aborted), repr(cause))
eq("…after every attempt", len(events("begin", "ex-B")), MAX_ATTEMPTS)
ok("…and NOTHING was written", S.state() == before)
check_state("pure exhaustion", uid, app_id, "A5", [("B5", t_b)], [outB])
again = call("ex-again", dict(row), "A5", "B5", t_b)
eq("trying again once the contention has passed moves the Host", again, True)
check_state("…after trying again", uid, app_id, "A5", [("B5", t_b)], [again])

# The re-read itself fails: still "nothing changed" — the move is known not to have committed.
uid, app_id, row = seed_host("A6")
before = S.state()
S.on_commit["reread-B"] = abort_attempts(None)


def unreadable(path: str) -> None:
    raise ServiceUnavailable("503 The service is currently unavailable.")


S.on_plain_read["reread-B"] = unreadable
outB = call("reread-B", dict(row), "A6", "B6", t_b)
S.clear_hooks()
# HT-2: an error is no proof that nothing committed, and the read that would
# have shown it failed — so the answer is "could not confirm", never "not made".
ok("when the Host cannot be read again: HostMoveOutcomeUnknown (503), not a claim that nothing moved",
   unknown(outB) and getattr(outB, "status_code", None) == 503, show(outB))
ok("…nothing written", S.state() == before)

# ══════════════════════════════════════════════════════════════════════════════
print("4. ABORTED from a READ, which the library does not retry")

uid, app_id, row = seed_host("A7")
before = S.state()


def abort_first_read(tx, path: str) -> None:
    if path.startswith("users/"):
        S.record("abort", tx.label, tx.attempt, "read")
        raise Aborted("409 Transaction lock timeout.")


S.on_read["read-B"] = abort_first_read
outB = call("read-B", dict(row), "A7", "B7", t_b)
S.clear_hooks()
eq("the library gave up after one attempt", len(events("begin", "read-B")), 1)
ok("…still under the origin → HostMoveContended", contended(outB), show(outB))
ok("…nothing written", S.state() == before)

uid, app_id, row = seed_host("A8")
competitor.clear()


def competitor_then_abort_read(tx, path: str) -> None:
    if path.startswith("users/") and "C" not in competitor:
        competitor["C"] = call("read2-C", dict(row), "A8", "C8", t_c)
        raise Aborted("409 Transaction lock timeout.")


S.on_read["read2-B"] = competitor_then_abort_read
outB = call("read2-B", dict(row), "A8", "B8", t_b)
S.clear_hooks()
eq("…moved by somebody else meanwhile → False", (outB, competitor.get("C")), (False, True))
check_state("read-phase abort", uid, app_id, "A8", [("B8", t_b), ("C8", t_c)], [outB, competitor.get("C")])
no_writes_by("read-phase abort", "read2-B")

# ══════════════════════════════════════════════════════════════════════════════
print("5. Other errors: Firestore's are verified, our own pass through as the same object")


def raises_on_commit(exc: BaseException) -> Callable:
    def hook(tx) -> None:
        raise exc
    return hook


lookalike = ValueError(EXHAUSTED)  # the sentence, but not caused by Aborted
# HT-2: a Firestore error other than ABORTED says nothing about whether the
# commit landed, so the Host is read again: here it is still under its agency,
# and the answer is the typed "could not confirm" (503), chained to the error.
api_cases = [
    ("a 503 from the commit", ServiceUnavailable("503 unavailable")),
    ("a deadline on the commit", DeadlineExceeded("504 deadline exceeded")),
    ("a 404 from the commit", NotFound("404 No document to update")),
]
own_cases = [
    ("another ValueError", ValueError("The transaction has no transaction ID, so it cannot be committed.")),
    ("the exhaustion sentence without an Aborted behind it", lookalike),
]
cases = api_cases + own_cases
for claim, exc in api_cases:
    uid, app_id, row = seed_host(f"E{next(_seq)}")
    before = S.state()
    S.on_commit["X"] = raises_on_commit(exc)
    out = call("X", dict(row), S.docs[f"users/{uid}"]["agencyId"], "Z", t_b)
    S.clear_hooks()
    ok(f"{claim}: verified, then HostMoveOutcomeUnknown (503) chained to the same error",
       unknown(out) and getattr(out, "status_code", None) == 503 and out.__cause__ is exc, show(out))
    ok(f"{claim}: …and the store is as it was", S.state() == before)
for claim, exc in own_cases:
    uid, app_id, row = seed_host(f"E{next(_seq)}")
    before = S.state()
    S.on_commit["X"] = raises_on_commit(exc)
    out = call("X", dict(row), S.docs[f"users/{uid}"]["agencyId"], "Z", t_b)
    S.clear_hooks()
    ok(f"{claim}: re-raised unchanged", out is exc, show(out))
    ok(f"{claim}: …and the store is as it was", S.state() == before)

uid, app_id, row = seed_host("E-body")
bug = RuntimeError("a bug in the transaction body")


def body_bug(tx, path: str) -> None:
    if path.startswith("hostVerification/"):
        raise bug


S.on_read["X"] = body_bug
out = call("X", dict(row), "E-body", "Z", t_b)
S.clear_hooks()
ok("an error raised inside the transaction body: re-raised unchanged", out is bug, show(out))
recognise = getattr(firebase_mod, "is_transaction_contention", None)
if recognise is not None:
    ok("the recogniser: an error from the transaction body → not contention", not recognise(bug))
    chained = ValueError(EXHAUSTED)
    chained.__cause__ = Aborted("409")
    ok("the recogniser: the library's exhaustion error, caused by Aborted → contention", recognise(chained))
    ok("the recogniser: a bare Aborted → contention", recognise(Aborted("409")))
    ok("the recogniser: the sentence without an Aborted cause → not contention", not recognise(ValueError(EXHAUSTED)))
    ok("the recogniser: a subclass of ValueError with the sentence → not contention",
       not recognise(type("Odd", (ValueError,), {})(EXHAUSTED)))
    for _text in ("Failed to commit transaction in  attempts.", "Failed to commit transaction in 5 attempts. Retry",
                  "Failed to commit transaction in ² attempts.", "failed to commit transaction in 5 attempts."):
        _near = ValueError(_text)
        _near.__cause__ = Aborted("409")
        ok(f"the recogniser: {_text!r} from an Aborted → not the library's sentence", not recognise(_near))
    _other_count = ValueError("Failed to commit transaction in 12 attempts.")
    _other_count.__cause__ = Aborted("409")
    ok("the recogniser: the sentence with another attempt count, from an Aborted → contention",
       recognise(_other_count))
    for _claim, _exc in cases:
        ok(f"the recogniser: {_claim} → not contention", not recognise(_exc))
    kind_of = getattr(firebase_mod, "transaction_error_kind", None)
    ok("HT-2: the error sorter exists", kind_of is not None)
    if kind_of is not None:
        ok("HT-2 sorter: Aborted / exhaustion → contended", kind_of(Aborted("409")) == "contended"
           and kind_of(chained) == "contended")
        for _claim, _exc in api_cases:
            ok(f"HT-2 sorter: {_claim} → uncertain (verify before answering)", kind_of(_exc) == "uncertain")
        ok("HT-2 sorter: a transport error → uncertain", kind_of(TimeoutError("timed out")) == "uncertain")
        for _claim, _exc in own_cases:
            ok(f"HT-2 sorter: {_claim} → our own code, passed through", kind_of(_exc) is None)
        ok("HT-2 sorter: an error of the transaction body → our own code", kind_of(bug) is None)
else:
    ok("app.db.firebase.is_transaction_contention exists", False)

# ══════════════════════════════════════════════════════════════════════════════
print("6. Races on real threads, with forced exhaustion — the invariant every time")

stats = {"rounds": 0, "exhausted": 0, "false": 0, "contended": 0, "no_winner": 0}


def thread_race(n: int, rounds: int, seed: int) -> None:
    rng = random.Random(seed)
    rng_lock = threading.Lock()
    for i in range(rounds):
        origin = f"R{n}-{i}-A"
        uid, app_id, row = seed_host(origin)
        movers = [(f"R{n}-{i}-T{k}", T0 + timedelta(minutes=i, seconds=k)) for k in range(n)]
        forced = i % n  # this mover's every commit is aborted: it ALWAYS exhausts

        def maybe_abort(tx, k=None) -> None:
            with rng_lock:
                roll = rng.random()
            if roll < 0.5:
                lock_contention(tx)

        for k in range(n):
            S.on_commit[f"r{k}"] = abort_attempts(None) if k == forced else maybe_abort
        S.yield_between = True
        barrier = threading.Barrier(n)
        out: list[Any] = [None] * n

        def mover(k: int) -> None:
            ACTOR.set(f"r{k}")
            barrier.wait()
            try:
                out[k] = _move_host(dict(row), origin, movers[k][0], movers[k][1])
            except Exception as exc:  # noqa: BLE001
                out[k] = exc

        mark = len(S.events)
        threads = [threading.Thread(target=mover, args=(k,)) for k in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        S.clear_hooks()
        tag = f"{n}-way round {i}"
        ok(f"{tag}: every mover finished", not any(t.is_alive() for t in threads))
        check_state(tag, uid, app_id, origin, movers, out)
        with S.lock:
            exhausted = {e[1] for e in S.events[mark:] if e[0] == "abort" and e[2] == MAX_ATTEMPTS}
        ok(f"{tag}: the forced mover exhausted every attempt", f"r{forced}" in exhausted, repr(sorted(exhausted)))
        stats["rounds"] += 1
        stats["exhausted"] += len(exhausted)
        stats["false"] += sum(o is False for o in out)
        stats["contended"] += sum(contended(o) for o in out)
        stats["no_winner"] += not any(o is True for o in out)

        # "Try again" — what HostMoveContended tells its caller to do.
        final = list(out)
        for k, o in enumerate(out):
            if contended(o):
                final[k] = call(f"retry{k}", dict(row), origin, movers[k][0], movers[k][1])
        ok(f"{tag}: after the retries exactly one call succeeded, every other one says False",
           sum(o is True for o in final) == 1 and all(o is True or o is False for o in final),
           ", ".join(map(show, final)))
        check_state(f"{tag} after retries", uid, app_id, origin, movers, final)
        for k, o in enumerate(final):
            if o is not True:
                no_writes_by(f"{tag} mover {k}", f"r{k}", since=mark)


thread_race(2, 25, seed=20261020)
thread_race(5, 25, seed=5)
print(f"   {stats['rounds']} rounds: {stats['exhausted']} movers exhausted every attempt, "
      f"{stats['false']} False, {stats['contended']} HostMoveContended, {stats['no_winner']} rounds with no winner")
# Which loser result a thread gets depends on the interleaving, so the split is
# reported, not asserted; sections 2–4 pin each result deterministically.
ok("exhaustion was exercised under real threads in every round", stats["exhausted"] >= stats["rounds"], repr(stats))

# ══════════════════════════════════════════════════════════════════════════════
print("7. The callers — an Owner's transfer decision and a revocation")

ADMIN = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "The Owner", "role": "owner", "team": None}
NOTE = "The host asked to move; both agencies agreed in writing."


def user(uid: str, **over) -> None:
    S.apply([("set", f"users/{uid}", {"name": f"user {uid}", "accountState": "active",
                                      "isBanned": False, "isSuspended": False, **over}, False)])


def partner(pid: str, owner: str, kind: str = "agency", status: str = "approved", **over) -> dict:
    doc = {"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
           "is_active": status == "approved", "name": pid, **over}
    DB[C.PARTNERS].docs.append(doc)
    S.apply([("set", f"agencies/{pid}", {"agencyName": pid, "crmUid": owner}, False)])
    user(owner)
    return doc


def request_doc(rid: str) -> dict:
    return next(d for d in DB["transfer_requests"].docs if d["_id"] == rid)


DB.seed(C.STAFF, [{"uid": "owner-1", "role": "owner", "is_active": True,
                   "email": "owner@zipper.test", "name": "The Owner"}])
MAIN1, MAIN2, MAIN3 = partner("MAIN1", "o-1"), partner("MAIN2", "o-2"), partner("MAIN3", "o-3")

# 7a. Pure exhaustion while the Owner approves → 409, request still pending, lease released.
huid, happ, hrow = seed_host("MAIN1")
T1 = run(svc.request("host", huid, "MAIN2", NOTE, ADMIN))["request"]["id"]
before = S.state()
audits = len(AUDIT)
S.on_commit["owner"] = abort_attempts(None)
try:
    acting("owner", run, svc.decide(T1, True, NOTE, OWNER))
    got: Any = None
except Exception as exc:  # noqa: BLE001
    got = exc
print(f"   decide under exhaustion → {show(got)}")
ok("decide answers TransferConflict, not the library's error", isinstance(got, svc.TransferConflict), show(got))
eq("…409", getattr(got, "status_code", None), 409)
ok("…saying the host is still under its agency and to approve again",
   "still under its agency" in str(got) and "Approve it again" in str(got),
   str(got))
eq("…the request is still pending, its lease released",
   (request_doc(T1)["status"], request_doc(T1).get("deciding_token")), ("pending", None))
# B2 (spec §6): the Owner's approval places the HOLD on the Host's unsettled
# earnings (`payoutHold*` on the account, cause `transfer_review`) BEFORE the
# move, so a move that is then refused leaves the hold — recorded on the still-
# pending request — and nothing else. The host, the rosters and the verification
# record are exactly as they were.
_HOLD_FIELDS = ("payoutHold", "payoutHoldReason", "payoutHoldAt")


def _without_hold(state: dict) -> dict:
    return {path: {k: v for k, v in doc.items() if k not in _HOLD_FIELDS} for path, doc in state.items()}


ok("…nothing moved in Firestore (only the §6 hold on the Host's earnings was written)",
   _without_hold(S.state()) == _without_hold(before)
   and S.docs[f"users/{huid}"].get("payoutHold") is True)
ok("…no approval was audited and nobody was told the agency changed",
   not any(a["action"] == svc.Act.APPROVED for a in AUDIT[audits:]) and not [n for n in NOTICES if n[0] == huid])

try:
    acting("owner", run, router.decide_transfer(T1, router.TransferDecision(approve=True, note=NOTE), user=OWNER))
    route_status = None
except Exception as exc:  # noqa: BLE001
    route_status = getattr(exc, "status_code", None)
S.clear_hooks()
eq("…and through the route it is a 409 (it was a 500)", route_status, 409)

done = acting("owner", run, svc.decide(T1, True, NOTE, OWNER))
eq("approving again once the contention has passed moves the Host", (done["request"]["status"], done["moved"]["to"]),
   ("approved", "MAIN2"))
eq("…the Host is under MAIN2", S.docs[f"users/{huid}"]["agencyId"], "MAIN2")
eq("…and is told once", [n for n in NOTICES if n[0] == huid], [(huid, "host", "MAIN1", "MAIN2")])

# 7b. Round 4 through decide: a revocation's move to MAIN3 commits during the Owner's last attempt.
huid, happ, hrow = seed_host("MAIN1")
T2 = run(svc.request("host", huid, "MAIN2", NOTE, ADMIN))["request"]["id"]
competitor.clear()
S.on_commit["owner"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=lambda tx: (
    competitor.setdefault("rev", call("revocation", dict(hrow), "MAIN1", "MAIN3", t_c))
    if tx.attempt == MAX_ATTEMPTS else None))
try:
    acting("owner", run, svc.decide(T2, True, NOTE, OWNER))
    got = None
except Exception as exc:  # noqa: BLE001
    got = exc
S.clear_hooks()
print(f"   decide losing to a committed move → {show(got)}")
ok("decide answers the existing 'the host moved' refusal (400), not a 500",
   type(got) is svc.TransferError and getattr(got, "status_code", None) == 400
   and "moved while this was being decided" in str(got), show(got))
eq("…the request stays pending, lease released", (request_doc(T2)["status"], request_doc(T2).get("deciding_token")),
   ("pending", None))
eq("…the Host is under MAIN3 (the move that committed)", S.docs[f"users/{huid}"]["agencyId"], "MAIN3")
check_state("decide vs revocation", huid, happ, "MAIN1", [("MAIN2", T0), ("MAIN3", t_c)],
            [False, competitor.get("rev")])

# 7c. The revocation loop: contention is a resumable failure with a readable sentence.
REVOKED = partner("OLD1", "o-old")
huid, happ, hrow = seed_host("OLD1")
before = S.state()
S.on_commit["revoke"] = abort_attempts(None)
moved = acting("revoke", run, ops._transfer_dependents(
    REVOKED, MAIN2, "Agency revoked for cause.", OWNER, T0, planned=([], [dict(hrow)], MAIN2)))
S.clear_hooks()
eq("revocation under exhaustion: the host is a FAILED move, named, with the readable sentence",
   (moved["hosts"], moved["failed_hosts"], moved["complete"]), ([], [{"uid": huid, "error": SENTENCE}], False))
ok("…nothing moved and nobody was told", S.state() == before and not [n for n in NOTICES if n[0] == huid])
eq("…the record says what is left",
   (next(d for d in DB[C.PARTNERS].docs if d["_id"] == "OLD1").get("dependents_transfer") or {}).get("failed_hosts"),
   [huid])
moved = acting("revoke", run, ops._transfer_dependents(
    REVOKED, MAIN2, "Agency revoked for cause.", OWNER, T0, planned=([], [dict(hrow)], MAIN2)))
eq("running it again moves the host", (moved["hosts"], moved["failed_hosts"], moved["complete"]), ([huid], [], True))
eq("…told once", [n for n in NOTICES if n[0] == huid], [(huid, "host", "OLD1", "MAIN2")])

huid, happ, hrow = seed_host("OLD1")
competitor.clear()
S.on_commit["revoke"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=lambda tx: (
    competitor.setdefault("t", call("transfer", dict(hrow), "OLD1", "MAIN3", t_c))
    if tx.attempt == MAX_ATTEMPTS else None))
moved = acting("revoke", run, ops._transfer_dependents(
    REVOKED, MAIN2, "Agency revoked for cause.", OWNER, T0, planned=([], [dict(hrow)], MAIN2)))
S.clear_hooks()
eq("revocation losing to a committed transfer: skipped (moved by somebody else), not failed",
   (moved["skipped_hosts"], moved["failed_hosts"], competitor.get("t")), ([huid], [], True))
eq("…the Host stays where the committed move put it", S.docs[f"users/{huid}"]["agencyId"], "MAIN3")
ok("…and is not told about a move that did not happen", not [n for n in NOTICES if n[0] == huid])

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} host-move contention checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} host-move contention checks passed.")
