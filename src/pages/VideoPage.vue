<template>
  <q-page class="video-page">
    <div v-if="isProcessing" class="processing-page-mask"></div>
    <div class="video-layout">
      <div class="top-row" :class="{ 'has-timeline': videoStore.hasVideoFile }">
        <q-card class="left-panel">
          <q-card-section class="side-panel-body">
            <ResourceManage
              v-model:export-fps-mode="exportFpsMode"
              :fps-options="fpsOptions"
              :proxy-size-text="proxySizeText"
              :export-size-text="exportSizeText"
              :computed-batch-size="computedBatchSize"
              :can-run="canRun"
              :can-open-output="canOpenOutput"
              :is-processing="isProcessing"
              :processing-progress="processingProgress"
              :processing-message="processingMessage"
              :last-output-path="lastOutputPath"
              :processing-succeeded="processingSucceeded"
              :can-replace-source="canReplaceCurrentSource"
              :can-rollback-history="videoStore.canOpenVideoHistory"
              :history-entries="historyEntries"
              @run="runVideoProcessing"
              @open-output="openOutputDir"
              @replace-source="replaceCurrentVideoSource"
              @restore-history="restoreVideoHistory"
            />
          </q-card-section>
        </q-card>

        <q-card class="center-panel">
          <q-card-section class="player-section" ref="playerContainer">
            <div class="preview-stage-wrap">
              <CanvasPlayer ref="canvasPlayerRef" class="player-canvas">
                <template #overlay>
                  <VideoPreviewOverlay
                    ref="videoOverlayRef"
                    v-if="videoStore.hasVideoFile && videoStore.displayWidth && videoStore.displayHeight"
                    :display-width="videoStore.displayWidth"
                    :display-height="videoStore.displayHeight"
                    :source-width="videoStore.videoWidth"
                    :source-height="videoStore.videoHeight"
                    :disabled="isProcessing"
                  />
                </template>
              </CanvasPlayer>
            </div>
          </q-card-section>
        </q-card>

        <q-card class="right-panel">
          <q-card-section class="side-panel-body">
            <VideoMaskEditor
              :disabled="!videoStore.hasVideoFile || isProcessing"
            />
          </q-card-section>
        </q-card>
      </div>

      <q-card v-if="videoStore.hasVideoFile" class="timeline-panel">
        <q-card-section
          class="timeline-controls"
          :class="{ 'timeline-controls-disabled': timelineControlsDisabled }"
        >
          <div class="timeline-controls-scroll">
            <div class="timeline-controls-row">
              <q-btn
                round
                dense
                flat
                color="primary"
                icon="stop"
                :disable="timelineControlsDisabled"
                @click="handleStop"
              >
                <q-tooltip>Stop</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                icon="fast_rewind"
                :disable="timelineControlsDisabled"
                @click="handlePreviousFrame"
              >
                <q-tooltip>Prev Frame</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                :icon="videoStore.isPlaying ? 'pause' : 'play_arrow'"
                :disable="timelineControlsDisabled"
                @click="handlePlayPause"
              >
                <q-tooltip>{{ videoStore.isPlaying ? "Pause" : "Play" }}</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                icon="fast_forward"
                :disable="timelineControlsDisabled"
                @click="handleNextFrame"
              >
                <q-tooltip>Next Frame</q-tooltip>
              </q-btn>

              <div class="timeline-progress-control">
                <q-slider
                  v-model="currentProgress"
                  class="timeline-progress-slider"
                  :min="0"
                  :max="Math.max(videoStore.videoDuration, 0.001)"
                  :step="0.001"
                  :disable="timelineControlsDisabled"
                  @update:model-value="handleProgressChange"
                  @pan="handleProgressDrag"
                  color="primary"
                  track-size="6px"
                  track-color="grey-4"
                  thumb-color="primary"
                />
                <span class="timeline-time-display">{{ timelineTimeText }}</span>
              </div>

              <q-btn-dropdown
                dense
                no-caps
                color="primary"
                unelevated
                :label="`${videoStore.playbackRate}x`"
                :disable="timelineControlsDisabled"
              >
                <q-list>
                  <q-item
                    v-for="rate in playbackRates"
                    :key="rate"
                    clickable
                    v-close-popup
                    @click="handlePlaybackRateChange(rate)"
                    :class="{ 'bg-primary text-white': rate === videoStore.playbackRate }"
                  >
                    <q-item-section>
                      <q-item-label>{{ rate }}x</q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-btn-dropdown>

              <q-btn
                round
                dense
                flat
                :color="videoStore.isMuted ? 'negative' : 'primary'"
                :icon="videoStore.isMuted ? 'volume_off' : 'volume_up'"
                :disable="timelineControlsDisabled"
                @click="handleToggleMute"
              >
                <q-tooltip>{{ videoStore.isMuted ? "Unmute" : "Mute" }}</q-tooltip>
              </q-btn>

              <div class="timeline-zoom-control">
                <q-btn
                  round
                  dense
                  flat
                  color="primary"
                  icon="zoom_out"
                  :disable="timelineZoomDisabled"
                  @click="decreaseTimelineZoom"
                >
                  <q-tooltip>Zoom Out</q-tooltip>
                </q-btn>
                <q-slider
                  v-model="timelineZoomPercent"
                  class="timeline-zoom-slider"
                  :min="0"
                  :max="100"
                  :step="timelineZoomStep"
                  :disable="timelineZoomDisabled"
                  color="primary"
                  track-size="6px"
                  track-color="grey-4"
                  thumb-color="primary"
                />
                <q-btn
                  round
                  dense
                  flat
                  color="primary"
                  icon="zoom_in"
                  :disable="timelineZoomDisabled"
                  @click="increaseTimelineZoom"
                >
                  <q-tooltip>Zoom In</q-tooltip>
                </q-btn>
              </div>
            </div>
          </div>
        </q-card-section>
        <q-card-section class="timeline-wrap" :class="{ 'timeline-disabled': isProcessing }">
          <div ref="timelineViewportRef" class="timeline-editor-host">
          <TimelineEditor
            ref="timelineRef"
            :model-value="timelineRows"
            :effects="timelineEffects"
            :options="timelineOptions"
            :auto-scroll="true"
             @update:model-value="handleTimelineModelChange"
             @time-update="handleTimelineTimeUpdate"
             @scroll="handleTimelineScroll"
             @click-action="handleTimelineActionClick"
             @action-move-end="handleTimelineActionMoveEnd"
             @action-resize-end="handleTimelineActionResizeEnd"
           >
            <template #action="{ action }">
              <div
                class="timeline-action"
                :class="{
                  'timeline-action-range': action.data?.kind === 'mask-range',
                  'timeline-action-keyframe': action.data?.kind === 'mask-keyframe',
                }"
              >
                <span v-if="action.data?.kind === 'mask-range'">
                  {{ action.data?.label || action.id }}
                </span>
                <span v-else class="keyframe-dot"></span>
              </div>
            </template>
          </TimelineEditor>
          </div>
        </q-card-section>
      </q-card>
    </div>
  </q-page>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { onBeforeRouteLeave } from "vue-router";
import TimelineEditor from "vue-timeline-editor";
import "vue-timeline-editor/dist/vue-timeline-editor.css";
import {
  Combinator,
  MP4Clip,
  OffscreenSprite,
  fastConcatMP4,
  mixinMP4AndAudio,
} from "@webav/av-cliper";

import { useConfigStore } from "src/stores/config";
import { useConfiguredShortcuts } from "src/composables/useConfiguredShortcuts";
import { useVideoManagerStore } from "src/stores/videoManager";
import { submitVideoBatchInpaint } from "src/services/VideoProcessingService";
import { MASK_TOOL_MODES } from "src/utils/maskTool";
import {
  formatSeconds,
  getVideoCenterAnchor,
  getInterpolatedMaskTransform,
  loadImageElement,
  MASK_KEYFRAME_TYPES,
  sortMaskKeyframes,
} from "src/utils/videoMaskUtils";

import CanvasPlayer from "src/components/video/CanvasPlayer.vue";
import ResourceManage from "src/components/video/ResourceManage.vue";
import VideoMaskEditor from "src/components/video/VideoMaskEditor.vue";
import VideoPreviewOverlay from "src/components/video/VideoPreviewOverlay.vue";

const $q = useQuasar();
const videoStore = useVideoManagerStore();
const configStore = useConfigStore();
const loadingControl = inject("loadingControl", null);
const backendRunningState = inject("backendRunning", ref(false));

const playerContainer = ref(null);
const canvasPlayerRef = ref(null);
const timelineRef = ref(null);
const timelineViewportRef = ref(null);
const videoOverlayRef = ref(null);

const currentProgress = ref(0);
const isDragging = ref(false);
const isProcessing = ref(false);
const processingSucceeded = ref(false);
const processingProgress = ref(0);
const processingMessage = ref("");
const lastOutputPath = ref("");
const exportFpsMode = ref("source");
const sourceFps = ref(30);
const timelineRows = ref([]);
const timelineViewportWidth = ref(0);
const timelineScrollLeft = ref(0);
const timelineZoomPercent = ref(0);

let syncingTimelineFromStore = false;
let processingEtaTickerId = null;
let processingBatchMessageContext = null;
let preserveLastOutputPathOnNextVideoChange = false;
const playbackRates = [0.5, 1, 1.5, 2, 3];
const timelineScaleWidth = 160;
const timelineStartLeft = 20;
const timelineZoomStep = 5;
const VIDEO_READY_TIMEOUT_MS = 30000;
const PROCESSING_ETA_TICK_MS = 250;
const PROCESSING_FINAL_STAGE_PLACEHOLDER_SECONDS = 5;
const PROCESSING_ETA_MODES = {
  DYNAMIC: "dynamic",
  FREEZE: "freeze",
};
const VIDEO_MOUNT_LOADING_PROGRESS = Object.freeze({
  PREPARE: 0.18,
  PREVIEW: 0.62,
  TIMELINE: 0.88,
  FINALIZE: 0.97,
});

const processingEtaState = {
  firstResponseSeconds: null,
  estimateBaseSeconds: null,
  estimateFloorSeconds: 0,
  estimateStartedAtMs: 0,
  frozenSeconds: null,
  progressAwareCapSeconds: null,
  progressAwareFloorSeconds: null,
  progressAwareStageBaseSeconds: null,
  sessionStartedAtMs: 0,
};
const videoMountLoadingState = {
  token: 0,
  externallyManaged: false,
};

const timelineEffects = {
  "effect-mask-range": { id: "effect-mask-range", name: "Mask Range" },
  "effect-mask-keyframe": { id: "effect-mask-keyframe", name: "Keyframe" },
};

const fpsOptions = computed(() => [
  { label: `跟随源视频（估算 ${sourceFps.value} fps）`, value: "source" },
  { label: "24 fps", value: "24" },
  { label: "30 fps", value: "30" },
  { label: "60 fps", value: "60" },
]);

const exportFps = computed(() => {
  if (exportFpsMode.value === "source") return sourceFps.value;
  return Number(exportFpsMode.value) || sourceFps.value;
});

const historyEntries = computed(() => [...videoStore.videoHistory].reverse());
const canReplaceCurrentSource = computed(
  () => Boolean(lastOutputPath.value) && processingSucceeded.value
);
const canOpenOutput = computed(
  () =>
    Boolean(lastOutputPath.value) &&
    (processingSucceeded.value ||
      (Boolean(videoStore.currentSourceIsReplacement) && videoStore.videoHistory.length > 0))
);

const proxyDimensions = computed(() => {
  const width = videoStore.videoWidth || 0;
  const height = videoStore.videoHeight || 0;
  const maxSide = configStore.config.video?.proxyMaxSide || 1280;
  if (!width || !height) return { width: 0, height: 0, ratio: 1 };

  const side = Math.max(width, height);
  if (side <= maxSide) return { width, height, ratio: 1 };

  const ratio = maxSide / side;
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
    ratio,
  };
});

const proxySizeText = computed(() => {
  if (!videoStore.videoWidth || !videoStore.videoHeight) return "-";
  return `${proxyDimensions.value.width} x ${proxyDimensions.value.height}`;
});

const exportSizeText = computed(() => {
  if (!videoStore.videoWidth || !videoStore.videoHeight) return "-";
  return `${videoStore.videoWidth} x ${videoStore.videoHeight}`;
});

const keyframeMarkerDuration = computed(() => {
  const duration = Math.max(videoStore.videoDuration || 0, 0.1);
  return Math.min(0.08, Math.max(0.02, duration / 300));
});

const timelineOptions = computed(() => ({
  scale: timelineScale.value,
  scaleSplitCount: 10,
  scaleWidth: timelineScaleWidth,
  startLeft: timelineStartLeft,
  rowHeight: 44,
  minScaleCount: 1,
  duration: Math.max(0.1, videoStore.videoDuration || 0.1),
  gridSnap: true,
  dragLine: true,
  enableRowDrag: false,
  disableDrag: isProcessing.value,
  hideCursor: false,
}));

const timelineControlsDisabled = computed(
  () => !videoStore.hasVideoFile || isProcessing.value
);

const maxZoomVisibleDuration = computed(() => {
  const duration = Math.max(Number(videoStore.videoDuration || 0), 0);
  if (!duration) return 0.1;
  const fps = Math.max(Number(videoStore.sourceFrameRate || sourceFps.value || 30), 1);
  return Math.max(Math.min(duration, 30 / fps), 1 / fps);
});

const timelineVisibleDuration = computed(() => {
  if (!videoStore.hasVideoFile) return 0.1;
  const fullDuration = Math.max(Number(videoStore.videoDuration || 0), 0.1);
  const zoomedDuration = maxZoomVisibleDuration.value;
  const zoomRatio = timelineZoomPercent.value / 100;
  return fullDuration - (fullDuration - zoomedDuration) * zoomRatio;
});

const timelineScale = computed(() => {
  const viewportWidth = Math.max(timelineViewportWidth.value - timelineStartLeft, 1);
  const visibleUnits = Math.max(viewportWidth / timelineScaleWidth, 1);
  return Math.max(timelineVisibleDuration.value / visibleUnits, 0.0001);
});

const timelineZoomDisabled = computed(
  () =>
    timelineControlsDisabled.value ||
    Math.abs(Math.max(videoStore.videoDuration || 0, 0.1) - maxZoomVisibleDuration.value) <= 0.0005
);

const timelineTimeText = computed(
  () =>
    `${formatTimelineDuration(videoStore.currentTime)}/${formatTimelineDuration(
      videoStore.videoDuration
    )}`
);

const computedBatchSize = computed(() => {
  const configured = Number(configStore.config.video?.batchFrameCount || 120);
  if (!Number.isFinite(configured)) return 120;
  return Math.max(120, Math.round(configured));
});

const canRun = computed(
  () =>
    videoStore.hasVideoFile &&
    videoStore.videoWidth > 0 &&
    videoStore.videoHeight > 0 &&
    videoStore.videoDuration > 0 &&
    videoStore.masks.length > 0
);
const isVideoDrawingShortcutReady = computed(
  () =>
    Boolean(
      videoStore.hasVideoFile &&
        videoStore.selectedMaskId &&
        !isProcessing.value &&
        videoOverlayRef.value?.isReady?.()
    )
);
const canUndoVideoMaskShortcut = computed(
  () => Boolean(isVideoDrawingShortcutReady.value && videoStore.canUndoSelectedMaskDraw)
);

const setVideoToolMode = (mode) => {
  if (!isVideoDrawingShortcutReady.value) {
    return false;
  }

  videoStore.updateMaskTool({
    mode,
  });
  return true;
};

const restoreVideoShortcutSession = (session = {}) => {
  if (!isVideoDrawingShortcutReady.value) {
    return;
  }

  videoStore.updateMaskTool({
    drawingEnabled:
      session.videoDrawingEnabled ?? videoStore.maskTool.drawingEnabled,
    mode: session.videoToolMode ?? videoStore.maskTool.mode,
  });
};

const handleVideoShortcutPress = (actionId) => {
  switch (actionId) {
    case "drawingUndo":
      if (canUndoVideoMaskShortcut.value) {
        videoStore.undoSelectedMaskDraw();
      }
      break;
    case "drawingResetView":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.resetSelectedMaskTransformAtCurrentTime();
      }
      break;
    case "drawingToggle":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: !videoStore.maskTool.drawingEnabled,
        });
      }
      break;
    case "drawingBrush":
      setVideoToolMode(MASK_TOOL_MODES.DRAW);
      break;
    case "drawingRect":
      setVideoToolMode(MASK_TOOL_MODES.RECT);
      break;
    case "drawingErase":
      setVideoToolMode(MASK_TOOL_MODES.ERASE);
      break;
    default:
      break;
  }
};

const handleVideoShortcutHoldStart = (actionId) => {
  switch (actionId) {
    case "drawingHoldBrush":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.DRAW,
        });
      }
      break;
    case "drawingHoldRect":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.RECT,
        });
      }
      break;
    case "drawingHoldErase":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.ERASE,
        });
      }
      break;
    default:
      break;
  }
};

const handleVideoShortcutHoldEnd = (actionId, session) => {
  switch (actionId) {
    case "drawingHoldBrush":
    case "drawingHoldRect":
    case "drawingHoldErase":
      restoreVideoShortcutSession(session);
      break;
    default:
      break;
  }
};

useConfiguredShortcuts({
  enabled: computed(() => true),
  shortcutConfig: computed(() => configStore.config.shortcuts),
  createSessionContext: () => ({
    videoToolMode: videoStore.maskTool.mode,
    videoDrawingEnabled: videoStore.maskTool.drawingEnabled,
  }),
  onPress: (actionId) => {
    handleVideoShortcutPress(actionId);
  },
  onHoldStart: (actionId) => {
    handleVideoShortcutHoldStart(actionId);
  },
  onHoldEnd: (actionId, session) => {
    handleVideoShortcutHoldEnd(actionId, session);
  },
});

const getMimeTypeForPath = (filePath) => {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".mp4")) return "video/mp4";
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

const readFileBytes = async (filePath) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法读取本地文件");
  }

  const result = await window.electron.ipcRenderer.invoke("read-file", filePath);
  if (!result?.success || !result.data?.buffer) {
    throw new Error(result?.error || `读取文件失败: ${filePath}`);
  }

  return new Uint8Array(result.data.buffer);
};

const unwrapElement = (value) => {
  if (value?.$el instanceof HTMLElement) return value.$el;
  return value instanceof HTMLElement ? value : null;
};

const updateTimelineViewportWidth = () => {
  const element = unwrapElement(timelineViewportRef.value);
  timelineViewportWidth.value = Math.max(0, element?.clientWidth || 0);
};

const updateLayoutMetrics = () => {
  adjustPlayerSize();
  updateTimelineViewportWidth();
};

const getTimelineTotalWidth = () =>
  Math.max(
    timelineStartLeft,
    (Math.max(videoStore.videoDuration || 0, 0) / Math.max(timelineScale.value, 0.0001)) *
      timelineScaleWidth +
      timelineStartLeft
  );

const syncTimelineViewport = ({ center = false, ensureVisible = false } = {}) => {
  if (!videoStore.hasVideoFile) return;
  if (!timelineRef.value?.setTime) return;

  const time = Math.max(0, Math.min(videoStore.currentTime || 0, videoStore.videoDuration || 0));
  timelineRef.value.setTime(time);

  if (!timelineRef.value?.setScrollLeft || timelineViewportWidth.value <= 0) return;

  const cursorLeft =
    (time / Math.max(timelineScale.value, 0.0001)) * timelineScaleWidth + timelineStartLeft;
  const viewportWidth = timelineViewportWidth.value;
  const totalWidth = getTimelineTotalWidth();
  const maxScroll = Math.max(0, totalWidth - viewportWidth);
  const currentScroll = timelineScrollLeft.value;

  let targetScroll = currentScroll;
  if (time <= 0.0005) {
    targetScroll = 0;
  } else if (center) {
    targetScroll = cursorLeft - viewportWidth / 2;
  } else if (ensureVisible) {
    const leftBoundary = currentScroll + 40;
    const rightBoundary = currentScroll + viewportWidth - Math.min(180, viewportWidth * 0.35);

    if (cursorLeft < leftBoundary || cursorLeft > rightBoundary) {
      targetScroll = cursorLeft - viewportWidth / 2;
    } else {
      return;
    }
  } else {
    return;
  }

  targetScroll = Math.max(0, Math.min(maxScroll, targetScroll));
  timelineScrollLeft.value = targetScroll;
  timelineRef.value.setScrollLeft(targetScroll);
};

const setTimelineZoomPercent = (value) => {
  timelineZoomPercent.value = Math.max(0, Math.min(100, value));
};

const decreaseTimelineZoom = () => {
  if (timelineZoomDisabled.value) return;
  setTimelineZoomPercent(timelineZoomPercent.value - timelineZoomStep);
};

const increaseTimelineZoom = () => {
  if (timelineZoomDisabled.value) return;
  setTimelineZoomPercent(timelineZoomPercent.value + timelineZoomStep);
};

const formatTimelineDuration = (input) => {
  const totalSeconds = Math.max(Number(input || 0), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const normalizedSeconds = Number(
    seconds.toFixed(seconds < 10 && hours === 0 && minutes === 0 ? 2 : 1)
  );
  const secondText = `${normalizedSeconds}s`;

  if (hours > 0) {
    return `${hours}h${minutes}m${secondText}`;
  }
  if (minutes > 0) {
    return `${minutes}m${secondText}`;
  }
  return secondText;
};

const captureVideoUiState = () => ({
  exportFpsMode: exportFpsMode.value,
  timelineZoomPercent: timelineZoomPercent.value,
  timelineScrollLeft: timelineScrollLeft.value,
});

const restoreVideoUiState = async (uiState = {}) => {
  exportFpsMode.value = uiState.exportFpsMode || "source";
  timelineZoomPercent.value = Math.max(0, Math.min(100, Number(uiState.timelineZoomPercent || 0)));
  timelineScrollLeft.value = Math.max(0, Number(uiState.timelineScrollLeft || 0));

  await nextTick();
  if (timelineRef.value?.setTime) {
    timelineRef.value.setTime(videoStore.currentTime || 0);
  }
  if (timelineRef.value?.setScrollLeft && timelineScrollLeft.value > 0) {
    timelineRef.value.setScrollLeft(timelineScrollLeft.value);
  } else {
    syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
  }
};

const getConfiguredVideoHistoryLimit = () =>
  Math.max(1, Number(configStore.config.video?.historyLimit || 5));

const confirmHistoryTrim = () =>
  new Promise((resolve) => {
    $q.dialog({
      title: "历史记录已满",
      message: "继续替换会删除最早的一条视频历史记录，是否继续？",
      ok: {
        label: "继续",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "取消",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });

const ensureFileExists = async (filePath) => {
  if (!filePath || !window.electron?.ipcRenderer?.invoke) {
    return true;
  }
  const result = await window.electron.ipcRenderer.invoke("get-file-stats", filePath);
  return Boolean(result?.success);
};

const loadVideoFileFromPath = async (filePath) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法读取视频文件");
  }

  const result = await window.electron.ipcRenderer.invoke("read-file", filePath);
  if (!result?.success || !result.data?.buffer) {
    throw new Error(result?.error || `读取视频失败: ${filePath}`);
  }

  const bytes = new Uint8Array(result.data.buffer);
  const file = new File([bytes], result.data.name || "video.mp4", {
    type: result.data.type || "video/mp4",
    lastModified: Number(result.data.lastModified || Date.now()),
  });

  Object.defineProperty(file, "path", {
    configurable: true,
    enumerable: true,
    writable: false,
    value: filePath,
  });

  return file;
};

const waitForVideoReady = async (timeoutMs = VIDEO_READY_TIMEOUT_MS) => {
  await nextTick();
  if (canvasPlayerRef.value?.waitForReady) {
    await canvasPlayerRef.value.waitForReady(timeoutMs);
    await nextTick();
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    let stop = null;
    const finish = async () => {
      if (settled) return;
      settled = true;
      if (stop) stop();
      await nextTick();
      resolve();
    };

    const timer = window.setTimeout(() => {
      finish();
    }, timeoutMs);

    stop = watch(
      () => [videoStore.videoWidth, videoStore.videoHeight, videoStore.videoDuration],
      ([width, height]) => {
        if (width > 0 && height > 0) {
          window.clearTimeout(timer);
          finish();
        }
      },
      { immediate: true }
    );
  });
};

const beginVideoMountLoading = ({
  message = "正在读取视频信息",
  progress = VIDEO_MOUNT_LOADING_PROGRESS.PREPARE,
  external = false,
} = {}) => {
  const token = ++videoMountLoadingState.token;
  videoMountLoadingState.externallyManaged = external;
  updateGlobalLoadingOverlay(message, progress);
  return token;
};

const isActiveVideoMountLoading = (token) => token === videoMountLoadingState.token;

const updateVideoMountLoading = (token, message, progress = null) => {
  if (!isActiveVideoMountLoading(token)) {
    return false;
  }

  updateGlobalLoadingOverlay(message, progress);
  return true;
};

const finishVideoMountLoading = (token, { forceHide = false } = {}) => {
  if (!isActiveVideoMountLoading(token)) {
    return;
  }

  const shouldHide = forceHide || !videoMountLoadingState.externallyManaged;
  videoMountLoadingState.externallyManaged = false;
  if (shouldHide) {
    hideGlobalLoadingOverlay();
  }
};

const buildTimelineRows = () => {
  const markerDuration = keyframeMarkerDuration.value;
  return videoStore.masks.flatMap((mask) => {
    const userKeyframes = sortMaskKeyframes(mask.keyframes).filter(
      (keyframe) => keyframe.type === MASK_KEYFRAME_TYPES.USER
    );

    const rangeRow = {
      id: `range-row-${mask.id}`,
      rowHeight: 44,
      classNames: ["timeline-row-range"],
      selected: mask.id === videoStore.selectedMaskId,
      actions: [
        {
          id: `range-${mask.id}`,
          start: mask.startTime,
          end: mask.endTime,
          effectId: "effect-mask-range",
          movable: true,
          flexible: true,
          minStart: 0,
          maxEnd: Math.max(videoStore.videoDuration || 0, 0),
          selected: mask.id === videoStore.selectedMaskId,
          data: {
            kind: "mask-range",
            maskId: mask.id,
            label: mask.name,
            color: mask.displayColor,
          },
        },
      ],
    };

    if (userKeyframes.length === 0) {
      return [rangeRow];
    }

    const keyframeRow = {
      id: `keyframe-row-${mask.id}`,
      rowHeight: 20,
      classNames: ["timeline-row-keyframes"],
      actions: userKeyframes.map((keyframe) => ({
        id: `keyframe-${mask.id}-${keyframe.id}`,
        start: keyframe.time,
        end: keyframe.time + markerDuration,
        effectId: "effect-mask-keyframe",
        movable: false,
        flexible: false,
        selected: keyframe.id === videoStore.selectedKeyframeId,
        data: {
          kind: "mask-keyframe",
          maskId: mask.id,
          keyframeId: keyframe.id,
          label: formatSeconds(keyframe.time),
          color: "transparent",
        },
      })),
    };

    return [
      rangeRow,
      keyframeRow,
    ];
  });
};

const syncTimelineRowsFromStore = () => {
  syncingTimelineFromStore = true;
  timelineRows.value = buildTimelineRows();
  nextTick(() => {
    syncingTimelineFromStore = false;
  });
};

watch(
  () => [videoStore.masks, videoStore.videoDuration, videoStore.selectedMaskId, videoStore.selectedKeyframeId],
  () => syncTimelineRowsFromStore(),
  { deep: true, immediate: true }
);

watch(
  () => videoStore.videoFile,
  async (file) => {
    const shouldPreserveLastOutputPath = preserveLastOutputPathOnNextVideoChange;
    preserveLastOutputPathOnNextVideoChange = false;
    processingSucceeded.value = false;
    if (!shouldPreserveLastOutputPath) {
      lastOutputPath.value = "";
    }

    if (!file) {
      timelineRows.value = [];
      sourceFps.value = 30;
      timelineZoomPercent.value = 0;
      timelineScrollLeft.value = 0;
      timelineViewportWidth.value = 0;
      videoStore.setSourceFrameRate(30);
      if (!videoMountLoadingState.externallyManaged) {
        hideGlobalLoadingOverlay();
      }
      return;
    }

    const mountToken = videoMountLoadingState.externallyManaged
      ? videoMountLoadingState.token
      : beginVideoMountLoading({
          message: "正在读取视频信息",
          progress: VIDEO_MOUNT_LOADING_PROGRESS.PREPARE,
        });

    try {
      sourceFps.value = await estimateFpsFromVideo(file);
      if (!isActiveVideoMountLoading(mountToken)) return;

      videoStore.setSourceFrameRate(sourceFps.value);
      timelineZoomPercent.value = 0;
      timelineScrollLeft.value = 0;

      updateVideoMountLoading(
        mountToken,
        "正在挂载视频预览",
        VIDEO_MOUNT_LOADING_PROGRESS.PREVIEW
      );
      await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
      if (!isActiveVideoMountLoading(mountToken)) return;

      updateVideoMountLoading(
        mountToken,
        "正在初始化时间轴",
        VIDEO_MOUNT_LOADING_PROGRESS.TIMELINE
      );
      await nextTick();
      updateLayoutMetrics();
      syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
      updateVideoMountLoading(
        mountToken,
        "正在完成页面准备",
        VIDEO_MOUNT_LOADING_PROGRESS.FINALIZE
      );
    } catch (error) {
      if (isActiveVideoMountLoading(mountToken)) {
        console.warn("Failed to prepare video page:", error);
        $q.notify({
          type: "warning",
          message: `视频加载可能未完成：${error.message}`,
          position: "top",
          timeout: 3000,
        });
      }
    } finally {
      if (isActiveVideoMountLoading(mountToken) && !videoMountLoadingState.externallyManaged) {
        finishVideoMountLoading(mountToken);
      }
    }
  }
);

watch(
  () => (videoStore.selectedKeyframe ? `${videoStore.selectedKeyframe.id}:${videoStore.selectedKeyframe.time}` : ""),
  (signature) => {
    if (!signature || !videoStore.selectedKeyframe) return;
    const keyframeTime = Number(videoStore.selectedKeyframe.time || 0);
    if (Math.abs(videoStore.currentTime - keyframeTime) <= 0.0005) return;
    canvasPlayerRef.value?.seekTo(keyframeTime);
  }
);

watch(
  () => videoStore.currentTime,
  (newTime) => {
    if (!isDragging.value) {
      currentProgress.value = newTime;
    }
    syncTimelineViewport({ ensureVisible: true });
  }
);

watch(
  () => [timelineZoomPercent.value, timelineViewportWidth.value, timelineScale.value],
  async () => {
    if (!videoStore.hasVideoFile) return;
    await nextTick();
    syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
  }
);

const handlePlayPause = () => canvasPlayerRef.value?.togglePlayPause();
const handleStop = () => canvasPlayerRef.value?.stop();
const handlePreviousFrame = () => canvasPlayerRef.value?.previousFrame();
const handleNextFrame = () => canvasPlayerRef.value?.nextFrame();

const handleToggleMute = () => {
  videoStore.setIsMuted(!videoStore.isMuted);
};

const handlePlaybackRateChange = (rate) => {
  videoStore.setPlaybackRate(rate);
  if (videoStore.isPlaying && canvasPlayerRef.value) {
    canvasPlayerRef.value.play();
  }
};

const handleProgressDrag = (details) => {
  if (details.isFirst) {
    isDragging.value = true;
    if (videoStore.isPlaying) {
      canvasPlayerRef.value?.pause();
    }
  } else if (details.isFinal) {
    isDragging.value = false;
  }
};

const handleProgressChange = (value) => {
  if (!videoStore.hasVideoFile) return;
  canvasPlayerRef.value?.seekTo(value);
};

const handleTimelineTimeUpdate = (time) => {
  if (!videoStore.hasVideoFile || isDragging.value || isProcessing.value) return;
  if (Math.abs(time - videoStore.currentTime) < 0.02) return;
  currentProgress.value = time;
  canvasPlayerRef.value?.seekTo(time);
};

const handleTimelineScroll = ({ scrollLeft }) => {
  timelineScrollLeft.value = scrollLeft;
};

const handleTimelineActionClick = (_event, params) => {
  if (isProcessing.value) return;
  const action = params?.action;
  if (!action?.data) return;

  if (action.data.kind === "mask-range") {
    videoStore.selectMask(action.data.maskId, null);
    return;
  }

  if (action.data.kind === "mask-keyframe") {
    videoStore.selectKeyframe(action.data.maskId, action.data.keyframeId);
  }
};

const handleTimelineModelChange = (rows) => {
  if (syncingTimelineFromStore || isProcessing.value) return;
  timelineRows.value = rows;
};

const confirmOverflowKeyframeDeletion = (overflowKeyframes = []) =>
  new Promise((resolve) => {
    const timeList = overflowKeyframes.map((item) => formatSeconds(item.time)).join("、");
    $q.dialog({
      title: "删除越界关键帧？",
      message:
        overflowKeyframes.length > 0
          ? `调整后的蒙版区间会删除 ${overflowKeyframes.length} 个越界关键帧：${timeList}`
          : "调整后的蒙版区间会删除越界关键帧。",
      ok: {
        label: "删除",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "取消",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });

const commitTimelineRangeResize = async (action) => {
  const maskId = action?.data?.maskId;
  if (!maskId) {
    syncTimelineRowsFromStore();
    return;
  }

  const result = videoStore.resizeMaskRange(
    maskId,
    {
      startTime: action.start,
      endTime: action.end,
    },
    {
      deleteOverflow: false,
    }
  );

  if (!result.ok && result.code === "overflow-user-keyframes") {
    const confirmed = await confirmOverflowKeyframeDeletion(result.overflowKeyframes);
    if (!confirmed) {
      syncTimelineRowsFromStore();
      return;
    }

    videoStore.resizeMaskRange(
      maskId,
      {
        startTime: result.startTime,
        endTime: result.endTime,
      },
      {
        deleteOverflow: true,
      }
    );
    syncTimelineRowsFromStore();
    return;
  }

  if (!result.ok) {
    $q.notify({
      type: "warning",
      message: result.error || "蒙版区间调整失败。",
      timeout: 2500,
    });
  }

  syncTimelineRowsFromStore();
};

const handleTimelineActionMoveEnd = (params) => {
  if (isProcessing.value) {
    syncTimelineRowsFromStore();
    return;
  }

  const action = params?.action;
  if (action?.data?.kind !== "mask-range") {
    syncTimelineRowsFromStore();
    return;
  }

  const mask = videoStore.getMaskById(action.data.maskId);
  if (!mask) {
    syncTimelineRowsFromStore();
    return;
  }

  const delta = Number(action.start || 0) - Number(mask.startTime || 0);
  const result = videoStore.moveMaskRange(mask.id, delta);
  if (!result.ok) {
    $q.notify({
      type: "warning",
      message: result.error || "蒙版区间移动失败。",
      timeout: 2500,
    });
  }
  syncTimelineRowsFromStore();
};

const handleTimelineActionResizeEnd = async (params) => {
  if (isProcessing.value) {
    syncTimelineRowsFromStore();
    return;
  }

  const action = params?.action;
  if (action?.data?.kind !== "mask-range") {
    syncTimelineRowsFromStore();
    return;
  }

  await commitTimelineRangeResize(action);
};

const replaceCurrentVideoSource = async () => {
  if (!canReplaceCurrentSource.value || !videoStore.videoFile) return;

  const mountToken = beginVideoMountLoading({
    message: "正在加载导出视频文件",
    progress: 0.2,
    external: true,
  });

  try {
    const historyLimit = getConfiguredVideoHistoryLimit();
    if (videoStore.videoHistory.length >= historyLimit) {
      const confirmed = await confirmHistoryTrim();
      if (!confirmed) return;
    }

    const nextFile = await loadVideoFileFromPath(lastOutputPath.value);
    const currentEntry = videoStore.buildHistoryEntry({
      uiState: captureVideoUiState(),
    });
    videoStore.pushHistoryEntry(currentEntry, historyLimit);

    preserveLastOutputPathOnNextVideoChange = true;
    updateVideoMountLoading(mountToken, "正在切换当前视频源", 0.44);
    await videoStore.setVideoFile(nextFile, {
      resetEditor: true,
      resetHistory: false,
      isReplacementSource: true,
      sourcePath: lastOutputPath.value,
      sourceName: nextFile.name || videoStore.currentSourceName || "",
    });

    exportFpsMode.value = "source";
    timelineZoomPercent.value = 0;
    timelineScrollLeft.value = 0;
    processingSucceeded.value = false;
    processingMessage.value = "";

    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
    updateVideoMountLoading(mountToken, "正在恢复预览位置", VIDEO_MOUNT_LOADING_PROGRESS.FINALIZE);
    await canvasPlayerRef.value?.seekTo(0);
    syncTimelineRowsFromStore();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `替换视频失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  } finally {
    finishVideoMountLoading(mountToken, { forceHide: true });
  }
};

const restoreVideoHistory = async (entryId) => {
  const mountToken = beginVideoMountLoading({
    message: "正在恢复历史视频",
    progress: 0.18,
    external: true,
  });

  try {
    const targetEntry = videoStore.videoHistory.find((item) => item.id === entryId);
    if (!targetEntry) return;

    if (targetEntry.filePath) {
      const exists = await ensureFileExists(targetEntry.filePath);
      if (!exists) {
        $q.notify({
          type: "warning",
          message: "视频文件已不存在",
          position: "top",
          timeout: 2500,
        });
        return;
      }
    }

    const nextFile =
      targetEntry.videoFile ||
      (targetEntry.filePath ? await loadVideoFileFromPath(targetEntry.filePath) : null);
    if (!nextFile) {
      $q.notify({
        type: "warning",
        message: "无法恢复该历史记录对应的视频文件",
        position: "top",
        timeout: 2500,
      });
      return;
    }

    await videoStore.setVideoFile(nextFile, {
      resetEditor: true,
      resetHistory: false,
      isReplacementSource: Boolean(targetEntry.isReplacement),
      sourcePath: targetEntry.filePath || nextFile.path || "",
      sourceName: targetEntry.fileName || nextFile.name || "",
    });

    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);

    const restored = videoStore.restoreEditorSnapshot(targetEntry.snapshot, {
      preserveVideoInfo: true,
    });
    processingSucceeded.value = false;
    lastOutputPath.value = "";
    processingMessage.value = "";

    updateVideoMountLoading(mountToken, "正在恢复历史编辑状态", 0.95);
    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
    await restoreVideoUiState(restored.uiState);
    const seekSucceeded = await canvasPlayerRef.value?.seekTo(
      Number(targetEntry.snapshot?.currentTime || 0)
    );
    if (seekSucceeded === false) {
      throw new Error("播放器未能恢复到历史记录时间点");
    }
    videoStore.removeHistoryFrom(entryId);
    syncTimelineRowsFromStore();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `恢复历史记录失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  } finally {
    finishVideoMountLoading(mountToken, { forceHide: true });
  }
};

const adjustPlayerSize = () => {
  if (!playerContainer.value) return;
  const target =
    playerContainer.value?.$el instanceof HTMLElement
      ? playerContainer.value.$el
      : playerContainer.value;
  if (!(target instanceof HTMLElement)) return;

  const rect = target.getBoundingClientRect();
  const availableWidth = Math.max(0, rect.width - 20);
  const availableHeight = Math.max(0, rect.height - 20);
  videoStore.adjustPlayerSize(availableWidth, availableHeight);
};

const INPUT_FRAME_QUALITY = 0.92;
const RESULT_FRAME_FORMAT = "jpg";
let mp4ExportSupportChecked = false;

const normalizeImageFormat = (format, fallback = "jpg") => {
  const normalized = String(format || fallback).toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(normalized)) {
    return normalized === "jpeg" ? "jpg" : normalized;
  }
  return fallback;
};

const getMimeTypeForFormat = (format) => {
  switch (normalizeImageFormat(format)) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
};

const joinRendererPath = (...parts) => {
  const normalizedParts = parts.filter((part) => typeof part === "string" && part.length > 0);
  if (normalizedParts.length === 0) return "";
  if (window.electron?.ipcRenderer?.joinPath) {
    return window.electron.ipcRenderer.joinPath(...normalizedParts);
  }
  return normalizedParts.join("/").replace(/\/+/g, "/");
};

const getOutputDirectory = (sourcePath) => {
  const downloadPath = configStore.config.fileManagement?.downloadPath || "";
  const videoFolderName = configStore.config.fileManagement?.videoFolderName || "videos";
  if (downloadPath) {
    return joinRendererPath(downloadPath, videoFolderName);
  }
  return sourcePath.replace(/[\\/][^\\/]+$/, "");
};

const buildOutputVideoPath = async (sourceFile, sourcePath) => {
  const outputDir = getOutputDirectory(sourcePath);
  await window.electron.ipcRenderer.invoke("ensure-directory", outputDir);

  const outputName = `${sourceFile.name.replace(/\.[^/.]+$/, "")}_processed_${Date.now()}.mp4`;
  return window.electron.ipcRenderer.joinPath(outputDir, outputName);
};

const withBackendProgressHint = (message = "") =>
  backendRunningState?.value ? `${message}\n可打开后端管理页面查看进度` : message;

const updateGlobalLoadingOverlay = (message, progress = null) => {
  if (loadingControl?.update) {
    loadingControl.update({
      message,
      progress: typeof progress === "number" ? progress : null,
    });
  } else if (loadingControl?.show) {
    loadingControl.show({
      message,
      progress: typeof progress === "number" ? progress : null,
    });
  }
};

const hideGlobalLoadingOverlay = () => {
  loadingControl?.hide?.();
};

const applyProcessingUi = (message, progress = processingProgress.value) => {
  const resolvedMessage = withBackendProgressHint(message);
  processingMessage.value = resolvedMessage;
  processingProgress.value = Math.max(0, Math.min(1, Number(progress || 0)));
  updateGlobalLoadingOverlay(resolvedMessage, processingProgress.value);
};

const clearProcessingEtaTicker = () => {
  if (processingEtaTickerId === null) return;
  window.clearInterval(processingEtaTickerId);
  processingEtaTickerId = null;
};

const clearProgressAwareEtaState = () => {
  processingEtaState.progressAwareCapSeconds = null;
  processingEtaState.progressAwareFloorSeconds = null;
  processingEtaState.progressAwareStageBaseSeconds = null;
};

const clearProcessingBatchMessageContext = () => {
  processingBatchMessageContext = null;
  processingEtaState.estimateBaseSeconds = null;
  processingEtaState.estimateFloorSeconds = 0;
  processingEtaState.estimateStartedAtMs = 0;
  processingEtaState.frozenSeconds = null;
  clearProgressAwareEtaState();
  clearProcessingEtaTicker();
};

const resetProcessingEtaState = () => {
  clearProcessingBatchMessageContext();
  processingEtaState.firstResponseSeconds = null;
  processingEtaState.sessionStartedAtMs = 0;
};

const formatEta = (seconds) => {
  const safeSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
};

const getAverageBatchSeconds = (
  batchDurations = [],
  fallbackSeconds = processingEtaState.firstResponseSeconds
) => {
  if (batchDurations.length > 0) {
    const recentSamples = batchDurations.slice(-6);
    const totalWeight = recentSamples.reduce((sum, _value, index) => sum + index + 1, 0);
    const weightedSum = recentSamples.reduce(
      (sum, value, index) => sum + Number(value || 0) * (index + 1),
      0
    );
    return totalWeight > 0 ? weightedSum / totalWeight : Number(fallbackSeconds || 0);
  }
  return Number(fallbackSeconds || 0);
};

const getProgressBasedEtaSeconds = (progress = processingProgress.value) => {
  if (!(processingEtaState.sessionStartedAtMs > 0)) return null;

  const clampedProgress = Math.max(0, Math.min(0.97, Number(progress || 0)));
  if (!(clampedProgress >= 0.05)) return null;

  const elapsedSeconds = Math.max(
    0,
    (performance.now() - processingEtaState.sessionStartedAtMs) / 1000
  );
  if (!(elapsedSeconds > 1)) return null;

  return Math.max(0, elapsedSeconds * ((1 - clampedProgress) / clampedProgress));
};

const blendProcessingEtaSeconds = ({
  batchModelSeconds,
  progressModelSeconds = null,
  progress = processingProgress.value,
  completedBatchCount = 0,
}) => {
  if (!(progressModelSeconds > 0)) {
    return batchModelSeconds;
  }

  const progressWeight = Math.min(
    0.7,
    Math.max(0, completedBatchCount - 1) * 0.12 + Math.max(0, Number(progress || 0) - 0.12) * 0.45
  );
  if (!(progressWeight > 0)) {
    return batchModelSeconds;
  }

  return batchModelSeconds * (1 - progressWeight) + progressModelSeconds * progressWeight;
};

const getRemainingBatchCount = ({
  batchNumber,
  totalBatches,
  remainingBatchCount = null,
}) => {
  if (
    remainingBatchCount !== null &&
    remainingBatchCount !== undefined &&
    Number.isFinite(Number(remainingBatchCount))
  ) {
    return Math.max(0, Number(remainingBatchCount));
  }
  return Math.max(0, totalBatches - batchNumber + 1);
};

const resolveProcessingEtaSnapshot = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  progress = processingProgress.value,
}) => {
  const averageProcessingBatchSeconds = getAverageBatchSeconds(batchDurations);
  const averagePipelineBatchSeconds = getAverageBatchSeconds(
    pipelineBatchDurations,
    averageProcessingBatchSeconds
  );
  if (
    !(averageProcessingBatchSeconds > 0) ||
    !(averagePipelineBatchSeconds > 0) ||
    !(processingEtaState.firstResponseSeconds > 0)
  ) {
    return null;
  }

  const nextRemainingBatchCount = getRemainingBatchCount({
    batchNumber,
    totalBatches,
    remainingBatchCount,
  });
  const futureBatchCount = Math.max(0, nextRemainingBatchCount - 1);
  const futureBatchSeconds =
    averagePipelineBatchSeconds * futureBatchCount +
    PROCESSING_FINAL_STAGE_PLACEHOLDER_SECONDS;
  const batchModelSeconds =
    Math.max(averageProcessingBatchSeconds, processingEtaState.firstResponseSeconds) +
    futureBatchSeconds;
  const progressModelSeconds = getProgressBasedEtaSeconds(progress);
  const baseSeconds = Math.max(
    futureBatchSeconds,
    blendProcessingEtaSeconds({
      batchModelSeconds,
      progressModelSeconds,
      progress,
      completedBatchCount: pipelineBatchDurations.length,
    })
  );
  const floorSeconds =
    nextRemainingBatchCount <= 1
      ? 1
      : Math.max(futureBatchSeconds, baseSeconds - processingEtaState.firstResponseSeconds);

  return {
    averageProcessingBatchSeconds,
    averagePipelineBatchSeconds,
    nextRemainingBatchCount,
    futureBatchCount,
    futureBatchSeconds,
    baseSeconds,
    floorSeconds,
  };
};

const primeProcessingEta = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  progress = processingProgress.value,
}) => {
  const snapshot = resolveProcessingEtaSnapshot({
    batchNumber,
    totalBatches,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount,
    progress,
  });
  if (!snapshot) {
    processingEtaState.estimateBaseSeconds = null;
    processingEtaState.estimateFloorSeconds = 0;
    processingEtaState.estimateStartedAtMs = 0;
    clearProgressAwareEtaState();
    return null;
  }

  processingEtaState.estimateBaseSeconds = snapshot.baseSeconds;
  processingEtaState.estimateFloorSeconds = snapshot.floorSeconds;
  processingEtaState.estimateStartedAtMs = performance.now();
  clearProgressAwareEtaState();
  return snapshot.baseSeconds;
};

const freezeProcessingEtaAtCurrentValue = () => {
  const etaSeconds = getCurrentProcessingEtaSeconds();
  processingEtaState.frozenSeconds =
    etaSeconds === null ? null : Math.max(0, Number(etaSeconds || 0));
  clearProcessingEtaTicker();
  return processingEtaState.frozenSeconds;
};

const primeProgressAwareEta = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  overallProgress = processingProgress.value,
  stageProgress = 0,
  initialEtaSeconds = null,
  resetStageBase = false,
}) => {
  const snapshot = resolveProcessingEtaSnapshot({
    batchNumber,
    totalBatches,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount,
    progress: overallProgress,
  });
  if (!snapshot) {
    processingEtaState.estimateBaseSeconds = null;
    processingEtaState.estimateFloorSeconds = 0;
    processingEtaState.estimateStartedAtMs = 0;
    clearProgressAwareEtaState();
    return null;
  }

  const shouldResetStageBase =
    resetStageBase || !(processingEtaState.progressAwareStageBaseSeconds > 0);
  const fallbackBaseSeconds =
    initialEtaSeconds ?? processingEtaState.estimateBaseSeconds ?? snapshot.baseSeconds;
  const nextStageBaseSeconds = shouldResetStageBase
    ? Math.max(snapshot.futureBatchSeconds, fallbackBaseSeconds)
    : Math.max(processingEtaState.progressAwareStageBaseSeconds, snapshot.futureBatchSeconds);
  const clampedProgress = Math.max(0, Math.min(1, Number(stageProgress || 0)));

  if (shouldResetStageBase) {
    processingEtaState.progressAwareStageBaseSeconds = nextStageBaseSeconds;
    processingEtaState.estimateBaseSeconds = nextStageBaseSeconds;
    processingEtaState.estimateFloorSeconds = snapshot.futureBatchSeconds;
    processingEtaState.estimateStartedAtMs = performance.now();
  }

  const stageBaseSeconds = Math.max(
    processingEtaState.progressAwareStageBaseSeconds,
    snapshot.futureBatchSeconds
  );
  const stageBudgetSeconds = Math.max(0.25, stageBaseSeconds - snapshot.futureBatchSeconds);
  processingEtaState.progressAwareFloorSeconds = snapshot.futureBatchSeconds;
  processingEtaState.progressAwareCapSeconds = Math.max(
    snapshot.futureBatchSeconds,
    snapshot.futureBatchSeconds + stageBudgetSeconds * (1 - clampedProgress)
  );
  return processingEtaState.progressAwareCapSeconds;
};

const getCurrentProcessingEtaSeconds = () => {
  if (
    typeof processingEtaState.frozenSeconds === "number" &&
    Number.isFinite(processingEtaState.frozenSeconds)
  ) {
    return Math.max(0, processingEtaState.frozenSeconds);
  }
  const hasEstimateBase = processingEtaState.estimateBaseSeconds > 0;
  const elapsedBasedEtaSeconds = hasEstimateBase
    ? Math.max(
        processingEtaState.estimateFloorSeconds,
        processingEtaState.estimateBaseSeconds -
          Math.max(0, (performance.now() - processingEtaState.estimateStartedAtMs) / 1000)
      )
    : null;

  if (
    typeof processingEtaState.progressAwareCapSeconds === "number" &&
    Number.isFinite(processingEtaState.progressAwareCapSeconds)
  ) {
    if (elapsedBasedEtaSeconds === null) {
      return Math.max(0, processingEtaState.progressAwareCapSeconds);
    }

    return Math.max(
      processingEtaState.progressAwareFloorSeconds ?? processingEtaState.estimateFloorSeconds,
      Math.min(elapsedBasedEtaSeconds, processingEtaState.progressAwareCapSeconds)
    );
  }

  return elapsedBasedEtaSeconds;
};

const buildBatchMessage = ({
  batchNumber,
  totalBatches,
  stageLabel,
}) => {
  const baseMessage = `正在处理第 ${batchNumber}/${totalBatches} 批：${stageLabel}`;
  const etaSeconds = getCurrentProcessingEtaSeconds();
  if (etaSeconds === null) return baseMessage;
  return `${baseMessage}，预计剩余 ${formatEta(etaSeconds)}`;
};

const refreshProcessingBatchMessage = () => {
  if (!processingBatchMessageContext) return;
  applyProcessingUi(
    buildBatchMessage(processingBatchMessageContext),
    processingProgress.value
  );
};

const ensureProcessingEtaTicker = () => {
  if (processingEtaTickerId !== null) return;
  processingEtaTickerId = window.setInterval(() => {
    refreshProcessingBatchMessage();
  }, PROCESSING_ETA_TICK_MS);
};

const updateBatchProcessingUi = ({
  batchNumber,
  totalBatches,
  stageLabel,
  batchDurations = [],
  pipelineBatchDurations = [],
  progress = processingProgress.value,
  remainingBatchCount = null,
  etaMode = PROCESSING_ETA_MODES.DYNAMIC,
  etaProgress = null,
}) => {
  const previousBatchMessageContext = processingBatchMessageContext;
  const previousEtaSeconds = getCurrentProcessingEtaSeconds();
  const shouldFreezeEta = etaMode === PROCESSING_ETA_MODES.FREEZE;
  const normalizedEtaProgress = Number.isFinite(Number(etaProgress))
    ? Math.max(0, Math.min(1, Number(etaProgress)))
    : null;
  const shouldUseProgressAwareEta =
    !shouldFreezeEta && normalizedEtaProgress !== null;
  const isSameFrozenStage =
    shouldFreezeEta &&
    previousBatchMessageContext?.etaMode === PROCESSING_ETA_MODES.FREEZE &&
    previousBatchMessageContext?.batchNumber === batchNumber &&
    previousBatchMessageContext?.stageLabel === stageLabel;
  const shouldPrimeDynamicEta =
    !shouldFreezeEta &&
    (
      previousBatchMessageContext?.etaMode !== PROCESSING_ETA_MODES.DYNAMIC ||
      previousBatchMessageContext?.batchNumber !== batchNumber ||
      previousBatchMessageContext?.totalBatches !== totalBatches ||
      previousBatchMessageContext?.stageLabel !== stageLabel ||
      previousBatchMessageContext?.remainingBatchCount !== remainingBatchCount ||
      processingEtaState.estimateBaseSeconds === null
    );

  processingBatchMessageContext = {
    batchNumber,
    totalBatches,
    stageLabel,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount,
    etaMode,
    progress,
    etaProgress: normalizedEtaProgress,
  };

  if (shouldFreezeEta) {
    if (!isSameFrozenStage) {
      freezeProcessingEtaAtCurrentValue();
    } else {
      clearProcessingEtaTicker();
    }
    clearProgressAwareEtaState();
  } else {
    processingEtaState.frozenSeconds = null;
    if (shouldUseProgressAwareEta) {
      primeProgressAwareEta({
        batchNumber,
        totalBatches,
        batchDurations,
        pipelineBatchDurations,
        remainingBatchCount,
        overallProgress: progress,
        stageProgress: normalizedEtaProgress,
        initialEtaSeconds: previousEtaSeconds,
        resetStageBase: shouldPrimeDynamicEta,
      });
    } else {
      clearProgressAwareEtaState();
    }

    if (shouldPrimeDynamicEta && !shouldUseProgressAwareEta) {
      primeProcessingEta({
        batchNumber,
        totalBatches,
        batchDurations,
        pipelineBatchDurations,
        remainingBatchCount,
        progress,
      });
    }

    if (processingEtaState.estimateBaseSeconds !== null) {
      ensureProcessingEtaTicker();
    } else {
      clearProcessingEtaTicker();
    }
  }

  applyProcessingUi(buildBatchMessage(processingBatchMessageContext), progress);
};

const refreshProcessingEtaEstimate = () => {
  if (!processingBatchMessageContext) return;
  if (processingBatchMessageContext.etaMode === PROCESSING_ETA_MODES.FREEZE) {
    refreshProcessingBatchMessage();
    return;
  }

  primeProcessingEta(processingBatchMessageContext);
  if (processingEtaState.estimateBaseSeconds !== null) {
    ensureProcessingEtaTicker();
  }
  refreshProcessingBatchMessage();
};

const updateProcessingUi = (message, progress = processingProgress.value) => {
  clearProcessingBatchMessageContext();
  applyProcessingUi(message, progress);
};

const ensureMp4ExportSupported = async (width, height) => {
  if (mp4ExportSupportChecked) return;

  const supported = await Combinator.isSupported({
    width,
    height,
    bitrate: 5_000_000,
    videoCodec: "avc1.42E032",
  });
  if (!supported) {
    throw new Error("当前环境不支持 WebAV MP4 导出");
  }
  mp4ExportSupportChecked = true;
};

const removeTemporaryFiles = async (filePaths = []) => {
  await Promise.allSettled(
    filePaths
      .filter(Boolean)
      .map((filePath) => window.electron.ipcRenderer.invoke("cleanup-temp-file", filePath))
  );
};

const openPathAsStream = async (filePath) => {
  const bytes = await readFileBytes(filePath);
  return new Blob([bytes], {
    type: getMimeTypeForPath(filePath),
  }).stream();
};

const saveStreamToPath = async (stream, outputPath) => {
  const bytes = await readReadableStream(stream);
  return window.electron.ipcRenderer.invoke("save-file", {
    filePath: outputPath,
    blob: bytes.buffer,
  });
};

const exportProcessedBatchSegment = async ({
  framePaths,
  outputPath,
  width,
  height,
  fps,
  progressBase,
  progressWeight,
  batchNumber,
  totalBatches,
  batchDurations,
  pipelineBatchDurations,
}) => {
  await ensureMp4ExportSupported(width, height);

  const frameClip = new ProcessedFramesClip({ framePaths, width, height, fps });
  const mainSprite = new OffscreenSprite(frameClip);
  const combinator = new Combinator({
    width,
    height,
    fps,
    bitrate: 5_000_000,
    videoCodec: "avc1.42E032",
    audio: false,
  });

  let unbindProgress = null;
  try {
    await combinator.addSprite(mainSprite, { main: true });
    updateBatchProcessingUi({
      batchNumber,
      totalBatches,
      stageLabel: "正在编码临时视频分段",
      batchDurations,
      pipelineBatchDurations,
      progress: progressBase,
      etaProgress: 0,
    });
    unbindProgress = combinator.on("OutputProgress", (progress) => {
      const normalized = Math.max(0, Math.min(1, progress));
      updateBatchProcessingUi({
        batchNumber,
        totalBatches,
        stageLabel: "正在编码临时视频分段",
        batchDurations,
        pipelineBatchDurations,
        progress: progressBase + progressWeight * normalized,
        etaProgress: normalized,
      });
    });

    const stream = combinator.output();
    return await saveStreamToPath(stream, outputPath);
  } finally {
    if (typeof unbindProgress === "function") unbindProgress();
    combinator.destroy();
    frameClip.destroy();
  }
};

const detectSourceHasAudio = async (sourceFile) => {
  let sourceClip = null;
  let splitTracks = [];

  try {
    sourceClip = new MP4Clip(sourceFile.stream());
    await sourceClip.ready;
    try {
      splitTracks = await sourceClip.splitTrack();
      return splitTracks.some(
        (track) =>
          Number(track.meta?.audioSampleRate || 0) > 0 &&
          Number(track.meta?.audioChanCount || 0) > 0
      );
    } catch {
      return (
        Number(sourceClip.meta?.audioSampleRate || 0) > 0 &&
        Number(sourceClip.meta?.audioChanCount || 0) > 0
      );
    }
  } finally {
    splitTracks.forEach((track) => track?.destroy?.());
    sourceClip?.destroy?.();
  }
};

const finalizeProcessedVideo = async ({ segmentPaths, sourceFile, sourcePath, width, height }) => {
  await ensureMp4ExportSupported(width, height);
  const outputPath = await buildOutputVideoPath(sourceFile, sourcePath);

  updateProcessingUi("正在进行最后的拼接与封装", 0.9);

  if (segmentPaths.length === 0) {
    throw new Error("没有可用于封装的视频分段");
  }

  const segmentStreams = await Promise.all(
    segmentPaths.map((segmentPath) => openPathAsStream(segmentPath))
  );
  let finalStream =
    segmentStreams.length === 1 ? segmentStreams[0] : await fastConcatMP4(segmentStreams);

  const hasAudio = await detectSourceHasAudio(sourceFile);
  if (hasAudio) {
    updateProcessingUi("正在进行最后的拼接与封装", 0.95);
    finalStream = mixinMP4AndAudio(finalStream, {
      stream: sourceFile.stream(),
      volume: 1,
      loop: false,
    });
  }

  return await saveStreamToPath(finalStream, outputPath);
};

const buildBatchDescriptor = ({ start, batchSize, totalFrames, totalBatches }) => {
  const batchNumber = Math.floor(start / batchSize) + 1;
  const end = Math.min(totalFrames, start + batchSize);
  const batchFrameCount = end - start;
  const batchProgressBase = ((batchNumber - 1) / totalBatches) * 0.85;
  const batchProgressSpan = (1 / totalBatches) * 0.85;

  return {
    start,
    end,
    batchNumber,
    batchFrameCount,
    batchProgressBase,
    batchProgressSpan,
  };
};

const prepareBatchArtifacts = async ({
  descriptor,
  paths,
  fps,
  frameFormat,
  extractor,
  maskRenderer,
  totalBatches,
  batchDurations,
  reportProgress = true,
}) => {
  const preparationStartedAt = performance.now();
  const {
    start,
    end,
    batchNumber,
    batchFrameCount,
    batchProgressBase,
    batchProgressSpan,
  } = descriptor;

  const batchItems = [];
  const batchArtifactPaths = [];
  const batchResultPaths = [];

  for (let frameIndex = start; frameIndex < end; frameIndex += 1) {
    if (reportProgress) {
      updateBatchProcessingUi({
        batchNumber,
        totalBatches,
        stageLabel: "正在生成帧与蒙版",
        batchDurations,
        progress:
          batchProgressBase +
          ((frameIndex - start) / Math.max(batchFrameCount, 1)) * batchProgressSpan * 0.3,
      });
    }

    const ts = Math.min(videoStore.videoDuration, frameIndex / fps);
    const frameName = `frame_${String(frameIndex).padStart(6, "0")}.${frameFormat}`;
    const maskName = `mask_${String(frameIndex).padStart(6, "0")}.png`;
    const resultName = `result_${String(frameIndex).padStart(6, "0")}.${RESULT_FRAME_FORMAT}`;

    const framePath = window.electron.ipcRenderer.joinPath(paths.framesDir, frameName);
    const maskPath = window.electron.ipcRenderer.joinPath(paths.masksDir, maskName);
    const outputPath = window.electron.ipcRenderer.joinPath(paths.resultsDir, resultName);

    const [frameBlob, maskBlob] = await Promise.all([
      extractor.capture(ts),
      maskRenderer.render(ts),
    ]);

    await Promise.all([
      saveBlobToPath(frameBlob, framePath),
      saveBlobToPath(maskBlob, maskPath),
    ]);

    batchItems.push({
      frame_index: frameIndex,
      image_path: framePath,
      mask_path: maskPath,
      output_path: outputPath,
    });
    batchArtifactPaths.push(framePath, maskPath, outputPath);
    batchResultPaths.push(outputPath);
  }

  return {
    ...descriptor,
    preparationSeconds: (performance.now() - preparationStartedAt) / 1000,
    batchItems,
    batchArtifactPaths,
    batchResultPaths,
  };
};

const createPreparedBatchTask = ({
  start,
  totalFrames,
  batchSize,
  totalBatches,
  paths,
  fps,
  frameFormat,
  extractor,
  maskRenderer,
  batchDurations,
  reportProgress,
}) => {
  if (start >= totalFrames) return null;

  const descriptor = buildBatchDescriptor({
    start,
    batchSize,
    totalFrames,
    totalBatches,
  });

  const preparationPromise = prepareBatchArtifacts({
    descriptor,
    paths,
    fps,
    frameFormat,
    extractor,
    maskRenderer,
    totalBatches,
    batchDurations,
    reportProgress,
  });

  return {
    descriptor,
    reportProgress,
    promise: preparationPromise.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    ),
  };
};

const runVideoProcessing = async () => {
  if (!canRun.value || isProcessing.value) return;

  isProcessing.value = true;
  processingSucceeded.value = false;
  processingProgress.value = 0;
  lastOutputPath.value = "";
  resetProcessingEtaState();
  processingEtaState.sessionStartedAtMs = performance.now();
  applyProcessingUi("准备处理任务", 0);

  const fps = exportFps.value;
  const totalFrames = Math.max(1, Math.ceil(videoStore.videoDuration * fps));
  const maxFrameCount = Math.max(1, Number(configStore.config.video?.maxFrameCount || 10000));
  const batchSize = computedBatchSize.value;
  const retryCount = Math.max(1, Number(configStore.config.video?.batchRetryCount || 3));
  const totalBatches = Math.max(1, Math.ceil(totalFrames / batchSize));
  const frameFormat = normalizeImageFormat(configStore.config.video?.frameExtractionFormat, "jpg");
  let paths = null;
  let tempSourcePath = null;
  let preparedBatchTask = null;
  let firstBatchRequestStartedAt = null;

  try {
    if (!window.electron) {
      throw new Error("视频处理仅支持 Electron 模式");
    }

    if (totalFrames > maxFrameCount) {
      throw new Error(
        `当前导出需要 ${totalFrames} 帧，已超过设置上限 ${maxFrameCount} 帧。请缩短视频、降低导出帧率，或在全局设置中提高上限。`
      );
    }

    paths = await prepareTaskPaths();
    tempSourcePath = videoStore.videoFile?.path ? null : paths.sourcePath;
    const extractor = await createFrameExtractor(videoStore.videoFile, frameFormat, fps);

    try {
      const maskRenderer = await createCombinedMaskRenderer({
        masks: videoStore.masks,
        width: videoStore.videoWidth,
        height: videoStore.videoHeight,
      });

      const segmentPaths = [];
      const batchDurations = [];
      const pipelineBatchDurations = [];
      let processedFrames = 0;
      preparedBatchTask = createPreparedBatchTask({
        start: 0,
        totalFrames,
        batchSize,
        totalBatches,
        paths,
        fps,
        frameFormat,
        extractor,
        maskRenderer,
        batchDurations,
        reportProgress: true,
      });

      while (preparedBatchTask) {
        const currentTask = preparedBatchTask;

        if (!currentTask.reportProgress) {
          updateBatchProcessingUi({
            batchNumber: currentTask.descriptor.batchNumber,
            totalBatches,
            stageLabel: "正在生成帧与蒙版",
            batchDurations,
            pipelineBatchDurations,
            progress: currentTask.descriptor.batchProgressBase,
          });
        }

        const currentBatchResult = await currentTask.promise;
        if (!currentBatchResult.ok) {
          throw currentBatchResult.error;
        }
        const currentBatch = currentBatchResult.value;
        const batchStartedAt = performance.now();

        preparedBatchTask = createPreparedBatchTask({
          start: currentBatch.end,
          totalFrames,
          batchSize,
          totalBatches,
          paths,
          fps,
          frameFormat,
          extractor,
          maskRenderer,
          batchDurations,
          reportProgress: false,
        });

        let success = false;
        let lastError = null;

        for (let attempt = 1; attempt <= retryCount; attempt += 1) {
          try {
            if (currentBatch.batchNumber === 1 && firstBatchRequestStartedAt === null) {
              firstBatchRequestStartedAt = performance.now();
            }

            updateBatchProcessingUi({
              batchNumber: currentBatch.batchNumber,
              totalBatches,
              stageLabel: "正在提交后端批次",
              batchDurations,
              pipelineBatchDurations,
              progress: currentBatch.batchProgressBase + currentBatch.batchProgressSpan * 0.45,
            });

            const { data } = await submitVideoBatchInpaint({
              frames: currentBatch.batchItems,
              options: {
                keep_mask_grayscale: false,
                stop_on_error: true,
                failure_root: paths.failureRoot,
                failure_retention: configStore.config.video?.failureRetentionCount || 3,
                batch_id: `batch_${currentBatch.start}_${currentBatch.end}`,
                inpaint: {
                  prompt: "",
                  negative_prompt: "",
                  sd_seed: -1,
                },
              },
            });

            if (
              currentBatch.batchNumber === 1 &&
              !(processingEtaState.firstResponseSeconds > 0) &&
              firstBatchRequestStartedAt !== null
            ) {
              processingEtaState.firstResponseSeconds =
                (performance.now() - firstBatchRequestStartedAt) / 1000;
              refreshProcessingEtaEstimate();
            }

            const failed = (data?.results || []).filter((item) => !item.success);
            if (failed.length > 0) {
              const firstError = failed[0]?.error || "未知错误";
              throw new Error(`批次中存在失败帧: ${firstError}`);
            }

            success = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!success) {
          throw new Error(
            `批次 ${currentBatch.start + 1}-${currentBatch.end} 连续 ${retryCount} 次失败，已停止处理。\n${lastError?.message || ""}`
          );
        }

        const segmentPath = window.electron.ipcRenderer.joinPath(
          paths.segmentsDir,
          `segment_${String(currentBatch.batchNumber).padStart(4, "0")}.mp4`
        );
        const savedSegmentPath = await exportProcessedBatchSegment({
          framePaths: currentBatch.batchResultPaths,
          outputPath: segmentPath,
          width: videoStore.videoWidth,
          height: videoStore.videoHeight,
          fps,
          progressBase: currentBatch.batchProgressBase + currentBatch.batchProgressSpan * 0.55,
          progressWeight: currentBatch.batchProgressSpan * 0.3,
          batchNumber: currentBatch.batchNumber,
          totalBatches,
          batchDurations,
          pipelineBatchDurations,
        });

        segmentPaths.push(savedSegmentPath || segmentPath);
        processedFrames += currentBatch.batchFrameCount;
        const currentBatchProcessingSeconds = (performance.now() - batchStartedAt) / 1000;
        batchDurations.push(currentBatchProcessingSeconds);
        pipelineBatchDurations.push(
          currentBatch.batchNumber === 1
            ? Number(currentBatch.preparationSeconds || 0) + currentBatchProcessingSeconds
            : Math.max(Number(currentBatch.preparationSeconds || 0), currentBatchProcessingSeconds)
        );

        await removeTemporaryFiles(currentBatch.batchArtifactPaths);
        updateBatchProcessingUi({
          batchNumber: currentBatch.batchNumber,
          totalBatches,
          stageLabel: "当前批次已完成",
          batchDurations,
          pipelineBatchDurations,
          progress: (processedFrames / totalFrames) * 0.85,
          remainingBatchCount: Math.max(0, totalBatches - currentBatch.batchNumber),
        });
      }

      const outputPath = await finalizeProcessedVideo({
        segmentPaths,
        sourceFile: videoStore.videoFile,
        sourcePath: paths.sourcePath,
        width: videoStore.videoWidth,
        height: videoStore.videoHeight,
      });

      lastOutputPath.value = outputPath;
      processingSucceeded.value = true;
      processingProgress.value = 1;
      updateProcessingUi("处理完成", 1);
      $q.notify({
        type: "positive",
        message: `视频处理完成，已导出: ${outputPath}`,
        position: "top",
        timeout: 4500,
      });
    } finally {
      if (preparedBatchTask?.promise) {
        await Promise.allSettled([preparedBatchTask.promise]);
      }
      await extractor.dispose();
    }
    } catch (error) {
    processingSucceeded.value = false;
    updateProcessingUi("处理失败", processingProgress.value);
    $q.notify({
      type: "negative",
      message: `视频处理失败: ${error.message}`,
      position: "top",
      timeout: 6000,
    });
  } finally {
    isProcessing.value = false;
    resetProcessingEtaState();
    loadingControl?.hide?.();
    const cleanupTasks = [];
    if (paths?.taskRoot && window.electron) {
      cleanupTasks.push(
        window.electron.ipcRenderer.invoke("remove-directory-recursive", paths.taskRoot)
      );
    }
    if (tempSourcePath && window.electron) {
      cleanupTasks.push(window.electron.ipcRenderer.invoke("cleanup-temp-file", tempSourcePath));
    }
    if (cleanupTasks.length > 0) {
      await Promise.allSettled(cleanupTasks);
    }
  }
};

const prepareTaskPaths = async () => {
  const file = videoStore.videoFile;
  const sourcePath = await resolveVideoSourcePath(file);

  const tempBase =
    configStore.config.fileManagement?.tempPath || sourcePath.replace(/[\\/][^\\/]+$/, "");

  const taskRoot = window.electron.ipcRenderer.joinPath(
    tempBase,
    `moonshine_video_task_${Date.now()}`
  );

  const framesDir = window.electron.ipcRenderer.joinPath(taskRoot, "frames");
  const masksDir = window.electron.ipcRenderer.joinPath(taskRoot, "masks");
  const resultsDir = window.electron.ipcRenderer.joinPath(taskRoot, "results");
  const segmentsDir = window.electron.ipcRenderer.joinPath(taskRoot, "segments");
  const failureRoot = window.electron.ipcRenderer.joinPath(taskRoot, "failed_batches");

  await window.electron.ipcRenderer.invoke("ensure-directory", taskRoot);
  await window.electron.ipcRenderer.invoke("ensure-directory", framesDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", masksDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", resultsDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", segmentsDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", failureRoot);

  return {
    sourcePath,
    taskRoot,
    framesDir,
    masksDir,
    resultsDir,
    segmentsDir,
    failureRoot,
  };
};

const resolveVideoSourcePath = async (file) => {
  if (file?.path) return file.path;
  if (!window.electron) throw new Error("无法解析视频文件路径");

  const buffer = await file.arrayBuffer();
  return window.electron.ipcRenderer.invoke("save-temp-video", {
    fileName: file.name,
    buffer: new Uint8Array(buffer),
  });
};

const createFrameExtractor = async (file, format, fps) => {
  const createClipInstance = async () => {
    const nextClip = new MP4Clip(file.stream(), {
      __unsafe_hardwareAcceleration__: "no-preference",
      audio: false,
    });
    await nextClip.ready;
    return nextClip;
  };

  const getClipDurationSeconds = (activeClip) =>
    Math.max(0, Number(activeClip?.meta?.duration || 0) / 1e6);

  let clip = await createClipInstance();
  let clipDurationSeconds = getClipDurationSeconds(clip);

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(videoStore.videoWidth, videoStore.videoHeight)
      : document.createElement("canvas");
  canvas.width = videoStore.videoWidth;
  canvas.height = videoStore.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let captureQueue = Promise.resolve();
  let disposed = false;
  const safeFps = Math.max(Number(fps || 0), 1);
  const frameStepSeconds = 1 / safeFps;
  const endGuardSeconds = Math.min(frameStepSeconds * 0.5, 0.02);
  const fallbackOffsets = [
    0,
    endGuardSeconds,
    frameStepSeconds * 0.25,
    frameStepSeconds * 0.5,
    frameStepSeconds,
    frameStepSeconds * 1.5,
    frameStepSeconds * 2,
    frameStepSeconds * 3,
    frameStepSeconds * 5,
    frameStepSeconds * 8,
  ].filter((value, index, values) => value >= 0 && values.indexOf(value) === index);

  const decodeFrameFromClip = async (activeClip, requestedTime, maxSafeTime) => {
    let decodedFrame = null;
    let lastError = null;
    let lastTriedTime = Math.max(0, Math.min(maxSafeTime, requestedTime));

    for (const offset of fallbackOffsets) {
      const candidateTime = Math.max(0, Math.min(maxSafeTime, requestedTime - offset));
      lastTriedTime = candidateTime;
      try {
        const { video } = await activeClip.tick(candidateTime * 1e6);
        if (video) {
          decodedFrame = video;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    return {
      decodedFrame,
      lastError,
      lastTriedTime,
    };
  };

  const recreateClip = async () => {
    clip.destroy();
    clip = await createClipInstance();
    clipDurationSeconds = getClipDurationSeconds(clip);
  };

  const captureImpl = async (time) => {
    if (disposed) {
      throw new Error("拆帧器已释放");
    }

    const requestedTime = Math.max(0, Number(time || 0));
    const knownDurationSeconds = Math.max(
      0,
      Math.min(videoStore.videoDuration || clipDurationSeconds, clipDurationSeconds || Infinity)
    );
    const effectiveDurationSeconds =
      Number.isFinite(knownDurationSeconds) && knownDurationSeconds > 0
        ? knownDurationSeconds
        : Math.max(0, Number(videoStore.videoDuration || 0));
    const maxSafeTime = Math.max(0, effectiveDurationSeconds - endGuardSeconds);

    let { decodedFrame, lastError, lastTriedTime } = await decodeFrameFromClip(
      clip,
      requestedTime,
      maxSafeTime
    );

    if (!decodedFrame && !disposed) {
      await recreateClip();
      ({ decodedFrame, lastError, lastTriedTime } = await decodeFrameFromClip(
        clip,
        requestedTime,
        maxSafeTime
      ));
    }

    if (!decodedFrame) {
      const reason = lastError?.message ? `，${lastError.message}` : "";
      throw new Error(`无法解码视频帧: ${lastTriedTime.toFixed(3)}s${reason}`);
    }

    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(decodedFrame, 0, 0, canvas.width, canvas.height);
      return await canvasToBlob(canvas, {
        mimeType: getMimeTypeForFormat(format),
        quality: INPUT_FRAME_QUALITY,
      });
    } finally {
      if (typeof decodedFrame.close === "function") {
        decodedFrame.close();
      }
    }
  };

  return {
    capture: (time) => {
      const task = captureQueue.then(() => captureImpl(time));
      captureQueue = task.catch(() => undefined);
      return task;
    },
    dispose: async () => {
      disposed = true;
      await Promise.allSettled([captureQueue]);
      clip.destroy();
    },
  };
};

const createCombinedMaskRenderer = async ({ masks, width, height }) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const anchor = getVideoCenterAnchor(width, height);

  const assets = await Promise.all(
    masks.map(async (mask) => {
      if (!mask.baseMaskDataUrl) {
        return { mask, image: null };
      }

      return {
        mask,
        image: await loadImageElement(mask.baseMaskDataUrl),
      };
    })
  );

  return {
    render: async (time) => {
      ctx.clearRect(0, 0, width, height);

      assets.forEach((asset) => {
        if (!asset.image) return;

        const state = getInterpolatedMaskTransform(asset.mask, time);
        if (!state) return;

        ctx.save();
        ctx.translate(anchor.x + state.x, anchor.y + state.y);
        ctx.scale(state.scale, state.scale);
        ctx.translate(-anchor.x, -anchor.y);
        ctx.drawImage(asset.image, 0, 0, width, height);
        ctx.restore();
      });

      const imageData = ctx.getImageData(0, 0, width, height);
      const { data } = imageData;
      for (let index = 0; index < data.length; index += 4) {
        const active = data[index + 3] > 0 ? 255 : 0;
        data[index] = 255;
        data[index + 1] = 255;
        data[index + 2] = 255;
        data[index + 3] = active;
      }
      ctx.putImageData(imageData, 0, 0);

      return canvasToBlob(canvas, {
        mimeType: "image/png",
      });
    },
  };
};

const openOutputDir = async () => {
  if (!canOpenOutput.value || !lastOutputPath.value || !window.electron) return;
  try {
    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", {
      filePath: lastOutputPath.value,
    });
    if (!result?.success) {
      throw new Error(result?.error || "打开目录失败");
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `打开目录失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  }
};

const estimateFpsFromVideo = async (file) => {
  let objectUrl = "";
  let video = null;
  let callbackId = null;

  try {
    video = document.createElement("video");
    objectUrl = URL.createObjectURL(file);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await once(video, "loadedmetadata");
    await once(video, "loadeddata");

    if (typeof video.requestVideoFrameCallback !== "function") {
      return 30;
    }

    const estimatedFps = await new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(callbackId);
        }
        resolve(30);
      }, 4000);

      let firstFrame = null;

      const finish = (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      };

      const sampleFrame = (_now, metadata) => {
        if (!firstFrame) {
          firstFrame = {
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
          };
          callbackId = video.requestVideoFrameCallback(sampleFrame);
          return;
        }

        const frameDelta = metadata.presentedFrames - firstFrame.presentedFrames;
        const timeDelta = metadata.mediaTime - firstFrame.mediaTime;
        const reachedEnoughFrames = frameDelta >= 24;
        const reachedEnoughTime = timeDelta >= Math.min(Math.max(video.duration * 0.15, 0.4), 1.2);

        if (!reachedEnoughFrames && !reachedEnoughTime) {
          callbackId = video.requestVideoFrameCallback(sampleFrame);
          return;
        }

        const fps = frameDelta > 0 && timeDelta > 0 ? frameDelta / timeDelta : 30;
        finish(Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 30);
      };

      video
        .play()
        .then(() => {
          callbackId = video.requestVideoFrameCallback(sampleFrame);
        })
        .catch(() => finish(30));
    });

    video.pause();
    return estimatedFps;
  } catch {
    return 30;
  } finally {
    if (video && callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(callbackId);
    }
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
};

const once = (target, event) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, onOk);
      target.removeEventListener("error", onError);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`事件失败: ${event}`));
    };
    target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onError, { once: true });
  });

const canvasToBlob = async (canvas, { mimeType = "image/png", quality } = {}) => {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({
      type: mimeType,
      quality,
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("无法生成图像数据"));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
};

const saveBlobToPath = async (blob, filePath) => {
  const buffer = await blob.arrayBuffer();
  await window.electron.ipcRenderer.invoke("save-file", {
    filePath,
    blob: buffer,
  });
};

const readReadableStream = async (stream) => {
  const reader = stream.getReader();
  const chunks = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
};

class ProcessedFramesClip {
  constructor({ framePaths, width, height, fps }) {
    this.framePaths = framePaths;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.frameDurationUs = 1e6 / fps;
    this.cache = new Map();
    this.meta = {
      width,
      height,
      duration: Math.round((framePaths.length / fps) * 1e6),
      audioSampleRate: 0,
      audioChanCount: 0,
    };
    this.ready = Promise.resolve(this.meta);
  }

  async tick(time) {
    const index = Math.floor(time / this.frameDurationUs);
    if (index >= this.framePaths.length) {
      return { audio: [], state: "done" };
    }

    const video = await this.loadFrame(index);
    return {
      video,
      audio: [],
      state: index >= this.framePaths.length - 1 ? "done" : "success",
    };
  }

  async loadFrame(index) {
    if (this.cache.has(index)) return this.cache.get(index);

    const framePath = this.framePaths[index];
    const bytes = await readFileBytes(framePath);
    const blob = new Blob([bytes], {
      type: getMimeTypeForPath(framePath),
    });
    const bitmap = await createImageBitmap(blob);
    this.cache.set(index, bitmap);

    if (this.cache.size > 12) {
      const firstKey = this.cache.keys().next().value;
      const first = this.cache.get(firstKey);
      if (first && typeof first.close === "function") first.close();
      this.cache.delete(firstKey);
    }

    return bitmap;
  }

  async clone() {
    return new ProcessedFramesClip({
      framePaths: [...this.framePaths],
      width: this.width,
      height: this.height,
      fps: this.fps,
    });
  }

  destroy() {
    this.cache.forEach((bitmap) => {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    });
    this.cache.clear();
  }
}

const handleResize = async () => {
  await nextTick();
  updateLayoutMetrics();
  syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
};

const applyVideoBrushDefaults = () => {
  videoStore.setMaskToolDefaults(configStore.config.advanced?.videoBrushDefault, {
    syncActive: !videoStore.hasVideoFile,
    preserveInteraction: true,
  });
};

const preserveVideoPagePlaybackState = () => {
  if (!videoStore.hasVideoFile) {
    return;
  }

  if (videoStore.isPlaying) {
    canvasPlayerRef.value?.pause?.();
    videoStore.setIsPlaying(false);
  }
};

onMounted(async () => {
  await configStore.loadConfig();
  applyVideoBrushDefaults();
  await nextTick();
  updateLayoutMetrics();
  window.addEventListener("resize", handleResize);
});

watch(
  () => configStore.config.advanced?.videoBrushDefault,
  () => {
    applyVideoBrushDefaults();
  },
  {
    deep: true,
  }
);

onBeforeRouteLeave(() => {
  preserveVideoPagePlaybackState();
});

onUnmounted(() => {
  preserveVideoPagePlaybackState();
  window.removeEventListener("resize", handleResize);
});
</script>

<style scoped>
.video-page {
  height: calc(100vh - 50px);
  position: relative;
}

.processing-page-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.08);
  z-index: 1200;
  cursor: not-allowed;
}

.video-layout {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 10px;
  overflow-x: auto;
  overflow-y: hidden;
}

.top-row {
  display: grid;
  grid-template-columns: 320px 1fr 360px;
  gap: 10px;
  min-height: 0;
  height: 100%;
  min-width: 980px;
}

.top-row.has-timeline {
  height: calc(100% - 260px);
}

.left-panel,
.center-panel,
.right-panel,
.timeline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.side-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.player-section {
  flex: 1 1 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
}

.preview-stage-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.player-canvas {
  flex: 1;
  min-height: 0;
}

.timeline-panel {
  height: 250px;
  min-width: 980px;
}

.timeline-controls {
  flex: 0 0 auto;
  padding: 8px 12px 0;
}

.timeline-controls-disabled {
  opacity: 0.72;
}

.timeline-controls-scroll {
  overflow: hidden;
}

.timeline-controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}

.timeline-progress-control {
  flex: 1 1 420px;
  min-width: 220px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.timeline-progress-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.timeline-time-display {
  flex: 0 0 auto;
  min-width: 90px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  text-align: right;
}

.timeline-zoom-control {
  flex: 0 0 210px;
  min-width: 170px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.timeline-zoom-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.timeline-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.timeline-wrap.timeline-disabled {
  pointer-events: none;
  opacity: 0.72;
}

.timeline-editor-host {
  height: 100%;
}

.timeline-editor-host :deep(.timeline-editor) {
  height: 100%;
}

.timeline-action {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.timeline-action-range {
  width: 100%;
  font-size: 12px;
  text-shadow: 0 1px 2px rgba(15, 23, 42, 0.45);
}

.timeline-action-keyframe {
  width: 100%;
  min-width: 14px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  position: relative;
}

.timeline-action-keyframe::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  background: #b4d0f9;
  border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(104, 142, 196, 0.45);
  transform: translate(-50%, -50%) rotate(45deg);
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe) {
  top: 0;
  height: 100%;
  min-width: 14px;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
  overflow: visible;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe.selected) {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe .timeline-action-content) {
  padding: 0;
  overflow: visible;
  display: flex;
  align-items: center;
  justify-content: center;
}

.keyframe-dot {
  display: none;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe.selected)
  .timeline-action-keyframe::before {
  box-shadow:
    0 0 0 1px rgba(104, 142, 196, 0.6),
    0 0 0 3px rgba(180, 208, 249, 0.28);
}

@media (max-width: 1280px) {
  .top-row {
    grid-template-columns: 280px 1fr 320px;
  }

  .timeline-controls-scroll {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-controls-row {
    min-width: max-content;
  }
}

@media (max-width: 980px) {
  .timeline-progress-control {
    min-width: 260px;
  }
}
</style>
