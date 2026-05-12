import json
import os
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Optional, Dict, List
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
from fastapi import APIRouter, FastAPI, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from loguru import logger
from socketio import AsyncServer

from moonshine_server.file_manager import FileManager
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
from moonshine_server.model.utils import torch_gc
from moonshine_server.model_manager import ModelManager
from moonshine_server.plugins import build_plugins, RealESRGANUpscaler, InteractiveSeg
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
    InteractiveSegModel,
    RealESRGANModel,
    BatchInpaintRequest, 
    BatchInpaintByFolderRequest,
    MoonshineImageProcessRequest,
    MoonshineImageFolderProcessRequest,
    VideoBatchInpaintRequest,
)
from moonshine_server.moonshine.slbr_runner import (
    SlbrRunner,
    clamp_tile_batch,
    clamp_tile_size,
    get_overlap_for_tile_size,
    read_image_bgr,
    recommend_slbr_params,
)
from moonshine_server.moonshine.model_registry import (
    build_model_status,
    download_task_manager,
    get_model_manifest,
)

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
            status_code=vars(e).get("status_code", 500), content=jsonable_encoder(err)
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



class Api:
    def __init__(self, app: FastAPI, config: ApiConfig):
        self.app = app
        self.config = config
        self.router = APIRouter()
        self.queue_lock = threading.Lock()
        api_middleware(self.app)

        self.file_manager = self._build_file_manager()
        self.plugins = self._build_plugins()
        self.model_manager = self._build_model_manager()
        self._moonshine_runners = {}

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
        self.add_api_route("/api/v1/check_cuda", self.api_check_cuda_fixed, methods=["GET"])
        self.add_api_route("/api/v1/batch_inpaint_by_folder", self.api_batch_inpaint_by_folder, methods=["POST"])
        self.add_api_route("/api/v1/video_batch_inpaint", self.api_video_batch_inpaint, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models", self.api_moonshine_models, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/models/refresh", self.api_moonshine_models, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/{model_id}/verify", self.api_verify_moonshine_model, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/{model_id}/download", self.api_download_moonshine_model, methods=["POST"])
        self.add_api_route("/api/v1/moonshine/models/tasks/{task_id}", self.api_moonshine_model_task, methods=["GET"])
        self.add_api_route("/api/v1/moonshine/image/process", self.api_moonshine_image_process, methods=["POST"])
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
        with open(output_path, "wb") as fw:
            fw.write(origin_image_bytes)

    def api_current_model(self) -> ModelInfo:
        return self.model_manager.current_model

    def api_switch_model(self, req: SwitchModelRequest) -> ModelInfo:
        if req.name == self.model_manager.name:
            return self.model_manager.current_model
        self.model_manager.switch(req.name)
        return self.model_manager.current_model

    def api_switch_plugin_model(self, req: SwitchPluginModelRequest):
        if req.plugin_name in self.plugins:
            self.plugins[req.plugin_name].switch_model(req.model_name)
            if req.plugin_name == RemoveBG.name:
                self.config.remove_bg_model = req.model_name
            if req.plugin_name == RealESRGANUpscaler.name:
                self.config.realesrgan_model = req.model_name
            if req.plugin_name == InteractiveSeg.name:
                self.config.interactive_seg_model = req.model_name
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
            interactiveSegModel=self.config.interactive_seg_model,
            interactiveSegModels=InteractiveSegModel.values(),
            enableFileManager=self.file_manager is not None,
            enableAutoSaving=self.config.output_dir is not None,
            disableModelSwitch=False,
            isDesktop=False,
            samplers=self.api_samplers(),
        )

    def api_moonshine_models(self):
        """Return the dynamic Moonshine model registry used by the client."""
        self.model_manager.scan_models()
        cuda_info = self._get_cuda_info()
        slbr_recommended = recommend_slbr_params(cuda_info)
        models = build_model_status(self._model_dir(), cuda_info)

        for model in models:
            if model.get("id") == "slbr":
                model["parameters"] = {
                    **(model.get("parameters") or {}),
                    "recommended": slbr_recommended,
                }

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "currentModel": self.model_manager.name,
                    "modelDir": str(self._model_dir()),
                    "cuda": cuda_info,
                    "models": models,
                }
            )
        )

    def api_verify_moonshine_model(self, model_id: str):
        """Refresh and return one model's file/install status."""
        manifest_item = get_model_manifest(model_id)
        if manifest_item is None:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        cuda_info = self._get_cuda_info()
        models = build_model_status(self._model_dir(), cuda_info)
        model = next((item for item in models if item.get("id") == model_id), None)
        if model is None:
            raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "success": True,
                    "model": model,
                }
            )
        )

    def api_download_moonshine_model(self, model_id: str):
        """Create an in-process model download task."""
        try:
            task = download_task_manager.create_download_task(model_id, self._model_dir())
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

    def _model_dir(self) -> Path:
        model_dir = os.getenv("XDG_CACHE_HOME") or os.getenv("TORCH_HOME")
        if not model_dir:
            model_dir = str(Path.cwd() / "models")
        return Path(model_dir).expanduser().resolve()

    def _get_slbr_runner(self) -> SlbrRunner:
        key = (str(self._model_dir()), str(self.config.device))
        runner = self._moonshine_runners.get(key)
        if runner is None:
            runner = SlbrRunner(self._model_dir(), self.config.device)
            self._moonshine_runners[key] = runner
        return runner

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
        }

    def _get_cuda_info(self):
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
                            f"sm_{max_supported_arch}。请升级到支持 CUDA 12.8/13.0 的运行时，"
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
            cuda_info["message"] = "当前运行时未检测到可用 CUDA 设备。"

        cuda_info["recommended"] = {
            "slbr": recommend_slbr_params(cuda_info),
        }
        return cuda_info

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
        rgb_np_img = self.model_manager(image, mask, req)
        logger.info(f"process time: {(time.time() - start) * 1000:.2f}ms")
        torch_gc()

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
            self.config.enable_interactive_seg,
            self.config.interactive_seg_model,
            self.config.interactive_seg_device,
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
        if mask_type == "base64":
            encoded_mask = self._normalize_base64_payload(mask_value)
            mask_data = base64.b64decode(encoded_mask)
            mask_pil = Image.open(io.BytesIO(mask_data))
        else:
            if not os.path.exists(mask_value):
                raise FileNotFoundError(f"Mask file not found: {mask_value}")
            mask_pil = Image.open(mask_value)

        if mask_pil.mode == "RGBA":
            _, _, _, alpha = mask_pil.split()
            mask = np.array(alpha)
            mask[mask > 0] = 255
            mask[mask == 0] = 0
        else:
            mask = np.array(mask_pil.convert("L"))
            mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]
        return mask

    @staticmethod
    def _save_result_image(
        result_bytes: bytes,
        item_id: str,
        temp_path: Optional[str],
        extension: str = ".png",
    ):
        output_extension = extension if str(extension or "").startswith(".") else f".{extension}"
        output_name = f"result_{item_id}{output_extension}"
        if temp_path:
            os.makedirs(temp_path, exist_ok=True)
            output_path = os.path.join(temp_path, output_name)
        else:
            output_path = output_name

        with open(output_path, "wb") as output_file:
            output_file.write(result_bytes)
        return output_path

    def api_moonshine_image_process(self, req: MoonshineImageProcessRequest):
        """Process images through no-mask Moonshine image models."""
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
                clean_bgr, _ = runner.infer_bgr(
                    image_bgr,
                    tile_size=options["tile_size"],
                    tile_batch=options["tile_batch"],
                )
                clean_rgb = cv2.cvtColor(clean_bgr.astype(np.uint8), cv2.COLOR_BGR2RGB)
                serializable_result = concat_alpha_channel(clean_rgb, alpha_channel)
                output_spec = self._resolve_result_spec(
                    req.output_format,
                    req.output_quality,
                    source_format,
                    alpha_channel,
                )
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

                results.append(
                    {
                        "id": item_id,
                        "index": index,
                        "result": result_data,
                        "image": result_data,
                        "success": True,
                        **self._build_result_meta(output_spec),
                    }
                )
                torch_gc()
            except Exception as e:
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
        return JSONResponse(
            content=jsonable_encoder(
                {
                    "results": results,
                    "total_time": total_time,
                    "processed_count": len(results),
                    "success_count": sum(
                        1 for result in results if result.get("success", False)
                    ),
                }
            )
        )

    def api_batch_inpaint(self, req: BatchInpaintRequest):
        """Process a batch of image and mask pairs in one request."""
        if len(req.data) == 0:
            raise HTTPException(
                status_code=400,
                detail="Empty data list",
            )

        results = []

        # Create one InpaintRequest and reuse the shared batch params.
        inpaint_req = InpaintRequest()

        start_time = time.time()

        for i, item in enumerate(
            tqdm(req.data, total=len(req.data), desc="Batch processing", mininterval=1)
        ):
            item_id = item.id or f"item_{i}"
            try:
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

                rgb_np_img = self.model_manager(image, mask, inpaint_req)

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
                    )
                else:
                    result_data = self._build_result_payload(res_img_bytes, output_spec)

                results.append(
                    {
                        "id": item_id,
                        "index": i,
                        "result": result_data,
                        # Backward compatibility for older frontend response parsing.
                        "image": result_data,
                        "success": True,
                        **self._build_result_meta(output_spec),
                    }
                )
                torch_gc()

            except Exception as e:
                logger.error(f"Error processing item {item_id}: {str(e)}")
                results.append(
                    {
                        "id": item_id,
                        "index": i,
                        "error": str(e),
                        "success": False,
                    }
                )

        total_time = time.time() - start_time
        logger.info(
            f"Batch processing completed in {total_time:.2f}s for {len(req.data)} images"
        )

        return JSONResponse(
            content=jsonable_encoder(
                {
                    "results": results,
                    "total_time": total_time,
                    "processed_count": len(results),
                    "success_count": sum(
                        1 for result in results if result.get("success", False)
                    ),
                }
            )
        )

    def api_batch_inpaint_by_folder(self, req: BatchInpaintByFolderRequest):
        """Process images from an image folder and masks from a mask folder.
        This wraps the existing batch_processing.batch_inpaint workflow."""
        try:
            from moonshine_server.batch_processing import batch_inpaint
            
            # Resolve request paths.
            image_path = Path(req.image_folder)
            mask_path = Path(req.mask_folder)
            output_path = Path(req.output_folder)

            # Build torch device from the requested backend device string.
            device = torch.device(req.device)
            
            # Run the existing folder-based batch inpaint pipeline.
            start_time = time.time()
            
            processed_count = batch_inpaint(
                model="lama",  # Keep current default model for folder mode.
                device=device,
                image=image_path,
                mask=mask_path,
                output=output_path,
                output_format=req.output_format,
                output_quality=req.output_quality,
            )
            
            total_time = time.time() - start_time
            
            return JSONResponse(content=jsonable_encoder({
                "success": True,
                "message": "Batch processing completed",
                "total_time": total_time,
                "processed_count": processed_count,
                "image_folder": str(image_path),
                "mask_folder": str(mask_path),
                "output_folder": str(output_path)
            }))
            
        except Exception as e:
            logger.error(f"Batch processing failed: {str(e)}")
            return JSONResponse(
                status_code=500,
                content=jsonable_encoder({
                    "success": False,
                    "error": str(e)
                })
            )

    def api_moonshine_image_process_folder(self, req: MoonshineImageFolderProcessRequest):
        """Process a folder through a no-mask Moonshine image model."""
        start_time = time.time()
        try:
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
            )
            total_time = time.time() - start_time

            return JSONResponse(
                content=jsonable_encoder(
                    {
                        "success": True,
                        "message": "Folder processing completed",
                        "total_time": total_time,
                        "processed_count": len(results),
                        "success_count": sum(
                            1 for result in results if result.get("success", False)
                        ),
                        "image_folder": str(image_path),
                        "output_folder": str(output_path),
                        "results": results,
                    }
                )
            )
        except Exception as e:
            logger.exception(f"Moonshine folder processing failed: {str(e)}")
            return JSONResponse(
                status_code=500,
                content=jsonable_encoder(
                    {
                        "success": False,
                        "error": str(e),
                    }
                ),
            )

    @staticmethod
    def _load_image_from_path(image_path: str):
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image file not found: {image_path}")

        image = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
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
        if not os.path.exists(mask_path):
            raise FileNotFoundError(f"Mask file not found: {mask_path}")

        mask_image = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
        if mask_image is None:
            raise ValueError(f"Failed to decode mask: {mask_path}")

        if mask_image.ndim == 3 and mask_image.shape[2] == 4:
            mask = mask_image[:, :, 3]
        elif mask_image.ndim == 3:
            mask = cv2.cvtColor(mask_image, cv2.COLOR_BGR2GRAY)
        else:
            mask = mask_image

        if not keep_grayscale:
            mask = np.where(mask > 0, 255, 0).astype(np.uint8)

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
        batch_number = max(1, int(getattr(req.options, "batch_number", 1) or 1))
        total_batches = max(
            batch_number,
            int(getattr(req.options, "total_batches", batch_number) or batch_number),
        )
        gc_interval = 8
        slbr_runner = None
        slbr_options = None
        if model_id == "slbr":
            slbr_runner = self._get_slbr_runner()
            slbr_options = self._normalize_moonshine_options(req.options.model_options)

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
            try:
                image, alpha_channel = self._load_image_from_path(item.image_path)

                if model_id == "slbr":
                    image_bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
                    processed_bgr, _ = slbr_runner.infer_bgr(
                        image_bgr,
                        tile_size=slbr_options["tile_size"],
                        tile_batch=slbr_options["tile_batch"],
                    )
                    self._save_processed_frame(
                        item.output_path, processed_bgr.astype(np.uint8), alpha_channel
                    )
                    results.append(
                        {
                            "frame_index": item.frame_index,
                            "output_path": item.output_path,
                            "success": True,
                        }
                    )
                else:
                    mask = self._load_mask_from_path(
                        item.mask_path, req.options.keep_mask_grayscale
                    )

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

                    processed_bgr = self.model_manager(image, mask, inpaint_req)
                    self._save_processed_frame(
                        item.output_path, processed_bgr.astype(np.uint8), alpha_channel
                    )

                    results.append(
                        {
                            "frame_index": item.frame_index,
                            "output_path": item.output_path,
                            "success": True,
                        }
                    )

                if index % gc_interval == 0:
                    torch_gc()
            except Exception as error:
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

        torch_gc()

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
                    "results": results,
                }
            )
        )
