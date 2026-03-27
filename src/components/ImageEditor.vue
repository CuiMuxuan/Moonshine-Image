<template>
  <div class="absolute inset-0 overflow-hidden">
    <div
      ref="imageContainer"
      class="absolute inset-0 editor-grid-bg overflow-hidden"
      :style="containerStyle"
      :class="{
        'cursor-grab': !isDrawingMode && !isDragging && !isCtrlPressed && !isToolbarInteracting,
        'cursor-grabbing': !isDrawingMode && !isCtrlPressed && isDragging && !isToolbarInteracting,
        'cursor-none': (isDrawingMode || isCtrlPressed) && !isToolbarInteracting,
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
        draggable="false"
      />

      <ImageMasker
        v-if="showMasker && isImageLoaded"
        ref="maskerRef"
        :show="true"
        :show-toolbar="showMasker"
        :drawing-mode="drawingMode"
        :scale="scale"
        :mask="mask"
        :visible-area-insets="visibleAreaInsets"
        @update:mask="$emit('update:mask', $event)"
        @update:drawing-mode="updateDrawingMode"
        @update:ctrl-pressed="updateCtrlPressed"
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
import { useEventListener } from "@vueuse/core";

import { useEditorStore } from "../stores/editor";
import { useFileManagerStore } from "../stores/fileManager";
import ImageMasker from "./ImageMasker.vue";

const store = useEditorStore();
const fileManagerStore = useFileManagerStore();
const imageContainer = ref(null);
const imageRef = ref(null);
const maskerRef = ref(null);
const isImageLoaded = ref(false);
const isDragging = ref(false);
const hasManualViewportChange = ref(false);
const isCtrlPressed = ref(false);
const isToolbarInteracting = ref(false);

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

const emit = defineEmits(["loaded", "update:mask", "update:drawing-mode"]);
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

  const width = container.clientWidth;
  const height = container.clientHeight;
  const leftInset = Math.max(0, Number(props.visibleAreaInsets?.left || 0));
  const rightInset = Math.max(0, Number(props.visibleAreaInsets?.right || 0));
  const topInset = Math.max(0, Number(props.visibleAreaInsets?.top || 0));
  const bottomInset = Math.max(0, Number(props.visibleAreaInsets?.bottom || 0));

  const safeWidth = Math.max(1, width - leftInset - rightInset);
  const safeHeight = Math.max(1, height - topInset - bottomInset);

  return {
    width,
    height,
    safeWidth,
    safeHeight,
    leftInset,
    rightInset,
    topInset,
    bottomInset,
  };
};

const computeFitViewport = () => {
  const img = imageRef.value;
  const viewport = getVisibleViewport();
  if (!img || !viewport) return null;

  const imageWidth = img.naturalWidth || store.imageWidth || 1;
  const imageHeight = img.naturalHeight || store.imageHeight || 1;
  const scaleX = viewport.safeWidth / imageWidth;
  const scaleY = viewport.safeHeight / imageHeight;
  const nextScale = Math.min(scaleX, scaleY);
  const offsetX = viewport.leftInset + (viewport.safeWidth - imageWidth * nextScale) / 2;
  const offsetY = viewport.topInset + (viewport.safeHeight - imageHeight * nextScale) / 2;

  return {
    scale: nextScale,
    offsetX,
    offsetY,
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

    isImageLoaded.value = true;
    emit("loaded");
  });
};

useEventListener(window, "keydown", (event) => {
  if (event.key === "Control") {
    isCtrlPressed.value = true;
  }
});

useEventListener(window, "keyup", (event) => {
  if (event.key === "Control") {
    isCtrlPressed.value = false;
  }
});

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

const updateCtrlPressed = (pressed) => {
  isCtrlPressed.value = pressed;
};

const updateDrawingMode = (modeValue) => {
  emit("update:drawing-mode", Boolean(modeValue));
};

const updateToolbarInteracting = (value) => {
  isToolbarInteracting.value = Boolean(value);
};

const onPointerDown = (event) => {
  if (isDrawingMode.value || isCtrlPressed.value) return;

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

const resetView = () => {
  hasManualViewportChange.value = false;
  applyFitViewport();
};

provide(
  "image-editor",
  ref({
    resetView,
    getCanvasData,
    getSelection,
  })
);

defineExpose({
  resetView,
  getCanvasData,
  getSelection,
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
  background-image: linear-gradient(45deg, #f0f0f0 25%, transparent 25%),
    linear-gradient(-45deg, #f0f0f0 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #f0f0f0 75%),
    linear-gradient(-45deg, transparent 75%, #f0f0f0 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  background-color: #ffffff;
  position: relative;
}

:global(body.body--dark) .editor-grid-bg {
  background-image: linear-gradient(45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.04) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.04) 75%);
  background-color: #121212;
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
