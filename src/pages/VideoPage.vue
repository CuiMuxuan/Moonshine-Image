<template>
  <q-page class="fit">
    <div class="column video">
      <div class="row col-7">
        <div class="col">
          <ResourceManage />
        </div>
        <div class="column col-6">
          <div class="column col flex-center" ref="playerContainer">
            <CanvasPlayer ref="canvasPlayerRef" class="col" />
            <div class="col-auto full-width">
              <q-slider
                v-model="currentProgress"
                :min="0"
                :max="videoStore.videoDuration"
                :step="0.1"
                :disable="!videoStore.hasVideoFile"
                @update:model-value="handleProgressChange"
                @pan="handleProgressDrag"
                color="primary"
                track-size="8px"
                track-color="grey-4"
                thumb-color="primary"
              />
            </div>
          </div>
          <!-- 播放控制工具栏 -->
          <div class="col-auto">
            <VideoToolbar
              @play-pause="handlePlayPause"
              @previous-frame="handlePreviousFrame"
              @next-frame="handleNextFrame"
              @playback-rate-change="handlePlaybackRateChange"
            />
          </div>
        </div>
        <div class="col">蒙版编辑区</div>
      </div>
      <div class="col-5">轨道编辑区</div>
    </div>
  </q-page>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import VideoToolbar from "../components/video/VideoToolbar.vue";
import ResourceManage from "../components/video/ResourceManage.vue";
import CanvasPlayer from "../components/video/CanvasPlayer.vue";
import { useVideoManagerStore } from "../stores/videoManager";

const videoStore = useVideoManagerStore();
const playerContainer = ref(null);
const canvasPlayerRef = ref(null);

// 进度条相关状态
const currentProgress = ref(0);
const isDragging = ref(false);

// 监听视频当前时间变化，更新进度条
watch(
  () => videoStore.currentTime,
  (newTime) => {
    if (!isDragging.value) {
      currentProgress.value = newTime;
    }
  }
);

// 播放控制处理
const handlePlayPause = () => {
  if (canvasPlayerRef.value) {
    canvasPlayerRef.value.togglePlayPause();
  }
};

// 上一帧控制处理
const handlePreviousFrame = () => {
  if (canvasPlayerRef.value) {
    canvasPlayerRef.value.previousFrame();
  }
};

// 下一帧控制处理
const handleNextFrame = () => {
  if (canvasPlayerRef.value) {
    canvasPlayerRef.value.nextFrame();
  }
};

// 进度条拖拽处理
const handleProgressDrag = (details) => {
  if (details.isFirst) {
    isDragging.value = true;
    // 拖拽开始时暂停播放
    if (videoStore.isPlaying && canvasPlayerRef.value) {
      canvasPlayerRef.value.pause();
    }
  } else if (details.isFinal) {
    isDragging.value = false;
  }
};

// 进度条值变化处理
const handleProgressChange = (value) => {
  if (canvasPlayerRef.value && videoStore.hasVideoFile) {
    canvasPlayerRef.value.seekTo(value);
  }
};

// 播放倍速变化处理
const handlePlaybackRateChange = (rate) => {
  videoStore.setPlaybackRate(rate);
  // 如果正在播放，重新开始播放以应用新的倍速
  if (videoStore.isPlaying && canvasPlayerRef.value) {
    canvasPlayerRef.value.play();
  }
};

// 调整播放器尺寸
const adjustPlayerSize = () => {
  if (playerContainer.value) {
    const rect = playerContainer.value.getBoundingClientRect();
    // 减去padding，但保留进度条区域的高度计算
    const availableWidth = rect.width - 20;
    const availableHeight = rect.height - 20 - 40; // 减去padding和进度条区域高度
    videoStore.adjustPlayerSize(availableWidth, availableHeight);
  }
};

// 监听窗口大小变化
const handleResize = () => {
  adjustPlayerSize();
};

onMounted(() => {
  // 使用nextTick确保DOM渲染完成后再计算尺寸
  nextTick(() => {
    // 立即计算尺寸，确保空状态也有正确的容器尺寸
    adjustPlayerSize();
  });
  // 监听窗口大小变化
  window.addEventListener("resize", handleResize);
});

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
});
</script>

<style scoped>
.video {
  height: calc(100vh - 50px);
}
</style>
