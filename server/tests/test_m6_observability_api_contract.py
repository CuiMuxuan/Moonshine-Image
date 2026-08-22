from __future__ import annotations

import ast
import unittest
from pathlib import Path


API_PATH = Path(__file__).resolve().parents[1] / "moonshine_server" / "api.py"


class M6ObservabilityApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = API_PATH.read_text(encoding="utf-8")
        tree = ast.parse(cls.source, filename=str(API_PATH))
        api_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Api")
        cls.methods = {
            node.name: ast.get_source_segment(cls.source, node) or ""
            for node in api_class.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

    def test_read_only_route_delegates_to_safe_summary(self):
        source = self.methods["api_job_observability"]
        self.assertIn("get_observability_summary(job_id)", source)
        self.assertIn('"observability"', source)
        self.assertNotIn("record_cleanup", source)
        self.assertNotIn("unlink", source)

    def test_route_preserves_not_found_boundary(self):
        init_source = self.methods["__init__"]
        source = self.methods["api_job_observability"]
        self.assertIn('/api/v1/jobs/{job_id}/observability', init_source)
        self.assertIn("except JobNotFoundError", source)
        self.assertIn("status_code=404", source)


if __name__ == "__main__":
    unittest.main()
