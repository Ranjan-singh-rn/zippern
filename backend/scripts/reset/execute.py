"""Step 4 — EXECUTE the frozen manifest. Deletes EXACTLY the ids it lists. IRREVERSIBLE.

    cd backend
    .venv/bin/python -m scripts.reset.execute \\
        --project <id> --bucket <bucket> --mongo-db <db> --mongo-uri-env MONGO_URI_RESET \\
        --credentials /path/key.json --manifest reset-runs/<UTC>/reset-manifest-<UTC>.json \\
        --out-dir reset-runs/<UTC> [--rehearse]

`--rehearse` performs every check and classifies every id (present / absent /
newer than the manifest) but deletes nothing and asks for no confirmation.

── WHAT IT NEVER DOES ───────────────────────────────────────────────────────
It never lists a collection, a bucket or the Auth users to find things to
delete. It never deletes a collection, a query result or "everything". Every
delete names one id taken from the manifest, in batches of explicit ids.

── REFUSALS (nothing is deleted) ────────────────────────────────────────────
  * --project is a demo- id, or differs from the manifest's target;
  * the live Firestore project, bucket, MongoDB database, MongoDB hosts or
    data canary differ from the manifest;
  * the backup manifest the plan referenced has changed (sha256), has not
    passed verify, or finished more than one hour ago;
  * the classification table changed since the plan (fingerprint);
  * the manifest carries UNKNOWN names, or is not a reset manifest;
  * the operator does not type the exact project id and the first 12
    characters of the manifest file's sha256.

── PER ID ───────────────────────────────────────────────────────────────────
  deleted          it existed, was created at or before manifest_time, and is gone;
  already_absent   it was gone already (an earlier run, a trigger, the app) — idempotent;
  skipped_newer    its creation time is after manifest_time (or, for Storage, its
                   generation changed) — the record post-dates the Owner's review;
  failed           the delete raised; recorded with the error; re-run to complete.

Order: Mongo → Firestore (deepest paths first) → Storage → Auth last.
Log: reset-log-<UTC>.jsonl (every id, every outcome) + reset-log-<UTC>.summary.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from scripts.reset import classification as T
from scripts.reset.adapters import FIRESTORE_CREATED_FIELDS, MONGO_CREATED_FIELDS, creation_time_of
from scripts.reset.common import (MANIFEST_KIND, Refused, Target, as_datetime, check_backup_manifest, iso,
                                  parse_iso, read_json, require_same_target, require_typed_project,
                                  require_typed_sha_prefix, run_main, say, sha256_file, stamp, table, target_from,
                                  utc_now, validate_target, write_json)

FIRESTORE_BATCH = 400
AUTH_BATCH = 1000
OUTCOMES = ("attempted", "deleted", "already_absent", "skipped_newer", "failed")


class Log:
    """Append-only JSONL. One line per id, plus start / summary / finish events."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._fh = open(path, "a", encoding="utf-8") if path else None
        self.counts: dict[str, Counter] = defaultdict(Counter)   # "store/collection" → outcome → n
        self.errors: list[dict] = []

    def event(self, **row: Any) -> None:
        row.setdefault("at", iso(utc_now()))
        if self._fh:
            self._fh.write(json.dumps(row, default=str) + "\n")
            self._fh.flush()

    def item(self, store: str, collection: str, ident: str, outcome: str, error: str = "") -> None:
        key = f"{store}/{collection}"
        self.counts[key]["attempted"] += 1
        self.counts[key][outcome] += 1
        row = {"event": "item", "store": store, "collection": collection, "id": ident, "outcome": outcome}
        if error:
            row["error"] = error[:500]
            self.errors.append({"store": store, "collection": collection, "id": ident, "error": error[:500]})
        self.event(**row)

    def close(self) -> None:
        if self._fh:
            self._fh.close()

    def summary(self) -> dict:
        return {k: {o: int(v.get(o, 0)) for o in OUTCOMES} for k, v in sorted(self.counts.items())}


# ══════════════════════════════════════════════════════════════════════════════
#  Pre-flight (pure)
# ══════════════════════════════════════════════════════════════════════════════

def static_checks(manifest: dict, manifest_path: Path, target: Target, now: datetime) -> tuple[str, datetime]:
    """Everything that can be refused before a connection exists.
    Returns (manifest sha256, manifest_time)."""
    if manifest.get("kind") != MANIFEST_KIND:
        raise Refused(f"{manifest_path} is not a reset manifest")
    if manifest.get("unknown"):
        raise Refused("the manifest carries UNKNOWN names; it must never have been written — re-plan")
    require_same_target(target_from(manifest), target, "manifest vs typed target")
    if manifest.get("table_fingerprint") != T.table_fingerprint():
        raise Refused("classification.py changed since this manifest was planned; re-plan")
    manifest_time = parse_iso(manifest.get("manifest_time"))
    if manifest_time is None:
        raise Refused("the manifest carries no usable manifest_time")
    if manifest_time > now:
        raise Refused("the manifest_time is in the future; check the clocks")
    backup_ref = manifest.get("backup") or {}
    backup_path = Path(str(backup_ref.get("manifest_path") or ""))
    if not backup_path.is_file():
        raise Refused(f"the backup manifest the plan referenced is missing: {backup_path}")
    if sha256_file(backup_path) != backup_ref.get("sha256"):
        raise Refused("the backup manifest changed since the plan (sha256 differs); re-run verify and plan")
    check_backup_manifest(read_json(backup_path), target, now, path=str(backup_path))
    return sha256_file(manifest_path), manifest_time


def live_checks(manifest: dict, target: Target, *, fs: Any, mongo: Any, storage: Any, canary_project: str) -> None:
    if fs.project() != target.project:
        raise Refused(f"live Firestore is project {fs.project()!r}, not {target.project!r}")
    if mongo.db_name() != target.mongo_db:
        raise Refused(f"live MongoDB database is {mongo.db_name()!r}, not {target.mongo_db!r}")
    if sorted(mongo.hosts()) != sorted(manifest.get("mongo_hosts") or []):
        raise Refused("the MongoDB hosts differ from the ones the manifest was planned against")
    if canary_project != target.project:
        raise Refused(f"the MongoDB data canary does not name {target.project!r}"
                      + (f" (it names {canary_project!r})" if canary_project else " (absent)"))
    if storage.bucket_name() != target.bucket or not storage.bucket_exists():
        raise Refused(f"live bucket {storage.bucket_name()!r} is not {target.bucket!r} or does not exist")


def _newer(created: datetime | None, manifest_time: datetime) -> bool:
    return created is not None and created > manifest_time


# ══════════════════════════════════════════════════════════════════════════════
#  The four phases. Each takes ONLY the manifest's ids.
# ══════════════════════════════════════════════════════════════════════════════

def run_mongo(entries: list[dict], mongo: Any, manifest_time: datetime, log: Log, *, apply: bool) -> None:
    for e in entries:
        coll, id_spec = str(e["collection"]), e["id"]
        ident = f"{id_spec.get('t')}:{id_spec.get('v')}"
        try:
            doc = mongo.find_one(coll, id_spec)
            if doc is None:
                log.item("mongo", coll, ident, "already_absent")
                continue
            created = creation_time_of(doc, *MONGO_CREATED_FIELDS)
            if created is None:
                created = as_datetime(getattr(doc.get("_id"), "generation_time", None))
            if _newer(created, manifest_time):
                log.item("mongo", coll, ident, "skipped_newer")
                continue
            if not apply:
                log.item("mongo", coll, ident, "deleted")   # rehearsal: would be deleted
                continue
            n = mongo.delete_one(coll, id_spec)
            log.item("mongo", coll, ident, "deleted" if n == 1 else "already_absent")
        except Exception as exc:  # noqa: BLE001
            log.item("mongo", coll, ident, "failed", f"{type(exc).__name__}: {exc}")


def _firestore_key(path: str) -> str:
    segs = path.split("/")
    return "/".join(s if i % 2 == 0 else "*" for i, s in enumerate(segs[:-1]))


def run_firestore(entries: list[dict], fs: Any, manifest_time: datetime, log: Log, *, apply: bool) -> None:
    paths = sorted((str(e["path"]) for e in entries), key=lambda p: (-p.count("/"), p))
    pending: list[str] = []

    def flush() -> None:
        if not pending:
            return
        chunk = list(pending)
        pending.clear()
        try:
            if apply:
                fs.delete_docs(chunk)
            for p in chunk:
                log.item("firestore", _firestore_key(p), p, "deleted")
        except Exception as exc:  # noqa: BLE001
            for p in chunk:
                log.item("firestore", _firestore_key(p), p, "failed", f"{type(exc).__name__}: {exc}")

    for path in paths:
        key = _firestore_key(path)
        try:
            fields = fs.get_doc(path)
        except Exception as exc:  # noqa: BLE001
            log.item("firestore", key, path, "failed", f"{type(exc).__name__}: {exc}")
            continue
        if fields is None:
            log.item("firestore", key, path, "already_absent")
            continue
        created = as_datetime(fields.get("_create_time")) or creation_time_of(fields, *FIRESTORE_CREATED_FIELDS)
        if _newer(created, manifest_time):
            log.item("firestore", key, path, "skipped_newer")
            continue
        pending.append(path)
        if len(pending) >= FIRESTORE_BATCH:
            flush()
    flush()


def run_storage(entries: list[dict], storage: Any, manifest_time: datetime, log: Log, *, apply: bool) -> None:
    for e in entries:
        name = str(e["name"])
        top = T.storage_prefix(name)
        try:
            obj = storage.get_object(name)
            if obj is None:
                log.item("storage", top, name, "already_absent")
                continue
            gen_manifest, gen_live = e.get("generation"), obj.get("generation")
            if gen_manifest and gen_live and str(gen_manifest) != str(gen_live):
                log.item("storage", top, name, "skipped_newer")
                continue
            if _newer(as_datetime(obj.get("time_created")), manifest_time):
                log.item("storage", top, name, "skipped_newer")
                continue
            if apply:
                storage.delete_object(name, gen_manifest or None)
            log.item("storage", top, name, "deleted")
        except Exception as exc:  # noqa: BLE001
            log.item("storage", top, name, "failed", f"{type(exc).__name__}: {exc}")


def run_auth(entries: list[dict], auth: Any, manifest_time: datetime, log: Log, *, apply: bool) -> None:
    to_delete: list[str] = []
    for e in entries:
        uid = str(e["uid"])
        try:
            user = auth.get_user(uid)
        except Exception as exc:  # noqa: BLE001
            log.item("auth", "users", uid, "failed", f"{type(exc).__name__}: {exc}")
            continue
        if user is None:
            log.item("auth", "users", uid, "already_absent")
            continue
        if _newer(as_datetime(user.get("created")), manifest_time):
            log.item("auth", "users", uid, "skipped_newer")
            continue
        to_delete.append(uid)
    for i in range(0, len(to_delete), AUTH_BATCH):
        chunk = to_delete[i:i + AUTH_BATCH]
        errors: dict[str, str] = {}
        if apply:
            try:
                errors = dict(auth.delete_users(chunk))
            except Exception as exc:  # noqa: BLE001
                errors = {u: f"{type(exc).__name__}: {exc}" for u in chunk}
        for uid in chunk:
            if uid in errors:
                log.item("auth", "users", uid, "failed", errors[uid])
            else:
                log.item("auth", "users", uid, "deleted")


def execute_manifest(*, manifest: dict, manifest_sha: str, manifest_time: datetime, target: Target,
                     fs: Any, mongo: Any, storage: Any, auth: Any, log: Log, apply: bool) -> dict:
    d = manifest.get("delete") or {}
    log.event(event="start", mode="execute" if apply else "rehearse", target=target.as_dict(),
              manifest_sha256=manifest_sha, manifest_time=iso(manifest_time),
              totals=manifest.get("totals"), table_fingerprint=manifest.get("table_fingerprint"))
    run_mongo(list(d.get("mongo") or []), mongo, manifest_time, log, apply=apply)
    run_firestore(list(d.get("firestore") or []), fs, manifest_time, log, apply=apply)
    run_storage(list(d.get("storage") or []), storage, manifest_time, log, apply=apply)
    run_auth(list(d.get("auth") or []), auth, manifest_time, log, apply=apply)
    summary = log.summary()
    for key, counts in summary.items():
        log.event(event="collection", collection=key, **counts)
    totals = {o: sum(c[o] for c in summary.values()) for o in OUTCOMES}
    log.event(event="finish", totals=totals, errors=len(log.errors))
    return {"mode": "execute" if apply else "rehearse", "target": target.as_dict(), "manifest_sha256": manifest_sha,
            "manifest_time": iso(manifest_time), "per_collection": summary, "totals": totals,
            "errors": log.errors, "finished": iso(utc_now())}


def render_summary(summary: dict) -> str:
    rows = [(k, c["attempted"], c["deleted"], c["already_absent"], c["skipped_newer"], c["failed"])
            for k, c in summary["per_collection"].items()]
    t = summary["totals"]
    rows.append(("TOTAL", t["attempted"], t["deleted"], t["already_absent"], t["skipped_newer"], t["failed"]))
    return table(rows, ("store/collection", "attempted", "deleted", "already_absent", "skipped_newer", "failed"))


# ══════════════════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════════════════

def main(argv: list[str] | None = None, input_fn: Callable[[str], str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--mongo-db", required=True)
    ap.add_argument("--mongo-uri-env", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--rehearse", action="store_true", help="check and classify every id; delete nothing")
    args = ap.parse_args(argv)

    def go() -> int:
        target = validate_target(args.project, args.bucket, args.mongo_db, allow_demo=False)
        manifest_path = Path(args.manifest)
        manifest = read_json(manifest_path)
        now = utc_now()
        manifest_sha, manifest_time = static_checks(manifest, manifest_path, target, now)
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        from scripts.reset.common import mongo_uri_from_env
        from scripts.reset.live import FirebaseSession, LiveMongo, mongo_canary_project

        uri = mongo_uri_from_env(args.mongo_uri_env)
        session = FirebaseSession(target, args.credentials)
        mongo = LiveMongo(uri, target)
        try:
            fs, storage, auth = session.firestore(), session.storage(), session.auth()
            live_checks(manifest, target, fs=fs, mongo=mongo, storage=storage,
                        canary_project=mongo_canary_project(mongo))
            say(f"\n== {'REHEARSAL (no deletes)' if args.rehearse else 'EXECUTE — IRREVERSIBLE'} ==")
            say(f"target   {target.describe()}")
            say(f"manifest {manifest_path}\n         sha256 {manifest_sha}\n         frozen at {iso(manifest_time)}")
            say(f"delete   {manifest['totals']['delete']} record(s) listed; keep {manifest['totals']['keep']}")
            for store, per in manifest.get("counts", {}).items():
                for name, n in sorted(per.items()):
                    say(f"           {store:<10} {name:<40} {n:>7}")
            if not args.rehearse:
                require_typed_project(target.project, input_fn)
                require_typed_sha_prefix(manifest_sha, input_fn)
            run_stamp = stamp(now)
            log_path = out_dir / (f"reset-log-{run_stamp}.jsonl" if not args.rehearse
                                  else f"reset-rehearsal-{run_stamp}.jsonl")
            log = Log(log_path)
            try:
                summary = execute_manifest(manifest=manifest, manifest_sha=manifest_sha, manifest_time=manifest_time,
                                           target=target, fs=fs, mongo=mongo, storage=storage, auth=auth,
                                           log=log, apply=not args.rehearse)
            finally:
                log.close()
            summary_path = log_path.with_suffix(".summary.json")
            write_json(summary_path, {"kind": "zipper-reset-log-summary", "manifest_path": str(manifest_path),
                                      **summary})
            say("\n" + render_summary(summary))
            say(f"\nlog {log_path}\nsummary {summary_path}")
            if summary["totals"]["failed"]:
                say(f"\n{summary['totals']['failed']} delete(s) FAILED — re-run the same command to complete them.")
                return 1
            return 0
        finally:
            mongo.close()
            session.close()

    return run_main(go)


if __name__ == "__main__":
    sys.exit(main())
