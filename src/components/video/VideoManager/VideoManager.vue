<template>
  <div class="video-manager q-pa-md">
    <div class="row q-gutter-md">
      <!-- 左侧视频文件区域 -->
      <div class="col-3">
        <q-card class="fit">
          <q-card-section class="q-pa-none">
            <VideoFileArea />
          </q-card-section>
        </q-card>
      </div>

      <!-- 中间轨道控制区域 -->
      <div class="col">
        <q-card class="fit">
          <q-card-section class="q-pa-none">
            <TrackControlArea />
          </q-card-section>
        </q-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import VideoFileArea from './VideoFileArea/VideoFileArea.vue'
import TrackControlArea from './TrackControlArea/TrackControlArea.vue'
</script>

<style scoped>
.video-manager {
  height: 100%;
  background: #f5f5f5;
}

/* 确保卡片填满容器 */
.q-card {
  height: 100%;
}
</style>
