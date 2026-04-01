<template>
  <div class="canvas-player fit row flex-center">
    <div
      v-if="videoStore.hasVideoFile"
      class="canvas-stage"
      :style="playerSize"
    >
      <div ref="canvasWrapper" class="canvas-wrapper"></div>
      <div class="canvas-overlay-layer">
        <slot name="overlay"></slot>
      </div>
    </div>
    <div
      v-else
      class="empty-state fit column flex-center"
      :class="emptyStateClass"
      :style="playerSize"
    >
      <div class="empty-content text-center">
        <img class="empty-state-logo" :src="emptyStateLogoImage" alt="Moonshine Logo" />
        <p class="q-mt-md" :class="emptyStateTextClass">
          Upload a video from the left panel to start editing.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { AVCanvas } from "@webav/av-canvas";
import { MP4Clip, VisibleSprite } from "@webav/av-cliper";

import { useVideoManagerStore } from "../../stores/videoManager";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

const videoStore = useVideoManagerStore();
const $q = useQuasar();

const canvasWrapper = ref(null);
let avCvs = null;
let visibleSprite = null;
let videoSprite = null;
let loadVersion = 0;
let pendingCanvasSetup = null;
let canvasSetupPromise = null;

const createDeferred = () => {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve,
  };
};

const createReadyState = (version) => ({
  version,
  settled: false,
  ready: false,
  error: null,
  deferred: createDeferred(),
});

let playerReadyState = createReadyState(loadVersion);

const playerSize = computed(() => {
  if (videoStore.hasVideoFile && videoStore.displayWidth > 0 && videoStore.displayHeight > 0) {
    return {
      width: `${videoStore.displayWidth}px`,
      height: `${videoStore.displayHeight}px`,
    };
  }

  if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
    return {
      width: `${videoStore.playerWidth}px`,
      height: `${videoStore.playerHeight}px`,
    };
  }

  return {
    width: "100%",
    height: "100%",
  };
});

const emptyStateClass = computed(() =>
  $q.dark.isActive ? "empty-state--dark" : "empty-state--light"
);
const emptyStateTextClass = computed(() =>
  $q.dark.isActive ? "text-grey-4" : "text-grey-7"
);
const emptyStateLogoImage = resolvePublicAssetPath("icons/cmx-logo256.png");

const destroyVideoClip = () => {
  if (videoSprite) {
    try {
      videoSprite.destroy();
    } catch (error) {
      console.warn("Failed to destroy MP4Clip:", error);
    }
    videoSprite = null;
  }
};

const destroyCanvas = () => {
  const currentCanvas = avCvs;
  avCvs = null;

  if (currentCanvas) {
    try {
      currentCanvas.pause?.();
      currentCanvas.destroy();
    } catch (error) {
      console.warn("Failed to destroy AVCanvas:", error);
    }
  }

  visibleSprite = null;
  videoStore.setIsPlaying(false);

  if (canvasWrapper.value instanceof HTMLElement) {
    canvasWrapper.value.innerHTML = "";
  }
};

const startReadyCycle = (version) => {
  pendingCanvasSetup = null;
  playerReadyState = createReadyState(version);
};

const finishReadyCycle = (version, error = null) => {
  if (playerReadyState.version !== version || playerReadyState.settled) return;
  playerReadyState.settled = true;
  playerReadyState.error =
    error instanceof Error ? error : error ? new Error(String(error)) : null;
  playerReadyState.ready = !playerReadyState.error;
  playerReadyState.deferred.resolve();
};

const waitForReady = async (timeoutMs = 8000) => {
  if (!videoStore.hasVideoFile) return;

  const state = playerReadyState;
  if (
    state.ready &&
    state.version === loadVersion &&
    !state.error &&
    avCvs &&
    visibleSprite &&
    videoSprite
  ) {
    return;
  }

  let timerId = null;
  try {
    await Promise.race([
      state.deferred.promise,
      new Promise((_, reject) => {
        timerId = window.setTimeout(() => {
          reject(new Error("Video player initialization timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  }

  if (state !== playerReadyState) {
    await waitForReady(timeoutMs);
    return;
  }

  if (state.error) {
    throw state.error;
  }

  if (!state.ready || !avCvs || !visibleSprite || !videoSprite) {
    throw new Error("Video player is not ready.");
  }
};

const createVideoClip = async (file, version) => {
  const stream = file.stream();
  const clip = new MP4Clip(stream, {
    __unsafe_hardwareAcceleration__: "no-preference",
    audio: { volume: videoStore.isMuted ? 0 : 1 },
  });

  const { duration, width, height } = await clip.ready;
  if (version !== loadVersion) {
    clip.destroy();
    return null;
  }

  videoStore.setVideoInfo(width, height, duration / 1e6);
  if (videoStore.playerWidth > 0 && videoStore.playerHeight > 0) {
    videoStore.calculateDisplaySize(videoStore.playerWidth, videoStore.playerHeight);
  }
  videoSprite = clip;
  return clip;
};

const createCanvas = async (version) => {
  if (!canvasWrapper.value || !videoStore.hasVideoFile || !videoSprite) return;
  if (!(canvasWrapper.value instanceof HTMLElement)) return;
  if (version !== loadVersion) return;

  const canvasWidth = videoStore.videoWidth || 1280;
  const canvasHeight = videoStore.videoHeight || 720;

  const nextCanvas = new AVCanvas(canvasWrapper.value, {
    bgColor: "#000",
    width: canvasWidth,
    height: canvasHeight,
  });
  const currentVersion = version;

  nextCanvas.on("timeupdate", (time) => {
    if (currentVersion !== loadVersion) return;
    videoStore.setCurrentTime(time / 1e6);
  });
  nextCanvas.on("playing", () => {
    if (currentVersion !== loadVersion) return;
    videoStore.setIsPlaying(true);
  });
  nextCanvas.on("paused", () => {
    if (currentVersion !== loadVersion) return;
    videoStore.setIsPlaying(false);
  });

  const nextSprite = new VisibleSprite(videoSprite);
  await nextCanvas.addSprite(nextSprite);

  if (currentVersion !== loadVersion) {
    try {
      nextCanvas.destroy();
    } catch (error) {
      console.warn("Failed to destroy stale AVCanvas:", error);
    }
    return;
  }

  avCvs = nextCanvas;
  visibleSprite = nextSprite;
};

const maybeCompletePendingCanvasSetup = async () => {
  if (canvasSetupPromise) {
    await canvasSetupPromise;
    return;
  }

  const pending = pendingCanvasSetup;
  if (!pending || pending.version !== loadVersion) return;
  if (!(canvasWrapper.value instanceof HTMLElement)) return;
  if (!(videoStore.playerWidth > 0 && videoStore.playerHeight > 0) || !videoSprite) return;

  canvasSetupPromise = (async () => {
    try {
      await nextTick();
      await createCanvas(pending.version);
      if (pending.version !== loadVersion) return;
      if (!avCvs || !visibleSprite) return;

      await previewFrame(pending.restoreTime);
      if (pending.version !== loadVersion) return;

      pendingCanvasSetup = null;
      finishReadyCycle(pending.version);
    } catch (error) {
      pendingCanvasSetup = null;
      finishReadyCycle(pending.version, error);
      console.warn("Failed to finish player setup:", error);
    }
  })();

  try {
    await canvasSetupPromise;
  } finally {
    canvasSetupPromise = null;
  }
};

const queueCanvasSetup = async (version, restoreTime = 0) => {
  pendingCanvasSetup = {
    version,
    restoreTime,
  };
  await maybeCompletePendingCanvasSetup();
};

const loadVideoIntoPlayer = async (file, version, restoreTime = 0) => {
  startReadyCycle(version);
  destroyCanvas();
  destroyVideoClip();

  try {
    const clip = await createVideoClip(file, version);
    if (!clip || version !== loadVersion) return;
    await queueCanvasSetup(version, restoreTime);
  } catch (error) {
    if (version !== loadVersion) return;
    pendingCanvasSetup = null;
    finishReadyCycle(version, error);
    console.warn("Failed to load video player:", error);
  }
};

const rebuildPlayer = async ({ keepTime = true, keepPlaying = false } = {}) => {
  if (!videoStore.videoFile) return false;

  const version = ++loadVersion;
  const restoreTime = keepTime ? videoStore.currentTime : 0;
  try {
    await loadVideoIntoPlayer(videoStore.videoFile, version, restoreTime);
    await waitForReady();
    if (version !== loadVersion) return false;
    if (keepPlaying) {
      play();
    }
    return true;
  } catch (error) {
    console.warn("Failed to rebuild player:", error);
    return false;
  }
};

const play = () => {
  if (!avCvs || !videoStore.hasVideoFile || !visibleSprite) return;
  try {
    avCvs.play({
      start: videoStore.currentTime * 1e6,
      playbackRate: videoStore.playbackRate,
    });
  } catch (error) {
    console.warn("Failed to play video:", error);
    videoStore.setIsPlaying(false);
  }
};

const pause = () => {
  if (avCvs) {
    avCvs.pause();
  }
};

const stop = () => {
  pause();
  previewFrame(0);
};

const togglePlayPause = () => {
  if (!avCvs || !videoStore.hasVideoFile || !visibleSprite) return;
  if (videoStore.isPlaying) {
    pause();
  } else {
    play();
  }
};

const previewFrame = async (timeInSeconds) => {
  if (avCvs && videoStore.hasVideoFile && visibleSprite) {
    const safeTime = Math.max(0, Math.min(videoStore.videoDuration, timeInSeconds));
    const activeCanvas = avCvs;

    try {
      await activeCanvas.previewFrame(safeTime * 1e6);
      if (activeCanvas !== avCvs) return;
      videoStore.setCurrentTime(safeTime);
    } catch (error) {
      if (activeCanvas !== avCvs) return;
      console.warn("Failed to preview frame:", error);
    }
  }
};

const previousFrame = () => {
  if (!videoStore.hasVideoFile) return;
  const frameTime = 1 / Math.max(videoStore.sourceFrameRate || 30, 1);
  const newTime = Math.max(0, videoStore.currentTime - frameTime);
  previewFrame(newTime);
  if (videoStore.isPlaying) {
    pause();
  }
};

const nextFrame = () => {
  if (!videoStore.hasVideoFile) return;
  const frameTime = 1 / Math.max(videoStore.sourceFrameRate || 30, 1);
  const newTime = Math.min(videoStore.videoDuration, videoStore.currentTime + frameTime);
  previewFrame(newTime);
  if (videoStore.isPlaying) {
    pause();
  }
};

const seekTo = async (timeInSeconds) => {
  if (!videoStore.hasVideoFile) return false;

  try {
    await waitForReady();
    await previewFrame(Math.max(0, Math.min(videoStore.videoDuration, timeInSeconds)));
    return true;
  } catch (error) {
    console.warn("Failed to seek video:", error);
    return false;
  }
};

watch(
  () => videoStore.videoFile,
  async (newFile) => {
    const version = ++loadVersion;
    if (newFile) {
      const restoreTime = Math.max(
        0,
        Math.min(Number(videoStore.currentTime || 0), Number(videoStore.videoDuration || 0))
      );
      await loadVideoIntoPlayer(newFile, version, restoreTime);
    } else {
      startReadyCycle(version);
      destroyCanvas();
      destroyVideoClip();
      pendingCanvasSetup = null;
      videoStore.clearVideoInfo();
    }
  },
  { immediate: true }
);

watch(
  canvasWrapper,
  async () => {
    await maybeCompletePendingCanvasSetup();
  },
  { flush: "post" }
);

watch(
  () => [videoStore.playerWidth, videoStore.playerHeight],
  async ([newWidth, newHeight]) => {
    if (newWidth > 0 && newHeight > 0) {
      videoStore.calculateDisplaySize(newWidth, newHeight);
      await maybeCompletePendingCanvasSetup();
    }
  }
);

watch(
  () => videoStore.playbackRate,
  () => {
    if (videoStore.isPlaying && avCvs && visibleSprite) {
      avCvs.pause();
      setTimeout(() => {
        play();
      }, 50);
    }
  }
);

watch(
  () => videoStore.isMuted,
  async (muted, previous) => {
    if (muted === previous || !videoStore.videoFile) return;
    await rebuildPlayer({
      keepTime: true,
      keepPlaying: videoStore.isPlaying,
    });
  }
);

defineExpose({
  play,
  pause,
  stop,
  togglePlayPause,
  previewFrame,
  previousFrame,
  nextFrame,
  seekTo,
  rebuildPlayer,
  waitForReady,
});

onUnmounted(() => {
  destroyCanvas();
  destroyVideoClip();
});
</script>

<style scoped>
.canvas-wrapper {
  position: absolute;
  inset: 0;
}

.canvas-stage {
  position: relative;
  background-color: #000;
  border-radius: 4px;
  overflow: hidden;
}

.canvas-wrapper :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
}

.canvas-overlay-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
}

.empty-state {
  border-radius: 4px;
  transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease;
}

.empty-state-logo {
  width: clamp(76px, 14vw, 132px);
  height: clamp(76px, 14vw, 132px);
  object-fit: contain;
  display: block;
  margin: 0 auto;
}

.empty-state--light {
  background-color: #f5f5f5;
  border: 2px dashed #d4d4d8;
}

.empty-state--dark {
  background-color: #171717;
  border: 2px dashed rgba(255, 255, 255, 0.16);
}
</style>
