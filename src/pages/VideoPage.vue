<template>
  <div class="video-page column fit">
    <!-- 主要内容区域 -->
    <div class="row col">
      <!-- 左侧蒙版管理区 -->
      <div class="col-3 bg-grey-1">
        <MaskManager />
      </div>

      <!-- 中央预览区 -->
      <div class="col bg-white column">
        <PreviewArea />
      </div>

      <!-- 右侧蒙版编辑区 -->
      <div class="col-3 bg-grey-1">
        <MaskEditor />
      </div>
    </div>

    <!-- 底部视频管理区 -->
    <div class="col-auto bg-grey-2">
      <VideoManager />
    </div>
  </div>
</template>

<script setup>
import MaskManager from '../components/video/MaskManager/MaskManager.vue'
import PreviewArea from '../components/video/PreviewArea/PreviewArea.vue'
import MaskEditor from '../components/video/MaskEditor/MaskEditor.vue'
import VideoManager from '../components/video/VideoManager/VideoManager.vue'
</script>

<style scoped>
.video-page {
  height: 100vh;
}

/* 添加间隙效果 */
.video-page > .row {
  gap: 1px;
}

.video-page > .row > div {
  overflow-y: auto;
}

/* 底部面板样式 */
.video-page > .col-auto {
  overflow: hidden;
}
</style>
