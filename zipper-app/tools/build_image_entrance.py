"""
Build an image-based Lottie entrance from a finished illustration.

    python3 tools/build_image_entrance.py

This is the answer to "can you do the dragon". Lottie can embed a bitmap and
move it — fly it in, bank it, scale it, trail it with sparks, drop a lit banner
under it. What it cannot do is articulate the drawing: the wings will not flap,
because that needs an animator drawing every pose.

For an entrance effect that is usually enough. The user sees a dragon sweep
across the room and land on a banner carrying their name. Nobody is studying
the wings.

Swap ART for any PNG/JPG — an illustrator's export, a purchased asset, an
AI-generated character — and this produces an entrance for it.
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lottie_kit import (                                    # noqa: E402
    FPS, GOLD, GOLD_LT, ROSE, VIOLET, VIOLET_DK,
    eased, linear, fixed, _tr, _rect, _ellipse, _fill, _grad_stroke,
    _group, _layer, _comp, write,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "art", "dragon.jpg")
OUT = os.path.join(HERE, "..", "app", "src", "main", "assets", "anim")

W, H = 1080, 320
DUR = int(2.6 * FPS)
IN, HOLD, EXIT = int(DUR * 0.28), int(DUR * 0.62), DUR

if not os.path.exists(ART):
    sys.exit(f"missing {ART} — put a PNG or JPG there first")

raw = open(ART, "rb").read()
mime = "jpeg" if ART.lower().endswith((".jpg", ".jpeg")) else "png"
b64 = base64.b64encode(raw).decode()

# Figure out the real pixel size so the layer isn't stretched.
if mime == "png":
    iw = int.from_bytes(raw[16:20], "big"); ih = int.from_bytes(raw[20:24], "big")
else:
    iw = ih = None
    i = 2
    while i < len(raw) - 9:
        if raw[i] != 0xFF: i += 1; continue
        m = raw[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3):
            ih = int.from_bytes(raw[i + 5:i + 7], "big")
            iw = int.from_bytes(raw[i + 7:i + 9], "big")
            break
        i += 2 + int.from_bytes(raw[i + 2:i + 4], "big")
    if not iw:
        sys.exit("could not read JPEG dimensions")

asset = {"id": "art_0", "w": iw, "h": ih, "u": "", "p": f"data:image/{mime};base64,{b64}", "e": 1}

layers = []

# 1 — lit banner the dragon lands on
layers.append(_layer(
    1, "banner",
    [_group(_rect(W * 1.3, 150, 75),
            _grad_stroke(150, [(0, VIOLET_DK), (0.5, ROSE), (1, VIOLET_DK)], W * 0.65),
            _tr())],
    DUR, pos=(W / 2, H / 2 + 40),
    scale=eased(0, [30, 100, 100], IN, [100, 100, 100], EXIT, [130, 100, 100]),
    opacity=eased(0, 0, IN, 82, HOLD, 82, EXIT, 0),
))

# 2 — glow behind the dragon so it reads against a bright stream
layers.append(_layer(
    2, "glow",
    [_group(_ellipse(300), _fill(GOLD), _tr())],
    DUR, pos=(W * 0.30, H / 2),
    scale=eased(0, [60, 60, 100], HOLD, [130, 130, 100], EXIT, [70, 70, 100]),
    opacity=eased(0, 0, IN, 34, HOLD, 34, EXIT, 0),
))

# 3 — the artwork. Flies in from the left, banks, settles, drifts out.
scale = 210.0 / ih * 100
layers.append({
    "ddd": 0, "ind": 3, "ty": 2, "nm": "dragon", "refId": "art_0", "sr": 1,
    "ks": {
        "o": eased(0, 0, int(IN * 0.5), 100, HOLD, 100, EXIT, 0),
        "r": eased(0, -14, IN, 4, HOLD, 0, EXIT, 6),
        "p": {"a": 1, "k": [
            {"t": 0,    "s": [-260, H / 2 + 40, 0], "i": {"x": 0.25, "y": 1}, "o": {"x": 0.4, "y": 0}},
            {"t": IN,   "s": [W * 0.30, H / 2, 0],  "i": {"x": 0.5, "y": 1},  "o": {"x": 0.5, "y": 0}},
            {"t": HOLD, "s": [W * 0.33, H / 2 - 6, 0], "i": {"x": 0.6, "y": 1}, "o": {"x": 0.4, "y": 0}},
            {"t": EXIT, "s": [W + 320, H / 2 - 30, 0]},
        ]},
        "a": fixed([iw / 2, ih / 2, 0]),
        "s": {"a": 1, "k": [
            {"t": 0,    "s": [scale * 0.72, scale * 0.72, 100], "i": {"x": 0.3, "y": 1}, "o": {"x": 0.5, "y": 0}},
            {"t": IN,   "s": [scale, scale, 100], "i": {"x": 0.5, "y": 1}, "o": {"x": 0.5, "y": 0}},
            {"t": HOLD, "s": [scale * 1.04, scale * 1.04, 100], "i": {"x": 0.5, "y": 1}, "o": {"x": 0.5, "y": 0}},
            {"t": EXIT, "s": [scale * 0.9, scale * 0.9, 100]},
        ]},
    },
    "ao": 0, "ip": 0, "op": DUR, "st": 0, "bm": 0,
})

# 4+ — embers trailing behind it
for i in range(14):
    delay = int(i * 2.2)
    layers.append(_layer(
        4 + i, f"ember{i}",
        [_group(_ellipse(5 + (i % 4) * 4), _fill(GOLD_LT if i % 2 else GOLD), _tr())],
        DUR,
        pos=(W * (0.06 + 0.055 * i), H / 2 + (-56 if i % 3 == 0 else 44 if i % 3 == 1 else -12)),
        scale=eased(0, [40, 40, 100], HOLD, [110, 110, 100], EXIT, [20, 20, 100]),
        opacity=eased(0, 0, min(IN + delay, HOLD), 95, EXIT, 0),
    ))

comp = _comp("Zipper entrance — dragon", layers, DUR, w=W, h=H)
comp["assets"] = [asset]

path = write(comp, os.path.join(OUT, "entrance_dragon.json"))
print(f"wrote {os.path.basename(path)}  "
      f"({os.path.getsize(path)/1024:.0f} KB, {W}x{H}, {DUR/FPS:.1f}s, artwork {iw}x{ih} embedded)")
