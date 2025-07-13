<template>
  <div class="moonshine-file-wrapper">
    <div class="file-selector-container">
      <q-btn
        :label="label"
        :icon="icon"
        :color="color"
        :disable="disable"
        @click="selectFiles"
        class="file-select-btn"
        unelevated
        no-caps
      >
        <q-tooltip v-if="tooltip" class="bg-deep-purple text-white">{{ tooltip }}</q-tooltip>
      </q-btn>

      <!-- 文件数量指示器 -->
      <div
        v-if="selectedFiles.length > 0"
        class="file-indicator"
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
      >
        <q-btn
          flat
          round
          dense
          icon="expand_less"
          color="deep-purple"
          class="file-count-btn"
          unelevated
        >
          <q-badge
            color="negative"
            floating
            :label="selectedFiles.length"
            rounded
          />
        </q-btn>

        <!-- 悬浮文件列表 -->
        <q-card
          v-show="showFileList"
          class="file-list-popup bg-deep-purple-2"
          @mouseenter="handleMouseEnter"
          @mouseleave="handleMouseLeave"
          bordered
          flat
        >
          <q-card-section class="q-pa-xs">
            <div class="text-subtitle2 text-deep-purple-10 q-mb-xs q-px-sm">
              已选择文件 ({{ selectedFiles.length }})
            </div>
            <q-separator class="q-mb-xs" />
            <q-scroll-area
              :style="`height: ${Math.min(selectedFiles.length * 60)}px; max-height: 50vh;`"
              class="file-list-container"
              :thumb-style="thumbStyle"
              :bar-style="barStyle"
            >
              <q-list dense class="q-pa-none">
                <q-item
                  v-for="(file, index) in selectedFiles"
                  :key="index"
                  class="file-item q-pa-xs"
                  clickable
                  v-ripple
                >
                  <q-item-section avatar>
                    <q-avatar size="28px" color="deep-purple-1" text-color="deep-purple-10">
                      <q-icon :name="getFileIcon(file)" />
                    </q-avatar>
                  </q-item-section>

                  <q-item-section>
                    <q-item-label class="text-caption ellipsis text-deep-purple-10">
                      {{ file.name }}
                    </q-item-label>
                    <q-item-label caption class="text-deep-purple-8">
                      {{ formatFileSize(file.size) }}
                      <span v-if="file.path" class="q-ml-xs">
                        • {{ file.path.split(/[\\/]/).pop() }}
                      </span>
                    </q-item-label>
                  </q-item-section>

                  <q-item-section side>
                    <q-btn
                      flat
                      round
                      dense
                      size="sm"
                      icon="close"
                      color="negative"
                      @click.stop="removeFile(index)"
                      class="hover-scale"
                    >
                      <q-tooltip class="bg-negative text-white">移除文件</q-tooltip>
                    </q-btn>
                  </q-item-section>
                </q-item>
              </q-list>
            </q-scroll-area>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      :accept="accept"
      :multiple="multiple"
      style="display: none"
      @change="handleFileChange"
    />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useQuasar } from 'quasar'

const $q = useQuasar()

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => []
  },
  accept: {
    type: String,
    default: '*'
  },
  multiple: {
    type: Boolean,
    default: true
  },
  label: {
    type: String,
    default: '选择文件'
  },
  icon: {
    type: String,
    default: 'attach_file'
  },
  color: {
    type: String,
    default: 'primary'
  },
  disable: {
    type: Boolean,
    default: false
  },
  tooltip: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['update:modelValue', 'rejected'])

const fileInput = ref(null)
const selectedFiles = ref([])
const showFileList = ref(false)
let hideTimeout = null

// Quasar滚动条样式
const thumbStyle = {
  right: '4px',
  borderRadius: '5px',
  backgroundColor: '#9c27b0',
  width: '6px',
  opacity: 0.75
}

const barStyle = {
  right: '2px',
  borderRadius: '9px',
  backgroundColor: '#e1bee7',
  width: '10px',
  opacity: 0.2
}

// 处理鼠标离开事件，延迟隐藏列表
const handleMouseLeave = () => {
  hideTimeout = setTimeout(() => {
    showFileList.value = false
  }, 300) // 增加延迟时间
}

// 当鼠标重新进入时取消隐藏
const handleMouseEnter = () => {
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }
  showFileList.value = true
}

// 格式化文件大小
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 检查文件是否已存在
const isFileAlreadySelected = (newFile) => {
  return selectedFiles.value.some(existingFile => {
    // 优先比较路径，如果都有路径则比较路径
    if (newFile.path && existingFile.path) {
      return newFile.path === existingFile.path
    }
    // 否则比较文件名和大小
    return existingFile.name === newFile.name && existingFile.size === newFile.size
  })
}

// 监听外部传入的文件
watch(
  () => props.modelValue,
  (newFiles) => {
    selectedFiles.value = newFiles || []
  },
  { immediate: true }
)

// 选择文件
const selectFiles = async () => {
  if (window.electron) {
    // Electron环境：使用原生文件选择对话框
    try {
      const result = await window.electron.ipcRenderer.invoke('select-file', {
        title: '选择文件',
        filters: getFileFilters(),
        properties: props.multiple ? ['openFile', 'multiSelections'] : ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        await loadFilesFromPaths(result.filePaths)
      }
    } catch (error) {
      console.error('文件选择失败:', error)
      $q.notify({
        type: 'negative',
        message: '文件选择失败: ' + error.message,
        position: 'top'
      })
    }
  } else {
    // 浏览器环境：使用传统文件输入
    fileInput.value?.click()
  }
}

// 处理浏览器文件选择
const handleFileChange = async (event) => {
  const files = Array.from(event.target.files || [])
  if (files.length > 0) {
    const newFiles = []
    const skippedFiles = []

    const processedFiles = files.map(file => {
      // 为浏览器选择的文件创建扩展对象
      const extendedFile = new File([file], file.name, {
        type: file.type,
        lastModified: file.lastModified
      })

      // 添加路径信息（浏览器环境下为空）
      Object.defineProperty(extendedFile, 'path', {
        value: file.webkitRelativePath || '',
        writable: false
      })

      return extendedFile
    })

    // 检查重复文件
    processedFiles.forEach(file => {
      if (isFileAlreadySelected(file)) {
        skippedFiles.push(file.name)
      } else {
        newFiles.push(file)
      }
    })

    // 显示跳过的文件提示
    if (skippedFiles.length > 0) {
      $q.notify({
        type: 'info',
        message: `${skippedFiles.join(', ')} 已选中，跳过上传`,
        position: 'top',
        timeout: 3000
      })
    }

    // 添加新文件
    if (newFiles.length > 0) {
      if (props.multiple) {
        selectedFiles.value = [...selectedFiles.value, ...newFiles]
      } else {
        selectedFiles.value = newFiles
      }

      emit('update:modelValue', selectedFiles.value)

      $q.notify({
        type: 'positive',
        message: `成功添加 ${newFiles.length} 个文件`,
        position: 'top',
        timeout: 2000
      })
    }
  }

  // 清空input值以允许重复选择同一文件
  event.target.value = ''
}

// 从文件路径加载文件（Electron环境）
const loadFilesFromPaths = async (filePaths) => {
  const loadedFiles = []
  const skippedFiles = []

  for (const filePath of filePaths) {
    try {
      // 检查文件是否已存在
      const isExisting = selectedFiles.value.some(file => file.path === filePath)
      if (isExisting) {
        const fileName = filePath.split(/[\\/]/).pop()
        skippedFiles.push(fileName)
        continue
      }

      const result = await window.electron.ipcRenderer.invoke('read-file', filePath)

      if (result.success) {
        // 创建File对象
        const uint8Array = new Uint8Array(result.data.buffer)
        const blob = new Blob([uint8Array], { type: result.data.type })
        const file = new File([blob], result.data.name, {
          type: result.data.type,
          lastModified: result.data.lastModified
        })

        // 添加路径信息
        Object.defineProperty(file, 'path', {
          value: filePath,
          writable: false
        })

        loadedFiles.push(file)
      }
    } catch (error) {
      console.error(`加载文件失败 ${filePath}:`, error)
      emit('rejected', [{ name: filePath, reason: '文件读取失败' }])
    }
  }

  // 显示跳过的文件提示
  if (skippedFiles.length > 0) {
    $q.notify({
      type: 'info',
      message: `${skippedFiles.join(', ')} 已选中，跳过上传`,
      position: 'top',
      timeout: 3000
    })
  }

  // 添加新文件
  if (loadedFiles.length > 0) {
    if (props.multiple) {
      selectedFiles.value = [...selectedFiles.value, ...loadedFiles]
    } else {
      selectedFiles.value = loadedFiles
    }

    emit('update:modelValue', selectedFiles.value)

    $q.notify({
      type: 'positive',
      message: `成功添加 ${loadedFiles.length} 个文件`,
      position: 'top',
      timeout: 2000
    })
  }
}

// 移除文件
const removeFile = (index) => {
  const removedFile = selectedFiles.value[index]
  selectedFiles.value.splice(index, 1)
  emit('update:modelValue', selectedFiles.value)

  $q.notify({
    type: 'info',
    message: `已移除文件: ${removedFile.name}`,
    position: 'top',
    timeout: 2000
  })
}

// 获取文件过滤器（Electron用）
const getFileFilters = () => {
  if (props.accept === '*') {
    return []
  }

  const extensions = props.accept.split(',').map(ext => ext.trim().replace('.', ''))
  return [{
    name: '支持的文件',
    extensions: extensions
  }]
}

// 获取文件图标
const getFileIcon = (file) => {
  const type = file.type?.split('/')[0] || ''
  return {
    image: 'photo',
    video: 'movie',
    audio: 'music_note',
    text: 'description',
    application: 'insert_drive_file'
  }[type] || 'insert_drive_file'
}

// 暴露方法供外部调用
defineExpose({
  selectFiles,
  removeFile
})
</script>

<style scoped>
.moonshine-file-wrapper {
  width: 100%;
}

.file-selector-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-select-btn {
  flex: 1;
  transition: all 0.3s ease;
}

.file-select-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

.file-indicator {
  position: relative;
}

.file-count-btn {
  min-width: 40px;
  transition: all 0.3s ease;
}

.file-count-btn:hover {
  transform: scale(1.1);
}

.file-list-popup {
  position: absolute;
  bottom: 100%;
  right: 0;
  min-width: 450px;
  max-width: 50vw;
  z-index: 1000;
  box-shadow: 0 8px 24px rgba(156, 39, 176, 0.3);
  border-radius: 12px;
  border: 2px solid rgba(156, 39, 176, 0.2);
  backdrop-filter: blur(10px);
  animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.file-list-container {
  min-height: 10vh;
  max-height: 50vh;
  overflow-y: auto;
}

.file-item {
  border-radius: 8px;
  margin: 2px 4px;
  transition: all 0.2s ease;
}

.file-item:hover {
  background-color: rgba(156, 39, 176, 0.1);
  transform: translateX(4px);
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.hover-scale {
  transition: transform 0.2s ease;
}

.hover-scale:hover {
  transform: scale(1.2);
}

/* 深紫色主题样式 */
.bg-deep-purple-2 {
  background-color: #d1c4e9 !important;
}

.text-deep-purple-10 {
  color: #4a148c !important;
}

.text-deep-purple-8 {
  color: #6a1b9a !important;
}
</style>
