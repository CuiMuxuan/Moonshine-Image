import abc
from typing import Optional

import cv2
import numpy as np
import torch
from loguru import logger

from moonshine_server.helper import (
    boxes_from_mask,
    pad_img_to_modulo,
    resize_max_size,
    switch_mps_device,
)
from moonshine_server.schema import HDStrategy, InpaintRequest


class InpaintModel:
    name = "base"
    min_size: Optional[int] = None
    pad_mod = 8
    pad_to_square = False
    is_erase_model = False

    def __init__(self, device, **kwargs):
        self.device = switch_mps_device(self.name, device)
        self.init_model(self.device, **kwargs)

    @abc.abstractmethod
    def init_model(self, device, **kwargs): ...

    @staticmethod
    @abc.abstractmethod
    def is_downloaded() -> bool:
        return False

    @staticmethod
    def download(): ...

    @abc.abstractmethod
    def forward(self, image, mask, config: InpaintRequest):
        """Run model on RGB image and 0/255 mask, returning BGR image."""
        ...

    def forward_pre_process(self, image, mask, config):
        return image, mask

    def forward_post_process(self, result, image, mask, config):
        return result, image, mask

    def _pad_forward(self, image, mask, config: InpaintRequest):
        origin_height, origin_width = image.shape[:2]
        pad_image = pad_img_to_modulo(
            image, mod=self.pad_mod, square=self.pad_to_square, min_size=self.min_size
        )
        pad_mask = pad_img_to_modulo(
            mask, mod=self.pad_mod, square=self.pad_to_square, min_size=self.min_size
        )

        image, mask = self.forward_pre_process(image, mask, config)
        result = self.forward(pad_image, pad_mask, config)
        result = result[0:origin_height, 0:origin_width, :]
        result, image, mask = self.forward_post_process(result, image, mask, config)

        if config.sd_keep_unmasked_area:
            mask = mask[:, :, np.newaxis]
            result = result * (mask / 255) + image[:, :, ::-1] * (1 - (mask / 255))
        return result

    @torch.no_grad()
    def __call__(self, image, mask, config: InpaintRequest):
        inpaint_result = None
        if config.hd_strategy == HDStrategy.CROP:
            if max(image.shape) > config.hd_strategy_crop_trigger_size:
                crop_result = []
                for box in boxes_from_mask(mask):
                    crop_image, crop_box = self._run_box(image, mask, box, config)
                    crop_result.append((crop_image, crop_box))

                inpaint_result = image[:, :, ::-1]
                for crop_image, crop_box in crop_result:
                    x1, y1, x2, y2 = crop_box
                    inpaint_result[y1:y2, x1:x2, :] = crop_image

        elif config.hd_strategy == HDStrategy.RESIZE:
            if max(image.shape) > config.hd_strategy_resize_limit:
                origin_size = image.shape[:2]
                downsize_image = resize_max_size(
                    image, size_limit=config.hd_strategy_resize_limit
                )
                downsize_mask = resize_max_size(
                    mask, size_limit=config.hd_strategy_resize_limit
                )

                logger.info(
                    f"Run resize strategy, origin size: {image.shape} forward size: {downsize_image.shape}"
                )
                inpaint_result = self._pad_forward(
                    downsize_image, downsize_mask, config
                )

                inpaint_result = cv2.resize(
                    inpaint_result,
                    (origin_size[1], origin_size[0]),
                    interpolation=cv2.INTER_CUBIC,
                )
                original_pixel_indices = mask < 127
                inpaint_result[original_pixel_indices] = image[:, :, ::-1][
                    original_pixel_indices
                ]

        if inpaint_result is None:
            inpaint_result = self._pad_forward(image, mask, config)

        return inpaint_result

    def _crop_box(self, image, mask, box, config: InpaintRequest):
        box_h = box[3] - box[1]
        box_w = box[2] - box[0]
        cx = (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        img_h, img_w = image.shape[:2]

        w = box_w + config.hd_strategy_crop_margin * 2
        h = box_h + config.hd_strategy_crop_margin * 2

        left = cx - w // 2
        right = cx + w // 2
        top = cy - h // 2
        bottom = cy + h // 2

        l = max(left, 0)
        r = min(right, img_w)
        t = max(top, 0)
        b = min(bottom, img_h)

        if left < 0:
            r += abs(left)
        if right > img_w:
            l -= right - img_w
        if top < 0:
            b += abs(top)
        if bottom > img_h:
            t -= bottom - img_h

        l = max(l, 0)
        r = min(r, img_w)
        t = max(t, 0)
        b = min(b, img_h)

        return image[t:b, l:r, :], mask[t:b, l:r], [l, t, r, b]

    def _run_box(self, image, mask, box, config: InpaintRequest):
        crop_img, crop_mask, crop_box = self._crop_box(image, mask, box, config)
        return self._pad_forward(crop_img, crop_mask, config), crop_box
