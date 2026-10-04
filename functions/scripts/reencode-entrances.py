#!/usr/bin/env python3
"""Turn the image-sequence entrance Lotties into video, and make real thumbnails.

WHY THIS EXISTS
---------------
`functions/entry-lotties/*.json` are not animations in any sense Lottie was
designed for. Opened up, `en_jet.json` is 22.3 MB, of which 22.26 MB is 237
base64-embedded WebP images at 1082x1912 — one full-screen picture per frame,
with 237 image layers referencing them in order. There is no vector content, no
transparency, and no shape data. Somebody exported a video through a Lottie
wrapper.

That distinction is the whole performance story. Lottie draws by decoding its
images into Android bitmaps, and 1082 x 1912 x 4 bytes is 8.3 MB per frame, so
one entrance asks the device for roughly two gigabytes. The Bag screen used to
start eleven of them at once. A Samsung S24 Ultra freezes on that for the same
reason a budget phone does: no amount of RAM makes two gigabytes of bitmap per
item free, and none of it touches the hardware video decoder that this content
should have been going through from the start.

As H.264 the same clip is about 1.9 MB and decodes on a fixed-function block
that every Android device made in the last decade has, including the cheap ones
these entrances need to run on in India, Pakistan, Bangladesh and Nepal.

WHY H.264 AND NOT SVGA / VP9-ALPHA / PAG
----------------------------------------
Those formats exist to solve a problem these particular assets do not have.
SVGA and PAG are for animations built from a handful of sprites moved by
transforms, and VP9-alpha is for overlay animations that need to composite over
live video. Every frame here is opaque and full-bleed — the corners are sky and
city, not transparency — so the entrance is a full-screen takeover, and the
cheapest correct container for a full-screen opaque clip is baseline H.264.
Baseline profile specifically: it is the one every hardware decoder supports,
where VP9-with-alpha silently falls back to software on a lot of budget SoCs and
costs more than the Lottie did.

If a future entrance really is a sprite animation over the live stream, that one
wants SVGA or alpha video, and this script is not the tool for it.

USAGE
-----
    python3 functions/scripts/reencode-entrances.py \
        --src functions/entry-lotties \
        --out functions/entry-video

Needs ffmpeg on PATH and Pillow (`pip install pillow`). Writes, per entrance:

    <out>/mp4/<id>.mp4          the animation, 540 px wide, baseline H.264
    <out>/thumb/<id>.webp       a 256 px still for the Bag grid

Nothing is uploaded and nothing in Firestore is touched — `upload-entry-*.mjs`
do that, and they should be pointed at these outputs once the results have been
eyeballed.
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")


#: Output width. The entrances are portrait (1082x1912); 540 is half of that and
#: is already more pixels than the phone shows for a clip that is on screen for
#: eight seconds over a video call. Height follows the source aspect ratio, kept
#: even because H.264 requires it.
WIDTH = 540

#: Constant Rate Factor. 26 is visually indistinguishable from the source at this
#: size for this kind of motion-heavy footage; 23 roughly doubles the file for no
#: benefit anyone can see on a phone.
CRF = 26

#: The still the Bag grid shows. 256 px because the tile is around 54 dp, so even
#: on a 4x-density screen this is more than enough and decodes to a small bitmap.
THUMB_PX = 256

#: Which frame to take the still from. A tenth of the way in: frame zero is
#: usually an empty or fading-in frame, and the middle is often the busiest part
#: of the clip rather than the most recognisable.
THUMB_AT = 0.10


def extract_frames(lottie_path: Path, frames_dir: Path) -> tuple[int, float, str]:
    """Write every embedded image out as its own file.

    Returns (frame count, source fps, file extension). Raises if the JSON turns
    out to be a real vector Lottie, because re-encoding one of those to video
    would be a downgrade — it would lose the resolution independence that is the
    entire reason to use the format.
    """
    doc = json.loads(lottie_path.read_text())
    assets = doc.get("assets", [])
    embedded = [a for a in assets if isinstance(a.get("p"), str) and a["p"].startswith("data:")]

    if not embedded:
        raise ValueError(
            f"{lottie_path.name} has no embedded images — it looks like a real "
            f"vector Lottie. Leave it alone; it is already the right format."
        )
    if len(embedded) < len(assets):
        print(
            f"  ! {lottie_path.name}: {len(assets) - len(embedded)} asset(s) are "
            f"not embedded images and will be lost. Check the result.",
            file=sys.stderr,
        )

    ext = "png"
    for index, asset in enumerate(embedded):
        header, b64 = asset["p"].split(",", 1)
        ext = header.split("/")[1].split(";")[0]
        (frames_dir / f"{index:05d}.{ext}").write_bytes(base64.b64decode(b64))

    fps = float(doc.get("fr") or 30)
    return len(embedded), fps, ext


def encode(frames_dir: Path, ext: str, fps: float, dest: Path) -> None:
    """Frames to baseline H.264."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", f"{fps:g}",
            "-i", str(frames_dir / f"%05d.{ext}"),
            # -2 keeps the height even, which H.264 requires.
            "-vf", f"scale={WIDTH}:-2",
            "-c:v", "libx264",
            # Baseline/3.1 is the decoder floor. Anything above it risks a
            # software fallback on exactly the phones this is meant to help.
            "-profile:v", "baseline", "-level", "3.1",
            "-pix_fmt", "yuv420p",
            "-crf", str(CRF), "-preset", "slow",
            # Puts the index at the front so playback can start before the whole
            # file has arrived.
            "-movflags", "+faststart",
            "-an",
            str(dest),
        ],
        check=True,
    )


def thumbnail(frames_dir: Path, ext: str, count: int, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    index = min(count - 1, int(count * THUMB_AT))
    with Image.open(frames_dir / f"{index:05d}.{ext}") as im:
        im = im.convert("RGB")
        im.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
        im.save(dest, "WEBP", quality=80, method=6)


def human(n: int) -> str:
    return f"{n / 1_000_000:.2f} MB" if n >= 1_000_000 else f"{n / 1000:.1f} KB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, required=True, help="directory of Lottie JSON")
    ap.add_argument("--out", type=Path, required=True, help="output directory")
    ap.add_argument("--only", default="", help="comma-separated ids, for one-off re-runs")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        return print("ffmpeg is not on PATH.", file=sys.stderr) or 1

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    sources = sorted(p for p in args.src.glob("*.json") if not wanted or p.stem in wanted)
    if not sources:
        return print(f"No JSON found in {args.src}", file=sys.stderr) or 1

    before = after = 0
    failures: list[str] = []

    for path in sources:
        size_in = path.stat().st_size
        print(f"{path.stem:<12} {human(size_in):>10} ...", end=" ", flush=True)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                frames = Path(tmp)
                count, fps, ext = extract_frames(path, frames)
                mp4 = args.out / "mp4" / f"{path.stem}.mp4"
                encode(frames, ext, fps, mp4)
                thumbnail(frames, ext, count, args.out / "thumb" / f"{path.stem}.webp")
            size_out = mp4.stat().st_size
            before += size_in
            after += size_out
            print(f"{count:>4} frames -> {human(size_out):>10}  ({size_in / size_out:.1f}x smaller)")
        except Exception as exc:  # noqa: BLE001 — one bad asset must not stop the run
            failures.append(f"{path.stem}: {exc}")
            print("FAILED")

    if before:
        print(f"\nTotal {human(before)} -> {human(after)}  ({before / after:.1f}x smaller)")
    for f in failures:
        print(f"  ! {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
