"""The dry-run reset planner: fail-closed allowlist, classification, self-check,
and the guarantee that the script cannot delete anything.

    python3 -m tests.test_reset_plan
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import plan_test_data_reset as P  # noqa: E402

checks = 0
failures: list[str] = []


def ok(claim, cond, detail=""):
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim} {detail}")


def refused(claim, fn):
    global checks
    checks += 1
    try:
        fn()
    except P.AllowlistError:
        return
    failures.append(f"{claim}: was NOT refused")


OBS = "observer@x.test"
AUTH = {"o1": "o1@x.test", "o2": "o2@x.test", "o3": "o3@x.test",
        "o1-app": None, "t1": "t1@x.test", "ruhan": "ruhan@x.test"}
PHONES = {"+911111": "o1-app"}


def staff(n_owners=3, observers=1, **over):
    rows = [{"_id": f"s{i}", "uid": f"o{i}", "role": "owner", "email": f"o{i}@x.test",
             "phone": "+911111" if i == 1 else ""} for i in range(1, n_owners + 1)]
    rows += [{"_id": "obs", "uid": f"observer:{OBS}", "role": "observer", "email": OBS}
             for _ in range(observers)]
    rows += [{"_id": "s9", "uid": "t1", "role": "ops_admin", "email": "t1@x.test"}]
    return rows


get = lambda u: SimpleNamespace(uid=u) if u in AUTH else None  # noqa: E731
by_email = lambda e: next((SimpleNamespace(uid=u) for u, m in AUTH.items() if m == e), None)  # noqa: E731
by_phone = lambda p: SimpleNamespace(uid=PHONES[p]) if p in PHONES else None  # noqa: E731


def resolve(rows=None, explicit=("o1", "o2", "o3"), auth_get=get, email=by_email):
    return P.resolve_allowlist(rows if rows is not None else staff(), list(explicit), OBS,
                               auth_get, email, by_phone)


print("1. Allowlist — fail closed")
A = resolve()
ok("three owners", A.owner_uids == ["o1", "o2", "o3"])
ok("owner's phone-OTP account is linked and kept", A.owner_linked_uids == {"o1-app": "o1"})
ok("observer resolved from staff with no Auth", A.observer["uid"] == f"observer:{OBS}")
refused("two owners", lambda: resolve(staff(n_owners=2), explicit=("o1", "o2")))
refused("four owners", lambda: resolve(staff(n_owners=4), explicit=("o1", "o2", "o3", "o4")))
refused("explicit uids differ from staff", lambda: resolve(explicit=("o1", "o2", "t1")))
refused("only two explicit uids", lambda: resolve(explicit=("o1", "o2")))
refused("owner with no Auth account", lambda: resolve(auth_get=lambda u: None if u == "o3" else get(u)))
refused("no observer", lambda: resolve(staff(observers=0)))
refused("two observers", lambda: resolve(staff(observers=2)))
refused("observer has an Auth account",
        lambda: resolve(auth_get=lambda u: SimpleNamespace(uid=u) if u.startswith("observer:") or u in AUTH else None))
refused("observer email on an Auth account",
        lambda: resolve(email=lambda e: SimpleNamespace(uid="x") if e == OBS else by_email(e)))
bad = staff(); bad[1]["uid"] = ""
refused("owner row without uid", lambda: resolve(bad))

print("2. Classification")
removed: set[str] = set()
auth_rows = P.classify_auth([{"uid": u, "email": e} for u, e in AUTH.items()], A)
act = {r["id"]: r["action"] for r in auth_rows}
ok("owners preserved in Auth", all(act[u] == "PRESERVE" for u in ("o1", "o2", "o3", "o1-app")))
ok("test accounts deleted in Auth", act["t1"] == "DELETE" and act["ruhan"] == "DELETE")

users = P.classify_firestore("users", [("o1", {"isAgent": True}), ("o2", {}), ("ruhan", {"isAgent": True})], A, removed)
u = {r["id"]: r["action"] for r in users}
ok("owner users doc with test partner flags → RESET", u["o1"] == "RESET")
ok("owner users doc clean → PRESERVE", u["o2"] == "PRESERVE")
ok("test user → DELETE", u["ruhan"] == "DELETE")
ag = P.classify_firestore("agencies", [("A1", {"ownerUid": "ruhan"}), ("A2", {"crmUid": "o2"})], A, removed)
ok("test agency deleted, owner agency kept",
   [r["action"] for r in ag] == ["DELETE", "PRESERVE"] and "A1" in removed)
ok("config preserved", P.classify_firestore("appConfig", [("x", {})], A, removed)[0]["action"] == "PRESERVE")
ok("rechargeRequests retained for audit",
   P.classify_firestore("rechargeRequests", [("r", {})], A, removed)[0]["action"] == "RETAIN_FOR_AUDIT")
ok("unknown collection is UNCLASSIFIED",
   P.classify_firestore("mystery", [("m", {})], A, removed)[0]["action"] == "UNCLASSIFIED")
for name in ("audit", "ledger", "recharges", "partner_sales"):
    ok(f"mongo {name} retained", P.classify_mongo(name, [{}], A, removed)[0]["action"] == "RETAIN_FOR_AUDIT")
st = {r["id"]: r["action"] for r in P.classify_mongo("staff", staff(), A, removed)}
ok("owner staff kept", all(st[f"s{i}"] == "PRESERVE" for i in (1, 2, 3)))
ok("observer staff kept", st["obs"] == "PRESERVE")
ok("non-owner staff deleted", st["s9"] == "DELETE")
ses = P.classify_mongo("sessions", [{"_id": 1, "uid": f"observer:{OBS}"}, {"_id": 2, "uid": "ruhan"}], A, removed)
ok("observer session kept, test session deleted", [r["action"] for r in ses] == ["PRESERVE", "DELETE"])
bal = P.classify_mongo("balances", [{"_id": "b", "holder_id": "A1"}], A, removed)
ok("balance of a removed holder retained (ledger must reconcile)", bal[0]["action"] == "RETAIN_FOR_AUDIT")
sto = P.classify_storage(["users/o1/a.jpg", "users/ruhan/a.jpg", "gifts/rose.svga", "weird/x"], A, removed)
sa = {(r["collection"], r["action"]): r["count"] for r in sto}
ok("owner storage kept", sa.get(("users/", "PRESERVE")) == 1)
ok("test storage deleted", sa.get(("users/", "DELETE")) == 1)
ok("config storage kept", sa.get(("gifts/", "PRESERVE")) == 1)
ok("unknown prefix UNCLASSIFIED", sa.get(("weird/", "UNCLASSIFIED")) == 1)

print("3. Self-check")
all_rows = auth_rows + users + ag + P.classify_mongo("staff", staff(), A, removed)
ok("clean plan has no violations", P.self_check(all_rows, A) == [])
poisoned = all_rows + [{"store": "firestore", "collection": "users", "id": "o3", "action": "DELETE", "owner": "o3"}]
ok("a DELETE of an owner is caught", len(P.self_check(poisoned, A)) == 1)
poisoned = all_rows + [{"store": "mongo", "collection": "sessions", "id": "z", "action": "DELETE",
                        "owner": f"observer:{OBS}"}]
ok("a DELETE touching the observer is caught", len(P.self_check(poisoned, A)) == 1)

print("4. The script cannot delete")
src = (ROOT / "scripts" / "plan_test_data_reset.py").read_text()
tree = ast.parse(src)
calls = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
forbidden = {"delete", "delete_one", "delete_many", "delete_user", "delete_users", "update", "update_one",
             "update_many", "set", "insert_one", "insert_many", "replace_one", "set_custom_user_claims",
             "delete_blob", "drop", "commit", "batch", "transaction"}
ok("no write/delete call in the planner", not (calls & forbidden), str(calls & forbidden))
ok("does not import the destructive reset tool", "reset_test_data import" not in src)

print("5. --fresh policy (the production shape of 2026-10-07)")
from scripts import execute_test_data_reset as X  # noqa: E402
FA = A
base = (P.classify_auth([{"uid": u} for u in AUTH], FA)
        + P.classify_firestore("users", [("o1", {"diamonds": 50}), ("ruhan", {})], FA, set())
        + P.classify_firestore("crmUsers", [("o2", {"role": "superadmin"}), ("t1", {})], FA, set())
        + P.classify_firestore("notifications", [("n1", {"userId": "o1"}), ("n2", {"userId": "ruhan"})], FA, set())
        + P.classify_firestore("agencies", [("A9", {"ownerUid": "o2"})], FA, set())
        + P.classify_firestore("platformRevenue", [("p", {})], FA, set())
        + P.classify_firestore("authEvents", [("e", {"uid": "o1"})], FA, set())
        + P.classify_firestore("appConfig", [("androidUpdate", {})], FA, set())
        + P.classify_mongo("audit", [{}], FA, set())
        + P.classify_mongo("staff", staff(), FA, set())
        + P.classify_mongo("sessions", [{"_id": 1, "uid": "o1"}, {"_id": 2, "uid": "t1"}], FA, set())
        + P.classify_mongo("scheduled_runs", [{}], FA, set()))
fresh = P.apply_fresh_policy(base, FA)
fa = {(r["store"], r["collection"], str(r["id"])): r["action"] for r in fresh}
ok("fresh: audit history deleted", fa[("mongo", "audit", "*")] == "DELETE")
ok("fresh: platformRevenue deleted", fa[("firestore", "platformRevenue", "*")] == "DELETE")
ok("fresh: authEvents deleted", fa[("firestore", "authEvents", "*")] == "DELETE")
ok("fresh: owner's notification deleted", fa[("firestore", "notifications", "n1")] == "DELETE")
ok("fresh: owner-owned test agency deleted", fa[("firestore", "agencies", "A9")] == "DELETE")
ok("fresh: owner users doc RESET, not deleted", fa[("firestore", "users", "o1")] == "RESET")
ok("fresh: owner crmUsers RESET, not deleted", fa[("firestore", "crmUsers", "o2")] == "RESET")
ok("fresh: owner Auth preserved", all(fa[("auth", "auth", u)] == "PRESERVE" for u in ("o1", "o2", "o3")))
ok("fresh: owner + observer staff preserved",
   all(fa[("mongo", "staff", i)] == "PRESERVE" for i in ("s1", "s2", "s3", "obs")))
ok("fresh: owner session kept, test session deleted",
   fa[("mongo", "sessions", "1")] == "PRESERVE" and fa[("mongo", "sessions", "2")] == "DELETE")
ok("fresh: config preserved", fa[("firestore", "appConfig", "*")] == "PRESERVE"
   and fa[("mongo", "scheduled_runs", "*")] == "PRESERVE")
ok("fresh: self-check clean", P.self_check(fresh, FA, fresh=True) == [])
bad_rows = fresh + [{"store": "firestore", "collection": "users", "id": "o2", "action": "DELETE", "owner": "o2"}]
ok("fresh: deleting an owner users doc still caught", len(P.self_check(bad_rows, FA, fresh=True)) == 1)
bad_rows = fresh + [{"store": "auth", "collection": "auth", "id": "o3", "action": "DELETE", "owner": "o3"}]
ok("fresh: deleting an owner Auth account caught", len(P.self_check(bad_rows, FA, fresh=True)) >= 1)
ok("storage: appBuilds (in-app updater) preserved", P.storage_action("appBuilds/release/arm64/a.apk", FA) == "PRESERVE")
ok("storage: contentAssets preserved", P.storage_action("contentAssets/banner.png", FA) == "PRESERVE")
ok("storage: owner profileMedia preserved", P.storage_action("profileMedia/o1/avatar.jpg", FA) == "PRESERVE")
ok("storage: test profileMedia deleted", P.storage_action("profileMedia/ruhan/avatar.jpg", FA) == "DELETE")
ok("storage: appealEvidence / coinPurchases deleted",
   P.storage_action("appealEvidence/x/1.jpg", FA) == "DELETE" and P.storage_action("coinPurchases/x/p.jpg", FA) == "DELETE")

print("5b. The 2026-10-07 blockers: publicSellers, coinPurchaseProofs/, sellerDocs/")
kept_p: set[str] = set()
rem_p: set[str] = set()
sel = P.classify_firestore("sellers", [("S-test", {"crmUid": "ruhan"}), ("S-own", {"ownerUid": "o1"})],
                           A, rem_p, kept_p)
ok("seller of a test identity removed, owner's kept", "S-test" in rem_p and "S-own" in kept_p)
pub = {r["id"]: r["action"] for r in P.classify_firestore(
    "publicSellers", [("S-test", {}), ("S-own", {}), ("S-orphan", {})], A, rem_p, kept_p)}
ok("publicSellers mirror of a removed seller → DELETE", pub["S-test"] == "DELETE")
ok("publicSellers mirror of a kept seller → PRESERVE", pub["S-own"] == "PRESERVE")
ok("orphan publicSellers mirror → DELETE", pub["S-orphan"] == "DELETE")
ok("publicSellers is never UNCLASSIFIED", "UNCLASSIFIED" not in pub.values())
ok("without a kept set every mirror is DELETE (fail toward no stale public listing)",
   P.classify_firestore("publicSellers", [("S-own", {})], A, set())[0]["action"] == "DELETE")
fresh_pub = P.apply_fresh_policy(P.classify_firestore("publicSellers", [("S-own", {})], A, set(), {"S-own"}), A)
ok("fresh: even a kept seller's mirror is deleted (its seller is too)", fresh_pub[0]["action"] == "DELETE")


class _C:
    def __init__(self, i):
        self.id = i


ok("mirrors are classified after their source",
   [c.id for c in P.firestore_order([_C("publicSellers"), _C("sellers"), _C("agencies")])]
   == ["agencies", "sellers", "publicSellers"])
ok("coinPurchaseProofs of a test seller → DELETE",
   P.storage_action("coinPurchaseProofs/ruhan/p.jpg", A) == "DELETE")
ok("coinPurchaseProofs of an owner uid → PRESERVE",
   P.storage_action("coinPurchaseProofs/o1/p.jpg", A) == "PRESERVE")
ok("sellerDocs/{testSeller} → DELETE", P.storage_action("sellerDocs/S-test/id.pdf", A) == "DELETE")
ok("sellerDocs/signup and /crm → DELETE",
   P.storage_action("sellerDocs/signup/proof_1", A) == "DELETE"
   and P.storage_action("sellerDocs/crm/1_id.pdf", A) == "DELETE")
ok("sellerDocs/{keptSeller} → PRESERVE when the seller survives",
   P.storage_action("sellerDocs/S-own/id.pdf", A, {"S-own"}) == "PRESERVE")
ok("bare prefix object still UNCLASSIFIED", P.storage_action("sellerDocs", A) == "UNCLASSIFIED")
sto2 = P.classify_storage(["coinPurchaseProofs/x/1.jpg", "sellerDocs/s/1.pdf", "sellerDocs/s/2.pdf"], A, set())
ok("no new storage prefix is UNCLASSIFIED", all(r["action"] != "UNCLASSIFIED" for r in sto2))
ok("unknown prefixes are STILL blockers", P.storage_action("brandNewPrefix/x/y", A) == "UNCLASSIFIED")

# RC reset (2026-10-20): Step 1's managed Firestore export lands in the DEFAULT bucket under
# zipper-backups/ — the same bucket the planner lists. It is the restore source of the very reset
# being planned: never a blocker (the plan would refuse to run), never deleted.
_exp = "zipper-backups/firestore/20261020T000000Z/all_namespaces/all_kinds/output-0"
ok("storage: zipper-backups/ (the managed export) is PRESERVE, under every policy",
   P.storage_action(_exp, A) == "PRESERVE" and P.storage_action(_exp, FA) == "PRESERVE"
   and P.storage_action("zipper-backups/firestore/20261020T000000Z/20261020T000000Z.overall_export_metadata", A) == "PRESERVE")
_sto3 = P.apply_fresh_policy(P.classify_storage([_exp, "users/ruhan/a.jpg"], FA, set()), FA)
ok("fresh: the export is neither a blocker nor a deletion",
   {(r["collection"], r["action"]) for r in _sto3} == {("zipper-backups/", "PRESERVE"), ("users/", "DELETE")})
qlc = {r["id"]: r["action"] for r in P.classify_firestore(
    "quickLoginChallenges", [("c-test", {}), ("o1", {})], A, set())}
ok("quickLoginChallenges are ephemeral: test nonce deleted", qlc["c-test"] == "DELETE")
ok("quickLoginChallenges never UNCLASSIFIED", "UNCLASSIFIED" not in qlc.values())
for coll, docs in (("quickLoginRate", [("r1", {})]),
                   ("feedbackTickets", [("f1", {"userId": "ruhan"})]),
                   ("pkInvites", [("p1", {"hostAUid": "ruhan"})])):
    acts = [r["action"] for r in P.classify_firestore(coll, docs, A, set())]
    ok(f"{coll}: test record deleted, never UNCLASSIFIED", acts == ["DELETE"])

print("5c. Collections added after 2026-10-09 (the RC) — classified, never UNCLASSIFIED")

# Firestore. The verified-contacts ledger is IDENTITY: an Owner's survives (and
# the executor's guard protects it); everybody else's goes.
cv = {r["id"]: r["action"] for r in P.classify_firestore(
    "contactVerifications", [("o1", {"email": {}}), ("ruhan", {"phone": {}})], A, set())}
ok("contactVerifications: an Owner's is kept, a test account's deleted",
   (cv.get("o1"), cv.get("ruhan")) == ("PRESERVE", "DELETE"), repr(cv))
icr = {r["id"]: r["action"] for r in P.classify_firestore(
    "identityChangeRefusals", [("x1", {"uid": "ruhan"}), ("x2", {"uid": "o2"})], A, set())}
ok("identityChangeRefusals: owned by its uid field", (icr.get("x1"), icr.get("x2")) == ("DELETE", "PRESERVE"), repr(icr))
abr = {r["id"]: r["action"] for r in P.classify_firestore(
    "appBuildReports", [("o3", {"versionCode": 19}), ("ruhan", {"versionCode": 18})], A, set())}
ok("appBuildReports: owned by the document id (no uid field)",
   (abr.get("o3"), abr.get("ruhan")) == ("PRESERVE", "DELETE"), repr(abr))
for coll in ("emailOtpChallenges", "emailOtpRate"):
    acts = [r["action"] for r in P.classify_firestore(coll, [("h1", {})], A, set())]
    ok(f"{coll}: ephemeral, deleted", acts == ["DELETE"], repr(acts))

# Mongo.
for coll in ("transfer_requests", "role_appeals", "money_freezes"):
    rows = P.classify_mongo(coll, [{"_id": "r1"}], A, set())
    ok(f"{coll}: decision history, retained (normal mode)", [r["action"] for r in rows] == ["RETAIN_FOR_AUDIT"])
    ok(f"{coll}: …and deleted under --fresh",
       [r["action"] for r in P.apply_fresh_policy(rows, A)] == ["DELETE"])
canary = P.apply_fresh_policy(P.classify_mongo("ops_canary", [{"_id": "target"}], A, set()), A)
ok("ops_canary (the P0-10 data canary) is configuration: PRESERVED, even under --fresh",
   [r["action"] for r in canary] == ["PRESERVE"], repr(canary))
locks = {r["id"]: r["action"] for coll, docs in (
    ("host_application_locks", [{"_id": "ruhan", "application_id": "a"}, {"_id": "o1", "application_id": "b"}]),
    ("transfer_locks", [{"_id": "host:ruhan", "request_id": "t"}]),
    ("role_appeal_locks", [{"_id": "L1", "uid": "o2", "appeal_id": "x"}]),
) for r in P.classify_mongo(coll, docs, A, set())}
ok("locks: owned by uid / _id / 'kind:subject'",
   locks == {"ruhan": "DELETE", "o1": "PRESERVE", "host:ruhan": "DELETE", "L1": "PRESERVE"}, repr(locks))
rate = P.classify_mongo("public_appeal_rate", [{"_id": "h1"}, {"_id": "h2"}], A, set())
ok("public_appeal_rate: rate counters, deleted wholesale", [(r["id"], r["action"]) for r in rate] == [("*", "DELETE")])
ok("an unknown Mongo collection is STILL a blocker",
   P.classify_mongo("brand_new_collection", [{"_id": 1}], A, set())[0]["action"] == "UNCLASSIFIED")
ok("…and an unknown Firestore collection too",
   P.classify_firestore("brandNewCollection", [("d", {})], A, set())[0]["action"] == "UNCLASSIFIED")

# The reset tools never build indexes (DDL) on the database they reset.
for script in ("plan_test_data_reset.py", "execute_test_data_reset.py", "print_owner_uids.py"):
    tree = ast.parse((ROOT / "scripts" / script).read_text())
    connects = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == "connect" and isinstance(n.func.value, ast.Name) and n.func.value.id == "mongo"]
    ok(f"{script}: every mongo.connect() passes ensure=False (no index builds)",
       bool(connects) and all(any(k.arg == "ensure" and isinstance(k.value, ast.Constant) and k.value.value is False
                                  for k in c.keywords) for c in connects), f"{len(connects)} call(s)")

print("6. Executor guards")
def refuses_guard(claim, *args):
    global checks
    checks += 1
    try:
        X.guard(*args, FA)
    except X.RefusedError:
        return
    failures.append(f"{claim}: guard did NOT refuse")
refuses_guard("guard: owner Auth", "auth", "auth", "o1", "o1")
refuses_guard("guard: owner linked Auth", "auth", "auth", "o1-app", "o1-app")
refuses_guard("guard: owner users doc", "firestore", "users", "o2", "o2")
refuses_guard("guard: owner crmUsers doc", "firestore", "crmUsers", "o3", "o3")
refuses_guard("guard: owner staff row", "mongo", "staff", "s1", "o1")
refuses_guard("guard: observer staff row", "mongo", "staff", "obs", f"observer:{OBS}")
refuses_guard("guard: owner session", "mongo", "sessions", "1", "o1")
refuses_guard("guard: owner storage", "storage", "profileMedia/", "profileMedia/o1/a.jpg", "")
refuses_guard("guard: the managed Firestore export (zipper-backups/)", "storage", "zipper-backups/",
              "zipper-backups/firestore/20261020T000000Z/all_namespaces/all_kinds/output-0", "")
refuses_guard("guard: updater APKs", "storage", "appBuilds/", "appBuilds/release/a.apk", "")
refuses_guard("guard: Firestore config", "firestore", "appConfig", "*", "")
refuses_guard("guard: Mongo config", "mongo", "rates", "*", "")
refuses_guard("guard: an Owner's verified-contacts ledger", "firestore", "contactVerifications", "o1", "o1")
refuses_guard("guard: the P0-10 data canary", "mongo", "ops_canary", "*", "")
X.guard("firestore", "users", "ruhan", "ruhan", FA)
X.guard("firestore", "notifications", "n1", "o1", FA)       # owned record of an owner: allowed under fresh
X.guard("mongo", "audit", "*", "", FA)
X.guard("auth", "auth", "t1", "t1", FA)
ok("guard: test records pass", True)

DF = object()
up = X.owner_users_patch({"diamonds": 50, "beans": 0, "isAgent": True, "agencyId": "A", "crmRole": "superadmin",
                          "isProfileComplete": True, "isBanned": False, "name": "N"}, DF)
eq_ = up == {"diamonds": 0, "isAgent": False, "agencyId": DF}
ok("owner users patch: only flags + non-zero counters", eq_)
ok("owner users patch never touches profile/ban/staff crmRole",
   not ({"isProfileComplete", "isBanned", "name", "crmRole"} & set(up)))
cp = X.owner_crm_patch({"role": "superadmin", "roles": ["superadmin", "agency"], "agencyId": "A"}, DF)
ok("owner crm patch removes partner residue only", cp == {"roles": ["superadmin"], "agencyId": DF})
ok("owner crm patch empty when clean", X.owner_crm_patch({"role": "superadmin"}, DF) == {})

def refuses_plan(claim, plan):
    global checks
    checks += 1
    try:
        X.check_plan_file(plan)
    except X.RefusedError:
        return
    failures.append(f"{claim}: was NOT refused")
refuses_plan("non-fresh plan refused", {"policy": "retain-history", "blockers": []})
refuses_plan("plan with blockers refused", {"policy": "fresh", "blockers": ["UNCLASSIFIED x"]})
X.check_plan_file({"policy": "fresh", "blockers": []})

src = (ROOT / "scripts" / "execute_test_data_reset.py").read_text()
tree = ast.parse(src)
fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "execute")
deletes = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
           and n.func.attr in ("delete_many", "delete_one", "recursive_delete", "delete", "delete_users")]
guards = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "guard"]
ok(f"every delete site has a guard ({len(deletes)} deletes, {len(guards)} guards)", len(guards) >= len(deletes) - 1)
ok("executor never imports reset_test_data", "reset_test_data" not in src.split('"""', 2)[2])

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} reset-plan checks passed.")
