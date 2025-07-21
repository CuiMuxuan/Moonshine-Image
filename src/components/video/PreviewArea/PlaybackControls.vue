<template>
  <div class="playback-controls">
    <q-btn
      :icon="isPlaying ? 'pause' : 'play_arrow'"
      @click="onPlayToggle"
      :disabled="!currentVideoFile || !duration"
      color="primary"
      round
      size="lg"
    />

    <div class="time-info">
      <span class="current-time">{{ formatTime(currentTime) }}</span>
      <span class="separator">/</span>
      <span class="duration">{{ formatTime(duration) }}</span>
    </div>

    <div class="frame-controls">
      <q-btn
        icon="skip_previous"
        @click="onPreviousFrame"
        :disable="currentTime <= 0"
        flat
        round
        size="sm"
      >
        <q-tooltip>上一帧</q-tooltip>
      </q-btn>

      <q-btn
        icon="skip_next"
        @click="onNextFrame"
        :disable="currentTime >= duration"
        flat
        round
        size="sm"
      >
        <q-tooltip>下一帧</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useVideoHandleManager } from '../../../stores/videoHandleManager'

const videoHandleManager = useVideoHandleManager()
const {
  currentTime,
  duration,
  isPlaying,
  currentVideoFile
} = storeToRefs(videoHandleManager)
const {
  formatTime,
  onPlayToggle,
  onPreviousFrame,
  onNextFrame
} = videoHandleManager
</script>

<style scoped>
.playback-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.8);
  border-radius: 8px;
  color: white;
}

.time-info {
  font-family: monospace;
  font-size: 14px;
  min-width: 120px;
  text-align: center;
}

.frame-controls {
  display: flex;
  gap: 4px;
}

.separator {
  margin: 0 4px;
  opacity: 0.7;
}
</style>
