"""Application boundary for the bounded OCR capability and recognition API.

This module deliberately does not discover models, install packages, read
filesystem paths, or start a runtime.  ``RapidOcrAdapter`` remains the local
component boundary; callers inject an adapter factory when a verified
component is available.  The default is a deterministic unavailable adapter.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import math
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictStr, model_validator

from .ocr_adapter import (
    MAX_IMAGE_BYTES,
    MAX_REGION_COUNT,
    OcrAdapterError,
    OcrAdapterInputError,
    OcrAdapterResultError,
    OcrAdapterRuntimeError,
    OcrAdapterUnavailableError,
)
from .ocr_contract import DEFAULT_ENGINE_ID


OCR_CAPABILITIES_SCHEMA = "ocr-capabilities/v1"
OCR_RECOGNIZE_SCHEMA = "ocr-recognize/v1"
TEXT_REGION_SCHEMA = "text-region/v2"
MAX_BASE64_LENGTH = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 128
_DATA_URL_RE = re.compile(r"^data:([a-z0-9.+-]+/[a-z0-9.+-]+);base64,(.*)$", re.IGNORECASE | re.DOTALL)
_ENGINE_ID_RE = re.compile(r"^ocr_[a-z0-9]+(?:_[a-z0-9]+)+$")
_LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


class OcrApiError(RuntimeError):
    """Stable, safe error raised at the OCR application boundary."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class OcrApiInputError(OcrApiError):
    def __init__(self, message: str = "OCR input is invalid") -> None:
        super().__init__("OCR_INPUT_INVALID", message, 400)


class OcrApiUnavailableError(OcrApiError):
    def __init__(self, message: str = "OCR is unavailable") -> None:
        super().__init__("OCR_UNAVAILABLE", message, 503)


class OcrApiRuntimeError(OcrApiError):
    def __init__(self, message: str = "OCR runtime failed") -> None:
        super().__init__("OCR_RUNTIME_ERROR", message, 503)


class OcrApiResultError(OcrApiError):
    def __init__(self, message: str = "OCR returned an invalid result") -> None:
        super().__init__("OCR_RESULT_INVALID", message, 502)


class OcrRecognizeRequest(BaseModel):
    """JSON request carrying one bounded, in-memory image representation.

    ``image`` is retained as a short compatibility alias for clients that use
    the existing image service naming. ``image_bytes`` is an explicit base64
    field for byte-oriented clients. All three fields carry base64 text; raw
    bytes are accepted by ``OcrApi.recognize`` for trusted in-process callers,
    never as a path or URI.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    image_base64: StrictStr | None = Field(default=None, max_length=MAX_BASE64_LENGTH)
    image: StrictStr | None = Field(default=None, max_length=MAX_BASE64_LENGTH)
    image_bytes: StrictStr | None = Field(default=None, max_length=MAX_BASE64_LENGTH)
    model_id: StrictStr | None = Field(default=None, max_length=64)
    regions: list[Any] | None = Field(default=None, max_length=MAX_REGION_COUNT)
    options: dict[StrictStr, Any] | None = Field(default=None, max_length=16)

    @model_validator(mode="after")
    def validate_image_fields(self) -> "OcrRecognizeRequest":
        supplied = [value for value in (self.image_base64, self.image, self.image_bytes) if value is not None]
        if len(supplied) != 1:
            raise ValueError("exactly one image base64 field is required")
        return self

    @property
    def encoded_image(self) -> str:
        for value in (self.image_base64, self.image, self.image_bytes):
            if value is not None:
                return value
        raise RuntimeError("validated request has no image")


class _UnavailableOcrAdapter:
    """Default adapter used when no verified component has been injected."""

    def capabilities(self) -> dict[str, Any]:
        return {
            "engine_id": DEFAULT_ENGINE_ID,
            "status": "missing",
            "enabled": False,
            "languages": [],
            "supports_orientation": False,
        }

    def recognize(self, image: Any, regions: Sequence[Any] | None = None, options: Mapping[str, Any] | None = None):
        raise OcrAdapterUnavailableError("OCR component is not installed")


def _decode_base64_image(value: str) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise OcrApiInputError("image must be base64 text")
    encoded = value.strip()
    if len(encoded) > MAX_BASE64_LENGTH:
        raise OcrApiInputError("image exceeds the supported size limit")
    data_url = _DATA_URL_RE.fullmatch(encoded)
    if data_url:
        if not data_url.group(1).lower().startswith("image/"):
            raise OcrApiInputError("image data URL must use an image media type")
        encoded = data_url.group(2)
    if not encoded or any(character.isspace() for character in encoded):
        raise OcrApiInputError("image base64 is malformed")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise OcrApiInputError("image base64 is malformed") from None
    if not decoded or len(decoded) > MAX_IMAGE_BYTES:
        raise OcrApiInputError("image exceeds the supported size limit")
    return decoded


def _safe_capabilities(adapter: Any) -> dict[str, Any]:
    fallback = {
        "schema_version": OCR_CAPABILITIES_SCHEMA,
        "engine_id": DEFAULT_ENGINE_ID,
        "status": "missing",
        "enabled": False,
        "languages": [],
        "supports_orientation": False,
    }
    try:
        source = adapter.capabilities()
    except Exception:
        return fallback
    if not isinstance(source, Mapping):
        return fallback
    engine_id = source.get("engine_id")
    status = source.get("status")
    languages = source.get("languages")
    if not isinstance(engine_id, str) or not _ENGINE_ID_RE.fullmatch(engine_id):
        engine_id = DEFAULT_ENGINE_ID
    if status not in {"missing", "ready", "incompatible", "integrity_error"}:
        status = "incompatible"
    if (
        not isinstance(languages, list)
        or len(languages) > 64
        or any(not isinstance(item, str) or not _LANGUAGE_RE.fullmatch(item.strip()) for item in languages)
    ):
        languages = []
    return {
        "schema_version": OCR_CAPABILITIES_SCHEMA,
        "engine_id": engine_id,
        "status": status,
        "enabled": bool(source.get("enabled")) and status == "ready",
        "languages": list(languages),
        "supports_orientation": bool(source.get("supports_orientation")),
    }


def _region_id(region: Mapping[str, Any], index: int) -> str:
    candidate = region.get("region_id")
    if isinstance(candidate, str) and re.fullmatch(r"txt_[a-z0-9]{8,64}", candidate):
        return candidate
    digest = hashlib.sha256(f"{index}:{repr(sorted(region.items(), key=lambda item: str(item[0])))}".encode("utf-8")).hexdigest()
    return f"txt_{digest[:24]}"


def _normalize_region(region: Any, index: int, fallback_engine_revision: str) -> dict[str, Any]:
    if not isinstance(region, Mapping):
        raise OcrApiResultError()
    polygon = region.get("polygon")
    if not isinstance(polygon, Sequence) or isinstance(polygon, (str, bytes, bytearray)) or len(polygon) != 4:
        raise OcrApiResultError()
    points: list[list[float]] = []
    for point in polygon:
        if not isinstance(point, Sequence) or isinstance(point, (str, bytes, bytearray)) or len(point) != 2:
            raise OcrApiResultError()
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError):
            raise OcrApiResultError() from None
        if not math.isfinite(x) or not math.isfinite(y) or x < 0 or y < 0:
            raise OcrApiResultError()
        points.append([x, y])
    bbox = region.get("bbox")
    if not isinstance(bbox, Sequence) or isinstance(bbox, (str, bytes, bytearray)) or len(bbox) != 4:
        raise OcrApiResultError()
    try:
        left, top, right, bottom = (float(value) for value in bbox)
    except (TypeError, ValueError):
        raise OcrApiResultError() from None
    if (
        not all(math.isfinite(value) for value in (left, top, right, bottom))
        or right <= left
        or bottom <= top
        or left < 0
        or top < 0
    ):
        raise OcrApiResultError()
    if len({(point[0], point[1]) for point in points}) != 4:
        raise OcrApiResultError()
    signed_area = sum(
        points[point_index][0] * points[(point_index + 1) % 4][1]
        - points[(point_index + 1) % 4][0] * points[point_index][1]
        for point_index in range(4)
    )
    if abs(signed_area) <= 0.0:
        raise OcrApiResultError()
    text = region.get("text", "")
    language = region.get("language", "und")
    confidence = region.get("confidence", region.get("recognition_confidence", 0.0))
    if not isinstance(text, str) or len(text) > 8192 or "\x00" in text:
        raise OcrApiResultError()
    if not isinstance(language, str) or not _LANGUAGE_RE.fullmatch(language.strip()):
        language = "und"
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        raise OcrApiResultError() from None
    if not 0.0 <= confidence <= 1.0:
        raise OcrApiResultError()
    revision = region.get("engine_revision", region.get("engine_version", fallback_engine_revision))
    if not isinstance(revision, str) or not revision.strip() or len(revision) > 160 or "\x00" in revision:
        raise OcrApiResultError()
    try:
        orientation = float(region.get("orientation_degrees", 0.0) or 0.0)
    except (TypeError, ValueError):
        raise OcrApiResultError() from None
    if not math.isfinite(orientation) or orientation < -180 or orientation > 180:
        raise OcrApiResultError()
    return {
        "schema_version": TEXT_REGION_SCHEMA,
        "region_id": _region_id(region, index),
        "polygon": points,
        "bbox": {"x": left, "y": top, "width": right - left, "height": bottom - top},
        "text": text,
        "language": language.strip(),
        "orientation_degrees": orientation,
        "detection_confidence": confidence,
        "recognition_confidence": confidence,
        "engine_revision": revision.strip(),
    }


class OcrApi:
    """Safe API orchestration around an injected OCR adapter."""

    def __init__(self, adapter_factory: Callable[[], Any] | None = None) -> None:
        self._adapter_factory = adapter_factory
        self._adapter: Any | None = None

    def _get_adapter(self) -> Any:
        if self._adapter is not None:
            return self._adapter
        if self._adapter_factory is None:
            self._adapter = _UnavailableOcrAdapter()
            return self._adapter
        try:
            adapter = self._adapter_factory()
        except Exception:
            self._adapter = _UnavailableOcrAdapter()
            return self._adapter
        self._adapter = adapter if adapter is not None else _UnavailableOcrAdapter()
        return self._adapter

    def capabilities(self) -> dict[str, Any]:
        return _safe_capabilities(self._get_adapter())

    def recognize(
        self,
        image: bytes | bytearray | memoryview | str,
        regions: Sequence[Any] | None = None,
        options: Mapping[str, Any] | None = None,
        model_id: str | None = None,
    ) -> dict[str, Any]:
        if isinstance(image, str):
            image_bytes = _decode_base64_image(image)
        elif isinstance(image, (bytes, bytearray, memoryview)):
            try:
                if len(image) == 0 or len(image) > MAX_IMAGE_BYTES:
                    raise OcrApiInputError("image exceeds the supported size limit")
            except TypeError:
                raise OcrApiInputError("image must be in-memory bytes or base64 text") from None
            image_bytes = bytes(image)
            if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
                raise OcrApiInputError("image exceeds the supported size limit")
        else:
            raise OcrApiInputError("image must be in-memory bytes or base64 text")
        if regions is not None:
            if (
                not isinstance(regions, Sequence)
                or isinstance(regions, (str, bytes, bytearray, memoryview))
                or len(regions) > MAX_REGION_COUNT
            ):
                raise OcrApiInputError("requested OCR regions exceed the supported bounds")
        if options is not None:
            if not isinstance(options, Mapping) or len(options) > 16:
                raise OcrApiInputError("OCR options exceed the supported bounds")
            if any(not isinstance(key, str) or not key or len(key) > 64 for key in options):
                raise OcrApiInputError("OCR option names are invalid")
        if model_id is not None and (
            not isinstance(model_id, str)
            or not model_id.strip()
            or not _ENGINE_ID_RE.fullmatch(model_id.strip())
        ):
            raise OcrApiInputError("OCR model id is invalid")
        adapter = self._get_adapter()
        normalized_options = dict(options) if options is not None else None
        if model_id is not None:
            if normalized_options is None:
                normalized_options = {}
            normalized_options["model_id"] = model_id.strip()
        try:
            raw_regions = adapter.recognize(image_bytes, regions=regions, options=normalized_options)
        except OcrAdapterUnavailableError:
            raise OcrApiUnavailableError() from None
        except OcrAdapterInputError:
            raise OcrApiInputError() from None
        except OcrAdapterRuntimeError:
            raise OcrApiRuntimeError() from None
        except OcrAdapterResultError:
            raise OcrApiResultError() from None
        except OcrAdapterError:
            raise OcrApiRuntimeError() from None
        except Exception:
            raise OcrApiRuntimeError() from None
        if (
            not isinstance(raw_regions, Sequence)
            or isinstance(raw_regions, (str, bytes, bytearray))
            or len(raw_regions) > MAX_REGION_COUNT
        ):
            raise OcrApiResultError()
        capabilities = _safe_capabilities(adapter)
        revision = capabilities["engine_id"]
        try:
            normalized_regions = [
                _normalize_region(region, index, revision)
                for index, region in enumerate(raw_regions)
            ]
        except OcrApiError:
            raise
        except Exception:
            raise OcrApiResultError() from None
        return {
            "schema_version": OCR_RECOGNIZE_SCHEMA,
            "engine_id": capabilities["engine_id"],
            "regions": normalized_regions,
        }


__all__ = [
    "MAX_BASE64_LENGTH",
    "OCR_CAPABILITIES_SCHEMA",
    "OCR_RECOGNIZE_SCHEMA",
    "OcrApi",
    "OcrApiError",
    "OcrApiInputError",
    "OcrApiResultError",
    "OcrApiRuntimeError",
    "OcrApiUnavailableError",
    "OcrRecognizeRequest",
]
