import { defineStore } from "pinia";
import { ref, computed } from "vue";

export const useVideoHandleManager = defineStore("videoHandleManager", () => {
  // 状态
  const maskList = ref([]);
  const activeMaskId = ref(null);
  const currentTime = ref(0);
  const duration = ref(0);
  const isPlaying = ref(false);
  const currentZoom = ref(1);
  const currentMode = ref("preview"); // 'preview' | 'edit'
  const currentVideoFile = ref(null);
  const selectedKeyframeIndex = ref(0);
  const selectedMaskIds = ref(new Set());
  const videoPlayerRef = ref(null);
  const selectedTimeRange = ref({ start: 0, end: 0 });
  const videoWidth = ref(0);
  const videoHeight = ref(0);
  const isProcessing = ref(false);
  const processingProgress = ref(0);
  const processingStatus = ref("idle"); // 'idle' | 'processing' | 'completed' | 'error'
  const processingError = ref(null);

  // 计算属性
  const activeMask = computed(() => {
    return maskList.value.find((mask) => mask.id === activeMaskId.value);
  });

  const hasActiveMask = computed(() => {
    return !!activeMask.value;
  });
  const selectedMasks = computed(() => {
    return maskList.value.filter((mask) => selectedMaskIds.value.has(mask.id));
  });

  const hasSelectedMasks = computed(() => {
    return selectedMaskIds.value.size > 0;
  });
  const hasVideo = computed(() => !!currentVideoFile.value);
  const hasMasks = computed(() => maskList.value.length > 0);
  const canEdit = computed(() => hasVideo.value && hasMasks.value);
  const canProcess = computed(() => hasVideo.value && hasMasks.value);

  // 动作
  /**
   * 添加新的蒙版到蒙版列表
   * @param {Object} maskData - 蒙版数据对象
   */
  function addMask(maskData) {
    maskList.value.push(maskData);
    activeMaskId.value = maskData.id;
  }

  /**
   * 删除指定ID的蒙版
   * @param {string} maskId - 要删除的蒙版ID
   */
  function removeMask(maskId) {
    const index = maskList.value.findIndex((mask) => mask.id === maskId);
    if (index !== -1) {
      maskList.value.splice(index, 1);
      if (activeMaskId.value === maskId) {
        activeMaskId.value =
          maskList.value.length > 0 ? maskList.value[0].id : null;
      }
    }
  }

  /**
   * 更新指定ID的蒙版数据
   * @param {string} maskId - 蒙版ID
   * @param {Object} updatedMask - 更新后的蒙版数据
   */
  function updateMask(maskId, updatedMask) {
    const index = maskList.value.findIndex((mask) => mask.id === maskId);
    if (index !== -1) {
      maskList.value[index] = updatedMask;
    }
  }

  /**
   * 选择一个 mask
   * @param {*} maskId
   */
  function onMaskSelect(maskId) {
    activeMaskId.value = maskId;
    selectedKeyframeIndex.value = 0;
  }

  /**
   * 切换 mask 可见性
   * @param {*} maskId
   */
  function toggleMaskVisibility(maskId) {
    const mask = maskList.value.find((m) => m.id === maskId);
    if (mask) {
      mask.visible = !mask.visible;
    }
  }

  /**
   * 设置视频播放器引用
   * @param {*} ref
   */
  function setVideoPlayerRef(ref) {
    videoPlayerRef.value = ref;
  }

  /**
   * 播放暂停切换
   */
  function onPlayToggle() {
    isPlaying.value = !isPlaying.value;
    if (videoPlayerRef.value) {
      if (isPlaying.value) {
        videoPlayerRef.value.play();
      } else {
        videoPlayerRef.value.pause();
      }
    }
  }

  /**
   * 跳转到指定时间点
   * @param {number} time - 目标时间（秒）
   */
  function onSeek(time) {
    const clampedTime = Math.max(0, Math.min(time, duration.value));
    currentTime.value = clampedTime;
    if (videoPlayerRef.value) {
      videoPlayerRef.value.seek(clampedTime);
    }
  }

  /**
   * 设置视频总时长
   * @param {number} duration - 视频时长（秒）
   */
  function setDuration(newDuration) {
    duration.value = newDuration;
  }

  /**
   * 视频缩放
   * @param {*} zoom
   */
  function onZoomChange(zoom) {
    currentZoom.value = Math.max(0.1, Math.min(10, zoom));
  }

  /**
   * 视频缩放放大
   */
  function onZoomIn() {
    onZoomChange(currentZoom.value * 1.2);
  }

  /**
   * 视频缩放缩小
   */
  function onZoomOut() {
    onZoomChange(currentZoom.value / 1.2);
  }

  /**
   * 视频缩放重置
   */
  function resetZoom() {
    currentZoom.value = 1;
  }

  /**
   * 切换编辑模式
   * @param {string} mode - 模式类型（'preview' | 'edit'）
   */
  function onModeChange(mode) {
    currentMode.value = mode;
  }

  /**
   * 视频上一帧 TODO:根据当前视频帧率控制
   */
  function onPreviousFrame() {
    onSeek(currentTime.value - 1 / 30); // 假设30fps
  }

  /**
   * 视频下一帧 TODO:根据当前视频帧率控制
   */
  function onNextFrame() {
    onSeek(currentTime.value + 1 / 30);
  }

  /**
   * 视频加载
   * @param {*} file
   */
  function loadVideoFile(file) {
    currentVideoFile.value = {
      name: file.name,
      size: file.size,
      type: file.type,
      url: URL.createObjectURL(file),
    };

    // 重置状态
    maskList.value = [];
    activeMaskId.value = null;
    currentTime.value = 0;
    isPlaying.value = false;
  }

  /**
   * 导出视频
   * @returns {Promise<Object>} 导出结果
   */
  function exportVideo() {
    // TODO:实现视频导出逻辑
    console.log("导出视频", {
      video: currentVideoFile.value,
      masks: maskList.value,
    });
  }

  function getCurrentKeyframe(mask) {
    if (!mask || !mask.keyframes.length) return null;

    // 查找当前时间最近的关键帧
    const sortedKeyframes = mask.keyframes.sort((a, b) => a.time - b.time);

    for (let i = sortedKeyframes.length - 1; i >= 0; i--) {
      if (sortedKeyframes[i].time <= currentTime.value) {
        return sortedKeyframes[i];
      }
    }

    return sortedKeyframes[0];
  }

  /**
   * 格式化时间显示
   * @param {number} seconds - 秒数
   * @returns {string} 格式化后的时间字符串（MM:SS）
   */
  function formatTime(seconds, includeMs = false) {
    if (typeof seconds !== "number" || isNaN(seconds)) return "00:00";

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    if (includeMs) {
      return `${mins.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }

  /**
   * 格式化时长显示
   * @param {number} seconds - 秒数
   * @returns {string} 格式化后的时长字符串（HH:MM:SS）
   */
  function formatDuration(seconds) {
    return formatTime(seconds);
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  function onTrackClick(time) {
    onSeek(Math.max(0, Math.min(time, duration.value)));
  }

  function onTrackDoubleClick(time) {
    onSeek(time);
    if (activeMask.value) {
      addKeyframeAtCurrentTime(activeMask.value.id);
    }
  }

  function addKeyframeAtCurrentTime(maskId) {
    const mask = maskList.value.find((m) => m.id === maskId);
    if (!mask) return;

    // 检查当前时间是否已有关键帧
    const existingKeyframe = mask.keyframes.find(
      (kf) => Math.abs(kf.time - currentTime.value) < 0.1
    );

    if (existingKeyframe) return;

    // 获取插值数据
    const nearestKeyframe = getCurrentKeyframe(mask);
    const newKeyframe = {
      time: currentTime.value,
      maskData: nearestKeyframe
        ? { ...nearestKeyframe.maskData }
        : {
            type: "rectangle",
            rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          },
      transform: nearestKeyframe
        ? { ...nearestKeyframe.transform }
        : {
            offsetX: 0,
            offsetY: 0,
            scaleX: 1,
            scaleY: 1,
          },
    };

    mask.keyframes.push(newKeyframe);
    mask.keyframes.sort((a, b) => a.time - b.time);
  }

  function loadVideo(videoSrc) {
    currentVideoFile.value = {
      name: "",
      size: 0,
      type: "",
      url: videoSrc,
    };
    // 重置其他状态
    currentTime.value = 0;
    isPlaying.value = false;
  }

  function resetProject() {
    maskList.value = [];
    activeMaskId.value = null;
    currentTime.value = 0;
    isPlaying.value = false;
    currentVideoFile.value = null;
    duration.value = 0;
    currentZoom.value = 1;
    currentMode.value = "preview";
    selectedKeyframeIndex.value = 0;
  }

  function selectAllMasks() {
    selectedMaskIds.value = new Set(maskList.value.map((mask) => mask.id));
  }

  function clearMaskSelection() {
    selectedMaskIds.value.clear();
  }

  function removeSelectedMasks() {
    const masksToRemove = Array.from(selectedMaskIds.value);
    masksToRemove.forEach((maskId) => {
      removeMask(maskId);
    });
    selectedMaskIds.value.clear();
  }

  function toggleMaskSelection(maskId) {
    const newSet = new Set(selectedMaskIds.value);
    if (newSet.has(maskId)) {
      newSet.delete(maskId);
    } else {
      newSet.add(maskId);
    }
    selectedMaskIds.value = newSet;
  }

  function selectMaskRange(startId, endId) {
    const startIndex = maskList.value.findIndex((m) => m.id === startId);
    const endIndex = maskList.value.findIndex((m) => m.id === endId);

    if (startIndex !== -1 && endIndex !== -1) {
      const min = Math.min(startIndex, endIndex);
      const max = Math.max(startIndex, endIndex);
      const newSet = new Set(selectedMaskIds.value);

      for (let i = min; i <= max; i++) {
        newSet.add(maskList.value[i].id);
      }
      selectedMaskIds.value = newSet;
    }
  }

  function duplicateSelectedMasks() {
    const masksToClone = selectedMasks.value;
    masksToClone.forEach((mask) => {
      const newMask = {
        ...mask,
        id: Date.now() + Math.random(),
        name: `${mask.name}_副本`,
        keyframes: mask.keyframes.map((kf) => ({ ...kf })),
      };
      addMask(newMask);
    });
  }

  function selectTimeRange(startTime, endTime) {
    selectedTimeRange.value = {
      start: Math.max(0, startTime),
      end: Math.min(duration.value, endTime),
    };
  }
  function clearTimeRange() {
    selectedTimeRange.value = { start: 0, end: 0 };
  }
  function hasTimeRangeSelected() {
    return selectedTimeRange.value.start !== selectedTimeRange.value.end;
  }

  function moveKeyframe(maskId, keyframeIndex, newTime) {
    const mask = maskList.value.find((m) => m.id === maskId);
    if (mask && mask.keyframes[keyframeIndex]) {
      mask.keyframes[keyframeIndex].time = newTime;
      mask.keyframes.sort((a, b) => a.time - b.time);
    }
  }
  /**
   * 处理视频
   * @returns {Promise<Object>} 处理结果
   */
  async function processVideo() {
    isProcessing.value = true;
    processingProgress.value = 0;
    processingStatus.value = "processing";
    processingError.value = null;

    try {
      // 模拟处理进度
      for (let i = 0; i <= 100; i += 10) {
        processingProgress.value = i;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // 实际的视频处理逻辑
      // TODO: 集成实际的视频处理API
      console.log("处理视频", {
        video: currentVideoFile.value,
        masks: maskList.value,
        timeRange: selectedTimeRange.value,
      });

      processingStatus.value = "completed";
      isProcessing.value = false;
      return { success: true, outputPath: "processed_video.mp4" };
    } catch (error) {
      processingStatus.value = "error";
      processingError.value = error.message;
      isProcessing.value = false;
      throw error;
    }
  }
  /**
   * 为指定蒙版添加关键帧
   * @param {string} maskId - 蒙版ID
   * @param {number} time - 关键帧时间点
   */
  function addKeyframeToMask(maskId, time = null) {
    const mask = maskList.value.find((m) => m.id === maskId);
    if (!mask) return;

    const keyframeTime = time !== null ? time : currentTime.value;

    // 检查是否已存在该时间的关键帧
    const existingKeyframe = mask.keyframes.find(
      (kf) => Math.abs(kf.time - keyframeTime) < 0.1
    );

    if (existingKeyframe) return;

    const newKeyframe = {
      time: keyframeTime,
      maskData: {
        type: mask.type || "rectangle",
        rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
      transform: {
        offsetX: 0,
        offsetY: 0,
        scaleX: 1,
        scaleY: 1,
      },
    };

    mask.keyframes.push(newKeyframe);
    mask.keyframes.sort((a, b) => a.time - b.time);

    updateMask(maskId, mask);
  }

  // 批量操作优化
  function batchUpdateMasks(updates) {
    updates.forEach(({ maskId, data }) => {
      const index = maskList.value.findIndex((m) => m.id === maskId);
      if (index !== -1) {
        maskList.value[index] = { ...maskList.value[index], ...data };
      }
    });
  }

  /**
   * 重置处理状态
   */
  function resetProcessingState() {
    isProcessing.value = false;
    processingProgress.value = 0;
    processingStatus.value = "idle";
    processingError.value = null;
  }

  return {
    // 状态
    maskList,
    activeMaskId,
    currentTime,
    duration,
    isPlaying,
    currentZoom,
    currentMode,
    currentVideoFile,
    selectedKeyframeIndex,
    selectedMaskIds,
    videoPlayerRef,
    videoWidth,
    videoHeight,
    selectedTimeRange,
    isProcessing,
    processingProgress,
    processingStatus,
    processingError,

    // 计算属性
    activeMask,
    hasActiveMask,
    selectedMasks,
    hasSelectedMasks,
    hasVideo,
    hasMasks,
    canEdit,
    canProcess,

    // 动作
    addMask,
    removeMask,
    updateMask,
    onMaskSelect,
    toggleMaskVisibility,
    onPlayToggle,
    onSeek,
    setDuration,
    onZoomChange,
    onZoomIn,
    onZoomOut,
    resetZoom,
    onModeChange,
    onPreviousFrame,
    onNextFrame,
    loadVideoFile,
    exportVideo,
    getCurrentKeyframe,
    addKeyframeAtCurrentTime,
    loadVideo,
    resetProject,
    toggleMaskSelection,
    selectAllMasks,
    clearMaskSelection,
    removeSelectedMasks,
    setVideoPlayerRef,
    formatTime,
    formatDuration,
    formatFileSize,
    selectMaskRange,
    duplicateSelectedMasks,
    onTrackClick,
    onTrackDoubleClick,
    selectTimeRange,
    moveKeyframe,
    clearTimeRange,
    hasTimeRangeSelected,
    processVideo,
    addKeyframeToMask,
    batchUpdateMasks,
    resetProcessingState,
  };
});
