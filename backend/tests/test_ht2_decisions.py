"""HT-2 — decisions under Firestore failure: recorded once, never misreported.

── WHY ─────────────────────────────────────────────────────────────────────

The client re-sends a commit on UNAVAILABLE / RESOURCE_EXHAUSTED, and a
re-sent commit of an applied transaction can come back as an error — ABORTED
makes the library run the callback AGAIN on the state it just committed. So an
error never proves that nothing committed, and a compare-and-set callback that
cannot recognise its own earlier commit reports "lost" for a write it made.

What that did to the decision lease (`firebase.claim_decision` /
`complete_decision` / `release_decision`) and its callers:

  * a claim whose answer was lost found its OWN lease → "Somebody else is
    deciding this" (blocked for two minutes);
  * a stamp whose answer was lost found the lease gone → False → "changed while
    it was being decided": the decision WAS recorded, but the audit, the
    application lock release and the notice were skipped;
  * a stamp that raised (retry exhaustion, a deadline) escaped as a 500 with the
    lease held — and for Host ACTIVATION, the role already granted: every later
    check was refused by the role table ("You are already a Host"), so the
    application stayed `awaiting_verification` for good, with no approval audit;
  * Host activation also audited an approval when the stamp came back False;
  * `release_decision` swallowed every failure;
  * HT-1's two sites (`_move_host`, `_auto_resolve_one`) reported a move or a
    resolution whose answer was lost as lost to somebody else.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  1. the lease primitives: a claim / stamp whose answer was lost is recognised;
     a stamp that is not visible after an error raises `DecisionNotRecorded`
     (never "nothing happened"); a late-landing stamp is recognised by the
     retry; recognition needs the token AND the decided status; release says
     what happened;
  2. Host activation, asserting the final role, decision, lease and audit state
     each time: a lost answer; an applied-then-deadline stamp; a stamp that
     never lands (the role started, `recorded: false`, lease released, no
     approval audit — and the next check finishes it WITHOUT granting again); a
     stamp that may land late; a grant interrupted mid-way (roster repaired,
     grant audited once); a stamp taken over by another decision;
  3. the KYC decision and 4. the appeal decision: a lost answer is a recorded
     decision with its audit, lock release / reversal and notice exactly once;
     a stamp that never lands is a typed 409 with the lease released, and
     deciding again converges with nothing applied twice;
  5. HT-1's sites: a move / a resolution whose answer was lost is reported as
     the move / resolution it is.

REAL: `app.db.firebase` (lease, classification), `users` (activation, KYC
      decision, grant), `appeals`, `partner_ops._move_host`,
      `transfer_requests`, and the library's own retry loop
      (`tests/firestore_contention`, from the installed, pinned
      google-cloud-firestore).
FAKE: Firestore = `tests/fakes_tx.TxFirestore` (FakeFirestore's documents and
      queries; faithful transactions with scripted failures); Mongo
      (`harness.FakeDb`); audit, notices and Firebase Auth are recorders.

Service-level tests against an in-memory model — NOT end-to-end.

    python3 -m tests.test_ht2_decisions
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

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


from tests.harness import FakeDb, auth_record, install_stubs  # noqa: E402

install_stubs()

from tests.fakes_tx import TxFirestore, defer, lose_answer  # noqa: E402
from tests.firestore_contention import Aborted, DeadlineExceeded, acting  # noqa: E402

import app.db.mongo as mongo  # noqa: E402

db = FakeDb()
fs = TxFirestore()
mongo.get_db = lambda: db  # type: ignore[assignment]


class _Tx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class _Session(_Tx):
    def start_transaction(self):
        return _Tx()


class _Client:
    async def start_session(self):
        return _Session()


mongo.get_client = lambda: _Client()  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

AUDIT: list[dict] = []


async def fake_audit(**kw):
    audit_mod._entry(**{k: kw.get(k) for k in (
        "actor", "action", "subject_type", "subject_id", "reason", "before", "after", "card_id", "meta")})
    AUDIT.append({**kw, "id": f"audit-{len(AUDIT) + 1}"})
    return f"audit-{len(AUDIT)}"


async def fake_history_for(subject_type: str, subject_id: str, limit: int = 200) -> list[dict]:
    return [{"action": a["action"], "meta": a.get("meta") or {}, "id": a["id"]}
            for a in reversed(AUDIT) if a.get("subject_type") == subject_type and a.get("subject_id") == subject_id]


audit_mod.record = fake_audit
audit_mod.history_for = fake_history_for
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
AUTH: dict[str, object] = {}
firebase_mod.get_user = lambda uid: AUTH.get(uid)  # type: ignore[assignment]
firebase_mod.get_user_by_phone = lambda p: next(  # type: ignore[assignment]
    (r for r in AUTH.values() if getattr(r, "phone_number", "") == p), None)
firebase_mod.get_user_by_email = lambda e: next(  # type: ignore[assignment]
    (r for r in AUTH.values() if str(getattr(r, "email", "") or "").lower() == str(e or "").lower()), None)

from app.services import appeals as appeals_svc  # noqa: E402
from app.services import notices as notices_mod  # noqa: E402
from app.services import partner_activation as activation  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import role_appeals  # noqa: E402
from app.services import transfer_requests as transfers  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, apps, users_svc, activation):
    if hasattr(mod, "get_db"):
        mod.get_db = lambda: db  # type: ignore[assignment]

NOTICES: list[tuple] = []


async def _notice(name, *args, **kw):
    NOTICES.append((name, args[0] if args else kw.get("uid")))
    return True


notices_mod.host_application_approved = lambda uid, app_id: _notice("host_approved", uid)
notices_mod.host_application_rejected = lambda uid, app_id, reason="": _notice("host_rejected", uid)
notices_mod.partner_transferred = lambda uid, *a, **k: _notice("transferred", uid)
LOCK_RELEASES: list[tuple] = []
_real_release_lock = apps.release_host_application_lock


async def _release_lock(applicant_uid, application_id):
    LOCK_RELEASES.append((applicant_uid, application_id))
    return await _real_release_lock(applicant_uid, application_id)


apps.release_host_application_lock = _release_lock


async def _owners(**kw):
    return {"sent": 1}


role_appeals.email_owners = _owners
apps.is_unverified_guest = lambda uid: False
logging.disable(logging.CRITICAL)
run = asyncio.run

LEASE = firebase_mod.DECISION_LEASE_FIELD
TOKEN_FIELD = getattr(firebase_mod, "DECISION_TOKEN_FIELD", "decisionToken")
DecisionNotRecorded = getattr(firebase_mod, "DecisionNotRecorded", None)
DecisionNotRecordedError = getattr(users_svc, "DecisionNotRecordedError", None)
AppealDecisionNotRecorded = getattr(appeals_svc, "AppealDecisionNotRecorded", None)

STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None,
           "service_credential": "partner-registration"}
WHY = "Documents checked against the originals."
HOST_FORM = {
    "hostName": "H", "age": "24", "country": "India", "callRate": "10",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"], "photoUrl": ["https://x/p"],
}


def attempt(coro_fn, label: str, *args):
    """Run `coro_fn(*args)` as `label`; the result, or the exception it raised."""
    try:
        return acting(label, run, coro_fn(*args))
    except Exception as exc:  # noqa: BLE001 — returned and asserted on
        return exc


def show(x) -> str:
    return repr(x) if isinstance(x, Exception) else str(x)


# ── Which transaction is which, by what it writes (the same before and after HT-2) ──


def _updates(tx) -> list[dict]:
    return [data for op, _doc, data, _m in tx._writes if op == "update" and isinstance(data, dict)]


def is_stamp(tx) -> bool:
    """A decision stamp: the status and the lease's removal, in one update."""
    return any("status" in d and LEASE in d for d in _updates(tx))


def is_claim(tx) -> bool:
    return any(isinstance(d.get(LEASE), dict) for d in _updates(tx))


def only(pred, hook):
    """A hook that acts only on the transactions `pred` picks."""
    def wrapped(tx, *rest):
        if pred(tx):
            hook(tx, *rest)
    return wrapped


def once(hook):
    """A hook that acts on its first call only."""
    fired: list[int] = []

    def wrapped(tx, *rest):
        if not fired:
            fired.append(1)
            hook(tx, *rest)
    return wrapped


#: every scripted failure that actually fired: (label, what)
FIRED: list[tuple] = []


def always(error):
    def hook(tx, *rest):
        err = error()
        FIRED.append((tx.label, type(err).__name__))
        raise err
    return hook


def defer_rec(error):
    inner = defer(error)

    def hook(tx, *rest):
        FIRED.append((tx.label, "deferred"))
        inner(tx)
    return hook


def really(where: str) -> None:
    """The scripted failure of the case just run DID fire — no case passes vacuously."""
    ok(f"the scripted failure really fired ({where})", bool(FIRED), "nothing was injected")
    FIRED.clear()


def actions(subject_id: str, action: str) -> list[dict]:
    return [a for a in AUDIT if a.get("subject_id") == subject_id and a.get("action") == action]


def activation_approvals(app_id: str) -> list[dict]:
    """The approvals an ACTIVATION audits (the Owner's earlier approval is audited too)."""
    return [a for a in actions(app_id, audit_mod.Action.HOST_APPLICATION_APPROVED)
            if (a.get("meta") or {}).get("activation") == "contacts_verified"]


def injected(kind: str, label: str) -> int:
    """How many scripted failures actually hit `label` — so no case passes vacuously."""
    return len([e for e in fs.events if e[0] == kind and e[1] == label])


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False,
                                        "isProfileComplete": True, **over}


def auth(uid: str, *, phone: str = "", email: str = "", verified: bool = False) -> None:
    AUTH[uid] = auth_record(uid, phone=phone, email=email, email_verified=verified)


# A live main agency for hosts to hang under (both contacts verified).
user("own-main")
auth("own-main", phone="+919700000001", email="main@x.test", verified=True)
fs.collection("agencies").docs["MAIN1"] = {
    "agencyName": "Main One", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "own-main", "crmUid": "own-main", "source": "self_signup",
}
run(ops.ensure_partner_record("MAIN1", SERVICE, "Registered."))
run(ops.approve_partner("MAIN1", WHY, STAFF))
user("own-main2")
auth("own-main2", phone="+919700000002", email="main2@x.test", verified=True)
fs.collection("agencies").docs["MAIN2"] = {
    "agencyName": "Main Two", "type": "main", "status": "pending", "kycStatus": "submitted",
    "ownerUid": "own-main2", "crmUid": "own-main2", "source": "self_signup",
}
run(ops.ensure_partner_record("MAIN2", SERVICE, "Registered."))
run(ops.approve_partner("MAIN2", WHY, STAFF))

_n = iter(range(1, 10**6))


def waiting_host() -> tuple[str, str]:
    """A Host self-application the Owner approved while the email was missing — now verified."""
    n = next(_n)
    uid = f"HOST-{n}"
    user(uid)
    auth(uid, phone=f"+91800000{n:04d}")
    app_id = run(apps.submit_host_application(uid, dict(HOST_FORM), "MAIN1", SERVICE))["id"]
    run(users_svc.decide_host_application(app_id, True, WHY, OWNER))
    AUTH[uid].email, AUTH[uid].email_verified = f"{uid.lower()}@x.test", True
    return uid, app_id


def app_doc(app_id: str) -> dict:
    return fs.collection("hostApplications").docs.get(app_id) or {}


def roster_rows(uid: str) -> int:
    return int(uid in fs.collection("agencies").document("MAIN1").collection("agencyHosts").docs)


def activation_state(tag: str, uid: str, app_id: str, *, recorded: bool, grants: int = 1,
                     approvals: int | None = None) -> None:
    """The final role, decision, lease and audit state — the invariant of every case."""
    doc = app_doc(app_id)
    eq(f"{tag}: the account is a Host", fs.collection("users").docs[uid].get("isHost"), True)
    eq(f"{tag}: …granted once (HOST_GRANTED audits)", len(actions(uid, audit_mod.Action.HOST_GRANTED)), grants)
    eq(f"{tag}: …on the roster", roster_rows(uid), 1)
    eq(f"{tag}: the application status", doc.get("status"), "approved" if recorded else "awaiting_verification")
    ok(f"{tag}: no decision lease left behind", LEASE not in doc, repr(doc.get(LEASE)))
    eq(f"{tag}: approval audits (the activation's)", len(activation_approvals(app_id)),
       (1 if recorded else 0) if approvals is None else approvals)


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The lease primitives")

fs.collection("probe").docs["p1"] = {"status": "pending"}
ref = fs.collection("probe").document("p1")
fs.after_commit["c1"] = only(is_claim, once(always(lambda: Aborted("409 transaction no longer valid"))))
tok = attempt(lambda: asyncio.to_thread(firebase_mod.claim_decision, ref, expected_status="pending",
                                        actor_uid="me"), "c1")
fs.clear_hooks()
really("line 375")
ok("a claim whose answer was lost HAS the lease (it used to be refused by its own lease)",
   isinstance(tok, str) and (fs.collection("probe").docs["p1"].get(LEASE) or {}).get("token") == tok, show(tok))

fs.after_commit["s1"] = only(is_stamp, once(always(lambda: Aborted("409 transaction no longer valid"))))
done = attempt(lambda: asyncio.to_thread(firebase_mod.complete_decision, ref, tok, {"status": "decided"},
                                         expected_status="pending"), "s1")
fs.clear_hooks()
really("line 382")
eq("a stamp whose answer was lost is RECORDED (True; it used to come back False)", done, True)
eq("…the document is decided, with this lease's token", (fs.collection("probe").docs["p1"].get("status"),
   fs.collection("probe").docs["p1"].get(TOKEN_FIELD)), ("decided", tok))
eq("…and the stamp landed once", len([e for e in fs.events_of("commit", "s1") if e[3]]), 1)

fs.collection("probe").docs["p2"] = {"status": "pending"}
ref2 = fs.collection("probe").document("p2")
tok2 = acting("c2", firebase_mod.claim_decision, ref2, expected_status="pending", actor_uid="me")
fs.after_commit["s2"] = only(is_stamp, once(always(lambda: DeadlineExceeded("504"))))
done = attempt(lambda: asyncio.to_thread(firebase_mod.complete_decision, ref2, tok2, {"status": "decided"},
                                         expected_status="pending"), "s2")
fs.clear_hooks()
really("line 394")
eq("a stamp applied but answered with a deadline: verified by reading it again → True", done, True)

fs.collection("probe").docs["p3"] = {"status": "pending"}
ref3 = fs.collection("probe").document("p3")
tok3 = acting("c3", firebase_mod.claim_decision, ref3, expected_status="pending", actor_uid="me")
fs.on_commit["s3"] = only(is_stamp, defer_rec(lambda: DeadlineExceeded("504")))
out = attempt(lambda: asyncio.to_thread(firebase_mod.complete_decision, ref3, tok3, {"status": "decided"},
                                        expected_status="pending"), "s3")
fs.clear_hooks()
really("line 403")
ok("a stamp that is not visible after a deadline: DecisionNotRecorded('unknown'), not 'nothing happened'",
   DecisionNotRecorded is not None and isinstance(out, DecisionNotRecorded) and out.outcome == "unknown",
   show(out))
eq("…the lease is still ours, nothing decided yet", (fs.collection("probe").docs["p3"].get("status"),
   (fs.collection("probe").docs["p3"].get(LEASE) or {}).get("token")), ("pending", tok3))
eq("the stamp then lands late", fs.land_deferred(), [True])
done = acting("s3b", firebase_mod.complete_decision, ref3, tok3, {"status": "decided"}, expected_status="pending")
eq("…and completing again recognises it (True, written once)", (done, len(fs.events_of("commit", "s3b"))),
   (True, 1))
ok("…the retry wrote nothing", all(not e[3] for e in fs.events_of("commit", "s3b")))

fs.collection("probe").docs["p4"] = {"status": "pending"}
ref4 = fs.collection("probe").document("p4")
tok4 = acting("c4", firebase_mod.claim_decision, ref4, expected_status="pending", actor_uid="me")
fs.on_commit["s4"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(lambda: asyncio.to_thread(firebase_mod.complete_decision, ref4, tok4, {"status": "decided"},
                                        expected_status="pending"), "s4")
fs.clear_hooks()
really("line 421")
ok("a stamp Firestore kept aborting: DecisionNotRecorded('not_applied'), chained to the library's error",
   DecisionNotRecorded is not None and isinstance(out, DecisionNotRecorded) and out.outcome == "not_applied"
   and isinstance(out.__cause__, ValueError), show(out))

# Recognition needs the decided status too: a forged token on an undecided document is not "recorded".
fs.collection("probe").docs["p5"] = {"status": "pending"}
ref5 = fs.collection("probe").document("p5")
tok5 = acting("c5", firebase_mod.claim_decision, ref5, expected_status="pending", actor_uid="me")
fs.collection("probe").docs["p5"][TOKEN_FIELD] = tok5  # somebody copied the lease token across
done = acting("s5", firebase_mod.complete_decision, ref5, tok5, {"status": "decided"}, expected_status="pending")
eq("a token without the decided status is not taken as recorded — the stamp is written",
   (done, fs.collection("probe").docs["p5"].get("status")), (True, "decided"))

# Contended / unknown claims.
fs.collection("probe").docs["p6"] = {"status": "pending"}
ref6 = fs.collection("probe").document("p6")
fs.on_commit["c6"] = only(is_claim, always(lambda: Aborted("409")))
out = attempt(lambda: asyncio.to_thread(firebase_mod.claim_decision, ref6, expected_status="pending",
                                        actor_uid="me"), "c6")
fs.on_commit["c7"] = only(is_claim, always(lambda: DeadlineExceeded("504")))
out2 = attempt(lambda: asyncio.to_thread(firebase_mod.claim_decision, ref6, expected_status="pending",
                                         actor_uid="me"), "c7")
fs.clear_hooks()
really("line 444")
eq("a claim Firestore kept aborting: DecisionConflict('contended')",
   (type(out).__name__, getattr(out, "reason", None)), ("DecisionConflict", "contended"))
eq("a claim answered with a deadline, not visible: DecisionConflict('unknown')",
   (type(out2).__name__, getattr(out2, "reason", None)), ("DecisionConflict", "unknown"))
ok("…neither left a lease", LEASE not in fs.collection("probe").docs["p6"])

# Release says what happened.
fs.collection("probe").docs["p7"] = {"status": "pending"}
ref7 = fs.collection("probe").document("p7")
tok7 = acting("c8", firebase_mod.claim_decision, ref7, expected_status="pending", actor_uid="me")
eq("release of a lease we hold → released", acting("r1", firebase_mod.release_decision, ref7, tok7), "released")
eq("release of a lease we do not hold → not_held", acting("r2", firebase_mod.release_decision, ref7, tok7),
   "not_held")
tok7b = acting("c9", firebase_mod.claim_decision, ref7, expected_status="pending", actor_uid="me")
fs.on_commit["r3"] = always(lambda: DeadlineExceeded("504"))
LOGGED: list[str] = []


class _Grab(logging.Handler):
    def emit(self, record):
        LOGGED.append(f"{record.levelname} {record.getMessage()}")


logging.disable(logging.NOTSET)
_handler = _Grab(level=logging.ERROR)
logging.getLogger("app.db.firebase").addHandler(_handler)
got = acting("r3", firebase_mod.release_decision, ref7, tok7b)
logging.getLogger("app.db.firebase").removeHandler(_handler)
logging.disable(logging.CRITICAL)
fs.clear_hooks()
really("line 474")
eq("release that fails → failed (it used to be swallowed)", got, "failed")
ok("…logged as an ERROR, with how long the lease lasts", any(m.startswith("ERROR") and "lapses" in m for m in LOGGED),
   repr(LOGGED))
fs.after_commit["r4"] = always(lambda: DeadlineExceeded("504"))
eq("release whose answer was lost → released (read again)", acting("r4", firebase_mod.release_decision, ref7, tok7b),
   "released")
fs.clear_hooks()
really("line 481")

# ══════════════════════════════════════════════════════════════════════════════
print("2. Host activation — the role, the decision, the lease and the audit, every time")

uid, app_id = waiting_host()
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
eq("baseline: activated and recorded", [(r.get("activated"), r.get("recorded")) for r in out], [(True, True)])
activation_state("baseline", uid, app_id, recorded=True)

uid, app_id = waiting_host()
fs.after_commit["act"] = only(is_stamp, once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
fs.clear_hooks()
really("line 494")
print(f"   stamp answer lost → {show(out)[:160]}")
eq("stamp answer lost: activated AND recorded (it used to say activated: False)",
   [(r.get("activated"), r.get("recorded")) for r in out] if isinstance(out, list) else show(out), [(True, True)])
activation_state("stamp answer lost", uid, app_id, recorded=True)

uid, app_id = waiting_host()
fs.after_commit["act"] = only(is_stamp, once(always(lambda: DeadlineExceeded("504"))))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
fs.clear_hooks()
really("line 503")
print(f"   stamp applied, deadline → {show(out)[:160]}")
eq("stamp applied but answered with a deadline: verified, recorded (it used to raise)",
   [(r.get("activated"), r.get("recorded")) for r in out] if isinstance(out, list) else show(out), [(True, True)])
activation_state("stamp applied, deadline", uid, app_id, recorded=True)

uid, app_id = waiting_host()
fs.on_commit["act"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
fs.clear_hooks()
really("line 512")
print(f"   stamp never lands → {show(out)[:200]}")
ok("stamp never lands: an explicit result — the role started, the application not yet recorded",
   isinstance(out, list) and [(r.get("activated"), r.get("recorded"), r.get("pending_completion"),
                               r.get("outcome")) for r in out] == [(True, False, True, "not_applied")], show(out))
ok("…saying the next check finishes it and nothing is granted twice",
   isinstance(out, list) and "next check" in str(out[0].get("detail")), show(out))
activation_state("stamp never lands", uid, app_id, recorded=False)
out = attempt(users_svc.activate_host_if_verified, "act2", uid, activation.activation_actor(uid))
eq("the next check finishes it", [(r.get("activated"), r.get("recorded"), r.get("resumed")) for r in out]
   if isinstance(out, list) else show(out), [(True, True, True)])
activation_state("…after the next check", uid, app_id, recorded=True)
ok("…the approval audit says it resumed an interrupted activation",
   [bool((a.get("meta") or {}).get("resumed_after_interruption")) for a in activation_approvals(app_id)] == [True])
started = run(activation.check_and_activate(uid, activation.activation_actor(uid)))["started"]
eq("…and a third check has nothing to do", started, [])

uid, app_id = waiting_host()
fs.on_commit["act"] = only(is_stamp, defer_rec(lambda: DeadlineExceeded("504")))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
fs.clear_hooks()
really("line 532")
ok("stamp unknown (may land late): role started, recorded False, outcome 'unknown'",
   isinstance(out, list) and [(r.get("activated"), r.get("recorded"), r.get("outcome")) for r in out]
   == [(True, False, "unknown")], show(out))
eq("…the late stamps cannot land over the released lease", fs.land_deferred(), [False, False])
activation_state("stamp unknown", uid, app_id, recorded=False)
out = attempt(users_svc.activate_host_if_verified, "act2", uid, activation.activation_actor(uid))
activation_state("…after the next check", uid, app_id, recorded=True)

# The grant interrupted after its batch (the roster write failed).
uid, app_id = waiting_host()
roster_col = fs.collection("agencies").document("MAIN1").collection("agencyHosts")
roster_col.fail_on("set", uid, RuntimeError("503 roster unavailable"))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
roster_col.clear_failures()
ok("a grant interrupted after its batch raises (as before)", isinstance(out, Exception), show(out))
eq("…the account IS a Host, the roster row is missing, the application waits",
   (fs.collection("users").docs[uid].get("isHost"), roster_rows(uid), app_doc(app_id).get("status")),
   (True, 0, "awaiting_verification"))
out = attempt(users_svc.activate_host_if_verified, "act2", uid, activation.activation_actor(uid))
print(f"   next check after an interrupted grant → {show(out)[:160]}")
eq("the next check finishes it (it used to be refused: 'You are already a Host')",
   [(r.get("activated"), r.get("recorded")) for r in out] if isinstance(out, list) else show(out), [(True, True)])
activation_state("interrupted grant, finished", uid, app_id, recorded=True)
ok("…the roster row was repaired and the grant audited once",
   (out[0].get("account") or {}).get("roster_repaired") is True if isinstance(out, list) else False, show(out))

# Another decision took the application over (the lease lapsed and was claimed).
uid, app_id = waiting_host()


def _take_over(tx) -> None:
    FIRED.append((tx.label, "take-over"))
    fs.collection("hostApplications").docs[app_id][LEASE] = {"token": "someone-else", "by": "x", "at": None}


fs.on_commit["act"] = only(is_stamp, once(_take_over))
out = attempt(users_svc.activate_host_if_verified, "act", uid, activation.activation_actor(uid))
fs.clear_hooks()
really("line 570")
ok("stamp taken over: role started, recorded False, conflict — and NO approval audit",
   isinstance(out, list) and [(r.get("activated"), r.get("recorded"), r.get("conflict")) for r in out]
   == [(True, False, True)], show(out))
eq("…no approval audited for an application that is not recorded as approved",
   len(activation_approvals(app_id)), 0)
fs.collection("hostApplications").docs[app_id].pop(LEASE, None)

uid, app_id = waiting_host()
fs.on_commit["act"] = only(is_stamp, always(lambda: Aborted("409")))
res = attempt(activation.check_and_activate, "act", uid, activation.activation_actor(uid))
started = res["started"] if isinstance(res, dict) else [{"error": show(res)}]
fs.clear_hooks()
really("line 581")
ok("check_and_activate passes 'recorded: false' and the sentence through to the app",
   [(s.get("activated"), s.get("recorded"), bool(s.get("detail"))) for s in started] == [(True, False, True)],
   repr(started))

# ══════════════════════════════════════════════════════════════════════════════
print("3. The KYC decision")


def kyc_app() -> tuple[str, str]:
    n = next(_n)
    uid = f"KYC-{n}"
    user(uid)
    auth(uid, phone=f"+91700000{n:04d}", email=f"kyc{n}@x.test", verified=True)
    return uid, run(apps.submit_host_application(uid, dict(HOST_FORM), "MAIN1", SERVICE))["id"]


uid, app_id = kyc_app()
fs.after_commit["kyc"] = only(is_stamp, once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(users_svc.decide_host_application, "kyc", app_id, True, WHY, STAFF)
fs.clear_hooks()
really("line 601")
print(f"   KYC stamp answer lost → {show(out)[:140]}")
ok("KYC stamp answer lost: the decision is reported, not 'changed while being decided'",
   not isinstance(out, Exception), show(out))
eq("…recorded approved, no lease", (app_doc(app_id).get("status"), LEASE in app_doc(app_id)), ("approved", False))
eq("…decision audited once, lock released once, applicant told once",
   (len(actions(app_id, audit_mod.Action.HOST_APPLICATION_APPROVED)),
    LOCK_RELEASES.count((uid, app_id)), NOTICES.count(("host_approved", uid))), (1, 1, 1))

uid, app_id = kyc_app()
fs.on_commit["kyc"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(users_svc.decide_host_application, "kyc", app_id, True, WHY, STAFF)
fs.clear_hooks()
really("line 613")
ok("KYC stamp never lands: DecisionNotRecordedError, 409, saying to decide again",
   DecisionNotRecordedError is not None and isinstance(out, DecisionNotRecordedError)
   and out.status_code == 409 and "Decide it again" in str(out), show(out))
eq("…the account is a Host, the application still pending, no lease",
   (fs.collection("users").docs[uid].get("isHost"), app_doc(app_id).get("status"), LEASE in app_doc(app_id)),
   (True, "pending", False))
out = attempt(users_svc.decide_host_application, "kyc2", app_id, True, WHY, STAFF)
ok("deciding again converges", not isinstance(out, Exception), show(out))
eq("…recorded approved; granted ONCE; decision audited once",
   (app_doc(app_id).get("status"), len(actions(uid, audit_mod.Action.HOST_GRANTED)),
    len(actions(app_id, audit_mod.Action.HOST_APPLICATION_APPROVED))), ("approved", 1, 1))

# ══════════════════════════════════════════════════════════════════════════════
print("4. The appeal decision")

MOD = lambda u: {"uid": u, "name": u, "role": "app_admin", "team": "app"}  # noqa: E731


def banned_with_appeal() -> tuple[str, str]:
    n = next(_n)
    uid, aid = f"BAN-{n}", f"apl-{n}"
    user(uid, isBanned=True, accountState="banned", bannedBy="mod-x")
    fs.collection("appeals").docs[aid] = {"subjectUid": uid, "status": "pending", "kind": "ban"}
    return uid, aid


uid, aid = banned_with_appeal()
fs.after_commit["apl"] = only(is_stamp, once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(appeals_svc.decide_appeal, "apl", aid, "overturned", "The ban was on the wrong account.", MOD("mod-z"))
fs.clear_hooks()
really("line 643")
ok("appeal stamp answer lost: the verdict is reported (it used to be 'decided or closed meanwhile')",
   not isinstance(out, Exception), show(out))
eq("…overturned, account active, verdict audited once, unbanned once",
   (fs.collection("appeals").docs[aid].get("status"), fs.collection("users").docs[uid].get("accountState"),
    len(actions(uid, appeals_svc.Action.APPEAL_OVERTURNED)), len(actions(uid, audit_mod.Action.USER_UNBANNED))),
   ("overturned", "active", 1, 1))

uid, aid = banned_with_appeal()
fs.on_commit["apl"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(appeals_svc.decide_appeal, "apl", aid, "overturned", "The ban was on the wrong account.", MOD("mod-z"))
fs.clear_hooks()
really("line 654")
ok("appeal stamp never lands: AppealDecisionNotRecorded, 409, saying to decide again",
   AppealDecisionNotRecorded is not None and isinstance(out, AppealDecisionNotRecorded)
   and out.status_code == 409 and "Decide it again" in str(out), show(out))
eq("…the ban IS lifted, the appeal still pending, no lease",
   (fs.collection("users").docs[uid].get("accountState"), fs.collection("appeals").docs[aid].get("status"),
    LEASE in fs.collection("appeals").docs[aid]), ("active", "pending", False))
out = attempt(appeals_svc.decide_appeal, "apl2", aid, "overturned", "The ban was on the wrong account.", MOD("mod-z"))
ok("deciding again converges", not isinstance(out, Exception), show(out))
eq("…overturned; unbanned ONCE; verdict audited once",
   (fs.collection("appeals").docs[aid].get("status"), len(actions(uid, audit_mod.Action.USER_UNBANNED)),
    len(actions(uid, appeals_svc.Action.APPEAL_OVERTURNED))), ("overturned", 1, 1))

# ══════════════════════════════════════════════════════════════════════════════
print("5. HT-1's sites — a move / a resolution whose answer was lost")


def is_move(tx) -> bool:
    return any(op == "set" and isinstance(data, dict) and "transferredFrom" in data
               for op, _d, data, _m in tx._writes)


uid, app_id = waiting_host()
run(users_svc.activate_host_if_verified(uid, activation.activation_actor(uid)))
row = dict(fs.collection("agencies").document("MAIN1").collection("agencyHosts").docs[uid], uid=uid)
fs.after_commit["mv"] = only(is_move, once(always(lambda: Aborted("409 transaction no longer valid"))))
moved = attempt(lambda: asyncio.to_thread(ops._move_host, row, "MAIN1", "MAIN2", users_svc.datetime.now(
    users_svc.timezone.utc)), "mv")
fs.clear_hooks()
really("line 682")
eq("a move whose answer was lost is the move (True; it used to be False, 'another move won')", moved, True)
eq("…the host is under MAIN2", fs.collection("users").docs[uid].get("agencyId"), "MAIN2")

uid, app_id = waiting_host()
run(users_svc.activate_host_if_verified(uid, activation.activation_actor(uid)))
row = dict(fs.collection("agencies").document("MAIN1").collection("agencyHosts").docs[uid], uid=uid)
fs.after_commit["mv2"] = only(is_move, once(always(lambda: DeadlineExceeded("504"))))
moved = attempt(lambda: asyncio.to_thread(ops._move_host, row, "MAIN1", "MAIN2", users_svc.datetime.now(
    users_svc.timezone.utc)), "mv2")
fs.clear_hooks()
really("line 692")
eq("a move applied but answered with a deadline: verified → True (it used to raise)", moved, True)

# Through the Owner's decision: approved, the host told once.
uid, app_id = waiting_host()
run(users_svc.activate_host_if_verified(uid, activation.activation_actor(uid)))
db.seed("staff", [{"uid": "owner-1", "role": "owner", "is_active": True, "email": "o@x.test", "name": "Owner"}])
req = run(transfers.request("host", uid, "MAIN2", "The host asked to move; both agreed.", STAFF))["request"]["id"]
fs.after_commit["own"] = only(is_move, once(always(lambda: Aborted("409 transaction no longer valid"))))
out = attempt(transfers.decide, "own", req, True, "The host asked to move; both agreed.", OWNER)
fs.clear_hooks()
really("line 702")
ok("an Owner's transfer whose move answer was lost is APPROVED (it used to be 'the host moved meanwhile')",
   isinstance(out, dict) and out["request"]["status"] == "approved", show(out))
eq("…and the host is told once", NOTICES.count(("transferred", uid)), 1)

# The appeal claim (auto-resolve on unban).
n = next(_n)
fs.collection("appeals").docs[f"auto-{n}"] = {"subjectUid": "subj", "status": "pending", "kind": "ban"}
snap = fs.collection("appeals").document(f"auto-{n}").get()
fs.after_commit["ar"] = only(lambda tx: bool(tx._writes), once(always(lambda: Aborted("409 transaction no longer valid"))))
res = attempt(appeals_svc._auto_resolve_one, "ar", fs, snap, "subj", MOD("mod-q"), "unban", "Lifted.")
fs.clear_hooks()
really("line 713")
ok("an appeal claim whose answer was lost is the resolution (it used to be None, with no audit)",
   isinstance(res, dict) and res.get("status") == "resolved", show(res))
eq("…audited once", len([a for a in AUDIT if a.get("subject_id") == f"auto-{n}"
                         and a.get("action") == appeals_svc.Action.APPEAL_AUTO_RESOLVED]), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("6. Review findings")
from tests.firestore_contention import ServiceUnavailable  # noqa: E402

# R5 — a release whose answer was lost (the library re-runs it) says released.
fs.collection("probe").docs["p9"] = {"status": "pending"}
ref9 = fs.collection("probe").document("p9")
tok9 = acting("c10", firebase_mod.claim_decision, ref9, expected_status="pending", actor_uid="me")


def is_release(tx) -> bool:
    return any(LEASE in d and "status" not in d and not isinstance(d.get(LEASE), dict) for d in _updates(tx))


fs.after_commit["r5"] = only(is_release, once(always(lambda: Aborted("409 transaction no longer valid"))))
got = acting("r5", firebase_mod.release_decision, ref9, tok9)
fs.clear_hooks()
really("release, lost answer")
eq("a release whose answer was lost says 'released' (it said 'not_held')", got, "released")

# R6 — a stamp that landed, then a failed begin hidden behind the library's ValueError.
fs.collection("probe").docs["p10"] = {"status": "pending"}
ref10 = fs.collection("probe").document("p10")
tok10 = acting("c11", firebase_mod.claim_decision, ref10, expected_status="pending", actor_uid="me")
fs.after_commit["s10"] = only(is_stamp, once(always(lambda: Aborted("409 transaction no longer valid"))))


def fail_second_begin(tx) -> None:
    if tx.attempt == 2:
        FIRED.append((tx.label, "begin"))
        raise ServiceUnavailable("503 begin unavailable")


fs.on_begin["s10"] = fail_second_begin
done = attempt(lambda: asyncio.to_thread(firebase_mod.complete_decision, ref10, tok10, {"status": "decided"},
                                         expected_status="pending"), "s10")
fs.clear_hooks()
really("stamp landed, then a failed begin")
eq("a stamp that landed, then a failed begin the library hides behind 'cannot be rolled back': True", done, True)

# R7 — a transfer whose move landed but could not be read back; approving again records it.
uid, app_id = waiting_host()
run(users_svc.activate_host_if_verified(uid, activation.activation_actor(uid)))
req = run(transfers.request("host", uid, "MAIN2", "The host asked to move; both agreed.", STAFF))["request"]["id"]
landed: list[bool] = []


def _lose_and_mark(tx) -> None:
    landed.append(True)
    FIRED.append((tx.label, "DeadlineExceeded"))
    raise DeadlineExceeded("504")


def _unreadable(path: str) -> None:
    if landed and path.startswith("users/"):
        raise ServiceUnavailable("503 read unavailable")


fs.after_commit["own3"] = only(is_move, once(_lose_and_mark))
fs.on_plain_read["own3"] = _unreadable
out = attempt(transfers.decide, "own3", req, True, "The host asked to move; both agreed.", OWNER)
fs.clear_hooks()
really("transfer move landed, read-back failed")
ok("a move that landed but could not be read back: TransferOutcomeUnknown (503), request still pending",
   type(out).__name__ == "TransferOutcomeUnknown" and getattr(out, "status_code", None) == 503
   and next(d for d in db["transfer_requests"].docs if d["_id"] == req)["status"] == "pending", show(out))
eq("…the host IS under MAIN2", fs.collection("users").docs[uid].get("agencyId"), "MAIN2")
out = attempt(transfers.decide, "own4", req, True, "The host asked to move; both agreed.", OWNER)
ok("approving again RECORDS the move that landed (it was refused: 'already the current agency')",
   isinstance(out, dict) and out["request"]["status"] == "approved"
   and (out.get("moved") or {}).get("recorded_after_unconfirmed_move") is True, show(out))
eq("…no second move; the host told once; the lock released",
   (len([e for e in fs.events if e[0] == "commit" and e[1] == "own4" and e[3]]),
    NOTICES.count(("transferred", uid)), any(d.get("_id") == f"host:{uid}" for d in db["transfer_locks"].docs)),
   (0, 1, False))

# R8 — a KYC approval whose grant landed but was not recorded; a reviewer then REFUSES it.
uid, app_id = kyc_app()
fs.on_commit["kyc5"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(users_svc.decide_host_application, "kyc5", app_id, True, WHY, STAFF)
fs.clear_hooks()
really("KYC not recorded, then refused")
out = attempt(users_svc.decide_host_application, "kyc6", app_id, False, "Documents do not match.", STAFF)
note = str((out or {}).get("note") or (out or {}).get("account_note") or "") if isinstance(out, dict) else show(out)
print(f"   refusing an unrecorded approval → {note[:150]}")
ok("refusing it treats the role as granted BY this application (it said 'a Host through another application')",
   isinstance(out, dict) and "through another application" not in note, note)
eq("…the application is recorded refused", app_doc(app_id).get("status"), "rejected")

# R9 — an appeal overturn that lifted the ban but was not recorded; then an UPHOLD, then an overturn.
uid, aid = banned_with_appeal()
other = f"apl-other-{next(_n)}"
fs.collection("appeals").docs[other] = {"subjectUid": uid, "status": "pending", "kind": "ban", "source": "web"}
fs.on_commit["apl5"] = only(is_stamp, always(lambda: Aborted("409")))
out = attempt(appeals_svc.decide_appeal, "apl5", aid, "overturned", "The ban was on the wrong account.", MOD("mod-z"))
fs.clear_hooks()
really("appeal overturn not recorded, then upheld")
out = attempt(appeals_svc.decide_appeal, "apl6", aid, "upheld", "The ban was right.", MOD("mod-w"))
ok("upholding an appeal whose overturn already lifted the ban is refused (it recorded 'upheld' over a lifted ban)",
   isinstance(out, appeals_svc.AppealError) and "already lifted" in str(out), show(out))
eq("…the appeal is still pending", fs.collection("appeals").docs[aid].get("status"), "pending")
out = attempt(appeals_svc.decide_appeal, "apl7", aid, "overturned", "The ban was on the wrong account.", MOD("mod-z"))
eq("deciding it as overturned records it, and the person's OTHER pending appeal is closed too",
   (fs.collection("appeals").docs[aid].get("status"), fs.collection("appeals").docs[other].get("status")),
   ("overturned", "resolved"))

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} HT-2 decision checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} HT-2 decision checks passed.")
