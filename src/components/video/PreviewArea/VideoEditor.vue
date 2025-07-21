<template>
  <div class="video-editor" v-if="isEditMode">
    <!-- 可拖动的工具栏 -->
    <div
      class="floating-toolbar"
      :style="toolbarStyle"
      @mousedown="startDragToolbar"
    >
      <q-btn-group>
        <q-btn
          :color="tool === 'select' ? 'primary' : 'grey-5'"
          icon="near_me"
          @click="setTool('select')"
          dense
        >
          <q-tooltip>选择工具</q-tooltip>
        </q-btn>
        <q-btn
          :color="tool === 'rectangle' ? 'primary' : 'grey-5'"
          icon="crop_free"
          @click="setTool('rectangle')"
          dense
        >
          <q-tooltip>矩形工具</q-tooltip>
        </q-btn>
        <q-btn
          :color="tool === 'polygon' ? 'primary' : 'grey-5'"
          icon="polyline"
          @click="setTool('polygon')"
          dense
        >
          <q-tooltip>多边形工具</q-tooltip>
        </q-btn>
      </q-btn-group>

      <q-separator vertical />

      <q-btn
        icon="aspect_ratio"
        @click="resetToOriginalRatio"
        dense
        color="grey-7"
      >
        <q-tooltip>原图比例</q-tooltip>
      </q-btn>

      <q-btn
        icon="transform"
        @click="enableFreeTransform"
        dense
        color="grey-7"
      >
        <q-tooltip>自由变换</q-tooltip>
      </q-btn>
    </div>

    <!-- 蒙版编辑覆盖层 -->
    <div class="mask-edit-overlay" v-if="activeMask">
      <canvas
        ref="editCanvas"
        class="edit-canvas"
        :width="canvasWidth"
        :height="canvasHeight"
        @mousedown="onCanvasMouseDown"
        @mousemove="onCanvasMouseMove"
        @mouseup="onCanvasMouseUp"
        @click="onCanvasClick"
      ></canvas>

      <!-- 变换控制点 -->
      <div
        v-if="tool === 'select' && selectedMask"
        class="transform-controls"
      >
        <div
          v-for="(handle, index) in transformHandles"
          :key="index"
          class="transform-handle"
          :class="handle.type"
          :style="handle.style"
          @mousedown="startTransform(handle, $event)"
        ></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { activeMask, currentMode, currentTime } = storeToRefs(videoStore)

const editCanvas = ref(null)
const tool = ref('select')
const canvasWidth = ref(800)
const canvasHeight = ref(600)
const selectedMask = ref(null)
const isDrawing = ref(false)
const currentPath = ref([])

// 工具栏拖拽相关
const toolbarPosition = ref({ x: 20, y: 20 })
const isDraggingToolbar = ref(false)
const dragOffset = ref({ x: 0, y: 0 })

const isEditMode = computed(() => currentMode.value === 'edit')

const toolbarStyle = computed(() => ({
  left: toolbarPosition.value.x + 'px',
  top: toolbarPosition.value.y + 'px'
}))

const transformHandles = computed(() => {
  if (!selectedMask.value) return []

  const mask = selectedMask.value
  const rect = mask.currentRect || { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }

  const x = rect.x * canvasWidth.value
  const y = rect.y * canvasHeight.value
  const w = rect.width * canvasWidth.value
  const h = rect.height * canvasHeight.value

  return [
    // 四个角
    { type: 'corner nw', style: { left: x - 4 + 'px', top: y - 4 + 'px' } },
    { type: 'corner ne', style: { left: x + w - 4 + 'px', top: y - 4 + 'px' } },
    { type: 'corner sw', style: { left: x - 4 + 'px', top: y + h - 4 + 'px' } },
    { type: 'corner se', style: { left: x + w - 4 + 'px', top: y + h - 4 + 'px' } },
    // 四边中点
    { type: 'edge n', style: { left: x + w/2 - 4 + 'px', top: y - 4 + 'px' } },
    { type: 'edge s', style: { left: x + w/2 - 4 + 'px', top: y + h - 4 + 'px' } },
    { type: 'edge w', style: { left: x - 4 + 'px', top: y + h/2 - 4 + 'px' } },
    { type: 'edge e', style: { left: x + w - 4 + 'px', top: y + h/2 - 4 + 'px' } }
  ]
})

function setTool(newTool) {
  tool.value = newTool
  selectedMask.value = null
}

function resetToOriginalRatio() {
  if (selectedMask.value) {
    // 重置为原始比例
    updateMaskTransform(selectedMask.value, {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1
    })
  }
}

function enableFreeTransform() {
  tool.value = 'select'
}

function onCanvasMouseDown(event) {
  const rect = editCanvas.value.getBoundingClientRect()
  const x = (event.clientX - rect.left) / canvasWidth.value
  const y = (event.clientY - rect.top) / canvasHeight.value

  if (tool.value === 'rectangle') {
    startDrawingRectangle(x, y)
  } else if (tool.value === 'polygon') {
    addPolygonPoint(x, y)
  } else if (tool.value === 'select') {
    selectMaskAt(x, y)
  }
}

function onCanvasMouseMove(event) {
  if (!isDrawing.value) return

  const rect = editCanvas.value.getBoundingClientRect()
  const x = (event.clientX - rect.left) / canvasWidth.value
  const y = (event.clientY - rect.top) / canvasHeight.value

  if (tool.value === 'rectangle') {
    updateDrawingRectangle(x, y)
  }

  // 更新鼠标样式
  updateCursor(x, y)
}

function onCanvasMouseUp() {
  if (isDrawing.value && tool.value === 'rectangle') {
    finishDrawingRectangle()
  }
  isDrawing.value = false
}

function onCanvasClick(event) {
  if (tool.value === 'polygon') {
    // 双击完成多边形绘制
    if (event.detail === 2) {
      finishDrawingPolygon()
    }
  }
}

function startDrawingRectangle(x, y) {
  isDrawing.value = true
  currentPath.value = [{ x, y }]
}

function updateDrawingRectangle(x, y) {
  if (currentPath.value.length > 0) {
    const start = currentPath.value[0]
    // 绘制预览矩形
    drawPreviewRectangle(start.x, start.y, x, y)
  }
}

function finishDrawingRectangle() {
  if (currentPath.value.length > 0 && activeMask.value) {
    const start = currentPath.value[0]
    const end = currentPath.value[currentPath.value.length - 1] || start

    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    }

    updateMaskData(activeMask.value, {
      type: 'rectangle',
      rect
    })
  }
  currentPath.value = []
}

function addPolygonPoint(x, y) {
  currentPath.value.push({ x, y })
  drawPreviewPolygon()
}

function finishDrawingPolygon() {
  if (currentPath.value.length >= 3 && activeMask.value) {
    updateMaskData(activeMask.value, {
      type: 'polygon',
      points: [...currentPath.value]
    })
  }
  currentPath.value = []
}

function selectMaskAt(x, y) {
  // 检查点击位置是否在某个蒙版内
  const mask = findMaskAt(x, y)
  selectedMask.value = mask
}

function findMaskAt(x, y) {
  // 简化实现：检查是否在激活蒙版的范围内
  if (!activeMask.value) return null

  const currentKeyframe = getCurrentKeyframe(activeMask.value)
  if (!currentKeyframe?.maskData) return null

  const maskData = currentKeyframe.maskData

  if (maskData.type === 'rectangle' && maskData.rect) {
    const rect = maskData.rect
    return x >= rect.x && x <= rect.x + rect.width &&
           y >= rect.y && y <= rect.y + rect.height ? activeMask.value : null
  }

  return null
}

function getCurrentKeyframe(mask) {
  return mask.keyframes.find(kf => Math.abs(kf.time - currentTime.value) < 0.1) ||
         mask.keyframes[0]
}

function updateMaskData(mask, maskData) {
  const currentKeyframe = getCurrentKeyframe(mask)
  if (currentKeyframe) {
    currentKeyframe.maskData = { ...currentKeyframe.maskData, ...maskData }
    videoStore.updateMask(mask.id, mask)
  }
}

function updateMaskTransform(mask, transform) {
  const currentKeyframe = getCurrentKeyframe(mask)
  if (currentKeyframe) {
    currentKeyframe.transform = { ...currentKeyframe.transform, ...transform }
    videoStore.updateMask(mask.id, mask)
  }
}

function updateCursor(x, y) {
  const canvas = editCanvas.value
  if (!canvas) return

  if (tool.value === 'select' && selectedMask.value) {
    const mask = findMaskAt(x, y)
    canvas.style.cursor = mask ? 'move' : 'default'
  } else {
    canvas.style.cursor = 'crosshair'
  }
}

function drawPreviewRectangle(x1, y1, x2, y2) {
  const canvas = editCanvas.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.strokeStyle = '#2196F3'
  ctx.lineWidth = 2
  ctx.setLineDash([5, 5])

  const x = Math.min(x1, x2) * canvas.width
  const y = Math.min(y1, y2) * canvas.height
  const w = Math.abs(x2 - x1) * canvas.width
  const h = Math.abs(y2 - y1) * canvas.height

  ctx.strokeRect(x, y, w, h)
}

function drawPreviewPolygon() {
  const canvas = editCanvas.value
  if (!canvas || currentPath.value.length < 2) return

  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  ctx.strokeStyle = '#2196F3'
  ctx.lineWidth = 2
  ctx.setLineDash([5, 5])

  ctx.beginPath()
  currentPath.value.forEach((point, index) => {
    const x = point.x * canvas.width
    const y = point.y * canvas.height
    if (index === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  })
  ctx.stroke()
}

// 工具栏拖拽
function startDragToolbar(event) {
  isDraggingToolbar.value = true
  dragOffset.value = {
    x: event.clientX - toolbarPosition.value.x,
    y: event.clientY - toolbarPosition.value.y
  }

  document.addEventListener('mousemove', dragToolbar)
  document.addEventListener('mouseup', stopDragToolbar)
}

function dragToolbar(event) {
  if (!isDraggingToolbar.value) return

  toolbarPosition.value = {
    x: event.clientX - dragOffset.value.x,
    y: event.clientY - dragOffset.value.y
  }
}

function stopDragToolbar() {
  isDraggingToolbar.value = false
  document.removeEventListener('mousemove', dragToolbar)
  document.removeEventListener('mouseup', stopDragToolbar)
}

function startTransform(handle, event) {
  event.stopPropagation()

  const startX = event.clientX
  const startY = event.clientY
  const originalTransform = { ...selectedMask.value.transform }

  function onMouseMove(e) {
    const deltaX = (e.clientX - startX) / canvasWidth.value
    const deltaY = (e.clientY - startY) / canvasHeight.value

    let newTransform = { ...originalTransform }

    if (handle.type.includes('corner')) {
      // 处理角点缩放
      newTransform.scaleX = Math.max(0.1, originalTransform.scaleX + deltaX)
      newTransform.scaleY = Math.max(0.1, originalTransform.scaleY + deltaY)
    } else if (handle.type.includes('edge')) {
      // 处理边缘缩放
      if (handle.type.includes('e') || handle.type.includes('w')) {
        newTransform.scaleX = Math.max(0.1, originalTransform.scaleX + deltaX)
      }
      if (handle.type.includes('n') || handle.type.includes('s')) {
        newTransform.scaleY = Math.max(0.1, originalTransform.scaleY + deltaY)
      }
    }

    updateMaskTransform(selectedMask.value, newTransform)
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

onMounted(() => {
  // 初始化画布尺寸
  if (editCanvas.value) {
    const parent = editCanvas.value.parentElement
    canvasWidth.value = parent.clientWidth
    canvasHeight.value = parent.clientHeight
  }
})

onUnmounted(() => {
  document.removeEventListener('mousemove', dragToolbar)
  document.removeEventListener('mouseup', stopDragToolbar)
})
</script>

<style scoped>
.video-editor {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.floating-toolbar {
  position: absolute;
  background: white;
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 1000;
  pointer-events: auto;
  cursor: move;
}

.mask-edit-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
}

.edit-canvas {
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.transform-controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.transform-handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #2196F3;
  border: 1px solid white;
  border-radius: 50%;
  pointer-events: auto;
  cursor: pointer;
}

.transform-handle.corner {
  cursor: nw-resize;
}

.transform-handle.edge.n,
.transform-handle.edge.s {
  cursor: ns-resize;
}

.transform-handle.edge.w,
.transform-handle.edge.e {
  cursor: ew-resize;
}
</style>
