"""The partner role lifecycle, end to end: eligibility, hierarchy, revocation,
notification, re-application. The §23 matrix, executed against the real code.

── WHAT THIS PINS SHUT ─────────────────────────────────────────────────────

  * the role table — which roles a person may ADD given what they hold, as a
    pure function over authoritative state (`eligible_kinds`);
  * the hierarchy — one Agency may have unlimited Sub-agencies owned by
    different humans; a Sub-agency may not have one; a pending, rejected,
    revoked or nonexistent parent is refused; all server-side;
  * revocation — the role goes, the human stays, other roles survive, the
    login stays active for them, history is untouched — and (C1) the revoked
    role still counts: the sentinel is KEPT, the same kind is refused at
    submit, CRM creation and approval with the reinstatement sentence, and
    only the Owner restores it, as the same record (C2);
  * dependents — an agency with sub-agencies or hosts cannot be revoked into
    a void; with a replacement they move and are told; a sub-agency's hosts
    go up to its parent;
  * notification — every lifecycle event writes exactly one Official
    message, on `userId`, idempotent on retry; and
  * the Ruhan shape — Agency + Coin Seller stays allowed, through the real
    creation path, with a fixture rather than the production account.

REAL: `partner_applications`, `partner_ops`, `partner_roles`, `notices`.
FAKE: Mongo (`tests/harness.FakeDb`) and Firestore (`tests/fakes.FakeFirestore`).

    python3 -m tests.test_partner_lifecycle
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

# `fakes.FakeDb` (dict-backed, with the unique indexes and `$push`/`$inc`)
# rather than the harness one — the lifecycle leans on `find_one_and_update`
# with `$push`, on `crm_id` uniqueness, and on `_id` races.
from tests.fakes import FakeDb, FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.services import notices  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402

# Phase 1A (AUTH-002): these fixtures are verified people; the guest refusal
# is covered by tests/test_phase1a_identity.py.
apps.is_unverified_guest = lambda uid: False
from app.services.partner_ops import PartnerOpsError  # noqa: E402

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


def refuses(claim: str, coro) -> str:
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc}) — wanted PartnerOpsError")
        return ""
    failures.append(f"{claim}: was NOT refused")
    return ""


run = asyncio.run

# ── The world ───────────────────────────────────────────────────────────────

db = FakeDb()
fs = FakeFirestore()
audit_entries: list[dict] = []


async def fake_audit(**kw):
    audit_entries.append(kw)
    return f"audit-{len(audit_entries)}"


from app.services import money as money_mod  # noqa: E402
from app.services import users as users_svc  # noqa: E402

for mod in (ops, partner_svc, roles, apps, money_mod, users_svc):
    mod.get_db = lambda: db  # type: ignore[assignment]
audit_mod.record = fake_audit
ops.audit.record = fake_audit
apps.audit.record = fake_audit
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
# L3/B48: a self-filed Host application takes its contact details from the
# VERIFIED sign-in only, never from `users/{uid}` or the form. These fixtures
# sign in with a verified email and no phone.
import types as _types  # noqa: E402

# Decision 15 (RC): a role starts only with BOTH contacts verified, so these
# fixtures now also hold an SMS-linked phone (deterministic per uid). The
# subject of this module is the partner lifecycle, not the contact rule —
# tests/test_rc_contact_verification.py runs that with per-uid records.
from tests import harness as _rc_harness  # noqa: E402

firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]
logging.disable(logging.CRITICAL)

STAFF = {"uid": "staff-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
#: C2 / C3 — restoring a revoked role and moving dependents are the Owner's.
OWNER = {"uid": "owner-1", "name": "Owner", "role": "owner", "team": None}
SERVICE = {"uid": "system:partner-registration", "name": "reg", "role": "system", "team": None}
WHY = "Reviewed and decided."


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "email": f"{uid}@x.test",
                                        "phone": f"+91{abs(hash(uid)) % 10**9:09d}", **over}


def partner(pid: str) -> dict:
    return db["partners"].docs[pid]


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


def notice_types(uid: str) -> list[str]:
    return sorted(d["type"] for d in notices_for(uid))


AGENCY_FORM = {
    "agencyName": "Skyline", "ownerName": "A", "ownerPhone": "+911", "ownerEmail": "a@x.test",
    "address": "1 Road", "paymentType": "india", "accountHolderName": "A", "accountNumber": "123",
    "ifscCode": "HDFC0001", "bankName": "HDFC", "branch": "Main",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
SELLER_FORM = {
    "displayName": "Coins R Us", "phone": "+912", "email": "s@x.test", "city": "Pune",
    "idDocUrls": ["https://x/id"],
    "payment": {"upiId": "coins@upi", "accountNumber": "999", "ifscCode": "SBIN0001", "bankName": "SBI"},
}


def apply(uid: str, kind: str, parent: str | None = None, **over) -> dict:
    form = dict(SELLER_FORM if kind == "seller" else AGENCY_FORM)
    form.update(over)
    return run(apps.submit_partner_application(uid, kind, form, parent, SERVICE))


def approve(pid: str) -> dict:
    return run(ops.approve_partner(pid, WHY, STAFF))


# ══════════════════════════════════════════════════════════════════════════════
print("\n1. The role table — pure, over authoritative state")

T = apps.eligible_kinds
none = {"partners": [], "host": None, "pending_host_application": None}
eq("a normal user may apply for all four", T(none)["options"], ["host", "agency", "sub_agency", "seller"])

def held(*kinds, host=None, pending=None):
    return {"partners": [{"id": k, "kind": k, "status": "approved", "name": k, "parent_id": None} for k in kinds],
            "host": host, "pending_host_application": pending}

eq("Agency → Coin Seller only", T(held("agency"))["options"], ["seller"])
# RC (confirmed role rule): a Sub-agency under main Agency X may ALSO be a Host
# directly under X — and nowhere else. With no main agency on the record the
# pair cannot be pinned, so it is not offered.
eq("Sub-agency with no main agency on record → Coin Seller only", T(held("sub_agency"))["options"], ["seller"])
_sub_x = {"partners": [{"id": "S", "kind": "sub_agency", "status": "approved", "name": "S", "parent_id": "X"}],
          "host": None, "pending_host_application": None}
eq("RC: Sub-agency under X → Host or Coin Seller", T(_sub_x)["options"], ["host", "seller"])
eq("RC: …the Host only directly under X", T(_sub_x)["parent_for"], {"host": "X"})
eq("RC: a Host under Y may add a Sub-agency only under Y",
   T(held(host={"agency_id": "Y", "parent_kind": "agency"}))["parent_for"], {"sub_agency": "Y"})
eq("RC: Sub-agency(X) + Host(X) → Coin Seller only",
   T({**_sub_x, "host": {"agency_id": "X", "parent_kind": "agency"}})["options"], ["seller"])
eq("Coin Seller → Host, Agency, Sub-agency", T(held("seller"))["options"], ["host", "agency", "sub_agency"])
eq("Host under MAIN → Sub-agency, Coin Seller",
   T(held(host={"agency_id": "A", "parent_kind": "agency"}))["options"], ["sub_agency", "seller"])
eq("Host under SUB → Coin Seller only",
   T(held(host={"agency_id": "B", "parent_kind": "sub_agency"}))["options"], ["seller"])
eq("Agency + Seller → nothing further", T(held("agency", "seller"))["options"], [])
eq("Sub-agency + Seller → nothing further", T(held("sub_agency", "seller"))["options"], [])
eq("Host under main + Seller → Sub-agency only",
   T(held("seller", host={"agency_id": "A", "parent_kind": "agency"}))["options"], ["sub_agency"])
eq("Host under sub + Seller → nothing further",
   T(held("seller", host={"agency_id": "B", "parent_kind": "sub_agency"}))["options"], [])
eq("a pending Host application under a MAIN agency binds like that Host",
   T(held(pending={"id": "h1", "agency_id": "A", "parent_kind": "agency"}))["options"], ["sub_agency", "seller"])
eq("a pending Host application under a SUB-agency binds like that Host",
   T(held(pending={"id": "h1", "agency_id": "B", "parent_kind": "sub_agency"}))["options"], ["seller"])
ok("…and Agency is blocked while it is pending (Host + Agency)",
   "agency" not in T(held(pending={"id": "h1", "agency_id": "A", "parent_kind": "agency"}))["options"])
ok("a blocked role carries a sentence for the screen",
   "already hold" in T(held("agency"))["blocked"]["agency"])
# Rejected holds nothing. REVOKED is held (C1): a revoked role still counts for
# the combination table, and its own kind says "request reinstatement".
ok("rejected is not held", "rejected" not in apps.HELD_STATUSES)
ok("C1: revoked IS held — a revoked role still counts", "revoked" in apps.HELD_STATUSES)
ok("suspended IS held — the business still exists", "suspended" in apps.HELD_STATUSES)


def revoked_rec(kind):
    return {"id": f"rev-{kind}", "kind": kind, "status": "revoked", "name": kind, "parent_id": None,
            "revoked_at": "2026-10-01T00:00:00+00:00", "revoked_reason": "Policy."}


REV = apps.REVOKED_REFUSAL.format
seller_ok = {"id": "s1", "kind": "seller", "status": "approved", "name": "s", "parent_id": None}
t_ra_s = T({"partners": [revoked_rec("agency"), seller_ok], "host": None, "pending_host_application": None})
eq("C1 revoked Agency + Seller → nothing further: Agency is NOT offered again", t_ra_s["options"], [])
eq("C1 …the Agency choice says request reinstatement", t_ra_s["blocked"]["agency"], REV(role="Agency"))
eq("C1 …the Seller choice still says it is held", t_ra_s["blocked"]["seller"], "You already hold a Coin Seller role.")
t_ra = T({"partners": [revoked_rec("agency")], "host": None, "pending_host_application": None})
eq("C1 a revoked Agency still constrains: Coin Seller only", t_ra["options"], ["seller"])
ok("C1 …so a revoked Agency still blocks Host", "host" in t_ra["blocked"])
ok("C1 …and Sub-agency (same family)", "sub_agency" in t_ra["blocked"])
eq("C1 a revoked Sub-agency blocks its own kind with the reinstatement sentence",
   T({"partners": [revoked_rec("sub_agency")], "host": None, "pending_host_application": None})["blocked"]["sub_agency"],
   REV(role="Sub-agency"))
eq("C1 a revoked Coin Seller: Seller blocked with the reinstatement sentence",
   T({"partners": [revoked_rec("seller")], "host": None, "pending_host_application": None})["blocked"]["seller"],
   REV(role="Coin Seller"))
t_rh = T(held(host={"agency_id": "A", "parent_kind": "agency", "status": "revoked"}))
eq("C1 a revoked Host under main constrains like a Host: Sub-agency + Seller", t_rh["options"], ["sub_agency", "seller"])
eq("C1 …and Host itself says request reinstatement", t_rh["blocked"]["host"], REV(role="Host"))
eq("C1 a live record's sentence wins over a revoked one of the same family",
   T({"partners": [revoked_rec("agency"), {"id": "a2", "kind": "agency", "status": "approved", "name": "Agency",
                                          "parent_id": None}], "host": None,
      "pending_host_application": None})["blocked"]["agency"],
   "You already hold a Agency. One agency-family role per person.")

# ══════════════════════════════════════════════════════════════════════════════
print("2. Identity — a normal user applies, ownership is server-set")

for u in ("h-a", "h-b", "h-c", "h-d", "h-seller", "h-ruhan", "h-x", "h-y", "h-z", "h-host1", "h-host2"):
    user(u)

a = apply("h-a", "agency")
eq("application is pending", a["status"], "pending")
A = a["id"]
eq("ownerUid written by the server", fs.collection("agencies").docs[A]["ownerUid"], "h-a")
eq("crmUid written too", fs.collection("agencies").docs[A]["crmUid"], "h-a")
eq("owner_crm_uid on the Mongo record at birth", partner(A)["owner_crm_uid"], "h-a")
eq("…and the record is a main agency", partner(A)["kind"], "agency")
eq("the applicant is told it was received", notice_types("h-a"), ["partner_submitted"])
ok("crmUsers was written, pending", "h-a" in fs.collection("crmUsers").docs)
ok("the application is audited", any(e["action"] == "partner.applied" and e["subject_id"] == A
                                      for e in audit_entries))

# A client cannot set ownerUid: the form field is ignored.
x = apply("h-x", "agency", ownerUid="somebody-else", crmUid="somebody-else")
eq("ownerUid from the form body is ignored", fs.collection("agencies").docs[x["id"]]["ownerUid"], "h-x")
X = x["id"]

s = apply("h-seller", "seller")
S = s["id"]
eq("a seller application is pending", partner(S)["status"], "pending")
eq("seller payment block is stored", fs.collection("sellers").docs[S]["payment"]["upiId"], "coins@upi")
eq("seller ownerUid set", fs.collection("sellers").docs[S]["ownerUid"], "h-seller")

approve(A)
eq("approval → approved", partner(A)["status"], "approved")
eq("…and the applicant is told", notice_types("h-a"), ["partner_approved", "partner_submitted"])
approve(X)

# ══════════════════════════════════════════════════════════════════════════════
print("3. Hierarchy — unlimited sub-agencies under one agency, one level only")

b = apply("h-b", "sub_agency", parent=A); B = b["id"]
c = apply("h-c", "sub_agency", parent=A); Cc = c["id"]
d = apply("h-d", "sub_agency", parent=A); D = d["id"]
eq("Sub B under A", partner(B)["parent_id"], A)
eq("Sub C under A", partner(Cc)["parent_id"], A)
eq("Sub D under A", partner(D)["parent_id"], A)
ok("different humans", len({partner(p)["owner_crm_uid"] for p in (B, Cc, D)}) == 3)
ok("B still exists after C and D", partner(B)["kind"] == "sub_agency")
subs = run(partner_svc.sub_agencies_of(A))
eq("the parent query returns all three", sorted(x["id"] for x in subs), sorted([B, Cc, D]))
approve(B)

m = refuses("Sub under Sub is refused", apps.submit_partner_application("h-y", "sub_agency", AGENCY_FORM, B, SERVICE))
ok("…and says why", "itself a sub-agency" in m)
ok("…and nothing was written", "h-y" not in {p.get("owner_crm_uid") for p in db["partners"].docs.values()})
m = refuses("nonexistent parent is refused", apps.submit_partner_application("h-y", "sub_agency", AGENCY_FORM, "nope", SERVICE))
ok("…plainly", "not a registered agency" in m)
# A pending parent: a fresh, undecided agency.
p_pending = apply("h-z", "agency"); PZ = p_pending["id"]
m = refuses("a PENDING parent is refused", apps.submit_partner_application("h-y", "sub_agency", AGENCY_FORM, PZ, SERVICE))
ok("…saying it is pending", "pending" in m.lower())
m = refuses("a SELLER as parent is refused", apps.submit_partner_application("h-y", "sub_agency", AGENCY_FORM, S, SERVICE))
m = refuses("your OWN agency as parent is refused", apps.submit_partner_application("h-a", "sub_agency", AGENCY_FORM, A, SERVICE))
m = refuses("no parent at all is refused", apps.submit_partner_application("h-y", "sub_agency", AGENCY_FORM, None, SERVICE))
ok("…asking for one", "Choose" in m or "must name" in m or "agency" in m.lower())

# ══════════════════════════════════════════════════════════════════════════════
# ── "Unlimited": twenty-five more different humans under the same agency ────
for i in range(25):
    u = f"h-many-{i}"
    user(u)
    apply(u, "sub_agency", parent=A)
many = [p for p in db["partners"].docs.values() if p["kind"] == "sub_agency" and p["parent_id"] == A]
eq("one agency holds 28 sub-agencies (B, C, D + 25) — no per-parent limit", len(many), 28)
eq("…owned by 28 different humans", len({p["owner_crm_uid"] for p in many}), 28)
ok("no uniqueness on parent_id anywhere in the Mongo index declarations",
   "parent_id\", ASCENDING)], unique=True" not in open(ROOT / "app" / "db" / "mongo.py").read())

print("4. Combinations — through the real creation path")

m = refuses("Agency + Agency denied", apps.submit_partner_application("h-a", "agency", AGENCY_FORM, None, SERVICE))
m = refuses("Agency + Sub-agency denied", apps.submit_partner_application("h-a", "sub_agency", AGENCY_FORM, X, SERVICE))
m = refuses("Sub-agency + Agency denied", apps.submit_partner_application("h-b", "agency", AGENCY_FORM, None, SERVICE))
m = refuses("Sub-agency + Sub-agency denied", apps.submit_partner_application("h-b", "sub_agency", AGENCY_FORM, X, SERVICE))
m = refuses("Seller + Seller denied", apps.submit_partner_application("h-seller", "seller", SELLER_FORM, None, SERVICE))

ra = apply("h-ruhan", "agency"); RA = ra["id"]; approve(RA)
rs = apply("h-ruhan", "seller"); RS = rs["id"]
eq("Agency + Seller ALLOWED (the Ruhan shape, on a fixture)", partner(RS)["kind"], "seller")
approve(RS)
cu = fs.collection("crmUsers").docs["h-ruhan"]
eq("the second capability did NOT replace the login's primary role", cu["role"], "agency")
eq("…both capabilities are listed", sorted(cu["roles"]), ["agency", "seller"])
eq("…each with its own status", (cu["roleStatus"]["agency"], cu["roleStatus"]["seller"]), ("approved", "approved"))
eq("…and the agency link survived the seller link", cu.get("agencyId"), RA)
bs = apply("h-b", "seller"); BS = bs["id"]
eq("Sub-agency + Seller ALLOWED", partner(BS)["owner_crm_uid"], "h-b")
ss = apply("h-seller", "agency"); SA = ss["id"]
eq("Seller + Agency ALLOWED", partner(SA)["kind"], "agency")
sx = apply("h-c", "seller")
eq("Seller + Sub-agency ALLOWED (sub first)", partner(sx["id"])["kind"], "seller")
elig = run(apps.eligibility("h-ruhan"))
eq("Ruhan-shape: nothing further may be added", elig["options"], [])
# The Android tag reads users/{uid}. Agency + Seller must show BOTH, and the
# second capability must not turn the person into "Seller only".
ru = fs.collection("users").docs["h-ruhan"]
eq("app: Agency + Seller → isAgent", ru.get("isAgent"), True)
eq("app: Agency + Seller → isSeller", ru.get("isSeller"), True)
eq("app: ownAgencyId stamped for the agency dashboard", ru.get("ownAgencyId"), RA)
ok("app: the owner's own agency is NOT written into agencyId (that is a Host's agency)", ru.get("agencyId") is None)
eq("app: a partner carries no staff crmRole (matches syncMyRoles)", ru.get("crmRole"), "")
eq("app: a partner is not official", ru.get("isOfficial"), False)
eq("app: role approval did NOT complete the profile", ru.get("isProfileComplete"), None)
from app.services import crm_directory as crm_dir  # noqa: E402
F = crm_dir.app_role_flags
eq("flags: roles list, both approved", F({"role": "agency", "roles": ["agency", "seller"], "isActive": True,
   "roleStatus": {"agency": "approved", "seller": "approved"}}), {"isAgent": True, "isSeller": True})
eq("flags: primary role alone (old doc, no roles list)", F({"role": "agency", "isActive": True}),
   {"isAgent": True, "isSeller": False})
eq("flags: revoked agency withdrawn", F({"role": "agency", "roles": ["agency", "seller"], "isActive": True,
   "roleStatus": {"agency": "revoked", "seller": "approved"}}), {"isAgent": False, "isSeller": True})
eq("flags: suspended withdrawn, pending earns nothing yet", F({"role": "seller", "roles": ["seller", "agency"],
   "roleStatus": {"seller": "suspended", "agency": "pending"}}), {"isAgent": False, "isSeller": False})
eq("flags: CRM-created agency (status approved, no roleStatus)", F({"role": "agency", "status": "approved",
   "isActive": True, "agencyId": "fp"}), {"isAgent": True, "isSeller": False})
eq("flags: pending login, no roleStatus → nothing", F({"role": "agency", "status": "pending"}),
   {"isAgent": False, "isSeller": False})
eq("flags: inactive login holds nothing", F({"role": "agency", "roles": ["agency"], "isActive": False}),
   {"isAgent": False, "isSeller": False})
eq("flags: no document holds nothing", F(None), {"isAgent": False, "isSeller": False})
# push never invents an app profile for someone who never opened the app.
fs.collection("crmUsers").docs["crm-only"] = {"role": "agency", "roles": ["agency"], "isActive": True}
eq("push: no users doc → nothing written", crm_dir.push_app_role_flags("crm-only"), "")
ok("…and no users doc created", "crm-only" not in fs.collection("users").docs)

# Two simultaneous agency applications from one human → exactly one.
user("h-race")
async def _race():
    return await asyncio.gather(
        apps.submit_partner_application("h-race", "agency", AGENCY_FORM, None, SERVICE),
        apps.submit_partner_application("h-race", "agency", AGENCY_FORM, None, SERVICE),
        return_exceptions=True,
    )
r1, r2 = run(_race())
wins = [r for r in (r1, r2) if isinstance(r, dict)]
eq("concurrent duplicate applications resolve to exactly one record", len(wins), 1)
ok("…and the other is a refusal, not a crash", any(isinstance(r, PartnerOpsError) for r in (r1, r2)))
eq("…and exactly one agency record exists for that human",
   len([p for p in db["partners"].docs.values() if p.get("owner_crm_uid") == "h-race"]), 1)
eq("…and the loser's Firestore document was removed again",
   len([d for d in fs.collection("agencies").docs.values() if d.get("ownerUid") == "h-race"]), 1)

# ══════════════════════════════════════════════════════════════════════════════
print("5. Host — under an agency, under a sub-agency, approved unverified")

parents = run(apps.eligible_parents("host"))
ok("host parents include main agencies", any(p["id"] == A and p["kind"] == "agency" for p in parents))
ok("…and approved sub-agencies", any(p["id"] == B and p["kind"] == "sub_agency" for p in parents))
ok("…but not pending ones", all(p["id"] != Cc for p in parents))
sub_parents = run(apps.eligible_parents("sub_agency"))
ok("sub-agency parents are MAIN agencies only", all(p["kind"] == "agency" for p in sub_parents))

HOST_FORM = {"hostName": "Hema", "age": "24", "country": "IN", "callRate": "30",
             "photoUrl": ["https://x/face.jpg"], "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
             "accountNumber": "1", "ifscCode": "A", "bankName": "B"}
h1 = run(apps.submit_host_application("h-host1", HOST_FORM, A, SERVICE))
app1 = fs.collection("hostApplications").docs[h1["id"]]
eq("host application pending", app1["status"], "pending")
eq("applicantUid set by the server", app1["applicantUid"], "h-host1")
eq("agencyId is the chosen MAIN agency", app1["agencyId"], A)
ok("referral code minted by the server", len(app1["referralCode"]) == 8)
ok("identity prefilled from the account", app1["applicantEmail"] == "h-host1@x.test")
eq("the applicant is told", notice_types("h-host1"), ["host_submitted"])
eq("B32: a pending self-filed Host application holds the per-person lock",
   db[apps.HOST_APPLICATION_LOCKS].docs.get("h-host1", {}).get("application_id"), h1["id"])
eq("L3: the applicant's email is the VERIFIED sign-in's", app1["applicantEmail"], "h-host1@x.test")
# Decision 15 (RC): these fixtures now sign in with a verified phone too, so
# the application carries it — still taken from the sign-in, never the form.
eq("L3: …and the phone is the VERIFIED sign-in's too", app1["applicantPhone"],
   _rc_harness.verified_auth("h-host1").phone_number)
m = refuses("a second host application while one is pending", apps.submit_host_application("h-host1", HOST_FORM, A, SERVICE))
m = refuses("host under a pending sub-agency refused", apps.submit_host_application("h-host2", HOST_FORM, Cc, SERVICE))
m = refuses("host under own agency refused", apps.submit_host_application("h-a", HOST_FORM, A, SERVICE))
m = refuses("an Agency cannot apply as Host", apps.submit_host_application("h-x", HOST_FORM, B, SERVICE))

h2 = run(apps.submit_host_application("h-host2", HOST_FORM, B, SERVICE))
eq("host under a SUB-agency: agencyId is the sub-agency itself",
   fs.collection("hostApplications").docs[h2["id"]]["agencyId"], B)

users_svc.audit.record = fake_audit
# `ensure_ordinary_target` reads Mongo staff — none here, so hosts are ordinary.
dec = run(users_svc.decide_host_application(h1["id"], True, WHY, STAFF))
eq("approval grants the role to the applicant directly", fs.collection("users").docs["h-host1"]["isHost"], True)
ok("…UNVERIFIED", not fs.collection("users").docs["h-host1"].get("isVerifiedHost"))
ok("…with a verification record opened", "h-host1" in fs.collection("hostVerification").docs)
eq("…and the applicant told, with the next step", notice_types("h-host1"), ["host_approved", "host_submitted"])
ok("the approval notice names facial verification",
   "facial verification" in next(d["body"] for d in notices_for("h-host1") if d["type"] == "host_approved"))
el = run(apps.eligibility("h-host1"))
eq("host under main may add Sub-agency and Seller", el["options"], ["sub_agency", "seller"])
app1d = fs.collection("hostApplications").docs[h1["id"]]
eq("C5/B08: approving a known applicant activates the application — one person, one row",
   (app1d.get("isActivated"), app1d.get("activatedByUid")), (True, "h-host1"))
ok("C5: …stamped with the moment", app1d.get("activatedAt") is not None)
ok("B17: …and the decision lease is gone once the decision is stamped", "decisionInFlight" not in app1d)
ok("B32: …and the one-pending-application lock went with the decision",
   "h-host1" not in db[apps.HOST_APPLICATION_LOCKS].docs)
# B22: a half-finished approval — the Host granted, the stamp lost — can be
# decided again, and only the decision is recorded.
app1d.update({"status": "pending", "kycStatus": "submitted", "isActivated": False})
for _k in ("activatedByUid", "activatedAt"):
    app1d.pop(_k, None)
dec_again = run(users_svc.decide_host_application(h1["id"], True, WHY, STAFF))
eq("B22: re-approving for a Host of the SAME agency only stamps the decision",
   (dec_again["account"], app1d["status"]), (None, "approved"))
ok("B22: …and says so", "already a Host of this agency" in dec_again["note"])
eq("C5: …activating the application as it does", (app1d.get("isActivated"), app1d.get("activatedByUid")),
   (True, "h-host1"))
eq("B22: …and grants nothing twice", fs.collection("users").docs["h-host1"]["agencyId"], A)

run(users_svc.decide_host_application(h2["id"], False, "Blurry documents.", STAFF))
eq("rejection tells the applicant with the reason", notice_types("h-host2"), ["host_rejected", "host_submitted"])
ok("…reason carried", "Blurry" in next(d["body"] for d in notices_for("h-host2") if d["type"] == "host_rejected"))
ok("a rejected host applicant may apply again", "host" in run(apps.eligibility("h-host2"))["options"])

# ══════════════════════════════════════════════════════════════════════════════
print("6. Revocation — the role goes, the human stays")

# Ruhan-shape: Agency + Seller. Revoke the agency.
sentinel_before = "agency:h-ruhan" in db[roles.PARTNER_ROLE_CLAIMS].docs
ok("the agency-family sentinel is held before revocation", bool(sentinel_before))
rev = run(ops.revoke_partner(RA, "Repeated policy breaches.", STAFF))
eq("agency → revoked", partner(RA)["status"], "revoked")
eq("…inactive", partner(RA)["is_active"], False)
eq("the Seller is untouched", partner(RS)["status"], "approved")
eq("…and still active", partner(RS)["is_active"], True)
ok("the record still exists (history)", RA in db["partners"].docs)
ok("revocation reason kept", partner(RA)["revocation_reason"] == "Repeated policy breaches.")
ok("C1/B04: the sentinel is KEPT — a revoked role still holds its place",
   "agency:h-ruhan" in db[roles.PARTNER_ROLE_CLAIMS].docs)
ok("C1/B04: …and the response says nothing was released", rev.get("role_family_released") is False)
el_r = run(apps.eligibility("h-ruhan"))
eq("C1: revoked Agency + Seller → Agency is NOT offered again (nothing further)", el_r["options"], [])
eq("C1: …the Agency choice says request reinstatement",
   el_r["blocked"].get("agency"), apps.REVOKED_REFUSAL.format(role="Agency"))
eq("C1: …the revoked role is listed at the top level, with no request yet",
   [(r["kind"], r["record_id"], r["reason"], r["appeal"]) for r in el_r["revoked"]],
   [("agency", RA, "Repeated policy breaches.", None)])
ok("C1: …and held.partners carries it with when and why",
   any(p["id"] == RA and p["status"] == "revoked" and p["revoked_at"]
       and p["revoked_reason"] == "Repeated policy breaches." for p in el_r["held"]["partners"]))
ok("C1: …while the Seller is kept", partner(RS)["status"] == "approved")
eq("the person is told, with the reason", notice_types("h-ruhan").count("partner_revoked"), 1)
ok("…and pointed at reinstatement, not at re-applying",
   "reinstatement" in next(d["body"] for d in notices_for("h-ruhan") if d["type"] == "partner_revoked"))
ok("the login stays active for the Seller",
   fs.collection("crmUsers").docs["h-ruhan"]["isActive"] is True)
eq("roleStatus.agency = revoked on the login", fs.collection("crmUsers").docs["h-ruhan"]["roleStatus"]["agency"], "revoked")
eq("…roleStatus.seller still approved", fs.collection("crmUsers").docs["h-ruhan"]["roleStatus"]["seller"], "approved")
eq("…and the LOGIN's status is not downgraded (no waiting room for the seller)",
   fs.collection("crmUsers").docs["h-ruhan"]["status"], "approved")
# The Storage/agency claim is derived from this document by the Functions'
# `partnerClaimFrom` — asserted in functions/test/storageClaims.test.js: with
# roleStatus.agency = revoked it emits the seller claim with no agency scope.
ru = fs.collection("users").docs["h-ruhan"]
eq("app: after agency revocation the Agency tag goes immediately", ru.get("isAgent"), False)
eq("app: …and the Seller tag stays", ru.get("isSeller"), True)
ok("sessions revoked", "sessions_revoked" in rev)
ok("audited as partner.revoked", any(e["action"] == "partner.revoked" and e["subject_id"] == RA for e in audit_entries))
ok("the user account was NOT suspended or banned",
   not fs.collection("users").docs["h-ruhan"].get("isSuspended") and not fs.collection("users").docs["h-ruhan"].get("isBanned"))

records_before = len(db["partners"].docs)
m = refuses("C1: re-applying for the revoked Agency is refused through the application API",
            apps.submit_partner_application("h-ruhan", "agency", AGENCY_FORM, None, SERVICE))
eq("C1: …with the reinstatement sentence", m, apps.REVOKED_REFUSAL.format(role="Agency"))
eq("C1: …and no new record was created", len(db["partners"].docs), records_before)
m = refuses("C1: a revoked Agency still blocks Sub-agency",
            apps.submit_partner_application("h-ruhan", "sub_agency", AGENCY_FORM, X, SERVICE))
m = refuses("C1: a revoked Agency still blocks Host",
            apps.submit_host_application("h-ruhan", HOST_FORM, A, SERVICE))
# The CRM creation path (register screen / registration trigger) is held to the
# same rule: a second agency document naming the revoked owner gets no record.
fs.collection("agencies").docs["crm-ruhan-2"] = {"agencyName": "Ruhan Two", "crmUid": "h-ruhan",
                                                 "type": "main", "crmId": "RUHAN002"}
m = refuses("C1: CRM creation of a new Agency for the revoked owner is refused",
            ops.create_partner("crm-ruhan-2", "Registered by staff.", STAFF))
ok("C1: …with the reinstatement sentence", apps.REVOKED_REFUSAL.format(role="Agency") in m, m)
ok("C1: …and no Mongo record exists for it", "crm-ruhan-2" not in db["partners"].docs)
# B04 at the lock itself: a Sub-agency (same family) created from the CRM for
# the revoked Agency's owner cannot take the place the revoked record holds.
# The claim is aged past its settle window, as any real one is, so the
# hand-over rule — not the freshness guard — is what is being asked.
from datetime import datetime as _dt, timezone as _tz  # noqa: E402

db[roles.PARTNER_ROLE_CLAIMS].docs["agency:h-ruhan"]["claimed_at"] = _dt(2026, 1, 1, tzinfo=_tz.utc)
fs.collection("agencies").docs["crm-ruhan-sub"] = {"agencyName": "Ruhan Sub", "crmUid": "h-ruhan", "type": "sub",
                                                   "parentAgencyId": X, "crmId": "RUHANSUB"}
m = refuses("B04: CRM creation of a Sub-agency for the revoked Agency's owner is refused",
            ops.create_partner("crm-ruhan-sub", "Registered by staff.", STAFF))
eq("B04: …the family claim still names the revoked record",
   db[roles.PARTNER_ROLE_CLAIMS].docs["agency:h-ruhan"]["partner_id"], RA)
ok("B04: …and no record was created", "crm-ruhan-sub" not in db["partners"].docs)
m = refuses("revoking twice is refused", ops.revoke_partner(RA, WHY, STAFF))
run(ops.reject_partner(PZ, "Incomplete.", STAFF))
m = refuses("revoking a rejected application is refused", ops.revoke_partner(PZ, WHY, STAFF))
eq("rejection notifies with the reason", notice_types("h-z"), ["partner_rejected", "partner_submitted"])
ok("a rejected applicant may re-apply", "agency" in run(apps.eligibility("h-z"))["options"])

# Suspension keeps the slot; reactivation restores; a suspended role is told.
run(ops.deactivate_partner(X, "Temporary hold.", STAFF))
eq("deactivate → suspended", partner(X)["status"], "suspended")
eq("suspended is still held (no re-apply)", run(apps.eligibility("h-x"))["options"], ["seller"])
ok("the person is told about the suspension", "partner_suspended" in notice_types("h-x"))
eq("app: suspended agency loses the tag", fs.collection("users").docs["h-x"].get("isAgent"), False)
run(ops.reactivate_partner(X, "Hold lifted.", STAFF))
eq("app: reactivated agency regains the tag", fs.collection("users").docs["h-x"].get("isAgent"), True)
eq("reactivate → approved", partner(X)["status"], "approved")
ok("…and told", "partner_reactivated" in notice_types("h-x"))

# UGP-B: ONE active role → suspend the account, never a separate revoke. With
# the Agency revoked and the new one still pending, the Seller is the only role
# Ruhan holds, so revoking it on its own is refused and nothing changes.
m = refuses("UGP-B revoking a person's ONLY active role is refused", ops.revoke_partner(RS, "Closed shop.", STAFF))
ok("…saying to suspend instead", "only active role" in m and "suspend" in m.lower(), m)
eq("…and the Seller is untouched", partner(RS)["status"], "approved")

# C2: the revoked Agency comes back only by the Owner's decision, as the SAME
# record — directly, or through Approve, which delegates to the restore.
def _forbidden(coro) -> bool:
    try:
        run(coro)
    except ops.PartnerOpsForbidden:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


ok("C2: a non-Owner cannot restore the revoked Agency (403)",
   _forbidden(ops.reactivate_partner(RA, "Reinstated after review.", STAFF)))
ok("C2: …nor through Approve on the revoked record",
   _forbidden(ops.approve_partner(RA, "Reinstated after review.", STAFF)))
eq("C2: …and it is still revoked", partner(RA)["status"], "revoked")
restored = run(ops.reactivate_partner(RA, "Reinstated after review.", OWNER))
eq("C2: the Owner restores the SAME record", restored["id"], RA)
eq("C2: …approved again", partner(RA)["status"], "approved")
eq("C2: …and there is still exactly one agency record for this human",
   len([p for p in db["partners"].docs.values() if p.get("owner_crm_uid") == "h-ruhan" and p["kind"] == "agency"]), 1)
eq("C2: …holding the same claim", db[roles.PARTNER_ROLE_CLAIMS].docs["agency:h-ruhan"]["partner_id"], RA)
ok("B39: restoring revokes the sessions so the role reappears", "sessions_revoked" in restored)

# Revoking a Seller leaves the Agency — once there are two roles to choose from.
rev_s = run(ops.revoke_partner(RS, "Closed shop.", STAFF))
eq("seller → revoked", partner(RS)["status"], "revoked")
eq("the restored agency untouched", partner(RA)["status"], "approved")
ok("C1: the seller sentinel is KEPT", "seller:h-ruhan" in db[roles.PARTNER_ROLE_CLAIMS].docs)

# ══════════════════════════════════════════════════════════════════════════════
print("7. Dependents — nobody is orphaned")

# UGP-B: revoking needs a SECOND role (one role → suspend), so A's owner also
# holds an approved Coin Seller role. What is under test here is dependents.
approve(apply("h-a", "seller")["id"])
# A has approved sub-agency B (with hosts? add a host roster row) and pending C, D.
fs.collection("agencies").document(A).collection("agencyHosts").docs["h-host1"] = {
    "uid": "h-host1", "name": "Hema", "agencyId": A}
# C3: a revocation that MOVES dependents is a transfer, and transfers are the
# Owner's. Anyone else is refused before anything is written.
n_deps = len([p for p in db["partners"].docs.values()
              if p.get("kind") == "sub_agency" and p.get("parent_id") == A
              and p.get("status") not in ("revoked", "rejected")]) + 1  # + host h-host1
try:
    run(ops.revoke_partner(A, "Closing.", STAFF, transfer_to=X))
    c3_refusal = None
except PartnerOpsError as exc:
    c3_refusal = exc
ok("C3: a non-Owner revoking an agency WITH dependents is refused (403)",
   isinstance(c3_refusal, ops.PartnerOpsForbidden))
eq("C3: …with the Owner-transfer sentence", str(c3_refusal),
   ops.OWNER_ONLY_TRANSFER.format(n=n_deps))
eq("C3: …and nothing changed", (partner(A)["status"], partner(B)["parent_id"]), ("approved", A))
m = refuses("revoking an agency with dependents and no replacement is refused",
            ops.revoke_partner(A, "Closing.", OWNER))
ok("…listing what is attached", "sub-agenc" in m and "host" in m)
eq("…and nothing changed", partner(A)["status"], "approved")
m = refuses("a replacement that is a sub-agency is refused", ops.revoke_partner(A, "Closing.", OWNER, transfer_to=B))
m = refuses("a nonexistent replacement is refused", ops.revoke_partner(A, "Closing.", OWNER, transfer_to="nope"))

moved = run(ops.revoke_partner(A, "Closing.", OWNER, transfer_to=X))
eq("A → revoked", partner(A)["status"], "revoked")
eq("sub-agency B now hangs under X", partner(B)["parent_id"], X)
eq("…and C and D too", (partner(Cc)["parent_id"], partner(D)["parent_id"]), (X, X))
ok("B's parent history records the move", partner(B)["parent_history"][0]["from"] == A)
eq("the host's current agency is X", fs.collection("users").docs["h-host1"]["agencyId"], X)
ok("…and the roster row moved",
   "h-host1" in fs.collection("agencies").document(X).collection("agencyHosts").docs
   and "h-host1" not in fs.collection("agencies").document(A).collection("agencyHosts").docs)
ok("the host was told", "partner_transferred" in notice_types("h-host1"))
ok("sub-agency B's owner was told", "partner_transferred" in notice_types("h-b"))
ok("the transfer is audited with the full list",
   any(e["action"] == "partner.dependents_transferred" and e["after"]["to"] == X for e in audit_entries))
eq("moved summary: every one of A's 28 sub-agencies moved, none left behind",
   sorted(moved["dependents_moved"]["sub_agencies"]), sorted(p["_id"] for p in many))
eq("…and none still names A as parent",
   [p["_id"] for p in db["partners"].docs.values() if p.get("kind") == "sub_agency" and p.get("parent_id") == A], [])

# A sub-agency's hosts go up to its parent by default.
fs.collection("agencies").document(B).collection("agencyHosts").docs["h-host2"] = {"uid": "h-host2", "agencyId": B}
fs.collection("users").docs["h-host2"]["agencyId"] = B
approve(BS)  # UGP-B: B's owner holds two roles, so B alone may be revoked
ok("C3: moving a sub-agency's hosts up is a transfer too — a non-Owner is refused",
   _forbidden(ops.revoke_partner(B, "Done.", STAFF)))
run(ops.revoke_partner(B, "Done.", OWNER))
eq("B → revoked", partner(B)["status"], "revoked")
eq("B's host went up to B's parent (X)", fs.collection("users").docs["h-host2"]["agencyId"], X)
eq("the parent X is untouched", partner(X)["status"], "approved")
eq("B's owner's Seller is untouched", partner(BS)["status"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("8. Notifications — one message per event, idempotent")

before = len(notices_for("h-x"))
# Retry the exact same approval notice.
run(notices.partner_approved("h-x", "agency", X))
run(notices.partner_approved("h-x", "agency", X))
eq("re-delivering the same event does not add messages", len(notices_for("h-x")), before)
for d in fs.collection("notifications").docs.values():
    if not d.get("userId"):
        failures.append(f"a notice with no userId: {d}"); checks += 1; break
else:
    ok("every notice is addressed on userId", True)
ok("no notice names the staff actor",
   all("staff-1" not in str(d) and "Ops Admin" not in str(d) for d in fs.collection("notifications").docs.values()))
# Host revocation, for real: the role goes, the account and history stay.
hs = apply("h-host1", "seller"); approve(hs["id"])
agency_before = fs.collection("users").docs["h-host1"].get("agencyId")
run(users_svc.revoke_host("h-host1", "Repeated no-shows.", STAFF))
hu = fs.collection("users").docs["h-host1"]
eq("host revoke: isHost false", hu.get("isHost"), False)
ok("…account not banned or suspended", not hu.get("isBanned") and not hu.get("isSuspended"))
eq("…agency link kept for earnings history", hu.get("agencyId"), agency_before)
eq("…their Coin Seller role untouched", partner(hs["id"])["status"], "approved")
ok("…told, with the reason", any(d["type"] == "host_revoked" and "no-shows" in d["body"] for d in notices_for("h-host1")))
el_h = run(apps.eligibility("h-host1"))
ok("C1: …and is NOT offered Host again", "host" not in el_h["options"])
eq("C1: …Host says request reinstatement", el_h["blocked"].get("host"), apps.REVOKED_REFUSAL.format(role="Host"))
eq("C1: held.host is the revoked Host, with when",
   (el_h["held"]["host"]["status"], bool(el_h["held"]["host"]["revoked_at"])), ("revoked", True))
eq("C1: revoked lists it — the uid is the record, with the reason",
   [(r["kind"], r["record_id"], r["reason"]) for r in el_h["revoked"]], [("host", "h-host1", "Repeated no-shows.")])
m = refuses("C1: a fresh Host application from the revoked Host is refused",
            apps.submit_host_application("h-host1", HOST_FORM, X, SERVICE))
eq("C1: …with the reinstatement sentence", m, apps.REVOKED_REFUSAL.format(role="Host"))
host_row = next(r for r in run(apps.applications_of("h-host1")) if r["kind"] == "host")
eq("B34: the revoked Host's application shows the role revoked, with the reason",
   (host_row["status"], host_row["revocation_reason"]), ("revoked", "Repeated no-shows."))
eq("B34: …while the application itself still says approved (restore uses it)",
   fs.collection("hostApplications").docs[h1["id"]]["status"], "approved")

# ══════════════════════════════════════════════════════════════════════════════
print("9. Delivery failure never rolls back a decision")

user("h-nodeliver")
nd = apply("h-nodeliver", "agency")
approve(apply("h-nodeliver", "seller")["id"])  # UGP-B: a second role, so revoking is allowed
fs.collection("notifications").fail_on("set")
try:
    out = approve(nd["id"])
    eq("approval stands when the notice cannot be written", partner(nd["id"])["status"], "approved")
    eq("…and the response says it was not delivered", out.get("notified"), False)
    rv = run(ops.revoke_partner(nd["id"], "Closing.", STAFF))
    eq("revocation stands when the notice cannot be written", partner(nd["id"])["status"], "revoked")
    eq("…notified False", rv.get("notified"), False)
finally:
    fs.collection("notifications").clear_failures()

# ══════════════════════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════════════════════
print("10. Internal staff can never hold a partner role")

STAFF_CASES = {
    "st-owner": ("owner", "superadmin"),
    "st-observer": ("observer", None),
    "st-dept-admin": ("ops_admin", "ops_admin"),
    "st-dept-member": ("finance_member", "finance_member"),
}
for uid, (mongo_role, crm_role) in STAFF_CASES.items():
    user(uid)
    db["staff"].docs[uid] = {"_id": uid, "uid": uid, "role": mongo_role, "email": f"{uid}@zipper.test"}
    if crm_role:
        fs.collection("crmUsers").docs[uid] = {"role": crm_role, "isActive": True}
    e = run(apps.eligibility(uid))
    eq(f"{mongo_role}: no partner options", e["options"], [])
    ok(f"{mongo_role}: every kind carries the staff reason",
       set(e["blocked"]) == set(apps.KINDS) and all("staff" in v for v in e["blocked"].values()))
    for kind in ("agency", "sub_agency", "seller"):
        before = len(db["partners"].docs)
        m = refuses(f"{mongo_role} cannot submit {kind}",
                    apps.submit_partner_application(uid, kind, SELLER_FORM if kind == "seller" else AGENCY_FORM,
                                                    A if kind == "sub_agency" else None, SERVICE))
        ok(f"{mongo_role}: {kind} refusal names staff", "staff" in m.lower())
        eq(f"{mongo_role}: nothing written for {kind}", len(db["partners"].docs), before)
    m = refuses(f"{mongo_role} cannot submit host", apps.submit_host_application(uid, HOST_FORM, A, SERVICE))
    ok(f"{mongo_role}: host refusal names staff", "staff" in m.lower())

# A staff identity known only to crmUsers (no Mongo row yet) is still internal.
user("st-crm-only")
fs.collection("crmUsers").docs["st-crm-only"] = {"role": "support_member", "isActive": True}
eq("crmUsers-only department member: no options", run(apps.eligibility("st-crm-only"))["options"], [])

# The app's display badge is NOT staff identity.
user("u-badge", isOfficial=True, crmRole="")
eq("an isOfficial badge alone does not block a normal user",
   run(apps.eligibility("u-badge"))["options"], ["host", "agency", "sub_agency", "seller"])
# A partner login (crmUsers role agency/seller) is not internal.
eq("a partner crmUsers role is not internal", run(apps.internal_identity("h-ruhan")), "")
eq("pure table: internal short-circuits", apps.eligible_kinds({"internal": "owner", "partners": [], "host": None,
   "pending_host_application": None})["options"], [])

# ══════════════════════════════════════════════════════════════════════════════
print("11. B3/B5 — approval and reactivation re-check the rules")

def try_(coro) -> str:
    """'' if it succeeded, else the refusal message."""
    try:
        run(coro)
        return ""
    except PartnerOpsError as exc:
        return str(exc) or "refused"

def revoke(pid):
    run(ops.revoke_partner(pid, "Policy breach confirmed.", STAFF))

# B3.1 / B3.3 / B3.7 — revoke Agency: a NEW agency application is refused (C1).
# A legacy second record that reached Mongo before revoked held its place can
# not be approved either, and the old one cannot be restored while it lives.
user("b3-a")
OLD = apply("b3-a", "agency")["id"]; approve(OLD)
approve(apply("b3-a", "seller")["id"])  # UGP-B: two roles, so one may be revoked
revoke(OLD)
m = refuses("B3.3 a new Agency application after revocation is refused (C1)",
            apps.submit_partner_application("b3-a", "agency", AGENCY_FORM, None, SERVICE))
eq("B3.3 …with the reinstatement sentence", m, apps.REVOKED_REFUSAL.format(role="Agency"))
db["partners"].docs["b3-a-legacy"] = {**partner(OLD), "_id": "b3-a-legacy", "crm_id": "LEGACYA",
                                      "status": "pending", "is_active": False}
m = try_(ops.approve_partner("b3-a-legacy", WHY, STAFF))
ok("B3.3b approving a legacy NEW agency beside the revoked one is refused at approval (C1)",
   apps.REVOKED_REFUSAL.format(role="Agency") in m, m)
eq("B3.3b …and it stays pending", partner("b3-a-legacy")["status"], "pending")
ok("B3.1 a non-Owner cannot restore the OLD revoked agency, directly or through Approve (C2)",
   _forbidden(ops.approve_partner(OLD, WHY, STAFF)) and _forbidden(ops.reactivate_partner(OLD, WHY, STAFF)))
m = try_(ops.reactivate_partner(OLD, WHY, OWNER))
ok("B3.2 even the Owner cannot restore it while another agency record lives", "agency" in m.lower(), m)
live = [p for p in db["partners"].docs.values()
        if p.get("owner_crm_uid") == "b3-a" and p["kind"] in ("agency", "sub_agency")
        and p["status"] in ("pending", "approved", "suspended")]
eq("B3.7 exactly one live agency-family record for the uid", len(live), 1)

# Revoke-then-reinstate: the slot is KEPT by the revocation, the Owner's restore
# re-affirms it on the same record, and a later second agency is refused.
user("b3-b")
R1 = apply("b3-b", "agency")["id"]; approve(R1)
approve(apply("b3-b", "seller")["id"])  # UGP-B: two roles, so one may be revoked
revoke(R1)
eq("C1: the slot is KEPT by revocation, on the revoked record",
   db[roles.PARTNER_ROLE_CLAIMS].docs.get("agency:b3-b", {}).get("partner_id"), R1)
eq("C2: the Owner reinstating the revoked agency (nothing else live) is allowed",
   try_(ops.reactivate_partner(R1, WHY, OWNER)), "")
eq("…the same record, approved", partner(R1)["status"], "approved")
eq("…still holding the slot", db[roles.PARTNER_ROLE_CLAIMS].docs["agency:b3-b"]["partner_id"], R1)
m = refuses("…so a fresh agency application is now refused", apps.submit_partner_application("b3-b", "agency", AGENCY_FORM, None, SERVICE))
# Legacy: a revocation made before this rule released the slot. Reinstating it
# takes the slot back for the same record.
revoke(R1)
del db[roles.PARTNER_ROLE_CLAIMS].docs["agency:b3-b"]
eq("legacy: reinstating a revoked agency whose slot was released is allowed",
   try_(ops.reactivate_partner(R1, WHY, OWNER)), "")
eq("legacy: …and it takes the slot back", db[roles.PARTNER_ROLE_CLAIMS].docs["agency:b3-b"]["partner_id"], R1)

# B3.4 / B3.5 — Agency + Seller, revoke Agency, Seller stays; re-apply Agency works
user("b3-c")
CA = apply("b3-c", "agency")["id"]; approve(CA)
CS = apply("b3-c", "seller")["id"]; approve(CS)
revoke(CA)
eq("B3.4 the Seller stays approved", partner(CS)["status"], "approved")
m = refuses("B3.5 re-applying for Agency (with the Seller held) is refused — reinstatement is the way back",
            apps.submit_partner_application("b3-c", "agency", AGENCY_FORM, None, SERVICE))
eq("B3.5 …the Owner's restore reuses the SAME record", run(ops.reactivate_partner(CA, WHY, OWNER))["id"], CA)
eq("B3.5 …and the Seller is still approved beside it", partner(CS)["status"], "approved")

# B3.6 — concurrent approvals of two agency-family records for one uid
user("b3-d")
D1 = apply("b3-d", "agency")["id"]
run(ops.reject_partner(D1, "Incomplete documents.", STAFF))
# A second, also-rejected record for the same human. Both are releasable, so
# only the lock decides which approval wins.
db["partners"].docs["b3-d-legacy"] = {**partner(D1), "_id": "b3-d-legacy", "crm_id": "LEGACY1"}
async def _race_approve():
    return await asyncio.gather(ops.approve_partner(D1, WHY, STAFF),
                                ops.approve_partner("b3-d-legacy", WHY, STAFF), return_exceptions=True)
res = run(_race_approve())
eq("B3.6 concurrent approvals → exactly one agency approved",
   sum(1 for p in (partner(D1), partner("b3-d-legacy")) if p["status"] == "approved"), 1)

# B3.6b — the SAME race, with the interleaving FORCED rather than left to the
# scheduler. B3.6 above passed or failed depending on thread timing (it failed
# 2 runs in 11 during Phase 1A validation); this pins the exact order that
# broke it, so the result no longer depends on luck:
#
#   1. the legacy approval reads the claim (held by R1 via an old `create`
#      claim, so "not fresh") and checks R1 is releasable (R1 is rejected);
#   2. only THEN does R1's approval take the claim (re-affirm) and approve R1;
#   3. the legacy approval resumes and tries to hand the claim over.
#
# Before the fix, step 3's compare-and-set matched on `partner_id` alone and
# succeeded, so BOTH records ended up approved for one human.
user("b3-r")
R1 = apply("b3-r", "agency")["id"]
_pre_reject_claim = dict(db[roles.PARTNER_ROLE_CLAIMS].docs.get("agency:b3-r") or {})
run(ops.reject_partner(R1, "Incomplete documents.", STAFF))
# Decision 16 (RC): a rejection now releases its claim at once. Claims taken
# BEFORE that change still name rejected records in production, and that stale
# claim is exactly the state this race needs — so it is put back as it was,
# an old `create` claim naming the rejected R1.
if _pre_reject_claim:
    db[roles.PARTNER_ROLE_CLAIMS].docs["agency:b3-r"] = _pre_reject_claim
db["partners"].docs["b3-r-legacy"] = {**partner(R1), "_id": "b3-r-legacy", "crm_id": "LEGACY2"}
_r1_done, _legacy_read = asyncio.Event(), asyncio.Event()
_real_releasable, _real_claim = roles._is_releasable, roles.claim_role_family

async def _releasable_then_wait(pid):
    verdict = await _real_releasable(pid)   # read while R1 is still rejected
    _legacy_read.set()
    await _r1_done.wait()                   # R1 re-affirms the claim and is approved
    return verdict                          # …and the legacy approval acts on the stale read

async def _claim_after_legacy_read(owner_uid, kind, partner_id, **kw):
    if partner_id == R1:
        await _legacy_read.wait()
    return await _real_claim(owner_uid, kind, partner_id, **kw)

async def _approve_r1():
    try:
        await ops.approve_partner(R1, WHY, STAFF)
    except PartnerOpsError:
        pass
    finally:
        _r1_done.set()

async def _approve_legacy():
    try:
        await ops.approve_partner("b3-r-legacy", WHY, STAFF)
    except PartnerOpsError:
        pass

roles._is_releasable, roles.claim_role_family = _releasable_then_wait, _claim_after_legacy_read
try:
    async def _forced():
        await asyncio.gather(_approve_r1(), _approve_legacy())
    run(_forced())
finally:
    roles._is_releasable, roles.claim_role_family = _real_releasable, _real_claim
eq("B3.6b forced interleaving → still exactly one agency approved",
   sum(1 for p in (partner(R1), partner("b3-r-legacy")) if p["status"] == "approved"), 1)
eq("B3.6b …and it is the record whose approval re-affirmed the claim first",
   partner(R1)["status"], "approved")

# B5 — Host combinations, at application AND at approval
def make_host(uid, under):
    user(uid, isHost=True, agencyId=under)

user("b5-main-owner"); MAIN = apply("b5-main-owner", "agency")["id"]; approve(MAIN)
user("b5-sub-owner"); SUBP = apply("b5-sub-owner", "sub_agency", parent=MAIN)["id"]; approve(SUBP)

make_host("b5-h-main", MAIN)
make_host("b5-h-sub", SUBP)
make_host("b5-h-none", "")
E = lambda u: run(apps.eligibility(u))["options"]
eq("Host under Agency → Sub-agency + Seller", E("b5-h-main"), ["sub_agency", "seller"])
eq("Host under Sub-agency → Seller only", E("b5-h-sub"), ["seller"])
ok("Host (no agency link) → no Agency", "agency" not in E("b5-h-none"))
refuses("Host under Agency → Agency rejected", apps.submit_partner_application("b5-h-main", "agency", AGENCY_FORM, None, SERVICE))
refuses("Host under Sub-agency → Agency rejected", apps.submit_partner_application("b5-h-sub", "agency", AGENCY_FORM, None, SERVICE))
refuses("Host under Sub-agency → Sub-agency rejected", apps.submit_partner_application("b5-h-sub", "sub_agency", AGENCY_FORM, MAIN, SERVICE))
eq("Host → Seller allowed", apply("b5-h-sub", "seller")["status"], "pending")
user("b5-seller"); approve(apply("b5-seller", "seller")["id"])
eq("Seller → Host, Agency, Sub-agency", E("b5-seller"), ["host", "agency", "sub_agency"])
eq("Agency → Seller only", E("b5-main-owner"), ["seller"])
# RC (confirmed role rule): the Sub-agency's owner may also be a Host — under
# the Sub-agency's own main agency only.
eq("RC: Sub-agency → Host (under its own main agency) or Seller", E("b5-sub-owner"), ["host", "seller"])

# The original B5 hole: file a Host application, then an Agency application.
user("b5-pend")
run(apps.submit_host_application("b5-pend", HOST_FORM, MAIN, SERVICE))
eq("a pending Host application blocks Agency", "agency" in E("b5-pend"), False)
refuses("…and an Agency submission is refused", apps.submit_partner_application("b5-pend", "agency", AGENCY_FORM, None, SERVICE))

# Approval re-checks even when the application predates the conflict:
user("b5-late")
LATE = apply("b5-late", "agency")["id"]                 # filed while an ordinary user
fs.collection("users").docs["b5-late"].update({"isHost": True, "agencyId": MAIN})  # became a Host since
m = try_(ops.approve_partner(LATE, WHY, STAFF))
ok("approval re-checks the table: Host + Agency refused at approval", m != "", m)
eq("…and the agency stays pending", partner(LATE)["status"], "pending")

# Host approval re-checks too: an Agency owner cannot be granted Host.
from app.services import users as users_svc_mod  # noqa: E402
try:
    run(users_svc_mod.grant_host("b5-main-owner", MAIN, "Approved after review.", STAFF))
    granted = True
except users_svc_mod.UserError:
    granted = False
eq("granting Host to an Agency owner is refused at the grant", granted, False)
ok("…nothing was written", not fs.collection("users").docs["b5-main-owner"].get("isHost"))

# ══════════════════════════════════════════════════════════════════════════════
print("12. B4 — a Host who becomes a Sub-agency keeps the agency they work under")

user("b4-host", isHost=True, agencyId=MAIN, isVerifiedHost=True, hostGiftEarnings=500)
fs.collection("agencies").document(MAIN).collection("agencyHosts").docs["b4-host"] = {"uid": "b4-host", "joinedAt": "t0"}
eq("Host under Agency may add Sub-agency", "sub_agency" in run(apps.eligibility("b4-host"))["options"], True)
B4S = apply("b4-host", "sub_agency", parent=MAIN)["id"]
approve(B4S)
hu = fs.collection("users").docs["b4-host"]
eq("1-3. the Host's parent agency is untouched", hu.get("agencyId"), MAIN)
eq("…and the own Sub-agency is recorded separately", hu.get("ownAgencyId"), B4S)
eq("…the Sub-agency's own parent is the main agency", partner(B4S)["parent_id"], MAIN)
eq("…both tags", (hu.get("isHost"), hu.get("isAgent")), (True, True))
B4SELL = apply("b4-host", "seller")["id"]; approve(B4SELL)
run(ops.revoke_partner(B4S, "Sub-agency closed by staff.", STAFF))
hu = fs.collection("users").docs["b4-host"]
eq("4-5. after revoking the Sub-agency the Host still works under the original agency", hu.get("agencyId"), MAIN)
ok("…the own-agency link is gone", "ownAgencyId" not in hu)
eq("…the Agency tag is gone, the Host flag stays", (hu.get("isAgent"), hu.get("isHost")), (False, True))
eq("6. the Seller role remains", (partner(B4SELL)["status"], hu.get("isSeller")), ("approved", True))
eq("7. host earnings and verification untouched", (hu.get("hostGiftEarnings"), hu.get("isVerifiedHost")), (500, True))
ok("…and the agency roster row is untouched",
   "b4-host" in fs.collection("agencies").document(MAIN).collection("agencyHosts").docs)
eq("9. role sync (the same derivation as cold start) agrees", crm_dir.app_role_patch(
   fs.collection("crmUsers").docs["b4-host"], hu), {})

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} partner-lifecycle checks passed.")
print("  · the role table, pure and complete; combinations through the real path")
print("  · unlimited sub-agencies under one agency; sub-sub, pending, revoked,")
print("    nonexistent and own-agency parents refused server-side")
print("  · host under main and under sub; approval grants UNVERIFIED")
print("  · revocation keeps history, spares other roles and the login — and the revoked")
print("    role still counts: no re-application, only an Owner restore of the same record")
print("  · dependents move (Owner only) or the revocation is refused; every event notifies once\n")
