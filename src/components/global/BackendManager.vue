<template>
  <q-dialog v-model="showDialog" persistent class="backend-dialog">
    <q-card :class="['backend-manager-card', backendManagerCardClass]">
      <q-card-section class="row items-center q-pb-none bg-primary text-white">
        <q-icon name="settings" size="md" class="q-mr-sm" />
        <div class="text-h6">{{ backendManagerTitle }}</div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          v-close-popup
          color="white"
          data-testid="backend-manager-close-button"
        />
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
              <div ref="terminalRef" class="terminal-output" data-testid="backend-terminal-output">
                <div
                  v-for="(line, index) in terminalOutput"
                  :key="index"
                  :class="['terminal-line', getTerminalLineClass(line)]"
                  data-testid="backend-terminal-line"
                  :data-refresh-id="line.refreshId"
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
import {
  buildBackendPathBlockedMessage,
  buildBackendPathSelectionBlockedMessage,
  validateBackendPaths,
} from "src/utils/backendPathValidation";

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
const MAX_TERMINAL_LINES = 2000;
const TERMINAL_PROGRESS_SYNC_MIN_MS = 500;
const TERMINAL_PROGRESS_SYNC_MAX_MS = 1000;
const TERMINAL_PROGRESS_HEARTBEAT_MS = 1000;
const TERMINAL_TRUNCATION_MESSAGE = `较早的终端输出已折叠，仅保留最近 ${MAX_TERMINAL_LINES} 行。`;
const ansiPattern =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
let activeTerminalLine = null;
let pendingTerminalLogs = [];
let terminalFlushTimerId = 0;
let lastTerminalFlushAt = 0;
let terminalLineRefreshId = 0;
let terminalProgressHeartbeatTimerId = 0;
let activeVideoBatchProgressContext = null;

const sanitizeTerminalText = (message) =>
  String(message ?? "")
    .replace(ansiPattern, "")
    .split(String.fromCharCode(8))
    .join("");

const getProgressLineKey = (message = "") => {
  const text = String(message || "").trim();
  if (!text.includes("%") || !text.includes("|")) {
    return "";
  }

  const prefix = text.split("|", 1)[0].replace(/\s*\d+%\s*$/, "").trim();
  return prefix || "terminal-progress";
};

const formatBackendModelLabel = (modelId = "") => {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (normalized === "batch processing") return "批量图片";
  if (normalized === "slbr" || normalized === "slbr processing") return "SLBR";
  if (normalized === "lama" || normalized === "lama processing") return "Lama";
  return normalized ? normalized.toUpperCase() : "模型";
};

const parseDurationTokenToSeconds = (value = "") => {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] ?? null;
};

const formatDurationForTerminal = (seconds = 0) => {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const restSeconds = safeSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(restSeconds)}`;
  }
  return `${pad(minutes)}:${pad(restSeconds)}`;
};

const parseTqdmProgressLine = (message = "") => {
  const text = String(message || "").trim();
  const match = text.match(
    /^(?:([^:\r\n]+):\s*)?(\d+)%\|.*\|\s*(\d+)\/(\d+)\s*\[([^<,\]]+)(?:<([^,\]]+))?(?:,\s*([^\]]+))?\]/
  );
  if (!match) {
    return null;
  }

  const [, label, percent, current, total, elapsed, remaining, rate] = match;
  return {
    label: String(label || "").trim(),
    percent: Number(percent),
    current: Number(current),
    total: Number(total),
    baseElapsedSeconds: parseDurationTokenToSeconds(elapsed),
    baseRemainingSeconds: parseDurationTokenToSeconds(remaining),
    rateText: String(rate || "").trim(),
    receivedAtMs: Date.now(),
  };
};

const isCompleteProgressInfo = (progressInfo = {}) =>
  Number(progressInfo.percent) >= 100 ||
  (Number.isFinite(progressInfo.current) &&
    Number.isFinite(progressInfo.total) &&
    Number(progressInfo.total) > 0 &&
    Number(progressInfo.current) >= Number(progressInfo.total));

const buildLiveProgressMessage = (progressInfo = {}, now = Date.now()) => {
  const elapsedDeltaSeconds = Math.max(
    0,
    (Number(now || Date.now()) - Number(progressInfo.receivedAtMs || now)) / 1000
  );
  const elapsedSeconds = Number.isFinite(progressInfo.baseElapsedSeconds)
    ? progressInfo.baseElapsedSeconds + elapsedDeltaSeconds
    : null;
  const remainingSeconds = Number.isFinite(progressInfo.baseRemainingSeconds)
    ? Math.max(0, progressInfo.baseRemainingSeconds - elapsedDeltaSeconds)
    : null;
  const label = formatBackendModelLabel(progressInfo.label);
  const progressText =
    Number.isFinite(progressInfo.current) && Number.isFinite(progressInfo.total)
      ? `${progressInfo.current}/${progressInfo.total}`
      : "";
  const percentText = Number.isFinite(progressInfo.percent) ? `${progressInfo.percent}%` : "";
  const timing = [];
  if (elapsedSeconds !== null) {
    timing.push(`已用 ${formatDurationForTerminal(elapsedSeconds)}`);
  }
  if (remainingSeconds !== null) {
    timing.push(`预计剩余 ${formatDurationForTerminal(remainingSeconds)}`);
  }
  const rateText = progressInfo.rateText
    ? `，平均 ${progressInfo.rateText.replace("/it", "/项")}`
    : "";
  const progressSuffix = [progressText, percentText].filter(Boolean).join("，");

  const actionText = progressInfo.completed || isCompleteProgressInfo(progressInfo)
    ? "处理完成"
    : "正在处理";

  return `${label} ${actionText}${progressSuffix ? `：${progressSuffix}` : ""}${
    timing.length ? `，${timing.join("，")}` : ""
  }${rateText}。`;
};

const getLiveProgressElapsedSeconds = (progressInfo = {}, now = Date.now()) =>
  Number.isFinite(progressInfo.baseElapsedSeconds)
    ? progressInfo.baseElapsedSeconds +
      Math.max(0, (Number(now) - Number(progressInfo.receivedAtMs || now)) / 1000)
    : null;

const getLiveProgressRemainingSeconds = (progressInfo = {}, now = Date.now()) =>
  Number.isFinite(progressInfo.baseRemainingSeconds)
    ? Math.max(
        0,
        progressInfo.baseRemainingSeconds -
          Math.max(0, (Number(now) - Number(progressInfo.receivedAtMs || now)) / 1000)
      )
    : null;

const isSameProgressStep = (left = {}, right = {}) =>
  left &&
  right &&
  left.label === right.label &&
  left.percent === right.percent &&
  left.current === right.current &&
  left.total === right.total;

const mergeLiveProgressInfo = (currentInfo, incomingInfo, now = Date.now()) => {
  if (!currentInfo || !incomingInfo || !isSameProgressStep(currentInfo, incomingInfo)) {
    return incomingInfo;
  }

  const currentElapsed = getLiveProgressElapsedSeconds(currentInfo, now);
  const incomingElapsed = Number.isFinite(incomingInfo.baseElapsedSeconds)
    ? incomingInfo.baseElapsedSeconds
    : null;

  if (currentElapsed === null || incomingElapsed === null || currentElapsed <= incomingElapsed) {
    return incomingInfo;
  }

  const currentRemaining = getLiveProgressRemainingSeconds(currentInfo, now);
  return {
    ...incomingInfo,
    baseElapsedSeconds: currentElapsed,
    baseRemainingSeconds:
      currentRemaining === null ? incomingInfo.baseRemainingSeconds : currentRemaining,
    receivedAtMs: now,
  };
};

const stripBackendLogEnvelope = (message = "") =>
  String(message || "")
    .trim()
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "")
    .replace(
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\|\s+\w+\s+\|\s+[\s\S]*?\s+-\s+/,
      ""
    );

const normalizeBackendLogPayload = (message = "") =>
  stripBackendLogEnvelope(message).replace(/\s*\r?\n\s*/g, " ").trim();

const parseVideoBatchStartLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^\[(batch_[^\]]+)\]\s+start\s+video\s+batch:\s*(\d+)\s*frame\(s\),\s*model=([^,\s]+),\s*batch=(\d+)\/(\d+)/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "video-start",
    batchId: match[1],
    totalFrames: Number(match[2]),
    modelId: String(match[3] || "").trim(),
    batchNumber: Number(match[4]),
    totalBatches: Number(match[5]),
  };
};

const parseVideoBatchFinishLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^\[(batch_[^\]]+)\]\s+finished\s+video\s+batch:\s*model=([^,\s]+),\s*batch=(\d+)\/(\d+),\s*total_frames=(\d+),\s*success=(\d+),\s*failed=(\d+),\s*elapsed=([\d.]+)s/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "video-finish",
    batchId: match[1],
    modelId: String(match[2] || "").trim(),
    batchNumber: Number(match[3]),
    totalBatches: Number(match[4]),
    totalFrames: Number(match[5]),
    successCount: Number(match[6]),
    failedCount: Number(match[7]),
    elapsedSeconds: Number(match[8]),
  };
};

const parseImageBatchFinishLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^Batch processing completed in\s*([\d.]+)s\s*for\s*(\d+)\s*images/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "image-finish",
    modelId: "batch processing",
    totalFrames: Number(match[2]),
    successCount: Number(match[2]),
    failedCount: 0,
    elapsedSeconds: Number(match[1]),
  };
};

const getBackendTerminalLogInfo = (message = "") =>
  parseVideoBatchStartLog(message) ||
  parseVideoBatchFinishLog(message) ||
  parseImageBatchFinishLog(message);

const normalizeBackendTerminalText = (message = "") => {
  const payload = normalizeBackendLogPayload(message);
  const progressInfo = parseTqdmProgressLine(payload);
  if (progressInfo) {
    return buildLiveProgressMessage(progressInfo);
  }

  const startLog = parseVideoBatchStartLog(message);
  if (startLog) {
    return `开始处理视频批次 ${startLog.batchNumber}/${startLog.totalBatches}：共 ${startLog.totalFrames} 帧，模型 ${formatBackendModelLabel(startLog.modelId)}。`;
  }

  const finishLog = parseVideoBatchFinishLog(message);
  if (finishLog) {
    return `视频批次 ${finishLog.batchNumber}/${finishLog.totalBatches} 处理完成：共 ${finishLog.totalFrames} 帧，成功 ${finishLog.successCount} 帧，失败 ${finishLog.failedCount} 帧，用时 ${finishLog.elapsedSeconds} 秒。`;
  }

  const imageFinishLog = parseImageBatchFinishLog(message);
  if (imageFinishLog) {
    return `批量图片处理完成：共 ${imageFinishLog.totalFrames} 张，用时 ${imageFinishLog.elapsedSeconds} 秒。`;
  }

  const metaMatch = payload.match(
    /^\u672c\u6b21\u89c6\u9891\u5904\u7406\u603b\u5171\s*(\d+)\s*\u6279\u6b21\uff0c?\u5f53\u524d\u7b2c\s*(\d+)\s*\u6279/u
  );
  if (metaMatch) {
    return `视频处理进度：当前第 ${metaMatch[2]}/${metaMatch[1]} 批。`;
  }

  return payload.replace(/,\s*outputs=\[[\s\S]*\]\s*$/u, "。");
};

const isProgressMetaLine = (message = "") => {
  const text = String(message || "").trim();
  return (
    /\u672c\u6b21\u89c6\u9891\u5904\u7406\u603b\u5171\s*\d+\s*\u6279\u6b21/u.test(text) &&
    /\u5f53\u524d\u7b2c\s*\d+\s*\u6279/u.test(text) &&
    /\u5f53\u524d\u6279\u6b21\u8fdb\u5ea6\u5982\u4e0b[:\uff1a]?\s*$/u.test(text)
  );
};

const isProgressLine = (message = "") =>
  Boolean(getProgressLineKey(message)) || isProgressMetaLine(message);

const createTerminalLine = (message, type = "info", options = {}) => ({
  message,
  type,
  timestamp: options.timestamp || new Date().toLocaleTimeString(),
  system: Boolean(options.system),
  progressKey: options.progressKey || "",
  progressActive: Boolean(options.progressActive),
  progressInfo: options.progressInfo || null,
  refreshId: ++terminalLineRefreshId,
});

const getProgressLineKeyFromInfo = (progressInfo = {}) =>
  progressInfo ? `progress:${progressInfo.label || "backend"}` : "";

const findActiveProgressLine = (progressKey) => {
  if (!progressKey) {
    return null;
  }

  for (let index = terminalOutput.value.length - 1; index >= 0; index -= 1) {
    const line = terminalOutput.value[index];
    if (line?.progressKey === progressKey && line.progressActive) {
      return line;
    }
  }

  return null;
};

const trimTerminalOutput = () => {
  if (terminalOutput.value.length <= MAX_TERMINAL_LINES) {
    return;
  }

  const maxDataLines = Math.max(1, MAX_TERMINAL_LINES - 1);
  const recentLines = terminalOutput.value
    .filter((line) => !line.system)
    .slice(-maxDataLines);

  terminalOutput.value = [
    createTerminalLine(TERMINAL_TRUNCATION_MESSAGE, "warning", {
      system: true,
      timestamp: "--:--:--",
    }),
    ...recentLines,
  ];

  if (activeTerminalLine && !terminalOutput.value.includes(activeTerminalLine)) {
    activeTerminalLine = null;
  }
};

const getActiveProgressLines = () =>
  terminalOutput.value.filter((line) => line?.progressActive && line.progressInfo);

const clearTerminalProgressHeartbeat = () => {
  if (terminalProgressHeartbeatTimerId) {
    window.clearInterval(terminalProgressHeartbeatTimerId);
    terminalProgressHeartbeatTimerId = 0;
  }
};

const refreshLiveProgressLines = () => {
  const lines = getActiveProgressLines();
  if (lines.length === 0) {
    clearTerminalProgressHeartbeat();
    return;
  }

  const now = Date.now();
  const timestamp = new Date().toLocaleTimeString();
  lines.forEach((line) => {
    line.message = buildLiveProgressMessage(line.progressInfo, now);
    line.timestamp = timestamp;
    line.refreshId = ++terminalLineRefreshId;
  });
};

const ensureTerminalProgressHeartbeat = () => {
  if (terminalProgressHeartbeatTimerId || getActiveProgressLines().length === 0) {
    return;
  }
  terminalProgressHeartbeatTimerId = window.setInterval(
    refreshLiveProgressLines,
    TERMINAL_PROGRESS_HEARTBEAT_MS
  );
};

const syncTerminalProgressHeartbeat = () => {
  if (getActiveProgressLines().length > 0) {
    ensureTerminalProgressHeartbeat();
  } else {
    clearTerminalProgressHeartbeat();
  }
};

const deactivateTerminalProgressLines = () => {
  getActiveProgressLines().forEach((line) => {
    line.progressActive = false;
    line.progressInfo = null;
    line.refreshId = ++terminalLineRefreshId;
  });
};

const completeActiveProgressLine = (completionInfo = {}) => {
  const activeLines = getActiveProgressLines();
  if (activeLines.length === 0) {
    return false;
  }

  const line = activeLines[activeLines.length - 1];
  const previousInfo = line.progressInfo || {};
  const now = Date.now();
  const total = Number(completionInfo.totalFrames || previousInfo.total || 0);
  const elapsedSeconds =
    Number.isFinite(completionInfo.elapsedSeconds) && Number(completionInfo.elapsedSeconds) > 0
      ? Number(completionInfo.elapsedSeconds)
      : getLiveProgressElapsedSeconds(previousInfo, now);
  const completedInfo = {
    ...previousInfo,
    label: previousInfo.label || completionInfo.modelId || "backend",
    percent: 100,
    current: total || previousInfo.current || previousInfo.total || 0,
    total: total || previousInfo.total || previousInfo.current || 0,
    baseElapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : previousInfo.baseElapsedSeconds,
    baseRemainingSeconds: 0,
    rateText: previousInfo.rateText || "",
    receivedAtMs: now,
    completed: true,
  };

  line.message = buildLiveProgressMessage(completedInfo, now);
  line.timestamp = new Date().toLocaleTimeString();
  line.type = "progress-complete";
  line.progressActive = false;
  line.progressInfo = null;
  line.progressKey = line.progressKey || getProgressLineKeyFromInfo(completedInfo);
  line.refreshId = ++terminalLineRefreshId;
  syncTerminalProgressHeartbeat();
  return true;
};

const scrollTerminalToBottom = () => {
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
};

const getTerminalLineClass = (line = {}) => {
  switch (line.type) {
    case "error":
      return "terminal-line--error";
    case "warning":
      return "terminal-line--warning";
    case "success":
      return "terminal-line--success";
    case "progress":
      return "terminal-line--progress";
    case "progress-complete":
      return "terminal-line--progress-complete";
    default:
      return "terminal-line--info";
  }
};

const clearTerminal = () => {
  terminalOutput.value = [];
  activeTerminalLine = null;
  activeVideoBatchProgressContext = null;
  pendingTerminalLogs = [];
  lastTerminalFlushAt = Date.now();
  clearTerminalProgressHeartbeat();
  if (terminalFlushTimerId) {
    window.clearTimeout(terminalFlushTimerId);
    terminalFlushTimerId = 0;
  }
  addTerminalLog("终端已清空", "info");
};

const flushPendingTerminalLogs = () => {
  terminalFlushTimerId = 0;
  if (pendingTerminalLogs.length === 0) {
    return;
  }

  const logs = pendingTerminalLogs;
  pendingTerminalLogs = [];
  lastTerminalFlushAt = Date.now();
  logs.forEach((item) => addTerminalLog(item.message, item.type));
};

const getQueuedTerminalLogType = (item = {}) => {
  const rawText = sanitizeTerminalText(item.message);
  let progressInfo = parseTqdmProgressLine(stripBackendLogEnvelope(rawText));
  const message = normalizeBackendTerminalText(rawText);
  return progressInfo || isProgressLine(message) || item.type === "progress"
    ? "progress"
    : item.type || "info";
};

const scheduleTerminalLogFlush = () => {
  if (pendingTerminalLogs.length === 0) {
    return;
  }

  const now = Date.now();
  const hasPendingProgress = pendingTerminalLogs.some(
    (item) => getQueuedTerminalLogType(item) === "progress"
  );

  if (!hasPendingProgress) {
    flushPendingTerminalLogs();
    return;
  }

  const elapsedSinceFlush = Math.max(0, now - lastTerminalFlushAt);
  const oldestQueuedAt = pendingTerminalLogs.reduce(
    (oldest, item) => Math.min(oldest, Number(item.queuedAt || now)),
    now
  );
  const oldestAge = Math.max(0, now - oldestQueuedAt);

  const minDelay = Math.max(
    0,
    TERMINAL_PROGRESS_SYNC_MIN_MS - elapsedSinceFlush,
    TERMINAL_PROGRESS_SYNC_MIN_MS - oldestAge
  );
  const maxDelay = Math.max(0, TERMINAL_PROGRESS_SYNC_MAX_MS - oldestAge);
  const delay = Math.min(minDelay, maxDelay);

  if (delay === 0) {
    if (terminalFlushTimerId) {
      window.clearTimeout(terminalFlushTimerId);
      terminalFlushTimerId = 0;
    }
    flushPendingTerminalLogs();
    return;
  }

  if (!terminalFlushTimerId) {
    terminalFlushTimerId = window.setTimeout(flushPendingTerminalLogs, delay);
  }
};

const queueTerminalLog = (message, type = "info") => {
  pendingTerminalLogs.push({ message, type, queuedAt: Date.now() });
  scheduleTerminalLogFlush();
};
// IPC 监听器处理后端输出
const handleBackendOutput = (event, data) => {
  queueTerminalLog(data.message, data.type);
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
  const rawText = sanitizeTerminalText(message);
  const cleanText = normalizeBackendTerminalText(rawText);
  if (!cleanText) {
    return;
  }

  const logInfo = getBackendTerminalLogInfo(rawText);
  const isCompletionLog = logInfo?.kind === "video-finish" || logInfo?.kind === "image-finish";
  if (logInfo?.kind === "video-start") {
    activeVideoBatchProgressContext = logInfo;
  }

  let progressInfo = parseTqdmProgressLine(stripBackendLogEnvelope(rawText));
  if (progressInfo && !progressInfo.label && activeVideoBatchProgressContext?.modelId) {
    progressInfo = {
      ...progressInfo,
      label: activeVideoBatchProgressContext.modelId,
    };
  }
  const lineType =
    progressInfo || isProgressLine(cleanText) || type === "progress"
      ? "progress"
      : isCompletionLog
        ? "progress-complete"
        : type;
  const timestamp = new Date().toLocaleTimeString();
  const hasCursorControl = cleanText.includes("\r") || cleanText.includes("\n");
  const getTerminalProgressKey = (text) =>
    getProgressLineKey(text) ||
    getProgressLineKeyFromInfo(progressInfo);

  let buffer = "";
  let shouldOverwriteCurrentLine = false;
  const assignLinePayload = (line, text, progressKey) => {
    const isSameProgressRefresh =
      line.message === text &&
      line.type === lineType &&
      line.progressKey === progressKey &&
      line.progressActive === Boolean(progressKey) &&
      lineType === "progress";
    if (isSameProgressRefresh) {
      line.timestamp = timestamp;
      line.progressInfo = progressInfo;
      line.refreshId = ++terminalLineRefreshId;
      syncTerminalProgressHeartbeat();
      return true;
    }

    if (
      line.message === text &&
      line.type === lineType &&
      line.progressKey === progressKey &&
      line.progressActive === Boolean(progressKey)
    ) {
      return false;
    }

    line.message = text;
    line.type = lineType;
    line.timestamp = timestamp;
    line.progressKey = progressKey;
    line.progressActive = Boolean(progressKey);
    line.progressInfo = progressInfo;
    line.refreshId = ++terminalLineRefreshId;
    syncTerminalProgressHeartbeat();
    return true;
  };

  const writeActiveLine = (text) => {
    const progressKey = getTerminalProgressKey(text);
    const existingProgressLine = findActiveProgressLine(progressKey);
    if (existingProgressLine) {
      progressInfo = mergeLiveProgressInfo(existingProgressLine.progressInfo, progressInfo);
      assignLinePayload(
        existingProgressLine,
        progressInfo ? buildLiveProgressMessage(progressInfo) : text,
        progressKey
      );
      activeTerminalLine = existingProgressLine;
      return;
    }

    if (
      activeTerminalLine &&
      terminalOutput.value.includes(activeTerminalLine) &&
      !activeTerminalLine.system
    ) {
      progressInfo = mergeLiveProgressInfo(activeTerminalLine.progressInfo, progressInfo);
      assignLinePayload(
        activeTerminalLine,
        progressInfo ? buildLiveProgressMessage(progressInfo) : text,
        progressKey
      );
      return;
    }

    activeTerminalLine = createTerminalLine(text, lineType, {
      timestamp,
      progressKey,
      progressActive: Boolean(progressKey),
      progressInfo,
    });
    terminalOutput.value.push(activeTerminalLine);
    syncTerminalProgressHeartbeat();
  };

  const writeFinalLine = (text) => {
    if (isCompletionLog) {
      completeActiveProgressLine(logInfo);
      activeVideoBatchProgressContext =
        logInfo.kind === "video-finish" ? null : activeVideoBatchProgressContext;
    } else if (lineType === "error" || lineType === "warning") {
      deactivateTerminalProgressLines();
    }
    terminalOutput.value.push(createTerminalLine(text, lineType, { timestamp }));
    activeTerminalLine = null;
    syncTerminalProgressHeartbeat();
  };

  const flushBuffer = ({ active = false, finalize = false } = {}) => {
    if (!buffer) {
      if (finalize) {
        if (activeTerminalLine) {
          activeTerminalLine.progressActive = false;
          activeTerminalLine.progressInfo = null;
        }
        activeTerminalLine = null;
        syncTerminalProgressHeartbeat();
      }
      return;
    }

    if (active || shouldOverwriteCurrentLine) {
      writeActiveLine(buffer);
    } else {
      writeFinalLine(buffer);
    }

    buffer = "";
    shouldOverwriteCurrentLine = false;
    if (finalize) {
      if (activeTerminalLine) {
        activeTerminalLine.progressActive = false;
        activeTerminalLine.progressInfo = null;
      }
      activeTerminalLine = null;
      syncTerminalProgressHeartbeat();
    }
    trimTerminalOutput();
  };

  if (!hasCursorControl) {
    if (lineType === "progress") {
      writeActiveLine(cleanText);
    } else {
      writeFinalLine(cleanText);
    }
    trimTerminalOutput();
    scrollTerminalToBottom();
    return;
  }

  for (const char of cleanText.split("\r\n").join("\n")) {
    if (char === "\r") {
      flushBuffer({ active: true });
      shouldOverwriteCurrentLine = true;
      continue;
    }

    if (char === "\n") {
      flushBuffer({ finalize: true });
      continue;
    }

    buffer += char;
  }

  flushBuffer();
  scrollTerminalToBottom();
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

const ensureBackendPathsValid = async ({
  backendProjectPath = backendConfig.projectPath || projectPath.value || "",
  modelDir = backendConfig.modelDir || "",
  modelPath = backendConfig.modelPath || "",
  notify = true,
  log = true,
  blockedMessageBuilder = null,
} = {}) => {
  const validation = await validateBackendPaths({
    backendProjectPath,
    modelDir,
    modelPath,
  });
  if (validation.valid) {
    return true;
  }

  const blockedMessage =
    (typeof blockedMessageBuilder === "function" && blockedMessageBuilder(validation)) ||
    buildBackendPathBlockedMessage(validation);
  if (log) {
    addTerminalLog(blockedMessage, "warning");
  }
  if (notify) {
    $q.notify({
      type: "negative",
      message: blockedMessage,
      position: "top",
      timeout: 6500,
    });
  }
  return false;
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
  if (!result) {
    return;
  }

  if (result.code === "PROJECT_STRUCTURE_INVALID" && result.recoveryHint) {
    addTerminalLog(result.recoveryHint, "warning");
    return;
  }

  if (!["PROJECT_NOT_SELECTED", "PROJECT_PATH_NOT_FOUND"].includes(result.code)) {
    return;
  }

  if (result.defaultProjectParentPath) {
    addTerminalLog(
      `请将 Moonshine 后端项目移动到 ${result.defaultProjectParentPath} 路径下。`,
      "warning"
    );
  } else {
    addTerminalLog("请将 Moonshine 后端项目移动到默认后端目录下。", "warning");
  }

  addTerminalLog(
    "或退出后端管理页面 → 打开全局设置 → 后端设置 → 后端项目路径→ 点击图标选择路径",
    "warning"
  );
};

// 检查环境
const checkEnvironment = async () => {
  const pathsValid = await ensureBackendPathsValid({});
  if (!pathsValid) {
    environmentStatus.error = true;
    currentStep.value = 1;
    return;
  }

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
      const pathsValid = await ensureBackendPathsValid({
        backendProjectPath: selectedPath,
        modelDir: backendConfig.modelDir || "",
        modelPath: backendConfig.modelPath || "",
        blockedMessageBuilder: (validation) =>
          buildBackendPathSelectionBlockedMessage(validation, {
            currentBackendProjectPath:
              backendConfig.projectPath || projectPath.value || configStore.config.general?.backendProjectPath || "",
            currentModelDir: backendConfig.modelDir || configStore.config.general?.modelDir || "",
            currentModelPath: backendConfig.modelPath || configStore.config.general?.modelPath || "",
            selectedBackendProjectPath: selectedPath,
          }),
      });
      if (!pathsValid) {
        return;
      }

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
      const pathsValid = await ensureBackendPathsValid({
        backendProjectPath: backendConfig.projectPath || projectPath.value || "",
        modelDir: selectedPath,
        modelPath: backendConfig.modelPath || "",
        blockedMessageBuilder: (validation) =>
          buildBackendPathSelectionBlockedMessage(validation, {
            currentBackendProjectPath:
              backendConfig.projectPath || projectPath.value || configStore.config.general?.backendProjectPath || "",
            currentModelDir: backendConfig.modelDir || configStore.config.general?.modelDir || "",
            currentModelPath: backendConfig.modelPath || configStore.config.general?.modelPath || "",
            selectedModelDir: selectedPath,
          }),
      });
      if (!pathsValid) {
        return;
      }

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
  const pathsValid = await ensureBackendPathsValid({
    backendProjectPath: backendConfig.projectPath || projectPath.value || "",
    modelDir: backendConfig.modelDir || "",
    modelPath: backendConfig.modelPath || "",
  });
  if (!pathsValid) {
    serviceStatus.value = "stopped";
    serviceStatusText.value = "已停止";
    return;
  }

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
        modelDir: backendConfig.modelDir || backendConfig.modelPath,
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
        addTerminalLog(result.output, "info");
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
  if (typeof window !== "undefined" && window.__MOONSHINE_E2E__ === true) {
    window.__MOONSHINE_BACKEND_MANAGER_TEST__ = {
      addTerminalLog,
      queueTerminalLog,
      flushPendingTerminalLogs,
      getTerminalMessages: () => terminalOutput.value.map((line) => line.message),
      getTerminalLines: () =>
        terminalOutput.value.map((line) => ({
          message: line.message,
          type: line.type,
          progressKey: line.progressKey,
          progressActive: line.progressActive,
          hasProgressInfo: Boolean(line.progressInfo),
          refreshId: line.refreshId,
          timestamp: line.timestamp,
          className: getTerminalLineClass(line),
        })),
      getPendingTerminalCount: () => pendingTerminalLogs.length,
      getFlushIntervalMs: () => TERMINAL_PROGRESS_SYNC_MAX_MS,
      getFlushIntervalRangeMs: () => ({
        min: TERMINAL_PROGRESS_SYNC_MIN_MS,
        max: TERMINAL_PROGRESS_SYNC_MAX_MS,
      }),
      getProgressHeartbeatMs: () => TERMINAL_PROGRESS_HEARTBEAT_MS,
      clearTerminal,
    };
  }
});
onUnmounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.removeListener('backend-output', handleBackendOutput);
  }
  if (typeof window !== "undefined" && window.__MOONSHINE_BACKEND_MANAGER_TEST__) {
    delete window.__MOONSHINE_BACKEND_MANAGER_TEST__;
  }
  if (terminalFlushTimerId) {
    window.clearTimeout(terminalFlushTimerId);
    terminalFlushTimerId = 0;
  }
  clearTerminalProgressHeartbeat();
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
.terminal-line--info {
  color: #ffffff;
}
.terminal-line--error {
  color: #ff6b6b;
}
.terminal-line--warning {
  color: #ffd166;
}
.terminal-line--success {
  color: #4ade80;
}
.terminal-line--progress {
  color: var(--q-accent);
}
.terminal-line--progress-complete {
  color: var(--q-accent);
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
