<template>
  <div class="video-file-area">
    <!-- 控制按钮区 -->
    <div class="control-section">
      <ControlButtons />
    </div>

    <!-- 文件信息显示区 -->
    <div class="file-info-section">
      <FileInfoDisplay />
    </div>
    <div class="processing-section">
      <ProcessingControls />
    </div>
  </div>
</template>

<script setup>
import ControlButtons from './ControlButtons.vue'
import FileInfoDisplay from './FileInfoDisplay/FileInfoDisplay.vue'
import ProcessingControls from '../ProcessingControls.vue'
</script>

<style scoped>
.video-file-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 16px;
}

.control-section {
  flex: 0 0 auto;
}

.file-info-section {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
