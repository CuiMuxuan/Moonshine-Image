from __future__ import annotations

import ast
import unittest
from pathlib import Path


API_PATH = Path(__file__).resolve().parents[1] / "moonshine_server" / "api.py"


class ApplicationFacadeApiWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = API_PATH.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source, filename=str(API_PATH))
        api_class = next(
            node
            for node in cls.tree.body
            if isinstance(node, ast.ClassDef) and node.name == "Api"
        )
        cls.methods = {
            node.name: ast.get_source_segment(cls.source, node) or ""
            for node in api_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        helper_names = {"_normalize_query_int", "_normalize_client_scope"}
        helper_nodes = [
            node
            for node in cls.tree.body
            if isinstance(node, ast.FunctionDef) and node.name in helper_names
        ]
        namespace = {"Any": object}
        exec(
            compile(
                ast.fix_missing_locations(ast.Module(body=helper_nodes, type_ignores=[])),
                str(API_PATH),
                "exec",
            ),
            namespace,
        )
        cls.helpers = namespace

    def test_v1_batch_route_calls_application_facade(self):
        source = self.methods["api_batch_inpaint"]
        self.assertIn("self.application_facade.submit_batch_inpaint", source)
        self.assertIn("self._process_batch_inpaint", source)
        self.assertIn("X-Moonshine-Job-Id", source)
        self.assertIn("Idempotency-Key", source)

    def test_batch_worker_observes_cancellation_and_publishes_through_context(self):
        source = self.methods["_process_batch_inpaint"]
        self.assertIn("execution_context.raise_if_cancelled()", source)
        self.assertIn("execution_context=execution_context", source)

    def test_job_query_and_cancel_routes_are_registered(self):
        source = self.methods["__init__"]
        self.assertIn('/api/v1/jobs/{job_id}', source)
        self.assertIn('/api/v1/jobs/{job_id}/events', source)
        self.assertIn('/api/v1/jobs/{job_id}/artifacts', source)
        self.assertIn('/api/v1/jobs/{job_id}/cleanup', source)
        self.assertIn('/api/v1/jobs/{job_id}/observability', source)
        self.assertIn('/api/v1/jobs/{job_id}/cancel', source)

        artifact_source = self.methods["api_job_artifacts"]
        self.assertIn("self.application_facade.get_artifacts(job_id)", artifact_source)

        cleanup_source = self.methods["api_job_cleanup"]
        self.assertIn("self.application_facade.get_cleanup_ledger(job_id)", cleanup_source)

        observability_source = self.methods["api_job_observability"]
        self.assertIn("self.application_facade.get_observability_summary(job_id)", observability_source)
        self.assertIn('"observability"', observability_source)
        self.assertIn("status_code=404", observability_source)

    def test_direct_call_defaults_are_normalized_without_fastapi_param_objects(self):
        normalize_query = self.helpers["_normalize_query_int"]
        normalize_scope = self.helpers["_normalize_client_scope"]

        self.assertEqual(normalize_query(object(), 100, 1, 500), 100)
        self.assertEqual(normalize_query(900, 100, 1, 500), 500)
        self.assertEqual(normalize_scope(object()), "legacy-v1")
        self.assertEqual(normalize_scope(" desktop "), "desktop")


if __name__ == "__main__":
    unittest.main()
