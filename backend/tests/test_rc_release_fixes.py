"""RC release fixes — RF-27 (restriction precedence) and RF-30 (unknown outcomes).

── RF-27: A RESTRICTED ACCOUNT CANNOT FILE AN APPLICATION ──────────────────

`submit_partner_application` refused `isBanned` only, and
`submit_host_application` refused nothing. The callables in front of them
check the restriction first (`assertActiveSession`), but the API is the
authority and must not depend on its caller: an account that is suspended or
banned in ANY spelling — `accountState` first, then the two flags, exactly as
`core.account_state.app_account_refusal` reads it for a session — is refused
at both doors, and nothing is written.

── RF-30: A RECHARGE CAN BE ASKED FOR AGAIN WITHOUT BEING FILED TWICE ──────

The bridge gives the API 25 s. A recharge filed with a screenshot and no
reference, whose reply was lost to that timeout, was filed AGAIN when the
buyer pressed Send again — two pending requests for one payment, each of which
a reviewer could approve. With a reference, the repeat was refused with
"Reference … has already been submitted", which reads as somebody else's use.

The app now sends one `client_request_id` per form. A repeat by the same buyer
with the same details returns the request already filed (`replayed`), with no
second notice and no second audit; the same id with different details is
refused; two copies racing in resolve to one request through the partial
unique index `(buyer_uid, client_request_id)`. Without an id, nothing changes.

Service-level integration against in-memory fakes — NOT an end-to-end test.
REAL: `services/partner_applications`, `services/recharges`,
      `core/account_state.app_account_refusal`, `db/mongo` index builders.
FAKE: Mongo (`tests/harness.FakeDb`, which enforces declared partial unique
      indexes with Mongo's participation rules and yields inside
      `insert_one`, so two coroutines really interleave), Firestore
      (`tests/fakes.FakeFirestore`), Firebase Auth (`harness.verified_auth`).

    python3 -m tests.test_rc_release_fixes
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs, verified_auth  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
firebase_mod.get_user = verified_auth  # type: ignore[assignment]
audit_entries: list[dict] = []


async def fake_audit(**kw):
    audit_entries.append(kw)
    return f"audit-{len(audit_entries)}"


audit_mod.record = fake_audit

from app.services import partner_applications as apps  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services import partner_roles as roles  # noqa: E402
from app.services import partners as partner_svc  # noqa: E402
from app.services import recharges as rc  # noqa: E402
from app.services.partner_ops import PartnerOpsError  # noqa: E402

for mod in (ops, partner_svc, roles, apps, rc):
    mod.get_db = lambda: DB  # type: ignore[assignment]
for mod in (ops, apps, rc):
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
    "agencyName": "Agency", "ownerName": "O", "address": "1 Road", "paymentType": "india",
    "accountHolderName": "O", "accountNumber": "123", "ifscCode": "HDFC0001", "bankName": "HDFC",
    "branch": "Main", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
}
HOST_FORM = {
    "hostName": "H", "age": "24", "country": "India", "callRate": "10",
    "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"], "photoUrl": ["https://x/p"],
}


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def main_agency(pid: str, owner: str) -> None:
    user(owner)
    fs.collection("agencies").docs[pid] = {
        "agencyName": pid, "type": "main", "parentAgencyId": None,
        "status": "pending", "kycStatus": "submitted", "ownerUid": owner, "crmUid": owner,
        "source": "self_signup", "kycDocUrls": ["https://x/1", "https://x/2", "https://x/3"],
    }
    run(ops.ensure_partner_record(pid, SERVICE, "Registered."))
    run(ops.approve_partner(pid, WHY, STAFF))


def filed_by(uid: str) -> list:
    """Everything an applicant left behind: partner records and host applications."""
    partners = [d for d in DB[C.PARTNERS].docs if d.get("owner_crm_uid") == uid or d.get("owner_uid") == uid]
    host_apps = [d for d in fs.collection("hostApplications").docs.values() if d.get("applicantUid") == uid]
    return partners + host_apps


main_agency("AG-MAIN", "own-main")

# ══════════════════════════════════════════════════════════════════════════════
print("\nRF-27. A restricted account cannot file — at the API, in every spelling")

RESTRICTED = {
    "accountState suspended, both flags false": {"accountState": "suspended"},
    "accountState banned, both flags false": {"accountState": "banned"},
    "isSuspended only (legacy)": {"accountState": "", "isSuspended": True},
    "isBanned only (legacy)": {"accountState": "", "isBanned": True},
}
for i, (label, shape) in enumerate(RESTRICTED.items()):
    # One account per door, so a refusal at one door can never be explained by
    # what the other door filed ("An Agency cannot also be a Host").
    uid_p, uid_h = f"rp-{i}", f"rh-{i}"
    user(uid_p, **shape)
    user(uid_h, **shape)
    exc = refusal(apps.submit_partner_application(uid_p, "agency", dict(AGENCY_FORM, agencyName=f"A{i}"), None, SERVICE))
    ok(f"partner application refused — {label}", exc is not None, "it was filed")
    ok(f"…because the account is restricted — {label}",
       exc is not None and "cannot apply" in str(exc), repr(exc))
    eq(f"…and nothing was written — {label}", filed_by(uid_p), [])
    exc = refusal(apps.submit_host_application(uid_h, dict(HOST_FORM), "AG-MAIN", SERVICE))
    ok(f"Host application refused — {label}", exc is not None, "it was filed")
    ok(f"…because the account is restricted — {label}",
       exc is not None and "cannot apply" in str(exc), repr(exc))
    eq(f"…and nothing was written — {label}", filed_by(uid_h), [])

user("ok-1")
a = run(apps.submit_partner_application("ok-1", "agency", dict(AGENCY_FORM, agencyName="Fine"), None, SERVICE))
eq("control: an ordinary account's Agency application is filed", a["status"], "pending")
user("ok-2")
h = run(apps.submit_host_application("ok-2", dict(HOST_FORM), "AG-MAIN", SERVICE))
eq("control: an ordinary account's Host application is filed", h["status"], "pending")

# ══════════════════════════════════════════════════════════════════════════════
print("RF-30. A recharge repeated with the same request id is filed once")

run(mongo.ensure_recharge_reference_index(DB))
built = run(mongo.ensure_recharge_request_id_index(DB))
info = run(DB[C.RECHARGES].index_information())
spec = info.get(mongo.RECHARGE_REQUEST_ID_INDEX, {})
eq("the index is declared on (buyer_uid, client_request_id)",
   [tuple(k) for k in spec.get("key", [])], [("buyer_uid", 1), ("client_request_id", 1)])
eq("…unique", spec.get("unique"), True)
eq("…and partial on a non-empty id, so older apps' requests take no part",
   spec.get("partialFilterExpression"), {"client_request_id": {"$gt": ""}})
eq("…building it again is harmless", run(mongo.ensure_recharge_request_id_index(DB)), built)

DB[C.PARTNERS].docs.append({"_id": "SELL", "kind": "seller", "name": "Coins R Us",
                            "status": "approved", "is_active": True, "owner_crm_uid": "u-seller"})
DB[C.PARTNERS].docs.append({"_id": "SELL2", "kind": "seller", "name": "Other Coins",
                            "status": "approved", "is_active": True, "owner_crm_uid": "u-seller2"})
fs.collection("users").docs["u-buyer"] = {"name": "Buyer", "diamonds": 0}


def file(buyer="u-buyer", **over) -> dict:
    kw = dict(seller_id="SELL", diamonds=300, amount_minor=30000, currency="INR",
              payment_method="upi", reference="", proof_url="https://x/proof.jpg", actor=SERVICE)
    kw.update(over)
    return run(rc.submit_recharge(buyer, kw.pop("seller_id"), **kw))


def requests_of(buyer: str) -> list[dict]:
    return [d for d in DB[C.RECHARGES].docs if d.get("buyer_uid") == buyer]


def notices_for(uid: str) -> int:
    return len([d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid])


def audits() -> int:
    return len([e for e in audit_entries if e.get("action") == audit_mod.Action.RECHARGE_REQUESTED])


RID = "rq-0123456789abcdef"
first = file(client_request_id=RID)
eq("the first filing is pending", first["status"], "pending")
eq("…stores the request id", requests_of("u-buyer")[0].get("client_request_id"), RID)
ok("…is not a replay", not first.get("replayed"))
n_buyer, n_seller, n_audit = notices_for("u-buyer"), notices_for("u-seller"), audits()

again = file(client_request_id=RID)
eq("the same form again returns the SAME request", again["id"], first["id"])
eq("…marked as a replay", again.get("replayed"), True)
eq("…and still ONE request for this payment (was: two, proof-only)", len(requests_of("u-buyer")), 1)
eq("…no second notice to the buyer", notices_for("u-buyer"), n_buyer)
eq("…or to the seller", notices_for("u-seller"), n_seller)
eq("…and no second audit entry", audits(), n_audit)

exc = refusal(rc.submit_recharge("u-buyer", "SELL", diamonds=300, amount_minor=99900, currency="INR",
                                 payment_method="upi", reference="", proof_url="https://x/proof.jpg",
                                 actor=SERVICE, client_request_id=RID))
ok("the same id with a DIFFERENT amount is refused", isinstance(exc, PartnerOpsError), repr(exc))
ok("…naming the request already filed", exc is not None and first["id"] in str(exc), str(exc))
eq("…and nothing more was filed", len(requests_of("u-buyer")), 1)
exc = refusal(rc.submit_recharge("u-buyer", "SELL2", diamonds=300, amount_minor=30000, currency="INR",
                                 payment_method="upi", reference="", proof_url="https://x/proof.jpg",
                                 actor=SERVICE, client_request_id=RID))
ok("the same id naming ANOTHER seller is refused", isinstance(exc, PartnerOpsError), repr(exc))

fs.collection("users").docs["u-other"] = {"name": "Other", "diamonds": 0}
other = file(buyer="u-other", client_request_id=RID)
ok("the same id from ANOTHER buyer is that buyer's own request", other["id"] != first["id"])
ok("…not a replay of someone else's", not other.get("replayed"))

# With a reference (UTR): the repeat used to be refused as "already submitted".
RID2 = "rq-utr-000000000001"
withref = file(reference="UTR-777", client_request_id=RID2)
again = file(reference="UTR-777", client_request_id=RID2)
eq("a repeat WITH a reference returns the request (was: 'Reference … already submitted')",
   again["id"], withref["id"])
eq("…as a replay", again.get("replayed"), True)
exc = refusal(rc.submit_recharge("u-other", "SELL", diamonds=10, amount_minor=1000, currency="INR",
                                 payment_method="upi", reference="UTR-777", proof_url="",
                                 actor=SERVICE, client_request_id="rq-someone-else-01"))
ok("the reference rule still holds for everybody else", isinstance(exc, PartnerOpsError) and "UTR-777" in str(exc),
   repr(exc))

# A repeat after the seller stopped accepting recharges is still the request already filed.
RID3 = "rq-before-suspension"
before = file(client_request_id=RID3, diamonds=50, amount_minor=5000)
seller = next(p for p in DB[C.PARTNERS].docs if p["_id"] == "SELL")
seller["is_active"] = False
after = file(client_request_id=RID3, diamonds=50, amount_minor=5000)
eq("a repeat after the seller was paused returns the request already filed", after["id"], before["id"])
exc = refusal(rc.submit_recharge("u-buyer", "SELL", diamonds=50, amount_minor=5000, currency="INR",
                                 payment_method="upi", reference="", proof_url="https://x/proof.jpg",
                                 actor=SERVICE, client_request_id="rq-new-after-pause"))
ok("…while a NEW request to that seller is refused as before", isinstance(exc, PartnerOpsError), repr(exc))
seller["is_active"] = True

for bad in ("short", "has spaces in it!", "x" * 65, "semi;colon-id"):
    exc = refusal(rc.submit_recharge("u-buyer", "SELL", diamonds=1, amount_minor=100, currency="INR",
                                     payment_method="upi", reference="", proof_url="https://x/p.jpg",
                                     actor=SERVICE, client_request_id=bad))
    ok(f"a malformed id {bad[:12]!r} is refused", isinstance(exc, PartnerOpsError), repr(exc))

# Older apps: no id → the old behaviour, unchanged (two proof-only filings are two requests).
fs.collection("users").docs["u-old"] = {"name": "Old app", "diamonds": 0}
o1 = file(buyer="u-old")
o2 = file(buyer="u-old")
ok("without an id, two filings are two requests, as before", o1["id"] != o2["id"])
ok("…and neither carries a request id", all("client_request_id" not in d for d in requests_of("u-old")))

# Two copies of the same form in flight at once.
fs.collection("users").docs["u-race"] = {"name": "Racer", "diamonds": 0}
RACE = "rq-race-0000000001"


async def _race():
    return await asyncio.gather(
        rc.submit_recharge("u-race", "SELL", diamonds=70, amount_minor=7000, currency="INR",
                           payment_method="upi", reference="", proof_url="https://x/r.jpg",
                           actor=SERVICE, client_request_id=RACE),
        rc.submit_recharge("u-race", "SELL", diamonds=70, amount_minor=7000, currency="INR",
                           payment_method="upi", reference="", proof_url="https://x/r.jpg",
                           actor=SERVICE, client_request_id=RACE),
        return_exceptions=True,
    )


res = run(_race())
eq("two copies racing in: neither is refused", [type(r).__name__ for r in res], ["dict", "dict"])
eq("…ONE request exists", len(requests_of("u-race")), 1)
eq("…both answers name it", {r["id"] for r in res if isinstance(r, dict)}, {requests_of("u-race")[0]["_id"]})

# ══════════════════════════════════════════════════════════════════════════════
print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} RC release-fix checks passed.")
