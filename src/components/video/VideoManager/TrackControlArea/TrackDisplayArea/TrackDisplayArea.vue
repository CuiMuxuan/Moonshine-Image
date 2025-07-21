<template>
  <div class="track-display-area">
    <div class="track-header">
      <div class="track-labels">
        <div class="track-label">视频轨道</div>
        <div class="track-label">遮罩轨道</div>
      </div>
      <div class="timeline-ruler" ref="timelineRuler">
        <div
          v-for="mark in timeMarks"
          :key="mark.time"
          class="time-mark"
          :style="{ left: mark.position + 'px' }"
        >
          <div class="time-mark-line"></div>
          <div class="time-mark-label">{{ formatTime(mark.time) }}</div>
        </div>
      </div>
    </div>

    <div class="tracks-container" ref="tracksContainer">
      <!-- 视频轨道 -->
      <div class="video-track">
        <div class="track-content">
          <div
            class="video-clip"
            :style="{
              width: (duration * pixelsPerSecond * currentZoom) + 'px'
            }"
          >
            视频片段
          </div>
        </div>
      </div>

      <!-- 遮罩轨道 -->
      <div class="mask-track">
        <div class="track-content">
          <div
            v-for="mask in maskList"
            :key="mask.id"
            class="mask-clip"
            :class="{ active: mask.id === activeMaskId }"
            :style="{
              left: (mask.startTime * pixelsPerSecond * currentZoom) + 'px',
              width: ((mask.endTime - mask.startTime) * pixelsPerSecond * currentZoom) + 'px'
            }"
            @click="onMaskSelect(mask.id)"
          >
            <div class="mask-clip-content">
              <span class="mask-name">{{ mask.name }}</span>
              <div class="keyframe-indicators">
                <div
                  v-for="keyframe in mask.keyframes"
                  :key="keyframe.time"
                  class="keyframe-indicator"
                  :style="{
                    left: ((keyframe.time - mask.startTime) / (mask.endTime - mask.startTime) * 100) + '%'
                  }"
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 播放头 -->
    <div
      class="playhead"
      :style="{
        left: (currentTime * pixelsPerSecond * currentZoom) + 'px'
      }"
    >
      <div class="playhead-line"></div>
      <div class="playhead-handle"></div>
    </div>

    <!-- 时间轴交互层 -->
    <div
      class="timeline-interaction"
      @mousedown="onTimelineMouseDown"
      @mousemove="onTimelineMouseMove"
      @mouseup="onTimelineMouseUp"
    ></div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const {
  maskList,
  activeMaskId,
  currentTime,
  duration,
  currentZoom
} = storeToRefs(videoStore)

const {
  onMaskSelect,
  onSeek
} = videoStore

const timelineRuler = ref(null)
const tracksContainer = ref(null)
const pixelsPerSecond = 50
const isDragging = ref(false)

// 计算时间刻度
const timeMarks = computed(() => {
  const marks = []
  const interval = currentZoom.value > 2 ? 0.5 : currentZoom.value > 1 ? 1 : 2

  for (let time = 0; time <= duration.value; time += interval) {
    marks.push({
      time,
      position: time * pixelsPerSecond * currentZoom.value
    })
  }

  return marks
})

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`
}

function onTimelineMouseDown(event) {
  isDragging.value = true
  updateTimeFromMousePosition(event)
}

function onTimelineMouseMove(event) {
  if (isDragging.value) {
    updateTimeFromMousePosition(event)
  }
}

function onTimelineMouseUp() {
  isDragging.value = false
}

function updateTimeFromMousePosition(event) {
  const rect = tracksContainer.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const time = x / (pixelsPerSecond * currentZoom.value)
  const clampedTime = Math.max(0, Math.min(duration.value, time))
  onSeek(clampedTime)
}

onMounted(() => {
  document.addEventListener('mousemove', onTimelineMouseMove)
  document.addEventListener('mouseup', onTimelineMouseUp)
})

onUnmounted(() => {
  document.removeEventListener('mousemove', onTimelineMouseMove)
  document.removeEventListener('mouseup', onTimelineMouseUp)
})
</script>

<style scoped>
.track-display-area {
  position: relative;
  flex: 1;
  background: white;
  border-radius: 6px;
  overflow: hidden;
}

.track-header {
  display: flex;
  border-bottom: 1px solid #e0e0e0;
}

.track-labels {
  width: 120px;
  background: #f8f9fa;
  border-right: 1px solid #e0e0e0;
}

.track-label {
  height: 60px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 500;
  color: #666;
  border-bottom: 1px solid #e0e0e0;
}

.timeline-ruler {
  position: relative;
  flex: 1;
  height: 30px;
  background: #f8f9fa;
  overflow: hidden;
}

.time-mark {
  position: absolute;
  top: 0;
  height: 100%;
}

.time-mark-line {
  width: 1px;
  height: 15px;
  background: #999;
  margin-top: 15px;
}

.time-mark-label {
  position: absolute;
  top: 2px;
  left: 2px;
  font-size: 10px;
  color: #666;
  white-space: nowrap;
}

.tracks-container {
  position: relative;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}

.video-track,
.mask-track {
  height: 60px;
  border-bottom: 1px solid #e0e0e0;
  position: relative;
}

.track-content {
  position: relative;
  height: 100%;
  min-width: 100%;
}

.video-clip {
  height: 40px;
  margin: 10px 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 12px;
  font-weight: 500;
}

.mask-clip {
  position: absolute;
  height: 40px;
  top: 10px;
  background: #4CAF50;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 2px solid transparent;
}

.mask-clip:hover {
  background: #45a049;
  transform: translateY(-1px);
}

.mask-clip.active {
  border-color: #2196F3;
  box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.3);
}

.mask-clip-content {
  position: relative;
  height: 100%;
  padding: 0 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mask-name {
  color: white;
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.keyframe-indicators {
  display: flex;
  gap: 2px;
}

.keyframe-indicator {
  position: absolute;
  top: -2px;
  width: 6px;
  height: 6px;
  background: #FFC107;
  border-radius: 50%;
  border: 1px solid white;
}

.playhead {
  position: absolute;
  top: 30px;
  bottom: 0;
  pointer-events: none;
  z-index: 10;
}

.playhead-line {
  width: 2px;
  height: 100%;
  background: #FF5722;
  margin-left: -1px;
}

.playhead-handle {
  position: absolute;
  top: -6px;
  left: -6px;
  width: 12px;
  height: 12px;
  background: #FF5722;
  border: 2px solid white;
  border-radius: 50%;
  cursor: pointer;
  pointer-events: auto;
}

.timeline-interaction {
  position: absolute;
  top: 30px;
  left: 120px;
  right: 0;
  bottom: 0;
  cursor: pointer;
}
</style>
