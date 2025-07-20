<template>
  <div class="mask-configuration">
    <div v-if="activeMask" class="mask-config-panel">
      <h3>蒙版配置</h3>

      <!-- 基础信息 -->
      <div class="config-section">
        <h4>基础信息</h4>
        <q-input
          v-model="activeMask.name"
          label="蒙版名称"
          @update:model-value="updateMaskName"
        />

        <div class="frame-range">
          <q-input
            v-model.number="activeMask.start_frame"
            type="number"
            label="开始帧"
            :min="0"
            :max="videoInfo.totalFrames - 1"
            @update:model-value="updateFrameRange"
          />
          <q-input
            v-model.number="activeMask.end_frame"
            type="number"
            label="结束帧"
            :min="activeMask.start_frame"
            :max="videoInfo.totalFrames - 1"
            @update:model-value="updateFrameRange"
          />
        </div>

        <div class="time-range">
          <div>
            开始时间:
            {{ formatTime(activeMask.start_frame / videoInfo.frameRate) }}
          </div>
          <div>
            结束时间:
            {{ formatTime(activeMask.end_frame / videoInfo.frameRate) }}
          </div>
        </div>
      </div>

      <!-- 蒙版变化列表 -->
      <div class="config-section">
        <div class="section-header">
          <h4>蒙版变化</h4>
          <q-btn
            icon="add"
            size="sm"
            @click="addMaskOffset"
            :disable="!canAddOffset"
            label="添加变化点"
          />
        </div>

        <div class="offset-list">
          <div
            v-for="offset in activeMask.offsets"
            :key="offset.frame_index"
            class="offset-item"
            :class="{ current: offset.frame_index === currentFrame }"
          >
            <div class="offset-info">
              <div class="frame-number">第 {{ offset.frame_index }} 帧</div>
              <div class="offset-values">
                <span
                  >位移: ({{ offset.offset_x }}, {{ offset.offset_y }})</span
                >
                <span
                  >缩放: {{ offset.scale_x.toFixed(2) }}x{{
                    offset.scale_y.toFixed(2)
                  }}</span
                >
                <span>旋转: {{ offset.rotation.toFixed(1) }}°</span>
              </div>
            </div>

            <div class="offset-actions">
              <q-btn flat dense icon="edit" @click="editOffset(offset)" />
              <q-btn
                flat
                dense
                icon="delete"
                color="negative"
                @click="removeOffset(offset.frame_index)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="no-mask-selected">
      <q-icon name="info" size="48px" color="grey-5" />
      <p>请选择一个蒙版进行配置</p>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, watch } from "vue";
import { useQuasar } from "quasar";

const $q = useQuasar();

// Props
const props = defineProps({
  mask: {
    type: Object,
    default: null,
  },
  videoInfo: {
    type: Object,
    required: true,
  },
  currentFrame: {
    type: Number,
    default: 0,
  },
});

// Emits
const emit = defineEmits(["update-mask", "add-offset", "remove-offset"]);

// 响应式数据
const editingOffset = ref(null);

// 计算属性
const activeMask = computed(() => props.mask);

const canAddOffset = computed(() => {
  if (!activeMask.value) return false;

  // 检查当前帧是否在蒙版范围内
  if (
    props.currentFrame < activeMask.value.start_frame ||
    props.currentFrame > activeMask.value.end_frame
  ) {
    return false;
  }

  // 检查当前帧是否已有偏移
  return !activeMask.value.offsets.some(
    (offset) => offset.frame_index === props.currentFrame
  );
});

// 方法
const updateMaskName = (newName) => {
  if (activeMask.value) {
    emit("update-mask", { name: newName });
  }
};

const updateFrameRange = () => {
  if (activeMask.value) {
    // 确保结束帧不小于开始帧
    if (activeMask.value.end_frame < activeMask.value.start_frame) {
      activeMask.value.end_frame = activeMask.value.start_frame;
    }

    emit("update-mask", {
      start_frame: activeMask.value.start_frame,
      end_frame: activeMask.value.end_frame,
    });
  }
};

const addMaskOffset = () => {
  if (!canAddOffset.value) return;

  const newOffset = {
    frame_index: props.currentFrame,
    offset_x: 0,
    offset_y: 0,
    scale_x: 1.0,
    scale_y: 1.0,
    rotation: 0.0,
    opacity: 1.0,
  };

  emit("add-offset", props.currentFrame, newOffset);

  $q.notify({
    type: "positive",
    message: `已在第 ${props.currentFrame} 帧添加变化点`,
    position: "top",
  });
};

const editOffset = (offset) => {
  editingOffset.value = { ...offset };

  $q.dialog({
    title: `编辑第 ${offset.frame_index} 帧变化`,
    message: "请在视频编辑器中调整蒙版位置、大小和旋转",
    ok: {
      label: "完成编辑",
      color: "primary",
    },
    cancel: {
      label: "取消",
      color: "grey",
    },
  })
    .onOk(() => {
      // 编辑完成的逻辑
      editingOffset.value = null;
    })
    .onCancel(() => {
      editingOffset.value = null;
    });
};

const removeOffset = (frameIndex) => {
  $q.dialog({
    title: "确认删除",
    message: `确定要删除第 ${frameIndex} 帧的变化点吗？`,
    cancel: true,
    persistent: true,
  }).onOk(() => {
    emit("remove-offset", frameIndex);

    $q.notify({
      type: "info",
      message: `已删除第 ${frameIndex} 帧的变化点`,
      position: "top",
    });
  });
};

const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${minutes.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
};

// 监听器
// 监听器
watch(
  () => props.currentFrame,
  (newFrame) => {
    // 当前帧变化时，检查是否需要更新蒙版配置显示
    if (!activeMask.value) return;

    // 检查当前帧是否在活动蒙版的范围内
    const isInRange =
      newFrame >= activeMask.value.start_frame &&
      newFrame <= activeMask.value.end_frame;

    if (!isInRange) {
      // 如果当前帧不在蒙版范围内，可以显示提示或禁用某些操作
      console.log(
        `当前帧 ${newFrame} 不在蒙版 ${activeMask.value.name} 的范围内`
      );
    }

    // 检查当前帧是否有偏移数据
    const currentOffset = activeMask.value.offsets.find(
      (offset) => offset.frame_index === newFrame
    );

    if (currentOffset) {
      // 当前帧有偏移数据，可以高亮显示或提供编辑选项
      console.log(`当前帧 ${newFrame} 有偏移数据:`, currentOffset);
    }
  }
);

// 监听活动蒙版变化
watch(
  () => props.mask,
  (newMask, oldMask) => {
    if (newMask && newMask !== oldMask) {
      // 蒙版切换时重置编辑状态
      editingOffset.value = null;

      // 可以在这里添加蒙版切换的其他逻辑
      console.log("切换到蒙版:", newMask.name);
    }
  },
  { immediate: true }
);
</script>

<style scoped>
.mask-configuration {
  height: 100%;
  overflow-y: auto;
}

.mask-config-panel {
  padding: 16px;
}

.config-section {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
}

.config-section h4 {
  margin: 0 0 16px 0;
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.frame-range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.time-range {
  font-size: 12px;
  color: #666;
  line-height: 1.4;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h4 {
  margin: 0;
}

.offset-list {
  max-height: 300px;
  overflow-y: auto;
}

.offset-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.offset-item:hover {
  background-color: #f5f5f5;
}

.offset-item.current {
  background-color: #e3f2fd;
  border-color: #1976d2;
}

.offset-info {
  flex: 1;
}

.frame-number {
  font-weight: 500;
  margin-bottom: 4px;
}

.offset-values {
  font-size: 12px;
  color: #666;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.offset-actions {
  display: flex;
  gap: 4px;
}

.no-mask-selected {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: #999;
}

.no-mask-selected p {
  margin: 16px 0 0 0;
  font-size: 14px;
}
</style>
