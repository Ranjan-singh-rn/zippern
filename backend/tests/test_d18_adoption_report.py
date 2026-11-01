"""D18 — the adoption report counts the right people and prints nothing personal.

`scripts/d18_adoption_report.py` decides when the restrictive rules may ship,
so its arithmetic is pinned here on fixtures: who is active, who runs a build
that pins appeal ids, who still runs an older (unreporting) build, and how
restricted accounts — the ones who file appeals — are counted. The script is
read-only by construction; that is checked on its source.

    python3 -m tests.test_d18_adoption_report
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.harness import install_stubs  # noqa: E402

install_stubs()

from scripts import d18_adoption_report as R  # noqa: E402

checks = 0
failures: list[str] = []


def eq(claim: str, got, want) -> None:
    global checks
    checks += 1
    if got != want:
        failures.append(f"{claim}\n        got  {got!r}\n        want {want!r}")


def ok(claim: str, cond: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(f"{claim}\n        {detail}" if detail else claim)


NOW = int(datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp() * 1000)
DAY = R.DAY_MS
recent = NOW - 2 * DAY
old = NOW - 40 * DAY

USERS = [
    ("u-new", {"lastSeen": recent}),                                        # RC build, active
    ("u-new2", {"lastSeen": old}),                                          # RC build — active by its report
    ("u-old", {"lastSeen": recent}),                                        # active, no report → older build
    ("u-qa", {"lastSeen": recent}),                                         # a QA build below the cutoff
    ("u-idle", {"lastSeen": old}),                                          # inactive, no report
    ("u-stale", {"lastSeen": old}),                                         # a report outside the window
    ("u-banned", {"lastSeen": recent, "accountState": "banned", "isBanned": True}),
    ("u-susp-old", {"lastSeen": recent, "isSuspended": True}),              # restricted on an old build
    ("u-deleted", {"lastSeen": recent, "isDeleted": True}),
    ("u-purged", {"lastSeen": recent, "accountState": "permanently_deactivated"}),
    ("u-guest", {"lastSeen": recent, "isGuest": True}),
]
BUILDS = {
    "u-new": {"versionCode": 19, "seenAt": datetime.fromtimestamp((NOW - DAY) / 1000, tz=timezone.utc)},
    "u-new2": {"versionCode": 20, "seenAt": NOW - 3 * DAY},
    "u-qa": {"versionCode": 18, "seenAt": NOW - DAY},
    "u-stale": {"versionCode": 19, "seenAt": old},
    "u-banned": {"versionCode": 19, "seenAt": NOW - DAY},
    "u-guest": {"versionCode": 19, "seenAt": NOW - DAY},
    "u-deleted": {"versionCode": 19, "seenAt": NOW - DAY},
}

a = R.summarise(USERS, BUILDS, now_ms=NOW, days=14, min_version=19)
eq("active: everyone seen or reporting in the window, minus deleted/purged", a.active, 7)
eq("reporting a build in the window", a.reported, 5)
eq("unreported (older builds)", a.unreported, 2)
eq("on >= 19", a.at_or_above, 4)
eq("by versionCode", a.by_version, {19: 3, 20: 1, 18: 1})
eq("restricted & active", a.restricted_active, 2)
eq("restricted on >= 19", a.restricted_at_or_above, 1)
eq("guests active", a.guests_active, 1)
ok("share is at_or_above / active", abs(a.share - 4 / 7) < 1e-9, str(a.share))
ok("restricted share is its own fraction", abs(a.restricted_share - 0.5) < 1e-9, str(a.restricted_share))

text = R.render(a, 0.95)
ok("the report says NOT MET below the threshold", "NOT MET" in text)
for uid, _ in USERS:
    ok(f"no uid is printed ({uid})", uid not in text)
ok("it says it is a measurement, not a deployment", "separate," in text and "explicitly approved" in text)

full = R.summarise([("a", {"lastSeen": recent}), ("b", {"lastSeen": recent})],
                   {"a": {"versionCode": 19, "seenAt": NOW}, "b": {"versionCode": 21, "seenAt": NOW}},
                   now_ms=NOW, days=14, min_version=19)
ok("all active on >= cutoff and no restricted → MET", "MET" in R.render(full, 0.95)
   and "NOT MET" not in R.render(full, 0.95))
empty = R.summarise([], {}, now_ms=NOW, days=14, min_version=19)
ok("no active accounts is never MET", "NOT MET" in R.render(empty, 0.95))

bad = R.summarise([("x", {"lastSeen": recent})], {"x": {"versionCode": "19", "seenAt": NOW}},
                  now_ms=NOW, days=14, min_version=19)
eq("a non-integer versionCode is not a report", (bad.reported, bad.unreported), (0, 1))

SRC = (ROOT / "scripts" / "d18_adoption_report.py").read_text()
code = "\n".join(line for line in SRC.splitlines() if not line.strip().startswith(("#", '"', "*")))
for verb in (".set(", ".update(", ".delete(", ".add(", "batch(", "transaction("):
    ok(f"the script never calls {verb}", verb not in code)
ok("users are read with a field selection, not whole documents",
   'db.collection("users").select(USER_FIELDS)' in SRC)
ok("it goes through firebase.init() (the isolation rules) before any read",
   SRC.index("firebase.init()") < SRC.index("firebase.firestore_client()"))

print()
if failures:
    print(f"{len(failures)} of {checks} checks FAILED:")
    for f in failures:
        print("  ✗ " + f)
    sys.exit(1)
print(f"All {checks} D18 adoption-report checks passed.")
