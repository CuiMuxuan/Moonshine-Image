<template>
  <q-layout view="lHh LpR lFf" class="video-layout">
    <q-drawer
      v-model="leftDrawerOpen"
      side="left"
      bordered
      :width="320"
      :breakpoint="768"
      class="bg-grey-1"
    >
      <q-scroll-area class="fit">
        <MaskManager />
      </q-scroll-area>
    </q-drawer>

    <q-drawer
      v-model="rightDrawerOpen"
      side="right"
      bordered
      :width="320"
      :breakpoint="768"
      class="bg-grey-1"
    >
      <q-scroll-area class="fit">
        <MaskEditor />
      </q-scroll-area>
    </q-drawer>

    <q-page-container>
      <q-page class="video-page">
        <!-- 使用 Quasar 的 Grid 系统 -->
        <div class="row fit">
          <!-- 主预览区域 -->
          <div class="col-12 preview-section">
            <PreviewArea />
          </div>
        </div>
      </q-page>
    </q-page-container>

    <!-- 使用 q-footer 固定底部轨道控制区 -->
    <q-footer elevated class="bg-white text-dark">
      <div class="video-manager-container">
        <VideoManager />
      </div>
    </q-footer>
  </q-layout>
</template>

<script setup>
import { ref } from 'vue'
import MaskManager from '../components/video/MaskManager/MaskManager.vue'
import PreviewArea from '../components/video/PreviewArea/PreviewArea.vue'
import MaskEditor from '../components/video/MaskEditor/MaskEditor.vue'
import VideoManager from '../components/video/VideoManager/VideoManager.vue'

const leftDrawerOpen = ref(true)
const rightDrawerOpen = ref(true)

</script>

<style scoped>
.video-layout {
  height: 100vh;
}

.video-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 50px); /* 减去header和footer高度 */
}

.preview-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0; /* 允许flex子项收缩 */
}
</style>
