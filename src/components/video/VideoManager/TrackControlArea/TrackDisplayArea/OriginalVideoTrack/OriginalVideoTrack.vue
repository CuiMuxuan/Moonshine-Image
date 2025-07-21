<template>
  <div class="original-video-track">
    <div class="track-header">
      <q-icon name="videocam" size="16px" color="grey-6" />
      <span class="track-title">原始视频</span>
    </div>

    <div class="track-content">
      <VideoPreview
        :duration="duration"
        :zoom="currentZoom"
        :pixels-per-second="pixelsPerSecond"
        :current-time="currentTime"
      />
    </div>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import VideoPreview from './VideoPreview.vue'

defineProps({
  pixelsPerSecond: {
    type: Number,
    default: 50
  }
})

const videoStore = useVideoHandleManager()
const { duration, currentZoom, currentTime } = storeToRefs(videoStore)
</script>

<style scoped>
.original-video-track {
  display: flex;
  align-items: center;
  height: 60px;
  border-bottom: 1px solid #e0e0e0;
}

.track-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 120px;
  padding: 0 12px;
  background: #f8f9fa;
  border-right: 1px solid #e0e0e0;
}

.track-title {
  font-size: 12px;
  font-weight: 500;
  color: #666;
}

.track-content {
  flex: 1;
  height: 100%;
  position: relative;
}
</style>
