"""Procedural effect layers — sparkles, glows, light rays, rings, placeholders (B13, 4 Nov 2026).

Generic shapes drawn with Pillow, so every effect has its sparkle and glow even when the main artwork came from an
image model. RGBA PNGs, premultiplied by nothing: what the SVGA players expect.
"""

from __future__ import annotations

import io
import math

from PIL import Image, ImageDraw, ImageFilter


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _rgba(color: tuple[int, int, int], a: int = 255) -> tuple[int, int, int, int]:
    return (color[0], color[1], color[2], a)


def sparkle(size: int = 64, color: tuple[int, int, int] = (255, 236, 160)) -> Image.Image:
    """A four-point star with a soft halo."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    c = size / 2
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([c - size * 0.22, c - size * 0.22, c + size * 0.22, c + size * 0.22], fill=_rgba(color, 150))
    img = Image.alpha_composite(img, halo.filter(ImageFilter.GaussianBlur(size * 0.08)))
    star = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(star)
    long, short = size * 0.48, size * 0.07
    d.polygon([(c, c - long), (c + short, c - short), (c + long, c), (c + short, c + short),
               (c, c + long), (c - short, c + short), (c - long, c), (c - short, c - short)], fill=_rgba((255, 255, 255)))
    return Image.alpha_composite(img, star)


def glow(size: int = 512, color: tuple[int, int, int] = (255, 196, 64), strength: float = 0.85) -> Image.Image:
    """A radial glow fading to transparent at the edge."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    c = (size - 1) / 2
    for yy in range(size):
        for xx in range(size):
            r = math.hypot(xx - c, yy - c) / c
            if r < 1:
                a = int(255 * strength * (1 - r) ** 2.2)
                px[xx, yy] = _rgba(color, a)
    return img


def rays(size: int = 720, color: tuple[int, int, int] = (255, 226, 140), count: int = 14) -> Image.Image:
    """Soft light rays radiating from the centre — rotated slowly behind a gift."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = size / 2
    for i in range(count):
        a0 = (2 * math.pi / count) * i
        a1 = a0 + (2 * math.pi / count) * 0.38
        d.polygon([(c, c), (c + c * math.cos(a0), c + c * math.sin(a0)), (c + c * math.cos(a1), c + c * math.sin(a1))],
                  fill=_rgba(color, 90))
    img = img.filter(ImageFilter.GaussianBlur(size * 0.012))
    mask = glow(size, (255, 255, 255), 1.0).split()[3]  # fade the rays out towards the edge
    r, g, b, a = img.split()
    a = Image.composite(a, Image.new("L", img.size, 0), mask)
    return Image.merge("RGBA", (r, g, b, a))


def ring(size: int = 300, color: tuple[int, int, int] = (255, 200, 80), width_ratio: float = 0.07) -> Image.Image:
    """A glowing ring — the bones of an avatar frame when no artwork is supplied."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w = size * width_ratio
    pad = size * 0.12
    d.ellipse([pad, pad, size - pad, size - pad], outline=_rgba(color), width=int(w))
    blur = img.filter(ImageFilter.GaussianBlur(w * 0.8))
    return Image.alpha_composite(blur, img)


def disc(size: int = 160, color: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """A plain disc: the placeholder the app swaps for the user's avatar (dynamic image key `avatar`)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([0, 0, size - 1, size - 1], fill=_rgba(color))
    return img


def text_slot(w: int = 360, h: int = 64) -> Image.Image:
    """A transparent box: the app draws the user's name into it (dynamic text key `name`)."""
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def trim(img: Image.Image, pad: int = 4) -> Image.Image:
    """Crop to the visible pixels (plus a little padding) so sprites are as small as they can be."""
    bbox = img.split()[3].getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def fit(img: Image.Image, max_side: int) -> Image.Image:
    """Scale down so the longer side is at most max_side (never up)."""
    s = max(img.width, img.height)
    if s <= max_side:
        return img
    k = max_side / s
    return img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)


def remove_plain_background(img: Image.Image, tolerance: int = 28, feather: float = 1.2) -> Image.Image:
    """
    Cut a plain (near-white or near-black) studio background out of generated artwork, when the model could not give
    a transparent one. Flood-fills from the corners, so a white highlight inside the subject is kept.
    """
    rgba = img.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    bg = px[0, 0][:3]
    seen = bytearray(w * h)
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        r, g, b = px[x, y][:3]
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > tolerance * 3:
            continue
        mp[x, y] = 0
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    mask = mask.filter(ImageFilter.GaussianBlur(feather))
    out = rgba.copy()
    out.putalpha(Image.composite(rgba.split()[3], Image.new("L", (w, h), 0), mask))
    return out
