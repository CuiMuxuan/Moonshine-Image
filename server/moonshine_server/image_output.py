from pathlib import Path
from typing import Any, Optional

from PIL import Image

from moonshine_server.helper import pil_to_bytes


SUPPORTED_IMAGE_OUTPUT_FORMATS = frozenset({"png", "jpg", "webp"})
IMAGE_OUTPUT_MIME_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "webp": "image/webp",
}
IMAGE_OUTPUT_EXTENSIONS = {
    "png": ".png",
    "jpg": ".jpg",
    "webp": ".webp",
}


def normalize_image_output_format(value: Any, fallback: str = "auto") -> str:
    normalized = str(value or "").strip().lower()
    if normalized == "jpeg":
        normalized = "jpg"
    if normalized in {"auto", "original"} or normalized in SUPPORTED_IMAGE_OUTPUT_FORMATS:
        return normalized
    return fallback


def normalize_image_format(value: Any) -> str:
    normalized = str(value or "").strip().lower().lstrip(".")
    if normalized == "jpeg":
        normalized = "jpg"
    if normalized in SUPPORTED_IMAGE_OUTPUT_FORMATS:
        return normalized
    return ""


def normalize_image_output_quality(value: Any, fallback: int = 95) -> int:
    try:
        numeric = int(round(float(value)))
    except (TypeError, ValueError):
        numeric = fallback
    return max(1, min(100, numeric))


def image_format_from_path(path_value: Any) -> str:
    suffix = Path(str(path_value or "")).suffix
    return normalize_image_format(suffix)


def has_pil_alpha(image: Image.Image) -> bool:
    if image.mode in {"RGBA", "LA"}:
        return True
    if image.mode == "P":
        return "transparency" in image.info
    return False


def resolve_image_output_spec(
    requested_format: Any = "auto",
    source_format: Any = "",
    has_alpha: bool = False,
    quality: Any = 95,
) -> dict:
    requested = normalize_image_output_format(requested_format)
    source = normalize_image_format(source_format)

    if requested in SUPPORTED_IMAGE_OUTPUT_FORMATS:
        output_format = requested
    elif requested == "original" and source:
        output_format = source
    elif requested == "auto" and source:
        output_format = source
    else:
        output_format = "png"

    # Auto/original should protect alpha. Explicit JPG is allowed and flattened.
    if has_alpha and output_format == "jpg" and requested not in SUPPORTED_IMAGE_OUTPUT_FORMATS:
        output_format = "png"

    return {
        "format": output_format,
        "mime_type": IMAGE_OUTPUT_MIME_TYPES[output_format],
        "extension": IMAGE_OUTPUT_EXTENSIONS[output_format],
        "quality": normalize_image_output_quality(quality),
    }


def _sanitize_pil_infos(infos: Optional[dict]) -> dict:
    if not isinstance(infos, dict):
        return {}
    return {
        key: value
        for key, value in infos.items()
        if key not in {"format", "source_format"} and value is not None
    }


def _flatten_alpha_to_white(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def prepare_pil_for_output(image: Image.Image, output_format: str) -> Image.Image:
    normalized_format = normalize_image_format(output_format) or "png"
    if normalized_format == "jpg":
        if has_pil_alpha(image):
            return _flatten_alpha_to_white(image)
        return image.convert("RGB")
    if normalized_format == "webp":
        return image.convert("RGBA" if has_pil_alpha(image) else "RGB")
    return image


def encode_pil_image(
    image: Image.Image,
    output_format: str,
    quality: Any = 95,
    infos: Optional[dict] = None,
) -> bytes:
    normalized_format = normalize_image_format(output_format) or "png"
    prepared_image = prepare_pil_for_output(image, normalized_format)
    return pil_to_bytes(
        prepared_image,
        ext=normalized_format,
        quality=normalize_image_output_quality(quality),
        infos=_sanitize_pil_infos(infos),
    )


def build_image_data_url(image_bytes: bytes, mime_type: str) -> str:
    import base64

    return f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('utf-8')}"
