"""The organisation is a hierarchy of positions, not a record of who invited whom.

    Owner
      ├── app_admin        → app_member
      ├── ops_admin        → ops_member
      ├── finance_admin    → finance_member
      ├── tech_admin       → tech_member
      ├── support_admin    → support_member
      └── marketing_admin  → marketing_member

── WHAT THIS REPLACES ────────────────────────────────────────────────────────

`reports_to` — the uid of whoever sent the invitation — was the authorisation key
in three places: `list_staff` scoped a department admin's whole view by it, and
`deactivate` and `set_employment` refused on it. Authority therefore meant "I
invited you", which is a fact about the past rather than a position in the
organisation, and it was wrong three different ways:

  * an owner who invited a member directly left that member's own department
    admin with no authority over them at all;
  * two admins in one department each saw only their own invitees;
  * a transfer did not move authority — somebody moved from Ops to Finance still
    reported to the `ops_admin` who first invited them, so the department they
    had LEFT kept the power to revoke them while the one that now runs them
    could not see them.

An earlier attempt to fix the third case re-pointed `reports_to` at whoever did
the transfer. That made the employee owner-owned and invisible to their new
department, which is the same bug facing the other way.

`manages()` derives authority from the actor's role and the target's `team`,
both read at the moment of the decision. Nothing here depends on `reports_to`,
and one test asserts that it cannot be used as a bypass.

Run:  python3 -m tests.test_staff_hierarchy
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.core import roles as R  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.services import staff as svc  # noqa: E402

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def actor(role: Role, uid: str | None = None) -> dict:
    return {"uid": uid or f"{role}-1", "role": role, "name": str(role)}


def person(role: Role, uid: str | None = None, **extra) -> dict:
    """A staff row as Mongo holds it. `team` is what carries the department."""
    team = R.team_of(role)
    return {
        "uid": uid or f"{role}-person",
        "role": str(role),
        "team": str(team) if team else None,
        "is_active": True,
        **extra,
    }


ADMINS = sorted(R.ADMIN_ROLES, key=str)
MEMBERS = sorted(R.MEMBER_ROLES, key=str)


# ══════════════════════════════════════════════════════════════════════════════
#  1–6. Every department admin runs their own department, and only that
# ══════════════════════════════════════════════════════════════════════════════

for role in ADMINS:
    team = R.team_of(role)
    offered = svc.assignable_roles(role)

    ok(f"{role} holds CAN_MANAGE_TEAM",
       R.has_permission(role, R.Permission.CAN_MANAGE_TEAM))
    check(f"{role} may create exactly one role", len(offered), 1)
    check(f"{role} may create their own department's member",
          offered, [r for r in R.MEMBER_ROLES if R.team_of(r) == team])
    ok(f"{role} may not create any admin",
       not any(r in R.ADMIN_ROLES for r in offered))
    ok(f"{role} may not create another department's member",
       all(R.team_of(r) == team for r in offered))
    ok(f"{role} may not create an owner or the observer",
       Role.OWNER not in offered and Role.OBSERVER not in offered)

# The two that were missing, named outright.
check("finance_admin → finance_member", svc.assignable_roles(Role.FINANCE_ADMIN),
      [Role.FINANCE_MEMBER])
check("tech_admin → tech_member", svc.assignable_roles(Role.TECH_ADMIN),
      [Role.TECH_MEMBER])


# ══════════════════════════════════════════════════════════════════════════════
#  7–9. A department admin cannot reach another department
# ══════════════════════════════════════════════════════════════════════════════

# `manages()` is the single predicate behind listing, deactivating and editing
# employment, so one table covers all three. They used to be three separate
# comparisons, which is how they came to disagree.
for admin_role in ADMINS:
    admin_team = R.team_of(admin_role)
    a = actor(admin_role)

    for member_role in MEMBERS:
        same_team = R.team_of(member_role) == admin_team
        allowed = svc.manages(a, person(member_role))
        check(
            f"{admin_role} {'manages' if same_team else 'does NOT manage'} {member_role}",
            allowed,
            same_team,
        )

    # Never a fellow admin — not even of their own department. An admin is
    # appointed by an owner and managed by one, which is what stops a department
    # being taken over from inside it.
    for other_admin in ADMINS:
        ok(f"{admin_role} does not manage {other_admin}",
           not svc.manages(a, person(other_admin)))

    ok(f"{admin_role} does not manage an owner",
       not svc.manages(a, person(Role.OWNER)))
    ok(f"{admin_role} does not manage the observer",
       not svc.manages(a, person(Role.OBSERVER)))


# ══════════════════════════════════════════════════════════════════════════════
#  10. An owner manages every department
# ══════════════════════════════════════════════════════════════════════════════

owner = actor(Role.OWNER, "owner-1")
for role in ADMINS + MEMBERS:
    ok(f"an owner manages {role}", svc.manages(owner, person(role)))
ok("an owner manages another owner", svc.manages(owner, person(Role.OWNER)))


# ══════════════════════════════════════════════════════════════════════════════
#  11–13. A member belongs to their own department's hierarchy
# ══════════════════════════════════════════════════════════════════════════════

cases = [
    (Role.APP_MEMBER, Role.APP_ADMIN, [Role.OPS_ADMIN, Role.FINANCE_ADMIN]),
    (Role.FINANCE_MEMBER, Role.FINANCE_ADMIN, [Role.OPS_ADMIN, Role.TECH_ADMIN]),
    (Role.TECH_MEMBER, Role.TECH_ADMIN, [Role.FINANCE_ADMIN, Role.APP_ADMIN]),
]
for member_role, own_admin, foreign_admins in cases:
    row = person(member_role)
    ok(f"{member_role} is managed by {own_admin}",
       svc.manages(actor(own_admin), row))
    for foreign in foreign_admins:
        ok(f"{member_role} is NOT managed by {foreign}",
           not svc.manages(actor(foreign), row))
    ok(f"{member_role} is managed by an owner", svc.manages(owner, row))


# ══════════════════════════════════════════════════════════════════════════════
#  14–16. A transfer moves authority, and the inviter keeps none
# ══════════════════════════════════════════════════════════════════════════════

# Invited into Ops by the ops admin, so `reports_to` names that admin for ever.
OPS_ADMIN_UID = "ops-admin-7"
employee = person(Role.OPS_MEMBER, "emp-1", reports_to=OPS_ADMIN_UID)

ok("while in Ops, the ops admin manages them",
   svc.manages(actor(Role.OPS_ADMIN, OPS_ADMIN_UID), employee))
ok("and finance does not",
   not svc.manages(actor(Role.FINANCE_ADMIN), employee))

# The transfer. `change_role` writes `role` and `team`; `reports_to` is left
# exactly as it was, which is the point — it is no longer load-bearing.
moved = dict(employee)
moved["role"] = str(Role.FINANCE_MEMBER)
moved["team"] = str(R.team_of(Role.FINANCE_MEMBER))

check("`reports_to` still names the original inviter",
      moved["reports_to"], OPS_ADMIN_UID)
ok("the ops admin who invited them has NO authority after the transfer",
   not svc.manages(actor(Role.OPS_ADMIN, OPS_ADMIN_UID), moved))
ok("the finance admin now manages them, having never met them",
   svc.manages(actor(Role.FINANCE_ADMIN), moved))
ok("and the owner still does",
   svc.manages(owner, moved))

# The employee is NOT left owner-owned and invisible, which was the earlier
# wrong fix: Finance can see them, which is the whole point of the transfer.
ok("so the employee is visible to the department that now runs them",
   svc.manages(actor(Role.FINANCE_ADMIN), moved))


# ══════════════════════════════════════════════════════════════════════════════
#  17. `reports_to` cannot be used as an authorisation bypass
# ══════════════════════════════════════════════════════════════════════════════

# Whatever it says, and whoever is asking. A forged or stale value buys nothing,
# because the predicate never reads it.
for claimed in (OPS_ADMIN_UID, "owner-1", "attacker", "", None):
    row = person(Role.FINANCE_MEMBER, "emp-2", reports_to=claimed)
    ok(f"reports_to={claimed!r} does not give an ops admin authority",
       not svc.manages(actor(Role.OPS_ADMIN, OPS_ADMIN_UID), row))
    ok(f"reports_to={claimed!r} does not change the finance admin's authority",
       svc.manages(actor(Role.FINANCE_ADMIN), row))

# And a member cannot manage anybody, including somebody pointed at them.
ok("a member manages nobody",
   not svc.manages(actor(Role.FINANCE_MEMBER),
                   person(Role.FINANCE_MEMBER, "emp-3", reports_to="finance_member-1")))


# ══════════════════════════════════════════════════════════════════════════════
#  18–19. Owners, partners and the unknown
# ══════════════════════════════════════════════════════════════════════════════

# An external partner is not staff and has no place in this hierarchy. Asserted
# from the role sets rather than by poking the partner services, which this
# change does not touch.
ok("agency and seller are external, never staff",
   R.EXTERNAL_ROLES.isdisjoint(R.STAFF_ROLES))
for external in sorted(R.EXTERNAL_ROLES, key=str):
    ok(f"{external} is not in any department", R.team_of(external) is None)
    ok(f"a department admin does not manage {external}",
       not svc.manages(actor(Role.OPS_ADMIN), person(external)))
    ok(f"{external} manages no staff",
       not svc.manages(actor(external), person(Role.OPS_MEMBER)))

# A role this build does not recognise — a legacy string, a hand edit — is
# refused rather than guessed at.
ok("an unknown role is not manageable by a department admin",
   not svc.manages(actor(Role.OPS_ADMIN), {"uid": "x", "role": "wizard", "team": "ops"}))
ok("a row with no role at all is refused",
   not svc.manages(actor(Role.OPS_ADMIN), {"uid": "x"}))


# ══════════════════════════════════════════════════════════════════════════════
#  20. The observer sits above the owners, and that is all it does
# ══════════════════════════════════════════════════════════════════════════════

# It provisions owners — the top of the hierarchy — and holds no other write
# anywhere: none of the twenty CRM capabilities, no Firebase account, no
# `crmUsers` document. `tests/test_observer_owner.py` holds the full set; these
# are here so the hierarchy work cannot quietly widen it.
check("the observer may provision an owner, and only that",
      svc.assignable_roles(Role.OBSERVER), [Role.OWNER])
ok("it may not create any department role",
   not any(r in R.STAFF_ROLES for r in svc.assignable_roles(Role.OBSERVER)))
ok("nor another observer",
   Role.OBSERVER not in svc.assignable_roles(Role.OBSERVER))
ok("the observer does not hold CAN_MANAGE_TEAM",
   not R.has_permission(Role.OBSERVER, R.Permission.CAN_MANAGE_TEAM))
ok("the observer is not in a department", R.team_of(Role.OBSERVER) is None)
# `can_read_all` is why `manages()` answers True: the observer SEES everything.
# Seeing is not writing — `require_write` refuses it at the route, which
# `tests/test_authority.py` and `tests/test_permissions.py` hold shut.
ok("the observer reads everything", R.can_read_all(Role.OBSERVER))


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} staff-hierarchy checks passed.")
print("  · all six department admins create their own member role, and only that")
print("  · a department admin reaches their own department's members and nothing else")
print("  · never another admin, never an owner, never the observer")
print("  · an owner manages every department")
print("  · a transfer moves authority to the new department and away from the old")
print("  · reports_to grants nothing, whatever it says")
print("  · partners are not staff, and the observer is unchanged")
sys.exit(0)
