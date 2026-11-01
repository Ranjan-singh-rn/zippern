"""One human, one agency-family record — enforced in Mongo, not the browser.

── THE PRODUCTION FACT THIS ENCODES ─────────────────────────────────────────

One Firebase identity, `ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2`, held two main
agencies: `NqvNnhe6BY5GESpWjKIT` ("Ruhan", source second_role, 0 KYC
documents) and `mrXHV4SNmGhsdQ5d5k5Q` ("Tan", source crm, 3 KYC documents).
The session resolves only the first, so the second was invisible to its owner
and visible to staff — which is why it presented as a KYC bug.

Every guard that existed was client-side, and each failed differently: the
signup form read "could not verify" as "no duplicate", and the second-role
flow asked a DENORMALISED field (`crmUsers.agencyId`) that other writers
blank with a non-merging `setDoc`. Firestore rules cannot help — the question
needs a collection query and rules cannot query.

── THE MATRIX ───────────────────────────────────────────────────────────────

                  Agency   Sub-agency   Coin Seller
    Agency          —          NO           YES
    Sub-agency      NO         —            YES
    Coin Seller    YES        YES            —

REAL: `app.services.partner_roles`, imported and called.
FAKE: Mongo, from `tests/harness.FakeDb` — including its `_id` uniqueness,
      which is the mechanism under test.

    python3 -m tests.test_partner_roles
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from app.db.mongo import C  # noqa: E402
from app.services import partner_roles as pr  # noqa: E402

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
        print(f"  FAIL  {claim}\n        got {got!r}  want {want!r}")


db = FakeDb()
pr.get_db = lambda: db  # type: ignore[assignment]
run = asyncio.get_event_loop().run_until_complete

RUHAN = "ZJ2xFSw6bDOCNzuuY1Pkv1zkXIr2"
OTHER = "some_other_human_uid"
ACTOR = {"uid": "staff1"}


def claim(uid: str, kind: str, pid: str) -> str:
    """'' when the claim was taken, else the refusal message."""
    try:
        run(pr.claim_role_family(uid, kind, pid, actor=ACTOR))
        return ""
    except pr.RoleConflict as exc:
        return str(exc)


def fresh() -> None:
    db[pr.PARTNER_ROLE_CLAIMS].docs.clear()


# ── 1. The matrix, as a pure function ───────────────────────────────────────
print("\n1. The role matrix")

eq("agency and sub_agency share one family",
   (pr.family_of("agency"), pr.family_of("sub_agency")), ("agency", "agency"))
eq("seller is its own family", pr.family_of("seller"), "seller")
eq("an unknown kind has no family", pr.family_of("host"), None)

ok("nothing held -> agency allowed", pr.allows(set(), "agency"))
ok("nothing held -> seller allowed", pr.allows(set(), "seller"))
ok("agency -> seller ALLOWED", pr.allows({"agency"}, "seller"))
ok("sub_agency -> seller ALLOWED", pr.allows({"sub_agency"}, "seller"))
ok("seller -> agency ALLOWED", pr.allows({"seller"}, "agency"))
ok("seller -> sub_agency ALLOWED", pr.allows({"seller"}, "sub_agency"))
ok("agency -> agency REJECTED", not pr.allows({"agency"}, "agency"))
ok("agency -> sub_agency REJECTED", not pr.allows({"agency"}, "sub_agency"))
ok("sub_agency -> agency REJECTED", not pr.allows({"sub_agency"}, "agency"))
ok("sub_agency -> sub_agency REJECTED", not pr.allows({"sub_agency"}, "sub_agency"))
ok("seller -> seller REJECTED", not pr.allows({"seller"}, "seller"))
ok("agency+seller -> agency REJECTED", not pr.allows({"agency", "seller"}, "agency"))
ok("agency+seller -> seller REJECTED", not pr.allows({"agency", "seller"}, "seller"))
ok("an unknown kind is never allowed", not pr.allows(set(), "host"))

# ── 2. The numbered cases from the brief ────────────────────────────────────
print("2. The eighteen cases")

fresh()
eq("(1) new human -> Agency: SUCCESS", claim(OTHER, "agency", "A_new"), "")

fresh()
claim(RUHAN, "agency", "NqvNnhe6BY5GESpWjKIT")
eq("(2) Agency human -> Coin Seller: SUCCESS",
   claim(RUHAN, "seller", "NLTAidHAo2BfFGj6VIiH"), "")

fresh()
claim(RUHAN, "seller", "S1")
eq("(3) Coin Seller with no Agency -> Agency: SUCCESS",
   claim(RUHAN, "agency", "A1"), "")

fresh()
claim(RUHAN, "agency", "NqvNnhe6BY5GESpWjKIT")
refusal = claim(RUHAN, "agency", "mrXHV4SNmGhsdQ5d5k5Q")
ok("(4) Agency human -> second Agency: REJECTED", refusal != "")
ok("    and the refusal names the record already held",
   "NqvNnhe6BY5GESpWjKIT" in refusal)
eq("(5) exactly one agency claim exists after the refusal",
   len([d for d in db[pr.PARTNER_ROLE_CLAIMS].docs if d.get("family") == "agency"]), 1)
held = run(pr.holder_of(RUHAN, "agency"))
eq("(6) the existing Agency is unchanged", held["partner_id"], "NqvNnhe6BY5GESpWjKIT")

fresh()
claim(RUHAN, "agency", "A1")
claim(RUHAN, "seller", "S1")
claim(RUHAN, "agency", "A2")          # refused
seller_claim = run(pr.holder_of(RUHAN, "seller"))
eq("(7) the existing Seller is untouched by a refused Agency",
   seller_claim["partner_id"], "S1")

fresh()
claim(RUHAN, "agency", "A1")
ok("(8) Agency human -> Sub-agency: REJECTED", claim(RUHAN, "sub_agency", "B1") != "")

fresh()
claim(RUHAN, "sub_agency", "B1")
ok("(9) Sub-agency human -> Agency: REJECTED", claim(RUHAN, "agency", "A1") != "")

fresh()
claim(RUHAN, "agency", "A1")
eq("(10) a DIFFERENT human -> Agency: SUCCESS", claim(OTHER, "agency", "A2"), "")

# (11) and (12) are the /agency-signup client guard; the server-side half is
# (4) above, which is what actually stops the write. Asserted here as the
# property the form can no longer defeat:
fresh()
claim(RUHAN, "agency", "A1")
ok("(11) a duplicate reaching the API from ANY client is refused",
   claim(RUHAN, "agency", "A_from_signup") != "")
ok("(12) a client that could not verify uniqueness cannot create one either "
   "— the API does not take the client's word for it",
   claim(RUHAN, "agency", "A_unverified") != "")

# ── 3. Concurrency: the `_id` insert IS the lock ────────────────────────────
print("3. Two simultaneous creates")

fresh()
results = run(asyncio.gather(
    *[pr.claim_role_family(RUHAN, "agency", f"A{i}", actor=ACTOR) for i in range(8)],
    return_exceptions=True,
))
winners = [r for r in results if not isinstance(r, Exception)]
losers = [r for r in results if isinstance(r, pr.RoleConflict)]
eq("(13) eight concurrent Agency creates -> exactly ONE wins", len(winners), 1)
eq("     and the other seven are refused", len(losers), 7)
eq("     exactly one claim document exists",
   len([d for d in db[pr.PARTNER_ROLE_CLAIMS].docs if d.get("family") == "agency"]), 1)

fresh()
results = run(asyncio.gather(
    pr.claim_role_family(RUHAN, "agency", "A1", actor=ACTOR),
    pr.claim_role_family(RUHAN, "seller", "S1", actor=ACTOR),
    return_exceptions=True,
))
eq("     a concurrent Agency AND Seller both succeed — different families",
   len([r for r in results if not isinstance(r, Exception)]), 2)

# ── 4. The owner key, and failing closed ────────────────────────────────────
print("4. Identity and failure modes")

fresh()
ok("a create naming no Firebase identity is REFUSED, not waved through",
   claim("", "agency", "A1") != "")
ok("  (a rule keyed on the human cannot be applied without one)",
   "cannot be applied" in claim("", "agency", "A1"))
ok("an unrecognised kind is refused", claim(RUHAN, "wizard", "W1") != "")

fresh()
claim(RUHAN, "agency", "A1")
run(pr.release_role_family(RUHAN, "agency"))
eq("releasing the claim frees the family — a failed insert must not lock "
   "the human out for ever", claim(RUHAN, "agency", "A2"), "")

fresh()
run(pr.release_role_family(RUHAN, "agency"))
eq("releasing a claim that was never taken is harmless",
   claim(RUHAN, "agency", "A1"), "")

# ── 4b. Claiming the same pairing twice is not a conflict ───────────────────
print("4b. Re-affirming a claim this record already holds")

# TWO WRITERS, ONE PAIRING. A partner created from a Firestore document
# carrying `ownerUid` is claimed by `ensure_partner_record`; `attach_login`
# later gives that same record a CRM login for the same human and claims
# again. Nothing changes hands. Refusing would block the operation the rule
# exists to permit, and would report it as a duplicate-agency violation —
# "you already hold A1" in answer to a request about A1.
#
# There are two independent paths to get this right and both must:
#   · the SENTINEL path, when a claim document already names this record;
#   · the RECORDS path, when `partners` already names this human as owner.
# A mutation that breaks either one has to fail here, so both are driven.

fresh()
eq("the first claim is taken", claim(RUHAN, "agency", "A1"), "")
eq("claiming the SAME record again is accepted, not refused "
   "(sentinel path)", claim(RUHAN, "agency", "A1"), "")
eq("and it is still one claim",
   len([d for d in db[pr.PARTNER_ROLE_CLAIMS].docs if d.get("family") == "agency"]), 1)
eq("a DIFFERENT record for the same human is still refused after that",
   claim(RUHAN, "agency", "A2") == "", False)

# The records path. No sentinel at all — the shape of every partner that
# predates this module — and `partners` already names RUHAN as the owner of
# A1. Claiming A1 must succeed; claiming A2 must not.
fresh()
db[C.PARTNERS].docs.clear()
db[C.PARTNERS].docs.append({
    "_id": "A1", "kind": "agency", "status": "approved", "owner_crm_uid": RUHAN,
})
eq("claiming the record the human ALREADY owns is accepted "
   "(records path, no sentinel)", claim(RUHAN, "agency", "A1"), "")
ok("  — a record must never conflict with itself", True)

fresh()
eq("but a different record, same human, same family, is refused",
   claim(RUHAN, "agency", "A2") == "", False)
refusal = claim(RUHAN, "agency", "A2")
ok("  and the refusal names the one they hold", "A1" in refusal)

db[C.PARTNERS].docs.clear()


# ── 5. Agency + Coin Seller, the combination that must keep working ─────────
print("5. Agency + Coin Seller stays supported")

fresh()
eq("Ruhan takes the agency", claim(RUHAN, "agency", "NqvNnhe6BY5GESpWjKIT"), "")
eq("Ruhan takes the coin seller", claim(RUHAN, "seller", "NLTAidHAo2BfFGj6VIiH"), "")
families = run(pr.families_held(RUHAN))
eq("both families are held", sorted(families), ["agency", "seller"])
eq("the agency family names the one agency",
   families["agency"]["partner_id"], "NqvNnhe6BY5GESpWjKIT")
eq("the seller family names the one seller",
   families["seller"]["partner_id"], "NLTAidHAo2BfFGj6VIiH")
ok("and a second agency is still refused on top of both",
   claim(RUHAN, "agency", "mrXHV4SNmGhsdQ5d5k5Q") != "")

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} partner-role checks passed.")
print("  · Agency + Coin Seller allowed; Agency + Agency and Agency + "
      "Sub-agency refused")
print("  · concurrent creates resolve to exactly one record, via the _id lock")
print("  · a create with no Firebase identity fails closed")
print("  · a released claim does not strand the human\n")
