import axios from "axios";

class VideoProcessingService {
  constructor() {
    this.baseURL = "http://localhost:8080"; // 根据实际后端地址调整
  }

  async processVideo(videoFile, masks, config, progressCallback) {
    try {
      // 创建FormData
      const formData = new FormData();
      formData.append("video", videoFile);

      // 构建请求数据
      const request = {
        output_path: this.generateOutputPath(videoFile.name),
        temp_path: this.generateTempPath(),
        masks: this.convertMasksToBackendFormat(masks),
        processing_config: {
          fps: config.fps || null,
          quality: config.quality || 23,
          audio_codec: config.audio_codec || "aac",
          video_codec: config.video_codec || "libx264",
          preserve_audio: config.preserve_audio !== false,
          temp_cleanup: config.temp_cleanup !== false,
          max_workers: config.max_workers || 4,
          frame_format: config.frame_format || "png",
        },
        prompt: config.prompt || "",
        negative_prompt: config.negative_prompt || "",
        sd_steps: config.sd_steps || 20,
        sd_guidance_scale: config.sd_guidance_scale || 7.5,
        sd_strength: config.sd_strength || 0.8,
        sd_seed: config.sd_seed || -1,
      };

      formData.append("request", JSON.stringify(request));

      // 发送请求
      const response = await axios.post(
        `${this.baseURL}/api/video_inpaint`,
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
          onUploadProgress: (progressEvent) => {
            if (progressCallback) {
              const progress = Math.round(
                (progressEvent.loaded * 100) / progressEvent.total
              );
              progressCallback({
                stage: "上传视频文件",
                progress: Math.min(progress, 10), // 上传占总进度的10%
                details: `已上传 ${this.formatBytes(
                  progressEvent.loaded
                )} / ${this.formatBytes(progressEvent.total)}`,
              });
            }
          },
        }
      );

      // 处理响应
      if (response.data.success) {
        return response.data;
      } else {
        throw new Error(response.data.message || "视频处理失败");
      }
    } catch (error) {
      console.error("视频处理错误:", error);
      throw new Error(
        error.response?.data?.message || error.message || "视频处理失败"
      );
    }
  }

  async checkProcessingStatus(taskId, progressCallback) {
    try {
      const response = await axios.get(
        `${this.baseURL}/api/video_inpaint/status/${taskId}`
      );

      if (progressCallback && response.data.progress) {
        progressCallback(response.data.progress);
      }

      return response.data;
    } catch (error) {
      console.error("检查处理状态失败:", error);
      throw error;
    }
  }

  async cancelProcessing(taskId) {
    try {
      const response = await axios.post(
        `${this.baseURL}/api/video_inpaint/cancel/${taskId}`
      );
      return response.data;
    } catch (error) {
      console.error("取消处理失败:", error);
      throw error;
    }
  }

  convertMasksToBackendFormat(masks) {
    return masks.map((mask) => ({
      id: mask.id.toString(), // 确保ID是字符串
      mask_data: mask.mask_data || "", // 蒙版数据
      mask_type: mask.mask_type || "base64", // 默认base64类型
      start_frame: mask.start_frame,
      end_frame: mask.end_frame,
      interpolate_offsets: mask.interpolate_offsets !== false,
      offsets: (mask.offsets || []).map((offset) => ({
        frame_index: offset.frame_index,
        offset_x: offset.offset_x || 0,
        offset_y: offset.offset_y || 0,
        scale_x: offset.scale_x || 1.0,
        scale_y: offset.scale_y || 1.0,
        rotation: offset.rotation || 0.0,
        opacity: offset.opacity || 1.0,
      })),
    }));
  }

  generateOutputPath(videoFileName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const nameWithoutExt = videoFileName.replace(/\.[^/.]+$/, "");
    return `${nameWithoutExt}_processed_${timestamp}.mp4`;
  }

  generateTempPath() {
    const timestamp = Date.now();
    return `temp_video_${timestamp}`;
  }

  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }
}

export default VideoProcessingService;
