from __future__ import annotations

import ast
import unittest
from pathlib import Path


SERVER_ROOT = Path(__file__).resolve().parents[1]
API_PATH = SERVER_ROOT / "moonshine_server" / "api.py"
FACADE_PATH = SERVER_ROOT / "moonshine_server" / "application_facade.py"
OBSERVABILITY_PATH = SERVER_ROOT / "moonshine_server" / "jobs" / "observability.py"

CONSUMER_FLOW = (
    "GET /api/v1/jobs/{job_id}/observability",
    "Api.api_job_observability",
    "ApplicationFacade.get_observability_summary",
    "job-observability/v1",
)


def _class_methods(source: str, class_name: str) -> dict[str, str]:
    tree = ast.parse(source)
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    return {
        node.name: ast.get_source_segment(source, node) or ""
        for node in owner.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


class M6ObservabilityConsumerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api_source = API_PATH.read_text(encoding="utf-8")
        cls.facade_source = FACADE_PATH.read_text(encoding="utf-8")
        cls.observability_source = OBSERVABILITY_PATH.read_text(encoding="utf-8")
        cls.api_methods = _class_methods(cls.api_source, "Api")
        observability_tree = ast.parse(cls.observability_source)
        cls.summary_function = next(
            node
            for node in observability_tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "build_job_observability_summary"
        )
        cls.summary_source = ast.get_source_segment(cls.observability_source, cls.summary_function) or ""

    def test_synthetic_consumer_flow_is_registered_and_facade_bound(self):
        self.assertEqual(CONSUMER_FLOW[0], "GET /api/v1/jobs/{job_id}/observability")
        init_source = self.api_methods["__init__"]
        route_source = self.api_methods["api_job_observability"]
        self.assertIn('/api/v1/jobs/{job_id}/observability', init_source)
        self.assertIn("self.application_facade.get_observability_summary(job_id)", route_source)
        self.assertIn('"observability"', route_source)

    def test_consumer_projection_is_read_only_and_path_free(self):
        route_source = self.api_methods["api_job_observability"]
        self.assertNotRegex(route_source, r"record_cleanup|transition\(|set_result\(|unlink\(")
        for forbidden in ("relative_path", "absolute_path", "raw_payload", "token", "exception_text"):
            self.assertNotIn(forbidden, self.summary_source)

    def test_summary_contract_has_bounded_observability_fields(self):
        for field in (
            "schema_version",
            "job_id",
            "status",
            "terminal",
            "event_count",
            "event_types",
            "artifact_count",
            "artifact_bytes",
            "cleanup_counts",
            "cleanup_pending",
            "error_code",
        ):
            self.assertIn(f'"{field}"', self.summary_source)
        self.assertIn('"job-observability/v1"', self.summary_source)

    def test_consumer_boundary_has_no_renderer_or_ipc_surface(self):
        self.assertNotIn("ipcRenderer", self.api_source)
        self.assertNotIn("invoke(", self.api_source)
        self.assertNotIn("src-electron", str(Path(__file__).resolve()))


if __name__ == "__main__":
    unittest.main()
