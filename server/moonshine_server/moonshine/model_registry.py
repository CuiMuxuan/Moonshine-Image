import hashlib
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional
from urllib.request import Request, urlopen

from loguru import logger

from moonshine_server.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space


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
    "并放入当前模型目录。也可以私信作者或者加入交流群获取模型文件或百度网盘链接。"
)
SAM_MODEL_MANUAL_SOURCES = [
    {
        "label": "夸克网盘副源",
        "type": "quark",
        "url": MANUAL_MODEL_SOURCE_URL,
    }
]
SAM_MODEL_INSTALL_HINT = (
    "SAM 模型推荐按版本分目录放置：SAM1 放入 sam/，SAM2.1 放入 sam2/，"
    "SAM3/SAM3.1 放入 sam3/。同一版本的不同型号按各自 checkpoint 文件名并列管理；"
    "根目录 checkpoint 不再作为 SAM 模型安装位置识别。"
)
SAM3_LICENSE_HINT = (
    "SAM3/SAM3.1 权重由 Moonshine-Image 模型库提供下载时，仍需保留来源、版本、"
    "hash 与 Meta SAM License 确认记录；运行时只使用本项目模型目录下的本地 checkpoint。"
)
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
        "parameterHelp": "当前模型参数由后端自动控制，无需手动调整。",
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
            "请将 sam_vit_b_01ec64.pth 放入当前模型目录的 sam/ 子目录。"
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
            "请将 sam_vit_l_0b3195.pth 放入当前模型目录的 sam/ 子目录。"
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
            "请将 sam_vit_h_4b8939.pth 放入当前模型目录的 sam/ 子目录。"
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
            "请将 sam2.1_hiera_tiny.pt 放入当前模型目录的 sam2/ 子目录。"
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
            "请将 sam2.1_hiera_small.pt 放入当前模型目录的 sam2/ 子目录。"
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
            "请将 sam2.1_hiera_base_plus.pt 放入当前模型目录的 sam2/ 子目录。"
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
            "请将 sam2.1_hiera_large.pt 放入当前模型目录的 sam2/ 子目录。"
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
        "label": "SAM3 文本智能选区模型",
        "description": "适合用文字查找图片中的目标。输入简短目标名称后自动检索并生成候选蒙版，适合不方便点选或目标较明确的图片选区。",
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
            "请将 sam3.pt 放入当前模型目录的 sam3/ 子目录。"
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
        "parameterHelp": "SAM3 作为后续文本智能选区能力管理，当前不会替代 SAM1 点选/框选。",
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
            "请将 sam3.1_multiplex.pt 放入当前模型目录的 sam3/ 子目录。"
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
            "maskPrompts": ["point", "box", "text"],
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
    path = Path(str(value or "").replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
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
    minimum_vram = model.get("minimumVram")
    if not minimum_vram:
        return True

    recommended_device = str(model.get("recommendedDevice") or "").lower()
    if recommended_device != "cuda":
        return True

    cuda_info = cuda_info or {}
    if not cuda_info.get("cuda_available") or cuda_info.get("cuda_compatible") is False:
        return False

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
    for manifest_item in MODEL_MANIFEST:
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
        installed = len(file_statuses) > 0 and not missing_files and not corrupt_files
        device_compatible = _device_compatible(manifest_item, cuda_info)
        recommended_vram_warning = _recommended_vram_warning(manifest_item, cuda_info)

        item = {
            **manifest_item,
            **_sam_model_capability_metadata(manifest_item),
            "license": manifest_item.get("license") or _model_license_metadata(manifest_item),
            "files": file_statuses,
            "installed": installed,
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
    return next(
        (item for item in MODEL_MANIFEST if item.get("id") == normalized_id),
        None,
    )


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
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)
    completed_at: Optional[float] = None
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
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
            "done": self.status in {"completed", "failed"},
        }


class ModelDownloadTaskManager:
    def __init__(self):
        self._tasks: Dict[str, ModelDownloadTask] = {}
        self._lock = threading.Lock()

    def create_download_task(self, model_id: str, model_dir: Path) -> ModelDownloadTask:
        manifest_item = get_model_manifest(model_id)
        if manifest_item is None:
            raise ValueError(f"Unknown model: {model_id}")
        if not manifest_item.get("downloadable"):
            raise ValueError("该模型不支持软件内下载。")
        if not manifest_item.get("sourceLinks"):
            raise ValueError("暂无下载源。")

        task = ModelDownloadTask(id=uuid.uuid4().hex, model_id=model_id)
        thread = threading.Thread(
            target=self._run_download_task,
            args=(task.id, Path(model_dir).expanduser().resolve()),
            daemon=True,
        )
        task.thread = thread
        with self._lock:
            self._tasks[task.id] = task
        thread.start()
        return task

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

        manifest_item = get_model_manifest(task.model_id)
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
            logger.exception(f"Model download task failed: {task.model_id}")
            self._patch_task(
                task_id,
                status="failed",
                error=str(error),
                message="模型下载失败。",
            )

    def _download_model_files(self, task_id: str, manifest_item: dict, model_dir: Path):
        source_links = manifest_item.get("sourceLinks") or []
        file_specs = manifest_item.get("files") or []
        if len(file_specs) != 1:
            raise ValueError("当前下载器仅支持单文件模型。")

        file_spec = file_specs[0]
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

        last_error = None
        for source in source_links:
            url = source.get("url") if isinstance(source, dict) else str(source)
            if not url:
                continue
            try:
                self._download_url_to_file(task_id, url, part_path)
                expected_sha256 = str(file_spec.get("sha256") or "").strip().lower()
                if expected_sha256:
                    actual_sha256 = _sha256_file(part_path)
                    if actual_sha256 != expected_sha256:
                        raise ValueError("模型文件校验失败，请重新下载。")
                os.replace(part_path, target_path)
                return
            except Exception as error:
                last_error = error
                try:
                    part_path.unlink(missing_ok=True)
                except TypeError:
                    if part_path.exists():
                        part_path.unlink()
                continue

        raise last_error or ValueError("暂无可用下载源。")

    def _download_url_to_file(self, task_id: str, url: str, part_path: Path):
        request = Request(url, headers={"User-Agent": "Moonshine-Image"})
        with urlopen(request, timeout=30) as response:
            total_bytes = response.headers.get("Content-Length")
            total_bytes = int(total_bytes) if total_bytes and total_bytes.isdigit() else None
            self._patch_task(task_id, total_bytes=total_bytes)

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
                    progress = downloaded / total_bytes if total_bytes else 0
                    self._patch_task(
                        task_id,
                        downloaded_bytes=downloaded,
                        progress=max(0, min(0.99, progress)),
                    )


download_task_manager = ModelDownloadTaskManager()
