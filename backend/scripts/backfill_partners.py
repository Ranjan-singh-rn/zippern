"""Create the missing partner records for agencies and sellers already in Firestore.

    python -m scripts.backfill_partners              # dry run
    python -m scripts.backfill_partners --confirm    # write them
    python -m scripts.backfill_partners --kind seller --confirm
    python -m scripts.backfill_partners --limit 25

Nothing ever inserted into Mongo's `partners` collection, so every agency and
seller registered before this exists in Firestore and nowhere else. They cannot
be funded, lent to, paid commission or paid out — every one of those flows looks
the partner up by the Firestore document id and finds nothing.

This walks the Firestore `agencies` and `sellers` collections and creates the
record for anything that has none, through the same
`partner_ops.ensure_partner_record` the API uses. So:

  * every partner is created **holding nothing** — zero coins, zero credit, zero
    commission, zero cash. An opening load is a separate signed card, and this
    script never mints one;
  * the record is created **pending**, not approved. Backfilling a record is not
    an onboarding decision, and a partner that was never approved must not
    become approved because a script ran. Where Firestore already says the
    partner is approved that is reported below as a **mismatch to resolve**,
    with the approval left to a person;
  * it is safe to run twice. A partner that already has a record is skipped and
    nothing about it is touched — not its balances, not its status.

Dry run by default. Nothing is written without `--confirm`.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase, mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402
from app.services import partner_ops as ops  # noqa: E402
from app.services.partners import PartnerKind, PartnerStatus  # noqa: E402

# The unattended credential this script wears in the audit log. `system` is
# deliberately not a `Role` (see app/core/roles.py) — it is a label, not an
# identity that can sign in, and every authority predicate answers "no" for it.
ACTOR = {
    "uid": "system:backfill_partners",
    "name": "scripts/backfill_partners.py",
    "role": "system",
    "team": None,
}

REASON = (
    "Backfill — this partner existed in Firestore with no business record, so "
    "no money could move on it. Created at zero, pending approval."
)

COLLECTIONS = {
    "agencies": (ops.FS_AGENCIES,),
    "sellers": (ops.FS_SELLERS,),
    "all": (ops.FS_AGENCIES, ops.FS_SELLERS),
}


def arg(flag: str, default: str = "") -> str:
    """`--flag value` or `--flag=value`."""
    for i, item in enumerate(sys.argv):
        if item == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if item.startswith(f"{flag}="):
            return item.split("=", 1)[1]
    return default


def scan(collection: str, limit: int) -> list[tuple[str, dict]]:
    """Every document in one Firestore collection, id first. Blocking."""
    client = firebase.firestore_client()
    query = client.collection(collection)
    if limit:
        query = query.limit(limit)
    return [(snap.id, snap.to_dict() or {}) for snap in query.stream()]


def firestore_says_approved(collection: str, data: dict) -> bool:
    """Is this partner already live as far as Firestore is concerned?"""
    if collection == ops.FS_SELLERS:
        return bool(data.get("isApproved"))
    return str(data.get("status") or "") == "approved"


async def run() -> int:
    confirm = "--confirm" in sys.argv
    kind_arg = (arg("--kind") or "all").lower()
    if kind_arg not in COLLECTIONS:
        print(f"\n  ✗ --kind must be one of {', '.join(COLLECTIONS)}\n")
        return 1
    try:
        limit = int(arg("--limit") or 0)
    except ValueError:
        print("\n  ✗ --limit must be a whole number\n")
        return 1

    print("\n  Backfilling partner records from Firestore")
    print(f"  {'WRITING' if confirm else 'DRY RUN — nothing will be written'}")
    print(f"  Scanning: {', '.join(COLLECTIONS[kind_arg])}"
          + (f" (first {limit} each)" if limit else ""))
    print()

    firebase.init()
    await mongo.connect()
    partners = mongo.get_db()[C.PARTNERS]

    scanned = 0
    present = 0
    would_create: list[tuple[str, str, str]] = []   # id, kind, name
    created: list[tuple[str, str, str]] = []
    refused: list[tuple[str, str]] = []             # id, why
    warned: list[tuple[str, str]] = []              # id, warning
    mismatched: list[tuple[str, str, str]] = []     # id, name, mongo status

    for collection in COLLECTIONS[kind_arg]:
        try:
            docs = await asyncio.to_thread(scan, collection, limit)
        except Exception as exc:  # noqa: BLE001
            print(f"    ✗ {collection} could not be read: {exc}")
            print("      Nothing from this collection was backfilled.\n")
            continue

        print(f"    {collection} — {len(docs)} document(s)")
        for doc_id, data in docs:
            scanned += 1
            existing = await partners.find_one({"_id": doc_id})
            if existing is not None:
                present += 1
                if (
                    firestore_says_approved(collection, data)
                    and existing.get("status") != str(PartnerStatus.APPROVED)
                ):
                    mismatched.append(
                        (doc_id, existing.get("name", ""), str(existing.get("status")))
                    )
                continue

            name = ops._derive_name(collection, data)
            kind = ops._derive_kind(collection, data)

            if not confirm:
                would_create.append((doc_id, str(kind), name))
                if firestore_says_approved(collection, data):
                    mismatched.append((doc_id, name, "would be created as pending"))
                print(f"      + {doc_id}  {kind}  {name or '(no name)'}")
                continue

            try:
                # A MIRROR, not a creation: represent what exists, duplicates
                # included, so they can be seen and corrected. This is the one
                # caller allowed to switch the rule off.
                _, made, warnings = await ops.ensure_partner_record(
                    doc_id, ACTOR, REASON, enforce_role_family=False
                )
            except ops.PartnerOpsError as exc:
                refused.append((doc_id, str(exc)))
                print(f"      ✗ {doc_id}  {exc}")
                continue

            if made:
                created.append((doc_id, str(kind), name))
                print(f"      + {doc_id}  {kind}  {name or '(no name)'}")
                if firestore_says_approved(collection, data):
                    mismatched.append((doc_id, name, "created as pending"))
            else:
                # Created between the read and the write, or by a parallel run.
                present += 1
            for warning in warnings:
                warned.append((doc_id, warning))

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n  ── Summary ──")
    print(f"    Firestore documents scanned      {scanned}")
    print(f"    already had a partner record     {present}")
    if confirm:
        print(f"    partner records created          {len(created)}")
        print(f"    refused                          {len(refused)}")
    else:
        print(f"    would be created                 {len(would_create)}")

    by_kind: dict[str, int] = {}
    for _, kind, _ in (created if confirm else would_create):
        by_kind[kind] = by_kind.get(kind, 0) + 1
    for kind in (PartnerKind.AGENCY, PartnerKind.SUB_AGENCY, PartnerKind.SELLER):
        if by_kind.get(str(kind)):
            print(f"      · {kind:<12} {by_kind[str(kind)]}")

    if warned:
        print("\n  Created, with something worth knowing")
        for doc_id, warning in warned:
            print(f"    · {doc_id}: {warning}")

    if refused:
        print("\n  Refused — these still have no business record")
        for doc_id, why in refused:
            print(f"    ✗ {doc_id}: {why}")

    if mismatched:
        print("\n  Approved in Firestore, not approved in Mongo")
        print("    A backfill creates a record; it does not make an onboarding")
        print("    decision. These are live to the app but cannot move money")
        print("    until somebody approves them in the CRM, which is where that")
        print("    decision belongs — and where it gets a reason and an audit entry.")
        for doc_id, name, state in mismatched:
            print(f"    · {doc_id}  {name or '(no name)'}  — {state}")

    if confirm:
        print(f"\n  Created {len(created)} partner record(s), each holding nothing.")
        print("  No coins, no credit, no commission. An opening load is a card.")
        print("  Running this again is safe: everything above is now skipped.\n")
    else:
        print(f"\n  {len(would_create)} partner record(s) would be created.")
        print("\n  To write them:")
        print("    python -m scripts.backfill_partners --confirm\n")

    await mongo.disconnect()
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
