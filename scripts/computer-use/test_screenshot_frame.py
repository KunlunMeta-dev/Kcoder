from base64 import b64encode
from io import BytesIO
import json
from random import Random
from types import SimpleNamespace
import unittest

from PIL import Image

from screenshot_frame import ScreenshotFrame, bound_screenshot_text, encode_screenshot


class ScreenshotFrameTests(unittest.TestCase):
    def test_points_in_virtual_desktop_gaps_do_not_map_to_input(self):
        frame = ScreenshotFrame((-800, 0), (1800, 600), (900, 300))
        displays = [
            SimpleNamespace(left=-800, right=0, top=0, bottom=600),
            SimpleNamespace(left=200, right=1000, top=0, bottom=600),
        ]
        self.assertEqual(frame.to_desktop([200, 80], displays), [-399, 161])
        with self.assertRaisesRegex(ValueError, "does not fall on a display"):
            frame.to_desktop([440, 80], displays)

    def test_small_capture_keeps_lossless_pixels_and_native_coordinates(self):
        image = Image.new("RGB", (321, 123), (220, 40, 90))
        data, image_format, size = encode_screenshot(image)
        self.assertEqual((image_format, size), ("png", image.size))
        with Image.open(BytesIO(data)) as decoded:
            self.assertEqual(decoded.tobytes(), image.tobytes())
        frame = ScreenshotFrame((-1920, -80), image.size, size)
        self.assertEqual(frame.to_desktop([320, 122]), [-1600, 42])

    def test_jpeg_can_keep_resolution_when_only_png_exceeds_budget(self):
        size = (1200, 800)
        noise = Image.frombytes("RGB", size, Random(42).randbytes(3 * size[0] * size[1]))
        image = Image.blend(Image.new("RGB", size, (120, 120, 120)), noise, 0.2)
        data, image_format, delivered_size = encode_screenshot(image)
        self.assertEqual((image_format, delivered_size), ("jpeg", size))
        self.assertLessEqual(len(b64encode(data)), 1024 * 1024)

    def test_high_entropy_8k_view_stays_within_the_base64_budget(self):
        # The worker's first dimension limit has already reduced this 8K frame.
        size = (1920, 1080)
        image = Image.frombytes("RGB", size, Random(42).randbytes(3 * size[0] * size[1]))
        old_png = BytesIO()
        image.save(old_png, format="PNG")
        self.assertGreater(len(b64encode(old_png.getvalue())), 1024 * 1024)

        budget = 1536 * 1024
        data, image_format, delivered_size = encode_screenshot(image, base64_budget=budget)
        self.assertGreater(len(b64encode(data)), 1024 * 1024)
        self.assertLessEqual(len(b64encode(data)), budget)
        self.assertEqual(image_format, "jpeg")
        self.assertEqual(delivered_size, (1600, 900))
        with Image.open(BytesIO(data)) as decoded:
            decoded.load()
            self.assertEqual(decoded.size, delivered_size)
        frame = ScreenshotFrame((-7680, -100), (7680, 4320), delivered_size)
        x, y = frame.to_desktop([delivered_size[0] // 2, delivered_size[1] // 2])
        self.assertLessEqual(abs(x + 3840), 4)
        self.assertLessEqual(abs(y - 2060), 4)

    def test_large_snapshot_text_keeps_metadata_and_fits_the_broker_reply(self):
        metadata = "Screenshot ID: fixture\n"
        text = bound_screenshot_text(metadata + "\x00😀\n" * 100_000)
        self.assertTrue(text.startswith(metadata))
        self.assertTrue(text.endswith("use a text-only Snapshot for more detail.]"))
        reply = {"requestId": 1, "result": {"content": [
            {"type": "text", "text": text},
            {"type": "image", "mimeType": "image/jpeg", "data": "A" * (1536 * 1024)},
        ]}}
        wire = json.dumps(reply, ensure_ascii=False).encode("utf-8")
        self.assertLess(len(wire), 2 * 1024 * 1024)
        self.assertEqual(bound_screenshot_text(metadata), metadata)

    def test_uneven_ratios_and_crop_origin_use_actual_dimensions(self):
        frame = ScreenshotFrame((-300, 47), (1001, 501), (333, 167))
        self.assertEqual(frame.to_desktop([0, 0]), [-299, 48])
        self.assertEqual(frame.to_desktop([332, 166]), [699, 546])
        for pixel in ([-1, 0], [333, 0], [0, 167]):
            with self.subTest(pixel=pixel), self.assertRaisesRegex(ValueError, "outside the image"):
                frame.to_desktop(pixel)
