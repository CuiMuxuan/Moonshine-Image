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
                  <q-chip
                    v-else-if="model.downloadable"
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
                  {{ getTaskMessage(model.id) }}
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
                    <div v-if="model.sourceLinks?.length" class="source-list">
                      <div
                        v-for="source in model.sourceLinks"
                        :key="source.url || source"
                        class="source-item"
                      >
                        {{ source.label || source.url || source }}
                      </div>
                    </div>
                    <div v-else class="text-body2 text-grey-7">暂无下载源</div>
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

const downloadModel = async (model) => {
  try {
    const task = await modelRegistry.startDownload(model.id);
    $q.notify({
      type: "info",
      message: "模型下载任务已开始",
      position: "top",
    });
    watchDownloadCompletion(task.id, model.id);
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型下载失败",
      position: "top",
    });
  }
};

const watchDownloadCompletion = (taskId, modelId) => {
  const stop = watch(
    () => modelRegistry.tasks[taskId],
    (task) => {
      if (!task?.done) return;
      stop();
      if (task.status === "completed") {
        emit("model-downloaded", modelId);
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

.source-list {
  display: grid;
  gap: 8px;
}

.source-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.model-file-list {
  border-radius: 10px;
  overflow: hidden;
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

  .model-management-splitter {
    min-height: 640px;
  }

  .model-detail {
    padding-left: 10px;
  }
}
</style>
