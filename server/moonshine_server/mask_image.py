from __future__ import annotations

import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image


def binary_mask_from_pil(image: Image.Image) -> np.ndarray:
    """Convert a mask image to the application's binary selection semantics."""
    if "A" in image.getbands():
        source = np.asarray(image.getchannel("A"))
        selected = source > 0
    elif image.mode == "P" and "transparency" in image.info:
        source = np.asarray(image.convert("RGBA").getchannel("A"))
        selected = source > 0
    else:
        source = np.asarray(image.convert("L"))
        selected = source > 127
    return np.where(selected, 255, 0).astype(np.uint8)


def binary_mask_from_bytes(payload: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as image:
        return binary_mask_from_pil(image)


def decode_binary_mask(value: str, value_type: str = "base64") -> np.ndarray:
    if value_type == "base64":
        raw = value.split(",", 1)[1] if "," in value else value
        return binary_mask_from_bytes(base64.b64decode(raw))
    return read_binary_mask_path(value)


def read_binary_mask_path(path: str | Path) -> np.ndarray:
    mask_path = Path(path)
    if not mask_path.is_file():
        raise FileNotFoundError(f"Mask file not found: {mask_path}")
    with Image.open(mask_path) as image:
        return binary_mask_from_pil(image)


def resize_binary_mask(mask: np.ndarray, image_shape) -> tuple[np.ndarray, bool]:
    image_height, image_width = image_shape[:2]
    resized = mask.shape != (image_height, image_width)
    if not resized:
        return mask, False

    resampling = getattr(Image, "Resampling", Image)
    resized_mask = Image.fromarray(mask).resize(
        (image_width, image_height),
        resample=resampling.NEAREST,
    )
    return np.asarray(resized_mask, dtype=np.uint8), True
