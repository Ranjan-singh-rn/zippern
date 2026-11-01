"""Mobile parity — `GET /api/auth/me` capability keys.

The Android app decides which work screens to OFFER from these keys, so they
must be the server's own table, the caller's own facts only, and must never
widen anything. Pure: `roles.capability_profile` and the route's source.

Run:  python3 -m tests.test_me_capabilities
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core import roles as R  # noqa: E402
from app.core.roles import Permission, Role, capability_profile  # noqa: E402

failures: list[str] = []


def check(label, actual, expected):
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


# Every role's permissions are exactly the table's, in declaration order.
for role in Role:
    p = capability_profile(role)
    want = [str(x) for x in R.ALL_PERMISSIONS if x in R.PERMISSIONS.get(role, frozenset())]
    check(f"{role} permissions mirror PERMISSIONS", p["permissions"], want)
    check(f"{role} is_internal", p["is_internal"], R.is_internal(role))
    check(f"{role} is_external", p["is_external"], R.is_external(role))
    check(f"{role} is_owner", p["is_owner"], role == Role.OWNER)

# The owner holds everything; the observer holds nothing and cannot write.
check("owner holds all", len(capability_profile(Role.OWNER)["permissions"]), len(R.ALL_PERMISSIONS))
obs = capability_profile(Role.OBSERVER)
check("observer permissions", obs["permissions"], [])
check("observer can_write", obs["can_write"], False)
check("observer flagged", obs["is_observer"], True)

# Partners: no capability list (authorised by their record), their own ids only.
ag = capability_profile("agency", {"agency": "A1"}, "approved")
check("agency permissions", ag["permissions"], [])
check("agency ids", ag["partner_ids"], {"agency": "A1"})
check("agency status", ag["partner_status"], "approved")
check("agency cannot write as staff", ag["can_write"], False)
pending = capability_profile("seller", {}, "pending")
check("pending seller has no ids", pending["partner_ids"], {})

# An internal session never carries partner ids, whatever the dict says.
staff = capability_profile("ops_admin", {"agency": "SNEAKY"}, "approved")
check("staff partner ids dropped", staff["partner_ids"], {})
check("staff partner status dropped", staff["partner_status"], None)
check("ops admin can approve kyc", str(Permission.CAN_APPROVE_KYC) in staff["permissions"], True)
check("ops admin is team admin", staff["is_team_admin"], True)
check("ops admin can write", staff["can_write"], True)

# A machine or unknown role gets nothing.
for bogus in ("system", "", "superadmin", None):
    b = capability_profile(bogus)
    check(f"{bogus!r} permissions", b["permissions"], [])
    check(f"{bogus!r} internal", b["is_internal"], False)
    check(f"{bogus!r} can_write", b["can_write"], False)

# The route keeps its identity keys and its session dependency.
src = (ROOT / "app" / "routers" / "auth.py").read_text()
me = src[src.index('@router.get("/me")'):src.index('@router.post("/signout")')]
for key in ('"uid"', '"email"', '"name"', '"role"', '"team"', "capability_profile("):
    check(f"/me returns {key}", key in me, True)
check("/me requires a session", "Depends(current_user)" in me, True)

if failures:
    print(f"{len(failures)} FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print("All /me capability checks passed.")
