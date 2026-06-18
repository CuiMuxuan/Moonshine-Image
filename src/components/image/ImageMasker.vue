<template>
  <div
    v-if="show"
    ref="rootRef"
    class="absolute inset-0"
    :class="{ 'masker-dark': $q.dark.isActive }"
  >
    <canvas
      ref="maskCanvas"
      class="absolute"
      :class="{
        'cursor-none':
          (manualDrawingEnabled || smartEraseDrawingEnabled) &&
          cursorPosition &&
          !isToolbarInteracting,
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
      v-if="samBoxPreviewStyle"
      class="sam-box-preview"
      :style="samBoxPreviewStyle"
    ></div>

    <img
      v-if="hoveredSamCandidate"
      :src="hoveredSamCandidateMask"
      class="absolute sam-candidate-preview"
      :style="samCandidatePreviewStyle"
      alt=""
      draggable="false"
    />

    <div
      v-if="showCustomCursor && (smartEraseDrawingEnabled || currentToolMode !== MASK_TOOL_MODES.RECT)"
      class="absolute pointer-events-none custom-cursor"
      :class="{ 'is-erase': activeCursorIsErase }"
      :style="brushCursorStyle"
    ></div>

    <div
      v-if="showCustomCursor && !smartEraseDrawingEnabled && currentToolMode === MASK_TOOL_MODES.RECT"
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
      v-if="!smartSelectionMode"
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

    <div
      v-if="smartSelectionMode"
      v-show="showToolbar"
      ref="toolbarRef"
      class="absolute toolbar-container sam-toolbar mask-toolbar-region app-floating-toolbar"
      data-testid="sam-smart-selection-toolbar"
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
        智能选区拖动区域
      </div>

      <q-bar
        class="q-px-md rounded-b-pill app-floating-toolbar-bar"
        :style="floatingToolbarBarStyle"
      >
        <div class="sam-toolbar-controls">
          <div class="sam-tool-main-group">
            <q-btn
              :color="props.samAvailable || props.samTextAvailable ? 'positive' : 'grey-6'"
              text-color="white"
              icon="center_focus_strong"
              :loading="samPredicting"
              :disable="!props.samImage || (!props.samAvailable && !props.samTextAvailable)"
              :size="toolbarButtonSize"
              class="sam-control-button sam-control-button-status"
            >
              <q-tooltip :class="toolbarTooltipContentClass">{{ samStatusText }}</q-tooltip>
            </q-btn>

            <q-btn
              :color="samToolMode === SAM_TOOL_MODES.ERASE ? 'negative' : 'primary'"
              text-color="white"
              :icon="samToolToggleIcon"
              :disable="samPredicting"
              :size="toolbarButtonSize"
              class="sam-control-button"
              data-testid="sam-tool-toggle-button"
              :data-mode="samToolMode"
              @click="toggleSamToolMode"
            >
              <q-tooltip :class="toolbarTooltipContentClass">{{ samToolToggleTooltip }}</q-tooltip>
            </q-btn>

            <q-btn
              color="primary"
              text-color="white"
              icon="tune"
              :disable="samPredicting"
              :size="toolbarButtonSize"
              class="sam-control-button"
              data-testid="sam-settings-button"
            >
              <q-tooltip :class="toolbarTooltipContentClass">智能选区设置</q-tooltip>
              <q-menu
                v-model="samSettingsMenuOpen"
                :anchor="settingsPopupAnchor"
                :self="settingsPopupSelf"
                :content-class="toolbarPopupContentClass"
                :transition-show="settingsPopupTransitionShow"
                :transition-hide="settingsPopupTransitionHide"
              >
                <div class="sam-settings-panel q-pa-md">
                  <div class="sam-popup-header">
                    <div class="sam-settings-title">SAM 模型</div>
                    <q-btn
                      flat
                      dense
                      round
                      icon="close"
                      color="primary"
                      data-testid="sam-settings-close-button"
                      @click="samSettingsMenuOpen = false"
                    >
                      <q-tooltip :class="toolbarTooltipContentClass">关闭设置</q-tooltip>
                    </q-btn>
                  </div>
                  <q-select
                    v-if="resolvedSamModelOptions.length"
                    :model-value="selectedSamModelId"
                    :options="resolvedSamModelOptions"
                    dense
                    outlined
                    emit-value
                    map-options
                    options-dense
                    label="默认模型"
                    class="sam-model-select"
                    :disable="samPredicting || !props.samAvailable"
                    @update:model-value="updateSelectedSamModel"
                  />
                  <div v-else class="sam-empty-state">
                    请先在模型管理中安装 SAM1/SAM2 点选模型；文本选区需安装 SAM3 文本模型。
                  </div>
                  <div class="sam-settings-hint">{{ samStatusText }}</div>
                  <div v-if="samAutoExpandNotice" class="sam-auto-expand-notice">
                    当前结果已自动扩边，以提升 LaMa 边缘修复效果。
                  </div>
                  <div v-if="samPerformanceText" class="sam-performance-state">
                    {{ samPerformanceText }}
                  </div>
                  <div v-if="samCudaUsageHint" class="sam-cuda-usage-hint">
                    {{ samCudaUsageHint }}
                  </div>

                  <div
                    v-if="props.samTextAvailable"
                    class="sam-settings-section"
                    data-testid="sam-text-settings-section"
                  >
                    <div class="sam-settings-title">文本智选</div>
                    <q-input
                      v-model="samTextPrompt"
                      dense
                      outlined
                      :disable="samPredicting || samTextBatchRunning || !props.samImage || !props.samTextAvailable"
                      label="自定义文本"
                      placeholder="输入短名词短语"
                      class="sam-text-prompt"
                      @keyup.enter="runSamTextPrediction"
                    />

                    <div class="sam-lexicon-row">
                      <q-select
                        v-model="samTextColor"
                        :options="samTextColorOptions"
                        dense
                        outlined
                        clearable
                        emit-value
                        map-options
                        options-dense
                        label="颜色"
                        class="sam-lexicon-select"
                        :disable="samPredicting || samTextBatchRunning || !props.samImage"
                      />
                      <q-select
                        v-model="samTextNoun"
                        :options="samTextNounOptions"
                        dense
                        outlined
                        clearable
                        emit-value
                        map-options
                        options-dense
                        use-input
                        input-debounce="0"
                        label="目标"
                        class="sam-lexicon-select"
                        :disable="samPredicting || samTextBatchRunning || !props.samImage"
                        @filter="filterSamTextNounOptions"
                      />
                    </div>

                    <div v-if="samGeneratedPromptText" class="sam-generated-prompt">
                      {{ samGeneratedPromptText }}
                    </div>

                    <div v-if="samTextBatchVisible" class="sam-batch-state">
                      <div class="sam-batch-state-row">
                        <span>{{ samTextBatchText }}</span>
                        <q-btn
                          v-if="samTextBatchRunning"
                          dense
                          flat
                          round
                          size="sm"
                          icon="close"
                          color="primary"
                          @click="cancelSamTextBatchPrediction"
                        >
                          <q-tooltip :class="toolbarTooltipContentClass">取消批量检索</q-tooltip>
                        </q-btn>
                      </div>
                      <q-linear-progress
                        rounded
                        size="6px"
                        color="primary"
                        :value="samTextBatchProgress"
                        :indeterminate="samTextBatchRunning && !samTextBatchProgress"
                      />
                    </div>

                    <div class="sam-text-actions">
                      <q-btn
                        unelevated
                        no-caps
                        color="primary"
                        icon="image_search"
                        label="检索当前图片"
                        :disable="!canRunSamTextPrediction"
                        :loading="samTextPredicting"
                        @click="runSamTextPrediction"
                      />
                      <q-btn
                        outline
                        no-caps
                        color="primary"
                        icon="select_all"
                        label="批量检索"
                        :disable="!canRunSamBatchTextPrediction"
                        :loading="samTextBatchRunning"
                        @click="requestSamTextBatchPrediction"
                      >
                        <q-tooltip :class="toolbarTooltipContentClass">{{ samTextBatchTooltip }}</q-tooltip>
                      </q-btn>
                    </div>
                  </div>
                </div>
              </q-menu>
            </q-btn>

            <q-btn
              color="primary"
              text-color="white"
              icon="playlist_remove"
              :disable="samCandidates.length === 0 || samPredicting"
              :size="toolbarButtonSize"
              class="sam-control-button sam-control-button-candidates"
              data-testid="sam-candidate-menu-button"
            >
              <q-tooltip :class="toolbarTooltipContentClass">{{ samCandidateMenuTooltip }}</q-tooltip>
              <q-menu
                v-model="samCandidateMenuOpen"
                :anchor="settingsPopupAnchor"
                :self="settingsPopupSelf"
                :content-class="toolbarPopupContentClass"
                :transition-show="settingsPopupTransitionShow"
                :transition-hide="settingsPopupTransitionHide"
              >
                <div class="sam-candidate-panel q-pa-sm">
                  <div class="sam-popup-header sam-popup-header--compact q-px-sm q-pt-xs">
                    <div class="sam-settings-title">候选蒙版</div>
                    <q-btn
                      flat
                      dense
                      round
                      icon="close"
                      color="primary"
                      data-testid="sam-candidate-close-button"
                      @click="samCandidateMenuOpen = false"
                    >
                      <q-tooltip :class="toolbarTooltipContentClass">关闭候选列表</q-tooltip>
                    </q-btn>
                  </div>
                  <q-list dense separator class="sam-candidate-list">
                    <q-item
                      v-for="candidate in samCandidates"
                      :key="candidate.localId"
                      clickable
                      :active="hoveredSamCandidateId === candidate.localId"
                      @mouseenter="hoveredSamCandidateId = candidate.localId"
                      @mouseleave="hoveredSamCandidateId = ''"
                    >
                      <q-item-section side>
                        <q-checkbox
                          :model-value="candidate.enabled"
                          dense
                          color="primary"
                          @update:model-value="setSamCandidateEnabled(candidate.localId, $event)"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label>{{ candidate.label }}</q-item-label>
                        <q-item-label caption>
                          {{ formatSamScore(candidate.score) }} · {{ formatSamCreatedAt(candidate.createdAt) }}
                        </q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-btn
                          flat
                          dense
                          round
                          icon="close"
                          color="primary"
                          @click.stop="removeSamCandidate(candidate.localId)"
                        >
                          <q-tooltip :class="toolbarTooltipContentClass">删除该候选</q-tooltip>
                        </q-btn>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </q-menu>
            </q-btn>
          </div>

          <q-btn-group flat class="rounded-pill overflow-hidden sam-control-group">
            <q-btn
              icon="undo"
              :disable="!canUndo"
              :size="toolbarButtonSize"
              :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
              @click="undo"
            >
              <q-tooltip :class="toolbarTooltipContentClass">撤回</q-tooltip>
            </q-btn>
            <q-btn
              icon="clear"
              :disable="samCandidates.length === 0 || samPredicting"
              :size="toolbarButtonSize"
              :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
              @click="clearSamCandidates"
            >
              <q-tooltip :class="toolbarTooltipContentClass">清空智能选区结果</q-tooltip>
            </q-btn>
          </q-btn-group>

          <q-btn-group flat class="toolbar-side-actions">
            <q-btn
              icon="center_focus_strong"
              :size="toolbarButtonSize"
              :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
              @click="resetView"
            >
              <q-tooltip :class="toolbarTooltipContentClass">重置视图</q-tooltip>
            </q-btn>
            <q-btn
              icon="visibility_off"
              :size="toolbarButtonSize"
              :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
              @mousedown="toggleMaskVisibility(false)"
              @mouseup="toggleMaskVisibility(true)"
              @mouseleave="toggleMaskVisibility(true)"
              @touchstart.prevent="toggleMaskVisibility(false)"
              @touchend.prevent="toggleMaskVisibility(true)"
              @touchcancel.prevent="toggleMaskVisibility(true)"
            >
              <q-tooltip :class="toolbarTooltipContentClass">按住隐藏蒙版</q-tooltip>
            </q-btn>
          </q-btn-group>
        </div>
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
import { predictSamMask, predictSamText } from "src/services/SamPredictionService";
import {
  buildSam3LexiconPrompt,
  loadSam3Lexicon,
} from "src/services/SamLexiconService";
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
import { expandSamMaskImageDataForLama } from "src/utils/samMaskAutoExpand";
import { useEditorStore } from "src/stores/editor";

const editor = inject("image-editor", { value: null });
const configStore = useConfigStore();
const $q = useQuasar();

const SAM_TOOL_MODES = Object.freeze({
  SELECT: "select",
  ERASE: "erase",
});

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
  smartSelectionMode: {
    type: Boolean,
    default: false,
  },
  currentModel: {
    type: String,
    default: "",
  },
  samModelId: {
    type: String,
    default: "sam_vit_b",
  },
  samModelOptions: {
    type: Array,
    default: () => [],
  },
  samAvailable: {
    type: Boolean,
    default: false,
  },
  samTextAvailable: {
    type: Boolean,
    default: false,
  },
  samImage: {
    type: String,
    default: "",
  },
  samImageType: {
    type: String,
    default: "base64",
  },
  samContextId: {
    type: String,
    default: "",
  },
  samTextModelId: {
    type: String,
    default: "sam3",
  },
  samTextBatchTargetCount: {
    type: Number,
    default: 0,
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
  samTextBatchState: {
    type: Object,
    default: () => ({
      running: false,
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      cancelled: false,
    }),
  },
});

const emit = defineEmits([
  "update:mask",
  "update:drawing-mode",
  "update:tool-state",
  "update:toolbar-interacting",
  "sam-processing-state",
  "sam-text-batch-request",
  "sam-text-batch-cancel",
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
const toolbarPopupContentClass = `${toolbarPopupClass} sam-toolbar-popup-layer`;
const toolbarTooltipContentClass = "sam-toolbar-tooltip-layer";
const isToolbarPointerRegionActive = ref(false);
const samToolMode = ref(SAM_TOOL_MODES.SELECT);
const samEraseOperation = ref(null);
const samSettingsMenuOpen = ref(false);
const samCandidateMenuOpen = ref(false);

const drawingModeActive = computed(() => Boolean(props.drawingMode));
const smartSelectionMode = computed(() => Boolean(props.smartSelectionMode));
const effectiveDrawingEnabled = computed(
  () => Boolean(props.show) && (drawingModeActive.value || smartSelectionMode.value)
);
const manualDrawingEnabled = computed(() => Boolean(props.show) && drawingModeActive.value);
const smartEraseDrawingEnabled = computed(
  () =>
    Boolean(props.show) &&
    smartSelectionMode.value &&
    samToolMode.value === SAM_TOOL_MODES.ERASE &&
    canUseSamEraseTool.value
);
const currentToolMode = computed(() => normalizeMaskToolMode(toolMode.value));
const isToolbarInteracting = computed(
  () => Boolean(props.showToolbar) && (isDraggingToolbar.value || isToolbarPointerRegionActive.value)
);
const showCustomCursor = computed(
  () =>
    (manualDrawingEnabled.value || smartEraseDrawingEnabled.value) &&
    Boolean(cursorPosition.value) &&
    !isToolbarInteracting.value
);
const activeCursorIsErase = computed(
  () => currentToolMode.value === MASK_TOOL_MODES.ERASE || smartEraseDrawingEnabled.value
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
  const isErase = activeCursorIsErase.value;

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
const samPointerStart = ref(null);
const samDragPoint = ref(null);
const samPredicting = ref(false);
const samTextPredicting = ref(false);
const samTextPrompt = ref("");
const samTextColor = ref("");
const samTextNoun = ref("");
const samTextLexicon = ref({ colors: [], nouns: [] });
const samTextFilteredNouns = ref([]);
const samCandidates = ref([]);
const hoveredSamCandidateId = ref("");
const samBaseSnapshot = ref(null);
const samBaseSnapshotDataUrl = ref("");
const samOperationIndex = ref(0);
const samLastPerformance = ref(null);
const samSessionByContext = new Map();
const samExpandedMaskCache = new WeakMap();
const activeSamContextId = ref("");
const selectedSamModelId = ref("");

const normalizeBatchState = (value = {}) => {
  const total = Math.max(0, Number(value.total || 0));
  const completed = Math.max(0, Math.min(total, Number(value.completed || 0)));
  return {
    running: Boolean(value.running),
    total,
    completed,
    success: Math.max(0, Number(value.success || 0)),
    failed: Math.max(0, Number(value.failed || 0)),
    cancelled: Boolean(value.cancelled),
  };
};

const samTextBatchState = computed(() => normalizeBatchState(props.samTextBatchState));
const samTextBatchRunning = computed(() => samTextBatchState.value.running);
const samTextBatchVisible = computed(
  () => samTextBatchState.value.running || samTextBatchState.value.total > 0
);
const samTextBatchProgress = computed(() => {
  const state = samTextBatchState.value;
  if (!state.total) return 0;
  return Math.max(0, Math.min(1, state.completed / state.total));
});
const samTextBatchText = computed(() => {
  const state = samTextBatchState.value;
  if (!state.total) return "等待批量文本检索";
  if (state.running) {
    return `批量检索 ${state.completed}/${state.total} · 成功 ${state.success} · 失败 ${state.failed}`;
  }
  if (state.cancelled) {
    return `批量检索已取消 · 成功 ${state.success} · 失败 ${state.failed}`;
  }
  return `批量检索完成 · 成功 ${state.success} · 失败 ${state.failed}`;
});
const samProcessingState = computed(() => {
  if (samTextBatchRunning.value) {
    return {
      running: true,
      message: samTextBatchText.value,
      progress: samTextBatchProgress.value,
    };
  }
  if (samTextPredicting.value) {
    return {
      running: true,
      message: "正在运行 SAM3 文本智能选区",
      progress: null,
    };
  }
  if (samPredicting.value) {
    return {
      running: true,
      message: "正在运行 SAM 智能选区",
      progress: null,
    };
  }
  return {
    running: false,
    message: "",
    progress: null,
  };
});

const samTextColorOptions = computed(() =>
  (samTextLexicon.value.colors || []).map((entry) => ({
    label: `${entry.zh} / ${entry.en}`,
    value: entry.zh,
  }))
);
const samTextNounOptions = computed(() =>
  (samTextFilteredNouns.value.length ? samTextFilteredNouns.value : samTextLexicon.value.nouns || [])
    .map((entry) => ({
      label: `${entry.zh} / ${entry.en}`,
      value: entry.zh,
    }))
);
const selectedSamTextColorEntry = computed(
  () => (samTextLexicon.value.colors || []).find((entry) => entry.zh === samTextColor.value) || null
);
const selectedSamTextNounEntry = computed(
  () => (samTextLexicon.value.nouns || []).find((entry) => entry.zh === samTextNoun.value) || null
);
const samTextPromptSpec = computed(() =>
  buildSam3LexiconPrompt({
    text: samTextPrompt.value,
    color: selectedSamTextColorEntry.value,
    noun: selectedSamTextNounEntry.value,
  })
);
const samGeneratedPromptText = computed(() => {
  const spec = samTextPromptSpec.value;
  if (!spec.text || spec.source === "manual") return "";
  const prefix = spec.source === "lexicon-color" ? "仅颜色：" : "将检索：";
  return `${prefix}${spec.text}${spec.warning ? ` · ${spec.warning}` : ""}`;
});

const currentProcessingModelId = computed(() =>
  String(props.currentModel || "").trim().toLowerCase()
);
const shouldAutoExpandSamMasks = computed(() => currentProcessingModelId.value === "lama");
const hasEnabledSamCandidates = computed(() =>
  samCandidates.value.some((candidate) => candidate.enabled && candidate.mask)
);
const samAutoExpandNotice = computed(
  () => shouldAutoExpandSamMasks.value && hasEnabledSamCandidates.value
);
const canUseSamEraseTool = computed(
  () =>
    smartSelectionMode.value &&
    !samPredicting.value &&
    samCandidates.value.some((candidate) => candidate.enabled && candidate.mask)
);
const samEraseTooltip = computed(() => {
  if (!samCandidates.value.length) return "先生成智能选区候选后再擦除";
  if (!samCandidates.value.some((candidate) => candidate.enabled && candidate.mask)) {
    return "先启用至少一个智能选区候选";
  }
  if (samPredicting.value) return "智能选区运行中";
  return "擦除智能选区生成的蒙版";
});

const samStatusText = computed(() => {
  if (!props.samAvailable && !props.samTextAvailable) {
    return "请先安装 SAM1/SAM2 点选模型或 SAM3 文本模型";
  }
  if (samPredicting.value) return "正在加载模型或计算图片特征";
  if (samToolMode.value === SAM_TOOL_MODES.ERASE) return "拖动擦除智能选区结果";
  if (samCandidates.value.length) return `${samCandidates.value.length} 个候选`;
  if (!props.samAvailable && props.samTextAvailable) return "输入文本提示后检索当前图片";
  return "单击点选，拖拽框选，或输入文本提示";
});

const samPerformanceText = computed(() => {
  const performance = samLastPerformance.value;
  if (samPredicting.value) return "首次处理当前图片会计算图片特征，同一图片后续点选会复用特征。";
  if (!performance) return "";
  const device = String(performance.device || "").toUpperCase() || "CPU";
  const cacheText = performance.imageCacheHit ? "已复用图片特征" : "已计算图片特征";
  const totalMs = Number(performance.totalMs);
  const totalText = Number.isFinite(totalMs) ? `${Math.round(totalMs)} ms` : "耗时未知";
  const megapixels = Number(performance.imageMegapixels);
  const imageText = Number.isFinite(megapixels) ? `${megapixels.toFixed(2)} MP` : "图片尺寸未知";
  return `${device} · ${cacheText} · ${imageText} · ${totalText}`;
});

const samCudaUsageHint = computed(() => {
  const performance = samLastPerformance.value;
  if (!performance || String(performance.device || "").toLowerCase() !== "cpu") return "";
  return "当前 SAM 在 CPU 上运行。如需使用 CUDA，请在全局设置或后端管理中将启动设备改为 CUDA，确认 CUDA 版运行时与 PyTorch 可用，然后重启后端。";
});

const samToolToggleIcon = computed(() =>
  samToolMode.value === SAM_TOOL_MODES.ERASE ? "auto_fix_off" : "ads_click"
);

const samToolToggleTooltip = computed(() => {
  if (samToolMode.value === SAM_TOOL_MODES.ERASE) {
    return "当前为擦除智能选区，点击切回点选/框选";
  }
  if (!canUseSamEraseTool.value) return `当前为点选/框选；${samEraseTooltip.value}`;
  return "当前为点选/框选，点击切换为擦除智能选区蒙版";
});

const hoveredSamCandidate = computed(() =>
  samCandidates.value.find((candidate) => candidate.localId === hoveredSamCandidateId.value) || null
);
const hoveredSamCandidateMask = computed(() => {
  const candidate = hoveredSamCandidate.value;
  if (!candidate) return "";
  if (candidate.renderedMask) return candidate.renderedMask;
  if (candidate.eraseMask) return candidate.mask || "";
  if (!shouldAutoExpandSamMasks.value) return candidate.mask || "";
  const cached = samExpandedMaskCache.get(candidate);
  return cached?.dataUrl || candidate.mask || "";
});

const samCandidatePreviewStyle = computed(() => ({
  left: `${store.offsetX}px`,
  top: `${store.offsetY}px`,
  width: `${store.imageWidth}px`,
  height: `${store.imageHeight}px`,
  transform: `scale(${props.scale})`,
  transformOrigin: "0 0",
}));

const samBoxPreviewStyle = computed(() => {
  if (
    !smartSelectionMode.value ||
    smartEraseDrawingEnabled.value ||
    !samPointerStart.value ||
    !samDragPoint.value
  ) {
    return null;
  }

  const rect = normalizeCanvasRect(samPointerStart.value, samDragPoint.value);
  if (!rect || rect.width < 4 || rect.height < 4) return null;

  return {
    left: `${store.offsetX + rect.x * props.scale}px`,
    top: `${store.offsetY + rect.y * props.scale}px`,
    width: `${rect.width * props.scale}px`,
    height: `${rect.height * props.scale}px`,
  };
});

const getSamContextId = () => {
  const explicitId = String(props.samContextId || "").trim();
  if (explicitId) return explicitId;
  return `${props.samImageType || "base64"}:${props.samImage || ""}`;
};

const buildSamContextId = (contextId) => {
  const explicitId = String(contextId || "").trim();
  return explicitId;
};

const normalizeSamModelOptions = (items = []) =>
  items
    .filter((item) => item?.value || item?.id)
    .map((item) => ({
      label: item.label || item.id || item.value,
      value: item.value || item.id,
      disable: Boolean(item.disable),
    }));

const resolvedSamModelOptions = computed(() => {
  const options = normalizeSamModelOptions(props.samModelOptions);
  if (!options.length) {
    return [];
  }
  if (options.some((option) => option.value === props.samModelId)) {
    return options;
  }
  return [
    {
      label: props.samModelId || "sam_vit_b",
      value: props.samModelId || "sam_vit_b",
    },
    ...options,
  ];
});

const effectiveSamModelId = computed(
  () => selectedSamModelId.value || props.samModelId || ""
);
const canRunSamTextPrediction = computed(
  () =>
    Boolean(props.samTextAvailable) &&
    Boolean(props.samImage) &&
    Boolean(samTextPromptSpec.value.text) &&
    !samPredicting.value &&
    !samTextBatchRunning.value
);
const canRunSamBatchTextPrediction = computed(
  () =>
    Boolean(props.samTextAvailable) &&
    Boolean(samTextPromptSpec.value.text) &&
    props.samTextBatchTargetCount > 0 &&
    !samPredicting.value &&
    !samTextBatchRunning.value
);
const samTextBatchTooltip = computed(() => {
  if (!props.samTextAvailable) return "请先安装 SAM3 文本模型";
  if (!samTextPromptSpec.value.text) return "先输入文本提示或选择颜色/目标";
  if (props.samTextBatchTargetCount <= 0) return "先在左侧选择图片";
  if (samTextBatchRunning.value) return "正在批量检索";
  return `检索 ${props.samTextBatchTargetCount} 张选中图片`;
});
const samCandidateMenuTooltip = computed(() => {
  if (samCandidates.value.length === 0) return "暂无候选蒙版";
  return "候选蒙版显示与删除";
});

const updateSelectedSamModel = (modelId) => {
  const nextModelId = String(modelId || props.samModelId || "sam_vit_b").trim();
  if (!nextModelId || selectedSamModelId.value === nextModelId) return;
  saveSamContextSession();
  selectedSamModelId.value = nextModelId;
  restoreSamContextSession();
};

const getTextModelId = () => props.samTextModelId || "sam3";

const filterSamTextNounOptions = (value, update) => {
  update(() => {
    const keyword = String(value || "").trim().toLowerCase();
    const nouns = samTextLexicon.value.nouns || [];
    samTextFilteredNouns.value = keyword
      ? nouns.filter((entry) =>
          [entry.zh, entry.en, entry.category]
            .filter(Boolean)
            .some((item) => String(item).toLowerCase().includes(keyword))
        )
      : nouns;
  });
};

const refreshSamTextLexicon = async () => {
  try {
    const lexicon = await loadSam3Lexicon();
    samTextLexicon.value = lexicon;
    samTextFilteredNouns.value = lexicon.nouns || [];
  } catch (error) {
    samTextLexicon.value = { colors: [], nouns: [] };
    samTextFilteredNouns.value = [];
    console.warn("Failed to load SAM3 lexicon:", error);
  }
};

const buildSamTextCandidate = (candidate, index, result = {}, prompt = samTextPrompt.value.trim()) => ({
  ...candidate,
  localId: `${Date.now()}-${samOperationIndex.value}-text-${index}`,
  label: `文本候选 ${index + 1}`,
  enabled: index === 0,
  source: "text",
  modelId: getTextModelId(),
  prompt: candidate.prompt || result.prompt || { type: "text", text: prompt },
  createdAt: new Date().toISOString(),
});

const cloneSamCandidates = (items = []) =>
  items.map((candidate) => {
    const nextCandidate = { ...candidate };
    delete nextCandidate.renderedMask;
    return nextCandidate;
  });

const saveSamContextSession = () => {
  const contextId = activeSamContextId.value;
  if (!contextId) return;
  samSessionByContext.set(contextId, {
    candidates: cloneSamCandidates(samCandidates.value),
    hoveredCandidateId: hoveredSamCandidateId.value,
    baseSnapshot: samBaseSnapshot.value ? cloneImageData(samBaseSnapshot.value) : null,
    baseSnapshotDataUrl: samBaseSnapshotDataUrl.value || "",
    operationIndex: samOperationIndex.value,
    lastPerformance: samLastPerformance.value ? { ...samLastPerformance.value } : null,
  });
};

const restoreSamContextSession = () => {
  const contextId = getSamContextId();
  activeSamContextId.value = contextId;
  const session = samSessionByContext.get(contextId);
  samCandidates.value = cloneSamCandidates(session?.candidates || []);
  hoveredSamCandidateId.value = session?.hoveredCandidateId || "";
  samBaseSnapshot.value = session?.baseSnapshot ? cloneImageData(session.baseSnapshot) : null;
  samBaseSnapshotDataUrl.value = session?.baseSnapshotDataUrl || "";
  samOperationIndex.value = Number.isInteger(session?.operationIndex) ? session.operationIndex : 0;
  samLastPerformance.value = session?.lastPerformance ? { ...session.lastPerformance } : null;
  samPointerStart.value = null;
  samDragPoint.value = null;
};

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
    mode: smartEraseDrawingEnabled.value ? MASK_TOOL_MODES.ERASE : currentToolMode.value,
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

const closeSamToolbarPopups = () => {
  samSettingsMenuOpen.value = false;
  samCandidateMenuOpen.value = false;
  setToolbarPointerRegionState(false);
};

const syncToolbarPointerRegionState = (event) => {
  setToolbarPointerRegionState(isEventWithinToolbarRegion(event));
};

const cloneImageData = (imageData) =>
  new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);

const imageDataToDataUrl = (imageData) => {
  if (!imageData?.width || !imageData?.height) return "";
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return "";
  canvasContext.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

const imageDataHasVisibleAlpha = (imageData) => {
  const data = imageData?.data;
  if (!data) return false;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
};

const dataUrlToImageData = async (dataUrl, width, height) => {
  if (!dataUrl || !width || !height) return null;
  const image = await drawImageUrlToContext(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) return null;
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.drawImage(image, 0, 0, width, height);
  return canvasContext.getImageData(0, 0, width, height);
};

const normalizeCanvasRect = (startPoint, endPoint) => {
  if (!startPoint || !endPoint) return null;
  const left = Math.min(startPoint.x, endPoint.x);
  const right = Math.max(startPoint.x, endPoint.x);
  const top = Math.min(startPoint.y, endPoint.y);
  const bottom = Math.max(startPoint.y, endPoint.y);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
};

const ensureSamBaseSnapshot = () => {
  if (samBaseSnapshot.value || !ctx.value || !maskCanvas.value) {
    return samBaseSnapshot.value;
  }
  samBaseSnapshot.value = ctx.value.getImageData(
    0,
    0,
    maskCanvas.value.width,
    maskCanvas.value.height
  );
  samBaseSnapshotDataUrl.value = getMaskData();
  return samBaseSnapshot.value;
};

const drawImageUrlToContext = (dataUrl) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("候选蒙版加载失败"));
    image.src = dataUrl;
  });

const expandSamMaskForLama = async (maskDataUrl, width, height) => {
  if (!maskDataUrl || !width || !height) return maskDataUrl || "";
  const image = await drawImageUrlToContext(maskDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) return maskDataUrl;

  canvasContext.clearRect(0, 0, width, height);
  canvasContext.drawImage(image, 0, 0, width, height);
  const imageData = canvasContext.getImageData(0, 0, width, height);
  const result = expandSamMaskImageDataForLama(imageData, {
    imageWidth: width,
    imageHeight: height,
  });
  if (!result.expanded) return maskDataUrl;

  canvasContext.putImageData(result.imageData, 0, 0);
  return canvas.toDataURL("image/png");
};

const subtractSamEraseMask = async (maskDataUrl, eraseMaskDataUrl, width, height) => {
  if (!maskDataUrl || !eraseMaskDataUrl || !width || !height) return maskDataUrl || "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) return maskDataUrl;

  const maskImage = await drawImageUrlToContext(maskDataUrl);
  const eraseImage = await drawImageUrlToContext(eraseMaskDataUrl);
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.drawImage(maskImage, 0, 0, width, height);
  canvasContext.save();
  canvasContext.globalCompositeOperation = "destination-out";
  canvasContext.drawImage(eraseImage, 0, 0, width, height);
  canvasContext.restore();

  const imageData = canvasContext.getImageData(0, 0, width, height);
  if (!imageDataHasVisibleAlpha(imageData)) return "";
  return canvas.toDataURL("image/png");
};

const resolveSamCandidateMaskForRendering = async (candidate, { width = 0, height = 0 } = {}) => {
  const sourceMask = candidate?.mask || "";
  if (!sourceMask) return "";

  const renderWidth = Math.max(1, Math.round(width || maskCanvas.value?.width || store.imageWidth || 1));
  const renderHeight = Math.max(1, Math.round(height || maskCanvas.value?.height || store.imageHeight || 1));
  let renderMask = sourceMask;

  if (!shouldAutoExpandSamMasks.value) {
    renderMask = sourceMask;
  } else {
    const cached = samExpandedMaskCache.get(candidate);
    if (
      cached?.sourceMask === sourceMask &&
      cached.width === renderWidth &&
      cached.height === renderHeight
    ) {
      renderMask = cached.dataUrl;
    } else {
      try {
        // Keep candidate.mask untouched so every render starts from the original SAM result.
        renderMask = await expandSamMaskForLama(sourceMask, renderWidth, renderHeight);
        samExpandedMaskCache.set(candidate, {
          sourceMask,
          width: renderWidth,
          height: renderHeight,
          dataUrl: renderMask,
        });
      } catch (error) {
        console.warn("Failed to auto-expand SAM mask for LaMa:", error);
        renderMask = sourceMask;
      }
    }
  }

  if (candidate?.eraseMask) {
    renderMask = await subtractSamEraseMask(
      renderMask,
      candidate.eraseMask,
      renderWidth,
      renderHeight
    );
  }

  candidate.renderedMask = renderMask;
  return renderMask;
};

const hasSamCandidateLayer = () => samCandidates.value.some((candidate) => candidate.mask);

const resolveCurrentSamBaseSnapshot = async () => {
  if (!maskCanvas.value) return null;
  const width = maskCanvas.value.width;
  const height = maskCanvas.value.height;
  if (samBaseSnapshot.value) return cloneImageData(samBaseSnapshot.value);
  if (samBaseSnapshotDataUrl.value) {
    return dataUrlToImageData(samBaseSnapshotDataUrl.value, width, height);
  }
  return null;
};

const applyRasterOperationToImageData = (baseImageData, operation = {}) => {
  if (!baseImageData || !operation?.tool) return null;
  const canvas = document.createElement("canvas");
  canvas.width = baseImageData.width;
  canvas.height = baseImageData.height;
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) return null;
  canvasContext.putImageData(baseImageData, 0, 0);

  const mode = normalizeMaskToolMode(operation.mode);
  const tool = operation.tool || {};
  canvasContext.save();
  if (mode === MASK_TOOL_MODES.ERASE) {
    canvasContext.globalCompositeOperation = "destination-out";
  } else {
    canvasContext.globalCompositeOperation = "source-over";
  }

  if (mode === MASK_TOOL_MODES.RECT && operation.rect) {
    if (mode === MASK_TOOL_MODES.ERASE) {
      canvasContext.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      canvasContext.fillStyle = hexToRgba(tool.brushColor, tool.brushAlpha);
    }
    canvasContext.fillRect(
      operation.rect.x,
      operation.rect.y,
      operation.rect.width,
      operation.rect.height
    );
  } else if (operation.imageData && operation.dirtyRect) {
    const operationCanvas = document.createElement("canvas");
    operationCanvas.width = baseImageData.width;
    operationCanvas.height = baseImageData.height;
    const operationContext = operationCanvas.getContext("2d");
    if (!operationContext) {
      canvasContext.restore();
      return null;
    }
    operationContext.putImageData(
      operation.imageData,
      operation.dirtyRect.x,
      operation.dirtyRect.y
    );
    if (mode !== MASK_TOOL_MODES.ERASE) {
      canvasContext.globalAlpha = Math.min(1, Math.max(0.05, Number(tool.brushAlpha ?? 1)));
    }
    canvasContext.drawImage(operationCanvas, 0, 0);
  } else {
    canvasContext.restore();
    return null;
  }

  canvasContext.restore();
  return canvasContext.getImageData(0, 0, canvas.width, canvas.height);
};

const drawRasterOperationLayer = (canvasContext, operation = {}) => {
  if (!canvasContext || !operation?.tool) return false;
  if (operation.rect) {
    canvasContext.save();
    canvasContext.globalCompositeOperation = "source-over";
    canvasContext.fillStyle = "rgba(0, 0, 0, 1)";
    canvasContext.fillRect(
      operation.rect.x,
      operation.rect.y,
      operation.rect.width,
      operation.rect.height
    );
    canvasContext.restore();
    return true;
  }

  if (operation.imageData && operation.dirtyRect) {
    canvasContext.putImageData(
      operation.imageData,
      operation.dirtyRect.x,
      operation.dirtyRect.y
    );
    return true;
  }

  return false;
};

const applySamEraseOperationToCandidate = async (candidate, operation = {}) => {
  if (!candidate?.mask || !maskCanvas.value) return false;
  const width = maskCanvas.value.width;
  const height = maskCanvas.value.height;
  if (!width || !height) return false;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) return false;

  if (candidate.eraseMask) {
    try {
      const existingEraseImage = await drawImageUrlToContext(candidate.eraseMask);
      canvasContext.drawImage(existingEraseImage, 0, 0, width, height);
    } catch (error) {
      console.warn("Failed to restore SAM erase mask:", error);
      canvasContext.clearRect(0, 0, width, height);
    }
  }

  const drewOperation = drawRasterOperationLayer(canvasContext, operation);
  if (!drewOperation) return false;

  const nextEraseMask = canvasContext.getImageData(0, 0, width, height);
  if (!imageDataHasVisibleAlpha(nextEraseMask)) {
    candidate.eraseMask = "";
    candidate.renderedMask = "";
    samExpandedMaskCache.delete(candidate);
    return true;
  }

  candidate.eraseMask = canvas.toDataURL("image/png");
  candidate.renderedMask = "";
  samExpandedMaskCache.delete(candidate);
  return true;
};

const applySamEraseOperationToEnabledCandidates = async (operation = {}) => {
  const targets = samCandidates.value.filter((candidate) => candidate.enabled && candidate.mask);
  if (!targets.length) return false;

  let changed = false;
  for (const candidate of targets) {
    changed = (await applySamEraseOperationToCandidate(candidate, operation)) || changed;
  }
  return changed;
};

const syncSamBaseSnapshotFromManualOperation = async (operationResult = {}) => {
  if (!operationResult?.changed || !operationResult.operation || !hasSamCandidateLayer()) {
    return false;
  }

  const currentBaseSnapshot = await resolveCurrentSamBaseSnapshot();
  if (!currentBaseSnapshot) return false;
  const nextBaseSnapshot = applyRasterOperationToImageData(
    currentBaseSnapshot,
    operationResult.operation
  );
  if (!nextBaseSnapshot) return false;

  samBaseSnapshot.value = nextBaseSnapshot;
  samBaseSnapshotDataUrl.value = imageDataToDataUrl(nextBaseSnapshot);
  await renderSamCandidates({ pushHistory: true });
  return true;
};

const renderSamCandidates = async ({ pushHistory = false, saveSession = true } = {}) => {
  if (!ctx.value || !maskCanvas.value) return;
  const baseSnapshot = samBaseSnapshot.value || (!samBaseSnapshotDataUrl.value ? ensureSamBaseSnapshot() : null);
  if (baseSnapshot) {
    ctx.value.putImageData(baseSnapshot, 0, 0);
  } else if (samBaseSnapshotDataUrl.value) {
    ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
    const baseImage = await drawImageUrlToContext(samBaseSnapshotDataUrl.value);
    ctx.value.drawImage(baseImage, 0, 0, maskCanvas.value.width, maskCanvas.value.height);
  } else {
    ctx.value.clearRect(0, 0, maskCanvas.value.width, maskCanvas.value.height);
  }

  for (const candidate of samCandidates.value) {
    if (!candidate.enabled) continue;
    if (!candidate.mask) continue;
    const candidateMask = await resolveSamCandidateMaskForRendering(candidate, {
      width: maskCanvas.value.width,
      height: maskCanvas.value.height,
    });
    if (!candidateMask) continue;
    const image = await drawImageUrlToContext(candidateMask);
    ctx.value.drawImage(image, 0, 0, maskCanvas.value.width, maskCanvas.value.height);
  }

  if (pushHistory) {
    appendHistorySnapshot(ctx.value.getImageData(0, 0, maskCanvas.value.width, maskCanvas.value.height));
  }
  emitMask();
  if (saveSession) {
    saveSamContextSession();
  }
};

const formatSamScore = (score) =>
  Number.isFinite(Number(score)) ? `置信度 ${Number(score).toFixed(3)}` : "置信度未知";

const formatSamCreatedAt = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const runSamPrediction = async ({ point = null, box = null } = {}) => {
  if (!props.samImage || samPredicting.value) return;
  if (!props.samAvailable || !effectiveSamModelId.value) {
    $q.notify({
      type: "warning",
      message: "请先在模型管理中安装 SAM1/SAM2 点选模型",
      position: "top",
    });
    return;
  }
  closeSamToolbarPopups();
  ensureSamBaseSnapshot();
  samPredicting.value = true;
  try {
    const result = await predictSamMask({
      image: props.samImage,
      imageType: props.samImageType,
      modelId: effectiveSamModelId.value,
      points: point ? [point] : [],
      box,
      multimaskOutput: !box,
    });
    samLastPerformance.value = result.performance ? { ...result.performance } : null;
    const nextCandidates = (result.candidates || []).map((candidate, index) => ({
      ...candidate,
      localId: `${Date.now()}-${samOperationIndex.value}-${index}`,
      label: box ? `框选候选 ${index + 1}` : `点选候选 ${index + 1}`,
      enabled: index === 0,
      source: box ? "box" : "point",
      modelId: effectiveSamModelId.value,
      prompt: box ? { box } : { point },
      createdAt: new Date().toISOString(),
    }));
    samOperationIndex.value += 1;
    samCandidates.value = [...samCandidates.value, ...nextCandidates];
    await renderSamCandidates({ pushHistory: nextCandidates.length > 0 });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "SAM 智能选区失败",
      position: "top",
    });
  } finally {
    samPredicting.value = false;
  }
};

const runSamTextPrediction = async () => {
  const promptSpec = samTextPromptSpec.value;
  const prompt = promptSpec.text;
  if (!props.samImage || samPredicting.value || !prompt) return;
  if (!props.samTextAvailable) {
    $q.notify({
      type: "warning",
      message: "请先在模型管理中安装 SAM3 文本模型",
      position: "top",
    });
    return;
  }
  closeSamToolbarPopups();
  ensureSamBaseSnapshot();
  samPredicting.value = true;
  samTextPredicting.value = true;
  try {
    const result = await predictSamText({
      image: props.samImage,
      imageType: props.samImageType,
      modelId: getTextModelId(),
      text: prompt,
      language: promptSpec.language,
      promptSource: promptSpec.source,
      promptColor: promptSpec.color,
      promptNoun: promptSpec.noun,
    });
    samLastPerformance.value = result.performance ? { ...result.performance } : null;
    const nextCandidates = (result.candidates || []).map((candidate, index) =>
      buildSamTextCandidate(candidate, index, result, prompt)
    );
    samOperationIndex.value += 1;
    if (!nextCandidates.length) {
      $q.notify({
        type: "warning",
        message: "未找到匹配的文本目标",
        position: "top",
      });
      saveSamContextSession();
      return;
    }
    samCandidates.value = [...samCandidates.value, ...nextCandidates];
    await renderSamCandidates({ pushHistory: true });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "SAM3 文本智能选区失败",
      position: "top",
    });
  } finally {
    samTextPredicting.value = false;
    samPredicting.value = false;
  }
};

const requestSamTextBatchPrediction = () => {
  const promptSpec = samTextPromptSpec.value;
  const prompt = promptSpec.text;
  if (!canRunSamBatchTextPrediction.value || !prompt) return;
  closeSamToolbarPopups();
  emit("sam-text-batch-request", {
    text: prompt,
    language: promptSpec.language,
    modelId: getTextModelId(),
    promptSource: promptSpec.source,
    promptColor: promptSpec.color,
    promptNoun: promptSpec.noun,
  });
};

const cancelSamTextBatchPrediction = () => {
  emit("sam-text-batch-cancel");
};

const composeSamMaskDataUrl = async ({ baseMask = "", candidates = [], width = 0, height = 0 } = {}) => {
  if (!width || !height) return "";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return "";

  if (baseMask) {
    const baseImage = await drawImageUrlToContext(baseMask);
    canvasContext.drawImage(baseImage, 0, 0, width, height);
  }

  for (const candidate of candidates) {
    if (!candidate.enabled || !candidate.mask) continue;
    const candidateMask = await resolveSamCandidateMaskForRendering(candidate, { width, height });
    const maskImage = await drawImageUrlToContext(candidateMask);
    canvasContext.drawImage(maskImage, 0, 0, width, height);
  }

  const imageData = canvasContext.getImageData(0, 0, width, height);
  if (!imageData.data.some((value, index) => index % 4 === 3 && value > 0)) {
    return "";
  }
  return canvas.toDataURL("image/png");
};

const appendExternalSamTextResult = async ({
  contextId = "",
  modelId = "",
  result = {},
  prompt = "",
  baseMask = "",
} = {}) => {
  const sessionKey = buildSamContextId(contextId);
  if (!sessionKey) return { candidates: [], mask: "", performance: result.performance || null };

  const previousSession = samSessionByContext.get(sessionKey) || {};
  const previousCandidates = cloneSamCandidates(previousSession.candidates || []);
  const previousOperationIndex = Number.isInteger(previousSession.operationIndex)
    ? previousSession.operationIndex
    : 0;
  const nextCandidates = (result.candidates || []).map((candidate, index) => ({
    ...candidate,
    localId: `${Date.now()}-${previousOperationIndex}-batch-text-${index}`,
    label: `文本候选 ${previousCandidates.length + index + 1}`,
    enabled: index === 0,
    source: "text",
    modelId: modelId || getTextModelId(),
    prompt: candidate.prompt || result.prompt || { type: "text", text: prompt },
    createdAt: new Date().toISOString(),
  }));
  const mergedCandidates = [...previousCandidates, ...nextCandidates];
  const width = Number(result.width || 0);
  const height = Number(result.height || 0);
  const baseSnapshotDataUrl = previousSession.baseSnapshotDataUrl || baseMask || "";
  const composedMask = await composeSamMaskDataUrl({
    baseMask: baseSnapshotDataUrl,
    candidates: mergedCandidates,
    width,
    height,
  });

  samSessionByContext.set(sessionKey, {
    ...previousSession,
    candidates: mergedCandidates,
    hoveredCandidateId: previousSession.hoveredCandidateId || "",
    baseSnapshot: previousSession.baseSnapshot || null,
    baseSnapshotDataUrl,
    operationIndex: previousOperationIndex + 1,
    lastPerformance: result.performance ? { ...result.performance } : previousSession.lastPerformance || null,
  });

  if (sessionKey === activeSamContextId.value) {
    samCandidates.value = cloneSamCandidates(mergedCandidates);
    samBaseSnapshotDataUrl.value = baseSnapshotDataUrl;
    samOperationIndex.value = previousOperationIndex + 1;
    samLastPerformance.value = result.performance ? { ...result.performance } : samLastPerformance.value;
    if (ctx.value && maskCanvas.value) {
      await renderSamCandidates({ pushHistory: nextCandidates.length > 0 });
    }
  }

  return {
    candidates: nextCandidates,
    mask: composedMask,
    performance: result.performance || null,
  };
};

const setSamCandidateEnabled = async (localId, enabled) => {
  const candidate = samCandidates.value.find((item) => item.localId === localId);
  if (!candidate) return;
  candidate.enabled = Boolean(enabled);
  await renderSamCandidates({ pushHistory: true });
};

const removeSamCandidate = async (localId) => {
  samCandidates.value = samCandidates.value.filter((item) => item.localId !== localId);
  if (hoveredSamCandidateId.value === localId) {
    hoveredSamCandidateId.value = "";
  }
  if (samCandidates.value.length === 0) {
    samCandidateMenuOpen.value = false;
    hoveredSamCandidateId.value = "";
  }
  await renderSamCandidates({ pushHistory: true });
};

const clearSamCandidates = async () => {
  samCandidates.value = [];
  hoveredSamCandidateId.value = "";
  samCandidateMenuOpen.value = false;
  samLastPerformance.value = null;
  await renderSamCandidates({ pushHistory: true, saveSession: false });
  samBaseSnapshot.value = null;
  saveSamContextSession();
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

const canvasHasVisibleMaskPixels = () => {
  const canvas = maskCanvas.value;
  if (!canvas || !ctx.value || canvas.width <= 0 || canvas.height <= 0) return false;

  try {
    const pixels = ctx.value.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) return true;
    }
    return false;
  } catch (error) {
    console.error("Failed to inspect mask canvas:", error);
    return true;
  }
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

const getMaskData = () => {
  if (!canvasHasVisibleMaskPixels()) return "";
  return maskCanvas.value?.toDataURL("image/png") || "";
};

const emitMask = () => {
  if (!ctx.value || !maskCanvas.value) return;

  if (!canvasHasVisibleMaskPixels()) {
    pendingMaskSyncDataUrl.value = "";
    emit("update:mask", null);
    return;
  }

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

const finishCurrentOperation = async (event = null) => {
  if (samEraseOperation.value) {
    await finishSamEraseOperation(event);
    return;
  }

  const result = rasterMaskEditor.finishOperation(event ? getCanvasPoint(event) : null);
  rectPreview.value = null;
  detachDrawingWindowListeners();
  if (result.changed) {
    if (await syncSamBaseSnapshotFromManualOperation(result)) {
      return;
    }
    appendHistorySnapshot(result.imageData);
    emitMask();
  }
};

const cancelCurrentOperation = () => {
  samPointerStart.value = null;
  samDragPoint.value = null;
  samEraseOperation.value = null;
  rasterMaskEditor.cancelOperation();
  rectPreview.value = null;
  detachDrawingWindowListeners();
};

const finishSamEraseOperation = async (event = null) => {
  const result = rasterMaskEditor.finishOperation(event ? getCanvasPoint(event) : null);
  samEraseOperation.value = null;
  rectPreview.value = null;
  detachDrawingWindowListeners();

  if (!result.changed || !result.operation) {
    await renderSamCandidates({ pushHistory: false });
    return;
  }

  const changed = await applySamEraseOperationToEnabledCandidates(result.operation);
  await renderSamCandidates({ pushHistory: changed });
};

const handleWindowPointerMove = (event) => {
  if (smartSelectionMode.value && samPointerStart.value) {
    updateCursorPosition(event);
    samDragPoint.value = getCanvasPoint(event);
    event.preventDefault();
    return;
  }
  if (!rasterMaskEditor.isOperating.value) return;
  updateCursorPosition(event);
  rasterMaskEditor.updateOperation(getCanvasPoint(event));
  event.preventDefault();
};

const finishSamPointerOperation = async (event) => {
  const startPoint = samPointerStart.value;
  const endPoint = getCanvasPoint(event) || samDragPoint.value || startPoint;
  samPointerStart.value = null;
  samDragPoint.value = null;
  detachDrawingWindowListeners();
  if (!startPoint || !endPoint) return;

  const rect = normalizeCanvasRect(startPoint, endPoint);
  const isBoxPrompt = rect && (rect.width >= 8 || rect.height >= 8);
  if (isBoxPrompt) {
    await runSamPrediction({ box: rect });
    return;
  }

  await runSamPrediction({
    point: {
      x: Math.round(endPoint.x),
      y: Math.round(endPoint.y),
      label: 1,
    },
  });
};

const handleWindowPointerUp = async (event) => {
  if (smartSelectionMode.value && samPointerStart.value) {
    updateCursorPosition(event);
    await finishSamPointerOperation(event);
    event.preventDefault();
    return;
  }
  if (samEraseOperation.value) {
    updateCursorPosition(event);
    await finishSamEraseOperation(event);
    event.preventDefault();
    return;
  }
  if (!rasterMaskEditor.isOperating.value) {
    detachDrawingWindowListeners();
    return;
  }

  updateCursorPosition(event);
  await finishCurrentOperation(event);
  event.preventDefault();
};

const handleCanvasPointerDown = (event) => {
  if (event.button !== 0 || !effectiveDrawingEnabled.value || !maskCanvas.value || !ctx.value) {
    return;
  }

  updateCursorPosition(event);
  if (smartSelectionMode.value) {
    if (smartEraseDrawingEnabled.value) {
      const result = rasterMaskEditor.beginOperation(getCanvasPoint(event));
      rectPreview.value = rasterMaskEditor.rectPreview.value;
      if (!result.started) return;
      samEraseOperation.value = {
        startedAt: Date.now(),
      };
      detachDrawingWindowListeners();
      window.addEventListener("pointermove", handleWindowPointerMove, true);
      window.addEventListener("pointerup", handleWindowPointerUp, true);
      isDrawingWindowBound.value = true;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    samPointerStart.value = getCanvasPoint(event);
    samDragPoint.value = samPointerStart.value;
    detachDrawingWindowListeners();
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerUp, true);
    isDrawingWindowBound.value = true;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

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
  if (!rasterMaskEditor.isOperating.value && !samEraseOperation.value) {
    cursorPosition.value = null;
  }
};

const setSamToolMode = (value) => {
  const nextMode = Object.values(SAM_TOOL_MODES).includes(value)
    ? value
    : SAM_TOOL_MODES.SELECT;
  if (nextMode === SAM_TOOL_MODES.ERASE && !canUseSamEraseTool.value) {
    $q.notify({
      type: "warning",
      message: samEraseTooltip.value,
      position: "top",
    });
    return;
  }
  if (samToolMode.value === nextMode) return;

  samPointerStart.value = null;
  samDragPoint.value = null;
  if (rasterMaskEditor.isOperating.value || samEraseOperation.value) {
    cancelCurrentOperation();
  }
  samToolMode.value = nextMode;
};

const toggleSamToolMode = () => {
  if (samToolMode.value === SAM_TOOL_MODES.ERASE) {
    setSamToolMode(SAM_TOOL_MODES.SELECT);
    return;
  }
  setSamToolMode(SAM_TOOL_MODES.ERASE);
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
  if (!nextValue && rasterMaskEditor.isOperating.value) {
    void finishCurrentOperation();
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

  if (props.samTextAvailable) {
    refreshSamTextLexicon();
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
  emit("sam-processing-state", {
    running: false,
    message: "",
    progress: null,
  });
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
    void finishCurrentOperation();
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
    if (!enabled && rasterMaskEditor.isOperating.value) {
      void finishCurrentOperation();
    }
  }
);

watch(
  () => props.smartSelectionMode,
  (enabled) => {
    if (!enabled) {
      samPointerStart.value = null;
      samDragPoint.value = null;
    }
    if (enabled && rasterMaskEditor.isOperating.value) {
      cancelCurrentOperation();
    }
    if (enabled && props.samTextAvailable) {
      refreshSamTextLexicon();
    }
    nextTick(() => {
      restoreToolbarState();
    });
  }
);

watch(
  () => props.samTextAvailable,
  (available) => {
    if (available) {
      refreshSamTextLexicon();
    }
  },
  { immediate: true }
);

watch(
  () => [props.samContextId, props.samImage, props.samImageType],
  async () => {
    saveSamContextSession();
    restoreSamContextSession();
    await nextTick();
    if (samCandidates.value.length && ctx.value && maskCanvas.value) {
      await renderSamCandidates({ pushHistory: false });
    }
  },
  { immediate: true }
);

watch(
  () => props.currentModel,
  async () => {
    if (!samCandidates.value.length || !ctx.value || !maskCanvas.value) return;
    await renderSamCandidates({ pushHistory: false });
  }
);

watch(
  [() => props.samModelId, resolvedSamModelOptions],
  () => {
    const options = resolvedSamModelOptions.value;
    const currentAvailable = options.some((option) => option.value === selectedSamModelId.value);
    if (currentAvailable) return;
    selectedSamModelId.value = props.samModelId || options[0]?.value || "sam_vit_b";
  },
  { immediate: true }
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
  samProcessingState,
  (state) => {
    if (state.running) {
      closeSamToolbarPopups();
    }
    emit("sam-processing-state", state);
  },
  { immediate: true, deep: true }
);

watch(
  canUseSamEraseTool,
  (enabled) => {
    if (enabled || samToolMode.value !== SAM_TOOL_MODES.ERASE) return;
    if (samEraseOperation.value || rasterMaskEditor.isOperating.value) {
      cancelCurrentOperation();
    }
    samToolMode.value = SAM_TOOL_MODES.SELECT;
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

    saveSamContextSession();
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
  undo,
  resetView,
  appendExternalSamTextResult,
  isReady: () => Boolean(maskCanvas.value && ctx.value),
  canUndo: () => canUndo.value,
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

.sam-box-preview {
  position: absolute;
  z-index: 999;
  border: 1px dashed rgba(25, 118, 210, 0.95);
  background: rgba(25, 118, 210, 0.1);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.42);
  pointer-events: none;
}

.sam-candidate-preview {
  z-index: 1000;
  opacity: 0.72;
  filter: drop-shadow(0 0 2px rgba(24, 144, 255, 0.85));
  pointer-events: none;
  mix-blend-mode: screen;
}

.sam-toolbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  min-width: 430px;
  flex-wrap: nowrap;
}

.sam-tool-main-group {
  display: flex;
  align-items: stretch;
  flex-wrap: nowrap;
  min-width: 0;
  border-radius: 999px;
  overflow: hidden;
}

.sam-control-button {
  min-width: 46px;
  min-height: 42px;
  border-radius: 0;
}

.sam-control-button-status {
  border-top-left-radius: 999px !important;
  border-bottom-left-radius: 999px !important;
}

.sam-control-button-candidates {
  border-top-right-radius: 999px !important;
  border-bottom-right-radius: 999px !important;
}

.sam-control-group {
  min-height: 42px;
  flex: 0 0 auto;
}

@media (max-width: 560px) {
  .sam-toolbar-controls {
    min-width: 0;
    gap: 6px;
  }

  .sam-control-button,
  .sam-control-group :deep(.q-btn),
  .toolbar-side-actions :deep(.q-btn) {
    min-width: 40px;
    padding-left: 8px;
    padding-right: 8px;
  }
}

.sam-settings-panel,
.sam-text-panel,
.sam-candidate-panel {
  width: min(420px, calc(100vw - 32px));
  color: rgba(17, 24, 39, 0.9);
}

.sam-settings-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
}

.sam-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 32px;
}

.sam-popup-header--compact {
  min-height: 28px;
}

.sam-settings-hint {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(75, 85, 99, 0.9);
  background: rgba(255, 255, 255, 0.5);
}

.sam-performance-state {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(75, 85, 99, 0.9);
  background: rgba(25, 118, 210, 0.08);
}

.sam-cuda-usage-hint {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(5, 95, 70, 0.96);
  background: rgba(16, 185, 129, 0.12);
}

.sam-auto-expand-notice {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(146, 64, 14, 0.96);
  background: rgba(245, 158, 11, 0.14);
}

.sam-model-select {
  margin-top: 8px;
}

.sam-empty-state {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(75, 85, 99, 0.92);
  background: rgba(255, 255, 255, 0.5);
}

.sam-text-prompt {
  margin-top: 8px;
}

.sam-text-prompt :deep(.q-field__control) {
  background: rgba(255, 255, 255, 0.44);
}

.sam-text-prompt :deep(.q-field__append) {
  gap: 2px;
}

.sam-lexicon-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 8px;
  margin-top: 8px;
}

.sam-lexicon-select :deep(.q-field__control) {
  background: rgba(255, 255, 255, 0.44);
}

.sam-generated-prompt {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
  color: rgba(31, 41, 55, 0.9);
  background: rgba(59, 130, 246, 0.1);
}

.sam-batch-state {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: rgba(31, 41, 55, 0.9);
  background: rgba(255, 255, 255, 0.52);
}

.sam-batch-state-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.sam-text-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  margin-top: 10px;
}

.sam-candidate-list {
  margin-top: 8px;
  max-height: 260px;
  overflow: auto;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.5);
}

:global(.mask-toolbar-popup) {
  border-radius: 20px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  overflow: hidden;
}

:global(.sam-toolbar-popup-layer),
:global(.sam-toolbar-tooltip-layer) {
  z-index: 3200 !important;
}

:global(body.body--dark .mask-toolbar-popup) {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(24, 24, 27, 0.96);
  box-shadow: 0 20px 42px rgba(0, 0, 0, 0.4);
}

.masker-dark .sam-settings-panel,
.masker-dark .sam-text-panel,
.masker-dark .sam-candidate-panel,
:global(body.body--dark .sam-settings-panel),
:global(body.body--dark .sam-text-panel),
:global(body.body--dark .sam-candidate-panel) {
  color: rgba(244, 244, 245, 0.94);
}

.masker-dark .sam-settings-hint,
:global(body.body--dark .sam-settings-hint) {
  color: rgba(228, 228, 231, 0.86);
  background: rgba(39, 39, 42, 0.62);
}

.masker-dark .sam-empty-state,
:global(body.body--dark .sam-empty-state) {
  color: rgba(228, 228, 231, 0.86);
  background: rgba(39, 39, 42, 0.62);
}

.masker-dark .sam-performance-state,
:global(body.body--dark .sam-performance-state) {
  color: rgba(228, 228, 231, 0.86);
  background: rgba(59, 130, 246, 0.16);
}

.masker-dark .sam-cuda-usage-hint,
:global(body.body--dark .sam-cuda-usage-hint) {
  color: rgba(167, 243, 208, 0.96);
  background: rgba(16, 185, 129, 0.16);
}

.masker-dark .sam-auto-expand-notice,
:global(body.body--dark .sam-auto-expand-notice) {
  color: rgba(253, 230, 138, 0.95);
  background: rgba(245, 158, 11, 0.18);
}

:global(body.body--dark .sam-text-prompt .q-field__control),
.masker-dark .sam-text-prompt :deep(.q-field__control) {
  background: rgba(39, 39, 42, 0.5);
}

:global(body.body--dark .sam-lexicon-select .q-field__control),
.masker-dark .sam-lexicon-select :deep(.q-field__control) {
  background: rgba(39, 39, 42, 0.5);
}

.masker-dark .sam-generated-prompt,
:global(body.body--dark .sam-generated-prompt) {
  color: rgba(228, 228, 231, 0.9);
  background: rgba(59, 130, 246, 0.16);
}

.masker-dark .sam-batch-state,
:global(body.body--dark .sam-batch-state) {
  color: rgba(228, 228, 231, 0.9);
  background: rgba(39, 39, 42, 0.62);
}

.masker-dark .sam-candidate-list,
:global(body.body--dark .sam-candidate-list) {
  background: rgba(39, 39, 42, 0.62);
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

.masker-dark .app-floating-toolbar {
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

.masker-dark .toolbar-side-actions :deep(.q-btn) {
  color: rgba(244, 244, 245, 0.94);
}
</style>
