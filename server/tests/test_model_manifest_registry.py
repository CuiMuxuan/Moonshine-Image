from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.moonshine.model_registry import (
    ModelDownloadTaskManager,
    build_model_status,
    get_model_manifest_metadata,
)


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

            self.assertEqual([model["id"] for model in models], ["remote_lama"])
            self.assertTrue(models[0]["downloadable"])
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

