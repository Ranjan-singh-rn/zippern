"""Clear test data from Firestore, keeping the content you built.

    python -m scripts.reset_firestore            # dry run — shows what would go
    python -m scripts.reset_firestore --confirm  # ask for the confirmation phrase
                                                 # and then delete

Deliberately built around an explicit KEEP list rather than a delete list: a
collection nobody thought about is kept, not destroyed. Getting that backwards
is how content disappears.

Nothing here touches MongoDB. To reset the ledger and audit log, drop the
`zipper` database in Atlas separately — and think twice, because the audit log
is meant to be permanent.

── WHAT CHANGED, AND WHY ────────────────────────────────────────────────────

This script used to delete `crmUsers` and `users` **wholesale**, sparing
nobody — so a run took the owners' CRM logins and the observer with it, and the
only way back was `scripts.seed_accounts`. `scripts/reset_test_data.py`, which
does a bigger job, has always spared them. Two scripts against one Firestore
disagreeing about whether the owners survive is not a difference in scope; it is
one of them being wrong.

So two things are different:

  * **The owners and the observer are spared**, by uid, in `crmUsers` and
    `users` — the same protection list `reset_test_data.py` uses, imported from
    it rather than copied. One list, one place to add somebody.
  * **`--confirm` is no longer enough.** It now asks for a typed phrase naming
    the project, because this is irreversible, because `appConfig` goes with it,
    and because `--confirm` on its own is one arrow-up away in a shell history.
    A non-interactive run cannot supply the phrase and is refused, which is the
    right answer for a destructive script reached from a pipeline by accident.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase  # noqa: E402

# The protection list, and the collections it applies to, come from the sibling
# script rather than being restated here. A second copy would be a second thing
# to remember when an owner joins, and the copy nobody updates is the one that
# deletes them.
from scripts.reset_test_data import (  # noqa: E402
    SPARED_BY_UID,
    _kept_uids,
    _protected_emails,
)

# ── Content you built — never deleted ─────────────────────────────────────────

KEEP = {
    "gifts",     # gift catalogue — 10 items you built
    "bagItems",  # frames, entrances, chat bubbles, profile cards — 34 items
}

# Everything else goes, including configuration, so it can be rebuilt
# deliberately rather than inherited. Two consequences worth knowing:
#
#   crmUsers  — emptied EXCEPT the owners and the observer, so the CRM is still
#               reachable afterwards. Everybody else's account goes and is
#               recreated by inviting them again.
#   appConfig — wiped, which takes the economy rates and payment credentials
#               with it. Both are in the backup, and both should be re-entered
#               deliberately so the numbers are ones you chose today.

# ── Test data — cleared with --confirm ────────────────────────────────────────

CLEAR = [
    # Configuration — rebuilt deliberately after the reset
    "appConfig",
    "paymentConfig",
    "rechargePackages",
    "diamondPacks",
    "coinPackages",
    "levelConfig",
    "contentConfig",
    "policies",
    "crmUsers",
    # Test data
    "users",
    "agencies",
    "sellers",
    "hostApplications",
    "kycSubmissions",
    "liveRooms",
    "rechargeRequests",
    "coinPurchaseRequests",
    "approvalRequests",
    "withdrawalRequests",
    "salaryRequests",
    "weeklyPayoutReports",
    "hostPayouts",
    "platformRevenue",
    "platformStats",
    "supportTickets",
    "feedbackTickets",
    "techTickets",
    "opsTickets",
    "reports",
    "bannedDevices",
    "broadcasts",
    "verifiedIdentities",
    "gamingBets",
    "giftEvents",
    "callHistory",
    "chats",
    "notifications",
]

#: What has to be typed before anything is deleted. Named after the thing being
#: destroyed rather than being a yes/no, so it cannot be answered by reflex and
#: cannot be satisfied by a stray newline on a pipe.
CONFIRMATION_PHRASE = "DELETE FIRESTORE"


def delete_collection(
    name: str, dry_run: bool, keep_ids: set[str] = frozenset(), batch_size: int = 400
) -> int:
    """Delete every document in a collection, in batches, sparing `keep_ids`.

    `keep_ids` is why the loop below re-reads rather than paging: a spared
    document stays in the collection, so `col.limit(n)` would hand back the same
    protected rows for ever once everything else was gone. The exit condition is
    "this page contained nothing deletable", not "this page was short".
    """
    fs = firebase.firestore_client()
    col = fs.collection(name)
    total = 0

    while True:
        page = list(col.limit(batch_size).stream())
        if not page:
            break
        docs = [d for d in page if d.id not in keep_ids]
        if dry_run:
            # Count without deleting. Stop after one page — enough to report.
            return len([d for d in col.limit(1000).stream() if d.id not in keep_ids])
        if not docs:
            break
        batch = fs.batch()
        for d in docs:
            batch.delete(d.reference)
        batch.commit()
        total += len(docs)
        if len(page) < batch_size:
            break

    return total


def count_collection(name: str) -> int:
    try:
        return len(list(firebase.firestore_client().collection(name).limit(5000).stream()))
    except Exception:  # noqa: BLE001
        return -1


def backup_exists() -> Path | None:
    root = Path(__file__).resolve().parents[1] / "backups"
    if not root.exists():
        return None
    runs = sorted(p for p in root.iterdir() if p.is_dir() and p.name.startswith("firestore-"))
    return runs[-1] if runs else None


def _confirmed() -> bool:
    """Ask for the phrase. Anything else — including a closed stdin — stops.

    `EOFError` is treated as a refusal rather than as an empty answer. A script
    that deletes a Firestore project when its stdin happens not to be a terminal
    is a script that will one day be run from CI by somebody who meant to run the
    dry run.
    """
    print()
    print("  This permanently deletes the collections listed above, including")
    print("  appConfig — the commission slabs, the bean rate, the diamond price")
    print("  and the bank account sellers pay into. It cannot be undone.")
    try:
        typed = input(f"  Type {CONFIRMATION_PHRASE} to continue: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n  No confirmation was given. Nothing was written.\n")
        return False
    if typed != CONFIRMATION_PHRASE:
        print("\n  Stopped. Nothing was written.\n")
        return False
    return True


def main() -> int:
    confirm = "--confirm" in sys.argv
    dry_run = not confirm

    # Refuse to delete without a backup. Losing content because nobody ran the
    # export first is the failure this whole script exists to avoid.
    latest = backup_exists()
    if confirm and latest is None:
        print(
            "\n  ✗ No backup found in backend/backups/.\n\n"
            "    Take one first — it is read-only and takes seconds:\n"
            "      python -m scripts.backup_firestore\n"
        )
        return 1
    if latest:
        print(f"\n  Most recent backup: {latest.name}")

    firebase.init()

    # The owners and the observer. Resolved before anything is counted, so the
    # figures printed below are the ones that would actually be deleted.
    #
    # `_kept_uids` reads Mongo as well as Firebase Auth — a staff row is one of
    # the four places a protected uid can be found, and the only one that finds
    # an account whose Auth record has gone. It is `async` for that reason alone;
    # this script is otherwise synchronous and stays that way.
    import asyncio

    from app.db import mongo

    async def _resolve_protected() -> set[str]:
        protected = _protected_emails([])
        await mongo.connect()
        try:
            return await _kept_uids(protected, mongo.get_db())
        finally:
            await mongo.disconnect()

    try:
        keep_ids = asyncio.run(_resolve_protected())
    except SystemExit:
        # `_protected_emails` exits 2 when the owner list cannot be read. That is
        # the one failure that must not be downgraded into "spare nobody".
        raise
    except Exception as exc:  # noqa: BLE001
        print(
            f"\n  ✗ The owner and observer accounts could not be resolved ({exc}).\n"
            "    Refusing to continue: this run would delete the logins it is\n"
            "    supposed to spare.\n"
        )
        return 2

    print("\n  KEEPING (your content, never touched)")
    kept_total = 0
    for name in sorted(KEEP):
        n = count_collection(name)
        kept_total += max(n, 0)
        marker = "" if n > 0 else "   ← empty"
        print(f"    · {name}: {n if n >= 0 else '?'} document(s){marker}")

    print(
        f"\n  KEEPING (the owners and the observer — {len(keep_ids)} account id(s))"
    )
    print(f"    · spared by id in: {', '.join(n for n in SPARED_BY_UID if n in CLEAR)}")
    if not keep_ids:
        print(
            "\n  ⚠  No owner or observer account was found. Every crmUsers and\n"
            "     users document will go, and nobody will be able to sign in to\n"
            "     the CRM until scripts.seed_accounts has been run again. Check\n"
            "     you are pointed at the right project before going further."
        )

    if kept_total == 0:
        print(
            "\n  ⚠  Every protected collection is empty. Nothing is being preserved\n"
            "     because there is nothing there. If you expected gifts or bag items\n"
            "     to exist, they are not in this Firestore project — check you are\n"
            "     pointed at the right one before going further."
        )

    # Anything present that neither list mentions — surfaced so it is a decision,
    # not an accident.
    known = KEEP | set(CLEAR)
    try:
        others = [
            c.id
            for c in firebase.firestore_client().collections()
            if c.id not in known
        ]
    except Exception:  # noqa: BLE001
        others = []
    if others:
        print("\n  NOT IN EITHER LIST (kept by default — tell me if any should go)")
        for name in sorted(others):
            print(f"    · {name}: {count_collection(name)} document(s)")

    print(f"\n  {'WOULD CLEAR' if dry_run else 'CLEARING'} (test data)")

    # Counted first, in full, and only then deleted — so the confirmation is
    # given against the real figures rather than against a promise.
    planned: list[tuple[str, int]] = []
    for name in CLEAR:
        if name in KEEP:
            continue
        spare = keep_ids if name in SPARED_BY_UID else set()
        try:
            count = delete_collection(name, True, spare)
        except Exception as exc:  # noqa: BLE001
            print(f"    ⚠  {name}: {exc}")
            continue
        planned.append((name, count))
        if count:
            print(f"    · {name}: {count} document(s)")
    grand = sum(c for _, c in planned)

    if dry_run:
        print(f"\n  {grand} document(s) would be deleted.")
        print("\n  Nothing has changed. To go ahead:")
        print("    python -m scripts.reset_firestore --confirm\n")
        return 0

    if grand == 0:
        print("\n  Nothing to delete.\n")
        return 0

    if not _confirmed():
        return 1

    print()
    deleted = 0
    for name, _ in planned:
        spare = keep_ids if name in SPARED_BY_UID else set()
        try:
            count = delete_collection(name, False, spare)
        except Exception as exc:  # noqa: BLE001
            print(f"    ⚠  {name}: {exc}")
            continue
        deleted += count
        if count:
            print(f"    · {name}: {count} document(s)")

    print(f"\n  Deleted {deleted} document(s).")
    print("\n  The owner and observer accounts were kept. Re-run seeding only if")
    print("  the count above said none were found —")
    print("    python -m scripts.seed_accounts\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
