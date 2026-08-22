<template>
  <transition name="startup-overlay">
    <div
      v-if="modelValue"
      class="startup-overlay"
      :class="{ 'startup-overlay--ready': videoReady }"
      aria-hidden="true"
    >
      <div class="startup-overlay-backdrop"></div>
      <video
        ref="videoRef"
        class="startup-overlay-video"
        :src="startupVideoSrc"
        preload="auto"
        muted
        playsinline
        @loadeddata="handleVideoReady"
        @canplay="handleVideoReady"
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
const videoReady = ref(false);
const FALLBACK_TIMEOUT_MS = 12000;
const PLAYBACK_RETRY_DELAY_MS = 160;
const MAX_PLAYBACK_RETRIES = 1;
let fallbackTimer = 0;
let playbackRetryTimer = 0;
let playbackAttempt = 0;
let playbackScheduled = false;
let finished = false;

const clearFallbackTimer = () => {
  window.clearTimeout(fallbackTimer);
  fallbackTimer = 0;
};

const clearPlaybackRetryTimer = () => {
  window.clearTimeout(playbackRetryTimer);
  playbackRetryTimer = 0;
};

const waitForFirstFramePaint = () =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });

const finish = () => {
  if (finished) return;
  finished = true;
  clearFallbackTimer();
  clearPlaybackRetryTimer();
  playbackScheduled = false;
  emit("update:modelValue", false);
  emit("finished");
};

const schedulePlayback = async () => {
  if (finished || !props.modelValue || playbackScheduled) return;

  const video = videoRef.value;
  if (!video || video.readyState < 2) return;

  playbackScheduled = true;
  await nextTick();
  await waitForFirstFramePaint();

  if (finished || !props.modelValue || video !== videoRef.value) {
    playbackScheduled = false;
    return;
  }

  const retryPlayback = () => {
    playbackScheduled = false;
    if (finished || !props.modelValue || playbackAttempt >= MAX_PLAYBACK_RETRIES) return;

    playbackAttempt += 1;
    playbackRetryTimer = window.setTimeout(() => {
      void schedulePlayback();
    }, PLAYBACK_RETRY_DELAY_MS);
  };

  try {
    const playback = video.play?.();
    playback?.catch(retryPlayback);
  } catch {
    retryPlayback();
  }
};

const handleVideoReady = () => {
  if (finished || !props.modelValue) return;

  videoReady.value = true;
  void schedulePlayback();
};

const handleVideoError = () => {
  finish();
};

const startPlayback = async () => {
  clearFallbackTimer();
  clearPlaybackRetryTimer();
  finished = false;
  videoReady.value = false;
  playbackAttempt = 0;
  playbackScheduled = false;

  await nextTick();

  const video = videoRef.value;
  if (!video) {
    finish();
    return;
  }

  fallbackTimer = window.setTimeout(finish, FALLBACK_TIMEOUT_MS);
  video.load();
  if (video.readyState >= 2) handleVideoReady();
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
    playbackScheduled = false;
    videoReady.value = false;
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
  opacity: 0;
  transition: opacity 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.startup-overlay--ready .startup-overlay-video {
  opacity: 1;
}

.startup-overlay-enter-active,
.startup-overlay-leave-active {
  transition: opacity 0.22s cubic-bezier(0.23, 1, 0.32, 1);
}

.startup-overlay-enter-from,
.startup-overlay-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .startup-overlay-video {
    transition-duration: 0ms;
  }

  .startup-overlay-enter-active,
  .startup-overlay-leave-active {
    transition-duration: 120ms;
  }
}
</style>
