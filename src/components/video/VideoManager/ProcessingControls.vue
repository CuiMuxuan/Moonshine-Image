<template>
  <div class="processing-controls">
      <q-card-section>
        <div class="processing-info q-mb-md">
          <div class="text-body2 text-grey-7">
            当前视频: {{ currentVideoFile?.name || '未选择' }}
          </div>
          <div class="text-body2 text-grey-7">
            蒙版数量: {{ maskList.length }}
          </div>
          <div class="text-body2 text-grey-7" v-if="hasTimeRangeSelected">
            时间范围: {{ formatTime(selectedTimeRange.start) }} - {{ formatTime(selectedTimeRange.end) }}
          </div>
        </div>

        <q-btn
          color="primary"
          label="运行处理"
          icon="play_arrow"
          :loading="isProcessing"
          :disable="!currentVideoFile || maskList.length === 0"
          @click="onProcessVideo"
          class="full-width q-mb-md"
        />

        <q-linear-progress
          v-if="isProcessing"
          :value="processingProgress / 100"
          color="primary"
          class="q-mb-sm"
        />

        <div v-if="isProcessing" class="text-center text-body2">
          处理进度: {{ processingProgress }}%
        </div>

        <div v-if="processingStatus === 'completed'" class="text-positive text-center">
          <q-icon name="check_circle" size="sm" />
          处理完成
        </div>

        <div v-if="processingStatus === 'error'" class="text-negative text-center">
          <q-icon name="error" size="sm" />
          处理失败: {{ processingError }}
        </div>
      </q-card-section>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const {
  isProcessing,
  processingProgress,
  processingStatus,
  processingError,
  currentVideoFile,
  maskList,
  selectedTimeRange
} = storeToRefs(videoStore)

const {
  processVideo,
  formatTime,
  hasTimeRangeSelected
} = videoStore

async function onProcessVideo() {
  try {
    const result = await processVideo()
    if (result.success) {
      console.log('视频处理完成:', result.outputPath)
      // 可以在这里添加下载或保存逻辑
    }
  } catch (error) {
    console.error('视频处理失败:', error)
  }
}
</script>

<style scoped>
.processing-info {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
}
</style>
