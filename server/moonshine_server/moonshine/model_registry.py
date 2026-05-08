import hashlib
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional
from urllib.request import Request, urlopen

from loguru import logger


MODEL_CAPABILITY_KEYS = (
    "speed",
    "realImageQuality",
    "cartoonImageQuality",
    "simpleSceneQuality",
    "complexSceneQuality",
    "textWatermarkAbility",
    "lowVramFriendly",
    "stability",
)


MODEL_MANIFEST = (
    {
        "id": "lama",
        "label": "Lama 去除模型",
        "description": "通用擦除与图像修复模型，适合需要蒙版的物体、文字和水印移除。",
        "type": "image",
        "requiresMask": True,
        "downloadable": False,
        "sourceLinks": [],
        "files": [
            {
                "path": "torch/hub/checkpoints/big-lama.pt",
                "label": "big-lama.pt",
                "size": None,
                "sha256": "",
                "legacyPaths": ["hub/checkpoints/big-lama.pt", "big-lama.pt"],
            }
        ],
        "size": None,
        "sha256": "",
        "recommendedDevice": "cuda",
        "minimumVram": 2048,
        "runCapabilities": {
            "scopes": ["selected", "folder"],
            "folderInputs": ["imageFolder", "maskFolder"],
            "batchActions": ["deleteSelected", "applyCurrentMaskToSelected"],
            "outputRequired": True,
        },
        "parameters": {},
        "capabilities": {
            "speed": 3,
            "realImageQuality": 4,
            "cartoonImageQuality": 3,
            "simpleSceneQuality": 4,
            "complexSceneQuality": 3,
            "textWatermarkAbility": 3,
            "lowVramFriendly": 3,
            "stability": 4,
        },
    },
    {
        "id": "slbr",
        "label": "透明水印去除模型",
        "description": "用于半透明可见水印去除的无蒙版模型，适合批量清理图片水印。",
        "type": "image",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [],
        "files": [
            {
                "path": "slbr/model_best.pth.tar",
                "label": "model_best.pth.tar",
                "size": None,
                "sha256": "",
            }
        ],
        "size": None,
        "sha256": "",
        "recommendedDevice": "cuda",
        "minimumVram": 2048,
        "runCapabilities": {
            "scopes": ["selected", "folder"],
            "folderInputs": ["imageFolder"],
            "batchActions": ["deleteSelected"],
            "outputRequired": True,
        },
        "parameters": {
            "tile_size": {
                "label": "分块大小",
                "type": "select",
                "default": 384,
                "options": [256, 384, 512],
                "required": True,
            },
            "tile_batch": {
                "label": "批次数量",
                "type": "number",
                "default": 4,
                "min": 1,
                "max": 32,
                "step": 1,
                "required": True,
            },
        },
        "capabilities": {
            "speed": 3,
            "realImageQuality": 3,
            "cartoonImageQuality": 2,
            "simpleSceneQuality": 4,
            "complexSceneQuality": 2,
            "textWatermarkAbility": 5,
            "lowVramFriendly": 3,
            "stability": 3,
        },
    },
)


def _now() -> float:
    return time.time()


def _normalize_capabilities(capabilities: Optional[dict]) -> dict:
    source = capabilities or {}
    result = {}
    for key in MODEL_CAPABILITY_KEYS:
        try:
            value = int(source.get(key, 0))
        except (TypeError, ValueError):
            value = 0
        result[key] = max(0, min(5, value))
    return result


def _safe_relative_path(value: str) -> Path:
    path = Path(str(value or "").replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Invalid model file path: {value}")
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_status(model_dir: Path, file_spec: dict) -> dict:
    relative_path = _safe_relative_path(file_spec.get("path", ""))
    expected_sha256 = str(file_spec.get("sha256") or "").strip().lower()
    candidate_paths = [
        model_dir / relative_path,
        model_dir.parent / relative_path,
    ]
    for legacy_path in file_spec.get("legacyPaths") or []:
        candidate_paths.append(model_dir / _safe_relative_path(legacy_path))

    existing_path = next((path for path in candidate_paths if path.is_file()), None)
    status = {
        "path": str(relative_path).replace("\\", "/"),
        "label": file_spec.get("label") or relative_path.name,
        "size": file_spec.get("size"),
        "sha256": expected_sha256,
        "exists": existing_path is not None,
        "valid": False,
        "actualSize": None,
        "actualSha256": "",
        "resolvedPath": str(existing_path) if existing_path else "",
    }

    if existing_path is None:
        return status

    status["actualSize"] = existing_path.stat().st_size
    if expected_sha256:
        actual_sha256 = _sha256_file(existing_path)
        status["actualSha256"] = actual_sha256
        status["valid"] = actual_sha256 == expected_sha256
    else:
        status["valid"] = True
    return status


def _device_compatible(model: dict, cuda_info: Optional[dict]) -> bool:
    minimum_vram = model.get("minimumVram")
    if not minimum_vram:
        return True

    recommended_device = str(model.get("recommendedDevice") or "").lower()
    if recommended_device != "cuda":
        return True

    cuda_info = cuda_info or {}
    if not cuda_info.get("cuda_available") or cuda_info.get("cuda_compatible") is False:
        return False

    memory_mb = cuda_info.get("total_memory_mb") or cuda_info.get("free_memory_mb") or 0
    try:
        return float(memory_mb) >= float(minimum_vram)
    except (TypeError, ValueError):
        return True


def build_model_status(model_dir: Path, cuda_info: Optional[dict] = None) -> list[dict]:
    model_dir = Path(model_dir).expanduser().resolve()
    models = []
    for manifest_item in MODEL_MANIFEST:
        file_statuses = [
            _file_status(model_dir, file_spec)
            for file_spec in manifest_item.get("files", [])
        ]
        missing_files = [
            file_status["path"]
            for file_status in file_statuses
            if not file_status["exists"]
        ]
        corrupt_files = [
            file_status["path"]
            for file_status in file_statuses
            if file_status["exists"] and not file_status["valid"]
        ]
        installed = len(file_statuses) > 0 and not missing_files and not corrupt_files
        device_compatible = _device_compatible(manifest_item, cuda_info)

        item = {
            **manifest_item,
            "files": file_statuses,
            "installed": installed,
            "available": installed and device_compatible,
            "missingFiles": missing_files,
            "corruptFiles": corrupt_files,
            "deviceCompatible": device_compatible,
            "capabilities": _normalize_capabilities(manifest_item.get("capabilities")),
        }
        models.append(item)
    return models


def get_model_manifest(model_id: str) -> Optional[dict]:
    normalized_id = str(model_id or "").strip()
    return next(
        (item for item in MODEL_MANIFEST if item.get("id") == normalized_id),
        None,
    )


@dataclass
class ModelDownloadTask:
    id: str
    model_id: str
    status: str = "queued"
    progress: float = 0
    downloaded_bytes: int = 0
    total_bytes: Optional[int] = None
    message: str = ""
    error: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)
    completed_at: Optional[float] = None
    thread: Optional[threading.Thread] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "modelId": self.model_id,
            "status": self.status,
            "progress": self.progress,
            "downloadedBytes": self.downloaded_bytes,
            "totalBytes": self.total_bytes,
            "message": self.message,
            "error": self.error,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
            "done": self.status in {"completed", "failed"},
        }


class ModelDownloadTaskManager:
    def __init__(self):
        self._tasks: Dict[str, ModelDownloadTask] = {}
        self._lock = threading.Lock()

    def create_download_task(self, model_id: str, model_dir: Path) -> ModelDownloadTask:
        manifest_item = get_model_manifest(model_id)
        if manifest_item is None:
            raise ValueError(f"Unknown model: {model_id}")
        if not manifest_item.get("downloadable"):
            raise ValueError("该模型不支持软件内下载。")
        if not manifest_item.get("sourceLinks"):
            raise ValueError("暂无下载源。")

        task = ModelDownloadTask(id=uuid.uuid4().hex, model_id=model_id)
        thread = threading.Thread(
            target=self._run_download_task,
            args=(task.id, Path(model_dir).expanduser().resolve()),
            daemon=True,
        )
        task.thread = thread
        with self._lock:
            self._tasks[task.id] = task
        thread.start()
        return task

    def get_task(self, task_id: str) -> Optional[ModelDownloadTask]:
        with self._lock:
            return self._tasks.get(task_id)

    def _patch_task(self, task_id: str, **changes):
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            for key, value in changes.items():
                setattr(task, key, value)
            task.updated_at = _now()
            if task.status in {"completed", "failed"} and task.completed_at is None:
                task.completed_at = task.updated_at

    def _run_download_task(self, task_id: str, model_dir: Path):
        task = self.get_task(task_id)
        if task is None:
            return

        manifest_item = get_model_manifest(task.model_id)
        try:
            self._patch_task(task_id, status="running", message="正在下载模型...")
            self._download_model_files(task_id, manifest_item, model_dir)
            self._patch_task(
                task_id,
                status="completed",
                progress=1,
                message="模型已下载并校验完成。",
            )
        except Exception as error:
            logger.exception(f"Model download task failed: {task.model_id}")
            self._patch_task(
                task_id,
                status="failed",
                error=str(error),
                message="模型下载失败。",
            )

    def _download_model_files(self, task_id: str, manifest_item: dict, model_dir: Path):
        source_links = manifest_item.get("sourceLinks") or []
        file_specs = manifest_item.get("files") or []
        if len(file_specs) != 1:
            raise ValueError("当前下载器仅支持单文件模型。")

        file_spec = file_specs[0]
        relative_path = _safe_relative_path(file_spec.get("path", ""))
        target_path = model_dir / relative_path
        part_path = target_path.with_name(f"{target_path.name}.part")
        target_path.parent.mkdir(parents=True, exist_ok=True)

        last_error = None
        for source in source_links:
            url = source.get("url") if isinstance(source, dict) else str(source)
            if not url:
                continue
            try:
                self._download_url_to_file(task_id, url, part_path)
                expected_sha256 = str(file_spec.get("sha256") or "").strip().lower()
                if expected_sha256:
                    actual_sha256 = _sha256_file(part_path)
                    if actual_sha256 != expected_sha256:
                        raise ValueError("模型文件校验失败，请重新下载。")
                os.replace(part_path, target_path)
                return
            except Exception as error:
                last_error = error
                try:
                    part_path.unlink(missing_ok=True)
                except TypeError:
                    if part_path.exists():
                        part_path.unlink()
                continue

        raise last_error or ValueError("暂无可用下载源。")

    def _download_url_to_file(self, task_id: str, url: str, part_path: Path):
        request = Request(url, headers={"User-Agent": "Moonshine-Image"})
        with urlopen(request, timeout=30) as response:
            total_bytes = response.headers.get("Content-Length")
            total_bytes = int(total_bytes) if total_bytes and total_bytes.isdigit() else None
            self._patch_task(task_id, total_bytes=total_bytes)

            downloaded = 0
            with part_path.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    downloaded += len(chunk)
                    progress = downloaded / total_bytes if total_bytes else 0
                    self._patch_task(
                        task_id,
                        downloaded_bytes=downloaded,
                        progress=max(0, min(0.99, progress)),
                    )


download_task_manager = ModelDownloadTaskManager()
