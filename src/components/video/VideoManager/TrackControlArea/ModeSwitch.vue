<template>
  <q-btn-toggle
    v-model="currentMode"
    :options="modeOptions"
    @update:model-value="onModeChange"
    color="primary"
    toggle-color="primary"
    outline
  />
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { currentMode } = storeToRefs(videoStore)
const { onModeChange } = videoStore

const modeOptions = [
  { label: '预览模式', value: 'preview', icon: 'visibility' },
  { label: '编辑模式', value: 'edit', icon: 'edit' }
]
</script>
