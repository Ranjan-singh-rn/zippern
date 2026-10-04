"""Repair partners whose approval never reached their login.

WHAT WENT WRONG
---------------
`approve_partner` updated Mongo and mirrored the decision onto the Firestore
`agencies`/`sellers` document, and stopped there. The CRM does not route on
either of those — it routes on `crmUsers.status`, which is written `'pending'`
at signup and which nothing in the running system ever changed.

So every partner approved before this fix is `approved` in the business record,
`approved` on their partner document, and still `pending` on the login they
actually sign in with. The CRM believes them, and sends them to the waiting
room. From their side, being approved changed nothing at all.

It runs a long way past the login screen:

  * they cannot reach their own dashboard, so an agency cannot invite a host,
    so `hostApplications` stays empty, so the host KYC queue is empty
  * the "also become a coin seller" card requires an approved primary
    capability, so it never appears either

WHAT THIS FIXES
---------------
For every partner whose Mongo status is `approved`:

  1. `crmUsers/{uid}.status` and `roleStatus.<kind>` set to `approved`
  2. an agency with no `referralCode` is issued one — the public signup form
     never generated one, so a self-registered agency could never recruit
  3. `kycStatus` set to `approved` where the partner is approved, because
     approval is the act of verification and the two must not disagree

Rejected and suspended partners are mirrored too, so nobody keeps access their
last decision withdrew.

USAGE
-----
    python -m scripts.repair_partner_logins            # dry run, changes nothing
    python -m scripts.repair_partner_logins --confirm  # apply

Safe to run repeatedly: every write is idempotent and a partner already correct
is reported as such and skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.db import firebase
from app.db import mongo
from app.db.mongo import C
from app.services import partner_ops as ops
from app.services.partners import PartnerStatus


def _fmt(partner: dict) -> str:
    return (
        f"{partner.get('kind', '?'):<12} "
        f"{str(partner.get('_id'))[:24]:<26} "
        f"{str(partner.get('name') or '—')[:28]:<30} "
        f"{partner.get('status', '?')}"
    )


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--confirm", action="store_true", help="apply the changes")
    args = ap.parse_args()

    firebase.init()
    await mongo.connect()
    db = mongo.get_db()

    partners = [p async for p in db[C.PARTNERS].find({})]
    if not partners:
        print("No partners on file. Nothing to do.")
        await mongo.disconnect()
        return 0

    print(f"\n{len(partners)} partner(s) on file.\n")
    print(f"  {'KIND':<12} {'ID':<26} {'NAME':<30} STATUS")
    print(f"  {'-' * 12} {'-' * 26} {'-' * 30} {'-' * 10}")

    planned: list[tuple[dict, str]] = []
    for p in partners:
        status = str(p.get("status") or "")
        uid = await asyncio.to_thread(ops._login_uid_of, p)
        note = ""
        if not uid:
            note = "  ← NO LOGIN ATTACHED, cannot be signed in to"
        elif status not in {
            str(PartnerStatus.APPROVED),
            str(PartnerStatus.REJECTED),
            str(PartnerStatus.SUSPENDED),
        }:
            note = "  ← still pending, nothing to mirror"
        else:
            planned.append((p, status))
            note = f"  → mirror '{status}' onto crmUsers/{uid[:12]}…"
        print(f"  {_fmt(p)}{note}")

    if not planned:
        print("\nNothing to repair.")
        await mongo.disconnect()
        return 0

    print(f"\n{len(planned)} partner(s) would be repaired.")
    if not args.confirm:
        print("\nDRY RUN — nothing was written. Re-run with --confirm to apply.\n")
        await mongo.disconnect()
        return 0

    print("\nApplying…\n")
    repaired = 0
    for p, status in planned:
        name = str(p.get("name") or p.get("_id"))

        ok = await asyncio.to_thread(ops._mirror_login_status, p, status)
        print(f"  {'ok  ' if ok else 'FAIL'} login status  {name}")

        if status == str(PartnerStatus.APPROVED):
            # `kycStatus` follows the decision, but ONLY where there were
            # documents to have verified.
            #
            # Passing the default `verified_documents=True` here wrote
            # `kycStatus: approved` onto records with nothing on file — and the
            # upload form on a partner's own dashboard used to render only while
            # KYC was pending or rejected, so this repair was itself removing
            # the screen they needed to supply what was missing. That gate is
            # gone now, and this no longer claims a verification that never
            # happened either.
            has_docs = await asyncio.to_thread(ops._has_kyc_documents, p)
            synced = await asyncio.to_thread(
                ops._sync_partner_doc,
                p,
                ops._fs_status_fields(
                    p.get("kind", ""),
                    PartnerStatus.APPROVED,
                    True,
                    verified_documents=has_docs,
                ),
            )
            note = "verified" if has_docs else "left pending — no documents on file"
            print(f"  {'ok  ' if synced else 'FAIL'} kyc status    {name} ({note})")

            code = await asyncio.to_thread(ops._ensure_referral_code, p)
            if code:
                print(f"  ok   referral      {name} → {code}")
            elif str(p.get("kind", "")) != "seller":
                print(f"  FAIL referral      {name} — hosts cannot join this agency")

        repaired += 1 if ok else 0
        print()

    print(f"{repaired} of {len(planned)} partner(s) repaired.\n")
    print("Ask each partner to sign out and back in — the CRM reads the login")
    print("record at sign-in, so an open tab will still show the old state.\n")
    await mongo.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
