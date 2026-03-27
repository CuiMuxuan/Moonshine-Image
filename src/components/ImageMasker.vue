<template>
  <div v-if="show" ref="rootRef" class="absolute inset-0">
    <canvas
      ref="maskCanvas"
      class="absolute"
      :class="{
          'cursor-none': (drawingModeActive || isCtrlPressed) && cursorPosition && !isToolbarInteracting,
          'cursor-grab': !drawingModeActive && !isCtrlPressed && !isToolbarInteracting,
      }"
      :style="{
        width: `${store.imageWidth}px`,
        height: `${store.imageHeight}px`,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        left: `${store.offsetX}px`,
        top: `${store.offsetY}px`,
        pointerEvents: drawingModeActive || isCtrlPressed ? 'auto' : 'none',
        opacity: maskVisible ? brushAlpha : 0,
        transition: 'opacity 0.15s ease',
      }"
      @pointerdown="onPointerDown"
      @pointermove="handlePointerMove"
      @pointerup="stopDrawing"
      @pointerout="handlePointerOut"
    ></canvas>

    <div
      v-if="(drawingModeActive || isCtrlPressed) && cursorPosition && !isToolbarInteracting"
      class="absolute rounded-full pointer-events-none custom-cursor"
      :style="{
        width: `${brushSize}px`,
        height: `${brushSize}px`,
        backgroundColor: toRgba(brushColor, brushAlpha),
        border: '1px solid rgba(255, 255, 255, 0.9)',
        transform: 'translate(-50%, -50%)',
        left: `${cursorPosition.x}px`,
        top: `${cursorPosition.y}px`,
        zIndex: 1000,
        borderRadius: '50%',
      }"
    ></div>

    <div
      v-show="showToolbar"
      ref="toolbarRef"
      class="absolute toolbar-container mask-toolbar-region app-floating-toolbar"
      :style="{
        left: `${toolbarPosition.x}px`,
        top: `${toolbarPosition.y}px`,
        zIndex: 1001,
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

      <q-bar class="q-px-md rounded-b-pill app-floating-toolbar-bar">
        <q-btn-group flat class="rounded-pill overflow-hidden">
          <q-btn :color="drawingModeActive ? 'primary' : 'grey'" icon="brush" @click="toggleDrawing">
            <q-tooltip>绘制 (Ctrl/B)</q-tooltip>
          </q-btn>

          <q-btn-dropdown
            color="primary"
            icon="format_size"
            :content-class="toolbarPopupClass"
          >
            <div class="brush-size-panel q-pa-md">
              <q-slider
                v-model="brushSize"
                :min="1"
                :max="120"
                label
                label-always
              />
            </div>
          </q-btn-dropdown>

          <q-btn-dropdown
            color="primary"
            icon="palette"
            :content-class="toolbarPopupClass"
          >
            <div class="q-pa-sm">
              <q-color v-model="brushColor" />
            </div>
          </q-btn-dropdown>

          <q-btn-dropdown
            color="primary"
            icon="opacity"
            :content-class="toolbarPopupClass"
          >
            <div class="alpha-panel q-pa-md">
              <q-slider
                v-model="brushAlpha"
                :min="0.05"
                :max="1"
                :step="0.05"
                label
                label-always
              />
            </div>
          </q-btn-dropdown>
        </q-btn-group>

        <q-separator vertical inset />

        <q-btn-group flat class="rounded-pill overflow-hidden">
          <q-btn icon="center_focus_strong" @click="resetView">
            <q-tooltip>重置位置</q-tooltip>
          </q-btn>
          <q-btn icon="clear" @click="clearCanvas">
            <q-tooltip>清除</q-tooltip>
          </q-btn>
          <q-btn icon="undo" :disable="!canUndo" @click="undo">
            <q-tooltip>撤销 (Ctrl+Z)</q-tooltip>
          </q-btn>
          <q-btn
            icon="visibility_off"
            @mousedown="toggleMaskVisibility(false)"
            @mouseup="toggleMaskVisibility(true)"
            @mouseleave="toggleMaskVisibility(true)"
          >
            <q-tooltip>按住隐藏蒙版</q-tooltip>
          </q-btn>
        </q-btn-group>
      </q-bar>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";

import { DEFAULT_IMAGE_BRUSH, normalizeBrushConfig } from "src/config/ConfigManager";
import { useConfigStore } from "src/stores/config";
import { useEditorStore } from "../stores/editor";

const editor = inject("image-editor", { value: null });
const configStore = useConfigStore();

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
  "update:toolbar-interacting",
]);

const store = useEditorStore();
const rootRef = ref(null);
const toolbarRef = ref(null);
const maskCanvas = ref(null);
const ctx = ref(null);
const isDrawing = ref(false);
const brushSize = ref(DEFAULT_IMAGE_BRUSH.size);
const brushColor = ref(DEFAULT_IMAGE_BRUSH.color);
const brushAlpha = ref(DEFAULT_IMAGE_BRUSH.alpha);
const lastPoint = ref(null);
const isCtrlPressed = ref(false);
const cursorPosition = ref(null);
const history = ref([]);
const historyIndex = ref(-1);
const canUndo = ref(false);
const operationStartIndices = ref([0]);
const tempCanvas = ref(null);
const tempCtx = ref(null);
const toolbarPosition = ref({ x: 20, y: 20 });
const isDraggingToolbar = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const hasManualToolbarPosition = ref(false);
const maskVisible = ref(true);
const pendingMaskSyncDataUrl = ref("");
const drawingModeActive = computed(() => Boolean(props.drawingMode));
const toolbarPopupClass = "mask-toolbar-popup";
const isToolbarPointerRegionActive = ref(false);
const isToolbarInteracting = computed(
  () => Boolean(props.showToolbar) && (isDraggingToolbar.value || isToolbarPointerRegionActive.value)
);

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

const toRgba = (hex, alpha = 1) => {
  const value = String(hex || "").replace("#", "").trim();
  const normalized =
    value.length === 3
      ? value
          .split("")
          .map((item) => item + item)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
};

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

const areImageDatasEqual = (data1, data2) => {
  if (!data1 || !data2) return false;
  if (data1.width !== data2.width || data1.height !== data2.height) return false;

  const source = data1.data;
  const target = data2.data;
  if (source.length !== target.length) return false;

  for (let index = 0; index < source.length; index += 4) {
    if (
      (source[index + 3] > 0 || target[index + 3] > 0) &&
      (source[index] !== target[index] ||
        source[index + 1] !== target[index + 1] ||
        source[index + 2] !== target[index + 2] ||
        source[index + 3] !== target[index + 3])
    ) {
      return false;
    }
  }

  return true;
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

const handlePointerMove = (event) => {
  if (!maskCanvas.value) return;

  cursorPosition.value = {
    x: event.clientX,
    y: event.clientY,
  };

  if (isDrawing.value) {
    draw(event);
  }
};

const handlePointerOut = (event) => {
  if (event.relatedTarget && event.relatedTarget.closest(".toolbar-container")) {
    return;
  }

  if (isDrawing.value) {
    stopDrawing();
  }
  cursorPosition.value = null;
};

const draw = (event) => {
  if (!isDrawing.value || !ctx.value || !lastPoint.value) return;

  event.preventDefault();
  event.stopPropagation();

  const rect = maskCanvas.value.getBoundingClientRect();
  const x = (event.clientX - rect.left) / props.scale;
  const y = (event.clientY - rect.top) / props.scale;

  if (x < 0 || x > maskCanvas.value.width || y < 0 || y > maskCanvas.value.height) {
    return;
  }

  requestAnimationFrame(() => {
    ctx.value.beginPath();
    ctx.value.moveTo(lastPoint.value.x, lastPoint.value.y);
    ctx.value.lineTo(x, y);
    ctx.value.strokeStyle = brushColor.value;
    ctx.value.lineWidth = brushSize.value / props.scale;
    ctx.value.lineCap = "round";
    ctx.value.lineJoin = "round";
    ctx.value.stroke();

    lastPoint.value = { x, y };
  });
};

const startDrawing = (event) => {
  if (event.button !== 0 || !maskCanvas.value || !ctx.value) return;

  const rect = maskCanvas.value.getBoundingClientRect();
  const x = (event.clientX - rect.left) / props.scale;
  const y = (event.clientY - rect.top) / props.scale;

  if (!tempCanvas.value) {
    tempCanvas.value = document.createElement("canvas");
    tempCanvas.value.width = maskCanvas.value.width;
    tempCanvas.value.height = maskCanvas.value.height;
    tempCtx.value = tempCanvas.value.getContext("2d", {
      willReadFrequently: true,
    });
  }

  tempCtx.value.clearRect(0, 0, tempCanvas.value.width, tempCanvas.value.height);
  tempCtx.value.drawImage(maskCanvas.value, 0, 0);

  lastPoint.value = { x, y };
  isDrawing.value = true;

  ctx.value.beginPath();
  ctx.value.arc(x, y, brushSize.value / (props.scale * 2), 0, Math.PI * 2);
  ctx.value.fillStyle = brushColor.value;
  ctx.value.fill();
};

const stopDrawing = () => {
  if (!isDrawing.value || !ctx.value || !maskCanvas.value) return;

  isDrawing.value = false;
  if (!tempCanvas.value || !tempCtx.value) return;

  const currentImageData = ctx.value.getImageData(
    0,
    0,
    maskCanvas.value.width,
    maskCanvas.value.height
  );
  const startImageData = tempCtx.value.getImageData(
    0,
    0,
    tempCanvas.value.width,
    tempCanvas.value.height
  );

  if (areImageDatasEqual(currentImageData, startImageData)) {
    return;
  }

  if (historyIndex.value < history.value.length - 1) {
    history.value.splice(historyIndex.value + 1);
    operationStartIndices.value = operationStartIndices.value.filter(
      (index) => index <= historyIndex.value
    );
  }

  const newIndex = history.value.length;
  operationStartIndices.value.push(newIndex);
  history.value.push(
    new ImageData(
      new Uint8ClampedArray(currentImageData.data),
      currentImageData.width,
      currentImageData.height
    )
  );
  historyIndex.value = history.value.length - 1;
  updateCanUndoRedo();
  emitMask();
};

const toggleDrawing = () => {
  const nextValue = !drawingModeActive.value;
  if (!nextValue && isDrawing.value) {
    stopDrawing();
  }
  emit("update:drawing-mode", nextValue);
};

const onPointerDown = (event) => {
  if (event.button !== 0) return;

  if (drawingModeActive.value || isCtrlPressed.value) {
    startDrawing(event);
    if (isCtrlPressed.value) {
      event.preventDefault();
    }
    return;
  }

  const startX = event.clientX - store.offsetX;
  const startY = event.clientY - store.offsetY;

  const onPointerMove = (moveEvent) => {
    store.setOffset(moveEvent.clientX - startX, moveEvent.clientY - startY);
  };

  const onPointerUp = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
};

const resetView = () => {
  hasManualToolbarPosition.value = false;
  if (editor?.value) {
    editor.value.resetView();
  } else {
    store.resetView();
  }

  nextTick(() => {
    syncToolbarPosition();
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

  ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);

  if (historyIndex.value < history.value.length - 1) {
    history.value.splice(historyIndex.value + 1);
    operationStartIndices.value = operationStartIndices.value.filter(
      (index) => index <= historyIndex.value
    );
  }

  const newIndex = history.value.length;
  operationStartIndices.value.push(newIndex);
  history.value.push(
    ctx.value.getImageData(0, 0, maskCanvas.value.width, maskCanvas.value.height)
  );
  historyIndex.value = history.value.length - 1;
  updateCanUndoRedo();
  emitMask();
};

const updateMask = (newMask) => {
  if (!ctx.value || !maskCanvas.value) return;

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

const getSafeToolbarViewport = () => {
  const rootEl = rootRef.value;
  const toolbarEl = toolbarRef.value;
  if (!rootEl || !toolbarEl) return null;

  const rootWidth = rootEl.clientWidth;
  const rootHeight = rootEl.clientHeight;
  const leftInset = Math.max(0, Number(props.visibleAreaInsets?.left || 0));
  const rightInset = Math.max(0, Number(props.visibleAreaInsets?.right || 0));
  const topInset = Math.max(0, Number(props.visibleAreaInsets?.top || 0));
  const bottomInset = Math.max(0, Number(props.visibleAreaInsets?.bottom || 0));
  const safeWidth = Math.max(1, rootWidth - leftInset - rightInset);
  const safeHeight = Math.max(1, rootHeight - topInset - bottomInset);

  return {
    rootWidth,
    rootHeight,
    toolbarWidth: toolbarEl.offsetWidth || 0,
    toolbarHeight: toolbarEl.offsetHeight || 0,
    leftInset,
    rightInset,
    topInset,
    bottomInset,
    safeWidth,
    safeHeight,
  };
};

const clampToolbarPosition = (position) => {
  const viewport = getSafeToolbarViewport();
  if (!viewport) return position;

  const minX = viewport.leftInset + 20;
  const minY = viewport.topInset + 20;
  const maxX = Math.max(minX, viewport.rootWidth - viewport.rightInset - viewport.toolbarWidth - 20);
  const maxY = Math.max(minY, viewport.rootHeight - viewport.bottomInset - viewport.toolbarHeight - 20);

  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y)),
  };
};

const setDefaultToolbarPosition = () => {
  const viewport = getSafeToolbarViewport();
  if (!viewport) return;

  const imageCenterX = store.offsetX + (store.imageWidth * props.scale) / 2;
  toolbarPosition.value = clampToolbarPosition({
    x: imageCenterX - viewport.toolbarWidth / 2,
    y: viewport.rootHeight - viewport.bottomInset - viewport.toolbarHeight - 20,
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
};

const applyBrushDefaults = () => {
  const defaults = normalizeBrushConfig(
    configStore.config.advanced?.imageBrushDefault,
    DEFAULT_IMAGE_BRUSH
  );
  brushSize.value = defaults.size;
  brushColor.value = defaults.color;
  brushAlpha.value = defaults.alpha;
};

onMounted(() => {
  if (props.show) {
    initCanvas();
  }

  applyBrushDefaults();
  nextTick(() => {
    syncToolbarPosition();
  });
});

onUnmounted(() => {
  document.removeEventListener("mousemove", moveToolbar, { capture: true });
  document.removeEventListener("mouseup", stopDragToolbar, { capture: true });
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
  if (isDrawing.value) {
    stopDrawing();
  }
});

useEventListener(window, "mousemove", (event) => {
  if (drawingModeActive.value || isCtrlPressed.value) {
    cursorPosition.value = {
      x: event.clientX,
      y: event.clientY,
    };
  }
});

useEventListener(window, "pointermove", syncToolbarPointerRegionState, { passive: true, capture: true });
useEventListener(window, "pointerdown", syncToolbarPointerRegionState, { passive: true, capture: true });
useEventListener(window, "pointerup", syncToolbarPointerRegionState, { passive: true, capture: true });
useEventListener(window, "blur", () => {
  setToolbarPointerRegionState(false);
});

useEventListener(window, "resize", () => {
  nextTick(() => {
    syncToolbarPosition();
  });
});

watch(
  () => configStore.config.advanced?.imageBrushDefault,
  () => {
    applyBrushDefaults();
  },
  {
    deep: true,
    immediate: true,
  }
);

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
    if (!enabled && isDrawing.value) {
      stopDrawing();
    }
  }
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
  () => props.visibleAreaInsets,
  async () => {
    await nextTick();
    syncToolbarPosition();
  },
  { deep: true }
);

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      nextTick(() => {
        initCanvas();
        syncToolbarPosition();
      });
    }
  }
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
}

.toolbar-container {
  z-index: 1001 !important;
  pointer-events: auto !important;
  position: absolute !important;
  touch-action: none;
  user-select: none;
  overflow: hidden;
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

.rounded-pill {
  border-radius: 999px !important;
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

.alpha-panel {
  width: 240px;
}

.brush-size-panel {
  width: 240px;
}
</style>
