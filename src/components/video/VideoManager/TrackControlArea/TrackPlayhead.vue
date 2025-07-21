<template>
  <div class="playhead-container">
    <div
      class="playhead"
      :style="{ left: playheadPosition + 'px' }"
      @mousedown="startDrag"
    >
      <div class="playhead-line"></div>
      <div class="playhead-handle">
        <q-icon name="play_arrow" size="12px" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  pixelsPerSecond: {
    type: Number,
    default: 50
  }
})

const videoStore = useVideoHandleManager()
const { currentTime, currentZoom, duration } = storeToRefs(videoStore)
const { setCurrentTime } = videoStore

const isDragging = ref(false)

const playheadPosition = computed(() => {
  return currentTime.value * props.pixelsPerSecond * currentZoom.value
})

function startDrag(event) {
  isDragging.value = true
  document.addEventListener('mousemove', onDrag)
  document.addEventListener('mouseup', stopDrag)
  event.preventDefault()
}

function onDrag(event) {
  if (!isDragging.value) return

  const container = event.target.closest('.track-display-area')
  if (!container) return

  const rect = container.getBoundingClientRect()
  const x = event.clientX - rect.left
  const newTime = Math.max(0, Math.min(duration.value, x / (props.pixelsPerSecond * currentZoom.value)))

  setCurrentTime(newTime)
}

function stopDrag() {
  isDragging.value = false
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
}
</script>

<style scoped>
.playhead-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 100;
}

.playhead {
  position: absolute;
  top: 0;
  height: 100%;
  pointer-events: all;
  cursor: ew-resize;
}

.playhead-line {
  width: 2px;
  height: 100%;
  background: #ff4444;
  margin-left: -1px;
}

.playhead-handle {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 16px;
  height: 16px;
  background: #ff4444;
  border: 2px solid white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.playhead-handle:hover {
  transform: scale(1.1);
}
</style>
