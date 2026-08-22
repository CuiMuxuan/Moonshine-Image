from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any


class ArtifactIntegrityError(RuntimeError):
    """The staged artifact no longer matches its recorded digest or size."""


class ArtifactConflictError(RuntimeError):
    """Publishing would overwrite an existing artifact."""


def sha256_bytes(payload: bytes) -> tuple[str, int]:
    return hashlib.sha256(payload).hexdigest(), len(payload)


def sha256_file(file_path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _resolve_contained(root: Path, relative_path: str | Path) -> Path:
    root_resolved = root.expanduser().resolve()
    candidate = (root_resolved / str(relative_path)).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError(f"path escapes artifact root: {relative_path}") from exc
    return candidate


def _durable_json(file_path: Path, value: dict[str, Any]) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = file_path.with_name(
        f".{file_path.name}.{os.getpid()}.{time.time_ns()}.tmp"
    )
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    try:
        with temporary_path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, file_path)
    finally:
        temporary_path.unlink(missing_ok=True)


class ArtifactPublisher:
    """Publish bytes by staging and atomically linking within one approved root."""

    def __init__(self, root: Path | str, *, retain_reconciled: bool = False):
        self.root = Path(root).expanduser().resolve()
        self.retain_reconciled = retain_reconciled
        self.root.mkdir(parents=True, exist_ok=True)
        self.recovery_results = self.reconcile()

    @staticmethod
    def _receipt_path(intent_path: Path) -> Path:
        return intent_path.with_name(intent_path.name.replace(".intent.json", ".receipt.json"))

    def reconcile(self) -> list[dict[str, Any]]:
        """Reconcile publish-after-rename crashes without replaying bytes."""
        results: list[dict[str, Any]] = []
        staging_root = self.root / ".staging"
        if not staging_root.exists():
            return results
        for intent_path in staging_root.glob("*/*.intent.json"):
            intent = json.loads(intent_path.read_text(encoding="utf-8"))
            final_path = _resolve_contained(self.root, intent["final_path"])
            staging_path = _resolve_contained(self.root, intent["staging_path"])
            receipt_path = self._receipt_path(intent_path)
            if final_path.exists():
                actual_digest, actual_size = sha256_file(final_path)
                if (actual_digest, actual_size) != (intent["sha256"], intent["size_bytes"]):
                    raise ArtifactIntegrityError(
                        f"published artifact verification failed: {intent['final_path']}"
                    )
                if not receipt_path.exists():
                    _durable_json(receipt_path, {**intent, "state": "published"})
                if not self.retain_reconciled:
                    intent_path.unlink(missing_ok=True)
                    staging_path.unlink(missing_ok=True)
                results.append(
                    {
                        "artifact_id": intent["artifact_id"],
                        "job_id": intent["job_id"],
                        "artifact_type": intent.get("artifact_type", "image"),
                        "relative_path": intent["final_path"],
                        "mime_type": intent["mime_type"],
                        "sha256": intent["sha256"],
                        "size_bytes": int(intent["size_bytes"]),
                        "path": str(final_path),
                        "state": "receipt_required",
                    }
                )
            else:
                # A staged file without a final is never replayed or deleted
                # automatically. The facade records a safe cleanup ledger entry
                # while this intent remains available for deliberate recovery.
                results.append(
                    {
                        "artifact_id": intent["artifact_id"],
                        "job_id": intent["job_id"],
                        "artifact_type": intent.get("artifact_type", "image"),
                        "sha256": intent["sha256"],
                        "size_bytes": int(intent["size_bytes"]),
                        "state": "staging_orphan",
                    }
                )
        return results

    def publish_bytes(
        self,
        job_id: str,
        artifact_id: str,
        relative_path: str,
        payload: bytes,
        *,
        mime_type: str,
        artifact_type: str = "image",
    ) -> dict[str, Any]:
        # Resolve every path before creating a directory or opening a file. This is
        # the containment boundary for request-controlled job/artifact identifiers.
        staging_path = _resolve_contained(
            self.root,
            Path(".staging") / job_id / f"{artifact_id}.part",
        )
        intent_path = _resolve_contained(
            self.root,
            Path(".staging") / job_id / f"{artifact_id}.intent.json",
        )
        final_path = _resolve_contained(self.root, relative_path)
        staging_path.parent.mkdir(parents=True, exist_ok=True)

        digest, size = sha256_bytes(payload)
        with staging_path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())

        intent = {
            "artifact_id": artifact_id,
            "job_id": job_id,
            "final_path": final_path.relative_to(self.root).as_posix(),
            "mime_type": mime_type,
            "artifact_type": artifact_type,
            "sha256": digest,
            "size_bytes": size,
            "staging_path": staging_path.relative_to(self.root).as_posix(),
            "state": "ready",
        }
        _durable_json(intent_path, intent)

        final_path.parent.mkdir(parents=True, exist_ok=True)
        if final_path.exists():
            intent_path.unlink(missing_ok=True)
            staging_path.unlink(missing_ok=True)
            raise ArtifactConflictError(f"artifact already exists: {intent['final_path']}")
        try:
            # Hard-linking a fully fsynced staging file makes publication
            # atomic and fails without overwriting an existing destination on
            # both Windows and POSIX filesystems.
            os.link(staging_path, final_path)
            staging_path.unlink(missing_ok=True)
        except FileExistsError as exc:
            intent_path.unlink(missing_ok=True)
            staging_path.unlink(missing_ok=True)
            raise ArtifactConflictError(f"artifact already exists: {intent['final_path']}") from exc

        actual_digest, actual_size = sha256_file(final_path)
        if (actual_digest, actual_size) != (digest, size):
            raise ArtifactIntegrityError(f"published artifact verification failed: {final_path}")

        receipt_path = self._receipt_path(intent_path)
        _durable_json(receipt_path, {**intent, "state": "published"})
        return {
            "artifact_id": artifact_id,
            "job_id": job_id,
            "relative_path": intent["final_path"],
            "mime_type": mime_type,
            "sha256": digest,
            "size_bytes": size,
            "path": str(final_path),
        }

    def acknowledge(self, artifact_id: str, job_id: str) -> None:
        intent_path = self.root / ".staging" / job_id / f"{artifact_id}.intent.json"
        intent_path = _resolve_contained(self.root, intent_path.relative_to(self.root))
        staging_path = self.root / ".staging" / job_id / f"{artifact_id}.part"
        staging_path = _resolve_contained(self.root, staging_path.relative_to(self.root))
        intent_path.unlink(missing_ok=True)
        staging_path.unlink(missing_ok=True)
