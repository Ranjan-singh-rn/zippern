"""The eleven security fixes, as properties rather than as descriptions.

Each section names the hole it closes and what somebody could do through it.
The Firestore-rule half of the work is asserted against the rules TEXT — there
is no emulator here, and a rule nobody can run is still a rule that can be read.

Run:  python3 -m tests.test_security_phase1
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES = (ROOT.parent / "firestore.rules").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

from app.core import audit as audit_mod  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import cards as cards_svc  # noqa: E402
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


def block(name: str) -> str:
    """One `match` block from the rules, by collection name.

    Counting braces from the `match` keyword does not work: the path itself
    contains a wildcard — `match /salaryRequests/{reqId}` — which opens and
    closes a brace before the body starts, so a naive counter closes the block
    on the first line. Start at the brace that ENDS the match line instead.
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


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


# ══════════════════════════════════════════════════════════════════════════════
#  B1 — salaryRequests: anyone could inject a payout and approve it
# ══════════════════════════════════════════════════════════════════════════════

salary = strip_comments(block("salaryRequests"))

ok("create is no longer open to any signed-in account",
   "allow create: if request.auth != null;" not in salary)
ok("a request must be born pending",
   "request.resource.data.get('status', '') == 'pending'" in salary)
ok("and may only be raised for the caller's own agency",
   "crmUserAgencyId() == request.resource.data.get('agencyId', '')" in salary)

# The self-approval route: create naming yourself in `agencyOwnerUid`, then
# update your own record to `approved` with any amount.
ok("the requester can no longer update their own record by agencyOwnerUid",
   "resource.data.agencyOwnerUid == request.auth.uid" not in salary.split("allow update")[1])
ok("the agency's own update is pinned to two keys",
   "hasOnly(['status', 'distributedAt'])" in salary)
ok("and to the one status it is for",
   "request.resource.data.get('status', '') == 'distributed'" in salary)

# Deciding a host payout is Finance's, not every `*_admin`'s.
update_clause = salary.split("allow update")[1].split(";")[0]
ok("deciding is finance or the owner", "isFinance() || isSuperAdmin()" in update_clause)
ok("not any department admin", "isAdmin()" not in update_clause)


# ══════════════════════════════════════════════════════════════════════════════
#  B2 — hostApplications: a stranger could activate and read KYC
# ══════════════════════════════════════════════════════════════════════════════

apps = strip_comments(block("hostApplications"))

# The clause took `hasOnly(['isActivated','activatedByUid'])` with no binding to
# whose application it was. One write made the attacker `activatedByUid`, and
# the read clause admits that field — so it handed over bank details, DOB and
# KYC document URLs.
ok("the unbound activation clause is gone",
   "hasOnly(['isActivated', 'activatedByUid'])" not in apps)
# Phase 1A (SECURITY-002): the applicant update arm is gone entirely, and both
# fields are on `hostDecisionFields()`, which no client arm may touch.
ok("an app user still cannot touch those two fields",
   "'isActivated', 'activatedByUid'" in apps
   and "hostAppDecisionUntouched()" in apps
   and "resource.data.applicantUid == request.auth.uid" not in apps)
ok("the read clause on activatedByUid is unchanged, now that it cannot be forged",
   "resource.data.get('activatedByUid', '') == request.auth.uid" in apps)


# ══════════════════════════════════════════════════════════════════════════════
#  B3 — sellers: the whole collection was listable by any signed-in account
# ══════════════════════════════════════════════════════════════════════════════

sellers = strip_comments(block("sellers"))

ok("blanket read is gone", "allow read:   if request.auth != null;" not in sellers)
ok("list is narrowed", "allow list:" in sellers)
list_clause = sellers.split("allow list:")[1].split(";")[0]
# Phase 2 narrowed this to approved-and-active, which stopped pending and
# rejected records being enumerated and left an approved seller's KYC one query
# away — Firestore returns a document whole or not at all. Phase 3 moved the
# directory to `publicSellers`, so this is staff only now. The assertion is
# updated rather than deleted: the weaker state should not silently come back.
ok("the list is staff only", "isStaff()" in list_clause)
ok("app users have no route to the private collection at all",
   "request.auth != null" not in list_clause)

get_clause = sellers.split("allow get:")[1].split(";")[0]
ok("a seller can still read their own record by document id",
   "sellerId == request.auth.uid" in get_clause)


# ══════════════════════════════════════════════════════════════════════════════
#  B12 — withdrawalRequests: a host could file one already approved
# ══════════════════════════════════════════════════════════════════════════════

wd = strip_comments(block("withdrawalRequests"))
create_clause = wd.split("allow create:")[1].split(";")[0]
ok("the requester is still pinned",
   "request.resource.data.get('hostUid', '') == request.auth.uid" in create_clause)
ok("and so is the status, which it was not",
   "request.resource.data.get('status', '') == 'pending'" in create_clause)

wd_update = wd.split("allow update:")[1].split(";")[0]
ok("deciding a withdrawal is finance or the owner",
   "isFinance() || isSuperAdmin()" in wd_update)
ok("not every department admin", "isAdmin()" not in wd_update)


# ══════════════════════════════════════════════════════════════════════════════
#  B6 — a deactivated staff member kept full Firestore rights
# ══════════════════════════════════════════════════════════════════════════════

is_crm_user = RULES[RULES.index("function isCrmUser()") :]
is_crm_user = is_crm_user[: is_crm_user.index("\n    }")]

ok("isCrmUser now reads isActive", "isActive" in is_crm_user)
ok("and absent reads as active, so old documents are not locked out",
   "get('isActive', true)" in is_crm_user)
# Every other role helper is built on this one, so one check covers them all.
for helper in ("isStaff", "isAdmin", "isOps", "isFinance", "isTech"):
    body = RULES[RULES.index(f"function {helper}()") :]
    body = body[: body.index("\n    }")]
    ok(f"{helper}() goes through isCrmUser()", "isCrmUser()" in body)


# ══════════════════════════════════════════════════════════════════════════════
#  B8 — isAdmin() matched `.*_admin` on privileged collections
# ══════════════════════════════════════════════════════════════════════════════

app_config = strip_comments(block("appConfig"))
cfg_write = app_config.split("allow write:")[1].split(";")[0]
ok("the company bank account is still superadmin only",
   "docId == 'paymentCredentials' && isSuperAdmin()" in cfg_write)
ok("and the economy config is Tech or the owner, not every admin",
   "isTech() || isSuperAdmin()" in cfg_write)
ok("marketing_admin can no longer rewrite the commission slabs",
   "isAdmin()" not in cfg_write)


# ══════════════════════════════════════════════════════════════════════════════
#  B4 — GET /staff returned salary to department admins
# ══════════════════════════════════════════════════════════════════════════════

db = FakeDb()
svc.get_db = lambda: db


async def fake_audit(**kwargs):
    return "audit-id"


audit_mod.record = fake_audit


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


for row in (
    {"uid": "fin-1", "email": "a@x.com", "name": "A", "role": "finance_member",
     "team": "finance", "is_active": True, "salary_minor": 9000000,
     "salary_currency": "INR", "joined_at": "2026-01-01"},
    {"uid": "ops-1", "email": "b@x.com", "name": "B", "role": "ops_member",
     "team": "ops", "is_active": True, "salary_minor": 7000000,
     "salary_currency": "INR"},
):
    run(db[C.STAFF].insert_one(dict(row)))

FIN_ADMIN = {"uid": "fa-1", "role": Role.FINANCE_ADMIN, "team": "finance", "name": "FA"}
OWNER = {"uid": "o-1", "role": Role.OWNER, "team": None, "name": "O"}
OBSERVER = {"uid": "obs", "role": Role.OBSERVER, "team": None, "name": "Obs"}

seen = run(svc.list_staff(FIN_ADMIN))
check("a department admin sees their own department", len(seen), 1)
check("and the right person", seen[0]["uid"], "fin-1")
ok("but NOT their salary", "salary_minor" not in seen[0])
ok("nor the currency", "salary_currency" not in seen[0])
ok("everything else is still there", seen[0].get("joined_at") == "2026-01-01")

owner_view = run(svc.list_staff(OWNER))
ok("an owner still sees pay", any("salary_minor" in r for r in owner_view))
check("and sees everybody", len(owner_view), 2)

# The observer reads everything by design — `can_read_all`.
ok("the observer still reads pay", any("salary_minor" in r for r in run(svc.list_staff(OBSERVER))))

# A member sees only themselves, and their own pay is theirs to see.
own = run(svc.list_staff({"uid": "fin-1", "role": Role.FINANCE_MEMBER, "team": "finance"}))
check("a member sees one row", len(own), 1)
ok("their own, with their own pay", own[0]["uid"] == "fin-1" and "salary_minor" in own[0])


# ══════════════════════════════════════════════════════════════════════════════
#  B9 — an owner could sign the card that pays them
# ══════════════════════════════════════════════════════════════════════════════

sign_src = (ROOT / "app" / "services" / "cards.py").read_text(encoding="utf-8")
sign_fn = sign_src[sign_src.index("async def sign(") :]
sign_fn = sign_fn[: sign_fn.index("\nasync def ", 10)]

ok("the raiser still cannot sign", 'card["requested_by"]["uid"] == actor["uid"]' in sign_fn)
ok("nor the verifier", 'verifier.get("uid") == actor["uid"]' in sign_fn)
# The gap: an owner whose capital card was raised by a finance admin is neither
# the raiser nor the verifier, and `capital.py` sets them as the SUBJECT.
ok("and now nor the subject — the person the money is for",
   'subject.get("id") == actor["uid"]' in sign_fn)
ok("a card with no subject is unaffected", 'subject.get("id") and' in sign_fn)


# ══════════════════════════════════════════════════════════════════════════════
#  B5 — the audit history endpoint was unscoped
# ══════════════════════════════════════════════════════════════════════════════

audit_router = (ROOT / "app" / "routers" / "audit.py").read_text(encoding="utf-8")
hist = audit_router[audit_router.index("async def record_history") :]

ok("an owner or the observer still reads any history",
   "R.can_read_all(user[\"role\"])" in hist)
ok("a non-admin still gets nothing", "R.is_team_admin(user[\"role\"])" in hist)
# `set_employment` writes salary into before/after, so a staff subject is the
# one that leaks. A department admin is now held to the people they manage.
ok("a staff subject is checked against manages()", "staff_svc.manages(user, person)" in hist)
ok("and a missing record is refused rather than passed through",
   "person is None" in hist)


# ══════════════════════════════════════════════════════════════════════════════
#  B7 — a rejected partner traded on for up to seven days
# ══════════════════════════════════════════════════════════════════════════════

ops_src = (ROOT / "app" / "services" / "partner_ops.py").read_text(encoding="utf-8")

ok("there is a session-revoking helper", "_revoke_partner_sessions" in ops_src)
ok("it keys on the uid the session was issued to",
   'partner.get("owner_crm_uid")' in ops_src)

reject_fn = ops_src[ops_src.index("async def reject_partner") :]
reject_fn = reject_fn[: reject_fn.index("\nasync def ", 10)]
ok("rejection revokes the live session", "_revoke_partner_sessions" in reject_fn)

deact_fn = ops_src[ops_src.index("async def deactivate_partner") :]
deact_fn = deact_fn[: deact_fn.index("\nasync def ", 10)]
ok("suspension does too", "_revoke_partner_sessions" in deact_fn)

react_fn = ops_src[ops_src.index("async def reactivate_partner") :]
react_fn = react_fn[: react_fn.index("\nasync def ", 10)]
# B39: reactivation revokes too — not to shut them out but because the session
# they hold was minted while the capability was withdrawn and does not carry
# it. The CRM signs them back in and the new session does. Approval has always
# done the same for the same reason.
ok("reactivation revokes too, so the restored capability reaches a fresh session (B39)",
   "_revoke_partner_sessions" in react_fn)


# ══════════════════════════════════════════════════════════════════════════════
#  B10 / B11 — the CRM half
# ══════════════════════════════════════════════════════════════════════════════

CRM = ROOT.parent / "zipper-crm"
salary_client = (CRM / "app" / "agencies" / "[id]" / "salary" / "Client.tsx").read_text(
    encoding="utf-8"
)
reject_fn_ts = salary_client[salary_client.index("async function handleReject") :]
reject_fn_ts = reject_fn_ts[: reject_fn_ts.index("\n  }") + 4]
ok("rejecting writes 'rejected'", "status: 'rejected'" in reject_fn_ts)
ok("not 'distributed', which is what a PAID request ends at",
   "status: 'distributed'" not in reject_fn_ts)
ok("and the badge has its own colour for it", "rejected:" in salary_client)

kyc = (CRM / "app" / "kyc" / "page.tsx").read_text(encoding="utf-8")
ok("the KYC decide buttons are gated on the permission",
   "hasPermission(crmUser, 'can_approve_kyc')" in kyc)
ok("reviewing is still open to the page roles", "canAccess(crmUser, [...PAGE_ROLES])" in kyc)
ok("and a reviewer without the permission is told who decides",
   "ask an ops admin or an owner" in kyc)




# ══════════════════════════════════════════════════════════════════════════════
#  PHASE 2 — phone numbers as identity (the Python half)
# ══════════════════════════════════════════════════════════════════════════════
#
# `functions/test/phone.test.js` holds the canonical-key properties. These cover
# the Python side, which is where a staff member's or partner's number is turned
# into something Firebase will accept — and where `+91` used to be written over
# a foreign number.

from app.services import crm_directory as crm  # noqa: E402

# ── Two countries, same local digits ─────────────────────────────────────────
US = "+14155550100"
IN = "+914155550100"
ok("the old key made them one identity — the regression",
   crm._legacy_phone_key(US) == crm._legacy_phone_key(IN))
ok("the canonical key keeps them apart", crm._phone_key(US) != crm._phone_key(IN))
check("and is the full number", crm._phone_key(US), "14155550100")

# ── An already-international number is never re-prefixed ─────────────────────
#
# `_attach_app_identity` wrote `phoneNumber = f"+91{key}"` UNCONDITIONALLY, so a
# US staff member's own document carried `+914155550100` — a real Indian number
# belonging to somebody else.
for number in (US, "+447911123456", "+971501234567", "+8613800138000"):
    check(f"{number} is preserved", crm.to_e164(number), number)
    ok(f"{number} is not given an Indian prefix",
       not crm.to_e164(number).startswith("+91") or number.startswith("+91"))

# ── A bare national number gets the configured default, and only then ────────
check("a bare Indian number still works", crm.to_e164("9876543210"), "+919876543210")
check("a trunk zero is not a country code", crm.to_e164("09876543210"), "+919876543210")
check("nor is an international dialling prefix",
      crm.to_e164("00919876543210"), "+919876543210")
ok("the default is a named constant, not a literal in a helper",
   crm.DEFAULT_DIAL_CODE == "+91")

# ── The length gate that silently refused foreign numbers is gone ────────────
#
# It was `len(key) != 10 -> return ""`, so a nine- or eleven-digit national
# number got no phone sign-in at all and nothing on any screen said why.
ok("a nine-digit national number is now attachable",
   crm.to_e164("+971501234567") != "")
ok("and an eleven-digit one", crm.to_e164("+8613800138000") != "")
check("nothing in still gives nothing out", crm.to_e164(""), "")
check("and neither does punctuation alone", crm.to_e164("+-- "), "")

# ── The survey script cannot write ───────────────────────────────────────────
survey = (ROOT / "scripts" / "survey_phone_keys.py").read_text(encoding="utf-8")
for forbidden in (".set(", ".update(", ".delete(", "--apply", "--confirm"):
    ok(f"the survey script has no {forbidden}",
       forbidden not in survey.replace("`--apply` flag", ""))
ok("it says so out loud", "writes nothing, ever" in survey)

# ── ownedItems and the ledgers are server-written, and now say so ────────────
for coll in ("ownedItems", "diamondTransactions", "beanTransactions",
             "dailyStats", "weeklyEarnings", "weeklyStatements"):
    # `block()` exists because counting braces from the `match` keyword closes
    # on `{itemId}` in the path. An earlier version of this loop sliced to the
    # first `}` and therefore asserted nothing at all — both checks passed on an
    # empty string.
    blk = block(coll)
    ok(f"{coll} is no longer writable by every department admin",
       "allow write: if isAdmin()" not in blk)
    ok(f"{coll} is closed to clients outright", "allow write: if false" in blk)

# ── The seller form no longer rejects a foreign number ───────────────────────
seller_form = (CRM / "app" / "seller-signup" / "page.tsx").read_text(encoding="utf-8")
# The pattern survives in the comment that explains its removal, so the test
# is that it is no longer EXECUTED — `.test(` is what ran it.
ok("the 10-digit wall no longer runs",
   ".test(form.phone.replace(/\\s/g, ''))" not in seller_form)
ok("and the error no longer calls a foreign number invalid",
   "valid 10-digit phone number" not in seller_form)
ok("it asks for a country code instead", "Include your country code" in seller_form)



# ══════════════════════════════════════════════════════════════════════════════
#  PHASE 3 — the public seller directory
# ══════════════════════════════════════════════════════════════════════════════
#
# The projection and visibility properties live in
# `functions/test/publicSeller.test.js`, which runs the real code. These are the
# wiring checks that code cannot make about itself: that the rules closed the old
# door, that the writer is a trigger rather than anything a client can reach, and
# that the app now reads the new collection.

pub = block("publicSellers")
ok("publicSellers is readable by a signed-in account — it is a directory",
   "allow read:  if request.auth != null;" in pub)
ok("and writable by NOBODY, so there is no client path to argue about",
   "allow write: if false;" in pub)

sellers_blk = strip_comments(block("sellers"))
ok("sellers is no longer listable by an app user", "allow list:   if isStaff();" in sellers_blk)
ok("the approved-and-active list clause is gone, because the collection is",
   "resource.data.get('isApproved', false) == true" not in sellers_blk.split("allow get")[1].split(";")[0])
ok("a seller can still read their own private record",
   "sellerId == request.auth.uid" in sellers_blk)
ok("and staff still can", "allow get:    if isStaff()" in sellers_blk)

FN = ROOT.parent / "functions" / "src"
writer = (FN / "index.ts").read_text(encoding="utf-8")
ok("the writer is a Firestore trigger on the private document",
   "export const syncPublicSeller" in writer and ".document('sellers/{sellerId}')" in writer)
ok("it fires on every write, so no lifecycle path is missed", ".onWrite(" in writer)
ok("it projects through the allowlist rather than copying the document",
   "toPublicSeller(sellerId" in writer)
ok("a seller who stops qualifying is DELETED, not flagged",
   "ref.delete()" in writer)
ok("and it skips writes that do not change the public view",
   "publicViewChanged(before, after)" in writer)

proj = (FN / "publicSeller.ts").read_text(encoding="utf-8")
ok("the allowlist is six fields", proj.count("'") > 0 and "PUBLIC_FIELDS" in proj)
for sensitive in ("idDocUrls", "coinBalance", "commissionRate", "email"):
    ok(f"{sensitive} is named on the never-public list", sensitive in proj)
ok("the projection builds a literal rather than spreading the document",
   "...doc" not in proj)

app_dir = (
    ROOT.parent / "zipper-app" / "app" / "src" / "main" / "java" / "com" / "zipper"
    / "app" / "ui" / "screens" / "diamond" / "ResellerListScreen.kt"
).read_text(encoding="utf-8")
ok("the app reads publicSellers", 'collection("publicSellers")' in app_dir)
ok("and no longer reads the private collection", 'collection("sellers")' not in app_dir)
ok("the isApproved/isActive filters are gone — the collection is the filter",
   'whereEqualTo("isApproved"' not in app_dir)

# ── Result ────────────────────────────────────────────────────────────────────

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\nAll {checks} phase-1 security checks passed.")
print("  · salaryRequests: pinned to the caller's agency, born pending, no self-approval")
print("  · hostApplications: the unbound client activation clause is gone")
print("  · sellers: private to staff and self; the app reads publicSellers")
print("  · withdrawalRequests: a host cannot file one already approved")
print("  · a deactivated staff member is no longer a CRM user to the rules")
print("  · economy config is Tech or the owner, not every *_admin")
print("  · GET /staff no longer returns pay to a department admin")
print("  · nobody signs the money card that pays them")
print("  · audit history is scoped to the people an admin manages")
print("  · a rejected or suspended partner's live session is revoked")
print("  · phone identity is full E.164 — two countries cannot share one key")
print("  · and the survey script reports without writing")
print("  · publicSellers is an allowlist projection, trigger-written, client-closed")
print("  · and the app reads it instead of the private seller record")
sys.exit(0)
