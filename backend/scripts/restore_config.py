"""Restore configuration from a backup, with the commission slab fix applied.

    python -m scripts.restore_config            # dry run
    python -m scripts.restore_config --confirm  # write it

Replays configuration only — appConfig, paymentConfig, rechargePackages,
diamondPacks. Test data is deliberately not restored; the point of the reset
was to be rid of it.

One correction is applied on the way through: the top commission slab is made
open-ended. As stored, both tables stopped at ₹50,00,000, and the slab engine
walks bands in order and stops — so an agency billing ₹60L earned commission on
only the first ₹50L. The intent was "₹50L and above earns the top rate", which
needs an unbounded final band.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase  # noqa: E402

NO_CAP = 999_999_999

CONFIG_COLLECTIONS = [
    "appConfig",
    "paymentConfig",
    "rechargePackages",
    "diamondPacks",
    "coinPackages",
    "levelConfig",
    "policies",
]


def decode(value: Any) -> Any:
    """Reverse the encoding used by backup_firestore."""
    if isinstance(value, dict):
        kind = value.get("__type__")
        if kind == "timestamp":
            from datetime import datetime

            return datetime.fromisoformat(value["value"])
        if kind == "bytes":
            return bytes.fromhex(value["value"])
        if kind == "geopoint":
            from google.cloud.firestore_v1 import GeoPoint

            return GeoPoint(value["latitude"], value["longitude"])
        if kind == "reference":
            return firebase.firestore_client().document(value["path"])
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def fix_slabs(slabs: list[dict], label: str) -> tuple[list[dict], str | None]:
    """Make the highest band open-ended. Returns the slabs and a note if changed."""
    if not slabs:
        return slabs, None

    ordered = sorted(slabs, key=lambda s: s.get("from", 0))
    top = ordered[-1]
    old_to = top.get("to")

    if old_to is None or old_to >= NO_CAP:
        return ordered, None

    top["to"] = NO_CAP
    return ordered, (
        f"{label}: top band was ₹{top.get('from', 0):,}–₹{old_to:,} at "
        f"{top.get('rate')}%, now ₹{top.get('from', 0):,} and above"
    )


def apply_fixes(collection: str, doc_id: str, data: dict) -> tuple[dict, list[str]]:
    notes: list[str] = []
    if collection != "appConfig" or doc_id != "economy":
        return data, notes

    comm = data.get("commissionConfig")
    if not isinstance(comm, dict):
        return data, notes

    for key, label in (
        ("mainAgencySlabs", "Main agency"),
        ("subAgencySlabs", "Sub-agency"),
    ):
        slabs = comm.get(key)
        if isinstance(slabs, list):
            fixed, note = fix_slabs(slabs, label)
            comm[key] = fixed
            if note:
                notes.append(note)

    return data, notes


def latest_backup() -> Path | None:
    root = Path(__file__).resolve().parents[1] / "backups"
    if not root.exists():
        return None
    runs = sorted(p for p in root.iterdir() if p.is_dir() and p.name.startswith("firestore-"))
    return runs[-1] if runs else None


def main() -> int:
    confirm = "--confirm" in sys.argv

    src = latest_backup()
    if src is None:
        print("\n  ✗ No backup found in backend/backups/\n")
        return 1

    print(f"\n  Restoring configuration from {src.name}")
    print(f"  {'WRITING' if confirm else 'DRY RUN — nothing will be written'}\n")

    firebase.init()
    fs = firebase.firestore_client()

    total = 0
    all_notes: list[str] = []

    for collection in CONFIG_COLLECTIONS:
        path = src / f"{collection}.json"
        if not path.exists():
            continue

        docs = json.loads(path.read_text())
        if not docs:
            continue

        print(f"    {collection}")
        for doc in docs:
            doc_id = doc["id"]
            data = decode(doc["data"])
            data, notes = apply_fixes(collection, doc_id, data)
            all_notes.extend(notes)

            if confirm:
                fs.collection(collection).document(doc_id).set(data)
            print(f"      · {doc_id}")
            total += 1

    if all_notes:
        print("\n  Corrections applied")
        for n in all_notes:
            print(f"    · {n}")

    if confirm:
        print(f"\n  Restored {total} configuration document(s).")
        print("\n  Check Economy Config in the CRM and adjust anything you want")
        print("  to change — every figure is editable there now.\n")
    else:
        print(f"\n  {total} document(s) would be restored.")
        print("\n  To write them:")
        print("    python -m scripts.restore_config --confirm\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
