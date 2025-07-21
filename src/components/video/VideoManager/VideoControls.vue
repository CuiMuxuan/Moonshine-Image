<template>
  <div class="video-controls">
    <ZoomControls />
  </div>
</template>

<script setup>
import ZoomControls from './ZoomControls.vue'
</script>

<style scoped>
.video-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

