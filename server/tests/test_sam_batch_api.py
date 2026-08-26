from __future__ import annotations

import ast
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import torch

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.moonshine.sam_service import SamService
from moonshine_server.api import Api
from moonshine_server.schema import MoonshineSamPredictBatchRequest


class _FakeTransform:
    def apply_boxes(self, boxes, _original_size):
        return boxes


class _FakeSam1Predictor:
    device = torch.device("cpu")
    original_size = (4, 4)

    def __init__(self, fail_batched=False, fail_single=False):
        self.transform = _FakeTransform()
        self.fail_batched = fail_batched
        self.fail_single = fail_single
        self.set_image_calls = 0
        self.predict_torch_calls = []
        self.predict_calls = []

    def set_image(self, image):
        self.set_image_calls += 1
        self.image = image

    def predict_torch(self, *, boxes, **_kwargs):
        count = int(boxes.shape[0])
        self.predict_torch_calls.append(count)
        if self.fail_batched and count > 1:
            raise RuntimeError("out of memory")
        masks = torch.zeros((count, 1, 4, 4), dtype=torch.bool)
        for index in range(count):
            masks[index, 0, index % 4, index % 4] = True
        scores = torch.arange(count, dtype=torch.float32).reshape(count, 1)
        logits = torch.zeros((count, 1, 2, 2), dtype=torch.float32)
        return masks, scores, logits

    def predict(self, **_kwargs):
        self.predict_calls.append(1)
        if self.fail_single:
            raise RuntimeError("prompt failed")
        return (
            np.ones((1, 4, 4), dtype=np.uint8),
            np.asarray([0.5], dtype=np.float32),
            np.zeros((1, 2, 2), dtype=np.float32),
        )


class _FakeSam2Predictor(_FakeSam1Predictor):
    def __init__(self):
        super().__init__()
        self._transforms = _FakeTransform()

    def _prep_prompts(self, _points, _labels, boxes, _mask, _normalize):
        return None, None, None, torch.as_tensor(boxes, dtype=torch.float32)

    def _predict(self, _points, _labels, boxes, _mask, _multimask, **_kwargs):
        count = int(boxes.shape[0])
        self.predict_torch_calls.append(count)
        masks = torch.ones((count, 1, 4, 4), dtype=torch.bool)
        scores = torch.ones((count, 1), dtype=torch.float32)
        logits = torch.zeros((count, 1, 2, 2), dtype=torch.float32)
        return masks, scores, logits


class _FakeSam3Model:
    def __init__(self):
        self.calls = []

    def predict_inst(self, _state, *, point_coords, point_labels, box, multimask_output):
        self.calls.append({
            "point_coords": point_coords,
            "point_labels": point_labels,
            "box": box,
            "multimask_output": multimask_output,
        })
        count = int(np.asarray(box).shape[0]) if box is not None else 1
        masks = torch.ones((count, 1, 4, 4), dtype=torch.bool)
        scores = torch.ones((count, 1), dtype=torch.float32)
        logits = torch.zeros((count, 1, 2, 2), dtype=torch.float32)
        return masks, scores, logits


class _FakeSam3Processor:
    def set_image(self, _image):
        return {"original_height": 4, "original_width": 4, "backbone_out": {}}


def _status(family="sam"):
    return {
        "id": "test_model",
        "family": family,
        "type": "mask",
        "installed": True,
        "missingFiles": [],
        "enabledCapabilities": {"imagePoint": True, "imageBox": True},
    }


class SamBatchApiTests(unittest.TestCase):
    def setUp(self):
        self.service = SamService(Path.cwd(), "cpu")
        self.image = np.zeros((4, 4, 3), dtype=np.uint8)

    def _patch_image(self):
        return mock.patch.object(
            self.service,
            "_load_image",
            return_value=(self.image, "image-hash"),
        )

    def test_schema_accepts_box_point_and_mixed_items_and_rejects_empty(self):
        request = MoonshineSamPredictBatchRequest(
            image="encoded",
            prompts=[
                {"id": "box", "box": {"x": 0, "y": 0, "width": 2, "height": 2}},
                {"id": "point", "points": [{"x": 1, "y": 1}]},
                {
                    "id": "mixed",
                    "points": [{"x": 1, "y": 1, "label": 1}],
                    "box": {"x": 0, "y": 0, "width": 2, "height": 2},
                },
            ],
            multimask_output=False,
        )
        self.assertEqual([item.id for item in request.prompts], ["box", "point", "mixed"])
        with self.assertRaises(ValueError):
            MoonshineSamPredictBatchRequest(image="encoded", prompts=[{"id": "empty"}])
        with self.assertRaises(ValueError):
            MoonshineSamPredictBatchRequest(
                image="encoded",
                prompts=[
                    {"id": "same", "points": [{"x": 1, "y": 1}]},
                    {"id": "same", "box": {"x": 0, "y": 0, "width": 1, "height": 1}},
                ],
            )

    def test_sam1_box_items_share_image_and_use_low_level_batch(self):
        predictor = _FakeSam1Predictor()
        self.service._build_status = mock.Mock(return_value=[_status("sam")])
        self.service._get_predictor = mock.Mock(return_value=predictor)
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {"id": "first", "box": {"x": 0, "y": 0, "width": 2, "height": 2}},
                    {"id": "second", "box": {"x": 1, "y": 1, "width": 2, "height": 2}},
                ],
                multimask_output=False,
            )
        self.assertEqual(predictor.set_image_calls, 1)
        self.assertEqual(predictor.predict_torch_calls, [2])
        self.assertEqual([item["id"] for item in result["results"]], ["first", "second"])
        self.assertTrue(all(item["status"] == "succeeded" for item in result["results"]))
        self.assertEqual(result["performance"]["batchedPromptCount"], 2)

    def test_mixed_and_point_items_reuse_image_and_preserve_individual_results(self):
        predictor = _FakeSam1Predictor()
        self.service._build_status = mock.Mock(return_value=[_status("sam")])
        self.service._get_predictor = mock.Mock(return_value=predictor)
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {"id": "point", "points": [{"x": 1, "y": 1}]},
                    {
                        "id": "mixed",
                        "points": [{"x": 1, "y": 1}],
                        "box": {"x": 0, "y": 0, "width": 2, "height": 2},
                    },
                ],
                multimask_output=False,
            )
        self.assertEqual([item["promptType"] for item in result["results"]], ["point", "mixed"])
        self.assertTrue(all(item["status"] == "succeeded" for item in result["results"]))
        self.assertEqual(len(predictor.predict_calls), 2)
        self.assertEqual(predictor.set_image_calls, 1)

    def test_oom_reduces_micro_batch_and_keeps_successful_items(self):
        predictor = _FakeSam1Predictor(fail_batched=True)
        self.service._build_status = mock.Mock(return_value=[_status("sam")])
        self.service._get_predictor = mock.Mock(return_value=predictor)
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {"id": "one", "box": {"x": 0, "y": 0, "width": 2, "height": 2}},
                    {"id": "two", "box": {"x": 1, "y": 1, "width": 2, "height": 2}},
                    {"id": "three", "box": {"x": 0, "y": 1, "width": 2, "height": 2}},
                ],
                multimask_output=False,
            )
        self.assertGreaterEqual(result["performance"]["retryCount"], 1)
        self.assertEqual(result["failedCount"], 0)
        self.assertTrue(all(item["status"] == "succeeded" for item in result["results"]))
        self.assertEqual(predictor.predict_torch_calls[0], 3)
        self.assertTrue(all(size == 1 for size in predictor.predict_torch_calls[1:]))

    def test_item_failure_is_returned_with_a_stable_error_code(self):
        predictor = _FakeSam1Predictor(fail_single=True)
        self.service._build_status = mock.Mock(return_value=[_status("sam")])
        self.service._get_predictor = mock.Mock(return_value=predictor)
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[{"id": "point", "points": [{"x": 1, "y": 1}]}],
                multimask_output=False,
            )
        item = result["results"][0]
        self.assertEqual(item["status"], "failed")
        self.assertEqual(item["errorCode"], "SAM_RUNTIME_ERROR")
        self.assertEqual(item["error"]["code"], item["errorCode"])
        self.assertEqual(result["successCount"], 0)
        self.assertEqual(result["failedCount"], 1)

    def test_sam2_uses_batched_private_decoder_path(self):
        predictor = _FakeSam2Predictor()
        self.service._build_status = mock.Mock(return_value=[_status("sam2")])
        self.service._get_predictor = mock.Mock(return_value=predictor)
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {"id": "a", "box": {"x": 0, "y": 0, "width": 2, "height": 2}},
                    {"id": "b", "box": {"x": 1, "y": 1, "width": 2, "height": 2}},
                ],
                multimask_output=False,
            )
        self.assertEqual(predictor.predict_torch_calls, [2])
        self.assertEqual(result["successCount"], 2)

    def test_standard_sam3_uses_the_same_batch_contract(self):
        model = _FakeSam3Model()
        self.service._build_status = mock.Mock(return_value=[_status("sam3")])
        self.service._get_sam3_image_predictor = mock.Mock(
            return_value={"model": model, "processor": _FakeSam3Processor()}
        )
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {"id": "a", "box": {"x": 0, "y": 0, "width": 2, "height": 2}},
                    {"id": "b", "box": {"x": 1, "y": 1, "width": 2, "height": 2}},
                ],
                multimask_output=False,
            )
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(np.asarray(model.calls[0]["box"]).shape, (2, 4))
        self.assertEqual(result["successCount"], 2)

    def test_standard_sam3_mixed_prompt_wraps_box_and_preserves_points(self):
        model = _FakeSam3Model()
        self.service._build_status = mock.Mock(return_value=[_status("sam3")])
        self.service._get_sam3_image_predictor = mock.Mock(
            return_value={"model": model, "processor": _FakeSam3Processor()}
        )
        with self._patch_image():
            result = self.service.predict_batch(
                image="encoded",
                image_type="base64",
                model_id="test_model",
                prompts=[
                    {
                        "id": "mixed",
                        "points": [
                            {"x": 1, "y": 1, "label": 1},
                            {"x": 2, "y": 2, "label": 0},
                        ],
                        "box": {"x": 0, "y": 0, "width": 2, "height": 2},
                    }
                ],
                multimask_output=False,
            )

        self.assertEqual(len(model.calls), 1)
        call = model.calls[0]
        np.testing.assert_array_equal(call["point_coords"], [[1, 1], [2, 2]])
        np.testing.assert_array_equal(call["point_labels"], [1, 0])
        np.testing.assert_array_equal(call["box"], [[0, 0, 2, 2]])
        self.assertEqual(np.asarray(call["box"]).shape, (1, 4))
        self.assertFalse(call["multimask_output"])
        self.assertEqual(result["successCount"], 1)
        self.assertEqual(result["results"][0]["promptType"], "mixed")

    def test_api_registers_separate_batch_route_and_handler(self):
        source = (SERVER_ROOT / "moonshine_server" / "api.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        api_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Api")
        methods = {
            node.name: ast.get_source_segment(source, node) or ""
            for node in api_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertIn("/api/v1/moonshine/sam/predict", methods["__init__"])
        self.assertIn("/api/v1/moonshine/sam/predict-batch", methods["__init__"])
        self.assertIn("predict_batch", methods["api_moonshine_sam_predict_batch"])
        self.assertIn("MoonshineSamPredictBatchRequest", source)

    def test_api_batch_handler_passes_the_validated_request_to_service(self):
        api = Api.__new__(Api)
        service = mock.Mock()
        service.predict_batch.return_value = {
            "schemaVersion": "sam-predict-batch/v1",
            "results": [],
        }
        api._get_sam_service = mock.Mock(return_value=service)
        request = MoonshineSamPredictBatchRequest(
            image="encoded",
            model_id="test_model",
            prompts=[{"id": "box", "box": {"x": 0, "y": 0, "width": 2, "height": 2}}],
            multimask_output=False,
        )
        response = api.api_moonshine_sam_predict_batch(request)
        service.predict_batch.assert_called_once()
        kwargs = service.predict_batch.call_args.kwargs
        self.assertEqual(kwargs["model_id"], "test_model")
        self.assertFalse(kwargs["multimask_output"])
        self.assertEqual(json.loads(response.body)["schemaVersion"], "sam-predict-batch/v1")


if __name__ == "__main__":
    unittest.main()
