<template>
  <div class="mask-renderer" v-if="activeMask">
    <canvas
      ref="maskCanvas"
      class="mask-canvas"
      :width="videoWidth"
      :height="videoHeight"
    ></canvas>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useMaskInterpolation } from '../../../composables/useMaskInterpolation'

const props = defineProps({
  activeMask: {
    type: Object,
    default: null
  },
  currentTime: {
    type: Number,
    required: true
  },
  videoWidth: {
    type: Number,
    required: true
  },
  videoHeight: {
    type: Number,
    required: true
  }
})

const maskCanvas = ref(null)
const { getCurrentMaskData } = useMaskInterpolation()

// 监听遮罩变化，重新渲染
watch([() => props.activeMask, () => props.currentTime], () => {
  renderMask()
}, { deep: true })

function renderMask() {
  if (!maskCanvas.value || !props.activeMask) return

  const canvas = maskCanvas.value
  const ctx = canvas.getContext('2d')

  // 清空画布
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 获取当前时间对应的遮罩数据
  const maskData = getCurrentMaskData(props.activeMask, props.currentTime)
  if (!maskData) return

  // 渲染遮罩
  ctx.fillStyle = maskData.color || 'rgba(255, 0, 0, 0.5)'

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

onMounted(() => {
  renderMask()
})
</script>
