from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.path_io import (
    load_torch_checkpoint,
    load_torchscript,
    open_video_capture,
    read_image_file,
    stage_ascii_path,
    to_path,
    write_image_file,
)

try:
    import cv2
except ImportError:
    cv2 = None


@unittest.skipIf(cv2 is None, "opencv-python is required for path compatibility tests")
class UnicodeImagePathTests(unittest.TestCase):
    def test_image_and_mask_round_trip_in_cjk_directory(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-path-test-") as root:
            unicode_dir = Path(root) / "中文 路径" / "图片"
            image_path = unicode_dir / "测试图像.PNG"
            mask_path = unicode_dir / "测试蒙版.png"

            image = np.zeros((12, 16, 4), dtype=np.uint8)
            image[:, :, 0] = 17
            image[:, :, 1] = 83
            image[:, :, 2] = 211
            image[:, :, 3] = 127
            mask = np.zeros((12, 16), dtype=np.uint8)
            mask[2:10, 4:13] = 255

            self.assertTrue(
                write_image_file(
                    image_path,
                    image,
                    np.array([cv2.IMWRITE_PNG_COMPRESSION, 1], dtype=np.int32),
                    create_parent=True,
                )
            )
            self.assertTrue(write_image_file(mask_path, mask, create_parent=True))
            np.testing.assert_array_equal(
                read_image_file(image_path, cv2.IMREAD_UNCHANGED),
                image,
            )
            np.testing.assert_array_equal(
                read_image_file(mask_path, cv2.IMREAD_GRAYSCALE),
                mask,
            )

    def test_video_capture_reads_cjk_path(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-video-test-") as root:
            root_path = Path(root)
            ascii_video = root_path / "source.avi"
            writer = cv2.VideoWriter(
                str(ascii_video),
                cv2.VideoWriter_fourcc(*"MJPG"),
                5.0,
                (24, 16),
            )
            if not writer.isOpened():
                self.skipTest("OpenCV MJPG video writer is unavailable")
            try:
                for value in (32, 96, 160):
                    frame = np.full((16, 24, 3), value, dtype=np.uint8)
                    writer.write(frame)
            finally:
                writer.release()

            unicode_video = root_path / "中文视频" / "测试 视频.avi"
            unicode_video.parent.mkdir(parents=True)
            shutil.move(ascii_video, unicode_video)

            with open_video_capture(unicode_video) as capture:
                ok, frame = capture.read()
                self.assertTrue(ok)
                self.assertEqual(frame.shape[:2], (16, 24))

    def test_video_capture_fallback_uses_ascii_temporary_path(self):
        class FakeCapture:
            def __init__(self, opened):
                self.opened = opened
                self.released = False

            def isOpened(self):
                return self.opened

            def release(self):
                self.released = True

        with tempfile.TemporaryDirectory(prefix="moonshine-video-fallback-") as root:
            unicode_video = Path(root) / "中文视频" / "测试.mp4"
            unicode_video.parent.mkdir(parents=True)
            unicode_video.write_bytes(b"video-placeholder")
            opened_paths = []
            captures = []

            def capture_factory(path):
                opened_paths.append(Path(path))
                capture = FakeCapture(opened=len(opened_paths) > 1)
                captures.append(capture)
                return capture

            with mock.patch.object(cv2, "VideoCapture", side_effect=capture_factory):
                with open_video_capture(unicode_video) as capture:
                    self.assertIs(capture, captures[1])
                    staged_path = opened_paths[1]
                    self.assertTrue(staged_path.is_file())
                    str(staged_path).encode("ascii")

            self.assertTrue(all(capture.released for capture in captures))
            self.assertFalse(staged_path.parent.exists())

    def test_stage_ascii_path_cleans_up_after_use(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-stage-test-") as root:
            source = Path(root) / "中文视频.mp4"
            source.write_bytes(b"video-placeholder")

            with stage_ascii_path(source) as staged_path:
                self.assertNotEqual(staged_path, source)
                self.assertTrue(staged_path.is_file())
                staged_path_string = str(staged_path)
                staged_path_string.encode("ascii")

            self.assertFalse(Path(staged_path_string).exists())

    def test_stage_ascii_path_sanitizes_non_ascii_suffix(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-stage-suffix-") as root:
            source = Path(root) / "中文视频.自定义"
            source.write_bytes(b"video-placeholder")

            with stage_ascii_path(source) as staged_path:
                self.assertEqual(staged_path.suffix, ".bin")
                str(staged_path).encode("ascii")


class UnicodeModelPathTests(unittest.TestCase):
    def test_checkpoint_loads_from_cjk_path(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-test-") as root:
            root_path = Path(root)
            ascii_checkpoint = root_path / "checkpoint.pt"
            unicode_checkpoint = root_path / "中文模型" / "权重 文件.pt"
            unicode_checkpoint.parent.mkdir(parents=True)
            expected = {"weight": torch.arange(6, dtype=torch.float32).reshape(2, 3)}
            torch.save(expected, ascii_checkpoint)
            shutil.move(ascii_checkpoint, unicode_checkpoint)

            actual = load_torch_checkpoint(
                unicode_checkpoint,
                map_location="cpu",
                weights_only=True,
            )
            self.assertTrue(torch.equal(actual["weight"], expected["weight"]))

    def test_torchscript_loads_from_cjk_path(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-jit-test-") as root:
            root_path = Path(root)
            ascii_model = root_path / "model.pt"
            unicode_model = root_path / "中文模型" / "脚本 模型.pt"
            unicode_model.parent.mkdir(parents=True)

            model = torch.nn.Linear(3, 2).eval()
            example = torch.ones(1, 3)
            traced = torch.jit.trace(model, example)
            torch.jit.save(traced, ascii_model)
            shutil.move(ascii_model, unicode_model)

            loaded = load_torchscript(unicode_model, map_location="cpu")
            torch.testing.assert_close(loaded(example), traced(example))

    def test_to_path_rejects_encoded_byte_paths(self):
        with self.assertRaises(TypeError):
            to_path(b"encoded-path")


if __name__ == "__main__":
    unittest.main()
