import os
from pathlib import Path
from typing import List

from loguru import logger

from moonshine_server.const import DEFAULT_MODEL_DIR
from moonshine_server.schema import ModelInfo, ModelType


def cli_download_model(model: str):
    from moonshine_server.model import models

    if model not in models:
        raise NotImplementedError(f"Unsupported erase model: {model}")

    logger.info(f"Downloading {model}...")
    models[model].download()
    logger.info("Done.")


def scan_inpaint_models(model_dir: Path) -> List[ModelInfo]:
    from moonshine_server.model import models

    result = []
    for name, model_cls in models.items():
        if model_cls.is_erase_model and model_cls.is_downloaded():
            result.append(
                ModelInfo(
                    name=name,
                    path=name,
                    model_type=ModelType.INPAINT,
                )
            )
    return result


def scan_models() -> List[ModelInfo]:
    model_dir = Path(os.getenv("XDG_CACHE_HOME", DEFAULT_MODEL_DIR))
    return scan_inpaint_models(model_dir)
