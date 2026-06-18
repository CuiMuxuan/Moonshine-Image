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

VALID_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
DEFAULT_TILE_SIZE = 384
DEFAULT_TILE_BATCH = 4
MAX_TILE_BATCH = 32

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


def gather_images(source: Path, output_dir: Path) -> list[Path]:
    source = Path(source).resolve()
    output_dir = Path(output_dir).resolve()
    if source.is_file():
        return [source]

    images = []
    for path in source.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VALID_IMAGE_EXTENSIONS:
            continue
        try:
            if path.resolve().is_relative_to(output_dir):
                continue
        except ValueError:
            pass
        images.append(path)
    return sorted(images)


def output_path_for(source: Path, image_path: Path, output_dir: Path, extension: str = ".png") -> Path:
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
    return parent / f"{stem}_clean{output_extension}"


def read_image_alpha(path: Path):
    with Image.open(path) as image:
        source_format = image_format_from_path(path) or str(image.format or "")
        infos = dict(image.info)
        if image.mode == "RGBA":
            return np.array(image.getchannel("A")), source_format, infos
        return None, source_format, infos


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

    def process_folder(
        self,
        image_folder: str | Path,
        output_folder: str | Path,
        tile_size: int = DEFAULT_TILE_SIZE,
        tile_batch: int = DEFAULT_TILE_BATCH,
        output_format: str = "auto",
        output_quality: int = 95,
    ) -> list[dict]:
        image_folder = Path(image_folder)
        output_folder = Path(output_folder)
        images = gather_images(image_folder, output_folder)
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
