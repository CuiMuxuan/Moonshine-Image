<template>
  <q-btn
    color="primary"
    icon="add"
    label="添加蒙版"
    @click="onAdd"
    class="full-width"
  />
</template>

<script setup>
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()

function onAdd() {
  const newMask = {
    id: `mask_${Date.now()}`,
    name: `蒙版 ${videoStore.maskList.length + 1}`,
    color: getRandomColor(),
    startTime: videoStore.currentTime,
    endTime: Math.min(videoStore.currentTime + 5, videoStore.duration),
    visible: true,
    keyframes: [
      {
        time: videoStore.currentTime,
        maskData: {
          type: 'rectangle',
          rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
        },
        transform: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 }
      }
    ]
  }

  videoStore.addMask(newMask)
}

function getRandomColor() {
  const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#00BCD4']
  return colors[Math.floor(Math.random() * colors.length)]
}
</script>
