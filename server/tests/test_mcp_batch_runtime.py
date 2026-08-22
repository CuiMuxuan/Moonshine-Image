from __future__ import annotations

import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

from moonshine_server.application_facade import ApplicationFacade
from moonshine_server.jobs import IdempotencyConflictError, SqliteJobStore


@contextmanager
def temporary_store(prefix):
    with tempfile.TemporaryDirectory(prefix=prefix) as root:
        store = SqliteJobStore(Path(root) / "jobs.sqlite3")
        try:
            yield root, store
        finally:
            # Daemon workers may still be unwinding after the job reaches a
            # terminal state; wait before removing the Windows-backed SQLite
            # directory.
            for worker in tuple(threading.enumerate()):
                if worker.name.startswith("moonshine-job-"):
                    worker.join(timeout=2)
            store.close()


class McpBatchRuntimeTests(unittest.TestCase):
    def test_contract_fingerprint_reuses_job_when_request_metadata_changes(self):
        with temporary_store("moonshine-mcp-fingerprint-") as (root, store):
            facade = ApplicationFacade(store)
            processed = []
            def fingerprint_payload(request_id, confirmation):
                inbound = {
                    "workspace_id": "ws_abcdefgh",
                    "items": [{"id": "itm_abcdefgh", "input_path": "a.png", "mask_path": "a.mask.png"}],
                    "client_id": "stdio-adapter",
                    "request_id": request_id,
                    "policy_snapshot_id": "pol_abcdefgh",
                    "confirmation": confirmation,
                }
                return {
                    "workspace_id": inbound["workspace_id"],
                    "items": inbound["items"],
                    "client_id": inbound["client_id"],
                    "policy_snapshot_id": inbound["policy_snapshot_id"],
                    "options": {"operation": "image_batch_inpaint"},
                }

            first_request = fingerprint_payload(
                "req_first000",
                {"mode": "confirmed", "confirmation_id": "cnf_first000"},
            )
            retry_request = fingerprint_payload(
                "req_retry000",
                {"mode": "confirmed", "confirmation_id": "cnf_retry000"},
            )
            self.assertNotEqual("req_first000", "req_retry000")
            self.assertNotEqual("cnf_first000", "cnf_retry000")
            self.assertEqual(first_request, retry_request)
            first, created = facade.enqueue_batch_inpaint(
                first_request,
                lambda _context: processed.append("first") or {"processed_count": 1, "success_count": 1},
                client_scope="stdio-adapter",
                idempotency_key="batch-key-fingerprint",
                policy_snapshot_id="pol_abcdefgh",
            )
            self.assertTrue(created)
            second, replayed = facade.enqueue_batch_inpaint(
                retry_request,
                lambda _context: processed.append("second") or {"processed_count": 1, "success_count": 1},
                client_scope="stdio-adapter",
                idempotency_key="batch-key-fingerprint",
                policy_snapshot_id="pol_abcdefgh",
            )
            self.assertFalse(replayed)
            self.assertEqual(second.job_id, first.job_id)
            deadline = time.time() + 2
            while time.time() < deadline and store.get_job(first.job_id).status not in {"succeeded", "failed", "cancelled"}:
                time.sleep(0.01)
            self.assertEqual(processed, ["first"])

    def test_enqueue_persists_queued_job_before_worker_and_reuses_idempotency(self):
        with temporary_store("moonshine-mcp-submit-") as (root, store):
            facade = ApplicationFacade(store)
            started = threading.Event()
            release = threading.Event()

            def processor(context):
                started.set()
                release.wait(2)
                context.publish_bytes(
                    root=Path(root) / "artifacts" / context.job_id,
                    relative_path="result_item.png",
                    payload=b"result",
                    mime_type="image/png",
                )
                return {"processed_count": 1, "success_count": 1}

            first, created = facade.enqueue_batch_inpaint(
                {"workspace_id": "ws_abcdefgh", "items": [{"id": "itm_abcdefgh", "input_path": "a.png", "mask_path": "a.mask.png"}]},
                processor,
                client_scope="stdio-adapter",
                idempotency_key="batch-key-001",
                policy_snapshot_id="pol_abcdefgh",
            )
            self.assertTrue(created)
            self.assertIn(first.status, {"queued", "running"})
            self.assertTrue(started.wait(1))

            replay, replay_created = facade.enqueue_batch_inpaint(
                {"workspace_id": "ws_abcdefgh", "items": [{"id": "itm_abcdefgh", "input_path": "a.png", "mask_path": "a.mask.png"}]},
                processor,
                client_scope="stdio-adapter",
                idempotency_key="batch-key-001",
                policy_snapshot_id="pol_abcdefgh",
            )
            self.assertFalse(replay_created)
            self.assertEqual(replay.job_id, first.job_id)
            release.set()
            deadline = time.time() + 2
            while time.time() < deadline and store.get_job(first.job_id).status not in {"succeeded", "failed", "cancelled"}:
                time.sleep(0.01)
            self.assertEqual(store.get_job(first.job_id).status, "succeeded")
            self.assertEqual(len(store.get_artifacts(first.job_id)), 1)

    def test_contract_fingerprint_rejects_semantic_request_changes(self):
        with temporary_store("moonshine-mcp-fingerprint-conflict-") as (root, store):
            facade = ApplicationFacade(store)
            base_request = {
                "workspace_id": "ws_abcdefgh",
                "items": [{"id": "itm_abcdefgh", "input_path": "a.png", "mask_path": "a.mask.png"}],
                "client_id": "stdio-adapter",
                "policy_snapshot_id": "pol_abcdefgh",
                "options": {"operation": "image_batch_inpaint"},
            }
            first, created = facade.enqueue_batch_inpaint(
                base_request,
                lambda _context: {"processed_count": 1, "success_count": 1},
                client_scope="stdio-adapter",
                idempotency_key="batch-key-conflict",
                policy_snapshot_id="pol_abcdefgh",
            )
            self.assertTrue(created)
            deadline = time.time() + 2
            while time.time() < deadline and store.get_job(first.job_id).status not in {"succeeded", "failed", "cancelled"}:
                time.sleep(0.01)

            changed_requests = [
                {**base_request, "workspace_id": "ws_bcdefghi"},
                {**base_request, "items": [{"id": "itm_abcdefgh", "input_path": "b.png", "mask_path": "a.mask.png"}]},
                {**base_request, "items": [{**base_request["items"][0], "model_id": "mat"}]},
                {**base_request, "client_id": "other-client"},
                {**base_request, "policy_snapshot_id": "pol_bcdefghi"},
            ]
            for changed_request in changed_requests:
                with self.subTest(changed_request=changed_request):
                    with self.assertRaises(IdempotencyConflictError):
                        facade.enqueue_batch_inpaint(
                            changed_request,
                            lambda _context: {"processed_count": 1, "success_count": 1},
                            client_scope="stdio-adapter",
                            idempotency_key="batch-key-conflict",
                            policy_snapshot_id=changed_request["policy_snapshot_id"],
                        )

    def test_worker_policy_drift_fails_without_processing_inputs(self):
        with temporary_store("moonshine-mcp-policy-") as (root, store):
            facade = ApplicationFacade(store)
            processed = []
            current_policy = {"value": "pol_newer00"}
            job, created = facade.enqueue_batch_inpaint(
                {"workspace_id": "ws_abcdefgh", "items": [{"id": "itm_abcdefgh", "input_path": "a.png", "mask_path": "a.mask.png"}]},
                lambda _context: processed.append(True) or {"processed_count": 1, "success_count": 1},
                client_scope="stdio-adapter",
                idempotency_key="batch-key-002",
                policy_snapshot_id="pol_old0000",
                policy_validator=lambda: current_policy["value"] == "pol_old0000",
            )
            self.assertTrue(created)
            deadline = time.time() + 2
            while time.time() < deadline and store.get_job(job.job_id).status not in {"succeeded", "failed", "cancelled"}:
                time.sleep(0.01)
            self.assertEqual(store.get_job(job.job_id).status, "failed")
            self.assertEqual(processed, [])
            self.assertEqual(store.get_job(job.job_id).error["message_key"], "job.policy_revoked")


if __name__ == "__main__":
    unittest.main()
