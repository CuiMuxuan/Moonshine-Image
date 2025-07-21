<template>
  <div class="video-player">
    <div v-if="!videoSrc" class="video-placeholder">
      <q-icon name="videocam_off" size="48px" color="grey-4" />
      <div class="placeholder-text">暂无视频</div>
    </div>

    <video
      v-else
      ref="videoElement"
      class="video-element"
      :src="videoSrc"
      @loadedmetadata="onVideoLoaded"
      @timeupdate="onTimeUpdate"
      @ended="onVideoEnded"
      preload="metadata"
    ></video>

    <VideoControlsOverlay
      v-if="videoSrc"
      :is-playing="isPlaying"
      @click="onVideoClick"
    />

    <LoadingOverlay v-if="isLoading && videoSrc" />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import VideoControlsOverlay from './VideoControlsOverlay.vue'
import LoadingOverlay from './LoadingOverlay.vue'

defineProps({
  videoSrc: {
    type: String,
    required: true
  },
  isPlaying: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['video-loaded', 'time-update', 'video-ended', 'video-click'])

const videoElement = ref(null)
const isLoading = ref(true)

function onVideoLoaded() {
  isLoading.value = false
  if (videoElement.value) {
    emit('video-loaded', {
      duration: videoElement.value.duration,
      videoWidth: videoElement.value.videoWidth,
      videoHeight: videoElement.value.videoHeight
    })
  }
}

function onTimeUpdate() {
  if (videoElement.value) {
    emit('time-update', videoElement.value.currentTime)
  }
}

function onVideoEnded() {
  emit('video-ended')
}

function onVideoClick() {
  emit('video-click')
}

// 暴露方法供父组件调用
defineExpose({
  play: () => videoElement.value?.play(),
  pause: () => videoElement.value?.pause(),
  seek: (time) => {
    if (videoElement.value) {
      videoElement.value.currentTime = time
    }
  },
  getCurrentTime: () => videoElement.value?.currentTime || 0,
  getDuration: () => videoElement.value?.duration || 0
})
</script>

<style scoped>
.video-player {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
}

.video-element {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
