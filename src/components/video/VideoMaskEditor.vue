<template>
  <div v-if="videoStore.selectedMask" class="mask-editor">
    <q-expansion-item
      v-model="sections.brush"
      dense
      dense-toggle
      expand-separator
      label="画笔与蒙版"
      icon="brush"
      class="editor-section"
    >
      <div class="section-body tool-section">
        <MaskBrushControls
          :drawing-enabled="videoStore.maskTool.drawingEnabled"
          :mode="videoStore.maskTool.mode"
          :brush-size="videoStore.maskTool.brushSize"
          :brush-color="videoStore.maskTool.brushColor"
          :brush-alpha="videoStore.maskTool.brushAlpha"
          :can-undo="videoStore.canUndoSelectedMaskDraw"
          :button-size="controlButtonSize"
          :disabled="disabled"
          @toggle-drawing="
            videoStore.updateMaskTool({
              drawingEnabled: !videoStore.maskTool.drawingEnabled,
            })
          "
          @update:mode="videoStore.updateMaskTool({ mode: $event })"
          @update:brush-size="videoStore.updateMaskTool({ brushSize: $event })"
          @update:brush-color="videoStore.updateMaskTool({ brushColor: $event })"
          @update:brush-alpha="videoStore.updateMaskTool({ brushAlpha: $event })"
          @undo="undoDraw"
          @clear="clearMask"
        />

        <q-select
          :model-value="videoStore.selectedMask.interpolation"
          :disable="disabled"
          label="关键帧插值"
          emit-value
          map-options
          :options="[
            { label: '线性', value: 'linear' },
            { label: '缓入缓出', value: 'ease-in-out' },
          ]"
          @update:model-value="videoStore.updateSelectedMask({ interpolation: $event })"
        />
      </div>
    </q-expansion-item>

    <q-expansion-item
      v-model="sections.range"
      dense
      dense-toggle
      expand-separator
      label="蒙版范围编辑"
      icon="schedule"
      class="editor-section"
    >
      <div class="section-body">
        <div class="row q-col-gutter-sm">
          <div class="col-12">
            <q-input
              :model-value="videoStore.selectedMask.startTime"
              type="number"
              label="开始时间"
              :disable="disabled"
              :step="0.01"
              @update:model-value="updateRangeField('startTime', $event)"
            />
          </div>
          <div class="col-12">
            <q-btn
              outline
              color="primary"
              icon="first_page"
              label="以当前时间开始"
              class="full-width"
              :disable="disabled"
              @click="setStartFromCurrentTime"
            />
          </div>
        </div>

        <div class="row q-col-gutter-sm q-mt-sm">
          <div class="col-12">
            <q-input
              :model-value="videoStore.selectedMask.endTime"
              type="number"
              label="结束时间"
              :disable="disabled"
              :step="0.01"
              @update:model-value="updateRangeField('endTime', $event)"
            />
          </div>
          <div class="col-12">
            <q-btn
              outline
              color="primary"
              icon="last_page"
              label="以当前时间结束"
              class="full-width"
              :disable="disabled"
              @click="setEndFromCurrentTime"
            />
          </div>
        </div>
      </div>
    </q-expansion-item>

    <q-expansion-item
      v-model="sections.keyframes"
      dense
      dense-toggle
      expand-separator
      label="关键帧编辑"
      icon="timeline"
      class="editor-section"
    >
      <div class="section-body">
        <div class="keyframe-toolbar">
          <q-btn
            dense
            color="primary"
            icon="add"
            label="在当前时间添加关键帧"
            :disable="disabled"
            @click="createKeyframeAtCurrentTime"
          />
        </div>

        <q-list bordered separator class="keyframe-list">
          <q-expansion-item
            v-for="keyframe in orderedKeyframes"
            :key="keyframe.id"
            dense
            expand-separator
            switch-toggle-side
            :model-value="keyframe.id === videoStore.selectedKeyframeId"
            @update:model-value="handleKeyframeExpand(keyframe, $event)"
          >
            <template #header>
              <q-item-section>
                <q-item-label class="row items-center justify-between no-wrap">
                  <span class="ellipsis">{{ getKeyframeTitle(keyframe) }}</span>
                  <q-chip
                    v-if="keyframe.type === MASK_KEYFRAME_TYPES.END"
                    dense
                    square
                    size="sm"
                    :color="videoStore.selectedMask.endStateExplicit ? 'primary' : 'grey-6'"
                    text-color="white"
                  >
                    {{ videoStore.selectedMask.endStateExplicit ? "独立" : "继承" }}
                  </q-chip>
                </q-item-label>
                <q-item-label caption>{{ formatSeconds(keyframe.time) }}</q-item-label>
              </q-item-section>
            </template>

            <div class="keyframe-form-wrap q-pa-md q-pt-sm">
              <div class="text-caption text-grey-6 q-mb-sm">
                {{ getKeyframeDescription(keyframe) }}
              </div>

              <div class="row q-col-gutter-sm">
                <div class="col-12">
                  <q-input
                    :model-value="keyframe.time"
                    type="number"
                    label="时间"
                    :disable="disabled || !canEditTime(keyframe)"
                    :step="0.01"
                    @update:model-value="updateKeyframeField(keyframe, 'time', $event)"
                  />
                </div>
              </div>

              <div class="row q-col-gutter-sm">
                <div class="col-6">
                  <q-input
                    :model-value="keyframe.x"
                    type="number"
                    label="X"
                    :disable="disabled || !canEditTransform(keyframe)"
                    :step="1"
                    @update:model-value="updateKeyframeField(keyframe, 'x', $event)"
                  />
                </div>
                <div class="col-6">
                  <q-input
                    :model-value="keyframe.y"
                    type="number"
                    label="Y"
                    :disable="disabled || !canEditTransform(keyframe)"
                    :step="1"
                    @update:model-value="updateKeyframeField(keyframe, 'y', $event)"
                  />
                </div>
              </div>

              <q-input
                :model-value="keyframe.scale"
                type="number"
                label="缩放"
                :disable="disabled || !canEditTransform(keyframe)"
                :step="0.01"
                @update:model-value="updateKeyframeField(keyframe, 'scale', $event)"
              />

              <q-banner
                v-if="keyframe.type === MASK_KEYFRAME_TYPES.END"
                dense
                rounded
                class="bg-grey-2 text-grey-8 q-mt-sm"
              >
                结束关键帧的时间始终跟随蒙版结束时间。手动修改任一字段后，会切换为独立状态。
              </q-banner>

              <q-btn
                v-if="canDeleteKeyframe(keyframe)"
                color="negative"
                icon="delete"
                label="删除此关键帧"
                outline
                :disable="disabled"
                class="q-mt-md"
                @click="removeKeyframe(keyframe)"
              />
            </div>
          </q-expansion-item>
        </q-list>
      </div>
    </q-expansion-item>
  </div>

  <div v-else class="empty-state">
    先从左侧创建并选中一个蒙版，然后在这里编辑画笔、范围和关键帧。
  </div>
</template>

<script setup>
import { useQuasar } from "quasar";
import { computed, reactive } from "vue";

import MaskBrushControls from "src/components/common/MaskBrushControls.vue";
import { normalizeButtonSize } from "src/config/ConfigManager";
import { useConfigStore } from "src/stores/config";
import { useVideoManagerStore } from "src/stores/videoManager";
import { createTransparentMaskDataUrl } from "src/utils/maskTool";
import { formatSeconds, MASK_KEYFRAME_TYPES, parseNumeric } from "src/utils/videoMaskUtils";

defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
});

const $q = useQuasar();
const configStore = useConfigStore();
const videoStore = useVideoManagerStore();
const controlButtonSize = computed(() =>
  normalizeButtonSize(configStore.config.ui?.buttonSize)
);

const sections = reactive({
  brush: true,
  range: false,
  keyframes: true,
});

const orderedKeyframes = computed(() => videoStore.selectedMaskOrderedKeyframes);

const getKeyframeTitle = (keyframe) => {
  if (keyframe.type === MASK_KEYFRAME_TYPES.START) return "起始关键帧";
  if (keyframe.type === MASK_KEYFRAME_TYPES.END) return "结束关键帧";

  const index = orderedKeyframes.value
    .filter((item) => item.type === MASK_KEYFRAME_TYPES.USER)
    .findIndex((item) => item.id === keyframe.id);
  return `关键帧 ${index + 1}`;
};

const getKeyframeDescription = (keyframe) => {
  if (keyframe.type === MASK_KEYFRAME_TYPES.START) {
    return "起始关键帧不可编辑。";
  }

  if (keyframe.type === MASK_KEYFRAME_TYPES.END) {
    return videoStore.selectedMask?.endStateExplicit
      ? "结束关键帧当前为独立状态。"
      : "结束关键帧当前继承上一个关键帧的状态。";
  }

  return "用户关键帧可编辑时间、位置和缩放。";
};

const showWarning = (message) => {
  $q.notify({
    type: "warning",
    message,
    timeout: 2500,
  });
};

const clearMask = () => {
  if (!videoStore.selectedMaskId) return;
  videoStore.commitSelectedMaskBaseMask(
    createTransparentMaskDataUrl(videoStore.videoWidth, videoStore.videoHeight)
  );
};

const undoDraw = () => {
  if (!videoStore.selectedMaskId) return;
  videoStore.undoSelectedMaskDraw();
};

const createKeyframeAtCurrentTime = () => {
  if (!videoStore.selectedMaskId) return;

  const result = videoStore.createUserKeyframe(
    videoStore.selectedMaskId,
    {
      time: videoStore.currentTime,
    },
    {
      reuseExisting: true,
      select: true,
    }
  );

  if (!result.ok) {
    showWarning(result.error || "关键帧创建失败。");
  }
};

const canEditTime = (keyframe) => keyframe.type === MASK_KEYFRAME_TYPES.USER;
const canEditTransform = (keyframe) =>
  keyframe.type === MASK_KEYFRAME_TYPES.USER || keyframe.type === MASK_KEYFRAME_TYPES.END;
const canDeleteKeyframe = (keyframe) => keyframe.type === MASK_KEYFRAME_TYPES.USER;

const handleKeyframeExpand = (keyframe, expanded) => {
  if (!videoStore.selectedMaskId) return;

  if (!expanded) {
    if (videoStore.selectedKeyframeId === keyframe.id) {
      videoStore.selectMask(videoStore.selectedMaskId, null);
    }
    return;
  }

  videoStore.selectKeyframe(videoStore.selectedMaskId, keyframe.id);
};

const updateKeyframeField = (keyframe, field, value) => {
  const mask = videoStore.selectedMask;
  if (!keyframe || !mask) return;

  const nextValue =
    field === "time"
      ? parseNumeric(value, keyframe.time)
      : parseNumeric(value, keyframe[field]);

  const result = videoStore.upsertKeyframe(mask.id, {
    id: keyframe.id,
    [field]: nextValue,
  });

  if (!result.ok) {
    showWarning(result.error || "关键帧更新失败。");
  }
};

const removeKeyframe = (keyframe) => {
  if (!videoStore.selectedMaskId || !keyframe?.id) return;

  const result = videoStore.removeKeyframe(videoStore.selectedMaskId, keyframe.id);
  if (!result.ok) {
    showWarning(result.error || "关键帧删除失败。");
  }
};

const confirmOverflowKeyframeDeletion = (overflowKeyframes = []) =>
  new Promise((resolve) => {
    const timeList = overflowKeyframes.map((item) => formatSeconds(item.time)).join("、");
    $q.dialog({
      title: "删除越界关键帧？",
      message:
        overflowKeyframes.length > 0
          ? `调整后的蒙版区间会删除 ${overflowKeyframes.length} 个越界关键帧：${timeList}`
          : "调整后的蒙版区间会删除越界关键帧。",
      ok: {
        label: "删除",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "取消",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });

const commitRangeUpdate = async (nextRange) => {
  if (!videoStore.selectedMaskId) return;

  const result = videoStore.resizeMaskRange(videoStore.selectedMaskId, nextRange, {
    deleteOverflow: false,
  });

  if (!result.ok && result.code === "overflow-user-keyframes") {
    const confirmed = await confirmOverflowKeyframeDeletion(result.overflowKeyframes);
    if (!confirmed) return;

    const confirmedResult = videoStore.resizeMaskRange(
      videoStore.selectedMaskId,
      {
        startTime: result.startTime,
        endTime: result.endTime,
      },
      {
        deleteOverflow: true,
      }
    );

    if (!confirmedResult.ok) {
      showWarning(confirmedResult.error || "蒙版范围更新失败。");
    }
    return;
  }

  if (!result.ok) {
    showWarning(result.error || "蒙版范围更新失败。");
  }
};

const updateRangeField = async (field, value) => {
  const mask = videoStore.selectedMask;
  if (!mask) return;

  const nextValue = parseNumeric(value, mask[field]);
  await commitRangeUpdate({
    startTime: field === "startTime" ? nextValue : mask.startTime,
    endTime: field === "endTime" ? nextValue : mask.endTime,
  });
};

const setStartFromCurrentTime = async () => {
  const mask = videoStore.selectedMask;
  if (!mask) return;

  await commitRangeUpdate({
    startTime: videoStore.currentTime,
    endTime: mask.endTime,
  });
};

const setEndFromCurrentTime = async () => {
  const mask = videoStore.selectedMask;
  if (!mask) return;

  await commitRangeUpdate({
    startTime: mask.startTime,
    endTime: videoStore.currentTime,
  });
};
</script>

<style scoped>
.mask-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-section {
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 10px;
  overflow: hidden;
}

.section-body {
  padding: 12px;
}

.tool-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.keyframe-toolbar {
  display: flex;
  justify-content: flex-start;
  margin-bottom: 12px;
}

.keyframe-list {
  overflow: hidden;
}

.keyframe-form-wrap {
  border-top: 1px solid rgba(17, 24, 39, 0.06);
}

.empty-state {
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  text-align: center;
  padding: 20px;
}
</style>
