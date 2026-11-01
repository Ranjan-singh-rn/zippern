"""Step 3 — PLAN: read everything, classify by THE TABLE, freeze the manifest. READ-ONLY.

    cd backend
    .venv/bin/python -m scripts.reset.plan \\
        --project <id> --bucket <bucket> --mongo-db <db> --mongo-uri-env MONGO_URI_RESET \\
        --credentials /path/key.json --backup-manifest reset-runs/<UTC>/backup-manifest.json \\
        --out-dir reset-runs/<UTC>

Writes reset-manifest-<UTC>.json — THE FROZEN MANIFEST: every Firestore
document path (subcollections walked), every Mongo _id, every Storage object
name (+generation) and every Auth uid that `execute` may delete, with counts
per collection/subcollection, three sample ids per collection, the target
identifiers, the backup-manifest reference and the table fingerprint.

REFUSES (writes nothing but a reset-plan-refused-<UTC>.json diagnostic) when:
  * the backup manifest is missing, was a dry run, has not passed `verify`,
    is for another target, or finished more than ONE HOUR ago;
  * the MongoDB database carries no data canary naming this project;
  * ANY collection, subcollection, Storage prefix or Mongo _id type is not
    in `classification.py` (UNKNOWN is never guessed at);
  * the live project / bucket / database differ from what was typed.

`manifest_time` is taken BEFORE the first read. `execute` skips any record
whose creation time is later than it, so a document created while this ran —
or after the Owner reviewed the manifest — is never deleted.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from scripts.reset import classification as T
from scripts.reset.adapters import encode_mongo_id
from scripts.reset.common import (MANIFEST_KIND, Refused, Target, check_backup_manifest, iso, mask_email,
                                  read_json, run_main, say, sha256_file, stamp, table, utc_now, validate_target,
                                  write_json)

SAMPLES = 3


class Unknowns:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, store: str, name: str, count: int, samples: list[str], why: str) -> None:
        self.rows.append({"store": store, "name": name, "count": count, "samples": samples[:SAMPLES], "why": why})

    def __bool__(self) -> bool:
        return bool(self.rows)


def _freeze_collection(fs: Any, parent_collection: str, collection_path: str, key: str, paths: list[str],
                       counts: dict[str, int], samples: dict[str, list[str]], unknown: Unknowns) -> int:
    """Freeze every document of one (sub)collection, depth-first, and walk its children.

    `list_doc_ids` also yields "missing" parents — a document deleted while a
    subcollection stayed behind. Their children are frozen; the phantom itself
    is not a document and is not listed. Returns the number of existing documents."""
    existing = dict(fs.list_docs(collection_path))
    for doc_id in fs.list_doc_ids(collection_path):
        doc_path = f"{collection_path}/{doc_id}"
        for sub in fs.list_subcollections(doc_path):
            sub_key = f"{key}/*/{sub}"
            if T.classify_subcollection(parent_collection, sub) != T.DELETE:
                sub_docs = fs.list_docs(f"{doc_path}/{sub}")
                unknown.add("firestore", sub_key, len(sub_docs), [f"{doc_path}/{sub}/{d}" for d, _ in sub_docs],
                            f"subcollection {sub!r} under {parent_collection!r} is not in FIRESTORE_SUBCOLLECTIONS")
                continue
            _freeze_collection(fs, sub, f"{doc_path}/{sub}", sub_key, paths, counts, samples, unknown)
        if doc_id in existing:
            paths.append(doc_path)
            counts[key] = counts.get(key, 0) + 1
            if len(samples.setdefault(key, [])) < SAMPLES:
                samples[key].append(doc_id if "/" not in key else doc_path)
    return len(existing)


def plan_firestore(fs: Any, unknown: Unknowns) -> tuple[list[dict], dict, dict, dict]:
    delete: list[dict] = []
    counts: dict[str, int] = {}
    keep: dict[str, int] = {}
    samples: dict[str, list[str]] = {}
    for coll in fs.list_collections():
        action = T.classify_firestore(coll)
        if action == T.KEEP:
            keep[coll] = fs.count(coll)
            continue
        if action != T.DELETE:
            docs = fs.list_docs(coll)
            unknown.add("firestore", coll, len(docs), [d for d, _ in docs], "collection not in the table")
            continue
        paths: list[str] = []
        _freeze_collection(fs, coll, coll, coll, paths, counts, samples, unknown)
        counts.setdefault(coll, 0)
        samples.setdefault(coll, [])
        delete.extend({"path": p} for p in paths)
    return delete, counts, keep, samples


def plan_mongo(mongo: Any, unknown: Unknowns) -> tuple[list[dict], dict, dict, dict]:
    delete: list[dict] = []
    counts: dict[str, int] = {}
    keep: dict[str, int] = {}
    samples: dict[str, list[str]] = {}
    for coll in mongo.list_collections():
        action = T.classify_mongo(coll)
        if action == T.KEEP:
            keep[coll] = mongo.count(coll)
            continue
        rows = mongo.find_ids(coll)
        if action != T.DELETE:
            unknown.add("mongo", coll, len(rows), [str(r.get("_id")) for r in rows], "collection not in the table")
            continue
        ids = []
        bad = []
        for r in rows:
            try:
                ids.append(encode_mongo_id(r.get("_id")))
            except ValueError as exc:
                bad.append(f"{r.get('_id')!r}: {exc}")
        if bad:
            unknown.add("mongo", f"{coll} (_id type)", len(bad), bad, "an _id shape that cannot be frozen exactly")
            continue
        counts[coll] = len(ids)
        samples[coll] = [str(i["v"]) for i in ids[:SAMPLES]]
        delete.extend({"collection": coll, "id": i} for i in ids)
    return delete, counts, keep, samples


def plan_storage(storage: Any, unknown: Unknowns) -> tuple[list[dict], dict, dict, dict]:
    if not storage.bucket_exists():
        raise Refused(f"bucket {storage.bucket_name()!r} does not exist or is not readable")
    delete: list[dict] = []
    counts: dict[str, int] = {}
    keep: dict[str, int] = {}
    samples: dict[str, list[str]] = {}
    unknown_by_prefix: dict[str, list[str]] = defaultdict(list)
    for obj in storage.list_objects():
        name = obj["name"]
        top = T.storage_prefix(name)
        action = T.classify_storage(name)
        if action == T.KEEP:
            keep[top] = keep.get(top, 0) + 1
        elif action == T.DELETE:
            delete.append({"name": name, "generation": obj.get("generation"), "size": int(obj.get("size") or 0)})
            counts[top] = counts.get(top, 0) + 1
            if len(samples.setdefault(top, [])) < SAMPLES:
                samples[top].append(name)
        else:
            unknown_by_prefix[top].append(name)
    for top, names in sorted(unknown_by_prefix.items()):
        why = ("UNDECIDED prefix: personal files whose deletion the spec did not approve — the Owner decides"
               if top in T.STORAGE_UNDECIDED else
               ("an object named exactly like a DELETE prefix (not under it)" if top in T.STORAGE_DELETE
                else "prefix not in the table"))
        unknown.add("storage", top, len(names), names, why)
    return delete, counts, keep, samples


def plan_auth(auth: Any) -> tuple[list[dict], dict, dict]:
    users = auth.list_users()
    if T.AUTH_SCOPE != T.DELETE:   # pragma: no cover — the table pins this
        raise Refused("AUTH_SCOPE is not DELETE; this tool only knows the Owner's all-accounts decision")
    delete = [{"uid": u["uid"], "created": iso(u["created"]) if u.get("created") else None,
               "email": mask_email(u.get("email") or ""), "providers": list(u.get("providers") or [])}
              for u in users]
    return delete, {"users": len(users)}, {"users": [u["uid"] for u in users[:SAMPLES]]}


def refuse_unknown(manifest: dict, out_dir: Path | None) -> None:
    """UNKNOWN is never guessed at: write the diagnostic (no delete lists) and refuse."""
    if not manifest.get("unknown"):
        return
    say(render(manifest))
    where = ""
    if out_dir is not None:
        path = out_dir / f"reset-plan-refused-{stamp(utc_now())}.json"
        write_json(path, {k: v for k, v in manifest.items() if k != "delete"})
        where = f" Diagnostic: {path}"
    listed = "; ".join(f"{u['store']}/{u['name']} ({u['count']}): {u['why']}" for u in manifest["unknown"][:12])
    raise Refused(f"{len(manifest['unknown'])} UNKNOWN name(s) — nothing is guessed. Decide each in "
                  f"scripts/reset/classification.py and re-plan. {listed}.{where}")


def build_manifest(*, target: Target, fs: Any, mongo: Any, storage: Any, auth: Any,
                   backup_manifest_path: Path, canary_project: str, now: datetime | None = None,
                   diagnostics_dir: Path | None = None) -> dict:
    manifest_time = now or utc_now()
    backup = read_json(backup_manifest_path)
    backup_finished = check_backup_manifest(backup, target, manifest_time, path=str(backup_manifest_path))
    if canary_project != target.project:
        raise Refused(f"the MongoDB database {target.mongo_db!r} has no data canary naming {target.project!r}"
                      + (f" (it names {canary_project!r})" if canary_project else "")
                      + " — see RESET-RUNBOOK.md step 0")
    if fs.project() != target.project:
        raise Refused(f"Firestore is project {fs.project()!r}, not {target.project!r}")
    if mongo.db_name() != target.mongo_db:
        raise Refused(f"MongoDB adapter is on database {mongo.db_name()!r}, not {target.mongo_db!r}")
    if storage.bucket_name() != target.bucket:
        raise Refused(f"Storage adapter is on bucket {storage.bucket_name()!r}, not {target.bucket!r}")
    problems = T.self_check()
    if problems:
        raise Refused("classification table is inconsistent: " + "; ".join(problems))

    unknown = Unknowns()
    fs_delete, fs_counts, fs_keep, fs_samples = plan_firestore(fs, unknown)
    mg_delete, mg_counts, mg_keep, mg_samples = plan_mongo(mongo, unknown)
    st_delete, st_counts, st_keep, st_samples = plan_storage(storage, unknown)
    au_delete, au_counts, au_samples = plan_auth(auth)

    manifest = {
        "kind": MANIFEST_KIND, "version": 1,
        "manifest_time": iso(manifest_time), "written_at": None,
        "target": target.as_dict(), "mongo_hosts": mongo.hosts(), "canary_project": canary_project,
        "table_fingerprint": T.table_fingerprint(),
        "backup": {"manifest_path": str(backup_manifest_path), "sha256": sha256_file(backup_manifest_path),
                   "finished": iso(backup_finished), "verified_at": (backup.get("verify") or {}).get("checked_at")},
        "counts": {"firestore": fs_counts, "mongo": mg_counts, "storage": st_counts, "auth": au_counts},
        "keep": {"firestore": fs_keep, "mongo": mg_keep, "storage": st_keep},
        "samples": {"firestore": fs_samples, "mongo": mg_samples, "storage": st_samples, "auth": au_samples},
        "delete": {"firestore": fs_delete, "mongo": mg_delete, "storage": st_delete, "auth": au_delete},
        "totals": {"delete": len(fs_delete) + len(mg_delete) + len(st_delete) + len(au_delete),
                   "keep": sum(fs_keep.values()) + sum(mg_keep.values()) + sum(st_keep.values())},
        "unknown": unknown.rows,
    }
    refuse_unknown(manifest, diagnostics_dir)
    return manifest


def render(manifest: dict) -> str:
    rows = []
    for store in ("firestore", "mongo", "storage", "auth"):
        for name, n in sorted(manifest["counts"].get(store, {}).items()):
            rows.append((store, name, "DELETE", n, ", ".join(manifest["samples"].get(store, {}).get(name, []))))
        for name, n in sorted(manifest.get("keep", {}).get(store, {}).items()):
            rows.append((store, name, "KEEP", n, ""))
    for u in manifest.get("unknown", []):
        rows.append((u["store"], u["name"], "UNKNOWN", u["count"], u["why"]))
    return table(rows, ("store", "collection / prefix", "action", "count", "samples / why"))


def write_manifest(manifest: dict, out_dir: Path) -> tuple[Path, str]:
    refuse_unknown(manifest, out_dir)   # defence in depth: never on disk with unknowns
    manifest["written_at"] = iso(utc_now())
    path = out_dir / f"reset-manifest-{stamp(utc_now())}.json"
    sha = write_json(path, manifest)
    return path, sha


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--mongo-db", required=True)
    ap.add_argument("--mongo-uri-env", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--backup-manifest", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args(argv)

    def go() -> int:
        target = validate_target(args.project, args.bucket, args.mongo_db, allow_demo=True)
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        # The backup must be fresh BEFORE anything connects.
        check_backup_manifest(read_json(args.backup_manifest), target, utc_now(), path=args.backup_manifest)
        from scripts.reset.common import mongo_uri_from_env
        from scripts.reset.live import FirebaseSession, LiveMongo, mongo_canary_project

        uri = mongo_uri_from_env(args.mongo_uri_env)
        session = FirebaseSession(target, args.credentials)
        mongo = LiveMongo(uri, target)
        try:
            manifest = build_manifest(
                target=target, fs=session.firestore(), mongo=mongo, storage=session.storage(),
                auth=session.auth(), backup_manifest_path=Path(args.backup_manifest),
                canary_project=mongo_canary_project(mongo), diagnostics_dir=out_dir)
        finally:
            mongo.close()
            session.close()
        path, sha = write_manifest(manifest, out_dir)
        say(render(manifest))
        say(f"\nFROZEN MANIFEST: {path}\n  sha256 {sha}\n  manifest_time {manifest['manifest_time']}"
            f"\n  delete {manifest['totals']['delete']} record(s); keep {manifest['totals']['keep']}"
            "\nNothing was written to the target. Review the manifest before `execute`.")
        return 0

    return run_main(go)


if __name__ == "__main__":
    sys.exit(main())
