<template>
  <div class="video-preview">
    <div
      class="video-clip"
      :style="{
        width: (duration * pixelsPerSecond * zoom) + 'px'
      }"
    >
      <div class="video-thumbnail-strip">
        <div
          v-for="thumbnail in thumbnails"
          :key="thumbnail.time"
          class="video-thumbnail"
          :style="{
            left: (thumbnail.time * pixelsPerSecond * zoom) + 'px',
            width: thumbnailWidth + 'px'
          }"
        >
          <!-- 这里可以放置视频缩略图 -->
          <div class="thumbnail-placeholder"></div>
        </div>
      </div>

      <!-- 当前时间指示器 -->
      <div
        class="current-time-indicator"
        :style="{
          left: (currentTime * pixelsPerSecond * zoom) + 'px'
        }"
      ></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  duration: {
    type: Number,
    default: 0
  },
  zoom: {
    type: Number,
    default: 1
  },
  pixelsPerSecond: {
    type: Number,
    default: 50
  },
  currentTime: {
    type: Number,
    default: 0
  }
})

const thumbnailWidth = 60
const thumbnailInterval = computed(() => {
  // 根据缩放级别调整缩略图间隔
  return Math.max(1, 5 / props.zoom)
})

const thumbnails = computed(() => {
  const thumbs = []
  for (let time = 0; time < props.duration; time += thumbnailInterval.value) {
    thumbs.push({ time })
  }
  return thumbs
})
</script>

<style scoped>
.video-preview {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.video-clip {
  position: relative;
  height: 100%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 4px;
  margin: 8px 0;
}

.video-thumbnail-strip {
  position: relative;
  width: 100%;
  height: 100%;
}

.video-thumbnail {
  position: absolute;
  height: 100%;
  border-right: 1px solid rgba(255, 255, 255, 0.2);
}

.thumbnail-placeholder {
  width: 100%;
  height: 100%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.current-time-indicator {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: #ff4444;
  z-index: 10;
}
</style>
