<template>
  <q-dialog v-model="showDialog" persistent class="backend-dialog">
    <q-card :class="['backend-manager-card', backendManagerCardClass]">
      <q-card-section class="row items-center q-pb-none bg-primary text-white">
        <q-icon name="settings" size="md" class="q-mr-sm" />
        <div class="text-h6">{{ backendManagerTitle }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup color="white" />
      </q-card-section>

      <q-card-section class="q-pa-none backend-content">
        <q-splitter
          v-model="splitterModel"
          :limits="[20, 80]"
          class="full-height"
        >
          <!-- 左侧控制面板 -->
          <template v-slot:before>
            <div :class="['q-pa-md', 'control-panel', 'full-height', controlPanelClass]">
              <q-stepper
                v-model="currentStep"
                vertical
                color="primary"
                animated
                class="bg-transparent"
              >
                <!-- 环境检测步骤 -->
                <q-step
                  :name="1"
                  title="环境检测"
                  icon="search"
                  :done="environmentStatus.python && environmentStatus.project"
                  :error="environmentStatus.error"
                  header-class="text-primary"
                  v-show="serviceStatus !== 'running'"
                >
                <div class="q-mb-md">
                  <q-list separator>
                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-icon
                          :name="
                            environmentStatus.python ? 'check_circle' : 'error'
                          "
                          :color="
                            environmentStatus.python ? 'positive' : 'negative'
                          "
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ pythonSectionLabel }}</q-item-label
                        >
                        <q-item-label caption class="text-grey-6">{{
                          pythonVersion || "未检测到"
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-icon
                          :name="
                            environmentStatus.project ? 'check_circle' : 'error'
                          "
                          :color="
                            environmentStatus.project ? 'positive' : 'negative'
                          "
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >后端项目</q-item-label
                        >
                        <q-item-label caption class="text-grey-6">{{
                          projectPath || "未找到"
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-icon
                          :name="
                            environmentStatus.venv ? 'check_circle' : 'error'
                          "
                          :color="
                            environmentStatus.venv ? 'positive' : 'negative'
                          "
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ venvSectionLabel }}</q-item-label
                        >
                        <q-item-label caption class="text-grey-6">{{
                          environmentStatus.venv ? "已创建" : "未创建"
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>

                <q-stepper-navigation>
                  <q-btn
                    @click="checkEnvironment"
                    color="primary"
                    label="重新检测"
                    :loading="checking"
                    unelevated
                    class="q-mb-sm"
                  />
                  <div class="q-gutter-sm">
                    <q-btn
                      v-if="!isBundledBackendMode && !environmentStatus.python"
                      @click="installPython"
                      color="secondary"
                      label="安装 Python"
                      :loading="installing.python"
                      outline
                      size="sm"
                    />
                    <q-btn
                      v-if="
                        environmentStatus.python && !environmentStatus.project
                      "
                      @click="selectProjectPath"
                      color="secondary"
                      label="选择项目路径"
                      outline
                      size="sm"
                    />
                  </div>
                </q-stepper-navigation>
              </q-step>

              <!-- 环境配置步骤 -->
                <q-step
                  :name="2"
                  title="环境配置"
                  icon="build"
                  :done="environmentStatus.configured"
                  :disable="!environmentStatus.python || !environmentStatus.project"
                  header-class="text-primary"
                  v-show="serviceStatus !== 'running'"
                >
                <div class="q-mb-md">
                  <q-list separator>
                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-icon
                          :name="
                            environmentStatus.venv ? 'check_circle' : 'pending'
                          "
                          :color="
                            environmentStatus.venv ? 'positive' : 'orange'
                          "
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ venvSetupLabel }}</q-item-label
                        >
                        <q-item-label caption class="text-grey-6">{{
                          venvStatus
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-icon
                          :name="
                            environmentStatus.dependencies
                              ? 'check_circle'
                              : 'pending'
                          "
                          :color="
                            environmentStatus.dependencies
                              ? 'positive'
                              : 'orange'
                          "
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ dependenciesLabel }}</q-item-label
                        >
                        <q-item-label caption class="text-grey-6">{{
                          dependenciesStatus
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>

                  <q-linear-progress
                    v-if="installing.dependencies"
                    :value="installProgress"
                    color="primary"
                    class="q-mt-md"
                    rounded
                    size="8px"
                  />
                </div>

                <q-stepper-navigation>
                  <q-btn
                    @click="setupEnvironment"
                    color="primary"
                    :label="setupEnvironmentLabel"
                    :loading="installing.dependencies"
                    :disable="
                      !environmentStatus.python || !environmentStatus.project
                    "
                    unelevated
                  />
                </q-stepper-navigation>
              </q-step>

              <!-- 服务管理步骤 -->
                <q-step
                  :name="3"
                  title="服务管理"
                  icon="play_arrow"
                  :disable="!environmentStatus.configured && serviceStatus !== 'running'"
                  header-class="text-primary"
                >
                <div class="q-mb-md">
                  <q-card flat bordered class="q-mb-md">
                    <q-card-section class="q-pa-md">
                      <div class="text-subtitle2 q-mb-sm text-grey-8">
                        服务状态
                      </div>
                      <q-chip
                        :color="
                          serviceStatus === 'running'
                            ? 'positive'
                            : serviceStatus === 'stopped'
                            ? 'negative'
                            : 'orange'
                        "
                        text-color="white"
                        :icon="
                          serviceStatus === 'running'
                            ? 'play_arrow'
                            : serviceStatus === 'stopped'
                            ? 'stop'
                            : 'pending'
                        "
                        class="q-mb-sm"
                      >
                        {{ serviceStatusText }}
                      </q-chip>

                      <div class="q-mt-sm text-body2">
                        <div class="text-grey-7 q-mb-xs">
                          端口:
                          <span class="text-primary text-weight-medium">{{
                            backendConfig.port
                          }}</span>
                        </div>
                        <div class="text-grey-7 q-mb-xs">
                          设备:
                          <span class="text-primary text-weight-medium">{{
                            backendConfig.device
                          }}</span>
                        </div>
                        <div class="text-grey-7 q-mb-xs">
                          模型:
                          <span class="text-primary text-weight-medium">{{
                            backendConfig.model
                          }}</span>
                        </div>
                        <div v-if="backendModelLocation" class="text-grey-7">
                          模型目录:
                          <span class="text-primary text-weight-medium">{{
                            backendModelLocation
                          }}</span>
                        </div>
                      </div>
                    </q-card-section>
                  </q-card>

                  <q-card flat bordered>
                    <q-card-section class="q-pa-md">
                      <div class="text-subtitle2 q-mb-sm text-grey-8">
                        启动配置
                      </div>
                      <q-form class="q-gutter-sm">
                        <q-input
                          v-model.number="backendConfig.port"
                          label="端口"
                          type="number"
                          :min="1024"
                          :max="65535"
                          dense
                          outlined
                          color="primary"
                        />

                        <q-select
                          v-model="backendConfig.device"
                          :options="deviceOptions"
                          label="设备"
                          dense
                          outlined
                          color="primary"
                        />

                        <q-select
                          v-model="backendConfig.model"
                          :options="modelOptions"
                          label="模型"
                          dense
                          outlined
                          color="primary"
                        />
                        <q-banner
                          v-if="isBundledBackendMode"
                          dense
                          rounded
                          class="bg-blue-1 text-primary"
                        >
                          当前使用内置离线后端，模型将直接从安装包内的内置模型目录读取。
                        </q-banner>
                        <q-input
                          v-else
                          v-model="backendConfig.modelDir"
                          label="模型目录"
                          dense
                          outlined
                          color="primary"
                          placeholder="可选：指定模型文件存储目录"
                          hint="留空则使用默认目录"
                        >
                          <template v-slot:append>
                            <q-btn
                              flat
                              round
                              dense
                              icon="folder"
                              @click="selectModelDir"
                              color="primary"
                            />
                          </template>
                        </q-input>
                      </q-form>
                    </q-card-section>
                  </q-card>
                </div>

                <q-stepper-navigation>
                  <div class="q-gutter-sm">
                    <q-btn
                      v-if="serviceStatus !== 'running'"
                      @click="startService"
                      color="positive"
                      icon="play_arrow"
                      label="启动服务"
                      :loading="serviceLoading"
                      unelevated
                    />
                    <q-btn
                      v-if="serviceStatus === 'running'"
                      @click="stopService"
                      color="negative"
                      icon="stop"
                      label="停止服务"
                      :loading="serviceLoading"
                      unelevated
                    />
                    <q-btn
                      v-if="serviceStatus === 'running'"
                      @click="restartService"
                      color="orange"
                      icon="refresh"
                      label="重启服务"
                      :loading="serviceLoading"
                      outline
                    />
                  </div>
                </q-stepper-navigation>
              </q-step>
            </q-stepper>
          </div>

          </template>

          <!-- 右侧终端区域 -->
          <template v-slot:after>
            <div class="terminal-section full-height">
              <div class="terminal-header">
                <q-icon name="terminal" class="q-mr-sm" />
                <span class="text-h6">终端输出</span>
                <q-space />
                <q-btn
                  flat
                  round
                  dense
                  icon="clear_all"
                  color="white"
                  @click="clearTerminal"
                  class="q-mr-sm"
                >
                  <q-tooltip>清空终端</q-tooltip>
                </q-btn>
              </div>
              <div ref="terminalRef" class="terminal-output">
                <div
                  v-for="(line, index) in terminalOutput"
                  :key="index"
                  :class="{
                    'text-red': line.type === 'error',
                    'text-yellow': line.type === 'warning',
                    'text-green': line.type === 'success',
                    'text-white': line.type === 'info',
                  }"
                  class="terminal-line"
                >
                  <span class="text-grey-5">[{{ line.timestamp }}]</span>
                  {{ line.message }}
                </div>
              </div>

              <!-- 终端输入 -->
              <div class="terminal-input">
                <q-input
                  v-model="terminalInput"
                  dense
                  outlined
                  placeholder="输入命令..."
                  class="col"
                  bg-color="grey-9"
                  color="green"
                  @keyup.enter="executeCommand"
                >
                  <template v-slot:prepend>
                    <q-icon name="terminal" color="green" />
                  </template>
                </q-input>
                <q-btn
                  @click="executeCommand"
                  color="primary"
                  icon="send"
                  dense
                  class="q-ml-sm"
                  :loading="commandExecuting"
                  unelevated
                />
              </div>
            </div>
          </template>
        </q-splitter>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>
<script setup>
import { computed, ref, reactive, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useQuasar } from "quasar";
import { useConfigStore } from "src/stores/config";
import { api } from "src/boot/axios";

// Props
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});
const splitterModel = ref(35);

const configStore = useConfigStore();
const $q = useQuasar();
// Emits
const emit = defineEmits(["update:modelValue"]);

const backendMode = ref("external");
const isBundledBackendMode = computed(() => backendMode.value === "bundled");
const backendManagerTitle = computed(() =>
  isBundledBackendMode.value ? "离线后端管理" : "Python 后端管理"
);
const pythonSectionLabel = computed(() =>
  isBundledBackendMode.value ? "离线运行时" : "Python 环境"
);
const venvSectionLabel = computed(() =>
  isBundledBackendMode.value ? "离线运行时" : "虚拟环境"
);
const venvSetupLabel = computed(() =>
  isBundledBackendMode.value ? "离线运行时准备" : "虚拟环境创建"
);
const dependenciesLabel = computed(() =>
  isBundledBackendMode.value ? "内置依赖" : "依赖安装"
);
const setupEnvironmentLabel = computed(() =>
  isBundledBackendMode.value ? "准备离线运行时" : "配置环境"
);

// 响应式数据
const backendManagerCardClass = computed(() =>
  $q.dark.isActive ? "backend-manager-card--dark" : "backend-manager-card--light"
);
const controlPanelClass = computed(() =>
  $q.dark.isActive ? "control-panel--dark" : "control-panel--light"
);
const backendModelLocation = computed(() =>
  isBundledBackendMode.value
    ? backendConfig.modelPath || "resources/models"
    : backendConfig.modelDir || ""
);
const showDialog = ref(false);
const currentStep = ref(1);
const checking = ref(false);
const commandExecuting = ref(false);
const serviceLoading = ref(false);

// 环境状态
const environmentStatus = reactive({
  python: false,
  project: false,
  venv: false,
  dependencies: false,
  configured: false,
  error: false,
});

// 安装状态
const installing = reactive({
  python: false,
  dependencies: false,
});

// 服务状态
const serviceStatus = ref("stopped"); // 'stopped', 'starting', 'running', 'stopping'
const serviceStatusText = ref("已停止");

// 配置
const pythonVersion = ref("");
const projectPath = ref("");
const venvStatus = ref("未创建");
const dependenciesStatus = ref("未安装");
const installProgress = ref(0);

// 后端配置
const backendConfig = reactive({
  port: configStore.config.general.backendPort || 8080,
  device: configStore.config.general.launchMode || "cuda",
  model: configStore.config.general.defaultModel || "lama",
  modelPath: configStore.config.general.modelPath || "",
  projectPath: configStore.config.general.backendProjectPath || "",
  modelDir: configStore.config.general.modelDir || ""
});

// 选项
const deviceOptions = ["cuda", "cpu"];
const modelOptions = ["lama"];

// 终端
const terminalOutput = ref([]);
const terminalInput = ref("");
const terminalRef = ref(null);

const clearTerminal = () => {
  terminalOutput.value = [];
  addTerminalLog("终端已清空", "info");
};
// IPC 监听器处理后端输出
const handleBackendOutput = (event, data) => {
  addTerminalLog(data.message, data.type);
};
// 检查服务状态的函数
const checkServiceStatus = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("check-backend-status");
    if (result.success && result.running) {
      serviceStatus.value = "running";
      serviceStatusText.value = "运行中";
      // 设置环境状态为已配置
      environmentStatus.python = true;
      environmentStatus.project = true;
      environmentStatus.venv = true;
      environmentStatus.dependencies = true;
      environmentStatus.configured = true;
      pythonVersion.value =
        pythonVersion.value ||
        (isBundledBackendMode.value ? "Bundled offline runtime ready" : "Python detected");
      venvStatus.value = isBundledBackendMode.value
        ? "Ready (bundled-runtime)"
        : "Ready";
      dependenciesStatus.value = isBundledBackendMode.value
        ? "Bundled dependencies ready"
        : "Installed";
    } else {
      serviceStatus.value = "stopped";
      serviceStatusText.value = "已停止";
    }
  } catch (error) {
    console.error("检查服务状态失败:", error);
    serviceStatus.value = "stopped";
    serviceStatusText.value = "已停止";
  }
};
// 监听对话框显示状态
watch(
  () => props.modelValue,
  (newVal) => {
    showDialog.value = newVal;
    if (newVal) {
      // 检查服务状态，如果服务正在运行则跳过环境检测
      syncCurrentBackendMode().finally(() => {
        checkServiceStatus().then(() => {
          if (serviceStatus.value !== "running") {
            checkEnvironment();
          } else {
            // 服务正在运行，直接跳转到服务管理步骤
            currentStep.value = 3;
            addTerminalLog("检测到后端服务正在运行，跳过环境检测", "info");
          }
        });
      });
    }
  }
);

// 监听配置变化
watch(
  () => configStore.config,
  (newConfig) => {
    backendConfig.port = newConfig.general.backendPort || 8080;
    backendConfig.device = newConfig.general.launchMode || "cuda";
    backendConfig.model = newConfig.general.defaultModel || "lama";
    backendConfig.modelPath = newConfig.general.modelPath || "";
    backendConfig.projectPath = newConfig.general.backendProjectPath || "";
    backendConfig.modelDir = newConfig.general.modelDir || "";
  },
  { deep: true }
);

watch(showDialog, (newVal) => {
  emit("update:modelValue", newVal);
});

// 添加终端日志
const addTerminalLog = (message, type = "info") => {
  const timestamp = new Date().toLocaleTimeString();
  terminalOutput.value.push({
    message,
    type,
    timestamp,
  });

  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
};

const persistConfig = async (nextConfig) => {
  const serializableConfig = JSON.parse(JSON.stringify(nextConfig));
  const electronResult = await window.electron.ipcRenderer.invoke(
    "save-app-config",
    serializableConfig
  );
  if (!electronResult?.success) {
    throw new Error(electronResult?.error || "配置持久化失败");
  }

  const storeResult = await configStore.saveConfig(nextConfig);
  if (!storeResult?.success) {
    if (Array.isArray(storeResult?.errors) && storeResult.errors.length > 0) {
      throw new Error(storeResult.errors.join("; "));
    }
    throw new Error(storeResult?.error || "配置更新失败");
  }
};

const syncBackendMode = (mode = "external") => {
  backendMode.value = mode === "bundled" ? "bundled" : "external";
};

const syncCurrentBackendMode = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke(
      "check-project",
      backendConfig.projectPath
    );
    if (!result?.success) {
      return;
    }

    syncBackendMode(result.backendMode);
    if (result.path) {
      projectPath.value = result.path;
      backendConfig.projectPath = result.path;
    }
  } catch (error) {
    console.warn("Failed to sync backend mode:", error);
  }
};

const applyPreparedEnvironment = (prepareResult = {}) => {
  syncBackendMode(prepareResult.backendMode || backendMode.value);
  environmentStatus.project = true;
  environmentStatus.python = true;
  environmentStatus.venv = true;

  if (prepareResult.path) {
    projectPath.value = prepareResult.path;
    backendConfig.projectPath = prepareResult.path;
  }

  if (prepareResult.modelDir !== undefined) {
    backendConfig.modelPath = prepareResult.modelDir || backendConfig.modelPath;
  }

  pythonVersion.value = prepareResult.pythonVersion
    ? `Python ${prepareResult.pythonVersion}`
    : isBundledBackendMode.value
      ? "Bundled offline runtime ready"
      : "Python detected";

  const runtimeName =
    prepareResult.venvName || (isBundledBackendMode.value ? "bundled-runtime" : ".venv");
  venvStatus.value = isBundledBackendMode.value
    ? `Ready (${runtimeName})`
    : `Created (${runtimeName})`;
};

const applyDependenciesStatus = (ready) => {
  environmentStatus.dependencies = !!ready;
  environmentStatus.configured = !!ready;
  dependenciesStatus.value = ready
    ? isBundledBackendMode.value
      ? "Bundled dependencies ready"
      : "Installed"
    : isBundledBackendMode.value
      ? "Bundled dependencies not ready"
      : "Not installed";
};

const appendProjectPathGuidance = (result) => {
  if (!result || !["PROJECT_NOT_SELECTED", "PROJECT_PATH_NOT_FOUND"].includes(result.code)) {
    return;
  }

  if (result.defaultProjectParentPath) {
    addTerminalLog(
      `请将 IOPaint 后端项目移动到 ${result.defaultProjectParentPath} 路径下。`,
      "warning"
    );
  } else {
    addTerminalLog("请将 IOPaint 后端项目移动到默认后端目录下。", "warning");
  }

  addTerminalLog(
    "或退出后端管理页面 → 打开全局设置 → 后端设置 → 后端项目路径→ 点击图标选择路径",
    "warning"
  );
};

// 检查环境
const checkEnvironment = async () => {
  checking.value = true;
  environmentStatus.error = false;
  addTerminalLog("开始检测后端环境...", "info");

  try {
    const projectResult = await window.electron.ipcRenderer.invoke(
      "check-project",
      backendConfig.projectPath
    );

    if (!projectResult.success) {
      environmentStatus.python = false;
      environmentStatus.project = false;
      environmentStatus.venv = false;
      environmentStatus.dependencies = false;
      environmentStatus.configured = false;
      pythonVersion.value = "";
      venvStatus.value = "未创建";
      dependenciesStatus.value = "未安装";
      currentStep.value = 1;
      addTerminalLog(`后端项目检测失败：${projectResult.error}`, "error");
      appendProjectPathGuidance(projectResult);
      return;
    }

    syncBackendMode(projectResult.backendMode);
    environmentStatus.project = true;
    projectPath.value = projectResult.path;
    backendConfig.projectPath = projectResult.path;
    if (configStore.config.general.backendProjectPath !== projectResult.path) {
      const newConfig = { ...configStore.config };
      newConfig.general.backendProjectPath = projectResult.path;
      await persistConfig(newConfig);
    }
    addTerminalLog(`后端项目检测成功：${projectResult.path}`, "success");

    addTerminalLog(
      projectResult.backendMode === "bundled"
        ? "Detected bundled offline backend mode."
        : "Detected external backend mode.",
      "info"
    );

    const prepareResult = await window.electron.ipcRenderer.invoke(
      "prepare-project-python",
      projectResult.path
    );

    if (!prepareResult.success) {
      environmentStatus.python = false;
      environmentStatus.venv = false;
      environmentStatus.dependencies = false;
      environmentStatus.configured = false;
      pythonVersion.value = "";
      venvStatus.value = "未创建";
      dependenciesStatus.value = "未安装";
      currentStep.value = 1;
      addTerminalLog(
        `Python 环境准备失败：${prepareResult.error || "未知错误"}`,
        "error"
      );
      appendProjectPathGuidance(prepareResult);

      if (prepareResult.manualGuide?.downloadUrl) {
        addTerminalLog(
          `手动下载链接：${prepareResult.manualGuide.downloadUrl}`,
          "warning"
        );
      }
      if (Array.isArray(prepareResult.manualGuide?.commands)) {
        addTerminalLog("手动执行命令：", "info");
        prepareResult.manualGuide.commands.forEach((command) => {
          addTerminalLog(command, "info");
        });
      }
      return;
    }

    environmentStatus.python = true;
    environmentStatus.venv = true;
    pythonVersion.value = prepareResult.pythonVersion
      ? `Python ${prepareResult.pythonVersion}`
      : "已检测到 Python";
    venvStatus.value = `已就绪（${prepareResult.venvName || ".venv"}）`;
    addTerminalLog(
      `Python 环境已就绪（来源：${prepareResult.pythonSource || "项目虚拟环境"}）`,
      "success"
    );

    applyPreparedEnvironment(prepareResult);
    addTerminalLog(
      isBundledBackendMode.value
        ? "Bundled offline runtime is ready."
        : `Python environment is ready (${prepareResult.pythonSource || "project virtual environment"}).`,
      "success"
    );

    const depsResult = await window.electron.ipcRenderer.invoke("check-dependencies");
    if (depsResult.success) {
      applyDependenciesStatus(true);
      addTerminalLog(
        isBundledBackendMode.value
          ? "Bundled backend dependencies are ready."
          : "依赖已安装。",
        "success"
      );
      currentStep.value = 3;
    } else {
      applyDependenciesStatus(false);
      if (depsResult.error) {
        addTerminalLog(
          isBundledBackendMode.value
            ? `Bundled dependency check failed: ${depsResult.error}`
            : `依赖检测失败：${depsResult.error}`,
          "warning"
        );
      }
      currentStep.value = 2;
    }
  } catch (error) {
    environmentStatus.error = true;
    addTerminalLog(`环境检测失败：${error.message}`, "error");
  } finally {
    checking.value = false;
  }
};

// 安装 Python
const installPython = async () => {
  installing.python = true;
  addTerminalLog("开始安装 Python...", "info");

  try {
    const result = await window.electron.ipcRenderer.invoke("install-python");
    if (result.success) {
      addTerminalLog("Python 安装完成。", "success");
      await checkEnvironment();
    } else {
      addTerminalLog(`Python 安装失败：${result.error}`, "error");
    }
  } catch (error) {
    addTerminalLog(`Python 安装失败：${error.message}`, "error");
  } finally {
    installing.python = false;
  }
};

// 选择项目路径
const selectProjectPath = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择 Python 后端项目路径",
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];

      // 先检查选择的路径是否有效
      const checkResult = await window.electron.ipcRenderer.invoke(
        "check-project",
        selectedPath
      );

      if (checkResult.success) {
        const setResult = await window.electron.ipcRenderer.invoke(
          "set-project-path",
          selectedPath
        );

        if (setResult.success) {
          const effectiveProjectPath = setResult.path || checkResult.path || selectedPath;
          projectPath.value = effectiveProjectPath;
          backendConfig.projectPath = effectiveProjectPath;
          syncBackendMode(setResult.backendMode || checkResult.backendMode);
          environmentStatus.project = true;

          // 保存到配置文件
          const newConfig = { ...configStore.config };
          newConfig.general.backendProjectPath = effectiveProjectPath;
          await persistConfig(newConfig);

          addTerminalLog(`项目路径设置成功: ${effectiveProjectPath}`, "success");
          await checkEnvironment();
        } else {
          addTerminalLog(`项目路径设置失败: ${setResult.error}`, "error");
        }
      } else {
        addTerminalLog(`项目路径无效: ${checkResult.error}`, "error");
      }
    }
  } catch (error) {
    addTerminalLog(`选择项目路径失败: ${error.message}`, "error");
  }
};
// 选择模型目录
const selectModelDir = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择模型目录",
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      backendConfig.modelDir = selectedPath;

      // 保存到配置文件
      const newConfig = { ...configStore.config };
      newConfig.general.modelDir = selectedPath;
      await persistConfig(newConfig);

      addTerminalLog(`模型目录设置成功: ${selectedPath}`, "success");
    }
  } catch (error) {
    addTerminalLog(`选择模型目录失败: ${error.message}`, "error");
  }
};
// 配置环境
const setupEnvironment = async () => {
  installing.dependencies = true;
  installProgress.value = 0;
  addTerminalLog(
    isBundledBackendMode.value
      ? "Preparing bundled offline backend..."
      : "Preparing backend environment...",
    "info"
  );
  addTerminalLog("开始配置后端环境...", "info");

  try {
    const prepareResult = await window.electron.ipcRenderer.invoke(
      "prepare-project-python",
      projectPath.value || backendConfig.projectPath
    );

    if (!prepareResult.success) {
      appendProjectPathGuidance(prepareResult);
      if (prepareResult.manualGuide?.downloadUrl) {
        addTerminalLog(
          `手动下载链接：${prepareResult.manualGuide.downloadUrl}`,
          "warning"
        );
      }
      if (Array.isArray(prepareResult.manualGuide?.commands)) {
        addTerminalLog("手动执行命令：", "info");
        prepareResult.manualGuide.commands.forEach((command) => {
          addTerminalLog(command, "info");
        });
      }
      throw new Error(prepareResult.error || "Python 环境准备失败。");
    }

    environmentStatus.project = true;
    environmentStatus.python = true;
    environmentStatus.venv = true;
    if (prepareResult.path) {
      projectPath.value = prepareResult.path;
    }
    pythonVersion.value = prepareResult.pythonVersion
      ? `Python ${prepareResult.pythonVersion}`
      : pythonVersion.value;
    venvStatus.value = `已就绪（${prepareResult.venvName || ".venv"}）`;
    addTerminalLog("虚拟环境已就绪。", "success");
    installProgress.value = 50;

    addTerminalLog("开始安装依赖...", "info");
    applyPreparedEnvironment(prepareResult);
    addTerminalLog(
      isBundledBackendMode.value
        ? "Bundled offline runtime is ready."
        : "Virtual environment is ready.",
      "success"
    );
    addTerminalLog(
      isBundledBackendMode.value
        ? "Verifying bundled backend dependencies..."
        : "Installing dependencies...",
      "info"
    );

    const depsResult = await window.electron.ipcRenderer.invoke(
      "install-dependencies",
      projectPath.value || backendConfig.projectPath
    );

    if (depsResult.success) {
      applyDependenciesStatus(true);
      addTerminalLog(
        isBundledBackendMode.value
          ? "Bundled backend dependencies are ready."
          : "依赖安装成功。",
        "success"
      );
      installProgress.value = 100;
      currentStep.value = 3;
    } else {
      throw new Error(depsResult.error);
    }
  } catch (error) {
    addTerminalLog(`环境配置失败：${error.message}`, "error");
  } finally {
    installing.dependencies = false;
  }
};

// 启动服务
const startService = async () => {
  serviceLoading.value = true;
  serviceStatus.value = "starting";
  serviceStatusText.value = "启动中...";
  addTerminalLog(
    `启动后端服务... 端口: ${backendConfig.port}, 设备: ${backendConfig.device}, 模型: ${backendConfig.model}`,
    "info"
  );

  try {
    const result = await window.electron.ipcRenderer.invoke(
      "start-backend-service",
      {
        port: backendConfig.port,
        device: backendConfig.device,
        model: backendConfig.model,
        modelDir: backendConfig.modelDir,
      }
    );

    if (result.success) {
      serviceStatus.value = "running";
      serviceStatusText.value = "运行中";
      addTerminalLog(
        `后端服务启动成功，端口: ${backendConfig.port}`,
        "success"
      );
      // 更新 axios 的端口配置
      api.updateConfig({
        general: {
          backendPort: backendConfig.port
        }
      });
      addTerminalLog(
        `已更新前端 API 端口配置为: ${backendConfig.port}`,
        "success"
      );
      addTerminalLog(
        `请耐心等待直到本页面出现以下内容：INFO: Uvicorn running on http://127.0.0.1:8080 (Press CTRL+C to quit)`,
        "success"
      );
    } else {
      serviceStatus.value = "stopped";
      serviceStatusText.value = "已停止";
      addTerminalLog(`后端服务启动失败: ${result.error}`, "error");
    }
  } catch (error) {
    serviceStatus.value = "stopped";
    serviceStatusText.value = "已停止";
    addTerminalLog(`后端服务启动失败: ${error.message}`, "error");
  } finally {
    serviceLoading.value = false;
  }
};

// 停止服务
const stopService = async () => {
  serviceLoading.value = true;
  serviceStatus.value = "stopping";
  serviceStatusText.value = "停止中...";
  addTerminalLog("停止后端服务...", "info");

  try {
    const result = await window.electron.ipcRenderer.invoke(
      "stop-backend-service"
    );

    if (result.success) {
      serviceStatus.value = "stopped";
      serviceStatusText.value = "已停止";
      addTerminalLog("后端服务已停止", "success");
    } else {
      addTerminalLog(`停止后端服务失败: ${result.error}`, "error");
    }
  } catch (error) {
    addTerminalLog(`停止后端服务失败: ${error.message}`, "error");
  } finally {
    serviceLoading.value = false;
  }
};

// 重启服务
const restartService = async () => {
  await stopService();
  setTimeout(() => {
    startService();
  }, 2000);
};

// 执行命令
const executeCommand = async () => {
  if (!terminalInput.value.trim()) return;

  const command = terminalInput.value.trim();
  terminalInput.value = "";
  commandExecuting.value = true;

  addTerminalLog(`$ ${command}`, "info");

  try {
    const result = await window.electron.ipcRenderer.invoke("execute-command", {
      command,
      cwd: projectPath.value,
    });

    if (result.success) {
      if (result.output) {
        result.output.split("\n").forEach((line) => {
          if (line.trim()) {
            addTerminalLog(line, "info");
          }
        });
      }
    } else {
      addTerminalLog(result.error, "error");
    }
  } catch (error) {
    addTerminalLog(`命令执行失败: ${error.message}`, "error");
  } finally {
    commandExecuting.value = false;
  }
};

// 组件挂载时检查环境
onMounted(() => {
  if (showDialog.value) {
    checkEnvironment();
  }
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.on('backend-output', handleBackendOutput);
    // 监听Python安装路径消息
    window.electron.ipcRenderer.on('python-install-path', (event, path) => {
      addTerminalLog(`安装包已下载至: ${path}`, 'info');
    });
  }
});
onUnmounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.removeListener('backend-output', handleBackendOutput);
  }
});
</script>

<style scoped>
/* 后端管理对话框层级 - 最高层级 */
.backend-dialog {
  z-index: 3000 !important;
}

:deep(.backend-dialog .q-dialog) {
  z-index: 3000 !important;
}

:deep(.backend-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}

.backend-manager-card {
  width: 90vw;
  height: 80vh;
  max-width: 1600px;
  max-height: 1000px;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.15);
  transition: background-color 0.2s ease, color 0.2s ease;
}

.backend-manager-card--light {
  background: #ffffff;
  color: rgba(17, 24, 39, 0.94);
}

.backend-manager-card--dark {
  background: #121212;
  color: rgba(244, 244, 245, 0.94);
}

.backend-content {
  height: calc(80vh - 60px);
  max-height: calc(1000px - 60px);
}

.full-height {
  height: 100%;
}

.control-panel {
  overflow-y: auto;
  min-width: 300px;
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.control-panel--light {
  background: #f5f5f5;
  border-right: 1px solid #e0e0e0;
  color: rgba(17, 24, 39, 0.94);
}

.control-panel--dark {
  background: #1d1d1d;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(244, 244, 245, 0.94);
}

.control-panel::-webkit-scrollbar {
  width: 6px;
}

.control-panel--light::-webkit-scrollbar-track {
  background: #f5f5f5;
}

.control-panel--light::-webkit-scrollbar-thumb {
  background: #c0c0c0;
  border-radius: 3px;
}

.control-panel--light::-webkit-scrollbar-thumb:hover {
  background: #a0a0a0;
}

.terminal-section {
  background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
  display: flex;
  flex-direction: column;
  color: white;
  min-width: 400px;
}

.terminal-header {
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  color: #4ade80;
  flex-shrink: 0;
}

.terminal-output {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  font-family: "Courier New", "Monaco", "Menlo", monospace;
  font-size: 13px;
  line-height: 1.5;
  background: rgba(0, 0, 0, 0.3);
  margin: 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.terminal-line {
  margin-bottom: 2px;
  word-wrap: break-word;
}

.terminal-output::-webkit-scrollbar {
  width: 8px;
}

.terminal-output::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.terminal-output::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 4px;
}

.terminal-output::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.5);
}

.terminal-input {
  padding: 16px;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.control-panel--dark::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.04);
}

.control-panel--dark::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
}

.control-panel--dark::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}

.control-panel--dark :deep(.q-stepper),
.control-panel--dark :deep(.q-stepper__step-inner),
.control-panel--dark :deep(.q-stepper__nav),
.control-panel--dark :deep(.q-card) {
  background: #1d1d1d;
  color: rgba(244, 244, 245, 0.94);
}

.control-panel--dark :deep(.q-card) {
  border-color: rgba(255, 255, 255, 0.08);
}

.control-panel--dark :deep(.q-banner) {
  background: rgba(59, 130, 246, 0.16) !important;
  color: rgba(191, 219, 254, 0.98) !important;
}

.control-panel--dark :deep(.q-item__label),
.control-panel--dark :deep(.text-grey-8),
.control-panel--dark :deep(.text-grey-7),
.control-panel--dark :deep(.text-grey-6) {
  color: rgba(228, 228, 231, 0.9) !important;
}

.control-panel--dark :deep(.q-field__control),
.control-panel--dark :deep(.q-field__native),
.control-panel--dark :deep(.q-field__input) {
  color: rgba(244, 244, 245, 0.94);
}

.control-panel--dark :deep(.q-field--outlined .q-field__control) {
  background: rgba(255, 255, 255, 0.04);
}

.control-panel--dark :deep(.q-field__marginal),
.control-panel--dark :deep(.q-stepper__title),
.control-panel--dark :deep(.q-stepper__caption) {
  color: rgba(228, 228, 231, 0.88);
}

/* 响应式设计 */
@media (max-width: 1200px) {
  .backend-dialog .q-dialog__inner {
    padding: 2vh 2vw;
  }

  .backend-manager-card {
    width: 96vw;
    height: 96vh;
  }

  .backend-content {
    height: calc(96vh - 60px);
  }
}

@media (max-width: 768px) {
  .control-panel {
    min-width: 250px;
  }

  .terminal-section {
    min-width: 300px;
  }
}
</style>
