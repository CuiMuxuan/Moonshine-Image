from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import torch
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.moonshine.model_registry import (
    ModelDownloadTaskManager,
    _device_compatible,
    build_model_status,
    get_model_manifest_metadata,
)
from moonshine_server.moonshine.sam_service import SamService, SamServiceError
from moonshine_server.api import Api
from moonshine_server.model_manager import ModelManager


def model_record(**overrides):
    record = {
        "id": "remote_lama",
        "label": "Remote LaMa",
        "type": "image",
        "family": "lama",
        "downloadable": True,
        "sourceLinks": [
            {
                "type": "huggingface",
                "url": "https://huggingface.co/example/model.bin",
            }
        ],
        "manualSources": [
            {
                "type": "quark",
                "url": "https://pan.quark.cn/s/example",
            }
        ],
        "files": [
            {
                "path": "remote/model.bin",
                "size": 5,
                "sha256": "a" * 64,
            }
        ],
        "license": {
            "name": "Apache-2.0",
            "url": "https://example.invalid/license",
        },
    }
    record.update(overrides)
    return record


def signed_document(models, channel="stable", sequence=3):
    return {
        "payload": {
            "schemaVersion": 1,
            "channel": channel,
            "sequence": sequence,
            "appVersion": "1.3.0",
            "platform": "win32",
            "arch": "x64",
            "publishedAt": "2026-08-07T00:00:00.000Z",
            "expiresAt": "2026-09-07T00:00:00.000Z",
            "models": models,
        },
        "signature": {
            "algorithm": "Ed25519",
            "keyId": "moonshine-app-manifest-v1",
            "value": "verified-by-electron",
        },
    }


class SignedModelManifestTests(unittest.TestCase):
    def test_model_manager_initializes_mat_on_cpu_without_cuda(self):
        manager = ModelManager.__new__(ModelManager)
        fake_generator = mock.Mock()
        fake_generator.z_dim = 512
        fake_generator.to.return_value = fake_generator
        loaded_network = mock.Mock()
        loaded_network.c_dim = 0

        with mock.patch(
            "moonshine_server.model.mat.Generator", return_value=fake_generator
        ), mock.patch(
            "moonshine_server.model.mat.set_seed"
        ), mock.patch(
            "moonshine_server.model.mat._resolve_mat_model_path", return_value="mat.pth"
        ), mock.patch(
            "moonshine_server.helper.load_model", return_value=loaded_network
        ) as load_model:
            model = manager._init_mat_cpu("cpu")

        self.assertEqual(model.device.type, "cpu")
        self.assertEqual(model.torch_dtype, torch.float32)
        self.assertEqual(model.z.device.type, "cpu")
        self.assertEqual(model.label.device.type, "cpu")
        load_model.assert_called_once_with(fake_generator, "mat.pth", model.device, None)

    def test_prepare_endpoint_loads_an_ordinary_model_on_cpu(self):
        api = Api.__new__(Api)
        api.config = SimpleNamespace(device="cpu")
        api.model_manager = SimpleNamespace(name="lama", model=None)
        api.model_manager.switch = mock.Mock(
            side_effect=lambda model_id: setattr(api.model_manager, "model", object())
        )
        api._sync_model_dir = mock.Mock()
        api._model_dir = mock.Mock(return_value=Path.cwd())
        cpu_info = {"cuda_available": False, "cuda_compatible": False}
        api._get_cuda_info = mock.Mock(return_value=cpu_info)
        model = {
            "id": "lama",
            "type": "image",
            "installed": True,
            "verified": True,
            "deviceCompatible": True,
        }

        with mock.patch("moonshine_server.api.build_model_status", return_value=[model]):
            response = api.api_prepare_moonshine_model("lama", None)

        payload = json.loads(response.body)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["loaded"])
        self.assertTrue(payload["runtimeReady"])
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["readiness"]["status"], "ready")

    def test_cpu_accepts_ordinary_models_but_keeps_sam2_sam3_restricted(self):
        cpu = {"cuda_available": False, "cuda_compatible": False}
        for model in (
            {"id": "lama", "recommendedDevice": "cuda", "minimumVram": 2048},
            {"id": "mat", "family": "mat", "recommendedDevice": "cuda", "minimumVram": 6144},
            {"id": "slbr", "recommendedDevice": "cuda", "minimumVram": 2048},
            {"id": "sam_vit_b", "family": "sam", "recommendedDevice": "cuda"},
        ):
            with self.subTest(model=model["id"]):
                self.assertTrue(_device_compatible(model, cpu))

        for family in ("sam2", "sam3"):
            with self.subTest(family=family):
                self.assertFalse(_device_compatible({"id": family, "family": family}, cpu))

    def test_file_verification_is_separate_from_runtime_load_state(self):
        manifest = [{
            "id": "lama",
            "label": "LaMa",
            "type": "image",
            "family": "lama",
            "files": [{"path": "big-lama.pt"}],
        }]
        file_status = {
            "path": "big-lama.pt",
            "exists": True,
            "valid": True,
        }
        with tempfile.TemporaryDirectory(prefix="moonshine-model-state-") as root, mock.patch(
            "moonshine_server.moonshine.model_registry._active_model_manifest",
            return_value=(manifest, {}),
        ), mock.patch(
            "moonshine_server.moonshine.model_registry._file_status",
            return_value=file_status,
        ):
            model = build_model_status(Path(root))[0]

        self.assertTrue(model["installed"])
        self.assertTrue(model["verified"])
        self.assertEqual(model["fileStatus"], "verified")
        self.assertFalse(model["loaded"])
        self.assertEqual(model["loadState"], "not_loaded")
        self.assertFalse(model["runtimeReady"])
        self.assertFalse(model["ready"])

    def test_sam1_prepares_on_cpu_while_sam2_and_sam3_remain_cuda_only(self):
        service = SamService(Path.cwd(), "cpu")
        installed = lambda family: {
            "id": f"{family}_model",
            "family": family,
            "installed": True,
            "missingFiles": [],
            "enabledCapabilities": {"imagePoint": True},
        }

        with mock.patch.object(service, "_build_status", return_value=[installed("sam")]), mock.patch.object(
            service, "_get_predictor", return_value=object()
        ) as predictor:
            result = service.prepare_model("sam_model")
        predictor.assert_called_once_with("sam_model")
        self.assertTrue(result["runtimeReady"])

        for family in ("sam2", "sam3"):
            with self.subTest(family=family), mock.patch.object(
                service, "_build_status", return_value=[installed(family)]
            ):
                with self.assertRaisesRegex(SamServiceError, "CUDA-only"):
                    service.prepare_model(f"{family}_model")

    def test_verified_manifest_replaces_the_bundled_catalog(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-manifest-") as root:
            root_path = Path(root)
            manifest_path = root_path / "verified-model-manifest.json"
            manifest_path.write_text(
                json.dumps(signed_document([model_record()])),
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "1",
                    "MOONSHINE_MODEL_MANIFEST_PATH": str(manifest_path),
                    "MOONSHINE_MODEL_MANIFEST_CHANNEL": "stable",
                },
                clear=False,
            ):
                models = build_model_status(root_path / "models")
                metadata = get_model_manifest_metadata()

            self.assertEqual([model["id"] for model in models], ["remote_lama", "ocr_rapid_onnx_mobile"])
            self.assertTrue(models[0]["downloadable"])
            self.assertFalse(models[1]["downloadable"])
            self.assertEqual(models[1]["sourceLinks"], [])
            self.assertEqual(metadata["source"], "signed")
            self.assertEqual(metadata["sequence"], 3)

    def test_required_mode_starts_with_downloads_disabled_when_manifest_is_missing(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-fallback-") as root:
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "1",
                    "MOONSHINE_MODEL_MANIFEST_PATH": "",
                    "MOONSHINE_MODEL_MANIFEST_CHANNEL": "stable",
                },
                clear=False,
            ):
                models = build_model_status(Path(root) / "models")
                metadata = get_model_manifest_metadata()

            self.assertGreater(len(models), 0)
            self.assertTrue(all(not model["downloadable"] for model in models))
            self.assertTrue(all(not model["sourceLinks"] for model in models))
            self.assertEqual(metadata["source"], "safe-fallback")

    def test_sam3_download_requires_the_versioned_license_acceptance(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-license-") as root:
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "0",
                    "MOONSHINE_MODEL_MANIFEST_PATH": "",
                },
                clear=False,
            ):
                manager = ModelDownloadTaskManager()
                with self.assertRaisesRegex(ValueError, "必须确认并接受"):
                    manager.create_download_task("sam3", Path(root), license_acceptance=None)
                with self.assertRaisesRegex(ValueError, "必须确认并接受"):
                    manager.create_download_task(
                        "sam3",
                        Path(root),
                        license_acceptance={
                            "accepted": True,
                            "acceptanceId": "wrong-license-version",
                        },
                    )

    def test_duplicate_active_download_reuses_the_existing_task(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-dedupe-") as root:
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "0",
                    "MOONSHINE_MODEL_MANIFEST_PATH": "",
                },
                clear=False,
            ), mock.patch("threading.Thread.start"):
                manager = ModelDownloadTaskManager()
                first = manager.create_download_task("lama", Path(root))
                second = manager.create_download_task("lama", Path(root))

            self.assertIs(first, second)
            self.assertEqual(first.id, second.id)

    def test_same_model_in_different_directories_uses_distinct_tasks(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-dirs-") as root:
            root_path = Path(root)
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "0",
                    "MOONSHINE_MODEL_MANIFEST_PATH": "",
                },
                clear=False,
            ), mock.patch("threading.Thread.start"):
                manager = ModelDownloadTaskManager()
                first = manager.create_download_task("lama", root_path / "first")
                second = manager.create_download_task("lama", root_path / "second")

            self.assertNotEqual(first.id, second.id)

    def test_invalid_remote_source_fails_closed_in_required_mode(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-model-invalid-") as root:
            root_path = Path(root)
            manifest_path = root_path / "verified-model-manifest.json"
            manifest_path.write_text(
                json.dumps(signed_document([
                    model_record(sourceLinks=[{"url": "http://example.invalid/model.bin"}])
                ])),
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ,
                {
                    "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST": "1",
                    "MOONSHINE_MODEL_MANIFEST_PATH": str(manifest_path),
                    "MOONSHINE_MODEL_MANIFEST_CHANNEL": "stable",
                },
                clear=False,
            ):
                models = build_model_status(root_path / "models")
                metadata = get_model_manifest_metadata()

            self.assertEqual(metadata["source"], "safe-fallback")
            self.assertIn("HTTPS URL", metadata["error"])
            self.assertTrue(all(not model["downloadable"] for model in models))


if __name__ == "__main__":
    unittest.main()
