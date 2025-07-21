<template>
  <div class="preview-area">
    <div v-if="!currentVideoFile" class="empty-state">
      <div class="empty-content">
        <q-icon name="video_library" size="64px" color="grey-4" />
        <div class="empty-text">请先上传视频文件</div>
        <div class="empty-hint">支持 MP4、AVI、MOV 等格式</div>
      </div>
    </div>

    <div v-else class="video-display-container">
      <VideoDisplay :video-src="currentVideoFile?.url || ''" />
      <VideoEditor v-if="currentMode === 'edit'" />
    </div>

    <div class="playback-controls-container">
      <PlaybackControls />
    </div>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from '../../../stores/videoHandleManager'
import VideoDisplay from './VideoDisplay.vue'
import VideoEditor from './VideoEditor.vue'
import PlaybackControls from './PlaybackControls.vue'

const videoHandleManager = useVideoHandleManager()
const { currentMode, currentVideoFile } = storeToRefs(videoHandleManager)
</script>
