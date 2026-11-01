"""The claim verifier's comparison, including the bug it shipped with.

── THE BUG ──────────────────────────────────────────────────────────────────

The first production run reported four failures against the three Owners and
the App Admin — accounts whose claims were correct and required. Production
was right; the verifier was wrong, and it was wrong in the direction that
would have stopped a correct deployment.

`plan()`'s `no_claim` roster is a statement about a SOURCE: "this `crmUsers`
document yields no partner claim". A member of staff has two records — a
Mongo row that earns them an internal claim, and a mirrored `crmUsers`
document carrying `superadmin`, which is not a partner role and so lands on
the roster. Reading the roster as "this uid must carry no claim" conflated a
source with an identity.

Section 1 is that exact shape: the real production arrangement, asserted to
come back clean.

REAL: `scripts.verify_storage_claims.compare`, imported and called.
FAKE: nothing — `compare` is pure. The inputs are the real production shape.

    python3 -m tests.test_verify_storage_claims
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from scripts.verify_storage_claims import compare  # noqa: E402

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
        print(f"  FAIL  {claim}\n        got {got!r}\n        want {want!r}")


# ── The real production arrangement ─────────────────────────────────────────
OWNER_A = "XIWhltIc91h35xRkxySpdmhFzb12"
OWNER_B = "q3htaaXWj4bTXpVKIl02vWgAwtI2"
OWNER_C = "KVGmKZCzKsWj3osAFdo7KlWjJ6d2"
APP_ADMIN = "T7XT5mvZHKbo3nd6zU0eBvFRSBu2"
AGENCY = "ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2"
AID = "NqvNnhe6BY5GESpWjKIT"
OBSERVER = "observer:314zipper@gmail.com"

EXPECTED = {
    OWNER_A: {"role": "owner", "aid": ""},
    OWNER_B: {"role": "owner", "aid": ""},
    OWNER_C: {"role": "owner", "aid": ""},
    APP_ADMIN: {"role": "app_admin", "aid": ""},
    AGENCY: {"role": "agency", "aid": AID},
}

# Every staff uid ALSO appears here, because each has a mirrored `crmUsers`
# document whose role is not a partner role. This is the production shape.
NO_CLAIM = [
    (OBSERVER, "314zipper@gmail.com", "observer has no Firebase account by design"),
    (OWNER_C, "baapaadmi0101@gmail.com", "crmUsers role 'superadmin' is not a partner role"),
    (APP_ADMIN, "loolipop0101@gmail.com", "crmUsers role 'app_admin' is not a partner role"),
    (OWNER_A, "tanishque50@gmail.com", "crmUsers role 'superadmin' is not a partner role"),
    (OWNER_B, "soumyaranjan.singh7@gmail.com", "crmUsers role 'superadmin' is not a partner role"),
]

# 11 Firebase accounts; the five planned carry claims, six carry none.
ACTUAL = {
    OWNER_A: {"role": "owner", "aid": ""},
    OWNER_B: {"role": "owner", "aid": ""},
    OWNER_C: {"role": "owner", "aid": ""},
    APP_ADMIN: {"role": "app_admin", "aid": ""},
    AGENCY: {"role": "agency", "aid": AID},
    **{f"ordinary_{i}": {} for i in range(6)},
}

# ── 1. The production shape verifies clean ──────────────────────────────────
print("\n1. The real production arrangement reports no problems")

lines, roster, probs = compare(EXPECTED, set(), NO_CLAIM, ACTUAL)
eq("zero failures", probs, [])
ok("all five expected claims are reported OK",
   sum(1 for ln in lines if ln.strip().startswith("OK ")) == 5)

# The regression, named: a staff uid is granted AND on the roster. The grant
# is the authoritative word on the identity; the roster entry is about a
# `crmUsers` document and must not contradict it.
for uid in (OWNER_A, OWNER_B, OWNER_C, APP_ADMIN):
    ok(f"{uid[:10]}… is NOT listed as holding no claim — it is granted",
       not any(r[0] == uid for r in roster))
ok("the Observer IS listed, because it genuinely holds none",
   any(r[0] == OBSERVER for r in roster))
eq("so the roster is the Observer alone", [r[0] for r in roster], [OBSERVER])

# ── 2. It still detects a claim that should not exist ───────────────────────
print("2. An unexpected privileged claim is still caught")

for bad_role in ("owner", "app_admin", "finance_admin", "agency", "observer"):
    actual = {**ACTUAL, "a_stranger": {"role": bad_role}}
    _l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
    ok(f"a stranger carrying role={bad_role!r} is reported",
       any("a_stranger" in x and "not in the plan" in x for x in p))

# The detector walks every account, so it does not depend on the roster.
actual = {**ACTUAL, "a_stranger": {"role": "owner"}}
_l, _r, p = compare(EXPECTED, set(), [], actual)
ok("…even with an empty no-claim roster", any("a_stranger" in x for x in p))

# An account with no role claim is not a stray, whatever else it carries.
actual = {**ACTUAL, "harmless": {"somethingElse": True}}
_l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
eq("an unrelated claim is not mistaken for a privileged one", p, [])

# ── 3. The real mismatches are still caught ─────────────────────────────────
print("3. Missing, wrong and stale claims")

actual = dict(ACTUAL); del actual[OWNER_A]
_l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
ok("a planned uid with no Firebase account is reported",
   any(OWNER_A in x and "no Firebase account" in x for x in p))

actual = {**ACTUAL, OWNER_A: {"role": "app_admin", "aid": ""}}
_l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
ok("a wrong role is reported", any(OWNER_A in x and "expected" in x for x in p))

actual = {**ACTUAL, AGENCY: {"role": "agency", "aid": "SOMEBODY_ELSE"}}
_l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
ok("a wrong aid is reported — an agency scoped to another agency",
   any(AGENCY in x for x in p))

actual = {**ACTUAL, AGENCY: {"role": "agency"}}
_l, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
ok("a missing aid is reported", any(AGENCY in x for x in p))

_l, _r, p = compare(EXPECTED, {"was_cleared"}, NO_CLAIM,
                    {**ACTUAL, "was_cleared": {"role": "agency", "aid": "X"}})
ok("a claim that should have been cleared but was not is reported",
   any("was_cleared" in x and "cleared" in x for x in p))

_l, _r, p = compare(EXPECTED, {"was_cleared"}, NO_CLAIM, {**ACTUAL, "was_cleared": {}})
eq("and a genuinely cleared one is fine", p, [])

# ── 4. Unrelated claims are preserved, not flagged ──────────────────────────
print("4. Claims this system does not own")

actual = {**ACTUAL, OWNER_A: {"role": "owner", "aid": "", "somethingElse": 1}}
lines, _r, p = compare(EXPECTED, set(), NO_CLAIM, actual)
eq("an extra claim alongside a correct one is not a failure", p, [])
ok("but it is reported, so it is visible",
   any("also carries" in ln for ln in lines))

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} claim-verification checks passed.")
print("  · a staff uid granted a claim is not also reported as claimless")
print("  · the Observer is, because it genuinely holds none")
print("  · a privileged claim outside the plan is still caught, roster or not")
print("  · missing, wrong, stale and mis-scoped claims all still fail\n")
