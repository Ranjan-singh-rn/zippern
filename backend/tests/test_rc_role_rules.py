"""RC — the confirmed role-combination rule, at every door the backend owns.

Confirmed (request §3, "Host lifecycle and Agency/Sub-agency relationships"):

  * a person who is a Sub-agency under Agency X may ALSO be a Host under
    Agency X, while being ineligible to become a Host under another Agency or
    any Sub-agency;
  * a Host under a Sub-agency cannot become an Agency or Sub-agency.

Read as a PAIR, whichever role came first: Sub-agency(X) + Host directly
under X is the only agency-family + Host pair allowed. Before this change the
outcome depended on the order (Sub-agency → Host was refused; Host(Y) → a
Sub-agency under any X was allowed).

Service-level integration against in-memory fakes — NOT an end-to-end test.
Every account holds both verified contacts (`harness.verified_auth`): the
subject here is the role table, not the contact rule.

    python3 -m tests.test_rc_role_rules
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs, verified_auth  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
mongo.get_db = lambda: db  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402


async def fake_audit(**kw):
    return "audit-x"


audit_mod.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
firebase_mod.get_user = verified_auth  # type: ignore[assignment]

from app.services import money as money_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, partner_svc, roles, apps, money_mod, users_svc):
    mod.get_db = lambda: db  # type: ignore[assignment]
for mod in (ops, apps, users_svc):
    mod.audit.record = fake_audit
logging.disable(logging.CRITICAL)

checks = 0
failures: list[str] = []


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def refusal(coro) -> Exception | None:
    try:
        asyncio.run(coro)
    except Exception as exc:  # noqa: BLE001
        return exc
    return None


run = asyncio.run
STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None}
WHY = "Documents checked against the originals."
AGENCY_FORM = {
    "agencyName": "Sub", "ownerName": "S", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "S", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
HOST_FORM = {
    "hostName": "H", "age": "24", "country": "India", "callRate": "10",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"], "photoUrl": ["https://x/p"],
}


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def agency(pid: str, owner: str, *, parent: str | None = None) -> None:
    user(owner)
    fs.collection("agencies").docs[pid] = {
        "agencyName": pid, "type": "sub" if parent else "main", "parentAgencyId": parent,
        "status": "pending", "kycStatus": "submitted", "ownerUid": owner, "crmUid": owner,
        "source": "self_signup", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
    }
    run(ops.ensure_partner_record(pid, SERVICE, "Registered."))
    run(ops.approve_partner(pid, WHY, STAFF))


def sub_agency_of(uid: str, main: str) -> str:
    user(uid)
    sid = run(apps.submit_partner_application(uid, "sub_agency", dict(AGENCY_FORM, agencyName=f"Sub {uid}"),
                                              main, SERVICE))["id"]
    run(ops.approve_partner(sid, WHY, STAFF))
    return sid


agency("X", "own-x")
agency("Y", "own-y")
agency("X-SUB", "own-xsub", parent="X")   # another sub-agency under X

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. A Sub-agency under X may be a Host under X — nowhere else")

S1 = sub_agency_of("p-sub", "X")
el = run(apps.eligibility("p-sub"))
eq("eligibility offers Host to a Sub-agency", "host" in el["options"], True)
eq("…pinned to its own main agency", el.get("parent_for", {}).get("host"), "X")

exc = refusal(apps.submit_host_application("p-sub", dict(HOST_FORM), "Y", SERVICE))
ok("a Host application under ANOTHER agency is refused", exc is not None, "it was filed")
ok("…saying why", exc is not None and "only directly under" in str(exc), str(exc))
exc = refusal(apps.submit_host_application("p-sub", dict(HOST_FORM), "X-SUB", SERVICE))
ok("a Host application under a sub-agency (even of X) is refused", exc is not None, "it was filed")
eq("…nothing was written", [d for d in fs.collection("hostApplications").docs.values()
                            if d.get("applicantUid") == "p-sub"], [])

filed = run(apps.submit_host_application("p-sub", dict(HOST_FORM), "X", SERVICE))
eq("a Host application directly under X is filed", filed["status"], "pending")
run(users_svc.decide_host_application(filed["id"], True, WHY, STAFF))
eq("…and granted on approval", fs.collection("users").docs["p-sub"].get("isHost"), True)
eq("…under X", fs.collection("users").docs["p-sub"].get("agencyId"), "X")
eq("the Sub-agency is untouched", db["partners"].docs[S1]["status"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("2. A Host under Y may be a Sub-agency only under Y")

user("p-host")
h = run(apps.submit_host_application("p-host", dict(HOST_FORM), "Y", SERVICE))
run(users_svc.decide_host_application(h["id"], True, WHY, STAFF))
eq("(precondition) a Host under Y", fs.collection("users").docs["p-host"].get("agencyId"), "Y")
exc = refusal(apps.submit_partner_application("p-host", "sub_agency", dict(AGENCY_FORM), "X", SERVICE))
ok("a Sub-agency under ANOTHER main agency is refused", exc is not None, "it was filed")
ok("…saying why", exc is not None and "only under" in str(exc), str(exc))
s2 = run(apps.submit_partner_application("p-host", "sub_agency", dict(AGENCY_FORM, agencyName="Under Y"), "Y", SERVICE))
eq("a Sub-agency under Y is filed", s2["status"], "pending")
run(ops.approve_partner(s2["id"], WHY, STAFF))
eq("…and approved", db["partners"].docs[s2["id"]]["status"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("3. The pair is checked again at the decision, whatever was filed first")

# A Host application under Y filed BEFORE the Sub-agency under X existed
# (the order the old table allowed), decided after it.
user("p-late")
run(apps.submit_host_application("p-late", dict(HOST_FORM), "Y", SERVICE))
fs.collection("agencies").docs["S-LATE"] = {
    "agencyName": "late sub", "type": "sub", "parentAgencyId": "X", "status": "pending",
    "kycStatus": "submitted", "ownerUid": "p-late", "crmUid": "p-late", "source": "crm",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
run(ops.ensure_partner_record("S-LATE", SERVICE, "Registered by staff."))
exc = refusal(ops.approve_partner("S-LATE", WHY, STAFF))
ok("approving a Sub-agency under X for somebody with a Host application under Y is refused",
   exc is not None, "it was approved")
eq("…the Sub-agency stays pending", db["partners"].docs["S-LATE"]["status"], "pending")

# And the other way round: Sub-agency under X approved, then a legacy Host
# application under Y (filed before the rule) is decided.
user("p-legacy")
sub_agency_of("p-legacy", "X")
fs.collection("hostApplications").docs["legacy-y"] = {
    "applicantUid": "p-legacy", "status": "pending", "agencyId": "Y", "hostName": "L",
    "kycStatus": "submitted", "isActivated": False,
}
exc = refusal(users_svc.decide_host_application("legacy-y", True, WHY, STAFF))
ok("granting a Host role under Y to a Sub-agency of X is refused at the decision", exc is not None, "it was granted")
eq("…the account is not a Host", fs.collection("users").docs["p-legacy"].get("isHost"), None)

# ══════════════════════════════════════════════════════════════════════════════
print("4. A Host under a Sub-agency still cannot become an Agency or Sub-agency")

user("p-hsub")
hs = run(apps.submit_host_application("p-hsub", dict(HOST_FORM), "X-SUB", SERVICE))
run(users_svc.decide_host_application(hs["id"], True, WHY, STAFF))
el = run(apps.eligibility("p-hsub"))
eq("only Coin Seller is offered", el["options"], ["seller"])
ok("a Sub-agency application is refused",
   refusal(apps.submit_partner_application("p-hsub", "sub_agency", dict(AGENCY_FORM), "X", SERVICE)) is not None)
ok("an Agency application is refused",
   refusal(apps.submit_partner_application("p-hsub", "agency", dict(AGENCY_FORM), None, SERVICE)) is not None)

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} RC role-rule checks passed.")
