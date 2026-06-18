<template>
  <div class="video-preview-overlay" :style="overlayRootStyle">
    <canvas
      ref="overlayCanvasRef"
      class="overlay-canvas"
      :width="safeSourceWidth"
      :height="safeSourceHeight"
      :style="overlayCanvasStyle"
      @pointerenter="handlePointerEnter"
      @pointerdown="startPreviewDraw"
      @pointermove="handlePreviewPointerMove"
      @pointerleave="handlePointerLeave"
    />

    <div
      v-if="cursorVisible && !samVideoPromptEnabled && videoStore.maskTool.mode !== MASK_TOOL_MODES.RECT"
      class="brush-cursor"
      :class="{ 'is-erase': videoStore.maskTool.mode === MASK_TOOL_MODES.ERASE }"
      :style="brushCursorStyle"
    ></div>

    <div
      v-if="cursorVisible && (samVideoPromptEnabled || videoStore.maskTool.mode === MASK_TOOL_MODES.RECT)"
      class="rect-cursor"
      :style="rectCursorStyle"
    >
      <span class="rect-cursor-line is-horizontal"></span>
      <span class="rect-cursor-line is-vertical"></span>
      <span class="rect-cursor-core"></span>
    </div>

    <div
      v-if="rectPreviewDisplayBox"
      class="rect-preview-box"
      :style="rectPreviewDisplayStyle"
    ></div>

    <div
      v-for="marker in visibleSamPromptMarkers"
      :key="marker.key"
      class="sam-prompt-marker"
      :class="`is-${marker.type}`"
      :style="marker.style"
    >
      <span v-if="marker.type === 'point'" class="sam-prompt-marker-core"></span>
    </div>

    <div
      v-if="selectedDisplayBox"
      class="selection-box"
      :class="{ 'is-drawing': videoStore.maskTool.drawingEnabled }"
      :style="selectionBoxStyle"
      @pointerdown.stop.prevent="startMove"
    >
      <div
        v-for="handle in handles"
        :key="handle"
        class="selection-handle"
        :class="`is-${handle}`"
        @pointerdown.stop.prevent="startScale($event, handle)"
      ></div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { useRasterMaskEditor } from "src/composables/useRasterMaskEditor";
import { useVideoManagerStore } from "src/stores/videoManager";
import { MASK_TOOL_MODES, hexToRgba } from "src/utils/maskTool";
import { expandSamMaskImageDataForLama } from "src/utils/samMaskAutoExpand";
import {
  createMaskTransformFromRenderedCenter,
  getMaskBoundsCornerPoint,
  getMaskBoundsFromDataUrl,
  getMaskKeyframeTransform,
  getMaskKeyframeUniformScale,
  getRenderedMaskCenter,
  getTransformedBoundsRect,
  getVideoCenterAnchor,
  inverseTransformPointAroundAnchor,
  isMaskKeyframeDeformed,
  loadImageElement,
} from "src/utils/videoMaskUtils";

const props = defineProps({
  displayWidth: {
    type: Number,
    required: true,
  },
  displayHeight: {
    type: Number,
    required: true,
  },
  sourceWidth: {
    type: Number,
    required: true,
  },
  sourceHeight: {
    type: Number,
    required: true,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  previewVisible: {
    type: Boolean,
    default: true,
  },
  allowMaskTransform: {
    type: Boolean,
    default: true,
  },
});
const emit = defineEmits(["draw-start", "draw-end", "sam-prompt"]);

const videoStore = useVideoManagerStore();
const overlayCanvasRef = ref(null);
const assets = ref([]);
const editableCanvasRef = ref(null);
const editableCtxRef = ref(null);
const editableMaskId = ref(null);
const activeDrawingMaskId = ref(null);
const selectedState = ref(null);
const interactionState = ref(null);
const cursorPosition = ref({ x: 0, y: 0 });
const cursorInside = ref(false);
const rectPreview = ref(null);
const samPromptOperation = ref(null);
const drawingWindowBound = ref(false);
const samPromptWindowBound = ref(false);
const samFrameImageCache = new Map();
const SAM_FRAME_PRELOAD_WINDOW = 30;
const SAM_FRAME_IMAGE_CACHE_LIMIT = 96;
let renderOverlayToken = 0;
let samFramePreloadToken = 0;
let lastSamFramePreloadKey = "";

const handles = ["nw", "ne", "se", "sw"];

const safeSourceWidth = computed(() => Math.max(1, props.sourceWidth || 1));
const safeSourceHeight = computed(() => Math.max(1, props.sourceHeight || 1));
const safeDisplayWidth = computed(() => Math.max(1, props.displayWidth || 1));
const safeDisplayHeight = computed(() => Math.max(1, props.displayHeight || 1));
const scaleX = computed(() => safeDisplayWidth.value / safeSourceWidth.value);
const scaleY = computed(() => safeDisplayHeight.value / safeSourceHeight.value);
const displayScale = computed(() => (scaleX.value + scaleY.value) / 2);
const videoAnchor = computed(() =>
  getVideoCenterAnchor(safeSourceWidth.value, safeSourceHeight.value)
);

const selectedAsset = computed(
  () => assets.value.find((item) => item.maskId === videoStore.selectedMaskId) || null
);

const getFallbackBounds = () => {
  const side = Math.max(
    96,
    Math.round(Math.min(safeSourceWidth.value, safeSourceHeight.value) * 0.2)
  );
  return {
    x: (safeSourceWidth.value - side) / 2,
    y: (safeSourceHeight.value - side) / 2,
    width: side,
    height: side,
    centerX: safeSourceWidth.value / 2,
    centerY: safeSourceHeight.value / 2,
  };
};

const getRenderableBounds = (bounds) => bounds || getFallbackBounds();

const selectedSourceRect = computed(() => {
  if (videoStore.selectedMask?.type === "samVideo") return null;
  if (!selectedAsset.value || !selectedState.value) return null;

  const bounds = getRenderableBounds(selectedAsset.value.bounds);
  return getTransformedBoundsRect(bounds, selectedState.value, videoAnchor.value);
});

const selectedDisplayBox = computed(() => {
  if (!selectedSourceRect.value) return null;

  return {
    left: selectedSourceRect.value.left * scaleX.value,
    top: selectedSourceRect.value.top * scaleY.value,
    width: selectedSourceRect.value.width * scaleX.value,
    height: selectedSourceRect.value.height * scaleY.value,
    centerX: selectedSourceRect.value.centerX,
    centerY: selectedSourceRect.value.centerY,
  };
});

const rectPreviewDisplayBox = computed(() => {
  if (!rectPreview.value || !selectedState.value) return null;

  const maskScaleX = Number(selectedState.value.scaleX ?? selectedState.value.scale ?? 1);
  const maskScaleY = Number(selectedState.value.scaleY ?? selectedState.value.scale ?? 1);
  const translatedLeft =
    videoAnchor.value.x +
    Number(selectedState.value.x || 0) +
    maskScaleX * (rectPreview.value.x - videoAnchor.value.x);
  const translatedTop =
    videoAnchor.value.y +
    Number(selectedState.value.y || 0) +
    maskScaleY * (rectPreview.value.y - videoAnchor.value.y);

  return {
    left: translatedLeft * scaleX.value,
    top: translatedTop * scaleY.value,
    width: rectPreview.value.width * maskScaleX * scaleX.value,
    height: rectPreview.value.height * maskScaleY * scaleY.value,
  };
});

const rectPreviewDisplayStyle = computed(() => {
  if (!rectPreviewDisplayBox.value) return {};
  return {
    left: `${rectPreviewDisplayBox.value.left}px`,
    top: `${rectPreviewDisplayBox.value.top}px`,
    width: `${rectPreviewDisplayBox.value.width}px`,
    height: `${rectPreviewDisplayBox.value.height}px`,
    borderColor: hexToRgba(
      videoStore.maskTool.brushColor,
      Math.max(0.3, videoStore.maskTool.brushAlpha)
    ),
    background: hexToRgba(videoStore.maskTool.brushColor, videoStore.maskTool.brushAlpha),
  };
});

const getCurrentVideoFrameIndex = () => {
  const fps = Math.max(1, Number(videoStore.sourceFrameRate || 30));
  return Math.max(0, Math.round(Number(videoStore.currentTime || 0) * fps));
};

const getSamPromptTrackColor = () =>
  videoStore.selectedMask?.displayColor || videoStore.maskTool.brushColor || "#f59e0b";

const createSamPointMarker = (prompt, point, index) => ({
  key: `${prompt.objectId}:point:${index}`,
  type: "point",
  style: {
    left: `${Number(point.x || 0) * scaleX.value}px`,
    top: `${Number(point.y || 0) * scaleY.value}px`,
    color: getSamPromptTrackColor(),
    borderColor: getSamPromptTrackColor(),
    background: hexToRgba(getSamPromptTrackColor(), 0.24),
  },
});

const createSamBoxMarker = (prompt, box) => ({
  key: `${prompt.objectId}:box`,
  type: "box",
  style: {
    left: `${Number(box.x || 0) * scaleX.value}px`,
    top: `${Number(box.y || 0) * scaleY.value}px`,
    width: `${Math.max(1, Number(box.width || 0) * scaleX.value)}px`,
    height: `${Math.max(1, Number(box.height || 0) * scaleY.value)}px`,
    borderColor: getSamPromptTrackColor(),
    background: hexToRgba(getSamPromptTrackColor(), 0.08),
  },
});

const visibleSamPromptMarkers = computed(() => {
  const selectedMask = videoStore.selectedMask;
  if (!samVideoPromptEnabled.value || selectedMask?.type !== "samVideo") return [];
  const currentFrameIndex = getCurrentVideoFrameIndex();
  return (selectedMask.samPromptObjects || [])
    .filter((prompt) => Number(prompt.frameIndex || 0) === currentFrameIndex)
    .flatMap((prompt) => {
      if (prompt.box) {
        return [createSamBoxMarker(prompt, prompt.box)];
      }
      return (prompt.points || [])
        .filter((point) => Number(point.label ?? 1) === 1)
        .map((point, index) => createSamPointMarker(prompt, point, index));
    });
});

const overlayRootStyle = computed(() => ({
  width: `${safeDisplayWidth.value}px`,
  height: `${safeDisplayHeight.value}px`,
  opacity: props.previewVisible ? 1 : 0,
}));

const drawingEnabled = computed(
  () =>
    videoStore.maskTool.drawingEnabled &&
    selectedState.value &&
    videoStore.selectedMask?.type !== "samVideo" &&
    !props.disabled
);
const samVideoPromptEnabled = computed(
  () => videoStore.selectedMask?.type === "samVideo" && !props.disabled
);

const overlayCanvasStyle = computed(() => ({
  width: `${safeDisplayWidth.value}px`,
  height: `${safeDisplayHeight.value}px`,
  pointerEvents: drawingEnabled.value || samVideoPromptEnabled.value ? "auto" : "none",
  cursor: drawingEnabled.value || samVideoPromptEnabled.value ? "none" : "default",
}));

const cursorVisible = computed(
  () => (drawingEnabled.value || samVideoPromptEnabled.value) && cursorInside.value
);

const brushCursorStyle = computed(() => {
  const size = Math.max(4, videoStore.maskTool.brushSize * displayScale.value);
  const isErase = videoStore.maskTool.mode === MASK_TOOL_MODES.ERASE;

  return {
    left: `${cursorPosition.value.x}px`,
    top: `${cursorPosition.value.y}px`,
    width: `${size}px`,
    height: `${size}px`,
    background: isErase
      ? "rgba(255, 255, 255, 0.95)"
      : hexToRgba(videoStore.maskTool.brushColor, Math.max(0.18, videoStore.maskTool.brushAlpha)),
    borderColor: isErase ? "rgba(17, 24, 39, 0.65)" : "rgba(255, 255, 255, 0.92)",
  };
});

const rectCursorStyle = computed(() => ({
  left: `${cursorPosition.value.x}px`,
  top: `${cursorPosition.value.y}px`,
}));

const selectionBoxStyle = computed(() => {
  if (!selectedDisplayBox.value) return {};
  return {
    left: `${selectedDisplayBox.value.left}px`,
    top: `${selectedDisplayBox.value.top}px`,
    width: `${selectedDisplayBox.value.width}px`,
    height: `${selectedDisplayBox.value.height}px`,
    pointerEvents:
      props.disabled ||
      videoStore.selectedMask?.type === "samVideo" ||
      videoStore.maskTool.drawingEnabled ||
      !props.allowMaskTransform
        ? "none"
        : "auto",
  };
});

const refreshSelectedState = () => {
  selectedState.value =
    videoStore.getMaskStateAtTime(videoStore.selectedMaskId, videoStore.currentTime) || null;
};

const ensureEditableCanvas = async () => {
  const selectedMask = videoStore.selectedMask;
  if (!selectedMask?.baseMaskDataUrl) {
    editableCanvasRef.value = null;
    editableCtxRef.value = null;
    editableMaskId.value = null;
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = safeSourceWidth.value;
  canvas.height = safeSourceHeight.value;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const image = await loadImageElement(selectedMask.baseMaskDataUrl);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  editableCanvasRef.value = canvas;
  editableCtxRef.value = ctx;
  editableMaskId.value = selectedMask.id;
};

const getMaskDataSignature = (mask = "") => {
  const value = String(mask || "");
  if (!value) return "";
  return `${value.length}:${value.slice(0, 32)}:${value.slice(-32)}`;
};

const getSamFrameListSignature = (samFrames = []) => {
  const frames = Array.isArray(samFrames) ? samFrames : [];
  const firstFrame = frames[0] || null;
  const lastFrame = frames[frames.length - 1] || null;
  const summarizeFrame = (frame) => {
    if (!frame) return "";
    const masks = Array.isArray(frame.masks) ? frame.masks : [];
    const firstMask = masks[0] || null;
    const lastMask = masks[masks.length - 1] || null;
    const summarizeMask = (item) =>
      item
        ? [
            item.objectId || "",
            item.maskPath || "",
            item.maskAssetId || "",
            item.maskSignature || getMaskDataSignature(item.mask),
          ].join(":")
        : "";
    return [
      frame.frameIndex ?? "",
      frame.time ?? "",
      masks.length,
      summarizeMask(firstMask),
      summarizeMask(lastMask),
    ].join("~");
  };
  return `${frames.length}|${summarizeFrame(firstFrame)}|${summarizeFrame(lastFrame)}`;
};

const getLocalMaskImageUrl = (filePath = "") => {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  if (!normalizedPath) return "";
  if (normalizedPath.startsWith("atom://") || normalizedPath.startsWith("file://")) {
    return normalizedPath;
  }
  return window.electron ? `atom://${encodeURI(normalizedPath)}` : `file://${encodeURI(normalizedPath)}`;
};

const getSamFrameCacheKey = ({
  maskId,
  frameIndex,
  objectId,
  mask = "",
  maskPath = "",
  maskSignature = "",
  modelId = "",
  previewColor = "",
  previewAlpha = 1,
} = {}) =>
  [
    maskId,
    frameIndex,
    objectId,
    String(modelId || "").toLowerCase() === "lama" ? "lama-expanded" : "original",
    maskPath || maskSignature || getMaskDataSignature(mask),
    previewColor,
    Number(previewAlpha || 0).toFixed(3),
  ].join(":");

const buildSamFrameIndex = (samFrames = []) =>
  samFrames
    .map((frame, index) => ({
      index,
      frameIndex: Number(frame.frameIndex || 0),
      time: Number(frame.time || 0),
    }))
    .sort((a, b) => a.time - b.time || a.frameIndex - b.frameIndex);

const findNearestSamFrame = (asset, currentTime = 0) => {
  const frames = asset?.samFrames || [];
  const frameIndex = asset?.samFrameIndex || [];
  if (!frames.length || !frameIndex.length) return null;

  const targetTime = Number(currentTime || 0);
  if (targetTime <= frameIndex[0].time) {
    return frames[frameIndex[0].index] || null;
  }
  const last = frameIndex[frameIndex.length - 1];
  if (targetTime >= last.time) {
    return frames[last.index] || null;
  }

  let left = 0;
  let right = frameIndex.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const middleTime = frameIndex[middle].time;
    if (middleTime === targetTime) {
      return frames[frameIndex[middle].index] || null;
    }
    if (middleTime < targetTime) {
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  const previous = frameIndex[Math.max(0, right)];
  const next = frameIndex[Math.min(frameIndex.length - 1, left)];
  const nearest =
    Math.abs(targetTime - previous.time) <= Math.abs(next.time - targetTime)
      ? previous
      : next;
  return frames[nearest.index] || null;
};

const parseMaskPreviewColor = (color = "") => {
  const normalized = String(color || "#ffffff").replace("#", "");
  const safeHex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized.padEnd(6, "f").slice(0, 6);
  return {
    r: Number.parseInt(safeHex.slice(0, 2), 16) || 255,
    g: Number.parseInt(safeHex.slice(2, 4), 16) || 255,
    b: Number.parseInt(safeHex.slice(4, 6), 16) || 255,
  };
};

const createPreviewMaskImage = async (image, { color, alpha } = {}) => {
  const width = Math.max(1, Number(image?.naturalWidth || image?.videoWidth || image?.width || 1));
  const height = Math.max(1, Number(image?.naturalHeight || image?.videoHeight || image?.height || 1));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  let imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = Math.max(data[index], data[index + 1], data[index + 2]);
    const sourceAlpha = data[index + 3];
    const isMaskPixel =
      sourceAlpha < 255 ? sourceAlpha > 0 : luminance > 127;
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = isMaskPixel ? 255 : 0;
  }
  if (String(props.currentModel || "").toLowerCase() === "lama") {
    imageData = expandSamMaskImageDataForLama(imageData, {
      imageWidth: width,
      imageHeight: height,
    }).imageData;
  }
  const previewData = imageData.data;
  const previewColor = parseMaskPreviewColor(color || videoStore.maskTool.brushColor);
  const previewAlpha = Math.round(
    Math.max(0, Math.min(1, Number(alpha ?? videoStore.maskTool.brushAlpha ?? 1))) * 255
  );
  for (let index = 0; index < previewData.length; index += 4) {
    const isMaskPixel = previewData[index + 3] > 0;
    previewData[index] = previewColor.r;
    previewData[index + 1] = previewColor.g;
    previewData[index + 2] = previewColor.b;
    previewData[index + 3] = isMaskPixel ? previewAlpha : 0;
  }
  ctx.putImageData(imageData, 0, 0);
  return await loadImageElement(canvas.toDataURL("image/png"));
};

const rememberSamFrameImage = (key, image) => {
  if (!key || !image) return image;
  if (samFrameImageCache.has(key)) {
    samFrameImageCache.delete(key);
  }
  samFrameImageCache.set(key, image);
  while (samFrameImageCache.size > SAM_FRAME_IMAGE_CACHE_LIMIT) {
    const oldestKey = samFrameImageCache.keys().next().value;
    samFrameImageCache.delete(oldestKey);
  }
  return image;
};

const loadSamFrameMaskImage = async ({
  maskId,
  frameIndex,
  objectId,
  mask,
  maskPath,
  maskSignature,
}) => {
  if (!maskPath && !mask) return null;
  const previewColor = videoStore.maskTool.brushColor;
  const previewAlpha = videoStore.maskTool.brushAlpha;
  const modelId = props.currentModel;
  const cacheKey = getSamFrameCacheKey({
    maskId,
    frameIndex,
    objectId,
    mask,
    maskPath,
    maskSignature,
    modelId,
    previewColor,
    previewAlpha,
  });
  const cached = samFrameImageCache.get(cacheKey);
  if (cached) {
    samFrameImageCache.delete(cacheKey);
    samFrameImageCache.set(cacheKey, cached);
    return cached;
  }

  try {
    const image = await loadImageElement(maskPath ? getLocalMaskImageUrl(maskPath) : mask);
    return rememberSamFrameImage(
      cacheKey,
      await createPreviewMaskImage(image, {
        color: previewColor,
        alpha: previewAlpha,
      })
    );
  } catch (error) {
    console.warn("加载 SAM 视频蒙版帧失败，已跳过该对象:", error);
    return null;
  }
};

const preloadSamFrameMasks = async ({ mask, asset, nearestFrame } = {}) => {
  if (!mask || !asset?.samFrames?.length || !nearestFrame) return;
  const frameIndexEntries = asset.samFrameIndex || [];
  const startIndex = frameIndexEntries.findIndex(
    (item) => Number(item.frameIndex) === Number(nearestFrame.frameIndex)
  );
  if (startIndex < 0) return;
  const enabledObjects = new Set(
    (mask.samObjects || [])
      .filter((item) => item.enabled !== false)
      .map((item) => Number(item.objectId))
  );
  if (!enabledObjects.size) return;
  const stride = Math.max(1, Math.floor(SAM_FRAME_PRELOAD_WINDOW / 2));
  const windowBucket = Math.floor(startIndex / stride);
  const preloadKey = [
    mask.id,
    windowBucket,
    getSamFrameListSignature(mask.samFrames),
    props.currentModel,
    videoStore.maskTool.brushColor,
    Number(videoStore.maskTool.brushAlpha || 0).toFixed(3),
    [...enabledObjects].sort((a, b) => a - b).join(","),
  ].join(":");
  if (preloadKey === lastSamFramePreloadKey) return;
  lastSamFramePreloadKey = preloadKey;
  const preloadToken = ++samFramePreloadToken;
  const framesToPreload = frameIndexEntries
    .slice(startIndex, startIndex + SAM_FRAME_PRELOAD_WINDOW + 1)
    .map((item) => asset.samFrames[item.index])
    .filter(Boolean);

  for (const frame of framesToPreload) {
    if (preloadToken !== samFramePreloadToken) return;
    await Promise.all(
      (frame.masks || [])
        .filter((item) => enabledObjects.has(Number(item.objectId)))
        .map((item) =>
          loadSamFrameMaskImage({
            maskId: mask.id,
            frameIndex: frame.frameIndex,
            objectId: item.objectId,
            mask: item.mask,
            maskPath: item.maskPath,
            maskSignature: item.maskSignature,
          })
        )
    );
  }
};

const refreshAssets = async () => {
  const nextAssets = await Promise.all(
    videoStore.masks.map(async (mask) => {
      if (mask.type === "samVideo") {
        const samFrames = (mask.samFrames || [])
          .map((frame) => ({
            frameIndex: Number(frame.frameIndex || 0),
            time: Number(frame.time ?? 0),
            masks: (frame.masks || [])
              .map((item) => ({
                objectId: Number(item.objectId || 0),
                mask: item.mask || "",
                maskPath: item.maskPath || "",
                maskSignature: item.maskSignature || "",
              }))
              .filter((item) => item.objectId > 0 && (item.maskPath || item.mask)),
          }))
          .filter((frame) => frame.masks.length > 0)
          .sort((a, b) => a.frameIndex - b.frameIndex);
        return {
          maskId: mask.id,
          image: null,
          bounds: null,
          samFrames,
          samFrameIndex: buildSamFrameIndex(samFrames),
        };
      }
      if (!mask.baseMaskDataUrl) {
        return {
        maskId: mask.id,
        image: null,
        bounds: null,
        samFrames: [],
        samFrameIndex: [],
      };
    }

      const image = await loadImageElement(mask.baseMaskDataUrl);
      const bounds = await getMaskBoundsFromDataUrl(mask.baseMaskDataUrl);
      return {
        maskId: mask.id,
        image,
      bounds,
      samFrames: [],
      samFrameIndex: [],
    };
  })
  );
  assets.value = nextAssets;
};

const getOverlayRect = () => overlayCanvasRef.value?.getBoundingClientRect() || null;

const isPointerInOverlay = (event) => {
  const rect = getOverlayRect();
  if (!rect) return false;
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
};

const getSourcePointFromEvent = (event) => {
  const rect = getOverlayRect();
  if (!rect) {
    return {
      x: 0,
      y: 0,
    };
  }

  return {
    x: ((event.clientX - rect.left) / rect.width) * safeSourceWidth.value,
    y: ((event.clientY - rect.top) / rect.height) * safeSourceHeight.value,
  };
};

const updateCursorPosition = (event) => {
  const rect = getOverlayRect();
  if (!rect) return;

  const normalizedX = (event.clientX - rect.left) / Math.max(rect.width, 1);
  const normalizedY = (event.clientY - rect.top) / Math.max(rect.height, 1);
  const clampedX = Math.min(1, Math.max(0, normalizedX));
  const clampedY = Math.min(1, Math.max(0, normalizedY));
  cursorPosition.value = {
    x: clampedX * safeDisplayWidth.value,
    y: clampedY * safeDisplayHeight.value,
  };
};

const getInverseTransformedPoint = (sourcePoint) => {
  if (!selectedAsset.value || !selectedState.value) return sourcePoint;
  return inverseTransformPointAroundAnchor(sourcePoint, selectedState.value, videoAnchor.value);
};

const getBasePointFromEvent = (event) => {
  const sourcePoint = getSourcePointFromEvent(event);
  return getInverseTransformedPoint(sourcePoint);
};

const getMaskPreviewOpacity = (maskId) =>
  maskId === videoStore.selectedMaskId ? 1 : 0.28;

const handleOverlayRenderError = (error) => {
  console.warn("视频蒙版预览渲染失败，已跳过本次覆盖层绘制:", error);
  samFrameImageCache.clear();
  const canvas = overlayCanvasRef.value;
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
};

const renderOverlay = async () => {
  const renderToken = ++renderOverlayToken;
  const canvas = overlayCanvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    for (const mask of videoStore.masks) {
      const asset = assets.value.find((item) => item.maskId === mask.id);
      if (!asset) continue;

      const state = videoStore.getMaskStateAtTime(mask.id, videoStore.currentTime);
      if (!state) continue;

      if (mask.type === "samVideo") {
        const enabledObjects = new Set(
          (mask.samObjects || [])
            .filter((item) => item.enabled !== false)
            .map((item) => Number(item.objectId))
        );
        if (enabledObjects.size === 0 || !asset.samFrames?.length) continue;
        const nearestFrame = findNearestSamFrame(asset, videoStore.currentTime);
        if (!nearestFrame) continue;

        ctx.save();
        try {
          ctx.globalAlpha = getMaskPreviewOpacity(mask.id);
          for (const item of nearestFrame.masks) {
            if (!enabledObjects.has(Number(item.objectId))) continue;
            const image = await loadSamFrameMaskImage({
              maskId: mask.id,
              frameIndex: nearestFrame.frameIndex,
              objectId: item.objectId,
              mask: item.mask,
              maskPath: item.maskPath,
              maskSignature: item.maskSignature,
            });
            if (renderToken !== renderOverlayToken) break;
            if (image) {
              ctx.drawImage(image, 0, 0, safeSourceWidth.value, safeSourceHeight.value);
            }
          }
        } finally {
          ctx.restore();
        }
        if (renderToken !== renderOverlayToken) return;
        void preloadSamFrameMasks({ mask, asset, nearestFrame });
        continue;
      }

      if (!asset.image) continue;

      const imageSource =
        mask.id === editableMaskId.value && editableCanvasRef.value ? editableCanvasRef.value : asset.image;

      ctx.save();
      ctx.globalAlpha = getMaskPreviewOpacity(mask.id);
      ctx.translate(videoAnchor.value.x + state.x, videoAnchor.value.y + state.y);
      ctx.scale(state.scaleX ?? state.scale ?? 1, state.scaleY ?? state.scale ?? 1);
      ctx.translate(-videoAnchor.value.x, -videoAnchor.value.y);
      ctx.drawImage(imageSource, 0, 0, safeSourceWidth.value, safeSourceHeight.value);
      ctx.restore();
    }
  } catch (error) {
  if (renderToken === renderOverlayToken) {
    handleOverlayRenderError(error);
  }
  }
};

let rasterMaskEditor;
const syncRectPreview = () => {
  rectPreview.value = rasterMaskEditor.rectPreview.value;
  renderOverlay();
};

rasterMaskEditor = useRasterMaskEditor({
  canvasRef: editableCanvasRef,
  ctxRef: editableCtxRef,
  getTool: () => ({
    mode: videoStore.maskTool.mode,
    brushColor: videoStore.maskTool.brushColor,
    brushAlpha: videoStore.maskTool.brushAlpha,
    brushSize: videoStore.maskTool.brushSize,
  }),
  onPreviewChange: syncRectPreview,
});

const detachDrawingWindowListeners = () => {
  if (!drawingWindowBound.value) return;
  window.removeEventListener("pointermove", handleWindowPointerMove, true);
  window.removeEventListener("pointerup", handleWindowPointerUp, true);
  drawingWindowBound.value = false;
};

const detachSamPromptWindowListeners = () => {
  if (!samPromptWindowBound.value) return;
  window.removeEventListener("pointermove", handleSamPromptWindowPointerMove, true);
  window.removeEventListener("pointerup", handleSamPromptWindowPointerUp, true);
  samPromptWindowBound.value = false;
};

const commitEditedMask = () => {
  if (!editableCanvasRef.value) return;
  if (activeDrawingMaskId.value === videoStore.selectedMaskId) {
    videoStore.commitSelectedMaskBaseMask(editableCanvasRef.value.toDataURL("image/png"));
  } else if (activeDrawingMaskId.value) {
    videoStore.commitMaskBaseMask(activeDrawingMaskId.value, editableCanvasRef.value.toDataURL("image/png"));
  }
};

const cancelPreviewDraw = () => {
  rasterMaskEditor.cancelOperation();
  rectPreview.value = null;
  samPromptOperation.value = null;
  activeDrawingMaskId.value = null;
  detachDrawingWindowListeners();
  detachSamPromptWindowListeners();
  emit("draw-end");
  renderOverlay();
};

const normalizePromptBox = (startPoint, endPoint) => {
  const x0 = Math.min(startPoint.x, endPoint.x);
  const y0 = Math.min(startPoint.y, endPoint.y);
  const x1 = Math.max(startPoint.x, endPoint.x);
  const y1 = Math.max(startPoint.y, endPoint.y);
  return {
    x: Math.max(0, x0),
    y: Math.max(0, y0),
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  };
};

const startSamVideoPrompt = (event) => {
  if (!samVideoPromptEnabled.value || event.button !== 0) return;
  updateCursorPosition(event);
  cursorInside.value = true;
  const startPoint = getSourcePointFromEvent(event);

  samPromptOperation.value = {
    pointerId: event.pointerId,
    startPoint,
    moved: false,
  };
  rectPreview.value = normalizePromptBox(startPoint, startPoint);
  detachSamPromptWindowListeners();
  window.addEventListener("pointermove", handleSamPromptWindowPointerMove, true);
  window.addEventListener("pointerup", handleSamPromptWindowPointerUp, true);
  samPromptWindowBound.value = true;
  emit("draw-start");
  event.preventDefault();
};

const finishPreviewDraw = (event = null) => {
  const result = rasterMaskEditor.finishOperation(event ? getBasePointFromEvent(event) : null);
  rectPreview.value = null;
  detachDrawingWindowListeners();
  if (result.changed) {
    commitEditedMask();
  }
  activeDrawingMaskId.value = null;
  emit("draw-end");
  renderOverlay();
};

const handlePointerEnter = (event) => {
  cursorInside.value = true;
  updateCursorPosition(event);
};

const startPreviewDraw = async (event) => {
  if (samVideoPromptEnabled.value) {
    startSamVideoPrompt(event);
    return;
  }
  if (!drawingEnabled.value || !videoStore.selectedMask || event.button !== 0) {
    return;
  }

  updateCursorPosition(event);
  cursorInside.value = true;

  if (editableMaskId.value !== videoStore.selectedMask.id) {
    await ensureEditableCanvas();
  }

  activeDrawingMaskId.value = videoStore.selectedMask.id;
  const result = rasterMaskEditor.beginOperation(getBasePointFromEvent(event));
  rectPreview.value = rasterMaskEditor.rectPreview.value;
  if (!result.started) return;

  detachDrawingWindowListeners();
  window.addEventListener("pointermove", handleWindowPointerMove, true);
  window.addEventListener("pointerup", handleWindowPointerUp, true);
  drawingWindowBound.value = true;
  emit("draw-start");
  event.preventDefault();
};

const handleSamPromptWindowPointerMove = (event) => {
  if (!samPromptOperation.value || event.pointerId !== samPromptOperation.value.pointerId) return;
  updateCursorPosition(event);
  cursorInside.value = isPointerInOverlay(event);
  const nextBox = normalizePromptBox(
    samPromptOperation.value.startPoint,
    getSourcePointFromEvent(event)
  );
  samPromptOperation.value.moved =
    samPromptOperation.value.moved || nextBox.width >= 4 || nextBox.height >= 4;
  rectPreview.value = samPromptOperation.value.moved ? nextBox : null;
  event.preventDefault();
};

const handleSamPromptWindowPointerUp = (event) => {
  if (!samPromptOperation.value || event.pointerId !== samPromptOperation.value.pointerId) return;
  const operation = samPromptOperation.value;
  const box = normalizePromptBox(operation.startPoint, getSourcePointFromEvent(event));
  detachSamPromptWindowListeners();
  samPromptOperation.value = null;
  rectPreview.value = null;
  cursorInside.value = isPointerInOverlay(event);
  if (box.width >= 4 && box.height >= 4) {
    emit("sam-prompt", { box });
  } else {
    emit("sam-prompt", { point: operation.startPoint });
  }
  emit("draw-end");
  renderOverlay();
  event.preventDefault();
};

const handlePreviewPointerMove = (event) => {
  cursorInside.value = true;
  updateCursorPosition(event);
};

const handleWindowPointerMove = (event) => {
  if (!rasterMaskEditor.isOperating.value) return;
  updateCursorPosition(event);
  cursorInside.value = isPointerInOverlay(event);
  rasterMaskEditor.updateOperation(getBasePointFromEvent(event));
  event.preventDefault();
};

const handleWindowPointerUp = (event) => {
  if (!rasterMaskEditor.isOperating.value) {
    detachDrawingWindowListeners();
    return;
  }

  updateCursorPosition(event);
  cursorInside.value = isPointerInOverlay(event);
  finishPreviewDraw(event);
  event.preventDefault();
};

const handlePointerLeave = () => {
  if (!rasterMaskEditor.isOperating.value) {
    cursorInside.value = false;
  }
};

const startMove = (event) => {
  if (
    props.disabled ||
    !props.allowMaskTransform ||
    videoStore.maskTool.drawingEnabled ||
    !selectedDisplayBox.value ||
    !selectedState.value
  ) {
    return;
  }

  const keyframe = videoStore.ensureTransformKeyframeAtCurrentTime(videoStore.selectedMaskId);
  if (!keyframe) return;
  const keyframeTransform = getMaskKeyframeTransform(keyframe, selectedState.value || undefined);

  interactionState.value = {
    type: "move",
    startPointer: getSourcePointFromEvent(event),
    startX: keyframeTransform.x,
    startY: keyframeTransform.y,
    scaleX: keyframeTransform.scaleX,
    scaleY: keyframeTransform.scaleY,
    originScaleX: keyframeTransform.originScaleX,
    originScaleY: keyframeTransform.originScaleY,
    keyframeId: keyframe.id,
  };
  window.addEventListener("pointermove", handleInteractionMove);
  window.addEventListener("pointerup", finishInteraction);
};

const startScale = (event, handle) => {
  if (
    props.disabled ||
    !props.allowMaskTransform ||
    videoStore.maskTool.drawingEnabled ||
    !selectedSourceRect.value ||
    !selectedState.value
  ) {
    return;
  }

  const keyframe = videoStore.ensureTransformKeyframeAtCurrentTime(videoStore.selectedMaskId);
  if (!keyframe) return;
  const keyframeTransform = getMaskKeyframeTransform(keyframe, selectedState.value || undefined);
  const bounds = getRenderableBounds(selectedAsset.value?.bounds);
  const transformedRect =
    getTransformedBoundsRect(bounds, keyframeTransform, videoAnchor.value) || selectedSourceRect.value;
  const fixedHandle =
    {
      nw: "se",
      ne: "sw",
      se: "nw",
      sw: "ne",
    }[handle] || "nw";

  interactionState.value = {
    type: "scale",
    handle,
    bounds,
    fixedHandle,
    fixedPoint: getMaskBoundsCornerPoint(transformedRect, fixedHandle),
    originScaleX: keyframeTransform.originScaleX,
    originScaleY: keyframeTransform.originScaleY,
    keyframeId: keyframe.id,
  };
  videoStore.deferKeyframeDeformationUi(keyframe.id);
  window.addEventListener("pointermove", handleInteractionMove);
  window.addEventListener("pointerup", finishInteraction);
};

const handleInteractionMove = (event) => {
  if (!interactionState.value || !videoStore.selectedMaskId) return;

  if (interactionState.value.type === "move") {
    const pointer = getSourcePointFromEvent(event);
    const dx = pointer.x - interactionState.value.startPointer.x;
    const dy = pointer.y - interactionState.value.startPointer.y;
    videoStore.upsertKeyframe(videoStore.selectedMaskId, {
      id: interactionState.value.keyframeId,
      x: interactionState.value.startX + dx,
      y: interactionState.value.startY + dy,
      scaleX: interactionState.value.scaleX,
      scaleY: interactionState.value.scaleY,
      originScaleX: interactionState.value.originScaleX,
      originScaleY: interactionState.value.originScaleY,
    });
  } else if (interactionState.value.type === "scale") {
    const bounds = interactionState.value.bounds || getRenderableBounds(selectedAsset.value?.bounds);
    const fixedPoint = interactionState.value.fixedPoint;
    const pointer = getSourcePointFromEvent(event);
    if (!bounds || !fixedPoint) return;

    let nextLeft = Math.min(fixedPoint.x, pointer.x);
    let nextRight = Math.max(fixedPoint.x, pointer.x);
    let nextTop = Math.min(fixedPoint.y, pointer.y);
    let nextBottom = Math.max(fixedPoint.y, pointer.y);
    const minWidth = Math.max(1, Number(bounds.width || 0) * 0.05);
    const minHeight = Math.max(1, Number(bounds.height || 0) * 0.05);

    if (nextRight - nextLeft < minWidth) {
      if (pointer.x >= fixedPoint.x) {
        nextRight = fixedPoint.x + minWidth;
      } else {
        nextLeft = fixedPoint.x - minWidth;
      }
    }

    if (nextBottom - nextTop < minHeight) {
      if (pointer.y >= fixedPoint.y) {
        nextBottom = fixedPoint.y + minHeight;
      } else {
        nextTop = fixedPoint.y - minHeight;
      }
    }

    const nextTransform = createMaskTransformFromRenderedCenter({
      bounds,
      center: {
        x: (nextLeft + nextRight) / 2,
        y: (nextTop + nextBottom) / 2,
      },
      scaleX: (nextRight - nextLeft) / Math.max(Number(bounds.width || 1), 1),
      scaleY: (nextBottom - nextTop) / Math.max(Number(bounds.height || 1), 1),
      anchor: videoAnchor.value,
      originScaleX: interactionState.value.originScaleX,
      originScaleY: interactionState.value.originScaleY,
    });

    videoStore.upsertKeyframe(videoStore.selectedMaskId, {
      id: interactionState.value.keyframeId,
      ...nextTransform,
    });
  }
};

const finishInteraction = () => {
  const completedInteraction = interactionState.value;
  interactionState.value = null;
  window.removeEventListener("pointermove", handleInteractionMove);
  window.removeEventListener("pointerup", finishInteraction);
  videoStore.deferKeyframeDeformationUi(null);

  if (
    completedInteraction?.type !== "scale" ||
    !videoStore.selectedMaskId ||
    !completedInteraction.bounds
  ) {
    return;
  }

  const mask = videoStore.getMaskById(videoStore.selectedMaskId);
  const keyframe =
    mask?.keyframes.find((item) => item.id === completedInteraction.keyframeId) || null;
  if (!keyframe || isMaskKeyframeDeformed(keyframe)) {
    return;
  }

  const normalizedScale = getMaskKeyframeUniformScale(keyframe);
  const nextTransform = createMaskTransformFromRenderedCenter({
    bounds: completedInteraction.bounds,
    center: getRenderedMaskCenter(completedInteraction.bounds, keyframe, videoAnchor.value),
    scaleX: keyframe.originScaleX * normalizedScale,
    scaleY: keyframe.originScaleY * normalizedScale,
    anchor: videoAnchor.value,
    originScaleX: keyframe.originScaleX,
    originScaleY: keyframe.originScaleY,
  });

  videoStore.upsertKeyframe(videoStore.selectedMaskId, {
    id: keyframe.id,
    ...nextTransform,
  });
};

watch(
  () => [
    videoStore.masks
      .map((mask) =>
        [
          mask.id,
          mask.type,
          mask.baseMaskDataUrl,
          ...(mask.samObjects || []).map((item) => `${item.objectId}:${item.enabled !== false}`),
          getSamFrameListSignature(mask.samFrames),
        ].join("|")
      )
      .join("||"),
    safeSourceWidth.value,
    safeSourceHeight.value,
  ],
  async () => {
    await refreshAssets();
    await ensureEditableCanvas();
    refreshSelectedState();
    await nextTick();
    renderOverlay();
  },
  { immediate: true }
);

watch(
  () => [videoStore.currentTime, videoStore.selectedMaskId, videoStore.selectedKeyframeId],
  () => {
    if (rasterMaskEditor.isOperating.value) {
      cancelPreviewDraw();
    }
    refreshSelectedState();
    renderOverlay();
  },
  { immediate: true }
);

watch(
  () =>
    videoStore.masks
      .map((mask) =>
        [
          mask.id,
          mask.startTime,
          mask.endTime,
          mask.interpolation,
          mask.enabled,
          mask.type,
          ...(mask.samObjects || []).map((item) => `${item.objectId}:${item.enabled !== false}`),
          ...(mask.keyframes || []).map(
            (keyframe) =>
              [
                keyframe.id,
                keyframe.time,
                keyframe.x,
                keyframe.y,
                keyframe.scale,
                keyframe.scaleX,
                keyframe.scaleY,
                keyframe.originScaleX,
                keyframe.originScaleY,
              ].join(":")
          ),
        ].join("|")
      )
      .join("||"),
  () => {
    refreshSelectedState();
    renderOverlay();
  }
);

watch(
  () => props.displayWidth,
  () => renderOverlay()
);

watch(
  () => props.displayHeight,
  () => renderOverlay()
);

watch(
  () => [
    videoStore.maskTool.mode,
    videoStore.maskTool.brushColor,
    videoStore.maskTool.brushAlpha,
    videoStore.maskTool.brushSize,
  ],
  () => {
    if (!cursorInside.value) return;
    renderOverlay();
  }
);

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled && rasterMaskEditor.isOperating.value) {
      cancelPreviewDraw();
    }
  }
);

onMounted(() => {
  refreshSelectedState();
  renderOverlay();
});

onUnmounted(() => {
  renderOverlayToken += 1;
  samFramePreloadToken += 1;
  samFrameImageCache.clear();
  cancelPreviewDraw();
  detachSamPromptWindowListeners();
  finishInteraction();
});

defineExpose({
  isReady: () => Boolean(overlayCanvasRef.value && videoStore.selectedMask),
  cancelPreviewDraw,
});
</script>

<style scoped>
.video-preview-overlay {
  position: absolute;
  inset: 0;
}

.overlay-canvas {
  position: absolute;
  inset: 0;
}

.brush-cursor {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.92);
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.18);
  pointer-events: none;
  z-index: 3;
}

.brush-cursor.is-erase {
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.45);
}

.rect-cursor {
  position: absolute;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 4;
  mix-blend-mode: difference;
}

.rect-cursor-line {
  position: absolute;
  background: #ffffff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2);
}

.rect-cursor-line.is-horizontal {
  left: 0;
  right: 0;
  top: 50%;
  height: 1.5px;
  transform: translateY(-50%);
}

.rect-cursor-line.is-vertical {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1.5px;
  transform: translateX(-50%);
}

.rect-cursor-core {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  border: 1.5px solid #ffffff;
  background: transparent;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18);
}

.rect-preview-box {
  position: absolute;
  border: 1px dashed rgba(59, 130, 246, 0.95);
  background: rgba(59, 130, 246, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4);
  pointer-events: none;
  z-index: 3;
}

.sam-prompt-marker {
  position: absolute;
  pointer-events: none;
  z-index: 5;
}

.sam-prompt-marker.is-point {
  width: 18px;
  height: 18px;
  transform: translate(-50%, -50%);
  border: 2px solid #f59e0b;
  border-radius: 999px;
  box-shadow:
    0 0 0 2px rgba(255, 255, 255, 0.9),
    0 4px 12px rgba(17, 24, 39, 0.32);
}

.sam-prompt-marker-core {
  position: absolute;
  inset: 4px;
  border-radius: inherit;
  background: currentColor;
}

.sam-prompt-marker.is-box {
  border: 2px dashed #f59e0b;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.68),
    0 4px 12px rgba(17, 24, 39, 0.28);
}

.selection-box {
  position: absolute;
  border: 1px dashed #f59e0b;
  box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.2);
  cursor: move;
  z-index: 2;
}

.selection-box.is-drawing {
  border-color: #3b82f6;
}

.selection-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 2px solid #f59e0b;
  border-radius: 999px;
}

.selection-handle.is-nw {
  top: -7px;
  left: -7px;
  cursor: nwse-resize;
}

.selection-handle.is-ne {
  top: -7px;
  right: -7px;
  cursor: nesw-resize;
}

.selection-handle.is-se {
  right: -7px;
  bottom: -7px;
  cursor: nwse-resize;
}

.selection-handle.is-sw {
  left: -7px;
  bottom: -7px;
  cursor: nesw-resize;
}
</style>
