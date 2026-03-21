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
      @pointermove="handlePreviewDrawMove"
      @pointerup="finishPreviewDraw"
      @pointerleave="handlePointerLeave"
    />

    <div
      v-if="cursorVisible"
      class="brush-cursor"
      :class="{ 'is-erase': videoStore.maskTool.mode === 'erase' }"
      :style="brushCursorStyle"
    ></div>

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
        @pointerdown.stop.prevent="startScale($event)"
      ></div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { useVideoManagerStore } from "src/stores/videoManager";
import {
  getMaskBoundsFromDataUrl,
  getTransformedBoundsRect,
  getVideoCenterAnchor,
  inverseTransformPointAroundAnchor,
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
  disabled: {
    type: Boolean,
    default: false,
  },
});

const videoStore = useVideoManagerStore();
const overlayCanvasRef = ref(null);
const assets = ref([]);
const editableCanvasRef = ref(null);
const editableCtxRef = ref(null);
const editableMaskId = ref(null);
const activeDrawingMaskId = ref(null);
const selectedState = ref(null);
const isPreviewDrawing = ref(false);
const previewLastPoint = ref(null);
const interactionState = ref(null);
const cursorPosition = ref({ x: 0, y: 0 });
const cursorInside = ref(false);

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

const selectedDisplayBox = computed(() => {
  if (!selectedAsset.value || !selectedState.value) return null;

  const bounds = getRenderableBounds(selectedAsset.value.bounds);
  const transformedRect = getTransformedBoundsRect(bounds, selectedState.value, videoAnchor.value);
  if (!transformedRect) return null;

  return {
    left: transformedRect.left * scaleX.value,
    top: transformedRect.top * scaleY.value,
    width: transformedRect.width * scaleX.value,
    height: transformedRect.height * scaleY.value,
    centerX: transformedRect.centerX,
    centerY: transformedRect.centerY,
  };
});

const overlayRootStyle = computed(() => ({
  width: `${safeDisplayWidth.value}px`,
  height: `${safeDisplayHeight.value}px`,
}));

const drawingEnabled = computed(
  () => videoStore.maskTool.drawingEnabled && selectedState.value && !props.disabled
);

const overlayCanvasStyle = computed(() => ({
  width: `${safeDisplayWidth.value}px`,
  height: `${safeDisplayHeight.value}px`,
  pointerEvents: drawingEnabled.value ? "auto" : "none",
  cursor: drawingEnabled.value ? "none" : "default",
}));

const cursorVisible = computed(() => drawingEnabled.value && cursorInside.value);

const hexToRgba = (hex, alpha) => {
  const normalized = String(hex || "#ffffff").replace("#", "");
  const safeHex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized.padEnd(6, "f").slice(0, 6);

  const r = Number.parseInt(safeHex.slice(0, 2), 16);
  const g = Number.parseInt(safeHex.slice(2, 4), 16);
  const b = Number.parseInt(safeHex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const brushCursorStyle = computed(() => {
  const size = Math.max(4, videoStore.maskTool.brushSize * displayScale.value);
  const isErase = videoStore.maskTool.mode === "erase";

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

const selectionBoxStyle = computed(() => {
  if (!selectedDisplayBox.value) return {};
  return {
    left: `${selectedDisplayBox.value.left}px`,
    top: `${selectedDisplayBox.value.top}px`,
    width: `${selectedDisplayBox.value.width}px`,
    height: `${selectedDisplayBox.value.height}px`,
    pointerEvents: props.disabled || videoStore.maskTool.drawingEnabled ? "none" : "auto",
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

const refreshAssets = async () => {
  const nextAssets = await Promise.all(
    videoStore.masks.map(async (mask) => {
      if (!mask.baseMaskDataUrl) {
        return {
          maskId: mask.id,
          image: null,
          bounds: null,
        };
      }

      const image = await loadImageElement(mask.baseMaskDataUrl);
      const bounds = await getMaskBoundsFromDataUrl(mask.baseMaskDataUrl);
      return {
        maskId: mask.id,
        image,
        bounds,
      };
    })
  );
  assets.value = nextAssets;
};

const getSourcePointFromEvent = (event) => {
  const rect = overlayCanvasRef.value.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * safeSourceWidth.value,
    y: ((event.clientY - rect.top) / rect.height) * safeSourceHeight.value,
  };
};

const updateCursorPosition = (event) => {
  const rect = overlayCanvasRef.value.getBoundingClientRect();
  cursorPosition.value = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
};

const getInverseTransformedPoint = (sourcePoint) => {
  if (!selectedAsset.value || !selectedState.value) return sourcePoint;
  return inverseTransformPointAroundAnchor(sourcePoint, selectedState.value, videoAnchor.value);
};

const drawBaseMaskLine = (from, to) => {
  const ctx = editableCtxRef.value;
  if (!ctx) return;

  ctx.save();
  if (videoStore.maskTool.mode === "erase") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = hexToRgba(videoStore.maskTool.brushColor, videoStore.maskTool.brushAlpha);
  }
  ctx.lineWidth = videoStore.maskTool.brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
};

const renderOverlay = () => {
  const canvas = overlayCanvasRef.value;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  videoStore.masks.forEach((mask) => {
    const asset = assets.value.find((item) => item.maskId === mask.id);
    if (!asset?.image) return;

    const state = videoStore.getMaskStateAtTime(mask.id, videoStore.currentTime);
    if (!state) return;

    const imageSource =
      mask.id === editableMaskId.value && editableCanvasRef.value ? editableCanvasRef.value : asset.image;

    ctx.save();
    ctx.globalAlpha = mask.id === videoStore.selectedMaskId ? 0.4 : 0.2;
    ctx.translate(videoAnchor.value.x + state.x, videoAnchor.value.y + state.y);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-videoAnchor.value.x, -videoAnchor.value.y);
    ctx.drawImage(imageSource, 0, 0, safeSourceWidth.value, safeSourceHeight.value);
    ctx.restore();
  });
};

const handlePointerEnter = (event) => {
  cursorInside.value = true;
  updateCursorPosition(event);
};

const startPreviewDraw = async (event) => {
  if (!drawingEnabled.value || !videoStore.selectedMask) {
    return;
  }

  updateCursorPosition(event);
  cursorInside.value = true;

  if (editableMaskId.value !== videoStore.selectedMask.id) {
    await ensureEditableCanvas();
  }

  const sourcePoint = getSourcePointFromEvent(event);
  const basePoint = getInverseTransformedPoint(sourcePoint);
  activeDrawingMaskId.value = videoStore.selectedMask.id;
  previewLastPoint.value = basePoint;
  drawBaseMaskLine(basePoint, basePoint);
  isPreviewDrawing.value = true;
  renderOverlay();
  event.preventDefault();
};

const handlePreviewDrawMove = (event) => {
  updateCursorPosition(event);
  cursorInside.value = true;

  if (!isPreviewDrawing.value || props.disabled) return;

  const sourcePoint = getSourcePointFromEvent(event);
  const basePoint = getInverseTransformedPoint(sourcePoint);
  drawBaseMaskLine(previewLastPoint.value, basePoint);
  previewLastPoint.value = basePoint;
  renderOverlay();
};

const finishPreviewDraw = () => {
  if (!isPreviewDrawing.value || !editableCanvasRef.value) return;
  isPreviewDrawing.value = false;
  previewLastPoint.value = null;
  if (activeDrawingMaskId.value === videoStore.selectedMaskId) {
    videoStore.commitSelectedMaskBaseMask(editableCanvasRef.value.toDataURL("image/png"));
  } else if (activeDrawingMaskId.value) {
    videoStore.commitMaskBaseMask(
      activeDrawingMaskId.value,
      editableCanvasRef.value.toDataURL("image/png")
    );
  }
  activeDrawingMaskId.value = null;
};

const handlePointerLeave = () => {
  cursorInside.value = false;
  finishPreviewDraw();
};

const startMove = (event) => {
  if (
    props.disabled ||
    videoStore.maskTool.drawingEnabled ||
    !selectedDisplayBox.value ||
    !selectedState.value
  ) {
    return;
  }

  const keyframe = videoStore.ensureTransformKeyframeAtCurrentTime(videoStore.selectedMaskId);
  if (!keyframe) return;

  interactionState.value = {
    type: "move",
    startPointer: getSourcePointFromEvent(event),
    startX: keyframe.x,
    startY: keyframe.y,
    keyframeId: keyframe.id,
  };
  window.addEventListener("pointermove", handleInteractionMove);
  window.addEventListener("pointerup", finishInteraction);
};

const startScale = (event) => {
  if (
    props.disabled ||
    videoStore.maskTool.drawingEnabled ||
    !selectedDisplayBox.value ||
    !selectedState.value
  ) {
    return;
  }

  const keyframe = videoStore.ensureTransformKeyframeAtCurrentTime(videoStore.selectedMaskId);
  if (!keyframe) return;

  const pointer = getSourcePointFromEvent(event);
  const distance = Math.max(
    0.0001,
    Math.hypot(
      pointer.x - selectedDisplayBox.value.centerX,
      pointer.y - selectedDisplayBox.value.centerY
    )
  );

  interactionState.value = {
    type: "scale",
    centerX: selectedDisplayBox.value.centerX,
    centerY: selectedDisplayBox.value.centerY,
    startDistance: distance,
    startScale: keyframe.scale,
    keyframeId: keyframe.id,
  };
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
      scale: videoStore.selectedKeyframe?.scale ?? selectedState.value?.scale ?? 1,
    });
  } else if (interactionState.value.type === "scale") {
    const pointer = getSourcePointFromEvent(event);
    const distance = Math.max(
      0.0001,
      Math.hypot(
        pointer.x - interactionState.value.centerX,
        pointer.y - interactionState.value.centerY
      )
    );
    videoStore.upsertKeyframe(videoStore.selectedMaskId, {
      id: interactionState.value.keyframeId,
      x: videoStore.selectedKeyframe?.x ?? selectedState.value?.x ?? 0,
      y: videoStore.selectedKeyframe?.y ?? selectedState.value?.y ?? 0,
      scale: Math.max(
        0.05,
        interactionState.value.startScale * (distance / interactionState.value.startDistance)
      ),
    });
  }
};

const finishInteraction = () => {
  interactionState.value = null;
  window.removeEventListener("pointermove", handleInteractionMove);
  window.removeEventListener("pointerup", finishInteraction);
};

watch(
  () => [
    videoStore.masks.map((mask) => `${mask.id}:${mask.baseMaskDataUrl}`).join("|"),
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
          ...(mask.keyframes || []).map(
            (keyframe) =>
              `${keyframe.id}:${keyframe.time}:${keyframe.x}:${keyframe.y}:${keyframe.scale}`
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
  () => [videoStore.maskTool.brushColor, videoStore.maskTool.brushAlpha, videoStore.maskTool.brushSize],
  () => {
    if (!cursorInside.value) return;
    renderOverlay();
  }
);

onMounted(() => {
  refreshSelectedState();
  renderOverlay();
});

onUnmounted(() => {
  finishInteraction();
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
