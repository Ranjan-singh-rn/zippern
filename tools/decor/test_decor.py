"""B13 — the SVGA writer, the motion maths and the templates.

    cd tools/decor && python3 -m unittest -v test_decor
"""

import math
import unittest
import zlib

from PIL import Image

import procedural as P
import templates as T
from motion import Track, ease_out_back, ease_out_cubic, linear
from svga import Frame, Layout, Movie, Transform, decode, pose


def png(w=8, h=8, color=(255, 0, 0, 255)) -> bytes:
    return P.png(Image.new("RGBA", (w, h), color))


class SvgaFormat(unittest.TestCase):
    def test_round_trip(self):
        m = Movie(750, 1334, 20, 3)
        m.add_image("a", png())
        m.add_image("b", png(4, 4))
        m.add_sprite("a", [pose(8, 8, 100, 200, 2.0, 30, 0.5), Frame(), pose(8, 8, 1, 2)])
        m.add_sprite("b", [Frame(), Frame(), pose(4, 4, 375, 667)])
        back = decode(m.to_svga())
        self.assertEqual(back.version, "2.0.0")
        self.assertEqual((back.width, back.height, back.fps, back.frames), (750, 1334, 20, 3))
        self.assertEqual(sorted(back.images), ["a", "b"])
        self.assertEqual(back.images["a"], m.images["a"])
        self.assertEqual([s.image_key for s in back.sprites], ["a", "b"])
        self.assertEqual(len(back.sprites[0].frames), 3)
        f = back.sprites[0].frames[0]
        self.assertAlmostEqual(f.alpha, 0.5, places=5)
        want = m.sprites[0].frames[0].transform
        for k in ("a", "b", "c", "d", "tx", "ty"):
            self.assertAlmostEqual(getattr(f.transform, k), getattr(want, k), places=3)
        self.assertFalse(back.sprites[0].frames[1].visible)  # an invisible frame stays invisible

    def test_a_2x_file_is_zlib_not_zip(self):
        m = Movie(10, 10, 20, 1)
        m.add_image("a", png())
        m.add_sprite("a", [pose(8, 8, 5, 5)])
        data = m.to_svga()
        self.assertNotEqual(data[:4], b"PK\x03\x04")
        self.assertTrue(zlib.decompress(data))

    def test_refuses_mistakes(self):
        m = Movie(10, 10, 20, 2)
        with self.assertRaises(ValueError):
            m.add_image("x", b"GIF89a")
        m.add_image("a", png())
        with self.assertRaises(ValueError):
            m.add_sprite("missing", [Frame(), Frame()])
        with self.assertRaises(ValueError):
            m.add_sprite("a", [Frame()])

    def test_same_input_same_bytes(self):
        self.assertEqual(T.gift_burst(seed=3).to_svga(), T.gift_burst(seed=3).to_svga())


class Geometry(unittest.TestCase):
    def test_pose_centres_the_image(self):
        f = pose(100, 60, 375, 500, scale=1.7, rotation_deg=33)
        cx, cy = f.transform.apply(50, 30)
        self.assertAlmostEqual(cx, 375, places=4)
        self.assertAlmostEqual(cy, 500, places=4)

    def test_quarter_turn(self):
        f = pose(100, 100, 0, 0, rotation_deg=90)
        x, y = f.transform.apply(100, 50)  # the right-middle edge point turns to the bottom
        self.assertAlmostEqual(x, 0, places=4)
        self.assertAlmostEqual(y, 50, places=4)

    def test_hidden_when_transparent_or_zero_size(self):
        self.assertFalse(pose(10, 10, 0, 0, alpha=0).visible)
        self.assertFalse(pose(10, 10, 0, 0, scale=0).visible)


class Motion(unittest.TestCase):
    def test_tracks_hit_their_keys(self):
        t = Track([(0, 0), (10, 100, ease_out_cubic), (20, 50, linear)])
        self.assertEqual(t.at(-5), 0)
        self.assertEqual(t.at(10), 100)
        self.assertEqual(t.at(15), 75)
        self.assertEqual(t.at(99), 50)

    def test_ease_out_back_overshoots_then_lands(self):
        peak = max(ease_out_back(i / 100) for i in range(101))
        self.assertGreater(peak, 1.0)
        self.assertAlmostEqual(ease_out_back(1.0), 1.0, places=9)


class Templates(unittest.TestCase):
    def _check(self, m: Movie):
        for s in m.sprites:
            self.assertEqual(len(s.frames), m.frames)
            self.assertIn(s.image_key, m.images)
        self.assertTrue(any(f.visible for s in m.sprites for f in s.frames))
        self.assertEqual(decode(m.to_svga()).frames, m.frames)

    def test_gift(self):
        art = Image.new("RGBA", (500, 400), (0, 0, 0, 0))
        art.paste((255, 215, 0, 255), (100, 100, 400, 300))
        m = T.gift_burst(art)
        self._check(m)
        self.assertLess(len(m.to_svga()), 1_500_000)

    def test_avatar_frame_loops_seamlessly(self):
        m = T.avatar_frame()
        self._check(m)
        ring = next(s for s in m.sprites if s.image_key == "frame_ring")
        first, last = ring.frames[0].transform, ring.frames[-1].transform
        self.assertAlmostEqual(first.a, last.a, places=2)  # one step from the start, nearly identical

    def test_entrance_has_the_dynamic_keys(self):
        m = T.entrance_banner()
        self._check(m)
        self.assertIn("avatar", m.images)
        self.assertIn("name", m.images)

    def test_vehicle(self):
        self._check(T.vehicle_entrance())


class Cutout(unittest.TestCase):
    def test_plain_background_is_removed_and_the_subject_kept(self):
        img = Image.new("RGB", (60, 60), (255, 255, 255))
        img.paste((200, 30, 30), (20, 20, 40, 40))
        img.paste((255, 255, 255), (28, 28, 32, 32))  # a white highlight INSIDE the subject stays
        out = P.remove_plain_background(img, feather=0.1)
        self.assertEqual(out.getpixel((2, 2))[3], 0)
        self.assertGreater(out.getpixel((25, 25))[3], 200)
        self.assertGreater(out.getpixel((30, 30))[3], 200)


if __name__ == "__main__":
    unittest.main()
