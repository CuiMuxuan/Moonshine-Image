<template>
  <q-page class="w-full h-screen flex">
    <!-- 左侧文件浏览器 -->
    <file-explorer
      v-model:drawer-open="leftDrawerOpen"
      :files="files"
      :selected-file="selectedFile"
      :selected-files="selectedFiles"
      :file-urls="fileUrls"
      @update:selected-file="selectedFile = $event"
      @toggle-selection="toggleFileSelection"
      @remove-file="removeFile"
    />

    <!-- 右侧设置面板 -->
    <q-drawer show-if-above v-model="rightDrawerOpen" side="right" bordered>
      <div class="q-pa-md">
        <div class="text-h6 q-mb-md flex items-center">
          <q-icon name="settings" class="q-mr-sm" />
          运行设置
        </div>

        <!-- 模型选择器 -->
        <q-item>
          <q-item-section>
            <model-selector
              v-model="currentModel"
              type="video"
              @update:model-value="handleModelChange"
            />
          </q-item-section>
        </q-item>

        <!-- 视频处理设置 -->
        <q-list>
          <q-item>
            <q-item-section>
              <q-select
                v-model="videoQuality"
                :options="['高质量', '中等质量', '快速处理']"
                label="处理质量"
                filled
              />
            </q-item-section>
          </q-item>

          <q-item>
            <q-item-section>
              <q-toggle v-model="preserveAudio" label="保留音频" />
            </q-item-section>
          </q-item>
          <div class="text-3">别琢磨了，视频处理此版本未开发</div>
        </q-list>
      </div>
    </q-drawer>

    <!-- 主工作区 -->
    <div class="flex-1 flex flex-col">
      <div class="flex-1">
        <workspace :selected-file="selectedFile">
          <div v-if="selectedFile && selectedFile.type.startsWith('video/')" class="w-full h-full">
            <!-- 视频播放器组件 -->
            <video
              :src="fileUrls[selectedFile.name]"
              controls
              class="w-full h-full object-contain"
            />
          </div>
        </workspace>
      </div>

      <!-- 底部工具栏 -->
      <processing-toolbar
        :files="files"
        :selected-file="selectedFile"
        :current-model="currentModel"
        :has-processed-images="false"
        type="video"
        @toggle-file-explorer="leftDrawerOpen = !leftDrawerOpen"
        @update:files="files = $event"
        @run-model="runVideoModel"
        @download="downloadVideo"
        @toggle-settings="rightDrawerOpen = !rightDrawerOpen"
      />
    </div>
  </q-page>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useQuasar } from 'quasar'
import FileExplorer from '../components/FileExplorer.vue'
import Workspace from '../components/Workspace.vue'
import ModelSelector from '../components/ModelSelector.vue'
import ProcessingToolbar from '../components/ProcessingToolbar.vue'

const $q = useQuasar()

const leftDrawerOpen = ref(false)
const rightDrawerOpen = ref(false)
const files = ref([])
const selectedFile = ref(null)
const selectedFiles = ref([])
const currentModel = ref('video1')
const videoQuality = ref('高质量')
const preserveAudio = ref(true)

const fileUrls = computed(() => {
  const urls = {}
  files.value.forEach(file => {
    if (file.type.startsWith('video/')) {
      urls[file.name] = URL.createObjectURL(file)
    }
  })
  return urls
})

const toggleFileSelection = (file) => {
  const index = selectedFiles.value.findIndex(f => f.name === file.name)
  if (index === -1) {
    selectedFiles.value.push(file)
  } else {
    selectedFiles.value.splice(index, 1)
  }
}

const removeFile = (index) => {
  const removed = files.value.splice(index, 1)[0]
  if (selectedFile.value?.name === removed.name) {
    selectedFile.value = files.value[0] || null
  }
}

const handleModelChange = (model) => {
  currentModel.value = model
  $q.notify({
    type: 'info',
    message: `已切换到${model}模型`,
    position: 'top'
  })
}

const runVideoModel = () => {
  $q.notify({
    type: 'info',
    message: '视频处理功能开发中...',
    position: 'top'
  })
}

const downloadVideo = () => {
  $q.notify({
    type: 'info',
    message: '视频下载功能开发中...',
    position: 'top'
  })
}
</script>
