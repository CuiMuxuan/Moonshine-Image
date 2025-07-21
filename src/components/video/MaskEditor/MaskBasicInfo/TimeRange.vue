<template>
  <div class="time-range">
    <q-input
      v-model.number="localStartTime"
      label="开始时间"
      type="number"
      outlined
      dense
      :min="0"
      :max="duration"
      @update:model-value="onStartTimeChange"
    />

    <q-input
      v-model.number="localEndTime"
      label="结束时间"
      type="number"
      outlined
      dense
      :min="localStartTime"
      :max="duration"
      @update:model-value="onEndTimeChange"
    />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const videoStore = useVideoHandleManager()
const { duration } = storeToRefs(videoStore)

const localStartTime = ref(props.mask.startTime)
const localEndTime = ref(props.mask.endTime)

function onStartTimeChange(newStartTime) {
  const updatedMask = {
    ...props.mask,
    startTime: Math.max(0, Math.min(newStartTime, props.mask.endTime - 0.1))
  }
  videoStore.updateMask(props.mask.id, updatedMask)
}

function onEndTimeChange(newEndTime) {
  const updatedMask = {
    ...props.mask,
    endTime: Math.min(duration.value, Math.max(newEndTime, props.mask.startTime + 0.1))
  }
  videoStore.updateMask(props.mask.id, updatedMask)
}

watch(() => props.mask.startTime, (newTime) => {
  localStartTime.value = newTime
})

watch(() => props.mask.endTime, (newTime) => {
  localEndTime.value = newTime
})
</script>

<style scoped>
.time-range {
  display: flex;
  gap: 12px;
}
</style>
