<template>
  <q-drawer
    v-model="drawerModel"
    overlay
    side="right"
    bordered
    :class="['image-settings-drawer', { 'image-settings-drawer--dark': $q.dark.isActive }]"
  >
    <q-scroll-area class="drawer-scroll">
      <div class="settings-content q-pa-md">
        <div class="settings-title">
          <q-icon name="tune" size="24px" />
          <div>
            <div class="text-h6">运行设置</div>
            <div class="text-caption text-grey-7">
              {{ backendAvailable ? "按当前模型动态配置运行条件" : "后端启动后会恢复模型运行设置" }}
            </div>
          </div>
        </div>

        <section
          v-if="!backendAvailable"
          class="settings-section backend-status-card"
          :class="`backend-status-card--${backendStatusTone}`"
        >
          <div class="backend-status-main">
            <div class="backend-status-icon">
              <q-spinner
                v-if="backendPreparing"
                color="primary"
                size="22px"
                thickness="4"
              />
              <q-icon
                v-else
                :name="backendFailed ? 'error_outline' : 'terminal'"
                size="22px"
              />
            </div>
            <div class="backend-status-copy">
              <div class="backend-status-title">{{ backendStatusTitle }}</div>
              <div class="backend-status-message">{{ backendStatusMessage }}</div>
            </div>
          </div>

          <div class="backend-status-actions">
            <q-btn
              outline
              no-caps
              color="primary"
              icon="terminal"
              :label="backendPreparing ? '查看后端管理' : '打开后端管理'"
              class="backend-status-button"
              @click="$emit('open-backend-manager')"
            />
          </div>
        </section>

        <section v-if="backendAvailable" class="settings-section">
          <div class="section-heading section-heading--split">
            <div class="section-heading-main">
              <q-icon name="memory" />
              <span>模型与范围</span>
            </div>
            <div class="heading-cuda-status">
              <cuda-status
                :backend-running="backendRunning"
                @cuda-status-changed="$emit('cuda-status-changed', $event)"
              />
            </div>
          </div>

          <model-selector
            :model-value="currentModel"
            :options="modelOptions"
            type="image"
            @update:model-value="$emit('update:current-model', $event)"
            @open-model-management="$emit('open-model-management', $event)"
          />

          <div class="q-mt-md">
            <div class="field-label">作用范围</div>
            <div class="scope-options">
              <q-btn
                v-for="option in scopedActionOptions"
                :key="option.value"
                outline
                no-caps
                class="scope-button"
                :color="normalizedActionScope.value === option.value ? 'primary' : 'grey-7'"
                :disable="option.disable"
                :label="option.label"
                @click="selectScope(option)"
              >
                <q-tooltip v-if="option.disable">
                  {{ option.disableReason }}
                </q-tooltip>
              </q-btn>
            </div>
          </div>

        </section>

        <section v-if="backendAvailable && parameterFields.length > 0" class="settings-section">
          <div class="section-heading">
            <q-icon name="tune" />
            <span>模型参数</span>
          </div>

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
            <div
              v-for="field in parameterFields"
              :key="field.key"
              class="parameter-field"
            >
              <q-select
                v-if="field.type === 'select'"
                :model-value="modelParameterValues[field.key]"
                :options="getSelectOptions(field)"
                :label="field.label"
                filled
                emit-value
                map-options
                @update:model-value="updateParameter(field.key, $event)"
              />

              <q-toggle
                v-else-if="field.type === 'switch'"
                :model-value="Boolean(modelParameterValues[field.key])"
                :label="field.label"
                @update:model-value="updateParameter(field.key, $event)"
              />

              <div v-else-if="field.type === 'slider'" class="slider-field">
                <div class="field-label">{{ field.label }}</div>
                <q-slider
                  :model-value="Number(modelParameterValues[field.key] ?? field.default ?? 0)"
                  :min="Number(field.min ?? 0)"
                  :max="Number(field.max ?? 100)"
                  :step="Number(field.step ?? 1)"
                  label
                  label-always
                  @update:model-value="updateParameter(field.key, $event)"
                />
              </div>

              <q-input
                v-else
                :model-value="modelParameterValues[field.key]"
                :type="field.type === 'text' ? 'text' : 'number'"
                :label="field.label"
                filled
                :min="field.min"
                :max="field.max"
                :step="field.step"
                :rules="getNumberRules(field)"
                @update:model-value="updateParameter(field.key, normalizeFieldValue(field, $event))"
              />

              <q-tooltip v-if="field.description">
                {{ field.description }}
              </q-tooltip>
            </div>
          </div>

          <q-btn
            v-if="hasRecommendedParameters"
            outline
            no-caps
            color="primary"
            icon="auto_fix_high"
            label="使用推荐参数"
            class="full-width settings-action-button q-mt-md"
            @click="applyRecommendedParameters"
          />
        </section>

        <section class="settings-section">
          <div class="section-heading">
            <q-icon name="fact_check" />
            <span>批量操作</span>
          </div>

          <div class="action-grid">
            <q-toggle
              :model-value="selectAll"
              label="全选文件"
              class="batch-toggle"
              @update:model-value="$emit('update:select-all', $event)"
            />
            <q-btn
              v-if="supportsAction('deleteSelected')"
              outline
              no-caps
              color="negative"
              icon="delete"
              label="删除选中文件"
              class="settings-action-button"
              :disable="selectedFiles.length === 0"
              @click="$emit('confirm-delete-selected')"
            />
            <q-btn
              v-if="supportsAction('applyCurrentMaskToSelected')"
              outline
              no-caps
              color="primary"
              icon="content_copy"
              label="将当前蒙版作用于选中文件"
              class="settings-action-button"
              :disable="selectedFiles.length === 0 || !hasCurrentMask"
              @click="$emit('apply-current-mask-to-selected')"
            />
            <div v-if="!hasActionButtons" class="empty-copy">
              当前模型没有额外批量操作。
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-heading">
            <q-icon name="folder_open" />
            <span>{{ backendAvailable ? "输出与设备" : "输出设置" }}</span>
          </div>

          <folder-selector
            v-if="backendAvailable && needsFolderInput('imageFolder')"
            :model-value="folderPath"
            label="输入文件夹"
            @update:model-value="$emit('update:folder-path', $event)"
          />

          <folder-selector
            v-if="backendAvailable && needsFolderInput('maskFolder')"
            :model-value="maskFolderPath"
            label="蒙版文件夹"
            class="q-mt-md"
            @update:model-value="$emit('update:mask-folder-path', $event)"
          />

          <folder-selector
            :model-value="savePath"
            label="保存路径"
            class="q-mt-md"
            @update:model-value="$emit('update:save-path', $event)"
          />

          <q-btn
            outline
            no-caps
            color="primary"
            icon="folder_open"
            label="打开保存路径"
            class="full-width settings-action-button q-mt-md"
            :disable="!canOpenSavePath"
            @click="$emit('open-save-path')"
          />

        </section>
      </div>
    </q-scroll-area>
  </q-drawer>
</template>

<script setup>
import { computed } from "vue";
import { useQuasar } from "quasar";

import CudaStatus from "src/components/common/CudaStatus.vue";
import FolderSelector from "src/components/common/FolderSelector.vue";
import ModelSelector from "src/components/common/ModelSelector.vue";

const actionScopeOptions = [
  { label: "仅选中文件", value: "selected" },
  { label: "整个文件夹", value: "folder" },
];

const DEFAULT_LAMA_RUN_CAPABILITIES = Object.freeze({
  scopes: ["selected", "folder"],
  folderInputs: ["imageFolder", "maskFolder"],
  batchActions: ["deleteSelected", "applyCurrentMaskToSelected"],
  outputRequired: true,
});

const props = defineProps({
  drawerOpen: {
    type: Boolean,
    default: false,
  },
  currentModel: {
    type: String,
    default: "lama",
  },
  modelMetadata: {
    type: Object,
    default: () => ({}),
  },
  modelOptions: {
    type: Array,
    default: () => [],
  },
  modelParameterValues: {
    type: Object,
    default: () => ({}),
  },
  actionScope: {
    type: Object,
    default: () => ({ label: "仅选中文件", value: "selected" }),
  },
  selectAll: {
    type: Boolean,
    default: false,
  },
  selectedFiles: {
    type: Array,
    default: () => [],
  },
  currentMask: {
    type: Object,
    default: null,
  },
  folderPath: {
    type: String,
    default: "",
  },
  maskFolderPath: {
    type: String,
    default: "",
  },
  savePath: {
    type: String,
    default: "",
  },
  canOpenSavePath: {
    type: Boolean,
    default: false,
  },
  backendRunning: {
    type: Boolean,
    default: false,
  },
  backendEngineState: {
    type: Object,
    default: () => ({}),
  },
});

const emit = defineEmits([
  "update:drawer-open",
  "update:current-model",
  "open-model-management",
  "update:action-scope",
  "update:select-all",
  "update:folder-path",
  "update:mask-folder-path",
  "update:model-parameter",
  "apply-recommended-parameters",
  "update:save-path",
  "confirm-delete-selected",
  "apply-current-mask-to-selected",
  "open-save-path",
  "open-backend-manager",
  "cuda-status-changed",
]);

const $q = useQuasar();

const readEngineValue = (key, fallback = "") => {
  const value = props.backendEngineState?.[key];
  return value?.value ?? value ?? fallback;
};

const backendAvailable = computed(() =>
  Boolean(props.backendRunning || readEngineValue("isRunning", false))
);
const backendPreparing = computed(() =>
  !backendAvailable.value && Boolean(readEngineValue("isPreparing", false))
);
const backendFailed = computed(() => Boolean(readEngineValue("hasFailed", false)));
const backendStatusTone = computed(() => {
  if (backendPreparing.value) return "preparing";
  if (backendFailed.value) return "failed";
  return "stopped";
});
const backendStatusTitle = computed(() =>
  backendPreparing.value ? "正在启动后端服务" : "未检测到后端服务"
);
const backendStatusMessage = computed(() => {
  if (backendPreparing.value) {
    const phaseLabel = String(readEngineValue("phaseLabel", "") || "").trim();
    return phaseLabel
      ? `${phaseLabel}，服务启动后会自动刷新模型设置。`
      : "正在启动服务，请稍等，服务启动后会自动刷新模型设置。";
  }

  const failureMessage = String(readEngineValue("runDisabledTooltip", "") || "").trim();
  if (backendFailed.value && failureMessage) {
    return failureMessage;
  }

  return "请打开后端管理启动服务，或手动启动后端。";
});

const runCapabilities = computed(() => {
  const capabilities = props.modelMetadata?.runCapabilities;
  if (capabilities && Object.keys(capabilities).length > 0) {
    return capabilities;
  }
  return props.currentModel === "lama" ? DEFAULT_LAMA_RUN_CAPABILITIES : {};
});
const supportedScopes = computed(() => runCapabilities.value.scopes || ["selected"]);
const supportedBatchActions = computed(() => [
  ...new Set(["deleteSelected", ...(runCapabilities.value.batchActions || [])]),
]);
const folderInputs = computed(() => runCapabilities.value.folderInputs || []);
const parameters = computed(() => props.modelMetadata?.parameters || {});
const modelParameterHelp = computed(() =>
  String(props.modelMetadata?.parameterHelp || "").trim()
);
const showModelParameterHelp = computed(() => Boolean(modelParameterHelp.value));
const recommendedParameters = computed(() => parameters.value.recommended || {});
const hasCurrentMask = computed(() =>
  Boolean(props.currentMask?.data || props.currentMask?.displayUrl)
);
const hasActionButtons = computed(() =>
  supportedBatchActions.value.some((actionId) => supportsAction(actionId))
);

const parameterFields = computed(() =>
  Object.entries(parameters.value)
    .filter(([key, value]) => key !== "recommended" && value && typeof value === "object")
    .map(([key, value]) => ({
      key,
      type: value.type || "number",
      label: value.label || key,
      ...value,
    }))
);

const hasRecommendedParameters = computed(() =>
  Object.keys(recommendedParameters.value || {}).length > 0
);

const normalizedActionScope = computed(() => {
  const matched = actionScopeOptions.find((option) => option.value === props.actionScope?.value);
  return matched || actionScopeOptions[0];
});

const scopedActionOptions = computed(() =>
  actionScopeOptions.map((option) => {
    const supported = supportedScopes.value.includes(option.value);
    return {
      ...option,
      disable: !supported,
      disableReason: supported ? "" : "当前模型不支持该作用范围",
    };
  })
);

const drawerModel = computed({
  get: () => props.drawerOpen,
  set: (value) => emit("update:drawer-open", value),
});

const selectScope = (option) => {
  if (option.disable) return;
  emit("update:action-scope", {
    label: option.label,
    value: option.value,
  });
};

const needsFolderInput = (inputId) =>
  normalizedActionScope.value.value === "folder" && folderInputs.value.includes(inputId);

const supportsAction = (actionId) => supportedBatchActions.value.includes(actionId);

const updateParameter = (key, value) => {
  emit("update:model-parameter", { key, value });
};

const applyRecommendedParameters = () => {
  emit("apply-recommended-parameters", recommendedParameters.value);
};

const getSelectOptions = (field) =>
  (field.options || []).map((option) =>
    typeof option === "object"
      ? {
          label: option.label || String(option.value),
          value: option.value,
        }
      : {
          label: String(option),
          value: option,
        }
  );

const normalizeFieldValue = (field, value) => {
  if (field.type === "text") return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return field.default ?? "";
  if (field.type === "number") {
    return Number.isInteger(Number(field.step || 1)) ? Math.round(numeric) : numeric;
  }
  return numeric;
};

const getNumberRules = (field) => [
  (value) => {
    if (!field.required && (value === "" || value == null)) return true;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "请输入有效数字";
    if (field.min != null && numeric < Number(field.min)) {
      return `不能小于 ${field.min}`;
    }
    if (field.max != null && numeric > Number(field.max)) {
      return `不能大于 ${field.max}`;
    }
    return true;
  },
];
</script>

<style scoped>
.image-settings-drawer {
  width: min(360px, 92vw);
  overflow: hidden;
}

.drawer-scroll {
  height: 100%;
  width: 100%;
  overflow-x: hidden;
}

.drawer-scroll :deep(.q-scrollarea__container),
.drawer-scroll :deep(.q-scrollarea__content) {
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.settings-content {
  display: grid;
  gap: 14px;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.settings-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 2px;
  min-width: 0;
}

.settings-title > div {
  min-width: 0;
}

.settings-section {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  background: rgba(255, 255, 255, 0.76);
  overflow: hidden;
}

.backend-status-card {
  display: grid;
  gap: 12px;
}

.backend-status-card--preparing {
  border-color: rgba(25, 118, 210, 0.28);
  background: rgba(25, 118, 210, 0.08);
}

.backend-status-card--failed,
.backend-status-card--stopped {
  border-color: rgba(245, 124, 0, 0.24);
  background: rgba(245, 124, 0, 0.08);
}

.backend-status-main {
  display: flex;
  gap: 12px;
  min-width: 0;
}

.backend-status-icon {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 38px;
  border-radius: 10px;
  color: var(--q-primary);
  background: rgba(255, 255, 255, 0.78);
}

.backend-status-card--failed .backend-status-icon,
.backend-status-card--stopped .backend-status-icon {
  color: #f57c00;
}

.backend-status-copy {
  min-width: 0;
}

.backend-status-title {
  font-weight: 600;
  line-height: 1.35;
}

.backend-status-message {
  margin-top: 3px;
  color: rgba(17, 24, 39, 0.62);
  font-size: 13px;
  line-height: 1.45;
}

.backend-status-actions {
  display: flex;
  justify-content: center;
}

.backend-status-button {
  min-width: 0;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-weight: 600;
}

.section-heading--split {
  justify-content: space-between;
  gap: 12px;
}

.section-heading-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.heading-cuda-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 0 auto;
  min-width: 0;
}

.heading-cuda-status :deep(.row) {
  flex-wrap: nowrap;
}

.heading-cuda-status :deep(.col) {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
}

.heading-cuda-status :deep(.q-badge) {
  white-space: nowrap;
}

.field-label {
  margin-bottom: 6px;
  font-size: 12px;
  color: rgba(17, 24, 39, 0.62);
}

.scope-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
}

.scope-button {
  min-height: 38px;
  min-width: 0;
}

.scope-button :deep(.q-btn__content) {
  white-space: normal;
  line-height: 1.25;
  text-align: center;
}

.parameter-grid,
.action-grid {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.parameter-help-button {
  display: flex;
  margin-left: auto;
  margin-top: -44px;
  margin-bottom: 8px;
}

.parameter-help-tooltip {
  max-width: 320px;
  line-height: 1.35;
  white-space: pre-line;
}

.batch-toggle {
  min-height: 38px;
}

.parameter-field {
  min-width: 0;
}

.parameter-field :deep(.q-field),
.parameter-field :deep(.q-field__inner),
.parameter-field :deep(.q-field__control),
.settings-section :deep(.q-field),
.settings-section :deep(.q-field__inner),
.settings-section :deep(.q-field__control) {
  min-width: 0;
  max-width: 100%;
}

.slider-field {
  padding: 8px 4px 0;
}

.settings-action-button {
  width: 100%;
  min-width: 0;
  min-height: 42px;
}

.settings-action-button :deep(.q-btn__content) {
  width: 100%;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  white-space: normal;
  line-height: 1.25;
  text-align: center;
}

.empty-copy {
  min-height: 38px;
  display: flex;
  align-items: center;
  color: rgba(17, 24, 39, 0.58);
  font-size: 13px;
}

:global(body.body--dark) .image-settings-drawer,
.image-settings-drawer--dark {
  background: #242426;
  border-left-color: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .image-settings-drawer :deep(.text-grey-7),
.image-settings-drawer--dark :deep(.text-grey-7) {
  color: rgba(255, 255, 255, 0.62) !important;
}

:global(body.body--dark) .settings-section,
.image-settings-drawer--dark .settings-section {
  background: #363638;
  border-color: rgba(255, 255, 255, 0.12);
}

:global(body.body--dark) .backend-status-card--preparing,
.image-settings-drawer--dark .backend-status-card--preparing {
  border-color: rgba(100, 181, 246, 0.34);
  background: rgba(100, 181, 246, 0.12);
}

:global(body.body--dark) .backend-status-card--failed,
:global(body.body--dark) .backend-status-card--stopped,
.image-settings-drawer--dark .backend-status-card--failed,
.image-settings-drawer--dark .backend-status-card--stopped {
  border-color: rgba(255, 183, 77, 0.34);
  background: rgba(255, 183, 77, 0.12);
}

:global(body.body--dark) .backend-status-icon,
.image-settings-drawer--dark .backend-status-icon {
  background: rgba(255, 255, 255, 0.08);
}

:global(body.body--dark) .field-label,
:global(body.body--dark) .empty-copy,
:global(body.body--dark) .backend-status-message,
.image-settings-drawer--dark .field-label,
.image-settings-drawer--dark .empty-copy,
.image-settings-drawer--dark .backend-status-message {
  color: rgba(255, 255, 255, 0.62);
}

:global(body.body--dark) .section-heading,
:global(body.body--dark) .backend-status-title,
.image-settings-drawer--dark .section-heading,
.image-settings-drawer--dark .backend-status-title {
  color: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .settings-section :deep(.q-field--filled .q-field__control),
:global(body.body--dark) .settings-section :deep(.q-field--outlined .q-field__control),
.image-settings-drawer--dark .settings-section :deep(.q-field--filled .q-field__control),
.image-settings-drawer--dark .settings-section :deep(.q-field--outlined .q-field__control) {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.88);
}

:global(body.body--dark) .settings-section :deep(.q-field--filled .q-field__control::before),
:global(body.body--dark) .settings-section :deep(.q-field--outlined .q-field__control::before),
.image-settings-drawer--dark .settings-section :deep(.q-field--filled .q-field__control::before),
.image-settings-drawer--dark .settings-section :deep(.q-field--outlined .q-field__control::before) {
  border-color: rgba(255, 255, 255, 0.16);
}

:global(body.body--dark) .settings-section :deep(.q-field__native),
:global(body.body--dark) .settings-section :deep(.q-field__label),
:global(body.body--dark) .settings-section :deep(.q-field__append),
:global(body.body--dark) .settings-section :deep(.q-field__marginal),
.image-settings-drawer--dark .settings-section :deep(.q-field__native),
.image-settings-drawer--dark .settings-section :deep(.q-field__label),
.image-settings-drawer--dark .settings-section :deep(.q-field__append),
.image-settings-drawer--dark .settings-section :deep(.q-field__marginal) {
  color: rgba(255, 255, 255, 0.78);
}

:global(body.body--dark) .settings-section :deep(.q-field--focused .q-field__label),
:global(body.body--dark) .settings-section :deep(.q-field--focused .q-field__marginal),
.image-settings-drawer--dark .settings-section :deep(.q-field--focused .q-field__label),
.image-settings-drawer--dark .settings-section :deep(.q-field--focused .q-field__marginal) {
  color: var(--q-primary);
}

:global(body.body--dark) .scope-button :deep(.q-btn__content),
:global(body.body--dark) .settings-action-button :deep(.q-btn__content),
.image-settings-drawer--dark .scope-button :deep(.q-btn__content),
.image-settings-drawer--dark .settings-action-button :deep(.q-btn__content) {
  color: inherit;
}

:global(body.body--dark) .scope-button :deep(.q-btn__content),
.image-settings-drawer--dark .scope-button :deep(.q-btn__content) {
  color: rgba(255, 255, 255, 0.78);
}

:global(body.body--dark) .scope-button.text-primary :deep(.q-btn__content),
.image-settings-drawer--dark .scope-button.text-primary :deep(.q-btn__content) {
  color: var(--q-primary);
}

:global(body.body--dark) .settings-section :deep(.q-btn--outline:before),
.image-settings-drawer--dark .settings-section :deep(.q-btn--outline:before) {
  border-color: rgba(255, 255, 255, 0.2);
}

:global(body.body--dark) .settings-section :deep(.q-btn.disabled),
:global(body.body--dark) .settings-section :deep(.q-btn[disabled]),
.image-settings-drawer--dark .settings-section :deep(.q-btn.disabled),
.image-settings-drawer--dark .settings-section :deep(.q-btn[disabled]) {
  color: rgba(255, 255, 255, 0.38) !important;
}

:global(body.body--dark) .settings-section :deep(.q-toggle__label),
.image-settings-drawer--dark .settings-section :deep(.q-toggle__label) {
  color: rgba(255, 255, 255, 0.86);
}
</style>
