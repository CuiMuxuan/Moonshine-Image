<template>
  <div class="timeline-ruler">
    <div class="ruler-track" :style="{ width: totalWidth + 'px' }">
      <div
        v-for="mark in timeMarks"
        :key="mark.time"
        class="time-mark"
        :class="{ major: mark.isMajor }"
        :style="{ left: mark.position + 'px' }"
      >
        <div class="mark-line"></div>
        <div v-if="mark.isMajor" class="mark-label">{{ formatTime(mark.time) }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  pixelsPerSecond: {
    type: Number,
    default: 50
  }
})

const videoStore = useVideoHandleManager()
const { duration, currentZoom } = storeToRefs(videoStore)

const totalWidth = computed(() => {
  return duration.value * props.pixelsPerSecond * currentZoom.value
})

const timeMarks = computed(() => {
  const marks = []
  const interval = currentZoom.value > 2 ? 0.5 : currentZoom.value > 1 ? 1 : 5

  for (let time = 0; time <= duration.value; time += interval) {
    const position = time * props.pixelsPerSecond * currentZoom.value
    const isMajor = time % (interval * 5) === 0

    marks.push({
      time,
      position,
      isMajor
    })
  }

  return marks
})

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.timeline-ruler {
  height: 30px;
  background: #f8f9fa;
  border-bottom: 1px solid #e0e0e0;
  overflow: hidden;
  position: relative;
}

.ruler-track {
  position: relative;
  height: 100%;
}

.time-mark {
  position: absolute;
  height: 100%;
}

.mark-line {
  width: 1px;
  background: #ccc;
  height: 8px;
  margin-top: 22px;
}

.time-mark.major .mark-line {
  height: 12px;
  margin-top: 18px;
  background: #666;
}

.mark-label {
  position: absolute;
  top: 2px;
  left: 2px;
  font-size: 10px;
  color: #666;
  white-space: nowrap;
}
</style>
