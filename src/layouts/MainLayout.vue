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
            <q-tooltip>后端管理</q-tooltip>
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
            @click="showSettings = true"
          >
            <q-tooltip>全局设置</q-tooltip>
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

        <q-inner-loading :showing="loadingState.showing" class="global-loading">
          <div class="global-loading-content">
            <div class="global-loading-logo-shell" aria-hidden="true">
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
    :backend-running="backendRunning"
    @open-backend-manager="showBackendManager = true"
    @model-downloaded="handleModelDownloaded"
  />
  <startup-overlay v-model="showStartupOverlay" @finished="handleStartupOverlayFinished" />
</template>

<script setup>
import { setCssVar, useQuasar } from "quasar";
import { computed, markRaw, onMounted, provide, ref, shallowRef, watch } from "vue";
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
import { useRuntimeDiagnosticsStore } from "src/stores/runtimeDiagnostics";
import {
  BACKEND_PATH_CJK_BLOCK_MESSAGE,
  validateBackendPathsForConfig,
} from "src/utils/backendPathValidation";
import { resolvePublicAssetPath } from "src/utils/publicAsset";

const $q = useQuasar();
const router = useRouter();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const backendEngineStore = useBackendEngineStore();
const runtimeDiagnosticsStore = useRuntimeDiagnosticsStore();
const globalLoadingLogo = resolvePublicAssetPath("icons/cmx-logo256.png");

const showBackendManager = ref(false);
const showSettings = ref(false);
const settingsTarget = ref({
  tab: "",
  modelId: "",
});
const backendRunning = ref(false);
const showStartupOverlay = ref(false);
const runtimeE2EFlag =
  typeof window !== "undefined" && window.__MOONSHINE_E2E__ === true;
const isE2EMode = import.meta.env.VITE_MOONSHINE_E2E === "1" || runtimeE2EFlag;
const pendingBackendPathDialog = ref(null);
const cudaDiagnosticNotificationKey = ref("");
const backendSessionStartedAt = ref(0);

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

const normalizeLoadingMessage = (message = "") =>
  String(message || "").replace(
    /\s*，?\s*可打开后端管理页面查看进度/g,
    "\n可打开后端管理页面查看进度"
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
  normalizeLoadingMessage(message).replace(
    /\s*[\uFF0C,]?\s*\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6/g,
    "\n\u53ef\u6253\u5f00\u540e\u7aef\u7ba1\u7406\u9875\u9762\u67e5\u770b\u8fdb\u5ea6"
  );

const openBackendDiagnostics = () => {
  showBackendManager.value = true;
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

const openGlobalSettings = ({ tab = "", modelId = "" } = {}) => {
  settingsTarget.value = {
    tab,
    modelId,
  };
  showSettings.value = true;
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
  phaseLabel: backendEngineStore.phaseLabel,
  isRunning: backendEngineStore.isRunning,
  isPreparing: backendEngineStore.isPreparing,
  hasFailed: backendEngineStore.hasFailed,
  runDisabled: backendEngineStore.runDisabled,
  runDisabledTooltip: backendEngineStore.runDisabledTooltip,
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

const checkBackendStatus = async ({ notifyOnFailure = true } = {}) => {
  try {
    await refreshCudaDiagnostics({ notify: true });
    backendRunning.value = true;
    backendEngineStore.setRunning();
    return true;
  } catch (error) {
    backendRunning.value = false;
    runtimeDiagnosticsStore.setCudaUnavailable("后端服务未启动");
    if (notifyOnFailure) {
      const classifiedError = classifyMoonshineError(error, "后端服务未启动");
      $q.notify({
        type: "warning",
        message: classifiedError.message,
        position: "top",
        timeout: 5000,
        actions: [
          {
            label: "启动后端",
            color: "white",
            handler: openBackendDiagnostics,
          },
        ],
      });
    }
    return false;
  }
};

const showBackendPathBlockedDialog = (validationResult = null) => {
  const invalidPathLines = Array.isArray(validationResult?.invalidPaths)
    ? validationResult.invalidPaths
        .map((item) => `${item?.label || item?.field || "路径"}：${item?.path || ""}`)
        .filter(Boolean)
    : [];
  const message = invalidPathLines.length > 0
    ? `${BACKEND_PATH_CJK_BLOCK_MESSAGE}\n${invalidPathLines.join("\n")}`
    : BACKEND_PATH_CJK_BLOCK_MESSAGE;

  $q.dialog({
    title: "路径配置异常",
    message,
    ok: {
      label: "知道了",
      color: "primary",
      unelevated: true,
    },
    persistent: true,
  });
};

const flushPendingBackendPathDialog = () => {
  if (!pendingBackendPathDialog.value) {
    return;
  }

  const payload = pendingBackendPathDialog.value;
  pendingBackendPathDialog.value = null;
  showBackendPathBlockedDialog(payload);
};

const queueBackendPathBlockedDialog = (validationResult = null) => {
  if (showStartupOverlay.value) {
    pendingBackendPathDialog.value = validationResult || {};
    return;
  }

  showBackendPathBlockedDialog(validationResult);
};

const getElectronInvoke = () => window.electron?.ipcRenderer?.invoke;

const getSkippedAutoStartMessage = () =>
  import.meta.env.DEV
    ? "开发环境已跳过自动启动 Moonshine AI 引擎；需要时请打开后端管理手动启动。"
    : "当前环境未自动启动 Moonshine AI 引擎";

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

  const result = await configStore.saveConfig({
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

const prepareBackendEngine = async () => {
  const invoke = getElectronInvoke();
  if (!invoke || import.meta.env.DEV || configStore.config.general?.autoStart === false) {
    const reachable = await checkBackendStatus({ notifyOnFailure: false });
    if (!reachable) {
      backendEngineStore.setFailed(getSkippedAutoStartMessage());
    }
    return;
  }

  backendEngineStore.setPreparing("preparing");

  try {
    const backendPathValidation = await validateBackendPathsForConfig(
      configStore.config.general || {}
    );
    if (!backendPathValidation.valid) {
      backendRunning.value = false;
      backendEngineStore.setFailed(
        backendPathValidation.message || BACKEND_PATH_CJK_BLOCK_MESSAGE
      );
      queueBackendPathBlockedDialog(backendPathValidation);
      return;
    }

    const processStatus = await invoke("check-backend-status");
    if (processStatus?.success && processStatus.running) {
      await syncBackendRuntimePort(processStatus.port);
      if (!backendSessionStartedAt.value) {
        backendSessionStartedAt.value = Date.now();
      }
      backendEngineStore.setPhase("verifying");
      const reachable = await checkBackendStatus({ notifyOnFailure: false });
      if (!reachable) {
        throw new Error("Moonshine AI 引擎进程存在，但接口未响应");
      }
      return;
    }

    backendEngineStore.setPhase("checkingRuntime");
    const projectResult = await invoke(
      "check-project",
      configStore.config.general?.backendProjectPath || ""
    );
    if (!projectResult?.success) {
      const message = [projectResult?.error || "后端项目检测失败", projectResult?.recoveryHint]
        .filter(Boolean)
        .join(" ");
      throw new Error(message);
    }

    const prepareResult = await invoke("prepare-project-python", projectResult.path);
    if (!prepareResult?.success) {
      throw new Error(prepareResult?.error || "运行时准备失败");
    }

    backendEngineStore.setPhase("loadingModel");
    const depsResult = await invoke("check-dependencies");
    if (!depsResult?.success) {
      const installResult = await invoke("install-dependencies", projectResult.path);
      if (!installResult?.success) {
        throw new Error(installResult?.error || depsResult?.error || "依赖准备失败");
      }
    }

    backendEngineStore.setPhase("startingEngine");
    const generalConfig = configStore.config.general || {};
    const startResult = await invoke("start-backend-service", {
      port: generalConfig.backendPort || 8080,
      device: generalConfig.launchMode || "cuda",
      model: generalConfig.defaultModel || "lama",
      modelDir: generalConfig.modelDir || "",
    });
    if (!startResult?.success) {
      throw new Error(startResult?.error || "AI 引擎启动失败");
    }

    await syncBackendRuntimePort(startResult.port || generalConfig.backendPort || 8080);
    backendSessionStartedAt.value = Date.now();
    if (startResult.portChanged) {
      $q.notify({
        type: "warning",
        message: `配置端口 ${startResult.requestedPort} 被占用，已自动切换到 ${startResult.port}`,
        position: "top",
        timeout: 5000,
      });
    }

    backendEngineStore.setPhase("verifying");
    let reachable = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      reachable = await checkBackendStatus({ notifyOnFailure: false });
      if (reachable) break;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    if (!reachable) {
      throw new Error("AI 引擎启动后未响应");
    }
  } catch (error) {
    backendRunning.value = false;
    backendEngineStore.setFailed(
      classifyMoonshineError(error, "Moonshine AI 引擎准备失败").message
    );
  }
};

const handleStartupOverlayFinished = () => {
  flushPendingBackendPathDialog();
};

const handleRouteChange = (value) => {
  router.push(`/${value}`);
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
  await configStore.loadConfig();
  showStartupOverlay.value =
    !isE2EMode && configStore.config.ui?.showStartupAnimation !== false;
  applyUiPreferences();
  api.updateConfig(configStore.config);
  await appStateStore.loadState();
  void prepareBackendEngine();
});

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
  if (!visible) {
    flushPendingBackendPathDialog();
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
  animation: global-loading-breathe 2.2s ease-in-out infinite;
  will-change: transform, opacity, filter;
}

.global-loading-progress {
  width: 100%;
}

.global-loading-action {
  min-width: 156px;
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
    transform: scale(1.08);
    opacity: 1;
    filter: drop-shadow(0 10px 22px rgba(17, 24, 39, 0.22));
  }
}

@media (prefers-reduced-motion: reduce) {
  .global-loading-logo {
    animation: none;
    transform: none;
    opacity: 1;
    filter: none;
  }
}
</style>
