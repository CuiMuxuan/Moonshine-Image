<template>
  <q-dialog v-model="showDialog" persistent class="settings-dialog">
    <q-card class="settings-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">全局设置</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <q-tabs
          v-model="activeTab"
          dense
          class="text-grey"
          active-color="primary"
          indicator-color="primary"
          align="justify"
        >
          <q-tab name="general" label="后端设置" />
          <q-tab name="files" label="文件管理" />
          <q-tab name="appearance" label="外观主题" />
          <q-tab name="advanced" label="高级设置" />
        </q-tabs>

        <q-separator />

        <q-tab-panels v-model="activeTab" animated>
          <q-tab-panel name="general">
            <div class="q-gutter-md">
              <q-input
                v-model.number="localConfig.general.backendPort"
                label="后端端口"
                type="number"
                :min="1024"
                :max="65535"
                :error="portError"
                :error-message="portErrorMessage"
                @update:model-value="validatePort"
              />

              <q-select
                v-model="localConfig.general.launchMode"
                label="启动方式"
                :options="[
                  { label: 'CUDA 加速', value: 'cuda' },
                  { label: 'CPU 模式', value: 'cpu' },
                ]"
                emit-value
                map-options
              />

              <q-input
                v-model="localConfig.general.backendProjectPath"
                label="后端项目路径"
                readonly
              >
                <template #append>
                  <q-btn round dense flat icon="folder" @click="selectBackendProjectPath" />
                </template>
              </q-input>

              <q-input v-model="localConfig.general.modelPath" label="模型文件路径" readonly>
                <template #append>
                  <q-btn round dense flat icon="folder" @click="selectModelPath" />
                </template>
              </q-input>

              <q-select
                v-model="localConfig.general.defaultModel"
                label="默认模型"
                :options="['lama']"
              />
            </div>
          </q-tab-panel>

          <q-tab-panel name="files">
            <div class="q-gutter-md">
              <q-input
                v-model="localConfig.fileManagement.downloadPath"
                label="下载/导出路径"
                readonly
              >
                <template #append>
                  <q-btn round dense flat icon="folder" @click="selectDownloadPath" />
                </template>
              </q-input>

              <q-input
                v-model="localConfig.fileManagement.tempPath"
                label="临时文件路径"
                readonly
              >
                <template #append>
                  <q-btn round dense flat icon="folder" @click="selectTempPath" />
                </template>
              </q-input>

              <q-input
                v-model="localConfig.fileManagement.imageFolderName"
                label="图片文件夹名称"
              />
              <q-input
                v-model="localConfig.fileManagement.videoFolderName"
                label="视频文件夹名称"
              />
            </div>
          </q-tab-panel>

          <q-tab-panel name="appearance">
            <div class="q-gutter-lg">
              <div class="theme-mode-card">
                <div>
                  <div class="text-subtitle2">主题模式</div>
                  <div class="text-caption text-grey-7">
                    明亮 / 黑暗模式请使用右上角按钮栏最左侧的切换按钮。
                  </div>
                </div>
                <q-chip
                  dense
                  square
                  :color="localConfig.ui.theme === 'dark' ? 'accent' : 'primary'"
                  text-color="white"
                >
                  {{ localConfig.ui.theme === "dark" ? "黑暗模式" : "明亮模式" }}
                </q-chip>
              </div>

              <div>
                <div class="row items-center q-mb-sm">
                  <div class="text-subtitle2">主题品牌色</div>
                  <q-space />
                  <q-btn
                    outline
                    color="primary"
                    icon="restart_alt"
                    label="恢复默认主题色"
                    @click="resetThemeColors"
                  />
                </div>

                <div class="theme-color-grid">
                  <div
                    v-for="item in themeColorFields"
                    :key="item.key"
                    class="theme-color-item"
                  >
                    <div class="text-caption text-grey-7 q-mb-xs">{{ item.label }}</div>
                    <div class="theme-color-control">
                      <input
                        v-model="localConfig.ui.brandColors[item.key]"
                        type="color"
                        class="native-color-input"
                      />
                      <q-input
                        v-model="localConfig.ui.brandColors[item.key]"
                        dense
                        outlined
                        :label="item.key"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <q-separator />

              <div>
                <div class="row items-center q-mb-md">
                  <div class="text-subtitle2">默认笔刷样式</div>
                  <q-space />
                  <q-btn
                    outline
                    color="primary"
                    icon="restart_alt"
                    label="恢复默认笔刷"
                    @click="resetBrushDefaults"
                  />
                </div>

                <div class="brush-config-grid">
                  <div
                    v-for="item in brushConfigFields"
                    :key="item.key"
                    class="brush-config-card"
                  >
                    <div class="row items-center q-mb-md">
                      <div class="text-subtitle2">{{ item.label }}</div>
                      <q-space />
                      <div class="brush-preview">
                        <span
                          class="brush-preview-dot"
                          :style="{
                            width: `${Math.max(12, getBrushConfig(item.key).size)}px`,
                            height: `${Math.max(12, getBrushConfig(item.key).size)}px`,
                            backgroundColor: getBrushPreviewColor(item.key),
                          }"
                        ></span>
                      </div>
                    </div>

                    <div class="q-gutter-md">
                      <div class="theme-color-control">
                        <input
                          v-model="localConfig.advanced[item.key].color"
                          type="color"
                          class="native-color-input"
                        />
                        <q-input
                          v-model="localConfig.advanced[item.key].color"
                          dense
                          outlined
                          label="颜色"
                        />
                      </div>

                      <q-slider
                        v-model="localConfig.advanced[item.key].size"
                        label
                        label-always
                        :min="1"
                        :max="120"
                        :step="1"
                      >
                        <template #prepend>大小</template>
                      </q-slider>

                      <q-slider
                        v-model="localConfig.advanced[item.key].alpha"
                        label
                        label-always
                        :min="0.05"
                        :max="1"
                        :step="0.05"
                      >
                        <template #prepend>透明度</template>
                      </q-slider>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </q-tab-panel>

          <q-tab-panel name="advanced">
            <div class="q-gutter-lg">
              <div>
                <div class="text-subtitle2 q-mb-md">图片处理设置</div>
                <div class="q-gutter-md">
                  <q-input
                    v-model.number="localConfig.advanced.imageHistoryLimit"
                    label="图片历史记录上限"
                    type="number"
                    :min="1"
                    :max="100"
                  />

                  <q-input
                    v-model.number="localConfig.advanced.imageWarningSize"
                    label="图片警告大小 (MB)"
                    type="number"
                    :min="1"
                    :max="1000"
                  />

                  <q-input
                    v-model.number="localConfig.advanced.stateSaveLimit"
                    label="状态保存上限大小 (MB)"
                    type="number"
                    :min="1"
                    :max="500"
                  />

                  <div class="row items-center q-gutter-md">
                    <div class="col-4">
                      <q-item-label class="text-subtitle2">图片处理方式</q-item-label>
                      <q-item-label caption>选择图片处理时的数据传输方式</q-item-label>
                    </div>
                    <div class="col">
                      <q-select
                        v-model="localConfig.advanced.imageProcessingMethod"
                        :options="imageProcessingOptions"
                        emit-value
                        map-options
                        outlined
                        dense
                        :disable="!canChangeImageProcessingMethod"
                      >
                        <template #hint>
                          <div class="text-caption">{{ getImageProcessingHint() }}</div>
                        </template>
                      </q-select>
                      <div
                        v-if="!canChangeImageProcessingMethod"
                        class="text-caption text-orange q-mt-xs"
                      >
                        <q-icon name="warning" size="xs" class="q-mr-xs" />
                        当前有文件正在处理中，无法修改图片处理方式
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <q-separator />

              <div>
                <div class="text-subtitle2 q-mb-md">视频处理设置</div>
                <div class="q-gutter-md">
                  <div class="row q-col-gutter-md">
                    <div class="col-6">
                      <q-input
                        v-model.number="localConfig.video.batchFrameCount"
                        label="固定批次帧数"
                        type="number"
                        :min="120"
                        :max="5000"
                      />
                    </div>
                    <div class="col-6">
                      <q-select
                        v-model="localConfig.video.frameExtractionFormat"
                        label="拆帧存储格式"
                        emit-value
                        map-options
                        :options="[
                          { label: 'JPG', value: 'jpg' },
                          { label: 'PNG', value: 'png' },
                          { label: 'WebP', value: 'webp' },
                        ]"
                      />
                    </div>
                  </div>

                  <q-input
                    v-model.number="localConfig.video.historyLimit"
                    label="视频历史记录上限"
                    type="number"
                    :min="1"
                    :max="50"
                  />

                  <div class="row q-col-gutter-md">
                    <div class="col-6">
                      <q-input
                        v-model.number="localConfig.video.batchRetryCount"
                        label="批次失败重试次数"
                        type="number"
                        :min="1"
                        :max="10"
                      />
                    </div>
                    <div class="col-6">
                      <q-input
                        v-model.number="localConfig.video.failureRetentionCount"
                        label="失败现场保留数量"
                        type="number"
                        :min="1"
                        :max="50"
                      />
                    </div>
                  </div>

                  <q-input
                    v-model.number="localConfig.video.proxyMaxSide"
                    label="代理预览最大边长 (px)"
                    type="number"
                    :min="256"
                    :max="4096"
                  />
                </div>
              </div>
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="取消" v-close-popup />
        <q-btn color="primary" label="保存" :loading="saving" :disable="hasErrors" @click="saveSettings">
          <q-tooltip v-if="hasErrors" class="bg-negative">
            {{ disableReason }}
          </q-tooltip>
        </q-btn>
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="showConfirmDialog" persistent class="confirm-dialog">
    <q-card>
      <q-card-section class="row items-center">
        <q-avatar icon="warning" color="orange" text-color="white" />
        <span class="q-ml-sm">{{ confirmMessage }}</span>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="取消" v-close-popup />
        <q-btn color="primary" label="确认" @click="confirmAction" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useQuasar } from "quasar";

import {
  ConfigManager,
  DEFAULT_BRAND_COLORS,
  DEFAULT_IMAGE_BRUSH,
  DEFAULT_VIDEO_BRUSH,
} from "src/config/ConfigManager";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";
import { useFileManagerStore } from "src/stores/fileManager";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();

const imageProcessingOptions = [
  {
    label: "Base64 编码（默认）",
    value: "base64",
    description: "兼容性更好，但内存占用更高。",
  },
  {
    label: "文件路径（节省内存）",
    value: "path",
    description: "更省内存，适合大文件批处理。",
  },
];

const themeColorFields = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
];

const brushConfigFields = [
  { key: "imageBrushDefault", label: "图片默认笔刷" },
  { key: "videoBrushDefault", label: "视频默认笔刷" },
];

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["update:modelValue"]);

const showDialog = computed({
  get: () => props.modelValue,
  set: (val) => emit("update:modelValue", val),
});

const canChangeImageProcessingMethod = computed(() => fileManagerStore.files.length === 0);
const activeTab = ref("general");
const saving = ref(false);
const showConfirmDialog = ref(false);
const confirmMessage = ref("");
const pendingAction = ref(null);

const buildSerializableConfig = (sourceConfig) =>
  JSON.parse(JSON.stringify(ConfigManager.mergeWithDefault(sourceConfig || {})));

const localConfig = ref(buildSerializableConfig(configStore.config));

const portError = ref(false);
const portErrorMessage = ref("");

const getImageProcessingHint = () => {
  const method = localConfig.value.advanced?.imageProcessingMethod || "base64";
  const option = imageProcessingOptions.find((item) => item.value === method);
  return option?.description || "";
};

const getBrushConfig = (key) => localConfig.value.advanced?.[key] || DEFAULT_IMAGE_BRUSH;

const getBrushPreviewColor = (key) => {
  const brush = getBrushConfig(key);
  const alpha = Math.max(0.05, Math.min(1, Number(brush.alpha || 1)));
  const suffix = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${brush.color}${suffix}`;
};

watch(
  () => configStore.config,
  (newConfig) => {
    localConfig.value = buildSerializableConfig(newConfig);
  },
  { deep: true }
);

const validatePort = (port) => {
  if (!port || port < 1024 || port > 65535) {
    portError.value = true;
    portErrorMessage.value = "后端端口必须在 1024-65535 范围内";
  } else {
    portError.value = false;
    portErrorMessage.value = "";
  }
};

const hasErrors = computed(() => {
  const mergedConfig = ConfigManager.mergeWithDefault(localConfig.value);
  const errors = configStore.validateConfig(mergedConfig);
  return errors.length > 0 || portError.value;
});

const disableReason = computed(() => {
  const mergedConfig = ConfigManager.mergeWithDefault(localConfig.value);
  const errors = configStore.validateConfig(mergedConfig);
  const reasons = [];

  if (portError.value) reasons.push(portErrorMessage.value);
  if (errors.length > 0) reasons.push(...errors);
  return reasons.join("；");
});

const resetThemeColors = () => {
  localConfig.value.ui.brandColors = { ...DEFAULT_BRAND_COLORS };
};

const resetBrushDefaults = () => {
  localConfig.value.advanced.imageBrushDefault = { ...DEFAULT_IMAGE_BRUSH };
  localConfig.value.advanced.videoBrushDefault = { ...DEFAULT_VIDEO_BRUSH };
};

const selectFolderWithNotify = async (assign) => {
  if (!window.electron) return;
  try {
    const result = await window.electron.ipcRenderer.invoke("select-directory");
    if (!result.canceled && result.filePaths.length > 0) {
      assign(result.filePaths[0]);
    }
  } catch (error) {
    $q.notify({ type: "negative", message: `选择目录失败: ${error.message}` });
  }
};

const selectModelPath = async () => {
  if (!window.electron) return;
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择模型文件路径",
    });
    if (!result.canceled && result.filePaths.length > 0) {
      localConfig.value.general.modelPath = result.filePaths[0];
    }
  } catch (error) {
    $q.notify({ type: "negative", message: `选择文件夹失败: ${error.message}` });
  }
};

const selectDownloadPath = async () => {
  await selectFolderWithNotify((path) => {
    localConfig.value.fileManagement.downloadPath = path;
  });
};

const selectTempPath = async () => {
  await selectFolderWithNotify((path) => {
    localConfig.value.fileManagement.tempPath = path;
  });
};

const selectBackendProjectPath = async () => {
  if (!window.electron) return;
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择后端项目路径",
    });
    if (result.canceled || result.filePaths.length === 0) return;

    const selectedPath = result.filePaths[0];
    const checkResult = await window.electron.ipcRenderer.invoke("check-project", selectedPath);

    if (checkResult.success) {
      localConfig.value.general.backendProjectPath = selectedPath;
      $q.notify({ type: "positive", message: "后端项目路径设置成功" });
      return;
    }

    $q.notify({
      type: "negative",
      message: `无效的后端项目路径: ${checkResult.error}`,
    });
  } catch (error) {
    $q.notify({ type: "negative", message: `选择文件夹失败: ${error.message}` });
  }
};

const saveSettings = async () => {
  const needsStateSave =
    JSON.stringify(localConfig.value) !== JSON.stringify(buildSerializableConfig(configStore.config));

  if (needsStateSave) {
    const stateResult = await appStateStore.saveState();
    if (!stateResult.success && stateResult.oversized) {
      confirmMessage.value = `状态数据过大无法保存（${stateResult.error}）。继续保存将重置页面，未保存内容可能丢失。是否继续？`;
      showConfirmDialog.value = true;
      pendingAction.value = () => doSaveSettings();
      return;
    }
  }

  await doSaveSettings();
};

const doSaveSettings = async () => {
  saving.value = true;
  try {
    const serializableConfig = buildSerializableConfig(localConfig.value);
    const previousPort = configStore.config.general.backendPort;
    const storeResult = await configStore.persistConfig(serializableConfig);
    if (!storeResult.success) {
      throw new Error(storeResult.error || storeResult.errors?.join("；") || "保存失败");
    }

    if (serializableConfig.advanced?.imageProcessingMethod) {
      const processingMethod = serializableConfig.advanced.imageProcessingMethod;
      fileManagerStore.processingConfig.imageType = processingMethod;
      fileManagerStore.processingConfig.responseType = processingMethod;
    }

    $q.notify({ type: "positive", message: "设置保存成功" });
    showDialog.value = false;

    const portChanged = serializableConfig.general.backendPort !== previousPort;
    if (portChanged) {
      $q.notify({
        type: "info",
        message: "端口已变更，页面将重新加载以应用新配置",
        timeout: 2000,
      });
      setTimeout(() => window.location.reload(), 2000);
    }
  } catch (error) {
    $q.notify({ type: "negative", message: `保存失败: ${error.message}` });
  } finally {
    saving.value = false;
  }
};

const confirmAction = () => {
  showConfirmDialog.value = false;
  if (pendingAction.value) {
    pendingAction.value();
    pendingAction.value = null;
  }
};
</script>

<style scoped>
.settings-dialog {
  z-index: 3000 !important;
}

:deep(.settings-dialog .q-dialog) {
  z-index: 3000 !important;
}

:deep(.settings-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}

.settings-card {
  min-width: min(900px, calc(100vw - 32px));
  max-width: min(960px, calc(100vw - 32px));
}

.theme-mode-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 14px;
}

.theme-color-grid,
.brush-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.theme-color-item,
.brush-config-card {
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 14px;
  padding: 16px;
}

.theme-color-control {
  display: flex;
  flex-wrap: nowrap;
  gap: 12px;
  align-items: center;
  width: 100%;
}

.native-color-input {
  flex: 0 0 52px;
  width: 52px;
  height: 40px;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.theme-color-control :deep(.q-field) {
  flex: 1 1 auto;
  min-width: 0;
}

.brush-preview {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(119, 88, 196, 0.08);
}

.brush-preview-dot {
  display: inline-block;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.08);
}

.confirm-dialog {
  z-index: 3100 !important;
}

:deep(.confirm-dialog .q-dialog) {
  z-index: 3100 !important;
}

:deep(.confirm-dialog .q-dialog__backdrop) {
  z-index: 3100 !important;
}

@media (max-width: 700px) {
  .settings-card {
    min-width: calc(100vw - 20px);
  }

  .theme-mode-card {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
