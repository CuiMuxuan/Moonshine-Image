<template>
  <q-btn
    color="primary"
    icon="add"
    label="添加关键帧"
    @click="onAddKeyframe"
    :disable="!canAddKeyframe"
    class="full-width"
  />
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const videoStore = useVideoHandleManager()
const { currentTime } = storeToRefs(videoStore)

const canAddKeyframe = computed(() => {
  // 检查当前时间是否已经有关键帧
  return !props.mask.keyframes.some(kf => Math.abs(kf.time - currentTime.value) < 0.1)
})

function onAddKeyframe() {
  if (!canAddKeyframe.value) return

  // 获取当前时间最近的关键帧数据作为基础
  const nearestKeyframe = props.mask.keyframes
    .filter(kf => kf.time <= currentTime.value)
    .sort((a, b) => b.time - a.time)[0] || props.mask.keyframes[0]

  const newKeyframe = {
    time: currentTime.value,
    maskData: { ...nearestKeyframe.maskData },
    transform: { ...nearestKeyframe.transform }
  }

  const updatedMask = {
    ...props.mask,
    keyframes: [...props.mask.keyframes, newKeyframe]
      .sort((a, b) => a.time - b.time)
  }

  videoStore.updateMask(props.mask.id, updatedMask)
}
</script>
