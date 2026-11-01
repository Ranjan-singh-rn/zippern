"""The internal half of the Storage role claim.

`storage.rules` authorises on `request.auth.token.role`. This module is what
puts an INTERNAL role there, and the property worth testing is as much what it
refuses as what it writes:

  * it never grants a claim for `agency` or `seller`, because those belong to
    the Firestore trigger and two authorities writing the same key would race
    on every staff edit;
  * it preserves claims it does not own, because `set_custom_user_claims`
    REPLACES the whole object and a blind write would silently drop one;
  * it reports failure instead of raising, because a claim that could not be
    written must not roll back a staff invitation that already succeeded — but
    must not vanish either.

REAL: `app.services.storage_claims`, imported and called.
FAKE: `firebase_admin.auth`, from `tests/harness.py`, with the user store
      swapped for a dict so a write can be read back.

    python3 -m tests.test_storage_claims
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

import firebase_admin.auth as fb_auth  # noqa: E402

from app.core.roles import EXTERNAL_ROLES, INTERNAL_ROLES, Role  # noqa: E402
from app.services import storage_claims  # noqa: E402

checks = 0
failures = 0


def ok(claim: str, cond: bool) -> None:
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
        print(f"  FAIL  {claim}")


def eq(claim: str, got, want) -> None:
    global checks, failures
    checks += 1
    if got != want:
        failures += 1
        print(f"  FAIL  {claim}\n        got {got!r}, want {want!r}")


# ── A user store the fake auth module reads and writes ──────────────────────

USERS: dict[str, dict] = {}


class _User:
    def __init__(self, claims):
        self.custom_claims = claims


def _get_user(uid):
    if uid not in USERS:
        raise RuntimeError(f"no such user {uid}")
    return _User(dict(USERS[uid]))


def _set_claims(uid, claims):
    USERS[uid] = dict(claims or {})


fb_auth.get_user = _get_user
fb_auth.set_custom_user_claims = _set_claims


def reset(uid="u1", claims=None):
    USERS.clear()
    USERS[uid] = dict(claims or {})


# ── 1. claim_for: the vocabulary ────────────────────────────────────────────
print("\n1. Which roles earn an internal claim")

for role in INTERNAL_ROLES:
    c = storage_claims.claim_for(role)
    ok(f"{role} earns a claim", c is not None)
    if c:
        eq(f"{role} carries its own Role value", c["role"], str(role))
        eq(f"{role} carries an empty aid rather than omitting it", c["aid"], "")

for role in EXTERNAL_ROLES:
    eq(f"{role} earns NOTHING here — the trigger owns it",
       storage_claims.claim_for(role), None)

for junk in [None, "", "nonsense", "system", "superadmin", 0, True, "OWNER"]:
    eq(f"{junk!r} earns nothing", storage_claims.claim_for(junk), None)

# `superadmin` is the CRM spelling, not a backend Role. It must not slip
# through: the token vocabulary is Role values only, and `storage.rules` has
# no 'superadmin' in any tier.
eq("the CRM spelling 'superadmin' is not a backend Role and earns nothing",
   storage_claims.claim_for("superadmin"), None)

# ── 2. Writing, and not clobbering ──────────────────────────────────────────
print("2. Writing a claim")

reset("u1", {})
eq("a clean grant reports no problem",
   storage_claims.apply_for_role("u1", Role.FINANCE_ADMIN), "")
eq("and the claim is on the user", USERS["u1"], {"role": "finance_admin", "aid": ""})

reset("u1", {"role": "ops_member", "aid": "", "somethingElse": "keep me"})
storage_claims.apply_for_role("u1", Role.OWNER)
eq("a role change replaces role", USERS["u1"]["role"], "owner")
eq("and preserves an unrelated claim", USERS["u1"]["somethingElse"], "keep me")

reset("u1", {"role": "owner", "aid": "", "somethingElse": "keep me"})
storage_claims.clear("u1")
ok("clearing removes role", "role" not in USERS["u1"])
ok("clearing removes aid", "aid" not in USERS["u1"])
eq("and still preserves an unrelated claim", USERS["u1"]["somethingElse"], "keep me")

reset("u1", {"role": "agency", "aid": "AG7"})
storage_claims.apply_for_role("u1", Role.AGENCY)
eq("an external role CLEARS rather than writes — a staff account converted to "
   "a partner must not keep internal access while the trigger catches up",
   USERS["u1"], {})

# ── 3. Idempotence ──────────────────────────────────────────────────────────
print("3. Idempotence")

reset("u1", {"role": "ops_admin", "aid": ""})
writes = []
real_set = fb_auth.set_custom_user_claims


def counting_set(uid, claims):
    writes.append(uid)
    real_set(uid, claims)


fb_auth.set_custom_user_claims = counting_set
storage_claims.apply_for_role("u1", Role.OPS_ADMIN)
eq("re-applying the same claim writes nothing", writes, [])
storage_claims.apply_for_role("u1", Role.TECH_ADMIN)
eq("a real change does write", writes, ["u1"])
fb_auth.set_custom_user_claims = real_set

# ── 4. Failure is reported, never raised ────────────────────────────────────
print("4. Failure is reported")

USERS.clear()   # the uid now does not exist
problem = storage_claims.apply_for_role("ghost", Role.OWNER)
ok("a missing auth user yields a problem string", problem != "")
ok("and says what went wrong", "could not read" in problem.lower())

eq("an empty uid is refused without touching Firebase",
   storage_claims.apply_for_role("", Role.OWNER), "no uid")


def _boom(uid, claims):
    raise RuntimeError("network down")


reset("u1", {})
fb_auth.set_custom_user_claims = _boom
problem = storage_claims.apply_for_role("u1", Role.OWNER)
ok("a write failure yields a problem string rather than raising", problem != "")
ok("naming the cause", "network down" in problem)
fb_auth.set_custom_user_claims = real_set

# ── 4b. apply_partner refuses to be the escalation path ─────────────────────
print("4b. apply_partner is whitelisted")

fb_auth.set_custom_user_claims = real_set
for bad in ["owner", "observer", "finance_admin", "superadmin", "system",
            "", "  ", "AGENCY", "agency ", None, "admin"]:
    reset("u1", {})
    out = storage_claims.apply_partner("u1", bad, "AG7")
    if str(bad).strip() in ("agency", "seller"):
        continue
    ok(f"apply_partner refuses {bad!r}", out.startswith("refused"))
    eq(f"and writes nothing for {bad!r}", USERS["u1"], {})

reset("u1", {})
eq("apply_partner('agency') writes the scoped claim",
   storage_claims.apply_partner("u1", "agency", "AG7"), "")
eq("with the agency id", USERS["u1"], {"role": "agency", "aid": "AG7"})

reset("u1", {})
storage_claims.apply_partner("u1", "seller", "")
eq("a seller carries an empty aid", USERS["u1"], {"role": "seller", "aid": ""})

reset("u1", {"keepMe": 1})
storage_claims.apply_partner("u1", "agency", "AG9")
eq("and unrelated claims survive", USERS["u1"]["keepMe"], 1)

# ── 5. The split of authority, restated as a test ───────────────────────────
print("5. Two authorities, disjoint vocabularies")

internal_values = {str(r) for r in INTERNAL_ROLES}
external_values = {str(r) for r in EXTERNAL_ROLES}
ok("the two role sets do not overlap", not (internal_values & external_values))

granted = {
    c["role"]
    for c in (storage_claims.claim_for(r) for r in list(Role))
    if c is not None
}
eq("this module grants exactly the internal roles and nothing else",
   granted, internal_values)
ok("and never 'agency' or 'seller'", not (granted & external_values))

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} storage-claim checks passed.")
print("  · internal roles only — the partner vocabulary is the trigger's")
print("  · unrelated claims survive a write, a change and a clear")
print("  · every failure comes back as a sentence, never as an exception\n")
