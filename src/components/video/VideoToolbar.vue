<template>
  <div class="fit row items-center justify-evenly q-gutter-sm">
    <MoonshineButton
      round
      color="primary"
      icon="fast_rewind"
      anchor="top"
      tooltip-text="上一帧"
      :disabled="!videoStore.hasVideoFile"
      @click="emit('previous-frame')"
    />

    <MoonshineButton
      :model-value="videoStore.isPlaying"
      :toggle="true"
      round
      color="primary"
      toggle-color="negative"
      icon="play_arrow"
      toggle-icon="pause"
      anchor="top"
      tooltip-text="播放"
      toggle-tooltip-text="暂停"
      :disabled="!videoStore.hasVideoFile"
      @click="emit('play-pause')"
    />

    <MoonshineButton
      round
      color="primary"
      icon="stop"
      anchor="top"
      tooltip-text="停止"
      :disabled="!videoStore.hasVideoFile"
      @click="emit('stop')"
    />

    <MoonshineButton
      round
      :color="videoStore.isMuted ? 'negative' : 'primary'"
      :icon="videoStore.isMuted ? 'volume_off' : 'volume_up'"
      anchor="top"
      :tooltip-text="videoStore.isMuted ? '取消静音' : '静音'"
      :disabled="!videoStore.hasVideoFile"
      @click="emit('toggle-mute')"
    />

    <MoonshineButton
      round
      color="primary"
      icon="fast_forward"
      anchor="top"
      tooltip-text="下一帧"
      :disabled="!videoStore.hasVideoFile"
      @click="emit('next-frame')"
    />

    <q-btn-dropdown
      :label="`${videoStore.playbackRate}x`"
      color="primary"
      dense
      :disable="!videoStore.hasVideoFile"
    >
      <q-list>
        <q-item
          v-for="rate in playbackRates"
          :key="rate"
          clickable
          v-close-popup
          @click="emit('playback-rate-change', rate)"
          :class="{ 'bg-primary text-white': rate === videoStore.playbackRate }"
        >
          <q-item-section>
            <q-item-label>{{ rate }}x</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-btn-dropdown>
  </div>
</template>

<script setup>
import MoonshineButton from "src/components/common/MoonshineButton.vue";
import { useVideoManagerStore } from "src/stores/videoManager";

const emit = defineEmits([
  "play-pause",
  "stop",
  "toggle-mute",
  "previous-frame",
  "next-frame",
  "playback-rate-change",
]);

const videoStore = useVideoManagerStore();
const playbackRates = [0.5, 1, 1.5, 2, 3];
</script>
