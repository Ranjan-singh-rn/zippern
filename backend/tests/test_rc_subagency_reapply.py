"""Decision 16 (RC) — Sub-agency reapplication after rejection.

The confirmed rule, verbatim from the request:

  * Rejection releases the registration slot.
  * The applicant may submit a fresh application, including under the same Agency.
  * The rejected application and its decision history are preserved.
  * The new application is a NEW record, not an overwrite.
  * Concurrent submissions must not create duplicate active applications or
    orphaned records.
  * Behaviour must be consistent across Android, backend, Functions, Firestore
    and CRM.

Two doors, both run here:

  * the app's own application (`submit_partner_application`, what the Android
    "Join as Sub-agency" calls through `submitPartnerApplication`);
  * a parent agency re-filing from its dashboard for a person whose login
    already exists from the rejected attempt (`reapply_sub_agency`, what the
    CRM's Add Sub-Agency now calls when Firebase refuses the address).

Service-level integration against in-memory fakes — NOT an end-to-end test.

REAL: services.partner_applications, partner_ops (reject / approve /
      ensure_partner_record), partner_roles (the one-agency claim),
      crm_directory (the login document), core.security.resolve_partner_login,
      the router function of the re-application route (called directly).
FAKE: Mongo (`tests/fakes.FakeDb`), Firestore (`tests/fakes.FakeFirestore`),
      Firebase Auth (per uid).

    python3 -m tests.test_rc_subagency_reapply
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import auth_record, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

db = FakeDb()
fs = FakeFirestore()
mongo.get_db = lambda: db  # type: ignore[assignment]

from app.core import audit as audit_mod  # noqa: E402
from app.core import security  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
AUTH: dict[str, object] = {}
firebase_mod.get_user = lambda uid: AUTH.get(uid)  # type: ignore[assignment]
firebase_mod.get_user_by_email = lambda e: next(  # type: ignore[assignment]
    (r for r in AUTH.values() if str(getattr(r, "email", "") or "").lower() == str(e or "").lower()), None)

from app.services import money as money_mod  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, partner_svc, roles, apps, money_mod, users_svc, security):
    if hasattr(mod, "get_db"):
        mod.get_db = lambda: db  # type: ignore[assignment]
for mod in (ops, apps):
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
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None,
           "service_credential": "partner-registration"}
WHY = "Documents checked against the originals."
NO = "The documents do not match the applicant."

FORM = {
    "agencyName": "Sub One", "ownerName": "S", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "S", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str) -> dict:
    return db["partners"].docs.get(pid) or {}


def family_records(uid: str) -> list[dict]:
    return [p for p in db["partners"].docs.values()
            if p.get("owner_crm_uid") == uid and p.get("kind") in ("agency", "sub_agency")]


def claim(uid: str) -> dict | None:
    return db[roles.PARTNER_ROLE_CLAIMS].docs.get(f"agency:{uid}")


def login(uid: str) -> dict:
    return fs.collection("crmUsers").docs.get(uid) or {}


def main_agency(pid: str, owner: str) -> None:
    user(owner)
    AUTH[owner] = auth_record(owner, phone=f"+9197{abs(hash(owner)) % 10**8:08d}",
                              email=f"{owner}@x.test", email_verified=True)
    fs.collection("agencies").docs[pid] = {
        "agencyName": pid, "type": "main", "status": "pending", "kycStatus": "submitted",
        "ownerUid": owner, "crmUid": owner, "source": "self_signup",
        "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
    }
    run(ops.ensure_partner_record(pid, SERVICE, "Registered."))
    run(ops.approve_partner(pid, WHY, STAFF))


main_agency("MAIN1", "own-main1")
main_agency("MAIN2", "own-main2")

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The app's own path — rejected, then a fresh application under the SAME agency")

user("APP-S")
AUTH["APP-S"] = auth_record("APP-S", phone="+910000000501")
first = run(apps.submit_partner_application("APP-S", "sub_agency", dict(FORM), "MAIN1", SERVICE))
A1 = first["id"]
eq("(precondition) the first application holds the slot", (claim("APP-S") or {}).get("partner_id"), A1)
run(ops.reject_partner(A1, NO, STAFF))
eq("rejection releases the registration slot (no claim names it)", claim("APP-S"), None)
eq("…the rejected record is kept", partner(A1).get("status"), "rejected")
eq("…with its decision history", [h.get("reason") for h in partner(A1).get("rejection_history") or []], [NO])
eq("…and its Firestore document keeps the reason", fs.collection("agencies").docs[A1].get("rejectionReason"), NO)

el = run(apps.eligibility("APP-S"))
ok("the app offers Sub-agency again", "sub_agency" in el["options"], repr(el["options"]))

second = run(apps.submit_partner_application("APP-S", "sub_agency", dict(FORM, agencyName="Sub One again"),
                                             "MAIN1", SERVICE))
A2 = second["id"]
ok("the fresh application is a NEW record", A2 != A1, f"{A1} vs {A2}")
eq("…pending", partner(A2).get("status"), "pending")
eq("…under the same agency", partner(A2).get("parent_id"), "MAIN1")
eq("the old record is untouched", (partner(A1).get("status"), partner(A1).get("rejection_reason")), ("rejected", NO))
eq("the slot now names the new application", (claim("APP-S") or {}).get("partner_id"), A2)
eq("the login document follows the new application", login("APP-S").get("agencyId"), A2)
eq("…pending", (login("APP-S").get("roleStatus") or {}).get("agency"), "pending")
eq("exactly two family records: one rejected, one pending",
   sorted(p.get("status") for p in family_records("APP-S")), ["pending", "rejected"])

exc = refusal(ops.approve_partner(A1, WHY, STAFF))
ok("the OLD rejected record cannot be approved past the newer application", exc is not None, "it was approved")
eq("…it stays rejected", partner(A1).get("status"), "rejected")
eq("…and the new one is untouched", partner(A2).get("status"), "pending")

pl = run(security.resolve_partner_login("APP-S", "", email_proven=False))
eq("sign-in gives the waiting room for the new application (not 'rejected')", pl.status if pl else None, "pending")

# ══════════════════════════════════════════════════════════════════════════════
print("2. …or under ANOTHER agency")

user("APP-T")
AUTH["APP-T"] = auth_record("APP-T", phone="+910000000502")
t1 = run(apps.submit_partner_application("APP-T", "sub_agency", dict(FORM), "MAIN1", SERVICE))["id"]
run(ops.reject_partner(t1, NO, STAFF))
t2 = run(apps.submit_partner_application("APP-T", "sub_agency", dict(FORM), "MAIN2", SERVICE))["id"]
eq("a fresh application under another agency is a new pending record",
   (t2 != t1, partner(t2).get("status"), partner(t2).get("parent_id")), (True, "pending", "MAIN2"))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Two submissions at once after a rejection → one application, no orphan")

user("APP-C")
AUTH["APP-C"] = auth_record("APP-C", phone="+910000000503")
c1 = run(apps.submit_partner_application("APP-C", "sub_agency", dict(FORM), "MAIN1", SERVICE))["id"]
run(ops.reject_partner(c1, NO, STAFF))
docs_before = set(fs.collection("agencies").docs)


async def _two():
    return await asyncio.gather(
        apps.submit_partner_application("APP-C", "sub_agency", dict(FORM, agencyName="Tab A"), "MAIN1", SERVICE),
        apps.submit_partner_application("APP-C", "sub_agency", dict(FORM, agencyName="Tab B"), "MAIN1", SERVICE),
        return_exceptions=True,
    )


outs = run(_two())
won = [o for o in outs if isinstance(o, dict)]
eq("exactly one of the two is filed", len(won), 1)
eq("one pending family record (plus the rejected one)",
   sorted(p.get("status") for p in family_records("APP-C")), ["pending", "rejected"])
new_docs = set(fs.collection("agencies").docs) - docs_before
eq("no orphaned Firestore document is left behind", sorted(new_docs), sorted(w["id"] for w in won))

# ══════════════════════════════════════════════════════════════════════════════
print("4. A failure part-way leaves nothing, and the retry files exactly one")

user("APP-R")
AUTH["APP-R"] = auth_record("APP-R", phone="+910000000504")
r1 = run(apps.submit_partner_application("APP-R", "sub_agency", dict(FORM), "MAIN1", SERVICE))["id"]
run(ops.reject_partner(r1, NO, STAFF))
docs_before = set(fs.collection("agencies").docs)
_real_ensure = ops.ensure_partner_record
_calls = {"n": 0}


async def _flaky(*a, **k):
    _calls["n"] += 1
    if _calls["n"] == 1:
        raise RuntimeError("Mongo blinked")
    return await _real_ensure(*a, **k)


ops.ensure_partner_record = _flaky  # type: ignore[assignment]
exc = refusal(apps.submit_partner_application("APP-R", "sub_agency", dict(FORM), "MAIN1", SERVICE))
ok("the first attempt fails", exc is not None)
eq("…leaving no Firestore document", set(fs.collection("agencies").docs) - docs_before, set())
eq("…and no new record", sorted(p.get("status") for p in family_records("APP-R")), ["rejected"])
retry = run(apps.submit_partner_application("APP-R", "sub_agency", dict(FORM), "MAIN1", SERVICE))
ops.ensure_partner_record = _real_ensure  # type: ignore[assignment]
eq("the retry files exactly one", sorted(p.get("status") for p in family_records("APP-R")), ["pending", "rejected"])
eq("…and one document", len(set(fs.collection("agencies").docs) - docs_before), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("5. The parent's dashboard — the login already exists from the rejected attempt")

# A sub-agency the parent created from its dashboard: a password login made by
# the parent, unverified, with a record the trigger registered.
AUTH["CRM-S"] = auth_record("CRM-S", email="crm-s@x.test", email_verified=False, providers=("password",))
fs.collection("agencies").docs["SUB-OLD"] = {
    "agencyName": "Sub old", "type": "sub", "parentAgencyId": "MAIN1", "status": "pending",
    "kycStatus": "submitted", "ownerEmail": "crm-s@x.test", "crmUid": "CRM-S",
    "source": "agency_created", "createdByUid": "own-main1",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
fs.collection("crmUsers").docs["CRM-S"] = {"uid": "CRM-S", "role": "agency", "status": "pending",
                                           "agencyId": "SUB-OLD", "isActive": True, "email": "crm-s@x.test"}
run(ops.ensure_partner_record("SUB-OLD", SERVICE, "Registered."))
run(ops.reject_partner("SUB-OLD", NO, STAFF))
eq("(precondition) rejected, slot released", (partner("SUB-OLD").get("status"), claim("CRM-S")), ("rejected", None))

PARENT_SESSION = {"uid": "own-main1", "role": "agency", "partner_ids": {"agency": "MAIN1"}}
docs_before = set(fs.collection("agencies").docs)
out = run(apps.reapply_sub_agency("MAIN1", "crm-s@x.test", dict(FORM, agencyName="Sub new"), PARENT_SESSION))
NEW = out["id"]
ok("a NEW application is filed for the existing login", NEW not in ("SUB-OLD", ""), repr(out))
eq("…pending", partner(NEW).get("status"), "pending")
eq("…owned by the same login (no second identity)", partner(NEW).get("owner_crm_uid"), "CRM-S")
eq("…under the parent", partner(NEW).get("parent_id"), "MAIN1")
eq("…marked as following the rejected one", fs.collection("agencies").docs[NEW].get("reapplicationOf"), "SUB-OLD")
eq("…written by the API (the trigger skips this source)", fs.collection("agencies").docs[NEW].get("source"),
   apps.SOURCE_REAPPLY)
eq("the rejected record is kept exactly", (partner("SUB-OLD").get("status"),
                                           [h.get("reason") for h in partner("SUB-OLD").get("rejection_history") or []]),
   ("rejected", [NO]))
eq("the login follows the new application", login("CRM-S").get("agencyId"), NEW)
eq("…pending", (login("CRM-S").get("roleStatus") or {}).get("agency"), "pending")
eq("the slot names the new application", (claim("CRM-S") or {}).get("partner_id"), NEW)
ok("the re-application is audited", any(a["action"] == apps.REAPPLIED and a["subject_id"] == NEW for a in AUDIT))

exc = refusal(apps.reapply_sub_agency("MAIN1", "crm-s@x.test", dict(FORM), PARENT_SESSION))
ok("re-applying again while one is pending is refused", exc is not None, "it was filed")
ok("…naming the pending record", exc is not None and NEW in str(exc), str(exc))

# Concurrency on this door too.
AUTH["CRM-K"] = auth_record("CRM-K", email="crm-k@x.test", providers=("password",))
fs.collection("agencies").docs["SUB-K"] = {
    "agencyName": "Sub K", "type": "sub", "parentAgencyId": "MAIN1", "status": "pending",
    "kycStatus": "submitted", "ownerEmail": "crm-k@x.test", "crmUid": "CRM-K", "source": "agency_created",
    "createdByUid": "own-main1", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
run(ops.ensure_partner_record("SUB-K", SERVICE, "Registered."))
run(ops.reject_partner("SUB-K", NO, STAFF))
docs_before = set(fs.collection("agencies").docs)


async def _two_reapply():
    return await asyncio.gather(
        apps.reapply_sub_agency("MAIN1", "crm-k@x.test", dict(FORM), PARENT_SESSION),
        apps.reapply_sub_agency("MAIN1", "crm-k@x.test", dict(FORM), PARENT_SESSION),
        return_exceptions=True,
    )


outs = run(_two_reapply())
won = [o for o in outs if isinstance(o, dict)]
eq("two re-applications at once → one filed", len(won), 1)
eq("…one pending record beside the rejected one",
   sorted(p.get("status") for p in family_records("CRM-K")), ["pending", "rejected"])
eq("…and no orphaned document", sorted(set(fs.collection("agencies").docs) - docs_before),
   sorted(w["id"] for w in won))

# Who may NOT be re-applied for.
exc = refusal(apps.reapply_sub_agency("MAIN1", "nobody@x.test", dict(FORM), PARENT_SESSION))
ok("an address with no login is refused (use Add Sub-Agency)", exc is not None and "No Zipper login" in str(exc),
   str(exc))
AUTH["APP-PLAIN"] = auth_record("APP-PLAIN", email="plain@x.test", email_verified=True)
user("APP-PLAIN")
exc = refusal(apps.reapply_sub_agency("MAIN1", "plain@x.test", dict(FORM), PARENT_SESSION))
ok("a login with no rejected Sub-agency history is refused (cannot hang an application on anyone)",
   exc is not None and "no rejected Sub-agency" in str(exc), str(exc))
exc = refusal(apps.reapply_sub_agency("MAIN1", "APP-S@x.test".lower(), dict(FORM), PARENT_SESSION))
ok("an address that is nobody's login is refused", exc is not None, "it was filed")

# The route: a partner may name only its OWN agency.
from app.routers import partner_ops as router  # noqa: E402

body = router.SubAgencyReapply(email="crm-s@x.test", form=dict(FORM))
try:
    run(router.reapply_sub_agency("MAIN2", body, PARENT_SESSION))
    _scoped = None
except Exception as e:  # noqa: BLE001
    _scoped = e
eq("the route refuses a parent naming another agency (scope)", getattr(_scoped, "status_code", None), 403)
member = {"uid": "staff-m", "name": "M", "role": "ops_member", "team": "ops"}
try:
    run(router.reapply_sub_agency("MAIN1", body, member))
    _member = None
except Exception as e:  # noqa: BLE001
    _member = e
eq("…and staff below team admin", getattr(_member, "status_code", None), 403)

# ══════════════════════════════════════════════════════════════════════════════
print("6. A rejected login is told WHY at sign-in, not 'deactivated'")

AUTH["CRM-X"] = auth_record("CRM-X", email="crm-x@x.test", providers=("password",))
fs.collection("agencies").docs["SUB-X"] = {
    "agencyName": "Sub X", "type": "sub", "parentAgencyId": "MAIN1", "status": "pending",
    "kycStatus": "submitted", "ownerEmail": "crm-x@x.test", "crmUid": "CRM-X", "source": "agency_created",
    "createdByUid": "own-main1", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
fs.collection("crmUsers").docs["CRM-X"] = {"uid": "CRM-X", "role": "agency", "status": "pending",
                                           "agencyId": "SUB-X", "isActive": True, "email": "crm-x@x.test"}
run(ops.ensure_partner_record("SUB-X", SERVICE, "Registered."))
run(ops.reject_partner("SUB-X", NO, STAFF))
eq("(precondition) the rejection left the login inactive", login("CRM-X").get("isActive"), False)
try:
    run(security.resolve_partner_login("CRM-X", "crm-x@x.test", email_proven=False))
    _signin = None
except Exception as e:  # noqa: BLE001
    _signin = e
ok("sign-in is refused (no session)", _signin is not None)
ok("…with the rejection reason, not 'deactivated'", _signin is not None and NO in str(_signin)
   and "deactivated" not in str(_signin), str(_signin))
ok("…and says a new application is possible", _signin is not None and "apply again" in str(_signin), str(_signin))

# A login the CRM switched off while its record is live is still "deactivated".
fs.collection("crmUsers").docs["own-main2"] = {"uid": "own-main2", "role": "agency", "status": "approved",
                                               "agencyId": "MAIN2", "isActive": False}
try:
    run(security.resolve_partner_login("own-main2", "own-main2@x.test", email_proven=False))
    _off = None
except Exception as e:  # noqa: BLE001
    _off = e
ok("a switched-off login with a live record is still 'deactivated'", _off is not None and "deactivated" in str(_off),
   str(_off))

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} Decision 16 re-application checks passed.")
