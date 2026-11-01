"""MFA release, revision 4: the image is built from a frozen dependency set and a pinned base image.

`requirements.txt` pins the direct dependencies; `requirements.lock` pins all of them,
transitive ones included, at the versions of the reviewed stage 1 image. This keeps the
two from drifting apart and the Dockerfile from going back to re-resolving.

What this checks (static; reads files only):
  1. `requirements.lock` pins every package exactly (name==version), once each.
  2. Every pin in `requirements.txt` is in the lock at the same version (extras aside).
  3. The packages the Owner MFA code imports are in the lock (cryptography for Fernet).
  4. The Dockerfile installs the lock with --no-deps, runs `pip check`, never installs
     requirements.txt, and takes its base image by digest.

Run:  python3 -m tests.test_p2_requirements_lock
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

failures: list[str] = []
checks = 0


def ok(label: str, cond: bool) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(label)


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(path: Path) -> list[tuple[str, str]]:
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.fullmatch(r"([A-Za-z0-9._-]+)(\[[^\]]*\])?==([A-Za-z0-9.+!-]+)", line)
        out.append((norm(m.group(1)), m.group(3)) if m else (line, ""))
    return out


lock = pins(ROOT / "requirements.lock")
direct = pins(ROOT / "requirements.txt")
lock_map = dict(lock)

ok("1a every line of requirements.lock is an exact pin", all(v for _, v in lock))
ok("1b each package is pinned once", len(lock_map) == len(lock))
ok("1c the lock holds the full set of the stage 1 image (64 packages)", len(lock) == 64)
missing = [n for n, v in direct if lock_map.get(n) != v]
ok("2  every requirements.txt pin is in the lock at the same version" + (f" (not: {missing})" if missing else ""),
   not missing and all(v for _, v in direct))
for pkg in ("cryptography", "cffi", "google-cloud-firestore", "firebase-admin", "pymongo", "motor", "python-jose"):
    ok(f"3  {pkg} is pinned in the lock", pkg in lock_map)

docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
ok("4a the Dockerfile installs the lock with --no-deps and runs pip check",
   "pip install --no-cache-dir --no-deps -r requirements.lock && pip check" in docker)
ok("4b and never installs requirements.txt (which would re-resolve)", "-r requirements.txt" not in docker)
ok("4c the base image is taken by digest", re.search(r"^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$", docker, re.M) is not None)

if failures:
    print(f"{len(failures)} of {checks} dependency-lock checks FAILED:")
    for f in failures:
        print("  ✗", f)
    sys.exit(1)
print(f"All {checks} dependency-lock checks passed.")
