from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


JOB_STATUSES = {"queued", "running", "cancelling", "succeeded", "failed", "cancelled"}
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
ALLOWED_TRANSITIONS = {
    "queued": {"running", "cancelling", "cancelled", "failed"},
    "running": {"cancelling", "succeeded", "failed"},
    "cancelling": {"cancelled", "failed"},
    "succeeded": set(),
    "failed": set(),
    "cancelled": set(),
}
DEFAULT_POLICY_SNAPSHOT_ID = "pol_default00"
SAFE_ERROR_CODES = frozenset(
    {
        "invalid_input",
        "asset_not_found",
        "asset_not_allowed",
        "path_escape",
        "model_not_ready",
        "component_not_ready",
        "policy_denied",
        "policy_revoked",
        "confirmation_required",
        "confirmation_expired",
        "resource_exhausted",
        "job_conflict",
        "job_cancelled",
        "backend_unavailable",
        "internal_error",
    }
)
SAFE_ERROR_STAGES = frozenset({"submit", "validate", "queue", "decode", "model", "mask", "write", "publish", "recover", "cancel"})
ARTIFACT_TYPES = frozenset({"image", "video", "mask", "ocr_sidecar", "preview", "diagnostic"})
ASSET_KINDS = frozenset({"image", "video", "mask", "ocr_sidecar", "artifact"})
CLEANUP_STATES = frozenset({"staging_orphan", "receipt_required", "reconciled"})
_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*_[a-z0-9]{8,64}$")
_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_MEDIA_TYPE_PATTERN = re.compile(r"^[a-z0-9.+-]+/[a-z0-9.+-]+$")
_MESSAGE_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{2,95}$")


class JobStoreError(RuntimeError):
    pass


class IdempotencyConflictError(JobStoreError):
    pass


class InvalidJobTransitionError(JobStoreError):
    pass


class EventSequenceError(JobStoreError):
    pass


class JobNotFoundError(JobStoreError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def safe_error(
    code: str,
    *,
    stage: str,
    retryable: bool,
    message_key: str,
    safe_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_code = code if code in SAFE_ERROR_CODES else "internal_error"
    normalized_stage = stage if stage in SAFE_ERROR_STAGES else "recover"
    normalized_retryable = retryable if isinstance(retryable, bool) else False
    normalized_message_key = message_key if isinstance(message_key, str) and _MESSAGE_KEY_PATTERN.fullmatch(message_key) else "job.internal_error"
    error = {
        "schema_version": "error/v2",
        "code": normalized_code,
        "stage": normalized_stage,
        "retryable": normalized_retryable,
        "message_key": normalized_message_key,
    }
    if isinstance(safe_details, dict):
        details: dict[str, Any] = {}
        diagnostic_id = safe_details.get("diagnostic_id")
        if isinstance(diagnostic_id, str) and _ID_PATTERN.fullmatch(diagnostic_id):
            details["diagnostic_id"] = diagnostic_id
        retry_after_ms = safe_details.get("retry_after_ms")
        if isinstance(retry_after_ms, int) and not isinstance(retry_after_ms, bool) and retry_after_ms >= 0:
            details["retry_after_ms"] = retry_after_ms
        required_component = safe_details.get("required_component")
        if isinstance(required_component, str) and _MESSAGE_KEY_PATTERN.fullmatch(required_component):
            details["required_component"] = required_component
        field = safe_details.get("field")
        if isinstance(field, str) and re.fullmatch(r"^[a-z][a-z0-9_.-]{0,95}$", field):
            details["field"] = field
        item_index = safe_details.get("item_index")
        if isinstance(item_index, int) and not isinstance(item_index, bool) and item_index >= 0:
            details["item_index"] = item_index
        if details:
            error["safe_details"] = details
    return error


def _safe_relative_path(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
        return None
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return "/".join(parts)


def _safe_asset_ref(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    if value.get("schema_version") != "asset-ref/v2":
        return None
    asset_id = value.get("asset_id")
    kind = value.get("kind")
    media_type = value.get("media_type")
    sha256 = value.get("sha256")
    size_bytes = value.get("size_bytes")
    if not isinstance(asset_id, str) or not _ID_PATTERN.fullmatch(asset_id):
        return None
    if kind not in ASSET_KINDS or not isinstance(media_type, str) or not _MEDIA_TYPE_PATTERN.fullmatch(media_type):
        return None
    if not isinstance(sha256, str) or not _SHA256_PATTERN.fullmatch(sha256):
        return None
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes < 0:
        return None
    locator = value.get("locator")
    if not isinstance(locator, dict):
        return None
    scheme = locator.get("scheme")
    if scheme == "workspace":
        workspace_id = locator.get("workspace_id")
        relative_path = _safe_relative_path(locator.get("relative_path"))
        if not isinstance(workspace_id, str) or not re.fullmatch(r"^ws_[a-z0-9]{8,64}$", workspace_id) or relative_path is None:
            return None
        safe_locator = {"scheme": "workspace", "workspace_id": workspace_id, "relative_path": relative_path}
    elif scheme == "artifact":
        artifact_id = locator.get("artifact_id")
        if not isinstance(artifact_id, str) or not _ID_PATTERN.fullmatch(artifact_id) or not artifact_id.startswith("art_"):
            return None
        safe_locator = {"scheme": "artifact", "artifact_id": artifact_id}
    else:
        return None
    result = {
        "schema_version": "asset-ref/v2",
        "asset_id": asset_id,
        "kind": kind,
        "locator": safe_locator,
        "media_type": media_type,
        "sha256": sha256,
        "size_bytes": size_bytes,
    }
    for key in ("width", "height", "duration_ms"):
        dimension = value.get(key)
        if isinstance(dimension, int) and not isinstance(dimension, bool) and dimension >= (1 if key != "duration_ms" else 0):
            result[key] = dimension
    return result


def _safe_request_summary(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe: dict[str, Any] = {}
    for key in ("operation", "image_type", "mask_type", "response_type", "output_format"):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= 160:
            safe[key] = item
    for key, pattern, maximum in (
        ("request_id", re.compile(r"^req_[a-z0-9]{8,64}$"), 80),
        ("client_id", re.compile(r"^[A-Za-z0-9._-]{1,128}$"), 128),
        ("policy_snapshot_id", re.compile(r"^pol_[a-z0-9_]{8,64}$"), 80),
        ("workspace_id", re.compile(r"^ws_[a-z0-9]{8,64}$"), 68),
    ):
        item = value.get(key)
        if isinstance(item, str) and len(item) <= maximum and pattern.fullmatch(item):
            safe[key] = item
    item_count = value.get("item_count")
    if isinstance(item_count, int) and not isinstance(item_count, bool) and item_count >= 0:
        safe["item_count"] = item_count
    item_ids = value.get("item_ids")
    if isinstance(item_ids, list):
        safe["item_ids"] = [item for item in item_ids if isinstance(item, str) and _ID_PATTERN.fullmatch(item)][:100]
    input_assets = value.get("input_assets")
    if isinstance(input_assets, list):
        safe_assets = [asset for asset in (_safe_asset_ref(item) for item in input_assets) if asset is not None]
        if safe_assets:
            safe["input_assets"] = safe_assets[:200]
    return safe


def _safe_result_summary(value: Any, artifact_ids: list[str] | None = None) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("processed_count", "success_count"):
        item = value.get(key)
        if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
            result[key] = item
    ids = artifact_ids if artifact_ids is not None else value.get("artifact_ids")
    if isinstance(ids, list):
        result["artifact_ids"] = [item for item in ids if isinstance(item, str) and item.startswith("art_") and _ID_PATTERN.fullmatch(item)]
    return result


def _safe_cleanup_detail(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe: dict[str, Any] = {}
    if value.get("action") == "manual_recovery_required":
        safe["action"] = value["action"]
    if value.get("recovery") in CLEANUP_STATES:
        safe["recovery"] = value["recovery"]
    if value.get("retention") == "staged_bytes_retained":
        safe["retention"] = value["retention"]
    if value.get("artifact_type") in ARTIFACT_TYPES:
        safe["artifact_type"] = value["artifact_type"]
    if value.get("error_code") in SAFE_ERROR_CODES:
        safe["error_code"] = value["error_code"]
    sha256 = value.get("sha256")
    if isinstance(sha256, str) and _SHA256_PATTERN.fullmatch(sha256):
        safe["sha256"] = sha256
    size_bytes = value.get("size_bytes")
    if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes >= 0:
        safe["size_bytes"] = size_bytes
    return safe


def _fallback_input_assets(job_id: str) -> list[dict[str, Any]]:
    digest = hashlib.sha256(job_id.encode("utf-8")).hexdigest()
    return [
        {
            "schema_version": "asset-ref/v2",
            "asset_id": f"ast_{digest[:24]}",
            "kind": "artifact",
            "locator": {
                "scheme": "workspace",
                "workspace_id": "ws_legacybatch",
                "relative_path": f"batch/recovered/{digest[:24]}",
            },
            "media_type": "application/octet-stream",
            "sha256": digest,
            "size_bytes": 0,
        }
    ]


def _safe_event_payload(event_type: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    safe: dict[str, Any] = {}
    progress = payload.get("progress")
    if isinstance(progress, (int, float)) and not isinstance(progress, bool) and math.isfinite(float(progress)):
        safe["progress"] = max(0, min(1, float(progress)))
    for key in ("completed_items", "total_items"):
        if isinstance(payload.get(key), int) and not isinstance(payload[key], bool) and payload[key] >= 0:
            safe[key] = payload[key]
    artifact_ids = payload.get("artifact_ids")
    if isinstance(artifact_ids, list):
        safe["artifact_ids"] = [item for item in artifact_ids if isinstance(item, str) and _ID_PATTERN.fullmatch(item)]
    if isinstance(payload.get("error_code"), str) and re.fullmatch(r"^[a-z][a-z0-9_]{2,95}$", payload["error_code"]):
        safe["error_code"] = payload["error_code"]
    elif event_type in {"failed", "recovery_started"}:
        safe["error_code"] = "internal_error"
    if isinstance(payload.get("diagnostic_id"), str) and payload["diagnostic_id"].startswith("diag_"):
        safe["diagnostic_id"] = payload["diagnostic_id"]
    return safe


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    kind: str
    status: str
    client_scope: str
    idempotency_key: str
    request_fingerprint: str
    policy_snapshot_id: str
    renderer_required: bool
    write_started: bool
    request_summary: dict[str, Any]
    result_summary: dict[str, Any] | None
    error: dict[str, Any] | None
    created_at: str
    updated_at: str
    artifact_ids: tuple[str, ...] = ()

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "JobRecord":
        raw_error = json.loads(row["error_json"]) if row["error_json"] else None
        error = raw_error if isinstance(raw_error, dict) and raw_error.get("schema_version") == "error/v2" else None
        return cls(
            job_id=row["job_id"],
            kind=row["kind"],
            status=row["status"],
            client_scope=row["client_scope"],
            idempotency_key=row["idempotency_key"],
            request_fingerprint=row["request_fingerprint"],
            policy_snapshot_id=row["policy_snapshot_id"],
            renderer_required=bool(row["renderer_required"]),
            write_started=bool(row["write_started"]),
        request_summary=_safe_request_summary(json.loads(row["request_json"])),
        result_summary=_safe_result_summary(json.loads(row["result_json"])) if row["result_json"] else None,
            error=error,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def public(self, artifact_ids: list[str] | None = None) -> dict[str, Any]:
        request_assets = [
            asset
            for asset in (_safe_asset_ref(item) for item in self.request_summary.get("input_assets", []))
            if asset is not None
        ]
        safe_artifact_ids = [
            item
            for item in (artifact_ids if artifact_ids is not None else self.artifact_ids)
            if isinstance(item, str) and item.startswith("art_") and _ID_PATTERN.fullmatch(item)
        ]
        return {
            "schema_version": "job/v2",
            "job_id": self.job_id,
            "kind": self.kind,
            "status": self.status,
            "idempotency_key": self.idempotency_key,
            "request_fingerprint": self.request_fingerprint,
            "policy_snapshot_id": self.policy_snapshot_id,
            "renderer_required": self.renderer_required,
            "input_assets": request_assets or _fallback_input_assets(self.job_id),
            "artifact_ids": safe_artifact_ids,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error": self.error,
        }


class SqliteJobStore:
    """Single-writer SQLite registry shared by routes and worker adapters."""

    def __init__(self, database_path: Path | str, *, recover: bool = True):
        self.database_path = Path(database_path)
        self._memory_uri: str | None = None
        self._memory_anchor: sqlite3.Connection | None = None
        if str(self.database_path) == ":memory:":
            # Keep one anchor connection alive so per-operation connections share
            # the same in-memory schema without creating a temporary file.
            self._memory_uri = f"file:moonshine_jobs_{uuid.uuid4().hex}?mode=memory&cache=shared"
            self._memory_anchor = sqlite3.connect(self._memory_uri, uri=True, timeout=5, isolation_level=None)
        if str(self.database_path) != ":memory:":
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()
        if recover:
            self.recover_started_jobs()

    def _connect(self) -> sqlite3.Connection:
        if self._memory_uri is not None:
            connection = sqlite3.connect(self._memory_uri, uri=True, timeout=5, isolation_level=None)
        else:
            connection = sqlite3.connect(str(self.database_path), timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def close(self) -> None:
        anchor, self._memory_anchor = self._memory_anchor, None
        if anchor is not None:
            anchor.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if version == 0:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.execute(
                        """CREATE TABLE jobs (
                            job_id TEXT PRIMARY KEY,
                            kind TEXT NOT NULL,
                            status TEXT NOT NULL,
                            client_scope TEXT NOT NULL,
                            idempotency_key TEXT NOT NULL,
                            request_fingerprint TEXT NOT NULL,
                            policy_snapshot_id TEXT NOT NULL,
                            renderer_required INTEGER NOT NULL,
                            write_started INTEGER NOT NULL DEFAULT 0,
                            request_json TEXT NOT NULL,
                            result_json TEXT,
                            error_json TEXT,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            UNIQUE(client_scope, idempotency_key)
                        )"""
                    )
                    connection.execute(
                        """CREATE TABLE job_events (
                            job_id TEXT NOT NULL,
                            sequence INTEGER NOT NULL,
                            event_type TEXT NOT NULL,
                            payload_json TEXT NOT NULL,
                            created_at TEXT NOT NULL,
                            PRIMARY KEY(job_id, sequence),
                            FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                        )"""
                    )
                    connection.execute(
                        """CREATE TABLE artifacts (
                            artifact_id TEXT PRIMARY KEY,
                            job_id TEXT NOT NULL,
                            artifact_type TEXT NOT NULL,
                            relative_path TEXT NOT NULL,
                            mime_type TEXT NOT NULL,
                            size_bytes INTEGER NOT NULL,
                            sha256 TEXT NOT NULL,
                            created_at TEXT NOT NULL,
                            FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                        )"""
                    )
                    connection.execute(
                        """CREATE TABLE cleanup_ledger (
                            job_id TEXT NOT NULL,
                            artifact_id TEXT NOT NULL,
                            state TEXT NOT NULL,
                            detail_json TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            PRIMARY KEY(job_id, artifact_id),
                            FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                        )"""
                    )
                    connection.execute("CREATE INDEX jobs_status_idx ON jobs(status, updated_at)")
                    connection.execute("PRAGMA user_version = 1")
                    connection.execute("COMMIT")
                except BaseException:
                    if connection.in_transaction:
                        connection.execute("ROLLBACK")
                    raise
            elif version == 1:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.execute(
                        """CREATE TABLE IF NOT EXISTS cleanup_ledger (
                            job_id TEXT NOT NULL,
                            artifact_id TEXT NOT NULL,
                            state TEXT NOT NULL,
                            detail_json TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            PRIMARY KEY(job_id, artifact_id),
                            FOREIGN KEY(job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
                        )"""
                    )
                    connection.execute("COMMIT")
                except BaseException:
                    if connection.in_transaction:
                        connection.execute("ROLLBACK")
                    raise
            else:
                raise JobStoreError(f"unsupported job database schema version: {version}")
        finally:
            connection.close()

    @staticmethod
    def _next_event(connection: sqlite3.Connection, job_id: str, event_type: str, payload: dict[str, Any]) -> int:
        next_sequence = int(
            connection.execute(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM job_events WHERE job_id = ?",
                (job_id,),
            ).fetchone()[0]
        )
        connection.execute(
            "INSERT INTO job_events(job_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (job_id, next_sequence, event_type, _json(payload), utc_now()),
        )
        return next_sequence

    @staticmethod
    def _row(connection: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFoundError(job_id)
        return row

    def _transaction(self):
        connection = self._connect()
        connection.execute("BEGIN IMMEDIATE")
        return connection

    def create_job(
        self,
        *,
        kind: str,
        client_scope: str,
        idempotency_key: str,
        request_fingerprint: str,
        request_summary: dict[str, Any],
        policy_snapshot_id: str = DEFAULT_POLICY_SNAPSHOT_ID,
        renderer_required: bool = False,
    ) -> tuple[JobRecord, bool]:
        idempotency_digest = hashlib.sha256(
            f"{client_scope}\0{idempotency_key}".encode("utf-8")
        ).hexdigest()
        with self._lock:
            connection = self._transaction()
            try:
                existing = connection.execute(
                    "SELECT * FROM jobs WHERE client_scope = ? AND idempotency_key = ?",
                    (client_scope, idempotency_digest),
                ).fetchone()
                if existing is not None:
                    record = JobRecord.from_row(existing)
                    if record.request_fingerprint != request_fingerprint:
                        raise IdempotencyConflictError(
                            "idempotency key already belongs to another request"
                        )
                    connection.execute("COMMIT")
                    return record, False

                job_id = f"job_{uuid.uuid4().hex[:24]}"
                now = utc_now()
                connection.execute(
                    """
                    INSERT INTO jobs(
                        job_id, kind, status, client_scope, idempotency_key,
                        request_fingerprint, policy_snapshot_id, renderer_required,
                        request_json, created_at, updated_at
                    ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        kind,
                        client_scope,
                        idempotency_digest,
                        request_fingerprint,
                        policy_snapshot_id,
                        int(renderer_required),
                        _json(_safe_request_summary(request_summary)),
                        now,
                        now,
                    ),
                )
                self._next_event(connection, job_id, "accepted", {})
                record = JobRecord.from_row(self._row(connection, job_id))
                connection.execute("COMMIT")
                return record, True
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()

    def transition(self, job_id: str, status: str, *, error: dict[str, Any] | None = None) -> JobRecord:
        if status not in JOB_STATUSES:
            raise InvalidJobTransitionError(f"unknown job status: {status}")
        with self._lock:
            connection = self._transaction()
            try:
                current = JobRecord.from_row(self._row(connection, job_id))
                if status == current.status:
                    connection.execute("COMMIT")
                    return current
                if status not in ALLOWED_TRANSITIONS[current.status]:
                    raise InvalidJobTransitionError(f"{current.status} -> {status} is not allowed")
                now = utc_now()
                write_started = current.write_started or status in {"running", "cancelling"}
                connection.execute(
                    "UPDATE jobs SET status = ?, write_started = ?, error_json = ?, updated_at = ? WHERE job_id = ?",
                    (status, int(write_started), _json(error) if error else None, now, job_id),
                )
                event_type = {
                    "running": "started",
                    "cancelling": "cancel_requested",
                    "succeeded": "succeeded",
                    "failed": "failed",
                    "cancelled": "cancelled",
                }.get(status, "progress")
                event_payload = {"error_code": error["code"]} if error else {}
                self._next_event(connection, job_id, event_type, event_payload)
                record = JobRecord.from_row(self._row(connection, job_id))
                connection.execute("COMMIT")
                return record
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()

    def set_result(self, job_id: str, result: dict[str, Any], artifact_ids: list[str] | None = None) -> JobRecord:
        with self._lock:
            connection = self._transaction()
            try:
                self._row(connection, job_id)
                connection.execute(
                    "UPDATE jobs SET result_json = ?, updated_at = ? WHERE job_id = ?",
                    (_json(_safe_result_summary(result, artifact_ids)), utc_now(), job_id),
                )
                if artifact_ids:
                    self._next_event(connection, job_id, "artifact_published", {"artifact_ids": artifact_ids})
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()
        return self.get_job(job_id)

    def add_artifact(self, job_id: str, artifact: dict[str, Any], *, artifact_type: str = "image") -> None:
        if artifact_type not in ARTIFACT_TYPES:
            raise JobStoreError("unsupported artifact type")
        artifact_id = artifact.get("artifact_id")
        relative_path = _safe_relative_path(artifact.get("relative_path"))
        mime_type = artifact.get("mime_type")
        size_bytes = artifact.get("size_bytes")
        sha256 = artifact.get("sha256")
        if (
            not isinstance(artifact_id, str)
            or not artifact_id.startswith("art_")
            or not _ID_PATTERN.fullmatch(artifact_id)
            or relative_path is None
            or not isinstance(mime_type, str)
            or not _MEDIA_TYPE_PATTERN.fullmatch(mime_type)
            or not isinstance(size_bytes, int)
            or isinstance(size_bytes, bool)
            or size_bytes < 0
            or not isinstance(sha256, str)
            or not _SHA256_PATTERN.fullmatch(sha256)
        ):
            raise JobStoreError("artifact metadata is invalid")
        with self._lock:
            connection = self._transaction()
            try:
                self._row(connection, job_id)
                connection.execute(
                    """
                    INSERT INTO artifacts(artifact_id, job_id, artifact_type, relative_path, mime_type, size_bytes, sha256, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        artifact_id,
                        job_id,
                        artifact_type,
                        relative_path,
                        mime_type,
                        size_bytes,
                        sha256,
                        utc_now(),
                    ),
                )
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()

    def get_job(self, job_id: str) -> JobRecord:
        connection = self._connect()
        try:
            record = JobRecord.from_row(self._row(connection, job_id))
        finally:
            connection.close()
        artifact_ids = [item["artifact_id"] for item in self.get_artifacts(job_id)]
        return replace(record, artifact_ids=tuple(artifact_ids))

    def get_events(self, job_id: str, *, after_sequence: int = -1, limit: int = 100) -> list[dict[str, Any]]:
        if after_sequence < -1:
            raise EventSequenceError("event cursor cannot be negative")
        connection = self._connect()
        try:
            self._row(connection, job_id)
            rows = connection.execute(
                "SELECT sequence, event_type, payload_json, created_at FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
                (job_id, after_sequence, max(1, min(limit, 500))),
            ).fetchall()
            return [
                {
                    "schema_version": "job-event/v2",
                    "event_id": "evt_"
                    + hashlib.sha256(
                        f"{job_id}:{row['sequence']}".encode("utf-8")
                    ).hexdigest()[:24],
                    "job_id": job_id,
                    "sequence": row["sequence"],
                    "event_type": row["event_type"],
                    "timestamp": row["created_at"],
                    "payload": _safe_event_payload(row["event_type"], json.loads(row["payload_json"])),
                }
                for row in rows
            ]
        finally:
            connection.close()

    def get_artifacts(self, job_id: str) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            self._row(connection, job_id)
            rows = connection.execute(
                """SELECT artifact_id, job_id, artifact_type, relative_path, mime_type,
                          size_bytes, sha256, created_at
                   FROM artifacts WHERE job_id = ? ORDER BY created_at, artifact_id""",
                (job_id,),
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()

    def record_cleanup(
        self,
        job_id: str,
        artifact_id: str,
        state: str,
        detail: dict[str, Any] | None = None,
    ) -> None:
        if state not in CLEANUP_STATES or not isinstance(artifact_id, str) or not artifact_id.startswith("art_") or not _ID_PATTERN.fullmatch(artifact_id):
            raise JobStoreError("cleanup record is invalid")
        with self._lock:
            connection = self._transaction()
            try:
                self._row(connection, job_id)
                connection.execute(
                    """INSERT INTO cleanup_ledger(job_id, artifact_id, state, detail_json, updated_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(job_id, artifact_id) DO UPDATE SET
                           state = excluded.state,
                           detail_json = excluded.detail_json,
                           updated_at = excluded.updated_at""",
                    (job_id, artifact_id, state, _json(_safe_cleanup_detail(detail)), utc_now()),
                )
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()

    def get_cleanup_ledger(self, job_id: str) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            self._row(connection, job_id)
            rows = connection.execute(
                """SELECT artifact_id, state, detail_json, updated_at
                   FROM cleanup_ledger WHERE job_id = ? ORDER BY updated_at, artifact_id""",
                (job_id,),
            ).fetchall()
            return [
                {
                    "artifact_id": row["artifact_id"],
                    "state": row["state"],
                    "detail": json.loads(row["detail_json"]),
                    "updated_at": row["updated_at"],
                }
                for row in rows
            ]
        finally:
            connection.close()

    def recover_started_jobs(self) -> list[str]:
        recovered: list[str] = []
        with self._lock:
            connection = self._transaction()
            try:
                rows = connection.execute(
                    "SELECT job_id FROM jobs WHERE status IN ('running', 'cancelling') AND write_started = 1"
                ).fetchall()
                for row in rows:
                    job_id = row["job_id"]
                    error = safe_error(
                        "internal_error",
                        stage="recover",
                        retryable=False,
                        message_key="job.interrupted_requires_reconciliation",
                    )
                    connection.execute(
                        "UPDATE jobs SET status = 'failed', error_json = ?, updated_at = ? WHERE job_id = ?",
                        (_json(error), utc_now(), job_id),
                    )
                    self._next_event(
                        connection,
                        job_id,
                        "recovery_started",
                        {"error_code": "internal_error"},
                    )
                    self._next_event(
                        connection,
                        job_id,
                        "failed",
                        {"error_code": "internal_error"},
                    )
                    recovered.append(job_id)
                connection.execute("COMMIT")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("ROLLBACK")
                raise
            finally:
                connection.close()
        return recovered
