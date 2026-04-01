import asyncio
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
    torch._C._jit_set_nvfuser_enabled(False)
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

from iopaint.file_manager import FileManager
from iopaint.helper import (
    load_img,
    decode_base64_to_image,
    pil_to_bytes,
    numpy_to_bytes,
    concat_alpha_channel,
    gen_frontend_mask,
    adjust_mask,
)
from iopaint.model.utils import torch_gc
from iopaint.model_manager import ModelManager
from iopaint.plugins import build_plugins, RealESRGANUpscaler, InteractiveSeg
from iopaint.plugins.base_plugin import BasePlugin
from iopaint.plugins.remove_bg import RemoveBG
from iopaint.schema import (
    GenInfoResponse,
    ApiConfig,
    ServerConfigResponse,
    SwitchModelRequest,
    InpaintRequest,
    RunPluginRequest,
    SDSampler,
    PluginInfo,
    AdjustMaskRequest,
    RemoveBGModel,
    SwitchPluginModelRequest,
    ModelInfo,
    InteractiveSegModel,
    RealESRGANModel,
    BatchInpaintRequest, 
    BatchInpaintByFolderRequest,
    VideoBatchInpaintRequest,
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


def diffuser_callback(pipe, step: int, timestep: int, callback_kwargs: Dict = {}):
    # self: DiffusionPipeline, step: int, timestep: int, callback_kwargs: Dict
    # logger.info(f"diffusion callback: step={step}, timestep={timestep}")

    # We use asyncio loos for task processing. Perhaps in the future, we can add a processing queue similar to InvokeAI,
    # but for now let's just start a separate event loop. It shouldn't make a difference for single person use
    asyncio.run(global_sio.emit("diffusion_progress", {"step": step}))
    return {}


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
        self.add_api_route("/api/v1/check_cuda", self.api_check_cuda, methods=["GET"])
        self.add_api_route("/api/v1/batch_inpaint_by_folder", self.api_batch_inpaint_by_folder, methods=["POST"])
        self.add_api_route("/api/v1/video_batch_inpaint", self.api_video_batch_inpaint, methods=["POST"])
        
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
            enableControlnet=self.model_manager.enable_controlnet,
            controlnetMethod=self.model_manager.controlnet_method,
            disableModelSwitch=False,
            isDesktop=False,
            samplers=self.api_samplers(),
        )

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

        if req.paint_by_example_example_image:
            paint_by_example_image, _, _, *_ = decode_base64_to_image(
                req.paint_by_example_example_image
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

        asyncio.run(self.sio.emit("diffusion_finish"))

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
        return [member.value for member in SDSampler.__members__.values()]

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
            disable_nsfw=self.config.disable_nsfw_checker,
            sd_cpu_textencoder=self.config.cpu_textencoder,
            local_files_only=self.config.local_files_only,
            cpu_offload=self.config.cpu_offload,
            callback=diffuser_callback,
        )

    @staticmethod
    def _normalize_base64_payload(value: str) -> str:
        if value.startswith("data:image/") or value.startswith(
            "data:application/octet-stream;base64,"
        ):
            return value.split(";")[1].split(",")[1]
        return value

    def _decode_item_image(self, image_value: str, image_type: str):
        if image_type == "base64":
            return decode_base64_to_image(image_value)

        if not os.path.exists(image_value):
            raise FileNotFoundError(f"Image file not found: {image_value}")
        with open(image_value, "rb") as image_file:
            image_b64 = base64.b64encode(image_file.read()).decode("utf-8")
        return decode_base64_to_image(image_b64)

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
    def _save_result_image(result_bytes: bytes, item_id: str, temp_path: Optional[str]):
        output_name = f"result_{item_id}.png"
        if temp_path:
            os.makedirs(temp_path, exist_ok=True)
            output_path = os.path.join(temp_path, output_name)
        else:
            output_path = output_name

        with open(output_path, "wb") as output_file:
            output_file.write(result_bytes)
        return output_path

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
            tqdm(req.data, total=len(req.data), desc="Batch processing")
        ):
            item_id = item.id or f"item_{i}"
            try:
                image, alpha_channel, infos, *_ = self._decode_item_image(
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

                ext = "png"
                res_img_bytes = pil_to_bytes(
                    Image.fromarray(rgb_res),
                    ext=ext,
                    quality=self.config.quality,
                    infos=infos,
                )

                if req.response_type == "path":
                    result_data = self._save_result_image(
                        res_img_bytes, item_id, req.temp_path
                    )
                else:
                    result_data = (
                        f"data:image/{ext};base64,"
                        f"{base64.b64encode(res_img_bytes).decode('utf-8')}"
                    )

                results.append(
                    {
                        "id": item_id,
                        "index": i,
                        "result": result_data,
                        # Backward compatibility for older frontend response parsing.
                        "image": result_data,
                        "success": True,
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

    def api_check_cuda(self):
        """Return basic CUDA availability and device information."""
        cuda_info = {
            "cuda_available": torch.cuda.is_available(),
            "cuda_device_count": torch.cuda.device_count(),
            "current_device": None,
            "device_name": None,
            "device_capability": None,
            "total_memory_mb": None,
            "free_memory_mb": None,
        }
        
        if cuda_info["cuda_available"] and cuda_info["cuda_device_count"] > 0:
            try:
                current_device = torch.cuda.current_device()
                cuda_info["current_device"] = current_device
                cuda_info["device_name"] = torch.cuda.get_device_name(current_device)
                
                if hasattr(torch.cuda, 'get_device_capability'):
                    cuda_info["device_capability"] = torch.cuda.get_device_capability(current_device)
                
                # Query total CUDA memory when device properties are available.
                if hasattr(torch.cuda, 'get_device_properties'):
                    props = torch.cuda.get_device_properties(current_device)
                    cuda_info["total_memory_mb"] = props.total_memory / (1024 * 1024)
                
                # Refresh cache stats after empty_cache for a rough reserved-memory snapshot.
                torch.cuda.empty_cache()
                cuda_info["free_memory_mb"] = torch.cuda.memory_reserved(current_device) / (1024 * 1024)
            except Exception as e:
                cuda_info["error"] = str(e)
        
        return JSONResponse(content=jsonable_encoder(cuda_info))
    def api_batch_inpaint_by_folder(self, req: BatchInpaintByFolderRequest):
        """Process images from an image folder and masks from a mask folder.
        This wraps the existing batch_processing.batch_inpaint workflow."""
        try:
            from iopaint.batch_processing import batch_inpaint
            
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
                output=output_path
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
            if os.path.exists(frame_item.mask_path):
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
        gc_interval = 8

        logger.info(
            f"[{batch_id}] start video batch: {total_frames} frame(s), "
            f"stop_on_error={req.options.stop_on_error}"
        )

        for index, item in enumerate(req.frames, start=1):
            try:
                image, alpha_channel = self._load_image_from_path(item.image_path)
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

                if index == total_frames or index % 5 == 0:
                    logger.info(
                        f"[{batch_id}] processed {index}/{total_frames} frame(s)"
                    )
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

                logger.error(
                    f"[{batch_id}] frame {item.frame_index} failed: {str(error)}"
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
            f"[{batch_id}] finished video batch: success="
            f"{sum(1 for it in results if it.get('success', False))}/{total_frames}, "
            f"failed={len(failed_items)}, elapsed={batch_time:.2f}s"
        )
        return JSONResponse(
            content=jsonable_encoder(
                {
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
