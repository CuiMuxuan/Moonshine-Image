import { defineStore } from "pinia";
import { ref } from "vue";

export const useVideoManagerStore = defineStore("videoManager", () => {
  // 视频文件
  const videoFile = ref(null);

  // 是否有视频文件
  const hasVideoFile = ref(false);

  // 播放器尺寸（初始值为0，等待父容器计算）
  const playerWidth = ref(0);
  const playerHeight = ref(0);

  // 播放状态
  const isPlaying = ref(false);
  const currentTime = ref(0);
  const playbackRate = ref(1); // 播放倍速
  
  // 视频信息
  const videoWidth = ref(0);
  const videoHeight = ref(0);
  const videoDuration = ref(0); // 视频总时长（秒）
  
  // 显示尺寸（根据视频宽高比计算的实际显示尺寸）
  const displayWidth = ref(0);
  const displayHeight = ref(0);

  // 设置视频文件
  const setVideoFile = (file) => {
    videoFile.value = file;
    hasVideoFile.value = !!file;
  };

  // 清除视频文件
  const clearVideoFile = () => {
    videoFile.value = null;
    hasVideoFile.value = false;
  };

  // 获取视频文件信息
  const getVideoFileInfo = () => {
    if (!videoFile.value) return null;

    return {
      name: videoFile.value.name,
      size: videoFile.value.size,
      type: videoFile.value.type,
      lastModified: videoFile.value.lastModified,
    };
  };

  // 设置播放器尺寸
  const setPlayerSize = (width, height) => {
    playerWidth.value = width;
    playerHeight.value = height;
  };

  // 根据父容器调整播放器尺寸
  const adjustPlayerSize = (containerWidth, containerHeight) => {
    // 直接使用容器尺寸，不强制宽高比
    setPlayerSize(Math.floor(containerWidth), Math.floor(containerHeight));
  };

  // 设置播放状态
  const setIsPlaying = (playing) => {
    isPlaying.value = playing;
  };

  const setCurrentTime = (time) => {
    currentTime.value = time;
  };
  
  // 设置播放倍速
  const setPlaybackRate = (rate) => {
    playbackRate.value = rate;
  };
  
  // 设置视频信息
  const setVideoInfo = (width, height, duration) => {
    videoWidth.value = width;
    videoHeight.value = height;
    videoDuration.value = duration;
  };
  
  // 清除视频信息
  const clearVideoInfo = () => {
    videoWidth.value = 0;
    videoHeight.value = 0;
    videoDuration.value = 0;
    displayWidth.value = 0;
    displayHeight.value = 0;
  };
  
  // 根据视频宽高比计算显示尺寸
  const calculateDisplaySize = (containerWidth, containerHeight) => {
    if (videoWidth.value === 0 || videoHeight.value === 0) {
      displayWidth.value = containerWidth;
      displayHeight.value = containerHeight;
      return;
    }
    
    const videoAspectRatio = videoWidth.value / videoHeight.value;
    const containerAspectRatio = containerWidth / containerHeight;
    
    let newWidth, newHeight;
    
    if (videoAspectRatio > containerAspectRatio) {
      // 视频更宽，以容器宽度为准
      newWidth = containerWidth;
      newHeight = containerWidth / videoAspectRatio;
    } else {
      // 视频更高，以容器高度为准
      newHeight = containerHeight;
      newWidth = containerHeight * videoAspectRatio;
    }
    
    displayWidth.value = Math.floor(newWidth);
    displayHeight.value = Math.floor(newHeight);
  };

  return {
    // 状态
    videoFile,
    hasVideoFile,
    playerWidth,
    playerHeight,
    isPlaying,
    currentTime,
    playbackRate,
    videoWidth,
    videoHeight,
    videoDuration,
    displayWidth,
    displayHeight,

    // 方法
    setVideoFile,
    clearVideoFile,
    getVideoFileInfo,
    setPlayerSize,
    adjustPlayerSize,
    setIsPlaying,
    setCurrentTime,
    setPlaybackRate,
    setVideoInfo,
    clearVideoInfo,
    calculateDisplaySize,
  };
});
