<template>
  <div class="current-file-info">
    <div class="file-label">源文件</div>
    <div class="file-details" v-if="videoSrc">
      <div class="file-name">{{ fileName }}</div>
      <div class="file-meta">{{ formatDuration(duration) }} | {{ resolution }}</div>
    </div>
    <div class="no-file" v-else>
      <q-icon name="video_file" size="24px" color="grey-4" />
      <span>未选择视频文件</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { videoSrc, duration, videoWidth, videoHeight } = storeToRefs(videoStore)

const fileName = computed(() => {
  if (!videoSrc.value) return ''
  return videoSrc.value.split('/').pop() || 'video.mp4'
})

const resolution = computed(() => {
  if (!videoWidth.value || !videoHeight.value) return ''
  return `${videoWidth.value}x${videoHeight.value}`
})

function formatDuration(seconds) {
  if (!seconds) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.current-file-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.file-label {
  font-size: 12px;
  color: #666;
  font-weight: 500;
}

.file-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.file-meta {
  font-size: 12px;
  color: #888;
}

.no-file {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #999;
  font-size: 12px;
}
</style>
