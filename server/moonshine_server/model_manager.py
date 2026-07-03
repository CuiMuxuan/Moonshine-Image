from typing import Dict, List

import numpy as np
import torch
from loguru import logger

from moonshine_server.download import scan_models
from moonshine_server.helper import switch_mps_device
from moonshine_server.model import models
from moonshine_server.model.utils import torch_gc
from moonshine_server.schema import InpaintRequest, ModelInfo, ModelType


MAT_CUDA_FALLBACK_MESSAGE = "MAT 需要 CUDA，当前已自动切换为 LaMa。"


def _mat_cuda_unavailable(name: str, device) -> bool:
    return (
        str(name or "").strip().lower() == "mat"
        and ("cuda" not in str(device).lower() or not torch.cuda.is_available())
    )


class ModelManager:
    def __init__(self, name: str, device: torch.device, **kwargs):
        self.name = name
        self.device = device
        self.kwargs = kwargs
        self.available_models: Dict[str, ModelInfo] = {}
        self.scan_models()
        self.model = None
        if name in self.available_models:
            if _mat_cuda_unavailable(name, device):
                logger.warning(MAT_CUDA_FALLBACK_MESSAGE)
                if "lama" in self.available_models:
                    self.name = "lama"
                    self.model = self.init_model("lama", device, **kwargs)
                else:
                    logger.warning("Lama model is not installed; the server will start without a loaded model.")
                return
            self.model = self.init_model(name, device, **kwargs)
        else:
            logger.warning(
                f"Default model {name} is not installed. The server will start without a loaded model."
            )

    @property
    def current_model(self) -> ModelInfo:
        if self.name in self.available_models:
            return self.available_models[self.name]
        return ModelInfo(name=self.name, path=self.name, model_type=ModelType.INPAINT)

    def release(self):
        self.model = None
        torch_gc()

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass

    def init_model(self, name: str, device, **kwargs):
        logger.info(f"Loading model: {name}")
        if name not in self.available_models:
            raise NotImplementedError(
                f"Unsupported model: {name}. Available models: {list(self.available_models.keys())}"
            )
        if name in models:
            return models[name](device, model_info=self.available_models[name], **kwargs)
        raise NotImplementedError(f"Unsupported model: {name}")

    @torch.inference_mode()
    def __call__(self, image, mask, config: InpaintRequest):
        try:
            if self.model is None:
                self.scan_models()
                if self.name not in self.available_models:
                    raise RuntimeError(
                        f"Model {self.name} is not installed. Please install the model before processing."
                    )
                if _mat_cuda_unavailable(self.name, self.device):
                    raise RuntimeError(MAT_CUDA_FALLBACK_MESSAGE)
                self.model = self.init_model(
                    self.name,
                    switch_mps_device(self.name, self.device),
                    **self.kwargs,
                )
            return self.model(image, mask, config).astype(np.uint8)
        except Exception:
            torch_gc()
            raise

    def scan_models(self) -> List[ModelInfo]:
        available_models = scan_models()
        self.available_models = {it.name: it for it in available_models}
        return available_models

    def switch(self, new_name: str):
        if new_name == self.name:
            return

        old_name = self.name
        self.scan_models()
        if new_name not in self.available_models:
            raise RuntimeError(
                f"Model {new_name} is not installed. Please install the model before switching."
            )
        if _mat_cuda_unavailable(new_name, self.device):
            raise RuntimeError(MAT_CUDA_FALLBACK_MESSAGE)

        self.name = new_name
        try:
            self.release()
            self.model = self.init_model(
                new_name,
                switch_mps_device(new_name, self.device),
                **self.kwargs,
            )
        except Exception as exc:
            self.name = old_name
            logger.info(f"Switch model from {old_name} to {new_name} failed, rollback")
            self.release()
            self.model = (
                self.init_model(
                    old_name,
                    switch_mps_device(old_name, self.device),
                    **self.kwargs,
                )
                if old_name in self.available_models
                else None
            )
            raise exc
