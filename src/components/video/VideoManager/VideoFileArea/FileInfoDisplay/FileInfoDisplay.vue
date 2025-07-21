<template>
  <div class="file-info-display">
    <CurrentFileInfo />
    <q-icon name="arrow_forward" size="24px" color="grey-5" />
    <TargetFileInfo />
  </div>
</template>

<script setup>
import CurrentFileInfo from './CurrentFileInfo.vue'
import TargetFileInfo from './TargetFileInfo.vue'
</script>

<style scoped>
.file-info-display {
  display: flex;
  align-items: center;
  gap: 16px;
}
</style>
