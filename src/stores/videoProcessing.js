import { defineStore } from "pinia";
import VideoProcessingService from "src/services/VideoProcessingService";

const videoService = new VideoProcessingService();

export const useVideoProcessingStore = defineStore("videoProcessing", {
  state: () => ({
    // 视频基础信息
    currentVideo: null,
    videoInfo: {
      duration: 0,
      width: 0,
      height: 0,
      frameRate: 30,
      totalFrames: 0,
    },

    // 播放控制
    currentTime: 0,
    currentFrame: 0,
    isPlaying: false,

    // 蒙版管理
    masks: new Map(), // maskId -> VideoMask
    activeMaskId: null,
    maskHistory: [], // 操作历史

    // 处理状态
    isProcessing: false,
    processingProgress: {
      stage: "",
      progress: 0,
      details: "",
    },
    processedVideoPath: null,

    // 配置
    processingConfig: {
      fps: null,
      quality: 23,
      audio_codec: "aac",
      video_codec: "libx264",
      preserve_audio: true,
      temp_cleanup: true,
      max_workers: 4,
      frame_format: "png",
    },
  }),

  getters: {
    activeMask: (state) => state.masks.get(state.activeMaskId),

    masksForCurrentFrame: (state) => {
      return Array.from(state.masks.values()).filter(
        (mask) =>
          mask.start_frame <= state.currentFrame &&
          mask.end_frame >= state.currentFrame
      );
    },

    hasUnsavedChanges: (state) => {
      return state.maskHistory.some((item) => !item.saved);
    },

    maskArray: (state) => Array.from(state.masks.values()),

    canProcess: (state) => {
      return state.currentVideo && state.masks.size > 0 && !state.isProcessing;
    },
  },

  actions: {
    // 视频操作
    async loadVideo(file) {
      this.currentVideo = file;

      // 重置状态
      this.currentTime = 0;
      this.currentFrame = 0;
      this.masks.clear();
      this.activeMaskId = null;
      this.maskHistory = [];

      // 获取视频信息
      try {
        const videoElement = document.createElement("video");
        videoElement.src = URL.createObjectURL(file);

        await new Promise((resolve) => {
          videoElement.onloadedmetadata = () => {
            this.videoInfo = {
              duration: videoElement.duration,
              width: videoElement.videoWidth,
              height: videoElement.videoHeight,
              frameRate: 30, // 默认值，可以通过其他方式获取
              totalFrames: Math.floor(videoElement.duration * 30),
            };
            URL.revokeObjectURL(videoElement.src);
            resolve();
          };
        });
      } catch (error) {
        console.error("加载视频信息失败:", error);
        throw error;
      }
    },

    setCurrentFrame(frame) {
      this.currentFrame = Math.max(
        0,
        Math.min(frame, this.videoInfo.totalFrames - 1)
      );
      this.currentTime = this.currentFrame / this.videoInfo.frameRate;
    },

    setCurrentTime(time) {
      this.currentTime = Math.max(0, Math.min(time, this.videoInfo.duration));
      this.currentFrame = Math.floor(
        this.currentTime * this.videoInfo.frameRate
      );
    },

    // 蒙版操作
    addMask(maskData) {
      const mask = {
        id: maskData.id || Date.now(),
        name: maskData.name || `蒙版 ${this.masks.size + 1}`,
        start_frame: maskData.start_frame || this.currentFrame,
        end_frame: maskData.end_frame || this.currentFrame + 30,
        mask_data: maskData.mask_data || null,
        mask_type: maskData.mask_type || "user-drawn",
        interpolate_offsets: maskData.interpolate_offsets !== false,
        offsets: maskData.offsets || [],
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      this.masks.set(mask.id, mask);
      this.activeMaskId = mask.id;

      // 添加到历史记录
      this.maskHistory.push({
        type: "add",
        maskId: mask.id,
        data: { ...mask },
        timestamp: Date.now(),
        saved: false,
      });

      return mask.id;
    },

    updateMask(maskId, updates) {
      const mask = this.masks.get(maskId);
      if (!mask) return false;

      const oldData = { ...mask };
      Object.assign(mask, updates, { updated_at: Date.now() });

      // 添加到历史记录
      this.maskHistory.push({
        type: "update",
        maskId,
        oldData,
        newData: { ...mask },
        timestamp: Date.now(),
        saved: false,
      });

      return true;
    },

    deleteMask(maskId) {
      const mask = this.masks.get(maskId);
      if (!mask) return false;

      this.masks.delete(maskId);

      if (this.activeMaskId === maskId) {
        this.activeMaskId =
          this.masks.size > 0 ? this.masks.keys().next().value : null;
      }

      // 添加到历史记录
      this.maskHistory.push({
        type: "delete",
        maskId,
        data: mask,
        timestamp: Date.now(),
        saved: false,
      });

      return true;
    },

    setActiveMask(maskId) {
      if (this.masks.has(maskId)) {
        this.activeMaskId = maskId;
        return true;
      }
      return false;
    },

    // 蒙版变换操作
    addMaskOffset(maskId, frame, offset) {
      const mask = this.masks.get(maskId);
      if (!mask) return false;

      // 检查是否已存在该帧的偏移
      const existingIndex = mask.offsets.findIndex(
        (o) => o.frame_index === frame
      );

      const offsetData = {
        frame_index: frame,
        offset_x: offset.offset_x || 0,
        offset_y: offset.offset_y || 0,
        scale_x: offset.scale_x || 1,
        scale_y: offset.scale_y || 1,
        rotation: offset.rotation || 0,
        opacity: offset.opacity || 1,
      };

      if (existingIndex >= 0) {
        mask.offsets[existingIndex] = offsetData;
      } else {
        mask.offsets.push(offsetData);
        mask.offsets.sort((a, b) => a.frame_index - b.frame_index);
      }

      mask.updated_at = Date.now();
      return true;
    },

    removeMaskOffset(maskId, frame) {
      const mask = this.masks.get(maskId);
      if (!mask) return false;

      const index = mask.offsets.findIndex((o) => o.frame_index === frame);
      if (index >= 0) {
        mask.offsets.splice(index, 1);
        mask.updated_at = Date.now();
        return true;
      }
      return false;
    },

    // 处理操作
    async processVideo() {
      if (!this.currentVideo || this.masks.size === 0) {
        throw new Error("缺少视频文件或蒙版");
      }

      this.isProcessing = true;
      this.processingProgress = {
        stage: "准备处理...",
        progress: 0,
        details: "正在初始化处理参数",
      };

      try {
        // 转换蒙版格式
        const masks = Array.from(this.masks.values());

        // 调用处理服务
        const result = await videoService.processVideo(
          this.currentVideo,
          masks,
          this.processingConfig,
          (progress) => {
            this.processingProgress = {
              stage: progress.stage || "处理中...",
              progress: progress.progress || 0,
              details: progress.details || "",
            };
          }
        );

        this.processedVideoPath = result.output_path;
        this.processingProgress = {
          stage: "处理完成",
          progress: 100,
          details: "视频处理成功完成",
        };

        return result;
      } catch (error) {
        this.processingProgress = {
          stage: "处理失败",
          progress: 0,
          details: error.message,
        };
        throw error;
      } finally {
        this.isProcessing = false;
      }
    },

    cancelProcessing() {
      if (this.isProcessing) {
        // TODO: 实现取消逻辑
        this.isProcessing = false;
        this.processingProgress = {
          stage: "已取消",
          progress: 0,
          details: "用户取消了处理操作",
        };
      }
    },

    // 历史记录操作
    markHistoryAsSaved() {
      this.maskHistory.forEach((item) => {
        item.saved = true;
      });
    },

    clearHistory() {
      this.maskHistory = [];
    },

    // 重置状态
    reset() {
      this.currentVideo = null;
      this.videoInfo = {
        duration: 0,
        width: 0,
        height: 0,
        frameRate: 30,
        totalFrames: 0,
      };
      this.currentTime = 0;
      this.currentFrame = 0;
      this.isPlaying = false;
      this.masks.clear();
      this.activeMaskId = null;
      this.maskHistory = [];
      this.isProcessing = false;
      this.processedVideoPath = null;
    },
  },
});
