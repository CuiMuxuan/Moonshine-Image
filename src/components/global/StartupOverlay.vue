<template>
  <transition name="startup-overlay">
    <div
      v-if="modelValue"
      class="startup-overlay"
      aria-hidden="true"
    >
      <div class="startup-overlay-backdrop"></div>
      <video
        ref="videoRef"
        class="startup-overlay-video"
        :src="startupVideoSrc"
        preload="auto"
        autoplay
        muted
        playsinline
        @ended="finish"
        @error="handleVideoError"
      />
    </div>
  </transition>
</template>

<script setup>
import { nextTick, onUnmounted, ref, watch } from "vue";

import { resolvePublicAssetPath } from "src/utils/publicAsset";

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["update:modelValue", "finished"]);

const startupVideoSrc = resolvePublicAssetPath("videos/start.webm");
const videoRef = ref(null);
const STARTUP_PLAYBACK_RATE = 1.5;
const FALLBACK_TIMEOUT_MS = 8500;
const PLAYBACK_RETRY_DELAY_MS = 160;
const MAX_PLAYBACK_RETRIES = 1;
let fallbackTimer = 0;
let playbackRetryTimer = 0;
let playbackAttempt = 0;
let finished = false;

const clearFallbackTimer = () => {
  window.clearTimeout(fallbackTimer);
  fallbackTimer = 0;
};

const clearPlaybackRetryTimer = () => {
  window.clearTimeout(playbackRetryTimer);
  playbackRetryTimer = 0;
};

const finish = () => {
  if (finished) return;
  finished = true;
  clearFallbackTimer();
  clearPlaybackRetryTimer();
  emit("update:modelValue", false);
  emit("finished");
};

const startVideoPlayback = () => {
  if (finished || !props.modelValue) return;
  const video = videoRef.value;
  if (!video) return;

  const retryPlayback = () => {
    if (finished || !props.modelValue || playbackAttempt >= MAX_PLAYBACK_RETRIES) return;

    playbackAttempt += 1;
    playbackRetryTimer = window.setTimeout(() => {
      startVideoPlayback();
    }, PLAYBACK_RETRY_DELAY_MS);
  };

  try {
    const playback = video.play?.();
    playback?.catch(retryPlayback);
  } catch {
    retryPlayback();
  }
};

const handleVideoError = () => {
  finish();
};

const startPlayback = async () => {
  clearFallbackTimer();
  clearPlaybackRetryTimer();
  finished = false;
  playbackAttempt = 0;

  await nextTick();

  const video = videoRef.value;
  if (!video) {
    finish();
    return;
  }

  fallbackTimer = window.setTimeout(finish, FALLBACK_TIMEOUT_MS);
  video.defaultPlaybackRate = STARTUP_PLAYBACK_RATE;
  video.playbackRate = STARTUP_PLAYBACK_RATE;
  video.currentTime = 0;
  video.load();
  video.playbackRate = STARTUP_PLAYBACK_RATE;
  // The video is muted and has autoplay enabled, so Chromium permits this
  // direct playback call even when the overlay is shown from a file URL.
  startVideoPlayback();
};

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      void startPlayback();
      return;
    }

    clearFallbackTimer();
    clearPlaybackRetryTimer();
  },
  {
    immediate: true,
    flush: "post",
  }
);

onUnmounted(() => {
  clearFallbackTimer();
  clearPlaybackRetryTimer();
});
</script>

<style scoped>
.startup-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  pointer-events: all;
  background: transparent;
}

.startup-overlay-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: rgba(8, 9, 12, 0.68);
}

.startup-overlay-video {
  position: relative;
  z-index: 1;
  width: 100vw;
  height: 100vh;
  object-fit: contain;
  object-position: center center;
  display: block;
}

.startup-overlay-enter-active,
.startup-overlay-leave-active {
  transition: opacity 260ms cubic-bezier(0.23, 1, 0.32, 1);
  will-change: opacity;
}

.startup-overlay-enter-from,
.startup-overlay-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .startup-overlay-enter-active,
  .startup-overlay-leave-active {
    transition-duration: 160ms;
  }
}
</style>
