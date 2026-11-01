"""P1-E — the names-only staff roster is kept by the server, and holds no contacts.

  * mirroring a staff member writes `staffRoster/{uid}` with exactly
    uid / name / role / dept / isActive (+ updatedAt) — no phone, email, address;
  * a deactivation flips the roster's `isActive`;
  * a partner (agency / seller) is never put on the staff roster;
  * the Observer is never on it (no CRM presence);
  * a roster failure is reported in the outcome, never raised (it decides no access);
  * the rules file: crmUsers is no longer readable by every member of staff,
    staffRoster is staff-read / no-client-write.

Run:  python3 -m tests.test_p1_directory_privacy
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.fakes import FakeFirestore, install_module_stubs  # noqa: E402

install_module_stubs()

from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.services import crm_directory as crm  # noqa: E402

fs = FakeFirestore()
fb._fs = fs
fb.get_user = lambda uid: None
fb.get_user_by_email = lambda email: None

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def roster(uid: str) -> dict | None:
    snap = fs.collection("staffRoster").document(uid).get()
    return snap.to_dict() if snap.exists else None


out = crm.mirror(uid="u-ops", email="ops@x.test", name="Ops Member", role=Role.OPS_MEMBER,
                 created_by="test", phone="+919999999999")
row = roster("u-ops")
ok("a staff mirror writes the roster row", row is not None)
ok("…with only the names-only fields",
   row is not None and set(row) == {"uid", "name", "role", "dept", "isActive", "updatedAt"})
ok("…no phone, email or address", row is not None and not any(k in row for k in ("phone", "email", "personalEmail", "address")))
ok("…CRM role spelling and department", row is not None and (row["role"], row["dept"], row["isActive"]) == ("ops_member", "ops", True))
ok("the contact details stay on crmUsers", (fs.collection("crmUsers").document("u-ops").get().to_dict() or {}).get("phone") == "+919999999999")

crm.set_active(uid="u-ops", email="ops@x.test", role=Role.OPS_MEMBER, is_active=False)
ok("deactivation flips the roster", (roster("u-ops") or {}).get("isActive") is False)
crm.set_active(uid="u-ops", email="ops@x.test", role=Role.OPS_MEMBER, is_active=True)
ok("reactivation flips it back", (roster("u-ops") or {}).get("isActive") is True)

crm.mirror(uid="u-own", email="o@x.test", name="Owner", role=Role.OWNER, created_by="test")
ok("an Owner is on the roster as superadmin, no department",
   (roster("u-own") or {}).get("role") == "superadmin" and (roster("u-own") or {}).get("dept") is None)

crm.mirror(uid="observer:1", email="obs@x.test", name="Observer", role=Role.OBSERVER, created_by="test")
ok("the Observer is never on the roster", roster("observer:1") is None)

try:
    crm.mirror(uid="u-ag", email="ag@x.test", name="Agency", role=Role.AGENCY, created_by="test",
               partner_id="AG1", partner_status="approved")
except crm.DirectoryError:
    pass
ok("a partner is never on the staff roster", roster("u-ag") is None)

# A failing roster write is reported, not raised.
real = fb.firestore_client


class Boom:
    def __init__(self, inner):
        self.inner = inner

    def collection(self, name):
        if name == "staffRoster":
            raise RuntimeError("roster down")
        return self.inner.collection(name)


fb.firestore_client = lambda: Boom(fs)
try:
    o = crm.mirror(uid="u-tech", email="t@x.test", name="Tech", role=Role.TECH_MEMBER, created_by="test")
    ok("a roster failure does not fail the mirror", o.action == "written")
    ok("…and is reported in the outcome", "staffRoster/u-tech not written" in o.detail)
except Exception as exc:  # noqa: BLE001
    ok(f"a roster failure was raised: {exc}", False)
finally:
    fb.firestore_client = real

# ── The rules say so too ─────────────────────────────────────────────────────
rules = (ROOT.parent / "firestore.rules").read_text()
block = rules[rules.index("match /crmUsers/{uid} {"):]
read_rule = block[block.index("allow read:"):block.index(";", block.index("allow read:"))]
ok("crmUsers is no longer readable by every member of staff", "isStaff()" not in read_rule)
ok("…a department admin reads only their own department's members",
   "callerDept()" in read_rule and ".*_member" in read_rule)
_start = rules.index("match /staffRoster/{uid} {") + len("match /staffRoster/{uid} {")
roster_block = rules[_start:rules.index("}", _start)]
ok("staffRoster: staff read", re.search(r"allow read:\s+if isStaff\(\);", roster_block) is not None)
ok("staffRoster: no client write", re.search(r"allow write:\s+if false;", roster_block) is not None)

if failures:
    print(f"{len(failures)} of {checks} directory-privacy checks FAILED")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} P1 directory-privacy checks passed.")
