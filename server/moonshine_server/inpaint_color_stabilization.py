from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import cv2
import numpy as np


COLOR_STABILIZATION_MODES = {"off", "auto", "enhanced"}


def normalize_color_stabilization_mode(value: Any) -> str:
    mode = str(value or "auto").strip().lower()
    return mode if mode in COLOR_STABILIZATION_MODES else "auto"


def _binary_mask(mask: np.ndarray) -> np.ndarray:
    if mask.ndim == 3:
        mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    return (mask > 127).astype(np.uint8)


def _mask_bbox(mask_bool: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    ys, xs = np.where(mask_bool > 0)
    if xs.size == 0 or ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _expanded_bbox(
    bbox: Tuple[int, int, int, int],
    width: int,
    height: int,
    padding: int,
) -> Tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    return (
        max(0, x1 - padding),
        max(0, y1 - padding),
        min(width, x2 + padding),
        min(height, y2 + padding),
    )


def _analysis_config(mode: str) -> Dict[str, float]:
    if mode == "enhanced":
        return {
            "ring_radius": 10,
            "flat_mean_std": 8.0,
            "flat_max_std": 12.0,
            "max_mask_ratio": 0.65,
            "match_strength": 0.9,
            "scale_min": 0.5,
            "scale_max": 1.6,
            "feather_sigma": 1.6,
        }
    return {
        "ring_radius": 8,
        "flat_mean_std": 4.5,
        "flat_max_std": 7.0,
        "max_mask_ratio": 0.45,
        "match_strength": 0.75,
        "scale_min": 0.65,
        "scale_max": 1.35,
        "feather_sigma": 1.2,
    }


def _analyze_mask_context(
    image_rgb: np.ndarray,
    mask: np.ndarray,
    mode: str,
) -> Optional[Dict[str, Any]]:
    normalized_mode = normalize_color_stabilization_mode(mode)
    if normalized_mode == "off":
        return None
    if image_rgb is None or mask is None or image_rgb.ndim != 3:
        return None

    height, width = image_rgb.shape[:2]
    mask_bool = _binary_mask(mask)
    if mask_bool.shape[:2] != (height, width):
        mask_bool = cv2.resize(mask_bool, (width, height), interpolation=cv2.INTER_NEAREST)
    mask_area = int(np.count_nonzero(mask_bool))
    if mask_area <= 0:
        return None
    mask_ratio = mask_area / max(1, height * width)
    config = _analysis_config(normalized_mode)
    if mask_ratio > config["max_mask_ratio"]:
        return None

    bbox = _mask_bbox(mask_bool)
    if bbox is None:
        return None

    ring_radius = int(config["ring_radius"])
    rx1, ry1, rx2, ry2 = _expanded_bbox(bbox, width, height, ring_radius * 2)
    roi_mask = mask_bool[ry1:ry2, rx1:rx2]
    if roi_mask.size == 0:
        return None

    kernel_size = ring_radius * 2 + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    dilated = cv2.dilate(roi_mask, kernel, iterations=1)
    ring = (dilated > 0) & (roi_mask == 0)
    ring_count = int(np.count_nonzero(ring))
    if ring_count < max(64, min(512, int(mask_area * 0.02))):
        return None

    roi_image = image_rgb[ry1:ry2, rx1:rx2]
    background_samples = roi_image[ring].astype(np.float32)
    std = np.std(background_samples, axis=0)
    flat_background = bool(
        float(np.mean(std)) <= config["flat_mean_std"]
        and float(np.max(std)) <= config["flat_max_std"]
    )

    return {
        "mode": normalized_mode,
        "config": config,
        "mask": mask_bool,
        "bbox": bbox,
        "roi_bbox": (rx1, ry1, rx2, ry2),
        "roi_mask": roi_mask.astype(bool),
        "ring": ring,
        "background_samples": background_samples,
        "background_median": np.median(background_samples, axis=0),
        "background_mean": np.mean(background_samples, axis=0),
        "background_std": std,
        "flat_background": flat_background,
    }


def _compose_rgb_with_mask(
    base_rgb: np.ndarray,
    replacement_rgb: np.ndarray,
    roi_mask: np.ndarray,
    roi_bbox: Tuple[int, int, int, int],
    sigma: float,
) -> np.ndarray:
    x1, y1, x2, y2 = roi_bbox
    output = base_rgb.astype(np.float32).copy()
    roi_output = output[y1:y2, x1:x2]
    alpha = roi_mask.astype(np.float32)
    if sigma > 0:
        alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=sigma, sigmaY=sigma)
    alpha = np.clip(alpha, 0.0, 1.0)[:, :, np.newaxis]
    roi_output[:] = roi_output * (1.0 - alpha) + replacement_rgb.astype(np.float32) * alpha
    return np.clip(output, 0, 255).astype(np.uint8)


def try_flat_background_fill(
    image_rgb: np.ndarray,
    mask: np.ndarray,
    mode: str = "auto",
) -> Tuple[Optional[np.ndarray], Dict[str, Any]]:
    try:
        context = _analyze_mask_context(image_rgb, mask, mode)
        if not context or not context["flat_background"]:
            return None, {"applied": False, "reason": "not-flat-background"}

        x1, y1, x2, y2 = context["roi_bbox"]
        roi_shape = image_rgb[y1:y2, x1:x2].shape
        fill_rgb = np.zeros(roi_shape, dtype=np.float32)
        fill_rgb[:, :] = context["background_median"]
        stabilized_rgb = _compose_rgb_with_mask(
            image_rgb,
            fill_rgb,
            context["roi_mask"],
            context["roi_bbox"],
            context["config"]["feather_sigma"],
        )
        return cv2.cvtColor(stabilized_rgb, cv2.COLOR_RGB2BGR), {
            "applied": True,
            "method": "flat-background-fill",
        }
    except Exception as error:
        return None, {"applied": False, "reason": "error", "error": str(error)}


def apply_inpaint_color_stabilization(
    image_rgb: np.ndarray,
    mask: np.ndarray,
    result_bgr: np.ndarray,
    mode: str = "auto",
) -> Tuple[np.ndarray, Dict[str, Any]]:
    normalized_mode = normalize_color_stabilization_mode(mode)
    if normalized_mode == "off":
        return result_bgr, {"applied": False, "reason": "disabled"}

    try:
        context = _analyze_mask_context(image_rgb, mask, normalized_mode)
        if not context:
            return result_bgr, {"applied": False, "reason": "no-context"}

        if context["flat_background"]:
            filled_bgr, decision = try_flat_background_fill(image_rgb, mask, normalized_mode)
            if filled_bgr is not None:
                return filled_bgr, decision
            return result_bgr, decision

        x1, y1, x2, y2 = context["roi_bbox"]
        result_rgb = cv2.cvtColor(result_bgr.astype(np.uint8), cv2.COLOR_BGR2RGB)
        roi_result = result_rgb[y1:y2, x1:x2].astype(np.float32)
        roi_mask = context["roi_mask"]
        if int(np.count_nonzero(roi_mask)) < 8:
            return result_bgr, {"applied": False, "reason": "small-mask"}

        source_samples = roi_result[roi_mask]
        source_mean = np.mean(source_samples, axis=0)
        source_std = np.maximum(np.std(source_samples, axis=0), 1.0)
        target_mean = context["background_mean"]
        target_std = np.maximum(context["background_std"], 1.0)
        config = context["config"]
        scale = np.clip(target_std / source_std, config["scale_min"], config["scale_max"])
        strength = float(config["match_strength"])

        matched_roi = roi_result.copy()
        adjusted_samples = (source_samples - source_mean) * scale + target_mean
        blended_samples = source_samples * (1.0 - strength) + adjusted_samples * strength
        matched_roi[roi_mask] = blended_samples
        stabilized_rgb = _compose_rgb_with_mask(
            result_rgb,
            np.clip(matched_roi, 0, 255).astype(np.uint8),
            roi_mask,
            context["roi_bbox"],
            config["feather_sigma"],
        )
        return cv2.cvtColor(stabilized_rgb, cv2.COLOR_RGB2BGR), {
            "applied": True,
            "method": "local-color-match",
        }
    except Exception as error:
        return result_bgr, {"applied": False, "reason": "error", "error": str(error)}
