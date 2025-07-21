<template>
  <div class="track-control-area column fit">
    <!-- 控制头部 -->
    <div class="control-header row justify-between items-center q-pa-md bg-grey-1">
      <div class="mode-controls">
        <ModeSwitch />
      </div>
      <div class="zoom-controls">
        <ZoomControls />
      </div>
    </div>

    <!-- 时间轴容器 -->
    <div class="timeline-container">
      <TimelineRuler :pixels-per-second="pixelsPerSecond" />
    </div>

    <!-- 轨道区域 -->
    <div class="tracks-area col relative-position">
      <TrackDisplayArea :pixels-per-second="pixelsPerSecond" />
      <TrackPlayhead :pixels-per-second="pixelsPerSecond" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import ModeSwitch from './ModeSwitch.vue'
import ZoomControls from './ZoomControls.vue'
import TimelineRuler from './TimelineRuler.vue'
import TrackDisplayArea from './TrackDisplayArea/TrackDisplayArea.vue'
import TrackPlayhead from './TrackPlayhead.vue'

const pixelsPerSecond = ref(50)
</script>

<style scoped>
.track-control-area {
  background: white;
  border-radius: 8px;
  overflow: hidden;
}

.timeline-container {
  border-bottom: 1px solid #e0e0e0;
}

.tracks-area {
  overflow: hidden;
}
</style>
