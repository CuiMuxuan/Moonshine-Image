<template>
  <q-dialog v-model="showDialog" persistent>
    <q-card style="min-width: 600px; max-width: 800px">
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
          <q-tab name="general" label="常规设置" />
          <q-tab name="files" label="文件管理" />
          <q-tab name="advanced" label="高级设置" />
        </q-tabs>

        <q-separator />

        <q-tab-panels v-model="activeTab" animated>
<q-tab-panel name="general">
  <div class="q-gutter-md">
    <q-input
      v-model.number="localConfig.general.backendPort"
      label="后端端口号"
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
      <template v-slot:append>
        <q-btn
          round
          dense
          flat
          icon="folder"
          @click="selectBackendProjectPath"
        />
      </template>
    </q-input>

    <q-input
      v-model="localConfig.general.modelPath"
      label="模型文件路径"
      readonly
    >
      <template v-slot:append>
        <q-btn
          round
          dense
          flat
          icon="folder"
          @click="selectModelPath"
        />
      </template>
    </q-input>

    <q-select
      v-model="localConfig.general.defaultModel"
      label="默认模型"
      :options="['lama', 'big-lama', 'ldm', 'zits', 'mat', 'fcf']"
    />
  </div>
</q-tab-panel>
          <!-- 常规设置 -->
          <q-tab-panel name="general">
            <div class="q-gutter-md">
              <q-input
                v-model.number="localConfig.general.backendPort"
                label="后端端口号"
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
                v-model="localConfig.general.modelPath"
                label="模型文件路径"
                readonly
              >
                <template v-slot:append>
                  <q-btn
                    round
                    dense
                    flat
                    icon="folder"
                    @click="selectModelPath"
                  />
                </template>
              </q-input>
            </div>
          </q-tab-panel>

          <!-- 文件管理 -->
          <q-tab-panel name="files">
            <div class="q-gutter-md">
              <q-input
                v-model="localConfig.fileManagement.downloadPath"
                label="下载/导出路径"
                readonly
              >
                <template v-slot:append>
                  <q-btn
                    round
                    dense
                    flat
                    icon="folder"
                    @click="selectDownloadPath"
                  />
                </template>
              </q-input>

              <q-input
                v-model="localConfig.fileManagement.tempPath"
                label="临时文件路径"
                readonly
              >
                <template v-slot:append>
                  <q-btn
                    round
                    dense
                    flat
                    icon="folder"
                    @click="selectTempPath"
                  />
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

          <!-- 高级设置 -->
          <q-tab-panel name="advanced">
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
                label="状态保存限制大小 (MB)"
                type="number"
                :min="1"
                :max="500"
              />
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="取消" v-close-popup />
        <q-btn
          color="primary"
          label="保存"
          :loading="saving"
          @click="saveSettings"
          :disable="hasErrors"
        >
          <!-- 添加禁用原因提示 -->
          <q-tooltip v-if="hasErrors" class="bg-negative">
            {{ disableReason }}
          </q-tooltip>
        </q-btn>
      </q-card-actions>
    </q-card>
  </q-dialog>

  <!-- 确认对话框 -->
  <q-dialog v-model="showConfirmDialog" persistent>
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
import { ref, computed, watch } from "vue";
import { useQuasar } from "quasar";
import { useConfigStore } from "src/stores/config";
import { useAppStateStore } from "src/stores/appState";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();

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

const activeTab = ref("general");
const saving = ref(false);
const showConfirmDialog = ref(false);
const confirmMessage = ref("");
const pendingAction = ref(null);

// 本地配置副本
const localConfig = ref({
  general: { ...configStore.config.general },
  fileManagement: { ...configStore.config.fileManagement },
  advanced: { ...configStore.config.advanced },
});

// 验证状态
const portError = ref(false);
const portErrorMessage = ref("");

// 监听配置变化
watch(
  () => configStore.config,
  (newConfig) => {
    localConfig.value = {
      general: { ...newConfig.general },
      fileManagement: { ...newConfig.fileManagement },
      advanced: { ...newConfig.advanced },
    };
  },
  { deep: true }
);

// 验证端口号
const validatePort = (port) => {
  if (!port || port < 1024 || port > 65535) {
    portError.value = true;
    portErrorMessage.value = "端口号必须在 1024-65535 范围内";
  } else {
    portError.value = false;
    portErrorMessage.value = "";
  }
};

// 检查是否有错误
const hasErrors = computed(() => {
  const errors = configStore.validateConfig(localConfig.value);
  return errors.length > 0 || portError.value;
});

// 计算禁用原因
const disableReason = computed(() => {
  const errors = configStore.validateConfig(localConfig.value);
  const reasons = [];

  if (portError.value) {
    reasons.push(portErrorMessage.value);
  }

  if (errors.length > 0) {
    reasons.push(...errors);
  }

  return reasons.join("；");
});
// 选择模型路径
const selectModelPath = async () => {
  if (window.electron) {
    try {
      const result = await window.electron.ipcRenderer.invoke("select-folder", {
        title: "选择模型文件夹"
      });

      if (!result.canceled && result.filePaths.length > 0) {
        localConfig.value.general.modelPath = result.filePaths[0];
      }
    } catch (error) {
      $q.notify({
        type: "negative",
        message: "选择文件夹失败: " + error.message,
      });
    }
  }
};

// 选择下载路径
const selectDownloadPath = async () => {
  if (window.electron) {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        "select-directory"
      );

      if (!result.canceled && result.filePaths.length > 0) {
        localConfig.value.fileManagement.downloadPath = result.filePaths[0];
      }
    } catch (error) {
      $q.notify({
        type: "negative",
        message: "选择目录失败: " + error.message,
      });
    }
  }
};

// 选择临时路径
const selectTempPath = async () => {
  if (window.electron) {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        "select-directory"
      );

      if (!result.canceled && result.filePaths.length > 0) {
        localConfig.value.fileManagement.tempPath = result.filePaths[0];
      }
    } catch (error) {
      $q.notify({
        type: "negative",
        message: "选择目录失败: " + error.message,
      });
    }
  }
};

// 选择后端项目路径
const selectBackendProjectPath = async () => {
  if (window.electron) {
    try {
      const result = await window.electron.ipcRenderer.invoke("select-folder", {
        title: "选择后端项目路径"
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];

        // 检查选择的路径是否有效
        const checkResult = await window.electron.ipcRenderer.invoke('check-project', selectedPath);

        if (checkResult.success) {
          localConfig.value.general.backendProjectPath = selectedPath;
          $q.notify({
            type: "positive",
            message: "后端项目路径设置成功",
          });
        } else {
          $q.notify({
            type: "negative",
            message: `无效的后端项目路径: ${checkResult.error}`,
          });
        }
      }
    } catch (error) {
      $q.notify({
        type: "negative",
        message: "选择文件夹失败: " + error.message,
      });
    }
  }
};
// 保存设置
const saveSettings = async () => {
  // 检查是否需要状态保存
  const needsStateSave =
    JSON.stringify(localConfig.value) !== JSON.stringify(configStore.config);

  if (needsStateSave) {
    // 尝试保存状态
    const stateResult = await appStateStore.saveState();
    if (!stateResult.success && stateResult.oversized) {
      // 状态过大，询问用户
      confirmMessage.value = `状态数据过大无法保存 (${stateResult.error})。继续保存配置将重置页面，未保存的内容将丢失。是否继续？`;
      showConfirmDialog.value = true;
      pendingAction.value = () => doSaveSettings();
      return;
    }
  }

  await doSaveSettings();
};

// 执行保存设置
const doSaveSettings = async () => {
  saving.value = true;
  try {
    const serializableConfig = JSON.parse(JSON.stringify(localConfig.value));
    console.log('准备保存的配置:', serializableConfig);
    // 先保存到 Electron 配置文件
    const electronResult = await window.electron.ipcRenderer.invoke(
      "save-app-config",
      serializableConfig
    );
    console.log('Electron保存结果:', electronResult);

    if (!electronResult.success) {
      throw new Error(electronResult.error);
    }

    // 然后更新 Pinia store
    const storeResult = await configStore.saveConfig(localConfig.value);
    if (storeResult.success) {
      $q.notify({
        type: "positive",
        message: "设置保存成功",
      });

      showDialog.value = false;

      // 只有在端口号改变时才需要重新加载页面
      const portChanged =
        localConfig.value.general.backendPort !==
        configStore.config.general.backendPort;

      if (portChanged) {
        $q.notify({
          type: "info",
          message: "端口号已更改，页面将重新加载以应用新配置",
          timeout: 2000,
        });

        setTimeout(() => {
          window.location.reload();
        }, 2000);
      }
    } else {
      throw new Error(storeResult.error);
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: "保存失败: " + error.message,
    });
  } finally {
    saving.value = false;
  }
};

// 确认操作
const confirmAction = () => {
  showConfirmDialog.value = false;
  if (pendingAction.value) {
    pendingAction.value();
    pendingAction.value = null;
  }
};
</script>
