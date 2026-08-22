from __future__ import annotations

import ast
import base64
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.ocr_adapter import RapidOcrAdapter, OcrAdapterRuntimeError
from moonshine_server.ocr_api import (
    OcrApi,
    OcrApiInputError,
    OcrApiResultError,
    OcrApiRuntimeError,
    OcrApiUnavailableError,
    OcrRecognizeRequest,
)


MANIFEST_TEMPLATE = {
    "schema_version": "ocr-component/v1",
    "engine_id": "ocr_rapid_onnx_mobile",
    "engine_version": "test-runtime",
    "model_revision": "test-model",
    "license_id": "test-license",
    "languages": ["eng", "chi"],
    "runtime_flavor": "cpu",
    "supports_gpu": False,
    "supports_orientation": True,
    "memory_limit_mb": 256,
    "source_kind": "signed_manifest",
    "default": True,
}


class FakeRuntime:
    def recognize(self, image, *, regions=None, options=None):
        assert isinstance(image, bytes)
        return (
            [
                {
                    "polygon": [[1, 2], [11, 2], [11, 12], [1, 12]],
                    "text": " Hello ",
                    "confidence": 0.91,
                    "language": "eng",
                    "engine_version": "test-runtime",
                }
            ],
            0.001,
        )


class FailingRuntime:
    def recognize(self, image, *, regions=None, options=None):
        raise RuntimeError("private runtime detail must not escape")


class OfficialRapidOcrRuntime:
    def __init__(self):
        self.use_cls = None

    def __call__(self, image, *, use_cls=None):
        self.use_cls = use_cls
        return [[[1, 1], [11, 1], [11, 11], [1, 11]], "official", 0.93]


class EmptyOfficialRapidOcrRuntime:
    class Output:
        boxes = None
        txts = None
        scores = None
        word_results = (("", 1.0, None),)

    def __call__(self, image, *, use_cls=None):
        return self.Output()


def build_adapter(root: Path, runtime) -> RapidOcrAdapter:
    payload = b"verified-model"
    artifact = root / "model.bin"
    artifact.write_bytes(payload)
    manifest = dict(MANIFEST_TEMPLATE)
    manifest.update({"model_sha256": hashlib.sha256(payload).hexdigest(), "size_bytes": len(payload)})
    return RapidOcrAdapter(manifest, artifact, runtime=runtime)


class M5OcrApiContractTests(unittest.TestCase):
    def test_official_rapidocr_branch_uses_bound_instance_state(self):
        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            runtime = OfficialRapidOcrRuntime()
            adapter = build_adapter(Path(root), runtime)
            adapter._runtime_kind = "rapidocr"
            result = adapter.recognize(b"image")
            self.assertTrue(runtime.use_cls)
            self.assertEqual(result[0]["text"], "official")

    def test_official_rapidocr_empty_output_is_zero_regions(self):
        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            runtime = EmptyOfficialRapidOcrRuntime()
            adapter = build_adapter(Path(root), runtime)
            adapter._runtime_kind = "rapidocr"
            self.assertEqual(adapter.recognize(b"image"), [])

    def test_capabilities_are_safe_and_ready_with_injected_fake(self):
        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            api = OcrApi(lambda: build_adapter(Path(root), FakeRuntime()))
            capabilities = api.capabilities()
            self.assertEqual(capabilities["schema_version"], "ocr-capabilities/v1")
            self.assertEqual(capabilities["engine_id"], "ocr_rapid_onnx_mobile")
            self.assertEqual(capabilities["status"], "ready")
            self.assertTrue(capabilities["enabled"])
            self.assertNotIn("path", repr(capabilities).lower())
            self.assertNotIn("model.bin", repr(capabilities))

    def test_recognize_decodes_bounded_base64_and_normalizes_text_region(self):
        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            api = OcrApi(lambda: build_adapter(Path(root), FakeRuntime()))
            encoded = base64.b64encode(b"image-bytes").decode("ascii")
            result = api.recognize(encoded, regions=[], options={"orientation": True})
            self.assertEqual(result["schema_version"], "ocr-recognize/v1")
            self.assertEqual(result["engine_id"], "ocr_rapid_onnx_mobile")
            region = result["regions"][0]
            self.assertEqual(region["schema_version"], "text-region/v2")
            self.assertTrue(region["region_id"].startswith("txt_"))
            self.assertEqual(region["text"], "Hello")
            self.assertEqual(region["bbox"], {"x": 1.0, "y": 2.0, "width": 10.0, "height": 10.0})
            self.assertEqual(region["detection_confidence"], 0.91)
            self.assertEqual(region["engine_revision"], "test-runtime")

    def test_default_and_invalid_inputs_fail_closed_without_details(self):
        api = OcrApi()
        self.assertEqual(api.capabilities()["status"], "missing")
        with self.assertRaises(OcrApiUnavailableError):
            api.recognize(b"image")
        with self.assertRaises(OcrApiInputError):
            api.recognize("file:///private/image.png")
        with self.assertRaises(OcrApiInputError):
            api.recognize("not-base64")

    def test_runtime_failure_maps_to_stable_error(self):
        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            api = OcrApi(lambda: build_adapter(Path(root), FailingRuntime()))
            with self.assertRaises(OcrApiRuntimeError) as raised:
                api.recognize(b"image")
            self.assertEqual(raised.exception.code, "OCR_RUNTIME_ERROR")
            self.assertNotIn("private runtime detail", str(raised.exception))

    def test_request_model_requires_one_base64_field(self):
        encoded = base64.b64encode(b"image").decode("ascii")
        self.assertEqual(OcrRecognizeRequest(image=encoded).encoded_image, encoded)
        self.assertEqual(OcrRecognizeRequest(image_bytes=encoded).encoded_image, encoded)
        with self.assertRaises(ValueError):
            OcrRecognizeRequest()
        with self.assertRaises(ValueError):
            OcrRecognizeRequest(image=encoded, image_base64=encoded)
        with self.assertRaises(ValueError):
            OcrRecognizeRequest(image=encoded, regions=[{}] * 129)
        with self.assertRaises(ValueError):
            OcrRecognizeRequest(image=encoded, options={str(index): True for index in range(17)})
        with self.assertRaises(ValueError):
            OcrRecognizeRequest(image=123)

    def test_result_geometry_rejects_degenerate_regions(self):
        class DegenerateRuntime:
            def recognize(self, image, *, regions=None, options=None):
                return [
                    {
                        "polygon": [[1, 1], [1, 1], [2, 2], [2, 2]],
                        "bbox": [1, 1, 1, 2],
                        "text": "bad",
                        "confidence": 0.5,
                    }
                ]

        with tempfile.TemporaryDirectory(prefix="m5-ocr-api-") as root:
            api = OcrApi(lambda: build_adapter(Path(root), DegenerateRuntime()))
            with self.assertRaises(OcrApiResultError) as raised:
                api.recognize(b"image")
            self.assertEqual(raised.exception.code, "OCR_RESULT_INVALID")

    def test_api_registers_bounded_ocr_routes(self):
        source = (SERVER_ROOT / "moonshine_server" / "api.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        api_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Api")
        methods = {
            node.name: ast.get_source_segment(source, node) or ""
            for node in api_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertIn("/api/v1/moonshine/ocr/capabilities", methods["__init__"])
        self.assertIn("/api/v1/moonshine/ocr/recognize", methods["__init__"])
        self.assertIn("OcrRecognizeRequest.model_validate", methods["api_moonshine_ocr_recognize"])
        self.assertIn("OCR_INPUT_INVALID", methods["api_moonshine_ocr_recognize"])
        self.assertIn("self.ocr_api.recognize", methods["api_moonshine_ocr_recognize"])
        self.assertIn("OcrApiError", methods["api_moonshine_ocr_recognize"])


if __name__ == "__main__":
    unittest.main()
