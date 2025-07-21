<template>
  <div class="zoom-controls">
    <q-btn
      icon="zoom_out"
      @click="onZoomOut"
      :disable="currentZoom <= 0.1"
      flat
      dense
    />

    <q-slider
      v-model="currentZoom"
      :min="0.1"
      :max="5"
      :step="0.1"
      style="width: 100px"
      @update:model-value="onZoomChange"
    />

    <q-btn
      icon="zoom_in"
      @click="onZoomIn"
      :disable="currentZoom >= 5"
      flat
      dense
    />

    <span class="zoom-label">{{ Math.round(currentZoom * 100) }}%</span>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'

const videoStore = useVideoHandleManager()
const { currentZoom } = storeToRefs(videoStore)
const { onZoomChange, onZoomIn, onZoomOut } = videoStore
</script>

<style scoped>
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-label {
  font-size: 12px;
  color: #666;
  min-width: 40px;
  text-align: center;
}
</style>
