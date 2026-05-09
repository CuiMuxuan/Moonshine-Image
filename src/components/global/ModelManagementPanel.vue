<template>
  <div class="model-management-panel">
    <div v-if="!backendRunning" class="model-empty-state">
      <q-icon name="power_settings_new" size="42px" color="warning" />
      <div>
        <div class="text-subtitle1 text-weight-medium">需要启动后端服务</div>
        <div class="text-body2 text-grey-7 q-mt-xs">
          模型状态、校验和下载由 Moonshine 后端统一管理。
        </div>
      </div>
      <q-btn
        outline
        no-caps
        color="primary"
        icon="terminal"
        label="打开后端管理"
        class="settings-action-button model-empty-action"
        @click="$emit('open-backend-manager')"
      />
    </div>

    <template v-else>
      <div class="model-management-toolbar">
        <div class="model-management-title">
          <div class="text-subtitle1 text-weight-medium">模型管理</div>
          <div class="text-caption text-grey-7">
            模型目录：{{ modelRegistry.modelDir || "后端默认目录" }}
          </div>
        </div>
        <q-space />
        <q-btn
          outline
          no-caps
          color="primary"
          icon="refresh"
          label="刷新状态"
          class="settings-action-button"
          :loading="modelRegistry.loading"
          @click="refreshModels"
        />
      </div>

      <q-banner
        v-if="modelRegistry.error"
        rounded
        class="settings-warning-banner q-mb-md"
      >
        {{ modelRegistry.error }}
      </q-banner>

      <q-splitter
        v-model="splitterModel"
        class="model-management-splitter"
        :limits="[22, 42]"
      >
        <template #before>
          <q-tabs
            v-model="selectedModelId"
            vertical
            dense
            active-color="primary"
            indicator-color="primary"
            class="model-tabs"
          >
            <q-tab
              v-for="model in modelRegistry.models"
              :key="model.id"
              :name="model.id"
              :label="model.label || model.id"
              no-caps
            />
          </q-tabs>
        </template>

        <template #after>
          <q-tab-panels
            v-model="selectedModelId"
            animated
            class="model-panels bg-transparent"
          >
            <q-tab-panel
              v-for="model in modelRegistry.models"
              :key="model.id"
              :name="model.id"
              class="q-pa-none"
            >
              <div class="model-detail">
                <div class="model-detail-header">
                  <div>
                    <div class="text-h6">{{ model.label || model.id }}</div>
                    <div class="text-body2 text-grey-7 q-mt-xs">
                      {{ model.description || "暂无模型说明。" }}
                    </div>
                  </div>
                  <q-badge :color="getStatusColor(model)" class="model-status-badge">
                    {{ getStatusLabel(model) }}
                  </q-badge>
                </div>

                <div class="model-action-row">
                  <q-btn
                    outline
                    no-caps
                    color="primary"
                    icon="verified"
                    label="校验"
                    class="settings-action-button"
                    :loading="verifyingModelId === model.id"
                    @click="verifyModel(model.id)"
                  />
                  <q-btn
                    v-if="canDownload(model)"
                    outline
                    no-caps
                    color="primary"
                    :icon="model.installed ? 'restart_alt' : 'download'"
                    :label="model.installed ? '重新下载' : '下载'"
                    class="settings-action-button"
                    :loading="isTaskRunning(model.id)"
                    @click="downloadModel(model)"
                  />
                  <q-btn
                    v-if="hasManualInstallGuide(model)"
                    outline
                    no-caps
                    color="secondary"
                    icon="folder_open"
                    label="手动安装"
                    class="settings-action-button"
                    @click="openManualInstallGuide(model)"
                  />
                  <q-chip
                    v-if="model.downloadable && !canDownload(model) && !hasManualInstallGuide(model)"
                    outline
                    color="grey"
                    text-color="grey-8"
                  >
                    暂无下载源
                  </q-chip>
                </div>

                <q-linear-progress
                  v-if="getTask(model.id)"
                  :value="getTaskProgress(model.id)"
                  rounded
                  color="primary"
                  class="q-mb-md"
                />

                <q-banner
                  v-if="getTaskMessage(model.id)"
                  rounded
                  :class="getTask(model.id)?.status === 'failed' ? 'settings-warning-banner' : 'settings-info-banner'"
                  class="q-mb-md"
                >
                  <div class="task-banner-content">
                    <span>{{ getTaskMessage(model.id) }}</span>
                    <q-btn
                      v-if="getTask(model.id)?.status === 'failed' && hasManualInstallGuide(model)"
                      flat
                      dense
                      no-caps
                      color="primary"
                      icon="folder_open"
                      label="查看手动安装"
                      @click="openManualInstallGuide(model)"
                    />
                  </div>
                </q-banner>

                <div class="model-info-grid">
                  <div class="mini-block">
                    <div class="text-subtitle2 text-weight-medium q-mb-sm">运行信息</div>
                    <div class="model-info-line">
                      <span>需要蒙版</span>
                      <strong>{{ model.requiresMask ? "是" : "否" }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>推荐设备</span>
                      <strong>{{ model.recommendedDevice || "不限" }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>最低显存</span>
                      <strong>{{ formatVram(model.minimumVram) }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>设备适配</span>
                      <strong>{{ model.deviceCompatible ? "适配" : "不适配" }}</strong>
                    </div>
                  </div>

                  <div class="mini-block">
                    <div class="text-subtitle2 text-weight-medium q-mb-sm">下载源</div>
                    <div class="text-caption text-grey-7 q-mb-xs">自动下载</div>
                    <div v-if="model.sourceLinks?.length" class="source-list">
                      <div
                        v-for="source in model.sourceLinks"
                        :key="source.url || source"
                        class="source-item"
                      >
                        <div class="source-copy">
                          <div class="source-label">{{ getSourceLabel(source) }}</div>
                          <div class="source-url">{{ getSourceUrl(source) }}</div>
                        </div>
                        <q-btn
                          v-if="getSourceUrl(source)"
                          flat
                          dense
                          round
                          icon="open_in_new"
                          color="primary"
                          @click="openExternalUrl(getSourceUrl(source))"
                        >
                          <q-tooltip>打开链接</q-tooltip>
                        </q-btn>
                      </div>
                    </div>
                    <div v-else class="text-body2 text-grey-7">暂无自动下载源</div>

                    <template v-if="hasManualInstallGuide(model)">
                      <q-separator class="q-my-md" />
                      <div class="manual-source-heading">
                        <div>
                          <div class="text-caption text-grey-7">副源</div>
                          <div class="text-body2">副源仅用于手动下载安装。</div>
                        </div>
                        <q-btn
                          flat
                          dense
                          no-caps
                          color="primary"
                          icon="info"
                          label="安装说明"
                          @click="openManualInstallGuide(model)"
                        />
                      </div>
                      <div v-if="model.manualSources?.length" class="source-list q-mt-sm">
                        <div
                          v-for="source in model.manualSources"
                          :key="source.url || source"
                          class="source-item"
                        >
                          <div class="source-copy">
                            <div class="source-label">{{ getSourceLabel(source) }}</div>
                            <div class="source-url">{{ getSourceUrl(source) }}</div>
                          </div>
                          <q-btn
                            v-if="getSourceUrl(source)"
                            flat
                            dense
                            round
                            icon="open_in_new"
                            color="primary"
                            @click="openExternalUrl(getSourceUrl(source))"
                          >
                            <q-tooltip>打开副源</q-tooltip>
                          </q-btn>
                        </div>
                      </div>
                    </template>
                  </div>
                </div>

                <div class="mini-block q-mt-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-md">模型能力</div>
                  <model-capability-radar
                    :model-label="model.label || model.id"
                    :capabilities="model.capabilities"
                  />
                </div>

                <div class="mini-block q-mt-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-sm">文件状态</div>
                  <q-list dense bordered separator class="model-file-list">
                    <q-item v-for="file in model.files" :key="file.path">
                      <q-item-section>
                        <q-item-label>{{ file.label || file.path }}</q-item-label>
                        <q-item-label caption>{{ file.path }}</q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-badge :color="getFileColor(file)">
                          {{ getFileLabel(file) }}
                        </q-badge>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>
            </q-tab-panel>
          </q-tab-panels>
        </template>
      </q-splitter>
    </template>

    <q-dialog v-model="manualInstallDialog">
      <q-card class="manual-install-dialog">
        <q-card-section class="manual-install-header">
          <div>
            <div class="text-subtitle1 text-weight-medium">手动安装模型</div>
            <div class="text-caption text-grey-7">
              {{ manualInstallModel?.label || manualInstallModel?.id || "模型文件" }}
            </div>
          </div>
          <q-space />
          <q-btn v-close-popup flat dense round icon="close">
            <q-tooltip>关闭</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-separator />

        <q-card-section class="q-gutter-md">
          <q-banner rounded class="settings-info-banner">
            {{ manualInstallModel?.manualHint || defaultManualInstallHint }}
          </q-banner>

          <div class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">模型目录</div>
            <div class="manual-path-row">
              <code>{{ modelRegistry.modelDir || "后端默认目录" }}</code>
              <q-btn
                flat
                dense
                round
                icon="content_copy"
                color="primary"
                :disable="!modelRegistry.modelDir"
                @click="copyText(modelRegistry.modelDir)"
              >
                <q-tooltip>复制模型目录</q-tooltip>
              </q-btn>
            </div>
          </div>

          <div class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">需要放置的文件</div>
            <q-list dense bordered separator class="model-file-list">
              <q-item v-for="file in manualInstallModel?.files || []" :key="file.path">
                <q-item-section>
                  <q-item-label>{{ file.label || file.path }}</q-item-label>
                  <q-item-label caption>{{ getExpectedFilePath(file) }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-btn
                    flat
                    dense
                    round
                    icon="content_copy"
                    color="primary"
                    @click="copyText(getExpectedFilePath(file))"
                  >
                    <q-tooltip>复制目标路径</q-tooltip>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>
          </div>

          <div v-if="manualInstallModel?.manualSources?.length" class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">手动下载副源</div>
            <div class="source-list">
              <div
                v-for="source in manualInstallModel.manualSources"
                :key="source.url || source"
                class="source-item"
              >
                <div class="source-copy">
                  <div class="source-label">{{ getSourceLabel(source) }}</div>
                  <div class="source-url">{{ getSourceUrl(source) }}</div>
                </div>
                <q-btn
                  flat
                  dense
                  round
                  icon="open_in_new"
                  color="primary"
                  :disable="!getSourceUrl(source)"
                  @click="openExternalUrl(getSourceUrl(source))"
                >
                  <q-tooltip>打开副源</q-tooltip>
                </q-btn>
              </div>
            </div>
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps label="关闭" />
          <q-btn
            v-if="getPrimaryManualSourceUrl(manualInstallModel)"
            unelevated
            no-caps
            color="primary"
            icon="open_in_new"
            label="打开副源"
            @click="openExternalUrl(getPrimaryManualSourceUrl(manualInstallModel))"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from "vue";
import { useQuasar } from "quasar";

import ModelCapabilityRadar from "src/components/common/ModelCapabilityRadar.vue";
import { useModelRegistryStore } from "src/stores/modelRegistry";

const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
  selectedModelId: {
    type: String,
    default: "",
  },
});

const emit = defineEmits([
  "open-backend-manager",
  "model-downloaded",
  "update:selected-model-id",
]);

const $q = useQuasar();
const modelRegistry = useModelRegistryStore();
const splitterModel = ref(28);
const selectedModelId = ref(props.selectedModelId || "lama");
const verifyingModelId = ref("");
const manualInstallDialog = ref(false);
const manualInstallModel = ref(null);
const defaultManualInstallHint =
  "请手动下载对应模型文件并放入当前模型目录。也可以私信作者或者加入交流群获取模型文件或百度网盘链接。";

const refreshModels = async () => {
  try {
    await modelRegistry.refreshModels();
    ensureSelectedModel();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型状态刷新失败",
      position: "top",
    });
  }
};

const ensureSelectedModel = () => {
  if (modelRegistry.models.some((model) => model.id === selectedModelId.value)) {
    return;
  }
  selectedModelId.value =
    props.selectedModelId ||
    modelRegistry.models[0]?.id ||
    "lama";
};

const verifyModel = async (modelId) => {
  verifyingModelId.value = modelId;
  try {
    await modelRegistry.verifyModel(modelId);
    $q.notify({
      type: "positive",
      message: "模型校验完成",
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型校验失败",
      position: "top",
    });
  } finally {
    verifyingModelId.value = "";
  }
};

const canDownload = (model) =>
  Boolean(model?.downloadable && model?.sourceLinks?.length);

const hasManualInstallGuide = (model) =>
  Boolean(model?.manualSources?.length || model?.manualHint || model?.files?.length);

const openManualInstallGuide = (model) => {
  manualInstallModel.value = model;
  manualInstallDialog.value = true;
};

const getSourceUrl = (source) => {
  if (!source) return "";
  return typeof source === "string" ? source : source.url || "";
};

const getSourceLabel = (source) => {
  if (!source) return "下载源";
  if (typeof source === "string") return source;
  return source.label || source.type || source.url || "下载源";
};

const openExternalUrl = (url) => {
  if (!url) return;
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
    return;
  }
  if (window.electron?.ipcRenderer?.send) {
    window.electron.ipcRenderer.send("open-external-link", url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

const copyText = async (text) => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $q.notify({
      type: "positive",
      message: "已复制",
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "复制失败",
      position: "top",
    });
  }
};

const getExpectedFilePath = (file) => {
  const path = file?.path || "";
  if (!modelRegistry.modelDir) return path;
  const separator = modelRegistry.modelDir.includes("\\") ? "\\" : "/";
  const normalizedDir = modelRegistry.modelDir.replace(/[\\/]+$/, "");
  return `${normalizedDir}${separator}${path.replace(/[\\/]+/g, separator)}`;
};

const getPrimaryManualSourceUrl = (model) =>
  getSourceUrl(model?.manualSources?.[0]);

const downloadModel = async (model) => {
  try {
    const task = await modelRegistry.startDownload(model.id);
    $q.notify({
      type: "info",
      message: "模型下载任务已开始",
      position: "top",
    });
    watchDownloadCompletion(task.id, model);
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型下载失败",
      position: "top",
    });
  }
};

const watchDownloadCompletion = (taskId, model) => {
  const stop = watch(
    () => modelRegistry.tasks[taskId],
    (task) => {
      if (!task?.done) return;
      stop();
      if (task.status === "completed") {
        emit("model-downloaded", model.id);
      } else if (task.status === "failed" && hasManualInstallGuide(model)) {
        openManualInstallGuide(model);
      }
    },
    { deep: true }
  );
};

const getTask = (modelId) => modelRegistry.getTaskForModel(modelId);
const isTaskRunning = (modelId) => {
  const task = getTask(modelId);
  return task?.status === "queued" || task?.status === "running";
};
const getTaskProgress = (modelId) => {
  const task = getTask(modelId);
  const progress = Number(task?.progress || 0);
  return Math.max(0, Math.min(1, progress));
};
const getTaskMessage = (modelId) => {
  const task = getTask(modelId);
  if (!task) return "";
  if (task.status === "failed") return task.error || task.message || "下载失败";
  if (task.status === "completed") return task.message || "下载完成";
  if (task.status === "running") return "正在下载模型...";
  return task.message || "";
};

const getStatusLabel = (model) => {
  if (!model.deviceCompatible) return "设备不适配";
  if (model.corruptFiles?.length) return "需修复";
  if (model.missingFiles?.length) return "未安装";
  if (model.installed) return "已安装";
  return "未安装";
};

const getStatusColor = (model) => {
  if (!model.deviceCompatible) return "warning";
  if (model.corruptFiles?.length) return "negative";
  if (model.installed) return "positive";
  return "grey";
};

const getFileLabel = (file) => {
  if (!file.exists) return "缺失";
  if (!file.valid) return "损坏";
  return "正常";
};

const getFileColor = (file) => {
  if (!file.exists) return "grey";
  if (!file.valid) return "negative";
  return "positive";
};

const formatVram = (value) => {
  if (!value) return "不限";
  return `${Number(value).toFixed(0)} MB`;
};

watch(
  () => props.selectedModelId,
  (value) => {
    if (value && value !== selectedModelId.value) {
      selectedModelId.value = value;
    }
  }
);

watch(selectedModelId, (value) => {
  emit("update:selected-model-id", value);
});

watch(
  () => modelRegistry.models,
  () => {
    ensureSelectedModel();
  },
  { deep: true }
);

watch(
  () => props.backendRunning,
  async (running) => {
    if (running) {
      await modelRegistry.loadModels();
      ensureSelectedModel();
    }
  }
);

onMounted(async () => {
  if (props.backendRunning) {
    await modelRegistry.loadModels();
    ensureSelectedModel();
  }
});
</script>

<style scoped>
.model-management-panel {
  min-height: 0;
}

.model-empty-state {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 180px;
  padding: 20px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
}

.model-empty-state > div {
  min-width: 0;
}

.model-empty-action {
  margin-left: auto;
  flex: 0 0 auto;
}

.model-management-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.model-management-title {
  min-width: 0;
}

.model-management-splitter {
  min-height: 560px;
}

.model-tabs {
  align-items: stretch;
  padding-right: 10px;
}

.model-tabs :deep(.q-tab) {
  justify-content: flex-start;
  min-height: 42px;
  border-radius: 8px;
}

.model-panels {
  height: 100%;
}

.model-detail {
  padding-left: 16px;
  min-width: 0;
}

.model-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.model-status-badge {
  flex: 0 0 auto;
}

.model-action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.model-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.mini-block {
  padding: 14px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
}

.model-info-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
}

.task-banner-content,
.manual-source-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.source-list {
  display: grid;
  gap: 8px;
}

.source-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.source-copy {
  min-width: 0;
}

.source-label,
.source-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-url {
  color: rgba(75, 85, 99, 0.86);
  font-size: 12px;
}

.model-file-list {
  border-radius: 10px;
  overflow: hidden;
}

.manual-install-dialog {
  width: min(620px, calc(100vw - 32px));
}

.manual-install-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.manual-install-section {
  min-width: 0;
}

.manual-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.manual-path-row code {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-action-button {
  min-height: 40px;
}

.settings-action-button :deep(.q-btn__content) {
  justify-content: center;
  flex-wrap: nowrap;
  gap: 6px;
  white-space: nowrap;
}

.settings-info-banner {
  background: #e8efff;
  color: #233a7a;
  border: 1px solid rgba(122, 141, 190, 0.22);
}

.settings-warning-banner {
  background: #fff4d7;
  color: #735000;
  border: 1px solid rgba(230, 172, 0, 0.28);
}

:global(body.body--dark) .model-empty-state,
:global(body.body--dark) .mini-block {
  background: #2f2f32;
  border-color: rgba(255, 255, 255, 0.12);
}

:global(body.body--dark) .source-item {
  background: rgba(255, 255, 255, 0.06);
}

:global(body.body--dark) .manual-path-row {
  background: rgba(255, 255, 255, 0.06);
}

:global(body.body--dark) .source-url {
  color: rgba(229, 231, 235, 0.72);
}

:global(body.body--dark) .settings-info-banner {
  background: rgba(122, 141, 190, 0.2);
  color: #dce4ff;
  border-color: rgba(122, 141, 190, 0.34);
}

:global(body.body--dark) .settings-warning-banner {
  background: rgba(230, 172, 0, 0.18);
  color: #ffe1a0;
  border-color: rgba(230, 172, 0, 0.34);
}

@media (max-width: 760px) {
  .model-empty-state {
    flex-wrap: wrap;
  }

  .model-empty-action {
    width: 100%;
    margin-left: 58px;
  }

  .task-banner-content,
  .manual-source-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .model-management-splitter {
    min-height: 640px;
  }

  .model-detail {
    padding-left: 10px;
  }
}
</style>
