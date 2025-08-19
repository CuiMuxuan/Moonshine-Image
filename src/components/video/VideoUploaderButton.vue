<template>
  <q-file
    v-model="model"
    accept="video/mp4"
    max-files="1"
    filled
    label="选择视频文件"
    @update:model-value="handleFileChange"
  >
    <template v-slot:before>
      <q-icon name="folder_open" />
    </template>

    <template v-slot:hint>
      仅支持MP4格式视频文件
    </template>

    <template v-if="model" v-slot:file="{ file }">
      <q-chip
        removable
        @remove="removeFile"
        color="primary"
        text-color="white"
        icon="movie"
      >
        <div class="ellipsis relative-position">
          {{ file.name }}
          <q-tooltip>{{ file.name }} ({{ formatFileSize(file.size) }})</q-tooltip>
        </div>
      </q-chip>
    </template>
  </q-file>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useVideoManagerStore } from '../../stores/videoManager'

// 使用视频管理状态
const videoManagerStore = useVideoManagerStore()

// 本地文件模型
const model = ref(null)

// 组件挂载时恢复状态
onMounted(() => {
  if (videoManagerStore.videoFile) {
    model.value = videoManagerStore.videoFile
  }
})

// 处理文件变化
const handleFileChange = async (file) => {
  if (file) {
    // 验证文件类型
    if (file.type !== 'video/mp4') {
      console.warn('仅支持MP4格式的视频文件')
      model.value = null
      return
    }

    // 设置到状态管理中
    await videoManagerStore.setVideoFile(file)
  } else {
    // 清除状态管理中的文件
    videoManagerStore.clearVideoFile()
  }
}

// 移除文件
const removeFile = () => {
  model.value = null
  videoManagerStore.clearVideoFile()
}

// 格式化文件大小
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 监听状态管理中的文件变化，同步到本地模型
watch(
  () => videoManagerStore.videoFile,
  (newFile) => {
    if (!newFile && model.value) {
      model.value = null
    }
  }
)
</script>

<style scoped>
/* 可以添加自定义样式 */
</style>
