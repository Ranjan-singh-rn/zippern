"""
Import gift SVGs exported from Figma and prepare them for Android.

    1. In Figma, open page "16 Gift Catalogue"
    2. Select all 31 gift components
    3. Export panel -> SVG -> Export -> save into  zipper-app/assets-src/gifts/
    4. python3 tools/import_gifts.py

Why not export straight to Android VectorDrawable: Android Studio's converter
chokes on a few things Figma emits (gradient transforms, some opacity forms),
and it fails quietly by dropping the element rather than erroring. This script
checks each file first and tells you which ones will need attention.

What it does
    - normalises filenames to gift_<name>.svg
    - reports anything VectorDrawable cannot represent
    - writes a manifest the CRM gift catalogue can be seeded from

What it does NOT do
    - the actual SVG -> VectorDrawable conversion. Use Android Studio
      (right-click res > New > Vector Asset > Local file) or the bundled
      vd-tool. Both are more reliable than anything hand-rolled here.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "assets-src", "gifts")
MANIFEST = os.path.join(HERE, "..", "assets-src", "gifts", "manifest.json")

# The price ladder these were drawn against. Tier drives the visual weight, so
# keep them in step: if a gift moves tier, its artwork needs to move with it.
TIERS = {
    1: ("impulse", 2, 50, ["rose", "heart", "thumbs-up", "star", "coffee", "candy"]),
    2: ("casual", 100, 500, ["kiss", "teddy", "balloon", "cupcake", "puppy",
                             "flower-bouquet", "perfume", "ice-cream"]),
    3: ("mid", 900, 5000, ["ring", "necklace", "crown-small", "champagne",
                           "cake", "guitar", "motorbike"]),
    4: ("premium", 10000, 50000, ["sports-car", "diamond-ring", "crown-royal",
                                  "yacht", "piano", "fireworks"]),
    5: ("flagship", 100000, None, ["castle", "private-jet", "dragon", "galaxy-throne"]),
}

# Things VectorDrawable cannot express. Each is a real conversion failure, and
# Android Studio drops the element silently rather than complaining.
UNSUPPORTED = [
    (r"<radialGradient", "radial gradient — VectorDrawable supports it only from API 24; "
                         "either raise minSdk (yours is 26, so fine) or flatten it"),
    (r"gradientTransform=", "gradientTransform — not supported; bake the transform into the coordinates"),
    (r"<filter|feGaussianBlur", "filter/blur — not supported; render the glow as a translucent shape instead"),
    (r"<text", "text element — not supported; gift names are drawn by the UI anyway, remove it"),
    (r"<image", "embedded raster — defeats the point of a vector; redraw or ship as WebP"),
    (r"<use", "<use> reference — flatten it before converting"),
    (r"stroke-dasharray", "dashed stroke — supported but frequently mis-rendered; convert to solid"),
]


def norm(name):
    n = os.path.splitext(os.path.basename(name))[0]
    n = re.sub(r"^Gift\s*/?\s*", "", n, flags=re.I).strip()
    n = re.sub(r"[^a-zA-Z0-9]+", "_", n).strip("_").lower()
    return n


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"missing {SRC} — export the SVGs from Figma first")

    files = [f for f in sorted(os.listdir(SRC)) if f.lower().endswith(".svg")]
    if not files:
        print(f"No SVGs in {os.path.relpath(SRC, os.path.join(HERE, '..'))}.\n")
        print("In Figma: page '16 Gift Catalogue' -> select all gift components")
        print("          -> Export panel -> SVG -> Export -> save here.")
        return

    tier_of = {}
    for t, (_, lo, hi, names) in TIERS.items():
        for n in names:
            tier_of[n.replace("-", "_")] = (t, lo, hi)

    entries, problems, unknown = [], [], []
    for f in files:
        path = os.path.join(SRC, f)
        body = open(path, encoding="utf-8").read()
        name = norm(f)

        target = os.path.join(SRC, f"gift_{name}.svg")
        if os.path.abspath(path) != os.path.abspath(target):
            os.rename(path, target)
            path = target

        issues = [msg for pat, msg in UNSUPPORTED if re.search(pat, body)]
        if issues:
            problems.append((name, issues))

        t = tier_of.get(name)
        if not t:
            unknown.append(name)
        entries.append({
            "slug": name,
            "file": f"gift_{name}.svg",
            "tier": t[0] if t else None,
            "priceFloor": t[1] if t else None,
            "priceCeiling": t[2] if t else None,
            "bytes": os.path.getsize(path),
        })

    with open(MANIFEST, "w") as fh:
        json.dump({
            "note": "Original artwork drawn for Zipper. No third-party licence attaches. "
                    "Regenerate from Figma page '16 Gift Catalogue' rather than hand-editing.",
            "figmaFile": "KzjWYs64L1bPAmD6Bxoic2",
            "count": len(entries),
            "gifts": entries,
        }, fh, indent=2)

    total = sum(e["bytes"] for e in entries)
    print(f"{len(entries)} gifts, {total/1024:.0f} KB total")
    print(f"manifest: {os.path.relpath(MANIFEST, os.path.join(HERE, '..'))}\n")

    missing = set(tier_of) - {e["slug"] for e in entries}
    if missing:
        print(f"Expected but not exported ({len(missing)}): {', '.join(sorted(missing))}\n")
    if unknown:
        print(f"Exported but not in the price ladder: {', '.join(unknown)}\n")

    if problems:
        print("Will not survive VectorDrawable conversion as-is:\n")
        for name, issues in problems:
            print(f"  {name}")
            for i in issues:
                print(f"     - {i}")
        print()
    else:
        print("All files convert cleanly to VectorDrawable.\n")

    print("Next: Android Studio > right-click res > New > Vector Asset > Local file,")
    print("      or in bulk:  vd-tool -c -in assets-src/gifts -out app/src/main/res/drawable")


if __name__ == "__main__":
    main()
