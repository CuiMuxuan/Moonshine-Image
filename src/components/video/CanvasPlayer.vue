<template>
  <div class="canvas-player fit row flex-center">
    <div
      v-if="videoStore.hasVideoFile"
      ref="canvasWrapper"
      class="canvas-wrapper"
      :style="playerSize"
    ></div>
    <div v-else class="empty-state fit column flex-center" :style="playerSize">
      <div class="empty-content text-center">
        <q-icon name="videocam_off" size="64px" color="grey-5" />
        <p class="text-grey-5 q-mt-md">请选择视频文件</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick, computed } from "vue";
import { useVideoManagerStore } from "../../stores/videoManager";
import { AVCanvas } from "@webav/av-canvas";
import { VisibleSprite, MP4Clip } from "@webav/av-cliper";

const videoStore = useVideoManagerStore();
const canvasWrapper = ref(null);

// 本地状态管理 - 模仿 video-editor.tsx 的状态管理方式
// 避免将WebAV对象存储在响应式ref中，防止Vue代理包装导致私有字段访问问题
let avCvs = null;
let visibleSprite = null;
let videoSprite = null;
const videoWidth = ref(0);
const videoHeight = ref(0);
const videoDuration = ref(0);

// 计算播放器尺寸样式 - 根据视频宽高比固定容器宽高比
const playerSize = computed(() => {
  // 如果有视频文件，使用视频的宽高比来计算容器尺寸
  if (videoStore.hasVideoFile && videoStore.videoWidth > 0 && videoStore.videoHeight > 0) {
    const videoAspectRatio = videoStore.videoWidth / videoStore.videoHeight;

    // 如果有容器尺寸，根据视频宽高比计算适合的显示尺寸
    if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
      const containerAspectRatio = videoStore.playerWidth / videoStore.playerHeight;

      let displayWidth, displayHeight;

      if (videoAspectRatio > containerAspectRatio) {
        // 视频更宽，以容器宽度为准
        displayWidth = videoStore.playerWidth;
        displayHeight = videoStore.playerWidth / videoAspectRatio;
      } else {
        // 视频更高，以容器高度为准
        displayHeight = videoStore.playerHeight;
        displayWidth = videoStore.playerHeight * videoAspectRatio;
      }

      return {
        width: Math.floor(displayWidth) + "px",
        height: Math.floor(displayHeight) + "px",
      };
    }

    // 如果没有容器尺寸，使用视频原始尺寸的缩放版本
    const maxWidth = 800; // 最大宽度限制
    const maxHeight = 600; // 最大高度限制

    let displayWidth = videoStore.videoWidth;
    let displayHeight = videoStore.videoHeight;

    // 如果视频尺寸超过最大限制，按比例缩放
    if (displayWidth > maxWidth) {
      displayHeight = (displayHeight * maxWidth) / displayWidth;
      displayWidth = maxWidth;
    }

    if (displayHeight > maxHeight) {
      displayWidth = (displayWidth * maxHeight) / displayHeight;
      displayHeight = maxHeight;
    }

    return {
      width: Math.floor(displayWidth) + "px",
      height: Math.floor(displayHeight) + "px",
    };
  }

  // 没有视频文件时，使用容器尺寸或默认尺寸
  if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
    return {
      width: videoStore.playerWidth + "px",
      height: videoStore.playerHeight + "px",
    };
  }

  return {
    width: "100%",
    height: "100%",
  };
});

// 创建视频剪辑 - 模仿 video-editor.tsx 的创建方式
const createVideoClip = async (file) => {
  try {
    // 销毁之前的MP4Clip实例
    if (videoSprite) {
      try {
        videoSprite.destroy();
      } catch (error) {
        console.warn("销毁之前的MP4Clip时出错:", error);
      }
    }

    const stream = file.stream();
    const clip = new MP4Clip(stream, {
      __unsafe_hardwareAcceleration__: "no-preference",
    });

    // 等待clip准备完成以获取视频信息
    const { duration, width, height } = await clip.ready;

    videoWidth.value = width;
    videoHeight.value = height;
    videoDuration.value = Math.round(duration / 1e6);
    videoSprite = clip;

    // 更新store中的视频信息
    videoStore.setVideoInfo(width, height, Math.round(duration / 1e6));

    // 重新计算显示尺寸
    if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
      videoStore.calculateDisplaySize(
        videoStore.playerWidth,
        videoStore.playerHeight
      );
    }

    return clip;
  } catch (error) {
    console.error("创建视频剪辑失败:", error);
    throw error;
  }
};

// 创建AVCanvas实例 - 使用固定尺寸避免频繁重建
const createCanvas = async () => {
  if (!canvasWrapper.value || !videoStore.hasVideoFile) {
    return;
  }

  // 确认DOM元素存在且是HTMLElement
  if (!(canvasWrapper.value instanceof HTMLElement)) {
    console.error(
      "canvasWrapper.value不是有效的HTMLElement:",
      canvasWrapper.value
    );
    return;
  }

  // 如果AVCanvas已存在且有视频精灵，不需要重建
  if (avCvs && visibleSprite) {
    return;
  }

  // 销毁现有实例
  if (avCvs) {
    avCvs.destroy();
    avCvs = null;
  }
  visibleSprite = null;

  try {
    // 使用视频的实际尺寸创建AVCanvas，避免比例扭曲
    // 如果没有视频信息，使用默认尺寸
    const canvasWidth = videoWidth.value || 1280;
    const canvasHeight = videoHeight.value || 720;
    
    const cvs = new AVCanvas(canvasWrapper.value, {
      bgColor: "#000",
      width: canvasWidth,
      height: canvasHeight,
    });

    avCvs = cvs;

    // 设置事件监听
    cvs.on("timeupdate", (time) => {
      const timeInSeconds = time / 1e6;
      videoStore.setCurrentTime(timeInSeconds);
    });

    cvs.on("playing", () => {
      videoStore.setIsPlaying(true);
    });

    cvs.on("paused", () => {
      videoStore.setIsPlaying(false);
    });

    // 如果有视频剪辑，创建并添加视频精灵到画布
    if (videoSprite) {
      try {
        // 直接创建 VisibleSprite
        const sprite = new VisibleSprite(videoSprite);
        await cvs.addSprite(sprite);

        // 保存创建的精灵
        visibleSprite = sprite;
      } catch (error) {
        console.error("创建或添加视频精灵失败:", error);
        throw error;
      }
    }
  } catch (error) {
    console.error("创建AVCanvas失败:", error);
  }
};

// 销毁AVCanvas实例 - 模仿 video-editor.tsx 的销毁方式
const destroyCanvas = () => {
  if (avCvs) {
    // 直接销毁，不捕获异常，模仿参考代码的方式
    avCvs.destroy();
    avCvs = null;
  }
  visibleSprite = null;
};

// 播放控制方法 - 模仿 video-editor.tsx 的实现
const play = () => {
  if (avCvs && videoStore.hasVideoFile && visibleSprite) {
    // 确保有视频精灵才能播放，支持播放倍速
    console.log("播放倍速设置为:", videoStore.playbackRate);
    avCvs.play({
      start: videoStore.currentTime * 1e6,
      playbackRate: videoStore.playbackRate,
    });
  }
};

const pause = () => {
  if (avCvs) {
    avCvs.pause();
  }
};

const togglePlayPause = () => {
  if (avCvs == null || !videoStore.hasVideoFile || !visibleSprite) {
    return;
  }

  if (videoStore.isPlaying) {
    pause();
  } else {
    play();
  }
};

// 预览指定时间的帧 - 模仿 video-editor.tsx 的实现
const previewFrame = (timeInSeconds) => {
  if (avCvs && videoStore.hasVideoFile && visibleSprite) {
    avCvs.previewFrame(timeInSeconds * 1e6);
    videoStore.setCurrentTime(timeInSeconds);
  }
};

// 跳转到上一帧（约33ms前）
const previousFrame = () => {
  if (!videoStore.hasVideoFile) return;
  const frameTime = 1 / 30; // 假设30fps
  const newTime = Math.max(0, videoStore.currentTime - frameTime);
  previewFrame(newTime);
  // 如果正在播放，暂停播放
  if (videoStore.isPlaying) {
    pause();
  }
};

// 跳转到下一帧（约33ms后）
const nextFrame = () => {
  if (!videoStore.hasVideoFile) return;
  const frameTime = 1 / 30; // 假设30fps
  const newTime = Math.min(
    videoStore.videoDuration,
    videoStore.currentTime + frameTime
  );
  previewFrame(newTime);
  // 如果正在播放，暂停播放
  if (videoStore.isPlaying) {
    pause();
  }
};

// 跳转到指定时间
const seekTo = (timeInSeconds) => {
  if (!videoStore.hasVideoFile) return;
  const clampedTime = Math.max(
    0,
    Math.min(videoStore.videoDuration, timeInSeconds)
  );
  previewFrame(clampedTime);
};

// 监听视频文件变化，创建视频剪辑
watch(
  () => videoStore.videoFile,
  async (newFile) => {
    if (newFile) {
      try {
        await createVideoClip(newFile);
        // 如果播放器尺寸已经准备好，立即创建画布
        if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
          setTimeout(() => {
            createCanvas();
          }, 100);
        }
      } catch (error) {
        console.error("处理视频文件失败:", error);
        // 清理状态
        videoSprite = null;
        videoWidth.value = 0;
        videoHeight.value = 0;
        videoDuration.value = 0;
      }
    } else {
      // 清理所有状态 - 模仿 decode-video.tsx 的清理方式
      destroyCanvas();
      // 销毁MP4Clip实例
      if (videoSprite) {
        try {
          videoSprite.destroy();
        } catch (error) {
          console.warn("销毁MP4Clip时出错:", error);
        }
      }
      videoSprite = null;
      videoWidth.value = 0;
      videoHeight.value = 0;
      videoDuration.value = 0;
      // 清理store中的视频信息
      videoStore.clearVideoInfo();
    }
  }
);

// 监听播放器尺寸变化，仅重新计算显示尺寸，不重建AVCanvas
watch(
  [() => videoStore.playerWidth, () => videoStore.playerHeight],
  async ([newWidth, newHeight]) => {
    if (newWidth > 0 && newHeight > 0) {
      // 重新计算显示尺寸
      videoStore.calculateDisplaySize(newWidth, newHeight);

      // 如果还没有创建AVCanvas，则创建一次
      if (videoStore.hasVideoFile && videoSprite && !avCvs) {
        await nextTick();
        createCanvas();
      }
    }
  }
);

// 监听播放倍速变化，如果正在播放则重新开始播放以应用新倍速
watch(
  () => videoStore.playbackRate,
  (newRate) => {
    console.log("播放倍速变化为:", newRate);
    if (videoStore.isPlaying && avCvs && visibleSprite) {
      // 暂停当前播放
      avCvs.pause();
      // 重新开始播放以应用新的倍速
      setTimeout(() => {
        play();
      }, 50);
    }
  }
);

// 暴露方法给父组件使用
defineExpose({
  play,
  pause,
  togglePlayPause,
  previewFrame,
  previousFrame,
  nextFrame,
  seekTo,
  // 暴露视频信息
  videoWidth: () => videoWidth.value,
  videoHeight: () => videoHeight.value,
  videoDuration: () => videoDuration.value,
});

onMounted(() => {
  // 组件挂载时等待视频文件设置后通过watch监听器创建
});

onUnmounted(() => {
  destroyCanvas();
  // 销毁MP4Clip实例
  if (videoSprite) {
    try {
      videoSprite.destroy();
    } catch (error) {
      console.warn("组件卸载时销毁MP4Clip出错:", error);
    }
  }
});
</script>

<style scoped>
.canvas-wrapper {
  background-color: #000;
  border-radius: 4px;
  overflow: hidden;
}

.canvas-wrapper :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
  object-fit: scale-down;
}

.empty-state {
  background-color: #f5f5f5;
  border-radius: 4px;
  border: 2px dashed #ddd;
}
</style>
