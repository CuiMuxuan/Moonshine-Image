import base64
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import io
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from threading import RLock
from typing import Callable, Optional

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

from moonshine_server.helper import decode_base64_to_image, numpy_to_bytes
from moonshine_server.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space
from moonshine_server.moonshine.model_registry import build_model_status
from moonshine_server.plugins.segment_anything import SamPredictor, sam_model_registry
from moonshine_server.plugins.segment_anything2.build_sam import (
    build_sam2,
    build_sam2_video_predictor,
)
from moonshine_server.plugins.segment_anything2.modeling.sam import transformer as sam2_transformer
from moonshine_server.plugins.segment_anything2.sam2_image_predictor import SAM2ImagePredictor


SAM1_MODEL_TYPES = {
    "sam_vit_b": "vit_b",
    "sam_vit_l": "vit_l",
    "sam_vit_h": "vit_h",
}

SAM2_MODEL_TYPES = {
    "sam2_hiera_tiny": "sam2_tiny",
    "sam2_hiera_small": "sam2_small",
    "sam2_hiera_base_plus": "sam2_base",
    "sam2_hiera_large": "sam2_large",
    "sam2_1_hiera_tiny": "sam2_1_tiny",
    "sam2_1_hiera_small": "sam2_1_small",
    "sam2_1_hiera_base_plus": "sam2_1_base",
    "sam2_1_hiera_large": "sam2_1_large",
}

POINT_BOX_FAMILIES = {"sam", "sam2"}
TEXT_FAMILIES = {"sam3"}
SAM_VIDEO_MASK_JPEG_QUALITY = 88
SAM_VIDEO_MASK_BYTES_PER_PIXEL_ESTIMATE = 0.18

SAM3_REQUIRED_MODULES = {
    "sam3": "sam3",
    "iopath": "iopath",
    "hydra": "hydra",
    "omegaconf": "omegaconf",
    "einops": "einops",
    "ftfy": "ftfy",
    "pycocotools": "pycocotools",
    "psutil": "psutil",
    "triton": "triton",
}

SAM3_OPTIONAL_MODULES = {
    "ninja": "ninja",
    "flash_attn": "flash_attn",
    "cc_torch": "cc_torch",
}

SAM3_TEXT_MODEL_IDS = {"sam3", "sam3_1_multiplex"}
SAM3_TEXT_DEFAULT_MODEL_ID = "sam3_1_multiplex"
SAM3_TEXT_PENDING_MODELS = {}
SAM3_1_MISSING_KEYS_WARNING = (
    "sam3.1_multiplex.pt may log non-blocking missing keys for "
    "backbone.vision_backbone.convs.3.conv_1x1.* and "
    "backbone.vision_backbone.convs.3.conv_3x3.* during loading. "
    "The current local CUDA smoke still passed; keep this warning visible "
    "in release diagnostics."
)

SAM3_ZH_PROMPT_TERMS = (
    ("深红色", "dark red"),
    ("浅红色", "light red"),
    ("红色", "red"),
    ("蓝色", "blue"),
    ("绿色", "green"),
    ("黄色", "yellow"),
    ("黑色", "black"),
    ("白色", "white"),
    ("紫色", "purple"),
    ("橙色", "orange"),
    ("粉色", "pink"),
    ("灰色", "gray"),
    ("棕色", "brown"),
    ("长方形", "rectangle"),
    ("正方形", "square"),
    ("矩形", "rectangle"),
    ("方形", "square"),
    ("圆形", "circle"),
    ("三角形", "triangle"),
    ("水印", "watermark"),
    ("文字", "text"),
    ("文本", "text"),
    ("标志", "logo"),
    ("图标", "icon"),
    ("人物", "person"),
    ("人像", "person"),
    ("男人", "man"),
    ("女人", "woman"),
    ("小孩", "child"),
    ("儿童", "child"),
    ("汽车", "car"),
    ("车辆", "vehicle"),
    ("自行车", "bicycle"),
    ("摩托车", "motorcycle"),
    ("猫", "cat"),
    ("狗", "dog"),
    ("树", "tree"),
    ("花", "flower"),
    ("天空", "sky"),
    ("云", "cloud"),
    ("建筑", "building"),
    ("房子", "house"),
    ("道路", "road"),
    ("红", "red"),
    ("蓝", "blue"),
    ("绿", "green"),
    ("黄", "yellow"),
    ("黑", "black"),
    ("白", "white"),
    ("圆", "circle"),
    ("车", "car"),
)

SAM3_ZH_PROMPT_STOPWORDS = ("一个", "一只", "一辆", "这张", "图片中", "图中", "里面", "的", "和")


class SamServiceError(RuntimeError):
    pass


class SamService:
    def __init__(self, model_dir: Path, device: str = "cpu"):
        self.model_dir = Path(model_dir).expanduser().resolve()
        self.device = self._resolve_device(device)
        self._predictors = {}
        self._video_predictors = {}
        self._text_predictors = {}
        self._image_cache = {}
        self._text_image_cache = {}
        self._lock = RLock()

    @staticmethod
    def _resolve_device(device: str) -> str:
        requested = str(device or "cpu").strip().lower()
        if requested == "cuda" and not torch.cuda.is_available():
            return "cpu"
        return requested if requested in {"cpu", "cuda", "mps"} else "cpu"

    def _get_model_status(self, model_id: str) -> dict:
        model = next((item for item in self._build_status() if item.get("id") == model_id), None)
        if model is None:
            raise SamServiceError(f"Unknown SAM model: {model_id}")
        if model.get("family") not in POINT_BOX_FAMILIES:
            raise SamServiceError(f"Only SAM1/SAM2 point/box prediction is enabled now: {model_id}")
        if not model.get("installed"):
            missing = ", ".join(model.get("missingFiles") or [])
            raise SamServiceError(f"SAM model is not installed: {model_id}. Missing: {missing}")
        return model

    def _build_status(self) -> list[dict]:
        cuda_info = None
        if self.device == "cuda":
            cuda_info = {"cuda_available": torch.cuda.is_available(), "cuda_compatible": True}
            if torch.cuda.is_available():
                total_memory = torch.cuda.get_device_properties(0).total_memory
                cuda_info["total_memory_mb"] = int(total_memory / 1024 / 1024)

        return build_model_status(self.model_dir, cuda_info)

    @staticmethod
    def _module_status(modules: dict[str, str]) -> dict:
        installed = {
            name: importlib.util.find_spec(module_name) is not None
            for name, module_name in modules.items()
        }
        return {
            "installed": installed,
            "missing": [name for name, present in installed.items() if not present],
        }

    @staticmethod
    def _sam3_numpy_status() -> dict:
        requirement = ">=1.26,<2"
        try:
            version = importlib.metadata.version("numpy")
        except importlib.metadata.PackageNotFoundError:
            return {
                "package": "numpy",
                "requirement": requirement,
                "version": None,
                "compatible": False,
                "runtimeCompatible": False,
                "officialCompatible": False,
                "reason": "numpy is not installed",
                "warning": None,
            }

        parts = []
        for part in version.split("."):
            digits = "".join(ch for ch in part if ch.isdigit())
            if digits == "":
                break
            parts.append(int(digits))
        major = parts[0] if parts else 0
        minor = parts[1] if len(parts) > 1 else 0
        official_compatible = major == 1 and minor >= 26
        runtime_compatible = major >= 1
        warning = None
        if runtime_compatible and not official_compatible:
            warning = (
                f"Official SAM3 metadata declares numpy {requirement}; "
                f"current runtime uses numpy {version}. Keeping this as a "
                "warning because the existing Moonshine runtime also depends on "
                "numpy 2.x and SAM3 image text smoke passed with this version."
            )
        return {
            "package": "numpy",
            "requirement": requirement,
            "version": version,
            "compatible": runtime_compatible,
            "runtimeCompatible": runtime_compatible,
            "officialCompatible": official_compatible,
            "reason": None if runtime_compatible else f"SAM3 requires numpy {requirement}",
            "warning": warning,
        }

    def _sam3_runtime_status(self) -> dict:
        required_modules = self._module_status(SAM3_REQUIRED_MODULES)
        optional_modules = self._module_status(SAM3_OPTIONAL_MODULES)
        numpy_status = self._sam3_numpy_status()
        device_ready = self.device == "cuda" and torch.cuda.is_available()
        runtime_ready = (
            len(required_modules["missing"]) == 0
            and bool(numpy_status["runtimeCompatible"])
        )
        return {
            "runtimeReady": runtime_ready,
            "deviceReady": device_ready,
            "requiredModules": required_modules,
            "optionalModules": optional_modules,
            "versionRequirements": {
                "numpy": numpy_status,
            },
            "reason": None
            if runtime_ready and device_ready
            else self._sam3_runtime_reason(required_modules, numpy_status, device_ready),
        }

    @staticmethod
    def _sam3_runtime_reason(required_modules: dict, numpy_status: dict, device_ready: bool) -> str:
        issues = []
        if required_modules["missing"]:
            issues.append("missing modules: " + ", ".join(required_modules["missing"]))
        if not numpy_status["runtimeCompatible"]:
            issues.append(
                f"numpy {numpy_status['version']} does not satisfy "
                f"{numpy_status['requirement']}"
            )
        if not device_ready:
            issues.append(
                "SAM3 text smart selection currently requires CUDA with bfloat16 autocast"
            )
        return "; ".join(issues)

    @staticmethod
    def _release_runtime_profile() -> dict:
        runtime_flavor = str(os.getenv("MOONSHINE_RUNTIME_FLAVOR") or "external").strip().lower()
        model_bundle = str(os.getenv("MOONSHINE_MODEL_BUNDLE") or "external-models").strip().lower()
        return {
            "runtimeFlavor": runtime_flavor,
            "modelBundle": model_bundle,
            "packagedRuntime": os.getenv("MOONSHINE_PACKAGED_RUNTIME") in {"1", "true", "yes"},
            "pythonTarget": "3.12",
            "sam3TextSupportedByPackage": runtime_flavor in {"external", "cu126", "cu130"},
            "sam3TextPackageReason": (
                "当前是 CPU 发布包，SAM3/SAM3.1 文本智能选区不会作为可用能力开放。"
                if runtime_flavor == "cpu"
                else ""
            ),
        }

    def capabilities(self) -> dict:
        models = [item for item in self._build_status() if item.get("type") == "mask"]
        point_box_models = [
            item
            for item in models
            if item.get("family") in POINT_BOX_FAMILIES and item.get("installed")
        ]
        video_models = [
            item
            for item in models
            if item.get("family") == "sam2" and item.get("installed")
        ]
        text_models = [item for item in models if item.get("family") in TEXT_FAMILIES]
        default_point_box_model = next(
            (item.get("id") for item in point_box_models if item.get("id") == "sam_vit_b"),
            point_box_models[0].get("id") if point_box_models else None,
        )
        default_video_model = next(
            (item.get("id") for item in video_models if item.get("id") == "sam2_1_hiera_large"),
            video_models[0].get("id") if video_models else None,
        )
        sam3_runtime_status = self._sam3_runtime_status()
        release_runtime = self._release_runtime_profile()
        installed_text_models = [item for item in text_models if item.get("installed")]
        runnable_text_models = [
            item
            for item in installed_text_models
            if item.get("id") in SAM3_TEXT_MODEL_IDS
            and sam3_runtime_status["runtimeReady"]
            and sam3_runtime_status["deviceReady"]
            and release_runtime["sam3TextSupportedByPackage"]
        ]
        pending_text_models = [
            {
                "id": model_id,
                "reason": reason,
            }
            for model_id, reason in SAM3_TEXT_PENDING_MODELS.items()
            if any(item.get("id") == model_id for item in installed_text_models)
        ]
        text_warnings = []
        if any(item.get("id") == "sam3_1_multiplex" for item in installed_text_models):
            text_warnings.append(
                {
                    "code": "sam3_1_missing_keys_warning",
                    "severity": "warning",
                    "message": SAM3_1_MISSING_KEYS_WARNING,
                }
            )
        numpy_warning = (
            sam3_runtime_status.get("versionRequirements", {})
            .get("numpy", {})
            .get("warning")
        )
        if numpy_warning:
            text_warnings.append(
                {
                    "code": "sam3_numpy_official_range_warning",
                    "severity": "warning",
                    "message": numpy_warning,
                }
            )

        return {
            "device": self.device,
            "models": models,
            "pointBox": {
                "enabled": bool(point_box_models),
                "families": sorted(POINT_BOX_FAMILIES),
                "models": point_box_models,
                "defaultModelId": default_point_box_model,
                "promptTypes": ["point", "box"],
            },
            "video": {
                "enabled": bool(video_models),
                "families": ["sam2"],
                "models": video_models,
                "defaultModelId": default_video_model,
                "promptTypes": ["point", "box"],
                "inputTypes": ["jpegFrameDirectory", "videoPath"],
                "supportsMp4": True,
                "supportsMultipleObjects": True,
                "reason": (
                    "SAM2 video predictor accepts JPEG frame directories and local video paths. "
                    "Video paths are staged to JPEG frames with OpenCV before propagation."
                ),
            },
            "text": {
                "enabled": bool(runnable_text_models),
                "families": sorted(TEXT_FAMILIES),
                "models": text_models,
                "defaultModelId": next(
                    (
                        item.get("id")
                        for item in runnable_text_models
                        if item.get("id") == SAM3_TEXT_DEFAULT_MODEL_ID
                    ),
                    runnable_text_models[0].get("id") if runnable_text_models else None,
                ),
                "promptTypes": ["text"],
                "runtimeReady": sam3_runtime_status["runtimeReady"],
                "deviceReady": sam3_runtime_status["deviceReady"],
                "installedModels": installed_text_models,
                "implementedModelIds": sorted(SAM3_TEXT_MODEL_IDS),
                "pendingModels": pending_text_models,
                "requiredModules": sam3_runtime_status["requiredModules"],
                "optionalModules": sam3_runtime_status["optionalModules"],
                "versionRequirements": sam3_runtime_status["versionRequirements"],
                "releaseRuntime": release_runtime,
                "warnings": text_warnings,
                "reason": (
                    None
                    if runnable_text_models
                    else release_runtime["sam3TextPackageReason"]
                    if release_runtime["sam3TextPackageReason"]
                    else (
                        "SAM3 text smart selection is available only after the "
                        "SAM3 package, CUDA runtime, and a managed models/sam3 checkpoint are ready. "
                        f"{sam3_runtime_status['reason'] or ''}".strip()
                    )
                ),
            },
        }

    def _get_checkpoint_path(self, model: dict) -> Path:
        files = model.get("files") or []
        resolved_path = next((item.get("resolvedPath") for item in files if item.get("resolvedPath")), "")
        if not resolved_path:
            raise SamServiceError(f"SAM checkpoint path is unavailable: {model.get('id')}")
        return Path(resolved_path)

    def _get_predictor(self, model_id: str):
        cache_key = (model_id, self.device)
        predictor = self._predictors.get(cache_key)
        if predictor is not None:
            return predictor

        model = self._get_model_status(model_id)
        checkpoint_path = self._get_checkpoint_path(model)
        if model.get("family") == "sam2":
            model_type = SAM2_MODEL_TYPES.get(model_id)
            if not model_type:
                raise SamServiceError(f"Unsupported SAM2 model id: {model_id}")
            self._configure_sam2_attention_compatibility()
            sam2 = build_sam2(model_type, ckpt_path=str(checkpoint_path), device=self.device)
            predictor = SAM2ImagePredictor(sam2)
        else:
            model_type = SAM1_MODEL_TYPES.get(model_id)
            if not model_type:
                raise SamServiceError(f"Unsupported SAM1 model id: {model_id}")
            sam = sam_model_registry[model_type](checkpoint=str(checkpoint_path)).to(self.device)
            sam.eval()
            predictor = SamPredictor(sam)
        self._predictors[cache_key] = predictor
        return predictor

    def _get_sam2_model_status(self, model_id: str) -> dict:
        model = next((item for item in self._build_status() if item.get("id") == model_id), None)
        if model is None:
            raise SamServiceError(f"Unknown SAM2 model: {model_id}")
        if model.get("family") != "sam2":
            raise SamServiceError(f"Only SAM2 video propagation is enabled now: {model_id}")
        if not model.get("installed"):
            missing = ", ".join(model.get("missingFiles") or [])
            raise SamServiceError(f"SAM2 model is not installed: {model_id}. Missing: {missing}")
        return model

    def _get_video_predictor(self, model_id: str):
        cache_key = (model_id, self.device)
        predictor = self._video_predictors.get(cache_key)
        if predictor is not None:
            return predictor

        model = self._get_sam2_model_status(model_id)
        model_type = SAM2_MODEL_TYPES.get(model_id)
        if not model_type:
            raise SamServiceError(f"Unsupported SAM2 video model id: {model_id}")
        self._configure_sam2_attention_compatibility()
        checkpoint_path = self._get_checkpoint_path(model)
        predictor = build_sam2_video_predictor(
            model_type,
            ckpt_path=str(checkpoint_path),
            device=self.device,
        )
        self._video_predictors[cache_key] = predictor
        return predictor

    def _get_text_model_status(self, model_id: str) -> dict:
        model = next((item for item in self._build_status() if item.get("id") == model_id), None)
        if model is None:
            raise SamServiceError(f"Unknown SAM3 model: {model_id}")
        if model.get("family") not in TEXT_FAMILIES:
            raise SamServiceError(f"Only SAM3 text smart selection is enabled on this route: {model_id}")
        if model_id not in SAM3_TEXT_MODEL_IDS:
            raise SamServiceError(f"Unsupported SAM3 text model id: {model_id}")
        if not model.get("installed"):
            missing = ", ".join(model.get("missingFiles") or [])
            raise SamServiceError(f"SAM3 text model is not installed: {model_id}. Missing: {missing}")

        runtime_status = self._sam3_runtime_status()
        if not runtime_status["runtimeReady"] or not runtime_status["deviceReady"]:
            reason = runtime_status["reason"] or "SAM3 runtime is not ready"
            raise SamServiceError(f"SAM3 text smart selection is not ready: {reason}")
        return model

    def _get_text_predictor(self, model_id: str):
        cache_key = (model_id, self.device)
        predictor = self._text_predictors.get(cache_key)
        if predictor is not None:
            return predictor

        model = self._get_text_model_status(model_id)
        checkpoint_path = self._get_checkpoint_path(model)
        try:
            from sam3.model.sam3_image_processor import Sam3Processor
            from sam3.model_builder import build_sam3_image_model
        except ImportError as error:
            raise SamServiceError(
                "SAM3 package is not installed in the current Python runtime. "
                "Install the official SAM3 package into the Moonshine runtime before "
                "using text smart selection."
            ) from error

        sam3_model = build_sam3_image_model(
            device=self.device,
            checkpoint_path=str(checkpoint_path),
            load_from_HF=False,
            compile=False,
        )
        predictor = Sam3Processor(sam3_model, device=self.device)
        self._text_predictors[cache_key] = predictor
        return predictor

    def _configure_sam2_attention_compatibility(self):
        if self.device != "cuda" or not torch.cuda.is_available():
            return
        # The bundled SAM2 transformer can force Flash SDP on CUDA builds where
        # PyTorch cannot select a usable kernel. Math SDP is slower but stable.
        sam2_transformer.USE_FLASH_ATTN = False
        sam2_transformer.MATH_KERNEL_ON = True
        sam2_transformer.OLD_GPU = False

    @staticmethod
    def _format_runtime_error(error: RuntimeError) -> str:
        message = str(error)
        lower_message = message.lower()
        if "out of memory" in lower_message:
            return (
                "SAM 推理显存不足。请切换到更小的 SAM 型号、降低图片分辨率，"
                "或改用 CPU/更大显存的 CUDA 运行时。"
            )
        if "no available kernel" in lower_message or "flash attention" in lower_message:
            return (
                "SAM2 CUDA attention kernel 不可用。当前运行时已优先使用稳定 math SDP，"
                "若仍失败，请切换 CPU 或更新 PyTorch/CUDA 运行时。"
            )
        if "cuda" in lower_message and "not available" in lower_message:
            return "当前 CUDA 不可用，SAM 已无法在 CUDA 上推理。请切换 CPU 或检查运行时。"
        return f"SAM 推理失败：{message}"

    @staticmethod
    def _load_image(image: str, image_type: str) -> tuple[np.ndarray, str]:
        if image_type == "path":
            image_path = Path(image).expanduser().resolve()
            if not image_path.is_file():
                raise SamServiceError(f"Image file not found: {image_path}")
            image_bytes = image_path.read_bytes()
            with Image.open(io.BytesIO(image_bytes)) as pil_image:
                rgb_np_img = np.array(pil_image.convert("RGB"))
            image_hash = hashlib.sha256(image_bytes).hexdigest()
            return rgb_np_img, image_hash

        rgb_np_img, _, _ = decode_base64_to_image(image)
        image_hash = hashlib.sha256(image.encode("utf-8")).hexdigest()
        return rgb_np_img, image_hash

    @staticmethod
    def _normalize_points(points: list) -> tuple[Optional[np.ndarray], Optional[np.ndarray]]:
        if not points:
            return None, None

        coords = []
        labels = []
        for point in points:
            x = float(point.x if hasattr(point, "x") else point["x"])
            y = float(point.y if hasattr(point, "y") else point["y"])
            label = int(point.label if hasattr(point, "label") else point["label"])
            coords.append([x, y])
            labels.append(1 if label else 0)
        return np.array(coords, dtype=np.float32), np.array(labels, dtype=np.int32)

    @staticmethod
    def _normalize_box(box) -> Optional[np.ndarray]:
        if box is None:
            return None
        x = float(box.x if hasattr(box, "x") else box["x"])
        y = float(box.y if hasattr(box, "y") else box["y"])
        width = float(box.width if hasattr(box, "width") else box["width"])
        height = float(box.height if hasattr(box, "height") else box["height"])
        return np.array([x, y, x + width, y + height], dtype=np.float32)

    @staticmethod
    def _mask_to_data_url(mask: np.ndarray) -> str:
        rgba_mask = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
        rgba_mask[mask > 128] = [255, 203, 0, int(255 * 0.73)]
        encoded = base64.b64encode(numpy_to_bytes(rgba_mask, "png")).decode("utf-8")
        return f"data:image/png;base64,{encoded}"

    @staticmethod
    def _sort_candidates_by_score(candidates: list[dict]) -> list[dict]:
        def sort_key(candidate: dict):
            score = candidate.get("score")
            if score is None:
                return (1, 0.0)
            try:
                score_value = float(score)
            except (TypeError, ValueError):
                return (1, 0.0)
            if score_value != score_value:
                return (1, 0.0)
            return (0, -score_value)

        return sorted(candidates, key=sort_key)

    @staticmethod
    def _save_video_mask(mask: np.ndarray, output_dir: Path, frame_index: int, object_id: int) -> dict:
        mask_binary = np.where(mask > 128, 255, 0).astype(np.uint8)
        file_name = f"mask_f{frame_index:06d}_o{object_id:03d}.jpg"
        mask_path = output_dir / file_name
        ok, encoded = cv2.imencode(
            ".jpg",
            mask_binary,
            [int(cv2.IMWRITE_JPEG_QUALITY), SAM_VIDEO_MASK_JPEG_QUALITY],
        )
        if not ok:
            raise SamServiceError(f"Failed to encode SAM2 video mask: {mask_path}")
        mask_bytes = encoded.tobytes()
        ensure_disk_space(
            mask_path,
            len(mask_bytes),
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="SAM2 视频蒙版写入",
        )
        mask_path.write_bytes(mask_bytes)
        mask_signature = hashlib.sha256(mask_bytes).hexdigest()
        return {
            "objectId": int(object_id),
            "maskPath": str(mask_path),
            "maskAssetId": f"{mask_signature[:12]}:{frame_index}:{object_id}",
            "maskSize": len(mask_bytes),
            "maskSignature": mask_signature,
        }

    @staticmethod
    def _estimate_video_mask_disk_bytes(
        *,
        width: int,
        height: int,
        remaining_frames: int,
        object_count: int,
    ) -> int:
        pixel_count = max(1, int(width or 1) * int(height or 1))
        estimated_mask_bytes = int(pixel_count * SAM_VIDEO_MASK_BYTES_PER_PIXEL_ESTIMATE)
        return max(1, remaining_frames) * max(1, object_count) * estimated_mask_bytes

    @classmethod
    def _ensure_video_mask_disk_space(
        cls,
        *,
        output_dir: Path,
        width: int,
        height: int,
        remaining_frames: int,
        object_count: int,
    ) -> None:
        if remaining_frames <= 0 or object_count <= 0:
            return
        required_bytes = cls._estimate_video_mask_disk_bytes(
            width=width,
            height=height,
            remaining_frames=remaining_frames,
            object_count=object_count,
        )
        ensure_disk_space(
            output_dir,
            required_bytes,
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="SAM2 视频蒙版临时文件写入",
        )

    @staticmethod
    def _frame_dir_hash(frame_dir: Path) -> str:
        frame_names = sorted(
            item.name
            for item in frame_dir.iterdir()
            if item.suffix.lower() in {".jpg", ".jpeg"}
        )
        digest = hashlib.sha256()
        digest.update(str(frame_dir).encode("utf-8"))
        for name in frame_names:
            digest.update(name.encode("utf-8"))
        return digest.hexdigest()

    @staticmethod
    def _file_hash(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _emit_progress(
        progress_callback: Optional[Callable[..., None]],
        *,
        status: str,
        phase: Optional[str] = None,
        message: str = "",
        current: int = 0,
        total: int = 0,
        progress: Optional[float] = None,
    ) -> None:
        if not progress_callback:
            return
        progress_callback(
            status=status,
            phase=phase or status,
            message=message,
            current=current,
            total=total,
            progress=progress,
        )

    @staticmethod
    def _stage_video_to_jpeg_frames(
        video_path: Path,
        output_dir: Path,
        progress_callback: Optional[Callable[..., None]] = None,
    ) -> dict:
        if not video_path.is_file():
            raise SamServiceError(f"SAM2 video file not found: {video_path}")
        output_dir.mkdir(parents=True, exist_ok=True)

        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            raise SamServiceError(f"Failed to open video for SAM2 propagation: {video_path}")

        frame_count = 0
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        expected_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        try:
            SamService._emit_progress(
                progress_callback,
                status="frame_loading",
                phase="staging_frames",
                message="正在抽取视频帧",
                current=0,
                total=expected_frame_count,
                progress=0,
            )
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                frame_path = output_dir / f"{frame_count:06d}.jpg"
                if not cv2.imwrite(str(frame_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95]):
                    raise SamServiceError(f"Failed to stage SAM2 video frame: {frame_path}")
                frame_count += 1
                if frame_count == 1 or frame_count % 10 == 0:
                    SamService._emit_progress(
                        progress_callback,
                        status="frame_loading",
                        phase="staging_frames",
                        message=f"正在抽取视频帧 {frame_count}/{expected_frame_count or '?'}",
                        current=frame_count,
                        total=expected_frame_count,
                    )
        finally:
            capture.release()

        if frame_count <= 0:
            raise SamServiceError(f"SAM2 video file has no readable frames: {video_path}")

        return {
            "frameCount": frame_count,
            "fps": round(fps, 3) if fps > 0 else None,
            "width": width or None,
            "height": height or None,
        }

    @classmethod
    def _normalize_video_objects(
        cls,
        *,
        objects: Optional[list],
        object_id: int,
        points: list,
        box,
    ) -> list[dict]:
        normalized = []
        for item in objects or []:
            prompt_points = list(item.points if hasattr(item, "points") else item.get("points") or [])
            prompt_box = item.box if hasattr(item, "box") else item.get("box")
            prompt_object_id = int(
                item.object_id if hasattr(item, "object_id") else item.get("object_id", 1)
            )
            if not prompt_points and prompt_box is None:
                continue
            normalized.append(
                {
                    "objectId": prompt_object_id,
                    "points": prompt_points,
                    "box": prompt_box,
                }
            )

        if not normalized and (points or box is not None):
            normalized.append(
                {
                    "objectId": int(object_id or 1),
                    "points": list(points or []),
                    "box": box,
                }
            )

        if not normalized:
            raise SamServiceError("At least one point or box prompt is required.")

        seen_ids = set()
        duplicate_ids = set()
        for item in normalized:
            if item["objectId"] in seen_ids:
                duplicate_ids.add(item["objectId"])
            seen_ids.add(item["objectId"])
        if duplicate_ids:
            duplicate_text = ", ".join(str(item) for item in sorted(duplicate_ids))
            raise SamServiceError(f"SAM2 video object ids must be unique: {duplicate_text}")

        return normalized

    @staticmethod
    def _tensor_mask_to_numpy(mask_tensor, height: int, width: int) -> np.ndarray:
        mask = mask_tensor.detach().float()
        if mask.dim() == 3:
            mask = mask.unsqueeze(0)
        if mask.dim() == 2:
            mask = mask[None, None, ...]
        resized = F.interpolate(mask, size=(height, width), mode="bilinear", align_corners=False)
        return (resized.squeeze().cpu().numpy() > 0).astype(np.uint8) * 255

    @staticmethod
    def _sam3_mask_to_numpy(mask_tensor) -> np.ndarray:
        mask = mask_tensor.detach()
        if mask.dim() == 3 and mask.shape[0] == 1:
            mask = mask.squeeze(0)
        if mask.dtype == torch.bool:
            return mask.cpu().numpy().astype(np.uint8) * 255
        return (mask.float().cpu().numpy() > 0.5).astype(np.uint8) * 255

    @staticmethod
    def _sam3_box_to_dict(box_tensor) -> Optional[dict]:
        if box_tensor is None:
            return None
        values = box_tensor.detach().float().cpu().tolist()
        if len(values) < 4:
            return None
        x0, y0, x1, y1 = [float(value) for value in values[:4]]
        return {
            "x": x0,
            "y": y0,
            "width": max(0.0, x1 - x0),
            "height": max(0.0, y1 - y0),
            "x0": x0,
            "y0": y0,
            "x1": x1,
            "y1": y1,
        }

    @staticmethod
    def _contains_cjk(value: str) -> bool:
        return any("\u4e00" <= char <= "\u9fff" for char in value)

    @classmethod
    def _normalize_text_prompts(cls, prompt: str, language: str) -> list[dict]:
        prompts = [{"text": prompt, "source": "original", "language": language}]
        should_translate = language == "zh" or (language == "auto" and cls._contains_cjk(prompt))
        if not should_translate:
            return prompts

        normalized = prompt
        for stopword in SAM3_ZH_PROMPT_STOPWORDS:
            normalized = normalized.replace(stopword, " ")
        for zh_term, en_term in SAM3_ZH_PROMPT_TERMS:
            normalized = normalized.replace(zh_term, f" {en_term} ")
        normalized = re.sub(r"[，。！？、；：,.!?;:/\\|()\[\]{}]+", " ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if normalized and normalized != prompt and not cls._contains_cjk(normalized):
            prompts.append(
                {
                    "text": normalized,
                    "source": "zh_lexicon",
                    "language": "en",
                    "originalLanguage": language,
                }
            )
        return prompts

    @torch.inference_mode()
    def predict(
        self,
        *,
        image: str,
        image_type: str,
        model_id: str,
        points: list,
        box,
        multimask_output: bool,
    ) -> dict:
        if not points and box is None:
            raise SamServiceError("At least one point or box prompt is required.")

        total_started_at = time.perf_counter()
        load_image_ms = 0.0
        set_image_ms = 0.0
        predict_ms = 0.0
        image_cache_hit = False
        model_cache_key = (model_id, self.device)
        model_cached = model_cache_key in self._predictors

        try:
            with self._lock:
                predictor = self._get_predictor(model_id)

                load_image_started_at = time.perf_counter()
                rgb_np_img, image_hash = self._load_image(image, image_type)
                load_image_ms = (time.perf_counter() - load_image_started_at) * 1000

                cached_image_hash = self._image_cache.get(model_cache_key)
                image_cache_hit = cached_image_hash == image_hash
                if not image_cache_hit:
                    set_image_started_at = time.perf_counter()
                    predictor.set_image(rgb_np_img)
                    set_image_ms = (time.perf_counter() - set_image_started_at) * 1000
                    self._image_cache[model_cache_key] = image_hash

                point_coords, point_labels = self._normalize_points(points)
                box_array = self._normalize_box(box)
                predict_started_at = time.perf_counter()
                masks, scores, logits = predictor.predict(
                    point_coords=point_coords,
                    point_labels=point_labels,
                    box=box_array,
                    multimask_output=multimask_output,
                )
                predict_ms = (time.perf_counter() - predict_started_at) * 1000
        except RuntimeError as error:
            raise SamServiceError(self._format_runtime_error(error)) from error

        encode_started_at = time.perf_counter()
        candidates = []
        for index, mask in enumerate(masks):
            binary_mask = (mask.astype(np.uint8) * 255)
            candidates.append(
                {
                    "id": f"{model_id}-{image_hash[:12]}-{index}",
                    "index": index,
                    "mask": self._mask_to_data_url(binary_mask),
                    "score": float(scores[index]) if index < len(scores) else None,
                }
            )
        candidates = self._sort_candidates_by_score(candidates)
        encode_ms = (time.perf_counter() - encode_started_at) * 1000
        total_ms = (time.perf_counter() - total_started_at) * 1000

        return {
            "modelId": model_id,
            "imageHash": image_hash,
            "width": int(rgb_np_img.shape[1]),
            "height": int(rgb_np_img.shape[0]),
            "candidates": candidates,
            "logitsShape": list(logits.shape) if hasattr(logits, "shape") else None,
            "performance": {
                "device": self.device,
                "modelCached": model_cached,
                "imageCacheHit": image_cache_hit,
                "imageMegapixels": round(
                    float(rgb_np_img.shape[0] * rgb_np_img.shape[1]) / 1_000_000,
                    3,
                ),
                "loadImageMs": round(load_image_ms, 2),
                "setImageMs": round(set_image_ms, 2),
                "predictMs": round(predict_ms, 2),
                "encodeMs": round(encode_ms, 2),
                "totalMs": round(total_ms, 2),
            },
        }

    @torch.inference_mode()
    def propagate_video(
        self,
        *,
        frame_dir: Optional[str],
        video_path: Optional[str] = None,
        input_type: str = "jpegFrameDirectory",
        model_id: str,
        frame_index: int,
        object_id: int,
        points: list,
        box,
        objects: Optional[list] = None,
        max_frames: Optional[int],
        reverse: bool,
        offload_video_to_cpu: bool,
        offload_state_to_cpu: bool,
        response_type: str = "base64",
        mask_output_dir: Optional[str] = None,
        progress_callback: Optional[Callable[..., None]] = None,
    ) -> dict:
        self._emit_progress(
            progress_callback,
            status="queued",
            phase="queued",
            message="SAM2 视频传播任务已开始",
            current=0,
            total=0,
            progress=0,
        )
        normalized_objects = self._normalize_video_objects(
            objects=objects,
            object_id=object_id,
            points=points,
            box=box,
        )
        normalized_input_type = (
            "videoPath" if str(input_type or "").strip() == "videoPath" else "jpegFrameDirectory"
        )
        staging_root = None
        source_video_path = None
        source_video_hash = None
        staged_video_info = None
        normalized_response_type = "path" if str(response_type or "").strip() == "path" else "base64"
        mask_output_path = None
        if normalized_response_type == "path":
            if not mask_output_dir:
                raise SamServiceError("mask_output_dir is required when SAM2 response_type is path.")
            mask_output_path = Path(mask_output_dir).expanduser().resolve()
            mask_output_path.mkdir(parents=True, exist_ok=True)

        if normalized_input_type == "videoPath":
            if not video_path:
                raise SamServiceError("video_path is required for SAM2 videoPath input.")
            source_video_path = Path(video_path).expanduser().resolve()
            if not source_video_path.is_file():
                raise SamServiceError(f"SAM2 video file not found: {source_video_path}")
            source_video_hash = self._file_hash(source_video_path)
            staging_root = Path(tempfile.mkdtemp(prefix="moonshine_sam2_video_"))
            frame_path = staging_root / "frames"
            try:
                staged_video_info = self._stage_video_to_jpeg_frames(
                    source_video_path,
                    frame_path,
                    progress_callback=progress_callback,
                )
            except Exception:
                shutil.rmtree(staging_root, ignore_errors=True)
                staging_root = None
                raise
        else:
            if not frame_dir:
                raise SamServiceError("frame_dir is required for SAM2 JPEG frame directory input.")
            frame_path = Path(frame_dir).expanduser().resolve()
            if not frame_path.is_dir():
                raise SamServiceError(f"SAM2 video input must be a JPEG frame directory: {frame_path}")

        frame_names = sorted(
            item.name
            for item in frame_path.iterdir()
            if item.suffix.lower() in {".jpg", ".jpeg"}
        )
        if not frame_names:
            raise SamServiceError(f"SAM2 video frame directory has no JPEG frames: {frame_path}")
        frame_dir_hash = (
            source_video_hash
            if normalized_input_type == "videoPath" and source_video_hash
            else self._frame_dir_hash(frame_path)
        )
        estimated_output_frame_count = max(
            1,
            min(
                len(frame_names),
                int(max_frames) if max_frames is not None else len(frame_names),
            ),
        )

        total_started_at = time.perf_counter()
        try:
            with self._lock:
                predictor = self._get_video_predictor(model_id)
                self._emit_progress(
                    progress_callback,
                    status="frame_loading",
                    phase="frame_loading",
                    message=f"正在加载 SAM2 视频帧 0/{len(frame_names)}",
                    current=0,
                    total=len(frame_names),
                    progress=0,
                )

                def emit_frame_loading_progress(current: int, total: int) -> None:
                    self._emit_progress(
                        progress_callback,
                        status="frame_loading",
                        phase="frame_loading",
                        message=f"正在加载 SAM2 视频帧 {current}/{total}",
                        current=current,
                        total=total,
                    )

                state = predictor.init_state(
                    str(frame_path),
                    offload_video_to_cpu=offload_video_to_cpu,
                    offload_state_to_cpu=offload_state_to_cpu,
                    progress_callback=emit_frame_loading_progress,
                )
                self._emit_progress(
                    progress_callback,
                    status="frame_loading",
                    phase="frame_loading",
                    message=f"SAM2 视频帧加载完成 {len(frame_names)}/{len(frame_names)}",
                    current=len(frame_names),
                    total=len(frame_names),
                    progress=1,
                )
                self._emit_progress(
                    progress_callback,
                    status="prompt_encoding",
                    phase="prompt_encoding",
                    message=f"正在注册 {len(normalized_objects)} 个对象提示",
                    current=0,
                    total=len(normalized_objects),
                    progress=0,
                )
                for prompt_index, prompt in enumerate(normalized_objects, start=1):
                    point_coords, point_labels = self._normalize_points(prompt["points"])
                    box_array = self._normalize_box(prompt["box"])
                    predictor.add_new_points_or_box(
                        state,
                        frame_idx=frame_index,
                        obj_id=prompt["objectId"],
                        points=point_coords,
                        labels=point_labels,
                        box=box_array,
                    )
                    self._emit_progress(
                        progress_callback,
                        status="prompt_encoding",
                        phase="prompt_encoding",
                        message=f"已注册对象 {prompt['objectId']} 的点选/框选提示",
                        current=prompt_index,
                        total=len(normalized_objects),
                    )

                frames = []
                if normalized_response_type == "path":
                    self._ensure_video_mask_disk_space(
                        output_dir=mask_output_path,
                        width=int(state["video_width"]),
                        height=int(state["video_height"]),
                        remaining_frames=estimated_output_frame_count,
                        object_count=len(normalized_objects),
                    )
                self._emit_progress(
                    progress_callback,
                    status="propagating",
                    phase="propagating",
                    message=f"正在传播 SAM2 视频蒙版 0/{estimated_output_frame_count}",
                    current=0,
                    total=estimated_output_frame_count,
                    progress=0,
                )
                for out_frame_index, object_ids, masks in predictor.propagate_in_video(
                    state,
                    start_frame_idx=frame_index,
                    max_frame_num_to_track=max_frames,
                    reverse=reverse,
                ):
                    frame_masks = []
                    if normalized_response_type == "path":
                        self._ensure_video_mask_disk_space(
                            output_dir=mask_output_path,
                            width=int(state["video_width"]),
                            height=int(state["video_height"]),
                            remaining_frames=max(1, estimated_output_frame_count - len(frames)),
                            object_count=max(1, len(object_ids)),
                        )
                    for mask_index, obj_id in enumerate(object_ids):
                        mask_np = self._tensor_mask_to_numpy(
                            masks[mask_index],
                            state["video_height"],
                            state["video_width"],
                        )
                        if normalized_response_type == "path":
                            frame_masks.append(
                                self._save_video_mask(
                                    mask_np,
                                    mask_output_path,
                                    int(out_frame_index),
                                    int(obj_id),
                                )
                            )
                        else:
                            frame_masks.append(
                                {
                                    "objectId": int(obj_id),
                                    "mask": self._mask_to_data_url(mask_np),
                                }
                            )
                    frames.append(
                        {
                            "frameIndex": int(out_frame_index),
                            "masks": frame_masks,
                        }
                    )
                    self._emit_progress(
                        progress_callback,
                        status="propagating",
                        phase="propagating",
                        message=f"正在传播 SAM2 视频蒙版 {len(frames)}/{estimated_output_frame_count}",
                        current=len(frames),
                        total=estimated_output_frame_count,
                    )
                self._emit_progress(
                    progress_callback,
                    status="writing_masks",
                    phase="writing_masks",
                    message=f"SAM2 蒙版写入完成 {len(frames)}/{estimated_output_frame_count}",
                    current=len(frames),
                    total=estimated_output_frame_count,
                    progress=1,
                )
        except RuntimeError as error:
            raise SamServiceError(self._format_runtime_error(error)) from error
        finally:
            if staging_root is not None:
                shutil.rmtree(staging_root, ignore_errors=True)

        total_ms = (time.perf_counter() - total_started_at) * 1000
        return {
            "modelId": model_id,
            "frameDirHash": frame_dir_hash,
            "frameCount": len(frame_names),
            "width": int(state["video_width"]),
            "height": int(state["video_height"]),
            "objectCount": len(normalized_objects),
            "objects": [
                {
                    "objectId": item["objectId"],
                    "pointCount": len(item["points"]),
                    "hasBox": item["box"] is not None,
                }
                for item in normalized_objects
            ],
            "frames": frames,
            "input": {
                "type": normalized_input_type,
                "frameDir": str(frame_path) if normalized_input_type == "jpegFrameDirectory" else None,
                "videoPath": str(source_video_path) if source_video_path is not None else None,
                "videoHash": source_video_hash,
                "staged": normalized_input_type == "videoPath",
                "stagedFrameCount": staged_video_info.get("frameCount")
                if staged_video_info
                else None,
                "fps": staged_video_info.get("fps") if staged_video_info else None,
                "responseType": normalized_response_type,
                "maskOutputDir": str(mask_output_path) if mask_output_path is not None else None,
            },
            "performance": {
                "device": self.device,
                "totalMs": round(total_ms, 2),
                "offloadVideoToCpu": offload_video_to_cpu,
                "offloadStateToCpu": offload_state_to_cpu,
            },
        }

    def predict_text(
        self,
        *,
        image: str,
        image_type: str,
        model_id: str,
        text: str,
        language: str,
        prompt_source: str = "manual",
        prompt_color: Optional[dict] = None,
        prompt_noun: Optional[dict] = None,
    ) -> dict:
        prompt = str(text or "").strip()
        if not prompt:
            raise SamServiceError("Text prompt is required for SAM3 smart selection.")
        normalized_prompt_source = str(prompt_source or "manual").strip() or "manual"
        is_lexicon_prompt = normalized_prompt_source.startswith("lexicon")
        if is_lexicon_prompt:
            prompt_candidates = [
                {
                    "text": prompt,
                    "source": normalized_prompt_source,
                    "language": "en",
                    "originalLanguage": language,
                }
            ]
        else:
            prompt_candidates = self._normalize_text_prompts(prompt, language)
        used_prompt = prompt_candidates[0]

        total_started_at = time.perf_counter()
        load_image_ms = 0.0
        set_image_ms = 0.0
        predict_ms = 0.0
        image_cache_hit = False
        model_cache_key = (model_id, self.device)
        model_cached = model_cache_key in self._text_predictors

        try:
            with self._lock:
                predictor = self._get_text_predictor(model_id)

                load_image_started_at = time.perf_counter()
                rgb_np_img, image_hash = self._load_image(image, image_type)
                load_image_ms = (time.perf_counter() - load_image_started_at) * 1000

                text_cache_key = (model_id, self.device)
                cached_image = self._text_image_cache.get(text_cache_key)
                image_cache_hit = (
                    cached_image is not None
                    and cached_image.get("imageHash") == image_hash
                    and cached_image.get("state") is not None
                )

                autocast_context = (
                    torch.autocast(device_type="cuda", dtype=torch.bfloat16)
                    if self.device == "cuda"
                    else contextlib.nullcontext()
                )
                with autocast_context:
                    if image_cache_hit:
                        state = cached_image["state"]
                        predictor.reset_all_prompts(state)
                    else:
                        set_image_started_at = time.perf_counter()
                        pil_image = Image.fromarray(rgb_np_img)
                        state = predictor.set_image(pil_image)
                        set_image_ms = (time.perf_counter() - set_image_started_at) * 1000
                        self._text_image_cache[text_cache_key] = {
                            "imageHash": image_hash,
                            "state": state,
                        }

                    output = None
                    for candidate in prompt_candidates:
                        predictor.reset_all_prompts(state)
                        predict_started_at = time.perf_counter()
                        candidate_output = predictor.set_text_prompt(
                            prompt=candidate["text"],
                            state=state,
                        )
                        predict_ms += (time.perf_counter() - predict_started_at) * 1000
                        candidate_masks = candidate_output.get("masks")
                        if candidate_masks is not None and int(candidate_masks.shape[0]) > 0:
                            output = candidate_output
                            used_prompt = candidate
                            break
                        if output is None:
                            output = candidate_output
        except RuntimeError as error:
            raise SamServiceError(self._format_runtime_error(error)) from error
        except ValueError as error:
            raise SamServiceError(str(error)) from error

        masks = output.get("masks")
        if masks is None:
            raise SamServiceError("SAM3 text prediction did not return masks.")
        boxes = output.get("boxes")
        scores = output.get("scores")

        if masks.dim() == 4 and masks.shape[1] == 1:
            masks = masks[:, 0, :, :]
        if masks.dim() == 2:
            masks = masks.unsqueeze(0)

        warnings = []
        if model_id == "sam3_1_multiplex":
            warnings.append(
                {
                    "code": "sam3_1_missing_keys_warning",
                    "severity": "warning",
                    "message": SAM3_1_MISSING_KEYS_WARNING,
                }
            )
        candidate_count = int(masks.shape[0])
        empty_result_reason = None
        if candidate_count <= 0:
            empty_result_reason = (
                "SAM3 text smart selection did not find a matching target. "
                "Use a short noun phrase, try a simpler English prompt, or add the "
                "Chinese term to the local normalization lexicon if this is a Chinese prompt."
            )

        encode_started_at = time.perf_counter()
        candidates = []
        for index in range(candidate_count):
            binary_mask = self._sam3_mask_to_numpy(masks[index])
            score = None
            if scores is not None and index < int(scores.shape[0]):
                score = float(scores[index].detach().float().cpu().item())
            box = None
            if boxes is not None and index < int(boxes.shape[0]):
                box = self._sam3_box_to_dict(boxes[index])
            candidates.append(
                {
                    "id": f"{model_id}-{image_hash[:12]}-text-{index}",
                    "index": index,
                    "mask": self._mask_to_data_url(binary_mask),
                    "score": score,
                    "box": box,
                    "promptType": "text",
                    "prompt": {
                        "type": "text",
                        "text": prompt,
                        "language": language,
                        "source": normalized_prompt_source,
                        "color": prompt_color,
                        "noun": prompt_noun,
                        "modelText": used_prompt["text"],
                        "modelLanguage": used_prompt["language"],
                        "normalization": used_prompt["source"],
                    },
                }
            )
        candidates = self._sort_candidates_by_score(candidates)
        encode_ms = (time.perf_counter() - encode_started_at) * 1000
        total_ms = (time.perf_counter() - total_started_at) * 1000

        return {
            "modelId": model_id,
            "imageHash": image_hash,
            "width": int(rgb_np_img.shape[1]),
            "height": int(rgb_np_img.shape[0]),
            "prompt": {
                "type": "text",
                "text": prompt,
                "language": language,
                "source": normalized_prompt_source,
                "color": prompt_color,
                "noun": prompt_noun,
                "modelText": used_prompt["text"],
                "modelLanguage": used_prompt["language"],
                "normalization": used_prompt["source"],
                "attempts": [
                    {
                        "text": candidate["text"],
                        "language": candidate["language"],
                        "source": candidate["source"],
                    }
                    for candidate in prompt_candidates
                ],
            },
            "candidates": candidates,
            "diagnostics": {
                "candidateCount": len(candidates),
                "promptAttempts": [
                    {
                        "text": candidate["text"],
                        "language": candidate["language"],
                        "source": candidate["source"],
                    }
                    for candidate in prompt_candidates
                ],
                "usedPrompt": {
                    "text": used_prompt["text"],
                    "language": used_prompt["language"],
                    "source": used_prompt["source"],
                },
                "normalization": used_prompt["source"],
                "promptSource": normalized_prompt_source,
                "promptColor": prompt_color,
                "promptNoun": prompt_noun,
                "emptyResultReason": empty_result_reason,
                "warnings": warnings,
                "chineseSupport": (
                    "basic_lexicon_normalization"
                    if language == "zh" or self._contains_cjk(prompt)
                    else "not_applicable"
                ),
            },
            "outputShapes": {
                "masks": list(output["masks"].shape) if hasattr(output.get("masks"), "shape") else None,
                "boxes": list(boxes.shape) if hasattr(boxes, "shape") else None,
                "scores": list(scores.shape) if hasattr(scores, "shape") else None,
            },
            "performance": {
                "device": self.device,
                "modelCached": model_cached,
                "imageCacheHit": image_cache_hit,
                "autocast": "cuda.bfloat16" if self.device == "cuda" else None,
                "imageMegapixels": round(
                    float(rgb_np_img.shape[0] * rgb_np_img.shape[1]) / 1_000_000,
                    3,
                ),
                "loadImageMs": round(load_image_ms, 2),
                "setImageMs": round(set_image_ms, 2),
                "predictMs": round(predict_ms, 2),
                "encodeMs": round(encode_ms, 2),
                "totalMs": round(total_ms, 2),
            },
        }
