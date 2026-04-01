<template>
  <div class="absolute inset-0 overflow-hidden">
    <div
      ref="imageContainer"
      class="absolute inset-0 editor-grid-bg overflow-hidden"
      :style="containerStyle"
      :class="{
        'cursor-grab': !isDrawingMode && !isDragging && !isToolbarInteracting,
        'cursor-grabbing': !isDrawingMode && isDragging && !isToolbarInteracting,
        'cursor-none': isDrawingMode && !isToolbarInteracting,
      }"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
    >
      <img
        ref="imageRef"
        :src="imageUrl"
        :style="imageStyle"
        class="absolute select-none"
        @load="onImageLoad"
        @error="onImageError"
        draggable="false"
      />

      <ImageMasker
        v-if="showMasker && isImageLoaded"
        ref="maskerRef"
        :show="true"
        :show-toolbar="showMasker"
        :drawing-mode="drawingMode"
        :tool-state="resolvedToolState"
        :scale="scale"
        :mask="mask"
        :visible-area-insets="visibleAreaInsets"
        @update:mask="$emit('update:mask', $event)"
        @update:drawing-mode="updateDrawingMode"
        @update:tool-state="updateMaskToolState"
        @update:toolbar-interacting="updateToolbarInteracting"
      />
    </div>
  </div>
</template>

<script setup>
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  ref,
  watch,
} from "vue";
import { useQuasar } from "quasar";

import { useEditorStore } from "src/stores/editor";
import { useFileManagerStore } from "src/stores/fileManager";
import { normalizeMaskToolUiState } from "src/utils/maskTool";
import {
  computeContainPlacement,
  resolveViewportRect,
} from "src/utils/viewportPlacement";
import ImageMasker from "./ImageMasker.vue";

const store = useEditorStore();
const fileManagerStore = useFileManagerStore();
const $q = useQuasar();
const imageContainer = ref(null);
const imageRef = ref(null);
const maskerRef = ref(null);
const isImageLoaded = ref(false);
const isDragging = ref(false);
const hasManualViewportChange = ref(false);
const isToolbarInteracting = ref(false);
const lastMissingImagePath = ref("");

const props = defineProps({
  selectedFile: {
    type: Object,
    default: null,
  },
  showMasker: {
    type: Boolean,
    default: false,
  },
  drawingMode: {
    type: Boolean,
    default: false,
  },
  toolState: {
    type: Object,
    default: null,
  },
  mask: {
    type: Object,
    default: null,
  },
  imageUrl: {
    type: String,
    default: null,
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
  "loaded",
  "update:mask",
  "update:drawing-mode",
  "update:tool-state",
]);
const imageUrl = computed(() => {
  if (props.imageUrl) {
    return props.imageUrl;
  }

  const currentDisplayImage = fileManagerStore.getCurrentDisplayImage;
  if (currentDisplayImage) {
    if (currentDisplayImage.type === "path" && currentDisplayImage.displayUrl) {
      if (window.electron) {
        return `atom://${currentDisplayImage.data.replace(/\\/g, "/")}`;
      }
      console.warn("文件路径模式仅在 Electron 环境中支持，回退到 base64 模式");
      return null;
    }

    if (currentDisplayImage.type === "base64") {
      return currentDisplayImage.displayUrl;
    }
  }

  if (props.selectedFile) {
    const url = URL.createObjectURL(props.selectedFile);
    store.setImageUrl(url);
    return url;
  }

  return store.imageUrl;
});

const mode = computed(() => store.mode);
const scale = computed(() => store.scale);
const drawingMode = computed(() => Boolean(props.drawingMode));
const isDrawingMode = computed(() => Boolean(props.showMasker && drawingMode.value));
const resolvedToolState = computed(() => normalizeMaskToolUiState(props.toolState));

const imageStyle = computed(() => ({
  transform: `scale(${scale.value})`,
  left: `${store.offsetX}px`,
  top: `${store.offsetY}px`,
  width: `${store.imageWidth}px`,
  height: `${store.imageHeight}px`,
  transformOrigin: "0 0",
}));

const containerStyle = computed(() => ({
  width: "100%",
  height: "100%",
}));

const waitForLayoutFrame = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });

const getCanvasData = () => {
  if (!maskerRef.value) {
    return props.mask?.data || null;
  }

  try {
    const maskData = maskerRef.value.getMaskData?.();
    return maskData || props.mask?.data || null;
  } catch (error) {
    console.error("获取蒙版数据失败:", error);
    return props.mask?.data || null;
  }
};

const getSelection = () => imageUrl.value || null;

const getVisibleViewport = () => {
  const container = imageContainer.value;
  if (!container) {
    return null;
  }

  return resolveViewportRect({
    containerWidth: container.clientWidth,
    containerHeight: container.clientHeight,
    insets: props.visibleAreaInsets,
    respectInsets: true,
  });
};

const computeFitViewport = () => {
  const img = imageRef.value;
  const viewport = getVisibleViewport();
  if (!img || !viewport) return null;

  const imageWidth = img.naturalWidth || store.imageWidth || 1;
  const imageHeight = img.naturalHeight || store.imageHeight || 1;
  const placement = computeContainPlacement({
    contentWidth: imageWidth,
    contentHeight: imageHeight,
    viewport,
  });
  if (!placement) return null;

  return {
    scale: placement.scale,
    offsetX: placement.x,
    offsetY: placement.y,
  };
};

const applyFitViewport = () => {
  const fitViewport = computeFitViewport();
  if (!fitViewport) return false;

  store.setScale(fitViewport.scale);
  store.setOffset(fitViewport.offsetX, fitViewport.offsetY);
  return true;
};

const initializeEmptyMaskIfNeeded = () => {
  const img = imageRef.value;
  if (!img || !props.mask || props.mask.data) return;

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  emit("update:mask", {
    data: canvas.toDataURL(),
    width: img.naturalWidth,
    height: img.naturalHeight,
  });
};

const onImageLoad = () => {
  if (!imageRef.value || !imageContainer.value) return;

  nextTick(() => {
    const img = imageRef.value;
    if (!img) return;

    store.setImageSize(img.naturalWidth, img.naturalHeight);
    hasManualViewportChange.value = false;
    applyFitViewport();
    initializeEmptyMaskIfNeeded();

    lastMissingImagePath.value = "";
    isImageLoaded.value = true;
    emit("loaded");
  });
};

const onImageError = async () => {
  isImageLoaded.value = false;

  const currentDisplayImage = fileManagerStore.getCurrentDisplayImage;
  if (currentDisplayImage?.type !== "path" || !currentDisplayImage.data) {
    return;
  }

  const missingPath = currentDisplayImage.data;
  if (await fileManagerStore.fileExists(missingPath)) {
    return;
  }

  if (lastMissingImagePath.value === missingPath) {
    return;
  }

  lastMissingImagePath.value = missingPath;
  $q.notify({
    type: "warning",
    message: `${props.selectedFile?.name || "当前图片"} 对应的本地文件已被删除或移动，请重新导入后再试`,
    position: "top",
  });
};

watch([() => store.scale, () => store.offsetX, () => store.offsetY], () => {
  if (mode.value === "mask" && maskerRef.value) {
    nextTick(() => {
      maskerRef.value.$el.style.transform = `scale(${store.scale})`;
      maskerRef.value.$el.style.left = `${store.offsetX}px`;
      maskerRef.value.$el.style.top = `${store.offsetY}px`;
    });
  }
});

watch(
  () => props.mask,
  () => {
    if (isImageLoaded.value) {
      nextTick(() => {
        if (maskerRef.value) {
          // Mask state is managed inside ImageMasker watchers.
        }
      });
    }
  },
  { deep: true }
);

watch(
  () => imageUrl.value,
  () => {
    isImageLoaded.value = false;
    hasManualViewportChange.value = false;
    isToolbarInteracting.value = false;
  }
);

watch(
  () => props.showMasker,
  (visible) => {
    if (!visible) {
      isToolbarInteracting.value = false;
    }
  }
);

watch(
  () => props.visibleAreaInsets,
  async () => {
    if (!isImageLoaded.value || hasManualViewportChange.value) {
      return;
    }

    await nextTick();
    await waitForLayoutFrame();
    applyFitViewport();
  },
  { deep: true }
);

const onWheel = (event) => {
  event.preventDefault();
  hasManualViewportChange.value = true;

  const container = imageContainer.value;
  const rect = container.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  const relativeX = (mouseX - store.offsetX) / scale.value;
  const relativeY = (mouseY - store.offsetY) / scale.value;

  if (event.deltaY < 0) {
    store.zoomIn(relativeX, relativeY);
  } else {
    store.zoomOut(relativeX, relativeY);
  }
};

const updateDrawingMode = (modeValue) => {
  emit("update:drawing-mode", Boolean(modeValue));
};

const updateToolbarInteracting = (value) => {
  isToolbarInteracting.value = Boolean(value);
};

const updateMaskToolState = (value = {}) => {
  const mergedState = normalizeMaskToolUiState({
    ...resolvedToolState.value,
    ...value,
    toolbarState:
      value.toolbarState === undefined
        ? resolvedToolState.value.toolbarState
        : value.toolbarState,
  });

  emit("update:tool-state", mergedState);
};

const onPointerDown = (event) => {
  if (isDrawingMode.value) return;

  hasManualViewportChange.value = true;
  isDragging.value = true;
  const startX = event.clientX - store.offsetX;
  const startY = event.clientY - store.offsetY;

  const onPointerMove = (moveEvent) => {
    store.setOffset(moveEvent.clientX - startX, moveEvent.clientY - startY);
  };

  const onPointerUp = () => {
    isDragging.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
};

onMounted(() => {
  if (imageRef.value && imageRef.value.complete) {
    onImageLoad();
  }
});

onUnmounted(() => {
  if (imageRef.value && !props.imageUrl) {
    URL.revokeObjectURL(imageRef.value.src);
  }
});

const resetView = async () => {
  hasManualViewportChange.value = false;
  await nextTick();
  await waitForLayoutFrame();
  await waitForLayoutFrame();
  applyFitViewport();
};

provide(
  "image-editor",
  ref({
    resetView,
    getCanvasData,
    getSelection,
    undoMask: () => maskerRef.value?.undo?.(),
    canUndoMask: () => Boolean(maskerRef.value?.canUndo?.()),
    isMaskerReady: () => Boolean(maskerRef.value?.isReady?.()),
  })
);

defineExpose({
  resetView,
  getCanvasData,
  getSelection,
  undoMask: () => maskerRef.value?.undo?.(),
  canUndoMask: () => Boolean(maskerRef.value?.canUndo?.()),
  isMaskerReady: () => Boolean(maskerRef.value?.isReady?.()),
});
</script>

<style scoped>
.absolute {
  position: absolute;
}

.inset-0 {
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
}

.overflow-hidden {
  overflow: hidden;
}

.editor-grid-bg {
  position: relative;
  background: transparent;
}

.cursor-grab {
  cursor: grab !important;
}

.cursor-grabbing {
  cursor: grabbing !important;
}

.cursor-none {
  cursor: none !important;
}
</style>
