from __future__ import annotations

import hashlib
import json
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from moonshine_server.jobs import (
    ArtifactPublisher,
    InvalidJobTransitionError,
    JobRecord,
    SqliteJobStore,
    safe_error,
)
from moonshine_server.jobs.observability import build_job_observability_summary


class JobInProgressError(RuntimeError):
    """A request with the same idempotency key is already being processed."""


class JobCancellationRequested(RuntimeError):
    """The coordinator observed a cancellation request between work items."""


class JobResultUnavailableError(RuntimeError):
    """A completed job has no in-memory legacy response after a restart."""


class JobProcessingError(RuntimeError):
    """A processing failure carrying only a safe v2 error contract."""

    def __init__(self, error: dict[str, Any]):
        super().__init__(error["message_key"])
        self.safe_error = error


@dataclass
class JobExecutionContext:
    job_id: str
    store: SqliteJobStore
    _publishers: dict[str, ArtifactPublisher] = field(default_factory=dict)
    artifact_ids: list[str] = field(default_factory=list)

    def raise_if_cancelled(self) -> None:
        if self.store.get_job(self.job_id).status == "cancelling":
            raise JobCancellationRequested(self.job_id)

    def publish_bytes(
        self,
        *,
        root: Path | str,
        relative_path: str,
        payload: bytes,
        mime_type: str,
        artifact_type: str = "image",
    ) -> dict[str, Any]:
        root_key = str(Path(root).expanduser().resolve())
        publisher = self._publishers.get(root_key)
        if publisher is None:
            publisher = ArtifactPublisher(root_key, retain_reconciled=True)
            self._publishers[root_key] = publisher
            for recovered in publisher.recovery_results:
                if recovered.get("state") == "staging_orphan":
                    # The staged bytes and intent remain in place for deliberate
                    # recovery. Persist only safe artifact metadata, never paths.
                    try:
                        self.store.record_cleanup(
                            recovered["job_id"],
                            recovered["artifact_id"],
                            "staging_orphan",
                            {
                                "recovery": "staging_orphan",
                                "action": "manual_recovery_required",
                                "retention": "staged_bytes_retained",
                                "artifact_type": recovered.get("artifact_type", "image"),
                                "sha256": recovered["sha256"],
                                "size_bytes": int(recovered["size_bytes"]),
                            },
                        )
                    except Exception:
                        # Keep the intent and staged bytes for the next recovery
                        # attempt when the registry is temporarily unavailable.
                        pass
                    continue
                if recovered.get("state") != "receipt_required":
                    continue
                registered = False
                try:
                    self.store.add_artifact(
                        recovered["job_id"],
                        recovered,
                        artifact_type=recovered.get("artifact_type", "image"),
                    )
                    registered = True
                except Exception:
                    try:
                        registered = any(
                            item["artifact_id"] == recovered["artifact_id"]
                            for item in self.store.get_artifacts(recovered["job_id"])
                        )
                    except Exception:
                        registered = False
                if not registered:
                    # Keep the intent and published bytes for the next retry.
                    continue
                try:
                    self.store.record_cleanup(
                        recovered["job_id"],
                        recovered["artifact_id"],
                        "reconciled",
                        {"recovery": "receipt_required"},
                    )
                except Exception:
                    pass
                publisher.acknowledge(recovered["artifact_id"], recovered["job_id"])
        artifact_id = f"art_{uuid.uuid4().hex[:24]}"
        artifact = publisher.publish_bytes(
            self.job_id,
            artifact_id,
            relative_path,
            payload,
            mime_type=mime_type,
            artifact_type=artifact_type,
        )
        try:
            self.store.add_artifact(self.job_id, artifact, artifact_type=artifact_type)
        except Exception:
            try:
                self.store.record_cleanup(
                    self.job_id,
                    artifact_id,
                    "receipt_required",
                    {
                        "error_code": "internal_error",
                        "artifact": {
                            "artifact_id": artifact["artifact_id"],
                            "job_id": artifact["job_id"],
                            "artifact_type": artifact_type,
                            "relative_path": artifact["relative_path"],
                            "mime_type": artifact["mime_type"],
                            "sha256": artifact["sha256"],
                            "size_bytes": artifact["size_bytes"],
                        },
                    },
                )
            except Exception:
                pass
            raise
        publisher.acknowledge(artifact_id, self.job_id)
        self.artifact_ids.append(artifact_id)
        return artifact


class ApplicationFacade:
    """Shared orchestration boundary used by legacy v1 routes and future job clients."""

    def __init__(self, store: SqliteJobStore | None):
        # Disabled persistence uses a process-local SQLite database. It never
        # creates a file and preserves the legacy route's synchronous behavior.
        self.store = store or SqliteJobStore(":memory:")
        self._response_cache: dict[str, dict[str, Any]] = {}

    @staticmethod
    def request_fingerprint(request: Any) -> str:
        if hasattr(request, "model_dump"):
            payload = request.model_dump(mode="json")
        elif hasattr(request, "dict"):
            payload = request.dict()
        else:
            payload = request
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def request_summary(request: Any) -> dict[str, Any]:
        data = request.model_dump(mode="json") if hasattr(request, "model_dump") else {}
        items = data.get("data") if isinstance(data, dict) else None
        input_assets: list[dict[str, Any]] = []
        item_ids: list[str] = []
        for index, item in enumerate(items if isinstance(items, list) else []):
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or f"item_{index}")
            item_digest = hashlib.sha256(
                f"item:{index}:{item_id}".encode("utf-8")
            ).hexdigest()
            item_ids.append(f"itm_{item_digest[:24]}")
            for kind, field_name in (("image", "image"), ("mask", "mask")):
                value = str(item.get(field_name) or "")
                digest = hashlib.sha256(
                    f"{kind}:{index}:{item_id}:{value}".encode("utf-8")
                ).hexdigest()
                input_assets.append(
                    {
                        "schema_version": "asset-ref/v2",
                        "asset_id": f"ast_{digest[:24]}",
                        "kind": kind,
                        "locator": {
                            "scheme": "workspace",
                            "workspace_id": "ws_legacybatch",
                            "relative_path": f"batch/{digest[:24]}/{kind}",
                        },
                        "media_type": "image/png",
                        "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
                        "size_bytes": len(value.encode("utf-8")),
                    }
                )
        if not input_assets:
            digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()
            input_assets.append(
                {
                    "schema_version": "asset-ref/v2",
                    "asset_id": f"ast_{digest[:24]}",
                    "kind": "artifact",
                    "locator": {
                        "scheme": "workspace",
                        "workspace_id": "ws_legacybatch",
                        "relative_path": f"batch/{digest[:24]}/request",
                    },
                    "media_type": "application/octet-stream",
                    "sha256": digest,
                    "size_bytes": 0,
                }
            )
        return {
            "operation": "image_batch_inpaint",
            "item_count": len(items) if isinstance(items, list) else 0,
            "item_ids": item_ids[:100],
            "image_type": data.get("image_type"),
            "mask_type": data.get("mask_type"),
            "response_type": data.get("response_type"),
            "output_format": data.get("output_format"),
            "input_assets": input_assets,
        }

    @staticmethod
    def _safe_result_summary(result: dict[str, Any], artifact_ids: list[str]) -> dict[str, Any]:
        return {
            "processed_count": int(result.get("processed_count") or 0),
            "success_count": int(result.get("success_count") or 0),
            "artifact_ids": list(artifact_ids),
        }

    @staticmethod
    def _public_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
        artifact_id = artifact["artifact_id"]
        asset_digest = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()
        artifact_type = artifact.get("artifact_type", "image")
        if artifact_type not in {"image", "video", "mask", "ocr_sidecar", "preview", "diagnostic"}:
            artifact_type = "diagnostic"
        asset_kind = artifact_type if artifact_type in {"image", "video", "mask", "ocr_sidecar"} else "artifact"
        return {
            "schema_version": "artifact/v2",
            "artifact_id": artifact_id,
            "job_id": artifact["job_id"],
            "artifact_type": artifact_type,
            "asset": {
                "schema_version": "asset-ref/v2",
                "asset_id": f"ast_{asset_digest[:24]}",
                "kind": asset_kind,
                "locator": {"scheme": "artifact", "artifact_id": artifact_id},
                "media_type": artifact["mime_type"],
                "sha256": artifact["sha256"],
                "size_bytes": int(artifact["size_bytes"]),
            },
            "retention": {"class": "result", "expires_at": None},
            "created_at": artifact["created_at"],
        }

    def submit_batch_inpaint(
        self,
        request: Any,
        processor: Callable[[JobExecutionContext], dict[str, Any]],
        *,
        client_scope: str = "legacy-v1",
        idempotency_key: str | None = None,
    ) -> tuple[JobRecord, dict[str, Any], bool]:
        record, created = self._create_batch_job(
            request,
            client_scope=client_scope,
            idempotency_key=idempotency_key,
        )
        if not created:
            cached = self._response_cache.get(record.job_id)
            if cached is not None:
                return record, cached, False
            if record.status not in {"queued", "running", "cancelling"}:
                raise JobResultUnavailableError(record.job_id)
            raise JobInProgressError(record.job_id)

        completed, result = self._execute_batch_job(record.job_id, processor)
        return completed, result, True

    def _create_batch_job(
        self,
        request: Any,
        *,
        client_scope: str,
        idempotency_key: str | None,
        policy_snapshot_id: str = "pol_default00",
        request_summary: dict[str, Any] | None = None,
    ) -> tuple[JobRecord, bool]:
        key = idempotency_key or f"legacy-{uuid.uuid4().hex}"
        fingerprint = self.request_fingerprint(request)
        return self.store.create_job(
            kind="image_batch_inpaint",
            client_scope=client_scope,
            idempotency_key=key,
            request_fingerprint=fingerprint,
            request_summary=request_summary if isinstance(request_summary, dict) else self.request_summary(request),
            policy_snapshot_id=policy_snapshot_id,
        )

    def _execute_batch_job(
        self,
        job_id: str,
        processor: Callable[[JobExecutionContext], dict[str, Any]],
        *,
        policy_validator: Callable[[], bool] | None = None,
    ) -> tuple[JobRecord, dict[str, Any]]:
        context = JobExecutionContext(job_id=job_id, store=self.store)
        self.store.transition(job_id, "running")
        try:
            if policy_validator is not None and not policy_validator():
                error = safe_error(
                    "policy_denied",
                    stage="queue",
                    retryable=False,
                    message_key="job.policy_revoked",
                )
                self.store.transition(job_id, "failed", error=error)
                return self.store.get_job(job_id), {"error": error}
            result = processor(context)
            context.raise_if_cancelled()
            self.store.set_result(
                job_id,
                self._safe_result_summary(result, context.artifact_ids),
                context.artifact_ids,
            )
            context.raise_if_cancelled()
            try:
                completed = self.store.transition(job_id, "succeeded")
            except InvalidJobTransitionError:
                # A cancellation can land between the final cancellation check and
                # the terminal transition. Cancellation wins over success.
                context.raise_if_cancelled()
                raise
            self._response_cache[job_id] = result
            return completed, result
        except JobCancellationRequested:
            self.store.transition(job_id, "cancelled")
            raise
        except Exception as exc:
            error = safe_error(
                "internal_error",
                stage="model",
                retryable=False,
                message_key="job.processing_failed",
            )
            try:
                self.store.transition(job_id, "failed", error=error)
            except Exception:
                # Preserve the original processing error. The store's recovery scan
                # will reconcile a job left in running state on the next start.
                pass
            raise JobProcessingError(error) from exc

    def enqueue_batch_inpaint(
        self,
        request: Any,
        processor: Callable[[JobExecutionContext], dict[str, Any]],
        *,
        client_scope: str,
        idempotency_key: str,
        policy_snapshot_id: str,
        request_summary: dict[str, Any] | None = None,
        policy_validator: Callable[[], bool] | None = None,
    ) -> tuple[JobRecord, bool]:
        """Persist a queued job, then execute it on a daemon worker thread.

        The legacy submit method above remains synchronous. This method is the
        narrow async boundary used by the MCP submit route; the durable job row
        is committed before the worker is started or a response is returned.
        """
        record, created = self._create_batch_job(
            request,
            client_scope=client_scope,
            idempotency_key=idempotency_key,
            policy_snapshot_id=policy_snapshot_id,
            request_summary=request_summary,
        )
        if not created:
            return record, False

        def run() -> None:
            try:
                self._execute_batch_job(
                    record.job_id,
                    processor,
                    policy_validator=policy_validator,
                )
            except (JobCancellationRequested, JobProcessingError):
                # Terminal state and safe error are persisted by the executor.
                return

        worker = threading.Thread(
            target=run,
            name=f"moonshine-job-{record.job_id}",
            daemon=True,
        )
        try:
            worker.start()
        except Exception as exc:
            error = safe_error(
                "resource_exhausted",
                stage="queue",
                retryable=True,
                message_key="job.queue_unavailable",
            )
            try:
                self.store.transition(record.job_id, "failed", error=error)
            except Exception:
                pass
            raise JobProcessingError(error) from exc
        return record, True

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self.store.get_job(job_id).public()

    def get_events(self, job_id: str, *, after_sequence: int = -1, limit: int = 100) -> list[dict[str, Any]]:
        return self.store.get_events(job_id, after_sequence=after_sequence, limit=limit)

    def get_artifacts(self, job_id: str) -> list[dict[str, Any]]:
        return [self._public_artifact(item) for item in self.store.get_artifacts(job_id)]

    def get_cleanup_ledger(self, job_id: str) -> list[dict[str, Any]]:
        allowed_artifact_types = {"image", "video", "mask", "ocr_sidecar", "preview", "diagnostic"}
        allowed_actions = {"manual_recovery_required"}
        allowed_recoveries = {"receipt_required", "staging_orphan"}
        allowed_retentions = {"staged_bytes_retained"}
        allowed_error_codes = {"internal_error"}
        records: list[dict[str, Any]] = []
        for item in self.store.get_cleanup_ledger(job_id):
            detail = item.get("detail")
            safe_detail: dict[str, Any] = {}
            if isinstance(detail, dict):
                if detail.get("action") in allowed_actions:
                    safe_detail["action"] = detail["action"]
                if detail.get("artifact_type") in allowed_artifact_types:
                    safe_detail["artifact_type"] = detail["artifact_type"]
                if detail.get("error_code") in allowed_error_codes:
                    safe_detail["error_code"] = detail["error_code"]
                if detail.get("recovery") in allowed_recoveries:
                    safe_detail["recovery"] = detail["recovery"]
                if detail.get("retention") in allowed_retentions:
                    safe_detail["retention"] = detail["retention"]
                sha256 = detail.get("sha256")
                if (
                    isinstance(sha256, str)
                    and len(sha256) == 64
                    and all(character in "0123456789abcdef" for character in sha256)
                ):
                    safe_detail["sha256"] = sha256
                size_bytes = detail.get("size_bytes")
                if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes >= 0:
                    safe_detail["size_bytes"] = size_bytes
            records.append(
                {
                    "artifact_id": item["artifact_id"],
                    "state": item["state"],
                    "detail": safe_detail,
                    "updated_at": item["updated_at"],
                }
            )
        return records

    def get_observability_summary(self, job_id: str) -> dict[str, Any]:
        job = self.store.get_job(job_id).public()
        return build_job_observability_summary(
            job,
            self.store.get_events(job_id),
            self.store.get_artifacts(job_id),
            self.get_cleanup_ledger(job_id),
        )

    def cancel(self, job_id: str) -> dict[str, Any]:
        current = self.store.get_job(job_id)
        if current.status == "queued":
            return self.store.transition(job_id, "cancelled").public()
        if current.status == "running":
            return self.store.transition(job_id, "cancelling").public()
        return current.public()
