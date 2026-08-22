from __future__ import annotations

import sys
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.application_facade import (
    ApplicationFacade,
    JobExecutionContext,
    JobCancellationRequested,
    JobProcessingError,
)
from moonshine_server.jobs import (
    ArtifactConflictError,
    ArtifactPublisher,
    IdempotencyConflictError,
    InvalidJobTransitionError,
    JobStoreError,
    SqliteJobStore,
    safe_error,
)


class FakeBatchRequest:
    def __init__(self, item_id: str = "item-1"):
        self.payload = {
            "data": [{"id": item_id, "image": "image-bytes", "mask": "mask-bytes"}],
            "image_type": "base64",
            "mask_type": "base64",
            "response_type": "base64",
            "output_format": "png",
        }

    def model_dump(self, *, mode: str = "python"):
        return self.payload


class SqliteJobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="moonshine-jobstore-")
        self.root = Path(self.temporary.name)
        self.database = self.root / "jobs.sqlite3"
        self.store = SqliteJobStore(self.database)

    def tearDown(self):
        self.temporary.cleanup()

    def create_job(self, *, fingerprint: str = "a" * 64):
        return self.store.create_job(
            kind="image_batch_inpaint",
            client_scope="desktop",
            idempotency_key="request-key-001",
            request_fingerprint=fingerprint,
            request_summary={"item_count": 1},
        )

    def test_idempotency_reuses_same_request_and_rejects_conflict(self):
        first, created = self.create_job()
        second, second_created = self.create_job()
        self.assertTrue(created)
        self.assertFalse(second_created)
        self.assertEqual(first.job_id, second.job_id)

        with self.assertRaises(IdempotencyConflictError):
            self.create_job(fingerprint="b" * 64)

    def test_terminal_state_cannot_transition_again(self):
        job, _ = self.create_job()
        self.store.transition(job.job_id, "running")
        self.store.transition(job.job_id, "succeeded")
        with self.assertRaises(InvalidJobTransitionError):
            self.store.transition(job.job_id, "failed")

    def test_restart_marks_started_write_failed_without_replay(self):
        job, _ = self.create_job()
        self.store.transition(job.job_id, "running")

        restarted = SqliteJobStore(self.database)
        recovered = restarted.get_job(job.job_id)
        self.assertEqual(recovered.status, "failed")
        self.assertEqual(recovered.error["code"], "internal_error")
        event_types = [item["event_type"] for item in restarted.get_events(job.job_id)]
        self.assertEqual(event_types[-2:], ["recovery_started", "failed"])

    def test_cancel_moves_running_job_through_cancelling(self):
        job, _ = self.create_job()
        self.store.transition(job.job_id, "running")
        facade = ApplicationFacade(self.store)
        cancelled = facade.cancel(job.job_id)
        self.assertEqual(cancelled["status"], "cancelling")

    def test_facade_returns_persisted_artifact_metadata(self):
        job, _ = self.create_job()
        self.store.add_artifact(
            job.job_id,
            {
                "artifact_id": "art_12345678",
                "relative_path": "results/output.png",
                "mime_type": "image/png",
                "size_bytes": 7,
                "sha256": "c" * 64,
            },
        )

        artifacts = ApplicationFacade(self.store).get_artifacts(job.job_id)

        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0]["artifact_id"], "art_12345678")
        self.assertEqual(artifacts[0]["schema_version"], "artifact/v2")
        self.assertEqual(artifacts[0]["asset"]["locator"]["scheme"], "artifact")
        self.assertNotIn("relative_path", artifacts[0]["asset"])

        preview = ApplicationFacade._public_artifact(
            {
                "artifact_id": "art_preview01",
                "job_id": job.job_id,
                "artifact_type": "preview",
                "mime_type": "image/png",
                "sha256": "d" * 64,
                "size_bytes": 3,
                "created_at": "2026-01-01T00:00:00Z",
            }
        )
        diagnostic = ApplicationFacade._public_artifact(
            {
                "artifact_id": "art_diag0001",
                "job_id": job.job_id,
                "artifact_type": "diagnostic",
                "mime_type": "application/json",
                "sha256": "e" * 64,
                "size_bytes": 3,
                "created_at": "2026-01-01T00:00:00Z",
            }
        )
        self.assertEqual(preview["asset"]["kind"], "artifact")
        self.assertEqual(diagnostic["asset"]["kind"], "artifact")

    def test_job_public_contract_contains_safe_refs_without_result_payload(self):
        job, _ = self.create_job()
        public = ApplicationFacade(self.store).get_job(job.job_id)

        self.assertEqual(public["schema_version"], "job/v2")
        self.assertEqual(public["policy_snapshot_id"], "pol_default00")
        self.assertTrue(public["input_assets"])
        self.assertEqual(public["input_assets"][0]["schema_version"], "asset-ref/v2")
        self.assertNotIn("result", public)

    def test_store_does_not_persist_result_bytes_or_exception_text(self):
        facade = ApplicationFacade(self.store)
        raw_item_id = "C:\\Users\\alice\\private\\scan.png"
        request = FakeBatchRequest(item_id=raw_item_id)

        def processor(_context):
            return {
                "results": [{"result": "data:image/png;base64,SECRET", "path": "C:\\private\\result.png"}],
                "processed_count": 1,
                "success_count": 1,
            }

        job, _, _ = facade.submit_batch_inpaint(
            request,
            processor,
            client_scope="desktop",
            idempotency_key="request-key-002",
        )
        connection = sqlite3.connect(self.database)
        try:
            raw = connection.execute(
                "SELECT request_json, result_json, error_json FROM jobs WHERE job_id = ?", (job.job_id,)
            ).fetchone()
        finally:
            connection.close()
        serialized = " ".join(value or "" for value in raw)

        self.assertNotIn("data:image", serialized)
        self.assertNotIn("C:\\private", serialized)
        self.assertNotIn(raw_item_id, serialized)
        self.assertNotIn("alice", serialized)
        self.assertNotIn("scan.png", serialized)
        request_summary = json.loads(raw[0])
        self.assertEqual(len(request_summary["item_ids"]), 1)
        self.assertTrue(request_summary["item_ids"][0].startswith("itm_"))

    def test_store_boundary_sanitizes_direct_summary_result_and_cleanup_writes(self):
        job, _ = self.store.create_job(
            kind="image_batch_inpaint",
            client_scope="desktop",
            idempotency_key="request-key-direct-boundary",
            request_fingerprint="d" * 64,
            request_summary={
                "input_assets": [{"path": "C:\\Users\\alice\\private\\input.png"}],
                "secret": "do-not-persist",
            },
        )
        self.store.set_result(
            job.job_id,
            {
                "results": [{"result": "data:image/png;base64,SECRET", "path": "C:\\private\\result.png"}],
                "processed_count": 1,
                "success_count": 1,
            },
            ["art_12345678", "art_../../secret", "art_abcdefgh"],
        )
        self.store.record_cleanup(
            job.job_id,
            "art_12345678",
            "staging_orphan",
            {"action": "C:\\Users\\alice\\private\\cleanup", "path": "C:\\private\\path"},
        )
        connection = sqlite3.connect(self.database)
        try:
            raw = " ".join(
                value or ""
                for row in connection.execute(
                    "SELECT request_json, result_json FROM jobs WHERE job_id = ?", (job.job_id,)
                )
                for value in row
            )
            cleanup = connection.execute(
                "SELECT detail_json FROM cleanup_ledger WHERE job_id = ?", (job.job_id,)
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertNotIn("alice", raw)
        self.assertNotIn("data:image", raw)
        self.assertNotIn("private", cleanup)
        self.assertEqual(json.loads(cleanup), {})
        artifact_events = [
            event
            for event in self.store.get_events(job.job_id)
            if event["event_type"] == "artifact_published"
        ]
        self.assertEqual(len(artifact_events), 1)
        self.assertEqual(artifact_events[0]["payload"]["artifact_ids"], ["art_12345678", "art_abcdefgh"])

    def test_safe_error_normalizes_unknown_fields_without_private_details(self):
        error = safe_error(
            "not-a-contract-code",
            stage="unknown-stage",
            retryable=1,
            message_key="bad message",
            safe_details={"path": "C:\\private\\secret", "item_index": True},
        )
        self.assertEqual(
            error,
            {
                "schema_version": "error/v2",
                "code": "internal_error",
                "stage": "recover",
                "retryable": False,
                "message_key": "job.internal_error",
            },
        )

    def test_staging_orphan_is_retained_and_exposed_through_cleanup_ledger(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-orphan-") as root:
            root_path = Path(root)
            store = SqliteJobStore(root_path / "jobs.sqlite3")
            job, _ = store.create_job(
                kind="image_batch_inpaint",
                client_scope="desktop",
                idempotency_key="orphan-key-001",
                request_fingerprint="f" * 64,
                request_summary={"input_assets": []},
            )
            store.transition(job.job_id, "running")
            artifact_root = root_path / "artifacts"
            publisher = ArtifactPublisher(artifact_root)

            with patch("moonshine_server.jobs.artifacts.os.link", side_effect=OSError("simulated crash")):
                with self.assertRaises(OSError):
                    publisher.publish_bytes(
                        job.job_id,
                        "art_orphan000000000000000",
                        "results/orphan.png",
                        b"orphan-bytes",
                        mime_type="image/png",
                    )

            intent = artifact_root / ".staging" / job.job_id / "art_orphan000000000000000.intent.json"
            staged = artifact_root / ".staging" / job.job_id / "art_orphan000000000000000.part"
            self.assertTrue(intent.exists())
            self.assertTrue(staged.exists())

            context = JobExecutionContext(job_id=job.job_id, store=store)
            context.publish_bytes(
                root=artifact_root,
                relative_path="results/second.png",
                payload=b"second",
                mime_type="image/png",
            )

            cleanup = ApplicationFacade(store).get_cleanup_ledger(job.job_id)
            orphan = next(item for item in cleanup if item["artifact_id"] == "art_orphan000000000000000")
            self.assertEqual(orphan["state"], "staging_orphan")
            self.assertEqual(orphan["detail"]["action"], "manual_recovery_required")
            self.assertEqual(orphan["detail"]["retention"], "staged_bytes_retained")
            self.assertNotIn("results/orphan.png", json.dumps(orphan))
            self.assertTrue(intent.exists())
            self.assertTrue(staged.exists())

            store.record_cleanup(
                job.job_id,
                "art_untrusted0001",
                "staging_orphan",
                {"action": "C:\\Users\\alice\\private\\cleanup"},
            )
            projected = ApplicationFacade(store).get_cleanup_ledger(job.job_id)
            self.assertNotIn("C:\\Users\\alice", json.dumps(projected))

    def test_processing_error_persists_only_safe_error(self):
        facade = ApplicationFacade(self.store)

        def processor(_context):
            raise ValueError("private path C:\\secret\\input.png")

        with self.assertRaises(JobProcessingError):
            facade.submit_batch_inpaint(
                FakeBatchRequest(),
                processor,
                client_scope="desktop",
                idempotency_key="request-key-003",
            )

        connection = sqlite3.connect(self.database)
        try:
            row = connection.execute(
                "SELECT error_json FROM jobs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        finally:
            connection.close()
        self.assertEqual(json.loads(row[0])["schema_version"], "error/v2")
        self.assertNotIn("private path", row[0])

    def test_cancel_after_processor_returns_marks_job_cancelled(self):
        facade = ApplicationFacade(self.store)
        job_ids = []

        def processor(context):
            job_ids.append(context.job_id)
            facade.cancel(context.job_id)
            return {"results": [], "processed_count": 0, "success_count": 0}

        with self.assertRaises(JobCancellationRequested):
            facade.submit_batch_inpaint(
                FakeBatchRequest(),
                processor,
                client_scope="desktop",
                idempotency_key="request-key-004",
            )

        self.assertEqual(self.store.get_job(job_ids[0]).status, "cancelled")


class ArtifactPublisherTests(unittest.TestCase):
    def test_atomic_publish_verifies_bytes_and_never_overwrites(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-") as root:
            publisher = ArtifactPublisher(root)
            first = publisher.publish_bytes(
                "job_12345678",
                "art_12345678",
                "results/output.bin",
                b"first",
                mime_type="application/octet-stream",
            )
            self.assertEqual(Path(first["path"]).read_bytes(), b"first")
            with self.assertRaises(ArtifactConflictError):
                publisher.publish_bytes(
                    "job_12345678",
                    "art_87654321",
                    "results/output.bin",
                    b"second",
                    mime_type="application/octet-stream",
                )
            self.assertEqual(Path(first["path"]).read_bytes(), b"first")

    def test_known_publish_conflict_does_not_leave_unregistered_staging(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-conflict-") as root:
            publisher = ArtifactPublisher(Path(root))
            publisher.publish_bytes(
                "job_conflict01",
                "art_first0001",
                "results/output.bin",
                b"first",
                mime_type="application/octet-stream",
            )
            with self.assertRaises(ArtifactConflictError):
                publisher.publish_bytes(
                    "job_conflict01",
                    "art_second0001",
                    "results/output.bin",
                    b"second",
                    mime_type="application/octet-stream",
                )
            staging = Path(root) / ".staging" / "job_conflict01"
            self.assertEqual(list(staging.glob("art_second0001.*")), [])

    def test_traversal_is_rejected_before_any_write(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-") as root:
            root_path = Path(root)
            outside = root_path.parent / "outside" / "payload.part"
            publisher = ArtifactPublisher(root_path)
            with self.assertRaises(ValueError):
                publisher.publish_bytes(
                    "../../../outside",
                    "art_12345678",
                    "results/output.bin",
                    b"payload",
                    mime_type="application/octet-stream",
                )
            self.assertFalse(outside.exists())
            self.assertEqual(list(root_path.rglob("*")), [])

    def test_reconcile_repairs_receipt_after_publish_without_replaying_bytes(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-") as root:
            root_path = Path(root)
            publisher = ArtifactPublisher(root_path)
            first = publisher.publish_bytes(
                "job_12345678",
                "art_12345678",
                "results/output.bin",
                b"first",
                mime_type="application/octet-stream",
            )
            receipt = root_path / ".staging" / "job_12345678" / "art_12345678.receipt.json"
            intent = root_path / ".staging" / "job_12345678" / "art_12345678.intent.json"
            receipt.unlink()

            ArtifactPublisher(root_path)

            self.assertEqual(Path(first["path"]).read_bytes(), b"first")
            self.assertTrue(receipt.exists())
            self.assertFalse(intent.exists())

    def test_failed_artifact_registration_is_reconciled_on_next_publisher(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-artifact-recovery-") as root:
            root_path = Path(root)
            store = SqliteJobStore(root_path / "jobs.sqlite3")
            job, _ = store.create_job(
                kind="image_batch_inpaint",
                client_scope="desktop",
                idempotency_key="recovery-key-001",
                request_fingerprint="f" * 64,
                request_summary={"input_assets": []},
            )
            store.transition(job.job_id, "running")
            context = JobExecutionContext(job_id=job.job_id, store=store)
            original_add = store.add_artifact
            failed = True

            def fail_once(*args, **kwargs):
                nonlocal failed
                if failed:
                    failed = False
                    raise RuntimeError("simulated registration failure")
                return original_add(*args, **kwargs)

            store.add_artifact = fail_once
            with self.assertRaises(RuntimeError):
                context.publish_bytes(
                    root=root_path / "artifacts",
                    relative_path="results/recover.png",
                    payload=b"recover-me",
                    mime_type="image/png",
                )

            store.add_artifact = original_add
            retry_context = JobExecutionContext(job_id=job.job_id, store=store)
            retry_context.publish_bytes(
                root=root_path / "artifacts",
                relative_path="results/second.png",
                payload=b"second",
                mime_type="image/png",
            )

            artifact_rows = store.get_artifacts(job.job_id)
            self.assertEqual(len(artifact_rows), 2)
            staging = root_path / "artifacts" / ".staging" / job.job_id
            self.assertEqual(list(staging.glob("*.intent.json")), [])
            ledger = store.get_cleanup_ledger(job.job_id)
            self.assertTrue(any(item["state"] == "reconciled" for item in ledger))


class ApplicationFacadeTests(unittest.TestCase):
    def test_disabled_persistence_uses_memory_without_a_temp_file(self):
        facade = ApplicationFacade(None)

        self.assertEqual(str(facade.store.database_path), ":memory:")
        job, _, created = facade.submit_batch_inpaint(
            FakeBatchRequest(),
            lambda _context: {"results": [], "processed_count": 0, "success_count": 0},
            client_scope="desktop",
            idempotency_key="request-key-memory",
        )
        self.assertTrue(created)
        self.assertEqual(job.status, "succeeded")

    def test_same_idempotent_request_returns_saved_response_without_second_execution(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-facade-") as root:
            store = SqliteJobStore(Path(root) / "jobs.sqlite3")
            facade = ApplicationFacade(store)
            request = FakeBatchRequest()
            calls = []

            def processor(context):
                calls.append(context.job_id)
                return {
                    "results": [{"id": "item-1", "success": True}],
                    "processed_count": 1,
                    "success_count": 1,
                    "total_time": 0.0,
                }

            first_job, first_response, first_created = facade.submit_batch_inpaint(
                request,
                processor,
                client_scope="desktop",
                idempotency_key="request-key-001",
            )
            second_job, second_response, second_created = facade.submit_batch_inpaint(
                request,
                processor,
                client_scope="desktop",
                idempotency_key="request-key-001",
            )

            self.assertTrue(first_created)
            self.assertFalse(second_created)
            self.assertEqual(first_job.job_id, second_job.job_id)
            self.assertEqual(first_response, second_response)
            self.assertEqual(len(calls), 1)

    def test_cancellation_wins_when_it_races_the_succeeded_transition(self):
        with tempfile.TemporaryDirectory(prefix="moonshine-facade-") as root:
            store = SqliteJobStore(Path(root) / "jobs.sqlite3")
            facade = ApplicationFacade(store)
            original_transition = store.transition
            raced = False

            def transition(job_id, status, **kwargs):
                nonlocal raced
                if status == "succeeded" and not raced:
                    raced = True
                    original_transition(job_id, "cancelling")
                return original_transition(job_id, status, **kwargs)

            store.transition = transition
            job_ids = []

            def processor(context):
                job_ids.append(context.job_id)
                return {"results": [], "processed_count": 0, "success_count": 0}

            with self.assertRaises(JobCancellationRequested):
                facade.submit_batch_inpaint(
                    FakeBatchRequest(),
                    processor,
                    client_scope="desktop",
                    idempotency_key="request-key-race",
                )

            self.assertEqual(store.get_job(job_ids[0]).status, "cancelled")


if __name__ == "__main__":
    unittest.main()
