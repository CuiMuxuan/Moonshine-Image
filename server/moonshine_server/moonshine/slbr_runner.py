import argparse
import base64
import math
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable, Optional

import cv2
import numpy as np
import torch
from loguru import logger
from PIL import Image

from moonshine_server.helper import concat_alpha_channel
from moonshine_server.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space
from moonshine_server.image_output import (
    encode_pil_image,
    image_format_from_path,
    resolve_image_output_spec,
)
from moonshine_server.mask_image import read_binary_mask_path, resize_binary_mask

VALID_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
DEFAULT_TILE_SIZE = 384
DEFAULT_TILE_BATCH = 4
MAX_TILE_BATCH = 32
LOCAL_INFERENCE_STRATEGIES = {"auto", "full", "smart_tiles"}
DEFAULT_LOCAL_BBOX_EMPTY_RATIO_THRESHOLD = 50
DEFAULT_LOCAL_EDGE_FEATHER_PX = 2
MIN_SMART_TILE_SAVING_RATIO = 0.15

RUNTIME_ROOT = Path(__file__).resolve().parent / "slbr_runtime"


@contextmanager
def _slbr_runtime_path():
    runtime_path = str(RUNTIME_ROOT)
    already_present = runtime_path in sys.path
    if not already_present:
        sys.path.insert(0, runtime_path)
    try:
        yield
    finally:
        if not already_present:
            try:
                sys.path.remove(runtime_path)
            except ValueError:
                pass


def _build_model_args(checkpoint_path: Path, device: torch.device):
    return SimpleNamespace(
        nets="slbr",
        models="slbr",
        name="slbr_v1",
        input_size=256,
        crop_size=256,
        checkpoint=str(checkpoint_path.parent),
        resume=str(checkpoint_path),
        evaluate=True,
        preprocess="resize",
        no_flip=True,
        mask_mode="res",
        bg_mode="res_mask",
        sim_metric="cos",
        k_center=2,
        project_mode="simple",
        use_refine=True,
        k_refine=3,
        k_skip_stage=3,
        gpu=device.type == "cuda",
        gpu_id="0",
    )


def clamp_tile_size(value) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return DEFAULT_TILE_SIZE
    return normalized if normalized in {256, 384, 512} else DEFAULT_TILE_SIZE


def clamp_tile_batch(value) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return DEFAULT_TILE_BATCH
    return max(1, min(MAX_TILE_BATCH, normalized))


def get_overlap_for_tile_size(tile_size: int) -> int:
    return max(1, int(tile_size) // 4)


def recommend_slbr_params(cuda_info: Optional[dict] = None) -> dict:
    cuda_info = cuda_info or {}
    if not cuda_info.get("cuda_available"):
        tile_size, tile_batch = 256, 1
    else:
        free_memory_mb = cuda_info.get("free_memory_mb")
        total_memory_mb = cuda_info.get("total_memory_mb")
        memory_mb = float(free_memory_mb or total_memory_mb or 0)
        if memory_mb >= 12000:
            tile_size, tile_batch = 512, 4
        elif memory_mb >= 8000:
            tile_size, tile_batch = 384, 4
        elif memory_mb >= 6000:
            tile_size, tile_batch = 384, 3
        elif memory_mb >= 4000:
            tile_size, tile_batch = 384, 2
        elif memory_mb >= 2000:
            tile_size, tile_batch = 256, 4
        else:
            tile_size, tile_batch = 256, 1

    return {
        "tile_size": tile_size,
        "tile_batch": tile_batch,
        "overlap": get_overlap_for_tile_size(tile_size),
        "pad_multiple": 16,
    }


def _image_to_tensor(image_bgr: np.ndarray) -> torch.Tensor:
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return torch.from_numpy(image_rgb.transpose(2, 0, 1))


def _tensor_to_bgr(image: torch.Tensor) -> np.ndarray:
    image = image.detach().cpu().clamp(0, 1).numpy()
    image = (image.transpose(1, 2, 0) * 255.0).round().astype(np.uint8)
    return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)


def _mask_to_bgr(mask: torch.Tensor) -> np.ndarray:
    mask = mask.detach().cpu().clamp(0, 1).numpy()
    mask = (mask.squeeze(0) * 255.0).round().astype(np.uint8)
    return cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)


def _ceil_to_multiple(value: int, multiple: int) -> int:
    return int(math.ceil(value / multiple) * multiple)


def _grid_canvas_size(length: int, tile_size: int, stride: int, pad_multiple: int) -> int:
    target = max(length, tile_size)
    if target > tile_size:
        steps = int(math.ceil((target - tile_size) / stride))
        target = tile_size + steps * stride
    if pad_multiple > 1:
        target = _ceil_to_multiple(target, pad_multiple)
        if target > tile_size:
            steps = int(math.ceil((target - tile_size) / stride))
            target = tile_size + steps * stride
    return target


def _pad_center_black(image: np.ndarray, tile_size: int, overlap: int, pad_multiple: int):
    stride = tile_size - overlap
    height, width = image.shape[:2]
    canvas_height = _grid_canvas_size(height, tile_size, stride, pad_multiple)
    canvas_width = _grid_canvas_size(width, tile_size, stride, pad_multiple)

    top = (canvas_height - height) // 2
    left = (canvas_width - width) // 2
    canvas = np.zeros((canvas_height, canvas_width, 3), dtype=image.dtype)
    canvas[top:top + height, left:left + width] = image
    return canvas, (top, left, height, width)


def _tile_positions(length: int, tile_size: int, stride: int):
    if length <= tile_size:
        return [0]
    positions = list(range(0, length - tile_size + 1, stride))
    last = length - tile_size
    if positions[-1] != last:
        positions.append(last)
    return positions


def _blend_weight(tile_size: int, overlap: int, min_weight: float = 0.05):
    if overlap <= 0:
        return torch.ones(1, tile_size, tile_size)

    weight = torch.ones(tile_size, dtype=torch.float32)
    ramp = torch.linspace(min_weight, 1.0, steps=overlap, dtype=torch.float32)
    weight[:overlap] = ramp
    weight[-overlap:] = ramp.flip(0)
    return weight.view(1, tile_size, 1) * weight.view(1, 1, tile_size)


def normalize_local_inference_strategy(value) -> str:
    normalized = str(value or "auto").strip().lower()
    return normalized if normalized in LOCAL_INFERENCE_STRATEGIES else "auto"


def clamp_local_bbox_empty_ratio_threshold(value) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return DEFAULT_LOCAL_BBOX_EMPTY_RATIO_THRESHOLD
    return max(1, min(99, normalized))


def clamp_local_edge_feather_px(value) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return DEFAULT_LOCAL_EDGE_FEATHER_PX
    return max(0, min(16, normalized))


def _effective_local_mask(mask, image_shape) -> np.ndarray:
    normalized = np.asarray(mask)
    if normalized.ndim == 3:
        normalized = normalized[:, :, 0]
    if normalized.ndim != 2:
        raise ValueError("SLBR local mask must be a single-channel image")
    height, width = image_shape[:2]
    if normalized.shape != (height, width):
        raise ValueError(
            "SLBR local mask size must match the source image size: "
            f"expected {(height, width)}, got {normalized.shape}"
        )
    return normalized > 0


def plan_local_tile_inference(
    image_shape,
    mask,
    tile_size: int = DEFAULT_TILE_SIZE,
    strategy: str = "auto",
    bbox_empty_ratio_threshold: int = DEFAULT_LOCAL_BBOX_EMPTY_RATIO_THRESHOLD,
    pad_multiple: int = 16,
) -> dict:
    """Build a local plan from the same canonical grid as full-image SLBR inference."""
    effective_mask = _effective_local_mask(mask, image_shape)
    if not np.any(effective_mask):
        raise ValueError("SLBR local processing requires a non-empty mask")

    tile_size = clamp_tile_size(tile_size)
    normalized_strategy = normalize_local_inference_strategy(strategy)
    empty_ratio_threshold = clamp_local_bbox_empty_ratio_threshold(
        bbox_empty_ratio_threshold
    )
    overlap = get_overlap_for_tile_size(tile_size)
    stride = tile_size - overlap
    image_height, image_width = effective_mask.shape
    canvas_height = _grid_canvas_size(image_height, tile_size, stride, pad_multiple)
    canvas_width = _grid_canvas_size(image_width, tile_size, stride, pad_multiple)
    top = (canvas_height - image_height) // 2
    left = (canvas_width - image_width) // 2

    ys, xs = np.where(effective_mask)
    bbox_y0 = int(ys.min())
    bbox_y1 = int(ys.max()) + 1
    bbox_x0 = int(xs.min())
    bbox_x1 = int(xs.max()) + 1
    bbox_area = (bbox_y1 - bbox_y0) * (bbox_x1 - bbox_x0)
    effective_mask_pixels = int(effective_mask[bbox_y0:bbox_y1, bbox_x0:bbox_x1].sum())
    effective_mask_coverage = effective_mask_pixels / float(bbox_area)
    bbox_empty_ratio = 1.0 - effective_mask_coverage

    canvas_bbox_y0 = top + bbox_y0
    canvas_bbox_y1 = top + bbox_y1
    canvas_bbox_x0 = left + bbox_x0
    canvas_bbox_x1 = left + bbox_x1
    full_tile_positions = [
        (y, x)
        for y in _tile_positions(canvas_height, tile_size, stride)
        for x in _tile_positions(canvas_width, tile_size, stride)
    ]
    local_tile_positions = [
        (y, x)
        for y, x in full_tile_positions
        if y < canvas_bbox_y1
        and y + tile_size > canvas_bbox_y0
        and x < canvas_bbox_x1
        and x + tile_size > canvas_bbox_x0
    ]
    full_tile_count = len(full_tile_positions)
    local_tile_count = len(local_tile_positions)
    tile_saving_ratio = (
        (full_tile_count - local_tile_count) / float(full_tile_count)
        if full_tile_count
        else 0.0
    )

    fallback_reason = ""
    if normalized_strategy == "full":
        inference_strategy = "full"
        fallback_reason = "forced_full"
    elif normalized_strategy == "smart_tiles":
        inference_strategy = "smart_tiles"
    elif bbox_empty_ratio >= empty_ratio_threshold / 100.0:
        inference_strategy = "full"
        fallback_reason = "bbox_empty_ratio_threshold"
    elif tile_saving_ratio < MIN_SMART_TILE_SAVING_RATIO:
        inference_strategy = "full"
        fallback_reason = "tile_saving_below_minimum"
    else:
        inference_strategy = "smart_tiles"

    return {
        "requested_strategy": normalized_strategy,
        "inference_strategy": inference_strategy,
        "fallback_reason": fallback_reason,
        "bbox_empty_ratio": bbox_empty_ratio,
        "effective_mask_coverage": effective_mask_coverage,
        "full_tile_count": full_tile_count,
        "local_tile_count": local_tile_count,
        "tile_saving_ratio": tile_saving_ratio,
        "tile_size": tile_size,
        "tile_positions": local_tile_positions,
    }


def local_composite_alpha(mask, edge_feather_px: int = DEFAULT_LOCAL_EDGE_FEATHER_PX) -> np.ndarray:
    effective_mask = np.asarray(mask) > 0
    feather = clamp_local_edge_feather_px(edge_feather_px)
    if feather == 0:
        return effective_mask.astype(np.float32)

    # Replicate the real image edge so an edge-touching mask never fades toward virtual pixels.
    padded = cv2.copyMakeBorder(
        effective_mask.astype(np.uint8) * 255,
        feather,
        feather,
        feather,
        feather,
        cv2.BORDER_REPLICATE,
    )
    distance = cv2.distanceTransform(padded, cv2.DIST_L2, 5)[
        feather:-feather,
        feather:-feather,
    ]
    alpha = np.minimum(distance / float(feather), 1.0).astype(np.float32)
    alpha[~effective_mask] = 0.0
    return alpha


def compose_local_result(
    original_bgr: np.ndarray,
    clean_bgr: np.ndarray,
    mask,
    edge_feather_px: int = DEFAULT_LOCAL_EDGE_FEATHER_PX,
) -> np.ndarray:
    if original_bgr.shape != clean_bgr.shape:
        raise ValueError("SLBR local clean result size must match the source image size")
    alpha = local_composite_alpha(mask, edge_feather_px)
    result = original_bgr.copy()
    active = alpha > 0
    if not np.any(active):
        return result
    blended = np.rint(
        original_bgr.astype(np.float32) * (1.0 - alpha[:, :, None])
        + clean_bgr.astype(np.float32) * alpha[:, :, None]
    ).clip(0, 255).astype(np.uint8)
    result[active] = blended[active]
    return result


def read_image_bgr(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Failed to read image: {path}")
    return image


def write_image(path: Path, image: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(path.suffix or ".png", image)
    if not ok:
        raise ValueError(f"Failed to encode image: {path}")
    encoded.tofile(str(path))


def gather_images(source: Path, output_dir: Path | None = None) -> list[Path]:
    source = Path(source).resolve()
    resolved_output_dir = Path(output_dir).resolve() if output_dir else None
    if source.is_file():
        return [source]

    images = []
    for path in source.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VALID_IMAGE_EXTENSIONS:
            continue
        if resolved_output_dir is not None:
            try:
                if path.resolve().is_relative_to(resolved_output_dir):
                    continue
            except ValueError:
                pass
        images.append(path)
    return sorted(images)


def _output_collision_key(source: Path, image_path: Path) -> tuple[str, str]:
    source = Path(source).resolve()
    image_path = Path(image_path).resolve()
    if source.is_dir():
        relative = image_path.relative_to(source)
        return relative.parent.as_posix().casefold(), relative.stem.casefold()
    return "", image_path.stem.casefold()


def build_output_collision_keys(source: Path, images: Iterable[Path]) -> set[tuple[str, str]]:
    counts: dict[tuple[str, str], int] = {}
    for image_path in images:
        key = _output_collision_key(source, image_path)
        counts[key] = counts.get(key, 0) + 1
    return {key for key, count in counts.items() if count > 1}


def build_output_stem_plan(source: Path, images: Iterable[Path]) -> dict[Path, str]:
    """Reserve deterministic, unique output stems within each relative directory."""
    source = Path(source).resolve()
    resolved_images = [Path(image_path).resolve() for image_path in images]
    collision_keys = build_output_collision_keys(source, resolved_images)
    records = []
    for image_path in resolved_images:
        if source.is_dir():
            relative = image_path.relative_to(source)
        else:
            relative = Path(image_path.name)
        collision = _output_collision_key(source, image_path) in collision_keys
        source_extension = image_path.suffix.lower().lstrip(".") or "image"
        preferred_stem = (
            f"{relative.stem}_{source_extension}" if collision else relative.stem
        )
        records.append(
            {
                "image_path": image_path,
                "parent": relative.parent.as_posix().casefold(),
                "relative": relative.as_posix(),
                "collision": collision,
                "source_extension": source_extension,
                "preferred_stem": preferred_stem,
            }
        )

    # Reserve unchanged names first so collision-derived names adapt around them.
    records.sort(
        key=lambda record: (
            record["collision"],
            record["relative"].casefold(),
            record["relative"],
        )
    )
    reserved: set[tuple[str, str]] = set()
    plan: dict[Path, str] = {}
    for record in records:
        preferred_stem = record["preferred_stem"]
        candidate = preferred_stem
        attempt = 0
        while (record["parent"], candidate.casefold()) in reserved:
            attempt += 1
            suffix = record["source_extension"]
            candidate = (
                f"{preferred_stem}_{suffix}"
                if attempt == 1
                else f"{preferred_stem}_{suffix}_{attempt}"
            )
        reserved.add((record["parent"], candidate.casefold()))
        plan[record["image_path"]] = candidate
    return plan


def output_path_for(
    source: Path,
    image_path: Path,
    output_dir: Path,
    extension: str = ".png",
    *,
    collision_keys: set[tuple[str, str]] | None = None,
    output_stem: str | None = None,
) -> Path:
    source = Path(source).resolve()
    image_path = Path(image_path).resolve()
    output_dir = Path(output_dir).resolve()
    output_extension = extension if str(extension or "").startswith(".") else f".{extension}"
    if source.is_dir():
        relative = image_path.relative_to(source)
        parent = output_dir / relative.parent
        stem = relative.stem
    else:
        parent = output_dir
        stem = image_path.stem
    if output_stem:
        stem = output_stem
    elif collision_keys and _output_collision_key(source, image_path) in collision_keys:
        source_extension = image_path.suffix.lower().lstrip(".") or "image"
        stem = f"{stem}_{source_extension}"
    return parent / f"{stem}_clean{output_extension}"


def read_image_alpha(path: Path):
    with Image.open(path) as image:
        source_format = image_format_from_path(path) or str(image.format or "")
        infos = dict(image.info)
        if image.mode == "RGBA":
            return np.array(image.getchannel("A")), source_format, infos
        return None, source_format, infos


def read_folder_mask(path: Path, image_shape) -> tuple[np.ndarray, bool]:
    return resize_binary_mask(read_binary_mask_path(path), image_shape)


def build_folder_mask_lookup(mask_folder: str | Path | None) -> dict:
    if not mask_folder:
        return {"relative_exact": {}, "relative": {}, "stem": {}}

    root = Path(mask_folder)
    if not root.is_dir():
        raise FileNotFoundError(f"Mask folder not found: {root}")

    by_relative_exact = {}
    by_relative = {}
    by_stem = {}
    duplicate_relative_keys = set()
    duplicate_stems = set()
    for mask_path in root.rglob("*"):
        if not mask_path.is_file() or mask_path.suffix.lower() not in VALID_IMAGE_EXTENSIONS:
            continue
        relative_exact_key = mask_path.relative_to(root).as_posix().lower()
        relative_key = mask_path.relative_to(root).with_suffix("").as_posix().lower()
        stem_key = mask_path.stem.lower()
        by_relative_exact.setdefault(relative_exact_key, mask_path)
        if relative_key in by_relative and by_relative[relative_key] != mask_path:
            duplicate_relative_keys.add(relative_key)
        else:
            by_relative[relative_key] = mask_path
        if stem_key in by_stem and by_stem[stem_key] != mask_path:
            duplicate_stems.add(stem_key)
        else:
            by_stem[stem_key] = mask_path
    for duplicate_relative_key in duplicate_relative_keys:
        by_relative.pop(duplicate_relative_key, None)
    for duplicate_stem in duplicate_stems:
        by_stem.pop(duplicate_stem, None)
    return {
        "relative_exact": by_relative_exact,
        "relative": by_relative,
        "stem": by_stem,
    }


def resolve_folder_mask_path(
    image_folder: Path,
    image_path: Path,
    mask_lookup: dict,
) -> Path | None:
    match = resolve_folder_mask_match(image_folder, image_path, mask_lookup)
    return match[0] if match else None


def resolve_folder_mask_match(
    image_folder: Path,
    image_path: Path,
    mask_lookup: dict,
    *,
    allow_stem_fallback: bool = True,
) -> tuple[Path, str] | None:
    try:
        relative_exact_key = image_path.relative_to(image_folder).as_posix().lower()
        relative_key = image_path.relative_to(image_folder).with_suffix("").as_posix().lower()
    except ValueError:
        relative_exact_key = image_path.name.lower()
        relative_key = image_path.with_suffix("").name.lower()
    relative_exact_match = mask_lookup.get("relative_exact", {}).get(relative_exact_key)
    if relative_exact_match:
        return relative_exact_match, "relative_path"
    relative_match = mask_lookup["relative"].get(relative_key)
    if relative_match:
        return relative_match, "relative_path"
    stem_match = (
        mask_lookup["stem"].get(image_path.stem.lower())
        if allow_stem_fallback
        else None
    )
    if stem_match:
        return stem_match, "unique_stem"
    return None


def _normalize_missing_mask_behavior(value) -> str:
    normalized = str(value or "full").strip().lower()
    return normalized if normalized in {"current_mask", "full", "skip"} else "full"


def summarize_processing_results(results: list[dict]) -> dict:
    total_count = len(results)
    success_count = sum(1 for result in results if result.get("success", False))
    skipped_count = sum(1 for result in results if result.get("skipped", False))
    failed_count = total_count - success_count - skipped_count

    if failed_count > 0 and success_count == 0:
        status = "failed"
    elif success_count > 0 and (failed_count > 0 or skipped_count > 0):
        status = "partial"
    elif total_count > 0 and skipped_count == total_count:
        status = "skipped"
    else:
        status = "completed"
    return {
        "success": status != "failed",
        "status": status,
        "total_count": total_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "skipped_count": skipped_count,
    }


def iter_folder_local_plans(
    image_folder: str | Path,
    output_folder: str | Path | None = None,
    *,
    mask_folder: str | Path | None = None,
    template_mask_path: str | Path | None = None,
    missing_mask_behavior: str = "full",
    include_mask: bool = False,
):
    image_folder = Path(image_folder).resolve()
    if not image_folder.is_dir():
        raise FileNotFoundError(f"Image folder not found: {image_folder}")

    output_path = Path(output_folder).resolve() if output_folder else None
    images = gather_images(image_folder, output_path)
    collision_keys = build_output_collision_keys(image_folder, images)
    output_stems = build_output_stem_plan(image_folder, images)
    image_stem_counts: dict[str, int] = {}
    for image_path in images:
        stem_key = image_path.stem.lower()
        image_stem_counts[stem_key] = image_stem_counts.get(stem_key, 0) + 1
    normalized_missing_behavior = _normalize_missing_mask_behavior(missing_mask_behavior)
    mask_lookup = build_folder_mask_lookup(mask_folder)
    template_path = Path(template_mask_path) if template_mask_path else None

    if normalized_missing_behavior == "current_mask":
        if not (template_path and template_path.is_file()):
            raise ValueError("SLBR folder local processing requires a valid current-mask template")
        if not np.any(read_binary_mask_path(template_path)):
            raise ValueError("SLBR current-mask template is empty")

    for index, image_path in enumerate(images):
        try:
            with Image.open(image_path) as image:
                image_shape = (image.height, image.width)
            relative_path = image_path.relative_to(image_folder).as_posix()
            candidate_masks: list[tuple[Path, str]] = []
            matched_mask = resolve_folder_mask_match(
                image_folder,
                image_path,
                mask_lookup,
                allow_stem_fallback=image_stem_counts.get(
                    image_path.stem.lower(), 0
                ) == 1,
            )
            if matched_mask:
                candidate_masks.append(matched_mask)
            if normalized_missing_behavior == "current_mask" and template_path:
                candidate_masks.append((template_path, "current_mask"))

            effective_mask = None
            selected_mask_path = None
            mask_source = None
            mask_resized = False
            mask_status = "missing"
            missing_reason = "missing_mask"
            for candidate_path, candidate_source in candidate_masks:
                candidate_mask, candidate_resized = read_folder_mask(
                    candidate_path, image_shape
                )
                if not np.any(candidate_mask):
                    if candidate_source == "current_mask":
                        raise ValueError(
                            "SLBR current-mask template is empty after resizing for "
                            f"{relative_path}"
                        )
                    mask_status = "empty"
                    missing_reason = "empty_mask"
                    continue
                effective_mask = candidate_mask
                selected_mask_path = candidate_path
                mask_source = candidate_source
                mask_resized = candidate_resized
                if candidate_source != "current_mask":
                    mask_status = "valid"
                    missing_reason = None
                break

            if effective_mask is not None:
                apply_scope = "mask"
            elif normalized_missing_behavior == "skip":
                apply_scope = "skip"
            else:
                apply_scope = "full"

            plan = {
                "id": str(index),
                "index": index,
                "image_path": str(image_path),
                "relative_path": relative_path,
                "apply_scope": apply_scope,
                "mask_status": mask_status,
                "missing_reason": missing_reason,
                "output_collision": _output_collision_key(
                    image_folder, image_path
                ) in collision_keys,
                "output_stem": output_stems[image_path.resolve()],
            }
            if selected_mask_path:
                plan.update(
                    {
                        "mask_path": str(selected_mask_path),
                        "mask_source": mask_source,
                        "mask_resized": mask_resized,
                    }
                )
            if include_mask and effective_mask is not None:
                plan["effective_mask"] = effective_mask
            yield plan
        except Exception as error:
            yield {
                "id": str(index),
                "index": index,
                "image_path": str(image_path),
                "relative_path": image_path.relative_to(image_folder).as_posix(),
                "apply_scope": "error",
                "mask_status": "error",
                "success": False,
                "error": str(error),
                "output_collision": _output_collision_key(
                    image_folder, image_path
                ) in collision_keys,
                "output_stem": output_stems[image_path.resolve()],
            }


def write_output_image(path: Path, image_bgr: np.ndarray, alpha_channel, output_spec: dict, infos: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    image_rgb = cv2.cvtColor(image_bgr.astype(np.uint8), cv2.COLOR_BGR2RGB)
    serializable_result = concat_alpha_channel(image_rgb, alpha_channel)
    encoded = encode_pil_image(
        Image.fromarray(serializable_result),
        output_spec["format"],
        output_spec["quality"],
        infos,
    )
    ensure_disk_space(
        path,
        len(encoded),
        safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
        operation="保存 SLBR 文件夹处理结果",
    )
    path.write_bytes(encoded)


class SlbrRunner:
    def __init__(self, model_dir: str | Path, device: str | torch.device = "cpu"):
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.device = torch.device(device)
        self._model = None
        self._lock = threading.Lock()

    @property
    def checkpoint_path(self) -> Path:
        preferred_path = self.model_dir / "slbr.pth.tar"
        if preferred_path.is_file():
            return preferred_path
        return self.model_dir / "slbr" / "model_best.pth.tar"

    @property
    def installed(self) -> bool:
        return self.checkpoint_path.is_file()

    def _load_model(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            if not self.installed:
                raise FileNotFoundError(f"SLBR checkpoint not found: {self.checkpoint_path}")

            logger.info(f"Loading SLBR checkpoint: {self.checkpoint_path}")
            with _slbr_runtime_path():
                from src.networks.resunet import SLBR

                args = _build_model_args(self.checkpoint_path, self.device)
                model = SLBR(args=args, shared_depth=1, blocks=3, long_skip=True)
                checkpoint = torch.load(
                    self.checkpoint_path,
                    map_location=self.device,
                    weights_only=False,
                )
                state_dict = checkpoint.get("state_dict", checkpoint)
                model.load_state_dict(state_dict, strict=True)
                model.to(self.device)
                model.eval()
                self._model = model
            logger.info("SLBR model loaded")
            return self._model

    def _forward(self, batch: torch.Tensor):
        model = self._load_model()
        batch = batch.to(self.device).float()
        with torch.inference_mode():
            pred_images, pred_masks, _ = model(batch)
            pred_image = pred_images[0] if isinstance(pred_images, list) else pred_images
            pred_mask = pred_masks[0]
            final = pred_image * pred_mask + batch * (1 - pred_mask)
        return final.clamp(0, 1), pred_mask.clamp(0, 1)

    def infer_bgr(
        self,
        image_bgr: np.ndarray,
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
        pad_multiple: int = 16,
    ):
        tile_size = clamp_tile_size(tile_size)
        tile_batch = clamp_tile_batch(tile_batch)
        overlap = get_overlap_for_tile_size(tile_size)
        stride = tile_size - overlap

        canvas_bgr, crop = _pad_center_black(image_bgr, tile_size, overlap, pad_multiple)
        canvas = _image_to_tensor(canvas_bgr)
        _, canvas_height, canvas_width = canvas.shape

        ys = _tile_positions(canvas_height, tile_size, stride)
        xs = _tile_positions(canvas_width, tile_size, stride)
        weight = _blend_weight(tile_size, overlap)

        clean_sum = torch.zeros(3, canvas_height, canvas_width, dtype=torch.float32)
        mask_sum = torch.zeros(1, canvas_height, canvas_width, dtype=torch.float32)
        weight_sum = torch.zeros(1, canvas_height, canvas_width, dtype=torch.float32)

        pending_tiles = []
        pending_coords = []

        def flush():
            if not pending_tiles:
                return
            batch = torch.stack(pending_tiles, dim=0)
            clean_batch, mask_batch = self._forward(batch)
            for clean_tile, mask_tile, (y, x) in zip(
                clean_batch.cpu(), mask_batch.cpu(), pending_coords
            ):
                clean_sum[:, y:y + tile_size, x:x + tile_size] += clean_tile * weight
                mask_sum[:, y:y + tile_size, x:x + tile_size] += mask_tile * weight
                weight_sum[:, y:y + tile_size, x:x + tile_size] += weight
            pending_tiles.clear()
            pending_coords.clear()

        for y in ys:
            for x in xs:
                pending_tiles.append(canvas[:, y:y + tile_size, x:x + tile_size])
                pending_coords.append((y, x))
                if len(pending_tiles) >= tile_batch:
                    flush()
        flush()

        clean = clean_sum / weight_sum.clamp_min(1e-6)
        mask = mask_sum / weight_sum.clamp_min(1e-6)
        top, left, height, width = crop
        clean = clean[:, top:top + height, left:left + width]
        mask = mask[:, top:top + height, left:left + width]
        return _tensor_to_bgr(clean), _mask_to_bgr(mask)

    def infer_bgr_selected_tiles(
        self,
        image_bgr: np.ndarray,
        tile_positions: Iterable[tuple[int, int]],
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
        pad_multiple: int = 16,
    ) -> np.ndarray:
        """Infer a subset of the canonical full-image tile grid."""
        tile_size = clamp_tile_size(tile_size)
        tile_batch = clamp_tile_batch(tile_batch)
        overlap = get_overlap_for_tile_size(tile_size)
        selected_positions = list(tile_positions)
        if not selected_positions:
            raise ValueError("SLBR local inference requires at least one tile")

        canvas_bgr, crop = _pad_center_black(image_bgr, tile_size, overlap, pad_multiple)
        canvas = _image_to_tensor(canvas_bgr)
        _, canvas_height, canvas_width = canvas.shape
        for y, x in selected_positions:
            if y < 0 or x < 0 or y + tile_size > canvas_height or x + tile_size > canvas_width:
                raise ValueError("SLBR local tile plan contains an invalid tile position")

        weight = _blend_weight(tile_size, overlap)
        clean_sum = torch.zeros(3, canvas_height, canvas_width, dtype=torch.float32)
        weight_sum = torch.zeros(1, canvas_height, canvas_width, dtype=torch.float32)
        pending_tiles = []
        pending_coords = []

        def flush():
            if not pending_tiles:
                return
            batch = torch.stack(pending_tiles, dim=0)
            clean_batch, _ = self._forward(batch)
            for clean_tile, (y, x) in zip(clean_batch.cpu(), pending_coords):
                clean_sum[:, y:y + tile_size, x:x + tile_size] += clean_tile * weight
                weight_sum[:, y:y + tile_size, x:x + tile_size] += weight
            pending_tiles.clear()
            pending_coords.clear()

        for y, x in selected_positions:
            pending_tiles.append(canvas[:, y:y + tile_size, x:x + tile_size])
            pending_coords.append((y, x))
            if len(pending_tiles) >= tile_batch:
                flush()
        flush()

        clean = clean_sum / weight_sum.clamp_min(1e-6)
        top, left, height, width = crop
        clean = clean[:, top:top + height, left:left + width]
        return _tensor_to_bgr(clean)

    def infer_bgr_local(
        self,
        image_bgr: np.ndarray,
        mask,
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
        strategy: str = "auto",
        bbox_empty_ratio_threshold: int = DEFAULT_LOCAL_BBOX_EMPTY_RATIO_THRESHOLD,
        edge_feather_px: int = DEFAULT_LOCAL_EDGE_FEATHER_PX,
        pad_multiple: int = 16,
    ) -> tuple[np.ndarray, dict]:
        effective_mask = _effective_local_mask(mask, image_bgr.shape)
        plan = plan_local_tile_inference(
            image_bgr.shape,
            effective_mask,
            tile_size=tile_size,
            strategy=strategy,
            bbox_empty_ratio_threshold=bbox_empty_ratio_threshold,
            pad_multiple=pad_multiple,
        )
        if plan["inference_strategy"] == "smart_tiles":
            clean_bgr = self.infer_bgr_selected_tiles(
                image_bgr,
                plan["tile_positions"],
                tile_size=plan["tile_size"],
                tile_batch=tile_batch,
                pad_multiple=pad_multiple,
            )
        else:
            clean_bgr, _ = self.infer_bgr(
                image_bgr,
                tile_size=plan["tile_size"],
                tile_batch=tile_batch,
                pad_multiple=pad_multiple,
            )

        result_bgr = compose_local_result(
            image_bgr,
            clean_bgr,
            effective_mask,
            edge_feather_px=edge_feather_px,
        )
        diagnostics = {
            key: value for key, value in plan.items() if key != "tile_positions"
        }
        diagnostics["edge_feather_px"] = clamp_local_edge_feather_px(edge_feather_px)
        return result_bgr, diagnostics

    def infer_base64(
        self,
        image_base64: str,
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
    ) -> bytes:
        raw = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
        image_bytes = base64.b64decode(raw)
        image_array = np.frombuffer(image_bytes, dtype=np.uint8)
        image_bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
        if image_bgr is None:
            raise ValueError("Failed to decode image payload")
        clean_bgr, _ = self.infer_bgr(image_bgr, tile_size=tile_size, tile_batch=tile_batch)
        ok, encoded = cv2.imencode(".png", clean_bgr)
        if not ok:
            raise ValueError("Failed to encode SLBR result")
        return encoded.tobytes()

    def _process_folder_local(
        self,
        image_folder: Path,
        output_folder: Path,
        tile_size: int,
        tile_batch: int,
        output_format: str,
        output_quality: int,
        mask_folder: str | Path | None,
        template_mask_path: str | Path | None,
        missing_mask_behavior: str,
        local_inference_strategy: str,
        local_bbox_empty_ratio_threshold: int,
        local_edge_feather_px: int,
    ) -> list[dict]:
        image_folder = Path(image_folder).resolve()
        output_folder = Path(output_folder).resolve()
        results = []
        plans = iter_folder_local_plans(
            image_folder,
            output_folder,
            mask_folder=mask_folder,
            template_mask_path=template_mask_path,
            missing_mask_behavior=missing_mask_behavior,
            include_mask=True,
        )
        for plan in plans:
            image_path = Path(plan["image_path"])
            index = plan["index"]
            if plan["apply_scope"] == "error":
                results.append(
                    {
                        key: value
                        for key, value in plan.items()
                        if key not in {"output_collision", "output_stem"}
                    }
                )
                continue
            if plan["apply_scope"] == "skip":
                results.append(
                    {
                        key: value
                        for key, value in plan.items()
                        if key
                        not in {"effective_mask", "output_collision", "output_stem"}
                    }
                    | {
                        "success": False,
                        "skipped": True,
                        "skip_reason": plan["missing_reason"],
                    }
                )
                continue

            try:
                image_bgr = read_image_bgr(image_path)
                alpha_channel, source_format, infos = read_image_alpha(image_path)
                local_diagnostics = None
                if plan["apply_scope"] == "full":
                    clean_bgr, _ = self.infer_bgr(
                        image_bgr,
                        tile_size=tile_size,
                        tile_batch=tile_batch,
                    )
                    output_spec = resolve_image_output_spec(
                        requested_format=output_format,
                        source_format=source_format,
                        has_alpha=alpha_channel is not None,
                        quality=output_quality,
                    )
                    effective_scope = "full"
                    fallback_reason = f"{plan['missing_reason']}_full_image"
                else:
                    clean_bgr, local_diagnostics = self.infer_bgr_local(
                        image_bgr,
                        plan["effective_mask"],
                        tile_size=tile_size,
                        tile_batch=tile_batch,
                        strategy=local_inference_strategy,
                        bbox_empty_ratio_threshold=local_bbox_empty_ratio_threshold,
                        edge_feather_px=local_edge_feather_px,
                    )
                    output_spec = resolve_image_output_spec(
                        requested_format="png",
                        source_format=source_format,
                        has_alpha=alpha_channel is not None,
                        quality=output_quality,
                    )
                    effective_scope = "mask"
                    fallback_reason = local_diagnostics["fallback_reason"] or None

                clean_path = output_path_for(
                    image_folder,
                    image_path,
                    output_folder,
                    output_spec["extension"],
                    output_stem=plan["output_stem"],
                )
                write_output_image(clean_path, clean_bgr, alpha_channel, output_spec, infos)
                result = {
                    key: value
                    for key, value in plan.items()
                    if key not in {"effective_mask", "output_collision", "output_stem"}
                }
                result.update({
                    "output_path": str(clean_path),
                    "success": True,
                    "format": output_spec["format"],
                    "mime_type": output_spec["mime_type"],
                    "extension": output_spec["extension"],
                    "apply_scope": effective_scope,
                    "inference_strategy": (
                        local_diagnostics["inference_strategy"]
                        if local_diagnostics
                        else "full"
                    ),
                    "fallback_reason": fallback_reason,
                })
                if local_diagnostics:
                    result.update(
                        {
                            "bboxEmptyRatio": local_diagnostics["bbox_empty_ratio"],
                            "effectiveMaskCoverage": local_diagnostics[
                                "effective_mask_coverage"
                            ],
                            "fullTileCount": local_diagnostics["full_tile_count"],
                            "localTileCount": local_diagnostics["local_tile_count"],
                            "tileSavingRatio": local_diagnostics["tile_saving_ratio"],
                        }
                    )
                results.append(result)
            except Exception as error:
                logger.exception(f"SLBR local folder item failed: {image_path}")
                results.append(
                    {
                        "id": str(index),
                        "index": index,
                        "image_path": str(image_path),
                        "relative_path": plan.get("relative_path"),
                        "success": False,
                        "error": str(error),
                    }
                )
        return results

    def process_folder(
        self,
        image_folder: str | Path,
        output_folder: str | Path,
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
        output_format: str = "auto",
        output_quality: int = 95,
        apply_scope: str = "full",
        mask_folder: str | Path | None = None,
        template_mask_path: str | Path | None = None,
        missing_mask_behavior: str = "full",
        local_inference_strategy: str = "auto",
        local_bbox_empty_ratio_threshold: int = DEFAULT_LOCAL_BBOX_EMPTY_RATIO_THRESHOLD,
        local_edge_feather_px: int = DEFAULT_LOCAL_EDGE_FEATHER_PX,
    ) -> list[dict]:
        image_folder = Path(image_folder).resolve()
        output_folder = Path(output_folder).resolve()
        if str(apply_scope or "full").strip().lower() == "mask":
            return self._process_folder_local(
                image_folder,
                output_folder,
                tile_size=tile_size,
                tile_batch=tile_batch,
                output_format=output_format,
                output_quality=output_quality,
                mask_folder=mask_folder,
                template_mask_path=template_mask_path,
                missing_mask_behavior=missing_mask_behavior,
                local_inference_strategy=local_inference_strategy,
                local_bbox_empty_ratio_threshold=local_bbox_empty_ratio_threshold,
                local_edge_feather_px=local_edge_feather_px,
            )
        images = gather_images(image_folder, output_folder)
        normalized_output_format = str(output_format or "auto").strip().lower()
        preserve_source_names = normalized_output_format in {"auto", "source"}
        output_stems = (
            {} if preserve_source_names else build_output_stem_plan(image_folder, images)
        )
        results = []
        for index, image_path in enumerate(images):
            try:
                image_bgr = read_image_bgr(image_path)
                alpha_channel, source_format, infos = read_image_alpha(image_path)
                clean_bgr, _ = self.infer_bgr(
                    image_bgr,
                    tile_size=tile_size,
                    tile_batch=tile_batch,
                )
                output_spec = resolve_image_output_spec(
                    requested_format=output_format,
                    source_format=source_format,
                    has_alpha=alpha_channel is not None,
                    quality=output_quality,
                )
                clean_path = output_path_for(
                    image_folder,
                    image_path,
                    output_folder,
                    output_spec["extension"],
                    output_stem=output_stems.get(image_path.resolve()),
                )
                write_output_image(clean_path, clean_bgr, alpha_channel, output_spec, infos)
                results.append(
                    {
                        "id": str(index),
                        "index": index,
                        "image_path": str(image_path),
                        "output_path": str(clean_path),
                        "success": True,
                        "format": output_spec["format"],
                        "mime_type": output_spec["mime_type"],
                        "extension": output_spec["extension"],
                    }
                )
            except Exception as error:
                logger.exception(f"SLBR folder item failed: {image_path}")
                results.append(
                    {
                        "id": str(index),
                        "index": index,
                        "image_path": str(image_path),
                        "success": False,
                        "error": str(error),
                    }
                )
        return results


def create_parser():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--tile_size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--tile_batch", type=int, default=DEFAULT_TILE_BATCH)
    return parser
