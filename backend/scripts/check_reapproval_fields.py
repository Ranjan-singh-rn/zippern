#!/usr/bin/env python3
"""The re-approval field set exists in three places. Check they still agree.

    firestore.rules                     reapprovalFields()   — what may be WRITTEN
    zipper-crm/lib/pendingChanges.ts    REAPPROVAL_FIELDS    — what gets PROPOSED
    backend/app/services/partner_ops.py APPLICABLE_FIELDS    — what gets APPLIED

One set, three languages, no way to share it: a Firestore rules file cannot
import from TypeScript, and neither can import from Python. So the only defence
is a check that reads all three and complains.

It is worth having because a mismatch fails silently and in opposite
directions:

  * A field the RULES call sensitive that the CRM calls ordinary is written
    directly — and refused. The partner sees "missing or insufficient
    permissions" on a form that worked yesterday, with nothing to say which
    field caused it.

  * A field the CRM proposes that the BACKEND does not apply is dropped on
    approval. A reviewer presses "apply", the queue clears, and the change does
    not happen. That one leaves no error at all.

Both of those happened with `ownerPhone` and `address`.

    python3 backend/scripts/check_reapproval_fields.py

Exits non-zero on a mismatch, so it can go in CI or a pre-deploy step.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _names(text: str) -> set[str]:
    """Every quoted identifier in a chunk of source, comments excluded.

    The comments matter: these lists carry long explanations, and a quoted word
    inside one ("a reviewer pressing 'apply'") is prose, not a field. Reading it
    as a field made this script report a disagreement that did not exist —
    which for a checker is the worst failure available, because the next person
    learns to ignore it.
    """
    lines = []
    for line in text.split("\n"):
        for marker in ("#", "//"):
            if marker in line:
                line = line.split(marker)[0]
        lines.append(line)
    return set(re.findall(r"['\"]([A-Za-z][A-Za-z0-9_]*)['\"]", "\n".join(lines)))


def from_rules() -> set[str]:
    src = (ROOT / "firestore.rules").read_text()
    out: set[str] = set()
    for fn in ("payoutFields", "identityFields"):
        m = re.search(rf"function {fn}\(\)\s*{{(.*?)}}", src, re.S)
        if not m:
            raise SystemExit(f"firestore.rules: {fn}() not found")
        out |= _names(m.group(1))
    return out


def from_crm() -> set[str]:
    src = (ROOT / "zipper-crm" / "lib" / "pendingChanges.ts").read_text()
    out: set[str] = set()
    for const in ("PAYOUT_FIELDS", "IDENTITY_FIELDS"):
        m = re.search(rf"export const {const}\s*=\s*\[(.*?)\]", src, re.S)
        if not m:
            raise SystemExit(f"pendingChanges.ts: {const} not found")
        out |= _names(m.group(1))
    return out


def from_backend() -> set[str]:
    src = (ROOT / "backend" / "app" / "services" / "partner_ops.py").read_text()
    out: set[str] = set()
    for const in ("REAPPROVAL_PAYOUT_FIELDS", "REAPPROVAL_IDENTITY_FIELDS"):
        m = re.search(rf"^{const}\s*=\s*\((.*?)^\)", src, re.S | re.M)
        if not m:
            raise SystemExit(f"partner_ops.py: {const} not found")
        out |= _names(m.group(1))
    return out


def main() -> int:
    sources = {
        "firestore.rules": from_rules(),
        "zipper-crm/lib/pendingChanges.ts": from_crm(),
        "backend/app/services/partner_ops.py": from_backend(),
    }

    everything: set[str] = set()
    for names in sources.values():
        everything |= names

    problems: list[str] = []
    for field in sorted(everything):
        missing = [where for where, names in sources.items() if field not in names]
        if missing:
            problems.append(f"  {field:<20} missing from: {', '.join(missing)}")

    for where, names in sources.items():
        print(f"{len(names):>3} fields  {where}")

    if problems:
        print("\nThe three lists disagree:\n")
        print("\n".join(problems))
        print(
            "\nAdd the field everywhere it is missing. A field the rules call\n"
            "sensitive and the CRM does not is a permission error on a form; a\n"
            "field the CRM proposes and the backend does not apply is a change\n"
            "that silently never happens."
        )
        return 1

    print(f"\nAll three agree on {len(everything)} fields.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
