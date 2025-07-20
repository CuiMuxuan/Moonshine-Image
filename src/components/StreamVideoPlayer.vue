<template>
  <div class="stream-video-player">
    <video
      ref="videoRef"
      class="video-player"
      @loadedmetadata="handleVideoLoaded"
      @timeupdate="handleTimeUpdate"
      @seeked="handleSeeked"
      controls
    />
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue'

const props = defineProps({
  videoFile: {
    type: [File, String],
    required: true
  }
})

const emit = defineEmits([
  'video-loaded',
  'time-update',
  'seeked'
])

const videoRef = ref(null)
let mediaSource = null
let sourceBuffer = null

const setupStreamingVideo = async () => {
  if (!('MediaSource' in window)) {
    console.warn('MediaSource API不支持，降级到普通播放')
    fallbackToNormalPlayback()
    return
  }

  try {
    mediaSource = new MediaSource()
    const video = videoRef.value
    video.src = URL.createObjectURL(mediaSource)

    mediaSource.addEventListener('sourceopen', async () => {
      try {
        // 检测视频格式
        const mimeType = await detectVideoMimeType(props.videoFile)
        sourceBuffer = mediaSource.addSourceBuffer(mimeType)

        // 分块加载视频数据
        await loadVideoInChunks()
      } catch (error) {
        console.error('设置SourceBuffer失败:', error)
        fallbackToNormalPlayback()
      }
    })
  } catch (error) {
    console.error('设置MediaSource失败:', error)
    fallbackToNormalPlayback()
  }
}

const loadVideoInChunks = async () => {
  const chunkSize = 1024 * 1024 // 1MB chunks
  let offset = 0

  const file = props.videoFile instanceof File ? props.videoFile : await fetch(props.videoFile).then(r => r.blob())

  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkSize)
    const arrayBuffer = await chunk.arrayBuffer()

    await new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', resolve, { once: true })
      sourceBuffer.addEventListener('error', reject, { once: true })
      sourceBuffer.appendBuffer(arrayBuffer)
    })

    offset += chunkSize
  }

  mediaSource.endOfStream()
}

const detectVideoMimeType = async (file) => {
  // 简单的MIME类型检测
  if (file instanceof File) {
    return file.type || 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
  }

  // 对于文件路径，根据扩展名推断
  const ext = file.split('.').pop().toLowerCase()
  const mimeTypes = {
    'mp4': 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'webm': 'video/webm; codecs="vp8, vorbis"',
    'mov': 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
  }

  return mimeTypes[ext] || 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
}

const fallbackToNormalPlayback = () => {
  const video = videoRef.value
  if (props.videoFile instanceof File) {
    video.src = URL.createObjectURL(props.videoFile)
  } else {
    video.src = `atom://${props.videoFile}`
  }
}

const handleVideoLoaded = () => {
  const video = videoRef.value
  emit('video-loaded', {
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight
  })
}

const handleTimeUpdate = () => {
  const video = videoRef.value
  emit('time-update', {
    currentTime: video.currentTime,
    duration: video.duration
  })
}

const handleSeeked = () => {
  emit('seeked')
}

watch(() => props.videoFile, () => {
  if (props.videoFile) {
    setupStreamingVideo()
  }
}, { immediate: true })

onUnmounted(() => {
  if (mediaSource) {
    mediaSource.removeEventListener('sourceopen', () => {})
    if (mediaSource.readyState === 'open') {
      mediaSource.endOfStream()
    }
  }
})
</script>
