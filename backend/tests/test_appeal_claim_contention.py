"""HT-1 (second transaction) — the appeal claim gives its documented result under contention.

── WHY ─────────────────────────────────────────────────────────────────────

`appeals._auto_resolve_one` resolves a pending appeal by compare-and-set
inside ONE Firestore transaction — the same shape as `partner_ops._move_host`,
and it had the same gap: when Firestore aborted the claim on every attempt, the
library's `ValueError('Failed to commit transaction in 5 attempts.')` escaped
instead of the documented result (None: "it had moved on"). The real-emulator
half (`tests/crosssys/backend_transactions.crosssys.py`, section D) asserts
"none raised" for 2 and 4 Unbans at once. A dry run of that file under
contention failed there with exactly that error, after the host move was fixed.

Production impact was small: every caller of `auto_resolve_pending` catches
any error, so the unban, resume or decision still succeeds and the appeal is
left pending, logged. The error also stops the loop, so the account's other
pending appeals are not resolved in that call.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  1. the compare-and-set is unchanged (once; a second press is None; a race
     the library's retry resolves);
  2. exhaustion after another claim resolved it → None, one audit, the
     winner's name on the document;
  3. exhaustion with nobody else resolving it → `AppealClaimContended`,
     nothing written, no audit, and pressing again resolves it;
  4. a reviewer deciding it mid-claim → None, and the decision stands;
  5. an `Aborted` from a READ (not retried by the library) → the same results;
  6. nothing else is converted — a 503, a deadline, any other ValueError, the
     sentence without an `Aborted` behind it, all re-raised as the same object;
  7. 2-, 4- and 5-way races on real threads, with forced exhaustion: the
     appeal is resolved at most once, by the admin the one audit entry names,
     and every claimant told to try again gets the documented result.

REAL: `appeals._auto_resolve_one`, `AppealClaimContended`,
      `firebase.is_transaction_contention`, and the library's own retry loop
      (`tests/firestore_contention`, read out of the installed, pinned
      google-cloud-firestore).
FAKE: the Firestore server (`tests/firestore_contention.Server`); audit is an
      in-memory recorder.

Service-level tests against an in-memory model — NOT end-to-end.

    python3 -m tests.test_appeal_claim_contention
"""

from __future__ import annotations

import asyncio
import logging
import random
import sys
import threading
from pathlib import Path
from typing import Any

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


from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from tests.firestore_contention import (  # noqa: E402
    ACTOR, CLIENT, EXHAUSTED, MAX_ATTEMPTS, PIN, S, VERSION, Aborted, DeadlineExceeded,
    ServiceUnavailable, abort_attempts, acting, events, lock_contention,
)

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

firebase_mod.firestore_client = lambda: CLIENT  # type: ignore[assignment]
AUDIT: list[dict] = []
_audit_lock = threading.Lock()


async def fake_audit(**kw):
    with _audit_lock:
        AUDIT.append(kw)
        return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.services import appeals  # noqa: E402

logging.disable(logging.CRITICAL)
ACC = getattr(appeals, "AppealClaimContended", None)
SENTENCE = getattr(appeals, "APPEAL_CLAIM_CONTENDED", None)
_seq = iter(range(1, 10**6))


def contended(outcome) -> bool:
    return ACC is not None and isinstance(outcome, ACC)


def show(outcome) -> str:
    if isinstance(outcome, dict):
        return f"resolved({outcome.get('audit_id')})"
    return repr(outcome) if isinstance(outcome, Exception) else str(outcome)


def admin(k) -> dict:
    return {"uid": f"admin-{k}", "name": f"Admin {k}", "role": "ops_admin"}


def seed_appeal(status: str = "pending") -> tuple[str, Any]:
    aid = f"appeal-{next(_seq)}"
    S.apply([("set", f"appeals/{aid}", {"status": status, "subjectUid": "subject-1", "kind": "ban"}, False)])
    return aid, CLIENT.document(f"appeals/{aid}").get()


def claim(label: str, snap, who: dict):
    """`_auto_resolve_one` as `label`: the resolution, None, or what it raised."""
    try:
        return acting(label, asyncio.run, appeals._auto_resolve_one(
            CLIENT, snap, "subject-1", who, "unban", "Lifted by an administrator."))
    except Exception as exc:  # noqa: BLE001 — returned and asserted on
        return exc


def audits_for(aid: str) -> list[dict]:
    with _audit_lock:
        return [a for a in AUDIT if a.get("subject_id") == aid]


def check_appeal(tag: str, aid: str, claimants: list[dict], outcomes: list, *, decided_by_reviewer: str = "") -> None:
    ok(f"{tag}: every result is a resolution, None or AppealClaimContended",
       all(isinstance(o, dict) or o is None or contended(o) for o in outcomes), ", ".join(map(show, outcomes)))
    winners = [k for k, o in enumerate(outcomes) if isinstance(o, dict)]
    ok(f"{tag}: at most one call reports that it resolved the appeal", len(winners) <= 1,
       ", ".join(map(show, outcomes)))
    stored = S.docs.get(f"appeals/{aid}") or {}
    trail = audits_for(aid)
    if decided_by_reviewer:
        ok(f"{tag}: the reviewer's decision stands", stored.get("status") == decided_by_reviewer
           and "resolvedBy" not in stored, repr(stored.get("status")))
        ok(f"{tag}: …nobody claims to have resolved it, nothing audited", not winners and not trail)
        return
    if len(winners) == 1:
        who = claimants[winners[0]]["uid"]
        ok(f"{tag}: the appeal is resolved", stored.get("status") == "resolved", repr(stored.get("status")))
        ok(f"{tag}: …by the claimant that says so", stored.get("resolvedBy") == who, repr(stored.get("resolvedBy")))
        eq(f"{tag}: …and ONE audit entry, naming them", [a["actor"]["uid"] for a in trail], [who])
    elif not winners:
        ok(f"{tag}: nobody resolved it, so nobody may say it had moved on (None)",
           all(contended(o) for o in outcomes), ", ".join(map(show, outcomes)))
        ok(f"{tag}: …the appeal is still pending and nothing was audited",
           stored.get("status") == "pending" and "resolvedBy" not in stored and not trail, repr(stored))


# ══════════════════════════════════════════════════════════════════════════════
print("\n0. The library and the new result")

eq("google-cloud-firestore installed in backend/.venv is the version requirements.txt pins", VERSION, PIN)
ok("AppealClaimContended exists and is an AppealError", ACC is not None and issubclass(ACC, appeals.AppealError))

# ══════════════════════════════════════════════════════════════════════════════
print("1. The compare-and-set is unchanged")

aid, snap = seed_appeal()
first = claim("one", snap, admin(1))
second = claim("two", snap, admin(2))
check_appeal("pressed twice", aid, [admin(1), admin(2)], [first, second])
eq("…the second press is None", second, None)

aid, snap = seed_appeal()
won: dict[str, Any] = {}
S.on_commit["race-B"] = lambda tx: (won.setdefault("C", claim("race-C", snap, admin("C"))) if tx.attempt == 1 else None)
outB = claim("race-B", snap, admin("B"))
S.clear_hooks()
check_appeal("a race the library's retry resolves", aid, [admin("B"), admin("C")], [outB, won.get("C")])
eq("…the loser read it again and said None", (outB, len(events("begin", "race-B"))), (None, 2))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Every attempt aborted, another claim resolved it first")

aid, snap = seed_appeal()
won.clear()
S.on_commit["r4-B"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=lambda tx: (
    won.setdefault("C", claim("r4-C", snap, admin("C"))) if tx.attempt == MAX_ATTEMPTS else None))
outB = claim("r4-B", snap, admin("B"))
S.clear_hooks()
print(f"   outcomes (B, C) = ({show(outB)}, {show(won.get('C'))})")
eq("the loser used every attempt", len(events("begin", "r4-B")), MAX_ATTEMPTS)
ok("the loser did not raise the library's error", not isinstance(outB, ValueError), show(outB))
eq("the loser reports the documented result: None", outB, None)
check_appeal("exhaustion after a resolution", aid, [admin("B"), admin("C")], [outB, won.get("C")])

# ══════════════════════════════════════════════════════════════════════════════
print("3. Exhaustion with nobody else resolving it")

aid, snap = seed_appeal()
before = S.state()
S.on_commit["ex-B"] = abort_attempts(None)
outB = claim("ex-B", snap, admin("B"))
S.clear_hooks()
print(f"   outcome = {show(outB)}")
cause = getattr(outB, "__cause__", None)
ok("AppealClaimContended, not the library's ValueError", contended(outB), show(outB))
eq("…with the sentence", str(outB), SENTENCE)
ok("…the cause chain keeps the library's error and its Aborted",
   isinstance(cause, ValueError) and str(cause) == EXHAUSTED and isinstance(cause.__cause__, Aborted), repr(cause))
ok("…nothing written", S.state() == before)
check_appeal("pure exhaustion", aid, [admin("B")], [outB])
again = claim("ex-again", snap, admin("B"))
check_appeal("pressing again", aid, [admin("B")], [again])
ok("pressing again resolves it", isinstance(again, dict), show(again))

# ══════════════════════════════════════════════════════════════════════════════
print("4. A reviewer decides it while the claim is being retried")

aid, snap = seed_appeal()
S.on_commit["rv-B"] = abort_attempts(set(range(1, MAX_ATTEMPTS)), then=lambda tx: (
    CLIENT.document(f"appeals/{aid}").update({"status": "upheld"}) if tx.attempt == MAX_ATTEMPTS else None))
outB = claim("rv-B", snap, admin("B"))
S.clear_hooks()
eq("the claim reports None", outB, None)
check_appeal("reviewer first", aid, [admin("B")], [outB], decided_by_reviewer="upheld")

# ══════════════════════════════════════════════════════════════════════════════
print("5. ABORTED from a READ, which the library does not retry")

aid, snap = seed_appeal()
before = S.state()


def abort_read(tx, path: str) -> None:
    raise Aborted("409 Transaction lock timeout.")


S.on_read["rd-B"] = abort_read
outB = claim("rd-B", snap, admin("B"))
S.clear_hooks()
eq("one attempt", len(events("begin", "rd-B")), 1)
ok("still pending → AppealClaimContended", contended(outB), show(outB))
ok("…nothing written", S.state() == before)

aid, snap = seed_appeal()
won.clear()


def resolve_then_abort_read(tx, path: str) -> None:
    if "C" not in won:
        won["C"] = claim("rd2-C", snap, admin("C"))
        raise Aborted("409 Transaction lock timeout.")


S.on_read["rd2-B"] = resolve_then_abort_read
outB = claim("rd2-B", snap, admin("B"))
S.clear_hooks()
eq("resolved by somebody else meanwhile → None", outB, None)
check_appeal("read-phase abort", aid, [admin("B"), admin("C")], [outB, won.get("C")])

# ══════════════════════════════════════════════════════════════════════════════
print("6. Other errors: Firestore's are verified, our own pass through as the same object")

#: HT-2 — a claim whose outcome could not be established (absent before HT-2).
ACU = getattr(appeals, "AppealClaimOutcomeUnknown", None)
for what, exc, verified in [
    ("a 503 from the commit", ServiceUnavailable("503 unavailable"), True),
    ("a deadline on the commit", DeadlineExceeded("504 deadline exceeded"), True),
    ("another ValueError", ValueError("The transaction has no transaction ID, so it cannot be committed."), False),
    ("the exhaustion sentence without an Aborted behind it", ValueError(EXHAUSTED), False),
]:
    aid, snap = seed_appeal()
    before = S.state()

    def boom(tx, exc=exc) -> None:
        raise exc

    S.on_commit["x"] = boom
    out = claim("x", snap, admin("x"))
    S.clear_hooks()
    if verified:
        # HT-2: Firestore's error says nothing about whether the claim landed;
        # read again, the appeal is still pending → "could not confirm".
        ok(f"{what}: verified, then AppealClaimOutcomeUnknown chained to the same error",
           ACU is not None and isinstance(out, ACU) and out.__cause__ is exc, show(out))
    else:
        ok(f"{what}: re-raised unchanged", out is exc, show(out))
    ok(f"{what}: …nothing written, nothing audited", S.state() == before and not audits_for(aid))

# ══════════════════════════════════════════════════════════════════════════════
print("7. Unbans at once on real threads, with forced exhaustion")

stats = {"races": 0, "none": 0, "contended": 0, "no_winner": 0}


def unbans_at_once(n: int, races: int, seed: int) -> None:
    rng = random.Random(seed)
    rng_lock = threading.Lock()
    for i in range(races):
        aid, snap = seed_appeal()
        who = [admin(f"{n}-{i}-{k}") for k in range(n)]
        forced = i % n

        def maybe(tx) -> None:
            with rng_lock:
                roll = rng.random()
            if roll < 0.5:
                lock_contention(tx)

        for k in range(n):
            S.on_commit[f"u{k}"] = abort_attempts(None) if k == forced else maybe
        S.yield_between = True
        barrier = threading.Barrier(n)
        out: list[Any] = [None] * n

        def press(k: int) -> None:
            ACTOR.set(f"u{k}")
            barrier.wait()
            try:
                out[k] = asyncio.run(appeals._auto_resolve_one(CLIENT, snap, "subject-1", who[k], "unban", "Lifted."))
            except Exception as exc:  # noqa: BLE001
                out[k] = exc

        threads = [threading.Thread(target=press, args=(k,)) for k in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        S.clear_hooks()
        tag = f"{n} at once, race {i}"
        ok(f"{tag}: every claim finished", not any(t.is_alive() for t in threads))
        check_appeal(tag, aid, who, out)
        stats["races"] += 1
        stats["none"] += sum(o is None for o in out)
        stats["contended"] += sum(contended(o) for o in out)
        stats["no_winner"] += not any(isinstance(o, dict) for o in out)
        final = list(out)
        for k, o in enumerate(out):
            if contended(o):
                final[k] = claim(f"again{k}", snap, who[k])
        ok(f"{tag}: after pressing again, resolved exactly once and every other call says None",
           sum(isinstance(o, dict) for o in final) == 1 and all(isinstance(o, dict) or o is None for o in final),
           ", ".join(map(show, final)))
        check_appeal(f"{tag} after pressing again", aid, who, final)


unbans_at_once(2, 20, seed=2)
unbans_at_once(4, 15, seed=4)
unbans_at_once(5, 10, seed=5)
print(f"   {stats['races']} races: {stats['none']} None, {stats['contended']} AppealClaimContended, "
      f"{stats['no_winner']} races with no winner")

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} appeal-claim contention checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} appeal-claim contention checks passed.")
