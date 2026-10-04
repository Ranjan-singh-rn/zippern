"""Authority model tests.

These cover the rules that decide who can do what with money. They are the most
security-sensitive logic in the system, and they are pure functions — no
database, no network — so they can be verified directly.

Run:  python3 -m tests.test_authority
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core import roles as R  # noqa: E402
from app.core.roles import Role, Team  # noqa: E402

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


# ── The observer never writes. Spec 1.1.4 ─────────────────────────────────────

check("observer cannot write", R.can_write(Role.OBSERVER), False)
check("observer cannot sign money", R.can_sign_money(Role.OBSERVER), False)
check("observer reads everything", R.can_read_all(Role.OBSERVER), True)
check("observer audit scope", R.audit_scope(Role.OBSERVER), "all")

for role in Role:
    if role is not Role.OBSERVER:
        check(f"{role} can write", R.can_write(role), True)


# ── Only owners sign money. Spec 1.2.1 / 1.3.6 ────────────────────────────────

check("owner signs money", R.can_sign_money(Role.OWNER), True)
for role in Role:
    if role is not Role.OWNER:
        check(f"{role} cannot sign money", R.can_sign_money(role), False)

# A team admin verifies but never approves — verification is not approval.
check("finance admin cannot sign", R.can_sign_money(Role.FINANCE_ADMIN), False)
check("app admin cannot sign", R.can_sign_money(Role.APP_ADMIN), False)


# ── Verification. Spec 3.5.8 / 9.3 ────────────────────────────────────────────

# Finance verifies money facts on any card, whoever raised it.
for team in Team:
    check(
        f"finance admin verifies {team} card",
        R.can_verify_money(Role.FINANCE_ADMIN, team),
        True,
    )

# Owners may verify any card. Separation of duties is preserved by cards.sign,
# which refuses a signature from whoever verified — so two people are always
# involved, even before any staff are hired.
for team in Team:
    check(f"owner verifies {team} card", R.can_verify_money(Role.OWNER, team), True)

# A team admin verifies only their own team's cards.
check("app admin verifies app card", R.can_verify_money(Role.APP_ADMIN, Team.APP), True)
check(
    "app admin cannot verify ops card",
    R.can_verify_money(Role.APP_ADMIN, Team.OPS),
    False,
)
check(
    "support admin cannot verify tech card",
    R.can_verify_money(Role.SUPPORT_ADMIN, Team.TECH),
    False,
)

# Members never verify.
for role in R.MEMBER_ROLES:
    check(
        f"{role} cannot verify",
        R.can_verify_money(role, R.team_of(role)),
        False,
    )

# The observer never verifies, despite reading everything.
check("observer cannot verify", R.can_verify_money(Role.OBSERVER, Team.FINANCE), False)


# ── Audit visibility. Spec 6.3 ────────────────────────────────────────────────

check("owner sees all audit", R.audit_scope(Role.OWNER), "all")
check("team admin sees team audit", R.audit_scope(Role.OPS_ADMIN), "team")
check("member sees own audit", R.audit_scope(Role.OPS_MEMBER), "self")
check("agency sees own audit", R.audit_scope(Role.AGENCY), "self")


# ── External accounts are not internal. Spec 1.6 ──────────────────────────────

check("agency is not internal", R.is_internal(Role.AGENCY), False)
check("seller is not internal", R.is_internal(Role.SELLER), False)
check("observer is internal", R.is_internal(Role.OBSERVER), True)
check("owner is internal", R.is_internal(Role.OWNER), True)
check("app member is internal", R.is_internal(Role.APP_MEMBER), True)

check("agency cannot read all", R.can_read_all(Role.AGENCY), False)
check("seller cannot sign money", R.can_sign_money(Role.SELLER), False)

# `is_external` is an allowlist of the two partner roles, deliberately not the
# negation of `is_internal`. A machine credential is neither, and a negation
# would file it as a partner and hand it a partner's route allowlist.
check("agency is external", R.is_external(Role.AGENCY), True)
check("seller is external", R.is_external(Role.SELLER), True)
for role in Role:
    if role not in {Role.AGENCY, Role.SELLER}:
        check(f"{role} is not external", R.is_external(role), False)
check("the machine is not external", R.is_external(R.SYSTEM_ROLE), False)
check("the machine is not internal either", R.is_internal(R.SYSTEM_ROLE), False)
check("nonsense is not external", R.is_external("wholesaler"), False)
check("every role is internal or external",
      len(R.INTERNAL_ROLES | R.EXTERNAL_ROLES), len(list(Role)))
check("and the two do not overlap", R.INTERNAL_ROLES & R.EXTERNAL_ROLES, frozenset())


# ── A partner record's kind becomes a session role, in one place ──────────────
#
# Three kinds, two roles. A sub-agency is an agency because it is paid
# commission and reads an agency statement; anything else is refused rather
# than guessed, so a corrupt `kind` on a record cannot mint a session role.

check("an agency signs in as an agency", R.partner_role_for("agency"), Role.AGENCY)
check("a sub-agency signs in as an agency", R.partner_role_for("sub_agency"), Role.AGENCY)
check("a seller signs in as a seller", R.partner_role_for("seller"), Role.SELLER)
for kind in ("", None, "owner", "staff", "wholesaler", "app_admin", "system"):
    try:
        R.partner_role_for(kind)
        failures.append(f"partner_role_for({kind!r}) returned a role")
    except ValueError:
        pass
for kind in ("agency", "sub_agency", "seller"):
    if R.partner_role_for(kind) not in R.EXTERNAL_ROLES:
        failures.append(f"partner_role_for({kind!r}) is not an external role")


# ── Team mapping ──────────────────────────────────────────────────────────────

check("app_admin team", R.team_of(Role.APP_ADMIN), Team.APP)
check("finance_member team", R.team_of(Role.FINANCE_MEMBER), Team.FINANCE)
check("marketing_admin team", R.team_of(Role.MARKETING_ADMIN), Team.MARKETING)
check("owner has no team", R.team_of(Role.OWNER), None)
check("observer has no team", R.team_of(Role.OBSERVER), None)
check("agency has no team", R.team_of(Role.AGENCY), None)

# Every staff role maps to exactly one team.
for role in R.STAFF_ROLES:
    if R.team_of(role) is None:
        failures.append(f"{role} has no team but is a staff role")

check("six departments", len(list(Team)), 6)
check("twelve staff roles", len(R.STAFF_ROLES), 12)
check("six team admins", len(R.ADMIN_ROLES), 6)
check("six team members", len(R.MEMBER_ROLES), 6)


# ── Enum values stringify to their value, not ClassName.MEMBER ────────────────

check("role stringifies to value", str(Role.FINANCE_ADMIN), "finance_admin")
check("team stringifies to value", str(Team.FINANCE), "finance")
check("role compares as string", Role.OWNER == "owner", True)


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print("\nAll authority checks passed.")
print("  · observer is read-only across every role check")
print("  · only owners sign money; team admins verify but never approve")
print("  · finance verifies any team's card; other admins only their own")
print("  · audit scope narrows correctly: all → team → self")
print("  · external is an allowlist of two roles, not the negation of internal")
print("  · three partner kinds become two session roles, and nothing else does")
sys.exit(0)
