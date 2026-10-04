"""Export every Firestore collection to JSON files.

    python -m scripts.backup_firestore

Writes to backend/backups/firestore-YYYY-MM-DD-HHMM/, one file per collection,
plus a manifest. Read-only — it never modifies Firestore.

Run this before any reset. A backup you took after deleting is not a backup.

Subcollections are included: documents are walked recursively, so nested data
like sellers/{id}/diamondLending comes along too.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import firebase  # noqa: E402


def encode(value: Any) -> Any:
    """Make Firestore values JSON-safe without losing meaning."""
    # Timestamps, DatetimeWithNanoseconds
    if hasattr(value, "isoformat"):
        return {"__type__": "timestamp", "value": value.isoformat()}
    # DocumentReference
    if hasattr(value, "path") and hasattr(value, "id"):
        return {"__type__": "reference", "path": value.path}
    # GeoPoint
    if hasattr(value, "latitude") and hasattr(value, "longitude"):
        return {
            "__type__": "geopoint",
            "latitude": value.latitude,
            "longitude": value.longitude,
        }
    if isinstance(value, bytes):
        return {"__type__": "bytes", "value": value.hex()}
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    return value


def dump_document(doc) -> dict:
    out: dict[str, Any] = {
        "id": doc.id,
        "data": encode(doc.to_dict() or {}),
    }
    subs = {}
    for sub in doc.reference.collections():
        rows = [dump_document(d) for d in sub.stream()]
        if rows:
            subs[sub.id] = rows
    if subs:
        out["subcollections"] = subs
    return out


def main() -> int:
    firebase.init()
    fs = firebase.firestore_client()

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M")
    out_dir = Path(__file__).resolve().parents[1] / "backups" / f"firestore-{stamp}"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n  Backing up to {out_dir}\n")

    manifest: dict[str, int] = {}
    grand = 0

    for col in fs.collections():
        name = col.id
        docs = [dump_document(d) for d in col.stream()]

        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(docs, indent=2, ensure_ascii=False))

        # Count nested documents too, so the manifest reflects reality.
        def deep_count(rows: list[dict]) -> int:
            total = len(rows)
            for r in rows:
                for sub_rows in (r.get("subcollections") or {}).values():
                    total += deep_count(sub_rows)
            return total

        n = deep_count(docs)
        manifest[name] = n
        grand += n
        print(f"    {name:<28} {n:>6} document(s)")

    (out_dir / "_manifest.json").write_text(
        json.dumps(
            {
                "taken_at": datetime.now(timezone.utc).isoformat(),
                "project": firebase.settings.firebase_project_id
                if hasattr(firebase, "settings")
                else "",
                "total_documents": grand,
                "collections": manifest,
            },
            indent=2,
        )
    )

    print(f"\n  {grand} document(s) across {len(manifest)} collection(s).")
    print(f"  Saved to: {out_dir}")
    print("\n  Keep this somewhere outside the repo if it matters — it is")
    print("  gitignored, so it will not be committed.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
