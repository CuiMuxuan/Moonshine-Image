<template>
  <div class="mask-tracks">
    <div
      v-for="mask in maskList"
      :key="mask.id"
      class="mask-track-item"
      :class="{ active: mask.id === activeMaskId }"
      @click="onMaskSelect(mask.id)"
    >
      <TrackColorBar :color="mask.color" />
      <TrackName :name="mask.name" />
      <KeyframeMarkers
        :mask="mask"
        :zoom="currentZoom"
        :pixels-per-second="pixelsPerSecond"
        @keyframe-select="onKeyframeSelect"
        @keyframe-move="onKeyframeMove"
      />
    </div>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import TrackColorBar from './TrackColorBar.vue'
import TrackName from './TrackName.vue'
import KeyframeMarkers from './KeyframeMarkers.vue'

defineProps({
  pixelsPerSecond: {
    type: Number,
    default: 50
  }
})

const emit = defineEmits(['keyframe-select', 'keyframe-move'])

const videoStore = useVideoHandleManager()
const { maskList, activeMaskId, currentZoom } = storeToRefs(videoStore)
const { onMaskSelect } = videoStore

function onKeyframeSelect(maskId, keyframeIndex) {
  emit('keyframe-select', maskId, keyframeIndex)
}

function onKeyframeMove(maskId, keyframeIndex, newTime) {
  emit('keyframe-move', maskId, keyframeIndex, newTime)
}
</script>

<style scoped>
.mask-tracks {
  display: flex;
  flex-direction: column;
}

.mask-track-item {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 4px 8px;
  border-bottom: 1px solid #e0e0e0;
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.mask-track-item:hover {
  background-color: #f5f5f5;
}

.mask-track-item.active {
  background-color: #e3f2fd;
  border-left: 3px solid #2196f3;
}
</style>
