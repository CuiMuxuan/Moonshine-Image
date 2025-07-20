<template>
  <div class="video-mask-editor">
    <!-- 视频预览区域 -->
    <div class="video-preview-container" ref="previewContainer">
      <div class="video-canvas-wrapper" :style="canvasWrapperStyle">
        <!-- 视频帧显示 -->
        <canvas
          ref="videoCanvas"
          :width="canvasWidth"
          :height="canvasHeight"
          class="video-canvas"
        />

        <!-- 蒙版编辑层 -->
        <image-masker
          v-if="showMaskEditor"
          ref="maskEditorRef"
          :image-url="currentFrameUrl"
          :mask="currentMask"
          :width="canvasWidth"
          :height="canvasHeight"
          :drawing-mode="maskEditMode === 'draw'"
          @mask-change="onMaskChange"
          class="mask-editor-overlay"
        />

        <!-- 蒙版预览层 -->
        <canvas
          v-if="showMaskPreview && !showMaskEditor"
          ref="maskPreviewCanvas"
          :width="canvasWidth"
          :height="canvasHeight"
          class="mask-preview-overlay"
        />
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="mask-editor-toolbar">
      <div class="toolbar-section">
        <q-btn-group flat>
          <q-btn
            flat
            :color="maskEditMode === 'draw' ? 'primary' : 'grey'"
            icon="brush"
            label="绘制蒙版"
            @click="enterDrawMode"
          />
          <q-btn
            flat
            :color="maskEditMode === 'adjust' ? 'primary' : 'grey'"
            icon="transform"
            label="调整蒙版"
            @click="enterAdjustMode"
            :disable="!hasMaskAtCurrentFrame"
          />
        </q-btn-group>
      </div>

      <div class="toolbar-section">
        <q-btn-group flat>
          <q-btn
            flat
            icon="visibility"
            :color="showMaskPreview ? 'primary' : 'grey'"
            @click="toggleMaskPreview"
            tooltip="切换蒙版预览"
          />
          <q-btn
            flat
            icon="delete"
            color="negative"
            @click="deleteMaskAtCurrentFrame"
            :disable="!hasMaskAtCurrentFrame"
            tooltip="删除当前帧蒙版"
          />
        </q-btn-group>
      </div>

      <q-space />

      <div class="toolbar-section">
        <q-btn
          flat
          color="positive"
          icon="save"
          label="保存蒙版"
          @click="saveMask"
          :disable="!hasUnsavedChanges"
        />
        <q-btn
          flat
          color="warning"
          icon="cancel"
          label="取消编辑"
          @click="cancelEdit"
          v-if="showMaskEditor"
        />
      </div>
    </div>

    <!-- 蒙版调整工具 -->
    <div v-if="maskEditMode === 'adjust' && showMaskAdjustTools" class="mask-adjust-tools">
      <div class="adjust-controls">
        <div class="control-group">
          <label>位置 X:</label>
          <q-slider
            v-model="maskTransform.x"
            :min="-canvasWidth"
            :max="canvasWidth"
            @update:model-value="updateMaskTransform"
          />
        </div>
        <div class="control-group">
          <label>位置 Y:</label>
          <q-slider
            v-model="maskTransform.y"
            :min="-canvasHeight"
            :max="canvasHeight"
            @update:model-value="updateMaskTransform"
          />
        </div>
        <div class="control-group">
          <label>缩放:</label>
          <q-slider
            v-model="maskTransform.scale"
            :min="0.1"
            :max="3"
            :step="0.1"
            @update:model-value="updateMaskTransform"
          />
        </div>
        <div class="control-group">
          <label>旋转:</label>
          <q-slider
            v-model="maskTransform.rotation"
            :min="-180"
            :max="180"
            @update:model-value="updateMaskTransform"
          />
        </div>
      </div>

      <div class="adjust-actions">
        <q-btn
          flat
          color="positive"
          icon="check"
          label="确认调整"
          @click="confirmMaskAdjustment"
        />
        <q-btn
          flat
          color="negative"
          icon="refresh"
          label="重置"
          @click="resetMaskTransform"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useQuasar } from 'quasar'
import ImageMasker from './ImageMasker.vue'
import { useVideoMaskStore } from '../stores/videoMask'
import { useVideoProcessingStore } from '../stores/videoProcessing'
import { videoService } from '../services/VideoService'

const props = defineProps({
  videoFile: {
    type: Object,
    default: null
  },
  currentFrame: {
    type: Number,
    default: 0
  },
  videoInfo: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits([
  'mask-saved',
  'mask-deleted',
  'edit-mode-change'
])

const $q = useQuasar()
const videoMaskStore = useVideoMaskStore()
const videoProcessingStore = useVideoProcessingStore()

// 响应式数据
const previewContainer = ref(null)
const videoCanvas = ref(null)
const maskPreviewCanvas = ref(null)
const maskEditorRef = ref(null)

const maskEditMode = ref('draw') // 'draw' | 'adjust'
const showMaskEditor = ref(false)
const showMaskPreview = ref(true)
const showMaskAdjustTools = ref(false)
const hasUnsavedChanges = ref(false)

const currentFrameUrl = ref('')
const currentMask = ref(null)

// 画布尺寸
const canvasWidth = computed(() => props.videoInfo.width || 800)
const canvasHeight = computed(() => props.videoInfo.height || 600)
const canvasWrapperStyle = computed(() => ({
  width: canvasWidth.value + 'px',
  height: canvasHeight.value + 'px'
}))

// 蒙版变换参数
const maskTransform = ref({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0
})

// 当前帧是否有蒙版
const hasMaskAtCurrentFrame = computed(() => {
  const masks = Array.from(videoProcessingStore.masks.values())
  return masks.some(mask =>
    props.currentFrame >= mask.start_frame &&
    props.currentFrame <= mask.end_frame
  )
})

// 方法
const loadCurrentFrame = async () => {
  if (!props.videoFile) return

  try {
    const timestamp = props.currentFrame / (props.videoInfo.frameRate || 30)
    const frameData = await videoService.extractFrame(props.videoFile.path, timestamp)
    currentFrameUrl.value = `data:image/png;base64,${frameData}`

    // 绘制到画布
    await drawFrameToCanvas(frameData)

    // 加载当前帧的蒙版
    loadCurrentFrameMask()

    // 更新蒙版预览
    if (showMaskPreview.value) {
      updateMaskPreview()
    }
  } catch (error) {
    console.error('加载当前帧失败:', error)
    $q.notify({
      type: 'negative',
      message: '加载视频帧失败',
      position: 'top'
    })
  }
}

const drawFrameToCanvas = async (frameData) => {
  const canvas = videoCanvas.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  const img = new Image()

  return new Promise((resolve) => {
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve()
    }
    img.src = `data:image/png;base64,${frameData}`
  })
}

const loadCurrentFrameMask = () => {
  const masks = Array.from(videoProcessingStore.masks.values())
    .filter(mask =>
      props.currentFrame >= mask.start_frame &&
      props.currentFrame <= mask.end_frame
    )

  if (masks.length > 0) {
    currentMask.value = masks[masks.length - 1]
  } else {
    currentMask.value = null
  }
}

const updateMaskPreview = () => {
  if (!showMaskPreview.value || !currentMask.value) return

  const canvas = maskPreviewCanvas.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 绘制蒙版预览
  const img = new Image()
  img.onload = () => {
    ctx.globalAlpha = 0.5
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    ctx.globalAlpha = 1
  }
  img.src = currentMask.value.data
}

const enterDrawMode = () => {
  if (maskEditMode.value === 'adjust' && hasUnsavedChanges.value) {
    $q.dialog({
      title: '确认切换',
      message: '当前有未保存的调整，是否保存后切换到绘制模式？',
      cancel: true,
      persistent: true
    }).onOk(() => {
      confirmMaskAdjustment()
      switchToDrawMode()
    }).onCancel(() => {
      resetMaskTransform()
      switchToDrawMode()
    })
  } else {
    switchToDrawMode()
  }
}

const switchToDrawMode = () => {
  maskEditMode.value = 'draw'
  showMaskEditor.value = true
  showMaskAdjustTools.value = false
  videoMaskStore.maskEditMode.value = 'draw'
  emit('edit-mode-change', 'draw')
}

const enterAdjustMode = () => {
  if (!hasMaskAtCurrentFrame.value) {
    $q.notify({
      type: 'warning',
      message: '当前帧没有蒙版，无法进行调整',
      position: 'top'
    })
    return
  }

  maskEditMode.value = 'adjust'
  showMaskEditor.value = false
  showMaskAdjustTools.value = true
  resetMaskTransform()
  videoMaskStore.maskEditMode.value = 'adjust'
  emit('edit-mode-change', 'adjust')
}

const onMaskChange = (maskData) => {
  hasUnsavedChanges.value = true
  currentMask.value = {
    id: Date.now(),
    data: maskData,
    createdAt: Date.now(),
    type: 'user-drawn'
  }
}

const saveMask = () => {
  if (!currentMask.value) {
    $q.notify({
      type: 'warning',
      message: '没有蒙版数据可保存',
      position: 'top'
    })
    return
  }

  // 检查当前帧是否已有蒙版
  const existingMasks = videoMaskStore.getMasksAtTimestamp(props.currentFrame)

  if (existingMasks.length > 0) {
    $q.dialog({
      title: '蒙版冲突',
      message: '当前帧已存在蒙版，请选择处理方式：',
      options: {
        type: 'radio',
        model: 'merge',
        items: [
          { label: '合并蒙版', value: 'merge' },
          { label: '使用新蒙版', value: 'new' },
          { label: '保留旧蒙版', value: 'old' }
        ]
      },
      cancel: true,
      persistent: true
    }).onOk((action) => {
      handleMaskConflict(action)
    })
  } else {
    // 直接保存
    videoMaskStore.addKeyframeMask(props.currentFrame, currentMask.value.data)
    hasUnsavedChanges.value = false
    showMaskEditor.value = false

    $q.notify({
      type: 'positive',
      message: '蒙版保存成功',
      position: 'top'
    })

    emit('mask-saved', props.currentFrame)
  }
}

const handleMaskConflict = (action) => {
  switch (action) {
    case 'merge':
      // 实现蒙版合并逻辑
      mergeMasks()
      break
    case 'new':
      // 替换为新蒙版
      videoMaskStore.keyframes.value.set(props.currentFrame, [currentMask.value])
      break
    case 'old':
      // 保留旧蒙版，不做任何操作
      break
  }

  hasUnsavedChanges.value = false
  showMaskEditor.value = false
  emit('mask-saved', props.currentFrame)
}

const mergeMasks = () => {
  // 简化的蒙版合并实现
  videoMaskStore.addKeyframeMask(props.currentFrame, currentMask.value.data)
}

const deleteMaskAtCurrentFrame = () => {
  $q.dialog({
    title: '确认删除',
    message: '确定要删除当前帧的所有蒙版吗？此操作不可撤销。',
    cancel: true,
    persistent: true
  }).onOk(() => {
    videoMaskStore.keyframes.value.delete(props.currentFrame)
    currentMask.value = null
    hasUnsavedChanges.value = false

    $q.notify({
      type: 'positive',
      message: '蒙版删除成功',
      position: 'top'
    })

    emit('mask-deleted', props.currentFrame)
  })
}

const cancelEdit = () => {
  if (hasUnsavedChanges.value) {
    $q.dialog({
      title: '确认取消',
      message: '有未保存的更改，确定要取消编辑吗？',
      cancel: true,
      persistent: true
    }).onOk(() => {
      doCancel()
    })
  } else {
    doCancel()
  }
}

const doCancel = () => {
  showMaskEditor.value = false
  showMaskAdjustTools.value = false
  hasUnsavedChanges.value = false
  loadCurrentFrameMask() // 重新加载原始蒙版
  emit('edit-mode-change', null)
}

const toggleMaskPreview = () => {
  showMaskPreview.value = !showMaskPreview.value
  if (showMaskPreview.value) {
    nextTick(() => updateMaskPreview())
  }
}

const updateMaskTransform = () => {
  hasUnsavedChanges.value = true
  // 实现蒙版变换预览
}

const confirmMaskAdjustment = () => {
  // 应用变换到蒙版数据
  if (currentMask.value && hasUnsavedChanges.value) {
    // 这里需要实现将变换应用到蒙版数据的逻辑
    const transformedMaskData = applyTransformToMask(currentMask.value.data, maskTransform.value)

    videoMaskStore.updateKeyframeMask(
      props.currentFrame,
      currentMask.value.id,
      transformedMaskData
    )

    hasUnsavedChanges.value = false
    showMaskAdjustTools.value = false

    $q.notify({
      type: 'positive',
      message: '蒙版调整已保存',
      position: 'top'
    })

    emit('mask-saved', props.currentFrame)
  }
}

const resetMaskTransform = () => {
  maskTransform.value = {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0
  }
  hasUnsavedChanges.value = false
}

const applyTransformToMask = (maskData, transform) => {
  if (!maskData || !transform) return maskData

  try {
    // 创建临时canvas进行变换
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')

    // 设置canvas尺寸
    canvas.width = canvasWidth.value
    canvas.height = canvasHeight.value

    // 创建图像对象
    const img = new Image()

    return new Promise((resolve) => {
      img.onload = () => {
        // 应用变换
        ctx.save()
        ctx.translate(transform.x || 0, transform.y || 0)
        ctx.scale(transform.scaleX || 1, transform.scaleY || 1)
        ctx.rotate((transform.rotation || 0) * Math.PI / 180)

        // 绘制蒙版
        ctx.drawImage(img, -img.width / 2, -img.height / 2)
        ctx.restore()

        // 返回变换后的数据
        resolve(canvas.toDataURL())
      }

      img.src = maskData
    })
  } catch (error) {
    console.error('应用蒙版变换失败:', error)
    return maskData
  }
}

// 监听当前帧变化
watch(() => props.currentFrame, () => {
  loadCurrentFrame()
})

// 监听视频文件变化
watch(() => props.videoFile, () => {
  if (props.videoFile) {
    loadCurrentFrame()
  }
})

// 组件挂载时加载当前帧
onMounted(() => {
  if (props.videoFile) {
    loadCurrentFrame()
  }
})
</script>

<style scoped>
.video-mask-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.video-preview-container {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  background: #f0f0f0;
  overflow: auto;
}

.video-canvas-wrapper {
  position: relative;
  border: 1px solid #ddd;
  background: white;
}

.video-canvas {
  display: block;
}

.mask-editor-overlay,
.mask-preview-overlay {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.mask-editor-overlay {
  pointer-events: auto;
}

.mask-editor-toolbar {
  display: flex;
  align-items: center;
  padding: 12px;
  background: white;
  border-top: 1px solid #e0e0e0;
  gap: 16px;
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mask-adjust-tools {
  padding: 16px;
  background: #f8f8f8;
  border-top: 1px solid #e0e0e0;
}

.adjust-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.control-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.control-group label {
  font-weight: 500;
  font-size: 14px;
}

.adjust-actions {
  display: flex;
  justify-content: center;
  gap: 16px;
}
</style>
