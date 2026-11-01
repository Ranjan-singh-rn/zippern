"""D18 — how much of the active app population runs a build that pins appeal ids.

Reports only — COUNTS. Writes nothing, prints no uid, name, phone or email.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────

The restrictive Firestore/Storage rules (pinned appeal ids, RC) refuse what
builds older than the RC send: an old build's appeal goes to an auto-id that
the RC rules no longer accept. So the rules ship only after the RC build is
released AND enough of the people who actually use the app run it — with the
forced update (`appConfig/androidUpdate.<channel>.minSupportedVersionCode`,
`mandatory`) as the tool that moves the rest. This script measures that.

── WHAT IT READS ───────────────────────────────────────────────────────────

  * `appBuildReports/{uid}` — `{versionCode, seenAt}`, written by the sign-in gate
    (`resolveIdentity`) on every cold start and sign-in of a build that
    reports (the RC build and later). Nothing else is in it.
  * `users/{uid}` — only `lastSeen`, `isDeleted`, `accountState`, `isBanned`,
    `isSuspended`, `isGuest` (selected; no other field is fetched).

An account is ACTIVE when its `lastSeen` or its build report is inside the
window. An active account with no report inside the window runs a build OLDER
than the first that reports — "unreported" — which is exactly the population
the cutoff is about. Restricted accounts are shown separately because they are
the ones who file appeals.

── USAGE (owner-run; read-only production access) ─────────────────────────

    cd backend
    ENVIRONMENT=production ZIPPER_ALLOW_PRODUCTION_ACCESS=<project id> \\
        .venv/bin/python -m scripts.d18_adoption_report --min-version 19 --days 14 --threshold 0.95

`firebase.init()` applies the isolation rules (`app/core/isolation.py`):
outside production it reaches only the local emulators.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DAY_MS = 86_400_000
USER_FIELDS = ["lastSeen", "isDeleted", "accountState", "isBanned", "isSuspended", "isGuest"]


def _millis(value: Any) -> int:
    """Epoch milliseconds from a Firestore Timestamp/datetime, a number, or 0."""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    to_dt = getattr(value, "to_datetime", None)          # google.api_core DatetimeWithNanoseconds is a datetime
    if callable(to_dt):
        return _millis(to_dt())
    return 0


def _restricted(user: Mapping[str, Any]) -> bool:
    state = str(user.get("accountState") or "").strip().lower()
    return state in ("suspended", "banned") or user.get("isBanned") is True or user.get("isSuspended") is True


def _gone(user: Mapping[str, Any]) -> bool:
    state = str(user.get("accountState") or "").strip().lower()
    return user.get("isDeleted") is True or state in ("permanently_deactivated", "recovery_pending")


@dataclass
class Adoption:
    window_days: int
    min_version: int
    active: int = 0
    reported: int = 0
    unreported: int = 0
    at_or_above: int = 0
    by_version: dict[int, int] = field(default_factory=dict)
    restricted_active: int = 0
    restricted_at_or_above: int = 0
    guests_active: int = 0

    @property
    def share(self) -> float:
        return (self.at_or_above / self.active) if self.active else 0.0

    @property
    def restricted_share(self) -> float:
        return (self.restricted_at_or_above / self.restricted_active) if self.restricted_active else 1.0


def summarise(
    users: Iterable[tuple[str, Mapping[str, Any]]],
    builds: Mapping[str, Mapping[str, Any]],
    *,
    now_ms: int,
    days: int,
    min_version: int,
) -> Adoption:
    """Pure: the counts, from (uid, users-doc) pairs and appBuildReports by uid."""
    since = now_ms - days * DAY_MS
    out = Adoption(window_days=days, min_version=min_version)
    for uid, user in users:
        if _gone(user):
            continue
        build = builds.get(uid) or {}
        seen = _millis(build.get("seenAt"))
        version = build.get("versionCode")
        recent_build = seen >= since and isinstance(version, int) and version > 0
        active = recent_build or _millis(user.get("lastSeen")) >= since
        if not active:
            continue
        out.active += 1
        if user.get("isGuest") is True:
            out.guests_active += 1
        restricted = _restricted(user)
        if restricted:
            out.restricted_active += 1
        if recent_build:
            out.reported += 1
            out.by_version[int(version)] = out.by_version.get(int(version), 0) + 1
            if int(version) >= min_version:
                out.at_or_above += 1
                if restricted:
                    out.restricted_at_or_above += 1
        else:
            out.unreported += 1
    return out


def render(a: Adoption, threshold: float) -> str:
    lines = [
        "",
        "═" * 70,
        "  D18 ADOPTION REPORT — read-only, counts only. Nothing was written.",
        "═" * 70,
        f"  window                          last {a.window_days} days",
        f"  active accounts                 {a.active}   (of which guests {a.guests_active})",
        f"    reporting a build              {a.reported}",
        f"    NOT reporting (older build)    {a.unreported}",
        f"  on versionCode >= {a.min_version:<13} {a.at_or_above}   ({a.share:.1%})",
        f"  restricted & active             {a.restricted_active}   "
        f"(on >= {a.min_version}: {a.restricted_at_or_above}, {a.restricted_share:.1%})",
        "",
        "  by versionCode:",
    ]
    for version in sorted(a.by_version, reverse=True):
        lines.append(f"    {version:>8}  {a.by_version[version]}")
    if a.unreported:
        lines.append(f"    {'(older)':>8}  {a.unreported}")
    met = a.active > 0 and a.share >= threshold and a.restricted_share >= threshold
    lines += [
        "",
        f"  threshold {threshold:.0%} of active AND of restricted-active on >= {a.min_version}: "
        + ("MET" if met else "NOT MET"),
        "  This is a measurement. Deploying the restrictive rules is a separate,",
        "  explicitly approved step (deployment plan, step 9).",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-version", type=int, required=True, help="the first versionCode that pins appeal ids")
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--threshold", type=float, default=0.95)
    args = ap.parse_args()
    if args.min_version <= 0 or args.days <= 0 or not 0 < args.threshold <= 1:
        ap.error("--min-version and --days must be positive; --threshold in (0, 1]")

    from app.db import firebase  # applies the isolation rules before any credential is read

    firebase.init()
    db = firebase.firestore_client()
    builds = {s.id: (s.to_dict() or {}) for s in db.collection("appBuildReports").select(["versionCode", "seenAt"]).stream()}
    users = ((s.id, s.to_dict() or {}) for s in db.collection("users").select(USER_FIELDS).stream())
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    print(render(summarise(users, builds, now_ms=now_ms, days=args.days, min_version=args.min_version),
                 args.threshold))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
