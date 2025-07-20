<template>
  <div class="video-progress-container">
    <!-- 第一进度条：帧预览控制 -->
    <div class="progress-bar-wrapper">
      <div class="progress-label">帧预览控制</div>
      <q-slider
        v-model="currentFrame"
        :min="0"
        :max="totalFrames - 1"
        :step="1"
        color="primary"
        track-color="grey-4"
        @update:model-value="onFrameChange"
        class="frame-preview-slider"
      />
      <div class="progress-info">
        <span>{{ formatTime(currentTime) }} / {{ formatTime(totalDuration) }}</span>
        <span>帧: {{ currentFrame + 1 }} / {{ totalFrames }}</span>
      </div>
    </div>

    <!-- 第二进度条：蒙版覆盖显示 -->
    <div class="progress-bar-wrapper">
      <div class="progress-label">蒙版覆盖范围</div>
      <div class="mask-coverage-bar" ref="maskCoverageBar">
        <div class="coverage-background"></div>
        <div
          v-for="(segment, index) in maskSegments"
          :key="index"
          class="coverage-segment"
          :style="{
            left: `${(segment.start / totalFrames) * 100}%`,
            width: `${((segment.end - segment.start) / totalFrames) * 100}%`
          }"
        ></div>
      </div>
    </div>

    <!-- 第三进度条：蒙版精细化编辑轨道 -->
    <div class="progress-bar-wrapper">
      <div class="progress-label">
        蒙版编辑轨道
        <q-btn-group flat>
          <q-btn flat dense icon="zoom_in" @click="zoomIn" />
          <q-btn flat dense icon="zoom_out" @click="zoomOut" />
          <q-btn flat dense icon="fit_screen" @click="resetZoom" />
        </q-btn-group>
      </div>
      <div
        class="mask-edit-track"
        ref="maskEditTrack"
        @click="addKeyframe"
        @wheel="onWheel"
      >
        <div class="track-background" :style="{ width: `${zoomLevel * 100}%` }">
          <!-- 时间刻度 -->
          <div class="time-markers">
            <div
              v-for="marker in timeMarkers"
              :key="marker.frame"
              class="time-marker"
              :style="{ left: `${(marker.frame / totalFrames) * 100}%` }"
            >
              <span>{{ formatTime(marker.time) }}</span>
            </div>
          </div>

          <!-- 关键帧标记 -->
          <div
            v-for="(keyframe) in keyframes"
            :key="keyframe.id"
            class="keyframe-marker"
            :class="{ active: selectedKeyframe === keyframe.id }"
            :style="{ left: `${(keyframe.frame / totalFrames) * 100}%` }"
            @click.stop="selectKeyframe(keyframe.id)"
            @contextmenu.prevent="deleteKeyframe(keyframe.id)"
            draggable
            @dragstart="startDragKeyframe(keyframe.id, $event)"
            @dragend="endDragKeyframe"
          >
            <q-tooltip>帧: {{ keyframe.frame + 1 }}</q-tooltip>
          </div>

          <!-- 当前帧指示器 -->
          <div
            class="current-frame-indicator"
            :style="{ left: `${(currentFrame / totalFrames) * 100}%` }"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  totalFrames: { type: Number, required: true },
  totalDuration: { type: Number, required: true },
  frameRate: { type: Number, default: 30 },
  keyframes: { type: Array, default: () => [] },
  maskSegments: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'frame-change',
  'keyframe-add',
  'keyframe-delete',
  'keyframe-select',
  'keyframe-move'
])

const currentFrame = ref(0)
const zoomLevel = ref(1)
const selectedKeyframe = ref(null)
const draggedKeyframe = ref(null)

const currentTime = computed(() => currentFrame.value / props.frameRate)

const timeMarkers = computed(() => {
  const markers = []
  const interval = Math.max(1, Math.floor(props.totalFrames / 20))
  for (let i = 0; i < props.totalFrames; i += interval) {
    markers.push({
      frame: i,
      time: i / props.frameRate
    })
  }
  return markers
})

const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

const onFrameChange = (frame) => {
  emit('frame-change', frame)
}

const addKeyframe = (event) => {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = event.clientX - rect.left
  const percentage = (x / rect.width) * zoomLevel.value
  const frame = Math.round(percentage * props.totalFrames)

  if (frame >= 0 && frame < props.totalFrames) {
    emit('keyframe-add', frame)
  }
}

const selectKeyframe = (keyframeId) => {
  selectedKeyframe.value = keyframeId
  emit('keyframe-select', keyframeId)
}

const deleteKeyframe = (keyframeId) => {
  emit('keyframe-delete', keyframeId)
}

const startDragKeyframe = (keyframeId, event) => {
  draggedKeyframe.value = keyframeId
  event.dataTransfer.effectAllowed = 'move'
}

const endDragKeyframe = (event) => {
  if (draggedKeyframe.value) {
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    const x = event.clientX - rect.left
    const percentage = (x / rect.width) * zoomLevel.value
    const newFrame = Math.round(percentage * props.totalFrames)

    if (newFrame >= 0 && newFrame < props.totalFrames) {
      emit('keyframe-move', draggedKeyframe.value, newFrame)
    }

    draggedKeyframe.value = null
  }
}

const zoomIn = () => {
  zoomLevel.value = Math.min(zoomLevel.value * 1.5, 10)
}

const zoomOut = () => {
  zoomLevel.value = Math.max(zoomLevel.value / 1.5, 1)
}

const resetZoom = () => {
  zoomLevel.value = 1
}

const onWheel = (event) => {
  if (event.ctrlKey) {
    event.preventDefault()
    if (event.deltaY < 0) {
      zoomIn()
    } else {
      zoomOut()
    }
  }
}

watch(() => props.keyframes, () => {
  if (selectedKeyframe.value && !props.keyframes.find(k => k.id === selectedKeyframe.value)) {
    selectedKeyframe.value = null
  }
}, { deep: true })

defineExpose({
  setCurrentFrame: (frame) => { currentFrame.value = frame },
  getCurrentFrame: () => currentFrame.value,
  getSelectedKeyframe: () => selectedKeyframe.value
})
</script>

<style scoped>
.video-progress-container {
  padding: 16px;
  background: #f5f5f5;
  border-radius: 8px;
}

.progress-bar-wrapper {
  margin-bottom: 20px;
}

.progress-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 500;
  color: #333;
}

.progress-info {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

.mask-coverage-bar {
  position: relative;
  height: 20px;
  background: #e0e0e0;
  border-radius: 10px;
  overflow: hidden;
}

.coverage-background {
  width: 100%;
  height: 100%;
  background: #e0e0e0;
}

.coverage-segment {
  position: absolute;
  top: 0;
  height: 100%;
  background: linear-gradient(90deg, #2196f3, #21cbf3);
  border-radius: 2px;
}

.mask-edit-track {
  position: relative;
  height: 60px;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 4px;
  overflow-x: auto;
  cursor: crosshair;
}

.track-background {
  position: relative;
  height: 100%;
  min-width: 100%;
}

.time-markers {
  position: absolute;
  top: 0;
  width: 100%;
  height: 20px;
  pointer-events: none;
}

.time-marker {
  position: absolute;
  top: 0;
  height: 100%;
  border-left: 1px solid #ccc;
  font-size: 10px;
  color: #666;
}

.time-marker span {
  position: absolute;
  left: 2px;
  top: 2px;
}

.keyframe-marker {
  position: absolute;
  top: 20px;
  width: 12px;
  height: 30px;
  background: #ff9800;
  border: 2px solid #f57c00;
  border-radius: 6px;
  cursor: pointer;
  transform: translateX(-50%);
  transition: all 0.2s;
}

.keyframe-marker:hover,
.keyframe-marker.active {
  background: #ff5722;
  border-color: #d84315;
  transform: translateX(-50%) scale(1.1);
}

.current-frame-indicator {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: #e91e63;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 10;
}
</style>
