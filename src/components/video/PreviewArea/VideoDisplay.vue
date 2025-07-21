<template>
  <div class="video-display" ref="videoContainer">
    <div class="video-wrapper">
      <VideoPlayer
        :video-src="videoSrc"
        @video-loaded="onVideoLoaded"
        @time-update="onTimeUpdate"
        @video-ended="onVideoEnded"
        @video-click="onVideoClick"
      />

      <MaskRenderer
        :active-mask="activeMask"
        :current-time="currentTime"
        :video-width="videoWidth"
        :video-height="videoHeight"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from 'src/stores/videoHandleManager'
import VideoPlayer from './VideoPlayer.vue'
import MaskRenderer from './MaskRenderer.vue'

defineProps({
  videoSrc: {
    type: String,
    default: ''
  }
})

const videoStore = useVideoHandleManager()
const {
  currentTime,
  activeMaskId,
  maskList
} = storeToRefs(videoStore)

const {
  onPlayToggle,
  onSeek,
  setDuration
} = videoStore

const videoWidth = ref(0)
const videoHeight = ref(0)

// 获取当前激活的遮罩
const activeMask = computed(() => {
  return maskList.value.find(mask => mask.id === activeMaskId.value)
})

function onVideoLoaded({ duration, videoWidth: width, videoHeight: height }) {
  setDuration(duration)
  videoWidth.value = width
  videoHeight.value = height
}

function onTimeUpdate(time) {
  onSeek(time)
}

function onVideoEnded() {
  // 视频播放结束时的处理
}

function onVideoClick() {
  onPlayToggle()
}
</script>
