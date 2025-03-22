<template>
  <div
    v-if="show"
    class="absolute h-full w-full pointer-events-none z-[2]"
    :style="{ cursor: isDragging ? 'move' : 'crosshair' }"
  >
    <div
      v-if="isActive"
      class="relative pointer-events-none z-[2]"
      :style="{
        height: height + 'px',
        width: width + 'px',
        left: x + 'px',
        top: y + 'px',
        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
      }"
    >
      <!-- 边框 -->
      <div
        class="absolute top-0 left-0"
        :style="{
          height: height + 'px',
          width: width + 'px',
          outline: `${DRAG_HANDLE_BORDER / scale}px dashed var(--q-primary)`,
        }"
      />

      <!-- 信息栏 -->
      <div
        class="border absolute pointer-events-auto px-2 py-1 rounded-full bg-white"
        :style="{
          transform: `scale(${1 / scale})`,
          top: 0,
          left: 0,
        }"
      >
        {{ width }} x {{ height }}
      </div>

      <!-- 拖拽控制器 -->
      <div
        class="absolute top-0 h-full w-full"
        @pointerdown="onCropPointerDown"
      >
        <div
          v-for="handle in dragHandles"
          :key="handle.ord"
          class="absolute pointer-events-auto"
          :style="getDragHandleStyle(handle)"
          :data-ord="handle.ord"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useEditorStore } from "../stores/editor";
import { useEventListener } from "@vueuse/core";

const props = defineProps({
  scale: {
    type: Number,
    required: true,
  },
  show: {
    type: Boolean,
    required: true,
  },
});

const store = useEditorStore();
const DRAG_HANDLE_BORDER = 2;
const DOC_MOVE_OPTS = { capture: true, passive: false };
const MIN_SIZE = 20; // 最小尺寸限制
const aspectRatio = ref(null); // 宽高比例锁定
// 拖拽手柄配置
const dragHandles = [
  { ord: "nw", cursor: "nw-resize" },
  { ord: "n", cursor: "n-resize" },
  { ord: "ne", cursor: "ne-resize" },
  { ord: "e", cursor: "e-resize" },
  { ord: "se", cursor: "se-resize" },
  { ord: "s", cursor: "s-resize" },
  { ord: "sw", cursor: "sw-resize" },
  { ord: "w", cursor: "w-resize" },
];
// 状态
const isDragging = ref(false);
const isActive = ref(false);
const startPoint = ref({ x: 0, y: 0 });
const evData = ref({
  initX: 0,
  initY: 0,
  initHeight: 0,
  initWidth: 0,
  startResizeX: 0,
  startResizeY: 0,
  ord: "",
});

// Store 状态需要使用 computed 来保持响应性
const cropperState = computed(() => store.cropperState);
const x = computed(() => cropperState.value.x);
const y = computed(() => cropperState.value.y);
const width = computed(() => cropperState.value.width);
const height = computed(() => cropperState.value.height);
const isResizing = computed(() => store.isCropperExtenderResizing);

const onCropPointerDown = (e) => {
  const ord = e.target.dataset.ord;
  if (ord) {
    store.setIsCropperExtenderResizing(true);
    evData.value = {
      initX: x.value,
      initY: y.value,
      initHeight: height.value,
      initWidth: width.value,
      startResizeX: e.clientX,
      startResizeY: e.clientY,
      ord,
    };
  } else {
    isDragging.value = true;
    startPoint.value = {
      x: e.clientX - x.value,
      y: e.clientY - y.value,
    };
  }
};

const onPointerMove = (e) => {
  if (isDragging.value) {
    const newX = e.clientX - startPoint.value.x;
    const newY = e.clientY - startPoint.value.y;

    const maxX = store.imageWidth - width.value;
    const maxY = store.imageHeight - height.value;

    store.setCropperX(Math.max(0, Math.min(newX, maxX)));
    store.setCropperY(Math.max(0, Math.min(newY, maxY)));
  } else if (isResizing.value) {
    const curX = e.clientX;
    const curY = e.clientY;
    const offsetY = Math.round(
      (curY - evData.value.startResizeY) / props.scale
    );
    const offsetX = Math.round(
      (curX - evData.value.startResizeX) / props.scale
    );

    // 添加边界检查函数
    const checkBoundary = (newX, newY, newWidth, newHeight) => {
      const maxX = store.imageWidth - newWidth;
      const maxY = store.imageHeight - newHeight;
      return {
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
        width: Math.min(newWidth, store.imageWidth),
        height: Math.min(newHeight, store.imageHeight),
      };
    };

    // 在 moveTop、moveRight、moveLeft、moveBottom 中使用边界检查
    const moveTop = () => {
      const newHeight = evData.value.initHeight - offsetY;
      const newY = evData.value.initY + offsetY;
      if (newHeight >= MIN_SIZE) {
        if (aspectRatio.value) {
          const newWidth = newHeight * aspectRatio.value;
          if (newWidth >= MIN_SIZE) {
            const { x, y, width, height } = checkBoundary(
              x.value,
              newY,
              newWidth,
              newHeight
            );
            store.setCropperX(x);
            store.setCropperY(y);
            store.setCropperWidth(width);
            store.setCropperHeight(height);
          }
        } else {
          const { y, height } = checkBoundary(
            x.value,
            newY,
            width.value,
            newHeight
          );
          store.setCropperY(y);
          store.setCropperHeight(height);
        }
      }
    };

    const moveRight = () => {
      const newWidth = evData.value.initWidth + offsetX;
      if (newWidth >= MIN_SIZE) {
        if (aspectRatio.value) {
          const newHeight = newWidth / aspectRatio.value;
          if (newHeight >= MIN_SIZE) {
            const { width, height } = checkBoundary(
              x.value,
              y.value,
              newWidth,
              newHeight
            );
            store.setCropperWidth(width);
            store.setCropperHeight(height);
          }
        } else {
          const { width } = checkBoundary(
            x.value,
            y.value,
            newWidth,
            height.value
          );
          store.setCropperWidth(width);
        }
      }
    };

    const moveLeft = () => {
      const newWidth = evData.value.initWidth - offsetX;
      const newX = evData.value.initX + offsetX;
      if (newWidth >= MIN_SIZE) {
        if (aspectRatio.value) {
          const newHeight = newWidth / aspectRatio.value;
          if (newHeight >= MIN_SIZE) {
            const { x, width, height } = checkBoundary(
              newX,
              y.value,
              newWidth,
              newHeight
            );
            store.setCropperX(x);
            store.setCropperWidth(width);
            store.setCropperHeight(height);
          }
        } else {
          const { x, width } = checkBoundary(
            newX,
            y.value,
            newWidth,
            height.value
          );
          store.setCropperX(x);
          store.setCropperWidth(width);
        }
      }
    };

    const moveBottom = () => {
      const newHeight = evData.value.initHeight + offsetY;
      if (newHeight >= MIN_SIZE) {
        if (aspectRatio.value) {
          const newWidth = newHeight * aspectRatio.value;
          if (newWidth >= MIN_SIZE) {
            const { width, height } = checkBoundary(
              x.value,
              y.value,
              newWidth,
              newHeight
            );
            store.setCropperWidth(width);
            store.setCropperHeight(height);
          }
        } else {
          store.setCropperHeight(newHeight);
        }
      }
    };

    switch (evData.value.ord) {
      case "nw":
        moveTop();
        moveLeft();
        break;
      case "n":
        moveTop();
        break;
      case "ne":
        moveTop();
        moveRight();
        break;
      case "e":
        moveRight();
        break;
      case "se":
        moveBottom();
        moveRight();
        break;
      case "s":
        moveBottom();
        break;
      case "sw":
        moveBottom();
        moveLeft();
        break;
      case "w":
        moveLeft();
        break;
    }
  }
};
const initCropper = () => {
  isActive.value = true;
  store.setCropperX(0);
  store.setCropperY(0);
  store.setCropperWidth(store.imageWidth);
  store.setCropperHeight(store.imageHeight);
};

const resetCropper = () => {
  isActive.value = false;
  isDragging.value = false;
  store.setIsCropperExtenderResizing(false);
  store.setCropperX(0);
  store.setCropperY(0);
  store.setCropperWidth(0);
  store.setCropperHeight(0);
  aspectRatio.value = null;
};
// 添加双击重置功能
const onDoubleClick = () => {
  if (!isActive.value) return;

  // 重置为图片原始尺寸
  store.setCropperX(0);
  store.setCropperY(0);
  store.setCropperWidth(store.imageWidth);
  store.setCropperHeight(store.imageHeight);
};

// 添加宽高比例锁定切换
const toggleAspectRatio = () => {
  if (aspectRatio.value) {
    aspectRatio.value = null;
  } else {
    aspectRatio.value = width.value / height.value;
  }
};

// 添加键盘快捷键
useEventListener(window, "keydown", (e) => {
  if (!isActive.value) return;

  if (e.key === "r" && e.ctrlKey) {
    toggleAspectRatio();
    e.preventDefault();
  } else if (e.key === "Enter") {
    // 触发裁剪操作
    store.cropImage();
  }
});

// 添加事件监听
useEventListener(window, "dblclick", onDoubleClick);

// 修复 onPointerDown 函数
const onPointerDown = (e) => {
  if (e.button !== 0 || !props.show) return;

  const rect = e.currentTarget.getBoundingClientRect();
  const newX = Math.round((e.clientX - rect.left) / props.scale);
  const newY = Math.round((e.clientY - rect.top) / props.scale);

  startPoint.value = { x: newX, y: newY };
  store.setCropperX(newX);
  store.setCropperY(newY);
  store.setCropperWidth(0);
  store.setCropperHeight(0);

  isActive.value = true;
  isDragging.value = true;
};
// 修改 onPointerUp 中的重置逻辑
const onPointerUp = () => {
  if (isDragging.value) {
    isDragging.value = false;
    if (width.value < MIN_SIZE || height.value < MIN_SIZE) {
      resetCropper();
    }
  }
  if (isResizing.value) {
    store.setIsCropperExtenderResizing(false);
    if (width.value < MIN_SIZE || height.value < MIN_SIZE) {
      store.setCropperX(evData.value.initX);
      store.setCropperY(evData.value.initY);
      store.setCropperWidth(evData.value.initWidth);
      store.setCropperHeight(evData.value.initHeight);
    }
  }
};
const getDragHandleStyle = (handle) => {
  const size = Math.max(12, Math.round(12 / props.scale)); // 根据缩放调整手柄大小
  const halfSize = size / 2;
  const styles = {
    width: `${size}px`,
    height: `${size}px`,
    cursor: handle.cursor,
    border: "2px solid var(--q-primary)",
    backgroundColor: "white",
    transform: `scale(${1 / props.scale})`,
    borderRadius: "50%", // 添加圆角
    transition: "border-color 0.2s", // 添加过渡效果
  };

  switch (handle.ord) {
    case "nw":
      styles.top = styles.left = `-${halfSize}px`;
      break;
    case "n":
      styles.top = `-${halfSize}px`;
      styles.left = "50%";
      styles.transform += " translateX(-50%)";
      break;
    case "ne":
      styles.top = `-${halfSize}px`;
      styles.right = `-${halfSize}px`;
      break;
    case "e":
      styles.top = "50%";
      styles.right = `-${halfSize}px`;
      styles.transform += " translateY(-50%)";
      break;
    case "se":
      styles.bottom = styles.right = `-${halfSize}px`;
      break;
    case "s":
      styles.bottom = `-${halfSize}px`;
      styles.left = "50%";
      styles.transform += " translateX(-50%)";
      break;
    case "sw":
      styles.bottom = styles.left = `-${halfSize}px`;
      break;
    case "w":
      styles.top = "50%";
      styles.left = `-${halfSize}px`;
      styles.transform += " translateY(-50%)";
      break;
  }
  return styles;
};
// 事件监听
useEventListener(window, "pointerdown", onPointerDown, DOC_MOVE_OPTS);
useEventListener(window, "pointermove", onPointerMove, DOC_MOVE_OPTS);
useEventListener(window, "pointerup", onPointerUp, DOC_MOVE_OPTS);
// 组件挂载时初始化
onMounted(() => {
  if (props.show) {
    initCropper();
  }
});
// 组件卸载时清理
onUnmounted(() => {
  isActive.value = false;
  isDragging.value = false;
  store.setIsCropperExtenderResizing(false);
});
// 监听 show 属性变化
watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      initCropper();
    }
  }
);
</script>
