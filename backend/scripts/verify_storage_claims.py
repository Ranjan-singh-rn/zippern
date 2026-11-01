"""Did the claims actually land? READ ONLY.

    cd backend && .venv/bin/python -m scripts.verify_storage_claims

THIS SCRIPT WRITES NOTHING. It does not import `set_custom_user_claims`, does
not call `apply_for_role`, `apply_partner` or `clear`, and has no `--apply`.
Every Firebase and Mongo call below is a read.

── WHY IT RE-DERIVES RATHER THAN HARD-CODING ────────────────────────────────

The obvious version of this script is a list of five uids and five expected
claims, typed in from the backfill's output. That checks that the output
matched itself.

This one re-runs `backfill_storage_claims.plan()` against the live Mongo
`staff` collection and the live `crmUsers` documents, and compares the plan to
what Firebase Auth actually holds. So it answers the question worth asking —
**does the token now say what the authoritative records say it should** —
and it would catch a claim applied from a stale plan, a claim edited by hand
in the console afterwards, and a staff row that changed since.

── AND WHY IT CHECKS FOR CLAIMS THAT SHOULD NOT EXIST ───────────────────────

A backfill can be wrong in two directions. Missing claims are loud: somebody
is refused a document and files a ticket. Claims on accounts that should not
carry one are silent, and they are the dangerous half — so every Firebase
account in the project is read, not only the planned ones.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.db import firebase, mongo
from scripts.backfill_storage_claims import agency_kinds, partner_docs, plan, staff_rows

#: Firebase returns at most this many accounts per page.
_PAGE = 1000


def _all_auth_uids() -> list[tuple[str, dict]]:
    """Every Firebase account and its custom claims. Read-only."""
    from firebase_admin import auth as fb_auth

    out: list[tuple[str, dict]] = []
    page = fb_auth.list_users(max_results=_PAGE)
    while page:
        for u in page.users:
            out.append((u.uid, dict(u.custom_claims or {})))
        page = page.get_next_page()
    return out


def compare(
    expected: dict[str, dict[str, str]],
    cleared: set[str],
    no_claim: list[tuple[str, str, str]],
    actual: dict[str, dict],
) -> tuple[list[str], list[tuple[str, str, str]], list[str]]:
    """Compare the plan to what Firebase Auth holds. Pure, so it is testable.

    Returns `(lines, roster, failures)` — the report body, the genuinely
    claimless identities, and anything wrong.

    ── THE DISTINCTION THAT CAUGHT ME OUT ──────────────────────────────────

    `plan()`'s `no_claim` roster is a statement about a SOURCE: "this
    `crmUsers` document yields no partner claim". It is not a statement about
    an identity. A member of staff has BOTH — a Mongo row that earns them an
    internal claim, and a mirrored `crmUsers` document carrying `superadmin`,
    which is not a partner role and so lands on the roster.

    The first version of this function read the roster as "this uid must
    carry no claim" and reported four false failures against the three
    Owners and the App Admin — accounts whose claims were correct and
    required. Production was right; the verifier was wrong.

    So the roster is filtered by `expected` here. A grant is the authoritative
    statement about an identity, and a source-level note cannot contradict it.

    Detecting claims that should NOT exist does not depend on the roster at
    all — `stray` below walks every Firebase account in the project, which is
    a stronger check and is unaffected by this distinction.
    """
    lines: list[str] = []
    failures: list[str] = []

    lines.append(f"\n── EXPECTED CLAIMS ({len(expected)}) " + "─" * 44)
    for uid, want in sorted(expected.items(), key=lambda kv: kv[1]["role"]):
        got = actual.get(uid)
        if got is None:
            lines.append(f"  MISSING  {uid:30} no Firebase account")
            failures.append(f"{uid}: expected a claim but has no Firebase account")
            continue
        have = {"role": got.get("role", ""), "aid": got.get("aid", "")}
        if have == want:
            lines.append(
                f"  OK       {uid:30} role={have['role']:16} aid={have['aid'] or '—'}"
            )
        else:
            lines.append(f"  MISMATCH {uid:30} role={have['role'] or '—':16} aid={have['aid'] or '—'}")
            lines.append(f"           expected role={want['role'] or '—'} aid={want['aid'] or '—'}")
            failures.append(f"{uid}: expected {want}, found {have}")
        extra = sorted(set(got) - {"role", "aid"})
        if extra:
            lines.append(f"           also carries (not ours, preserved): {extra}")

    # Every Firebase account outside the plan. This is the check that finds a
    # privileged claim nobody intended — it needs no roster and no allowlist.
    lines.append("\n── UNEXPECTED PRIVILEGED CLAIMS " + "─" * 35)
    stray = 0
    for uid, claims in sorted(actual.items()):
        if uid in expected:
            continue
        role = str(claims.get("role", "") or "")
        if role:
            lines.append(f"  STRAY    {uid:30} role={role:16} aid={claims.get('aid', '') or '—'}")
            failures.append(f"{uid}: carries role {role!r} and is not in the plan")
            stray += 1
    if stray == 0:
        lines.append(
            f"  none — of {len(actual)} Firebase accounts, only the "
            f"{len(expected)} planned carry a role claim"
        )

    if cleared:
        lines.append(f"\n── SHOULD HAVE BEEN CLEARED ({len(cleared)}) " + "─" * 32)
        for uid in sorted(cleared):
            role = str((actual.get(uid) or {}).get("role", "") or "")
            if role:
                lines.append(f"  STILL SET {uid:30} role={role}")
                failures.append(f"{uid}: claim should have been cleared")
            else:
                lines.append(f"  OK        {uid:30} cleared")

    # Only identities that genuinely hold no claim. A uid in `expected` is
    # excluded: its grant is the authoritative word on it.
    roster = [(uid, who, why) for uid, who, why in no_claim if uid not in expected]
    lines.append(f"\n── IDENTITIES CORRECTLY HOLDING NO CLAIM ({len(roster)}) " + "─" * 18)
    for uid, who, why in roster:
        carries = str((actual.get(uid) or {}).get("role", "") or "")
        lines.append(f"  {uid:34} {who:30} {why[:44]}")
        if carries:
            failures.append(f"{uid}: holds no-claim status but carries role {carries!r}")
    if not roster:
        lines.append("  (none)")

    return lines, roster, failures


async def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()

    firebase.init()
    await mongo.connect()
    try:
        planned, problems, no_claim = plan(
            await staff_rows(), partner_docs(), agency_kinds()
        )
        expected = {
            uid: {"role": role, "aid": aid}
            for uid, _who, role, aid, _note in planned
            if role
        }
        cleared = {uid for uid, _w, role, _a, _n in planned if not role}
        actual = dict(_all_auth_uids())

        print("\n" + "=" * 78)
        print("STORAGE CLAIM VERIFICATION — read only, nothing written")
        print("=" * 78)
        print(f"Firebase accounts read : {len(actual)}")
        print(f"Claims expected        : {len(expected)}")

        lines, _roster, failures = compare(expected, cleared, no_claim, actual)
        for line in lines:
            print(line)

        if problems:
            print(f"\n── PLAN WARNINGS ({len(problems)}) " + "─" * 44)
            for p in problems:
                print(f"  ! {p}")

        print("\n" + "=" * 78)
        if failures:
            print(f"{len(failures)} PROBLEM(S):")
            for f in failures:
                print(f"  · {f}")
            print("\nDo NOT deploy Storage Rules until these are resolved.\n" + "=" * 78 + "\n")
            return 1

        print("ALL CLAIMS MATCH THE AUTHORITATIVE RECORDS.")
        print("  Every expected claim is present and exact.")
        print("  No Firebase account outside the plan carries a role claim.")
        print("  Read from Firebase Auth custom claims — Firestore was read only")
        print("  to re-derive what SHOULD be there, never as the claim source.")
        print("\nNothing was written." + "\n" + "=" * 78 + "\n")
        return 0
    finally:
        await mongo.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
