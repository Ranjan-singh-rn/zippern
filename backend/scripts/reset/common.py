"""Shared, pure helpers for the reset tooling: refusals, targets, time, hashes, files.

Nothing in this module connects anywhere, reads `.env`, or prints a secret.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

#: Firebase's reserved prefix for emulator-only projects. `execute` refuses it:
#: there is nothing to reset there, and a demo id typed into a production tool
#: is a sign the operator is not where they think they are.
DEMO_PROJECT_PREFIX = "demo-"

#: The spec: "Refuse reset without backup newer than one hour."
BACKUP_MAX_AGE = timedelta(hours=1)

#: Where every artifact of a run lands (under backend/). Gitignored.
DEFAULT_RUNS_DIR = "reset-runs"

MANIFEST_KIND = "zipper-reset-manifest"
BACKUP_MANIFEST_KIND = "zipper-backup-manifest"
SEED_RESULT_KIND = "zipper-seed-result"
POSTCHECK_KIND = "zipper-postcheck"

PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")
MONGO_DB_RE = re.compile(r"^[A-Za-z0-9_-]{1,63}$")
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


class Refused(RuntimeError):
    """The run may not continue. Nothing (further) is written. Exit code 2."""


# ── Time ─────────────────────────────────────────────────────────────────────

def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(dt: datetime | None = None) -> str:
    """`20261101T093000Z` — the UTC stamp used in every artifact name."""
    return (dt or utc_now()).strftime("%Y%m%dT%H%M%SZ")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value: Any) -> datetime | None:
    """A UTC datetime from an ISO string (or a datetime). None if unparseable."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def as_datetime(value: Any) -> datetime | None:
    """Best effort: a Firestore/Mongo/Auth timestamp of any shape, as UTC, or None.

    Accepts datetimes (incl. DatetimeWithNanoseconds), ISO strings, epoch
    seconds or milliseconds (ints/floats), and objects with `.timestamp()`.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        secs = float(value)
        if secs > 1e11:          # milliseconds
            secs = secs / 1000.0
        if secs <= 0 or secs > 4e9:
            return None
        return datetime.fromtimestamp(secs, tz=timezone.utc)
    if isinstance(value, str):
        return parse_iso(value)
    ts = getattr(value, "timestamp", None)
    if callable(ts):
        try:
            return datetime.fromtimestamp(float(ts()), tz=timezone.utc)
        except Exception:  # noqa: BLE001
            return None
    return None


# ── Hashing and files ────────────────────────────────────────────────────────

def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def write_json(path: str | Path, payload: Mapping[str, Any]) -> str:
    """Write JSON atomically (tmp + rename) and return the file's sha256."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=False, default=str)
        fh.write("\n")
    os.replace(tmp, p)
    return sha256_file(p)


def read_json(path: str | Path) -> dict:
    p = Path(path)
    if not p.is_file():
        raise Refused(f"{p} does not exist (the previous step did not produce it)")
    try:
        with open(p, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        raise Refused(f"{p} is not readable JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise Refused(f"{p} does not hold a JSON object")
    return data


def require_kind(data: Mapping[str, Any], kind: str, path: str = "") -> None:
    if data.get("kind") != kind:
        raise Refused(f"{path or 'the file'} is not a {kind} (kind={data.get('kind')!r})")


# ── Targets ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Target:
    """The exact project, bucket and database a run is for. Typed, never defaulted."""

    project: str
    bucket: str
    mongo_db: str
    firestore_database: str = "(default)"

    def as_dict(self) -> dict:
        return asdict(self)

    def describe(self) -> str:
        return (f"project={self.project} firestore={self.firestore_database} "
                f"bucket={self.bucket} mongo_db={self.mongo_db}")


def validate_target(project: str, bucket: str, mongo_db: str, *, allow_demo: bool) -> Target:
    project = (project or "").strip()
    bucket = (bucket or "").strip()
    mongo_db = (mongo_db or "").strip()
    if not project:
        raise Refused("--project is required and must be typed explicitly (no default, no .env)")
    if not PROJECT_ID_RE.match(project):
        raise Refused(f"--project {project!r} is not a well-formed project id")
    if project.startswith(DEMO_PROJECT_PREFIX) and not allow_demo:
        raise Refused(f"--project {project!r} is a demo- (emulator-only) id; refused for this step")
    if not bucket:
        raise Refused("--bucket is required (the project's Storage bucket, typed explicitly)")
    if bucket.startswith("gs://"):
        raise Refused("--bucket takes a bare bucket name, not a gs:// URL")
    if not BUCKET_RE.match(bucket):
        raise Refused(f"--bucket {bucket!r} is not a well-formed bucket name")
    if not mongo_db:
        raise Refused("--mongo-db is required (the MongoDB database name, typed explicitly)")
    if not MONGO_DB_RE.match(mongo_db):
        raise Refused(f"--mongo-db {mongo_db!r} is not a well-formed database name")
    return Target(project=project, bucket=bucket, mongo_db=mongo_db)


def target_from(data: Mapping[str, Any]) -> Target:
    t = data.get("target")
    if not isinstance(t, Mapping):
        raise Refused("the file carries no target block")
    return Target(project=str(t.get("project") or ""), bucket=str(t.get("bucket") or ""),
                  mongo_db=str(t.get("mongo_db") or ""),
                  firestore_database=str(t.get("firestore_database") or "(default)"))


def require_same_target(expected: Target, actual: Target, what: str) -> None:
    diffs = [f"{k}: {getattr(expected, k)!r} != {getattr(actual, k)!r}"
             for k in ("project", "bucket", "mongo_db", "firestore_database")
             if getattr(expected, k) != getattr(actual, k)]
    if diffs:
        raise Refused(f"target mismatch ({what}): " + "; ".join(diffs))


def mongo_uri_from_env(env_name: str, environ: Mapping[str, str] | None = None) -> str:
    """The connection string, from the named variable only. Never logged."""
    name = (env_name or "").strip()
    if not ENV_NAME_RE.match(name):
        raise Refused(f"--mongo-uri-env {name!r} is not an environment variable NAME")
    env = os.environ if environ is None else environ
    value = (env.get(name) or "").strip()
    if not value:
        raise Refused(f"environment variable {name} is not set; it must hold the MongoDB "
                      "connection string (the tool never reads .env)")
    if not (value.startswith("mongodb://") or value.startswith("mongodb+srv://")):
        raise Refused(f"environment variable {name} does not hold a mongodb:// connection string")
    return value


def mongo_hosts(uri: str) -> list[str]:
    """Host names of a connection string, credentials stripped. Safe to record."""
    u = (uri or "").strip()
    _scheme, sep, rest = u.partition("://")
    if not sep:
        return []
    netloc = rest.split("/", 1)[0].split("?", 1)[0]
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]
    hosts = []
    for part in netloc.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("["):
            hosts.append(part[1:part.find("]")] if "]" in part else part)
        else:
            hosts.append(part.split(":", 1)[0])
    return hosts


def credential_project(path: str) -> str:
    """The `project_id` named by a service-account key file. Nothing else is read out."""
    p = (path or "").strip()
    if not p:
        raise Refused("--credentials is required: the path to the service-account key for "
                      "this project (its project_id is compared with --project)")
    if not os.path.isfile(p):
        raise Refused(f"--credentials {p!r} is not a file")
    try:
        with open(p, encoding="utf-8") as fh:
            project = str(json.load(fh).get("project_id") or "").strip()
    except Exception as exc:  # noqa: BLE001
        raise Refused("the service-account key could not be read") from exc
    if not project:
        raise Refused("the service-account key names no project_id")
    return project


# ── Backup freshness ─────────────────────────────────────────────────────────

def check_backup_manifest(backup: Mapping[str, Any], target: Target, now: datetime,
                          *, path: str = "backup manifest") -> datetime:
    """Refuse unless the backup was EXECUTED, VERIFIED (passed) and is < 1 h old.

    Returns the backup's `finished` time.
    """
    require_kind(backup, BACKUP_MANIFEST_KIND, path)
    if backup.get("mode") != "executed":
        raise Refused(f"{path}: the backup was a {backup.get('mode', '?')} run, not an executed one")
    require_same_target(target, target_from(backup), f"{path} vs this run")
    verify = backup.get("verify")
    if not isinstance(verify, Mapping) or verify.get("passed") is not True:
        raise Refused(f"{path}: the backup has not passed `backup.py verify`")
    finished = parse_iso(backup.get("finished"))
    if finished is None:
        raise Refused(f"{path}: carries no usable `finished` time")
    age = now - finished
    if age > BACKUP_MAX_AGE:
        raise Refused(f"{path}: the backup finished {int(age.total_seconds() // 60)} minutes ago; "
                      "a reset needs a backup newer than one hour. Run backup + verify again.")
    if age < timedelta(0) - timedelta(minutes=5):
        raise Refused(f"{path}: the backup's finished time is in the future; check the clocks")
    return finished


# ── Operator confirmation ────────────────────────────────────────────────────

def typed(prompt: str, input_fn: Callable[[str], str] | None = None) -> str:
    """One typed line. A closed stdin or an interrupt is a refusal, never an answer."""
    fn = input_fn or input
    try:
        return (fn(prompt) or "").strip()
    except (EOFError, KeyboardInterrupt):
        raise Refused("no confirmation was typed (stdin closed or interrupted)") from None


def require_typed_project(project: str, input_fn: Callable[[str], str] | None = None) -> None:
    if typed(f"Type the exact project id ({'…' + project[-4:]}) to continue: ", input_fn) != project:
        raise Refused("the typed project id does not match --project; stopped")


def require_typed_sha_prefix(sha256: str, input_fn: Callable[[str], str] | None = None,
                             length: int = 12) -> None:
    got = typed(f"Type the first {length} characters of the manifest sha256: ", input_fn).lower()
    if len(got) != length or not sha256.lower().startswith(got):
        raise Refused("the typed sha256 prefix does not match the manifest file; stopped")


# ── Presentation ─────────────────────────────────────────────────────────────

def mask_email(email: str) -> str:
    e = (email or "").strip()
    if "@" not in e:
        return "***" if e else ""
    local, _, domain = e.partition("@")
    return f"{local[:1]}***@{domain}"


def mask_phone(phone: str) -> str:
    p = (phone or "").strip()
    return f"{p[:3]}{'*' * max(0, len(p) - 6)}{p[-3:]}" if len(p) >= 7 else ("***" if p else "")


def table(rows: Iterable[Iterable[Any]], headers: Iterable[str]) -> str:
    rows = [[str(c) for c in r] for r in rows]
    heads = [str(h) for h in headers]
    widths = [len(h) for h in heads]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(c))
    line = "  ".join(h.ljust(w) for h, w in zip(heads, widths))
    out = [line, "  ".join("-" * w for w in widths)]
    for r in rows:
        out.append("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    return "\n".join(out)


def say(*parts: Any) -> None:
    print(*parts, flush=True)


def run_main(fn: Callable[[], int]) -> int:
    """Uniform exit codes: 0 ok, 1 stopped/failed, 2 refused."""
    try:
        return int(fn())
    except Refused as exc:
        say(f"\nREFUSED: {exc}\n")
        return 2


def runs_dir(base: str | None, backend_root: Path) -> Path:
    return Path(base) if base else backend_root / DEFAULT_RUNS_DIR


BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent

if sys.version_info < (3, 10):  # pragma: no cover
    raise SystemExit("scripts/reset needs Python 3.10+")
