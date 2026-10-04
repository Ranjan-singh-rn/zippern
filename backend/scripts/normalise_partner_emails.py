"""Lower-case the login address on partner records that were filed with a capital.

    python -m scripts.normalise_partner_emails                  # dry run
    python -m scripts.normalise_partner_emails --confirm        # write the repairs
    python -m scripts.normalise_partner_emails --kind agencies  # one collection
    python -m scripts.normalise_partner_emails --kind sellers

`firestore.rules` binds four things to a partner's own address, and Firebase
stores the address on an ID token **lower-cased**:

  * `agencyNamesCaller()` — the agency's own `crmUsers` document may only be
    created by someone whose token email equals `agencies/{id}.ownerEmail`;
  * the `agencies` update clause that lets the applicant write the `crmUid`
    back-link, matched the same way;
  * the `agencies` read clause that lets the applicant read back the
    application they just filed, before any uid is on it;
  * `sellerNamesCaller()` and the matching `sellers` `crmUid` clause, which do
    exactly the same thing against `sellers/{id}.email`.

**The seller side has the same binding.** It was worth checking before touching
it, and the answer is that `sellers` is bound in two of the four places rather
than three — its `read` is `request.auth != null`, so a mis-cased seller can
still be read — but the two that matter are identical: a seller whose `email`
carries a capital cannot create their own `crmUsers` document and cannot write
their own `crmUid`. So both collections are in scope, and both are fixed here.

The registration forms did not lower-case the address until the fix earlier
today. Every partner registered before that whose owner typed a capital letter
has those writes denied by rule. The result is a record its own owner cannot
attach a login to and — for an agency — cannot even read: a live application
that looks completely healthy on every staff screen and is inert to the one
person it belongs to. New records are already correct; these are the ones left.

This rewrites nothing but that one field. No status, no balance, no approval,
no login — an address in the wrong case is a typo, not a decision, and nothing
else about the partner is this script's business.

  * **Collisions are reported, never resolved.** If lower-casing a record would
    make it identical to another record's address, both are printed and neither
    is touched. Two partner documents at one address is a real thing that needs
    a person: the duplicate check added earlier today
    (`zipper-crm/lib/partnerDuplicates.ts`) queries `agencies` by `ownerEmail`
    and `sellers` by `email`, and after normalisation that query starts
    returning both, which is a refusal on the registration form and a question
    somebody has to answer.
  * **There is deliberately no `--limit`.** Deciding whether a record collides
    means having read every other record in its collection; a partial scan
    could only guess, and a guess here writes a duplicate address.

Dry run by default. Nothing is written without `--confirm`.

── A NOTE ON A SEPARATE PROBLEM, WHILE YOU ARE IN HERE ───────────────────────

`/agencies/register` used to file the agency owner's plaintext CRM password on
its `approvalRequests` document as `_password`, and `onApprovalApproved` copied
it onto the `agencies` document it created. Both the form and the Cloud
Function have been fixed, and the function now strips the field from any
request still carrying it — but a request filed before the fix still holds the
password itself, and `approvalRequests` is readable by the superadmin and by
the requester. Those are live credentials and this script does not touch them.
To find them:

    from app.db import firebase
    firebase.init()
    client = firebase.firestore_client()
    for snap in client.collection("approvalRequests").stream():
        if "_password" in (snap.to_dict() or {}).get("payload", {}):
            print(snap.id, (snap.to_dict() or {}).get("description"))

Every one that prints is a password that has been readable at rest. Have the
owner of that address change it, then delete the field —
`payload._password` — from the request document.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core import audit  # noqa: E402
from app.db import firebase, mongo  # noqa: E402

# The unattended credential this script wears in the audit log. `system` is
# deliberately not a `Role` (see app/core/roles.py) — it is a label, not an
# identity that can sign in, and every authority predicate answers "no" for it.
ACTOR = {
    "uid": "system:normalise_partner_emails",
    "name": "scripts/normalise_partner_emails.py",
    "role": "system",
    "team": None,
}

REASON = (
    "Normalised — this partner's login address was stored with a capital "
    "letter, and firestore.rules matches it against the ID token address, "
    "which Firebase lower-cases. Its owner was denied their own crmUsers "
    "document and their own crmUid back-link. Only the case of the address "
    "was changed; nothing else about the partner was touched."
)

#: Collection → the field holding the address its owner signs in with.
EMAIL_FIELD = {"agencies": "ownerEmail", "sellers": "email"}

KINDS = {
    "agencies": ("agencies",),
    "sellers": ("sellers",),
    "all": ("agencies", "sellers"),
}

#: What a repair in each collection actually unblocks, in the owner's terms.
UNBLOCKS = {
    "agencies": (
        "its owner can create their crmUsers document (agencyNamesCaller), "
        "write the crmUid back-link, and read their own application"
    ),
    "sellers": (
        "its owner can create their crmUsers document (sellerNamesCaller) "
        "and write the crmUid back-link"
    ),
}


# ══════════════════════════════════════════════════════════════════════════════
#  What the survey found
# ══════════════════════════════════════════════════════════════════════════════


@dataclass(slots=True)
class Fix:
    """One record whose address is stored in the wrong case."""

    collection: str
    doc_id: str
    stored: str
    normalised: str
    #: What is standing between this partner and a working login right now.
    state: str

    @property
    def line(self) -> str:
        return (
            f"{self.collection}/{self.doc_id}  {self.stored}  →  "
            f"{self.normalised}   ({self.state})"
        )


@dataclass(slots=True)
class Blocked:
    """One record this script will not guess at."""

    collection: str
    doc_id: str
    why: str


@dataclass(slots=True)
class Survey:
    fixes: list[Fix] = field(default_factory=list)
    blocked: list[Blocked] = field(default_factory=list)
    #: collection → how many documents were read
    scanned: dict[str, int] = field(default_factory=dict)
    #: collection → how many were already lower-case
    already_lower: dict[str, int] = field(default_factory=dict)
    #: collection → how many carry no address at all
    no_address: dict[str, int] = field(default_factory=dict)


# ══════════════════════════════════════════════════════════════════════════════
#  Survey — reads both collections, writes nothing
# ══════════════════════════════════════════════════════════════════════════════


def read_collection(collection: str) -> list[tuple[str, dict]]:
    """Every document in one Firestore collection, id first. Blocking.

    Everything, with no limit, because the collision check below is only
    correct if it has seen every address in the collection.
    """
    client = firebase.firestore_client()
    return [(snap.id, snap.to_dict() or {}) for snap in client.collection(collection).stream()]


def partner_state(collection: str, data: dict) -> str:
    """Why this record is stuck, so the printed line says what the fix buys."""
    linked = str(data.get("crmUid") or "").strip()
    source = str(data.get("source") or "").strip() or "unknown source"
    if linked:
        return f"{source}, login already attached — unblocks its own reads"
    return f"{source}, no login attached — its owner cannot attach one"


async def survey(kind: str) -> Survey:
    """Compare stored addresses with their lower-cased form. This never writes."""
    found = Survey()

    for collection in KINDS[kind]:
        field_name = EMAIL_FIELD[collection]
        docs = await asyncio.to_thread(read_collection, collection)
        found.scanned[collection] = len(docs)
        found.already_lower[collection] = 0
        found.no_address[collection] = 0

        # Every address in this collection, grouped by what it normalises to.
        # A group with more than one member is where two records would end up
        # sharing an address, and that is reported rather than written.
        groups: dict[str, list[tuple[str, str]]] = {}   # normalised → [(id, stored)]
        for doc_id, data in docs:
            stored = str(data.get(field_name) or "").strip()
            if not stored:
                found.no_address[collection] += 1
                continue
            groups.setdefault(stored.lower(), []).append((doc_id, stored))

        by_id = dict(docs)
        for normalised, members in groups.items():
            needing = [(i, s) for i, s in members if s != normalised]
            if not needing:
                found.already_lower[collection] += len(members)
                continue

            if len(members) > 1:
                # Either another record already holds the lower-cased address,
                # or two mis-cased records normalise onto each other. Both mean
                # the same thing to everything that queries this field.
                held = ", ".join(f"{i} ({s})" for i, s in members)
                for doc_id, _ in needing:
                    found.blocked.append(
                        Blocked(
                            collection,
                            doc_id,
                            f"lower-casing it would make {len(members)} records share "
                            f"the address {normalised!r} — {held}. Something already "
                            "holds it, so this would create a duplicate rather than "
                            "repair anything. Decide which record is the real one "
                            "first; that is not a decision a script can make.",
                        )
                    )
                found.already_lower[collection] += len(members) - len(needing)
                continue

            doc_id, stored = needing[0]
            found.fixes.append(
                Fix(
                    collection=collection,
                    doc_id=doc_id,
                    stored=stored,
                    normalised=normalised,
                    state=partner_state(collection, by_id.get(doc_id, {})),
                )
            )

    return found


# ══════════════════════════════════════════════════════════════════════════════
#  Apply
# ══════════════════════════════════════════════════════════════════════════════


def write_field(collection: str, doc_id: str, field_name: str, value: str) -> None:
    """Rewrite one field and nothing else. Blocking."""
    client = firebase.firestore_client()
    client.collection(collection).document(doc_id).set({field_name: value}, merge=True)


async def apply(fix: Fix) -> str:
    """Normalise one address, with the audit entry that goes with it."""
    field_name = EMAIL_FIELD[fix.collection]
    await asyncio.to_thread(
        write_field, fix.collection, fix.doc_id, field_name, fix.normalised
    )
    await audit.record(
        actor=ACTOR,
        action=audit.Action.PARTNER_EMAIL_NORMALISED,
        subject_type="partner",
        subject_id=fix.doc_id,
        reason=REASON,
        before={field_name: fix.stored},
        after={field_name: fix.normalised},
        meta={
            "collection": fix.collection,
            "unblocks": UNBLOCKS[fix.collection],
        },
    )
    return f"{fix.collection}/{fix.doc_id}  {fix.stored} → {fix.normalised}"


# ══════════════════════════════════════════════════════════════════════════════
#  Command line
# ══════════════════════════════════════════════════════════════════════════════


def arg(flag: str, default: str = "") -> str:
    """`--flag value` or `--flag=value`."""
    for i, item in enumerate(sys.argv):
        if item == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if item.startswith(f"{flag}="):
            return item.split("=", 1)[1]
    return default


def report(found: Survey, confirm: bool, written: list[str]) -> None:
    print("\n  ── Summary ──")
    for collection, count in found.scanned.items():
        print(f"    {collection:<10} documents scanned      {count}")
        print(f"    {collection:<10} already lower-case     {found.already_lower[collection]}")
        if found.no_address[collection]:
            print(
                f"    {collection:<10} with no address at all {found.no_address[collection]}"
                "  (nothing to normalise)"
            )

    if confirm:
        print(f"    addresses normalised             {len(written)}")
    else:
        print(f"    addresses to normalise           {len(found.fixes)}")
    print(f"    reported, not touched            {len(found.blocked)}")

    if found.blocked:
        print("\n  Reported, not touched")
        for item in found.blocked:
            print(f"    ✗ {item.collection}/{item.doc_id}")
            print(f"        {item.why}")

    if written:
        print("\n  Written")
        for line in written:
            print(f"    + {line}")

    if confirm and written:
        print("\n  What this unblocks, for each record above:")
        for collection in sorted({f.collection for f in found.fixes}):
            print(f"    · {collection}: {UNBLOCKS[collection]}.")
        print(
            "\n  These owners could not do any of that until now, and nothing\n"
            "  told them why — the rule denied the write and the record looked\n"
            "  healthy on every staff screen. Running this again is safe: every\n"
            "  address above is now lower-case and will be skipped.\n"
        )
    elif confirm:
        print("\n  Nothing needed normalising. Every address is already lower-case.\n")
    else:
        print(f"\n  {len(found.fixes)} address(es) would be normalised. Nothing has been written.")
        if found.fixes:
            print("\n  Each one unblocks:")
            for collection in sorted({f.collection for f in found.fixes}):
                print(f"    · {collection}: {UNBLOCKS[collection]}.")
        print("\n  To write them:")
        print("    python -m scripts.normalise_partner_emails --confirm\n")


async def run() -> int:
    confirm = "--confirm" in sys.argv
    kind = (arg("--kind") or "all").lower()
    if kind not in KINDS:
        print(f"\n  ✗ --kind must be one of {', '.join(KINDS)}\n")
        return 1
    if "--limit" in " ".join(sys.argv):
        print(
            "\n  ✗ There is no --limit. Whether a record collides with another "
            "can only be\n    answered by reading every record in its "
            "collection, so a partial scan\n    could only guess — and a guess "
            "here writes a duplicate address.\n"
        )
        return 1

    print("\n  Normalising partner login addresses to lower case")
    print(f"  {'WRITING' if confirm else 'DRY RUN — nothing will be written'}")
    print(f"  Scanning: {', '.join(KINDS[kind])}")
    print()

    firebase.init()
    await mongo.connect()

    try:
        found = await survey(kind)
    except Exception as exc:  # noqa: BLE001
        print(f"    ✗ Firestore could not be read: {exc}")
        print("      Nothing was normalised.\n")
        await mongo.disconnect()
        return 1

    for fix in found.fixes:
        print(f"    {'+' if confirm else '·'} {fix.line}")

    written: list[str] = []
    if confirm:
        for fix in found.fixes:
            try:
                written.append(await apply(fix))
            except Exception as exc:  # noqa: BLE001
                found.blocked.append(
                    Blocked(
                        fix.collection,
                        fix.doc_id,
                        f"the write failed and the address is unchanged: {exc}",
                    )
                )

    report(found, confirm, written)

    await mongo.disconnect()
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
