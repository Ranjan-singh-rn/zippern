"""The backfill's plan, which is the whole of its safety.

The script itself cannot run here — it needs Mongo and a Firebase credential —
but every decision it makes is in `plan()`, which needs neither. So the
questions that matter before anybody types `--apply` are answered against the
real function:

  * exactly which accounts does it touch, and which does it leave alone?
  * where does each role come from?
  * what happens to a malformed or unrecognised identity?
  * can it grant a privileged claim from client-written data?

The last one is the point. `crmUsers` is written by the browser during partner
signup, so a backfill that read `role` out of it and believed it would be a
one-command privilege escalation over the whole business.

    python3 -m tests.test_backfill_storage_claims
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.core.roles import EXTERNAL_ROLES, INTERNAL_ROLES, Role  # noqa: E402
from scripts.backfill_storage_claims import PARTNER_ROLES, plan  # noqa: E402

checks = 0
failures = 0


def ok(claim, cond):
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
        print(f"  FAIL  {claim}")


def eq(claim, got, want):
    global checks, failures
    checks += 1
    if got != want:
        failures += 1
        print(f"  FAIL  {claim}\n        got {got!r}\n        want {want!r}")


def roles_of(planned):
    return {p[2] for p in planned}


# ── 1. Which accounts it touches ────────────────────────────────────────────
print("\n1. What it plans to modify")

staff = [
    {"uid": "s1", "email": "owner@z", "role": "owner", "is_active": True},
    {"uid": "s2", "email": "obs@z", "role": "observer", "is_active": True},
    {"uid": "s3", "email": "fa@z", "role": "finance_admin", "is_active": True},
    {"uid": "s4", "email": "gone@z", "role": "ops_member", "is_active": False},
]
crm = [
    ("p1", {"email": "ag@z", "role": "agency", "agencyId": "AG7", "isActive": True}),
    ("p2", {"email": "se@z", "role": "seller", "isActive": True}),
    ("p3", {"email": "old@z", "role": "agency", "agencyId": "AG9", "isActive": False}),
]

planned, problems, no_claim = plan(staff, crm)
# Six, not seven: the observer row is deliberately not planned — it has no
# Firebase account to stamp. See section 2c.
eq("every stampable staff row and partner document is planned", len(planned), 6)
eq("no problems on clean input", problems, [])

by_uid = {p[0]: p for p in planned}
eq("an owner gets the owner claim", by_uid["s1"][2], "owner")
ok("the observer is NOT planned — it has no Firebase account to stamp",
   "s2" not in by_uid)
ok("and is on the no-claim roster with the reason",
   any(r[0] == "s2" and "no Firebase account" in r[2] for r in no_claim))
eq("an inactive staff row is CLEARED, not granted", by_uid["s4"][2], "")
eq("an agency carries its own id", (by_uid["p1"][2], by_uid["p1"][3]), ("agency", "AG7"))
eq("a seller carries an empty aid", (by_uid["p2"][2], by_uid["p2"][3]), ("seller", ""))
eq("an inactive partner is cleared", by_uid["p3"][2], "")

# ── 2. It cannot grant a privileged claim from Firestore ────────────────────
print("2. Client-written crmUsers cannot produce an internal claim")

hostile = [
    (f"x{i}", {"email": "a@z", "role": r, "agencyId": "AG7", "isActive": True})
    for i, r in enumerate([
        "owner", "observer", "superadmin", "system",
        "app_admin", "app_member", "ops_admin", "ops_member",
        "finance_admin", "finance_member", "tech_admin", "tech_member",
        "support_admin", "support_member", "marketing_admin", "marketing_member",
        "admin", "ops", "tech", "finance", "support",
        "constructor", "__proto__", "toString", "AGENCY", "Agency", " agency",
    ])
]
planned, _, _nc = plan([], hostile)
eq("not one of them is planned", planned, [])

# Non-string roles, which a hand-crafted Firestore write could carry.
weird = [(f"w{i}", {"role": r, "isActive": True})
         for i, r in enumerate([None, 0, 1, True, {}, [], ["agency"]])]
planned, _, _nc = plan([], weird)
eq("non-string roles are planned for nothing", planned, [])

# And the whitelist itself.
eq("PARTNER_ROLES has exactly two keys", set(PARTNER_ROLES), {"agency", "seller"})
ok("neither is an internal role",
   not ({"agency", "seller"} & {str(r) for r in INTERNAL_ROLES}))

planned, _, _nc = plan(staff, crm)
# Asserted on the role VALUE, not on the note text. An earlier version matched
# `note.startswith("partner")` and broke the moment the note began naming
# sub-agencies separately — a test coupled to a display string, which is the
# same mistake as parsing one.
PARTNER_VALUES = {str(r) for r in EXTERNAL_ROLES}
INTERNAL_VALUES = {str(r) for r in INTERNAL_ROLES}
staff_uids = {str(r["uid"]) for r in staff if r.get("uid")}
crm_uids = {u for u, _ in crm}

ok("every internal claim lands on a uid that has a Mongo staff row",
   all(p[0] in staff_uids for p in planned if p[2] in INTERNAL_VALUES))
ok("no internal claim is granted to a uid known only to crmUsers",
   not any(p[0] in crm_uids - staff_uids for p in planned if p[2] in INTERNAL_VALUES))
ok("every partner claim lands on a crmUsers uid",
   all(p[0] in crm_uids for p in planned if p[2] in PARTNER_VALUES))

# ── 2b. A staff uid is never downgraded by a partner document ──────────────
print("2b. Mongo wins a staff/partner conflict")

conflict_staff = [{"uid": "X", "email": "x@z", "role": "ops_admin", "is_active": True}]
conflict_crm = [("X", {"email": "x@z", "role": "agency", "agencyId": "AG7", "isActive": True})]
planned, problems, nc = plan(conflict_staff, conflict_crm)

eq("exactly one entry is planned for the uid", len(planned), 1)
eq("and it is the INTERNAL claim from Mongo", planned[0][2], "ops_admin")
ok("the conflict is reported, not resolved by iteration order",
   any("CONFLICT" in p for p in problems))
ok("and the refusal is on the no-claim roster",
   any(r[0] == "X" and "authoritative" in r[2] for r in nc))

# Before the guard, --apply ran the plan in order and the partner entry landed
# second, silently replacing ops_admin with agency. One entry per uid is what
# makes the ordering irrelevant.
uids = [r[0] for r in planned]
eq("no uid appears twice in the plan", len(uids), len(set(uids)))

# ── 2c. The observer is never planned ──────────────────────────────────────
print("2c. The observer earns no claim, because it has no Firebase account")
#
# Found in the first real production dry run: the plan contained
# `observer:314zipper@gmail.com -> role=observer`. That uid is synthetic —
# `seed_accounts.py` writes `observer:<email>` and gives the identity NO
# Firebase account, and `core/security.py` refuses a Firebase-token observer
# session outright. So `--apply` would have called `get_user()` on a uid that
# cannot exist, printed FAILED, and exited 1 on a correct condition.

obs_staff = [
    {"uid": "observer:obs@z", "email": "obs@z", "role": "observer", "is_active": True},
    {"uid": "real_uid", "email": "owner@z", "role": "owner", "is_active": True},
]
planned, problems, nc = plan(obs_staff, [])

eq("only the owner is planned", [r[0] for r in planned], ["real_uid"])
ok("the observer is on the no-claim roster, not the plan",
   any(r[0] == "observer:obs@z" for r in nc))
ok("with the reason stated",
   any("no Firebase account" in r[2] for r in nc if r[0] == "observer:obs@z"))
ok("and it is not a warning — this is expected, not a fault",
   not any("observer" in p for p in problems))

# An observer row that is somehow inactive is still just skipped, not cleared:
# there is no claim to clear.
planned2, _, _ = plan(
    [{"uid": "observer:x@z", "email": "x@z", "role": "observer", "is_active": False}], [])
eq("an inactive observer is not planned for a clear either", planned2, [])

# ── 3. Malformed and unrecognised identities ────────────────────────────────
print("3. Malformed input is reported, never guessed at")

messy = [
    {"uid": "", "role": "owner", "is_active": True},
    {"uid": "m2", "role": "wizard", "is_active": True},
    {"uid": "m3", "role": "", "is_active": True},
    {"uid": "m4", "role": "agency", "is_active": True},
]
planned, problems, no_claim = plan(messy, [])
eq("none of the four is planned", planned, [])
eq("and all four are reported", len(problems), 4)
ok("a row with no uid is named", any("no uid" in p for p in problems))
ok("an unknown role is named with its value", any("'wizard'" in p for p in problems))
ok("an external role on a staff row is reported rather than granted",
   any("not internal" in p for p in problems))

planned, _, _nc = plan([], [("c1", {"role": "agency", "isActive": True})])
eq("a partner with no agencyId gets an empty aid, not a missing one",
   planned[0][3], "")

# ── 4. Idempotence and the dry run ──────────────────────────────────────────
print("4. Idempotence and the dry run")

a, _, _na = plan(staff, crm)
b, _, _nb = plan(staff, crm)
eq("the plan is a pure function of its input", a, b)

# Behavioural, not textual: run the real `main()` with the two data sources
# stubbed and EVERY claim writer replaced by something that raises. If the dry
# run writes anything at all, this fails. Grepping the source for the string
# "Dry run" proved nothing and broke when the wording changed.
import asyncio as _asyncio, contextlib as _ctx, io as _io, importlib.util as _ilu

_spec = _ilu.spec_from_file_location(
    "bf_live", Path(__file__).resolve().parents[1] / "scripts" / "backfill_storage_claims.py")
bf = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(bf)


def _never(*_a, **_k):
    raise AssertionError("the dry run attempted to write a claim")


async def _rows():
    return staff


async def _noop_connect():
    return None


async def _noop_disconnect():
    return None


# `main()` now opens both clients the way the application does, so a test that
# only stubbed the readers would try to dial the real Atlas cluster.
bf.mongo.connect = _noop_connect
bf.mongo.disconnect = _noop_disconnect
bf.staff_rows = _rows
bf.partner_docs = lambda: crm
bf.agency_kinds = lambda: {"AG7": "agency", "SUB3": "sub_agency", "AG9": "agency"}
bf.firebase.init = lambda: None
bf.storage_claims.apply_for_role = _never
bf.storage_claims.apply_partner = _never
bf.storage_claims.clear = _never

_saved_argv = sys.argv
sys.argv = ["backfill_storage_claims"]          # NO --apply
_buf = _io.StringIO()
try:
    with _ctx.redirect_stdout(_buf):
        _code = _asyncio.run(bf.main())
    ok("a dry run completes without writing a single claim", True)
except AssertionError as exc:
    ok(f"a dry run completes without writing a single claim ({exc})", False)
finally:
    sys.argv = _saved_argv

_out = _buf.getvalue()
eq("and exits 0", _code, 0)
ok("saying plainly that zero writes happened", "ZERO WRITES" in _out)
ok("naming setCustomUserClaims as not called", "setCustomUserClaims was NOT called" in _out)
ok("and reporting a summary", "SUMMARY" in _out)

src = (Path(__file__).resolve().parents[1]
       / "scripts" / "backfill_storage_claims.py").read_text()
ok("the write path goes through apply_partner, which re-checks the whitelist",
   'storage_claims.apply_partner' in src)
ok("and never through the private _apply",
   'storage_claims._apply' not in src)
ok("the aid is carried as data, not re-parsed from the display string",
   'note.split("aid=' not in src)

# ── 5. Initialisation lifecycle ────────────────────────────────────────────
print("5. The clients are opened before they are used, and closed after")
#
# The regression this pins: `main()` called `firebase.init()` and nothing
# else, so the first real run died on
# `RuntimeError: Mongo client not initialised — call connect() first`.
# `app/db/mongo.py` keeps a module-level `_client` that stays None until
# `connect()` is awaited, and `get_db()` refuses rather than quietly building
# one — so the script was broken for every caller, and only a run against a
# real Mongo could show it.
#
# Asserted as an ORDER, not a presence check: `connect()` appearing somewhere
# in the file would have satisfied a grep while still running after the first
# query.

calls: list[str] = []

bf2 = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(bf2)


async def _rec_connect():
    calls.append("mongo.connect")


async def _rec_disconnect():
    calls.append("mongo.disconnect")


async def _rec_staff():
    calls.append("staff_rows")
    return staff


bf2.firebase.init = lambda: calls.append("firebase.init")
bf2.mongo.connect = _rec_connect
bf2.mongo.disconnect = _rec_disconnect
bf2.staff_rows = _rec_staff
bf2.partner_docs = lambda: (calls.append("partner_docs"), crm)[1]
bf2.agency_kinds = lambda: (calls.append("agency_kinds"), {})[1]
bf2.storage_claims.apply_for_role = _never
bf2.storage_claims.apply_partner = _never
bf2.storage_claims.clear = _never

_saved = sys.argv
sys.argv = ["backfill_storage_claims"]
try:
    with _ctx.redirect_stdout(_io.StringIO()):
        _asyncio.run(bf2.main())
finally:
    sys.argv = _saved

ok("mongo.connect() is called", "mongo.connect" in calls)
ok("firebase.init() is called", "firebase.init" in calls)
ok("mongo.connect() happens BEFORE staff_rows()",
   calls.index("mongo.connect") < calls.index("staff_rows"))
ok("firebase.init() happens BEFORE partner_docs()",
   calls.index("firebase.init") < calls.index("partner_docs"))
ok("firebase.init() happens BEFORE agency_kinds()",
   calls.index("firebase.init") < calls.index("agency_kinds"))
ok("mongo.disconnect() is called", "mongo.disconnect" in calls)
eq("and it is last — the client is closed on the way out",
   calls[-1], "mongo.disconnect")

# The `finally` matters more than the happy path: an operator debugging a
# failed run is exactly who should not also get a hung process.
calls.clear()


async def _boom():
    calls.append("staff_rows")
    raise RuntimeError("Mongo unreachable")


bf2.staff_rows = _boom
sys.argv = ["backfill_storage_claims"]
try:
    with _ctx.redirect_stdout(_io.StringIO()):
        _asyncio.run(bf2.main())
    ok("a failing run still raises", False)
except RuntimeError:
    ok("a failing run still raises", True)
finally:
    sys.argv = _saved

ok("and the client is STILL closed when the body raises",
   calls and calls[-1] == "mongo.disconnect")

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} backfill-plan checks passed.")
print("  · internal claims come only from the Mongo staff row")
print("  · no crmUsers document of any shape yields a privileged claim")
print("  · malformed identities are reported and skipped, never guessed")
print("  · the plan is pure, repeatable, and dry by default\n")
