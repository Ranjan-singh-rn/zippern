"""Keyframe tracks and easing for SVGA sprites (B13, 4 Nov 2026).

A Track holds (frame, value, easing-into-this-key) keys and gives the value at any frame; `animate()` turns tracks
for x, y, scale, rotation and alpha into the per-frame list a Sprite needs. Pure maths — tested in test_decor.py.
"""

from __future__ import annotations

import math
from typing import Callable

from svga import Frame, pose

Ease = Callable[[float], float]


def linear(t: float) -> float:
    return t


def ease_in_out_sine(t: float) -> float:
    return -(math.cos(math.pi * t) - 1) / 2


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def ease_in_cubic(t: float) -> float:
    return t ** 3


def ease_out_back(t: float, k: float = 1.70158) -> float:
    """Overshoots past the target and settles back — the 'pop' of a gift arriving."""
    t -= 1
    return 1 + (k + 1) * t ** 3 + k * t ** 2


def ease_out_elastic(t: float) -> float:
    if t in (0.0, 1.0):
        return t
    return 2 ** (-10 * t) * math.sin((t * 10 - 0.75) * (2 * math.pi) / 3) + 1


class Track:
    """Values at key frames; between keys the value follows the easing of the later key."""

    def __init__(self, keys: list[tuple[float, float]] | list[tuple[float, float, Ease]]):
        if not keys:
            raise ValueError("a track needs at least one key")
        norm = []
        for k in keys:
            f, v = k[0], k[1]
            ease = k[2] if len(k) > 2 else linear  # type: ignore[misc]
            norm.append((float(f), float(v), ease))
        self.keys = sorted(norm, key=lambda k: k[0])

    def at(self, frame: float) -> float:
        ks = self.keys
        if frame <= ks[0][0]:
            return ks[0][1]
        if frame >= ks[-1][0]:
            return ks[-1][1]
        for (f0, v0, _), (f1, v1, e1) in zip(ks, ks[1:]):
            if f0 <= frame <= f1:
                t = 0.0 if f1 == f0 else (frame - f0) / (f1 - f0)
                return v0 + (v1 - v0) * e1(t)
        return ks[-1][1]


def const(v: float) -> Track:
    return Track([(0, v)])


def animate(frames: int, w: float, h: float, *, x: Track, y: Track, scale: Track | None = None,
            rotation: Track | None = None, alpha: Track | None = None, scale_y: Track | None = None,
            visible: Callable[[int], bool] | None = None) -> list[Frame]:
    """The per-frame poses for one sprite of size w×h (its centre follows x, y)."""
    out = []
    for i in range(frames):
        if visible is not None and not visible(i):
            out.append(Frame())
            continue
        s = scale.at(i) if scale else 1.0
        out.append(pose(
            w, h, x.at(i), y.at(i), s,
            rotation.at(i) if rotation else 0.0,
            alpha.at(i) if alpha else 1.0,
            scale_y.at(i) if scale_y else None,
        ))
    return out
