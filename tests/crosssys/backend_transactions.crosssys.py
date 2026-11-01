"""CROSS-SYSTEM — the backend's Firestore transactions against the LOCAL emulator.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

The backend's service tests run on `tests/fakes.FakeFirestore`, whose
`transactional` is "the identity function, with no retry and no contention"
(`tests/harness.py`). Two guarantees therefore were never executed against a
datastore that can race:

  C. Host-transfer contention (FX-10, RF-15/RF-31, HT-1) — `partner_ops._move_host`
     moves a Host only while `users/{uid}.agencyId` still names the agency it
     is moving FROM, inside one transaction. Moves of one Host racing (an
     Owner transfer A→B and a revocation of A with transfer to C; and five at
     once) must end with the Host under exactly ONE agency, with exactly one
     roster row, and every call must give a DOCUMENTED result: True (it moved
     the Host), False (another move won) or `HostMoveContended` (Firestore
     aborted it under contention, nothing changed — try again). HT-1: on
     candidate f88988afe615b135 round 4 returned the library's
     `ValueError('Failed to commit transaction in 5 attempts.')` instead; the
     ownership checks all passed. A caller told to try again is retried here,
     and must then get True or False.
  D. Appeal claim contention — `appeals._auto_resolve_one` resolves a pending
     appeal by compare-and-set inside a transaction, so two admins pressing
     Unban at once (or Unban racing a reviewer's decision) resolve it once.
     HT-1: the same library error could escape it; each call now gives a
     documented result — the resolution, None (it had moved on) or
     `AppealClaimContended` (nothing changed, press again) — and a call told
     to press again is retried here.

── WHAT IS REAL ────────────────────────────────────────────────────────────

The function bodies are the SHIPPED source, read out of `app/services/*.py`
by `ast` and executed as written — not copies. The Firestore client, the
transactions, their retries and their contention are the real
`google-cloud-firestore` against the emulator. What is replaced: the audit
writer (recorded in memory) and `firebase.firestore_client()` (the emulator
client). `app.*` is NOT imported, so no settings and no `.env` are read, and
there is no Mongo.

── SAFETY ──────────────────────────────────────────────────────────────────

Refuses to start unless FIRESTORE_EMULATOR_HOST is loopback, the project is a
`demo-` id and GOOGLE_APPLICATION_CREDENTIALS is unset. Metadata-server
detection is switched off. The Mac runner also puts the loopback-only network
guard (`outputs/phase0-isolation/netguard`) first on PYTHONPATH. Run from the
repository root with the backend's virtualenv:

    firebase emulators:exec --only firestore --project demo-zipper-crosssys \
        "backend/.venv/bin/python tests/crosssys/backend_transactions.crosssys.py"
"""

from __future__ import annotations

import os
import re
import sys

_LOOPBACK = re.compile(r"^(127\.0\.0\.1|localhost|\[::1\]):\d+$")
_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST", "")
_PROJECT = os.environ.get("GCLOUD_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
if not _LOOPBACK.match(_HOST) or not _PROJECT.startswith("demo-") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    print(f"CROSSSYS REFUSED: needs FIRESTORE_EMULATOR_HOST on loopback, a demo- project and no "
          f"GOOGLE_APPLICATION_CREDENTIALS (got host={_HOST or '-'}, project={_PROJECT or '-'})")
    sys.exit(2)
os.environ["METADATA_SERVER_DETECTION"] = "none"
os.environ.setdefault("GCE_METADATA_HOST", "127.0.0.1:9")
os.environ.setdefault("GCE_METADATA_IP", "127.0.0.1:9")

import ast  # noqa: E402
import asyncio  # noqa: E402
import logging  # noqa: E402
import secrets  # noqa: E402
import threading  # noqa: E402
import types  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from enum import Enum  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any, Callable  # noqa: E402

from google.cloud import firestore as gcf  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SERVICES = REPO / "backend" / "app" / "services"
COMPAT = REPO / "backend" / "app" / "core" / "compat.py"


def shipped(path: Path, *names: str) -> str:
    """The exact source of the named top-level definitions (and constants) in `path`."""
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    found = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = node.name
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
        else:
            continue
        if name in names:
            start = min([d.lineno for d in getattr(node, "decorator_list", [])] + [node.lineno])
            lines = src.splitlines()[start - 1:node.end_lineno]
            found[name] = "\n".join(lines)
    missing = [n for n in names if n not in found]
    if missing:
        raise SystemExit(f"CROSSSYS: {path.name} no longer defines {missing} — update this test")
    return "\n\n".join(found[n] for n in names)


client = gcf.Client(project=_PROJECT)
audit_records: list[dict] = []


async def _audit_record(**kw):
    audit_records.append(kw)
    return f"audit-{len(audit_records)}"


# One namespace with what the shipped functions reach for by name.
from firebase_admin import firestore as fa_firestore  # noqa: E402  (the module the services import)

NS: dict[str, Any] = {
    "__name__": "crosssys_shipped",
    "asyncio": asyncio, "logging": logging, "datetime": datetime, "timezone": timezone, "secrets": secrets,
    "Any": Any, "Callable": Callable, "Enum": Enum,
    "firestore": fa_firestore,
    "firebase": types.SimpleNamespace(firestore_client=lambda: client),
    "audit": types.SimpleNamespace(record=_audit_record),
    "log": logging.getLogger("crosssys"),
}
SOURCE = "\n\n".join([
    "from __future__ import annotations",
    shipped(COMPAT, "StrEnum"),
    shipped(REPO / "backend" / "app" / "db" / "firebase.py", "_single_error_kind", "transaction_error_kind",
            "is_transaction_contention"),
    shipped(SERVICES / "appeals.py", "AppealError", "APPEAL_CLAIM_CONTENDED", "AppealClaimContended",
            "APPEAL_CLAIM_UNKNOWN", "AppealClaimOutcomeUnknown",
            "AppealStatus", "Action", "_fs", "_auto_resolve_one"),
    shipped(SERVICES / "partner_ops.py", "PartnerOpsError", "HOST_MOVE_CONTENDED", "HOST_MOVE_UNKNOWN",
            "HostMoveContended", "HostMoveOutcomeUnknown", "_move_host"),
])
exec(compile(SOURCE, "crosssys-shipped-functions", "exec"), NS)  # noqa: S102
# The shipped functions call `firebase.transaction_error_kind` — the shipped one.
NS["firebase"].transaction_error_kind = NS["transaction_error_kind"]
NS["firebase"].is_transaction_contention = NS["is_transaction_contention"]
_move_host = NS["_move_host"]
HostMoveContended = NS["HostMoveContended"]
HostMoveOutcomeUnknown = NS["HostMoveOutcomeUnknown"]
AppealClaimContended = NS["AppealClaimContended"]
AppealClaimOutcomeUnknown = NS["AppealClaimOutcomeUnknown"]
#: HT-2 — "try again" results: aborted, or its outcome could not be established.
MOVE_RETRY = (HostMoveContended, HostMoveOutcomeUnknown)
CLAIM_RETRY = (AppealClaimContended, AppealClaimOutcomeUnknown)
_auto_resolve_one = NS["_auto_resolve_one"]

RUN = secrets.token_hex(4)
checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def doc(path: str) -> dict | None:
    snap = client.document(path).get()
    return snap.to_dict() if snap.exists else None


# ══════════════════════════════════════════════════════════════════════════════
print("\nC. Host-transfer contention — _move_host on the real emulator")


def seed_host(uid: str, agency: str, app_id: str) -> dict:
    client.document(f"users/{uid}").set({"name": "H", "isHost": True, "agencyId": agency})
    row = {"uid": uid, "name": "H", "agencyId": agency, "applicationId": app_id, "isActive": True}
    client.document(f"agencies/{agency}/agencyHosts/{uid}").set(row)
    client.document(f"hostVerification/{uid}").set({"agencyId": agency, "status": "verified"})
    client.document(f"hostApplications/{app_id}").set({"applicantUid": uid, "agencyId": agency, "status": "approved"})
    return row


def check_round(tag: str, uid: str, app_id: str, origin: str, movers: list, outcomes: list) -> None:
    """The business invariant, read back from the emulator.

    `movers[k]` is `(destination, now)` of the k-th call and `outcomes[k]` what
    it returned or raised. Each call passes its own `now`, so whose write
    landed is visible in the documents themselves.
    """
    ok(f"{tag}: every result is True, False, HostMoveContended or HostMoveOutcomeUnknown — nothing else escapes",
       all(o is True or o is False or isinstance(o, MOVE_RETRY) for o in outcomes), repr(outcomes))
    winners = [k for k, o in enumerate(outcomes) if o is True]
    ok(f"{tag}: at most one move reports success", len(winners) <= 1, repr(outcomes))
    places = sorted({origin, *(m[0] for m in movers)})
    user = doc(f"users/{uid}") or {}
    rows = [a for a in places if doc(f"agencies/{a}/agencyHosts/{uid}") is not None]
    ver = doc(f"hostVerification/{uid}") or {}
    app = doc(f"hostApplications/{app_id}") or {}
    if len(winners) == 1:
        target, at = movers[winners[0]]
        ok(f"{tag}: the Host is under the winner only", user.get("agencyId") == target, repr(user.get("agencyId")))
        ok(f"{tag}: …transferred from A, at the winner's time",
           user.get("agencyTransferredFrom") == origin and user.get("agencyTransferredAt") == at,
           repr((user.get("agencyTransferredFrom"), user.get("agencyTransferredAt"), at)))
        ok(f"{tag}: one roster row, the winner's", rows == [target], repr(rows))
        ok(f"{tag}: verification names the winner", ver.get("agencyId") == target, repr(ver.get("agencyId")))
        ok(f"{tag}: the application is stamped once, with the winner",
           app.get("transferredTo") == target and app.get("transferredAt") == at, repr(app.get("transferredTo")))
    elif not winners:
        ok(f"{tag}: no winner, so every call says try again (not applied / not confirmed)",
           all(isinstance(o, MOVE_RETRY) for o in outcomes), repr(outcomes))
        ok(f"{tag}: …and the Host is untouched under A",
           user.get("agencyId") == origin and "agencyTransferredFrom" not in user and rows == [origin]
           and ver.get("agencyId") == origin and "transferredTo" not in app, repr((user.get("agencyId"), rows)))


def race(n: int, rounds: int, label: str) -> dict:
    tally = {"wins": [0] * n, "false": 0, "contended": 0, "no_winner": 0}
    for i in range(rounds):
        uid, app_id = f"host-{RUN}-{label}{i}", f"app-{RUN}-{label}{i}"
        origin = f"A-{RUN}-{label}{i}"
        base = datetime.now(timezone.utc).replace(microsecond=0)
        movers = [(f"T{k}-{RUN}-{label}{i}", base + timedelta(seconds=k + 1)) for k in range(n)]
        row = seed_host(uid, origin, app_id)
        gate = threading.Barrier(n)
        result: list[Any] = [None] * n

        def move(k: int) -> None:
            gate.wait()
            try:
                result[k] = _move_host(dict(row), origin, movers[k][0], movers[k][1])
            except Exception as exc:  # noqa: BLE001 — recorded and asserted below
                result[k] = exc

        threads = [threading.Thread(target=move, args=(k,)) for k in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        tag = f"{n}-way round {i}"
        ok(f"{tag}: every move finished", not any(t.is_alive() for t in threads))
        check_round(tag, uid, app_id, origin, movers, result)
        for k, o in enumerate(result):
            tally["wins"][k] += o is True
        tally["false"] += sum(o is False for o in result)
        tally["contended"] += sum(isinstance(o, MOVE_RETRY) for o in result)
        tally["no_winner"] += not any(o is True for o in result)

        # "Try again": what HostMoveContended / HostMoveOutcomeUnknown tell the caller.
        final = list(result)
        for k, o in enumerate(result):
            if isinstance(o, MOVE_RETRY):
                try:
                    final[k] = _move_host(dict(row), origin, movers[k][0], movers[k][1])
                except Exception as exc:  # noqa: BLE001
                    final[k] = exc
        ok(f"{tag}: after trying again, exactly one move succeeded and every other call says False",
           sum(o is True for o in final) == 1 and all(o is True or o is False for o in final), repr(final))
        check_round(f"{tag} after retries", uid, app_id, origin, movers, final)
    print(f"   ({rounds} rounds of {n}: first-committer split {tally['wins']}; losers {tally['false']} False, "
          f"{tally['contended']} HostMoveContended; {tally['no_winner']} rounds with no winner)")
    return tally


race(2, 10, "p")   # an Owner transfer A→B against a revocation of A to C — the failed Mac configuration
race(5, 3, "q")    # five at once

# A move whose FROM is stale writes nothing.
uid, app_id = f"host-{RUN}-stale", f"app-{RUN}-stale"
seed_host(uid, f"X-{RUN}", app_id)
moved = _move_host({"uid": uid, "applicationId": app_id}, f"A-{RUN}-stale", f"B-{RUN}-stale", datetime.now(timezone.utc))
ok("a move from an agency the Host is no longer under is refused", moved is False)
ok("…and writes nothing", (doc(f"users/{uid}") or {}).get("agencyId") == f"X-{RUN}"
   and doc(f"agencies/B-{RUN}-stale/agencyHosts/{uid}") is None
   and "transferredTo" not in (doc(f"hostApplications/{app_id}") or {}))

# ══════════════════════════════════════════════════════════════════════════════
print("D. Appeal claim contention — _auto_resolve_one on the real emulator")


async def race_unban(snap, admins: list[dict]):
    return await asyncio.gather(*[
        _auto_resolve_one(client, snap, "subject-1", a, "unban", "Lifted by an administrator.") for a in admins
    ], return_exceptions=True)


for n in (2, 4):
    appeal_id = f"appeal-{RUN}-{n}"
    client.document(f"appeals/{appeal_id}").set({"status": "pending", "subjectUid": "subject-1", "kind": "ban"})
    snap = client.document(f"appeals/{appeal_id}").get()
    admins = [{"uid": f"admin-{k}", "name": f"Admin {k}", "role": "ops_admin"} for k in range(n)]
    before = len(audit_records)
    rs = asyncio.run(race_unban(snap, admins))
    tag = f"{n} Unbans at once"
    ok(f"{tag}: every result is a resolution, None, AppealClaimContended or AppealClaimOutcomeUnknown",
       all(isinstance(r, dict) or r is None or isinstance(r, CLAIM_RETRY) for r in rs), repr(rs))
    claimed = [r for r in rs if isinstance(r, dict)]
    ok(f"{tag}: at most one resolved it", len(claimed) <= 1, repr(rs))
    stored = doc(f"appeals/{appeal_id}") or {}
    if not claimed:
        ok(f"{tag}: nobody resolved it, so every call says try again",
           all(isinstance(r, CLAIM_RETRY) for r in rs), repr(rs))
        ok(f"{tag}: …the appeal is still pending and nothing was audited",
           stored.get("status") == "pending" and len(audit_records) == before, repr(stored.get("status")))
    # "Nothing changed — try again": a contended claim pressed again.
    final = list(rs)
    for k, r in enumerate(rs):
        if isinstance(r, CLAIM_RETRY):
            try:
                final[k] = asyncio.run(_auto_resolve_one(client, snap, "subject-1", admins[k], "unban", "Lifted."))
            except Exception as exc:  # noqa: BLE001
                final[k] = exc
    ok(f"{tag}: exactly one resolved it (after pressing again where told to)",
       sum(isinstance(r, dict) for r in final) == 1, repr(final))
    ok(f"{tag}: the others changed nothing (None)", sum(r is None for r in final) == n - 1, repr(final))
    stored = doc(f"appeals/{appeal_id}") or {}
    ok(f"{tag}: the appeal is resolved", stored.get("status") == "resolved", repr(stored.get("status")))
    ok(f"{tag}: ONE audit entry", len(audit_records) - before == 1, str(len(audit_records) - before))
    ok(f"{tag}: …naming the admin the document names",
       len(audit_records) > before
       and audit_records[-1]["actor"]["uid"] == stored.get("resolvedBy")
       and stored.get("resolvedBy") in {a["uid"] for a in admins},
       repr((stored.get("resolvedBy"), audit_records[-1]["actor"] if len(audit_records) > before else None)))
    print(f"   ({tag}: {[type(r).__name__ if not isinstance(r, dict) else 'resolved' for r in rs]})")

appeal_id = f"appeal-{RUN}-decided"
client.document(f"appeals/{appeal_id}").set({"status": "pending", "subjectUid": "subject-1", "kind": "ban"})
stale_snap = client.document(f"appeals/{appeal_id}").get()                 # read while pending
client.document(f"appeals/{appeal_id}").update({"status": "upheld"})       # a reviewer decided first
before = len(audit_records)
r = asyncio.run(_auto_resolve_one(client, stale_snap, "subject-1", {"uid": "admin-z"}, "unban", "Lifted."))
ok("an Unban racing a reviewer's decision leaves the decision alone", r is None
   and (doc(f"appeals/{appeal_id}") or {}).get("status") == "upheld")
ok("…and audits nothing", len(audit_records) == before)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} cross-system checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    print(f"CROSSSYS-BACKEND-RESULT checks={checks} failed={len(failures)}")
    sys.exit(1)
print(f"All {checks} cross-system backend checks passed.")
print(f"CROSSSYS-BACKEND-RESULT checks={checks} failed=0")
