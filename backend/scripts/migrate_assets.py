"""Move the gift and bag-item assets, and the documents that point at them.

    python -m scripts.migrate_assets            # dry run — probes, decides, writes nothing
    python -m scripts.migrate_assets --confirm  # copy the files, rewrite the documents

Twenty-eight asset URLs live *inside* Firestore documents — `gifts.imageUrl`,
`gifts.lottieAsset`, `bagItems.previewUrl`, `bagItems.animationUrl`. Copying the
objects to a new bucket is only half of it; a document still naming the old
bucket is a broken gift in the app.

WHY THIS AND NOT gsutil rsync
─────────────────────────────
Every stored URL has the shape

    https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=<uuid>

That `token` is not part of the file. It is a value in the object's custom
metadata, `firebaseStorageDownloadTokens`, and Firebase's download endpoint
compares the query parameter against it. Two consequences decide the approach:

  · A raw copy that loses custom metadata produces objects with no token at all.
    The rewritten URL then answers 403 for every visitor, and it answers it
    *only in production* — an authenticated `gsutil cat` still works, so the
    copy looks fine from the terminal. That is the naive version's failure.
  · Even where a copy does carry the metadata across, reusing the old token
    keeps the new bucket's URLs tied to a value minted inside a project someone
    else controls. There is no reason to.

So each object gets a **freshly minted token** in the new bucket, and the URL is
rebuilt around it. Nothing depends on metadata surviving a copy.

The bytes are fetched over the **existing public download URL**, not from the
old bucket by API. That URL carries its own token, so it needs no credentials
and no IAM on `dating-app-967f3` at all — which matters, because the account
that owns that project is not one to depend on. Twenty-eight small files.

Re-running the old uploaders instead was considered and does not work: the
local sources cover eleven entrances only. The `tank` entrance and both gift
assets — six of the twenty-eight objects — exist nowhere but the old bucket.
Where a local source does exist it is used as a fallback, and said so.

WHAT ELSE THIS DOES
───────────────────
`scripts.restore_config` restores configuration and deliberately not content, so
`gifts` and `bagItems` — the two collections `scripts.reset_firestore` protects —
have no other route into a new project. They are imported here, whole, with
their URLs already corrected. A document that exists in the target is patched on
its URL fields only; a document that does not is created from the backup.

Every rewritten URL is fetched afterwards and must return 200 with the right
number of bytes. Anything that does not is named. Nothing is left silently
broken.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

REPO = Path(__file__).resolve().parents[2]
BACKEND = Path(__file__).resolve().parents[1]

# Imported lazily so a dry run works on a machine that has not installed the
# backend requirements yet — the probe and the plan need neither.
try:  # pragma: no cover - environment dependent
    from app.db import firebase  # noqa: E402
except Exception:  # noqa: BLE001
    firebase = None  # type: ignore[assignment]

OLD_BUCKET = "dating-app-967f3.firebasestorage.app"
DOWNLOAD_HOST = "https://firebasestorage.googleapis.com"

# Imported whole. These are the two collections reset_firestore protects and
# restore_config does not touch, so nothing else carries them across.
CONTENT_COLLECTIONS = ["gifts", "bagItems"]

# Fields that hold an asset URL. Used for the merge path, so an existing
# document is patched rather than overwritten.
URL_FIELDS = {"imageUrl", "lottieAsset", "previewUrl", "animationUrl", "thumbnailUrl"}

# Where a local copy of an asset lives, if one does. doc id → (field, path).
LOCAL_SOURCES = {
    "animationUrl": REPO / "functions" / "entry-lotties" / "{doc}.json",
    "previewUrl": REPO / "functions" / "entry-thumbnails" / "{doc}.webp",
}

CONTENT_TYPES = {
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".svga": "application/octet-stream",
}


# ── The backup ────────────────────────────────────────────────────────────────


def decode(value: Any) -> Any:
    """Reverse the encoding used by backup_firestore. Same as restore_config."""
    if isinstance(value, dict):
        kind = value.get("__type__")
        if kind == "timestamp":
            from datetime import datetime

            return datetime.fromisoformat(value["value"])
        if kind == "bytes":
            return bytes.fromhex(value["value"])
        if kind == "geopoint":
            from google.cloud.firestore_v1 import GeoPoint

            return GeoPoint(value["latitude"], value["longitude"])
        if kind == "reference":
            return firebase.firestore_client().document(value["path"])
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def latest_backup() -> Path | None:
    root = BACKEND / "backups"
    if not root.exists():
        return None
    runs = sorted(p for p in root.iterdir() if p.is_dir() and p.name.startswith("firestore-"))
    return runs[-1] if runs else None


# ── Assets ────────────────────────────────────────────────────────────────────


class Asset:
    """One object in the old bucket, and every document field pointing at it."""

    def __init__(self, object_path: str, old_url: str) -> None:
        self.object_path = object_path      # contentAssets/gifts/ship/lottie.json
        self.old_url = old_url
        self.refs: list[tuple[str, str, str]] = []   # collection, doc id, field
        self.source_status: str = "not probed"
        self.source_bytes: int | None = None
        self.source: str = "old bucket"
        self.new_url: str | None = None
        self.verify: str = "not checked"

    @property
    def name(self) -> str:
        return self.object_path.split("/", 2)[-1]


def parse_url(url: str) -> str | None:
    """Return the object path if this is a download URL for the OLD bucket."""
    prefix = f"{DOWNLOAD_HOST}/v0/b/{OLD_BUCKET}/o/"
    if not url.startswith(prefix):
        return None
    encoded = url[len(prefix):].split("?", 1)[0]
    return urllib.parse.unquote(encoded)


def walk_strings(node: Any, trail: str = ""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk_strings(value, f"{trail}.{key}" if trail else key)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from walk_strings(value, f"{trail}[{i}]")
    elif isinstance(node, str):
        yield trail, node


def collect(backup: Path) -> tuple[dict[str, Asset], dict[str, list[dict]], list[str]]:
    """Read the backup. Returns assets, the content docs, and stray collections."""
    assets: dict[str, Asset] = {}
    docs: dict[str, list[dict]] = {}
    strays: list[str] = []

    for path in sorted(backup.glob("*.json")):
        if path.name == "_manifest.json":
            continue
        collection = path.stem
        try:
            rows = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        if not isinstance(rows, list):
            continue

        if collection in CONTENT_COLLECTIONS:
            docs[collection] = rows

        found_here = False
        for row in rows:
            for field, value in walk_strings(row.get("data") or {}):
                object_path = parse_url(value)
                if object_path is None:
                    continue
                found_here = True
                asset = assets.setdefault(object_path, Asset(object_path, value))
                asset.refs.append((collection, row["id"], field))

        if found_here and collection not in CONTENT_COLLECTIONS:
            strays.append(collection)

    return assets, docs, strays


# ── HTTP, with no dependency beyond the standard library ──────────────────────


def probe(url: str, timeout: int = 30) -> tuple[str, int | None]:
    """Does this URL resolve? Returns a short status and the byte length.

    HEAD first, then a one-byte ranged GET if HEAD is refused — some fronting
    layers answer HEAD with 405 on a URL that serves perfectly well. Falling
    back means a working asset is never reported as broken.
    """
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            return "ok", int(length) if length else None
    except urllib.error.HTTPError as exc:
        head_status = f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return f"unreachable ({type(exc).__name__})", None

    ranged = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
    try:
        with urllib.request.urlopen(ranged, timeout=timeout) as response:
            response.read(1)
            content_range = response.headers.get("Content-Range") or ""
            total = content_range.rpartition("/")[2]
            if total.isdigit():
                return "ok", int(total)
            length = response.headers.get("Content-Length")
            return "ok", int(length) if length else None
    except urllib.error.HTTPError as exc:
        return f"HTTP {exc.code}", None
    except Exception:  # noqa: BLE001
        return head_status, None


def fetch(url: str, timeout: int = 120) -> tuple[bytes, str | None]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read(), response.headers.get("Content-Type")


def content_type_for(object_path: str, sniffed: str | None) -> str:
    suffix = Path(object_path).suffix.lower()
    if suffix in CONTENT_TYPES:
        return CONTENT_TYPES[suffix]
    if sniffed and sniffed != "application/octet-stream":
        return sniffed.split(";")[0].strip()
    return mimetypes.guess_type(object_path)[0] or "application/octet-stream"


def download_url(bucket: str, object_path: str, token: str) -> str:
    encoded = urllib.parse.quote(object_path, safe="")
    return f"{DOWNLOAD_HOST}/v0/b/{bucket}/o/{encoded}?alt=media&token={token}"


def local_source(collection: str, doc_id: str, field: str) -> Path | None:
    template = LOCAL_SOURCES.get(field)
    if template is None or collection != "bagItems":
        return None
    candidate = Path(str(template).replace("{doc}", doc_id))
    return candidate if candidate.exists() else None


# ── The target bucket ─────────────────────────────────────────────────────────


def bucket_from_env() -> str | None:
    """Read the bucket the CRM is pointed at — retarget_project sets it."""
    env = REPO / "zipper-crm" / ".env.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        key, _, value = line.partition("=")
        if key.strip() == "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET":
            return value.strip() or None
    return None


# ── Main ──────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m scripts.migrate_assets",
        description="Copy the content assets to the new bucket and rewrite the "
                    "documents that name them.",
    )
    p.add_argument("--backup", default=None,
                   help="Backup directory. Default: the most recent one.")
    p.add_argument("--bucket", default=None,
                   help="Target bucket. Default: read from zipper-crm/.env.local.")
    p.add_argument("--probe-only", action="store_true",
                   help="Only check that the old URLs still resolve. Needs no "
                        "target bucket and no credentials — run it before you "
                        "start, while the old project is still reachable.")
    p.add_argument("--no-probe", action="store_true",
                   help="Skip the source reachability check. Only for planning "
                        "offline — --confirm always probes.")
    p.add_argument("--skip-unreachable", action="store_true",
                   help="Migrate what can be fetched instead of refusing when "
                        "something cannot.")
    p.add_argument("--confirm", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    a = parse_args(argv)

    # ── Where from ────────────────────────────────────────────────────────────
    backup = Path(a.backup) if a.backup else latest_backup()
    if backup is None or not backup.exists():
        print(
            "\n  ✗ No backup found in backend/backups/.\n\n"
            "    The assets and the documents that name them are read from one.\n"
            "    Take it against the OLD project, while you still can:\n"
            "      python -m scripts.backup_firestore\n"
        )
        return 1

    # ── Where to ──────────────────────────────────────────────────────────────
    bucket_name = a.bucket or bucket_from_env()
    if a.probe_only:
        bucket_name = bucket_name or "(none — --probe-only)"
    elif not bucket_name:
        print(
            "\n  ✗ No target bucket.\n\n"
            "    Either pass --bucket <new>.firebasestorage.app, or run\n"
            "      python -m scripts.retarget_project ... --confirm\n"
            "    first, which sets it in zipper-crm/.env.local.\n"
        )
        return 1
    if bucket_name == OLD_BUCKET and not a.probe_only:
        print(
            f"\n  ✗ The target bucket is still {OLD_BUCKET}.\n\n"
            "    That is the bucket being left. Run scripts.retarget_project\n"
            "    first, or pass --bucket explicitly.\n"
        )
        return 1

    assets, docs, strays = collect(backup)

    if not assets:
        print(f"\n  ✗ No {OLD_BUCKET} URLs in {backup.name}.\n")
        print("    Either this backup is already migrated, or it is the wrong one.\n")
        return 1

    if a.probe_only:
        print(f"\n  Checking the old content assets from {backup.name}")
        print("  PROBE ONLY — nothing is copied and nothing is written\n")
    else:
        print(f"\n  Migrating content assets from {backup.name}")
        print(f"  {'WRITING' if a.confirm else 'DRY RUN — nothing will be written'}\n")
    print(f"    from bucket   {OLD_BUCKET}")
    if not a.probe_only:
        print(f"    to bucket     {bucket_name}")
    print(f"    documents     {sum(len(v) for v in docs.values())} in "
          f"{', '.join(f'{k} ({len(v)})' for k, v in docs.items())}")
    print(f"    asset objects {len(assets)}, referenced "
          f"{sum(len(x.refs) for x in assets.values())} time(s)")

    if strays:
        print(
            "\n  ⚠  These collections also hold old-bucket URLs and are NOT part of\n"
            "     the content import. Their objects are copied and their URLs are\n"
            "     rebuilt below, but their documents are not written — say so and\n"
            "     they can be added to CONTENT_COLLECTIONS:"
        )
        for name in strays:
            print(f"       · {name}")

    # ── Can the sources still be read? ────────────────────────────────────────
    probing = a.confirm or a.probe_only or not a.no_probe
    unreachable: list[Asset] = []
    if probing:
        print("\n  Checking the old URLs still resolve")
        for asset in sorted(assets.values(), key=lambda x: x.object_path):
            status, length = probe(asset.old_url)
            asset.source_status, asset.source_bytes = status, length
            if status != "ok":
                collection, doc_id, field = asset.refs[0]
                fallback = local_source(collection, doc_id, field)
                if fallback is not None:
                    asset.source = f"local: {fallback.relative_to(REPO).as_posix()}"
                    asset.source_bytes = fallback.stat().st_size
                    asset.source_status = "ok (local copy)"
                else:
                    unreachable.append(asset)
        ok = sum(1 for x in assets.values() if x.source_status.startswith("ok"))
        print(f"    {ok} of {len(assets)} readable")
    else:
        print("\n  ⚠  --no-probe: the old URLs were not checked. This plan assumes")
        print("     they all still resolve, which is the thing most likely to be")
        print("     untrue. --confirm probes regardless.")

    if unreachable:
        print(f"\n  ⚠  {len(unreachable)} object(s) cannot be read and have no local copy")
        for asset in unreachable:
            print(f"    · {asset.object_path}")
            print(f"        {asset.source_status}")
            for collection, doc_id, field in asset.refs:
                print(f"        used by {collection}/{doc_id}.{field}")
        if a.confirm and not a.skip_unreachable:
            print(
                "\n  ✗ Refusing to write. A half-migrated catalogue is worse than an\n"
                "    un-migrated one: the app shows some gifts and silently fails on\n"
                "    the rest, and nothing says which.\n\n"
                "    Either the old project has gone, or the download tokens on those\n"
                "    objects were rotated. If you have the files, drop them in and\n"
                "    re-run. To go ahead without them anyway:\n"
                "      python -m scripts.migrate_assets --confirm --skip-unreachable\n"
                "    Those documents keep their old, broken URLs and are listed again\n"
                "    at the end.\n"
            )
            return 1

    if a.probe_only:
        if unreachable:
            print(
                f"\n  {len(unreachable)} of {len(assets)} asset(s) are already out of\n"
                "  reach. Find those files before you go any further — after the\n"
                "  move there is nowhere left to get them from.\n"
            )
            return 1
        print(
            f"\n  All {len(assets)} asset(s) are readable. Nothing was copied and\n"
            "  nothing was written. Carry on with MIGRATION.md § 1.\n"
        )
        return 0

    # ── Plan ──────────────────────────────────────────────────────────────────
    print(f"\n  {'COPYING' if a.confirm else 'WOULD COPY'} — same object paths, new download tokens")
    width = max(len(x.object_path) for x in assets.values())
    for asset in sorted(assets.values(), key=lambda x: x.object_path):
        size = f"{asset.source_bytes:,} B" if asset.source_bytes else "size unknown"
        note = "" if asset.source == "old bucket" else f"  ← {asset.source}"
        print(f"    · {asset.object_path:<{width}}  {size}{note}")

    if not a.confirm:
        print(f"\n  {'WOULD REWRITE'}")
        for collection, rows in docs.items():
            touched = sorted({
                doc_id
                for asset in assets.values()
                for c, doc_id, _f in asset.refs
                if c == collection
            })
            print(f"    · {collection}: {len(rows)} document(s), "
                  f"{len(touched)} carrying an asset URL")
        print(f"\n  {len(assets)} object(s) and "
              f"{sum(len(v) for v in docs.values())} document(s) would move.")
        print("\n  Nothing has changed. To go ahead:")
        rerun = [x for x in argv if x != "--no-probe"]
        print("    python -m scripts.migrate_assets " + " ".join(rerun) + " --confirm\n")
        return 0

    # ── Write ─────────────────────────────────────────────────────────────────
    if firebase is None:
        print(
            "\n  ✗ The backend package could not be imported, so nothing can be\n"
            "    written. From backend/, with the virtualenv active:\n"
            "      pip install -r requirements.txt\n"
        )
        return 1

    from app.config import settings  # noqa: E402
    from firebase_admin import storage as fb_storage  # noqa: E402
    from google.api_core.exceptions import NotFound  # noqa: E402

    if settings.firebase_project_id and not bucket_name.startswith(
        settings.firebase_project_id + "."
    ):
        print(
            f"\n  ✗ backend/.env points at project '{settings.firebase_project_id}'\n"
            f"    but the target bucket is '{bucket_name}'. One of the two is stale,\n"
            "    and writing the documents into the wrong project is not something\n"
            "    a later run can undo. Fix backend/.env, or pass --bucket.\n"
        )
        return 1

    firebase.init()
    fs = firebase.firestore_client()
    target = fb_storage.bucket(bucket_name)

    # Ask whether the bucket is actually there before downloading 160MB and
    # discovering it on the first PUT. Storage has to be turned on by hand in the
    # console — it is not created with the project — so "bucket does not exist"
    # is the single likeliest way this script fails, and a raw 404 traceback out
    # of the upload library says nothing about which button to press.
    try:
        if not target.exists():
            raise NotFound(bucket_name)
    except NotFound:
        print(
            f"\n  ✗ The bucket {bucket_name} does not exist.\n\n"
            "    Firebase does not create it with the project — Storage is a\n"
            "    separate step. In the console:\n\n"
            "      Build → Storage → Get started → production mode\n"
            "      Location: asia-south1   (fixed at creation, like Firestore)\n\n"
            "    Then run this again. Nothing has been written, so re-running\n"
            "    is clean.\n"
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        # A permission error here is worth showing plainly too, rather than
        # letting it surface 160MB later as a failed upload.
        print(
            f"\n  ✗ Could not reach the bucket {bucket_name}.\n\n"
            f"    {exc}\n\n"
            "    Check that serviceAccountKey.json belongs to the project that\n"
            "    owns this bucket:\n"
            "      python3 -c \"import json;print(json.load("
            "open('serviceAccountKey.json'))['project_id'])\"\n"
        )
        return 1

    print("\n  Uploading")
    for asset in sorted(assets.values(), key=lambda x: x.object_path):
        if asset in unreachable:
            print(f"    · {asset.object_path}  SKIPPED — source unreadable")
            continue
        try:
            if asset.source == "old bucket":
                payload, sniffed = fetch(asset.old_url)
            else:
                path = REPO / asset.source.split(": ", 1)[1]
                payload, sniffed = path.read_bytes(), None
        except Exception as exc:  # noqa: BLE001
            asset.verify = f"fetch failed: {exc}"
            print(f"    · {asset.object_path}  ✗ {asset.verify}")
            unreachable.append(asset)
            continue

        token = str(uuid.uuid4())
        blob = target.blob(asset.object_path)
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.upload_from_string(
            payload, content_type=content_type_for(asset.object_path, sniffed)
        )
        asset.new_url = download_url(bucket_name, asset.object_path, token)

        status, length = probe(asset.new_url)
        if status != "ok":
            asset.verify = status
        elif length is not None and length != len(payload):
            asset.verify = f"length mismatch: sent {len(payload)}, served {length}"
        else:
            asset.verify = "ok"
        mark = "·" if asset.verify == "ok" else "✗"
        print(f"    {mark} {asset.object_path:<{width}}  {len(payload):,} B  {asset.verify}")

    by_path = {x.object_path: x for x in assets.values()}

    def rewrite(node: Any) -> Any:
        if isinstance(node, dict):
            return {k: rewrite(v) for k, v in node.items()}
        if isinstance(node, list):
            return [rewrite(v) for v in node]
        if isinstance(node, str):
            object_path = parse_url(node)
            if object_path is not None:
                asset = by_path.get(object_path)
                if asset and asset.new_url and asset.verify == "ok":
                    return asset.new_url
        return node

    print("\n  Writing documents")
    written = 0
    for collection, rows in docs.items():
        print(f"    {collection}")
        for row in rows:
            doc_id = row["id"]
            data = rewrite(decode(row["data"]))
            ref = fs.collection(collection).document(doc_id)
            exists = ref.get().exists
            if exists:
                # Patch only the URL fields. Anything edited in the CRM since the
                # backup stays as it is.
                patch = {k: v for k, v in data.items() if k in URL_FIELDS}
                if patch:
                    ref.set(patch, merge=True)
                print(f"      · {doc_id}  patched ({', '.join(sorted(patch))})")
            else:
                ref.set(data)
                print(f"      · {doc_id}  created")
            written += 1

    # ── Verify what is actually in Firestore now ──────────────────────────────
    print("\n  Verifying every URL now stored in Firestore")
    checked = 0
    bad: list[tuple[str, str, str]] = []
    for collection in docs:
        for snapshot in fs.collection(collection).stream():
            for field, value in walk_strings(snapshot.to_dict() or {}):
                if DOWNLOAD_HOST not in value:
                    continue
                checked += 1
                status, _length = probe(value)
                if status != "ok" or f"/b/{bucket_name}/" not in value:
                    reason = status if status != "ok" else "still names the old bucket"
                    bad.append((f"{collection}/{snapshot.id}", field, reason))

    print(f"    {checked - len(bad)} of {checked} resolve against {bucket_name}")

    if bad:
        print("\n  ✗ THESE DID NOT RESOLVE")
        for where, field, reason in bad:
            print(f"    · {where}.{field}  {reason}")
        print(
            "\n    The documents are written and these fields still point at\n"
            "    something that does not answer. Fix the source, then re-run —\n"
            "    the run is idempotent: objects are overwritten and URLs replaced.\n"
        )
        return 1

    print(f"\n  {len(assets)} object(s) copied, {written} document(s) written, "
          f"{checked} URL(s) verified.")
    print("\n  Next: open the CRM → Gifts and → Tech/Content and look at the")
    print("  previews. Then the Android app's gift tray and entrance animations.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
