from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from moonshine_server.application_facade import ApplicationFacade
from moonshine_server.jobs import SqliteJobStore, safe_error
from moonshine_server.jobs.observability import build_job_observability_summary


class JobObservabilitySummaryTests(unittest.TestCase):
    def test_facade_projects_request_job_artifact_cleanup_summary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="moonshine-observability-") as root:
            store = SqliteJobStore(Path(root) / "jobs.sqlite3")
            facade = ApplicationFacade(store)
            job, created = store.create_job(
                kind="image_batch_inpaint",
                client_scope="desktop",
                idempotency_key="observability-key-001",
                request_fingerprint="a" * 64,
                request_summary={"item_count": 1},
            )
            self.assertTrue(created)
            store.transition(job.job_id, "running")
            store.add_artifact(
                job.job_id,
                {
                    "artifact_id": "art_summary0001",
                    "relative_path": "results/summary.png",
                    "mime_type": "image/png",
                    "size_bytes": 12,
                    "sha256": "b" * 64,
                },
            )
            store.record_cleanup(
                job.job_id,
                "art_summary0001",
                "staging_orphan",
                {"action": "manual_recovery_required", "path": "C:/private"},
            )
            store.transition(
                job.job_id,
                "failed",
                error=safe_error(
                    "internal_error",
                    stage="model",
                    retryable=False,
                    message_key="job.processing_failed",
                ),
            )

            summary = facade.get_observability_summary(job.job_id)

            self.assertEqual(summary["schema_version"], "job-observability/v1")
            self.assertEqual(summary["status"], "failed")
            self.assertTrue(summary["terminal"])
            self.assertEqual(summary["artifact_count"], 1)
            self.assertEqual(summary["artifact_bytes"], 12)
            self.assertEqual(summary["cleanup_counts"], {"staging_orphan": 1})
            self.assertTrue(summary["cleanup_pending"])
            self.assertEqual(summary["error_code"], "internal_error")
            self.assertNotIn("private", str(summary))
            self.assertNotIn("summary.png", str(summary))

    def test_projection_discards_unknown_status_events_and_sizes(self) -> None:
        summary = build_job_observability_summary(
            {
                "job_id": "job_observability01",
                "status": "surprise",
                "error": {"code": {"secret": "no"}},
            },
            [{"event_type": "accepted"}, {"event_type": "secret_event"}],
            [{"size_bytes": True}, {"size_bytes": -4}, {"size_bytes": 5}],
            [{"state": "secret_state"}, {"state": "reconciled"}],
        )

        self.assertEqual(summary["status"], "unknown")
        self.assertEqual(summary["event_count"], 1)
        self.assertEqual(summary["artifact_bytes"], 5)
        self.assertEqual(summary["cleanup_counts"], {"reconciled": 1})
        self.assertIsNone(summary["error_code"])


if __name__ == "__main__":
    unittest.main()
