<template>
  <div v-if="show" ref="rootRef" class="absolute inset-0">
    <canvas
      ref="maskCanvas"
      class="absolute"
      :class="{
        'cursor-none': effectiveDrawingEnabled && cursorPosition && !isToolbarInteracting,
        'cursor-grab': !effectiveDrawingEnabled && !isToolbarInteracting,
      }"
      :style="{
        width: `${store.imageWidth}px`,
        height: `${store.imageHeight}px`,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        left: `${store.offsetX}px`,
        top: `${store.offsetY}px`,
        pointerEvents: effectiveDrawingEnabled ? 'auto' : 'none',
        opacity: maskVisible ? 1 : 0,
        transition: 'opacity 0.15s ease',
      }"
      @pointerdown="handleCanvasPointerDown"
      @pointermove="handleCanvasPointerMove"
      @pointerleave="handleCanvasPointerLeave"
    ></canvas>

    <div
      v-if="showCustomCursor && currentToolMode !== MASK_TOOL_MODES.RECT"
      class="absolute pointer-events-none custom-cursor"
      :class="{ 'is-erase': currentToolMode === MASK_TOOL_MODES.ERASE }"
      :style="brushCursorStyle"
    ></div>

    <div
      v-if="showCustomCursor && currentToolMode === MASK_TOOL_MODES.RECT"
      class="absolute pointer-events-none rect-cursor"
      :style="rectCursorStyle"
    >
      <span class="rect-cursor-line is-horizontal"></span>
      <span class="rect-cursor-line is-vertical"></span>
    </div>

    <div
      v-if="rectPreviewStyle && effectiveDrawingEnabled"
      class="rect-operation-preview"
      :style="rectPreviewStyle"
    ></div>

    <div
      v-show="showToolbar"
      ref="toolbarRef"
      class="absolute toolbar-container mask-toolbar-region app-floating-toolbar"
      :style="{
        left: `${toolbarPosition.x}px`,
        top: `${toolbarPosition.y}px`,
        zIndex: 1001,
        ...floatingToolbarShellStyle,
      }"
      @mousedown.stop
      @pointerdown.stop
      @pointerenter="setToolbarPointerRegionState(true)"
    >
      <div
        class="toolbar-handle bg-primary text-white text-center text-xs py-1 cursor-move"
        @mousedown.stop="startDragToolbar"
        @pointerdown.stop
      >
        绘制工具拖动区域
      </div>

      <q-bar
        class="q-px-md rounded-b-pill app-floating-toolbar-bar"
        :style="floatingToolbarBarStyle"
      >
        <MaskBrushControls
          :drawing-enabled="drawingModeActive"
          :mode="currentToolMode"
          :brush-size="brushSize"
          :brush-color="brushColor"
          :brush-alpha="brushAlpha"
          :can-undo="canUndo"
          :button-size="toolbarButtonSize"
          :content-class="toolbarPopupClass"
          :popup-anchor="settingsPopupAnchor"
          :popup-self="settingsPopupSelf"
          :transition-show="settingsPopupTransitionShow"
          :transition-hide="settingsPopupTransitionHide"
          @toggle-drawing="toggleDrawing"
          @update:mode="updateToolMode"
          @update:brush-size="updateBrushSize"
          @update:brush-color="updateBrushColor"
          @update:brush-alpha="updateBrushAlpha"
          @undo="undo"
          @clear="clearCanvas"
        >
          <template #after="{ buttonSize, textColor }">
            <q-btn-group flat class="toolbar-side-actions">
              <q-btn
                icon="center_focus_strong"
                :size="buttonSize"
                :text-color="textColor"
                @click="resetView"
              >
                <q-tooltip>重置视图</q-tooltip>
              </q-btn>
              <q-btn
                icon="visibility_off"
                :size="buttonSize"
                :text-color="textColor"
                @mousedown="toggleMaskVisibility(false)"
                @mouseup="toggleMaskVisibility(true)"
                @mouseleave="toggleMaskVisibility(true)"
              >
                <q-tooltip>按住隐藏蒙版</q-tooltip>
              </q-btn>
            </q-btn-group>
          </template>
        </MaskBrushControls>
      </q-bar>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useQuasar } from "quasar";

import MaskBrushControls from "src/components/common/MaskBrushControls.vue";
import { useRasterMaskEditor } from "src/composables/useRasterMaskEditor";
import {
  DEFAULT_IMAGE_BRUSH,
  normalizeBrushConfig,
  normalizeButtonSize,
} from "src/config/ConfigManager";
import { useConfigStore } from "src/stores/config";
import {
  MASK_TOOL_MODES,
  hexToRgba,
  normalizeMaskToolMode,
  normalizeMaskToolUiState,
} from "src/utils/maskTool";
import {
  clampBoxToViewport,
  computeAnchoredPlacement,
  resolveViewportRect,
} from "src/utils/viewportPlacement";
import { useEditorStore } from "src/stores/editor";

const editor = inject("image-editor", { value: null });
const configStore = useConfigStore();
const $q = useQuasar();

const props = defineProps({
  scale: {
    type: Number,
    required: true,
  },
  show: {
    type: Boolean,
    required: true,
  },
  showToolbar: {
    type: Boolean,
    default: true,
  },
  mask: {
    type: Object,
    default: null,
  },
  drawingMode: {
    type: Boolean,
    default: false,
  },
  toolState: {
    type: Object,
    default: () => ({
      mode: MASK_TOOL_MODES.DRAW,
      brushSize: DEFAULT_IMAGE_BRUSH.size,
      brushColor: DEFAULT_IMAGE_BRUSH.color,
      brushAlpha: DEFAULT_IMAGE_BRUSH.alpha,
      toolbarState: {
        manual: false,
        position: null,
      },
    }),
  },
  visibleAreaInsets: {
    type: Object,
    default: () => ({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    }),
  },
});

const emit = defineEmits([
  "update:mask",
  "update:drawing-mode",
  "update:ctrl-pressed",
  "update:tool-state",
  "update:toolbar-interacting",
]);

const store = useEditorStore();
const rootRef = ref(null);
const toolbarRef = ref(null);
const maskCanvas = ref(null);
const ctx = ref(null);
const brushSize = ref(DEFAULT_IMAGE_BRUSH.size);
const brushColor = ref(DEFAULT_IMAGE_BRUSH.color);
const brushAlpha = ref(DEFAULT_IMAGE_BRUSH.alpha);
const toolMode = ref(MASK_TOOL_MODES.DRAW);
const isCtrlPressed = ref(false);
const cursorPosition = ref(null);
const history = ref([]);
const historyIndex = ref(-1);
const canUndo = ref(false);
const operationStartIndices = ref([0]);
const toolbarPosition = ref({ x: 20, y: 20 });
const isDraggingToolbar = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const hasManualToolbarPosition = ref(false);
const maskVisible = ref(true);
const pendingMaskSyncDataUrl = ref("");
const rectPreview = ref(null);
const isDrawingWindowBound = ref(false);
const toolbarPopupClass = "mask-toolbar-popup";
const isToolbarPointerRegionActive = ref(false);

const drawingModeActive = computed(() => Boolean(props.drawingMode));
const effectiveDrawingEnabled = computed(
  () => Boolean(props.show) && (drawingModeActive.value || isCtrlPressed.value)
);
const currentToolMode = computed(() => normalizeMaskToolMode(toolMode.value));
const isToolbarInteracting = computed(
  () => Boolean(props.showToolbar) && (isDraggingToolbar.value || isToolbarPointerRegionActive.value)
);
const showCustomCursor = computed(
  () => effectiveDrawingEnabled.value && Boolean(cursorPosition.value) && !isToolbarInteracting.value
);
const toolbarButtonSize = computed(() =>
  normalizeButtonSize(configStore.config.ui?.buttonSize)
);
const floatingToolbarShellStyle = computed(() => ({
  borderColor: $q.dark.isActive
    ? "rgba(255, 255, 255, 0.1)"
    : "rgba(17, 24, 39, 0.08)",
  background: $q.dark.isActive ? "rgba(24, 24, 27, 0.94)" : "rgba(255, 255, 255, 0.92)",
  color: $q.dark.isActive ? "rgba(244, 244, 245, 0.94)" : "rgba(17, 24, 39, 0.9)",
}));
const floatingToolbarBarStyle = computed(() => ({
  background: "transparent",
  color: $q.dark.isActive ? "rgba(244, 244, 245, 0.94)" : "rgba(17, 24, 39, 0.9)",
}));

const getBrushDefaults = () =>
  normalizeBrushConfig(configStore.config.advanced?.imageBrushDefault, DEFAULT_IMAGE_BRUSH);

const normalizeToolState = (value = props.toolState) =>
  normalizeMaskToolUiState(value, getBrushDefaults());

const brushCursorStyle = computed(() => {
  const size = Math.max(6, Number(brushSize.value || 0));
  const isErase = currentToolMode.value === MASK_TOOL_MODES.ERASE;

  return {
    width: `${size}px`,
    height: `${size}px`,
    left: `${cursorPosition.value?.x || 0}px`,
    top: `${cursorPosition.value?.y || 0}px`,
    backgroundColor: isErase
      ? "rgba(255, 255, 255, 0.95)"
      : hexToRgba(brushColor.value, brushAlpha.value),
    border: isErase
      ? "1px solid rgba(17, 24, 39, 0.68)"
      : "1px solid rgba(255, 255, 255, 0.9)",
    transform: "translate(-50%, -50%)",
  };
});

const rectCursorStyle = computed(() => ({
  left: `${cursorPosition.value?.x || 0}px`,
  top: `${cursorPosition.value?.y || 0}px`,
}));

const rectPreviewStyle = computed(() => {
  if (!rectPreview.value || !maskCanvas.value) return null;

  return {
    left: `${store.offsetX + rectPreview.value.x * props.scale}px`,
    top: `${store.offsetY + rectPreview.value.y * props.scale}px`,
    width: `${rectPreview.value.width * props.scale}px`,
    height: `${rectPreview.value.height * props.scale}px`,
    borderColor: hexToRgba(brushColor.value, Math.max(0.3, brushAlpha.value)),
    background: hexToRgba(brushColor.value, brushAlpha.value),
  };
});

const getToolbarViewport = ({ respectInsets = false } = {}) => {
  const rootEl = rootRef.value;
  const toolbarEl = toolbarRef.value;
  if (!rootEl || !toolbarEl) return null;

  return {
    ...resolveViewportRect({
      containerWidth: rootEl.clientWidth,
      containerHeight: rootEl.clientHeight,
      insets: props.visibleAreaInsets,
      respectInsets,
    }),
    toolbarWidth: toolbarEl.offsetWidth || 0,
    toolbarHeight: toolbarEl.offsetHeight || 0,
  };
};

const toolbarShouldOpenUpward = computed(() => {
  const viewport = getToolbarViewport();
  const toolbarEl = toolbarRef.value;
  if (!viewport || !toolbarEl) return true;

  const centerY = toolbarPosition.value.y + (toolbarEl.offsetHeight || 0) / 2;
  return centerY > viewport.centerY;
});

const settingsPopupAnchor = computed(() =>
  toolbarShouldOpenUpward.value ? "top middle" : "bottom middle"
);
const settingsPopupSelf = computed(() =>
  toolbarShouldOpenUpward.value ? "bottom middle" : "top middle"
);
const settingsPopupTransitionShow = computed(() =>
  toolbarShouldOpenUpward.value ? "jump-up" : "jump-down"
);
const settingsPopupTransitionHide = computed(() =>
  toolbarShouldOpenUpward.value ? "jump-down" : "jump-up"
);

let rasterMaskEditor;
const syncRectPreview = () => {
  rectPreview.value = rasterMaskEditor.rectPreview.value;
};

rasterMaskEditor = useRasterMaskEditor({
  canvasRef: maskCanvas,
  ctxRef: ctx,
  getTool: () => ({
    mode: currentToolMode.value,
    brushColor: brushColor.value,
    brushAlpha: brushAlpha.value,
    brushSize: Math.max(1, Number(brushSize.value || 1) / Math.max(0.0001, props.scale)),
  }),
  onPreviewChange: syncRectPreview,
});

const isElementWithinToolbarRegion = (target) =>
  target instanceof HTMLElement &&
  Boolean(target.closest(".mask-toolbar-region") || target.closest(`.${toolbarPopupClass}`));

const isEventWithinToolbarRegion = (event) => {
  if (isElementWithinToolbarRegion(event?.target)) {
    return true;
  }

  const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
  return path.some((target) => isElementWithinToolbarRegion(target));
};

const setToolbarPointerRegionState = (value) => {
  isToolbarPointerRegionActive.value = Boolean(value);
};

const syncToolbarPointerRegionState = (event) => {
  setToolbarPointerRegionState(isEventWithinToolbarRegion(event));
};

const cloneImageData = (imageData) =>
  new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);

const saveInitialState = () => {
  const canvas = maskCanvas.value;
  if (!canvas || !ctx.value || canvas.width <= 0 || canvas.height <= 0) return;

  history.value = [];
  historyIndex.value = -1;
  operationStartIndices.value = [0];

  const initialState = ctx.value.getImageData(0, 0, canvas.width, canvas.height);
  history.value.push(initialState);
  historyIndex.value = 0;
  operationStartIndices.value = [0];
  pendingMaskSyncDataUrl.value = "";
  updateCanUndoRedo();
};

const normalizeMaskDataUrl = (mask) => {
  if (!mask) return "";
  if (typeof mask === "string") return mask;
  if (mask instanceof ImageData) return null;
  if (typeof mask.displayUrl === "string" && mask.displayUrl) {
    return mask.displayUrl;
  }
  if (typeof mask.data === "string" && mask.data) {
    return mask.data.startsWith("data:")
      ? mask.data
      : `data:image/png;base64,${mask.data}`;
  }
  return "";
};

const initCanvas = () => {
  const canvas = maskCanvas.value;
  if (!canvas || !store.imageWidth || !store.imageHeight) return;

  canvas.width = store.imageWidth;
  canvas.height = store.imageHeight;
  ctx.value = canvas.getContext("2d", { willReadFrequently: true });
  ctx.value.globalCompositeOperation = "source-over";
  ctx.value.clearRect(0, 0, canvas.width, canvas.height);

  if (!props.mask) {
    saveInitialState();
    return;
  }

  if (props.mask instanceof ImageData) {
    ctx.value.putImageData(props.mask, 0, 0);
    saveInitialState();
    return;
  }

  if (props.mask.data && typeof props.mask.data === "string") {
    const img = new Image();
    img.onload = () => {
      ctx.value.clearRect(0, 0, canvas.width, canvas.height);
      ctx.value.drawImage(img, 0, 0, canvas.width, canvas.height);
      saveInitialState();
    };
    img.onerror = () => {
      console.error("加载蒙版图像失败");
      ctx.value.clearRect(0, 0, canvas.width, canvas.height);
      saveInitialState();
    };

    if (props.mask.type === "path" && props.mask.displayUrl) {
      img.src = props.mask.displayUrl;
    } else if (props.mask.type === "base64") {
      img.src = props.mask.data.startsWith("data:")
        ? props.mask.data
        : `data:image/png;base64,${props.mask.data}`;
    } else {
      img.src = props.mask.data;
    }
    return;
  }

  saveInitialState();
};

const toggleMaskVisibility = (visible) => {
  maskVisible.value = visible;
};

const getMaskData = () => maskCanvas.value?.toDataURL("image/png") || "";

const emitMask = () => {
  if (!ctx.value || !maskCanvas.value) return;

  const dataUrl = maskCanvas.value.toDataURL("image/png");
  pendingMaskSyncDataUrl.value = dataUrl;
  emit("update:mask", {
    data: dataUrl,
    width: maskCanvas.value.width,
    height: maskCanvas.value.height,
  });
};

const updateCanUndoRedo = () => {
  canUndo.value = historyIndex.value > operationStartIndices.value[0];
};

const appendHistorySnapshot = (imageData) => {
  if (!imageData) return;

  if (historyIndex.value < history.value.length - 1) {
    history.value.splice(historyIndex.value + 1);
    operationStartIndices.value = operationStartIndices.value.filter(
      (index) => index <= historyIndex.value
    );
  }

  const newIndex = history.value.length;
  operationStartIndices.value.push(newIndex);
  history.value.push(cloneImageData(imageData));
  historyIndex.value = history.value.length - 1;
  updateCanUndoRedo();
};

const getCanvasPoint = (event) => {
  if (!maskCanvas.value) return null;
  const rect = maskCanvas.value.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / props.scale,
    y: (event.clientY - rect.top) / props.scale,
  };
};

const updateCursorPosition = (event) => {
  cursorPosition.value = {
    x: event.clientX,
    y: event.clientY,
  };
};

const detachDrawingWindowListeners = () => {
  if (!isDrawingWindowBound.value) return;
  window.removeEventListener("pointermove", handleWindowPointerMove, true);
  window.removeEventListener("pointerup", handleWindowPointerUp, true);
  isDrawingWindowBound.value = false;
};

const finishCurrentOperation = (event = null) => {
  const result = rasterMaskEditor.finishOperation(event ? getCanvasPoint(event) : null);
  rectPreview.value = null;
  detachDrawingWindowListeners();
  if (result.changed) {
    appendHistorySnapshot(result.imageData);
    emitMask();
  }
};

const cancelCurrentOperation = () => {
  rasterMaskEditor.cancelOperation();
  rectPreview.value = null;
  detachDrawingWindowListeners();
};

const handleWindowPointerMove = (event) => {
  if (!rasterMaskEditor.isOperating.value) return;
  updateCursorPosition(event);
  rasterMaskEditor.updateOperation(getCanvasPoint(event));
  event.preventDefault();
};

const handleWindowPointerUp = (event) => {
  if (!rasterMaskEditor.isOperating.value) {
    detachDrawingWindowListeners();
    return;
  }

  updateCursorPosition(event);
  finishCurrentOperation(event);
  event.preventDefault();
};

const handleCanvasPointerDown = (event) => {
  if (event.button !== 0 || !effectiveDrawingEnabled.value || !maskCanvas.value || !ctx.value) {
    return;
  }

  updateCursorPosition(event);
  const result = rasterMaskEditor.beginOperation(getCanvasPoint(event));
  rectPreview.value = rasterMaskEditor.rectPreview.value;
  if (!result.started) return;

  detachDrawingWindowListeners();
  window.addEventListener("pointermove", handleWindowPointerMove, true);
  window.addEventListener("pointerup", handleWindowPointerUp, true);
  isDrawingWindowBound.value = true;
  event.preventDefault();
  event.stopPropagation();
};

const handleCanvasPointerMove = (event) => {
  updateCursorPosition(event);
};

const handleCanvasPointerLeave = () => {
  if (!rasterMaskEditor.isOperating.value) {
    cursorPosition.value = null;
  }
};

const updateToolMode = (value) => {
  const nextMode = normalizeMaskToolMode(value);
  if (toolMode.value === nextMode) return;
  toolMode.value = nextMode;
  emitToolState();
};

const updateBrushSize = (value) => {
  const nextSize = Math.max(1, Math.round(Number(value || 1)));
  if (brushSize.value === nextSize) return;
  brushSize.value = nextSize;
  emitToolState();
};

const updateBrushColor = (value) => {
  const normalized = normalizeBrushConfig(
    { color: value, size: brushSize.value, alpha: brushAlpha.value },
    getBrushDefaults()
  );
  if (brushColor.value === normalized.color) return;
  brushColor.value = normalized.color;
  emitToolState();
};

const updateBrushAlpha = (value) => {
  const normalized = normalizeBrushConfig(
    { color: brushColor.value, size: brushSize.value, alpha: value },
    getBrushDefaults()
  );
  if (brushAlpha.value === normalized.alpha) return;
  brushAlpha.value = normalized.alpha;
  emitToolState();
};

const toggleDrawing = () => {
  const nextValue = !drawingModeActive.value;
  if (!nextValue && !isCtrlPressed.value && rasterMaskEditor.isOperating.value) {
    finishCurrentOperation();
  }
  emit("update:drawing-mode", nextValue);
};

const getCurrentToolbarState = () => ({
  manual: hasManualToolbarPosition.value,
  position: hasManualToolbarPosition.value
    ? {
        x: toolbarPosition.value.x,
        y: toolbarPosition.value.y,
      }
    : null,
});

const isSameToolbarState = (left, right) => {
  const leftManual = Boolean(left?.manual);
  const rightManual = Boolean(right?.manual);
  if (leftManual !== rightManual) return false;
  if (!leftManual && !rightManual) return true;

  return (
    Number(left?.position?.x) === Number(right?.position?.x) &&
    Number(left?.position?.y) === Number(right?.position?.y)
  );
};

const getCurrentToolState = () =>
  normalizeToolState({
    mode: toolMode.value,
    brushSize: brushSize.value,
    brushColor: brushColor.value,
    brushAlpha: brushAlpha.value,
    toolbarState: getCurrentToolbarState(),
  });

const isSameToolState = (left, right) => {
  const normalizedLeft = normalizeToolState(left);
  const normalizedRight = normalizeToolState(right);

  return (
    normalizedLeft.mode === normalizedRight.mode &&
    normalizedLeft.brushSize === normalizedRight.brushSize &&
    normalizedLeft.brushColor === normalizedRight.brushColor &&
    normalizedLeft.brushAlpha === normalizedRight.brushAlpha &&
    isSameToolbarState(normalizedLeft.toolbarState, normalizedRight.toolbarState)
  );
};

const emitToolState = () => {
  const nextState = getCurrentToolState();
  if (isSameToolState(nextState, props.toolState)) {
    return;
  }

  emit("update:tool-state", nextState);
};

const resetView = async () => {
  hasManualToolbarPosition.value = false;
  if (editor?.value) {
    await editor.value.resetView();
  } else {
    store.resetView();
  }

  nextTick(() => {
    syncToolbarPosition();
    emitToolState();
  });
};

const undo = () => {
  if (historyIndex.value <= 0 || !ctx.value) return;

  let currentOpIndex = 0;
  for (let index = operationStartIndices.value.length - 1; index >= 0; index -= 1) {
    if (operationStartIndices.value[index] <= historyIndex.value) {
      currentOpIndex = index;
      break;
    }
  }

  const previousOpIndex = Math.max(0, currentOpIndex - 1);
  const targetIndex = operationStartIndices.value[previousOpIndex];
  if (targetIndex < 0 || targetIndex >= history.value.length) return;

  operationStartIndices.value = operationStartIndices.value.filter((index) => index <= targetIndex);
  historyIndex.value = targetIndex;
  ctx.value.putImageData(history.value[historyIndex.value], 0, 0);
  updateCanUndoRedo();
  emitMask();
};

const clearCanvas = () => {
  if (!ctx.value || !maskCanvas.value) return;

  cancelCurrentOperation();
  ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
  appendHistorySnapshot(ctx.value.getImageData(0, 0, maskCanvas.value.width, maskCanvas.value.height));
  emitMask();
};

const updateMask = (newMask) => {
  if (!ctx.value || !maskCanvas.value) return;

  cancelCurrentOperation();

  if (!newMask) {
    ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
    saveInitialState();
    return;
  }

  if (newMask instanceof ImageData) {
    ctx.value.putImageData(newMask, 0, 0);
    saveInitialState();
    return;
  }

  if (newMask.data && typeof newMask.data === "string") {
    const img = new Image();
    img.onload = () => {
      ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
      ctx.value.drawImage(img, 0, 0, maskCanvas.value.width, maskCanvas.value.height);
      saveInitialState();
    };
    img.onerror = () => {
      console.error("加载蒙版图像失败");
      ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
      saveInitialState();
    };
    img.src = newMask.displayUrl || newMask.data;
  }
};

const clampToolbarPosition = (position, { respectInsets = false } = {}) => {
  const viewport = getToolbarViewport({ respectInsets });
  if (!viewport) return position;

  return clampBoxToViewport({
    x: position.x,
    y: position.y,
    boxWidth: viewport.toolbarWidth,
    boxHeight: viewport.toolbarHeight,
    viewport,
    margin: 20,
  });
};

const setDefaultToolbarPosition = () => {
  const viewport = getToolbarViewport({ respectInsets: true });
  if (!viewport) return;

  const placement = computeAnchoredPlacement({
    boxWidth: viewport.toolbarWidth,
    boxHeight: viewport.toolbarHeight,
    viewport,
    alignX: "center",
    alignY: "bottom",
    margin: 20,
  });
  if (!placement) return;

  toolbarPosition.value = clampToolbarPosition(placement, {
    respectInsets: true,
  });
};

const syncToolbarPosition = () => {
  if (!toolbarRef.value || !rootRef.value) return;

  if (hasManualToolbarPosition.value) {
    toolbarPosition.value = clampToolbarPosition(toolbarPosition.value);
    return;
  }

  setDefaultToolbarPosition();
};

const restoreToolbarState = () => {
  if (!toolbarRef.value || !rootRef.value) return;

  const toolbarState = normalizeToolState().toolbarState;

  if (
    toolbarState.manual &&
    Number.isFinite(toolbarState.position?.x) &&
    Number.isFinite(toolbarState.position?.y)
  ) {
    hasManualToolbarPosition.value = true;
    toolbarPosition.value = clampToolbarPosition(toolbarState.position);
    emitToolState();
    return;
  }

  hasManualToolbarPosition.value = false;
  syncToolbarPosition();
  emitToolState();
};

const startDragToolbar = (event) => {
  event.stopPropagation();
  event.preventDefault();

  hasManualToolbarPosition.value = true;
  isDraggingToolbar.value = true;
  dragOffset.value = {
    x: event.clientX - toolbarPosition.value.x,
    y: event.clientY - toolbarPosition.value.y,
  };

  document.addEventListener("mousemove", moveToolbar, {
    capture: true,
    passive: false,
  });
  document.addEventListener("mouseup", stopDragToolbar, { capture: true });
};

const moveToolbar = (event) => {
  if (!isDraggingToolbar.value) return;

  event.stopPropagation();
  event.preventDefault();

  toolbarPosition.value = clampToolbarPosition({
    x: event.clientX - dragOffset.value.x,
    y: event.clientY - dragOffset.value.y,
  });
};

const stopDragToolbar = (event) => {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }

  isDraggingToolbar.value = false;
  document.removeEventListener("mousemove", moveToolbar, { capture: true });
  document.removeEventListener("mouseup", stopDragToolbar, { capture: true });
  emitToolState();
};

const applyToolState = (value = props.toolState) => {
  const normalized = normalizeToolState(value);
  toolMode.value = normalized.mode;
  brushSize.value = normalized.brushSize;
  brushColor.value = normalized.brushColor;
  brushAlpha.value = normalized.brushAlpha;
  return normalized;
};

onMounted(() => {
  if (props.show) {
    initCanvas();
  }

  nextTick(() => {
    applyToolState();
    restoreToolbarState();
  });
});

onUnmounted(() => {
  document.removeEventListener("mousemove", moveToolbar, { capture: true });
  document.removeEventListener("mouseup", stopDragToolbar, { capture: true });
  detachDrawingWindowListeners();
});

useEventListener(window, "keydown", (event) => {
  if (!props.show) return;

  if (event.key === "z" && event.ctrlKey && !event.shiftKey) {
    event.preventDefault();
    undo();
  } else if (event.key === "b") {
    event.preventDefault();
    toggleDrawing();
  } else if (event.key === "Control") {
    isCtrlPressed.value = true;
    emit("update:ctrl-pressed", true);
  }
});

useEventListener(window, "keyup", (event) => {
  if (event.key !== "Control") return;

  isCtrlPressed.value = false;
  emit("update:ctrl-pressed", false);
  if (!drawingModeActive.value && rasterMaskEditor.isOperating.value) {
    finishCurrentOperation();
  }
});

useEventListener(window, "mousemove", (event) => {
  if (effectiveDrawingEnabled.value && !isToolbarInteracting.value) {
    cursorPosition.value = {
      x: event.clientX,
      y: event.clientY,
    };
  }
});

useEventListener(window, "pointermove", syncToolbarPointerRegionState, {
  passive: true,
  capture: true,
});
useEventListener(window, "pointerdown", syncToolbarPointerRegionState, {
  passive: true,
  capture: true,
});
useEventListener(window, "pointerup", syncToolbarPointerRegionState, {
  passive: true,
  capture: true,
});
useEventListener(window, "blur", () => {
  setToolbarPointerRegionState(false);
  if (rasterMaskEditor.isOperating.value) {
    finishCurrentOperation();
  }
});

useEventListener(window, "resize", () => {
  nextTick(() => {
    syncToolbarPosition();
    emitToolState();
  });
});

watch(
  [() => store.offsetX, () => store.offsetY, () => store.scale, () => store.imageWidth, () => store.imageHeight],
  async () => {
    if (!props.show || !maskCanvas.value) return;
    const canvas = maskCanvas.value;
    Object.assign(canvas.style, {
      left: `${store.offsetX}px`,
      top: `${store.offsetY}px`,
      transform: `scale(${store.scale})`,
    });

    if (canvas.width !== store.imageWidth || canvas.height !== store.imageHeight) {
      initCanvas();
    }

    await nextTick();
    syncToolbarPosition();
    emitToolState();
  },
  { immediate: true }
);

watch(
  () => props.mask,
  (newMask) => {
    if (!props.show || !ctx.value) return;
    const nextMaskDataUrl = normalizeMaskDataUrl(newMask);
    const currentMaskDataUrl = getMaskData();
    if (nextMaskDataUrl && nextMaskDataUrl === pendingMaskSyncDataUrl.value) {
      pendingMaskSyncDataUrl.value = "";
      return;
    }
    if (nextMaskDataUrl && nextMaskDataUrl === currentMaskDataUrl) {
      pendingMaskSyncDataUrl.value = "";
      return;
    }
    pendingMaskSyncDataUrl.value = "";
    updateMask(newMask);
  },
  { deep: true }
);

watch(
  () => props.drawingMode,
  (enabled) => {
    if (!enabled && !isCtrlPressed.value && rasterMaskEditor.isOperating.value) {
      finishCurrentOperation();
    }
  }
);

watch(
  effectiveDrawingEnabled,
  (enabled) => {
    if (!enabled) {
      cursorPosition.value = null;
    }
  },
  { immediate: true }
);

watch(
  isToolbarInteracting,
  (value) => {
    emit("update:toolbar-interacting", value);
  },
  { immediate: true }
);

watch(
  () => props.showToolbar,
  (visible) => {
    if (!visible) {
      setToolbarPointerRegionState(false);
    }
  }
);

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      nextTick(() => {
        initCanvas();
        applyToolState();
        restoreToolbarState();
      });
      return;
    }

    cancelCurrentOperation();
  }
);

watch(
  () => props.toolState,
  async () => {
    await nextTick();
    applyToolState();
    restoreToolbarState();
  },
  { deep: true }
);

defineExpose({
  updateMask,
  getMaskData,
});
</script>

<style scoped>
.cursor-none {
  cursor: none !important;
  z-index: 10;
}

.cursor-grab {
  cursor: grab !important;
  z-index: 10;
}

.custom-cursor {
  position: fixed !important;
  pointer-events: none !important;
  z-index: 999 !important;
  border-radius: 50%;
}

.custom-cursor.is-erase {
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.28);
}

.rect-cursor {
  position: fixed !important;
  width: 26px;
  height: 26px;
  transform: translate(-50%, -50%);
  pointer-events: none !important;
  z-index: 999 !important;
  mix-blend-mode: difference;
}

.rect-cursor-line {
  position: absolute;
  background: #ffffff;
  border-radius: 999px;
}

.rect-cursor-line.is-horizontal {
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
}

.rect-cursor-line.is-vertical {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
}

.rect-operation-preview {
  position: absolute;
  z-index: 998;
  border: 1px dashed rgba(59, 130, 246, 0.95);
  background: rgba(59, 130, 246, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.38);
  pointer-events: none;
}

.toolbar-container {
  z-index: 1001 !important;
  pointer-events: auto !important;
  position: absolute !important;
  touch-action: none;
  user-select: none;
  overflow: visible;
  width: max-content;
  max-width: none;
}

.toolbar-handle {
  cursor: move !important;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  letter-spacing: 0.02em;
}

.app-floating-toolbar {
  border-radius: 20px !important;
  border: 1px solid rgba(17, 24, 39, 0.08);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  background: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .app-floating-toolbar {
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
  background: rgba(24, 24, 27, 0.88);
}

.rounded-b-pill {
  border-bottom-left-radius: 20px !important;
  border-bottom-right-radius: 20px !important;
}

.app-floating-toolbar-bar {
  border: none !important;
  background: transparent !important;
  min-height: 54px;
}

.toolbar-side-actions :deep(.q-btn) {
  color: rgba(17, 24, 39, 0.88);
}

:global(body.body--dark) .toolbar-side-actions :deep(.q-btn) {
  color: rgba(244, 244, 245, 0.94);
}
</style>
