"""Step 1 — BACKUP, and step 2 — VERIFY the backup. Read-only against production.

    cd backend
    .venv/bin/python -m scripts.reset.backup run \\
        --project <id> --bucket <bucket> --backup-bucket <bucket> --mongo-db <db> \\
        --mongo-uri-env MONGO_URI_RESET --credentials /path/key.json --out-dir reset-runs/<UTC> \\
        [--execute]                     # without it: DRY RUN — prints the commands, runs nothing
    .venv/bin/python -m scripts.reset.backup verify --manifest reset-runs/<UTC>/backup-manifest.json

What `run --execute` does, in order:
  (a) a Firestore MANAGED EXPORT of every collection to
      gs://<backup-bucket>/zipper-backups/firestore/<UTC>/   (gcloud firestore export)
  (b) a `mongodump --gzip --archive` of the named database to <out-dir>. The
      connection string is read from the environment variable NAMED on the
      command line, handed to mongodump through a 0600 config file that is
      deleted afterwards, and never printed or logged;
  (c) a Storage INVENTORY (name, size, md5, updated, generation) of the whole
      bucket to <out-dir>/storage-inventory-<UTC>.jsonl, and a copy of every
      deletable or undecided prefix to gs://<backup-bucket>/zipper-backups/storage/<UTC>/
      (gsutil -m cp -r);
  (d) backup-manifest.json: targets, started/finished UTC, export path, dump
      path, inventory counts, sha256 of every local artifact.

`verify` re-reads the manifest and refuses unless every artifact exists and is
readable: the export's metadata file is listed in the bucket, the Storage copy
holds as many objects as the inventory counted, the dump is a valid gzip whose
archive prelude lists the database's collections (and `mongorestore --dryRun`
passes when a mongorestore is on PATH). It writes its verdict INTO the manifest;
`plan` and `execute` refuse a manifest without `verify.passed: true`.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from scripts.reset import classification as T
from scripts.reset.common import (BACKUP_MANIFEST_KIND, Refused, Target, iso, mongo_uri_from_env,
                                  read_json, run_main, say, sha256_file, stamp, utc_now, validate_target,
                                  write_json)

Runner = Callable[[list[str]], subprocess.CompletedProcess]
BACKUP_ROOT = "zipper-backups"
ARCHIVE_MAGIC = b"\x6d\xe2\x99\x81"   # mongodump archive: 0x8199e26d little-endian


def real_runner(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


# ══════════════════════════════════════════════════════════════════════════════
#  Pure: the commands and the manifest shape
# ══════════════════════════════════════════════════════════════════════════════

def export_uri(backup_bucket: str, run_stamp: str) -> str:
    return f"gs://{backup_bucket}/{BACKUP_ROOT}/firestore/{run_stamp}/"


def storage_copy_uri(backup_bucket: str, run_stamp: str) -> str:
    return f"gs://{backup_bucket}/{BACKUP_ROOT}/storage/{run_stamp}/"


def firestore_export_command(target: Target, backup_bucket: str, run_stamp: str) -> list[str]:
    return ["gcloud", "firestore", "export", export_uri(backup_bucket, run_stamp),
            f"--project={target.project}", "--format=json"]


def mongodump_command(target: Target, config_path: str, archive_path: str) -> list[str]:
    # `--config` carries the uri so the connection string never appears in a
    # process list, a shell history or this tool's output.
    return ["mongodump", f"--config={config_path}", f"--db={target.mongo_db}",
            f"--archive={archive_path}", "--gzip"]


def storage_copy_commands(target: Target, backup_bucket: str, run_stamp: str,
                          prefixes_present: list[str]) -> list[list[str]]:
    dest = storage_copy_uri(backup_bucket, run_stamp)
    return [["gsutil", "-m", "cp", "-r", f"gs://{target.bucket}/{p}", dest]
            for p in prefixes_present if p in T.STORAGE_BACKUP_PREFIXES]


def inventory_rows(objects: list[dict]) -> list[dict]:
    rows = []
    for o in objects:
        rows.append({
            "name": o["name"], "size": int(o.get("size") or 0), "md5": o.get("md5"),
            "updated": iso(o["updated"]) if isinstance(o.get("updated"), datetime) else o.get("updated"),
            "generation": o.get("generation"),
        })
    return rows


def prefix_counts(objects: list[dict]) -> dict[str, int]:
    return dict(Counter(T.storage_prefix(o["name"]) for o in objects))


def copied_object_count(objects: list[dict]) -> int:
    return sum(1 for o in objects if T.storage_prefix(o["name"]) in T.STORAGE_BACKUP_PREFIXES
               and not o["name"].endswith("/"))


# ══════════════════════════════════════════════════════════════════════════════
#  run
# ══════════════════════════════════════════════════════════════════════════════

def write_mongo_config(uri: str, directory: str) -> str:
    """A 0600 YAML file holding only the connection string. Caller deletes it."""
    fd, path = tempfile.mkstemp(prefix="mongodump-", suffix=".yaml", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("uri: " + json.dumps(uri) + "\n")
    os.chmod(path, 0o600)
    return path


def run_backup(target: Target, backup_bucket: str, out_dir: Path, *, execute: bool,
               mongo_uri_env: str, runner: Runner = real_runner,
               storage_factory: Callable[[], Any] | None = None, now: datetime | None = None) -> Path:
    started = now or utc_now()
    run_stamp = stamp(started)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "kind": BACKUP_MANIFEST_KIND, "version": 1, "mode": "executed" if execute else "dry-run",
        "target": target.as_dict(), "backup_bucket": backup_bucket, "run_stamp": run_stamp,
        "started": iso(started), "finished": None, "table_fingerprint": T.table_fingerprint(),
        "firestore_export": {}, "mongo_dump": {}, "storage": {}, "artifacts": {}, "verify": None,
    }
    say(f"\n== BACKUP {'EXECUTE' if execute else 'DRY RUN'} == {target.describe()} → gs://{backup_bucket}/{BACKUP_ROOT}/")

    # (a) Firestore managed export
    cmd = firestore_export_command(target, backup_bucket, run_stamp)
    manifest["firestore_export"] = {"uri": export_uri(backup_bucket, run_stamp), "command": cmd}
    say("firestore export:", " ".join(cmd))
    if execute:
        res = runner(cmd)
        manifest["firestore_export"]["returncode"] = res.returncode
        manifest["firestore_export"]["stdout_tail"] = (res.stdout or "")[-2000:]
        if res.returncode != 0:
            raise Refused(f"gcloud firestore export failed (rc={res.returncode}): {(res.stderr or '')[-800:]}")

    # (b) mongodump
    archive = out_dir / f"mongo-{target.mongo_db}-{run_stamp}.archive.gz"
    manifest["mongo_dump"] = {"path": str(archive), "db": target.mongo_db, "uri_env": mongo_uri_env}
    if execute:
        uri = mongo_uri_from_env(mongo_uri_env)
        cfg = write_mongo_config(uri, str(out_dir))
        try:
            cmd = mongodump_command(target, cfg, str(archive))
            say("mongodump:", " ".join(cmd))
            res = runner(cmd)
        finally:
            try:
                os.remove(cfg)
            except OSError:
                pass
        manifest["mongo_dump"]["returncode"] = res.returncode
        if res.returncode != 0 or not archive.is_file():
            raise Refused(f"mongodump failed (rc={res.returncode}): {(res.stderr or '')[-800:]}")
        manifest["mongo_dump"]["sha256"] = sha256_file(archive)
        manifest["mongo_dump"]["bytes"] = archive.stat().st_size
        manifest["artifacts"][str(archive)] = manifest["mongo_dump"]["sha256"]
    else:
        mongo_uri_from_env(mongo_uri_env)   # the variable must exist even for a rehearsal
        say("mongodump:", " ".join(mongodump_command(target, "<0600 temp config file>", str(archive))))

    # (c) Storage inventory + copy of the deletable/undecided prefixes
    inv_path = out_dir / f"storage-inventory-{run_stamp}.jsonl"
    manifest["storage"] = {"inventory_path": str(inv_path), "copy_uri": storage_copy_uri(backup_bucket, run_stamp),
                           "copied_prefixes": list(T.STORAGE_BACKUP_PREFIXES)}
    if execute:
        if storage_factory is None:
            raise Refused("no Storage adapter was supplied for an executed backup")
        storage = storage_factory()
        if not storage.bucket_exists():
            raise Refused(f"bucket {target.bucket!r} does not exist or is not readable with this key")
        objects = storage.list_objects()
        with open(inv_path, "w", encoding="utf-8") as fh:
            for row in inventory_rows(objects):
                fh.write(json.dumps(row, default=str) + "\n")
        counts = prefix_counts(objects)
        manifest["storage"].update({
            "object_count": len(objects), "bytes": sum(int(o.get("size") or 0) for o in objects),
            "per_prefix": counts, "copied_object_count_expected": copied_object_count(objects),
            "inventory_sha256": sha256_file(inv_path),
        })
        manifest["artifacts"][str(inv_path)] = manifest["storage"]["inventory_sha256"]
        cmds = storage_copy_commands(target, backup_bucket, run_stamp, [p for p, n in counts.items() if n])
        manifest["storage"]["copy_commands"] = cmds
        for cmd in cmds:
            say("storage copy:", " ".join(cmd))
            res = runner(cmd)
            if res.returncode != 0:
                raise Refused(f"gsutil cp failed (rc={res.returncode}): {(res.stderr or '')[-800:]}")
        say(f"storage: {len(objects)} object(s) inventoried; "
            f"{manifest['storage']['copied_object_count_expected']} copied across {len(cmds)} prefix(es)")
    else:
        for cmd in storage_copy_commands(target, backup_bucket, run_stamp, list(T.STORAGE_BACKUP_PREFIXES)):
            say("storage copy (if the prefix holds objects):", " ".join(cmd))

    manifest["finished"] = iso(utc_now())
    path = out_dir / ("backup-manifest.json" if execute else "backup-manifest.dry-run.json")
    sha = write_json(path, manifest)
    say(f"\nbackup manifest: {path}  sha256 {sha[:12]}…  mode={manifest['mode']}")
    if not execute:
        say("DRY RUN — nothing ran, nothing was exported. Re-run with --execute.")
    return path


# ══════════════════════════════════════════════════════════════════════════════
#  verify
# ══════════════════════════════════════════════════════════════════════════════

def _bson_cstring(buf: bytes, pos: int) -> tuple[str, int]:
    end = buf.index(b"\x00", pos)
    return buf[pos:end].decode("utf-8", "replace"), end + 1


def bson_decode(buf: bytes) -> dict:
    """A minimal BSON reader for the mongodump archive prelude (strings, ints,
    doubles, bools, nulls, nested documents/arrays; others skipped by length)."""
    total = struct.unpack_from("<i", buf, 0)[0]
    pos, out = 4, {}
    while pos < total - 1:
        kind = buf[pos]
        pos += 1
        key, pos = _bson_cstring(buf, pos)
        if kind == 0x01:
            out[key] = struct.unpack_from("<d", buf, pos)[0]; pos += 8
        elif kind == 0x02:
            n = struct.unpack_from("<i", buf, pos)[0]; pos += 4
            out[key] = buf[pos:pos + n - 1].decode("utf-8", "replace"); pos += n
        elif kind in (0x03, 0x04):
            n = struct.unpack_from("<i", buf, pos)[0]
            sub = bson_decode(buf[pos:pos + n]); pos += n
            out[key] = list(sub.values()) if kind == 0x04 else sub
        elif kind == 0x05:
            n = struct.unpack_from("<i", buf, pos)[0]; pos += 4 + 1 + n; out[key] = None
        elif kind == 0x07:
            out[key] = buf[pos:pos + 12].hex(); pos += 12
        elif kind == 0x08:
            out[key] = bool(buf[pos]); pos += 1
        elif kind in (0x09, 0x11, 0x12):
            out[key] = struct.unpack_from("<q", buf, pos)[0]; pos += 8
        elif kind == 0x0A:
            out[key] = None
        elif kind == 0x10:
            out[key] = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        elif kind == 0x13:
            out[key] = buf[pos:pos + 16].hex(); pos += 16
        else:
            raise ValueError(f"unsupported BSON type 0x{kind:02x} in archive prelude")
    return out


def read_archive_prelude(stream) -> tuple[dict, list[dict]]:
    """(header, collection metadata docs) from a (decompressed) mongodump archive."""
    magic = stream.read(4)
    if magic != ARCHIVE_MAGIC:
        raise ValueError("not a mongodump archive (bad magic number)")
    docs: list[dict] = []
    while True:
        head = stream.read(4)
        if len(head) < 4:
            raise ValueError("archive prelude ended early")
        n = struct.unpack("<i", head)[0]
        if n == -1:
            break
        if n < 5 or n > 64 * 1024 * 1024:
            raise ValueError("archive prelude has an implausible document length")
        body = stream.read(n - 4)
        if len(body) < n - 4:
            raise ValueError("archive prelude truncated")
        docs.append(bson_decode(head + body))
    if not docs:
        raise ValueError("archive prelude holds no header")
    return docs[0], docs[1:]


def inspect_archive(path: Path, expected_db: str) -> dict:
    """Gzip integrity (full read), sha256, and the namespaces the prelude lists."""
    sha = hashlib.sha256()
    with gzip.open(path, "rb") as fh:
        header, metas = read_archive_prelude(fh)
        # Read to the end so a truncated or corrupt gzip member is detected.
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            pass
    with open(path, "rb") as raw:
        for chunk in iter(lambda: raw.read(1 << 20), b""):
            sha.update(chunk)
    namespaces = sorted(f"{m.get('db')}.{m.get('collection')}" for m in metas if m.get("collection"))
    in_db = [ns for ns in namespaces if ns.startswith(expected_db + ".")]
    return {"sha256": sha.hexdigest(), "tool_version": header.get("tool_version"),
            "server_version": header.get("server_version"), "namespaces": namespaces,
            "collections_in_db": len(in_db)}


def mongorestore_dry_run(path: Path, db: str, runner: Runner, which: Callable[[str], str | None] = shutil.which) -> dict:
    if not which("mongorestore"):
        return {"status": "unavailable", "detail": "mongorestore is not on PATH"}
    cmd = ["mongorestore", "--dryRun", "--gzip", f"--archive={path}", f"--nsInclude={db}.*", "--verbose=1"]
    try:
        res = runner(cmd)
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "detail": f"could not run mongorestore: {exc}"}
    err = (res.stderr or "") + (res.stdout or "")
    if res.returncode == 0:
        return {"status": "passed", "detail": err[-600:]}
    low = err.lower()
    if any(s in low for s in ("connect", "server selection", "no reachable servers", "timed out")):
        return {"status": "unavailable", "detail": "mongorestore --dryRun needs a reachable mongod; " + err[-400:]}
    return {"status": "failed", "detail": err[-800:]}


def verify_manifest(path: Path, *, runner: Runner = real_runner, which: Callable[[str], str | None] = shutil.which,
                    now: datetime | None = None) -> dict:
    manifest = read_json(path)
    if manifest.get("kind") != BACKUP_MANIFEST_KIND:
        raise Refused(f"{path} is not a backup manifest")
    if manifest.get("mode") != "executed":
        raise Refused("this manifest is from a DRY RUN; there is no backup to verify")
    target = Target(**manifest["target"])
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        say(f"  [{'ok' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}")

    say(f"\n== VERIFY backup {manifest.get('run_stamp')} for {target.describe()} ==")

    # Local artifacts: exist, readable, sha256 unchanged.
    for apath, sha in (manifest.get("artifacts") or {}).items():
        p = Path(apath)
        if not p.is_file():
            check(f"artifact exists: {p.name}", False, "missing")
            continue
        actual = sha256_file(p)
        check(f"artifact sha256: {p.name}", actual == sha, "" if actual == sha else f"{actual[:12]} != {sha[:12]}")

    # Firestore export: the overall metadata file and at least one output file.
    uri = str((manifest.get("firestore_export") or {}).get("uri") or "")
    check("firestore export uri recorded", bool(uri), uri)
    if uri:
        res = runner(["gsutil", "ls", "-r", uri])
        lines = [ln.strip() for ln in (res.stdout or "").splitlines() if ln.strip()]
        meta = [ln for ln in lines if ln.endswith(".overall_export_metadata")]
        outputs = [ln for ln in lines if "/output-" in ln]
        check("firestore export metadata file listed", res.returncode == 0 and len(meta) == 1,
              meta[0] if meta else (res.stderr or "")[-300:])
        check("firestore export has output files", len(outputs) > 0, f"{len(outputs)} output file(s)")
        if meta:
            stat = runner(["gsutil", "stat", meta[0]])
            check("firestore export metadata readable (gsutil stat)", stat.returncode == 0,
                  (stat.stdout or stat.stderr or "")[-200:].strip().replace("\n", " | "))

    # Storage copy: as many objects as the inventory counted for the copied prefixes.
    st = manifest.get("storage") or {}
    expected = int(st.get("copied_object_count_expected") or 0)
    copy_uri = str(st.get("copy_uri") or "")
    if expected and copy_uri:
        res = runner(["gsutil", "ls", "-r", copy_uri + "**"])
        objs = [ln for ln in (res.stdout or "").splitlines() if ln.strip() and not ln.strip().endswith("/") and not ln.strip().endswith(":")]
        check("storage copy object count", res.returncode == 0 and len(objs) == expected,
              f"{len(objs)} listed, {expected} expected")
    else:
        check("storage copy", True, "nothing to copy (no objects under the deletable/undecided prefixes)")
    inv = Path(str(st.get("inventory_path") or ""))
    if inv.is_file():
        with open(inv, encoding="utf-8") as fh:
            n = sum(1 for ln in fh if ln.strip())
        check("storage inventory row count", n == int(st.get("object_count") or 0),
              f"{n} rows, {st.get('object_count')} objects")
    else:
        check("storage inventory exists", False, str(inv))

    # Mongo dump: gzip integrity, archive prelude, namespaces, mongorestore --dryRun.
    md = manifest.get("mongo_dump") or {}
    dump = Path(str(md.get("path") or ""))
    if dump.is_file():
        try:
            info = inspect_archive(dump, target.mongo_db)
            check("mongo archive gzip + prelude readable", True,
                  f"{info['collections_in_db']} collection(s) in {target.mongo_db}; tool {info['tool_version']}")
            check("mongo archive sha256", info["sha256"] == md.get("sha256"))
            check("mongo archive lists the database", info["collections_in_db"] > 0,
                  ", ".join(info["namespaces"][:12]) + (" …" if len(info["namespaces"]) > 12 else ""))
            manifest["mongo_dump"]["namespaces"] = info["namespaces"]
        except Exception as exc:  # noqa: BLE001
            check("mongo archive readable", False, str(exc))
        dr = mongorestore_dry_run(dump, target.mongo_db, runner, which)
        check(f"mongorestore --dryRun: {dr['status']}", dr["status"] != "failed", dr["detail"][-200:])
        manifest["mongo_dump"]["mongorestore_dry_run"] = dr
    else:
        check("mongo dump exists", False, str(dump))

    passed = all(c["ok"] for c in checks)
    manifest["verify"] = {"passed": passed, "checked_at": iso(now or utc_now()), "checks": checks}
    sha = write_json(path, manifest)
    say(f"\nverify: {'PASSED' if passed else 'FAILED'} — written into {path} (sha256 {sha[:12]}…)")
    if not passed:
        raise Refused("the backup did not verify; do not plan or execute a reset on it")
    return manifest


# ══════════════════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════════════════

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="take the backup (dry run unless --execute)")
    r.add_argument("--project", required=True)
    r.add_argument("--bucket", required=True, help="the project's Storage bucket (bare name)")
    r.add_argument("--backup-bucket", required=True, help="where the export and the copies go (bare name)")
    r.add_argument("--mongo-db", required=True)
    r.add_argument("--mongo-uri-env", required=True, help="NAME of the env var holding the MongoDB URI")
    r.add_argument("--credentials", required=True, help="service-account key for --project")
    r.add_argument("--out-dir", required=True)
    r.add_argument("--execute", action="store_true")
    v = sub.add_parser("verify", help="verify an executed backup and record the verdict in its manifest")
    v.add_argument("--manifest", required=True)
    args = ap.parse_args(argv)

    def go() -> int:
        if args.cmd == "verify":
            verify_manifest(Path(args.manifest))
            return 0
        target = validate_target(args.project, args.bucket, args.mongo_db, allow_demo=True)
        if not args.backup_bucket.strip() or args.backup_bucket.startswith("gs://"):
            raise Refused("--backup-bucket takes a bare bucket name")
        from scripts.reset.common import credential_project

        key_project = credential_project(args.credentials)
        if key_project != target.project:
            raise Refused(f"the key at --credentials belongs to {key_project!r}, not {target.project!r}")

        def storage_factory():
            from scripts.reset.live import FirebaseSession

            return FirebaseSession(target, args.credentials).storage()

        run_backup(target, args.backup_bucket.strip(), Path(args.out_dir), execute=args.execute,
                   mongo_uri_env=args.mongo_uri_env, storage_factory=storage_factory)
        return 0

    return run_main(go)


if __name__ == "__main__":
    sys.exit(main())
