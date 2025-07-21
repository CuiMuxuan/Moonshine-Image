<template>
  <div class="thumbnail" @click="onPreview">
    <canvas
      ref="thumbnailCanvas"
      :width="32"
      :height="24"
      class="thumbnail-canvas"
    ></canvas>
    <q-tooltip>预览蒙版</q-tooltip>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'

const props = defineProps({
  mask: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['preview'])

const thumbnailCanvas = ref(null)

function renderThumbnail() {
  if (!thumbnailCanvas.value || !props.mask.keyframes.length) return

  const canvas = thumbnailCanvas.value
  const ctx = canvas.getContext('2d')

  // 清空画布
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 获取第一个关键帧的数据作为缩略图
  const firstKeyframe = props.mask.keyframes[0]
  if (!firstKeyframe?.maskData) return

  const maskData = firstKeyframe.maskData
  ctx.fillStyle = props.mask.color || 'rgba(76, 175, 80, 0.8)'

  if (maskData.type === 'polygon' && maskData.points) {
    ctx.beginPath()
    maskData.points.forEach((point, index) => {
      const x = point.x * canvas.width
      const y = point.y * canvas.height
      if (index === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    })
    ctx.closePath()
    ctx.fill()
  } else if (maskData.type === 'rectangle' && maskData.rect) {
    const x = maskData.rect.x * canvas.width
    const y = maskData.rect.y * canvas.height
    const width = maskData.rect.width * canvas.width
    const height = maskData.rect.height * canvas.height
    ctx.fillRect(x, y, width, height)
  }
}

function onPreview() {
  emit('preview', props.mask)
}

watch(() => props.mask, renderThumbnail, { deep: true })

onMounted(() => {
  renderThumbnail()
})
</script>

<style scoped>
.thumbnail {
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid #ddd;
  transition: transform 0.2s ease;
}

.thumbnail:hover {
  transform: scale(1.1);
}

.thumbnail-canvas {
  display: block;
  background: #f5f5f5;
}
</style>
