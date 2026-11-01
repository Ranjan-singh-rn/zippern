"""The seller's buyer lookup and the signup "already registered" check.

    python3 -m tests.test_buyer_lookup
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.db import firebase as firebase_mod  # noqa: E402
from app.services import users as svc  # noqa: E402

fs = FakeFirestore()
firebase_mod.firestore_client = lambda: fs  # type: ignore[assignment]
run = asyncio.run
checks = 0
failures: list[str] = []


def eq(claim, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


U = fs.collection("users").docs
U["u-tan"] = {"name": "Tanishque", "email": "tanishque50@gmail.com", "phoneNumber": "+919876543210",
              "phoneKey": "919876543210"}
U["u-gone"] = {"name": "Gone", "email": "gone@x.test", "isDeleted": True}

print("\n1. Buyer lookup — exact, masked")
r = run(svc.lookup_buyers("tanishque50@gmail.com"))
eq("by exact email", [x["uid"] for x in r], ["u-tan"])
eq("…email masked", r[0]["email"], "ta•••@gmail.com")
eq("…phone masked", r[0]["phone"], "•••••3210")
eq("email is case-insensitive", [x["uid"] for x in run(svc.lookup_buyers("Tanishque50@gmail.com"))], ["u-tan"])
eq("by uid", [x["uid"] for x in run(svc.lookup_buyers("u-tan"))], ["u-tan"])
eq("by phone number", [x["uid"] for x in run(svc.lookup_buyers("+91 98765 43210"))], ["u-tan"])
eq("no partial match (no browsing)", run(svc.lookup_buyers("tanishque")), [])
eq("deleted accounts are not offered", run(svc.lookup_buyers("gone@x.test")), [])
eq("too short → nothing", run(svc.lookup_buyers("ab")), [])

print("2. Registration availability — per field, role only")
A = fs.collection("agencies").docs
S = fs.collection("sellers").docs
A["ag1"] = {"ownerEmail": "owner@x.test", "ownerPhone": "+919000000001", "status": "approved"}
A["ag-rej"] = {"ownerEmail": "rejected@x.test", "ownerPhone": "+919000000009", "status": "rejected"}
S["s1"] = {"email": "seller@x.test", "phone": "9000000002", "status": "pending"}
eq("an agency email", run(svc.registration_availability("Owner@x.test", "")), {"email": "agency", "phone": None})
eq("an agency phone (E.164)", run(svc.registration_availability("", "+91 90000 00001")), {"email": None, "phone": "agency"})
eq("a seller phone stored without the code", run(svc.registration_availability("", "+919000000002")),
   {"email": None, "phone": "seller"})
eq("a seller email", run(svc.registration_availability("seller@x.test", "")), {"email": "seller", "phone": None})
eq("a rejected application does not block", run(svc.registration_availability("rejected@x.test", "+919000000009")),
   {"email": None, "phone": None})
eq("unknown → free", run(svc.registration_availability("new@x.test", "+447700900123")), {"email": None, "phone": None})
# UGP-G (I-5): the seller signup asks about Coin Sellers ONLY. An address held
# by an Agency must not read as "already a seller" (Agency + Seller is allowed),
# and an address that IS a seller must not be hidden behind an agency match.
A["ag-both"] = {"ownerEmail": "both@x.test", "ownerPhone": "+919000000077", "status": "approved"}
S["s-both"] = {"email": "both@x.test", "phone": "9000000078", "status": "approved"}
eq("kind=seller: an agency-only address is free for a seller",
   run(svc.registration_availability("owner@x.test", "", "seller")), {"email": None, "phone": None})
eq("kind=seller: a seller address is taken", run(svc.registration_availability("seller@x.test", "", "seller")),
   {"email": "seller", "phone": None})
eq("unfiltered, an address on both answers agency first (unchanged)",
   run(svc.registration_availability("both@x.test", "")), {"email": "agency", "phone": None})
eq("kind=seller sees the seller behind it", run(svc.registration_availability("both@x.test", "", "seller")),
   {"email": "seller", "phone": None})

if failures:
    print(f"\n{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"\nAll {checks} buyer-lookup checks passed.")
