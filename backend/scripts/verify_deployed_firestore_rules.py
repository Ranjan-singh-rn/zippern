"""What Firestore rules are ACTUALLY live, compared to the file we tested. READ ONLY.

    cd backend && .venv/bin/python -m scripts.verify_deployed_firestore_rules

THIS SCRIPT WRITES NOTHING. It issues two HTTP GETs against the Firebase Rules
API and reads one local file. It cannot deploy, cannot edit a ruleset, and has
no flags.

── WHY THIS EXISTS ──────────────────────────────────────────────────────────

`firebase deploy --only firestore:rules` says "released rules firestore.rules
to cloud.firestore" and that is the last anybody hears of it. The deploy output
names no ruleset id and no hash, so "is what I tested what is enforcing?" can
otherwise only be answered by opening the console and comparing 3,000 lines of
text by eye.

This fetches the live ruleset source and compares its SHA-256 to the local
file. Either they match or they do not.

── WHY IT IMPORTS FROM ITS STORAGE SIBLING ──────────────────────────────────

`verify_deployed_storage_rules.py` already solved authentication and the HTTP
call, and that script is in use and working. Copying those twenty lines would
create a second place for the credential path and the read-only scope to drift,
and the whole point of both scripts is to be trustworthy about what is live. So
the two helpers are imported rather than duplicated, and that file is not
modified.

The part that genuinely differs is the release name:

    storage   projects/{p}/releases/firebase.storage/{bucket}   ← ends in a bucket
    firestore projects/{p}/releases/cloud.firestore             ← ends in the service

The storage verifier matched `endswith("firebase.storage")` on its first draft
and reported "nothing is deployed" immediately after a successful deploy. The
no-match branch below therefore prints every release the API returned rather
than asserting an absence.

── AUTH ─────────────────────────────────────────────────────────────────────

The same service-account key the API uses (`FIREBASE_CREDENTIALS_PATH`),
requesting a READ-ONLY scope. If the key lacks Rules API access the script says
so and names the console page instead of failing silently.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.error
from pathlib import Path

from app.config import settings

# Not duplicated: one credential path, one read-only scope, one HTTP helper.
from scripts.verify_deployed_storage_rules import _API, _get, _token

#: A Firestore rules release is named for the SERVICE, with no bucket after it.
_RELEASE_MARKER = "/releases/cloud.firestore"


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    project = settings.firebase_project_id or "zipper-83816"

    local_path = Path(__file__).resolve().parents[2] / "firestore.rules"
    local = local_path.read_text()
    local_sha = hashlib.sha256(local.encode()).hexdigest()

    print("\n" + "=" * 78)
    print("DEPLOYED FIRESTORE RULES — read only")
    print("=" * 78)
    print(f"project    : {project}")
    print(f"local file : {local_path}")
    print(f"local sha  : {local_sha}")
    print(f"local size : {len(local.encode())} bytes")
    print(f"local lines: {len(local.splitlines())}")

    try:
        token = _token()
        releases = _get(f"{_API}/projects/{project}/releases", token).get("releases", [])
    except urllib.error.HTTPError as exc:
        print(
            f"\nCould not read the Rules API: HTTP {exc.code} {exc.reason}\n"
            "  The service account may not hold `firebaserules.viewer`.\n"
            f"  Check by eye instead: https://console.firebase.google.com/"
            f"project/{project}/firestore/rules\n"
        )
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"\nCould not read the Rules API: {exc}\n")
        return 2

    matches = [r for r in releases if _RELEASE_MARKER in r.get("name", "")]
    if not matches:
        print(f"\nNo Firestore release found among {len(releases)} release(s).")
        print("  Releases the API returned:")
        for r in releases:
            print(f"    {r.get('name', '?')}")
        if not releases:
            print("    (none at all — the project has never had a ruleset released)")
        print(
            f"\n  Check by eye: https://console.firebase.google.com/"
            f"project/{project}/firestore/rules\n"
        )
        return 1

    # Newest first, so a project with several named databases shows the latest.
    matches.sort(key=lambda r: r.get("updateTime", ""), reverse=True)
    live = matches[0]
    if len(matches) > 1:
        print(f"\n{len(matches)} Firestore releases:")
        for r in matches:
            print(f"  {r.get('name', '').split('/releases/')[-1]}")

    ruleset_name = live.get("rulesetName", "")
    print(f"\nlive release : {live.get('name', '').split('/releases/')[-1]}")
    print(f"ruleset      : {ruleset_name.split('/')[-1]}")
    print(f"created      : {live.get('createTime', '?')}")
    print(f"updated      : {live.get('updateTime', '?')}")

    ruleset = _get(f"{_API}/{ruleset_name}", token)
    files = ruleset.get("source", {}).get("files", [])
    if not files:
        print("\nThe live ruleset carries no source.\n")
        return 1

    deployed = files[0].get("content", "")
    deployed_sha = hashlib.sha256(deployed.encode()).hexdigest()
    print(f"\ndeployed name: {files[0].get('name', '?')}")
    print(f"deployed sha : {deployed_sha}")
    print(f"deployed size: {len(deployed.encode())} bytes")
    print(f"deployed lines: {len(deployed.splitlines())}")

    print("\n" + "=" * 78)
    if deployed_sha == local_sha:
        print("MATCH — the live ruleset is byte-identical to local firestore.rules.")
        print("        What the emulator tested is what is enforcing.")
        print("\nNothing was written.\n" + "=" * 78 + "\n")
        return 0

    print("MISMATCH — the live ruleset is NOT the local file.")
    print("  Worth resolving before trusting either one. Possible causes:")
    print("    · the deploy did not actually publish (check the deploy output)")
    print("    · firestore.rules changed locally after the deploy")
    print("    · somebody edited the rules in the console")
    dl, ll = deployed.split("\n"), local.split("\n")
    print(f"\n  deployed: {len(dl)} lines    local: {len(ll)} lines")
    for i, (a, b) in enumerate(zip(dl, ll)):
        if a != b:
            print(f"  first difference at line {i + 1}:")
            print(f"    live  : {a[:90]}")
            print(f"    local : {b[:90]}")
            break
    print("\nNothing was written.\n" + "=" * 78 + "\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
