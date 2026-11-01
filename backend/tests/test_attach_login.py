"""Attaching a login to a partner record that has none.

A `partners` record with no `crmUid` and no `owner_crm_uid` is a business nobody
can sign in as. Those records exist — a sub-agency whose secondary-app signup
half-failed, an applicant whose `crmUsers` write the security rules refused,
every partner brought in by `scripts/backfill_partners.py` — and until now there
was no control anywhere that could give one an owner. The only remedy was
editing Firestore by hand.

These tests cover the endpoint that does it, and they are written around one
claim: **it grants a sign-in and nothing else.** The partner's status, its
balances and its approval are the same afterwards as before, and the account it
attaches to an unapproved partner can reach no record at all.

The refusals get as much attention as the success, because each of them is a way
of pointing a credential at the wrong business:

  * a login is already attached, on either side of the link;
  * the address is a staff account;
  * the address already holds a `crmUsers` document naming a different partner;
  * the address's uid already signs in as another partner.

Every one of them must run **before** anything is created. A refusal that leaves
a Firebase account behind is a refusal that has already half-succeeded.

No database and no network: `tests/fakes.py` stubs the I/O, so the code
exercised here is the real `app/services/partner_ops.py` writing through the
real `app/services/crm_directory.py::mirror`.

Run:  python3 -m tests.test_attach_login
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeDb, FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

# Several of these tests fail a Firestore call on purpose, and the real code
# logs the traceback when one fails. That behaviour is asserted below from the
# value it returns, so the traceback is noise here and the two loggers that
# write it are quietened rather than the code being asked not to log.
logging.getLogger("app.services.partner_ops").setLevel(logging.CRITICAL)
logging.getLogger("app.services.crm_directory").setLevel(logging.CRITICAL)

from app.core import audit as audit_mod  # noqa: E402
from app.core.roles import Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles  # noqa: E402

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


def refuses(label: str, factory) -> str:
    """This must be refused with a message, not quietly given a login."""
    global checks
    checks += 1
    try:
        result = asyncio.run(factory())
    except ops.PartnerOpsError as exc:
        return str(exc)
    except Exception as exc:  # noqa: BLE001
        failures.append(
            f"{label}: raised {type(exc).__name__}({exc}) — wanted PartnerOpsError"
        )
        return ""
    failures.append(f"{label}: was NOT refused — returned {result!r}")
    return ""


# ══════════════════════════════════════════════════════════════════════════════
#  The world
# ══════════════════════════════════════════════════════════════════════════════

NOW = datetime(2026, 8, 24, tzinfo=timezone.utc)

STAFF_ACTOR = {
    "uid": "uid-ops-admin",
    "name": "Priya Menon",
    "role": "ops_admin",
    "team": "ops",
    "email": "priya@zipper.test",
}

REASON = "Owner lost access when the sub-agency signup failed; verified by phone."


def partner_doc(pid: str, kind: str, status: str = "approved", **extra) -> dict:
    return {
        "_id": pid,
        "kind": kind,
        "name": f"{pid} Ltd",
        "status": status,
        "is_active": status == "approved",
        "credit": {"outstanding": 0, "due_at": None, "history": []},
        "cash_paid_minor": 0,
        "total_coins_sold": 0,
        "created_at": NOW,
        **extra,
    }


class _Account:
    def __init__(self, uid: str, email: str):
        self.uid = uid
        self.email = email


class World:
    """One clean slate: Mongo, Firestore and Firebase Auth."""

    def __init__(self) -> None:
        self.db = FakeDb()
        self.fs = FakeFirestore()
        self.accounts: dict[str, _Account] = {}
        self.created: list[dict] = []
        self.create_fails: Exception | None = None

        ops.get_db = lambda: self.db  # type: ignore[assignment]
        audit_mod.get_db = lambda: self.db  # type: ignore[assignment]
        # Attaching a login now claims the human's role family — it is the
        # second way somebody becomes an agency's owner, and the only one the
        # one-agency-per-human rule used to miss. `partner_roles` reaches
        # Mongo through its own import, so it needs the same fake.
        partner_roles.get_db = lambda: self.db  # type: ignore[assignment]
        # B16: attaching now runs the same role table approval runs, which
        # reads what the person holds through `partner_applications` (and the
        # staff check through `users`). Same fake, same reason as above.
        from app.services import partner_applications as apps_mod
        from app.services import users as users_mod

        apps_mod.get_db = lambda: self.db  # type: ignore[assignment]
        users_mod.get_db = lambda: self.db  # type: ignore[assignment]
        firebase_mod.firestore_client = lambda: self.fs  # type: ignore[assignment]
        firebase_mod.get_user_by_email = self._by_email  # type: ignore[assignment]
        ops.fb_auth.create_user = self._create  # type: ignore[assignment]
        ops.fb_auth.generate_password_reset_link = (  # type: ignore[assignment]
            lambda email: f"https://reset.example/{email}"
        )

    # ── Firebase Auth ────────────────────────────────────────────────────
    def _by_email(self, email: str):
        return self.accounts.get(email.lower())

    def _create(self, **kwargs):
        if self.create_fails:
            raise self.create_fails
        email = str(kwargs["email"]).lower()
        account = _Account(f"fb-{len(self.accounts) + 1}", email)
        self.accounts[email] = account
        self.created.append(dict(kwargs))
        return account

    # ── Seeding ──────────────────────────────────────────────────────────
    def partner(self, pid: str, kind: str, status: str = "approved", **extra) -> dict:
        doc = partner_doc(pid, kind, status, **extra)
        self.db[C.PARTNERS].docs[pid] = dict(doc)
        collection = "sellers" if kind == "seller" else "agencies"
        self.fs.collection(collection).docs[pid] = {
            "crmId": f"CRM{pid[:5].upper()}",
            "agencyName" if collection == "agencies" else "displayName": doc["name"],
        }
        return doc

    def account(self, email: str, uid: str) -> None:
        self.accounts[email.lower()] = _Account(uid, email.lower())

    def crm_user(self, uid: str, data: dict) -> None:
        self.fs.collection("crmUsers").docs[uid] = dict(data)

    def staff(self, email: str) -> None:
        self.db[C.STAFF].docs[email] = {
            "_id": email,
            "uid": f"staff-{email}",
            "email": email,
            "role": "ops_member",
            "is_active": True,
        }

    # ── Reads ────────────────────────────────────────────────────────────
    def stored(self, pid: str) -> dict:
        return self.db[C.PARTNERS].docs[pid]

    def audit_entries(self, action: str) -> list[dict]:
        return [
            d
            for d in self.db[C.AUDIT].docs.values()
            if d.get("action") == action
        ]


def attach(world: World, pid: str, email: str, **kwargs):
    return ops.attach_login(pid, email, kwargs.pop("reason", REASON), STAFF_ACTOR,
                            **kwargs)


# ══════════════════════════════════════════════════════════════════════════════
#  1. The orphan gets an owner
# ══════════════════════════════════════════════════════════════════════════════

w = World()
before = w.partner("agency-orphan", "agency")
result = asyncio.run(
    attach(w, "agency-orphan", "  Ravi@Skyline.Example  ", name="Ravi Kulkarni",
           phone="+919876500001")
)

check("a Firebase account was created", len(w.created), 1)
check("the address is lower-cased", w.created[0]["email"], "ravi@skyline.example")
ok("the created account has no known password", "password" in w.created[0])
check("the account is not pre-verified", w.created[0]["email_verified"], False)
check("the response reports the creation", result["firebase_account_created"], True)
check("a set-password link comes back",
      result["set_password_link"], "https://reset.example/ravi@skyline.example")

uid = result["owner_crm_uid"]
ok("a uid came back", bool(uid))

# ── Mongo: the authoritative link ────────────────────────────────────────────
stored = w.stored("agency-orphan")
check("Mongo carries the link", stored["owner_crm_uid"], uid)
check("and the address", stored["login_email"], "ravi@skyline.example")
check("and the reason", stored["login_attach_reason"], REASON)
check("and who decided", stored["login_attached_by"]["uid"], STAFF_ACTOR["uid"])
check("and their role", stored["login_attached_by"]["role"], "ops_admin")

# ── Nothing else about the partner moved ─────────────────────────────────────
untouched = {
    k: v
    for k, v in stored.items()
    if k not in {
        "owner_crm_uid", "login_email", "login_attach_reason",
        "login_attached_by", "login_attached_at", "updated_at",
    }
}
check("the partner is otherwise byte-for-byte what it was",
      untouched, {k: v for k, v in before.items() if k != "updated_at"})
check("status unchanged", stored["status"], "approved")
check("credit unchanged", stored["credit"]["outstanding"], 0)
check("cash unchanged", stored["cash_paid_minor"], 0)
check("coins sold unchanged", stored["total_coins_sold"], 0)

# ── The audit entry ──────────────────────────────────────────────────────────
entries = w.audit_entries(ops.Act.LOGIN_ATTACHED)
check("exactly one audit entry", len(entries), 1)
entry = entries[0]
check("audited against the partner", entry["subject"],
      {"type": "partner", "id": "agency-orphan"})
check("with the mandatory reason", entry["reason"], REASON)
check("naming who did it", entry["actor"]["uid"], STAFF_ACTOR["uid"])
check("before says there was no login", entry["before"]["owner_crm_uid"], None)
check("after names the login", entry["after"]["owner_crm_uid"], uid)
check("the session role is recorded", entry["meta"]["session_role"], "agency")
check("and that the status did not move", entry["meta"]["partner_status_unchanged"],
      "approved")
check("no approval happened", w.audit_entries("partner.approved"), [])

# ── Firestore: the crmUsers document, written by the real `mirror` ───────────
crm_doc = w.fs.collection("crmUsers").docs[uid]
check("crm document written", result["crm_user_document_written"], True)
check("role is the partner's", crm_doc["role"], "agency")
check("linked by the field the rules read", crm_doc["agencyId"], "agency-orphan")
check("roles carries the capability", crm_doc["roles"], ["agency"])
check("roleStatus mirrors the partner", crm_doc["roleStatus"], {"agency": "approved"})
check("status mirrors the partner", crm_doc["status"], "approved")
check("a partner holds no CRM permissions", crm_doc["permissions"], [])
check("the address is on it", crm_doc["email"], "ravi@skyline.example")
check("the name is on it", crm_doc["name"], "Ravi Kulkarni")
check("the phone is on it", crm_doc["phone"], "+919876500001")
check("it is active", crm_doc["isActive"], True)
ok("a crmId was minted", len(str(crm_doc.get("crmId", ""))) == 8)
ok("no dept on a partner document", "dept" not in crm_doc)
ok("no reportsTo on a partner document", "reportsTo" not in crm_doc)
ok(
    "the Android app's staff directory was NOT written",
    "verifiedIdentities" not in w.fs.collections,
)

# ── Firestore: the back-link the rules bind on ──────────────────────────────
check("crmUid written back on the partner document",
      w.fs.collection("agencies").docs["agency-orphan"]["crmUid"], uid)
check("and reported", result["replica_synced"], True)
ok("the response says what it granted", "grants a sign-in and nothing else"
   in result["note"])


# ── A seller resolves to the seller vocabulary ───────────────────────────────

w = World()
w.partner("seller-orphan", "seller", status="pending")
seller_result = asyncio.run(attach(w, "seller-orphan", "coins@example.test"))
seller_doc = w.fs.collection("crmUsers").docs[seller_result["owner_crm_uid"]]
check("a seller's document says seller", seller_doc["role"], "seller")
check("and is linked by sellerId", seller_doc["sellerId"], "seller-orphan")
ok("and has no agencyId", "agencyId" not in seller_doc)
check("a pending partner's document is pending", seller_doc["status"], "pending")
check("attaching does not approve", w.stored("seller-orphan")["status"], "pending")
check("nor activate", w.stored("seller-orphan")["is_active"], False)

# A sub-agency is an agency, because it reads an agency's statement.
w = World()
w.partner("agency-sub", "sub_agency", parent_id="agency-main")
sub_result = asyncio.run(attach(w, "agency-sub", "sub@example.test"))
sub_doc = w.fs.collection("crmUsers").docs[sub_result["owner_crm_uid"]]
check("a sub-agency's login is an agency", sub_doc["role"], "agency")
check("linked as an agency", sub_doc["agencyId"], "agency-sub")


# ── An address that already has a Firebase account is reused, not duplicated ─

w = World()
w.partner("agency-known", "agency")
w.account("already@example.test", "existing-uid-1")
reuse = asyncio.run(attach(w, "agency-known", "already@example.test"))
check("no second account was minted", len(w.created), 0)
check("the existing uid is used", reuse["owner_crm_uid"], "existing-uid-1")
check("reported honestly", reuse["firebase_account_created"], False)
check("and the document is keyed by it",
      w.fs.collection("crmUsers").docs["existing-uid-1"]["agencyId"], "agency-known")


# ══════════════════════════════════════════════════════════════════════════════
#  2. Refusals — and none of them creates anything
# ══════════════════════════════════════════════════════════════════════════════


def refuses_and_creates_nothing(label: str, world: World, factory) -> str:
    accounts = dict(world.accounts)
    crm_docs = dict(world.fs.collection("crmUsers").docs)
    partners = {k: dict(v) for k, v in world.db[C.PARTNERS].docs.items()}
    entries = len(world.db[C.AUDIT].docs)

    message = refuses(label, factory)

    ok(f"{label}: no Firebase account was created", world.accounts == accounts)
    ok(f"{label}: no crmUsers document was written",
       world.fs.collection("crmUsers").docs == crm_docs)
    ok(f"{label}: no partner record was changed",
       {k: dict(v) for k, v in world.db[C.PARTNERS].docs.items()} == partners)
    ok(f"{label}: nothing was audited", len(world.db[C.AUDIT].docs) == entries)
    return message


w = World()
w.partner("agency-a", "agency")
w.partner("agency-b", "agency")
w.partner("agency-linked", "agency", owner_crm_uid="uid-already-there")
w.partner("agency-fs-linked", "agency")
w.fs.collection("agencies").docs["agency-fs-linked"]["crmUid"] = "uid-on-firestore"
w.staff("employee@zipper.test")
w.account("employee@zipper.test", "uid-employee")

# ── The obvious ones ────────────────────────────────────────────────────────
message = refuses_and_creates_nothing(
    "a partner that does not exist", w,
    lambda: attach(w, "agency-nowhere", "x@example.test"),
)
ok("names the id", "agency-nowhere" in message)

message = refuses_and_creates_nothing(
    "no reason", w, lambda: attach(w, "agency-a", "x@example.test", reason="ok"),
)
ok("says a reason is required", "reason" in message.lower())

for bad in ("", "   ", "not-an-address", "@example.test", "someone@"):
    refuses_and_creates_nothing(
        f"an invalid address {bad!r}", w,
        lambda b=bad: attach(w, "agency-a", b),
    )

# ── A login is already attached ─────────────────────────────────────────────
message = refuses_and_creates_nothing(
    "a partner already linked in Mongo", w,
    lambda: attach(w, "agency-linked", "someone@example.test"),
)
ok("refuses a handover", "already has a login" in message)
ok("and says nothing was changed", "nothing was changed" in message)

message = refuses_and_creates_nothing(
    "a partner already linked in Firestore only", w,
    lambda: attach(w, "agency-fs-linked", "someone@example.test"),
)
ok("both halves of the link are checked", "already has a login" in message)

# ── The address belongs to somebody else ────────────────────────────────────
message = refuses_and_creates_nothing(
    "a staff address", w, lambda: attach(w, "agency-a", "employee@zipper.test"),
)
ok("says it is staff", "staff account" in message)
ok("and why that could never work", "resolves staff first" in message)

w.crm_user("uid-holder", {
    "uid": "uid-holder",
    "email": "held@example.test",
    "role": "agency",
    "agencyId": "agency-b",
})
message = refuses_and_creates_nothing(
    "an address holding another partner's CRM account", w,
    lambda: attach(w, "agency-a", "held@example.test"),
)
ok("names the partner it belongs to", "agency-b" in message)

# A Firestore outage cannot be read as "no login attached".
w.fs.collection("agencies").fail_on("get")
message = refuses_and_creates_nothing(
    "Firestore unreachable", w, lambda: attach(w, "agency-a", "new@example.test"),
)
ok("says nothing was created", "Nothing was created" in message
   or "nothing was created" in message)
w.fs.collection("agencies").clear_failures()

# And after every one of those, the untouched partner is still attachable.
final = asyncio.run(attach(w, "agency-a", "finally@example.test"))
check("the record was left in a state that still works",
      w.stored("agency-a")["owner_crm_uid"], final["owner_crm_uid"])

# ── FROM HERE, EACH CASE GETS ITS OWN WORLD ─────────────────────────────────
#
# `World()` repoints the module-level seams (`ops.get_db` and friends) at its
# own fakes, so the newest one is what the code under test actually reads. The
# blocks below therefore have to come AFTER every remaining use of `w` — an
# earlier draft put them in the middle of this section and the checks that
# followed went looking for `agency-a` in a database that had never heard of
# it.

# ── THE ROLE-FAMILY CLASH: a second agency for one human ───────────────────
#
# Linking is the second way somebody becomes an agency's owner, and it is the
# one the rule used to miss.
#
# NOTE WHAT THIS PROVES ABOUT PRE-EXISTING DATA. `their-first-agency` is seeded
# straight into Mongo with an `owner_crm_uid` and NO claim sentinel — the shape
# of every partner in production, because the claim collection was created
# with this rule and is empty for all of them. A check that read only its own
# sentinels would find nothing here and allow the link. It reads `partners`.
#
# Its own world, like everything below. Run against the shared `w` above, a
# mutant that lets the link through does not report a failed check: it links
# `agency-a`, and the later cases that reuse `agency-a` die with a traceback
# instead. A regression should name itself.
w1b = World()
w1b.partner("their-first-agency", "agency", owner_crm_uid="uid-reused")
w1b.account("reused@example.test", "uid-reused")
w1b.partner("a-second-agency", "agency")

message = refuses_and_creates_nothing(
    "linking a second agency to a human who already holds one", w1b,
    lambda: attach(w1b, "a-second-agency", "reused@example.test"),
)
ok("names the agency they already hold", "their-first-agency" in message)
ok("and states the rule", "one agency record" in message)
ok("and says nothing was created", "Nothing was created" in message)
check("the second agency is still unlinked — the record is unchanged",
      w1b.stored("a-second-agency").get("owner_crm_uid"), None)
check("and so is the first",
      w1b.stored("their-first-agency")["owner_crm_uid"], "uid-reused")
ok("the claim is not left behind by the refusal — a refused link must not "
   "lock the human out of the family for ever",
   not [d for d in w1b.db[partner_roles.PARTNER_ROLE_CLAIMS].docs.values()
        if d.get("partner_id") == "a-second-agency"])


# ── THE COMBINATION THE OLD CHECK WRONGLY REFUSED ───────────────────────────
#
# A FRESH WORLD for each of the next cases, deliberately. Run against `w` they
# would pass or fail for the wrong reason: the attach above writes a `crmUsers`
# document for that address, and the "one address is one login" check — an
# older, separate rule — fires before the family check and would be the thing
# answering. Each case below tests exactly one rule.
#
# The old clash check was `find_one({"owner_crm_uid": uid})` — ANY other
# partner, of any kind. Its own message said "a login holds at most one agency
# record and one seller record", and then refused the second of those.
# Attaching a coin seller to somebody who runs an agency was rejected with a
# message describing it as permitted.
w2 = World()
w2.partner("their-agency", "agency", owner_crm_uid="uid-both")
w2.account("both@example.test", "uid-both")
w2.partner("their-coin-shop", "seller")
allowed = asyncio.run(attach(w2, "their-coin-shop", "both@example.test"))
check("an agency owner CAN be given a coin-seller login",
      allowed["owner_crm_uid"], "uid-both")
check("and Mongo carries it",
      w2.stored("their-coin-shop")["owner_crm_uid"], "uid-both")
check("their agency is untouched by it",
      w2.stored("their-agency")["owner_crm_uid"], "uid-both")

# ── A SUB-AGENCY IS THE SAME FAMILY AS AN AGENCY ────────────────────────────
w3 = World()
w3.partner("their-agency", "agency", owner_crm_uid="uid-sub")
w3.account("sub@example.test", "uid-sub")
w3.partner("a-sub-agency", "sub_agency")
message = refuses_and_creates_nothing(
    "linking a sub-agency to a human who already holds an agency", w3,
    lambda: attach(w3, "a-sub-agency", "sub@example.test"),
)
ok("the sub-agency refusal explains the shared family",
   "Sub-agency are the same family" in message)
check("and the sub-agency is still unlinked",
      w3.stored("a-sub-agency").get("owner_crm_uid"), None)
check("and the agency they already held is unchanged",
      w3.stored("their-agency")["owner_crm_uid"], "uid-sub")

# ── A REJECTED AGENCY DOES NOT HOLD THE SLOT ────────────────────────────────
# One LIVE agency per human, not one ever. Otherwise a single refused
# application would be a life sentence.
w4 = World()
w4.partner("agency-rejected", "agency", status="rejected",
           owner_crm_uid="uid-reapplies")
w4.account("reapplies@example.test", "uid-reapplies")
w4.partner("agency-fresh-try", "agency")
again = asyncio.run(attach(w4, "agency-fresh-try", "reapplies@example.test"))
check("a human whose only agency was REJECTED may be linked to a new one",
      again["owner_crm_uid"], "uid-reapplies")

# ── A SUSPENDED AGENCY DOES ─────────────────────────────────────────────────
# A suspension is temporary and the business still exists, so it keeps its
# place. This is the line between the two, and it is easy to get backwards.
w5 = World()
w5.partner("agency-suspended", "agency", status="suspended",
           owner_crm_uid="uid-suspended")
w5.account("suspended@example.test", "uid-suspended")
w5.partner("agency-while-suspended", "agency")
message = refuses_and_creates_nothing(
    "a suspended agency still holds the slot", w5,
    lambda: attach(w5, "agency-while-suspended", "suspended@example.test"),
)
ok("named in the refusal", "agency-suspended" in message)


# ══════════════════════════════════════════════════════════════════════════════
#  3. A replica failure does not unwind the grant
# ══════════════════════════════════════════════════════════════════════════════
#
# Mongo is written and audited first, so the API session works even when the
# CRM's own document does not get written. The caller is told, rather than the
# decision being rolled back — `owner_crm_uid` is what sign-in resolves against.

w = World()
w.partner("agency-flaky", "agency")
w.fs.collection("crmUsers").fail_on("set")
flaky = asyncio.run(attach(w, "agency-flaky", "flaky@example.test"))

check("Mongo still carries the link",
      w.stored("agency-flaky")["owner_crm_uid"], flaky["owner_crm_uid"])
check("the grant is audited regardless", len(w.audit_entries(ops.Act.LOGIN_ATTACHED)), 1)
check("the failure is reported", flaky["crm_user_document_written"], False)
ok("and explained", "crmUsers" in flaky.get("warning", ""))
ok("the API half is said to work", "Mongo" in flaky.get("warning", ""))


# ══════════════════════════════════════════════════════════════════════════════
#  4. `mirror` still behaves exactly as it did for everybody else
# ══════════════════════════════════════════════════════════════════════════════
#
# The partner branch is inside `crm_directory.mirror` rather than beside it, so
# the one thing worth proving is that nothing reached it by accident. Without a
# partner id an external role is still in `NOT_MIRRORED` and still *removes*
# documents, which is what the repair script depends on.

w = World()
w.crm_user("stray-uid", {"uid": "stray-uid", "email": "stray@example.test",
                         "role": "agency", "agencyId": "agency-x"})
outcome = crm.mirror(
    uid="stray-uid", email="stray@example.test", name="Stray",
    role=Role.AGENCY, created_by="uid-ops-admin",
)
check("an agency with no partner id is still not mirrored", outcome.action, "removed")
ok("and the stray document is gone",
   "stray-uid" not in w.fs.collection("crmUsers").docs)

check(
    "the observer path is untouched",
    crm.mirror(uid="obs", email="observer@zipper.test", name="Observer",
               role=Role.OBSERVER, created_by="x").action,
    "absent_by_design",
)

staff_outcome = crm.mirror(
    uid="uid-tech", email="dev@zipper.test", name="Dev", role=Role.TECH_ADMIN,
    created_by="uid-ops-admin", phone="+911111111111",
)
staff_doc = w.fs.collection("crmUsers").docs["uid-tech"]
check("a staff document is unchanged in shape", staff_outcome.crm_role, "tech_admin")
check("with its department", staff_doc["dept"], "tech")
check("its reportsTo key", staff_doc["reportsTo"], None)
ok("its real permissions", "can_economy_config" in staff_doc["permissions"])
ok("no partner link on it", "agencyId" not in staff_doc and "sellerId" not in staff_doc)
ok("and the Android directory written as before",
   "verifiedIdentities" in w.fs.collections)

# A partner id on a staff role is refused rather than written: a link field on a
# staff document would give a staff account an agency's scope in the rules.
try:
    crm.mirror(uid="uid-tech2", email="dev2@zipper.test", name="Dev",
               role=Role.TECH_ADMIN, created_by="x", partner_id="agency-a")
    failures.append("a partner id on a staff role was accepted")
    checks += 1
except crm.DirectoryError as exc:
    checks += 1
    ok("a partner id on a staff role is refused", "not an external partner role"
       in str(exc))


# ══════════════════════════════════════════════════════════════════════════════
#  6. Two staff members linking the same person at the same moment
# ══════════════════════════════════════════════════════════════════════════════
#
# The check that matters is not "is this refused" — section 2 covers that —
# but "can BOTH succeed". A read-then-write guard passes for both callers when
# they interleave, and the result is the production bug: one human, two
# agencies, each created by somebody who checked first and was told it was
# fine.
#
# Eight agencies, one address, launched together. The claim is an `_id` insert,
# so Mongo settles it: exactly one caller may come back with a link.

w6 = World()
w6.account("raced@example.test", "uid-raced")
for i in range(8):
    w6.partner(f"agency-race-{i}", "agency")

async def _race() -> list:
    # `asyncio.gather` has to be built INSIDE the running loop. Called from
    # `asyncio.run(asyncio.gather(...))` it is evaluated first, with no loop
    # yet, and 3.10 raises rather than making one.
    return await asyncio.gather(
        *[attach(w6, f"agency-race-{i}", "raced@example.test") for i in range(8)],
        return_exceptions=True,
    )


outcomes = asyncio.run(_race())
won = [o for o in outcomes if not isinstance(o, Exception)]
lost = [o for o in outcomes if isinstance(o, ops.PartnerOpsError)]
other = [o for o in outcomes if isinstance(o, Exception)
         and not isinstance(o, ops.PartnerOpsError)]

check("eight simultaneous links → exactly ONE succeeds", len(won), 1)
check("     and the other seven are refused, not crashed", len(lost), 7)
check("     with nothing raised that is not a refusal", other, [])

linked = [pid for pid in (f"agency-race-{i}" for i in range(8))
          if str(w6.stored(pid).get("owner_crm_uid") or "")]
check("exactly one agency carries the link in Mongo", len(linked), 1)
check("and it is the one that was reported", linked, [won[0]["id"]])
check("exactly one agency-family claim exists for this human",
      len([d for d in w6.db[partner_roles.PARTNER_ROLE_CLAIMS].docs.values()
           if d.get("owner_uid") == "uid-raced"
           and d.get("family") == partner_roles.AGENCY_FAMILY]), 1)


# ══════════════════════════════════════════════════════════════════════════════
#  7. Staff can still create and run an UNLINKED agency
# ══════════════════════════════════════════════════════════════════════════════
#
# Said out loud because the cheapest way to make the rule above hold is to
# require an owner on every record, and that would break staff onboarding:
# `/agencies/register` deliberately creates the agency first and attaches the
# login after, so the half-finished state is visible on /agencies rather than
# invisible.
#
# An unlinked record belongs to nobody, so it holds no family and bars nobody.

w7 = World()
w7.partner("agency-unlinked-a", "agency")
w7.partner("agency-unlinked-b", "agency")

check("an unlinked agency has no owner", w7.stored("agency-unlinked-a").get("owner_crm_uid"), None)
check("two of them can coexist", len(w7.db[C.PARTNERS].docs), 2)
check("and neither claims a role family",
      len(w7.db[partner_roles.PARTNER_ROLE_CLAIMS].docs), 0)

# Both are still attachable — to DIFFERENT humans.
w7.account("owner-one@example.test", "uid-one")
w7.account("owner-two@example.test", "uid-two")
one = asyncio.run(attach(w7, "agency-unlinked-a", "owner-one@example.test"))
two = asyncio.run(attach(w7, "agency-unlinked-b", "owner-two@example.test"))
check("the first unlinked agency links to a human with no agency",
      one["owner_crm_uid"], "uid-one")
check("the second links to a DIFFERENT human",
      two["owner_crm_uid"], "uid-two")
ok("two humans, two agencies, both allowed", one["owner_crm_uid"] != two["owner_crm_uid"])


# ══════════════════════════════════════════════════════════════════════════════
#  B16 — attaching runs the whole role table, not only the family lock
# ══════════════════════════════════════════════════════════════════════════════
#
# The lock is one rule of several. A Host given an agency's login passed it,
# because Host + Agency is a rule of the table and not of the family claim.

w16 = World()
w16.partner("their-agency", "agency", owner_crm_uid="uid-their-owner")
w16.partner("agency-for-a-host", "agency")
w16.account("host@example.test", "uid-host")
w16.fs.collection("users").docs["uid-host"] = {"name": "Hema", "isHost": True, "agencyId": "their-agency"}
message = refuses_and_creates_nothing(
    "B16: a Host cannot be given an agency's login", w16,
    lambda: attach(w16, "agency-for-a-host", "host@example.test"),
)
ok("B16: …told it is the Host rule", "Host" in message)
ok("B16: …and that no login was attached", "No login was attached" in message)
ok("B16: …and the family claim it took was given back",
   "agency:uid-host" not in w16.db[partner_roles.PARTNER_ROLE_CLAIMS].docs)

# C1 at the same door: a REVOKED agency still holds its owner's place.
w16b = World()
w16b.partner("agency-revoked", "agency", status="revoked", owner_crm_uid="uid-revoked")
w16b.account("revoked@example.test", "uid-revoked")
w16b.partner("agency-again", "agency")
message = refuses_and_creates_nothing(
    "C1: the owner of a REVOKED agency cannot be given another", w16b,
    lambda: attach(w16b, "agency-again", "revoked@example.test"),
)
ok("C1: …the revoked agency is what holds the place", "agency-revoked" in message)


# ══════════════════════════════════════════════════════════════════════════════
#  Result
# ══════════════════════════════════════════════════════════════════════════════

if failures:
    print(f"\n{len(failures)} of {checks} FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)

print(f"\n  ✓ all {checks} attach-login checks passed\n")
print("  · an orphaned partner gets a Firebase account, a crmUsers document")
print("    written by the real crm_directory.mirror, and a crmUid back-link")
print("  · it grants a sign-in and nothing else: status, credit, cash and coins")
print("    are byte-for-byte what they were, and no approval is recorded")
print("  · every mutation carries a mandatory reason into the audit log, with")
print("    who decided and the fact that the status did not move")
print("  · a partner that is already linked, a staff address and an address")
print("    that holds another partner's account are all refused — and none of")
print("    them creates a Firebase account, a document or an audit entry")
print("  · LINKING GOES THROUGH THE ONE-AGENCY-PER-HUMAN RULE: a second agency")
print("    is refused even when the holder has no claim sentinel, because the")
print("    `partners` records are read and not just this rule's own bookkeeping")
print("  · an agency owner may still be given a coin-seller login; a sub-agency")
print("    is the same family as an agency and is refused")
print("  · rejected releases the slot, suspended keeps it")
print("  · eight simultaneous links resolve to exactly one owned agency")
print("  · unlinked agencies still work: staff create them, they claim nothing,")
print("    and two of them link to two different humans")
print("  · a Firestore failure does not unwind the grant; Mongo is authoritative")
print("    and the caller is told which half is missing")
print("  · mirror() with no partner id still removes an agency's document, so")
print("    the repair script and the observer path are unchanged")
sys.exit(0)
