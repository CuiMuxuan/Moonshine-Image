<template>
  <div class="processing-toolbar">
    <div class="toolbar-section">
      <!-- 文件操作 -->
      <q-btn-group>
        <q-btn
          icon="upload"
          label="上传视频"
          @click="uploadVideo"
          :disable="isProcessing||true"
        />
        <q-btn
          icon="download"
          label="下载视频"
          @click="downloadVideo"
          :disable="!hasProcessedVideo"
        />
      </q-btn-group>
    </div>

    <div class="toolbar-section">
      <!-- 编辑操作 -->
      <q-btn-group>
        <q-btn
          icon="brush"
          label="编辑蒙版"
          @click="toggleMaskEditor"
          :color="isEditingMask ? 'primary' : 'grey'"
          :disable="!currentVideo"
        />
        <q-btn
          icon="undo"
          label="撤销"
          @click="undo"
          :disable="!canUndo"
        />
        <q-btn
          icon="redo"
          label="重做"
          @click="redo"
          :disable="!canRedo"
        />
      </q-btn-group>
    </div>

    <q-space />

    <div class="toolbar-section">
      <!-- 处理操作 -->
      <q-btn
        icon="play_arrow"
        label="开始处理"
        color="positive"
        @click="startProcessing"
        :disable="!canStartProcessing"
        :loading="isProcessing"
      />

      <q-btn
        icon="stop"
        label="停止处理"
        color="negative"
        @click="stopProcessing"
        :disable="!isProcessing"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

// Props
const props = defineProps({
  currentVideo: {
    type: File,
    default: null
  },
  currentModel: {
    type: String,
    default: 'lama'
  },
  isEditingMask: {
    type: Boolean,
    default: false
  },
  isProcessing: {
    type: Boolean,
    default: false
  },
  hasProcessedVideo: {
    type: Boolean,
    default: false
  },
  canUndo: {
    type: Boolean,
    default: false
  },
  canRedo: {
    type: Boolean,
    default: false
  }
})

// Emits
const emit = defineEmits([
  'upload-video',
  'download-video',
  'toggle-mask-editor',
  'start-processing',
  'stop-processing',
  'undo',
  'redo'
])

// 计算属性
const canStartProcessing = computed(() => {
  return props.currentVideo && !props.isProcessing
})

// 方法
const uploadVideo = () => {
  emit('upload-video')
}

const downloadVideo = () => {
  emit('download-video')
}

const toggleMaskEditor = () => {
  emit('toggle-mask-editor')
}

const startProcessing = () => {
  emit('start-processing')
}

const stopProcessing = () => {
  emit('stop-processing')
}

const undo = () => {
  emit('undo')
}

const redo = () => {
  emit('redo')
}
</script>

<style scoped>
.processing-toolbar {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: #f5f5f5;
  border-top: 1px solid #e0e0e0;
  gap: 16px;
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
