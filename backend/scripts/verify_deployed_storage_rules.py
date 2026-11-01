"""What is ACTUALLY live on the bucket, compared to the file we tested. READ ONLY.

    cd backend && .venv/bin/python -m scripts.verify_deployed_storage_rules

THIS SCRIPT WRITES NOTHING. It issues two HTTP GETs against the Firebase Rules
API and reads one local file. It cannot deploy, cannot edit a ruleset, and has
no flags.

── WHY THIS EXISTS ──────────────────────────────────────────────────────────

`firebase deploy --only storage` says "released rules storage.rules to
firebase.storage" and that is the last anybody hears of it. There is no
`firebase storage:rules:list` — I suggested one and it does not exist — so the
usual way to check what is live is to open the console and read it, which
compares a screenful of text by eye.

This fetches the live ruleset source and compares its SHA-256 to the local
file. Either they match or they do not; there is nothing to read carefully.

── WHAT IT ANSWERS ──────────────────────────────────────────────────────────

  * which ruleset the `firebase.storage` release currently points at
  * when that ruleset was created
  * whether its source is byte-identical to local `storage.rules`
  * the previous releases, so a rollback target is visible

── AUTH ─────────────────────────────────────────────────────────────────────

Uses the same service-account key the API uses (`FIREBASE_CREDENTIALS_PATH`),
requesting a READ-ONLY scope. If the key lacks Rules API access the script
says so and names the console page instead of failing silently.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from app.config import settings

#: Read-only. Deliberately not `cloud-platform`, which would also permit writes.
_SCOPE = "https://www.googleapis.com/auth/firebase.readonly"
_API = "https://firebaserules.googleapis.com/v1"


def _token() -> str:
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request

    key = (Path(__file__).resolve().parents[1] / settings.firebase_credentials_path).resolve()
    if not key.exists():
        raise SystemExit(
            f"\nNo service-account key at {key}\n"
            "  (FIREBASE_CREDENTIALS_PATH in backend/.env)\n"
        )
    creds = service_account.Credentials.from_service_account_file(
        str(key), scopes=[_SCOPE]
    )
    creds.refresh(Request())
    return creds.token


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    project = settings.firebase_project_id or "zipper-83816"

    local_path = Path(__file__).resolve().parents[2] / "storage.rules"
    local = local_path.read_text()
    local_sha = hashlib.sha256(local.encode()).hexdigest()

    print("\n" + "=" * 78)
    print("DEPLOYED STORAGE RULES — read only")
    print("=" * 78)
    print(f"project    : {project}")
    print(f"local file : {local_path}")
    print(f"local sha  : {local_sha}")
    print(f"local size : {len(local.encode())} bytes")

    try:
        token = _token()
        releases = _get(f"{_API}/projects/{project}/releases", token).get("releases", [])
    except urllib.error.HTTPError as exc:
        print(
            f"\nCould not read the Rules API: HTTP {exc.code} {exc.reason}\n"
            "  The service account may not hold `firebaserules.viewer`.\n"
            f"  Check by eye instead: https://console.firebase.google.com/"
            f"project/{project}/storage/rules\n"
        )
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"\nCould not read the Rules API: {exc}\n")
        return 2

    # ── MATCHING THE RELEASE NAME ───────────────────────────────────────────
    #
    # A storage release is named
    #   projects/{project}/releases/firebase.storage/{bucket}
    # so it ENDS WITH THE BUCKET, not with "firebase.storage". The first
    # version of this used `.endswith("firebase.storage")` and reported
    # "nothing is deployed" immediately after a successful deploy — a
    # verification script that is confidently wrong is worse than none, so
    # the no-match branch below now prints every release it did find instead
    # of asserting an absence.
    #
    # Firestore releases are `.../releases/cloud.firestore`, which this
    # correctly ignores.
    storage_releases = [
        r for r in releases if "/releases/firebase.storage" in r.get("name", "")
    ]
    if not storage_releases:
        print(f"\nNo storage release found among {len(releases)} release(s).")
        print("  Releases the API returned:")
        for r in releases:
            print(f"    {r.get('name', '?')}")
        if not releases:
            print("    (none at all — the project has never had a ruleset released)")
        print(
            f"\n  Check by eye: https://console.firebase.google.com/"
            f"project/{project}/storage/rules\n"
        )
        return 1

    # Newest first, so a project with several buckets shows the most recent.
    storage_releases.sort(key=lambda r: r.get("updateTime", ""), reverse=True)
    live = storage_releases[0]
    if len(storage_releases) > 1:
        print(f"\n{len(storage_releases)} storage releases (one per bucket):")
        for r in storage_releases:
            print(f"  {r.get('name', '').split('/releases/')[-1]}")

    bucket = live.get("name", "").split("/releases/firebase.storage/")[-1]
    print(f"\nbucket       : {bucket or '(default)'}")
    ruleset_name = live.get("rulesetName", "")
    print(f"\nlive release : {live.get('name', '').split('/')[-1]}")
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

    print("\n" + "=" * 78)
    if deployed_sha == local_sha:
        print("MATCH — the live ruleset is byte-identical to local storage.rules.")
        print("        What was tested is what is enforcing.")
        print("\nNothing was written.\n" + "=" * 78 + "\n")
        return 0

    print("MISMATCH — the live ruleset is NOT the local file.")
    print("  This is worth resolving before trusting either one. Possible causes:")
    print("    · the deploy did not actually publish (check the deploy output)")
    print("    · storage.rules changed locally after the deploy")
    print("    · somebody edited the rules in the console")
    # A small, honest diff summary rather than dumping two files.
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
