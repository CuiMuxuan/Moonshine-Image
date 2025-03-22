<template>
  <div class="absolute inset-0 overflow-hidden">
    <div
      ref="imageContainer"
      class="absolute inset-0 editor-grid-bg overflow-hidden"
      :style="containerStyle"
      :class="{
        'cursor-grab': !isDrawingMode && !isDragging && !isCtrlPressed,
        'cursor-grabbing': !isDrawingMode && !isCtrlPressed && isDragging,
        'cursor-none': isDrawingMode || isCtrlPressed,
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
        :scale="scale"
        :mask="mask"
        @update:mask="$emit('update:mask', $event)"
        @update:drawing-mode="updateDrawingMode"
        @update:ctrl-pressed="updateCtrlPressed"
      />
    </div>
  </div>
</template>

<script setup>
import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  watch,
  nextTick,
  provide,
} from "vue";
import { useEventListener } from "@vueuse/core";
import { useEditorStore } from "../stores/editor";
import ImageMasker from "./ImageMasker.vue";

const store = useEditorStore();
const imageContainer = ref(null);
const imageRef = ref(null);
const maskerRef = ref(null);
const isImageLoaded = ref(false);
const isDrawingMode = ref(false);
const isDragging = ref(false);

const initialScale = ref(1);
const initialOffsetX = ref(0);
const initialOffsetY = ref(0);
const isCtrlPressed = ref(false);

const props = defineProps({
  selectedFile: {
    type: Object,
    default: null,
  },
  showMasker: {
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
  }
});

const emit = defineEmits(["loaded", "update:mask"]);
const imageUrl = computed(() => {
  if (props.imageUrl) {
    // 优先使用父组件传入的 URL（可能是处理后的图片）
    return props.imageUrl;
  } else if (props.selectedFile) {
    // 如果没有传入 URL 但有文件，则创建新的 URL
    const url = URL.createObjectURL(props.selectedFile);
    // 存储到 store 中以便后续管理
    store.setImageUrl(url);
    return url;
  }
  return store.imageUrl;
});
const mode = computed(() => store.mode);
const scale = computed(() => store.scale);

// 图片样式
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
// 修改图片加载处理
const onImageLoad = () => {
  if (!imageRef.value || !imageContainer.value) return;

  nextTick(() => {
    const img = imageRef.value;
    const container = imageContainer.value;

    if (!img || !container) return;

    store.setImageSize(img.naturalWidth, img.naturalHeight);

    // 计算初始缩放比例以适应容器
    const containerRatio = container.clientWidth / container.clientHeight;
    const imageRatio = img.naturalWidth / img.naturalHeight;

    let scale = 1;
    if (imageRatio > containerRatio) {
      scale = container.clientWidth / img.naturalWidth;
    } else {
      scale = container.clientHeight / img.naturalHeight;
    }

    // 居中图片
    const offsetX = (container.clientWidth - img.naturalWidth * scale) / 2;
    const offsetY = (container.clientHeight - img.naturalHeight * scale) / 2;

    // 保存初始值
    initialScale.value = scale;
    initialOffsetX.value = offsetX;
    initialOffsetY.value = offsetY;

    store.setScale(scale);
    store.setOffset(offsetX, offsetY);
    // 如果没有蒙版数据，创建初始蒙版
    if (props.mask && !props.mask.data) {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 发送初始蒙版数据
      emit('update:mask', {
        data: canvas.toDataURL(),
        width: img.naturalWidth,
        height: img.naturalHeight
      });
    }

    isImageLoaded.value = true;
    emit("loaded");
  });
};

useEventListener(window, "keydown", (e) => {
  if (e.key === "Control") {
    isCtrlPressed.value = true;
  }
});

useEventListener(window, "keyup", (e) => {
  if (e.key === "Control") {
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

// 监听蒙版变化，处理蒙版调整
watch(() => props.mask, (newMask) => {
  if (newMask && isImageLoaded.value) {
    // 确保图片已加载
    nextTick(() => {
      if (maskerRef.value) {
        // 通知masker组件更新蒙版
      }
    });
  }
}, { deep: true });


// 事件处理
const onWheel = (e) => {
  e.preventDefault();

  const container = imageContainer.value;
  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // 计算鼠标相对于图片的位置
  const relativeX = (mouseX - store.offsetX) / scale.value;
  const relativeY = (mouseY - store.offsetY) / scale.value;

  if (e.deltaY < 0) {
    store.zoomIn(relativeX, relativeY);
  } else {
    store.zoomOut(relativeX, relativeY);
  }
};

const updateCtrlPressed = (pressed) => {
  isCtrlPressed.value = pressed;
};
const updateDrawingMode = (mode) => {
  isDrawingMode.value = mode;
};

const onPointerDown = (e) => {
  if (isDrawingMode.value || isCtrlPressed.value) return;

  isDragging.value = true;
  const startX = e.clientX - store.offsetX;
  const startY = e.clientY - store.offsetY;

  const onPointerMove = (e) => {
    store.setOffset(e.clientX - startX, e.clientY - startY);
  };

  const onPointerUp = () => {
    isDragging.value = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
};

// 生命周期
onMounted(() => {
  if (imageRef.value && imageRef.value.complete) {
    onImageLoad();
  }
});

// 在组件卸载时清理资源
onUnmounted(() => {
  // 只清理组件内部创建的 URL，不清理外部传入的 URL
  if (imageRef.value && !props.imageUrl) {
    URL.revokeObjectURL(imageRef.value.src);
  }
});

// 添加重置方法
const resetView = () => {
  store.setScale(initialScale.value);
  store.setOffset(initialOffsetX.value, initialOffsetY.value);
};
provide(
  "image-editor",
  ref({
    resetView,
  })
);
// 暴露方法给父组件
defineExpose({ resetView });
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
