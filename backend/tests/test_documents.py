"""Who gets a signed URL, and for which document.

This service exists because every KYC and identity document in the product was
stored as the string `getDownloadURL()` returned — a permanent
`?alt=media&token=` bearer credential that Storage Rules are never consulted
for. The questions worth asserting are therefore:

  * does the stored permanent URL ever leave the service? (it must not)
  * is every record authorised on its own, including inside a batch?
  * does a partner reach exactly its own records and nothing beside them?
  * does `slots` actually narrow what gets signed, or is it decoration?

The last one matters more than it looks. A list view asking for fifty
reference photographs that also signs a hundred and fifty KYC documents is
not just slow — it is signing identity documents nobody asked to see.

REAL: `app.services.documents`, imported and called.
FAKE: Firestore (`tests/fakes.FakeFirestore`) and `_sign`, which is replaced
      by a marker so a signed URL is distinguishable from a stored one.

    python3 -m tests.test_documents
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from tests.fakes import FakeFirestore  # noqa: E402

from app.core.roles import Role  # noqa: E402
from app.db import firebase as fb  # noqa: E402
from app.services import documents as svc  # noqa: E402

checks = 0
failures = 0


def ok(claim, cond):
    global checks, failures
    checks += 1
    if not cond:
        failures += 1
        print(f"  FAIL  {claim}")


def eq(claim, got, want):
    global checks, failures
    checks += 1
    if got != want:
        failures += 1
        print(f"  FAIL  {claim}\n        got {got!r}\n        want {want!r}")


# ── The world ───────────────────────────────────────────────────────────────

STORED_AADHAAR = "https://firebasestorage.googleapis.com/v0/b/b/o/kyc%2FAG7%2Fapplications%2Fd1?alt=media&token=SECRET-1"
STORED_PHOTO = "https://firebasestorage.googleapis.com/v0/b/b/o/hostPhotos%2FAG7%2Fp?alt=media&token=SECRET-2"
STORED_PROOF = "https://firebasestorage.googleapis.com/v0/b/b/o/coinPurchaseProofs%2FS1%2Fp?alt=media&token=SECRET-3"

store = FakeFirestore()
store.collection("hostApplications").document("H1").set({
    "kycDocUrls": [STORED_AADHAAR, "", ""],
    "photoUrl": STORED_PHOTO,
})
store.collection("hostApplications").document("H2").set({
    "kycDocUrls": [], "photoUrl": STORED_PHOTO,
})
store.collection("agencies").document("AG7").set({"kycDocUrls": [STORED_AADHAAR]})
store.collection("agencies").document("AG9").set({"kycDocUrls": [STORED_AADHAAR]})
store.collection("sellers").document("S1").set({"registrationProofUrl": STORED_PROOF})
store.collection("coinPurchaseRequests").document("CP1").set({
    "sellerUid": "S1", "paymentProofUrl": STORED_PROOF,
})

fb.firestore_client = lambda: store

signed = []


def fake_sign(stored):
    """An OPAQUE marker — deliberately echoing no part of the input.

    The first version returned `f"SIGNED::{stored[-8:]}"`, which ends in the
    stored URL's own token, so the "no SECRET appears in the response" check
    failed against its own fixture. A fake that carries the secret through
    cannot be used to prove the secret does not escape.
    """
    signed.append(stored)
    return (f"SIGNED-URL-{len(signed)}", "")


svc._sign = fake_sign

ACTORS = {
    "owner": {"uid": "o", "role": str(Role.OWNER), "partner_ids": {}},
    "observer": {"uid": "ob", "role": str(Role.OBSERVER), "partner_ids": {}},
    "app_admin": {"uid": "aa", "role": str(Role.APP_ADMIN), "partner_ids": {}},
    "finance_admin": {"uid": "fa", "role": str(Role.FINANCE_ADMIN), "partner_ids": {}},
    "marketing": {"uid": "mm", "role": str(Role.MARKETING_MEMBER), "partner_ids": {}},
    "agency7": {"uid": "a7", "role": str(Role.AGENCY), "partner_ids": {"agency": "AG7"}},
    "agency9": {"uid": "a9", "role": str(Role.AGENCY), "partner_ids": {"agency": "AG9"}},
    "sellerS1": {"uid": "S1", "role": str(Role.SELLER), "partner_ids": {"seller": "S1"}},
    "sellerS2": {"uid": "S2", "role": str(Role.SELLER), "partner_ids": {"seller": "S2"}},
}

run = asyncio.get_event_loop().run_until_complete


def urls_of(result):
    return [d["url"] for d in result["documents"]]


# ── 1. The stored permanent URL never leaves ────────────────────────────────
print("\n1. The stored bearer URL never leaves the service")

res = run(svc.documents_for("host", "H1", ACTORS["owner"]))
out = repr(res)
ok("no SECRET token appears in the response", "SECRET-" not in out)
ok("no firebasestorage.googleapis.com URL appears", "firebasestorage" not in out)
ok("no alt=media appears", "alt=media" not in out)
ok("every entry is a signed marker", all(str(u).startswith("SIGNED-URL-") for u in urls_of(res)))
ok("and the label survives", any(d["label"] == "Reference photo" for d in res["documents"]))

batch = run(svc.documents_batch([{"kind": "host", "id": "H1"}], ACTORS["owner"]))
ok("the batch form leaks nothing either",
   "SECRET-" not in repr(batch) and "firebasestorage" not in repr(batch))

# ── 2. Per-record authorisation, single and batched ─────────────────────────
print("2. Authorisation is per record")

ok("an agency reads its own KYC",
   len(run(svc.documents_for("agency", "AG7", ACTORS["agency7"]))["documents"]) == 1)
try:
    run(svc.documents_for("agency", "AG9", ACTORS["agency7"]))
    ok("an agency is refused another agency's KYC", False)
except svc.DocumentForbidden:
    ok("an agency is refused another agency's KYC", True)

try:
    run(svc.documents_for("host", "H1", ACTORS["agency7"]))
    ok("an agency is refused a host application (staff-only kind)", False)
except svc.DocumentForbidden:
    ok("an agency is refused a host application (staff-only kind)", True)

try:
    run(svc.documents_for("agency", "AG7", ACTORS["marketing"]))
    ok("marketing is refused KYC", False)
except svc.DocumentForbidden:
    ok("marketing is refused KYC", True)

# The batch must not become a way around any of that.
b = run(svc.documents_batch(
    [{"kind": "agency", "id": "AG7"}, {"kind": "agency", "id": "AG9"}],
    ACTORS["agency7"],
))
eq("a batch gives an agency only its own record", sorted(b["documents"]), ["agency:AG7"])
ok("the unauthorised ref is omitted, not refused — the call still succeeded",
   "agency:AG9" not in b["documents"])

b = run(svc.documents_batch(
    [{"kind": "agency", "id": "AG7"}, {"kind": "host", "id": "H1"}],
    ACTORS["marketing"],
))
eq("marketing gets an empty batch rather than an error", b["documents"], {})

b = run(svc.documents_batch([{"kind": "host", "id": "H1"}, {"kind": "host", "id": "H2"}],
                            ACTORS["app_admin"]))
eq("a KYC reviewer gets both host records", sorted(b["documents"]), ["host:H1", "host:H2"])

# ── 3. Money evidence asks a different question ─────────────────────────────
print("3. coin_purchase is finance's, not onboarding's")

ok("finance reads a payment proof",
   len(run(svc.documents_for("coin_purchase", "CP1", ACTORS["finance_admin"]))["documents"]) == 1)
ok("the owner reads it", len(run(svc.documents_for("coin_purchase", "CP1", ACTORS["owner"]))["documents"]) == 1)
try:
    run(svc.documents_for("coin_purchase", "CP1", ACTORS["app_admin"]))
    ok("app_admin is refused — CAN_APPROVE_KYC is not the coin ledger", False)
except svc.DocumentForbidden:
    ok("app_admin is refused — CAN_APPROVE_KYC is not the coin ledger", True)

ok("the seller who filed it reads it",
   len(run(svc.documents_for("coin_purchase", "CP1", ACTORS["sellerS1"]))["documents"]) == 1)
try:
    run(svc.documents_for("coin_purchase", "CP1", ACTORS["sellerS2"]))
    ok("another seller is refused", False)
except svc.DocumentForbidden:
    ok("another seller is refused", True)

# `sellerUid` is written by the Android client, so it is compared against the
# SESSION's partner ids — forging it grants its writer nothing.
store.collection("coinPurchaseRequests").document("CP2").set({
    "sellerUid": "S2", "paymentProofUrl": STORED_PROOF,
})
try:
    run(svc.documents_for("coin_purchase", "CP2", ACTORS["sellerS1"]))
    ok("a forged sellerUid cannot widen access", False)
except svc.DocumentForbidden:
    ok("a forged sellerUid cannot widen access", True)

# ── 4. Slots narrow what is signed ──────────────────────────────────────────
print("4. `slots` narrows what gets signed")

signed.clear()
b = run(svc.documents_batch([{"kind": "host", "id": "H1", "slots": ["photo"]}],
                            ACTORS["owner"]))
eq("only the photo is signed", len(signed), 1)
eq("and it is the photo", b["documents"]["host:H1"][0]["slot"], "photo")
ok("the Aadhaar was NOT signed — a list must not sign documents it will not show",
   STORED_AADHAAR not in signed)

signed.clear()
run(svc.documents_batch([{"kind": "host", "id": "H1"}], ACTORS["owner"]))
eq("without slots, everything on the record is signed", len(signed), 2)

# ── 5. Batch hygiene ────────────────────────────────────────────────────────
print("5. Batch hygiene")

signed.clear()
b = run(svc.documents_batch(
    [{"kind": "host", "id": "H1", "slots": ["photo"]}] * 5, ACTORS["owner"]))
eq("a repeated ref is signed once", len(signed), 1)

b = run(svc.documents_batch([{"kind": "host", "id": "NOPE"}], ACTORS["owner"]))
eq("a missing record is omitted", b["documents"], {})

b = run(svc.documents_batch(
    [{"kind": "wizard", "id": "X"}, {"kind": "host"}, {"id": "H1"}, "junk", None],
    ACTORS["owner"]))
eq("malformed refs are skipped rather than raising", b["documents"], {})

try:
    run(svc.documents_batch([{"kind": "host", "id": "H1"}] * (svc.MAX_BATCH + 1),
                            ACTORS["owner"]))
    ok("an oversized batch is refused", False)
except svc.DocumentError:
    ok("an oversized batch is refused", True)

try:
    run(svc.documents_batch("not a list", ACTORS["owner"]))
    ok("a non-list is refused", False)
except svc.DocumentError:
    ok("a non-list is refused", True)

eq("an empty batch is an empty answer, not an error",
   run(svc.documents_batch([], ACTORS["owner"]))["documents"], {})

# ── 6. The single route does not leak existence ─────────────────────────────
print("6. Missing and forbidden answer the same way to an outsider")

for actor in ("agency9", "sellerS2"):
    try:
        run(svc.documents_for("agency", "AG7", ACTORS[actor]))
        ok(f"{actor} is refused AG7", False)
    except svc.DocumentForbidden:
        ok(f"{actor} is refused AG7", True)
    except svc.DocumentNotFound:
        ok(f"{actor} is refused AG7", True)

# ── Result ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\n{failures} of {checks} checks FAILED.\n")
    sys.exit(1)
print(f"\nAll {checks} document-access checks passed.")
print("  · the stored ?alt=media&token= URL never appears in a response")
print("  · a batch authorises every ref on its own and omits the rest")
print("  · money evidence asks for finance, not for the KYC capability")
print("  · `slots` really narrows signing, so a list signs one file per row\n")
