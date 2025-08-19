import base64
import imghdr
import io
import cv2
import os
import sys
import subprocess
import json
import torch
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional, Dict, Tuple
from urllib.parse import urlparse
from scipy import interpolate
from PIL import Image, ImageOps, PngImagePlugin
import numpy as np
from iopaint.const import MPS_UNSUPPORT_MODELS
from loguru import logger
from torch.hub import download_url_to_file, get_dir
import hashlib
from iopaint.schema import VideoMask, VideoMaskOffset, VideoProcessingConfig


def md5sum(filename):
    md5 = hashlib.md5()
    with open(filename, "rb") as f:
        for chunk in iter(lambda: f.read(128 * md5.block_size), b""):
            md5.update(chunk)
    return md5.hexdigest()


def switch_mps_device(model_name, device):
    if model_name in MPS_UNSUPPORT_MODELS and str(device) == "mps":
        logger.info(f"{model_name} not support mps, switch to cpu")
        return torch.device("cpu")
    return device


def get_cache_path_by_url(url):
    parts = urlparse(url)
    hub_dir = get_dir()
    model_dir = os.path.join(hub_dir, "checkpoints")
    if not os.path.isdir(model_dir):
        os.makedirs(model_dir)
    filename = os.path.basename(parts.path)
    cached_file = os.path.join(model_dir, filename)
    return cached_file


def download_model(url, model_md5: str = None):
    if os.path.exists(url):
        cached_file = url
    else:
        cached_file = get_cache_path_by_url(url)
    if not os.path.exists(cached_file):
        sys.stderr.write('Downloading: "{}" to {}\n'.format(url, cached_file))
        hash_prefix = None
        download_url_to_file(url, cached_file, hash_prefix, progress=True)
        if model_md5:
            _md5 = md5sum(cached_file)
            if model_md5 == _md5:
                logger.info(f"Download model success, md5: {_md5}")
            else:
                try:
                    os.remove(cached_file)
                    logger.error(
                        f"Model md5: {_md5}, expected md5: {model_md5}, wrong model deleted. Please restart iopaint."
                        f"If you still have errors, please try download model manually first https://lama-cleaner-docs.vercel.app/install/download_model_manually.\n"
                    )
                except:
                    logger.error(
                        f"Model md5: {_md5}, expected md5: {model_md5}, please delete {cached_file} and restart iopaint."
                    )
                exit(-1)

    return cached_file


def ceil_modulo(x, mod):
    if x % mod == 0:
        return x
    return (x // mod + 1) * mod


def handle_error(model_path, model_md5, e):
    _md5 = md5sum(model_path)
    if _md5 != model_md5:
        try:
            os.remove(model_path)
            logger.error(
                f"Model md5: {_md5}, expected md5: {model_md5}, wrong model deleted. Please restart iopaint."
                f"If you still have errors, please try download model manually first https://lama-cleaner-docs.vercel.app/install/download_model_manually.\n"
            )
        except:
            logger.error(
                f"Model md5: {_md5}, expected md5: {model_md5}, please delete {model_path} and restart iopaint."
            )
    else:
        logger.error(
            f"Failed to load model {model_path},"
            f"please submit an issue at https://github.com/Sanster/lama-cleaner/issues and include a screenshot of the error:\n{e}"
        )
    exit(-1)


def load_jit_model(url_or_path, device, model_md5: str):
    if os.path.exists(url_or_path):
        model_path = url_or_path
    else:
        model_path = download_model(url_or_path, model_md5)

    logger.info(f"Loading model from: {model_path}")
    try:
        model = torch.jit.load(model_path, map_location="cpu").to(device)
    except Exception as e:
        handle_error(model_path, model_md5, e)
    model.eval()
    return model


def load_model(model: torch.nn.Module, url_or_path, device, model_md5):
    if os.path.exists(url_or_path):
        model_path = url_or_path
    else:
        model_path = download_model(url_or_path, model_md5)

    try:
        logger.info(f"Loading model from: {model_path}")
        state_dict = torch.load(model_path, map_location="cpu")
        model.load_state_dict(state_dict, strict=True)
        model.to(device)
    except Exception as e:
        handle_error(model_path, model_md5, e)
    model.eval()
    return model


def numpy_to_bytes(image_numpy: np.ndarray, ext: str) -> bytes:
    data = cv2.imencode(
        f".{ext}",
        image_numpy,
        [int(cv2.IMWRITE_JPEG_QUALITY), 100, int(cv2.IMWRITE_PNG_COMPRESSION), 0],
    )[1]
    image_bytes = data.tobytes()
    return image_bytes


def pil_to_bytes(pil_img, ext: str, quality: int = 95, infos={}) -> bytes:
    with io.BytesIO() as output:
        kwargs = {k: v for k, v in infos.items() if v is not None}
        if ext == "jpg":
            ext = "jpeg"
        if "png" == ext.lower() and "parameters" in kwargs:
            pnginfo_data = PngImagePlugin.PngInfo()
            pnginfo_data.add_text("parameters", kwargs["parameters"])
            kwargs["pnginfo"] = pnginfo_data

        pil_img.save(output, format=ext, quality=quality, **kwargs)
        image_bytes = output.getvalue()
    return image_bytes


def load_img(img_bytes, gray: bool = False, return_info: bool = False):
    alpha_channel = None
    image = Image.open(io.BytesIO(img_bytes))

    if return_info:
        infos = image.info

    try:
        image = ImageOps.exif_transpose(image)
    except:
        pass

    if gray:
        image = image.convert("L")
        np_img = np.array(image)
    else:
        if image.mode == "RGBA":
            np_img = np.array(image)
            alpha_channel = np_img[:, :, -1]
            np_img = cv2.cvtColor(np_img, cv2.COLOR_RGBA2RGB)
        else:
            image = image.convert("RGB")
            np_img = np.array(image)

    if return_info:
        return np_img, alpha_channel, infos
    return np_img, alpha_channel


def norm_img(np_img):
    if len(np_img.shape) == 2:
        np_img = np_img[:, :, np.newaxis]
    np_img = np.transpose(np_img, (2, 0, 1))
    np_img = np_img.astype("float32") / 255
    return np_img


def resize_max_size(
    np_img, size_limit: int, interpolation=cv2.INTER_CUBIC
) -> np.ndarray:
    # Resize image's longer size to size_limit if longer size larger than size_limit
    h, w = np_img.shape[:2]
    if max(h, w) > size_limit:
        ratio = size_limit / max(h, w)
        new_w = int(w * ratio + 0.5)
        new_h = int(h * ratio + 0.5)
        return cv2.resize(np_img, dsize=(new_w, new_h), interpolation=interpolation)
    else:
        return np_img


def pad_img_to_modulo(
    img: np.ndarray, mod: int, square: bool = False, min_size: Optional[int] = None
):
    """

    Args:
        img: [H, W, C]
        mod:
        square: 是否为正方形
        min_size:

    Returns:

    """
    if len(img.shape) == 2:
        img = img[:, :, np.newaxis]
    height, width = img.shape[:2]
    out_height = ceil_modulo(height, mod)
    out_width = ceil_modulo(width, mod)

    if min_size is not None:
        assert min_size % mod == 0
        out_width = max(min_size, out_width)
        out_height = max(min_size, out_height)

    if square:
        max_size = max(out_height, out_width)
        out_height = max_size
        out_width = max_size

    return np.pad(
        img,
        ((0, out_height - height), (0, out_width - width), (0, 0)),
        mode="symmetric",
    )


def boxes_from_mask(mask: np.ndarray) -> List[np.ndarray]:
    """
    Args:
        mask: (h, w, 1)  0~255

    Returns:

    """
    height, width = mask.shape[:2]
    _, thresh = cv2.threshold(mask, 127, 255, 0)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        box = np.array([x, y, x + w, y + h]).astype(int)

        box[::2] = np.clip(box[::2], 0, width)
        box[1::2] = np.clip(box[1::2], 0, height)
        boxes.append(box)

    return boxes


def only_keep_largest_contour(mask: np.ndarray) -> List[np.ndarray]:
    """
    Args:
        mask: (h, w)  0~255

    Returns:

    """
    _, thresh = cv2.threshold(mask, 127, 255, 0)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    max_area = 0
    max_index = -1
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if area > max_area:
            max_area = area
            max_index = i

    if max_index != -1:
        new_mask = np.zeros_like(mask)
        return cv2.drawContours(new_mask, contours, max_index, 255, -1)
    else:
        return mask


def is_mac():
    return sys.platform == "darwin"


def get_image_ext(img_bytes):
    w = imghdr.what("", img_bytes)
    if w is None:
        w = "jpeg"
    return w


def decode_base64_to_image(
    encoding: str, gray=False
) -> Tuple[np.array, Optional[np.array], Dict]:
    if encoding.startswith("data:image/") or encoding.startswith(
        "data:application/octet-stream;base64,"
    ):
        encoding = encoding.split(";")[1].split(",")[1]
    image = Image.open(io.BytesIO(base64.b64decode(encoding)))

    alpha_channel = None
    try:
        image = ImageOps.exif_transpose(image)
    except:
        pass
    # exif_transpose will remove exif rotate info，we must call image.info after exif_transpose
    infos = image.info

    if gray:
        image = image.convert("L")
        np_img = np.array(image)
    else:
        if image.mode == "RGBA":
            np_img = np.array(image)
            alpha_channel = np_img[:, :, -1]
            np_img = cv2.cvtColor(np_img, cv2.COLOR_RGBA2RGB)
        else:
            image = image.convert("RGB")
            np_img = np.array(image)

    return np_img, alpha_channel, infos


def encode_pil_to_base64(image: Image, quality: int, infos: Dict) -> bytes:
    img_bytes = pil_to_bytes(
        image,
        "png",
        quality=quality,
        infos=infos,
    )
    return base64.b64encode(img_bytes)


def concat_alpha_channel(rgb_np_img, alpha_channel) -> np.ndarray:
    if alpha_channel is not None:
        if alpha_channel.shape[:2] != rgb_np_img.shape[:2]:
            alpha_channel = cv2.resize(
                alpha_channel, dsize=(rgb_np_img.shape[1], rgb_np_img.shape[0])
            )
        rgb_np_img = np.concatenate(
            (rgb_np_img, alpha_channel[:, :, np.newaxis]), axis=-1
        )
    return rgb_np_img


def adjust_mask(mask: np.ndarray, kernel_size: int, operate):
    # fronted brush color "ffcc00bb"
    # kernel_size = kernel_size*2+1
    mask[mask >= 127] = 255
    mask[mask < 127] = 0

    if operate == "reverse":
        mask = 255 - mask
    else:
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * kernel_size + 1, 2 * kernel_size + 1)
        )
        if operate == "expand":
            mask = cv2.dilate(
                mask,
                kernel,
                iterations=1,
            )
        else:
            mask = cv2.erode(
                mask,
                kernel,
                iterations=1,
            )
    res_mask = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    res_mask[mask > 128] = [255, 203, 0, int(255 * 0.73)]
    res_mask = cv2.cvtColor(res_mask, cv2.COLOR_BGRA2RGBA)
    return res_mask


def gen_frontend_mask(bgr_or_gray_mask):
    if len(bgr_or_gray_mask.shape) == 3 and bgr_or_gray_mask.shape[2] != 1:
        bgr_or_gray_mask = cv2.cvtColor(bgr_or_gray_mask, cv2.COLOR_BGR2GRAY)

    # fronted brush color "ffcc00bb"
    # TODO: how to set kernel size?
    kernel_size = 9
    bgr_or_gray_mask = cv2.dilate(
        bgr_or_gray_mask,
        np.ones((kernel_size, kernel_size), np.uint8),
        iterations=1,
    )
    res_mask = np.zeros(
        (bgr_or_gray_mask.shape[0], bgr_or_gray_mask.shape[1], 4), dtype=np.uint8
    )
    res_mask[bgr_or_gray_mask > 128] = [255, 203, 0, int(255 * 0.73)]
    res_mask = cv2.cvtColor(res_mask, cv2.COLOR_BGRA2RGBA)
    return res_mask
def decode_path_to_image(
    image_path: str, gray=False
) -> Tuple[np.array, Optional[np.array], Dict]:
    """
    从文件路径加载图像
    
    Args:
        image_path: 图像文件路径
        gray: 是否转换为灰度图
        
    Returns:
        Tuple of (numpy array, alpha channel, image info dict)
    """
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image file not found: {image_path}")
    
    with open(image_path, 'rb') as f:
        img_bytes = f.read()
    
    return load_img(img_bytes, gray=gray, return_info=True)

def save_image_to_path(
    image_array: np.ndarray, 
    output_path: str, 
    quality: int = 95, 
    infos: Dict = None,
    alpha_channel: Optional[np.ndarray] = None
) -> str:
    """
    保存图像数组到指定路径
    
    Args:
        image_array: 图像numpy数组
        output_path: 输出文件路径
        quality: 图像质量 (1-100)
        infos: 图像信息字典
        alpha_channel: Alpha通道数据
        
    Returns:
        保存的文件路径
    """
    # 确保输出目录存在
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    # 添加alpha通道
    if alpha_channel is not None:
        image_array = concat_alpha_channel(image_array, alpha_channel)
    
    # 转换为PIL图像
    if image_array.shape[-1] == 4:  # RGBA
        pil_image = Image.fromarray(image_array, 'RGBA')
        ext = 'png'  # RGBA需要使用PNG格式
    else:  # RGB
        pil_image = Image.fromarray(image_array, 'RGB')
        ext = os.path.splitext(output_path)[1][1:].lower() or 'jpg'
    
    # 如果没有扩展名，添加默认扩展名
    if not os.path.splitext(output_path)[1]:
        output_path = f"{output_path}.{ext}"
    
    # 保存图像
    infos = infos or {}
    image_bytes = pil_to_bytes(pil_image, ext, quality=quality, infos=infos)
    
    with open(output_path, 'wb') as f:
        f.write(image_bytes)
    
    return output_path


def extract_video_info(video_path: str) -> Dict:
    """提取视频信息"""
    cmd = [
        'ffprobe', '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', video_path
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Failed to extract video info: {e}")

def extract_audio(video_path: str, audio_path: str) -> bool:
    """提取音频"""
    cmd = [
        'ffmpeg', '-i', video_path, '-vn', '-acodec', 'copy',
        '-y', audio_path
    ]
    
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        return True
    except subprocess.CalledProcessError:
        logger.warning(f"No audio track found in {video_path}")
        return False

def extract_frames(video_path: str, output_dir: str, frame_format: str = "png") -> Tuple[List[str], float]:
    """提取视频帧"""
    os.makedirs(output_dir, exist_ok=True)
    
    # 获取视频信息
    video_info = extract_video_info(video_path)
    video_stream = next(s for s in video_info['streams'] if s['codec_type'] == 'video')
    fps = eval(video_stream['r_frame_rate'])  # 例如 "30/1" -> 30.0
    
    # 提取帧
    frame_pattern = os.path.join(output_dir, f"frame_%06d.{frame_format}")
    cmd = [
        'ffmpeg', '-i', video_path, '-vf', 'fps=fps=source',
        '-y', frame_pattern
    ]
    
    try:
        subprocess.run(cmd, capture_output=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Failed to extract frames: {e}")
    
    # 获取生成的帧文件列表
    frame_files = sorted([f for f in os.listdir(output_dir) if f.startswith('frame_')])
    frame_paths = [os.path.join(output_dir, f) for f in frame_files]
    
    return frame_paths, fps

def interpolate_mask_offset(mask: VideoMask, frame_index: int) -> VideoMaskOffset:
    """插值计算指定帧的蒙版偏移"""
    if not mask.interpolate_offsets or not mask.offsets:
        return VideoMaskOffset(frame_index=frame_index)
    
    # 如果有精确匹配的偏移，直接返回
    for offset in mask.offsets:
        if offset.frame_index == frame_index:
            return offset
    
    # 找到前后最近的偏移进行插值
    before_offsets = [o for o in mask.offsets if o.frame_index <= frame_index]
    after_offsets = [o for o in mask.offsets if o.frame_index >= frame_index]
    
    if not before_offsets and not after_offsets:
        return VideoMaskOffset(frame_index=frame_index)
    
    if not before_offsets:
        return after_offsets[0]
    
    if not after_offsets:
        return before_offsets[-1]
    
    before = before_offsets[-1]
    after = after_offsets[0]
    
    if before.frame_index == after.frame_index:
        return before
    
    # 线性插值
    ratio = (frame_index - before.frame_index) / (after.frame_index - before.frame_index)
    
    return VideoMaskOffset(
        frame_index=frame_index,
        offset_x=int(before.offset_x + (after.offset_x - before.offset_x) * ratio),
        offset_y=int(before.offset_y + (after.offset_y - before.offset_y) * ratio),
        scale_x=before.scale_x + (after.scale_x - before.scale_x) * ratio,
        scale_y=before.scale_y + (after.scale_y - before.scale_y) * ratio,
        rotation=before.rotation + (after.rotation - before.rotation) * ratio,
        opacity=before.opacity + (after.opacity - before.opacity) * ratio
    )

def apply_mask_transform(mask_array: np.ndarray, offset: VideoMaskOffset, frame_shape: Tuple[int, int]) -> np.ndarray:
    """应用蒙版变换（偏移、缩放、旋转）"""
    h, w = frame_shape
    mask_h, mask_w = mask_array.shape[:2]
    
    # 创建变换矩阵
    center_x, center_y = mask_w // 2, mask_h // 2
    
    # 缩放和旋转
    M = cv2.getRotationMatrix2D((center_x, center_y), offset.rotation, 1.0)
    M[0, 0] *= offset.scale_x
    M[0, 1] *= offset.scale_x
    M[1, 0] *= offset.scale_y
    M[1, 1] *= offset.scale_y
    
    # 添加平移
    M[0, 2] += offset.offset_x
    M[1, 2] += offset.offset_y
    
    # 应用变换
    transformed_mask = cv2.warpAffine(mask_array, M, (w, h))
    
    # 应用透明度
    if offset.opacity < 1.0:
        transformed_mask = (transformed_mask * offset.opacity).astype(np.uint8)
    
    return transformed_mask

def get_frame_masks(frame_index: int, masks: List[VideoMask], frame_shape: Tuple[int, int]) -> List[np.ndarray]:
    """获取指定帧的所有有效蒙版"""
    frame_masks = []
    
    for mask in masks:
        # 检查蒙版是否在当前帧的范围内
        if mask.start_frame <= frame_index <= mask.end_frame:
            # 加载蒙版数据
            if mask.mask_type == "base64":
                mask_array, _, _ = decode_base64_to_image(mask.mask_data, gray=True)
            else:
                mask_array, _, _ = decode_path_to_image(mask.mask_data, gray=True)
            
            # 计算当前帧的偏移
            offset = interpolate_mask_offset(mask, frame_index)
            
            # 应用变换
            transformed_mask = apply_mask_transform(mask_array, offset, frame_shape)
            frame_masks.append(transformed_mask)
    
    return frame_masks

def combine_masks(masks: List[np.ndarray]) -> Optional[np.ndarray]:
    """合并多个蒙版"""
    if not masks:
        return None
    
    if len(masks) == 1:
        return masks[0]
    
    # 使用逻辑或操作合并蒙版
    combined = masks[0].copy()
    for mask in masks[1:]:
        combined = cv2.bitwise_or(combined, mask)
    
    return combined

def reassemble_video(frame_dir: str, audio_path: str, output_path: str, fps: float, config: VideoProcessingConfig):
    """重新组装视频"""
    frame_pattern = os.path.join(frame_dir, "processed_frame_%06d.png")
    
    # 构建ffmpeg命令
    cmd = [
        'ffmpeg', '-framerate', str(fps),
        '-i', frame_pattern,
        '-c:v', config.video_codec,
        '-crf', str(config.quality)
    ]
    
    # 如果有音频文件，添加音频
    if os.path.exists(audio_path) and config.preserve_audio:
        cmd.extend(['-i', audio_path, '-c:a', config.audio_codec, '-shortest'])
    
    cmd.extend(['-y', output_path])
    
    try:
        subprocess.run(cmd, capture_output=True, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"Failed to reassemble video: {e}")