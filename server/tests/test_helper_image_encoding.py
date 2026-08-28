from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server import helper


class NumpyToBytesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.image = np.zeros((12, 16, 3), dtype=np.uint8)
        self.image[:, :, 0] = 17
        self.image[:, :, 1] = 83
        self.image[:, :, 2] = 211

    def assert_decodes(self, encoded: bytes) -> None:
        decoded = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        self.assertIsNotNone(decoded)
        self.assertEqual(decoded.shape[:2], self.image.shape[:2])

    def test_png_uses_only_png_compression_parameter(self) -> None:
        with mock.patch.object(helper.cv2, "imencode", wraps=helper.cv2.imencode) as imencode:
            encoded = helper.numpy_to_bytes(self.image, "PNG")

        self.assertEqual(
            imencode.call_args.args[2],
            [int(cv2.IMWRITE_PNG_COMPRESSION), 0],
        )
        self.assert_decodes(encoded)

    def test_jpeg_uses_only_jpeg_quality_parameter(self) -> None:
        with mock.patch.object(helper.cv2, "imencode", wraps=helper.cv2.imencode) as imencode:
            encoded = helper.numpy_to_bytes(self.image, ".jpg")

        self.assertEqual(
            imencode.call_args.args[2],
            [int(cv2.IMWRITE_JPEG_QUALITY), 100],
        )
        self.assert_decodes(encoded)

    def test_other_formats_receive_no_cross_format_parameters(self) -> None:
        with mock.patch.object(helper.cv2, "imencode", wraps=helper.cv2.imencode) as imencode:
            encoded = helper.numpy_to_bytes(self.image, "bmp")

        self.assertEqual(imencode.call_args.args[2], [])
        self.assert_decodes(encoded)


if __name__ == "__main__":
    unittest.main(verbosity=2)
