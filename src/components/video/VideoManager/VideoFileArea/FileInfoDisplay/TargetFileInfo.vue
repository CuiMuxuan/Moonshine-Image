<template>
  <div class="target-file-info">
    <div class="file-label">输出文件</div>
    <div class="file-details">
      <div class="file-name">{{ outputFileName }}</div>
      <div class="file-meta">{{ formatDuration(duration) }} | {{ resolution }} | {{ maskCount }}个蒙版</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { duration, videoWidth, videoHeight, maskList } = storeToRefs(videoStore)

const outputFileName = computed(() => {
  return 'output_with_masks.mp4'
})

const resolution = computed(() => {
  if (!videoWidth.value || !videoHeight.value) return ''
  return `${videoWidth.value}x${videoHeight.value}`
})

const maskCount = computed(() => {
  return maskList.value.length
})

function formatDuration(seconds) {
  if (!seconds) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.target-file-info {
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
</style>
