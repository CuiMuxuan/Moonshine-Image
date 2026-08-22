"""Reversible mask operation and provenance contract spike.

This module deliberately stays in-memory.  It defines the smallest stable
contract needed by the future mask application service: versioned operations,
pixel/normalized coordinates, deterministic replay, and a sidecar that binds
the resulting mask to its source and provenance.  It does not read or write
image files and it never publishes an artifact.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from typing import Any, Mapping, Sequence


OPERATION_LOG_VERSION = "mask-operation-log/v1"
SIDECAR_VERSION = "mask-sidecar/v1"
MASK_HASH_VERSION = b"moonshine-mask/v1\0"
COORDINATE_SPACES = frozenset({"pixels", "normalized"})
STAGING_STATES = frozenset({"pending", "writing", "complete", "cancelled", "failed"})
PROVENANCE_PRODUCERS = frozenset({"ui", "mcp", "sam", "ocr", "batch", "legacy_adapter"})


class MaskProvenanceError(ValueError):
    """Base error for malformed or unsafe mask contracts."""


class InvalidOperationError(MaskProvenanceError):
    """Raised when an operation log cannot be replayed safely."""


class InvalidCoordinateError(InvalidOperationError):
    """Raised for missing, non-finite, non-integral, or out-of-bounds points."""


class UnsafePublishTargetError(MaskProvenanceError):
    """Raised when a proposed output path would overwrite its source."""


class IncompleteStagingError(MaskProvenanceError):
    """Raised when a partially written/cancelled staging artifact is used."""


def _canonical_json(value: Any) -> bytes:
    """Return canonical JSON bytes for stable hashes and sidecars."""
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise MaskProvenanceError("value is not canonical-json serializable") from exc


def _require_dimension(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise MaskProvenanceError(f"{name} must be a positive integer")
    return value


def _require_sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise MaskProvenanceError(f"{name} must be a lowercase SHA-256")
    if any(character not in "0123456789abcdef" for character in value):
        raise MaskProvenanceError(f"{name} must be a lowercase SHA-256")
    return value


def _require_operations(log: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if not isinstance(log, Mapping) or log.get("schema_version") != OPERATION_LOG_VERSION:
        raise InvalidOperationError(f"schema_version must be {OPERATION_LOG_VERSION}")
    operations = log.get("operations")
    if not isinstance(operations, list):
        raise InvalidOperationError("operations must be a list")
    return operations


def _coordinate_space(operation: Mapping[str, Any]) -> str:
    if "coordinate_space" not in operation:
        raise InvalidOperationError("coordinate_space is required")
    space = operation.get("coordinate_space")
    if not isinstance(space, str) or space not in COORDINATE_SPACES:
        raise InvalidOperationError("coordinate_space must be pixels or normalized")
    return space


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidCoordinateError(f"{name} must be a number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise InvalidCoordinateError(f"{name} must be finite") from exc
    if not math.isfinite(number):
        raise InvalidCoordinateError(f"{name} must be finite")
    return number


def _point(value: Any, width: int, height: int, space: str) -> tuple[int, int]:
    if isinstance(value, Mapping):
        raw_x, raw_y = value.get("x"), value.get("y")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)) and len(value) == 2:
        raw_x, raw_y = value
    else:
        raise InvalidCoordinateError("point must contain x and y")

    x, y = _number(raw_x, "x"), _number(raw_y, "y")
    if space == "pixels":
        if not x.is_integer() or not y.is_integer():
            raise InvalidCoordinateError("pixel coordinates must be integers")
        pixel_x, pixel_y = int(x), int(y)
    else:
        if not 0.0 <= x <= 1.0 or not 0.0 <= y <= 1.0:
            raise InvalidCoordinateError("normalized coordinates must be in [0, 1]")
        # Round-half-up avoids Python's banker's rounding and is stable across
        # runtimes.  1.0 maps exactly to the last pixel.
        pixel_x = math.floor(x * (width - 1) + 0.5)
        pixel_y = math.floor(y * (height - 1) + 0.5)

    if not 0 <= pixel_x < width or not 0 <= pixel_y < height:
        raise InvalidCoordinateError("point is outside the mask bounds")
    return pixel_x, pixel_y


def pixel_to_normalized(x: int, y: int, width: int, height: int) -> dict[str, float]:
    """Convert a valid pixel point to the source-image normalized space."""
    width, height = _require_dimension(width, "width"), _require_dimension(height, "height")
    point = _point({"x": x, "y": y}, width, height, "pixels")
    return {
        "x": point[0] / (width - 1) if width > 1 else 0.0,
        "y": point[1] / (height - 1) if height > 1 else 0.0,
    }


def normalized_to_pixel(x: float, y: float, width: int, height: int) -> dict[str, int]:
    """Convert a valid normalized point to a deterministic pixel point."""
    width, height = _require_dimension(width, "width"), _require_dimension(height, "height")
    pixel = _point({"x": x, "y": y}, width, height, "normalized")
    return {"x": pixel[0], "y": pixel[1]}


def new_operation_log(width: int, height: int, *, base_mask: bytes | bytearray | None = None) -> dict[str, Any]:
    """Create an empty versioned operation log for a fixed mask size."""
    width, height = _require_dimension(width, "width"), _require_dimension(height, "height")
    result: dict[str, Any] = {
        "schema_version": OPERATION_LOG_VERSION,
        "width": width,
        "height": height,
        "operations": [],
    }
    if base_mask is not None:
        _validate_mask(base_mask, width, height)
        result["base_mask_sha256"] = compute_mask_hash(width, height, base_mask)
    return result


def append_operation(log: Mapping[str, Any], operation: Mapping[str, Any]) -> dict[str, Any]:
    """Return a copied log with one validated, contiguous operation appended."""
    operations = _require_operations(log)
    validate_operation_log(log)
    width, height = _require_dimension(log.get("width"), "width"), _require_dimension(log.get("height"), "height")
    if not isinstance(operation, Mapping):
        raise InvalidOperationError("operation must be an object")
    op = dict(operation)
    op_id = op.get("op_id")
    if not isinstance(op_id, str) or not op_id.strip():
        raise InvalidOperationError("operation op_id is required")
    for existing in operations:
        if not isinstance(existing, Mapping):
            raise InvalidOperationError("each operation must be an object")
        if existing.get("op_id") == op_id:
            raise InvalidOperationError("operation op_id must be unique")
    expected_sequence = len(operations)
    sequence = op.get("sequence", expected_sequence)
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence != expected_sequence:
        raise InvalidOperationError("operation sequence must be contiguous")
    op["sequence"] = expected_sequence
    _validate_operation(op, width, height)
    updated = dict(log)
    updated["operations"] = [*operations, op]
    return updated


def validate_operation_log(log: Mapping[str, Any]) -> None:
    """Validate a complete operation log without mutating it."""
    operations = _require_operations(log)
    width, height = _require_dimension(log.get("width"), "width"), _require_dimension(log.get("height"), "height")
    if "base_mask_sha256" in log:
        _require_sha256(log["base_mask_sha256"], "base_mask_sha256")
    seen: set[str] = set()
    for sequence, operation in enumerate(operations):
        if not isinstance(operation, Mapping):
            raise InvalidOperationError("each operation must be an object")
        actual_sequence = operation.get("sequence")
        if isinstance(actual_sequence, bool) or not isinstance(actual_sequence, int) or actual_sequence != sequence:
            raise InvalidOperationError("operation sequence must be contiguous")
        op_id = operation.get("op_id")
        if not isinstance(op_id, str) or not op_id.strip() or op_id in seen:
            raise InvalidOperationError("operation op_id must be unique and non-empty")
        seen.add(op_id)
        _validate_operation(operation, width, height)


def _validate_operation(operation: Mapping[str, Any], width: int, height: int) -> None:
    kind = operation.get("kind")
    if not isinstance(kind, str) or kind not in {"paint", "erase", "rectangle", "polygon", "clear", "invert"}:
        raise InvalidOperationError("unsupported operation kind")
    if kind in {"clear", "invert"}:
        return
    space = _coordinate_space(operation)
    if kind in {"paint", "erase"}:
        points = operation.get("points")
        if not isinstance(points, list) or not points:
            raise InvalidOperationError("paint/erase requires a non-empty points list")
        for point in points:
            _point(point, width, height, space)
        return
    points = operation.get("points")
    if kind == "rectangle":
        if not isinstance(points, list) or len(points) != 2:
            raise InvalidOperationError("rectangle requires exactly two points")
    elif not isinstance(points, list) or len(points) < 3:
        raise InvalidOperationError("polygon requires at least three points")
    for point in points:
        _point(point, width, height, space)


def _validate_mask(mask: bytes | bytearray, width: int, height: int) -> bytes:
    if not isinstance(mask, (bytes, bytearray)) or len(mask) != width * height:
        raise MaskProvenanceError("mask must be width*height bytes")
    if any(value not in (0, 255) for value in mask):
        raise MaskProvenanceError("mask must use binary values 0 or 255")
    return bytes(mask)


def _fill_rectangle(mask: bytearray, width: int, height: int, first: tuple[int, int], second: tuple[int, int], value: int) -> None:
    left, right = sorted((first[0], second[0]))
    top, bottom = sorted((first[1], second[1]))
    for y in range(top, bottom + 1):
        row = y * width
        for x in range(left, right + 1):
            mask[row + x] = value


def _polygon_contains(x: float, y: float, points: Sequence[tuple[int, int]]) -> bool:
    inside = False
    previous_x, previous_y = points[-1]
    for current_x, current_y in points:
        if ((current_y > y) != (previous_y > y)) and (
            x < (previous_x - current_x) * (y - current_y) / (previous_y - current_y) + current_x
        ):
            inside = not inside
        previous_x, previous_y = current_x, current_y
    return inside


def _fill_polygon(mask: bytearray, width: int, height: int, points: Sequence[tuple[int, int]], value: int) -> None:
    min_x = max(0, min(point[0] for point in points))
    max_x = min(width - 1, max(point[0] for point in points))
    min_y = max(0, min(point[1] for point in points))
    max_y = min(height - 1, max(point[1] for point in points))
    for y in range(min_y, max_y + 1):
        for x in range(min_x, max_x + 1):
            # Sampling at pixel centers gives deterministic rasterization.
            if _polygon_contains(x + 0.5, y + 0.5, points):
                mask[y * width + x] = value


def replay_mask(
    log: Mapping[str, Any],
    *,
    initial_mask: bytes | bytearray | None = None,
    staging_state: str = "complete",
) -> bytes:
    """Replay a validated operation log into a binary row-major mask.

    ``staging_state`` is part of the safety boundary: a cancelled or partially
    written job cannot be treated as a completed mask merely because replay is
    deterministic.
    """
    validate_staging_state(staging_state)
    if staging_state != "complete":
        raise IncompleteStagingError("mask replay requires complete staging")
    validate_operation_log(log)
    width, height = int(log["width"]), int(log["height"])
    if initial_mask is None:
        if log.get("base_mask_sha256") is not None:
            raise InvalidOperationError("initial mask is required when base_mask_sha256 is present")
        mask = bytearray(width * height)
    else:
        mask = bytearray(_validate_mask(initial_mask, width, height))
        expected = log.get("base_mask_sha256")
        if expected is not None and compute_mask_hash(width, height, mask) != expected:
            raise InvalidOperationError("initial mask does not match base_mask_sha256")

    for operation in log["operations"]:
        kind = operation["kind"]
        if kind == "clear":
            mask[:] = b"\x00" * len(mask)
            continue
        if kind == "invert":
            for index, value in enumerate(mask):
                mask[index] = 0 if value else 255
            continue
        space = _coordinate_space(operation)
        points = [_point(point, width, height, space) for point in operation["points"]]
        value = 255 if kind in {"paint", "rectangle", "polygon"} else 0
        if kind in {"paint", "erase"}:
            for x, y in points:
                mask[y * width + x] = value
        elif kind == "rectangle":
            _fill_rectangle(mask, width, height, points[0], points[1], value)
        else:
            _fill_polygon(mask, width, height, points, value)
    return bytes(mask)


def compute_mask_hash(width: int, height: int, mask: bytes | bytearray) -> str:
    """Hash dimensions and binary pixels with an explicit algorithm version."""
    width, height = _require_dimension(width, "width"), _require_dimension(height, "height")
    pixels = _validate_mask(mask, width, height)
    digest = hashlib.sha256()
    digest.update(MASK_HASH_VERSION)
    digest.update(width.to_bytes(8, "big", signed=False))
    digest.update(height.to_bytes(8, "big", signed=False))
    digest.update(pixels)
    return digest.hexdigest()


def replay_hash(log: Mapping[str, Any], *, initial_mask: bytes | bytearray | None = None) -> str:
    """Replay and hash a mask, binding the deterministic result to the log."""
    mask = replay_mask(log, initial_mask=initial_mask)
    return compute_mask_hash(int(log["width"]), int(log["height"]), mask)


def build_sidecar(
    *,
    sidecar_id: str,
    source_image_sha256: str,
    width: int,
    height: int,
    operation_log: Mapping[str, Any],
    provenance: Mapping[str, Any],
    initial_mask: bytes | bytearray | None = None,
    source_orientation: int = 1,
    job_id: str | None = None,
    artifact_id: str | None = None,
) -> dict[str, Any]:
    """Build a JSON-safe provenance sidecar from the replayed mask."""
    if not isinstance(sidecar_id, str) or not sidecar_id.strip():
        raise MaskProvenanceError("sidecar_id is required")
    _require_sha256(source_image_sha256, "source_image_sha256")
    width, height = _require_dimension(width, "width"), _require_dimension(height, "height")
    if isinstance(source_orientation, bool) or not isinstance(source_orientation, int) or source_orientation not in range(1, 9):
        raise MaskProvenanceError("source_orientation must be an EXIF orientation from 1 to 8")
    if not isinstance(provenance, Mapping) or not provenance:
        raise MaskProvenanceError("provenance must be a non-empty object")
    if not isinstance(provenance.get("producer"), str) or provenance.get("producer") not in PROVENANCE_PRODUCERS:
        raise MaskProvenanceError("provenance producer must match core-v2")
    validate_operation_log(operation_log)
    if int(operation_log["width"]) != width or int(operation_log["height"]) != height:
        raise MaskProvenanceError("operation log dimensions must match sidecar dimensions")
    mask = replay_mask(operation_log, initial_mask=initial_mask)
    sidecar: dict[str, Any] = {
        "schema_version": SIDECAR_VERSION,
        "sidecar_id": sidecar_id,
        "source_image_sha256": source_image_sha256,
        "coordinate_space": "source_pixels",
        "source_orientation": source_orientation,
        "width": width,
        "height": height,
        "mask": {
            "encoding": "binary_u8_row_major",
            "width": width,
            "height": height,
            "sha256": compute_mask_hash(width, height, mask),
        },
        "provenance": json.loads(_canonical_json(dict(provenance))),
        "operation_log": json.loads(_canonical_json(dict(operation_log))),
        "replay": {"deterministic": True, "hash_algorithm": "moonshine-mask/v1"},
    }
    if job_id is not None:
        sidecar["job_id"] = job_id
    if artifact_id is not None:
        sidecar["artifact_id"] = artifact_id
    return sidecar


def validate_staging_state(state: str) -> None:
    if not isinstance(state, str) or state not in STAGING_STATES:
        raise IncompleteStagingError("unknown staging state")


def validate_publish_target(source_path: str | os.PathLike[str], output_path: str | os.PathLike[str], staging_state: str) -> None:
    """Reject source overwrite or incomplete staging before future publication."""
    validate_staging_state(staging_state)
    if staging_state != "complete":
        raise IncompleteStagingError("only complete staging may be published")
    source = os.path.normcase(os.path.realpath(os.fspath(source_path)))
    output = os.path.normcase(os.path.realpath(os.fspath(output_path)))
    same_file = False
    try:
        same_file = os.path.samefile(source_path, output_path)
    except (FileNotFoundError, OSError, ValueError):
        pass
    if source == output or same_file:
        raise UnsafePublishTargetError("mask output must not overwrite source image")


__all__ = [
    "COORDINATE_SPACES",
    "IncompleteStagingError",
    "InvalidCoordinateError",
    "InvalidOperationError",
    "MaskProvenanceError",
    "OPERATION_LOG_VERSION",
    "PROVENANCE_PRODUCERS",
    "SIDECAR_VERSION",
    "UnsafePublishTargetError",
    "append_operation",
    "build_sidecar",
    "compute_mask_hash",
    "new_operation_log",
    "normalized_to_pixel",
    "pixel_to_normalized",
    "replay_hash",
    "replay_mask",
    "validate_operation_log",
    "validate_publish_target",
    "validate_staging_state",
]
