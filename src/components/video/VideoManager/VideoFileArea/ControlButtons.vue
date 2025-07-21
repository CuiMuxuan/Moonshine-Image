<template>
  <div class="control-buttons">
    <q-btn-group>
      <q-btn
        icon="folder_open"
        label="打开视频"
        @click="onOpenVideo"
        color="primary"
      />

      <q-btn
        icon="save"
        label="保存项目"
        @click="onSaveProject"
        :disable="!hasVideo"
      />

      <q-btn
        icon="video_call"
        label="导出视频"
        @click="onExportVideo"
        :disable="!hasVideo || !hasMasks"
        color="positive"
      />
    </q-btn-group>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { maskList, currentVideoFile } = storeToRefs(videoStore)

const hasVideo = computed(() => !!currentVideoFile.value)
const hasMasks = computed(() => maskList.value.length > 0)

function onOpenVideo() {
  // 创建文件输入元素
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*'
  input.onchange = (event) => {
    const file = event.target.files[0]
    if (file) {
      videoStore.loadVideoFile(file)
    }
  }
  input.click()
}

function onSaveProject() {
  const projectData = {
    video: currentVideoFile.value,
    masks: maskList.value,
    timestamp: Date.now()
  }

  const blob = new Blob([JSON.stringify(projectData, null, 2)], {
    type: 'application/json'
  })

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `video_project_${Date.now()}.json`
  a.click()

  URL.revokeObjectURL(url)
}

function onExportVideo() {
  // 触发视频导出流程
  videoStore.exportVideo()
}
</script>

<style scoped>
.control-buttons {
  display: flex;
  gap: 8px;
}
</style>
