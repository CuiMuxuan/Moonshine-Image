import json
import os
import re
from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np


STATE_VERSION = 1
DEFAULT_OBJECT_KEY = "default"

MODE_PRESETS = {
    "conservative": {
        "scene_change_threshold": 0.35,
        "mask_iou_threshold": 0.45,
        "center_shift_threshold": 0.08,
        "blend_strength": 0.25,
    },
    "balanced": {
        "scene_change_threshold": 0.42,
        "mask_iou_threshold": 0.36,
        "center_shift_threshold": 0.12,
        "blend_strength": 0.32,
    },
    "strong": {
        "scene_change_threshold": 0.5,
        "mask_iou_threshold": 0.28,
        "center_shift_threshold": 0.16,
        "blend_strength": 0.4,
    },
}


DEFAULT_OPTIONS = {
    "enabled": False,
    "mode": "conservative",
    "stabilize_mask": True,
    "stabilize_result": True,
    "texture_cache": True,
    "diagnostics": False,
    "scene_change_threshold": 0.35,
    "mask_iou_threshold": 0.45,
    "center_shift_threshold": 0.08,
    "blend_strength": 0.25,
    "cache_ttl_frames": 12,
    "min_mask_area": 16,
    "diagnostics_path": "",
    "state_path": "",
    "cache_dir": "",
    "config_signature": "",
    "source_fingerprint": "",
    "video_width": None,
    "video_height": None,
    "fps": None,
}


def _as_dict(options: Any) -> Dict[str, Any]:
    if options is None:
        return {}
    if isinstance(options, dict):
        return options
    if hasattr(options, "model_dump"):
        return options.model_dump(mode="json")
    return {}


def _bool(value: Any, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def _float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not np.isfinite(numeric):
        return fallback
    return max(minimum, min(maximum, numeric))


def _int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        numeric = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, numeric))


def _optional_int(value: Any, minimum: int = 0, maximum: int = 1_000_000) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        numeric = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    if numeric < minimum or numeric > maximum:
        return None
    return numeric


def _optional_float(value: Any, minimum: float = 0.0, maximum: float = 1_000_000.0) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(numeric) or numeric < minimum or numeric > maximum:
        return None
    return numeric


def _string(value: Any) -> str:
    return str(value or "").strip()


def normalize_temporal_enhancement_options(options: Any) -> Dict[str, Any]:
    raw = _as_dict(options)
    normalized = dict(DEFAULT_OPTIONS)
    normalized["enabled"] = _bool(raw.get("enabled"), DEFAULT_OPTIONS["enabled"])
    mode = str(raw.get("mode") or DEFAULT_OPTIONS["mode"]).strip().lower()
    normalized["mode"] = mode if mode in MODE_PRESETS else DEFAULT_OPTIONS["mode"]
    preset = MODE_PRESETS[normalized["mode"]]

    normalized["stabilize_mask"] = _bool(
        raw.get("stabilize_mask"), DEFAULT_OPTIONS["stabilize_mask"]
    )
    normalized["stabilize_result"] = _bool(
        raw.get("stabilize_result"), DEFAULT_OPTIONS["stabilize_result"]
    )
    normalized["texture_cache"] = _bool(
        raw.get("texture_cache"), DEFAULT_OPTIONS["texture_cache"]
    )
    normalized["diagnostics"] = _bool(
        raw.get("diagnostics"), DEFAULT_OPTIONS["diagnostics"]
    )
    normalized["scene_change_threshold"] = _float(
        raw.get("scene_change_threshold"),
        preset["scene_change_threshold"],
        0,
        1,
    )
    normalized["mask_iou_threshold"] = _float(
        raw.get("mask_iou_threshold"),
        preset["mask_iou_threshold"],
        0,
        1,
    )
    normalized["center_shift_threshold"] = _float(
        raw.get("center_shift_threshold"),
        preset["center_shift_threshold"],
        0,
        1,
    )
    normalized["blend_strength"] = _float(
        raw.get("blend_strength"), preset["blend_strength"], 0, 1
    )
    normalized["cache_ttl_frames"] = _int(
        raw.get("cache_ttl_frames"), DEFAULT_OPTIONS["cache_ttl_frames"], 1, 120
    )
    normalized["min_mask_area"] = _int(
        raw.get("min_mask_area"), DEFAULT_OPTIONS["min_mask_area"], 1, 1_000_000
    )
    normalized["diagnostics_path"] = str(raw.get("diagnostics_path") or "").strip()
    normalized["state_path"] = _string(raw.get("state_path"))
    normalized["cache_dir"] = _string(raw.get("cache_dir"))
    normalized["config_signature"] = _string(raw.get("config_signature"))
    normalized["source_fingerprint"] = _string(raw.get("source_fingerprint"))
    normalized["video_width"] = _optional_int(raw.get("video_width"), 1, 100_000)
    normalized["video_height"] = _optional_int(raw.get("video_height"), 1, 100_000)
    normalized["fps"] = _optional_float(raw.get("fps"), 0.001, 1000.0)
    return normalized


def is_temporal_enhancement_enabled(options: Any) -> bool:
    return normalize_temporal_enhancement_options(options).get("enabled") is True


def _mask_stats(mask: np.ndarray) -> Dict[str, Any]:
    binary = mask > 127
    nonzero = int(np.count_nonzero(binary))
    height, width = mask.shape[:2]
    if nonzero <= 0:
        return {
            "nonzero": 0,
            "area_ratio": 0.0,
            "bounds": None,
            "center": None,
            "binary": binary,
        }

    ys, xs = np.where(binary)
    x0 = int(xs.min())
    x1 = int(xs.max()) + 1
    y0 = int(ys.min())
    y1 = int(ys.max()) + 1
    return {
        "nonzero": nonzero,
        "area_ratio": float(nonzero / max(width * height, 1)),
        "bounds": (x0, y0, x1, y1),
        "center": (
            float((x0 + x1) / 2 / max(width, 1)),
            float((y0 + y1) / 2 / max(height, 1)),
        ),
        "binary": binary,
    }


def _mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    intersection = int(np.logical_and(left, right).sum())
    union = int(np.logical_or(left, right).sum())
    return float(intersection / union) if union > 0 else 0.0


def _center_shift(left: Optional[Tuple[float, float]], right: Optional[Tuple[float, float]]) -> float:
    if left is None or right is None:
        return 1.0
    return float(max(abs(left[0] - right[0]), abs(left[1] - right[1])))


def _scene_thumbnail(image_rgb: np.ndarray) -> np.ndarray:
    small = cv2.resize(image_rgb, (32, 32), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    return gray.astype(np.float32) / 255.0


def _scene_delta(current_thumb: np.ndarray, previous_thumb: Optional[np.ndarray]) -> float:
    if previous_thumb is None or previous_thumb.shape != current_thumb.shape:
        return 1.0
    return float(np.mean(np.abs(current_thumb - previous_thumb)))


def _safe_cache_key(value: Any) -> str:
    text = _string(value) or DEFAULT_OBJECT_KEY
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    text = text.strip("._-")
    return (text or DEFAULT_OBJECT_KEY)[:120]


def _write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    temporary_path = f"{path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
    os.replace(temporary_path, path)


def _read_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fp:
        payload = json.load(fp)
    return payload if isinstance(payload, dict) else {}


def _write_image(path: str, image: np.ndarray) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    if not cv2.imwrite(path, image):
        raise OSError(f"Failed to write image: {path}")


def _json_bounds(bounds: Any) -> Optional[list]:
    if not bounds or len(bounds) != 4:
        return None
    return [int(value) for value in bounds]


def _json_center(center: Any) -> Optional[list]:
    if not center or len(center) != 2:
        return None
    return [float(center[0]), float(center[1])]


def _read_binary_mask_from_path(mask_path: str, expected_shape: Tuple[int, int]) -> Optional[np.ndarray]:
    if not mask_path:
        return None
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        return None
    expected_height, expected_width = expected_shape
    if mask.shape[:2] != (expected_height, expected_width):
        mask = cv2.resize(
            mask,
            (expected_width, expected_height),
            interpolation=cv2.INTER_NEAREST,
        )
    return np.where(mask > 127, 255, 0).astype(np.uint8)


def _stabilize_binary_mask(mask: np.ndarray) -> np.ndarray:
    kernel = np.ones((3, 3), np.uint8)
    binary = np.where(mask > 127, 255, 0).astype(np.uint8)
    opened = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel)


def _blend_in_mask(
    current_bgr: np.ndarray,
    reference_bgr: np.ndarray,
    mask: np.ndarray,
    strength: float,
) -> np.ndarray:
    if reference_bgr is None or reference_bgr.shape != current_bgr.shape:
        return current_bgr

    original_mask = mask > 127
    if not np.any(original_mask):
        return current_bgr

    mask_float = np.where(mask > 127, 1.0, 0.0).astype(np.float32)
    mask_float = cv2.GaussianBlur(mask_float, (0, 0), sigmaX=1.2)
    mask_float *= original_mask.astype(np.float32)
    mask_float = np.clip(mask_float, 0.0, 1.0)
    weight = (mask_float * max(0.0, min(1.0, strength)))[:, :, None]
    blended = current_bgr.astype(np.float32) * (1.0 - weight)
    blended += reference_bgr.astype(np.float32) * weight
    return np.clip(blended, 0, 255).astype(np.uint8)


class VideoTemporalEnhancer:
    def __init__(self, options: Any, batch_id: str = ""):
        self.options = normalize_temporal_enhancement_options(options)
        self.batch_id = batch_id
        self.previous = None
        self.texture_cache = {}
        self.state_restored = False
        if self.enabled:
            self._load_previous_from_state()
            self._load_object_cache()

    @property
    def enabled(self) -> bool:
        return self.options.get("enabled") is True

    def enhance_frame(
        self,
        *,
        frame_index: int,
        image_rgb: np.ndarray,
        mask: np.ndarray,
        independent_bgr: np.ndarray,
        output_path: str = "",
        temporal_objects: Optional[Any] = None,
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        decision = {
            "enabled": self.enabled,
            "applied": False,
            "fallback": True,
            "skip_reason": "disabled",
            "frame_index": frame_index,
        }
        if not self.enabled:
            return independent_bgr, decision

        object_refs = self._normalize_temporal_object_refs(temporal_objects)
        object_key = self._resolve_object_key(object_refs)
        current_thumb = _scene_thumbnail(image_rgb)
        stats = _mask_stats(mask)
        decision.update(
            {
                "skip_reason": "",
                "mask_pixels": stats["nonzero"],
                "texture_cache_hit": False,
                "object_key": object_key,
                "object_keys": [item["object_key"] for item in object_refs],
                "object_mask_path_count": sum(1 for item in object_refs if item.get("mask_path")),
                "state_restored": self.state_restored,
            }
        )

        if stats["nonzero"] < self.options["min_mask_area"]:
            decision["skip_reason"] = "small-mask"
            self._remember(frame_index, current_thumb, stats, independent_bgr)
            self._write_diagnostic(decision, output_path)
            return independent_bgr, decision

        previous = self.previous
        if previous is None:
            decision["skip_reason"] = "missing-reference"
            self._remember(frame_index, current_thumb, stats, independent_bgr)
            self._update_texture_cache(
                frame_index,
                stats,
                independent_bgr,
                object_key,
                object_refs,
                mask.shape[:2],
            )
            self._write_diagnostic(decision, output_path)
            return independent_bgr, decision

        scene_delta = _scene_delta(current_thumb, previous.get("thumbnail"))
        iou = _mask_iou(stats["binary"], previous["mask_binary"])
        center_shift = _center_shift(stats["center"], previous.get("center"))
        previous_area = max(float(previous.get("area_ratio") or 0), 1e-8)
        area_delta = abs(stats["area_ratio"] - previous_area) / previous_area
        decision.update(
            {
                "scene_delta": scene_delta,
                "mask_iou": iou,
                "center_shift": center_shift,
                "area_delta": area_delta,
            }
        )

        risk_reason = self._get_risk_reason(scene_delta, iou, center_shift, area_delta)
        if risk_reason:
            decision["skip_reason"] = risk_reason
            self._remember(frame_index, current_thumb, stats, independent_bgr)
            self._update_texture_cache(
                frame_index,
                stats,
                independent_bgr,
                object_key,
                object_refs,
                mask.shape[:2],
            )
            self._write_diagnostic(decision, output_path)
            return independent_bgr, decision

        blend_mask = mask
        if self.options["stabilize_mask"]:
            blend_mask = _stabilize_binary_mask(mask)
            decision["mask_stabilized"] = True

        enhanced_bgr = independent_bgr
        cache_hit_keys = self._get_texture_cache_hit_keys(frame_index, object_refs, object_key)
        if cache_hit_keys:
            decision["texture_cache_hit"] = True
            decision["texture_cache_hit_keys"] = cache_hit_keys

        if self.options["stabilize_result"]:
            enhanced_bgr = _blend_in_mask(
                independent_bgr,
                previous["result_bgr"],
                blend_mask,
                self.options["blend_strength"],
            )
            decision["applied"] = not np.array_equal(enhanced_bgr, independent_bgr)
            decision["fallback"] = not decision["applied"]
            decision["skip_reason"] = "" if decision["applied"] else "no-visible-change"

        self._remember(frame_index, current_thumb, stats, enhanced_bgr)
        self._update_texture_cache(
            frame_index,
            stats,
            enhanced_bgr,
            object_key,
            object_refs,
            mask.shape[:2],
        )
        self._write_diagnostic(decision, output_path)
        return enhanced_bgr, decision

    def _get_risk_reason(
        self, scene_delta: float, iou: float, center_shift: float, area_delta: float
    ) -> str:
        if scene_delta > self.options["scene_change_threshold"]:
            return "scene-change"
        if iou < self.options["mask_iou_threshold"]:
            return "mask-iou"
        if center_shift > self.options["center_shift_threshold"]:
            return "center-shift"
        if area_delta > 1.0:
            return "mask-area-change"
        return ""

    def _remember(
        self,
        frame_index: int,
        thumbnail: np.ndarray,
        stats: Dict[str, Any],
        result_bgr: np.ndarray,
    ) -> None:
        self.previous = {
            "frame_index": frame_index,
            "thumbnail": thumbnail.copy(),
            "mask_binary": stats["binary"].copy(),
            "mask_uint8": np.where(stats["binary"], 255, 0).astype(np.uint8),
            "center": stats["center"],
            "area_ratio": stats["area_ratio"],
            "bounds": stats["bounds"],
            "nonzero": stats["nonzero"],
            "result_bgr": result_bgr.copy(),
        }

    def _normalize_temporal_object_refs(self, temporal_objects: Optional[Any]) -> list:
        if not temporal_objects:
            return []
        candidates = temporal_objects
        if not isinstance(candidates, (list, tuple)):
            candidates = [candidates]
        refs = []
        for item in candidates:
            if isinstance(item, str):
                object_key = _string(item)
                if object_key:
                    refs.append({"object_key": object_key, "mask_path": ""})
                continue
            if hasattr(item, "model_dump"):
                item = item.model_dump(mode="json")
            if not isinstance(item, dict):
                continue
            object_key = _string(item.get("object_key") or item.get("objectKey"))
            mask_id = _string(item.get("mask_id") or item.get("maskId"))
            object_id = _string(item.get("object_id") or item.get("objectId"))
            source = _string(item.get("source")).lower()
            if not object_key and source == "sam" and mask_id and object_id:
                object_key = f"sam:{mask_id}:{object_id}"
            if not object_key and mask_id:
                object_key = f"mask:{mask_id}"
            if object_key:
                refs.append(
                    {
                        "object_key": object_key,
                        "source": source,
                        "mask_id": mask_id,
                        "object_id": object_id,
                        "mask_path": _string(item.get("mask_path") or item.get("maskPath")),
                    }
                )
        deduped = {}
        for ref in refs:
            deduped.setdefault(ref["object_key"], ref)
        return list(deduped.values())

    def _resolve_object_key(self, temporal_objects: Optional[Any]) -> str:
        object_refs = (
            temporal_objects
            if isinstance(temporal_objects, list)
            and all(isinstance(item, dict) and item.get("object_key") for item in temporal_objects)
            else self._normalize_temporal_object_refs(temporal_objects)
        )
        object_keys = [item["object_key"] for item in object_refs if item.get("object_key")]
        unique_keys = sorted({key for key in object_keys if key})
        if len(unique_keys) == 1:
            return unique_keys[0]
        if len(unique_keys) > 1:
            return "combo:" + "|".join(unique_keys)
        return DEFAULT_OBJECT_KEY

    def _get_texture_cache_hit_keys(
        self,
        frame_index: int,
        object_refs: Optional[list],
        fallback_key: str,
    ) -> list:
        if not self.options["texture_cache"]:
            return []
        keys = [item["object_key"] for item in object_refs or [] if item.get("object_key")]
        if not keys:
            keys = [fallback_key or DEFAULT_OBJECT_KEY]
        hit_keys = []
        for key in keys:
            cache_entry = self.texture_cache.get(key)
            if (
                cache_entry
                and frame_index - int(cache_entry.get("frame_index", frame_index))
                <= self.options["cache_ttl_frames"]
            ):
                hit_keys.append(key)
        return hit_keys

    def _update_texture_cache(
        self,
        frame_index: int,
        stats: Dict[str, Any],
        result_bgr: np.ndarray,
        object_key: str = DEFAULT_OBJECT_KEY,
        object_refs: Optional[list] = None,
        mask_shape: Optional[Tuple[int, int]] = None,
    ) -> None:
        if not self.options["texture_cache"] or not stats.get("bounds"):
            return
        precise_updates = self._update_precise_object_texture_cache(
            frame_index,
            result_bgr,
            object_refs or [],
            mask_shape or result_bgr.shape[:2],
        )
        if precise_updates > 0:
            return
        x0, y0, x1, y1 = stats["bounds"]
        if x1 <= x0 or y1 <= y0:
            return
        self.texture_cache[object_key or DEFAULT_OBJECT_KEY] = {
            "frame_index": frame_index,
            "bounds": stats["bounds"],
            "area_ratio": stats["area_ratio"],
            "center": stats["center"],
            "patch": result_bgr[y0:y1, x0:x1].copy(),
            "mask": np.where(stats["binary"][y0:y1, x0:x1], 255, 0).astype(np.uint8),
        }

    def _update_precise_object_texture_cache(
        self,
        frame_index: int,
        result_bgr: np.ndarray,
        object_refs: list,
        mask_shape: Tuple[int, int],
    ) -> int:
        updates = 0
        if not object_refs:
            return updates
        for ref in object_refs:
            object_key = _string(ref.get("object_key"))
            mask_path = _string(ref.get("mask_path"))
            if not object_key or not mask_path:
                continue
            object_mask = _read_binary_mask_from_path(mask_path, mask_shape)
            if object_mask is None:
                continue
            object_stats = _mask_stats(object_mask)
            if object_stats["nonzero"] < self.options["min_mask_area"]:
                continue
            x0, y0, x1, y1 = object_stats["bounds"]
            if x1 <= x0 or y1 <= y0:
                continue
            self.texture_cache[object_key] = {
                "frame_index": frame_index,
                "bounds": object_stats["bounds"],
                "area_ratio": object_stats["area_ratio"],
                "center": object_stats["center"],
                "patch": result_bgr[y0:y1, x0:x1].copy(),
                "mask": np.where(object_stats["binary"][y0:y1, x0:x1], 255, 0).astype(np.uint8),
                "source_mask_path": mask_path,
            }
            updates += 1
        return updates

    def _state_dir(self) -> str:
        state_path = self.options.get("state_path") or ""
        return os.path.dirname(os.path.abspath(state_path)) if state_path else ""

    def _resolve_state_reference_path(self, reference_path: str) -> str:
        if os.path.isabs(reference_path):
            return reference_path
        state_dir = self._state_dir()
        return os.path.abspath(os.path.join(state_dir, reference_path))

    def _relative_to_state_dir(self, path: str) -> str:
        state_dir = self._state_dir()
        if not state_dir:
            return path
        try:
            return os.path.relpath(path, state_dir)
        except ValueError:
            return path

    def _matches_context(self, payload: Dict[str, Any], *, require_enabled: bool = False) -> bool:
        try:
            if int(payload.get("version", 0)) != STATE_VERSION:
                return False
        except (TypeError, ValueError):
            return False
        if require_enabled and payload.get("enabled") is not True:
            return False

        config_signature = self.options.get("config_signature") or ""
        source_fingerprint = self.options.get("source_fingerprint") or ""
        if config_signature and _string(payload.get("configSignature")) != config_signature:
            return False
        if source_fingerprint and _string(payload.get("sourceFingerprint")) != source_fingerprint:
            return False

        video = payload.get("video") if isinstance(payload.get("video"), dict) else {}
        expected_width = self.options.get("video_width")
        expected_height = self.options.get("video_height")
        expected_fps = self.options.get("fps")
        if expected_width and int(video.get("width") or 0) != int(expected_width):
            return False
        if expected_height and int(video.get("height") or 0) != int(expected_height):
            return False
        if expected_fps:
            try:
                if abs(float(video.get("fps") or 0) - float(expected_fps)) > 0.001:
                    return False
            except (TypeError, ValueError):
                return False
        return True

    def _load_previous_from_state(self) -> None:
        state_path = self.options.get("state_path") or ""
        if not state_path or not os.path.exists(state_path):
            return
        try:
            payload = _read_json(state_path)
            if not self._matches_context(payload, require_enabled=True):
                return
            reference = payload.get("reference")
            if not isinstance(reference, dict):
                return

            result_path = self._resolve_state_reference_path(
                _string(reference.get("resultPath") or reference.get("result_path"))
            )
            mask_path = self._resolve_state_reference_path(
                _string(reference.get("maskPath") or reference.get("mask_path"))
            )
            thumbnail_path = self._resolve_state_reference_path(
                _string(reference.get("thumbnailPath") or reference.get("thumbnail_path"))
            )
            if not result_path or not mask_path or not thumbnail_path:
                return

            result_bgr = cv2.imread(result_path, cv2.IMREAD_COLOR)
            mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
            thumbnail_payload = _read_json(thumbnail_path)
            thumbnail = np.asarray(
                thumbnail_payload.get("thumbnail"), dtype=np.float32
            )
            if result_bgr is None or mask is None or thumbnail.shape != (32, 32):
                return
            if result_bgr.shape[:2] != mask.shape[:2]:
                return
            expected_width = self.options.get("video_width")
            expected_height = self.options.get("video_height")
            if expected_width and result_bgr.shape[1] != int(expected_width):
                return
            if expected_height and result_bgr.shape[0] != int(expected_height):
                return

            stats = _mask_stats(mask)
            frame_index = int(reference.get("frameIndex") or reference.get("frame_index") or 0)
            self.previous = {
                "frame_index": frame_index,
                "thumbnail": thumbnail.copy(),
                "mask_binary": stats["binary"].copy(),
                "mask_uint8": np.where(stats["binary"], 255, 0).astype(np.uint8),
                "center": stats["center"],
                "area_ratio": stats["area_ratio"],
                "bounds": stats["bounds"],
                "nonzero": stats["nonzero"],
                "result_bgr": result_bgr.copy(),
            }
            self.state_restored = True
        except Exception as error:
            self._write_persistence_diagnostic("state-load-failed", error)

    def _reference_stats_for_json(self) -> Dict[str, Any]:
        previous = self.previous or {}
        return {
            "nonzero": int(previous.get("nonzero") or 0),
            "areaRatio": float(previous.get("area_ratio") or 0.0),
            "area_ratio": float(previous.get("area_ratio") or 0.0),
            "center": _json_center(previous.get("center")),
            "bounds": _json_bounds(previous.get("bounds")),
        }

    def _persist_previous_state(self) -> None:
        if not self.previous:
            return
        state_path = self.options.get("state_path") or ""
        cache_dir = self.options.get("cache_dir") or ""
        if not state_path or not cache_dir:
            return

        frame_index = int(self.previous.get("frame_index") or 0)
        refs_dir = os.path.join(cache_dir, "refs")
        result_path = os.path.join(refs_dir, f"result_ref_{frame_index:06d}.png")
        mask_path = os.path.join(refs_dir, f"mask_ref_{frame_index:06d}.png")
        thumbnail_path = os.path.join(refs_dir, f"thumb_ref_{frame_index:06d}.json")

        _write_image(result_path, self.previous["result_bgr"])
        _write_image(mask_path, self.previous["mask_uint8"])
        _write_json_atomic(
            thumbnail_path,
            {
                "version": STATE_VERSION,
                "thumbnail": self.previous["thumbnail"].astype(float).tolist(),
            },
        )

        payload = {
            "version": STATE_VERSION,
            "enabled": True,
            "configSignature": self.options.get("config_signature") or "",
            "sourceFingerprint": self.options.get("source_fingerprint") or "",
            "video": {
                "width": self.options.get("video_width") or 0,
                "height": self.options.get("video_height") or 0,
                "fps": self.options.get("fps") or 0,
            },
            "batch": {
                "batchId": self.batch_id,
                "lastFrameIndex": frame_index,
                "lastReliableFrameIndex": frame_index,
            },
            "reference": {
                "frameIndex": frame_index,
                "resultPath": self._relative_to_state_dir(result_path),
                "maskPath": self._relative_to_state_dir(mask_path),
                "thumbnailPath": self._relative_to_state_dir(thumbnail_path),
                "maskStats": self._reference_stats_for_json(),
            },
        }
        _write_json_atomic(state_path, payload)

    def _resolve_object_cache_file(self, object_dir: str, cache_path: str) -> str:
        if os.path.isabs(cache_path):
            return cache_path
        return os.path.join(object_dir, cache_path)

    def _load_object_cache(self) -> None:
        cache_dir = self.options.get("cache_dir") or ""
        if not cache_dir:
            return
        objects_dir = os.path.join(cache_dir, "objects")
        if not os.path.isdir(objects_dir):
            return
        try:
            for object_name in os.listdir(objects_dir):
                object_dir = os.path.join(objects_dir, object_name)
                meta_path = os.path.join(object_dir, "meta.json")
                if not os.path.isfile(meta_path):
                    continue
                meta = _read_json(meta_path)
                if not self._matches_context(meta):
                    continue
                object_key = _string(meta.get("objectKey")) or DEFAULT_OBJECT_KEY
                patch_path = self._resolve_object_cache_file(
                    object_dir, _string(meta.get("patchPath"))
                )
                patch = cv2.imread(patch_path, cv2.IMREAD_COLOR)
                if patch is None:
                    continue
                mask_path = self._resolve_object_cache_file(
                    object_dir, _string(meta.get("maskPath"))
                )
                mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
                self.texture_cache[object_key] = {
                    "frame_index": int(meta.get("lastReliableFrameIndex") or 0),
                    "bounds": tuple(meta.get("bounds") or ()),
                    "area_ratio": float(meta.get("areaRatio") or meta.get("area_ratio") or 0),
                    "center": tuple(meta.get("center") or ()),
                    "patch": patch,
                    "mask": mask,
                }
        except Exception as error:
            self._write_persistence_diagnostic("object-cache-load-failed", error)

    def _persist_object_cache(self) -> None:
        cache_dir = self.options.get("cache_dir") or ""
        if not cache_dir or not self.texture_cache:
            return
        objects_dir = os.path.join(cache_dir, "objects")
        for object_key, entry in list(self.texture_cache.items()):
            try:
                patch = entry.get("patch")
                if not isinstance(patch, np.ndarray) or patch.size == 0:
                    continue
                frame_index = int(entry.get("frame_index") or 0)
                object_dir = os.path.join(objects_dir, _safe_cache_key(object_key))
                patch_name = f"patch_{frame_index:06d}.png"
                mask_name = f"mask_{frame_index:06d}.png"
                patch_path = os.path.join(object_dir, patch_name)
                mask_path = os.path.join(object_dir, mask_name)

                _write_image(patch_path, patch)
                mask = entry.get("mask")
                if isinstance(mask, np.ndarray) and mask.size > 0:
                    _write_image(mask_path, mask)
                else:
                    _write_image(
                        mask_path,
                        np.full(patch.shape[:2], 255, dtype=np.uint8),
                    )

                meta = {
                    "version": STATE_VERSION,
                    "objectKey": object_key or DEFAULT_OBJECT_KEY,
                    "safeKey": _safe_cache_key(object_key),
                    "lastReliableFrameIndex": frame_index,
                    "bounds": _json_bounds(entry.get("bounds")),
                    "areaRatio": float(entry.get("area_ratio") or 0.0),
                    "center": _json_center(entry.get("center")),
                    "patchPath": patch_name,
                    "maskPath": mask_name,
                    "confidence": 1.0,
                    "configSignature": self.options.get("config_signature") or "",
                    "sourceFingerprint": self.options.get("source_fingerprint") or "",
                    "video": {
                        "width": self.options.get("video_width") or 0,
                        "height": self.options.get("video_height") or 0,
                        "fps": self.options.get("fps") or 0,
                    },
                }
                _write_json_atomic(os.path.join(object_dir, "meta.json"), meta)
            except Exception as error:
                self._write_persistence_diagnostic("object-cache-write-failed", error)

    def finalize_batch(self) -> None:
        if not self.enabled:
            return
        try:
            self._persist_previous_state()
        except Exception as error:
            self._write_persistence_diagnostic("state-write-failed", error)
        try:
            self._persist_object_cache()
        except Exception as error:
            self._write_persistence_diagnostic("object-cache-write-failed", error)

    def _write_persistence_diagnostic(self, event: str, error: Exception) -> None:
        self._write_diagnostic(
            {
                "enabled": self.enabled,
                "applied": False,
                "fallback": True,
                "skip_reason": event,
                "event": event,
                "error": str(error),
                "frame_index": int((self.previous or {}).get("frame_index") or -1),
            }
        )

    def _write_diagnostic(self, decision: Dict[str, Any], output_path: str = "") -> None:
        if not self.options["diagnostics"]:
            return
        diagnostics_path = self.options.get("diagnostics_path")
        if not diagnostics_path:
            return
        payload = {
            **decision,
            "batch_id": self.batch_id,
            "output_path": output_path,
        }
        try:
            diagnostics_dir = os.path.dirname(diagnostics_path)
            if diagnostics_dir:
                os.makedirs(diagnostics_dir, exist_ok=True)
            with open(diagnostics_path, "a", encoding="utf-8") as fp:
                fp.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except OSError:
            return
