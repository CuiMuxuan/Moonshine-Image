<template>
  <div class="resource-manage" :class="{ 'resource-manage--dark': $q.dark.isActive }">
    <VideoUploaderButton @uploaded="handleVideoUploaded" @cleared="handleVideoCleared" />

    <div v-if="videoStore.hasVideoFile" class="q-mt-md">
      <q-tabs
        v-model="tab"
        dense
        align="justify"
        active-color="primary"
        indicator-color="primary"
      >
        <q-tab name="info" label="视频信息" />
        <q-tab name="runtime" label="运行设置" />
      </q-tabs>

      <q-separator class="q-my-sm" />

      <q-tab-panels v-model="tab" animated class="bg-transparent">
        <q-tab-panel name="info" class="q-pa-none">
          <div class="info-grid">
            <div class="info-item">
              <span class="label">文件名</span>
              <span class="value ellipsis">{{ videoInfo?.name || "-" }}</span>
            </div>
            <div class="info-item">
              <span class="label">时长</span>
              <span class="value">{{ durationText }}</span>
            </div>
            <div class="info-item">
              <span class="label">原始分辨率</span>
              <span class="value">{{ exportSizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">预览分辨率</span>
              <span class="value">{{ previewSizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">文件大小</span>
              <span class="value">{{ fileSizeText }}</span>
            </div>
            <div class="info-item">
              <span class="label">每批帧数</span>
              <span class="value">{{ computedBatchSize || "-" }}</span>
            </div>
            <div class="info-item">
              <span class="label">当前来源</span>
              <span class="value">
                {{ videoStore.currentSourceIsReplacement ? "替换后视频" : "原始上传视频" }}
              </span>
            </div>
          </div>
        </q-tab-panel>

        <q-tab-panel name="runtime" class="q-pa-none">
          <div class="model-settings q-mb-sm">
            <div class="field-label">处理模型</div>
            <q-select
              :model-value="currentModel"
              :options="modelOptions"
              emit-value
              map-options
              filled
              dense
              :disable="isProcessing"
              @update:model-value="emit('update:currentModel', $event)"
            />
            <div class="model-status-row q-mt-sm">
              <q-chip
                dense
                square
                :color="modelStatusColor"
                text-color="white"
                class="model-status-chip"
              >
                {{ modelStatusLabel }}
              </q-chip>
              <q-btn
                flat
                dense
                no-caps
                color="primary"
                icon="settings"
                label="模型管理"
                @click="emit('openModelManagement', currentModel)"
              />
            </div>
          </div>

          <div
            v-if="isSlbrModel && parameterFields.length > 0"
            class="slbr-parameters q-mb-md"
          >
            <div class="field-label">模型参数</div>
            <q-btn
              v-if="showModelParameterHelp"
              flat
              round
              dense
              size="sm"
              color="primary"
              icon="help_outline"
              class="parameter-help-button"
            >
              <q-tooltip class="parameter-help-tooltip">
                {{ modelParameterHelp }}
              </q-tooltip>
            </q-btn>
            <div class="parameter-grid">
              <q-select
                v-for="field in selectParameterFields"
                :key="field.key"
                :model-value="modelParameterValues[field.key]"
                :options="getSelectOptions(field)"
                :label="field.label"
                dense
                filled
                emit-value
                map-options
                :disable="isProcessing"
                @update:model-value="emit('updateModelParameter', field.key, $event)"
              />
              <q-input
                v-for="field in numberParameterFields"
                :key="field.key"
                :model-value="modelParameterValues[field.key]"
                type="number"
                :label="field.label"
                dense
                filled
                :min="field.min"
                :max="field.max"
                :step="field.step"
                :disable="isProcessing"
                @update:model-value="emit('updateModelParameter', field.key, normalizeFieldValue(field, $event))"
              />
            </div>
            <q-btn
              v-if="hasRecommendedParameters"
              outline
              no-caps
              dense
              color="primary"
              icon="auto_fix_high"
              label="使用推荐参数"
              class="full-width sidebar-action-button q-mt-sm"
              :disable="isProcessing"
              @click="emit('applyRecommendedParameters', recommendedParameters)"
            />
          </div>

          <div class="row q-col-gutter-sm q-mb-sm">
            <div :class="isSlbrModel ? 'col-12' : 'col-6'">
              <q-btn
                outline
                no-caps
                color="primary"
                icon="add"
                :label="isSlbrModel ? '增加范围' : '新建蒙版'"
                class="full-width sidebar-action-button"
                :disable="isProcessing"
                @click="handleCreatePrimaryItem"
              />
            </div>
            <div v-if="!isSlbrModel" class="col-6">
              <q-btn
                outline
                no-caps
                color="primary"
                icon="auto_awesome_motion"
                label="智能选区"
                class="full-width sidebar-action-button"
                :disable="samVideoActionDisabled"
                :loading="samVideoRunning"
                @click="emit('run-sam-video-selection')"
              >
                <q-tooltip>{{ samVideoActionTooltip }}</q-tooltip>
              </q-btn>
            </div>
          </div>

          <q-list v-if="!isSlbrModel" bordered separator class="mask-list">
            <q-item
              v-for="mask in videoStore.masks"
              :key="mask.id"
              clickable
              :active="mask.id === videoStore.selectedMaskId"
              active-class="mask-item-active"
              @click="videoStore.selectMask(mask.id)"
            >
              <q-item-section>
                <q-item-label class="mask-title-row">
                  <span>{{ mask.name }}</span>
                  <q-badge v-if="mask.type === 'samVideo'" color="amber-8" text-color="white">
                    SAM
                  </q-badge>
                </q-item-label>
                <q-item-label caption>
                  {{ formatSeconds(mask.startTime) }} - {{ formatSeconds(mask.endTime) }}
                </q-item-label>
                <div v-if="mask.type === 'samVideo'" class="sam-object-list">
                  <div
                    v-for="objectItem in mask.samObjects || []"
                    :key="`${mask.id}-${objectItem.objectId}`"
                    class="sam-object-row"
                  >
                    <q-checkbox
                      dense
                      :model-value="objectItem.enabled !== false"
                      :disable="isProcessing"
                      :label="`对象 ${objectItem.objectId}`"
                      @update:model-value="
                        (value) =>
                          videoStore.setSamVideoObjectEnabled(mask.id, objectItem.objectId, value)
                      "
                    />
                    <q-btn
                      flat
                      round
                      dense
                      icon="delete"
                      color="negative"
                      :disable="isProcessing"
                      @click.stop="emit('remove-sam-video-object', { maskId: mask.id, objectId: objectItem.objectId })"
                    >
                      <q-tooltip>删除对象</q-tooltip>
                    </q-btn>
                  </div>
                </div>
              </q-item-section>

              <q-item-section side>
                <q-btn
                  flat
                  round
                  dense
                  icon="delete"
                  color="negative"
                  :disable="isProcessing"
                  @click.stop="emit('remove-mask', mask.id)"
                />
              </q-item-section>
            </q-item>

            <q-item v-if="videoStore.masks.length === 0">
              <q-item-section class="text-grey-6">
                还没有蒙版，先创建一个蒙版开始编辑。
              </q-item-section>
            </q-item>
          </q-list>

          <q-list v-else bordered separator class="mask-list">
            <q-item
              v-for="range in videoStore.processingRanges"
              :key="range.id"
              clickable
              :active="range.id === videoStore.selectedProcessingRangeId"
              active-class="mask-item-active"
              @click="videoStore.selectProcessingRange(range.id)"
            >
              <q-item-section>
                <q-item-label>{{ range.name }}</q-item-label>
                <q-item-label caption>
                  {{ formatSeconds(range.startTime) }} - {{ formatSeconds(range.endTime) }}
                </q-item-label>
              </q-item-section>

              <q-item-section side>
                <q-btn
                  flat
                  round
                  dense
                  icon="delete"
                  color="negative"
                  :disable="isProcessing"
                  @click.stop="videoStore.removeProcessingRange(range.id)"
                />
              </q-item-section>
            </q-item>

            <q-item v-if="videoStore.processingRanges.length === 0">
              <q-item-section class="text-grey-6">
                未增加范围时会处理完整视频；也可以增加范围来减少处理时间。
              </q-item-section>
            </q-item>
          </q-list>

          <q-separator class="q-my-md" />

          <q-select
            :model-value="exportFpsMode"
            :options="fpsOptions"
            emit-value
            map-options
            label="导出帧率"
            :disable="isProcessing"
            @update:model-value="emit('update:exportFpsMode', $event)"
          />

          <div
            v-if="processingSucceeded && lastOutputPath"
            class="result-status text-positive text-weight-medium q-mt-md"
          >
            {{ lastOutputIsPreview ? "样片试跑完成" : "处理完成" }}
          </div>

          <div v-if="processingMessage" class="text-caption q-mt-sm text-grey-7">
            {{ processingMessage }}
          </div>

          <div class="preview-trial-row q-mt-md">
            <q-select
              dense
              outlined
              class="preview-trial-select"
              :model-value="previewTrialSeconds"
              :options="previewTrialOptions"
              emit-value
              map-options
              label="样片长度"
              :disable="isProcessing"
              @update:model-value="emit('update:previewTrialSeconds', $event)"
            />
            <span
              :class="[
                'preview-trial-button-wrap',
                { 'action-button-icon-only': actionButtonMode === 'icon' },
              ]"
              @click="handleRunWrapperClick"
            >
              <q-btn
                outline
                no-caps
                color="primary"
                icon="movie_filter"
                :label="actionButtonMode === 'icon' ? undefined : previewButtonLabel"
                :disable="!canRun || isProcessing || engineRunDisabled"
                :class="[
                  'action-button',
                  'sidebar-action-button',
                  { 'action-button-icon-only': actionButtonMode === 'icon' },
                ]"
                @click.stop="emit('run-preview')"
              />
              <q-tooltip>{{ previewActionTooltip }}</q-tooltip>
            </span>
          </div>

          <div ref="actionButtonsRef" class="action-buttons-row q-pt-md">
            <span
              :class="[
                'action-button-tooltip-wrap',
                { 'action-button-icon-only': actionButtonMode === 'icon' },
              ]"
              @click="handleRunWrapperClick"
            >
              <q-btn
                outline
                no-caps
                color="primary"
                :icon="runButtonIcon"
                :label="actionButtonMode === 'icon' ? undefined : runButtonLabel"
                :disable="!canRun || isProcessing || engineRunDisabled || enginePreparing"
                :loading="isProcessing || enginePreparing"
                :class="[
                  'action-button',
                  'sidebar-action-button',
                  'action-button-primary',
                  { 'action-button-icon-only': actionButtonMode === 'icon' },
                ]"
                @click.stop="emit('run')"
              >
                <template #loading>
                  <q-spinner size="20px" class="on-left" />
                  <span v-if="actionButtonMode !== 'icon'">{{ runButtonLabel }}</span>
                </template>
              </q-btn>
              <q-tooltip>{{ runActionTooltip }}</q-tooltip>
            </span>

            <q-btn
              outline
              no-caps
              color="primary"
              icon="folder_open"
              :label="actionButtonMode === 'icon' ? undefined : openButtonLabel"
              :disable="!canOpenOutput"
              :class="[
                'action-button',
                'sidebar-action-button',
                { 'action-button-icon-only': actionButtonMode === 'icon' },
              ]"
              @click="emit('open-output')"
            >
              <q-tooltip>打开目录</q-tooltip>
            </q-btn>
          </div>

          <div class="row q-col-gutter-sm q-mt-sm">
            <div class="col-12">
              <q-btn
                outline
                no-caps
                color="primary"
                icon="swap_horiz"
                label="替换当前视频源文件"
                class="full-width sidebar-action-button"
                :disable="!canReplaceSource || isProcessing"
                @click="emit('replace-source')"
              />
            </div>
            <div class="col-12" v-if="canRollbackHistory">
              <q-btn
                outline
                no-caps
                color="secondary"
                icon="history"
                label="回退到历史记录"
                class="full-width sidebar-action-button"
                :disable="isProcessing"
                @click="showHistoryDialog = true"
              />
            </div>
          </div>

          <q-input
            v-if="lastOutputPath"
            :model-value="lastOutputPath"
            readonly
            label="最近输出文件"
            class="q-mt-md"
          />
        </q-tab-panel>
      </q-tab-panels>
    </div>

    <q-dialog v-model="showHistoryDialog">
      <q-card class="history-dialog-card">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">视频历史记录</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>

        <q-card-section class="history-list-wrap">
          <q-list bordered separator>
            <q-item v-for="entry in historyEntries" :key="entry.id" class="history-item">
              <q-item-section>
                <q-item-label class="row items-center q-gutter-sm no-wrap">
                  <span class="ellipsis">{{ entry.fileName || entry.label || "历史记录" }}</span>
                  <q-chip
                    dense
                    square
                    size="sm"
                    :color="entry.isReplacement ? 'secondary' : 'grey-6'"
                    text-color="white"
                  >
                    {{ entry.isReplacement ? "替换" : "原始" }}
                  </q-chip>
                </q-item-label>
                <q-item-label caption class="ellipsis">
                  {{ formatHistoryTime(entry.createdAt) }}
                </q-item-label>
                <q-item-label caption class="ellipsis">
                  {{ entry.filePath || "当前会话内文件对象" }}
                </q-item-label>
              </q-item-section>

              <q-item-section side>
                <q-btn color="primary" unelevated label="回退至此" @click="restoreHistory(entry.id)" />
              </q-item-section>
            </q-item>

            <q-item v-if="historyEntries.length === 0">
              <q-item-section class="text-grey-6">
                当前没有可回退的历史记录。
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useQuasar } from "quasar";

import { useVideoManagerStore } from "src/stores/videoManager";
import { formatSeconds } from "src/utils/videoMaskUtils";

import VideoUploaderButton from "./VideoUploaderButton.vue";

const props = defineProps({
  exportFpsMode: {
    type: String,
    default: "source",
  },
  fpsOptions: {
    type: Array,
    default: () => [],
  },
  previewSizeText: {
    type: String,
    default: "-",
  },
  exportSizeText: {
    type: String,
    default: "-",
  },
  computedBatchSize: {
    type: Number,
    default: 0,
  },
  canRun: {
    type: Boolean,
    default: false,
  },
  canOpenOutput: {
    type: Boolean,
    default: false,
  },
  isProcessing: {
    type: Boolean,
    default: false,
  },
  processingProgress: {
    type: Number,
    default: 0,
  },
  processingMessage: {
    type: String,
    default: "",
  },
  lastOutputPath: {
    type: String,
    default: "",
  },
  processingSucceeded: {
    type: Boolean,
    default: false,
  },
  lastOutputIsPreview: {
    type: Boolean,
    default: false,
  },
  previewTrialSeconds: {
    type: Number,
    default: 3,
  },
  previewTrialOptions: {
    type: Array,
    default: () => [],
  },
  activeTab: {
    type: String,
    default: "info",
  },
  canReplaceSource: {
    type: Boolean,
    default: false,
  },
  canRollbackHistory: {
    type: Boolean,
    default: false,
  },
  engineRunDisabled: {
    type: Boolean,
    default: false,
  },
  engineRunTooltip: {
    type: String,
    default: "",
  },
  enginePreparing: {
    type: Boolean,
    default: false,
  },
  enginePreparingLabel: {
    type: String,
    default: "",
  },
  engineFailed: {
    type: Boolean,
    default: false,
  },
  historyEntries: {
    type: Array,
    default: () => [],
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  modelOptions: {
    type: Array,
    default: () => [],
  },
  currentModelMetadata: {
    type: Object,
    default: () => ({}),
  },
  modelParameterValues: {
    type: Object,
    default: () => ({}),
  },
  backendRunning: {
    type: Boolean,
    default: false,
  },
  samVideoRunning: {
    type: Boolean,
    default: false,
  },
  samVideoActionDisabled: {
    type: Boolean,
    default: false,
  },
  samVideoActionTooltip: {
    type: String,
    default: "使用 SAM2 为当前视频创建智能蒙版轨道",
  },
});

const emit = defineEmits([
  "update:exportFpsMode",
  "update:previewTrialSeconds",
  "update:activeTab",
  "update:currentModel",
  "updateModelParameter",
  "applyRecommendedParameters",
  "openModelManagement",
  "run",
  "run-preview",
  "open-diagnostics",
  "open-output",
  "replace-source",
  "restore-history",
  "video-uploaded",
  "video-cleared",
  "run-sam-video-selection",
  "remove-sam-video-object",
  "remove-mask",
]);

const $q = useQuasar();
const videoStore = useVideoManagerStore();
const normalizeTabName = (value) => {
  if (value === "masks") return "runtime";
  if (value === "runtime" || value === "info") return value;
  return "info";
};

const tab = ref(normalizeTabName(props.activeTab));
const showHistoryDialog = ref(false);
const actionButtonsRef = ref(null);
const actionButtonMode = ref("full");
let actionButtonsObserver = null;

const FULL_ACTION_WIDTH = 236;
const SHORT_ACTION_WIDTH = 150;

const videoInfo = computed(() => videoStore.getVideoFileInfo());
const durationText = computed(() => formatSeconds(videoStore.videoDuration));
const fileSizeText = computed(() => {
  const size = Number(videoInfo.value?.size || 0);
  if (!size) return "-";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** index).toFixed(2)} ${units[index]}`;
});
const backendPreparingText = computed(
  () => props.enginePreparingLabel || props.engineRunTooltip || "正在启动后端服务"
);
const runButtonIcon = computed(() => (props.enginePreparing ? "sync" : "play_arrow"));
const runButtonLabel = computed(() => {
  if (props.enginePreparing) return "启动中";
  return actionButtonMode.value === "full" ? "运行处理" : "运行";
});
const runActionTooltip = computed(() => {
  if (props.enginePreparing) return backendPreparingText.value;
  if (props.engineRunDisabled && props.engineRunTooltip) {
    return props.engineRunTooltip;
  }
  return "运行处理";
});
const previewButtonLabel = computed(() =>
  actionButtonMode.value === "full" ? "试跑样片" : "试跑"
);
const previewActionTooltip = computed(() => {
  if (props.engineRunDisabled && props.engineRunTooltip) {
    return props.engineRunTooltip;
  }
  return `先处理前 ${props.previewTrialSeconds || 3} 秒样片`;
});
const openButtonLabel = computed(() =>
  actionButtonMode.value === "full" ? "打开目录" : "打开"
);
const isSlbrModel = computed(() => props.currentModel === "slbr");
const parameterSchema = computed(() => props.currentModelMetadata?.parameters || {});
const parameterFields = computed(() =>
  Object.entries(parameterSchema.value)
    .filter(([key, field]) => key !== "recommended" && field && typeof field === "object")
    .map(([key, field]) => ({ key, ...field }))
);
const selectParameterFields = computed(() =>
  parameterFields.value.filter((field) => field.type === "select")
);
const numberParameterFields = computed(() =>
  parameterFields.value.filter((field) => field.type !== "select")
);
const recommendedParameters = computed(() => parameterSchema.value.recommended || {});
const hasRecommendedParameters = computed(
  () => Object.keys(recommendedParameters.value || {}).length > 0
);
const modelParameterHelp = computed(() =>
  String(props.currentModelMetadata?.parameterHelp || "").trim()
);
const showModelParameterHelp = computed(() => Boolean(modelParameterHelp.value));
const modelStatusLabel = computed(() => {
  if (!props.backendRunning) return "后端未启动";
  if (props.currentModelMetadata?.corruptFiles?.length > 0) return "需修复";
  if (!props.currentModelMetadata?.installed) return "未安装";
  if (props.currentModelMetadata?.deviceCompatible === false) return "设备不适配";
  return "已安装";
});
const modelStatusColor = computed(() => {
  if (!props.backendRunning) return "grey-7";
  if (props.currentModelMetadata?.corruptFiles?.length > 0) return "warning";
  if (!props.currentModelMetadata?.installed) return "negative";
  if (props.currentModelMetadata?.deviceCompatible === false) return "warning";
  return "positive";
});

const getSelectOptions = (field) =>
  (Array.isArray(field.options) ? field.options : []).map((option) =>
    option && typeof option === "object"
      ? {
          label: option.label || option.value,
          value: option.value,
        }
      : {
          label: String(option),
          value: option,
        }
  );

const normalizeFieldValue = (field, value) => {
  if (field.type === "number") {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return field.default ?? "";
    const min = Number(field.min);
    const max = Number(field.max);
    const boundedMin = Number.isFinite(min) ? Math.max(numericValue, min) : numericValue;
    return Number.isFinite(max) ? Math.min(boundedMin, max) : boundedMin;
  }
  return value;
};

const disconnectActionButtonsObserver = () => {
  if (!actionButtonsObserver) return;
  actionButtonsObserver.disconnect();
  actionButtonsObserver = null;
};

const updateActionButtonMode = () => {
  const width = actionButtonsRef.value?.clientWidth || 0;
  if (width >= FULL_ACTION_WIDTH) {
    actionButtonMode.value = "full";
    return;
  }
  if (width >= SHORT_ACTION_WIDTH) {
    actionButtonMode.value = "short";
    return;
  }
  actionButtonMode.value = "icon";
};

const createMask = () => {
  videoStore.createMask({
    name: `蒙版 ${videoStore.masks.length + 1}`,
    startTime: 0,
    endTime: videoStore.videoDuration,
  });
};

const createProcessingRange = () => {
  videoStore.createProcessingRange({
    name: `范围 ${videoStore.processingRanges.length + 1}`,
    startTime: videoStore.currentTime,
  });
};

const handleCreatePrimaryItem = () => {
  if (isSlbrModel.value) {
    createProcessingRange();
    return;
  }
  createMask();
};

const handleRunWrapperClick = () => {
  if (props.engineFailed) {
    emit("open-diagnostics");
  }
};

const formatHistoryTime = (timestamp) => {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
};

const restoreHistory = (entryId) => {
  showHistoryDialog.value = false;
  emit("restore-history", entryId);
};

const setTab = (value) => {
  const normalized = normalizeTabName(value);
  if (tab.value !== normalized) {
    tab.value = normalized;
  }
};

const handleVideoUploaded = (payload) => {
  setTab("runtime");
  emit("video-uploaded", payload || {});
};

const handleVideoCleared = () => {
  setTab("info");
  emit("video-cleared");
};

watch(
  actionButtonsRef,
  async (element) => {
    disconnectActionButtonsObserver();
    await nextTick();
    updateActionButtonMode();

    if (!element || typeof ResizeObserver === "undefined") return;

    actionButtonsObserver = new ResizeObserver(() => {
      updateActionButtonMode();
    });
    actionButtonsObserver.observe(element);
  },
  {
    flush: "post",
  }
);

watch(
  () => videoStore.hasVideoFile,
  async () => {
    await nextTick();
    updateActionButtonMode();
  }
);

watch(
  () => props.activeTab,
  (value) => {
    const normalized = normalizeTabName(value);
    if (tab.value !== normalized) {
      tab.value = normalized;
    }
  },
  { immediate: true }
);

watch(tab, (value) => {
  const normalized = normalizeTabName(value);
  if (normalized !== value) {
    tab.value = normalized;
    return;
  }
  emit("update:activeTab", normalized);
});

onUnmounted(() => {
  disconnectActionButtonsObserver();
});
</script>

<style scoped>
.resource-manage {
  display: flex;
  flex-direction: column;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.label {
  color: #6b7280;
}

.field-label {
  color: #6b7280;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.value {
  color: #111827;
  text-align: right;
}

.mask-title-row {
  align-items: center;
  display: flex;
  gap: 8px;
}

.sam-object-list {
  border-left: 2px solid rgba(245, 158, 11, 0.35);
  display: grid;
  gap: 4px;
  margin-top: 8px;
  padding-left: 8px;
}

.sam-object-row {
  align-items: center;
  display: flex;
  gap: 6px;
  justify-content: space-between;
}

.model-settings,
.slbr-parameters {
  min-width: 0;
}

.slbr-parameters {
  position: relative;
}

.model-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.model-status-chip {
  margin-left: 0;
}

.parameter-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.parameter-help-button {
  position: absolute;
  top: -2px;
  right: 0;
  z-index: 1;
}

.parameter-help-tooltip {
  max-width: 320px;
  line-height: 1.35;
  white-space: pre-line;
}

.resource-manage--dark .info-item .label,
.resource-manage--dark .info-item .value,
.resource-manage--dark .field-label {
  color: #fff;
}

.mask-list {
  max-height: 280px;
  overflow: auto;
}

.mask-item-active {
  background: rgba(25, 118, 210, 0.1);
}

.result-status {
  font-size: 14px;
}

.action-buttons-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 10px;
  min-width: 0;
}

.preview-trial-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 10px;
  min-width: 0;
}

.preview-trial-select {
  width: 100%;
  min-width: 0;
}

.preview-trial-select :deep(.q-field__control) {
  min-height: 48px;
}

.action-button {
  width: 100%;
  min-width: 0;
  min-height: 48px;
}

.action-button-tooltip-wrap {
  display: flex;
  width: 100%;
  min-width: 0;
}

.preview-trial-button-wrap {
  display: flex;
  width: 100%;
  min-width: 0;
}

.action-button-icon-only {
  min-width: 40px;
}

.action-button-primary {
  min-width: 0;
}

.sidebar-action-button {
  min-height: 48px;
}

.sidebar-action-button :deep(.q-btn__content),
.action-button :deep(.q-btn__content) {
  width: 100%;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 8px;
  white-space: nowrap;
}

.history-dialog-card {
  width: min(720px, calc(100vw - 32px));
  max-width: 720px;
}

.history-list-wrap {
  max-height: min(60vh, 560px);
  overflow: auto;
}

.history-item {
  align-items: center;
}
</style>
