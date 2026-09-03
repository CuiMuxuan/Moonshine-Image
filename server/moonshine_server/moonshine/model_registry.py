import hashlib
import json
import os
import re
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    from loguru import logger
except ImportError:  # Lightweight release/export tools do not need the full backend environment.
    import logging

    logger = logging.getLogger(__name__)

from moonshine_server.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space

REMOTE_UNREACHABLE_USER_MESSAGE = (
    "无法连接到远程的下载源，建议稍后重试或手动下载。"
)
REMOTE_UNREACHABLE_ERROR_KIND = "remote_unreachable"
REMOTE_UNREACHABLE_PATTERN = re.compile(
    r"urlopen\s+error|winerror\s+10060|winerror\s+10061|winerror\s+10065|"
    r"timed?\s*out|getaddrinfo failed|failed to establish|connection refused|"
    r"connection reset|name or service not known|temporary failure in name resolution|"
    r"network is unreachable|no route to host|econnrefused|etimedout|enotfound|"
    r"由于连接方在一段时间后",
    re.IGNORECASE,
)


MODEL_CAPABILITY_KEYS = (
    "speed",
    "realImageQuality",
    "cartoonImageQuality",
    "simpleSceneQuality",
    "complexSceneQuality",
    "textWatermarkAbility",
    "lowVramFriendly",
    "stability",
)

SAM_FINE_GRAINED_CAPABILITY_KEYS = (
    "imagePoint",
    "imageBox",
    "imageText",
    "videoPoint",
    "videoBox",
    "videoText",
    "videoPropagate",
)

SAM_CAPABILITY_EMPTY = {key: False for key in SAM_FINE_GRAINED_CAPABILITY_KEYS}
SAM1_IMAGE_CAPABILITIES = {
    **SAM_CAPABILITY_EMPTY,
    "imagePoint": True,
    "imageBox": True,
}
SAM2_1_CAPABILITIES = {
    **SAM1_IMAGE_CAPABILITIES,
    "videoPoint": True,
    "videoBox": True,
    "videoPropagate": True,
}
SAM3_OFFICIAL_CAPABILITIES = {
    **SAM_CAPABILITY_EMPTY,
    "imagePoint": True,
    "imageBox": True,
    "imageText": True,
    "videoPoint": True,
    "videoBox": True,
    "videoText": True,
    "videoPropagate": True,
}
SAM3_ENABLED_CAPABILITIES = {
    **SAM_CAPABILITY_EMPTY,
    "imagePoint": True,
    "imageBox": True,
    "imageText": True,
    "videoBox": True,
    "videoText": True,
    "videoPropagate": True,
}
SAM3_1_MULTIPLEX_ENABLED_CAPABILITIES = {
    **SAM3_ENABLED_CAPABILITIES,
    "imagePoint": False,
    "imageBox": False,
}
SAM3_CAPABILITY_NOTES = {
    "imagePoint": (
        "官方 SAM1-task 示例通过 build_sam3_image_model(enable_inst_interactivity=True) "
        "和 model.predict_inst(point_coords=...) 支持图片点选；本项目通过独立 SAM3 图片 adapter 接入。"
    ),
    "imageBox": (
        "官方图片示例通过 Sam3Processor.add_geometric_prompt() 支持归一化框选；"
        "本项目点/框统一通过 SAM3 instance interactivity adapter 接入。"
    ),
    "videoPoint": (
        "官方视频示例中的点提示需要 obj_id，更适合作为已有对象恢复/修正；"
        "本轮不开放 SAM3/SAM3.1 点选新建对象入口。"
    ),
    "videoBox": (
        "官方视频 predictor 的 add_prompt 支持 bounding_boxes；本项目通过独立 SAM3 视频 adapter 接入。"
    ),
    "videoText": (
        "官方视频 predictor 的 add_prompt 支持 text；本项目通过独立 SAM3 视频 adapter 接入。"
    ),
    "videoPropagate": "官方视频 predictor 支持传播；本项目通过任务式视频传播接口接入。",
}
SAM3_1_MULTIPLEX_CAPABILITY_NOTES = {
    **SAM3_CAPABILITY_NOTES,
    "imagePoint": (
        "sam3.1_multiplex.pt 当前缺少图片 instance interactivity 权重，"
        "不开放图片点选入口；图片点选请使用 SAM3/SAM2.1/SAM1。"
    ),
    "imageBox": (
        "sam3.1_multiplex.pt 当前缺少图片 instance interactivity 权重，"
        "不开放图片框选入口；图片框选请使用 SAM3/SAM2.1/SAM1。"
    ),
}

HF_MODEL_REPO_BASE_URL = "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main"
MANUAL_MODEL_SOURCE_URL = "https://pan.quark.cn/s/2e51ec70c7b9"
MANUAL_MODEL_INSTALL_HINT = (
    "如果 Hugging Face 主源下载不可用，请从夸克网盘副源手动下载对应模型文件，"
    "并放入当前模型路径。也可以私信作者或者加入交流群获取模型文件或百度网盘链接。"
)
SAM_MODEL_MANUAL_SOURCES = [
    {
        "label": "夸克网盘副源",
        "type": "quark",
        "url": MANUAL_MODEL_SOURCE_URL,
    }
]
SAM_MODEL_INSTALL_HINT = (
    "SAM 模型推荐按版本分路径放置：SAM1 放入 sam/，SAM2.1 放入 sam2/，"
    "SAM3/SAM3.1 放入 sam3/。同一版本的不同型号按各自 checkpoint 文件名并列管理；"
    "根路径 checkpoint 不再作为 SAM 模型安装位置识别。"
)
SAM3_LICENSE_HINT = (
    "SAM3/SAM3.1 权重由 Moonshine-Image 模型库提供下载时，仍需保留来源、版本、"
    "hash 与 Meta SAM License 确认记录；运行环境只使用本项目模型路径下的本地 checkpoint。"
)
RAPIDOCR_LICENSE = {
    "name": "Apache-2.0",
    "url": "https://github.com/RapidAI/RapidOCR/blob/main/LICENSE",
    "note": "RapidOCR 项目代码采用 Apache License 2.0；ONNX 模型文件的来源与分发权利仍按本项目模型清单核验。",
}
RAPIDOCR_MODEL_BASE_URL = (
    "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/ocr/rapidocr"
)
RAPIDOCR_MODEL_FILES = (
    {
        "path": "ocr/PP-OCRv6_det_small.onnx",
        "label": "检测模型（det）",
        "size": 9929594,
        "sha256": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{RAPIDOCR_MODEL_BASE_URL}/PP-OCRv6_det_small.onnx",
            }
        ],
        "legacyPaths": [],
    },
    {
        "path": "ocr/PP-OCRv6_rec_small.onnx",
        "label": "识别模型（rec）",
        "size": 21234383,
        "sha256": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{RAPIDOCR_MODEL_BASE_URL}/PP-OCRv6_rec_small.onnx",
            }
        ],
        "legacyPaths": [],
    },
    {
        "path": "ocr/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "label": "方向分类模型（cls）",
        "size": 585532,
        "sha256": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{RAPIDOCR_MODEL_BASE_URL}/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
            }
        ],
        "legacyPaths": [],
    },
)
RAPIDOCR_MODEL_MANIFEST = {
    "id": "ocr_rapid_onnx_mobile",
    "label": "RapidOCR",
    "description": "RapidOCR det/rec/cls ONNX 文本识别模型。",
    "type": "ocr",
    "family": "rapidocr",
    "category": "ocr",
    "license": RAPIDOCR_LICENSE,
    "downloadable": True,
    "sourceLinks": [source for file_spec in RAPIDOCR_MODEL_FILES for source in file_spec["sourceLinks"]],
    "manualSources": [
        {
            "label": "夸克网盘副源",
            "type": "quark",
            "url": MANUAL_MODEL_SOURCE_URL,
        }
    ],
    "manualHint": (
        "请将 RapidOCR 的 det、rec、cls 三个 ONNX 文件放入当前模型路径的 ocr/ 子路径。"
        + MANUAL_MODEL_INSTALL_HINT
    ),
    "requiresMask": False,
    "files": RAPIDOCR_MODEL_FILES,
    "size": sum(file_spec["size"] for file_spec in RAPIDOCR_MODEL_FILES),
    "sha256": "",
    "capabilities": {
        "imageText": True,
        "imagePolygon": True,
    },
}
LAMA_LICENSE = {
    "name": "Apache-2.0",
    "url": "https://github.com/advimman/lama/blob/main/LICENSE",
    "note": "LaMa 上游项目许可证；模型下载仍按本项目模型库元数据校验。",
}
SLBR_LICENSE = {
    "name": "SLBR upstream research checkpoint",
    "url": "",
    "note": "SLBR 权重来自上游研究发布，发布前需保留来源和本项目模型库校验记录。",
}
MAT_LICENSE = {
    "name": "CC BY-NC 4.0",
    "url": "https://creativecommons.org/licenses/by-nc/4.0/",
    "note": "MAT 权重仅限非商业用途；分发和使用时必须保留上游来源、署名和许可证说明。",
}
SAM1_LICENSE = {
    "name": "Apache-2.0",
    "url": "https://github.com/facebookresearch/segment-anything/blob/main/LICENSE",
    "note": "SAM1 代码和公开 checkpoint 按上游 Segment Anything 许可证记录。",
}
SAM2_LICENSE = {
    "name": "Apache-2.0",
    "url": "https://github.com/facebookresearch/sam2/blob/main/LICENSE",
    "note": "SAM2.1 代码和公开 checkpoint 按上游 SAM2 许可证记录。",
}
SAM3_LICENSE = {
    "name": "SAM License",
    "url": "https://github.com/facebookresearch/sam3/blob/main/LICENSE",
    "note": "SAM3/SAM3.1 属于 Meta SAM License；本项目只从项目自有模型库提供已记录来源、hash 和许可证说明的文件。",
    "requiresAcceptance": True,
    "acceptanceId": "meta-sam-license-v1",
}
UNKNOWN_LICENSE = {
    "name": "Manual review required",
    "url": "",
    "note": "该模型缺少可自动确认的许可证元数据，进入发布包前必须人工补齐。",
}


MODEL_MANIFEST = (
    {
        "id": "lama",
        "label": "Lama 去除模型",
        "description": "通用擦除与图像修复模型，适合需要蒙版的物体、文字和水印移除。",
        "type": "image",
        "requiresMask": True,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/big-lama.pt",
            }
        ],
        "manualSources": [
            {
                "label": "夸克网盘副源",
                "type": "quark",
                "url": MANUAL_MODEL_SOURCE_URL,
            }
        ],
        "manualHint": MANUAL_MODEL_INSTALL_HINT,
        "files": [
            {
                "path": "big-lama.pt",
                "label": "big-lama.pt",
                "size": 205669692,
                "sha256": "344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9",
                "legacyPaths": [
                    "hub/checkpoints/big-lama.pt",
                    "torch/hub/checkpoints/big-lama.pt",
                ],
            }
        ],
        "size": 205669692,
        "sha256": "344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9",
        "recommendedDevice": "cuda",
        "minimumVram": 2048,
        "runCapabilities": {
            "scopes": ["selected", "folder"],
            "folderInputs": ["imageFolder", "maskFolder"],
            "batchActions": ["deleteSelected", "applyCurrentMaskToSelected"],
            "outputRequired": True,
        },
        "parameters": {},
        "parameterHelp": "当前模型参数由服务自动控制，无需手动调整。",
        "capabilities": {
            "speed": 7.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 9.0,
            "complexSceneQuality": 7.0,
            "textWatermarkAbility": 6.0,
            "lowVramFriendly": 6.0,
            "stability": 8.0,
        },
    },
    {
        "id": "mat",
        "label": "MAT 去除模型",
        "description": "Mask-Aware Transformer 图像修复模型，适合需要蒙版的较大区域擦除和补全；仅限非商业用途，且需要 CUDA。",
        "type": "image",
        "family": "mat",
        "modelVersion": "MAT",
        "requiresMask": True,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/mat/Places_512_FullData_G.pth",
            }
        ],
        "manualSources": [
            {
                "label": "夸克网盘副源",
                "type": "quark",
                "url": MANUAL_MODEL_SOURCE_URL,
            }
        ],
        "manualHint": MANUAL_MODEL_INSTALL_HINT,
        "files": [
            {
                "path": "mat/Places_512_FullData_G.pth",
                "label": "Places_512_FullData_G.pth",
                "size": 250619359,
                "sha256": "0512e37ebba3986b0355130b2e2c1f95736d0778ac82e91b1212b4b21c231312",
            }
        ],
        "size": 250619359,
        "sha256": "0512e37ebba3986b0355130b2e2c1f95736d0778ac82e91b1212b4b21c231312",
        "license": MAT_LICENSE,
        "recommendedDevice": "cuda",
        "minimumVram": 6144,
        "recommendedVram": 8192,
        "runCapabilities": {
            "scopes": ["selected", "batch", "folder", "video"],
            "folderInputs": ["imageFolder", "maskFolder"],
            "batchActions": ["deleteSelected", "applyCurrentMaskToSelected"],
            "outputRequired": True,
        },
        "parameters": {},
        "parameterHelp": "MAT 使用当前蒙版进行图像修复，需要 CUDA；无 CUDA 时会自动回退到 LaMa。",
        "capabilities": {
            "speed": 5.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 6.0,
            "lowVramFriendly": 4.0,
            "stability": 7.0,
        },
    },
    {
        "id": "slbr",
        "label": "透明水印去除模型",
        "description": "用于半透明可见水印去除的特化模型，适合批量清理图片半透明可见水印，不适合清除不透明水印。",
        "type": "image",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/slbr.pth.tar",
            }
        ],
        "manualSources": [
            {
                "label": "夸克网盘副源",
                "type": "quark",
                "url": MANUAL_MODEL_SOURCE_URL,
            }
        ],
        "manualHint": MANUAL_MODEL_INSTALL_HINT,
        "files": [
            {
                "path": "slbr.pth.tar",
                "label": "slbr.pth.tar",
                "size": 85782395,
                "sha256": "f3984bd73e8eff5bfd69ad4786788c049a934fc8619821e4d9b9605c31a5d9b0",
                "legacyPaths": ["slbr/model_best.pth.tar"],
            }
        ],
        "size": 85782395,
        "sha256": "f3984bd73e8eff5bfd69ad4786788c049a934fc8619821e4d9b9605c31a5d9b0",
        "recommendedDevice": "cuda",
        "minimumVram": 2048,
        "runCapabilities": {
            "scopes": ["selected", "folder"],
            "folderInputs": ["imageFolder", "maskFolder"],
            "batchActions": ["deleteSelected"],
            "outputRequired": True,
            "localApplication": True,
        },
        "parameters": {
            "tile_size": {
                "label": "分块大小",
                "type": "select",
                "default": 384,
                "options": [256, 384, 512],
                "required": True,
            },
            "tile_batch": {
                "label": "批次数量",
                "type": "number",
                "default": 4,
                "min": 1,
                "max": 32,
                "step": 1,
                "required": True,
            },
        },
        "parameterHelp": (
            "图片尺寸越大使用越大的分块大小，批次数量影响占用的显存，"
            "设备性能和分块大小直接影响处理效果和处理时间，"
            "分块大小为256与384的效果一般好于512。"
        ),
        "capabilities": {
            "speed": 6.0,
            "realImageQuality": 7.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 6.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 10.0,
            "lowVramFriendly": 6.0,
            "stability": 6.0,
        },
    },
    {
        "id": "sam_vit_b",
        "family": "sam",
        "familyLabel": "SAM1",
        "modelVersion": "SAM1",
        "variant": "ViT-B",
        "category": "mask_generator",
        "label": "SAM1 ViT-B 智能选区模型",
        "description": "适合日常图片智能选区。可以通过单击目标或拖出框选范围快速生成蒙版，速度快、占用较低，是多数图片处理场景的默认选择。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam/sam_vit_b_01ec64.pth",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam_vit_b_01ec64.pth 放入当前模型路径的 sam/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam/sam_vit_b_01ec64.pth",
                "label": "sam_vit_b_01ec64.pth",
                "size": 375042383,
                "sha256": "ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912",
                "legacyPaths": [],
            }
        ],
        "size": 375042383,
        "sha256": "ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912",
        "recommendedDevice": "cuda",
        "recommendedVram": 4096,
        "runCapabilities": {
            "scopes": ["currentImage"],
            "maskPrompts": ["point", "box"],
            "outputRequired": False,
        },
        "parameters": {},
        "parameterHelp": "SAM1 ViT-B 支持点选和框选提示，不直接支持自然语言文本提示词。",
        "capabilities": {
            "speed": 8.0,
            "realImageQuality": 7.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 6.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 7.0,
            "stability": 8.0,
        },
    },
    {
        "id": "sam_vit_l",
        "family": "sam",
        "familyLabel": "SAM1",
        "modelVersion": "SAM1",
        "variant": "ViT-L",
        "category": "mask_generator",
        "label": "SAM1 ViT-L 智能选区模型",
        "description": "适合需要更细致图片选区的场景。支持点选和框选生成蒙版，边缘识别通常比 ViT-B 更稳，但加载和处理会更慢。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam/sam_vit_l_0b3195.pth",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam_vit_l_0b3195.pth 放入当前模型路径的 sam/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam/sam_vit_l_0b3195.pth",
                "label": "sam_vit_l_0b3195.pth",
                "size": 1249524607,
                "sha256": "3adcc4315b642a4d2101128f611684e8734c41232a17c648ed1693702a49a622",
                "legacyPaths": [],
            }
        ],
        "size": 1249524607,
        "sha256": "3adcc4315b642a4d2101128f611684e8734c41232a17c648ed1693702a49a622",
        "recommendedDevice": "cuda",
        "recommendedVram": 8192,
        "runCapabilities": {
            "scopes": ["currentImage"],
            "maskPrompts": ["point", "box"],
            "outputRequired": False,
        },
        "parameters": {},
        "parameterHelp": "SAM1 ViT-L 支持点选和框选提示，不直接支持自然语言文本提示词。",
        "capabilities": {
            "speed": 6.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 8.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 7.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 5.0,
            "stability": 8.0,
        },
    },
    {
        "id": "sam_vit_h",
        "family": "sam",
        "familyLabel": "SAM1",
        "modelVersion": "SAM1",
        "variant": "ViT-H",
        "category": "mask_generator",
        "label": "SAM1 ViT-H 智能选区模型",
        "description": "适合质量优先的图片智能选区。对复杂主体、细节边缘和大图更友好，但显存和处理时间要求最高。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam/sam_vit_h_4b8939.pth",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam_vit_h_4b8939.pth 放入当前模型路径的 sam/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam/sam_vit_h_4b8939.pth",
                "label": "sam_vit_h_4b8939.pth",
                "size": 2564550879,
                "sha256": "a7bf3b02f3ebf1267aba913ff637d9a2d5c33d3173bb679e46d9f338c26f262e",
                "legacyPaths": [],
            }
        ],
        "size": 2564550879,
        "sha256": "a7bf3b02f3ebf1267aba913ff637d9a2d5c33d3173bb679e46d9f338c26f262e",
        "recommendedDevice": "cuda",
        "recommendedVram": 12288,
        "runCapabilities": {
            "scopes": ["currentImage"],
            "maskPrompts": ["point", "box"],
            "outputRequired": False,
        },
        "parameters": {},
        "parameterHelp": "SAM1 ViT-H 支持点选和框选提示，不直接支持自然语言文本提示词。",
        "capabilities": {
            "speed": 4.0,
            "realImageQuality": 9.0,
            "cartoonImageQuality": 8.0,
            "simpleSceneQuality": 9.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 3.0,
            "stability": 8.0,
        },
    },
    {
        "id": "sam2_1_hiera_tiny",
        "family": "sam2",
        "familyLabel": "SAM2.1",
        "modelVersion": "SAM2.1",
        "variant": "Hiera Tiny",
        "category": "mask_generator",
        "label": "SAM2.1 Hiera Tiny",
        "description": "适合轻量视频智能选区。可以用较低资源完成目标跟踪和跨帧蒙版生成，适合快速试选和低配置设备。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam2/sam2.1_hiera_tiny.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam2.1_hiera_tiny.pt 放入当前模型路径的 sam2/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam2/sam2.1_hiera_tiny.pt",
                "label": "sam2.1_hiera_tiny.pt",
                "size": 156008466,
                "sha256": "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
                "legacyPaths": [],
            }
        ],
        "size": 156008466,
        "sha256": "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
        "recommendedDevice": "cuda",
        "recommendedVram": 1024,
        "runCapabilities": {
            "scopes": ["currentImage", "videoFrames"],
            "maskPrompts": ["point", "box", "mask"],
            "outputRequired": False,
        },
        "parameters": {"config": "sam2/configs/sam2.1/sam2.1_hiera_t.yaml"},
        "parameterHelp": "SAM2.1 支持图像和视频 predictor，当前作为后续增强能力管理。",
        "capabilities": {
            "speed": 8.0,
            "realImageQuality": 7.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 7.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 7.0,
            "stability": 6.0,
        },
    },
    {
        "id": "sam2_1_hiera_small",
        "family": "sam2",
        "familyLabel": "SAM2.1",
        "modelVersion": "SAM2.1",
        "variant": "Hiera Small",
        "category": "mask_generator",
        "label": "SAM2.1 Hiera Small",
        "description": "适合常规视频智能选区。速度和选区质量比较均衡，可以处理人物、物体等常见目标的跨帧蒙版。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam2/sam2.1_hiera_small.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam2.1_hiera_small.pt 放入当前模型路径的 sam2/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam2/sam2.1_hiera_small.pt",
                "label": "sam2.1_hiera_small.pt",
                "size": 184416285,
                "sha256": "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38",
                "legacyPaths": [],
            }
        ],
        "size": 184416285,
        "sha256": "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38",
        "recommendedDevice": "cuda",
        "recommendedVram": 2048,
        "runCapabilities": {
            "scopes": ["currentImage", "videoFrames"],
            "maskPrompts": ["point", "box", "mask"],
            "outputRequired": False,
        },
        "parameters": {"config": "sam2/configs/sam2.1/sam2.1_hiera_s.yaml"},
        "parameterHelp": "SAM2.1 支持图像和视频 predictor，当前作为后续增强能力管理。",
        "capabilities": {
            "speed": 7.0,
            "realImageQuality": 7.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 7.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 6.0,
            "stability": 6.0,
        },
    },
    {
        "id": "sam2_1_hiera_base_plus",
        "family": "sam2",
        "familyLabel": "SAM2.1",
        "modelVersion": "SAM2.1",
        "variant": "Hiera Base+",
        "category": "mask_generator",
        "label": "SAM2.1 Hiera Base+",
        "description": "适合更复杂的视频选区任务。对目标边缘、运动变化和跨帧一致性更友好，适合比 Small 更高质量的输出。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam2/sam2.1_hiera_base_plus.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam2.1_hiera_base_plus.pt 放入当前模型路径的 sam2/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam2/sam2.1_hiera_base_plus.pt",
                "label": "sam2.1_hiera_base_plus.pt",
                "size": 323606802,
                "sha256": "a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5",
                "legacyPaths": [],
            }
        ],
        "size": 323606802,
        "sha256": "a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5",
        "recommendedDevice": "cuda",
        "recommendedVram": 4096,
        "runCapabilities": {
            "scopes": ["currentImage", "videoFrames"],
            "maskPrompts": ["point", "box", "mask"],
            "outputRequired": False,
        },
        "parameters": {"config": "sam2/configs/sam2.1/sam2.1_hiera_b+.yaml"},
        "parameterHelp": "SAM2.1 支持图像和视频 predictor，当前作为后续增强能力管理。",
        "capabilities": {
            "speed": 6.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 8.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 5.0,
            "stability": 6.0,
        },
    },
    {
        "id": "sam2_1_hiera_large",
        "family": "sam2",
        "familyLabel": "SAM2.1",
        "modelVersion": "SAM2.1",
        "variant": "Hiera Large",
        "category": "mask_generator",
        "label": "SAM2.1 Hiera Large",
        "description": "适合高质量视频智能选区。可以把当前帧的点选或框选目标传播到视频片段中，生成更稳定、细节更好的蒙版轨道。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam2/sam2.1_hiera_large.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam2.1_hiera_large.pt 放入当前模型路径的 sam2/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
        ),
        "files": [
            {
                "path": "sam2/sam2.1_hiera_large.pt",
                "label": "sam2.1_hiera_large.pt",
                "size": 898083611,
                "sha256": "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318",
                "legacyPaths": [],
            }
        ],
        "size": 898083611,
        "sha256": "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318",
        "recommendedDevice": "cuda",
        "recommendedVram": 6144,
        "runCapabilities": {
            "scopes": ["currentImage", "videoFrames"],
            "maskPrompts": ["point", "box", "mask"],
            "outputRequired": False,
        },
        "parameters": {"config": "sam2/configs/sam2.1/sam2.1_hiera_l.yaml"},
        "parameterHelp": "SAM2.1 Hiera Large 是本项目默认视频智能选区型号。",
        "capabilities": {
            "speed": 4.0,
            "realImageQuality": 9.0,
            "cartoonImageQuality": 8.0,
            "simpleSceneQuality": 9.0,
            "complexSceneQuality": 9.0,
            "textWatermarkAbility": 2.0,
            "lowVramFriendly": 3.0,
            "stability": 6.0,
        },
    },
    {
        "id": "sam3",
        "family": "sam3",
        "familyLabel": "SAM3",
        "modelVersion": "SAM3",
        "variant": "Base",
        "category": "text_smart_selection",
        "label": "SAM3 图片智能选区模型",
        "description": "同时支持图片点选、框选和文字提示；可在同一张图片上生成一个或多个候选蒙版。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam3/sam3.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam3.pt 放入当前模型路径的 sam3/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
            + SAM3_LICENSE_HINT
        ),
        "files": [
            {
                "path": "sam3/sam3.pt",
                "label": "sam3.pt",
                "size": 3450062241,
                "sha256": "9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e",
                "legacyPaths": [],
            }
        ],
        "size": 3450062241,
        "sha256": "9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e",
        "recommendedDevice": "cuda",
        "recommendedVram": 16384,
        "runCapabilities": {
            "scopes": ["currentImage", "selectedImages"],
            "maskPrompts": ["point", "box", "text"],
            "languages": ["zh-CN", "en"],
            "outputRequired": False,
        },
        "parameters": {},
        "parameterHelp": "SAM3 支持图片点选、框选、点框混合提示和文字提示；批量接口一次处理同一张图片的多个提示。",
        "capabilities": {
            "speed": 4.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 8.0,
            "lowVramFriendly": 2.0,
            "stability": 5.0,
        },
    },
    {
        "id": "sam3_1_multiplex",
        "family": "sam3",
        "familyLabel": "SAM3.1",
        "modelVersion": "SAM3.1",
        "variant": "Multiplex",
        "category": "text_smart_selection",
        "label": "SAM3.1 Multiplex 文本智能选区模型",
        "description": "适合更强的文本智能选区。可以用中文或英文短语检索图片目标，并返回可选择的候选蒙版；对多目标和相似目标场景更友好。",
        "type": "mask",
        "requiresMask": False,
        "downloadable": True,
        "sourceLinks": [
            {
                "label": "Hugging Face 主源",
                "type": "huggingface",
                "url": f"{HF_MODEL_REPO_BASE_URL}/sam3/sam3.1_multiplex.pt",
            }
        ],
        "manualSources": SAM_MODEL_MANUAL_SOURCES,
        "manualHint": (
            "请将 sam3.1_multiplex.pt 放入当前模型路径的 sam3/ 子路径。"
            + SAM_MODEL_INSTALL_HINT
            + SAM3_LICENSE_HINT
        ),
        "files": [
            {
                "path": "sam3/sam3.1_multiplex.pt",
                "label": "sam3.1_multiplex.pt",
                "size": 3502755717,
                "sha256": "0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6",
                "legacyPaths": [],
            }
        ],
        "size": 3502755717,
        "sha256": "0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6",
        "recommendedDevice": "cuda",
        "recommendedVram": 16384,
        "runCapabilities": {
            "scopes": ["currentImage", "selectedImages", "videoFrames"],
            "maskPrompts": ["text"],
            "languages": ["zh-CN", "en"],
            "outputRequired": False,
        },
        "parameters": {},
        "parameterHelp": "SAM3.1 Multiplex 是本项目 SAM3 默认评估型号，下载必须遵守 Meta SAM License 和 gated 访问要求。",
        "capabilities": {
            "speed": 5.0,
            "realImageQuality": 8.0,
            "cartoonImageQuality": 7.0,
            "simpleSceneQuality": 8.0,
            "complexSceneQuality": 8.0,
            "textWatermarkAbility": 9.0,
            "lowVramFriendly": 2.0,
            "stability": 6.0,
        },
    },
)
MODEL_MANIFEST = MODEL_MANIFEST + (RAPIDOCR_MODEL_MANIFEST,)

SIGNED_MODEL_MANIFEST_PATH_ENV = "MOONSHINE_MODEL_MANIFEST_PATH"
SIGNED_MODEL_MANIFEST_REQUIRED_ENV = "MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST"
SIGNED_MODEL_MANIFEST_CHANNEL_ENV = "MOONSHINE_MODEL_MANIFEST_CHANNEL"
SIGNED_MODEL_MANIFEST_KEY_ID = "moonshine-app-manifest-v1"
MODEL_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{1,63}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_model_manifest_cache = {
    "key": None,
    "models": MODEL_MANIFEST,
    "metadata": None,
}
_model_manifest_lock = threading.Lock()


def _env_enabled(name: str) -> bool:
    return str(os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def _downloads_disabled_fallback() -> tuple[dict, ...]:
    return tuple(_disable_model_downloads(model) for model in MODEL_MANIFEST)


def _disable_model_downloads(model: dict) -> dict:
    return {
        **model,
        "downloadable": False,
        "sourceLinks": [],
        "files": [
            {
                **file_spec,
                "sourceLinks": [],
                # Older catalogs used the `sources` alias. Clear both names
                # so the download worker cannot resurrect a disabled URL.
                "sources": [],
            }
            for file_spec in model.get("files", [])
        ],
    }


def _has_download_sources(model: dict) -> bool:
    """Return whether a model has either aggregate or per-file download URLs."""
    if model.get("sourceLinks"):
        return True
    for file_spec in model.get("files") or []:
        if file_spec.get("sourceLinks") or file_spec.get("sources"):
            return True
    return False


def _validate_https_url(value: str, label: str):
    parsed = urlparse(str(value or "").strip())
    if (
        parsed.scheme.lower() != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise ValueError(f"{label} must be a credential-free HTTPS URL")


def _validate_external_model(model: dict, index: int) -> dict:
    if not isinstance(model, dict):
        raise ValueError(f"models[{index}] must be an object")
    model_id = str(model.get("id") or "").strip().lower()
    if not MODEL_ID_PATTERN.fullmatch(model_id):
        raise ValueError(f"models[{index}].id is invalid")
    files = model.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError(f"models[{index}].files must be a non-empty array")
    file_paths = set()
    file_source_count = 0
    for file_index, file_spec in enumerate(files):
        if not isinstance(file_spec, dict):
            raise ValueError(f"models[{index}].files[{file_index}] must be an object")
        relative_path = str(_safe_relative_path(file_spec.get("path", ""))).replace("\\", "/")
        if not relative_path or relative_path in file_paths:
            raise ValueError(f"models[{index}] contains a duplicate or empty file path")
        file_paths.add(relative_path)
        size = file_spec.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size < 1:
            raise ValueError(f"models[{index}].files[{file_index}].size is invalid")
        sha256 = str(file_spec.get("sha256") or "").strip().lower()
        if not SHA256_PATTERN.fullmatch(sha256):
            raise ValueError(f"models[{index}].files[{file_index}].sha256 is invalid")
        for legacy_path in file_spec.get("legacyPaths") or []:
            _safe_relative_path(legacy_path)
        file_sources = file_spec.get("sourceLinks") or file_spec.get("sources") or []
        if not isinstance(file_sources, list):
            raise ValueError(f"models[{index}].files[{file_index}].sourceLinks must be an array")
        for source_index, source in enumerate(file_sources):
            if not isinstance(source, dict):
                raise ValueError(
                    f"models[{index}].files[{file_index}].sourceLinks[{source_index}] must be an object"
                )
            _validate_https_url(
                source.get("url"),
                f"models[{index}].files[{file_index}].sourceLinks[{source_index}].url",
            )
        file_source_count += bool(file_sources)

    source_links = model.get("sourceLinks") or []
    if not isinstance(source_links, list):
        raise ValueError(f"models[{index}].sourceLinks must be an array")
    if bool(model.get("downloadable")) and not source_links and file_source_count < len(files):
        raise ValueError(f"models[{index}] is downloadable but has no sourceLinks")
    for source_index, source in enumerate(source_links):
        if not isinstance(source, dict):
            raise ValueError(f"models[{index}].sourceLinks[{source_index}] must be an object")
        _validate_https_url(source.get("url"), f"models[{index}].sourceLinks[{source_index}].url")
    for source_index, source in enumerate(model.get("manualSources") or []):
        if not isinstance(source, dict):
            raise ValueError(f"models[{index}].manualSources[{source_index}] must be an object")
        _validate_https_url(source.get("url"), f"models[{index}].manualSources[{source_index}].url")

    license_metadata = model.get("license") or _model_license_metadata(model)
    family = str(model.get("family") or "").strip().lower()
    if family == "sam3" or model_id.startswith("sam3"):
        if not license_metadata.get("requiresAcceptance") or not license_metadata.get("acceptanceId"):
            raise ValueError(f"models[{index}] requires an explicit SAM license acceptance gate")
    return model


def _parse_signed_model_manifest(document: dict, expected_channel: str) -> tuple[tuple[dict, ...], dict]:
    if not isinstance(document, dict):
        raise ValueError("Signed model manifest must be an object")
    payload = document.get("payload")
    signature = document.get("signature")
    if not isinstance(payload, dict) or not isinstance(signature, dict):
        raise ValueError("Signed model manifest must contain payload and signature")
    if signature.get("algorithm") != "Ed25519" or signature.get("keyId") != SIGNED_MODEL_MANIFEST_KEY_ID:
        raise ValueError("Signed model manifest signature metadata is invalid")
    if not str(signature.get("value") or "").strip():
        raise ValueError("Signed model manifest signature value is missing")
    channel = str(payload.get("channel") or "").strip().lower()
    if expected_channel and channel != expected_channel:
        raise ValueError("Signed model manifest channel does not match the selected channel")
    sequence = payload.get("sequence")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        raise ValueError("Signed model manifest sequence is invalid")
    raw_models = payload.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise ValueError("Signed model manifest contains no models")
    ids = set()
    models = []
    for index, raw_model in enumerate(raw_models):
        model = _validate_external_model(raw_model, index)
        model_id = str(model.get("id") or "").strip().lower()
        if model_id in ids:
            raise ValueError(f"Duplicate model id: {model_id}")
        ids.add(model_id)
        models.append(model)
    # RapidOCR is a core application capability. Keep its aggregate card even
    # when an optional signed catalog does not enumerate it, but do not expose
    # unsigned download URLs in signed-manifest mode.
    if RAPIDOCR_MODEL_MANIFEST["id"] not in ids:
        models.append(_disable_model_downloads(RAPIDOCR_MODEL_MANIFEST))
    return tuple(models), {
        "source": "signed",
        "required": _env_enabled(SIGNED_MODEL_MANIFEST_REQUIRED_ENV),
        "channel": channel,
        "sequence": sequence,
        "modelCount": len(models),
        "path": str(Path(os.getenv(SIGNED_MODEL_MANIFEST_PATH_ENV) or "").expanduser()),
        "error": "",
    }


def _active_model_manifest() -> tuple[tuple[dict, ...], dict]:
    required = _env_enabled(SIGNED_MODEL_MANIFEST_REQUIRED_ENV)
    configured_path = str(os.getenv(SIGNED_MODEL_MANIFEST_PATH_ENV) or "").strip()
    expected_channel = str(os.getenv(SIGNED_MODEL_MANIFEST_CHANNEL_ENV) or "").strip().lower()
    if not configured_path:
        models = _downloads_disabled_fallback() if required else MODEL_MANIFEST
        return models, {
            "source": "safe-fallback" if required else "bundled",
            "required": required,
            "channel": expected_channel,
            "sequence": None,
            "modelCount": len(models),
            "path": "",
            "error": "Signed model manifest is unavailable" if required else "",
        }

    manifest_path = Path(configured_path).expanduser().resolve()
    try:
        stat = manifest_path.stat()
        if not manifest_path.is_file():
            raise ValueError("Signed model manifest path is not a file")
        cache_key = (str(manifest_path), stat.st_mtime_ns, stat.st_size, expected_channel, required)
        with _model_manifest_lock:
            if _model_manifest_cache["key"] == cache_key:
                return _model_manifest_cache["models"], dict(_model_manifest_cache["metadata"])
            with manifest_path.open("r", encoding="utf-8") as manifest_file:
                document = json.load(manifest_file)
            models, metadata = _parse_signed_model_manifest(document, expected_channel)
            metadata["path"] = str(manifest_path)
            _model_manifest_cache.update({"key": cache_key, "models": models, "metadata": metadata})
            return models, dict(metadata)
    except Exception as error:
        logger.warning(f"Signed model manifest rejected: {error}")
        models = _downloads_disabled_fallback() if required else MODEL_MANIFEST
        return models, {
            "source": "safe-fallback" if required else "bundled",
            "required": required,
            "channel": expected_channel,
            "sequence": None,
            "modelCount": len(models),
            "path": str(manifest_path),
            "error": str(error),
        }


def get_model_manifest_metadata() -> dict:
    _, metadata = _active_model_manifest()
    return metadata


def _now() -> float:
    return time.time()


def _normalize_capabilities(capabilities: Optional[dict]) -> dict:
    source = capabilities or {}
    result = {}
    for key in MODEL_CAPABILITY_KEYS:
        try:
            value = float(source.get(key, 0))
        except (TypeError, ValueError):
            value = 0.0
        result[key] = round(max(0.0, min(10.0, value)), 1)
    return result


def _normalize_sam_capabilities(capabilities: Optional[dict]) -> dict:
    source = capabilities or {}
    return {
        key: bool(source.get(key, False))
        for key in SAM_FINE_GRAINED_CAPABILITY_KEYS
    }


def _sam_model_capability_metadata(model: dict) -> dict:
    family = str(model.get("family") or "").lower()
    if family == "sam":
        return {
            "officialCapabilities": _normalize_sam_capabilities(SAM1_IMAGE_CAPABILITIES),
            "enabledCapabilities": _normalize_sam_capabilities(SAM1_IMAGE_CAPABILITIES),
            "capabilityNotes": {},
        }
    if family == "sam2":
        return {
            "officialCapabilities": _normalize_sam_capabilities(SAM2_1_CAPABILITIES),
            "enabledCapabilities": _normalize_sam_capabilities(SAM2_1_CAPABILITIES),
            "capabilityNotes": {},
        }
    if family == "sam3":
        is_sam3_1_multiplex = str(model.get("id") or "") == "sam3_1_multiplex"
        enabled_capabilities = (
            SAM3_1_MULTIPLEX_ENABLED_CAPABILITIES
            if is_sam3_1_multiplex
            else SAM3_ENABLED_CAPABILITIES
        )
        capability_notes = (
            SAM3_1_MULTIPLEX_CAPABILITY_NOTES
            if is_sam3_1_multiplex
            else SAM3_CAPABILITY_NOTES
        )
        return {
            "officialCapabilities": _normalize_sam_capabilities(SAM3_OFFICIAL_CAPABILITIES),
            "enabledCapabilities": _normalize_sam_capabilities(enabled_capabilities),
            "capabilityNotes": {
                key: value
                for key, value in capability_notes.items()
                if key in SAM_FINE_GRAINED_CAPABILITY_KEYS
            },
        }
    return {}


def _safe_relative_path(value: str) -> Path:
    raw = str(value or "").strip().replace("\\", "/")
    path = Path(raw)
    if not raw or raw in {".", ".."} or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Invalid model file path: {value}")
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _model_license_metadata(model: dict) -> dict:
    model_id = str(model.get("id") or "").lower()
    family = str(model.get("family") or "").lower()
    if model_id == "lama":
        return LAMA_LICENSE
    if model_id == "slbr":
        return SLBR_LICENSE
    if family == "sam":
        return SAM1_LICENSE
    if family == "sam2":
        return SAM2_LICENSE
    if family == "sam3":
        return SAM3_LICENSE
    return UNKNOWN_LICENSE


def _file_status(model_dir: Path, file_spec: dict) -> dict:
    relative_path = _safe_relative_path(file_spec.get("path", ""))
    expected_sha256 = str(file_spec.get("sha256") or "").strip().lower()
    canonical_path = model_dir / relative_path
    candidate_paths = [
        {
            "path": canonical_path,
            "kind": "canonical",
            "legacyPath": "",
        },
        {
            "path": model_dir.parent / relative_path,
            "kind": "alternate",
            "legacyPath": "",
        },
    ]
    legacy_candidates = []
    for legacy_path in file_spec.get("legacyPaths") or []:
        safe_legacy_path = _safe_relative_path(legacy_path)
        legacy_candidates.append(
            {
                "path": model_dir / safe_legacy_path,
                "kind": "legacy",
                "legacyPath": str(safe_legacy_path).replace("\\", "/"),
            }
        )
    candidate_paths.extend(legacy_candidates)

    existing_candidate = next(
        (candidate for candidate in candidate_paths if candidate["path"].is_file()),
        None,
    )
    existing_path = existing_candidate["path"] if existing_candidate else None
    legacy_existing_paths = [
        candidate["path"]
        for candidate in legacy_candidates
        if candidate["path"].is_file()
    ]
    status = {
        "path": str(relative_path).replace("\\", "/"),
        "label": file_spec.get("label") or relative_path.name,
        "size": file_spec.get("size"),
        "sha256": expected_sha256,
        "canonicalPath": str(canonical_path),
        "legacyPaths": [
            str(_safe_relative_path(path)).replace("\\", "/")
            for path in file_spec.get("legacyPaths") or []
        ],
        "legacyExists": bool(legacy_existing_paths),
        "legacyDetected": bool(existing_candidate and existing_candidate["kind"] == "legacy"),
        "legacyPathUsed": existing_candidate["legacyPath"] if existing_candidate else "",
        "resolvedPathKind": existing_candidate["kind"] if existing_candidate else "",
        "migrationTarget": str(canonical_path),
        "exists": existing_path is not None,
        "valid": False,
        "actualSize": None,
        "actualSha256": "",
        "resolvedPath": str(existing_path) if existing_path else "",
    }

    if existing_path is None:
        return status

    status["actualSize"] = existing_path.stat().st_size
    if expected_sha256:
        actual_sha256 = _sha256_file(existing_path)
        status["actualSha256"] = actual_sha256
        status["valid"] = actual_sha256 == expected_sha256
    else:
        status["valid"] = True
    return status


def _device_compatible(model: dict, cuda_info: Optional[dict]) -> bool:
    """Return hard runtime compatibility, not the preferred accelerator.

    ``recommendedDevice`` and VRAM values are performance guidance. LaMa, MAT,
    SLBR and SAM1 have CPU implementations and must remain preparable without
    CUDA. SAM2/SAM3 are intentionally restricted by the packaged application.
    """
    family = str(model.get("family") or model.get("id") or "").strip().lower()
    if family not in {"sam2", "sam3"}:
        return True

    cuda_info = cuda_info or {}
    if not cuda_info.get("cuda_available") or cuda_info.get("cuda_compatible") is False:
        return False

    minimum_vram = model.get("minimumVram")
    if not minimum_vram:
        return True

    memory_mb = cuda_info.get("total_memory_mb") or cuda_info.get("free_memory_mb") or 0
    try:
        return float(memory_mb) >= float(minimum_vram)
    except (TypeError, ValueError):
        return True


def _recommended_vram_warning(model: dict, cuda_info: Optional[dict]) -> Optional[dict]:
    recommended_vram = model.get("recommendedVram")
    if not recommended_vram:
        return None

    cuda_info = cuda_info or {}
    memory_mb = cuda_info.get("total_memory_mb") or cuda_info.get("free_memory_mb") or 0
    try:
        recommended_mb = float(recommended_vram)
        current_mb = float(memory_mb or 0)
    except (TypeError, ValueError):
        return None

    if current_mb <= 0 or current_mb >= recommended_mb:
        return None

    return {
        "recommendedVram": recommended_mb,
        "currentVram": current_mb,
        "message": (
            f"推荐 {recommended_mb / 1024:.0f}GB，当前 {current_mb / 1024:.0f}GB，"
            "可能较慢或失败。"
        ),
    }


def build_model_status(model_dir: Path, cuda_info: Optional[dict] = None) -> list[dict]:
    model_dir = Path(model_dir).expanduser().resolve()
    models = []
    active_manifest, _ = _active_model_manifest()
    for manifest_item in active_manifest:
        file_statuses = [
            _file_status(model_dir, file_spec)
            for file_spec in manifest_item.get("files", [])
        ]
        missing_files = [
            file_status["path"]
            for file_status in file_statuses
            if not file_status["exists"]
        ]
        corrupt_files = [
            file_status["path"]
            for file_status in file_statuses
            if file_status["exists"] and not file_status["valid"]
        ]
        verified = len(file_statuses) > 0 and not missing_files and not corrupt_files
        installed = verified
        device_compatible = _device_compatible(manifest_item, cuda_info)
        recommended_vram_warning = _recommended_vram_warning(manifest_item, cuda_info)

        item = {
            **manifest_item,
            **_sam_model_capability_metadata(manifest_item),
            "license": manifest_item.get("license") or _model_license_metadata(manifest_item),
            "files": file_statuses,
            "installed": installed,
            "verified": verified,
            "fileStatus": "verified" if verified else ("corrupt" if corrupt_files else "missing"),
            "loadState": "not_loaded",
            "loaded": False,
            "runtimeReady": False,
            "ready": False,
            "readiness": {
                "status": "not_loaded" if verified and device_compatible else "blocked",
                "reason": (
                    None
                    if verified and device_compatible
                    else (
                        "device_incompatible"
                        if verified
                        else ("files_corrupt" if corrupt_files else "files_missing")
                    )
                ),
            },
            "available": installed and device_compatible,
            "missingFiles": missing_files,
            "corruptFiles": corrupt_files,
            "deviceCompatible": device_compatible,
            "recommendedVramWarning": recommended_vram_warning,
            "capabilities": _normalize_capabilities(manifest_item.get("capabilities")),
        }
        models.append(item)

    return models


def get_model_manifest(model_id: str) -> Optional[dict]:
    normalized_id = str(model_id or "").strip()
    active_manifest, _ = _active_model_manifest()
    return next(
        (item for item in active_manifest if item.get("id") == normalized_id),
        None,
    )


def _is_remote_unreachable_error(error: BaseException) -> bool:
    if isinstance(error, HTTPError):
        return False
    if isinstance(error, (URLError, TimeoutError, socket.timeout, ConnectionError)):
        return True
    if isinstance(error, OSError) and getattr(error, "winerror", None) in {10060, 10061, 10065}:
        return True
    return bool(REMOTE_UNREACHABLE_PATTERN.search(str(error) or ""))


@dataclass
class ModelDownloadTask:
    id: str
    model_id: str
    status: str = "queued"
    progress: float = 0
    downloaded_bytes: int = 0
    total_bytes: Optional[int] = None
    message: str = ""
    error: str = ""
    error_kind: str = ""
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)
    completed_at: Optional[float] = None
    model_dir: str = field(default="", repr=False)
    manifest_item: Optional[dict] = field(default=None, repr=False)
    thread: Optional[threading.Thread] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "modelId": self.model_id,
            "status": self.status,
            "progress": self.progress,
            "downloadedBytes": self.downloaded_bytes,
            "totalBytes": self.total_bytes,
            "message": self.message,
            "error": self.error,
            "errorKind": self.error_kind,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
            "done": self.status in {"completed", "failed"},
        }


class ModelDownloadTaskManager:
    def __init__(self):
        self._tasks: Dict[str, ModelDownloadTask] = {}
        self._lock = threading.Lock()

    def create_download_task(
        self,
        model_id: str,
        model_dir: Path,
        license_acceptance: Optional[dict] = None,
    ) -> ModelDownloadTask:
        manifest_item = get_model_manifest(model_id)
        if manifest_item is None:
            raise ValueError(f"Unknown model: {model_id}")
        if not manifest_item.get("downloadable"):
            raise ValueError("该模型不支持软件内下载。")
        if not _has_download_sources(manifest_item):
            raise ValueError("暂无下载源。")

        license_metadata = manifest_item.get("license") or _model_license_metadata(manifest_item)
        if license_metadata.get("requiresAcceptance"):
            acceptance = license_acceptance or {}
            expected_id = str(license_metadata.get("acceptanceId") or "").strip()
            if not acceptance.get("accepted") or str(acceptance.get("acceptanceId") or "").strip() != expected_id:
                raise ValueError("下载该模型前必须确认并接受对应许可证。")

        resolved_model_dir = Path(model_dir).expanduser().resolve()
        with self._lock:
            self._prune_completed_tasks_locked()
            active_task = next(
                (
                    task
                    for task in self._tasks.values()
                    if task.model_id == model_id
                    and task.model_dir == str(resolved_model_dir)
                    and task.status in {"queued", "running"}
                ),
                None,
            )
            if active_task is not None:
                return active_task

        task = ModelDownloadTask(
            id=uuid.uuid4().hex,
            model_id=model_id,
            model_dir=str(resolved_model_dir),
            manifest_item=manifest_item,
        )
        thread = threading.Thread(
            target=self._run_download_task,
            args=(task.id, resolved_model_dir),
            daemon=True,
        )
        task.thread = thread
        with self._lock:
            # Close the small race between the first lookup and task registration.
            active_task = next(
                (
                    existing
                    for existing in self._tasks.values()
                    if existing.model_id == model_id
                    and existing.model_dir == str(resolved_model_dir)
                    and existing.status in {"queued", "running"}
                ),
                None,
            )
            if active_task is not None:
                return active_task
            self._tasks[task.id] = task
            thread.start()
        return task

    def _prune_completed_tasks_locked(self, keep: int = 100):
        completed = sorted(
            (task for task in self._tasks.values() if task.status in {"completed", "failed"}),
            key=lambda task: task.completed_at or task.updated_at,
            reverse=True,
        )
        for task in completed[keep:]:
            self._tasks.pop(task.id, None)

    def get_task(self, task_id: str) -> Optional[ModelDownloadTask]:
        with self._lock:
            return self._tasks.get(task_id)

    def _patch_task(self, task_id: str, **changes):
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            for key, value in changes.items():
                setattr(task, key, value)
            task.updated_at = _now()
            if task.status in {"completed", "failed"} and task.completed_at is None:
                task.completed_at = task.updated_at

    def _run_download_task(self, task_id: str, model_dir: Path):
        task = self.get_task(task_id)
        if task is None:
            return

        manifest_item = task.manifest_item or get_model_manifest(task.model_id)
        try:
            self._patch_task(task_id, status="running", message="正在下载模型...")
            self._download_model_files(task_id, manifest_item, model_dir)
            self._patch_task(
                task_id,
                status="completed",
                progress=1,
                message="模型已下载并校验完成。",
            )
        except Exception as error:
            original_error = str(error)
            remote_unreachable = _is_remote_unreachable_error(error)
            logger.error(
                f"Model download task failed: {task.model_id}: {original_error}"
            )
            self._patch_task(
                task_id,
                status="failed",
                error=original_error,
                error_kind=REMOTE_UNREACHABLE_ERROR_KIND if remote_unreachable else "",
                message=(
                    REMOTE_UNREACHABLE_USER_MESSAGE
                    if remote_unreachable
                    else "模型下载失败。"
                ),
            )

    def _download_model_files(self, task_id: str, manifest_item: dict, model_dir: Path):
        file_specs = manifest_item.get("files") or []
        if not file_specs:
            raise ValueError("模型清单没有可下载文件。")

        total_expected = sum(max(0, int(file_spec.get("size") or 0)) for file_spec in file_specs)
        downloaded_total = 0
        self._patch_task(
            task_id,
            total_bytes=total_expected or None,
            downloaded_bytes=0,
            progress=0,
        )
        model_sources = manifest_item.get("sourceLinks") or []

        for file_spec in file_specs:
            relative_path = _safe_relative_path(file_spec.get("path", ""))
            target_path = model_dir / relative_path
            part_path = target_path.with_name(f"{target_path.name}.part")
            target_path.parent.mkdir(parents=True, exist_ok=True)
            estimated_size = int(file_spec.get("size") or 0)
            ensure_disk_space(
                target_path,
                estimated_size,
                safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
                operation="下载模型文件",
            )

            file_sources = file_spec.get("sourceLinks") or file_spec.get("sources") or model_sources
            if not file_sources:
                raise ValueError(f"模型文件没有下载源：{relative_path}")
            self._patch_task(
                task_id,
                message=f"正在下载 {file_spec.get('label') or relative_path.name}...",
            )
            last_error = None
            for source in file_sources:
                url = source.get("url") if isinstance(source, dict) else str(source)
                if not url:
                    continue
                try:
                    downloaded = self._download_url_to_file(
                        task_id,
                        url,
                        part_path,
                        downloaded_offset=downloaded_total,
                        aggregate_total=total_expected,
                    )
                    actual_size = part_path.stat().st_size
                    if estimated_size and actual_size != estimated_size:
                        raise ValueError(
                            f"模型文件大小校验失败：{relative_path}（期望 {estimated_size}，实际 {actual_size}）"
                        )
                    expected_sha256 = str(file_spec.get("sha256") or "").strip().lower()
                    if expected_sha256:
                        actual_sha256 = _sha256_file(part_path)
                        if actual_sha256 != expected_sha256:
                            raise ValueError("模型文件校验失败，请重新下载。")
                    os.replace(part_path, target_path)
                    downloaded_total += downloaded
                    if total_expected:
                        self._patch_task(
                            task_id,
                            downloaded_bytes=downloaded_total,
                            progress=min(0.99, downloaded_total / total_expected),
                        )
                    break
                except Exception as error:
                    last_error = error
                    try:
                        part_path.unlink(missing_ok=True)
                    except TypeError:
                        if part_path.exists():
                            part_path.unlink()
                    continue
            else:
                raise last_error or ValueError(f"暂无可用下载源：{relative_path}")

    def _download_url_to_file(
        self,
        task_id: str,
        url: str,
        part_path: Path,
        downloaded_offset: int = 0,
        aggregate_total: Optional[int] = None,
    ) -> int:
        request = Request(url, headers={"User-Agent": "Moonshine-Image"})
        with urlopen(request, timeout=30) as response:
            total_bytes = response.headers.get("Content-Length")
            total_bytes = int(total_bytes) if total_bytes and total_bytes.isdigit() else None
            effective_total = aggregate_total or total_bytes
            self._patch_task(task_id, total_bytes=effective_total)

            downloaded = 0
            with part_path.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    ensure_disk_space(
                        part_path,
                        len(chunk),
                        safety_bytes=DEFAULT_DISK_SPACE_SAFETY_BYTES,
                        operation="下载模型文件",
                    )
                    output.write(chunk)
                    downloaded += len(chunk)
                    progress = (
                        (downloaded_offset + downloaded) / effective_total
                        if effective_total
                        else 0
                    )
                    self._patch_task(
                        task_id,
                        downloaded_bytes=downloaded_offset + downloaded,
                        progress=max(0, min(0.99, progress)),
                    )
            return downloaded


download_task_manager = ModelDownloadTaskManager()
