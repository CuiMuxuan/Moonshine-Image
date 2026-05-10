import random
from enum import Enum
from pathlib import Path
from typing import Any, List, Literal, Optional

from loguru import logger
from pydantic import BaseModel, Field, computed_field, model_validator


class ModelType(str, Enum):
    INPAINT = "inpaint"


class ModelInfo(BaseModel):
    name: str
    path: str
    model_type: ModelType
    is_single_file_model: bool = False

    @computed_field
    @property
    def support_strength(self) -> bool:
        return False

    @computed_field
    @property
    def support_outpainting(self) -> bool:
        return False


class Choices(str, Enum):
    @classmethod
    def values(cls):
        return [member.value for member in cls]


class RealESRGANModel(Choices):
    realesr_general_x4v3 = "realesr-general-x4v3"
    RealESRGAN_x4plus = "RealESRGAN_x4plus"
    RealESRGAN_x4plus_anime_6B = "RealESRGAN_x4plus_anime_6B"


class RemoveBGModel(Choices):
    briaai_rmbg_1_4 = "briaai/RMBG-1.4"
    briaai_rmbg_2_0 = "briaai/RMBG-2.0"
    u2net = "u2net"
    u2netp = "u2netp"
    u2net_human_seg = "u2net_human_seg"
    u2net_cloth_seg = "u2net_cloth_seg"
    silueta = "silueta"
    isnet_general_use = "isnet-general-use"
    birefnet_general = "birefnet-general"
    birefnet_general_lite = "birefnet-general-lite"
    birefnet_portrait = "birefnet-portrait"
    birefnet_dis = "birefnet-dis"
    birefnet_hrsod = "birefnet-hrsod"
    birefnet_cod = "birefnet-cod"
    birefnet_massive = "birefnet-massive"


class Device(Choices):
    cpu = "cpu"
    cuda = "cuda"
    mps = "mps"


class InteractiveSegModel(Choices):
    vit_b = "vit_b"
    vit_l = "vit_l"
    vit_h = "vit_h"
    sam_hq_vit_b = "sam_hq_vit_b"
    sam_hq_vit_l = "sam_hq_vit_l"
    sam_hq_vit_h = "sam_hq_vit_h"
    mobile_sam = "mobile_sam"
    sam2_tiny = "sam2_tiny"
    sam2_small = "sam2_small"
    sam2_base = "sam2_base"
    sam2_large = "sam2_large"
    sam2_1_tiny = "sam2_1_tiny"
    sam2_1_small = "sam2_1_small"
    sam2_1_base = "sam2_1_base"
    sam2_1_large = "sam2_1_large"


class PluginInfo(BaseModel):
    name: str
    support_gen_image: bool = False
    support_gen_mask: bool = False


class CV2Flag(str, Enum):
    INPAINT_NS = "INPAINT_NS"
    INPAINT_TELEA = "INPAINT_TELEA"


class HDStrategy(str, Enum):
    ORIGINAL = "Original"
    RESIZE = "Resize"
    CROP = "Crop"


class LDMSampler(str, Enum):
    ddim = "ddim"
    plms = "plms"


class ApiConfig(BaseModel):
    host: str
    port: int
    inbrowser: bool
    model: str
    no_half: bool
    low_mem: bool
    cpu_offload: bool
    disable_nsfw_checker: bool
    local_files_only: bool
    cpu_textencoder: bool
    device: Device
    input: Optional[Path]
    mask_dir: Optional[Path]
    output_dir: Optional[Path]
    quality: int
    enable_interactive_seg: bool
    interactive_seg_model: InteractiveSegModel
    interactive_seg_device: Device
    enable_remove_bg: bool
    remove_bg_device: Device
    remove_bg_model: str
    enable_anime_seg: bool
    enable_realesrgan: bool
    realesrgan_device: Device
    realesrgan_model: RealESRGANModel
    enable_gfpgan: bool
    gfpgan_device: Device
    enable_restoreformer: bool
    restoreformer_device: Device


class InpaintRequest(BaseModel):
    image: Optional[str] = Field(None, description="base64 encoded image")
    mask: Optional[str] = Field(None, description="base64 encoded mask")

    ldm_steps: int = Field(20, description="Steps for ldm model")
    ldm_sampler: str = Field(LDMSampler.plms, description="Sampler for ldm model")
    zits_wireframe: bool = Field(True, description="Enable wireframe for zits model")

    hd_strategy: str = Field(HDStrategy.CROP, description="HD strategy for erase models")
    hd_strategy_crop_trigger_size: int = Field(800)
    hd_strategy_crop_margin: int = Field(128)
    hd_strategy_resize_limit: int = Field(1280)

    sd_keep_unmasked_area: bool = Field(True)
    sd_seed: int = Field(42, validate_default=True)
    prompt: str = ""
    negative_prompt: str = ""

    cv2_flag: CV2Flag = Field(CV2Flag.INPAINT_NS)
    cv2_radius: int = Field(4)

    @model_validator(mode="after")
    def validate_field(cls, values: "InpaintRequest"):
        if values.sd_seed == -1:
            values.sd_seed = random.randint(1, 99999999)
            logger.info(f"Generate random seed: {values.sd_seed}")
        return values


class RunPluginRequest(BaseModel):
    name: str
    image: str = Field(..., description="base64 encoded image")
    clicks: List[List[int]] = Field(
        [], description="Clicks for interactive segmentation"
    )
    scale: float = Field(2.0, description="Scale for upscaling")


MediaTab = Literal["input", "output", "mask"]


class MediasResponse(BaseModel):
    name: str
    height: int
    width: int
    ctime: float
    mtime: float


class GenInfoResponse(BaseModel):
    prompt: str = ""
    negative_prompt: str = ""


class ServerConfigResponse(BaseModel):
    plugins: List[PluginInfo]
    modelInfos: List[ModelInfo]
    removeBGModel: RemoveBGModel
    removeBGModels: List[RemoveBGModel]
    realesrganModel: RealESRGANModel
    realesrganModels: List[RealESRGANModel]
    interactiveSegModel: InteractiveSegModel
    interactiveSegModels: List[InteractiveSegModel]
    enableFileManager: bool
    enableAutoSaving: bool
    disableModelSwitch: bool
    isDesktop: bool
    samplers: List[str]


class SwitchModelRequest(BaseModel):
    name: str


class SwitchPluginModelRequest(BaseModel):
    plugin_name: str
    model_name: str


AdjustMaskOperate = Literal["expand", "shrink", "reverse"]


class AdjustMaskRequest(BaseModel):
    mask: str = Field(..., description="base64 encoded mask")
    operate: AdjustMaskOperate = Field(..., description="expand/shrink/reverse")
    kernel_size: int = Field(5, description="Kernel size for expanding mask")


class BatchInpaintItem(BaseModel):
    id: str = Field(..., description="Unique identifier for this item")
    image: str = Field(..., description="Image data")
    mask: str = Field(..., description="Mask data")


class BatchInpaintRequest(BaseModel):
    data: List[BatchInpaintItem] = Field(default_factory=list)
    image_type: Literal["base64", "path"] = Field("base64")
    mask_type: Literal["base64", "path"] = Field("base64")
    temp_path: Optional[str] = Field(None)
    response_type: Literal["base64", "path"] = Field("base64")
    images: Optional[List[str]] = Field(default=None, exclude=True)
    masks: Optional[List[str]] = Field(default=None, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_payload(cls, values: Any):
        if not isinstance(values, dict):
            return values
        has_data = isinstance(values.get("data"), list) and len(values["data"]) > 0
        if has_data:
            return values
        images = values.get("images")
        masks = values.get("masks")
        if images is None and masks is None:
            return values
        if not isinstance(images, list) or not isinstance(masks, list):
            raise ValueError("images and masks must both be arrays")
        if len(images) != len(masks):
            raise ValueError("Number of images and masks must be the same")
        values["data"] = [
            {"id": f"legacy_{index}", "image": image, "mask": masks[index]}
            for index, image in enumerate(images)
        ]
        values.setdefault("image_type", "base64")
        values.setdefault("mask_type", "base64")
        values.setdefault("response_type", "base64")
        return values

    @model_validator(mode="after")
    def validate_field(cls, values: "BatchInpaintRequest"):
        if len(values.data) == 0:
            raise ValueError("Data list cannot be empty")
        item_ids = [item.id for item in values.data]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("All item IDs must be unique")
        return values


class BatchInpaintByFolderRequest(BaseModel):
    device: str
    image_folder: str
    mask_folder: str
    output_folder: str
    concat: bool = False


class MoonshineImageModelOptions(BaseModel):
    tile_size: int = Field(384, ge=1)
    tile_batch: int = Field(4, ge=1, le=32)


class MoonshineImageProcessItem(BaseModel):
    id: str = Field(..., description="Unique identifier for this item")
    image: str = Field(..., description="Image data")


class MoonshineImageProcessRequest(BaseModel):
    model_id: str = Field(..., description="Moonshine image model id")
    data: List[MoonshineImageProcessItem] = Field(default_factory=list)
    image_type: Literal["base64", "path"] = Field("base64")
    temp_path: Optional[str] = Field(None)
    response_type: Literal["base64", "path"] = Field("base64")
    options: MoonshineImageModelOptions = Field(default_factory=MoonshineImageModelOptions)

    @model_validator(mode="after")
    def validate_fields(cls, values: "MoonshineImageProcessRequest"):
        if len(values.data) == 0:
            raise ValueError("Data list cannot be empty")
        item_ids = [item.id for item in values.data]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("All item IDs must be unique")
        return values


class MoonshineImageFolderProcessRequest(BaseModel):
    model_id: str = Field(..., description="Moonshine image model id")
    device: str = Field("cpu", description="Torch device string")
    image_folder: str
    output_folder: str
    options: MoonshineImageModelOptions = Field(default_factory=MoonshineImageModelOptions)


class VideoBatchFrameItem(BaseModel):
    frame_index: int = Field(..., ge=0)
    image_path: str
    mask_path: Optional[str] = None
    output_path: str


class VideoBatchInpaintOptions(BaseModel):
    inpaint: InpaintRequest = Field(default_factory=InpaintRequest)
    model_options: MoonshineImageModelOptions = Field(default_factory=MoonshineImageModelOptions)
    keep_mask_grayscale: bool = Field(True)
    stop_on_error: bool = Field(True)
    batch_id: Optional[str] = Field(None)
    failure_root: Optional[str] = Field(None)
    failure_retention: int = Field(3, ge=1, le=50)


class VideoBatchInpaintRequest(BaseModel):
    model_id: str = Field("lama", description="Video processing model id")
    frames: List[VideoBatchFrameItem] = Field(default_factory=list)
    options: VideoBatchInpaintOptions = Field(default_factory=VideoBatchInpaintOptions)

    @model_validator(mode="after")
    def validate_fields(cls, values: "VideoBatchInpaintRequest"):
        if len(values.frames) == 0:
            raise ValueError("frames cannot be empty")
        frame_indexes = [item.frame_index for item in values.frames]
        if len(frame_indexes) != len(set(frame_indexes)):
            raise ValueError("frame_index must be unique in one batch")
        model_id = str(values.model_id or "lama").strip().lower()
        values.model_id = model_id or "lama"
        if values.model_id == "lama":
            missing_mask_indexes = [
                item.frame_index for item in values.frames if not item.mask_path
            ]
            if missing_mask_indexes:
                raise ValueError("mask_path is required when model_id is lama")
        if values.model_id not in {"lama", "slbr"}:
            raise ValueError(f"Unsupported video model_id: {values.model_id}")
        return values
