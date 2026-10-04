"""
Generate the Lottie asset catalogue into app/src/main/assets/anim/.

    cd zipper-app && python3 tools/build_assets.py

Everything here is parametric. To add a new avatar-frame tier, add a row to
TIERS — do not hand-write JSON. The eight tiers below match the TIER palette
already in MyBagScreen.kt so the animated frame and the static fallback agree.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lottie_kit import (                                    # noqa: E402
    avatar_frame, burst, entrance_sweep, progress_ring, shimmer, write,
    ROSE, ROSE_DK, VIOLET, VIOLET_DK, GOLD, GOLD_LT, AQUA, MINT, CORAL, WHITE,
)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "app", "src", "main", "assets", "anim")
os.makedirs(OUT, exist_ok=True)

SILVER = (0.76, 0.78, 0.86)
BRONZE = (0.80, 0.53, 0.30)
NEON   = (0.36, 1.00, 0.78)
GALAXY = (0.62, 0.45, 1.00)
COSMIC = (1.00, 0.45, 0.85)

# tier -> (ring, accent, inner, sparks)
TIERS = {
    "bronze": (BRONZE, GOLD_LT, ROSE_DK, 3),
    "silver": (SILVER, WHITE,   VIOLET,  3),
    "gold":   (GOLD,   GOLD_LT, ROSE,    4),
    "purple": (VIOLET, GALAXY,  ROSE,    4),
    "royal":  (VIOLET_DK, GOLD, ROSE_DK, 5),
    "neon":   (NEON,   AQUA,    MINT,    5),
    "galaxy": (GALAXY, VIOLET,  AQUA,    6),
    "cosmic": (COSMIC, GOLD_LT, VIOLET,  6),
}

built = []

# ── Avatar frames, one per tier ───────────────────────────────────────────────
for tier, (ring, accent, inner, sparks) in TIERS.items():
    d = avatar_frame(f"Avatar frame — {tier}", ring=ring, accent=accent,
                     inner=inner, sparks=sparks)
    built.append(write(d, os.path.join(OUT, f"frame_{tier}.json")))

# ── Gift and celebration bursts ───────────────────────────────────────────────
built.append(write(burst("Gift combo", spokes=12, a=GOLD, b=ROSE),
                   os.path.join(OUT, "combo_burst.json")))
built.append(write(burst("Lucky win", spokes=16, a=GOLD_LT, b=GOLD,
                         ring=(GOLD, ROSE), seconds=1.1),
                   os.path.join(OUT, "lucky_win.json")))
built.append(write(burst("Level up", spokes=10, a=AQUA, b=VIOLET,
                         ring=(AQUA, VIOLET), seconds=1.0),
                   os.path.join(OUT, "level_up.json")))
built.append(write(burst("PK win", spokes=14, a=CORAL, b=GOLD,
                         ring=(CORAL, GOLD), seconds=1.2),
                   os.path.join(OUT, "pk_win.json")))

# ── Entrances. Three weights, gated by user level. ────────────────────────────
built.append(write(entrance_sweep("Entrance — standard", tint=VIOLET, glow=ROSE, seconds=1.8),
                   os.path.join(OUT, "entrance_standard.json")))
built.append(write(entrance_sweep("Entrance — premium", tint=VIOLET_DK, glow=GOLD, seconds=2.2),
                   os.path.join(OUT, "entrance_premium.json")))
built.append(write(entrance_sweep("Entrance — royal", tint=GOLD, glow=GOLD_LT, seconds=2.6),
                   os.path.join(OUT, "entrance_royal.json")))

# ── Progress and surface effects ──────────────────────────────────────────────
built.append(write(progress_ring("Wish gift progress", tint=ROSE),
                   os.path.join(OUT, "wish_progress.json")))
built.append(write(progress_ring("Payout threshold", tint=MINT),
                   os.path.join(OUT, "payout_progress.json")))
built.append(write(shimmer("VIP card shimmer", tint=GOLD_LT, w=328, h=180),
                   os.path.join(OUT, "vip_shimmer.json")))
built.append(write(shimmer("Chat bubble shimmer", tint=WHITE, w=280, h=52),
                   os.path.join(OUT, "bubble_shimmer.json")))

total = 0
print(f"{'file':<34}{'KB':>8}")
print("-" * 42)
for p in sorted(built):
    kb = os.path.getsize(p) / 1024
    total += kb
    print(f"{os.path.basename(p):<34}{kb:>8.1f}")
print("-" * 42)
print(f"{len(built)} files{'':<22}{total:>8.1f} KB")
print(f"\nwritten to app/src/main/assets/anim/")
