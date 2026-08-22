from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path


class ArtifactIntegrityError(RuntimeError):
    pass


def sha256_file(file_path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _durable_json(file_path: Path, value: dict[str, object]) -> None:
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


def _load_json(file_path: Path) -> dict[str, object]:
    return json.loads(file_path.read_text(encoding="utf-8"))


def _relative(root: Path, file_path: Path) -> str:
    return file_path.resolve().relative_to(root.resolve()).as_posix()


def _resolve(root: Path, relative_path: object) -> Path:
    candidate = (root / str(relative_path)).resolve()
    candidate.relative_to(root.resolve())
    return candidate


def stage_artifact(
    root: Path,
    job_id: str,
    artifact_id: str,
    final_relative_path: str,
    payload: bytes,
    *,
    chunk_size: int = 64 * 1024,
    chunk_delay_seconds: float = 0.0,
) -> Path:
    staging_path = _resolve(
        root,
        Path(".staging") / job_id / f"{artifact_id}.part",
    )
    intent_path = _resolve(
        root,
        Path(".staging") / job_id / f"{artifact_id}.intent.json",
    )
    final_path = _resolve(root, final_relative_path)
    staging_directory = staging_path.parent
    staging_directory.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256()
    written = 0
    with staging_path.open("xb") as handle:
        for offset in range(0, len(payload), chunk_size):
            chunk = payload[offset : offset + chunk_size]
            handle.write(chunk)
            handle.flush()
            digest.update(chunk)
            written += len(chunk)
            if chunk_delay_seconds:
                time.sleep(chunk_delay_seconds)
        os.fsync(handle.fileno())

    _durable_json(
        intent_path,
        {
            "artifact_id": artifact_id,
            "final_path": _relative(root, final_path),
            "job_id": job_id,
            "sha256": digest.hexdigest(),
            "size_bytes": written,
            "staging_path": _relative(root, staging_path),
            "state": "ready",
        },
    )
    return intent_path


def _receipt_path(intent_path: Path) -> Path:
    return intent_path.with_name(intent_path.name.replace(".intent.json", ".receipt.json"))


def _verify(file_path: Path, intent: dict[str, object]) -> None:
    digest, size = sha256_file(file_path)
    if digest != intent["sha256"] or size != intent["size_bytes"]:
        raise ArtifactIntegrityError(
            f"artifact verification failed for {file_path}: {digest}/{size}"
        )


def publish_artifact(
    root: Path,
    intent_path: Path,
    *,
    crash_after_rename: bool = False,
) -> dict[str, object]:
    intent = _load_json(intent_path)
    staging_path = _resolve(root, intent["staging_path"])
    final_path = _resolve(root, intent["final_path"])
    receipt_path = _receipt_path(intent_path)

    _verify(staging_path, intent)
    final_path.parent.mkdir(parents=True, exist_ok=True)
    if final_path.exists():
        return {"status": "conflict_existing", "final_path": final_path}

    try:
        os.rename(staging_path, final_path)
    except FileExistsError:
        return {"status": "conflict_existing", "final_path": final_path}

    if crash_after_rename:
        os._exit(92)

    _durable_json(
        receipt_path,
        {
            "artifact_id": intent["artifact_id"],
            "final_path": intent["final_path"],
            "sha256": intent["sha256"],
            "size_bytes": intent["size_bytes"],
            "state": "published",
        },
    )
    return {"status": "published", "final_path": final_path}


def scan_reconciliation(root: Path) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    referenced_staging: set[Path] = set()
    staging_root = root / ".staging"
    for intent_path in sorted(staging_root.rglob("*.intent.json")):
        intent = _load_json(intent_path)
        staging_path = _resolve(root, intent["staging_path"])
        final_path = _resolve(root, intent["final_path"])
        receipt_path = _receipt_path(intent_path)
        referenced_staging.add(staging_path)
        record: dict[str, object] = {
            "artifact_id": intent["artifact_id"],
            "automatic_republish": False,
            "intent_path": intent_path,
        }
        if receipt_path.exists():
            receipt = _load_json(receipt_path)
            if receipt["state"] == "published":
                if not final_path.exists():
                    record["status"] = "missing_final"
                else:
                    try:
                        _verify(final_path, intent)
                        record["status"] = "published"
                    except ArtifactIntegrityError:
                        record["status"] = "integrity_conflict"
            else:
                record["status"] = receipt["state"]
        elif final_path.exists():
            try:
                _verify(final_path, intent)
                record["status"] = "receipt_required"
            except ArtifactIntegrityError:
                record["status"] = "integrity_conflict"
        elif staging_path.exists():
            try:
                _verify(staging_path, intent)
                record["status"] = "staging_orphan"
            except ArtifactIntegrityError:
                record["status"] = "staging_corrupt"
        else:
            record["status"] = "missing_artifact"
        results.append(record)

    for part_path in sorted(staging_root.rglob("*.part")):
        if part_path not in referenced_staging:
            results.append(
                {
                    "artifact_id": part_path.stem,
                    "automatic_republish": False,
                    "part_path": part_path,
                    "status": "unregistered_part",
                }
            )
    return results


def reconcile_receipt(root: Path, intent_path: Path) -> str:
    intent = _load_json(intent_path)
    final_path = _resolve(root, intent["final_path"])
    receipt_path = _receipt_path(intent_path)
    if receipt_path.exists():
        return str(_load_json(receipt_path)["state"])
    _verify(final_path, intent)
    _durable_json(
        receipt_path,
        {
            "artifact_id": intent["artifact_id"],
            "final_path": intent["final_path"],
            "sha256": intent["sha256"],
            "size_bytes": intent["size_bytes"],
            "state": "published",
        },
    )
    return "published"


def cleanup_staging_orphan(root: Path, intent_path: Path) -> str:
    intent = _load_json(intent_path)
    staging_path = _resolve(root, intent["staging_path"])
    final_path = _resolve(root, intent["final_path"])
    receipt_path = _receipt_path(intent_path)
    if receipt_path.exists():
        return str(_load_json(receipt_path)["state"])
    if final_path.exists():
        return "final_exists"
    staging_path.unlink(missing_ok=True)
    _durable_json(
        receipt_path,
        {
            "artifact_id": intent["artifact_id"],
            "final_path": intent["final_path"],
            "sha256": intent["sha256"],
            "size_bytes": intent["size_bytes"],
            "state": "cleaned",
        },
    )
    return "cleaned"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["crash-before-publish", "crash-after-rename", "slow-publish"])
    parser.add_argument("root", type=Path)
    parser.add_argument("size", type=int)
    args = parser.parse_args()

    payload = b"x" * args.size
    intent_path = stage_artifact(
        args.root,
        "worker-job",
        "worker-artifact",
        "artifacts/output.bin",
        payload,
        chunk_size=16 * 1024,
        chunk_delay_seconds=0.01 if args.command == "slow-publish" else 0.0,
    )
    if args.command == "crash-before-publish":
        os._exit(91)
    publish_artifact(
        args.root,
        intent_path,
        crash_after_rename=args.command == "crash-after-rename",
    )


if __name__ == "__main__":
    main()
