"""The twenty capabilities, enforced on the server rather than in a browser.

WHAT THIS COVERS
----------------
`zipper-crm/lib/auth.ts` has always defined twenty permissions, written them
onto every `crmUsers` document and greyed out every control accordingly. None of
them was enforced anywhere on this side. The real gate on a privileged route was
`Depends(require_write)`, which admits every role that is not the observer and
not a partner — so a marketing member could ban any account on the platform, a
tech member could approve an agency, and a finance admin could invite staff
without holding `can_manage_team`.

So these tests ask four things, in the order the system now answers them:

  1. **The table is the front end's**, read out of `lib/auth.ts` rather than
     restated here — both the `Permission` union and `DEFAULT_PERMISSIONS`, and
     against `app/core/roles.PERMISSIONS` directly rather than only against the
     Firestore projection of it.
  2. **`has_permission` says what the CRM's `hasPermission` says**, including
     the `superadmin` short-circuit and the empty sets.
  3. **The dependency refuses**, with the real `require_permission`, the real
     `require_write` under it, and real sessions on top: an owner passes
     everything; a marketing member is refused ban, KYC, payout and the staff
     invite; a finance admin is refused the staff invite.
  4. **The routes actually wear it.** Read out of the router source with `ast`,
     not from a list somebody remembered to update — a gate removed from a route
     is a failing test rather than a silent regression.

No database and no network: `tests/harness.py` stubs the I/O, so everything
under `app/` exercised here is the real, unmodified code.

Run:  python3 -m tests.test_permissions
"""

from __future__ import annotations

import ast
import asyncio
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo_mod  # noqa: E402
from app.core import deps  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Permission, Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

TS_AUTH = ROOT.parent / "zipper-crm" / "lib" / "auth.ts"
ROUTERS = ROOT / "app" / "routers"


# ── Harness ───────────────────────────────────────────────────────────────────

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  ok    {name}")
    else:
        FAILED.append(name)
        print(f"  FAIL  {name}" + (f"\n          {detail}" if detail else ""))


def equal(name: str, actual, expected) -> None:
    check(name, actual == expected, f"expected {expected!r}\n          got      {actual!r}")


def run(coro):
    return asyncio.run(coro)


# ── Sessions and the staff rows behind them ───────────────────────────────────
#
# A permission-gated route re-reads the caller's role from Mongo before it grants
# anything (§19), so a session in this file is two things: the token claim and
# the `staff` row it must agree with. `session()` writes both, which is what
# makes the drift tests below meaningful — they take the two apart on purpose.

db = FakeDb()
mongo_mod.get_db = lambda: db  # type: ignore[assignment]


def session(role: Role, *, uid: str = "", on_record: Role | None = None,
            active: bool = True, row: bool = True) -> dict:
    """A live session for `role`, with a matching staff row unless told otherwise.

    `on_record` writes a DIFFERENT role to Mongo than the token carries, which is
    the state a script, a migration or a hand edit in Atlas leaves behind —
    none of them revokes a session.
    """
    uid = uid or f"uid-{role}"
    if row:
        run(
            db[C.STAFF].insert_one(
                {
                    "uid": uid,
                    "email": f"{uid}@example.com",
                    "name": str(role),
                    "role": str(on_record if on_record is not None else role),
                    "is_active": active,
                }
            )
        )
    return {"uid": uid, "email": f"{uid}@example.com", "name": str(role), "role": role}


async def through(dependency, user: dict):
    """Resolve the dependency the way FastAPI would.

    Calling a dependency function directly bypasses its `Depends` default,
    because FastAPI is what evaluates a default — so `require_write` would never
    run and the observer and partner refusals would go untested. This threads the
    one sub-dependency by hand, which is exactly what the framework does.
    """
    return await dependency(await deps.require_write(user))


def refused(name: str, dependency, user: dict, *, saying: str = "") -> str:
    """This must be refused with a 403, and the message must say the right thing."""
    try:
        run(through(dependency, user))
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "status_code", None)
        detail = str(getattr(exc, "detail", exc))
        if code != 403:
            check(name, False, f"raised {type(exc).__name__} with status {code}")
            return detail
        check(name, saying.lower() in detail.lower(), f"message was {detail!r}")
        return detail
    check(name, False, "was NOT refused")
    return ""


def allowed(name: str, dependency, user: dict) -> None:
    try:
        run(through(dependency, user))
    except Exception as exc:  # noqa: BLE001
        check(name, False, f"refused: {getattr(exc, 'detail', exc)!r}")
        return
    check(name, True)


# ══════════════════════════════════════════════════════════════════════════════
# 1. The table is the front end's, read out of lib/auth.ts
# ══════════════════════════════════════════════════════════════════════════════
#
# `tests/test_staff_directory.py` already pins `crm_directory.DEFAULT_PERMISSIONS`
# to the TypeScript. That is now the *projection*, so it proves the derived value
# is right and says nothing about the Python table it is derived from. These
# checks close the other half: `app/core/roles.PERMISSIONS`, role by role,
# against the same file, so neither end can drift.


def ts_permission_union(text: str) -> list[str]:
    """The `Permission` union members, in declaration order."""
    start = text.index("export type Permission =")
    end = text.index("export const DEFAULT_PERMISSIONS", start)
    body = text[start:end]
    return re.findall(r"\|\s*'([a-z_]+)'", body)


def ts_default_permissions(text: str) -> dict[str, list[str]]:
    """`DEFAULT_PERMISSIONS`, role name → permission strings.

    The same parser `tests/test_staff_directory.py` uses, deliberately: two
    readers of one TypeScript literal that disagreed about what it said would be
    worse than one.
    """
    start = text.index("export const DEFAULT_PERMISSIONS")
    start = text.index("{", start)
    depth = 0
    end = start
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = re.sub(r"//[^\n]*", "", text[start + 1 : end])
    return {
        m.group(1): re.findall(r"'([a-z_]+)'", m.group(2))
        for m in re.finditer(r"([A-Za-z_]+)\s*:\s*\[([^\]]*)\]", block)
    }


print("\nThe permission table is the front end's, read from zipper-crm/lib/auth.ts")

if not TS_AUTH.exists():  # pragma: no cover — the backend outside the monorepo
    check("zipper-crm/lib/auth.ts is present to compare against", False,
          f"{TS_AUTH} not found")
else:
    ts = TS_AUTH.read_text()
    union = ts_permission_union(ts)
    ts_table = ts_default_permissions(ts)

    equal("twenty capabilities, no more and no fewer", len(Permission), 20)
    equal(
        "the Permission enum is the TypeScript union, in the same order",
        [str(p) for p in Permission],
        union,
    )

    # Every CRM role in the front end has a Mongo role that maps onto it, and
    # every Mongo role except the observer has a CRM spelling. The observer is
    # the one deliberate absence — the CRM vocabulary has no read-only tier.
    mongo_for_crm = {
        **{crm_name: role for role, crm_name in crm.CRM_ROLE.items()},
        **{crm_name: role for role, crm_name in crm.PARTNER_CRM_ROLE.items()},
    }
    equal(
        "every role in the TypeScript table maps back to a Mongo role",
        sorted(ts_table),
        sorted(mongo_for_crm),
    )
    equal(
        "and the only Mongo role with no entry is the observer",
        sorted(str(r) for r in Role if r not in set(mongo_for_crm.values())),
        [str(Role.OBSERVER)],
    )
    check(
        "which holds nothing, stated in the table rather than defaulted",
        Role.OBSERVER in R.PERMISSIONS and R.PERMISSIONS[Role.OBSERVER] == frozenset(),
    )
    equal(
        "and every one of the sixteen roles has an entry — none falls through a default",
        sorted(str(r) for r in R.PERMISSIONS),
        sorted(str(r) for r in Role),
    )

    for crm_name in sorted(ts_table):
        role = mongo_for_crm[crm_name]
        equal(
            f"PERMISSIONS[{role}] matches {crm_name} in lib/auth.ts",
            sorted(str(p) for p in R.PERMISSIONS[role]),
            sorted(ts_table[crm_name]),
        )

    # And the Firestore projection is that same table, not a third opinion.
    equal(
        "crm_directory.DEFAULT_PERMISSIONS is derived from it, not copied beside it",
        {k: sorted(v) for k, v in crm.DEFAULT_PERMISSIONS.items()},
        {
            crm_name: sorted(str(p) for p in R.PERMISSIONS[mongo_for_crm[crm_name]])
            for crm_name in ts_table
        },
    )
    equal(
        "and it is written in enum order so a document diff stays readable",
        list(crm.DEFAULT_PERMISSIONS["superadmin"]),
        [str(p) for p in Permission],
    )


# ══════════════════════════════════════════════════════════════════════════════
# 2. has_permission — the CRM's `hasPermission`, in Python
# ══════════════════════════════════════════════════════════════════════════════

print("\nhas_permission, including the superadmin short-circuit")

check(
    "an owner holds every one of the twenty",
    all(R.has_permission(Role.OWNER, p) for p in Permission),
)
check(
    "and holds a capability added to the enum without being listed",
    R.PERMISSIONS[Role.OWNER] == frozenset(Permission),
)

for role in (Role.OBSERVER, Role.AGENCY, Role.SELLER):
    check(
        f"{role} holds none of them",
        not any(R.has_permission(role, p) for p in Permission),
    )

check("a marketing member may broadcast", R.has_permission(Role.MARKETING_MEMBER, Permission.CAN_SEND_BROADCASTS))
check("and may not ban", not R.has_permission(Role.MARKETING_MEMBER, Permission.CAN_BAN_USERS))
check("a finance admin may process a payout", R.has_permission(Role.FINANCE_ADMIN, Permission.CAN_PROCESS_PAYOUT))

# ── Every department admin manages their own department ──────────────────────
#
# Finance and Tech were the two that did not hold this, and the omission read as
# a decision rather than a gap: the CRM showed them an Invite button that
# answered 403. The organisation model is that all six departments run
# themselves, so the permission is theirs — and `services/staff.assignable_roles`
# narrows it to their own department at member tier, which is asserted in
# `tests/test_staff_hierarchy.py` rather than here.
for role in sorted(R.ADMIN_ROLES, key=str):
    check(f"{role} may manage their team", R.has_permission(role, Permission.CAN_MANAGE_TEAM))
for role in sorted(R.MEMBER_ROLES, key=str):
    check(f"{role} may not", not R.has_permission(role, Permission.CAN_MANAGE_TEAM))

# Fail closed on anything the model does not recognise.
for unknown in (R.SYSTEM_ROLE, "admin", "team", "", None, "superadmin"):
    check(
        f"{unknown!r} holds nothing",
        R.permissions_of(unknown) == frozenset()
        and not R.has_permission(unknown, Permission.CAN_BAN_USERS),
    )
check(
    "including 'superadmin' — that is the CRM's spelling, not a Mongo role",
    not R.has_permission("superadmin", Permission.CAN_BAN_USERS),
)

equal(
    "missing_permissions answers in enum order, not argument order",
    R.missing_permissions(
        Role.MARKETING_MEMBER,
        (Permission.CAN_MANAGE_TEAM, Permission.CAN_BAN_USERS),
    ),
    (Permission.CAN_BAN_USERS, Permission.CAN_MANAGE_TEAM),
)
equal(
    "and names nothing an owner is missing",
    R.missing_permissions(Role.OWNER, tuple(Permission)),
    (),
)


# ══════════════════════════════════════════════════════════════════════════════
# 3. require_permission — the real dependency, real sessions
# ══════════════════════════════════════════════════════════════════════════════

print("\nrequire_permission, with require_write underneath it")

BAN = deps.require_permission(Permission.CAN_BAN_USERS)
KYC = deps.require_permission(Permission.CAN_APPROVE_KYC)
PAYOUT = deps.require_permission(Permission.CAN_PROCESS_PAYOUT)
TEAM = deps.require_permission(Permission.CAN_MANAGE_TEAM)
BROADCAST = deps.require_permission(Permission.CAN_SEND_BROADCASTS)
ONBOARD = deps.require_permission(
    Permission.CAN_APPROVE_KYC, Permission.CAN_APPROVE_SELLER, any_of=True
)
BOTH = deps.require_permission(
    Permission.CAN_BAN_USERS, Permission.CAN_MANAGE_TEAM
)

owner = session(Role.OWNER)
marketing = session(Role.MARKETING_MEMBER)
finance_admin = session(Role.FINANCE_ADMIN)
tech_member = session(Role.TECH_MEMBER)
ops_admin = session(Role.OPS_ADMIN)
app_member = session(Role.APP_MEMBER)

# ── An owner passes everything ────────────────────────────────────────────────
for permission in Permission:
    allowed(f"an owner passes {permission}", deps.require_permission(permission), owner)
allowed("an owner passes a two-capability gate", BOTH, owner)
allowed("an owner passes an any-of gate", ONBOARD, owner)

# ── A marketing member is refused the four the audit named ───────────────────
message = refused(
    "a marketing member cannot ban a user", BAN, marketing, saying="can_ban_users"
)
refused("…cannot approve KYC", KYC, marketing, saying="can_approve_kyc")
refused("…cannot process a payout", PAYOUT, marketing, saying="can_process_payout")
refused("…cannot invite staff", TEAM, marketing, saying="can_manage_team")
refused("…cannot approve a partner either", ONBOARD, marketing, saying="can_approve")
allowed("but may still send a broadcast, which is their job", BROADCAST, marketing)

# The refusal names the capability that is missing and nothing else. A 403 that
# printed the role, or what the role does hold, would let one staff login
# enumerate the whole authority model from outside.
check("the refusal names the capability", "can_ban_users" in message)
check("and does not name the role", "marketing_member" not in message, message)
check(
    "and does not leak who does hold it",
    not any(str(r) in message for r in (Role.OWNER, Role.APP_ADMIN, Role.APP_MEMBER)),
    message,
)

# ── A finance admin invites, like every other department admin ───────────────
#
# This used to be a refusal, and the refusal was the defect: `POST /staff` is
# `require_team_admin` + `can_manage_team`, a finance admin satisfies the first
# and did not hold the second, so the button was live and the endpoint said no.
# Finance runs Finance. The narrowing to `finance_member` is the server's, in
# `assignable_roles`.
allowed("a finance admin may invite staff", TEAM, finance_admin)
allowed("and may process a payout", PAYOUT, finance_admin)
refused("a tech member cannot ban", BAN, tech_member, saying="can_ban_users")
allowed("an ops admin may invite staff", TEAM, ops_admin)
allowed("an ops admin may approve a partner", ONBOARD, ops_admin)
allowed("an app member may ban", BAN, app_member)
refused(
    "but not with a gate that also needs can_manage_team",
    BOTH,
    app_member,
    saying="can_manage_team",
)

# ── The two roles the guard underneath refuses ───────────────────────────────
observer = session(Role.OBSERVER, uid="uid-observer")
seller = {"uid": "uid-seller", "role": Role.SELLER, "partner_ids": {"seller": "s1"}}

refused("the observer is refused, read-only as ever", BAN, observer, saying="read-only")
refused("a partner is refused", BAN, seller, saying="partner accounts")

# ── A role this process cannot name ──────────────────────────────────────────
machine = {"uid": "system:weekly-accrual", "role": R.SYSTEM_ROLE}
stranger = {"uid": "uid-legacy", "role": "admin"}

refused(
    "a machine credential is refused a permission-gated route",
    BAN,
    machine,
    saying="requires a person",
)
refused(
    "and so is a role the model does not know",
    BAN,
    stranger,
    saying="could not be established",
)
check(
    "the unknown-role refusal does not blame the caller for a missing permission",
    "can_ban_users"
    not in refused("…and says so plainly", BAN, stranger, saying="sign in again"),
)


# ══════════════════════════════════════════════════════════════════════════════
# 4. §19 — the role is re-established from the record, for sensitive work only
# ══════════════════════════════════════════════════════════════════════════════
#
# `crm_directory.mirror()` can fail after the Mongo row is written, and a role
# changed by a script or by hand revokes no session at all. A token's role is a
# claim; the `staff` row is the record. Before anything privileged happens, the
# two must agree.

print("\n§19 — a sensitive action re-reads the role from the staff record")

drifted = session(Role.APP_ADMIN, uid="uid-drift", on_record=Role.APP_MEMBER)
gone = {"uid": "uid-no-row", "role": Role.APP_ADMIN}
switched_off = session(Role.APP_ADMIN, uid="uid-off", active=False)

refused(
    "a session whose role has moved under it is refused",
    BAN,
    drifted,
    saying="role has changed",
)
refused(
    "a session whose staff row has gone is refused",
    BAN,
    gone,
    saying="could not be found",
)
refused(
    "a deactivated account is refused even while its token lives",
    BAN,
    switched_off,
    saying="deactivated",
)
allowed("and an account that agrees with its record passes", BAN, app_member)

# Reads are deliberately untouched: the instruction is to fail closed on a
# sensitive operation, not to lock somebody out of the screen that would show
# them what is wrong. `require_internal` and `require_write` make no such check
# and must not start.
for name, guard in (("require_internal", deps.require_internal),
                    ("require_write", deps.require_write)):
    try:
        run(guard(drifted))
        check(f"{name} still admits the drifted session — reads do not fail", True)
    except Exception as exc:  # noqa: BLE001
        check(f"{name} still admits the drifted session — reads do not fail", False,
              f"refused: {getattr(exc, 'detail', exc)!r}")

# A gate that names nothing admits everybody, which is the bug this whole module
# exists to fix. It is refused when the dependency is built — at import time,
# where somebody sees it — rather than at the first request.
try:
    deps.require_permission()
    check("require_permission() with no capability is refused at build time", False,
          "it returned a dependency")
except ValueError as exc:
    check("require_permission() with no capability is refused at build time",
          "at least one" in str(exc), str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# 5. The routes actually wear the gate
# ══════════════════════════════════════════════════════════════════════════════
#
# Read out of the router source, so a gate deleted from a decorator is a failing
# test rather than a regression nobody is looking for. The same technique
# `tests/test_partner_session.py` uses to enumerate the API, applied to the
# `dependencies=[…]` list instead of the endpoint signature.

print("\nEvery privileged route declares the capability it needs")


def _permissions_in_call(node: ast.Call) -> tuple[frozenset[str], bool] | None:
    """`require_permission(Permission.X, …, any_of=…)` → (names, any_of)."""
    if not (isinstance(node.func, ast.Name) and node.func.id in
            {"require_permission", "enforce_permission"}):
        return None
    names = {
        a.attr
        for a in node.args
        if isinstance(a, ast.Attribute) and isinstance(a.value, ast.Name)
        and a.value.id == "Permission"
    }
    any_of = any(
        kw.arg == "any_of" and isinstance(kw.value, ast.Constant) and kw.value.value
        for kw in node.keywords
    )
    return frozenset(str(Permission[n]) for n in names), any_of


def gates_of(module: str) -> dict[tuple[str, str], tuple[frozenset[str], bool]]:
    """{(METHOD, path): (permissions, any_of)} declared by one router file."""
    tree = ast.parse((ROUTERS / f"{module}.py").read_text())

    prefix = ""
    aliases: dict[str, tuple[frozenset[str], bool]] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Name) and call.func.id == "APIRouter":
                for kw in call.keywords:
                    if kw.arg == "prefix" and isinstance(kw.value, ast.Constant):
                        prefix = str(kw.value.value)
            # `_BAN_USERS = Depends(require_permission(...))`
            if (
                isinstance(call.func, ast.Name)
                and call.func.id == "Depends"
                and call.args
                and isinstance(call.args[0], ast.Call)
            ):
                found = _permissions_in_call(call.args[0])
                if found and isinstance(node.targets[0], ast.Name):
                    aliases[node.targets[0].id] = found

    out: dict[tuple[str, str], tuple[frozenset[str], bool]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        # Anything the body enforces itself — the two routes that also accept a
        # service key cannot use a dependency and say so in their docstrings.
        names: set[str] = set()
        any_of = False
        for inner in ast.walk(node):
            if isinstance(inner, ast.Call):
                found = _permissions_in_call(inner)
                if found and isinstance(inner.func, ast.Name) and \
                        inner.func.id == "enforce_permission":
                    names |= set(found[0])
                    any_of = any_of or found[1]

        for decorator in node.decorator_list:
            if not (
                isinstance(decorator, ast.Call)
                and isinstance(decorator.func, ast.Attribute)
                and isinstance(decorator.func.value, ast.Name)
                and decorator.func.value.id == "router"
                and decorator.func.attr in {"get", "post", "put", "patch", "delete"}
                and decorator.args
                and isinstance(decorator.args[0], ast.Constant)
            ):
                continue
            declared, declared_any = set(names), any_of
            for kw in decorator.keywords:
                if kw.arg != "dependencies" or not isinstance(kw.value, ast.List):
                    continue
                for element in kw.value.elts:
                    if isinstance(element, ast.Name) and element.id in aliases:
                        found = aliases[element.id]
                    elif (
                        isinstance(element, ast.Call)
                        and isinstance(element.func, ast.Name)
                        and element.func.id == "Depends"
                        and element.args
                        and isinstance(element.args[0], ast.Call)
                    ):
                        found = _permissions_in_call(element.args[0])
                    else:
                        found = None
                    if found:
                        declared |= set(found[0])
                        declared_any = declared_any or found[1]
            out[(decorator.func.attr.upper(), f"{prefix}{decorator.args[0].value}")] = (
                frozenset(declared),
                declared_any,
            )
    return out


GATES: dict[tuple[str, str], tuple[frozenset[str], bool]] = {}
for module in ("users", "staff", "partner_ops", "verification", "chance", "cards",
               "role_appeals", "transfer_requests"):
    GATES.update(gates_of(module))

#: What each privileged route must ask for. Written out rather than derived, so
#: that moving a route onto a weaker capability is a diff somebody reads.
EXPECTED: dict[tuple[str, str], set[str]] = {
    # ── Moderation — the four operations plus the devices they touch ─────────
    ("POST", "/users/{uid}/ban"): {"can_ban_users"},
    ("POST", "/users/{uid}/unban"): {"can_ban_users"},
    ("POST", "/users/{uid}/suspend"): {"can_ban_users"},
    ("POST", "/users/{uid}/resume"): {"can_ban_users"},
    ("POST", "/users/devices/bans"): {"can_ban_users"},
    ("POST", "/users/devices/bans/{device_id}/unban"): {"can_ban_users"},
    # An overturn unbans, so it costs what unbanning costs.
    ("POST", "/users/appeals/{appeal_id}/decide"): {"can_ban_users"},
    # UGP review: the private attachments are read by the people who decide.
    ("GET", "/users/appeals/{appeal_id}/evidence"): {"can_ban_users"},
    # ── Balance ─────────────────────────────────────────────────────────────
    ("POST", "/users/{uid}/balance-request"): {"can_adjust_balance"},
    ("POST", "/users/balance-cards/{card_id}/execute"): {"can_adjust_balance"},
    # ── Hosts and KYC ───────────────────────────────────────────────────────
    ("POST", "/users/host-applications/{application_id}/decide"): {"can_approve_kyc"},
    (
        "POST",
        "/users/host-applications/{application_id}/pending-changes/decide",
    ): {"can_approve_kyc"},
    # `/users/{uid}/grant-host` no longer exists: a host comes through an
    # application decided at `/users/host-applications/{id}/decide`.
    ("POST", "/users/{uid}/revoke-host"): {"can_approve_kyc"},
    # UGP-B: restoring a revoked Host costs what revoking it costs.
    ("POST", "/users/{uid}/restore-host"): {"can_approve_kyc"},
    ("POST", "/users/{uid}/seller-flag"): {"can_approve_seller"},
    ("GET", "/host-verification/pending"): {"can_approve_kyc"},
    ("GET", "/host-verification/{uid}"): {"can_approve_kyc"},
    ("POST", "/host-verification/{uid}/review"): {"can_approve_kyc"},
    # ── Staff ───────────────────────────────────────────────────────────────
    ("POST", "/staff"): {"can_manage_team"},
    ("PATCH", "/staff/{uid}/role"): {"can_manage_team"},
    ("PATCH", "/staff/{uid}/employment"): {"can_manage_team"},
    ("POST", "/staff/{uid}/deactivate"): {"can_manage_team"},
    # P1-B2 / B3 — same authority as deactivation.
    ("POST", "/staff/{uid}/suspend"): {"can_manage_team"},
    ("POST", "/staff/{uid}/reactivate"): {"can_manage_team"},
    # ── Partner onboarding ──────────────────────────────────────────────────
    ("POST", "/partner-ops/partners"): {"can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/approve"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/reject"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/deactivate"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/reactivate"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/revoke"): {
        "can_approve_kyc", "can_approve_seller"},
    # Decision 15 (RC): start an Owner-approved role whose contacts are now
    # both verified. Same gate as approving it, and it never bypasses them.
    ("POST", "/partner-ops/partners/{partner_id}/activate"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/attach-login"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/grant-capability"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/second-role"): {
        "can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/partners/{partner_id}/pending-changes/decide"): {
        "can_approve_kyc"},
    ("POST", "/partner-ops/partners/{partner_id}/virtual-account"): {
        "can_approve_seller"},
    # ── Seller credit and inventory ─────────────────────────────────────────
    ("POST", "/partner-ops/coin-purchases/{card_id}/execute"): {"can_coin_operations"},
    ("POST", "/partner-ops/sellers/{seller_id}/lending"): {"can_coin_operations"},
    ("POST", "/partner-ops/lending/{card_id}/execute"): {"can_coin_operations"},
    ("POST", "/partner-ops/sellers/{seller_id}/repayments"): {"can_coin_operations"},
    ("POST", "/partner-ops/repayments/{card_id}/execute"): {"can_coin_operations"},
    ("POST", "/partner-ops/sellers/{seller_id}/recoveries"): {"can_coin_operations"},
    ("POST", "/partner-ops/recoveries/{card_id}/execute"): {"can_coin_operations"},
    ("POST", "/partner-ops/partners/{partner_id}/write-off"): {"can_coin_operations"},
    ("POST", "/partner-ops/write-offs/{card_id}/execute"): {"can_coin_operations"},
    ("POST", "/partner-ops/sales/{sale_id}/approve"): {"can_coin_operations"},
    # Manual recharge through a Coin Seller — money moves, same gate as a sale.
    ("POST", "/partner-ops/recharges/{recharge_id}/approve"): {"can_coin_operations"},
    ("POST", "/partner-ops/recharges/{recharge_id}/reject"): {"can_coin_operations"},
    ("POST", "/partner-ops/recharges/{recharge_id}/refund"): {"can_coin_operations"},
    ("POST", "/partner-ops/recharges/{recharge_id}/refund/decide"): {"can_coin_operations"},
    # ── Money out ───────────────────────────────────────────────────────────
    ("POST", "/partner-ops/agencies/{agency_id}/commission-payouts"): {
        "can_process_payout"},
    ("POST", "/partner-ops/commission-payouts/{card_id}/execute"): {
        "can_process_payout"},
    ("POST", "/partner-ops/agencies/{agency_id}/commission-accruals"): {
        "can_process_payout"},
    ("POST", "/partner-ops/hosts/{host_uid}/withdrawals"): {"can_process_payout"},
    ("POST", "/partner-ops/host-withdrawals/{card_id}/execute"): {"can_process_payout"},
    ("POST", "/partner-ops/subagency-payouts"): {"can_process_payout"},
    ("POST", "/partner-ops/subagency-payouts/{card_id}/execute"): {"can_process_payout"},
    ("POST", "/partner-ops/subagency-payouts/{payout_id}/confirm-leg"): {
        "can_process_payout"},
    # ── Economy configuration ───────────────────────────────────────────────
    ("POST", "/chance/configs/preview"): {"can_economy_config"},
    ("POST", "/chance/mechanics"): {"can_economy_config"},
    ("POST", "/chance/mechanics/{mechanic_id}/configs"): {"can_economy_config"},
    ("POST", "/chance/configs/{card_id}/activate"): {"can_economy_config"},
    ("POST", "/chance/mechanics/{mechanic_id}/withdraw-country"): {"can_economy_config"},
    # ── The SA approval queue ───────────────────────────────────────────────
    ("POST", "/cards/{card_id}/sign"): {"can_approve_requests"},
    ("POST", "/cards/sign-bulk"): {"can_approve_requests"},
    # ── The queue verdict that is not a dependency ──────────────────────────
    # The action is in the body, so the route carries the floor and the verdicts
    # that ban or take money carry their own — see `_REPORT_ACTION_PERMISSION`.
    ("POST", "/users/reports/{report_id}/action"): {"can_view_users"},
    ("POST", "/users/{uid}/warn"): {"can_view_users"},
    # ── C2 — reinstatement of a revoked role ────────────────────────────────
    # Reviewers of either kind reach the queue and the recommendation; the
    # per-kind check is the service's, and DECIDING declares no capability on
    # purpose — it is the Owner's, refused in the service for everybody else.
    ("GET", "/partner-ops/role-appeals"): {"can_approve_kyc", "can_approve_seller"},
    ("POST", "/partner-ops/role-appeals/{appeal_id}/recommend"): {
        "can_approve_kyc", "can_approve_seller"},
    # ── C3 — transfers: requested by a KYC reviewer, decided by the Owner ──
    ("POST", "/partner-ops/transfers"): {"can_approve_kyc"},
    ("GET", "/partner-ops/transfers"): {"can_approve_kyc"},
}

for key, wanted in sorted(EXPECTED.items()):
    declared = GATES.get(key)
    if declared is None:
        check(f"{key[0]} {key[1]} is a route that exists", False, "no such route")
        continue
    equal(f"{key[0]} {key[1]} requires {', '.join(sorted(wanted))}",
          sorted(declared[0]), sorted(wanted))

# The two the audit named, stated as the properties they are rather than as two
# more rows in the table above.
check(
    "POST /staff/{uid}/deactivate is at least as strict as PATCH /{uid}/role",
    GATES[("POST", "/staff/{uid}/deactivate")][0]
    >= GATES[("PATCH", "/staff/{uid}/role")][0],
)
check(
    "partner approval is not plain require_write any more",
    bool(GATES[("POST", "/partner-ops/partners/{partner_id}/approve")][0]),
)
check(
    "and it is an any-of gate, because one route serves both kinds of partner",
    GATES[("POST", "/partner-ops/partners/{partner_id}/approve")][1],
)
for role in (Role.FINANCE_ADMIN, Role.TECH_ADMIN):
    check(
        f"{role} holds can_manage_team — their department is theirs to run",
        R.has_permission(role, Permission.CAN_MANAGE_TEAM),
    )

# Every route that reads `require_permission` or `enforce_permission` is in the
# table above. A gate added without a line here is a gate nobody has agreed to.
for key, (declared, _any) in sorted(GATES.items()):
    if declared:
        check(f"{key[0]} {key[1]} is accounted for above", key in EXPECTED)


# ── Result ────────────────────────────────────────────────────────────────────

print("\n" + "=" * 74)
print(f"  {len(PASSED)} passed, {len(FAILED)} failed")
print("=" * 74 + "\n")
if FAILED:
    sys.exit(1)

print("  · the twenty capabilities are read out of zipper-crm/lib/auth.ts")
print("  · roles.PERMISSIONS matches it role by role, and crm_directory derives from it")
print("  · an owner passes every gate; a marketing member passes none of the four")
print("  · all six department admins may invite, narrowed to their own department")
print("  · a sensitive action re-reads the role from Mongo; reads are untouched")
print("  · every gated route is enumerated from the router source, not from memory")
sys.exit(0)
