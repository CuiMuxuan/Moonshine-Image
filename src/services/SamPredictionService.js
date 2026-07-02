import { api } from "src/boot/axios";
import { classifyMoonshineError } from "src/services/ErrorClassifier";

const normalizeImagePayload = (image, imageType = "base64") => {
  if (!image || typeof image !== "string") {
    throw new Error("图片数据不能为空");
  }
  if (imageType === "path") {
    return image;
  }
  if (image.startsWith("data:image/")) {
    return image.split(",")[1] || "";
  }
  return image;
};

const normalizePoints = (points = []) =>
  points.map((point) => ({
    x: Math.max(0, Number(point.x) || 0),
    y: Math.max(0, Number(point.y) || 0),
    label: Number(point.label ?? 1) === 0 ? 0 : 1,
  }));

const normalizeBox = (box) => {
  if (!box) return null;
  return {
    x: Math.max(0, Number(box.x) || 0),
    y: Math.max(0, Number(box.y) || 0),
    width: Math.max(1, Number(box.width) || 1),
    height: Math.max(1, Number(box.height) || 1),
  };
};

const validateSamRequest = (request = {}) => {
  const points = Array.isArray(request.points) ? request.points : [];
  if (!request.image) {
    throw new Error("图片数据不能为空");
  }
  if (!points.length && !request.box) {
    throw new Error("请先添加点选或框选提示");
  }
};

const buildSamVideoPayload = (request = {}) => {
  const inputType = request.input_type || request.inputType || "jpegFrameDirectory";
  const objects = Array.isArray(request.objects)
    ? request.objects.map((item, index) => ({
        object_id: Number(item.object_id ?? item.objectId ?? index + 1),
        points: normalizePoints(item.points),
        box: normalizeBox(item.box),
      }))
    : [];
  return {
    input_type: inputType,
    frame_dir: request.frame_dir || request.frameDir,
    video_path: request.video_path || request.videoPath,
    model_id: request.model_id || request.modelId || "sam2_1_hiera_large",
    frame_index: Number(request.frame_index ?? request.frameIndex ?? 0),
    object_id: Number(request.object_id ?? request.objectId ?? 1),
    points: normalizePoints(request.points),
    box: normalizeBox(request.box),
    objects,
    max_frames: request.max_frames ?? request.maxFrames ?? null,
    reverse: Boolean(request.reverse),
    offload_video_to_cpu:
      request.offload_video_to_cpu ?? request.offloadVideoToCpu ?? true,
    offload_state_to_cpu:
      request.offload_state_to_cpu ?? request.offloadStateToCpu ?? true,
    response_type: request.response_type || request.responseType || "base64",
    mask_output_dir: request.mask_output_dir || request.maskOutputDir || null,
  };
};

export const predictSamMask = async (request = {}) => {
  try {
    validateSamRequest(request);
    const imageType = request.image_type || request.imageType || "base64";
    const payload = {
      image: normalizeImagePayload(request.image, imageType),
      image_type: imageType,
      model_id: request.model_id || request.modelId || "sam_vit_b",
      points: normalizePoints(request.points),
      box: normalizeBox(request.box),
      multimask_output: request.multimask_output ?? request.multimaskOutput ?? true,
    };

    return await api.post("/api/v1/moonshine/sam/predict", payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "SAM 智能选区失败").message);
    }
    throw error;
  }
};

export const getSamCapabilities = async () => {
  try {
    return await api.get("/api/v1/moonshine/sam/capabilities");
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "读取 SAM 能力失败").message);
    }
    throw error;
  }
};

export const propagateSamVideo = async (request = {}) => {
  try {
    const payload = buildSamVideoPayload(request);
    return await api.post("/api/v1/moonshine/sam/video/propagate", payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "SAM2.1 视频传播失败").message);
    }
    throw error;
  }
};

export const createSamVideoPropagationJob = async (request = {}) => {
  try {
    return await api.post(
      "/api/v1/moonshine/sam/video/propagate/jobs",
      buildSamVideoPayload(request),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "启动 SAM2.1 视频传播任务失败").message);
    }
    throw error;
  }
};

export const getSamVideoPropagationJob = async (taskId) => {
  try {
    return await api.get(`/api/v1/moonshine/sam/video/propagate/jobs/${encodeURIComponent(taskId)}`);
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "读取 SAM2.1 视频传播进度失败").message);
    }
    throw error;
  }
};

export const getSamVideoPropagationJobResult = async (taskId) => {
  try {
    return await api.get(
      `/api/v1/moonshine/sam/video/propagate/jobs/${encodeURIComponent(taskId)}/result`
    );
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "读取 SAM2.1 视频传播结果失败").message);
    }
    throw error;
  }
};

export const cancelSamVideoPropagationJob = async (taskId) => {
  try {
    return await api.post(
      `/api/v1/moonshine/sam/video/propagate/jobs/${encodeURIComponent(taskId)}/cancel`
    );
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "取消 SAM2.1 视频传播任务失败").message);
    }
    throw error;
  }
};

export const predictSamText = async (request = {}) => {
  try {
    const imageType = request.image_type || request.imageType || "base64";
    const payload = {
      image: normalizeImagePayload(request.image, imageType),
      image_type: imageType,
      model_id: request.model_id || request.modelId || "sam3",
      text: String(request.text || "").trim(),
      language: request.language || "auto",
      prompt_source: request.prompt_source || request.promptSource || "manual",
      prompt_color: request.prompt_color || request.promptColor || null,
      prompt_noun: request.prompt_noun || request.promptNoun || null,
    };
    return await api.post("/api/v1/moonshine/sam/text/predict", payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error.response || error.request) {
      throw new Error(classifyMoonshineError(error, "SAM3 文本智能选区失败").message);
    }
    throw error;
  }
};

export default {
  getSamCapabilities,
  predictSamText,
  predictSamMask,
  propagateSamVideo,
  createSamVideoPropagationJob,
  getSamVideoPropagationJob,
  getSamVideoPropagationJobResult,
  cancelSamVideoPropagationJob,
};
