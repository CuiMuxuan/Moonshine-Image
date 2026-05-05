<template>
  <transition name="startup-overlay">
    <div v-if="modelValue" class="startup-overlay" aria-hidden="true">
      <div class="startup-overlay-backdrop"></div>
      <video
        ref="videoRef"
        class="startup-overlay-video"
        :src="startupVideoSrc"
        autoplay
        muted
        playsinline
        @ended="finish"
        @error="finish"
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
let fallbackTimer = 0;
let finished = false;

const clearFallbackTimer = () => {
  window.clearTimeout(fallbackTimer);
  fallbackTimer = 0;
};

const finish = () => {
  if (finished) return;
  finished = true;
  clearFallbackTimer();
  emit("update:modelValue", false);
  emit("finished");
};

const startPlayback = async () => {
  clearFallbackTimer();
  finished = false;

  await nextTick();

  fallbackTimer = window.setTimeout(finish, 8500);
  const video = videoRef.value;
  if (!video) {
    finish();
    return;
  }

  video.currentTime = 0;
  video.load();
  video.play?.().catch(() => {
    finish();
  });
};

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      void startPlayback();
      return;
    }

    clearFallbackTimer();
  },
  {
    immediate: true,
    flush: "post",
  }
);

onUnmounted(() => {
  clearFallbackTimer();
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
  transition: opacity 0.22s ease;
}

.startup-overlay-enter-from,
.startup-overlay-leave-to {
  opacity: 0;
}
</style>
