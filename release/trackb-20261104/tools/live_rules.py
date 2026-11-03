"""Fetch the LIVE Firestore or Storage ruleset SOURCE (read-only) and save it to a file — the text 39/49 re-release.

    cd backend && <venv python> ../release/completion-20261101/tools/live_rules.py get firestore|storage <out-file>

Run by the release scripts with PYTHONPATH=. from backend/, in production mode with ZIPPER_ENV_FILE pointing at an
empty file (no .env is read) and the explicit production acknowledgement of app/core/isolation.py. It reuses the
backend's own READ-ONLY verifier helpers (scripts/verify_deployed_storage_rules: `firebase.readonly` scope, two
HTTP GETs). It cannot release, edit or delete a ruleset. Prints only: the release name, ruleset id, update time,
size and sha256 of the live text. The text itself goes to <out-file> (mode 600).
"""
from __future__ import annotations

import hashlib
import os
import sys

from app.config import settings
from scripts.verify_deployed_storage_rules import _API, _get, _token

MARKERS = {"firestore": "/releases/cloud.firestore", "storage": "/releases/firebase.storage"}


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] != "get" or argv[1] not in MARKERS:
        print("usage: live_rules.py get firestore|storage <out-file>", file=sys.stderr)
        return 2
    kind, out = argv[1], argv[2]
    project = settings.firebase_project_id or "zipper-83816"
    token = _token()
    releases = _get(f"{_API}/projects/{project}/releases", token).get("releases", [])
    matches = [r for r in releases if MARKERS[kind] in r.get("name", "")]
    if not matches:
        print(f"LIVE-RELEASE none ({len(releases)} release(s) seen)")
        return 1
    matches.sort(key=lambda r: r.get("updateTime", ""), reverse=True)
    live = matches[0]
    ruleset_name = live.get("rulesetName", "")
    ruleset = _get(f"{_API}/{ruleset_name}", token)
    files = ruleset.get("source", {}).get("files", [])
    if not files:
        print("LIVE-SOURCE none")
        return 1
    text = files[0].get("content", "")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"LIVE-RELEASE {live.get('name', '').split('/releases/')[-1]}")
    print(f"LIVE-RULESET {ruleset_name.split('/')[-1]}")
    print(f"LIVE-UPDATED {live.get('updateTime', '?')}")
    print(f"LIVE-FILE {files[0].get('name', '?')}")
    print(f"LIVE-SIZE {len(text.encode('utf-8'))}")
    print(f"LIVE-SHA {hashlib.sha256(text.encode('utf-8')).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
