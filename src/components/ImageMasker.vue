<template>
  <div v-if="show" class="absolute inset-0">
    <canvas
      ref="maskCanvas"
      class="absolute"
      :class="{
        'cursor-none': (isDrawingMode || isCtrlPressed) && cursorPosition,
        'cursor-grab': !isDrawingMode && !isCtrlPressed,
      }"
      :style="{
        width: `${store.imageWidth}px`,
        height: `${store.imageHeight}px`,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
        left: `${store.offsetX}px`,
        top: `${store.offsetY}px`,
        pointerEvents: isDrawingMode || isCtrlPressed ? 'auto' : 'none',
        opacity: maskVisible ? 1 : 0,
        transition: 'opacity 0.15s ease',
      }"
      @pointerdown="onPointerDown"
      @pointermove="handlePointerMove"
      @pointerup="stopDrawing"
      @pointerout="handlePointerOut"
    ></canvas>

    <!-- 自定义画笔光标 -->
    <div
      v-if="(isDrawingMode || isCtrlPressed) && cursorPosition"
      class="absolute rounded-full pointer-events-none custom-cursor"
      :style="{
        width: `${brushSize}px`,
        height: `${brushSize}px`,
        backgroundColor: brushColor + '80', // 添加透明度
        border: '1px solid white',
        transform: 'translate(-50%, -50%)',
        left: `${cursorPosition.x}px`,
        top: `${cursorPosition.y}px`,
        zIndex: 1000,
        borderRadius: '50%',
      }"
    ></div>

    <!-- 工具栏 -->
    <div
      v-show="showToolbar"
      class="absolute bg-deep-purple-2 rounded-pill shadow-lg toolbar-container"
      :style="{
        left: `${toolbarPosition.x}px`,
        top: `${toolbarPosition.y}px`,
        zIndex: 1001,
      }"
      @mousedown.stop
      @pointerdown.stop
    >
      <div
        class="toolbar-handle bg-primary text-white text-center text-xs py-1 rounded-t-pill cursor-move"
        @mousedown.stop="startDragToolbar"
        @pointerdown.stop
      >
        绘制工具拖动区域
      </div>
      <q-bar class="q-px-md rounded-b-pill bg-deep-purple-2">
        <q-btn-group flat class="rounded-pill overflow-hidden">
          <q-btn
            :color="isDrawingMode ? 'primary' : 'grey'"
            icon="brush"
            @click="toggleDrawing"
          >
            <q-tooltip>绘制 (Ctrl/B)</q-tooltip>
          </q-btn>

          <q-btn-dropdown color="primary" icon="format_size">
            <q-list>
              <q-item>
                <q-item-section>
                  <div class="flex items-center">
                    <div
                      class="mr-2 rounded-full"
                      :style="{
                        width: `${brushSize}px`,
                        height: `${brushSize}px`,
                        backgroundColor: brushColor,
                        minWidth: '10px',
                        minHeight: '10px',
                      }"
                    ></div>
                    <q-slider
                      v-model="brushSize"
                      :min="1"
                      :max="100"
                      label
                      label-always
                      class="flex-1"
                    />
                  </div>
                </q-item-section>
              </q-item>
            </q-list>
          </q-btn-dropdown>

          <q-btn-dropdown color="primary" icon="palette">
            <q-color v-model="brushColor" />
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
            <q-tooltip>撤销(Ctrl+Z)</q-tooltip>
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
import { ref, onMounted, onUnmounted, watch, inject, nextTick } from "vue";
import { useEditorStore } from "../stores/editor";
import { useEventListener } from "@vueuse/core";

const editor = inject("image-editor", { value: null });
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
});

const store = useEditorStore();
const maskCanvas = ref(null);
const ctx = ref(null);
const isDrawing = ref(false);
const brushSize = ref(20);
const brushColor = ref("#1976D2");
const lastPoint = ref(null);
const isCtrlPressed = ref(false);
const cursorPosition = ref(null);

// 撤销重做相关
const history = ref([]);
const historyIndex = ref(-1);
const canUndo = ref(false);
// 记录每次操作的起始索引
const operationStartIndices = ref([0]);
// 临时绘制缓存
const tempCanvas = ref(null);
const tempCtx = ref(null);

// 工具栏拖拽相关
const toolbarPosition = ref({ x: 20, y: 20 }); // 初始位置
const isDraggingToolbar = ref(false);
const dragOffset = ref({ x: 0, y: 0 });

const maskVisible = ref(true);
// 初始化画布
const initCanvas = () => {
  const canvas = maskCanvas.value;
  if (!store.imageWidth || !store.imageHeight) return;

  canvas.width = store.imageWidth;
  canvas.height = store.imageHeight;
  ctx.value = canvas.getContext("2d", { willReadFrequently: true });

  // 设置全局透明度合成模式，保留透明度
  ctx.value.globalCompositeOperation = "source-over";

  // 清空画布
  ctx.value.clearRect(0, 0, canvas.width, canvas.height);

  // 处理不同类型的mask数据
  if (props.mask) {
    if (props.mask instanceof ImageData) {
      // 如果是ImageData类型，直接使用putImageData
      ctx.value.putImageData(props.mask, 0, 0);
      saveInitialState();
    } else if (props.mask.data && typeof props.mask.data === "string") {
      // 如果是包含data字符串的对象(可能是base64图像)
      const img = new Image();
      img.onload = () => {
        ctx.value.drawImage(img, 0, 0, canvas.width, canvas.height);
        // 保存初始状态
        saveInitialState();
      };
      img.onerror = () => {
        console.error("加载蒙版图像失败");
        ctx.value.clearRect(0, 0, canvas.width, canvas.height);
        saveInitialState();
      };
      img.src = props.mask.data;
      return; // 异步加载，提前返回
    } else {
      // 如果没有有效的蒙版数据，创建空白蒙版
      ctx.value.clearRect(0, 0, canvas.width, canvas.height);
      saveInitialState();
    }
  } else {
    // 没有蒙版，创建空白蒙版
    ctx.value.clearRect(0, 0, canvas.width, canvas.height);
    saveInitialState();
  }
};

// 切换蒙版可见性
const toggleMaskVisibility = (visible) => {
  maskVisible.value = visible;
};
// 提取保存初始状态的逻辑为单独函数
const saveInitialState = () => {
  const canvas = maskCanvas.value;
  if (!canvas || !ctx.value || canvas.width <= 0 || canvas.height <= 0) return;

  // 重置历史记录
  history.value = [];
  historyIndex.value = -1;
  operationStartIndices.value = [];

  const initialState = ctx.value.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );
  history.value.push(initialState);
  historyIndex.value = 0;
  operationStartIndices.value = [0];
  updateCanUndoRedo();
};
// 比较两个 ImageData 是否相同
const areImageDatasEqual = (data1, data2) => {
  if (!data1 || !data2) return false;
  if (data1.width !== data2.width || data1.height !== data2.height)
    return false;

  const d1 = data1.data;
  const d2 = data2.data;

  if (d1.length !== d2.length) return false;

  return !Array.from({ length: d1.length / 4 }, (_, i) => i * 4).some((i) => {
    // 只有当至少一个像素有透明度时才比较
    return (
      (d1[i + 3] > 0 || d2[i + 3] > 0) &&
      (d1[i] !== d2[i] ||
        d1[i + 1] !== d2[i + 1] ||
        d1[i + 2] !== d2[i + 2] ||
        d1[i + 3] !== d2[i + 3])
    );
  });
};
// 状态管理
const saveState = () => {
  if (
    !ctx.value ||
    !maskCanvas.value ||
    !maskCanvas.value.width ||
    !maskCanvas.value.height
  )
    return;

  const imageData = ctx.value.getImageData(
    0,
    0,
    maskCanvas.value.width,
    maskCanvas.value.height
  );
  // 删除当前位置之后的所有历史记录
  history.value.splice(historyIndex.value + 1);
  history.value.push(imageData);
  historyIndex.value = history.value.length - 1;
};

// 处理鼠标移动，更新光标位置
const handlePointerMove = (e) => {
  if (!maskCanvas.value) return;

  cursorPosition.value = {
    x: e.clientX,
    y: e.clientY,
  };

  // 如果正在绘制，则调用绘制函数
  if (isDrawing.value) {
    draw(e);
  }
};
// 鼠标移出画布的处理
const handlePointerOut = (e) => {
  // 如果是移出到工具栏，不停止绘制
  if (e.relatedTarget && e.relatedTarget.closest(".toolbar-container")) {
    return;
  }

  if (isDrawing.value) {
    stopDrawing();
  }
  // 移出画布时隐藏自定义光标
  cursorPosition.value = null;
};
//绘制
const draw = (e) => {
  if (!isDrawing.value || !ctx.value || !lastPoint.value) return;

  // 防止绘制时的事件冒泡
  e.preventDefault();
  e.stopPropagation();

  const rect = maskCanvas.value.getBoundingClientRect();
  const x = (e.clientX - rect.left) / props.scale;
  const y = (e.clientY - rect.top) / props.scale;

  // 检查是否在画布范围内
  if (
    x < 0 ||
    x > maskCanvas.value.width ||
    y < 0 ||
    y > maskCanvas.value.height
  ) {
    return;
  }

  // 使用requestAnimationFrame优化绘制性能
  requestAnimationFrame(() => {
    ctx.value.beginPath();
    ctx.value.moveTo(lastPoint.value.x, lastPoint.value.y);
    ctx.value.lineTo(x, y);

    // 设置画笔样式
    ctx.value.strokeStyle = brushColor.value;
    ctx.value.lineWidth = brushSize.value / props.scale;
    ctx.value.lineCap = "round";
    ctx.value.lineJoin = "round";
    ctx.value.stroke();

    lastPoint.value = { x, y };
  });
};
// 节流函数
const throttle = (fn, delay) => {
  let lastCall = 0;
  return function (...args) {
    const now = new Date().getTime();
    if (now - lastCall < delay) {
      return;
    }
    lastCall = now;
    return fn(...args);
  };
};
// 开始绘制时，保存当前状态到临时画布
const startDrawing = (e) => {
  if (e.button !== 0) return;

  const rect = maskCanvas.value.getBoundingClientRect();
  const x = (e.clientX - rect.left) / props.scale;
  const y = (e.clientY - rect.top) / props.scale;

  // 创建临时画布保存当前状态
  if (!tempCanvas.value) {
    tempCanvas.value = document.createElement("canvas");
    tempCanvas.value.width = maskCanvas.value.width;
    tempCanvas.value.height = maskCanvas.value.height;
    tempCtx.value = tempCanvas.value.getContext("2d", {
      willReadFrequently: true,
    });
  }

  // 复制当前状态到临时画布
  tempCtx.value.clearRect(
    0,
    0,
    tempCanvas.value.width,
    tempCanvas.value.height
  );
  tempCtx.value.drawImage(maskCanvas.value, 0, 0);

  lastPoint.value = { x, y };
  isDrawing.value = true;

  // 立即绘制一个点
  ctx.value.beginPath();
  ctx.value.arc(x, y, brushSize.value / (props.scale * 2), 0, Math.PI * 2);
  ctx.value.fillStyle = brushColor.value;
  ctx.value.fill();
  emitMask();
};
const stopDrawing = () => {
  if (isDrawing.value) {
    isDrawing.value = false;

    // 只在绘制结束时保存状态，并且只有当内容有变化时才保存
    if (tempCanvas.value && tempCtx.value) {
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

      // 只有当绘制前后有变化时才保存状态
      if (!areImageDatasEqual(currentImageData, startImageData)) {
        // 删除当前位置之后的所有历史记录
        if (historyIndex.value < history.value.length - 1) {
          history.value.splice(historyIndex.value + 1);

          // 重建操作起始索引数组，只保留当前有效的索引
          operationStartIndices.value = operationStartIndices.value.filter(
            (index) => index <= historyIndex.value
          );
        }

        // 记录新操作的起始索引
        const newIndex = history.value.length;
        operationStartIndices.value.push(newIndex);

        // 创建新的ImageData对象以避免引用问题
        const newImageData = new ImageData(
          new Uint8ClampedArray(currentImageData.data),
          currentImageData.width,
          currentImageData.height
        );

        history.value.push(newImageData);
        historyIndex.value = history.value.length - 1;
        updateCanUndoRedo();
        emitMask();
      }
    }
  }
};

// 工具栏功能
const isDrawingMode = ref(false);

const toggleDrawing = () => {
  isDrawingMode.value = !isDrawingMode.value;
  isDrawing.value = false;
  // 通知父组件绘制模式状态变化
  emit("update:drawing-mode", isDrawingMode.value);
};

const onPointerDown = (e) => {
  if (e.button !== 0) return;

  if (isDrawingMode.value || isCtrlPressed.value) {
    // 绘制模式
    startDrawing(e);

    // 防止 Ctrl 键触发浏览器默认行为
    if (isCtrlPressed.value) {
      e.preventDefault();
    }
  } else {
    // 拖拽模式
    const startX = e.clientX - store.offsetX;
    const startY = e.clientY - store.offsetY;

    const onPointerMove = (e) => {
      store.setOffset(e.clientX - startX, e.clientY - startY);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
};

const resetView = () => {
  if (editor && editor.value) {
    editor.value.resetView();
  } else {
    // 如果没有找到editor引用，使用store的重置方法
    store.resetView();
  }
};

const undo = () => {
  if (historyIndex.value > 0) {
    // 找到当前操作的起始索引
    let currentOpIndex = 0;
    for (let i = operationStartIndices.value.length - 1; i >= 0; i--) {
      if (operationStartIndices.value[i] <= historyIndex.value) {
        currentOpIndex = i;
        break;
      }
    }

    // 找到上一个操作的起始索引
    const prevOpIndex = Math.max(0, currentOpIndex - 1);
    const targetIndex = operationStartIndices.value[prevOpIndex];

    // 确保目标索引有效
    if (targetIndex >= 0 && targetIndex < history.value.length) {
      // 从操作起始索引中移除被撤销的索引
      operationStartIndices.value = operationStartIndices.value.filter(
        (index) => index <= targetIndex
      );

      // 直接跳转到上一个操作的起始点
      historyIndex.value = targetIndex;
      ctx.value.putImageData(history.value[historyIndex.value], 0, 0);

      updateCanUndoRedo();
      emitMask();
    } else {
      console.error("无效的目标索引:", targetIndex);
    }
  }
};

// 清除方法
const clearCanvas = () => {
  if (!ctx.value || !maskCanvas.value) return;

  ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);

  // 删除当前位置之后的所有历史记录
  if (historyIndex.value < history.value.length - 1) {
    history.value.splice(historyIndex.value + 1);
    // 同时删除对应的操作起始索引
    operationStartIndices.value = operationStartIndices.value.filter(
      (index) => index <= historyIndex.value
    );
  }
  // 记录清除操作的起始索引
  const newIndex = history.value.length;
  operationStartIndices.value.push(newIndex);

  const imageData = ctx.value.getImageData(
    0,
    0,
    maskCanvas.value.width,
    maskCanvas.value.height
  );
  history.value.push(imageData);
  historyIndex.value = history.value.length - 1;
  updateCanUndoRedo();
  emitMask();
};
const updateCanUndoRedo = () => {
  // 只有当当前索引大于最早的操作起始索引时，才能撤销
  canUndo.value = historyIndex.value > operationStartIndices.value[0];
};
// 向父组件发送蒙版数据
const emitMask = throttle(() => {
  if (!ctx.value || !maskCanvas.value) return;

  // 使用toDataURL代替getImageData，减少数据量
  const dataUrl = maskCanvas.value.toDataURL("image/png", 0.8); // 使用压缩率0.8

  emit("update:mask", {
    data: dataUrl,
    width: maskCanvas.value.width,
    height: maskCanvas.value.height,
  });
}, 100);
// 添加updateMask方法，供外部调用
const updateMask = (newMask) => {
  if (!ctx.value || !maskCanvas.value) return;

  if (newMask instanceof ImageData) {
    ctx.value.putImageData(newMask, 0, 0);
    saveInitialState();
  } else if (newMask.data && typeof newMask.data === "string") {
    const img = new Image();
    img.onload = () => {
      ctx.value.clearRect(
        0,
        0,
        maskCanvas.value.width,
        maskCanvas.value.height
      );
      ctx.value.drawImage(
        img,
        0,
        0,
        maskCanvas.value.width,
        maskCanvas.value.height
      );
      saveInitialState();
    };
    img.onerror = () => {
      console.error("加载蒙版图像失败");
      ctx.value.clearRect(
        0,
        0,
        maskCanvas.value.width,
        maskCanvas.value.height
      );
      saveInitialState();
    };
    img.src = newMask.data;
  }
};
// 开始拖拽工具栏
const startDragToolbar = (e) => {
  // 阻止事件冒泡和默认行为
  e.stopPropagation();
  e.preventDefault();

  isDraggingToolbar.value = true;
  dragOffset.value = {
    x: e.clientX - toolbarPosition.value.x,
    y: e.clientY - toolbarPosition.value.y,
  };

  // 使用捕获阶段监听，确保我们的处理函数先执行
  document.addEventListener("mousemove", moveToolbar, {
    capture: true,
    passive: false,
  });
  document.addEventListener("mouseup", stopDragToolbar, { capture: true });
};

// 移动工具栏
const moveToolbar = (e) => {
  if (!isDraggingToolbar.value) return;

  // 阻止事件冒泡和默认行为
  e.stopPropagation();
  e.preventDefault();

  // 计算新位置
  const newX = e.clientX - dragOffset.value.x;
  const newY = e.clientY - dragOffset.value.y;

  // 获取容器边界
  const container = document.querySelector(".absolute.inset-0");
  if (container) {
    const rect = container.getBoundingClientRect();
    const toolbarEl = document.querySelector(".toolbar-container");
    if (toolbarEl) {
      const toolbarRect = toolbarEl.getBoundingClientRect();

      // 限制工具栏在容器内
      const maxX = rect.width - toolbarRect.width;
      const maxY = rect.height - toolbarRect.height;

      toolbarPosition.value = {
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      };
    } else {
      toolbarPosition.value = { x: newX, y: newY };
    }
  } else {
    toolbarPosition.value = { x: newX, y: newY };
  }
};
// 停止拖拽工具栏
const stopDragToolbar = (e) => {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }

  isDraggingToolbar.value = false;
  document.removeEventListener("mousemove", moveToolbar, { capture: true });
  document.removeEventListener("mouseup", stopDragToolbar, { capture: true });
};

const emit = defineEmits([
  "update:mask",
  "update:drawing-mode",
  "update:ctrl-pressed",
]);
// 生命周期
onMounted(() => {
  if (props.show) {
    initCanvas();
  }
  const primaryColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--q-primary")
    .trim();
  if (primaryColor) {
    brushColor.value = primaryColor;
  }
  // 设置工具栏初始位置在可见区域底部中间
  nextTick(() => {
    const container = document.querySelector(".absolute.inset-0");
    const toolbar = document.querySelector(".toolbar-container");
    if (container && toolbar) {
      const containerRect = container.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();

      // 计算底部中间位置
      toolbarPosition.value = {
        x: (containerRect.width - toolbarRect.width) / 2,
        y: containerRect.height - toolbarRect.height - 20, // 底部留20px边距
      };
    }
  });
});
// 在组件卸载时清理事件监听器
onUnmounted(() => {
  document.removeEventListener("mousemove", moveToolbar, { capture: true });
  document.removeEventListener("mouseup", stopDragToolbar, { capture: true });
});
// 快捷键
// Ctrl键监听器
useEventListener(window, "keydown", (e) => {
  if (props.show) {
    if (e.key === "z" && e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (e.key === "b") {
      e.preventDefault();
      toggleDrawing();
    } else if (e.key === "Control") {
      isCtrlPressed.value = true;
      // 通知父组件 Ctrl 键状态变化
      emit("update:ctrl-pressed", true);
    }
  }
});

// keyup监听器
useEventListener(window, "keyup", (e) => {
  if (e.key === "Control") {
    isCtrlPressed.value = false;
    // 通知父组件 Ctrl 键状态变化
    emit("update:ctrl-pressed", false);
    if (isDrawing.value) {
      stopDrawing();
    }
  }
});
// 确保全局监听鼠标移动以更新光标位置
useEventListener(window, "mousemove", (e) => {
  if (isDrawingMode.value || isCtrlPressed.value) {
    cursorPosition.value = {
      x: e.clientX,
      y: e.clientY,
    };
  }
});

watch(
  [
    () => ({ x: store.offsetX, y: store.offsetY, scale: store.scale }),
    () => ({ width: store.imageWidth, height: store.imageHeight }),
  ],
  ([position, size], [oldPosition, oldSize]) => {
    if (!props.show || !maskCanvas.value) return;

    const canvas = maskCanvas.value;

    const { x, y, scale } = position;
    const { width, height } = size;

    // 处理位置和缩放变化
    if (
      x !== oldPosition?.x ||
      y !== oldPosition?.y ||
      scale !== oldPosition?.scale
    ) {
      Object.assign(canvas.style, {
        left: `${x}px`,
        top: `${y}px`,
        transform: `scale(${scale})`,
      });
    }

    // 处理尺寸变化
    if (width !== oldSize?.width || height !== oldSize?.height) {
      initCanvas();
    }
  },
  { immediate: true, deep: true }
);
watch(
  () => props.mask,
  (newMask) => {
    if (!props.show || !ctx.value || !newMask) return;

    if (newMask instanceof ImageData) {
      ctx.value.putImageData(newMask, 0, 0);
      saveState();
    } else if (newMask.data && typeof newMask.data === "string") {
      const img = new Image();
      img.onload = () => {
        ctx.value.clearRect(
          0,
          0,
          maskCanvas.value.width,
          maskCanvas.value.height
        );
        ctx.value.drawImage(
          img,
          0,
          0,
          maskCanvas.value.width,
          maskCanvas.value.height
        );
        saveState();
      };
      img.src = newMask.data;
    }
  }
);
defineExpose({
  updateMask,
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
/* 自定义光标样式 */
.custom-cursor {
  position: fixed !important;
  pointer-events: none !important;
  z-index: 999 !important;
}
/* 确保工具栏始终可点击 */
.toolbar-container {
  z-index: 1001 !important;
  pointer-events: auto !important;
  position: absolute !important;
  touch-action: none;
  user-select: none;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
  border-radius: 50px !important; /* 胶囊形状 */
  overflow: hidden;
}
.toolbar-handle {
  cursor: move !important;
  border-top-left-radius: 50px !important;
  border-top-right-radius: 50px !important;
}
/* 胶囊形状的圆角类 */
.rounded-pill {
  border-radius: 50px !important;
}
.rounded-t-pill {
  border-top-left-radius: 50px !important;
  border-top-right-radius: 50px !important;
}
.rounded-b-pill {
  border-bottom-left-radius: 50px !important;
  border-bottom-right-radius: 50px !important;
  border: none !important;
}
.q-bar {
  border: none !important;
  background: transparent !important;
}
/* 按钮组样式 */
.q-btn-group.rounded-pill .q-btn:first-child {
  border-top-left-radius: 50px !important;
  border-bottom-left-radius: 50px !important;
}
.q-btn-group.rounded-pill .q-btn:last-child {
  border-top-right-radius: 50px !important;
  border-bottom-right-radius: 50px !important;
}
</style>
