from __future__ import annotations

import ast
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.application_facade import ApplicationFacade
from moonshine_server.jobs.store import SqliteJobStore


ROOT = Path(__file__).resolve().parents[1]
API_PATH = ROOT / "moonshine_server" / "api.py"
FACADE_PATH = ROOT / "moonshine_server" / "application_facade.py"


class M3RuntimeSourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api_source = API_PATH.read_text(encoding="utf-8")
        cls.api_tree = ast.parse(cls.api_source, filename=str(API_PATH))
        api_class = next(node for node in cls.api_tree.body if isinstance(node, ast.ClassDef) and node.name == "Api")
        cls.api_methods = {
            node.name: ast.get_source_segment(cls.api_source, node) or ""
            for node in api_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        cls.facade_source = FACADE_PATH.read_text(encoding="utf-8")

    def test_submit_route_is_registered_and_queued(self):
        init_source = self.api_methods["__init__"]
        submit_source = self.api_methods["api_mcp_image_submit"]
        self.assertIn('/api/v1/jobs/image-batch-inpaint', init_source)
        self.assertIn('status_code=202', submit_source)
        self.assertIn('X-Moonshine-Job-Id', submit_source)
        self.assertIn('self.application_facade.enqueue_batch_inpaint', submit_source)
        self.assertIn('"request_id": request_id', submit_source)
        self.assertIn('"options": {"operation": "image_batch_inpaint"}', submit_source)
        fingerprint_start = submit_source.index("request_fingerprint_payload = {")
        fingerprint_end = submit_source.index("\n            initial_request", fingerprint_start)
        fingerprint_source = submit_source[fingerprint_start:fingerprint_end]
        self.assertNotIn("request_id", fingerprint_source)
        self.assertNotIn("confirmation", fingerprint_source)

    def test_workspace_and_artifact_boundaries_are_explicit(self):
        self.assertIn('MOONSHINE_WORKSPACE_ROOTS_JSON', self.api_source)
        self.assertIn('self._resolve_mcp_workspace_file', self.api_methods["api_mcp_image_submit"])
        self.assertIn('self._mcp_artifact_root', self.api_methods["_build_mcp_batch_request"])
        self.assertIn('relative_path', self.api_methods["_mcp_request_summary"])

    def test_unwired_model_selection_fails_closed(self):
        submit_source = self.api_methods["api_mcp_image_submit"]
        self.assertIn('any(item.model_id is not None for item in req.items)', submit_source)
        self.assertIn('"UNSUPPORTED_TOOL_OR_MODEL"', submit_source)

    def test_facade_exposes_durable_async_worker_boundary(self):
        self.assertIn('def enqueue_batch_inpaint(', self.facade_source)
        self.assertIn('threading.Thread(', self.facade_source)
        self.assertIn('self._create_batch_job(', self.facade_source)
        self.assertIn('daemon=True', self.facade_source)


class M3AsyncFacadeTests(unittest.TestCase):
    def test_enqueue_persists_before_worker_and_completes_safely(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-m3-app005-") as root:
            store = SqliteJobStore(Path(root) / "jobs.sqlite3")
            facade = ApplicationFacade(store)
            finished = threading.Event()

            def processor(context):
                context.publish_bytes(
                    root=Path(root) / "artifacts",
                    relative_path="result.png",
                    payload=b"png",
                    mime_type="image/png",
                )
                finished.set()
                return {"processed_count": 1, "success_count": 1}

            record, created = facade.enqueue_batch_inpaint(
                {"workspace_id": "ws_test12345678", "items": [{"id": "itm_test12345678"}]},
                processor,
                client_scope="mcp-client",
                idempotency_key="idem-m3-app005",
                policy_snapshot_id="pol_test12345678",
            )
            self.assertTrue(created)
            self.assertIn(store.get_job(record.job_id).status, {"queued", "running", "succeeded"})
            self.assertTrue(finished.wait(timeout=5))
            for _ in range(50):
                if store.get_job(record.job_id).status == "succeeded":
                    break
                time.sleep(0.01)
            self.assertEqual(store.get_job(record.job_id).status, "succeeded")
            artifacts = facade.get_artifacts(record.job_id)
            self.assertEqual(len(artifacts), 1)
            self.assertEqual(artifacts[0]["asset"]["locator"]["scheme"], "artifact")
            self.assertNotIn("relative_path", artifacts[0]["asset"]["locator"])


if __name__ == "__main__":
    unittest.main()
