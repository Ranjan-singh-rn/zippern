"""Clear the Mongo balances of accounts that no longer exist.

    python -m scripts.purge_app_balances            # dry run — shows what would go
    python -m scripts.purge_app_balances --confirm  # actually delete

The other half of `functions/scripts/purge-app-users.mjs`. Run that one first:
this reads Firestore to decide who is gone, so it needs the accounts already
deleted to know which balances are orphaned.

── WHAT IT DELETES ───────────────────────────────────────────────────────────

`balances` rows for `user` holders whose `users/{uid}` document no longer
exists. Nothing else.

── WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────────────

`ledger` and `audit` are append-only and are left alone.

That is not caution for its own sake. A balance is a live figure — a row saying
somebody holds 4,000 diamonds when the account is gone is wrong, and the
nightly reconciliation will report it as drift every night until it is cleared.
A ledger row is a record that something happened, and it did happen. Deleting
it does not make the past different; it makes the past unreadable, and the two
reports built on it (`/reports/revenue` and the weekly business report) quietly
lose the movements they were summing.

If you genuinely want the history gone too — a development reset where none of
it ever meant anything — drop the `zipper` database in Atlas rather than
extending this script. Making that easy from a command line is how somebody
does it to production one day while meaning to do it to staging.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase, mongo  # noqa: E402
from app.db.mongo import C  # noqa: E402


async def run() -> int:
    confirm = "--confirm" in sys.argv
    print(
        "\n*** LIVE RUN — balances will be deleted ***\n"
        if confirm
        else "\nDRY RUN — nothing will be changed. Re-run with --confirm.\n"
    )

    # P0-10 (OPS-C): the target, named and confirmed, before anything connects.
    from app.core.destructive import DestructiveRefused, require_data_canary, require_destructive_target
    try:
        print(require_destructive_target("purge_app_balances", writes=confirm))
    except DestructiveRefused as exc:
        print(f"\n  ✗ {exc}\n")
        return 2

    firebase.init()
    await mongo.connect()
    try:
        db = mongo.get_db()
        if confirm:
            try:
                await require_data_canary(db, "purge_app_balances")
            except DestructiveRefused as exc:
                print(f"\n  ✗ {exc}\n")
                return 2
        client = firebase.firestore_client()

        rows = await db[C.BALANCES].find({"holder_type": "user"}).to_list(length=None)
        print(f"{len(rows)} user balance row(s) in Mongo.")
        if not rows:
            return 0

        # One read per holder. Slow and obvious beats clever here — this runs
        # once, by hand, and being able to see which uid was checked matters
        # more than the seconds saved.
        orphaned = []
        for row in rows:
            uid = str(row.get("holder_id") or "")
            if not uid:
                continue
            snap = await asyncio.to_thread(
                lambda u=uid: client.collection("users").document(u).get()
            )
            if not getattr(snap, "exists", False):
                orphaned.append(row)

        if not orphaned:
            print("Every balance belongs to an account that still exists. Nothing to do.\n")
            return 0

        print(f"\n{len(orphaned)} balance row(s) belong to deleted accounts:\n")
        total: dict[str, int] = {}
        for row in orphaned[:25]:
            cur = str(row.get("currency", "?"))
            amt = int(row.get("amount", 0))
            total[cur] = total.get(cur, 0) + amt
            print(f"  {row.get('holder_id')}  {amt:>12,} {cur}")
        if len(orphaned) > 25:
            print(f"  …and {len(orphaned) - 25} more")

        for row in orphaned[25:]:
            cur = str(row.get("currency", "?"))
            total[cur] = total.get(cur, 0) + int(row.get("amount", 0))
        print("\n  Totals being written off:")
        for cur, amt in sorted(total.items()):
            print(f"    {amt:>14,} {cur}")

        if not confirm:
            print("\nRe-run with --confirm to delete these rows.\n")
            return 0

        answer = input(f"\nType DELETE to remove {len(orphaned)} balance row(s): ")
        if answer.strip() != "DELETE":
            print("Not confirmed. Nothing was deleted.\n")
            return 0

        removed = 0
        for row in orphaned:
            res = await db[C.BALANCES].delete_one({"_id": row["_id"]})
            removed += res.deleted_count
        print(f"\nDeleted {removed} balance row(s). Ledger and audit untouched.\n")
        return 0
    finally:
        await mongo.disconnect()


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
