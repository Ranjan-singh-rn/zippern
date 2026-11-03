"""Effect templates: artwork in, a finished SVGA movie out (B13, 4 Nov 2026).

Each template takes transparent PNG artwork (from an image model, or drawn here when none is given) and composes
the motion live apps use:

  gift_burst        the gift pops in at centre stage with light rays, a pulsing glow and a sparkle burst
  avatar_frame      a looping frame around the user's avatar: ring pulse, glow and orbiting sparkles
  entrance_banner   a name banner sweeps in, greets the user by avatar and name, and sweeps out
  vehicle_entrance  a vehicle drives in, pauses with the user's name, and drives off

Dynamic keys — replaced by the app at play time, so one file serves every user:
  `avatar`  the user's photo (a disc placeholder here)
  `name`    the user's name (a transparent text slot here)

Deterministic: the same artwork and seed give the same bytes.
"""

from __future__ import annotations

import math
import random

from PIL import Image

import procedural as P
from motion import (Track, animate, const, ease_in_cubic, ease_in_out_sine, ease_out_back, ease_out_cubic, linear)
from svga import Frame, Movie, pose

SCREEN_W, SCREEN_H = 750.0, 1334.0
FPS = 20


def _add(m: Movie, key: str, img: Image.Image) -> tuple[str, int, int]:
    m.add_image(key, P.png(img))
    return key, img.width, img.height


def gift_burst(art: Image.Image | None = None, *, seconds: float = 3.0, color=(255, 200, 80), seed: int = 7) -> Movie:
    frames = int(seconds * FPS)
    m = Movie(SCREEN_W, SCREEN_H, FPS, frames)
    rnd = random.Random(seed)
    cx, cy = SCREEN_W / 2, SCREEN_H * 0.46
    end = frames - 1
    art = P.fit(P.trim(art), 440) if art is not None else P.glow(300, color, 1.0)

    k, w, h = _add(m, "rays", P.rays(720, color))
    m.add_sprite(k, animate(frames, w, h, x=const(cx), y=const(cy),
                            scale=Track([(0, 0.6), (10, 1.0, ease_out_cubic)]),
                            rotation=Track([(0, 0), (end, 40, linear)]),
                            alpha=Track([(0, 0), (8, 0.9), (end - 12, 0.9), (end, 0, ease_in_cubic)])))

    k, w, h = _add(m, "glow", P.glow(520, color))
    m.add_sprite(k, animate(frames, w, h, x=const(cx), y=const(cy),
                            scale=Track([(0, 0.4), (10, 1.05, ease_out_back), (25, 0.95, ease_in_out_sine),
                                         (40, 1.05, ease_in_out_sine), (end, 0.6, ease_in_cubic)]),
                            alpha=Track([(0, 0), (6, 0.95), (end - 10, 0.85), (end, 0)])))

    k, w, h = _add(m, "art", art)
    m.add_sprite(k, animate(frames, w, h, x=const(cx),
                            y=Track([(0, cy + 40), (12, cy, ease_out_cubic), (24, cy - 10, ease_in_out_sine),
                                     (36, cy, ease_in_out_sine), (48, cy - 8, ease_in_out_sine), (end, cy - 30)]),
                            scale=Track([(0, 0.1), (12, 1.0, ease_out_back), (end - 10, 1.0), (end, 0.55, ease_in_cubic)]),
                            alpha=Track([(0, 0), (4, 1), (end - 8, 1), (end, 0, ease_in_cubic)])))

    sk = _add(m, "sparkle", P.sparkle(64))[0]
    for i in range(14):
        start = 6 + rnd.randint(0, 10)
        life = rnd.randint(14, 22)
        ang = rnd.uniform(0, 2 * math.pi)
        dist = rnd.uniform(220, 420)
        size = rnd.uniform(0.5, 1.3)
        spin = rnd.uniform(-180, 180)
        m.add_sprite(sk, animate(
            frames, 64, 64,
            x=Track([(start, cx), (start + life, cx + dist * math.cos(ang), ease_out_cubic)]),
            y=Track([(start, cy), (start + life, cy + dist * math.sin(ang), ease_out_cubic)]),
            scale=Track([(start, size * 0.4), (start + life * 0.3, size), (start + life, size * 0.3)]),
            rotation=Track([(start, 0), (start + life, spin)]),
            alpha=Track([(start, 1), (start + life * 0.6, 1), (start + life, 0)]),
            visible=lambda f, s=start, l=life: s <= f <= s + l))
    for i in range(6):  # twinkles that stay near the gift
        px = cx + rnd.uniform(-200, 200)
        py = cy + rnd.uniform(-200, 200)
        t0 = rnd.randint(12, 30)
        m.add_sprite(sk, animate(
            frames, 64, 64, x=const(px), y=const(py),
            scale=Track([(t0, 0.2), (t0 + 6, 0.9, ease_out_back), (t0 + 14, 0.2)]),
            alpha=Track([(t0, 0), (t0 + 4, 1), (t0 + 14, 0)]),
            visible=lambda f, s=t0: s <= f <= s + 14))
    return m


def avatar_frame(ring_art: Image.Image | None = None, *, seconds: float = 2.0, color=(255, 200, 80),
                 size: float = 300.0) -> Movie:
    """A seamless loop: the last frame leads straight back into the first."""
    frames = int(seconds * FPS)
    m = Movie(size, size, FPS, frames)
    c = size / 2
    art = P.fit(P.trim(ring_art), int(size)) if ring_art is not None else P.ring(int(size), color)

    def wave(i: int, lo: float, hi: float, phase: float = 0.0) -> float:
        return lo + (hi - lo) * (0.5 - 0.5 * math.cos(2 * math.pi * (i / frames) + phase))

    k, w, h = _add(m, "frame_glow", P.glow(int(size), color, 0.7))
    m.add_sprite(k, [pose(w, h, c, c, 1.0, 0, wave(i, 0.30, 0.65)) for i in range(frames)])
    k, w, h = _add(m, "frame_ring", art)
    m.add_sprite(k, [pose(w, h, c, c, wave(i, 1.0, 1.025)) for i in range(frames)])
    sk = _add(m, "frame_sparkle", P.sparkle(48))[0]
    r = size * 0.40
    for n in range(4):
        base = n * math.pi / 2
        m.add_sprite(sk, [pose(48, 48,
                               c + r * math.cos(base + 2 * math.pi * i / frames),
                               c + r * math.sin(base + 2 * math.pi * i / frames),
                               wave(i, 0.35, 0.8, n), (360 * i / frames) % 360, wave(i, 0.4, 1.0, n * 1.3))
                          for i in range(frames)])
    return m


def entrance_banner(banner_art: Image.Image | None = None, emblem_art: Image.Image | None = None, *,
                    seconds: float = 3.5, color=(255, 120, 200), seed: int = 11) -> Movie:
    frames = int(seconds * FPS)
    m = Movie(SCREEN_W, SCREEN_H, FPS, frames)
    rnd = random.Random(seed)
    y = SCREEN_H * 0.42
    if banner_art is None:
        banner_art = _plain_banner(color)
    banner = P.fit(P.trim(banner_art), 640)
    bx = Track([(0, -banner.width / 2 - 40), (12, SCREEN_W / 2, ease_out_cubic), (52, SCREEN_W / 2),
                (66, SCREEN_W + banner.width / 2 + 40, ease_in_cubic)])
    fade = Track([(0, 1), (66, 1), (68, 0)])
    visible = lambda f: f <= 67  # noqa: E731

    k, w, h = _add(m, "banner", banner)
    m.add_sprite(k, animate(frames, w, h, x=bx, y=const(y), alpha=fade, visible=visible))

    def follow(dx: float) -> Track:
        return Track([(f, bx.at(f) + dx) for f in range(frames)])

    left = -banner.width / 2 + 90
    k, w, h = _add(m, "avatar", P.disc(120))
    m.add_sprite(k, animate(frames, w, h, x=follow(left), y=const(y), alpha=fade, visible=visible))
    k, w, h = _add(m, "name", P.text_slot(340, 60))
    m.add_sprite(k, animate(frames, w, h, x=follow(left + 80 + 170), y=const(y), alpha=fade, visible=visible))
    if emblem_art is not None:
        emblem = P.fit(P.trim(emblem_art), 150)
        k, w, h = _add(m, "emblem", emblem)
        m.add_sprite(k, animate(frames, w, h, x=follow(left), y=const(y - 95),
                                scale=Track([(10, 0.0), (18, 1.0, ease_out_back)]), alpha=fade,
                                visible=lambda f: 10 <= f <= 67))
    sk = _add(m, "trail_sparkle", P.sparkle(48))[0]
    for i in range(10):
        t0 = rnd.randint(0, 12)
        oy = rnd.uniform(-60, 60)
        m.add_sprite(sk, animate(
            frames, 48, 48,
            x=Track([(t0, bx.at(t0) - banner.width / 2), (t0 + 14, bx.at(t0) - banner.width / 2 - 120, ease_out_cubic)]),
            y=const(y + oy),
            scale=Track([(t0, 1.0), (t0 + 14, 0.2)]),
            alpha=Track([(t0, 1), (t0 + 14, 0)]),
            visible=lambda f, s=t0: s <= f <= s + 14))
    return m


def vehicle_entrance(body_art: Image.Image | None = None, *, seconds: float = 4.0, color=(120, 200, 255),
                     seed: int = 5) -> Movie:
    frames = int(seconds * FPS)
    m = Movie(SCREEN_W, SCREEN_H, FPS, frames)
    rnd = random.Random(seed)
    y = SCREEN_H * 0.50
    body = P.fit(P.trim(body_art), 560) if body_art is not None else P.glow(360, color, 1.0)
    x = Track([(0, SCREEN_W + body.width / 2 + 60), (24, SCREEN_W / 2, ease_out_cubic), (56, SCREEN_W / 2),
               (76, -body.width / 2 - 60, ease_in_cubic)])
    bounce = Track([(0, y), (24, y), (28, y - 6, ease_out_cubic), (32, y, ease_in_out_sine), (56, y), (76, y)])
    visible = lambda f: f <= 77  # noqa: E731

    k, w, h = _add(m, "ground_glow", P.glow(420, color, 0.8))
    m.add_sprite(k, animate(frames, w, h, x=x, y=Track([(f, bounce.at(f) + body.height * 0.42) for f in range(frames)]),
                            scale=const(1.0), scale_y=const(0.28), alpha=const(0.8), visible=visible))
    k, w, h = _add(m, "vehicle", body)
    m.add_sprite(k, animate(frames, w, h, x=x, y=bounce, visible=visible))
    k, w, h = _add(m, "name", P.text_slot(360, 60))
    m.add_sprite(k, animate(frames, w, h, x=x, y=const(y + body.height * 0.62),
                            alpha=Track([(20, 0), (28, 1), (54, 1), (58, 0)]), visible=lambda f: 20 <= f <= 58))
    streak = Image.new("RGBA", (240, 8), (255, 255, 255, 0))
    for i in range(240):  # a horizontal light streak fading to the left
        for j in range(8):
            streak.putpixel((i, j), (255, 255, 255, int(200 * (i / 239) * (1 - abs(j - 3.5) / 4))))
    sk = _add(m, "streak", streak)[0]
    for i in range(8):
        oy = rnd.uniform(-body.height * 0.4, body.height * 0.4)
        lag = rnd.uniform(40, 160)
        for (a, b) in ((0, 24), (56, 76)):
            m.add_sprite(sk, animate(frames, 240, 8,
                                     x=Track([(f, x.at(f) + (body.width / 2 + lag if a == 0 else -body.width / 2 - lag))
                                              for f in range(frames)]),
                                     y=Track([(f, bounce.at(f) + oy) for f in range(frames)]),
                                     alpha=Track([(a, 0), (a + 4, 0.9), (b - 4, 0.9), (b, 0)]),
                                     rotation=const(0 if a == 56 else 180),
                                     visible=lambda f, s=a, e=b: s <= f <= e))
    return m


def _plain_banner(color) -> Image.Image:
    from PIL import ImageDraw, ImageFilter
    img = Image.new("RGBA", (640, 150), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([10, 20, 630, 130], radius=55, fill=(color[0], color[1], color[2], 230),
                        outline=(255, 255, 255, 255), width=4)
    return Image.alpha_composite(img.filter(ImageFilter.GaussianBlur(6)), img)
