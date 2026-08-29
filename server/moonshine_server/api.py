import json
import hashlib
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Optional, Dict, List, Callable
import base64 
import io
from tqdm import tqdm

import cv2
import numpy as np
import socketio
import torch

try:
    torch._C._jit_override_can_fuse_on_cpu(False)
    torch._C._jit_override_can_fuse_on_gpu(False)
    torch._C._jit_set_texpr_fuser_enabled(False)
    torch._C._jit_set_profiling_mode(False)
except:
    pass

import uvicorn
from PIL import Image
from fastapi import APIRouter, Body, FastAPI, Header, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pydantic import ValidationError
from socketio import AsyncServer

from moonshine_server.file_manager import FileManager
from moonshine_server.disk_space import (
    DEFAULT_DISK_SPACE_SAFETY_BYTES,
    DiskSpaceError,
    ensure_disk_space,
    file_size_or_zero,
)
from moonshine_server.helper import (
    load_img,
    decode_base64_to_image,
    pil_to_bytes,
    numpy_to_bytes,
    concat_alpha_channel,
    gen_frontend_mask,
    adjust_mask,
)
from moonshine_server.image_output import (
    build_image_data_url,
    encode_pil_image,
    image_format_from_path,
    normalize_image_format,
    resolve_image_output_spec,
)
from moonshine_server.mask_image import decode_binary_mask
from moonshine_server.path_io import read_image_file, to_path
from moonshine_server.inpaint_color_stabilization import (
    apply_inpaint_color_stabilization,
    try_flat_background_fill,
)
from moonshine_server.model.utils import torch_gc
from moonshine_server.model_manager import ModelManager
from moonshine_server.application_facade import (
    ApplicationFacade,
    JobCancellationRequested,
    JobInProgressError,
    JobProcessingError,
    JobResultUnavailableError,
)
from moonshine_server.jobs import (
    IdempotencyConflictError,
    JobNotFoundError,
    SqliteJobStore,
    safe_error,
)
from moonshine_server.video_temporal_enhancement import (
    VideoTemporalEnhancer,
    is_temporal_enhancement_enabled,
)
from moonshine_server.plugins import build_plugins, RealESRGANUpscaler
from moonshine_server.plugins.base_plugin import BasePlugin
from moonshine_server.plugins.remove_bg import RemoveBG
from moonshine_server.schema import (
    GenInfoResponse,
    ApiConfig,
    ServerConfigResponse,
    SwitchModelRequest,
    InpaintRequest,
    RunPluginRequest,
    PluginInfo,
    AdjustMaskRequest,
    RemoveBGModel,
    SwitchPluginModelRequest,
    ModelInfo,
    RealESRGANModel,
    BatchInpaintRequest, 
    McpImageSubmitRequest,
    BatchInpaintByFolderRequest,
    MoonshineImageProcessRequest,
    MoonshineImageFolderInspectRequest,
    MoonshineImageFolderProcessRequest,
    VideoBatchInpaintRequest,
    MoonshineModelRegistryRequest,
    MoonshineSamPredictRequest,
    MoonshineSamPredictBatchRequest,
    MoonshineSamTextPredictRequest,
    MoonshineSamVideoPropagateRequest,
)


SAM_VIDEO_POLLING_PATH_PREFIX = "/api/v1/moonshine/sam/video/propagate/jobs/"


class SamVideoPollingAccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "uvicorn.access":
            return True
        message = record.getMessage()
        if "GET " not in message:
            return True
        if SAM_VIDEO_POLLING_PATH_PREFIX not in message:
            return True
        return "/result" in message or "/cancel" in message
from moonshine_server.moonshine.slbr_runner import (
    SlbrRunner,
    clamp_local_bbox_empty_ratio_threshold,
    clamp_local_edge_feather_px,
    clamp_tile_batch,
    clamp_tile_size,
    get_overlap_for_tile_size,
    normalize_local_inference_strategy,
    read_image_bgr,
    recommend_slbr_params,
    iter_folder_local_plans,
    summarize_processing_results,
)
from moonshine_server.moonshine.model_registry import (
    build_model_status,
    download_task_manager,
    get_model_manifest,
    get_model_manifest_metadata,
)
from moonshine_server.moonshine.sam_service import SamService, SamServiceError
from moonshine_server.moonshine.sam_video_tasks import sam_video_task_manager
from moonshine_server.ocr_api import OcrApi, OcrApiError, OcrRecognizeRequest
from moonshine_server.ocr_adapter import build_local_rapidocr_adapter

CURRENT_DIR = Path(__file__).parent.absolute().resolve()
WEB_APP_DIR = CURRENT_DIR / "web_app"


def api_middleware(app: FastAPI):
    rich_available = False
    try:
        if os.environ.get("WEBUI_RICH_EXCEPTIONS", None) is not None:
            import anyio  # importing just so it can be placed on silent list
            import starlette  # importing just so it can be placed on silent list
            from rich.console import Console

            console = Console()
            rich_available = True
    except Exception:
        pass

    def handle_exception(request: Request, e: Exception):
        status_code = vars(e).get("status_code", 500)
        if isinstance(e, DiskSpaceError):
            status_code = 507
        err = {
            "error": type(e).__name__,
            "detail": vars(e).get("detail", ""),
            "body": vars(e).get("body", ""),
            "errors": str(e),
        }
        if not isinstance(
            e, HTTPException
        ):  # do not print backtrace on known httpexceptions
            message = f"API error: {request.method}: {request.url} {err}"
            if rich_available:
                print(message)
                console.print_exception(
                    show_locals=True,
                    max_frames=2,
                    extra_lines=1,
                    suppress=[anyio, starlette],
                    word_wrap=False,
                    width=min([console.width, 200]),
                )
            else:
                traceback.print_exc()
        return JSONResponse(
            status_code=status_code, content=jsonable_encoder(err)
        )

    @app.middleware("http")
    async def exception_handling(request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            return handle_exception(request, e)

    @app.exception_handler(Exception)
    async def fastapi_exception_handler(request: Request, e: Exception):
        return handle_exception(request, e)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, e: HTTPException):
        return handle_exception(request, e)

    cors_options = {
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        "allow_origins": ["*"],
        "allow_credentials": True,
        "expose_headers": ["X-Seed"],
    }
    app.add_middleware(CORSMiddleware, **cors_options)


global_sio: AsyncServer = None



def _normalize_query_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(minimum, min(maximum, value))


def _normalize_client_scope(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else "legacy-v1"


class Api:
    def __init__(self, app: FastAPI, config: ApiConfig, ocr_adapter_factory: Callable[[], Any] | None = None):
        self.app = app
        self.config = config
        self.router = APIRouter()
        self.queue_lock = threading.Lock()
        api_middleware(self.app)

        self.file_manager = self._build_file_manager()
        self.plugins = self._build_plugins()
        self.model_manager = self._build_model_manager()
        self._moonshine_runners = {}
        self._sam_services = {}
        self.job_store = self._build_job_store()
        self.application_facade = ApplicationFacade(self.job_store)
        self.workspace_registry = self._build_workspace_registry()
        self._mcp_policy_snapshot_id: str | None = None
        self._mcp_artifact_root = self._build_mcp_artifact_root()
        # Prefer the explicit caller factory; otherwise use the local, hash-
        # checked development bundle and remain unavailable when it is absent.
        self.ocr_api = OcrApi(adapter_factory=ocr_adapter_factory or build_local_rapidocr_adapter)

        # fmt: off
        self.add_api_route("/api/v1/gen-info", self.api_geninfo, methods=["POST"], response_model=GenInfoResponse)
        self.add_api_route("/api/v1/server-config", self.api_server_config, methods=["GET"],
                           response_model=ServerConfigResponse)
        self.add_api_route("/api/v1/model", self.api_current_model, methods=["GET"], response_model=ModelInfo)
        self.add_api_route("/api/v1/model", self.api_switch_model, methods=["POST"], response_model=ModelInfo)
        self.add_api_route("/api/v1/inputimage", self.api_input_image, methods=["GET"])
        self.add_api_route("/api/v1/inpaint", self.api_inpaint, methods=["POST"])
        self.add_api_route("/api/v1/switch_plugin_model", self.api_switch_plugin_model, methods=["POST"])
        self.add_api_route("/api/v1/run_plugin_gen_mask", self.api_run_plugin_gen_mask, methods=["POST"])
        self.add_api_route("/api/v1/run_plugin_gen_image", self.api_run_plugin_gen_image, methods=["POST"])
        self.add_api_route("/api/v1/samplers", self.api_samplers, methods=["GET"])
        self.add_api_route("/api/v1/adjust_mask", self.api_adjust_mask, methods=["POST"])
        self.add_api_route("/api/v1/save_image", self.api_save_image, methods=["POST"])
        self.add_api_route("/api/v1/batch_inpaint", self.api_batch_inpaint, methods=["POST"])
        self.add_api_route("/api/v1/jobs/image-batch-inpaint", self.api_mcp_image_submit, methods=["POST"])
        self.add_api_route("/api/v1/jobs/{job_id}", self.api_job, methods=["GET"])
        self.add_api_route("/api/v1/jobs/{job_id}/events", self.api_job_events, methods=["GET"])
        self.add_api_route("/api/v1/jobs/{job_id}/artifacts", self.api_job_artifacts, methods=["GET"])
        self.add_api_route("/api/v1/jobs/{job_id}/cleanup", self.api_job_cleanup, methods=["GET"])
        self.add_api_route("/api/v1/jobs/{job_id}/observability", self.api_job_observability, methods=["GET"])
        self.add_api_route("/api/v1/jobs/{job_id}/cancel", self.api_job_cancel, methods=["POST"])
        self.add_api_route("/api/v1/health", self.api_health, methods=["GET"])
        self.add_api_route("/api/v1/check_cuda", self.api_check_cuda_fixed, methods=["GET"])
        self.add_api_route("/api/v1/batch_inpaint_by_folder", self.api_batch_inpaint_by_folder, methods=["POST"])
        self.add_api_route("/api/v1/video_batch_inpaint", self.api_video_batch_inpaint, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models", self.api_moonshine_models, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/models/refresh", self.api_moonshine_models, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/{model_id}/verify", self.api_verify_moonshine_model, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/{model_id}/download", self.api_download_moonshine_model, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/{model_id}/prepare", self.api_prepare_moonshine_model, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/tasks/{task_id}", self.api_moonshine_model_task, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/sam/capabilities", self.api_moonshine_sam_capabilities, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/sam/predict", self.api_moonshine_sam_predict, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/sam/predict-batch", self.api_moonshine_sam_predict_batch, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/ocr/capabilities", self.api_moonshine_ocr_capabilities, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/ocr/recognize", self.api_moonshine_ocr_recognize, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/sam/video/propagate", self.api_moonshine_sam_video_propagate, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/sam/video/propagate/jobs", self.api_moonshine_sam_video_propagate_job_create, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/sam/video/propagate/jobs/{task_id}", self.api_moonshine_sam_video_propagate_job, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/sam/video/propagate/jobs/{task_id}/result", self.api_moonshine_sam_video_propagate_job_result, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/sam/video/propagate/jobs/{task_id}/cancel", self.api_moonshine_sam_video_propagate_job_cancel, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/sam/text/predict", self.api_moonshine_sam_text_predict, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/image/process", self.api_moonshine_image_process, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/image/inspect_folder_masks", self.api_moonshine_image_inspect_folder_masks, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/image/process_folder", self.api_moonshine_image_process_folder, methods=["POST"])
        
        # self.app.mount("/", StaticFiles(directory=WEB_APP_DIR, html=True), name="assets")
        # fmt: on

        global global_sio
        self.sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
        self.combined_asgi_app = socketio.ASGIApp(self.sio, self.app)
        self.app.mount("/ws", self.combined_asgi_app)
        global_sio = self.sio

    def add_api_route(self, path: str, endpoint, **kwargs):
        return self.app.add_api_route(path, endpoint, **kwargs)

    @staticmethod
    def _build_job_store() -> SqliteJobStore | None:
        user_data = str(os.environ.get("MOONSHINE_USER_DATA_DIR") or "").strip()
        enabled = os.environ.get("MOONSHINE_PERSISTENT_JOBS_ENABLED") == "1"
        if enabled and user_data:
            database_path = Path(user_data).expanduser().resolve() / "jobs" / "jobs.sqlite3"
            return SqliteJobStore(database_path)
        # The facade owns a process-local in-memory store for CLI/tests. The
        # disabled path must not create a filesystem database.
        return None

    @staticmethod
    def _build_workspace_registry() -> dict[str, Path]:
        """Load opaque workspace ids from application-owned configuration.

        The MCP request never carries these roots. They are injected by the
        application process through a bounded JSON map and canonicalized again
        before any input file is opened.
        """
        raw = str(os.environ.get("MOONSHINE_WORKSPACE_ROOTS_JSON") or "").strip()
        if not raw:
            return {}
        try:
            values = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        if not isinstance(values, dict):
            return {}
        registry: dict[str, Path] = {}
        for workspace_id, root in values.items():
            if not isinstance(workspace_id, str) or not re.fullmatch(r"^ws_[a-z0-9]{8,64}$", workspace_id):
                continue
            if not isinstance(root, str) or not root.strip():
                continue
            try:
                canonical = Path(root).expanduser().resolve(strict=True)
            except OSError:
                continue
            if canonical.is_dir():
                registry[workspace_id] = canonical
        return registry

    def _build_mcp_artifact_root(self) -> Path:
        user_data = str(os.environ.get("MOONSHINE_USER_DATA_DIR") or "").strip()
        if user_data:
            return Path(user_data).expanduser().resolve() / "jobs" / "artifacts"
        return Path.cwd() / ".moonshine-mcp-artifacts"

    @staticmethod
    def _normalize_mcp_relative_path(value: Any) -> str | None:
        if not isinstance(value, str) or not value.strip() or len(value) > 240:
            return None
        normalized = value.strip().replace("\\", "/")
        if (
            normalized.startswith("/")
            or normalized.startswith("//")
            or re.match(r"^[A-Za-z]:/", normalized)
            or "://" in normalized
        ):
            return None
        parts = normalized.split("/")
        if any(not part or part in {".", ".."} for part in parts):
            return None
        return normalized

    def _resolve_mcp_workspace_file(self, workspace_id: str, relative_path: str) -> Path:
        root = self.workspace_registry.get(workspace_id)
        normalized = self._normalize_mcp_relative_path(relative_path)
        if root is None or normalized is None:
            raise ValueError("workspace path is invalid")
        candidate = (root / Path(*normalized.split("/"))).resolve(strict=True)
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise ValueError("workspace path escapes its root") from exc
        if not candidate.is_file():
            raise ValueError("workspace asset is not a file")
        return candidate

    def _build_mcp_batch_request(self, req: McpImageSubmitRequest, job_id: str) -> BatchInpaintRequest:
        items = []
        for item in req.items:
            image_path = self._resolve_mcp_workspace_file(req.workspace_id, item.input_path)
            mask_path = self._resolve_mcp_workspace_file(req.workspace_id, item.mask_path)
            items.append({"id": item.id, "image": str(image_path), "mask": str(mask_path)})
        return BatchInpaintRequest(
            data=items,
            image_type="path",
            mask_type="path",
            response_type="path",
            temp_path=str(self._mcp_artifact_root / job_id),
            output_format="auto",
            output_quality=95,
        )

    @staticmethod
    def _mcp_request_summary(req: McpImageSubmitRequest) -> dict[str, Any]:
        assets = []
        item_ids = []
        for item in req.items:
            item_ids.append(item.id)
            for kind, value in (("image", item.input_path), ("mask", item.mask_path)):
                digest = hashlib.sha256(f"{kind}:{req.workspace_id}:{value}".encode("utf-8")).hexdigest()
                assets.append(
                    {
                        "schema_version": "asset-ref/v2",
                        "asset_id": f"ast_{digest[:24]}",
                        "kind": kind,
                        "locator": {
                            "scheme": "workspace",
                            "workspace_id": req.workspace_id,
                            "relative_path": value,
                        },
                        "media_type": "image/png",
                        "sha256": digest,
                        "size_bytes": 0,
                    }
                )
        return {
            "operation": "image_batch_inpaint",
            "item_count": len(req.items),
            "item_ids": item_ids,
            "input_assets": assets,
        }

    def api_job(self, job_id: str):
        try:
            return self.application_facade.get_job(job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_job_events(self, job_id: str, after: int = Query(-1, ge=-1), limit: int = Query(100, ge=1, le=500)):
        after = _normalize_query_int(after, -1, -1, 2**31 - 1)
        limit = _normalize_query_int(limit, 100, 1, 500)
        try:
            return {
                "job_id": job_id,
                "events": self.application_facade.get_events(
                    job_id,
                    after_sequence=after,
                    limit=limit,
                ),
            }
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_job_artifacts(self, job_id: str):
        try:
            return {
                "job_id": job_id,
                "artifacts": self.application_facade.get_artifacts(job_id),
            }
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_job_cleanup(self, job_id: str):
        try:
            return {
                "job_id": job_id,
                "cleanup": self.application_facade.get_cleanup_ledger(job_id),
            }
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_job_observability(self, job_id: str):
        try:
            return {
                "job_id": job_id,
                "observability": self.application_facade.get_observability_summary(job_id),
            }
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_job_cancel(self, job_id: str):
        try:
            return self.application_facade.cancel(job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Job not found") from exc

    def api_save_image(self, file: UploadFile):
        # Sanitize filename to prevent path traversal
        safe_filename = Path(file.filename).name  # Get just the filename component

        # Construct the full path within output_dir
        output_path = self.config.output_dir / safe_filename

        # Ensure output directory exists
        if not self.config.output_dir or not self.config.output_dir.exists():
            raise HTTPException(
                status_code=400,
                detail="Output directory not configured or doesn't exist",
            )

        # Read and write the file
        origin_image_bytes = file.file.read()
        ensure_disk_space(
            output_path,
            len(origin_image_bytes),
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="保存上传图片",
        )
        with open(output_path, "wb") as fw:
            fw.write(origin_image_bytes)

    def api_current_model(self) -> ModelInfo:
        return self.model_manager.current_model

    def api_switch_model(self, req: SwitchModelRequest) -> ModelInfo:
        if req.name == self.model_manager.name:
            return self.model_manager.current_model
        try:
            self.model_manager.switch(req.name)
        except RuntimeError as error:
            raise HTTPException(status_code=422, detail=str(error))
        return self.model_manager.current_model

    def api_switch_plugin_model(self, req: SwitchPluginModelRequest):
        if req.plugin_name in self.plugins:
            self.plugins[req.plugin_name].switch_model(req.model_name)
            if req.plugin_name == RemoveBG.name:
                self.config.remove_bg_model = req.model_name
            if req.plugin_name == RealESRGANUpscaler.name:
                self.config.realesrgan_model = req.model_name
            torch_gc()

    def api_server_config(self) -> ServerConfigResponse:
        plugins = []
        for it in self.plugins.values():
            plugins.append(
                PluginInfo(
                    name=it.name,
                    support_gen_image=it.support_gen_image,
                    support_gen_mask=it.support_gen_mask,
                )
            )

        return ServerConfigResponse(
            plugins=plugins,
            modelInfos=self.model_manager.scan_models(),
            removeBGModel=self.config.remove_bg_model,
            removeBGModels=RemoveBGModel.values(),
            realesrganModel=self.config.realesrgan_model,
            realesrganModels=RealESRGANModel.values(),
            enableFileManager=self.file_manager is not None,
            enableAutoSaving=self.config.output_dir is not None,
            disableModelSwitch=False,
            isDesktop=False,
            samplers=self.api_samplers(),
        )

    def _attach_moonshine_model_runtime_metadata(self, models, cuda_info):
        slbr_recommended = recommend_slbr_params(cuda_info)
        for model in models:
            model_id = str(model.get("id") or "")
            loaded = False
            if model_id == "slbr":
                model["parameters"] = {
                    **(model.get("parameters") or {}),
                    "recommended": slbr_recommended,
                }
                key = (str(self._model_dir()), str(self.config.device))
                loaded = self._moonshine_runners.get(key, None) is not None and (
                    self._moonshine_runners[key]._model is not None
                )
            elif model.get("type") == "image":
                loaded = self.model_manager.name == model_id and self.model_manager.model is not None
            elif model.get("type") == "mask":
                loaded = self._get_sam_service().model_load_state(model_id)["loaded"]
            elif model.get("type") == "ocr":
                # The OCR adapter is lazy; file verification is its readiness
                # signal and avoids reporting a permanently "not loaded" card.
                loaded = bool(model.get("verified", model.get("installed")))

            verified = bool(model.get("verified", model.get("installed")))
            compatible = bool(model.get("deviceCompatible", True))
            ready = verified and compatible and loaded
            model.update({
                "loaded": loaded,
                "loadState": "loaded" if loaded else "not_loaded",
                "runtimeReady": ready,
                "ready": ready,
                "readiness": {
                    "status": "ready" if ready else (
                        "not_loaded" if verified and compatible else "blocked"
                    ),
                    "reason": None if ready else (
                        "not_loaded" if verified and compatible else (
                            "device_incompatible" if verified else "files_not_verified"
                        )
                    ),
                },
            })
        return models

    def _get_release_runtime_profile(self, cuda_info):
        runtime_flavor = str(os.getenv("MOONSHINE_RUNTIME_FLAVOR") or "external").strip().lower()
        model_bundle = str(os.getenv("MOONSHINE_MODEL_BUNDLE") or "external-models").strip().lower()
        packaged_runtime = os.getenv("MOONSHINE_PACKAGED_RUNTIME") in {"1", "true", "yes"}
        sam3_runtime_supported = runtime_flavor in {"external", "cu126", "cu130"}
        return {
            "runtimeFlavor": runtime_flavor,
            "modelBundle": model_bundle,
            "packagedRuntime": packaged_runtime,
            "pythonTarget": "3.12",
            "sam3TextSupportedByPackage": sam3_runtime_supported,
            "sam3TextPackageReason": "" if sam3_runtime_supported else "当前运行包未声明 SAM3/SAM3.1 文本智能选区能力。",
            "externalModels": model_bundle == "external-models",
            "bundledModels": model_bundle == "bundled-models",
        }

    def api_moonshine_models(
        self,
        req: Optional[MoonshineModelRegistryRequest] = Body(default=None),
        model_dir: Optional[str] = Query(default=None),
    ):
        """Return the dynamic Moonshine model registry used by the client."""
        self._sync_model_dir(model_dir or (req.model_dir if req else ""))
        self.model_manager.scan_models()
        cuda_info = self._get_cuda_info()
        models = build_model_status(self._model_dir(), cuda_info)
        self._attach_moonshine_model_runtime_metadata(models, cuda_info)

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "currentModel": self.model_manager.name,
                    "modelDir": str(self._model_dir()),
                    "cuda": cuda_info,
                    "runtime": self._get_release_runtime_profile(cuda_info),
                    "modelManifest": get_model_manifest_metadata(),
                    "models": models,
                }
            )
        )

    def api_verify_moonshine_model(
        self,
        model_id: str,
        req: Optional[MoonshineModelRegistryRequest] = Body(default=None),
    ):
        """Refresh and return one model's file/install status."""
        self._sync_model_dir(req.model_dir if req else "")
        manifest_item = get_model_manifest(model_id)
        if manifest_item is None:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        cuda_info = self._get_cuda_info()
        models = build_model_status(self._model_dir(), cuda_info)
        self._attach_moonshine_model_runtime_metadata(models, cuda_info)
        model = next((item for item in models if item.get("id") == model_id), None)
        if model is None:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "success": True,
                    "runtime": self._get_release_runtime_profile(cuda_info),
                    "model": model,
                }
            )
        )

    def api_download_moonshine_model(
        self,
        model_id: str,
        req: Optional[MoonshineModelRegistryRequest] = Body(default=None),
    ):
        """Create an in-process model download task."""
        self._sync_model_dir(req.model_dir if req else "")
        try:
            task = download_task_manager.create_download_task(
                model_id,
                self._model_dir(),
                license_acceptance={
                    "accepted": bool(req.license_accepted) if req else False,
                    "acceptanceId": req.license_acceptance_id if req else "",
                },
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "success": True,
                    "task": task.to_dict(),
                }
            )
        )

    def api_moonshine_model_task(self, task_id: str):
        task = download_task_manager.get_task(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail=f"Download task not found: {task_id}")
        return JSONResponse(content=jsonable_encoder(task.to_dict()))

    def api_prepare_moonshine_model(
        self,
        model_id: str,
        req: Optional[MoonshineModelRegistryRequest] = Body(default=None),
    ):
        """Verify an installed model and initialize its runtime without running inference."""
        self._sync_model_dir(req.model_dir if req else "")
        model = next(
            (item for item in build_model_status(self._model_dir(), self._get_cuda_info()) if item.get("id") == model_id),
            None,
        )
        if model is None:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
        if not model.get("installed"):
            reason = "files_corrupt" if model.get("corruptFiles") else "files_missing"
            return JSONResponse(
                status_code=422,
                content=jsonable_encoder({
                    "success": False,
                    "modelId": model_id,
                    "verified": False,
                    "loaded": False,
                    "loadState": "blocked",
                    "runtimeReady": False,
                    "ready": False,
                    "readiness": {"status": "blocked", "reason": reason},
                    "error": f"Model is not installed or verified: {model_id}",
                }),
            )
        if not model.get("deviceCompatible", True):
            return JSONResponse(
                status_code=422,
                content=jsonable_encoder({
                    "success": False,
                    "modelId": model_id,
                    "verified": True,
                    "loaded": False,
                    "loadState": "blocked",
                    "runtimeReady": False,
                    "ready": False,
                    "readiness": {
                        "status": "blocked",
                        "reason": "device_incompatible",
                    },
                    "error": f"Model is not compatible with the current device: {model_id}",
                }),
            )

        try:
            if model_id == "slbr":
                self._get_slbr_runner()._load_model()
                loaded_model = self._get_slbr_runner()._model is not None
            elif model.get("type") == "image":
                self.model_manager.switch(model_id)
                loaded_model = self.model_manager.model is not None
            elif model.get("type") == "mask":
                preparation = self._get_sam_service().prepare_model(model_id)
                loaded_model = bool(preparation.get("loaded"))
            elif model.get("type") == "ocr":
                # RapidOCR initializes lazily on the first recognition call;
                # verified ONNX files are sufficient for the preparation gate.
                loaded_model = True
            else:
                raise ValueError(f"Unsupported model type: {model.get('type')}")
        except Exception as error:
            logger.exception(f"Model preparation failed: {model_id}")
            return JSONResponse(
                status_code=422,
                content=jsonable_encoder({
                    "success": False,
                    "modelId": model_id,
                    "verified": True,
                    "loaded": False,
                    "loadState": "failed",
                    "runtimeReady": False,
                    "ready": False,
                    "readiness": {"status": "failed", "reason": "load_failed"},
                    "error": str(error),
                }),
            )

        ready = bool(loaded_model)

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "success": True,
                    "modelId": model_id,
                    "currentModel": self.model_manager.name,
                    "loaded": loaded_model,
                    "verified": True,
                    "loadState": "loaded" if ready else "failed",
                    "runtimeReady": ready,
                    "ready": ready,
                    "readiness": {
                        "status": "ready" if ready else "failed",
                        "reason": None if ready else "load_failed",
                    },
                }
            )
        )

    def api_moonshine_sam_capabilities(self):
        """Return SAM smart-selection capability state without loading predictor weights."""
        return JSONResponse(content=jsonable_encoder(self._get_sam_service().capabilities()))

    def api_moonshine_ocr_capabilities(self):
        """Return a safe OCR capability projection without loading a runtime."""
        return JSONResponse(content=jsonable_encoder(self.ocr_api.capabilities()))

    def api_moonshine_ocr_recognize(self, raw_request: Any = Body(default=None)):
        """Recognize bounded in-memory image bytes through the injected OCR adapter."""
        try:
            req = OcrRecognizeRequest.model_validate(raw_request)
        except ValidationError:
            return JSONResponse(
                status_code=400,
                content={"error": {"code": "OCR_INPUT_INVALID", "message": "OCR input is invalid"}},
            )
        try:
            result = self.ocr_api.recognize(
                req.encoded_image,
                regions=req.regions,
                options=req.options,
                model_id=req.model_id,
            )
        except OcrApiError as error:
            return JSONResponse(
                status_code=error.status_code,
                content={"error": {"code": error.code, "message": error.message}},
            )
        return JSONResponse(content=jsonable_encoder(result))

    def api_moonshine_sam_predict(self, req: MoonshineSamPredictRequest):
        """Run SAM1/SAM2 point/box prediction using manually installed model files."""
        try:
            result = self._get_sam_service().predict(
                image=req.image,
                image_type=req.image_type,
                model_id=req.model_id,
                points=req.points,
                box=req.box,
                multimask_output=req.multimask_output,
            )
        except SamServiceError as error:
            raise HTTPException(status_code=422, detail=str(error))
        return JSONResponse(content=jsonable_encoder(result))

    def api_moonshine_sam_predict_batch(self, req: MoonshineSamPredictBatchRequest):
        """Run multiple point/box prompts against one SAM image embedding."""
        try:
            result = self._get_sam_service().predict_batch(
                image=req.image,
                image_type=req.image_type,
                model_id=req.model_id,
                prompts=req.prompts,
                multimask_output=req.multimask_output,
            )
        except SamServiceError as error:
            raise HTTPException(status_code=422, detail=str(error))
        return JSONResponse(content=jsonable_encoder(result))

    def api_moonshine_sam_video_propagate(self, req: MoonshineSamVideoPropagateRequest):
        """Run SAM video propagation on a JPEG frame directory or local video path."""
        try:
            result = self._get_sam_service().propagate_video(
                frame_dir=req.frame_dir,
                video_path=req.video_path,
                input_type=req.input_type,
                model_id=req.model_id,
                frame_index=req.frame_index,
                object_id=req.object_id,
                points=req.points,
                box=req.box,
                objects=req.objects,
                text=req.text,
                language=req.language,
                prompt_source=req.prompt_source,
                prompt_color=req.prompt_color,
                prompt_noun=req.prompt_noun,
                max_frames=req.max_frames,
                reverse=req.reverse,
                offload_video_to_cpu=req.offload_video_to_cpu,
                offload_state_to_cpu=req.offload_state_to_cpu,
                response_type=req.response_type,
                mask_output_dir=req.mask_output_dir,
            )
        except SamServiceError as error:
            raise HTTPException(status_code=422, detail=str(error))
        return JSONResponse(content=jsonable_encoder(result))

    def _run_sam_video_propagate_task(self, task_id: str):
        task = sam_video_task_manager.get_task(task_id)
        if not task:
            return
        req = task.request
        try:
            result = self._get_sam_service().propagate_video(
                frame_dir=req.frame_dir,
                video_path=req.video_path,
                input_type=req.input_type,
                model_id=req.model_id,
                frame_index=req.frame_index,
                object_id=req.object_id,
                points=req.points,
                box=req.box,
                objects=req.objects,
                text=req.text,
                language=req.language,
                prompt_source=req.prompt_source,
                prompt_color=req.prompt_color,
                prompt_noun=req.prompt_noun,
                max_frames=req.max_frames,
                reverse=req.reverse,
                offload_video_to_cpu=req.offload_video_to_cpu,
                offload_state_to_cpu=req.offload_state_to_cpu,
                response_type=req.response_type,
                mask_output_dir=req.mask_output_dir,
                progress_callback=sam_video_task_manager.make_progress_callback(task_id),
            )
            sam_video_task_manager.finish_task(task_id, result)
        except RuntimeError as error:
            sam_video_task_manager.fail_task(task_id, str(error))
        except SamServiceError as error:
            sam_video_task_manager.fail_task(task_id, str(error))
        except Exception as error:
            logger.exception("SAM video propagation task failed")
            sam_video_task_manager.fail_task(task_id, str(error))

    def api_moonshine_sam_video_propagate_job_create(self, req: MoonshineSamVideoPropagateRequest):
        """Start a background SAM video propagation task."""
        task = sam_video_task_manager.create_task(req)
        worker = threading.Thread(
            target=self._run_sam_video_propagate_task,
            args=(task.task_id,),
            daemon=True,
            name=f"sam-video-{task.task_id[:8]}",
        )
        worker.start()
        return JSONResponse(content=jsonable_encoder(task.to_dict()))

    def api_moonshine_sam_video_propagate_job(self, task_id: str):
        task = sam_video_task_manager.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="SAM video propagation task not found")
        return JSONResponse(content=jsonable_encoder(task.to_dict()))

    def api_moonshine_sam_video_propagate_job_result(self, task_id: str):
        task = sam_video_task_manager.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="SAM video propagation task not found")
        if task.status == "failed":
            raise HTTPException(status_code=422, detail=task.error or task.message)
        if task.status == "canceled":
            raise HTTPException(status_code=409, detail=task.message)
        if task.status != "completed" or task.result is None:
            raise HTTPException(status_code=409, detail="SAM video propagation task is not complete")
        return JSONResponse(content=jsonable_encoder(task.result))

    def api_moonshine_sam_video_propagate_job_cancel(self, task_id: str):
        task = sam_video_task_manager.cancel_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="SAM video propagation task not found")
        return JSONResponse(content=jsonable_encoder(task.to_dict()))

    def api_moonshine_sam_text_predict(self, req: MoonshineSamTextPredictRequest):
        """Run SAM3 text smart selection when the managed runtime and model are ready."""
        try:
            result = self._get_sam_service().predict_text(
                image=req.image,
                image_type=req.image_type,
                model_id=req.model_id,
                text=req.text,
                language=req.language,
                prompt_source=req.prompt_source,
                prompt_color=req.prompt_color,
                prompt_noun=req.prompt_noun,
            )
        except SamServiceError as error:
            raise HTTPException(status_code=422, detail=str(error))
        return JSONResponse(content=jsonable_encoder(result))

    def _model_dir(self) -> Path:
        model_dir = os.getenv("XDG_CACHE_HOME") or os.getenv("TORCH_HOME")
        if not model_dir:
            model_dir = str(Path.cwd() / "models")
        return Path(model_dir).expanduser().resolve()

    def _sync_model_dir(self, model_dir: Optional[str]):
        normalized = str(model_dir or "").strip()
        if not normalized:
            return
        next_model_dir = Path(normalized).expanduser().resolve()
        current_model_dir = self._model_dir()
        if next_model_dir == current_model_dir:
            return
        logger.info(f"Switch model directory: {current_model_dir} -> {next_model_dir}")
        self._release_sam_runtime(reason="model_dir_changed", force=True)
        next_model_dir.mkdir(exist_ok=True, parents=True)
        os.environ["XDG_CACHE_HOME"] = str(next_model_dir)
        os.environ["TORCH_HOME"] = str(next_model_dir)
        os.environ["U2NET_HOME"] = str(next_model_dir)
        os.environ["HF_HOME"] = str(next_model_dir / "huggingface")
        self._moonshine_runners.clear()
        self._sam_services.clear()

    def _get_slbr_runner(self) -> SlbrRunner:
        key = (str(self._model_dir()), str(self.config.device))
        runner = self._moonshine_runners.get(key)
        if runner is None:
            runner = SlbrRunner(self._model_dir(), self.config.device)
            self._moonshine_runners[key] = runner
        return runner

    @staticmethod
    def _normalize_device_value(device) -> str:
        raw_value = getattr(device, "value", device)
        normalized = str(raw_value or "cpu").strip().lower()
        if normalized.startswith("device."):
            normalized = normalized.rsplit(".", 1)[-1]
        return normalized if normalized in {"cpu", "cuda", "mps"} else "cpu"

    def _get_sam_service(self, device: Optional[str] = None) -> SamService:
        sam_device = self._normalize_device_value(device or self.config.device)
        key = (str(self._model_dir()), sam_device)
        service = self._sam_services.get(key)
        if service is None:
            service = SamService(self._model_dir(), sam_device)
            self._sam_services[key] = service
        return service

    def _release_sam_runtime(self, *, reason: str, force: bool = False):
        if not force and not getattr(self.config, "sam_release_before_processing", True):
            return
        if not self._sam_services:
            return
        if not force and sam_video_task_manager.has_active_tasks():
            logger.info(f"Skip SAM runtime release: reason={reason}, active SAM video task is running")
            return
        released_totals = {
            "predictors": 0,
            "sam3ImagePredictors": 0,
            "videoPredictors": 0,
            "textPredictors": 0,
            "imageCache": 0,
            "sam3ImageCache": 0,
            "textImageCache": 0,
        }
        for service in list(self._sam_services.values()):
            released = service.release()
            for key, value in released.items():
                released_totals[key] = released_totals.get(key, 0) + int(value or 0)
        if any(released_totals.values()):
            logger.info(f"Release SAM runtime: reason={reason}, released={released_totals}")

    def _release_sam_runtime_before_processing(self, reason: str = "before_processing"):
        self._release_sam_runtime(reason=reason, force=False)

    def _get_moonshine_runner(self, model_id: str):
        if model_id == "slbr":
            return self._get_slbr_runner()
        raise HTTPException(status_code=422, detail=f"Unsupported Moonshine model: {model_id}")

    def _normalize_moonshine_options(self, options):
        tile_size = clamp_tile_size(getattr(options, "tile_size", 384))
        tile_batch = clamp_tile_batch(getattr(options, "tile_batch", 4))
        return {
            "tile_size": tile_size,
            "tile_batch": tile_batch,
            "overlap": get_overlap_for_tile_size(tile_size),
            "local_inference_strategy": normalize_local_inference_strategy(
                getattr(options, "local_inference_strategy", "auto")
            ),
            "local_bbox_empty_ratio_threshold": clamp_local_bbox_empty_ratio_threshold(
                getattr(options, "local_bbox_empty_ratio_threshold", 50)
            ),
            "local_edge_feather_px": clamp_local_edge_feather_px(
                getattr(options, "local_edge_feather_px", 2)
            ),
        }

    @staticmethod
    def _run_diagnostic_command(command, timeout=4):
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
                encoding="utf-8",
                errors="replace",
            )
            return {
                "available": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": (result.stdout or "").strip(),
                "stderr": (result.stderr or "").strip(),
            }
        except FileNotFoundError:
            return {
                "available": False,
                "returncode": None,
                "stdout": "",
                "stderr": "command not found",
            }
        except Exception as exc:
            return {
                "available": False,
                "returncode": None,
                "stdout": "",
                "stderr": str(exc),
            }

    def _get_nvidia_driver_info(self):
        result = self._run_diagnostic_command(
            [
                "nvidia-smi",
                "--query-gpu=name,driver_version",
                "--format=csv,noheader",
            ]
        )
        gpu_names = []
        driver_version = ""
        if result["available"]:
            for line in result["stdout"].splitlines():
                parts = [part.strip() for part in line.split(",")]
                if parts and parts[0]:
                    gpu_names.append(parts[0])
                if len(parts) > 1 and parts[1] and not driver_version:
                    driver_version = parts[1]
        return {
            "nvidia_smi_available": result["available"],
            "nvidia_driver_available": result["available"] and bool(gpu_names),
            "nvidia_driver_version": driver_version,
            "nvidia_gpu_count": len(gpu_names),
            "nvidia_gpu_names": gpu_names,
            "nvidia_smi_error": "" if result["available"] else result["stderr"],
        }

    def _get_nvcc_info(self):
        result = self._run_diagnostic_command(["nvcc", "--version"])
        version_line = ""
        if result["available"]:
            version_line = next(
                (
                    line.strip()
                    for line in result["stdout"].splitlines()
                    if "release" in line.lower()
                ),
                result["stdout"].splitlines()[-1].strip() if result["stdout"].splitlines() else "",
            )
        return {
            "nvcc_available": result["available"],
            "nvcc_version": version_line,
            "nvcc_error": "" if result["available"] else result["stderr"],
        }

    def _get_cuda_info(self):
        torch_cuda_version = getattr(getattr(torch, "version", None), "cuda", None)
        torch_package = "cuda" if torch_cuda_version else "cpu"
        driver_info = self._get_nvidia_driver_info()
        nvcc_info = self._get_nvcc_info()
        cuda_info = {
            "cuda_available": torch.cuda.is_available(),
            "cuda_device_count": torch.cuda.device_count(),
            "cuda_compatible": None,
            "current_device": None,
            "device_name": None,
            "device_capability": None,
            "supported_arches": None,
            "total_memory_mb": None,
            "free_memory_mb": None,
            "used_memory_mb": None,
            "message": None,
            "torch_package": torch_package,
            "torch_cuda_version": torch_cuda_version,
            "torch_cuda_available": torch.cuda.is_available(),
            **driver_info,
            **nvcc_info,
            "diagnostic_code": None,
            "diagnostic_status": "unknown",
            "notification_level": None,
            "notification_title": None,
            "notification_message": None,
            "notification_links": [],
        }

        if cuda_info["cuda_available"] and cuda_info["cuda_device_count"] > 0:
            try:
                current_device = torch.cuda.current_device()
                cuda_info["current_device"] = current_device
                cuda_info["device_name"] = torch.cuda.get_device_name(current_device)

                if hasattr(torch.cuda, "get_device_capability"):
                    cuda_info["device_capability"] = torch.cuda.get_device_capability(current_device)

                if hasattr(torch.cuda, "get_arch_list"):
                    try:
                        cuda_info["supported_arches"] = list(torch.cuda.get_arch_list() or [])
                    except Exception:
                        cuda_info["supported_arches"] = []

                supported_arch_values = []
                for arch in cuda_info["supported_arches"] or []:
                    if isinstance(arch, str) and arch.startswith("sm_"):
                        suffix = arch[3:]
                        if suffix.isdigit():
                            supported_arch_values.append(int(suffix))

                if cuda_info["device_capability"] and supported_arch_values:
                    device_arch = (
                        int(cuda_info["device_capability"][0]) * 10
                        + int(cuda_info["device_capability"][1])
                    )
                    max_supported_arch = max(supported_arch_values)
                    cuda_info["cuda_compatible"] = device_arch <= max_supported_arch
                    if not cuda_info["cuda_compatible"]:
                        cuda_info["message"] = (
                            f"当前显卡算力为 sm_{device_arch}，但当前 PyTorch 仅支持到 "
                            f"sm_{max_supported_arch}。请升级到支持 CUDA 12.8/13.0 的运行环境，"
                            "或切换为 CPU 模式。"
                        )
                elif cuda_info["device_capability"]:
                    cuda_info["cuda_compatible"] = True

                if hasattr(torch.cuda, "mem_get_info"):
                    free_bytes, total_bytes = torch.cuda.mem_get_info(current_device)
                    cuda_info["total_memory_mb"] = total_bytes / (1024 * 1024)
                    cuda_info["free_memory_mb"] = free_bytes / (1024 * 1024)
                    cuda_info["used_memory_mb"] = (total_bytes - free_bytes) / (1024 * 1024)
                elif hasattr(torch.cuda, "get_device_properties"):
                    props = torch.cuda.get_device_properties(current_device)
                    total_mb = props.total_memory / (1024 * 1024)
                    reserved_mb = torch.cuda.memory_reserved(current_device) / (1024 * 1024)
                    allocated_mb = torch.cuda.memory_allocated(current_device) / (1024 * 1024)
                    cuda_info["total_memory_mb"] = total_mb
                    cuda_info["used_memory_mb"] = allocated_mb
                    cuda_info["free_memory_mb"] = max(0, total_mb - reserved_mb)
            except Exception as e:
                cuda_info["error"] = str(e)
                cuda_info["cuda_compatible"] = False
        else:
            cuda_info["cuda_compatible"] = False
            cuda_info["message"] = "当前运行环境未检测到可用 CUDA 设备。"

        if torch_package == "cpu":
            cuda_info["diagnostic_code"] = "torch_cpu_package"
            cuda_info["diagnostic_status"] = "cpu-runtime"
            cuda_info["message"] = "当前为 CPU 运行包，CUDA 推理不可用。"
        elif cuda_info["cuda_available"] and cuda_info["cuda_compatible"] is not False:
            cuda_info["diagnostic_code"] = "cuda_inference_available"
            cuda_info["diagnostic_status"] = "ok"
            if not cuda_info["nvcc_available"]:
                cuda_info["toolkit_message"] = (
                    "未检测到 nvcc/CUDA Toolkit；这不会影响当前 PyTorch CUDA 推理。"
                )
        elif not cuda_info["nvidia_driver_available"]:
            cuda_info["diagnostic_code"] = "no_nvidia_gpu"
            cuda_info["diagnostic_status"] = "warning"
            cuda_info["notification_level"] = "warning"
            cuda_info["notification_title"] = "未检测到可用 GPU"
            cuda_info["notification_message"] = (
                "未检测到 NVIDIA GPU 或驱动，SAM 高配能力将使用 CPU 或不可用。"
            )
            cuda_info["notification_links"] = [
                {
                    "label": "NVIDIA 驱动",
                    "url": "https://www.nvidia.com/en-us/drivers/",
                }
            ]
        else:
            cuda_info["diagnostic_code"] = "torch_cuda_unavailable"
            cuda_info["diagnostic_status"] = "warning"
            cuda_info["notification_level"] = "warning"
            cuda_info["notification_title"] = "CUDA 推理不可用"
            cuda_info["notification_message"] = (
                "已检测到 NVIDIA GPU，但当前 PyTorch CUDA 不可用。请检查 CUDA 版 PyTorch "
                "与 NVIDIA 驱动是否匹配。"
            )
            cuda_info["notification_links"] = [
                {
                    "label": "PyTorch 安装说明",
                    "url": "https://pytorch.org/get-started/locally/",
                },
                {
                    "label": "NVIDIA 驱动",
                    "url": "https://www.nvidia.com/en-us/drivers/",
                },
            ]

        cuda_info["recommended"] = {
            "slbr": recommend_slbr_params(cuda_info),
        }
        return cuda_info

    def api_health(self):
        """Return a lightweight, uncached service liveness response."""
        return JSONResponse(
            content={"status": "ok"},
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )

    def api_check_cuda_fixed(self):
        """Return CUDA availability, memory and model recommendation details."""
        return JSONResponse(content=jsonable_encoder(self._get_cuda_info()))

    def api_input_image(self) -> FileResponse:
        if self.config.input is None:
            raise HTTPException(status_code=200, detail="No input image configured")

        if self.config.input.is_file():
            return FileResponse(self.config.input)
        raise HTTPException(status_code=404, detail="Input image not found")

    def api_geninfo(self, file: UploadFile) -> GenInfoResponse:
        _, _, info = load_img(file.file.read(), return_info=True)
        parts = info.get("parameters", "").split("Negative prompt: ")
        prompt = parts[0].strip()
        negative_prompt = ""
        if len(parts) > 1:
            negative_prompt = parts[1].split("\n")[0].strip()
        return GenInfoResponse(prompt=prompt, negative_prompt=negative_prompt)

    def api_inpaint(self, req: InpaintRequest):
        image, alpha_channel, infos, *_ = decode_base64_to_image(req.image)
        mask, _, _, *_ = decode_base64_to_image(req.mask, gray=True)

        mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]
        if image.shape[:2] != mask.shape[:2]:
            raise HTTPException(
                400,
                detail=f"Image size({image.shape[:2]}) and mask size({mask.shape[:2]}) not match.",
            )
        start = time.time()
        self._release_sam_runtime_before_processing("single_image_inpaint")
        rgb_np_img, color_decision = try_flat_background_fill(
            image, mask, req.color_stabilization
        )
        if rgb_np_img is None:
            try:
                rgb_np_img = self.model_manager(image, mask, req)
                rgb_np_img, color_decision = apply_inpaint_color_stabilization(
                    image, mask, rgb_np_img, req.color_stabilization
                )
            finally:
                torch_gc()
        logger.info(f"process time: {(time.time() - start) * 1000:.2f}ms")

        rgb_np_img = cv2.cvtColor(rgb_np_img.astype(np.uint8), cv2.COLOR_BGR2RGB)
        rgb_res = concat_alpha_channel(rgb_np_img, alpha_channel)

        ext = "png"
        res_img_bytes = pil_to_bytes(
            Image.fromarray(rgb_res),
            ext=ext,
            quality=self.config.quality,
            infos=infos,
        )
        return Response(
            content=res_img_bytes,
            media_type=f"image/{ext}",
            headers={"X-Seed": str(req.sd_seed)},
        )

    def api_run_plugin_gen_image(self, req: RunPluginRequest):
        ext = "png"
        if req.name not in self.plugins:
            raise HTTPException(status_code=422, detail="Plugin not found")
        if not self.plugins[req.name].support_gen_image:
            raise HTTPException(
                status_code=422, detail="Plugin does not support output image"
            )
        rgb_np_img, alpha_channel, infos, *_ = decode_base64_to_image(req.image)
        bgr_or_rgba_np_img = self.plugins[req.name].gen_image(rgb_np_img, req)
        torch_gc()

        if bgr_or_rgba_np_img.shape[2] == 4:
            rgba_np_img = bgr_or_rgba_np_img
        else:
            rgba_np_img = cv2.cvtColor(bgr_or_rgba_np_img, cv2.COLOR_BGR2RGB)
            rgba_np_img = concat_alpha_channel(rgba_np_img, alpha_channel)

        return Response(
            content=pil_to_bytes(
                Image.fromarray(rgba_np_img),
                ext=ext,
                quality=self.config.quality,
                infos=infos,
            ),
            media_type=f"image/{ext}",
        )

    def api_run_plugin_gen_mask(self, req: RunPluginRequest):
        if req.name not in self.plugins:
            raise HTTPException(status_code=422, detail="Plugin not found")
        if not self.plugins[req.name].support_gen_mask:
            raise HTTPException(
                status_code=422, detail="Plugin does not support output image"
            )
        rgb_np_img, alpha_channel, infos = decode_base64_to_image(req.image)
        bgr_or_gray_mask = self.plugins[req.name].gen_mask(rgb_np_img, req)
        torch_gc()
        res_mask = gen_frontend_mask(bgr_or_gray_mask)
        return Response(
            content=numpy_to_bytes(res_mask, "png"),
            media_type="image/png",
        )

    def api_samplers(self) -> List[str]:
        return []

    def api_adjust_mask(self, req: AdjustMaskRequest):
        mask, _, _ = decode_base64_to_image(req.mask, gray=True)
        mask = adjust_mask(mask, req.kernel_size, req.operate)
        return Response(content=numpy_to_bytes(mask, "png"), media_type="image/png")

    def launch(self):
        self.app.include_router(self.router)
        access_logger = logging.getLogger("uvicorn.access")
        if not any(isinstance(item, SamVideoPollingAccessLogFilter) for item in access_logger.filters):
            access_logger.addFilter(SamVideoPollingAccessLogFilter())
        uvicorn.run(
            self.combined_asgi_app,
            host=self.config.host,
            port=self.config.port,
            timeout_keep_alive=999999999,
        )

    def _build_file_manager(self) -> Optional[FileManager]:
        if self.config.input and self.config.input.is_dir():
            logger.info(
                f"Input is directory, initialize file manager {self.config.input}"
            )

            return FileManager(
                app=self.app,
                input_dir=self.config.input,
                mask_dir=self.config.mask_dir,
                output_dir=self.config.output_dir,
            )
        return None

    def _build_plugins(self) -> Dict[str, BasePlugin]:
        return build_plugins(
            self.config.enable_remove_bg,
            self.config.remove_bg_device,
            self.config.remove_bg_model,
            self.config.enable_anime_seg,
            self.config.enable_realesrgan,
            self.config.realesrgan_device,
            self.config.realesrgan_model,
            self.config.enable_gfpgan,
            self.config.gfpgan_device,
            self.config.enable_restoreformer,
            self.config.restoreformer_device,
            self.config.no_half,
        )

    def _build_model_manager(self):
        return ModelManager(
            name=self.config.model,
            device=torch.device(self.config.device),
            no_half=self.config.no_half,
            low_mem=self.config.low_mem,
        )

    @staticmethod
    def _normalize_base64_payload(value: str) -> str:
        if value.startswith("data:image/") or value.startswith(
            "data:application/octet-stream;base64,"
        ):
            return value.split(";")[1].split(",")[1]
        return value

    @staticmethod
    def _detect_base64_image_format(value: str) -> str:
        encoded = Api._normalize_base64_payload(value)
        try:
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
                return normalize_image_format(image.format)
        except Exception:
            return ""

    @staticmethod
    def _build_result_meta(spec: dict) -> dict:
        return {
            "format": spec["format"],
            "mime_type": spec["mime_type"],
            "extension": spec["extension"],
        }

    @staticmethod
    def _encode_result_array(
        result_array: np.ndarray,
        spec: dict,
        infos: Optional[dict] = None,
    ) -> bytes:
        return encode_pil_image(
            Image.fromarray(result_array),
            output_format=spec["format"],
            quality=spec["quality"],
            infos=infos,
        )

    @staticmethod
    def _build_result_payload(result_bytes: bytes, spec: dict) -> str:
        return build_image_data_url(result_bytes, spec["mime_type"])

    @staticmethod
    def _resolve_result_spec(
        output_format: str,
        output_quality: int,
        source_format: str,
        alpha_channel,
    ) -> dict:
        return resolve_image_output_spec(
            requested_format=output_format,
            source_format=source_format,
            has_alpha=alpha_channel is not None,
            quality=output_quality,
        )

    def _decode_item_image(self, image_value: str, image_type: str):
        if image_type == "base64":
            image, alpha_channel, infos = decode_base64_to_image(image_value)
            return image, alpha_channel, infos, self._detect_base64_image_format(image_value)

        if not os.path.exists(image_value):
            raise FileNotFoundError(f"Image file not found: {image_value}")
        with open(image_value, "rb") as image_file:
            image_b64 = base64.b64encode(image_file.read()).decode("utf-8")
        image, alpha_channel, infos = decode_base64_to_image(image_b64)
        return image, alpha_channel, infos, image_format_from_path(image_value)

    def _decode_item_mask(self, mask_value: str, mask_type: str):
        return decode_binary_mask(mask_value, mask_type)

    def _save_result_image(
        self,
        result_bytes: bytes,
        item_id: str,
        temp_path: Optional[str],
        extension: str = ".png",
        execution_context=None,
    ):
        output_extension = extension if str(extension or "").startswith(".") else f".{extension}"
        output_name = f"result_{item_id}{output_extension}"
        if execution_context is not None and temp_path:
            mime_type = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".png": "image/png",
            }.get(output_extension.lower(), "application/octet-stream")
            artifact = execution_context.publish_bytes(
                root=temp_path,
                relative_path=output_name,
                payload=result_bytes,
                mime_type=mime_type,
            )
            # Keep the legacy response path shape; the Job/Artifact contract
            # exposes only the artifact locator and never the absolute path.
            return os.path.join(str(temp_path), output_name)
        if temp_path:
            os.makedirs(temp_path, exist_ok=True)
            output_path = os.path.join(temp_path, output_name)
        else:
            output_path = output_name

        ensure_disk_space(
            output_path,
            len(result_bytes),
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="保存图片处理结果",
        )
        with open(output_path, "wb") as output_file:
            output_file.write(result_bytes)
        return output_path

    def api_moonshine_image_process(self, req: MoonshineImageProcessRequest):
        """Process SLBR images, optionally applying local results through a mask."""
        self._release_sam_runtime_before_processing("moonshine_image_process")
        runner = self._get_moonshine_runner(req.model_id)
        options = self._normalize_moonshine_options(req.options)
        results = []
        start_time = time.time()

        for index, item in enumerate(
            tqdm(
                req.data,
                total=len(req.data),
                desc=f"{req.model_id} processing",
                mininterval=1,
            )
        ):
            item_id = item.id or f"item_{index}"
            try:
                image_rgb, alpha_channel, infos, source_format = self._decode_item_image(
                    item.image, req.image_type
                )
                image_bgr = cv2.cvtColor(image_rgb.astype(np.uint8), cv2.COLOR_RGB2BGR)
                apply_scope = item.apply_scope or req.apply_scope
                local_diagnostics = None
                if apply_scope == "mask":
                    mask = self._decode_item_mask(item.mask, req.mask_type)
                    if mask.shape[:2] != image_bgr.shape[:2]:
                        mask = cv2.resize(
                            mask,
                            (image_bgr.shape[1], image_bgr.shape[0]),
                            interpolation=cv2.INTER_NEAREST,
                        )
                    clean_bgr, local_diagnostics = runner.infer_bgr_local(
                        image_bgr,
                        mask,
                        tile_size=options["tile_size"],
                        tile_batch=options["tile_batch"],
                        strategy=options["local_inference_strategy"],
                        bbox_empty_ratio_threshold=options[
                            "local_bbox_empty_ratio_threshold"
                        ],
                        edge_feather_px=options["local_edge_feather_px"],
                    )
                    output_spec = self._resolve_result_spec(
                        "png",
                        req.output_quality,
                        source_format,
                        alpha_channel,
                    )
                else:
                    clean_bgr, _ = runner.infer_bgr(
                        image_bgr,
                        tile_size=options["tile_size"],
                        tile_batch=options["tile_batch"],
                    )
                    output_spec = self._resolve_result_spec(
                        req.output_format,
                        req.output_quality,
                        source_format,
                        alpha_channel,
                    )
                clean_rgb = cv2.cvtColor(clean_bgr.astype(np.uint8), cv2.COLOR_BGR2RGB)
                serializable_result = concat_alpha_channel(clean_rgb, alpha_channel)
                result_bytes = self._encode_result_array(
                    serializable_result,
                    output_spec,
                    infos,
                )

                if req.response_type == "path":
                    result_data = self._save_result_image(
                        result_bytes,
                        item_id,
                        req.temp_path,
                        output_spec["extension"],
                    )
                else:
                    result_data = self._build_result_payload(result_bytes, output_spec)

                result = {
                    "id": item_id,
                    "index": index,
                    "result": result_data,
                    "success": True,
                    "apply_scope": apply_scope,
                    "inference_strategy": (
                        local_diagnostics["inference_strategy"]
                        if local_diagnostics
                        else "full"
                    ),
                    **self._build_result_meta(output_spec),
                }
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
                            "fallback_reason": local_diagnostics["fallback_reason"] or None,
                        }
                    )
                results.append(result)
                torch_gc()
            except Exception as e:
                if isinstance(e, DiskSpaceError):
                    raise
                logger.exception(f"Moonshine image processing failed for {item_id}")
                results.append(
                    {
                        "id": item_id,
                        "index": index,
                        "error": str(e),
                        "success": False,
                    }
                )

        total_time = time.time() - start_time
        summary = summarize_processing_results(results)
        return JSONResponse(
            content=jsonable_encoder(
                {
                    "results": results,
                    "total_time": total_time,
                    "processed_count": len(results),
                    **summary,
                }
            )
        )

    def api_mcp_image_submit(
        self,
        raw_request: dict[str, Any] = Body(...),
        idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
        client_id: Optional[str] = Header(None, alias="X-Moonshine-Client"),
        request_id: Optional[str] = Header(None, alias="X-Moonshine-Request-Id"),
        policy_snapshot_id: Optional[str] = Header(None, alias="X-Moonshine-Policy-Snapshot"),
    ):
        """Queue the contract-v1 MCP batch without changing legacy v1 semantics."""
        try:
            req = McpImageSubmitRequest.model_validate(raw_request)
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail={"code": "INVALID_SUBMIT_REQUEST"}) from exc
        if (
            not isinstance(idempotency_key, str)
            or not idempotency_key
            or len(idempotency_key) > 160
            or not isinstance(client_id, str)
            or not re.fullmatch(r"^[A-Za-z0-9._-]{1,128}$", client_id)
            or not isinstance(request_id, str)
            or not re.fullmatch(r"^req_[a-z0-9]{8,64}$", request_id)
            or not isinstance(policy_snapshot_id, str)
            or req.confirmation.policy_snapshot_id != policy_snapshot_id
        ):
            raise HTTPException(status_code=400, detail={"code": "INVALID_SUBMIT_REQUEST"})
        if req.workspace_id not in self.workspace_registry:
            raise HTTPException(status_code=400, detail={"code": "INVALID_WORKSPACE_OR_PATH"})
        if any(item.model_id is not None for item in req.items):
            # Model selection is intentionally unavailable until the worker can
            # bind an allowlisted model snapshot to the durable request.
            raise HTTPException(status_code=400, detail={"code": "UNSUPPORTED_TOOL_OR_MODEL"})
        if req.confirmation.mode == "confirmed" and not req.confirmation.confirmation_id:
            raise HTTPException(status_code=409, detail={"code": "CONFIRMATION_REQUIRED"})
        try:
            # Resolve every input before creating a job. This keeps validation
            # failures side-effect free and prevents jobs with missing masks.
            for item in req.items:
                self._resolve_mcp_workspace_file(req.workspace_id, item.input_path)
                self._resolve_mcp_workspace_file(req.workspace_id, item.mask_path)
            request_fingerprint_payload = {
                "workspace_id": req.workspace_id,
                "items": [
                    {
                        "id": item.id,
                        "input_path": item.input_path,
                        "mask_path": item.mask_path,
                        **({"model_id": item.model_id} if item.model_id is not None else {}),
                    }
                    for item in req.items
                ],
                "client_id": client_id,
                "policy_snapshot_id": policy_snapshot_id,
                "options": {"operation": "image_batch_inpaint"},
            }
            initial_request = dict(request_fingerprint_payload)
            request_summary = self._mcp_request_summary(req)
            request_summary.update({
                "request_id": request_id,
                "client_id": client_id,
                "policy_snapshot_id": policy_snapshot_id,
                "workspace_id": req.workspace_id,
            })
            # Build once after the job id is known; path checks are repeated by
            # the worker before opening files to cover workspace changes.
            self._mcp_policy_snapshot_id = policy_snapshot_id
            record, _ = self.application_facade.enqueue_batch_inpaint(
                initial_request,
                lambda context: self._process_batch_inpaint(
                    self._build_mcp_batch_request(req, context.job_id),
                    context,
                ),
                client_scope=client_id,
                idempotency_key=idempotency_key,
                policy_snapshot_id=policy_snapshot_id,
                request_summary=request_summary,
                policy_validator=lambda: self._mcp_policy_snapshot_id == policy_snapshot_id,
            )
        except IdempotencyConflictError as exc:
            raise HTTPException(status_code=409, detail={"code": "IDEMPOTENCY_CONFLICT"}) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"code": "INVALID_WORKSPACE_OR_PATH"}) from exc
        except Exception as exc:
            raise HTTPException(status_code=503, detail={"code": "QUEUE_UNAVAILABLE"}) from exc
        return JSONResponse(
            status_code=202,
            content={
                "schema_version": "batch-submit-response/v1",
                "job_id": record.job_id,
                "request_id": request_id,
                "status": "queued",
            },
            headers={"X-Moonshine-Job-Id": record.job_id},
        )

    def api_batch_inpaint(
        self,
        req: BatchInpaintRequest,
        idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
        client_id: Optional[str] = Header(None, alias="X-Moonshine-Client"),
    ):
        """Keep the v1 response shape while routing execution through the facade."""
        try:
            record, payload, _ = self.application_facade.submit_batch_inpaint(
                req,
                lambda context: self._process_batch_inpaint(req, context),
                client_scope=_normalize_client_scope(client_id),
                idempotency_key=idempotency_key if isinstance(idempotency_key, str) else None,
            )
        except IdempotencyConflictError as exc:
            raise HTTPException(status_code=409, detail="Idempotency key conflicts with an existing job") from exc
        except JobInProgressError as exc:
            raise HTTPException(status_code=409, detail="A job with this idempotency key is already running") from exc
        except JobCancellationRequested as exc:
            raise HTTPException(
                status_code=409,
                detail=safe_error(
                    "job_cancelled",
                    stage="cancel",
                    retryable=False,
                    message_key="job.cancelled",
                ),
            ) from exc
        except JobProcessingError as exc:
            raise HTTPException(status_code=500, detail=exc.safe_error) from exc
        except JobResultUnavailableError as exc:
            raise HTTPException(
                status_code=409,
                detail=safe_error(
                    "resource_exhausted",
                    stage="queue",
                    retryable=True,
                    message_key="job.result_unavailable_after_restart",
                ),
            ) from exc
        return JSONResponse(
            content=jsonable_encoder(payload),
            headers={"X-Moonshine-Job-Id": record.job_id},
        )

    def _process_batch_inpaint(self, req: BatchInpaintRequest, execution_context):
        """Process a batch of image and mask pairs in one facade-owned job."""
        if len(req.data) == 0:
            raise HTTPException(
                status_code=400,
                detail="Empty data list",
            )

        self._release_sam_runtime_before_processing("batch_inpaint")
        results = []

        # Create one InpaintRequest and reuse the shared batch params.
        inpaint_req = req.inpaint.model_copy(deep=True)

        start_time = time.time()

        for i, item in enumerate(
            tqdm(req.data, total=len(req.data), desc="Batch processing", mininterval=1)
        ):
            item_id = item.id or f"item_{i}"
            try:
                execution_context.raise_if_cancelled()
                image, alpha_channel, infos, source_format = self._decode_item_image(
                    item.image, req.image_type
                )
                mask = self._decode_item_mask(item.mask, req.mask_type)

                if image.shape[:2] != mask.shape[:2]:
                    logger.warning(
                        f"Item {item_id} image size({image.shape[:2]}) and mask size({mask.shape[:2]}) not match. Resizing mask."
                    )
                    mask = cv2.resize(
                        mask,
                        (image.shape[1], image.shape[0]),
                        interpolation=cv2.INTER_NEAREST,
                    )

                if req.image_type == "base64":
                    inpaint_req.image = self._normalize_base64_payload(item.image)
                else:
                    with open(item.image, "rb") as image_file:
                        inpaint_req.image = base64.b64encode(image_file.read()).decode(
                            "utf-8"
                        )

                if req.mask_type == "base64":
                    inpaint_req.mask = self._normalize_base64_payload(item.mask)
                else:
                    with open(item.mask, "rb") as mask_file:
                        inpaint_req.mask = base64.b64encode(mask_file.read()).decode(
                            "utf-8"
                        )

                rgb_np_img, color_decision = try_flat_background_fill(
                    image, mask, inpaint_req.color_stabilization
                )
                if rgb_np_img is None:
                    rgb_np_img = self.model_manager(image, mask, inpaint_req)
                    rgb_np_img, color_decision = apply_inpaint_color_stabilization(
                        image, mask, rgb_np_img, inpaint_req.color_stabilization
                    )

                rgb_np_img = cv2.cvtColor(rgb_np_img.astype(np.uint8), cv2.COLOR_BGR2RGB)
                rgb_res = concat_alpha_channel(rgb_np_img, alpha_channel)

                output_spec = self._resolve_result_spec(
                    req.output_format,
                    req.output_quality,
                    source_format,
                    alpha_channel,
                )
                res_img_bytes = self._encode_result_array(
                    rgb_res,
                    output_spec,
                    infos,
                )

                if req.response_type == "path":
                    result_data = self._save_result_image(
                        res_img_bytes,
                        item_id,
                        req.temp_path,
                        output_spec["extension"],
                        execution_context=execution_context,
                    )
                else:
                    result_data = self._build_result_payload(res_img_bytes, output_spec)

                results.append(
                    {
                        "id": item_id,
                        "index": i,
                        "result": result_data,
                        "success": True,
                        **self._build_result_meta(output_spec),
                    }
                )

            except Exception as e:
                if isinstance(e, JobCancellationRequested):
                    raise
                if isinstance(e, DiskSpaceError):
                    raise
                logger.error(f"Error processing item {item_id}: {str(e)}")
                results.append(
                    {
                        "id": item_id,
                        "index": i,
                        "error": safe_error(
                            "internal_error",
                            stage="model",
                            retryable=False,
                            message_key="image.item_processing_failed",
                            safe_details={"item_index": i},
                        ),
                        "success": False,
                    }
                )
            finally:
                torch_gc()

        total_time = time.time() - start_time
        logger.info(
            f"Batch processing completed in {total_time:.2f}s for {len(req.data)} images"
        )

        return {
            "results": results,
            "total_time": total_time,
            "processed_count": len(results),
            "success_count": sum(1 for result in results if result.get("success", False)),
        }

    def api_batch_inpaint_by_folder(self, req: BatchInpaintByFolderRequest):
        """Process images from an image folder and masks from a mask folder.
        This wraps the existing batch_processing.batch_inpaint workflow."""
        try:
            self._release_sam_runtime_before_processing("batch_inpaint_by_folder")
            from moonshine_server.batch_processing import batch_inpaint
            
            # Resolve request paths.
            image_path = Path(req.image_folder)
            mask_path = Path(req.mask_folder)
            output_path = Path(req.output_folder)

            # Build torch device from the requested backend device string.
            device = torch.device(req.device)
            
            # Run the existing folder-based batch inpaint pipeline.
            start_time = time.time()
            
            folder_model = self.model_manager.name if self.model_manager.name in {"lama", "mat"} else "lama"
            folder_results = batch_inpaint(
                model=folder_model,
                device=device,
                image=image_path,
                mask=mask_path,
                output=output_path,
                output_format=req.output_format,
                output_quality=req.output_quality,
                color_stabilization=req.color_stabilization,
                return_results=True,
            )
            success_count = sum(
                1 for result in folder_results if result.get("success", False)
            )
            
            total_time = time.time() - start_time
            
            return JSONResponse(content=jsonable_encoder({
                "success": True,
                "message": "Batch processing completed",
                "total_time": total_time,
                "processed_count": success_count,
                "success_count": success_count,
                "image_folder": str(image_path),
                "mask_folder": str(mask_path),
                "output_folder": str(output_path),
                "results": folder_results,
            }))
            
        except Exception as e:
            logger.error(f"Batch processing failed: {str(e)}")
            return JSONResponse(
                status_code=507 if isinstance(e, DiskSpaceError) else 500,
                content=jsonable_encoder({
                    "success": False,
                    "error": str(e)
                })
            )

    def api_moonshine_image_inspect_folder_masks(
        self, req: MoonshineImageFolderInspectRequest
    ):
        """Inspect effective SLBR folder mask behavior without loading the model."""
        try:
            plans = list(
                iter_folder_local_plans(
                    req.image_folder,
                    req.output_folder,
                    mask_folder=req.mask_folder,
                    template_mask_path=req.template_mask_path,
                    missing_mask_behavior=req.missing_mask_behavior,
                    include_mask=False,
                )
            )
            mask_count = sum(1 for plan in plans if plan["apply_scope"] == "mask")
            full_count = sum(1 for plan in plans if plan["apply_scope"] == "full")
            skipped_count = sum(1 for plan in plans if plan["apply_scope"] == "skip")
            error_count = sum(1 for plan in plans if plan["apply_scope"] == "error")
            missing_count = sum(
                1 for plan in plans if plan.get("mask_status") == "missing"
            )
            empty_count = sum(
                1 for plan in plans if plan.get("mask_status") == "empty"
            )
            status = (
                "failed"
                if plans and error_count == len(plans)
                else "partial"
                if error_count
                else "completed"
            )
            public_plans = [
                {
                    key: value
                    for key, value in plan.items()
                    if key not in {"output_collision", "output_stem"}
                }
                for plan in plans
            ]
            return JSONResponse(
                content=jsonable_encoder(
                    {
                        "success": status != "failed",
                        "status": status,
                        "total_count": len(plans),
                        "mask_count": mask_count,
                        "full_count": full_count,
                        "skipped_count": skipped_count,
                        "missing_count": missing_count,
                        "empty_count": empty_count,
                        "error_count": error_count,
                        "results": public_plans,
                    }
                )
            )
        except Exception as e:
            logger.exception(f"Moonshine folder mask inspection failed: {str(e)}")
            return JSONResponse(
                status_code=400,
                content=jsonable_encoder(
                    {
                        "success": False,
                        "status": "failed",
                        "error": str(e),
                        "total_count": 0,
                        "mask_count": 0,
                        "full_count": 0,
                        "skipped_count": 0,
                        "missing_count": 0,
                        "empty_count": 0,
                        "error_count": 0,
                        "results": [],
                    }
                ),
            )

    def api_moonshine_image_process_folder(self, req: MoonshineImageFolderProcessRequest):
        """Process a folder through a Moonshine image model."""
        start_time = time.time()
        try:
            self._release_sam_runtime_before_processing("moonshine_image_process_folder")
            runner = self._get_moonshine_runner(req.model_id)
            options = self._normalize_moonshine_options(req.options)
            image_path = Path(req.image_folder)
            output_path = Path(req.output_folder)

            if not image_path.exists():
                raise FileNotFoundError(f"Image folder not found: {image_path}")
            output_path.mkdir(parents=True, exist_ok=True)

            results = runner.process_folder(
                image_path,
                output_path,
                tile_size=options["tile_size"],
                tile_batch=options["tile_batch"],
                output_format=req.output_format,
                output_quality=req.output_quality,
                apply_scope=req.apply_scope,
                mask_folder=req.mask_folder,
                template_mask_path=req.template_mask_path,
                missing_mask_behavior=req.missing_mask_behavior,
                local_inference_strategy=options["local_inference_strategy"],
                local_bbox_empty_ratio_threshold=options[
                    "local_bbox_empty_ratio_threshold"
                ],
                local_edge_feather_px=options["local_edge_feather_px"],
            )
            total_time = time.time() - start_time
            summary = summarize_processing_results(results)
            status_messages = {
                "completed": "Folder processing completed",
                "partial": "Folder processing partially completed",
                "skipped": "Folder processing skipped",
                "failed": "Folder processing failed",
            }

            return JSONResponse(
                content=jsonable_encoder(
                    {
                        "message": status_messages[summary["status"]],
                        "total_time": total_time,
                        "processed_count": len(results),
                        "image_folder": str(image_path),
                        "output_folder": str(output_path),
                        "results": results,
                        **summary,
                    }
                )
            )
        except Exception as e:
            logger.exception(f"Moonshine folder processing failed: {str(e)}")
            return JSONResponse(
                status_code=507 if isinstance(e, DiskSpaceError) else 500,
                content=jsonable_encoder(
                    {
                        "success": False,
                        "status": "failed",
                        "error": str(e),
                        "total_count": 0,
                        "success_count": 0,
                        "failed_count": 0,
                        "skipped_count": 0,
                    }
                ),
            )

    @staticmethod
    def _load_image_from_path(image_path: str):
        image_file = to_path(image_path)
        if not image_file.is_file():
            raise FileNotFoundError(f"Image file not found: {image_path}")

        image = read_image_file(image_file, cv2.IMREAD_UNCHANGED)
        if image is None:
            raise ValueError(f"Failed to decode image: {image_path}")

        alpha_channel = None
        if image.ndim == 3 and image.shape[2] == 4:
            rgba_image = cv2.cvtColor(image, cv2.COLOR_BGRA2RGBA)
            alpha_channel = rgba_image[:, :, 3]
            image = rgba_image[:, :, :3]
        elif image.ndim == 3:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        elif image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)

        return image, alpha_channel

    @staticmethod
    def _load_mask_from_path(mask_path: str, keep_grayscale: bool):
        mask_file = to_path(mask_path)
        if not mask_file.is_file():
            raise FileNotFoundError(f"Mask file not found: {mask_path}")

        mask_image = read_image_file(mask_file, cv2.IMREAD_UNCHANGED)
        if mask_image is None:
            raise ValueError(f"Failed to decode mask: {mask_path}")

        if mask_image.ndim == 3 and mask_image.shape[2] == 4:
            mask = mask_image[:, :, 3]
        elif mask_image.ndim == 3:
            mask = cv2.cvtColor(mask_image, cv2.COLOR_BGR2GRAY)
        else:
            mask = mask_image

        if not keep_grayscale:
            mask = np.where(mask > 127, 255, 0).astype(np.uint8)

        return mask

    def _save_processed_frame(self, output_path: str, bgr_result: np.ndarray, alpha_channel):
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        rgb_result = cv2.cvtColor(bgr_result.astype(np.uint8), cv2.COLOR_BGR2RGB)

        file_ext = os.path.splitext(output_path)[1].lower().lstrip(".") or "png"
        supports_alpha = file_ext in {"png", "webp", "tiff", "tif"}

        if alpha_channel is not None and alpha_channel.shape[:2] != rgb_result.shape[:2]:
            alpha_channel = cv2.resize(
                alpha_channel,
                (rgb_result.shape[1], rgb_result.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )

        serializable_result = (
            concat_alpha_channel(rgb_result, alpha_channel)
            if alpha_channel is not None and supports_alpha
            else rgb_result
        )

        result_bytes = pil_to_bytes(
            Image.fromarray(serializable_result),
            ext=file_ext,
            quality=self.config.quality,
            infos={},
        )

        ensure_disk_space(
            output_path,
            len(result_bytes),
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="保存视频处理结果帧",
        )
        with open(output_path, "wb") as output_file:
            output_file.write(result_bytes)

    @staticmethod
    def _prune_failure_snapshots(failure_root: str, retention: int):
        if not os.path.isdir(failure_root):
            return

        snapshots = []
        for name in os.listdir(failure_root):
            full_path = os.path.join(failure_root, name)
            if os.path.isdir(full_path):
                snapshots.append(full_path)

        snapshots.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        for stale_path in snapshots[retention:]:
            shutil.rmtree(stale_path, ignore_errors=True)

    def _dump_failed_batch_snapshot(
        self,
        req: VideoBatchInpaintRequest,
        failed_items: List[Dict],
        batch_start_time: float,
    ):
        failure_root = req.options.failure_root
        if not failure_root:
            return None

        os.makedirs(failure_root, exist_ok=True)
        batch_name = req.options.batch_id or f"batch_{int(batch_start_time)}"
        snapshot_dir = os.path.join(
            failure_root,
            f"{batch_name}_{int(batch_start_time * 1000)}",
        )
        os.makedirs(snapshot_dir, exist_ok=True)

        frames_dir = os.path.join(snapshot_dir, "frames")
        masks_dir = os.path.join(snapshot_dir, "masks")
        os.makedirs(frames_dir, exist_ok=True)
        os.makedirs(masks_dir, exist_ok=True)

        estimated_snapshot_bytes = 0
        for frame_item in req.frames:
            estimated_snapshot_bytes += file_size_or_zero(frame_item.image_path)
            if frame_item.mask_path:
                estimated_snapshot_bytes += file_size_or_zero(frame_item.mask_path)
        estimated_snapshot_bytes += len(json.dumps(req.model_dump(mode="json"), ensure_ascii=False).encode("utf-8"))
        estimated_snapshot_bytes += len(json.dumps(failed_items, ensure_ascii=False).encode("utf-8"))
        ensure_disk_space(
            snapshot_dir,
            estimated_snapshot_bytes,
            safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
            operation="保存视频失败诊断快照",
        )

        for frame_item in req.frames:
            if os.path.exists(frame_item.image_path):
                shutil.copy2(
                    frame_item.image_path,
                    os.path.join(frames_dir, os.path.basename(frame_item.image_path)),
                )
            if frame_item.mask_path and os.path.exists(frame_item.mask_path):
                shutil.copy2(
                    frame_item.mask_path,
                    os.path.join(masks_dir, os.path.basename(frame_item.mask_path)),
                )

        request_path = os.path.join(snapshot_dir, "request_snapshot.json")
        with open(request_path, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(req.model_dump(mode="json"), ensure_ascii=False, indent=2))

        errors_path = os.path.join(snapshot_dir, "errors.json")
        with open(errors_path, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(failed_items, ensure_ascii=False, indent=2))

        self._prune_failure_snapshots(
            failure_root, req.options.failure_retention
        )
        return snapshot_dir

    def api_video_batch_inpaint(self, req: VideoBatchInpaintRequest):
        """
        Process one video frame batch using frame/mask file paths.
        """
        start_time = time.time()
        results = []
        failed_items = []
        total_frames = len(req.frames)
        batch_id = getattr(req.options, "batch_id", "") or f"video_batch_{int(start_time)}"
        model_id = str(req.model_id or "lama").strip().lower() or "lama"
        self._release_sam_runtime_before_processing("video_batch_inpaint")
        batch_number = max(1, int(getattr(req.options, "batch_number", 1) or 1))
        total_batches = max(
            batch_number,
            int(getattr(req.options, "total_batches", batch_number) or batch_number),
        )
        gc_interval = 8
        slbr_runner = None
        slbr_options = None
        mask_cache = {}
        temporal_enhancer = None
        temporal_checkpoint = None
        if model_id == "slbr":
            slbr_runner = self._get_slbr_runner()
            slbr_options = self._normalize_moonshine_options(req.options.model_options)
        elif model_id in {"lama", "mat"} and self.model_manager.name != model_id:
            try:
                self.model_manager.switch(model_id)
            except RuntimeError as error:
                raise HTTPException(status_code=422, detail=str(error))
        if model_id in {"lama", "mat"} and is_temporal_enhancement_enabled(
            req.options.temporal_enhancement
        ):
            temporal_options = req.options.temporal_enhancement.model_copy(deep=True)
            if temporal_options.resume_before_frame_index is None and req.frames:
                temporal_options.resume_before_frame_index = min(
                    int(item.frame_index) for item in req.frames
                )
            temporal_enhancer = VideoTemporalEnhancer(
                temporal_options,
                batch_id=batch_id,
            )

        logger.info(
            f"[{batch_id}] start video batch: {total_frames} frame(s), "
            f"model={model_id}, batch={batch_number}/{total_batches}"
        )
        logger.info(
            f"本次视频处理总共{total_batches}批次，当前第{batch_number}批，当前批次进度如下："
        )

        for index, item in enumerate(
            tqdm(req.frames, total=total_frames, mininterval=1, leave=False),
            start=1,
        ):
            image = None
            mask = None
            alpha_channel = None
            mask_nonzero_pixels = None
            should_gc = index % gc_interval == 0
            try:
                image, alpha_channel = self._load_image_from_path(item.image_path)

                if model_id == "slbr":
                    image_bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
                    apply_scope = str(getattr(item, "apply_scope", "full") or "full")
                    local_diagnostics = None
                    if apply_scope == "mask":
                        mask_cache_key = (os.path.abspath(item.mask_path), False)
                        cached_mask = mask_cache.get(mask_cache_key)
                        if cached_mask is None:
                            cached_mask = self._load_mask_from_path(item.mask_path, False)
                            mask_cache[mask_cache_key] = cached_mask
                        mask = cached_mask.copy()
                        if image.shape[:2] != mask.shape[:2]:
                            mask = cv2.resize(
                                mask,
                                (image.shape[1], image.shape[0]),
                                interpolation=cv2.INTER_NEAREST,
                            )
                        mask_nonzero_pixels = int(np.count_nonzero(mask))
                        if mask_nonzero_pixels <= 0:
                            self._save_processed_frame(item.output_path, image_bgr, alpha_channel)
                            results.append(
                                {
                                    "frame_index": item.frame_index,
                                    "output_path": item.output_path,
                                    "success": True,
                                    "skipped": True,
                                    "skip_reason": "empty-mask",
                                    "apply_scope": apply_scope,
                                }
                            )
                            continue
                        processed_bgr, local_diagnostics = slbr_runner.infer_bgr_local(
                            image_bgr,
                            mask,
                            tile_size=slbr_options["tile_size"],
                            tile_batch=slbr_options["tile_batch"],
                            strategy=slbr_options["local_inference_strategy"],
                            bbox_empty_ratio_threshold=slbr_options[
                                "local_bbox_empty_ratio_threshold"
                            ],
                            edge_feather_px=slbr_options["local_edge_feather_px"],
                        )
                    else:
                        processed_bgr, _ = slbr_runner.infer_bgr(
                            image_bgr,
                            tile_size=slbr_options["tile_size"],
                            tile_batch=slbr_options["tile_batch"],
                        )
                    self._save_processed_frame(
                        item.output_path, processed_bgr.astype(np.uint8), alpha_channel
                    )
                    result_item = {
                        "frame_index": item.frame_index,
                        "output_path": item.output_path,
                        "success": True,
                        "apply_scope": apply_scope,
                    }
                    if local_diagnostics is not None:
                        result_item["local_diagnostics"] = local_diagnostics
                    results.append(result_item)
                else:
                    mask_cache_key = (
                        os.path.abspath(item.mask_path),
                        bool(req.options.keep_mask_grayscale),
                    )
                    cached_mask = mask_cache.get(mask_cache_key)
                    if cached_mask is None:
                        cached_mask = self._load_mask_from_path(
                            item.mask_path, req.options.keep_mask_grayscale
                        )
                        mask_cache[mask_cache_key] = cached_mask
                    mask = cached_mask.copy()

                    if image.shape[:2] != mask.shape[:2]:
                        mask = cv2.resize(
                            mask,
                            (image.shape[1], image.shape[0]),
                            interpolation=cv2.INTER_NEAREST,
                        )

                    inpaint_req = req.options.inpaint.model_copy(deep=True)
                    inpaint_req.image = ""
                    inpaint_req.mask = ""
                    mask_nonzero_pixels = int(np.count_nonzero(mask))

                    if mask_nonzero_pixels <= 0:
                        self._save_processed_frame(
                            item.output_path,
                            cv2.cvtColor(image, cv2.COLOR_RGB2BGR),
                            alpha_channel,
                        )

                        results.append(
                            {
                                "frame_index": item.frame_index,
                                "output_path": item.output_path,
                                "success": True,
                                "skipped": True,
                                "skip_reason": "empty-mask",
                            }
                        )
                        continue

                    processed_bgr, color_decision = try_flat_background_fill(
                        image, mask, inpaint_req.color_stabilization
                    )
                    if processed_bgr is None:
                        processed_bgr = self.model_manager(image, mask, inpaint_req).astype(
                            np.uint8
                        )
                        processed_bgr, color_decision = apply_inpaint_color_stabilization(
                            image,
                            mask,
                            processed_bgr,
                            inpaint_req.color_stabilization,
                        )
                    temporal_decision = None
                    if temporal_enhancer is not None:
                        try:
                            processed_bgr, temporal_decision = (
                                temporal_enhancer.enhance_frame(
                                    frame_index=item.frame_index,
                                    image_rgb=image,
                                    mask=mask,
                                    independent_bgr=processed_bgr,
                                    output_path=item.output_path,
                                    temporal_objects=getattr(item, "temporal_objects", None),
                                )
                            )
                        except Exception as enhancement_error:
                            logger.exception(
                                f"[{batch_id}] temporal enhancement fallback for "
                                f"frame {item.frame_index}: {str(enhancement_error)}"
                            )
                            temporal_decision = {
                                "enabled": True,
                                "applied": False,
                                "fallback": True,
                                "skip_reason": "enhancement-error",
                                "error": str(enhancement_error),
                            }
                    self._save_processed_frame(
                        item.output_path, processed_bgr.astype(np.uint8), alpha_channel
                    )

                    result_item = {
                        "frame_index": item.frame_index,
                        "output_path": item.output_path,
                        "success": True,
                    }
                    if temporal_decision is not None:
                        result_item["temporal_enhancement"] = temporal_decision
                    if color_decision and color_decision.get("applied"):
                        result_item["color_stabilization"] = color_decision
                    results.append(result_item)

            except Exception as error:
                should_gc = True
                if isinstance(error, DiskSpaceError):
                    raise
                failed = {
                    "frame_index": item.frame_index,
                    "image_path": item.image_path,
                    "mask_path": item.mask_path,
                    "output_path": item.output_path,
                    "success": False,
                    "error": str(error),
                }
                failed_items.append(failed)
                results.append(failed)

                logger.exception(
                    f"[{batch_id}] frame {item.frame_index} failed: {str(error)} | "
                    f"image_shape={getattr(image, 'shape', None)} | "
                    f"mask_shape={getattr(mask, 'shape', None)} | "
                    f"mask_nonzero_pixels={mask_nonzero_pixels} | "
                    f"mask_min={None if mask is None else int(mask.min())} | "
                    f"mask_max={None if mask is None else int(mask.max())}"
                )
                if req.options.stop_on_error:
                    break
            finally:
                if should_gc:
                    torch_gc()

        torch_gc()

        if temporal_enhancer is not None and len(failed_items) == 0:
            try:
                temporal_checkpoint = temporal_enhancer.finalize_batch()
            except Exception as temporal_finalize_error:
                logger.exception(
                    f"[{batch_id}] temporal enhancement finalize skipped: "
                    f"{str(temporal_finalize_error)}"
                )

        failure_snapshot_dir = None
        if len(failed_items) > 0:
            failure_snapshot_dir = self._dump_failed_batch_snapshot(
                req=req,
                failed_items=failed_items,
                batch_start_time=start_time,
            )

        batch_time = time.time() - start_time
        logger.info(
            f"[{batch_id}] finished video batch: model={model_id}, "
            f"batch={batch_number}/{total_batches}, total_frames={total_frames}, "
            f"success={sum(1 for it in results if it.get('success', False))}, "
            f"failed={len(failed_items)}, elapsed={batch_time:.2f}s"
        )
        return JSONResponse(
            content=jsonable_encoder(
                {
                    "model_id": model_id,
                    "processed_count": len(results),
                    "success_count": sum(
                        1 for it in results if it.get("success", False)
                    ),
                    "failed_count": len(failed_items),
                    "batch_time": batch_time,
                    "failure_snapshot_dir": failure_snapshot_dir,
                    "temporal_checkpoint": temporal_checkpoint,
                    "results": results,
                }
            )
        )
