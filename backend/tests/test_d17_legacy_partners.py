"""D17 — legacy partners without both verified contacts: the transition and the migration tooling.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * `partner_ops.hold_for_verification` puts an ACTIVE role whose login lacks
    a verified phone or email into exactly the Decision 15 waiting state —
    inactive, `awaiting_verification` on Mongo, the Firestore document and
    the CRM login — audits it, tells the person, and refuses anything else:
    a complete login, a record that is not approved and active, a Host, a
    record with no login, a record that changed underneath it.
  * The way back is the D15 way back: verifying both contacts starts the role
    again through `activate_partner_if_verified`; the referral code is the
    one it had.
  * `scripts/d17_legacy_partners.py`: the survey WRITES NOTHING (every store
    is compared before and after); the plan carries no uid, name, phone or
    email and prints only anonymous references; records with money in
    flight and Hosts are excluded (open decisions D17-M, D17-H); the apply
    step refuses a tampered, stale, unapproved or foreign plan before a
    single write, and skips a record that changed since the plan.

Service-level integration against in-memory fakes — NOT an end-to-end test.
The migration has NOT been run anywhere; this is its dry-run and guard.

    python3 -m tests.test_d17_legacy_partners
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import auth_record, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
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
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
AUTH: dict[str, object] = {}
firebase_mod.get_user = lambda uid: AUTH.get(uid)  # type: ignore[assignment]
firebase_mod.get_user_by_phone = lambda p: next((r for r in AUTH.values() if r.phone_number == p), None)  # type: ignore[assignment]
firebase_mod.get_user_by_email = lambda e: next((r for r in AUTH.values() if r.email == e), None)  # type: ignore[assignment]

from app.services import contact_verification as cv  # noqa: E402
from app.services import money as money_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402
from scripts import d17_legacy_partners as D  # noqa: E402

for mod in (ops, partner_svc, roles, apps, money_mod, users_svc):
    if hasattr(mod, "get_db"):
        mod.get_db = lambda: db  # type: ignore[assignment]
for mod in (ops, apps, users_svc):
    mod.audit.record = fake_audit
logging.disable(logging.CRITICAL)

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


def refusal(coro) -> Exception | None:
    try:
        asyncio.run(coro)
    except Exception as exc:  # noqa: BLE001
        return exc
    return None


run = asyncio.run
STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None,
           "service_credential": "partner-registration"}
WHY = "Documents checked against the originals."
HOLD = "D17 legacy-partner migration (test). The login lacks a verified email."


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, "isProfileComplete": True, **over}


def both_verified(uid: str) -> None:
    AUTH[uid] = auth_record(uid, phone=f"+9197{abs(hash(uid)) % 10**8:08d}", email=f"{uid}@x.test",
                            email_verified=True)


def legacy_unverified_email(uid: str) -> None:
    """A CRM password login whose address was only ever SENT credentials (D15: not verified)."""
    AUTH[uid] = auth_record(uid, phone=f"+9196{abs(hash(uid)) % 10**8:08d}", email=f"{uid}@x.test",
                            email_verified=False, providers=("password",))


def live_partner(pid: str, owner: str, collection: str = "agencies", **doc) -> None:
    """An approved, ACTIVE role — approved while both contacts were verified, as a legacy role was."""
    user(owner)
    both_verified(owner)
    base = {"status": "pending", "kycStatus": "submitted", "ownerUid": owner, "crmUid": owner,
            "source": "self_signup", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"]}
    if collection == "agencies":
        base.update({"agencyName": pid, "type": "main"})
    else:
        base.update({"displayName": pid})
    fs.collection(collection).docs[pid] = {**base, **doc}
    run(ops.ensure_partner_record(pid, SERVICE, "Registered."))
    run(ops.approve_partner(pid, WHY, STAFF))


def partner(pid: str) -> dict:
    return db["partners"].docs.get(pid) or {}


def snapshot() -> str:
    """Every store, serialised — a survey must leave this byte-for-byte as it was.

    Firestore also counts every write and delete each collection (and each
    subcollection) has ever seen, so even a write of identical data shows."""
    # A fake creates a collection object on first ACCESS; an empty one is not a write.
    mongo_state = {name: copy.deepcopy(col.docs) for name, col in db.collections.items() if col.docs}

    def fs_tree(col) -> dict:
        return {"docs": copy.deepcopy(col.docs), "writes": len(col.writes), "deleted": len(col.deleted),
                "sub": {f"{k[0]}/{k[1]}": fs_tree(v) for k, v in col.subcollections.items()}}

    fs_state = {name: fs_tree(col) for name, col in fs.collections.items()
                if col.docs or col.writes or col.deleted or col.subcollections}
    return json.dumps([mongo_state, fs_state], default=str, sort_keys=True)


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. hold_for_verification — the D15 waiting state, for a role that had started")

live_partner("AG1", "own-ag1")
ok("(precondition) AG1 is approved and active", partner("AG1").get("status") == "approved"
   and partner("AG1").get("is_active") is True)
code_before = fs.collection("agencies").docs["AG1"].get("referralCode")
legacy_unverified_email("own-ag1")

out = run(ops.hold_for_verification("AG1", HOLD, D.MIGRATION_ACTOR))
eq("held: awaiting_verification", partner("AG1").get("status"), "awaiting_verification")
eq("…inactive", partner("AG1").get("is_active"), False)
eq("…what is missing is recorded", partner("AG1").get("activation", {}).get("missing"), ["email"])
eq("…with the reason", partner("AG1").get("activation", {}).get("held_reason"), HOLD)
ok("…the original approval stays on record", bool(partner("AG1").get("approved_at")))
eq("the Firestore document follows", (fs.collection("agencies").docs["AG1"].get("status"),
                                      fs.collection("agencies").docs["AG1"].get("isActive")),
   ("awaiting_verification", False))
eq("…with what is pending", fs.collection("agencies").docs["AG1"].get("activationPending"), ["email"])
eq("the CRM login is in the waiting room", (fs.collection("crmUsers").docs.get("own-ag1") or {}).get("status"),
   "awaiting_verification")
ok("audited as partner.held_for_verification",
   any(a["action"] == "partner.held_for_verification" and a["subject_id"] == "AG1" for a in AUDIT))
notes = [d for d in fs.collection("notifications").docs.values()
         if d.get("userId") == "own-ag1" and (d.get("meta") or {}).get("held") is True]
ok("the person is told the role is paused until verified", len(notes) == 1
   and "paused" in notes[0].get("body", ""), repr(notes))
eq("the answer says so", (out.get("held"), out.get("missing")), (True, ["email"]))

exc = refusal(ops.hold_for_verification("AG1", HOLD, D.MIGRATION_ACTOR))
ok("holding it again is refused — it is no longer approved and active", exc is not None, "held twice")

live_partner("AG2", "own-ag2")                                  # both contacts verified
exc = refusal(ops.hold_for_verification("AG2", HOLD, D.MIGRATION_ACTOR))
ok("a login with both contacts verified is never held", exc is not None and "nothing to hold" in str(exc), str(exc))
eq("…AG2 untouched", partner("AG2").get("status"), "approved")
exc = refusal(ops.hold_for_verification("AG2", "", D.MIGRATION_ACTOR))
ok("a hold needs a reason", exc is not None)

# ══════════════════════════════════════════════════════════════════════════════
print("2. The way back is the D15 way back")

exc = refusal(ops.activate_partner_if_verified("AG1", STAFF))
ok("while the email is unverified the role does not start", exc is not None, "it started")
cv_ledger = fs.collection(cv.LEDGER).docs
cv_ledger["own-ag1"] = {**cv_ledger.get("own-ag1", {}),
                        "email": {"address": "own-ag1@x.test", "verifiedAt": "t", "method": "email_code"}}
AUTH["own-ag1"] = auth_record("own-ag1", phone=AUTH["own-ag1"].phone_number, email="own-ag1@x.test",
                              email_verified=True, providers=("password",))
res = run(ops.activate_partner_if_verified("AG1", STAFF))
eq("once both are verified the role starts again", (partner("AG1").get("status"), partner("AG1").get("is_active")),
   ("approved", True))
ok("…reported as activated", res.get("activated") is True)
eq("…the referral code is the one it had", fs.collection("agencies").docs["AG1"].get("referralCode"), code_before)

# ══════════════════════════════════════════════════════════════════════════════
print("3. The survey writes nothing; the plan holds no personal data")

live_partner("AG3", "own-ag3")
legacy_unverified_email("own-ag3")                              # → hold
live_partner("SL1", "own-sl1", collection="sellers")
legacy_unverified_email("own-sl1")
db["balances"].docs["bal-SL1"] = {"_id": "bal-SL1", "holder_type": "seller", "holder_id": "SL1",
                                  "currency": "coins", "amount": 500}
live_partner("SL2", "own-sl2", collection="sellers")
AUTH["own-sl2"] = auth_record("own-sl2", email="own-sl2@x.test", email_verified=True)   # no phone → hold
user("host-1", isHost=True, beans=120)
AUTH["host-1"] = auth_record("host-1", email="host-1@x.test", email_verified=True)      # no phone
user("host-2", isHost=True)
both_verified("host-2")

before = snapshot()
candidates, hosts = run(D.survey(db))
after = snapshot()
ok("the survey changed NOTHING in Mongo or Firestore", before == after)
by_id = {c.partner_id: c for c in candidates}
eq("AG3 lacks the email", by_id["AG3"].missing, ["email"])
eq("SL1 lacks the email and holds coins", (by_id["SL1"].missing, by_id["SL1"].money.get("seller_coins")),
   (["email"], 500))
eq("SL2 lacks the phone", by_id["SL2"].missing, ["phone"])
eq("AG2 and AG1 are complete", (by_id["AG2"].missing, by_id["AG1"].missing), ([], []))
eq("hosts are counted, not planned", (hosts["active_hosts"], hosts["lacking"]["phone"], hosts["with_beans"],
                                      hosts["action"]), (2, 1, 1, "excluded"))

plan = D.build_plan(candidates, hosts, project="zipper-test", generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
actions = {e["partner_id"]: e["action"] for e in plan["entries"]}
eq("planned: AG3 and SL2 held, SL1 excluded (money in flight)", actions, {"AG3": "hold", "SL1": "exclude", "SL2": "hold"})
eq("the plan validates against the current semantics", D.validate_plan(plan), [])
blob = json.dumps(plan)
for secret in ("own-ag3", "own-sl1", "own-sl2", "@x.test", "+91", "host-1", "agencyName", "displayName"):
    ok(f"the plan file holds no {secret!r}", secret not in blob)
sha = D.plan_sha256(plan)
text = D.render(plan, D.totals(candidates), sha)
ok("the dry run says nothing was written", "DRY RUN. Nothing was written." in text)
for pid in ("AG1", "AG2", "AG3", "SL1", "SL2"):
    ok(f"the printed dry run names {pid} only by reference", f" {pid} " not in text and f"ref {D.ref(pid)}" in text
       if actions.get(pid) else f" {pid} " not in text)
ok("it lists the exact state change", "status approved → awaiting_verification" in text)
ok("it says applying is a separate approved step", "SEPARATE, explicitly approved step" in text)

# ══════════════════════════════════════════════════════════════════════════════
print("4. The apply step refuses before a single write unless everything holds")

NOW = datetime.now(timezone.utc)
base = dict(given_sha=sha, approval="Owner approved the reviewed dry-run, 2026-10-21", project="zipper-test", now=NOW)
eq("a reviewed, matching, fresh plan passes the preconditions", D.check_apply_preconditions(plan, **base), [])
ok("a wrong sha256 is refused", D.check_apply_preconditions(plan, **{**base, "given_sha": "0" * 64}) != [])
ok("no approval reference is refused", D.check_apply_preconditions(plan, **{**base, "approval": " "}) != [])
ok("another project is refused", D.check_apply_preconditions(plan, **{**base, "project": "zipper-prod"}) != [])
ok("a stale plan is refused", D.check_apply_preconditions(plan, **{**base, "now": NOW + timedelta(hours=73)}) != [])
tampered = copy.deepcopy(plan)
next(e for e in tampered["entries"] if e["partner_id"] == "SL1")["action"] = "hold"
ok("a plan edited to hold a record with money in flight is refused",
   any("money in flight" in p for p in D.check_apply_preconditions(tampered, **{**base, "given_sha": D.plan_sha256(tampered)})))
hosty = copy.deepcopy(plan)
hosty["entries"].append({"partner_id": "host-1", "ref": D.ref("host-1"), "kind": "host", "missing": ["phone"],
                         "money_in_flight": {}, "action": "hold", "why": "", "expect": {"status": "approved", "is_active": True}})
ok("a plan that names a Host is refused (D17-H)",
   any("Hosts are D17-H" in p for p in D.check_apply_preconditions(hosty, **{**base, "given_sha": D.plan_sha256(hosty)})))

# A record that changed after the plan was made: SL2's owner verified the phone meanwhile.
AUTH["own-sl2"] = auth_record("own-sl2", phone="+919500000002", email="own-sl2@x.test", email_verified=True)
results = run(D.apply(plan, sha, base["approval"]))
by_ref = {r["ref"]: r for r in results}
eq("AG3 is held", (by_ref[D.ref("AG3")]["applied"], partner("AG3").get("status")), (True, "awaiting_verification"))
eq("SL1 (money in flight) is not touched", (by_ref[D.ref("SL1")]["applied"], partner("SL1").get("status")),
   (False, "approved"))
eq("SL2 changed since the plan (both verified now) and is skipped, untouched",
   (by_ref[D.ref("SL2")]["applied"], partner("SL2").get("status")), (False, "approved"))
ok("…the skip names the record by reference only", "SL2" not in json.dumps(results))
ok("every applied hold is audited with the migration actor",
   any(a["action"] == "partner.held_for_verification" and a["subject_id"] == "AG3"
       and a["actor"]["uid"] == "system:d17-migration" for a in AUDIT))

SRC = (ROOT / "scripts" / "d17_legacy_partners.py").read_text()
import ast  # noqa: E402

_connects = [n for n in ast.walk(ast.parse(SRC)) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and n.func.attr in ("connect", "ensure_indexes")]
ok("the script connects only as mongo.connect(ensure=False) — no index DDL — read from its code, not its prose",
   len(_connects) == 1 and _connects[0].func.attr == "connect"
   and any(k.arg == "ensure" and isinstance(k.value, ast.Constant) and k.value.value is False
           for k in _connects[0].keywords), ast.dump(_connects[0]) if _connects else "no connect")

# mongo.connect(ensure=False): the isolation check still runs, the DDL does not.
_made, _indexed = [], []


class _RecMotor:
    def __init__(self, uri, **kw):
        _made.append(uri)

        class _A:
            async def command(self, *_a, **_k):
                return {"ok": 1}
        self.admin = _A()


async def _rec_indexes():
    _indexed.append(True)


_saved = (mongo.AsyncIOMotorClient, mongo.ensure_indexes, mongo._client, mongo.isolation.assert_mongo_allowed)
_checked = []
mongo.AsyncIOMotorClient, mongo.ensure_indexes = _RecMotor, _rec_indexes
mongo.isolation.assert_mongo_allowed = lambda s, *a, **k: _checked.append(True)
try:
    run(mongo.connect(ensure=False))
    eq("connect(ensure=False): isolation checked, client made, NO ensure_indexes", (_checked, len(_made), _indexed),
       ([True], 1, []))
    run(mongo.connect())
    eq("connect() (every existing caller): ensure_indexes still runs", _indexed, [True])
finally:
    mongo.AsyncIOMotorClient, mongo.ensure_indexes, mongo._client, mongo.isolation.assert_mongo_allowed = _saved
    mongo.get_db = lambda: db  # type: ignore[assignment]
ok("the survey reads the owner without persisting it (not owner_uid_of)",
   "_firestore_owner_of" in SRC and "owner_uid_of(" not in SRC.split("async def survey", 1)[1].split("async def apply", 1)[0])

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} D17 legacy-partner checks passed.")
