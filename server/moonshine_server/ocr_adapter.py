"""Bounded, non-downloading RapidOCR adapter.

The adapter deliberately owns no installation, download, model-registry, IPC,
or user-data behaviour.  A caller must provide a validated
``ocr-component/v1`` manifest and the exact local artifact path or bundle root
that the manifest describes. Runtime loading happens only when recognition is
requested, so probing the component cannot cause a model download.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import math
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .ocr_contract import DEFAULT_ENGINE_ID, OcrManifestError, validate_component_manifest


MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16_384
MAX_IMAGE_PIXELS = 64 * 1024 * 1024
MAX_REGION_COUNT = 128
MAX_TEXT_LENGTH = 4_096
MAX_COORDINATE = float(MAX_IMAGE_DIMENSION)
HEALTH_STATES = frozenset({"missing", "integrity_error", "incompatible", "ready"})

RAPIDOCR_DEFAULT_ARTIFACTS = {
    "det": {
        "path": "PP-OCRv6_det_small.onnx",
        "sha256": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
        "size_bytes": 9_929_594,
    },
    "rec": {
        "path": "PP-OCRv6_rec_small.onnx",
        "sha256": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
        "size_bytes": 21_234_383,
    },
    "cls": {
        "path": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "sha256": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
        "size_bytes": 585_532,
    },
}


def _default_model_root() -> Path | None:
    candidates = []
    configured = os.environ.get("MOONSHINE_OCR_MODEL_ROOT", "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.extend(
        [
            Path.cwd() / "models" / "ocr",
            Path(__file__).resolve().parents[2] / "models" / "ocr",
        ]
    )
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_dir():
            return resolved
    return None


def build_local_rapidocr_adapter(model_root: str | os.PathLike[str] | None = None) -> "RapidOcrAdapter" | None:
    """Build a local-development adapter when the verified model bundle exists."""
    root = Path(model_root).expanduser().resolve() if model_root is not None else _default_model_root()
    if root is None:
        return None
    det = RAPIDOCR_DEFAULT_ARTIFACTS["det"]
    manifest = {
        "schema_version": "ocr-component/v1",
        "engine_id": DEFAULT_ENGINE_ID,
        "engine_version": "3.9.2",
        "model_revision": "PP-OCRv6-small-bundled",
        "model_sha256": det["sha256"],
        "size_bytes": det["size_bytes"],
        "license_id": "Apache-2.0",
        "languages": ["zh-Hans", "en"],
        "runtime_flavor": "cpu",
        "supports_gpu": False,
        "supports_orientation": True,
        "memory_limit_mb": 1024,
        "source_kind": "local_development",
        "default": False,
        "artifacts": RAPIDOCR_DEFAULT_ARTIFACTS,
    }
    return RapidOcrAdapter(manifest, root)


class OcrAdapterError(RuntimeError):
    """Base error for the in-memory OCR adapter boundary."""


class OcrAdapterUnavailableError(OcrAdapterError):
    """Raised when the signed local component cannot be used."""


class OcrAdapterInputError(OcrAdapterError):
    """Raised for unsupported or unbounded in-memory OCR input."""


class OcrAdapterResultError(OcrAdapterError):
    """Raised when a runtime returns a result outside the adapter contract."""


class OcrAdapterRuntimeError(OcrAdapterError):
    """Raised when the runtime cannot be initialized or invoked safely."""


def _positive_limit(value: Any, name: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > maximum:
        raise ValueError(f"{name} must be a positive integer no greater than {maximum}")
    return value


def _finite_number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OcrAdapterResultError("OCR runtime returned invalid polygon coordinates")
    number = float(value)
    if not math.isfinite(number):
        raise OcrAdapterResultError("OCR runtime returned invalid polygon coordinates")
    return number


def _is_sequence(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray, memoryview))


class RapidOcrAdapter:
    """A local-only RapidOCR adapter with a deliberately narrow contract.

    ``runtime_factory`` is intended for dependency injection and receives the
    explicit ``Path`` of the verified artifact or bundle root. Without it, a
    multi-file manifest uses the official ``rapidocr`` API with explicit
    det/rec/cls paths. Legacy single-file manifests retain the old
    ``rapidocr_onnxruntime`` adapter path for compatibility.
    """

    def __init__(
        self,
        manifest: Mapping[str, Any],
        model_artifact_path: str | os.PathLike[str] | None = None,
        *,
        runtime_flavor: str = "cpu",
        runtime_factory: Callable[[Path], Any] | None = None,
        runtime: Any | None = None,
        model_path: str | os.PathLike[str] | None = None,
        max_regions: int = MAX_REGION_COUNT,
        max_text_length: int = MAX_TEXT_LENGTH,
    ) -> None:
        if model_artifact_path is not None and model_path is not None:
            raise ValueError("provide only one explicit model artifact path")
        artifact_path = model_artifact_path if model_artifact_path is not None else model_path
        if artifact_path is None:
            raise ValueError("an explicit model artifact path is required")
        if isinstance(artifact_path, (bytes, bytearray, memoryview)):
            raise ValueError("model artifact path must be a filesystem path")
        if runtime_factory is not None and not callable(runtime_factory):
            raise TypeError("runtime_factory must be callable")
        if runtime is not None and runtime_factory is not None:
            raise ValueError("provide either runtime or runtime_factory")

        self._manifest = validate_component_manifest(manifest)
        if self._manifest["engine_id"] != DEFAULT_ENGINE_ID:
            raise OcrManifestError("RapidOCR adapter requires the RapidOCR component manifest")
        self._model_artifact_path = Path(artifact_path)
        self._runtime_flavor = runtime_flavor if isinstance(runtime_flavor, str) else ""
        self._runtime_factory = runtime_factory
        self._runtime = runtime
        self._runtime_kind: str | None = None
        self._max_regions = _positive_limit(max_regions, "max_regions", MAX_REGION_COUNT)
        self._max_text_length = _positive_limit(max_text_length, "max_text_length", MAX_TEXT_LENGTH)

    @property
    def engine_id(self) -> str:
        """Return the stable engine ID from the validated component manifest."""
        return self._manifest["engine_id"]

    @property
    def model_artifact_path(self) -> Path:
        """Return the configured artifact path or bundle root for trusted callers."""
        return self._model_artifact_path

    def health(self) -> dict[str, Any]:
        """Return a non-downloading component health projection.

        The return shape intentionally has no artifact path, package error, or
        runtime exception, so it is safe for a future capability projection.
        ``ready`` means the exact local bytes are present, runtime flavor is
        compatible, and a runtime factory/module is available for lazy use.
        """
        status = self._health_status()
        return {
            "engine_id": self.engine_id,
            "status": status,
            "enabled": status == "ready",
        }

    def capabilities(self) -> dict[str, Any]:
        """Expose static manifest capability metadata without loading a runtime."""
        health = self.health()
        return {
            **health,
            "languages": list(self._manifest["languages"]),
            "supports_orientation": self._manifest["supports_orientation"],
        }

    def recognize(
        self,
        image: Any,
        regions: Sequence[Any] | None = None,
        options: Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Recognize in-memory pixels and normalize bounded text regions.

        File paths are rejected before the runtime can see them.  This keeps
        future asset authorization outside this spike and prevents the adapter
        from becoming a filesystem-reading shortcut.
        """
        dimensions = self._validate_image_input(image)
        normalized_regions = self._validate_requested_regions(regions)
        normalized_options = self._validate_options(options)
        health = self.health()
        if health["status"] != "ready":
            raise OcrAdapterUnavailableError(f"OCR engine is unavailable ({health['status']})")

        runtime = self._get_runtime()
        raw_result = self._invoke_runtime(runtime, image, normalized_regions, normalized_options)
        return self._normalize_runtime_result(raw_result, dimensions)

    def detect(self, image: Any, options: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        """Provide the spike's detection-compatible surface through recognition."""
        return self.recognize(image, regions=None, options=options)

    def _health_status(self) -> str:
        artifact_status = self._artifact_status()
        if artifact_status is not None:
            return artifact_status
        if self._runtime_flavor != self._manifest["runtime_flavor"]:
            return "incompatible"
        if self._runtime is not None:
            return "ready" if self._has_runtime_entry_point(self._runtime) else "incompatible"
        if self._runtime_factory is not None:
            return "ready"
        try:
            if self._manifest.get("artifacts"):
                available = "rapidocr" in sys.modules or importlib.util.find_spec("rapidocr") is not None
            else:
                available = (
                    "rapidocr_onnxruntime" in sys.modules
                    or importlib.util.find_spec("rapidocr_onnxruntime") is not None
                )
        except (ImportError, AttributeError, ValueError):
            available = False
        return "ready" if available else "incompatible"

    def _artifact_status(self) -> str | None:
        artifacts = self._manifest.get("artifacts")
        if artifacts:
            try:
                if not self._model_artifact_path.is_dir() or self._model_artifact_path.is_symlink():
                    return "integrity_error" if self._model_artifact_path.exists() else "missing"
            except OSError:
                return "integrity_error"
            for artifact in artifacts.values():
                candidate = self._model_artifact_path / artifact["path"]
                try:
                    if not candidate.is_file() or candidate.is_symlink():
                        return "missing" if not candidate.exists() else "integrity_error"
                    if candidate.stat().st_size != artifact["size_bytes"]:
                        return "integrity_error"
                    digest = hashlib.sha256()
                    with candidate.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                    if digest.hexdigest() != artifact["sha256"]:
                        return "integrity_error"
                except FileNotFoundError:
                    return "missing"
                except OSError:
                    return "integrity_error"
            return None
        try:
            metadata = self._model_artifact_path.stat()
        except FileNotFoundError:
            return "missing"
        except OSError:
            return "integrity_error"
        if not self._model_artifact_path.is_file() or metadata.st_size != self._manifest["size_bytes"]:
            return "integrity_error"
        digest = hashlib.sha256()
        try:
            with self._model_artifact_path.open("rb") as artifact:
                for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            return "integrity_error"
        if digest.hexdigest() != self._manifest["model_sha256"]:
            return "integrity_error"
        return None

    def _get_runtime(self) -> Any:
        if self._runtime is not None:
            return self._runtime
        try:
            if self._runtime_factory is not None:
                runtime = self._runtime_factory(self._model_artifact_path)
            elif self._manifest.get("artifacts"):
                module = importlib.import_module("rapidocr")
                runtime_class = getattr(module, "RapidOCR")
                artifacts = self._manifest["artifacts"]
                params = {
                    "Global.model_root_dir": str(self._model_artifact_path),
                    "Global.use_det": True,
                    "Global.use_rec": True,
                    "Global.use_cls": bool(self._manifest["supports_orientation"] and "cls" in artifacts),
                    "EngineConfig.onnxruntime.use_cuda": False,
                    "Det.model_path": str(self._model_artifact_path / artifacts["det"]["path"]),
                    "Rec.model_path": str(self._model_artifact_path / artifacts["rec"]["path"]),
                }
                if "cls" in artifacts:
                    params["Cls.model_path"] = str(self._model_artifact_path / artifacts["cls"]["path"])
                runtime = runtime_class(params=params)
                self._runtime_kind = "rapidocr"
            else:
                module = importlib.import_module("rapidocr_onnxruntime")
                runtime_class = getattr(module, "RapidOCR")
                # No parameterless fallback: it may cause vendor default downloads.
                runtime = runtime_class(model_path=str(self._model_artifact_path))
                self._runtime_kind = "rapidocr_onnxruntime"
        except Exception:
            raise OcrAdapterRuntimeError("OCR runtime could not be initialized") from None
        if runtime is None:
            raise OcrAdapterRuntimeError("OCR runtime could not be initialized")
        self._runtime = runtime
        return runtime

    @staticmethod
    def _validate_image_input(image: Any) -> tuple[int, int] | None:
        if image is None or isinstance(image, (str, os.PathLike)):
            raise OcrAdapterInputError("image must be in-memory pixels or bytes")
        if isinstance(image, (bytes, bytearray, memoryview)):
            if len(image) == 0 or len(image) > MAX_IMAGE_BYTES:
                raise OcrAdapterInputError("image bytes are empty or exceed the size limit")
            return None

        shape = getattr(image, "shape", None)
        if _is_sequence(shape) and len(shape) in {2, 3}:
            height, width = shape[0], shape[1]
            if (
                isinstance(height, bool)
                or isinstance(width, bool)
                or not isinstance(height, int)
                or not isinstance(width, int)
                or height <= 0
                or width <= 0
                or height > MAX_IMAGE_DIMENSION
                or width > MAX_IMAGE_DIMENSION
                or height * width > MAX_IMAGE_PIXELS
            ):
                raise OcrAdapterInputError("image dimensions exceed the supported bounds")
            return width, height

        size = getattr(image, "size", None)
        if _is_sequence(size) and len(size) == 2:
            width, height = size[0], size[1]
            if (
                isinstance(height, bool)
                or isinstance(width, bool)
                or not isinstance(height, int)
                or not isinstance(width, int)
                or height <= 0
                or width <= 0
                or height > MAX_IMAGE_DIMENSION
                or width > MAX_IMAGE_DIMENSION
                or height * width > MAX_IMAGE_PIXELS
            ):
                raise OcrAdapterInputError("image dimensions exceed the supported bounds")
            return width, height
        raise OcrAdapterInputError("image must be in-memory pixels or bytes")

    def _validate_requested_regions(self, regions: Sequence[Any] | None) -> list[Any] | None:
        if regions is None:
            return None
        if not _is_sequence(regions) or len(regions) > self._max_regions:
            raise OcrAdapterInputError("requested OCR regions exceed the supported bounds")
        return list(regions)

    @staticmethod
    def _validate_options(options: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if options is None:
            return None
        if not isinstance(options, Mapping) or len(options) > 16:
            raise OcrAdapterInputError("OCR options exceed the supported bounds")
        if any(not isinstance(key, str) or not key or len(key) > 64 for key in options):
            raise OcrAdapterInputError("OCR option names are invalid")
        return dict(options)

    @staticmethod
    def _has_runtime_entry_point(runtime: Any) -> bool:
        return (
            callable(getattr(runtime, "recognize", None))
            or callable(getattr(runtime, "run", None))
            or callable(runtime)
        )

    def _invoke_runtime(
        self,
        runtime: Any,
        image: Any,
        regions: list[Any] | None,
        options: dict[str, Any] | None,
    ) -> Any:
        if callable(getattr(runtime, "recognize", None)):
            method = runtime.recognize
        elif callable(getattr(runtime, "run", None)):
            method = runtime.run
        elif callable(runtime):
            method = runtime
        else:
            raise OcrAdapterRuntimeError("OCR runtime has no supported recognition entry point")
        try:
            if self._runtime_kind == "rapidocr":
                if regions:
                    raise OcrAdapterInputError("official RapidOCR does not support bounded region requests")
                use_cls = bool(self._manifest["supports_orientation"])
                if options and "orientation" in options:
                    use_cls = bool(options["orientation"]) and use_cls
                return method(image, use_cls=use_cls)
            if regions is None and options is None:
                return method(image)
            return method(image, regions=regions, options=options)
        except OcrAdapterError:
            raise
        except Exception:
            raise OcrAdapterRuntimeError("OCR runtime failed to process the in-memory image") from None

    def _normalize_runtime_result(
        self,
        raw_result: Any,
        dimensions: tuple[int, int] | None,
    ) -> list[dict[str, Any]]:
        entries = self._extract_entries(raw_result)
        if len(entries) > self._max_regions:
            raise OcrAdapterResultError("OCR runtime returned too many text regions")
        return [self._normalize_entry(entry, dimensions) for entry in entries]

    @staticmethod
    def _extract_entries(raw_result: Any) -> list[Any]:
        boxes = getattr(raw_result, "boxes", None)
        texts = getattr(raw_result, "txts", None)
        scores = getattr(raw_result, "scores", None)
        if boxes is not None and texts is not None and scores is not None:
            to_list = lambda value: value.tolist() if callable(getattr(value, "tolist", None)) else value
            boxes, texts, scores = to_list(boxes), to_list(texts), to_list(scores)
            if not _is_sequence(boxes) or not _is_sequence(texts) or not _is_sequence(scores):
                raise OcrAdapterResultError("OCR runtime returned invalid output arrays")
            if not len(boxes) == len(texts) == len(scores):
                raise OcrAdapterResultError("OCR runtime returned mismatched output arrays")
            return [
                {"polygon": polygon, "text": text, "confidence": score}
                for polygon, text, score in zip(boxes, texts, scores)
            ]
        # Official RapidOCR returns a typed output with ``boxes/txts/scores``
        # set to None when no text is detected.  Treat that explicit empty
        # result as a valid zero-region response instead of a malformed
        # runtime payload.
        word_results = getattr(raw_result, "word_results", None)
        if boxes is None and texts is None and scores is None and word_results is not None:
            if _is_sequence(word_results) and all(
                _is_sequence(item) and len(item) >= 1 and item[0] == ""
                for item in word_results
            ):
                return []
        # RapidOCR commonly returns ``(regions, elapsed_seconds)``.
        if (
            isinstance(raw_result, tuple)
            and len(raw_result) == 2
            and isinstance(raw_result[1], (int, float))
            and _is_sequence(raw_result[0])
        ):
            raw_result = raw_result[0]
        if isinstance(raw_result, Mapping):
            return [raw_result]
        if RapidOcrAdapter._looks_like_triplet(raw_result):
            return [raw_result]
        if not _is_sequence(raw_result):
            raise OcrAdapterResultError("OCR runtime returned an invalid text-region collection")
        return list(raw_result)

    @staticmethod
    def _looks_like_triplet(value: Any) -> bool:
        return (
            _is_sequence(value)
            and len(value) == 3
            and _is_sequence(value[0])
            and isinstance(value[1], str)
            and isinstance(value[2], (int, float))
            and not isinstance(value[2], bool)
        )

    def _normalize_entry(self, entry: Any, dimensions: tuple[int, int] | None) -> dict[str, Any]:
        if isinstance(entry, Mapping):
            polygon = entry.get("polygon", entry.get("points", entry.get("box")))
            text = entry.get("text")
            confidence = entry.get("confidence", entry.get("score"))
            language = entry.get("language", "und")
        elif self._looks_like_triplet(entry):
            polygon, text, confidence = entry
            language = "und"
        else:
            raise OcrAdapterResultError("OCR runtime returned an invalid text region")
        normalized_polygon = self._normalize_polygon(polygon, dimensions)
        if not isinstance(text, str):
            raise OcrAdapterResultError("OCR runtime returned invalid text")
        normalized_text = text.strip()
        if not normalized_text or len(normalized_text) > self._max_text_length or "\x00" in normalized_text:
            raise OcrAdapterResultError("OCR runtime returned text outside the supported bounds")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise OcrAdapterResultError("OCR runtime returned invalid confidence")
        normalized_confidence = float(confidence)
        if not math.isfinite(normalized_confidence) or not 0.0 <= normalized_confidence <= 1.0:
            raise OcrAdapterResultError("OCR runtime returned invalid confidence")
        if not isinstance(language, str) or not language.strip() or len(language.strip()) > 32:
            raise OcrAdapterResultError("OCR runtime returned invalid language")

        xs = [point[0] for point in normalized_polygon]
        ys = [point[1] for point in normalized_polygon]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        return {
            "polygon": normalized_polygon,
            "bbox": [left, top, right, bottom],
            "text": normalized_text,
            "confidence": normalized_confidence,
            "language": language.strip(),
            "engine_id": self.engine_id,
            "engine_version": self._manifest["engine_version"],
        }

    @staticmethod
    def _normalize_polygon(polygon: Any, dimensions: tuple[int, int] | None) -> list[list[float]]:
        if not _is_sequence(polygon) or len(polygon) != 4:
            raise OcrAdapterResultError("OCR runtime returned an invalid four-point polygon")
        max_x, max_y = dimensions if dimensions is not None else (MAX_COORDINATE, MAX_COORDINATE)
        normalized: list[list[float]] = []
        for point in polygon:
            if not _is_sequence(point) or len(point) != 2:
                raise OcrAdapterResultError("OCR runtime returned an invalid polygon point")
            x, y = _finite_number(point[0]), _finite_number(point[1])
            if x < 0 or y < 0 or x > max_x or y > max_y:
                raise OcrAdapterResultError("OCR runtime returned polygon coordinates outside image bounds")
            normalized.append([x, y])
        if len({(point[0], point[1]) for point in normalized}) != 4:
            raise OcrAdapterResultError("OCR runtime returned a degenerate polygon")
        signed_area = sum(
            normalized[index][0] * normalized[(index + 1) % 4][1]
            - normalized[(index + 1) % 4][0] * normalized[index][1]
            for index in range(4)
        )
        if abs(signed_area) <= 0.0:
            raise OcrAdapterResultError("OCR runtime returned a degenerate polygon")
        return normalized


# Preserve the conventional vendor capitalization for callers that use it.
RapidOCRAdapter = RapidOcrAdapter


__all__ = [
    "HEALTH_STATES",
    "MAX_IMAGE_BYTES",
    "MAX_REGION_COUNT",
    "MAX_TEXT_LENGTH",
    "OcrAdapterError",
    "OcrAdapterInputError",
    "OcrAdapterResultError",
    "OcrAdapterRuntimeError",
    "OcrAdapterUnavailableError",
    "RAPIDOCR_DEFAULT_ARTIFACTS",
    "RapidOCRAdapter",
    "RapidOcrAdapter",
    "build_local_rapidocr_adapter",
]
