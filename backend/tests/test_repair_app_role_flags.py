"""FLAGS_STALE repair: the production shapes from `diagnose_app_identity`
(2026-10-07), on fixtures — never the real accounts.

Pins: the repair and the decision-time push derive flags only from crmUsers,
never create users/{uid}, never touch profile/suspension/ban/host fields,
keep Agency and Seller independent, remove withdrawn roles, and are
idempotent (a second run writes nothing).

    python3 -m tests.test_repair_app_role_flags
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.db import firebase as firebase_mod  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from scripts import repair_app_role_flags as R  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim, cond):
    eq(claim, bool(cond), True)


fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
U = fs.collection("users").docs
C = fs.collection("crmUsers").docs

PROTECTED = {"isProfileComplete": True, "isSuspended": False, "isBanned": False,
             "suspendedUntil": None, "name": "N", "gender": "male", "isOfficial": False}

# 1. CRM-created Agency (zipper262003 shape): approved, no roleStatus, flags absent.
C["agency1"] = {"role": "agency", "status": "approved", "isActive": True, "agencyId": "fpcp"}
U["agency1"] = dict(PROTECTED)
# 2. Ruhan shape: Agency + Seller, both approved, flags absent.
C["ruhan"] = {"role": "agency", "roles": ["agency", "seller"], "isActive": True, "status": "approved",
              "roleStatus": {"agency": "approved", "seller": "approved"},
              "agencyId": "NqvN", "sellerId": "NLTA"}
U["ruhan"] = dict(PROTECTED)
# 3. Approved agency that never opened the app (giiliijawani shape).
C["noapp"] = {"role": "agency", "status": "approved", "isActive": True, "agencyId": "W"}
# 4. Revoked agency still tagged, seller kept; stale partner crmRole from old mirror.
C["revoked"] = {"role": "agency", "roles": ["agency", "seller"], "isActive": True, "status": "approved",
                "roleStatus": {"agency": "revoked", "seller": "approved"}, "agencyId": "OLD"}
U["revoked"] = {**PROTECTED, "isAgent": True, "isSeller": True, "agencyId": "OLD", "crmRole": "agency"}
# 5. Suspended seller, agency approved.
C["susp"] = {"role": "seller", "roles": ["seller", "agency"], "isActive": True, "status": "approved",
             "roleStatus": {"seller": "suspended", "agency": "approved"}, "agencyId": "AG5"}
U["susp"] = {**PROTECTED, "isAgent": False, "isSeller": True}
# 6. A HOST whose users.agencyId is the agency they work under, and whose own
#    seller capability was rejected. Their host agencyId must survive.
C["host"] = {"role": "seller", "isActive": True, "status": "rejected", "sellerId": "S6"}
U["host"] = {**PROTECTED, "isHost": True, "agencyId": "HOSTAGENCY", "isSeller": True}
# 7. Pending agency application: no tag yet.
C["pending"] = {"role": "agency", "status": "pending", "isActive": True, "agencyId": "P7",
                "roleStatus": {"agency": "pending"}}
U["pending"] = dict(PROTECTED)
# 8. Already correct.
C["fine"] = {"role": "seller", "status": "approved", "isActive": True, "sellerId": "S8"}
U["fine"] = {**PROTECTED, "isAgent": False, "isSeller": True}
# 9. Staff member: crmRole must never be touched.
C["staff"] = {"role": "ops_admin", "status": "approved", "isActive": True}
U["staff"] = {**PROTECTED, "crmRole": "ops_admin", "isOfficial": True, "isAgent": False, "isSeller": False}
# 10. Stale positive with no crmUsers at all.
U["ghost"] = {**PROTECTED, "isAgent": True, "agencyId": "GONE"}

before = copy.deepcopy(U)

print("1. Dry run writes nothing")
rows = {r["uid"]: r for r in R.run(fs, [], apply=False)}
eq("dry run left users untouched", U, before)
eq("noapp is skipped, not created", rows["noapp"]["action"], "SKIP_NO_USERS_DOC")
ok("…and still has no users doc", "noapp" not in U)
eq("CRM-created agency planned", rows["agency1"]["action"], "UPDATE")
eq("Ruhan planned", rows["ruhan"]["action"], "UPDATE")
eq("already-correct seller needs nothing", rows["fine"]["action"], "OK")
ok("staff is not a candidate (no partner role, no partner flag)", "staff" not in rows)
ok("stale positive with no crmUsers IS a candidate", "ghost" in rows)

print("2. Apply")
R.run(fs, [], apply=True)
eq("agency1: isAgent", U["agency1"].get("isAgent"), True)
eq("agency1: isSeller", U["agency1"].get("isSeller"), False)
eq("agency1: ownAgencyId", U["agency1"].get("ownAgencyId"), "fpcp")
ok("agency1: agencyId not written", "agencyId" not in U["agency1"])
eq("ruhan: isAgent", U["ruhan"].get("isAgent"), True)
eq("ruhan: isSeller", U["ruhan"].get("isSeller"), True)
eq("ruhan: ownAgencyId", U["ruhan"].get("ownAgencyId"), "NqvN")
eq("revoked: Agency removed", U["revoked"].get("isAgent"), False)
eq("revoked: Seller kept", U["revoked"].get("isSeller"), True)
ok("revoked: own agencyId removed", "agencyId" not in U["revoked"])
eq("revoked: partner crmRole cleared", U["revoked"].get("crmRole"), "")
eq("susp: Seller removed", U["susp"].get("isSeller"), False)
eq("susp: Agency added", U["susp"].get("isAgent"), True)
eq("susp: ownAgencyId set", U["susp"].get("ownAgencyId"), "AG5")
eq("host: rejected seller removed", U["host"].get("isSeller"), False)
eq("host: HOST agencyId preserved", U["host"].get("agencyId"), "HOSTAGENCY")
eq("host: still a host", U["host"].get("isHost"), True)
eq("pending: no Agency tag", U["pending"].get("isAgent"), False)
ok("pending: no agencyId stamped", "agencyId" not in U["pending"])
eq("ghost: stale Agency removed", U["ghost"].get("isAgent"), False)
eq("ghost: unrelated agencyId left alone (cannot prove it is theirs)", U["ghost"].get("agencyId"), "GONE")
eq("staff untouched", U["staff"], before["staff"])
eq("fine untouched", U["fine"], before["fine"])
ok("noapp still not created", "noapp" not in U)
for uid in ("agency1", "ruhan", "revoked", "susp", "host", "pending", "ghost"):
    for k, v in PROTECTED.items():
        eq(f"{uid}: {k} unchanged", U[uid].get(k), v)
    extra = set(U[uid]) - set(before[uid]) - set(crm.APP_ROLE_FIELDS)
    eq(f"{uid}: no field outside APP_ROLE_FIELDS added", extra, set())

print("3. Idempotent")
after = copy.deepcopy(U)
rows2 = R.run(fs, [], apply=True)
eq("second run plans no UPDATE", [r["uid"] for r in rows2 if r["action"] == "UPDATE"], [])
eq("second run changed nothing", U, after)

print("4. Targeted run and the decision-time push agree")
C["agency1"]["roleStatus"] = {"agency": "suspended"}
rows3 = R.run(fs, ["agency1"], apply=False)
eq("--uid limits the run", [r["uid"] for r in rows3], ["agency1"])
eq("push_app_role_flags returns no error", crm.push_app_role_flags("agency1"), "")
eq("push: suspended agency loses the tag", U["agency1"].get("isAgent"), False)
ok("push: own agencyId removed", "agencyId" not in U["agency1"])
eq("push: profile untouched", U["agency1"].get("isProfileComplete"), True)
eq("push on a uid with no users doc writes nothing", crm.push_app_role_flags("noapp"), "")
ok("…and creates nothing", "noapp" not in U)

print("5. A crmUsers read failure is not 'no roles'")
real_read = crm.read
crm.read = lambda uid: (_ for _ in ()).throw(crm.DirectoryError("boom"))  # type: ignore[assignment]
snapshot = copy.deepcopy(U["ruhan"])
eq("repair skips", R.plan_one(fs, "ruhan")["action"], "SKIP_CRM_UNREADABLE")
ok("push reports, does not strip", crm.push_app_role_flags("ruhan") != "")
eq("ruhan's flags survived the failed read", U["ruhan"], snapshot)
crm.read = real_read

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} repair-app-role-flags checks passed.")
