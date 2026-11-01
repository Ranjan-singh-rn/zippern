"""Every partner record held by one human, and which rules they break. READ ONLY.

    cd backend && .venv/bin/python -m scripts.inspect_partner_identity EMAIL

THIS SCRIPT WRITES NOTHING. No document is created, updated or deleted; no
claim is touched. Every call is a read.

── THE AUTHORITATIVE ROLE-COMBINATION RULES ────────────────────────────────

    Agency      + Coin Seller  ALLOWED
    Sub-agency  + Coin Seller  ALLOWED
    Agency      + Agency       FORBIDDEN
    Agency      + Sub-agency   FORBIDDEN
    An Agency may not itself become a Sub-agency.

A Sub-agency is a separate partner identity exactly one level below an
Agency — a different human. So one person holds AT MOST ONE record from the
agency family (an Agency *or* a Sub-agency, never both and never two), plus
optionally one Coin Seller.

An earlier version of this script called "one Agency plus a Sub-agency"
legitimate. It is not, and a report that blesses a violation is worse than
no report, so the rule table above is now encoded in `classify()` rather
than described in prose.

── WHY IT SEARCHES BY FIVE KEYS, NOT BY EMAIL ──────────────────────────────

A sub-agency created FOR somebody else carries THEIR email. Searching
`ownerEmail` alone would miss exactly the record this investigation is about
— "Agency: Ruhan Agency, Sub-agency: Taniya" would come back clean because
the second record says `taniya@…`.

So every record is gathered by all five identity keys a partner document can
carry — `ownerEmail`, `ownerUid`, `crmUid`, `secondRoleOwnerUid`, and for
sellers `email` — and the output says which key matched. A record found only
by `parentAgencyId` is reported separately: that is a child business owned by
a DIFFERENT human, which is the normal parent/child relationship and not a
violation.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from app.core.security import _claimed_partner_ids
from app.db import firebase, mongo
from app.db.mongo import C

AGENCY_KEYS = ("ownerEmail", "ownerUid", "crmUid", "secondRoleOwnerUid")
SELLER_KEYS = ("email", "ownerUid", "crmUid", "secondRoleOwnerUid")


def _fs():
    return firebase.firestore_client()


def _by_keys(collection: str, keys: tuple[str, ...], values: list[str]) -> dict[str, dict]:
    """Every document matching any key/value pair. `_matched_by` records which."""
    from google.cloud.firestore_v1.base_query import FieldFilter

    found: dict[str, dict] = {}
    for key in keys:
        for value in values:
            if not value:
                continue
            q = _fs().collection(collection).where(filter=FieldFilter(key, "==", value))
            for d in q.stream():
                row = found.setdefault(d.id, {**(d.to_dict() or {}), "_matched_by": []})
                row["_matched_by"].append(f"{key}={value}")
    return found


def family_of(a: dict) -> str:
    """`agency` or `sub_agency`, from the record itself."""
    if str(a.get("type", "")).strip() == "sub":
        return "sub_agency"
    if str(a.get("parentAgencyId") or "").strip():
        return "sub_agency"
    return "agency"


def classify(agencies: dict[str, dict], sellers: dict[str, dict]) -> list[str]:
    """Which rules the held combination breaks. Empty means compliant."""
    violations: list[str] = []

    mains = [i for i, a in agencies.items() if family_of(a) == "agency"]
    subs = [i for i, a in agencies.items() if family_of(a) == "sub_agency"]

    if len(mains) > 1:
        violations.append(
            f"FORBIDDEN — Agency + Agency. {len(mains)} main agencies are held by "
            f"this identity: {', '.join(mains)}. One human may hold one."
        )
    if len(subs) > 1:
        violations.append(
            f"FORBIDDEN — Sub-agency + Sub-agency. {len(subs)} sub-agencies: "
            f"{', '.join(subs)}."
        )
    if mains and subs:
        violations.append(
            f"FORBIDDEN — Agency + Sub-agency. Agency {mains[0]} and sub-agency "
            f"{subs[0]} are both held by this identity. A sub-agency is a "
            "separate partner one level below an agency, not a second record "
            "for the same human."
        )
    if len(sellers) > 1:
        violations.append(
            f"FORBIDDEN — two Coin Seller records: {', '.join(sellers)}."
        )

    # The permitted shapes, stated so a clean run says so rather than staying silent.
    if not violations:
        held = []
        if mains:
            held.append("Agency")
        if subs:
            held.append("Sub-agency")
        if sellers:
            held.append("Coin Seller")
        violations.append(f"COMPLIANT — holds {' + '.join(held) or 'nothing'}.")
    return violations


def _show_agency(aid: str, a: dict, resolved: str) -> None:
    fam = family_of(a).replace("_", "-").upper()
    mark = "   <<< the session resolves to THIS one" if aid == resolved else ""
    print(f"\n  [{fam}] agencies/{aid}{mark}")
    print(f"    agencyName         : {a.get('agencyName', '—')}")
    print(f"    type / parent      : {a.get('type', '—')} / {a.get('parentAgencyId') or '—'}")
    print(f"    source             : {a.get('source', '—')}")
    print(f"    status / kycStatus : {a.get('status', '—')} / {a.get('kycStatus', '—')}")
    print(f"    isActive           : {a.get('isActive')}")
    print(f"    ownerEmail         : {a.get('ownerEmail', '—')}")
    print(f"    ownerUid / crmUid  : {a.get('ownerUid') or '—'} / {a.get('crmUid') or '—'}")
    print(f"    secondRoleOwnerUid : {a.get('secondRoleOwnerUid') or '—'}")
    docs = [u for u in (a.get("kycDocUrls") or []) if u]
    print(f"    kycDocUrls         : {len(docs)} document(s)")
    print(f"    createdAt          : {a.get('createdAt', '—')}")
    print(f"    MATCHED BY         : {', '.join(a.get('_matched_by', []))}")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("email", nargs="?", default="ruhanmittal2001@gmail.com")
    args = ap.parse_args()
    email = args.email.strip().lower()

    firebase.init()
    await mongo.connect()
    try:
        print("\n" + "=" * 78)
        print(f"PARTNER IDENTITY — {email}   (read only)")
        print("=" * 78)

        from firebase_admin import auth as fb_auth

        uid = ""
        try:
            u = fb_auth.get_user_by_email(email)
            claims = dict(u.custom_claims or {})
            uid = u.uid
            print(f"\nFIREBASE AUTH   uid = {uid}")
            print(f"  providers     : {', '.join(p.provider_id for p in u.provider_data) or '—'}")
            print(f"  custom claims : role={claims.get('role', '—')}  aid={claims.get('aid', '—')}")
        except Exception as exc:  # noqa: BLE001
            print(f"\nFIREBASE AUTH   no account for this address ({exc})")

        crm_snap = _fs().collection("crmUsers").document(uid).get() if uid else None
        crm: dict[str, Any] = (
            (crm_snap.to_dict() or {}) if crm_snap is not None and crm_snap.exists else {}
        )
        resolved = _claimed_partner_ids(crm) if crm else {}
        print(f"\ncrmUsers/{uid or '?'}")
        if not crm:
            print("  ABSENT")
        else:
            print(f"  role / roles       : {crm.get('role', '—')} / {crm.get('roles') or '—'}")
            print(f"  roleStatus         : {crm.get('roleStatus') or '—'}")
            print(f"  agencyId / sellerId: {crm.get('agencyId') or '—'} / {crm.get('sellerId') or '—'}")
        print(f"\n  → session partner_ids = {resolved or '{}'}")
        print("    (the ONLY thing document access is scoped by)")

        ids = [email, uid]
        agencies = _by_keys("agencies", AGENCY_KEYS, ids)
        sellers = _by_keys("sellers", SELLER_KEYS, ids)

        print("\n" + "-" * 78)
        print(f"AGENCY-FAMILY RECORDS HELD BY THIS IDENTITY  →  {len(agencies)}")
        print("-" * 78)
        for aid, a in agencies.items():
            _show_agency(aid, a, resolved.get("agency", ""))
        if not agencies:
            print("  (none)")

        print("\n" + "-" * 78)
        print(f"COIN SELLER RECORDS HELD BY THIS IDENTITY  →  {len(sellers)}")
        print("-" * 78)
        for sid, s in sellers.items():
            mark = "   <<< the session resolves to THIS one" if sid == resolved.get("seller") else ""
            print(f"\n  sellers/{sid}{mark}")
            print(f"    displayName        : {s.get('displayName', '—')}")
            print(f"    source             : {s.get('source', '—')}")
            print(f"    status / approved  : {s.get('status', '—')} / {s.get('isApproved')}")
            print(f"    ownerUid / crmUid  : {s.get('ownerUid') or '—'} / {s.get('crmUid') or '—'}")
            proof = str(s.get("registrationProofUrl") or "")
            idd = [d for d in (s.get("idDocUrls") or []) if d]
            print(f"    registrationProof  : {'present' if proof else 'EMPTY'}")
            print(f"    idDocUrls          : {len(idd)} document(s)")
            print(f"    MATCHED BY         : {', '.join(s.get('_matched_by', []))}")
            if not proof and not idd:
                print("      → no documents. A record created by the second-capability")
                print("        form writes registrationProofUrl:'' and collects no files.")
        if not sellers:
            print("  (none)")

        # Children of this identity's agency. A different human — shown so the
        # report is complete, and explicitly NOT counted as a violation.
        children: dict[str, dict] = {}
        for aid in agencies:
            children.update(_by_keys("agencies", ("parentAgencyId",), [aid]))
        for held in agencies:
            children.pop(held, None)
        if children:
            print("\n" + "-" * 78)
            print(f"SUB-AGENCIES PARENTED BY THIS IDENTITY'S AGENCY  →  {len(children)}")
            print("  (separate humans one level below — NOT a rule violation)")
            print("-" * 78)
            for cid, c in children.items():
                print(f"  agencies/{cid}  {c.get('agencyName', '—'):28} "
                      f"ownerEmail={c.get('ownerEmail', '—')}")

        print("\n" + "-" * 78)
        rows = [r async for r in _partner_rows(email)]
        print(f"MONGO `partners` ROWS  →  {len(rows)}")
        print("-" * 78)
        for r in rows:
            print(f"  kind={str(r.get('kind', '—')):10} id={str(r.get('_id', '—')):26} "
                  f"status={r.get('status', '—')}")
        if not rows:
            print("  (none — an external session is built from these)")

        print("\n" + "=" * 78)
        print("RULE CHECK")
        print("=" * 78)
        for line in classify(agencies, sellers):
            print(f"  {line}")

        print("\nNothing was written.")
        print("=" * 78 + "\n")
        return 0
    finally:
        await mongo.disconnect()


async def _partner_rows(email: str):
    async for r in mongo.get_db()[C.PARTNERS].find({"email": email}):
        yield r


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
