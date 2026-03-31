<template>
  <div class="mask-browser">
    <div class="mask-browser-header">
      <h3>蒙版管理</h3>
      <q-btn
        icon="add"
        color="primary"
        @click="addNewMask"
        label="添加蒙版"
        :disable="true"
      />
    </div>

    <div class="mask-list">
      <div
        v-for="mask in masks"
        :key="mask.id"
        class="mask-item"
        :class="{ active: mask.id === activeMaskId }"
        @click="selectMask(mask.id)"
      >
        <div class="mask-preview">
          <canvas
            :ref="el => maskPreviews[mask.id] = el"
            width="60"
            height="40"
          />
        </div>

        <div class="mask-info">
          <div class="mask-name">{{ mask.name || `蒙版 ${mask.id}` }}</div>
          <div class="mask-range">
            帧 {{ mask.start_frame }} - {{ mask.end_frame }}
          </div>
        </div>

        <div class="mask-actions">
          <q-btn
            flat
            dense
            icon="edit"
            @click.stop="editMask(mask.id)"
          />
          <q-btn
            flat
            dense
            icon="delete"
            color="negative"
            @click.stop="deleteMask(mask.id)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useQuasar } from 'quasar'

const $q = useQuasar()

// Props
const props = defineProps({
  masks: {
    type: [Array, Map],
    default: () => []
  },
  activeMaskId: {
    type: [String, Number],
    default: null
  },
  currentFrame: {
    type: Number,
    default: 0
  }
})

// Emits
const emit = defineEmits([
  'select-mask',
  'add-mask',
  'delete-mask',
  'edit-mask'
])

// 响应式数据
const maskPreviews = ref({})

// 计算属性
const masksArray = computed(() => {
  return Array.isArray(props.masks) ? props.masks : Array.from(props.masks.values())
})

// 方法
const selectMask = (maskId) => {
  emit('select-mask', maskId)
}

const addNewMask = () => {
  emit('add-mask')
}

const editMask = (maskId) => {
  emit('edit-mask', maskId)
}

const deleteMask = (maskId) => {
  $q.dialog({
    title: '确认删除',
    message: '确定要删除这个蒙版吗？此操作不可撤销。',
    cancel: true,
    persistent: true
  }).onOk(() => {
    emit('delete-mask', maskId)
  })
}

// 绘制蒙版预览
const drawMaskPreview = (mask) => {
  const canvas = maskPreviews.value[mask.id]
  if (!canvas || !mask.mask_data) return

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  try {
    // 如果mask_data是base64格式
    if (typeof mask.mask_data === 'string' && mask.mask_data.startsWith('data:image')) {
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      }
      img.src = mask.mask_data
    } else {
      // 绘制简单的预览图形
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
      ctx.fillRect(10, 10, canvas.width - 20, canvas.height - 20)
      ctx.strokeStyle = '#1976d2'
      ctx.lineWidth = 2
      ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
    }
  } catch (error) {
    console.warn('绘制蒙版预览失败:', error)
  }
}

// 监听器
watch(() => props.masks, (newMasks, oldMasks) => {
  // 使用newMasks参数，确保变量被读取
  console.log('蒙版列表更新:', newMasks)

  nextTick(() => {
    // 重新绘制所有蒙版预览
    masksArray.value.forEach(mask => {
      drawMaskPreview(mask)
    })

    // 检查是否有新增的蒙版需要特殊处理
    if (oldMasks && Array.isArray(oldMasks)) {
      const newMaskIds = masksArray.value.map(m => m.id)
      const oldMaskIds = oldMasks.map(m => m.id)

      const addedMasks = newMaskIds.filter(id => !oldMaskIds.includes(id))
      const removedMasks = oldMaskIds.filter(id => !newMaskIds.includes(id))

      if (addedMasks.length > 0) {
        console.log('新增蒙版:', addedMasks)
      }

      if (removedMasks.length > 0) {
        console.log('删除蒙版:', removedMasks)
        // 清理已删除蒙版的预览canvas引用
        removedMasks.forEach(maskId => {
          delete maskPreviews.value[maskId]
        })
      }
    }
  })
}, { deep: true, immediate: true })

// 监听当前帧变化，更新蒙版预览的高亮状态
watch(() => props.currentFrame, (newFrame) => {
  // 更新蒙版项的当前帧状态显示
  masksArray.value.forEach(mask => {
    const isCurrentFrameInRange = newFrame >= mask.start_frame && newFrame <= mask.end_frame

    // 可以在这里添加视觉反馈，比如高亮当前帧范围内的蒙版
    if (isCurrentFrameInRange) {
      // 重新绘制预览以显示当前状态
      drawMaskPreview(mask)
    }
  })
})

// 监听活动蒙版ID变化
watch(() => props.activeMaskId, (newActiveMaskId, oldActiveMaskId) => {
  // 更新蒙版选中状态的视觉反馈
  if (oldActiveMaskId && maskPreviews.value[oldActiveMaskId]) {
    // 移除旧的活动状态
    const oldCanvas = maskPreviews.value[oldActiveMaskId]
    if (oldCanvas) {
      oldCanvas.style.border = '1px solid #e0e0e0'
    }
  }

  if (newActiveMaskId && maskPreviews.value[newActiveMaskId]) {
    // 添加新的活动状态
    const newCanvas = maskPreviews.value[newActiveMaskId]
    if (newCanvas) {
      newCanvas.style.border = '2px solid #1976d2'
    }
  }
})

// 生命周期
onMounted(() => {
  nextTick(() => {
    masksArray.value.forEach(mask => {
      drawMaskPreview(mask)
    })
  })
})
</script>

<style scoped>
.mask-browser {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.mask-browser-header {
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mask-browser-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

.mask-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.mask-item {
  display: flex;
  align-items: center;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mask-item:hover {
  background-color: #f5f5f5;
  border-color: #1976d2;
}

.mask-item.active {
  background-color: #e3f2fd;
  border-color: #1976d2;
}

.mask-preview {
  margin-right: 12px;
}

.mask-preview canvas {
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #f9f9f9;
}

.mask-info {
  flex: 1;
  min-width: 0;
}

.mask-name {
  font-weight: 500;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mask-range {
  font-size: 12px;
  color: #666;
}

.mask-actions {
  display: flex;
  gap: 4px;
}
</style>
