from typing import Dict, List

import numpy as np
import torch
from loguru import logger

from moonshine_server.download import scan_models
from moonshine_server.helper import switch_mps_device
from moonshine_server.model import models
from moonshine_server.model.utils import torch_gc
from moonshine_server.schema import InpaintRequest, ModelInfo, ModelType


class ModelManager:
    def __init__(self, name: str, device: torch.device, **kwargs):
        self.name = name
        self.device = device
        self.kwargs = kwargs
        self.available_models: Dict[str, ModelInfo] = {}
        self.scan_models()
        self.model = None
        if name in self.available_models:
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
        if self.model is None:
            self.scan_models()
            if self.name not in self.available_models:
                raise RuntimeError(
                    f"Model {self.name} is not installed. Please install the model before processing."
                )
            self.model = self.init_model(
                self.name,
                switch_mps_device(self.name, self.device),
                **self.kwargs,
            )
        return self.model(image, mask, config).astype(np.uint8)

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

        self.name = new_name
        try:
            if self.model is not None:
                del self.model
            torch_gc()
            self.model = self.init_model(
                new_name,
                switch_mps_device(new_name, self.device),
                **self.kwargs,
            )
        except Exception as exc:
            self.name = old_name
            logger.info(f"Switch model from {old_name} to {new_name} failed, rollback")
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
