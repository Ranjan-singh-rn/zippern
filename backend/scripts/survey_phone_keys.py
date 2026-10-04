"""What a phone-key migration would face. Reports only — writes nothing, ever.

── WHY THIS EXISTS BEFORE ANY MIGRATION ─────────────────────────────────────

`users.phoneKey` was the LAST TEN DIGITS of a number. It is now every digit,
country code included — see `functions/src/phone.ts` for why. Both spellings are
therefore live in the database, and the lookup path reads both: the canonical key
first, the legacy key as a fallback, with each legacy hit confirmed against the
record's stored `phoneNumber` before it counts.

That makes the system correct without a migration. It does not make the data
tidy, and three questions have to be answered before anybody decides whether to
tidy it:

  1. How many records still carry a ten-digit key?
  2. Are there COLLISIONS — two records whose legacy keys match but whose real
     numbers are in different countries? Those are the records the old code
     would have treated as one person, and the ones a naive migration would
     merge.
  3. How many records have a `phoneNumber` with no country code at all? Those
     cannot be upgraded deterministically: `9876543210` might be `+91…` or
     `+1…`, and this script will not guess.

── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────

No writes. No merges. No deletions. No account is touched, and there is no
`--apply` flag to add later without someone reading this paragraph: deciding
that two records are one person is not a decision a script should make, and
`bindVerifiedIdentity` blanking the wrong record is exactly what this whole
change exists to stop.

Anything it cannot resolve deterministically is listed under NEEDS A HUMAN with
the uids, for someone to look at.

USAGE
-----
    python -m scripts.survey_phone_keys
    python -m scripts.survey_phone_keys --limit 5000
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.db import firebase  # noqa: E402
from app.services.crm_directory import (  # noqa: E402
    DEFAULT_DIAL_CODE,
    _digits,
    _legacy_phone_key,
    _phone_key,
)


def country_code_of(e164: str) -> str:
    """A crude leading-country-code read, for GROUPING only.

    Deliberately not a real country lookup: the question here is "do these two
    records plausibly belong to different countries", and for that the first one
    to three digits are enough to say "these differ". A library that got India
    and Kazakhstan exactly right would not change what this script reports, and
    the script must not imply more precision than it has.
    """
    digits = _digits(e164)
    if not str(e164).strip().startswith("+") and len(digits.lstrip("0")) <= 10:
        return "(none)"
    for size in (1, 2, 3):
        if len(digits) > size:
            return digits[:size]
    return "(none)"


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=0, help="stop after N documents")
    args = ap.parse_args()

    firebase.init()
    db = firebase.firestore_client()

    total = 0
    with_key = 0
    legacy_shaped = 0
    canonical_shaped = 0
    no_number = 0
    bare_number = 0
    by_legacy: dict[str, list[tuple[str, str]]] = defaultdict(list)

    stream = db.collection("users").select(["phoneKey", "phoneNumber", "phone"]).stream()
    for snap in stream:
        total += 1
        if args.limit and total > args.limit:
            total -= 1
            break
        data = snap.to_dict() or {}
        key = str(data.get("phoneKey") or "")
        number = str(data.get("phoneNumber") or data.get("phone") or "")

        if not key:
            continue
        with_key += 1

        canonical = _phone_key(number)
        if key == canonical and canonical:
            canonical_shaped += 1
        elif key == _legacy_phone_key(number):
            legacy_shaped += 1

        if not number:
            no_number += 1
        elif not number.strip().startswith("+") and len(_digits(number).lstrip("0")) <= 10:
            bare_number += 1

        by_legacy[_legacy_phone_key(number) or key].append((snap.id, number))

    collisions = {k: v for k, v in by_legacy.items() if len(v) > 1}
    cross_country = {
        k: v
        for k, v in collisions.items()
        if len({country_code_of(num) for _uid, num in v}) > 1
    }

    print()
    print("═" * 70)
    print("  PHONE KEY SURVEY — read-only. Nothing was written.")
    print("═" * 70)
    print(f"  user documents scanned          {total}")
    print(f"  carrying a phoneKey             {with_key}")
    print(f"    already canonical (full E.164) {canonical_shaped}")
    print(f"    still the legacy 10-digit key  {legacy_shaped}")
    print()
    print(f"  phoneNumber missing entirely    {no_number}")
    print(f"  phoneNumber with NO country code {bare_number}")
    print(f"    (these cannot be upgraded deterministically —")
    print(f"     a bare number could be {DEFAULT_DIAL_CODE} or anything else)")
    print()
    print(f"  legacy keys shared by >1 record  {len(collisions)}")
    print(f"    of those, spanning >1 country  {len(cross_country)}")
    print()

    if cross_country:
        print("  NEEDS A HUMAN — same last ten digits, different countries.")
        print("  These are the records the old key treated as one identity.")
        print("  NOTHING HAS BEEN CHANGED. Do not merge them from a script.")
        print()
        for key, rows in sorted(cross_country.items())[:50]:
            print(f"    legacy key {key}")
            for uid, num in rows:
                print(f"      {uid:30} {num or '(no number stored)'}")
        if len(cross_country) > 50:
            print(f"    … and {len(cross_country) - 50} more")
        print()

    same_country = {k: v for k, v in collisions.items() if k not in cross_country}
    if same_country:
        print("  SHARED KEY, ONE COUNTRY — probably genuine duplicates of one")
        print("  person, or two records written at different times. Still not")
        print("  a script's decision.")
        print()
        for key, rows in sorted(same_country.items())[:20]:
            print(f"    legacy key {key}: {', '.join(uid for uid, _ in rows)}")
        if len(same_country) > 20:
            print(f"    … and {len(same_country) - 20} more")
        print()

    print("  No migration is required for correctness: the lookup path reads")
    print("  both keys and confirms every legacy hit against the stored number.")
    print("  This survey exists so the decision to tidy the data is an informed")
    print("  one rather than an automatic one.")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
