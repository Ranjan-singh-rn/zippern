"""Print the Owner uids exactly as Mongo `staff` holds them. READ ONLY.

    cd backend && .venv/bin/python -m scripts.print_owner_uids
    cd backend && .venv/bin/python -m scripts.print_owner_uids --candidate 'THE_UID_YOU_TYPED'

Writes nothing. One `find` on `staff` (role=owner), one Firebase Auth lookup
per uid. For each uid it prints:

  * the value between |bars| (shows leading/trailing spaces),
  * its length and whether it is pure ASCII letters/digits,
  * every character with its position and code point, with the ones people
    misread flagged: I/l/1/|, O/0/o, S/5, Z/2, B/8, rn/m, and any non-ASCII
    or invisible character (zero-width space, NBSP, Cyrillic look-alikes),
  * whether Firebase Auth has an account with exactly that uid.

`--candidate` (repeatable) compares a value you typed against each Owner uid
and prints the FIRST differing position and both characters — that is the
answer to "why does the cleanup refuse my third uid".
"""

from __future__ import annotations

import argparse
import asyncio
import string
import sys
import unicodedata

CONFUSABLE = set("Il1|O0oS5Z2B8")
SAFE = set(string.ascii_letters + string.digits)


def describe(uid: str) -> list[str]:
    out = [f"    value   |{uid}|", f"    length  {len(uid)}",
           f"    ascii alnum only: {all(c in SAFE for c in uid)}"]
    for i, c in enumerate(uid):
        flag = ""
        if c not in SAFE:
            flag = f"  <-- NOT ASCII ALNUM: {unicodedata.name(c, 'UNNAMED')}"
        elif c in CONFUSABLE:
            flag = "  (easily misread)"
        out.append(f"      [{i:2}] {c!r:6} U+{ord(c):04X}{flag}")
    if "rn" in uid:
        out.append("    note: contains 'rn' (reads as 'm')")
    return out


def first_diff(a: str, b: str) -> str:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return (f"differs at position {i}: owner has {x!r} (U+{ord(x):04X}), "
                    f"candidate has {y!r} (U+{ord(y):04X})")
    if len(a) != len(b):
        return f"same prefix, different length: owner {len(a)}, candidate {len(b)}"
    return "IDENTICAL"


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidate", action="append", default=[])
    args = ap.parse_args()

    from firebase_admin import auth as fb_auth

    from app.db import firebase, mongo

    firebase.init()
    await mongo.connect(ensure=False)  # READ ONLY: no index builds (DDL)
    try:
        rows = [r async for r in mongo.get_db()["staff"].find(
            {"role": "owner"}, {"uid": 1, "email": 1, "name": 1})]
    finally:
        await mongo.disconnect()

    print(f"Owner rows in Mongo staff: {len(rows)}\n")
    uids = []
    for n, r in enumerate(rows, 1):
        uid = str(r.get("uid") or "")
        uids.append(uid)
        try:
            fb_auth.get_user(uid)
            auth = "YES"
        except Exception as exc:  # noqa: BLE001
            auth = f"NO ({type(exc).__name__})"
        print(f"Owner {n}: {r.get('email')}")
        print("\n".join(describe(uid)))
        print(f"    Firebase Auth account with this exact uid: {auth}\n")

    for cand in args.candidate:
        print(f"Candidate |{cand}| (length {len(cand)})")
        for n, uid in enumerate(uids, 1):
            print(f"    vs Owner {n}: {first_diff(uid, cand)}")
        print()

    print("Copy/paste-safe command (single-quoted, exactly as stored):\n")
    print("  .venv/bin/python -m scripts.plan_test_data_reset \\")
    print(" \\\n".join(f"      --owner-uid '{u}'" for u in uids) + " \\")
    print("      --out reset-plan.json")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
