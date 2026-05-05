import { api } from "src/boot/axios";
import { classifyMoonshineError } from "src/services/ErrorClassifier";

const formatError = (error, fallback = "视频处理失败") => {
  return classifyMoonshineError(error, fallback).message;
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
