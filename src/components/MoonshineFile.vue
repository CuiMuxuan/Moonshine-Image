<template>
  <div class="moonshine-file-wrapper">
    <!-- 上传进度对话框 -->
    <q-dialog v-model="showUploadProgress" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">文件上传进度</div>
        </q-card-section>

        <q-card-section>
          <div class="q-mb-md">
            <div class="text-subtitle2">{{ uploadStatus.currentFile }}</div>
            <q-linear-progress
              :value="uploadStatus.progress"
              color="primary"
              size="20px"
              class="q-mt-sm"
            >
              <div class="absolute-full flex flex-center">
                <q-badge color="white" text-color="primary" :label="`${Math.round(uploadStatus.progress * 100)}%`" />
              </div>
            </q-linear-progress>
          </div>

          <div class="text-caption text-grey-7">
            {{ uploadStatus.details }}
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            flat
            color="negative"
            label="取消"
            @click="cancelUpload"
            :disable="!canCancelUpload"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <div class="file-selector-container">
      <q-btn
        :label="$q.screen.gt.xs ? label : ''"
        :icon="icon"
        :color="color"
        :disable="disable"
        @click="selectFiles"
        class="file-select-btn row"
        :class="{ 'icon-only': $q.screen.xs }"
        unelevated
        no-caps
      >
        <q-tooltip v-if="tooltip" class="bg-deep-purple text-white">{{ tooltip }}</q-tooltip>
      </q-btn>

      <!-- 文件数量指示器 -->
      <div
        v-if="fileManagerStore.files.length > 0"
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
            :label="fileManagerStore.files.length"
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
              已选择文件 ({{ fileManagerStore.files.length }})
            </div>
            <q-separator class="q-mb-xs" />
            <q-scroll-area
              :style="`height: ${Math.min(fileManagerStore.files.length * 60, 300)}px; max-height: 50vh;`"
              class="file-list-container"
              :thumb-style="thumbStyle"
              :bar-style="barStyle"
            >
              <q-list dense class="q-pa-none">
                <q-item
                  v-for="file in fileManagerStore.files"
                  :key="file.id"
                  class="file-item q-pa-xs"
                  clickable
                  v-ripple
                  :class="{ 'bg-deep-purple-1': file.id === fileManagerStore.currentFileId }"
                  @click="fileManagerStore.setCurrentFile(file.id)"
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
                      历史记录: {{ file.history.length }}
                      <span v-if="file.mask" class="q-ml-xs">• 已设置蒙版</span>
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
                      @click.stop="removeFile(file.id)"
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
import { ref, onMounted } from 'vue'
import { useQuasar } from 'quasar'
import { useFileManagerStore } from 'src/stores/fileManager'

const $q = useQuasar()
const fileManagerStore = useFileManagerStore()

const props = defineProps({
  accept: {
    type: String,
    default: 'image/*'
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
    default: 'upload_file'
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

const emit = defineEmits(['file-added', 'file-removed'])

const fileInput = ref(null)
const showFileList = ref(false)
// 上传进度相关状态
const showUploadProgress = ref(false)
const canCancelUpload = ref(true)
const uploadStatus = ref({
  currentFile: '',
  progress: 0,
  details: ''
})
let hideTimeout = null

// 初始化处理配置
onMounted(() => {
  fileManagerStore.initProcessingConfig()
})
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
    await processFiles(files)
  }
  event.target.value = ''
}

// 处理文件
const processFiles = async (files) => {
  showUploadProgress.value = true
  canCancelUpload.value = true

  // 计算总文件大小
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  let uploadedSize = 0

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const fileStartSize = uploadedSize

      uploadStatus.value = {
        currentFile: file.name,
        progress: uploadedSize / totalSize,
        details: `正在处理文件 ${i + 1} / ${files.length} (${formatFileSize(uploadedSize)}/${formatFileSize(totalSize)})`
      }

      if (!canCancelUpload.value) break

      // 模拟文件处理进度（如果addFile支持进度回调）
      const fileData = await fileManagerStore.addFile(file, (progress) => {
        const currentFileProgress = fileStartSize + (file.size * progress)
        uploadStatus.value = {
          currentFile: file.name,
          progress: currentFileProgress / totalSize,
          details: `正在处理 ${file.name} (${Math.round(progress * 100)}%)`
        }
      })

      uploadedSize += file.size
      emit('file-added', fileData)
    }

    uploadStatus.value = {
      currentFile: '处理完成',
      progress: 1,
      details: `成功处理 ${files.length} 个文件 (${formatFileSize(totalSize)})`
    }


    $q.notify({
      type: 'positive',
      message: `成功添加 ${files.length} 个文件`,
      position: 'top',
      timeout: 2000
    })

  } catch (error) {
    console.error('文件处理失败:', error)
    $q.notify({
      type: 'negative',
      message: '文件处理失败: ' + error.message,
      position: 'top'
    })
  } finally {
    setTimeout(() => {
      showUploadProgress.value = false
    }, 1000)
  }
}

// 移除文件
const removeFile = (fileId) => {
  const file = fileManagerStore.files.find(f => f.id === fileId)
  if (file) {
    fileManagerStore.removeFile(fileId)
    emit('file-removed', file)

    $q.notify({
      type: 'info',
      message: `已移除文件: ${file.name}`,
      position: 'top',
      timeout: 2000
    })
  }
}

// 从文件路径加载文件（Electron环境）
const loadFilesFromPaths = async (filePaths) => {
  showUploadProgress.value = true
  canCancelUpload.value = true
  const processedCount = ref(0)
  let totalSize = 0
  let loadedSize = 0

  try {
    // 首先获取所有文件的大小信息
    const fileInfos = []
    for (const filePath of filePaths) {
      try {
        const stats = await window.electron.ipcRenderer.invoke('get-file-stats', filePath)
        if (stats.success) {
          fileInfos.push({ path: filePath, size: stats.size, name: stats.name })
          totalSize += stats.size
        }
      } catch (error) {
        console.error(`获取文件信息失败 ${filePath}:`, error)
      }
    }

    for (let i = 0; i < fileInfos.length; i++) {
      const fileInfo = fileInfos[i]
      const fileStartSize = loadedSize

      uploadStatus.value = {
        currentFile: fileInfo.name,
        progress: loadedSize / totalSize,
        details: `正在加载文件 ${i + 1} / ${fileInfos.length} (${formatFileSize(loadedSize)}/${formatFileSize(totalSize)})`
      }

      if (!canCancelUpload.value) break

      try {
        // 检查文件是否已存在
        const isExisting = fileManagerStore.files.some(file =>
          file.originalFile?.path === fileInfo.path
        )
        if (isExisting) {
          loadedSize += fileInfo.size
          continue
        }

        // 使用支持进度的文件读取方法
        // 设置进度监听器
        const progressHandler = (event, progressData) => {
          if (progressData.filePath === fileInfo.path) {
            const currentProgress = fileStartSize + (fileInfo.size * (progressData.progress / 100))
            uploadStatus.value = {
              currentFile: fileInfo.name,
              progress: currentProgress / totalSize,
              details: `正在读取 ${fileInfo.name} (${progressData.progress}%)`
            }
          }
        }

        // 添加进度监听器
        window.electron.ipcRenderer.on('file-read-progress', progressHandler)

        try {
          // 调用文件读取，不传递回调函数
          const result = await window.electron.ipcRenderer.invoke('read-file-with-progress', fileInfo.path)

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
              value: fileInfo.path,
              writable: false
            })

            // 添加到fileManager store
            const fileData = await fileManagerStore.addFile(file)
            emit('file-added', fileData)
            processedCount.value++
          }
        } finally {
          // 清理进度监听器
          window.electron.ipcRenderer.removeListener('file-read-progress', progressHandler)
        }
      } catch (error) {
        console.error(`加载文件失败 ${fileInfo.path}:`, error)
        loadedSize += fileInfo.size // 即使失败也要更新进度
      }
    }

    uploadStatus.value = {
      currentFile: '加载完成',
      progress: 1,
      details: `成功加载 ${processedCount.value} 个文件 (${formatFileSize(totalSize)})`
    }


    if (processedCount.value > 0) {
      $q.notify({
        type: 'positive',
        message: `成功添加 ${processedCount.value} 个文件`,
        position: 'top',
        timeout: 2000
      })
    }

  } catch (error) {
    console.error('文件加载失败:', error)
    $q.notify({
      type: 'negative',
      message: '文件加载失败: ' + error.message,
      position: 'top'
    })
  } finally {
    // 延迟关闭进度对话框
    setTimeout(() => {
      showUploadProgress.value = false
    }, 1000)
  }
}

// 格式化文件大小显示
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
// 取消上传
const cancelUpload = () => {
  canCancelUpload.value = false
  showUploadProgress.value = false
  $q.notify({
    type: 'info',
    message: '已取消文件上传',
    position: 'top'
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
.file-select-btn {
  flex: 1;
  transition: all 0.3s ease;
  min-width: 44px; /* 确保按钮有最小宽度以容纳图标 */
}

.file-select-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
}

/* 小屏幕下的图标模式样式 */
.icon-only {
  min-width: 44px;
  max-width: 44px;
  padding: 8px;
}

/* 使用Quasar CSS类的替代方案 */
@media (max-width: 599px) {
  .file-select-btn {
    min-width: 44px;
    max-width: 44px;
    padding: 8px;
  }

  .file-select-btn .q-btn__content {
    min-width: auto;
  }
}

/* 超小屏幕优化 */
@media (max-width: 320px) {
  .file-selector-container {
    gap: 4px;
  }

  .file-select-btn {
    min-width: 40px;
    max-width: 40px;
    padding: 6px;
  }
}

</style>
