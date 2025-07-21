<template>
  <div class="keyframe-markers" ref="markersContainer">
    <div
      v-for="(keyframe, index) in mask.keyframes"
      :key="index"
      class="keyframe-marker"
      :class="{ selected: selectedKeyframeIndex === index }"
      :style="{
        left: (keyframe.time * pixelsPerSecond * zoom) + 'px'
      }"
      @mousedown="startDragKeyframe(index, $event)"
      @click="selectKeyframe(index)"
    >
      <q-tooltip>{{ formatTime(keyframe.time) }}</q-tooltip>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  },
  zoom: {
    type: Number,
    default: 1
  },
  pixelsPerSecond: {
    type: Number,
    default: 50
  }
})

const emit = defineEmits(['keyframe-select', 'keyframe-move'])

const markersContainer = ref(null)
const selectedKeyframeIndex = ref(-1)
const isDragging = ref(false)
const dragStartX = ref(0)
const dragKeyframeIndex = ref(-1)

function selectKeyframe(index) {
  selectedKeyframeIndex.value = index
  emit('keyframe-select', props.mask.id, index)
}

function startDragKeyframe(index, event) {
  if (index === 0 || index === props.mask.keyframes.length - 1) {
    // 不允许拖动开始和结束关键帧
    return
  }

  isDragging.value = true
  dragKeyframeIndex.value = index
  dragStartX.value = event.clientX

  document.addEventListener('mousemove', onDragKeyframe)
  document.addEventListener('mouseup', stopDragKeyframe)
}

function onDragKeyframe(event) {
  if (!isDragging.value) return

  const deltaX = event.clientX - dragStartX.value
  const deltaTime = deltaX / (props.pixelsPerSecond * props.zoom)
  const originalTime = props.mask.keyframes[dragKeyframeIndex.value].time
  const newTime = Math.max(0, originalTime + deltaTime)

  emit('keyframe-move', props.mask.id, dragKeyframeIndex.value, newTime)
}

function stopDragKeyframe() {
  isDragging.value = false
  dragKeyframeIndex.value = -1
  document.removeEventListener('mousemove', onDragKeyframe)
  document.removeEventListener('mouseup', stopDragKeyframe)
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.keyframe-markers {
  position: relative;
  flex: 1;
  height: 100%;
}

.keyframe-marker {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #ff9800;
  border: 1px solid white;
  border-radius: 50%;
  top: 50%;
  transform: translateY(-50%);
  cursor: pointer;
  transition: all 0.2s ease;
}

.keyframe-marker:hover {
  transform: translateY(-50%) scale(1.2);
}

.keyframe-marker.selected {
  background: #2196f3;
  transform: translateY(-50%) scale(1.3);
}
</style>
