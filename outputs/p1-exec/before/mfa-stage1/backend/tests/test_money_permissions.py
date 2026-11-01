"""THE NINE MONEY CLAUSES — who may move coins, proved role by role.

`isAdmin()` in `firestore.rules` matches `.*_admin`. It is a question about how a
role is SPELLED, and on a money collection the answer is wrong: marketing_admin
and support_admin both satisfy it, and neither department has any business
approving a recharge. That is not a hypothetical — flipping `rechargeRequests`
status to 'approved' fires `onRechargeApproved`, which debits a seller's coin
inventory and credits a buyer's diamonds inside a transaction.

This file proves the replacement, for every role, on every changed operation.

── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────

There is no Firestore emulator in this environment and no way to obtain one: the
firebase CLI is absent, `@firebase/rules-unit-testing` is absent, and both the
npm and PyPI registries answer 403. So these are NOT rules-unit tests and must
not be reported as equivalent to them. The rules in this repo have not been
compiled.

What this is instead is a model of the four predicates the money clauses depend
on, evaluated over real data:

  * The PERMISSION facts come from `app.core.roles.PERMISSIONS` by import — the
    same table the server enforces and the same table `crm_directory.write()`
    projects into `crmUsers.permissions`. Granting `can_coin_operations` to
    marketing_admin in `roles.py` fails this file.

  * The RULE EXPRESSIONS are extracted from `firestore.rules` as text and PINNED:
    each model carries the exact expression it claims to implement, and the test
    fails if the file no longer says that. So the model cannot drift away from
    the rule quietly — an edit to either side breaks the pin and forces the
    other to be updated deliberately.

That pin is the whole reason to trust anything below. Without it this would be a
test of my own paraphrase.

Run:  python3 -m tests.test_money_permissions
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = (ROOT.parent / "firestore.rules").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from app.services.crm_directory import DEFAULT_PERMISSIONS  # noqa: E402

failures: list[str] = []
checks = 0


def ok(label: str, condition: bool) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual != expected:
        failures.append(f"{label}\n    expected {expected!r}\n    got      {actual!r}")


# ══════════════════════════════════════════════════════════════════════════════
#  Reading the rules file
# ══════════════════════════════════════════════════════════════════════════════


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def squash(text: str) -> str:
    """Collapse whitespace, so a reflowed rule still matches its pin.

    A space before a member access is also removed. `get(...)\\n  .data.get(...)`
    is how the rules wrap a long chain, and squashing alone leaves `) .data`,
    which no pin would ever be written with. Nothing else is normalised: the
    point of a pin is to notice changes, so it stays strict about everything
    that could alter meaning.
    """
    return " ".join(text.split()).replace(" .", ".")


def block(name: str) -> str:
    """One `match` block from the rules, by collection name.

    Brace counting starts at the brace that ENDS the match line, not at the
    `match` keyword: the path contains a wildcard — `match /rechargeRequests/{reqId}`
    — which opens and closes a brace before the body begins, so a counter started
    at the keyword closes the block on its first line and every assertion made
    against the result is vacuously true. That bug was real and silent.
    """
    start = RULES.index(f"match /{name}/")
    body = RULES.index("{", RULES.index("\n", start) - 2)
    depth = 0
    for i in range(body, len(RULES)):
        if RULES[i] == "{":
            depth += 1
        elif RULES[i] == "}":
            depth -= 1
            if depth == 0:
                return RULES[start : i + 1]
    raise AssertionError(f"unterminated match block for {name}")


def helper(name: str) -> str:
    """The body of a top-level rules function, comments stripped and squashed.

    Matched on `function <name>(` rather than `<name>()` because `hasPerm(p)`
    takes an argument and the exact-parens form silently misses it.
    """
    src = strip_comments(RULES)
    start = src.index(f"function {name}(")
    body = src.index("{", start)
    depth = 0
    for i in range(body, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                inner = src[body + 1 : i]
                return squash(inner.replace("return", "", 1).strip().rstrip(";"))
    raise AssertionError(f"unterminated function {name}")


def allow(collection: str, op: str) -> str:
    """The condition of one `allow <op>:` line in a collection's block.

    Matched on the operation list so `allow write` is not confused with
    `allow update`, and the condition is returned squashed for pinning.
    """
    body = strip_comments(block(collection))
    m = re.search(rf"allow\s+([\w,\s]*\b{op}\b[\w,\s]*):\s*if\s*(.*?);", body, re.S)
    if not m:
        raise AssertionError(f"no `allow {op}` in {collection}")
    return squash(m.group(2))


# ══════════════════════════════════════════════════════════════════════════════
#  The principals
# ══════════════════════════════════════════════════════════════════════════════
#
# `crm` is the crmUsers document, or None where there is none. Absence is not a
# detail: the OBSERVER has no crmUsers document at all — `crm_directory.NOT_MIRRORED`
# refuses to write one, because the CRM vocabulary has no read-only tier and any
# document it were given would grant write access on every Firestore-backed page.
# To this file the observer is therefore indistinguishable from an app user, which
# is exactly the intended outcome and is asserted as such below.


def crm_doc(role: str, *, active: bool = True) -> dict:
    return {
        "role": role,
        "isActive": active,
        "permissions": list(DEFAULT_PERMISSIONS.get(role, ())),
    }


PRINCIPALS: dict[str, dict | None] = {
    "anonymous": None,                      # no auth at all
    "app_user": None,                       # signed in, no crmUsers document
    "host": None,                           # likewise — a host is an app account
    "observer": None,                       # NOT_MIRRORED: no document by design
    "owner": crm_doc("superadmin"),
    "app_admin": crm_doc("app_admin"),
    "app_member": crm_doc("app_member"),
    "ops_admin": crm_doc("ops_admin"),
    "ops_member": crm_doc("ops_member"),
    "finance_admin": crm_doc("finance_admin"),
    "finance_member": crm_doc("finance_member"),
    "tech_admin": crm_doc("tech_admin"),
    "tech_member": crm_doc("tech_member"),
    "support_admin": crm_doc("support_admin"),
    "support_member": crm_doc("support_member"),
    "marketing_admin": crm_doc("marketing_admin"),
    "marketing_member": crm_doc("marketing_member"),
    "seller": crm_doc("seller"),
    "agency": crm_doc("agency"),
    "deactivated_finance_admin": crm_doc("finance_admin", active=False),
}

#: Signed in? Only `anonymous` is not. Needed because `isCrmUser()` leads with
#: `request.auth != null` and a document cannot exist without one.
AUTHED = {name: name != "anonymous" for name in PRINCIPALS}


# ══════════════════════════════════════════════════════════════════════════════
#  The model — each piece pinned to the text it implements
# ══════════════════════════════════════════════════════════════════════════════


def is_crm_user(p: str) -> bool:
    return AUTHED[p] and PRINCIPALS[p] is not None and PRINCIPALS[p]["isActive"] is not False


def crm_role(p: str) -> str:
    doc = PRINCIPALS[p]
    return "" if doc is None else doc.get("role", "")


def crm_permissions(p: str) -> list[str]:
    doc = PRINCIPALS[p]
    return [] if doc is None else doc.get("permissions", [])


def is_super_admin(p: str) -> bool:
    return is_crm_user(p) and crm_role(p) == "superadmin"


def has_perm(p: str, perm: str) -> bool:
    return is_crm_user(p) and (crm_role(p) == "superadmin" or perm in crm_permissions(p))


def can_decide_coin_ops(p: str) -> bool:
    return is_super_admin(p) or (
        has_perm(p, "can_coin_operations") and crm_role(p) == "finance_admin"
    )


def is_tech(p: str) -> bool:
    return is_crm_user(p) and crm_role(p) in [
        "superadmin", "admin", "tech", "tech_admin", "tech_member",
    ]


#: (rules function name, the exact expression it must still say, the model).
#: The pin is what makes the model trustworthy: edit the rule and this fails.
PINS: list[tuple[str, str, object]] = [
    (
        "isCrmUser",
        "request.auth != null && exists(/databases/$(database)/documents/crmUsers/$(request.auth.uid)) "
        "&& get(/databases/$(database)/documents/crmUsers/$(request.auth.uid)).data.get('isActive', true) != false",
        is_crm_user,
    ),
    ("isSuperAdmin", "isCrmUser() && crmRole() == 'superadmin'", is_super_admin),
    (
        "hasPerm",
        "isCrmUser() && (crmRole() == 'superadmin' || p in crmPermissions())",
        None,
    ),
    (
        "canDecideCoinOps",
        "isSuperAdmin() || (hasPerm('can_coin_operations') && crmRole() == 'finance_admin')",
        can_decide_coin_ops,
    ),
    (
        "isTech",
        "isCrmUser() && crmRole() in ['superadmin', 'admin', 'tech', 'tech_admin', 'tech_member']",
        is_tech,
    ),
]


print("── the model is pinned to the rule text ──────────────────────────────────")
for name, expected, _ in PINS:
    # `hasPerm(p)` takes an argument, so its signature is not `name()`.
    probe = name if name != "hasPerm" else "hasPerm"
    src = strip_comments(RULES)
    idx = src.find(f"function {probe}(")
    ok(f"{name}() exists in firestore.rules", idx != -1)
    if idx == -1:
        continue
    body = src.index("{", idx)
    depth, actual = 0, ""
    for i in range(body, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                actual = squash(src[body + 1 : i].replace("return", "", 1).strip().rstrip(";"))
                break
    check(f"{name}() still says what the model implements", actual, expected)


# ══════════════════════════════════════════════════════════════════════════════
#  1 — can_coin_operations belongs to Finance and the owner, and to nobody else
# ══════════════════════════════════════════════════════════════════════════════
#
# The load-bearing fact. `canDecideCoinOps()` is only as narrow as this table,
# and this table is the real one — imported, not transcribed.

print("\n── who holds can_coin_operations, from roles.PERMISSIONS ─────────────────")
holders = sorted(r for r, perms in DEFAULT_PERMISSIONS.items() if "can_coin_operations" in perms)
check(
    "exactly Finance and the owner hold can_coin_operations",
    holders,
    ["finance_admin", "finance_member", "superadmin"],
)

for role in ("app_admin", "ops_admin", "tech_admin", "support_admin", "marketing_admin"):
    ok(
        f"{role} does NOT hold can_coin_operations — _admin in the name grants nothing",
        "can_coin_operations" not in DEFAULT_PERMISSIONS[role],
    )

for role in ("agency", "seller"):
    ok(
        f"the {role} partner role holds no permissions at all",
        DEFAULT_PERMISSIONS[role] == (),
    )

ok(
    "the observer has no CRM role to hold permissions under",
    "observer" not in DEFAULT_PERMISSIONS,
)


# ══════════════════════════════════════════════════════════════════════════════
#  2 — the matrix
# ══════════════════════════════════════════════════════════════════════════════

#: Who is allowed, per changed operation. Everyone absent from the set is denied,
#: and the loop below asserts the denial explicitly for every one of them — so a
#: role added to PRINCIPALS cannot slip through untested.
MATRIX: dict[str, tuple[object, set[str]]] = {
    # The money-moving document is NOBODY's to write from a client now. The
    # API decides recharges (services/recharges.py) through the Admin SDK and
    # credits through the ledger; the rule is `allow create, update: if false`
    # and `allow delete: if false`. Not even the owner — a browser write that
    # the server must then undo is not an authority.
    "rechargeRequests.update (no client)": (lambda p: False, set()),
    "rechargeRequests.delete (no client)": (lambda p: False, set()),
    # Rejection only, by Finance admin or the owner; approval left the browser.
    "coinPurchaseRequests.update": (can_decide_coin_ops, {"owner", "finance_admin"}),
    "coinPurchaseRequests.delete": (is_super_admin, {"owner"}),
    # Configuration, not money movement — Tech department, members included,
    # matching the already-reviewed appConfig decision.
    "paymentConfig.write": (is_tech, {"owner", "tech_admin", "tech_member"}),
}

DEPT_ADMINS_OFF_DUTY = {"app_admin", "ops_admin", "support_admin", "marketing_admin"}
MEMBERS = {
    "app_member", "ops_member", "finance_member",
    "tech_member", "support_member", "marketing_member",
}
OUTSIDERS = {"anonymous", "app_user", "host", "observer", "seller", "agency"}

print("\n── the matrix: every principal, every changed operation ──────────────────")
for label, (model, allowed) in MATRIX.items():
    for name in PRINCIPALS:
        want = name in allowed
        got = bool(model(name))
        check(f"{label:44} {name:26} {'ALLOW' if want else 'deny '}", got, want)

print("\n── the six groups the matrix has to get right ────────────────────────────")
for label, (model, allowed) in MATRIX.items():
    # "owner allowed" holds for every operation with a staff authority. The two
    # rechargeRequests rows have NONE — the owner is denied there too, by
    # design — so for them the assertion is the opposite.
    if not allowed:
        ok(f"{label}: owner DENIED — no client authority exists", not model("owner"))
    else:
        ok(f"{label}: owner allowed", model("owner"))
    for name in DEPT_ADMINS_OFF_DUTY:
        ok(f"{label}: {name} denied — unrelated department", not model(name))
    for name in OUTSIDERS:
        ok(f"{label}: {name} denied — not staff", not model(name))
    ok(
        f"{label}: a DEACTIVATED finance admin is denied",
        not model("deactivated_finance_admin"),
    )

# Members: denied on every money operation. `paymentConfig` is the stated
# exception and is asserted as one rather than skipped, so the exception stays
# visible and deliberate instead of becoming an unnoticed gap.
for label, (model, _) in MATRIX.items():
    if label == "paymentConfig.write":
        ok("paymentConfig: tech_member ALLOWED — configuration, per appConfig", model("tech_member"))
        for name in MEMBERS - {"tech_member"}:
            ok(f"paymentConfig: {name} denied", not model(name))
        continue
    for name in MEMBERS:
        ok(f"{label}: {name} denied — a member does not decide", not model(name))

ok(
    "finance_member holds can_coin_operations and is STILL denied the decision",
    "can_coin_operations" in DEFAULT_PERMISSIONS["finance_member"]
    and not can_decide_coin_ops("finance_member"),
)
ok(
    "tech_admin is denied every coin operation",
    not can_decide_coin_ops("tech_admin") and not is_super_admin("tech_admin"),
)
ok(
    "tech_admin IS allowed paymentConfig — its own department's configuration",
    is_tech("tech_admin"),
)


# ══════════════════════════════════════════════════════════════════════════════
#  3 — the clauses say what the matrix assumed
# ══════════════════════════════════════════════════════════════════════════════
#
# The matrix above evaluates models. These assertions tie each model to the
# clause it stands for, so the pair means something together.

print("\n── the rule text itself ──────────────────────────────────────────────────")

# The seller's own-sale path and the finance break-glass path are both gone:
# every write to this collection is the API's. Pinned on the rule text.
check("rechargeRequests create/update is closed to every client",
      allow("rechargeRequests", "update"), "false")
check("rechargeRequests.create is the same clause", allow("rechargeRequests", "create"), "false")
check("rechargeRequests.delete is closed too — even to the owner",
      allow("rechargeRequests", "delete"), "false")
ok("no seller clause survives", "sellerUid', '') == request.auth.uid" not in strip_comments(block("rechargeRequests")).split("allow read")[0] + strip_comments(block("rechargeRequests")).split("allow create")[-1])

cpr_update = allow("coinPurchaseRequests", "update")
ok("coinPurchaseRequests.update is gated by canDecideCoinOps()", "canDecideCoinOps()" in cpr_update)
ok("coinPurchaseRequests.update no longer admits isAdmin()", "isAdmin()" not in cpr_update)
ok(
    "and it can only reject — browser approval is gone for good",
    "request.resource.data.get('status', '') == 'rejected'" in cpr_update,
)
check("coinPurchaseRequests.delete is the owner alone", allow("coinPurchaseRequests", "delete"), "isSuperAdmin()")

cpr_create = allow("coinPurchaseRequests", "create")
ok(
    "a coin purchase is born pending — nobody files one pre-approved",
    "request.resource.data.get('status', '') == 'pending'" in cpr_create,
)
ok("staff do not file a purchase on a seller's behalf from a browser", "isAdmin()" not in cpr_create)
ok(
    "the seller's own two bindings are both present",
    ".data.get('crmUid', '') == request.auth.uid" in cpr_create
    and "request.resource.data.get('sellerUid', '') == request.auth.uid" in cpr_create,
)

# The two dead collections. `allow write: if false` is the assertion: Admin SDK
# writes bypass rules entirely, so closing these costs the server nothing.
for dead in ("coinPurchases", "rechargeHistory"):
    body = strip_comments(block(dead))
    check(f"{dead} is closed to every client write", allow(dead, "write"), "false")
    for op in ("create", "update", "delete"):
        ok(
            f"{dead} has no separate `allow {op}` to undo that",
            not re.search(rf"allow\s+[\w,\s]*\b{op}\b[\w,\s]*:", body),
        )
    ok(f"{dead} is still readable by staff", "isStaff()" in body)

ok(
    "rechargeHistory no longer lets any CRM user write into another seller's ledger",
    "allow create: if isAdmin() || isCrmUser()" not in squash(strip_comments(block("rechargeHistory"))),
)

pc_write = allow("paymentConfig", "write")
check("paymentConfig is Tech or the owner", pc_write, "isTech() || isSuperAdmin()")
ok("paymentConfig no longer admits every *_admin", "isAdmin()" not in pc_write)


# ══════════════════════════════════════════════════════════════════════════════
#  4 — the capability model is actually read now
# ══════════════════════════════════════════════════════════════════════════════
#
# Before this patch the rules NAMED capabilities in comments and gated on role
# strings. `crmPermissions()` existing is the difference between a documented
# intention and an enforced one.

print("\n── the rules read the permission array ───────────────────────────────────")
ok("crmPermissions() reads crmUsers.permissions", "permissions" in helper("crmPermissions"))
ok("hasPerm() short-circuits the owner on role, not on the array", "crmRole() == 'superadmin'" in helper("hasPerm"))
ok(
    "canDecideCoinOps() asks for the capability, not for a name ending in _admin",
    "can_coin_operations" in helper("canDecideCoinOps"),
)
ok(
    "and it does not reach isAdmin()",
    "isAdmin()" not in helper("canDecideCoinOps"),
)


# ══════════════════════════════════════════════════════════════════════════════
#  5 — four server-written collections that `isAdmin()` opened to a browser
# ══════════════════════════════════════════════════════════════════════════════
#
# Not part of the nine, and changed anyway, because each is the same defect in a
# pure form: the Admin SDK bypasses this file, so `allow write: if isAdmin()` on
# a server-written collection grants the server NOTHING and grants a browser held
# by any `.*_admin` everything. Three of them had a comment directly above saying
# "written only by Cloud Functions" and then said `isAdmin()` anyway.
#
# Closing a write clause is only safe if nothing legitimate uses it. Each was
# checked across all four codebases; every remaining reference is a read.

print("\n── server-written collections, now closed to clients ────────────────────")

SERVER_ONLY = {
    # collection: (what a forged write would buy, the real writers)
    "hostVerification": "a host's payout approval",
    "publicProfiles": "a permanent top slot on everybody's discover feed",
    "agencyHosts": "moving a host's commission to another agency",
    "commissionLedger": "a forged record of what an agency was paid",
}

for name, prize in SERVER_ONLY.items():
    body = strip_comments(block(name))
    check(f"{name} is closed to client writes — would have bought {prize}", allow(name, "write"), "false")
    ok(f"{name} has no isAdmin() write left", not re.search(r"allow\s+write:\s*if\s*isAdmin", body))
    for op in ("create", "update", "delete"):
        ok(
            f"{name} has no separate `allow {op}` reopening it",
            not re.search(rf"allow\s+[\w,\s]*\b{op}\b[\w,\s]*:", body),
        )
    # Reads must survive: closing a write is not a reason to blind the app or the
    # agency dashboard that reads these.
    ok(f"{name} is still readable", re.search(r"allow\s+(read|get|list)", body) is not None)

ok(
    "publicProfiles stays readable by every signed-in account — the feed depends on it",
    "allow read:  if request.auth != null" in block("publicProfiles"),
)
ok(
    "hostVerification stays readable by the host and by staff only",
    "isOwner(uid) || isStaff()" in strip_comments(block("hostVerification")),
)


# ══════════════════════════════════════════════════════════════════════════════
#  6 — the ~55 moderation clauses were NOT touched
# ══════════════════════════════════════════════════════════════════════════════
#
# The brief was a money patch, not a permission rewrite. If this count moves,
# something outside the nine changed and wants explaining.

print("\n── blast radius ─────────────────────────────────────────────────────────")
executable = strip_comments(RULES)
remaining = len(re.findall(r"isAdmin\(\)", executable))
ok(
    f"isAdmin() still governs the operational collections ({remaining} clauses)",
    # Phase 1A removed a handful of `isAdmin()` arms on purpose (the crmUsers
    # partner-status arm; agencies/sellers/hostApplications admin arms now
    # carry extra guards). The tripwire still catches a large unexplained move.
    60 <= remaining <= 90,
)
for keep in ("feedbackTickets", "supportTickets", "announcements"):
    ok(f"{keep} is untouched and still isAdmin()", "isAdmin()" in strip_comments(block(keep)))


# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} money-permission checks passed.")
print("  · rechargeRequests: no client write of any kind; the API alone decides")
print("  · coinPurchaseRequests: rejection only from a browser; born pending")
print("  · rechargeHistory: no CRM user can write into another seller's ledger")
print("  · coinPurchases: a dead collection is no longer writable")
print("  · paymentConfig: Tech and the owner, matching appConfig")
print("  · deletes on money records: the owner alone")
print("  · a deactivated finance admin is denied all of it")
print()
print("  NOT a rules-unit test. No emulator exists in this environment, so the")
print("  rules in this repo are UNCOMPILED. This is a pinned model over the real")
print("  permission table — see the module docstring.")
sys.exit(0)
