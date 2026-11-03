"""SVGA 2.0 — write and read the animation format live-streaming apps use for gifts, entrances and frames.

B13 (4 Nov 2026). No dependencies: the protobuf wire format is written by hand (it is small), so this runs anywhere
Python 3 does — the sandbox, the Mac, a CI box.

THE FORMAT
----------
An SVGA 2.x file is `zlib(MovieEntity)`, where MovieEntity is the protobuf message from the open SVGA format
(`svga.proto`):

    MovieEntity  { string version = 1; MovieParams params = 2; map<string, bytes> images = 3;
                   repeated SpriteEntity sprites = 4; repeated AudioEntity audios = 5; }
    MovieParams  { float viewBoxWidth = 1; float viewBoxHeight = 2; int32 fps = 3; int32 frames = 4; }
    SpriteEntity { string imageKey = 1; repeated FrameEntity frames = 2; string matteKey = 3; }
    FrameEntity  { float alpha = 1; Layout layout = 2; Transform transform = 3; string clipPath = 4;
                   repeated ShapeEntity shapes = 5; }
    Layout       { float x = 1; float y = 2; float width = 3; float height = 4; }
    Transform    { float a = 1; float b = 2; float c = 3; float d = 4; float tx = 5; float ty = 6; }

`images` holds PNG bytes by key; every sprite has exactly `frames` FrameEntity entries (an invisible frame is an
empty entry, alpha 0). A sprite's bitmap is drawn into `layout`, then mapped into the view box by the affine
`transform` (x' = a·x + c·y + tx, y' = b·x + d·y + ty). Players also let the app replace an image by its key at play
time (an avatar, a user name), which is how one entrance file greets every user by name.

SVGA 1.x was a zip of JSON + PNGs; players tell them apart by the zip signature, so 2.x files must not start with
`PK\\x03\\x04` — a zlib stream never does. `decode()` reads both (1.x for inspecting bought files only).

Images may be PNG (transparent) or JPEG (opaque frames — room themes); the players hand both to the platform's
bitmap decoder. Sound lives in the same `images` map: an MP3 whose bytes start with an ID3 tag (that is how the
Android player tells audio from a picture), referenced by an AudioEntity {audioKey=1, startFrame=2, endFrame=3,
startTime=4, totalTime=5} in field 5.

Omitted Transform fields: the players read a missing `a` or `d` as 1.0, not 0 (SVGAPlayer-Android:
`val a = it.a ?: 1.0f`). So `a` and `d` are always written explicitly — a 0 left out would come back as 1.
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass, field

# ── protobuf wire format (just what SVGA needs) ──────────────────────────────────────────────────────────────

_VARINT, _I64, _LEN, _I32 = 0, 1, 2, 5


def _varint(n: int) -> bytes:
    if n < 0:
        n &= (1 << 64) - 1  # proto int32 negatives are 10-byte varints
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _tag(field_no: int, wire: int) -> bytes:
    return _varint((field_no << 3) | wire)


def _f32(field_no: int, v: float) -> bytes:
    # proto3: a zero scalar is not written (readers default it), which also keeps invisible frames empty.
    if v == 0.0:
        return b""
    return _tag(field_no, _I32) + struct.pack("<f", float(v))


def _f32_always(field_no: int, v: float) -> bytes:
    """Written even when 0 — for fields whose reader default is NOT 0 (Transform.a and .d default to 1)."""
    return _tag(field_no, _I32) + struct.pack("<f", float(v))


def _i32(field_no: int, v: int) -> bytes:
    if v == 0:
        return b""
    return _tag(field_no, _VARINT) + _varint(int(v))


def _len(field_no: int, payload: bytes) -> bytes:
    return _tag(field_no, _LEN) + _varint(len(payload)) + payload


def _str(field_no: int, s: str) -> bytes:
    return _len(field_no, s.encode("utf-8")) if s else b""


# ── the model ────────────────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Layout:
    x: float = 0.0
    y: float = 0.0
    width: float = 0.0
    height: float = 0.0

    def encode(self) -> bytes:
        return _f32(1, self.x) + _f32(2, self.y) + _f32(3, self.width) + _f32(4, self.height)


@dataclass
class Transform:
    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 1.0
    tx: float = 0.0
    ty: float = 0.0

    def encode(self) -> bytes:
        return (_f32_always(1, self.a) + _f32(2, self.b) + _f32(3, self.c) + _f32_always(4, self.d)
                + _f32(5, self.tx) + _f32(6, self.ty))

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return self.a * x + self.c * y + self.tx, self.b * x + self.d * y + self.ty


@dataclass
class Frame:
    alpha: float = 0.0
    layout: Layout | None = None
    transform: Transform | None = None
    # Read from other people's files, never written here: vector shapes and a clip path (the preview renderer
    # draws bitmaps only, so a file that leans on these previews approximately).
    shapes: int = 0
    clip_path: str = ""

    @property
    def visible(self) -> bool:
        return self.alpha > 0.0 and self.layout is not None

    def encode(self) -> bytes:
        if not self.visible:
            return b""  # an empty FrameEntity: alpha 0, drawn as nothing
        out = _f32(1, min(1.0, max(0.0, self.alpha))) + _len(2, self.layout.encode())
        if self.transform is not None:
            out += _len(3, self.transform.encode())
        return out


@dataclass
class Sprite:
    image_key: str
    frames: list[Frame]
    matte_key: str = ""

    def encode(self) -> bytes:
        out = _str(1, self.image_key)
        for f in self.frames:
            out += _len(2, f.encode())
        return out + _str(3, self.matte_key)


@dataclass
class Audio:
    key: str
    start_frame: int = 0
    end_frame: int = 0
    start_time_ms: int = 0
    total_time_ms: int = 0

    def encode(self) -> bytes:
        return (_str(1, self.key) + _i32(2, self.start_frame) + _i32(3, self.end_frame)
                + _i32(4, self.start_time_ms) + _i32(5, self.total_time_ms))


PNG_MAGIC = b"\x89PNG"
JPEG_MAGIC = b"\xff\xd8\xff"
ID3_MAGIC = b"ID3"


def _with_id3(mp3: bytes) -> bytes:
    """An MP3 the Android player recognises as audio: it must open with an ID3 tag (an empty v2.3 tag will do)."""
    if mp3.startswith(ID3_MAGIC):
        return mp3
    return ID3_MAGIC + b"\x03\x00\x00\x00\x00\x00\x00" + mp3


@dataclass
class Movie:
    width: float
    height: float
    fps: int
    frames: int
    images: dict[str, bytes] = field(default_factory=dict)
    sprites: list[Sprite] = field(default_factory=list)
    version: str = "2.0.0"
    audios: list[Audio] = field(default_factory=list)
    # How the file was stored, when it was read rather than built: "2.x", "1.x-binary" or "1.x-json".
    format: str = "2.x"

    def add_image(self, key: str, data: bytes) -> str:
        if not (data.startswith(PNG_MAGIC) or data.startswith(JPEG_MAGIC)):
            raise ValueError(f"image {key!r} is not a PNG or a JPEG")
        self.images[key] = data
        return key

    def add_audio(self, key: str, mp3: bytes, *, total_ms: int, start_frame: int = 0,
                  end_frame: int | None = None) -> Audio:
        """Sound for the movie (a gift's whoosh): stored in the images map under `key`, played from start_frame."""
        if key in self.images:
            raise ValueError(f"key {key!r} is already used")
        if len(mp3) < 4:
            raise ValueError("that audio is empty")
        self.images[key] = _with_id3(mp3)
        a = Audio(key, start_frame, self.frames if end_frame is None else end_frame, 0, int(total_ms))
        self.audios.append(a)
        return a

    def is_audio(self, key: str) -> bool:
        return any(a.key == key for a in self.audios) or self.images.get(key, b"")[:3] == ID3_MAGIC

    def decoded_bytes(self) -> int:
        """What the player holds in memory once parsed: every picture decoded to 4 bytes a pixel."""
        total = 0
        for key, data in self.images.items():
            if self.is_audio(key):
                continue
            wh = image_size(data)
            if wh:
                total += wh[0] * wh[1] * 4
        return total

    def add_sprite(self, image_key: str, frames: list[Frame]) -> Sprite:
        if image_key not in self.images:
            raise ValueError(f"sprite refers to an image that was never added: {image_key!r}")
        if len(frames) != self.frames:
            raise ValueError(f"sprite {image_key!r} has {len(frames)} frames, the movie has {self.frames}")
        s = Sprite(image_key, frames)
        self.sprites.append(s)
        return s

    def encode(self) -> bytes:
        params = _f32(1, self.width) + _f32(2, self.height) + _i32(3, self.fps) + _i32(4, self.frames)
        out = _str(1, self.version) + _len(2, params)
        for key in sorted(self.images):  # deterministic output: same input, same bytes
            out += _len(3, _str(1, key) + _len(2, self.images[key]))
        for s in self.sprites:
            out += _len(4, s.encode())
        for a in self.audios:
            out += _len(5, a.encode())
        return out

    def to_svga(self) -> bytes:
        return zlib.compress(self.encode(), 9)

    def save(self, path: str) -> int:
        data = self.to_svga()
        with open(path, "wb") as fh:
            fh.write(data)
        return len(data)


def image_size(data: bytes) -> tuple[int, int] | None:
    """Width and height of a PNG or JPEG from its header, without decoding it."""
    if data.startswith(PNG_MAGIC) and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(JPEG_MAGIC):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg = struct.unpack(">H", data[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            i += 2 + seg
    return None


# ── reading (verification, and inspecting files from elsewhere) ─────────────────────────────────────────────


class _Reader:
    def __init__(self, data: bytes):
        self.d, self.i = data, 0

    def done(self) -> bool:
        return self.i >= len(self.d)

    def varint(self) -> int:
        shift = result = 0
        while True:
            b = self.d[self.i]
            self.i += 1
            result |= (b & 0x7F) << shift
            if not b & 0x80:
                return result
            shift += 7

    def field(self):
        key = self.varint()
        no, wire = key >> 3, key & 7
        if wire == _VARINT:
            return no, wire, self.varint()
        if wire == _I32:
            v = struct.unpack("<f", self.d[self.i:self.i + 4])[0]
            self.i += 4
            return no, wire, v
        if wire == _I64:
            v = self.d[self.i:self.i + 8]
            self.i += 8
            return no, wire, v
        if wire == _LEN:
            n = self.varint()
            v = self.d[self.i:self.i + n]
            self.i += n
            return no, wire, v
        raise ValueError(f"unsupported wire type {wire}")


def _fields(data: bytes):
    r = _Reader(data)
    while not r.done():
        yield r.field()


def _layout(b: bytes) -> Layout:
    lay = Layout()
    for no, _, v in _fields(b):
        if no == 1: lay.x = v
        elif no == 2: lay.y = v
        elif no == 3: lay.width = v
        elif no == 4: lay.height = v
    return lay


def _transform(b: bytes) -> Transform:
    t = Transform()  # a and d default to 1, as the players read an omitted field (see the module notes)
    for no, _, v in _fields(b):
        setattr(t, {1: "a", 2: "b", 3: "c", 4: "d", 5: "tx", 6: "ty"}.get(no, "_"), v)
    return t


def _frame(b: bytes) -> Frame:
    f = Frame()
    for no, _, v in _fields(b):
        if no == 1: f.alpha = v
        elif no == 2: f.layout = _layout(v)
        elif no == 3: f.transform = _transform(v)
        elif no == 4: f.clip_path = v.decode("utf-8", "replace")
        elif no == 5: f.shapes += 1
    return f


def _audio(b: bytes) -> Audio:
    a = Audio("")
    for no, _, v in _fields(b):
        if no == 1: a.key = v.decode()
        elif no == 2: a.start_frame = v
        elif no == 3: a.end_frame = v
        elif no == 4: a.start_time_ms = v
        elif no == 5: a.total_time_ms = v
    return a


def decode(data: bytes) -> Movie:
    """Read an SVGA file: 2.x (zlib + protobuf), or 1.x (a zip holding movie.binary or movie.spec + PNGs)."""
    if data[:4] == b"PK\x03\x04":
        return _decode_1x(data)
    return _decode_proto(zlib.decompress(data))


def _decode_1x(data: bytes) -> Movie:
    import io
    import json
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = {n.split("/")[-1]: n for n in z.namelist() if not n.endswith("/")}
        if "movie.binary" in names:
            m = _decode_proto(z.read(names["movie.binary"]))
            m.format = "1.x-binary"
        elif "movie.spec" in names:
            m = _from_spec(json.loads(z.read(names["movie.spec"]).decode("utf-8")))
            m.format = "1.x-json"
        else:
            raise ValueError("a zip, but neither movie.binary nor movie.spec is in it — not an SVGA file")
        # 1.x keeps pictures as files in the zip: `images` maps key → file name (no extension).
        for key in [s.image_key for s in m.sprites] + list(m.images):
            raw = m.images.get(key, b"")
            if raw.startswith(PNG_MAGIC) or raw.startswith(JPEG_MAGIC) or raw[:3] == ID3_MAGIC:
                continue
            stem = raw.decode("utf-8", "ignore") if raw else key
            for cand in (stem + ".png", key + ".png", stem):
                if cand in names:
                    m.images[key] = z.read(names[cand])
                    break
    return m


def _from_spec(spec: dict) -> Movie:
    mv = spec.get("movie", {})
    vb = mv.get("viewBox", {})
    m = Movie(float(vb.get("width", 0)), float(vb.get("height", 0)), int(mv.get("fps", 20)),
              int(mv.get("frames", 0)), version=str(spec.get("ver", "1.x")))
    for key, stem in (spec.get("images") or {}).items():
        m.images[key] = str(stem).encode()
    for sp in spec.get("sprites") or []:
        frames = []
        for fr in sp.get("frames") or []:
            f = Frame(alpha=float(fr.get("alpha", 0) or 0))
            lay = fr.get("layout")
            if lay:
                f.layout = Layout(float(lay.get("x", 0)), float(lay.get("y", 0)),
                                  float(lay.get("width", 0)), float(lay.get("height", 0)))
            t = fr.get("transform")
            if t:
                f.transform = Transform(float(t.get("a", 1)), float(t.get("b", 0)), float(t.get("c", 0)),
                                        float(t.get("d", 1)), float(t.get("tx", 0)), float(t.get("ty", 0)))
            f.clip_path = str(fr.get("clipPath") or "")
            f.shapes = len(fr.get("shapes") or [])
            frames.append(f)
        m.sprites.append(Sprite(str(sp.get("imageKey", "")), frames, str(sp.get("matteKey", "") or "")))
    return m


def _decode_proto(raw: bytes) -> Movie:
    m = Movie(0, 0, 0, 0, version="")
    for no, _, v in _fields(raw):
        if no == 1:
            m.version = v.decode()
        elif no == 2:
            for pno, _, pv in _fields(v):
                if pno == 1: m.width = pv
                elif pno == 2: m.height = pv
                elif pno == 3: m.fps = pv
                elif pno == 4: m.frames = pv
        elif no == 3:
            key, val = "", b""
            for eno, _, ev in _fields(v):
                if eno == 1: key = ev.decode()
                elif eno == 2: val = ev
            m.images[key] = val
        elif no == 4:
            key, frames, matte = "", [], ""
            for sno, _, sv in _fields(v):
                if sno == 1: key = sv.decode()
                elif sno == 2: frames.append(_frame(sv))
                elif sno == 3: matte = sv.decode()
            m.sprites.append(Sprite(key, frames, matte))
        elif no == 5:
            m.audios.append(_audio(v))
    return m


# ── geometry ─────────────────────────────────────────────────────────────────────────────────────────────────


def pose(w: float, h: float, cx: float, cy: float, scale: float = 1.0, rotation_deg: float = 0.0,
         alpha: float = 1.0, scale_y: float | None = None) -> Frame:
    """A frame that draws a w×h image with its centre at (cx, cy), scaled and rotated about that centre."""
    if alpha <= 0.0 or scale <= 0.0:
        return Frame()
    sy = scale if scale_y is None else scale_y
    th = math.radians(rotation_deg)
    cos, sin = math.cos(th), math.sin(th)
    a, b, c, d = scale * cos, scale * sin, -sy * sin, sy * cos
    tx = cx - (a * w / 2 + c * h / 2)
    ty = cy - (b * w / 2 + d * h / 2)
    return Frame(alpha=alpha, layout=Layout(0, 0, w, h), transform=Transform(a, b, c, d, tx, ty))
