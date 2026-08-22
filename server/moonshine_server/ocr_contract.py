"""Reversible OCR component and golden-set contract spike.

This module validates metadata only.  It deliberately does not import an OCR
engine, download weights, mutate EnvironmentManager state, or write user data.
"""

from __future__ import annotations

import re
from typing import Any, Mapping


OCR_COMPONENT_SCHEMA = "ocr-component/v1"
GOLDEN_SET_MANIFEST_VERSION = 1
DEFAULT_ENGINE_ID = "ocr_rapid_onnx_mobile"
SUPPORTED_RUNTIME_FLAVORS = frozenset({"cpu", "cu130"})
HEALTH_STATES = frozenset({"missing", "ready", "incompatible", "integrity_error"})
ENGINE_ID_PATTERN = re.compile(r"^ocr_[a-z0-9]+(?:_[a-z0-9]+)+$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
GOLDEN_SAMPLE_ID_PATTERN = re.compile(r"^OCR-GOLD-[0-9]{3}$")
GOLDEN_RELATIVE_PATH_PATTERN = re.compile(r"^(?![A-Za-z]:[\\/])(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$")
MODEL_RELATIVE_PATH_PATTERN = re.compile(r"^(?![A-Za-z]:[\\/])(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$")
UTC_TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
GOLDEN_SCENARIOS = frozenset({
    "rotated",
    "low_contrast",
    "transparent_background",
    "common_watermark",
    "perspective",
    "dense_text",
    "sparse_text",
})
GOLDEN_ROLES = frozenset({"ORCH", "ARCH", "APP", "SEC", "OCR", "LIFE", "UI", "QA", "REL", "RED", "KNOW"})


class OcrContractError(ValueError):
    """Base error for malformed OCR component or golden-set metadata."""


class OcrManifestError(OcrContractError):
    """Raised when an OCR component manifest is unsafe or incomplete."""


class GoldenSetManifestError(OcrContractError):
    """Raised when golden-set coverage or licensing metadata is incomplete."""


def _required_string(
    value: Any,
    name: str,
    *,
    pattern: re.Pattern[str] | None = None,
    error_type: type[OcrContractError] = OcrContractError,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise error_type(f"{name} must be a non-empty string")
    value = value.strip()
    if pattern is not None and not pattern.fullmatch(value):
        raise error_type(f"{name} has an invalid format")
    return value


def _sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise OcrManifestError(f"{name} must be a lowercase SHA-256")
    return value


def _positive_int(
    value: Any,
    name: str,
    *,
    error_type: type[OcrContractError] = OcrManifestError,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise error_type(f"{name} must be a positive integer")
    return value


def _normalize_model_artifacts(
    value: Any,
    *,
    supports_orientation: bool,
) -> dict[str, dict[str, Any]] | None:
    """Validate an optional multi-file ONNX bundle without touching the filesystem."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise OcrManifestError("artifacts must be an object")
    allowed_roles = {"det", "rec", "cls"}
    if set(value) - allowed_roles:
        raise OcrManifestError("artifacts contains an unsupported role")
    if not {"det", "rec"}.issubset(value):
        raise OcrManifestError("artifacts must include det and rec roles")
    if supports_orientation and "cls" not in value:
        raise OcrManifestError("orientation support requires a cls artifact")
    normalized: dict[str, dict[str, Any]] = {}
    for role, artifact in value.items():
        if not isinstance(artifact, Mapping):
            raise OcrManifestError(f"artifacts.{role} must be an object")
        relative_path = _required_string(
            artifact.get("path"),
            f"artifacts.{role}.path",
            pattern=MODEL_RELATIVE_PATH_PATTERN,
            error_type=OcrManifestError,
        ).replace("\\", "/")
        if any(part in {"", ".", ".."} for part in relative_path.split("/")):
            raise OcrManifestError(f"artifacts.{role}.path must be a normalized relative path")
        normalized[role] = {
            "path": relative_path,
            "sha256": _sha256(artifact.get("sha256"), f"artifacts.{role}.sha256"),
            "size_bytes": _positive_int(artifact.get("size_bytes"), f"artifacts.{role}.size_bytes"),
        }
    return normalized


def validate_component_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Return a normalized copy of a signed OCR component manifest candidate."""
    if not isinstance(manifest, Mapping):
        raise OcrManifestError("component manifest must be an object")
    if manifest.get("schema_version") != OCR_COMPONENT_SCHEMA:
        raise OcrManifestError(f"schema_version must be {OCR_COMPONENT_SCHEMA}")
    engine_id = _required_string(
        manifest.get("engine_id"), "engine_id", pattern=ENGINE_ID_PATTERN, error_type=OcrManifestError
    )
    engine_version = _required_string(manifest.get("engine_version"), "engine_version", error_type=OcrManifestError)
    model_revision = _required_string(manifest.get("model_revision"), "model_revision", error_type=OcrManifestError)
    model_sha256 = _sha256(manifest.get("model_sha256"), "model_sha256")
    size_bytes = _positive_int(manifest.get("size_bytes"), "size_bytes")
    license_id = _required_string(manifest.get("license_id"), "license_id", error_type=OcrManifestError)
    languages = manifest.get("languages")
    if not isinstance(languages, list) or not languages or any(not isinstance(item, str) or not item.strip() for item in languages):
        raise OcrManifestError("languages must be a non-empty string list")
    if len(set(languages)) != len(languages):
        raise OcrManifestError("languages must be unique")
    runtime_flavor = _required_string(manifest.get("runtime_flavor"), "runtime_flavor", error_type=OcrManifestError)
    if runtime_flavor not in SUPPORTED_RUNTIME_FLAVORS:
        raise OcrManifestError("runtime_flavor is unsupported")
    supports_gpu = manifest.get("supports_gpu")
    supports_orientation = manifest.get("supports_orientation")
    default = manifest.get("default")
    if not isinstance(supports_gpu, bool) or not isinstance(supports_orientation, bool) or not isinstance(default, bool):
        raise OcrManifestError("supports_gpu, supports_orientation and default must be booleans")
    memory_limit_mb = _positive_int(manifest.get("memory_limit_mb"), "memory_limit_mb")
    source_kind = _required_string(manifest.get("source_kind"), "source_kind", error_type=OcrManifestError)
    if source_kind not in {"signed_manifest", "offline_bundle", "local_development"}:
        raise OcrManifestError("source_kind is unsupported")
    if default and engine_id == DEFAULT_ENGINE_ID and (runtime_flavor != "cpu" or supports_gpu):
        raise OcrManifestError("default RapidOCR component must be CPU-only")
    if default and engine_id == DEFAULT_ENGINE_ID and source_kind not in {"signed_manifest", "offline_bundle"}:
        raise OcrManifestError("default RapidOCR component must use a signed or offline manifest")
    artifacts = _normalize_model_artifacts(manifest.get("artifacts"), supports_orientation=supports_orientation)
    return {
        "schema_version": OCR_COMPONENT_SCHEMA,
        "engine_id": engine_id,
        "engine_version": engine_version,
        "model_revision": model_revision,
        "model_sha256": model_sha256,
        "size_bytes": size_bytes,
        "license_id": license_id,
        "languages": list(languages),
        "runtime_flavor": runtime_flavor,
        "supports_gpu": supports_gpu,
        "supports_orientation": supports_orientation,
        "memory_limit_mb": memory_limit_mb,
        "source_kind": source_kind,
        "default": default,
        "artifacts": artifacts,
    }


def evaluate_component_health(
    manifest: Mapping[str, Any],
    *,
    installed_sha256: str | None = None,
    installed_size_bytes: int | None = None,
    runtime_flavor: str = "cpu",
) -> dict[str, Any]:
    """Project install metadata into a safe, non-downloading capability state."""
    normalized = validate_component_manifest(manifest)
    if installed_sha256 is None or installed_size_bytes is None:
        return {"engine_id": normalized["engine_id"], "status": "missing", "enabled": False}
    if installed_sha256 != normalized["model_sha256"] or installed_size_bytes != normalized["size_bytes"]:
        return {"engine_id": normalized["engine_id"], "status": "integrity_error", "enabled": False}
    if runtime_flavor != normalized["runtime_flavor"]:
        return {"engine_id": normalized["engine_id"], "status": "incompatible", "enabled": False}
    return {
        "engine_id": normalized["engine_id"],
        "status": "ready",
        "enabled": True,
        "languages": normalized["languages"],
        "supports_orientation": normalized["supports_orientation"],
    }


def validate_golden_set_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Validate coverage and license gates without requiring sample bytes."""
    if not isinstance(manifest, Mapping) or manifest.get("manifest_version") != GOLDEN_SET_MANIFEST_VERSION:
        raise GoldenSetManifestError("manifest_version must be 1")
    status = manifest.get("status")
    if status not in {"planned", "in_progress", "ready"}:
        raise GoldenSetManifestError("status must be planned, in_progress or ready")
    required = _positive_int(
        manifest.get("required_sample_count"),
        "required_sample_count",
        error_type=GoldenSetManifestError,
    )
    if required < 30:
        raise GoldenSetManifestError("required_sample_count must be at least 30")
    target = _positive_int(
        manifest.get("target_sample_count"),
        "target_sample_count",
        error_type=GoldenSetManifestError,
    )
    if target < 30 or target > 50:
        raise GoldenSetManifestError("target_sample_count must be between 30 and 50")
    if target < required:
        raise GoldenSetManifestError("target_sample_count must be >= required_sample_count")
    _required_string(
        manifest.get("updated_at"),
        "updated_at",
        pattern=UTC_TIMESTAMP_PATTERN,
        error_type=GoldenSetManifestError,
    )
    coverage = manifest.get("coverage")
    if not isinstance(coverage, Mapping):
        raise GoldenSetManifestError("coverage is required")
    for key in ("languages", "scenarios"):
        values = coverage.get(key)
        if not isinstance(values, list) or not values or any(not isinstance(item, str) or not item.strip() for item in values):
            raise GoldenSetManifestError(f"coverage.{key} must be a non-empty string list")
        if len(set(values)) != len(values):
            raise GoldenSetManifestError(f"coverage.{key} must be unique")
    if any(value not in GOLDEN_SCENARIOS for value in coverage["scenarios"]):
        raise GoldenSetManifestError("coverage.scenarios contains an unsupported scenario")
    samples = manifest.get("samples")
    if not isinstance(samples, list):
        raise GoldenSetManifestError("samples must be a list")
    sample_ids: set[str] = set()
    sample_paths: set[str] = set()
    license_gate = manifest.get("license_gate")
    if not isinstance(license_gate, Mapping):
        raise GoldenSetManifestError("license_gate is required")
    owner = _required_string(license_gate.get("owner"), "license_gate.owner", error_type=GoldenSetManifestError)
    if owner not in GOLDEN_ROLES:
        raise GoldenSetManifestError("license_gate.owner is not a governance role")
    _required_string(license_gate.get("rule"), "license_gate.rule", error_type=GoldenSetManifestError)
    for sample in samples:
        if not isinstance(sample, Mapping):
            raise GoldenSetManifestError("each sample must be an object")
        sample_id = _required_string(
            sample.get("sample_id"),
            "sample.sample_id",
            pattern=GOLDEN_SAMPLE_ID_PATTERN,
            error_type=GoldenSetManifestError,
        )
        relative_path = _required_string(
            sample.get("relative_path"),
            "sample.relative_path",
            pattern=GOLDEN_RELATIVE_PATH_PATTERN,
            error_type=GoldenSetManifestError,
        )
        if sample_id in sample_ids:
            raise GoldenSetManifestError("sample.sample_id must be unique")
        if relative_path in sample_paths:
            raise GoldenSetManifestError("sample.relative_path must be unique")
        sample_ids.add(sample_id)
        sample_paths.add(relative_path)
        sample_sha256 = sample.get("sha256")
        if not isinstance(sample_sha256, str) or not SHA256_PATTERN.fullmatch(sample_sha256):
            raise GoldenSetManifestError("sample.sha256 must be a lowercase SHA-256")
        _required_string(sample.get("source"), "sample.source", error_type=GoldenSetManifestError)
        _required_string(sample.get("license"), "sample.license", error_type=GoldenSetManifestError)
        if sample.get("redistribution") not in {"allowed", "internal_only", "prohibited"}:
            raise GoldenSetManifestError("sample.redistribution is unsupported")
        _required_string(sample.get("language"), "sample.language", error_type=GoldenSetManifestError)
        scenarios = sample.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios or any(item not in GOLDEN_SCENARIOS for item in scenarios):
            raise GoldenSetManifestError("sample.scenarios must contain supported scenarios")
        if len(set(scenarios)) != len(scenarios):
            raise GoldenSetManifestError("sample.scenarios must be unique")
        if sample.get("expected_detection") not in {"exact", "tolerant", "qualitative"}:
            raise GoldenSetManifestError("sample.expected_detection is unsupported")
        if sample.get("expected_recognition") not in {"exact", "normalized", "qualitative"}:
            raise GoldenSetManifestError("sample.expected_recognition is unsupported")
        if sample.get("expected_coordinates") not in {"polygon_exact", "polygon_tolerant", "bbox_only"}:
            raise GoldenSetManifestError("sample.expected_coordinates is unsupported")
    if status == "ready" and len(samples) < required:
        raise GoldenSetManifestError("ready golden set does not meet required sample count")
    return {"status": status, "required_sample_count": required, "target_sample_count": target, "sample_count": len(samples)}


__all__ = [
    "DEFAULT_ENGINE_ID",
    "GOLDEN_SET_MANIFEST_VERSION",
    "GoldenSetManifestError",
    "HEALTH_STATES",
    "OCR_COMPONENT_SCHEMA",
    "OcrContractError",
    "OcrManifestError",
    "evaluate_component_health",
    "validate_component_manifest",
    "validate_golden_set_manifest",
]
