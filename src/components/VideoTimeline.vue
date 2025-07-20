<template>
  <div class="video-timeline">
    <!-- 时间轴主体 -->
    <div class="timeline-container">
      <div class="timeline-track" ref="timelineTrack">
        <!-- 时间刻度 -->
        <div class="time-markers">
          <div
            v-for="marker in timeMarkers"
            :key="marker.time"
            class="time-marker"
            :style="{ left: marker.position + '%' }"
          >
            {{ formatTime(marker.time) }}
          </div>
        </div>

        <!-- 蒙版轨道 -->
        <div class="mask-tracks">
          <div
            v-for="mask in masks"
            :key="mask.id"
            class="mask-track"
          >
            <div
              class="mask-segment"
              :style="{
                left: (mask.start_frame / videoInfo.totalFrames) * 100 + '%',
                width: ((mask.end_frame - mask.start_frame) / videoInfo.totalFrames) * 100 + '%'
              }"
              :class="{ active: mask.id === activeMaskId }"
              @click="selectMask(mask.id)"
            >
              {{ mask.name || `蒙版 ${mask.id}` }}

              <!-- 关键帧标记 -->
              <div
                v-for="offset in mask.offsets"
                :key="offset.frame_index"
                class="keyframe-marker"
                :style="{
                  left: ((offset.frame_index - mask.start_frame) / (mask.end_frame - mask.start_frame)) * 100 + '%'
                }"
              />
            </div>
          </div>
        </div>

        <!-- 播放头 -->
        <div
          class="playhead"
          :style="{ left: (currentFrame / videoInfo.totalFrames) * 100 + '%' }"
          @mousedown="startDragging"
        />
      </div>
    </div>

    <!-- 时间轴控制 -->
    <div class="timeline-controls">
      <div class="time-display">
        {{ formatTime(currentTime) }} / {{ formatTime(videoInfo.duration) }}
      </div>

      <div class="frame-display">
        第 {{ currentFrame }} / {{ videoInfo.totalFrames }} 帧
      </div>

      <q-slider
        :model-value="currentFrame"
        :min="0"
        :max="videoInfo.totalFrames - 1"
        @update:model-value="seekToFrame"
        class="frame-slider"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'

// Props
const props = defineProps({
  videoInfo: {
    type: Object,
    required: true
  },
  currentFrame: {
    type: Number,
    default: 0
  },
  currentTime: {
    type: Number,
    default: 0
  },
  masks: {
    type: [Array, Map],
    default: () => []
  },
  activeMaskId: {
    type: [String, Number],
    default: null
  }
})

// Emits
const emit = defineEmits([
  'seek-to-frame',
  'select-mask'
])

// 响应式数据
const timelineTrack = ref(null)
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartFrame = ref(0)

// 计算属性
const timeMarkers = computed(() => {
  const markers = []
  const duration = props.videoInfo.duration

  if (duration <= 0) return markers

  // 根据视频长度决定时间标记间隔
  let interval = 1 // 秒
  if (duration > 60) interval = 10
  else if (duration > 30) interval = 5
  else if (duration > 10) interval = 2

  for (let time = 0; time <= duration; time += interval) {
    markers.push({
      time,
      position: (time / duration) * 100
    })
  }

  return markers
})

// 方法
const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '00:00'

  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

const seekToFrame = (frame) => {
  emit('seek-to-frame', frame)
}

const selectMask = (maskId) => {
  emit('select-mask', maskId)
}

const startDragging = (event) => {
  isDragging.value = true
  dragStartX.value = event.clientX
  dragStartFrame.value = props.currentFrame

  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragEnd)
  event.preventDefault()
}

const onDragMove = (event) => {
  if (!isDragging.value || !timelineTrack.value) return

  const rect = timelineTrack.value.getBoundingClientRect()
  const deltaX = event.clientX - dragStartX.value
  const deltaPercent = deltaX / rect.width
  const deltaFrames = Math.round(deltaPercent * props.videoInfo.totalFrames)

  const newFrame = Math.max(0, Math.min(
    props.videoInfo.totalFrames - 1,
    dragStartFrame.value + deltaFrames
  ))

  seekToFrame(newFrame)
}

const onDragEnd = () => {
  isDragging.value = false
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragEnd)
}

// 生命周期
onUnmounted(() => {
  if (isDragging.value) {
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }
})
</script>

<style scoped>
.video-timeline {
  background: #f5f5f5;
  border-top: 1px solid #e0e0e0;
  padding: 8px;
}

.timeline-container {
  position: relative;
  height: 120px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  margin-bottom: 8px;
}

.timeline-track {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.time-markers {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.time-marker {
  position: absolute;
  top: 0;
  font-size: 10px;
  color: #666;
  padding: 2px 4px;
  background: rgba(255, 255, 255, 0.8);
}

.mask-tracks {
  position: absolute;
  top: 20px;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 4px;
}

.mask-track {
  position: relative;
  height: 24px;
  margin-bottom: 4px;
}

.mask-segment {
  position: absolute;
  height: 100%;
  background: #1976d2;
  color: white;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: all 0.2s;
}

.mask-segment:hover {
  background: #1565c0;
}

.mask-segment.active {
  background: #f57c00;
  box-shadow: 0 0 0 2px rgba(245, 124, 0, 0.3);
}

.keyframe-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
  opacity: 0.8;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #f44336;
  cursor: ew-resize;
  z-index: 10;
}

.playhead::before {
  content: '';
  position: absolute;
  top: -4px;
  left: -4px;
  width: 10px;
  height: 10px;
  background: #f44336;
  border-radius: 50%;
}

.timeline-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: #666;
}

.frame-slider {
  flex: 1;
}
</style>
