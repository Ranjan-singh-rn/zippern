"""C2 — reinstatement of a revoked role: the person asks, a reviewer recommends,
the Owner decides, and the SAME record comes back.

── WHAT THIS PINS ──────────────────────────────────────────────────────────

  * filing: only for a revoked role the person actually has, never on a
    restricted account, idempotent (a second submit — sequential or at the
    same moment — returns the open request), held by the `<uid>:<kind>` lock;
  * the eligibility answer shows the request against the revoked role;
  * recommending: by a reviewer of THAT kind of role (`can_approve_kyc` for
    Host / Agency / Sub-agency, `can_approve_seller` for Coin Seller, the
    Owner), with a note, conditional on the open status; the Owners are told
    (audit + the existing email path);
  * deciding: the Owner only (403 "Only the Owner can decide a reinstatement."
    for anyone else, through the route as well as the service); `restore`
    runs the existing restore on the same record id; `keep_revoked` keeps the
    history; the lock goes; the person is told; a second decision is refused;
  * a restore the existing rules refuse (a restricted account) leaves the
    request open and the role revoked.

REAL: services.role_appeals, partner_ops, partner_applications, partner_roles,
users, notices, notify, email; routers.role_appeals.
FAKE: Mongo (`tests/harness.FakeDb`), Firestore (`tests/fakes.FakeFirestore`).

    python3 -m tests.test_role_appeals
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import FakeDb, install_stubs  # noqa: E402

install_stubs()

import app.db.mongo as mongo  # noqa: E402

DB = FakeDb()
mongo.get_db = lambda: DB  # type: ignore[assignment]

from tests.fakes import FakeFirestore  # noqa: E402

from app.core import audit as audit_mod  # noqa: E402
from app.core import roles as R  # noqa: E402
from app.core.roles import Permission, Role  # noqa: E402
from app.db import firebase as firebase_mod  # noqa: E402
from tests import harness as _rc_harness  # noqa: E402

# Decision 15 (RC): every login in these fixtures holds BOTH verified contacts
# (an SMS-linked phone and a code-verified email) — the subject of this module
# is not the contact rule, which tests/test_rc_contact_verification.py runs with
# per-uid records, verified and not.
firebase_mod.get_user = _rc_harness.verified_auth  # type: ignore[assignment]
from app.db.mongo import C  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]

AUDIT: list[dict] = []


async def fake_audit(**kw):
    AUDIT.append(kw)
    return f"audit-{len(AUDIT)}"


audit_mod.record = fake_audit

from app.routers import role_appeals as router  # noqa: E402
from app.services import partner_applications as apps  # noqa: E402
from app.services import role_appeals as svc  # noqa: E402

apps.is_unverified_guest = lambda uid: False  # fixtures are verified people
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


def refused(claim: str, coro, kind=svc.RoleAppealError):
    """The refusal, or None (and a failure) when it was not refused."""
    global checks
    checks += 1
    try:
        asyncio.run(coro)
    except kind as exc:
        return exc
    except Exception as exc:  # noqa: BLE001
        failures.append(f"{claim}: raised {type(exc).__name__}({exc})")
        return None
    failures.append(f"{claim}: was NOT refused")
    return None


run = asyncio.run
NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
SERVICE = {"uid": "system:partner-registration", "name": "Partner registration (automated)",
           "role": "system", "team": None}
REVIEWER = {"uid": "ops-1", "name": "Ops Admin", "role": "ops_admin", "team": "ops"}
FINANCE = {"uid": "fin-1", "name": "Finance Admin", "role": "finance_admin", "team": "finance"}
OWNER = {"uid": "owner-1", "name": "The Owner", "role": "owner", "team": None}
STATEMENT = "I fixed the issues the reviewer raised and would like my role back, please."
NOTE = "Reviewed the history; the breach was a one-off and is resolved."

DB.seed(C.STAFF, [{"uid": "owner-1", "role": "owner", "is_active": True,
                   "email": "owner@zipper.test", "name": "The Owner"}])


def user(uid: str, **over) -> None:
    fs.collection("users").docs[uid] = {"name": f"user {uid}", "accountState": "active",
                                        "isBanned": False, "isSuspended": False, **over}


def partner(pid: str, owner: str, kind: str, status: str = "approved", **over) -> None:
    DB[C.PARTNERS].docs.append({"_id": pid, "owner_crm_uid": owner, "kind": kind, "status": status,
                                "is_active": status == "approved", "name": pid, **over})


def record(pid: str) -> dict:
    return next(p for p in DB[C.PARTNERS].docs if p["_id"] == pid)


def notices_for(uid: str) -> list[dict]:
    return [d for d in fs.collection("notifications").docs.values() if d.get("userId") == uid]


# ── The world ────────────────────────────────────────────────────────────────
# An Agency + Coin Seller whose Agency was revoked (the Ruhan shape).
user("u-ag")
partner("AG", "u-ag", "agency", status="revoked", revoked_at=NOW,
        revocation_reason="Repeated policy breaches.")
partner("SL", "u-ag", "seller")
DB.seed("partner_role_claims", [{"_id": "agency:u-ag", "owner_uid": "u-ag", "family": "agency",
                                 "kind": "agency", "partner_id": "AG", "claimed_at": NOW,
                                 "claimed_via": "create"}])
# Nobody revoked.
user("u-plain")
partner("SL-plain", "u-plain", "seller")
# A banned account with a revoked Coin Seller.
user("u-banned", isBanned=True, accountState="banned")
partner("SL-banned", "u-banned", "seller", status="revoked", revoked_at=NOW)
# A revoked Coin Seller (for keep_revoked).
user("u-s2")
partner("SL2", "u-s2", "seller", status="revoked", revoked_at=NOW, revocation_reason="Chargebacks.")
partner("AG-s2", "u-s2", "agency")
# A revoked Host under a live agency, with the application they joined on.
partner("AG-HOME", "home-owner", "agency")
user("u-host", isHost=False, agencyId="AG-HOME", hostRevokedAt=NOW, hostRevokedReason="No-shows.")
fs.collection("hostApplications").docs["app-host"] = {"applicantUid": "u-host", "status": "approved",
                                                      "agencyId": "AG-HOME", "hostName": "Hema"}
partner("SL-host", "u-host", "seller")

# ══════════════════════════════════════════════════════════════════════════════
print("\n1. Filing a request")

first = run(svc.submit("u-ag", "agency", STATEMENT, SERVICE))
A1 = first["appeal"]["id"]
ok("a request is filed for the revoked Agency", A1.startswith("ra_"))
eq("…pending", first["appeal"]["status"], "pending")
eq("…naming the revoked record", first["appeal"]["record_id"], "AG")
eq("…and it is new", first["existing"], False)
eq("…held by the one-open-per-role lock", DB["role_appeal_locks"].docs[0]["_id"], "u-ag:agency")
ok("…audited as submitted", any(e["action"] == "role_appeal.submitted" and e["subject_id"] == A1 for e in AUDIT))
again = run(svc.submit("u-ag", "agency", STATEMENT + " Again.", SERVICE))
eq("a duplicate submit returns the SAME request", again["appeal"]["id"], A1)
ok("…marked as existing", again["existing"] is True)
eq("…and no second request was written", len([d for d in DB["role_appeals"].docs if d["uid"] == "u-ag"]), 1)


async def _both():
    return await asyncio.gather(
        svc.submit("u-host", "host", STATEMENT, SERVICE),
        svc.submit("u-host", "host", STATEMENT, SERVICE),
    )


h_a, h_b = run(_both())
eq("two submits at the same moment resolve to ONE request", h_a["appeal"]["id"], h_b["appeal"]["id"])
eq("…exactly one written", len([d for d in DB["role_appeals"].docs if d["uid"] == "u-host"]), 1)
eq("a Host request names the uid as its record", h_a["appeal"]["record_id"], "u-host")
H1 = h_a["appeal"]["id"]

el = run(apps.eligibility("u-ag"))
eq("C1: the eligibility answer shows the open request against the revoked role",
   [r["appeal"] for r in el["revoked"]], [{"id": A1, "status": "pending"}])

exc = refused("a person with no revoked role cannot file", svc.submit("u-plain", "agency", STATEMENT, SERVICE))
ok("…and is told there is nothing to reinstate", exc is not None and "no revoked Agency" in str(exc), str(exc))
refused("nor for a kind they never held revoked", svc.submit("u-ag", "host", STATEMENT, SERVICE))
exc = refused("a restricted (banned) account cannot file", svc.submit("u-banned", "seller", STATEMENT, SERVICE))
ok("…saying the restriction comes first", exc is not None and "restricted" in str(exc), str(exc))
refused("a statement under 20 characters is refused", svc.submit("u-s2", "seller", "Please.", SERVICE))
refused("an unknown kind is refused", svc.submit("u-s2", "owner", STATEMENT, SERVICE))
eq("…and none of those wrote anything", len(DB["role_appeals"].docs), 2)

mine = run(svc.list_of("u-ag"))["appeals"]
eq("the person's own list carries the request", [a["id"] for a in mine], [A1])
ok("…without naming any reviewer", all("recommendation" not in a for a in mine))

# ══════════════════════════════════════════════════════════════════════════════
print("2. Recommending — by a reviewer of that kind of role")

queue = run(svc.list_for_staff(REVIEWER))["appeals"]
ok("the reviewer's queue lists both open requests", {A1, H1} <= {a["id"] for a in queue})
refused("an account that reviews no role has no queue", svc.list_for_staff(FINANCE), kind=svc.RoleAppealForbidden)
refused("…and cannot recommend", svc.recommend(A1, "restore", NOTE, FINANCE), kind=svc.RoleAppealForbidden)

# Wrong kind: a reviewer of Coin Sellers only (no live role is cut that way
# today, so the table is narrowed for the test and put back).
_saved = R.PERMISSIONS[Role.OPS_MEMBER]
R.PERMISSIONS[Role.OPS_MEMBER] = frozenset({Permission.CAN_APPROVE_SELLER})
SELLER_REVIEWER = {"uid": "ops-m-1", "name": "Seller reviewer", "role": "ops_member", "team": "ops"}
try:
    exc = refused("a Coin Seller reviewer cannot recommend on an AGENCY request",
                  svc.recommend(A1, "restore", NOTE, SELLER_REVIEWER), kind=svc.RoleAppealForbidden)
    ok("…told it is not theirs to review", exc is not None and "Agency" in str(exc), str(exc))
    ok("…while a Coin Seller request IS theirs", svc.may_review(SELLER_REVIEWER, "seller"))
finally:
    R.PERMISSIONS[Role.OPS_MEMBER] = _saved

refused("a note under 10 characters is refused", svc.recommend(A1, "restore", "ok", REVIEWER))
refused("an unknown outcome is refused", svc.recommend(A1, "approve", NOTE, REVIEWER))
rec = run(svc.recommend(A1, "restore", NOTE, REVIEWER))
eq("a reviewer of the kind recommends", rec["appeal"]["status"], "recommended")
eq("…recorded with who and what", (rec["appeal"]["recommendation"]["by_uid"],
   rec["appeal"]["recommendation"]["outcome"]), ("ops-1", "restore"))
ok("…the Owners are notified on the audit log",
   any(e["action"] == "role_appeal.recommended" and e["subject_id"] == A1 for e in AUDIT))
eq("…and by email through the delivery log",
   [d["to"] for d in DB[C.EMAIL_DELIVERIES].docs if d["kind"] == "role_appeal.recommended"],
   ["owner@zipper.test"])
ok("…the response says what was tried", rec["owner_notified"]["email"].get("outcomes"))

# ══════════════════════════════════════════════════════════════════════════════
print("3. Deciding — the Owner only, on the same record")

exc = refused("a non-Owner cannot decide", svc.decide(A1, "restore", NOTE, REVIEWER), kind=svc.RoleAppealForbidden)
eq("…with the Owner sentence", str(exc), "Only the Owner can decide a reinstatement.")
eq("…and the role is still revoked", record("AG")["status"], "revoked")
try:
    run(router.decide_role_appeal(A1, router.AppealVerdict(outcome="restore", note=NOTE), user=REVIEWER))
    route_status = None
except Exception as e:  # noqa: BLE001
    route_status = getattr(e, "status_code", None)
eq("…and through the route it is a 403", route_status, 403)

out = run(svc.decide(A1, "restore", NOTE, OWNER))
eq("the Owner restores", out["appeal"]["status"], "restored")
eq("…the SAME record id comes back", out["restored"], {"kind": "agency", "record_id": "AG"})
eq("…and that record is approved again", record("AG")["status"], "approved")
eq("…with no second agency record for the person",
   len([p for p in DB[C.PARTNERS].docs if p.get("owner_crm_uid") == "u-ag" and p["kind"] == "agency"]), 1)
eq("…and no money moved: restoring a role writes no ledger row", len(DB[C.LEDGER].docs), 0)
ok("…the lock is released", all(d["_id"] != "u-ag:agency" for d in DB["role_appeal_locks"].docs))
ok("…the person is told", any(n["type"] == "role_appeal_restored" for n in notices_for("u-ag")))
ok("…audited as restored", any(e["action"] == "role_appeal.restored" and e["subject_id"] == A1 for e in AUDIT))
refused("deciding it a second time is refused", svc.decide(A1, "keep_revoked", NOTE, OWNER),
        kind=svc.RoleAppealConflict)

hout = run(svc.decide(H1, "restore", NOTE, OWNER))
eq("a Host request restores the Host role", fs.collection("users").docs["u-host"]["isHost"], True)
eq("…from the same application, onto the same agency",
   fs.collection("agencies").document("AG-HOME").collection("agencyHosts").docs["u-host"]["applicationId"],
   "app-host")
eq("…the record named is the uid", hout["restored"]["record_id"], "u-host")

# keep_revoked keeps the history.
k = run(svc.submit("u-s2", "seller", STATEMENT, SERVICE))
K1 = k["appeal"]["id"]
kept = run(svc.decide(K1, "keep_revoked", "The chargebacks were not explained.", OWNER))
eq("keep_revoked closes the request as kept_revoked", kept["appeal"]["status"], "kept_revoked")
eq("…the role stays revoked", record("SL2")["status"], "revoked")
eq("…the history keeps both events",
   [h["event"] for h in next(d for d in DB["role_appeals"].docs if d["_id"] == K1)["history"]],
   ["submitted", "kept_revoked"])
ok("…the person is told, with the reason",
   any(n["type"] == "role_appeal_kept_revoked" and "chargebacks" in n["body"].lower() for n in notices_for("u-s2")))
# RC (confirmed): "Permit another appeal after a decision only with new
# evidence or a valid reason." Repeating the decided statement is neither.
exc = refused("…the SAME request again after the decision is refused (no new evidence or reason)",
              svc.submit("u-s2", "seller", STATEMENT, SERVICE))
ok("…saying what is needed", exc is not None and "new evidence" in str(exc), str(exc))
k2 = run(svc.submit("u-s2", "seller",
                    "Since the decision I have repaid every chargeback in full; the bank receipts are with support.",
                    SERVICE))
ok("…and a later request with a NEW reason is a NEW one, the old one kept as history",
   k2["appeal"]["id"] != K1 and k2["existing"] is False)
eq("…the decided request is untouched", next(d for d in DB["role_appeals"].docs if d["_id"] == K1)["status"],
   "kept_revoked")

# A restore the existing rules refuse leaves the request open.
user("u-later")
partner("SL-later", "u-later", "seller", status="revoked", revoked_at=NOW)
partner("AG-later", "u-later", "agency")
L1 = run(svc.submit("u-later", "seller", STATEMENT, SERVICE))["appeal"]["id"]
fs.collection("users").docs["u-later"].update({"isSuspended": True, "isBanned": True, "accountState": "suspended"})
exc = refused("restoring onto an account restricted since filing is refused", svc.decide(L1, "restore", NOTE, OWNER))
ok("…naming the restriction", exc is not None and "restricted" in str(exc), str(exc))
left = next(d for d in DB["role_appeals"].docs if d["_id"] == L1)
eq("…the request stays open", left["status"], "pending")
eq("…and its decision lease was given back", left.get("deciding_token"), None)
eq("…the role stays revoked", record("SL-later")["status"], "revoked")

# ══════════════════════════════════════════════════════════════════════════════
if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED\n")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} reinstatement checks passed.")
print("  · filed only for a revoked role on an unrestricted account; idempotent under a race")
print("  · recommended by a reviewer of that kind; the Owners told by audit and email")
print("  · decided by the Owner only (403 for anyone else); the SAME record restored")
print("  · keep_revoked keeps the history; a refused restore leaves the request open\n")
