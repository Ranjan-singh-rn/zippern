"""Publish an APK to the in-app updater.

    cd backend
    .venv/bin/python -m scripts.publish_apk --channel debug            # dry run
    .venv/bin/python -m scripts.publish_apk --channel debug --apply

    .venv/bin/python -m scripts.publish_apk --channel release --apply \
        --notes "Fixes the profile-setup permission error"

── WHAT IT DOES ─────────────────────────────────────────────────────────────

Three things, in this order, and the order matters:

  1. Reads the versionCode and versionName **out of each APK itself**, not out
     of a flag. A published record that disagrees with the binary is how you
     ship an update that every phone declines to install, or worse, one that
     installs and then reports the wrong version to the next check. The
     architectures must agree on the version or nothing is published.
  2. Uploads each one to `appBuilds/{channel}/{abi}/` and takes a download URL.
  3. Writes `appConfig/androidUpdate.{channel}` — the document the app reads.

── ONE APK PER ARCHITECTURE ─────────────────────────────────────────────────

`splits { abi { … } }` builds `app-arm64-v8a-debug.apk` and
`app-armeabi-v7a-debug.apk` rather than one APK carrying both. A single APK
held 50.4 MB of arm64 libraries and 35.3 MB of the identical 32-bit ones out of
125 MB, and every phone can execute exactly one set — so a third of every
download was libraries that device can never run.

The document therefore carries an `abis` map, and the phone picks the entry
matching its own `Build.SUPPORTED_ABIS`. Both are published together, always:
a missing architecture does not fail loudly, it falls through to the legacy
flat fields, which carry the arm64 build — and a 32-bit handset then installs
an APK whose libraries its CPU cannot load, which installs cleanly and crashes
on the first Agora call.

The upload happens BEFORE the document write, so a failure halfway leaves an
orphaned file that nothing points at. The other order would point every phone
on the platform at a URL that 404s.

── THE TWO CHANNELS ARE NOT A CONVENIENCE ───────────────────────────────────

`debug` and `release` APKs are signed with different keys, and Android refuses
an update whose signature does not match the installed app
(INSTALL_FAILED_UPDATE_INCOMPATIBLE). Both builds carry the applicationId
`com.zipper.app`, so nothing else distinguishes them. Publishing a release APK
to the debug channel would fail on every tester's phone at the final step,
after a full download, with an OS error nobody can act on.

The channel is therefore taken from the APK's own signing certificate where it
can be determined, and cross-checked against `--channel`.

── WHY IT REFUSES TO GO BACKWARDS ───────────────────────────────────────────

Android will not install an APK whose versionCode is lower than the installed
one, and the updater only offers an update when the published code is higher.
So a republish at the same or a lower code is silently inert: the document
changes, the phones ignore it, and the person who published it believes they
shipped. It is refused loudly instead.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from app.db import firebase

CHANNELS = ("debug", "release")
DOC = "androidUpdate"

#: The architectures the app is built for, and the order they are reported in.
#:
#: Both are published for every release. A phone reads `Build.SUPPORTED_ABIS`
#: and takes the first entry present in the document, so a missing architecture
#: does not degrade gracefully — it silently falls back to the flat fields,
#: which carry the arm64 build, and a 32-bit handset then installs an APK whose
#: libraries its CPU cannot load. That installs cleanly and crashes on the first
#: Agora call. Publishing is therefore all-or-nothing across ABIs.
ABIS = ("arm64-v8a", "armeabi-v7a")

#: The ABI whose build is ALSO written to the flat `url`/`sha256`/`sizeBytes`
#: fields, for clients that predate the per-architecture map.
LEGACY_ABI = "arm64-v8a"

#: How many previously published builds to keep locally, per channel and ABI, so
#: a patch can be generated from each of them to the new one.
#:
#: Three covers the realistic case — somebody who skipped a couple of builds —
#: without storing a quarter of a gigabyte per architecture. Anyone further
#: behind than that downloads the full APK, which is the behaviour without
#: patches at all, so the floor is never worse than today.
RETAIN = 3

#: A patch worth serving. Above this fraction of the full APK the round trip
#: — fetch the patch, read 90 MB off internal storage, rebuild 90 MB, hash it —
#: costs more in time and battery than it saves in bytes, so the full download
#: is the better answer and the patch is discarded.
PATCH_MAX_RATIO = 0.70


def _cache_dir(channel: str, abi: str) -> Path:
    """Where previously published APKs are kept, to diff the next one against.

    Deliberately local and deliberately outside the repo's tracked tree. The
    alternative — pulling the previous build back out of Cloud Storage on every
    publish — means downloading ~90 MB per architecture before any work starts,
    on the same connection that is about to upload the new one.

    A fresh clone has no history here, so the first publish from a new machine
    produces no patches and every phone takes the full download. That is the
    correct degradation: patches are an optimisation over a path that always
    works, never a precondition for one.
    """
    d = _repo_root() / "zipper-app" / "build" / "published" / channel / abi
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cached_builds(channel: str, abi: str) -> dict[int, Path]:
    """Previously published APKs for this channel and ABI, by versionCode."""
    out: dict[int, Path] = {}
    for f in _cache_dir(channel, abi).glob("*.apk"):
        try:
            out[int(f.stem)] = f
        except ValueError:
            continue
    return out


def _make_patch(old: Path, new: Path, dest: Path) -> bool:
    """bsdiff `old` → `new` into `dest`. False if it could not be done.

    `bsdiff4` is a thin wrapper over the reference C implementation and writes
    the BSDIFF40 format the Android side reads. It is an optional dependency on
    purpose: a machine without it still publishes, it simply publishes no
    patches, and every phone takes the full download exactly as before.

    Installing it is one line — `.venv/bin/pip install bsdiff4` — and the
    message below says so rather than leaving somebody to wonder why their
    updates are still 90 MB.
    """
    try:
        import bsdiff4  # noqa: PLC0415 — optional, and absence is a supported state
    except ImportError:
        return False
    try:
        dest.write_bytes(bsdiff4.diff(old.read_bytes(), new.read_bytes()))
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"      patch from {old.stem} failed ({exc}) — full download for those phones")
        dest.unlink(missing_ok=True)
        return False

#: Where the Gradle build leaves each artefact, relative to the repo root.
#: `splits { abi { … } }` names them by architecture; there is no longer an
#: `app-debug.apk`.
APK_DIR = {
    "debug": "zipper-app/app/build/outputs/apk/debug",
    "release": "zipper-app/app/build/outputs/apk/release",
}


def _apk_for(channel: str, abi: str) -> Path:
    return _repo_root() / APK_DIR[channel] / f"app-{abi}-{channel}.apk"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sha256(path: Path) -> str:
    """Streamed, because the APK is well over a hundred megabytes."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sdk_tool(*names: str) -> str | None:
    """The first of `names` found in the Android SDK build-tools, newest first."""
    for root in (
        Path.home() / "Library/Android/sdk/build-tools",
        Path.home() / "Android/Sdk/build-tools",
    ):
        if not root.is_dir():
            continue
        for tool in sorted(root.iterdir(), reverse=True):
            for name in names:
                exe = tool / name
                if exe.is_file():
                    return str(exe)
    return None


def _aapt() -> str | None:
    return _sdk_tool("aapt2", "aapt")


def _version_from_apk(path: Path) -> tuple[int, str]:
    """The versionCode and versionName the binary actually declares.

    Read from the APK rather than from `build.gradle.kts`, because the file on
    disk may have been built before the last edit to that file — and the number
    that decides whether a phone installs this is the one compiled in, not the
    one in the source tree.

    `aapt2` is the reliable reader. Where it is absent the binary manifest is
    parsed for the two values directly: crude, but it fails loudly rather than
    guessing, and a wrong version here is the one error this script exists to
    prevent.
    """
    aapt = _aapt()
    if aapt:
        try:
            out = subprocess.run(
                [aapt, "dump", "badging", str(path)],
                capture_output=True, text=True, check=True,
            ).stdout
            code = re.search(r"versionCode='(\d+)'", out)
            name = re.search(r"versionName='([^']*)'", out)
            if code and name:
                return int(code.group(1)), name.group(1)
        except Exception as exc:  # noqa: BLE001
            print(f"  !  aapt could not read the APK ({exc}); falling back.")

    # Fallback: the compiled manifest holds the version name as a UTF-16 string
    # in the string pool. The code is not recoverable this way, so refuse rather
    # than invent one.
    try:
        with zipfile.ZipFile(path) as z:
            z.read("AndroidManifest.xml")
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"  ✗ {path} is not a readable APK: {exc}") from exc

    raise SystemExit(
        "  ✗ Could not read the versionCode from the APK, and guessing it is\n"
        "    exactly the mistake this script exists to prevent. Install the\n"
        "    Android build-tools (they ship aapt2) or pass --version-code and\n"
        "    --version-name explicitly, having checked them yourself."
    )


def _signer_channel(path: Path) -> str | None:
    """`debug` or `release` from the signing certificate, or None if unknown.

    The debug keystore's certificate is issued to `CN=Android Debug`. That is a
    platform convention rather than a guarantee, so an unrecognised certificate
    returns None and the caller's `--channel` stands unchallenged — this is a
    guard against a slip, not an authority.

    ── WHY apksigner AND NOT JUST keytool ──────────────────────────────────

    `keytool -printcert -jarfile` reads the **v1** (JAR) signature only, and
    modern APKs frequently do not have one: with `minSdk 26` the Gradle plugin
    signs with APK Signature Scheme v2/v3 and leaves v1 off, because every
    device that can run the app understands v2. So keytool found nothing, this
    returned None, and the mismatch check below silently stopped running — a
    guard that reports "unrecognised certificate" on every single build is a
    guard that is not there.

    `apksigner verify --print-certs` reads all three schemes and is in the same
    build-tools directory as aapt. keytool stays as the fallback for a machine
    with a JDK and no Android SDK.
    """
    signer = _sdk_tool("apksigner")
    if signer:
        try:
            out = subprocess.run(
                [signer, "verify", "--print-certs", str(path)],
                capture_output=True, text=True, check=True,
            ).stdout
            if "CN=Android Debug" in out:
                return "debug"
            if "certificate DN:" in out:
                return "release"
        except Exception:  # noqa: BLE001
            pass   # fall through to keytool

    try:
        out = subprocess.run(
            ["keytool", "-printcert", "-jarfile", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout
    except Exception:  # noqa: BLE001
        return None
    if "CN=Android Debug" in out:
        return "debug"
    return "release" if "Owner:" in out else None


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--channel", required=True, choices=CHANNELS)
    ap.add_argument("--apk-dir", help="override the Gradle output directory")
    ap.add_argument("--notes", default="", help="what changed, shown in the dialog")
    ap.add_argument(
        "--mandatory", action="store_true",
        help="the dialog cannot be dismissed — use for a broken build, not a feature",
    )
    ap.add_argument(
        "--min-supported", type=int, default=0,
        help="force the update for anything below this versionCode",
    )
    ap.add_argument("--version-code", type=int, help="override, if aapt is unavailable")
    ap.add_argument("--version-name", help="override, if aapt is unavailable")
    ap.add_argument("--apply", action="store_true", help="actually publish")
    args = ap.parse_args()

    # ── Resolve every architecture before touching anything ──────────────────
    # All of them or none. A half-published release leaves one class of handset
    # falling through to the legacy flat fields and installing the wrong
    # architecture — see ABIS.
    apks: dict[str, Path] = {}
    for abi in ABIS:
        path = (
            Path(args.apk_dir) / f"app-{abi}-{args.channel}.apk"
            if args.apk_dir else _apk_for(args.channel, abi)
        )
        if not path.is_file():
            raise SystemExit(
                f"  ✗ No {abi} APK at {path}\n"
                f"    Build them first:  cd zipper-app && ./gradlew assemble"
                f"{args.channel.capitalize()}\n"
                f"    `splits {{ abi }}` produces one APK per architecture; there is\n"
                f"    no longer an app-{args.channel}.apk."
            )
        apks[abi] = path

    firebase.init()
    client = firebase.firestore_client()

    print()
    print("═" * 74)
    print(f"  PUBLISH → {args.channel}" + ("" if args.apply else "   — DRY RUN"))
    print("═" * 74)
    print()

    # ── Read the version out of each binary, and make them agree ─────────────
    versions: dict[str, tuple[int, str]] = {}
    details: dict[str, dict] = {}
    for abi, path in apks.items():
        if args.version_code and args.version_name:
            code, name = args.version_code, args.version_name
        else:
            code, name = _version_from_apk(path)
        versions[abi] = (code, name)

        size = path.stat().st_size
        digest = _sha256(path)
        signer = _signer_channel(path)
        details[abi] = {"size": size, "sha256": digest, "signer": signer, "path": path}

        print(f"  {abi}")
        print(f"    file       {path.name}")
        print(f"    size       {size / 1_048_576:.1f} MB")
        print(f"    version    {name} ({code})")
        print(f"    sha256     {digest}")
        print(f"    signed as  {signer or 'unrecognised certificate'}")

        if signer and signer != args.channel:
            raise SystemExit(
                f"\n  ✗ The {abi} APK is signed as '{signer}' but you asked to\n"
                f"    publish to '{args.channel}'. Android refuses an update whose\n"
                f"    signature does not match the installed app, so every phone on\n"
                f"    that channel would download it and then fail to install.\n"
                f"    Nothing was published."
            )

    codes = {c for c, _ in versions.values()}
    names = {n for _, n in versions.values()}
    if len(codes) != 1 or len(names) != 1:
        raise SystemExit(
            f"\n  ✗ The architectures disagree about the version: {versions}\n"
            f"    They are one release and the updater compares a single number,\n"
            f"    so this would offer different things to different handsets.\n"
            f"    Rebuild both from the same tree."
        )
    code, name = versions[ABIS[0]]

    # ── Never go backwards ───────────────────────────────────────────────────
    ref = client.collection("appConfig").document(DOC)
    snap = ref.get()
    current = (snap.to_dict() or {}).get(args.channel, {}) if snap.exists else {}
    published = int(current.get("versionCode", 0) or 0)
    print()
    if published:
        print(f"  currently published   {current.get('versionName', '?')} ({published})")
    if code <= published:
        raise SystemExit(
            f"\n  ✗ versionCode {code} is not greater than the published {published}.\n"
            f"    Android will not install it and the updater will not offer it,\n"
            f"    so this would change the record and reach no phone at all.\n"
            f"    Raise `versionCode` in zipper-app/app/build.gradle.kts, rebuild,\n"
            f"    and run this again."
        )
    print(f"  publishing            {name} ({code})   mandatory={args.mandatory}")

    if not args.apply:
        print()
        print("  DRY RUN — re-run with --apply to publish.")
        print()
        return 0

    # Said once, loudly, rather than left to be inferred from an absent
    # `patches` map. Without it every phone downloads the full APK — which is
    # correct, and works, and is also the thing somebody installed this script
    # to stop doing.
    try:
        import bsdiff4  # noqa: F401, PLC0415
    except ImportError:
        print()
        print("  !  bsdiff4 is not installed, so NO PATCHES will be generated and")
        print("     every phone will download the full APK.")
        print("     Fix it with:  .venv/bin/pip install bsdiff4")
        print("     Publishing continues — patches are an optimisation, not a")
        print("     requirement.")

    # ── Upload every architecture FIRST ──────────────────────────────────────
    # A failure here leaves unreferenced files, which costs storage. Writing the
    # document first and failing here would point phones at a URL that 404s.
    bucket = firebase.storage_bucket()
    abis_payload: dict[str, dict] = {}
    print()
    for abi, d in details.items():
        blob = bucket.blob(f"appBuilds/{args.channel}/{abi}/zipper-{name}-{code}.apk")
        print(f"  uploading  {abi} → gs://{bucket.name}/{blob.name}")
        blob.upload_from_filename(
            str(d["path"]), content_type="application/vnd.android.package-archive"
        )
        # Public, because Android's DownloadManager is an OS service and carries
        # none of the app's Firebase credentials. The SHA-256 below is what
        # protects the file, not the ACL.
        blob.make_public()
        abis_payload[abi] = {
            "url": blob.public_url,
            "sha256": d["sha256"],
            "sizeBytes": d["size"],
        }

        # ── Patches, from each retained build to this one ────────────────────
        #
        # Generated per ABI, and that is not tidiness: a patch is a byte-level
        # diff against one exact binary, and the arm64 and 32-bit APKs share
        # almost nothing. A patch applied to the wrong architecture produces a
        # file that fails its hash check — caught, but only after the phone has
        # rebuilt 90 MB for nothing.
        #
        # Everything here is best-effort. A patch that cannot be made is simply
        # absent from the map, and a phone that finds no patch for its version
        # downloads the full APK, which is what it did before any of this
        # existed.
        patches: dict[str, dict] = {}
        for from_code, old_apk in sorted(_cached_builds(args.channel, abi).items()):
            if from_code >= code:
                continue
            tmp = _cache_dir(args.channel, abi) / f"patch-{from_code}-to-{code}.bsdiff"
            if not _make_patch(old_apk, d["path"], tmp):
                continue
            psize = tmp.stat().st_size
            if psize > d["size"] * PATCH_MAX_RATIO:
                print(f"      {from_code} → {code}: {psize / 1_048_576:.1f} MB, "
                      f"too close to the full APK — skipped")
                tmp.unlink(missing_ok=True)
                continue
            pblob = bucket.blob(
                f"appBuilds/{args.channel}/{abi}/patches/{from_code}-to-{code}.bsdiff"
            )
            pblob.upload_from_filename(str(tmp), content_type="application/octet-stream")
            pblob.make_public()
            patches[str(from_code)] = {
                "url": pblob.public_url,
                "sha256": _sha256(tmp),
                "sizeBytes": psize,
            }
            saved = 100 - (psize * 100 // d["size"])
            print(f"      patch {from_code} → {code}: "
                  f"{psize / 1_048_576:.1f} MB  ({saved}% smaller)")
            tmp.unlink(missing_ok=True)

        if patches:
            abis_payload[abi]["patches"] = patches

        # Retain this build so the NEXT release can be diffed against it, then
        # prune. Done after the patches above so the new APK is never diffed
        # against itself.
        shutil.copy2(d["path"], _cache_dir(args.channel, abi) / f"{code}.apk")
        keep = sorted(_cached_builds(args.channel, abi), reverse=True)[:RETAIN]
        for old_code, old_path in _cached_builds(args.channel, abi).items():
            if old_code not in keep:
                old_path.unlink(missing_ok=True)

    legacy = abis_payload[LEGACY_ABI]
    ref.set(
        {
            args.channel: {
                "versionCode": code,
                "versionName": name,
                "notes": args.notes.strip(),
                "mandatory": bool(args.mandatory),
                "minSupportedVersionCode": int(args.min_supported or 0),
                "publishedAt": datetime.now(timezone.utc),
                "abis": abis_payload,
                # ── The flat fields are LEGACY and still written ──────────────
                # The build already on people's phones reads only this shape.
                # Dropping it would strand every existing install on its current
                # version with no route forward but a manual sideload — which is
                # the thing this whole feature exists to stop. Carries the
                # arm64 build, which is what the overwhelming majority of
                # handsets run.
                **legacy,
            }
        },
        merge=True,   # never touch the other channel
    )

    print()
    print(f"  ✓ Published {name} ({code}) to {args.channel}, "
          f"{len(abis_payload)} architecture(s).")
    for abi, entry in abis_payload.items():
        print(f"      {abi:<14} {entry['sizeBytes'] / 1_048_576:>6.1f} MB")
    print()
    print("  Each phone downloads only the build its CPU can run. Phones see it")
    print("  on their next app start, and the dialog verifies that architecture's")
    print("  sha256 before installing.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
