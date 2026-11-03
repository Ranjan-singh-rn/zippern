"""Read, and on request restore, the in-app updater record `appConfig/androidUpdate`.

    cd backend && <venv python> ../release/completion-20261101/tools/android_update_doc.py get <out.json>
    cd backend && <venv python> ../release/completion-20261101/tools/android_update_doc.py restore <saved.json> <channel>

`get` is READ ONLY: it writes the document (publishedAt rendered as ISO text) to <out.json>, mode 600, and prints
the published versionCode / minSupportedVersionCode per channel. Nothing else.

`restore` is the WITHDRAW path of 61-withdraw-apk.command: it writes back EXACTLY the <channel> map saved by an
earlier `get`, after printing what it is about to write. It uses update() on the top-level field <channel>, which
REPLACES that whole map (set(..., merge=True) would deep-merge it and leave APK 20's minSupportedVersionCode or
patches behind if the saved map lacked them); the other channel is untouched. It is the only writer in this file
and it never deletes a document.

Run by the release scripts with PYTHONPATH=. from backend/, in production mode with ZIPPER_ENV_FILE pointing at an
empty file (no .env is read) and the explicit production acknowledgement of app/core/isolation.py, exactly like
scripts/publish_apk.py, with the same Firebase Admin credential the backend scripts already use.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

from app.db import firebase

DOC = "androidUpdate"
CHANNELS = ("debug", "release")


def _render(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, dict):
        return {k: _render(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_render(v) for v in value]
    return value


def _parse(value):
    """ISO text written by _render becomes a datetime again; everything else is left as it is."""
    if isinstance(value, str) and len(value) >= 20 and value[4] == "-" and value[10] == "T":
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return value
    if isinstance(value, dict):
        return {k: _parse(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_parse(v) for v in value]
    return value


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("get", "restore"):
        print(__doc__, file=sys.stderr)
        return 2
    firebase.init()
    ref = firebase.firestore_client().collection("appConfig").document(DOC)

    if argv[0] == "get":
        if len(argv) != 2:
            print("usage: android_update_doc.py get <out.json>", file=sys.stderr)
            return 2
        snap = ref.get()
        doc = _render(snap.to_dict() or {}) if snap.exists else {}
        fd = os.open(argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1, sort_keys=True)
        for ch in CHANNELS:
            c = doc.get(ch) or {}
            print(f"ANDROID {ch} versionCode={c.get('versionCode', 0)} versionName={c.get('versionName', '?')} "
                  f"minSupportedVersionCode={c.get('minSupportedVersionCode', 0)} publishedAt={c.get('publishedAt', '?')}")
        return 0

    if len(argv) != 3 or argv[2] not in CHANNELS:
        print("usage: android_update_doc.py restore <saved.json> debug|release", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        saved = json.load(fh)
    channel = argv[2]
    if channel not in saved or not isinstance(saved[channel], dict):
        print(f"RESTORE refused: the saved document has no '{channel}' map")
        return 1
    payload = _parse(saved[channel])
    print(f"RESTORE {channel} versionCode={payload.get('versionCode')} versionName={payload.get('versionName')} "
          f"minSupportedVersionCode={payload.get('minSupportedVersionCode')}")
    ref.update({channel: payload})   # replaces the whole <channel> map; the other channel is untouched
    print("RESTORE done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
