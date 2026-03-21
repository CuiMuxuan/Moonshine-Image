import { api } from "src/boot/axios";

const formatError = (error, fallback = "视频处理失败") => {
  if (error?.response?.data?.detail) return String(error.response.data.detail);
  if (error?.response?.data?.message) return String(error.response.data.message);
  if (error?.response?.data?.error) return String(error.response.data.error);
  return error?.message || fallback;
};

export const submitVideoBatchInpaint = async (request) => {
  try {
    return await api.post("/api/v1/video_batch_inpaint", request, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    throw new Error(formatError(error));
  }
};

export default {
  submitVideoBatchInpaint,
};
