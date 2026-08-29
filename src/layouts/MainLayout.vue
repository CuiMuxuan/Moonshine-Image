<template>
  <q-layout view="hHh LpR fFf">
    <q-header elevated class="bg-primary text-white main-header" height-hint="98">
      <main-toolbar
        :navigation-disabled="loadingState.showing"
        :theme-mode="configStore.config.ui?.theme || 'light'"
        @route-change="handleRouteChange"
        @toggle-theme="toggleThemeMode"
      >
        <template #backend>
          <q-btn
            flat
            round
            dense
            icon="terminal"
            class="q-mr-sm"
            data-testid="open-backend-manager-button"
            @click="showBackendManager = true"
          >
            <q-tooltip>服务管理</q-tooltip>
          </q-btn>
        </template>

        <template #settings>
          <q-btn
            flat
            round
            dense
            icon="settings"
            class="q-mr-sm"
            data-testid="open-global-settings-button"
            @click="handleSettingsButtonClick"
          >
            <q-badge
              v-if="showUpdateSettingsBadge"
              floating
              rounded
              :color="updateSettingsBadgeColor"
              class="update-settings-badge"
              data-testid="app-update-settings-badge"
              aria-label="应用更新待处理"
            >
              <q-icon name="system_update_alt" size="10px" />
            </q-badge>
            <q-tooltip>{{ updateSettingsTooltip }}</q-tooltip>
          </q-btn>
        </template>
      </main-toolbar>
    </q-header>

    <component
      :is="pageLeftDrawerComponent"
      v-if="pageLeftDrawerComponent"
      v-bind="pageLeftDrawerProps"
      v-on="pageLeftDrawerListeners"
      :class="pageLeftDrawerClass"
    />

    <component
      :is="pageRightDrawerComponent"
      v-if="pageRightDrawerComponent"
      v-bind="pageRightDrawerProps"
      v-on="pageRightDrawerListeners"
      :class="pageRightDrawerClass"
    />

    <q-page-container class="main-page-container">
      <div class="page-content-shell">
        <router-view :backend-running="backendRunning" @update:loading="handleLoadingUpdate" />

        <q-inner-loading
          :showing="loadingState.showing"
          class="global-loading"
          data-testid="global-loading-overlay"
        >
          <div class="global-loading-content">
            <div
              class="global-loading-logo-shell global-loading-pulse"
              data-testid="global-loading-pulse"
              aria-hidden="true"
            >
              <img class="global-loading-logo" :src="globalLoadingLogo" alt="" />
            </div>
            <span class="global-loading-message text-h6 text-primary text-center">
              {{ loadingState.message }}
            </span>
            <q-linear-progress
              v-if="typeof loadingState.progress === 'number'"
              :value="loadingState.progress"
              color="primary"
              size="10px"
              class="global-loading-progress"
            />
            <q-btn
              v-if="loadingState.actionLabel"
              outline
              color="primary"
              icon="terminal"
              :label="loadingState.actionLabel"
              no-caps
              class="global-loading-action"
              @click="loadingState.onAction?.()"
            />
          </div>
        </q-inner-loading>
      </div>
    </q-page-container>

    <q-footer v-if="pageFooterComponent" class="layout-page-footer" :height-hint="60">
      <component
        :is="pageFooterComponent"
        v-bind="pageFooterProps"
        v-on="pageFooterListeners"
        :class="pageFooterClass"
      />
    </q-footer>
  </q-layout>

  <backend-manager v-model="showBackendManager" />
  <global-settings
    v-model="showSettings"
    :initial-tab="settingsTarget.tab"
    :initial-model-id="settingsTarget.modelId"
    :initial-mcp-tab="settingsTarget.mcpTab"
    :navigation-key="settingsTarget.navigationKey"
    :backend-running="backendRunning"
    @open-backend-manager="showBackendManager = true"
    @model-downloaded="handleModelDownloaded"
  />
  <q-dialog
    :model-value="runtimePreparationVisible"
    transition-show="scale"
    transition-hide="fade"
    :transition-duration="180"
    data-testid="runtime-preparation-dialog"
    @update:model-value="handleRuntimeOnboardingModelValue"
  >
    <q-card class="runtime-onboarding-card">
      <q-card-section class="runtime-onboarding-header">
        <div class="runtime-onboarding-icon" aria-hidden="true">
          <q-icon name="settings_suggest" size="26px" />
        </div>
        <div class="runtime-onboarding-heading">
          <div class="text-h6 text-weight-medium">配置本地运行环境</div>
          <div class="text-caption text-grey-7">首次使用前只需配置一次</div>
        </div>
        <q-space />
        <q-btn
          flat
          round
          dense
          icon="close"
          aria-label="暂不配置运行环境"
          data-testid="runtime-preparation-close"
          @click="dismissRuntimeOnboarding"
        />
      </q-card-section>
      <q-separator />
      <q-card-section class="runtime-onboarding-content">
        <div class="text-body2 runtime-onboarding-copy">
          图片和视频处理需要本机 Python、PyTorch 与 FFmpeg 运行环境。你可以现在进入服务管理完成创建，也可以稍后再配置。
        </div>
        <div
          class="runtime-onboarding-status"
          :class="{ 'runtime-onboarding-status--error': updateManager.runtimeState.status === 'failed' }"
        >
          <q-icon
            :name="updateManager.runtimeState.status === 'failed' ? 'report_problem' : 'info'"
            size="20px"
          />
          <div class="runtime-onboarding-status-copy">
            <div class="text-body2 text-weight-medium">{{ updateManager.runtimeStatusLabel }}</div>
            <div class="text-caption text-grey-7">
              {{ updateManager.runtimeState.error?.message || "完成配置前，AI 服务不会自动启动。" }}
            </div>
          </div>
        </div>
      </q-card-section>
      <q-card-actions align="right" class="runtime-onboarding-actions">
        <q-btn
          flat
          no-caps
          icon="schedule"
          label="暂不配置"
          data-testid="runtime-preparation-defer"
          @click="dismissRuntimeOnboarding"
        />
        <q-btn
          unelevated
          no-caps
          color="primary"
          icon="tune"
          label="引导配置"
          data-testid="runtime-preparation-guide"
          @click="openRuntimeOnboardingGuide"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
  <startup-overlay
    :model-value="showStartupOverlay"
    @update:model-value="handleStartupOverlayVisibilityRequest"
    @finished="handleStartupOverlayFinished"
  />
</template>

<script setup>
import { setCssVar, useQuasar } from "quasar";
import {
  computed,
  markRaw,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useRouter } from "vue-router";

import { api } from "src/boot/axios";
import BackendManager from "src/components/global/BackendManager.vue";
import GlobalSettings from "src/components/global/GlobalSettings.vue";
import MainToolbar from "src/components/global/MainToolbar.vue";
import StartupOverlay from "src/components/global/StartupOverlay.vue";
import { DEFAULT_BRAND_COLORS, normalizeThemeMode } from "src/config/ConfigManager";
import { classifyMoonshineError } from "src/services/ErrorClassifier";
import { useAppStateStore } from "src/stores/appState";
import { useBackendEngineStore } from "src/stores/backendEngine";
import { useConfigStore } from "src/stores/config";
import { useFileManagerStore } from "src/stores/fileManager";
import { useModelRegistryStore } from "src/stores/modelRegistry";
import { useRuntimeDiagnosticsStore } from "src/stores/runtimeDiagnostics";
import { useUpdateManagerStore } from "src/stores/updateManager";
import {
  BACKEND_PATH_CJK_WARNING_MESSAGE,
  buildBackendPathBlockedMessage,
  buildBackendPathWarningMessage,
  validateBackendPathsForConfig,
} from "src/utils/backendPathValidation";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const backendEngineStore = useBackendEngineStore();
const fileManagerStore = useFileManagerStore();
const modelRegistryStore = useModelRegistryStore();
const runtimeDiagnosticsStore = useRuntimeDiagnosticsStore();
const updateManager = useUpdateManagerStore();
const globalLoadingLogo = resolvePublicAssetPath("icons/cmx-logo256.png");

const showBackendManager = ref(false);
const showSettings = ref(false);
const settingsTarget = ref({
  tab: "",
  modelId: "",
  mcpTab: "settings",
  navigationKey: 0,
});
const backendRunning = computed(() => backendEngineStore.isRunning);
const startupExperienceFinished = ref(false);
const runtimeOnboardingDismissed = ref(false);
const runtimeEnvironmentNeedsAttention = computed(() =>
  ["needs-create", "needs-repair", "needs-download", "failed"].includes(
    updateManager.runtimeState.status
  )
);
const runtimePreparationVisible = computed(() =>
  startupExperienceFinished.value &&
  updateManager.initialized &&
  !runtimeOnboardingDismissed.value &&
  !showSettings.value &&
  !backendRunning.value &&
  runtimeEnvironmentNeedsAttention.value
);
const showStartupOverlay = ref(false);
const runtimeE2EFlag =
  typeof window !== "undefined" && window.__MOONSHINE_E2E__ === true;
const isE2EMode = import.meta.env.VITE_MOONSHINE_E2E === "1" || runtimeE2EFlag;
const pendingBackendPathNotice = ref(null);
const cudaDiagnosticNotificationKey = ref("");
const backendSessionStartedAt = ref(0);
const startupOverlayFinished = ref(false);
const startupFlowPending = ref(false);
const startupFlowResult = ref(null);
const startupFailureNotified = ref(false);
let removeBackendServiceStateListener = null;
let removeTrayNavigationListener = null;
let removeMcpOpenArtifactListener = null;
const notifiedUpdateStates = new Set();

const loadingState = ref({
  showing: false,
  message: "",
  progress: null,
});
const pageFooterOwner = ref(null);
const pageFooterProps = ref({});
const pageFooterListeners = ref({});
const pageFooterClass = ref("");
const pageFooterComponent = shallowRef(null);
const pageLeftDrawerOwner = ref(null);
const pageLeftDrawerProps = ref({});
const pageLeftDrawerListeners = ref({});
const pageLeftDrawerClass = ref("");
const pageLeftDrawerComponent = shallowRef(null);
const pageRightDrawerOwner = ref(null);
const pageRightDrawerProps = ref({});
const pageRightDrawerListeners = ref({});
const pageRightDrawerClass = ref("");
const pageRightDrawerComponent = shallowRef(null);

const resetPageFooter = () => {
  pageFooterOwner.value = null;
  pageFooterProps.value = {};
  pageFooterListeners.value = {};
  pageFooterClass.value = "";
  pageFooterComponent.value = null;
};

const resetPageDrawer = (side) => {
  if (side === "left") {
    pageLeftDrawerOwner.value = null;
    pageLeftDrawerProps.value = {};
    pageLeftDrawerListeners.value = {};
    pageLeftDrawerClass.value = "";
    pageLeftDrawerComponent.value = null;
    return;
  }

  if (side === "right") {
    pageRightDrawerOwner.value = null;
    pageRightDrawerProps.value = {};
    pageRightDrawerListeners.value = {};
    pageRightDrawerClass.value = "";
    pageRightDrawerComponent.value = null;
  }
};

const setPageFooter = ({
  owner = Symbol("page-footer"),
  component = null,
  props = {},
  listeners = {},
  className = "",
} = {}) => {
  if (!component) {
    resetPageFooter();
    return owner;
  }

  pageFooterOwner.value = owner;
  pageFooterProps.value = props;
  pageFooterListeners.value = listeners;
  pageFooterClass.value = className;
  pageFooterComponent.value = markRaw(component);
  return owner;
};

const clearPageFooter = (owner = null) => {
  if (owner !== null && pageFooterOwner.value !== owner) {
    return;
  }

  resetPageFooter();
};

const setPageDrawer = ({
  side,
  owner = Symbol("page-drawer"),
  component = null,
  props = {},
  listeners = {},
  className = "",
} = {}) => {
  if (!side) {
    return owner;
  }

  if (!component) {
    resetPageDrawer(side);
    return owner;
  }

  if (side === "left") {
    pageLeftDrawerOwner.value = owner;
    pageLeftDrawerProps.value = props;
    pageLeftDrawerListeners.value = listeners;
    pageLeftDrawerClass.value = className;
    pageLeftDrawerComponent.value = markRaw(component);
    return owner;
  }

  if (side === "right") {
    pageRightDrawerOwner.value = owner;
    pageRightDrawerProps.value = props;
    pageRightDrawerListeners.value = listeners;
    pageRightDrawerClass.value = className;
    pageRightDrawerComponent.value = markRaw(component);
  }

  return owner;
};

const clearPageDrawer = (side, owner = null) => {
  if (side === "left") {
    if (owner !== null && pageLeftDrawerOwner.value !== owner) {
      return;
    }
    resetPageDrawer("left");
    return;
  }

  if (side === "right") {
    if (owner !== null && pageRightDrawerOwner.value !== owner) {
      return;
    }
    resetPageDrawer("right");
  }
};

const normalizeLoadingEllipsis = (message = "") =>
  String(message || "").replace(
    /(?:。+|…+|\.{2,})[^\S\r\n]*(?=\r?\n|$)/g,
    "…"
  );

const normalizeLoadingMessage = (message = "") =>
  normalizeLoadingEllipsis(
    String(message || "").replace(
      /\s*，?\s*可打开(?:后端|服务)管理页面查看进度/g,
      "\n可打开服务管理页面查看进度"
    )
  );

const normalizeLoadingPayload = (messageOrOptions, progressArg = null) => {
  if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
    return {
      message: messageOrOptions.message || "加载中...",
      progress:
        typeof messageOrOptions.progress === "number" ? messageOrOptions.progress : null,
      actionLabel: String(messageOrOptions.actionLabel || "").trim(),
      onAction:
        typeof messageOrOptions.onAction === "function" ? messageOrOptions.onAction : null,
    };
  }

  return {
    message: messageOrOptions || "加载中...",
    progress: typeof progressArg === "number" ? progressArg : null,
    actionLabel: "",
    onAction: null,
  };
};

const normalizeBackendHintBreak = (message = "") =>
  normalizeLoadingEllipsis(
    normalizeLoadingMessage(message).replace(
      /\s*[\uFF0C,]?\s*\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6/g,
      "\n\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6"
    )
  );

const openBackendDiagnostics = () => {
  showBackendManager.value = true;
};

const openExternalUrl = async (url) => {
  if (!url) return false;
  try {
    if (window.electron?.openExternal) {
      return Boolean(await window.electron.openExternal(url));
    }
    return Boolean(window.open(url, "_blank", "noopener,noreferrer"));
  } catch (error) {
    console.error("Failed to open external link:", error);
    return false;
  }
};

const maybeNotifyCudaDiagnostic = (cudaInfo = {}) => {
  const level = cudaInfo?.notification_level;
  if (!level || cudaInfo?.torch_package === "cpu") return;
  const port = configStore.config.general?.backendPort || "unknown";
  const code = cudaInfo?.diagnostic_code || level;
  const key = `${port}:${code}`;
  if (cudaDiagnosticNotificationKey.value === key) return;
  cudaDiagnosticNotificationKey.value = key;
  const links = Array.isArray(cudaInfo.notification_links)
    ? cudaInfo.notification_links
    : [];
  $q.notify({
    type: level === "negative" ? "negative" : "warning",
    message: cudaInfo.notification_message || cudaInfo.message || "CUDA 诊断提示",
    caption: cudaInfo.notification_title || "",
    position: "top",
    timeout: 9000,
    actions: [
      ...links.map((link) => ({
        label: link.label,
        color: "white",
        handler: () => openExternalUrl(link.url),
      })),
      { label: "关闭", color: "white" },
    ],
  });
};

const getBackendSessionKey = () => {
  const general = configStore.config.general || {};
  return [
    general.backendPort || "8080",
    general.launchMode || "cuda",
    backendSessionStartedAt.value || "existing",
  ].join(":");
};

const refreshCudaDiagnostics = async ({ force = false, notify = true } = {}) => {
  const sessionKey = getBackendSessionKey();
  if (!force && runtimeDiagnosticsStore.getCudaStatusMatchesSession(sessionKey)) {
    return runtimeDiagnosticsStore.cudaStatus;
  }

  runtimeDiagnosticsStore.setCudaRefreshing(sessionKey);
  const cudaInfo = await api.get("/api/v1/check_cuda");
  const nextStatus = runtimeDiagnosticsStore.setCudaStatus(cudaInfo, sessionKey);
  if (notify) {
    maybeNotifyCudaDiagnostic(cudaInfo);
  }
  return nextStatus;
};

const openGlobalSettings = ({ tab = "", modelId = "", mcpTab = "settings" } = {}) => {
  settingsTarget.value = {
    tab,
    modelId,
    mcpTab,
    navigationKey: settingsTarget.value.navigationKey + 1,
  };
  showSettings.value = true;
};

const dismissRuntimeOnboarding = () => {
  runtimeOnboardingDismissed.value = true;
};

const handleRuntimeOnboardingModelValue = (visible) => {
  if (!visible) dismissRuntimeOnboarding();
};

const openRuntimeOnboardingGuide = () => {
  dismissRuntimeOnboarding();
  showBackendManager.value = true;
};

const showUpdateSettingsBadge = computed(() =>
  ["available", "downloaded"].includes(updateManager.state.status) ||
  ["needs-create", "needs-repair", "needs-download", "failed"].includes(updateManager.runtimeState.status)
);
const updateSettingsBadgeColor = computed(() =>
  updateManager.state.status === "downloaded" ? "positive" :
    updateManager.runtimeState.status === "failed" ? "negative" : "warning"
);
const updateSettingsTooltip = computed(() => {
  if (updateManager.state.status === "downloaded") return "更新已下载，打开应用更新";
  if (updateManager.state.status === "available") return "发现可用更新，打开应用更新";
  if (["needs-create", "needs-download"].includes(updateManager.runtimeState.status)) return "运行环境尚未创建，打开服务管理准备环境";
  if (updateManager.runtimeState.status === "needs-repair") return "运行环境需要修复，打开服务管理处理";
  if (updateManager.runtimeState.status === "failed") return "运行环境操作失败，打开服务管理重试";
  return "全局设置";
});

const handleSettingsButtonClick = () => {
  const appUpdatePending = ["available", "downloaded"].includes(updateManager.state.status);
  if (appUpdatePending) {
    openGlobalSettings({ tab: "updates" });
    return;
  }
  if (runtimeEnvironmentNeedsAttention.value) {
    showBackendManager.value = true;
    return;
  }
  openGlobalSettings();
};

const notifyAppUpdateState = (status, version) => {
  if (!["available", "downloaded"].includes(status)) return;
  const notificationKey = `${status}:${version || "unknown"}`;
  if (notifiedUpdateStates.has(notificationKey)) return;
  notifiedUpdateStates.add(notificationKey);

  const downloaded = status === "downloaded";
  $q.notify({
    type: downloaded ? "positive" : "info",
    message: downloaded
      ? version
        ? `版本 ${version} 已下载，可以重启安装。`
        : "更新已下载，可以重启安装。"
      : version
        ? `发现稳定版 ${version}。`
        : "发现可用的稳定版更新。",
    position: "top",
    timeout: downloaded ? 10_000 : 8_000,
    actions: [
      {
        label: downloaded ? "安装" : "查看",
        color: "white",
        handler: () => openGlobalSettings({ tab: "updates" }),
      },
    ],
  });
};

const handleModelDownloaded = (modelId) => {
  window.dispatchEvent(
    new CustomEvent("moonshine-model-registry-updated", {
      detail: { modelId },
    })
  );

  $q.dialog({
    title: "模型下载完成",
    message: "是否切换到刚下载的模型？",
    cancel: {
      label: "暂不切换",
      flat: true,
    },
    ok: {
      label: "切换",
      color: "primary",
    },
  }).onOk(() => {
    window.dispatchEvent(
      new CustomEvent("moonshine-switch-model", {
        detail: { modelId },
      })
    );
  });
};

const backendEngineContext = computed(() => ({
  status: backendEngineStore.status,
  phase: backendEngineStore.phase,
  diagnostic: backendEngineStore.diagnostic,
  recoveryHint: backendEngineStore.recoveryHint,
  port: backendEngineStore.port,
  phaseLabel: backendEngineStore.phaseLabel,
  isRunning: backendEngineStore.isRunning,
  isPreparing: backendEngineStore.isPreparing,
  isBusy: backendEngineStore.isBusy,
  hasFailed: backendEngineStore.hasFailed,
  runDisabled: backendEngineStore.runDisabled,
  runDisabledTooltip: backendEngineStore.runDisabledTooltip,
  start: startBackendService,
  stop: stopBackendService,
  restart: restartBackendService,
  refresh: refreshBackendServiceStatus,
  openDiagnostics: openBackendDiagnostics,
}));

provide("backendRunning", backendRunning);
provide("backendEngine", backendEngineContext);
provide("globalLoadingState", loadingState);
provide("globalSettings", {
  open: openGlobalSettings,
});
provide("runtimeDiagnostics", {
  refreshCudaDiagnostics,
  getBackendSessionKey,
});
provide("layoutFooter", {
  setPageFooter,
  clearPageFooter,
});
provide("layoutDrawers", {
  setPageDrawer,
  clearPageDrawer,
});
provide("loadingControl", {
  show: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
      actionLabel: payload.actionLabel,
      onAction: payload.onAction,
    };
  },
  update: (messageOrOptions, progress) => {
    const payload = normalizeLoadingPayload(messageOrOptions, progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
      actionLabel: payload.actionLabel,
      onAction: payload.onAction,
    };
  },
  hide: () => {
    loadingState.value = {
      showing: false,
      message: "",
      progress: null,
      actionLabel: "",
      onAction: null,
    };
  },
});

const handleLoadingUpdate = (state) => {
  if (state.show) {
    const payload = normalizeLoadingPayload(state.message || state, state.progress);
    loadingState.value = {
      showing: true,
      message: normalizeBackendHintBreak(payload.message),
      progress: payload.progress,
      actionLabel: payload.actionLabel,
      onAction: payload.onAction,
    };
    return;
  }

  loadingState.value = {
    showing: false,
    message: "",
    progress: null,
    actionLabel: "",
    onAction: null,
  };
};

const probeBackendHealth = async () => {
  const health = await api.get(
    "/api/v1/health",
    { _: Date.now() },
    {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    }
  );
  if (health?.status !== "ok") {
    throw new Error("服务健康检查返回了无效响应");
  }
  return health;
};

const clearBackendSession = (reason = "服务未启动") => {
  backendSessionStartedAt.value = 0;
  cudaDiagnosticNotificationKey.value = "";
  runtimeDiagnosticsStore.setCudaUnavailable(reason);
  // A stopped backend cannot retain an in-memory model; force the next run to
  // revalidate and load the selected model instead of reusing stale readiness.
  modelRegistryStore.invalidatePreparedModels();
};

const handleBackendServiceState = (eventOrPayload, maybePayload) => {
  const payload = maybePayload ?? eventOrPayload;
  if (!payload || typeof payload !== "object") return;

  backendEngineStore.applyServiceEvent(payload);
  if (payload.port) {
    void syncBackendRuntimePort(payload.port);
  }

  if (payload.state === "running" && payload.ready !== false) {
    backendSessionStartedAt.value = payload.readyAt || Date.now();
    return;
  }

  if (payload.state === "stopped" || payload.state === "failed") {
    clearBackendSession(
      payload.state === "failed" ? "服务异常退出" : "服务未启动"
    );
  }
};

const checkBackendStatus = async ({ notifyOnFailure = true } = {}) => {
  let processStatus = null;
  try {
    const invoke = getElectronInvoke();
    if (invoke) {
      processStatus = await invoke("check-backend-status");
      if (processStatus?.success === false) {
        const statusError = new Error(processStatus.error || "无法读取服务进程状态");
        Object.assign(statusError, processStatus);
        throw statusError;
      }
      if (processStatus?.success) {
        backendEngineStore.applyServiceEvent(processStatus);
        if (processStatus.port) {
          await syncBackendRuntimePort(processStatus.port);
        }
        if (
          processStatus.running !== true &&
          processStatus.ready !== true &&
          processStatus.processRunning !== true
        ) {
          throw new Error("服务未启动");
        }
      }
    }

    await probeBackendHealth();
    backendSessionStartedAt.value =
      processStatus?.readyAt || backendSessionStartedAt.value || Date.now();
    backendEngineStore.setRunning({
      ...processStatus,
      ready: true,
      processRunning: true,
      port: processStatus?.port || configStore.config.general?.backendPort,
    });

    try {
      await refreshCudaDiagnostics({ notify: true });
    } catch (cudaError) {
      console.warn("CUDA diagnostics unavailable while backend is healthy:", cudaError);
      runtimeDiagnosticsStore.setCudaUnavailable("CUDA 诊断暂不可用");
    }
    return true;
  } catch (error) {
    if (processStatus?.state === "failed") {
      backendEngineStore.setFailed(processStatus);
      clearBackendSession("服务异常退出");
    } else if (processStatus?.processRunning) {
      backendEngineStore.setPreparing("verifying", processStatus);
    } else {
      backendEngineStore.setStopped(processStatus || {});
      clearBackendSession("服务未启动");
    }
    if (notifyOnFailure) {
      const classifiedError = classifyMoonshineError(error, "服务未启动");
      $q.notify({
        type: "warning",
        message: classifiedError.message,
        position: "top",
        timeout: 5000,
        actions: [
          {
            label: "启动服务",
            color: "white",
            handler: openBackendDiagnostics,
          },
        ],
      });
    }
    return false;
  }
};

const showBackendPathNotice = (validationResult = null) => {
  if (validationResult?.warning) {
    $q.notify({
      type: "warning",
      message: buildBackendPathWarningMessage(validationResult),
      position: "top",
      timeout: 10000,
      multiLine: true,
    });
    return;
  }

  $q.dialog({
    title: "路径配置异常",
    message: buildBackendPathBlockedMessage(validationResult),
    ok: {
      label: "知道了",
      color: "primary",
      unelevated: true,
    },
    persistent: true,
  });
};

const flushPendingBackendPathNotice = () => {
  if (!pendingBackendPathNotice.value) {
    return;
  }

  const payload = pendingBackendPathNotice.value;
  pendingBackendPathNotice.value = null;
  showBackendPathNotice(payload);
};

const queueBackendPathNotice = (validationResult = null) => {
  if (showStartupOverlay.value) {
    pendingBackendPathNotice.value = validationResult || {};
    return;
  }

  showBackendPathNotice(validationResult);
};

const getElectronInvoke = () => window.electron?.ipcRenderer?.invoke;

const syncBackendRuntimePort = async (port) => {
  const normalizedPort = Number(port);
  if (
    !Number.isInteger(normalizedPort) ||
    normalizedPort < 1024 ||
    normalizedPort > 65535
  ) {
    return false;
  }

  api.updateConfig({
    general: {
      backendPort: normalizedPort,
    },
  });

  if (configStore.config.general?.backendPort === normalizedPort) {
    return true;
  }

  const result = await configStore.persistConfig({
    ...configStore.config,
    general: {
      ...(configStore.config.general || {}),
      backendPort: normalizedPort,
    },
  });

  if (!result?.success) {
    console.warn("Failed to sync runtime backend port:", result?.error || result?.errors);
    return false;
  }

  return true;
};

const normalizeBackendFailure = (value, fallback) => ({
  success: false,
  code: value?.code || value?.diagnostic?.code || "BACKEND_OPERATION_FAILED",
  error: value?.error || value?.message || fallback,
  recoveryHint: value?.recoveryHint || "",
  diagnostic: value?.diagnostic || null,
});

const throwBackendFailure = (value, fallback) => {
  const failure = normalizeBackendFailure(value, fallback);
  const error = new Error(failure.error);
  Object.assign(error, failure);
  throw error;
};

const ensureDefaultModelReady = async (modelId = "") => {
  const normalizedModelId = String(
    modelId || configStore.config.general?.defaultModel || "lama"
  ).trim();
  if (!normalizedModelId) return { success: true };

  backendEngineStore.setPhase("loadingModel");
  try {
    const readiness = await modelRegistryStore.ensureModelReady(normalizedModelId);
    return {
      success: true,
      modelId: normalizedModelId,
      readiness,
    };
  } catch (error) {
    const failure = normalizeBackendFailure(
      error,
      `默认模型 ${normalizedModelId} 校验或加载失败`
    );
    return {
      ...failure,
      code: failure.code || "DEFAULT_MODEL_PREPARATION_FAILED",
      modelId: normalizedModelId,
    };
  }
};

const startBackendService = async (options = {}, lifecycle = {}) => {
  const invoke = getElectronInvoke();
  if (!invoke) {
    const failure = normalizeBackendFailure(null, "当前环境无法启动服务");
    backendEngineStore.setFailed(failure);
    return failure;
  }

  backendEngineStore.setPreparing("startingEngine");
  try {
    const result = await invoke("start-backend-service", options);
    if (!result?.success) {
      const failure = normalizeBackendFailure(result, "AI 引擎启动失败");
      backendEngineStore.setFailed(failure);
      return failure;
    }

    const actualPort = result.port || options.port || 8080;
    await syncBackendRuntimePort(actualPort);
    backendSessionStartedAt.value = result.readyAt || Date.now();
    backendEngineStore.setRunning({
      ...result,
      port: actualPort,
      processRunning: true,
      ready: true,
    });

    lifecycle.onHealthCheckStart?.();
    const healthy = await checkBackendStatus({ notifyOnFailure: false });
    if (!healthy) {
      const failure = normalizeBackendFailure(result, "AI 引擎启动后健康检查失败");
      backendEngineStore.setFailed({
        ...failure,
        processRunning: backendEngineStore.processRunning,
      });
      return failure;
    }
    const modelResult = await ensureDefaultModelReady(
      options.model || configStore.config.general?.defaultModel || "lama"
    );
    if (!modelResult.success) {
      backendEngineStore.setFailed({
        ...modelResult,
        processRunning: backendEngineStore.processRunning,
      });
      return modelResult;
    }
    backendEngineStore.setRunning({
      ...result,
      port: actualPort,
      processRunning: true,
      ready: true,
    });
    return {
      ...result,
      success: true,
      port: actualPort,
      ready: true,
      model: modelResult.modelId,
    };
  } catch (error) {
    const failure = normalizeBackendFailure(error, "AI 引擎启动失败");
    backendEngineStore.setFailed(failure);
    return failure;
  }
};

const refreshBackendServiceStatus = (options = {}) => checkBackendStatus(options);

const stopBackendService = async () => {
  const invoke = getElectronInvoke();
  if (!invoke) {
    const failure = normalizeBackendFailure(null, "当前环境无法停止服务");
    backendEngineStore.setFailed(failure);
    return failure;
  }

  backendEngineStore.setStopping({
    processRunning: backendEngineStore.processRunning,
  });
  try {
    const result = await invoke("stop-backend-service");
    if (backendEngineStore.applyStopResult(result)) {
      clearBackendSession("服务未启动");
      return result;
    }

    await checkBackendStatus({ notifyOnFailure: false });
    if (backendEngineStore.status === "stopping") {
      backendEngineStore.setFailed(
        normalizeBackendFailure(result, "停止服务失败")
      );
    }
    return normalizeBackendFailure(result, "停止服务失败");
  } catch (error) {
    await checkBackendStatus({ notifyOnFailure: false });
    if (backendEngineStore.status === "stopping") {
      backendEngineStore.setFailed(
        normalizeBackendFailure(error, "停止服务失败")
      );
    }
    return normalizeBackendFailure(error, "停止服务失败");
  }
};

const restartBackendService = async (options = {}) => {
  const stopResult = await stopBackendService();
  if (!stopResult?.success && backendEngineStore.processRunning) {
    return stopResult;
  }
  return await startBackendService(options);
};

const prepareBackendEngine = async () => {
  const invoke = getElectronInvoke();
  if (!invoke) {
    const reachable = await checkBackendStatus({ notifyOnFailure: false });
    if (!reachable) backendEngineStore.setStopped();
    return {
      success: reachable,
      skipped: true,
      code: reachable ? null : "BACKEND_IPC_UNAVAILABLE",
      error: reachable ? null : "当前环境无法连接 AI 服务。",
    };
  }

  if (configStore.config.general?.autoStart === false) {
    const reachable = await checkBackendStatus({ notifyOnFailure: false });
    if (!reachable) backendEngineStore.setStopped();
    return { success: reachable, skipped: true };
  }

  backendEngineStore.setPreparing("preparing");

  try {
    const backendPathValidation = await validateBackendPathsForConfig(
      configStore.config.general || {}
    );
    if (!backendPathValidation.valid) {
      const failure = normalizeBackendFailure(
        {
          ...backendPathValidation,
          code: backendPathValidation.code || "BACKEND_PATH_INVALID",
          error: backendPathValidation.message || BACKEND_PATH_CJK_WARNING_MESSAGE,
        },
        "服务路径配置异常"
      );
      backendEngineStore.setFailed(failure);
      queueBackendPathNotice(backendPathValidation);
      return failure;
    }
    if (backendPathValidation.warning) {
      queueBackendPathNotice(backendPathValidation);
    }

    const processStatus = await invoke("check-backend-status");
    if (processStatus?.success && processStatus.running) {
      backendEngineStore.applyServiceEvent(processStatus);
      await syncBackendRuntimePort(processStatus.port);
      if (!backendSessionStartedAt.value) {
        backendSessionStartedAt.value = Date.now();
      }
      backendEngineStore.setPhase("verifying");
      const reachable = await checkBackendStatus({ notifyOnFailure: false });
      if (!reachable) {
        throw new Error("Moonshine AI 引擎进程存在，但接口未响应");
      }
      const modelResult = await ensureDefaultModelReady(
        configStore.config.general?.defaultModel || "lama"
      );
      if (!modelResult.success) {
        backendEngineStore.setFailed({
          ...modelResult,
          processRunning: backendEngineStore.processRunning,
        });
        return modelResult;
      }
      backendEngineStore.setRunning({ ...processStatus, ready: true, processRunning: true });
      return { success: true, reused: true, model: modelResult.modelId };
    }

    backendEngineStore.setPhase("checkingRuntime");
    const projectResult = await invoke(
      "check-project",
      configStore.config.general?.backendProjectPath || ""
    );
    if (!projectResult?.success) {
      throwBackendFailure(projectResult, "服务项目检测失败");
    }

    const runtimeState = updateManager.runtimeState;
    const usesManagedEnvironment =
      runtimeState.enabled &&
      runtimeState.source !== "external";
    const usesExternalEnvironment =
      runtimeState.enabled && runtimeState.source === "external";
    if (usesManagedEnvironment) {
      const runtimeCheck = await updateManager.checkRuntime({
        accelerator:
          updateManager.runtimeState.preference ||
          updateManager.runtimeState.selectedAccelerator ||
          "auto",
      });
      const runtimeState = runtimeCheck?.state || updateManager.runtimeState;
      if (
        !runtimeCheck?.success ||
        !["ready", "degraded"].includes(runtimeState.status) ||
        !["ready", "degraded"].includes(updateManager.runtimeState.status)
      ) {
        backendEngineStore.setStopped();
        return {
          success: false,
          requiresEnvironmentSetup: true,
          code: runtimeCheck?.code || "RUNTIME_NOT_READY",
          error:
            runtimeCheck?.error?.message ||
            runtimeCheck?.error ||
            runtimeCheck?.reason ||
            "运行环境尚未就绪，请打开服务管理完成配置。",
          state: runtimeCheck?.state || updateManager.runtimeState,
        };
      }
    } else {
      if (usesExternalEnvironment) {
        const runtimeCheck = await updateManager.checkRuntime({
          accelerator:
            updateManager.runtimeState.preference ||
            updateManager.runtimeState.selectedAccelerator ||
            "auto",
        });
        const checkedRuntimeState = runtimeCheck?.state || updateManager.runtimeState;
        if (
          !runtimeCheck?.success ||
          !["ready", "degraded"].includes(checkedRuntimeState.status)
        ) {
          backendEngineStore.setStopped();
          return {
            success: false,
            requiresEnvironmentSetup: true,
            code: runtimeCheck?.code || "EXTERNAL_ENV_NOT_READY",
            error:
              runtimeCheck?.error?.message ||
              runtimeCheck?.error ||
              runtimeCheck?.reason ||
              "已有运行环境校验失败，请打开服务管理重新检测。",
            state: runtimeCheck?.state || updateManager.runtimeState,
          };
        }
      } else {
        const prepareResult = await invoke("prepare-project-python", projectResult.path);
        if (!prepareResult?.success) {
          throwBackendFailure(prepareResult, "运行环境准备失败");
        }

        backendEngineStore.setPhase("loadingModel");
        const depsResult = await invoke("check-dependencies");
        if (!depsResult?.success) {
          const installResult = await invoke("install-dependencies", projectResult.path);
          if (!installResult?.success) {
            throwBackendFailure(installResult || depsResult, "依赖准备失败");
          }
        }
      }
    }

    backendEngineStore.setPhase("startingEngine");
    const generalConfig = configStore.config.general || {};
    const startResult = await startBackendService({
      port: generalConfig.backendPort || 8080,
      device: generalConfig.launchMode || "cuda",
      model: generalConfig.defaultModel || "lama",
      modelDir: generalConfig.modelDir || "",
      samReleaseBeforeProcessing:
        configStore.config.masking?.samReleaseBeforeProcessing !== false,
    });
    if (!startResult?.success) {
      throwBackendFailure(startResult, "AI 引擎启动失败");
    }

    if (startResult.portChanged) {
      $q.notify({
        type: "warning",
        message: `配置端口 ${startResult.requestedPort} 被占用，已自动切换到 ${startResult.port}`,
        position: "top",
        timeout: 5000,
      });
    }
    return startResult;
  } catch (error) {
    const classified = classifyMoonshineError(error, "Moonshine AI 引擎准备失败");
    const failure = {
      ...normalizeBackendFailure(error, classified.message),
      error: classified.message,
      processRunning: backendEngineStore.processRunning,
    };
    backendEngineStore.setFailed(failure);
    return failure;
  }
};

const notifyStartupFailure = (result = null) => {
  if (startupFailureNotified.value || !result || result.success !== false) return;
  startupFailureNotified.value = true;
  const classified = classifyMoonshineError(
    result,
    result.requiresEnvironmentSetup
      ? "运行环境尚未就绪，请打开服务管理完成配置。"
      : "Moonshine AI 引擎启动失败"
  );
  const openDiagnostics = result.requiresEnvironmentSetup
    ? openRuntimeOnboardingGuide
    : openBackendDiagnostics;
  $q.notify({
    type: result.requiresEnvironmentSetup ? "warning" : "negative",
    message: classified.message || result.error || "Moonshine AI 引擎启动失败",
    position: "top",
    timeout: 7500,
    actions: [
      {
        label: result.requiresEnvironmentSetup ? "配置环境" : "打开诊断",
        color: "white",
        handler: openDiagnostics,
      },
    ],
  });
};

const settleStartupExperience = () => {
  // Let the visual overlay leave as soon as its media finishes; backend startup
  // can continue behind the page without leaving an opaque blocking layer.
  if (startupOverlayFinished.value) {
    showStartupOverlay.value = false;
  }
  if (startupFlowPending.value || !startupOverlayFinished.value) return;
  startupExperienceFinished.value = true;
  flushPendingBackendPathNotice();
  notifyStartupFailure(startupFlowResult.value);
};

const handleStartupOverlayVisibilityRequest = (visible) => {
  if (visible) {
    showStartupOverlay.value = true;
    return;
  }
  startupOverlayFinished.value = true;
  settleStartupExperience();
};

const handleStartupOverlayFinished = () => {
  startupOverlayFinished.value = true;
  settleStartupExperience();
};

const handleRouteChange = (value) => {
  router.push(`/${value}`);
};

const handleTrayNavigation = (request = {}) => {
  if (request?.route !== "/activity/mcp") return;
  runtimeOnboardingDismissed.value = true;
  showBackendManager.value = false;
  openGlobalSettings({ tab: "mcp", mcpTab: "activity" });
};

const handleMcpOpenArtifact = (payload = {}) => {
  const filePath = typeof payload?.path === "string" ? payload.path.trim() : "";
  const mimeType = typeof payload?.mimeType === "string" ? payload.mimeType.trim().toLowerCase() : "";
  if (!filePath || filePath.length > 4096 || [...filePath].some((character) => character.charCodeAt(0) < 32) || !mimeType.startsWith("image/")) {
    $q.notify({ type: "negative", message: "无法在编辑器中打开该结果。", position: "top" });
    return;
  }
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const descriptor = {
    path: filePath,
    normalizedPath,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : filePath.split(/[\\/]/).pop(),
    type: mimeType,
    size: Number.isSafeInteger(payload.size) && payload.size >= 0 ? payload.size : 0,
    lastModified: Number.isFinite(payload.lastModified) ? payload.lastModified : Date.now(),
  };
  const created = fileManagerStore.addPathFiles([descriptor]);
  const target = created[0] || fileManagerStore.files.find((file) => {
    const candidate = file?.originalFile?.path || file?.image?.data || "";
    return candidate.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalizedPath;
  });
  if (!target) {
    $q.notify({ type: "negative", message: "无法在编辑器中导入该结果。", position: "top" });
    return;
  }
  fileManagerStore.setCurrentFile(target.id);
  void router.push("/image");
};

const applyThemeColors = (brandColors = {}) => {
  const colors = {
    ...DEFAULT_BRAND_COLORS,
    ...(brandColors || {}),
  };

  Object.entries(colors).forEach(([key, value]) => {
    setCssVar(key, value);
  });
};

const applyUiPreferences = () => {
  const uiConfig = configStore.config.ui || {};
  $q.dark.set(normalizeThemeMode(uiConfig.theme) === "dark");
  applyThemeColors(uiConfig.brandColors);
};

const toggleThemeMode = async () => {
  const nextTheme = configStore.config.ui?.theme === "dark" ? "light" : "dark";
  const nextConfig = {
    ...configStore.config,
    ui: {
      ...(configStore.config.ui || {}),
      theme: nextTheme,
    },
  };

  const result = await configStore.persistConfig(nextConfig);
  if (!result.success) {
    $q.notify({
      type: "negative",
      message: `主题切换失败: ${result.error || result.errors?.join("；") || "未知错误"}`,
    });
  }
};

onMounted(async () => {
  const updateInitialization = updateManager.initialize();
  removeBackendServiceStateListener =
    window.electron?.ipcRenderer?.on?.(
      "backend-service-state",
      handleBackendServiceState
    ) || null;
  removeTrayNavigationListener =
    window.electron?.ipcRenderer?.onTrayNavigation?.(handleTrayNavigation) || null;
  removeMcpOpenArtifactListener =
    window.electron?.ipcRenderer?.onMcpOpenArtifact?.(handleMcpOpenArtifact) || null;
  window.electron?.ipcRenderer?.send?.("renderer-ready");
  await configStore.loadConfig();
  const shouldShowStartupOverlay =
    !isE2EMode && configStore.config.ui?.showStartupAnimation !== false;
  const shouldAutoStartService =
    configStore.config.general?.autoStart !== false;
  showStartupOverlay.value = shouldShowStartupOverlay;
  startupOverlayFinished.value = !shouldShowStartupOverlay;
  startupFlowPending.value = shouldAutoStartService;
  startupFlowResult.value = null;
  startupFailureNotified.value = false;
  startupExperienceFinished.value =
    !shouldShowStartupOverlay && !startupFlowPending.value;
  applyUiPreferences();
  api.updateConfig(configStore.config);
  await appStateStore.loadState();
  await updateInitialization;
  const startupPreparation = prepareBackendEngine();
  if (shouldAutoStartService) {
    void startupPreparation
      .then((result) => {
        startupFlowResult.value = result || {
          success: backendEngineStore.isRunning,
        };
      })
      .catch((error) => {
        startupFlowResult.value = normalizeBackendFailure(
          error,
          "Moonshine AI 引擎启动失败"
        );
      })
      .finally(() => {
        startupFlowPending.value = false;
        settleStartupExperience();
      });
  } else {
    startupFlowPending.value = false;
    startupFlowResult.value = { success: true, skipped: true };
    settleStartupExperience();
  }
});

onUnmounted(() => {
  updateManager.dispose();
  removeBackendServiceStateListener?.();
  removeBackendServiceStateListener = null;
  removeTrayNavigationListener?.();
  removeTrayNavigationListener = null;
  removeMcpOpenArtifactListener?.();
  removeMcpOpenArtifactListener = null;
});

watch(
  () => [
    updateManager.state.status,
    updateManager.state.availableVersion,
    updateManager.state.latestVersion,
  ],
  ([status, availableVersion, latestVersion]) => {
    notifyAppUpdateState(status, availableVersion || latestVersion);
  }
);

watch(
  () => configStore.config,
  () => {
    applyUiPreferences();
    api.updateConfig(configStore.config);
  },
  { deep: true }
);

watch(showBackendManager, (newVal) => {
  if (!newVal) {
    setTimeout(() => checkBackendStatus({ notifyOnFailure: false }), 1000);
  }
});

watch(showStartupOverlay, (visible) => {
  if (!visible && startupExperienceFinished.value) {
    flushPendingBackendPathNotice();
  }
});

router.beforeEach(async (to, from) => {
  if (loadingState.value.showing && from.name && from.name !== to.name) {
    $q.notify({
      type: "warning",
      message: "当前任务处理中，暂时不能切换页面。",
      position: "top",
      timeout: 2000,
    });
    return false;
  }

  if (from.name && from.name !== to.name) {
    const result = await appStateStore.switchPage(to.name);

    if (!result.success && result.oversized) {
      const confirmed = await new Promise((resolve) => {
        $q.dialog({
          title: "状态保存失败",
          message: `${result.error}。继续切换将丢失当前页面的未保存内容，是否继续？`,
          cancel: true,
          persistent: true,
        })
          .onOk(() => resolve(true))
          .onCancel(() => resolve(false));
      });

      if (!confirmed) {
        return false;
      }
      await appStateStore.restart();
    }
  }
});
</script>

<style scoped>
:deep(.q-tooltip) {
  z-index: 2100 !important;
}

:deep(.q-menu) {
  z-index: 2100 !important;
}

.main-page-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.page-content-shell {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.layout-page-footer {
  background: transparent !important;
  color: inherit !important;
  box-shadow: none !important;
}

.main-header,
.layout-page-footer {
  z-index: 2100 !important;
}

.global-loading {
  z-index: 4000 !important;
  pointer-events: auto;
}

.global-loading-content {
  width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.global-loading-logo-shell {
  width: clamp(84px, 11vw, 132px);
  height: clamp(84px, 11vw, 132px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.global-loading-logo {
  width: 72%;
  height: 72%;
  object-fit: contain;
  display: block;
  transform-origin: center;
  animation: global-loading-breathe 2.2s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  will-change: transform, opacity, filter;
}

.global-loading-progress {
  width: 100%;
}

.global-loading-action {
  min-width: 156px;
}

.update-settings-badge {
  width: 16px;
  min-width: 16px;
  height: 16px;
  min-height: 16px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.runtime-onboarding-card {
  width: min(520px, calc(100vw - 32px));
  max-width: 520px;
  border-radius: 8px;
  overflow: hidden;
}

.runtime-onboarding-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 20px 16px;
}

.runtime-onboarding-icon {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--q-primary);
  background: color-mix(in srgb, var(--q-primary) 12%, transparent);
}

.runtime-onboarding-heading {
  min-width: 0;
}

.runtime-onboarding-content {
  padding: 20px;
}

.runtime-onboarding-copy {
  line-height: 1.65;
}

.runtime-onboarding-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid rgba(35, 120, 80, 0.24);
  border-radius: 6px;
  color: #237850;
  background: rgba(35, 120, 80, 0.07);
}

.runtime-onboarding-status--error {
  border-color: rgba(186, 55, 55, 0.28);
  color: #ba3737;
  background: rgba(186, 55, 55, 0.07);
}

.runtime-onboarding-status-copy {
  min-width: 0;
}

.runtime-onboarding-actions {
  gap: 8px;
  padding: 0 20px 20px;
}

.runtime-onboarding-actions :deep(.q-btn) {
  min-height: 38px;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.runtime-onboarding-actions :deep(.q-btn:active) {
  transform: scale(0.97);
}

.global-loading-message {
  white-space: pre-line;
  line-height: 1.45;
}

@keyframes global-loading-breathe {
  0%,
  100% {
    transform: scale(0.9);
    opacity: 0.9;
    filter: drop-shadow(0 6px 14px rgba(17, 24, 39, 0.14));
  }

  50% {
    transform: scale(1.1);
    opacity: 1;
    filter: drop-shadow(0 10px 22px rgba(17, 24, 39, 0.22));
  }
}

@keyframes global-loading-reduced-pulse {
  0%,
  100% {
    opacity: 0.82;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .global-loading-logo {
    animation: global-loading-reduced-pulse 1.6s cubic-bezier(0.77, 0, 0.175, 1) infinite;
    transform: none;
    filter: none;
  }
}
</style>
