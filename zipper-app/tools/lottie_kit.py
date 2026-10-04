"""
lottie_kit — generate Lottie animations as JSON, without After Effects.

Why this exists
───────────────
Gift effects, avatar frames and entrances in this category ship as SVGA
(HiClub/Boloji) or Lottie. SVGA is an After Effects plugin format with almost no
support outside that ecosystem, and Figma cannot export it. Lottie is plain JSON,
which means a large class of these effects can be written directly — no designer,
no After Effects, no plugin.

What this can make
    rings, halos, orbiting sparks, shockwaves, radial bursts, sweeps,
    counters, progress fills, shimmer, confetti, slide-in banners
    → i.e. anything geometric and parametric.

What this CANNOT make
    illustrated character animation — a dragon flying, a car driving in,
    a hand-drawn mascot. Those need an illustrator plus After Effects, or
    a purchased/commissioned asset. Do not try to fake them here.

Usage
    python3 tools/build_assets.py          # writes app/src/main/assets/anim/*.json
    python3 tools/lottie_kit.py --selftest # validates every generated file

Android
    implementation("com.airbnb.android:lottie-compose:<version>")
    LottieAnimation(composition = rememberLottieComposition(
        LottieCompositionSpec.Asset("anim/frame_gold.json")).value)

Colours are 0..1 floats, NOT 0..255. That is the single most common Lottie bug.
"""

from __future__ import annotations
import json
import math
from typing import Sequence

FPS = 60

# ── Brand palette, matching the Figma Primitives collection ───────────────────
ROSE      = (1.000, 0.239, 0.545)
ROSE_DK   = (0.910, 0.118, 0.431)
VIOLET    = (0.545, 0.361, 0.965)
VIOLET_DK = (0.439, 0.220, 0.910)
GOLD      = (1.000, 0.714, 0.153)
GOLD_LT   = (1.000, 0.878, 0.541)
AQUA      = (0.361, 0.882, 0.902)
MINT      = (0.086, 0.780, 0.494)
CORAL     = (1.000, 0.302, 0.369)
WHITE     = (1.000, 1.000, 1.000)


# ── Keyframe helpers ──────────────────────────────────────────────────────────

def _kf(t: int, s, i_x=0.5, o_x=0.5):
    return {"t": t, "s": s if isinstance(s, list) else [s],
            "i": {"x": [i_x], "y": [1.0]}, "o": {"x": [o_x], "y": [0.0]}}


def linear(*pairs):
    """linear(0, 0, 180, 360) → constant-rate animation."""
    kfs = [_kf(pairs[i], pairs[i + 1], 0.5, 0.5) for i in range(0, len(pairs), 2)]
    return {"a": 1, "k": kfs}


def eased(*pairs):
    """eased(0, 100, 30, 0) → ease-in-out between values."""
    kfs = [_kf(pairs[i], pairs[i + 1], 0.6, 0.4) for i in range(0, len(pairs), 2)]
    return {"a": 1, "k": kfs}


def fixed(v):
    return {"a": 0, "k": v if isinstance(v, list) else v}


# ── Shape primitives ──────────────────────────────────────────────────────────

def _tr(p=(0, 0), s=(100, 100), r=0, o=100):
    return {"ty": "tr", "p": fixed(list(p)), "a": fixed([0, 0]), "s": fixed(list(s)),
            "r": fixed(r), "o": fixed(o), "sk": fixed(0), "sa": fixed(0)}


def _ellipse(d):
    return {"d": 1, "ty": "el", "s": fixed([d, d]), "p": fixed([0, 0])}


def _rect(w, h, r=0, p=(0, 0)):
    return {"d": 1, "ty": "rc", "s": fixed([w, h]), "p": fixed(list(p)), "r": fixed(r)}


def _fill(rgb, opacity=100):
    return {"ty": "fl", "c": fixed([rgb[0], rgb[1], rgb[2], 1]),
            "o": fixed(opacity), "r": 1, "bm": 0}


def _grad_stroke(width, stops: Sequence, span):
    """stops: [(pos, (r,g,b)), ...] — pos and channels are 0..1."""
    flat = []
    for pos, rgb in stops:
        flat += [pos, rgb[0], rgb[1], rgb[2]]
    return {"ty": "gs", "o": fixed(100), "w": fixed(width),
            "g": {"p": len(stops), "k": fixed(flat)},
            "s": fixed([-span, 0]), "e": fixed([span, 0]),
            "t": 1, "lc": 2, "lj": 2, "bm": 0}


def _stroke(rgb, width, opacity=100):
    return {"ty": "st", "c": fixed([rgb[0], rgb[1], rgb[2], 1]), "o": fixed(opacity),
            "w": fixed(width), "lc": 2, "lj": 2, "bm": 0}


def _group(*items):
    return {"ty": "gr", "nm": "g", "it": list(items)}


def _layer(ind, name, shapes, dur, pos=(256, 256),
           rot=None, scale=None, opacity=None, start=0):
    return {
        "ddd": 0, "ind": ind, "ty": 4, "nm": name, "sr": 1,
        "ks": {
            "o": opacity or fixed(100),
            "r": rot or fixed(0),
            "p": fixed([pos[0], pos[1], 0]),
            "a": fixed([0, 0, 0]),
            "s": scale or fixed([100, 100, 100]),
        },
        "ao": 0, "shapes": shapes, "ip": start, "op": dur, "st": start, "bm": 0,
    }


def _comp(name, layers, dur, w=512, h=512):
    return {"v": "5.7.4", "fr": FPS, "ip": 0, "op": dur, "w": w, "h": h,
            "nm": name, "ddd": 0, "assets": [], "layers": layers}


# ── Effect builders ───────────────────────────────────────────────────────────

def avatar_frame(name, ring=GOLD, accent=GOLD_LT, inner=ROSE,
                 diameter=408, sparks=4, seconds=3.0):
    """A rotating ring with a breathing halo and orbiting sparks.

    This is the workhorse: every tier of avatar frame is this shape with a
    different palette, ring weight and spark count. Eight tiers is eight calls.
    """
    dur = int(seconds * FPS)
    r_out = diameter / 2
    L = [
        _layer(1, "ring", [_group(_ellipse(diameter),
                                  _grad_stroke(14, [(0, accent), (0.5, ring), (1, accent)], r_out),
                                  _tr())],
               dur, rot=linear(0, 0, dur, 360)),
        _layer(2, "inner", [_group(_ellipse(diameter - 36),
                                   _grad_stroke(3, [(0, ring), (1, inner)], r_out - 18),
                                   _tr())],
               dur, rot=linear(0, 360, dur, 0)),
        _layer(3, "halo", [_group(_ellipse(diameter + 22),
                                  _grad_stroke(26, [(0, ring), (1, ring)], r_out + 11),
                                  _tr())],
               dur,
               scale=eased(0, [100, 100, 100], dur // 2, [104, 104, 100], dur, [100, 100, 100]),
               opacity=eased(0, 18, dur // 2, 40, dur, 18)),
    ]
    for i in range(sparks):
        step = dur // max(sparks, 1)
        L.append(_layer(4 + i, f"spark{i}",
                        [_group(_ellipse(14), _fill(accent), _tr(p=(r_out, 0)))],
                        dur,
                        rot=linear(0, i * (360 / sparks), dur, i * (360 / sparks) + 360),
                        opacity=eased(0, 30, (i * step + step // 2) % dur, 100, dur, 30)))
    return _comp(name, L, dur)


def burst(name, spokes=12, a=GOLD, b=ROSE, ring=(ROSE, VIOLET), seconds=0.75):
    """Radial shockwave plus spokes. Combo streaks, level-ups, lucky wins."""
    dur = int(seconds * FPS)
    L = [_layer(1, "shock", [_group(_ellipse(120),
                                    _grad_stroke(10, [(0, ring[0]), (1, ring[1])], 60), _tr())],
                dur,
                scale=eased(0, [40, 40, 100], dur, [260, 260, 100]),
                opacity=eased(0, 100, dur, 0))]
    for i in range(spokes):
        L.append(_layer(2 + i, f"spoke{i}",
                        [_group(_rect(8, 46, 4, (0, -150)), _fill(a if i % 2 == 0 else b), _tr())],
                        dur,
                        rot=fixed(i * (360 / spokes)),
                        scale=eased(0, [100, 30, 100], int(dur * 0.55), [100, 130, 100],
                                    dur, [100, 20, 100]),
                        opacity=eased(0, 0, 8, 100, dur, 0)))
    return _comp(name, L, dur)


def entrance_sweep(name, tint=VIOLET, glow=ROSE, seconds=2.2, w=1080, h=260):
    """A banner that sweeps in, holds, then sweeps out.

    This is the honest version of a "big entrance": a lit banner the user's
    avatar and name sit on. It is NOT a driving car — that needs an animator.
    """
    dur = int(seconds * FPS)
    hold_in, hold_out = int(dur * 0.22), int(dur * 0.78)
    L = [
        _layer(1, "streak", [_group(_rect(w * 1.4, h, h / 2),
                                    _grad_stroke(h, [(0, tint), (0.5, glow), (1, tint)], w * 0.7),
                                    _tr())],
               dur, pos=(w / 2, h / 2),
               scale=eased(0, [40, 100, 100], hold_in, [100, 100, 100], dur, [140, 100, 100]),
               opacity=eased(0, 0, hold_in, 90, hold_out, 90, dur, 0)),
        _layer(2, "flare", [_group(_ellipse(h * 1.5), _fill(glow), _tr())],
               dur, pos=(0, h / 2),
               opacity=eased(0, 0, hold_in, 55, hold_out, 20, dur, 0)),
    ]
    for i in range(10):
        L.append(_layer(3 + i, f"mote{i}",
                        [_group(_ellipse(6 + (i % 3) * 3), _fill(GOLD_LT), _tr())],
                        dur, pos=(w * (0.1 + 0.085 * i), h / 2 + (-40 if i % 2 else 40)),
                        scale=eased(0, [60, 60, 100], dur, [120, 120, 100]),
                        opacity=eased(0, 0, hold_in + i * 2, 100, dur, 0)))
    return _comp(name, L, dur, w=w, h=h)


def progress_ring(name, tint=MINT, track=(0.14, 0.15, 0.24), diameter=360, seconds=1.4):
    """A ring that fills 0→100%. Wish gifts, task progress, payout threshold."""
    dur = int(seconds * FPS)
    r = diameter / 2
    return _comp(name, [
        _layer(1, "track", [_group(_ellipse(diameter), _stroke(track, 18), _tr())], dur),
        _layer(2, "fill", [_group(_ellipse(diameter),
                                  _grad_stroke(18, [(0, tint), (1, GOLD)], r),
                                  {"ty": "tm", "s": fixed(0), "e": eased(0, 0, dur, 100),
                                   "o": fixed(0), "m": 1},
                                  _tr())],
               dur, rot=fixed(-90)),
    ], dur)


def shimmer(name, tint=GOLD_LT, w=320, h=64, seconds=1.6):
    """A highlight sweeping across a surface. Chat bubbles, VIP cards."""
    dur = int(seconds * FPS)
    return _comp(name, [
        _layer(1, "sheen", [_group(_rect(90, h * 2, 0), _fill(tint, 55), _tr())],
               dur, pos=(0, h / 2),
               rot=fixed(18),
               opacity=eased(0, 0, int(dur * 0.2), 70, int(dur * 0.8), 70, dur, 0)),
    ], dur, w=w, h=h)


# ── Validation ────────────────────────────────────────────────────────────────

_SHAPE_REQ = {"el": ["s", "p"], "rc": ["s", "p", "r"], "gs": ["o", "w", "g", "s", "e", "t"],
              "st": ["c", "o", "w"], "fl": ["c", "o"], "tm": ["s", "e", "o"],
              "tr": ["p", "a", "s", "r", "o"], "gr": ["it"]}


def validate(doc) -> list[str]:
    """Structural check against the Lottie spec. Returns a list of problems."""
    errs: list[str] = []

    def prop(v, path):
        if not isinstance(v, dict) or "a" not in v or "k" not in v:
            errs.append(f"{path}: not an animatable property"); return
        if v["a"] == 1:
            ts = [k.get("t") for k in v["k"]]
            if any(t is None for t in ts): errs.append(f"{path}: keyframe missing 't'")
            elif ts != sorted(ts): errs.append(f"{path}: keyframes out of order {ts}")
            for k in v["k"]:
                if "s" not in k: errs.append(f"{path}: keyframe missing 's'")

    def shape(s, path):
        ty = s.get("ty")
        if not ty: errs.append(f"{path}: missing 'ty'"); return
        for k in _SHAPE_REQ.get(ty, []):
            if k not in s: errs.append(f"{path}[{ty}]: missing '{k}'")
        if ty == "gr":
            for i, c in enumerate(s["it"]): shape(c, f"{path}.it[{i}]")
        if ty == "gs":
            k = s["g"]["k"]["k"]; n = s["g"]["p"]
            if len(k) != n * 4:
                errs.append(f"{path}: p={n} but {len(k)} floats (expected {n * 4})")
            for j in range(0, len(k), 4):
                for c in k[j:j + 4]:
                    if not 0.0 <= c <= 1.0:
                        errs.append(f"{path}: value {c} outside 0..1 — Lottie colours are 0-1, not 0-255")

    for k in ["v", "fr", "ip", "op", "w", "h", "layers"]:
        if k not in doc: errs.append(f"root: missing '{k}'")
    for i, L in enumerate(doc.get("layers", [])):
        p = f"layer[{i}] '{L.get('nm', '?')}'"
        for k in ["ty", "ks", "ip", "op", "st"]:
            if k not in L: errs.append(f"{p}: missing '{k}'")
        for k in ["o", "r", "p", "a", "s"]:
            if k not in L.get("ks", {}): errs.append(f"{p}.ks: missing '{k}'")
            else: prop(L["ks"][k], f"{p}.ks.{k}")
        if L.get("op", 0) > doc.get("op", 0):
            errs.append(f"{p}: op {L['op']} exceeds composition op {doc['op']}")
        for j, s in enumerate(L.get("shapes", [])): shape(s, f"{p}.shapes[{j}]")
    return errs


def write(doc, path):
    errs = validate(doc)
    if errs:
        raise ValueError(f"{doc['nm']} failed validation:\n  " + "\n  ".join(errs))
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    return path


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        for maker in [lambda: avatar_frame("t"), lambda: burst("t"),
                      lambda: entrance_sweep("t"), lambda: progress_ring("t"),
                      lambda: shimmer("t")]:
            d = maker()
            e = validate(d)
            print(f"{d['nm']:<28} {'PASS' if not e else 'FAIL'}")
            for x in e: print("   ✗", x)
