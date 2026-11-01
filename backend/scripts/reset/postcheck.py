"""Step 6 — POSTCHECK: prove the reset did exactly what the manifest said. READ-ONLY.

    cd backend
    .venv/bin/python -m scripts.reset.postcheck \\
        --project <id> --bucket <bucket> --mongo-db <db> --mongo-uri-env MONGO_URI_RESET \\
        --credentials /path/key.json --manifest reset-runs/<UTC>/reset-manifest-<UTC>.json \\
        --seed-result reset-runs/<UTC>/seed-result-<UTC>.json --out-dir reset-runs/<UTC>

Checks, printed as a table and written to postcheck-<UTC>.json:
  * every id the manifest froze is gone — or exists only because it was created
    AFTER manifest_time (listed separately as post-manifest; never an error);
  * every DELETE collection / prefix holds 0 pre-manifest records; post-manifest
    records are counted and listed (the app was live) so a second plan+execute
    pass can be decided;
  * every KEEP collection / prefix holds exactly as many records as the plan
    counted (unchanged);
  * the Auth user count equals the seeded count (the Owners), and the Observer
    has no Auth account;
  * any collection / prefix that is in NO list (new since the plan) is reported.
Exit 0 when every check passes, 1 otherwise. Nothing is written to the target.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from scripts.reset import classification as T
from scripts.reset.adapters import FIRESTORE_CREATED_FIELDS, MONGO_CREATED_FIELDS, creation_time_of
from scripts.reset.common import (MANIFEST_KIND, POSTCHECK_KIND, SEED_RESULT_KIND, Refused, Target, as_datetime,
                                  iso, parse_iso, read_json, require_kind, require_same_target, run_main, say,
                                  stamp, table, target_from, utc_now, validate_target, write_json)


def _newer(created: datetime | None, manifest_time: datetime) -> bool:
    return created is not None and created > manifest_time


def _firestore_created(fields: dict) -> datetime | None:
    return as_datetime(fields.get("_create_time")) or creation_time_of(fields, *FIRESTORE_CREATED_FIELDS)


def _mongo_created(doc: dict) -> datetime | None:
    return creation_time_of(doc, *MONGO_CREATED_FIELDS) or as_datetime(getattr(doc.get("_id"), "generation_time", None))


def postcheck(*, manifest: dict, seed_result: dict | None, target: Target, fs: Any, mongo: Any,
              storage: Any, auth: Any, now: datetime | None = None) -> dict:
    require_kind(manifest, MANIFEST_KIND, "manifest")
    require_same_target(target_from(manifest), target, "manifest vs typed target")
    manifest_time = parse_iso(manifest.get("manifest_time"))
    if manifest_time is None:
        raise Refused("the manifest carries no usable manifest_time")
    rows: list[dict] = []

    def row(store: str, name: str, check: str, ok: bool, detail: str = "", **extra: Any) -> None:
        rows.append({"store": store, "name": name, "check": check, "ok": bool(ok), "detail": detail, **extra})

    d = manifest.get("delete") or {}
    keep = manifest.get("keep") or {}
    counts = manifest.get("counts") or {}

    # ── Every frozen id: gone, or newer than the manifest ────────────────────
    remaining: dict[str, int] = {}
    for e in d.get("firestore") or []:
        fields = fs.get_doc(str(e["path"]))
        if fields is not None and not _newer(_firestore_created(fields), manifest_time):
            remaining[f"firestore/{e['path']}"] = 1
    for e in d.get("mongo") or []:
        doc = mongo.find_one(str(e["collection"]), e["id"])
        if doc is not None and not _newer(_mongo_created(doc), manifest_time):
            remaining[f"mongo/{e['collection']}/{e['id'].get('v')}"] = 1
    for e in d.get("storage") or []:
        obj = storage.get_object(str(e["name"]))
        if obj is not None and str(obj.get("generation")) == str(e.get("generation")) \
                and not _newer(as_datetime(obj.get("time_created")), manifest_time):
            remaining[f"storage/{e['name']}"] = 1
    for e in d.get("auth") or []:
        user = auth.get_user(str(e["uid"]))
        if user is not None and not _newer(as_datetime(user.get("created")), manifest_time):
            remaining[f"auth/{e['uid']}"] = 1
    row("all", "frozen ids", "every frozen id is gone", not remaining,
        f"{len(remaining)} still present" if remaining else f"{manifest.get('totals', {}).get('delete', 0)} checked",
        remaining=sorted(remaining)[:50])

    # ── DELETE collections: 0 pre-manifest records; post-manifest listed ─────
    new_names: list[str] = []
    fs_live = fs.list_collections()
    for coll in fs_live:
        action = T.classify_firestore(coll)
        if action == T.DELETE:
            docs = fs.list_docs(coll)
            post = [doc_id for doc_id, f in docs if _newer(_firestore_created(f), manifest_time)]
            pre = len(docs) - len(post)
            row("firestore", coll, "DELETE collection empty (pre-manifest)", pre == 0,
                f"{pre} pre-manifest, {len(post)} post-manifest", post_manifest=post[:20])
        elif action == T.KEEP:
            n = fs.count(coll)
            expected = (keep.get("firestore") or {}).get(coll)
            if expected is None:
                row("firestore", coll, "KEEP collection appeared since the plan", False, f"{n} doc(s)")
            else:
                row("firestore", coll, "KEEP count unchanged", n == expected, f"{n} now, {expected} planned")
        else:
            new_names.append(f"firestore/{coll}")
    for coll, expected in (keep.get("firestore") or {}).items():
        if coll not in fs_live:
            row("firestore", coll, "KEEP collection still exists", expected == 0, f"missing; planned {expected}")

    mg_live = mongo.list_collections()
    for coll in mg_live:
        action = T.classify_mongo(coll)
        if action == T.DELETE:
            docs = mongo.find_ids(coll)
            post = [str(x.get("_id")) for x in docs if _newer(_mongo_created(x), manifest_time)]
            pre = len(docs) - len(post)
            row("mongo", coll, "DELETE collection empty (pre-manifest)", pre == 0,
                f"{pre} pre-manifest, {len(post)} post-manifest", post_manifest=post[:20])
        elif action == T.KEEP:
            n = mongo.count(coll)
            expected = (keep.get("mongo") or {}).get(coll)
            if expected is None:
                row("mongo", coll, "KEEP collection appeared since the plan", False, f"{n} doc(s)")
            else:
                row("mongo", coll, "KEEP count unchanged", n == expected, f"{n} now, {expected} planned")
        else:
            new_names.append(f"mongo/{coll}")

    st_pre: dict[str, int] = {}
    st_post: dict[str, list[str]] = {}
    st_keep: dict[str, int] = {}
    for obj in storage.list_objects():
        top = T.storage_prefix(obj["name"])
        action = T.classify_storage(obj["name"])
        if action == T.DELETE:
            if _newer(as_datetime(obj.get("time_created")), manifest_time):
                st_post.setdefault(top, []).append(obj["name"])
            else:
                st_pre[top] = st_pre.get(top, 0) + 1
        elif action == T.KEEP:
            st_keep[top] = st_keep.get(top, 0) + 1
        else:
            if top not in T.STORAGE_UNDECIDED and f"storage/{top}" not in new_names:
                new_names.append(f"storage/{top}")
    for top in sorted(set(T.STORAGE_DELETE) & (set(st_pre) | set(st_post) | set(counts.get("storage") or {}))):
        row("storage", top, "DELETE prefix empty (pre-manifest)", st_pre.get(top, 0) == 0,
            f"{st_pre.get(top, 0)} pre-manifest, {len(st_post.get(top, []))} post-manifest",
            post_manifest=st_post.get(top, [])[:20])
    for top, expected in sorted((keep.get("storage") or {}).items()):
        n = st_keep.get(top, 0)
        row("storage", top, "KEEP prefix count unchanged", n == expected, f"{n} now, {expected} planned")
    for top, n in sorted(st_keep.items()):
        if top not in (keep.get("storage") or {}):
            row("storage", top, "KEEP prefix appeared since the plan", False, f"{n} object(s)")

    # ── Auth ─────────────────────────────────────────────────────────────────
    users = auth.list_users()
    post_users = [u["uid"] for u in users if _newer(as_datetime(u.get("created")), manifest_time)]
    if seed_result is not None:
        require_kind(seed_result, SEED_RESULT_KIND, "seed result")
        expected_n = int(seed_result.get("auth_user_count_expected") or 0)
        seeded = {o["uid"] for o in seed_result.get("owners") or []}
        row("auth", "users", "Auth user count == seeded count", len(users) == expected_n,
            f"{len(users)} now, {expected_n} seeded; {len(post_users)} created after the manifest",
            unexpected=[u["uid"] for u in users if u["uid"] not in seeded][:20])
        obs_email = str((seed_result.get("observer") or {}).get("email") or "")
        if obs_email:
            row("auth", "observer", "Observer has no Auth account", auth.get_user_by_email(obs_email) is None)
    else:
        row("auth", "users", "Auth users (no seed result given)", len(users) == 0,
            f"{len(users)} now; {len(post_users)} created after the manifest")

    for name in new_names:
        row(*name.split("/", 1), "NEW name since the plan — classify it", False, "not in the table")

    passed = all(r["ok"] for r in rows)
    return {"kind": POSTCHECK_KIND, "checked_at": iso(now or utc_now()), "target": target.as_dict(),
            "manifest_time": iso(manifest_time), "passed": passed, "rows": rows}


def render(result: dict) -> str:
    return table([(("ok" if r["ok"] else "FAIL"), r["store"], r["name"], r["check"], r["detail"])
                  for r in result["rows"]], ("", "store", "name", "check", "detail"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--mongo-db", required=True)
    ap.add_argument("--mongo-uri-env", required=True)
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--seed-result", default="")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args(argv)

    def go() -> int:
        target = validate_target(args.project, args.bucket, args.mongo_db, allow_demo=True)
        manifest = read_json(args.manifest)
        seed_result = read_json(args.seed_result) if args.seed_result else None
        from scripts.reset.common import mongo_uri_from_env
        from scripts.reset.live import FirebaseSession, LiveMongo

        uri = mongo_uri_from_env(args.mongo_uri_env)
        session = FirebaseSession(target, args.credentials)
        mongo = LiveMongo(uri, target)
        try:
            result = postcheck(manifest=manifest, seed_result=seed_result, target=target, fs=session.firestore(),
                               mongo=mongo, storage=session.storage(), auth=session.auth())
        finally:
            mongo.close()
            session.close()
        out_dir = Path(args.out_dir)
        path = out_dir / f"postcheck-{stamp()}.json"
        write_json(path, result)
        say(render(result))
        say(f"\npostcheck: {'PASSED' if result['passed'] else 'FAILED'} — {path}")
        return 0 if result["passed"] else 1

    return run_main(go)


if __name__ == "__main__":
    sys.exit(main())
