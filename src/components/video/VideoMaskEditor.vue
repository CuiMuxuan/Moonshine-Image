<template>
  <div v-if="isSlbrModel" class="mask-editor">
    <q-banner
      dense
      rounded
      class="slbr-range-hint"
      :class="$q.dark.isActive ? 'text-secondary' : 'text-grey-9'"
    >
      当前模型无需蒙版，但可以通过改变时间轴轨道范围的方式来设定视频处理的范围，以减少视频处理的时间。
    </q-banner>

    <q-expansion-item
      v-if="videoStore.selectedProcessingRange"
      v-model="sections.processingRange"
      dense
      dense-toggle
      expand-separator
      label="处理范围编辑"
      icon="schedule"
      class="editor-section"
    >
      <div class="section-body">
        <q-input
          :model-value="videoStore.selectedProcessingRange.name"
          label="范围名称"
          :disable="disabled"
          @update:model-value="updateProcessingRangeName"
        />

        <div class="row q-col-gutter-sm q-mt-sm">
          <div class="col-12">
            <q-input
              :model-value="videoStore.selectedProcessingRange.startTime"
              type="number"
              label="开始时间"
              :disable="disabled"
              :step="0.01"
              @update:model-value="updateProcessingRangeField('startTime', $event)"
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
              @click="setProcessingRangeStartFromCurrentTime"
            />
          </div>
        </div>

        <div class="row q-col-gutter-sm q-mt-sm">
          <div class="col-12">
            <q-input
              :model-value="videoStore.selectedProcessingRange.endTime"
              type="number"
              label="结束时间"
              :disable="disabled"
              :step="0.01"
              @update:model-value="updateProcessingRangeField('endTime', $event)"
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
              @click="setProcessingRangeEndFromCurrentTime"
            />
          </div>
        </div>
      </div>
    </q-expansion-item>

    <div v-else class="empty-state empty-state--slbr">
      未增加范围时会处理完整视频。点击左侧“增加范围”后，可在这里精确编辑开始和结束时间。
    </div>
  </div>

  <div v-else-if="videoStore.selectedMask?.type === 'samVideo'" class="mask-editor">
    <q-input
      :model-value="videoStore.selectedMask.name"
      dense
      outlined
      label="轨道名称"
      :disable="disabled"
      @update:model-value="updateSelectedMaskName"
    />

    <q-banner
      dense
      rounded
      class="sam-track-hint"
      :class="$q.dark.isActive ? 'text-amber-2' : 'text-grey-9'"
    >
      智能选区轨道使用 SAM2.1 点选/框选传播生成，默认占满全部视频时长，范围和关键帧不可编辑。
    </q-banner>

    <q-expansion-item
      v-model="sections.brush"
      dense
      dense-toggle
      expand-separator
      label="智能选区工具"
      icon="auto_awesome_motion"
      class="editor-section sam-smart-tool-section"
      data-testid="video-sam-smart-tool-section"
    >
      <div class="section-body sam-smart-tool-body">
        <div class="sam-tool-row sam-tool-row--compact">
          <q-btn-group flat class="sam-video-tool-group rounded-pill overflow-hidden">
            <q-btn
              color="primary"
              text-color="white"
              icon="tune"
              :disable="disabled || samVideoRunning"
              data-testid="video-sam-settings-button"
            >
              <q-tooltip>智能选区设置</q-tooltip>
              <q-menu
                anchor="bottom middle"
                self="top middle"
                :offset="[0, 10]"
                content-class="video-sam-settings-popup"
              >
                <div class="video-sam-settings-panel q-pa-md">
                  <div class="video-sam-popup-header">
                    <div class="video-sam-settings-title">智能选区设置</div>
                    <q-btn
                      flat
                      round
                      dense
                      icon="close"
                      v-close-popup
                      data-testid="video-sam-settings-close-button"
                    >
                      <q-tooltip>关闭</q-tooltip>
                    </q-btn>
                  </div>
                  <div class="video-sam-settings-item">
                    <div class="text-caption text-grey-7">当前点选/框选模型</div>
                    <div class="text-body2">SAM2.1 视频传播</div>
                  </div>
                  <q-separator />
                  <div class="video-sam-settings-item is-disabled">
                    <div class="text-caption text-grey-7">SAM3 文本视频智选</div>
                    <div class="text-body2">后续支持：文本找目标后自动进行视频传播。</div>
                    <q-chip dense square color="grey-5" text-color="white">暂未启用</q-chip>
                  </div>
                </div>
              </q-menu>
            </q-btn>
            <q-btn
              color="primary"
              text-color="white"
              icon="ads_click"
              data-testid="video-sam-select-tool-button"
              :disable="disabled || samVideoRunning"
            >
              <q-tooltip>点选/框选对象：单击点选，拖拽框选</q-tooltip>
            </q-btn>
            <q-btn
              icon="clear"
              :disable="disabled || samVideoRunning || !hasSamVideoResult"
              :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
              data-testid="video-sam-clear-result-button"
              @click="emit('clear-sam-video-result')"
            >
              <q-tooltip>清空提示、候选对象和传播结果</q-tooltip>
            </q-btn>
          </q-btn-group>
        </div>

        <div class="sam-tool-row">
          <q-btn
            color="primary"
            icon="auto_fix_high"
            label="运行智能选区"
            no-caps
            unelevated
            class="sam-run-button"
            :loading="samVideoRunning"
            :disable="disabled || !canRunSamVideo"
            @click="emit('run-sam-video-selection')"
          />
        </div>

        <div class="sam-smart-hint text-caption">
          {{ samSmartToolHint }}
        </div>

        <q-list
          v-if="samPromptObjects.length"
          dense
          bordered
          separator
          class="sam-prompt-list"
          data-testid="video-sam-prompt-list"
        >
          <q-item
            v-for="prompt in samPromptObjects"
            :key="`prompt-${prompt.objectId}`"
            clickable
            :disable="disabled || samVideoRunning"
            @click="seekToSamPromptFrame(prompt)"
          >
            <q-item-section>
              <q-item-label>对象 {{ prompt.objectId }}</q-item-label>
              <q-item-label caption>
                帧 {{ prompt.frameIndex }} · {{ prompt.box ? "框选" : "点选" }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                flat
                round
                dense
                color="negative"
                icon="delete"
                :disable="disabled || samVideoRunning"
                @click.stop="videoStore.removeSamVideoPromptObject(videoStore.selectedMaskId, prompt.objectId)"
              >
                <q-tooltip>删除待选对象</q-tooltip>
              </q-btn>
            </q-item-section>
          </q-item>
        </q-list>

        <q-linear-progress
          v-if="samVideoRunning || samVideoProgress > 0"
          :value="samVideoProgress"
          color="primary"
          rounded
        />

        <div
          v-if="samVideoMessage"
          class="sam-video-message"
          :class="{ 'sam-video-message--error': samVideoError }"
        >
          {{ samVideoMessage }}
        </div>

      </div>
    </q-expansion-item>

    <q-expansion-item
      v-model="sections.keyframes"
      dense
      dense-toggle
      expand-separator
      label="候选蒙版列表"
      icon="format_list_bulleted"
      class="editor-section"
      data-testid="video-sam-candidate-list-section"
    >
      <div class="section-body">
        <q-list bordered separator class="sam-track-object-list">
          <q-item
            v-for="objectItem in samObjects"
            :key="objectItem.objectId"
            clickable
            :disable="disabled || samVideoRunning"
            @click="seekToSamPromptFrame(objectItem.objectId)"
          >
            <q-item-section>
              <q-item-label>对象 {{ objectItem.objectId }}</q-item-label>
              <q-item-label caption>
                {{ objectItem.enabled === false ? "已隐藏" : "已启用" }} ·
                {{ objectItem.hasBox ? "框选传播" : "点选传播" }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <div class="row items-center no-wrap q-gutter-xs">
                <q-toggle
                  dense
                  :model-value="objectItem.enabled !== false"
                  :disable="disabled || samVideoRunning"
                  @update:model-value="
                    (value) =>
                      videoStore.setSamVideoObjectEnabled(
                        videoStore.selectedMaskId,
                        objectItem.objectId,
                        value
                      )
                  "
                  @click.stop
                />
                <q-input
                  v-if="isLamaModel"
                  :model-value="objectItem.expandPx ?? objectItem.autoExpandPx ?? 0"
                  type="number"
                  dense
                  outlined
                  min="0"
                  max="99"
                  step="1"
                  suffix="px"
                  class="sam-object-expand-input"
                  input-class="text-center"
                  :disable="disabled || samVideoRunning"
                  @update:model-value="setSamVideoObjectExpandPx(objectItem.objectId, $event)"
                  @click.stop
                >
                  <q-tooltip>LaMa 扩边大小</q-tooltip>
                </q-input>
                <q-btn
                  flat
                  round
                  dense
                  color="negative"
                  icon="delete"
                  :disable="disabled || samVideoRunning"
                  @click.stop="emit('remove-sam-video-object', objectItem.objectId)"
                >
                  <q-tooltip>删除候选对象</q-tooltip>
                </q-btn>
              </div>
            </q-item-section>
          </q-item>

          <q-item v-if="samObjects.length === 0">
            <q-item-section class="text-grey-6">
              还没有候选对象。先在画面上点选/框选目标，再运行智能选区。
            </q-item-section>
          </q-item>
        </q-list>
      </div>
    </q-expansion-item>
  </div>

  <div v-else-if="videoStore.selectedMask" class="mask-editor">
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
          layout="video-sidebar"
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
            outline
            color="primary"
            icon="add"
            label="在当前时间添加关键帧"
            class="full-width"
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
                <div class="col-6">
                  <q-input
                    :model-value="keyframe.time"
                    type="number"
                    label="时间"
                    :disable="disabled || !canEditTime(keyframe)"
                    :step="0.01"
                    @update:model-value="updateKeyframeField(keyframe, 'time', $event)"
                  />
                </div>
                <div class="col-6">
                  <q-input
                    v-if="!showRestoreOriginalAction(keyframe)"
                    :model-value="getKeyframeScaleValue(keyframe)"
                    type="number"
                    label="缩放"
                    :disable="disabled || !canEditTransform(keyframe)"
                    :step="0.01"
                    @update:model-value="updateKeyframeUniformScale(keyframe, $event)"
                  />

                  <div v-else class="keyframe-inline-action">
                    <q-btn
                      color="primary"
                      icon="undo"
                      label="复原"
                      outline
                      :disable="disabled || !canEditTransform(keyframe)"
                      class="full-width"
                      @click="restoreKeyframeOriginalShape(keyframe)"
                    />
                  </div>
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

              <div v-if="canDeleteKeyframe(keyframe)" class="keyframe-delete-action q-mt-md">
                <q-btn
                  color="negative"
                  icon="delete"
                  label="删除此关键帧"
                  outline
                  :disable="disabled"
                  @click="removeKeyframe(keyframe)"
                />
              </div>
              <q-banner
                v-if="keyframe.type === MASK_KEYFRAME_TYPES.END"
                dense
                rounded
                class="bg-grey-2 text-grey-8 q-mt-sm"
              >
                结束关键帧的时间始终跟随蒙版结束时间。手动修改任一字段后，会切换为独立状态。
              </q-banner>
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
import { computed, reactive, watch } from "vue";

import MaskBrushControls from "src/components/common/MaskBrushControls.vue";
import { normalizeButtonSize } from "src/config/ConfigManager";
import { useConfigStore } from "src/stores/config";
import { useVideoManagerStore } from "src/stores/videoManager";
import { createTransparentMaskDataUrl } from "src/utils/maskTool";
import {
  createMaskTransformFromRenderedCenter,
  formatSeconds,
  getMaskBoundsFromDataUrl,
  getMaskKeyframeTransform,
  getMaskKeyframeUniformScale,
  getRenderedMaskCenter,
  getVideoCenterAnchor,
  isMaskKeyframeDeformed,
  MASK_KEYFRAME_TYPES,
  parseNumeric,
} from "src/utils/videoMaskUtils";

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  sectionState: {
    type: Object,
    default: () => ({}),
  },
  samVideoRunning: {
    type: Boolean,
    default: false,
  },
  samVideoProgress: {
    type: Number,
    default: 0,
  },
  samVideoMessage: {
    type: String,
    default: "",
  },
  samVideoError: {
    type: String,
    default: "",
  },
  hasSamVideoResult: {
    type: Boolean,
    default: false,
  },
  canRunSamVideo: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits([
  "update:sectionState",
  "run-sam-video-selection",
  "clear-sam-video-result",
  "remove-sam-video-object",
]);

const $q = useQuasar();
const configStore = useConfigStore();
const videoStore = useVideoManagerStore();
const controlButtonSize = computed(() =>
  normalizeButtonSize(configStore.config.ui?.buttonSize)
);
const isSlbrModel = computed(() => props.currentModel === "slbr");
const isLamaModel = computed(() => String(props.currentModel || "").toLowerCase() === "lama");
const DEFAULT_SECTION_STATE = Object.freeze({
  brush: true,
  range: false,
  keyframes: true,
  processingRange: true,
});
const normalizeSectionState = (value = {}) => ({
  brush: value.brush !== undefined ? Boolean(value.brush) : DEFAULT_SECTION_STATE.brush,
  range: value.range !== undefined ? Boolean(value.range) : DEFAULT_SECTION_STATE.range,
  keyframes:
    value.keyframes !== undefined ? Boolean(value.keyframes) : DEFAULT_SECTION_STATE.keyframes,
  processingRange:
    value.processingRange !== undefined
      ? Boolean(value.processingRange)
      : DEFAULT_SECTION_STATE.processingRange,
});

const sections = reactive(normalizeSectionState(props.sectionState));
let syncingSectionsFromProps = false;

watch(
  () => props.sectionState,
  (value) => {
    const normalized = normalizeSectionState(value || {});
    syncingSectionsFromProps = true;
    sections.brush = normalized.brush;
    sections.range = normalized.range;
    sections.keyframes = normalized.keyframes;
    sections.processingRange = normalized.processingRange;
    syncingSectionsFromProps = false;
  },
  { deep: true, immediate: true }
);

watch(
  sections,
  (value) => {
    if (syncingSectionsFromProps) return;
    emit("update:sectionState", normalizeSectionState(value));
  },
  { deep: true }
);

const orderedKeyframes = computed(() => videoStore.selectedMaskOrderedKeyframes);
const samPromptObjects = computed(() => videoStore.selectedMask?.samPromptObjects || []);
const samObjects = computed(() => videoStore.selectedMask?.samObjects || []);
const samSmartToolHint = computed(() => {
  const promptCount = samPromptObjects.value.length;
  const frameIndex = videoStore.selectedMask?.samPromptFrameIndex;
  if (!promptCount) return "在预览画面中点击添加点选对象，拖拽添加框选对象。";
  return `已添加 ${promptCount} 个对象提示${Number.isInteger(frameIndex) ? `，提示帧 ${frameIndex}` : ""}。运行后会双向传播覆盖整段视频。`;
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeExpandPx = (value, fallback = 0) =>
  Math.max(0, Math.min(99, Math.round(Number.isFinite(Number(value)) ? Number(value) : Number(fallback) || 0)));

const setSamVideoObjectExpandPx = (objectId, value) => {
  videoStore.setSamVideoObjectExpandPx(
    videoStore.selectedMaskId,
    objectId,
    normalizeExpandPx(value)
  );
};

const getSamPromptForObject = (promptOrObjectId) => {
  if (typeof promptOrObjectId === "object" && promptOrObjectId !== null) {
    return promptOrObjectId;
  }
  const objectId = Number(promptOrObjectId);
  return samPromptObjects.value.find((item) => Number(item.objectId) === objectId) || null;
};

const seekToSamPromptFrame = (promptOrObjectId) => {
  const prompt = getSamPromptForObject(promptOrObjectId);
  if (!prompt) return;
  const fps = Math.max(1, Number(videoStore.selectedMask?.sourceFrameRate || videoStore.sourceFrameRate || 30));
  const frameIndex = Math.max(0, Math.floor(Number(prompt.frameIndex || 0)));
  const duration = Math.max(0, Number(videoStore.videoDuration || 0));
  videoStore.setCurrentTime(clamp(frameIndex / fps, 0, duration));
};

const getFallbackBounds = () => {
  const width = Math.max(1, Number(videoStore.videoWidth || 1));
  const height = Math.max(1, Number(videoStore.videoHeight || 1));
  const side = Math.max(96, Math.round(Math.min(width, height) * 0.2));
  return {
    x: (width - side) / 2,
    y: (height - side) / 2,
    width: side,
    height: side,
    centerX: width / 2,
    centerY: height / 2,
  };
};

const resolveMaskBounds = async (mask) => {
  if (!mask?.baseMaskDataUrl) return getFallbackBounds();

  try {
    return (await getMaskBoundsFromDataUrl(mask.baseMaskDataUrl)) || getFallbackBounds();
  } catch {
    return getFallbackBounds();
  }
};

const getKeyframeTitle = (keyframe) => {
  if (keyframe.type === MASK_KEYFRAME_TYPES.START) return "起始关键帧";
  if (keyframe.type === MASK_KEYFRAME_TYPES.END) return "结束关键帧";

  const index = orderedKeyframes.value
    .filter((item) => item.type === MASK_KEYFRAME_TYPES.USER)
    .findIndex((item) => item.id === keyframe.id);
  return `关键帧 ${index + 1}`;
};

const showRestoreOriginalAction = (keyframe) =>
  canEditTransform(keyframe) &&
  !videoStore.isKeyframeDeformationUiDeferred(keyframe?.id) &&
  isMaskKeyframeDeformed(keyframe);

const getKeyframeDescription = (keyframe) => {
  if (keyframe.type === MASK_KEYFRAME_TYPES.START) {
    return "起始关键帧不可编辑。";
  }

  if (keyframe.type === MASK_KEYFRAME_TYPES.END) {
    if (showRestoreOriginalAction(keyframe)) {
      return "结束关键帧当前存在非等比缩放，可恢复到上一关键帧形状。";
    }
    return videoStore.selectedMask?.endStateExplicit
      ? "结束关键帧当前为独立状态。"
      : "结束关键帧当前继承上一个关键帧的状态。";
  }

  if (showRestoreOriginalAction(keyframe)) {
    return "当前关键帧存在形变，可恢复到该上一关键帧形状。";
  }

  return "关键帧可编辑时间、位置和缩放。";
};

const updateSelectedMaskName = (value) => {
  if (!videoStore.selectedMaskId) return;
  videoStore.renameMask(videoStore.selectedMaskId, String(value || "").trim() || "SAM 轨道");
};

const getKeyframeScaleValue = (keyframe) => getMaskKeyframeUniformScale(keyframe);

const showWarning = (message) => {
  $q.notify({
    type: "warning",
    message,
    timeout: 2500,
  });
};

const clearMask = () => {
  if (!videoStore.selectedMaskId || videoStore.selectedMask?.type === "samVideo") return;
  videoStore.commitSelectedMaskBaseMask(
    createTransparentMaskDataUrl(videoStore.videoWidth, videoStore.videoHeight)
  );
};

const undoDraw = () => {
  if (!videoStore.selectedMaskId || videoStore.selectedMask?.type === "samVideo") return;
  videoStore.undoSelectedMaskDraw();
};

const createKeyframeAtCurrentTime = () => {
  if (!videoStore.selectedMaskId || videoStore.selectedMask?.type === "samVideo") return;

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

const canEditTime = (keyframe) =>
  videoStore.selectedMask?.type !== "samVideo" && keyframe.type === MASK_KEYFRAME_TYPES.USER;
const canEditTransform = (keyframe) =>
  videoStore.selectedMask?.type !== "samVideo" &&
  (keyframe.type === MASK_KEYFRAME_TYPES.USER || keyframe.type === MASK_KEYFRAME_TYPES.END);
const canDeleteKeyframe = (keyframe) =>
  videoStore.selectedMask?.type !== "samVideo" && keyframe.type === MASK_KEYFRAME_TYPES.USER;

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

const updateKeyframeUniformScale = async (keyframe, value) => {
  const mask = videoStore.selectedMask;
  if (!keyframe || !mask) return;

  const currentTransform = getMaskKeyframeTransform(keyframe);
  const nextScale = Math.max(0.05, parseNumeric(value, getKeyframeScaleValue(keyframe)));
  const bounds = await resolveMaskBounds(mask);
  const anchor = getVideoCenterAnchor(videoStore.videoWidth || 1, videoStore.videoHeight || 1);
  const center = getRenderedMaskCenter(bounds, currentTransform, anchor);
  const nextTransform = createMaskTransformFromRenderedCenter({
    bounds,
    center,
    scaleX: currentTransform.originScaleX * nextScale,
    scaleY: currentTransform.originScaleY * nextScale,
    anchor,
    originScaleX: currentTransform.originScaleX,
    originScaleY: currentTransform.originScaleY,
  });

  const result = videoStore.upsertKeyframe(mask.id, {
    id: keyframe.id,
    ...nextTransform,
  });

  if (!result.ok) {
    showWarning(result.error || "关键帧缩放更新失败。");
  }
};

const restoreKeyframeOriginalShape = async (keyframe) => {
  const mask = videoStore.selectedMask;
  if (!keyframe || !mask) return;

  const currentTransform = getMaskKeyframeTransform(keyframe);
  const bounds = await resolveMaskBounds(mask);
  const anchor = getVideoCenterAnchor(videoStore.videoWidth || 1, videoStore.videoHeight || 1);
  const center = getRenderedMaskCenter(bounds, currentTransform, anchor);
  const nextTransform = createMaskTransformFromRenderedCenter({
    bounds,
    center,
    scaleX: currentTransform.originScaleX,
    scaleY: currentTransform.originScaleY,
    anchor,
    originScaleX: currentTransform.originScaleX,
    originScaleY: currentTransform.originScaleY,
  });

  const result = videoStore.upsertKeyframe(mask.id, {
    id: keyframe.id,
    ...nextTransform,
  });

  if (!result.ok) {
    showWarning(result.error || "恢复原形失败。");
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

const updateProcessingRangeName = (value) => {
  if (!videoStore.selectedProcessingRangeId) return;
  videoStore.renameProcessingRange(videoStore.selectedProcessingRangeId, value);
};

const commitProcessingRangeUpdate = (nextRange) => {
  if (!videoStore.selectedProcessingRangeId) return;
  const result = videoStore.resizeProcessingRange(videoStore.selectedProcessingRangeId, nextRange);
  if (!result.ok) {
    showWarning(result.error || "处理范围更新失败。");
  }
};

const updateProcessingRangeField = (field, value) => {
  const range = videoStore.selectedProcessingRange;
  if (!range) return;

  const nextValue = parseNumeric(value, range[field]);
  commitProcessingRangeUpdate({
    startTime: field === "startTime" ? nextValue : range.startTime,
    endTime: field === "endTime" ? nextValue : range.endTime,
  });
};

const setProcessingRangeStartFromCurrentTime = () => {
  const range = videoStore.selectedProcessingRange;
  if (!range) return;

  commitProcessingRangeUpdate({
    startTime: videoStore.currentTime,
    endTime: range.endTime,
  });
};

const setProcessingRangeEndFromCurrentTime = () => {
  const range = videoStore.selectedProcessingRange;
  if (!range) return;

  commitProcessingRangeUpdate({
    startTime: range.startTime,
    endTime: videoStore.currentTime,
  });
};
</script>

<style scoped>
.mask-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100%;
}

.mask-editor--empty {
  justify-content: center;
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

.slbr-range-hint {
  background: rgba(25, 118, 210, 0.08);
}

:global(body.body--dark) .slbr-range-hint {
  background: rgba(144, 202, 249, 0.12);
}

.sam-track-hint {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.28);
  font-size: 12px;
}

.sam-track-object-list {
  background: rgba(245, 158, 11, 0.05);
}

.sam-object-expand-input {
  width: 76px;
}

.sam-object-expand-input :deep(.q-field__control) {
  min-height: 32px;
  padding: 0 4px;
}

.sam-object-expand-input :deep(input) {
  padding: 0;
}

.sam-smart-tool-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sam-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sam-video-tool-group {
  flex: 1 1 150px;
  min-width: 0;
}

.sam-video-tool-group :deep(.q-btn) {
  min-height: 38px;
}

.video-sam-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.sam-run-button {
  flex: 1 1 150px;
  min-height: 38px;
}

.sam-smart-hint,
.sam-video-message {
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(25, 118, 210, 0.08);
  line-height: 1.4;
}

.sam-video-message--error {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.12);
}

.sam-prompt-list {
  background: rgba(25, 118, 210, 0.04);
}

:global(body.body--dark) .sam-track-hint {
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(251, 191, 36, 0.34);
}

:global(body.body--dark) .sam-smart-hint,
:global(body.body--dark) .sam-video-message {
  background: rgba(59, 130, 246, 0.14);
}

:global(body.body--dark) .sam-video-message--error {
  color: rgba(252, 165, 165, 0.98);
  background: rgba(239, 68, 68, 0.18);
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

.keyframe-inline-action {
  display: flex;
  align-items: flex-end;
  height: 100%;
}

.keyframe-delete-action {
  display: flex;
  justify-content: center;
}

.empty-state {
  min-height: 220px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--q-info);
  text-align: center;
  padding: 20px;
  line-height: 1.5;
}

.empty-state--slbr {
  color: var(--q-info);
}

:global(body.body--dark) .empty-state,
:global(body.body--dark) .empty-state--slbr {
  color: rgba(157, 220, 255, 0.96);
}
</style>
