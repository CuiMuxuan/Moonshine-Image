import os
import shutil
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.hub import download_url_to_file

from moonshine_server.helper import (
    norm_img,
    get_cache_path_by_url,
    load_jit_model,
    download_model,
    md5sum,
)
from moonshine_server.schema import InpaintRequest
from .base import InpaintModel

MOONSHINE_MODEL_DIR = Path(
    os.environ.get("XDG_CACHE_HOME") or os.environ.get("TORCH_HOME") or Path.cwd() / "models"
).expanduser()
LAMA_MODEL_FILE = "big-lama.pt"
LAMA_MODEL_URL = os.environ.get(
    "LAMA_MODEL_URL",
    "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/big-lama.pt",
)
LAMA_MODEL_MD5 = os.environ.get("LAMA_MODEL_MD5", "e3aa4aaa15225a33ec84f9f4bc47e500")

ANIME_LAMA_MODEL_URL = os.environ.get(
    "ANIME_LAMA_MODEL_URL",
    "https://github.com/Sanster/models/releases/download/AnimeMangaInpainting/anime-manga-big-lama.pt",
)
ANIME_LAMA_MODEL_MD5 = os.environ.get(
    "ANIME_LAMA_MODEL_MD5", "29f284f36a0a510bcacf39ecf4c4d54f"
)


def _model_dir() -> Path:
    return Path(
        os.environ.get("XDG_CACHE_HOME") or os.environ.get("TORCH_HOME") or MOONSHINE_MODEL_DIR
    ).expanduser()


def _root_model_path(filename: str) -> Path:
    return _model_dir() / filename


def _legacy_cache_path(url: str) -> Path:
    return Path(get_cache_path_by_url(url))


def _resolve_lama_model_path() -> str:
    root_path = _root_model_path(LAMA_MODEL_FILE)
    if root_path.is_file():
        return str(root_path)
    if os.path.exists(LAMA_MODEL_URL):
        return LAMA_MODEL_URL
    legacy_path = _legacy_cache_path(LAMA_MODEL_URL)
    if legacy_path.is_file():
        return str(legacy_path)
    return LAMA_MODEL_URL


class LaMa(InpaintModel):
    name = "lama"
    pad_mod = 8
    is_erase_model = True

    @staticmethod
    def download():
        root_path = _root_model_path(LAMA_MODEL_FILE)
        if root_path.is_file():
            return str(root_path)
        root_path.parent.mkdir(parents=True, exist_ok=True)
        part_path = root_path.with_name(f"{root_path.name}.part")

        if os.path.exists(LAMA_MODEL_URL):
            shutil.copyfile(LAMA_MODEL_URL, part_path)
        else:
            download_url_to_file(LAMA_MODEL_URL, str(part_path), progress=True)

        if LAMA_MODEL_MD5:
            actual_md5 = md5sum(part_path)
            if actual_md5 != LAMA_MODEL_MD5:
                part_path.unlink(missing_ok=True)
                raise RuntimeError(
                    f"Lama model md5 mismatch: {actual_md5}, expected {LAMA_MODEL_MD5}"
                )

        os.replace(part_path, root_path)
        return str(root_path)

    def init_model(self, device, **kwargs):
        self.model = load_jit_model(_resolve_lama_model_path(), device, LAMA_MODEL_MD5).eval()

    @staticmethod
    def is_downloaded() -> bool:
        return (
            _root_model_path(LAMA_MODEL_FILE).is_file()
            or os.path.exists(LAMA_MODEL_URL)
            or _legacy_cache_path(LAMA_MODEL_URL).is_file()
        )

    def forward(self, image, mask, config: InpaintRequest):
        """Input image and output image have same size
        image: [H, W, C] RGB
        mask: [H, W]
        return: BGR IMAGE
        """
        image = norm_img(image)
        mask = norm_img(mask)

        mask = (mask > 0) * 1
        image = torch.from_numpy(image).unsqueeze(0).to(self.device)
        mask = torch.from_numpy(mask).unsqueeze(0).to(self.device)

        inpainted_image = self.model(image, mask)

        cur_res = inpainted_image[0].permute(1, 2, 0).detach().cpu().numpy()
        cur_res = np.clip(cur_res * 255, 0, 255).astype("uint8")
        cur_res = cv2.cvtColor(cur_res, cv2.COLOR_RGB2BGR)
        return cur_res


class AnimeLaMa(LaMa):
    name = "anime-lama"

    @staticmethod
    def download():
        download_model(ANIME_LAMA_MODEL_URL, ANIME_LAMA_MODEL_MD5)

    def init_model(self, device, **kwargs):
        self.model = load_jit_model(
            ANIME_LAMA_MODEL_URL, device, ANIME_LAMA_MODEL_MD5
        ).eval()

    @staticmethod
    def is_downloaded() -> bool:
        return os.path.exists(ANIME_LAMA_MODEL_URL) or os.path.exists(
            get_cache_path_by_url(ANIME_LAMA_MODEL_URL)
        )
