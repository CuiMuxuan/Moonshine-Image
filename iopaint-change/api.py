import asyncio
import os
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
    save_image_to_path,
    decode_path_to_image,
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
    VideoInpaintRequest,
    VideoProcessingConfig
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

    def api_batch_inpaint(self, req: BatchInpaintRequest):
        """
        批量处理多个图像和蒙版
        """
        if len(req.data) == 0:
            raise HTTPException(
                status_code=400,
                detail="Empty data list",
            )
            
        results = []
        
        # 创建一个InpaintRequest对象，复用BatchInpaintRequest的参数
        inpaint_req = InpaintRequest()
        
        start_time = time.time()
        
        for i, item in enumerate(tqdm(req.data, desc="Batch processing")):
            try:
                # 根据image_type解码图像
                if req.image_type == "base64":
                    image, alpha_channel, infos = decode_base64_to_image(item.image)
                else:  # path
                    image, alpha_channel, infos = decode_path_to_image(item.image)
                
                # 根据mask_type处理蒙版
                if req.mask_type == "base64":
                    mask_data = base64.b64decode(item.mask)
                    mask_pil = Image.open(io.BytesIO(mask_data))
                else:  # path
                    if not os.path.exists(item.mask):
                        raise FileNotFoundError(f"Mask file not found: {item.mask}")
                    mask_pil = Image.open(item.mask)
                
                # 处理蒙版，支持透明PNG
                if mask_pil.mode == 'RGBA':
                    # 从RGBA图像中提取Alpha通道作为蒙版
                    _, _, _, alpha = mask_pil.split()
                    mask = np.array(alpha)
                    # 二值化处理：不透明(>0)的区域设为白色(255)，透明(=0)的区域设为黑色(0)
                    mask[mask > 0] = 255
                    mask[mask == 0] = 0
                else:
                    # 如果没有Alpha通道，则按原来的方式处理
                    mask = np.array(mask_pil.convert("L"))
                    mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)[1]
                
                if image.shape[:2] != mask.shape[:2]:
                    logger.warning(f"Item {item.id} image size({image.shape[:2]}) and mask size({mask.shape[:2]}) not match. Resizing mask.")
                    mask = cv2.resize(
                        mask,
                        (image.shape[1], image.shape[0]),
                        interpolation=cv2.INTER_NEAREST,
                    )
                
                # 设置当前图像的请求参数
                if req.image_type == "base64":
                    inpaint_req.image = item.image
                else:
                    # 将路径图像转换为base64用于处理
                    with open(item.image, 'rb') as f:
                        img_bytes = f.read()
                    inpaint_req.image = base64.b64encode(img_bytes).decode('utf-8')
                
                if req.mask_type == "base64":
                    inpaint_req.mask = item.mask
                else:
                    # 将路径蒙版转换为base64用于处理
                    with open(item.mask, 'rb') as f:
                        mask_bytes = f.read()
                    inpaint_req.mask = base64.b64encode(mask_bytes).decode('utf-8')
                
                # 处理图像
                rgb_np_img = self.model_manager(image, mask, inpaint_req)
                
                # 转换颜色空间
                rgb_np_img = cv2.cvtColor(rgb_np_img.astype(np.uint8), cv2.COLOR_BGR2RGB)
                rgb_res = concat_alpha_channel(rgb_np_img, alpha_channel)
                
                # 根据response_type处理结果
                if req.response_type == "base64":
                    # 转换为base64
                    ext = "png"
                    res_img_bytes = pil_to_bytes(
                        Image.fromarray(rgb_res),
                        ext=ext,
                        quality=self.config.quality,
                        infos=infos,
                    )
                    result_data = f"data:image/{ext};base64,{base64.b64encode(res_img_bytes).decode('utf-8')}"
                else:  # path
                    # 保存到文件
                    if req.temp_path:
                        output_path = os.path.join(req.temp_path, f"result_{item.id}.png")
                    else:
                        output_path = f"result_{item.id}.png"
                    
                    result_path = save_image_to_path(
                        rgb_res,
                        output_path,
                        quality=self.config.quality,
                        infos=infos,
                        alpha_channel=None  # alpha_channel已经在concat_alpha_channel中处理
                    )
                    result_data = result_path
                
                # 将结果添加到列表中
                results.append({
                    "id": item.id,
                    "index": i,
                    "result": result_data,
                    "success": True
                })
                
                # 清理GPU内存
                torch_gc()
                
            except Exception as e:
                logger.error(f"Error processing item {item.id}: {str(e)}")
                results.append({
                    "id": item.id,
                    "index": i,
                    "error": str(e),
                    "success": False
                })
        
        total_time = time.time() - start_time
        logger.info(f"Batch processing completed in {total_time:.2f}s for {len(req.data)} items")
        
        return JSONResponse(content=jsonable_encoder({
            "results": results,
            "total_time": total_time,
            "processed_count": len(results),
            "success_count": sum(1 for r in results if r.get("success", False))
        }))
    def api_check_cuda(self):
        """
        检查CUDA是否可用及相关信息
        """
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
                
                # 获取显存信息
                if hasattr(torch.cuda, 'get_device_properties'):
                    props = torch.cuda.get_device_properties(current_device)
                    cuda_info["total_memory_mb"] = props.total_memory / (1024 * 1024)
                
                # 获取当前可用显存
                torch.cuda.empty_cache()
                cuda_info["free_memory_mb"] = torch.cuda.memory_reserved(current_device) / (1024 * 1024)
            except Exception as e:
                cuda_info["error"] = str(e)
        
        return JSONResponse(content=jsonable_encoder(cuda_info))
    def api_batch_inpaint_by_folder(self, req: BatchInpaintByFolderRequest):
        """
        批量处理文件夹中的图像和蒙版
        调用batch_processing.py中的batch_inpaint方法
        """
        try:
            from iopaint.batch_processing import batch_inpaint
            
            # 将字符串路径转换为Path对象
            image_path = Path(req.image_folder)
            mask_path = Path(req.mask_folder)
            output_path = Path(req.output_folder)

            # 创建设备对象
            device = torch.device(req.device)
            
            # 调用batch_inpaint函数处理图像
            start_time = time.time()
            
            processed_count = batch_inpaint(
                model="lama",  # 固定使用lama模型
                device=device,
                image=image_path,
                mask=mask_path,
                output=output_path
            )
            
            total_time = time.time() - start_time
            
            return JSONResponse(content=jsonable_encoder({
                "success": True,
                "message": "批量处理完成",
                "total_time": total_time,
                "processed_count": processed_count,
                "image_folder": str(image_path),
                "mask_folder": str(mask_path),
                "output_folder": str(output_path)
            }))
            
        except Exception as e:
            logger.error(f"批量处理失败: {str(e)}")
            return JSONResponse(
                status_code=500,
                content=jsonable_encoder({
                    "success": False,
                    "error": str(e)
                })
            )
    
    def api_video_inpaint(self, req: VideoInpaintRequest):
        """视频修复处理"""
        try:
            # 验证输入文件
            if not os.path.exists(req.video_path):
                raise HTTPException(status_code=400, detail=f"Video file not found: {req.video_path}")
            
            # 创建临时目录
            temp_dir = Path(req.temp_path)
            temp_dir.mkdir(parents=True, exist_ok=True)
            
            frames_dir = temp_dir / "frames"
            processed_dir = temp_dir / "processed"
            audio_path = temp_dir / "audio.aac"
            
            frames_dir.mkdir(exist_ok=True)
            processed_dir.mkdir(exist_ok=True)
            
            start_time = time.time()
            
            # 1. 提取音频
            logger.info("Extracting audio...")
            has_audio = extract_audio(req.video_path, str(audio_path))
            
            # 2. 提取视频帧
            logger.info("Extracting frames...")
            frame_paths, original_fps = extract_frames(
                req.video_path, 
                str(frames_dir), 
                req.processing_config.frame_format
            )
            
            fps = req.processing_config.fps or original_fps
            total_frames = len(frame_paths)
            
            logger.info(f"Extracted {total_frames} frames at {original_fps} fps")
            
            # 3. 处理每一帧
            def process_frame(frame_info):
                frame_index, frame_path = frame_info
                
                try:
                    # 加载帧图像
                    frame_image, alpha_channel, infos = decode_path_to_image(frame_path)
                    frame_shape = frame_image.shape[:2]
                    
                    # 获取当前帧的所有蒙版
                    frame_masks = get_frame_masks(frame_index, req.masks, frame_shape)
                    
                    if not frame_masks:
                        # 没有蒙版，直接复制原帧
                        processed_path = processed_dir / f"processed_frame_{frame_index:06d}.png"
                        save_image_to_path(frame_image, str(processed_path), infos=infos, alpha_channel=alpha_channel)
                        return frame_index, True, None
                    
                    # 合并蒙版
                    combined_mask = combine_masks(frame_masks)
                    
                    # 创建InpaintRequest
                    inpaint_req = InpaintRequest(
                        prompt=req.prompt,
                        negative_prompt=req.negative_prompt,
                        sd_steps=req.sd_steps,
                        sd_guidance_scale=req.sd_guidance_scale,
                        sd_strength=req.sd_strength,
                        sd_seed=req.sd_seed
                    )
                    
                    # 执行修复
                    processed_image = self.model_manager(frame_image, combined_mask, inpaint_req)
                    
                    # 转换颜色空间并保存
                    processed_image = cv2.cvtColor(processed_image.astype(np.uint8), cv2.COLOR_BGR2RGB)
                    processed_image = concat_alpha_channel(processed_image, alpha_channel)
                    
                    processed_path = processed_dir / f"processed_frame_{frame_index:06d}.png"
                    save_image_to_path(processed_image, str(processed_path), infos=infos)
                    
                    return frame_index, True, None
                    
                except Exception as e:
                    logger.error(f"Error processing frame {frame_index}: {str(e)}")
                    return frame_index, False, str(e)
            
            # 并行处理帧
            logger.info(f"Processing {total_frames} frames with {req.processing_config.max_workers} workers...")
            
            processed_count = 0
            failed_frames = []
            
            with ThreadPoolExecutor(max_workers=req.processing_config.max_workers) as executor:
                frame_infos = list(enumerate(frame_paths))
                future_to_frame = {executor.submit(process_frame, info): info for info in frame_infos}
                
                for future in tqdm(as_completed(future_to_frame), total=len(frame_infos), desc="Processing frames"):
                    frame_index, success, error = future.result()
                    
                    if success:
                        processed_count += 1
                    else:
                        failed_frames.append({"frame": frame_index, "error": error})
                    
                    # 清理GPU内存
                    torch_gc()
            
            # 4. 重新组装视频
            logger.info("Reassembling video...")
            reassemble_video(
                str(processed_dir),
                str(audio_path) if has_audio else "",
                req.output_path,
                fps,
                req.processing_config
            )
            
            # 5. 清理临时文件
            if req.processing_config.temp_cleanup:
                import shutil
                shutil.rmtree(temp_dir)
            
            total_time = time.time() - start_time
            
            logger.info(f"Video processing completed in {total_time:.2f}s")
            
            return JSONResponse(content=jsonable_encoder({
                "success": True,
                "output_path": req.output_path,
                "total_frames": total_frames,
                "processed_frames": processed_count,
                "failed_frames": failed_frames,
                "processing_time": total_time,
                "fps": fps,
                "has_audio": has_audio
            }))
            
        except Exception as e:
            logger.error(f"Video processing failed: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))